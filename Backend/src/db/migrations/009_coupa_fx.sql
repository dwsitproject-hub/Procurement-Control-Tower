-- 009: Coupa exchange rates (API Payload doc v3.0, Exchange Rates API).
-- Second FX source next to the SAP rate-conversion excel: at transform time,
-- for the same currency pair and period, whichever source was updated most
-- recently wins (excel side timed by its file's source_mtime).
CREATE TABLE IF NOT EXISTS ops.coupa_exchange_rate (
  id            bigint PRIMARY KEY,
  rate          numeric(24,12) NOT NULL,
  rate_date     date,
  from_currency text NOT NULL,
  to_currency   text NOT NULL,
  created_at    timestamptz,
  updated_at    timestamptz
);
CREATE INDEX IF NOT EXISTS ix_coupa_fx_pair_date
  ON ops.coupa_exchange_rate (from_currency, to_currency, rate_date DESC);
