-- 018 — the four SAP reference exports become ingestible feeds.
--
-- Until now this reference data was HARDCODED: migration 004 seeded company
-- codes and material-group categories, 017 seeded 299 purchasing groups. The
-- comments there said the point was that "an administrator can correct a
-- description without a deployment" — but a correction still meant an INSERT by
-- hand. These tables are instead refreshed from the SAP exports themselves:
--
--   P Grp.csv            -> core.dim_purch_group   (already exists, 017)
--   P Org.csv            -> core.dim_purch_org     (new)
--   Mat group.xlsx       -> core.dim_material_master (new)
--   zuser <date>.csv     -> core.dim_sap_user      (new)
--
-- Two properties of these feeds, both deliberate:
--
-- 1. GLOBAL, NOT VERSION-SCOPED. Facts are partitioned by dataset_version_id so
--    a published figure never moves. Reference data is the opposite: it is a
--    lookup of what a code MEANS today, and the existing dims (dim_company,
--    dim_purch_group, dim_material_group) are all global. A description
--    correction should show up everywhere at once, not only in new versions.
--    Anything that must not move retroactively is already materialised onto the
--    facts at transform time (material_category, priority_label) and is
--    untouched by this.
--
-- 2. OPTIONAL. They are added to FEEDS but NOT to REQUIRED_FEEDS, so a bundle
--    without them still publishes. The six transactional exports keep the
--    all-or-nothing rule; these refresh on their own cadence, which is what the
--    real world does — a purchasing group is created once a quarter, PR/PO
--    exports land daily.

-- ── Purchasing organisations ────────────────────────────────────────────────
-- Covers 100% of the purch_org values present in the PR and PO facts (11-12
-- distinct codes there, 491 in the master).
CREATE TABLE IF NOT EXISTS core.dim_purch_org (
  code        text PRIMARY KEY,
  description text NOT NULL
);

-- ── Material master ─────────────────────────────────────────────────────────
-- "Mat group.xlsx" is misnamed: it is a MATERIAL master (11,134 rows keyed by
-- material code), not a material-group table. It carries SAP's own spend
-- category per material — MRO GENERAL, MRO SPECIFIC, HEVE, OFFICE IT, CAPEX,
-- CHEMICAL, PACKAGING, FUEL & ENERGY, COAL, METHANOL, FUEL, SERVICES.
--
-- IMPORTANT: `category` here is NOT core.fact_*.material_category and must not
-- be conflated with it. That column is v1's rule keyed by material GROUP, and
-- it rests on a parity heuristic (even group -> Spare Parts-General, odd ->
-- Spare Parts-Factory) that packages/rules/src/category.ts explicitly flags as
-- unconfirmed. This column is a different vocabulary at a different grain from
-- an authoritative source. Pointing the existing charts at it would silently
-- restate every category figure and break v1 parity, so it is stored alongside
-- and nothing is repointed here. Deciding whether it SHOULD replace the
-- heuristic is a business question for the category managers.
CREATE TABLE IF NOT EXISTS core.dim_material_master (
  material_code text PRIMARY KEY,
  description   text,
  category      text
);
CREATE INDEX IF NOT EXISTS ix_material_master_category
  ON core.dim_material_master (category);

-- ── SAP user directory ──────────────────────────────────────────────────────
-- Maps the SAP user id to a person. This is what turns "62217195292" into a
-- name in the Created By column.
--
-- PERSONAL DATA. fact_pr_item.requisitioner and .created_by are already
-- annotated "personal data: restricted display" in 002_facts.sql. This table
-- does not widen who can see a document — it makes an id already on screen
-- legible — but it does mean a name rather than an opaque code, so it is kept
-- as its own table (joined for display) rather than materialised onto the
-- facts. That keeps one place to gate, mask or purge it.
--
-- The export is one client (300) with 2,073 unique users, and it covers 100% of
-- the distinct created_by / login_name values in the facts, background jobs
-- included. `client` is part of the key because SAP ids are only unique within
-- a client, even though only one appears today.
CREATE TABLE IF NOT EXISTS core.dim_sap_user (
  client       text NOT NULL,
  user_id      text NOT NULL,
  first_name   text,
  last_name    text,
  -- Precomputed so a display join is a plain column read. Either part can be
  -- blank in SAP, so this is not simply first || ' ' || last.
  display_name text NOT NULL,
  PRIMARY KEY (client, user_id)
);
-- Display joins have no client to hand (the facts do not carry one), so this
-- supports the lookup that actually happens. A duplicate id across clients
-- would make it ambiguous; today there is exactly one client.
CREATE INDEX IF NOT EXISTS ix_sap_user_user_id ON core.dim_sap_user (user_id);

-- ── Provenance on the purchasing-group table ────────────────────────────────
-- 017 seeded 299 rows from v1's inline JS map. The SAP export has 300 (it adds
-- P61 'Dela Oktakia') and disagrees on one description: L3C is 'Supian Suri' in
-- the seed and 'INACTIVESupianSuri' in SAP, which is live status the hardcoded
-- map cannot know. Recording where a row came from makes that difference
-- visible instead of silently overwriting history.
ALTER TABLE core.dim_purch_group
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'seed';
ALTER TABLE core.dim_purch_org
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'sap_export';

-- ── Widen the feed CHECK constraints ────────────────────────────────────────
-- Two tables pin the feed list in a CHECK. Without this, the very first insert
-- of a reference file into ingest.batch_file fails the constraint and the whole
-- batch dies — after the file has already been read and classified, which makes
-- the failure look like a parsing problem rather than a schema one.
--
-- Kept as an explicit drop-and-recreate (not a DOMAIN) to stay consistent with
-- how 001 declared them, and named so a future feed addition finds them here.
ALTER TABLE app.template_version DROP CONSTRAINT IF EXISTS template_version_feed_check;
ALTER TABLE app.template_version
  ADD CONSTRAINT template_version_feed_check
  CHECK (feed IN ('pr','prel','po','por','gr','fx','pgrp','porg','matm','zuser'));

ALTER TABLE ingest.batch_file DROP CONSTRAINT IF EXISTS batch_file_detected_feed_check;
ALTER TABLE ingest.batch_file
  ADD CONSTRAINT batch_file_detected_feed_check
  CHECK (detected_feed IN ('pr','prel','po','por','gr','fx','pgrp','porg','matm','zuser'));
