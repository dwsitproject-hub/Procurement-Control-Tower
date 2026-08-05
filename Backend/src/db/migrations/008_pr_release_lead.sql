-- 008: persist the SAP-precomputed PR-release lead columns. v1's
-- "PR Approval Lead Time (median)" card reads 'Approved Lead Time - PR
-- Created' and its approval-bottlenecks table reads 'GAP Approval Lead Time';
-- neither can be recomputed from the other dates in the export, so they are
-- stored as delivered (marked SAP-precomputed in the contract).
ALTER TABLE core.fact_pr_release ADD COLUMN IF NOT EXISTS lead_days int;
ALTER TABLE core.fact_pr_release ADD COLUMN IF NOT EXISTS gap_days int;
