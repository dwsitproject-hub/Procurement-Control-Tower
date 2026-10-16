-- 023 — per-row ingest errors, so a failure can name the rows that caused it.
--
-- Until now a bad value was silent. coerce() in parse.ts returns null when a
-- cell cannot be read as its declared type, and null is also what an empty cell
-- returns, so "the date was blank" and "the date said 31.02.2026" were
-- indistinguishable downstream. The validation layer counted rows in aggregate
-- (affectedRows) and could say 12 rows were wrong, but never which 12.
--
-- That is the gap this table closes: an operator gets the rows themselves, with
-- the value that could not be read and the reason, in a workbook they can hand
-- back to whoever produced the export.
--
-- Rows die with their batch (ON DELETE CASCADE) rather than accumulating: they
-- are a diagnostic for a specific run, not history. A batch's staging rows are
-- pruned on the same schedule, so an error row would otherwise outlive the data
-- it describes and could no longer be explained.
CREATE TABLE IF NOT EXISTS ingest.row_error (
  id         bigserial PRIMARY KEY,
  batch_id   bigint  NOT NULL REFERENCES ingest.batch(id) ON DELETE CASCADE,
  feed       text    NOT NULL,
  -- 1-based row number in the SOURCE sheet, matching what the exporter sees in
  -- Excel: the header is row 1, so the first data row is 2. Same basis as
  -- staging.raw_row.source_row, so the two join.
  source_row integer NOT NULL,
  -- The contract's canonical field name and the sheet header it came from. Both,
  -- because the operator reading the workbook knows the header and the engineer
  -- reading a log knows the field.
  field      text,
  header     text,
  -- What was actually in the cell, as text. Kept verbatim — the whole point is
  -- to show the value that could not be read, so it is never normalised.
  raw_value  text,
  rule_id    text    NOT NULL,
  reason     text    NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_row_error_batch ON ingest.row_error (batch_id, feed);

-- One row per (batch, feed, row, field): a cell has at most one reason, and this
-- makes the insert idempotent if a batch is ever re-parsed.
CREATE UNIQUE INDEX IF NOT EXISTS ux_row_error_cell
  ON ingest.row_error (batch_id, feed, source_row, COALESCE(field, ''));
