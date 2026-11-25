-- 043: audit hash chain, version 2 (security / architecture review, 12-13 Nov 2026).
--
-- Version 1 had two defects, both shown by replaying the chain on real data:
--   * recordAudit read the last hash and inserted without a lock, so two
--     concurrent writes linked to the same predecessor and the chain forked;
--   * the hash covered JSON.stringify(detail) in the order the code built it,
--     but jsonb stores keys re-ordered, so a row could never be re-hashed.
-- Version 2 (audit.ts) inserts under an advisory transaction lock and hashes a
-- canonical (sorted-key) form of every hashed column. The table is append-only
-- (rules in 002), so version-1 rows cannot be rewritten: they keep version 1,
-- their LINKS are still checked, and verification reports them as legacy.

ALTER TABLE audit.audit_log ADD COLUMN IF NOT EXISTS hash_version smallint NOT NULL DEFAULT 1;
