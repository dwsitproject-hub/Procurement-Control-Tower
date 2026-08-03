import type { Kpi } from '../lib/api';
import { DASH, formatNumber } from '../lib/format';

/**
 * v1's wide Overview cards: value + label on the left, a right-hand column of
 * detail rows (urgency split, GR completeness, quantity compare). Data comes
 * from the KPI's detail jsonb — same figures as the chips, v1's arrangement.
 */
export function OverviewCard({
  kpi, onDrill,
}: { kpi: Kpi; onDrill: (t: string, l: string) => void }) {
  const d = kpi.detail ?? {};
  const rows: { dot: string; label: string; value: string; strong?: boolean }[] = [];

  if (d['chip_emergency'] !== undefined) {
    rows.push(
      { dot: '#C0392B', label: 'Emergency', value: formatNumber(Number(d['chip_emergency'])) },
      { dot: '#ED7D31', label: 'Urgent', value: formatNumber(Number(d['chip_urgent'])) },
      { dot: '#2E75B6', label: 'Standard', value: formatNumber(Number(d['chip_standard'])) },
    );
  }
  if (d['gr_complete'] !== undefined) {
    rows.push(
      { dot: '#4CAF50', label: 'Complete GR', value: formatNumber(Number(d['gr_complete'])) },
      { dot: '#F59E0B', label: 'Partial GR', value: formatNumber(Number(d['gr_partial'])) },
    );
    if (d['qty_gr'] && d['qty_pr']) {
      const g = Number(d['qty_gr']);
      const q = Number(d['qty_pr']);
      rows.push({
        dot: '', label: 'Qty Compare (GR / PR)',
        value: `${formatNumber(g)} / ${formatNumber(q)} (${((g / q) * 100).toFixed(0)}%)`,
        strong: true,
      });
    }
  }

  const body = (
    <>
      <div className="ovc-main">
        <div className="v">{kpi.value === null ? DASH : formatNumber(Number(kpi.value))}</div>
        <div className="l">{kpi.title}</div>
        {kpi.sampleSize !== null && <div className="s">n = {formatNumber(kpi.sampleSize)}</div>}
      </div>
      <div className="ovc-rows" title="Quantity compare raw-sums across units of measure — indicative only">
        {rows.map((r) => (
          <div key={r.label} className="ovc-row">
            {r.dot && <span className="ovc-dot" style={{ background: r.dot }} />}
            <span className="ovc-lbl">{r.label}</span>
            <span className={r.strong ? 'ovc-val ovc-strong' : 'ovc-val'}>{r.value}</span>
          </div>
        ))}
      </div>
    </>
  );

  if (!kpi.drillToken) {
    return <div className="ovc" data-k={kpi.kpiId}>{body}</div>;
  }
  const token = kpi.drillToken;
  return (
    <button className="ovc" data-k={kpi.kpiId} title="Click to see the rows behind this figure"
      onClick={() => onDrill(token, kpi.title)}>
      {body}
    </button>
  );
}
