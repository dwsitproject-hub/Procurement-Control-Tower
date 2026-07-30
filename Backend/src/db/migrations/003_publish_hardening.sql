-- ============================================================================
-- Harden core.publish_version.
--
-- Defect found in local testing: the singleton row in core.dataset_pointer can be
-- removed by a cascading TRUNCATE (core.dataset_pointer -> core.dataset_version
-- -> ingest.batch). When that happened, `UPDATE core.dataset_pointer ... WHERE
-- id = 1` matched zero rows and the function returned normally — so the batch was
-- marked PUBLISHED while nothing was actually serving it.
--
-- A publish must never report success it did not perform. The function now
-- self-heals the singleton and raises if the repoint does not take.
-- ============================================================================

-- Restore the singleton if a cascade removed it.
INSERT INTO core.dataset_pointer (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION core.publish_version(p_version_id bigint, p_user uuid)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_prev    bigint;
  v_pointer integer;
  v_version integer;
BEGIN
  PERFORM 1 FROM core.dataset_version
    WHERE id = p_version_id AND status IN ('READY','PUBLISHED','SUPERSEDED') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dataset version % is not publishable', p_version_id;
  END IF;

  -- Self-heal the singleton before relying on it.
  INSERT INTO core.dataset_pointer (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

  SELECT current_version_id INTO v_prev FROM core.dataset_pointer WHERE id = 1 FOR UPDATE;

  IF v_prev IS NOT NULL AND v_prev <> p_version_id THEN
    UPDATE core.dataset_version
       SET status = 'SUPERSEDED', superseded_at = now()
     WHERE id = v_prev;
  END IF;

  UPDATE core.dataset_version
     SET status = 'PUBLISHED',
         published_at = COALESCE(published_at, now()),
         published_by = COALESCE(p_user, published_by),
         superseded_at = NULL
   WHERE id = p_version_id;
  GET DIAGNOSTICS v_version = ROW_COUNT;

  UPDATE core.dataset_pointer
     SET current_version_id = p_version_id, updated_at = now(), updated_by = p_user
   WHERE id = 1;
  GET DIAGNOSTICS v_pointer = ROW_COUNT;

  -- Fail loudly rather than leaving a version marked PUBLISHED that nothing points at.
  IF v_version <> 1 THEN
    RAISE EXCEPTION 'publish did not update dataset version % (rows=%)', p_version_id, v_version;
  END IF;
  IF v_pointer <> 1 THEN
    RAISE EXCEPTION 'publish did not repoint core.dataset_pointer (rows=%)', v_pointer;
  END IF;
END $fn$;

-- Guard the singleton against the same cascade in future: a deleted pointer row
-- is a bug, not a valid state.
ALTER TABLE core.dataset_pointer
  DROP CONSTRAINT IF EXISTS dataset_pointer_current_version_id_fkey;

ALTER TABLE core.dataset_pointer
  ADD CONSTRAINT dataset_pointer_current_version_id_fkey
  FOREIGN KEY (current_version_id) REFERENCES core.dataset_version(id)
  ON DELETE SET NULL;
