-- 046: what each supplier actually quoted, line by line (19 Nov 2026).
--
-- The Sourcing page could say WHO responded to an event and the total, but not
-- the comparison a buyer makes: price per line, quantity, lead time, the item the
-- supplier offered, shipping term, the supplier's comments. Coupa returns all of
-- that on every quote response the sync already fetches; until now the lines
-- were summed into ops.coupa_supplier_response.total_amount and thrown away.
--
-- Numbered 046, not 045: a concurrent piece of work (the Syncera SAP API) holds
-- 045 and the two must not collide. Neither depends on the other.

CREATE TABLE IF NOT EXISTS ops.coupa_quote_response_line (
  id                    bigint PRIMARY KEY,           -- Coupa quote response line id
  response_id           bigint NOT NULL,              -- ops.coupa_supplier_response.id
  quote_request_id      bigint NOT NULL,              -- the event
  request_line_id       bigint,                       -- the event line it answers
  price                 numeric(20,4),
  adjusted_price        numeric(20,4),
  currency              text,
  quantity              numeric(18,3),
  awarded               boolean,
  awarded_quantity      numeric(18,3),
  lead_time_days        integer,
  supplier_item_name    text,
  item_description      text,
  part_number           text,
  shipping_term         text,
  attachment_count      integer,
  updated_at            timestamptz
);
CREATE INDEX IF NOT EXISTS ix_coupa_qrl_event    ON ops.coupa_quote_response_line (quote_request_id);
CREATE INDEX IF NOT EXISTS ix_coupa_qrl_response ON ops.coupa_quote_response_line (response_id);

ALTER TABLE ops.coupa_supplier_response
  ADD COLUMN IF NOT EXISTS supplier_email text,
  ADD COLUMN IF NOT EXISTS comments       text,
  -- Set when the response LINES were stored, so an event whose lines predate
  -- this migration can be told apart from one that genuinely quoted nothing,
  -- and fetched on demand the first time someone opens its comparison.
  ADD COLUMN IF NOT EXISTS lines_fetched_at timestamptz;

-- The view selected r.* when it was created, which Postgres froze to the
-- columns of that day; re-create it so the new ones are visible through it.
CREATE OR REPLACE VIEW ops.v_coupa_supplier_response AS
SELECT r.*
  FROM ops.coupa_supplier_response r
 WHERE EXISTS (
         SELECT 1 FROM ops.v_coupa_sourcing_event e WHERE e.id = r.quote_request_id
       );

/*
 * A quote supplier's SAP vendor type (Local / Import).
 *
 * Coupa's quote supplier is an invitation - a name and an email, no supplier
 * number - so the type comes from matching it to the supplier master
 * (ops.coupa_supplier, whose number IS the SAP vendor code) by name, display
 * name, or contact / PO email. That resolves 94% of the quote suppliers in the
 * current data. A name that maps to vendors of BOTH types resolves to neither
 * rather than to whichever row came first.
 *
 * Local = vendor code LN..., Import = IN... (settled with the user 19 Nov 2026;
 * the request had them reversed, the vendor names do not).
 */
CREATE OR REPLACE FUNCTION ops.coupa_vendor_type(p_name text, p_email text)
RETURNS text LANGUAGE sql STABLE AS $$
  WITH m AS (
    SELECT DISTINCT CASE WHEN s.number LIKE 'LN%' THEN 'Local'
                         WHEN s.number LIKE 'IN%' THEN 'Import' END AS t
      FROM ops.coupa_supplier s
     WHERE lower(btrim(s.name))         = lower(btrim(p_name))
        OR lower(btrim(s.display_name)) = lower(btrim(p_name))
        OR (COALESCE(btrim(p_email), '') <> ''
            AND (lower(btrim(s.primary_contact_email)) = lower(btrim(p_email))
              OR lower(btrim(s.po_email))              = lower(btrim(p_email))))
  )
  SELECT CASE WHEN (SELECT count(*) FROM m WHERE t IS NOT NULL) = 1
              THEN (SELECT t FROM m WHERE t IS NOT NULL) END
$$;

CREATE INDEX IF NOT EXISTS ix_coupa_supplier_lname  ON ops.coupa_supplier (lower(btrim(name)));
CREATE INDEX IF NOT EXISTS ix_coupa_supplier_ldname ON ops.coupa_supplier (lower(btrim(display_name)));

-- Resolved once per response and stored: calling the matcher for every row of
-- a page listing tens of thousands of responses would scan the supplier master
-- per row. The sync sets it for new responses and re-resolves the unresolved
-- ones after each run (a supplier added to the master later then resolves).
ALTER TABLE ops.coupa_supplier_response ADD COLUMN IF NOT EXISTS vendor_type text;

-- Back-fill the email from the event's invitation list (same name, same event).
UPDATE ops.coupa_supplier_response r
   SET supplier_email = q.email
  FROM (
    SELECT raw.coupa_id AS event_id, q->>'name' AS name, min(q->>'email') AS email
      FROM ops.coupa_raw raw, jsonb_array_elements(raw.payload->'quote-suppliers') q
     WHERE raw.object = 'quote_requests'
     GROUP BY 1, 2
  ) q
 WHERE r.supplier_email IS NULL
   AND q.event_id = r.quote_request_id
   AND q.name = r.supplier_name;

-- Then the type, computed once per distinct (name, email) pair. MATERIALIZED
-- and joined on plain equality: inlined, the planner called the matcher once
-- per (response x pair) and the statement ran for minutes.
WITH t AS MATERIALIZED (
  SELECT COALESCE(supplier_name, '') AS nk, COALESCE(supplier_email, '') AS ek,
         ops.coupa_vendor_type(supplier_name, supplier_email) AS vt
    FROM (SELECT DISTINCT supplier_name, supplier_email FROM ops.coupa_supplier_response) k
)
UPDATE ops.coupa_supplier_response r
   SET vendor_type = t.vt
  FROM t
 WHERE r.vendor_type IS NULL
   AND t.vt IS NOT NULL
   AND t.nk = COALESCE(r.supplier_name, '')
   AND t.ek = COALESCE(r.supplier_email, '');

-- The view again, now that vendor_type exists too.
CREATE OR REPLACE VIEW ops.v_coupa_supplier_response AS
SELECT r.*
  FROM ops.coupa_supplier_response r
 WHERE EXISTS (
         SELECT 1 FROM ops.v_coupa_sourcing_event e WHERE e.id = r.quote_request_id
       );

/*
 * SAP purchase orders with a payment or down payment recorded in Coupa
 * (19 Nov 2026, Open Items: "PO not delivered" split into not-paid / paid).
 *
 * The SAP exports carry no payment or DP field, so Coupa is the only source:
 * a PO counts as paid when ANY Coupa invoice against it is marked paid or has
 * a payment row. Invoices reach the SAP PO through the Coupa order line (or,
 * when the invoice line carries no order line, the Coupa PO number). It covers
 * only POs invoiced through Coupa - the Open Items card says so.
 */
CREATE OR REPLACE VIEW ops.v_coupa_paid_sap_po AS
WITH inv AS (
  SELECT i.id, i.payment_date,
         (i.paid IS TRUE OR EXISTS (SELECT 1 FROM ops.coupa_payment p WHERE p.invoice_id = i.id)) AS is_paid,
         COALESCE((SELECT sum(p.amount_paid) FROM ops.coupa_payment p WHERE p.invoice_id = i.id), 0) AS paid_amount
    FROM ops.coupa_invoice i
), linked AS (
  SELECT DISTINCT pl.sap_po_no, inv.id AS invoice_id, inv.payment_date, inv.paid_amount
    FROM ops.coupa_invoice_line il
    JOIN inv ON inv.id = il.invoice_id AND inv.is_paid
    JOIN ops.coupa_po_line pl
      ON (il.order_line_id IS NOT NULL AND pl.order_line_id = il.order_line_id)
      OR (il.order_line_id IS NULL AND pl.po_number = il.po_number)
   WHERE pl.sap_po_no IS NOT NULL AND btrim(pl.sap_po_no) <> ''
)
SELECT sap_po_no AS po_no,
       count(DISTINCT invoice_id)::int AS paid_invoices,
       sum(paid_amount) AS paid_amount,
       min(payment_date) AS first_payment_date
  FROM linked
 GROUP BY sap_po_no;
