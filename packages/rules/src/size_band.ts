/**
 * Transaction size bands, in rupiah.
 *
 * ONE definition, read by the transform (which stamps the band onto each PO
 * line), the chart builder and the page. The reference design this replaces got
 * two things wrong that a single source of truth makes unreachable:
 *
 *   * it ordered the bands by % value, so `100-500 Jt` was drawn above
 *     `500 Jt - 1 Bio`. These are intervals on a number line; sorting them by a
 *     measure destroys the distribution shape the panel exists to show. `key`
 *     here is ordinal, so the correct order is the default.
 *   * it called the same magnitude `Bio` in one panel and `M` in another. In
 *     Indonesian both read as miliar, but `M` also reads as "million" to an
 *     English reader — a 1000x misreading. The ladder is Jt (juta, 10^6), Bio
 *     (miliar, 10^9), T (triliun, 10^12), used consistently and nowhere else
 *     redefined.
 *
 * Bounds are half-open, `min` inclusive and `max` exclusive, so every value
 * falls in exactly one band and no rupiah is double-counted at a boundary.
 */

export interface SizeBand {
  /** Ordinal key, '1' = largest. Stored on the fact; sorts lexically. */
  key: string;
  label: string;
  /** Inclusive lower bound, IDR. */
  min: number;
  /** Exclusive upper bound, IDR. `null` = unbounded. */
  max: number | null;
}

const JT = 1_000_000;
const BIO = 1_000_000_000;

/** Largest first, matching how the panel reads top to bottom. */
export const SIZE_BANDS: readonly SizeBand[] = [
  { key: '1', label: '> Rp 1 Bio',       min: BIO,      max: null },
  { key: '2', label: 'Rp 500 Jt - 1 Bio', min: 500 * JT, max: BIO },
  { key: '3', label: 'Rp 100 - 500 Jt',  min: 100 * JT, max: 500 * JT },
  { key: '4', label: 'Rp 25 - 100 Jt',   min: 25 * JT,  max: 100 * JT },
  { key: '5', label: 'Rp 5 - 25 Jt',     min: 5 * JT,   max: 25 * JT },
  { key: '6', label: 'Rp 1 - 5 Jt',      min: JT,       max: 5 * JT },
  { key: '7', label: '< Rp 1 Jt',        min: 0,        max: JT },
];

/**
 * The band a value falls in, or null when there is no value.
 *
 * Null rather than the smallest band on purpose: a line with no IDR value is
 * unknown, not tiny, and counting it as zero would inflate the smallest band —
 * which is the band the whole "fragmented tail" argument rests on.
 */
export function sizeBandKey(valueIdr: number | null | undefined): string | null {
  if (valueIdr === null || valueIdr === undefined || !Number.isFinite(valueIdr)) return null;
  if (valueIdr < 0) return null;
  for (const b of SIZE_BANDS) {
    if (valueIdr >= b.min && (b.max === null || valueIdr < b.max)) return b.key;
  }
  return null;
}

export function sizeBandLabel(key: string | null): string | null {
  return SIZE_BANDS.find((b) => b.key === key)?.label ?? null;
}

/** The band boundaries as a SQL CASE, so the transform stamps identical values. */
export function sizeBandSql(column: string): string {
  const arms = SIZE_BANDS.map((b) => (b.max === null
    ? `WHEN ${column} >= ${b.min} THEN '${b.key}'`
    : `WHEN ${column} >= ${b.min} AND ${column} < ${b.max} THEN '${b.key}'`));
  return `CASE WHEN ${column} IS NULL OR ${column} < 0 THEN NULL\n       ${arms.join('\n       ')}\n       ELSE NULL END`;
}
