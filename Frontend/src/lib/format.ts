/**
 * Display formatting.
 *
 * The one rule that matters here: a null NEVER renders as 0. It renders as an
 * em dash, because the difference between "we do not know" and "it is zero" is
 * the whole point of the product's honesty guarantee.
 */

export const DASH = '—';

/**
 * Adaptive units: millions only at >= 1,000,000, the full amount below that.
 * This is the v1 review's 2,325 USD case — a small foreign-currency value must
 * stay readable rather than rounding to "0M".
 */
export function formatMoney(v: number | null, ccy?: string): string {
  if (v === null || v === undefined || Number.isNaN(v)) return DASH;
  const prefix = ccy ? `${ccy} ` : '';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) {
    return `${prefix}${(v / 1_000_000).toLocaleString('en-GB', { maximumFractionDigits: 2 })}M`;
  }
  return `${prefix}${v.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
}

export function formatNumber(v: number | null, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return DASH;
  return v.toLocaleString('en-GB', { maximumFractionDigits: digits });
}

export function formatKpi(v: number | null, unit: string): string {
  if (v === null || v === undefined || Number.isNaN(v)) return DASH;
  switch (unit) {
    case 'percent':
      return `${v.toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`;
    case 'ratio':
      return `${v.toLocaleString('en-GB', { maximumFractionDigits: 2 })}×`;
    case 'days':
      return `${v.toLocaleString('en-GB', { maximumFractionDigits: 0 })} d`;
    case 'usd':
      return formatMoney(v, 'USD');
    case 'idr':
      return formatMoney(v, 'IDR');
    default:
      return formatNumber(v);
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return String(iso);
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${m[3]} ${months[Number(m[2])]} ${m[1]}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${formatDate(d.toISOString())} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

export function formatCell(v: unknown, type: string, currency?: string): string {
  if (v === null || v === undefined || v === '') return DASH;
  switch (type) {
    case 'money':
      return formatMoney(Number(v), currency);
    case 'number':
      return formatNumber(Number(v), 3);
    case 'int':
      return formatNumber(Number(v));
    case 'date':
      return formatDate(String(v));
    case 'pct':
      return `${formatNumber(Number(v), 1)}%`;
    default:
      return String(v);
  }
}

/** Row markers. Severity is never conveyed by colour alone. */
export const FLAG_META: Record<string, { icon: string; label: string }> = {
  sto: { icon: '🚚', label: 'Stock transport order — unpriced, excluded from price analytics' },
  tokenPrice: { icon: '⚠', label: 'Token price — not real spend' },
  releaseExempt: {
    icon: '⚑',
    label: 'No release strategy applies to this PO; no release record exists',
  },
  danglingLink: { icon: '⛓', label: 'References a requisition absent from the PR feed' },
  directPo: { icon: '·', label: 'Direct PO — no requisition' },
};
