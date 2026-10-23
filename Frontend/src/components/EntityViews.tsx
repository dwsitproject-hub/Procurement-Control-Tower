import { useEffect, useRef, useState } from 'react';
import { ScrollFrame } from './ScrollFrame';
import { SortButton, ToolTable, type SortState, type ToolTableColumn } from './TableTools';
import {
  CategoryScale, Chart as ChartJS, Legend, LineController, LineElement,
  LinearScale, PointElement, Tooltip,
} from 'chart.js';
import { api } from '../lib/api';
import { CATEGORY_COLORS, ChartPanel } from './Chart';
import { FilterDropdown } from './FilterDropdown';

ChartJS.register(CategoryScale, LineController, LineElement, LinearScale, PointElement, Tooltip, Legend);
import { DASH, FLAG_META, formatCurrency, formatDate, formatMoney, formatNumber, STATUS_PILL } from '../lib/format';
import { Lbl } from '../lib/labels';

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
  /** Coupa supplier master, matched on the supplier number (payload doc §1.8). */
  poEmail: string | null;
  /** Distinguishes "no Coupa record" from "record with no address". */
  inCoupa: boolean;
  poCount: number;
  lineCount: number;
  spendUsd: number | null;
  /** Rupiah equivalent, complete even where the USD total is not. */
  spendIdr: number | null;
  spendConverted: boolean;
  materials: number;
  areas: number;
  otdPct: number | null;
  avgDaysLate: number | null;
  openExposureUsd: number | null;
  openExposureIdr: number | null;
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

export function VendorsTab({ onDrill, filterQuery = '', currency = 'USD' }: {
  onDrill: (token: string, label: string) => void;
  /**
   * The filter bar (7 Oct 2026). Both tables ignored it until the Year filter
   * became the default, when Vendor 360 would have been the one page still
   * showing every year under a bar that said otherwise.
   */
  filterQuery?: string;
  /** Topbar display currency — every money cell below reads it. */
  currency?: 'USD' | 'IDR';
}) {
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
  /**
   * Header sort (7 Oct 2026), done on the SERVER: the table is paged, and
   * sorting the page on screen would rank 50 of the vendors, not all of them.
   * null is the default ranking, spend descending.
   */
  const [sort, setSort] = useState<SortState>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // A new search, page size, sort or filter restarts from the first page.
  useEffect(() => { setPage(0); }, [debounced, pageSize, sort, filterQuery]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<{ totalVendors: number; rows: VendorRow[] }>(
        `/api/v1/entity/vendors?limit=${pageSize}&offset=${page * pageSize}${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`
          + `${sort ? `&sort=${sort.key}&dir=${sort.dir}` : ''}${filterQuery ? `&${filterQuery}` : ''}`,
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
  }, [debounced, page, pageSize, sort, filterQuery]);

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
        <VendorPivot search={debounced} filterQuery={filterQuery} onOpenVendor={setOpen} onOpenMaterial={setOpenMaterial} />
      ) : loading ? (
        <div className="center-msg"><div className="spinner" />Loading vendors…</div>
      ) : (
        <>
        <ScrollFrame className="table-wrap dt-scroll">
          <table className="data dd-tbl">
            <thead>
              <tr>
                <th className="num">No</th>
                {/* Every header sorts, both ways (7 Oct 2026). The keys are the
                    server's whitelist (entity.ts VENDOR_SORT). */}
                {([
                  ['vendorName', 'Vendor', false], ['vendorCode', 'Code', false], ['poEmail', 'PO Email', false],
                  ['poCount', 'POs', true], ['lineCount', 'Lines', true], ['spendUsd', 'Spend USD', true],
                  ['materials', 'Materials', true], ['areas', 'Areas', true], ['otdPct', 'OTD %', true],
                  ['avgDaysLate', 'Avg late (d)', true], ['openExposureUsd', 'Open USD', true],
                ] as const).map(([key, label, right]) => (
                  <th key={key} style={right ? { textAlign: 'right' } : undefined}>
                    <SortButton label={label} colKey={key} sort={sort} onSort={setSort} />
                  </th>
                ))}
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
                  <td className="ent-email"><PoEmailCell email={r.poEmail} inCoupa={r.inCoupa} /></td>
                  <td className="num">{formatNumber(r.poCount)}</td>
                  <td className="num">{formatNumber(r.lineCount)}</td>
                  <td className="num">
                    {/* The unrated-currency caveat is a USD problem only: the
                        rupiah total needs no rate, so IDR always has a figure. */}
                    {currency === 'IDR' || r.spendConverted
                      ? formatCurrency(r.spendUsd, r.spendIdr, currency)
                      : `${DASH} (unrated ccy)`}
                  </td>
                  <td className="num">{formatNumber(r.materials)}</td>
                  <td className="num">{formatNumber(r.areas)}</td>
                  <td className="num">{r.otdPct === null ? DASH : `${r.otdPct}%`}</td>
                  <td className="num">{r.avgDaysLate === null ? DASH : r.avgDaysLate}</td>
                  <td className="num">{formatCurrency(r.openExposureUsd, r.openExposureIdr, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollFrame>
        {total > 0 && (
          <EntPager total={total} page={page} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} />
        )}
        </>
      )}
    </div>

    {/* On-time vs late in its own panel below (user decision 5 Aug 2026). */}
    <div className="panel" style={{ marginTop: '1rem' }}>
      <h3 className="pr-tbl-h"><Lbl>On-time vs late — GR vs PO delivery date, per vendor</Lbl></h3>
      <VendorOtdBars onOpenVendor={setOpen} />
    </div>

    {open && <VendorModal code={open} onClose={() => setOpen(null)} onDrill={onDrill} currency={currency} />}
    {openMaterial && <MaterialModal code={openMaterial} onClose={() => setOpenMaterial(null)} onDrill={onDrill} currency={currency} />}
    </>
  );
}

// ─────────────────────────── vendors × materials × month pivot (G3.1)

function VendorPivot({
  search, filterQuery, onOpenVendor, onOpenMaterial,
}: {
  search: string;
  filterQuery: string;
  onOpenVendor: (code: string) => void;
  onOpenMaterial: (code: string) => void;
}) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<50 | 100 | 200>(50);
  const [expanded, setExpanded] = useState<Record<string, Record<string, any>[] | 'loading'>>({});
  /**
   * Header sort (7 Oct 2026): vendor name, any month, or the total. Ranked on
   * the server before paging, so sorting by a month ranks every vendor by it.
   * null is the default ranking, total descending.
   */
  const [sort, setSort] = useState<SortState>(null);

  useEffect(() => { setPage(0); }, [search, pageSize, sort, filterQuery]);

  useEffect(() => {
    const q = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
    if (search) q.set('q', search);
    if (sort) { q.set('sort', sort.key); q.set('dir', sort.dir); }
    for (const [k, v] of new URLSearchParams(filterQuery)) q.set(k, v);
    api.get<Record<string, any>>(`/api/v1/entity/vendor-pivot?${q.toString()}`)
      .then(setD)
      .catch(() => setD(null));
  }, [search, page, pageSize, sort, filterQuery]);

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
      <ScrollFrame className="table-wrap dt-scroll">
        <table className="data dd-tbl">
          <thead>
            <tr>
              <th><SortButton label="Vendor / material (USD)" colKey="name" sort={sort} onSort={setSort} /></th>
              <th>PO Email</th>
              {months.map((m) => (
                <th key={m} style={{ textAlign: 'right' }}>
                  <SortButton label={m} colKey={m} sort={sort} onSort={setSort} />
                </th>
              ))}
              <th style={{ textAlign: 'right' }}>
                <SortButton label="Total" colKey="total" sort={sort} onSort={setSort} />
              </th>
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
                  <td className="ent-email"><PoEmailCell email={r.poEmail ?? null} inCoupa={r.inCoupa === true} /></td>
                  {months.map((m) => <td key={m} className="num">{cell(r.byMonth[m])}</td>)}
                  <td className="num"><strong>{cell(r.total)}</strong></td>
                </tr>
                {expanded[r.code] === 'loading' && (
                  <tr><td colSpan={months.length + 3} className="muted">Loading materials…</td></tr>
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
                      <td />
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
              <td colSpan={months.length + 1} />
              <td className="num"><strong>{d.grandTotalUsd === null ? `${DASH} (unrated ccy)` : cell(d.grandTotalUsd)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </ScrollFrame>
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
 * The PO email as a table cell.
 *
 * Three outcomes are distinguished rather than collapsed into a blank: an
 * address (a mailto link), a Coupa record whose address was never filled in
 * (actionable — someone should complete the master data), and no Coupa record
 * at all (nothing to fix on this side; the vendor was never onboarded there).
 */
function PoEmailCell({ email, inCoupa }: { email: string | null; inCoupa: boolean }) {
  if (email) {
    return (
      <a href={`mailto:${email}`} onClick={(e) => e.stopPropagation()} title="Send to this address">
        {email}
      </a>
    );
  }
  return inCoupa
    ? <span className="bs sa" title="This supplier exists in Coupa but has no PO email set">not set</span>
    : <span className="muted" title="No Coupa supplier carries this vendor code">{DASH}</span>;
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
  code, onClose, onDrill, currency = 'USD',
}: {
  code: string; onClose: () => void; onDrill: (t: string, l: string) => void;
  /** Topbar display currency — every money cell below reads it. */
  currency?: 'USD' | 'IDR';
}) {
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
                <Bio label="Total Spending" value={currency === 'USD' && d.bio.spendUsd === null ? `${DASH} (unrated ccy present)` : formatCurrency(d.bio.spendUsd, d.bio.spendIdr, currency)} />
                <Bio label="# POs" value={formatNumber(d.bio.poCount)} />
                <Bio label="Materials Supplied" value={formatNumber(d.bio.materialsSupplied)} />
                <Bio label="Areas Served" value={formatNumber(d.bio.areasServed)} />
                <Bio label="On-Time % (≤ deliv+7d)" value={d.bio.otdPct === null ? DASH : `${d.bio.otdPct}%`} title={d.bio.otdCaveat} />
                <Bio label="Avg Days Late" value={d.bio.avgDaysLate === null ? DASH : String(d.bio.avgDaysLate)} />
                <Bio label="Open Exposure" value={formatCurrency(d.bio.openExposureUsd, d.bio.openExposureIdr, currency)} />
                <Bio label="Delivered, Not Invoiced" value={formatCurrency(d.bio.deliveredNotInvoicedUsd, d.bio.deliveredNotInvoicedIdr, currency)} />
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
                left={<MiniBars title={`Spend by month (${currency})`} rows={d.spendByMonth.map((m: any) => ({ label: m.monthKey, value: currency === 'IDR' ? m.idr : m.usd, count: m.lines }))} money currency={currency} />}
                right={<MiniBars title={`Supply to area / plant (${currency})`} rows={d.byArea.map((a: any) => ({ label: a.plantName, value: currency === 'IDR' ? a.idr : a.usd, count: a.lines }))} money currency={currency} />}
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

              <h4 className="ent-h"><Lbl>Materials supplied</Lbl> <span className="muted">(top {d.materials.length} of cap {d.caps.materials})</span></h4>
              <SimpleTable
                prefKey="vendor_materials_layout"
                head={['Material', 'Description', 'Lines', 'Qty', 'Spend USD', 'Last PO']}
                right={[false, false, true, true, true, false]}
                rows={d.materials.map((m: any) => [
                  m.materialCode ?? '(service)', m.description, formatNumber(m.lines),
                  formatNumber(m.qty, 1), formatCurrency(m.usd, m.idr, currency), formatDate(m.lastPo),
                ])}
                sortValues={d.materials.map((m: any) => [
                  m.materialCode, m.description, m.lines, m.qty, m.usd, m.lastPo,
                ])}
              />

              <h4 className="ent-h">
                <Lbl>PO history</Lbl> <span className="muted">(newest {d.poHistory.length}, cap {d.caps.poHistory})</span>
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
              <PoHistoryTable rows={d.poHistory} currency={currency} />

              <h4 className="ent-h"><Lbl>GR history</Lbl> <span className="muted">(newest {d.grHistory.length}, cap {d.caps.grHistory})</span></h4>
              <SimpleTable
                prefKey="vendor_gr_history_layout"
                head={['Mat. doc', 'PO', 'Item', 'Mvt', 'Class', 'Posted', 'Signed qty', 'Material']}
                right={[false, false, true, false, false, false, true, false]}
                rows={d.grHistory.map((g: any) => [
                  g.materialDoc, g.poNo, String(g.poItem), g.movementType, g.postingClass,
                  formatDate(g.postingDate), formatNumber(g.signedQty, 3), g.materialDesc ?? DASH,
                ])}
                sortValues={d.grHistory.map((g: any) => [
                  g.materialDoc, g.poNo, g.poItem, g.movementType, g.postingClass,
                  g.postingDate, g.signedQty, g.materialDesc,
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
export function MaterialsTab({ onDrill, filterQuery = '', currency = 'USD' }: {
  onDrill: (t: string, l: string) => void;
  /** Global filter bar, as a query string — the charts below honour it. */
  filterQuery?: string;
  /** Topbar display currency — every money cell below reads it. */
  currency?: 'USD' | 'IDR';
}) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [category, setCategory] = useState<string>('');
  const [group, setGroup] = useState<string>('');
  const [limit, setLimit] = useState(150);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  /** The Category 360 popup (19 Oct 2026), by spend category. */
  const [cat360, setCat360] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    // The filter bar too: the category summary follows it (19 Oct 2026).
    const q = new URLSearchParams(filterQuery);
    q.set('limit', String(limit));
    if (category) q.set('category', category);
    if (group) q.set('materialGroup', group);
    if (debounced) q.set('q', debounced);
    api.get<Record<string, any>>(`/api/v1/entity/material-groups?${q.toString()}`)
      .then(setD)
      .catch(() => setD(null));
  }, [category, group, debounced, limit, filterQuery]);

  if (!d) return <div className="center-msg"><div className="spinner" />Loading material groups…</div>;

  return (
    <>
      {/* v1's Analysis by Material Group charts, on top (5 Aug 2026). */}
      <div className="chart-grid">
        {/* A bar or its label opens the Category 360 popup (19 Oct 2026). */}
        <ChartPanel chartId="items_by_category" onDrill={onDrill} currency={currency} filterQuery={filterQuery} onBucketClick={(k) => setCat360(k)} />
        <ChartPanel chartId="e2e_by_category" onDrill={onDrill} currency={currency} filterQuery={filterQuery} onBucketClick={(k) => setCat360(k)} />
      </div>

      <div className="panel" style={{ marginTop: '1rem' }}>
        <h3 className="pr-tbl-h"><Lbl>Summary by Spend Category</Lbl> <span className="muted">— avg aging metrics (days)</span></h3>
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
                  title={`Open ${c.category} 360`}
                  onClick={() => setCat360(c.category)}
                >
                  <td style={{ fontWeight: 700, color: CATEGORY_COLORS[c.category] ?? 'inherit' }}>
                    <button className="cu-link" style={{ fontWeight: 700, color: 'inherit' }} onClick={(e) => { e.stopPropagation(); setCat360(c.category); }}>
                      {c.category}
                    </button>
                  </td>
                  {/* The counts open the 360 too; its own buttons list the rows. */}
                  <td className="num">
                    <button className="cu-link" onClick={(e) => { e.stopPropagation(); setCat360(c.category); }}>
                      {formatNumber(c.items)}
                    </button>
                  </td>
                  <td className="num">
                    <button className="cu-link" style={{ color: 'var(--crit)', fontWeight: 700 }} onClick={(e) => { e.stopPropagation(); setCat360(c.category); }}>
                      {formatNumber(c.open)}
                    </button>
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
        <p className="note">PR items per category (deleted excluded), under the filter bar like the charts above; stage averages over non-negative spans. Click a category or any of its figures for its 360 view; filter the material list by category below.</p>
      </div>

      <div className="panel">
        <div className="dt-toolbar">
          <h3 className="pr-tbl-h" style={{ margin: 0 }}><Lbl>Material Explorer — click a material for vendors, areas &amp; price history</Lbl>{category ? ` · ${category}` : ''}</h3>
          {/* The category filter moved here when a summary click began opening
              the 360 popup (19 Oct 2026). */}
          <select
            className="dt-search"
            style={{ flex: 'none', width: 180 }}
            value={category}
            onChange={(e) => { setCategory(e.target.value); setLimit(150); }}
            aria-label="Spend category"
          >
            <option value="">All spend categories</option>
            {d.categories.map((c: any) => <option key={c.category} value={c.category}>{c.category}</option>)}
          </select>
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
          <h3 className="pr-tbl-h"><Lbl>Price Volatility — top 50 most erratic unit prices (CV%, IDR)</Lbl></h3>
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
          <h3 className="pr-tbl-h"><Lbl>Single-Source Risk — top 50 by spend · click for material popup</Lbl></h3>
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

      {open && <MaterialModal code={open} onClose={() => setOpen(null)} onDrill={onDrill} currency={currency} />}
      {cat360 && (
        <CategoryModal
          category={cat360}
          onClose={() => setCat360(null)}
          onDrill={onDrill}
          currency={currency}
          filterQuery={filterQuery}
        />
      )}
    </>
  );
}

/**
 * Category 360 (19 Oct 2026): a spend category drawn like the Material 360
 * popup - figures, the top vendors' monthly spend, vendor and area shares, its
 * materials (each opening its own Material 360) and its newest PO lines.
 * Follows the filter bar, like the charts that open it, and has its own Plant
 * filter on top.
 */
export function CategoryModal({
  category, onClose, onDrill, currency = 'USD', filterQuery = '',
}: {
  category: string; onClose: () => void; onDrill: (t: string, l: string) => void;
  currency?: 'USD' | 'IDR';
  filterQuery?: string;
}) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [plants, setPlants] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [mat, setMat] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    const q = new URLSearchParams(filterQuery);
    q.set('name', category);
    if (plants.length > 0) q.set('popPlant', plants.join(','));
    setBusy(true);
    setErr(null);
    api.get<Record<string, any>>(`/api/v1/entity/category?${q.toString()}`)
      .then((r) => { if (!gone) setD(r); })
      .catch((e: Error) => { if (!gone) setErr(e.message); })
      .finally(() => { if (!gone) setBusy(false); });
    return () => { gone = true; };
  }, [category, plants, filterQuery]);

  const k = d?.kpis;
  const money = (usd: number | null, idr: number | null) => formatCurrency(usd, idr, currency);
  const days = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${Number(v).toFixed(1)} d`);
  const scopeNote = plants.length > 0 ? ` · plant ${plants.join(', ')}` : '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`${category} 360`} onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>
            🏷️ <span style={{ color: CATEGORY_COLORS[category] ?? 'inherit' }}>{category}</span>{' '}
            <span className="muted"><Lbl>spend category 360</Lbl></span>
          </h3>
          <span className="spacer" />
          {d?.drill?.allLines && (
            <button className="dt-btn" onClick={() => onDrill(d.drill.allLines, `${category} — all PO lines${scopeNote}`)}>
              Open all lines
            </button>
          )}
          <button className="btn secondary" style={{ width: 'auto' }} onClick={onClose}>Close</button>
        </header>
        <div className="body">
          <div className="gf-bar cat360-filters">
            <span className="gf-label">Filter</span>
            <FilterDropdown
              label="Plant"
              options={d?.plantOptions ?? []}
              selected={plants}
              onChange={setPlants}
            />
            {plants.length > 0 && (
              <button className="gf-btn gf-clear" onClick={() => setPlants([])}>Clear</button>
            )}
            {filterQuery !== '' && <span className="gf-note">the page's filter bar applies too</span>}
            {busy && d && <span className="gf-note">updating…</span>}
          </div>

          {err && <p className="err">{err}</p>}
          {!d && !err && <div className="center-msg"><div className="spinner" />Loading…</div>}
          {d && k && (
            <>
              <div className="ent-kpis">
                <Bio label="PO lines" value={`${formatNumber(k.lineCount)} · ${formatNumber(k.poCount)} POs`} />
                <Bio label="Vendors" value={formatNumber(k.vendorCount)} />
                <Bio label="Materials" value={formatNumber(k.materialCount)} />
                <Bio label="Plants" value={formatNumber(k.plantCount)} />
                <Bio
                  label={`Spend ${currency}`}
                  value={money(k.spendUsd, k.spendIdr)}
                  title={k.unratedLines > 0 ? `${formatNumber(k.unratedLines)} lines have no USD rate; the USD total is withheld` : undefined}
                />
                <Bio label="Open commitment" value={money(k.openCommitUsd, k.openCommitIdr)} />
              </div>
              <div className="ent-kpis" style={{ marginTop: '.4rem' }}>
                <Bio label="PR items" value={formatNumber(k.prItems)} />
                <Bio label="Open PR items" value={`${formatNumber(k.openPrItems)}${k.prItems > 0 ? ` · ${((k.openPrItems / k.prItems) * 100).toFixed(1)}%` : ''}`} />
                <Bio label="PRA avg" value={days(k.avgPra)} />
                <Bio label="SRC avg" value={days(k.avgSrc)} />
                <Bio label="POA avg" value={days(k.avgPoa)} />
                <Bio label="DLT avg" value={days(k.avgDlt)} />
                <Bio label="E2E avg" value={days(k.avgE2e)} />
              </div>
              <p className="note" style={{ margin: '.3rem 0 0' }}>
                List the rows:{' '}
                {d.drill?.prItems && <button className="cu-link" onClick={() => onDrill(d.drill.prItems, `${category} — all PR items${scopeNote}`)}>PR items</button>}
                {' · '}
                {d.drill?.openPrItems && <button className="cu-link" onClick={() => onDrill(d.drill.openPrItems, `${category} — open items${scopeNote}`)}>open PR items</button>}
                {' · '}
                {d.drill?.openCommitment && <button className="cu-link" onClick={() => onDrill(d.drill.openCommitment, `${category} — open commitment${scopeNote}`)}>open commitment</button>}
                . PO figures exclude STO and deleted lines; PR figures use the requisition's own material, as the summary does.
              </p>

              <div className="ent-mini" style={{ marginTop: '.6rem' }}>
                <div className="ent-h" style={{ marginTop: 0 }}><Lbl>Spend by month — top vendors</Lbl> ({currency})</div>
                <PriceTrend
                  rows={(d.spendByVendor ?? []).map((x: any) => ({
                    ...x, unitPrice: currency === 'IDR' ? x.idr : x.usd,
                  }))}
                  yTitle={`Spend (${currency})`}
                  empty="No dated spend to chart."
                />
                <p className="note" style={{ marginBottom: 0 }}>
                  The six vendors with the most spend in this category, by PO document month.
                </p>
              </div>
              <TwoCol
                left={<AreaDonut title={`Suppliers / Vendors — share of PO amount (${currency})`} rows={(d.vendorShare ?? []).map((x: any) => ({ plant: x.vendorCode, plantName: `${x.vendorCode ?? ''} ${x.vendorName ?? ''}`.trim() || '(vendor)', usd: currency === 'IDR' ? x.idr : x.usd }))} />}
                right={<AreaDonut title={`Areas purchased — share of PO amount (${currency})`} rows={(d.areaShare ?? []).map((x: any) => ({ ...x, usd: currency === 'IDR' ? x.idr : x.usd }))} />}
              />

              <h4 className="ent-h">
                <Lbl>Materials in this category</Lbl>{' '}
                <span className="muted">· top {d.topMaterials.length} of {formatNumber(k.materialCount)} by spend · click one for its Material 360</span>
              </h4>
              <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
                <table className="data dd-tbl">
                  <thead>
                    <tr>
                      <th>Material</th><th>Description</th><th>Mat Grp</th>
                      <th className="num">Vendors</th><th className="num">Lines</th>
                      <th className="num">Spend {currency}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.topMaterials.length === 0 && <tr><td colSpan={6} className="muted">No materials with a code.</td></tr>}
                    {d.topMaterials.map((m: any, i: number) => (
                      <tr key={m.materialCode} className={`ent-row ${i % 2 ? '' : 're'}`} title="Open Material 360" onClick={() => setMat(m.materialCode)}>
                        <td style={{ fontWeight: 700, color: 'var(--blue)' }}>{m.materialCode}</td>
                        <td>{m.description}</td>
                        <td>{m.materialGroup ?? DASH}</td>
                        <td className="num">{m.soleSource ? <span title="Sole source">🔴 1</span> : formatNumber(m.vendors)}</td>
                        <td className="num">{formatNumber(m.lines)}</td>
                        <td className="num">{money(m.spendUsd, m.spendIdr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h4 className="ent-h"><Lbl>Purchase Orders in this category</Lbl> <span className="muted">· {formatNumber(k.lineCount)} PO lines (newest {d.poHistory.length}, cap {d.caps.poHistory})</span></h4>
              <PoHistoryTable rows={d.poHistory} vendor material currency={currency} />
            </>
          )}
        </div>
      </div>
      {mat && (
        <MaterialModal
          code={mat}
          onClose={() => setMat(null)}
          onDrill={onDrill}
          currency={currency}
          initialPlants={plants}
        />
      )}
    </div>
  );
}

export function MaterialModal({
  code, onClose, onDrill, currency = 'USD', initialPlants = [],
}: {
  code: string; onClose: () => void; onDrill: (t: string, l: string) => void;
  /** Topbar display currency — every money cell below reads it. */
  currency?: 'USD' | 'IDR';
  /** Plants to start filtered to - a Category 360's choice, carried in. */
  initialPlants?: string[];
}) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** The popup's own Plant filter (19 Oct 2026); empty = every plant. */
  const [plants, setPlants] = useState<string[]>(initialPlants);

  useEffect(() => {
    let gone = false;
    const qs = plants.length > 0 ? `?popPlant=${encodeURIComponent(plants.join(','))}` : '';
    setErr(null);
    api.get<Record<string, any>>(`/api/v1/entity/material/${encodeURIComponent(code)}${qs}`)
      .then((r) => { if (!gone) setD(r); })
      .catch((e: Error) => { if (!gone) setErr(e.message); });
    return () => { gone = true; };
  }, [code, plants]);

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
          <div className="gf-bar cat360-filters">
            <span className="gf-label">Filter</span>
            <FilterDropdown label="Plant" options={d?.plantOptions ?? []} selected={plants} onChange={setPlants} />
            {plants.length > 0 && (
              <button className="gf-btn gf-clear" onClick={() => setPlants([])}>Clear</button>
            )}
          </div>
          {err && <p className="err">{err}</p>}
          {!d && !err && <div className="center-msg"><div className="spinner" />Loading…</div>}
          {d && (
            <>
              <div className="ent-kpis">
                <Bio label="PO lines" value={formatNumber(d.kpis.lineCount)} />
                <Bio label="Vendors" value={`${formatNumber(d.kpis.vendorCount)}${d.kpis.soleSource ? ' 🔴 sole source' : ''}`} />
                <Bio label="Total qty" value={formatNumber(d.kpis.totalQty, 1)} />
                <Bio label={`Spend ${currency}`} value={formatCurrency(d.kpis.spendUsd, d.kpis.spendIdr, currency)} />
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

              <h4 className="ent-h"><Lbl>Purchase Orders for this material</Lbl> <span className="muted">· {formatNumber(d.kpis.lineCount)} PO lines (newest {d.poHistory.length}, cap {d.caps.poHistory})</span></h4>
              <PoHistoryTable rows={d.poHistory} vendor currency={currency} />
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
function PriceTrend({ rows, yTitle = 'Unit price (IDR equivalent)', empty = 'No IDR unit-price history to chart.' }: {
  rows: Record<string, any>[];
  yTitle?: string;
  empty?: string;
}) {
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
        scales: { y: { title: { display: true, text: yTitle } } },
      },
    }) as unknown as ChartJS;
    return () => { chart.current?.destroy(); chart.current = null; };
  }, [rows, yTitle]);
  if (rows.length === 0) return <p className="note">{empty}</p>;
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
  title, rows, money = false, currency = 'USD',
}: {
  title: string; rows: { label: string; value: number | null; count: number }[];
  money?: boolean; currency?: 'USD' | 'IDR';
}) {
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
          <span className="ent-bar-val">{money ? formatMoney(r2.value, currency) : formatNumber(r2.value, 2)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * A popup list with the table tools (7 Oct 2026): choose columns, drag to
 * reorder, sort any header either way, scrollbar above. `rows` are the cells
 * as shown; `sortValues`, when given, are the raw values they sort by, so a
 * money or quantity column sorts by amount rather than by its formatted text.
 */
function SimpleTable({ prefKey, head, rows, sortValues, right }: {
  prefKey: string;
  head: string[];
  rows: (string | null)[][];
  sortValues?: unknown[][];
  right?: boolean[];
}) {
  type R = { cells: (string | null)[]; raw: unknown[] };
  const data: R[] = rows.map((cells, i) => ({ cells, raw: sortValues?.[i] ?? cells }));
  const columns: ToolTableColumn<R>[] = head.map((h2, j) => ({
    key: String(j),
    label: h2,
    right: right?.[j] ?? false,
    render: (r) => r.cells[j] ?? DASH,
    sortValue: (r) => r.raw[j],
  }));
  return <ToolTable prefKey={prefKey} columns={columns} rows={data} maxHeight="300px" className="data" />;
}

function PoHistoryTable({ rows, vendor = false, material = false, currency = 'USD' }: {
  rows: Record<string, any>[]; vendor?: boolean;
  /** Material, description and plant columns - the Category 360's list. */
  material?: boolean;
  currency?: 'USD' | 'IDR';
}) {
  const columns: ToolTableColumn<Record<string, any>>[] = [
    { key: 'poNo', label: 'PO', render: (r) => r.poNo },
    { key: 'poItem', label: 'Item', right: true, render: (r) => r.poItem },
    { key: 'documentDate', label: 'Date', render: (r) => formatDate(r.documentDate) },
    ...(material ? [
      { key: 'materialCode', label: 'Material', render: (r: Record<string, any>) => r.materialCode ?? DASH },
      { key: 'shortText', label: 'Description', render: (r: Record<string, any>) => r.shortText ?? DASH },
      { key: 'plant', label: 'Plant', render: (r: Record<string, any>) => r.plant ?? DASH },
    ] : []),
    ...(vendor ? [{ key: 'vendorName', label: 'Vendor', render: (r: Record<string, any>) => r.vendorName ?? DASH }] : []),
    { key: 'orderQty', label: 'Qty', right: true, render: (r) => formatNumber(r.orderQty, 2) },
    { key: 'orderUnit', label: 'Unit', render: (r) => r.orderUnit ?? DASH },
    {
      key: 'unitPrice', label: 'Unit price', right: true,
      render: (r) => ((r.flags as string[])?.includes('sto') ? `${DASH} (STO)` : formatNumber(r.unitPrice, 2)),
    },
    { key: 'priceUnit', label: 'Price unit', right: true, render: (r) => r.priceUnit ?? DASH },
    { key: 'currencyCode', label: 'Ccy', render: (r) => r.currencyCode },
    { key: 'netOrderValue', label: 'Value', right: true, render: (r) => formatMoney(r.netOrderValue) },
    // The document-currency column beside this one never converts; this one
    // follows the toggle.
    { key: 'netOrderValueUsd', label: `Value ${currency}`, right: true, render: (r) => formatCurrency(r.netOrderValueUsd, r.netOrderValueIdr, currency) },
    {
      key: 'status', label: 'Status',
      render: (r) => <span className={'bs ' + (STATUS_PILL[String(r.status)] ?? 'sl')}>{r.status}</span>,
    },
    { key: 'receiptDate', label: 'GR date', render: (r) => formatDate(r.receiptDate) },
  ];
  return (
    <ToolTable
      prefKey={material ? 'category_po_history_layout' : vendor ? 'material_po_history_layout' : 'vendor_po_history_layout'}
      columns={columns}
      rows={rows}
      maxHeight="340px"
      lead={(r) => ((r.flags as string[]) ?? []).map((f) => {
        const m = FLAG_META[f];
        return m ? <span key={f} className="flag" title={m.label}>{m.icon}</span> : null;
      })}
    />
  );
}
