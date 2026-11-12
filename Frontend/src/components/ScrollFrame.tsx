import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * A scroll container with a second horizontal scrollbar ABOVE the table.
 *
 * Requested 7 Oct 2026: on a wide table the only horizontal scrollbar sat
 * under the last row, so reaching a column on the right meant scrolling all
 * the way down first. The top bar is a thin strip as wide as the table, kept in
 * step with the container in both directions; it appears only when the table
 * is actually wider than the frame.
 *
 * Used by every table that can outgrow its frame: the Detail Table, the drill
 * popups and the entity popups.
 */
export function ScrollFrame({
  className,
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const top = useRef<HTMLDivElement | null>(null);
  const main = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = main.current;
    if (!el) return undefined;
    const measure = () => {
      setWidth(el.scrollWidth);
      setOverflows(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The table inside changes width when columns are added, removed or paged
    // in, without the frame itself resizing.
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [children]);

  const sync = (from: 'top' | 'main') => {
    const a = from === 'top' ? top.current : main.current;
    const b = from === 'top' ? main.current : top.current;
    // Written only when they differ: the write fires the other side's scroll
    // event, which then finds them equal and stops there.
    if (!a || !b || b.scrollLeft === a.scrollLeft) return;
    b.scrollLeft = a.scrollLeft;
  };

  return (
    <>
      {overflows && (
        <div
          ref={top}
          className="scroll-top"
          onScroll={() => sync('top')}
          aria-hidden="true"
        >
          <div style={{ width, height: 1 }} />
        </div>
      )}
      <div ref={main} className={className} style={style} onScroll={() => sync('main')}>
        {children}
      </div>
    </>
  );
}
