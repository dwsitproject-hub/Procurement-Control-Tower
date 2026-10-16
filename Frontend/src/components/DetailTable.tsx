import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, downloadFile } from '../lib/api';
import { ScrollFrame } from './ScrollFrame';
import {
  FLAG_META, STATUS_PILL, agingClass, formatCell, formatNumber, moneyCellText, rowClass,
} from '../lib/format';

/** v1's AW per-column aging warn thresholds (amber above, red above 2x). */
const AGE_WARN: Record<string, number> = {
  praDays: 14, unrelDays: 14, sourcingAgingDays: 14, srcDays: 14,
  poaDays: 14, delivDays: 30, e2eDays: 60,
};

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
  /** Read live from the Coupa store, not the published SAP version. */
  coupa?: boolean;
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
  | 'status' | 'matCat' | 'spendCategory' | 'matGroup' | 'plant' | 'company'
  | 'purchOrg' | 'purchGroup' | 'priority' | 'prDocType' | 'poDocType';

/**
 * Every multi-value filter this table seeds from `initial`, in ONE place.
 *
 * It used to be a literal list inside the state initialiser, and spendCategory
 * was never added to it: a page that pre-filtered by category handed one in,
 * the table dropped it, and the row count under the table disagreed with the
 * number that had been clicked - the one thing the seeding exists to prevent.
 */
const MULTI_KEYS: MultiKey[] = [
  'status', 'matCat', 'spendCategory', 'matGroup', 'plant', 'company',
  'purchOrg', 'purchGroup', 'priority', 'prDocType', 'poDocType',
];

const FILTER_LABELS: Record<MultiKey, string> = {
  status: 'Status',
  matCat: 'Category (legacy)',
  spendCategory: 'Spend category',
  matGroup: 'Mat Group',
  plant: 'Plant',
  company: 'Company',
  purchOrg: 'Purch Org',
  purchGroup: 'Purch Grp',
  priority: 'Priority',
  prDocType: 'PR Type',
  poDocType: 'PO Type',
};

/**
 * Columns made default AFTER people had started saving layouts. A saved layout
 * lists the columns its owner chose, so a column added later would never
 * appear for them; these are offered once, appended, to a layout saved before
 * the table recorded which columns it knew (see `known` below).
 */
const ADDED_DEFAULTS = ['poDeliveryDate'];

/** The filter bar's dimensions the table follows (the global filter, 7 Oct 2026). */
const GLOBAL_KEYS = ['company', 'plant', 'purchOrg', 'year', 'monthKey'] as const;
const GLOBAL_LABELS: Record<(typeof GLOBAL_KEYS)[number], string> = {
  company: 'Company', plant: 'Plant', purchOrg: 'Purch Org', year: 'Year', monthKey: 'Month',
};

const NUMERIC = new Set(['int', 'number', 'money', 'pct']);

export function DetailTable({
  initial,
  initialLabel,
  globalQuery,
}: {
  /** Pre-applied filters from a drill handoff ("Open in Detail tab", G1.2). */
  initial?: Record<string, string>;
  initialLabel?: string;
  /**
   * The filter bar's query string (company, plant, purchOrg, year, monthKey).
   * The table follows it as every other page does - before 7 Oct 2026 it
   * ignored the bar entirely, so with the Year filter on by default it would
   * have listed every year under a bar that said 2026. A Company, Plant or
   * Purch Org picked in the table's OWN filters takes precedence over the
   * bar's, since that is the more specific choice.
   */
  globalQuery?: string;
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
    for (const k of MULTI_KEYS) {
      const v = listOf(k);
      if (v && v.length > 0) f[k] = v;
    }
    return f;
  });
  /**
   * Age band, arriving from an Open Items stage card.
   *
   * A single value rather than a list: the card that sent it drew one band, and
   * the boundaries are the server's (detail.ts AGE_BANDS) so the table returns
   * the number that was clicked.
   */
  const [ageBand, setAgeBand] = useState(init['ageBand'] ?? '');
  /**
   * The post-delivery state, from an Open Items money card.
   *
   * Single-valued like ageBand and for the same reason: the card that sent it
   * counted one state, and the two states are exclusive steps of one sequence.
   * Absent entirely until 23 Sep 2026, so those cards opened a table showing
   * every row in the dataset.
   */
  const [moneyState, setMoneyState] = useState(init['moneyState'] ?? '');
  const [excludeSto, setExcludeSto] = useState(init['excludeSto'] === 'true');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(init['onlyOpen'] === 'true');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [visible, setVisible] = useState<string[] | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const savedRef = useRef(false);
  const dragKey = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  /** Every column key the table knew when the layout was last saved. */
  const knownRef = useRef<string[] | null>(null);

  // Load the persisted layout once, before the first fetch renders columns.
  useEffect(() => {
    api
      .get<{ value: { columns?: string[]; known?: string[] } | null }>('/api/v1/me/preferences/detail_table_layout')
      .then((p) => {
        const cols = p?.value?.columns;
        if (!cols?.length) return;
        knownRef.current = p?.value?.known ?? null;
        // A layout saved before `known` existed gets the later defaults once.
        setVisible(p?.value?.known
          ? cols
          : [...cols, ...ADDED_DEFAULTS.filter((k) => !cols.includes(k))]);
      })
      .catch(() => undefined)
      .finally(() => {
        savedRef.current = true;
      });
  }, []);

  /**
   * The filter half of the query, kept separate from the paging half because
   * the export sends it verbatim.
   *
   * The export endpoint REJECTS `limit`, `cursor` and `facets` rather than
   * ignoring them, so one combined string could not be reused; and building a
   * second string for the export by hand is how an export quietly stops
   * honouring a filter someone added to the table.
   */
  /** The filter bar's values, as {key: 'a,b'}. */
  const globalParams = useMemo(() => {
    const g = new URLSearchParams(globalQuery ?? '');
    const out: Partial<Record<(typeof GLOBAL_KEYS)[number], string>> = {};
    for (const k of GLOBAL_KEYS) {
      const v = g.get(k);
      if (v) out[k] = v;
    }
    return out;
  }, [globalQuery]);

  const filterQuery = useMemo(() => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(globalParams)) q.set(k, v);
    // The table's own picks replace the bar's for the same dimension.
    for (const [k, v] of Object.entries(filters)) {
      if (v && v.length > 0) q.set(k, v.join(','));
    }
    if (debounced.trim() !== '') q.set('q', debounced.trim());
    if (ageBand) q.set('ageBand', ageBand);
    if (moneyState) q.set('moneyState', moneyState);
    if (excludeSto) q.set('excludeSto', 'true');
    if (includeDeleted) q.set('includeDeleted', 'true');
    if (onlyOpen) q.set('onlyOpen', 'true');
    if (sort) {
      q.set('sort', sort.key);
      q.set('dir', sort.dir);
    }
    return q.toString();
  }, [globalParams, filters, debounced, ageBand, moneyState, excludeSto, includeDeleted, onlyOpen, sort]);

  const queryString = useMemo(
    () => `${filterQuery}${filterQuery ? '&' : ''}limit=${pageSize}&facets=true`,
    [filterQuery, pageSize],
  );

  // Any filter/sort/page-size change restarts at page 1.
  useEffect(() => {
    setPage(0);
  }, [globalParams, filters, debounced, ageBand, moneyState, excludeSto, includeDeleted, onlyOpen, sort, pageSize]);

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
        if (knownRef.current === null) knownRef.current = d.columns.map((c) => c.key);
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
    // `known` records which columns existed at save time, so a column added
    // later can be told apart from one this person removed.
    void api
      .put('/api/v1/me/preferences/detail_table_layout', {
        value: { columns: cols, known: data?.columns.map((c) => c.key) ?? knownRef.current ?? cols },
      })
      .catch(() => undefined);
  }, [data]);

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

  /**
   * Export what is on screen.
   *
   * `visible` IS the on-screen column order -- the same array the header row
   * and the drag-to-reorder handler read -- so passing it as `cols` is what
   * makes the file match the table rather than merely resemble it.
   *
   * Every row that matches the filter is exported, not the page being viewed.
   * Someone looking at rows 1-50 of 32,704 who clicks Export wants the 32,704;
   * exporting the visible page would be technically defensible and useless.
   */
  const exportExcel = async () => {
    if (exporting) return;
    const cols = visible ?? [];
    if (cols.length === 0) {
      setExportNote('Choose at least one column before exporting.');
      return;
    }
    setExporting(true);
    setExportNote(null);
    try {
      const q = new URLSearchParams(filterQuery);
      q.set('cols', cols.join(','));
      const r = await downloadFile(`/api/v1/detail/export.xlsx?${q.toString()}`, 'pct-detail.xlsx');
      const rows = r.rows ?? 0;
      setExportNote(
        r.total !== null && r.total > rows
          ? `Downloaded ${r.filename} — ${formatNumber(rows)} of ${formatNumber(r.total)} rows. `
            + 'The export stops at 50,000; narrow the filters to get the rest.'
          : `Downloaded ${r.filename} — ${formatNumber(rows)} rows, ${cols.length} columns.`,
      );
    } catch (e) {
      setExportNote(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
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
    setAgeBand('');
    setExcludeSto(false);
    setIncludeDeleted(false);
    setOnlyOpen(false);
  };

  const activeFilterCount =
    Object.values(filters).reduce((n, v) => n + (v?.length ?? 0), 0) +
    (debounced.trim() ? 1 : 0) +
    (ageBand ? 1 : 0) +
    (moneyState ? 1 : 0) +
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
          <button
            className="dt-btn"
            onClick={() => void exportExcel()}
            disabled={exporting || shown.length === 0}
            title={
              data
                ? `Export all ${formatNumber(data.totalCount)} matching rows with the `
                  + `${shown.length} column${shown.length === 1 ? '' : 's'} shown`
                : 'Export these rows to Excel'
            }
          >
            {exporting ? 'Preparing\u2026' : '\u2B07 Export to Excel'}
          </button>
        </div>

        {Object.keys(globalParams).length > 0 && (
          <p className="note dt-agechip">
            Following the filter bar:{' '}
            {GLOBAL_KEYS.filter((k) => globalParams[k] && !(filters[k as MultiKey]?.length))
              .map((k) => `${GLOBAL_LABELS[k]} ${globalParams[k]!.split(',').join(', ')}`)
              .join(' · ') || 'overridden by the table\u2019s own filters'}
          </p>
        )}

        {ageBand && (
          <p className="note dt-agechip">
            Age filter: <strong>{ageBand === 'past-sla' ? 'over 15 days' : `${ageBand} days`}</strong>{' '}
            <button className="dt-btn" onClick={() => setAgeBand('')}>clear</button>
          </p>
        )}

        {moneyState && (
          <p className="note dt-agechip">
            State: <strong>
              {moneyState === 'deliveredNotInvoiced'
                ? 'delivered, not invoiced'
                : 'invoiced in Coupa, not paid'}
            </strong>{' '}
            <button className="dt-btn" onClick={() => setMoneyState('')}>clear</button>
          </p>
        )}

        {exportNote && (
          <p className={exportNote.startsWith('Export failed') ? 'err' : 'note'} style={{ marginTop: '.5rem' }}>
            {exportNote}
          </p>
        )}

        {chooserOpen && data && (
          <div className="dt-chooser">
            {/* SAP columns first, then Coupa's as their own group: they come
                from a different system, live rather than from the published
                version, and the reader should be able to see which is which. */}
            {[false, true].map((coupa) => (
              <div key={String(coupa)} className={coupa ? 'dt-chooser-group dt-chooser-coupa' : 'dt-chooser-group'}>
                {coupa && <span className="dt-chooser-title">From Coupa (live)</span>}
                {data.columns.filter((c) => Boolean(c.coupa) === coupa).map((c) => (
                  <label key={c.key} className={coupa ? 'dt-chip dt-chip-coupa' : 'dt-chip'}>
                    <input
                      type="checkbox"
                      checked={visible?.includes(c.key) ?? false}
                      onChange={() => toggleColumn(c.key)}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
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
          <ScrollFrame className="table-wrap dt-scroll">
            <table className="data dd-tbl">
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
                  <tr key={i} className={rowClass(String(r['status'] ?? ''), i)}>
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
                    {shown.map((c) => {
                      const v = r[c.key];
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
                      // v1's aging colouring — per-column warn thresholds (AW).
                      const warn = AGE_WARN[c.key];
                      if (warn !== undefined && v !== null && v !== undefined && v !== '') {
                        return (
                          <td key={c.key} className={'num ' + agingClass(Number(v), warn)}>
                            {formatNumber(Number(v))}
                          </td>
                        );
                      }
                      // v1's GR/PR % colour: >=100 teal, >=50 amber, below red.
                      if (c.key === 'grPrPct' && v !== null && v !== undefined && v !== '') {
                        const n = Number(v);
                        const cl = n >= 100 ? 'ag ok' : n >= 50 ? 'ag wn' : 'ag bd';
                        return (
                          <td key={c.key} className={'num ' + cl}>
                            {formatNumber(n, 1)}%
                          </td>
                        );
                      }
                      // v1's next-approver cells: Approved gets the teal check.
                      if ((c.key === 'prNextApprover' || c.key === 'poNextApprover') && v) {
                        const t = String(v);
                        return (
                          <td key={c.key}>
                            {t === 'Approved' ? (
                              <span className="dt-appr-ok">{'\u2713'} Approved</span>
                            ) : (
                              <span className="dt-appr-next" title="Next approver in the release workflow">{t}</span>
                            )}
                          </td>
                        );
                      }
                      // v1's value cells: compact M + small blue ccy tag; USD plain.
                      if (c.type === 'money' && v !== null && v !== undefined && v !== '') {
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
                        <td key={c.key} className={NUMERIC.has(c.type) ? 'num' : ''}>
                          {formatCell(v, c.type, c.currency)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollFrame>
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
