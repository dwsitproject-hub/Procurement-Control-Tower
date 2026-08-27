/**
 * Template contracts — the code form of Annex A.
 *
 * Files are matched by HEADER SIGNATURE, never by filename: the reference
 * filenames embed a date range that changes every refresh, which makes them
 * actively misleading.
 *
 * `field` is the canonical name the parser writes into the staging payload.
 * Columns with no `field` are ingested for lineage only.
 */

import { normHeader } from '@pct/rules';
import type { Feed } from '@pct/contracts';

export type ColStatus = 'PK' | 'REQ' | 'OPT' | 'IGN' | 'DEAD';
export type ColType = 'str' | 'int' | 'dec' | 'date' | 'time' | 'bool' | 'enum';

export interface ContractColumn {
  header: string;
  headerNorm: string;
  type: ColType;
  status: ColStatus;
  field?: string;
  notes?: string;
}

export interface TemplateContract {
  feed: Feed;
  note?: string;
  /**
   * The feed uses CONTINUATION ROWS: a row may leave its key columns blank and
   * inherit them from the row above.
   *
   * Set only where that is the export's actual shape. It suppresses the blank-key
   * row error (V-P02), which would otherwise fire on every continuation line —
   * on PR Release that was 13,338 of 27,742 rows reported as unreadable data
   * when nothing was wrong with any of them.
   */
  continuationRows?: boolean;
  /** Header signature: all of `all`, at least one of `any`, none of `none`. */
  signature: { all: string[]; any?: string[]; none?: string[] };
  columns: ContractColumn[];
  aliases?: Array<{ field: string; aliasNorm: string }>;
}

function col(
  header: string,
  type: ColType,
  status: ColStatus,
  field?: string,
  notes?: string,
): ContractColumn {
  return { header, headerNorm: normHeader(header), type, status, field, notes };
}

// ───────────────────────────────────────────────────────────── PR Report (ME5A)

const PR: TemplateContract = {
  feed: 'pr',
  note: 'SAP ME5A — list of purchase requisitions. PK: Purchase Requisition + Item of requisition.',
  signature: {
    all: ['purchaserequisition'],
    any: ['itemofrequisition', 'requisitiondate', 'quantityrequested'],
    none: ['purchasingdocument', 'purchdoc'],
  },
  columns: [
    col('Purchase Requisition', 'str', 'PK', 'prNo'),
    col('Item of requisition', 'int', 'PK', 'prItem'),
    col('Material', 'str', 'REQ', 'materialCode', 'blank => service item; WBS discriminator'),
    col('Requirement Urgency', 'enum', 'REQ', 'urgency', 'urgent = {1,2}; 0 is undefined'),
    col('Requirement Priority', 'enum', 'OPT', 'priority'),
    col('Short Text', 'str', 'REQ', 'shortText'),
    col('Quantity requested', 'dec', 'REQ', 'qtyRequested'),
    col('Unit of Measure', 'str', 'REQ', 'uom'),
    col('Requisitioner', 'str', 'REQ', 'requisitioner', 'personal data — restricted display'),
    col('Plant', 'str', 'REQ', 'plant'),
    col('Purchasing Group', 'str', 'REQ', 'purchGroup'),
    col('Valuation Price', 'dec', 'REQ', 'valuationPrice'),
    col('Total Value', 'dec', 'REQ', 'totalValueIdr', '20.9% are zero on reference data'),
    col('Purch. organization', 'str', 'REQ', 'purchOrg'),
    col('Created by', 'str', 'IGN', 'createdBy', 'personal data'),
    col('Requisition date', 'date', 'REQ', 'requisitionDate'),
    col('Release indicator', 'enum', 'REQ', 'releaseIndicator'),
    col('Deletion indicator', 'bool', 'REQ', 'deletionIndicator', "literal 'true'/'false' strings"),
    col('Document Type', 'enum', 'REQ', 'docType'),
    col('Material Group', 'str', 'REQ', 'materialGroup'),
    col('Batch', 'str', 'DEAD'),
    col('Delivery', 'str', 'DEAD', undefined, '100% blank'),
    col('Deliv. date(From/to)', 'date', 'OPT', 'delivDateRaw',
      'NOT a need-by date: equals Release Date on 99.40% of rows (V-M01)'),
    col('Closed', 'str', 'DEAD'),
    col('Goods receipt', 'str', 'DEAD', undefined, "single value 'Yes' on all rows"),
    col('Release strategy', 'str', 'OPT', 'releaseStrategy'),
    col('Release Date', 'date', 'REQ', 'releaseDate'),
    col('WBS Element', 'str', 'OPT', 'wbsElement', 'only 11.1% populated'),
    // Requested addition (decision D4). Absent today; activates Demand Realism.
    col('Deliv. date', 'date', 'OPT', 'needByDate', 'EBAN-LFDAT — requested; not yet in the export'),
  ],
  aliases: [
    { field: 'needByDate', aliasNorm: 'deliverydate' },
    { field: 'needByDate', aliasNorm: 'delivdate' },
    { field: 'totalValueIdr', aliasNorm: 'totalvalueidr' },
    { field: 'qtyRequested', aliasNorm: 'quantity' },
  ],
};

// ──────────────────────────────────────────────────────────────── PR Release

const PREL: TemplateContract = {
  feed: 'prel',
  continuationRows: true,
  note: 'SAP PR release-strategy list. 48% of rows are continuation rows with blank identifiers.',
  signature: {
    all: ['prno'],
    any: ['picrelease', 'gapapprovalleadtime', 'approvedate'],
  },
  columns: [
    col('Doc Type', 'enum', 'REQ', 'docType'),
    col('PR No', 'str', 'PK', 'prNo', 'blank on all 13,338 continuation rows'),
    col('PR Created Date', 'date', 'REQ', 'prCreatedDate'),
    col('PR Item', 'int', 'PK', 'prItem', 'literal 0 on continuation rows — a sentinel'),
    col('Plant', 'str', 'REQ', 'plant'),
    col('Pur.Org', 'str', 'REQ', 'purchOrg'),
    col('Material', 'str', 'OPT', 'materialCode'),
    col('Short Text', 'str', 'REQ', 'shortText'),
    col('Material Group', 'str', 'REQ', 'materialGroup'),
    col('Qty', 'dec', 'OPT', 'qty', 'literal 0 on continuation rows'),
    col('UOM', 'str', 'REQ', 'uom'),
    col('Status', 'enum', 'REQ', 'status'),
    col('Rel Seq', 'int', 'PK', 'relSeq'),
    col('Rel Code', 'str', 'REQ', 'relCode'),
    col('PIC Release', 'str', 'REQ', 'picRelease', 'role name — safe to display'),
    col('Login Name', 'str', 'REQ', 'loginName', 'personal data — never displayed below Auditor'),
    col('Approve Date', 'date', 'OPT', 'approveDate', 'blank = not yet approved at this level'),
    col('Approve Time', 'time', 'OPT', 'approveTime'),
    col('Approved Lead Time - PR Created', 'int', 'OPT', 'apprLeadDays',
      'SAP-precomputed PR created -> step approved; v1 pr-alt card (008)'),
    col('GAP Approval Lead Time', 'int', 'OPT', 'gapLeadDays',
      'SAP-precomputed per-step gap; v1 approval-bottlenecks table (008)'),
  ],
  aliases: [
    { field: 'prNo', aliasNorm: 'purchaserequisition' },
    { field: 'prItem', aliasNorm: 'item' },
    { field: 'relSeq', aliasNorm: 'releaseseq' },
    { field: 'approveDate', aliasNorm: 'approvaldate' },
  ],
};

// ───────────────────────────────────────────────────────────── PO Report (ME2N)

const PO: TemplateContract = {
  feed: 'po',
  note: 'SAP ME2N — purchasing documents. PK: Purchasing Document + Item.',
  signature: {
    all: ['purchasingdocument'],
    any: ['netordervalue', 'netprice', 'orderquantity', 'stilltobedeliveredvalue', 'suppliersupplyingplant'],
    none: ['pono', 'prno'],
  },
  columns: [
    col('Deletion indicator', 'enum', 'REQ', 'deletionIndicator', "'L' = deleted — the deletion source"),
    col('Purchasing Document', 'str', 'PK', 'poNo'),
    col('Item', 'int', 'PK', 'poItem'),
    col('Req. Tracking Number', 'str', 'REQ', 'reqTrackingNo', '100% populated on STO lines'),
    col('Purchasing Doc. Type', 'enum', 'REQ', 'docType', 'ends-with 70 => STO'),
    col('Purch. Doc. Category', 'enum', 'IGN'),
    col('Purchasing Group', 'str', 'REQ', 'purchGroup'),
    col('PO history/release documentation', 'str', 'DEAD'),
    col('Document Date', 'date', 'REQ', 'documentDate', 'aging basis; FX period basis'),
    col('Supplier/Supplying Plant', 'str', 'REQ', 'supplierRaw', 'CODE  NAME; supplying plant for STO'),
    col('Material', 'str', 'REQ', 'materialCode'),
    col('Short Text', 'str', 'REQ', 'shortText'),
    col('Acct Assignment Cat.', 'enum', 'OPT', 'acctAssignCat'),
    col('Plant', 'str', 'REQ', 'plant'),
    col('Order Quantity', 'dec', 'REQ', 'orderQty'),
    col('Stockkeeping unit', 'str', 'OPT'),
    col('Net Price', 'dec', 'REQ', 'netPrice'),
    col('Price unit', 'int', 'REQ', 'priceUnit', '398 lines have > 1 — unit price must divide by it'),
    col('Still to be delivered (qty)', 'dec', 'REQ', 'stillDeliverQty'),
    col('Still to be delivered (value)', 'dec', 'REQ', 'stillDeliverVal', 'open commitment basis'),
    col('Still to be invoiced (qty)', 'dec', 'REQ', 'stillInvoiceQty'),
    col('Still to be invoiced (val.)', 'dec', 'REQ', 'stillInvoiceVal', 'GR/IR exposure basis'),
    col('Purch. organization', 'str', 'REQ', 'purchOrg'),
    col('Item category', 'enum', 'OPT'),
    col('Purchasing info rec.', 'str', 'OPT', 'infoRecord',
      'filled on ~49.6% of lines — info-record coverage KPI (po_irc)'),
    col('Package number', 'str', 'IGN'),
    col('Release group', 'str', 'REQ', 'releaseGroup', 'blank on the same 964 lines as Release indicator'),
    col('Release Strategy', 'str', 'OPT', 'releaseStrategy'),
    col('Release State', 'str', 'OPT', 'releaseState'),
    col('Release indicator', 'enum', 'REQ', 'releaseIndicator', 'blank + blank group => release-exempt'),
    col('Order Price Unit', 'str', 'OPT', 'orderPriceUnit'),
    col('Incomplete', 'enum', 'OPT', 'incomplete', "'X' => HOLD PO"),
    col('Material Group', 'str', 'REQ', 'materialGroup'),
    col('Item Category', 'str', 'OPT'),
    col('Storage location', 'str', 'OPT', 'storageLocation'),
    col('Order Unit', 'str', 'REQ', 'orderUnit'),
    col('Quantity in SKU', 'dec', 'OPT'),
    col('Currency', 'enum', 'REQ', 'currencyCode', 'US$ and USD both occur — normalisation mandatory'),
    col('Outline agreement', 'str', 'DEAD'),
    col('Control indicator', 'str', 'IGN'),
    col('Name of Supplier', 'str', 'REQ', 'vendorName'),
    col('Tax Code', 'str', 'DEAD'),
    col('Tax Jurisdiction', 'str', 'DEAD'),
    col('Net Order Value', 'dec', 'REQ', 'netOrderValue'),
    col('Requirement Urgency', 'enum', 'OPT', 'urgency'),
    col('Reqmt Priority', 'enum', 'OPT', 'priority'),
    col('Incoterms', 'str', 'OPT'),
    col('Incoterms (Part 2)', 'str', 'OPT'),
    col('Contract Ext', 'str', 'DEAD'),
    col('Created by', 'str', 'IGN', 'createdBy', 'personal data'),
    col('Purchase Requisition', 'str', 'REQ', 'prNo', 'blank => direct PO (43.7% of lines)'),
    col('Item of requisition', 'int', 'REQ', 'prItem', "'0' is the NULL sentinel — 9,094 rows"),
    col('Delivery date', 'date', 'REQ', 'deliveryDate', 'EINDT; equals Document Date on 37.4%'),
  ],
  aliases: [
    { field: 'netOrderValue', aliasNorm: 'netvalue' },
    { field: 'netOrderValue', aliasNorm: 'sumnetordervalue' },
    { field: 'priceUnit', aliasNorm: 'per' },
    { field: 'orderQty', aliasNorm: 'quantity' },
    { field: 'poNo', aliasNorm: 'purchdoc' },
    { field: 'deliveryDate', aliasNorm: 'delivdate' },
    { field: 'vendorName', aliasNorm: 'nameofvendor' },
  ],
};

// ──────────────────────────────────────────────────────────────── PO Release

const POR: TemplateContract = {
  feed: 'por',
  note: 'SAP PO release-strategy list. No continuation-row problem — every row carries its PO No.',
  signature: {
    all: ['pono'],
    any: ['picrelease', 'approvedate', 'relcode'],
    none: ['purchasingdocument', 'purchdoc'],
  },
  columns: [
    col('PO No', 'str', 'PK', 'poNo'),
    col('PO Date', 'date', 'REQ', 'poDate'),
    col('PO Create Date', 'date', 'REQ', 'poCreateDate'),
    col('Vendor', 'str', 'REQ', 'vendorCode'),
    col('Vendor Name', 'str', 'REQ', 'vendorName'),
    col('Company Code', 'str', 'REQ', 'companyCode'),
    col('P.Org', 'str', 'REQ', 'purchOrg'),
    col('Ccy', 'enum', 'REQ', 'currencyCode'),
    col('Amount', 'dec', 'REQ', 'amount'),
    col('Rel Seq', 'int', 'PK', 'relSeq', 'up to 4 approval levels — deeper than PR'),
    col('Rel Code', 'str', 'PK', 'relCode'),
    col('PIC Release', 'str', 'REQ', 'picRelease'),
    col('Login Name', 'str', 'REQ', 'loginName', 'personal data'),
    col('Approve Date', 'date', 'OPT', 'approveDate', 'blank = pending'),
    col('Approve Time', 'time', 'OPT', 'approveTime'),
  ],
  aliases: [
    { field: 'poNo', aliasNorm: 'ponumber' },
    { field: 'currencyCode', aliasNorm: 'currency' },
  ],
};

// ───────────────────────────────────────────────────────────── GR List (MB51)

const GR: TemplateContract = {
  feed: 'gr',
  note: 'SAP MB51 — material documents. Movement types 101/102/641/642 in reference data.',
  signature: {
    all: ['movementtype'],
    any: ['postingdate', 'postingdt'],
  },
  columns: [
    col('Purchase order', 'str', 'PK', 'poNo'),
    col('Item', 'int', 'PK', 'poItem'),
    col('Plant', 'str', 'REQ', 'plant'),
    col('Storage location', 'str', 'OPT', 'storageLocation'),
    col('Movement type', 'enum', 'REQ', 'movementType', 'unregistered type => BLOCKER V-R07'),
    col('Material', 'str', 'OPT', 'materialCode'),
    col('Material description', 'str', 'REQ', 'materialDesc'),
    col('Entry Date', 'date', 'IGN', 'entryDate'),
    col('Posting Date', 'date', 'REQ', 'postingDate', 'receipt-date basis for movement type 101 only'),
    col('Document Date', 'date', 'OPT', 'documentDate'),
    col('Qty in unit of entry', 'dec', 'REQ', 'qtyEntry', 'THE correct quantity column — 0 zeros'),
    col('Unit of Entry', 'str', 'REQ', 'unitOfEntry'),
    col('Batch', 'str', 'OPT', 'batch'),
    col('Valuation Type', 'str', 'OPT'),
    col('Movement Type Text', 'str', 'REQ', 'movementTypeText'),
    col('Material Document', 'str', 'PK', 'materialDoc'),
    col('User Name', 'str', 'IGN', 'postedBy', 'personal data — restricted display'),
    col('Amt.in Loc.Cur.', 'dec', 'REQ', 'amountLocal'),
    col('Document Header Text', 'str', 'OPT'),
    col('Name 1', 'str', 'OPT'),
    col('Company Code', 'str', 'REQ', 'companyCode'),
    col('Qty in OPUn', 'dec', 'OPT'),
    col('Order Price Unit', 'str', 'OPT'),
    col('Order Unit', 'str', 'REQ', 'orderUnit'),
    col('Qty in order unit', 'dec', 'OPT'),
    col('Time of Entry', 'time', 'IGN'),
    col('Material Doc.Item', 'int', 'PK', 'materialDocItem'),
    col('Ext. Amount in Local Currency', 'dec', 'DEAD'),
    col('Sales Value', 'dec', 'DEAD'),
    col('Movement indicator', 'enum', 'OPT'),
    col('Consumption', 'str', 'OPT'),
    col('Receipt Indicator', 'str', 'OPT'),
    col('Vendor', 'str', 'OPT', 'vendorCode'),
    col('Base Unit of Measure', 'str', 'OPT'),
    col('Quantity', 'dec', 'IGN', undefined,
      'DO NOT USE — zero on 22.4% of rows; PRD v1 wrongly nominated this column'),
    col('Sales Value inc. VAT', 'dec', 'DEAD'),
  ],
  aliases: [
    { field: 'qtyEntry', aliasNorm: 'quantityinunitofentry' },
    { field: 'qtyEntry', aliasNorm: 'qtyinunofentry' },
    { field: 'poNo', aliasNorm: 'purchaseorder' },
    { field: 'postingDate', aliasNorm: 'pstngdate' },
  ],
};

// ─────────────────────────────────────────────────────────────── FX rate table

const FX: TemplateContract = {
  feed: 'fx',
  note: 'SAP rate table. Reference layout: Month | From | To | Average of Rate (no year).',
  signature: {
    all: ['from', 'to'],
  },
  columns: [
    col('Month', 'str', 'PK', 'period', "'1.Jan' .. '7.Jul' — NO YEAR; anchored from the data range"),
    col('From', 'str', 'PK', 'from'),
    col('To', 'str', 'PK', 'to'),
    col('Average of Rate', 'dec', 'REQ', 'rate', 'units of To per 1 unit of From'),
  ],
  aliases: [
    { field: 'period', aliasNorm: 'date' },
    { field: 'period', aliasNorm: 'period' },
    { field: 'rate', aliasNorm: 'rate' },
    { field: 'rate', aliasNorm: 'exchangerate' },
    { field: 'rate', aliasNorm: 'averagerate' },
    { field: 'rate', aliasNorm: 'avgrate' },
  ],
};

// ──────────────────────────────────────────── reference / master-data feeds
//
// These four differ from the six transactional exports in three ways worth
// stating, because each one caused a design choice below:
//
//   * They are SAP LIST OUTPUT, not spreadsheets. Three are tab-delimited text
//     named .csv, with a blank first line and — for the user listing — a title
//     line and a pipe-delimited header sitting above tab-delimited data. The
//     reader in parse.ts handles that shape; the contracts here see the same
//     clean {headers, rows} as any workbook.
//   * They are OPTIONAL. Absent from REQUIRED_FEEDS below, so a bundle without
//     them publishes normally.
//   * They are SMALL and header-poor. A two-column file gives a weak signature,
//     so `none` is used to keep them from shadowing each other: the purchasing
//     ORG file must not match the purchasing GROUP contract, and vice versa.

const PGRP: TemplateContract = {
  feed: 'pgrp',
  note: 'SAP purchasing-group master (ME_PGR list). Telephone and Fax exist in '
    + 'the header but are empty for all 300 rows, so they are lineage only.',
  signature: {
    all: ['pgr'],
    none: ['porg', 'user'],
  },
  columns: [
    col('PGr', 'str', 'PK', 'code'),
    col('Description', 'str', 'REQ', 'description', "buyer desk or person; two rows carry an 'INACTIVE' prefix typed by hand"),
    col('Telephone', 'str', 'IGN'),
    col('Fax Number', 'str', 'IGN'),
  ],
  aliases: [
    { field: 'code', aliasNorm: 'purchasinggroup' },
    { field: 'code', aliasNorm: 'purchgroup' },
    { field: 'description', aliasNorm: 'purchgroupdescr' },
  ],
};

const PORG: TemplateContract = {
  feed: 'porg',
  note: 'SAP purchasing-organisation master. 491 codes; covers every purch_org '
    + 'present in the PR and PO facts.',
  signature: {
    all: ['porg'],
    none: ['pgr', 'user'],
  },
  columns: [
    col('POrg', 'str', 'PK', 'code'),
    col('Purch. org. descr.', 'str', 'REQ', 'description'),
  ],
  aliases: [
    { field: 'code', aliasNorm: 'purchasingorganization' },
    { field: 'code', aliasNorm: 'purchasingorg' },
    { field: 'description', aliasNorm: 'purchorgdescr' },
    { field: 'description', aliasNorm: 'description' },
  ],
};

const MATM: TemplateContract = {
  feed: 'matm',
  note: 'Material master with SAP spend category. The file is called '
    + '"Mat group.xlsx" but is keyed by material CODE, not material group — see '
    + 'migration 018 for why its category is stored alongside material_category '
    + 'rather than replacing it.',
  signature: {
    all: ['code', 'desc', 'category'],
  },
  columns: [
    col('No', 'int', 'IGN', undefined, 'row counter in the export, not a business key'),
    col('Code', 'str', 'PK', 'materialCode'),
    col('Desc', 'str', 'REQ', 'description'),
    col('Category', 'str', 'REQ', 'category', 'MRO GENERAL, MRO SPECIFIC, HEVE, OFFICE IT, CAPEX, ...'),
  ],
  aliases: [
    { field: 'materialCode', aliasNorm: 'material' },
    { field: 'materialCode', aliasNorm: 'materialcode' },
    { field: 'description', aliasNorm: 'materialdescription' },
  ],
};

const ZUSER: TemplateContract = {
  feed: 'zuser',
  note: 'SAP user listing (ZUSER). Maps the user id in created_by / login_name '
    + 'to a person. PERSONAL DATA — see migration 018.',
  signature: {
    all: ['user', 'firstname', 'lastname'],
  },
  columns: [
    col('Client', 'str', 'PK', 'client', 'SAP client; 300 throughout'),
    col('User', 'str', 'PK', 'userId'),
    col('First Name', 'str', 'OPT', 'firstName', 'blank for background-job users'),
    col('Last Name', 'str', 'REQ', 'lastName'),
  ],
  aliases: [
    { field: 'userId', aliasNorm: 'username' },
    { field: 'userId', aliasNorm: 'userid' },
    { field: 'firstName', aliasNorm: 'name' },
  ],
};

export const TEMPLATE_CONTRACTS: TemplateContract[] = [
  PR, PREL, PO, POR, GR, FX,
  PGRP, PORG, MATM, ZUSER,
];

export const CONTRACT_BY_FEED: Record<Feed, TemplateContract> = {
  pr: PR,
  prel: PREL,
  po: PO,
  por: POR,
  gr: GR,
  fx: FX,
  pgrp: PGRP,
  porg: PORG,
  matm: MATM,
  zuser: ZUSER,
};

/**
 * Feeds that must all be present for a bundle to be considered complete.
 *
 * DELIBERATELY still the six transactional exports. The reference feeds
 * (pgrp, porg, matm, zuser) are recognised and ingested when present but never
 * gate a publish: master data changes quarterly while PR/PO land daily, so
 * requiring them would stop the pickup for a file nobody re-exported.
 */
export const REQUIRED_FEEDS: Feed[] = ['pr', 'prel', 'po', 'por', 'gr', 'fx'];
