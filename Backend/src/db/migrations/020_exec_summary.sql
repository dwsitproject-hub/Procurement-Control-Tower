-- 020 — Executive Summary page: spend category and transaction size band.
--
-- Both are materialised ONTO THE FACT rather than joined at query time. That is
-- this codebase's existing rule ("every attribute that affects a figure is
-- denormalised onto the fact, so a renamed vendor never changes a published
-- number") and here it is also what makes the page drillable: a chart point and
-- its drill predicate must filter on the same column, and the parity sweep
-- checks exactly that. A category that lived only in a join could not be
-- expressed as a drill filter.
--
-- ── The spend-category mapping ──────────────────────────────────────────────
--
-- The Executive Summary's category axis is NOT dim_material_master.category. It
-- is close to it, but the business taxonomy needs three things the SAP master
-- does not carry, all visible in the reference design:
--
--   * commodities carved OUT of a category — Sodium Methylate and Bleaching
--     Earth are shown beside Chemical, not inside it;
--   * CAPEX split into Project and Ops, where the master has one CAPEX value;
--   * small categories folded into "Others".
--
-- So the mapping is its own table, to be populated from a file the business
-- supplies. Until then the resolution order below falls back to the SAP master,
-- which means the page works today and sharpens when the file lands — no code
-- change, just a recompute.
--
-- Resolution order, most specific first (mirrors the storage-resolution pattern
-- in Backend/src/config/storage.ts):
--
--   1. mapping row for the exact material code
--   2. mapping row for the material group
--   3. dim_material_master.category            (the SAP master, 018)
--   4. '(no material code)'                    when the line carries no material
--   5. '(unmapped)'                            everything else
--
-- 4 and 5 are deliberately visible rather than swept into "Others". 12.8% of
-- committed value sits on lines with no material code at all — service and text
-- lines — and hiding that inside a business category would misstate every share
-- on the page. An executive summary that quietly buckets an eighth of the value
-- is worse than one that admits it.
CREATE TABLE IF NOT EXISTS core.dim_spend_category (
  -- Exactly one of these two is set; the check below enforces it.
  material_code  text,
  material_group text,
  category       text NOT NULL,
  -- Display order on the page. NULL sorts last, so an unranked row still shows.
  sort_order     integer,
  source         text NOT NULL DEFAULT 'mapping_file',
  CONSTRAINT dim_spend_category_key_one
    CHECK ((material_code IS NOT NULL) <> (material_group IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_spend_category_code
  ON core.dim_spend_category (material_code) WHERE material_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_spend_category_group
  ON core.dim_spend_category (material_group) WHERE material_group IS NOT NULL;

-- ── Materialised on the PO fact ─────────────────────────────────────────────
ALTER TABLE core.fact_po_line ADD COLUMN IF NOT EXISTS spend_category text;

-- ── Transaction size band ───────────────────────────────────────────────────
-- Stored as a sortable key ('1' .. '7') rather than a label, for two reasons
-- learned from the reference design's own mistakes:
--
--   * the design sorts its bands by % value, so '100-500 Jt' is drawn ABOVE
--     '500 Jt-1 Bio'. On an interval scale that destroys the distribution shape
--     the panel exists to show. An ordinal key makes the correct order the
--     default and a wrong one impossible to reach by accident.
--   * the design labels the same magnitude 'Bio' in one panel and 'M' in
--     another. One ladder is defined once, in packages/rules, and both the
--     transform and the page read it.
--
-- Banded on net_order_value_idr because the bands are stated in rupiah. A line
-- with no IDR value gets NULL and is excluded from the panel rather than
-- counted as zero, which would inflate the smallest band.
ALTER TABLE core.fact_po_line ADD COLUMN IF NOT EXISTS size_band text;

CREATE INDEX IF NOT EXISTS ix_pol_spend_category
  ON core.fact_po_line (dataset_version_id, spend_category);
CREATE INDEX IF NOT EXISTS ix_pol_size_band
  ON core.fact_po_line (dataset_version_id, size_band);
