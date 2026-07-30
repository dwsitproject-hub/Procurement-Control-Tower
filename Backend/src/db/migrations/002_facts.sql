-- ============================================================================
-- Fact tables, bridge, mart, audit, and the publish / prune functions.
--
-- All facts are PARTITION BY LIST (dataset_version_id), so every query prunes to
-- one partition and retention is DROP TABLE rather than a mass DELETE.
-- The partition key is part of every primary key, as PostgreSQL requires.
-- ============================================================================

-- ─────────────────────────────────────────────────────── core: fact_pr_item

CREATE TABLE core.fact_pr_item (
  dataset_version_id bigint  NOT NULL,
  pr_no              text    NOT NULL,
  pr_item            integer NOT NULL,

  short_text         text,
  material_code      text,           -- NULL => service item (WBS discriminator)
  material_group     text,
  requisitioner      text,           -- personal data: restricted display
  created_by         text,           -- personal data: restricted display
  plant              text NOT NULL,
  company_code       text NOT NULL,
  purch_org          text NOT NULL,
  purch_group        text,
  doc_type           text,
  uom                text,

  qty_requested      numeric(18,3),
  valuation_price    numeric(18,2),
  total_value_idr    numeric(18,2),  -- NULL if absent; 0 is real (20.9% of rows)
  total_value_usd    numeric(18,2),  -- NULL when unconvertible — never 0

  requisition_date   date,
  release_date       date,
  -- Raw as exported. NOT a need-by date in the reference feed: equals
  -- release_date on 99.40% of rows (assertion V-M01).
  deliv_date_raw     date,
  -- Populated only when a genuine delivery date is available (EBAN-LFDAT).
  -- Demand Realism reads this column and nothing else.
  need_by_date       date,

  urgency            smallint,
  priority           smallint,
  is_deleted         boolean NOT NULL DEFAULT false,
  release_indicator  text,
  wbs_element        text,

  release_l1_date    date,
  release_l2_date    date,
  release_final_date date,
  next_approver      text,
  is_fully_released  boolean NOT NULL DEFAULT false,

  wbs_required       boolean NOT NULL DEFAULT false,
  wbs_status         text NOT NULL DEFAULT 'indeterminate'
                       CHECK (wbs_status IN ('compliant','violation','not_required','indeterminate')),

  po_line_count      integer NOT NULL DEFAULT 0,
  status             text NOT NULL,
  aging_days         integer,

  source_file_id     bigint,
  source_row         integer,

  PRIMARY KEY (dataset_version_id, pr_no, pr_item)
) PARTITION BY LIST (dataset_version_id);

CREATE INDEX ix_pri_scope   ON core.fact_pr_item(dataset_version_id, company_code, plant, purch_org);
CREATE INDEX ix_pri_status  ON core.fact_pr_item(dataset_version_id, status);
CREATE INDEX ix_pri_reqdate ON core.fact_pr_item(dataset_version_id, requisition_date);
CREATE INDEX ix_pri_wbs     ON core.fact_pr_item(dataset_version_id, wbs_status);

-- ─────────────────────────────────────────────────────── core: fact_po_line

CREATE TABLE core.fact_po_line (
  dataset_version_id bigint  NOT NULL,
  po_no              text    NOT NULL,
  po_item            integer NOT NULL,

  -- PR link; NULL for direct POs (43.7% of reference lines).
  -- The '0' sentinel in `Item of requisition` is normalised to NULL upstream.
  pr_no              text,
  pr_item            integer,
  link_provenance    text,
  link_status        text,

  short_text         text,
  material_code      text,
  material_group     text,
  vendor_code        text,
  vendor_name        text,
  plant              text NOT NULL,
  company_code       text NOT NULL,
  purch_org          text NOT NULL,
  purch_group        text,
  doc_type           text NOT NULL,
  is_sto             boolean NOT NULL DEFAULT false,
  req_tracking_no    text,
  acct_assign_cat    text,
  storage_location   text,
  created_by         text,

  order_qty          numeric(18,3),
  order_unit         text,
  net_price          numeric(18,4),
  price_unit         integer NOT NULL DEFAULT 1,
  -- Unit price MUST divide by price_unit: 398 reference lines have price_unit > 1
  unit_price         numeric(24,8),

  currency_code      text NOT NULL,   -- normalised: US$ => USD
  net_order_value    numeric(18,2),
  net_order_value_usd numeric(18,2),
  still_deliver_qty  numeric(18,3),
  still_deliver_val  numeric(18,2),
  still_deliver_val_usd numeric(18,2),
  still_invoice_qty  numeric(18,3),
  still_invoice_val  numeric(18,2),
  still_invoice_val_usd numeric(18,2),
  fx_period_year     integer,
  fx_period_month    smallint,
  fx_basis           text,

  document_date      date NOT NULL,
  delivery_date      date,            -- EINDT; equals document_date on 37.4%
  eindt_equals_docdate boolean,

  release_indicator  text,
  release_group      text,
  release_state      text,
  deletion_indicator text,
  is_deleted         boolean NOT NULL DEFAULT false,
  po_release_state   text NOT NULL
                       CHECK (po_release_state IN ('approved','pending','not_subject_to_release','deleted')),
  -- Decision D2 = flag_only: these lines stay in the pipeline and are marked,
  -- never reclassified. 241 lines / 89 POs / IDR 1.51bn in the reference data.
  release_exempt     boolean NOT NULL DEFAULT false,
  is_incomplete      boolean NOT NULL DEFAULT false,

  release_final_date date,
  next_approver      text,

  -- Receipts: date from movement type 101 ONLY; qty signed per movement class
  receipt_date       date,
  receipt_qty_net    numeric(18,3),
  receipt_count      integer NOT NULL DEFAULT 0,
  reversal_count     integer NOT NULL DEFAULT 0,
  transit_qty_net    numeric(18,3),
  gr_completion_pct  numeric(8,2),
  join_method        text NOT NULL DEFAULT 'line_key',
  -- Diagnostic for V-B08: would a naive earliest-any-movement date have been
  -- wrong here? On reference data this was true for 1,695 line keys.
  gr_date_would_contaminate boolean NOT NULL DEFAULT false,

  status             text NOT NULL,
  aging_days         integer,
  po_approval_days   integer,
  sourcing_days      integer,
  delivery_days      integer,
  delivery_vs_promise_days integer,
  is_retro_po        boolean NOT NULL DEFAULT false,
  is_token_price     boolean NOT NULL DEFAULT false,
  is_zero_price      boolean NOT NULL DEFAULT false,

  source_file_id     bigint,
  source_row         integer,

  PRIMARY KEY (dataset_version_id, po_no, po_item)
) PARTITION BY LIST (dataset_version_id);

CREATE INDEX ix_pol_scope    ON core.fact_po_line(dataset_version_id, company_code, plant, purch_org);
CREATE INDEX ix_pol_docdate  ON core.fact_po_line(dataset_version_id, document_date);
CREATE INDEX ix_pol_vendor   ON core.fact_po_line(dataset_version_id, vendor_code);
CREATE INDEX ix_pol_material ON core.fact_po_line(dataset_version_id, material_code);
CREATE INDEX ix_pol_status   ON core.fact_po_line(dataset_version_id, status);
CREATE INDEX ix_pol_pr       ON core.fact_po_line(dataset_version_id, pr_no, pr_item);
CREATE INDEX ix_pol_purchase ON core.fact_po_line(dataset_version_id, document_date)
                               WHERE NOT is_sto AND NOT is_deleted;
CREATE INDEX ix_pol_exempt   ON core.fact_po_line(dataset_version_id, po_no) WHERE release_exempt;

-- ────────────────────────────────────────────────────── core: fact_gr_posting

CREATE TABLE core.fact_gr_posting (
  dataset_version_id bigint  NOT NULL,
  material_doc       text    NOT NULL,
  material_doc_item  integer NOT NULL,
  po_no              text    NOT NULL,
  po_item            integer NOT NULL,

  movement_type      text NOT NULL,
  posting_class      text NOT NULL,
  counts_as_receipt  boolean NOT NULL,

  posting_date       date NOT NULL,
  entry_date         date,

  qty_entry_raw      numeric(18,3),
  -- Receipts derive the sign from the movement type; transfers preserve the
  -- source leg sign, because a 641 pair is an issue leg and a receipt leg.
  signed_qty         numeric(18,3),
  unit_of_entry      text,
  amount_local       numeric(18,2),

  material_code      text,
  material_desc      text,
  plant              text NOT NULL,
  company_code       text NOT NULL,
  vendor_code        text,
  posted_by          text,           -- personal data: restricted display

  source_file_id     bigint,
  source_row         integer,

  PRIMARY KEY (dataset_version_id, material_doc, material_doc_item)
) PARTITION BY LIST (dataset_version_id);

CREATE INDEX ix_gr_poline  ON core.fact_gr_posting(dataset_version_id, po_no, po_item);
CREATE INDEX ix_gr_posting ON core.fact_gr_posting(dataset_version_id, posting_date);
CREATE INDEX ix_gr_receipt ON core.fact_gr_posting(dataset_version_id, po_no, po_item, posting_date)
                             WHERE movement_type = '101';

-- ────────────────────────────────────────────────────── core: release facts

CREATE TABLE core.fact_pr_release (
  dataset_version_id bigint NOT NULL,
  pr_no              text NOT NULL,
  pr_item            integer NOT NULL,
  rel_seq            smallint NOT NULL,
  rel_code           text,
  pic_release        text,            -- role name: safe to display
  login_name         text,            -- personal data: restricted
  status             text,
  approve_date       date,            -- NULL => pending at this level
  approve_time       time,
  -- TRUE when identifiers were forward-filled from the parent row, so the
  -- inference is never invisible in lineage.
  was_continuation   boolean NOT NULL DEFAULT false,
  plant              text,
  company_code       text,
  purch_org          text,
  source_row         integer,
  PRIMARY KEY (dataset_version_id, pr_no, pr_item, rel_seq)
) PARTITION BY LIST (dataset_version_id);

CREATE INDEX ix_prrel_pending ON core.fact_pr_release(dataset_version_id, pic_release)
                                WHERE approve_date IS NULL;

CREATE TABLE core.fact_po_release (
  dataset_version_id bigint NOT NULL,
  po_no              text NOT NULL,
  rel_seq            smallint NOT NULL,
  rel_code           text NOT NULL,
  pic_release        text,
  login_name         text,
  approve_date       date,
  approve_time       time,
  po_date            date,
  po_create_date     date,
  vendor_code        text,
  vendor_name        text,
  company_code       text NOT NULL,
  purch_org          text NOT NULL,
  currency_code      text,
  amount             numeric(18,2),
  amount_usd         numeric(18,2),
  source_row         integer,
  PRIMARY KEY (dataset_version_id, po_no, rel_seq, rel_code)
) PARTITION BY LIST (dataset_version_id);

CREATE INDEX ix_porel_pending ON core.fact_po_release(dataset_version_id, pic_release)
                                WHERE approve_date IS NULL;

-- ────────────────────────────────────────────────────── core: bridge_pr_po

CREATE TABLE core.bridge_pr_po (
  dataset_version_id bigint NOT NULL,
  pr_no              text NOT NULL,
  pr_item            integer NOT NULL,
  po_no              text NOT NULL,
  po_item            integer NOT NULL,
  link_provenance    text NOT NULL,
  -- Split sourcing: 645 reference PR items map to >1 PO line, max 33
  split_seq          smallint NOT NULL,
  split_total        smallint NOT NULL,
  PRIMARY KEY (dataset_version_id, pr_no, pr_item, po_no, po_item)
) PARTITION BY LIST (dataset_version_id);

CREATE INDEX ix_bridge_po ON core.bridge_pr_po(dataset_version_id, po_no, po_item);

-- ─────────────────────────────────────────────────────────────────────── mart

CREATE TABLE mart.kpi_value (
  dataset_version_id bigint NOT NULL REFERENCES core.dataset_version(id) ON DELETE CASCADE,
  kpi_id             text NOT NULL,
  company_code       text NOT NULL DEFAULT '*',
  plant              text NOT NULL DEFAULT '*',
  purch_org          text NOT NULL DEFAULT '*',
  status             text NOT NULL CHECK (status IN ('ok','insufficient_sample','disabled','unavailable')),
  value_num          numeric(24,6),   -- NULL unless status = 'ok'
  numerator          numeric(24,6),
  denominator        numeric(24,6),
  sample_size        integer,
  unit               text,
  currency_basis     text,
  severity           text,
  status_reason      text,
  detail             jsonb,
  drill_predicate    jsonb,
  PRIMARY KEY (dataset_version_id, kpi_id, company_code, plant, purch_org)
);

-- Storing the drill predicate alongside the aggregate is what makes
-- "drill count == chart count" true by construction.
CREATE TABLE mart.chart_series (
  id                 bigserial PRIMARY KEY,
  dataset_version_id bigint NOT NULL REFERENCES core.dataset_version(id) ON DELETE CASCADE,
  chart_id           text NOT NULL,
  company_code       text NOT NULL DEFAULT '*',
  plant              text NOT NULL DEFAULT '*',
  purch_org          text NOT NULL DEFAULT '*',
  series_key         text NOT NULL,
  series_label       text NOT NULL,
  bucket_key         text NOT NULL,
  bucket_label       text NOT NULL,
  bucket_ordinal     integer NOT NULL,
  value_num          numeric(24,6),
  row_count          integer NOT NULL,
  unit               text,
  currency_basis     text,
  drill_predicate    jsonb NOT NULL,
  UNIQUE (dataset_version_id, chart_id, company_code, plant, purch_org, series_key, bucket_key)
);
CREATE INDEX ix_chart_lookup ON mart.chart_series
  (dataset_version_id, chart_id, company_code, plant, purch_org, bucket_ordinal);

CREATE TABLE mart.chart_meta (
  chart_id text PRIMARY KEY,
  title    text NOT NULL,
  tab      text NOT NULL,
  grain    text NOT NULL,
  unit     text NOT NULL,
  notes    text[] NOT NULL DEFAULT '{}'
);

-- ────────────────────────────────────────────────────────────────────── audit

CREATE TABLE audit.audit_log (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES app.app_user(id),
  actor_email   citext,           -- denormalised: survives user deletion
  actor_ip      inet,
  user_agent    text,
  action        text NOT NULL,
  object_type   text,
  object_id     text,
  outcome       text NOT NULL CHECK (outcome IN ('success','failure','denied')),
  detail        jsonb,
  request_id    text,
  prev_hash     char(64),
  row_hash      char(64) NOT NULL
);
CREATE INDEX ix_audit_time   ON audit.audit_log(occurred_at DESC);
CREATE INDEX ix_audit_actor  ON audit.audit_log(actor_user_id, occurred_at DESC);
CREATE INDEX ix_audit_action ON audit.audit_log(action, occurred_at DESC);

-- Append-only enforced by the table, not by convention.
CREATE RULE audit_no_update AS ON UPDATE TO audit.audit_log DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit.audit_log DO INSTEAD NOTHING;

-- ─────────────────────────────────────────── functions: partitions & publish

CREATE OR REPLACE FUNCTION core.create_version_partitions(p_version_id bigint)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fact_pr_item','fact_po_line','fact_gr_posting',
                           'fact_pr_release','fact_po_release','bridge_pr_po'] LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS core.%I_v%s PARTITION OF core.%I FOR VALUES IN (%s)',
      t, p_version_id, t, p_version_id);
  END LOOP;
END $fn$;

CREATE OR REPLACE FUNCTION core.drop_version_partitions(p_version_id bigint)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fact_pr_item','fact_po_line','fact_gr_posting',
                           'fact_pr_release','fact_po_release','bridge_pr_po'] LOOP
    EXECUTE format('DROP TABLE IF EXISTS core.%I_v%s', t, p_version_id);
  END LOOP;
END $fn$;

-- Atomic publish: one transaction, one pointer row. Users never observe a
-- partial dataset, and a failure leaves the prior version serving.
CREATE OR REPLACE FUNCTION core.publish_version(p_version_id bigint, p_user uuid)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE v_prev bigint;
BEGIN
  PERFORM 1 FROM core.dataset_version
    WHERE id = p_version_id AND status IN ('READY','PUBLISHED','SUPERSEDED') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dataset version % is not publishable', p_version_id;
  END IF;

  SELECT current_version_id INTO v_prev FROM core.dataset_pointer WHERE id = 1 FOR UPDATE;

  IF v_prev IS NOT NULL AND v_prev <> p_version_id THEN
    UPDATE core.dataset_version
       SET status = 'SUPERSEDED', superseded_at = now()
     WHERE id = v_prev;
  END IF;

  UPDATE core.dataset_version
     SET status = 'PUBLISHED',
         published_at = COALESCE(published_at, now()),
         published_by = COALESCE(p_user, published_by),
         superseded_at = NULL
   WHERE id = p_version_id;

  UPDATE core.dataset_pointer
     SET current_version_id = p_version_id, updated_at = now(), updated_by = p_user
   WHERE id = 1;
END $fn$;

-- Retention: DROP PARTITION, not DELETE. Pruning a version also removes the
-- personal identifiers it contained.
CREATE OR REPLACE FUNCTION core.prune_versions(p_keep integer)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE v record; n integer := 0; v_current bigint;
BEGIN
  SELECT current_version_id INTO v_current FROM core.dataset_pointer WHERE id = 1;

  FOR v IN
    SELECT id, batch_id FROM core.dataset_version
     WHERE status IN ('SUPERSEDED','FAILED','BUILDING')
       AND (v_current IS NULL OR id <> v_current)
     ORDER BY COALESCE(published_at, built_at) DESC
     OFFSET p_keep
  LOOP
    PERFORM core.drop_version_partitions(v.id);
    DELETE FROM staging.raw_row WHERE batch_id = v.batch_id;
    DELETE FROM core.dataset_version WHERE id = v.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $fn$;

-- ────────────────────────────────────── current-version views (queried by the app)

CREATE VIEW core.v_pr_item AS
  SELECT f.* FROM core.fact_pr_item f
  JOIN core.dataset_pointer p ON p.id = 1 AND f.dataset_version_id = p.current_version_id;

CREATE VIEW core.v_po_line AS
  SELECT f.* FROM core.fact_po_line f
  JOIN core.dataset_pointer p ON p.id = 1 AND f.dataset_version_id = p.current_version_id;

CREATE VIEW core.v_gr_posting AS
  SELECT f.* FROM core.fact_gr_posting f
  JOIN core.dataset_pointer p ON p.id = 1 AND f.dataset_version_id = p.current_version_id;

CREATE VIEW core.v_pr_release AS
  SELECT f.* FROM core.fact_pr_release f
  JOIN core.dataset_pointer p ON p.id = 1 AND f.dataset_version_id = p.current_version_id;

CREATE VIEW core.v_po_release AS
  SELECT f.* FROM core.fact_po_release f
  JOIN core.dataset_pointer p ON p.id = 1 AND f.dataset_version_id = p.current_version_id;

CREATE VIEW core.v_bridge_pr_po AS
  SELECT f.* FROM core.bridge_pr_po f
  JOIN core.dataset_pointer p ON p.id = 1 AND f.dataset_version_id = p.current_version_id;
