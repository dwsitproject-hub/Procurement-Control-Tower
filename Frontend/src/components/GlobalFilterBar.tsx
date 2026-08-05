import { useEffect, useState } from 'react';
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
}: {
  value: GlobalFilterState;
  onChange: (next: GlobalFilterState) => void;
}) {
  const [opts, setOpts] = useState<FilterOptions | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<FilterOptions>('/api/v1/filters')
      .then(setOpts)
      .catch(() => setOpts(null));
  }, []);

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
    <div className="gf-bar">
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
        if (!options || options.length <= 1) return null;
        const selected = value[d.key];
        return (
          <div key={d.key} className="gf-dim">
            <button
              className="gf-btn"
              aria-expanded={open === d.key}
              onClick={() => setOpen(open === d.key ? null : d.key)}
            >
              {d.label}
              {selected.length > 0 && <span className="gf-badge">{selected.length}</span>}
            </button>
            {open === d.key && (
              <div className="gf-panel">
                <div className="gf-panel-head">
                  <button className="gf-mini" onClick={() => onChange({ ...value, [d.key]: [] })}>
                    Clear
                  </button>
                  <button
                    className="gf-mini"
                    onClick={() => onChange({ ...value, [d.key]: options.map((o) => o.value) })}
                  >
                    All
                  </button>
                </div>
                <div className="gf-panel-list">
                  {options.map((o) => (
                    <label key={o.value} className="gf-opt">
                      <input
                        type="checkbox"
                        checked={selected.includes(o.value)}
                        onChange={() => toggle(d.key, o.value)}
                      />
                      <span>{o.label}</span>
                      {o.label !== o.value && <span className="muted"> ({o.value})</span>}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}

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
