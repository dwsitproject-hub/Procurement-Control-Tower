-- 010: one shared FX pair store fed by BOTH sources (user decision 5 Aug 2026).
-- The SAP rate-file ingest and the Coupa exchange-rate sync upsert the same
-- table; for the same pair and period the record updated most recently wins
-- (SAP timed by the file's source_mtime, Coupa by its updated-at). The
-- versioned core.fx_rate keeps provenance so the Admin table can show it.
CREATE TABLE IF NOT EXISTS ops.fx_rate_source (
  from_currency     text NOT NULL,
  to_currency       text NOT NULL,
  period_year       integer NOT NULL,
  period_month      smallint NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  rate              numeric(24,12) NOT NULL CHECK (rate > 0),
  source            text NOT NULL CHECK (source IN ('sap','coupa')),
  source_updated_at timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_currency, to_currency, period_year, period_month)
);
ALTER TABLE core.fx_rate ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE core.fx_rate ADD COLUMN IF NOT EXISTS source_updated_at timestamptz;
