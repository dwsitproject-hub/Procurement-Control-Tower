/**
 * Aging — PRD §12.8.
 *
 * Aging is ALWAYS relative to the dataset's as-of date. There is deliberately no
 * access to the system clock in this module.
 *
 * v1 computed aging from wall-clock `new Date()`, so reopening an unchanged
 * export six months later inflated every ">60 day" KPI by roughly 180 days with
 * no change in the data. Passing the as-of date in makes aging deterministic,
 * reproducible and testable.
 */

const MS_PER_DAY = 86_400_000;

function utcMs(isoDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
}

/** Whole days between two calendar dates. Null if either is missing/invalid. */
export function dayDiff(laterIso: string | null, earlierIso: string | null): number | null {
  if (laterIso === null || earlierIso === null) return null;
  const a = utcMs(laterIso);
  const b = utcMs(earlierIso);
  if (a === null || b === null) return null;
  return Math.round((a - b) / MS_PER_DAY);
}

/**
 * Aging of a reference date against the dataset as-of date.
 * Never uses the current time.
 */
export function agingDays(asOfDate: string, refDate: string | null): number | null {
  return dayDiff(asOfDate, refDate);
}

export type AgingBand = '0-30' | '31-60' | '61-90' | '91-180' | '180+';

export const AGING_BANDS: readonly AgingBand[] = ['0-30', '31-60', '61-90', '91-180', '180+'];

export function agingBand(days: number | null): AgingBand | null {
  if (days === null) return null;
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  if (days <= 180) return '91-180';
  return '180+';
}

export const DEFAULT_AGING_THRESHOLD_DAYS = 60;

export function isOverAgingThreshold(
  days: number | null,
  thresholdDays: number = DEFAULT_AGING_THRESHOLD_DAYS,
): boolean {
  return days !== null && days > thresholdDays;
}

/**
 * The as-of date of a dataset version: the latest business date the data
 * describes. PRD §12.8 — MAX(PO document date, GR posting date).
 */
export function computeAsOfDate(maxPoDocumentDate: string | null, maxGrPostingDate: string | null): string | null {
  const candidates = [maxPoDocumentDate, maxGrPostingDate].filter((d): d is string => d !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a >= b ? a : b));
}

export type FreshnessState = 'current' | 'ageing' | 'stale';

export interface FreshnessConfig {
  readonly ageingDays: number;
  readonly staleDays: number;
}

export const DEFAULT_FRESHNESS: FreshnessConfig = { ageingDays: 3, staleDays: 7 };

/**
 * Freshness compares the as-of date to TODAY — this is the one place a real
 * clock is legitimate, because the question is "how old is this data now".
 * The caller passes today explicitly so the function stays testable.
 */
export function freshnessState(
  asOfDate: string,
  todayIso: string,
  cfg: FreshnessConfig = DEFAULT_FRESHNESS,
): FreshnessState {
  const lag = dayDiff(todayIso, asOfDate);
  if (lag === null) return 'stale';
  if (lag <= cfg.ageingDays) return 'current';
  if (lag <= cfg.staleDays) return 'ageing';
  return 'stale';
}
