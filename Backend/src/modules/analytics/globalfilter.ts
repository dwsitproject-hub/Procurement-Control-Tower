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
  /** v1's per-page "Show: All | Open Only | Complete (GR)" toggle (G2.2). */
  scope?: 'open' | 'complete';

  // ── Executive Summary dimensions (022) ──
  //
  // These exist so a figure on that page can be opened into the Overview
  // structure with the SAME slice applied — clicking METHANOL shows the whole
  // Overview filtered to METHANOL rather than a bare line list.

  /** core.fact_po_line.spend_category (020). */
  spendCategory?: string[];
  /** core.fact_po_line.size_band ordinal key, '1'..'7' (020). */
  sizeBand?: string[];
  /**
   * The Executive Summary's Open/Closed split: true = status 'Delivered'
   * (Closed), false = everything else (Open).
   *
   * DELIBERATELY NOT `scope`. That toggle's 'open' means OPEN_STATUSES, which
   * omits 'Fully Reversed' — so scope='open' and "not Delivered" disagree by 17
   * lines in the current data. Small, but the two would then be two different
   * definitions of the same word on one screen, and a chart series and the drill
   * behind it would not tie out. One extra field is cheaper than that.
   */
  delivered?: boolean;
}

/** The status set v1 (and the drill `open` filter) treat as open. */
export const OPEN_STATUSES = [
  'Unapproved PR', 'PR Approved-No PO', 'PO-Not Approved', 'HOLD PO', 'PO-No GR', 'Partially Delivered',
];

export function isEmptyFilter(f: GlobalFilter): boolean {
  return (
    (f.companyCode?.length ?? 0) === 0 &&
    (f.plant?.length ?? 0) === 0 &&
    (f.purchOrg?.length ?? 0) === 0 &&
    (f.monthKey?.length ?? 0) === 0 &&
    (f.spendCategory?.length ?? 0) === 0 &&
    (f.sizeBand?.length ?? 0) === 0 &&
    f.delivered === undefined &&
    f.scope === undefined
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

  /**
   * The Executive Summary dimensions live on the PO line. On the PR grain they
   * are resolved through the linked PO lines — the same device `scope` already
   * uses below, and for the same reason: a requisition has no spend category or
   * order value of its own, but "requisitions that became METHANOL orders" is a
   * meaningful and answerable question.
   *
   * On the GR grain they throw, so the caller reports the figure as unfilterable
   * rather than quietly returning an unfiltered number.
   */
  const poScoped = (predicate: (t: string) => string) => {
    if (kind === 'gr_posting') {
      throw new Error('Executive Summary filters do not apply to GR postings');
    }
    if (kind === 'pr_item') {
      const outer = alias !== '' ? alias : 'core.fact_pr_item.';
      parts.push(
        `EXISTS (SELECT 1 FROM core.fact_po_line _xs
                  WHERE _xs.dataset_version_id = ${outer}dataset_version_id
                    AND _xs.pr_no = ${outer}pr_no AND _xs.pr_item = ${outer}pr_item
                    AND ${predicate('_xs.')})`,
      );
    } else {
      parts.push(predicate(alias));
    }
  };

  if (f.spendCategory && f.spendCategory.length > 0) {
    params.push(f.spendCategory);
    const i = n;
    poScoped((t) => `${t}spend_category = ANY($${i})`);
    n += 1;
  }

  if (f.sizeBand && f.sizeBand.length > 0) {
    params.push(f.sizeBand);
    const i = n;
    poScoped((t) => `${t}size_band = ANY($${i})`);
    n += 1;
  }

  if (f.delivered !== undefined) {
    // Written as an explicit comparison rather than parameterised: the value is a
    // boolean the parser already validated, so there is nothing user-supplied to
    // bind, and the SQL reads as the rule it implements.
    const op = f.delivered ? '=' : '<>';
    poScoped((t) => `${t}status ${op} 'Delivered'`);
  }

  if (f.scope !== undefined) {
    // GR postings carry no lifecycle status; a spec on that grain cannot be
    // scoped honestly — the caller reports it unavailable instead.
    if (kind === 'gr_posting') {
      throw new Error('scope filter does not apply to GR postings');
    }
    if (kind === 'pr_item') {
      // A converted PR item's own status stays 'PO-No GR' forever — the PR
      // fact does not track delivery. Open/complete therefore consult the
      // linked PO lines. The outer table must be named explicitly: inside
      // EXISTS an unqualified column would bind to the inner alias.
      const outer = alias !== '' ? alias : 'core.fact_pr_item.';
      if (f.scope === 'open') {
        parts.push(
          `(${outer}status IN ('Unapproved PR','PR Approved-No PO')
            OR EXISTS (SELECT 1 FROM core.fact_po_line _pl
                        WHERE _pl.dataset_version_id = ${outer}dataset_version_id
                          AND _pl.pr_no = ${outer}pr_no AND _pl.pr_item = ${outer}pr_item
                          AND _pl.status IN ('PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered')))`,
        );
      } else {
        parts.push(
          `EXISTS (SELECT 1 FROM core.fact_po_line _pl
                    WHERE _pl.dataset_version_id = ${outer}dataset_version_id
                      AND _pl.pr_no = ${outer}pr_no AND _pl.pr_item = ${outer}pr_item
                      AND _pl.status = 'Delivered')`,
        );
      }
    } else if (f.scope === 'open') {
      params.push(OPEN_STATUSES);
      parts.push(`${alias}status = ANY($${n})`);
      n += 1;
    } else {
      params.push('Delivered');
      parts.push(`${alias}status = $${n}`);
      n += 1;
    }
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
  // A spec whose FIRST anchor is not its driving table (e.g. a scalar subquery
  // in the SELECT list) marks the true injection point with /*F*/ — otherwise
  // the filter would silently land on the wrong table.
  const mark = sql.indexOf('/*F*/');
  if (mark >= 0) return sql.slice(0, mark) + clause.sql + sql.slice(mark);
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
  if (f.scope === 'open') {
    filters['scopeOpen'] = true;
  } else if (f.scope === 'complete') {
    filters['scopeComplete'] = true;
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
  const rawScope = q['scope'] === undefined ? undefined : String(q['scope']);
  // 'open' | 'closed' on the wire, because that is what the page calls them.
  const rawLifecycle = q['lifecycle'] === undefined ? undefined : String(q['lifecycle']);
  return {
    companyCode: list('company'),
    plant: list('plant'),
    purchOrg: list('purchOrg'),
    monthKey: list('monthKey'),
    scope: rawScope === 'open' || rawScope === 'complete' ? rawScope : undefined,
    spendCategory: list('spendCategory'),
    sizeBand: list('sizeBand'),
    delivered: rawLifecycle === 'closed' ? true : rawLifecycle === 'open' ? false : undefined,
  };
}

/** Echoed back on every response so the client can never guess what was applied. */
export function describeFilter(f: GlobalFilter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.companyCode?.length) out['company'] = f.companyCode;
  if (f.plant?.length) out['plant'] = f.plant;
  if (f.purchOrg?.length) out['purchOrg'] = f.purchOrg;
  if (f.monthKey?.length) out['monthKey'] = f.monthKey;
  if (f.scope) out['scope'] = f.scope;
  if (f.spendCategory?.length) out['spendCategory'] = f.spendCategory;
  if (f.sizeBand?.length) out['sizeBand'] = f.sizeBand;
  if (f.delivered !== undefined) out['lifecycle'] = f.delivered ? 'closed' : 'open';
  return out;
}
