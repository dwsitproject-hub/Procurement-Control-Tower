-- 025 — grant the two pages that have no entry in the permission matrix.
--
-- app.page_permission denies by default: resolvePages() reads only the rows
-- that exist, so a page key with no row is 'none' for everyone except holders
-- of the admin capability tier, who are short-circuited to edit-everywhere.
--
-- That left two gaps.
--
-- 'master' is new in this release (Data -> Master), so it has never had rows.
--
-- 'execsummary' is the older and more serious one. The Executive Summary was
-- added in 020 and made the default landing page afterwards, but 011 is the
-- only migration that ever seeded the matrix and its VALUES list predates the
-- page. Every administrator could see it — which is why it went unnoticed — and
-- every non-administrator silently could not: the permission-aware redirect
-- sent them to the Overview instead. The page they were told is the landing
-- page was unreachable for them.
--
-- Both are granted on the same terms as the other read-only pages: view for
-- every job role, edit for admin. ON CONFLICT DO NOTHING, so a site that has
-- already tuned its matrix by hand keeps its own decisions.

INSERT INTO app.page_permission (subject_kind, subject_code, page_key, access)
SELECT 'job_role', jr.code, p.page_key,
       CASE WHEN jr.code = 'admin' THEN 'edit' ELSE 'view' END
  FROM app.job_role jr
 CROSS JOIN (VALUES ('execsummary'), ('master')) AS p(page_key)
ON CONFLICT (subject_kind, subject_code, page_key) DO NOTHING;
