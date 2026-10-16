import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { ScrollFrame } from './ScrollFrame';

/**
 * The table tools every popup table carries (requested 7 Oct 2026): choose
 * columns, drag a header to move it, click a header to sort either way. The
 * Detail Table had all three; the drill and entity popups had none, so the
 * same rows were easier to work with on one page than in the panel that
 * opened beside the number.
 *
 * Written once here so each table is a few lines of wiring, and the three
 * behave the same everywhere.
 */

export interface ToolColumn {
  key: string;
  label: string;
}

export type SortState = { key: string; dir: 'asc' | 'desc' } | null;

/** Next sort for a header click: ascending first, then descending, then ascending. */
export function nextSort(cur: SortState, key: string): SortState {
  return cur?.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
}

/**
 * Visible columns and their order, remembered per user under `prefKey`.
 *
 * Starts from every column (or `defaults`); a saved layout wins once it has
 * loaded. A column the table gains later is appended rather than hidden - the
 * saved list records only what its owner chose among the columns that
 * existed then.
 */
export function useColumnLayout(prefKey: string | null, columns: ToolColumn[] | null) {
  const [saved, setSaved] = useState<{ columns: string[]; known: string[] } | null>(null);
  const [visible, setVisible] = useState<string[] | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    loaded.current = false;
    setSaved(null);
    setVisible(null);
    if (!prefKey) return;
    let dead = false;
    api.get<{ value: { columns?: string[]; known?: string[] } | null }>(`/api/v1/me/preferences/${prefKey}`)
      .then((p) => {
        if (dead) return;
        const v = p?.value;
        if (v?.columns?.length) setSaved({ columns: v.columns, known: v.known ?? v.columns });
      })
      .catch(() => undefined)
      .finally(() => { if (!dead) loaded.current = true; });
    return () => { dead = true; };
  }, [prefKey]);

  // Keyed on the column KEYS, not the array: callers rebuild the column list
  // on every render, and an identity dependency here re-ran the effect below
  // on every render - and that effect sets state.
  const keySig = (columns ?? []).map((c) => c.key).join('\u0001');
  const allKeys = useMemo(() => (keySig === '' ? [] : keySig.split('\u0001')), [keySig]);

  // Resolve the visible list once the columns are known.
  useEffect(() => {
    if (allKeys.length === 0) return;
    setVisible((cur) => {
      if (cur !== null && saved === null) {
        const kept = cur.filter((k) => allKeys.includes(k));
        return kept.length === cur.length ? cur : kept;
      }
      if (saved) {
        const kept = saved.columns.filter((k) => allKeys.includes(k));
        const added = allKeys.filter((k) => !saved.known.includes(k));
        return [...kept, ...added];
      }
      return allKeys;
    });
  }, [allKeys, saved]);

  const persist = useCallback((cols: string[]) => {
    if (!prefKey || !loaded.current) return;
    void api.put(`/api/v1/me/preferences/${prefKey}`, { value: { columns: cols, known: allKeys } })
      .catch(() => undefined);
  }, [prefKey, allKeys]);

  const toggle = useCallback((key: string) => {
    setVisible((cur) => {
      const base = cur ?? allKeys;
      const next = base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
      persist(next);
      return next;
    });
  }, [allKeys, persist]);

  const reorder = useCallback((from: string, to: string) => {
    if (from === to) return;
    setVisible((cur) => {
      if (!cur) return cur;
      const fi = cur.indexOf(from);
      const ti = cur.indexOf(to);
      if (fi < 0 || ti < 0) return cur;
      const next = [...cur];
      next.splice(fi, 1);
      next.splice(ti, 0, from);
      persist(next);
      return next;
    });
  }, [persist]);

  const shown = useMemo(() => {
    const byKey = new Map((columns ?? []).map((c) => [c.key, c]));
    return (visible ?? allKeys).map((k) => byKey.get(k)).filter((c): c is ToolColumn => c !== undefined);
  }, [columns, visible, allKeys]);

  return { visible: visible ?? allKeys, shown, toggle, reorder };
}

/** The "Columns (n/m)" button and its checkbox panel. */
export function ColumnChooser({
  columns, visible, onToggle,
}: {
  columns: ToolColumn[];
  visible: string[];
  onToggle: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="dd-open" onClick={() => setOpen(!open)} aria-expanded={open}>
        Columns ({visible.length}/{columns.length})
      </button>
      {open && (
        <div className="dt-chooser tt-chooser">
          <div className="dt-chooser-group">
            {columns.map((c) => (
              <label key={c.key} className="dt-chip">
                <input type="checkbox" checked={visible.includes(c.key)} onChange={() => onToggle(c.key)} />
                {c.label}
              </label>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Header cells that drag to reorder and click to sort. Returns the props for a
 * <th>, and the sort button to put inside it.
 */
export function useHeaderDrag(onReorder: (from: string, to: string) => void) {
  const dragKey = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const thProps = (key: string) => ({
    draggable: true,
    className: over === key ? 'dt-dragover' : undefined,
    title: 'Drag to reorder, click to sort',
    onDragStart: (e: React.DragEvent) => { dragKey.current = key; e.dataTransfer.effectAllowed = 'move'; },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (over !== key) setOver(key);
    },
    onDragLeave: () => setOver((cur) => (cur === key ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      if (dragKey.current) onReorder(dragKey.current, key);
      dragKey.current = null;
      setOver(null);
    },
    onDragEnd: () => { dragKey.current = null; setOver(null); },
  });
  return thProps;
}

/** A header's label as a sort button, with the arrow when it is the sorted column. */
export function SortButton({
  label, colKey, sort, onSort,
}: {
  label: string;
  colKey: string;
  sort: SortState;
  onSort: (next: SortState) => void;
}) {
  return (
    <button className="dt-sort" onClick={() => onSort(nextSort(sort, colKey))} aria-label={`Sort by ${label}`}>
      {label}
      {sort?.key === colKey && <span aria-hidden="true">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
    </button>
  );
}

/** A cell value as a number when it reads as one ("1,234.5"), else null. */
function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.replace(/,/g, '').trim();
  if (t === '' || !/^-?[0-9]*[.]?[0-9]+$/.test(t)) return null;
  return Number(t);
}

/**
 * Order two cell values: numbers as numbers, everything else as text (with
 * numeric runs compared numerically), empty values last in either direction.
 */
export function compareValues(x: unknown, y: unknown, dir: 'asc' | 'desc'): number {
  const xe = x === null || x === undefined || x === '';
  const ye = y === null || y === undefined || y === '';
  if (xe || ye) return xe && ye ? 0 : xe ? 1 : -1;
  const sign = dir === 'asc' ? 1 : -1;
  const xn = asNumber(x);
  const yn = asNumber(y);
  if (xn !== null && yn !== null) return (xn - yn) * sign;
  return String(x).localeCompare(String(y), undefined, { numeric: true }) * sign;
}

export interface ToolTableColumn<T> {
  key: string;
  label: string;
  right?: boolean;
  render: (r: T) => ReactNode;
  /** What the column sorts by; the row's own `key` field when absent. */
  sortValue?: (r: T) => unknown;
}

/**
 * A table that holds all its rows (the entity popups), with every table tool:
 * column chooser, drag-to-reorder, sort by any header both ways, and the
 * scrollbar above. Sorting is in the browser - every row is already here.
 */
export function ToolTable<T>({
  prefKey, columns, rows, maxHeight, lead, className = 'data dd-tbl',
}: {
  /** Where the column choice is remembered, per user. */
  prefKey: string;
  columns: ToolTableColumn<T>[];
  rows: T[];
  maxHeight?: string;
  /** An unlabelled first cell (row flags), outside the chooser. */
  lead?: (r: T) => ReactNode;
  className?: string;
}) {
  const layout = useColumnLayout(prefKey, columns);
  const thProps = useHeaderDrag(layout.reorder);
  const [sort, setSort] = useState<SortState>(null);
  const byKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);
  const shown = layout.visible.map((k) => byKey.get(k)).filter((c): c is ToolTableColumn<T> => c !== undefined);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = byKey.get(sort.key);
    const val = (r: T): unknown => (col?.sortValue ? col.sortValue(r) : (r as Record<string, unknown>)[sort.key]);
    return [...rows].sort((a, b) => compareValues(val(a), val(b), sort.dir));
  }, [rows, sort, byKey]);

  return (
    <>
      <div className="tt-bar">
        <ColumnChooser columns={columns} visible={layout.visible} onToggle={layout.toggle} />
      </div>
      <ScrollFrame className="table-wrap" style={maxHeight ? { maxHeight, overflow: 'auto' } : undefined}>
        <table className={className}>
          <thead>
            <tr>
              {lead && <th />}
              {shown.map((c) => (
                <th key={c.key} {...thProps(c.key)} style={c.right ? { textAlign: 'right' } : undefined}>
                  <SortButton label={c.label} colKey={c.key} sort={sort} onSort={setSort} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={i}>
                {lead && <td>{lead(r)}</td>}
                {shown.map((c) => <td key={c.key} className={c.right ? 'num' : undefined}>{c.render(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollFrame>
    </>
  );
}
