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
import { sizeBandLabelSql } from '@pct/rules';
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
    sql: `SELECT sum(still_deliver_val_usd) AS value,
                 CASE WHEN count(*) FILTER (WHERE still_deliver_val IS NOT NULL AND still_deliver_val_idr IS NULL) > 0
                      THEN NULL ELSE sum(still_deliver_val_idr) END AS value_idr,
                 count(*)::int AS sample
            FROM ${POL} WHERE dataset_version_id = $1
             AND NOT is_sto AND NOT is_deleted AND COALESCE(still_deliver_val,0) > 0`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true, hasOpenCommitment: true } },
  },
  {
    id: 'grir_value',
    unit: 'usd',
    currencyBasis: 'usd_strict',
    sql: `SELECT sum(still_invoice_val_usd) AS value,
                 CASE WHEN count(*) FILTER (WHERE still_invoice_val IS NOT NULL AND still_invoice_val_idr IS NULL) > 0
                      THEN NULL ELSE sum(still_invoice_val_idr) END AS value_idr,
                 count(*)::int AS sample
            FROM ${POL} WHERE dataset_version_id = $1
             AND NOT is_sto AND NOT is_deleted
             AND COALESCE(still_deliver_qty,0) = 0 AND COALESCE(still_invoice_val,0) > 0`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true, grirOpen: true } },
  },
  {
    id: 'delivered_not_invoiced',
    unit: 'usd',
    currencyBasis: 'usd_strict',
    sql: `SELECT sum(still_invoice_val_usd) AS value,
                 CASE WHEN count(*) FILTER (WHERE still_invoice_val IS NOT NULL AND still_invoice_val_idr IS NULL) > 0
                      THEN NULL ELSE sum(still_invoice_val_idr) END AS value_idr,
                 count(*)::int AS sample
            FROM ${POL} WHERE dataset_version_id = $1
             AND NOT is_sto AND NOT is_deleted
             AND COALESCE(still_deliver_qty,0) = 0 AND COALESCE(still_invoice_val,0) > 0`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true, grirOpen: true } },
  },
  {
    // Headline in strict USD to sit beside the other exec money cards; the
    // source-of-truth IDR total rides in the detail (PR valuations are IDR).
    // Strict rule: any unrated row nulls the USD figure rather than
    // understating it.
    id: 'pr_pipeline_value',
    unit: 'usd',
    currencyBasis: 'usd_strict',
    sql: `SELECT CASE WHEN count(*) FILTER (WHERE total_value_idr IS NOT NULL AND total_value_usd IS NULL) > 0
                      THEN NULL ELSE sum(total_value_usd) END AS value,
                 sum(total_value_idr) AS idr_total,
                 sum(total_value_idr) AS value_idr,
                 count(*)::int AS sample
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
    sql: `SELECT count(*)::int AS value,
                 count(*) FILTER (WHERE urgency <= 1)::int AS chip_emergency,
                 count(*) FILTER (WHERE urgency = 2)::int AS chip_urgent,
                 count(*) FILTER (WHERE COALESCE(urgency, 9) >= 3)::int AS chip_standard
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted`,
    drill: { grain: 'pr_item', filters: { notDeleted: true } },
  },
  {
    id: 'delivered_gr',
    unit: 'count',
    // v1's card sub-details: complete vs partial, and the raw GR/PR quantity
    // compare. The quantity ratio raw-sums across units of measure exactly as
    // v1 does — indicative only, and labelled so in the UI.
    sql: `SELECT count(*)::int AS value,
                 count(*) FILTER (WHERE status = 'Delivered')::int AS gr_complete,
                 count(*) FILTER (WHERE status = 'Partially Delivered')::int AS gr_partial,
                 sum(receipt_qty_net) AS qty_gr,
                 (SELECT sum(qty_requested) FROM ${PRI}
                   WHERE dataset_version_id = $1 AND NOT is_deleted) AS qty_pr
            FROM ${POL}
           WHERE dataset_version_id = $1/*F*/ AND receipt_date IS NOT NULL`,
    drill: { grain: 'po_line', filters: { hasReceipt: true } },
  },

  // ── Open Items ──
  {
    id: 'pr_not_approved',
    unit: 'count',
    sql: `SELECT count(*)::int AS value,
                 avg(aging_days)::numeric(8,1) AS avg_wait,
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
                 avg(aging_days)::numeric(8,1) AS avg_wait,
                 count(*) FILTER (WHERE urgency <= 1)::int AS chip_emergency,
                 count(*) FILTER (WHERE urgency = 2)::int AS chip_urgent,
                 count(*) FILTER (WHERE COALESCE(urgency, 9) >= 3)::int AS chip_standard FROM ${PRI}
           WHERE dataset_version_id = $1 AND status = 'PR Approved-No PO'`,
    drill: { grain: 'pr_item', filters: { status: 'PR Approved-No PO' } },
  },
  {
    // Lines on hold, like v1's op-page card — the chips must sum to the
    // headline. The distinct-document count rides along as the sub-detail.
    id: 'po_hold',
    unit: 'count',
    sql: `SELECT count(*)::int AS value,
                 count(DISTINCT po_no)::int AS numerator,
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
                 avg(po_approval_days)::numeric(8,1) AS avg_po_appr,
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
    // v1's op-page "Open PR w/o WBS", v1-exact: AR-required violations that are
    // open in v1's sense — no PO yet, or POs unapproved/held/awaiting GR with NO
    // goods receipt anywhere on the item (v1 marks a row Delivered on ANY GR).
    // Verified against v1 at full scope: 186 PRs exactly; 594 vs 599 items (v1
    // judges multi-PO items by its first file row only — see V1_V2_Parity_Matrix).
    id: 'open_pr_no_wbs',
    unit: 'count',
    sql: `SELECT count(*)::int AS value,
                 count(DISTINCT pr_no)::int AS numerator,
                 sum(total_value_idr) AS chip_value_idr
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted
             AND wbs_status = 'violation'
             AND (status IN ('Unapproved PR','PR Approved-No PO')
                  OR (EXISTS (SELECT 1 FROM ${POL} _pl
                               WHERE _pl.dataset_version_id = ${PRI}.dataset_version_id
                                 AND _pl.pr_no = ${PRI}.pr_no AND _pl.pr_item = ${PRI}.pr_item
                                 AND _pl.status IN ('PO-Not Approved','HOLD PO','PO-No GR'))
                      AND NOT EXISTS (SELECT 1 FROM ${POL} _pl2
                               WHERE _pl2.dataset_version_id = ${PRI}.dataset_version_id
                                 AND _pl2.pr_no = ${PRI}.pr_no AND _pl2.pr_item = ${PRI}.pr_item
                                 AND _pl2.status IN ('Delivered','Partially Delivered'))))`,
    drill: { grain: 'pr_item', filters: { notDeleted: true, wbsStatus: 'violation', openBeforeGr: true } },
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
    sql: `SELECT sum(net_order_value_usd) AS value,
                 CASE WHEN count(*) FILTER (WHERE net_order_value IS NOT NULL AND net_order_value_idr IS NULL) > 0
                      THEN NULL ELSE sum(net_order_value_idr) END AS value_idr, count(*)::int AS sample FROM ${POL}
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

  // ── Executive Summary (020) ──
  //
  // The page makes two claims and these KPIs are those claims, computed rather
  // than asserted in prose. The reference design stated them as static text
  // ("top 5 = 70%", "72% of lines < Rp 25 Jt = 4% of value"), which is how a
  // slide goes stale silently.
  //
  // Every one uses the same purchase population as total_po_amount — NOT is_sto
  // AND NOT is_deleted — so a tile and the value chart beside it can never
  // disagree about what "committed value" counts.
  {
    id: 'active_purch_groups',
    entityUnit: 'desks',
    unit: 'count',
    sql: `SELECT count(DISTINCT purch_group)::int AS value FROM ${POL}
           WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
             AND purch_group IS NOT NULL AND btrim(purch_group) <> ''`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
  },
  {
    // How few desks hold most of the value. This replaces the reference design's
    // "HO 92% of value" panel, which cannot be reproduced here: NO Head-Office
    // purchasing group appears in this entity's orders at all, so an HO/UNIT
    // split computes to 2%/98% and would tell the reader the opposite of the
    // truth. Desk concentration carries the same strategic point — a few desks
    // control the money, many run the paperwork — and is measurable.
    id: 'desks_for_80pct_value',
    entityUnit: 'desks',
    unit: 'count',
    sql: `WITH d AS (
            SELECT purch_group, sum(net_order_value_idr) AS v FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
               AND purch_group IS NOT NULL AND btrim(purch_group) <> ''
             GROUP BY 1
          ), c AS (
            SELECT sum(v) OVER (ORDER BY v DESC NULLS LAST
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                   / NULLIF((SELECT sum(v) FROM d), 0) AS cum
              FROM d
          )
          SELECT (count(*) FILTER (WHERE cum < 0.8) + 1)::int AS value,
                 count(*)::int AS sample FROM c`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
  },
  {
    id: 'vendors_for_80pct_value',
    entityUnit: 'vendors',
    unit: 'count',
    sql: `WITH d AS (
            SELECT vendor_code, sum(net_order_value_idr) AS v FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
               AND vendor_code IS NOT NULL
             GROUP BY 1
          ), c AS (
            SELECT sum(v) OVER (ORDER BY v DESC NULLS LAST
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                   / NULLIF((SELECT sum(v) FROM d), 0) AS cum
              FROM d
          )
          SELECT (count(*) FILTER (WHERE cum < 0.8) + 1)::int AS value,
                 count(*)::int AS sample FROM c`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
  },
  {
    id: 'top5_category_share_pct',
    unit: 'percent',
    currencyBasis: 'idr_based',
    sql: `WITH c AS (
            SELECT spend_category, sum(net_order_value_idr) AS v FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
               AND spend_category IS NOT NULL
             GROUP BY 1
          ), r AS (
            SELECT v, row_number() OVER (ORDER BY v DESC NULLS LAST) AS rn FROM c
          )
          SELECT 100.0 * COALESCE(sum(v) FILTER (WHERE rn <= 5), 0)
                 / NULLIF(sum(v), 0) AS value, count(*)::int AS sample FROM r`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
  },
  {
    // The fragmentation pair. Two KPIs rather than one sentence, because the
    // whole argument is that these two numbers are far apart: a large share of
    // the lines carries a tiny share of the value. Bands 5, 6 and 7 are
    // everything below Rp 25 Jt (packages/rules/src/size_band.ts).
    id: 'lines_under_25jt_pct',
    unit: 'percent',
    sql: `SELECT 100.0 * count(*) FILTER (WHERE size_band IN ('5','6','7'))
                 / NULLIF(count(*), 0) AS value, count(*)::int AS sample
            FROM ${POL}
           WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
             AND size_band IS NOT NULL`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
  },
  {
    id: 'value_under_25jt_pct',
    unit: 'percent',
    currencyBasis: 'idr_based',
    sql: `SELECT 100.0 * COALESCE(sum(net_order_value_idr)
                   FILTER (WHERE size_band IN ('5','6','7')), 0)
                 / NULLIF(sum(net_order_value_idr), 0) AS value, count(*)::int AS sample
            FROM ${POL}
           WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
             AND size_band IS NOT NULL`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
  },

  {
    // The reference design's "control versus execution": Head Office holds the
    // money, sites run the paperwork.
    //
    // Keyed on purchasing ORGANISATION, not purchasing group. 020 checked it on
    // dim_purch_group.is_ho, got 2% against 98%, concluded the split could not be
    // measured here and dropped the panel. That was the wrong column: the group
    // is the buyer's desk, the organisation is the HQ-versus-site distinction.
    // On the right column it is 98.3% of value and 73% of lines, matching the
    // design's 92% / 51% in shape and magnitude.
    //
    // LEFT JOIN with COALESCE(false): an organisation missing from the master is
    // counted as non-HQ rather than dropped, so the two shares always sum with
    // the whole population and cannot quietly exclude rows.
    id: 'ho_share_value_pct',
    unit: 'percent',
    currencyBasis: 'idr_based',
    sql: `SELECT 100.0 * COALESCE(sum(f.net_order_value_idr)
                   FILTER (WHERE COALESCE(o.is_ho, false)), 0)
                 / NULLIF(sum(f.net_order_value_idr), 0) AS value,
                 count(*)::int AS sample
            FROM ${POL} f
            LEFT JOIN core.dim_purch_org o ON o.code = f.purch_org
           WHERE f.dataset_version_id = $1 AND NOT f.is_sto AND NOT f.is_deleted`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
  },
  {
    id: 'ho_share_lines_pct',
    unit: 'percent',
    sql: `SELECT 100.0 * count(*) FILTER (WHERE COALESCE(o.is_ho, false))
                 / NULLIF(count(*), 0) AS value, count(*)::int AS sample
            FROM ${POL} f
            LEFT JOIN core.dim_purch_org o ON o.code = f.purch_org
           WHERE f.dataset_version_id = $1 AND NOT f.is_sto AND NOT f.is_deleted`,
    drill: { grain: 'po_line', filters: { notSto: true, notDeleted: true } },
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
                 CASE WHEN count(*) FILTER (WHERE total_value_idr IS NOT NULL AND total_value_usd IS NULL) > 0
                      THEN NULL
                      ELSE sum(total_value_usd) / NULLIF(count(*) FILTER (WHERE COALESCE(total_value_idr,0) > 0), 0) END AS value_usd,
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
                 CASE WHEN count(*) FILTER (WHERE net_order_value IS NOT NULL AND net_order_value_usd IS NULL) > 0
                      THEN NULL
                      ELSE sum(net_order_value_usd) / NULLIF(count(DISTINCT po_no), 0) END AS value_usd,
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
                 CASE WHEN count(*) FILTER (WHERE net_order_value IS NOT NULL AND net_order_value_idr IS NULL) > 0
                      THEN NULL
                      ELSE sum(net_order_value_idr) / NULLIF(count(DISTINCT po_no), 0) END AS value_idr,
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
                 CASE WHEN count(*) FILTER (WHERE p.net_order_value IS NOT NULL AND p.net_order_value_usd IS NULL) > 0
                      THEN NULL ELSE sum(p.net_order_value_usd) END AS value_usd,
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
          SELECT max(med) AS value,
                 (SELECT count(*)::int FROM core.fact_pr_release r
                    JOIN ${PRI} i ON i.dataset_version_id = r.dataset_version_id
                                 AND i.pr_no = r.pr_no AND i.pr_item = r.pr_item
                   WHERE r.dataset_version_id = $1
                     AND r.approve_date IS NOT NULL AND i.requisition_date IS NOT NULL) AS sample,
                 (SELECT pic_release FROM g ORDER BY med DESC LIMIT 1) AS worst_pic
            FROM g`,
    drill: { grain: 'pr_release', filters: { gapEvaluable: true } },
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
    // v1's 'Urgent PO (PO before PR)': PO document date earlier than the
    // requisition date — the PO was raised before the demand was recorded.
    // Distinct from retro_po_rate, which compares against PR APPROVAL.
    id: 'urgent_po_before_pr',
    unit: 'count',
    sql: `SELECT count(*)::int AS value,
                 count(*) FILTER (WHERE pol.urgency <= 1)::int AS chip_emergency,
                 count(*) FILTER (WHERE pol.urgency = 2)::int AS chip_urgent,
                 count(*) FILTER (WHERE COALESCE(pol.urgency, 9) >= 3)::int AS chip_standard
            FROM ${POL} pol JOIN ${PRI} pri
              ON pri.dataset_version_id = pol.dataset_version_id
             AND pri.pr_no = pol.pr_no AND pri.pr_item = pol.pr_item
           WHERE pol.dataset_version_id = $1 AND NOT pol.is_deleted
             AND pol.document_date < pri.requisition_date`,
    drill: { grain: 'po_line', filters: { notDeleted: true, poBeforePr: true } },
  },
  {
    // The counter of Open PR w/o WBS: same v1-open rule, but the WBS is filled.
    id: 'open_pr_with_wbs',
    unit: 'count',
    sql: `SELECT count(*)::int AS value,
                 count(DISTINCT pr_no)::int AS numerator,
                 sum(total_value_idr) AS chip_value_idr
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted
             AND wbs_status = 'compliant'
             AND (status IN ('Unapproved PR','PR Approved-No PO')
                  OR (EXISTS (SELECT 1 FROM ${POL} _pl
                               WHERE _pl.dataset_version_id = ${PRI}.dataset_version_id
                                 AND _pl.pr_no = ${PRI}.pr_no AND _pl.pr_item = ${PRI}.pr_item
                                 AND _pl.status IN ('PO-Not Approved','HOLD PO','PO-No GR'))
                      AND NOT EXISTS (SELECT 1 FROM ${POL} _pl2
                               WHERE _pl2.dataset_version_id = ${PRI}.dataset_version_id
                                 AND _pl2.pr_no = ${PRI}.pr_no AND _pl2.pr_item = ${PRI}.pr_item
                                 AND _pl2.status IN ('Delivered','Partially Delivered'))))`,
    drill: { grain: 'pr_item', filters: { notDeleted: true, wbsStatus: 'compliant', openBeforeGr: true } },
  },
  {
    // v1's pr-md card: median created -> fully-approved days, over the same
    // population as cycle_pr_approval (its subtitle median, promoted to a card).
    id: 'median_pr_approval',
    unit: 'days',
    sql: `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (release_final_date - requisition_date)) AS value,
                 count(*)::int AS sample
            FROM ${PRI} WHERE dataset_version_id = $1
             AND release_final_date IS NOT NULL AND requisition_date IS NOT NULL
             AND (release_final_date - requisition_date) >= 0`,
    drill: { grain: 'pr_item', filters: { released: true } },
  },
  {
    // v1's pr-alt card: median of SAP's own 'Approved Lead Time - PR Created'
    // over approved release steps with a positive lead, scoped like v1 to
    // steps whose PR exists in the item feed. Kept alongside cycle_pr_approval
    // (date-derived) rather than replacing it - two bases, both labelled.
    id: 'pr_approval_lead_time',
    unit: 'days',
    sql: `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.lead_days) AS value,
                 count(*)::int AS sample
            FROM core.fact_pr_release r
            JOIN ${PRI} i ON i.dataset_version_id = r.dataset_version_id
                         AND i.pr_no = r.pr_no AND i.pr_item = r.pr_item
           WHERE r.dataset_version_id = $1
             AND r.approve_date IS NOT NULL AND r.lead_days > 0`,
    drill: { grain: 'pr_release', filters: { apprLeadEvaluable: true } },
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
  /**
   * Table alias the global-filter clause must qualify, when this SERIES joins two
   * facts. Per-series, not per-chart: aging_by_priority's first series is a
   * single-table query on fact_pr_item (no alias) while its second joins pol to
   * pri and needs 'pol.'. A chart-level alias cannot be right for both, and
   * before all series were computed under a filter only the first ever ran, so
   * the mismatch was invisible.
   */
  filterAlias?: string;
}

/** Six PO-approval bands (user decision 4 Aug 2026), same-day first. */
const APPR6_BUCKET = `CASE WHEN d <= 0 THEN '0d' WHEN d <= 3 THEN '1-3d' WHEN d <= 7 THEN '4-7d'
                           WHEN d <= 14 THEN '8-14d' WHEN d <= 30 THEN '15-30d' ELSE '>30d' END`;
const APPR6_ORDER = `CASE WHEN d <= 0 THEN 1 WHEN d <= 3 THEN 2 WHEN d <= 7 THEN 3
                          WHEN d <= 14 THEN 4 WHEN d <= 30 THEN 5 ELSE 6 END`;

/** v1's four Open-Items age bands, ordered oldest-first like v1. */
const AGE4_BUCKET = `CASE WHEN aging_days > 90 THEN '>90' WHEN aging_days > 30 THEN '31-90'
                          WHEN aging_days > 15 THEN '15-30' ELSE '0-15' END`;
const AGE4_ORDER = `CASE WHEN aging_days > 90 THEN 1 WHEN aging_days > 30 THEN 2
                         WHEN aging_days > 15 THEN 3 ELSE 4 END`;

/** Aging/lead-time histogram buckets, matching v1's distribution charts. */
const DIST_BUCKETS = `CASE WHEN d <= 3 THEN '0-3' WHEN d <= 7 THEN '4-7' WHEN d <= 14 THEN '8-14'
                           WHEN d <= 30 THEN '15-30' WHEN d <= 60 THEN '31-60' ELSE '60+' END`;
const DIST_ORDER = `CASE WHEN d <= 3 THEN 1 WHEN d <= 7 THEN 2 WHEN d <= 14 THEN 3
                         WHEN d <= 30 THEN 4 WHEN d <= 60 THEN 5 ELSE 6 END`;

export const PARITY_CHARTS: ChartSpec[] = [
  // ── Executive Summary charts (022) ──
  //
  // These exist HERE, not only in mart.ts, because a chart is only filterable if
  // it has a live spec: liveChartAvailable() consults this registry, and without
  // an entry the global filter bar silently does nothing to the panel. That was
  // the state on the Executive Summary until now.
  //
  // Each category and each size band splits into OPEN (status <> 'Delivered')
  // and CLOSED (status = 'Delivered'). Stacked, the two segments still sum to the
  // bucket's total, so the ranking and the share the panel is read for survive
  // the split rather than being replaced by it.
  //
  // The percentage denominators use window functions over the SAME filtered CTE,
  // so under a filter the shares are shares OF THE FILTERED POPULATION. Taking
  // them from the precomputed total instead would make a filtered panel's bars
  // sum to something other than 100% with no indication why.
  {
    chartId: 'exec_txn_size', seriesKey: 'open_value', seriesLabel: 'Open — % of value', unit: 'percent',
    sql: `WITH b AS (
            SELECT size_band, status, net_order_value_idr AS v
              FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
               AND size_band IS NOT NULL
          ), g AS (
            SELECT size_band,
                   COALESCE(sum(v) FILTER (WHERE status <> 'Delivered'), 0)::numeric AS part,
                   count(*) FILTER (WHERE status <> 'Delivered')::int AS n,
                   sum(sum(v)) OVER () AS total_v,
                   sum(count(*)) OVER () AS total_n
              FROM b GROUP BY 1
          )
          SELECT size_band AS bucket_key,
                 ${sizeBandLabelSql('size_band')} AS bucket_label,
                 CASE WHEN total_v > 0 THEN 100.0 * part / total_v ELSE 0 END AS value,
                 n AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('sizeBand', size_band,
                                      'delivered', false,
                                      'notSto', true, 'notDeleted', true)) AS drill
            FROM g ORDER BY size_band`,
  },
  {
    chartId: 'exec_txn_size', seriesKey: 'closed_value', seriesLabel: 'Closed — % of value', unit: 'percent',
    sql: `WITH b AS (
            SELECT size_band, status, net_order_value_idr AS v
              FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
               AND size_band IS NOT NULL
          ), g AS (
            SELECT size_band,
                   COALESCE(sum(v) FILTER (WHERE status = 'Delivered'), 0)::numeric AS part,
                   count(*) FILTER (WHERE status = 'Delivered')::int AS n,
                   sum(sum(v)) OVER () AS total_v,
                   sum(count(*)) OVER () AS total_n
              FROM b GROUP BY 1
          )
          SELECT size_band AS bucket_key,
                 ${sizeBandLabelSql('size_band')} AS bucket_label,
                 CASE WHEN total_v > 0 THEN 100.0 * part / total_v ELSE 0 END AS value,
                 n AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('sizeBand', size_band,
                                      'delivered', true,
                                      'notSto', true, 'notDeleted', true)) AS drill
            FROM g ORDER BY size_band`,
  },
  {
    chartId: 'exec_txn_size', seriesKey: 'open_lines', seriesLabel: 'Open — % of lines', unit: 'percent',
    sql: `WITH b AS (
            SELECT size_band, status, net_order_value_idr AS v
              FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
               AND size_band IS NOT NULL
          ), g AS (
            SELECT size_band,
                   count(*) FILTER (WHERE status <> 'Delivered')::numeric AS part,
                   count(*) FILTER (WHERE status <> 'Delivered')::int AS n,
                   sum(sum(1)) OVER () AS total_v,
                   sum(count(*)) OVER () AS total_n
              FROM b GROUP BY 1
          )
          SELECT size_band AS bucket_key,
                 ${sizeBandLabelSql('size_band')} AS bucket_label,
                 CASE WHEN total_n > 0 THEN 100.0 * part / total_n ELSE 0 END AS value,
                 n AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('sizeBand', size_band,
                                      'delivered', false,
                                      'notSto', true, 'notDeleted', true)) AS drill
            FROM g ORDER BY size_band`,
  },
  {
    chartId: 'exec_txn_size', seriesKey: 'closed_lines', seriesLabel: 'Closed — % of lines', unit: 'percent',
    sql: `WITH b AS (
            SELECT size_band, status, net_order_value_idr AS v
              FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
               AND size_band IS NOT NULL
          ), g AS (
            SELECT size_band,
                   count(*) FILTER (WHERE status = 'Delivered')::numeric AS part,
                   count(*) FILTER (WHERE status = 'Delivered')::int AS n,
                   sum(sum(1)) OVER () AS total_v,
                   sum(count(*)) OVER () AS total_n
              FROM b GROUP BY 1
          )
          SELECT size_band AS bucket_key,
                 ${sizeBandLabelSql('size_band')} AS bucket_label,
                 CASE WHEN total_n > 0 THEN 100.0 * part / total_n ELSE 0 END AS value,
                 n AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('sizeBand', size_band,
                                      'delivered', true,
                                      'notSto', true, 'notDeleted', true)) AS drill
            FROM g ORDER BY size_band`,
  },
  {
    chartId: 'exec_value_by_category', seriesKey: 'open', seriesLabel: 'Open', unit: 'idr',
    sql: `WITH b AS (
            SELECT spend_category, status, net_order_value_idr AS v
              FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
               AND spend_category IS NOT NULL
          )
          SELECT spend_category AS bucket_key, spend_category AS bucket_label,
                 COALESCE(sum(v) FILTER (WHERE status <> 'Delivered'), 0)::numeric AS value,
                 count(*) FILTER (WHERE status <> 'Delivered')::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('spendCategory', min(spend_category),
                                      'delivered', false,
                                      'notSto', true, 'notDeleted', true)) AS drill
            FROM b GROUP BY 1,2 ORDER BY 1`,
  },
  {
    chartId: 'exec_value_by_category', seriesKey: 'closed', seriesLabel: 'Closed', unit: 'idr',
    sql: `WITH b AS (
            SELECT spend_category, status, net_order_value_idr AS v
              FROM ${POL}
             WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
               AND spend_category IS NOT NULL
          )
          SELECT spend_category AS bucket_key, spend_category AS bucket_label,
                 COALESCE(sum(v) FILTER (WHERE status = 'Delivered'), 0)::numeric AS value,
                 count(*) FILTER (WHERE status = 'Delivered')::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('spendCategory', min(spend_category),
                                      'delivered', true,
                                      'notSto', true, 'notDeleted', true)) AS drill
            FROM b GROUP BY 1,2 ORDER BY 1`,
  },
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
  // v1's 'Avg Aging by Priority (days)': grouped bars, PR Approval + E2E.
  {
    chartId: 'aging_by_priority', seriesKey: 'pr_approval', seriesLabel: 'PR Approval', unit: 'days',
    sql: `SELECT COALESCE(priority_label,'(unlabelled)') AS bucket_key,
                 COALESCE(priority_label,'(unlabelled)') AS bucket_label,
                 avg(release_final_date - requisition_date)::numeric(8,1) AS value,
                 count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('priorityLabel', min(priority_label), 'released', true)) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND release_final_date IS NOT NULL
           GROUP BY 1,2 ORDER BY 1`,
  },
  {
    chartId: 'aging_by_priority', seriesKey: 'e2e', seriesLabel: 'E2E', unit: 'days',
    filterAlias: 'pol.',
    sql: `SELECT COALESCE(pol.priority_label,'(unlabelled)') AS bucket_key,
                 COALESCE(pol.priority_label,'(unlabelled)') AS bucket_label,
                 avg(pol.receipt_date - pri.requisition_date)::numeric(8,1) AS value,
                 count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('priorityLabel', min(pol.priority_label), 'hasReceipt', true, 'hasPr', true)) AS drill
            FROM ${POL} pol JOIN ${PRI} pri
              ON pri.dataset_version_id = pol.dataset_version_id
             AND pri.pr_no = pol.pr_no AND pri.pr_item = pol.pr_item
           WHERE pol.dataset_version_id = $1 AND pol.receipt_date IS NOT NULL
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
    // v1's buckets and v1's order: oldest first (>90d ... 0-15d).
    chartId: 'unreleased_aging_buckets', seriesKey: 'items', seriesLabel: 'Unreleased PR items', unit: 'count',
    sql: `SELECT ${AGE4_BUCKET} AS bucket_key, ${AGE4_BUCKET} || 'd' AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('unreleased',true,'notDeleted',true,
                     'ageBand4', ${AGE4_BUCKET})) AS drill
            FROM (SELECT aging_days FROM ${PRI}
                   WHERE dataset_version_id = $1 AND release_final_date IS NULL AND NOT is_deleted
                     AND aging_days IS NOT NULL) x
           GROUP BY 1,2, ${AGE4_ORDER} ORDER BY ${AGE4_ORDER}`,
  },
  // v1's 'Aging Severity by Open Stage': item counts in age bands, one series
  // per band, grouped by open stage. PR stages count PR items; PO stages count
  // PO lines — each point's drill carries its own grain.
  {
    chartId: 'aging_severity_by_stage', seriesKey: 'b0_15', seriesLabel: '0-15d', unit: 'count',
    sql: `SELECT s.bucket_key, s.bucket_label, s.value, s.row_count, s.drill FROM (
            SELECT CASE status WHEN 'Unapproved PR' THEN 'PR Not Appr' ELSE 'No PO' END AS bucket_key,
                   CASE status WHEN 'Unapproved PR' THEN 'PR Not Appr' ELSE 'No PO' END AS bucket_label,
                   CASE status WHEN 'Unapproved PR' THEN 1 ELSE 2 END AS ord,
                   count(*)::numeric AS value, count(*)::int AS row_count,
                   jsonb_build_object('grain','pr_item','filters',
                     jsonb_build_object('status', status, 'ageBand4', '0-15')) AS drill
              FROM ${PRI} WHERE dataset_version_id = $1
               AND status IN ('Unapproved PR','PR Approved-No PO') AND aging_days <= 15
             GROUP BY status
            UNION ALL
            SELECT CASE status WHEN 'HOLD PO' THEN 'PO Hold' WHEN 'PO-Not Approved' THEN 'PO Not Appr' ELSE 'No GR' END,
                   CASE status WHEN 'HOLD PO' THEN 'PO Hold' WHEN 'PO-Not Approved' THEN 'PO Not Appr' ELSE 'No GR' END,
                   CASE status WHEN 'HOLD PO' THEN 3 WHEN 'PO-Not Approved' THEN 4 ELSE 5 END,
                   count(*)::numeric, count(*)::int,
                   jsonb_build_object('grain','po_line','filters',
                     jsonb_build_object('status', status, 'ageBand4', '0-15'))
              FROM ${POL} WHERE dataset_version_id = $1
               AND status IN ('HOLD PO','PO-Not Approved','PO-No GR') AND aging_days <= 15
             GROUP BY status
          ) s ORDER BY s.ord`,
  },
  {
    chartId: 'aging_severity_by_stage', seriesKey: 'b15_30', seriesLabel: '15-30d', unit: 'count',
    sql: `SELECT s.bucket_key, s.bucket_label, s.value, s.row_count, s.drill FROM (
            SELECT CASE status WHEN 'Unapproved PR' THEN 'PR Not Appr' ELSE 'No PO' END AS bucket_key,
                   CASE status WHEN 'Unapproved PR' THEN 'PR Not Appr' ELSE 'No PO' END AS bucket_label,
                   CASE status WHEN 'Unapproved PR' THEN 1 ELSE 2 END AS ord,
                   count(*)::numeric AS value, count(*)::int AS row_count,
                   jsonb_build_object('grain','pr_item','filters',
                     jsonb_build_object('status', status, 'ageBand4', '15-30')) AS drill
              FROM ${PRI} WHERE dataset_version_id = $1
               AND status IN ('Unapproved PR','PR Approved-No PO') AND aging_days > 15 AND aging_days <= 30
             GROUP BY status
            UNION ALL
            SELECT CASE status WHEN 'HOLD PO' THEN 'PO Hold' WHEN 'PO-Not Approved' THEN 'PO Not Appr' ELSE 'No GR' END,
                   CASE status WHEN 'HOLD PO' THEN 'PO Hold' WHEN 'PO-Not Approved' THEN 'PO Not Appr' ELSE 'No GR' END,
                   CASE status WHEN 'HOLD PO' THEN 3 WHEN 'PO-Not Approved' THEN 4 ELSE 5 END,
                   count(*)::numeric, count(*)::int,
                   jsonb_build_object('grain','po_line','filters',
                     jsonb_build_object('status', status, 'ageBand4', '15-30'))
              FROM ${POL} WHERE dataset_version_id = $1
               AND status IN ('HOLD PO','PO-Not Approved','PO-No GR') AND aging_days > 15 AND aging_days <= 30
             GROUP BY status
          ) s ORDER BY s.ord`,
  },
  {
    chartId: 'aging_severity_by_stage', seriesKey: 'b31_90', seriesLabel: '31-90d', unit: 'count',
    sql: `SELECT s.bucket_key, s.bucket_label, s.value, s.row_count, s.drill FROM (
            SELECT CASE status WHEN 'Unapproved PR' THEN 'PR Not Appr' ELSE 'No PO' END AS bucket_key,
                   CASE status WHEN 'Unapproved PR' THEN 'PR Not Appr' ELSE 'No PO' END AS bucket_label,
                   CASE status WHEN 'Unapproved PR' THEN 1 ELSE 2 END AS ord,
                   count(*)::numeric AS value, count(*)::int AS row_count,
                   jsonb_build_object('grain','pr_item','filters',
                     jsonb_build_object('status', status, 'ageBand4', '31-90')) AS drill
              FROM ${PRI} WHERE dataset_version_id = $1
               AND status IN ('Unapproved PR','PR Approved-No PO') AND aging_days > 30 AND aging_days <= 90
             GROUP BY status
            UNION ALL
            SELECT CASE status WHEN 'HOLD PO' THEN 'PO Hold' WHEN 'PO-Not Approved' THEN 'PO Not Appr' ELSE 'No GR' END,
                   CASE status WHEN 'HOLD PO' THEN 'PO Hold' WHEN 'PO-Not Approved' THEN 'PO Not Appr' ELSE 'No GR' END,
                   CASE status WHEN 'HOLD PO' THEN 3 WHEN 'PO-Not Approved' THEN 4 ELSE 5 END,
                   count(*)::numeric, count(*)::int,
                   jsonb_build_object('grain','po_line','filters',
                     jsonb_build_object('status', status, 'ageBand4', '31-90'))
              FROM ${POL} WHERE dataset_version_id = $1
               AND status IN ('HOLD PO','PO-Not Approved','PO-No GR') AND aging_days > 30 AND aging_days <= 90
             GROUP BY status
          ) s ORDER BY s.ord`,
  },
  {
    chartId: 'aging_severity_by_stage', seriesKey: 'b90p', seriesLabel: '>90d', unit: 'count',
    sql: `SELECT s.bucket_key, s.bucket_label, s.value, s.row_count, s.drill FROM (
            SELECT CASE status WHEN 'Unapproved PR' THEN 'PR Not Appr' ELSE 'No PO' END AS bucket_key,
                   CASE status WHEN 'Unapproved PR' THEN 'PR Not Appr' ELSE 'No PO' END AS bucket_label,
                   CASE status WHEN 'Unapproved PR' THEN 1 ELSE 2 END AS ord,
                   count(*)::numeric AS value, count(*)::int AS row_count,
                   jsonb_build_object('grain','pr_item','filters',
                     jsonb_build_object('status', status, 'ageBand4', '>90')) AS drill
              FROM ${PRI} WHERE dataset_version_id = $1
               AND status IN ('Unapproved PR','PR Approved-No PO') AND aging_days > 90
             GROUP BY status
            UNION ALL
            SELECT CASE status WHEN 'HOLD PO' THEN 'PO Hold' WHEN 'PO-Not Approved' THEN 'PO Not Appr' ELSE 'No GR' END,
                   CASE status WHEN 'HOLD PO' THEN 'PO Hold' WHEN 'PO-Not Approved' THEN 'PO Not Appr' ELSE 'No GR' END,
                   CASE status WHEN 'HOLD PO' THEN 3 WHEN 'PO-Not Approved' THEN 4 ELSE 5 END,
                   count(*)::numeric, count(*)::int,
                   jsonb_build_object('grain','po_line','filters',
                     jsonb_build_object('status', status, 'ageBand4', '>90'))
              FROM ${POL} WHERE dataset_version_id = $1
               AND status IN ('HOLD PO','PO-Not Approved','PO-No GR') AND aging_days > 90
             GROUP BY status
          ) s ORDER BY s.ord`,
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
    // Buckets per user decision 4 Aug 2026: 0d / 1-3d / 4-7d / 8-14d / 15-30d
    // / >30d - same-day approvals get their own bar.
    chartId: 'po_approval_distribution', seriesKey: 'lines', seriesLabel: 'PO lines', unit: 'count',
    sql: `SELECT ${APPR6_BUCKET} AS bucket_key, ${APPR6_BUCKET} AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('notSto',true,'distBucket',
                     jsonb_build_object('measure','po_approval','bucket', ${APPR6_BUCKET}))) AS drill
            FROM (SELECT po_approval_days AS d FROM ${POL}
                   WHERE dataset_version_id = $1 AND po_approval_days IS NOT NULL AND NOT is_sto) x
           GROUP BY 1,2, ${APPR6_ORDER} ORDER BY ${APPR6_ORDER}`,
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
    chartId: 'po_by_plant', seriesKey: 'value_idr', seriesLabel: 'Net order value (IDR)', unit: 'idr',
    sql: `SELECT plant AS bucket_key, plant AS bucket_label,
                 sum(net_order_value_idr)::numeric AS value, count(*)::int AS row_count,
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
    chartId: 'po_value_by_category', seriesKey: 'value_idr', seriesLabel: 'Net order value (IDR)', unit: 'idr',
    sql: `SELECT COALESCE(material_category,'Other') AS bucket_key,
                 COALESCE(material_category,'Other') AS bucket_label,
                 sum(net_order_value_idr)::numeric AS value, count(*)::int AS row_count,
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
    chartId: 'po_value_by_purch_org', seriesKey: 'value_idr', seriesLabel: 'Net order value (IDR)', unit: 'idr',
    sql: `SELECT purch_org AS bucket_key, purch_org AS bucket_label,
                 sum(net_order_value_idr)::numeric AS value, count(*)::int AS row_count,
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
    chartId: 'commitment_aging', seriesKey: 'value_idr', seriesLabel: 'Still to deliver (IDR)', unit: 'idr',
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
                         still_deliver_val_idr AS v
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
  // Annotation series (label_*): not drawn as bars - the per-category PR
  // valuation rides in the bar labels and tooltips, in both currencies so the
  // display toggle picks the right one (user ask 5 Aug 2026).
  {
    chartId: 'items_by_category', seriesKey: 'label_amount', seriesLabel: 'Value (USD)', unit: 'usd',
    sql: `SELECT COALESCE(material_category,'Other') AS bucket_key,
                 COALESCE(material_category,'Other') AS bucket_label,
                 sum(total_value_usd)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('matCat', min(material_category),'notDeleted',true)) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted
           GROUP BY 1,2 ORDER BY count(*) DESC`,
  },
  {
    chartId: 'items_by_category', seriesKey: 'label_amount_idr', seriesLabel: 'Value (IDR)', unit: 'idr',
    sql: `SELECT COALESCE(material_category,'Other') AS bucket_key,
                 COALESCE(material_category,'Other') AS bucket_label,
                 sum(total_value_idr)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('matCat', min(material_category),'notDeleted',true)) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted
           GROUP BY 1,2 ORDER BY count(*) DESC`,
  },
  {
    chartId: 'e2e_by_category', seriesKey: 'days', seriesLabel: 'Avg E2E (days)', unit: 'days',
    // Grouped by the PO line's own category (not the PR's) so the po_line-grain
    // drill opens exactly the aggregated rows. The two categories agree on all
    // but a handful of lines, and self-consistency wins over that nuance.
    // Average basis like v1's ch-mge2 (5 Aug 2026).
    sql: `SELECT COALESCE(pol.material_category,'Other') AS bucket_key,
                 COALESCE(pol.material_category,'Other') AS bucket_label,
                 avg(pol.receipt_date - pri.requisition_date)::numeric AS value,
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
  {
    chartId: 'top_materials_spend', seriesKey: 'value_idr', seriesLabel: 'Spend (IDR)', unit: 'idr',
    sql: `SELECT material_code AS bucket_key,
                 left(COALESCE(max(short_text), material_code), 40) AS bucket_label,
                 sum(net_order_value_idr)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('materialCode', material_code,'notSto',true,'notDeleted',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
              AND material_code IS NOT NULL
           GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 15`,
  },
  // ── v1's ch-po-plant: PO Amount by Area (doughnut; Master_Area roll-up) ──
  {
    chartId: 'po_amount_by_area', seriesKey: 'value', seriesLabel: 'Amount (USD)', unit: 'usd',
    sql: `SELECT COALESCE((SELECT max(_dp.area) FROM core.dim_plant _dp WHERE _dp.plant = ${POL}.plant), plant) AS bucket_key,
                 COALESCE((SELECT max(_dp.area) FROM core.dim_plant _dp WHERE _dp.plant = ${POL}.plant), plant) AS bucket_label,
                 sum(net_order_value_usd)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('areaIs', COALESCE((SELECT max(_dp.area) FROM core.dim_plant _dp WHERE _dp.plant = ${POL}.plant), plant),'notSto',true,'notDeleted',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
           GROUP BY 1,2 ORDER BY 3 DESC NULLS LAST`,
  },
  {
    chartId: 'po_amount_by_area', seriesKey: 'value_idr', seriesLabel: 'Amount (IDR)', unit: 'idr',
    sql: `SELECT COALESCE((SELECT max(_dp.area) FROM core.dim_plant _dp WHERE _dp.plant = ${POL}.plant), plant) AS bucket_key,
                 COALESCE((SELECT max(_dp.area) FROM core.dim_plant _dp WHERE _dp.plant = ${POL}.plant), plant) AS bucket_label,
                 sum(net_order_value_idr)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('areaIs', COALESCE((SELECT max(_dp.area) FROM core.dim_plant _dp WHERE _dp.plant = ${POL}.plant), plant),'notSto',true,'notDeleted',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
           GROUP BY 1,2 ORDER BY 3 DESC NULLS LAST`,
  },
  // ── v1's Outstanding-PR family (ch-pr-outco / outpic / outporg) ──
  //
  // "Outstanding" is v1's word for an active requisition item that has not yet
  // produced a PO — its `!deleted && !PO_No`, which is `po_line_count = 0` here.
  {
    chartId: 'pr_outstanding_by_company', seriesKey: 'items', seriesLabel: 'Outstanding PR items', unit: 'count',
    sql: `SELECT company_code AS bucket_key, company_code AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('companyCode', company_code,'notDeleted',true,'prNoPo',true)) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted AND po_line_count = 0
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    chartId: 'pr_outstanding_by_porg', seriesKey: 'items', seriesLabel: 'Outstanding PR items', unit: 'count',
    sql: `SELECT purch_org AS bucket_key, purch_org AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('purchOrg', purch_org,'notDeleted',true,'prNoPo',true)) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted AND po_line_count = 0
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    chartId: 'pr_outstanding_by_pgrp', seriesKey: '< 7', seriesLabel: '< 7', unit: 'count',
    // Grouped by purchasing-group CODE and labelled with its description. v1
    // groups by description, which silently merges the codes that share one
    // (@14 and @21 are both "HO-PCH-7"); keeping the code distinct is what lets
    // each bar drill to exactly its own rows.
    sql: `SELECT purch_group AS bucket_key,
                 COALESCE((SELECT max(_dg.description) FROM core.dim_purch_group _dg WHERE _dg.code = ${PRI}.purch_group), NULLIF(${PRI}.purch_group,''), 'Unassigned') AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('purchGroup', purch_group,'notDeleted',true,'prNoPo',true,
                                      'prAgeBracket','< 7')) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted AND po_line_count = 0 AND aging_days IS NOT NULL
              AND CASE WHEN aging_days <= 7 THEN '< 7' WHEN aging_days <= 14 THEN '8 sd 14' WHEN aging_days <= 21 THEN '15 sd 21' WHEN aging_days <= 30 THEN '22 sd 30' ELSE '> 31' END = '< 7'
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    chartId: 'pr_outstanding_by_pgrp', seriesKey: '8 sd 14', seriesLabel: '8 sd 14', unit: 'count',
    // Grouped by purchasing-group CODE and labelled with its description. v1
    // groups by description, which silently merges the codes that share one
    // (@14 and @21 are both "HO-PCH-7"); keeping the code distinct is what lets
    // each bar drill to exactly its own rows.
    sql: `SELECT purch_group AS bucket_key,
                 COALESCE((SELECT max(_dg.description) FROM core.dim_purch_group _dg WHERE _dg.code = ${PRI}.purch_group), NULLIF(${PRI}.purch_group,''), 'Unassigned') AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('purchGroup', purch_group,'notDeleted',true,'prNoPo',true,
                                      'prAgeBracket','8 sd 14')) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted AND po_line_count = 0 AND aging_days IS NOT NULL
              AND CASE WHEN aging_days <= 7 THEN '< 7' WHEN aging_days <= 14 THEN '8 sd 14' WHEN aging_days <= 21 THEN '15 sd 21' WHEN aging_days <= 30 THEN '22 sd 30' ELSE '> 31' END = '8 sd 14'
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    chartId: 'pr_outstanding_by_pgrp', seriesKey: '15 sd 21', seriesLabel: '15 sd 21', unit: 'count',
    // Grouped by purchasing-group CODE and labelled with its description. v1
    // groups by description, which silently merges the codes that share one
    // (@14 and @21 are both "HO-PCH-7"); keeping the code distinct is what lets
    // each bar drill to exactly its own rows.
    sql: `SELECT purch_group AS bucket_key,
                 COALESCE((SELECT max(_dg.description) FROM core.dim_purch_group _dg WHERE _dg.code = ${PRI}.purch_group), NULLIF(${PRI}.purch_group,''), 'Unassigned') AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('purchGroup', purch_group,'notDeleted',true,'prNoPo',true,
                                      'prAgeBracket','15 sd 21')) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted AND po_line_count = 0 AND aging_days IS NOT NULL
              AND CASE WHEN aging_days <= 7 THEN '< 7' WHEN aging_days <= 14 THEN '8 sd 14' WHEN aging_days <= 21 THEN '15 sd 21' WHEN aging_days <= 30 THEN '22 sd 30' ELSE '> 31' END = '15 sd 21'
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    chartId: 'pr_outstanding_by_pgrp', seriesKey: '22 sd 30', seriesLabel: '22 sd 30', unit: 'count',
    // Grouped by purchasing-group CODE and labelled with its description. v1
    // groups by description, which silently merges the codes that share one
    // (@14 and @21 are both "HO-PCH-7"); keeping the code distinct is what lets
    // each bar drill to exactly its own rows.
    sql: `SELECT purch_group AS bucket_key,
                 COALESCE((SELECT max(_dg.description) FROM core.dim_purch_group _dg WHERE _dg.code = ${PRI}.purch_group), NULLIF(${PRI}.purch_group,''), 'Unassigned') AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('purchGroup', purch_group,'notDeleted',true,'prNoPo',true,
                                      'prAgeBracket','22 sd 30')) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted AND po_line_count = 0 AND aging_days IS NOT NULL
              AND CASE WHEN aging_days <= 7 THEN '< 7' WHEN aging_days <= 14 THEN '8 sd 14' WHEN aging_days <= 21 THEN '15 sd 21' WHEN aging_days <= 30 THEN '22 sd 30' ELSE '> 31' END = '22 sd 30'
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    chartId: 'pr_outstanding_by_pgrp', seriesKey: '> 31', seriesLabel: '> 31', unit: 'count',
    // Grouped by purchasing-group CODE and labelled with its description. v1
    // groups by description, which silently merges the codes that share one
    // (@14 and @21 are both "HO-PCH-7"); keeping the code distinct is what lets
    // each bar drill to exactly its own rows.
    sql: `SELECT purch_group AS bucket_key,
                 COALESCE((SELECT max(_dg.description) FROM core.dim_purch_group _dg WHERE _dg.code = ${PRI}.purch_group), NULLIF(${PRI}.purch_group,''), 'Unassigned') AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('purchGroup', purch_group,'notDeleted',true,'prNoPo',true,
                                      'prAgeBracket','> 31')) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND NOT is_deleted AND po_line_count = 0 AND aging_days IS NOT NULL
              AND CASE WHEN aging_days <= 7 THEN '< 7' WHEN aging_days <= 14 THEN '8 sd 14' WHEN aging_days <= 21 THEN '15 sd 21' WHEN aging_days <= 30 THEN '22 sd 30' ELSE '> 31' END = '> 31'
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  // ── v1's ch-pr-area: every PR item by area, the shape of demand ──
  {
    chartId: 'pr_items_by_area', seriesKey: 'items', seriesLabel: 'PR items', unit: 'count',
    sql: `SELECT COALESCE((SELECT max(_dp.area) FROM core.dim_plant _dp WHERE _dp.plant = ${PRI}.plant), ${PRI}.plant) AS bucket_key,
                 COALESCE((SELECT max(_dp.area) FROM core.dim_plant _dp WHERE _dp.plant = ${PRI}.plant), ${PRI}.plant) AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('areaIs', COALESCE((SELECT max(_dp.area) FROM core.dim_plant _dp WHERE _dp.plant = ${PRI}.plant), ${PRI}.plant))) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  // ── v1's ch-prl1: how long the FIRST approval layer takes ──
  {
    chartId: 'pr_layer1_aging_by_priority', seriesKey: 'days', seriesLabel: 'Layer-1 aging (days)', unit: 'days',
    sql: `SELECT COALESCE(priority_label,'(none)') AS bucket_key,
                 COALESCE(priority_label,'(none)') AS bucket_label,
                 avg(release_l1_date - requisition_date)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('priorityLabel', min(priority_label),'l1Evaluable',true)) AS drill
            FROM ${PRI}
           WHERE dataset_version_id = $1 AND release_l1_date IS NOT NULL AND requisition_date IS NOT NULL
           GROUP BY 1,2 ORDER BY 1`,
  },
  // ── v1's ch-po-brkval / ch-po-brkcnt: PO value brackets ──
  //
  // Brackets belong to the DOCUMENT, not the line: v1 sums each PO's IDR lines
  // and brackets the total ("JT" = juta, million IDR). Restricted to
  // IDR-currency lines exactly as v1 does, so the figure is a native-currency
  // total and not an FX conversion.
  //
  // `value` is the metric the bar shows (billions of IDR, then document count);
  // `row_count` is the LINES behind it, which is what the drill opens — the same
  // entity-vs-row convention the PO Hold card uses.
  //
  // Two CTEs, and which one the global filter lands on is the whole point:
  //
  //   `docs`  sizes each document over ALL its IDR lines and is deliberately
  //           NOT filtered. A 300 JT order does not become a small order
  //           because you are looking at only its open lines, and the drill's
  //           poDocBracket brackets on that same unfiltered document total —
  //           re-bracketing on the filtered subset would put chart and drill on
  //           two different definitions of "0 - 5 JT".
  //   `lines` is the line population the bar measures, and IS filtered. It
  //           carries the /*F*/ marker because the spec's FIRST
  //           dataset_version_id anchor belongs to `docs`; without it
  //           injectFilter would filter the sizing and leave the measurement
  //           alone, which is exactly backwards.
  //
  // `value` and `row_count` both read off `lines`, so the bar, its count and the
  // rows the drill opens can never be three different populations.
  //
  // Keep the anchor text out of any -- comment INSIDE these template literals.
  // injectFilter scans the raw SQL string, so a comment that spells the anchor
  // out becomes the first match and the clause is appended inside the comment:
  // silently dropped, bind parameter still supplied, and it surfaces as a "bind
  // message supplies 2 parameters" error nowhere near the cause.
  {
    chartId: 'po_bracket_value', seriesKey: '0 - 5 JT', seriesLabel: '0 - 5 JT', unit: 'idr',
    sql: `WITH docs AS (
               SELECT po_no, sum(net_order_value) AS total
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted
                GROUP BY 1 HAVING sum(net_order_value) > 0),
               lines AS (
               SELECT po_no, net_order_value
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted/*F*/)
           SELECT 'Amount in Local Currency' AS bucket_key,
                  'Amount in Local Currency' AS bucket_label,
                  (SELECT sum(x.net_order_value) FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 0 AND d.total < 5000000)::numeric AS value,
                  (SELECT count(*)::int FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 0 AND d.total < 5000000) AS row_count,
                  jsonb_build_object('grain','po_line','filters',
                    jsonb_build_object('poDocBracket','0 - 5 JT','currencyIs','IDR',
                                       'notSto',true,'notDeleted',true)) AS drill`,
  },
  {
    chartId: 'po_bracket_count', seriesKey: '0 - 5 JT', seriesLabel: '0 - 5 JT', unit: 'count',
    sql: `WITH docs AS (
               SELECT po_no, sum(net_order_value) AS total
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted
                GROUP BY 1 HAVING sum(net_order_value) > 0),
               lines AS (
               SELECT po_no, net_order_value
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted/*F*/)
           SELECT 'PO Count' AS bucket_key, 'PO Count' AS bucket_label,
                  (SELECT count(DISTINCT x.po_no)::numeric FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 0 AND d.total < 5000000) AS value,
                  (SELECT count(*)::int FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 0 AND d.total < 5000000) AS row_count,
                  jsonb_build_object('grain','po_line','filters',
                    jsonb_build_object('poDocBracket','0 - 5 JT','currencyIs','IDR',
                                       'notSto',true,'notDeleted',true)) AS drill`,
  },
  {
    chartId: 'po_bracket_value', seriesKey: '5 - 25 JT', seriesLabel: '5 - 25 JT', unit: 'idr',
    sql: `WITH docs AS (
               SELECT po_no, sum(net_order_value) AS total
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted
                GROUP BY 1 HAVING sum(net_order_value) > 0),
               lines AS (
               SELECT po_no, net_order_value
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted/*F*/)
           SELECT 'Amount in Local Currency' AS bucket_key,
                  'Amount in Local Currency' AS bucket_label,
                  (SELECT sum(x.net_order_value) FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 5000000 AND d.total < 25000000)::numeric AS value,
                  (SELECT count(*)::int FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 5000000 AND d.total < 25000000) AS row_count,
                  jsonb_build_object('grain','po_line','filters',
                    jsonb_build_object('poDocBracket','5 - 25 JT','currencyIs','IDR',
                                       'notSto',true,'notDeleted',true)) AS drill`,
  },
  {
    chartId: 'po_bracket_count', seriesKey: '5 - 25 JT', seriesLabel: '5 - 25 JT', unit: 'count',
    sql: `WITH docs AS (
               SELECT po_no, sum(net_order_value) AS total
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted
                GROUP BY 1 HAVING sum(net_order_value) > 0),
               lines AS (
               SELECT po_no, net_order_value
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted/*F*/)
           SELECT 'PO Count' AS bucket_key, 'PO Count' AS bucket_label,
                  (SELECT count(DISTINCT x.po_no)::numeric FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 5000000 AND d.total < 25000000) AS value,
                  (SELECT count(*)::int FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 5000000 AND d.total < 25000000) AS row_count,
                  jsonb_build_object('grain','po_line','filters',
                    jsonb_build_object('poDocBracket','5 - 25 JT','currencyIs','IDR',
                                       'notSto',true,'notDeleted',true)) AS drill`,
  },
  {
    chartId: 'po_bracket_value', seriesKey: '25 - 100 JT', seriesLabel: '25 - 100 JT', unit: 'idr',
    sql: `WITH docs AS (
               SELECT po_no, sum(net_order_value) AS total
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted
                GROUP BY 1 HAVING sum(net_order_value) > 0),
               lines AS (
               SELECT po_no, net_order_value
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted/*F*/)
           SELECT 'Amount in Local Currency' AS bucket_key,
                  'Amount in Local Currency' AS bucket_label,
                  (SELECT sum(x.net_order_value) FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 25000000 AND d.total < 100000000)::numeric AS value,
                  (SELECT count(*)::int FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 25000000 AND d.total < 100000000) AS row_count,
                  jsonb_build_object('grain','po_line','filters',
                    jsonb_build_object('poDocBracket','25 - 100 JT','currencyIs','IDR',
                                       'notSto',true,'notDeleted',true)) AS drill`,
  },
  {
    chartId: 'po_bracket_count', seriesKey: '25 - 100 JT', seriesLabel: '25 - 100 JT', unit: 'count',
    sql: `WITH docs AS (
               SELECT po_no, sum(net_order_value) AS total
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted
                GROUP BY 1 HAVING sum(net_order_value) > 0),
               lines AS (
               SELECT po_no, net_order_value
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted/*F*/)
           SELECT 'PO Count' AS bucket_key, 'PO Count' AS bucket_label,
                  (SELECT count(DISTINCT x.po_no)::numeric FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 25000000 AND d.total < 100000000) AS value,
                  (SELECT count(*)::int FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 25000000 AND d.total < 100000000) AS row_count,
                  jsonb_build_object('grain','po_line','filters',
                    jsonb_build_object('poDocBracket','25 - 100 JT','currencyIs','IDR',
                                       'notSto',true,'notDeleted',true)) AS drill`,
  },
  {
    chartId: 'po_bracket_value', seriesKey: '100 - 500 JT', seriesLabel: '100 - 500 JT', unit: 'idr',
    sql: `WITH docs AS (
               SELECT po_no, sum(net_order_value) AS total
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted
                GROUP BY 1 HAVING sum(net_order_value) > 0),
               lines AS (
               SELECT po_no, net_order_value
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted/*F*/)
           SELECT 'Amount in Local Currency' AS bucket_key,
                  'Amount in Local Currency' AS bucket_label,
                  (SELECT sum(x.net_order_value) FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 100000000 AND d.total < 500000000)::numeric AS value,
                  (SELECT count(*)::int FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 100000000 AND d.total < 500000000) AS row_count,
                  jsonb_build_object('grain','po_line','filters',
                    jsonb_build_object('poDocBracket','100 - 500 JT','currencyIs','IDR',
                                       'notSto',true,'notDeleted',true)) AS drill`,
  },
  {
    chartId: 'po_bracket_count', seriesKey: '100 - 500 JT', seriesLabel: '100 - 500 JT', unit: 'count',
    sql: `WITH docs AS (
               SELECT po_no, sum(net_order_value) AS total
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted
                GROUP BY 1 HAVING sum(net_order_value) > 0),
               lines AS (
               SELECT po_no, net_order_value
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted/*F*/)
           SELECT 'PO Count' AS bucket_key, 'PO Count' AS bucket_label,
                  (SELECT count(DISTINCT x.po_no)::numeric FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 100000000 AND d.total < 500000000) AS value,
                  (SELECT count(*)::int FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 100000000 AND d.total < 500000000) AS row_count,
                  jsonb_build_object('grain','po_line','filters',
                    jsonb_build_object('poDocBracket','100 - 500 JT','currencyIs','IDR',
                                       'notSto',true,'notDeleted',true)) AS drill`,
  },
  {
    chartId: 'po_bracket_value', seriesKey: '>500 JT', seriesLabel: '>500 JT', unit: 'idr',
    sql: `WITH docs AS (
               SELECT po_no, sum(net_order_value) AS total
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted
                GROUP BY 1 HAVING sum(net_order_value) > 0),
               lines AS (
               SELECT po_no, net_order_value
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted/*F*/)
           SELECT 'Amount in Local Currency' AS bucket_key,
                  'Amount in Local Currency' AS bucket_label,
                  (SELECT sum(x.net_order_value) FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 500000000)::numeric AS value,
                  (SELECT count(*)::int FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 500000000) AS row_count,
                  jsonb_build_object('grain','po_line','filters',
                    jsonb_build_object('poDocBracket','>500 JT','currencyIs','IDR',
                                       'notSto',true,'notDeleted',true)) AS drill`,
  },
  {
    chartId: 'po_bracket_count', seriesKey: '>500 JT', seriesLabel: '>500 JT', unit: 'count',
    sql: `WITH docs AS (
               SELECT po_no, sum(net_order_value) AS total
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted
                GROUP BY 1 HAVING sum(net_order_value) > 0),
               lines AS (
               SELECT po_no, net_order_value
                 FROM ${POL}
                WHERE dataset_version_id = $1 AND currency_code = 'IDR'
                  AND NOT is_sto AND NOT is_deleted/*F*/)
           SELECT 'PO Count' AS bucket_key, 'PO Count' AS bucket_label,
                  (SELECT count(DISTINCT x.po_no)::numeric FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 500000000) AS value,
                  (SELECT count(*)::int FROM lines x JOIN docs d ON d.po_no = x.po_no
                    WHERE d.total >= 500000000) AS row_count,
                  jsonb_build_object('grain','po_line','filters',
                    jsonb_build_object('poDocBracket','>500 JT','currencyIs','IDR',
                                       'notSto',true,'notDeleted',true)) AS drill`,
  },
  // ── v1's ch-po-issued: Head Office desks vs site UNITs ──
  {
    chartId: 'po_issued_by', seriesKey: 'documents', seriesLabel: 'PO documents', unit: 'count',
    // Documents, so a multi-line PO counts once; the drill opens its lines.
    sql: `SELECT b.k AS bucket_key, b.k AS bucket_label,
                 count(DISTINCT p.po_no)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('issuedBy', b.k,'notSto',true,'notDeleted',true)) AS drill
            FROM ${POL} p
            CROSS JOIN LATERAL (
              SELECT CASE
                       WHEN p.purch_group IS NULL OR p.purch_group = '' THEN 'Unassigned'
                       WHEN EXISTS (SELECT 1 FROM core.dim_purch_group _d
                                     WHERE _d.code = p.purch_group AND _d.is_ho) THEN 'HO'
                       ELSE 'UNIT' END AS k) b
           WHERE p.dataset_version_id = $1 AND NOT p.is_sto AND NOT p.is_deleted
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  // ── v1's ch-po-picitems: PO lines per buyer desk ──
  {
    chartId: 'po_items_by_pgrp', seriesKey: 'items', seriesLabel: 'PO line items', unit: 'count',
    sql: `SELECT purch_group AS bucket_key,
                 COALESCE((SELECT max(_dg.description) FROM core.dim_purch_group _dg WHERE _dg.code = ${POL}.purch_group), NULLIF(${POL}.purch_group,''), 'Unassigned') AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('purchGroup', purch_group,'notSto',true,'notDeleted',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  // ── v1's ch-po-catcnt: lines AND documents per material category ──
  {
    chartId: 'po_count_by_category', seriesKey: 'items', seriesLabel: 'PO line items', unit: 'count',
    sql: `SELECT COALESCE(material_category,'(uncategorised)') AS bucket_key,
                 COALESCE(material_category,'(uncategorised)') AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('matCat', min(material_category),'notSto',true,'notDeleted',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    chartId: 'po_count_by_category', seriesKey: 'documents', seriesLabel: 'PO count', unit: 'count',
    sql: `SELECT COALESCE(material_category,'(uncategorised)') AS bucket_key,
                 COALESCE(material_category,'(uncategorised)') AS bucket_label,
                 count(DISTINCT po_no)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('matCat', min(material_category),'notSto',true,'notDeleted',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  // ── v1's ch-po-matval: PO Amount by Material Category ──
  {
    chartId: 'po_amount_by_matcat', seriesKey: 'value', seriesLabel: 'Amount (USD)', unit: 'usd',
    sql: `SELECT COALESCE(material_category,'Other') AS bucket_key,
                 COALESCE(material_category,'Other') AS bucket_label,
                 sum(net_order_value_usd)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('matCat', min(material_category),'notSto',true,'notDeleted',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
           GROUP BY 1,2 ORDER BY 3 DESC NULLS LAST`,
  },
  {
    chartId: 'po_amount_by_matcat', seriesKey: 'value_idr', seriesLabel: 'Amount (IDR)', unit: 'idr',
    sql: `SELECT COALESCE(material_category,'Other') AS bucket_key,
                 COALESCE(material_category,'Other') AS bucket_label,
                 sum(net_order_value_idr)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('matCat', min(material_category),'notSto',true,'notDeleted',true)) AS drill
            FROM ${POL} WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
           GROUP BY 1,2 ORDER BY 3 DESC NULLS LAST`,
  },
  // ── v1's ch-po-pgrp: PR Status by Purchasing Group. Outstanding counts PR
  //    items awaiting a PO under the PR's OWN group (blank groups excluded,
  //    like v1's '?' filter); Converted counts PO lines under the PO List's
  //    group - who actually processed it - with blanks in a visible N/A
  //    bucket, never borrowing the PR's group. ──
  {
    chartId: 'pr_status_by_pgrp', seriesKey: 'outstanding', seriesLabel: 'Outstanding (No PO)', unit: 'count',
    sql: `SELECT btrim(purch_group) AS bucket_key, btrim(purch_group) AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','pr_item','filters',
                   jsonb_build_object('status','PR Approved-No PO','purchGrp', btrim(purch_group))) AS drill
            FROM ${PRI} WHERE dataset_version_id = $1 AND status = 'PR Approved-No PO'
             AND btrim(COALESCE(purch_group,'')) <> ''
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    chartId: 'pr_status_by_pgrp', seriesKey: 'converted', seriesLabel: 'Converted to PO', unit: 'count',
    sql: `SELECT COALESCE(NULLIF(btrim(purch_group),''),'N/A') AS bucket_key,
                 COALESCE(NULLIF(btrim(purch_group),''),'N/A') AS bucket_label,
                 count(*)::numeric AS value, count(*)::int AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('statusIn', jsonb_build_array('PO-No GR','Delivered','Partially Delivered'),
                                      'purchGrp', COALESCE(NULLIF(btrim(purch_group),''),'N/A'))) AS drill
            FROM ${POL} WHERE dataset_version_id = $1
             AND status IN ('PO-No GR','Delivered','Partially Delivered')
           GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  // ── v1's ch-po-pgpie: PO Value by Purchasing Group - share of IDR spend
  //    (doughnut; IDR document-currency lines only, top 8 + Others). ──
  {
    chartId: 'po_value_by_pgrp', seriesKey: 'value', seriesLabel: 'Spend (IDR)', unit: 'idr',
    sql: `WITH g AS (
            SELECT COALESCE(NULLIF(btrim(purch_group),''),'(none)') AS grp,
                   sum(net_order_value)::numeric AS val, count(*)::int AS n
              FROM ${POL}
             WHERE dataset_version_id = $1 AND currency_code = 'IDR' AND NOT is_deleted
             GROUP BY 1),
          r AS (SELECT g.*, row_number() OVER (ORDER BY val DESC NULLS LAST) AS rk FROM g),
          top AS (SELECT * FROM r WHERE rk <= 8)
          SELECT grp AS bucket_key, grp AS bucket_label, val AS value, n AS row_count,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('currencyIs','IDR','notDeleted',true,'purchGrp',grp)) AS drill
            FROM top
          UNION ALL
          SELECT 'Others','Others', sum(val), sum(n)::int,
                 jsonb_build_object('grain','po_line','filters',
                   jsonb_build_object('currencyIs','IDR','notDeleted',true,
                                      'purchGrpNotIn', (SELECT jsonb_agg(grp) FROM top)))
            FROM r WHERE rk > 8
          HAVING count(*) > 0
          ORDER BY 3 DESC NULLS LAST`,
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
