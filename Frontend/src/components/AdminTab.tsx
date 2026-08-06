import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { DASH, formatNumber } from '../lib/format';
import { CoupaPanel } from './CoupaTab';
import { UserAccessTab } from './UserAccessTab';
import { SapUploadTab } from './SapUploadTab';

/**
 * W6 — steward tooling. v1's cfg-modal (exclusions), cv-modal (column mapping)
 * and fx-modal (rate table), as an Admin tab.
 *
 * Exclusions do NOT apply instantly: excluded rows are removed at transform
 * time so every view agrees by construction. The UI says so and offers the
 * recompute button rather than pretending.
 */

interface Opt { value: string; count: number }
interface Exclusions { docTypes: string[]; purchGroups: string[]; purchOrgs: string[] }

const FEEDS = ['pr', 'prel', 'po', 'por', 'gr', 'fx'] as const;

/**
 * Admin sub-pages. The tab grew to six independent panels, which is too much
 * on one scroll, so each is its own section behind a sub-nav. The choice is
 * remembered per browser like the other UI preferences.
 */
const ADMIN_SECTIONS = [
  { id: 'users', label: 'Users', icon: '👥', adminOnly: true },
  { id: 'permissions', label: 'Page Permission', icon: '🔐', adminOnly: true },
  { id: 'sapupload', label: 'SAP Data Upload', icon: '⬆️', adminOnly: false },
  { id: 'coupa', label: 'Coupa Sync', icon: '🔄', adminOnly: false },
  { id: 'exclusions', label: 'Data Exclusions', icon: '🗂️', adminOnly: false },
  { id: 'mapping', label: 'Column Mapping', icon: '🔧', adminOnly: false },
  { id: 'fx', label: 'FX Rates', icon: '💱', adminOnly: false },
] as const;
type AdminSection = (typeof ADMIN_SECTIONS)[number]['id'];

export function AdminTab({ isAdmin, canIngest }: { isAdmin: boolean; canIngest: boolean }) {
  const available = ADMIN_SECTIONS.filter((x) => isAdmin || !x.adminOnly);
  const [section, setSection] = useState<AdminSection>(() => {
    const saved = localStorage.getItem('pct_admin_section') as AdminSection | null;
    return saved && available.some((x) => x.id === saved) ? saved : available[0]!.id;
  });
  // A demoted user must not be stranded on a section they can no longer see.
  const active = available.some((x) => x.id === section) ? section : available[0]!.id;
  const choose = (id: AdminSection) => {
    setSection(id);
    localStorage.setItem('pct_admin_section', id);
  };

  return (
    <>
      <div className="admin-subnav" role="tablist" aria-label="Admin sections">
        {available.map((x) => (
          <button
            key={x.id}
            className="asn-btn"
            role="tab"
            aria-selected={active === x.id}
            onClick={() => choose(x.id)}
          >
            <span aria-hidden="true">{x.icon}</span> {x.label}
          </button>
        ))}
      </div>

      {active === 'users' && <UserAccessTab section="users" />}
      {active === 'permissions' && <UserAccessTab section="matrix" />}
      {active === 'sapupload' && <SapUploadTab canUpload={canIngest} />}
      {active === 'coupa' && <CoupaPanel isAdmin={isAdmin} />}
      {active === 'exclusions' && <ExclusionsPanel isAdmin={isAdmin} />}
      {active === 'mapping' && <MappingsPanel />}
      {active === 'fx' && <FxPanel />}
    </>
  );
}

// ────────────────────────────────────────────────────────────── exclusions

function ExclusionsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [current, setCurrent] = useState<Exclusions | null>(null);
  const [options, setOptions] = useState<{ docTypes: Opt[]; purchGroups: Opt[]; purchOrgs: Opt[] } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ current: Exclusions; options: typeof options }>('/api/v1/admin/exclusions')
      .then((d) => {
        setCurrent(d.current);
        setOptions(d.options as never);
      })
      .catch((e: Error) => setMsg(e instanceof ApiError && e.status === 403 ? 'Steward role required.' : e.message));
  }, []);

  if (msg && !current) return <div className="panel"><h2>Data exclusions</h2><p className="note">{msg}</p></div>;
  if (!current || !options) return <div className="panel"><h2>Data exclusions</h2><div className="spinner" /></div>;

  const toggle = (key: keyof Exclusions, v: string) => {
    setCurrent((c) => {
      if (!c) return c;
      const list = c[key];
      const next = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
      return { ...c, [key]: next };
    });
    setDirty(true);
  };

  const save = async () => {
    setBusy('saving');
    setMsg(null);
    try {
      await api.put('/api/v1/admin/exclusions', current);
      setDirty(false);
      setMsg('Saved. Run a recompute to apply — until then every view still shows the previous scope.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'save failed');
    } finally {
      setBusy(null);
    }
  };

  const recompute = async () => {
    setBusy('recompute');
    setMsg('Recomputing — re-reading the share folder and rebuilding all facts…');
    try {
      // force: exclusion changes alter the transform's behaviour while the
      // source files stay byte-identical, so the bundle-hash no-op must be
      // bypassed.
      const out = await api.post<{ outcome: string }>('/api/v1/ingest/sync', { force: true });
      setMsg(
        out.outcome === 'published'
          ? 'Recompute complete — reload the page to see the new dataset version.'
          : `Recompute outcome: ${out.outcome}`,
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'recompute failed');
    } finally {
      setBusy(null);
    }
  };

  const group = (label: string, key: keyof Exclusions, opts: Opt[]) => (
    <details className="dt-facet" open={current[key].length > 0}>
      <summary>
        {label}
        {current[key].length > 0 && <span className="dt-badge">{current[key].length}</span>}
      </summary>
      <div className="dt-facet-list">
        {opts.map((o) => (
          <label key={o.value} className="dt-chip">
            <input
              type="checkbox"
              disabled={!isAdmin}
              checked={current[key].includes(o.value)}
              onChange={() => toggle(key, o.value)}
            />
            {o.value} <span className="muted">({formatNumber(o.count)} lines)</span>
          </label>
        ))}
      </div>
    </details>
  );

  return (
    <div className="panel">
      <h2>🎛 Data exclusions</h2>
      <p className="note" style={{ marginBottom: '.6rem' }}>
        Excluded document types, purchasing groups and orgs are removed from <strong>every</strong> view
        at the next recompute — KPIs, charts, drills and the detail table all agree because the rows
        are never loaded into the facts. Staging keeps them for lineage.
        {!isAdmin && ' Editing requires the admin role.'}
      </p>
      <div className="dt-facets">
        {group('Document types', 'docTypes', options.docTypes)}
        {group('Purchasing groups', 'purchGroups', options.purchGroups)}
        {group('Purchasing orgs', 'purchOrgs', options.purchOrgs)}
      </div>
      {isAdmin && (
        <div className="dt-toolbar" style={{ marginTop: '.6rem' }}>
          <button className="btn" style={{ width: 'auto' }} disabled={!dirty || busy !== null} onClick={() => void save()}>
            {busy === 'saving' ? 'Saving…' : 'Save exclusions'}
          </button>
          <button className="dt-btn" disabled={busy !== null} onClick={() => void recompute()}>
            {busy === 'recompute' ? 'Recomputing…' : 'Recompute now (re-ingest)'}
          </button>
        </div>
      )}
      {msg && <p className="note" style={{ marginTop: '.5rem' }}>{msg}</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── column mapping

function MappingsPanel() {
  const [feed, setFeed] = useState<(typeof FEEDS)[number]>('pr');
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = (f: (typeof FEEDS)[number]) => {
    setD(null);
    api.get<Record<string, any>>(`/api/v1/admin/mappings/${f}`).then(setD).catch((e: Error) => setMsg(e.message));
  };
  useEffect(() => load(feed), [feed]);

  const save = async (field: string, sourceHeader: string) => {
    setMsg(null);
    try {
      await api.put(`/api/v1/admin/mappings/${feed}`, {
        field,
        sourceHeader: sourceHeader.trim() === '' ? null : sourceHeader.trim(),
      });
      setMsg(`Mapping for ${field} saved — applies from the next ingest.`);
      load(feed);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'save failed');
    }
  };

  return (
    <div className="panel">
      <h2>🔧 Column mapping</h2>
      <p className="note" style={{ marginBottom: '.6rem' }}>
        When SAP renames a column, map the canonical field to the new header here. Mappings are
        server-side and audited — every user sees the same numbers, unlike v1's per-browser storage.
      </p>
      <div className="dt-toolbar">
        {FEEDS.map((f) => (
          <button key={f} className="dt-btn" aria-pressed={feed === f} style={feed === f ? { borderColor: 'var(--accent)' } : {}} onClick={() => setFeed(f)}>
            {f.toUpperCase()}
          </button>
        ))}
        {d?.lastFile && (
          <span className="muted">last file: {d.lastFile.filename} · match: {d.lastFile.matchOutcome}</span>
        )}
      </div>
      {!d ? (
        <div className="spinner" />
      ) : (
        <div className="table-wrap" style={{ maxHeight: '340px', overflow: 'auto' }}>
          <table className="data">
            <thead>
              <tr><th>Canonical field</th><th>Contract header</th><th>Status</th><th>Mapped to</th><th /></tr>
            </thead>
            <tbody>
              {d.columns.map((c: any) => (
                <MappingRow key={c.field} col={c} onSave={save} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {msg && <p className="note" style={{ marginTop: '.5rem' }}>{msg}</p>}
    </div>
  );
}

function MappingRow({ col, onSave }: { col: Record<string, any>; onSave: (f: string, h: string) => void }) {
  const [val, setVal] = useState<string>(col.mappedTo ?? '');
  return (
    <tr>
      <td><code>{col.field}</code></td>
      <td>{col.header}</td>
      <td>{col.status}</td>
      <td>
        <input
          className="dt-search"
          style={{ minWidth: 160, flex: 'none', padding: '.2rem .4rem' }}
          value={val}
          placeholder="(use contract header)"
          onChange={(e) => setVal(e.target.value)}
        />
      </td>
      <td>
        {val !== (col.mappedTo ?? '') && (
          <button className="dt-btn" onClick={() => onSave(col.field, val)}>Save</button>
        )}
      </td>
    </tr>
  );
}

// ────────────────────────────────────────────────────────────── FX rates

function FxPanel() {
  const [d, setD] = useState<Record<string, any> | null>(null);
  useEffect(() => {
    api.get<Record<string, any>>('/api/v1/admin/fx').then(setD).catch(() => setD(null));
  }, []);

  if (!d) return <div className="panel"><h2>💱 FX rates</h2><div className="spinner" /></div>;
  return (
    <div className="panel">
      <h2>💱 FX rates <span className="muted">— policy {d.policy}, year resolved {d.yearResolved ?? DASH}</span></h2>
      <div className="table-wrap" style={{ maxHeight: '300px', overflow: 'auto' }}>
        <table className="data">
          <thead>
            <tr><th>Currency</th><th>Period</th><th style={{ textAlign: 'right' }}>USD per unit</th><th>Derivation</th><th>Pivot</th><th>Source</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {d.rates.map((r: any, i: number) => (
              <tr key={i}>
                <td>{r.currency}</td>
                <td>{r.year}-{String(r.month).padStart(2, '0')}</td>
                <td className="num">{Number(r.usdPerUnit).toLocaleString('en-GB', { maximumSignificantDigits: 8 })}</td>
                <td>{r.derivation}</td>
                <td>{r.pivotCurrency ?? DASH}</td>
                <td>
                  <span className={`bs ${r.source === 'coupa' ? 'su' : r.source === 'sap' ? 'sd' : r.source === 'mixed' ? 'sn' : 'sl'}`}>
                    {r.source ?? 'sap'}
                  </span>
                </td>
                <td>{r.sourceUpdatedAt ? String(r.sourceUpdatedAt).slice(0, 16) : DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        Rates are stored per dataset version — a re-published bundle with a corrected rate file never
        changes figures already published.
      </p>
      <p className="note">
        <strong>Two sources, one table:</strong> the SAP rate file and Coupa's exchange-rate API both
        feed the shared FX store; for the same currency and period, whichever record was updated most
        recently wins (SAP timed by its file's modified date, Coupa by its <code>updated-at</code>).
        New rates take effect at the next recompute.
      </p>
      <p className="note">
        <strong>Period basis:</strong> a PO with a booked Coupa invoice converts at its <strong>invoice
        date</strong>'s period (latest invoice; voided/draft excluded); a PO without one converts at its{' '}
        <strong>PO document date</strong>'s period. Each line's <code>fx_basis</code> records which date
        fed the rate. New invoices affect figures at the next recompute.
      </p>
    </div>
  );
}
