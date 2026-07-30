/**
 * Global filters — v1's gms('co') / gms('mo') / gms('pl') controls.
 *
 * The mart precomputes the unfiltered slice at ('*','*','*'). Precomputing every
 * combination is not viable — 24 plants x 7 months x 53 KPIs x 34 charts explodes
 * — so a filtered request recomputes live from the facts using the SAME spec SQL
 * that produced the precomputed value.
 *
 * That reuse is the point: one definition serves both paths, so a filtered figure
 * and an unfiltered one can never be computed by two different pieces of SQL.
 */

export interface GlobalFilter {
  companyCode?: string[];
  plant?: string[];
  purchOrg?: string[];
  /** 'YYYY-MM' against the grain's primary date. */
  monthKey?: string[];
}

export function isEmptyFilter(f: GlobalFilter): boolean {
  return (
    (f.companyCode?.length ?? 0) === 0 &&
    (f.plant?.length ?? 0) === 0 &&
    (f.purchOrg?.length ?? 0) === 0 &&
    (f.monthKey?.length ?? 0) === 0
  );
}

/** The date column a month filter applies to, per fact table. */
export type FactKind = 'pr_item' | 'po_line' | 'gr_posting';

const MONTH_COL: Record<FactKind, string> = {
  pr_item: 'requisition_date',
  po_line: 'document_date',
  gr_posting: 'posting_date',
};

export interface Clause {
  /** Begins with ' AND ' when non-empty, so it can be appended directly. */
  sql: string;
  params: unknown[];
}

/**
 * Build the extra WHERE fragment.
 *
 * `alias` must end with a dot ('pol.') for specs that join two fact tables, and be
 * empty for single-table specs. An unqualified column in a joined query is an
 * ambiguous-column error, so this is explicit rather than inferred.
 *
 * `startIndex` is the next free positional parameter — the spec SQL already uses
 * $1 for the dataset version.
 */
export function buildFilterClause(
  f: GlobalFilter,
  kind: FactKind,
  alias: string,
  startIndex: number,
): Clause {
  const parts: string[] = [];
  const params: unknown[] = [];
  let n = startIndex;

  const add = (col: string, vals: string[] | undefined) => {
    if (!vals || vals.length === 0) return;
    params.push(vals);
    parts.push(`${alias}${col} = ANY($${n})`);
    n += 1;
  };

  add('company_code', f.companyCode);
  add('plant', f.plant);
  add('purch_org', f.purchOrg);

  if (f.monthKey && f.monthKey.length > 0) {
    params.push(f.monthKey);
    parts.push(`to_char(${alias}${MONTH_COL[kind]}, 'YYYY-MM') = ANY($${n})`);
    n += 1;
  }

  return { sql: parts.length === 0 ? '' : ` AND ${parts.join(' AND ')}`, params };
}

/**
 * Inject the clause into a spec's SQL.
 *
 * Every spec anchors on `dataset_version_id = $1`. Only the FIRST occurrence is
 * patched: in a joined spec the second table is correlated to the first on that
 * column, so filtering the driving table is sufficient and correct.
 */
export function injectFilter(sql: string, clause: Clause): string {
  if (clause.sql === '') return sql;
  const anchor = 'dataset_version_id = $1';
  const at = sql.indexOf(anchor);
  if (at < 0) {
    throw new Error('spec SQL has no dataset_version_id = $1 anchor to filter on');
  }
  return sql.slice(0, at + anchor.length) + clause.sql + sql.slice(at + anchor.length);
}

/**
 * Merge the global filters into a drill predicate so a drill opened from a
 * filtered figure returns the filtered rows. Without this the card would show
 * one number and its drill another — the exact class of defect the predicate
 * design exists to prevent.
 */
export function mergeIntoPredicate(
  predicate: Record<string, unknown> | null,
  f: GlobalFilter,
): Record<string, unknown> | null {
  if (predicate === null || isEmptyFilter(f)) return predicate;

  const filters = { ...((predicate['filters'] as Record<string, unknown>) ?? {}) };

  // Single values use the scalar compiler; multiples use the ANY() form.
  if (f.companyCode?.length) {
    filters['companyCodeIn'] = f.companyCode;
  }
  if (f.plant?.length) {
    filters['plantIn'] = f.plant;
  }
  if (f.purchOrg?.length) {
    filters['purchOrgIn'] = f.purchOrg;
  }
  if (f.monthKey?.length) {
    filters['monthKeyIn'] = f.monthKey;
  }

  return { ...predicate, filters };
}

/** Parse global filters off a query string, rejecting nothing silently. */
export function parseGlobalFilter(q: Record<string, unknown>): GlobalFilter {
  const list = (name: string): string[] | undefined => {
    const raw = q[name];
    if (raw === undefined) return undefined;
    const arr = Array.isArray(raw) ? raw.map(String) : String(raw).split(',');
    const cleaned = arr.map((x) => x.trim()).filter((x) => x !== '');
    return cleaned.length > 0 ? cleaned : undefined;
  };
  return {
    companyCode: list('company'),
    plant: list('plant'),
    purchOrg: list('purchOrg'),
    monthKey: list('monthKey'),
  };
}

/** Echoed back on every response so the client can never guess what was applied. */
export function describeFilter(f: GlobalFilter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.companyCode?.length) out['company'] = f.companyCode;
  if (f.plant?.length) out['plant'] = f.plant;
  if (f.purchOrg?.length) out['purchOrg'] = f.purchOrg;
  if (f.monthKey?.length) out['monthKey'] = f.monthKey;
  return out;
}
