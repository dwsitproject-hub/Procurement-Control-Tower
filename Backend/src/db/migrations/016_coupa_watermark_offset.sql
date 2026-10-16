-- 016 — resume offset for the Coupa poller.
--
-- The poller paged from offset 0 every run and relied on the watermark to move
-- forward: "the next tick resumes from the advanced watermark". That holds only
-- while a run can read past every row sharing its update window.
--
-- It fails when more rows fall inside the window than one run's page budget
-- (40 pages x 50 = 2,000). The run reads the first 2,000, the newest row among
-- them IS the stored watermark, so the watermark cannot advance — and the next
-- run asks the same question and gets the same 2,000 rows. Forever.
--
-- Found on the supplier master, where a bulk update stamped several thousand
-- suppliers within a few minutes: 14,000 rows fetched across 9 runs yielded
-- 3,895 distinct suppliers, and everything updated after that cluster was
-- unreachable. Every poll also burned 40 API calls re-reading the same page.
--
-- With an offset persisted, a capped run resumes where it stopped instead of
-- restarting. The offset resets whenever the watermark advances, because a new
-- watermark means a different result set.

ALTER TABLE ops.coupa_watermark
  ADD COLUMN IF NOT EXISTS last_offset integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN ops.coupa_watermark.last_offset IS
  'Resume position inside the current watermark window. Non-zero only when a '
  'run stopped at the page cap without advancing the watermark.';
