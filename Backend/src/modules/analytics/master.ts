/**
 * Master data — the reference tables behind every code the dashboard shows.
 *
 * Requested 31 Aug 2026: one page per master, so a reader can answer "what does
 * purchasing group P22 mean" or "which vendors do we have on record" without
 * asking someone with database access.
 *
 * ── Why a registry and not a table name in the URL ──────────────────────────
 *
 * The obvious shape is `/api/v1/master/:table` interpolating the segment into
 * `SELECT * FROM core.:table`. That is an injection, and no amount of escaping
 * makes it safe to let a URL choose a relation. Every dataset below is a FIXED
 * query written here; the URL selects one by id and can express nothing else.
 * A typo in the id is a 404, never a query.
 *
 * ── Two kinds of master ─────────────────────────────────────────────────────
 *
 * Most of these are CUMULATIVE: dim_vendor and friends carry every code ever
 * seen, across versions, because a vendor that stops appearing in the export
 * has not stopped existing. `core.fx_rate` is the exception — it is scoped to a
 * dataset version, because the whole point of it is what a given publish was
 * valued at. So it takes the version as a parameter and the others do not, and
 * the page says which it is looking at rather than leaving the reader to guess.
 *
 * These are code lists, so they are not row-scoped by company or plant: a plant
 * list reveals which plants exist, not what was bought at them. Every figure
 * derived from them stays scoped as it always was.
 */

import { query, queryOne } from '../../db/client.js';

export interface MasterColumn {
  key: string;
  label: string;
  /** Right-align and use tabular figures. */
  numeric?: boolean;
  /**
   * Fraction digits. Absent means whole numbers, which is right for a sort
   * order or a sign factor and very wrong for an FX rate — 0.272294 rendered
   * as "0" is not a rounding nicety, it is a different number.
   */
  decimals?: number;
}

interface MasterTableSpec {
  /** Table name as the reader sees it. */
  name: string;
  /** The real relation, for the "where this comes from" line. */
  relation: string;
  note: string;
  columns: MasterColumn[];
  select: string;
  from: string;
  /** Extra predicate, ANDed after the version filter when there is one. */
  where?: string;
  orderBy: string;
  /** Columns a search box matches against. Names come from here, never a request. */
  searchCols: string[];
  /** True when the rows belong to one dataset version. */
  versionScoped?: boolean;
}

export interface MasterPageSpec {
  id: string;
  label: string;
  icon: string;
  blurb: string;
  tables: MasterTableSpec[];
}

const C = (key: string, label: string, numeric = false, decimals?: number): MasterColumn => {
  if (!numeric) return { key, label };
  return decimals === undefined ? { key, label, numeric } : { key, label, numeric, decimals };
};

/**
 * The nine masters, in the order the reader asked for them. Ids are URL
 * segments, so they are kebab-case and stable — renaming one breaks a
 * bookmark.
 */
export const MASTER_PAGES: MasterPageSpec[] = [
  {
    id: 'fx-rates',
    label: 'FX Rates',
    icon: '💱',
    blurb: 'The rates this dataset version was valued at. Scoped to the version, '
      + 'because that is what makes a published figure reproducible.',
    tables: [{
      name: 'FX rates',
      relation: 'core.fx_rate',
      note: 'One row per currency and period. `derivation` says whether the rate was '
        + 'given directly or crossed through the pivot currency.',
      columns: [
        C('currencyCode', 'Currency'),
        C('period', 'Period'),
        C('usdPerUnit', 'USD per unit', true, 6),
        C('derivation', 'Derivation'),
        C('pivotCurrency', 'Pivot'),
        C('source', 'Source'),
        C('sourceUpdatedAt', 'Source updated'),
      ],
      select: `currency_code AS "currencyCode",
               period_year || '-' || lpad(period_month::text, 2, '0') AS period,
               usd_per_unit AS "usdPerUnit",
               derivation, pivot_currency AS "pivotCurrency", source,
               to_char(source_updated_at, 'YYYY-MM-DD HH24:MI') AS "sourceUpdatedAt"`,
      from: 'core.fx_rate',
      orderBy: 'currency_code, period_year, period_month',
      searchCols: ['currency_code', 'derivation', 'source'],
      versionScoped: true,
    }],
  },
  {
    id: 'vendors',
    label: 'Vendors',
    icon: '🏭',
    blurb: 'Every vendor code ever seen in an export, with the first and last date it '
      + 'appeared. Cumulative across versions: a vendor that stops appearing has not '
      + 'stopped existing.',
    tables: [{
      name: 'Vendors',
      relation: 'core.dim_vendor',
      note: 'Built from the PO export, so a vendor appears here once it has been ordered from.',
      columns: [
        C('vendorCode', 'Vendor code'),
        C('vendorName', 'Name'),
        C('firstSeen', 'First seen'),
        C('lastSeen', 'Last seen'),
      ],
      select: `vendor_code AS "vendorCode", vendor_name AS "vendorName",
               first_seen::text AS "firstSeen", last_seen::text AS "lastSeen"`,
      from: 'core.dim_vendor',
      orderBy: 'vendor_code',
      searchCols: ['vendor_code', 'vendor_name'],
    }],
  },
  {
    id: 'material-master',
    label: 'Material Master',
    icon: '🧾',
    blurb: 'The SAP material master. Its category is the fallback the spend-category '
      + 'mapping resolves to when no business rule matches.',
    tables: [{
      name: 'Material master',
      relation: 'core.dim_material_master',
      note: 'From the Mat group export. Third in the spend-category resolution order, '
        + 'after an exact material rule and a material-group rule.',
      columns: [
        C('materialCode', 'Material'),
        C('description', 'Description'),
        C('category', 'Category'),
      ],
      select: `material_code AS "materialCode", description, category`,
      from: 'core.dim_material_master',
      orderBy: 'material_code',
      searchCols: ['material_code', 'description', 'category'],
    }],
  },
  {
    id: 'spend-category',
    label: 'Spend Category',
    icon: '🗂️',
    blurb: 'The business taxonomy the Executive Summary is cut by. Deliberately keyless: '
      + 'a row matches on material code OR material group, so neither is unique.',
    tables: [{
      name: 'Spend category mapping',
      relation: 'core.dim_spend_category',
      note: 'Resolution order, most specific first: exact material code, then material '
        + 'group, then the SAP material master, then "(no material code)" or "(unmapped)".',
      columns: [
        C('materialCode', 'Material'),
        C('materialGroup', 'Material group'),
        C('category', 'Category'),
        C('sortOrder', 'Sort', true),
        C('source', 'Source'),
      ],
      select: `material_code AS "materialCode", material_group AS "materialGroup",
               category, sort_order AS "sortOrder", source`,
      from: 'core.dim_spend_category',
      orderBy: 'sort_order NULLS LAST, category, material_group NULLS FIRST, material_code NULLS FIRST',
      searchCols: ['material_code', 'material_group', 'category', 'source'],
    }],
  },
  {
    id: 'purchasing-groups',
    label: 'Purchasing Groups',
    icon: '👥',
    blurb: 'The buying desks. Only a fraction of the master appears on orders in any '
      + 'one dataset — the rest are historic or belong to other entities.',
    tables: [{
      name: 'Purchasing groups',
      relation: 'core.dim_purch_group',
      note: '`is_ho` marks a Head Office desk. Note the HO split on the dashboard is '
        + 'measured on purchasing ORG, not on this flag.',
      columns: [
        C('code', 'Code'),
        C('description', 'Description'),
        C('isHo', 'Head office'),
        C('source', 'Source'),
      ],
      select: `code, description,
               CASE WHEN is_ho THEN 'yes' ELSE 'no' END AS "isHo", source`,
      from: 'core.dim_purch_group',
      orderBy: 'code',
      searchCols: ['code', 'description', 'source'],
    }],
  },
  {
    id: 'org',
    label: 'Org Structure',
    icon: '🏛️',
    blurb: 'Purchasing organisation, plant and company — the three levels every figure '
      + 'can be filtered and scoped by.',
    tables: [
      {
        name: 'Purchasing orgs',
        relation: 'core.dim_purch_org',
        note: 'The HO / unit split the dashboard reports is measured on this table.',
        columns: [C('code', 'Code'), C('description', 'Description'), C('isHo', 'Head office'), C('source', 'Source')],
        select: `code, description, CASE WHEN is_ho THEN 'yes' ELSE 'no' END AS "isHo", source`,
        from: 'core.dim_purch_org',
        orderBy: 'code',
        searchCols: ['code', 'description', 'source'],
      },
      {
        name: 'Plants',
        relation: 'core.dim_plant',
        note: 'The company code is the first two characters of the plant, which is how '
          + 'the transform derives it.',
        columns: [
          C('plant', 'Plant'), C('plantName', 'Name'), C('companyCode', 'Company'),
          C('area', 'Area'), C('firstSeen', 'First seen'), C('lastSeen', 'Last seen'),
        ],
        select: `plant, plant_name AS "plantName", company_code AS "companyCode", area,
                 first_seen::text AS "firstSeen", last_seen::text AS "lastSeen"`,
        from: 'core.dim_plant',
        orderBy: 'plant',
        searchCols: ['plant', 'plant_name', 'company_code', 'area'],
      },
      {
        name: 'Companies',
        relation: 'core.dim_company',
        note: 'The legal entity behind a company code.',
        columns: [C('companyCode', 'Company'), C('shortCode', 'Short'), C('legalName', 'Legal name')],
        select: `company_code AS "companyCode", short_code AS "shortCode", legal_name AS "legalName"`,
        from: 'core.dim_company',
        orderBy: 'company_code',
        searchCols: ['company_code', 'short_code', 'legal_name'],
      },
    ],
  },
  {
    id: 'materials',
    label: 'Materials',
    icon: '🧱',
    blurb: 'Item reference data: the materials seen in the exports, and the groups they '
      + 'roll up to.',
    tables: [
      {
        name: 'Materials',
        relation: 'core.dim_material',
        note: 'Accumulated from the exports rather than loaded from a master, so a '
          + 'material appears once it has been requisitioned or ordered.',
        columns: [
          C('materialCode', 'Material'), C('description', 'Description'),
          C('materialGroup', 'Group'), C('baseUom', 'UOM'),
          C('firstSeen', 'First seen'), C('lastSeen', 'Last seen'),
        ],
        select: `material_code AS "materialCode", description,
                 material_group AS "materialGroup", base_uom AS "baseUom",
                 first_seen::text AS "firstSeen", last_seen::text AS "lastSeen"`,
        from: 'core.dim_material',
        orderBy: 'material_code',
        searchCols: ['material_code', 'description', 'material_group', 'base_uom'],
      },
      {
        name: 'Material groups',
        relation: 'core.dim_material_group',
        note: 'The `category` here is editable reference data — it is what the '
          + 'material-group step of spend-category resolution reads.',
        columns: [C('materialGroup', 'Group'), C('description', 'Description'), C('category', 'Category')],
        select: `material_group AS "materialGroup", description, category`,
        from: 'core.dim_material_group',
        orderBy: 'material_group',
        searchCols: ['material_group', 'description', 'category'],
      },
    ],
  },
  {
    id: 'doc-types',
    label: 'Document Types',
    icon: '🏷️',
    blurb: 'SAP code lists that change how a row is counted: which document types are '
      + 'stock transfers, and which movements count as a receipt.',
    tables: [
      {
        name: 'Document types',
        relation: 'core.dim_doc_type',
        note: '`is_sto` drives the stock-transfer exclusion applied on every page.',
        columns: [C('docType', 'Doc type'), C('description', 'Description'), C('isSto', 'Stock transfer')],
        select: `doc_type AS "docType", description,
                 CASE WHEN is_sto THEN 'yes' ELSE 'no' END AS "isSto"`,
        from: 'core.dim_doc_type',
        orderBy: 'doc_type',
        searchCols: ['doc_type', 'description'],
      },
      {
        name: 'Movement types',
        relation: 'core.dim_movement_type',
        note: '`sign_factor` is -1 for a reversal, so a reversed receipt cancels the '
          + 'original instead of counting twice.',
        columns: [
          C('movementType', 'Movement'), C('description', 'Description'),
          C('class', 'Class'), C('signFactor', 'Sign', true), C('countsAsReceipt', 'Counts as receipt'),
        ],
        select: `movement_type AS "movementType", description, class,
                 sign_factor AS "signFactor",
                 CASE WHEN counts_as_receipt THEN 'yes' ELSE 'no' END AS "countsAsReceipt"`,
        from: 'core.dim_movement_type',
        orderBy: 'movement_type',
        searchCols: ['movement_type', 'description', 'class'],
      },
    ],
  },
  {
    id: 'sap-users',
    label: 'SAP Users',
    icon: '🪪',
    blurb: 'The SAP user ids that appear as creators and approvers, resolved to names. '
      + 'This is what turns "created by EU7301" into a person.',
    tables: [{
      name: 'SAP users',
      relation: 'core.dim_sap_user',
      note: 'From the ZUSER export. Keyed by client and user id, because the same id can '
        + 'exist in more than one SAP client.',
      columns: [
        C('client', 'Client'), C('userId', 'User id'),
        C('firstName', 'First name'), C('lastName', 'Last name'), C('displayName', 'Display name'),
      ],
      select: `client, user_id AS "userId", first_name AS "firstName",
               last_name AS "lastName", display_name AS "displayName"`,
      from: 'core.dim_sap_user',
      orderBy: 'client, user_id',
      searchCols: ['client', 'user_id', 'first_name', 'last_name', 'display_name'],
    }],
  },
];

export const MASTER_BY_ID = new Map(MASTER_PAGES.map((p) => [p.id, p]));

/** Row cap. These are code lists, but dim_material can run to five figures. */
const MAX_ROWS = 5000;

export interface MasterTableResult {
  name: string;
  relation: string;
  note: string;
  columns: MasterColumn[];
  rows: Record<string, unknown>[];
  /** Rows matching the search, before the cap. */
  total: number;
  /** Rows in the table with no search applied. */
  totalUnfiltered: number;
  truncated: boolean;
  versionScoped: boolean;
}

/**
 * Read one master page.
 *
 * `q` is a free-text search. It is bound as a parameter; only the COLUMN names
 * it is matched against come from the registry, so the search cannot reach
 * anything the page does not already show.
 */
export async function loadMasterPage(
  id: string,
  versionId: number,
  q: string,
): Promise<{ id: string; label: string; blurb: string; tables: MasterTableResult[] } | null> {
  const page = MASTER_BY_ID.get(id);
  if (!page) return null;

  const search = q.trim();
  const tables: MasterTableResult[] = [];

  for (const t of page.tables) {
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (t.versionScoped) {
      params.push(versionId);
      clauses.push(`dataset_version_id = $${params.length}`);
    }
    if (t.where) clauses.push(t.where);

    // Unfiltered total first, so the page can say "12 of 301" rather than only
    // the filtered number — which reads as data having gone missing.
    const baseWhere = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const unfiltered = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${t.from} ${baseWhere}`,
      [...params],
    );

    if (search !== '') {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      clauses.push(`(${t.searchCols.map((c) => `${c}::text ILIKE ${p}`).join(' OR ')})`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const counted = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${t.from} ${where}`,
      [...params],
    );
    const total = counted?.n ?? 0;

    const rows = await query<Record<string, unknown>>(
      `SELECT ${t.select} FROM ${t.from} ${where} ORDER BY ${t.orderBy} LIMIT ${MAX_ROWS}`,
      [...params],
    );

    tables.push({
      name: t.name,
      relation: t.relation,
      note: t.note,
      columns: t.columns,
      rows,
      total,
      totalUnfiltered: unfiltered?.n ?? 0,
      truncated: total > rows.length,
      versionScoped: t.versionScoped === true,
    });
  }

  return { id: page.id, label: page.label, blurb: page.blurb, tables };
}

/** The sub-nav, with a row count per page so an empty master is visible up front. */
export async function masterIndex(versionId: number): Promise<
  { id: string; label: string; icon: string; rows: number }[]
> {
  const out: { id: string; label: string; icon: string; rows: number }[] = [];
  for (const p of MASTER_PAGES) {
    let rows = 0;
    for (const t of p.tables) {
      const r = await queryOne<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${t.from}`
        + (t.versionScoped ? ` WHERE dataset_version_id = $1` : ''),
        t.versionScoped ? [versionId] : [],
      );
      rows += r?.n ?? 0;
    }
    out.push({ id: p.id, label: p.label, icon: p.icon, rows });
  }
  return out;
}
