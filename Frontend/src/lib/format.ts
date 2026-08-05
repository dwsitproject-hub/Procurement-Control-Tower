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
  // Compact tiers keep card values on ONE line — "IDR 1,550,720.33M" wrapped
  // and broke the card grid. v1 uses the same B-IDR notation.
  if (abs >= 1_000_000_000_000) {
    return `${prefix}${(v / 1_000_000_000_000).toLocaleString('en-GB', { maximumFractionDigits: 2 })}T`;
  }
  if (abs >= 1_000_000_000) {
    return `${prefix}${(v / 1_000_000_000).toLocaleString('en-GB', { maximumFractionDigits: 2 })}B`;
  }
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
  retroPo: { icon: '⟲', label: 'Retro PO — ordered before the requisition was approved' },
  wbsViolation: { icon: '§', label: 'Over the WBS threshold with no WBS Element' },
};

/** v1's sCls status-pill palette, verbatim. Partially Delivered takes the
 *  Delivered pill because v1 marks any row with a GR as Delivered. */
export const STATUS_PILL: Record<string, string> = {
  Delivered: 'sd',
  'Partially Delivered': 'sd',
  'PO-No GR': 'su',
  'HOLD PO': 'shold',
  'PO-Not Approved': 'sp',
  'PO-Deleted': 'spdel',
  'PR Approved-No PO': 'sn',
  'Unapproved PR': 'sa',
};

/** v1's rCls row classes: per-status left-border tints, deleted dimmed,
 *  every other remaining row striped. */
export function rowClass(status: string, i: number): string {
  switch (status) {
    case 'Unapproved PR': return 'ra';
    case 'PR Approved-No PO': return 'rb';
    case 'HOLD PO': return 'rhold';
    case 'PO-Not Approved': return 'rp';
    case 'PO-No GR': return 'rc';
    case 'Deleted':
    case 'PO-Deleted': return 'rd';
    default: return i % 2 ? '' : 're';
  }
}

/** v1's aging cell class: over 2x the warn threshold red, over it amber. */
export function agingClass(v: number, warn: number): string {
  return v > warn * 2 ? 'ag bd' : v > warn ? 'ag wn' : 'ag ok';
}

/** v1's dd-modal value cell: >= 1M shown as 'x.x M' (tabular, ccy tag beside). */
export function moneyCellText(v: number): string {
  return Math.abs(v) >= 1e6
    ? (v / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' M'
    : v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
