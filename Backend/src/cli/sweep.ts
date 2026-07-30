/**
 * CLI: drill-parity sweep.
 *
 *   npm run sweep -w @pct/backend -- [--base http://127.0.0.1:8081] [--filter plant=EU71,...]
 *
 * Verifies the product's core guarantee — every displayed figure drills to
 * exactly its own row set — by walking every KPI card and every chart point and
 * comparing the displayed count against the drill's totalCount.
 *
 * Exit code 0 only when there are zero mismatches and zero errors, so this can
 * gate CI. Entity-count KPIs (detail.entityUnit set) are reported separately:
 * their card counts distinct entities while the drill returns underlying rows,
 * which differ by design.
 *
 * With --filter, the same sweep runs under a global filter, verifying the W2
 * live-computation path end to end (filtered card == filtered drill).
 */

import { fileURLToPath } from 'node:url';

interface KpiRow {
  kpiId: string;
  status: string;
  value: number | null;
  unit: string;
  detail: Record<string, unknown> | null;
  drillToken: string | null;
}

interface ChartPoint {
  bucketKey: string;
  rowCount: number;
  drillToken: string | null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const base = arg('base') ?? 'http://127.0.0.1:8081';
  const email = arg('email') ?? 'admin@energi-up.com';
  const password = arg('password') ?? 'ChangeMe!Local2026';
  const rawFilter = arg('filter'); // e.g. "plant=EU71,EU73;monthKey=2026-03"

  let filterQuery = '';
  if (rawFilter) {
    const params = new URLSearchParams();
    for (const part of rawFilter.split(';')) {
      const [k, v] = part.split('=');
      if (k && v) params.set(k.trim(), v.trim());
    }
    filterQuery = params.toString();
  }

  // ── login, keep the session cookie ──
  const loginRes = await fetch(`${base}/auth/local/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    process.stderr.write(`login failed: HTTP ${loginRes.status}\n`);
    return 2;
  }
  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  if (cookie === '') {
    process.stderr.write('login returned no session cookie\n');
    return 2;
  }
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${base}${path}`, { headers: { cookie } });
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  };

  const qs = filterQuery ? `?${filterQuery}` : '';
  process.stdout.write(
    `sweep against ${base}${filterQuery ? ` under filter [${filterQuery}]` : ' (unfiltered)'}\n\n`,
  );

  let mismatches = 0;
  let errors = 0;

  // ── KPI cards ──
  const kpiResp = await get<{ datasetVersionId: number; computed?: string; kpis: KpiRow[] }>(
    `/api/v1/kpi${qs}`,
  );
  const entityKpis = new Set(
    kpiResp.kpis.filter((k) => (k.detail ?? {})['entityUnit']).map((k) => k.kpiId),
  );
  let kpiChecked = 0;
  for (const k of kpiResp.kpis) {
    if (!k.drillToken || k.status !== 'ok' || k.unit !== 'count') continue;
    if (entityKpis.has(k.kpiId)) continue; // differs by design; reported below
    kpiChecked += 1;
    try {
      const d = await get<{ totalCount: number }>(`/api/v1/drill/${k.drillToken}?limit=1`);
      if (Math.abs(d.totalCount - (k.value ?? 0)) > 0.5) {
        mismatches += 1;
        process.stdout.write(
          `  KPI MISMATCH   ${k.kpiId}: card=${k.value} drill=${d.totalCount}\n`,
        );
      }
    } catch (err) {
      errors += 1;
      process.stdout.write(`  KPI ERROR      ${k.kpiId}: ${String(err)}\n`);
    }
  }

  // ── chart points ──
  const catalogue = await get<{ charts: { chartId: string }[] }>(`/api/v1/chart`);
  let pointsChecked = 0;
  let emptyCharts = 0;
  for (const c of catalogue.charts) {
    let chart: {
      computed?: string;
      notes: string[];
      buckets: unknown[];
      series: { key: string; points: ChartPoint[] }[];
    };
    try {
      chart = await get(`/api/v1/chart/${c.chartId}${qs}`);
    } catch (err) {
      errors += 1;
      process.stdout.write(`  CHART ERROR    ${c.chartId}: ${String(err)}\n`);
      continue;
    }
    // Under a filter, charts that declare the filter was NOT applied are
    // legitimately skipped — their counts describe the unfiltered population.
    if (filterQuery && chart.notes.some((n) => n.includes('NOT applied'))) continue;
    if (chart.buckets.length === 0) {
      emptyCharts += 1;
      continue;
    }
    for (const s of chart.series) {
      for (const pt of s.points) {
        if (!pt.drillToken) continue;
        pointsChecked += 1;
        try {
          const d = await get<{ totalCount: number }>(`/api/v1/drill/${pt.drillToken}?limit=1`);
          if (d.totalCount !== pt.rowCount) {
            mismatches += 1;
            process.stdout.write(
              `  CHART MISMATCH ${c.chartId}/${s.key}/${pt.bucketKey}: chart=${pt.rowCount} drill=${d.totalCount}\n`,
            );
          }
        } catch (err) {
          errors += 1;
          process.stdout.write(
            `  DRILL ERROR    ${c.chartId}/${s.key}/${pt.bucketKey}: ${String(err)}\n`,
          );
        }
      }
    }
  }

  process.stdout.write(
    `\nRESULT  kpis=${kpiResp.kpis.length} (entity-count: ${entityKpis.size}) ` +
      `kpiDrillsChecked=${kpiChecked} charts=${catalogue.charts.length} ` +
      `emptyCharts=${emptyCharts} chartPointsChecked=${pointsChecked} ` +
      `mismatches=${mismatches} errors=${errors}\n`,
  );
  return mismatches === 0 && errors === 0 ? 0 : 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`SWEEP ERROR: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(2);
    });
}
