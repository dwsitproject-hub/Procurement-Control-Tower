-- Purge every row this database received from a Coupa tenant.
--
-- Written 21 Sep 2026, when staging's COUPA_BASE_URL was moved off
-- https://kpn-test.coupahost.com onto production. Coupa ids are per-tenant, so
-- a production row NEVER collides with the test row that shares its table: the
-- upsert cannot overwrite the old data, it can only sit next to it. Every
-- figure on the Coupa pages would then be test plus production added together,
-- for as long as nobody deleted the old rows. Hence this file.
--
-- -- What it deletes ---------------------------------------------------------
--
-- Every ops.coupa_* table, in full. There is no tenant column to filter on and
-- none is needed: the whole store came from the one tenant being left behind.
--
-- -- What it must NOT delete -------------------------------------------------
--
-- ops.fx_rate_source is SHARED with SAP (migration 010): the rate file and the
-- Coupa exchange-rate sync upsert ONE row per currency pair and period, and the
-- most recently updated source wins. So the delete here is `WHERE source =
-- 'coupa'` and nothing else -- truncating that table would take the SAP rates
-- with it.
--
-- Read the consequence before running: where a junk test rate had WON a period,
-- that row is now gone rather than reverted, because the pair keeps one row and
-- the SAP value it overwrote is not kept anywhere. The SAP rate returns at the
-- next transform, which re-upserts the whole rate file (transform.ts ~1391).
-- On staging this is the fix, not a risk: the test tenant quotes USD->IDR at
-- ~17.8 instead of ~16,800, and those rates are why the PR Pipeline reads about
-- $76 B.
--
-- -- Why the watermarks go too -----------------------------------------------
--
-- ops.coupa_watermark holds the incremental cursor per object, and the sync
-- advances it with GREATEST(...) so that a cursor can never move BACKWARDS.
-- Left in place, the first production run would ask the new tenant for "rows
-- changed since <a timestamp reached in the test tenant>" and quietly return
-- almost nothing. Deleting the rows makes the next run a cold full pull, which
-- is exactly what a tenant change needs.
--
-- -- Running it --------------------------------------------------------------
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f purge-coupa-tenant-data.sql
--
-- or through purge-coupa-tenant-data.sh, which also checks the container really
-- is pointed at the new tenant and dumps a backup first. Nothing here is
-- undoable from inside the database, so take the dump.

\set ON_ERROR_STOP on

-- Refuse to run while a sync is in flight. 0xc00fa is the lock runCoupaSync
-- takes (Backend/src/modules/coupa/sync.ts); holding it here means a poll tick
-- cannot land rows between the delete and the commit, or re-write a watermark
-- after this file has cleared it.
DO $$
BEGIN
  IF NOT pg_try_advisory_lock(786682) THEN   -- 0xc00fa
    RAISE EXCEPTION 'A Coupa sync is holding the sync lock. Wait for it to finish (Admin -> Coupa shows the run), then re-run this file.';
  END IF;
END $$;

BEGIN;

CREATE TEMP TABLE coupa_purge_report (step text, item text, rows bigint) ON COMMIT DROP;

INSERT INTO coupa_purge_report
          SELECT 'before', 'ops.coupa_raw',                count(*) FROM ops.coupa_raw
UNION ALL SELECT 'before', 'ops.coupa_sourcing_event',     count(*) FROM ops.coupa_sourcing_event
UNION ALL SELECT 'before', 'ops.coupa_supplier_response',  count(*) FROM ops.coupa_supplier_response
UNION ALL SELECT 'before', 'ops.coupa_supplier',           count(*) FROM ops.coupa_supplier
UNION ALL SELECT 'before', 'ops.coupa_po_line',            count(*) FROM ops.coupa_po_line
UNION ALL SELECT 'before', 'ops.coupa_receipt',            count(*) FROM ops.coupa_receipt
UNION ALL SELECT 'before', 'ops.coupa_invoice',            count(*) FROM ops.coupa_invoice
UNION ALL SELECT 'before', 'ops.coupa_invoice_line',       count(*) FROM ops.coupa_invoice_line
UNION ALL SELECT 'before', 'ops.coupa_payment',            count(*) FROM ops.coupa_payment
UNION ALL SELECT 'before', 'ops.coupa_exchange_rate',      count(*) FROM ops.coupa_exchange_rate
UNION ALL SELECT 'before', 'ops.coupa_watermark',          count(*) FROM ops.coupa_watermark
UNION ALL SELECT 'before', 'fx_rate_source source=coupa (deleted)', count(*) FROM ops.fx_rate_source WHERE source = 'coupa'
UNION ALL SELECT 'before', 'fx_rate_source source=sap   (KEPT)',    count(*) FROM ops.fx_rate_source WHERE source = 'sap';

\echo ''
\echo '== before =='
SELECT item, rows FROM coupa_purge_report WHERE step = 'before' ORDER BY item;

-- No foreign key points at any of these, so one statement is enough and the
-- order does not matter.
TRUNCATE ops.coupa_raw,
         ops.coupa_sourcing_event,
         ops.coupa_supplier_response,
         ops.coupa_supplier,
         ops.coupa_po_line,
         ops.coupa_receipt,
         ops.coupa_invoice,
         ops.coupa_invoice_line,
         ops.coupa_payment,
         ops.coupa_exchange_rate;

-- The one delete that is NOT a truncate. See the header.
DELETE FROM ops.fx_rate_source WHERE source = 'coupa';

-- Cold start for every object on the next run.
DELETE FROM ops.coupa_watermark;

INSERT INTO coupa_purge_report
          SELECT 'after', 'ops.coupa_raw',                count(*) FROM ops.coupa_raw
UNION ALL SELECT 'after', 'ops.coupa_sourcing_event',     count(*) FROM ops.coupa_sourcing_event
UNION ALL SELECT 'after', 'ops.coupa_supplier_response',  count(*) FROM ops.coupa_supplier_response
UNION ALL SELECT 'after', 'ops.coupa_supplier',           count(*) FROM ops.coupa_supplier
UNION ALL SELECT 'after', 'ops.coupa_po_line',            count(*) FROM ops.coupa_po_line
UNION ALL SELECT 'after', 'ops.coupa_receipt',            count(*) FROM ops.coupa_receipt
UNION ALL SELECT 'after', 'ops.coupa_invoice',            count(*) FROM ops.coupa_invoice
UNION ALL SELECT 'after', 'ops.coupa_invoice_line',       count(*) FROM ops.coupa_invoice_line
UNION ALL SELECT 'after', 'ops.coupa_payment',            count(*) FROM ops.coupa_payment
UNION ALL SELECT 'after', 'ops.coupa_exchange_rate',      count(*) FROM ops.coupa_exchange_rate
UNION ALL SELECT 'after', 'ops.coupa_watermark',          count(*) FROM ops.coupa_watermark
UNION ALL SELECT 'after', 'fx_rate_source source=coupa (deleted)', count(*) FROM ops.fx_rate_source WHERE source = 'coupa'
UNION ALL SELECT 'after', 'fx_rate_source source=sap   (KEPT)',    count(*) FROM ops.fx_rate_source WHERE source = 'sap';

\echo ''
\echo '== before -> after =='
SELECT b.item,
       b.rows AS before,
       a.rows AS after
  FROM coupa_purge_report b
  JOIN coupa_purge_report a ON a.item = b.item AND a.step = 'after'
 WHERE b.step = 'before'
 ORDER BY b.item;

-- The SAP rates must have survived, and no Coupa rate may remain.
DO $$
DECLARE kept bigint; left_over bigint;
BEGIN
  SELECT count(*) INTO kept      FROM ops.fx_rate_source WHERE source = 'sap';
  SELECT count(*) INTO left_over FROM ops.fx_rate_source WHERE source = 'coupa';
  IF left_over <> 0 THEN
    RAISE EXCEPTION 'coupa FX rows survived the delete: %', left_over;
  END IF;
  RAISE NOTICE 'SAP FX rows kept: %', kept;
END $$;

COMMIT;

SELECT pg_advisory_unlock(786682);

\echo ''
\echo 'Purged. The next Coupa sync is a COLD FULL run against whatever tenant'
\echo 'COUPA_BASE_URL now names. Trigger it from Admin -> Coupa -> Sync now,'
\echo 'then recompute so core.fx_rate picks up the new rates.'
