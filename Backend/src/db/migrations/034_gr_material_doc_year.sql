-- 034 - goods-receipt postings are keyed by YEAR, document and item.
--
-- Reported 25 Sep 2026: the first upload whose extract spanned more than one
-- year - 2023 to 2026, so older orders and their receipts would appear - failed
-- to load:
--
--   duplicate key value violates unique constraint "fact_gr_posting_v38_pkey"
--
-- SAP numbers material documents per FISCAL YEAR. The real key of a receipt is
-- year + document + item (MJAHR, MBLNR, ZEILE), and the number range restarts
-- each year. This table was keyed on document + item alone, which held for
-- every extract until now because each one covered a single year. The upload
-- carried 217 collisions - document 5190005034 item 1 posted both on 2 Jan 2026
-- and on 7 Jan 2025 - and every one of them was two different receipts in two
-- different years, not a repeated row. With the year in the key, all 86,496
-- rows are distinct.
--
-- The export carries no year column. The year of the posting date IS the fiscal
-- year for these companies, which close on the calendar year, and posting_date
-- is NOT NULL here, so the backfill below and the transform both derive it from
-- that one column.
--
-- A partitioned table: dropping the parent's key drops each partition's, and
-- adding it back builds one per partition. Existing rows were already unique on
-- the old key, so they stay unique on a key that only adds a column.

ALTER TABLE core.fact_gr_posting ADD COLUMN IF NOT EXISTS material_doc_year smallint;

UPDATE core.fact_gr_posting
   SET material_doc_year = EXTRACT(YEAR FROM posting_date)::smallint
 WHERE material_doc_year IS NULL;

ALTER TABLE core.fact_gr_posting ALTER COLUMN material_doc_year SET NOT NULL;

ALTER TABLE core.fact_gr_posting DROP CONSTRAINT IF EXISTS fact_gr_posting_pkey;
ALTER TABLE core.fact_gr_posting
  ADD CONSTRAINT fact_gr_posting_pkey
  PRIMARY KEY (dataset_version_id, material_doc_year, material_doc, material_doc_item);
