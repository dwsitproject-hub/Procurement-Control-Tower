import { useEffect, useRef, useState } from 'react';
import { formatNumber } from '../lib/format';

/**
 * One multi-select filter, drawn exactly like a dimension of the filter bar
 * (GlobalFilterBar): a button with a count badge that opens a panel with a
 * search box, "Select all" over what is shown, a count, Clear, and the ticked
 * list. Closes on a click outside or Escape.
 *
 * Written 19 Oct 2026 so filters elsewhere on a page - Open Items' backlog
 * table, the Category 360 plant filter - look and behave like the ones in the
 * page header instead of being a second, plainer design.
 */
export interface FilterOption {
  value: string;
  /** Shown instead of the value when given. */
  label?: string;
  count?: number;
}

export function FilterDropdown({
  label, options, selected, onChange,
}: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    search.current?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const needle = q.trim().toLowerCase();
  const shown = needle === ''
    ? options
    : options.filter((o) => (o.label ?? o.value).toLowerCase().includes(needle)
      || o.value.toLowerCase().includes(needle));
  const shownValues = shown.map((o) => o.value);
  const allShown = shown.length > 0 && shownValues.every((v) => selected.includes(v));

  return (
    <div className="gf-dim" ref={box}>
      <button type="button" className="gf-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
        {selected.length > 0 && <span className="gf-badge">{selected.length}</span>}
        <span className="gf-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="gf-panel" role="group" aria-label={label}>
          <div className="gf-search">
            <input
              ref={search}
              type="search"
              className="gf-search-in"
              placeholder={`Search ${label.toLowerCase()}…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="gf-panel-head">
            <button
              type="button"
              className="gf-mini"
              onClick={() => onChange(allShown
                ? selected.filter((v) => !shownValues.includes(v))
                : [...new Set([...selected, ...shownValues])])}
            >
              {allShown ? 'Unselect' : 'Select'} {needle === '' ? 'all' : `all ${shown.length} shown`}
            </button>
            <span className="gf-count">{selected.length} of {options.length} selected</span>
            {selected.length > 0 && (
              <button type="button" className="gf-mini gf-mini-ghost" onClick={() => onChange([])}>Clear</button>
            )}
          </div>
          <div className="gf-panel-list">
            {shown.length === 0 && <p className="gf-empty">No {label.toLowerCase()} matches “{q}”.</p>}
            {shown.map((o) => (
              <label key={o.value} className={`gf-opt${selected.includes(o.value) ? ' gf-opt-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={selected.includes(o.value)}
                  onChange={() => onChange(selected.includes(o.value)
                    ? selected.filter((v) => v !== o.value)
                    : [...selected, o.value])}
                />
                <span className="gf-opt-label">{o.label ?? o.value}</span>
                {o.count !== undefined && <span className="gf-opt-code">{formatNumber(o.count)}</span>}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
