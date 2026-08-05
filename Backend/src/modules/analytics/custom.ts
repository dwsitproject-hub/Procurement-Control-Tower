/**
 * Custom KPI / chart builder — W7. v1's cu-modal and ce-modal.
 *
 * A user composes a figure from WHITELISTED parts only: a grain, a measure over
 * a whitelisted column, and whitelisted filters. Nothing user-supplied ever
 * reaches SQL as text — every identifier comes from the maps below and every
 * value is a bound parameter.
 *
 * User-defined figures live OUTSIDE packages/rules, so they carry no
 * golden-number guarantee. The API stamps every result `userDefined: true` and
 * the UI is required to show that.
 */

import { pool } from '../../db/client.js';
import { mintScopedQuery, scopeSql, type ScopeEntry } from '../authz/scope.js';

export type CustomGrain = 'pr_item' | 'po_line';

const TABLES: Record<CustomGrain, string> = {
  pr_item: 'core.fact_pr_item',
  po_line: 'core.fact_po_line',
};

/** Numeric columns a measure may aggregate, per grain. */
const MEASURE_COLUMNS: Record<CustomGrain, Record<string, string>> = {
  pr_item: {
    total_value_idr: 'total_value_idr',
    total_value_usd: 'total_value_usd',
    qty_requested: 'qty_requested',
    aging_days: 'aging_days',
    approval_days: '(release_final_date - requisition_date)',
  },
  po_line: {
    net_order_value: 'net_order_value',
    net_order_value_usd: 'net_order_value_usd',
    order_qty: 'order_qty',
    unit_price: 'unit_price',
    aging_days: 'aging_days',
    sourcing_days: 'sourcing_days',
    po_approval_days: 'po_approval_days',
    delivery_days: 'delivery_days',
    still_deliver_val_usd: 'still_deliver_val_usd',
    still_invoice_val_usd: 'still_invoice_val_usd',
  },
};

const AGGS: Record<string, (col: string) => string> = {
  count: () => 'count(*)',
  sum: (c) => `sum(${c})`,
  avg: (c) => `avg(${c})`,
  median: (c) => `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${c})`,
  min: (c) => `min(${c})`,
  max: (c) => `max(${c})`,
};

/** Categorical columns usable as filters or chart dimensions, per grain. */
const DIMENSION_COLUMNS: Record<CustomGrain, Record<string, string>> = {
  pr_item: {
    status: 'status',
    material_category: 'material_category',
    material_group: 'material_group',
    plant: 'plant',
    company_code: 'company_code',
    purch_org: 'purch_org',
    purch_group: 'purch_group',
    priority_label: 'priority_label',
    wbs_status: 'wbs_status',
    month: `to_char(requisition_date,'YYYY-MM')`,
  },
  po_line: {
    status: 'status',
    material_category: 'material_category',
    material_group: 'material_group',
    plant: 'plant',
    company_code: 'company_code',
    purch_org: 'purch_org',
    purch_group: 'purch_group',
    priority_label: 'priority_label',
    vendor_code: 'vendor_code',
    doc_type: 'doc_type',
    currency_code: 'currency_code',
    po_release_state: 'po_release_state',
    month: `to_char(document_date,'YYYY-MM')`,
  },
};

/** Boolean toggles a spec may apply, mapping to existing fact flags. */
const TOGGLES: Record<string, string> = {
  excludeSto: 'NOT is_sto',
  excludeDeleted: 'NOT is_deleted',
  onlyOpen: `status IN ('Unapproved PR','PR Approved-No PO','PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered')`,
  onlyWithReceipt: 'receipt_date IS NOT NULL',
};

export interface CustomKpiSpec {
  title: string;
  grain: CustomGrain;
  agg: string;                 // key of AGGS
  measure: string | null;      // key of MEASURE_COLUMNS[grain]; null for count
  filters?: Record<string, string[]>;   // dimension key -> allowed values
  toggles?: string[];          // keys of TOGGLES
}

export interface CustomChartSpec extends CustomKpiSpec {
  dimension: string;           // key of DIMENSION_COLUMNS[grain]
  topN?: number;
}

/** The vocabulary, served to the builder UI so it never guesses. */
export function customVocabulary(): Record<string, unknown> {
  return {
    grains: Object.keys(TABLES),
    aggs: Object.keys(AGGS),
    measures: Object.fromEntries(
      (Object.keys(MEASURE_COLUMNS) as CustomGrain[]).map((g) => [g, Object.keys(MEASURE_COLUMNS[g])]),
    ),
    dimensions: Object.fromEntries(
      (Object.keys(DIMENSION_COLUMNS) as CustomGrain[]).map((g) => [g, Object.keys(DIMENSION_COLUMNS[g])]),
    ),
    toggles: Object.keys(TOGGLES),
  };
}

interface Compiled {
  where: string;
  params: unknown[];
  /** Drill predicate reproducing exactly the aggregated rows. */
  predicate: Record<string, unknown>;
}

function compile(
  spec: CustomKpiSpec,
  versionId: number,
  scope: readonly ScopeEntry[],
): Compiled {
  if (!TABLES[spec.grain]) throw new Error(`unknown grain: ${String(spec.grain)}`);
  if (!AGGS[spec.agg]) throw new Error(`unknown aggregation: ${String(spec.agg)}`);
  if (spec.agg !== 'count') {
    if (!spec.measure || !MEASURE_COLUMNS[spec.grain][spec.measure]) {
      throw new Error(`unknown measure for ${spec.grain}: ${String(spec.measure)}`);
    }
  }

  const params: unknown[] = [versionId];
  const where: string[] = ['f.dataset_version_id = $1'];
  where.push(scopeSql(mintScopedQuery('custom', scope), 'f', params));

  const predFilters: Record<string, unknown> = {};

  for (const [dim, values] of Object.entries(spec.filters ?? {})) {
    const col = DIMENSION_COLUMNS[spec.grain][dim];
    if (!col) throw new Error(`unknown filter dimension: ${dim}`);
    if (!Array.isArray(values) || values.length === 0) continue;
    params.push(values.map(String));
    // `month` is an expression; plain columns get the f. prefix.
    const expr = col.includes('(') ? col.replace(/\b(requisition_date|document_date)\b/g, 'f.$1') : `f.${col}`;
    where.push(`${expr} = ANY($${params.length})`);
    predFilters[`custom:${dim}`] = values;
  }

  for (const t of spec.toggles ?? []) {
    const clause = TOGGLES[t];
    if (!clause) throw new Error(`unknown toggle: ${t}`);
    where.push(`(${clause.replace(/\b(is_sto|is_deleted|status|receipt_date)\b/g, 'f.$1')})`);
    predFilters[`custom:${t}`] = true;
  }

  return {
    where: where.join(' AND '),
    params,
    predicate: { grain: spec.grain, filters: predFilters },
  };
}

/**
 * Custom-spec drill filters are compiled here rather than in drill.ts, so the
 * static whitelist there stays closed. The drill endpoint recognises the
 * `custom:` prefix and delegates.
 */
export function compileCustomFilter(
  key: string,
  value: unknown,
  alias: string,
  params: unknown[],
  grain: string,
): string {
  const g = grain as CustomGrain;
  const name = key.slice('custom:'.length);

  const toggle = TOGGLES[name];
  if (toggle) {
    return `(${toggle.replace(/\b(is_sto|is_deleted|status|receipt_date)\b/g, `${alias}.$1`)})`;
  }
  const col = DIMENSION_COLUMNS[g]?.[name];
  if (!col) throw new Error(`unknown custom drill filter: ${name}`);
  params.push((value as unknown[]).map(String));
  const expr = col.includes('(')
    ? col.replace(/\b(requisition_date|document_date)\b/g, `${alias}.$1`)
    : `${alias}.${col}`;
  return `${expr} = ANY($${params.length})`;
}

export async function computeCustomKpi(
  spec: CustomKpiSpec,
  versionId: number,
  scope: readonly ScopeEntry[],
): Promise<{ value: number | null; sampleSize: number; predicate: Record<string, unknown> }> {
  const c = compile(spec, versionId, scope);
  const measureCol =
    spec.agg === 'count' ? '' : MEASURE_COLUMNS[spec.grain][spec.measure!]!.replace(
      /\b(total_value_idr|total_value_usd|qty_requested|aging_days|release_final_date|requisition_date|net_order_value|net_order_value_usd|order_qty|unit_price|sourcing_days|po_approval_days|delivery_days|still_deliver_val_usd|still_invoice_val_usd)\b/g,
      'f.$1',
    );
  const aggSql = AGGS[spec.agg]!(measureCol);

  const r = await pool.query<{ value: number | null; n: number }>(
    `SELECT ${aggSql} AS value, count(*)::int AS n FROM ${TABLES[spec.grain]} f WHERE ${c.where}`,
    c.params,
  );
  const row = r.rows[0] ?? { value: null, n: 0 };
  return {
    value: row.value === null || row.value === undefined ? null : Number(row.value),
    sampleSize: row.n,
    predicate: c.predicate,
  };
}

export async function computeCustomChart(
  spec: CustomChartSpec,
  versionId: number,
  scope: readonly ScopeEntry[],
): Promise<{
  points: { bucket: string; value: number | null; rowCount: number; predicate: Record<string, unknown> }[];
}> {
  const dimCol = DIMENSION_COLUMNS[spec.grain][spec.dimension];
  if (!dimCol) throw new Error(`unknown dimension: ${String(spec.dimension)}`);
  const c = compile(spec, versionId, scope);

  const measureCol =
    spec.agg === 'count' ? '' : MEASURE_COLUMNS[spec.grain][spec.measure!]!.replace(
      /\b(total_value_idr|total_value_usd|qty_requested|aging_days|release_final_date|requisition_date|net_order_value|net_order_value_usd|order_qty|unit_price|sourcing_days|po_approval_days|delivery_days|still_deliver_val_usd|still_invoice_val_usd)\b/g,
      'f.$1',
    );
  const aggSql = AGGS[spec.agg]!(measureCol);
  const dimExpr = dimCol.includes('(')
    ? dimCol.replace(/\b(requisition_date|document_date)\b/g, 'f.$1')
    : `f.${dimCol}`;

  const topN = Math.min(Math.max(spec.topN ?? 15, 1), 40);
  c.params.push(topN);

  const r = await pool.query<{ bucket: string | null; value: number | null; n: number }>(
    `SELECT ${dimExpr} AS bucket, ${aggSql} AS value, count(*)::int AS n
       FROM ${TABLES[spec.grain]} f WHERE ${c.where}
      GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT $${c.params.length}`,
    c.params,
  );

  return {
    points: r.rows.map((x) => ({
      bucket: x.bucket ?? '(none)',
      value: x.value === null ? null : Number(x.value),
      rowCount: x.n,
      // Each bucket's drill narrows the base predicate by its own dimension value.
      predicate: {
        grain: spec.grain,
        filters: {
          ...(c.predicate['filters'] as Record<string, unknown>),
          [`custom:${spec.dimension}`]: [x.bucket ?? '(none)'],
        },
      },
    })),
  };
}

/** Validation for saved specs — everything checked against the whitelists. */
export function validateSpec(raw: unknown, withDimension: boolean): CustomKpiSpec | CustomChartSpec {
  const s = raw as Partial<CustomChartSpec>;
  if (!s || typeof s !== 'object') throw new Error('spec must be an object');
  if (typeof s.title !== 'string' || s.title.trim() === '' || s.title.length > 80) {
    throw new Error('title is required (max 80 chars)');
  }
  if (s.grain !== 'pr_item' && s.grain !== 'po_line') throw new Error('grain must be pr_item or po_line');
  if (typeof s.agg !== 'string' || !AGGS[s.agg]) throw new Error('unknown aggregation');
  if (s.agg !== 'count' && (typeof s.measure !== 'string' || !MEASURE_COLUMNS[s.grain][s.measure])) {
    throw new Error('unknown measure');
  }
  if (withDimension && (typeof s.dimension !== 'string' || !DIMENSION_COLUMNS[s.grain][s.dimension])) {
    throw new Error('unknown dimension');
  }
  for (const t of s.toggles ?? []) if (!TOGGLES[t]) throw new Error(`unknown toggle: ${t}`);
  for (const d of Object.keys(s.filters ?? {})) {
    if (!DIMENSION_COLUMNS[s.grain][d]) throw new Error(`unknown filter dimension: ${d}`);
  }
  return s as CustomKpiSpec;
}
