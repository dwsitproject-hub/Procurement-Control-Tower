import { useEffect, useRef, useState } from 'react';
import {
  CategoryScale, Chart as ChartJS, Legend, LineController, LineElement,
  LinearScale, PointElement, Tooltip,
} from 'chart.js';
import { api } from '../lib/api';

ChartJS.register(CategoryScale, LineController, LineElement, LinearScale, PointElement, Tooltip, Legend);
import { DASH, FLAG_META, formatDate, formatMoney, formatNumber, STATUS_PILL } from '../lib/format';

/**
 * W3 — Vendor 360 and Material Group views (v1's pg-v360 / pg-mg / mx-modal).
 *
 * Every USD figure follows the strict rule: null renders as an em dash with the
 * unconverted state visible, never a partial sum presented as complete.
 */

// ────────────────────────────────────────────────────────────── Vendors tab

interface VendorRow {
  vendorCode: string;
  vendorName: string;
  poCount: number;
  lineCount: number;
  spendUsd: number | null;
  spendConverted: boolean;
  materials: number;
  areas: number;
  otdPct: number | null;
  avgDaysLate: number | null;
  openExposureUsd: number | null;
}

export function VendorsTab({ onDrill }: { onDrill: (token: string, label: string) => void }) {
  const [rows, setRows] = useState<VendorRow[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // v1's Vendor 360 has three faces: ranking, the vendors×materials×month
  // pivot, and the all-vendors on-time/late chart (G3.1/G3.2).
  const [view, setView] = useState<'top' | 'pivot' | 'otd'>('top');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<{ totalVendors: number; rows: VendorRow[] }>(
        `/api/v1/entity/vendors?limit=50${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`,
      )
      .then((d) => {
        if (cancelled) return;
        setRows(d.rows);
        setTotal(d.totalVendors);
      })
      .catch(() => setRows([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  return (
    <div className="panel">
      <div className="dt-toolbar">
        {(['top', 'pivot', 'otd'] as const).map((v) => (
          <button key={v} className="dt-btn" aria-pressed={view === v}
            style={view === v ? { borderColor: 'var(--accent)', fontWeight: 600 } : {}}
            onClick={() => setView(v)}>
            {v === 'top' ? 'Top vendors' : v === 'pivot' ? 'Vendors × months' : 'On-time vs late'}
          </button>
        ))}
        <input
          className="dt-search"
          type="search"
          placeholder="Search vendor name or code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search vendors"
        />
        <span className="count">
          {formatNumber(total)} vendors · STO excluded
        </span>
      </div>

      {view === 'pivot' ? (
        <VendorPivot search={debounced} onOpenVendor={setOpen} />
      ) : view === 'otd' ? (
        <VendorOtdBars onOpenVendor={setOpen} />
      ) : loading ? (
        <div className="center-msg"><div className="spinner" />Loading vendors…</div>
      ) : (
        <div className="table-wrap dt-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Vendor</th><th>Code</th>
                <th style={{ textAlign: 'right' }}>POs</th>
                <th style={{ textAlign: 'right' }}>Lines</th>
                <th style={{ textAlign: 'right' }}>Spend USD</th>
                <th style={{ textAlign: 'right' }}>Materials</th>
                <th style={{ textAlign: 'right' }}>Areas</th>
                <th style={{ textAlign: 'right' }}>OTD %</th>
                <th style={{ textAlign: 'right' }}>Avg late (d)</th>
                <th style={{ textAlign: 'right' }}>Open USD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.vendorCode} className="ent-row" onClick={() => setOpen(r.vendorCode)}>
                  <td>{r.vendorName}</td>
                  <td className="muted">{r.vendorCode}</td>
                  <td className="num">{formatNumber(r.poCount)}</td>
                  <td className="num">{formatNumber(r.lineCount)}</td>
                  <td className="num">
                    {r.spendConverted ? formatMoney(r.spendUsd, 'USD') : `${DASH} (unrated ccy)`}
                  </td>
                  <td className="num">{formatNumber(r.materials)}</td>
                  <td className="num">{formatNumber(r.areas)}</td>
                  <td className="num">{r.otdPct === null ? DASH : `${r.otdPct}%`}</td>
                  <td className="num">{r.avgDaysLate === null ? DASH : r.avgDaysLate}</td>
                  <td className="num">{formatMoney(r.openExposureUsd, 'USD')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <VendorModal code={open} onClose={() => setOpen(null)} onDrill={onDrill} />}
    </div>
  );
}

// ─────────────────────────── vendors × materials × month pivot (G3.1)

function VendorPivot({
  search, onOpenVendor,
}: { search: string; onOpenVendor: (code: string) => void }) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [limit, setLimit] = useState(40);
  const [expanded, setExpanded] = useState<Record<string, Record<string, any>[] | 'loading'>>({});

  useEffect(() => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (search) q.set('q', search);
    api.get<Record<string, any>>(`/api/v1/entity/vendor-pivot?${q.toString()}`)
      .then(setD)
      .catch(() => setD(null));
  }, [search, limit]);

  const toggle = (code: string) => {
    if (expanded[code]) {
      setExpanded((c) => {
        const n = { ...c };
        delete n[code];
        return n;
      });
      return;
    }
    setExpanded((c) => ({ ...c, [code]: 'loading' }));
    api.get<{ materials: Record<string, any>[] }>(`/api/v1/entity/vendor-pivot/${encodeURIComponent(code)}`)
      .then((r) => setExpanded((c) => ({ ...c, [code]: r.materials })))
      .catch(() => setExpanded((c) => ({ ...c, [code]: [] })));
  };

  if (!d) return <div className="center-msg"><div className="spinner" />Building pivot…</div>;
  const months: string[] = d.months;
  const cell = (v: number | null | undefined) =>
    v === null || v === undefined ? '' : v >= 1e6 ? `${(v / 1e6).toFixed(1)} M` : formatNumber(Math.round(v));

  return (
    <>
      <p className="note" style={{ marginTop: 0 }}>{d.note}</p>
      <div className="table-wrap dt-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Vendor / material (USD)</th>
              {months.map((m) => <th key={m} style={{ textAlign: 'right' }}>{m}</th>)}
              <th style={{ textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r: any) => (
              <>
                <tr key={r.code} className="ent-row">
                  <td>
                    <button className="cu-link" onClick={() => toggle(r.code)} title="Expand materials">
                      {expanded[r.code] ? '▾' : '▸'}
                    </button>{' '}
                    <button className="cu-link" onClick={() => onOpenVendor(r.code)} title="Open vendor popup">
                      {r.name ?? r.code}
                    </button>
                    {r.anyUnrated && <span className="muted" title="Some lines have unrated currencies"> ⚠</span>}
                  </td>
                  {months.map((m) => <td key={m} className="num">{cell(r.byMonth[m])}</td>)}
                  <td className="num"><strong>{cell(r.total)}</strong></td>
                </tr>
                {expanded[r.code] === 'loading' && (
                  <tr><td colSpan={months.length + 2} className="muted">Loading materials…</td></tr>
                )}
                {Array.isArray(expanded[r.code]) &&
                  (expanded[r.code] as Record<string, any>[]).map((m: any) => (
                    <tr key={`${r.code}|${m.code}`}>
                      <td className="muted" style={{ paddingLeft: '2rem' }}>{m.code} {m.descr ? `· ${m.descr}` : ''}</td>
                      {months.map((mk) => <td key={mk} className="num muted">{cell(m.byMonth[mk])}</td>)}
                      <td className="num muted">{cell(m.total)}</td>
                    </tr>
                  ))}
              </>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td><strong>Grand total ({formatNumber(d.totalVendors)} vendors)</strong></td>
              <td colSpan={months.length} />
              <td className="num"><strong>{d.grandTotalUsd === null ? `${DASH} (unrated ccy)` : cell(d.grandTotalUsd)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>
      {d.rows.length < d.totalVendors && (
        <button className="btn secondary" style={{ marginTop: '.6rem' }} onClick={() => setLimit((l) => l + 40)}>
          Load more vendors ({formatNumber(d.rows.length)} of {formatNumber(d.totalVendors)})
        </button>
      )}
    </>
  );
}

// ───────────────────────────── all-vendors on-time vs late (G3.2)

function VendorOtdBars({ onOpenVendor }: { onOpenVendor: (code: string) => void }) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  useEffect(() => {
    api.get<Record<string, any>>('/api/v1/entity/vendor-otd?limit=60').then(setD).catch(() => setD(null));
  }, []);
  if (!d) return <div className="center-msg"><div className="spinner" />Loading…</div>;
  return (
    <>
      <p className="note" style={{ marginTop: 0 }}>{d.note}</p>
      {d.vendors.map((v: any) => {
        const total = v.onTime + v.late;
        return (
          <div key={v.vendorCode} className="ent-bar-row">
            <span className="ent-bar-label" style={{ flexBasis: 220 }}>
              <button className="cu-link" onClick={() => onOpenVendor(v.vendorCode)}>{v.vendorName ?? v.vendorCode}</button>
            </span>
            <span className="ent-bar-track otd-track">
              <span className="otd-on" style={{ width: `${(v.onTime / total) * 100}%` }} title={`${v.onTime} on-time`} />
              <span className="otd-late" style={{ width: `${(v.late / total) * 100}%` }} title={`${v.late} late`} />
            </span>
            <span className="ent-bar-val">{formatNumber(v.onTime)} / {formatNumber(v.late)} late</span>
          </div>
        );
      })}
    </>
  );
}

export function VendorModal({
  code, onClose, onDrill,
}: { code: string; onClose: () => void; onDrill: (t: string, l: string) => void }) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<Record<string, any>>(`/api/v1/entity/vendor/${encodeURIComponent(code)}`)
      .then(setD)
      .catch((e: Error) => setErr(e.message));
  }, [code]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>🏢 {d?.vendorName ?? code} <span className="muted">({code})</span></h3>
          <span className="spacer" />
          {d?.drill?.allLines && (
            <button className="dt-btn" onClick={() => onDrill(d.drill.allLines, `Vendor ${code} — all PO lines`)}>
              Open all lines
            </button>
          )}
          <button className="btn secondary" style={{ width: 'auto' }} onClick={onClose}>Close</button>
        </header>
        <div className="body">
          {err && <p className="err">{err}</p>}
          {!d && !err && <div className="center-msg"><div className="spinner" />Loading…</div>}
          {d && (
            <>
              {/* v1's 11 Vendor-360 bio KPIs */}
              <div className="ent-kpis">
                <Bio label="Total Spending" value={d.bio.spendUsd === null ? `${DASH} (unrated ccy present)` : formatMoney(d.bio.spendUsd, 'USD')} />
                <Bio label="# POs" value={formatNumber(d.bio.poCount)} />
                <Bio label="Materials Supplied" value={formatNumber(d.bio.materialsSupplied)} />
                <Bio label="Areas Served" value={formatNumber(d.bio.areasServed)} />
                <Bio label="On-Time % (≤ deliv+7d)" value={d.bio.otdPct === null ? DASH : `${d.bio.otdPct}%`} title={d.bio.otdCaveat} />
                <Bio label="Avg Days Late" value={d.bio.avgDaysLate === null ? DASH : String(d.bio.avgDaysLate)} />
                <Bio label="Open Exposure" value={formatMoney(d.bio.openExposureUsd, 'USD')} />
                <Bio label="Delivered, Not Invoiced" value={formatMoney(d.bio.deliveredNotInvoicedUsd, 'USD')} />
                <Bio label="GR Reversal Rate" value={d.bio.reversalRatePct === null ? DASH : `${d.bio.reversalRatePct}%`} />
                <Bio label="Active" value={`${formatDate(d.bio.firstSeen)} → ${formatDate(d.bio.lastSeen)}`} />
                <Bio label="On-Time vs Requested" value={DASH} title={d.bio.onTimeVsRequestedReason} />
              </div>

              <p className="note" style={{ margin: '.4rem 0 .8rem' }}>
                Currency composition:{' '}
                {d.bio.spendByCurrency.map((c: any) => (
                  <span key={c.currency} className="ent-ccy">
                    {c.currency} {formatMoney(c.amount)}
                    {c.rated ? '' : ' (unrated)'}
                  </span>
                ))}
              </p>

              <TwoCol
                left={<MiniBars title="Spend by month (USD)" rows={d.spendByMonth.map((m: any) => ({ label: m.monthKey, value: m.usd, count: m.lines }))} money />}
                right={<MiniBars title="Supply to area / plant (USD)" rows={d.byArea.map((a: any) => ({ label: a.plantName, value: a.usd, count: a.lines }))} money />}
              />

              {/* v1's v3 popup pair: area-share donut + delivery-aging histogram (G3.3) */}
              <TwoCol
                left={<AreaDonut title="Share of spending by area" rows={d.byArea} />}
                right={
                  <MiniBars
                    title="Delivery aging (GR vs PO delivery date)"
                    rows={(d.deliveryAging ?? []).map((b: any) => ({ label: b.bucket, value: b.count, count: b.count }))}
                  />
                }
              />

              <h4 className="ent-h">Materials supplied <span className="muted">(top {d.materials.length} of cap {d.caps.materials})</span></h4>
              <SimpleTable
                head={['Material', 'Description', 'Lines', 'Qty', 'Spend USD', 'Last PO']}
                rows={d.materials.map((m: any) => [
                  m.materialCode ?? '(service)', m.description, formatNumber(m.lines),
                  formatNumber(m.qty, 1), formatMoney(m.usd, 'USD'), formatDate(m.lastPo),
                ])}
              />

              <h4 className="ent-h">
                PO history <span className="muted">(newest {d.poHistory.length}, cap {d.caps.poHistory})</span>
                {d.poTotals && (
                  <span className="muted">
                    {' '}· Σ all {formatNumber(d.poTotals.lines)} lines / {formatNumber(d.poTotals.pos)} POs:{' '}
                    {d.poTotals.valueIdr !== null && `${(d.poTotals.valueIdr / 1e9).toFixed(2)} B IDR`}
                    {d.poTotals.valueUsd !== null
                      ? ` · ${formatMoney(d.poTotals.valueUsd, 'USD')}`
                      : ' · USD total unavailable (unrated ccy)'}
                  </span>
                )}
              </h4>
              <PoHistoryTable rows={d.poHistory} />

              <h4 className="ent-h">GR history <span className="muted">(newest {d.grHistory.length}, cap {d.caps.grHistory})</span></h4>
              <SimpleTable
                head={['Mat. doc', 'PO', 'Item', 'Mvt', 'Class', 'Posted', 'Signed qty', 'Material']}
                rows={d.grHistory.map((g: any) => [
                  g.materialDoc, g.poNo, String(g.poItem), g.movementType, g.postingClass,
                  formatDate(g.postingDate), formatNumber(g.signedQty, 3), g.materialDesc ?? DASH,
                ])}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────── Materials tab

export function MaterialsTab({ onDrill }: { onDrill: (t: string, l: string) => void }) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [category, setCategory] = useState<string>('');
  const [group, setGroup] = useState<string>('');
  const [limit, setLimit] = useState(150);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (category) q.set('category', category);
    if (group) q.set('materialGroup', group);
    if (debounced) q.set('q', debounced);
    api.get<Record<string, any>>(`/api/v1/entity/material-groups?${q.toString()}`)
      .then(setD)
      .catch(() => setD(null));
  }, [category, group, debounced, limit]);

  if (!d) return <div className="center-msg"><div className="spinner" />Loading material groups…</div>;

  return (
    <>
      <div className="panel">
        <h2>Categories</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ textAlign: 'right' }}>Lines</th>
                <th style={{ textAlign: 'right' }}>POs</th>
                <th style={{ textAlign: 'right' }}>Spend USD</th>
                <th style={{ textAlign: 'right' }}>Sourcing med (d)</th>
                <th style={{ textAlign: 'right' }}>PO appr med (d)</th>
                <th style={{ textAlign: 'right' }}>Delivery med (d)</th>
                <th style={{ textAlign: 'right' }}>Open lines</th>
              </tr>
            </thead>
            <tbody>
              {d.categories.map((c: any) => (
                <tr
                  key={c.category}
                  className={`ent-row${category === c.category ? ' ent-row--sel' : ''}`}
                  onClick={() => setCategory(category === c.category ? '' : c.category)}
                >
                  <td>{c.category}</td>
                  <td className="num">
                    {c.drillAll ? (
                      <button className="cu-link" onClick={(e) => { e.stopPropagation(); onDrill(c.drillAll, `${c.category} — all PO lines`); }}>
                        {formatNumber(c.lines)}
                      </button>
                    ) : formatNumber(c.lines)}
                  </td>
                  <td className="num">{formatNumber(c.pos)}</td>
                  <td className="num">{formatMoney(c.spendUsd, 'USD')}</td>
                  <td className="num">{c.medianSourcingDays === null ? DASH : Math.round(c.medianSourcingDays)}</td>
                  <td className="num">{c.medianPoApprovalDays === null || c.medianPoApprovalDays === undefined ? DASH : Math.round(c.medianPoApprovalDays)}</td>
                  <td className="num">{c.medianDeliveryDays === null ? DASH : Math.round(c.medianDeliveryDays)}</td>
                  <td className="num">
                    {c.drillOpen ? (
                      <button className="cu-link" onClick={(e) => { e.stopPropagation(); onDrill(c.drillOpen, `${c.category} — open lines`); }}>
                        {formatNumber(c.openLines)}
                      </button>
                    ) : formatNumber(c.openLines)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">STO and deleted lines excluded. Click a category to filter the material list; click a count to open its rows.</p>
      </div>

      <div className="panel">
        <div className="dt-toolbar">
          <h2 style={{ margin: 0 }}>Materials{category ? ` — ${category}` : ''}</h2>
          <select
            className="dt-search"
            style={{ flex: 'none', width: 160 }}
            value={group}
            onChange={(e) => { setGroup(e.target.value); setLimit(150); }}
            aria-label="Material group"
          >
            <option value="">All material groups</option>
            {(d.materialGroups ?? []).map((g: string) => <option key={g} value={g}>{g}</option>)}
          </select>
          <input
            className="dt-search"
            type="search"
            placeholder="Search material code or description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search materials"
          />
          <span className="count">{formatNumber(d.totalMaterials)} materials match</span>
        </div>
        <div className="table-wrap dt-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Material</th><th>Description</th><th>Group</th>
                <th style={{ textAlign: 'right' }}>Lines</th>
                <th style={{ textAlign: 'right' }}>Vendors</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Spend USD</th>
                <th>Sole source</th>
              </tr>
            </thead>
            <tbody>
              {d.materials.map((m: any) => (
                <tr key={m.materialCode} className="ent-row" onClick={() => setOpen(m.materialCode)}>
                  <td>{m.materialCode}</td>
                  <td className="muted">{m.description}</td>
                  <td>{m.materialGroup ?? DASH}</td>
                  <td className="num">{formatNumber(m.lines)}</td>
                  <td className="num">{formatNumber(m.vendors)}</td>
                  <td className="num">{formatNumber(m.qty, 1)}</td>
                  <td className="num">{formatMoney(m.spendUsd, 'USD')}</td>
                  <td>{m.soleSource ? '🔴 yes' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">Top {d.materials.length} of {formatNumber(d.totalMaterials)} by spend.</p>
        {d.materials.length < d.totalMaterials && (
          <button className="btn secondary" onClick={() => setLimit((l) => l + 150)}>
            Load more materials
          </button>
        )}
      </div>

      <TwoCol
        left={
          <div className="panel">
            <h2>Volume leaders</h2>
            <SimpleTable
              head={['Material', 'Description', 'Qty', 'Unit']}
              rows={d.volumeLeaders.map((x: any) => [x.materialCode, x.description, formatNumber(x.qty, 1), x.unit ?? DASH])}
            />
          </div>
        }
        right={
          <div className="panel">
            <h2>Sole-source materials <span className="muted">({d.soleSource.length} of cap {d.caps.soleSource})</span></h2>
            <SimpleTable
              head={['Material', 'Description', 'Only vendor', 'Lines', 'Spend USD']}
              rows={d.soleSource.map((x: any) => [x.materialCode, x.description, x.vendorName ?? DASH, formatNumber(x.lines), formatMoney(x.spendUsd, 'USD')])}
            />
          </div>
        }
      />

      {open && <MaterialModal code={open} onClose={() => setOpen(null)} onDrill={onDrill} />}
    </>
  );
}

export function MaterialModal({
  code, onClose, onDrill,
}: { code: string; onClose: () => void; onDrill: (t: string, l: string) => void }) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<Record<string, any>>(`/api/v1/entity/material/${encodeURIComponent(code)}`)
      .then(setD)
      .catch((e: Error) => setErr(e.message));
  }, [code]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>📦 {code} <span className="muted">{d?.description ?? ''}</span></h3>
          <span className="spacer" />
          {d?.drill?.allLines && (
            <button className="dt-btn" onClick={() => onDrill(d.drill.allLines, `Material ${code} — all PO lines`)}>
              Open all lines
            </button>
          )}
          <button className="btn secondary" style={{ width: 'auto' }} onClick={onClose}>Close</button>
        </header>
        <div className="body">
          {err && <p className="err">{err}</p>}
          {!d && !err && <div className="center-msg"><div className="spinner" />Loading…</div>}
          {d && (
            <>
              <div className="ent-kpis">
                <Bio label="PO lines" value={formatNumber(d.kpis.lineCount)} />
                <Bio label="Vendors" value={`${formatNumber(d.kpis.vendorCount)}${d.kpis.soleSource ? ' 🔴 sole source' : ''}`} />
                <Bio label="Total qty" value={formatNumber(d.kpis.totalQty, 1)} />
                <Bio label="Spend USD" value={formatMoney(d.kpis.spendUsd, 'USD')} />
                <Bio label="Avg unit price" value={d.kpis.avgUnitPrice === null ? DASH : formatNumber(d.kpis.avgUnitPrice, 2)} title={d.kpis.avgUnitPriceNote} />
                <Bio label="Group / category" value={`${d.materialGroup ?? DASH} · ${d.category ?? DASH}`} />
              </div>

              {/* v1's material-360: per-vendor unit-price trend + two share donuts. */}
              <div className="ent-mini" style={{ marginTop: '.6rem' }}>
                <div className="ent-h" style={{ marginTop: 0 }}>Unit price by month — top vendors (IDR lines)</div>
                <PriceTrend rows={d.priceByVendor ?? []} />
                <p className="note" style={{ marginBottom: 0 }}>
                  Showing top {Math.min(6, d.kpis.vendorCount)} of {d.kpis.vendorCount} vendors by amount.
                  Unit price = Net Price ÷ Price Unit (i.e. Spend ÷ Order Qty), deduped per PO line, averaged per month.
                </p>
              </div>
              <TwoCol
                left={<AreaDonut title="Suppliers / Vendors — share of PO amount (USD)" rows={d.vendorShare.map((x: any) => ({ plant: x.vendorCode, plantName: `${x.vendorCode ?? ''} ${x.vendorName ?? ''}`.trim() || '(plant)', usd: x.usd }))} />}
                right={<AreaDonut title="Areas purchased — share of PO amount (USD)" rows={d.areaShare ?? []} />}
              />

              <h4 className="ent-h">Purchase Orders for this material <span className="muted">· {formatNumber(d.kpis.lineCount)} PO lines (newest {d.poHistory.length}, cap {d.caps.poHistory})</span></h4>
              <PoHistoryTable rows={d.poHistory} vendor />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────── small shared bits

/** CSS conic-gradient donut — v1's area-share chart, no chart library needed. */
function AreaDonut({ title, rows }: { title: string; rows: Record<string, any>[] }) {
  const DONUT = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948'];
  const withUsd = rows.filter((r) => r.usd !== null && Number(r.usd) > 0);
  const total = withUsd.reduce((a, r) => a + Number(r.usd), 0);
  if (total <= 0) return <div className="ent-mini"><div className="ent-h" style={{ marginTop: 0 }}>{title}</div><p className="note">No rated USD spend to chart.</p></div>;
  let acc = 0;
  const stops = withUsd.map((r, i) => {
    const from = (acc / total) * 360;
    acc += Number(r.usd);
    const to = (acc / total) * 360;
    return `${DONUT[i % DONUT.length]} ${from.toFixed(1)}deg ${to.toFixed(1)}deg`;
  });
  return (
    <div className="ent-mini">
      <div className="ent-h" style={{ marginTop: 0 }}>{title}</div>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
        <div className="donut" style={{ background: `conic-gradient(${stops.join(', ')})` }} aria-hidden="true" />
        <div>
          {withUsd.map((r, i) => (
            <div key={r.plant ?? i} style={{ fontSize: '.78rem' }}>
              <span style={{ color: DONUT[i % DONUT.length] }}>■</span>{' '}
              {r.plantName ?? r.plant} — {((Number(r.usd) / total) * 100).toFixed(1)}%
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** v1's material-360 unit-price trend: one line per top-6 vendor (IDR). */
function PriceTrend({ rows }: { rows: Record<string, any>[] }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart = useRef<ChartJS | null>(null);
  useEffect(() => {
    if (!canvas.current || rows.length === 0) return;
    const months = [...new Set(rows.map((r) => String(r.monthKey)))].sort();
    const vendors = [...new Set(rows.map((r) => String(r.vendorCode)))];
    const COLORS = ['#2E75B6', '#0D9488', '#ED7D31', '#7C3AED', '#e11d48', '#ca8a04'];
    chart.current?.destroy();
    chart.current = new ChartJS(canvas.current, {
      type: 'line',
      data: {
        labels: months,
        datasets: vendors.map((vc, i) => {
          const name = rows.find((r) => r.vendorCode === vc)?.vendorName ?? vc;
          return {
            label: `${vc} ${String(name).slice(0, 26)}`,
            data: months.map((m) => {
              const hit = rows.find((r) => r.vendorCode === vc && r.monthKey === m);
              return hit ? Number(hit.unitPrice) : null;
            }),
            borderColor: COLORS[i % COLORS.length],
            backgroundColor: COLORS[i % COLORS.length],
            spanGaps: true,
            tension: 0.3,
            pointRadius: 3,
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 9 } } },
        },
        scales: { y: { title: { display: true, text: 'Unit price (IDR)' } } },
      },
    }) as unknown as ChartJS;
    return () => { chart.current?.destroy(); chart.current = null; };
  }, [rows]);
  if (rows.length === 0) return <p className="note">No IDR unit-price history to chart.</p>;
  return <div style={{ height: 240 }}><canvas ref={canvas} /></div>;
}

function Bio({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="ent-bio" title={title}>
      <div className="v">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

function TwoCol({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return <div className="ent-two">{left}{right}</div>;
}

function MiniBars({
  title, rows, money = false,
}: { title: string; rows: { label: string; value: number | null; count: number }[]; money?: boolean }) {
  const max = Math.max(...rows.map((r) => r.value ?? 0), 1);
  return (
    <div className="ent-mini">
      <h4 className="ent-h">{title}</h4>
      {rows.length === 0 && <p className="note">No data</p>}
      {rows.map((r2) => (
        <div key={r2.label} className="ent-bar-row" title={`${r2.count} lines`}>
          <span className="ent-bar-label">{r2.label}</span>
          <span className="ent-bar-track">
            <span className="ent-bar" style={{ width: `${((r2.value ?? 0) / max) * 100}%` }} />
          </span>
          <span className="ent-bar-val">{money ? formatMoney(r2.value, 'USD') : formatNumber(r2.value, 2)}</span>
        </div>
      ))}
    </div>
  );
}

function SimpleTable({ head, rows }: { head: string[]; rows: (string | null)[][] }) {
  return (
    <div className="table-wrap" style={{ maxHeight: '300px', overflow: 'auto' }}>
      <table className="data">
        <thead><tr>{head.map((h2) => <th key={h2}>{h2}</th>)}</tr></thead>
        <tbody>
          {rows.map((r2, i) => (
            <tr key={i}>{r2.map((c, j) => <td key={j}>{c ?? DASH}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PoHistoryTable({ rows, vendor = false }: { rows: Record<string, any>[]; vendor?: boolean }) {
  return (
    <div className="table-wrap" style={{ maxHeight: '340px', overflow: 'auto' }}>
      <table className="data dd-tbl">
        <thead>
          <tr>
            <th /><th>PO</th><th>Item</th><th>Date</th>
            {vendor && <th>Vendor</th>}
            <th style={{ textAlign: 'right' }}>Qty</th><th>Unit</th>
            <th style={{ textAlign: 'right' }}>Unit price</th>
            <th style={{ textAlign: 'right' }}>Price unit</th>
            <th>Ccy</th>
            <th style={{ textAlign: 'right' }}>Value</th>
            <th style={{ textAlign: 'right' }}>Value USD</th>
            <th>Status</th><th>GR date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r2, i) => (
            <tr key={i}>
              <td>
                {((r2.flags as string[]) ?? []).map((f) => {
                  const m = FLAG_META[f];
                  return m ? <span key={f} className="flag" title={m.label}>{m.icon}</span> : null;
                })}
              </td>
              <td>{r2.poNo}</td>
              <td className="num">{r2.poItem}</td>
              <td>{formatDate(r2.documentDate)}</td>
              {vendor && <td className="muted">{r2.vendorName ?? DASH}</td>}
              <td className="num">{formatNumber(r2.orderQty, 2)}</td>
              <td>{r2.orderUnit ?? DASH}</td>
              <td className="num">{(r2.flags as string[])?.includes('sto') ? `${DASH} (STO)` : formatNumber(r2.unitPrice, 2)}</td>
              <td className="num">{r2.priceUnit ?? DASH}</td>
              <td>{r2.currencyCode}</td>
              <td className="num">{formatMoney(r2.netOrderValue)}</td>
              <td className="num">{formatMoney(r2.netOrderValueUsd, 'USD')}</td>
              <td><span className={'bs ' + (STATUS_PILL[String(r2.status)] ?? 'sl')}>{r2.status}</span></td>
              <td>{formatDate(r2.receiptDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
