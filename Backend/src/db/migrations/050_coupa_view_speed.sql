-- 050 - the Coupa invoice, invoice-line and receipt views check exclusions per
-- line instead of materialising every Coupa order line (24 Nov 2026).
--
-- Same views as 019, same rows; one change each: the "is this order line
-- still in scope?" subquery against ops.v_coupa_po_line ends in OFFSET 0.
--
-- Why: written as a plain EXISTS, Postgres turned the check into a HASHED
-- subplan - it evaluated the whole order-line view (every Coupa PO line through
-- its three exclusion lists, 53k rows) to build a hash, then probed it for the
-- few hundred lines it actually needed. That happened every time a view was
-- read, and the Invoicing & Payment page reads v_coupa_invoice in every query:
--
--   v_coupa_invoice       1,490 ms -> 18 ms
--   v_coupa_invoice_line    629 ms    (read once per invoice on the page)
--   v_coupa_receipt         799 ms
--
-- OFFSET 0 keeps the subquery correlated (it cannot be hashed), so each line is
-- looked up through the order line's primary key. It does not change what the
-- subquery returns - EXISTS only asks whether a row exists.
--
-- v_coupa_invoice's `linked` step is also MATERIALIZED now: under a predicate
-- the planner cannot estimate - the payment-aging bucket, a CASE over the due
-- date - it expected one invoice, skipped materialising the per-invoice
-- aggregate, and recomputed it for each of the 169 invoices it actually got
-- (1.0 s for the 91-180 bucket's popup; 14 ms with it computed once). Same
-- rows: a CTE's result does not depend on whether it is materialised.
--
-- The columns are unchanged (SELECT x.* over tables whose columns have not
-- changed since 019), so CREATE OR REPLACE applies as is. The views are owned by
-- the application account (the 046-048 owner check, DEPLOY_PRODUCTION §10g).

CREATE OR REPLACE VIEW ops.v_coupa_receipt AS
SELECT r.*
  FROM ops.coupa_receipt r
 WHERE r.order_line_id IS NULL
    OR EXISTS (
         SELECT 1 FROM ops.v_coupa_po_line p
          WHERE p.order_line_id = r.order_line_id
         OFFSET 0
       );

CREATE OR REPLACE VIEW ops.v_coupa_invoice_line AS
SELECT l.*
  FROM ops.coupa_invoice_line l
 WHERE l.order_line_id IS NULL
    OR EXISTS (
         SELECT 1 FROM ops.v_coupa_po_line p
          WHERE p.order_line_id = l.order_line_id
         OFFSET 0
       );

-- The rule is 019's, unchanged: no linkage -> kept; a mix of excluded and
-- surviving lines -> kept ("something survived wins").
CREATE OR REPLACE VIEW ops.v_coupa_invoice AS
WITH linked AS MATERIALIZED (
  SELECT l.invoice_id,
         count(*) AS linked_lines,
         count(*) FILTER (
           WHERE EXISTS (
                   SELECT 1 FROM core.excluded_doc x
                    WHERE x.dataset_version_id
                          = (SELECT current_version_id FROM core.dataset_pointer WHERE id = 1)
                      AND ((x.kind = 'po' AND x.doc_no = pl.sap_po_no)
                        OR (x.kind = 'pr' AND x.doc_no = pl.sap_pr_no))
                 )
              OR NOT EXISTS (
                   SELECT 1 FROM ops.v_coupa_po_line vp
                    WHERE vp.order_line_id = pl.order_line_id
                   OFFSET 0
                 )
         ) AS excluded_lines
    FROM ops.coupa_invoice_line l
    JOIN ops.coupa_po_line pl ON pl.order_line_id = l.order_line_id
   WHERE pl.sap_po_no IS NOT NULL
      OR pl.sap_pr_no IS NOT NULL
      OR pl.purch_group IS NOT NULL
   GROUP BY 1
)
SELECT i.*
  FROM ops.coupa_invoice i
  LEFT JOIN linked ON linked.invoice_id = i.id
 WHERE linked.invoice_id IS NULL
    OR linked.excluded_lines < linked.linked_lines;
