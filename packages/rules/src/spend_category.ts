/**
 * Spend-category resolution, as SQL, in one place.
 *
 * The transform stamps `fact_po_line.spend_category` at publish time; the
 * Materials master shows the same answer for every material in the catalogue,
 * including ones the current dataset never ordered. Those are two different
 * queries over two different populations, and they MUST agree — a master page
 * that says a material is Chemical while the chart counts it as Bleaching Earth
 * is worse than no master page at all.
 *
 * So the rule lives here and both callers generate it, the same way
 * sizeBandSql() already keeps the band boundaries from being retyped.
 *
 * INNER ALIASES ARE DELIBERATELY UGLY. `sc_` and `mm_` rather than `c` and `m`,
 * because a caller naturally aliases its own table `m` for materials — and then
 * the SAP-master subquery's `m.material_code = m.material_code` correlates to
 * ITSELF, matches every row, and fails with "more than one row returned by a
 * subquery". It does not fail to parse, it silently changes meaning, and only
 * the duplicate-row error made it visible.
 *
 * ── The order, and why each step exists ─────────────────────────────────────
 *
 *   1. exact material code    the business file names individual materials
 *   2. material-code PREFIX   912.001 is every Bleaching Earth code; the
 *                             business shows those beside Chemical, not inside
 *                             it, and there are ten of them. Longest prefix
 *                             wins, so a narrower rule always beats a wider one.
 *   3. material group         the bulk of the mapping, 86 of its 96 rows
 *   4. SAP material master    the fallback that existed before the business
 *                             file, and still covers what the file omits
 *   5. the two placeholders   deliberately visible rather than folded into an
 *                             "Others" bucket: a line with no material code is
 *                             a different statement from one whose material is
 *                             unmapped, and burying either misstates every
 *                             share on the page.
 */

/** How the category was reached — the values spendCategorySourceSql can return. */
export const SPEND_CATEGORY_SOURCES = [
  'material code',
  'code prefix',
  'material group',
  'SAP master',
  'no material code',
  'unmapped',
] as const;

export type SpendCategorySource = (typeof SPEND_CATEGORY_SOURCES)[number];

/**
 * The resolved category.
 *
 * `codeCol` and `groupCol` are SQL expressions naming the material code and
 * material group of the row being resolved — qualified by the caller, since the
 * transform reads `f.material_code` and the master page reads `m.material_code`.
 */
export function spendCategorySql(codeCol: string, groupCol: string): string {
  return `COALESCE(
              (SELECT sc_.category FROM core.dim_spend_category sc_
                WHERE sc_.material_code = ${codeCol}),
              (SELECT sc_.category FROM core.dim_spend_category sc_
                WHERE sc_.material_prefix IS NOT NULL
                  AND ${codeCol} LIKE sc_.material_prefix || '.%'
                ORDER BY length(sc_.material_prefix) DESC LIMIT 1),
              (SELECT sc_.category FROM core.dim_spend_category sc_
                WHERE sc_.material_group = ${groupCol}),
              (SELECT mm_.category FROM core.dim_material_master mm_
                WHERE mm_.material_code = ${codeCol} AND mm_.category IS NOT NULL),
              CASE WHEN ${codeCol} IS NULL OR ${codeCol} = ''
                     THEN '(no material code)'
                   ELSE '(unmapped)' END)`;
}

/**
 * WHICH rule produced the category.
 *
 * The reason the standalone mapping page could be folded into Materials: a list
 * of 96 abstract rules answers "what rules exist", which is rarely the question.
 * Attached to a material it answers the question people actually ask — "why is
 * this one Chemical?" — and "show me everything that came from prefix 912.001"
 * becomes a search rather than a join done by eye.
 *
 * Mirrors spendCategorySql step for step. The two are generated from the same
 * shape on purpose: if one gains a rule and the other does not, the page starts
 * attributing categories to the wrong rule.
 */
export function spendCategorySourceSql(codeCol: string, groupCol: string): string {
  return `CASE
            WHEN EXISTS (SELECT 1 FROM core.dim_spend_category sc_
                          WHERE sc_.material_code = ${codeCol})
              THEN 'material code'
            WHEN EXISTS (SELECT 1 FROM core.dim_spend_category sc_
                          WHERE sc_.material_prefix IS NOT NULL
                            AND ${codeCol} LIKE sc_.material_prefix || '.%')
              THEN 'code prefix'
            WHEN EXISTS (SELECT 1 FROM core.dim_spend_category sc_
                          WHERE sc_.material_group = ${groupCol})
              THEN 'material group'
            WHEN EXISTS (SELECT 1 FROM core.dim_material_master mm_
                          WHERE mm_.material_code = ${codeCol} AND mm_.category IS NOT NULL)
              THEN 'SAP master'
            WHEN ${codeCol} IS NULL OR ${codeCol} = ''
              THEN 'no material code'
            ELSE 'unmapped'
          END`;
}

/**
 * The CAPEX split, which is a property of the PLANT rather than the material.
 *
 * Requested 1 Sep 2026: capital spend divides into project and operational work,
 * and the business tells them apart by the plant code — a '9' in the third
 * position means a project plant (EU92, EU93, PM91), anything else is
 * operational.
 *
 * This is deliberately NOT folded into spendCategorySql. That function answers
 * "what category is this material", and the Materials master calls it for
 * materials that belong to no plant at all — a material is not project or
 * operational, a LINE is. So the split is applied on top, only where a plant
 * exists, and the master page says so rather than showing a CAPEX answer it
 * cannot know.
 *
 * A line whose plant is missing or shorter than three characters stays
 * operational: substr() returns '' there, which is not '9', and inventing a
 * project classification from an absent plant would be worse than the default.
 */
export function spendCategoryWithPlantSql(
  codeCol: string,
  groupCol: string,
  plantCol: string,
): string {
  const base = spendCategorySql(codeCol, groupCol);
  return `CASE WHEN (${base}) IN ('CAPEX OPS', 'CAPEX', 'CAPEX PROJ')
                 THEN CASE WHEN substr(COALESCE(${plantCol}, ''), 3, 1) = '9'
                             THEN 'CAPEX PROJ' ELSE 'CAPEX OPS' END
               ELSE (${base}) END`;
}
