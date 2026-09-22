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
  title, subtitle, clicked, filterQuery, kpiIds, chartIds, currency, onDrill, onClose,
  lifecycleToggle = false,
}: {
  title: string;
  subtitle: string;
  /**
   * The figure the reader clicked, in words, INCLUDING which measure it is.
   *
   * Added 22 Sep 2026. A reader clicked a METHANOL bar worth Rp 1.11 T and the
   * panel's first card read IDR 82.4 B, which looks like a defect and is not
   * one: the bar is net order value over open and closed together, while Open
   * PO Commitment is the value still TO BE delivered on the lines that are not
   * yet complete. Two measures, two numbers, no way for the reader to tell.
   *
   * The caller passes the clicked figure and names its measure, so the panel
   * can restate it above the cards. The caller must describe the population the
   * panel OPENS with, not the segment that was clicked, or the caption will
   * describe something the cards below do not show.
   */
  clicked?: string;
  /** Global filter AND the clicked slice, already merged. */
  filterQuery: string;
  /**
   * Offer All / Open / Closed inside the panel.
   *
   * For a slice that is a POPULATION rather than a lifecycle state — a spend
   * category, say. Clicking the Open segment of a category bar used to pin the
   * panel to open lines, so the obvious next question ("and what about the
   * closed ones?") meant closing the panel and clicking a different segment.
   * The toggle keeps the category and changes the state, which is the axis the
   * reader is actually moving along.
   *
   * Owned here rather than by the caller because it is a property of looking,
   * not of what was clicked: re-opening the panel starts from All again.
   */
  lifecycleToggle?: boolean;
  kpiIds: string[];
  chartIds: string[];
  currency: 'USD' | 'IDR';
  onDrill: (token: string, label: string) => void;
  onClose: () => void;
}) {
  const [kpis, setKpis] = useState<Kpi[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<'' | 'open' | 'closed'>('');

  /**
   * The slice the panel actually asks for.
   *
   * The toggle REPLACES any lifecycle the caller passed rather than adding to
   * it — two `lifecycle` values in one query string would leave the server to
   * pick one, and which one is not something the reader could predict.
   */
  const effectiveQuery = (() => {
    const qs = new URLSearchParams(filterQuery);
    qs.delete('lifecycle');
    if (lifecycle) qs.set('lifecycle', lifecycle);
    return qs.toString();
  })();

  useEffect(() => {
    let dead = false;
    const qs = new URLSearchParams(effectiveQuery);
    qs.set('ids', kpiIds.join(','));
    api.get<{ kpis: Kpi[] }>(`/api/v1/kpi?${qs.toString()}`)
      .then((d) => { if (!dead) setKpis(d.kpis); })
      .catch((e: Error) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [effectiveQuery, kpiIds]);

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
          {lifecycleToggle && (
            <div className="gf-scope" role="group" aria-label="Lifecycle">
              {([['', 'All'], ['open', 'Open'], ['closed', 'Closed']] as const).map(([v, l]) => (
                <button
                  key={v || 'all'}
                  type="button"
                  className={lifecycle === v ? 'on' : ''}
                  aria-pressed={lifecycle === v}
                  onClick={() => setLifecycle(v)}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="dd-x" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="body">
          {err && <p className="note"><span className="bs spdel">error</span> {err}</p>}
          <p className="note">
            The Overview, scoped to this figure. Every card and chart below is recomputed
            under the same slice, so a number here can be compared with the same number on
            the Overview page and the difference is the slice.
          </p>
          {/* The clicked figure, restated. Cards below measure the same slice in
              other ways — order value, value still to deliver, lines — so the
              one number the reader arrived with has to be on screen for the
              others to be read as different questions rather than as errors. */}
          {clicked && (
            <p className="note">
              <strong>You clicked:</strong> {clicked}
            </p>
          )}

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
                filterQuery={effectiveQuery}
                currency={currency}
              />
            </Suspense>
          ))}
        </div>
      </div>
    </div>
  );
}
