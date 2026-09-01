import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { DASH, formatNumber } from '../lib/format';
import { CoupaPanel } from './CoupaTab';
import { UserAccessTab } from './UserAccessTab';
import { SapUploadTab } from './SapUploadTab';
import { NotifyTab } from './NotifyTab';

/**
 * W6 — steward tooling. v1's cfg-modal (exclusions), cv-modal (column mapping)
 * and fx-modal (rate table), as an Admin tab.
 *
 * Exclusions do NOT apply instantly: excluded rows are removed at transform
 * time so every view agrees by construction. The UI says so and offers the
 * recompute button rather than pretending.
 */

/**
 * `excluded`/`inData` exist because an excluded value has NO rows in the facts —
 * it is listed from the saved configuration, and its count comes from staging:
 * what would come back if it were re-included.
 */
interface Opt {
  value: string;
  count: number;
  poLines?: number;
  prItems?: number;
  excluded?: boolean;
  inData?: boolean;
}
interface Exclusions {
  docTypes: string[];
  purchGroups: string[];
  purchOrgs: string[];
  /** Coupa-only (019). Enforced by views, so it needs no recompute. */
  coupaPurchGroups: string[];
  /** Drop lines whose derived status is HOLD PO. Needs a recompute. */
  holdPos: boolean;
  /** Vendor CODE prefixes treated as intercompany. Needs a recompute. */
  intercoVendorPrefixes: string[];
}

interface CoupaOpt {
  value: string;
  description: string | null;
  poLines: number;
  sourcingEvents: number;
  receipts: number;
  count: number;
  excluded: boolean;
}

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
  { id: 'notify', label: 'Notifications', icon: '📧', adminOnly: false },
] as const;
type AdminSection = (typeof ADMIN_SECTIONS)[number]['id'];

/**
 * The section now comes from the URL (`/admin/exclusions`) rather than from
 * local state, so an admin sub-page can be linked to and survives a reload —
 * "open Admin → Data Exclusions" is a link you can send someone.
 *
 * `section` is whatever was in the path, so it is validated here rather than
 * trusted: an unknown or no-longer-permitted value falls back to the first
 * section the user can actually see.
 */
export function AdminTab({ isAdmin, canIngest, section, onSection }: {
  isAdmin: boolean;
  canIngest: boolean;
  section: string | null;
  onSection: (id: AdminSection) => void;
}) {
  const available = ADMIN_SECTIONS.filter((x) => isAdmin || !x.adminOnly);
  const active: AdminSection = available.some((x) => x.id === section)
    ? (section as AdminSection)
    : available[0]!.id;

  // Canonicalise the URL so /admin (or a stale section) becomes the real path.
  useEffect(() => {
    if (section !== active) onSection(active);
  }, [section, active, onSection]);

  return (
    <>
      <div className="admin-subnav" role="tablist" aria-label="Admin sections">
        {available.map((x) => (
          <a
            key={x.id}
            href={`/admin/${x.id}`}
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
            <span aria-hidden="true">{x.icon}</span> {x.label}
          </a>
        ))}
      </div>

      {active === 'users' && <UserAccessTab section="users" />}
      {active === 'permissions' && <UserAccessTab section="matrix" />}
      {active === 'sapupload' && <SapUploadTab canUpload={canIngest} isAdmin={isAdmin} />}
      {active === 'coupa' && <CoupaPanel isAdmin={isAdmin} />}
      {active === 'exclusions' && <ExclusionsPanel isAdmin={isAdmin} />}
      {active === 'mapping' && <MappingsPanel />}
      {active === 'fx' && <FxPanel />}
      {active === 'notify' && <NotifyTab isAdmin={isAdmin} />}
    </>
  );
}

// ────────────────────────────────────────────────────────────── exclusions

/**
 * "12 PO lines · 4,300 PR items" rather than one combined figure: they are
 * separate populations, and the requisition count is often the larger of the
 * two — which is the whole reason the PR feed had to be read here.
 */
function rowSplit(o: Opt): string {
  const parts: string[] = [];
  if ((o.poLines ?? 0) > 0) parts.push(`${formatNumber(o.poLines!)} PO lines`);
  if ((o.prItems ?? 0) > 0) parts.push(`${formatNumber(o.prItems!)} PR items`);
  return parts.length > 0 ? parts.join(' · ') : `${formatNumber(o.count)} rows`;
}

function ExclusionsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [current, setCurrent] = useState<Exclusions | null>(null);
  const [options, setOptions] = useState<{ docTypes: Opt[]; purchGroups: Opt[]; purchOrgs: Opt[] } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [coupaOptions, setCoupaOptions] = useState<CoupaOpt[]>([]);

  useEffect(() => {
    api.get<{ current: Exclusions; options: typeof options; coupaOptions: CoupaOpt[] }>(
      '/api/v1/admin/exclusions',
    )
      .then((d) => {
        setCurrent(d.current);
        setOptions(d.options as never);
        setCoupaOptions(d.coupaOptions ?? []);
      })
      .catch((e: Error) => setMsg(e instanceof ApiError && e.status === 403 ? 'Steward role required.' : e.message));
  }, []);

  if (msg && !current) return <div className="panel"><h2>Data exclusions</h2><p className="note">{msg}</p></div>;
  if (!current || !options) return <div className="panel"><h2>Data exclusions</h2><div className="spinner" /></div>;

  /**
   * The list-valued exclusion keys.
   *
   * Named rather than `keyof Exclusions` because holdPos is a boolean: the
   * generic facet helpers below index the value as an array, and TypeScript
   * caught the mismatch the moment the flag was added.
   */
  type ListKey = 'docTypes' | 'purchGroups' | 'purchOrgs' | 'coupaPurchGroups'
    | 'intercoVendorPrefixes';

  const toggle = (key: ListKey, v: string) => {
    setCurrent((c) => {
      if (!c) return c;
      const list = c[key];
      const next = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
      return { ...c, [key]: next };
    });
    setDirty(true);
  };

  /**
   * Save AND recompute, in one action.
   *
   * These were two buttons, which made the destructive half optional: saving
   * alone changed the stored configuration while every page kept serving the
   * previous scope, so the panel and the dashboard disagreed until someone
   * remembered the second button. An exclusion is only real once the facts are
   * rebuilt, so the two steps are now one.
   */
  const saveAndRecompute = async () => {
    setBusy('saving');
    setMsg(null);
    try {
      const out = await api.put<{ recomputeRequired?: boolean }>(
        '/api/v1/admin/exclusions', current,
      );
      setDirty(false);
      // A Coupa-only change is live already: the views read the rule store
      // directly. Rebuilding every fact for it would cost a minute and change
      // nothing, so the server tells us whether it is actually needed.
      if (out.recomputeRequired === false) {
        setMsg('Saved. Coupa exclusions are live immediately — no rebuild was needed.');
        setBusy(null);
        return;
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'save failed');
      setBusy(null);
      return;
    }

    setBusy('recompute');
    setMsg('Saved. Rebuilding every fact from the source files — this takes a minute…');
    try {
      // force: exclusion changes alter the transform's behaviour while the
      // source files stay byte-identical, so the bundle-hash no-op must be
      // bypassed.
      const out = await api.post<{ outcome: string; datasetVersionId?: number }>(
        '/api/v1/ingest/sync', { force: true },
      );
      setMsg(
        out.outcome === 'published'
          ? `Applied — dataset version ${out.datasetVersionId} published. Every page now uses the new scope; reload to see it.`
          : out.outcome === 'source_unavailable'
            ? 'Saved, but the source files could not be read, so nothing was rebuilt — the previous scope is still in force.'
          : out.outcome === 'awaiting_exports'
            // A recompute reads the pickup folder, and after-run filing empties
            // it once a run has published. So between exports there is nothing
            // to rebuild FROM, and saying "reported awaiting_exports" would
            // leave an admin hunting for a fault that is not there.
            ? 'Saved, but the pickup folder is empty — a previous run filed its exports away, '
              + 'so there is nothing to rebuild from. The new scope takes effect at the next '
              + 'publish, or sooner if you put the exports back in the pickup folder.'
            : `Saved, but the rebuild reported "${out.outcome}" — the previous scope is still in force.`,
      );
    } catch (e) {
      setMsg(
        `Saved, but the rebuild failed (${e instanceof Error ? e.message : 'unknown error'}). `
        + 'The previous scope is still in force; retry to apply.',
      );
    } finally {
      setBusy(null);
    }
  };

  const group = (label: string, key: ListKey, opts: Opt[]) => (
    <details className="dt-facet" open={current[key].length > 0}>
      <summary>
        {label}
        {current[key].length > 0 && <span className="dt-badge">{current[key].length}</span>}
      </summary>
      <div className="dt-facet-list">
        {/* Excluded values first: they are the ones an admin comes here to undo,
            and they are absent from the data so they would otherwise be lost
            among values that are still present. */}
        {[...opts].sort((a, b) => Number(b.excluded ?? false) - Number(a.excluded ?? false))
          .map((o) => (
            <label key={o.value} className={`dt-chip${o.inData === false ? ' dt-chip-off' : ''}`}>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={current[key].includes(o.value)}
                onChange={() => toggle(key, o.value)}
              />
              {o.value}{' '}
              {o.inData === false ? (
                <span className="muted">
                  (excluded{o.count > 0 ? ` — ${rowSplit(o)} return if unticked` : ''})
                </span>
              ) : (
                <span className="muted">({rowSplit(o)})</span>
              )}
            </label>
          ))}
      </div>
    </details>
  );

  /**
   * The Coupa purchasing-group facet.
   *
   * Its own renderer rather than a parameter on group() above, because the
   * counts mean different things: order lines and quote requests, not PO lines
   * and PR items. It also shows the desk's NAME from the purchasing-group
   * master, since these codes are people and "L3A" alone is not reviewable.
   */
  const coupaGroup = () => (
    <details className="dt-facet" open={current.coupaPurchGroups.length > 0}>
      <summary>
        Coupa purchasing groups
        {current.coupaPurchGroups.length > 0 && (
          <span className="dt-badge">{current.coupaPurchGroups.length}</span>
        )}
      </summary>
      <div className="dt-facet-list">
        {[...coupaOptions].sort((a, b) => Number(b.excluded) - Number(a.excluded) || b.count - a.count)
          .map((o) => (
            <label key={o.value} className={`dt-chip${o.excluded ? ' dt-chip-off' : ''}`}>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={current.coupaPurchGroups.includes(o.value)}
                onChange={() => toggle('coupaPurchGroups', o.value)}
              />
              {o.value}
              {o.description ? <>{' '}<strong>{o.description}</strong></> : null}{' '}
              <span className="muted">
                ({formatNumber(o.poLines)} PO lines · {formatNumber(o.sourcingEvents)} quote requests
                {o.receipts > 0 ? ` · ${formatNumber(o.receipts)} receipts` : ''})
              </span>
            </label>
          ))}
      </div>
    </details>
  );

  /**
   * Held POs and intercompany vendors.
   *
   * Not a facet list like the three above: HOLD PO is one value of a derived
   * status rather than a code an administrator can pick from the data, and the
   * intercompany rule is a vendor-code PREFIX, which is free text — there is no
   * finite option list to tick.
   */
  const holdAndInterco = () => (
    <details className="dt-facet" open={current.holdPos || current.intercoVendorPrefixes.length > 0}>
      <summary>
        Held POs and intercompany
        {(current.holdPos || current.intercoVendorPrefixes.length > 0) && (
          <span className="dt-badge">
            {(current.holdPos ? 1 : 0) + current.intercoVendorPrefixes.length}
          </span>
        )}
      </summary>
      <div className="dt-facet-list" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '.5rem' }}>
        <label className="dt-chip" style={{ alignSelf: 'flex-start' }}>
          <input
            type="checkbox"
            disabled={!isAdmin}
            checked={current.holdPos}
            onChange={() => {
              setCurrent({ ...current, holdPos: !current.holdPos });
              setDirty(true);
            }}
          />
          Exclude PO lines on <strong>HOLD</strong>{' '}
          <span className="muted">(derived status “HOLD PO”)</span>
        </label>
        <label className="cu-field" style={{ maxWidth: '32rem' }}>
          Intercompany vendor code prefixes
          <input
            className="gf-search-in"
            disabled={!isAdmin}
            placeholder="e.g. LN21, LN29 — comma separated"
            value={current.intercoVendorPrefixes.join(', ')}
            onChange={(e) => {
              setCurrent({
                ...current,
                intercoVendorPrefixes: e.target.value.split(',')
                  .map((x) => x.trim().toUpperCase()).filter((x) => x !== ''),
              });
              setDirty(true);
            }}
          />
        </label>
        <p className="note" style={{ margin: 0 }}>
          A <strong>code prefix</strong>, not a name match. Matching the name on “INTERCO” also
          hits <code>INTERCON TERMINAL INDONESIA</code>, a genuine third-party supplier, so a
          name rule would silently drop a real vendor&apos;s orders. Leave this empty and nothing
          is excluded.
        </p>
      </div>
    </details>
  );

  return (
    <div className="panel">
      <h2>🎛 Data exclusions</h2>
      <p className="note" style={{ marginBottom: '.6rem' }}>
        Excluded document types, purchasing groups and orgs are removed from <strong>every</strong>
        stage — requisitions, approval steps (AR), sourcing, orders,
        goods receipts, and Coupa invoices and payments. Saving rebuilds the facts, so KPIs,
        charts, drills and the detail table all agree by construction rather than by filtering.
        Staging keeps the rows for lineage, so an exclusion is always reversible: an
        already-excluded value stays listed here in red with how many rows would come back, and
        unticking it restores them on the next save.
        {!isAdmin && ' Editing requires the admin role.'}
      </p>
      <div className="dt-facets">
        {group('Document types', 'docTypes', options.docTypes)}
        {group('Purchasing groups', 'purchGroups', options.purchGroups)}
        {group('Purchasing orgs', 'purchOrgs', options.purchOrgs)}
        {holdAndInterco()}
        {coupaGroup()}
      </div>
      <p className="note" style={{ marginTop: '.5rem' }}>
        <span className="bs sl">Coupa only</span> The last group above applies to the{' '}
        <strong>Coupa store alone</strong> — its purchase orders, quote requests, receipts and the
        invoices drawn from them. It is separate from the SAP lists because the desks in Coupa are
        largely not the ones in the SAP facts, and because it is enforced by database views rather
        than by the transform: <strong>it takes effect the moment you save, with no rebuild</strong>.
        A partially relevant invoice is kept, not dropped — an invoice disappears only when every
        one of its linked lines is excluded.
      </p>
      {isAdmin && (
        <div className="dt-toolbar" style={{ marginTop: '.6rem' }}>
          <button
            className="btn"
            style={{ width: 'auto' }}
            disabled={!dirty || busy !== null}
            onClick={() => void saveAndRecompute()}
            title="Saves the selection and rebuilds every fact so the change takes effect"
          >
            {busy === 'saving' ? 'Saving…'
              : busy === 'recompute' ? 'Rebuilding…'
                : 'Save exclusions & recompute'}
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
