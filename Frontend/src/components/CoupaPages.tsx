import { useEffect, useRef, useState } from 'react';
import {
  BarController, BarElement, CategoryScale, Chart as ChartJS, Legend, LinearScale, Tooltip,
} from 'chart.js';
import { api } from '../lib/api';
import { DASH, formatNumber } from '../lib/format';
import { Lbl } from '../lib/labels';
import { FloatControls } from './FloatControls';

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
  /** Vendor Type filter (19 Nov 2026): '' = all, else Local (LN…) / Import (IN…). */
  const [vtype, setVtype] = useState<'' | 'local' | 'import'>('');
  /** The event whose supplier comparison is open. */
  const [compare, setCompare] = useState<number | null>(null);
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
      <div className="kpi-grid" style={{ marginBottom: '1rem' }}>
        <Kpi v={formatNumber(Number(k.events ?? 0))} label="Sourcing events" sub={vtype ? `with a ${vtype === 'local' ? 'Local' : 'Import'} bid` : 'excluding templates'} />
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
          <h3 className="pr-tbl-h"><Lbl>Awarded spend by commodity — IDR documents</Lbl></h3>
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
          <h3 className="pr-tbl-h"><Lbl>Awarded spend by supplier — top 12, IDR documents</Lbl></h3>
          <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead><tr><th>Supplier</th><th className="num">Awarded bids</th><th className="num">Amount (M IDR)</th></tr></thead>
              <tbody>
                {(d.bySupplier ?? []).length === 0 && <tr><td colSpan={3} className="muted">No awarded bids yet.</td></tr>}
                {(d.bySupplier ?? []).map((c: any, i: number) => (
                  <tr key={c.supplier_name} className={i % 2 ? '' : 're'}>
                    <td>{c.supplier_name} <VendorTypeBadge t={c.vendor_type} /></td>
                    <td className="num">{formatNumber(c.awarded_bids)}{c.other_ccy > 0 ? <span className="muted" title={`${c.other_ccy} non-IDR bids not in the amount`}> ⚠</span> : null}</td>
                    <td className="num">{M(c.amount_idr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <EventPipeline pipeline={d.pipeline ?? []} bids={b} events={Number(k.events ?? 0)} />
      </div>

      <div className="panel" style={{ marginTop: '1rem' }}>
        <h3 className="pr-tbl-h"><Lbl>Sourcing data table</Lbl> <span className="muted">— newest 200 supplier bids · click an event or its bid count to compare the suppliers</span></h3>
        <div className="table-wrap dt-scroll">
          <table className="data dd-tbl">
            <thead>
              <tr>
                <th>Event</th><th>Type</th><th>State</th><th>Commodity</th><th>Description</th>
                <th>SAP PR</th><th>Supplier</th><th>Vendor Type</th><th className="num">Bids</th><th>Awarded</th><th>Submitted</th>
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
                  <td>{r2.sap_pr_no ?? DASH}</td>
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
      {compare !== null && <SourcingCompareModal eventId={compare} onClose={() => setCompare(null)} />}
    </>
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

function EventPipeline({ pipeline, bids, events }: {
  pipeline: { stage: string; events: number; with_bids: number; awarded: number }[];
  bids: Record<string, any>;
  events: number;
}) {
  const by = new Map(pipeline.map((p) => [p.stage, p]));
  const rows = STAGES.filter((s2) => (by.get(s2.key)?.events ?? 0) > 0);
  const max = Math.max(1, ...rows.map((s2) => by.get(s2.key)!.events));
  const funnel = [
    { label: 'Events', v: events },
    { label: 'Events with a bid', v: Number(bids.events_with_bids ?? 0) },
    { label: 'Bids submitted', v: Number(bids.responses ?? 0) },
    { label: 'Bids awarded', v: Number(bids.awarded ?? 0) },
  ];
  return (
    <div className="panel">
      <h3 className="pr-tbl-h"><Lbl>Event pipeline</Lbl> <span className="muted">— events by stage</span></h3>
      {rows.length === 0 && <p className="note">No sourcing events in this view.</p>}
      <div className="src-pipe">
        {rows.map((s2) => {
          const p = by.get(s2.key)!;
          return (
            <div key={s2.key} className="src-pipe-row" title={s2.hint}>
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
          <div key={f.label} className="src-funnel-step">
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
                {ev.sap_pr_no ? ` · SAP PR ${ev.sap_pr_no}` : ''}
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

export function CoupaInvoicesTab() {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
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
          <h3 className="pr-tbl-h"><Lbl>Top suppliers by invoiced value — IDR documents</Lbl></h3>
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
          <h3 className="pr-tbl-h"><Lbl>Invoice status mix</Lbl></h3>
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
          <h3 className="pr-tbl-h"><Lbl>Recent invoices</Lbl> <span className="muted">— newest 50</span></h3>
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
          <h3 className="pr-tbl-h"><Lbl>Recent payments</Lbl> <span className="muted">— newest 50</span></h3>
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
