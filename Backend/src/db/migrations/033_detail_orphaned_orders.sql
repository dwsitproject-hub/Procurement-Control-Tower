-- 033 - order lines whose requisition is not in the facts reach the detail view.
--
-- Reported 24 Sep 2026: 4,084 order lines in the SAP PO report could not be
-- found on the Detail Table, PO 1002035559 among them, although every one of
-- them was loaded and counted.
--
-- -- What happened -----------------------------------------------------------
--
-- core.v_detail is two halves. The first starts from the REQUISITION and joins
-- its orders; the second is meant to catch orders with no resolvable
-- requisition. Its comment says exactly that - "Direct POs and
-- dangling-reference POs" - and its filter said only `pol.pr_no IS NULL`, which
-- is the direct POs alone.
--
-- An order that names a requisition which is NOT in the facts therefore sat in
-- neither half. That happens whenever the two documents are excluded
-- differently: staging excludes purchasing organizations
-- (exclusions.purch_orgs, which includes PRO2), each document is judged by its
-- OWN organization, and a requisition raised under PRO2 is often ordered under
-- PUR1. The requisition is dropped at load, the order is kept - and the order
-- was counted in every PO figure while being impossible to find on this page.
--
-- On staging's published version: 45,189 order lines in the facts, 4,466 of
-- them naming a requisition that was not loaded, and 40,723 in this view -
-- exactly the difference. 4,058 of the reported 4,084 were this case; the rest
-- were one held PO (excluded on purpose) and 25 orders newer than the extract.
--
-- -- What changes -------------------------------------------------------------
--
--   the second half takes those orders too;
--   it keeps their requisition NUMBER rather than blanking it, so a reader can
--   see which requisition the order came from and why it has no requisition
--   detail - the requisition is excluded, not unknown;
--   is_direct_po is true only when there is genuinely no requisition, so the
--   Direct PO filter still means direct.
--
-- No figure changes: every one of these lines was already in fact_po_line and
-- already counted. What changes is that the Detail Table and Open Items can now
-- show the rows those figures were built from.
--
-- -- Why the whole view is restated -------------------------------------------
--
-- CREATE OR REPLACE VIEW keeps column order and types, which this does - the
-- edits are to two expressions and one WHERE clause, not to the column list.
-- GENERATED from 031's text rather than retyped.

CREATE OR REPLACE VIEW core.v_detail AS
-- (a) PR items, with their PO link when one exists
SELECT
  pri.dataset_version_id,
  pri.pr_no                                        AS pr_no,
  pri.pr_item                                      AS pr_item,
  pri.short_text                                   AS descr,
  pri.company_code                                 AS company,
  COALESCE(dc.legal_name, pri.company_code)        AS company_full,
  pri.plant                                        AS plant,
  COALESCE(dp.plant_name, pri.plant)               AS plant_name,
  pri.qty_requested                                AS pr_qty,
  pri.uom                                          AS uom,
  pol.receipt_qty_net                              AS gr_qty_total,
  pol.gr_completion_pct                            AS gr_pr_pct,
  pri.material_group                               AS mat_group,
  pri.material_category                            AS mat_cat,
  pri.priority_label                               AS p_cat,
  COALESCE(pol.status, pri.status)                 AS status,
  pri.next_approver                                AS pr_next_approver,
  pri.requisition_date                             AS req_date,
  pri.release_l1_date                              AS pr_l1,
  pri.release_l2_date                              AS pr_l2,
  (pri.release_final_date - pri.requisition_date)  AS pra_days,
  CASE WHEN pri.release_final_date IS NULL THEN pri.aging_days END AS unrel_days,
  CASE WHEN pri.po_line_count = 0 AND pri.release_final_date IS NOT NULL
       THEN pri.aging_days END                     AS sourcing_aging_days,
  pol.po_no                                        AS po_no,
  pol.po_item                                      AS po_item,
  CASE WHEN b.split_total > 1
       THEN b.split_seq || '/' || b.split_total END AS po_split,
  pol.short_text                                   AS po_mat_desc,
  pol.order_qty                                    AS po_qty,
  pol.order_unit                                   AS po_uom,
  pol.order_unit                                   AS order_price_unit,
  pol.price_unit                                   AS price_unit,
  pol.document_date                                AS po_date,
  pol.release_final_date                           AS po_full,
  pol.vendor_code                                  AS vendor_code,
  pol.vendor_name                                  AS supplier,
  pol.next_approver                                AS po_next_approver,
  pol.po_approval_days                             AS poa_days,
  pol.receipt_date                                 AS gr_date,
  pol.delivery_days                                AS deliv_days,
  pol.sourcing_days                                AS src_days,
  pol.delivery_vs_promise_days                     AS delvsgr_days,
  (pol.receipt_date - pri.requisition_date)        AS e2e_days,
  pri.wbs_element                                  AS wbs,
  pri.wbs_status                                   AS wbs_status,
  pol.currency_code                                AS currency_code,
  pol.net_order_value                              AS net_order_value,
  pol.net_order_value_usd                          AS net_order_value_usd,
  pri.total_value_idr                              AS pr_value_idr,
  pri.purch_org                                    AS purch_org,
  pri.purch_group                                  AS purch_group,
  pri.urgency                                      AS urgency,
  pri.is_deleted                                   AS pr_deleted,
  COALESCE(pol.is_sto, false)                      AS is_sto,
  COALESCE(pol.release_exempt, false)              AS release_exempt,
  COALESCE(pol.is_token_price, false)              AS is_token_price,
  COALESCE(pol.is_retro_po, false)                 AS is_retro_po,
  pol.link_status                                  AS link_status,
  false                                            AS is_direct_po,
  pri.requisitioner                                AS requisitioner,
  COALESCE(pol.aging_days, pri.aging_days)         AS age_days,
  pol.net_order_value_idr                          AS po_value_idr,
  pol.still_deliver_qty                            AS still_deliver_qty,
  pol.still_invoice_val                            AS still_invoice_val,
  pol.still_invoice_val_idr                        AS still_invoice_val_idr,
  COALESCE(pol.spend_category, pri.spend_category) AS spend_category
FROM core.fact_pr_item pri
LEFT JOIN core.bridge_pr_po b
       ON b.dataset_version_id = pri.dataset_version_id
      AND b.pr_no = pri.pr_no AND b.pr_item = pri.pr_item
LEFT JOIN core.fact_po_line pol
       ON pol.dataset_version_id = pri.dataset_version_id
      AND pol.po_no = b.po_no AND pol.po_item = b.po_item
LEFT JOIN core.dim_plant   dp ON dp.plant = pri.plant
LEFT JOIN core.dim_company dc ON dc.company_code = pri.company_code

UNION ALL

-- (b) Direct POs and dangling-reference POs: no resolvable requisition.
-- v1 omitted these from the detail table; 9,094 lines in the reference data.
SELECT
  pol.dataset_version_id,
  pol.pr_no, pol.pr_item,
  pol.short_text,
  pol.company_code,
  COALESCE(dc.legal_name, pol.company_code),
  pol.plant,
  COALESCE(dp.plant_name, pol.plant),
  NULL, pol.order_unit,
  pol.receipt_qty_net, pol.gr_completion_pct,
  pol.material_group, pol.material_category,
  NULL,
  pol.status,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  pol.po_no, pol.po_item, NULL,
  pol.short_text, pol.order_qty, pol.order_unit, pol.order_unit, pol.price_unit,
  pol.document_date, pol.release_final_date,
  pol.vendor_code, pol.vendor_name, pol.next_approver, pol.po_approval_days,
  pol.receipt_date, pol.delivery_days, NULL, pol.delivery_vs_promise_days, NULL,
  NULL, NULL,
  pol.currency_code, pol.net_order_value, pol.net_order_value_usd,
  NULL, pol.purch_org, pol.purch_group, pol.urgency,
  false,
  pol.is_sto, pol.release_exempt, pol.is_token_price, pol.is_retro_po,
  pol.link_status,
  pol.pr_no IS NULL,
  NULL,
  pol.aging_days,
  pol.net_order_value_idr,
  pol.still_deliver_qty,
  pol.still_invoice_val,
  pol.still_invoice_val_idr,
  pol.spend_category
FROM core.fact_po_line pol
LEFT JOIN core.dim_plant   dp ON dp.plant = pol.plant
LEFT JOIN core.dim_company dc ON dc.company_code = pol.company_code
WHERE pol.pr_no IS NULL
   OR NOT EXISTS (SELECT 1 FROM core.fact_pr_item x
                   WHERE x.dataset_version_id = pol.dataset_version_id
                     AND x.pr_no = pol.pr_no AND x.pr_item = pol.pr_item);
