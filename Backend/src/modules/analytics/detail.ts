/**
 * Detail table — v1's pg-dt, all 41 columns.
 *
 * Server-side filter, sort, search and paging. v1 held the whole row model in
 * browser memory and re-sorted ~21,000 rows on every interaction; here the work
 * happens in SQL against a partitioned view, so cost is independent of client.
 *
 * Two differences from v1, both deliberate:
 *  - the 9,385 direct and dangling PO lines are included (v1's PR-centric grain
 *    excluded them entirely)
 *  - a null renders as an em dash, never 0
 */

import { query, queryOne } from '../../db/client.js';
import { mintScopedQuery, scopeSql, type ScopeEntry } from '../authz/scope.js';

export interface DetailColumn {
  key: string;
  label: string;
  /** Column expression in core.v_detail. */
  sql: string;
  type: 'string' | 'int' | 'number' | 'money' | 'date' | 'enum' | 'pct';
  currency?: string;
  /** Shown by default; the rest are available in the column chooser. */
  default: boolean;
  sortable: boolean;
}

/**
 * The 41 columns of v1's detail table, in v1's order, plus the value/currency
 * columns v2 can supply because it converts server-side.
 */
export const DETAIL_COLUMNS: DetailColumn[] = [
  { key: 'prNo',            label: 'PR No',                  sql: 'pr_no',               type: 'string', default: true,  sortable: true },
  { key: 'prItem',          label: 'Item',                   sql: 'pr_item',             type: 'int',    default: true,  sortable: true },
  { key: 'descr',           label: 'Desc',                   sql: 'descr',               type: 'string', default: true,  sortable: true },
  { key: 'company',         label: 'Company',                sql: 'company',             type: 'string', default: false, sortable: true },
  { key: 'companyFull',     label: 'Company Description',    sql: 'company_full',        type: 'string', default: false, sortable: true },
  { key: 'plant',           label: 'Plant',                  sql: 'plant',               type: 'string', default: true,  sortable: true },
  { key: 'plantName',       label: 'Plant Name',             sql: 'plant_name',          type: 'string', default: false, sortable: true },
  { key: 'prQty',           label: 'PR Qty',                 sql: 'pr_qty',              type: 'number', default: true,  sortable: true },
  { key: 'uom',             label: 'UoM',                    sql: 'uom',                 type: 'string', default: false, sortable: true },
  { key: 'grQtyTotal',      label: 'Total GR Qty',           sql: 'gr_qty_total',        type: 'number', default: false, sortable: true },
  { key: 'grPrPct',         label: 'GR/PR %',                sql: 'gr_pr_pct',           type: 'pct',    default: false, sortable: true },
  { key: 'matGroup',        label: 'Mat Grp',                sql: 'mat_group',           type: 'string', default: false, sortable: true },
  { key: 'matCat',          label: 'Category',               sql: 'mat_cat',             type: 'enum',   default: true,  sortable: true },
  { key: 'pCat',            label: 'Priority',               sql: 'p_cat',               type: 'enum',   default: false, sortable: true },
  { key: 'status',          label: 'Status',                 sql: 'status',              type: 'enum',   default: true,  sortable: true },
  { key: 'prNextApprover',  label: 'PR Next Approver',       sql: 'pr_next_approver',    type: 'string', default: false, sortable: true },
  { key: 'reqDate',         label: 'PR Date',                sql: 'req_date',            type: 'date',   default: true,  sortable: true },
  { key: 'prL1',            label: 'PR Approval 1',          sql: 'pr_l1',               type: 'date',   default: false, sortable: true },
  { key: 'prL2',            label: 'PR Approval 2',          sql: 'pr_l2',               type: 'date',   default: false, sortable: true },
  { key: 'praDays',         label: 'PRA(d)',                 sql: 'pra_days',            type: 'int',    default: false, sortable: true },
  { key: 'unrelDays',       label: 'Unrel(d)',               sql: 'unrel_days',          type: 'int',    default: false, sortable: true },
  { key: 'sourcingAgingDays', label: 'Sourcing Aging(d)',    sql: 'sourcing_aging_days', type: 'int',    default: false, sortable: true },
  { key: 'poNo',            label: 'PO No',                  sql: 'po_no',               type: 'string', default: true,  sortable: true },
  { key: 'poItem',          label: 'PO Item',                sql: 'po_item',             type: 'int',    default: false, sortable: true },
  { key: 'poSplit',         label: 'PO Split',               sql: 'po_split',            type: 'string', default: false, sortable: false },
  { key: 'poMatDesc',       label: 'PO Mat Desc',            sql: 'po_mat_desc',         type: 'string', default: false, sortable: true },
  { key: 'poQty',           label: 'PO Qty',                 sql: 'po_qty',              type: 'number', default: false, sortable: true },
  { key: 'poUom',           label: 'PO UoM',                 sql: 'po_uom',              type: 'string', default: false, sortable: true },
  { key: 'orderPriceUnit',  label: 'Order Price Unit',       sql: 'order_price_unit',    type: 'string', default: false, sortable: true },
  { key: 'priceUnit',       label: 'Price Unit',             sql: 'price_unit',          type: 'int',    default: false, sortable: true },
  { key: 'poDate',          label: 'PO Date',                sql: 'po_date',             type: 'date',   default: true,  sortable: true },
  { key: 'poFull',          label: 'PO Final Approved Date', sql: 'po_full',             type: 'date',   default: false, sortable: true },
  { key: 'vendorCode',      label: 'Vendor Code',            sql: 'vendor_code',         type: 'string', default: false, sortable: true },
  { key: 'supplier',        label: 'Vendor Name',            sql: 'supplier',            type: 'string', default: true,  sortable: true },
  { key: 'poNextApprover',  label: 'PO Next Approver',       sql: 'po_next_approver',    type: 'string', default: false, sortable: true },
  { key: 'poaDays',         label: 'POA(d)',                 sql: 'poa_days',            type: 'int',    default: false, sortable: true },
  { key: 'grDate',          label: 'GR Date',                sql: 'gr_date',             type: 'date',   default: true,  sortable: true },
  { key: 'delivDays',       label: 'Deliv(d)',               sql: 'deliv_days',          type: 'int',    default: false, sortable: true },
  { key: 'srcDays',         label: 'Src(d)',                 sql: 'src_days',            type: 'int',    default: false, sortable: true },
  { key: 'delvsgrDays',     label: 'DelvsGR(d)',             sql: 'delvsgr_days',        type: 'int',    default: false, sortable: true },
  { key: 'e2eDays',         label: 'E2E(d)',                 sql: 'e2e_days',            type: 'int',    default: false, sortable: true },
  { key: 'wbs',             label: 'WBS',                    sql: 'wbs',                 type: 'string', default: false, sortable: true },
  // v2 additions: it converts server-side, so the value columns can be shown.
  { key: 'currencyCode',    label: 'Ccy',                    sql: 'currency_code',       type: 'string', default: false, sortable: true },
  { key: 'netOrderValue',   label: 'PO Value',               sql: 'net_order_value',     type: 'money',  default: false, sortable: true },
  { key: 'netOrderValueUsd',label: 'PO Value USD',           sql: 'net_order_value_usd', type: 'money',  currency: 'USD', default: false, sortable: true },
  { key: 'prValueIdr',      label: 'PR Value IDR',           sql: 'pr_value_idr',        type: 'money',  currency: 'IDR', default: false, sortable: true },
  { key: 'purchOrg',        label: 'Purch Org',              sql: 'purch_org',           type: 'string', default: false, sortable: true },
  { key: 'purchGroup',      label: 'Purch Grp',              sql: 'purch_group',         type: 'string', default: false, sortable: true },
  { key: 'requisitioner',   label: 'Requisitioner',          sql: 'requisitioner',       type: 'string', default: false, sortable: true },
];

const COLUMN_BY_KEY = new Map(DETAIL_COLUMNS.map((c) => [c.key, c]));

/** Free-text search hits these columns only, so the index stays predictable. */
const SEARCH_COLUMNS = ['pr_no', 'po_no', 'descr', 'po_mat_desc', 'supplier', 'vendor_code', 'plant', 'wbs'];

export interface DetailFilters {
  status?: string[];
  matCat?: string[];
  matGroup?: string[];
  plant?: string[];
  company?: string[];
  purchOrg?: string[];
  purchGroup?: string[];
  priority?: string[];
  monthKey?: string[];
  search?: string;
  excludeSto?: boolean;
  includeDeleted?: boolean;
  onlyOpen?: boolean;
  onlyDirectPo?: boolean;
  onlyReleaseExempt?: boolean;
}

export interface DetailPage {
  datasetVersionId: number;
  asOfDate: string;
  totalCount: number;
  columns: Array<Omit<DetailColumn, 'sql'>>;
  rows: Record<string, unknown>[];
  appliedFilters: Record<string, unknown>;
  nextCursor: string | null;
  facets: Record<string, Array<{ value: string; count: number }>>;
}

export async function queryDetail(
  versionId: number,
  asOfDate: string,
  scope: readonly ScopeEntry[],
  filters: DetailFilters,
  sort: { key: string; dir: 'asc' | 'desc' } | null,
  limit: number,
  offset: number,
  includeFacets: boolean,
): Promise<DetailPage> {
  const params: unknown[] = [versionId];
  const where: string[] = ['d.dataset_version_id = $1'];

  // Scope is composed in the data layer; an empty scope yields no rows.
  where.push(scopeSql(mintScopedQuery('detail', scope), 'd', params));

  const inList = (col: string, vals: string[] | undefined) => {
    if (!vals || vals.length === 0) return;
    params.push(vals);
    where.push(`d.${col} = ANY($${params.length})`);
  };

  inList('status', filters.status);
  inList('mat_cat', filters.matCat);
  inList('mat_group', filters.matGroup);
  inList('plant', filters.plant);
  inList('company', filters.company);
  inList('purch_org', filters.purchOrg);
  inList('purch_group', filters.purchGroup);
  inList('p_cat', filters.priority);

  if (filters.monthKey && filters.monthKey.length > 0) {
    params.push(filters.monthKey);
    where.push(`to_char(COALESCE(d.po_date, d.req_date), 'YYYY-MM') = ANY($${params.length})`);
  }

  if (filters.excludeSto) where.push('NOT d.is_sto');
  if (!filters.includeDeleted) where.push('NOT d.pr_deleted');
  if (filters.onlyOpen) {
    where.push(`d.status IN ('Unapproved PR','PR Approved-No PO','PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered')`);
  }
  if (filters.onlyDirectPo) where.push('d.is_direct_po');
  if (filters.onlyReleaseExempt) where.push('d.release_exempt');

  const search = (filters.search ?? '').trim();
  if (search !== '') {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    where.push(`(${SEARCH_COLUMNS.map((c) => `d.${c} ILIKE ${p}`).join(' OR ')})`);
  }

  const whereSql = where.join(' AND ');

  const countRow = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM core.v_detail d WHERE ${whereSql}`,
    params,
  );
  const total = countRow?.n ?? 0;

  // Sort column is looked up in the whitelist, never interpolated from input.
  const sortCol = sort ? COLUMN_BY_KEY.get(sort.key) : undefined;
  const orderBy =
    sortCol && sortCol.sortable
      ? `d.${sortCol.sql} ${sort!.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, d.pr_no, d.pr_item, d.po_no, d.po_item`
      : 'd.pr_no NULLS LAST, d.pr_item, d.po_no, d.po_item';

  const select = DETAIL_COLUMNS.map((c) => `d.${c.sql} AS "${c.key}"`).join(', ');
  const pageParams = [...params, limit, offset];

  const rows = await query<Record<string, unknown>>(
    `SELECT ${select},
            d.is_sto AS "_sto", d.release_exempt AS "_exempt", d.is_token_price AS "_token",
            d.link_status AS "_link", d.is_direct_po AS "_direct", d.wbs_status AS "_wbs",
            d.is_retro_po AS "_retro"
       FROM core.v_detail d
      WHERE ${whereSql}
      ORDER BY ${orderBy}
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );

  const decorated = rows.map((r) => {
    const flags: string[] = [];
    if (r['_sto']) flags.push('sto');
    if (r['_token']) flags.push('tokenPrice');
    if (r['_exempt']) flags.push('releaseExempt');
    if (r['_link'] === 'dangling') flags.push('danglingLink');
    if (r['_direct']) flags.push('directPo');
    if (r['_retro']) flags.push('retroPo');
    if (r['_wbs'] === 'violation') flags.push('wbsViolation');
    for (const k of ['_sto', '_exempt', '_token', '_link', '_direct', '_wbs', '_retro']) delete r[k];
    return { ...r, flags };
  });

  // Facets power the filter dropdowns and are computed from the SAME predicate
  // minus the facet's own column, so counts reflect the other active filters.
  const facets: DetailPage['facets'] = {};
  if (includeFacets) {
    for (const [name, col] of [
      ['status', 'status'],
      ['matCat', 'mat_cat'],
      ['matGroup', 'mat_group'],
      ['plant', 'plant'],
      ['company', 'company'],
      ['purchOrg', 'purch_org'],
      ['purchGroup', 'purch_group'],
      ['priority', 'p_cat'],
    ] as const) {
      const f = await query<{ value: string | null; n: number }>(
        `SELECT d.${col} AS value, count(*)::int AS n
           FROM core.v_detail d WHERE ${whereSql}
          GROUP BY 1 ORDER BY 2 DESC LIMIT 60`,
        params,
      );
      facets[name] = f
        .filter((x) => x.value !== null)
        .map((x) => ({ value: x.value as string, count: x.n }));
    }
  }

  return {
    datasetVersionId: versionId,
    asOfDate,
    totalCount: total,
    columns: DETAIL_COLUMNS.map(({ sql: _sql, ...rest }) => rest),
    rows: decorated,
    appliedFilters: {
      ...filters,
      excludeSto: filters.excludeSto ?? false,
      includeDeleted: filters.includeDeleted ?? false,
    },
    nextCursor: offset + rows.length < total ? String(offset + rows.length) : null,
    facets,
  };
}
