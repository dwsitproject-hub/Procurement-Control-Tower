import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { FLAG_META, formatCell, formatNumber } from '../lib/format';

/**
 * Detail table — v1's pg-dt, all 41 columns.
 *
 * Filtering, sorting, searching and paging all happen server-side against a
 * partitioned view. v1 held the row model in browser memory and re-sorted
 * ~21,000 rows on every click.
 *
 * Column visibility and order persist per user via /api/v1/me/preferences, so a
 * layout follows the user across devices — v1 kept this in localStorage, which
 * its own PRD conceded was unreliable.
 */

interface Column {
  key: string;
  label: string;
  type: string;
  currency?: string;
  default: boolean;
  sortable: boolean;
}

interface Facet {
  value: string;
  count: number;
}

interface DetailResponse {
  datasetVersionId: number;
  asOfDate: string;
  totalCount: number;
  columns: Column[];
  rows: Record<string, unknown>[];
  appliedFilters: Record<string, unknown>;
  nextCursor: string | null;
  facets: Record<string, Facet[]>;
}

type MultiKey =
  | 'status' | 'matCat' | 'matGroup' | 'plant' | 'company'
  | 'purchOrg' | 'purchGroup' | 'priority';

const FILTER_LABELS: Record<MultiKey, string> = {
  status: 'Status',
  matCat: 'Category',
  matGroup: 'Mat Group',
  plant: 'Plant',
  company: 'Company',
  purchOrg: 'Purch Org',
  purchGroup: 'Purch Grp',
  priority: 'Priority',
};

const NUMERIC = new Set(['int', 'number', 'money', 'pct']);

export function DetailTable({
  initial,
  initialLabel,
}: {
  /** Pre-applied filters from a drill handoff ("Open in Detail tab", G1.2). */
  initial?: Record<string, string>;
  initialLabel?: string;
} = {}) {
  const init = initial ?? {};
  const listOf = (k: string): string[] | undefined =>
    init[k] !== undefined ? init[k]!.split(',').filter(Boolean) : undefined;

  const [data, setData] = useState<DetailResponse | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<50 | 100 | 200>(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState(init['q'] ?? '');
  const [debounced, setDebounced] = useState(init['q'] ?? '');
  const [filters, setFilters] = useState<Partial<Record<MultiKey, string[]>>>(() => {
    const f: Partial<Record<MultiKey, string[]>> = {};
    for (const k of ['status', 'matCat', 'plant', 'company', 'purchOrg', 'purchGroup', 'priority'] as MultiKey[]) {
      const v = listOf(k);
      if (v && v.length > 0) f[k] = v;
    }
    return f;
  });
  const [excludeSto, setExcludeSto] = useState(init['excludeSto'] === 'true');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(init['onlyOpen'] === 'true');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [visible, setVisible] = useState<string[] | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const savedRef = useRef(false);
  const dragKey = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Load the persisted layout once, before the first fetch renders columns.
  useEffect(() => {
    api
      .get<{ value: { columns?: string[] } | null }>('/api/v1/me/preferences/detail_table_layout')
      .then((p) => {
        if (p?.value?.columns?.length) setVisible(p.value.columns);
      })
      .catch(() => undefined)
      .finally(() => {
        savedRef.current = true;
      });
  }, []);

  const queryString = useMemo(() => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v && v.length > 0) q.set(k, v.join(','));
    }
    if (debounced.trim() !== '') q.set('q', debounced.trim());
    if (excludeSto) q.set('excludeSto', 'true');
    if (includeDeleted) q.set('includeDeleted', 'true');
    if (onlyOpen) q.set('onlyOpen', 'true');
    if (sort) {
      q.set('sort', sort.key);
      q.set('dir', sort.dir);
    }
    q.set('limit', String(pageSize));
    q.set('facets', 'true');
    return q.toString();
  }, [filters, debounced, excludeSto, includeDeleted, onlyOpen, sort, pageSize]);

  // Any filter/sort/page-size change restarts at page 1.
  useEffect(() => {
    setPage(0);
  }, [filters, debounced, excludeSto, includeDeleted, onlyOpen, sort, pageSize]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<DetailResponse>(`/api/v1/detail?${queryString}${page > 0 ? `&cursor=${page * pageSize}` : ''}`)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setRows(d.rows);
        if (visible === null) setVisible(d.columns.filter((c) => c.default).map((c) => c.key));
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `visible` deliberately excluded: changing columns must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString, page]);

  const persistLayout = useCallback((cols: string[]) => {
    if (!savedRef.current) return;
    void api
      .put('/api/v1/me/preferences/detail_table_layout', { value: { columns: cols } })
      .catch(() => undefined);
  }, []);

  const toggleColumn = (key: string) => {
    setVisible((cur) => {
      const base = cur ?? [];
      const next = base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
      persistLayout(next);
      return next;
    });
  };

  // Drag a header onto another to move it there. The `visible` array IS the
  // column order, so reordering it is the whole feature; the same layout
  // preference that stores visibility persists the order.
  const reorderColumn = (from: string, to: string) => {
    if (from === to) return;
    setVisible((cur) => {
      if (!cur) return cur;
      const fi = cur.indexOf(from);
      const ti = cur.indexOf(to);
      if (fi < 0 || ti < 0) return cur;
      const next = [...cur];
      next.splice(fi, 1);
      next.splice(ti, 0, from);
      persistLayout(next);
      return next;
    });
  };

  const toggleFilter = (key: MultiKey, value: string) => {
    setFilters((cur) => {
      const list = cur[key] ?? [];
      const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
      return { ...cur, [key]: next };
    });
  };

  const clearFilters = () => {
    setFilters({});
    setSearch('');
    setExcludeSto(false);
    setIncludeDeleted(false);
    setOnlyOpen(false);
  };

  const activeFilterCount =
    Object.values(filters).reduce((n, v) => n + (v?.length ?? 0), 0) +
    (debounced.trim() ? 1 : 0) +
    (excludeSto ? 1 : 0) +
    (includeDeleted ? 1 : 0) +
    (onlyOpen ? 1 : 0);

  const shown = useMemo(() => {
    if (!data || !visible) return [];
    const byKey = new Map(data.columns.map((c) => [c.key, c]));
    return visible.map((k) => byKey.get(k)).filter((c): c is Column => c !== undefined);
  }, [data, visible]);

  if (error) {
    return (
      <div className="panel">
        <h2>Detail table</h2>
        <p className="err">{error}</p>
      </div>
    );
  }

  return (
    <>
      <div className="panel">
        {initialLabel && (
          <p className="note" style={{ marginTop: 0 }}>
            Pre-applied: <strong>{initialLabel}</strong> — adjust or clear the filters below.
          </p>
        )}
        <div className="dt-toolbar">
          <input
            className="dt-search"
            type="search"
            placeholder="Search PR, PO, description, vendor, plant, WBS…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search detail rows"
          />
          <label className="dt-check">
            <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />
            Open only
          </label>
          <label className="dt-check">
            <input type="checkbox" checked={excludeSto} onChange={(e) => setExcludeSto(e.target.checked)} />
            Exclude STO
          </label>
          <label className="dt-check">
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(e) => setIncludeDeleted(e.target.checked)}
            />
            Include deleted
          </label>
          <span style={{ flex: 1 }} />
          {activeFilterCount > 0 && (
            <button className="dt-btn" onClick={clearFilters}>
              Clear {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''}
            </button>
          )}
          <button className="dt-btn" onClick={() => setChooserOpen(!chooserOpen)} aria-expanded={chooserOpen}>
            Columns ({shown.length}/{data?.columns.length ?? 0})
          </button>
        </div>

        {chooserOpen && data && (
          <div className="dt-chooser">
            {data.columns.map((c) => (
              <label key={c.key} className="dt-chip">
                <input
                  type="checkbox"
                  checked={visible?.includes(c.key) ?? false}
                  onChange={() => toggleColumn(c.key)}
                />
                {c.label}
              </label>
            ))}
          </div>
        )}

        {data && (
          <div className="dt-facets">
            {(Object.keys(FILTER_LABELS) as MultiKey[]).map((key) => {
              const opts = data.facets[key] ?? [];
              if (opts.length === 0) return null;
              const active = filters[key] ?? [];
              return (
                <details key={key} className="dt-facet">
                  <summary>
                    {FILTER_LABELS[key]}
                    {active.length > 0 && <span className="dt-badge">{active.length}</span>}
                  </summary>
                  <div className="dt-facet-list">
                    {opts.map((o) => (
                      <label key={o.value} className="dt-chip">
                        <input
                          type="checkbox"
                          checked={active.includes(o.value)}
                          onChange={() => toggleFilter(key, o.value)}
                        />
                        {o.value} <span className="muted">({formatNumber(o.count)})</span>
                      </label>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        )}

        <p className="count">
          {loading && !data ? (
            'Loading…'
          ) : (
            <>
              <strong>{formatNumber(data?.totalCount ?? 0)}</strong> rows
              {(data?.totalCount ?? 0) > pageSize && (
                <> · showing {formatNumber(page * pageSize + 1)}–{formatNumber(Math.min((page + 1) * pageSize, data?.totalCount ?? 0))}</>
              )}
              {loading && <> · refreshing…</>}
            </>
          )}
        </p>

        {data && data.totalCount === 0 && (
          <p className="note">
            No rows match. {activeFilterCount > 0 ? 'Try clearing a filter.' : 'Your data scope may not include any rows.'}
          </p>
        )}

        {data && data.totalCount > 0 && (
          <div className="table-wrap dt-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th />
                  {shown.map((c) => (
                    <th
                      key={c.key}
                      draggable
                      className={dragOver === c.key ? 'dt-dragover' : undefined}
                      title="Drag to reorder"
                      onDragStart={(e) => {
                        dragKey.current = c.key;
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (dragOver !== c.key) setDragOver(c.key);
                      }}
                      onDragLeave={() => setDragOver((cur) => (cur === c.key ? null : cur))}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragKey.current) reorderColumn(dragKey.current, c.key);
                        dragKey.current = null;
                        setDragOver(null);
                      }}
                      onDragEnd={() => {
                        dragKey.current = null;
                        setDragOver(null);
                      }}
                    >
                      {c.sortable ? (
                        <button
                          className="dt-sort"
                          onClick={() =>
                            setSort((cur) =>
                              cur?.key === c.key
                                ? { key: c.key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
                                : { key: c.key, dir: 'asc' },
                            )
                          }
                          aria-label={`Sort by ${c.label}`}
                        >
                          {c.label}
                          {sort?.key === c.key && <span aria-hidden="true">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
                        </button>
                      ) : (
                        c.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="dt-flags">
                      {((r['flags'] as string[]) ?? []).map((f) => {
                        const m = FLAG_META[f];
                        return m ? (
                          <span key={f} className="flag" title={m.label}>
                            {m.icon}
                          </span>
                        ) : null;
                      })}
                    </td>
                    {shown.map((c) => (
                      <td key={c.key} className={NUMERIC.has(c.type) ? 'num' : ''}>
                        {formatCell(r[c.key], c.type, c.currency)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && data.totalCount > 0 && (
          <div className="dt-pager">
            <label className="dt-check">
              Rows per page
              <select
                className="ly-swap"
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value) as 50 | 100 | 200)}
              >
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
              </select>
            </label>
            {(() => {
              const pages = Math.max(1, Math.ceil(data.totalCount / pageSize));
              const nums: number[] = [];
              for (let i = 0; i < pages; i += 1) {
                if (i === 0 || i === pages - 1 || Math.abs(i - page) <= 2) nums.push(i);
              }
              return (
                <span className="dt-pages">
                  <button className="dt-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Prev</button>
                  {nums.map((n2, idx) => (
                    <span key={n2}>
                      {idx > 0 && nums[idx - 1] !== n2 - 1 && <span className="muted">…</span>}
                      <button
                        className="dt-btn"
                        aria-current={n2 === page ? 'page' : undefined}
                        style={n2 === page ? { borderColor: 'var(--accent)', fontWeight: 700 } : {}}
                        onClick={() => setPage(n2)}
                      >
                        {n2 + 1}
                      </button>
                    </span>
                  ))}
                  <button className="dt-btn" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next ›</button>
                  <span className="muted">page {page + 1} of {formatNumber(pages)}</span>
                </span>
              );
            })()}
          </div>
        )}
      </div>
    </>
  );
}
