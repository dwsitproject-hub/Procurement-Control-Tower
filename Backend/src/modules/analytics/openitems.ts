/**
 * Open Items — the stage pipeline and the desk table.
 *
 * Design spec: "Open Items — page redesign", 16 Sep 2026.
 *
 * ── Counted over core.v_detail, on purpose ──────────────────────────────────
 *
 * The first version of this module counted core.fact_pr_item and
 * core.fact_po_line. It was rewritten on 17 Sep 2026, when every figure on a
 * card became clickable and so had to open the rows behind it: the table those
 * clicks filter is v_detail, and the facts are NOT the same population.
 *
 *   v_detail is PR x PO grain — one requisition with two order lines is two
 *   rows — while fact_po_line is one row per order line;
 *
 *   its `status` is COALESCE(pol.status, pri.status), which is exactly "the
 *   stage this line is in", and the whole pipeline is built on that idea;
 *
 *   its `p_cat` is the REQUISITION's priority, and is null for an order that
 *   never had a requisition.
 *
 * Counting the facts while filtering the view disagreed by 156 rows on "PO not
 * delivered" and by 2,513 on the largest desk: small enough to look like
 * rounding, large enough to make a reader stop trusting the page. The cards now
 * count the rows the table shows, so a click returns the number that was
 * clicked by construction rather than by coincidence.
 *
 * Two consequences worth stating. STO lines are INCLUDED, because the detail
 * table includes them by default and its "Exclude STO" toggle belongs to the
 * reader. Deleted requisitions are excluded, because the table excludes them by
 * default.
 *
 * ── The SLA boundary ────────────────────────────────────────────────────────
 *
 * Policy is approval within 3 days; the dataset's smallest age band is 15 days.
 * The decision taken for this build is to read "past SLA" at 15 days and SAY SO
 * on screen, rather than print a 3-day figure the banded data cannot support.
 * PAST_SLA_DAYS is the one place that choice lives.
 */

import { query } from '../../db/client.js';
import {
  DETAIL_SCOPE_COLUMNS, mintScopedQuery, scopeSql, type ScopeEntry,
} from '../authz/scope.js';
import { MONEY_STATE_SQL } from './detail.js';
import type { GlobalFilter } from './globalfilter.js';

/** The age boundary this page reads "past SLA" at. See the header. */
export const PAST_SLA_DAYS = 15;

/**
 * The five stages, in pipeline order.
 *
 * An open line sits in exactly one of them: v_detail.status holds one value per
 * row, so the statuses are disjoint by construction and the page can say so
 * without qualification.
 */
export const OPEN_STAGES = [
  { key: 'pr_not_approved', name: 'PR not approved', sub: 'Waiting on requisition release', status: 'Unapproved PR' },
  { key: 'pr_no_po', name: 'PR approved, no PO', sub: 'Released but no order raised', status: 'PR Approved-No PO' },
  { key: 'po_pending_approval', name: 'PO pending approval', sub: 'Order awaiting release', status: 'PO-Not Approved' },
  { key: 'po_hold', name: 'PO on hold', sub: 'Blocked by buyer or requester', status: 'HOLD PO' },
  { key: 'po_not_delivered', name: 'PO not delivered', sub: 'Ordered, no goods receipt', status: 'PO-No GR' },
] as const;

/** Every stage status, for the filter that reproduces the whole pipeline. */
const ALL_STAGE_STATUSES = OPEN_STAGES.map((s) => s.status).join(',');

/** The priority values a click on the `standard` figure filters by. */
const STANDARD_LABELS = ['03-Standard', '04-Planned'];

export interface StageRow {
  key: string;
  name: string;
  sub: string;
  count: number;
  /** 0-15, 16-30, 31-90, over 90 — the bands the aging chart already uses. */
  bands: [number, number, number, number];
  /** Lines past PAST_SLA_DAYS. bands[1] + bands[2] + bands[3]. */
  pastSla: number;
  oldest: number | null;
  emergency: number;
  urgent: number;
  standard: number;
  /**
   * Rows whose requisition priority is absent — an order with no requisition.
   *
   * Counted and named so the four buckets sum to the stage's count, but the
   * page does not make it clickable: the detail filter matches values and
   * cannot ask for null, so the click would open a table that came back short.
   * Better a figure that does nothing than one that quietly disagrees.
   */
  prioUnset: number;
  standardLabels: string[];
  /** The detail filter that reproduces THIS card's population. */
  detailFilter: Record<string, string>;
}

export interface CategoryRow {
  /** The material category, or '(none)'. */
  desk: string;
  label: string;
  open: number;
  over90: number;
  oldest: number | null;
  bands: [number, number, number, number];
  detailFilter: Record<string, string>;
}

/**
 * The two states AFTER delivery, requested 22 Sep 2026.
 *
 * Deliberately not stages. Every stage on this page is work that has not been
 * delivered, and these two are money owed on work that HAS: adding them to the
 * pipeline would break the one property the pipeline has, that an open line
 * sits in exactly one stage and the stages sum to the total. They are counted
 * over the same version, scope and filter, and over a different status
 * population, which is why they are a separate block rather than two more
 * entries in `stages`.
 */
export interface MoneyCard {
  lines: number;
  /** Rupiah, or null when no row in the card carries a converted value. */
  valueIdr: number | null;
  detailFilter: Record<string, string>;
}

export interface CoupaCoverage {
  /** Unpaid, non-void, non-draft invoices in the Coupa store right now. */
  unpaidInvoices: number;
  /** How many of those reach a PO line in THIS dataset. */
  matchedInvoices: number;
}

export interface MoneyCards {
  deliveredNotInvoiced: MoneyCard;
  invoicedNotPaid: MoneyCard;
  /**
   * Present only when Coupa is reachable, and the reason the second card can
   * be read honestly: it says how much of the Coupa story the SAP dataset can
   * see. A card showing 53 lines when 573 invoice lines are unpaid is not
   * wrong, but it is not the whole debt either, and the page has to say which
   * it is.
   */
  coupaCoverage: CoupaCoverage | null;
}

export interface OpenItemsSummary {
  asOfDate: string;
  pastSlaDays: number;
  stages: StageRow[];
  categories: CategoryRow[];
  money: MoneyCards;
  totalOpen: number;
  totalPastSla: number;
  /** The filter for "every open line this page counts". */
  detailFilter: Record<string, string>;
  /**
   * Parts of the active global filter this page could not apply.
   *
   * Empty on every ordinary request. Non-empty means the figures describe a
   * WIDER population than the filter bar claims, which the page must say out
   * loud rather than leave the reader to discover.
   */
  filterIgnored: string[];
}

/**
 * The shared measures, written once.
 *
 * The stage query and the desk query group the same population by a different
 * key, so the measures must not be allowed to differ between them — the desk
 * totals have to add up to the pipeline totals.
 */
const MEASURES = `
  count(*)::int                                                           AS n,
  count(*) FILTER (WHERE d.age_days <= 15)::int                           AS b0,
  count(*) FILTER (WHERE d.age_days > 15  AND d.age_days <= 30)::int      AS b1,
  count(*) FILTER (WHERE d.age_days > 30  AND d.age_days <= 90)::int      AS b2,
  count(*) FILTER (WHERE d.age_days > 90)::int                            AS b3,
  max(d.age_days)::int                                                    AS oldest,
  count(*) FILTER (WHERE d.p_cat = '01-Emergency')::int                   AS emergency,
  count(*) FILTER (WHERE d.p_cat = '02-Urgent')::int                      AS urgent,
  count(*) FILTER (WHERE d.p_cat IN ('03-Standard','04-Planned'))::int    AS standard,
  count(*) FILTER (WHERE d.p_cat IS NULL
                      OR d.p_cat NOT IN ('01-Emergency','02-Urgent',
                                         '03-Standard','04-Planned'))::int AS prio_unset`;

/**
 * The global filter, expressed against core.v_detail.
 *
 * NOT buildFilterClause. That builder writes clauses for the FACT tables —
 * `company_code`, `plant`, `purch_org`, `document_date` — and this page reads
 * the detail VIEW, whose columns are named differently and which does not carry
 * spend category or size band at all. Handing it this view produced
 * `dcompany_code` and a 500 for every filter that touched company, plant,
 * purchasing org or month; the clause is empty when no filter is set, which is
 * how that survived review.
 *
 * Every column and the month basis below are the ones core.v_detail's own
 * detail-table filter uses (detail.ts), deliberately: the cards are counted so
 * that clicking one opens the rows behind it, and a card filtered on a
 * different basis from the table it opens would break exactly the guarantee
 * this module was rewritten to keep.
 *
 * What the view cannot express is REPORTED, never dropped quietly — a page
 * that showed unfiltered totals under an active filter would be worse than one
 * that says which part of the filter it could not apply.
 */
function detailFilterClause(
  f: GlobalFilter,
  params: unknown[],
): { sql: string; ignored: string[] } {
  const parts: string[] = [];
  const add = (expr: string, vals: string[] | undefined): void => {
    if (!vals || vals.length === 0) return;
    params.push(vals);
    parts.push(`${expr} = ANY($${params.length})`);
  };

  add('d.company', f.companyCode);
  add('d.plant', f.plant);
  add('d.purch_org', f.purchOrg);
  // The detail table's own basis: a line that never reached an order still has
  // a requisition date, and this page is mostly such lines.
  add("to_char(COALESCE(d.po_date, d.req_date), 'YYYY-MM')", f.monthKey);

  const ignored: string[] = [];
  // No material code and no size band on the view, so these cannot be derived
  // here at all. Named in the response rather than ignored in silence.
  if ((f.spendCategory?.length ?? 0) > 0) ignored.push('spend category');
  if ((f.sizeBand?.length ?? 0) > 0) ignored.push('PO size band');
  // Both mean "delivered vs not", and every stage this page counts is already
  // not delivered: honouring them would either change nothing or empty the
  // page, and neither is what the reader asked for.
  if (f.delivered !== undefined) ignored.push('open/closed');
  if (f.scope !== undefined) ignored.push('scope toggle');

  return { sql: parts.length === 0 ? '' : ` AND ${parts.join(' AND ')}`, ignored };
}

/**
 * Version, scope, the page's global filter, and the page's own definition of
 * "open" — all on core.v_detail.
 *
 * The filter matters as much as the scope: the KPI tiles and the charts beside
 * this pipeline are recomputed under the global filter bar, so a pipeline that
 * ignored it would state unfiltered totals on a filtered page, and the headline
 * sentence built from these numbers would describe a backlog nobody is looking
 * at.
 */
function buildWhere(
  versionId: number,
  scope: readonly ScopeEntry[],
  filter: GlobalFilter,
  /**
   * false for the post-delivery cards, which count DELIVERED lines - the exact
   * rows the five stages exclude. Everything else about the population is
   * identical, which is the point of the flag: one place decides what "in
   * scope for this page" means.
   */
  openStagesOnly = true,
): { sql: string; params: unknown[]; ignored: string[] } {
  const params: unknown[] = [versionId];
  // The VIEW's column names, as in detail.ts - see ScopeColumns.
  const s = scopeSql(mintScopedQuery('openitems', scope), 'd', params, DETAIL_SCOPE_COLUMNS);
  // v_detail carries both grains in one row set, so the PO-line dimensions are
  // the ones to filter on.
  const f = detailFilterClause(filter, params);
  let stage = '';
  if (openStagesOnly) {
    params.push(OPEN_STAGES.map((x) => x.status));
    stage = `
          AND d.status = ANY($${params.length})`;
  }
  return {
    sql: `d.dataset_version_id = $1 AND ${s}${f.sql}
          AND NOT d.pr_deleted${stage}`,
    params,
    ignored: f.ignored,
  };
}

export async function openItemsSummary(
  versionId: number,
  asOfDate: string,
  scope: readonly ScopeEntry[],
  filter: GlobalFilter,
): Promise<OpenItemsSummary> {
  const w = buildWhere(versionId, scope, filter);

  const rows = await query<Record<string, unknown>>(
    `SELECT d.status AS k, ${MEASURES}
       FROM core.v_detail d WHERE ${w.sql} GROUP BY 1`,
    w.params,
  );
  const byStatus = new Map(rows.map((r) => [String(r['k']), r]));

  const stages: StageRow[] = OPEN_STAGES.map((s) => {
    const r = byStatus.get(s.status);
    const n = (k: string): number => Number(r?.[k] ?? 0);
    const bands: [number, number, number, number] = [n('b0'), n('b1'), n('b2'), n('b3')];
    return {
      key: s.key,
      name: s.name,
      sub: s.sub,
      count: n('n'),
      bands,
      // Everything outside the first band. The band boundary IS the SLA line
      // this page reads at, so the two can never drift apart.
      pastSla: bands[1] + bands[2] + bands[3],
      // Null, not 0, for an empty stage: the page prints a dash rather than
      // claiming something is 0 days old.
      oldest: r && r['oldest'] !== null && r['oldest'] !== undefined ? Number(r['oldest']) : null,
      emergency: n('emergency'),
      urgent: n('urgent'),
      standard: n('standard'),
      prioUnset: n('prio_unset'),
      standardLabels: STANDARD_LABELS,
      detailFilter: { status: s.status },
    };
  });

  // ── material categories ──────────────────────────────────────────────
  //
  // Purchasing group until 22 Sep 2026, changed on request. It is what a buyer
  // recognises their own work by - a desk code says who files it, a category
  // says what it is - and it needs no dimension join for a readable label.
  //
  // matCat, not the Executive Summary's spend category: this page counts
  // core.v_detail and that view carries no material code, so a spend category
  // cannot be derived on it at all. matCat is on the view AND is a filter the
  // detail table already knows, which is what keeps a click on a row opening
  // exactly the rows it counted.
  const dw = buildWhere(versionId, scope, filter);
  const categories = await query<Record<string, unknown>>(
    `SELECT COALESCE(NULLIF(d.mat_cat, ''), '(none)') AS desk,
            COALESCE(NULLIF(d.mat_cat, ''), '(no material category)') AS label,
            ${MEASURES}
       FROM core.v_detail d
      WHERE ${dw.sql}
      GROUP BY 1, 2
      ORDER BY b3 DESC, n DESC`,
    dw.params,
  );

  // ── after delivery: money still in flight ────────────────────────────
  //
  // openStagesOnly=false: these count delivered lines, which every stage above
  // excludes by construction.
  const mw = buildWhere(versionId, scope, filter, false);
  const [money] = await query<Record<string, unknown>>(
    `SELECT count(*) FILTER (WHERE ${MONEY_STATE_SQL['deliveredNotInvoiced']})::int AS dni_lines,
            sum(d.still_invoice_val_idr)
              FILTER (WHERE ${MONEY_STATE_SQL['deliveredNotInvoiced']}) AS dni_idr,
            count(*) FILTER (WHERE ${MONEY_STATE_SQL['invoicedNotPaid']})::int AS inp_lines,
            sum(d.po_value_idr)
              FILTER (WHERE ${MONEY_STATE_SQL['invoicedNotPaid']}) AS inp_idr
       FROM core.v_detail d
      WHERE ${mw.sql}`,
    mw.params,
  );

  /*
   * How much of Coupa's unpaid debt this dataset can see.
   *
   * Asked of the Coupa store directly, without the page's filter: the point is
   * the SIZE OF THE GAP between what Coupa knows and what the SAP facts can be
   * joined to, and narrowing it by plant would describe a smaller gap than the
   * one that exists. Null when the store is absent or unreadable - a missing
   * coverage note is better than a fabricated one.
   */
  let coupaCoverage: CoupaCoverage | null = null;
  try {
    const [cov] = await query<Record<string, unknown>>(
      `SELECT count(*)::int AS unpaid,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM ops.coupa_invoice_line il
                  JOIN ops.coupa_po_line cpl ON cpl.order_line_id = il.order_line_id
                  JOIN core.fact_po_line p ON p.dataset_version_id = $1
                       AND p.po_no = cpl.sap_po_no AND p.po_item = cpl.sap_po_item
                 WHERE il.invoice_id = i.id))::int AS matched
         FROM ops.v_coupa_invoice i
        WHERE NOT i.paid AND i.status NOT IN ('voided', 'draft')`,
      [versionId],
    );
    if (cov) {
      coupaCoverage = {
        unpaidInvoices: Number(cov['unpaid'] ?? 0),
        matchedInvoices: Number(cov['matched'] ?? 0),
      };
    }
  } catch {
    coupaCoverage = null;
  }

  const card = (lines: unknown, idr: unknown, state: string): MoneyCard => ({
    lines: Number(lines ?? 0),
    valueIdr: idr === null || idr === undefined ? null : Number(idr),
    detailFilter: { moneyState: state },
  });

  return {
    asOfDate,
    pastSlaDays: PAST_SLA_DAYS,
    stages,
    categories: categories.map((r) => ({
      desk: String(r['desk']),
      label: String(r['label']),
      open: Number(r['n']),
      over90: Number(r['b3']),
      oldest: r['oldest'] === null ? null : Number(r['oldest']),
      bands: [Number(r['b0']), Number(r['b1']), Number(r['b2']), Number(r['b3'])],
      // '(none)' is a display label, not a value the filter can match, so a row
      // with no material category is reported and left unclickable.
      detailFilter: (r['desk'] === '(none)'
        ? {}
        : { status: ALL_STAGE_STATUSES, matCat: String(r['desk']) }) as Record<string, string>,
    })),
    money: {
      deliveredNotInvoiced: card(money?.['dni_lines'], money?.['dni_idr'], 'deliveredNotInvoiced'),
      invoicedNotPaid: card(money?.['inp_lines'], money?.['inp_idr'], 'invoicedNotPaid'),
      coupaCoverage,
    },
    totalOpen: stages.reduce((a, s) => a + s.count, 0),
    totalPastSla: stages.reduce((a, s) => a + s.pastSla, 0),
    detailFilter: { status: ALL_STAGE_STATUSES },
    filterIgnored: w.ignored,
  };
}
