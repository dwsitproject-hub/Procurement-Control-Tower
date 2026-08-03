import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { DASH, formatMoney, formatNumber } from '../lib/format';

/**
 * W7 — custom KPI and chart builder. v1's cu-modal and ce-modal.
 *
 * Specs are composed from the server's whitelist vocabulary only, saved per user,
 * and computed server-side. Every result is stamped user-defined: these figures
 * live outside the tested rules package and carry NO golden-number guarantee —
 * the banner below is required, not decorative.
 */

interface Vocab {
  grains: string[];
  aggs: string[];
  measures: Record<string, string[]>;
  dimensions: Record<string, string[]>;
  toggles: string[];
}

interface KpiSpec {
  title: string;
  grain: string;
  agg: string;
  measure: string | null;
  toggles?: string[];
  filters?: Record<string, string[]>;
}

interface ChartSpec extends KpiSpec {
  dimension: string;
  topN?: number;
}

interface Saved { kpis: KpiSpec[]; charts: ChartSpec[] }

export function CustomTab({ onDrill }: { onDrill: (t: string, l: string) => void }) {
  const [vocab, setVocab] = useState<Vocab | null>(null);
  const [saved, setSaved] = useState<Saved>({ kpis: [], charts: [] });
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.get<Vocab>('/api/v1/custom/vocabulary').then(setVocab).catch(() => setVocab(null));
    api.get<{ specs: Saved }>('/api/v1/custom/saved')
      .then((d) => setSaved(d.specs ?? { kpis: [], charts: [] }))
      .catch(() => undefined);
  }, []);

  const persist = useCallback(async (next: Saved) => {
    setSaved(next);
    try {
      await api.put('/api/v1/custom/saved', next);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'save failed');
    }
  }, []);

  if (!vocab) return <div className="center-msg"><div className="spinner" />Loading builder…</div>;

  return (
    <>
      <div className="panel" style={{ borderLeft: '3px solid var(--warn)' }}>
        <p className="note" style={{ margin: 0 }}>
          ⚠ <strong>User-defined figures.</strong> Everything on this tab is composed by you from
          whitelisted building blocks. These numbers are computed live but sit outside the tested
          rules package — they carry <strong>no golden-number guarantee</strong>. Drills still open
          exactly the aggregated rows.
        </p>
      </div>

      <Builder vocab={vocab} onSaveKpi={(k) => void persist({ ...saved, kpis: [...saved.kpis, k] })}
               onSaveChart={(c) => void persist({ ...saved, charts: [...saved.charts, c] })} />

      {saved.kpis.length > 0 && (
        <div className="panel">
          <h2>My KPIs</h2>
          <div className="kpi-grid">
            {saved.kpis.map((k, i) => (
              <CustomKpiCard key={`${k.title}-${i}`} spec={k} onDrill={onDrill}
                onRemove={() => void persist({ ...saved, kpis: saved.kpis.filter((_, j) => j !== i) })} />
            ))}
          </div>
        </div>
      )}

      {saved.charts.map((c, i) => (
        <CustomChartPanel key={`${c.title}-${i}`} spec={c} onDrill={onDrill}
          onRemove={() => void persist({ ...saved, charts: saved.charts.filter((_, j) => j !== i) })} />
      ))}

      {msg && <p className="err">{msg}</p>}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────── builder

function Builder({
  vocab, onSaveKpi, onSaveChart,
}: { vocab: Vocab; onSaveKpi: (k: KpiSpec) => void; onSaveChart: (c: ChartSpec) => void }) {
  const [kind, setKind] = useState<'kpi' | 'chart'>('kpi');
  const [title, setTitle] = useState('');
  const [grain, setGrain] = useState('po_line');
  const [agg, setAgg] = useState('count');
  const [measure, setMeasure] = useState<string | null>(null);
  const [dimension, setDimension] = useState('status');
  const [toggles, setToggles] = useState<string[]>(['excludeDeleted']);
  const [preview, setPreview] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const spec = (): KpiSpec | ChartSpec => ({
    title: title.trim() || '(untitled)',
    grain,
    agg,
    measure: agg === 'count' ? null : measure,
    toggles,
    ...(kind === 'chart' ? { dimension, topN: 15 } : {}),
  });

  const run = async () => {
    setBusy(true);
    setErr(null);
    setPreview(null);
    try {
      const out = await api.post<Record<string, any>>(
        kind === 'kpi' ? '/api/v1/custom/kpi' : '/api/v1/custom/chart',
        spec(),
      );
      setPreview(out);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'preview failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>🧮 Build a {kind === 'kpi' ? 'KPI card' : 'chart'}</h2>
      <div className="dt-toolbar" style={{ alignItems: 'flex-end' }}>
        <label className="cu-field">Type
          <select value={kind} onChange={(e) => setKind(e.target.value as never)}>
            <option value="kpi">KPI card</option>
            <option value="chart">Chart</option>
          </select>
        </label>
        <label className="cu-field">Title
          <input value={title} maxLength={80} placeholder="e.g. Open lines in EU73" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="cu-field">Grain
          <select value={grain} onChange={(e) => { setGrain(e.target.value); setMeasure(null); }}>
            {vocab.grains.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
        <label className="cu-field">Aggregation
          <select value={agg} onChange={(e) => setAgg(e.target.value)}>
            {vocab.aggs.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        {agg !== 'count' && (
          <label className="cu-field">Measure
            <select value={measure ?? ''} onChange={(e) => setMeasure(e.target.value || null)}>
              <option value="">(choose)</option>
              {(vocab.measures[grain] ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        )}
        {kind === 'chart' && (
          <label className="cu-field">Dimension
            <select value={dimension} onChange={(e) => setDimension(e.target.value)}>
              {(vocab.dimensions[grain] ?? []).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="dt-toolbar">
        {vocab.toggles.map((t) => (
          <label key={t} className="dt-check">
            <input
              type="checkbox"
              checked={toggles.includes(t)}
              onChange={() => setToggles((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))}
            />
            {t}
          </label>
        ))}
        <span style={{ flex: 1 }} />
        <button className="btn" style={{ width: 'auto' }} disabled={busy || (agg !== 'count' && !measure)} onClick={() => void run()}>
          {busy ? 'Computing…' : 'Preview'}
        </button>
        {preview && (
          <button className="dt-btn" onClick={() => (kind === 'kpi' ? onSaveKpi(spec()) : onSaveChart(spec() as ChartSpec))}>
            Save to my {kind === 'kpi' ? 'KPIs' : 'charts'}
          </button>
        )}
      </div>
      {err && <p className="err">{err}</p>}
      {preview && kind === 'kpi' && (
        <p className="count" style={{ marginTop: '.5rem' }}>
          Preview: <strong>{preview.value === null ? DASH : formatNumber(Number(preview.value), 2)}</strong>
          {' '}· n = {formatNumber(preview.sampleSize)} · user-defined
        </p>
      )}
      {preview && kind === 'chart' && (
        <div className="table-wrap" style={{ marginTop: '.5rem', maxHeight: 220, overflow: 'auto' }}>
          <table className="data">
            <thead><tr><th>Bucket</th><th style={{ textAlign: 'right' }}>Value</th><th style={{ textAlign: 'right' }}>Rows</th></tr></thead>
            <tbody>
              {preview.points.map((p2: any) => (
                <tr key={p2.bucket}>
                  <td>{p2.bucket}</td>
                  <td className="num">{p2.value === null ? DASH : formatNumber(Number(p2.value), 2)}</td>
                  <td className="num">{formatNumber(p2.rowCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────── saved cards

export function CustomKpiCard({
  spec, onDrill, onRemove,
}: { spec: KpiSpec; onDrill: (t: string, l: string) => void; onRemove: () => void }) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    api.post<Record<string, any>>('/api/v1/custom/kpi', spec).then(setD).catch(() => setErr(true));
  }, [spec]);

  const isMoney = spec.measure?.includes('usd') || spec.measure?.includes('value');

  return (
    <div className="kpi" data-sev="neutral" style={{ position: 'relative' }}>
      <button className="cu-x" title="Remove this card" onClick={onRemove}>×</button>
      <div className="v">
        {err ? DASH : !d ? '…' : d.value === null ? DASH
          : isMoney ? formatMoney(Number(d.value), 'USD') : formatNumber(Number(d.value), 2)}
      </div>
      <div className="l">{spec.title}</div>
      <div className="s">
        user-defined · {spec.agg}{spec.measure ? `(${spec.measure})` : ''}
        {d?.drillToken && (
          <> · <button className="cu-link" onClick={() => onDrill(d.drillToken, spec.title)}>rows</button></>
        )}
      </div>
    </div>
  );
}

export function CustomChartPanel({
  spec, onDrill, onRemove,
}: { spec: ChartSpec; onDrill: (t: string, l: string) => void; onRemove: () => void }) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.post<Record<string, any>>('/api/v1/custom/chart', spec)
      .then(setD)
      .catch((e: Error) => setErr(e.message));
  }, [spec]);

  const isMoney = spec.measure?.includes('usd') || spec.measure?.includes('value');
  const max = Math.max(...(d?.points ?? []).map((p2: any) => p2.value ?? 0), 1);

  return (
    <div className="panel" style={{ position: 'relative' }}>
      <button className="cu-x" title="Remove this chart" onClick={onRemove}>×</button>
      <h2>{spec.title} <span className="muted">· user-defined · by {spec.dimension}</span></h2>
      {err && <p className="err">{err}</p>}
      {!d && !err && <div className="spinner" />}
      {d && d.points.length === 0 && <p className="note">No rows match this spec.</p>}
      {d && d.points.map((p2: any) => (
        <div key={p2.bucket} className="ent-bar-row">
          <span className="ent-bar-label">{p2.bucket}</span>
          <span className="ent-bar-track">
            <button
              className="ent-bar cu-bar"
              style={{ width: `${((p2.value ?? 0) / max) * 100}%` }}
              title={`${formatNumber(p2.rowCount)} rows — click to open`}
              onClick={() => p2.drillToken && onDrill(p2.drillToken, `${spec.title} — ${p2.bucket}`)}
            />
          </span>
          <span className="ent-bar-val">
            {p2.value === null ? DASH : isMoney ? formatMoney(Number(p2.value), 'USD') : formatNumber(Number(p2.value), 2)}
          </span>
        </div>
      ))}
    </div>
  );
}
