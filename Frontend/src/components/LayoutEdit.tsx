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
}

export const EMPTY_LAYOUT: TabLayout = {
  hidden: [], kpiOrder: [], chartOrder: [], replaced: {},
  addedKpis: [], addedCharts: [], customKpis: [], customCharts: [],
};

function sanitize(raw: unknown): TabLayout {
  const o = (raw ?? {}) as Record<string, unknown>;
  const list = (k: string): string[] =>
    Array.isArray(o[k]) ? (o[k] as unknown[]).map(String).slice(0, 100) : [];
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
export function applyLayout(defaults: string[], layout: TabLayout, kind: 'kpi' | 'chart'): string[] {
  const added = kind === 'kpi' ? layout.addedKpis : layout.addedCharts;
  const order = kind === 'kpi' ? layout.kpiOrder : layout.chartOrder;
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
  kind: 'kpi' | 'chart';
  layout: TabLayout;
  update: (mut: (cur: TabLayout) => TabLayout) => void;
  /** For cards: the KPI library to swap in (id -> title). */
  swapOptions?: { id: string; title: string }[];
  /** The SLOT ids currently rendered on the tab, in order — seeds the order list. */
  currentIds: string[];
}) {
  const orderKey = kind === 'kpi' ? 'kpiOrder' : 'chartOrder';

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
      <button className="ly-btn" title="Move left" onClick={(e) => { e.stopPropagation(); move(-1); }}>◀</button>
      <button className="ly-btn" title="Move right" onClick={(e) => { e.stopPropagation(); move(1); }}>▶</button>
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
}: {
  editing: boolean;
  setEditing: (v: boolean) => void;
  layout: TabLayout;
  update: (mut: (cur: TabLayout) => TabLayout) => void;
  kpiOptions: { id: string; title: string }[];
  chartOptions: { id: string; title: string }[];
  customOptions: { kpis: string[]; charts: string[] };
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
          <select className="ly-swap" value="" onChange={(e) => add('addedKpis', e.target.value)} aria-label="Add a KPI card">
            <option value="">+ Add KPI card…</option>
            {kpiOptions.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
          </select>
          <select className="ly-swap" value="" onChange={(e) => add('addedCharts', e.target.value)} aria-label="Add a chart">
            <option value="">+ Add chart…</option>
            {chartOptions.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
          </select>
          {(customOptions.kpis.length > 0 || customOptions.charts.length > 0) && (
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
            || layout.addedKpis.length > 0 || layout.addedCharts.length > 0) && (
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
