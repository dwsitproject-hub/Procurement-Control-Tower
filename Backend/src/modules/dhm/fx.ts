/**
 * Exchange rates from Data Hub Management (040, 23 Oct 2026).
 *
 * One run:
 *   1. reads the master's contract, GET /v1/catalog/{entity}, and resolves
 *      which fields are the from currency, to currency, rate and date. The
 *      field names are NOT hard-coded: DHM owns them, and a run that cannot map
 *      them unambiguously stops and says which fields it saw, rather than
 *      loading numbers into the wrong columns;
 *   2. pulls records with GET /v1/sync/{entity} - a full snapshot the first
 *      time, then from the saved cursor - including tombstones, so a rate
 *      deleted in DHM leaves PCT too (guide §6, §9a);
 *   3. rebuilds the 'dhm' slots of ops.fx_rate_source: per pair and month, the
 *      rate with the latest date in that month. A DHM rate always replaces a
 *      Coupa one (DHM replaced Coupa as a source); against the SAP rate file
 *      the most recently updated wins, as it always has.
 *
 * Like every rate in that store, a change reaches the figures at the next
 * recompute (the transform builds core.fx_rate from it); a published version's
 * rates never change.
 */

import { pool, query, queryOne } from '../../db/client.js';
import { loadEnv } from '../../config/env.js';
import { DhmError, dhmConfigured, dhmGet, dhmHost } from './client.js';

const env = loadEnv();
const ADVISORY_LOCK_KEY = 0xd4f0e; // "dhm fx sync"
const PAGE_LIMIT = 500;
/** A run stops after this many pages and resumes from the cursor next time. */
const MAX_PAGES = 400;

interface CatalogField {
  key: string;
  name?: string;
  dataType: string;
  referenceSlug?: string;
}
interface CatalogEntity {
  slug: string;
  fields: CatalogField[];
}
interface SyncRecord {
  id: string;
  version: number;
  isDeleted: boolean;
  data: Record<string, unknown>;
  updatedAt: string;
}
interface SyncPage {
  hasMore: boolean;
  nextCursor: string | null;
  records: SyncRecord[];
}

/** Which DHM field holds each thing PCT needs. */
export interface FxMapping {
  from: string;
  to: string;
  rate: string;
  /** A DATE field, or a year + month pair of NUMBER fields. */
  date?: string;
  year?: string;
  month?: string;
  /** Quantity factors ("100 JPY = x IDR"), when the master carries them. */
  fromFactor?: string;
  toFactor?: string;
  /** Currency fields that REFERENCE another master, by field key -> slug. */
  refs: Record<string, string>;
  /** Fields seen but not used - shown on the Admin page. */
  unused: string[];
}

export class MappingError extends Error {}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');

/** Match each role to exactly one field, or explain why not. */
export function resolveMapping(entity: CatalogEntity): FxMapping {
  const fields = entity.fields.filter((f) => f.key !== 'code' && f.key !== 'is_active');
  const seen = fields.map((f) => `${f.key} (${f.dataType})`).join(', ');
  const k = (f: CatalogField) => norm(f.key);
  const isCcyType = (f: CatalogField) => f.dataType === 'STRING' || f.dataType === 'REFERENCE' || f.dataType === 'ENUM';
  const ccy = /(curr|ccy|currency)/;

  const pick = (role: string, cands: CatalogField[], prefer: string[] = []): CatalogField => {
    if (cands.length === 1) return cands[0]!;
    for (const p of prefer) {
      const hit = cands.filter((f) => k(f) === p);
      if (hit.length === 1) return hit[0]!;
    }
    throw new MappingError(
      cands.length === 0
        ? `No ${role} field in the '${entity.slug}' master. Fields seen: ${seen}`
        : `More than one possible ${role} field (${cands.map((f) => f.key).join(', ')}) in '${entity.slug}'. Fields seen: ${seen}`,
    );
  };

  const from = pick('from-currency', fields.filter((f) => isCcyType(f)
    && /(^|_)(from|source|base|src)(_|$)/.test(k(f)) && (ccy.test(k(f)) || /^from$/.test(k(f)))),
  ['from_currency', 'currency_from', 'from_ccy']);
  const to = pick('to-currency', fields.filter((f) => isCcyType(f)
    && /(^|_)(to|target|quote|dest)(_|$)/.test(k(f)) && (ccy.test(k(f)) || /^to$/.test(k(f)))),
  ['to_currency', 'currency_to', 'to_ccy']);

  const numbers = fields.filter((f) => f.dataType === 'NUMBER');
  const factorRe = /(factor|ratio|unit|per|qty|quantity)/;
  const rate = pick('rate', numbers.filter((f) => /(rate|kurs|value)/.test(k(f)) && !factorRe.test(k(f))),
    ['rate', 'exchange_rate', 'fx_rate', 'rate_value']);

  const m: FxMapping = { from: from.key, to: to.key, rate: rate.key, refs: {}, unused: [] };
  const dates = fields.filter((f) => f.dataType === 'DATE');
  if (dates.length > 0) {
    m.date = pick('date', dates.length === 1 ? dates
      : dates.filter((f) => /(rate_date|valid_from|effective|^date$|valid_date|start)/.test(k(f))),
    ['rate_date', 'valid_from', 'effective_date', 'effective_from', 'date']).key;
  } else {
    const y = numbers.filter((f) => /(^|_)year(_|$)/.test(k(f)));
    const mo = numbers.filter((f) => /(^|_)month(_|$)/.test(k(f)));
    if (y.length === 1 && mo.length === 1) {
      m.year = y[0]!.key;
      m.month = mo[0]!.key;
    } else {
      throw new MappingError(`No date field (DATE, or a year and a month) in '${entity.slug}'. Fields seen: ${seen}`);
    }
  }
  const ff = numbers.filter((f) => factorRe.test(k(f)) && /(^|_)(from|source|base)(_|$)/.test(k(f)));
  const tf = numbers.filter((f) => factorRe.test(k(f)) && /(^|_)(to|target|quote)(_|$)/.test(k(f)));
  if (ff.length === 1) m.fromFactor = ff[0]!.key;
  if (tf.length === 1) m.toFactor = tf[0]!.key;
  for (const f of [from, to]) {
    if (f.dataType === 'REFERENCE') {
      if (!f.referenceSlug) throw new MappingError(`'${f.key}' is a reference with no target master`);
      m.refs[f.key] = f.referenceSlug;
    }
  }
  const used = new Set([m.from, m.to, m.rate, m.date, m.year, m.month, m.fromFactor, m.toFactor]);
  m.unused = fields.map((f) => f.key).filter((x) => !used.has(x));
  return m;
}

/**
 * A referenced currency master: record id -> ISO code. The ISO code is the
 * field whose values are three capital letters (DHM's own `code` is
 * CUR-NNNN-style, so it is never that).
 */
async function loadRefCodes(slug: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor: string | null = null;
  for (let p = 0; p < MAX_PAGES; p += 1) {
    const page: SyncPage = await dhmGet<SyncPage>(
      `/v1/sync/${encodeURIComponent(slug)}?limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    for (const r of page.records) {
      const iso = Object.values(r.data).find((v) => typeof v === 'string' && /^[A-Z]{3}$/.test(v.trim()));
      if (typeof iso === 'string') {
        out.set(r.id, iso.trim());
        if (typeof r.data['code'] === 'string') out.set(r.data['code'], iso.trim());
      }
    }
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

/** JSON with object keys sorted, so two equal mappings compare equal. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

interface Row {
  id: string; code: string | null; version: number; isDeleted: boolean;
  from: string | null; to: string | null; rate: number | null; date: string | null;
  data: string; updatedAt: string;
}

function toRow(r: SyncRecord, m: FxMapping, refs: Map<string, Map<string, string>>): Row {
  const d = r.data ?? {};
  const ccy = (key: string): string | null => {
    const v = d[key];
    if (v === null || v === undefined || v === '') return null;
    const s = String(v).trim();
    const viaRef = m.refs[key] ? refs.get(key)?.get(s) : undefined;
    const c = (viaRef ?? s).toUpperCase();
    return /^[A-Z]{3}$/.test(c) ? c : null;
  };
  const num = (key: string | undefined): number | null => {
    if (!key) return null;
    const x = Number(d[key]);
    return Number.isFinite(x) ? x : null;
  };
  let rate = num(m.rate);
  // "100 JPY = x IDR": a quantity factor turns it into a per-unit rate.
  const ff = num(m.fromFactor);
  const tf = num(m.toFactor);
  if (rate !== null && ff !== null && ff > 0) rate /= ff;
  if (rate !== null && tf !== null && tf > 0) rate *= tf;
  let date: string | null = null;
  if (m.date) {
    const s = d[m.date];
    date = typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  } else {
    const y = num(m.year);
    const mo = num(m.month);
    if (y !== null && mo !== null && mo >= 1 && mo <= 12) date = `${y}-${String(mo).padStart(2, '0')}-01`;
  }
  return {
    id: r.id,
    code: typeof d['code'] === 'string' ? d['code'] : null,
    version: r.version,
    isDeleted: r.isDeleted,
    from: ccy(m.from),
    to: ccy(m.to),
    rate: rate !== null && rate > 0 ? rate : null,
    date,
    data: JSON.stringify(d),
    updatedAt: r.updatedAt,
  };
}

async function storeRows(rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  await query(
    `INSERT INTO ops.dhm_exchange_rate
       (id, code, version, is_deleted, from_currency, to_currency, rate, rate_date, data, dhm_updated_at, fetched_at)
     SELECT id, code, version, is_deleted, fc, tc, rate, rd, data::jsonb, upd, now()
       FROM unnest($1::uuid[], $2::text[], $3::int[], $4::bool[], $5::text[], $6::text[],
                   $7::numeric[], $8::date[], $9::text[], $10::timestamptz[])
            AS t(id, code, version, is_deleted, fc, tc, rate, rd, data, upd)
     ON CONFLICT (id) DO UPDATE SET
       code = EXCLUDED.code, version = EXCLUDED.version, is_deleted = EXCLUDED.is_deleted,
       from_currency = EXCLUDED.from_currency, to_currency = EXCLUDED.to_currency,
       rate = EXCLUDED.rate, rate_date = EXCLUDED.rate_date, data = EXCLUDED.data,
       dhm_updated_at = EXCLUDED.dhm_updated_at, fetched_at = now()
     -- A page re-read after a resume must not put an older version back.
     WHERE EXCLUDED.version >= dhm_exchange_rate.version`,
    [
      rows.map((r) => r.id), rows.map((r) => r.code), rows.map((r) => r.version),
      rows.map((r) => r.isDeleted), rows.map((r) => r.from), rows.map((r) => r.to),
      rows.map((r) => r.rate), rows.map((r) => r.date), rows.map((r) => r.data),
      rows.map((r) => r.updatedAt),
    ],
  );
}

/**
 * The 'dhm' slots of the FX store, rebuilt from every live DHM rate. Returns
 * the slots written and the 'dhm' slots removed because their rate was deleted
 * in DHM (the next SAP load refills a month the rate file covers).
 */
async function project(): Promise<{ written: number; removed: number }> {
  const best = `
    SELECT DISTINCT ON (from_currency, to_currency, date_part('year', rate_date), date_part('month', rate_date))
           from_currency, to_currency,
           date_part('year', rate_date)::int AS y, date_part('month', rate_date)::smallint AS m,
           rate, dhm_updated_at
      FROM ops.dhm_exchange_rate
     WHERE NOT is_deleted AND rate > 0 AND rate_date IS NOT NULL
       AND from_currency IS NOT NULL AND to_currency IS NOT NULL AND from_currency <> to_currency
     ORDER BY from_currency, to_currency, date_part('year', rate_date), date_part('month', rate_date),
              rate_date DESC, dhm_updated_at DESC`;
  const written = await query<{ n: number }>(
    `WITH b AS (${best}),
     ins AS (
       INSERT INTO ops.fx_rate_source
         (from_currency, to_currency, period_year, period_month, rate, source, source_updated_at)
       SELECT from_currency, to_currency, y, m, rate, 'dhm', dhm_updated_at FROM b
       ON CONFLICT (from_currency, to_currency, period_year, period_month)
       DO UPDATE SET rate = EXCLUDED.rate, source = 'dhm',
                     source_updated_at = EXCLUDED.source_updated_at, updated_at = now()
        WHERE fx_rate_source.source IN ('dhm', 'coupa')
           OR fx_rate_source.source_updated_at IS NULL
           OR EXCLUDED.source_updated_at > fx_rate_source.source_updated_at
       RETURNING 1)
     SELECT count(*)::int AS n FROM ins`,
  );
  const removed = await query<{ n: number }>(
    `WITH b AS (${best}),
     del AS (
       DELETE FROM ops.fx_rate_source s
        WHERE s.source = 'dhm'
          AND NOT EXISTS (SELECT 1 FROM b WHERE b.from_currency = s.from_currency
                            AND b.to_currency = s.to_currency AND b.y = s.period_year AND b.m = s.period_month)
       RETURNING 1)
     SELECT count(*)::int AS n FROM del`,
  );
  return { written: written[0]?.n ?? 0, removed: removed[0]?.n ?? 0 };
}

export interface DhmFxResult {
  outcome: 'ok' | 'error' | 'locked' | 'not_configured';
  trigger: 'scheduled' | 'manual';
  startedAt: string;
  pages: number;
  records: number;
  /** Records whose currencies, rate or date could not be read. */
  unusable: number;
  slotsWritten: number;
  slotsRemoved: number;
  /** Stopped at MAX_PAGES; the next run carries on from the cursor. */
  more: boolean;
  error?: string;
}

let inFlight = false;
export function dhmFxSyncInFlight(): boolean {
  return inFlight;
}

export async function runDhmFxSync(trigger: 'scheduled' | 'manual'): Promise<DhmFxResult> {
  const startedAt = new Date().toISOString();
  const res: DhmFxResult = {
    outcome: 'ok', trigger, startedAt, pages: 0, records: 0, unusable: 0,
    slotsWritten: 0, slotsRemoved: 0, more: false,
  };
  if (!dhmConfigured()) return { ...res, outcome: 'not_configured' };
  const entity = env.DHM_FX_ENTITY;

  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [ADVISORY_LOCK_KEY]);
    if (!lock.rows[0]?.ok) return { ...res, outcome: 'locked' };
    inFlight = true;
    try {
      const catalog = await dhmGet<CatalogEntity>(`/v1/catalog/${encodeURIComponent(entity)}`);
      const mapping = resolveMapping(catalog);
      const refs = new Map<string, Map<string, string>>();
      for (const [key, slug] of Object.entries(mapping.refs)) refs.set(key, await loadRefCodes(slug));

      const state = await queryOne<{ cursor: string | null; last_updated_at: string | null; mapping: FxMapping | null }>(
        `SELECT cursor, last_updated_at::text, mapping FROM ops.dhm_sync_state WHERE entity = $1`, [entity],
      );
      // A different mapping means every stored row was read with the old one:
      // start again from a full snapshot.
      // Compared key-order-independently: jsonb hands keys back reordered.
      const same = state?.mapping != null && canon({ ...state.mapping, unused: [] }) === canon({ ...mapping, unused: [] });
      let cursor = same ? state?.cursor ?? null : null;
      const since = same && !cursor ? state?.last_updated_at ?? null : null;
      let maxUpdated = same ? state?.last_updated_at ?? null : null;

      for (;;) {
        const qs = new URLSearchParams({ limit: String(PAGE_LIMIT), includeDeleted: 'true' });
        if (cursor) qs.set('cursor', cursor);
        else if (since) qs.set('updatedSince', new Date(since).toISOString());
        const page = await dhmGet<SyncPage>(`/v1/sync/${encodeURIComponent(entity)}?${qs.toString()}`);
        const rows = page.records.map((r) => toRow(r, mapping, refs));
        await storeRows(rows);
        res.pages += 1;
        res.records += rows.length;
        res.unusable += rows.filter((r) => !r.isDeleted && (!r.from || !r.to || r.rate === null || !r.date)).length;
        for (const r of rows) if (!maxUpdated || r.updatedAt > maxUpdated) maxUpdated = r.updatedAt;
        // The cursor is saved after every page, so a failure resumes here.
        if (page.nextCursor) cursor = page.nextCursor;
        await saveState(entity, { cursor, maxUpdated, mapping });
        if (!page.hasMore) break;
        if (res.pages >= MAX_PAGES) { res.more = true; break; }
      }

      const p = await project();
      res.slotsWritten = p.written;
      res.slotsRemoved = p.removed;
      await query(
        `UPDATE ops.dhm_sync_state SET last_run_at = now(), last_status = 'ok', last_error = NULL,
                last_trigger = $2, records_seen = records_seen + $3, runs = runs + 1
          WHERE entity = $1`,
        [entity, trigger, res.records],
      );
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await query(
        `INSERT INTO ops.dhm_sync_state (entity, last_run_at, last_status, last_error, last_trigger, runs)
         VALUES ($1, now(), 'error', $2, $3, 1)
         ON CONFLICT (entity) DO UPDATE SET last_run_at = now(), last_status = 'error',
           last_error = EXCLUDED.last_error, last_trigger = EXCLUDED.last_trigger,
           runs = ops.dhm_sync_state.runs + 1`,
        [entity, msg.slice(0, 1000), trigger],
      );
      return { ...res, outcome: 'error', error: msg };
    }
  } finally {
    inFlight = false;
    await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

async function saveState(
  entity: string, s: { cursor: string | null; maxUpdated: string | null; mapping: FxMapping },
): Promise<void> {
  await query(
    `INSERT INTO ops.dhm_sync_state (entity, cursor, last_updated_at, mapping)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (entity) DO UPDATE SET cursor = EXCLUDED.cursor,
       last_updated_at = EXCLUDED.last_updated_at, mapping = EXCLUDED.mapping`,
    [entity, s.cursor, s.maxUpdated, JSON.stringify(s.mapping)],
  );
}

/** What the Admin FX page shows about the Data Hub source. */
export async function dhmFxStatus(): Promise<Record<string, unknown>> {
  const entity = env.DHM_FX_ENTITY;
  const state = await queryOne<Record<string, unknown>>(
    `SELECT last_run_at, last_status, last_error, last_trigger, records_seen, runs, mapping,
            last_updated_at, cursor IS NOT NULL AS has_cursor
       FROM ops.dhm_sync_state WHERE entity = $1`,
    [entity],
  );
  const counts = await queryOne<{ total: number; live: number; usable: number; deleted: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE NOT is_deleted)::int AS live,
            count(*) FILTER (WHERE NOT is_deleted AND rate > 0 AND rate_date IS NOT NULL
                               AND from_currency IS NOT NULL AND to_currency IS NOT NULL)::int AS usable,
            count(*) FILTER (WHERE is_deleted)::int AS deleted
       FROM ops.dhm_exchange_rate`,
  );
  const bySource = await query<{ source: string; n: number }>(
    `SELECT source, count(*)::int AS n FROM ops.fx_rate_source GROUP BY 1 ORDER BY 1`,
  );
  return {
    configured: dhmConfigured(),
    host: dhmHost(),
    entity,
    intervalMinutes: env.DHM_FX_SYNC_MINUTES,
    inFlight,
    state,
    records: counts,
    storeBySource: Object.fromEntries(bySource.map((r) => [r.source, r.n])),
  };
}

let pollerStarted = false;
let lastRunAt = 0;

/** Checks every minute whether a run is due (DHM_FX_SYNC_MINUTES apart). */
export function startDhmFxPoller(log: (msg: string) => void): void {
  if (pollerStarted || !dhmConfigured()) return;
  pollerStarted = true;
  setInterval(() => {
    void (async () => {
      if (Date.now() - lastRunAt < env.DHM_FX_SYNC_MINUTES * 60_000) return;
      lastRunAt = Date.now();
      try {
        const r = await runDhmFxSync('scheduled');
        log(`dhm fx sync (${r.outcome}): ${r.records} records, ${r.slotsWritten} rates written, ${r.slotsRemoved} removed${r.error ? ` - ${r.error}` : ''}`);
      } catch (e) {
        log(`dhm fx poller error: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, 60_000).unref();
}

export { DhmError };
