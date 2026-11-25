-- 042 - partial loads: a file set aside whole, and why (5 Nov 2026).
--
-- Until now any blocker failed the whole run and every file went to the failed
-- folder. Now a bad ROW is set aside (ingest.row_error, the failed folder's
-- workbook) and the rest of its file loads; a file is set aside whole only
-- when none of it is usable - empty, a required column missing, a PR Release
-- file that looks re-sorted, a rate file without a usable year.
--
-- rejected_reason marks such a file. NULL for every file that loaded, and for
-- every file of a run before this migration. The after-run filing reads it:
-- a set-aside file goes to failed even when the run published.

ALTER TABLE ingest.batch_file ADD COLUMN IF NOT EXISTS rejected_reason text;
