import { useEffect, useRef, useState } from 'react';
import {
  BarController, BarElement, CategoryScale, Chart as ChartJS, Legend, LinearScale, Tooltip,
} from 'chart.js';
import { api } from '../lib/api';
import { DASH, formatMoney, formatNumber } from '../lib/format';
import { Lbl } from '../lib/labels';
import { FloatControls } from './FloatControls';
import { LayoutControls, LayoutEditBar, applyLayout, type TabLayout } from './LayoutEdit';
import { placeLabelAbove, type LabelRect } from '../lib/chartLabels';

ChartJS.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

/**
 * Coupa pages, split per user decision 5 Aug 2026 and modelled on Coupa's own
 * Analytics dashboards:
 *  - Sourcing        <- 1013 Sourcing Summary + 1012 Sourcing Details
 *  - Invoicing & Payment <- 3148 Coupa Value Review - Invoice
 * All money figures are IDR document-currency only (the ops store carries no
 * FX equivalents); non-IDR documents are counted and said so, never converted.
 */

const M = (v: unknown) =>
  v === null || v === undefined ? DASH : `${(Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} M`;

function Kpi({ v, label, sub, onClick }: { v: unknown; label: string; sub?: string; onClick?: () => void }) {
  const body = (
    <>
      <div className="v">{v === null || v === undefined ? DASH : String(v)}</div>
      <div className="l">{label}</div>
      {sub && <div className="s">{sub}</div>}
    </>
  );
  // Clickable figures open the rows they count (21 Nov 2026, Sourcing).
  return onClick ? (
    <button className="kpi" data-sev="neutral" onClick={onClick} title="Click to see the rows behind this figure">
      {body}
    </button>
  ) : (
    <div className="kpi" data-sev="neutral">{body}</div>
  );
}

/** Which rows a Sourcing figure opens - the keys of /api/v1/coupa/sourcing/rows. */
interface SourcingRowsReq { what: string; title: string; extra?: Record<string, string> }

/** Small month bar chart in the house style (value labels, PALETTE hue). */
function OpsBars({
  title, rows, series, onBar,
}: {
  title: string;
  rows: Record<string, any>[];
  series: { key: string; label: string; color: string; money?: boolean; currency?: string }[];
  /** A bar was clicked: its row and its series key. */
  onBar?: (row: Record<string, any>, seriesKey: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart = useRef<ChartJS | null>(null);
  useEffect(() => {
    if (!canvas.current || rows.length === 0) return;
    chart.current?.destroy();
    const labels = rows.map((r) => String(r.mk));
    const barLabels = {
      id: 'opsBarLabels',
      afterDatasetsDraw(c: any) {
        if (labels.length * series.length > 24) return;
        const ctx = c.ctx;
        ctx.save();
        ctx.font = '600 10px "Segoe UI", Arial, sans-serif';
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#64748B';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const placed: LabelRect[] = [];
        c.data.datasets.forEach((ds: any, di: number) => {
          const meta = c.getDatasetMeta(di);
          if (meta.hidden) return;
          ds.data.forEach((v: number | null, i: number) => {
            if (v === null || v === undefined) return;
            const el = meta.data[i];
            if (!el) return;
            const sp = series[di];
            placeLabelAbove(ctx, placed, sp?.money ? M(v) : formatNumber(Number(v)), el.x, el.y, el.width ?? 20);
          });
        });
        ctx.restore();
      },
    };
    chart.current = new ChartJS(canvas.current, {
      type: 'bar',
      plugins: [barLabels as never],
      data: {
        labels,
        datasets: series.map((sp) => ({
          label: sp.label,
          data: rows.map((r) => (r[sp.key] === null || r[sp.key] === undefined ? null : Number(r[sp.key]))),
          backgroundColor: sp.color,
          borderRadius: 3,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        onClick: (_e: unknown, els: { index: number; datasetIndex: number }[]) => {
          const el = els[0];
          if (!el || !onBar) return;
          const row = rows[el.index];
          const sp = series[el.datasetIndex];
          if (row && sp) onBar(row, sp.key);
        },
        onHover: (e: any, els: unknown[]) => {
          if (onBar && e?.native?.target) e.native.target.style.cursor = els.length > 0 ? 'pointer' : 'default';
        },
        // Headroom for the value labels above the tallest bars.
        scales: { y: { beginAtZero: true, grace: '15%' } },
        plugins: {
          legend: { display: series.length > 1, position: 'bottom', labels: { boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: (ctx: any) => {
                const sp = series[ctx.datasetIndex];
                return `${sp?.label}: ${sp?.money ? `${M(ctx.parsed.y)} ${sp.currency ?? 'IDR'}` : formatNumber(ctx.parsed.y)}`;
              },
            },
          },
        },
      },
    }) as unknown as ChartJS;
    return () => { chart.current?.destroy(); chart.current = null; };
  }, [rows, series, onBar]);
  return (
    <div className="panel">
      <h3 className="pr-tbl-h">{title}</h3>
      {rows.length === 0 ? <p className="note">No data yet.</p> : <div style={{ height: 220 }}><canvas ref={canvas} /></div>}
    </div>
  );
}

function SyncNote({ watermarks, converted = false }: { watermarks: Record<string, any>[] | undefined; converted?: boolean }) {
  return (
    <div className="panel" style={{ borderLeft: '3px solid var(--accent)' }}>
      <p className="note" style={{ margin: 0 }}>
        Live from the Coupa operational store
        {watermarks?.length
          ? ` — synced ${watermarks.map((w) => `${w.object} ${w.last_updated_at ? String(w.last_updated_at).slice(0, 16) : DASH} (${w.last_status ?? DASH})`).join(' · ')}`
          : ' — no sync has run yet'}
        . Separate from the SAP dataset versions.{' '}
        {converted
          ? 'Amounts follow the IDR / USD switch, each converted at its own month’s rate; any without a rate are counted but left out of the amount (⚠).'
          : 'IDR document-currency amounts only; other currencies are counted, never silently converted.'}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── Sourcing page

export function CoupaSourcingTab() {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Vendor Type filter (19 Nov 2026): '' = all, else Local (LN…) / Import (IN…). */
  const [vtype, setVtype] = useState<'' | 'local' | 'import'>('');
  /** The event whose supplier comparison is open. */
  const [compare, setCompare] = useState<number | null>(null);
  /** The figure whose rows are open. */
  const [rowsOf, setRowsOf] = useState<SourcingRowsReq | null>(null);
  const open = (what: string, title: string, extra?: Record<string, string>) =>
    setRowsOf({ what, title, ...(extra ? { extra } : {}) });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let gone = false;
    setBusy(true);
    api.get<Record<string, any>>(`/api/v1/coupa/sourcing${vtype ? `?vendorType=${vtype}` : ''}`)
      .then((r) => { if (!gone) { setD(r); setErr(null); } })
      .catch((e: Error) => { if (!gone) setErr(e.message); })
      .finally(() => { if (!gone) setBusy(false); });
    return () => { gone = true; };
  }, [vtype]);
  if (err) return <div className="panel"><h2><Lbl>Sourcing</Lbl></h2><p className="err">{err}</p></div>;
  if (!d) return <div className="center-msg"><div className="spinner" />Loading Coupa sourcing…</div>;
  if (!d.configured) {
    return <div className="panel"><h2><Lbl>Sourcing</Lbl></h2><p className="note">Coupa is not configured on this environment — an administrator must set the backend COUPA_* variables (Admin tab).</p></div>;
  }
  const k = d.kpis ?? {};
  const b = d.bids ?? {};
  function onMonthBar(row: Record<string, any>, key: string) {
    const mk = String(row.mk);
    if (key === 'completed') open('month_completed', `Events created in ${mk}, completed`, { month: mk });
    else open('month_events', `Events created in ${mk}`, { month: mk });
  }
  const awardRate = Number(b.responses ?? 0) > 0 ? ((Number(b.awarded ?? 0) / Number(b.responses)) * 100).toFixed(1) : null;
  const cov = d.typeCoverage ?? {};
  return (
    <>
      <SyncNote watermarks={d.watermarks} />
      <div className="gf-bar" style={{ marginBottom: '.8rem' }}>
        <span className="gf-label">Filter</span>
        <label className="ms-filter" title="Local = SAP vendor code LN…, Import = IN… - matched to the Coupa supplier master by name or email">
          <span className="gf-label">Vendor Type</span>
          <select className="dt-search" value={vtype} onChange={(e) => setVtype(e.target.value as '' | 'local' | 'import')} aria-label="Vendor Type">
            <option value="">All</option>
            <option value="local">Local</option>
            <option value="import">Import</option>
          </select>
        </label>
        {vtype !== '' && <button className="gf-btn gf-clear" onClick={() => setVtype('')}>Clear</button>}
        <span className="gf-note">
          Bids by type: {formatNumber(Number(cov.local ?? 0))} Local · {formatNumber(Number(cov.import ?? 0))} Import
          {Number(cov.unknown ?? 0) > 0 ? ` · ${formatNumber(Number(cov.unknown))} not matched to the supplier master` : ''}
        </span>
        {busy && <span className="gf-note">updating…</span>}
      </div>
      {/* 21 Nov 2026: Planned savings left the page; the event cycle and the
          bids per event are one card; every other figure opens its rows. */}
      <div className="kpi-grid" style={{ marginBottom: '1rem' }}>
        <Kpi v={formatNumber(Number(k.events ?? 0))} label="Sourcing events" sub={vtype ? `with a ${vtype === 'local' ? 'Local' : 'Import'} bid` : 'excluding templates'}
          onClick={() => open('events', 'Sourcing events')} />
        <Kpi v={formatNumber(Number(k.open_events ?? 0))} label="Open events" sub="not complete or canceled"
          onClick={() => open('open', 'Open events')} />
        <Kpi v={formatNumber(Number(k.completed ?? 0))} label="Completed events"
          onClick={() => open('completed', 'Completed events')} />
        <div className="kpi kpi-multi" style={{ ['--c' as string]: 'var(--heading)' }}>
          <div className="l kpi-multi-h">Event cycle &amp; bids</div>
          <dl className="kpi-multi-list">
            {/* Not clickable (21 Nov 2026): a summary of the events, the rows
                behind it are on the other cards and the funnel. */}
            <div className="kpi-multi-row">
              <dt>Event cycle (median, submit → end)</dt>
              <dd>{cycleText(k.median_cycle_days)}</dd>
            </div>
            <div className="kpi-multi-row">
              <dt>Avg bids per event</dt>
              <dd>{b.avg_bids_per_event ?? DASH}</dd>
            </div>
            <div className="kpi-multi-row">
              <dt>Events with bids</dt>
              <dd>{formatNumber(Number(b.events_with_bids ?? 0))}</dd>
            </div>
          </dl>
        </div>
        <Kpi v={formatNumber(Number(b.suppliers ?? 0))} label="Participating suppliers" sub={`${formatNumber(Number(b.responses ?? 0))} submitted bids`}
          onClick={() => open('bids', 'Participating suppliers — their submitted bids')} />
        <Kpi v={awardRate === null ? DASH : `${awardRate}%`} label="Bid award rate" sub={`${formatNumber(Number(b.awarded ?? 0))} awarded bids`}
          onClick={() => open('awarded_bids', 'Awarded bids')} />
      </div>

      <div className="chart-grid">
        <OpsBars
          title="Sourcing events by month"
          rows={d.eventsByMonth ?? []}
          series={MONTH_SERIES}
          onBar={onMonthBar}
        />
        <div className="panel">
          <h3 className="pr-tbl-h"><Lbl>Awarded spend by commodity — IDR documents</Lbl></h3>
          <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead><tr><th>Commodity</th><th className="num">Awarded bids</th><th className="num">Amount (M IDR)</th></tr></thead>
              <tbody>
                {(d.byCommodity ?? []).length === 0 && <tr><td colSpan={3} className="muted">No awarded bids yet.</td></tr>}
                {(d.byCommodity ?? []).map((c: any, i: number) => (
                  <tr key={c.commodity} className={`ent-row ${i % 2 ? '' : 're'}`} title="Click for the awarded bids"
                    onClick={() => open('commodity', `Awarded bids — ${c.commodity}`, { commodity: String(c.commodity) })}>
                    <td>{c.commodity}</td>
                    <td className="num">{formatNumber(c.awarded_bids)}{c.other_ccy > 0 ? <span className="muted" title={`${c.other_ccy} non-IDR bids not in the amount`}> ⚠</span> : null}</td>
                    <td className="num">{M(c.amount_idr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="chart-grid" style={{ marginTop: '1rem' }}>
        <div className="panel">
          <h3 className="pr-tbl-h"><Lbl>Awarded spend by supplier — top 12, IDR documents</Lbl></h3>
          <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead><tr><th>Supplier</th><th className="num">Awarded bids</th><th className="num">Amount (M IDR)</th></tr></thead>
              <tbody>
                {(d.bySupplier ?? []).length === 0 && <tr><td colSpan={3} className="muted">No awarded bids yet.</td></tr>}
                {(d.bySupplier ?? []).map((c: any, i: number) => (
                  <tr key={c.supplier_name} className={`ent-row ${i % 2 ? '' : 're'}`} title="Click for the awarded bids"
                    onClick={() => open('supplier', `Awarded bids — ${c.supplier_name}`, { supplier: String(c.supplier_name) })}>
                    <td>{c.supplier_name} <VendorTypeBadge t={c.vendor_type} /></td>
                    <td className="num">{formatNumber(c.awarded_bids)}{c.other_ccy > 0 ? <span className="muted" title={`${c.other_ccy} non-IDR bids not in the amount`}> ⚠</span> : null}</td>
                    <td className="num">{M(c.amount_idr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <EventPipeline pipeline={d.pipeline ?? []} bids={b} events={Number(k.events ?? 0)} onOpen={open} />
      </div>

      <div className="panel" style={{ marginTop: '1rem' }}>
        <h3 className="pr-tbl-h"><Lbl>Sourcing data table</Lbl> <span className="muted">— newest 200 supplier bids · click an event or its bid count to compare the suppliers</span></h3>
        <div className="table-wrap dt-scroll">
          <table className="data dd-tbl">
            <thead>
              <tr>
                <th>Event</th><th>Type</th><th>State</th><th>Commodity</th><th>Description</th>
                <th>PR No</th><th>Supplier</th><th>Vendor Type</th><th className="num">Bids</th><th>Awarded</th><th>Submitted</th>
                <th className="num">Amount</th><th>Ccy</th>
              </tr>
            </thead>
            <tbody>
              {(d.dataTable ?? []).map((r2: any, i: number) => (
                <tr key={`${r2.event_id}|${r2.supplier_name}|${i}`} className={i % 2 ? '' : 're'}>
                  <td>
                    <button className="cu-link" title="Compare every supplier's quote on this event" onClick={() => setCompare(Number(r2.event_id))}>
                      {r2.event_id}
                    </button>
                  </td>
                  <td>{r2.event_type ?? DASH}</td>
                  <td>{r2.event_state ?? DASH}</td>
                  <td>{r2.commodity ?? DASH}</td>
                  <td className="muted">{r2.description ?? ''}</td>
                  <td>{r2.pr_no ?? DASH}</td>
                  <td>{r2.supplier_name ?? DASH}</td>
                  <td><VendorTypeBadge t={r2.vendor_type} /></td>
                  <td className="num">
                    <button className="cu-link" onClick={() => setCompare(Number(r2.event_id))}>{formatNumber(Number(r2.bids_on_event ?? 0))}</button>
                  </td>
                  <td><span className={`bs ${r2.awarded ? 'sd' : 'sl'}`}>{r2.awarded ? 'Yes' : 'No'}</span></td>
                  <td>{r2.submitted_at ? String(r2.submitted_at).slice(0, 10) : DASH}</td>
                  <td className="num">{r2.total_amount === null ? DASH : formatNumber(Number(r2.total_amount))}</td>
                  <td><span className="dd-ccy">{r2.currency ?? DASH}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {rowsOf !== null && (
        <SourcingRowsModal req={rowsOf} vendorType={vtype} onClose={() => setRowsOf(null)} onCompare={setCompare} />
      )}
      {compare !== null && <SourcingCompareModal eventId={compare} onClose={() => setCompare(null)} />}
    </>
  );
}

/**
 * An event cycle in days, or in hours / minutes below a day (21 Nov 2026): the
 * median in this Coupa store is minutes, and "0.0 d" read as no data.
 */
function cycleText(v: unknown): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return DASH;
  const d = Number(v);
  if (d >= 1) return `${d.toFixed(1)} d`;
  const h = d * 24;
  return h >= 1 ? `${h.toFixed(1)} h` : `${Math.max(0, Math.round(h * 60))} min`;
}

const MONTH_SERIES = [
  { key: 'events', label: 'Events created', color: '#2E75B6' },
  { key: 'completed', label: 'Completed', color: '#0D9488' },
];

/**
 * The rows behind one Sourcing figure (21 Nov 2026), in the Sourcing data
 * table's columns. Event figures list events (the supplier and amount are the
 * AWARDED ones); bid figures list bids. The count in the header is the
 * figure's count - the server uses the figure's own predicate.
 */
function SourcingRowsModal({ req, vendorType, onClose, onCompare }: {
  req: SourcingRowsReq;
  vendorType: '' | 'local' | 'import';
  onClose: () => void;
  onCompare: (eventId: number) => void;
}) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const qs = (offset: number) => {
    const p = new URLSearchParams({ what: req.what, limit: '200', offset: String(offset) });
    if (vendorType) p.set('vendorType', vendorType);
    for (const [k2, v2] of Object.entries(req.extra ?? {})) p.set(k2, v2);
    return p.toString();
  };
  useEffect(() => {
    let gone = false;
    api.get<Record<string, any>>(`/api/v1/coupa/sourcing/rows?${qs(0)}`)
      .then((r) => { if (!gone) { setD(r); setRows(r.rows ?? []); } })
      .catch((e: Error) => { if (!gone) setErr(e.message); });
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, vendorType]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const loadMore = async () => {
    setMore(true);
    try {
      const r = await api.get<Record<string, any>>(`/api/v1/coupa/sourcing/rows?${qs(rows.length)}`);
      setRows((cur) => [...cur, ...(r.rows ?? [])]);
    } finally { setMore(false); }
  };
  const isEvent = d?.grain === 'event';
  const showCycle = req.what === 'cycle';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={req.title} onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>🔍 {req.title}</h3>
          <span className="spacer" />
          <FloatControls onClose={onClose} />
          <button className="btn secondary" style={{ width: 'auto' }} onClick={onClose}>Close</button>
        </header>
        <div className="body">
          {err && <p className="err">{err}</p>}
          {!d && !err && <div className="center-msg"><div className="spinner" />Loading…</div>}
          {d && (
            <>
              <p className="count">
                <strong>{formatNumber(Number(d.total ?? 0))}</strong> {isEvent ? 'events' : 'bids'}
                {!isEvent && <> · {formatNumber(Number(d.suppliers ?? 0))} suppliers · {formatNumber(Number(d.events ?? 0))} events</>}
                {vendorType && <> · {vendorType === 'local' ? 'Local' : 'Import'} only</>}
                {rows.length < Number(d.total ?? 0) && <> · showing {formatNumber(rows.length)}</>}
                {isEvent && <span className="muted"> · supplier and amount are the awarded bid(s)</span>}
              </p>
              <div className="table-wrap dt-scroll">
                <table className="data dd-tbl">
                  <thead>
                    <tr>
                      <th>Event</th><th>Type</th><th>State</th><th>Commodity</th><th>Description</th>
                      <th>PR No</th><th>{isEvent ? 'Awarded supplier' : 'Supplier'}</th><th>Vendor Type</th>
                      <th className="num">Bids</th><th>Awarded</th><th>Submitted</th>
                      {showCycle && <th className="num">Cycle</th>}
                      <th className="num">{isEvent ? 'Awarded amount' : 'Amount'}</th><th>Ccy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && <tr><td colSpan={14} className="muted">No rows.</td></tr>}
                    {rows.map((r2, i) => (
                      <tr key={`${r2.event_id}|${r2.supplier_name ?? ''}|${i}`} className={i % 2 ? '' : 're'}>
                        <td>
                          <button className="cu-link" title="Compare every supplier's quote on this event" onClick={() => onCompare(Number(r2.event_id))}>
                            {r2.event_id}
                          </button>
                        </td>
                        <td>{r2.event_type ?? DASH}</td>
                        <td>{r2.event_state ?? DASH}</td>
                        <td>{r2.commodity ?? DASH}</td>
                        <td className="muted">{r2.description ?? ''}</td>
                        <td>{r2.pr_no ?? DASH}</td>
                        <td>{r2.supplier_name ?? DASH}</td>
                        <td>{r2.vendor_type ? r2.vendor_type : <span className="muted">—</span>}</td>
                        <td className="num">{formatNumber(Number(r2.bids_on_event ?? 0))}</td>
                        <td><span className={`bs ${r2.awarded ? 'sd' : 'sl'}`}>{r2.awarded ? 'Yes' : 'No'}</span></td>
                        <td>{r2.submitted_at ? String(r2.submitted_at).slice(0, 10) : DASH}</td>
                        {showCycle && <td className="num">{cycleText(r2.cycle_days)}</td>}
                        <td className="num">{r2.total_amount == null ? DASH : formatNumber(Number(r2.total_amount))}</td>
                        <td><span className="dd-ccy">{r2.currency ?? DASH}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length < Number(d.total ?? 0) && (
                <button className="btn secondary" style={{ marginTop: '.75rem', width: 'auto' }} disabled={more} onClick={() => void loadMore()}>
                  {more ? 'Loading…' : 'Load more'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Local / Import, as resolved per supplier response; nothing when unmatched. */
function VendorTypeBadge({ t }: { t: string | null | undefined }) {
  if (!t) return <span className="muted" title="Not matched to the Coupa supplier master">—</span>;
  return <span className={`chip ${t === 'Import' ? 'chip-vt-import' : 'chip-vt-local'}`}>{t}</span>;
}

/**
 * The event pipeline (19 Nov 2026): every event by the stage its Coupa state
 * puts it in, in order, each with how many drew a bid and how many were
 * awarded; then the bid funnel. Replaces a single sentence of totals that left
 * the panel looking empty.
 */
const STAGES: { key: string; label: string; hint: string; color: string }[] = [
  { key: 'draft', label: 'Draft', hint: 'Coupa state new / draft - not yet sent to suppliers', color: '#94a3b8' },
  { key: 'live', label: 'Live', hint: 'Coupa state prod - open for bids', color: '#2E75B6' },
  { key: 'paused', label: 'Paused', hint: 'Coupa state pause', color: '#d4b106' },
  { key: 'evaluation', label: 'Evaluation', hint: 'Coupa state closed_for_edit - bidding closed, award pending', color: '#ea7317' },
  { key: 'complete', label: 'Complete', hint: 'Coupa state complete - awarded or closed', color: '#0D9488' },
  { key: 'canceled', label: 'Canceled', hint: 'Coupa state canceled', color: '#C0392B' },
  { key: 'other', label: 'Other', hint: 'Any other Coupa state', color: '#64748B' },
];

function EventPipeline({ pipeline, bids, events, onOpen }: {
  pipeline: { stage: string; events: number; with_bids: number; awarded: number }[];
  bids: Record<string, any>;
  events: number;
  onOpen: (what: string, title: string, extra?: Record<string, string>) => void;
}) {
  const by = new Map(pipeline.map((p) => [p.stage, p]));
  const rows = STAGES.filter((s2) => (by.get(s2.key)?.events ?? 0) > 0);
  const max = Math.max(1, ...rows.map((s2) => by.get(s2.key)!.events));
  const funnel = [
    { label: 'Events', v: events, what: 'events' },
    { label: 'Events with a bid', v: Number(bids.events_with_bids ?? 0), what: 'with_bids' },
    { label: 'Bids submitted', v: Number(bids.responses ?? 0), what: 'bids' },
    { label: 'Bids awarded', v: Number(bids.awarded ?? 0), what: 'awarded_bids' },
  ];
  return (
    <div className="panel">
      <h3 className="pr-tbl-h"><Lbl>Event pipeline</Lbl> <span className="muted">— events by stage</span></h3>
      {rows.length === 0 && <p className="note">No sourcing events in this view.</p>}
      <div className="src-pipe">
        {rows.map((s2) => {
          const p = by.get(s2.key)!;
          return (
            <div key={s2.key} className="src-pipe-row src-click" title={`${s2.hint} - click for these events`}
              role="button" tabIndex={0}
              onClick={() => onOpen('stage', `Events at stage ${s2.label}`, { stage: s2.key })}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpen('stage', `Events at stage ${s2.label}`, { stage: s2.key }); }}>
              <span className="src-pipe-label">{s2.label}</span>
              <span className="src-pipe-track">
                <span className="src-pipe-bar" style={{ width: `${(p.events / max) * 100}%`, background: s2.color }} />
              </span>
              <span className="src-pipe-num">
                <strong>{formatNumber(p.events)}</strong>
                <span className="muted"> · {formatNumber(p.with_bids)} with bids · {formatNumber(p.awarded)} awarded</span>
              </span>
            </div>
          );
        })}
      </div>
      <div className="src-funnel">
        {funnel.map((f, i) => (
          <div key={f.label} className="src-funnel-step src-click" role="button" tabIndex={0}
            title={`Click for the ${f.label.toLowerCase()}`}
            onClick={() => onOpen(f.what, f.label)}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(f.what, f.label); }}>
            <div className="v">{formatNumber(f.v)}</div>
            <div className="l">{f.label}</div>
            {i > 0 && funnel[i - 1]!.v > 0 && i !== 2 && (
              <div className="muted src-funnel-rate">{((f.v / funnel[i - 1]!.v) * 100).toFixed(0)}% of previous</div>
            )}
            {i === 2 && funnel[1]!.v > 0 && (
              <div className="muted src-funnel-rate">{(f.v / funnel[1]!.v).toFixed(1)} per event</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * One event, every supplier side by side (19 Nov 2026): the lines that were
 * asked for, and per supplier what was quoted against each - unit price and
 * line total, lead time, the item offered, shipping term - with the award
 * ticked and the lowest price per line marked.
 */
function SourcingCompareModal({ eventId, onClose }: { eventId: number; onClose: () => void }) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    api.get<Record<string, any>>(`/api/v1/coupa/sourcing/event/${eventId}`)
      .then((r) => { if (!gone) setD(r); })
      .catch((e: Error) => { if (!gone) setErr(e.message); });
    return () => { gone = true; };
  }, [eventId]);

  const ev = d?.event ?? {};
  const suppliers: Record<string, any>[] = d?.suppliers ?? [];
  const quote: Record<string, any>[] = d?.quoteLines ?? [];
  // The rows: the event's own lines; if the raw event is missing, the lines
  // the quotes answer.
  const reqLines: Record<string, any>[] = (d?.requestLines ?? []).length > 0
    ? d!.requestLines
    : [...new Set(quote.map((q) => q.request_line_id))].map((id, i) => ({ id, line_no: i + 1, description: `Line ${i + 1}` }));
  const cell = (supplierId: unknown, lineId: unknown) =>
    quote.find((q) => String(q.response_id) === String(supplierId) && String(q.request_line_id) === String(lineId));
  const num = (v: unknown, dg = 0) => (v === null || v === undefined || v === '' ? DASH : formatNumber(Number(v), dg));
  const lowestFor = (lineId: unknown): number | null => {
    const prices = quote.filter((q) => String(q.request_line_id) === String(lineId) && Number(q.price) > 0).map((q) => Number(q.price));
    return prices.length > 1 ? Math.min(...prices) : null;
  };
  const priced = suppliers.filter((s2) => Number(s2.total_amount) > 0);
  const lowestTotal = priced.length > 1 ? Math.min(...priced.map((s2) => Number(s2.total_amount))) : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Sourcing event ${eventId}`} onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>🛒 Event {eventId} <span className="muted">{ev.description ?? ''}</span></h3>
          <span className="spacer" />
          <FloatControls onClose={onClose} />
          <button className="btn secondary" style={{ width: 'auto' }} onClick={onClose}>Close</button>
        </header>
        <div className="body">
          {err && <p className="err">{err}</p>}
          {!d && !err && <div className="center-msg"><div className="spinner" />Loading the quotes…</div>}
          {d && (
            <>
              <p className="note" style={{ marginTop: 0 }}>
                {String(ev.event_type ?? '').toUpperCase()} · state {ev.state ?? DASH}
                {ev.commodity ? ` · ${ev.commodity}` : ''}{ev.plant ? ` · plant ${ev.plant}` : ''}
                {ev.purch_org ? ` · org ${ev.purch_org}` : ''}{ev.purch_group ? ` · group ${ev.purch_group}` : ''}
                {ev.pr_no ? ` · PR No ${ev.pr_no}` : ''}
                {ev.start_time ? ` · ${String(ev.start_time).slice(0, 10)}` : ''}{ev.end_time ? ` → ${String(ev.end_time).slice(0, 10)}` : ''}
              </p>
              {d.fetchNote && <p className="note"><span className="bs sl">note</span> {d.fetchNote}</p>}

              <h4 className="ent-h">Suppliers <span className="muted">· {formatNumber(suppliers.length)} responses</span></h4>
              <div className="table-wrap">
                <table className="data dd-tbl">
                  <thead>
                    <tr>
                      <th>Supplier</th><th>Vendor Type</th><th>State</th><th>Submitted</th>
                      <th className="num">Quoted total</th><th>Ccy</th><th>Awarded</th><th>Comments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suppliers.length === 0 && <tr><td colSpan={8} className="muted">No supplier has responded to this event.</td></tr>}
                    {suppliers.map((s2, i) => (
                      <tr key={s2.id} className={i % 2 ? '' : 're'}>
                        <td>{s2.supplier_name ?? DASH}{s2.supplier_email ? <div className="muted" style={{ fontSize: '.7rem' }}>{s2.supplier_email}</div> : null}</td>
                        <td><VendorTypeBadge t={s2.vendor_type} /></td>
                        <td>{s2.state ?? DASH}</td>
                        <td>{s2.submitted_at ? String(s2.submitted_at).slice(0, 10) : DASH}</td>
                        <td className="num">
                          {num(s2.total_amount, 2)}
                          {lowestTotal !== null && Number(s2.total_amount) === lowestTotal && <span className="chip chip-ok src-low">lowest</span>}
                        </td>
                        <td><span className="dd-ccy">{s2.currency ?? DASH}</span></td>
                        <td><span className={`bs ${s2.awarded ? 'sd' : 'sl'}`}>{s2.awarded ? 'Yes' : 'No'}</span></td>
                        <td className="muted" style={{ whiteSpace: 'normal', minWidth: '10rem' }}>{s2.comments ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h4 className="ent-h">Line-by-line comparison</h4>
              {quote.length === 0 ? (
                <p className="note">No line detail stored for this event{suppliers.length > 0 ? ' - only the supplier totals above' : ''}.</p>
              ) : (
                <div className="table-wrap dt-scroll">
                  <table className="data dd-tbl src-cmp">
                    <thead>
                      <tr>
                        <th className="src-cmp-line">Requested</th>
                        {suppliers.map((s2) => (
                          <th key={s2.id} className={s2.awarded ? 'src-cmp-awarded' : ''}>
                            {s2.supplier_name ?? DASH} {s2.awarded ? '✔' : ''}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {reqLines.map((l, i) => {
                        const low = lowestFor(l.id);
                        return (
                          <tr key={String(l.id)} className={i % 2 ? '' : 're'}>
                            <td className="src-cmp-line">
                              <strong>{l.line_no}. {l.description ?? DASH}</strong>
                              {l.spec && l.spec !== l.description && <div className="muted">{l.spec}</div>}
                              <div className="muted">
                                Qty {num(l.quantity, 2)}{l.need_by ? ` · need by ${l.need_by}` : ''}
                                {l.manufacturer ? ` · ${l.manufacturer}` : ''}{l.part_number ? ` · P/N ${l.part_number}` : ''}
                              </div>
                            </td>
                            {suppliers.map((s2) => {
                              const q = cell(s2.id, l.id);
                              if (!q) return <td key={s2.id} className="muted">no quote</td>;
                              const price = Number(q.price);
                              // A zero price is a supplier who answered without pricing the line.
                              if (!(price > 0)) {
                                return <td key={s2.id} className="muted">no price quoted{q.shipping_term ? ` · ${q.shipping_term}` : ''}</td>;
                              }
                              return (
                                <td key={s2.id} className={q.awarded ? 'src-cmp-awarded' : ''}>
                                  <div>
                                    <strong>{num(q.price, 2)}</strong> <span className="dd-ccy">{q.currency ?? ''}</span>
                                    {low !== null && price === low && <span className="chip chip-ok src-low">lowest</span>}
                                    {q.awarded && <span className="chip chip-vt-local src-low">awarded{q.awarded_quantity ? ` ${num(q.awarded_quantity, 2)}` : ''}</span>}
                                  </div>
                                  <div className="muted">
                                    Qty {num(q.quantity, 2)} · total {q.price !== null && q.quantity !== null ? num(Number(q.price) * Number(q.quantity), 2) : DASH}
                                  </div>
                                  <div className="muted">
                                    {q.lead_time_days !== null && q.lead_time_days !== undefined ? `Lead time ${q.lead_time_days} d` : 'Lead time —'}
                                    {q.shipping_term ? ` · ${q.shipping_term}` : ''}
                                    {Number(q.attachment_count) > 0 ? ` · 📎 ${q.attachment_count}` : ''}
                                  </div>
                                  {(q.supplier_item_name || q.item_description || q.part_number) && (
                                    <div className="muted">
                                      {[q.supplier_item_name, q.item_description, q.part_number ? `P/N ${q.part_number}` : null].filter(Boolean).join(' · ')}
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="note" style={{ marginBottom: 0 }}>
                Unit prices as each supplier quoted them, in the quote's currency; "lowest" marks the
                lowest unit price on a line (and the lowest total above) when more than one supplier priced it.
                Vendor Type comes from matching the supplier to Coupa's supplier master (LN… Local, IN… Import).
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────── Invoicing & Payment page

const INV_PILL: Record<string, string> = {
  paid: 'sd', approved: 'su', pending_approval: 'sn', pending_receipt: 'sn',
  voided: 'spdel', draft: 'sl', disputed: 'sa', on_hold: 'shold',
};

/**
 * The Invoicing & Payment page.
 *
 * 23 Nov 2026: its layout is configurable like the other pages - the same
 * shared, Admin-only layout (049): cards and panels can be moved and hidden -
 * and every amount follows the IDR / USD switch, each invoice converted at its
 * own month's rate (the server returns both currencies).
 */
const INV_CARD_IDS = [
  'inv_total', 'inv_paid', 'inv_open', 'inv_open_amt', 'inv_gross_amt', 'inv_payments', 'inv_paid_amt', 'inv_avg_days',
];
const INV_PANEL_IDS = [
  'inv_by_month', 'pay_by_month', 'inv_top_suppliers', 'inv_aging', 'inv_status_mix', 'inv_recent', 'pay_recent',
];
const EMPTY_LAYOUT_LOCAL: TabLayout = {
  hidden: [], kpiOrder: [], chartOrder: [], replaced: {}, addedKpis: [], addedCharts: [],
  customKpis: [], customCharts: [], panelOrder: [],
} as unknown as TabLayout;

export function CoupaInvoicesTab({
  currency = 'IDR', layout = EMPTY_LAYOUT_LOCAL, updateLayout, editing = false, setEditing, isAdmin = false,
}: {
  currency?: 'USD' | 'IDR';
  layout?: TabLayout;
  updateLayout?: (mut: (cur: TabLayout) => TabLayout) => void;
  editing?: boolean;
  setEditing?: (v: boolean) => void;
  isAdmin?: boolean;
}) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** The figure whose invoices / payments are open (21 Nov 2026). */
  const [rowsOf, setRowsOf] = useState<SourcingRowsReq | null>(null);
  /** The invoice whose lines are open. */
  const [lineOf, setLineOf] = useState<number | null>(null);
  const open = (what: string, title: string, extra?: Record<string, string>) =>
    setRowsOf({ what, title, ...(extra ? { extra } : {}) });
  useEffect(() => {
    api.get<Record<string, any>>('/api/v1/coupa/invoices').then(setD).catch((e: Error) => setErr(e.message));
  }, []);
  if (err) return <div className="panel"><h2><Lbl>Invoicing &amp; Payment</Lbl></h2><p className="err">{err}</p></div>;
  if (!d) return <div className="center-msg"><div className="spinner" />Loading Coupa invoices…</div>;
  if (!d.configured) {
    return <div className="panel"><h2><Lbl>Invoicing &amp; Payment</Lbl></h2><p className="note">Coupa is not configured on this environment — an administrator must set the backend COUPA_* variables (Admin tab).</p></div>;
  }
  const k = d.kpis ?? {};
  const p2 = d.pay ?? {};
  const isIdr = currency === 'IDR';
  /** An amount pair (usd, idr) in the reader's currency. */
  const money = (usd: unknown, idr: unknown): string => {
    const v = isIdr ? idr : usd;
    return v === null || v === undefined ? DASH : formatMoney(Number(v), currency);
  };
  const paidPct = Number(k.invoices ?? 0) > 0 ? ((Number(k.paid_count ?? 0) / Number(k.invoices)) * 100).toFixed(0) : null;
  const unratedNote = Number(k.unrated ?? 0) > 0 ? `${k.unrated} without an FX rate, not in the amount` : undefined;
  function onInvoiceBar(row: Record<string, any>, key: string) {
    const mk = String(row.mk);
    if (key === 'paid') open('month_paid', `Invoices dated ${mk}, paid`, { month: mk });
    else open('month_invoices', `Invoices dated ${mk}`, { month: mk });
  }
  function onPaymentBar(row: Record<string, any>) {
    const mk = String(row.mk);
    open('month_payments', `Payments in ${mk}`, { month: mk });
  }

  const CARDS: Record<string, React.ReactNode> = {
    inv_total: <Kpi v={formatNumber(Number(k.invoices ?? 0))} label="Total invoices" sub={`${k.currencies ?? 0} currencies`}
      onClick={() => open('invoices', 'All invoices')} />,
    inv_paid: <Kpi v={formatNumber(Number(k.paid_count ?? 0))} label="Paid" sub={paidPct === null ? undefined : `${paidPct}% of all invoices`}
      onClick={() => open('paid', 'Paid invoices')} />,
    inv_open: <Kpi v={formatNumber(Number(k.open_count ?? 0))} label="Open (unpaid)" sub="excl. drafts and voided"
      onClick={() => open('open', 'Open (unpaid) invoices')} />,
    inv_open_amt: <Kpi v={money(k.open_usd, k.open_idr)} label={`Open payables (${currency})`}
      sub={unratedNote ?? 'every currency at its month’s rate'}
      onClick={() => open('open_idr', 'Open payables')} />,
    inv_gross_amt: <Kpi v={money(k.gross_usd, k.gross_idr)} label={`Gross invoiced (${currency})`}
      sub={k.tax_idr == null ? undefined : `tax ${money(k.tax_usd, k.tax_idr)}`}
      onClick={() => open('gross_idr', 'Gross invoiced')} />,
    inv_payments: <Kpi v={formatNumber(Number(p2.payments ?? 0))} label="Payments recorded" sub={`${formatNumber(Number(p2.with_sap_doc ?? 0))} with SAP payment doc`}
      onClick={() => open('payments', 'Payments recorded')} />,
    inv_paid_amt: <Kpi v={money(p2.paid_usd, p2.paid_idr)} label={`Paid amount (${currency})`}
      onClick={() => open('payments_idr', 'Paid amount')} />,
    // Not clickable (23 Nov 2026): an average; the paid invoices open from Paid.
    inv_avg_days: <Kpi v={k.avg_days_to_pay == null ? DASH : `${Number(k.avg_days_to_pay).toFixed(1)} d`} label="Avg days to pay" sub="invoice date → payment date" />,
  };

  const PANELS: Record<string, React.ReactNode> = {
    inv_by_month: (
      <OpsBars title="Invoices by month" rows={d.invoicesByMonth ?? []} series={INVOICE_SERIES} onBar={onInvoiceBar} />
    ),
    pay_by_month: (
      <OpsBars title={`Payments by month (M ${currency})`} rows={d.paymentsByMonth ?? []}
        series={isIdr ? PAYMENT_SERIES_IDR : PAYMENT_SERIES_USD} onBar={onPaymentBar} />
    ),
    inv_top_suppliers: (
      <div className="panel">
        <h3 className="pr-tbl-h"><Lbl>Top suppliers by invoiced value</Lbl></h3>
        <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table className="data dd-tbl">
            <thead><tr><th>Supplier</th><th className="num">Invoices</th><th className="num">Paid</th><th className="num">Gross ({currency})</th></tr></thead>
            <tbody>
              {(d.topSuppliers ?? []).map((t: any, i: number) => {
                const sp = { supplier: String(t.supplier_name) };
                return (
                  <tr key={t.supplier_name} className={i % 2 ? '' : 're'}>
                    <td>{t.supplier_name}</td>
                    <td className="num">
                      <button className="cu-link" onClick={() => open('supplier', `Invoices — ${t.supplier_name}`, sp)}>{formatNumber(t.invoices)}</button>
                    </td>
                    <td className="num">
                      <button className="cu-link" onClick={() => open('supplier_paid', `Paid invoices — ${t.supplier_name}`, sp)}>{formatNumber(t.paid)}</button>
                    </td>
                    <td className="num">
                      <button className="cu-link" onClick={() => open('supplier_gross', `Invoiced — ${t.supplier_name}`, sp)}>{money(t.gross_usd, t.gross_idr)}</button>
                      {Number(t.unrated) > 0 ? <span className="muted" title={`${t.unrated} invoices without an FX rate, not in the amount`}> ⚠</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    ),
    inv_aging: (
      <div className="panel">
        <h3 className="pr-tbl-h"><Lbl>Open payables aging — days past due</Lbl></h3>
        <p className="note" style={{ marginTop: 0 }}>Due date = invoice date + the payment term's days (I30, D30…). Click a bucket for its invoices.</p>
        <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
          <table className="data dd-tbl">
            <thead><tr><th>Days past due</th><th className="num">Invoices</th><th className="num">Amount ({currency})</th><th style={{ width: '35%' }} /></tr></thead>
            <tbody>
              {(d.aging ?? []).length === 0 && <tr><td colSpan={4} className="muted">No open invoices.</td></tr>}
              {(() => {
                const rows = (d.aging ?? []) as any[];
                const max = Math.max(1, ...rows.map((x) => Number(x.invoices)));
                return rows.map((x, i) => (
                  <tr key={x.bucket} className={`ent-row ${i % 2 ? '' : 're'}`} title="Click for these invoices"
                    onClick={() => open('aging', agingTitle(String(x.bucket)), { bucket: String(x.bucket) })}>
                    <td><span className={`bs ${AGING_PILL[String(x.bucket)] ?? 'sl'}`}>{agingLabel(String(x.bucket))}</span></td>
                    <td className="num">{formatNumber(Number(x.invoices))}</td>
                    <td className="num">{money(x.gross_usd, x.gross_idr)}{Number(x.unrated) > 0 ? <span className="muted" title={`${x.unrated} without an FX rate`}> ⚠</span> : null}</td>
                    <td><span className="aging-bar" style={{ width: `${(Number(x.invoices) / max) * 100}%` }} /></td>
                  </tr>
                ));
              })()}
            </tbody>
          </table>
        </div>
      </div>
    ),
    inv_status_mix: (
      <div className="panel">
        <h3 className="pr-tbl-h"><Lbl>Invoice status mix</Lbl></h3>
        <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table className="data dd-tbl">
            <thead><tr><th>Status</th><th className="num">Invoices</th></tr></thead>
            <tbody>
              {(d.statusMix ?? []).map((x: any, i: number) => (
                <tr key={x.status} className={`ent-row ${i % 2 ? '' : 're'}`} title="Click for these invoices"
                  onClick={() => open('status', `Invoices — status ${x.status}`, { status: String(x.status) })}>
                  <td><span className={`bs ${INV_PILL[String(x.status)] ?? 'sl'}`}>{x.status}</span></td>
                  <td className="num">{formatNumber(x.n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ),
    inv_recent: (
      <div className="panel">
        <h3 className="pr-tbl-h"><Lbl>Recent invoices</Lbl> <span className="muted">— newest 50 · click a row for its lines</span></h3>
        <div className="table-wrap dt-scroll" style={{ maxHeight: 340 }}>
          <table className="data dd-tbl">
            <thead>
              <tr>
                <th>Invoice #</th><th>Date</th><th>Supplier</th><th>PO No</th><th>Status</th>
                <th className="num">Gross</th><th>Ccy</th><th className="num">Gross ({currency})</th>
                <th>Term</th><th>Due</th><th className="num">Overdue (d)</th><th>Paid on</th>
              </tr>
            </thead>
            <tbody>
              {(d.recentInvoices ?? []).map((i2: any, i: number) => (
                <tr key={i2.id} className={`ent-row ${i % 2 ? '' : 're'}`} title="Click for this invoice's lines"
                  onClick={() => setLineOf(Number(i2.id))}>
                  <td>{i2.invoice_number ?? i2.id}</td>
                  <td>{fmtDate(i2.invoice_date)}</td>
                  <td>{(i2.supplier_name ?? '').slice(0, 28)}</td>
                  <td><PoNos sap={i2.sap_po_no} coupa={i2.coupa_po_no} /></td>
                  <td><span className={`bs ${i2.paid ? 'sd' : INV_PILL[String(i2.status)] ?? 'sl'}`}>{i2.paid ? 'paid' : i2.status}</span></td>
                  <td className="num">{i2.gross_total === null ? DASH : formatNumber(Number(i2.gross_total))}</td>
                  <td><span className="dd-ccy">{i2.currency ?? DASH}</span></td>
                  <td className="num">{money(i2.gross_usd, i2.gross_idr)}</td>
                  <td>{i2.payment_term ?? DASH}</td>
                  <td>{fmtDate(i2.due_date)}</td>
                  <td className="num"><Overdue inv={i2} /></td>
                  <td>{fmtDate(i2.payment_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ),
    pay_recent: (
      <div className="panel">
        <h3 className="pr-tbl-h"><Lbl>Recent payments</Lbl> <span className="muted">— newest 50</span></h3>
        <div className="table-wrap dt-scroll" style={{ maxHeight: 340 }}>
          <table className="data dd-tbl">
            <thead>
              <tr><th>Paid on</th><th>Invoice #</th><th>Supplier</th><th>PO No</th><th className="num">Amount</th><th>Ccy</th><th className="num">Amount ({currency})</th><th>SAP doc</th></tr>
            </thead>
            <tbody>
              {(d.recentPayments ?? []).map((p3: any, i: number) => (
                <tr key={`${p3.invoice_number}|${i}`} className={`ent-row ${i % 2 ? '' : 're'}`} title="Click for this invoice's lines"
                  onClick={() => setLineOf(Number(p3.invoice_id))}>
                  <td>{fmtDate(p3.payment_date)}</td>
                  <td>{p3.invoice_number ?? DASH}</td>
                  <td>{(p3.supplier_name ?? '').slice(0, 28)}</td>
                  <td><PoNos sap={p3.sap_po_no} coupa={p3.coupa_po_no} /></td>
                  <td className="num">{p3.amount_paid === null ? DASH : formatNumber(Number(p3.amount_paid))}</td>
                  <td><span className="dd-ccy">{p3.currency ?? DASH}</span></td>
                  <td className="num">{money(p3.amount_usd, p3.amount_idr)}</td>
                  <td>{p3.sap_payment_doc ?? DASH}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ),
  };

  const cardSlots = applyLayout(INV_CARD_IDS, layout, 'kpi');
  const panelSlots = applyLayout(INV_PANEL_IDS, layout, 'panel');
  const canEdit = isAdmin && updateLayout !== undefined && setEditing !== undefined;
  const slot = (id: string, kind: 'kpi' | 'panel', currentIds: string[], node: React.ReactNode) => (
    <div key={id} className={editing && canEdit ? 'ly-slot' : undefined}>
      {editing && canEdit && (
        <LayoutControls id={id} kind={kind} layout={layout} update={updateLayout!} currentIds={currentIds} />
      )}
      {node}
    </div>
  );

  return (
    <>
      <SyncNote watermarks={d.watermarks} converted />
      {canEdit && (
        <LayoutEditBar
          editing={editing}
          setEditing={setEditing!}
          layout={layout}
          update={updateLayout!}
          kpiOptions={[]}
          chartOptions={[]}
          customOptions={{ kpis: [], charts: [] }}
          showAdders={false}
        />
      )}
      <div className="kpi-grid" style={{ marginBottom: '1rem' }}>
        {cardSlots.filter((id) => CARDS[id]).map((id) => slot(id, 'kpi', cardSlots, CARDS[id]))}
      </div>
      <div className="chart-grid">
        {panelSlots.filter((id) => PANELS[id]).map((id) => slot(id, 'panel', panelSlots, PANELS[id]))}
      </div>
      {rowsOf !== null && (
        <InvoiceRowsModal req={rowsOf} currency={currency} onClose={() => setRowsOf(null)} onInvoice={setLineOf} />
      )}
      {lineOf !== null && <InvoiceLinesModal invoiceId={lineOf} onClose={() => setLineOf(null)} />}
    </>
  );
}

const INVOICE_SERIES = [
  { key: 'invoices', label: 'Invoices', color: '#2E75B6' },
  { key: 'paid', label: 'Paid', color: '#4CAF50' },
];
const PAYMENT_SERIES_IDR = [{ key: 'paid_idr', label: 'Paid (IDR)', color: '#0D9488', money: true, currency: 'IDR' }];
const PAYMENT_SERIES_USD = [{ key: 'paid_usd', label: 'Paid (USD)', color: '#0D9488', money: true, currency: 'USD' }];

/**
 * An invoice's purchase orders: the SAP PO number(s), with Coupa's own PO
 * number(s) beneath in grey - the two systems' names for the same order.
 */
function PoNos({ sap, coupa }: { sap: string | null | undefined; coupa: string | null | undefined }) {
  if (!sap && !coupa) return <span className="muted">{DASH}</span>;
  return (
    <span className="po-nos">
      {sap ? <span>{sap}</span> : <span className="muted">no SAP PO</span>}
      {coupa && <span className="muted" title="Coupa PO number"> · Coupa {coupa}</span>}
    </span>
  );
}

const fmtDate = (v: unknown): string => (v ? String(v).slice(0, 10) : DASH);

/** Days past due of an OPEN invoice; a paid one shows how late it was paid. */
function Overdue({ inv }: { inv: Record<string, any> }) {
  if (inv.paid) {
    return inv.paid_late_days != null && Number(inv.paid_late_days) > 0
      ? <span className="muted" title="Paid this many days after the due date">{formatNumber(Number(inv.paid_late_days))} late</span>
      : <span className="muted">{DASH}</span>;
  }
  if (inv.overdue_days == null) return <span className="muted" title="No payment term">{DASH}</span>;
  const n = Number(inv.overdue_days);
  return n > 0 ? <strong style={{ color: n > 90 ? '#C0392B' : n > 30 ? '#B45309' : undefined }}>{formatNumber(n)}</strong>
    : <span className="muted">not due</span>;
}

const AGING_PILL: Record<string, string> = {
  'Not yet due': 'sd', '1-30': 'su', '31-60': 'sn', '61-90': 'sn', '91-180': 'sa', '>180': 'spdel', 'No term': 'sl',
};
const agingLabel = (b: string): string => (b === 'Not yet due' || b === 'No term' ? b : `${b} d`);
const agingTitle = (b: string): string =>
  b === 'Not yet due' || b === 'No term' ? `Open invoices — ${b.toLowerCase()}` : `Open invoices — ${b} days overdue`;

/**
 * The invoices or payments behind one Invoicing & Payment figure (21 Nov
 * 2026), each with its PO numbers; a row opens the invoice's lines. The count
 * in the header is the figure's count - the server uses its own predicate.
 */
function InvoiceRowsModal({ req, currency = 'IDR', onClose, onInvoice }: {
  req: SourcingRowsReq;
  currency?: 'USD' | 'IDR';
  onClose: () => void;
  onInvoice: (invoiceId: number) => void;
}) {
  const conv = (usd: unknown, idr: unknown): string => {
    const v = currency === 'IDR' ? idr : usd;
    return v === null || v === undefined ? DASH : formatMoney(Number(v), currency);
  };
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const qs = (offset: number) => {
    const p = new URLSearchParams({ what: req.what, limit: '200', offset: String(offset) });
    for (const [k2, v2] of Object.entries(req.extra ?? {})) p.set(k2, v2);
    return p.toString();
  };
  useEffect(() => {
    let gone = false;
    api.get<Record<string, any>>(`/api/v1/coupa/invoices/rows?${qs(0)}`)
      .then((r) => { if (!gone) { setD(r); setRows(r.rows ?? []); } })
      .catch((e: Error) => { if (!gone) setErr(e.message); });
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const loadMore = async () => {
    setMore(true);
    try {
      const r = await api.get<Record<string, any>>(`/api/v1/coupa/invoices/rows?${qs(rows.length)}`);
      setRows((cur) => [...cur, ...(r.rows ?? [])]);
    } finally { setMore(false); }
  };
  const isPay = d?.grain === 'payment';
  const showDays = req.what === 'days_to_pay';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={req.title} onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>🔍 {req.title}</h3>
          <span className="spacer" />
          <FloatControls onClose={onClose} />
          <button className="btn secondary" style={{ width: 'auto' }} onClick={onClose}>Close</button>
        </header>
        <div className="body">
          {err && <p className="err">{err}</p>}
          {!d && !err && <div className="center-msg"><div className="spinner" />Loading…</div>}
          {d && (
            <>
              <p className="count">
                <strong>{formatNumber(Number(d.total ?? 0))}</strong> {isPay ? 'payments' : 'invoices'}
                {!isPay && <> · Σ {conv(d.grossUsd, d.grossIdr)} gross</>}
                {isPay && <> · Σ {conv(d.paidUsd, d.paidIdr)} paid</>}
                {Number(d.unrated ?? 0) > 0 && <> · {formatNumber(Number(d.unrated))} without an FX rate, not in the total</>}
                {rows.length < Number(d.total ?? 0) && <> · showing {formatNumber(rows.length)}</>}
                <span className="muted"> · click a row for the invoice's lines</span>
              </p>
              <div className="table-wrap dt-scroll">
                <table className="data dd-tbl">
                  <thead>
                    {isPay ? (
                      <tr>
                        <th>Paid on</th><th>Invoice #</th><th>Invoice date</th><th>Supplier</th><th>PO No</th>
                        <th className="num">Amount</th><th>Ccy</th><th className="num">Amount ({currency})</th><th>Term</th><th>Due</th>
                        <th className="num">Days to pay</th><th className="num">Paid late (d)</th><th>SAP payment doc</th>
                      </tr>
                    ) : (
                      <tr>
                        <th>Invoice #</th><th>Date</th><th>Supplier</th><th>PO No</th><th>Status</th>
                        <th className="num">Gross</th><th className="num">Tax</th><th>Ccy</th><th className="num">Gross ({currency})</th><th>Term</th>
                        <th>Due</th><th className="num">Age (d)</th><th className="num">Overdue (d)</th><th>Aging</th>
                        <th>Paid on</th>{showDays && <th className="num">Days to pay</th>}<th className="num">Lines</th>
                      </tr>
                    )}
                  </thead>
                  <tbody>
                    {rows.length === 0 && <tr><td colSpan={12} className="muted">No rows.</td></tr>}
                    {rows.map((r2, i) => (
                      <tr key={`${r2.payment_id ?? r2.id}|${i}`} className={`ent-row ${i % 2 ? '' : 're'}`}
                        title="Click for this invoice's lines" onClick={() => onInvoice(Number(r2.id))}>
                        {isPay ? (
                          <>
                            <td>{fmtDate(r2.payment_date)}</td>
                            <td>{r2.invoice_number ?? r2.id}</td>
                            <td>{fmtDate(r2.invoice_date)}</td>
                            <td>{(r2.supplier_name ?? '').slice(0, 32)}</td>
                            <td><PoNos sap={r2.sap_po_no} coupa={r2.coupa_po_no} /></td>
                            <td className="num">{r2.amount_paid == null ? DASH : formatNumber(Number(r2.amount_paid))}</td>
                            <td><span className="dd-ccy">{r2.currency ?? DASH}</span></td>
                            <td className="num">{conv(r2.amount_usd, r2.amount_idr)}</td>
                            <td>{r2.payment_term ?? DASH}</td>
                            <td>{fmtDate(r2.due_date)}</td>
                            <td className="num">{r2.days_to_pay == null ? DASH : formatNumber(Number(r2.days_to_pay))}</td>
                            <td className="num">{r2.paid_late_days == null ? DASH : formatNumber(Number(r2.paid_late_days))}</td>
                            <td>{r2.sap_payment_doc ?? DASH}</td>
                          </>
                        ) : (
                          <>
                            <td>{r2.invoice_number ?? r2.id}</td>
                            <td>{fmtDate(r2.invoice_date)}</td>
                            <td>{(r2.supplier_name ?? '').slice(0, 32)}</td>
                            <td><PoNos sap={r2.sap_po_no} coupa={r2.coupa_po_no} /></td>
                            <td><span className={`bs ${r2.paid ? 'sd' : INV_PILL[String(r2.status)] ?? 'sl'}`}>{r2.paid ? 'paid' : r2.status}</span></td>
                            <td className="num">{r2.gross_total == null ? DASH : formatNumber(Number(r2.gross_total))}</td>
                            <td className="num">{r2.tax_amount == null ? DASH : formatNumber(Number(r2.tax_amount))}</td>
                            <td><span className="dd-ccy">{r2.currency ?? DASH}</span></td>
                            <td className="num">{conv(r2.gross_usd, r2.gross_idr)}</td>
                            <td>{r2.payment_term ?? DASH}</td>
                            <td>{fmtDate(r2.due_date)}</td>
                            <td className="num">{r2.age_days == null ? DASH : formatNumber(Number(r2.age_days))}</td>
                            <td className="num"><Overdue inv={r2} /></td>
                            <td>{r2.aging_bucket ? <span className={`bs ${AGING_PILL[String(r2.aging_bucket)] ?? 'sl'}`}>{agingLabel(String(r2.aging_bucket))}</span> : DASH}</td>
                            <td>{fmtDate(r2.payment_date)}</td>
                            {showDays && <td className="num">{r2.days_to_pay == null ? DASH : formatNumber(Number(r2.days_to_pay))}</td>}
                            <td className="num">{formatNumber(Number(r2.lines ?? 0))}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length < Number(d.total ?? 0) && (
                <button className="btn secondary" style={{ marginTop: '.75rem', width: 'auto' }} disabled={more} onClick={() => void loadMore()}>
                  {more ? 'Loading…' : 'Load more'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** One invoice, line by line, with the SAP and Coupa PO of each line and its payments. */
function InvoiceLinesModal({ invoiceId, onClose }: { invoiceId: number; onClose: () => void }) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    api.get<Record<string, any>>(`/api/v1/coupa/invoices/${invoiceId}/lines`)
      .then((r) => { if (!gone) setD(r); })
      .catch((e: Error) => { if (!gone) setErr(e.message); });
    return () => { gone = true; };
  }, [invoiceId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const inv = d?.invoice ?? {};
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Invoice ${invoiceId}`} onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>🧾 Invoice {inv.invoice_number ?? invoiceId} <span className="muted">{inv.supplier_name ?? ''}</span></h3>
          <span className="spacer" />
          <FloatControls onClose={onClose} />
          <button className="btn secondary" style={{ width: 'auto' }} onClick={onClose}>Close</button>
        </header>
        <div className="body">
          {err && <p className="err">{err}</p>}
          {!d && !err && <div className="center-msg"><div className="spinner" />Loading…</div>}
          {d && (
            <>
              <p className="count">
                {fmtDate(inv.invoice_date)} · <span className={`bs ${inv.paid ? 'sd' : INV_PILL[String(inv.status)] ?? 'sl'}`}>{inv.paid ? 'paid' : inv.status}</span>
                {' · '}gross {inv.gross_total == null ? DASH : formatNumber(Number(inv.gross_total))} <span className="dd-ccy">{inv.currency ?? ''}</span>
                {inv.payment_term ? <> · term {inv.payment_term}</> : null}
                {inv.due_date ? <> · due {fmtDate(inv.due_date)}</> : null}
                {inv.payment_date ? <> · paid on {fmtDate(inv.payment_date)}</> : null}
                {inv.age_days != null ? <> · age {formatNumber(Number(inv.age_days))} d</> : null}
                {inv.paid
                  ? (inv.paid_late_days != null && Number(inv.paid_late_days) > 0 ? <> · paid {formatNumber(Number(inv.paid_late_days))} d late</> : null)
                  : (inv.overdue_days != null ? <> · <strong>{Number(inv.overdue_days) > 0 ? `${formatNumber(Number(inv.overdue_days))} d overdue` : 'not yet due'}</strong></> : null)}
                {' · PO No '}<PoNos sap={inv.sap_po_no} coupa={inv.coupa_po_no} />
              </p>
              <div className="table-wrap dt-scroll">
                <table className="data dd-tbl">
                  <thead>
                    <tr>
                      <th>Line</th><th>SAP PO</th><th className="num">PO item</th><th>Coupa PO</th><th>Item</th><th>Description</th>
                      <th className="num">Qty</th><th>UoM</th><th className="num">Price</th><th className="num">Total</th>
                      <th className="num">Tax</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(d.lines ?? []).length === 0 && <tr><td colSpan={12} className="muted">No lines stored for this invoice.</td></tr>}
                    {(d.lines ?? []).map((l: any, i: number) => (
                      <tr key={l.id} className={i % 2 ? '' : 're'}>
                        <td>{i + 1}</td>
                        <td>{l.sap_po_no ?? DASH}</td>
                        <td className="num">{l.sap_po_item ?? DASH}</td>
                        <td>{l.coupa_po_no ?? DASH}</td>
                        <td>{l.item_number ?? DASH}</td>
                        <td className="muted">{(l.description ?? '').slice(0, 60)}</td>
                        <td className="num">{l.quantity == null ? DASH : formatNumber(Number(l.quantity), 3)}</td>
                        <td>{l.uom ?? DASH}</td>
                        <td className="num">{l.price == null ? DASH : formatNumber(Number(l.price))}</td>
                        <td className="num">{l.total == null ? DASH : formatNumber(Number(l.total))}</td>
                        <td className="num">{l.tax_amount == null ? DASH : formatNumber(Number(l.tax_amount))}</td>
                        <td>{l.status ?? DASH}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(d.payments ?? []).length > 0 && (
                <>
                  <h4 className="ent-h" style={{ marginTop: '1rem' }}>Payments</h4>
                  <div className="table-wrap">
                    <table className="data dd-tbl">
                      <thead><tr><th>Paid on</th><th className="num">Amount</th><th>SAP payment doc</th><th>Notes</th></tr></thead>
                      <tbody>
                        {(d.payments ?? []).map((p: any, i: number) => (
                          <tr key={i} className={i % 2 ? '' : 're'}>
                            <td>{fmtDate(p.payment_date)}</td>
                            <td className="num">{p.amount_paid == null ? DASH : formatNumber(Number(p.amount_paid))}</td>
                            <td>{p.sap_payment_doc ?? DASH}</td>
                            <td className="muted">{p.notes ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
