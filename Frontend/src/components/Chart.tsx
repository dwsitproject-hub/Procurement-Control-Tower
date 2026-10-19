import { useEffect, useRef, useState } from 'react';
import {
  ArcElement, BarController, BarElement, CategoryScale, Chart as ChartJS,
  DoughnutController, Legend, LinearScale, Tooltip,
} from 'chart.js';
import { api, type ChartResponse } from '../lib/api';
import { formatKpi } from '../lib/format';

ChartJS.register(
  ArcElement, BarController, BarElement, CategoryScale, DoughnutController,
  LinearScale, Tooltip, Legend,
);

const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948'];
// v1 colours each priority bucket (Emergency red → Planned green).
const PRIORITY_COLORS: Record<string, string> = {
  '01-Emergency': '#C0392B',
  '02-Urgent': '#ED7D31',
  '03-Standard': '#2E75B6',
  '04-Planned': '#4CAF50',
  '(unlabelled)': '#94a3b8',
};
// v1's MC2 material-category palette + the six PO-approval bands - any
// single-series bar chart whose bucket labels match gets per-bar colours.
// Keyed on the SPEND category, which is what every category axis in the
// product now shows. The sixteen values below are core.dim_spend_category's,
// plus the two placeholders the transform assigns; anything the mapping file
// adds later simply falls through to the rotating palette, which is why a
// missing key costs nothing. v1's material-category names are kept at the
// bottom because a saved custom chart can still group by material_category.
export const CATEGORY_COLORS: Record<string, string> = {
  // ── spend categories ──
  'MRO GENERAL': '#2E75B6',
  'MRO SPECIFIC': '#0D9488',
  'CHEMICAL REFINERY': '#ED7D31',
  // Carved out of Chemical by the business, so deliberately NOT its shade.
  'BLEACHING EARTH': '#B45309',
  'SODIUM METHYLATE': '#A16207',
  PACKAGING: '#DB2777',
  'FUEL & ENERGY': '#F59E0B',
  FUEL: '#FBBF24',
  COAL: '#374151',
  METHANOL: '#9333EA',
  FERTILIZER: '#4CAF50',
  HEVE: '#1F3864',
  'OFFICE IT': '#38BDF8',
  'CAPEX OPS': '#C0392B',
  'CAPEX PROJ': '#E11D48',
  SERVICES: '#7C3AED',
  UNIT: '#0EA5E9',
  // Deliberately visible rather than folded into a business category.
  '(no material code)': '#64748B',
  '(unmapped)': '#94a3b8',
  // ── v1's material categories, for custom charts that still group by them ──
  Service: '#7C3AED',
  'Spare Parts-General': '#2E75B6',
  'Spare Parts-Factory': '#0D9488',
  Chemical: '#ED7D31',
  'Packing Material': '#DB2777',
  'Fuel & Lubricant': '#F59E0B',
  Fertilizer: '#4CAF50',
  'Raw Product Liquid': '#1F3864',
  'Raw Product Solid': '#374151',
  'Finished Goods': '#9333EA',
  Other: '#94a3b8',
  // PO approval bands: same-day teal, escalating to dark red past a month.
  '0d': '#0D9488',
  '1-3d': '#4CAF50',
  '4-7d': '#F59E0B',
  '8-14d': '#ED7D31',
  '15-30d': '#dc2626',
  '>30d': '#7f1d1d',
};
const BAR_COLORS: Record<string, string> = { ...PRIORITY_COLORS, ...CATEGORY_COLORS };

/**
 * Colours pinned to a SERIES, for charts whose series mean something the
 * palette's rotation would contradict.
 *
 * The requisition flow chart is the case that needed it: incoming and outgoing
 * have to read as two pairs at a glance, and the default rotation gave "became
 * PO" the same blue as "brought forward" would have had on another page.
 * Requested 22 Sep 2026 with the colours named - green new, orange waiting,
 * blue converted, grey cancelled.
 */
const SERIES_COLORS: Record<string, string> = {
  'Newly raised': '#4CAF50',
  'Brought forward (still open)': '#ED7D31',
  'Became PO': '#2E75B6',
  'Cancelled (by month raised)': '#94a3b8',
};

/**
 * The requisition flow as a WATERFALL (requested 7 Oct 2026), per month:
 *
 *   brought forward - the requisitions still open when the month began,
 *                     stacked by how long each had been waiting (six bands,
 *                     colours as specified with the request);
 *   + newly raised  - a step up from there;
 *   - became PO     - a step down;
 *   - cancelled     - a further step down, drawn only when there are any.
 *
 * Where the last step ends is what the NEXT month brings forward: the chart's
 * own identity, open(M+1) = open(M) + new(M) - to PO(M) - cancelled(M).
 */
const WATERFALL_CHARTS = new Set(['pr_by_month']);

/**
 * Charts drawn full width and taller (8 Oct 2026): the waterfall carries four
 * columns a month and nine legend entries, which a 260-pixel half-width cell
 * squeezed into slivers.
 */
const WIDE_CHARTS: Record<string, number> = { pr_by_month: 440 };

/**
 * Charts drawn as HORIZONTAL bars (8 Oct 2026). Their labels carry two figures
 * ("12,335 · USD 4.53M") over a dozen-plus categories; printed above vertical
 * bars they ran into each other and the category names below were rotated
 * into an unreadable slant. Laid on their side, each label sits after the end
 * of its own bar, on its own row, and the category reads straight.
 */
const HORIZONTAL_CHARTS = new Set(['items_by_category']);
const WATERFALL_BAND_COLORS = ['#4E79A7', '#F28E2B', '#59A14F', '#E15759', '#76B7B2', '#EDC948'];
const WATERFALL_STEP_COLORS = { new_pr: '#2E7D32', to_po: '#1F3864', cancelled: '#94a3b8' };

// v1's PR Status Distribution donut colours, keyed by status.
const STATUS_COLORS: Record<string, string> = {
  Delivered: '#4CAF50',
  'Partially Delivered': '#0D9488',
  'PO-No GR': '#1d4ed8',
  'PR Approved-No PO': '#c2410c',
  'HOLD PO': '#C0392B',
  'Unapproved PR': '#be123c',
  'PO-Not Approved': '#7C3AED',
  'PR-Deleted': '#94a3b8',
  'PO-Deleted': '#64748B',
  'Fully Reversed': '#F59E0B',
};

/**
 * Chart panel.
 *
 * Every data point carries its own drill token issued by the server alongside the
 * aggregate, so clicking a bar re-executes the identical predicate against the
 * identical dataset version. The counts are equal by construction.
 */
export function ChartPanel({
  chartId,
  onDrill,
  filterQuery = '',
  onApplyFilter,
  variant = 'bar',
  currency = 'USD',
  onBucketClick,
}: {
  chartId: string;
  onDrill: (token: string, label: string) => void;
  /** Global filter as a query string; empty keeps the precomputed path. */
  filterQuery?: string;
  /**
   * v1's chart cross-filtering: when set, Alt/Shift-clicking a bar applies its
   * bucket as a global filter instead of drilling. Only wired for charts whose
   * bucket maps to a global-filter dimension.
   */
  onApplyFilter?: (bucketKey: string, bucketLabel: string) => void;
  /** 'doughnut' renders v1's status-distribution donut; default is bars. */
  variant?: 'bar' | 'doughnut';
  /** Money charts with an IDR twin series switch to it when 'IDR'. */
  currency?: 'USD' | 'IDR';
  /**
   * When set, a click on a bar - or on its axis label, or anywhere along its
   * row - hands the bucket to the page instead of opening the row list
   * (19 Oct 2026: the Material Group page opens its Category 360 popup).
   */
  onBucketClick?: (bucketKey: string, bucketLabel: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  // Read at click time, so a new callback each render does not rebuild the chart.
  const bucketClick = useRef(onBucketClick);
  bucketClick.current = onBucketClick;
  const chart = useRef<ChartJS | null>(null);
  const [data, setData] = useState<ChartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .get<ChartResponse>(`/api/v1/chart/${chartId}${filterQuery ? `?${filterQuery}` : ''}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [chartId, filterQuery]);

  // Annotation series (key label_*) are never drawn as bars: their per-bucket
  // values ride in the bar labels and tooltips (e.g. amount per category).
  const allSeries = data?.series ?? [];
  const mainSeries = allSeries.filter((x) => !x.key.startsWith('label_'));
  const annSeriesAll = allSeries.filter((x) => x.key.startsWith('label_'));
  // Display-currency twin series (seriesKey *_idr) — same rows, same drills.
  const idrCount = mainSeries.filter((x) => x.key.endsWith('_idr')).length;
  const hasTwin = idrCount > 0 && mainSeries.length > idrCount;
  const shownSeries = !data
    ? []
    : hasTwin
      ? mainSeries.filter((x) => (currency === 'IDR' ? x.key.endsWith('_idr') : !x.key.endsWith('_idr')))
      : mainSeries;
  const displayUnit = hasTwin && currency === 'IDR' ? 'idr' : data?.unit ?? 'count';
  // The annotation honours the currency toggle on its own.
  const annSeries = annSeriesAll.length === 0
    ? undefined
    : currency === 'IDR'
      ? annSeriesAll.find((x) => x.key.endsWith('_idr')) ?? annSeriesAll[0]
      : annSeriesAll.find((x) => !x.key.endsWith('_idr')) ?? annSeriesAll[0];
  const annUnit = annSeries?.key.endsWith('_idr') ? 'idr' : 'usd';

  useEffect(() => {
    if (!data || !canvas.current || data.buckets.length === 0) return;

    chart.current?.destroy();
    const labels = data.buckets.map((b) => b.label);

    if (variant === 'doughnut') {
      const series = shownSeries[0];
      if (!series) return;
      const values = data.buckets.map((b) => series.points.find((x) => x.bucketKey === b.key)?.value ?? 0);
      // Chart.js's per-type generics fight a union of bar|doughnut through one
      // ref; the doughnut config is checked structurally here and cast once.
      const doughnutCfg = {
        type: 'doughnut',
        data: {
          labels,
          datasets: [{
            data: values.map((v) => Number(v)),
            backgroundColor: data.buckets.map((b, i) => STATUS_COLORS[b.label] ?? PALETTE[i % PALETTE.length]),
            borderWidth: 1,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          cutout: '55%',
          onClick: (_e: unknown, elements: { index: number }[]) => {
            const el = elements[0];
            if (!el) return;
            const bucket = data.buckets[el.index];
            const point = bucket ? series.points.find((x) => x.bucketKey === bucket.key) : undefined;
            if (point?.drillToken && bucket) onDrill(point.drillToken, `${data.title} — ${bucket.label}`);
          },
          plugins: {
            legend: { display: true, position: 'right', labels: { boxWidth: 12, font: { size: 10 } } },
            tooltip: {
              callbacks: {
                label: (ctx: { dataIndex: number; parsed: number }) => {
                  const bucket = data.buckets[ctx.dataIndex];
                  const point = bucket ? series.points.find((x) => x.bucketKey === bucket.key) : undefined;
                  return `${bucket?.label}: ${formatKpi(ctx.parsed, data.unit)}${point ? ` (${point.rowCount.toLocaleString()} rows)` : ''}`;
                },
              },
            },
          },
        },
      };
      // v1 prints each segment's count on the arc (readable slices only) and
      // in the legend, so numbers are visible without hovering.
      const total = values.reduce((a, v) => a + Number(v), 0);
      const segmentLabels = {
        id: 'segmentLabels',
        afterDatasetsDraw(c: { ctx: CanvasRenderingContext2D; getDatasetMeta: (i: number) => { data: { tooltipPosition: () => { x: number; y: number } }[] } }) {
          const ctx = c.ctx;
          const meta = c.getDatasetMeta(0);
          ctx.save();
          ctx.font = '700 11px "Segoe UI", Arial, sans-serif';
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          values.forEach((v, i) => {
            if (total <= 0 || Number(v) / total < 0.04) return; // unreadable slivers
            const el = meta.data[i];
            if (!el) return;
            const pos = el.tooltipPosition();
            const pct = ((Number(v) / total) * 100).toFixed(0);
            const txt = displayUnit === 'count'
              ? Number(v).toLocaleString('en-GB')
              : formatKpi(Number(v), displayUnit);
            ctx.fillText(`${txt} (${pct}%)`, pos.x, pos.y);
          });
          ctx.restore();
        },
      };
      (doughnutCfg as unknown as { plugins: unknown[] }).plugins = [segmentLabels];
      (doughnutCfg.options.plugins.legend.labels as unknown as Record<string, unknown>)['generateLabels'] = (
        c: { data: { labels: string[]; datasets: { data: number[]; backgroundColor: string[] }[] } },
      ) =>
        c.data.labels.map((l, i) => ({
          text: `${l} — ${displayUnit === 'count'
            ? Number(c.data.datasets[0]!.data[i]).toLocaleString('en-GB')
            : formatKpi(Number(c.data.datasets[0]!.data[i]), displayUnit)} (${total > 0 ? ((Number(c.data.datasets[0]!.data[i]) / total) * 100).toFixed(0) : 0}%)`,
          fillStyle: c.data.datasets[0]!.backgroundColor[i],
          strokeStyle: c.data.datasets[0]!.backgroundColor[i],
          index: i,
        }));
      chart.current = new ChartJS(
        canvas.current,
        doughnutCfg as unknown as ConstructorParameters<typeof ChartJS>[1],
      ) as unknown as ChartJS;
      return () => {
        chart.current?.destroy();
        chart.current = null;
      };
    }

    if (WATERFALL_CHARTS.has(chartId)) {
      const ser = (key: string) => data.series.find((x) => x.key === key);
      const val = (key: string, bk: string): number =>
        Number(ser(key)?.points.find((x) => x.bucketKey === bk)?.value ?? 0);
      const bandKeys = data.series.map((x) => x.key).filter((k) => /^carried_in_b[0-9]$/.test(k)).sort();
      const bf = (bk: string) => bandKeys.reduce((a, k) => a + val(k, bk), 0);
      const hasCancelled = data.buckets.some((b) => val('cancelled', b.key) > 0);
      // Each dataset knows the series it draws, so a click drills to that
      // series' own point - the rows behind exactly that segment.
      const sets: { key: string; label: string; stack: string; color: string;
        values: (number | [number, number])[] }[] = [
        ...bandKeys.map((k, i) => ({
          key: k,
          label: ser(k)?.label ?? k,
          stack: 'bf',
          color: WATERFALL_BAND_COLORS[i] ?? PALETTE[i % PALETTE.length]!,
          values: data.buckets.map((b) => val(k, b.key)),
        })),
        {
          key: 'new_pr', label: '+ Newly raised', stack: 'new', color: WATERFALL_STEP_COLORS.new_pr,
          values: data.buckets.map((b) => [bf(b.key), bf(b.key) + val('new_pr', b.key)] as [number, number]),
        },
        {
          key: 'to_po', label: '\u2212 Became PO', stack: 'po', color: WATERFALL_STEP_COLORS.to_po,
          values: data.buckets.map((b) => {
            const top = bf(b.key) + val('new_pr', b.key);
            return [top - val('to_po', b.key), top] as [number, number];
          }),
        },
        ...(hasCancelled ? [{
          key: 'cancelled', label: '\u2212 Cancelled', stack: 'cx', color: WATERFALL_STEP_COLORS.cancelled,
          values: data.buckets.map((b) => {
            const top = bf(b.key) + val('new_pr', b.key) - val('to_po', b.key);
            return [top - val('cancelled', b.key), top] as [number, number];
          }),
        }] : []),
      ];
      chart.current = new ChartJS(canvas.current, {
        type: 'bar',
        data: {
          labels,
          datasets: sets.map((d) => ({
            label: d.label,
            data: d.values as never,
            stack: d.stack,
            backgroundColor: d.color,
            borderRadius: 2,
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          onClick: (_e, elements) => {
            const el = elements[0];
            if (!el) return;
            const d = sets[el.datasetIndex];
            const bucket = data.buckets[el.index];
            const point = d && bucket ? ser(d.key)?.points.find((x) => x.bucketKey === bucket.key) : undefined;
            if (point?.drillToken && bucket && d) {
              onDrill(point.drillToken, `${data.title} — ${bucket.label} · ${d.label}`);
            }
          },
          plugins: {
            legend: { display: true, position: 'bottom', labels: { boxWidth: 12 } },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const d = sets[ctx.datasetIndex];
                  const bucket = data.buckets[ctx.dataIndex];
                  if (!d || !bucket) return '';
                  const n = val(d.key, bucket.key);
                  return `${d.label}: ${n.toLocaleString('en-GB')}`;
                },
                afterBody: (items) => {
                  const bucket = items[0] ? data.buckets[items[0].dataIndex] : undefined;
                  if (!bucket) return '';
                  const end = bf(bucket.key) + val('new_pr', bucket.key)
                    - val('to_po', bucket.key) - val('cancelled', bucket.key);
                  return `Brought forward ${bf(bucket.key).toLocaleString('en-GB')} \u2192 open at month end ${end.toLocaleString('en-GB')}`;
                },
              },
            },
          },
          scales: {
            x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 60, minRotation: 0, autoSkip: true } },
            y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => formatKpi(Number(v), 'count') } },
          },
        },
      });
      return () => {
        chart.current?.destroy();
        chart.current = null;
      };
    }

    const horizontal = HORIZONTAL_CHARTS.has(chartId);
    // v1 prints the value above each bar; skipped when the chart is too dense
    // to stay readable (values remain in the tooltip). On a horizontal chart
    // every label has its own row, so density is not the limit there.
    const barCount = horizontal ? 0 : data.buckets.length * shownSeries.length;
    const barLabels = {
      id: 'barLabels',
      afterDatasetsDraw(c: {
        ctx: CanvasRenderingContext2D;
        data: { datasets: { data: (number | null)[] }[] };
        getDatasetMeta: (i: number) => { data: { x: number; y: number }[]; hidden: boolean | null };
      }) {
        if (barCount > 24) return;
        const ctx = c.ctx;
        ctx.save();
        ctx.font = '600 10px "Segoe UI", Arial, sans-serif';
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#64748B';
        ctx.textAlign = horizontal ? 'left' : 'center';
        ctx.textBaseline = horizontal ? 'middle' : 'bottom';
        c.data.datasets.forEach((ds, di) => {
          const meta = c.getDatasetMeta(di);
          if (meta.hidden) return;
          ds.data.forEach((v, i) => {
            if (v === null || v === undefined) return;
            const el = meta.data[i];
            if (!el) return;
            let txt = formatKpi(Number(v), displayUnit);
            if (annSeries && c.data.datasets.length === 1) {
              const bucket = data.buckets[i];
              const av = bucket ? annSeries.points.find((x) => x.bucketKey === bucket.key)?.value : null;
              if (av !== null && av !== undefined) txt += ` · ${formatKpi(Number(av), annUnit)}`;
            }
            if (horizontal) ctx.fillText(txt, el.x + 4, el.y);
            else ctx.fillText(txt, el.x, el.y - 2);
          });
        });
        ctx.restore();
      },
    };

    chart.current = new ChartJS(canvas.current, {
      type: 'bar',
      plugins: [barLabels as never],
      data: {
        labels,
        datasets: shownSeries.map((s, i) => ({
          label: s.label,
          data: data.buckets.map((b) => {
            const p = s.points.find((x) => x.bucketKey === b.key);
            return p?.value ?? null;
          }),
          // Single-series priority charts colour each bucket like v1
          // (Emergency red ... Planned green); everything else keeps one hue.
          backgroundColor:
            shownSeries.length === 1 && data.buckets.some((b) => BAR_COLORS[b.label])
              ? data.buckets.map((b) => BAR_COLORS[b.label] ?? PALETTE[0]!)
              // A series that owns a colour keeps it whatever its position in
              // the legend; everything else keeps the rotation.
              : SERIES_COLORS[s.label] ?? PALETTE[i % PALETTE.length],
          borderRadius: 3,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        indexAxis: horizontal ? 'y' : 'x',
        onHover: (e, elements, c) => {
          if (!bucketClick.current) return;
          c.canvas.style.cursor = elements.length > 0 || bucketAt(c, e) !== null ? 'pointer' : 'default';
        },
        onClick: (e, elements, c) => {
          if (bucketClick.current) {
            const idx = elements[0]?.index ?? bucketAt(c, e);
            const b = idx === null ? undefined : data.buckets[idx];
            if (b) bucketClick.current(b.key, b.label);
            return;
          }
          const el = elements[0];
          if (!el) return;
          const series = shownSeries[el.datasetIndex];
          const bucket = data.buckets[el.index];
          if (!series || !bucket) return;
          // Alt/Shift-click cross-filters the page (v1 behaviour); plain click drills.
          const native = e.native as MouseEvent | undefined;
          if (onApplyFilter && native && (native.altKey || native.shiftKey)) {
            onApplyFilter(bucket.key, bucket.label);
            return;
          }
          const point = series.points.find((x) => x.bucketKey === bucket.key);
          if (point?.drillToken) {
            onDrill(point.drillToken, `${data.title} — ${bucket.label} · ${series.label}`);
          }
        },
        plugins: {
          legend: { display: shownSeries.length > 1, position: 'bottom', labels: { boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const series = shownSeries[ctx.datasetIndex];
                const bucket = data.buckets[ctx.dataIndex];
                const p = series?.points.find((x) => x.bucketKey === bucket?.key);
                const v = formatKpi(horizontal ? ctx.parsed.x : ctx.parsed.y, displayUnit);
                const av = annSeries && bucket
                  ? annSeries.points.find((x) => x.bucketKey === bucket.key)?.value
                  : null;
                const ann = av === null || av === undefined
                  ? ''
                  : ` · ${annSeries!.label} ${formatKpi(Number(av), annUnit)}`;
                // Show the row count that the drill will return.
                return `${series?.label}: ${v}${ann}${p ? ` (${p.rowCount.toLocaleString()} rows)` : ''}`;
              },
            },
          },
        },
        scales: horizontal
          ? {
              // grace leaves room after the longest bar for its label.
              x: { beginAtZero: true, grace: '35%', ticks: { callback: (v) => formatKpi(Number(v), displayUnit) } },
              y: { grid: { display: false }, ticks: { autoSkip: false } },
            }
          : {
              x: { grid: { display: false }, ticks: { maxRotation: 60, minRotation: 0, autoSkip: true } },
              y: { beginAtZero: true, ticks: { callback: (v) => formatKpi(Number(v), displayUnit) } },
            },
      },
    });

    return () => {
      chart.current?.destroy();
      chart.current = null;
    };
  }, [data, onDrill, variant, currency, chartId]);

  /**
   * The bucket under the pointer by position on the category axis: its tick
   * label, or the empty part of its row beside a short bar. Null outside the
   * band of rows (the legend, the value axis).
   */
  function bucketAt(
    c: ChartJS,
    e: { x: number | null; y: number | null },
  ): number | null {
    if (!data || e.x === null || e.y === null) return null;
    const horiz = HORIZONTAL_CHARTS.has(chartId);
    const ax = horiz ? c.scales['y'] : c.scales['x'];
    const area = c.chartArea;
    if (!ax || !area) return null;
    // Across the rows only: a horizontal chart's labels sit left of the plot,
    // a vertical chart's below it.
    if (horiz ? (e.y < area.top || e.y > area.bottom || e.x > area.right)
      : (e.x < area.left || e.x > area.right || e.y < area.top)) return null;
    // A vertical chart's labels are rotated below the plot: the tick under the
    // pointer is the nearest one on x, which getValueForPixel gives.
    const v = ax.getValueForPixel(horiz ? e.y : e.x);
    if (v === undefined || v === null) return null;
    const i = Math.round(Number(v));
    return i >= 0 && i < data.buckets.length ? i : null;
  }

  /**
   * A click OUTSIDE the plot - on a category's axis label. Chart.js calls its
   * onClick only inside the plot area, so the label needs the canvas's own
   * listener; inside the plot this returns null and the chart handles it.
   */
  function outsideBucket(ev: React.MouseEvent<HTMLCanvasElement>): number | null {
    const c = chart.current;
    if (!c || !bucketClick.current) return null;
    const a = c.chartArea;
    const r = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    if (!a || (x >= a.left && x <= a.right && y >= a.top && y <= a.bottom)) return null;
    return bucketAt(c, { x, y });
  }

  if (error) {
    return (
      <div className="panel">
        <h2>{chartId}</h2>
        <p className="note">Could not load: {error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="panel">
        <div className="chart-box" />
      </div>
    );
  }

  // A horizontal chart grows with its categories, one readable row each.
  const boxHeight = WIDE_CHARTS[chartId]
    ?? (HORIZONTAL_CHARTS.has(chartId) ? Math.max(260, data.buckets.length * 26 + 50) : undefined);

  return (
    <div className={WIDE_CHARTS[chartId] ? 'panel chart-wide' : 'panel'}>
      <h2>{data.title}</h2>
      {data.buckets.length === 0 ? (
        // An empty chart states the reason rather than rendering empty axes.
        <p className="note">{data.notes[0] ?? 'No data for this chart'}</p>
      ) : (
        <>
          <div className="chart-box" style={boxHeight ? { height: boxHeight } : undefined}>
            <canvas
              ref={canvas}
              role="img"
              aria-label={data.title}
              onClick={(ev) => {
                const i = outsideBucket(ev);
                const b = i === null ? undefined : data.buckets[i];
                if (b) bucketClick.current?.(b.key, b.label);
              }}
              onMouseMove={(ev) => {
                const c = chart.current;
                if (!c || !bucketClick.current) return;
                const a = c.chartArea;
                const r = ev.currentTarget.getBoundingClientRect();
                const x = ev.clientX - r.left;
                const y = ev.clientY - r.top;
                // Inside the plot, the chart's own onHover sets the cursor.
                if (a && x >= a.left && x <= a.right && y >= a.top && y <= a.bottom) return;
                ev.currentTarget.style.cursor = outsideBucket(ev) === null ? 'default' : 'pointer';
              }}
            />
          </div>
          {(data.notes.length > 0 || onApplyFilter) && (
            <p className="note">
              {data.notes.join(' · ')}
              {onApplyFilter && (
                <>{data.notes.length > 0 ? ' · ' : ''}Alt-click a bar to filter the page by it</>
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}
