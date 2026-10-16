import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatNumber } from '../lib/format';
import {
  MasterEditDialog, rowKey, sameKey, type EditBlock, type RowMark,
} from './MasterEdit';

/**
 * Master data — one sub-page per reference table (31 Aug 2026).
 *
 * The sub-page lives in the URL, exactly as Admin's does, so a master is
 * bookmarkable and shareable: "the purchasing group list" is
 * /master/purchasing-groups rather than a click path someone has to describe.
 *
 * The registry is the SERVER's, not a copy here. A page defined in one place
 * and enumerated in another drifts the moment a master is added, and the
 * failure is silent — a tab that 404s, or a master with no tab. So the sub-nav
 * is rendered from what the API reports it can serve.
 */

interface MasterColumn { key: string; label: string; numeric?: boolean; decimals?: number }

interface MasterTable {
  name: string;
  relation: string;
  note: string;
  columns: MasterColumn[];
  rows: Record<string, unknown>[];
  total: number;
  totalUnfiltered: number;
  truncated: boolean;
  versionScoped: boolean;
  sortKey: string | null;
  sortDir: 'asc' | 'desc';
  /** Present only for an Admin - the server does not describe edits to anyone else. */
  edit?: EditBlock;
  marks?: RowMark[];
  /** FX: manual rates waiting for the next recompute. */
  pendingFx?: number;
}

interface MasterPage {
  id: string;
  label: string;
  blurb: string;
  datasetVersionId: number;
  tables: MasterTable[];
}

interface IndexEntry { id: string; label: string; icon: string; rows: number }

export function MasterTab({ section, onSection }: {
  section: string | null;
  onSection: (id: string) => void;
}) {
  const [index, setIndex] = useState<IndexEntry[] | null>(null);
  const [page, setPage] = useState<MasterPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** The search box, and the value actually sent — debounced so typing does
   *  not fire a query per keystroke against a 20,000-row master. */
  const [term, setTerm] = useState('');
  const [applied, setApplied] = useState('');
  /**
   * Sort, as one piece of state for the whole page.
   *
   * A page can show three tables (Org Structure does) whose column keys do not
   * overlap, and the server ignores a key a table does not have — so one sort
   * applies to whichever table owns that column and the others keep their
   * natural order. That is what a reader clicking a header in one table
   * expects: the other tables should not reshuffle.
   */
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  /** The row being edited: null row means ADD; the whole value null means closed. */
  const [editing, setEditing] = useState<{ table: MasterTable; row: Record<string, unknown> | null } | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  /** Bumped after any write, so the page reloads with the change applied. */
  const [nonce, setNonce] = useState(0);

  /**
   * Hide or revert, confirmed. Both are reversible, and the confirmation says
   * so - an administrator hesitating over "delete" should know it can be undone.
   */
  const act = async (
    t: MasterTable, verb: 'hide' | 'revert', values: Record<string, unknown>, what: string,
  ): Promise<void> => {
    const msg = verb === 'hide'
      ? `Hide ${what}? It disappears from every page, and the SAP sync will not bring it back. You can restore it from this page.`
      : `Revert ${what}? The row goes back to exactly what SAP had.`;
    if (!window.confirm(msg)) return;
    setActionErr(null);
    try {
      await api.post(`/api/v1/admin/master/rows/${verb}`, { relation: t.relation, values });
      setNonce((n) => n + 1);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    api.get<{ pages: IndexEntry[] }>('/api/v1/master')
      .then((d) => setIndex(d.pages))
      .catch((e: Error) => setErr(e.message));
  }, []);

  const active = index && index.some((x) => x.id === section)
    ? section!
    : index?.[0]?.id ?? null;

  // Canonicalise /master to the first master, matching Admin's behaviour.
  useEffect(() => {
    if (active !== null && section !== active) onSection(active);
  }, [section, active, onSection]);

  // A new master starts with a clear search: carrying a vendor code into the
  // document-type list shows an empty table and looks like missing data.
  useEffect(() => { setTerm(''); setApplied(''); setSort(null); }, [active]);

  useEffect(() => {
    const t = setTimeout(() => setApplied(term), 250);
    return () => clearTimeout(t);
  }, [term]);

  const load = useCallback(() => {
    if (active === null) return;
    let dead = false;
    setBusy(true);
    const p = new URLSearchParams();
    if (applied.trim() !== '') p.set('q', applied.trim());
    if (sort) { p.set('sort', sort.key); p.set('dir', sort.dir); }
    const qs = p.toString() === '' ? '' : `?${p.toString()}`;
    api.get<MasterPage>(`/api/v1/master/${active}${qs}`)
      .then((d) => { if (!dead) { setPage(d); setErr(null); } })
      .catch((e: Error) => { if (!dead) setErr(e.message); })
      .finally(() => { if (!dead) setBusy(false); });
    return () => { dead = true; };
  }, [active, applied, sort, nonce]);

  useEffect(() => load(), [load]);

  if (err && !index) return <div className="panel"><h2>Master</h2><p className="note">{err}</p></div>;
  if (!index) return <div className="panel"><h2>Master</h2><div className="spinner" /></div>;

  const fmt = (v: unknown, col: MasterColumn): string => {
    if (v === null || v === undefined || v === '') return '—';
    // A rate arrives as a string from pg's numeric type, so coerce rather than
    // testing typeof — otherwise every FX rate falls through to String() and
    // prints its full 12-digit form.
    if (col.numeric) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) {
        return col.decimals === undefined
          ? formatNumber(n)
          : n.toLocaleString('en-GB', {
            minimumFractionDigits: col.decimals, maximumFractionDigits: col.decimals,
          });
      }
    }
    return String(v);
  };

  return (
    <>
      <div className="admin-subnav" role="tablist" aria-label="Master data">
        {index.map((x) => (
          <a
            key={x.id}
            href={`/master/${x.id}`}
            className="asn-btn"
            role="tab"
            aria-selected={active === x.id}
            aria-current={active === x.id ? 'page' : undefined}
            onClick={(e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              onSection(x.id);
            }}
          >
            <span aria-hidden="true">{x.icon}</span> {x.label}{' '}
            <span className="muted">{formatNumber(x.rows)}</span>
          </a>
        ))}
      </div>

      <div className="panel">
        <h2>📚 {page?.label ?? 'Master'}</h2>
        {page && <p className="note">{page.blurb}</p>}
        {err && <p className="note"><span className="bs spdel">error</span> {err}</p>}

        <div className="dt-toolbar" style={{ marginTop: '.6rem', alignItems: 'center' }}>
          <input
            className="gf-search-in"
            style={{ width: '18rem' }}
            placeholder="Search this master…"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            aria-label="Search master data"
          />
          {term !== '' && (
            <button className="dt-btn" onClick={() => setTerm('')}>Clear</button>
          )}
          {busy && <span className="muted">searching…</span>}
        </div>
      </div>

      {page?.tables.map((t) => (
        <div className="panel" key={t.name}>
          <h3 className="pr-tbl-h">
            {t.name}{' '}
            <span className="muted">
              — {formatNumber(t.total)}
              {t.total !== t.totalUnfiltered ? ` of ${formatNumber(t.totalUnfiltered)}` : ''} row(s)
            </span>
          </h3>
          {t.edit && (
            <div className="me-bar">
              {t.edit.allowAdd && (
                <button type="button" className="dt-btn dt-btn-primary"
                  onClick={() => setEditing({ table: t, row: null })}>
                  + Add
                </button>
              )}
              <span className="muted">
                Admin: edits are kept over later SAP values, and every edited or hidden row can be reverted.
              </span>
            </div>
          )}
          {t.edit?.fx && (t.pendingFx ?? 0) > 0 && (
            <p className="note">
              <span className="bs sa">{t.pendingFx} manual rate{t.pendingFx === 1 ? '' : 's'}</span>{' '}
              waiting for the next Recompute. The rates below are what this published dataset was
              valued at, and they do not change.
            </p>
          )}
          <p className="note">
            {t.note}{' '}
            <span className="muted">
              Source: <code>{t.relation}</code>
              {t.versionScoped
                ? <> — scoped to dataset version <strong>{page.datasetVersionId}</strong>.</>
                : ' — cumulative across versions.'}
            </span>
          </p>

          {t.truncated && (
            <p className="note">
              <span className="bs sa">showing the first {formatNumber(t.rows.length)}</span>{' '}
              Narrow the search to see the rest — the page does not page through a master.
            </p>
          )}

          {t.rows.length === 0 ? (
            <p className="muted" style={{ marginTop: '.5rem' }}>
              {t.totalUnfiltered === 0
                ? 'This master is empty — no export has populated it yet.'
                : 'Nothing matches that search.'}
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data dd-tbl">
                <thead>
                  <tr>{t.columns.map((c) => {
                    const on = t.sortKey === c.key;
                    return (
                      <th key={c.key} style={c.numeric ? { textAlign: 'right' } : undefined}
                          aria-sort={on ? (t.sortDir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                        <button
                          type="button"
                          className={`ms-sort${on ? ' ms-sort-on' : ''}`}
                          // Third click clears rather than cycling forever back to
                          // ascending: returning to the table's own order is a
                          // state the reader can otherwise never get back to.
                          onClick={() => setSort(
                            !on ? { key: c.key, dir: 'asc' }
                              : t.sortDir === 'asc' ? { key: c.key, dir: 'desc' }
                                : null,
                          )}
                          title={!on ? `Sort by ${c.label}`
                            : t.sortDir === 'asc' ? `Sort by ${c.label}, descending`
                              : 'Back to the default order'}
                        >
                          {c.label}
                          <span className="ms-arrow" aria-hidden="true">
                            {on ? (t.sortDir === 'desc' ? '▼' : '▲') : '↕'}
                          </span>
                        </button>
                      </th>
                    );
                  })}
                  {t.edit && <th className="me-act-h">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((row, i) => {
                    // Index key: these rows have no single stable identifier
                    // across nine different masters, and the list is replaced
                    // wholesale on every search rather than reordered.
                    const key = t.edit ? rowKey(t.edit, row) : {};
                    const mark = t.marks?.find((m) => m.state !== 'hidden' && sameKey(m.key, key));
                    return (
                      <tr key={i} className={`${i % 2 ? 're' : ''}${mark ? ' me-row-marked' : ''}`}>
                        {t.columns.map((c, ci) => (
                          <td
                            key={c.key}
                            style={c.numeric
                              ? { textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
                              : undefined}
                          >
                            {fmt(row[c.key], c)}
                            {ci === 0 && mark && (
                              <span className={`me-badge me-badge--${mark.state}`}
                                title={`${mark.state === 'added' ? 'Added' : 'Edited'} by ${mark.by} on ${mark.at.slice(0, 16)}`}>
                                {mark.state}
                              </span>
                            )}
                          </td>
                        ))}
                        {t.edit && (
                          <td className="me-act">
                            <button type="button" className="dt-btn" onClick={() => setEditing({ table: t, row })}>Edit</button>
                            {mark?.state === 'edited' && (
                              <button type="button" className="dt-btn"
                                onClick={() => { void act(t, 'revert', key, 'this row'); }}>
                                Revert
                              </button>
                            )}
                            {t.edit.allowDelete && (
                              <button type="button" className="dt-btn dt-btn-danger"
                                onClick={() => { void act(t, 'hide', key, 'this row'); }}>
                                {mark?.state === 'added' ? 'Delete' : 'Hide'}
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Hidden rows, listed so they can be restored. A tombstone the
              reader cannot see is a row that is simply gone, and "reversible"
              would be a promise the page could not keep. */}
          {(t.marks ?? []).some((m) => m.state === 'hidden') && (
            <div className="me-hidden">
              <p className="me-ro-h">Hidden rows</p>
              <ul>
                {t.marks!.filter((m) => m.state === 'hidden').map((m) => (
                  <li key={JSON.stringify(m.key)}>
                    <code>{Object.values(m.key).join(' / ')}</code>{' '}
                    <span className="muted">hidden by {m.by}, {m.at.slice(0, 16)}</span>{' '}
                    <button type="button" className="dt-btn"
                      onClick={() => { void act(t, 'revert', m.key, Object.values(m.key).join(' / ')); }}>
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}

      {actionErr && (
        <div className="panel"><p className="note"><span className="bs spdel">error</span> {actionErr}</p></div>
      )}

      {editing && editing.table.edit && (
        <MasterEditDialog
          relation={editing.table.relation}
          tableName={editing.table.name}
          edit={editing.table.edit}
          row={editing.row}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setNonce((n) => n + 1); }}
        />
      )}
    </>
  );
}
