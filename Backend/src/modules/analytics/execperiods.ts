/**
 * YTD and current-month figures for the Executive Summary's headline tiles.
 *
 * Requested 22 Sep 2026: the value and lines tiles carried a "YTD 2026 / Sep
 * 2026" split under the headline figure, and the other six were asked to carry
 * the same thing.
 *
 * ── Why this could not stay in the frontend ─────────────────────────────────
 *
 * The two tiles that already had it derive it by SUMMING the months of
 * exec_committed_by_month. That works for a total and a count and for nothing
 * else on the row:
 *
 *   active vendors and purchasing desks are DISTINCT counts. A vendor billing
 *   in March and in April is one vendor for the year and two monthly buckets,
 *   so adding the buckets overstates the year by every repeat — which is nearly
 *   all of them;
 *
 *   the four cycle times are AVERAGES. Adding twelve averages produces a number
 *   with no meaning at all, and averaging them unweighted is still wrong
 *   whenever the months differ in size.
 *
 * So the window has to reach the rows. Each measure below is computed over the
 * SAME population as the tile it sits under, which is the property that matters:
 * a YTD figure that quietly counted a different population from the headline
 * above it would be worse than no YTD figure.
 *
 * ── The two populations ────────────────────────────────────────────────────
 *
 * They are not the same, and the difference is deliberate rather than an
 * oversight to be tidied up:
 *
 *   value, lines, vendors and desks use NOT is_sto AND NOT is_deleted — the
 *   purchase population, matching total_po_amount, po_line_items,
 *   unique_suppliers and active_purch_groups;
 *
 *   the cycle times use no such exclusion, because their KPIs do not. They
 *   measure how long the process took, and a stock transfer's approval still
 *   took as long as it took.
 *
 * Both are computed in one pass over one scan, with the exclusion expressed as
 * a flag per row, so the two can be read side by side in this file rather than
 * inferred from two queries that drifted.
 *
 * ── The window ─────────────────────────────────────────────────────────────
 *
 * PO-grain measures use document_date, the same basis
 * exec_committed_by_month buckets on, so the YTD figure here and the sum of
 * that chart's months agree exactly. The PR-grain cycle uses requisition_date:
 * the measure starts there, and bucketing an approval time by the month it
 * FINISHED would put a December requisition approved in January into January's
 * average and leave December's looking better than it was.
 *
 * The period comes from the dataset's as-of date, never the wall clock — an
 * extract has its own end date, and reading the server's calendar would make
 * one published version report different numbers on different days.
 */

import { query } from '../../db/client.js';
import { mintScopedQuery, scopeSql, type ScopeEntry } from '../authz/scope.js';
import { buildFilterClause, type GlobalFilter } from './globalfilter.js';

export interface TilePeriod {
  /** null, never 0: "no rows in this period" is not "zero this period". */
  ytd: number | null;
  mtd: number | null;
}

export interface ExecTilePeriods {
  /** 'YYYY' and 'YYYY-MM' of the dataset's as-of date. */
  year: string;
  month: string;
  /** Keyed by the KPI id the tile shows, so the frontend pairs them by id. */
  tiles: Record<string, TilePeriod>;
}

/** Number, or null for a SQL NULL — an empty period, not a zero one. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function execTilePeriods(
  versionId: number,
  asOfDate: string,
  scope: readonly ScopeEntry[],
  filter: GlobalFilter,
): Promise<ExecTilePeriods> {
  const year = asOfDate.slice(0, 4);
  const month = asOfDate.slice(0, 7);

  // ── PO grain ──────────────────────────────────────────────────────────
  const poParams: unknown[] = [versionId];
  const poScope = scopeSql(mintScopedQuery('execperiods', scope), 'pol', poParams);
  const poFilter = buildFilterClause(filter, 'po_line', 'pol.', poParams.length + 1);
  poParams.push(...poFilter.params);
  poParams.push(year, month);
  const yIdx = poParams.length - 1;
  const mIdx = poParams.length;

  const [po] = await query<Record<string, unknown>>(
    `WITH b AS (
       SELECT pol.net_order_value_idr, pol.net_order_value_usd, pol.vendor_code,
              pol.purch_group, pol.sourcing_days, pol.po_approval_days, pol.delivery_days,
              (NOT pol.is_sto AND NOT pol.is_deleted) AS purch,
              to_char(pol.document_date, 'YYYY')    = $${yIdx} AS in_ytd,
              to_char(pol.document_date, 'YYYY-MM') = $${mIdx} AS in_mtd
         FROM core.fact_po_line pol
        WHERE pol.dataset_version_id = $1 AND ${poScope}${poFilter.sql}
          AND pol.document_date IS NOT NULL
     )
     SELECT
       sum(net_order_value_idr) FILTER (WHERE purch AND in_ytd) AS value_idr_ytd,
       sum(net_order_value_idr) FILTER (WHERE purch AND in_mtd) AS value_idr_mtd,
       sum(net_order_value_usd) FILTER (WHERE purch AND in_ytd) AS value_usd_ytd,
       sum(net_order_value_usd) FILTER (WHERE purch AND in_mtd) AS value_usd_mtd,
       count(*) FILTER (WHERE purch AND in_ytd) AS lines_ytd,
       count(*) FILTER (WHERE purch AND in_mtd) AS lines_mtd,
       count(DISTINCT vendor_code) FILTER (WHERE purch AND in_ytd AND vendor_code IS NOT NULL) AS vendors_ytd,
       count(DISTINCT vendor_code) FILTER (WHERE purch AND in_mtd AND vendor_code IS NOT NULL) AS vendors_mtd,
       count(DISTINCT purch_group) FILTER (WHERE purch AND in_ytd
             AND purch_group IS NOT NULL AND btrim(purch_group) <> '') AS desks_ytd,
       count(DISTINCT purch_group) FILTER (WHERE purch AND in_mtd
             AND purch_group IS NOT NULL AND btrim(purch_group) <> '') AS desks_mtd,
       -- The cycle averages: no STO/deleted exclusion, matching their KPIs, and
       -- >= 0 only, matching the vals filter those KPIs apply in TypeScript.
       avg(sourcing_days)    FILTER (WHERE in_ytd AND sourcing_days    >= 0) AS sourcing_ytd,
       avg(sourcing_days)    FILTER (WHERE in_mtd AND sourcing_days    >= 0) AS sourcing_mtd,
       avg(po_approval_days) FILTER (WHERE in_ytd AND po_approval_days >= 0) AS po_appr_ytd,
       avg(po_approval_days) FILTER (WHERE in_mtd AND po_approval_days >= 0) AS po_appr_mtd,
       avg(delivery_days)    FILTER (WHERE in_ytd AND delivery_days    >= 0) AS delivery_ytd,
       avg(delivery_days)    FILTER (WHERE in_mtd AND delivery_days    >= 0) AS delivery_mtd
       FROM b`,
    poParams,
  );

  // ── PR grain ──────────────────────────────────────────────────────────
  //
  // A distinct query rather than a join: the measure is one row per PR item,
  // and joining it to the PO lines would count a requisition once per order
  // line raised against it.
  const prParams: unknown[] = [versionId];
  const prScope = scopeSql(mintScopedQuery('execperiods', scope), 'pri', prParams);
  const prFilter = buildFilterClause(filter, 'pr_item', 'pri.', prParams.length + 1);
  prParams.push(...prFilter.params);
  prParams.push(year, month);
  const pyIdx = prParams.length - 1;
  const pmIdx = prParams.length;

  const [pr] = await query<Record<string, unknown>>(
    `WITH b AS (
       SELECT (pri.release_final_date - pri.requisition_date) AS d,
              to_char(pri.requisition_date, 'YYYY')    = $${pyIdx} AS in_ytd,
              to_char(pri.requisition_date, 'YYYY-MM') = $${pmIdx} AS in_mtd
         FROM core.fact_pr_item pri
        WHERE pri.dataset_version_id = $1 AND ${prScope}${prFilter.sql}
          AND pri.requisition_date IS NOT NULL
          AND pri.release_final_date IS NOT NULL
     )
     SELECT avg(d) FILTER (WHERE in_ytd AND d >= 0) AS pr_appr_ytd,
            avg(d) FILTER (WHERE in_mtd AND d >= 0) AS pr_appr_mtd
       FROM b`,
    prParams,
  );

  const p = (ytd: unknown, mtd: unknown): TilePeriod => ({ ytd: num(ytd), mtd: num(mtd) });

  return {
    year,
    month,
    tiles: {
      // Both currency bases travel together, like total_po_amount's own detail,
      // so the tile follows the header's currency toggle without a second call.
      total_po_amount: p(po?.['value_usd_ytd'], po?.['value_usd_mtd']),
      total_po_amount_idr: p(po?.['value_idr_ytd'], po?.['value_idr_mtd']),
      po_line_items: p(po?.['lines_ytd'], po?.['lines_mtd']),
      unique_suppliers: p(po?.['vendors_ytd'], po?.['vendors_mtd']),
      active_purch_groups: p(po?.['desks_ytd'], po?.['desks_mtd']),
      cycle_pr_approval: p(pr?.['pr_appr_ytd'], pr?.['pr_appr_mtd']),
      cycle_sourcing: p(po?.['sourcing_ytd'], po?.['sourcing_mtd']),
      cycle_po_approval: p(po?.['po_appr_ytd'], po?.['po_appr_mtd']),
      cycle_delivery: p(po?.['delivery_ytd'], po?.['delivery_mtd']),
    },
  };
}
