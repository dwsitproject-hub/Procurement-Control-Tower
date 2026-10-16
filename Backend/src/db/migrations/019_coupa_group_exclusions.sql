-- 019 — exclude Coupa objects by purchasing group.
--
-- Requested 20 Aug 2026: drop purchase orders and quote requests belonging to
-- 16 named purchasing groups, and drop the receipts and invoices that hang off
-- them.
--
-- ── Why a SEPARATE list from the SAP exclusions ─────────────────────────────
--
-- app.rule_config already holds 'exclusions.purch_groups', applied at transform
-- time so an excluded SAP row never reaches core.fact_*. Reusing that key here
-- would have been less code and the wrong behaviour, for two measured reasons:
--
--   1. Only ONE of the 16 requested codes appears in the SAP PO facts at all —
--      these are Coupa-side desks. Adding them to the SAP key would mostly do
--      nothing there while implying it had.
--   2. The Admin -> Data Exclusions option lists are built from SAP facts, so
--      15 of the 16 could not even be selected in that UI.
--
-- The request was also scoped ("for the Coupa API"). A separate key keeps the
-- SAP dashboards byte-identical, which is what makes this change safe to ship:
-- the drill-parity sweep cannot move.
--
-- ── Why views rather than predicates in the endpoints ───────────────────────
--
-- Same reasoning 014 gave: the rule lives in one auditable place, an endpoint
-- changes by a table name, and no admin-entered value is ever concatenated into
-- SQL. These views also honour the EXISTING SAP exclusion keys, so a group
-- excluded globally is excluded here too.

-- The Coupa-scoped list. Latest effective_from wins, matching v_exclusion_value.
CREATE OR REPLACE VIEW ops.v_coupa_excluded_group AS
SELECT v.value AS purch_group
  FROM (
    SELECT DISTINCT ON (rule_key) rule_value
      FROM app.rule_config
     WHERE rule_key = 'exclusions.coupa_purch_groups'
       AND effective_from <= CURRENT_DATE
     ORDER BY rule_key, effective_from DESC
  ) c
  CROSS JOIN LATERAL jsonb_array_elements_text(c.rule_value) AS v(value);

-- ── Purchase orders ─────────────────────────────────────────────────────────
-- The base object: everything else below is defined by reference to it, so a
-- group excluded here disappears from receipts and invoices by construction
-- rather than by repeating the list.
CREATE OR REPLACE VIEW ops.v_coupa_po_line AS
SELECT p.*
  FROM ops.coupa_po_line p
 WHERE NOT EXISTS (
         SELECT 1 FROM ops.v_coupa_excluded_group g
          WHERE g.purch_group = p.purch_group
       )
   AND NOT EXISTS (
         SELECT 1 FROM ops.v_exclusion_value x
          WHERE (x.rule_key = 'exclusions.purch_orgs'   AND x.value = p.purch_org)
             OR (x.rule_key = 'exclusions.purch_groups' AND x.value = p.purch_group)
       );

-- ── Quote requests (sourcing events) ────────────────────────────────────────
-- Replaces 014's version, which honoured only the SAP keys. Column list is
-- unchanged (e.*) so CREATE OR REPLACE is legal and dependents stay valid.
CREATE OR REPLACE VIEW ops.v_coupa_sourcing_event AS
SELECT e.*
  FROM ops.coupa_sourcing_event e
 WHERE NOT EXISTS (
         SELECT 1 FROM ops.v_coupa_excluded_group g
          WHERE g.purch_group = e.purch_group
       )
   AND NOT EXISTS (
         SELECT 1 FROM ops.v_exclusion_value x
          WHERE (x.rule_key = 'exclusions.purch_orgs'   AND x.value = e.purch_org)
             OR (x.rule_key = 'exclusions.purch_groups' AND x.value = e.purch_group)
       );

-- ── Receiving transactions ──────────────────────────────────────────────────
-- A receipt has no purchasing group of its own; it inherits the decision from
-- its order line. A receipt whose order_line_id is NULL is KEPT: nothing here
-- can judge it, the same choice 014 made for unlinked invoices.
CREATE OR REPLACE VIEW ops.v_coupa_receipt AS
SELECT r.*
  FROM ops.coupa_receipt r
 WHERE r.order_line_id IS NULL
    OR EXISTS (
         SELECT 1 FROM ops.v_coupa_po_line p
          WHERE p.order_line_id = r.order_line_id
       );

-- ── Invoice lines ───────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW ops.v_coupa_invoice_line AS
SELECT l.*
  FROM ops.coupa_invoice_line l
 WHERE l.order_line_id IS NULL
    OR EXISTS (
         SELECT 1 FROM ops.v_coupa_po_line p
          WHERE p.order_line_id = l.order_line_id
       );

-- ── Invoices ────────────────────────────────────────────────────────────────
-- Extends 014. That version dropped an invoice when every SAP-linked line
-- pointed at an excluded document; a line is now also "excluded" when its Coupa
-- order line is excluded by purchasing group. The surrounding rule is
-- deliberately unchanged and worth restating:
--
--   * no linkage at all            -> KEPT, because nothing here can judge it;
--   * a mix of excluded and surviving lines -> KEPT, so a partially relevant invoice
--     is never silently removed.
--
-- "Something survived wins" — the same rule the transform applies to approval
-- steps.
CREATE OR REPLACE VIEW ops.v_coupa_invoice AS
WITH linked AS (
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

-- ── Payments ────────────────────────────────────────────────────────────────
-- No view needed, and that is worth recording rather than leaving someone to
-- wonder: every payment query already reads
--   FROM ops.coupa_payment p JOIN ops.v_coupa_invoice i ON i.id = p.invoice_id
-- so a payment whose invoice is excluded is already dropped by the join. A
-- v_coupa_payment would be redundant filtering. If a future query reads
-- ops.coupa_payment WITHOUT that join, it must add the exclusion itself.

-- ── Supplier responses (quotes) ─────────────────────────────────────────────
-- Same argument on the sourcing side: a quote against an excluded quote request
-- must not keep appearing in response counts and award analytics.
CREATE OR REPLACE VIEW ops.v_coupa_supplier_response AS
SELECT r.*
  FROM ops.coupa_supplier_response r
 WHERE EXISTS (
         SELECT 1 FROM ops.v_coupa_sourcing_event e WHERE e.id = r.quote_request_id
       );
