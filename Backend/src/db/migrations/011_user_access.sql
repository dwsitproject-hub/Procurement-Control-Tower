-- 011: User Access — organisational job roles, departments, and a per-page
-- permission matrix (user request 6 Aug 2026).
--
-- The existing four-tier capability role (viewer/analyst/steward/admin) is NOT
-- replaced: every API guard still enforces it. A job role MAPS to one of those
-- tiers (base_role), and the matrix adds per-page view/edit on top.

ALTER TABLE app.app_user ADD COLUMN IF NOT EXISTS department text;
ALTER TABLE app.app_user ADD COLUMN IF NOT EXISTS job_role text;
-- Forced rotation of an admin-issued default password. Enforced centrally in
-- the API guard, not just in the UI.
ALTER TABLE app.app_user ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS app.job_role (
  code       text PRIMARY KEY,
  name       text NOT NULL,
  rank       smallint NOT NULL,
  -- Which capability tier this job role grants (app.role.code).
  base_role  text NOT NULL REFERENCES app.role(code)
);

INSERT INTO app.job_role (code, name, rank, base_role) VALUES
  ('staff',          'Staff',          10, 'viewer'),
  ('section_head',   'Section Head',   20, 'analyst'),
  ('dept_head',      'Dept Head',      30, 'analyst'),
  ('division_head',  'Division Head',  40, 'manager'),
  ('management',     'Management',     50, 'manager'),
  ('admin',          'Admin',          90, 'admin')
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name, rank = EXCLUDED.rank, base_role = EXCLUDED.base_role;

CREATE TABLE IF NOT EXISTS app.department (
  code text PRIMARY KEY,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

INSERT INTO app.department (code, name) VALUES
  ('procurement', 'Procurement'),
  ('finance',     'Finance'),
  ('operations',  'Operations'),
  ('warehouse',   'Warehouse'),
  ('it',          'IT')
ON CONFLICT (code) DO NOTHING;

-- The matrix. One row per (subject, page); the effective access for a user is
-- the MOST PERMISSIVE of their job-role row and their department row, so
-- granting on either dimension works and neither silently blocks the other.
CREATE TABLE IF NOT EXISTS app.page_permission (
  subject_kind text NOT NULL CHECK (subject_kind IN ('job_role','department')),
  subject_code text NOT NULL,
  page_key     text NOT NULL,
  access       text NOT NULL CHECK (access IN ('none','view','edit')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES app.app_user(id),
  PRIMARY KEY (subject_kind, subject_code, page_key)
);

-- Sensible defaults: everyone views the analysis pages; only Admin gets the
-- Admin page; stewardship pages (Detail/Custom) editable from Section Head up.
-- Anything not listed defaults to 'none' (deny by default).
INSERT INTO app.page_permission (subject_kind, subject_code, page_key, access)
SELECT 'job_role', jr.code, p.page_key,
       CASE
         WHEN p.page_key = 'admin' THEN CASE WHEN jr.code = 'admin' THEN 'edit' ELSE 'none' END
         WHEN jr.code = 'admin' THEN 'edit'
         WHEN p.page_key IN ('detail','custom') AND jr.rank >= 20 THEN 'edit'
         WHEN p.page_key = 'datacheck' AND jr.rank >= 20 THEN 'view'
         WHEN p.page_key = 'datacheck' THEN 'none'
         ELSE 'view'
       END
  FROM app.job_role jr
 CROSS JOIN (VALUES
   ('executive'),('openitems'),('pr'),('coupa_src'),('po'),('delivery'),
   ('coupa_inv'),('approvals'),('materials'),('vendors'),('governance'),
   ('detail'),('custom'),('admin'),('datacheck')
 ) AS p(page_key)
ON CONFLICT (subject_kind, subject_code, page_key) DO NOTHING;

-- Existing users keep working: give them a job role matching their capability
-- tier so the matrix resolves for them too.
UPDATE app.app_user u SET job_role = 'admin'
 WHERE job_role IS NULL
   AND EXISTS (SELECT 1 FROM app.user_role ur WHERE ur.user_id = u.id AND ur.role_code = 'admin');
UPDATE app.app_user SET job_role = 'staff' WHERE job_role IS NULL;
