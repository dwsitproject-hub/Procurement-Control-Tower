/**
 * Data scope — TECH 01 §6.3.
 *
 * Scope is applied in the DATA LAYER, not in controllers. `ScopedQuery` is a
 * branded type that only this module can construct, so a repository function
 * requiring it CANNOT be called without a resolved scope. That makes "no query
 * without a scope" a compile-time property rather than a review checklist item.
 */

import { query } from '../../db/client.js';

export interface ScopeEntry {
  companyCode: string;
  plant: string;
  purchOrg: string;
}

declare const brand: unique symbol;

export interface ScopedQuery {
  readonly [brand]: 'ScopedQuery';
  readonly entries: readonly ScopeEntry[];
  readonly userId: string;
}

export function mintScopedQuery(userId: string, entries: readonly ScopeEntry[]): ScopedQuery {
  return { entries, userId } as unknown as ScopedQuery;
}

export async function resolveScope(userId: string): Promise<ScopeEntry[]> {
  const rows = await query<{ company_code: string; plant: string; purch_org: string }>(
    `SELECT company_code, plant, purch_org FROM app.data_scope WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => ({ companyCode: r.company_code, plant: r.plant, purchOrg: r.purch_org }));
}

/**
 * Compose a scope into SQL, appending parameters to `params`.
 *
 * An EMPTY scope yields `false` — a user with no grant sees nothing. That is the
 * default state of every newly provisioned SSO user, and it must fail closed.
 */
/**
 * The columns a scope is written against.
 *
 * The fact tables spell the company `company_code`; core.v_detail spells it
 * `company` and has no `company_code` at all. Both the detail table and Open
 * Items compose their scope over that view, so every narrowed scope produced
 * `column d.company_code does not exist` — a 500 that nobody had seen only
 * because every scope in use is ('*','*','*'), which emits no column reference
 * at all.
 *
 * Passing the names explicitly is the fix. A caller that reads a different
 * relation says so, and a relation whose columns move cannot silently keep
 * compiling against the old ones.
 */
export interface ScopeColumns {
  companyCode: string;
  plant: string;
  purchOrg: string;
}

/** The fact tables' own names, used when a caller passes nothing. */
const FACT_SCOPE_COLUMNS: ScopeColumns = {
  companyCode: 'company_code',
  plant: 'plant',
  purchOrg: 'purch_org',
};

/** core.v_detail's names. */
export const DETAIL_SCOPE_COLUMNS: ScopeColumns = {
  companyCode: 'company',
  plant: 'plant',
  purchOrg: 'purch_org',
};

export function scopeSql(
  sq: ScopedQuery,
  alias: string,
  params: unknown[],
  cols: ScopeColumns = FACT_SCOPE_COLUMNS,
): string {
  if (sq.entries.length === 0) return 'false';

  const clauses: string[] = [];
  for (const e of sq.entries) {
    const parts: string[] = [];
    if (e.companyCode !== '*') {
      params.push(e.companyCode);
      parts.push(`${alias}.${cols.companyCode} = $${params.length}`);
    }
    if (e.plant !== '*') {
      params.push(e.plant);
      parts.push(`${alias}.${cols.plant} = $${params.length}`);
    }
    if (e.purchOrg !== '*') {
      params.push(e.purchOrg);
      parts.push(`${alias}.${cols.purchOrg} = $${params.length}`);
    }
    clauses.push(parts.length > 0 ? `(${parts.join(' AND ')})` : 'true');
  }
  return `(${clauses.join(' OR ')})`;
}

/**
 * Intersect two scopes — used when opening a drill token so a token issued
 * before a scope was narrowed cannot outlive the revocation, and can never widen
 * access.
 */
export function intersectScopes(
  a: readonly ScopeEntry[],
  b: readonly ScopeEntry[],
): ScopeEntry[] {
  const out: ScopeEntry[] = [];
  for (const x of a) {
    for (const y of b) {
      const companyCode = narrow(x.companyCode, y.companyCode);
      const plant = narrow(x.plant, y.plant);
      const purchOrg = narrow(x.purchOrg, y.purchOrg);
      if (companyCode === null || plant === null || purchOrg === null) continue;
      out.push({ companyCode, plant, purchOrg });
    }
  }
  // Deduplicate
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = `${e.companyCode}|${e.plant}|${e.purchOrg}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function narrow(a: string, b: string): string | null {
  if (a === '*') return b;
  if (b === '*') return a;
  return a === b ? a : null;
}

export function scopeIsUnrestricted(entries: readonly ScopeEntry[]): boolean {
  return entries.some((e) => e.companyCode === '*' && e.plant === '*' && e.purchOrg === '*');
}
