import { useCallback, useEffect, useState } from 'react';
import { api, type ChartResponse, type Kpi } from '../lib/api';
import { formatMoney, formatNumber } from '../lib/format';
import { ExecFocusModal } from './ExecFocusModal';
import { LayoutControls, applyLayout, panelSpan, type TabLayout } from './LayoutEdit';

/**
 * Executive Summary — the one page that states a conclusion rather than
 * presenting a measurement.
 *
 * Built from a reference design (20 Aug 2026) with four deliberate departures,
 * each because the original could not be reproduced honestly:
 *
 * 1. NO "HO vs UNIT" PANEL. The design showed Head Office holding 92% of value
 *    against 51% of PO lines. Measured here it is 2% / 17% — inverted — because
 *    NO Head-Office purchasing group appears in this entity's orders at all.
 *    The panel would have told the reader the opposite of the truth. Desk and
 *    vendor concentration carries the same strategic point (a few control the
 *    money, many run the paperwork) and is measurable.
 *
 * 2. "COMMITTED VALUE", NOT "SPEND". The figure is net order value: what was
 *    ORDERED. Calling it spend, as the design did, invites an argument with
 *    finance that the label settles for free.
 *
 * 3. THE PERIOD IS STATED, NOT IMPLIED. The design was headed "2025" and
 *    "annual spend" over what is in fact a part-year extract of one entity. The
 *    scope line below reads the dataset's own dates, so it cannot drift.
 *
 * 4. EVERY CLAIM IS COMPUTED. "top 5 = 70%" and "72% of lines < Rp 25 Jt = 4%
 *    of value" were static text. Here they are KPIs, swept for drill parity
 *    like everything else, so they cannot silently go stale.
 *
 * The action plan from the design is intentionally absent: it is a set of
 * commitments, not data, and static text in a live dashboard rots. It belongs
 * in the board pack, or in an admin-editable block if it must live here.
 */

interface Props {
  kpis: Kpi[];
  /**
   * The global filter as a query string.
   *
   * Passed through to both chart fetches. Until now this page ignored it
   * entirely: the filter bar sat at the top and did nothing to either panel,
   * because a chart is only recomputed under a filter when it has a live spec —
   * these two now do (see PARITY_CHARTS).
   */
  filterQuery: string;
  /** The Overview's own KPI and chart lists, so the focus panel mirrors it. */
  overviewKpis: string[];
  overviewCharts: string[];
  onDrill: (token: string, label: string) => void;
  currency: 'USD' | 'IDR';
  asOfDate: string | null;
  firstDate?: string | null;
  /**
   * The page's saved layout, so its SECTIONS can be reordered and hidden like
   * the card slots on every other page. This page renders panels rather than
   * slots, so it was the one page the layout editor could not touch.
   */
  layout: TabLayout;
  update: (mut: (cur: TabLayout) => TabLayout) => void;
  editing: boolean;
}

/** Rupiah on the Jt / Bio / T ladder — ONE ladder, used everywhere on this page. */
function rupiah(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return 'Rp ' + (v / 1e12).toFixed(2) + ' T';
  if (abs >= 1e9) return 'Rp ' + formatNumber(Math.round(v / 1e9)) + ' Bio';
  if (abs >= 1e6) return 'Rp ' + formatNumber(Math.round(v / 1e6)) + ' Jt';
  return 'Rp ' + formatNumber(Math.round(v));
}

function pct(v: number | null, dp = 1): string {
  return v === null || !Number.isFinite(v) ? '—' : v.toFixed(dp) + '%';
}

/**
 * A ranked horizontal bar list, each bar STACKED into Open and Closed.
 *
 * Stacked rather than grouped on purpose: open + closed is the category's total,
 * so the ranking and the share the panel is read for survive the split instead of
 * being replaced by two half-height bars that no longer show which category is
 * biggest.
 *
 * Written rather than reusing ChartPanel because this is the page's signature
 * panel and the design is horizontal-and-ranked — and because the ordering is the
 * point. The reference chart was NOT correctly ranked (Coal at 127 Bio sat below
 * Bleaching Earth at 85), so the order here is derived from the total and cannot
 * be got wrong.
 *
 * `emphasiseTop` shades the leading N bars, matching the design's red/grey cut;
 * the caption below the panel states where the cut falls, which the reference
 * design left unexplained.
 *
 * Each SEGMENT is separately clickable and opens the focus panel for that slice
 * — "Open METHANOL" — rather than a bare row list. Rows drilling to lines is
 * still available from inside that panel.
 */
function RankedBars({ data, onFocus, emphasiseTop, currency }: {
  data: ChartResponse;
  onFocus: (title: string, subtitle: string, slice: string) => void;
  emphasiseTop: number;
  currency: 'USD' | 'IDR';
}) {
  /**
   * The currency toggle picks between twin series, the same `*_idr` suffix
   * convention ChartPanel uses. The panel previously read the IDR series
   * unconditionally and formatted it with the rupiah ladder, so switching the
   * header to USD changed the tiles and left this panel saying Rp.
   */
  const suffix = currency === 'IDR' ? '_idr' : '';
  const openS = data.series.find((x) => x.key === `open${suffix}`)
    ?? data.series.find((x) => x.key === 'open_idr');
  const closedS = data.series.find((x) => x.key === `closed${suffix}`)
    ?? data.series.find((x) => x.key === 'closed_idr');
  // Whichever twin was actually resolved decides the formatting, so a fallback
  // can never print USD figures with a rupiah label.
  const money = (v: number | null): string =>
    (openS?.key.endsWith('_idr') ?? true) ? rupiah(v) : formatMoney(v, 'USD');
  if (!openS && !closedS) return <p className="muted">No data.</p>;

  const at = (key: string, s: typeof openS) =>
    s?.points.find((pt) => pt.bucketKey === key) ?? null;

  const rows = data.buckets
    .map((b) => {
      const o = at(b.key, openS);
      const c = at(b.key, closedS);
      return { key: b.key, label: b.label, o, c, total: (o?.value ?? 0) + (c?.value ?? 0) };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);

  const grand = rows.reduce((a, r) => a + r.total, 0);
  const max = rows.reduce((a, r) => Math.max(a, r.total), 0);

  return (
    <div className="xs-bars">
      <div className="xs-legend">
        <span><i className="xs-key xs-closed" /> Closed <span className="muted">(delivered)</span></span>
        <span><i className="xs-key xs-open" /> Open <span className="muted">(not delivered)</span></span>
      </div>
      {rows.map((r, i) => {
        const share = grand > 0 ? (r.total / grand) * 100 : 0;
        const w = (v: number) => (max > 0 ? (v / max) * 100 : 0);
        const seg = (
          pt: { value: number | null; rowCount: number; drillToken: string | null } | null,
          cls: string,
          what: string,
        ) => (pt && (pt.value ?? 0) > 0 ? (
          <button
            type="button"
            className={`xs-seg ${cls}`}
            style={{ width: `${w(pt.value ?? 0)}%` }}
            title={`${what} ${r.label} — ${money(pt.value)}, ${formatNumber(pt.rowCount)} PO lines. Click for the Overview of this slice.`}
            onClick={(e) => {
              e.stopPropagation();
              onFocus(
                `${r.label} — ${what}`,
                `${money(pt.value)} · ${formatNumber(pt.rowCount)} PO lines`,
                `spendCategory=${encodeURIComponent(r.key)}&lifecycle=${what === 'Open' ? 'open' : 'closed'}`,
              );
            }}
          />
        ) : null);

        return (
          <div key={r.key} className={`xs-bar-row${i < emphasiseTop ? ' xs-hi' : ''}`}>
            <span className="xs-bar-label">{r.label}</span>
            <span className="xs-bar-track">
              {/* Closed first: delivered value has actually landed, so the bar
                  reads from the axis outward and the open tail is what is still
                  to come. The legend above is in the same order — a legend that
                  disagrees with the stack teaches the reader to misread it. */}
              {seg(r.c, 'xs-closed', 'Closed')}
              {seg(r.o, 'xs-open', 'Open')}
            </span>
            <span className="xs-bar-value">
              {money(r.total)} <span className="muted">({share.toFixed(1)}%)</span>
              {/* The split behind the total, in the stack's order. The bar showed
                  the proportions and the row showed only the sum, so neither
                  gave the closed figure as a number you could quote. */}
              <span className="xs-bar-split">
                <span className="xs-sp-closed">{money(r.c?.value ?? 0)}</span> closed
                {' · '}
                <span className="xs-sp-open">{money(r.o?.value ?? 0)}</span> open
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Stable colour per spend category.
 *
 * Keyed by NAME, not by index: the categories present vary from month to month,
 * so an index-based palette would recolour CHEMICAL between rows and make the
 * stack unreadable down the page. Named entries follow the reference design;
 * anything else — a category the mapping file adds later, or the two honest
 * placeholders — takes a deterministic slot derived from its own name, so it is
 * stable without having to be listed here.
 */
const SPEND_CATEGORY_COLORS: Record<string, string> = {
  METHANOL: '#4f46e5',
  SERVICES: '#1d4ed8',
  PACKAGING: '#1e3a5f',
  CHEMICAL: '#ea7317',
  COAL: '#10b981',
  HEVE: '#06b6d4',
  'FUEL & ENERGY': '#8b5cf6',
  FUEL: '#ec4899',
  'MRO GENERAL': '#c026d3',
  'MRO SPECIFIC': '#6b7280',
  'OFFICE IT': '#f87171',
  CAPEX: '#38bdf8',
  '(unmapped)': '#94a3b8',
  '(no material code)': '#cbd5e1',
};

const FALLBACK_CATEGORY_COLORS = [
  '#0f766e', '#b45309', '#7e22ce', '#be123c', '#15803d',
  '#a16207', '#1e40af', '#9d174d', '#4d7c0f', '#831843',
];

function categoryColor(name: string): string {
  const named = SPEND_CATEGORY_COLORS[name];
  if (named !== undefined) return named;
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 100000;
  return FALLBACK_CATEGORY_COLORS[h % FALLBACK_CATEGORY_COLORS.length]!;
}

/**
 * Monthly Spend Category — one stacked bar per month, stacked by category.
 *
 * DELIVERED value only, by request: the question is what was actually taken
 * delivery of in each month, and mixing in open commitment would inflate a month
 * with value that has not landed. The panel above stays the open-and-closed view
 * of the same population.
 *
 * The chart returns ONE series whose buckets carry both dimensions as
 * `YYYY-MM|CATEGORY`, because a ChartSpec's series are static SQL while the
 * categories are data. This pivots it. The split is at offset 7 rather than on
 * the separator — the month is fixed width, so a category containing a pipe
 * still cuts in the right place.
 *
 * Bars share ONE scale, against the largest month, rather than each filling its
 * own row: a per-row scale makes every month look the same size and destroys the
 * month-to-month comparison the panel exists for.
 */
function MonthlyCategoryBars({ data, onFocus, currency }: {
  data: ChartResponse;
  onFocus: (title: string, subtitle: string, slice: string) => void;
  currency: 'USD' | 'IDR';
}) {
  const suffix = currency === 'IDR' ? '_idr' : '';
  const series = data.series.find((x) => x.key === `closed${suffix}`)
    ?? data.series.find((x) => x.key === 'closed_idr')
    ?? data.series[0];
  if (!series) return <p className="muted">No data.</p>;
  const isIdr = series.key.endsWith('_idr');
  const money = (v: number | null): string => (isIdr ? rupiah(v) : formatMoney(v, 'USD'));

  const labelFor = new Map(data.buckets.map((b) => [b.key, b.label] as const));

  interface Cell { category: string; value: number; rowCount: number }
  const byMonth = new Map<string, { label: string; cells: Cell[]; total: number }>();

  for (const pt of series.points) {
    const v = pt.value ?? 0;
    if (v <= 0) continue;
    const monthKey = pt.bucketKey.slice(0, 7);
    const category = pt.bucketKey.slice(8);
    const monthLabel = (labelFor.get(pt.bucketKey) ?? monthKey).split('|')[0] ?? monthKey;
    let m = byMonth.get(monthKey);
    if (!m) { m = { label: monthLabel, cells: [], total: 0 }; byMonth.set(monthKey, m); }
    m.cells.push({ category, value: v, rowCount: pt.rowCount });
    m.total += v;
  }

  const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (months.length === 0) return <p className="muted">No delivered value in this scope.</p>;

  const max = months.reduce((a, [, m]) => Math.max(a, m.total), 0);

  // The legend covers every category present anywhere in the range, ordered by
  // total so the biggest contributors read first.
  const legendTotals = new Map<string, number>();
  for (const [, m] of months) {
    for (const c of m.cells) {
      legendTotals.set(c.category, (legendTotals.get(c.category) ?? 0) + c.value);
    }
  }
  const legend = [...legendTotals.entries()].sort((a, b) => b[1] - a[1]);

  /** Q1..Q4 from the month number, printed once per quarter as in the design. */
  const quarterOf = (mk: string): string => `Q${Math.floor((Number(mk.slice(5, 7)) - 1) / 3) + 1}`;

  return (
    <div className="xs-mc">
      <div className="xs-legend xs-mc-legend">
        {legend.map(([cat]) => (
          <span key={cat}>
            <i className="xs-key" style={{ background: categoryColor(cat) }} /> {cat}
          </span>
        ))}
      </div>

      {months.map(([mk, m], idx) => {
        const prevQ = idx > 0 ? quarterOf(months[idx - 1]![0]) : null;
        const q = quarterOf(mk);
        // Biggest first inside the bar, so a row is readable and the order does
        // not jump around between months.
        const cells = [...m.cells].sort((a, b) => b.value - a.value);
        return (
          <div key={mk} className="xs-mc-row">
            <span className="xs-mc-q">{q !== prevQ ? q : ''}</span>
            <span className="xs-mc-month">{m.label}</span>
            <span className="xs-mc-track">
              {cells.map((c) => {
                const w = max > 0 ? (c.value / max) * 100 : 0;
                return (
                  <button
                    key={c.category}
                    type="button"
                    className="xs-mc-seg"
                    style={{ width: `${w}%`, background: categoryColor(c.category) }}
                    title={`${m.label} — ${c.category}: ${money(c.value)}, ${formatNumber(c.rowCount)} delivered PO lines. Click for the Overview of this slice.`}
                    onClick={() => onFocus(
                      `${c.category} — delivered in ${m.label}`,
                      `${money(c.value)} · ${formatNumber(c.rowCount)} PO lines`,
                      `spendCategory=${encodeURIComponent(c.category)}`
                      + `&monthKey=${encodeURIComponent(mk)}&lifecycle=closed`,
                    )}
                  >
                    {/* Printed only where it fits: a figure wider than its own box
                        is unreadable, and the tooltip carries it regardless. */}
                    {w >= 6 ? (
                      <span className="xs-mc-num">
                        {formatNumber(Math.round(c.value / (isIdr ? 1e9 : 1e6)))}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </span>
            <span className="xs-mc-total">{money(m.total)}</span>
          </div>
        );
      })}
      <p className="note" style={{ marginTop: '.5rem' }}>
        Delivered value only, so each month counts what was received rather than what was
        ordered. Every bar shares one scale — the widest month is the largest — and in-bar
        figures are {isIdr ? 'billions of rupiah' : 'millions of USD'}.
      </p>
    </div>
  );
}

/**
 * The size-band panel: share of value against share of lines, each split into
 * Open and Closed.
 *
 * Two stacked bars per band. Stacking keeps open + closed equal to the band's
 * total share, so the value-versus-volume comparison the panel exists for reads
 * exactly as it did before the split.
 *
 * Bands are ordered by the bucket ordinal — the band's own size rank, never by
 * measure. The reference design sorted these rows by % value and so printed
 * "100-500 Jt" above "500 Jt - 1 Bio"; on an interval scale that destroys the
 * distribution shape the panel exists to show.
 */
function BandPairs({ data, onFocus }: {
  data: ChartResponse;
  onFocus: (title: string, subtitle: string, slice: string) => void;
}) {
  const S = (k: string) => data.series.find((x) => x.key === k);
  const ov = S('open_value'); const cv = S('closed_value');
  const ol = S('open_lines'); const cl = S('closed_lines');
  if (!ov && !cv && !ol && !cl) return <p className="muted">No data.</p>;

  const buckets = [...data.buckets].sort((a, b) => a.ordinal - b.ordinal);
  const at = (s: ReturnType<typeof S>, key: string) =>
    s?.points.find((pt) => pt.bucketKey === key) ?? null;

  const seg = (
    pt: { value: number | null; rowCount: number; drillToken: string | null } | null,
    cls: string, label: string, band: string, bandKey: string,
  ) => (pt && (pt.value ?? 0) > 0 ? (
    <button
      type="button"
      className={`xs-seg ${cls}`}
      style={{ width: `${pt.value ?? 0}%` }}
      title={`${label} ${band} — ${(pt.value ?? 0).toFixed(1)}%, ${formatNumber(pt.rowCount)} PO lines. Click for the Overview of this slice.`}
      onClick={() => onFocus(
        `${band} — ${label}`,
        `${(pt.value ?? 0).toFixed(1)}% · ${formatNumber(pt.rowCount)} PO lines`,
        `sizeBand=${encodeURIComponent(bandKey)}&lifecycle=${label === 'Open' ? 'open' : 'closed'}`,
      )}
    />
  ) : null);

  return (
    <div className="xs-bands">
      <div className="xs-legend">
        <span><i className="xs-key xs-open" /> Open <span className="muted">(not delivered)</span></span>
        <span><i className="xs-key xs-closed" /> Closed <span className="muted">(delivered)</span></span>
      </div>
      {buckets.map((b) => {
        const vTot = (at(ov, b.key)?.value ?? 0) + (at(cv, b.key)?.value ?? 0);
        const lTot = (at(ol, b.key)?.value ?? 0) + (at(cl, b.key)?.value ?? 0);
        return (
          <div key={b.key} className="xs-band-row">
            <span className="xs-band-label">{b.label}</span>
            <span className="xs-band-bars">
              <span className="xs-band-line">
                <span className="xs-band-track">
                  {seg(at(ov, b.key), 'xs-open', 'Open', b.label, b.key)}
                  {seg(at(cv, b.key), 'xs-closed', 'Closed', b.label, b.key)}
                </span>
                <span className="xs-band-num">{pct(vTot)} of value</span>
              </span>
              <span className="xs-band-line">
                <span className="xs-band-track">
                  {seg(at(ol, b.key), 'xs-open', 'Open', b.label, b.key)}
                  {seg(at(cl, b.key), 'xs-closed', 'Closed', b.label, b.key)}
                </span>
                <span className="xs-band-num">{pct(lTot)} of lines</span>
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ExecSummaryTab({
  kpis, onDrill, currency, asOfDate, firstDate, filterQuery, overviewKpis, overviewCharts,
  layout, update, editing,
}: Props) {
  /**
   * The focus panel's slice, or null when it is closed.
   *
   * `slice` is a query fragment, not a drill token: a token identifies ROWS,
   * and this panel needs to re-run every Overview figure over a POPULATION.
   * Those are different things, which is why the global filter had to learn
   * these dimensions rather than the panel borrowing the drill's token.
   */
  const [focus, setFocus] = useState<{
    title: string; subtitle: string; slice: string;
    /** What to show inside. Absent means the Overview's own lists. */
    kpiIds?: string[]; chartIds?: string[];
  } | null>(null);

  const openFocus = useCallback((title: string, subtitle: string, slice: string) => {
    setFocus({ title, subtitle, slice });
  }, []);

  /**
   * A headline tile opens the figures that EXPLAIN that tile.
   *
   * The four tiles all describe one population — they are different measures of
   * it, not different slices — so passing a slice could not distinguish them and
   * every tile opened an identical copy of the Overview. What differs is which
   * question the reader is now asking: clicking committed value means "where is
   * the money", clicking vendors means "how concentrated is the supply base".
   * So the tile chooses the CONTENT rather than the filter.
   */
  const openTileFocus = useCallback(
    (title: string, subtitle: string, kpiIds: string[], chartIds: string[]) => {
      setFocus({ title, subtitle, slice: '', kpiIds, chartIds });
    },
    [],
  );
  const [byCategory, setByCategory] = useState<ChartResponse | null>(null);
  const [byBand, setByBand] = useState<ChartResponse | null>(null);
  const [byMonth, setByMonth] = useState<ChartResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const q = filterQuery ? `?${filterQuery}` : '';
    setByCategory(null);
    setByBand(null);
    setByMonth(null);
    Promise.all([
      api.get<ChartResponse>(`/api/v1/chart/exec_value_by_category${q}`),
      api.get<ChartResponse>(`/api/v1/chart/exec_txn_size${q}`),
      api.get<ChartResponse>(`/api/v1/chart/exec_monthly_category${q}`),
    ])
      .then(([c, b, m]) => {
        if (!dead) { setByCategory(c); setByBand(b); setByMonth(m); }
      })
      .catch((e: Error) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [filterQuery]);

  const k = (id: string): Kpi | undefined => kpis.find((x) => x.kpiId === id);
  const val = (id: string): number | null => k(id)?.value ?? null;

  // total_po_amount carries both bases, so the tile follows the user's display
  // currency instead of quietly mixing one into the other.
  const totalKpi = k('total_po_amount');
  // 'value_idr' is the key KpiCard reads; a different spelling here silently
  // showed a dash in IDR view.
  const totalIdr = (totalKpi?.detail?.['value_idr'] as number | null | undefined) ?? null;
  const totalUsd = totalKpi?.value ?? null;

  /**
   * What each tile opens. Kept beside the tiles so the pairing is visible, and
   * chosen from the catalogue the Overview already exposes so nothing here is a
   * new measure that could disagree with the rest of the app.
   */
  const TILE_FOCUS: Record<string, { kpis: string[]; charts: string[] }> = {
    'committed value': {
      kpis: ['total_po_amount', 'open_po_commitment', 'avg_po_value_idr',
        'top5_category_share_pct', 'foreign_ccy_po_share', 'valuation_coverage_pct'],
      charts: ['po_value_by_category', 'po_value_by_purch_org', 'po_bracket_value'],
    },
    'PO lines': {
      kpis: ['po_line_items', 'total_po_count', 'po_not_delivered', 'delivered_gr',
        'hold_po_lines', 'lines_under_25jt_pct'],
      charts: ['po_count_by_category', 'po_items_by_pgrp', 'po_bracket_count'],
    },
    'active vendors': {
      kpis: ['unique_suppliers', 'top_vendor_share_pct', 'top5_vendor_share_pct',
        'vendors_for_80pct_value', 'sole_source_materials', 'tail_spend_pct'],
      charts: ['top_materials_spend', 'po_value_by_category'],
    },
    'purchasing desks': {
      kpis: ['active_purch_groups', 'desks_for_80pct_value', 'ho_share_value_pct',
        'ho_share_lines_pct'],
      charts: ['po_value_by_pgrp', 'po_items_by_pgrp', 'po_value_by_purch_org'],
    },
  };

  const tiles: { label: string; value: string; sub: string; kpi?: Kpi }[] = [
    {
      label: 'committed value',
      value: currency === 'IDR' && totalIdr !== null
        ? rupiah(totalIdr)
        : formatMoney(totalUsd, 'USD'),
      sub: 'net order value — STO and deleted excluded',
      ...(totalKpi ? { kpi: totalKpi } : {}),
    },
    {
      label: 'PO lines',
      value: formatNumber(val('po_line_items') ?? 0),
      sub: 'purchase lines in the period',
      ...(k('po_line_items') ? { kpi: k('po_line_items')! } : {}),
    },
    {
      label: 'active vendors',
      value: formatNumber(val('unique_suppliers') ?? 0),
      sub: 'distinct vendors ordered from',
      ...(k('unique_suppliers') ? { kpi: k('unique_suppliers')! } : {}),
    },
    {
      label: 'purchasing desks',
      value: formatNumber(val('active_purch_groups') ?? 0),
      sub: 'purchasing groups raising orders',
      ...(k('active_purch_groups') ? { kpi: k('active_purch_groups')! } : {}),
    },
  ];

  // Read from the chart rather than a KPI: this is a statement ABOUT the chart's
  // own completeness, so it must move with the chart and not with a separate
  // aggregate that could be computed over a different population.
  // Across BOTH lifecycle series, not series[0]: the chart split into Open and
  // Closed, and reading one series would halve the denominator and report a
  // mapping gap that is roughly double the real one.
  const catPoints = (byCategory?.series ?? []).flatMap((x) => x.points);
  const catTotal = catPoints.reduce((a, pt) => a + (pt.value ?? 0), 0);
  const catUnmapped = catPoints
    .filter((pt) => pt.bucketKey === '(unmapped)')
    .reduce((a, pt) => a + (pt.value ?? 0), 0);
  const unmappedShare = byCategory && catTotal > 0 ? (catUnmapped / catTotal) * 100 : null;

  const top5 = val('top5_category_share_pct');
  const linesTail = val('lines_under_25jt_pct');
  const valueTail = val('value_under_25jt_pct');
  const desks80 = val('desks_for_80pct_value');
  const desksAll = val('active_purch_groups');
  const vend80 = val('vendors_for_80pct_value');
  const vendAll = val('unique_suppliers');
  const hoValue = val('ho_share_value_pct');
  const hoLines = val('ho_share_lines_pct');
  const n = (v: number | null): string => (v === null ? '—' : formatNumber(v));

  /**
   * The page's sections, each with an id the layout can order and hide.
   *
   * A PANEL is the editable unit here, not a KPI card: this page has no card
   * slots, and what a reader wants moved or dropped is a whole section. The ids
   * are namespaced `panel:` so they cannot collide with a KPI or chart id in the
   * layout's shared `hidden` list.
   */
  const PANELS: { id: string; node: React.ReactNode }[] = [
    {
      id: 'panel:headline',
      node: (
              <div className="panel">
                <h2>🎯 Executive Summary - Procurement Manage</h2>
                {/*
                  Scope stated up front and read from the data rather than typed. The
                  reference design was headed "2025 / annual spend" over a part-year
                  extract of a single entity; a reader who trusts that headline draws
                  conclusions about a population that was never measured.
                */}
                <p className="note">
                  <span className="bs sl">scope</span>{' '}
                  Committed value on purchase orders
                  {firstDate && asOfDate ? <> from <strong>{firstDate}</strong> to <strong>{asOfDate}</strong></> : null}
                  . Stock-transport and deleted lines are excluded throughout, so every figure on
                  this page counts the same population. Values are <strong>ordered</strong> — this
                  is commitment, not invoiced or received cash.
                </p>
                {err && <p className="note"><span className="bs spdel">error</span> {err}</p>}

                <div className="kpi-grid">
                  {tiles.map((t) => (
                    <button
                      key={t.label}
                      type="button"
                      className="xs-tile"
                      onClick={() => openTileFocus(
                        t.kpi?.title ?? t.label,
                        `${t.value} — ${t.label}`,
                        // No slice: a headline tile IS the current scope. What
                        // makes one tile differ from another is the set of
                        // figures below, not a narrower population.
                        TILE_FOCUS[t.label]?.kpis ?? overviewKpis,
                        TILE_FOCUS[t.label]?.charts ?? overviewCharts,
                      )}
                      title={`Click for the figures behind ${t.label}`}
                    >
                      <span className="xs-tile-value">{t.value}</span>
                      <span className="xs-tile-label">{t.label}</span>
                      <span className="xs-tile-sub muted">{t.sub}</span>
                    </button>
                  ))}
                </div>
              </div>
      ),
    },
    {
      id: 'panel:category',
      node: (
              <div className="panel">
                <h3 className="pr-tbl-h">
                  Where the value is <span className="muted">— committed value by spend category</span>
                </h3>
                {byCategory
                  ? <RankedBars data={byCategory} onFocus={openFocus} emphasiseTop={5} currency={currency} />
                  : <div className="spinner" />}
                <p className="note" style={{ marginTop: '.5rem' }}>
                  {/*
                    The top-five claim is suppressed when there are five or fewer
                    categories. It stays TRUE in that case — five of five is 100% — but
                    "the top five are 100.0%" of two rows reads as a broken page, which
                    is how a real mapping failure was first spotted rather than the
                    claim itself being wrong.
                  */}
                  {(byCategory?.buckets.length ?? 0) > 5 && (
                    <>
                      The <strong>top five</strong> categories are shaded; together they are{' '}
                      <strong>{pct(top5)}</strong> of committed value.{' '}
                    </>
                  )}
                  Categories resolve from the business mapping first, then SAP&apos;s material
                  master. <code>(no material code)</code> is shown as itself rather than folded
                  into a category — it is service and text lines, and burying it would misstate
                  every share above it.
                </p>
                {/*
                  A mapping failure is loud rather than silent. When most of the value
                  cannot be attributed to a business category, the page says so instead
                  of presenting '(unmapped)' as though it were a category the business
                  would recognise.
                */}
                {unmappedShare !== null && unmappedShare > 20 && (
                  <p className="note">
                    <span className="bs sa">mapping incomplete</span>{' '}
                    <strong>{pct(unmappedShare)}</strong> of committed value has a material code
                    that is not in the spend-category mapping or SAP&apos;s material master, so it
                    is shown as <code>(unmapped)</code> rather than attributed to a category. The
                    shares above are therefore not yet a reliable category picture.
                  </p>
                )}
              </div>
      ),
    },
    {
      id: 'panel:monthly',
      node: (
              <div className="panel">
                <h3 className="pr-tbl-h">
                  Monthly Spend Category{' '}
                  <span className="muted">— delivered value by month, stacked by category</span>
                </h3>
                {byMonth
                  ? <MonthlyCategoryBars data={byMonth} onFocus={openFocus} currency={currency} />
                  : <div className="spinner" />}
              </div>
      ),
    },
    {
      id: 'panel:bands',
      node: (
              <div className="panel">
                <h3 className="pr-tbl-h">
                  Transaction size <span className="muted">— share of value against share of lines</span>
                </h3>
                {byBand ? <BandPairs data={byBand} onFocus={openFocus} /> : <div className="spinner" />}
                <p className="note" style={{ marginTop: '.5rem' }}>
                  Bands are ordered by size, never by measure. Lines with no rupiah value are
                  excluded rather than counted as zero, which would inflate the smallest band —
                  the band the whole fragmentation argument rests on.
                </p>
                <p className="note">
                  <span className="bs sl">rupiah basis</span> This panel does not follow the
                  currency toggle, and cannot: the bands <em>are</em> rupiah brackets, and the two
                  measures are shares rather than amounts, so there is no figure here to restate in
                  dollars. Switching to USD changes the tiles and the category panel above.
                </p>
              </div>
      ),
    },
    {
      id: 'panel:concentration',
      node: (
              <div className="panel">
                <h3 className="pr-tbl-h">
                  How concentrated <span className="muted">— how few hold most of the value</span>
                </h3>
                <div className="table-wrap">
                  <table className="data dd-tbl">
                    <tbody>
                      <tr className="re">
                        <td>Purchasing desks</td>
                        <td>
                          <strong>{n(desks80)}</strong> of {n(desksAll)} desks hold 80% of committed value
                        </td>
                      </tr>
                      <tr>
                        <td>Vendors</td>
                        <td>
                          <strong>{n(vend80)}</strong> of {n(vendAll)} vendors hold 80% of committed value
                        </td>
                      </tr>
                      <tr className="re">
                        <td>Head Office share</td>
                        <td>
                          <strong>{pct(hoValue)}</strong> of committed value and{' '}
                          <strong>{pct(hoLines)}</strong> of PO lines are raised by an HQ purchasing
                          organisation
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="note" style={{ marginTop: '.5rem' }}>
                  Head Office is read from the purchasing <strong>organisation</strong>, not the
                  purchasing group. The group is the buyer&apos;s desk; the HQ-versus-site
                  distinction lives on the organisation, and measuring it on the group gives 2%
                  against 98% — the opposite of the truth. Two organisations are judgement calls
                  and between them 0.4% of value: <code>Jakarta-PPIC</code> (planning) and{' '}
                  <code>LEGAL LICENSE DWS</code> count as non-HQ.
                </p>
              </div>
      ),
    },
    {
      id: 'panel:meaning',
      node: (
              <div className="panel">
                <h3 className="pr-tbl-h">What this means</h3>
                <ul className="xs-means">
                  <li>
                    <strong>Value is concentrated.</strong> The top five categories are {pct(top5)} of
                    committed value, and {n(desks80)} desks hold 80% of it.
                  </li>
                  <li>
                    <strong>Work is fragmented.</strong> {pct(linesTail)} of PO lines are under
                    Rp 25 Jt and carry {pct(valueTail)} of the value — most of the effort buys
                    almost none of the spend.
                  </li>
                  <li>
                    <strong>Control and execution sit apart.</strong> HQ raises {pct(hoValue)} of the
                    value on {pct(hoLines)} of the lines — so the money is decided centrally while
                    the volume of paperwork is spread much wider.
                  </li>
                  <li>
                    <strong>The two do not overlap.</strong> Price belongs on the few large
                    commodities; the many small lines are a process problem, not a negotiation
                    one, and no sourcing effort spent on them moves the total.
                  </li>
                </ul>
              </div>
      ),
    },
  ];

  const order = applyLayout(PANELS.map((x) => x.id), layout, 'panel');

        {/*
          The conclusion, assembled from the KPIs above rather than written out. In
          the reference design this was static prose ("top 5 = 70%", "72% of lines
          < Rp 25 Jt = 4% of value") — correct on the day it was drawn and wrong
          from the next refresh onwards.
        */}
  return (
    <>
      {/*
        A 12-column row, so a panel's width is a share of it rather than a pixel
        count. Panels default to the full 12 and therefore stack exactly as they
        did before widths existed; setting two to Half puts them side by side.
        The span is a CSS variable rather than a class per width, so the set of
        widths lives in one place — PANEL_SIZES.
      */}
      <div className="xs-grid">
        {order.map((id: string) => {
          const panel = PANELS.find((x) => x.id === id);
          if (!panel) return null;
          return (
            <div
              key={id}
              className={`xs-cell${editing ? ' ly-slot' : ''}`}
              style={{ '--span': panelSpan(layout, id) } as React.CSSProperties}
            >
              {editing && (
                <LayoutControls
                  id={id}
                  kind="panel"
                  layout={layout}
                  update={update}
                  currentIds={order}
                />
              )}
              {panel.node}
            </div>
          );
        })}
      </div>

        {focus && (
          <ExecFocusModal
            title={focus.title}
            subtitle={focus.subtitle}
            // The clicked slice on top of the page's own filter, so the panel can
            // never show a wider population than the page it was opened from.
            filterQuery={[filterQuery, focus.slice].filter(Boolean).join('&')}
            kpiIds={focus.kpiIds ?? overviewKpis}
            chartIds={focus.chartIds ?? overviewCharts}
            currency={currency}
            onDrill={onDrill}
            onClose={() => setFocus(null)}
          />
        )}
    </>
  );
}
