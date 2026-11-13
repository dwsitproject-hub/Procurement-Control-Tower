/**
 * Result cache for the computed views (13 Nov 2026).
 *
 * Every page opens on a filter - the data's year - so every chart and KPI was
 * recomputed from the facts on every visit: PO Analysis took 13 s in production
 * (24 live queries against ApsaraDB per load). A published dataset version is
 * immutable, so a result is fully determined by (version, what was asked, the
 * filter, the scope) and can be reused until the next version replaces it.
 *
 *  - Only COMPUTED RESULTS are cached, never HTTP responses: responses carry
 *    drill tokens bound to the caller's session.
 *  - Identical requests in flight share one computation.
 *  - A newer version id clears everything; size is bounded (LRU).
 *  - clearResultCache() (a master-data edit, a mart recompute) bumps a
 *    generation: a computation that STARTED before the clear is still returned
 *    to its caller but never stored, so pre-edit figures cannot creep back in.
 *  - Hits return a deep copy, so a caller can never alter the cached value.
 */

const MAX_ENTRIES = 600;
const store = new Map<string, Promise<unknown>>();
let newestVersion = -1;
let generation = 0;
let hits = 0;
let misses = 0;

function stable(v: unknown): string {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

export async function memo<T>(versionId: number, parts: unknown[], compute: () => Promise<T>): Promise<T> {
  if (versionId > newestVersion) {
    // A new version was published: everything cached belongs to the old one.
    store.clear();
    generation++;
    newestVersion = versionId;
  }
  const key = `${versionId}|${stable(parts)}`;
  const cached = store.get(key) as Promise<T> | undefined;
  if (cached) {
    hits++;
    store.delete(key); // LRU: move to the back
    store.set(key, cached);
    return structuredClone(await cached);
  }
  misses++;
  const gen = generation;
  const p = compute();
  store.set(key, p);
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value as string);
  try {
    const value = await p;
    // Cleared while computing: the value may predate the edit - do not keep it.
    if (gen !== generation && store.get(key) === p) store.delete(key);
    return structuredClone(value);
  } catch (err) {
    if (store.get(key) === p) store.delete(key); // a failure is not remembered
    throw err;
  }
}

export function cacheStats(): { entries: number; hits: number; misses: number; version: number; generation: number } {
  return { entries: store.size, hits, misses, version: newestVersion, generation };
}

export function clearResultCache(): void {
  store.clear();
  generation++;
}
