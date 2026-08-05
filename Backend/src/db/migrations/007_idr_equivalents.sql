-- 007 — per-line IDR equivalents for the display-currency toggle.
--
-- The dashboard can show money in USD or IDR. A single blended rate would
-- violate the no-silent-conversion rule, so each line carries its own IDR
-- equivalent computed at transform time with the SAME period-matched FX used
-- for the USD figures: IDR lines keep their document value verbatim; foreign
-- lines convert via their period's IDR rate; a period without an IDR rate
-- yields NULL and the strict rule nulls any aggregate that touches it.

ALTER TABLE core.fact_po_line ADD COLUMN IF NOT EXISTS net_order_value_idr  numeric(20,2);
ALTER TABLE core.fact_po_line ADD COLUMN IF NOT EXISTS still_deliver_val_idr numeric(20,2);
ALTER TABLE core.fact_po_line ADD COLUMN IF NOT EXISTS still_invoice_val_idr numeric(20,2);
