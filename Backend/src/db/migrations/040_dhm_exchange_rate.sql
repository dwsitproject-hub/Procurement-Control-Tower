-- 040 - exchange rates from Data Hub Management (DHM), replacing Coupa's.
--
-- Requested 23 Oct 2026: take exchange rates from the Data Hub instead of from
-- Coupa directly. DHM is the canonical master-data hub; PCT is a read-only
-- consumer of its `exchange_rate` master (Docs/CLIENT_INTEGRATION.md pattern C:
-- snapshot + incremental sync, no inbound writes).
--
-- ops.dhm_exchange_rate  every record as DHM last sent it, the raw `data` kept
--                        for lineage beside the four columns PCT reads. Deleted
--                        records are kept as tombstones (is_deleted), so a
--                        rate deleted in DHM leaves the FX store too.
-- ops.dhm_sync_state     one row per DHM entity: the sync cursor, the field
--                        mapping resolved from the catalog on the last run, and
--                        the outcome the Admin page shows.
--
-- ops.fx_rate_source gains source 'dhm'. The SAP rate file still writes it;
-- Coupa no longer does (its exchange_rates object left the Coupa sync), but its
-- existing rows stay until a DHM rate covers the same pair and month.

CREATE TABLE IF NOT EXISTS ops.dhm_exchange_rate (
  id             uuid        PRIMARY KEY,
  code           text,
  version        integer     NOT NULL,
  is_deleted     boolean     NOT NULL DEFAULT false,
  from_currency  text,
  to_currency    text,
  rate           numeric(24,12),
  rate_date      date,
  data           jsonb       NOT NULL,
  dhm_updated_at timestamptz NOT NULL,
  fetched_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_dhm_exchange_rate_pair
  ON ops.dhm_exchange_rate (from_currency, to_currency, rate_date);

CREATE TABLE IF NOT EXISTS ops.dhm_sync_state (
  entity          text        PRIMARY KEY,
  cursor          text,
  last_updated_at timestamptz,
  mapping         jsonb,
  last_run_at     timestamptz,
  last_status     text,
  last_error      text,
  last_trigger    text,
  records_seen    bigint      NOT NULL DEFAULT 0,
  runs            integer     NOT NULL DEFAULT 0
);

ALTER TABLE ops.fx_rate_source DROP CONSTRAINT IF EXISTS fx_rate_source_source_check;
ALTER TABLE ops.fx_rate_source
  ADD CONSTRAINT fx_rate_source_source_check CHECK (source IN ('sap', 'coupa', 'dhm'));
