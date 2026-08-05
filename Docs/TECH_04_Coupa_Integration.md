# TECH 04 — Coupa API Integration

**Status:** design accepted for staging build · **Source doc:** `Docs/KPN - API Payload for Sourcing, PO, Receipt, Invoice, Payment.docx` (Coupa/KPMG, 31-Jul-2026)
**Relates to:** PRD v2 §13 (data acquisition), TECH_01 (architecture), TECH_02 (API), decision D4.

---

## 1. What the Coupa team provided

One production tenant, `https://kpn.coupahost.com`, OAuth2 **client-credentials** flow:

| Concern | Value |
|---|---|
| Token endpoint | `POST /oauth2/token` — `grant_type=client_credentials`, form-encoded |
| Auth for data calls | `Authorization: Bearer <access_token>`, `Accept: application/json` |
| Sourcing event (buyer view) | `GET /api/quote_requests/:id?return_object=full` |
| Supplier responses (supplier view) | `GET /api/quote_requests/:id/quote_responses` |
| Purchase orders | `GET /api/purchase_orders/:id?return_object=full` |
| Goods receipts | `GET /api/receiving_transactions/:id?return_object=full` |
| Invoices **and payments** | `GET /api/invoices/:id?return_object=full` — payments are embedded in the invoice payload (`payments[]`, `paid`, `payment-date`); Coupa has **no separate payment endpoint** |
| Query filters | `field=x` (exact), `[contains]`, `[starts_with]`, `[ends_with]`, `[gt]`, `[lt]`, `[gt_or_eq]`, `[lt_or_eq]`, `[not_eq]`, `[in]`, `[not_in]`, `[blank]` — collections return **50 records per page** |

### 1.1 The SAP cross-references (the integration backbone)

Every Coupa payload carries the SAP keys our existing facts are built on:

| Coupa field | Sample | Joins to |
|---|---|---|
| PO line `custom-fields.sap-po-no-line-no` | `1242005431/1` | `fact_po_line (po_no, po_item)` |
| PO line `custom-fields.initial-sap-pr-no-line-no` | `1240005670/1` | `fact_pr_item (pr_no, pr_item)` |
| PO header `custom-fields.sap-po-no` | `1242005431` | `fact_po_line.po_no` |
| Sourcing event `custom-fields.sourcing-ref` | `1240005670` | `fact_pr_item.pr_no` |
| Event/PO `custom-fields.purchasing-organization.external-ref-num` | `R1P2` | `purch_org` |
| Event/PO `custom-fields.purchasing-group.external-ref-num` | `L2C` | `purch_group` |
| Event/PO/receipt `custom-fields.plant` | `WW2A-PABRIK WKN` | `plant` (prefix before `-`) |
| Supplier `number` | `LN11000351` | `vendor_code` (same LN/IN scheme as the SAP export) |
| Receipt `order-line.id` + `custom-fields.batch` | `1142012638` | Coupa PO line; batch = SAP material doc |
| Invoice line `po-number` / `order-line-id` | `4057 / 7261` | Coupa PO → SAP PO via the PO's `sap-po-no` |

**Two consequences:**

1. Coupa data can be joined line-level onto the current SAP-fed facts — no fuzzy matching.
2. **Coupa carries `need-by-date` on every PO line and sourcing line.** This is the requested-delivery date that decision D4 has been blocked on in the SAP export. For Coupa-era POs, the `otd_vs_requested` activation path (already built: `fact_po_line.need_by_date`, `otdrEvaluable` drill filter, V-M01 gate) can be fed from Coupa without touching the SAP export variant.

### 1.2 What is genuinely new data

| Domain | Today (SAP files) | With Coupa |
|---|---|---|
| Sourcing | Nothing before the PO | Event timeline (`created/submit/start/end-time`), event type (RFQ), invited suppliers, **supplier bids per line** (price, capacity, lead-time), award flags, planned savings |
| PO | Full | Coupa view adds transmission status, payment/shipping terms, tax conditions, emergency-request flag, need-by-date |
| GR | Full (SAP GR List) | Coupa receiving transactions (posting date, storage location, batch) — overlaps SAP GR |
| Invoice | **Nothing** | Invoice header + lines, match status (`matched`), tolerance failures, tax lines, status lifecycle |
| Payment | **Nothing** | `paid`, `payment-date`, `payments[]` (amount, date, SAP payment doc in `notes`), payment terms (D30, I90) |

Invoice + Payment closes the P2P loop the dashboard currently cannot see: GR → invoice → payment. New KPIs become possible: invoice cycle time, % paid on time vs payment terms, days payable outstanding, open payables, GR/IR closure from the invoice side, sourcing cycle time, bid competitiveness, realized vs planned savings.

---

## 2. Security findings — must be resolved before any build

1. **Production credentials are embedded in the Word document** (client id + secret in §1.1 of the doc, real user emails throughout). The document has been circulated by email. **Ask Coupa to rotate the secret** and deliver replacements via a secret channel. Credentials go in the backend `.env` / secret store only — never in the repo, never in `rule_config` (which is readable via API).
2. **The OAuth client is massively over-scoped.** The scope list includes `core.invoice.write`, `core.invoice.approval.bypass`, `core.purchase_order.write`, `core.supplier.write`, `core.pay.payments.write` … A read-only dashboard holding a credential that can bypass invoice approval is an unacceptable blast radius. **Request a dedicated integration client with read-only scopes**: `core.sourcing.read core.sourcing.response.read core.purchase_order.read core.inventory.receiving.read core.invoice.read core.pay.payments.read core.common.read login`.
3. **Staging first.** The doc covers production only. We need from the Coupa team: the staging/test tenant URL (typically `kpn-test.coupahost.com` or similar) and a client for it. All development and the scheduler soak test run against staging; production is enabled by flipping env vars.
4. PII: payloads carry requester/approver emails. Persist only what the dashboard needs (same rule as `createdBy` in the SAP feeds — staging keeps lineage, facts keep the minimum).

---

## 3. How it fits the current build

The v2 architecture was built for exactly this shape of extension: sources are pluggable (`ShareFolderSource`, manual upload), staging keeps raw payloads as jsonb, rules are pure functions, admin config lives in `rule_config`, and every figure carries its drill predicate.

### 3.1 Complement, not replace (phase 1 decision)

SAP extract files remain the source of truth for every existing KPI — golden numbers stay stable and the parity guarantee with v1 is untouched. Coupa lands **alongside**:

```
                 ┌────────────────────────────────────────────┐
 SAP XLSX files ─► ingest pipeline ─► dataset versions ─► marts│  (unchanged)
                 └────────────────────────────────────────────┘
                 ┌────────────────────────────────────────────┐
 Coupa API ──────► coupa poller ─► ops.coupa_* upserts ─► live │  (new)
   (5–10 min)    │   watermarks     (own freshness stamp)      │
                 └────────────────────────────────────────────┘
                          joined at query time via SAP refs
```

Rationale: the SAP pipeline is batch + immutable-versioned (a full re-publish per bundle). A 5–10-minute poll must NOT mint a dataset version per tick — that would produce ~100 versions/day and trash the version history. Coupa data therefore lives in its own continuously-upserted operational store with per-object watermarks and its own freshness indicator. Coupa-tab KPIs compute live against `ops.coupa_*` using the same spec-with-drill-predicate pattern (drill parity holds by construction, sweep extended to cover them).

Phase 2 (after Coupa go-live stabilises and SAP extracts are retired) can promote Coupa to a full pipeline source; nothing in phase 1 blocks that.

### 3.2 New backend modules

| Module | Responsibility |
|---|---|
| `modules/coupa/client.ts` | OAuth token manager (cache to expiry −60s, single-flight refresh, retry-once on 401), GET with paging + filter helpers, rate-limit backoff (429 → exponential), request audit |
| `modules/coupa/poller.ts` | Scheduler loop; per-object incremental sync `updated-at[gt_or_eq]=<watermark>` ordered by `updated-at`, page size 50; advisory lock so only one sync runs; watermark advances only after a page commits |
| `modules/coupa/store.ts` | Upserts into `ops.coupa_*`; raw payload retained in `ops.coupa_raw` for lineage/debug |
| `modules/coupa/link.ts` | Parses `sap-po-no-line-no` / `sourcing-ref` etc. into typed keys; nightly (or per-sync) refresh of the link columns |
| `modules/analytics/coupa_marts.ts` | Sourcing / invoice / payment KPI + chart specs, value SQL and drill predicate together, same as `mart_parity.ts` |

### 3.3 Schema (migration 006, sketch)

```sql
CREATE SCHEMA ops;
CREATE TABLE ops.coupa_watermark (object text PRIMARY KEY, last_updated_at timestamptz, last_run_at timestamptz, last_status text, last_error text, rows_upserted bigint);
CREATE TABLE ops.coupa_raw (object text, coupa_id bigint, payload jsonb, fetched_at timestamptz, PRIMARY KEY (object, coupa_id));
CREATE TABLE ops.coupa_sourcing_event (id bigint PRIMARY KEY, event_type text, state text, description text, created_at timestamptz, submit_time timestamptz, start_time timestamptz, end_time timestamptz, currency text, commodity text, plant text, purch_org text, purch_group text, sap_pr_no text, planned_savings numeric, supplier_count int, line_count int, updated_at timestamptz);
CREATE TABLE ops.coupa_supplier_response (id bigint PRIMARY KEY, quote_request_id bigint, supplier_id bigint, supplier_name text, submitted_at timestamptz, state text, awarded boolean, total_amount numeric, currency text, line_count int, updated_at timestamptz);
CREATE TABLE ops.coupa_po_line (order_line_id bigint PRIMARY KEY, coupa_po_id bigint, po_number text, sap_po_no text, sap_po_item int, sap_pr_no text, sap_pr_item int, status text, need_by_date date, price numeric, quantity numeric, total numeric, invoiced_total numeric, currency text, uom text, plant text, purch_org text, purch_group text, supplier_number text, supplier_name text, payment_term text, emergency boolean, match_type text, created_at timestamptz, updated_at timestamptz);
CREATE TABLE ops.coupa_receipt (id bigint PRIMARY KEY, order_line_id bigint, transaction_date date, posting_date date, quantity numeric, price numeric, total numeric, status text, storage_location text, batch text, item_number text, updated_at timestamptz);
CREATE TABLE ops.coupa_invoice (id bigint PRIMARY KEY, invoice_number text, invoice_date date, status text, paid boolean, payment_date timestamptz, gross_total numeric, tax_amount numeric, currency text, supplier_number text, supplier_name text, payment_term text, created_at timestamptz, updated_at timestamptz);
CREATE TABLE ops.coupa_invoice_line (id bigint PRIMARY KEY, invoice_id bigint, po_number text, order_line_id bigint, status text, quantity numeric, price numeric, total numeric, tax_amount numeric, item_number text, updated_at timestamptz);
CREATE TABLE ops.coupa_payment (id bigint PRIMARY KEY, invoice_id bigint, payment_date timestamptz, amount_paid numeric, notes text, sap_payment_doc text, updated_at timestamptz);
```

### 3.4 Admin-configurable scheduler (the 5–10 minute poll)

Config lives in `rule_config` (admin-editable, audited, effective-dated) — **except credentials, which stay in env**:

| Key | Default | Meaning |
|---|---|---|
| `coupa.sync_enabled` | `false` | Master switch |
| `coupa.sync_interval_minutes` | `10` | Clamped to 5–60 by the backend |
| `coupa.objects` | all five | Which objects to poll |
| `coupa.lookback_minutes` | `15` | Watermark overlap to absorb clock skew / late commits |
| `coupa.page_limit` | `50` | Coupa page size |

Env: `COUPA_BASE_URL`, `COUPA_CLIENT_ID`, `COUPA_CLIENT_SECRET`, `COUPA_SCOPES` (read-only set). Staging vs production is purely an env difference.

Admin tab gets a **Coupa panel**: enable toggle, interval field, per-object status table (last run, watermark, rows upserted, last error), and a "Sync now" button (same pattern as the exclusions recompute — audited, admin-only). The freshness banner gains a second stamp: *"SAP data as of … · Coupa data as of …"*. Honesty rule applies: if a sync fails, the banner says stale-with-reason; it never silently shows old data as fresh.

### 3.5 Frontend

- **Sourcing tab** (new): event list + funnel (draft→submitted→complete), cycle time (submit→end), supplier participation (invited vs responded vs awarded), bid spread per event, planned vs realized savings.
- **Invoice & Payment tab** (new): open payables, invoice status mix, match/tolerance failures, paid-on-time vs payment term, DPO trend, payment history drill (every figure drills to invoice lines, tokens as usual).
- **Existing tabs**: untouched in phase 1. Optional later: vendor bio gains "invoices / payments" section; Coupa need-by feeds `otd_vs_requested` for Coupa-era POs.

---

## 4. Open questions for the Coupa team (blocking staging build)

1. Staging tenant URL + credentials (doc covers production only).
2. Read-only OAuth client (see §2.2) and rotation of the leaked production secret.
3. Confirm **collection endpoints** support the filter syntax for all five objects (the doc's examples show `GET .../:id`; the filter chapter implies `GET /api/purchase_orders?...` etc. works) and confirm the paging parameters (`offset`? `limit` cap?) and any rate limits.
4. Confirm `receiving_transactions` and `quote_requests` support `updated-at` filters for incremental sync.
5. Volume estimate per object per day (sizing the 5-minute delta).

## 5. Build plan (staging)

| Step | Scope | Verification |
|---|---|---|
| C1 | Migration 006 + `client.ts` (token, GET, paging) against staging tenant | Token round-trip; one page of each object fetched and stored raw |
| C2 | `store.ts` + `link.ts` upserts, watermark logic | Re-run idempotent (same rows, no dupes); SAP link rate measured and reported |
| C3 | `poller.ts` + rule_config keys + Admin panel + "Sync now" | Interval honored; lock prevents overlap; failure surfaces in banner + audit |
| C4 | Sourcing + Invoice/Payment marts, tabs, drill specs | Sweep extended to Coupa specs: 0 mismatches; empty-state honest when sync disabled |
| C5 | Soak: 5-min interval for 48h on staging | No watermark drift; token refresh stable; memory flat |

## Exchange rates as a second FX source (added 5 Aug 2026, payload doc v3.0)

`GET /api/exchange_rates` syncs into `ops.coupa_exchange_rate` (migration 009)
under the same watermark mechanism as the other objects.

At transform time the two FX sources compete per currency pair and calendar
month: the SAP rate-conversion excel (timed by its file's `source_mtime`) vs
the newest Coupa rate in that month (timed by its `updated-at`). Whichever
record was updated most recently wins; pairs/months the excel lacks are added
from Coupa. Metrics: `coupaFxCandidates` / `coupaFxAdded` / `coupaFxReplaced`.

**Gated by `fx.coupa_source_enabled` (default OFF, Admin → Coupa panel).**
Staging (kpn-test) carries test rates (e.g. USD→IDR 17.8 instead of ~16,800):
with the gate open they inflated PR Pipeline from $86.5M to $76B in one
recompute. Enable only where Coupa carries real rates.

