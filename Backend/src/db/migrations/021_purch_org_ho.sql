-- 021 — Head Office flag on the purchasing-organisation master.
--
-- Restores the HQ-versus-site panel of the reference design, which 020 dropped
-- on a WRONG conclusion worth recording so it is not repeated.
--
-- That panel showed Head Office holding 92% of value against 51% of PO lines.
-- Checking it against dim_purch_group.is_ho gave 2% / 17% — inverted — and the
-- panel was replaced. But purchasing GROUP is the buyer's desk; the HQ-versus-
-- site distinction in this business lives on the purchasing ORGANISATION. On
-- that dimension the split is 98.3% of value and 73% of lines, which matches the
-- design in both shape and magnitude. The original was right; the check was
-- measured on the wrong column.
--
-- ── The rule, and why it is a rule rather than a column ─────────────────────
--
-- SAP's P Org export carries a code and a description, no HQ marker. The
-- descriptions are consistent enough to classify on: HQ orgs are prefixed
-- 'HQ-', sites carry their location ('Bontang-NTRD Pur', 'Kijing-NTRD Pur',
-- 'L.Gaung-NTRD Pur'). dim_purch_group (017) already classifies the same way,
-- so this is the established convention here rather than a new invention.
--
-- All eleven organisations present in the current data, for the record — with
-- only eleven this is inspectable rather than a leap of faith:
--
--   PUR1  HQ-PURCHASING DWS    86.5% of value   HQ
--   PRO3  HQ-PROJECT SPO        7.8%            HQ
--   PCP1  HQ-PURCH COUPA DWS    1.8%            HQ
--   OPS3  HQ-OPERASIONAL SPO    1.2%            HQ
--   BTG1  Bontang-NTRD Pur      0.9%            site
--   HRG1  HQ-PGA HRD            0.5%            HQ
--   IMP1  HQ-PURCHASE IMPORT    0.5%            HQ
--   KJG1  Kijing-NTRD Pur       0.3%            site
--   PPIC  Jakarta-PPIC          0.2%            NOT HQ  <- judgement call
--   LGL1  LEGAL LICENSE DWS     0.2%            NOT HQ  <- judgement call
--   LBG1  L.Gaung-NTRD Pur      0.1%            site
--
-- The two judgement calls are called out because they are judgement calls, not
-- because they matter to the total: PPIC is a planning function in Jakarta and
-- LGL1 is legal, and between them they are 0.4% of value. Reclassifying both as
-- HQ moves the headline from 98.3% to 98.7%. They are flagged here so the
-- decision is visible rather than buried, and `is_ho` is a plain column so an
-- administrator can correct either without a deployment.
ALTER TABLE core.dim_purch_org ADD COLUMN IF NOT EXISTS is_ho boolean;

-- Backfill from the descriptions already loaded. The ingest recomputes this on
-- every refresh (see upsertReferenceData), so this only matters for an
-- installation that will not re-ingest before someone opens the page.
UPDATE core.dim_purch_org
   SET is_ho = (description LIKE 'HQ%' OR description LIKE 'HO %' OR description LIKE 'HO-%')
 WHERE is_ho IS NULL;
