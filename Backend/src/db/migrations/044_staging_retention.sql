-- 044: staging retention (architecture review, 12-13 Nov 2026).
--
-- staging.raw_row keeps every source row of a batch, for lineage and so a
-- transform can re-run without the files. prune_versions() deletes a version's
-- rows together with the version - but two kinds of rows were never deleted:
--
--   * batches that never became a dataset version (FAILED, CANCELLED, or a run
--     that died mid-way and stayed TRANSFORMING) - 2.15 M of 2.8 M rows, about
--     three quarters of the table, in the review's database;
--   * READY versions (built, never published) - excluded from prune_versions,
--     so every unconfirmed manual upload stayed for ever.
--
-- What must stay, and does: the rows of every version that still exists (the
-- published one is the merge base and feeds the exclusion counts), and the rows
-- of recent failed batches, which the "rows set aside" workbook reads.

CREATE OR REPLACE FUNCTION core.prune_staging(p_keep_days integer)
RETURNS TABLE (abandoned integer, batches integer, raw_rows bigint)
LANGUAGE plpgsql AS $fn$
DECLARE v_abandoned integer; v_batches integer; v_rows bigint;
BEGIN
  -- A run still "in progress" a day after it started is dead (the process that
  -- owned it restarted). Mark it failed so it is visibly over, not pending.
  UPDATE ingest.batch b
     SET state = 'FAILED',
         failure_reason = COALESCE(b.failure_reason, 'abandoned: the run never finished'),
         finished_at = now()
   WHERE b.state IN ('DISCOVERED','SCANNING','PARSING','VALIDATING','TRANSFORMING')
     AND b.started_at < now() - interval '1 day'
     AND NOT EXISTS (SELECT 1 FROM core.dataset_version v WHERE v.batch_id = b.id);
  GET DIAGNOSTICS v_abandoned = ROW_COUNT;

  WITH gone AS (
    SELECT b.id
      FROM ingest.batch b
     WHERE b.state IN ('FAILED','CANCELLED','SUPERSEDED')
       -- Counted from the START: an abandoned run is only marked FAILED now.
       AND b.started_at < now() - make_interval(days => p_keep_days)
       AND NOT EXISTS (SELECT 1 FROM core.dataset_version v WHERE v.batch_id = b.id)
       AND EXISTS (SELECT 1 FROM staging.raw_row r WHERE r.batch_id = b.id)
  ), del AS (
    DELETE FROM staging.raw_row r USING gone WHERE r.batch_id = gone.id RETURNING r.batch_id
  )
  SELECT count(DISTINCT batch_id)::int, count(*) INTO v_batches, v_rows FROM del;

  RETURN QUERY SELECT v_abandoned, v_batches, v_rows;
END $fn$;

-- READY versions older than two weeks join the prune candidates: a build nobody
-- published in 14 days is stale, and it was never removed before.
CREATE OR REPLACE FUNCTION core.prune_versions(p_keep integer)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE v record; n integer := 0; v_current bigint;
BEGIN
  SELECT current_version_id INTO v_current FROM core.dataset_pointer WHERE id = 1;

  FOR v IN
    SELECT id, batch_id FROM core.dataset_version
     WHERE (status IN ('SUPERSEDED','FAILED','BUILDING')
            OR (status = 'READY' AND built_at < now() - interval '14 days'))
       AND (v_current IS NULL OR id <> v_current)
     ORDER BY COALESCE(published_at, built_at) DESC
     OFFSET p_keep
  LOOP
    PERFORM core.drop_version_partitions(v.id);
    DELETE FROM staging.raw_row WHERE batch_id = v.batch_id;
    DELETE FROM core.dataset_version WHERE id = v.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $fn$;
