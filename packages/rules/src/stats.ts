/**
 * Statistical helpers used by the KPI layer.
 *
 * Every function returns null rather than a misleading value on an inadequate
 * sample. The minimum-sample rule is what stops a median of three rows being
 * presented as a cycle time.
 */

export const DEFAULT_MIN_SAMPLE = 30;

export function median(values: readonly number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0]!;
  const idx = (xs.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return xs[lo]!;
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (idx - lo);
}

export function mean(values: readonly number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Expedite Effectiveness — PRD §13.2.
 *
 * Ratio of urgent to standard median PR-to-PO days. A ratio >= 1 means the
 * urgent lane is no faster, i.e. the flag is being abused or ignored.
 *
 * Reference data returns 0.50 (urgent median 6 days, standard median 12 days;
 * n = 2,568 / 7,575). v1's PRD claimed 1.40; six definition variants were tested
 * and all return 0.50, so the divergence is not formula ambiguity.
 *
 * Urgency 0 is undefined in the source and excluded from both arms.
 */
export interface ExpediteResult {
  readonly ratio: number | null;
  readonly urgentMedian: number | null;
  readonly standardMedian: number | null;
  readonly urgentSample: number;
  readonly standardSample: number;
  readonly status: 'ok' | 'insufficient_sample';
}

export function expediteEffectiveness(
  urgentDays: readonly number[],
  standardDays: readonly number[],
  minSample: number = DEFAULT_MIN_SAMPLE,
): ExpediteResult {
  const um = median(urgentDays);
  const sm = median(standardDays);

  if (urgentDays.length < minSample || standardDays.length < minSample || um === null || sm === null || sm === 0) {
    return {
      ratio: null,
      urgentMedian: um,
      standardMedian: sm,
      urgentSample: urgentDays.length,
      standardSample: standardDays.length,
      status: 'insufficient_sample',
    };
  }

  return {
    ratio: um / sm,
    urgentMedian: um,
    standardMedian: sm,
    urgentSample: urgentDays.length,
    standardSample: standardDays.length,
    status: 'ok',
  };
}

/**
 * Share-of-value over an aging threshold, e.g. GR/IR > 60 days.
 * Returns null when the denominator is zero rather than 0%.
 */
export interface ShareResult {
  readonly pct: number | null;
  readonly numerator: number;
  readonly denominator: number;
  readonly sampleSize: number;
}

export function shareOverThreshold(
  rows: readonly { value: number; agingDays: number | null }[],
  thresholdDays: number,
): ShareResult {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.value)) continue;
    den += r.value;
    if (r.agingDays !== null && r.agingDays > thresholdDays) num += r.value;
  }
  return {
    pct: den > 0 ? (num / den) * 100 : null,
    numerator: num,
    denominator: den,
    sampleSize: rows.length,
  };
}

/**
 * Demand Realism — PRD §13.1.
 *
 * Share of PR items whose requested lead time is at least the material group's
 * median ACTUAL lead time.
 *
 * On the reference export this KPI is disabled by semantic assertion V-M01: the
 * `Deliv. date(From/to)` column equals `Release Date` on 99.40% of rows, so it
 * is not a need-by date. Only 2.8% of rows carry a usable future date and the
 * median requested lead is 0 days.
 *
 * The function takes `needByDate`-derived leads only. Passing the raw column is
 * a caller error; the pipeline gates on V-M01 before ever reaching here.
 */
export interface DemandRealismRow {
  readonly requestedLeadDays: number | null;
  readonly materialGroup: string | null;
}

export interface DemandRealismResult {
  readonly pct: number | null;
  readonly evaluated: number;
  readonly realistic: number;
  readonly requestedMedian: number | null;
  readonly actualMedian: number | null;
  readonly status: 'ok' | 'insufficient_sample';
}

export function demandRealism(
  rows: readonly DemandRealismRow[],
  actualLeadByGroup: ReadonlyMap<string, number>,
  overallActualMedian: number | null,
  minSample: number = DEFAULT_MIN_SAMPLE,
): DemandRealismResult {
  let evaluated = 0;
  let realistic = 0;
  const requested: number[] = [];

  for (const r of rows) {
    if (r.requestedLeadDays === null) continue;
    const groupMedian = r.materialGroup !== null ? actualLeadByGroup.get(r.materialGroup) : undefined;
    const benchmark = groupMedian ?? overallActualMedian;
    if (benchmark === null || benchmark === undefined) continue;
    evaluated += 1;
    requested.push(r.requestedLeadDays);
    if (r.requestedLeadDays >= benchmark) realistic += 1;
  }

  if (evaluated < minSample) {
    return {
      pct: null,
      evaluated,
      realistic,
      requestedMedian: median(requested),
      actualMedian: overallActualMedian,
      status: 'insufficient_sample',
    };
  }

  return {
    pct: (realistic / evaluated) * 100,
    evaluated,
    realistic,
    requestedMedian: median(requested),
    actualMedian: overallActualMedian,
    status: 'ok',
  };
}

/** Group a list by key, returning medians. Used for category benchmarks. */
export function medianByGroup<T>(
  rows: readonly T[],
  keyOf: (r: T) => string | null,
  valueOf: (r: T) => number | null,
  minSample = 1,
): Map<string, number> {
  const buckets = new Map<string, number[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const v = valueOf(r);
    if (k === null || v === null) continue;
    const list = buckets.get(k);
    if (list) list.push(v);
    else buckets.set(k, [v]);
  }
  const out = new Map<string, number>();
  for (const [k, vs] of buckets) {
    if (vs.length < minSample) continue;
    const m = median(vs);
    if (m !== null) out.set(k, m);
  }
  return out;
}
