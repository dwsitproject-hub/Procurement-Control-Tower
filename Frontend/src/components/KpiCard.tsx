import type { Kpi } from '../lib/api';
import { DASH, formatKpi, formatMoney, formatNumber } from '../lib/format';
import { Lbl } from '../lib/labels';

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
// The first slot is the theme's heading colour, not the literal navy: the same
// #1F3864 in light mode, but readable in dark mode, where navy is the card
// background family and the value disappeared (functional test FT-40).
const CARD_PALETTE = ['var(--heading)', '#2E75B6', '#0D9488', '#7C3AED', '#ED7D31', '#4CAF50'];

function accentFor(kpi: Kpi): string {
  if (kpi.severity === 'critical') return '#C0392B';
  if (kpi.severity === 'warning') return '#F59E0B';
  if (kpi.severity === 'good') return '#4CAF50';
  // Stable per-KPI decoration: hash the id into the palette.
  let h = 0;
  for (const ch of kpi.kpiId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CARD_PALETTE[h % CARD_PALETTE.length]!;
}

export function KpiCard({
  kpi, onDrill, currency = 'USD',
}: {
  kpi: Kpi;
  onDrill: (token: string, label: string) => void;
  /** Display currency. Money cards switch only when the per-line-exact twin
      exists (detail.value_idr / value_usd); otherwise they keep their basis
      and say so — never a blended-rate guess. */
  currency?: 'USD' | 'IDR';
}) {
  if (kpi.status !== 'ok' || kpi.value === null) {
    return (
      <div className="kpi kpi--muted" title={kpi.statusReason ?? ''}>
        <div className="v">{DASH}</div>
        <div className="l"><Lbl k={`kpi:${kpi.kpiId}`}>{kpi.title}</Lbl></div>
        <div className="s">{kpi.statusReason ?? 'Not available'}</div>
      </div>
    );
  }
  const accent = accentFor(kpi);

  // Display-currency twin (per-line-exact, computed in the spec).
  const twinIdr = kpi.detail?.['value_idr'];
  const twinUsd = kpi.detail?.['value_usd'];
  let headline = formatKpi(kpi.value, kpi.unit);
  let basisNote: string | null = null;
  if (currency === 'IDR' && kpi.unit === 'usd') {
    if (twinIdr !== null && twinIdr !== undefined) {
      headline = formatMoney(Number(twinIdr), 'IDR');
      basisNote = `= ${formatKpi(kpi.value, 'usd')}`;
    } else {
      basisNote = 'IDR view unavailable (unrated period) — showing USD';
    }
  } else if (currency === 'USD' && kpi.unit === 'idr') {
    if (twinUsd !== null && twinUsd !== undefined) {
      headline = formatMoney(Number(twinUsd), 'USD');
      basisNote = `= ${formatKpi(kpi.value, 'idr')}`;
    } else if (kpi.kpiId !== 'pr_pipeline_value') {
      basisNote = 'USD view unavailable (unrated period) — showing IDR';
    }
  }

  const sub = subtitle(kpi);

  // v1's per-card urgency breakdown chips (G1.4), carried in the detail jsonb.
  const chips =
    kpi.detail && kpi.detail['chip_emergency'] !== undefined ? (
      <span className="kpi-chips">
        <span className="chip chip-emg" title="Emergency (urgency 1)">E {formatNumber(Number(kpi.detail['chip_emergency']))}</span>
        <span className="chip chip-urg" title="Urgent (urgency 2)">U {formatNumber(Number(kpi.detail['chip_urgent']))}</span>
        <span className="chip chip-std" title="Standard / planned">S {formatNumber(Number(kpi.detail['chip_standard']))}</span>
      </span>
    ) : kpi.detail && kpi.detail['gr_complete'] !== undefined ? (
      // v1's Delivered (GR) card: complete vs partial receipt split.
      <span className="kpi-chips">
        <span className="chip chip-ok" title="Fully received lines">✔ {formatNumber(Number(kpi.detail['gr_complete']))}</span>
        <span className="chip chip-urg" title="Partially received lines">◐ {formatNumber(Number(kpi.detail['gr_partial']))}</span>
      </span>
    ) : null;

  /*
   * Local / Import split (19 Nov 2026): Local = vendor code LN…, Import = IN….
   * Values are in the card's own unit; a type with no observation shows "—".
   */
  const vtFmt = (v: unknown): string => {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
    const n = Number(v);
    if (kpi.unit === 'percent') return `${n.toFixed(1)}%`;
    if (kpi.unit === 'days') return `${n.toFixed(1)} d`;
    return formatNumber(n);
  };
  const vendorSplit = kpi.detail && kpi.detail['vt_local'] !== undefined ? (
    <span className="kpi-chips kpi-vt">
      <span className="chip chip-vt-local"
        title={`Local suppliers (vendor code LN…): ${formatNumber(Number(kpi.detail['vt_local_n'] ?? 0))} observations`}>
        Local {vtFmt(kpi.detail['vt_local'])}
      </span>
      <span className="chip chip-vt-import"
        title={`Import suppliers (vendor code IN…): ${formatNumber(Number(kpi.detail['vt_import_n'] ?? 0))} observations`}>
        Import {vtFmt(kpi.detail['vt_import'])}
      </span>
    </span>
  ) : null;

  const body = (
    <>
      <div className="v">{headline}</div>
      <div className="l"><Lbl k={`kpi:${kpi.kpiId}`}>{kpi.title}</Lbl></div>
      <div className={vendorSplit ? 's s1' : 's'}>{basisNote ? `${basisNote} · ` : ''}{sub}{chips}</div>
      {/* Its own line (21 Nov 2026): inside the two-line subtitle the Local /
          Import row was clamped away on Delivered (GR). */}
      {vendorSplit && <div className="kpi-vt-row">{vendorSplit}</div>}
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
  if (kpi.kpiId === 'delivered_gr' && kpi.detail?.['qty_gr'] && kpi.detail?.['qty_pr']) {
    // v1's raw quantity compare - sums across units of measure, indicative only.
    const g = Number(kpi.detail['qty_gr']);
    const q = Number(kpi.detail['qty_pr']);
    parts.push(`Qty GR/PR ${formatNumber(g)} / ${formatNumber(q)} (${((g / q) * 100).toFixed(0)}%, raw units)`);
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
  if ((kpi.kpiId === 'open_pr_no_wbs' || kpi.kpiId === 'open_pr_with_wbs') && kpi.detail?.['chip_value_idr']) {
    parts.push(`${formatNumber(Number(kpi.numerator ?? 0))} PRs · ${(Number(kpi.detail['chip_value_idr']) / 1e9).toFixed(1)} B IDR`);
  }

  if (kpi.detail && kpi.detail['entityUnit']) {
    // The figure counts entities; the drill opens the rows behind them.
    parts.push('distinct ' + String(kpi.detail['entityUnit']) + ' — drill opens the lines');
  }

  if (kpi.unit === 'days' && kpi.detail) {
    // Whichever basis is the headline, the other stays in the subtitle so the
    // two remain reconcilable (avg headline on the stage cards, median on E2E).
    const avg = kpi.detail['avg'];
    const med = kpi.detail['median'];
    const p90 = kpi.detail['p90'];
    if (avg !== null && avg !== undefined) parts.push('avg ' + formatNumber(Number(avg), 1) + 'd');
    if (med !== null && med !== undefined) parts.push('median ' + formatNumber(Number(med)) + 'd');
    if (p90 !== null && p90 !== undefined) parts.push('p90 ' + formatNumber(Number(p90)) + 'd');
  }

  // The currency basis is part of the figure's meaning, not decoration.
  if (kpi.currencyBasis === 'idr_based') parts.push('(IDR-based %)');
  else if (kpi.currencyBasis === 'usd_strict') parts.push('USD, all currencies rated');
  else if (kpi.currencyBasis === 'per_currency') parts.push('per currency — not summed');

  // Not on a maximum (21 Nov 2026): "n = 13,200" under "Max PR Approval" read
  // as how many items took that long. The drill lists exactly those items.
  if (parts.length === 0 && kpi.sampleSize !== null && !NO_SAMPLE_KPIS.has(kpi.kpiId)) {
    parts.push(`n = ${formatNumber(kpi.sampleSize)}`);
  }
  return parts.join(' · ');
}

const NO_SAMPLE_KPIS = new Set(['max_pr_approval', 'oldest_unreleased']);

/** A Local / Import value in the card's own unit. */
function splitText(k: Kpi, v: unknown): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return DASH;
  const n = Number(v);
  if (k.unit === 'days') return `${n.toLocaleString('en-GB', { maximumFractionDigits: 1 })} d`;
  if (k.unit === 'percent') return `${n.toFixed(1)}%`;
  return formatNumber(n);
}

/**
 * Several related figures on ONE card, not clickable (21 Nov 2026, PR
 * Analysis): four cards that each answered "how long / how much on average"
 * were simplified into one. Each line keeps its own unit, and the display
 * currency switch applies to a money line exactly as on a single card.
 */
export function KpiSummaryCard({
  id, title, items, currency = 'USD',
}: {
  id: string;
  title: string;
  items: { kpi: Kpi | undefined; label: string }[];
  currency?: 'USD' | 'IDR';
}) {
  const line = (k: Kpi | undefined): string => {
    if (!k || k.status !== 'ok' || k.value === null) return DASH;
    if (currency === 'USD' && k.unit === 'idr' && k.detail?.['value_usd'] !== null && k.detail?.['value_usd'] !== undefined) {
      return formatMoney(Number(k.detail['value_usd']), 'USD');
    }
    if (currency === 'IDR' && k.unit === 'usd' && k.detail?.['value_idr'] !== null && k.detail?.['value_idr'] !== undefined) {
      return formatMoney(Number(k.detail['value_idr']), 'IDR');
    }
    // One decimal for days here: side by side, "3 d / 3 d / 3 d" hid that the
    // average is 3.2 while both medians are 3.
    if (k.unit === 'days') return `${Number(k.value).toLocaleString('en-GB', { maximumFractionDigits: 1 })} d`;
    return formatKpi(k.value, k.unit);
  };
  return (
    <div className="kpi kpi-multi" style={{ ['--c' as string]: 'var(--heading)' }}>
      <div className="l kpi-multi-h"><Lbl k={`kpi:${id}`}>{title}</Lbl></div>
      <dl className="kpi-multi-list">
        {items.map(({ kpi, label }) => (
          <div key={label} className="kpi-multi-item">
            <div className="kpi-multi-row" title={kpi?.statusReason ?? undefined}>
              <dt>{label}</dt>
              <dd>{line(kpi)}</dd>
            </div>
            {kpi?.detail && kpi.detail['vt_local'] !== undefined && (
              <div className="kpi-multi-vt">
                Local {splitText(kpi, kpi.detail['vt_local'])} · Import {splitText(kpi, kpi.detail['vt_import'])}
              </div>
            )}
          </div>
        ))}
      </dl>
    </div>
  );
}
