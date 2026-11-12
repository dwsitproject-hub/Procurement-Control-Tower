-- 032 - administrator edits to master data, as overrides the sync respects.
--
-- Requested 23 Sep 2026: an Admin should be able to add, edit and delete rows on
-- every Master page.
--
-- ── Why not simply write to the dimension tables ───────────────────────────
--
-- Because the SAP sync rewrites most of them every run. dim_vendor,
-- dim_material, dim_material_master, dim_purch_group, dim_purch_org,
-- dim_doc_type and dim_sap_user are all upserted ON CONFLICT DO UPDATE, so an
-- edit made on the page would have been silently undone the next morning, and
-- a deleted row would simply have come back. An edit that does not last is
-- worse than no edit: the reader believes the change was made.
--
-- So the edit is stored HERE, and the transform re-applies every override
-- immediately after it writes the SAP values (transform.ts, after
-- upsertReferenceData) - before any figure is stamped from those dimensions.
-- The write endpoint also applies it at once, so the page shows the change
-- without waiting for a sync.
--
-- Decided with the reader on 23 Sep 2026:
--
--   the administrator's value WINS over later SAP values, and each overridden
--   row can be reverted to what SAP had;
--
--   deleting a SAP row HIDES it reversibly - a tombstone the sync respects -
--   rather than removing it for SAP to bring back;
--
--   calculation inputs are editable and take effect at the next recompute,
--   because a published dataset is immutable.
--
-- ── The columns ────────────────────────────────────────────────────────────
--
-- relation  the dimension, spelled as the Master page spells it
--           ('core.dim_vendor'). Matched against a fixed registry in code; it
--           never selects a table on its own.
-- row_key   the row's primary key, as {column: value}.
-- action    'upsert' (add or edit) or 'delete' (hide).
-- vals      the administrator's values, {column: value}, for 'upsert'.
-- original  the WHOLE row as it stood before the first override, so a revert
--           can put it back exactly - including a hidden row's NOT NULL
--           columns. NULL for a row the administrator added.
--
-- FX rates are overrides too (relation 'core.fx_rate', keyed by currency and
-- period), but they are applied in the transform's FX build, never to
-- core.fx_rate itself: that table belongs to a published version, and a
-- published version does not change.

CREATE TABLE IF NOT EXISTS app.master_override (
  id           bigserial PRIMARY KEY,
  relation     text        NOT NULL,
  row_key      jsonb       NOT NULL,
  action       text        NOT NULL CHECK (action IN ('upsert', 'delete')),
  vals         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  original     jsonb,
  admin_added  boolean     NOT NULL DEFAULT false,
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (relation, row_key)
);

CREATE INDEX IF NOT EXISTS ix_master_override_relation ON app.master_override (relation);
