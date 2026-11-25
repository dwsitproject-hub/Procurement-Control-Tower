-- 048 — Purchasing Organization and HO/Unit become editable per SAP user
-- (20 Nov 2026, Master -> SAP Users).
--
-- Until now both came only from the business file 026 loaded ("User HO Unit"),
-- 110 rows over 72 users against 2,073 SAP users, so most users had neither and
-- nothing could be done about it short of a migration.
--
-- ── Shape ───────────────────────────────────────────────────────────────────
-- The file's rows move to core.dim_user_purch_org_file, untouched. An admin's
-- choice for a user is ONE row in core.dim_user_org_manual: the full list of
-- organisations and the HO/Unit. core.dim_user_purch_org becomes a VIEW with
-- the same columns: a user with a manual row is read from it, every other user
-- from the file. Every reader (the Master page, the "Manage by HO or Site"
-- split, the created-by HO/Unit filter, the mart charts) keeps reading
-- core.dim_user_purch_org and sees the edit without a code change.
--
-- Why a whole-user row rather than per-org edits: the manual row REPLACES the
-- file for that user. Removing an organisation the file assigned is then just
-- leaving it out, and reverting the user (deleting the row) hands them back to
-- the file exactly - the same contract as dim_material_category_manual (038).
--
-- HO/Unit is per user, as 026 established; the view repeats it on each of the
-- user's organisation rows, as the file does. A manual row with no
-- organisation has no rows in the view - so the edit form requires at least one
-- organisation whenever HO/Unit is set (modules/master/edit.ts).

ALTER TABLE IF EXISTS core.dim_user_purch_org RENAME TO dim_user_purch_org_file;

CREATE TABLE IF NOT EXISTS core.dim_user_org_manual (
  user_id    text PRIMARY KEY,
  purch_orgs text[] NOT NULL DEFAULT '{}',
  ho_unit    text CHECK (ho_unit IN ('HO', 'Unit')),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW core.dim_user_purch_org AS
SELECT f.user_id, f.purch_org, f.ho_unit, f.name, f.source
  FROM core.dim_user_purch_org_file f
 WHERE NOT EXISTS (SELECT 1 FROM core.dim_user_org_manual m WHERE m.user_id = f.user_id)
UNION ALL
SELECT m.user_id, o.purch_org, m.ho_unit,
       (SELECT max(f.name) FROM core.dim_user_purch_org_file f WHERE f.user_id = m.user_id) AS name,
       'manual'::text AS source
  FROM core.dim_user_org_manual m
  CROSS JOIN LATERAL unnest(m.purch_orgs) AS o(purch_org);

COMMENT ON VIEW core.dim_user_purch_org IS
  'Purchasing orgs and HO/Unit per SAP user: the business file (dim_user_purch_org_file), replaced per user by an admin edit (dim_user_org_manual). 048.';
