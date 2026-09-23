-- 030 - spend_category on core.v_detail.
--
-- Requested 22 Sep 2026: Open Items groups by material category, and it must be
-- the SAME category the Executive Summary uses - the one that comes from the
-- Material Master's Category field - rather than the legacy mat_cat the view
-- already carried. The two are different dimensions with similar names, which
-- is exactly the kind of pair that ends up quoted against each other in a
-- meeting.
--
-- -- Where each half gets it ------------------------------------------------
--
-- A line that reached an order takes fact_po_line.spend_category, the column
-- the Executive Summary's charts group by. Not re-derived: taking the same
-- column means the two pages cannot disagree, even if the resolution rules
-- change later.
--
-- A requisition with no order yet has no such column - fact_pr_item does not
-- carry spend_category - so it is resolved from its own material with
-- spendCategoryWithPlantSql, the generator the transform itself calls. That
-- matters here: Open Items counts requisition stages, and without this half
-- every unapproved PR would have fallen into '(none)' and the page would have
-- said the backlog was uncategorised.
--
-- The resolution order is the shared one: material code, then code prefix, then
-- material group, then core.dim_material_master.category, then '(unmapped)'.
-- The CAPEX split by plant rides along, since it is part of that generator.
--
-- -- Why the whole view is restated ----------------------------------------
--
-- CREATE OR REPLACE VIEW can only append columns. GENERATED from 029's text
-- with the column appended, and the PR-side expression GENERATED from
-- @pct/rules rather than transcribed.
--
-- A view, so nothing is recomputed: available the moment this migration runs.

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
  COALESCE(pol.spend_category,
    CASE WHEN (COALESCE(
    (SELECT sc_.category FROM core.dim_spend_category sc_
    WHERE sc_.material_code = pri.material_code),
    (SELECT sc_.category FROM core.dim_spend_category sc_
    WHERE sc_.material_prefix IS NOT NULL
    AND pri.material_code LIKE sc_.material_prefix || '.%'
    ORDER BY length(sc_.material_prefix) DESC LIMIT 1),
    (SELECT sc_.category FROM core.dim_spend_category sc_
    WHERE sc_.material_group = pri.material_group),
    (SELECT mm_.category FROM core.dim_material_master mm_
    WHERE mm_.material_code = pri.material_code AND mm_.category IS NOT NULL),
    CASE WHEN pri.material_code IS NULL OR pri.material_code = ''
    THEN '(no material code)'
    ELSE '(unmapped)' END)) IN ('CAPEX OPS', 'CAPEX', 'CAPEX PROJ')
    THEN CASE WHEN substr(COALESCE(pri.plant, ''), 3, 1) = '9'
    THEN 'CAPEX PROJ' ELSE 'CAPEX OPS' END
    ELSE (COALESCE(
    (SELECT sc_.category FROM core.dim_spend_category sc_
    WHERE sc_.material_code = pri.material_code),
    (SELECT sc_.category FROM core.dim_spend_category sc_
    WHERE sc_.material_prefix IS NOT NULL
    AND pri.material_code LIKE sc_.material_prefix || '.%'
    ORDER BY length(sc_.material_prefix) DESC LIMIT 1),
    (SELECT sc_.category FROM core.dim_spend_category sc_
    WHERE sc_.material_group = pri.material_group),
    (SELECT mm_.category FROM core.dim_material_master mm_
    WHERE mm_.material_code = pri.material_code AND mm_.category IS NOT NULL),
    CASE WHEN pri.material_code IS NULL OR pri.material_code = ''
    THEN '(no material code)'
    ELSE '(unmapped)' END)) END)                                    AS spend_category
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
  NULL, NULL,
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
  true,
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
WHERE pol.pr_no IS NULL;
