import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { EMPTY_LAYOUT, type TabLayout } from './LayoutEdit';

/**
 * Named layout views, per user and per tab.
 *
 * The layout editor already saved ONE arrangement per tab. That is enough to
 * customise a page and not enough to work: a reader who wants a board-ready
 * Executive Summary and a working one has to rebuild whichever they are not
 * looking at.
 *
 * ── The model, and why it is this one ────────────────────────────────────────
 *
 * `tab_layout_<tab>` remains THE LAYOUT THAT RENDERS. Nothing about the render
 * path changes: applying a view copies it into that preference, so every page
 * keeps reading one place and a view cannot half-apply.
 *
 * `tab_views_<tab>` holds the named snapshots plus which is active and which is
 * the default. Selecting a view writes it into the working layout; editing
 * afterwards leaves the view untouched until Save is pressed, so an experiment
 * never silently rewrites a saved arrangement.
 *
 * The DEFAULT is applied when the tab is opened and no view is active yet —
 * which is what "default" has to mean for it to be useful on a fresh session,
 * while still letting someone switch away for the rest of theirs.
 *
 * Both are user preferences, so views follow the person across devices and are
 * never shared: one reader's board view cannot alter another's working one.
 */

export interface SavedView {
  id: string;
  name: string;
  layout: TabLayout;
}

interface ViewStore {
  views: SavedView[];
  defaultId: string | null;
  activeId: string | null;
}

/**
 * An EXPLICIT choice of the page's own arrangement, as distinct from never having
 * chosen.
 *
 * Without the distinction, picking "Default layout" was overridden by the default
 * VIEW on the next load — the selection was a decision and the page ignored it.
 * null means "not chosen yet, apply the default view"; this means "the reader
 * asked for the plain layout, leave it alone".
 */
const NO_VIEW = '__default__';

const EMPTY_STORE: ViewStore = { views: [], defaultId: null, activeId: null };

function sanitizeStore(raw: unknown): ViewStore {
  const o = (raw ?? {}) as Record<string, unknown>;
  const views = Array.isArray(o['views'])
    ? (o['views'] as unknown[]).slice(0, 40).map((v) => {
      const r = (v ?? {}) as Record<string, unknown>;
      return {
        id: String(r['id'] ?? ''),
        name: String(r['name'] ?? '').slice(0, 60),
        // A view's layout goes through the same shape guard the live layout
        // does, so a hand-edited preference cannot introduce a field the
        // renderer does not expect.
        layout: { ...EMPTY_LAYOUT, ...((r['layout'] ?? {}) as Partial<TabLayout>) },
      };
    }).filter((v) => v.id !== '' && v.name !== '')
    : [];
  const ids = new Set(views.map((v) => v.id));
  const pick = (k: string): string | null => {
    const v = o[k] === null || o[k] === undefined ? null : String(o[k]);
    if (v === NO_VIEW) return NO_VIEW;
    // A pointer at a deleted view is dropped rather than left dangling.
    return v !== null && ids.has(v) ? v : null;
  };
  return { views, defaultId: pick('defaultId'), activeId: pick('activeId') };
}

/** A stable id without pulling in a uuid dependency for four characters of entropy. */
function newId(): string {
  return `v${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export function SavedViews({
  tab, layout, applyToWorking, editing,
}: {
  tab: string;
  /** The layout currently rendering — what Save snapshots. */
  layout: TabLayout;
  /** Replace the working layout, i.e. what the page renders. */
  applyToWorking: (next: TabLayout) => void;
  editing: boolean;
}) {
  const [store, setStore] = useState<ViewStore>(EMPTY_STORE);
  const [loaded, setLoaded] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const key = `tab_views_${tab}`;

  const persist = useCallback((next: ViewStore) => {
    setStore(next);
    void api.put(`/api/v1/me/preferences/${key}`, { value: next }).catch(() => undefined);
  }, [key]);

  useEffect(() => {
    let dead = false;
    setLoaded(false);
    setNaming(false);
    setMsg(null);
    api.get<{ value: unknown }>(`/api/v1/me/preferences/${key}`)
      .then((p) => { if (!dead) setStore(sanitizeStore(p?.value)); })
      .catch(() => { if (!dead) setStore(EMPTY_STORE); })
      .finally(() => { if (!dead) setLoaded(true); });
    return () => { dead = true; };
  }, [key]);

  /**
   * Apply the default on arrival.
   *
   * Guarded on `loaded` and on there being no active view, so it runs once per
   * tab visit and never fights a selection the reader just made.
   */
  useEffect(() => {
    if (!loaded) return;
    if (store.activeId !== null) return;
    if (store.defaultId === null) return;
    const def = store.views.find((v) => v.id === store.defaultId);
    if (!def) return;
    applyToWorking(def.layout);
    setStore((cur) => ({ ...cur, activeId: def.id }));
    // Deliberately not persisting activeId here: arriving on a page is not a
    // decision, and writing it would make the default look "chosen" forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  if (!loaded) return null;

  // NO_VIEW is not a view, so nothing to Save over, set as default or delete.
  const active = store.views.find((v) => v.id === store.activeId) ?? null;

  const select = (id: string) => {
    if (id === '') {
      // Back to the page's own default arrangement.
      applyToWorking(EMPTY_LAYOUT);
      persist({ ...store, activeId: NO_VIEW });
      setMsg('Showing the default layout.');
      return;
    }
    const v = store.views.find((x) => x.id === id);
    if (!v) return;
    applyToWorking(v.layout);
    persist({ ...store, activeId: id });
    setMsg(`Showing “${v.name}”.`);
  };

  const saveAs = () => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    const v: SavedView = { id: newId(), name: trimmed, layout };
    persist({ ...store, views: [...store.views, v], activeId: v.id });
    setNaming(false);
    setName('');
    setMsg(`Saved “${trimmed}”.`);
  };

  const saveOver = () => {
    if (!active) return;
    persist({
      ...store,
      views: store.views.map((v) => (v.id === active.id ? { ...v, layout } : v)),
    });
    setMsg(`Updated “${active.name}”.`);
  };

  const makeDefault = () => {
    if (!active) return;
    persist({ ...store, defaultId: active.id });
    setMsg(`“${active.name}” will open by default.`);
  };

  const remove = () => {
    if (!active) return;
    const gone = active.name;
    persist({
      ...store,
      views: store.views.filter((v) => v.id !== active.id),
      activeId: null,  // not chosen — a remaining default may apply next visit
      defaultId: store.defaultId === active.id ? null : store.defaultId,
    });
    applyToWorking(EMPTY_LAYOUT);
    setMsg(`Deleted “${gone}”. Showing the default layout.`);
  };

  return (
    <div className="ly-views">
      <label className="ly-views-pick">
        <span className="muted">View</span>
        <select
          className="ly-swap"
          value={store.activeId === null || store.activeId === NO_VIEW ? '' : store.activeId}
          onChange={(e) => select(e.target.value)}
          aria-label="Saved layout view"
        >
          <option value="">Default layout</option>
          {store.views.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}{v.id === store.defaultId ? ' ★' : ''}
            </option>
          ))}
        </select>
      </label>

      {/* The editing controls appear only while editing: a reader who just wants
          to switch view should not have to look past four buttons to find the
          picker. */}
      {editing && (
        <>
          {active && (
            <button className="dt-btn" onClick={saveOver} title={`Overwrite “${active.name}”`}>
              Save
            </button>
          )}
          {!naming && (
            <button className="dt-btn" onClick={() => { setNaming(true); setName(''); }}>
              Save as new view…
            </button>
          )}
          {naming && (
            <span className="ly-views-name">
              <input
                className="gf-search-in"
                style={{ width: '11rem' }}
                placeholder="View name"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveAs();
                  if (e.key === 'Escape') { setNaming(false); setName(''); }
                }}
              />
              <button className="dt-btn" disabled={name.trim() === ''} onClick={saveAs}>Save</button>
              <button className="dt-btn" onClick={() => { setNaming(false); setName(''); }}>Cancel</button>
            </span>
          )}
          {active && active.id !== store.defaultId && (
            <button className="dt-btn" onClick={makeDefault} title="Open this view by default">
              Set as default
            </button>
          )}
          {active && (
            <button className="dt-btn" onClick={remove} title={`Delete “${active.name}”`}>
              Delete view
            </button>
          )}
        </>
      )}

      {msg && <span className="ly-views-msg muted">{msg}</span>}
    </div>
  );
}
