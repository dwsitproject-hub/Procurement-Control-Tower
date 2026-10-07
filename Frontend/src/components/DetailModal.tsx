import { useEffect } from 'react';
import { DetailTable } from './DetailTable';

/**
 * The Detail Table in a floating panel (requested 7 Oct 2026).
 *
 * Open Items' figures used to narrow the table at the bottom of the page, two
 * screens below the number that was clicked - and in the Management view there
 * was no table at all, so a click did nothing visible. The rows now open over
 * the page, next to the figure.
 *
 * It is the whole Detail Table, not a reduced copy: the same server query, so
 * the row count equals the number clicked (the filter seeded here is the one
 * the server states for that number), and the same tools - column chooser,
 * drag-to-reorder, sort on every column, the scrollbar above the table, export.
 */
export function DetailModal({
  title,
  initial,
  globalQuery,
  onClose,
}: {
  title: string;
  initial: Record<string, string>;
  globalQuery: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3 id="detail-modal-title">{'\u{1F50D} '}{title}</h3>
          <span className="spacer" />
          <button className="dd-x" onClick={onClose} aria-label="Close" title="Close">
            {'✕'}
          </button>
        </header>
        <div className="body">
          <DetailTable
            key={JSON.stringify(initial)}
            initial={initial}
            initialLabel={title}
            globalQuery={globalQuery}
          />
        </div>
      </div>
    </div>
  );
}
