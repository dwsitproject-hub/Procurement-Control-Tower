import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { api, type Finding, type Kpi } from '../lib/api';
import { formatKpi, formatNumber } from '../lib/format';
import { DetailTable } from './DetailTable';

const ChartPanel = lazy(() => import('./Chart').then((m) => ({ default: m.ChartPanel })));

/**
 * Open Items — the stage-pipeline redesign.
 *
 * Built from the design spec of 16 Sep 2026, which replaced a wall of fifteen
 * equal-weight tiles with a reading order: a sentence saying where the backlog
 * is, a five-stage pipeline carrying its own aging, and the remaining figures
 * demoted to a watchlist strip and a one-line hygiene bar. Nothing was dropped
 * — every one of the fifteen is still on the page.
 *
 * ── Three decisions taken at build time ─────────────────────────────────────
 *
 * The spec left three questions open and they were answered before this was
 * written:
 *
 *  SLA boundary. Policy is approval within 3 days; the dataset's smallest age
 *  band is 15 days. The page reads "past SLA" at 15 days and SAYS SO, rather
 *  than printing a 3-day figure the banded data cannot support.
 *
 *  Desk key. Purchasing group, not buyer name — it is on both facts, has a
 *  description in dim_purch_group, and carries no personal data, which
 *  created_by and requisitioner are explicitly marked as.
 *
 *  Buyer view. There is no join from a login to a buyer today
 *  (core.dim_sap_user holds no email), so the Buyer lens asks which desk once
 *  and remembers the answer, instead of guessing an identity mapping.
 */

/** Age bands, in the order the aging chart already uses. */
const BAND_LABELS = ['0-15 d', '16-30 d', '31-90 d', 'over 90 d'];
const BAND_COLORS = ['var(--accent)', 'var(--warn)', 'var(--orange)', 'var(--crit)'];
/**
 * The filter value for each band, positionally aligned with the labels above.
 *
 * These strings are the server's whitelist (detail.ts AGE_BANDS). Keeping them
 * in the same order as the labels is what makes clicking the third segment open
 * the third band rather than something adjacent to it.
 */
const BAND_KEYS = ['0-15', '16-30', '31-90', '>90'];

interface StageRow {
  key: string; name: string; sub: string; count: number;
  bands: [number, number, number, number];
  pastSla: number; oldest: number | null;
  emergency: number; urgent: number; standard: number;
  prioUnset: number; standardLabels: string[];
  /** The detail filter that reproduces this card's own population. */
  detailFilter: Record<string, string>;
}
interface DeskRow {
  desk: string; label: string; open: number; over90: number;
  oldest: number | null; bands: [number, number, number, number];
  detailFilter: Record<string, string>;
}
interface Summary {
  asOfDate: string; pastSlaDays: number;
  stages: StageRow[]; desks: DeskRow[];
  totalOpen: number; totalPastSla: number;
  /** The filter for every open line this page counts. */
  detailFilter: Record<string, string>;
  /** Parts of the global filter this page could not apply. Usually empty. */
  filterIgnored?: string[];
}

type Lens = 'buyer' | 'lead' | 'mgmt';
const LENSES: { id: Lens; label: string; blurb: string }[] = [
  { id: 'buyer', label: 'Buyer', blurb: 'what do I clear today' },
  { id: 'lead', label: 'Team lead', blurb: 'where is my team stuck' },
  { id: 'mgmt', label: 'Management', blurb: 'is this getting better or worse' },
];

const LENS_KEY = 'pct_openitems_lens';
const DESK_KEY = 'pct_openitems_desk';

/** localStorage, defensively: a private window or blocked site data must not
    take the page down with it. */
function stored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function store(key: string, v: string): void {
  try { window.localStorage.setItem(key, v); } catch { /* not worth reporting */ }
}

/** The age colour rule, stated once. */
function ageColor(days: number): string {
  return days > 90 ? 'var(--crit)' : days > 30 ? 'var(--orange)' : days > 15 ? 'var(--warn)' : 'var(--accent)';
}

function AgeMixBar({ bands, total, onBand }: {
  bands: readonly number[];
  total: number;
  /** When given, each segment opens that band's rows. */
  onBand?: (i: number, n: number) => void;
}) {
  if (total <= 0) return <div className="oi-mix oi-mix--empty" />;
  return (
    <div className="oi-mix" role={onBand ? 'group' : 'img'}
      aria-label={bands.map((n, i) => `${BAND_LABELS[i]}: ${n}`).join(', ')}>
      {bands.map((n, i) => (n > 0 ? (
        onBand ? (
          <button
            key={BAND_LABELS[i]}
            type="button"
            className="oi-mix-seg"
            style={{ width: `${(n / total) * 100}%`, background: BAND_COLORS[i] }}
            title={`${BAND_LABELS[i]}: ${formatNumber(n)} lines — click for the rows`}
            aria-label={`${BAND_LABELS[i]}: ${formatNumber(n)} lines`}
            onClick={() => onBand(i, n)}
          />
        ) : (
          <span
            key={BAND_LABELS[i]}
            style={{ width: `${(n / total) * 100}%`, background: BAND_COLORS[i] }}
            title={`${BAND_LABELS[i]}: ${formatNumber(n)} lines`}
          />
        )
      ) : null))}
    </div>
  );
}

export function OpenItemsTab({
  kpis, findings, onDrill, currency, asOfDate, filterQuery,
}: {
  kpis: Kpi[] | null;
  findings: Finding[];
  onDrill: (token: string, label: string) => void;
  currency: 'USD' | 'IDR';
  asOfDate: string | null;
  filterQuery: string;
}) {
  const [sum, setSum] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>(() => {
    const s = stored(LENS_KEY);
    return s === 'buyer' || s === 'lead' || s === 'mgmt' ? s : 'lead';
  });
  const [desk, setDesk] = useState<string>(() => stored(DESK_KEY) ?? '');
  const [showCharts, setShowCharts] = useState(false);

  /**
   * What the reader last clicked, and the filter that reproduces it.
   *
   * Every figure on a stage card is a button, and clicking one narrows the
   * detail table at the bottom of the page rather than opening a modal — the
   * rows are already on the page, so the useful move is to point the table at
   * them.
   *
   * The filter always starts from the card's OWN detailFilter, which the server
   * states, so the table's row count matches the number that was clicked
   * instead of approximating it.
   */
  const [focus, setFocus] = useState<{ label: string; init: Record<string, string> } | null>(null);

  const openRows = (label: string, init: Record<string, string>) => {
    setFocus({ label, init });
    // A filter applied to a table two screens below the click is invisible, and
    // reads as nothing having happened. Defer a frame so the table has
    // re-rendered under its new key before we scroll to it.
    requestAnimationFrame(() => {
      document.getElementById('oi-rows')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  useEffect(() => {
    let dead = false;
    setErr(null);
    api.get<Summary>(`/api/v1/openitems/summary${filterQuery ? `?${filterQuery}` : ''}`)
      .then((d) => { if (!dead) setSum(d); })
      .catch((e: Error) => { if (!dead) { setSum(null); setErr(e.message); } });
    return () => { dead = true; };
  }, [filterQuery]);

  const kpi = useMemo(() => {
    const m = new Map<string, Kpi>();
    for (const k of kpis ?? []) m.set(k.kpiId, k);
    return m;
  }, [kpis]);
  const kval = (id: string): string => {
    const k = kpi.get(id);
    return k && k.status === 'ok' && k.value !== null ? formatKpi(k.value, k.unit) : '—';
  };

  const caveat = findings.find((f) => f.ruleId === 'V-B04');

  /**
   * The bottleneck is DERIVED, never assigned: the stage holding the most
   * lines past the SLA boundary. An acceptance criterion of the spec, and the
   * reason the headline sentence can be trusted — it cannot praise one stage
   * while the tag sits on another.
   */
  const bottleneck = useMemo(() => {
    if (!sum) return null;
    return sum.stages.reduce<StageRow | null>(
      (best, s) => (best === null || s.pastSla > best.pastSla ? s : best), null,
    );
  }, [sum]);

  const deskRow = sum?.desks.find((d) => d.desk === desk) ?? null;
  const pctPast = sum && sum.totalOpen > 0 ? Math.round((sum.totalPastSla / sum.totalOpen) * 100) : 0;

  if (err) {
    return <div className="panel"><h2>Open Items</h2><p className="err">{err}</p></div>;
  }
  if (!sum) {
    return <div className="panel" style={{ minHeight: 200 }}><div className="spinner" /></div>;
  }

  const showPipelineFull = lens !== 'buyer';
  const showSideFigures = lens !== 'buyer';
  const showDesks = lens !== 'buyer';
  const showTable = lens !== 'mgmt';

  return (
    <>
      {/* ── headline ───────────────────────────────────────────────── */}
      <div className="panel oi-head">
        <div className="oi-head-row">
          <div>
            <p className="oi-asof">Data as of {asOfDate ?? '—'}</p>
            <p className="oi-total">
              {formatNumber(lens === 'buyer' && deskRow ? deskRow.open : sum.totalOpen)}{' '}
              <span>open lines{lens === 'buyer' && deskRow ? ` on ${deskRow.desk}` : ''}</span>
            </p>
          </div>
          <span className="spacer" />
          <div className="oi-lens" role="group" aria-label="Reading as">
            <span className="muted">Reading as</span>
            {LENSES.map((l) => (
              <button
                key={l.id}
                type="button"
                className={lens === l.id ? 'on' : ''}
                aria-pressed={lens === l.id}
                title={l.blurb}
                onClick={() => { setLens(l.id); store(LENS_KEY, l.id); }}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>

        {/*
          The conclusion, in words. Every number in it is computed from the
          same figures the cards below show — an acceptance criterion of the
          spec, and the difference between a sentence and a caption.
        */}
        {lens === 'buyer' && deskRow ? (
          <p className="oi-says">
            <strong>{formatNumber(deskRow.over90)}</strong> of your {formatNumber(deskRow.open)} open
            lines have passed 90 days, and the oldest has been waiting{' '}
            <strong>{deskRow.oldest === null ? '—' : `${formatNumber(deskRow.oldest)} days`}</strong>.
          </p>
        ) : (
          <p className="oi-says">
            <strong>{formatNumber(sum.totalPastSla)}</strong> of them ({pctPast}%) are more than{' '}
            {sum.pastSlaDays} days old.
            {bottleneck && bottleneck.count > 0 && (
              <> The backlog sits mostly in one stage: <strong>{formatNumber(bottleneck.count)}</strong>{' '}
                in <strong>{bottleneck.name}</strong>, {formatNumber(bottleneck.bands[3])} of which passed 90 days.</>
            )}
          </p>
        )}

        {lens === 'buyer' && (
          <p className="note oi-desk-pick">
            Desk:{' '}
            <select
              value={desk}
              onChange={(e) => { setDesk(e.target.value); store(DESK_KEY, e.target.value); }}
            >
              <option value="">— choose your desk —</option>
              {sum.desks.map((d) => (
                <option key={d.desk} value={d.desk}>{d.desk} · {d.label}</option>
              ))}
            </select>{' '}
            {desk
              ? <>Showing <strong>{desk}</strong> only. This is remembered on this browser.</>
              : <>Pick a desk to filter this page. There is no link from a login to a buyer in the
                 dataset today, so the page asks rather than guesses.</>}
          </p>
        )}
      </div>

      {/* ── caveat, one line ───────────────────────────────────────── */}
      {caveat && (
        <p className="oi-caveat">
          <span className={`sev sev-${caveat.severity}`}>{caveat.severity}</span> {caveat.message}
        </p>
      )}

      {/* ── stage pipeline ─────────────────────────────────────────── */}
      <div className="panel">
        <h3 className="pr-tbl-h">
          Where the backlog sits{' '}
          <span className="muted">— an open line sits in exactly one stage</span>
        </h3>
        <p className="note" style={{ marginTop: 0 }}>
          Past-SLA counts are read at the dataset&apos;s {sum.pastSlaDays}-day age boundary. The
          approval policy is 3 days, which the banded data cannot express — so this is the closest
          honest line, and it is labelled rather than presented as the policy figure.
        </p>
        {/* An active filter this page cannot express. Said here, beside the
            figures it would have narrowed, rather than left for the reader to
            infer from a total that looks too big. */}
        {(sum.filterIgnored?.length ?? 0) > 0 && (
          <p className="note">
            <span className="bs spdel">filter</span>{' '}
            These figures ignore the {sum.filterIgnored!.join(' and ')} filter: the detail view
            behind this page does not carry {sum.filterIgnored!.length > 1 ? 'those dimensions' : 'that dimension'}.
            Everything else in the filter bar is applied.
          </p>
        )}

        <div className={showPipelineFull ? 'oi-pipe' : 'oi-pipe oi-pipe--compact'}>
          {sum.stages.map((s) => {
            const isBottleneck = bottleneck?.key === s.key && s.pastSla > 0;
            return (
              <div key={s.key} className={`oi-stage${isBottleneck ? ' oi-stage--hot' : ''}`}>
                <div className="oi-stage-h">
                  <span className="oi-stage-name">{s.name}</span>
                  {isBottleneck && <span className="oi-tag">Bottleneck</span>}
                </div>
                <p className="oi-stage-n">
                  <button
                    type="button"
                    className="oi-num"
                    disabled={s.count === 0}
                    title={`Show the ${formatNumber(s.count)} ${s.name} lines in the table below`}
                    onClick={() => openRows(s.name, s.detailFilter)}
                  >
                    {formatNumber(s.count)}
                  </button>
                  <span className="muted">
                    {sum.totalOpen > 0 ? ` ${Math.round((s.count / sum.totalOpen) * 100)}% of open` : ''}
                  </span>
                </p>
                {showPipelineFull && (
                  <>
                    <p className="oi-stage-sub">{s.sub}</p>
                    <AgeMixBar
                      bands={s.bands}
                      total={s.count}
                      onBand={(i) => openRows(
                        `${s.name} · ${BAND_LABELS[i]}`,
                        { ...s.detailFilter, ageBand: BAND_KEYS[i]! },
                      )}
                    />
                    <p className="oi-stage-foot">
                      <button
                        type="button"
                        className="oi-num oi-num--sm"
                        disabled={s.pastSla === 0}
                        style={{ color: s.pastSla > 0 ? 'var(--crit)' : 'inherit' }}
                        title={`Show the ${formatNumber(s.pastSla)} lines past ${sum.pastSlaDays} days`}
                        onClick={() => openRows(
                          `${s.name} · past ${sum.pastSlaDays} d`,
                          { ...s.detailFilter, ageBand: 'past-sla' },
                        )}
                      >
                        {formatNumber(s.pastSla)} past {sum.pastSlaDays} d
                        {s.count > 0 ? ` (${Math.round((s.pastSla / s.count) * 100)}%)` : ''}
                      </button>
                      <span className="muted">
                        oldest {s.oldest === null ? '—' : `${formatNumber(s.oldest)} d`}
                      </span>
                    </p>
                    <p className="oi-stage-prio">
                      {([
                        ['emergency', s.emergency, 'var(--crit)', '01-Emergency'],
                        ['urgent', s.urgent, 'var(--orange)', '02-Urgent'],
                        // The catch-all bucket filters by the labels the server
                        // says it counted, not by a guess at what "standard"
                        // means — a priority code nobody has seen yet would
                        // otherwise be counted here and missing from the rows.
                        ['standard', s.standard, 'var(--accent)', s.standardLabels.join(',')],
                        // An order with no requisition has no priority. Counted
                        // so the four add up, not clickable because the filter
                        // cannot ask for null — see openitems.ts.
                        ...(s.prioUnset > 0
                          ? [['not set', s.prioUnset, 'var(--muted)', ''] as const]
                          : []),
                      ] as const).map(([label, n, color, prio]) => (
                        <button
                          key={label}
                          type="button"
                          className="oi-num oi-num--sm"
                          disabled={n === 0 || prio === ''}
                          title={`Show the ${formatNumber(n)} ${label} lines in ${s.name}`}
                          onClick={() => openRows(
                            `${s.name} · ${label}`,
                            { ...s.detailFilter, priority: prio },
                          )}
                        >
                          <i style={{ background: color }} />{formatNumber(n)} {label}
                        </button>
                      ))}
                    </p>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── watchlist ──────────────────────────────────────────────── */}
      {showSideFigures && (
        <div className="panel">
          <h3 className="pr-tbl-h">Watchlist</h3>
          <div className="oi-watch">
            {[
              { id: 'emergency_open', note: 'Flagged emergency and still open — every one is already past the approval rule.' },
              { id: 'urgent_open', note: 'Carrying an urgent priority and still waiting.' },
              { id: 'avg_unreleased_age', note: 'How long the average unreleased requisition has been waiting.' },
              { id: 'retro_po_rate', note: 'Orders raised before their requisition — the control was applied after the fact.' },
            ].map((w) => {
              const k = kpi.get(w.id);
              return (
                <div key={w.id} className="oi-watch-card">
                  {/*
                    The watchlist figures do NOT filter the table. Three of the
                    four are an average or a rate — there is no set of detail
                    rows that "329 days" or "5.7%" selects. Their KPI drill
                    token opens exactly the rows the figure was computed from,
                    with the parity the sweep checks, so that is what a click
                    does here. A figure without a token is not a button.
                  */}
                  <p className="oi-watch-v">
                    {k?.drillToken ? (
                      <button
                        type="button"
                        className="oi-num"
                        title={`Show the rows behind ${k.title}`}
                        onClick={() => onDrill(k.drillToken!, k.title)}
                      >
                        {kval(w.id)}
                      </button>
                    ) : kval(w.id)}
                  </p>
                  <p className="oi-watch-l">{k?.title ?? w.id}</p>
                  <p className="oi-watch-n">{w.note}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── hygiene, one row ───────────────────────────────────────── */}
      {showSideFigures && (
        <div className="panel oi-hyg-panel">
          <h3 className="pr-tbl-h">Compliance &amp; hygiene</h3>
          <div className="oi-hyg">
            {['open_pr_no_wbs', 'open_pr_with_wbs', 'commitment_over_60d', 'urgent_po_before_pr', 'po_hold']
              .map((id) => (
                <div key={id} className="oi-hyg-item">
                  <span className="oi-hyg-v">
                    {kpi.get(id)?.drillToken ? (
                      <button
                        type="button"
                        className="oi-num oi-num--sm"
                        title={`Show the rows behind ${kpi.get(id)!.title}`}
                        onClick={() => onDrill(kpi.get(id)!.drillToken!, kpi.get(id)!.title)}
                      >
                        {kval(id)}
                      </button>
                    ) : kval(id)}
                  </span>
                  <span className="oi-hyg-l">{kpi.get(id)?.title ?? id}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* ── backlog by desk ────────────────────────────────────────── */}
      {showDesks && (
        <div className="panel">
          <h3 className="pr-tbl-h">
            Backlog by purchasing group{' '}
            <span className="muted">— sorted by lines over 90 days</span>
          </h3>
          <p className="note" style={{ marginTop: 0 }}>
            Grouped by purchasing group rather than by buyer: it is the desk the work belongs to,
            and it carries no personal data. Requisition and order stages are counted together,
            because a desk&apos;s open work is both.
          </p>
          <div className="table-wrap">
            <table className="data dd-tbl oi-desks">
              <thead>
                <tr>
                  <th>Desk</th><th>Age mix</th>
                  <th className="num">Open</th><th className="num">&gt; 90 d</th><th className="num">Oldest</th>
                </tr>
              </thead>
              <tbody>
                {sum.desks.map((d) => (
                  <tr key={d.desk}>
                    <th scope="row">
                      <strong>{d.desk}</strong> <span className="muted">{d.label}</span>
                    </th>
                    <td className="oi-desk-mix">
                      <AgeMixBar
                        bands={d.bands}
                        total={d.open}
                        onBand={Object.keys(d.detailFilter).length === 0 ? undefined : (i) => openRows(
                          `${d.desk} · ${BAND_LABELS[i]}`,
                          { ...d.detailFilter, ageBand: BAND_KEYS[i]! },
                        )}
                      />
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className="oi-num oi-num--sm"
                        title={`Show the ${formatNumber(d.open)} open lines on ${d.desk}`}
                        disabled={Object.keys(d.detailFilter).length === 0}
                        onClick={() => openRows(d.desk, d.detailFilter)}
                      >
                        {formatNumber(d.open)}
                      </button>
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className="oi-num oi-num--sm"
                        style={{ color: d.over90 > 0 ? 'var(--crit)' : undefined }}
                        title={`Show the ${formatNumber(d.over90)} lines over 90 days on ${d.desk}`}
                        disabled={d.over90 === 0 || Object.keys(d.detailFilter).length === 0}
                        onClick={() => openRows(
                          `${d.desk} · over 90 d`,
                          { ...d.detailFilter, ageBand: '>90' },
                        )}
                      >
                        {formatNumber(d.over90)}
                      </button>
                    </td>
                    <td className="num" style={{ color: d.oldest === null ? undefined : ageColor(d.oldest) }}>
                      {d.oldest === null ? '—' : `${formatNumber(d.oldest)} d`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── charts ─────────────────────────────────────────────────── */}
      {lens !== 'buyer' && (
        lens === 'lead' && !showCharts ? (
          <p className="note">
            <button className="dt-btn" onClick={() => setShowCharts(true)}>Show charts</button>{' '}
            Five aging and mix charts, hidden by default in this view so the desk table is what you
            land on.
          </p>
        ) : (
          <>
            {lens === 'lead' && (
              <p className="note">
                <button className="dt-btn" onClick={() => setShowCharts(false)}>Hide charts</button>
              </p>
            )}
            <div className="chart-grid">
              {['aging_severity_by_stage', 'aging_bands', 'open_by_priority',
                'unapproved_by_category', 'unreleased_aging_buckets'].map((c) => (
                <Suspense key={c} fallback={<div className="panel" style={{ minHeight: 180 }}><div className="spinner" /></div>}>
                  <ChartPanel chartId={c} onDrill={onDrill} filterQuery={filterQuery} currency={currency} />
                </Suspense>
              ))}
            </div>
            {/* Management alone gets the direction question. */}
            {lens === 'mgmt' && (
              <Suspense fallback={<div className="panel" style={{ minHeight: 180 }}><div className="spinner" /></div>}>
                <ChartPanel chartId="open_backlog_by_month" onDrill={onDrill} filterQuery={filterQuery} currency={currency} />
              </Suspense>
            )}
          </>
        )
      )}

      {/* ── the rows ───────────────────────────────────────────────── */}
      {showTable ? (
        <div id="oi-rows" style={{ marginTop: '1rem' }}>
          {focus && (
            <p className="note oi-focus">
              Showing <strong>{focus.label}</strong>{' '}
              <button className="dt-btn" onClick={() => setFocus(null)}>
                show all open items
              </button>
            </p>
          )}
          <DetailTable
            /*
              The key carries the focus, so a click REMOUNTS the table with the
              new filter. DetailTable takes `initial` as a seed for its own
              state — changing the prop alone would leave the old filter in
              place and the click would appear to do nothing.
            */
            key={`openitems-detail-${focus ? JSON.stringify(focus.init) : lens === 'buyer' ? desk || 'all' : 'all'}`}
            /*
              The default table shows the SAME population the pipeline counts —
              the five stage statuses — not the wider `onlyOpen` list, which
              also holds Partially Delivered. Otherwise the headline total and
              the row count under the table disagree on the page's own
              definition of an open item.
            */
            initial={
              focus
                ? { ...sum.detailFilter, ...focus.init }
                : lens === 'buyer' && desk
                  ? { ...sum.detailFilter, purchGroup: desk }
                  : sum.detailFilter
            }
            initialLabel={
              focus
                ? focus.label
                : lens === 'buyer' && desk ? `Open items on ${desk}` : 'Open items only'
            }
          />
        </div>
      ) : (
        <p className="note">
          Row-level detail is not shown in the Management view.{' '}
          <a href="/detail-table">Open in the Detail table →</a>
        </p>
      )}
    </>
  );
}
