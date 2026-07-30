import { useState } from 'react';
import type { DatasetCurrent } from '../lib/api';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';

const STATE_META: Record<string, { icon: string; label: string; sr: string }> = {
  current: { icon: '✔', label: 'Current', sr: 'Data is current' },
  ageing: { icon: '!', label: 'Ageing', sr: 'Data is ageing' },
  stale: { icon: '!!', label: 'Stale', sr: 'Data is stale' },
  caveats: { icon: '!', label: 'Caveats active', sr: 'Data has active caveats' },
  loading: { icon: '…', label: 'Loading', sr: 'Data is loading' },
};

const FEED_LABEL: Record<string, string> = {
  pr: 'PR Report',
  prel: 'PR Release',
  po: 'PO Report',
  por: 'PO Release',
  gr: 'GR List',
  fx: 'FX Rates',
};

/**
 * The freshness banner — PRD §14.1.
 *
 * Persistently visible on every screen, never behind a click. Because all aging
 * is computed from the as-of date rather than wall-clock time, a stale dataset
 * produces stale numbers rather than drifting ones; this banner is what explains
 * why the figures are not moving.
 */
export function FreshnessBanner({ data }: { data: DatasetCurrent }) {
  const [open, setOpen] = useState(false);
  const meta = STATE_META[data.freshnessState] ?? STATE_META.current!;

  return (
    <>
      <div className="freshness" data-state={data.freshnessState}>
        <span className="dot" aria-hidden="true" />
        <span className="sr-only">{meta.sr}</span>
        <strong>Data as of {formatDate(data.asOfDate)}</strong>
        <span className="sep">·</span>
        <span className="muted">
          loaded {formatDateTime(data.publishedAt)} ({data.sourceLabel})
        </span>
        <span className="sep">·</span>
        {/* Severity is never colour-only: the icon and text carry it too. */}
        <span className="state">
          {meta.icon} {meta.label}
        </span>
        {data.activeCaveats.length > 0 && (
          <>
            <span className="sep">·</span>
            <span className="muted">
              {data.activeCaveats.length} caveat{data.activeCaveats.length > 1 ? 's' : ''}
            </span>
          </>
        )}
        <span style={{ flex: 1 }} />
        <button aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide details' : 'Details'}
        </button>
      </div>

      {open && (
        <div className="details-panel">
          <p style={{ margin: '0 0 .6rem' }}>
            Dataset version <strong>{data.datasetVersionId}</strong> · as-of source{' '}
            <code>{data.asOfSource}</code> · FX policy <code>{data.fxPolicy}</code>
            {data.publishedBy ? ` · published by ${data.publishedBy}` : ' · published by system'}
          </p>

          <table>
            <thead>
              <tr>
                <th>Feed</th>
                <th>File</th>
                <th style={{ textAlign: 'right' }}>Rows</th>
                <th style={{ textAlign: 'right' }}>Δ vs previous</th>
                <th>SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {data.feeds.map((f) => (
                <tr key={f.feed}>
                  <td>{FEED_LABEL[f.feed] ?? f.feed}</td>
                  {/* Source-supplied filename: React escapes it on render. */}
                  <td className="muted">{f.filename}</td>
                  <td style={{ textAlign: 'right' }}>{formatNumber(f.rowCount)}</td>
                  <td
                    style={{ textAlign: 'right' }}
                    className={f.rowDelta ? 'delta-pos' : 'delta-zero'}
                  >
                    {f.rowDelta === null
                      ? '—'
                      : f.rowDelta === 0
                        ? 'unchanged'
                        : `${f.rowDelta > 0 ? '+' : ''}${formatNumber(f.rowDelta)}`}
                  </td>
                  <td className="muted">
                    <code>{f.sha256Short}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p style={{ margin: '.7rem 0 .2rem' }}>
            Validation: <span className="sev sev-BLOCKER">{data.validationSummary.blocker} blocker</span>{' '}
            <span className="sev sev-CAVEAT">{data.validationSummary.caveat} caveat</span>{' '}
            <span className="sev sev-WARNING">{data.validationSummary.warning} warning</span>{' '}
            <span className="sev sev-INFO">{data.validationSummary.info} info</span>
          </p>

          {data.activeCaveats.map((c) => (
            <p key={c.ruleId} className="muted" style={{ margin: '.35rem 0' }}>
              <span className="sev sev-CAVEAT">{c.ruleId}</span> {c.message}
              {c.disablesKpis.length > 0 && (
                <> <em>Disables: {c.disablesKpis.join(', ')}.</em></>
              )}
            </p>
          ))}

          <p className="muted" style={{ margin: '.7rem 0 0' }}>
            Rules in force for this version:{' '}
            <code>
              WBS ≥ IDR {formatNumber(Number(data.ruleSnapshot['wbs.material_threshold_idr']) / 1e6)}M
              material / ≥ IDR {formatNumber(Number(data.ruleSnapshot['wbs.service_threshold_idr']) / 1e6)}M
              service, {String(data.ruleSnapshot['wbs.basis'])}
            </code>{' '}
            · aging &gt; {String(data.ruleSnapshot['aging.threshold_days'])}d · release-exempt policy{' '}
            <code>{String(data.ruleSnapshot['release.no_strategy_policy'])}</code>
          </p>
        </div>
      )}
    </>
  );
}
