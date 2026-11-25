-- 047 — exclude Coupa data by PLANT (19 Nov 2026).
--
-- Coupa is shared with business units this dashboard does not cover. The user
-- confirmed the 11…/12…-series SAP POs in Coupa belong to Upstream, which is
-- out of scope for the Procurement Control Tower, and chose the wider rule: any
-- Coupa plant group that never appears in the SAP PR/PO files is out of scope.
--
-- ── Why plant, not the PO number ────────────────────────────────────────────
-- A quote request (sourcing event) has no SAP PO, so a PO-number rule could not
-- reach the Sourcing page, where about half the events were out of scope. And
-- the 10/13 series are shared: TH, CR and JJ (10…) and CM, PD, SA and SU (13…)
-- never appear in the SAP files either. Every Coupa PO line and event carries a
-- plant code, and the first two characters name the site.
--
-- ── Matching ────────────────────────────────────────────────────────────────
-- A value is a plant-code PREFIX: 'TH' drops TH01, TH3T…; a full code such as
-- 'TH3T' drops just that plant. Compared with left() rather than LIKE so no
-- value can act as a wildcard. A line or event with no plant is KEPT - nothing
-- here can judge it, the rule 019 applies to unlinked receipts and invoices.
--
-- ── Where it applies ────────────────────────────────────────────────────────
-- In the two BASE views only. Receipts, invoice lines and invoices are defined
-- by reference to v_coupa_po_line, quotes by reference to
-- v_coupa_sourcing_event (019, 046), so they inherit the rule by construction.
-- SAP-side figures are unaffected: these plants are not in the SAP facts.
-- Like 019's list, it is live the moment Admin -> Data Exclusions saves it.

CREATE OR REPLACE VIEW ops.v_coupa_excluded_plant AS
SELECT DISTINCT upper(btrim(v.value)) AS plant
  FROM (
    SELECT DISTINCT ON (rule_key) rule_value
      FROM app.rule_config
     WHERE rule_key = 'exclusions.coupa_plants'
       AND effective_from <= CURRENT_DATE
     ORDER BY rule_key, effective_from DESC
  ) c
  CROSS JOIN LATERAL jsonb_array_elements_text(c.rule_value) AS v(value)
 WHERE btrim(v.value) <> '';

-- p.* now also carries requisition_id (036 added the column after 019 built
-- the view). It lands at the end of the list, which CREATE OR REPLACE allows.
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
       )
   AND NOT EXISTS (
         SELECT 1 FROM ops.v_coupa_excluded_plant xp
          WHERE left(upper(p.plant), length(xp.plant)) = xp.plant
       );

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
       )
   AND NOT EXISTS (
         SELECT 1 FROM ops.v_coupa_excluded_plant xp
          WHERE left(upper(e.plant), length(xp.plant)) = xp.plant
       );

-- The starting list: every plant group in Coupa (POs and sourcing events) that
-- has no plant in the SAP files, measured against the live Coupa store and
-- core.dim_plant on 19 Nov 2026.
--   Upstream, 11… POs : AC AM BU HS IU KB SI SN TS WS
--   Upstream, 12… POs : AJ BS GN IP KU NJ PN PT WW
--   10… POs           : CR JJ TH
--   13… POs           : CM PD SA SU
--   events only       : JN
-- Seeded only where the key has never been set, so an environment whose admin
-- already saved a list keeps it. Editable in Admin -> Data Exclusions.
INSERT INTO app.rule_config (rule_key, rule_value, effective_from, note)
SELECT 'exclusions.coupa_plants',
       '["AC","AM","BU","HS","IU","KB","SI","SN","TS","WS",
         "AJ","BS","GN","IP","KU","NJ","PN","PT","WW",
         "CR","JJ","TH","CM","PD","SA","SU","JN"]'::jsonb,
       CURRENT_DATE,
       '047: Coupa plants outside the SAP files (Upstream and other BUs) - out of scope'
 WHERE NOT EXISTS (SELECT 1 FROM app.rule_config WHERE rule_key = 'exclusions.coupa_plants');
