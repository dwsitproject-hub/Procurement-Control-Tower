import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { DASH, FLAG_META, formatDate, formatMoney, formatNumber } from '../lib/format';

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
        <input
          className="dt-search"
          type="search"
          placeholder="Search vendor name or code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search vendors"
        />
        <span className="count">
          {formatNumber(total)} vendors · showing top {rows.length} by spend · STO excluded
        </span>
      </div>

      {loading ? (
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

function VendorModal({
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

              <h4 className="ent-h">Materials supplied <span className="muted">(top {d.materials.length} of cap {d.caps.materials})</span></h4>
              <SimpleTable
                head={['Material', 'Description', 'Lines', 'Qty', 'Spend USD', 'Last PO']}
                rows={d.materials.map((m: any) => [
                  m.materialCode ?? '(service)', m.description, formatNumber(m.lines),
                  formatNumber(m.qty, 1), formatMoney(m.usd, 'USD'), formatDate(m.lastPo),
                ])}
              />

              <h4 className="ent-h">PO history <span className="muted">(newest {d.poHistory.length}, cap {d.caps.poHistory})</span></h4>
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
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const q = new URLSearchParams();
    if (category) q.set('category', category);
    if (debounced) q.set('q', debounced);
    api.get<Record<string, any>>(`/api/v1/entity/material-groups?${q.toString()}`)
      .then(setD)
      .catch(() => setD(null));
  }, [category, debounced]);

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
                <th style={{ textAlign: 'right' }}>Median sourcing (d)</th>
                <th style={{ textAlign: 'right' }}>Median delivery (d)</th>
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
                  <td className="num">{formatNumber(c.lines)}</td>
                  <td className="num">{formatNumber(c.pos)}</td>
                  <td className="num">{formatMoney(c.spendUsd, 'USD')}</td>
                  <td className="num">{c.medianSourcingDays === null ? DASH : Math.round(c.medianSourcingDays)}</td>
                  <td className="num">{c.medianDeliveryDays === null ? DASH : Math.round(c.medianDeliveryDays)}</td>
                  <td className="num">{formatNumber(c.openLines)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">STO and deleted lines excluded. Click a category to filter the material list.</p>
      </div>

      <div className="panel">
        <div className="dt-toolbar">
          <h2 style={{ margin: 0 }}>Materials{category ? ` — ${category}` : ''}</h2>
          <input
            className="dt-search"
            type="search"
            placeholder="Search material code or description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search materials"
          />
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
        <p className="note">Top {d.materials.length} by spend (cap {d.caps.materials}).</p>
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

              <TwoCol
                left={<MiniBars title="Avg unit price by month (IDR lines, STO/token excluded)" rows={d.priceHistory.map((x: any) => ({ label: x.monthKey, value: x.avgUnitPrice, count: x.lines }))} />}
                right={<MiniBars title="Vendor share of spend (USD)" rows={d.vendorShare.map((x: any) => ({ label: x.vendorName ?? x.vendorCode ?? '(plant)', value: x.usd, count: x.lines }))} money />}
              />

              <h4 className="ent-h">PO history <span className="muted">(newest {d.poHistory.length}, cap {d.caps.poHistory})</span></h4>
              <PoHistoryTable rows={d.poHistory} vendor />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────── small shared bits

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
      <table className="data">
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
              <td>{r2.status}</td>
              <td>{formatDate(r2.receiptDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
