/**
 * "CODE — Name" for a plant code (26 Nov 2026: the plant name beside the code
 * wherever a code is shown). The names are core.dim_plant's, which the Data Hub
 * plant master keeps current (dhm/plant.ts); a plant without a name, or whose
 * name is its code, shows the bare code.
 *
 * `code` must be a QUALIFIED column (`f.plant`, `core.fact_po_line.plant`): a
 * bare `plant` inside the lookup would resolve to dim_plant's own column.
 */
export function plantLabelSql(code: string): string {
  return `(${code} || COALESCE(' — ' || NULLIF((SELECT _pl.plant_name FROM core.dim_plant _pl WHERE _pl.plant = ${code}), ${code}), ''))`;
}
