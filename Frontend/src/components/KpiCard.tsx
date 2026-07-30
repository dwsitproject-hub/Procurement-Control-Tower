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

  const sub = subtitle(kpi);

  return (
    <button
      className="kpi"
      data-sev={kpi.severity ?? 'neutral'}
      disabled={!kpi.drillToken}
      onClick={() => kpi.drillToken && onDrill(kpi.drillToken, kpi.title)}
      title={kpi.drillToken ? 'Click to see the rows behind this figure' : undefined}
    >
      <div className="v">{formatKpi(kpi.value, kpi.unit)}</div>
      <div className="l">{kpi.title}</div>
      <div className="s">{sub}</div>
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

  // The currency basis is part of the figure's meaning, not decoration.
  if (kpi.currencyBasis === 'idr_based') parts.push('(IDR-based %)');
  else if (kpi.currencyBasis === 'usd_strict') parts.push('USD, all currencies rated');
  else if (kpi.currencyBasis === 'per_currency') parts.push('per currency — not summed');

  if (parts.length === 0 && kpi.sampleSize !== null) parts.push(`n = ${formatNumber(kpi.sampleSize)}`);
  return parts.join(' · ');
}
