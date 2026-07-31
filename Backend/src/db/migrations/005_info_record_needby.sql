-- 005 — persist two columns the parity gaps need.
--
-- info_record: 'Purchasing info rec.' from the PO export (filled on ~49.6% of
-- reference lines). Basis of the Info-Record Coverage KPI (po_irc).
--
-- need_by_date: the requested delivery date carried over from the linked PR
-- item (EBAN-LFDAT, decision D4). NULL on every row today — the ME5A export
-- does not yet include a genuine need-by column (V-M01) — but persisting the
-- pathway means On-Time vs Requested lights up on the first ingest that
-- carries it, with no further schema change.
--
-- ALTER on the partitioned parent cascades to every partition.

ALTER TABLE core.fact_po_line ADD COLUMN IF NOT EXISTS info_record text;
ALTER TABLE core.fact_po_line ADD COLUMN IF NOT EXISTS need_by_date date;
