-- 010a: the six base roles, before anything references them.
--
-- 011_user_access.sql points app.job_role.base_role at app.role(code) and
-- inserts rows that need 'viewer', 'analyst', 'manager' and 'admin' to exist.
-- Those rows were only ever created by seed.js, which runs AFTER the boot-time
-- migrations, so a brand-new database (production, 12 Nov 2026) stopped at 011
-- with a foreign-key violation. Existing databases already have the roles; this
-- is a no-op there (applied out of order after 042, harmlessly).
--
-- DO NOTHING, not DO UPDATE: names an admin may have changed are left alone;
-- seed.js still owns the canonical names and ranks.

INSERT INTO app.role (code, name, rank) VALUES
  ('viewer',  'Viewer',        10),
  ('analyst', 'Analyst',       20),
  ('manager', 'Manager',       30),
  ('auditor', 'Auditor',       40),
  ('steward', 'Data Steward',  50),
  ('admin',   'Administrator', 90)
ON CONFLICT (code) DO NOTHING;
