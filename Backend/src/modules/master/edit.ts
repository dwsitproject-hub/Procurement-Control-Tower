/**
 * Administrator edits to master data - add, edit, hide, revert.
 *
 * See migration 032 for why these are OVERRIDES the sync re-applies rather than
 * writes to the dimension tables: most of those tables are rewritten by every
 * SAP sync, and an edit that silently undoes itself overnight is worse than no
 * edit at all.
 *
 * ── The registry is the only source of SQL identifiers ────────────────────
 *
 * Every table, key column and editable column below is written here. A request
 * names a relation and supplies VALUES; it can never supply a column or table
 * name, because the SQL is assembled only from what this file lists. An
 * unknown relation or column is a 400, never a query.
 *
 * ── Three kinds of field ──────────────────────────────────────────────────
 *
 *   label      what a code is CALLED. Visible at once, here and anywhere the
 *              name is shown.
 *   recompute  an INPUT to the transform - material category, say. The
 *              published dataset is immutable, so figures move at the next full
 *              recompute, and the page says so on the field.
 *   mart       read live by the KPIs and charts - the HO flag, the plant area.
 *              Figures move at the next "Recompute charts and KPIs".
 *
 * And fields that are deliberately NOT editable, listed with the reason. Some
 * look like calculation inputs and are not: dim_doc_type.is_sto is decided by
 * the STO rule and written INTO the dimension from the facts; the movement-type
 * signs are documentation of rules that live in code. Offering them as edits
 * would let an administrator "reclassify" something while no figure moved - a
 * silent lie - so the form shows them read-only and says where they really are
 * controlled.
 */
import type pg from 'pg';
import { query, queryOne, transaction } from '../../db/client.js';
import type { FxRate } from '@pct/rules';

export type FieldKind = 'text' | 'bool' | 'int' | 'number';
export type FieldEffect = 'label' | 'recompute' | 'mart';

export interface EditField {
  /** Database column. */
  col: string;
  /** The row's key for this column as the Master page returns it. */
  key: string;
  label: string;
  kind: FieldKind;
  effect: FieldEffect;
  required?: boolean;
}

export interface KeyColumn { col: string; key: string; label: string; kind: FieldKind }

export interface ReadOnlyField { key: string; reason: string }

export interface EditSpec {
  relation: string;
  keys: KeyColumn[];
  fields: EditField[];
  readOnly: ReadOnlyField[];
  allowAdd: boolean;
  allowDelete: boolean;
  /** NOT NULL columns an added row needs that are not editable. */
  insertDefaults?: Record<string, unknown>;
  /** FX is applied in the transform's FX build, never to the published table. */
  fx?: boolean;
  /** One line for the edit form, stated where the admin will read it. */
  note: string;
}

const SEEN = 'Derived from the facts - the first and last dataset this code appeared in.';

export const EDIT_SPECS: EditSpec[] = [
  {
    relation: 'core.fx_rate',
    fx: true,
    keys: [
      { col: 'currency_code', key: 'currencyCode', label: 'Currency', kind: 'text' },
      { col: 'period_year', key: 'periodYear', label: 'Year', kind: 'int' },
      { col: 'period_month', key: 'periodMonth', label: 'Month', kind: 'int' },
    ],
    fields: [
      { col: 'usd_per_unit', key: 'usdPerUnit', label: 'USD per unit', kind: 'number', effect: 'recompute', required: true },
    ],
    readOnly: [
      { key: 'derivation', reason: 'How the rate was computed from the source pairs.' },
      { key: 'source', reason: 'Where the rate came from. A manual rate shows as manual after the recompute.' },
    ],
    allowAdd: true,
    allowDelete: false,
    note: 'These are the rates this published dataset was valued at, and a published dataset does not '
      + 'change. A manual rate is used from the NEXT recompute, and wins over SAP and Coupa for that '
      + 'currency and month.',
  },
  {
    relation: 'core.dim_vendor',
    keys: [{ col: 'vendor_code', key: 'vendorCode', label: 'Vendor code', kind: 'text' }],
    fields: [{ col: 'vendor_name', key: 'vendorName', label: 'Name', kind: 'text', effect: 'label', required: true }],
    readOnly: [{ key: 'firstSeen', reason: SEEN }, { key: 'lastSeen', reason: SEEN }],
    allowAdd: true,
    allowDelete: true,
    note: 'Vendor names are refreshed by every SAP sync; an edited name is kept over the SAP one.',
  },
  {
    relation: 'core.dim_material_master',
    keys: [{ col: 'material_code', key: 'materialCode', label: 'Material', kind: 'text' }],
    fields: [
      { col: 'description', key: 'description', label: 'Description', kind: 'text', effect: 'label' },
      { col: 'category', key: 'category', label: 'Category', kind: 'text', effect: 'recompute' },
    ],
    readOnly: [],
    allowAdd: true,
    allowDelete: true,
    note: 'Category here feeds the spend category every Executive Summary figure is grouped by.',
  },
  {
    relation: 'core.dim_purch_group',
    keys: [{ col: 'code', key: 'code', label: 'Code', kind: 'text' }],
    fields: [{ col: 'description', key: 'description', label: 'Description', kind: 'text', effect: 'label', required: true }],
    readOnly: [
      { key: 'isHo', reason: 'Not used by any figure: head-office share is read from the purchasing ORGANIZATION.' },
      { key: 'source', reason: 'Which feed supplied this code.' },
    ],
    allowAdd: true,
    allowDelete: true,
    insertDefaults: { is_ho: false, source: 'admin' },
    note: 'Descriptions are refreshed by every SAP sync; an edited one is kept.',
  },
  {
    relation: 'core.dim_purch_org',
    keys: [{ col: 'code', key: 'code', label: 'Code', kind: 'text' }],
    fields: [
      { col: 'description', key: 'description', label: 'Description', kind: 'text', effect: 'label', required: true },
      { col: 'is_ho', key: 'isHo', label: 'Head office', kind: 'bool', effect: 'mart' },
    ],
    readOnly: [{ key: 'source', reason: 'Which feed supplied this code.' }],
    allowAdd: true,
    allowDelete: true,
    insertDefaults: { source: 'admin' },
    note: 'Head office decides the HO / site split on the Executive Summary.',
  },
  {
    relation: 'core.dim_plant',
    keys: [{ col: 'plant', key: 'plant', label: 'Plant', kind: 'text' }],
    fields: [
      { col: 'plant_name', key: 'plantName', label: 'Name', kind: 'text', effect: 'label' },
      { col: 'company_code', key: 'companyCode', label: 'Company', kind: 'text', effect: 'label', required: true },
      { col: 'area', key: 'area', label: 'Area', kind: 'text', effect: 'mart' },
    ],
    readOnly: [{ key: 'firstSeen', reason: SEEN }, { key: 'lastSeen', reason: SEEN }],
    allowAdd: true,
    allowDelete: true,
    note: 'Area groups plants on the Executive Summary, and is otherwise reset from the built-in area map at every sync.',
  },
  {
    relation: 'core.dim_company',
    keys: [{ col: 'company_code', key: 'companyCode', label: 'Company', kind: 'text' }],
    fields: [
      { col: 'short_code', key: 'shortCode', label: 'Short', kind: 'text', effect: 'label', required: true },
      { col: 'legal_name', key: 'legalName', label: 'Legal name', kind: 'text', effect: 'label', required: true },
    ],
    readOnly: [],
    allowAdd: true,
    allowDelete: true,
    note: 'Not refreshed by the sync; edits here are simply kept.',
  },
  {
    relation: 'core.dim_material',
    keys: [{ col: 'material_code', key: 'materialCode', label: 'Material', kind: 'text' }],
    fields: [
      { col: 'description', key: 'description', label: 'Description', kind: 'text', effect: 'label' },
      { col: 'material_group', key: 'materialGroup', label: 'Group', kind: 'text', effect: 'label' },
      { col: 'base_uom', key: 'baseUom', label: 'UOM', kind: 'text', effect: 'label' },
    ],
    readOnly: [
      { key: 'category', reason: 'Resolved from the material master and the spend-category mapping - edit the category on the Material master page.' },
      { key: 'categoryVia', reason: 'Which rule the category was resolved by.' },
      { key: 'firstSeen', reason: SEEN },
      { key: 'lastSeen', reason: SEEN },
    ],
    allowAdd: true,
    allowDelete: true,
    note: 'Descriptions and groups are refreshed by every SAP sync; edited values are kept.',
  },
  {
    relation: 'core.dim_material_group',
    keys: [{ col: 'material_group', key: 'materialGroup', label: 'Group', kind: 'text' }],
    fields: [
      { col: 'description', key: 'description', label: 'Description', kind: 'text', effect: 'label' },
      { col: 'category', key: 'category', label: 'Category', kind: 'text', effect: 'recompute' },
    ],
    readOnly: [],
    allowAdd: true,
    allowDelete: true,
    note: 'Category here is the LEGACY material category; the Executive Summary\'s spend category comes from the material master.',
  },
  {
    relation: 'core.dim_doc_type',
    keys: [{ col: 'doc_type', key: 'docType', label: 'Doc type', kind: 'text' }],
    fields: [{ col: 'description', key: 'description', label: 'Description', kind: 'text', effect: 'label' }],
    readOnly: [{
      key: 'isSto',
      reason: 'Decided by the STO rule (the document-type suffix) and written here FROM the facts. '
        + 'Editing it would change no figure - change the rule under Admin instead.',
    }],
    allowAdd: true,
    allowDelete: true,
    insertDefaults: { is_sto: false },
    note: 'The stock-transfer flag is a rule\'s output, so only the description is editable.',
  },
  {
    relation: 'core.dim_movement_type',
    keys: [{ col: 'movement_type', key: 'movementType', label: 'Movement', kind: 'text' }],
    fields: [{ col: 'description', key: 'description', label: 'Description', kind: 'text', effect: 'label', required: true }],
    readOnly: [
      { key: 'class', reason: 'Goods-receipt quantities are computed by movement rules in code; this table documents them.' },
      { key: 'signFactor', reason: 'As above - editing the documented sign would not change a receipt.' },
      { key: 'countsAsReceipt', reason: 'As above.' },
    ],
    allowAdd: false,
    allowDelete: false,
    note: 'A fixed code list. Only the wording can change.',
  },
  {
    relation: 'core.dim_sap_user',
    keys: [
      { col: 'client', key: 'client', label: 'Client', kind: 'text' },
      { col: 'user_id', key: 'userId', label: 'User id', kind: 'text' },
    ],
    fields: [
      { col: 'first_name', key: 'firstName', label: 'First name', kind: 'text', effect: 'label' },
      { col: 'last_name', key: 'lastName', label: 'Last name', kind: 'text', effect: 'label' },
      { col: 'display_name', key: 'displayName', label: 'Display name', kind: 'text', effect: 'label', required: true },
    ],
    readOnly: [
      { key: 'purchOrgs', reason: 'Assigned from the user-to-organization feed.' },
      { key: 'hoUnit', reason: 'Assigned from the user-to-organization feed.' },
    ],
    allowAdd: true,
    allowDelete: true,
    note: 'Names are refreshed by every SAP sync; edited ones are kept.',
  },
];

const SPEC_BY_RELATION = new Map(EDIT_SPECS.map((s) => [s.relation, s]));

export function editSpecFor(relation: string): EditSpec | undefined {
  return SPEC_BY_RELATION.get(relation);
}

export class EditError extends Error {}

/** A column or table name from the registry, checked, never from a request. */
function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_.]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name.split('.').map((p) => `"${p}"`).join('.');
}

/** Coerce one submitted value to its column's type, or refuse it. */
function coerce(kind: FieldKind, raw: unknown, label: string, required: boolean): unknown {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) throw new EditError(`${label} is required`);
    return null;
  }
  switch (kind) {
    case 'text':
      return String(raw).trim();
    case 'bool': {
      const s = String(raw).toLowerCase();
      if (['true', 'yes', '1'].includes(s)) return true;
      if (['false', 'no', '0'].includes(s)) return false;
      throw new EditError(`${label} must be yes or no`);
    }
    case 'int': {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new EditError(`${label} must be a whole number`);
      return n;
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw new EditError(`${label} must be a positive number`);
      return n;
    }
  }
}

/** The row key, coerced, from display-keyed input. Keys are always required. */
function readKey(spec: EditSpec, input: Record<string, unknown>): Record<string, unknown> {
  const key: Record<string, unknown> = {};
  for (const k of spec.keys) key[k.col] = coerce(k.kind, input[k.key], k.label, true);
  if (spec.fx) {
    const m = Number(key['period_month']);
    if (m < 1 || m > 12) throw new EditError('Month must be 1 to 12');
    key['currency_code'] = String(key['currency_code']).toUpperCase();
  }
  return key;
}

/** Only the fields the request actually carries, so an edit can touch one column. */
function readVals(spec: EditSpec, input: Record<string, unknown>, adding: boolean): Record<string, unknown> {
  const vals: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (!adding && !(f.key in input)) continue;
    vals[f.col] = coerce(f.kind, input[f.key], f.label, f.required === true);
  }
  if (Object.keys(vals).length === 0) throw new EditError('nothing to change');
  return vals;
}

function keyWhere(spec: EditSpec, key: Record<string, unknown>, params: unknown[]): string {
  return spec.keys.map((k) => {
    params.push(key[k.col]);
    return `${ident(k.col)} = $${params.length}`;
  }).join(' AND ');
}

async function readRow(
  c: pg.PoolClient, spec: EditSpec, key: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const params: unknown[] = [];
  const r = await c.query<Record<string, unknown>>(
    `SELECT * FROM ${ident(spec.relation)} WHERE ${keyWhere(spec, key, params)}`, params,
  );
  return r.rows[0] ?? null;
}

/** INSERT ... ON CONFLICT DO UPDATE, from a full column map. */
async function upsertRow(
  c: pg.PoolClient, spec: EditSpec, row: Record<string, unknown>, updateCols: string[],
): Promise<void> {
  const cols = Object.keys(row);
  const params = cols.map((col) => row[col]);
  const keyCols = spec.keys.map((k) => ident(k.col)).join(', ');
  const set = updateCols.length > 0
    ? `DO UPDATE SET ${updateCols.map((col) => `${ident(col)} = EXCLUDED.${ident(col)}`).join(', ')}`
    : 'DO NOTHING';
  await c.query(
    `INSERT INTO ${ident(spec.relation)} (${cols.map(ident).join(', ')})
     VALUES (${cols.map((_c, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (${keyCols}) ${set}`,
    params,
  );
}

async function deleteRow(c: pg.PoolClient, spec: EditSpec, key: Record<string, unknown>): Promise<void> {
  const params: unknown[] = [];
  await c.query(`DELETE FROM ${ident(spec.relation)} WHERE ${keyWhere(spec, key, params)}`, params);
}

interface OverrideRow {
  id: number; relation: string; row_key: Record<string, unknown>; action: 'upsert' | 'delete';
  vals: Record<string, unknown>; original: Record<string, unknown> | null; admin_added: boolean;
}

async function findOverride(
  c: pg.PoolClient, relation: string, key: Record<string, unknown>,
): Promise<OverrideRow | null> {
  const r = await c.query<OverrideRow>(
    `SELECT id, relation, row_key, action, vals, original, admin_added
       FROM app.master_override WHERE relation = $1 AND row_key = $2::jsonb`,
    [relation, JSON.stringify(key)],
  );
  return r.rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────── the actions

/** Add a row that SAP does not have. */
export async function addRow(relation: string, input: Record<string, unknown>, actor: string): Promise<void> {
  const spec = requireSpec(relation);
  if (!spec.allowAdd) throw new EditError('rows cannot be added to this table');
  const key = readKey(spec, input);
  const vals = readVals(spec, input, true);
  await transaction(async (c) => {
    if (spec.fx) {
      if (await findOverride(c, relation, key)) throw new EditError('a manual rate already exists for that currency and month - edit it instead');
    } else if (await readRow(c, spec, key)) {
      throw new EditError('that code already exists - edit it instead');
    }
    await c.query(
      `INSERT INTO app.master_override (relation, row_key, action, vals, admin_added, created_by, updated_by)
       VALUES ($1, $2::jsonb, 'upsert', $3::jsonb, true, $4, $4)`,
      [relation, JSON.stringify(key), JSON.stringify(vals), actor],
    );
    if (!spec.fx) {
      await upsertRow(c, spec, { ...spec.insertDefaults, ...vals, ...key }, Object.keys(vals));
    }
  });
}

/** Change fields on an existing row. The first edit snapshots the SAP row. */
export async function editRow(relation: string, input: Record<string, unknown>, actor: string): Promise<void> {
  const spec = requireSpec(relation);
  const key = readKey(spec, input);
  const vals = readVals(spec, input, false);
  await transaction(async (c) => {
    const existing = await findOverride(c, relation, key);
    if (existing?.action === 'delete') throw new EditError('that row is hidden - restore it first');
    if (existing) {
      await c.query(
        `UPDATE app.master_override SET vals = vals || $2::jsonb, updated_by = $3, updated_at = now() WHERE id = $1`,
        [existing.id, JSON.stringify(vals), actor],
      );
    } else {
      const original = spec.fx ? null : await readRow(c, spec, key);
      if (!spec.fx && !original) throw new EditError('no such row');
      await c.query(
        `INSERT INTO app.master_override (relation, row_key, action, vals, original, created_by, updated_by)
         VALUES ($1, $2::jsonb, 'upsert', $3::jsonb, $4::jsonb, $5, $5)`,
        [relation, JSON.stringify(key), JSON.stringify(vals), original ? JSON.stringify(original) : null, actor],
      );
    }
    if (!spec.fx) await upsertRow(c, spec, { ...spec.insertDefaults, ...vals, ...key }, Object.keys(vals));
  });
}

/**
 * Hide a row. An administrator's own row is removed outright - there is no SAP
 * version to protect. A SAP row becomes a tombstone the sync respects, holding
 * the whole row so a restore can put it back exactly.
 */
export async function hideRow(relation: string, input: Record<string, unknown>, actor: string): Promise<void> {
  const spec = requireSpec(relation);
  if (!spec.allowDelete) throw new EditError('rows cannot be deleted from this table');
  const key = readKey(spec, input);
  await transaction(async (c) => {
    const existing = await findOverride(c, relation, key);
    if (existing?.admin_added) {
      await c.query(`DELETE FROM app.master_override WHERE id = $1`, [existing.id]);
      await deleteRow(c, spec, key);
      return;
    }
    const current = await readRow(c, spec, key);
    if (!current && !existing) throw new EditError('no such row');
    // The snapshot is the row BEFORE any override, so a restore undoes the
    // edits too rather than resurrecting the edited version.
    const original = existing?.original ?? current;
    if (existing) {
      await c.query(
        `UPDATE app.master_override SET action = 'delete', vals = '{}'::jsonb, original = $2::jsonb,
                updated_by = $3, updated_at = now() WHERE id = $1`,
        [existing.id, JSON.stringify(original), actor],
      );
    } else {
      await c.query(
        `INSERT INTO app.master_override (relation, row_key, action, original, created_by, updated_by)
         VALUES ($1, $2::jsonb, 'delete', $3::jsonb, $4, $4)`,
        [relation, JSON.stringify(key), JSON.stringify(original), actor],
      );
    }
    await deleteRow(c, spec, key);
  });
}

/**
 * Undo an override: an edit goes back to the SAP values it replaced, a hidden
 * row comes back as it was. An FX override simply stops applying from the next
 * recompute.
 */
export async function revertRow(relation: string, input: Record<string, unknown>, actor: string): Promise<void> {
  const spec = requireSpec(relation);
  const key = readKey(spec, input);
  await transaction(async (c) => {
    const existing = await findOverride(c, relation, key);
    if (!existing) throw new EditError('nothing to revert - this row has no override');
    await c.query(`DELETE FROM app.master_override WHERE id = $1`, [existing.id]);
    if (spec.fx) return;
    if (existing.admin_added) {
      await deleteRow(c, spec, key);
    } else if (existing.original) {
      await upsertRow(c, spec, existing.original, Object.keys(existing.original).filter(
        (col) => !spec.keys.some((k) => k.col === col),
      ));
    }
    void actor;
  });
}

function requireSpec(relation: string): EditSpec {
  const spec = SPEC_BY_RELATION.get(relation);
  if (!spec) throw new EditError(`${relation} is not editable`);
  return spec;
}

// ─────────────────────────────────────────────────── applied by the sync

/**
 * Re-impose every dimension override. Called by the transform right after it
 * writes SAP's values, so the SAP value never wins over an edit.
 *
 * Each override runs in its own SAVEPOINT. One bad override - a column since
 * renamed, a value that no longer fits - must cost that one edit, logged, and
 * never the whole sync: a failed transform leaves every page on yesterday's
 * data, which is a far worse outcome than one name reverting.
 */
export async function applyDimOverrides(c: pg.PoolClient): Promise<{ applied: number; failed: number }> {
  const r = await c.query<OverrideRow>(
    `SELECT id, relation, row_key, action, vals, original, admin_added
       FROM app.master_override WHERE relation <> 'core.fx_rate' ORDER BY id`,
  );
  let applied = 0;
  let failed = 0;
  for (const o of r.rows) {
    const spec = SPEC_BY_RELATION.get(o.relation);
    if (!spec) { failed += 1; continue; }
    await c.query('SAVEPOINT master_override');
    try {
      if (o.action === 'delete') {
        await deleteRow(c, spec, o.row_key);
      } else {
        const base = { ...spec.insertDefaults, ...(o.original ?? {}), ...o.vals, ...o.row_key };
        await upsertRow(c, spec, base, Object.keys(o.vals));
      }
      await c.query('RELEASE SAVEPOINT master_override');
      applied += 1;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT master_override');
      failed += 1;
      console.warn(`master override ${o.id} (${o.relation}) not applied:`, e instanceof Error ? e.message : e);
    }
  }
  return { applied, failed };
}

/**
 * FX overrides, applied to the transform's rate table as it is built. A manual
 * rate REPLACES whatever SAP or Coupa supplied for that currency and month, and
 * is marked 'manual' so the Admin FX table can show where it came from.
 */
export async function applyFxOverrides(rates: FxRate[]): Promise<FxRate[]> {
  const rows = await query<{ row_key: Record<string, unknown>; vals: Record<string, unknown>; updated_at: string }>(
    `SELECT row_key, vals, updated_at::text FROM app.master_override
      WHERE relation = 'core.fx_rate' AND action = 'upsert'`,
  );
  if (rows.length === 0) return rates;
  const out = new Map(rates.map((r) => [`${r.currency}|${r.year}|${r.month}`, r]));
  for (const o of rows) {
    const currency = String(o.row_key['currency_code']);
    const year = Number(o.row_key['period_year']);
    const month = Number(o.row_key['period_month']);
    const usd = Number(o.vals['usd_per_unit']);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    out.set(`${currency}|${year}|${month}`, {
      currency, year, month, usdPerUnit: usd, derivation: 'direct', pivotCurrency: null,
      source: 'manual', sourceUpdatedAt: o.updated_at,
    });
  }
  return [...out.values()];
}

// ──────────────────────────────────────────────── what the page is told

export interface RowMark { key: Record<string, unknown>; state: 'edited' | 'added' | 'hidden'; by: string; at: string }

/**
 * Every override on a relation, keyed the way the page keys its rows, so the
 * page can badge edited and added rows and list the hidden ones for restore.
 */
export async function overridesFor(relation: string): Promise<RowMark[]> {
  const spec = SPEC_BY_RELATION.get(relation);
  if (!spec) return [];
  const rows = await query<{ row_key: Record<string, unknown>; action: string; admin_added: boolean;
    updated_by: string; updated_at: string; original: Record<string, unknown> | null; vals: Record<string, unknown> }>(
    `SELECT row_key, action, admin_added, updated_by, updated_at::text, original, vals
       FROM app.master_override WHERE relation = $1 ORDER BY updated_at DESC`,
    [relation],
  );
  return rows.map((o) => {
    // Display keys, so the page can match a mark to a row without knowing
    // the database's column names.
    const key: Record<string, unknown> = {};
    for (const k of spec.keys) key[k.key] = o.row_key[k.col];
    return {
      key,
      state: o.action === 'delete' ? 'hidden' : o.admin_added ? 'added' : 'edited',
      by: o.updated_by,
      at: o.updated_at,
    };
  });
}

/** The count of FX overrides waiting for a recompute, for the FX page's banner. */
export async function pendingFxOverrides(): Promise<number> {
  const r = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.master_override WHERE relation = 'core.fx_rate'`,
  );
  return r?.n ?? 0;
}
