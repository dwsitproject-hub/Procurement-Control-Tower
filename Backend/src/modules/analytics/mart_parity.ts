/**
 * Parity KPIs and charts — the v1 cards and charts listed in
 * Docs/V1_V2_Parity_Matrix.md §2 and §3.
 *
 * Declared as data rather than hand-written blocks so each entry carries its
 * value SQL AND the drill predicate that reproduces exactly the rows behind it.
 * Keeping the two together is what stops the aggregate and the drill drifting
 * apart — the defect that produced 29 mismatched chart points.
 */

import type pg from 'pg';
import { insertMany } from '../../db/client.js';

// Statuses v1 treats as "open".
const OPEN = `('Unapproved PR','PR Approved-No PO','PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered')`;

// ─────────────────────────────────────────────────────────────────── KPI specs

type Unit = 'ratio' | 'percent' | 'days' | 'usd' | 'idr' | 'count';

interface KpiSpec {
  id: string;
  /** Must return: value, and optionally numerator, denominator, sample. */
  sql: string;
  unit: Unit;
  currencyBasis?: 'usd_strict' | 'idr_based' | null;
  /** Predicate that reproduces the rows behind the figure. */
  drill: Record<string, unknown> | null;
  /**
   * Set when the card counts ENTITIES (distinct POs, vendors, materials) while the
   * drill returns the underlying rows. The two differ by design; naming the entity
   * lets both the card and the drill say so instead of looking like a defect.
   */
  entityUnit?: string;
  /** Higher is worse (drives the severity colour). */
  worseWhenHigh?: { warn: number; crit: number };
  worseWhenLow?: { warn: number; crit: number };
}

const PRI = 'core.fact_pr_item';
const POL = 'core.fact_po_line';

export const PARITY_KPIS: KpiSpec[] = [
  // ── Overview / Executive ──
  {
    id: 'open_po_commitment',
    unit: 'usd',
    currencyBasis: 'usd_strict',
    sql: `SELECT sum(still_deliver_val_usd) AS value, count(*)::int AS sample
            FROM ${POL} WHERE dataset_version_id = $1
             AND NOT is_sto AND NOT is_deleted AND COALESCE(still_deliver_val,0) > 0`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true, hasOpenCommitment: true } },
  },
  {
    id: 'grir_value',
    unit: 'usd',
    currencyBasis: 'usd_strict',
    sql: `SELECT sum(still_invoice_val_usd) AS value, count(*)::int AS sample
            FROM ${POL} WHERE dataset_version_id = $1
             AND NOT is_sto AND NOT is_deleted
             AND COALESCE(still_deliver_qty,0) = 0 AND COALESCE(still_invoice_val,0) > 0`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true, grirOpen: true } },
  },
  {
    id: 'delivered_not_invoiced',
    unit: 'usd',
    currencyBasis: 'usd_strict',
    sql: `SELECT sum(still_invoice_val_usd) AS value, count(*)::int AS sample
            FROM ${POL} WHERE dataset_version_id = $1
             AND NOT is_sto AND NOT is_deleted
             AND COALESCE(still_deliver_qty,0) = 0 AND COALESCE(still_invoice_val,0) > 0`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true, grirOpen: true } },
  },
  {
    id: 'pr_pipeline_value',
    unit: 'idr',
    currencyBasis: 'idr_based',
    sql: `SELECT sum(total_value_idr) AS value, count(*)::int AS sample
            FROM ${PRI} WHERE dataset_version_id = $1
             AND NOT is_deleted AND po_line_count = 0`,
    drill: { grain: 'pr_item', filters: { notDeleted: true, prNoPo: true } },
  },
  {
    id: 'emergency_pct_value',
    unit: 'percent',
    currencyBasis: 'idr_based',
    // G6.1 (decision, 3 Aug 2026): v1 parity — urgency 1-2 by value, matching
    // the card's own "Emg+Urg" label. Was urgency <= 1 (0.17%); now 11.3%.
    sql: `SELECT 100.0 * COALESCE(sum(total_value_idr) FILTER (WHERE urgency <= 2), 0)
                 / NULLIF(sum(total_value_idr), 0) AS value,
                 sum(total_value_idr) FILTER (WHERE urgency <= 2) AS numerator,
                 sum(total_value_idr) AS denominator, count(*)::int AS sample
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted`,
    drill: { grain: 'pr_item', filters: { notDeleted: true, urgencyLte: 2 } },
    worseWhenHigh: { warn: 10, crit: 25 },
  },
  {
    id: 'total_pr_items',
    unit: 'count',
    sql: `SELECT count(*)::int AS value FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted`,
    drill: { grain: 'pr_item', filters: { notDeleted: true } },
  },
  {
    id: 'delivered_gr',
    unit: 'count',
    sql: `SELECT count(*)::int AS value FROM ${POL}
           WHERE dataset_version_id = $1 AND receipt_date IS NOT NULL`,
    drill: { grain: 'po_line', filters: { hasReceipt: true } },
  },
  {
    id: 'items_delivered',
    unit: 'count',
    sql: `SELECT count(*)::int AS value FROM ${POL}
           WHERE dataset_version_id = $1 AND status IN ('Delivered','Partially Delivered')`,
    drill: { grain: 'po_line', filters: { statusIn: ['Delivered', 'Partially Delivered'] } },
  },

  // ── Open Items ──
  {
    id: 'pr_not_approved',
    unit: 'count',
    sql: `SELECT count(*)::int AS value,
                 count(*) FILTER (WHERE urgency <= 1)::int AS chip_emergency,
                 count(*) FILTER (WHERE urgency = 2)::int AS chip_urgent,
                 count(*) FILTER (WHERE COALESCE(urgency, 9) >= 3)::int AS chip_standard FROM ${PRI}
           WHERE dataset_version_id = $1 AND status = 'Unapproved PR'`,
    drill: { grain: 'pr_item', filters: { status: 'Unapproved PR' } },
  },
  {
    id: 'pr_no_po',
    unit: 'count',
    sql: `SELECT count(*)::int AS value,
                 count(*) FILTER (WHERE urgency <= 1)::int AS chip_emergency,
                 count(*) FILTER (WHERE urgency = 2)::int AS chip_urgent,
                 count(*) FILTER (WHERE COALESCE(urgency, 9) >= 3)::int AS chip_standard FROM ${PRI}
           WHERE dataset_version_id = $1 AND status = 'PR Approved-No PO'`,
    drill: { grain: 'pr_item', filters: { status: 'PR Approved-No PO' } },
  },
  {
    id: 'po_hold',
    entityUnit: 'POs',
    unit: 'count',
    sql: `SELECT count(DISTINCT po_no)::int AS value,
                 count(*) FILTER (WHERE urgency <= 1)::int AS chip_emergency,
                 count(*) FILTER (WHERE urgency = 2)::int AS chip_urgent,
                 count(*) FILTER (WHERE COALESCE(urgency, 9) >= 3)::int AS chip_standard FROM ${POL}
           WHERE dataset_version_id = $1 AND status = 'HOLD PO'`,
    drill: { grain: 'po_line', filters: { status: 'HOLD PO' } },
  },
  {
    id: 'hold_po_lines',
    unit: 'count',
    sql: `SELECT count(*)::int AS value FROM ${POL}
           WHERE dataset_version_id = $1 AND status = 'HOLD PO'`,
    drill: { grain: 'po_line', filters: { status: 'HOLD PO' } },
  },
  {
    id: 'po_not_delivered',
    unit: 'count',
    sql: `SELECT count(*)::int AS value,
                 count(*) FILTER (WHERE urgency <= 1)::int AS chip_emergency,
                 count(*) FILTER (WHERE urgency = 2)::int AS chip_urgent,
                 count(*) FILTER (WHERE COALESCE(urgency, 9) >= 3)::int AS chip_standard FROM ${POL}
           WHERE dataset_version_id = $1 AND status = 'PO-No GR'`,
    drill: { grain: 'po_line', filters: { status: 'PO-No GR' } },
  },
  {
    id: 'emergency_open',
    unit: 'count',
    sql: `SELECT count(*)::int AS value FROM ${PRI}
           WHERE dataset_version_id = $1 AND urgency <= 1 AND status IN ${OPEN}`,
    drill: { grain: 'pr_item', filters: { urgencyLte: 1, open: true } },
  },
  {
    id: 'urgent_open',
    unit: 'count',
    sql: `SELECT count(*)::int AS value FROM ${PRI}
           WHERE dataset_version_id = $1 AND urgency = 2 AND status IN ${OPEN}`,
    drill: { grain: 'pr_item', filters: { urgencyIn: [2], open: true } },
  },
  {
    id: 'avg_unreleased_age',
    unit: 'days',
    sql: `SELECT avg(aging_days) AS value, count(*)::int AS sample FROM ${PRI}
           WHERE dataset_version_id = $1 AND release_final_date IS NULL AND NOT is_deleted`,
    drill: { grain: 'pr_item', filters: { unreleased: true, notDeleted: true } },
    worseWhenHigh: { warn: 30, crit: 60 },
  },
  {
    id: 'oldest_unreleased',
    unit: 'days',
    sql: `SELECT max(aging_days) AS value, count(*)::int AS sample FROM ${PRI}
           WHERE dataset_version_id = $1 AND release_final_date IS NULL AND NOT is_deleted`,
    drill: { grain: 'pr_item', filters: { unreleased: true, notDeleted: true } },
    worseWhenHigh: { warn: 90, crit: 180 },
  },
  {
    id: 'unreleased_items',
    unit: 'count',
    sql: `SELECT count(*)::int AS value FROM ${PRI}
           WHERE dataset_version_id = $1 AND release_final_date IS NULL AND NOT is_deleted`,
    drill: { grain: 'pr_item', filters: { unreleased: true, notDeleted: true } },
  },
  {
    id: 'open_pr_no_wbs',
    unit: 'count',
    sql: `SELECT count(*)::int AS value, count(DISTINCT pr_no)::int AS numerator FROM ${PRI}
           WHERE dataset_version_id = $1 AND wbs_status = 'violation' AND status IN ${OPEN}`,
    drill: { grain: 'pr_item', filters: { wbsStatus: 'violation', open: true } },
    worseWhenHigh: { warn: 1, crit: 100 },
  },

  // ── PR analysis ──
  {
    id: 'max_pr_approval',
    unit: 'days',
    sql: `SELECT max(release_final_date - requisition_date) AS value, count(*)::int AS sample
            FROM ${PRI} WHERE dataset_version_id = $1 AND release_final_date IS NOT NULL`,
    drill: { grain: 'pr_item', filters: { released: true } },
  },
  {
    id: 'pr_to_po_conversion',
    unit: 'percent',
    sql: `SELECT 100.0 * count(*) FILTER (WHERE po_line_count > 0) / NULLIF(count(*), 0) AS value,
                 count(*) FILTER (WHERE po_line_count > 0)::int AS numerator,
                 count(*)::int AS denominator, count(*)::int AS sample
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted`,
    drill: { grain: 'pr_item', filters: { notDeleted: true, hasPo: true } },
    worseWhenLow: { warn: 70, crit: 50 },
  },
  {
    id: 'approved_within_3d',
    unit: 'percent',
    sql: `SELECT 100.0 * count(*) FILTER (WHERE release_final_date - requisition_date <= 3)
                 / NULLIF(count(*), 0) AS value,
                 count(*) FILTER (WHERE release_final_date - requisition_date <= 3)::int AS numerator,
                 count(*)::int AS denominator, count(*)::int AS sample
            FROM ${PRI} WHERE dataset_version_id = $1 AND release_final_date IS NOT NULL`,
    drill: { grain: 'pr_item', filters: { released: true } },
    worseWhenLow: { warn: 70, crit: 50 },
  },
  {
    id: 'emergency_urgent_share',
    unit: 'percent',
    sql: `SELECT 100.0 * count(*) FILTER (WHERE urgency <= 2) / NULLIF(count(*), 0) AS value,
                 count(*) FILTER (WHERE urgency <= 2)::int AS numerator,
                 count(*)::int AS denominator, count(*)::int AS sample
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted`,
    drill: { grain: 'pr_item', filters: { notDeleted: true, urgencyLte: 2 } },
    worseWhenHigh: { warn: 30, crit: 50 },
  },
  {
    id: 'at_risk_demand',
    unit: 'count',
    sql: `SELECT count(*)::int AS value FROM ${PRI}
           WHERE dataset_version_id = $1 AND NOT is_deleted AND po_line_count = 0
             AND aging_days > 0`,
    drill: { grain: 'pr_item', filters: { notDeleted: true, prNoPo: true, agingGt: 0 } },
    worseWhenHigh: { warn: 1, crit: 1000 },
  },
  {
    id: 'pr_cancellation_rate',
    unit: 'percent',
    sql: `SELECT 100.0 * count(*) FILTER (WHERE is_deleted) / NULLIF(count(*), 0) AS value,
                 count(*) FILTER (WHERE is_deleted)::int AS numerator,
                 count(*)::int AS denominator, count(*)::int AS sample
            FROM ${PRI} WHERE dataset_version_id = $1`,
    drill: { grain: 'pr_item', filters: { deletedOnly: true } },
    worseWhenHigh: { warn: 5, crit: 15 },
  },
  {
    id: 'pr_deleted',
    unit: 'count',
    sql: `SELECT count(*)::int AS value FROM ${PRI} WHERE dataset_version_id = $1 AND is_deleted`,
    drill: { grain: 'pr_item', filters: { deletedOnly: true } },
  },

  // ── PO analysis ──
  {
    id: 'total_po_amount',
    unit: 'usd',
    currencyBasis: 'usd_strict',
    sql: `SELECT sum(net_order_value_usd) AS value, count(*)::int AS sample FROM ${POL}
           WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
  },
  {
    id: 'total_po_count',
    entityUnit: 'POs',
    unit: 'count',
    sql: `SELECT count(DISTINCT po_no)::int AS value FROM ${POL}
           WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
  },
  {
    id: 'po_line_items',
    unit: 'count',
    sql: `SELECT count(*)::int AS value FROM ${POL}
           WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
  },
  {
    id: 'unique_suppliers',
    entityUnit: 'vendors',
    unit: 'count',
    sql: `SELECT count(DISTINCT vendor_code)::int AS value FROM ${POL}
           WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted AND vendor_code IS NOT NULL`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
  },
  {
    id: 'lines_pending_po_approval',
    unit: 'count',
    sql: `SELECT count(*)::int AS value,
                 count(*) FILTER (WHERE urgency <= 1)::int AS chip_emergency,
                 count(*) FILTER (WHERE urgency = 2)::int AS chip_urgent,
                 count(*) FILTER (WHERE COALESCE(urgency, 9) >= 3)::int AS chip_standard FROM ${POL}
           WHERE dataset_version_id = $1 AND po_release_state = 'pending'`,
    drill: { grain: 'po_line', filters: { poReleaseState: 'pending' } },
  },
  {
    // v1 'Info-Record Coverage %': share of PO lines (STO included, deleted
    // excluded — v1's _plScope) carrying a purchasing info record. The drill
    // opens the numerator, matching the gr_coverage_pct convention.
    id: 'po_irc',
    unit: 'percent',
    sql: `SELECT 100.0 * count(*) FILTER (WHERE info_record IS NOT NULL) / NULLIF(count(*), 0) AS value,
                 count(*) FILTER (WHERE info_record IS NOT NULL)::int AS numerator,
                 count(*)::int AS denominator, count(*)::int AS sample
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_deleted`,
    drill: { grain: 'po_line', filters: { notDeleted: true, hasInfoRecord: true } },
  },
  {
    id: 'gr_coverage_pct',
    unit: 'percent',
    sql: `SELECT 100.0 * count(*) FILTER (WHERE receipt_date IS NOT NULL) / NULLIF(count(*), 0) AS value,
                 count(*) FILTER (WHERE receipt_date IS NOT NULL)::int AS numerator,
                 count(*)::int AS denominator, count(*)::int AS sample
            FROM ${POL} WHERE dataset_version_id = $1
             AND po_release_state IN ('approved','not_subject_to_release') AND NOT is_deleted`,
    drill: { grain: 'po_line', filters: { notDeleted: true, hasReceipt: true } },
    worseWhenLow: { warn: 80, crit: 60 },
  },
  {
    id: 'pr_po_price_variance',
    unit: 'percent',
    // PR valuation price vs PO unit price on the same item. Only rows where both
    // are present and positive contribute; the rest are excluded, not zeroed.
    sql: `SELECT 100.0 * avg((pol.unit_price - pri.valuation_price) / NULLIF(pri.valuation_price, 0)) AS value,
                 count(*)::int AS sample
            FROM ${POL} pol
            JOIN ${PRI} pri ON pri.dataset_version_id = pol.dataset_version_id
                           AND pri.pr_no = pol.pr_no AND pri.pr_item = pol.pr_item
           WHERE pol.dataset_version_id = $1 AND NOT pol.is_sto
             AND pri.valuation_price > 0 AND pol.unit_price > 0`,
    drill: { grain: 'po_line', filters: { notSto: true, hasPr: true } },
    worseWhenHigh: { warn: 10, crit: 25 },
  },
  {
    id: 'tail_spend_pct',
    unit: 'percent',
    // Share of spend held by vendors outside the top 20 by value.
    sql: `WITH v AS (
            SELECT vendor_code, sum(net_order_value_usd) AS spend
              FROM ${POL} WHERE dataset_version_id = $1
               AND NOT is_sto AND NOT is_deleted AND vendor_code IS NOT NULL
             GROUP BY vendor_code
          ), ranked AS (
            SELECT spend, row_number() OVER (ORDER BY spend DESC NULLS LAST) AS rn FROM v
          )
          SELECT 100.0 * COALESCE(sum(spend) FILTER (WHERE rn > 20), 0)
                 / NULLIF(sum(spend), 0) AS value,
                 count(*)::int AS sample FROM ranked`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
  },
  {
    id: 'sole_source_materials',
    entityUnit: 'materials',
    unit: 'count',
    sql: `SELECT count(*)::int AS value FROM (
            SELECT material_code FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND material_code IS NOT NULL
             GROUP BY material_code HAVING count(DISTINCT vendor_code) = 1
          ) x`,
    drill: { grain: 'po_line', filters: { notSto: true } },
  },

  // ── G6.3: the v1-only registry KPIs, promoted (decision 3 Aug 2026) ──
  {
    // v1 'Tail Spend % (IDR)': share of IDR spend in the bottom 80% of PO
    // documents by value. The vendor-basis tail_spend_pct stays alongside.
    id: 'tail_spend_po_pct',
    unit: 'percent',
    currencyBasis: 'idr_based',
    sql: `WITH po_totals AS (
            SELECT po_no, sum(net_order_value) AS v FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted AND currency_code = 'IDR'
             GROUP BY po_no),
          ranked AS (SELECT v, percent_rank() OVER (ORDER BY v DESC) AS pr FROM po_totals)
          SELECT 100.0 * sum(v) FILTER (WHERE pr >= 0.2) / NULLIF(sum(v), 0) AS value,
                 count(*) FILTER (WHERE pr >= 0.2)::int AS numerator,
                 count(*)::int AS denominator, count(*)::int AS sample
            FROM ranked`,
    drill: null, // a percentile membership cannot be a static predicate
  },
  {
    id: 'valuation_coverage_pct',
    unit: 'percent',
    sql: `SELECT 100.0 * count(*) FILTER (WHERE COALESCE(total_value_idr,0) > 0) / NULLIF(count(*),0) AS value,
                 count(*) FILTER (WHERE COALESCE(total_value_idr,0) > 0)::int AS numerator,
                 count(*)::int AS denominator, count(*)::int AS sample
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted AND po_line_count = 0`,
    drill: { grain: 'pr_item', filters: { notDeleted: true, prNoPo: true, valuedIdr: true } },
    worseWhenLow: { warn: 80, crit: 60 },
  },
  {
    // v1 parity: counts requisitioners across ALL PR items including deleted
    // ones (a cancelled requisition is still a demand source). 368 on the
    // reference data; excluding deleted would read 353.
    id: 'unique_requisitioners',
    entityUnit: 'requisitioners',
    unit: 'count',
    sql: `SELECT count(DISTINCT requisitioner)::int AS value, count(*)::int AS sample
            FROM ${PRI} WHERE dataset_version_id = $1
             AND COALESCE(requisitioner, '') <> ''`,
    drill: { grain: 'pr_item', filters: {} },
  },
  {
    id: 'avg_pr_line_value_idr',
    unit: 'idr',
    currencyBasis: 'idr_based',
    sql: `SELECT sum(total_value_idr) / NULLIF(count(*) FILTER (WHERE COALESCE(total_value_idr,0) > 0), 0) AS value,
                 count(*) FILTER (WHERE COALESCE(total_value_idr,0) > 0)::int AS sample
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted`,
    drill: { grain: 'pr_item', filters: { notDeleted: true, valuedIdr: true } },
  },
  {
    id: 'avg_po_value_idr',
    entityUnit: 'POs',
    unit: 'idr',
    currencyBasis: 'idr_based',
    sql: `SELECT sum(net_order_value) / NULLIF(count(DISTINCT po_no), 0) AS value,
                 count(DISTINCT po_no)::int AS denominator, count(*)::int AS sample
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_deleted AND currency_code = 'IDR'`,
    drill: { grain: 'po_line', filters: { notDeleted: true, currencyIs: 'IDR' } },
  },
  {
    id: 'avg_value_per_po_usd',
    entityUnit: 'POs',
    unit: 'usd',
    currencyBasis: 'usd_strict',
    sql: `SELECT CASE WHEN count(*) FILTER (WHERE net_order_value IS NOT NULL AND net_order_value_usd IS NULL) > 0
                      THEN NULL
                      ELSE sum(net_order_value_usd) / NULLIF(count(DISTINCT po_no), 0) END AS value,
                 count(DISTINCT po_no)::int AS denominator, count(*)::int AS sample
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
  },
  {
    id: 'foreign_ccy_po_share',
    entityUnit: 'POs',
    unit: 'percent',
    sql: `SELECT 100.0 * count(DISTINCT po_no) FILTER (WHERE currency_code <> 'IDR')
                 / NULLIF(count(DISTINCT po_no), 0) AS value,
                 count(DISTINCT po_no) FILTER (WHERE currency_code <> 'IDR')::int AS numerator,
                 count(DISTINCT po_no)::int AS denominator, count(*)::int AS sample
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_deleted`,
    drill: { grain: 'po_line', filters: { notDeleted: true, foreignCcy: true } },
  },
  {
    // IDR spend on single-vendor materials. NOT EXISTS keeps the anchor on the
    // driving scan so the live-filter injection stays correct.
    id: 'single_source_spend_idr',
    unit: 'idr',
    currencyBasis: 'idr_based',
    sql: `SELECT sum(p.net_order_value) FILTER (WHERE p.currency_code = 'IDR') AS value,
                 count(*)::int AS sample
            FROM ${POL} p
           WHERE p.dataset_version_id = $1 AND NOT p.is_sto AND NOT p.is_deleted
             AND COALESCE(p.material_code, '') <> ''
             AND NOT EXISTS (
               SELECT 1 FROM ${POL} o
                WHERE o.dataset_version_id = p.dataset_version_id
                  AND o.material_code = p.material_code
                  AND NOT o.is_sto AND NOT o.is_deleted
                  AND o.vendor_code IS DISTINCT FROM p.vendor_code)`,
    drill: null, // single-source membership is a correlated condition
  },
  {
    id: 'top_vendor_share_pct',
    unit: 'percent',
    currencyBasis: 'idr_based',
    sql: `WITH vs AS (
            SELECT vendor_code, max(vendor_name) AS vn, sum(net_order_value) AS v FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
               AND currency_code = 'IDR' AND vendor_code IS NOT NULL
             GROUP BY vendor_code)
          SELECT 100.0 * max(v) / NULLIF(sum(v), 0) AS value, count(*)::int AS sample,
                 (SELECT vn FROM vs ORDER BY v DESC LIMIT 1) AS top_vendor
            FROM vs`,
    drill: null,
  },
  {
    id: 'top5_vendor_share_pct',
    unit: 'percent',
    currencyBasis: 'idr_based',
    sql: `WITH vs AS (
            SELECT vendor_code, sum(net_order_value) AS v FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
               AND currency_code = 'IDR' AND vendor_code IS NOT NULL
             GROUP BY vendor_code)
          SELECT 100.0 * (SELECT sum(v) FROM (SELECT v FROM vs ORDER BY v DESC LIMIT 5) t)
                 / NULLIF(sum(v), 0) AS value, count(*)::int AS sample
            FROM vs`,
    drill: null,
  },
  {
    id: 'avg_suppliers_per_material',
    unit: 'ratio',
    sql: `WITH m AS (
            SELECT material_code, count(DISTINCT vendor_code) AS c FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
               AND COALESCE(material_code, '') <> ''
             GROUP BY material_code)
          SELECT avg(c) AS value, count(*)::int AS sample FROM m`,
    drill: null,
  },
  {
    // Median approval wait per release PIC (>=30 steps), worst one. The PIC's
    // name rides in the detail jsonb via the extra-column mechanism.
    id: 'worst_approver_gap',
    unit: 'days',
    sql: `WITH g AS (
            SELECT r.pic_release,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY (r.approve_date - i.requisition_date)) AS med,
                   count(*)::int AS n
              FROM core.fact_pr_release r
              JOIN ${PRI} i ON i.dataset_version_id = r.dataset_version_id
                           AND i.pr_no = r.pr_no AND i.pr_item = r.pr_item
             WHERE r.dataset_version_id = $1
               AND r.approve_date IS NOT NULL AND i.requisition_date IS NOT NULL
             GROUP BY r.pic_release HAVING count(*) >= 30)
          SELECT max(med) AS value, sum(n)::int AS sample,
                 (SELECT pic_release FROM g ORDER BY med DESC LIMIT 1) AS worst_pic
            FROM g`,
    drill: null,
  },
  {
    id: 'auto_release_share_pct',
    unit: 'percent',
    sql: `SELECT 100.0 * count(*) FILTER (WHERE pic_release = 'Auto Release') / NULLIF(count(*), 0) AS value,
                 count(*) FILTER (WHERE pic_release = 'Auto Release')::int AS numerator,
                 count(*)::int AS denominator, count(*)::int AS sample
            FROM core.fact_po_release WHERE dataset_version_id = $1`,
    drill: { grain: 'po_release', filters: { picRelease: 'Auto Release' } },
  },
  {
    // G6.4: v1's op-page card — WBS violations still open (no PO yet).
    id: 'wbs_open_violations',
    unit: 'count',
    sql: `SELECT count(*)::int AS value,
                 count(DISTINCT pr_no)::int AS numerator,
                 sum(total_value_idr) AS chip_value_idr
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted
             AND wbs_status = 'violation' AND po_line_count = 0`,
    drill: { grain: 'pr_item', filters: { notDeleted: true, wbsStatus: 'violation', prNoPo: true } },
  },
];

// ───────────────────────────────────────────────────────────────── chart specs

interface ChartSpec {
  chartId: string;
  seriesKey: string;
  seriesLabel: string;
  unit: string;
  /** Must return bucket_key, bucket_label, value, row_count, drill (jsonb). */
  sql: string;
}

/** Aging/lead-time histogram buckets, matching v1's distribution charts. */
const DIST_BUCKETS = `CASE WHEN d <= 3 THEN '0-3' WHEN d <= 7 THEN '4-7' WHEN d <= 14 THEN '8-14'
                           WHEN d <= 30 THEN '15-30' WHEN d <= 60 THEN '31-60' ELSE '60+' END`;
const DIST_ORDER = `CASE WHEN d <= 3 THEN 1 WHEN d <= 7 THEN 2 WHEN d <= 14 THEN 3
                         WHEN d <= 30 THEN 4 WHEN d <= 60 THEN 5 ELSE 6 END`;

export const PARITY_CHARTS: ChartSpec[] = [
  {
    chartId: 'items_by_priority', seriesKey: 'items', seriesLabel: 'PR items', unit: 'count',
    sql: `SELECT COALESCE(priority_label,'(unlabelled)') AS bucket_key,
                 COALESCE(priority_label,'(unlabelled)') AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('priorityLabel', min(priority_label),'notDeleted',true)) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted
           GROUP BY 1,2 ORDER BY 1`,
  },
  {
    chartId: 'aging_by_priority', seriesKey: 'days', seriesLabel: 'Avg aging (days)', unit: 'days',
    sql: `SELECT COALESCE(priority_label,'(unlabelled)') AS bucket_key,
                 COALESCE(priority_label,'(unlabelled)') AS bucket_label,
                 avg(aging_days)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('priorityLabel', min(priority_label),'open',true)) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND status IN ${OPEN}
           GROUP BY 1,2 ORDER BY 1`,
  },
  {
    chartId: 'open_by_priority', seriesKey: 'items', seriesLabel: 'Open items', unit: 'count',
    sql: `SELECT COALESCE(priority_label,'(unlabelled)') AS bucket_key,
                 COALESCE(priority_label,'(unlabelled)') AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('priorityLabel', min(priority_label),'open',true)) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND status IN ${OPEN}
           GROUP BY 1,2 ORDER BY 1`,
  },
  {
    chartId: 'unapproved_by_category', seriesKey: 'items', seriesLabel: 'Unapproved PR items', unit: 'count',
    sql: `SELECT COALESCE(material_category,'Other') AS bucket_key,
                 COALESCE(material_category,'Other') AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('matCat', min(material_category),'status','Unapproved PR')) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND status = 'Unapproved PR'
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    chartId: 'pr_approval_by_priority', seriesKey: 'days', seriesLabel: 'Median PR approval (days)', unit: 'days',
    sql: `SELECT COALESCE(priority_label,'(unlabelled)') AS bucket_key,
                 COALESCE(priority_label,'(unlabelled)') AS bucket_label,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY release_final_date - requisition_date)::numeric AS value,
                 count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('priorityLabel', min(priority_label),'released',true)) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND release_final_date IS NOT NULL
           GROUP BY 1,2 ORDER BY 1`,
  },
  {
    chartId: 'pr_by_plant', seriesKey: 'items', seriesLabel: 'PR items', unit: 'count',
    sql: `SELECT plant AS bucket_key, plant AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('plant', plant,'notDeleted',true)) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted
           GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`,
  },
  {
    chartId: 'pr_approval_distribution', seriesKey: 'items', seriesLabel: 'PR items', unit: 'count',
    sql: `SELECT ${DIST_BUCKETS} AS bucket_key, ${DIST_BUCKETS} || ' days' AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('released',true,'distBucket',
                     jsonb_build_object('measure','pr_approval','bucket', ${DIST_BUCKETS}))) AS drill
            FROM (SELECT release_final_date - requisition_date AS d FROM ${PRI}
                   WHERE dataset_version_id = $1 AND release_final_date IS NOT NULL) x
           GROUP BY 1,2, ${DIST_ORDER} ORDER BY ${DIST_ORDER}`,
  },
  {
    chartId: 'unreleased_aging_buckets', seriesKey: 'items', seriesLabel: 'Unreleased PR items', unit: 'count',
    sql: `SELECT ${DIST_BUCKETS} AS bucket_key, ${DIST_BUCKETS} || ' days' AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('unreleased',true,'notDeleted',true,'distBucket',
                     jsonb_build_object('measure','aging','bucket', ${DIST_BUCKETS}))) AS drill
            FROM (SELECT aging_days AS d FROM ${PRI}
                   WHERE dataset_version_id = $1 AND release_final_date IS NULL AND NOT is_deleted
                     -- Explicit: a NULL would fall through the CASE into '60+' here
                     -- while the drill's distBucket filter excludes it, so the two
                     -- would disagree on that one bar. The other three
                     -- distributions already filter their measure.
                     AND aging_days IS NOT NULL) x
           GROUP BY 1,2, ${DIST_ORDER} ORDER BY ${DIST_ORDER}`,
  },
  {
    chartId: 'monthly_pr_no_po', seriesKey: 'items', seriesLabel: 'PR items with no PO', unit: 'count',
    sql: `SELECT to_char(requisition_date,'YYYY-MM') AS bucket_key,
                 to_char(requisition_date,'Mon YYYY') AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('monthKey', to_char(requisition_date,'YYYY-MM'),
                                      'prNoPo',true,'notDeleted',true)) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND po_line_count = 0 AND NOT is_deleted
              AND requisition_date IS NOT NULL
           GROUP BY 1,2 ORDER BY 1`,
  },
  {
    chartId: 'sourcing_by_priority', seriesKey: 'days', seriesLabel: 'Median sourcing (days)', unit: 'days',
    sql: `SELECT COALESCE(priority_label,'(unlabelled)') AS bucket_key,
                 COALESCE(priority_label,'(unlabelled)') AS bucket_label,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY sourcing_days)::numeric AS value,
                 count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('priorityLabel', min(priority_label),'notSto',true,
                                      'measureNotNull','sourcing')) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND sourcing_days IS NOT NULL AND NOT is_sto
           GROUP BY 1,2 ORDER BY 1`,
  },
  {
    chartId: 'po_approval_by_priority', seriesKey: 'days', seriesLabel: 'Median PO approval (days)', unit: 'days',
    sql: `SELECT COALESCE(priority_label,'(unlabelled)') AS bucket_key,
                 COALESCE(priority_label,'(unlabelled)') AS bucket_label,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY po_approval_days)::numeric AS value,
                 count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('priorityLabel', min(priority_label),'notSto',true,
                                      'measureNotNull','po_approval')) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND po_approval_days IS NOT NULL AND NOT is_sto
           GROUP BY 1,2 ORDER BY 1`,
  },
  {
    chartId: 'po_approval_distribution', seriesKey: 'lines', seriesLabel: 'PO lines', unit: 'count',
    sql: `SELECT ${DIST_BUCKETS} AS bucket_key, ${DIST_BUCKETS} || ' days' AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('notSto',true,'distBucket',
                     jsonb_build_object('measure','po_approval','bucket', ${DIST_BUCKETS}))) AS drill
            FROM (SELECT po_approval_days AS d FROM ${POL}
                   WHERE dataset_version_id = $1 AND po_approval_days IS NOT NULL AND NOT is_sto) x
           GROUP BY 1,2, ${DIST_ORDER} ORDER BY ${DIST_ORDER}`,
  },
  {
    chartId: 'sourcing_by_category', seriesKey: 'days', seriesLabel: 'Median sourcing (days)', unit: 'days',
    sql: `SELECT COALESCE(material_category,'Other') AS bucket_key,
                 COALESCE(material_category,'Other') AS bucket_label,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY sourcing_days)::numeric AS value,
                 count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('matCat', min(material_category),'notSto',true,
                                      'measureNotNull','sourcing')) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND sourcing_days IS NOT NULL AND NOT is_sto
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    chartId: 'po_by_plant', seriesKey: 'value', seriesLabel: 'Net order value (USD)', unit: 'usd',
    sql: `SELECT plant AS bucket_key, plant AS bucket_label,
                 sum(net_order_value_usd)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('plant', plant,'notSto',true,'notDeleted',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
           GROUP BY 1,2 ORDER BY 3 DESC NULLS LAST LIMIT 20`,
  },
  {
    chartId: 'po_value_by_category', seriesKey: 'value', seriesLabel: 'Net order value (USD)', unit: 'usd',
    sql: `SELECT COALESCE(material_category,'Other') AS bucket_key,
                 COALESCE(material_category,'Other') AS bucket_label,
                 sum(net_order_value_usd)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('matCat', min(material_category),'notSto',true,'notDeleted',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
           GROUP BY 1,2 ORDER BY 3 DESC NULLS LAST`,
  },
  {
    chartId: 'po_value_by_purch_org', seriesKey: 'value', seriesLabel: 'Net order value (USD)', unit: 'usd',
    sql: `SELECT purch_org AS bucket_key, purch_org AS bucket_label,
                 sum(net_order_value_usd)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('purchOrg', purch_org,'notSto',true,'notDeleted',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
           GROUP BY 1,2 ORDER BY 3 DESC NULLS LAST LIMIT 20`,
  },
  {
    chartId: 'commitment_aging', seriesKey: 'value', seriesLabel: 'Still to deliver (USD)', unit: 'usd',
    sql: `SELECT bk AS bucket_key, bk || ' days' AS bucket_label,
                 sum(v)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('agingBand', bk,'notSto',true,'notDeleted',true,
                                      'hasOpenCommitment',true)) AS drill
            FROM (SELECT CASE WHEN aging_days <= 30 THEN '0-30' WHEN aging_days <= 60 THEN '31-60'
                              WHEN aging_days <= 90 THEN '61-90' WHEN aging_days <= 180 THEN '91-180'
                              ELSE '180+' END AS bk,
                         CASE WHEN aging_days <= 30 THEN 1 WHEN aging_days <= 60 THEN 2
                              WHEN aging_days <= 90 THEN 3 WHEN aging_days <= 180 THEN 4 ELSE 5 END AS ord,
                         still_deliver_val_usd AS v
                    FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
                      AND COALESCE(still_deliver_val,0) > 0) x
           GROUP BY bk, ord ORDER BY ord`,
  },
  {
    chartId: 'delivery_by_category', seriesKey: 'days', seriesLabel: 'Median delivery (days)', unit: 'days',
    sql: `SELECT COALESCE(material_category,'Other') AS bucket_key,
                 COALESCE(material_category,'Other') AS bucket_label,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY delivery_days)::numeric AS value,
                 count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('matCat', min(material_category),'hasReceipt',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND delivery_days IS NOT NULL
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    chartId: 'delivery_by_priority', seriesKey: 'days', seriesLabel: 'Median delivery (days)', unit: 'days',
    sql: `SELECT COALESCE(priority_label,'(unlabelled)') AS bucket_key,
                 COALESCE(priority_label,'(unlabelled)') AS bucket_label,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY delivery_days)::numeric AS value,
                 count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('priorityLabel', min(priority_label),'hasReceipt',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND delivery_days IS NOT NULL
           GROUP BY 1,2 ORDER BY 1`,
  },
  {
    chartId: 'delivery_distribution', seriesKey: 'lines', seriesLabel: 'PO lines', unit: 'count',
    sql: `SELECT ${DIST_BUCKETS} AS bucket_key, ${DIST_BUCKETS} || ' days' AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('hasReceipt',true,'distBucket',
                     jsonb_build_object('measure','delivery','bucket', ${DIST_BUCKETS}))) AS drill
            FROM (SELECT delivery_days AS d FROM ${POL}
                   WHERE dataset_version_id = $1 AND delivery_days IS NOT NULL) x
           GROUP BY 1,2, ${DIST_ORDER} ORDER BY ${DIST_ORDER}`,
  },
  {
    chartId: 'e2e_by_month', seriesKey: 'days', seriesLabel: 'Median end-to-end (days)', unit: 'days',
    sql: `SELECT to_char(pol.document_date,'YYYY-MM') AS bucket_key,
                 to_char(pol.document_date,'Mon YYYY') AS bucket_label,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY pol.receipt_date - pri.requisition_date)::numeric AS value,
                 count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('monthKey', to_char(pol.document_date,'YYYY-MM'),
                                      'hasReceipt',true,'hasPr',true)) AS drill
            FROM ${POL} pol JOIN ${PRI} pri
              ON pri.dataset_version_id = pol.dataset_version_id
             AND pri.pr_no = pol.pr_no AND pri.pr_item = pol.pr_item
           WHERE pol.dataset_version_id = $1 AND pol.receipt_date IS NOT NULL
           GROUP BY 1,2 ORDER BY 1`,
  },
  {
    chartId: 'items_by_category', seriesKey: 'items', seriesLabel: 'PR items', unit: 'count',
    sql: `SELECT COALESCE(material_category,'Other') AS bucket_key,
                 COALESCE(material_category,'Other') AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('matCat', min(material_category),'notDeleted',true)) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    chartId: 'e2e_by_category', seriesKey: 'days', seriesLabel: 'Median end-to-end (days)', unit: 'days',
    // Grouped by the PO line's own category (not the PR's) so the po_line-grain
    // drill opens exactly the aggregated rows. The two categories agree on all
    // but a handful of lines, and self-consistency wins over that nuance.
    sql: `SELECT COALESCE(pol.material_category,'Other') AS bucket_key,
                 COALESCE(pol.material_category,'Other') AS bucket_label,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY pol.receipt_date - pri.requisition_date)::numeric AS value,
                 count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('matCat', min(pol.material_category),
                                      'hasReceipt',true,'hasPr',true)) AS drill
            FROM ${POL} pol JOIN ${PRI} pri
              ON pri.dataset_version_id = pol.dataset_version_id
             AND pri.pr_no = pol.pr_no AND pri.pr_item = pol.pr_item
           WHERE pol.dataset_version_id = $1 AND pol.receipt_date IS NOT NULL
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    chartId: 'top_materials_spend', seriesKey: 'value', seriesLabel: 'Spend (USD)', unit: 'usd',
    sql: `SELECT material_code AS bucket_key,
                 left(COALESCE(max(short_text), material_code), 40) AS bucket_label,
                 sum(net_order_value_usd)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('materialCode', material_code,'notSto',true,'notDeleted',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
              AND material_code IS NOT NULL
           GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 15`,
  },
];

// ────────────────────────────────────────────────────────────────── execution

const KPI_COLS = [
  'dataset_version_id', 'kpi_id', 'company_code', 'plant', 'purch_org', 'status', 'value_num',
  'numerator', 'denominator', 'sample_size', 'unit', 'currency_basis', 'severity',
  'status_reason', 'detail', 'drill_predicate',
] as const;

const CHART_COLS = [
  'dataset_version_id', 'chart_id', 'company_code', 'plant', 'purch_org', 'series_key',
  'series_label', 'bucket_key', 'bucket_label', 'bucket_ordinal', 'value_num', 'row_count',
  'unit', 'currency_basis', 'drill_predicate',
] as const;

function severityOf(spec: KpiSpec, value: number | null): string | null {
  if (value === null) return null;
  if (spec.worseWhenHigh) {
    if (value >= spec.worseWhenHigh.crit) return 'critical';
    if (value >= spec.worseWhenHigh.warn) return 'warning';
    return 'good';
  }
  if (spec.worseWhenLow) {
    if (value <= spec.worseWhenLow.crit) return 'critical';
    if (value <= spec.worseWhenLow.warn) return 'warning';
    return 'good';
  }
  return 'neutral';
}

export async function buildParityMart(client: pg.PoolClient, versionId: number): Promise<void> {
  // ── KPIs ──
  const kpiRows: unknown[][] = [];
  const CORE_COLS = new Set(['value', 'numerator', 'denominator', 'sample']);
  for (const spec of PARITY_KPIS) {
    const r = await client.query<Record<string, unknown>>(spec.sql, [versionId]);
    const row = r.rows[0] ?? { value: null, numerator: null, denominator: null, sample: null };
    const value = row['value'] === null || row['value'] === undefined ? null : Number(row['value']);

    // Any extra columns a spec returns land in the detail jsonb — this is how a
    // card carries its urgency chips (G1.4) without a second query.
    const detail: Record<string, unknown> = spec.entityUnit ? { entityUnit: spec.entityUnit } : {};
    for (const [k, v] of Object.entries(row)) {
      if (!CORE_COLS.has(k) && v !== null && v !== undefined) detail[k] = Number.isNaN(Number(v)) ? v : Number(v);
    }

    kpiRows.push([
      versionId, spec.id, '*', '*', '*',
      // A null value is 'unavailable', never a fabricated zero.
      value === null || Number.isNaN(value) ? 'unavailable' : 'ok',
      value,
      row['numerator'] ?? null,
      row['denominator'] ?? null,
      row['sample'] ?? null,
      spec.unit,
      spec.currencyBasis ?? null,
      severityOf(spec, value),
      value === null ? 'No qualifying rows in scope.' : null,
      Object.keys(detail).length > 0 ? JSON.stringify(detail) : null,
      spec.drill === null ? null : JSON.stringify(spec.drill),
    ]);
  }
  await insertMany(client, 'mart.kpi_value', KPI_COLS, kpiRows);

  // ── charts ──
  const chartRows: unknown[][] = [];
  for (const spec of PARITY_CHARTS) {
    const r = await client.query<{
      bucket_key: string; bucket_label: string; value: number | null;
      row_count: number; drill: Record<string, unknown>;
    }>(spec.sql, [versionId]);
    r.rows.forEach((x, i) => {
      chartRows.push([
        versionId, spec.chartId, '*', '*', '*', spec.seriesKey, spec.seriesLabel,
        x.bucket_key ?? '(none)', x.bucket_label ?? '(none)', i + 1,
        x.value === null ? null : Number(x.value),
        x.row_count, spec.unit, null, JSON.stringify(x.drill),
      ]);
    });
  }
  await insertMany(client, 'mart.chart_series', CHART_COLS, chartRows);
}
