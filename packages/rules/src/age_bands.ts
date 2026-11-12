/**
 * The age bands, defined once.
 *
 * Requested 23 Sep 2026, replacing the four bands (0-15, 16-30, 31-90, >90)
 * that every aging figure had used since the v1 port. The new cut is finer at
 * the young end, where a buyer can still act, and coarser at the old end, where
 * the only useful question is "how far past saving is this".
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * The bands are needed as: a bucket expression for charts, an ordering for
 * those buckets, a per-band predicate for drill filters and for the detail
 * table's age filter, and labels for the page. Before this they were written
 * out four times over three different column names — `aging_days` on the
 * facts, `age_days` on the detail view — and a boundary changed in one place
 * and not the others is a card that opens rows it did not count.
 *
 * Every consumer generates its SQL from THIS list, so a future change to the
 * cut is one edit.
 *
 * ── The boundaries ────────────────────────────────────────────────────────
 *
 * `max` is INCLUSIVE, and the first band with a max the value fits into wins.
 * So '<7' is really "7 days or fewer" — the label is the business's wording and
 * the comparison is stated here rather than guessed from it. A null `max` is
 * the open-ended last band.
 *
 * A NULL age belongs to no band: a line with no age is not young, and counting
 * it as such is how the first band flatters itself.
 */
export interface AgeBand {
  /** Stable key: appears in URLs, drill predicates and saved views. */
  readonly key: string;
  /** What a reader sees. */
  readonly label: string;
  /** Inclusive upper bound in days; null for the open-ended band. */
  readonly max: number | null;
}

export const AGE_BANDS: readonly AgeBand[] = [
  { key: '<7', label: '< 7 d', max: 7 },
  { key: '8-30', label: '8-30 d', max: 30 },
  { key: '31-60', label: '31-60 d', max: 60 },
  { key: '61-90', label: '61-90 d', max: 90 },
  { key: '91-150', label: '91-150 d', max: 150 },
  { key: '>150', label: '> 150 d', max: null },
];

/** The boundary the backlog tables and headlines read "badly late" at. */
export const AGE_LATE_DAYS = 150;

/** `key` of the band a value falls in, as a SQL CASE over `col`. */
export function ageBandCaseSql(col: string): string {
  const arms = AGE_BANDS
    .filter((b) => b.max !== null)
    .map((b) => `WHEN ${col} <= ${b.max} THEN '${b.key}'`)
    .join(' ');
  const last = AGE_BANDS[AGE_BANDS.length - 1]!;
  return `CASE WHEN ${col} IS NULL THEN NULL ${arms} ELSE '${last.key}' END`;
}

/** 1-based ordinal of the band, for ORDER BY — youngest first. */
export function ageBandOrderSql(col: string): string {
  const arms = AGE_BANDS
    .filter((b) => b.max !== null)
    .map((b, i) => `WHEN ${col} <= ${b.max} THEN ${i + 1}`)
    .join(' ');
  return `CASE ${arms} ELSE ${AGE_BANDS.length} END`;
}

/**
 * The predicate selecting ONE band, for a drill or a table filter.
 *
 * Throws on an unknown key rather than returning true: a filter that silently
 * matches everything is how a card opens more rows than it counted.
 */
export function ageBandPredicateSql(col: string, key: string): string {
  const i = AGE_BANDS.findIndex((b) => b.key === key);
  if (i < 0) throw new Error(`unknown age band: ${key}`);
  const band = AGE_BANDS[i]!;
  const lower = i === 0 ? null : AGE_BANDS[i - 1]!.max;
  const parts = [`${col} IS NOT NULL`];
  if (lower !== null) parts.push(`${col} > ${lower}`);
  if (band.max !== null) parts.push(`${col} <= ${band.max}`);
  return parts.join(' AND ');
}

/** Everything past `AGE_LATE_DAYS`, the "sorted by lines over 150 days" cut. */
export function ageLatePredicateSql(col: string): string {
  return `${col} > ${AGE_LATE_DAYS}`;
}

export function isAgeBandKey(v: string): boolean {
  return AGE_BANDS.some((b) => b.key === v);
}
