# Annex B — Database Schema

**Parent document:** [PRD v2 — Production](PRD_v2_Production.md) · **Version** 2.0 · **Date** 30 July 2026
**Target:** PostgreSQL 16

This annex specifies the physical data model. Column semantics, sentinels and domain values come from [Annex A](PRD_v2_Annex_A_Data_Contract.md).

---

## Contents

- [B.1 Design principles](#b1-design-principles)
- [B.2 Schemas & roles](#b2-schemas--roles)
- [B.3 Application & security tables](#b3-application--security-tables)
- [B.4 Configuration & template tables](#b4-configuration--template-tables)
- [B.5 Notification tables](#b5-notification-tables)
- [B.6 Ingestion tables](#b6-ingestion-tables)
- [B.7 Staging](#b7-staging)
- [B.8 Dataset versioning](#b8-dataset-versioning)
- [B.9 Dimensions](#b9-dimensions)
- [B.10 Facts & bridge](#b10-facts--bridge)
- [B.11 Mart](#b11-mart)
- [B.12 Audit](#b12-audit)
- [B.13 Publish, rollback & retention](#b13-publish-rollback--retention)
- [B.14 Optional hardening — row-level security](#b14-optional-hardening--row-level-security)
- [B.15 Sizing & maintenance](#b15-sizing--maintenance)

---

## B.1 Design principles

1. **The dataset version is the unit of everything.** It is the publish unit, the cache key, the partition key, the rollback target and the retention unit. A version, once published, is never mutated.
2. **Facts are partitioned by `dataset_version_id`.** Every analytics query prunes to a single partition, and retention is `DROP TABLE` on a partition rather than a mass `DELETE` and its vacuum cost.
3. **Analytically significant attributes are denormalised onto the facts** — currency, document type, plant, purchasing org, material group. Dimensions supply descriptive text only. This means a figure reproduces identically even if a vendor is later renamed, which is what makes the golden-number regression suite (PRD §23.2) meaningful.
4. **Dimensions are global and type-1.** Descriptive attributes reflect the latest load. They are deliberately not versioned, because versioning descriptive text buys nothing and costs a great deal.
5. **Source lineage on every fact row** — `source_file_id`, `source_row`. This is what makes PRD objective O3 real.
6. **Nulls mean unknown; zero means zero.** No column carries a defaulted value that could be mistaken for a measurement. There is no `DEFAULT 0` on any measure.
7. **Money is `numeric`, never floating point.** Document-currency amounts and derived USD amounts are stored separately, and the derived USD is nullable so an unconvertible amount is visibly absent.
8. **Forward-only migrations.** Every migration is reviewed and applied by CI.

---

## B.2 Schemas & roles

```sql
CREATE SCHEMA app;        -- users, config, templates, notifications
CREATE SCHEMA ingest;     -- batches, files, validation findings
CREATE SCHEMA staging;    -- raw rows as received
CREATE SCHEMA core;       -- dimensions, facts, dataset versions
CREATE SCHEMA mart;       -- precomputed KPI values and chart series
CREATE SCHEMA audit;      -- append-only audit trail

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram search on descriptions

-- Roles: least privilege, separated by function
CREATE ROLE pct_migrate LOGIN PASSWORD :'migrate_pw';   -- DDL only, used by CI
CREATE ROLE pct_app     LOGIN PASSWORD :'app_pw';       -- DML, used by the API and workers
CREATE ROLE pct_readonly LOGIN PASSWORD :'ro_pw';       -- SELECT, for BI tools and support

GRANT USAGE ON SCHEMA app, ingest, staging, core, mart, audit TO pct_app, pct_readonly;

ALTER DEFAULT PRIVILEGES IN SCHEMA app, ingest, staging, core, mart
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pct_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit
  GRANT SELECT, INSERT ON TABLES TO pct_app;            -- append-only: no UPDATE, no DELETE
ALTER DEFAULT PRIVILEGES IN SCHEMA app, ingest, staging, core, mart, audit
  GRANT SELECT ON TABLES TO pct_readonly;
```

`pct_app` has no DDL rights, so an application defect can never alter the schema. `audit` grants no `UPDATE` or `DELETE` to any application role — the append-only property is enforced by the database, not by convention.

---

## B.3 Application & security tables

```sql
-- ── Users ────────────────────────────────────────────────────────────────
CREATE TABLE app.app_user (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- DWS Hub OIDC 'sub' claim. The Hub guide requires >= 255 chars, and the sub
  -- is the stable key: email changes, sub does not.
  sso_subject     varchar(255) UNIQUE,
  email           citext      NOT NULL UNIQUE,
  display_name    text        NOT NULL,
  auth_method     text        NOT NULL CHECK (auth_method IN ('sso','local')),
  is_active       boolean     NOT NULL DEFAULT true,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        REFERENCES app.app_user(id),
  deactivated_at  timestamptz,
  CONSTRAINT sso_needs_subject CHECK (auth_method <> 'sso' OR sso_subject IS NOT NULL)
);

-- Local break-glass credentials. Separate table so an SSO user has no password row at all.
CREATE TABLE app.local_credential (
  user_id           uuid        PRIMARY KEY REFERENCES app.app_user(id) ON DELETE CASCADE,
  password_hash     text        NOT NULL,             -- Argon2id
  password_set_at   timestamptz NOT NULL DEFAULT now(),
  totp_secret_enc   bytea,                            -- encrypted at rest
  mfa_enabled       boolean     NOT NULL DEFAULT false,
  failed_attempts   smallint    NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  expires_at        date        NOT NULL,             -- break-glass accounts always expire
  approved_by       uuid        NOT NULL REFERENCES app.app_user(id),
  approval_note     text        NOT NULL
);

-- ── Roles ────────────────────────────────────────────────────────────────
CREATE TABLE app.role (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  rank        smallint NOT NULL          -- for "at least this role" checks
);
INSERT INTO app.role (code, name, rank) VALUES
  ('viewer','Viewer',10), ('analyst','Analyst',20), ('manager','Manager',30),
  ('auditor','Auditor',40), ('steward','Data Steward',50), ('admin','Administrator',90);

CREATE TABLE app.user_role (
  user_id     uuid NOT NULL REFERENCES app.app_user(id) ON DELETE CASCADE,
  role_code   text NOT NULL REFERENCES app.role(code),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  uuid NOT NULL REFERENCES app.app_user(id),
  PRIMARY KEY (user_id, role_code)
);

-- ── Data scope (row-level security) ──────────────────────────────────────
-- One row per granted slice. '*' means all values of that dimension.
-- A user with NO rows here sees NO data — the default for a new SSO user.
CREATE TABLE app.data_scope (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES app.app_user(id) ON DELETE CASCADE,
  company_code  text NOT NULL DEFAULT '*',
  plant         text NOT NULL DEFAULT '*',
  purch_org     text NOT NULL DEFAULT '*',
  granted_at    timestamptz NOT NULL DEFAULT now(),
  granted_by    uuid NOT NULL REFERENCES app.app_user(id),
  UNIQUE (user_id, company_code, plant, purch_org)
);
CREATE INDEX ix_data_scope_user ON app.data_scope(user_id);

-- ── Per-user UI preferences (v1 used browser localStorage) ───────────────
CREATE TABLE app.user_preference (
  user_id     uuid NOT NULL REFERENCES app.app_user(id) ON DELETE CASCADE,
  pref_key    text NOT NULL,             -- e.g. 'detail_table_layout'
  pref_value  jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pref_key)
);
```

Sessions live in Redis (PRD §19.3) and are deliberately not stored here; only their creation and destruction are audited.

---

## B.4 Configuration & template tables

```sql
-- ── Business-rule configuration, effective-dated ─────────────────────────
-- Every rule that PRD v1 hardcoded (WBS thresholds in two places, STO suffix,
-- 60-day aging) lives here with an effective date and an author.
CREATE TABLE app.rule_config (
  id             bigserial PRIMARY KEY,
  rule_key       text NOT NULL,
  rule_value     jsonb NOT NULL,
  effective_from date NOT NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES app.app_user(id),
  UNIQUE (rule_key, effective_from)
);
CREATE INDEX ix_rule_config_lookup ON app.rule_config(rule_key, effective_from DESC);

-- Seeded values (see PRD §12)
-- wbs.material_threshold_idr   30000000            -- D1 resolved: admin-editable at runtime
-- wbs.service_threshold_idr    150000000           -- D1 resolved: admin-editable at runtime
-- wbs.basis                    "per_item"          -- D1 resolved 30 Jul 2026
-- sto.doctype_suffix           "70"
-- aging.threshold_days         60
-- fx.policy                    "period_matched"    -- D3 default, pending confirmation
-- release.no_strategy_policy   "flag_only"         -- D2 resolved 30 Jul 2026
-- asof.source                  "data_max"
-- freshness.ageing_days        3
-- freshness.stale_days         7

-- ── Template contracts ───────────────────────────────────────────────────
CREATE TABLE app.template_version (
  id            bigserial PRIMARY KEY,
  feed          text NOT NULL CHECK (feed IN ('pr','prel','po','por','gr','fx')),
  version       integer NOT NULL,
  is_active     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES app.app_user(id),
  note          text,
  UNIQUE (feed, version)
);
CREATE UNIQUE INDEX ux_template_active ON app.template_version(feed) WHERE is_active;

CREATE TABLE app.template_column (
  id                  bigserial PRIMARY KEY,
  template_version_id bigint NOT NULL REFERENCES app.template_version(id) ON DELETE CASCADE,
  ordinal             integer NOT NULL,
  header              text NOT NULL,           -- as it appears in the file
  header_norm         text NOT NULL,           -- lowercase, non-alphanumerics stripped
  data_type           text NOT NULL CHECK (data_type IN ('str','int','dec','date','time','bool','enum')),
  status              text NOT NULL CHECK (status IN ('PK','REQ','OPT','IGN','DEAD')),
  nullable            boolean NOT NULL DEFAULT true,
  canonical_field     text,                    -- target column in staging/core
  notes               text,
  UNIQUE (template_version_id, header_norm)
);
CREATE INDEX ix_template_column_norm ON app.template_column(header_norm);

-- Known header variants that auto-heal (e.g. Price unit <-> Per)
CREATE TABLE app.template_alias (
  id                  bigserial PRIMARY KEY,
  template_version_id bigint NOT NULL REFERENCES app.template_version(id) ON DELETE CASCADE,
  canonical_field     text NOT NULL,
  alias_norm          text NOT NULL,
  UNIQUE (template_version_id, alias_norm)
);

-- Steward-created mappings. v1 stored these per browser in localStorage, so two
-- users could silently see different numbers. Now they are server-side and audited.
CREATE TABLE app.column_mapping (
  id                  bigserial PRIMARY KEY,
  template_version_id bigint NOT NULL REFERENCES app.template_version(id) ON DELETE CASCADE,
  canonical_field     text NOT NULL,
  source_header       text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES app.app_user(id),
  note                text,
  UNIQUE (template_version_id, canonical_field)
);
```

---

## B.5 Notification tables

```sql
CREATE TABLE app.notification_event (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('info','warning','error')),
  admin_only    boolean NOT NULL DEFAULT false,   -- users cannot self-subscribe
  description   text NOT NULL
);
INSERT INTO app.notification_event (code, name, severity, admin_only, description) VALUES
  ('data.published',              'New data published',        'info',    false, 'A new dataset version became active'),
  ('data.published.with_caveats', 'Published with caveats',    'warning', false, 'Published while CAVEAT findings are active'),
  ('ingest.failed',               'Ingestion failed',          'error',   true,  'A batch reached FAILED'),
  ('ingest.template_drift',       'Template drift detected',   'error',   true,  'A required column was unresolvable or unexpected columns appeared'),
  ('ingest.incomplete_bundle',    'Incomplete file bundle',    'warning', true,  'A poll found a partial file set'),
  ('ingest.stalled',              'Ingestion stalled',         'error',   true,  'Bundle incomplete for N consecutive cycles'),
  ('ingest.source_unavailable',   'Source unavailable',        'error',   true,  'Synology share unreachable'),
  ('data.stale',                  'Data is stale',             'warning', false, 'as-of date older than the stale threshold'),
  ('data.rolled_back',            'Dataset rolled back',       'warning', true,  'An administrator rolled back a version');

CREATE TABLE app.notification_subscription (
  id              bigserial PRIMARY KEY,
  event_code      text NOT NULL REFERENCES app.notification_event(code),
  -- Exactly one of user_id / external_email must be set
  user_id         uuid REFERENCES app.app_user(id) ON DELETE CASCADE,
  external_email  citext,
  is_external     boolean NOT NULL DEFAULT false,
  -- Scope filter: only notify for datasets touching this slice ('*' = any)
  company_code    text NOT NULL DEFAULT '*',
  plant           text NOT NULL DEFAULT '*',
  purch_org       text NOT NULL DEFAULT '*',
  delivery_mode   text NOT NULL DEFAULT 'immediate' CHECK (delivery_mode IN ('immediate','digest')),
  digest_at       time,                            -- required when mode = 'digest'
  severity_floor  text NOT NULL DEFAULT 'info' CHECK (severity_floor IN ('info','warning','error')),
  quiet_from      time,
  quiet_to        time,
  is_enabled      boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES app.app_user(id),
  approved_by     uuid REFERENCES app.app_user(id),   -- required for external
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
  status             text NOT NULL CHECK (status IN ('queued','sent','failed','suppressed','test')),
  attempt_count      smallint NOT NULL DEFAULT 0,
  smtp_response      text,
  error_message      text,
  queued_at          timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  -- Deduplication: one send per event x version x recipient
  dedupe_key         text NOT NULL
);
CREATE UNIQUE INDEX ux_notification_dedupe
  ON app.notification_delivery(dedupe_key) WHERE status IN ('queued','sent');
CREATE INDEX ix_notification_recent ON app.notification_delivery(queued_at DESC);

CREATE TABLE app.smtp_config (
  id           smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- singleton
  host         text NOT NULL,
  port         integer NOT NULL,
  secure_mode  text NOT NULL CHECK (secure_mode IN ('none','starttls','tls')),
  username     text,
  password_enc bytea,                        -- write-only via API; never returned
  from_address text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid NOT NULL REFERENCES app.app_user(id)
);
```

---

## B.6 Ingestion tables

```sql
CREATE TABLE ingest.batch (
  id             bigserial PRIMARY KEY,
  source_kind    text NOT NULL CHECK (source_kind IN ('synology','manual')),
  source_detail  text,                        -- share path, or upload session id
  state          text NOT NULL CHECK (state IN
                   ('DISCOVERED','SCANNING','PARSING','VALIDATING','TRANSFORMING',
                    'READY','PUBLISHED','FAILED','SUPERSEDED','CANCELLED')),
  submitted_by   uuid REFERENCES app.app_user(id),   -- NULL for automatic
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  failure_reason text,
  -- Set of source file hashes, used for the idempotency no-op check
  bundle_hash    char(64),
  timings        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- per-stage durations
  CONSTRAINT manual_has_user CHECK (source_kind <> 'manual' OR submitted_by IS NOT NULL)
);
CREATE INDEX ix_batch_state ON ingest.batch(state, started_at DESC);
CREATE UNIQUE INDEX ux_batch_bundle_published
  ON ingest.batch(bundle_hash) WHERE state = 'PUBLISHED';

CREATE TABLE ingest.batch_file (
  id                  bigserial PRIMARY KEY,
  batch_id            bigint NOT NULL REFERENCES ingest.batch(id) ON DELETE CASCADE,
  original_filename   text NOT NULL,          -- displayed escaped; never a path component
  stored_name         text,                   -- generated UUID, manual uploads only
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
  id            bigserial PRIMARY KEY,
  batch_id      bigint NOT NULL REFERENCES ingest.batch(id) ON DELETE CASCADE,
  batch_file_id bigint REFERENCES ingest.batch_file(id) ON DELETE CASCADE,
  rule_id       text NOT NULL,                -- 'V-S02', 'V-M01', 'V-B08', ...
  severity      text NOT NULL CHECK (severity IN ('BLOCKER','CAVEAT','WARNING','INFO')),
  feed          text,
  message       text NOT NULL,
  affected_rows integer,
  measured      jsonb,                        -- e.g. {"expected":">=50%","actual":"0.60%"}
  -- Predicate that reproduces the affected rows for drill-through
  drill_predicate jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_finding_batch ON ingest.validation_finding(batch_id, severity);
```

`ux_batch_bundle_published` is the idempotency guard from PRD §10.2: the same set of file hashes can never be published twice, so a 30-minute poll over unchanged files is inherently safe.

---

## B.7 Staging

Raw rows are retained per version so PRD §14.3 row-level lineage is answerable and so a transformation bug can be re-run without re-reading the source files.

```sql
CREATE TABLE staging.raw_row (
  batch_id      bigint NOT NULL REFERENCES ingest.batch(id) ON DELETE CASCADE,
  batch_file_id bigint NOT NULL,
  feed          text   NOT NULL,
  source_row    integer NOT NULL,             -- 1-based row number in the sheet
  payload       jsonb  NOT NULL,              -- canonical field -> raw value
  PRIMARY KEY (batch_id, batch_file_id, source_row)
) PARTITION BY LIST (batch_id);
```

Partitions are created by the pipeline at batch start and dropped by retention:

```sql
CREATE OR REPLACE FUNCTION staging.create_batch_partition(p_batch_id bigint)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS staging.raw_row_b%s PARTITION OF staging.raw_row
       FOR VALUES IN (%s)', p_batch_id, p_batch_id);
END $$;
```

Loading uses `COPY` into the partition directly. Files are streamed, never fully materialised (PRD §20.2).

---

## B.8 Dataset versioning

```sql
CREATE TABLE core.dataset_version (
  id                  bigserial PRIMARY KEY,
  batch_id            bigint NOT NULL REFERENCES ingest.batch(id),
  -- The business date the data describes: MAX(po.document_date, gr.posting_date).
  -- ALL aging is computed from this, never from wall-clock time (PRD §12.8).
  as_of_date          date NOT NULL,
  as_of_source        text NOT NULL DEFAULT 'data_max' CHECK (as_of_source IN ('data_max','publish_time')),
  status              text NOT NULL CHECK (status IN ('BUILDING','READY','PUBLISHED','SUPERSEDED','FAILED')),
  fx_year_resolved    integer,                -- year anchored for a yearless rate file (Annex A §A.7.2)
  fx_policy           text NOT NULL,
  -- Snapshot of every rule value in force, so the version is self-describing
  -- and a figure can always be explained without archaeology.
  rule_snapshot       jsonb NOT NULL,
  feed_row_counts     jsonb NOT NULL,         -- {"pr":20110,"po":20804,...}
  feed_row_deltas     jsonb,                  -- vs previous published version
  built_at            timestamptz NOT NULL DEFAULT now(),
  published_at        timestamptz,
  published_by        uuid REFERENCES app.app_user(id),
  superseded_at       timestamptz,
  UNIQUE (batch_id)
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
```

---

## B.9 Dimensions

Global, type-1, upserted on each load. Descriptive only — every attribute that affects a figure is denormalised onto the fact.

```sql
CREATE TABLE core.dim_plant (
  plant         text PRIMARY KEY,
  company_code  text NOT NULL,
  plant_name    text,
  area          text,
  first_seen    date NOT NULL,
  last_seen     date NOT NULL
);

CREATE TABLE core.dim_vendor (
  vendor_code   text PRIMARY KEY,
  vendor_name   text NOT NULL,
  first_seen    date NOT NULL,
  last_seen     date NOT NULL
);
CREATE INDEX ix_vendor_name_trgm ON core.dim_vendor USING gin (vendor_name gin_trgm_ops);

CREATE TABLE core.dim_material (
  material_code  text PRIMARY KEY,
  description    text,
  material_group text,
  base_uom       text,
  first_seen     date NOT NULL,
  last_seen      date NOT NULL
);
CREATE INDEX ix_material_desc_trgm ON core.dim_material USING gin (description gin_trgm_ops);

CREATE TABLE core.dim_material_group (
  material_group text PRIMARY KEY,
  description    text,
  category_l1    text,
  category_l2    text            -- chemical level-2 grouping used by the Category view
);

CREATE TABLE core.dim_purch_org   (purch_org  text PRIMARY KEY, description text);
CREATE TABLE core.dim_purch_group (purch_group text PRIMARY KEY, description text);

CREATE TABLE core.dim_doc_type (
  doc_type     text PRIMARY KEY,
  description  text,
  -- Derived from the configured suffix rule, stored so the classification of a
  -- published version is inspectable rather than recomputed.
  is_sto       boolean NOT NULL
);

-- ── Movement-type register (Annex A §A.6.1) ──────────────────────────────
-- An unregistered movement type is a BLOCKER. Nothing is ever guessed.
CREATE TABLE core.dim_movement_type (
  movement_type      text PRIMARY KEY,
  class              text NOT NULL CHECK (class IN ('receipt','reversal','transfer','transfer_reversal')),
  sign_factor        smallint NOT NULL CHECK (sign_factor IN (1,-1)),
  counts_as_receipt  boolean NOT NULL,
  description        text NOT NULL
);
INSERT INTO core.dim_movement_type VALUES
  ('101','receipt',           1, true,  'Goods receipt against purchase order'),
  ('102','reversal',         -1, true,  'Reversal of goods receipt'),
  ('122','reversal',         -1, true,  'Return delivery (registered; absent from current data)'),
  ('641','transfer',          1, false, 'Transfer posting to stock in transit (STO)'),
  ('642','transfer_reversal',-1, false, 'Reversal of transfer to stock in transit');

CREATE TABLE core.dim_currency (
  currency_code text PRIMARY KEY,
  is_local      boolean NOT NULL DEFAULT false
);
INSERT INTO core.dim_currency VALUES
  ('IDR',true),('USD',false),('CNY',false),('CNH',false),('EUR',false),('SGD',false),
  ('MYR',false),('GBP',false),('AUD',false),('CAD',false),('CHF',false),('HKD',false),
  ('INR',false),('JPY',false),('KRW',false);

-- ── FX rates, per dataset version ────────────────────────────────────────
-- Versioned because a re-published bundle may carry a corrected rate file, and a
-- figure must never change retroactively.
CREATE TABLE core.fx_rate (
  dataset_version_id bigint NOT NULL REFERENCES core.dataset_version(id) ON DELETE CASCADE,
  currency_code      text   NOT NULL REFERENCES core.dim_currency(currency_code),
  period_year        integer NOT NULL,
  period_month       smallint NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  usd_per_unit       numeric(24,12) NOT NULL CHECK (usd_per_unit > 0),
  derivation         text NOT NULL CHECK (derivation IN ('direct','inverted','triangulated')),
  pivot_currency     text,                   -- set when derivation = 'triangulated'
  PRIMARY KEY (dataset_version_id, currency_code, period_year, period_month)
);
```

---

## B.10 Facts & bridge

All facts are `PARTITION BY LIST (dataset_version_id)`. The partition key is part of every primary key, as PostgreSQL requires.

### B.10.1 PR items

```sql
CREATE TABLE core.fact_pr_item (
  dataset_version_id bigint  NOT NULL,
  pr_no              text    NOT NULL,
  pr_item            integer NOT NULL,

  -- Descriptive
  short_text         text,
  material_code      text,                    -- NULL => service item (WBS discriminator)
  material_group     text,
  requisitioner      text,                    -- personal data: restricted display
  created_by         text,                    -- personal data: restricted display
  plant              text    NOT NULL,
  company_code       text    NOT NULL,
  purch_org          text    NOT NULL,
  purch_group        text,
  doc_type           text,

  -- Measures (IDR at source)
  qty_requested      numeric(18,3),
  uom                text,
  valuation_price    numeric(18,2),
  total_value_idr    numeric(18,2),           -- NULL if absent; 0 is a real value (20.9% of rows)
  total_value_usd    numeric(18,2),           -- NULL when unconvertible — never 0

  -- Dates
  requisition_date   date,
  release_date       date,
  -- Raw as exported. NOT a need-by date in the current feed: equals release_date
  -- on 99.40% of rows (Annex A §A.10 / V-M01).
  deliv_date_raw     date,
  -- Populated only when a genuine delivery date is available (SAP EBAN-LFDAT).
  -- Demand Realism reads this column and nothing else.
  need_by_date       date,

  -- Flags
  urgency            smallint,
  priority           smallint,
  is_deleted         boolean NOT NULL,
  release_indicator  text,
  wbs_element        text,

  -- Derived: approval
  release_l1_date    date,
  release_l2_date    date,
  release_final_date date,
  next_approver      text,
  is_fully_released  boolean NOT NULL,

  -- Derived: WBS policy (rule snapshot on the version explains the values)
  wbs_required       boolean NOT NULL,
  wbs_status         text    NOT NULL CHECK (wbs_status IN ('compliant','violation','not_required','indeterminate')),

  -- Derived: status and aging (aging always vs dataset_version.as_of_date)
  status             text    NOT NULL,
  aging_days         integer,

  -- Lineage
  source_file_id     bigint  NOT NULL,
  source_row         integer NOT NULL,

  PRIMARY KEY (dataset_version_id, pr_no, pr_item)
) PARTITION BY LIST (dataset_version_id);

CREATE INDEX ix_pri_scope   ON core.fact_pr_item(dataset_version_id, company_code, plant, purch_org);
CREATE INDEX ix_pri_status  ON core.fact_pr_item(dataset_version_id, status);
CREATE INDEX ix_pri_reqdate ON core.fact_pr_item(dataset_version_id, requisition_date);
CREATE INDEX ix_pri_wbs     ON core.fact_pr_item(dataset_version_id, wbs_status)
                              WHERE wbs_status = 'violation';
```

### B.10.2 PO lines

First-class, not a satellite of PR. **43.7% of lines have no PR reference** and must be fully analysable (PRD §12.1).

```sql
CREATE TABLE core.fact_po_line (
  dataset_version_id bigint  NOT NULL,
  po_no              text    NOT NULL,
  po_item            integer NOT NULL,

  -- PR link; NULL for direct POs. Note '0' sentinel already normalised to NULL.
  pr_no              text,
  pr_item            integer,
  link_provenance    text CHECK (link_provenance IN ('po_side','pr_side',NULL)),
  link_status        text CHECK (link_status IN ('resolved','dangling',NULL)),

  -- Descriptive
  short_text         text,
  material_code      text,
  material_group     text,
  vendor_code        text,
  vendor_name        text,
  plant              text NOT NULL,
  company_code       text NOT NULL,
  purch_org          text NOT NULL,
  purch_group        text,
  doc_type           text NOT NULL,
  is_sto             boolean NOT NULL,        -- doc_type ends with configured suffix
  req_tracking_no    text,                    -- originating purchase PO for STO lines
  acct_assign_cat    text,
  item_category      text,
  storage_location   text,
  created_by         text,                    -- personal data: restricted display

  -- Quantities and price
  order_qty          numeric(18,3),
  order_unit         text,
  net_price          numeric(18,4),
  price_unit         integer NOT NULL DEFAULT 1 CHECK (price_unit > 0),
  -- Unit price MUST divide by price_unit: 398 lines have price_unit > 1
  unit_price         numeric(18,6) GENERATED ALWAYS AS
                       (CASE WHEN price_unit > 0 THEN net_price / price_unit END) STORED,

  -- Values in document currency + derived USD (NULL when unconvertible)
  currency_code      text NOT NULL,           -- normalised: US$ => USD
  net_order_value    numeric(18,2),
  net_order_value_usd numeric(18,2),
  still_deliver_qty  numeric(18,3),
  still_deliver_val  numeric(18,2),
  still_deliver_val_usd numeric(18,2),
  still_invoice_qty  numeric(18,3),
  still_invoice_val  numeric(18,2),
  still_invoice_val_usd numeric(18,2),
  fx_period_year     integer,
  fx_period_month    smallint,
  fx_derivation      text,                    -- direct / inverted / triangulated / fallback_latest

  -- Dates
  document_date      date NOT NULL,
  delivery_date      date,                    -- EINDT; equals document_date on 37.4% of lines
  eindt_equals_docdate boolean GENERATED ALWAYS AS (delivery_date = document_date) STORED,

  -- Release / deletion (Annex A §A.4.1)
  release_indicator  text,
  release_group      text,
  release_state      text,
  deletion_indicator text,
  is_deleted         boolean NOT NULL,        -- from deletion_indicator = 'L', NOT from blank release_indicator
  po_release_state   text NOT NULL CHECK (po_release_state IN
                       ('approved','pending','not_subject_to_release','deleted')),
  -- D2 = flag_only: these lines stay in the pipeline and are marked, never
  -- reclassified as approved/pending/deleted. Rendered as a "flag" marker on
  -- every surface. 241 lines / 89 POs / IDR 1.51bn in the current data.
  release_exempt     boolean GENERATED ALWAYS AS
                       (po_release_state = 'not_subject_to_release') STORED,
  is_incomplete      boolean NOT NULL,        -- Incomplete = 'X' => HOLD PO

  -- Derived: approval
  release_final_date date,
  next_approver      text,

  -- Derived: receipts (movement type 101 only for the date; signed netting for qty)
  receipt_date       date,
  receipt_qty_net    numeric(18,3),
  receipt_count      integer NOT NULL DEFAULT 0,
  reversal_count     integer NOT NULL DEFAULT 0,
  transit_qty_net    numeric(18,3),           -- from 641/642, kept separate
  gr_completion_pct  numeric(6,2),
  join_method        text NOT NULL DEFAULT 'line_key'
                       CHECK (join_method IN ('line_key','material_fallback','doc_fallback','none')),

  -- Derived: status, cycle times, aging
  status             text NOT NULL,
  aging_days         integer,
  po_approval_days   integer,
  sourcing_days      integer,
  delivery_days      integer,
  delivery_vs_promise_days integer,
  is_retro_po        boolean NOT NULL DEFAULT false,

  -- Lineage
  source_file_id     bigint  NOT NULL,
  source_row         integer NOT NULL,

  PRIMARY KEY (dataset_version_id, po_no, po_item)
) PARTITION BY LIST (dataset_version_id);

CREATE INDEX ix_pol_scope    ON core.fact_po_line(dataset_version_id, company_code, plant, purch_org);
CREATE INDEX ix_pol_docdate  ON core.fact_po_line(dataset_version_id, document_date);
CREATE INDEX ix_pol_vendor   ON core.fact_po_line(dataset_version_id, vendor_code);
CREATE INDEX ix_pol_material ON core.fact_po_line(dataset_version_id, material_code);
CREATE INDEX ix_pol_status   ON core.fact_po_line(dataset_version_id, status);
CREATE INDEX ix_pol_pr       ON core.fact_po_line(dataset_version_id, pr_no, pr_item)
                               WHERE pr_no IS NOT NULL;
-- Partial index for the spend/price analytics population (STO excluded)
CREATE INDEX ix_pol_purchase ON core.fact_po_line(dataset_version_id, document_date)
                               WHERE NOT is_sto AND NOT is_deleted;
-- Small partial index backing the V-B10 Data Check drill and the flag marker
CREATE INDEX ix_pol_rel_exempt ON core.fact_po_line(dataset_version_id, po_no)
                                 WHERE release_exempt;
```

### B.10.3 GR postings

```sql
CREATE TABLE core.fact_gr_posting (
  dataset_version_id bigint  NOT NULL,
  material_doc       text    NOT NULL,
  material_doc_item  integer NOT NULL,
  po_no              text    NOT NULL,
  po_item            integer NOT NULL,

  movement_type      text    NOT NULL REFERENCES core.dim_movement_type(movement_type),
  posting_class      text    NOT NULL,        -- copied from the register for query speed
  counts_as_receipt  boolean NOT NULL,

  posting_date       date    NOT NULL,
  entry_date         date,
  document_date      date,

  -- Sign is DERIVED from movement type, never trusted from the source
  qty_entry_abs      numeric(18,3) NOT NULL,
  signed_qty         numeric(18,3) NOT NULL,
  unit_of_entry      text,
  amount_local       numeric(18,2),

  material_code      text,
  material_desc      text,
  plant              text NOT NULL,
  company_code       text NOT NULL,
  storage_location   text,
  batch              text,
  vendor_code        text,
  posted_by          text,                    -- GR 'User Name': personal data, restricted

  source_file_id     bigint  NOT NULL,
  source_row         integer NOT NULL,

  PRIMARY KEY (dataset_version_id, material_doc, material_doc_item)
) PARTITION BY LIST (dataset_version_id);

CREATE INDEX ix_gr_poline  ON core.fact_gr_posting(dataset_version_id, po_no, po_item);
CREATE INDEX ix_gr_posting ON core.fact_gr_posting(dataset_version_id, posting_date);
-- The receipt-date computation reads only this population
CREATE INDEX ix_gr_receipt ON core.fact_gr_posting(dataset_version_id, po_no, po_item, posting_date)
                             WHERE movement_type = '101';
```

### B.10.4 Release events

```sql
CREATE TABLE core.fact_pr_release (
  dataset_version_id bigint  NOT NULL,
  pr_no              text    NOT NULL,
  pr_item            integer NOT NULL,
  rel_seq            smallint NOT NULL,
  rel_code           text    NOT NULL,
  pic_release        text    NOT NULL,        -- role name: safe to display
  login_name         text,                    -- personal data: restricted
  status             text    NOT NULL,        -- Release / Outstanding
  approve_date       date,                    -- NULL => pending at this level
  approve_time       time,
  -- TRUE when the row's identifiers were forward-filled from its parent
  -- (Annex A §A.3.1). Surfaced in lineage so the inference is never invisible.
  was_continuation   boolean NOT NULL DEFAULT false,
  plant              text,
  company_code       text,
  purch_org          text,
  source_file_id     bigint  NOT NULL,
  source_row         integer NOT NULL,
  PRIMARY KEY (dataset_version_id, pr_no, pr_item, rel_seq)
) PARTITION BY LIST (dataset_version_id);

CREATE INDEX ix_prrel_pending ON core.fact_pr_release(dataset_version_id, pic_release)
                                WHERE approve_date IS NULL;

CREATE TABLE core.fact_po_release (
  dataset_version_id bigint  NOT NULL,
  po_no              text    NOT NULL,
  rel_seq            smallint NOT NULL,
  rel_code           text    NOT NULL,
  pic_release        text    NOT NULL,
  login_name         text,                    -- personal data: restricted
  approve_date       date,
  approve_time       time,
  po_date            date,
  po_create_date     date,
  vendor_code        text,
  vendor_name        text,
  company_code       text NOT NULL,
  purch_org          text NOT NULL,
  currency_code      text NOT NULL,
  amount             numeric(18,2),
  amount_usd         numeric(18,2),
  source_file_id     bigint  NOT NULL,
  source_row         integer NOT NULL,
  PRIMARY KEY (dataset_version_id, po_no, rel_seq, rel_code)
) PARTITION BY LIST (dataset_version_id);

CREATE INDEX ix_porel_pending ON core.fact_po_release(dataset_version_id, pic_release)
                                WHERE approve_date IS NULL;
```

### B.10.5 PR ↔ PO bridge

```sql
CREATE TABLE core.bridge_pr_po (
  dataset_version_id bigint  NOT NULL,
  pr_no              text    NOT NULL,
  pr_item            integer NOT NULL,
  po_no              text    NOT NULL,
  po_item            integer NOT NULL,
  link_provenance    text    NOT NULL CHECK (link_provenance IN ('po_side','pr_side')),
  -- Split sourcing: 645 PR items map to >1 PO line, max 33
  split_seq          smallint NOT NULL,
  split_total        smallint NOT NULL,
  PRIMARY KEY (dataset_version_id, pr_no, pr_item, po_no, po_item)
) PARTITION BY LIST (dataset_version_id);

CREATE INDEX ix_bridge_po ON core.bridge_pr_po(dataset_version_id, po_no, po_item);
CREATE INDEX ix_bridge_split ON core.bridge_pr_po(dataset_version_id, pr_no, pr_item)
                               WHERE split_total > 1;
```

### B.10.6 Partition creation

```sql
CREATE OR REPLACE FUNCTION core.create_version_partitions(p_version_id bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fact_pr_item','fact_po_line','fact_gr_posting',
                           'fact_pr_release','fact_po_release','bridge_pr_po'] LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS core.%I_v%s PARTITION OF core.%I FOR VALUES IN (%s)',
      t, p_version_id, t, p_version_id);
  END LOOP;
END $$;
```

### B.10.7 Current-version views

The application queries these, never the base tables, so no code path can accidentally read an unpublished or superseded version.

```sql
CREATE VIEW core.v_po_line AS
SELECT f.* FROM core.fact_po_line f
JOIN core.dataset_pointer p ON p.id = 1 AND f.dataset_version_id = p.current_version_id;
-- ... equivalent views for each fact and the bridge
```

---

## B.11 Mart

Aggregates are computed once at publish time. This is what makes read cost independent of user count (PRD §20.2).

```sql
-- ── KPI values ───────────────────────────────────────────────────────────
CREATE TABLE mart.kpi_value (
  dataset_version_id bigint NOT NULL REFERENCES core.dataset_version(id) ON DELETE CASCADE,
  kpi_id             text   NOT NULL,         -- 'demand_realism', 'expedite_effectiveness', ...
  -- '*' means "not sliced by this dimension"
  company_code       text NOT NULL DEFAULT '*',
  plant              text NOT NULL DEFAULT '*',
  purch_org          text NOT NULL DEFAULT '*',

  status             text NOT NULL CHECK (status IN ('ok','insufficient_sample','disabled','unavailable')),
  value_num          numeric(24,6),           -- NULL unless status = 'ok'
  numerator          numeric(24,6),
  denominator        numeric(24,6),
  sample_size        integer,
  unit               text,                    -- 'ratio','percent','days','usd','idr','count'
  currency_basis     text,                    -- 'usd_strict','per_currency','idr_based'
  -- Why a KPI is not 'ok' — rendered verbatim in the card tooltip
  status_reason      text,
  -- Reproduces the exact rows behind this figure
  drill_predicate    jsonb,

  PRIMARY KEY (dataset_version_id, kpi_id, company_code, plant, purch_org)
);

-- ── Chart series ─────────────────────────────────────────────────────────
-- Storing the drill predicate alongside the aggregate is what makes
-- "drill count == chart count" true by construction (PRD §13.8).
CREATE TABLE mart.chart_series (
  id                 bigserial PRIMARY KEY,
  dataset_version_id bigint NOT NULL REFERENCES core.dataset_version(id) ON DELETE CASCADE,
  chart_id           text   NOT NULL,
  company_code       text NOT NULL DEFAULT '*',
  plant              text NOT NULL DEFAULT '*',
  purch_org          text NOT NULL DEFAULT '*',
  series_key         text NOT NULL,           -- e.g. 'ordered' / 'received'
  bucket_key         text NOT NULL,           -- e.g. '2026-03'
  bucket_label       text NOT NULL,           -- e.g. 'Mar 2026'
  bucket_ordinal     integer NOT NULL,
  value_num          numeric(24,6),
  row_count          integer NOT NULL,
  unit               text,
  currency_basis     text,
  drill_predicate    jsonb NOT NULL,
  UNIQUE (dataset_version_id, chart_id, company_code, plant, purch_org, series_key, bucket_key)
);
CREATE INDEX ix_chart_lookup ON mart.chart_series
  (dataset_version_id, chart_id, company_code, plant, purch_org, bucket_ordinal);

-- ── Aging bands for the Open Items tab ───────────────────────────────────
CREATE TABLE mart.agg_aging_band (
  dataset_version_id bigint NOT NULL REFERENCES core.dataset_version(id) ON DELETE CASCADE,
  grain              text NOT NULL CHECK (grain IN ('pr_item','po_line')),
  status             text NOT NULL,
  band               text NOT NULL,           -- '0-30','31-60','61-90','91-180','180+'
  company_code       text NOT NULL,
  plant              text NOT NULL,
  purch_org          text NOT NULL,
  doc_count          integer NOT NULL,
  line_count         integer NOT NULL,
  value_idr          numeric(24,2),
  value_usd          numeric(24,2),
  drill_predicate    jsonb NOT NULL,
  PRIMARY KEY (dataset_version_id, grain, status, band, company_code, plant, purch_org)
);

-- ── Vendor spend, per currency (never summed raw across currencies) ───────
CREATE TABLE mart.agg_vendor_spend (
  dataset_version_id bigint NOT NULL REFERENCES core.dataset_version(id) ON DELETE CASCADE,
  vendor_code        text NOT NULL,
  currency_code      text NOT NULL,
  period_month       date NOT NULL,           -- first of month
  company_code       text NOT NULL,
  plant              text NOT NULL,
  purch_org          text NOT NULL,
  line_count         integer NOT NULL,
  spend_doc_ccy      numeric(24,2) NOT NULL,
  spend_usd          numeric(24,2),           -- NULL when unconvertible
  PRIMARY KEY (dataset_version_id, vendor_code, currency_code, period_month,
               company_code, plant, purch_org)
);
```

Aggregating **per currency first** and only then converting is the physical expression of the strict no-silent-conversion rule: a NULL `spend_usd` on one currency row makes the incompleteness visible instead of quietly understating a total.

---

## B.12 Audit

```sql
CREATE TABLE audit.audit_log (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES app.app_user(id),
  actor_email   citext,                       -- denormalised: survives user deletion
  actor_ip      inet,
  user_agent    text,
  action        text NOT NULL,                -- 'auth.login','dataset.publish','scope.grant',...
  object_type   text,
  object_id     text,
  outcome       text NOT NULL CHECK (outcome IN ('success','failure','denied')),
  detail        jsonb,                        -- before/after for config changes
  request_id    text,
  -- Hash chain: any deletion or edit of a prior row breaks verification
  prev_hash     char(64),
  row_hash      char(64) NOT NULL
);
CREATE INDEX ix_audit_time   ON audit.audit_log(occurred_at DESC);
CREATE INDEX ix_audit_actor  ON audit.audit_log(actor_user_id, occurred_at DESC);
CREATE INDEX ix_audit_action ON audit.audit_log(action, occurred_at DESC);

-- Enforce append-only at the table level, in addition to the role grants
CREATE RULE audit_no_update AS ON UPDATE TO audit.audit_log DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit.audit_log DO INSTEAD NOTHING;
```

`row_hash = sha256(prev_hash || occurred_at || actor_email || action || object_id || outcome || detail)`, computed in the application. A scheduled job verifies the chain and alerts on a break.

---

## B.13 Publish, rollback & retention

```sql
-- ── Publish: atomic pointer swap ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION core.publish_version(p_version_id bigint, p_user uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_prev bigint;
BEGIN
  PERFORM 1 FROM core.dataset_version
    WHERE id = p_version_id AND status = 'READY' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'version % is not READY', p_version_id;
  END IF;

  SELECT current_version_id INTO v_prev FROM core.dataset_pointer WHERE id = 1 FOR UPDATE;

  UPDATE core.dataset_version
     SET status = 'SUPERSEDED', superseded_at = now()
   WHERE id = v_prev AND id IS DISTINCT FROM p_version_id;

  UPDATE core.dataset_version
     SET status = 'PUBLISHED', published_at = now(), published_by = p_user
   WHERE id = p_version_id;

  UPDATE core.dataset_pointer
     SET current_version_id = p_version_id, updated_at = now(), updated_by = p_user
   WHERE id = 1;
END $$;
```

Because this is one transaction touching one pointer row, users never observe a partial dataset (PRD §10.1, N5). Rollback is the same function against a retained version, with the target's status returned to `PUBLISHED`.

```sql
-- ── Retention: DROP PARTITION, not DELETE ────────────────────────────────
CREATE OR REPLACE FUNCTION core.prune_versions(p_keep integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v record; n integer := 0; t text;
BEGIN
  FOR v IN
    SELECT id FROM core.dataset_version
     WHERE status IN ('SUPERSEDED','FAILED')
       AND id <> (SELECT current_version_id FROM core.dataset_pointer WHERE id = 1)
     ORDER BY COALESCE(published_at, built_at) DESC
     OFFSET p_keep
  LOOP
    FOREACH t IN ARRAY ARRAY['fact_pr_item','fact_po_line','fact_gr_posting',
                             'fact_pr_release','fact_po_release','bridge_pr_po'] LOOP
      EXECUTE format('DROP TABLE IF EXISTS core.%I_v%s', t, v.id);
    END LOOP;
    -- staging partition, then the version row (cascades fx_rate and mart rows)
    EXECUTE format('DROP TABLE IF EXISTS staging.raw_row_b%s',
                   (SELECT batch_id FROM core.dataset_version WHERE id = v.id));
    DELETE FROM core.dataset_version WHERE id = v.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
```

Pruning a version also removes the personal identifiers it contained, which is how the retention commitment in PRD §19.7 is actually met.

---

## B.14 Optional hardening — row-level security

Data scope is enforced in the application's data layer (PRD §19.4). PostgreSQL RLS can add defence in depth so that even a SQL-injection or a stray query cannot escape scope.

```sql
-- The app sets these per request/transaction, from the session — never from user input
-- SET LOCAL app.user_id = '...';
-- SET LOCAL app.scope   = '[{"company_code":"EU","plant":"*","purch_org":"*"}]';

ALTER TABLE core.fact_po_line ENABLE ROW LEVEL SECURITY;

CREATE POLICY po_line_scope ON core.fact_po_line FOR SELECT TO pct_app
USING (
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(current_setting('app.scope', true)::jsonb) AS s
    WHERE (s->>'company_code' = '*' OR s->>'company_code' = company_code)
      AND (s->>'plant'        = '*' OR s->>'plant'        = plant)
      AND (s->>'purch_org'    = '*' OR s->>'purch_org'    = purch_org)
  )
);
```

**Trade-off, stated honestly:** RLS adds a per-row predicate that the planner cannot always optimise well on aggregate queries, and a missing `SET LOCAL` yields zero rows rather than an error — a fail-closed but confusing mode. Recommendation: **enable RLS on the fact tables in Phase 4** after the load test establishes a baseline, measure the cost, and keep it only if the aggregate paths stay inside the §20.1 targets. The mart tables carry no row-level detail and do not need RLS. Application-layer enforcement is mandatory either way; RLS is never the only control.

---

## B.15 Sizing & maintenance

### Volume estimate

| Table | Rows per version | Retained (12) | Approx. size |
|---|--:|--:|--:|
| `staging.raw_row` | 108,590 | 1.30 M | ~2.5 GB (JSONB) |
| `core.fact_pr_item` | 20,110 | 241 K | ~180 MB |
| `core.fact_po_line` | 20,804 | 250 K | ~400 MB |
| `core.fact_gr_posting` | 28,897 | 347 K | ~250 MB |
| `core.fact_pr_release` | 27,742 | 333 K | ~130 MB |
| `core.fact_po_release` | 10,807 | 130 K | ~60 MB |
| `core.bridge_pr_po` | 11,419 | 137 K | ~30 MB |
| `mart.*` | ~50,000 | 600 K | ~200 MB |
| `audit.audit_log` | — | 24 months | ~500 MB |
| **Total** | | | **≈ 4.5 GB** |

A 200 GB volume gives roughly 40× headroom. Staging JSONB dominates; if space ever pressures, staging retention can be shortened independently of fact retention (lineage for older versions degrades to file-level rather than row-level).

### Maintenance

| Task | Cadence |
|---|---|
| `ANALYZE` on new partitions | immediately after load, before publish |
| `prune_versions()` | after each successful publish |
| Autovacuum | default; facts are insert-only per partition so bloat is minimal |
| Audit hash-chain verification | daily |
| Index bloat check | monthly |
| Full backup + WAL archiving | nightly / continuous |
| Restore drill into staging | quarterly |

### Settings starting point (16 GB instance)

```ini
shared_buffers = 4GB
effective_cache_size = 12GB
work_mem = 64MB                  # raised per-session for mart refresh
maintenance_work_mem = 1GB
max_parallel_workers_per_gather = 4
random_page_cost = 1.1           # SSD
wal_level = replica              # ready for a read replica
checkpoint_completion_target = 0.9
default_statistics_target = 200  # facts are queried with several correlated predicates
log_min_duration_statement = 500ms
```

---

*End of Annex B. See [PRD v2](PRD_v2_Production.md) and [Annex A — Data Contract](PRD_v2_Annex_A_Data_Contract.md).*
