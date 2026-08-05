import { useEffect, useRef, useState } from 'react';
import {
  BarController, BarElement, CategoryScale, Chart as ChartJS, Legend, LinearScale, Tooltip,
} from 'chart.js';
import { api } from '../lib/api';
import { DASH, formatNumber } from '../lib/format';

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

function Kpi({ v, label, sub }: { v: unknown; label: string; sub?: string }) {
  return (
    <div className="kpi" data-sev="neutral">
      <div className="v">{v === null || v === undefined ? DASH : String(v)}</div>
      <div className="l">{label}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

/** Small month bar chart in the house style (value labels, PALETTE hue). */
function OpsBars({
  title, rows, series,
}: {
  title: string;
  rows: Record<string, any>[];
  series: { key: string; label: string; color: string; money?: boolean }[];
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
        c.data.datasets.forEach((ds: any, di: number) => {
          const meta = c.getDatasetMeta(di);
          if (meta.hidden) return;
          ds.data.forEach((v: number | null, i: number) => {
            if (v === null || v === undefined) return;
            const el = meta.data[i];
            if (!el) return;
            const sp = series[di];
            ctx.fillText(sp?.money ? M(v) : formatNumber(Number(v)), el.x, el.y - 2);
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
        plugins: {
          legend: { display: series.length > 1, position: 'bottom', labels: { boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: (ctx: any) => {
                const sp = series[ctx.datasetIndex];
                return `${sp?.label}: ${sp?.money ? M(ctx.parsed.y) + ' IDR' : formatNumber(ctx.parsed.y)}`;
              },
            },
          },
        },
      },
    }) as unknown as ChartJS;
    return () => { chart.current?.destroy(); chart.current = null; };
  }, [rows, series]);
  return (
    <div className="panel">
      <h3 className="pr-tbl-h">{title}</h3>
      {rows.length === 0 ? <p className="note">No data yet.</p> : <div style={{ height: 220 }}><canvas ref={canvas} /></div>}
    </div>
  );
}

function SyncNote({ watermarks }: { watermarks: Record<string, any>[] | undefined }) {
  return (
    <div className="panel" style={{ borderLeft: '3px solid var(--accent)' }}>
      <p className="note" style={{ margin: 0 }}>
        Live from the Coupa operational store
        {watermarks?.length
          ? ` — synced ${watermarks.map((w) => `${w.object} ${w.last_updated_at ? String(w.last_updated_at).slice(0, 16) : DASH} (${w.last_status ?? DASH})`).join(' · ')}`
          : ' — no sync has run yet'}
        . Separate from the SAP dataset versions. IDR document-currency amounts only; other currencies are counted, never silently converted.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── Sourcing page

export function CoupaSourcingTab() {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.get<Record<string, any>>('/api/v1/coupa/sourcing').then(setD).catch((e: Error) => setErr(e.message));
  }, []);
  if (err) return <div className="panel"><h2>Sourcing</h2><p className="err">{err}</p></div>;
  if (!d) return <div className="center-msg"><div className="spinner" />Loading Coupa sourcing…</div>;
  if (!d.configured) {
    return <div className="panel"><h2>Sourcing</h2><p className="note">Coupa is not configured on this environment — an administrator must set the backend COUPA_* variables (Admin tab).</p></div>;
  }
  const k = d.kpis ?? {};
  const b = d.bids ?? {};
  const awardRate = Number(b.responses ?? 0) > 0 ? ((Number(b.awarded ?? 0) / Number(b.responses)) * 100).toFixed(1) : null;
  return (
    <>
      <SyncNote watermarks={d.watermarks} />
      <div className="kpi-grid" style={{ marginBottom: '1rem' }}>
        <Kpi v={formatNumber(Number(k.events ?? 0))} label="Sourcing events" sub="excluding templates" />
        <Kpi v={formatNumber(Number(k.open_events ?? 0))} label="Open events" sub="not complete or canceled" />
        <Kpi v={formatNumber(Number(k.completed ?? 0))} label="Completed events" />
        <Kpi v={k.median_cycle_days == null ? DASH : `${Number(k.median_cycle_days).toFixed(1)} d`} label="Event cycle (median)" sub="submit → end" />
        <Kpi v={formatNumber(Number(b.suppliers ?? 0))} label="Participating suppliers" sub={`${formatNumber(Number(b.responses ?? 0))} submitted bids`} />
        <Kpi v={b.avg_bids_per_event ?? DASH} label="Avg bids per event" sub={`${formatNumber(Number(b.events_with_bids ?? 0))} events with bids`} />
        <Kpi v={awardRate === null ? DASH : `${awardRate}%`} label="Bid award rate" sub={`${formatNumber(Number(b.awarded ?? 0))} awarded bids`} />
        <Kpi
          v={k.planned_savings_idr == null ? DASH : `${M(k.planned_savings_idr)} IDR`}
          label="Planned savings (IDR)"
          sub={Number(k.savings_other_ccy ?? 0) > 0 ? `${k.savings_other_ccy} non-IDR events not converted` : 'from event headers'}
        />
      </div>

      <div className="chart-grid">
        <OpsBars
          title="Sourcing events by month"
          rows={d.eventsByMonth ?? []}
          series={[
            { key: 'events', label: 'Events created', color: '#2E75B6' },
            { key: 'completed', label: 'Completed', color: '#0D9488' },
          ]}
        />
        <div className="panel">
          <h3 className="pr-tbl-h">Awarded spend by commodity — IDR documents</h3>
          <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead><tr><th>Commodity</th><th className="num">Awarded bids</th><th className="num">Amount (M IDR)</th></tr></thead>
              <tbody>
                {(d.byCommodity ?? []).length === 0 && <tr><td colSpan={3} className="muted">No awarded bids yet.</td></tr>}
                {(d.byCommodity ?? []).map((c: any, i: number) => (
                  <tr key={c.commodity} className={i % 2 ? '' : 're'}>
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
          <h3 className="pr-tbl-h">Awarded spend by supplier — top 12, IDR documents</h3>
          <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead><tr><th>Supplier</th><th className="num">Awarded bids</th><th className="num">Amount (M IDR)</th></tr></thead>
              <tbody>
                {(d.bySupplier ?? []).length === 0 && <tr><td colSpan={3} className="muted">No awarded bids yet.</td></tr>}
                {(d.bySupplier ?? []).map((c: any, i: number) => (
                  <tr key={c.supplier_name} className={i % 2 ? '' : 're'}>
                    <td>{c.supplier_name}</td>
                    <td className="num">{formatNumber(c.awarded_bids)}{c.other_ccy > 0 ? <span className="muted" title={`${c.other_ccy} non-IDR bids not in the amount`}> ⚠</span> : null}</td>
                    <td className="num">{M(c.amount_idr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h3 className="pr-tbl-h">Event pipeline</h3>
          <p className="note">
            {formatNumber(Number(k.events ?? 0))} events · {formatNumber(Number(k.open_events ?? 0))} still open ·{' '}
            {formatNumber(Number(k.completed ?? 0))} complete. Bids: {formatNumber(Number(b.responses ?? 0))} submitted
            by {formatNumber(Number(b.suppliers ?? 0))} suppliers, {formatNumber(Number(b.awarded ?? 0))} awarded.
          </p>
        </div>
      </div>

      <div className="panel" style={{ marginTop: '1rem' }}>
        <h3 className="pr-tbl-h">Sourcing data table <span className="muted">— newest 200 supplier bids</span></h3>
        <div className="table-wrap dt-scroll">
          <table className="data dd-tbl">
            <thead>
              <tr>
                <th>Event</th><th>Type</th><th>State</th><th>Commodity</th><th>Description</th>
                <th>SAP PR</th><th>Supplier</th><th>Awarded</th><th>Submitted</th>
                <th className="num">Amount</th><th>Ccy</th>
              </tr>
            </thead>
            <tbody>
              {(d.dataTable ?? []).map((r2: any, i: number) => (
                <tr key={`${r2.event_id}|${r2.supplier_name}|${i}`} className={i % 2 ? '' : 're'}>
                  <td>{r2.event_id}</td>
                  <td>{r2.event_type ?? DASH}</td>
                  <td>{r2.event_state ?? DASH}</td>
                  <td>{r2.commodity ?? DASH}</td>
                  <td className="muted">{r2.description ?? ''}</td>
                  <td>{r2.sap_pr_no ?? DASH}</td>
                  <td>{r2.supplier_name ?? DASH}</td>
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
    </>
  );
}

// ──────────────────────────────────────────────── Invoicing & Payment page

const INV_PILL: Record<string, string> = {
  paid: 'sd', approved: 'su', pending_approval: 'sn', pending_receipt: 'sn',
  voided: 'spdel', draft: 'sl', disputed: 'sa', on_hold: 'shold',
};

export function CoupaInvoicesTab() {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.get<Record<string, any>>('/api/v1/coupa/invoices').then(setD).catch((e: Error) => setErr(e.message));
  }, []);
  if (err) return <div className="panel"><h2>Invoicing &amp; Payment</h2><p className="err">{err}</p></div>;
  if (!d) return <div className="center-msg"><div className="spinner" />Loading Coupa invoices…</div>;
  if (!d.configured) {
    return <div className="panel"><h2>Invoicing &amp; Payment</h2><p className="note">Coupa is not configured on this environment — an administrator must set the backend COUPA_* variables (Admin tab).</p></div>;
  }
  const k = d.kpis ?? {};
  const p2 = d.pay ?? {};
  const paidPct = Number(k.invoices ?? 0) > 0 ? ((Number(k.paid_count ?? 0) / Number(k.invoices)) * 100).toFixed(0) : null;
  return (
    <>
      <SyncNote watermarks={d.watermarks} />
      <div className="kpi-grid" style={{ marginBottom: '1rem' }}>
        <Kpi v={formatNumber(Number(k.invoices ?? 0))} label="Total invoices" sub={`${k.currencies ?? 0} currencies`} />
        <Kpi v={formatNumber(Number(k.paid_count ?? 0))} label="Paid" sub={paidPct === null ? undefined : `${paidPct}% of all invoices`} />
        <Kpi v={formatNumber(Number(k.open_count ?? 0))} label="Open (unpaid)" sub="excl. drafts and voided" />
        <Kpi v={k.open_idr == null ? DASH : `${(Number(k.open_idr) / 1e9).toFixed(2)} B IDR`} label="Open payables (IDR)" sub={Number(k.other_ccy ?? 0) > 0 ? `${k.other_ccy} non-IDR invoices not converted` : undefined} />
        <Kpi v={k.gross_idr == null ? DASH : `${(Number(k.gross_idr) / 1e9).toFixed(2)} B IDR`} label="Gross invoiced (IDR)" sub={k.tax_idr == null ? undefined : `tax ${M(k.tax_idr)} IDR`} />
        <Kpi v={formatNumber(Number(p2.payments ?? 0))} label="Payments recorded" sub={`${formatNumber(Number(p2.with_sap_doc ?? 0))} with SAP payment doc`} />
        <Kpi v={p2.paid_idr == null ? DASH : `${(Number(p2.paid_idr) / 1e9).toFixed(2)} B IDR`} label="Paid amount (IDR)" />
        <Kpi v={k.avg_days_to_pay == null ? DASH : `${Number(k.avg_days_to_pay).toFixed(1)} d`} label="Avg days to pay" sub="invoice date → payment date" />
      </div>

      <div className="chart-grid">
        <OpsBars
          title="Invoices by month"
          rows={d.invoicesByMonth ?? []}
          series={[
            { key: 'invoices', label: 'Invoices', color: '#2E75B6' },
            { key: 'paid', label: 'Paid', color: '#4CAF50' },
          ]}
        />
        <OpsBars
          title="Payments by month (M IDR)"
          rows={d.paymentsByMonth ?? []}
          series={[{ key: 'paid_idr', label: 'Paid (IDR)', color: '#0D9488', money: true }]}
        />
      </div>

      <div className="chart-grid" style={{ marginTop: '1rem' }}>
        <div className="panel">
          <h3 className="pr-tbl-h">Top suppliers by invoiced value — IDR documents</h3>
          <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead><tr><th>Supplier</th><th className="num">Invoices</th><th className="num">Paid</th><th className="num">Gross (M IDR)</th></tr></thead>
              <tbody>
                {(d.topSuppliers ?? []).map((t: any, i: number) => (
                  <tr key={t.supplier_name} className={i % 2 ? '' : 're'}>
                    <td>{t.supplier_name}</td>
                    <td className="num">{formatNumber(t.invoices)}{t.other_ccy > 0 ? <span className="muted" title={`${t.other_ccy} non-IDR invoices not in the amount`}> ⚠</span> : null}</td>
                    <td className="num">{formatNumber(t.paid)}</td>
                    <td className="num">{M(t.gross_idr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h3 className="pr-tbl-h">Invoice status mix</h3>
          <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead><tr><th>Status</th><th className="num">Invoices</th></tr></thead>
              <tbody>
                {(d.statusMix ?? []).map((x: any, i: number) => (
                  <tr key={x.status} className={i % 2 ? '' : 're'}>
                    <td><span className={`bs ${INV_PILL[String(x.status)] ?? 'sl'}`}>{x.status}</span></td>
                    <td className="num">{formatNumber(x.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="chart-grid" style={{ marginTop: '1rem' }}>
        <div className="panel">
          <h3 className="pr-tbl-h">Recent invoices <span className="muted">— newest 50</span></h3>
          <div className="table-wrap dt-scroll" style={{ maxHeight: 340 }}>
            <table className="data dd-tbl">
              <thead>
                <tr>
                  <th>Invoice #</th><th>Date</th><th>Supplier</th><th>Status</th>
                  <th className="num">Gross</th><th>Ccy</th><th>Term</th><th>Paid on</th>
                </tr>
              </thead>
              <tbody>
                {(d.recentInvoices ?? []).map((i2: any, i: number) => (
                  <tr key={i2.id} className={i % 2 ? '' : 're'}>
                    <td>{i2.invoice_number ?? i2.id}</td>
                    <td>{i2.invoice_date ? String(i2.invoice_date).slice(0, 10) : DASH}</td>
                    <td>{(i2.supplier_name ?? '').slice(0, 28)}</td>
                    <td><span className={`bs ${i2.paid ? 'sd' : INV_PILL[String(i2.status)] ?? 'sl'}`}>{i2.paid ? 'paid' : i2.status}</span></td>
                    <td className="num">{i2.gross_total === null ? DASH : formatNumber(Number(i2.gross_total))}</td>
                    <td><span className="dd-ccy">{i2.currency ?? DASH}</span></td>
                    <td>{i2.payment_term ?? DASH}</td>
                    <td>{i2.payment_date ? String(i2.payment_date).slice(0, 10) : DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h3 className="pr-tbl-h">Recent payments <span className="muted">— newest 50</span></h3>
          <div className="table-wrap dt-scroll" style={{ maxHeight: 340 }}>
            <table className="data dd-tbl">
              <thead>
                <tr><th>Paid on</th><th>Invoice #</th><th>Supplier</th><th className="num">Amount</th><th>Ccy</th><th>SAP doc</th></tr>
              </thead>
              <tbody>
                {(d.recentPayments ?? []).map((p3: any, i: number) => (
                  <tr key={`${p3.invoice_number}|${i}`} className={i % 2 ? '' : 're'}>
                    <td>{p3.payment_date ? String(p3.payment_date).slice(0, 10) : DASH}</td>
                    <td>{p3.invoice_number ?? DASH}</td>
                    <td>{(p3.supplier_name ?? '').slice(0, 28)}</td>
                    <td className="num">{p3.amount_paid === null ? DASH : formatNumber(Number(p3.amount_paid))}</td>
                    <td><span className="dd-ccy">{p3.currency ?? DASH}</span></td>
                    <td>{p3.sap_payment_doc ?? DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
