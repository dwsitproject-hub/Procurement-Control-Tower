import type { Kpi } from '../lib/api';
import { DASH, formatKpi, formatNumber } from '../lib/format';

/**
 * KPI card — the honesty rule in the UI.
 *
 * A KPI whose status is not 'ok' renders an em dash and the reason. Never 0,
 * never blank, never a plausible-looking substitute. That is what stops a
 * disabled Demand Realism reading as "0.3% — very bad" instead of
 * "not computable from this export".
 */
// v1's card palette (each .kc carries a --c accent). Severity still wins:
// a critical figure is red and a warning amber regardless of the decoration.
const CARD_PALETTE = ['#1F3864', '#2E75B6', '#0D9488', '#7C3AED', '#ED7D31', '#4CAF50'];

function accentFor(kpi: Kpi): string {
  if (kpi.severity === 'critical') return '#C0392B';
  if (kpi.severity === 'warning') return '#F59E0B';
  if (kpi.severity === 'good') return '#4CAF50';
  // Stable per-KPI decoration: hash the id into the palette.
  let h = 0;
  for (const ch of kpi.kpiId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CARD_PALETTE[h % CARD_PALETTE.length]!;
}

export function KpiCard({ kpi, onDrill }: { kpi: Kpi; onDrill: (token: string, label: string) => void }) {
  if (kpi.status !== 'ok' || kpi.value === null) {
    return (
      <div className="kpi kpi--muted" title={kpi.statusReason ?? ''}>
        <div className="v">{DASH}</div>
        <div className="l">{kpi.title}</div>
        <div className="s">{kpi.statusReason ?? 'Not available'}</div>
      </div>
    );
  }
  const accent = accentFor(kpi);

  const sub = subtitle(kpi);

  // v1's per-card urgency breakdown chips (G1.4), carried in the detail jsonb.
  const chips =
    kpi.detail && kpi.detail['chip_emergency'] !== undefined ? (
      <span className="kpi-chips">
        <span className="chip chip-emg" title="Emergency (urgency 1)">E {formatNumber(Number(kpi.detail['chip_emergency']))}</span>
        <span className="chip chip-urg" title="Urgent (urgency 2)">U {formatNumber(Number(kpi.detail['chip_urgent']))}</span>
        <span className="chip chip-std" title="Standard / planned">S {formatNumber(Number(kpi.detail['chip_standard']))}</span>
      </span>
    ) : null;

  const body = (
    <>
      <div className="v">{formatKpi(kpi.value, kpi.unit)}</div>
      <div className="l">{kpi.title}</div>
      <div className="s">{sub}{chips}</div>
    </>
  );

  // A card with no drill predicate renders as a div, NOT a disabled button.
  // Chrome greys disabled button text, so a perfectly valid figure read as the
  // unavailable state — and a disabled button with no accessible name is a
  // focusable control that announces nothing.
  if (!kpi.drillToken) {
    return (
      <div
        className="kpi"
        data-sev={kpi.severity ?? 'neutral'}
        style={{ ['--c' as string]: accent }}
        title={sub}
      >
        {body}
      </div>
    );
  }

  const token = kpi.drillToken;
  return (
    <button
      className="kpi"
      data-sev={kpi.severity ?? 'neutral'}
      style={{ ['--c' as string]: accent }}
      onClick={() => onDrill(token, kpi.title)}
      title={`${sub ? `${sub}
` : ''}Click to see the rows behind this figure`}
    >
      {body}
    </button>
  );
}

function subtitle(kpi: Kpi): string {
  const parts: string[] = [];

  if (kpi.kpiId === 'expedite_effectiveness' && kpi.detail) {
    parts.push(
      `urgent ${kpi.detail['urgentMedianDays']}d vs standard ${kpi.detail['standardMedianDays']}d`,
    );
  }
  if (kpi.kpiId === 'wbs_compliance' && kpi.detail) {
    parts.push(`${formatNumber(Number(kpi.detail['violationPrs']))} PRs`);
    // The threshold in force must be visible wherever the number is.
    if (kpi.detail['thresholdLabel']) parts.push(String(kpi.detail['thresholdLabel']));
  }
  if (kpi.kpiId === 'direct_po_share' && kpi.detail) {
    parts.push(`${formatNumber(Number(kpi.detail['directLines']))} lines with no requisition`);
  }
  if (kpi.kpiId === 'sto_share' && kpi.detail) {
    parts.push(`${formatNumber(Number(kpi.detail['stoLines']))} transport lines`);
  }
  if (kpi.kpiId === 'split_sourcing' && kpi.detail) {
    parts.push(`max ${kpi.detail['maxPoLinesPerPrItem']} PO lines on one item`);
  }
  if (kpi.kpiId === 'pending_po_approvals' && kpi.detail) {
    parts.push(`${kpi.detail['releaseExemptExcluded']} release-exempt excluded`);
  }
  if (kpi.kpiId === 'pr_pipeline_value' && kpi.detail?.['idr_total']) {
    parts.push(`= IDR ${(Number(kpi.detail['idr_total']) / 1e12).toFixed(2)}T (source valuation)`);
  }
  if (kpi.kpiId === 'top_vendor_share_pct' && kpi.detail?.['top_vendor']) {
    parts.push(String(kpi.detail['top_vendor']));
  }
  if (kpi.kpiId === 'worst_approver_gap' && kpi.detail?.['worst_pic']) {
    parts.push(String(kpi.detail['worst_pic']));
  }
  if (kpi.kpiId === 'wbs_open_violations' && kpi.detail?.['chip_value_idr']) {
    parts.push(`${formatNumber(Number(kpi.numerator ?? 0))} PRs · ${(Number(kpi.detail['chip_value_idr']) / 1e9).toFixed(1)} B IDR`);
  }

  if (kpi.detail && kpi.detail['entityUnit']) {
    // The figure counts entities; the drill opens the rows behind them.
    parts.push('distinct ' + String(kpi.detail['entityUnit']) + ' — drill opens the lines');
  }

  if (kpi.unit === 'days' && kpi.detail && kpi.detail['avg'] !== undefined) {
    // Median is the headline; v1 showed the average, so both stay visible and
    // the two remain reconcilable against v1.
    const avg = kpi.detail['avg'];
    const p90 = kpi.detail['p90'];
    if (avg !== null) parts.push('avg ' + formatNumber(Number(avg), 1) + 'd');
    if (p90 !== null && p90 !== undefined) parts.push('p90 ' + formatNumber(Number(p90)) + 'd');
  }

  // The currency basis is part of the figure's meaning, not decoration.
  if (kpi.currencyBasis === 'idr_based') parts.push('(IDR-based %)');
  else if (kpi.currencyBasis === 'usd_strict') parts.push('USD, all currencies rated');
  else if (kpi.currencyBasis === 'per_currency') parts.push('per currency — not summed');

  if (parts.length === 0 && kpi.sampleSize !== null) parts.push(`n = ${formatNumber(kpi.sampleSize)}`);
  return parts.join(' · ');
}
