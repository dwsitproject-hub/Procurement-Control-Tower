/**
 * Stock Transport Order segregation — PRD §12.5.
 *
 * Validated against the reference export: `EU70` = 4,453 lines across 767 POs,
 * 100% carrying a `Req. Tracking Number`, 100% with `Net Price = 0`. No other
 * document type in the data ends in '70'.
 *
 * The rule is exactly ends-with. Other series (EO21, SC21, PS21, JP21 — 12 lines
 * total) flow as normal purchases until the business specifies otherwise.
 */

export const DEFAULT_STO_SUFFIX = '70';

export function isSto(docType: string | null, suffix: string = DEFAULT_STO_SUFFIX): boolean {
  if (docType === null) return false;
  const t = docType.trim();
  if (t === '') return false;
  return t.endsWith(suffix);
}

/**
 * Which analytics populations an STO line participates in.
 *
 * Excluded from: price and unit-price analytics, PO count and average value,
 * category quantity, vendor spend, token-price warnings.
 * Retained in: delivery and receipt analytics, in-transit views.
 */
export interface StoParticipation {
  readonly priceAnalytics: boolean;
  readonly spendAnalytics: boolean;
  readonly poCountAnalytics: boolean;
  readonly deliveryAnalytics: boolean;
  readonly tokenPriceWarning: boolean;
}

export function stoParticipation(sto: boolean): StoParticipation {
  return sto
    ? {
        priceAnalytics: false,
        spendAnalytics: false,
        poCountAnalytics: false,
        deliveryAnalytics: true,
        tokenPriceWarning: false,
      }
    : {
        priceAnalytics: true,
        spendAnalytics: true,
        poCountAnalytics: true,
        deliveryAnalytics: true,
        tokenPriceWarning: true,
      };
}

/**
 * Token price: a deliberate placeholder in SAP (e.g. 1 per 10,000) that is not
 * real spend. STO lines are excluded by rule — including them would report
 * 4,527 "token" lines on the reference data instead of the genuine 107.
 */
export function isTokenPrice(netPrice: number | null, sto: boolean): boolean {
  if (sto) return false;
  if (netPrice === null) return false;
  return netPrice > 0 && netPrice <= 1;
}

export function isZeroPriceAnomaly(netPrice: number | null, sto: boolean): boolean {
  if (sto) return false;
  return netPrice === 0;
}

/**
 * Unit price must divide by `Price unit` — 398 lines in the reference export
 * have price_unit > 1. Ignoring it overstates unit price by up to 100x.
 */
export function unitPrice(netPrice: number | null, priceUnit: number | null): number | null {
  if (netPrice === null) return null;
  const pu = priceUnit === null || priceUnit <= 0 ? 1 : priceUnit;
  return netPrice / pu;
}
