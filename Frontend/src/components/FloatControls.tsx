import { useEffect, useRef, useState } from 'react';

/**
 * Minimize / maximize for a floating page (11 Nov 2026). Dropped into any
 * popup's header; it needs nothing from the popup but its close handler.
 *
 *   minimize  the popup shrinks to its title bar, docked bottom-right, and the
 *             dimmed backdrop clears and lets clicks through - the page behind
 *             can be read and used while the popup waits;
 *   maximize  the popup fills the screen below the top bar.
 *
 * The state is written as `data-float` on the popup and its backdrop, never as
 * a class: React owns their className and would put it back on the next
 * render, but it never touches an attribute it was not given.
 */
type Mode = 'normal' | 'max' | 'min';

export function FloatControls({ onClose }: { onClose?: () => void }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [mode, setMode] = useState<Mode>('normal');

  useEffect(() => {
    const modal = ref.current?.closest<HTMLElement>('.modal') ?? null;
    const back = modal?.parentElement?.classList.contains('modal-backdrop') ? modal.parentElement : null;
    for (const el of [modal, back]) {
      if (!el) continue;
      if (mode === 'normal') delete el.dataset['float'];
      else el.dataset['float'] = mode;
    }
  }, [mode]);

  // A click here must not reach the popup's own handlers (or a backdrop's
  // click-to-close).
  const btn = (title: string, label: string, onClick: () => void) => (
    <button type="button" className="fl-btn" title={title} aria-label={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {label}
    </button>
  );

  return (
    <span className="fl-ctl" ref={ref}>
      {mode === 'min'
        ? btn('Restore', '▢', () => setMode('normal'))
        : btn('Minimize', '—', () => setMode('min'))}
      {mode !== 'min' && (mode === 'max'
        ? btn('Restore size', '❐', () => setMode('normal'))
        : btn('Maximize', '□', () => setMode('max')))}
      {/* Minimized, the header shows only the title and these buttons. */}
      {mode === 'min' && onClose && btn('Close', '✕', onClose)}
    </span>
  );
}
