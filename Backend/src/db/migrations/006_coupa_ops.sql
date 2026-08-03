-- 006 — Coupa operational store (TECH_04 §3.3).
--
-- Coupa data is polled every 5-10 minutes and UPSERTED here, deliberately
-- outside the immutable dataset-version pipeline: a poll tick must not mint a
-- dataset version. The ops schema carries its own freshness (watermarks) and
-- joins onto the SAP facts at query time via the SAP cross-references that
-- every Coupa payload carries (sap-po-no-line-no, sourcing-ref, ...).

CREATE SCHEMA IF NOT EXISTS ops;

-- One row per synced object: the incremental cursor and last-run health.
CREATE TABLE ops.coupa_watermark (
  object          text PRIMARY KEY,
  last_updated_at timestamptz,          -- max updated-at seen; next run reads from this minus lookback
  last_run_at     timestamptz,
  last_status     text,                 -- ok | error | disabled
  last_error      text,
  last_trigger    text,                 -- scheduled | manual
  rows_upserted   bigint NOT NULL DEFAULT 0,
  runs            bigint NOT NULL DEFAULT 0
);

-- Raw payloads for lineage/debug — the typed tables below are projections.
CREATE TABLE ops.coupa_raw (
  object     text   NOT NULL,
  coupa_id   bigint NOT NULL,
  payload    jsonb  NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object, coupa_id)
);

CREATE TABLE ops.coupa_sourcing_event (
  id              bigint PRIMARY KEY,
  event_type      text,
  state           text,
  description     text,
  created_at      timestamptz,
  submit_time     timestamptz,
  start_time      timestamptz,
  end_time        timestamptz,
  currency        text,
  commodity       text,
  plant           text,
  purch_org       text,
  purch_group     text,
  sap_pr_no       text,                 -- custom-fields.sourcing-ref
  planned_savings numeric(18,2),
  supplier_count  integer,
  line_count      integer,
  updated_at      timestamptz
);
CREATE INDEX ix_coupa_se_sap_pr ON ops.coupa_sourcing_event(sap_pr_no);

CREATE TABLE ops.coupa_supplier_response (
  id               bigint PRIMARY KEY,
  quote_request_id bigint NOT NULL,
  supplier_name    text,
  submitted_at     timestamptz,
  state            text,
  awarded          boolean,
  total_amount     numeric(18,2),
  currency         text,
  line_count       integer,
  updated_at       timestamptz
);
CREATE INDEX ix_coupa_sr_event ON ops.coupa_supplier_response(quote_request_id);

CREATE TABLE ops.coupa_po_line (
  order_line_id  bigint PRIMARY KEY,
  coupa_po_id    bigint NOT NULL,
  po_number      text,
  status         text,                  -- header status (issued, buyer_hold, ...)
  line_status    text,
  sap_po_no      text,                  -- custom-fields.sap-po-no-line-no left part
  sap_po_item    integer,
  sap_pr_no      text,                  -- custom-fields.initial-sap-pr-no-line-no
  sap_pr_item    integer,
  need_by_date   date,                  -- D4: the requested date SAP's export lacks
  price          numeric(18,4),
  quantity       numeric(18,3),
  total          numeric(18,2),
  invoiced_total numeric(18,2),
  currency       text,
  uom            text,
  item_number    text,
  description    text,
  plant          text,
  purch_org      text,
  purch_group    text,
  supplier_number text,
  supplier_name  text,
  payment_term   text,
  emergency      boolean,
  match_type     text,
  created_at     timestamptz,
  updated_at     timestamptz
);
CREATE INDEX ix_coupa_pol_sap ON ops.coupa_po_line(sap_po_no, sap_po_item);
CREATE INDEX ix_coupa_pol_po ON ops.coupa_po_line(coupa_po_id);

CREATE TABLE ops.coupa_receipt (
  id               bigint PRIMARY KEY,
  order_line_id    bigint,
  transaction_date date,
  posting_date     date,
  quantity         numeric(18,3),
  price            numeric(18,4),
  total            numeric(18,2),
  status           text,
  type             text,
  storage_location text,
  batch            text,                -- SAP material document
  item_number      text,
  updated_at       timestamptz
);
CREATE INDEX ix_coupa_rcpt_line ON ops.coupa_receipt(order_line_id);

CREATE TABLE ops.coupa_invoice (
  id             bigint PRIMARY KEY,
  invoice_number text,
  invoice_date   date,
  status         text,
  paid           boolean,
  payment_date   timestamptz,
  gross_total    numeric(18,2),
  tax_amount     numeric(18,2),
  currency       text,
  supplier_number text,
  supplier_name  text,
  payment_term   text,
  created_at     timestamptz,
  updated_at     timestamptz
);

CREATE TABLE ops.coupa_invoice_line (
  id            bigint PRIMARY KEY,
  invoice_id    bigint NOT NULL,
  po_number     text,
  order_line_id bigint,
  status        text,
  quantity      numeric(18,3),
  price         numeric(18,4),
  total         numeric(18,2),
  tax_amount    numeric(18,2),
  item_number   text,
  updated_at    timestamptz
);
CREATE INDEX ix_coupa_invl_inv ON ops.coupa_invoice_line(invoice_id);
CREATE INDEX ix_coupa_invl_line ON ops.coupa_invoice_line(order_line_id);

CREATE TABLE ops.coupa_payment (
  id           bigint PRIMARY KEY,
  invoice_id   bigint NOT NULL,
  payment_date timestamptz,
  amount_paid  numeric(18,2),
  notes        text,
  sap_payment_doc text,                 -- first token of notes: "6526004273|IDR|..."
  updated_at   timestamptz
);
CREATE INDEX ix_coupa_pay_inv ON ops.coupa_payment(invoice_id);
