-- ============================================================================
-- Procurement Control Tower v2 — schema
-- Derived from PRD v2 Annex B. See Docs/PRD_v2_Annex_B_Database_Schema.md
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS ingest;
CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS mart;
CREATE SCHEMA IF NOT EXISTS audit;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ─────────────────────────────────────────────────────────── app: identity

CREATE TABLE app.app_user (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- DWS Hub OIDC 'sub'. The Hub guide requires >= 255 chars, and the sub is the
  -- stable key: email changes, sub does not.
  sso_subject     varchar(255) UNIQUE,
  email           citext NOT NULL UNIQUE,
  display_name    text NOT NULL,
  auth_method     text NOT NULL CHECK (auth_method IN ('sso','local')),
  is_active       boolean NOT NULL DEFAULT true,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sso_needs_subject CHECK (auth_method <> 'sso' OR sso_subject IS NOT NULL)
);

CREATE TABLE app.local_credential (
  user_id         uuid PRIMARY KEY REFERENCES app.app_user(id) ON DELETE CASCADE,
  password_hash   text NOT NULL,
  password_set_at timestamptz NOT NULL DEFAULT now(),
  totp_secret_enc bytea,
  mfa_enabled     boolean NOT NULL DEFAULT false,
  failed_attempts smallint NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  expires_at      date,
  approval_note   text
);

CREATE TABLE app.role (
  code text PRIMARY KEY,
  name text NOT NULL,
  rank smallint NOT NULL
);

CREATE TABLE app.user_role (
  user_id    uuid NOT NULL REFERENCES app.app_user(id) ON DELETE CASCADE,
  role_code  text NOT NULL REFERENCES app.role(code),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_code)
);

-- One row per granted slice. '*' means all values of that dimension.
-- A user with NO rows sees NO data — the default for a new SSO user.
CREATE TABLE app.data_scope (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES app.app_user(id) ON DELETE CASCADE,
  company_code text NOT NULL DEFAULT '*',
  plant        text NOT NULL DEFAULT '*',
  purch_org    text NOT NULL DEFAULT '*',
  granted_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, company_code, plant, purch_org)
);
CREATE INDEX ix_data_scope_user ON app.data_scope(user_id);

CREATE TABLE app.user_preference (
  user_id    uuid NOT NULL REFERENCES app.app_user(id) ON DELETE CASCADE,
  pref_key   text NOT NULL,
  pref_value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pref_key)
);

-- ─────────────────────────────────────────── app: rule config (effective-dated)

-- Every rule v1 hardcoded lives here with an effective date and an author.
CREATE TABLE app.rule_config (
  id             bigserial PRIMARY KEY,
  rule_key       text NOT NULL,
  rule_value     jsonb NOT NULL,
  effective_from date NOT NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES app.app_user(id),
  UNIQUE (rule_key, effective_from)
);
CREATE INDEX ix_rule_config_lookup ON app.rule_config(rule_key, effective_from DESC);

-- ─────────────────────────────────────────────────────── app: template contract

CREATE TABLE app.template_version (
  id         bigserial PRIMARY KEY,
  feed       text NOT NULL CHECK (feed IN ('pr','prel','po','por','gr','fx')),
  version    integer NOT NULL,
  is_active  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  note       text,
  UNIQUE (feed, version)
);
CREATE UNIQUE INDEX ux_template_active ON app.template_version(feed) WHERE is_active;

CREATE TABLE app.template_column (
  id                  bigserial PRIMARY KEY,
  template_version_id bigint NOT NULL REFERENCES app.template_version(id) ON DELETE CASCADE,
  ordinal             integer NOT NULL,
  header              text NOT NULL,
  header_norm         text NOT NULL,
  data_type           text NOT NULL,
  status              text NOT NULL CHECK (status IN ('PK','REQ','OPT','IGN','DEAD')),
  canonical_field     text,
  notes               text,
  UNIQUE (template_version_id, header_norm)
);
CREATE INDEX ix_template_column_norm ON app.template_column(header_norm);

CREATE TABLE app.template_alias (
  id                  bigserial PRIMARY KEY,
  template_version_id bigint NOT NULL REFERENCES app.template_version(id) ON DELETE CASCADE,
  canonical_field     text NOT NULL,
  alias_norm          text NOT NULL,
  UNIQUE (template_version_id, alias_norm)
);

-- Steward mappings: server-side and audited, unlike v1's per-browser localStorage
-- which let two users silently see different numbers.
CREATE TABLE app.column_mapping (
  id                  bigserial PRIMARY KEY,
  template_version_id bigint NOT NULL REFERENCES app.template_version(id) ON DELETE CASCADE,
  canonical_field     text NOT NULL,
  source_header       text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES app.app_user(id),
  note                text,
  UNIQUE (template_version_id, canonical_field)
);

-- ───────────────────────────────────────────────────────── app: notifications

CREATE TABLE app.notification_event (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('info','warning','error')),
  admin_only  boolean NOT NULL DEFAULT false,
  description text NOT NULL
);

CREATE TABLE app.notification_subscription (
  id             bigserial PRIMARY KEY,
  event_code     text NOT NULL REFERENCES app.notification_event(code),
  user_id        uuid REFERENCES app.app_user(id) ON DELETE CASCADE,
  external_email citext,
  is_external    boolean NOT NULL DEFAULT false,
  company_code   text NOT NULL DEFAULT '*',
  plant          text NOT NULL DEFAULT '*',
  purch_org      text NOT NULL DEFAULT '*',
  delivery_mode  text NOT NULL DEFAULT 'immediate' CHECK (delivery_mode IN ('immediate','digest')),
  digest_at      time,
  severity_floor text NOT NULL DEFAULT 'info' CHECK (severity_floor IN ('info','warning','error')),
  quiet_from     time,
  quiet_to       time,
  is_enabled     boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_by    uuid REFERENCES app.app_user(id),
  CONSTRAINT one_recipient CHECK ((user_id IS NULL) <> (external_email IS NULL)),
  CONSTRAINT external_needs_approval CHECK (NOT is_external OR approved_by IS NOT NULL),
  CONSTRAINT digest_needs_time CHECK (delivery_mode <> 'digest' OR digest_at IS NOT NULL)
);
CREATE INDEX ix_subscription_event ON app.notification_subscription(event_code) WHERE is_enabled;

CREATE TABLE app.notification_delivery (
  id                 bigserial PRIMARY KEY,
  subscription_id    bigint REFERENCES app.notification_subscription(id) ON DELETE SET NULL,
  event_code         text NOT NULL,
  dataset_version_id bigint,
  batch_id           bigint,
  recipient_email    citext NOT NULL,
  subject            text NOT NULL,
  body_text          text,
  status             text NOT NULL CHECK (status IN ('queued','sent','failed','suppressed','test')),
  attempt_count      smallint NOT NULL DEFAULT 0,
  smtp_response      text,
  error_message      text,
  queued_at          timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  dedupe_key         text NOT NULL
);
-- Duplicate sends are impossible even on retry.
CREATE UNIQUE INDEX ux_notification_dedupe
  ON app.notification_delivery(dedupe_key) WHERE status IN ('queued','sent');
CREATE INDEX ix_notification_recent ON app.notification_delivery(queued_at DESC);

-- ───────────────────────────────────────────────────────────── ingest: batches

CREATE TABLE ingest.batch (
  id             bigserial PRIMARY KEY,
  source_kind    text NOT NULL CHECK (source_kind IN ('synology','manual')),
  source_detail  text,
  state          text NOT NULL CHECK (state IN
                   ('DISCOVERED','SCANNING','PARSING','VALIDATING','TRANSFORMING',
                    'READY','PUBLISHED','FAILED','SUPERSEDED','CANCELLED')),
  submitted_by   uuid REFERENCES app.app_user(id),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  failure_reason text,
  bundle_hash    char(64),
  timings        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ix_batch_state ON ingest.batch(state, started_at DESC);
-- Idempotency: the same set of file hashes can never be published twice, which
-- is what makes a 30-minute poll over unchanged files inherently safe.
CREATE UNIQUE INDEX ux_batch_bundle_published
  ON ingest.batch(bundle_hash) WHERE state = 'PUBLISHED';

CREATE TABLE ingest.batch_file (
  id                  bigserial PRIMARY KEY,
  batch_id            bigint NOT NULL REFERENCES ingest.batch(id) ON DELETE CASCADE,
  original_filename   text NOT NULL,
  stored_name         text,
  sheet_name          text,
  byte_size           bigint NOT NULL,
  sha256              char(64) NOT NULL,
  source_mtime        timestamptz,
  detected_feed       text CHECK (detected_feed IN ('pr','prel','po','por','gr','fx')),
  template_version_id bigint REFERENCES app.template_version(id),
  match_outcome       text CHECK (match_outcome IN ('exact','healed','drift','unrecognised')),
  row_count           integer,
  av_scan_result      text,
  UNIQUE (batch_id, sha256)
);

CREATE TABLE ingest.validation_finding (
  id              bigserial PRIMARY KEY,
  batch_id        bigint NOT NULL REFERENCES ingest.batch(id) ON DELETE CASCADE,
  batch_file_id   bigint REFERENCES ingest.batch_file(id) ON DELETE CASCADE,
  rule_id         text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('BLOCKER','CAVEAT','WARNING','INFO')),
  feed            text,
  message         text NOT NULL,
  affected_rows   integer,
  measured        jsonb,
  disables_kpis   text[] NOT NULL DEFAULT '{}',
  drill_predicate jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_finding_batch ON ingest.validation_finding(batch_id, severity);

-- ──────────────────────────────────────────────────────────────────── staging

-- Raw rows retained per batch so row-level lineage is answerable and a
-- transformation bug can be re-run without re-reading the source files.
CREATE TABLE staging.raw_row (
  batch_id      bigint NOT NULL REFERENCES ingest.batch(id) ON DELETE CASCADE,
  batch_file_id bigint NOT NULL,
  feed          text NOT NULL,
  source_row    integer NOT NULL,
  payload       jsonb NOT NULL,
  PRIMARY KEY (batch_id, batch_file_id, source_row)
);
CREATE INDEX ix_raw_row_feed ON staging.raw_row(batch_id, feed);

-- ────────────────────────────────────────────────────────── core: versioning

CREATE TABLE core.dataset_version (
  id               bigserial PRIMARY KEY,
  batch_id         bigint NOT NULL UNIQUE REFERENCES ingest.batch(id),
  -- The business date the data describes: MAX(po document date, gr posting date).
  -- ALL aging is computed from this, never from wall-clock time.
  as_of_date       date NOT NULL,
  as_of_source     text NOT NULL DEFAULT 'data_max',
  status           text NOT NULL CHECK (status IN ('BUILDING','READY','PUBLISHED','SUPERSEDED','FAILED')),
  fx_year_resolved integer,
  fx_policy        text NOT NULL DEFAULT 'period_matched',
  -- Snapshot of every rule in force, so a figure quoted last month still
  -- reproduces even after a threshold is edited.
  rule_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  feed_row_counts  jsonb NOT NULL DEFAULT '{}'::jsonb,
  feed_row_deltas  jsonb,
  metrics          jsonb NOT NULL DEFAULT '{}'::jsonb,
  built_at         timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  published_by     uuid REFERENCES app.app_user(id),
  superseded_at    timestamptz
);
CREATE INDEX ix_dsv_published ON core.dataset_version(published_at DESC) WHERE status = 'PUBLISHED';

-- Singleton pointer. Publishing is one UPDATE of one row, which is what makes
-- publish atomic and rollback instantaneous.
CREATE TABLE core.dataset_pointer (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  current_version_id bigint REFERENCES core.dataset_version(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES app.app_user(id)
);
INSERT INTO core.dataset_pointer (id) VALUES (1);

-- ───────────────────────────────────────────────────────────── core: dimensions

CREATE TABLE core.dim_movement_type (
  movement_type     text PRIMARY KEY,
  class             text NOT NULL CHECK (class IN ('receipt','reversal','transfer','transfer_reversal')),
  sign_factor       smallint NOT NULL CHECK (sign_factor IN (1,-1)),
  counts_as_receipt boolean NOT NULL,
  description       text NOT NULL
);

CREATE TABLE core.dim_plant (
  plant        text PRIMARY KEY,
  company_code text NOT NULL,
  plant_name   text,
  first_seen   date,
  last_seen    date
);

CREATE TABLE core.dim_vendor (
  vendor_code text PRIMARY KEY,
  vendor_name text NOT NULL,
  first_seen  date,
  last_seen   date
);
CREATE INDEX ix_vendor_name_trgm ON core.dim_vendor USING gin (vendor_name gin_trgm_ops);

CREATE TABLE core.dim_material (
  material_code  text PRIMARY KEY,
  description    text,
  material_group text,
  base_uom       text,
  first_seen     date,
  last_seen      date
);
CREATE INDEX ix_material_desc_trgm ON core.dim_material USING gin (description gin_trgm_ops);

CREATE TABLE core.dim_doc_type (
  doc_type    text PRIMARY KEY,
  description text,
  is_sto      boolean NOT NULL
);

-- FX rates are versioned: a re-published bundle may carry a corrected rate file,
-- and a figure must never change retroactively.
CREATE TABLE core.fx_rate (
  dataset_version_id bigint NOT NULL REFERENCES core.dataset_version(id) ON DELETE CASCADE,
  currency_code      text NOT NULL,
  period_year        integer NOT NULL,
  period_month       smallint NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  usd_per_unit       numeric(24,12) NOT NULL CHECK (usd_per_unit > 0),
  derivation         text NOT NULL CHECK (derivation IN ('direct','inverted','triangulated')),
  pivot_currency     text,
  PRIMARY KEY (dataset_version_id, currency_code, period_year, period_month)
);
