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
/**
 * Charts that UNION two grains (PR stages + PO stages). One clause cannot
 * filter both halves honestly; each half gets its own grain's clause injected
 * at its own dataset_version_id anchor.
 */
const MIXED_GRAIN_CHARTS = new Set(['aging_severity_by_stage']);

const JOINED_ALIAS: Record<string, { kind: FactKind; alias: string }> = {
  pr_po_price_variance: { kind: 'po_line', alias: 'pol.' },
  e2e_by_month: { kind: 'po_line', alias: 'pol.' },
  e2e_by_category: { kind: 'po_line', alias: 'pol.' },
  single_source_spend_idr: { kind: 'po_line', alias: 'p.' },
  urgent_po_before_pr: { kind: 'po_line', alias: 'pol.' },
  pr_approval_lead_time: { kind: 'pr_item', alias: 'i.' },
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

/**
 * Compute EVERY series of a chart under the filter.
 *
 * The single-spec version below was the only entry point, and it used find()
 * rather than filter() — so a filtered multi-series chart silently lost all but
 * its first series. Unfiltered the mart holds them all, so the panel looked
 * complete until someone touched the filter bar and half of it vanished with no
 * error. aging_by_priority, po_bracket_* and the Executive Summary's Open/Closed
 * splits were all affected.
 *
 * A series whose SQL legitimately returns nothing is DROPPED rather than
 * returned empty: under "Open only" there are no Delivered rows, and an empty
 * "Closed" series in the response would draw a legend entry for something that
 * cannot exist in that slice.
 */
export async function computeLiveChartSeries(
  versionId: number,
  chartId: string,
  filter: GlobalFilter,
): Promise<LiveChart[] | null> {
  const specs = PARITY_CHARTS.filter((c) => c.chartId === chartId);
  if (specs.length === 0) return null;

  const out: LiveChart[] = [];
  for (const spec of specs) {
    const one = await computeLiveChartFor(spec, versionId, chartId, filter);
    // A null here means the filter cannot be honoured for this spec at all; that
    // is a property of the chart, not of one series, so the caller falls back to
    // the precomputed chart with its "filter not applied" note.
    if (one === null) return null;
    if (one.points.length > 0) out.push(one);
  }
  return out;
}

export async function computeLiveChart(
  versionId: number,
  chartId: string,
  filter: GlobalFilter,
): Promise<LiveChart | null> {
  const spec = PARITY_CHARTS.find((c) => c.chartId === chartId);
  if (!spec) return null;
  return computeLiveChartFor(spec, versionId, chartId, filter);
}

async function computeLiveChartFor(
  spec: {
    chartId: string; seriesKey: string; seriesLabel: string; unit: string; sql: string;
    filterAlias?: string;
  },
  versionId: number,
  chartId: string,
  filter: GlobalFilter,
): Promise<LiveChart | null> {

  // Chart specs embed their own grain in the drill jsonb; infer from the SQL's
  // driving table instead, which is unambiguous.
  const kind: FactKind = spec.sql.includes('fact_pr_item') && !spec.sql.includes('fact_po_line')
    ? 'pr_item'
    : spec.sql.includes('fact_gr_posting')
      ? 'gr_posting'
      : 'po_line';
  // Per-series alias first: a chart can have one single-table series and one
  // joined series, and only the series itself knows which it is.
  const alias = spec.filterAlias ?? JOINED_ALIAS[chartId]?.alias ?? '';

  // A scope toggle on a GR-grain chart cannot be honored; returning null makes
  // the route fall back to the precomputed chart with its explicit
  // "filter NOT applied" note — honest, and already what the sweep expects.
  let sql: string;
  let params: unknown[];
  if (MIXED_GRAIN_CHARTS.has(chartId)) {
    // Each UNION half is a single-table query on its own grain; its points'
    // drill predicates carry that grain, so per-half clauses keep the
    // chart-equals-drill guarantee intact under every filter.
    let prClause; let polClause;
    try {
      prClause = buildFilterClause(filter, 'pr_item', '', 2);
      polClause = buildFilterClause(filter, 'po_line', '', 2 + prClause.params.length);
    } catch {
      return null;
    }
    const anchor = 'dataset_version_id = $1';
    const first = spec.sql.indexOf(anchor);
    const second = spec.sql.indexOf(anchor, first + anchor.length);
    if (first < 0 || second < 0) return null;
    sql = spec.sql.slice(0, first + anchor.length) + prClause.sql
      + spec.sql.slice(first + anchor.length, second + anchor.length) + polClause.sql
      + spec.sql.slice(second + anchor.length);
    params = [...prClause.params, ...polClause.params];
  } else {
    let clause;
    try {
      clause = buildFilterClause(filter, kind, alias, 2);
    } catch {
      return null;
    }
    sql = injectFilter(spec.sql, clause);
    params = clause.params;
  }

  const r = await pool.query<{
    bucket_key: string; bucket_label: string; value: number | null;
    row_count: number; drill: Record<string, unknown>;
  }>(sql, [versionId, ...params]);

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
