-- 051 - SAP down payments (25 Nov 2026).
--
-- The "DP All" export: vendor line items on the down-payment G/L accounts
-- (FBL1N-style), dropped in the same folder as the PR/PO exports or uploaded by
-- hand. It complements Coupa, which holds invoices raised after goods receipt
-- and almost no down payments: on the 23 Nov 2026 file, 1 of 443 POs with an
-- SAP DP also had a Coupa payment - and that one was the same money, recorded in
-- Coupa as an invoice whose number IS the SAP DP document number.
--
-- Meaning of a row (user rule, 25 Nov 2026):
--   Clearing Date empty  -> the DP is outstanding (an advance still open);
--   Clearing Date filled -> settled against the vendor's final invoice: the PO
--                           is fully paid. The amount stays the DP amount - the
--                           balance paid at the end is on the normal vendor
--                           account, not in this file.
-- Negative rows are DP deductions ("POT DP"), reversals and refunds: summed with
-- the rest, never counted as payments of their own.

-- ── the feed id ─────────────────────────────────────────────────────────────
-- Same pair of CHECKs 018 widened for the reference feeds.
ALTER TABLE app.template_version DROP CONSTRAINT IF EXISTS template_version_feed_check;
ALTER TABLE app.template_version
  ADD CONSTRAINT template_version_feed_check
  CHECK (feed IN ('pr','prel','po','por','gr','fx','pgrp','porg','matm','zuser','dp'));

ALTER TABLE ingest.batch_file DROP CONSTRAINT IF EXISTS batch_file_detected_feed_check;
ALTER TABLE ingest.batch_file
  ADD CONSTRAINT batch_file_detected_feed_check
  CHECK (detected_feed IN ('pr','prel','po','por','gr','fx','pgrp','porg','matm','zuser','dp'));

-- ── the store ───────────────────────────────────────────────────────────────
-- Per dataset version, like the facts: every version carries its own DP
-- snapshot, so a manual upload awaiting confirmation, a rejected batch or a
-- rollback can never change what the published version shows. A version's
-- snapshot is the published one it was built on, with - when the batch brings
-- a DP file - the rows of each company code whose posting date falls inside
-- the range that file covers replaced by the file's rows (transform.ts
-- loadSapDownPayments). A full "DP All" refresh and a one-month file are both
-- right, and nothing outside the file's range is lost. Pruned versions take
-- their rows with them (ON DELETE CASCADE).
--
-- No natural key: the 23 Nov 2026 layout has no fiscal year or line item, so a
-- document number repeats across company codes and genuinely identical line
-- items exist (19 rows in 6 groups). Rows are therefore never de-duplicated by
-- content; id is a surrogate.
CREATE TABLE IF NOT EXISTS ops.sap_dp_line (
  id               bigserial PRIMARY KEY,
  dataset_version_id bigint NOT NULL REFERENCES core.dataset_version(id) ON DELETE CASCADE,
  company_code     text    NOT NULL,
  business_area    text,
  purchasing_doc   text,              -- as exported: a PO number or "EUPOTEMP"-style placeholder
  po_no            text,              -- the SAP PO: purchasing_doc, else a 10-digit Assignment; NULL = not a PO
  gl_account       text    NOT NULL,
  gl_text          text,
  vendor_code      text    NOT NULL,
  vendor_name      text,
  clearing_date    date,              -- NULL = DP outstanding
  clearing_doc     text,
  fiscal_year      int,
  line_item        int,
  tax_code         text,
  assignment       text,
  doc_no           text    NOT NULL,
  doc_type         text,
  doc_date         date,
  posting_date     date    NOT NULL,
  amount           numeric NOT NULL,  -- document currency; negative = deducted / reversed
  currency         text    NOT NULL,
  amount_lc2       numeric,           -- SAP's second local currency (US$ on the reference file)
  lc2_currency     text,
  item_text        text,
  source_batch_id  bigint,
  source_row       int,
  loaded_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_sap_dp_po ON ops.sap_dp_line (dataset_version_id, po_no);
CREATE INDEX IF NOT EXISTS ix_sap_dp_doc ON ops.sap_dp_line (dataset_version_id, doc_no);
CREATE INDEX IF NOT EXISTS ix_sap_dp_window ON ops.sap_dp_line (dataset_version_id, company_code, posting_date);

-- ── PCT scope ───────────────────────────────────────────────────────────────
-- The same exclusions the facts apply, read live:
--   * a PO the transform excluded (purchasing org / group, doc type, held,
--     deleted, intercompany...) is in core.excluded_doc for the current version;
--   * intercompany vendors by code prefix (exclusions.interco_vendor_prefixes),
--     which also covers POs not in the PO export;
--   * a row with no PO at all (insurance premiums, a tax DP, a withholding-tax
--     overpayment on the reference file) is not a procurement DP.
-- in_pct_po says whether the PO is in the current SAP PO data; a DP on a PO
-- the PO export does not carry (newer than the version, or a series it does
-- not include) still counts, and the popups show the flag. Only the current
-- version's snapshot is read.
CREATE OR REPLACE VIEW ops.v_sap_dp_line AS
SELECT d.*,
       (d.clearing_date IS NULL) AS is_open,
       EXISTS (
         SELECT 1 FROM core.fact_po_line f
          WHERE f.dataset_version_id = (SELECT current_version_id FROM core.dataset_pointer WHERE id = 1)
            AND f.po_no = d.po_no
       ) AS in_pct_po
  FROM ops.sap_dp_line d
 WHERE d.dataset_version_id = (SELECT current_version_id FROM core.dataset_pointer WHERE id = 1)
   AND d.po_no IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM core.excluded_doc x
          WHERE x.dataset_version_id = (SELECT current_version_id FROM core.dataset_pointer WHERE id = 1)
            AND x.kind = 'po' AND x.doc_no = d.po_no
       )
   AND NOT EXISTS (
         SELECT 1
           FROM (SELECT DISTINCT ON (rule_key) rule_value
                   FROM app.rule_config
                  WHERE rule_key = 'exclusions.interco_vendor_prefixes' AND effective_from <= CURRENT_DATE
                  ORDER BY rule_key, effective_from DESC) c
           CROSS JOIN LATERAL jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(c.rule_value) = 'array' THEN c.rule_value ELSE '[]'::jsonb END) p(pre)
          WHERE btrim(p.pre) <> '' AND upper(d.vendor_code) LIKE upper(btrim(p.pre)) || '%'
       );

-- ── no double counting with Coupa ───────────────────────────────────────────
-- A Coupa invoice whose number is an SAP DP document number on the same PO is
-- that down payment, keyed into Coupa: it is counted once, as the SAP DP. Read
-- against the raw store (not the scoped view) so a DP excluded from PCT does
-- not bring its Coupa twin back.
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
 WHERE (linked.invoice_id IS NULL
        OR linked.excluded_lines < linked.linked_lines)
   AND NOT EXISTS (
         SELECT 1 FROM ops.sap_dp_line dp
           JOIN ops.coupa_invoice_line il ON il.invoice_id = i.id
           JOIN ops.coupa_po_line pl ON pl.order_line_id = il.order_line_id
          WHERE dp.dataset_version_id = (SELECT current_version_id FROM core.dataset_pointer WHERE id = 1)
            AND dp.doc_no = i.invoice_number AND dp.po_no = pl.sap_po_no
       );

-- The per-PO Coupa payment used by Open Items: the same twin left out, so a PO
-- paid only through that invoice is "paid" by its SAP DP instead (below).
CREATE OR REPLACE VIEW ops.v_coupa_paid_sap_po AS
WITH inv AS (
  SELECT i.id, i.payment_date,
         (i.paid IS TRUE OR EXISTS (SELECT 1 FROM ops.coupa_payment p WHERE p.invoice_id = i.id)) AS is_paid,
         COALESCE((SELECT sum(p.amount_paid) FROM ops.coupa_payment p WHERE p.invoice_id = i.id), 0) AS paid_amount
    FROM ops.coupa_invoice i
   WHERE NOT EXISTS (
           SELECT 1 FROM ops.sap_dp_line dp
             JOIN ops.coupa_invoice_line il ON il.invoice_id = i.id
             JOIN ops.coupa_po_line pl ON pl.order_line_id = il.order_line_id
            WHERE dp.dataset_version_id = (SELECT current_version_id FROM core.dataset_pointer WHERE id = 1)
              AND dp.doc_no = i.invoice_number AND dp.po_no = pl.sap_po_no
         )
), linked AS (
  SELECT DISTINCT pl.sap_po_no, inv.id AS invoice_id, inv.payment_date, inv.paid_amount
    FROM ops.coupa_invoice_line il
    JOIN inv ON inv.id = il.invoice_id AND inv.is_paid
    JOIN ops.coupa_po_line pl
      ON (il.order_line_id IS NOT NULL AND pl.order_line_id = il.order_line_id)
      OR (il.order_line_id IS NULL AND pl.po_number = il.po_number)
   WHERE pl.sap_po_no IS NOT NULL AND btrim(pl.sap_po_no) <> ''
)
SELECT sap_po_no AS po_no,
       count(DISTINCT invoice_id)::int AS paid_invoices,
       sum(paid_amount) AS paid_amount,
       min(payment_date) AS first_payment_date
  FROM linked
 GROUP BY sap_po_no;
