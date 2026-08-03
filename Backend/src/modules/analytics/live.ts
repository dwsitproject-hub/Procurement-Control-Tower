/**
 * Live (filtered) KPI and chart computation — W2.
 *
 * Runs the SAME spec SQL the mart precomputes, with the global filter injected.
 * The precomputed path is untouched: an unfiltered request never reaches this
 * module, so a bug here cannot affect the default dashboard.
 */

import { pool } from '../../db/client.js';
import { PARITY_KPIS, PARITY_CHARTS } from './mart_parity.js';
import {
  buildFilterClause, injectFilter, mergeIntoPredicate, type FactKind, type GlobalFilter,
} from './globalfilter.js';

export interface LiveKpi {
  kpiId: string;
  status: 'ok' | 'unavailable';
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  sampleSize: number | null;
  unit: string;
  currencyBasis: string | null;
  severity: string | null;
  statusReason: string | null;
  detail: Record<string, unknown> | null;
  drillPredicate: Record<string, unknown> | null;
}

/**
 * Which fact table a spec drives from, and the alias its columns need.
 *
 * Derived from the spec's own drill grain where possible. The joined specs are
 * listed explicitly because an unqualified column would be ambiguous.
 */
const JOINED_ALIAS: Record<string, { kind: FactKind; alias: string }> = {
  pr_po_price_variance: { kind: 'po_line', alias: 'pol.' },
  e2e_by_month: { kind: 'po_line', alias: 'pol.' },
  e2e_by_category: { kind: 'po_line', alias: 'pol.' },
  single_source_spend_idr: { kind: 'po_line', alias: 'p.' },
};

function targetOf(id: string, grain: string | undefined): { kind: FactKind; alias: string } {
  const joined = JOINED_ALIAS[id];
  if (joined) return joined;
  const kind: FactKind =
    grain === 'pr_item' ? 'pr_item' : grain === 'gr_posting' ? 'gr_posting' : 'po_line';
  return { kind, alias: '' };
}

function severityOf(
  value: number | null,
  high?: { warn: number; crit: number },
  low?: { warn: number; crit: number },
): string | null {
  if (value === null) return null;
  if (high) return value >= high.crit ? 'critical' : value >= high.warn ? 'warning' : 'good';
  if (low) return value <= low.crit ? 'critical' : value <= low.warn ? 'warning' : 'good';
  return 'neutral';
}

export async function computeLiveKpis(
  versionId: number,
  filter: GlobalFilter,
): Promise<LiveKpi[]> {
  const out: LiveKpi[] = [];

  for (const spec of PARITY_KPIS) {
    const grain = (spec.drill?.['grain'] as string | undefined) ?? 'po_line';
    const { kind, alias } = targetOf(spec.id, grain);

    let sql: string;
    let clause;
    try {
      // Both steps can refuse: the scope toggle has no meaning on the GR grain,
      // and a spec without an anchor cannot be filtered.
      clause = buildFilterClause(filter, kind, alias, 2);
      sql = injectFilter(spec.sql, clause);
    } catch {
      // A spec with no anchor cannot be filtered honestly, so it reports as
      // unavailable rather than silently returning the unfiltered number.
      out.push({
        kpiId: spec.id, status: 'unavailable', value: null, numerator: null, denominator: null,
        sampleSize: null, unit: spec.unit, currencyBasis: spec.currencyBasis ?? null,
        severity: null, statusReason: 'This figure cannot be filtered.', detail: null,
        drillPredicate: null,
      });
      continue;
    }

    let row: { value?: unknown; numerator?: unknown; denominator?: unknown; sample?: unknown } = {};
    try {
      const r = await pool.query(sql, [versionId, ...clause.params]);
      row = (r.rows[0] ?? {}) as typeof row;
    } catch (err) {
      out.push({
        kpiId: spec.id, status: 'unavailable', value: null, numerator: null, denominator: null,
        sampleSize: null, unit: spec.unit, currencyBasis: spec.currencyBasis ?? null,
        severity: null,
        statusReason: `Could not compute under the active filter: ${
          err instanceof Error ? err.message.slice(0, 120) : 'unknown error'
        }`,
        detail: null, drillPredicate: null,
      });
      continue;
    }

    const value =
      row.value === null || row.value === undefined || Number.isNaN(Number(row.value))
        ? null
        : Number(row.value);

    out.push({
      kpiId: spec.id,
      status: value === null ? 'unavailable' : 'ok',
      value,
      numerator: row.numerator === null || row.numerator === undefined ? null : Number(row.numerator),
      denominator:
        row.denominator === null || row.denominator === undefined ? null : Number(row.denominator),
      sampleSize: row.sample === null || row.sample === undefined ? null : Number(row.sample),
      unit: spec.unit,
      currencyBasis: spec.currencyBasis ?? null,
      severity: severityOf(value, spec.worseWhenHigh, spec.worseWhenLow),
      statusReason: value === null ? 'No qualifying rows under the active filter.' : null,
      detail: spec.entityUnit ? { entityUnit: spec.entityUnit } : null,
      // The drill must carry the same global filter, or the card and its drill
      // would disagree the moment a filter is applied.
      drillPredicate: mergeIntoPredicate(spec.drill, filter),
    });
  }

  return out;
}

export interface LiveChartPoint {
  bucketKey: string;
  bucketLabel: string;
  ordinal: number;
  value: number | null;
  rowCount: number;
  drillPredicate: Record<string, unknown>;
}

export interface LiveChart {
  chartId: string;
  seriesKey: string;
  seriesLabel: string;
  unit: string;
  points: LiveChartPoint[];
}

export async function computeLiveChart(
  versionId: number,
  chartId: string,
  filter: GlobalFilter,
): Promise<LiveChart | null> {
  const spec = PARITY_CHARTS.find((c) => c.chartId === chartId);
  if (!spec) return null;

  // Chart specs embed their own grain in the drill jsonb; infer from the SQL's
  // driving table instead, which is unambiguous.
  const kind: FactKind = spec.sql.includes('fact_pr_item') && !spec.sql.includes('fact_po_line')
    ? 'pr_item'
    : spec.sql.includes('fact_gr_posting')
      ? 'gr_posting'
      : 'po_line';
  const alias = JOINED_ALIAS[chartId]?.alias ?? '';

  // A scope toggle on a GR-grain chart cannot be honored; returning null makes
  // the route fall back to the precomputed chart with its explicit
  // "filter NOT applied" note — honest, and already what the sweep expects.
  let clause;
  try {
    clause = buildFilterClause(filter, kind, alias, 2);
  } catch {
    return null;
  }
  const sql = injectFilter(spec.sql, clause);

  const r = await pool.query<{
    bucket_key: string; bucket_label: string; value: number | null;
    row_count: number; drill: Record<string, unknown>;
  }>(sql, [versionId, ...clause.params]);

  return {
    chartId: spec.chartId,
    seriesKey: spec.seriesKey,
    seriesLabel: spec.seriesLabel,
    unit: spec.unit,
    points: r.rows.map((x, i) => ({
      bucketKey: x.bucket_key ?? '(none)',
      bucketLabel: x.bucket_label ?? '(none)',
      ordinal: i + 1,
      value: x.value === null ? null : Number(x.value),
      rowCount: x.row_count,
      drillPredicate: mergeIntoPredicate(x.drill, filter) ?? x.drill,
    })),
  };
}

/** Which chart ids can be computed live. Others fall back to the mart. */
export function liveChartAvailable(chartId: string): boolean {
  return PARITY_CHARTS.some((c) => c.chartId === chartId);
}

/** Facet options for the global filter bar. */
export async function globalFilterOptions(versionId: number): Promise<{
  company: { value: string; label: string }[];
  plant: { value: string; label: string }[];
  purchOrg: { value: string; label: string }[];
  monthKey: { value: string; label: string }[];
}> {
  const co = await pool.query<{ value: string; label: string }>(
    `SELECT DISTINCT pol.company_code AS value,
            COALESCE(dc.legal_name, pol.company_code) AS label
       FROM core.fact_po_line pol
       LEFT JOIN core.dim_company dc ON dc.company_code = pol.company_code
      WHERE pol.dataset_version_id = $1 ORDER BY 1`,
    [versionId],
  );
  const pl = await pool.query<{ value: string; label: string }>(
    `SELECT DISTINCT pol.plant AS value,
            COALESCE(dp.plant_name, pol.plant) AS label
       FROM core.fact_po_line pol
       LEFT JOIN core.dim_plant dp ON dp.plant = pol.plant
      WHERE pol.dataset_version_id = $1 ORDER BY 1`,
    [versionId],
  );
  const po = await pool.query<{ value: string; label: string }>(
    `SELECT DISTINCT purch_org AS value, purch_org AS label
       FROM core.fact_po_line WHERE dataset_version_id = $1 AND purch_org <> '' ORDER BY 1`,
    [versionId],
  );
  const mo = await pool.query<{ value: string; label: string }>(
    `SELECT DISTINCT to_char(document_date,'YYYY-MM') AS value,
            to_char(document_date,'Mon YYYY') AS label
       FROM core.fact_po_line
      WHERE dataset_version_id = $1 AND document_date IS NOT NULL ORDER BY 1`,
    [versionId],
  );
  return { company: co.rows, plant: pl.rows, purchOrg: po.rows, monthKey: mo.rows };
}
