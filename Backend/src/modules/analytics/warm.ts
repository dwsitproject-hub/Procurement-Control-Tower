/**
 * Cache warm-up (13 Nov 2026).
 *
 * Every page opens on the data's year, so the first visitor after a publish
 * used to pay for every live computation (PO Analysis: 13 s in production).
 * After each publish, and at start-up, the default view - the data's year, full
 * scope, no section filters - is computed once, one query at a time so the warm
 * never competes with real users for database connections. Those results land
 * in the same cache (cache.ts) the routes read, under the same keys.
 */

import { queryOne } from '../../db/client.js';
import { memo } from './cache.js';
import { CHART_META } from './charts.js';
import { computeLiveChartSeries, computeLiveKpis, globalFilterOptions, liveChartAvailable } from './live.js';
import { execTilePeriods } from './execperiods.js';
import { openItemsSummary } from './openitems.js';
import { parseGlobalFilter } from './globalfilter.js';
import { materialGroupPage, topMaterialsSpend, vendorList } from './entity.js';
import type { ScopeEntry } from '../authz/scope.js';

const FULL_SCOPE: ScopeEntry[] = [{ companyCode: '*', plant: '*', purchOrg: '*' }];
let running = false;
let again = false;
let lastLog: (m: string) => void = (m) => process.stdout.write(`${m}${String.fromCharCode(10)}`);

/**
 * Warm the default view. A call while a warm is running queues ONE more pass
 * (an edit during a warm must be followed by a warm of the edited data).
 */
export async function warmDefaultView(log?: (m: string) => void): Promise<void> {
  if (log) lastLog = log;
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await warmOnce(lastLog);
    } while (again);
  } finally {
    running = false;
  }
}

async function warmOnce(log: (m: string) => void): Promise<void> {
  const t0 = Date.now();
  try {
    const v = await queryOne<{ id: number; as_of: string }>(
      `SELECT v.id, v.as_of_date::text AS as_of
         FROM core.dataset_pointer p JOIN core.dataset_version v ON v.id = p.current_version_id
        WHERE p.id = 1`,
    );
    if (!v) return;
    const id = Number(v.id);
    // Exactly what the browser sends on first load: year = the as-of year.
    const gf = parseGlobalFilter({ year: v.as_of.slice(0, 4) });
    let n = 0;
    const step = async (parts: unknown[], fn: () => Promise<unknown>) => {
      try {
        await memo(id, parts, fn);
        n++;
      } catch (e) {
        log(`cache warm: ${String(parts[0])} failed - ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    await step(['filters'], () => globalFilterOptions(id));
    await step(['kpi', gf], () => computeLiveKpis(id, gf));
    for (const c of CHART_META) {
      if (liveChartAvailable(c.chartId)) {
        await step(['chart', c.chartId, gf], () => computeLiveChartSeries(id, c.chartId, gf));
      }
    }
    await step(['tiles', FULL_SCOPE, gf], () => execTilePeriods(id, v.as_of, FULL_SCOPE, gf));
    const section = { plant: [], prType: [], poType: [], stage: [] };
    await step(['openitems', FULL_SCOPE, gf, section], () => openItemsSummary(id, v.as_of, FULL_SCOPE, gf, section));
    // PO Analysis' top-10 tables and the Material Group explorer's first page,
    // with exactly the arguments those pages send (routes_extra.ts).
    await step(['topvendors', FULL_SCOPE, 10], () => vendorList(id, FULL_SCOPE, '', 10));
    await step(['topmaterials', FULL_SCOPE, 10], () => topMaterialsSpend(id, FULL_SCOPE, 10));
    const mgArgs = [null, '', null, 150, 0, gf] as const;
    await step(['materialgroups', FULL_SCOPE, mgArgs], () => materialGroupPage(id, FULL_SCOPE, ...mgArgs));
    log(`cache warm: version ${id}, ${n} views ready in ${Math.round((Date.now() - t0) / 1000)} s`);
  } catch (e) {
    log(`cache warm failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
