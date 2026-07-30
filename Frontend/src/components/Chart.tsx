import { useEffect, useRef, useState } from 'react';
import {
  BarController, BarElement, CategoryScale, Chart as ChartJS, Legend, LinearScale, Tooltip,
} from 'chart.js';
import { api, type ChartResponse } from '../lib/api';
import { formatKpi } from '../lib/format';

ChartJS.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948'];

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
}: {
  chartId: string;
  onDrill: (token: string, label: string) => void;
  /** Global filter as a query string; empty keeps the precomputed path. */
  filterQuery?: string;
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
          backgroundColor: PALETTE[i % PALETTE.length],
          borderRadius: 3,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        onClick: (_e, elements) => {
          const el = elements[0];
          if (!el) return;
          const series = data.series[el.datasetIndex];
          const bucket = data.buckets[el.index];
          if (!series || !bucket) return;
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
  }, [data, onDrill]);

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
          {data.notes.length > 0 && <p className="note">{data.notes.join(' · ')}</p>}
        </>
      )}
    </div>
  );
}
