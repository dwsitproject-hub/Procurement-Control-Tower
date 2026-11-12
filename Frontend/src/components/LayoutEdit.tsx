import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * G4 — per-user tab layout: v1's lyMove / lyHide / hd-modal (restore hidden) /
 * cd-modal (swap a card's KPI) / "+ Add card / chart", rebuilt server-side.
 *
 * The layout is a per-user preference (`tab_layout_<tab>`), so it follows the
 * user across devices — v1 kept this in localStorage per browser. Only
 * whitelisted ids can appear: KPI ids come from the server's KPI payload and
 * chart ids from the chart catalogue, so a hand-edited preference can name
 * nothing that is not already served.
 */

export interface TabLayout {
  hidden: string[];           // kpi or chart ids removed from the tab
  kpiOrder: string[];         // explicit order; ids absent keep default order
  chartOrder: string[];
  replaced: Record<string, string>; // slot kpi id -> shown kpi id (cd-modal)
  addedKpis: string[];        // library KPIs added to this tab
  addedCharts: string[];      // registered charts added to this tab
  customKpis: string[];       // titles of saved Custom-builder KPIs shown here
  customCharts: string[];     // titles of saved Custom-builder charts shown here
  /**
   * Order of whole PANELS on pages built from panels rather than card slots —
   * the Executive Summary.
   *
   * A separate order list because a panel is a different unit from a card: that
   * page has no KPI slots to reorder, its sections are the thing a reader wants
   * moved or hidden. Hiding reuses the shared `hidden` list, since panel ids are
   * namespaced (`panel:category`) and cannot collide with a KPI or chart id.
   */
  panelOrder: string[];
  /**
   * Width of a panel, as a share of the row: id -> 'third' | 'half' |
   * 'twothirds' | 'full'.
   *
   * Absent means full width, which is what every panel was before this existed,
   * so an old saved layout renders exactly as it did.
   */
  size: Record<string, PanelSize>;
}

/** The widths a panel can take, on a 12-column row. */
export const PANEL_SIZES = [
  { key: 'third', label: 'One third', span: 4 },
  { key: 'half', label: 'Half', span: 6 },
  { key: 'twothirds', label: 'Two thirds', span: 8 },
  { key: 'full', label: 'Full width', span: 12 },
] as const;

export type PanelSize = (typeof PANEL_SIZES)[number]['key'];

/** Columns a panel spans; anything unrecognised falls back to full width. */
export function panelSpan(layout: TabLayout, id: string): number {
  const s = layout.size?.[id];
  return PANEL_SIZES.find((x) => x.key === s)?.span ?? 12;
}

export const EMPTY_LAYOUT: TabLayout = {
  hidden: [], kpiOrder: [], chartOrder: [], replaced: {},
  addedKpis: [], addedCharts: [], customKpis: [], customCharts: [],
  panelOrder: [], size: {},
};

function sanitize(raw: unknown): TabLayout {
  const o = (raw ?? {}) as Record<string, unknown>;
  const list = (k: string): string[] =>
    Array.isArray(o[k]) ? (o[k] as unknown[]).map(String).slice(0, 100) : [];
  // Only the known widths survive: a hand-edited preference cannot inject a
  // class name into the grid.
  const size: Record<string, PanelSize> = {};
  if (o['size'] && typeof o['size'] === 'object') {
    for (const [k, v] of Object.entries(o['size'] as Record<string, unknown>)) {
      const val = String(v);
      if (PANEL_SIZES.some((x) => x.key === val)) size[k] = val as PanelSize;
    }
  }

  const replaced: Record<string, string> = {};
  if (o['replaced'] && typeof o['replaced'] === 'object') {
    for (const [k, v] of Object.entries(o['replaced'] as Record<string, unknown>)) {
      replaced[k] = String(v);
    }
  }
  return {
    hidden: list('hidden'), kpiOrder: list('kpiOrder'), chartOrder: list('chartOrder'),
    replaced,
    addedKpis: list('addedKpis'), addedCharts: list('addedCharts'),
    customKpis: list('customKpis'), customCharts: list('customCharts'),
    // Absent in layouts saved before panels existed; list() gives [].
    panelOrder: list('panelOrder'),
    size,
  };
}

export function useTabLayout(tab: string) {
  const [layout, setLayout] = useState<TabLayout>(EMPTY_LAYOUT);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    api
      .get<{ value: unknown }>(`/api/v1/me/preferences/tab_layout_${tab}`)
      .then((p) => {
        if (!cancelled) setLayout(sanitize(p?.value));
      })
      .catch(() => {
        if (!cancelled) setLayout(EMPTY_LAYOUT);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const update = useCallback(
    (mut: (cur: TabLayout) => TabLayout) => {
      setLayout((cur) => {
        const next = mut(cur);
        void api
          .put(`/api/v1/me/preferences/tab_layout_${tab}`, { value: next })
          .catch(() => undefined);
        return next;
      });
    },
    [tab],
  );

  return { layout, loaded, update };
}

/**
 * Default ids + layout -> the ordered, visible SLOT id list. Slots keep their
 * original id even when swapped (cd-modal semantics: "this slot currently
 * shows X") — the caller resolves `layout.replaced[slot] ?? slot` to render.
 */
export function applyLayout(
  defaults: string[],
  layout: TabLayout,
  kind: 'kpi' | 'chart' | 'panel',
): string[] {
  // Panels are a fixed set — there is no library to add one from — so nothing is
  // appended for that kind.
  const added = kind === 'kpi' ? layout.addedKpis : kind === 'chart' ? layout.addedCharts : [];
  const order = kind === 'kpi'
    ? layout.kpiOrder
    : kind === 'chart' ? layout.chartOrder : layout.panelOrder;
  const base = [...defaults, ...added.filter((a) => !defaults.includes(a))];
  const ordered =
    order.length > 0
      ? [...order.filter((id) => base.includes(id)), ...base.filter((id) => !order.includes(id))]
      : base;
  return ordered.filter((id) => !layout.hidden.includes(id));
}

/** Move / hide / swap controls shown on a card or chart while editing. */
export function LayoutControls({
  id, kind, layout, update, swapOptions, currentIds,
}: {
  id: string;
  kind: 'kpi' | 'chart' | 'panel';
  layout: TabLayout;
  update: (mut: (cur: TabLayout) => TabLayout) => void;
  /** For cards: the KPI library to swap in (id -> title). */
  swapOptions?: { id: string; title: string }[];
  /** The SLOT ids currently rendered on the tab, in order — seeds the order list. */
  currentIds: string[];
}) {
  const orderKey = kind === 'kpi' ? 'kpiOrder' : kind === 'chart' ? 'chartOrder' : 'panelOrder';
  // Panels stack vertically, cards flow horizontally — the arrows should say
  // what they will actually do.
  const back = kind === 'panel' ? 'Move up' : 'Move left';
  const fwd = kind === 'panel' ? 'Move down' : 'Move right';

  const move = (dir: -1 | 1) => {
    update((cur) => {
      const order = cur[orderKey].length > 0 ? [...cur[orderKey]] : [...currentIds];
      const i = order.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return cur;
      [order[i], order[j]] = [order[j]!, order[i]!];
      return { ...cur, [orderKey]: order };
    });
  };

  return (
    <span className="ly-controls">
      <button className="ly-btn" title={back} onClick={(e) => { e.stopPropagation(); move(-1); }}>
        {kind === 'panel' ? '▲' : '◀'}
      </button>
      <button className="ly-btn" title={fwd} onClick={(e) => { e.stopPropagation(); move(1); }}>
        {kind === 'panel' ? '▼' : '▶'}
      </button>
      {/*
        Width, panels only. A card or chart on the other pages sits in a grid
        that sizes it, so offering a width there would be a control with nothing
        to act on until those grids learn the same idea.
      */}
      {kind === 'panel' && (
        <select
          className="ly-swap"
          title="How wide this section should be"
          value={layout.size?.[id] ?? 'full'}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const v = e.target.value;
            update((cur) => {
              const size = { ...cur.size };
              // 'full' is the default, so it is stored as ABSENT rather than as a
              // value — a layout that changed nothing then saves as empty and
              // reads as untouched.
              if (v === 'full') delete size[id];
              else size[id] = v as PanelSize;
              return { ...cur, size };
            });
          }}
        >
          {PANEL_SIZES.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
      )}
      {kind === 'kpi' && swapOptions && (
        <select
          className="ly-swap"
          title="Show a different KPI in this slot"
          value={layout.replaced[id] ?? ''}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const v = e.target.value;
            update((cur) => {
              const replaced = { ...cur.replaced };
              if (v === '') delete replaced[id];
              else replaced[id] = v;
              return { ...cur, replaced };
            });
          }}
        >
          <option value="">(default)</option>
          {swapOptions.map((o) => (
            <option key={o.id} value={o.id}>{o.title}</option>
          ))}
        </select>
      )}
      <button
        className="ly-btn ly-hide"
        title="Hide from this tab (restore from the edit bar)"
        onClick={(e) => {
          e.stopPropagation();
          update((cur) => ({ ...cur, hidden: [...cur.hidden, id] }));
        }}
      >
        ✕
      </button>
    </span>
  );
}

/** The edit bar: toggle, add pickers, hidden-item restore (v1's hd-modal). */
export function LayoutEditBar({
  editing, setEditing, layout, update, kpiOptions, chartOptions, customOptions,
  showAdders = true,
}: {
  editing: boolean;
  setEditing: (v: boolean) => void;
  layout: TabLayout;
  update: (mut: (cur: TabLayout) => TabLayout) => void;
  kpiOptions: { id: string; title: string }[];
  chartOptions: { id: string; title: string }[];
  customOptions: { kpis: string[]; charts: string[] };
  /**
   * False on a page built from PANELS rather than card slots.
   *
   * The Executive Summary's sections are a fixed set — there is no library to add
   * one from — so the three "+ Add…" pickers would be three empty dropdowns
   * inviting a click that can do nothing. Hide/move/restore/reset all still
   * apply, so the rest of the bar stays.
   */
  showAdders?: boolean;
}) {
  const add = (key: keyof TabLayout, v: string) => {
    if (!v) return;
    update((cur) => {
      const list = cur[key] as string[];
      return list.includes(v) ? cur : { ...cur, [key]: [...list, v] };
    });
  };

  return (
    <div className="ly-bar">
      <button className="dt-btn" aria-pressed={editing} onClick={() => setEditing(!editing)}>
        {editing ? '✓ Done editing' : '✎ Edit layout'}
      </button>
      {editing && (
        <>
          {showAdders && (
          <>
          <select className="ly-swap" value="" onChange={(e) => add('addedKpis', e.target.value)} aria-label="Add a KPI card">
            <option value="">+ Add KPI card…</option>
            {kpiOptions.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
          </select>
          <select className="ly-swap" value="" onChange={(e) => add('addedCharts', e.target.value)} aria-label="Add a chart">
            <option value="">+ Add chart…</option>
            {chartOptions.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
          </select>
          </>
          )}
          {showAdders && (customOptions.kpis.length > 0 || customOptions.charts.length > 0) && (
            <select
              className="ly-swap" value=""
              onChange={(e) => {
                const [kind, ...rest] = e.target.value.split(':');
                add(kind === 'k' ? 'customKpis' : 'customCharts', rest.join(':'));
              }}
              aria-label="Add a saved custom item"
            >
              <option value="">+ Add my custom…</option>
              {customOptions.kpis.map((t) => <option key={`k:${t}`} value={`k:${t}`}>KPI: {t}</option>)}
              {customOptions.charts.map((t) => <option key={`c:${t}`} value={`c:${t}`}>Chart: {t}</option>)}
            </select>
          )}
          {layout.hidden.length > 0 && (
            <span className="ly-hidden">
              Hidden: {layout.hidden.map((h) => (
                <button
                  key={h} className="dt-btn"
                  title="Restore"
                  onClick={() => update((cur) => ({ ...cur, hidden: cur.hidden.filter((x) => x !== h) }))}
                >
                  {h} ↩
                </button>
              ))}
            </span>
          )}
          {(layout.kpiOrder.length > 0 || Object.keys(layout.replaced).length > 0 || layout.hidden.length > 0
            || layout.addedKpis.length > 0 || layout.addedCharts.length > 0
            || layout.panelOrder.length > 0 || layout.chartOrder.length > 0
            || Object.keys(layout.size ?? {}).length > 0) && (
            <button
              className="dt-btn"
              title="Reset this tab to the default layout"
              onClick={() => update(() => EMPTY_LAYOUT)}
            >
              Reset tab
            </button>
          )}
        </>
      )}
    </div>
  );
}
