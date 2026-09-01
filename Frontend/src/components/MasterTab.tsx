import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatNumber } from '../lib/format';

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
  useEffect(() => { setTerm(''); setApplied(''); }, [active]);

  useEffect(() => {
    const t = setTimeout(() => setApplied(term), 250);
    return () => clearTimeout(t);
  }, [term]);

  const load = useCallback(() => {
    if (active === null) return;
    let dead = false;
    setBusy(true);
    const qs = applied.trim() === '' ? '' : `?q=${encodeURIComponent(applied.trim())}`;
    api.get<MasterPage>(`/api/v1/master/${active}${qs}`)
      .then((d) => { if (!dead) { setPage(d); setErr(null); } })
      .catch((e: Error) => { if (!dead) setErr(e.message); })
      .finally(() => { if (!dead) setBusy(false); });
    return () => { dead = true; };
  }, [active, applied]);

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
                  <tr>{t.columns.map((c) => (
                    <th key={c.key} style={c.numeric ? { textAlign: 'right' } : undefined}>{c.label}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {t.rows.map((row, i) => (
                    // Index key: these rows have no single stable identifier
                    // across nine different masters, and the list is replaced
                    // wholesale on every search rather than reordered.
                    <tr key={i} className={i % 2 ? 're' : undefined}>
                      {t.columns.map((c) => (
                        <td
                          key={c.key}
                          style={c.numeric
                            ? { textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
                            : undefined}
                        >
                          {fmt(row[c.key], c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
