-- 014 — which documents a version's exclusion config dropped.
--
-- Data exclusions are applied at transform time: excluded rows are simply not
-- loaded into core.fact_*, which is what makes every KPI, chart, drill and
-- detail row agree by construction.
--
-- That mechanism cannot reach the Coupa store. ops.coupa_* is a shared,
-- continuously-polled dataset that is NOT rebuilt per version, so the invoice
-- and payment pages read it directly and never saw an exclusion. Recording what
-- the transform dropped lets those queries honour the same configuration
-- without duplicating the exclusion rules — the transform stays the single
-- place that decides.
--
-- Coupa sourcing events need none of this: they carry purch_org and purch_group
-- themselves, so they are filtered on their own columns.
--
-- Rows die with their version: prune_versions() deletes core.dataset_version
-- rows, and the cascade takes these with them.

CREATE TABLE IF NOT EXISTS core.excluded_doc (
  dataset_version_id bigint  NOT NULL
    REFERENCES core.dataset_version(id) ON DELETE CASCADE,
  kind               text    NOT NULL CHECK (kind IN ('po', 'pr')),
  doc_no             text    NOT NULL,
  doc_item           integer NOT NULL,
  -- Which setting dropped it ('doc_type=EU70'), for audit and for answering
  -- "why is this invoice missing?" without re-deriving the decision.
  reason             text    NOT NULL,
  PRIMARY KEY (dataset_version_id, kind, doc_no, doc_item)
);

-- The Coupa queries look up by document number, not by line.
CREATE INDEX IF NOT EXISTS ix_excluded_doc_no
  ON core.excluded_doc (dataset_version_id, kind, doc_no);

-- ── Coupa views that honour the exclusion config ─────────────────────────
--
-- Expressed as views, not as predicates pasted into a dozen endpoint queries:
-- the rule then lives in one auditable place, the endpoints change by a table
-- name, and no admin-entered value is ever concatenated into SQL.

-- Sourcing events carry the exclusion attributes themselves, so they need no
-- bridge to SAP. The lists are read from the rule store here rather than
-- passed in, which keeps this a plain view.
CREATE OR REPLACE VIEW ops.v_exclusion_value AS
SELECT c.rule_key, v.value
  FROM (
    SELECT DISTINCT ON (rule_key) rule_key, rule_value
      FROM app.rule_config
     WHERE rule_key IN ('exclusions.purch_groups', 'exclusions.purch_orgs', 'exclusions.doc_types')
       AND effective_from <= CURRENT_DATE
     ORDER BY rule_key, effective_from DESC
  ) c
  CROSS JOIN LATERAL jsonb_array_elements_text(c.rule_value) AS v(value);

CREATE OR REPLACE VIEW ops.v_coupa_sourcing_event AS
SELECT e.*
  FROM ops.coupa_sourcing_event e
 WHERE NOT EXISTS (
         SELECT 1 FROM ops.v_exclusion_value x
          WHERE (x.rule_key = 'exclusions.purch_orgs'   AND x.value = e.purch_org)
             OR (x.rule_key = 'exclusions.purch_groups' AND x.value = e.purch_group)
       );

-- An invoice is dropped only when it is linked to SAP and EVERY linked line
-- points at an excluded document. Two deliberate choices:
--   * no SAP linkage at all -> kept, because nothing here can judge it;
--   * a mix of excluded and surviving lines -> kept, so a partially-relevant
--     invoice is never silently removed. Same "something survived wins" rule
--     the transform applies to approval steps.
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
         ) AS excluded_lines
    FROM ops.coupa_invoice_line l
    JOIN ops.coupa_po_line pl ON pl.order_line_id = l.order_line_id
   WHERE pl.sap_po_no IS NOT NULL OR pl.sap_pr_no IS NOT NULL
   GROUP BY 1
)
SELECT i.*
  FROM ops.coupa_invoice i
  LEFT JOIN linked ON linked.invoice_id = i.id
 WHERE linked.invoice_id IS NULL
    OR linked.excluded_lines < linked.linked_lines;
