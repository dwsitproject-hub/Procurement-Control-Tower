-- 024 — remember that a run filed its own source files away.
--
-- After-run filing (020's archive step) moves the consumed exports out of the
-- pickup folder. That makes the folder empty, and an empty folder was reported
-- as `incomplete_bundle` with every required feed missing — which is in
-- FAILURE_OUTCOMES, so the 07:00 scheduled run emailed a FAILURE every morning
-- between exports. The data was fine; the pipeline was describing the tidy-up
-- it had just performed as a fault.
--
-- "Empty because we filed everything" and "the exports never arrived" look
-- identical on the filesystem, so the difference has to be remembered rather
-- than inferred. This is that memory: one row per run that moved anything.
--
-- Why a table and not the in-memory lastArchive the panel reads: that is lost
-- on every container restart, and the question is asked by the NEXT run, which
-- is typically a day later and often after a deploy.

CREATE TABLE IF NOT EXISTS ops.ingest_filing (
  batch_id      bigint PRIMARY KEY REFERENCES ingest.batch (id) ON DELETE CASCADE,
  filed_at      timestamptz NOT NULL DEFAULT now(),
  -- Source files moved out of the pickup folder. Zero is not recorded at all:
  -- a run that filed nothing is not evidence that the folder is empty by
  -- design, so it must not silence the missing-exports warning.
  files_moved   int         NOT NULL,
  -- Unreadable rows written to the failed folder as a workbook, for the panel.
  rows_reported int         NOT NULL DEFAULT 0
);

-- The only read is "the most recent filing", so order by the timestamp.
CREATE INDEX IF NOT EXISTS ingest_filing_filed_at_idx
  ON ops.ingest_filing (filed_at DESC);
