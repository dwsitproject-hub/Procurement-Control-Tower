import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { formatNumber } from '../lib/format';

/**
 * Global filter bar — v1's gms('co') / gms('mo') / gms('pl') controls.
 *
 * Selections are lifted to App so every KPI and chart request carries them, and
 * are encoded in the URL so a filtered view is shareable. The recipient's own
 * data scope is always re-applied server-side, so a shared link can never widen
 * what someone is allowed to see.
 */

export interface GlobalFilterState {
  company: string[];
  plant: string[];
  purchOrg: string[];
  monthKey: string[];
  /** v1's "Show: All | Open Only | Complete (GR)" toggle. '' means All. */
  scope: '' | 'open' | 'complete';
}

export const EMPTY_FILTER: GlobalFilterState = {
  company: [],
  plant: [],
  purchOrg: [],
  monthKey: [],
  scope: '',
};

interface Option {
  value: string;
  label: string;
}

interface FilterOptions {
  company: Option[];
  plant: Option[];
  purchOrg: Option[];
  monthKey: Option[];
}

type ListDim = 'company' | 'plant' | 'purchOrg' | 'monthKey';

const DIMENSIONS: { key: ListDim; label: string }[] = [
  { key: 'company', label: 'Company' },
  { key: 'plant', label: 'Plant' },
  { key: 'purchOrg', label: 'Purch Org' },
  { key: 'monthKey', label: 'Month' },
];

export function globalFilterQuery(f: GlobalFilterState): string {
  const q = new URLSearchParams();
  if (f.company.length) q.set('company', f.company.join(','));
  if (f.plant.length) q.set('plant', f.plant.join(','));
  if (f.purchOrg.length) q.set('purchOrg', f.purchOrg.join(','));
  if (f.monthKey.length) q.set('monthKey', f.monthKey.join(','));
  if (f.scope) q.set('scope', f.scope);
  return q.toString();
}

export function activeFilterCount(f: GlobalFilterState): number {
  return (
    f.company.length + f.plant.length + f.purchOrg.length + f.monthKey.length + (f.scope ? 1 : 0)
  );
}

export function GlobalFilterBar({
  value,
  onChange,
  datasetVersionId,
}: {
  value: GlobalFilterState;
  onChange: (next: GlobalFilterState) => void;
  /**
   * The published version the options belong to.
   *
   * The list used to be fetched once on mount, so a newly published dataset that
   * introduced a plant, a purchasing org or a month left the bar offering the
   * PREVIOUS version's values — and a page reload was the only way to see the
   * new ones. Keying the fetch on the version means the options follow the data.
   */
  datasetVersionId: number | null;
}) {
  const [opts, setOpts] = useState<FilterOptions | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  /** Per-dimension search text, so each panel keeps its own. */
  const [search, setSearch] = useState<Record<string, string>>({});
  /** Selections dropped because the new dataset no longer offers them. */
  const [dropped, setDropped] = useState<string[]>([]);
  const barRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let dead = false;
    api
      .get<FilterOptions>('/api/v1/filters')
      .then((d) => { if (!dead) setOpts(d); })
      .catch(() => { if (!dead) setOpts(null); });
    return () => { dead = true; };
  }, [datasetVersionId]);

  /**
   * Drop selected values the new dataset no longer contains.
   *
   * Keeping them looks harmless and is not: a filter pinned to a plant that no
   * longer exists returns nothing, on every page, with no visible reason. The
   * pruned values are named below rather than removed silently — the reader
   * chose them, so they are owed an explanation.
   */
  useEffect(() => {
    if (!opts) return;
    const next = { ...value };
    const gone: string[] = [];
    let changed = false;
    for (const d of DIMENSIONS) {
      const allowed = new Set((opts[d.key] ?? []).map((o) => o.value));
      const kept = value[d.key].filter((v) => allowed.has(v));
      if (kept.length !== value[d.key].length) {
        gone.push(...value[d.key].filter((v) => !allowed.has(v)));
        next[d.key] = kept;
        changed = true;
      }
    }
    setDropped(gone);
    // Only when something actually changed, or this would re-render forever.
    if (changed) onChange(next);
    // `value` is deliberately not a dependency: this runs when the OPTIONS
    // change, not on every selection the user makes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts]);

  // Click outside and Escape close the open panel. Without either, the only way
  // to dismiss one was to click its own button again — easy to miss, and the
  // panel then covers the page it is filtering.
  useEffect(() => {
    if (open === null) return undefined;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Focus the search box when a panel opens, so a long list is typeable straight
  // away rather than needing a click first.
  useEffect(() => {
    if (open !== null) searchRef.current?.focus();
  }, [open]);

  if (!opts) return null;

  const toggle = (dim: ListDim, v: string) => {
    const cur = value[dim];
    onChange({
      ...value,
      [dim]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v],
    });
  };

  const count = activeFilterCount(value);

  return (
    <div className="gf-bar" ref={barRef}>
      <span className="gf-label">Filters</span>

      {/* v1's per-page Show toggle, global here: recomputes every KPI/chart live. */}
      <div className="gf-scope" role="group" aria-label="Scope">
        {([['', 'All'], ['open', 'Open only'], ['complete', 'Complete (GR)']] as const).map(([v, l]) => (
          <button
            key={v || 'all'}
            className="gf-seg"
            aria-pressed={value.scope === v}
            onClick={() => onChange({ ...value, scope: v })}
          >
            {l}
          </button>
        ))}
      </div>

      {DIMENSIONS.map((d) => {
        const options = opts[d.key];
        // A dimension with one value is hidden: filtering to the only value that
        // exists changes nothing, so the control would be a dead end. Company is
        // therefore invisible on a single-entity dataset and appears the moment a
        // second company code lands.
        if (!options || options.length <= 1) return null;
        const selected = value[d.key];
        const q = (search[d.key] ?? '').trim().toLowerCase();
        // Matched on BOTH label and code, because a user knows a plant either way.
        const shown = q === ''
          ? options
          : options.filter((o) => o.label.toLowerCase().includes(q)
            || o.value.toLowerCase().includes(q));
        const shownValues = shown.map((o) => o.value);
        const allShownSelected = shown.length > 0
          && shownValues.every((v) => selected.includes(v));

        return (
          <div key={d.key} className="gf-dim">
            <button
              className="gf-btn"
              aria-expanded={open === d.key}
              onClick={() => { setOpen(open === d.key ? null : d.key); }}
            >
              {d.label}
              {selected.length > 0 && <span className="gf-badge">{selected.length}</span>}
              <span className="gf-caret" aria-hidden="true">▾</span>
            </button>
            {open === d.key && (
              <div className="gf-panel" role="group" aria-label={d.label}>
                <div className="gf-search">
                  <input
                    ref={searchRef}
                    type="search"
                    className="gf-search-in"
                    placeholder={`Search ${d.label.toLowerCase()}…`}
                    value={search[d.key] ?? ''}
                    onChange={(e) => setSearch({ ...search, [d.key]: e.target.value })}
                  />
                </div>
                <div className="gf-panel-head">
                  {/*
                    Select-all applies to what is CURRENTLY SHOWN, not to the whole
                    list. With a search active that is the only useful meaning —
                    "select all" after typing "EU" should select the EU plants, not
                    all 48 — and the label says which it is so the two cannot be
                    confused.
                  */}
                  <button
                    className="gf-mini"
                    onClick={() => onChange({
                      ...value,
                      [d.key]: allShownSelected
                        ? selected.filter((v) => !shownValues.includes(v))
                        : [...new Set([...selected, ...shownValues])],
                    })}
                  >
                    {allShownSelected ? 'Unselect' : 'Select'}{' '}
                    {q === '' ? 'all' : `all ${shown.length} shown`}
                  </button>
                  <span className="gf-count">
                    {selected.length} of {options.length} selected
                  </span>
                  {selected.length > 0 && (
                    <button
                      className="gf-mini gf-mini-ghost"
                      onClick={() => onChange({ ...value, [d.key]: [] })}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="gf-panel-list">
                  {shown.length === 0 && (
                    <p className="gf-empty">No {d.label.toLowerCase()} matches “{q}”.</p>
                  )}
                  {shown.map((o) => (
                    <label
                      key={o.value}
                      className={`gf-opt${selected.includes(o.value) ? ' gf-opt-on' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(o.value)}
                        onChange={() => toggle(d.key, o.value)}
                      />
                      <span className="gf-opt-label">{o.label}</span>
                      {/* No chip for a blank code — it would render as an empty box. */}
                      {o.value !== '' && o.label !== o.value && (
                        <span className="gf-opt-code">{o.value}</span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/*
        Named, not silent. A selection dropped because the new dataset no longer
        offers that value would otherwise just change the figures with no reason
        given.
      */}
      {dropped.length > 0 && (
        <span className="gf-dropped" title="These values are not in the current dataset">
          dropped: {dropped.join(', ')}
        </span>
      )}

      {count > 0 && (
        <>
          <button className="gf-btn gf-clear" onClick={() => onChange(EMPTY_FILTER)}>
            Clear all ({formatNumber(count)})
          </button>
          {/* Filtered figures are recomputed from the facts rather than read from
              the precomputed mart, so the reader knows which path produced them. */}
          <span className="gf-note">figures recomputed under filter</span>
        </>
      )}
    </div>
  );
}
