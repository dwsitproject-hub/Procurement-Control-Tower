/**
 * Plant master from Data Hub Management (26 Nov 2026).
 *
 * Once a day (DHM_PLANT_SYNC_HOURS) the plant master is read from the Data Hub
 * and becomes the plant names PCT shows - "EU71 - <name>" wherever a plant code
 * appears. Until 26 Nov 2026 the names were a seeded reference list, and a plant
 * missing from it showed its code twice.
 *
 * One run:
 *   1. reads the master's contract, GET /v1/catalog/{entity}, and resolves which
 *      fields are the plant code, the name and (optionally) the company. Field
 *      names are not hard-coded - the Data Hub owns them - and a run that cannot
 *      map them unambiguously stops and says which fields it saw;
 *   2. reads the whole master (GET /v1/sync/{entity}; plants are a few hundred
 *      records, so every run is a full snapshot and needs no cursor);
 *   3. writes core.dim_plant: the name of every plant it knows, and new plants
 *      added. A name an administrator edited in Master (app.master_override) is
 *      left alone - the edit wins - and a plant the hub deleted keeps its row,
 *      because facts still refer to it.
 *
 * The run time is kept in ops.dhm_sync_state, so a restart does not re-run it.
 */

import { pool, query, queryOne } from '../../db/client.js';
import { loadEnv } from '../../config/env.js';
import { clearResultCache } from '../analytics/cache.js';
import { trackJob } from '../ops/watchdog.js';
import { dhmConfigured, dhmGet } from './client.js';

const env = loadEnv();
const ADVISORY_LOCK_KEY = 0xd4f1a; // "dhm plant sync"
const PAGE_LIMIT = 500;
const MAX_PAGES = 100;

interface CatalogField { key: string; dataType: string; referenceSlug?: string }
interface CatalogEntity { slug: string; fields: CatalogField[] }
interface SyncRecord { id: string; isDeleted: boolean; data: Record<string, unknown> }
interface SyncPage { hasMore: boolean; nextCursor: string | null; records: SyncRecord[] }

/** Which Data Hub field holds each thing PCT needs. */
export interface PlantMapping {
  code: string;
  name: string;
  company?: string;
  /** The company field references another master (field -> slug). */
  companyRef?: string;
  unused: string[];
}

export class PlantMappingError extends Error {}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');

/** Match each role to exactly one field, or explain why not. */
export function resolvePlantMapping(entity: CatalogEntity): PlantMapping {
  const fields = entity.fields.filter((f) => f.key !== 'is_active');
  const seen = fields.map((f) => `${f.key} (${f.dataType})`).join(', ');
  const k = (f: CatalogField) => norm(f.key);
  const text = (f: CatalogField) => f.dataType === 'STRING' || f.dataType === 'ENUM';
  const pick = (role: string, cands: CatalogField[], prefer: string[]): CatalogField => {
    for (const p of prefer) {
      const hit = cands.filter((f) => k(f) === p);
      if (hit.length === 1) return hit[0]!;
    }
    if (cands.length === 1) return cands[0]!;
    throw new PlantMappingError(
      cands.length === 0
        ? `No ${role} field in the '${entity.slug}' master. Fields seen: ${seen}`
        : `More than one possible ${role} field (${cands.map((f) => f.key).join(', ')}) in '${entity.slug}'. Fields seen: ${seen}`,
    );
  };
  const code = pick('plant-code', fields.filter((f) => text(f) && /(^|_)(code|plant|werks|plant_code|plant_id)$/.test(k(f))),
    ['plant_code', 'code', 'plant', 'werks']);
  const name = pick('plant-name', fields.filter((f) => f !== code && text(f) && /(name|description|desc|text)/.test(k(f))),
    ['plant_name', 'name', 'description', 'plant_description']);
  const m: PlantMapping = { code: code.key, name: name.key, unused: [] };
  const comp = fields.filter((f) => f !== code && f !== name && /(compan|bukrs|company_code)/.test(k(f)));
  if (comp.length > 0) {
    const c = pick('company', comp, ['company_code', 'company', 'bukrs']);
    m.company = c.key;
    if (c.dataType === 'REFERENCE' && c.referenceSlug) m.companyRef = c.referenceSlug;
  }
  m.unused = fields.map((f) => f.key).filter((x) => ![m.code, m.name, m.company].includes(x));
  return m;
}

async function readAll(slug: string): Promise<SyncRecord[]> {
  const out: SyncRecord[] = [];
  let cursor: string | null = null;
  for (let p = 0; p < MAX_PAGES; p += 1) {
    const page: SyncPage = await dhmGet<SyncPage>(
      `/v1/sync/${encodeURIComponent(slug)}?limit=${PAGE_LIMIT}&includeDeleted=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    out.push(...page.records);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

export interface DhmPlantResult {
  outcome: 'ok' | 'error' | 'locked' | 'not_configured' | 'disabled';
  trigger: 'scheduled' | 'manual';
  records: number;
  plants: number;
  renamed: number;
  added: number;
  keptAdminName: number;
  error?: string;
}

let inFlight = false;
export function dhmPlantSyncInFlight(): boolean { return inFlight; }

export async function runDhmPlantSync(trigger: 'scheduled' | 'manual'): Promise<DhmPlantResult> {
  const res: DhmPlantResult = { outcome: 'ok', trigger, records: 0, plants: 0, renamed: 0, added: 0, keptAdminName: 0 };
  if (!dhmConfigured()) return { ...res, outcome: 'not_configured' };
  const entity = env.DHM_PLANT_ENTITY;
  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_LOCK_KEY]);
    if (!lock.rows[0]?.ok) return { ...res, outcome: 'locked' };
    inFlight = true;
    try {
      const catalog = await dhmGet<CatalogEntity>(`/v1/catalog/${encodeURIComponent(entity)}`);
      const mapping = resolvePlantMapping(catalog);
      // A referenced company: its record id -> code.
      const companyById = new Map<string, string>();
      if (mapping.companyRef) {
        for (const r of await readAll(mapping.companyRef)) {
          const c = str(r.data['code']) ?? str(Object.values(r.data).find((v) => typeof v === 'string'));
          if (c) companyById.set(r.id, c);
        }
      }
      const records = await readAll(entity);
      res.records = records.length;
      const codes: string[] = [];
      const names: string[] = [];
      const companies: (string | null)[] = [];
      const seen = new Set<string>();
      for (const r of records) {
        if (r.isDeleted) continue;
        const code = str(r.data[mapping.code])?.toUpperCase() ?? null;
        const name = str(r.data[mapping.name]);
        if (!code || !name || seen.has(code)) continue;
        seen.add(code);
        const rawCo = mapping.company ? str(r.data[mapping.company]) : null;
        codes.push(code);
        names.push(name);
        companies.push(rawCo === null ? null : (companyById.get(rawCo) ?? rawCo).toUpperCase());
      }
      res.plants = codes.length;

      await client.query('BEGIN');
      try {
        // A name an administrator set in Master wins over the hub's.
        const kept = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.master_override o
            WHERE o.relation = 'core.dim_plant' AND o.action <> 'delete'
              AND o.vals ? 'plant_name' AND o.row_key->>'plant' = ANY($1::text[])`,
          [codes],
        );
        res.keptAdminName = kept.rows[0]?.n ?? 0;
        const w = await client.query<{ added: boolean; renamed: boolean }>(
          `WITH src AS (
             SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) AS t(plant, plant_name, company_code)
           ), up AS (
             INSERT INTO core.dim_plant (plant, company_code, plant_name)
             SELECT s.plant, COALESCE(s.company_code, left(s.plant, 2)), s.plant_name FROM src s
             ON CONFLICT (plant) DO UPDATE
               SET plant_name = EXCLUDED.plant_name,
                   company_code = COALESCE((SELECT s2.company_code FROM src s2 WHERE s2.plant = EXCLUDED.plant), core.dim_plant.company_code)
             WHERE core.dim_plant.plant_name IS DISTINCT FROM EXCLUDED.plant_name
               AND NOT EXISTS (SELECT 1 FROM app.master_override o
                                WHERE o.relation = 'core.dim_plant' AND o.action <> 'delete'
                                  AND o.vals ? 'plant_name' AND o.row_key->>'plant' = EXCLUDED.plant)
             RETURNING (xmax = 0) AS added, (xmax <> 0) AS renamed
           )
           SELECT * FROM up`,
          [codes, names, companies],
        );
        res.added = w.rows.filter((x) => x.added).length;
        res.renamed = w.rows.filter((x) => x.renamed).length;
        await client.query(
          `INSERT INTO ops.dhm_sync_state (entity, mapping, last_run_at, last_status, last_error, last_trigger, records_seen, runs)
           VALUES ($1, $2::jsonb, now(), 'ok', NULL, $3, $4, 1)
           ON CONFLICT (entity) DO UPDATE SET mapping = EXCLUDED.mapping, last_run_at = now(), last_status = 'ok',
             last_error = NULL, last_trigger = EXCLUDED.last_trigger,
             records_seen = ops.dhm_sync_state.records_seen + EXCLUDED.records_seen, runs = ops.dhm_sync_state.runs + 1`,
          [entity, JSON.stringify(mapping), trigger, res.records],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      // Plant names are in cached figures and labels.
      if (res.added > 0 || res.renamed > 0) clearResultCache();
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await query(
        `INSERT INTO ops.dhm_sync_state (entity, last_run_at, last_status, last_error, last_trigger, runs)
         VALUES ($1, now(), 'error', $2, $3, 1)
         ON CONFLICT (entity) DO UPDATE SET last_run_at = now(), last_status = 'error',
           last_error = EXCLUDED.last_error, last_trigger = EXCLUDED.last_trigger, runs = ops.dhm_sync_state.runs + 1`,
        [entity, msg.slice(0, 1000), trigger],
      ).catch(() => undefined);
      return { ...res, outcome: 'error', error: msg };
    } finally {
      inFlight = false;
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

/** What the Admin page shows about the plant master. */
export async function dhmPlantStatus(): Promise<Record<string, unknown>> {
  const entity = env.DHM_PLANT_ENTITY;
  const state = await queryOne<Record<string, unknown>>(
    `SELECT last_run_at, last_status, last_error, last_trigger, records_seen, runs, mapping
       FROM ops.dhm_sync_state WHERE entity = $1`,
    [entity],
  );
  const counts = await queryOne<{ plants: number; named: number }>(
    `SELECT count(*)::int AS plants, count(*) FILTER (WHERE plant_name IS NOT NULL AND plant_name <> plant)::int AS named
       FROM core.dim_plant`,
  );
  return {
    configured: dhmConfigured(),
    enabled: env.DHM_PLANT_ENABLED,
    entity,
    intervalHours: env.DHM_PLANT_SYNC_HOURS,
    inFlight,
    state,
    plants: counts,
  };
}

let pollerStarted = false;

/**
 * Checks hourly whether the daily run is due. The due time is read from the
 * last run stored in the database, so restarts neither skip nor repeat a run.
 */
export function startDhmPlantPoller(log: (msg: string) => void): void {
  if (pollerStarted || !dhmConfigured() || !env.DHM_PLANT_ENABLED) return;
  pollerStarted = true;
  const tick = async (): Promise<void> => {
    if (process.uptime() < env.BACKGROUND_START_DELAY_SECONDS) return;
    try {
      const last = await queryOne<{ due: boolean }>(
        `SELECT (last_run_at IS NULL OR last_run_at < now() - make_interval(hours => $2)) AS due
           FROM ops.dhm_sync_state WHERE entity = $1`,
        [env.DHM_PLANT_ENTITY, env.DHM_PLANT_SYNC_HOURS],
      );
      if (last && !last.due) return;
      const r = await trackJob('dhm plant sync', runDhmPlantSync('scheduled'));
      log(`dhm plant sync (${r.outcome}): ${r.plants} plants, ${r.added} added, ${r.renamed} renamed`
        + `${r.keptAdminName ? `, ${r.keptAdminName} admin names kept` : ''}${r.error ? ` - ${r.error}` : ''}`);
    } catch (e) {
      log(`dhm plant poller error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  setInterval(() => { void tick(); }, 60 * 60_000).unref();
  // First check once the start-up delay has passed, not an hour later.
  setTimeout(() => { void tick(); }, (env.BACKGROUND_START_DELAY_SECONDS + 30) * 1000).unref();
}
