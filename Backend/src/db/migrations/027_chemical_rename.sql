-- 027 — rename CHEMICAL to CHEMICAL REFINERY.
--
-- Requested 1 Sep 2026. The category was asked to be "removed", but its 435
-- lines / USD 8.57M are almost entirely material group 912 and had nowhere to
-- go: Bleaching Earth, Methanol and Sodium Methylate are already carved out of
-- it by code rules, so what remains is the rest of the group. The reader chose
-- to rename rather than drop, which keeps every line counted.
--
-- CHEMICAL REFINERY is the name the business file itself gives group 912, so
-- this renames it to what the source already calls it rather than to something
-- invented here. One UPDATE if a different label is wanted.
--
-- Only rows this project loaded are touched. A category typed in by hand under
-- a different source keeps whatever it says.

UPDATE core.dim_spend_category
   SET category = 'CHEMICAL REFINERY'
 WHERE category = 'CHEMICAL'
   AND source = 'business_file';
