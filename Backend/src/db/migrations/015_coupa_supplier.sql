-- 015 — Coupa supplier master (API payload doc §1.8, GET /api/suppliers).
--
-- Added so Vendor 360 can show the order-dispatch address for a vendor. The
-- join key is the supplier's `number` in Coupa, which carries the same value as
-- the SAP vendor code (LN11001111, IN11000154 …) — verified against the
-- staging tenant, where every supplier number seen on an invoice matched the
-- vendor code on the corresponding SAP line.
--
-- `po_email` is the field the business calls "PO Email": where a purchase order
-- is actually sent. It is distinct from the primary contact's address, and the
-- two differ often enough that both are stored rather than collapsed.

CREATE TABLE IF NOT EXISTS ops.coupa_supplier (
  id                    bigint PRIMARY KEY,
  -- The business key, and the bridge to SAP. Nullable because Coupa does not
  -- enforce it; a supplier without one simply never matches a vendor.
  number                text,
  name                  text,
  display_name          text,
  status                text,
  po_email              text,
  po_method             text,
  primary_contact_email text,
  payment_method        text,
  on_hold               boolean,
  website               text,
  created_at            timestamptz,
  updated_at            timestamptz
);

-- Vendor 360 looks a supplier up by number, once per vendor.
CREATE INDEX IF NOT EXISTS ix_coupa_supplier_number ON ops.coupa_supplier (number);
