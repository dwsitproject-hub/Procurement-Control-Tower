import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';

/**
 * Section and card titles an Admin can rename (039, 23 Oct 2026).
 *
 * A title is drawn through <Lbl>, which shows the Admin's rename when there is
 * one and the built-in text otherwise. The renames are one small shared set,
 * loaded once and re-read every POLL_MS and whenever the tab regains focus, so
 * a rename reaches every open page within that time without a reload; the
 * Admin who made it sees it at once.
 *
 * Keys: '<page>::<built-in text>' by default, so the same words on two pages
 * are two titles; an explicit `k` ('chart:<id>', 'kpi:<id>', 'oi-stage:<key>')
 * for a title that is the same thing wherever it appears.
 */

const POLL_MS = 30_000;

interface LabelSet {
  labels: Record<string, string>;
  version: string | null;
}

interface LabelCtx {
  labels: Record<string, string>;
  /** The page the titles belong to - the app's tab id. */
  page: string;
  /** Admin title-edit mode: every <Lbl> shows its rename pencil. */
  editing: boolean;
  save: (key: string, label: string, defaultText: string) => Promise<void>;
  reset: (key: string) => Promise<void>;
}

const Ctx = createContext<LabelCtx>({
  labels: {}, page: '', editing: false,
  save: async () => undefined, reset: async () => undefined,
});

export function LabelProvider({
  page, editing, children,
}: { page: string; editing: boolean; children: ReactNode }) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const last = useRef('');

  // Only a CHANGED set re-renders the page: every poll would otherwise redraw
  // every title, and the charts under them.
  const take = useCallback((s: LabelSet) => {
    const sig = JSON.stringify(s.labels);
    if (sig === last.current) return;
    last.current = sig;
    setLabels(s.labels);
  }, []);

  const load = useCallback(() => {
    api.get<LabelSet>('/api/v1/ui-labels').then(take).catch(() => undefined);
  }, [take]);

  useEffect(() => {
    load();
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [load]);

  const save = useCallback(async (key: string, label: string, defaultText: string) => {
    take(await api.put<LabelSet>('/api/v1/admin/ui-labels', { key, label, defaultText }));
  }, [take]);
  const reset = useCallback(async (key: string) => {
    take(await api.post<LabelSet>('/api/v1/admin/ui-labels/reset', { key }));
  }, [take]);

  return <Ctx.Provider value={{ labels, page, editing, save, reset }}>{children}</Ctx.Provider>;
}

/** The title's key: explicit, or the page plus its built-in text. */
function keyFor(c: LabelCtx, text: string, k?: string): string {
  return k ?? `${c.page}::${text}`;
}

/**
 * A title as plain text, for places that need a string (a drill label, a
 * filter option) rather than an element.
 */
export function useLabelText(): (text: string, k?: string) => string {
  const c = useContext(Ctx);
  return (text, k) => c.labels[keyFor(c, text, k)] ?? text;
}

/** A renamable title. `children` is the built-in text. */
export function Lbl({ children, k }: { children: string; k?: string }) {
  const c = useContext(Ctx);
  const key = keyFor(c, children, k);
  const renamed = c.labels[key];
  const shown = renamed ?? children;
  const [open, setOpen] = useState<DOMRect | null>(null);

  if (!c.editing) return <>{shown}</>;
  return (
    <>
      {shown}
      {/* A span, not a button: many titles sit inside a card that IS a
          button, and a button inside a button is invalid. */}
      <span
        role="button"
        tabIndex={0}
        className={`lbl-pen${renamed ? ' lbl-pen--on' : ''}`}
        title={renamed ? `Rename (built-in title: “${children}”)` : 'Rename this title for every user'}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((e.currentTarget as HTMLElement).getBoundingClientRect());
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.stopPropagation();
          e.preventDefault();
          setOpen((e.currentTarget as HTMLElement).getBoundingClientRect());
        }}
      >
        ✎
      </span>
      {open && createPortal(
        <RenameBox
          at={open}
          builtIn={children}
          current={shown}
          renamed={renamed !== undefined}
          onSave={(v) => c.save(key, v, children)}
          onReset={() => c.reset(key)}
          onClose={() => setOpen(null)}
        />,
        document.body,
      )}
    </>
  );
}

/** The rename editor, over the page beside the pencil (a portal, so no card's
    click handler or overflow clipping reaches it). */
function RenameBox({
  at, builtIn, current, renamed, onSave, onReset, onClose,
}: {
  at: DOMRect; builtIn: string; current: string; renamed: boolean;
  onSave: (v: string) => Promise<void>; onReset: () => Promise<void>; onClose: () => void;
}) {
  const [v, setV] = useState(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const width = 340;
  const left = Math.max(8, Math.min(at.left, window.innerWidth - width - 8));
  const top = Math.min(at.bottom + 6, window.innerHeight - 150);

  return (
    <div
      ref={box}
      className="lbl-box"
      role="dialog"
      aria-label="Rename title"
      style={{ left, top, width }}
      onClick={(e) => e.stopPropagation()}
    >
      <label className="lbl-box-l">
        Title shown to every user
        <input
          autoFocus
          value={v}
          maxLength={200}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && v.trim() !== '' && !busy) void run(() => onSave(v.trim()));
            if (e.key === 'Escape') onClose();
          }}
        />
      </label>
      <p className="lbl-box-n">Built-in title: “{builtIn}”</p>
      {err && <p className="err" style={{ margin: '.2rem 0' }}>{err}</p>}
      <div className="lbl-box-a">
        <button className="dt-btn" disabled={busy || v.trim() === ''} onClick={() => void run(() => onSave(v.trim()))}>
          Save
        </button>
        {renamed && (
          <button className="dt-btn" disabled={busy} onClick={() => void run(onReset)}>
            Reset to built-in
          </button>
        )}
        <button className="dt-btn" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
