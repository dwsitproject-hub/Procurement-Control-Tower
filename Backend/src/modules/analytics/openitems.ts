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
import {
  AGE_BANDS, AGE_LATE_DAYS, ageBandPredicateSql, ageLatePredicateSql,
} from '@pct/rules';
import { MONEY_STATE_SQL } from './detail.js';
import { OPEN_STATUSES, type GlobalFilter } from './globalfilter.js';

/** The age boundary this page reads "past SLA" at. See the header. */
export const PAST_SLA_DAYS = 15;

/**
 * The five stages, in pipeline order.
 *
 * An open line sits in exactly one of them: v_detail.status holds one value per
 * row, so the statuses are disjoint by construction and the page can say so
 * without qualification.
 */
/**
 * What each open status is called on a card, and what it means.
 *
 * The STAGES THEMSELVES are not listed here - they are derived from
 * OPEN_STATUSES below, which is the product's one definition of an open item,
 * already used by the scope toggle and the drill's `open` filter. This page
 * carried its own five-stage list until 23 Sep 2026 and it was missing
 * 'Partially Delivered', so the page's total, the sidebar badge and the
 * Executive Summary's open figure were three different populations wearing one
 * word. Deriving the list means a status added to the product's definition
 * cannot be quietly absent from this page.
 *
 * A status with no entry here fails loudly at startup rather than rendering a
 * card labelled with a raw status string.
 */
const STAGE_META: Record<string, { key: string; name: string; sub: string }> = {
  'Unapproved PR': { key: 'pr_not_approved', name: 'PR not approved', sub: 'Waiting on requisition release' },
  'PR Approved-No PO': { key: 'pr_no_po', name: 'PR approved, no PO', sub: 'Released but no order raised' },
  'PO-Not Approved': { key: 'po_pending_approval', name: 'PO pending approval', sub: 'Order awaiting release' },
  'HOLD PO': { key: 'po_hold', name: 'PO on hold', sub: 'Blocked by buyer or requester' },
  'PO-No GR': { key: 'po_not_delivered', name: 'PO not delivered', sub: 'Ordered, no goods receipt' },
  // Added with the derivation. A partly received order still has an
  // outstanding remainder, which is why the product's definition has always
  // counted it and why leaving it out understated this page.
  'Partially Delivered': { key: 'po_partial', name: 'PO partly delivered', sub: 'Some received, remainder outstanding' },
};

export const OPEN_STAGES = OPEN_STATUSES.map((status) => {
  const meta = STAGE_META[status];
  if (!meta) throw new Error(`Open Items has no card for open status: ${status}`);
  return { ...meta, status };
});

/** Every stage status, for the filter that reproduces the whole pipeline. */
const ALL_STAGE_STATUSES = OPEN_STAGES.map((s) => s.status).join(',');

/** The priority values a click on the `standard` figure filters by. */
const STANDARD_LABELS = ['03-Standard', '04-Planned'];

export interface StageRow {
  key: string;
  name: string;
  sub: string;
  count: number;
  /** One count per band of AGE_BANDS, in its order. */
  bands: number[];
  /** Lines past PAST_SLA_DAYS, counted directly rather than summed. */
  pastSla: number;
  /** Lines past AGE_LATE_DAYS - what the page calls badly late. */
  overLate: number;
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
  /** Lines past AGE_LATE_DAYS. The table sorts on it. */
  overLate: number;
  oldest: number | null;
  bands: number[];
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
/**
 * A post-delivery card.
 *
 * It extends StageRow rather than defining its own shape (23 Sep 2026): the two
 * sit in the pipeline's row and must read as cards of the same design, and the
 * surest way to keep two cards looking alike is for one component to draw both
 * from one type. What differs is stated - `valueIdr`, and `note` for the
 * provenance line - not re-invented.
 */
export interface MoneyCard extends StageRow {
  /** Rupiah, or null when no row in the card carries a converted value. */
  valueIdr: number | null;
  /** Where the figure comes from, when that is not the SAP export. */
  note: string | null;
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
  /** The boundary the page calls badly late. */
  lateDays: number;
  /** The bands, in order, so the page labels them from the server's own list. */
  bands: { key: string; label: string }[];
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
${AGE_BANDS.map((b, i) => `  count(*) FILTER (WHERE ${ageBandPredicateSql('d.age_days', b.key)})::int AS b${i},`).join('\n')}
  -- Past SLA is computed on its own now, not summed from the bands. The six
  -- bands (23 Sep 2026) have no boundary at 15 days, so the old trick of
  -- reading everything past the first band stopped meaning "past the approval
  -- line" and started meaning "older than a week".
  count(*) FILTER (WHERE d.age_days > ${PAST_SLA_DAYS})::int               AS past_sla,
  count(*) FILTER (WHERE ${ageLatePredicateSql('d.age_days')})::int        AS over_late,
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
  // 030 put spend_category on the view, so this one IS applied now.
  add('d.spend_category', f.spendCategory);
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
    const bands = AGE_BANDS.map((_b, i) => n(`b${i}`));
    return {
      key: s.key,
      name: s.name,
      sub: s.sub,
      count: n('n'),
      bands,
      pastSla: n('past_sla'),
      overLate: n('over_late'),
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
  // THE EXECUTIVE SUMMARY'S category (030), not the legacy mat_cat this page
  // shipped with on 22 Sep. Both were called "material category" and they are
  // different dimensions; grouping by one while the Executive Summary groups by
  // the other is how two pages come to disagree about what METHANOL is worth.
  // It resolves through the Material Master, and a line that reached an order
  // takes fact_po_line.spend_category itself - the same column those charts
  // group by - so the two agree by construction rather than by review.
  const dw = buildWhere(versionId, scope, filter);
  const categories = await query<Record<string, unknown>>(
    `SELECT COALESCE(NULLIF(d.spend_category, ''), '(none)') AS desk,
            COALESCE(NULLIF(d.spend_category, ''), '(no spend category)') AS label,
            ${MEASURES}
       FROM core.v_detail d
      WHERE ${dw.sql}
      GROUP BY 1, 2
      ORDER BY over_late DESC, n DESC`,
    dw.params,
  );

  // ── after delivery: money still in flight ────────────────────────────
  //
  // openStagesOnly=false: these count delivered lines, which every stage above
  // excludes by construction.
  //
  // MEASURES, the same expression the stage cards use, so the age mix, the
  // past-SLA figure, the oldest line and the priority split are computed for
  // these two exactly as they are for the five above - one definition, seven
  // cards.
  const mw = buildWhere(versionId, scope, filter, false);
  const moneyRows = await query<Record<string, unknown>>(
    `SELECT 'deliveredNotInvoiced' AS k, ${MEASURES},
            sum(d.still_invoice_val_idr) AS value_idr
       FROM core.v_detail d
      WHERE ${mw.sql} AND ${MONEY_STATE_SQL['deliveredNotInvoiced']}
      UNION ALL
     SELECT 'invoicedNotPaid' AS k, ${MEASURES},
            sum(d.po_value_idr) AS value_idr
       FROM core.v_detail d
      WHERE ${mw.sql} AND ${MONEY_STATE_SQL['invoicedNotPaid']}`,
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

  const AFTER: Record<string, { name: string; sub: string; note: string | null }> = {
    deliveredNotInvoiced: {
      name: 'PO delivered, not invoiced',
      sub: 'Received, invoice not posted',
      note: null,
    },
    invoicedNotPaid: {
      name: 'PO invoiced, not paid',
      sub: 'Invoiced, payment outstanding',
      // The caveat travels WITH the figure. The SAP export carries no payment
      // status at all, so this one comes from Coupa - a live store the dataset
      // version does not pin, reaching only the orders Coupa knows and carries
      // a SAP cross-reference for.
      note: 'From Coupa, not the SAP export, which carries no payment status.',
    },
  };

  const byMoneyKey = new Map(moneyRows.map((r) => [String(r['k']), r]));
  const moneyCard = (key: string): MoneyCard => {
    const r = byMoneyKey.get(key);
    const n = (c: string): number => Number(r?.[c] ?? 0);
    const meta = AFTER[key]!;
    return {
      key,
      name: meta.name,
      sub: meta.sub,
      count: n('n'),
      bands: AGE_BANDS.map((_b, i) => n(`b${i}`)),
      pastSla: n('past_sla'),
      overLate: n('over_late'),
      oldest: r && r['oldest'] !== null && r['oldest'] !== undefined ? Number(r['oldest']) : null,
      emergency: n('emergency'),
      urgent: n('urgent'),
      standard: n('standard'),
      prioUnset: n('prio_unset'),
      standardLabels: STANDARD_LABELS,
      detailFilter: { moneyState: key },
      valueIdr: r?.['value_idr'] === null || r?.['value_idr'] === undefined
        ? null : Number(r['value_idr']),
      note: meta.note,
    };
  };

  return {
    asOfDate,
    pastSlaDays: PAST_SLA_DAYS,
    lateDays: AGE_LATE_DAYS,
    bands: AGE_BANDS.map((b) => ({ key: b.key, label: b.label })),
    stages,
    categories: categories.map((r) => ({
      desk: String(r['desk']),
      label: String(r['label']),
      open: Number(r['n']),
      overLate: Number(r['over_late']),
      oldest: r['oldest'] === null ? null : Number(r['oldest']),
      bands: AGE_BANDS.map((_b, i) => Number(r[`b${i}`] ?? 0)),
      // '(none)' is a display label, not a value the filter can match, so a row
      // with no material category is reported and left unclickable.
      detailFilter: (r['desk'] === '(none)'
        ? {}
        : { status: ALL_STAGE_STATUSES, spendCategory: String(r['desk']) }) as Record<string, string>,
    })),
    money: {
      deliveredNotInvoiced: moneyCard('deliveredNotInvoiced'),
      invoicedNotPaid: moneyCard('invoicedNotPaid'),
      coupaCoverage,
    },
    totalOpen: stages.reduce((a, s) => a + s.count, 0),
    totalPastSla: stages.reduce((a, s) => a + s.pastSla, 0),
    detailFilter: { status: ALL_STAGE_STATUSES },
    filterIgnored: w.ignored,
  };
}
