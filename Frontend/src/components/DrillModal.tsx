import { useEffect, useState } from 'react';
import { ApiError, api, type DrillPage } from '../lib/api';
import { FLAG_META, formatCell, formatNumber } from '../lib/format';

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
}: {
  token: string;
  label: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState<DrillPage | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<{ expired: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState(true);

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
          <h3 id="drill-title">{page?.label ?? label}</h3>
          <span className="spacer" />
          <button className="btn secondary" style={{ width: 'auto' }} onClick={onClose}>
            Close
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
                {page.note && <> · {page.note}</>}
                {rows.length < page.totalCount && <> · showing {formatNumber(rows.length)}</>}
              </p>

              {page.totalCount === 0 ? (
                <p className="note">
                  No rows match this figure. If the figure was non-zero, your data scope may not
                  include them.
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th />
                        {page.columns.map((c) => (
                          <th key={c.key}>{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i}>
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
                          {page.columns.map((c) => (
                            <td
                              key={c.key}
                              className={
                                ['money', 'int', 'number', 'pct'].includes(c.type) ? 'num' : ''
                              }
                            >
                              {formatCell(r[c.key], c.type, c.currency)}
                            </td>
                          ))}
                        </tr>
                      ))}
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
