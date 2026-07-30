/**
 * WBS / Appropriation Request policy — PRD §12.7, decision D1.
 *
 * Decision D1 (resolved 30 Jul 2026): per item; the measured 89.7%
 * non-compliance rate is real; thresholds are administrator-configurable at
 * runtime with an effective date.
 *
 * Reference data: 1,247 items over threshold, 1,119 (89.7%) missing WBS across
 * 339 PRs, IDR 3,482,267,279,089 at risk. 4,211 items (20.9%) carry
 * `Total Value = 0` and are therefore untestable at any threshold.
 */

export type WbsStatus = 'compliant' | 'violation' | 'not_required' | 'indeterminate';

export type WbsBasis = 'per_item' | 'per_pr_total';

export interface WbsConfig {
  readonly materialThresholdIdr: number;
  readonly serviceThresholdIdr: number;
  readonly basis: WbsBasis;
}

export const DEFAULT_WBS_CONFIG: WbsConfig = {
  materialThresholdIdr: 30_000_000,
  serviceThresholdIdr: 150_000_000,
  basis: 'per_item',
};

export interface WbsItemInput {
  /** null/blank material code => service item, which uses the higher threshold */
  readonly materialCode: string | null;
  readonly totalValueIdr: number | null;
  readonly wbsElement: string | null;
}

/** Which threshold applies to this item. */
export function wbsThresholdFor(materialCode: string | null, cfg: WbsConfig): number {
  const isService = (materialCode ?? '').trim() === '';
  return isService ? cfg.serviceThresholdIdr : cfg.materialThresholdIdr;
}

/**
 * Per-item evaluation.
 *
 * A zero or missing valuation yields 'indeterminate', never 'compliant':
 * absence of data is not evidence of compliance. This is a distinct reported
 * bucket, not a rounding-down of the violation count.
 */
export function wbsStatus(item: WbsItemInput, cfg: WbsConfig = DEFAULT_WBS_CONFIG): WbsStatus {
  if (item.totalValueIdr === null || item.totalValueIdr === 0) return 'indeterminate';

  // Negative valuations are data anomalies, not sub-threshold items.
  if (item.totalValueIdr < 0) return 'indeterminate';

  const threshold = wbsThresholdFor(item.materialCode, cfg);
  if (item.totalValueIdr < threshold) return 'not_required';

  return (item.wbsElement ?? '').trim() !== '' ? 'compliant' : 'violation';
}

/**
 * Per-PR-total variant, retained because decision D1 keeps the basis
 * configurable. Aggregates item values to PR level and applies the material
 * threshold if ANY item carries a material code.
 */
export function wbsStatusPrTotal(
  items: readonly WbsItemInput[],
  cfg: WbsConfig = DEFAULT_WBS_CONFIG,
): WbsStatus {
  if (items.length === 0) return 'indeterminate';

  const values = items.map((i) => i.totalValueIdr);
  if (values.every((v) => v === null || v === 0)) return 'indeterminate';

  const total = values.reduce<number>((s, v) => s + (v ?? 0), 0);
  const anyMaterial = items.some((i) => (i.materialCode ?? '').trim() !== '');
  const threshold = anyMaterial ? cfg.materialThresholdIdr : cfg.serviceThresholdIdr;

  if (total < threshold) return 'not_required';
  return items.some((i) => (i.wbsElement ?? '').trim() !== '') ? 'compliant' : 'violation';
}

/** Human-readable label for the threshold in force. Must appear on the card. */
export function wbsThresholdLabel(cfg: WbsConfig, effectiveFrom: string | null): string {
  const fmt = (n: number) => `IDR ${(n / 1_000_000).toLocaleString('en-GB')}M`;
  const basis = cfg.basis === 'per_item' ? 'per item' : 'per PR total';
  const eff = effectiveFrom ? ` · effective ${effectiveFrom}` : '';
  return `≥ ${fmt(cfg.materialThresholdIdr)} material / ≥ ${fmt(cfg.serviceThresholdIdr)} service · ${basis}${eff}`;
}
