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

import { AGE_BANDS as SHARED_AGE_BANDS, ageBandPredicateSql } from '@pct/rules';
import { query, queryOne } from '../../db/client.js';
import {
  DETAIL_SCOPE_COLUMNS, mintScopedQuery, scopeSql, type ScopeEntry,
} from '../authz/scope.js';

export interface DetailColumn {
  key: string;
  label: string;
  /**
   * Column of core.v_detail - or, for a Coupa column, an expression over the
   * `cp` lateral below (COUPA_JOIN).
   */
  sql: string;
  /** Read from Coupa's live store through COUPA_JOIN, not from the view. */
  coupa?: boolean;
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
  { key: 'matCat',          label: 'Category (legacy)',      sql: 'mat_cat',             type: 'enum',   default: false, sortable: true },
  // 030. The Executive Summary's category, resolved from the Material Master.
  // It replaces mat_cat as the default column: the two are different
  // dimensions with near-identical names, and a page showing one beside a page
  // grouping by the other is how two numbers that should match stop matching.
  // mat_cat stays available, renamed so nobody picks it by accident.
  { key: 'spendCategory',   label: 'Spend Category',         sql: 'spend_category',      type: 'enum',   default: true,  sortable: true },
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
  // 029. The order's value in rupiah, converted by the TRANSFORM at the
  // document's own period rate - not multiplied here and not in the browser,
  // so this column and every IDR figure on a KPI card apply the same rate.
  // Null where the line has no order yet, and null where the currency could not
  // be resolved: an unconverted value is left empty rather than shown raw, which
  // would read as rupiah.
  { key: 'poValueIdr',      label: 'PO Value IDR',           sql: 'po_value_idr',        type: 'money',  currency: 'IDR', default: false, sortable: true },
  { key: 'prValueIdr',      label: 'PR Value IDR',           sql: 'pr_value_idr',        type: 'money',  currency: 'IDR', default: false, sortable: true },
  { key: 'purchOrg',        label: 'Purch Org',              sql: 'purch_org',           type: 'string', default: false, sortable: true },
  { key: 'purchGroup',      label: 'Purch Grp',              sql: 'purch_group',         type: 'string', default: false, sortable: true },
  { key: 'requisitioner',   label: 'Requisitioner',          sql: 'requisitioner',       type: 'string', default: false, sortable: true },
  // 028. The age of the row in the stage it is in — a PR still waiting ages on
  // the requisition, one that reached an order ages on the order. Added so the
  // Open Items stage cards' age figures can filter this table.
  { key: 'ageDays',         label: 'Age (d)',                sql: 'age_days',            type: 'int',    default: false, sortable: true },
  // Coupa, beside SAP (requested 6 Oct 2026), so a reader can see both systems
  // describe the same purchase. Read live from the Coupa store - which syncs
  // every few minutes and is not versioned - through COUPA_JOIN.
  { key: 'coupaMatch',      label: 'Coupa match',            sql: "COALESCE(cp.via, 'Not in Coupa')", coupa: true, type: 'string', default: false, sortable: true },
  { key: 'coupaReqNo',      label: 'Coupa Req No',           sql: 'cp.requisition_id',   coupa: true, type: 'string', default: false, sortable: true },
  { key: 'coupaPoNo',       label: 'Coupa PO No',            sql: 'cp.po_number',        coupa: true, type: 'string', default: false, sortable: true },
  { key: 'coupaPoStatus',   label: 'Coupa PO Status',        sql: 'cp.po_status',        coupa: true, type: 'string', default: false, sortable: true },
  // Coupa writes SAP's REJECTION into the SAP PO number field when SAP refuses
  // to create the order ("Purchase order still contains faulty items", "Please
  // entry tax term and regulation"...) - 841 lines on 408 Coupa POs in the
  // local copy of production. The clearest sign the two systems disagree, so
  // it gets a column of its own.
  { key: 'coupaSapError',   label: 'Coupa → SAP error',      sql: 'cp.sap_error',        coupa: true, type: 'string', default: false, sortable: true },
  { key: 'coupaSourcingEvent', label: 'Coupa Sourcing Event', sql: 'cp.event_id',        coupa: true, type: 'string', default: false, sortable: true },
  { key: 'coupaSourcingType',  label: 'Coupa Sourcing Type',  sql: 'cp.event_kind',      coupa: true, type: 'string', default: false, sortable: true },
  { key: 'coupaSourcingState', label: 'Coupa Sourcing State', sql: 'cp.event_state',     coupa: true, type: 'string', default: false, sortable: true },
  { key: 'coupaBids',       label: 'Coupa Bids',             sql: 'cp.bids',             coupa: true, type: 'int',    default: false, sortable: true },
  { key: 'coupaAwarded',    label: 'Coupa Awarded Supplier', sql: 'cp.awarded',          coupa: true, type: 'string', default: false, sortable: true },
  { key: 'coupaInvoiceNo',  label: 'Coupa Invoice No',       sql: 'cp.invoice_nos',      coupa: true, type: 'string', default: false, sortable: true },
  { key: 'coupaInvoiceStatus', label: 'Coupa Invoice Status', sql: 'cp.invoice_status',  coupa: true, type: 'string', default: false, sortable: true },
];

/**
 * One Coupa row per detail row, as a lateral join on the page query only.
 *
 * The chain (036): SAP PO line <- Coupa PO line (its sap-po-no-line-no field);
 * a row with no SAP order yet falls back to the Coupa PO line raised from its
 * SAP requisition item (initial-sap-pr-no-line-no). Never both for one row: a
 * requisition split across orders would otherwise borrow a sibling order's
 * Coupa line. From the Coupa PO line, its Coupa requisition; from the
 * requisition, the newest sourcing event created from it; from the line, its
 * invoices.
 *
 * Kept out of core.v_detail on purpose. The view serves Open Items and the
 * aggregate pages, none of which need Coupa, and the Coupa store moves every
 * few minutes while the view is a published, immutable version - a column that
 * changes under a fixed version would make two reads of one version disagree.
 * Here the reader is looking at a page of rows, which is what the lookup costs.
 */
const COUPA_JOIN = `
  LEFT JOIN LATERAL (
    SELECT cpl.via, cpl.requisition_id, cpl.po_number, cpl.status AS po_status,
           CASE WHEN cpl.sap_po_no !~ '^[0-9]+$'
                THEN btrim(regexp_replace(cpl.sap_po_no, '^null[[:space:]]*', '')) END AS sap_error,
           cse.id AS event_id,
           NULLIF(concat_ws(' / ', cse.event_type, cse.event_category), '') AS event_kind,
           cse.state AS event_state, cse.bids, cse.awarded,
           cin.invoice_nos, cin.invoice_status
      FROM (
        (SELECT x.order_line_id, x.requisition_id, x.po_number, x.status, x.updated_at,
                x.sap_po_no, 'SAP PO line' AS via, 1 AS pri
           FROM ops.coupa_po_line x
          WHERE d.po_no IS NOT NULL AND x.sap_po_no = d.po_no AND x.sap_po_item = d.po_item
          ORDER BY x.updated_at DESC NULLS LAST LIMIT 1)
        UNION ALL
        (SELECT x.order_line_id, x.requisition_id, x.po_number, x.status, x.updated_at,
                x.sap_po_no, 'SAP PR item (no SAP PO yet)', 2
           FROM ops.coupa_po_line x
          WHERE d.po_no IS NULL AND d.pr_no IS NOT NULL
            AND x.sap_pr_no = d.pr_no AND x.sap_pr_item = d.pr_item
          ORDER BY x.updated_at DESC NULLS LAST LIMIT 1)
        ORDER BY pri LIMIT 1
      ) cpl
      LEFT JOIN LATERAL (
        SELECT e.id, e.event_type, e.event_category, e.state,
               (SELECT count(*)::int FROM ops.coupa_supplier_response r
                 WHERE r.quote_request_id = e.id) AS bids,
               (SELECT string_agg(DISTINCT r.supplier_name, ', ') FROM ops.coupa_supplier_response r
                 WHERE r.quote_request_id = e.id AND r.awarded) AS awarded
          FROM ops.coupa_sourcing_event e
         WHERE cpl.requisition_id IS NOT NULL AND e.requisition_id = cpl.requisition_id
         ORDER BY e.updated_at DESC NULLS LAST LIMIT 1
      ) cse ON true
      LEFT JOIN LATERAL (
        SELECT string_agg(DISTINCT i.invoice_number, ', ') AS invoice_nos,
               CASE WHEN count(*) = 0 THEN NULL
                    WHEN bool_and(i.paid) THEN 'Paid' ELSE 'Not paid' END AS invoice_status
          FROM ops.coupa_invoice_line il
          JOIN ops.coupa_invoice i ON i.id = il.invoice_id
         WHERE il.order_line_id = cpl.order_line_id
           AND i.status NOT IN ('voided', 'draft')
      ) cin ON true
  ) cp ON true`;

/** A column's SELECT/ORDER expression: the view's column, or the Coupa lookup's. */
const colExpr = (c: DetailColumn): string => (c.coupa ? c.sql : `d.${c.sql}`);

const COLUMN_BY_KEY = new Map(DETAIL_COLUMNS.map((c) => [c.key, c]));

/** Free-text search hits these columns only, so the index stays predictable. */
const SEARCH_COLUMNS = ['pr_no', 'po_no', 'descr', 'po_mat_desc', 'supplier', 'vendor_code', 'plant', 'wbs'];

export interface DetailFilters {
  status?: string[];
  matCat?: string[];
  spendCategory?: string[];
  matGroup?: string[];
  plant?: string[];
  company?: string[];
  purchOrg?: string[];
  purchGroup?: string[];
  priority?: string[];
  monthKey?: string[];
  /** 'YYYY', on the same date as monthKey. */
  year?: string[];
  search?: string;
  /**
   * One of the four age bands, or 'past-sla' for everything beyond the first.
   *
   * A whitelist, not a number: the values come from a card the reader clicked,
   * and the band boundaries have to be the SAME boundaries the card drew or the
   * table will not return the number that was clicked.
   */
  ageBand?: string;
  /**
   * One of MONEY_STATE_SQL's keys, or undefined.
   *
   * A whitelist rather than free SQL, and one field rather than two booleans:
   * the two states are mutually exclusive steps of the same sequence, and
   * asking for both would return nothing while looking like it should return
   * more.
   */
  moneyState?: string;
  excludeSto?: boolean;
  includeDeleted?: boolean;
  onlyOpen?: boolean;
  onlyDirectPo?: boolean;
  onlyReleaseExempt?: boolean;
}

/**
 * Query parameters this endpoint understands.
 *
 * Exported so the route can reject anything else. A typo must not silently
 * return unfiltered data, and an export that ignored a filter the screen
 * applied would be worse still -- it would look complete.
 */
export const DETAIL_QUERY_PARAMS = [
  'status', 'matCat', 'spendCategory', 'matGroup', 'plant', 'company', 'purchOrg', 'purchGroup',
  'priority', 'monthKey', 'year', 'q', 'ageBand', 'moneyState', 'excludeSto', 'includeDeleted', 'onlyOpen',
  'onlyDirectPo', 'onlyReleaseExempt', 'sort', 'dir',
] as const;

/**
 * Age bands, matching the boundaries the Open Items cards draw.
 *
 * Defined here and nowhere else. If these drifted from the card's own bands,
 * clicking "2,722 past 15 d" would open a table with a different number in the
 * corner, and there would be no way for a reader to tell which was right.
 */
/**
 * Goods received, invoice not yet posted - the GR/IR gap, on the order line.
 *
 * The same pair the grir_value KPI and the drill's `grirOpen` filter use:
 * nothing left to deliver, something left to invoice. Written against the view
 * here because the Open Items cards count the view.
 */
const DELIVERED_NOT_INVOICED =
  'COALESCE(d.still_deliver_qty, 0) = 0 AND COALESCE(d.still_invoice_val, 0) > 0';

/**
 * Invoiced in Coupa and not yet paid.
 *
 * ── Why this one reaches outside the dataset ───────────────────────────────
 *
 * The SAP export carries no invoice document and no payment status at all - it
 * knows what is left to invoice and nothing about what happens afterwards. The
 * only payment data in this system is Coupa's, so this predicate crosses into
 * ops.* to answer a question the facts cannot.
 *
 * Three consequences a reader has to be told about, and the page says all three:
 *
 *   ops.* is a LIVE upsert store, not a versioned one. This figure can change
 *   between two loads of the same published dataset, which is true of nothing
 *   else on the page;
 *
 *   coverage is limited to orders Coupa knows about AND carries a SAP
 *   cross-reference for. Coupa's own `po_number` is its internal number - 0 of
 *   641 invoice lines matched an SAP PO number directly - so the bridge goes
 *   through coupa_po_line.sap_po_no/sap_po_item, which is the field the payload
 *   contract actually populates;
 *
 *   ops.v_coupa_invoice, not the raw table: it drops invoices whose linked
 *   lines are all in excluded purchasing groups, so this agrees with the
 *   Invoicing and Payment page rather than quietly counting more.
 *
 * 'voided' and 'draft' are excluded because neither is a debt.
 */
const INVOICED_NOT_PAID = `EXISTS (
  SELECT 1 FROM ops.coupa_invoice_line il
    JOIN ops.coupa_po_line cpl ON cpl.order_line_id = il.order_line_id
    JOIN ops.v_coupa_invoice i ON i.id = il.invoice_id
   WHERE cpl.sap_po_no = d.po_no AND cpl.sap_po_item = d.po_item
     AND NOT i.paid AND i.status NOT IN ('voided', 'draft'))`;

/** Exported so the Open Items cards count exactly what the table will show. */
export const MONEY_STATE_SQL: Record<string, string> = {
  deliveredNotInvoiced: DELIVERED_NOT_INVOICED,
  invoicedNotPaid: INVOICED_NOT_PAID,
};

const AGE_BANDS: Record<string, string> = {
  // The six bands, generated from @pct/rules over this view's own age column.
  ...Object.fromEntries(SHARED_AGE_BANDS.map(
    (b) => [b.key, ageBandPredicateSql('d.age_days', b.key)],
  )),
  // The four that preceded them, kept so a saved view or a link from before
  // 23 Sep 2026 still opens the rows it names. '16-30' and '31-90' are NOT the
  // same cut as the new '8-30' and '31-60' — they are left as they were rather
  // than quietly re-pointed at a different population.
  '0-15': 'd.age_days <= 15',
  '16-30': 'd.age_days > 15 AND d.age_days <= 30',
  '31-90': 'd.age_days > 30 AND d.age_days <= 90',
  '>90': 'd.age_days > 90',
  'past-sla': 'd.age_days > 15',
};

export function isAgeBand(v: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGE_BANDS, v);
}

export function isMoneyState(v: string): boolean {
  return Object.prototype.hasOwnProperty.call(MONEY_STATE_SQL, v);
}

/**
 * Read filters and sort out of a query string.
 *
 * Shared by the table endpoint and the export endpoint on purpose. These two
 * MUST read a query string identically: the export exists to hand someone the
 * rows they are looking at, so a filter honoured by one and not the other
 * produces a spreadsheet that disagrees with the screen -- and the person
 * holding the spreadsheet has no way to tell.
 */
export function parseDetailQuery(q: Record<string, unknown>): {
  filters: DetailFilters;
  sort: { key: string; dir: 'asc' | 'desc' } | null;
} {
  const list = (name: string): string[] | undefined => {
    const raw = q[name];
    if (raw === undefined) return undefined;
    const arr = Array.isArray(raw) ? raw.map(String) : String(raw).split(',');
    const cleaned = arr.map((x) => x.trim()).filter((x) => x !== '');
    return cleaned.length > 0 ? cleaned : undefined;
  };
  const flag = (name: string): boolean => String(q[name] ?? '') === 'true';

  const filters: DetailFilters = {
    status: list('status'),
    matCat: list('matCat'),
    spendCategory: list('spendCategory'),
    matGroup: list('matGroup'),
    plant: list('plant'),
    company: list('company'),
    purchOrg: list('purchOrg'),
    purchGroup: list('purchGroup'),
    priority: list('priority'),
    monthKey: list('monthKey'),
    year: list('year')?.filter((y) => /^\d{4}$/.test(y)),
    search: q['q'] === undefined ? undefined : String(q['q']),
    ageBand: q['ageBand'] === undefined ? undefined : String(q['ageBand']),
    moneyState: q['moneyState'] === undefined ? undefined : String(q['moneyState']),
    excludeSto: flag('excludeSto'),
    includeDeleted: flag('includeDeleted'),
    onlyOpen: flag('onlyOpen'),
    onlyDirectPo: flag('onlyDirectPo'),
    onlyReleaseExempt: flag('onlyReleaseExempt'),
  };

  const sortKey = q['sort'] === undefined ? null : String(q['sort']);
  const sort = sortKey
    ? { key: sortKey, dir: (String(q['dir'] ?? 'asc') === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc' }
    : null;

  return { filters, sort };
}

/**
 * The active filters as label/value pairs, for the export's provenance sheet.
 *
 * Labels rather than parameter names: the reader of the spreadsheet did not
 * write the query string, and "matCat" means nothing to them.
 */
export function describeDetailFilters(
  filters: DetailFilters,
  sort: { key: string; dir: 'asc' | 'desc' } | null,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const listLabels: Array<[keyof DetailFilters, string]> = [
    ['status', 'Status'],
    ['matCat', 'Category'],
    ['matGroup', 'Material group'],
    ['plant', 'Plant'],
    ['spendCategory', 'Spend category'],
    ['company', 'Company'],
    ['purchOrg', 'Purchasing org'],
    ['purchGroup', 'Purchasing group'],
    ['priority', 'Priority'],
    ['monthKey', 'Month'],
    ['year', 'Year'],
  ];
  for (const [key, label] of listLabels) {
    const v = filters[key] as string[] | undefined;
    if (v && v.length > 0) out.push([label, v.join(', ')]);
  }
  if ((filters.search ?? '').trim() !== '') out.push(['Search', filters.search!.trim()]);
  if (filters.ageBand) {
    out.push(['Age', filters.ageBand === 'past-sla' ? 'over 15 days' : `${filters.ageBand} days`]);
  }
  if (filters.moneyState === 'deliveredNotInvoiced') {
    out.push(['State', 'delivered, not invoiced']);
  }
  if (filters.moneyState === 'invoicedNotPaid') {
    // Named as Coupa's, in the export's own filter list, because the rows came
    // from a store the dataset version does not pin.
    out.push(['State', 'invoiced in Coupa, not paid']);
  }

  // Toggles are listed only when ON, except "include deleted", which is stated
  // either way: whether deleted rows are in the file changes every total in it.
  if (filters.excludeSto) out.push(['Exclude STO', 'yes']);
  if (filters.onlyOpen) out.push(['Open only', 'yes']);
  if (filters.onlyDirectPo) out.push(['Direct POs only', 'yes']);
  if (filters.onlyReleaseExempt) out.push(['Release-exempt only', 'yes']);
  out.push(['Deleted rows', filters.includeDeleted ? 'included' : 'excluded']);

  const sortCol = sort ? COLUMN_BY_KEY.get(sort.key) : undefined;
  out.push([
    'Sorted by',
    sortCol ? `${sortCol.label} ${sort!.dir === 'desc' ? 'descending' : 'ascending'}` : 'PR No, PR item, PO No, PO item',
  ]);
  return out;
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

/**
 * The facet columns, and which filter key each one is driven by.
 *
 * One list rather than two so a facet cannot be offered in the UI without the
 * filter that narrows it, or vice versa.
 */
const FACETS: { name: keyof DetailFilters & string; col: string }[] = [
  { name: 'status', col: 'status' },
  { name: 'matCat', col: 'mat_cat' },
  { name: 'matGroup', col: 'mat_group' },
  { name: 'plant', col: 'plant' },
  { name: 'spendCategory', col: 'spend_category' },
  { name: 'company', col: 'company' },
  { name: 'purchOrg', col: 'purch_org' },
  { name: 'purchGroup', col: 'purch_group' },
  { name: 'priority', col: 'p_cat' },
];

/**
 * Build the WHERE clause and the parameters that go with it.
 *
 * `omit` drops ONE filter, and exists for the facet counts. A facet computed
 * under its OWN filter can only ever return the values already chosen: tick
 * "Delivered" and the Status list collapses to just "Delivered", so there is
 * no second value left to tick and multi-select becomes impossible. Omitting
 * the facet's own filter is what makes the list stay open — and it makes the
 * count mean "how many rows would match if I added this value too", which is
 * the useful reading.
 *
 * The clause and its params are built together and returned together, because
 * they cannot be separated: PostgreSQL infers a parameter's type from where it
 * is used, so passing a param whose clause was dropped fails with "could not
 * determine data type of parameter $n". One pass per facet, each with its own
 * params array, is the only correct shape.
 */
function buildDetailWhere(
  versionId: number,
  scope: readonly ScopeEntry[],
  filters: DetailFilters,
  omit?: string,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [versionId];
  const where: string[] = ['d.dataset_version_id = $1'];

  // Scope is composed in the data layer; an empty scope yields no rows. Never
  // omitted — a facet must not offer a value the reader cannot open.
  // DETAIL_SCOPE_COLUMNS: this is the VIEW, which spells the company `company`.
  where.push(scopeSql(mintScopedQuery('detail', scope), 'd', params, DETAIL_SCOPE_COLUMNS));

  const inList = (col: string, vals: string[] | undefined, key: string) => {
    if (!vals || vals.length === 0 || key === omit) return;
    params.push(vals);
    where.push(`d.${col} = ANY($${params.length})`);
  };

  for (const f of FACETS) {
    inList(f.col, filters[f.name] as string[] | undefined, f.name);
  }

  if (filters.monthKey && filters.monthKey.length > 0 && omit !== 'monthKey') {
    params.push(filters.monthKey);
    where.push(`to_char(COALESCE(d.po_date, d.req_date), 'YYYY-MM') = ANY($${params.length})`);
  }
  if (filters.year && filters.year.length > 0) {
    params.push(filters.year);
    where.push(`to_char(COALESCE(d.po_date, d.req_date), 'YYYY') = ANY($${params.length})`);
  }

  // Toggles are NOT omitted for any facet: they narrow the population the
  // reader is looking at rather than one dimension of it, so a facet count
  // that ignored them would not describe the rows they would get.
  if (filters.excludeSto) where.push('NOT d.is_sto');
  if (!filters.includeDeleted) where.push('NOT d.pr_deleted');
  if (filters.onlyOpen) {
    where.push(`d.status IN ('Unapproved PR','PR Approved-No PO','PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered')`);
  }
  if (filters.onlyDirectPo) where.push('d.is_direct_po');
  if (filters.onlyReleaseExempt) where.push('d.release_exempt');

  // Never interpolated: the clause comes from the whitelist above, and an
  // unknown band is ignored rather than widening the query silently.
  if (filters.ageBand && AGE_BANDS[filters.ageBand]) {
    where.push(`(${AGE_BANDS[filters.ageBand]})`);
  }
  if (filters.moneyState && MONEY_STATE_SQL[filters.moneyState]) {
    where.push(`(${MONEY_STATE_SQL[filters.moneyState]})`);
  }

  const search = (filters.search ?? '').trim();
  if (search !== '') {
    params.push(`%${search}%`);
    const ph = `$${params.length}`;
    where.push(`(${SEARCH_COLUMNS.map((c) => `d.${c} ILIKE ${ph}`).join(' OR ')})`);
  }

  return { sql: where.join(' AND '), params };
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
  /**
   * Look up the Coupa columns. The table always does (a page is cheap); the
   * export does only when a Coupa column was chosen, because there the lookup
   * would run for every one of up to MAX_EXPORT_ROWS rows to fill columns
   * nobody asked for.
   */
  withCoupa = true,
): Promise<DetailPage> {
  const { sql: whereSql, params } = buildDetailWhere(versionId, scope, filters);

  const countRow = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM core.v_detail d WHERE ${whereSql}`,
    params,
  );
  const total = countRow?.n ?? 0;

  // Sort column is looked up in the whitelist, never interpolated from input.
  const sortCol = sort ? COLUMN_BY_KEY.get(sort.key) : undefined;
  const orderBy =
    sortCol && sortCol.sortable
      ? `${colExpr(sortCol)} ${sort!.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, d.pr_no, d.pr_item, d.po_no, d.po_item`
      : 'd.pr_no NULLS LAST, d.pr_item, d.po_no, d.po_item';

  const coupa = withCoupa || Boolean(sortCol?.coupa);
  const select = DETAIL_COLUMNS
    .map((c) => `${c.coupa && !coupa ? 'NULL' : colExpr(c)} AS "${c.key}"`).join(', ');
  const coupaJoin = coupa ? COUPA_JOIN : '';
  const pageParams = [...params, limit, offset];

  const flagCols = `d.is_sto AS "_sto", d.release_exempt AS "_exempt", d.is_token_price AS "_token",
            d.link_status AS "_link", d.is_direct_po AS "_direct", d.wbs_status AS "_wbs",
            d.is_retro_po AS "_retro"`;
  const lim = `LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`;
  /*
   * The Coupa lookup runs on the PAGE, not the population: the page is chosen
   * first and only its rows are looked up. Joined before the LIMIT, the planner
   * looked up every matching row - 4.4 s for a page of 200 on 56,716 rows.
   * Sorting BY a Coupa column has to look up every row to know the order, so
   * that one case still joins first.
   */
  const rows = await query<Record<string, unknown>>(
    sortCol?.coupa && sortCol.sortable
      ? `SELECT ${select}, ${flagCols}
           FROM core.v_detail d${coupaJoin}
          WHERE ${whereSql}
          ORDER BY ${orderBy}
          ${lim}`
      : `SELECT ${select}, ${flagCols}
           FROM (SELECT d.* FROM core.v_detail d
                  WHERE ${whereSql}
                  ORDER BY ${orderBy}
                  ${lim}) d${coupaJoin}
          ORDER BY ${orderBy}`,
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

  // Facets power the filter dropdowns. Each is computed from the same predicate
  // MINUS its own column — see buildDetailWhere. Before that omission the list
  // collapsed to whatever was already selected, which made it impossible to
  // pick a second value in any filter.
  const facets: DetailPage['facets'] = {};
  if (includeFacets) {
    for (const { name, col } of FACETS) {
      const w = buildDetailWhere(versionId, scope, filters, name);
      const f = await query<{ value: string | null; n: number }>(
        `SELECT d.${col} AS value, count(*)::int AS n
           FROM core.v_detail d WHERE ${w.sql}
          GROUP BY 1 ORDER BY 2 DESC LIMIT 200`,
        w.params,
      );
      const opts = f
        .filter((x) => x.value !== null)
        .map((x) => ({ value: x.value as string, count: x.n }));

      // A value the reader has already selected must appear in the list even
      // if this dataset no longer offers it — otherwise the only way to clear
      // it is the "Clear filters" button, and the tick it came from is gone
      // from the screen while still filtering the rows.
      const chosen = (filters[name] as string[] | undefined) ?? [];
      const present = new Set(opts.map((o) => o.value));
      for (const v of chosen) {
        if (!present.has(v)) opts.push({ value: v, count: 0 });
      }
      facets[name] = opts;
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
