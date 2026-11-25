-- 038 - a material's spend category, set by hand on the Master > Materials tab.
--
-- Requested 16 Oct 2026: every field the Materials table shows should be
-- editable, the category above all. The category was not stored on the
-- material at all - it is RESOLVED, by the chain in packages/rules
-- spend_category.ts: exact material code, code prefix, material group, then the
-- SAP material master. So "edit the category" has to mean "add a rule that
-- wins", and this table is that rule.
--
-- It is the FIRST step of the chain (spendCategorySql), ahead of the business
-- mapping file's own material-code rows. Kept apart from core.dim_spend_category
-- on purpose: writing a manual value there would overwrite the business file's
-- row for that material, and reverting the edit would then need the old row
-- back. Here, reverting is deleting one row, and the business file is never
-- touched.
--
-- Because the same generator stamps fact_po_line.spend_category and
-- fact_pr_item.spend_category at load, a value here reaches every chart and
-- KPI at the next recompute, and the Materials page shows it at once.
--
-- Not refreshed by any sync: nothing but the Master page writes it. The edit is
-- also recorded in app.master_override (relation core.dim_material), which is
-- what badges the row and offers Revert.

CREATE TABLE IF NOT EXISTS core.dim_material_category_manual (
  material_code text PRIMARY KEY,
  category      text NOT NULL,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
