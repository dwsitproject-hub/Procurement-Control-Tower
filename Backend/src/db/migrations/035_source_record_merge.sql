-- 035 - SAP uploads add to what is already loaded instead of replacing it.
--
-- Requested 6 Oct 2026: "every time we get new files ... we should not delete
-- the old data that we have captured from the previous files, instead, we
-- should check whether in the new files, there is a data update or not, if
-- there is then we need to update the data, if there is a new data, then we
-- should insert the new data."
--
-- Until now each dataset version was built from ONE batch's files and nothing
-- else, so an export covering September alone produced a dashboard holding
-- September alone.
--
-- -- The store -----------------------------------------------------------------
--
-- ingest.source_record keeps every SAP record the pipeline has accepted, one
-- row per (feed, record key, batch that changed it). A batch writes only the
-- records that are NEW or DIFFERENT from what its parent already held, so the
-- table grows by the changes, not by a full copy per upload.
--
-- A batch's effective data is its lineage: itself, its parent, the parent's
-- parent and so on, taking for each DOCUMENT the copy from the nearest batch.
-- The parent is the batch of the version that was PUBLISHED when the upload
-- started, so a rollback works: after reverting to an older version, the next
-- upload builds on that version and the rolled-back one is simply not in its
-- lineage.
--
-- -- Record key and document key --------------------------------------------------
--
-- record_key identifies one row (PO 4500000001 line 10). doc_key is the unit
-- that is replaced as a whole when a file carries it:
--
--   pr    Purchase Requisition + Item          (record = document)
--   po    Purchasing Document + Item           (record = document)
--   gr    year(Posting Date) + Material Document + Material Doc.Item (034)
--   prel  PR No + PR Item + Rel Seq, replaced per PR No + PR Item
--   por   PO No + Rel Seq + Rel Code, replaced per PO No
--
-- The two release feeds are replaced per document because their rows are the
-- steps of ONE approval: when SAP resets a release strategy, the new export
-- lists the steps the document has NOW, and keeping a step from an older file
-- that the new one no longer lists would invent an approval that no longer
-- exists. Every key was measured unique on the 25 Sep 2026 export (batch 40).
--
-- -- What is never removed -------------------------------------------------------
--
-- A record missing from a later file is kept. SAP signals a deletion INSIDE the
-- record - deletion indicator 'L' on an order line, the PR deletion flag - so a
-- deleted document arrives as an update, and it stays visible as deleted.

CREATE TABLE IF NOT EXISTS ingest.source_record (
  feed          text    NOT NULL,
  record_key    text    NOT NULL,
  doc_key       text    NOT NULL,
  batch_id      bigint  NOT NULL REFERENCES ingest.batch(id) ON DELETE CASCADE,
  payload       jsonb   NOT NULL,
  payload_hash  text    NOT NULL,
  -- Lineage: the file and row this copy came from. Kept on the record because
  -- staging.raw_row is pruned with old versions and these rows outlive it.
  batch_file_id bigint  NOT NULL,
  source_row    integer NOT NULL,
  PRIMARY KEY (feed, record_key, batch_id)
);

CREATE INDEX IF NOT EXISTS ix_source_record_doc
  ON ingest.source_record (feed, doc_key, batch_id);
CREATE INDEX IF NOT EXISTS ix_source_record_batch
  ON ingest.source_record (batch_id, feed);

-- The batch this one builds on (NULL: a full load that stands alone), and
-- whether its records have been written to the store. A batch published before
-- this migration is recorded on first use, from its own staging rows.
ALTER TABLE ingest.batch ADD COLUMN IF NOT EXISTS parent_batch_id bigint REFERENCES ingest.batch(id);
ALTER TABLE ingest.batch ADD COLUMN IF NOT EXISTS source_recorded boolean NOT NULL DEFAULT false;
-- Per feed: rows in the file, and how many were new, updated or unchanged.
ALTER TABLE ingest.batch ADD COLUMN IF NOT EXISTS merge_summary jsonb;
