-- 012: per-feed share-folder pickup slots (user request 6 Aug 2026).
--
-- Each feed gets its own folder, its own file-name pattern and up to three
-- daily pickup times in Asia/Jakarta. This table records which slot has
-- already fired on which Jakarta date, so a restart can neither re-run a slot
-- nor skip one, and the panel can show what happened.
CREATE TABLE IF NOT EXISTS ops.ingest_slot_run (
  feed      text NOT NULL,
  slot      smallint NOT NULL CHECK (slot BETWEEN 1 AND 3),
  -- The Jakarta calendar date the slot fired on, not UTC: a 23:30 Jakarta slot
  -- belongs to that Jakarta day even though it is the previous day in UTC.
  ran_on    date NOT NULL,
  ran_at    timestamptz NOT NULL DEFAULT now(),
  outcome   text,
  detail    text,
  PRIMARY KEY (feed, slot, ran_on)
);

CREATE INDEX IF NOT EXISTS ix_ingest_slot_run_recent
  ON ops.ingest_slot_run (ran_at DESC);
