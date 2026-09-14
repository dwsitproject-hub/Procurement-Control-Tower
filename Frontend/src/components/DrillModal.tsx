import { useEffect, useState } from 'react';
import { ApiError, api, downloadFile, type DrillPage } from '../lib/api';
import { FLAG_META, STATUS_PILL, formatCell, formatNumber, moneyCellText } from '../lib/format';

/** v1's aging colour rule: > 30 days red, > 14 amber, both bold. */
function agingStyle(days: number): React.CSSProperties | undefined {
  if (days > 30) return { color: 'var(--crit)', fontWeight: 700 };
  if (days > 14) return { color: 'var(--warn)', fontWeight: 700 };
  return undefined;
}


/**
 * Drill modal.
 *
 * The count shown here must equal the aggregate that opened it. That holds
 * because the server re-executes the same stored predicate against the same
 * immutable dataset version, rather than re-deriving a filter client-side.
 */
export function DrillModal({
  token,
  label,
  onClose,
  onOpenDetail,
}: {
  token: string;
  label: string;
  onClose: () => void;
  /** v1's "Open in Detail tab →": receives detail query params + the drill label. */
  onOpenDetail?: (params: Record<string, string>, label: string, unmapped: string[]) => void;
}) {
  const [page, setPage] = useState<DrillPage | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<{ expired: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<DrillPage>(`/api/v1/drill/${token}?limit=200`)
      .then((d) => {
        if (cancelled) return;
        setPage(d);
        setRows(d.rows);
        setCursor(d.nextCursor);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const expired = e instanceof ApiError && e.problem.type.includes('drill-token-expired');
        setError({
          expired,
          message: e instanceof Error ? e.message : String(e),
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  /**
   * Export every row behind this figure.
   *
   * No filter parameters: the token carries the stored predicate, so the
   * server re-executes the same query that produced the count in the header.
   * That is the same guarantee the panel itself relies on, which is why the
   * file cannot disagree with the number the user clicked.
   *
   * The panel holds 200 rows at a time; the file holds all of them. Exporting
   * only what had been scrolled into view would be a different, much less
   * useful feature.
   */
  const exportExcel = async () => {
    if (exporting) return;
    setExporting(true);
    setExportNote(null);
    try {
      // The heading the user is looking at, so the file is named after it.
      const shown = label || page?.label || '';
      const r = await downloadFile(
        `/api/v1/drill/${token}/export.xlsx${shown ? `?label=${encodeURIComponent(shown)}` : ''}`,
        'pct-drill.xlsx',
      );
      const n = r.rows ?? 0;
      setExportNote(
        r.total !== null && r.total > n
          ? `Downloaded ${r.filename} \u2014 ${formatNumber(n)} of ${formatNumber(r.total)} rows. `
            + 'The export stops at 50,000.'
          : `Downloaded ${r.filename} \u2014 ${formatNumber(n)} rows.`,
      );
    } catch (e) {
      // An expired token is the likely failure here, and it is the same
      // 15-minute expiry the panel explains above -- so say so in the same
      // words rather than showing a bare 401.
      const expired = e instanceof ApiError && e.problem.type.includes('drill-token-expired');
      setExportNote(
        expired
          ? 'Export failed: this drill link has expired. Close this and click the figure again.'
          : `Export failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setExporting(false);
    }
  };

  const loadMore = async () => {
    if (!cursor) return;
    const d = await api.get<DrillPage>(`/api/v1/drill/${token}?limit=200&cursor=${cursor}`);
    setRows((r) => [...r, ...d.rows]);
    setCursor(d.nextCursor);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drill-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3 id="drill-title">{'\u{1F50D} '}{label || page?.label}</h3>
          <span className="spacer" />
          {page && !error && page.totalCount > 0 && (
            <button
              className="dd-open"
              onClick={() => void exportExcel()}
              disabled={exporting}
              title={`Export all ${formatNumber(page.totalCount)} rows behind this figure to Excel`}
            >
              {exporting ? 'Preparing\u2026' : '\u2B07 Export to Excel'}
            </button>
          )}
          {page?.detailHandoff && onOpenDetail && (
            <button
              className="dd-open"
              title={
                page.detailHandoff.unmapped.length > 0
                  ? `Approximate: ${page.detailHandoff.unmapped.join(', ')} cannot be expressed as detail filters`
                  : 'Open these rows in the Detail Table'
              }
              onClick={() =>
                onOpenDetail(page.detailHandoff!.params, page.label, page.detailHandoff!.unmapped)
              }
            >
              Open in Detail tab →
            </button>
          )}
          <button className="dd-x" onClick={onClose} aria-label="Close" title="Close">
            {'\u2715'}
          </button>
        </header>

        <div className="body">
          {loading && <div className="center-msg"><div className="spinner" />Loading rows…</div>}

          {error && (
            <div className="center-msg">
              {error.expired ? (
                <>
                  <p>This drill link has expired.</p>
                  <p className="muted">
                    Drill tokens are valid for 15 minutes and bound to your session. Close this and
                    click the figure again.
                  </p>
                </>
              ) : (
                <p className="err">{error.message}</p>
              )}
            </div>
          )}

          {page && !error && (
            <>
              <p className="count">
                <strong>{formatNumber(page.totalCount)}</strong> rows
                {/* v1's dd-modal header: value totals over the whole population. */}
                {page.totals?.idrSum !== null && page.totals?.idrSum !== undefined && (
                  <> · Σ {(page.totals.idrSum / 1e9).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} B IDR</>
                )}
                {page.totals && page.totals.usdSum !== null && (
                  <> · ≈ ${formatNumber(Math.round(page.totals.usdSum))} USD</>
                )}
                {page.totals && !page.totals.usdComplete && (
                  <> · <span title="Some lines have no FX rate — no USD total is shown rather than an understated one.">USD total unavailable (unrated currencies)</span></>
                )}
                {page.grain === 'pr_item' && page.totals?.idrSum !== null && page.totals?.idrSum !== undefined && (
                  <> · PR rows valued at PR estimate</>
                )}
                {page.note && <> · {page.note}</>}
                {rows.length < page.totalCount && <> · showing {formatNumber(rows.length)}</>}
              </p>

              {exportNote && (
                <p className={exportNote.startsWith('Export failed') ? 'err' : 'note'}>
                  {exportNote}
                </p>
              )}

              {page.totalCount === 0 ? (
                <p className="note">
                  No rows match this figure. If the figure was non-zero, your data scope may not
                  include them.
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="data dd-tbl">
                    <thead>
                      <tr>
                        <th />
                        {page.columns.map((c) => (
                          <th key={c.key}>{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        // v1's row classes: deleted rows dim (rd), others stripe (re).
                        const st = String(r['status'] ?? '');
                        const rowCls =
                          st === 'Deleted' || st === 'PO-Deleted' ? 'rd' : i % 2 ? '' : 're';
                        return (
                        <tr key={i} className={rowCls}>
                          <td>
                            {((r['flags'] as string[]) ?? []).map((f) => {
                              const m = FLAG_META[f];
                              return m ? (
                                <span key={f} className="flag" title={m.label}>
                                  {m.icon}
                                </span>
                              ) : null;
                            })}
                          </td>
                          {page.columns.map((c) => {
                            const v = r[c.key];
                            const num = ['money', 'int', 'number', 'pct'].includes(c.type);
                            // v1's status pill, colour-coded per lifecycle state.
                            if (c.key === 'status' && v) {
                              return (
                                <td key={c.key}>
                                  <span className={'bs ' + (STATUS_PILL[String(v)] ?? 'sl')}>
                                    {String(v)}
                                  </span>
                                </td>
                              );
                            }
                            // v1's aging colour rule.
                            if (c.key === 'agingDays' && v !== null && v !== undefined) {
                              return (
                                <td key={c.key} className="num" style={agingStyle(Number(v))}>
                                  {formatNumber(Number(v))}
                                </td>
                              );
                            }
                            // v1's value cells: compact M + small blue ccy tag; USD plain.
                            if (c.type === 'money') {
                              if (v === null || v === undefined) {
                                return <td key={c.key} className="num dd-dash">{'\u2014'}</td>;
                              }
                              if (c.currency === 'USD') {
                                return (
                                  <td key={c.key} className="num">
                                    {Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                  </td>
                                );
                              }
                              const ccy = c.currency ?? String(r['currencyCode'] ?? 'IDR');
                              return (
                                <td key={c.key} className="num">
                                  {moneyCellText(Number(v))} <span className="dd-ccy">{ccy}</span>
                                </td>
                              );
                            }
                            return (
                              <td key={c.key} className={num ? 'num' : ''}>
                                {formatCell(v, c.type, c.currency)}
                              </td>
                            );
                          })}
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {cursor && (
                <button className="btn secondary" style={{ marginTop: '.75rem' }} onClick={loadMore}>
                  Load more
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
