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
 *  Grouping key. SPEND CATEGORY since 22 Sep 2026, purchasing group before
 *  that. It is what a buyer recognises their own work by - a desk code says
 *  who files the work, a category says what it is - and it carries no personal
 *  data either, which created_by and requisitioner are explicitly marked as.
 *  It is the Executive Summary's category, resolved through the Material
 *  Master (migration 030), NOT the legacy mat_cat: the two have near-identical
 *  names and different values, and grouping by one while that page groups by
 *  the other is how the same slice comes to carry two totals.
 *
 *  Buyer view. There is no join from a login to a buyer today
 *  (core.dim_sap_user holds no email), so the Buyer lens asks which category
 *  once and remembers the answer, instead of guessing an identity mapping.
 *
 *  After delivery. Two cards count money owed on work already delivered. They
 *  are NOT stages: every stage here is undelivered work, and folding these in
 *  would break the property that an open line sits in exactly one stage and
 *  the stages sum to the total.
 */

/** Age bands, in the order the aging chart already uses. */
/**
 * Six colours, youngest to oldest (23 Sep 2026).
 *
 * The LABELS and KEYS are no longer here: they arrive in the summary, from the
 * one definition in @pct/rules that the SQL is also generated from. A page that
 * kept its own copy would eventually draw a bar labelled one way and filtered
 * another.
 */
const BAND_COLORS = [
  'var(--good)', 'var(--accent)', 'var(--warn)', 'var(--orange)', 'var(--crit)', 'var(--oi-late)',
];
/**
 * The filter value for each band, positionally aligned with the labels above.
 *
 * These strings are the server's whitelist (detail.ts AGE_BANDS). Keeping them
 * in the same order as the labels is what makes clicking the third segment open
 * the third band rather than something adjacent to it.
 */

interface StageRow {
  key: string; name: string; sub: string; count: number;
  bands: number[];
  pastSla: number; overLate: number; oldest: number | null;
  emergency: number; urgent: number; standard: number;
  prioUnset: number; standardLabels: string[];
  /** The detail filter that reproduces this card's own population. */
  detailFilter: Record<string, string>;
}
interface CategoryRow {
  desk: string; label: string; open: number; overLate: number;
  oldest: number | null; bands: number[];
  detailFilter: Record<string, string>;
}
interface MoneyCard extends StageRow {
  valueIdr: number | null;
  note: string | null;
}
interface MoneyCards {
  deliveredNotInvoiced: MoneyCard;
  invoicedNotPaid: MoneyCard;
  coupaCoverage: { unpaidInvoices: number; matchedInvoices: number } | null;
}
interface Summary {
  asOfDate: string; pastSlaDays: number; lateDays: number;
  bands: { key: string; label: string }[];
  stages: StageRow[]; categories: CategoryRow[]; money: MoneyCards;
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
// Renamed with the grouping. A remembered purchasing group is not a material
// category, and reusing the key would have selected nothing while looking like
// a saved preference.
const DESK_KEY = 'pct_openitems_category';

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

function AgeMixBar({ bands, total, labels, onBand }: {
  bands: readonly number[];
  total: number;
  /** When given, each segment opens that band's rows. */
  labels: string[];
  onBand?: (i: number, n: number) => void;
}) {
  if (total <= 0) return <div className="oi-mix oi-mix--empty" />;
  return (
    <div className="oi-mix" role={onBand ? 'group' : 'img'}
      aria-label={bands.map((n, i) => `${labels[i]}: ${n}`).join(', ')}>
      {bands.map((n, i) => (n > 0 ? (
        onBand ? (
          <button
            key={labels[i]}
            type="button"
            className="oi-mix-seg"
            style={{ width: `${(n / total) * 100}%`, background: BAND_COLORS[i] }}
            title={`${labels[i]}: ${formatNumber(n)} lines — click for the rows`}
            aria-label={`${labels[i]}: ${formatNumber(n)} lines`}
            onClick={() => onBand(i, n)}
          />
        ) : (
          <span
            key={labels[i]}
            style={{ width: `${(n / total) * 100}%`, background: BAND_COLORS[i] }}
            title={`${labels[i]}: ${formatNumber(n)} lines`}
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
  const [focus, setFocus] = useState<
    { id: string; label: string; init: Record<string, string>; exact?: boolean } | null
  >(null);

  /**
   * The chosen category, as a filter fragment.
   *
   * Requested 23 Sep 2026: choosing a category must narrow EVERY figure on the
   * page, not just the sentence at the top. It is expressed as a filter rather
   * than applied by hand per figure, so the stage cards, the watchlist, the
   * hygiene row, the after-delivery cards, the charts and the table below all
   * narrow through the one mechanism the rest of the app already uses - and a
   * figure that cannot honour it says so instead of quietly staying wide.
   */
  const catQuery = desk ? `spendCategory=${encodeURIComponent(desk)}` : '';
  const pageQuery = [filterQuery, catQuery].filter(Boolean).join('&');

  /**
   * `id` identifies the CARD, so the one that was clicked can be marked while
   * its rows are on screen - a filtered table two screens below an unmarked
   * card reads as though nothing was clicked.
   *
   * The chosen category is merged into every filter here rather than at each
   * call site: the page is narrowed to it, so a click that opened every
   * category would show more rows than the card counted.
   */
  const openRows = (
    label: string, init: Record<string, string>, exact = false, id = label,
  ) => {
    setFocus({
      id,
      label,
      init: { ...init, ...(desk ? { spendCategory: desk } : {}) },
      ...(exact ? { exact } : {}),
    });
    // A filter applied to a table two screens below the click is invisible, and
    // reads as nothing having happened. Defer a frame so the table has
    // re-rendered under its new key before we scroll to it.
    requestAnimationFrame(() => {
      document.getElementById('oi-rows')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  /**
   * A figure whose population the server states as a DRILL TOKEN.
   *
   * The KPI cards and the charts carry a token, not a set of filters, so they
   * cannot seed the table directly. The drill endpoint already translates a
   * token's predicate into detail-table parameters and reports what it could
   * not translate (detailHandoff), which is the same machinery v1's "Open in
   * Detail tab" used.
   *
   * So: an EXACT handoff opens the table below, which is what the reader asked
   * for. An approximate one falls back to the drill panel, which returns the
   * rows the figure was computed from with the parity the sweep checks. An
   * average or a rate has no row set to hand off at all, and lands there too.
   * Silently opening the table on an approximate handoff would put a number
   * next to the figure that does not match it.
   */
  const openRowsFromToken = async (token: string, label: string): Promise<void> => {
    try {
      const d = await api.get<{
        detailHandoff?: { params: Record<string, string>; unmapped: string[] } | null;
      }>(`/api/v1/drill/${token}?limit=1`);
      const h = d.detailHandoff;
      if (h && h.unmapped.length === 0 && Object.keys(h.params).length > 0) {
        // The category is part of the page's state, not the token's, so it is
        // merged in here - otherwise clicking a card while a category is chosen
        // would open the table on every category.
        openRows(label, h.params, true, token);
        return;
      }
    } catch {
      // fall through to the drill panel
    }
    onDrill(token, label);
  };

  useEffect(() => {
    let dead = false;
    setErr(null);
    api.get<Summary>(`/api/v1/openitems/summary${pageQuery ? `?${pageQuery}` : ''}`)
      .then((d) => { if (!dead) setSum(d); })
      .catch((e: Error) => { if (!dead) { setSum(null); setErr(e.message); } });
    return () => { dead = true; };
  }, [pageQuery]);

  /**
   * The page's KPI cards, recomputed under the chosen category.
   *
   * The parent fetches these under the GLOBAL filter, which is right until a
   * category is chosen here - then the watchlist and hygiene rows would be the
   * only figures on screen still describing the whole dataset. The ids come
   * from the prop rather than a second hard-coded list, so this cannot drift
   * from what the page actually renders.
   *
   * A KPI with no live recomputation path reports itself unavailable under the
   * filter, which is the existing behaviour of that endpoint and the right one:
   * a dash beats a number that silently ignores the narrowing.
   */
  const [catKpis, setCatKpis] = useState<Kpi[] | null>(null);
  const kpiIds = useMemo(() => (kpis ?? []).map((k) => k.kpiId).join(','), [kpis]);

  useEffect(() => {
    if (!catQuery || kpiIds === '') { setCatKpis(null); return undefined; }
    let dead = false;
    api.get<{ kpis: Kpi[] }>(`/api/v1/kpi?ids=${encodeURIComponent(kpiIds)}&${pageQuery}`)
      .then((d) => { if (!dead) setCatKpis(d.kpis); })
      .catch(() => { if (!dead) setCatKpis(null); });
    return () => { dead = true; };
  }, [catQuery, kpiIds, pageQuery]);

  const kpi = useMemo(() => {
    const m = new Map<string, Kpi>();
    for (const k of catKpis ?? kpis ?? []) m.set(k.kpiId, k);
    return m;
  }, [kpis, catKpis]);
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

  const deskRow = sum?.categories.find((d) => d.desk === desk) ?? null;
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
            {/* One figure, from the server, under whatever filter is set. It
                used to read the chosen category's row out of the category table
                while the rest of the page stayed wide; now the category is part
                of the query, so the page total IS the category's total and
                there is nothing to reconcile. */}
            <p className="oi-total">
              {formatNumber(sum.totalOpen)}{' '}
              <span>open lines{desk ? ` in ${desk}` : ''}</span>
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
            <strong>{formatNumber(deskRow.overLate)}</strong> of your {formatNumber(deskRow.open)} open
            lines have passed {sum.lateDays} days, and the oldest has been waiting{' '}
            <strong>{deskRow.oldest === null ? '—' : `${formatNumber(deskRow.oldest)} days`}</strong>.
          </p>
        ) : (
          <p className="oi-says">
            <strong>{formatNumber(sum.totalPastSla)}</strong> of them ({pctPast}%) are more than{' '}
            {sum.pastSlaDays} days old.
            {bottleneck && bottleneck.count > 0 && (
              <> The backlog sits mostly in one stage: <strong>{formatNumber(bottleneck.count)}</strong>{' '}
                in <strong>{bottleneck.name}</strong>, {formatNumber(bottleneck.overLate)} of which
                passed {sum.lateDays} days.</>
            )}
          </p>
        )}

        {/*
          Shown in EVERY lens since 23 Sep 2026, because it now narrows every
          figure on the page. A filter that changes all the numbers while its
          control is hidden on another lens is the worst of both: the reader
          cannot see why the totals moved, and cannot clear it.
        */}
        {(
          <p className="note oi-desk-pick">
            Material category:{' '}
            <select
              value={desk}
              onChange={(e) => { setDesk(e.target.value); store(DESK_KEY, e.target.value); }}
            >
              <option value="">— choose your category —</option>
              {sum.categories.map((d) => (
                <option key={d.desk} value={d.desk}>{d.desk}</option>
              ))}
            </select>{' '}
            {desk
              ? (
                <>
                  Every figure on this page — cards, charts and the table below — is{' '}
                  <strong>{desk}</strong> only.{' '}
                  <button className="dt-btn" onClick={() => { setDesk(''); store(DESK_KEY, ''); }}>
                    show all categories
                  </button>{' '}
                  The choice is remembered on this browser.
                </>
              )
              : lens === 'buyer'
                ? <>Pick a category to narrow the whole page. There is no link from a login to a
                   buyer in the dataset today, so the page asks rather than guesses.</>
                : <>Optional. Picking one narrows every figure on this page.</>}
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
        {/* The twin of the note on the Executive Summary's category panel. Both
            pages said "open lines" of two different populations, and the gap is
            large enough - 495 of 717 on one category - to read as a defect. */}
        <p className="note">
          <strong>An open item is any line in one of these stages</strong>, from the unapproved
          requisition to the partly delivered order — the same definition the sidebar count, the
          scope toggle and every drill use. The Executive Summary&apos;s delivered / not-yet-delivered
          split is order <em>value</em>, a different question, and does not count requisitions
          that have no order yet.
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

        {/*
          SEVEN cards from ONE list. The two post-delivery cards arrive from the
          server in the stage row's own shape - same measures, same age bands,
          same priority split - so they are drawn by this map rather than by a
          second block that would drift into a second design. They differ by a
          tag and a money figure, which is what actually differs about them.
        */}
        {/*
          One row, however many cards: the column count is the CARD count, set
          here rather than guessed in CSS. auto-fit chose the count from a
          minimum width, which put five across and wrapped the rest out of the
          row they belong to. Narrow screens still wrap - see .oi-pipe.
        */}
        <div
          className={showPipelineFull ? 'oi-pipe' : 'oi-pipe oi-pipe--compact'}
          style={{ ['--oi-cards' as string]: String(sum.stages.length + 2) }}
        >
          {([...sum.stages, sum.money.deliveredNotInvoiced, sum.money.invoicedNotPaid]
          ).map((s) => {
            const after = 'valueIdr' in s;
            const isBottleneck = bottleneck?.key === s.key && s.pastSla > 0;
            // Marked while its rows are the ones on screen. A filtered table two
            // screens below an unmarked card reads as if nothing was clicked.
            const isOn = focus?.id.startsWith(`stage:${s.key}`) ?? false;
            return (
              <div
                key={s.key}
                className={`oi-stage${isBottleneck ? ' oi-stage--hot' : ''}${isOn ? ' oi-stage--on' : ''}${after ? ' oi-stage--after' : ''}`}
              >
                <div className="oi-stage-h">
                  <span className="oi-stage-name">{s.name}</span>
                  {isBottleneck && <span className="oi-tag">Bottleneck</span>}
                  {after && <span className="oi-tag oi-tag--after">after delivery</span>}
                </div>
                <p className="oi-stage-n">
                  <button
                    type="button"
                    className="oi-num"
                    disabled={s.count === 0}
                    title={`Show the ${formatNumber(s.count)} ${s.name} lines in the table below`}
                    onClick={() => openRows(s.name, s.detailFilter, false, `stage:${s.key}`)}
                  >
                    {formatNumber(s.count)}
                  </button>
                  {/* The five stages print a share of open. The two after
                      delivery are not open lines, so the same slot carries the
                      money instead - same position, same weight, a measure that
                      is true of them. */}
                  <span className="muted">
                    {after
                      ? ` ${formatKpi((s as MoneyCard).valueIdr, 'idr')}`
                      : sum.totalOpen > 0
                        ? ` ${Math.round((s.count / sum.totalOpen) * 100)}% of open`
                        : ''}
                  </span>
                </p>
                {showPipelineFull && (
                  <>
                    <p className="oi-stage-sub">{s.sub}</p>
                    {after && (s as MoneyCard).note && (
                      <p className="oi-stage-note">
                        {(s as MoneyCard).note}
                        {s.key === 'invoicedNotPaid' && sum.money.coupaCoverage && (
                          <>
                            {' '}Coupa has{' '}
                            <strong>{formatNumber(sum.money.coupaCoverage.unpaidInvoices)}</strong>{' '}
                            unpaid invoices;{' '}
                            <strong>{formatNumber(sum.money.coupaCoverage.matchedInvoices)}</strong>{' '}
                            reach an order line here.
                          </>
                        )}
                      </p>
                    )}
                    <AgeMixBar
                      bands={s.bands}
                      total={s.count}
                      labels={sum.bands.map((b) => b.label)}
                      onBand={(i) => openRows(
                        `${s.name} · ${sum.bands[i]!.label}`,
                        { ...s.detailFilter, ageBand: sum.bands[i]!.key },
                        false,
                        `stage:${s.key}:band:${sum.bands[i]!.key}`,
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
                          false,
                          `stage:${s.key}:pastsla`,
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
                        onClick={() => { void openRowsFromToken(k.drillToken!, k.title); }}
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
                        onClick={() => {
                          void openRowsFromToken(kpi.get(id)!.drillToken!, kpi.get(id)!.title);
                        }}
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

      {/* ── backlog by material category ────────── */}
      {showDesks && (
        <div className="panel">
          <h3 className="pr-tbl-h">
            Backlog by material category{' '}
            <span className="muted">— sorted by lines over {sum.lateDays} days</span>
          </h3>
          <p className="note" style={{ marginTop: 0 }}>
            Grouped by what is being bought rather than by who files it. Requisition and order
            stages are counted together, because a category&apos;s open work is both.
          </p>
          <div className="table-wrap">
            <table className="data dd-tbl oi-desks">
              <thead>
                <tr>
                  <th>Material category</th><th>Age mix</th>
                  {/* num, like the cells beneath them: a left-aligned heading
                      over right-aligned figures leaves the label floating away
                      from its own column. */}
                  <th className="oi-c">Open</th>
                  <th className="oi-c">&gt; {sum.lateDays} d</th>
                  <th className="oi-c">Oldest</th>
                </tr>
              </thead>
              <tbody>
                {sum.categories.map((d) => (
                  <tr key={d.desk}>
                    <th scope="row">
                      <strong>{d.label}</strong>
                    </th>
                    <td className="oi-desk-mix">
                      <AgeMixBar
                        bands={d.bands}
                        total={d.open}
                        labels={sum.bands.map((b) => b.label)}
                        onBand={Object.keys(d.detailFilter).length === 0 ? undefined : (i) => openRows(
                          `${d.desk} · ${sum.bands[i]!.label}`,
                          { ...d.detailFilter, ageBand: sum.bands[i]!.key },
                          false,
                          `cat:${d.desk}:band:${sum.bands[i]!.key}`,
                        )}
                      />
                    </td>
                    <td className="oi-c">
                      <button
                        type="button"
                        className="oi-num oi-num--sm"
                        title={`Show the ${formatNumber(d.open)} open lines in ${d.desk}`}
                        disabled={Object.keys(d.detailFilter).length === 0}
                        onClick={() => openRows(d.desk, d.detailFilter, false, `cat:${d.desk}`)}
                      >
                        {formatNumber(d.open)}
                      </button>
                    </td>
                    <td className="oi-c">
                      <button
                        type="button"
                        className="oi-num oi-num--sm"
                        style={{ color: d.overLate > 0 ? 'var(--crit)' : undefined }}
                        title={`Show the ${formatNumber(d.overLate)} lines over ${sum.lateDays} days in ${d.desk}`}
                        disabled={d.overLate === 0 || Object.keys(d.detailFilter).length === 0}
                        onClick={() => openRows(
                          `${d.desk} · over ${sum.lateDays} d`,
                          { ...d.detailFilter, ageBand: '>150' },
                          false,
                          `cat:${d.desk}:late`,
                        )}
                      >
                        {formatNumber(d.overLate)}
                      </button>
                    </td>
                    <td className="oi-c" style={{ color: d.oldest === null ? undefined : ageColor(d.oldest) }}>
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
                  {/* pageQuery, not filterQuery: the chart narrows with the
                      chosen category like everything else. onDrill routes
                      through the handoff, so a bar click lands in the table
                      below when its predicate can be expressed there. */}
                  <ChartPanel
                    chartId={c}
                    onDrill={(t, l) => { void openRowsFromToken(t, l); }}
                    filterQuery={pageQuery}
                    currency={currency}
                  />
                </Suspense>
              ))}
            </div>
            {/* Management alone gets the direction question. */}
            {lens === 'mgmt' && (
              <Suspense fallback={<div className="panel" style={{ minHeight: 180 }}><div className="spinner" /></div>}>
                <ChartPanel
                  chartId="open_backlog_by_month"
                  onDrill={(t, l) => { void openRowsFromToken(t, l); }}
                  filterQuery={pageQuery}
                  currency={currency}
                />
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
                // An exact handoff is the figure's OWN population, which is not
                // always the five open stages - imposing them on top would open
                // a table whose count is smaller than the number clicked.
                ? (focus.exact ? focus.init : { ...sum.detailFilter, ...focus.init })
                : lens === 'buyer' && desk
                  // spendCategory, not purchGroup. The picker changed dimension
                  // on 22 Sep and this seed did not, so choosing a category
                  // filtered the table by a purchasing group of that name -
                  // which matches nothing, and the table came back empty under
                  // a banner saying it had been pre-filtered.
                  ? { ...sum.detailFilter, spendCategory: desk }
                  : sum.detailFilter
            }
            initialLabel={
              focus
                ? focus.label
                : lens === 'buyer' && desk ? `Open items in ${desk}` : 'Open items only'
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
