import { useEffect, useRef, useState } from 'react';
import {
  CategoryScale, Chart as ChartJS, Legend, LineController, LineElement,
  LinearScale, PointElement, Tooltip,
} from 'chart.js';
import { api } from '../lib/api';
import { CATEGORY_COLORS, ChartPanel } from './Chart';

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

/** DetailTable's pager, shared by the Vendor-360 tables (5 Aug 2026). */
function EntPager({
  total, page, pageSize, onPage, onPageSize,
}: {
  total: number; page: number; pageSize: number;
  onPage: (p: number) => void; onPageSize: (n: 50 | 100 | 200) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const nums: number[] = [];
  for (let i = 0; i < pages; i += 1) {
    if (i === 0 || i === pages - 1 || Math.abs(i - page) <= 2) nums.push(i);
  }
  return (
    <div className="dt-pager">
      <label className="dt-check">
        Rows per page
        <select
          className="ly-swap"
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value) as 50 | 100 | 200)}
        >
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={200}>200</option>
        </select>
      </label>
      <span className="dt-pages">
        <button className="dt-btn" disabled={page === 0} onClick={() => onPage(page - 1)}>‹ Prev</button>
        {nums.map((n2, idx) => (
          <span key={n2}>
            {idx > 0 && nums[idx - 1] !== n2 - 1 && <span className="muted">…</span>}
            <button
              className="dt-btn"
              aria-current={n2 === page ? 'page' : undefined}
              style={n2 === page ? { borderColor: 'var(--accent)', fontWeight: 700 } : {}}
              onClick={() => onPage(n2)}
            >
              {n2 + 1}
            </button>
          </span>
        ))}
        <button className="dt-btn" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next ›</button>
        <span className="muted">page {page + 1} of {formatNumber(pages)}</span>
      </span>
    </div>
  );
}

export function VendorsTab({ onDrill }: { onDrill: (token: string, label: string) => void }) {
  const [rows, setRows] = useState<VendorRow[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [openMaterial, setOpenMaterial] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Two table faces (ranking + vendors×months); the on-time/late chart sits
  // in its own panel below (user decision 5 Aug 2026).
  const [view, setView] = useState<'top' | 'pivot'>('top');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<50 | 100 | 200>(50);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // A new search or page size restarts from the first page.
  useEffect(() => { setPage(0); }, [debounced, pageSize]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<{ totalVendors: number; rows: VendorRow[] }>(
        `/api/v1/entity/vendors?limit=${pageSize}&offset=${page * pageSize}${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`,
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
  }, [debounced, page, pageSize]);

  return (
    <>
    <div className="panel">
      <div className="dt-toolbar">
        {(['top', 'pivot'] as const).map((v) => (
          <button key={v} className="dt-btn" aria-pressed={view === v}
            style={view === v ? { borderColor: 'var(--accent)', fontWeight: 600 } : {}}
            onClick={() => setView(v)}>
            {v === 'top' ? 'Top vendors' : 'Vendors × months'}
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
        <VendorPivot search={debounced} onOpenVendor={setOpen} onOpenMaterial={setOpenMaterial} />
      ) : loading ? (
        <div className="center-msg"><div className="spinner" />Loading vendors…</div>
      ) : (
        <>
        <div className="table-wrap dt-scroll">
          <table className="data dd-tbl">
            <thead>
              <tr>
                <th className="num">No</th>
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
              {rows.map((r, i) => (
                <tr
                  key={r.vendorCode}
                  className={`ent-row ${i % 2 ? '' : 're'}`}
                  onClick={() => setOpen(r.vendorCode)}
                >
                  <td className="num muted">{page * pageSize + i + 1}</td>
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
        {total > 0 && (
          <EntPager total={total} page={page} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} />
        )}
        </>
      )}
    </div>

    {/* On-time vs late in its own panel below (user decision 5 Aug 2026). */}
    <div className="panel" style={{ marginTop: '1rem' }}>
      <h3 className="pr-tbl-h">On-time vs late — GR vs PO delivery date, per vendor</h3>
      <VendorOtdBars onOpenVendor={setOpen} />
    </div>

    {open && <VendorModal code={open} onClose={() => setOpen(null)} onDrill={onDrill} />}
    {openMaterial && <MaterialModal code={openMaterial} onClose={() => setOpenMaterial(null)} onDrill={onDrill} />}
    </>
  );
}

// ─────────────────────────── vendors × materials × month pivot (G3.1)

function VendorPivot({
  search, onOpenVendor, onOpenMaterial,
}: {
  search: string;
  onOpenVendor: (code: string) => void;
  onOpenMaterial: (code: string) => void;
}) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<50 | 100 | 200>(50);
  const [expanded, setExpanded] = useState<Record<string, Record<string, any>[] | 'loading'>>({});

  useEffect(() => { setPage(0); }, [search, pageSize]);

  useEffect(() => {
    const q = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
    if (search) q.set('q', search);
    api.get<Record<string, any>>(`/api/v1/entity/vendor-pivot?${q.toString()}`)
      .then(setD)
      .catch(() => setD(null));
  }, [search, page, pageSize]);

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
        <table className="data dd-tbl">
          <thead>
            <tr>
              <th>Vendor / material (USD)</th>
              {months.map((m) => <th key={m} style={{ textAlign: 'right' }}>{m}</th>)}
              <th style={{ textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r: any, ri: number) => (
              <>
                <tr key={r.code} className={`ent-row ${ri % 2 ? '' : 're'}`}>
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
                      <td className="muted" style={{ paddingLeft: '2rem' }}>
                        <button
                          className="cu-link"
                          title="Open Material 360"
                          onClick={() => onOpenMaterial(String(m.code))}
                        >
                          {m.code}
                        </button>
                        {m.descr ? ` · ${m.descr}` : ''}
                      </td>
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
      {d.totalVendors > 0 && (
        <EntPager
          total={d.totalVendors} page={page} pageSize={pageSize}
          onPage={setPage} onPageSize={setPageSize}
        />
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

/**
 * Where this vendor's purchase orders are sent — the Coupa supplier master
 * (payload doc §1.8), matched on the supplier number, which holds the same
 * value as the SAP vendor code.
 *
 * Three states, all worth distinguishing: no Coupa record at all (the vendor
 * was never onboarded there), a record with no PO email (onboarded but the
 * address was never filled in — actionable), and an address. A blank field
 * would read as a bug in all three.
 */
function SupplierContact({ code, supplier }: { code: string; supplier: any }) {
  if (!supplier) {
    return (
      <p className="note vsup">
        <span className="bs sl">no Coupa supplier</span>{' '}
        <span className="muted">
          No supplier in Coupa carries the number <code>{code}</code>, so there is no PO email
          on file. Vendors are matched on the supplier number, which holds the SAP vendor code.
        </span>
      </p>
    );
  }
  const held = supplier.onHold === true;
  return (
    <p className="note vsup">
      <strong>📧 PO Email </strong>
      {supplier.poEmail
        ? <a href={`mailto:${supplier.poEmail}`}>{supplier.poEmail}</a>
        : <span className="bs sa">not set in Coupa</span>}
      {supplier.contactEmail && supplier.contactEmail !== supplier.poEmail && (
        <span className="muted">
          {' · '}contact <a href={`mailto:${supplier.contactEmail}`}>{supplier.contactEmail}</a>
        </span>
      )}
      {supplier.poMethod && <span className="muted">{' · '}sent by {supplier.poMethod}</span>}
      {supplier.status && (
        <span className="muted">
          {' · '}Coupa status <span className={`bs ${supplier.status === 'active' ? 'sd' : 'sl'}`}>{supplier.status}</span>
        </span>
      )}
      {held && <span className="bs spdel" style={{ marginLeft: '.3rem' }}>on hold</span>}
      {supplier.name && supplier.name !== undefined && (
        <span className="muted">{' · '}as {supplier.name} in Coupa</span>
      )}
    </p>
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
              <SupplierContact code={code} supplier={d.coupaSupplier} />

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


/** v1's mgt aging colour: > 14d red, > 7d amber, else teal (all bold). */
function mgtAg(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'num';
  return 'num ag ' + (Number(v) > 14 ? 'bd' : Number(v) > 7 ? 'wn' : 'ok');
}
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
      {/* v1's Analysis by Material Group charts, on top (5 Aug 2026). */}
      <div className="chart-grid">
        <ChartPanel chartId="items_by_category" onDrill={onDrill} />
        <ChartPanel chartId="e2e_by_category" onDrill={onDrill} />
      </div>

      <div className="panel" style={{ marginTop: '1rem' }}>
        <h3 className="pr-tbl-h">Summary by Material Category <span className="muted">— avg aging metrics (days)</span></h3>
        <div className="table-wrap">
          <table className="data dd-tbl">
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Items</th>
                <th className="num">Open</th>
                <th className="num">%Open</th>
                <th className="num">PRA avg</th>
                <th className="num">SRC avg</th>
                <th className="num">POA avg</th>
                <th className="num">DLT avg</th>
                <th className="num">E2E avg</th>
              </tr>
            </thead>
            <tbody>
              {d.categories.map((c: any, i: number) => (
                <tr
                  key={c.category}
                  className={`ent-row ${i % 2 ? '' : 're'}${category === c.category ? ' ent-row--sel' : ''}`}
                  title={`Click to filter the material list to ${c.category}`}
                  onClick={() => setCategory(category === c.category ? '' : c.category)}
                >
                  <td style={{ fontWeight: 700, color: CATEGORY_COLORS[c.category] ?? 'inherit' }}>{c.category}</td>
                  <td className="num">
                    {c.drillAll ? (
                      <button className="cu-link" onClick={(e) => { e.stopPropagation(); onDrill(c.drillAll, `${c.category} — all PR items`); }}>
                        {formatNumber(c.items)}
                      </button>
                    ) : formatNumber(c.items)}
                  </td>
                  <td className="num">
                    {c.drillOpen ? (
                      <button className="cu-link" style={{ color: 'var(--crit)', fontWeight: 700 }} onClick={(e) => { e.stopPropagation(); onDrill(c.drillOpen, `${c.category} — open items`); }}>
                        {formatNumber(c.open)}
                      </button>
                    ) : formatNumber(c.open)}
                  </td>
                  <td className="num">{c.pctOpen}%</td>
                  <td className={mgtAg(c.avgPra)}>{c.avgPra === null ? DASH : Number(c.avgPra).toFixed(1)}</td>
                  <td className={mgtAg(c.avgSrc)}>{c.avgSrc === null ? DASH : Number(c.avgSrc).toFixed(1)}</td>
                  <td className={mgtAg(c.avgPoa)}>{c.avgPoa === null ? DASH : Number(c.avgPoa).toFixed(1)}</td>
                  <td className={mgtAg(c.avgDlt)}>{c.avgDlt === null ? DASH : Number(c.avgDlt).toFixed(1)}</td>
                  <td className={mgtAg(c.avgE2e)}>{c.avgE2e === null ? DASH : Number(c.avgE2e).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">PR items per category (deleted excluded); stage averages over non-negative spans. Click a category to filter the material list; click a count to open its rows.</p>
      </div>

      <div className="panel">
        <div className="dt-toolbar">
          <h3 className="pr-tbl-h" style={{ margin: 0 }}>Material Explorer — click a material for vendors, areas &amp; price history{category ? ` · ${category}` : ''}</h3>
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
          <table className="data dd-tbl">
            <thead>
              <tr>
                <th>Material</th><th>Description</th><th>Mat Grp</th><th>Category</th>
                <th style={{ textAlign: 'right' }}>Vendors</th>
                <th style={{ textAlign: 'right' }}>Lines</th>
                <th style={{ textAlign: 'right' }}>Amount (M IDR)</th>
              </tr>
            </thead>
            <tbody>
              {d.materials.map((m: any, i: number) => (
                <tr
                  key={m.materialCode}
                  className={`ent-row ${i % 2 ? '' : 're'}`}
                  title="Click for vendors, areas & price history"
                  onClick={() => setOpen(m.materialCode)}
                >
                  <td style={{ fontWeight: 700, color: 'var(--blue)' }}>{m.materialCode}</td>
                  <td>{m.description}</td>
                  <td>{m.materialGroup ?? DASH}</td>
                  <td>{m.category ?? DASH}</td>
                  <td className="num">{m.soleSource ? <span title="Sole source">🔴 1</span> : formatNumber(m.vendors)}</td>
                  <td className="num">{formatNumber(m.lines)}</td>
                  <td className="num">{m.spendIdr === null ? DASH : (Number(m.spendIdr) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
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

      <div className="chart-grid" style={{ marginTop: '1rem' }}>
        <div className="panel">
          <h3 className="pr-tbl-h">Price Volatility — top 50 most erratic unit prices (CV%, IDR)</h3>
          <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead>
                <tr>
                  <th>Material</th><th>Description</th>
                  <th className="num">Volatility (CV%)</th>
                  <th className="num">Months</th>
                  <th className="num">Spend (M IDR)</th>
                </tr>
              </thead>
              <tbody>
                {(d.priceVolatility ?? []).length === 0 && (
                  <tr><td colSpan={5} className="muted">Needs ≥3 months of unit-price history per material.</td></tr>
                )}
                {(d.priceVolatility ?? []).map((v: any, i: number) => (
                  <tr
                    key={v.materialCode}
                    className={`ent-row ${i % 2 ? '' : 're'}`}
                    title="Open material popup"
                    onClick={() => setOpen(v.materialCode)}
                  >
                    <td style={{ fontWeight: 600, color: 'var(--blue)' }}>{v.materialCode}</td>
                    <td>{v.description}</td>
                    <td className="num" style={v.cvPct !== null && v.cvPct > 25 ? { color: 'var(--crit)', fontWeight: 700 } : { fontWeight: 700 }}>
                      {v.cvPct === null ? DASH : `${Number(v.cvPct).toFixed(1)}%`}
                    </td>
                    <td className="num">{v.months}</td>
                    <td className="num">{v.spendIdr === null ? DASH : (Number(v.spendIdr) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <h3 className="pr-tbl-h">Single-Source Risk — top 50 by spend · click for material popup</h3>
          <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead>
                <tr>
                  <th>Material</th><th>Description</th><th>Sole Vendor</th>
                  <th className="num">Lines</th>
                  <th className="num">Spend (M IDR)</th>
                </tr>
              </thead>
              <tbody>
                {(d.soleSource ?? []).length === 0 && (
                  <tr><td colSpan={5} className="muted">No single-source materials found.</td></tr>
                )}
                {(d.soleSource ?? []).map((x: any, i: number) => (
                  <tr
                    key={x.materialCode}
                    className={`ent-row ${i % 2 ? '' : 're'}`}
                    title="Open material popup"
                    onClick={() => setOpen(x.materialCode)}
                  >
                    <td style={{ fontWeight: 600, color: 'var(--blue)' }}>{x.materialCode}</td>
                    <td>{x.description}</td>
                    <td>{x.vendorName ?? DASH}</td>
                    <td className="num">{formatNumber(x.lines)}</td>
                    <td className="num">{x.spendIdr === null ? DASH : (Number(x.spendIdr) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

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
                <div className="ent-h" style={{ marginTop: 0 }}>
                  Unit price by month — top vendors (IDR{d.priceBasis?.baseUnit ? ` per ${d.priceBasis.baseUnit}` : ''})
                </div>
                <PriceTrend rows={d.priceByVendor ?? []} />
                <p className="note" style={{ marginBottom: 0 }}>
                  Showing top {Math.min(6, d.kpis.vendorCount)} of {d.kpis.vendorCount} vendors by amount.
                  Unit price = Spend ÷ Order Qty per PO line, monthly ratio of sums{d.priceBasis?.baseUnit ? `, quantities normalised to ${d.priceBasis.baseUnit}` : ''}.
                  Foreign-currency lines use their exact per-line IDR equivalent (FX at invoice/PO date);
                  unrated lines and units that cannot be converted to the dominant base are excluded
                  ({formatNumber(d.priceBasis?.chartedLines ?? 0)} of {formatNumber(d.kpis.lineCount)} lines charted).
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
        scales: { y: { title: { display: true, text: 'Unit price (IDR equivalent)' } } },
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
