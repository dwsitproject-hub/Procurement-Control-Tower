/**
 * FX consolidation — PRD §12.6, decision D3 (period-matched, resolved 30 Jul 2026).
 *
 * A document converts at its OWN month's average rate. v1 kept only the newest
 * month per currency pair, so January POs were valued at July rates.
 *
 * Strict no-silent-conversion is preserved throughout: an unresolvable rate
 * yields null, never 0, and never a defaulted local currency.
 */

export type FxDerivation = 'direct' | 'inverted' | 'triangulated';
export type FxBasis = 'period_matched' | 'nearest_earlier' | 'fallback_latest' | 'unavailable';
export type FxPolicy = 'period_matched' | 'latest';

export interface FxRate {
  readonly currency: string;
  readonly year: number;
  readonly month: number;
  /** USD per 1 unit of `currency`. */
  readonly usdPerUnit: number;
  readonly derivation: FxDerivation;
  readonly pivotCurrency: string | null;
}

export interface FxResolution {
  readonly usdPerUnit: number | null;
  readonly year: number | null;
  readonly month: number | null;
  readonly basis: FxBasis;
}

const UNAVAILABLE: FxResolution = { usdPerUnit: null, year: null, month: null, basis: 'unavailable' };

function rateKey(currency: string, year: number, month: number): string {
  return `${currency}|${year}|${month}`;
}

/**
 * An indexed rate table. Built once per dataset version.
 */
export class FxTable {
  private readonly byKey = new Map<string, FxRate>();
  private readonly byCurrency = new Map<string, FxRate[]>();

  constructor(rates: readonly FxRate[]) {
    for (const r of rates) {
      this.byKey.set(rateKey(r.currency, r.year, r.month), r);
      const list = this.byCurrency.get(r.currency);
      if (list) list.push(r);
      else this.byCurrency.set(r.currency, [r]);
    }
    // Newest first, so "latest" and "nearest earlier" are cheap scans.
    for (const list of this.byCurrency.values()) {
      list.sort((a, b) => b.year - a.year || b.month - a.month);
    }
  }

  get currencies(): string[] {
    return [...this.byCurrency.keys()];
  }

  has(currency: string): boolean {
    return currency === 'USD' || this.byCurrency.has(currency);
  }

  /**
   * Resolve the rate for a document. Fallback chain per PRD §12.6:
   *   exact month -> nearest earlier month -> latest available -> unavailable.
   */
  resolve(currency: string | null, documentDate: string | null, policy: FxPolicy = 'period_matched'): FxResolution {
    if (currency === null) return UNAVAILABLE;
    if (currency === 'USD') {
      return { usdPerUnit: 1, year: null, month: null, basis: 'period_matched' };
    }

    const list = this.byCurrency.get(currency);
    if (!list || list.length === 0) return UNAVAILABLE;

    const latest = list[0]!;

    if (policy === 'latest' || documentDate === null) {
      return {
        usdPerUnit: latest.usdPerUnit,
        year: latest.year,
        month: latest.month,
        basis: documentDate === null ? 'fallback_latest' : 'period_matched',
      };
    }

    const year = Number(documentDate.slice(0, 4));
    const month = Number(documentDate.slice(5, 7));
    if (!Number.isInteger(year) || !Number.isInteger(month)) return UNAVAILABLE;

    const exact = this.byKey.get(rateKey(currency, year, month));
    if (exact) {
      return { usdPerUnit: exact.usdPerUnit, year, month, basis: 'period_matched' };
    }

    const earlier = list.find((r) => r.year < year || (r.year === year && r.month <= month));
    if (earlier) {
      return {
        usdPerUnit: earlier.usdPerUnit,
        year: earlier.year,
        month: earlier.month,
        basis: 'nearest_earlier',
      };
    }

    return {
      usdPerUnit: latest.usdPerUnit,
      year: latest.year,
      month: latest.month,
      basis: 'fallback_latest',
    };
  }

  /** Convert an amount. Null in, null out; unresolvable rate, null out. */
  toUsd(
    amount: number | null,
    currency: string | null,
    documentDate: string | null,
    policy: FxPolicy = 'period_matched',
  ): { usd: number | null; resolution: FxResolution } {
    const resolution = this.resolve(currency, documentDate, policy);
    if (amount === null || resolution.usdPerUnit === null) {
      return { usd: null, resolution };
    }
    return { usd: amount * resolution.usdPerUnit, resolution };
  }
}

/**
 * Raw rate row as it arrives from the SAP rate export.
 * The reference file layout is: Month | From | To | Average of Rate.
 */
export interface RawFxRow {
  readonly from: string;
  readonly to: string;
  readonly rate: number;
  readonly year: number;
  readonly month: number;
  readonly ratio?: number | null;
}

/**
 * Build a USD-anchored table from raw pairs.
 *
 * Handles three cases:
 *   1. direct        USD -> X  =>  usdPerUnit(X) = 1 / rate
 *   2. inverted      X -> USD  =>  usdPerUnit(X) = rate
 *   3. triangulated  X -> P and USD -> P for a shared pivot P
 *                    =>  usdPerUnit(X) = rate(X->P) / rate(USD->P)
 *
 * v1 implemented only (1) and (2) and explicitly skipped cross pairs. On the
 * reference file that happened to lose nothing, because direct `US$ -> X` rows
 * exist for all 15 currencies. But a rate variant exporting only `X -> IDR`
 * would have silently lost every currency except IDR while a USD anchor
 * (`US$ -> IDR`) sat in the same file. Triangulation removes that fragility.
 */
export function buildFxTable(rows: readonly RawFxRow[]): FxRate[] {
  const out = new Map<string, FxRate>();

  const put = (r: FxRate) => {
    const k = rateKey(r.currency, r.year, r.month);
    const existing = out.get(k);
    // Prefer direct/inverted over triangulated when both are available.
    if (!existing || rank(r.derivation) < rank(existing.derivation)) out.set(k, r);
  };

  const eff = (r: RawFxRow) => (r.ratio && r.ratio > 0 ? r.rate / r.ratio : r.rate);

  // Passes 1 and 2: pairs that involve USD directly.
  for (const r of rows) {
    if (!Number.isFinite(r.rate) || r.rate <= 0) continue;
    const v = eff(r);
    if (r.from === 'USD' && r.to !== 'USD') {
      put({ currency: r.to, year: r.year, month: r.month, usdPerUnit: 1 / v, derivation: 'direct', pivotCurrency: null });
    } else if (r.to === 'USD' && r.from !== 'USD') {
      put({ currency: r.from, year: r.year, month: r.month, usdPerUnit: v, derivation: 'inverted', pivotCurrency: null });
    }
  }

  // Pass 3: triangulate cross pairs through any pivot that has a USD rate.
  // Index USD -> pivot rates per period.
  const usdToPivot = new Map<string, number>();
  for (const r of rows) {
    if (!Number.isFinite(r.rate) || r.rate <= 0) continue;
    const v = eff(r);
    if (r.from === 'USD' && r.to !== 'USD') usdToPivot.set(rateKey(r.to, r.year, r.month), v);
    else if (r.to === 'USD' && r.from !== 'USD') usdToPivot.set(rateKey(r.from, r.year, r.month), 1 / v);
  }

  for (const r of rows) {
    if (!Number.isFinite(r.rate) || r.rate <= 0) continue;
    if (r.from === 'USD' || r.to === 'USD') continue;
    const v = eff(r);
    const pivotRate = usdToPivot.get(rateKey(r.to, r.year, r.month));
    if (pivotRate !== undefined && pivotRate > 0) {
      // rate is (to per from); pivotRate is (to per USD)
      put({
        currency: r.from,
        year: r.year,
        month: r.month,
        usdPerUnit: v / pivotRate,
        derivation: 'triangulated',
        pivotCurrency: r.to,
      });
    }
  }

  return [...out.values()];
}

function rank(d: FxDerivation): number {
  return d === 'direct' ? 0 : d === 'inverted' ? 1 : 2;
}

/**
 * Strict no-silent-conversion aggregation.
 *
 * A USD total exists only if EVERY currency present in scope is convertible.
 * Otherwise the caller must render the per-currency breakdown. This is the rule
 * that prevented v1 from ever showing a total that quietly excluded a currency.
 */
export function strictUsdTotal(
  amountsByCurrency: ReadonlyMap<string, number>,
  rateFor: (ccy: string) => number | null,
): { usd: number | null; missing: string[] } {
  let total = 0;
  const missing: string[] = [];
  for (const [ccy, amt] of amountsByCurrency) {
    const r = rateFor(ccy);
    if (r === null) missing.push(ccy);
    else total += amt * r;
  }
  if (missing.length > 0) return { usd: null, missing: missing.sort() };
  return { usd: total, missing: [] };
}

/**
 * The reference rate file's `Month` column has NO year ('1.Jan' .. '7.Jul').
 * v1 parsed the ordinal against a hardcoded year 2000 and displayed a 2000 date
 * to users; a bundle spanning December to January would order the months wrongly.
 *
 * We anchor the year from the batch's own data range. If the months span a
 * year boundary the anchor is ambiguous and the caller must raise a BLOCKER.
 */
export function anchorYear(
  monthOrdinals: readonly number[],
  dataMinDate: string,
  dataMaxDate: string,
): { year: number | null; ambiguous: boolean } {
  if (monthOrdinals.length === 0) return { year: null, ambiguous: false };

  const minYear = Number(dataMinDate.slice(0, 4));
  const maxYear = Number(dataMaxDate.slice(0, 4));
  const lo = Math.min(...monthOrdinals);
  const hi = Math.max(...monthOrdinals);

  // A contiguous ascending run inside one calendar year is unambiguous.
  if (minYear === maxYear) return { year: maxYear, ambiguous: false };

  // Data spans years: only safe if the month run does not wrap.
  if (lo <= hi && hi - lo === monthOrdinals.length - 1) {
    return { year: maxYear, ambiguous: false };
  }
  return { year: null, ambiguous: true };
}

/** Parse '1.Jan', '7-Jul', '03', 'Mar' to a month ordinal. */
export function parseMonthOrdinal(raw: unknown): number | null {
  const s = String(raw ?? '').trim();
  if (s === '') return null;

  let m = /^(\d{1,2})\s*[.\-/_ ]/.exec(s);
  if (m) {
    const n = +m[1]!;
    return n >= 1 && n <= 12 ? n : null;
  }
  if (/^\d{1,2}$/.test(s)) {
    const n = +s;
    return n >= 1 && n <= 12 ? n : null;
  }
  const names = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const lower = s.toLowerCase();
  const idx = names.findIndex((n) => lower.startsWith(n) || lower.includes(n));
  return idx >= 0 ? idx + 1 : null;
}
