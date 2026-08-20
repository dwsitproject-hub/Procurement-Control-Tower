import { Suspense, lazy, useEffect, useState } from 'react';
import { api, type Kpi } from '../lib/api';
import { KpiCard } from './KpiCard';

const ChartPanel = lazy(() => import('./Chart').then((m) => ({ default: m.ChartPanel })));

/**
 * The Executive Summary's focus panel: the Overview page's structure, scoped to
 * whatever figure was clicked.
 *
 * The drill modal answers "which rows are behind this number". This answers the
 * question after that one — "what does the rest of the business look like for
 * just this slice" — by rendering the same KPI cards and charts the Overview
 * uses, with the slice applied as a filter.
 *
 * It is built entirely from the existing KPI and chart endpoints under a filter,
 * which is why it needed GlobalFilter to grow spendCategory, sizeBand and
 * delivered (022): without those dimensions the slice could not be expressed as
 * a filter at all, and this panel would have had to re-implement every figure.
 *
 * A card or chart that cannot honour the slice reports itself unavailable rather
 * than showing an unfiltered number — that behaviour already exists in the KPI
 * and chart routes and is the reason this is safe to assemble from them.
 */
export function ExecFocusModal({
  title, subtitle, filterQuery, kpiIds, chartIds, currency, onDrill, onClose,
}: {
  title: string;
  subtitle: string;
  /** Global filter AND the clicked slice, already merged. */
  filterQuery: string;
  kpiIds: string[];
  chartIds: string[];
  currency: 'USD' | 'IDR';
  onDrill: (token: string, label: string) => void;
  onClose: () => void;
}) {
  const [kpis, setKpis] = useState<Kpi[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const qs = new URLSearchParams(filterQuery);
    qs.set('ids', kpiIds.join(','));
    api.get<{ kpis: Kpi[] }>(`/api/v1/kpi?${qs.toString()}`)
      .then((d) => { if (!dead) setKpis(d.kpis); })
      .catch((e: Error) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [filterQuery, kpiIds]);

  // Escape closes, matching the drill modal. A panel this large is easy to open
  // by accident from a stacked bar segment.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ordered = kpiIds
    .map((id) => kpis?.find((k) => k.kpiId === id))
    .filter((k): k is Kpi => k !== undefined);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h3>🎯 {title}</h3>
          <span className="count">{subtitle}</span>
          <span className="spacer" />
          <button type="button" className="dd-x" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="body">
          {err && <p className="note"><span className="bs spdel">error</span> {err}</p>}
          <p className="note">
            The Overview, scoped to this figure. Every card and chart below is recomputed
            under the same slice, so a number here can be compared with the same number on
            the Overview page and the difference is the slice.
          </p>

          {kpis === null ? <div className="spinner" /> : (
            <div className="kpi-grid">
              {ordered.map((k) => (
                <KpiCard key={k.kpiId} kpi={k} onDrill={onDrill} currency={currency} />
              ))}
            </div>
          )}

          {chartIds.map((c) => (
            <Suspense key={c} fallback={<div className="panel" style={{ minHeight: 180 }}><div className="spinner" /></div>}>
              <ChartPanel
                chartId={c}
                onDrill={onDrill}
                filterQuery={filterQuery}
                currency={currency}
              />
            </Suspense>
          ))}
        </div>
      </div>
    </div>
  );
}
