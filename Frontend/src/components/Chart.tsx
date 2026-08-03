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
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
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

  useEffect(() => {
    if (!data || !canvas.current || data.buckets.length === 0) return;

    chart.current?.destroy();
    const labels = data.buckets.map((b) => b.label);

    if (variant === 'doughnut') {
      const series = data.series[0];
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
            ctx.fillText(Number(v).toLocaleString('en-GB'), pos.x, pos.y);
          });
          ctx.restore();
        },
      };
      (doughnutCfg as unknown as { plugins: unknown[] }).plugins = [segmentLabels];
      (doughnutCfg.options.plugins.legend.labels as unknown as Record<string, unknown>)['generateLabels'] = (
        c: { data: { labels: string[]; datasets: { data: number[]; backgroundColor: string[] }[] } },
      ) =>
        c.data.labels.map((l, i) => ({
          text: `${l} — ${Number(c.data.datasets[0]!.data[i]).toLocaleString('en-GB')}`,
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

    chart.current = new ChartJS(canvas.current, {
      type: 'bar',
      data: {
        labels,
        datasets: data.series.map((s, i) => ({
          label: s.label,
          data: data.buckets.map((b) => {
            const p = s.points.find((x) => x.bucketKey === b.key);
            return p?.value ?? null;
          }),
          // Single-series priority charts colour each bucket like v1
          // (Emergency red ... Planned green); everything else keeps one hue.
          backgroundColor:
            data.series.length === 1 && data.buckets.some((b) => PRIORITY_COLORS[b.label])
              ? data.buckets.map((b) => PRIORITY_COLORS[b.label] ?? PALETTE[0]!)
              : PALETTE[i % PALETTE.length],
          borderRadius: 3,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        onClick: (e, elements) => {
          const el = elements[0];
          if (!el) return;
          const series = data.series[el.datasetIndex];
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
          legend: { display: data.series.length > 1, position: 'bottom', labels: { boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const series = data.series[ctx.datasetIndex];
                const bucket = data.buckets[ctx.dataIndex];
                const p = series?.points.find((x) => x.bucketKey === bucket?.key);
                const v = formatKpi(ctx.parsed.y, data.unit);
                // Show the row count that the drill will return.
                return `${series?.label}: ${v}${p ? ` (${p.rowCount.toLocaleString()} rows)` : ''}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 60, minRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, ticks: { callback: (v) => formatKpi(Number(v), data.unit) } },
        },
      },
    });

    return () => {
      chart.current?.destroy();
      chart.current = null;
    };
  }, [data, onDrill, variant]);

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

  return (
    <div className="panel">
      <h2>{data.title}</h2>
      {data.buckets.length === 0 ? (
        // An empty chart states the reason rather than rendering empty axes.
        <p className="note">{data.notes[0] ?? 'No data for this chart'}</p>
      ) : (
        <>
          <div className="chart-box">
            <canvas ref={canvas} role="img" aria-label={data.title} />
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
