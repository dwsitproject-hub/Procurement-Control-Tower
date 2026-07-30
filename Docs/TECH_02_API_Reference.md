# Technical Documentation 2 — API Reference

**Product:** Procurement Control Tower v2 · **API version:** v1
**Version:** 1.0 · **Date:** 30 July 2026
**Base URL:** `https://procurement.energi-up.com`
**Companions:** [TECH 01 — Architecture](TECH_01_Architecture_and_Implementation.md) · [TECH 03 — Deployment & Operations](TECH_03_Deployment_and_Operations.md) · [PRD v2](PRD_v2_Production.md)

---

## Contents

1. [Conventions](#1-conventions)
2. [Authentication endpoints](#2-authentication-endpoints)
3. [Identity](#3-identity)
4. [Dataset & freshness](#4-dataset--freshness)
5. [Analytics](#5-analytics)
6. [Drill-down](#6-drill-down)
7. [Detail rows & lineage](#7-detail-rows--lineage)
8. [Entity views](#8-entity-views)
9. [Export](#9-export)
10. [Ingestion](#10-ingestion)
11. [Administration](#11-administration)
12. [Audit](#12-audit)
13. [Health](#13-health)
14. [Error catalogue](#14-error-catalogue)
15. [Rate limits](#15-rate-limits)

---

## 1. Conventions

### 1.1 Transport

Single origin. Everything is served from one hostname; `/api/*` and `/auth/*` are reverse-proxied to the backend. **CORS is not enabled** and cross-origin calls are not supported by design (TECH 01 §2.3).

### 1.2 Authentication

Session cookie `pct_sid` — `HttpOnly`, `SameSite=Lax`, `Secure` in production, host-only. Browsers send it automatically on same-origin requests. There is no bearer-token API; there is no API key.

Clients must send `credentials: 'same-origin'`.

### 1.3 Versioning

All data endpoints are under `/api/v1`. Auth endpoints are unversioned (`/auth/*`) because the Hub's registered redirect URI must be stable across API versions.

Breaking changes go to `/api/v2`. Additive fields are not breaking; clients must ignore unknown fields.

### 1.4 Dataset identity on every response

Every analytics response carries the dataset version it was computed from:

```json
{
  "datasetVersionId": 41,
  "asOfDate": "2026-07-27",
  "...": "..."
}
```

Clients must surface a mismatch rather than blending versions. `asOfDate` is the business date the data describes and the basis of **all** aging — it is never wall-clock time.

### 1.5 Nulls

`null` means *unknown or unavailable*, never zero. Clients render `null` as `—`. A KPI whose `status` is not `"ok"` always has `value: null`.

### 1.6 Money

Amounts are always paired with a currency. A USD-consolidated amount is `null` whenever any currency in scope lacks a rate; `currencyBasis` explains which rule applied.

| `currencyBasis` | Meaning |
|---|---|
| `usd_strict` | Every currency in scope was convertible; the USD figure is complete |
| `per_currency` | Not all convertible; caller must render the per-currency breakdown |
| `idr_based` | Share computed on IDR-denominated documents only; label it `(IDR-based %)` |

### 1.7 Pagination

Cursor-based. `limit` defaults to 100, maximum 1,000.

```
GET /api/v1/rows?limit=100&cursor=eyJpZCI6MTIzfQ
```

```json
{ "rows": [], "nextCursor": "eyJpZCI6MjIzfQ", "totalCount": 20804 }
```

`totalCount` is exact, not estimated — drill counts must be verifiable against chart counts.

### 1.8 Filtering

Common query parameters, accepted by all analytics endpoints:

| Parameter | Type | Notes |
|---|---|---|
| `companyCode` | string, repeatable | Intersected with the caller's scope — never widens it |
| `plant` | string, repeatable | |
| `purchOrg` | string, repeatable | |
| `purchGroup` | string, repeatable | |
| `materialGroup` | string, repeatable | |
| `status` | string, repeatable | |
| `dateFrom`, `dateTo` | `YYYY-MM-DD` | Applies to the grain's primary date |
| `excludeSto` | boolean | Default varies per endpoint; the effective value is echoed in `appliedFilters` |
| `includeDeleted` | boolean | Default `false` |

Unknown parameters are **rejected** with `400 invalid-parameter`, not ignored — a typo must not silently return unfiltered data.

Every response echoes what was actually applied:

```json
"appliedFilters": { "plant": ["EU71"], "excludeSto": true, "includeDeleted": false }
```

### 1.9 Request ids

Every response carries `X-Request-Id`. It appears in server logs and in UI error states so a user can quote it to support.

### 1.10 Roles

Endpoint tables use the minimum role. Ranks: `viewer` 10 · `analyst` 20 · `manager` 30 · `auditor` 40 · `steward` 50 · `admin` 90. A higher rank satisfies a lower requirement, except where a table says a role is required explicitly.

**Data scope is applied on top of role, always.** A user with `admin` and an empty scope sees no data.

---

## 2. Authentication endpoints

### `GET /auth/oidc/login`

Begins SP-initiated SSO. Public.

| Query | Type | Notes |
|---|---|---|
| `returnTo` | string | Optional. Same-origin relative path only; anything else is replaced by `/` |

**302** to the Hub's `/api/sso/authorize` with `client_id`, `response_type=code`, `redirect_uri`, `scope`, `code_challenge`, `code_challenge_method=S256`, `state`, `nonce`.

Diagnostic:

```bash
curl -si https://procurement.energi-up.com/auth/oidc/login | grep -iE '^(HTTP|location)'
```

Confirm the `location` header contains `code_challenge_method=S256` and a `redirect_uri` byte-identical to the registered value.

**404** if the `OIDC_*` variables are absent — the route is gated on complete configuration.

### `GET /auth/oidc/callback`

Completes SSO. Public. Handles **both** flows.

| Query | Type | Notes |
|---|---|---|
| `code` | string | Required. Single-use, short-lived |
| `state` | string | Present in the SP-initiated flow |
| `code_verifier` | string | **Present only in the IdP-initiated flow** — the Hub created the PKCE challenge itself |

Branch selection is on the presence of `code_verifier`, not on `state`. See TECH 01 §6.2.4.

**303** to `returnTo` with `Set-Cookie: pct_sid=…`. 303 rather than 302 so the browser issues a GET carrying the new cookie.

**401** on state mismatch, token-exchange failure, or id_token verification failure. The response body never reveals which.

### `POST /auth/local/login`

Local break-glass login. Public, rate-limited. Available only when `LOCAL_AUTH_ENABLED=true`.

```json
{ "email": "ops.breakglass@energi-up.com", "password": "…" }
```

**200** — `{ "mfaRequired": true, "partialToken": "…" }` when MFA is enabled (mandatory in production), else a full session cookie.

**401** — `invalid-credentials`. Identical message and timing for unknown user and wrong password.
**423** — `account-locked` after 5 failures; 15-minute lockout per account and per source IP.

### `POST /auth/local/mfa`

```json
{ "partialToken": "…", "code": "123456" }
```

**200** with the session cookie. **401** `invalid-mfa-code`.

### `POST /auth/logout`

Session required. Destroys the server-side session record — not just the cookie. **204**.

---

## 3. Identity

### `GET /api/v1/me`

Role: authenticated.

```json
{
  "userId": "8f3e1c22-…",
  "email": "jerry.hakim@energi-up.com",
  "displayName": "Jerry Hakim",
  "authMethod": "sso",
  "roles": ["manager"],
  "scope": [
    { "companyCode": "EU", "plant": "*", "purchOrg": "*" }
  ],
  "capabilities": ["view", "drill", "export", "savePreferences"],
  "session": { "createdAt": "2026-07-30T02:11:04Z", "absoluteExpiresAt": "2026-07-30T14:11:04Z" }
}
```

An empty `scope` array is valid and expected for a newly provisioned SSO user. The client must render a "no data access granted" state rather than empty dashboards.

### `GET /api/v1/me/preferences` · `PUT /api/v1/me/preferences/{key}`

Role: authenticated. Server-side per-user UI state — detail-table column order and visibility, saved filter sets, default tab. Replaces v1's `localStorage`, so a layout follows the user across devices.

```json
{ "value": { "columns": ["PR_No", "Desc", "Status"], "hidden": ["OPU"] } }
```

---

## 4. Dataset & freshness

### `GET /api/v1/dataset/current`

Role: viewer. Backs the freshness banner; polled every 60 seconds.

```json
{
  "datasetVersionId": 41,
  "asOfDate": "2026-07-27",
  "asOfSource": "data_max",
  "publishedAt": "2026-07-30T02:15:22Z",
  "publishedBy": null,
  "sourceKind": "synology",
  "sourceLabel": "Synology auto-sync",
  "freshnessState": "current",
  "freshnessThresholds": { "ageingDays": 3, "staleDays": 7 },
  "fxPolicy": "period_matched",
  "feeds": [
    { "feed": "pr",   "filename": "PR Report EU 1 Jan 2026 31 July 2026.XLSX",   "rowCount": 20110, "rowDelta":  118, "sha256Short": "a3f19c4e" },
    { "feed": "prel", "filename": "PR Release EU 1 Jan 2026 31 July 2026.XLSX",  "rowCount": 27742, "rowDelta":  204, "sha256Short": "7b2d81f0" },
    { "feed": "po",   "filename": "PO Report EU 1 Jan 2026 31 July 2026.XLSX",   "rowCount": 20804, "rowDelta":  312, "sha256Short": "c91e4a77" },
    { "feed": "por",  "filename": "PO Release EU 1 Jan 2026 31 July 2026.XLSX",  "rowCount": 10807, "rowDelta":   96, "sha256Short": "2e88b105" },
    { "feed": "gr",   "filename": "GR List EU 1 Jan 2026 31 July 2026.XLSX",     "rowCount": 28897, "rowDelta":  441, "sha256Short": "5d70ff3a" },
    { "feed": "fx",   "filename": "Rate Conversion - Copy.xlsx",                 "rowCount":   230, "rowDelta":    0, "sha256Short": "9a04c2be" }
  ],
  "validationSummary": { "blocker": 0, "caveat": 1, "warning": 6, "info": 12 },
  "activeCaveats": [
    {
      "ruleId": "V-M01",
      "message": "Requested delivery date is not distinct from release date (0.60% of rows differ, expected >= 50%). The column is not a need-by date. Demand Realism remains disabled. See PRD 13.1.1.",
      "disablesKpis": ["demand_realism"]
    }
  ],
  "ruleSnapshot": {
    "wbs.material_threshold_idr": 30000000,
    "wbs.service_threshold_idr": 150000000,
    "wbs.basis": "per_item",
    "aging.threshold_days": 60,
    "fx.policy": "period_matched",
    "release.no_strategy_policy": "flag_only",
    "sto.doctype_suffix": "70"
  }
}
```

`freshnessState` ∈ `current` | `ageing` | `stale` | `caveats` | `loading`.

`ruleSnapshot` is the configuration in force **for this version**. Editing a threshold does not change published versions; the client displays the snapshot value, not the current setting.

`filename` is source-supplied — escape it before rendering.

### `GET /api/v1/dataset/versions`

Role: viewer.

```json
{
  "versions": [
    { "id": 41, "asOfDate": "2026-07-27", "publishedAt": "2026-07-30T02:15:22Z", "status": "PUBLISHED",  "sourceKind": "synology", "publishedBy": null,        "rowTotal": 108590 },
    { "id": 40, "asOfDate": "2026-07-26", "publishedAt": "2026-07-29T02:14:58Z", "status": "SUPERSEDED", "sourceKind": "synology", "publishedBy": null,        "rowTotal": 108119 },
    { "id": 39, "asOfDate": "2026-07-24", "publishedAt": "2026-07-25T09:41:07Z", "status": "SUPERSEDED", "sourceKind": "manual",   "publishedBy": "S. Wijaya", "rowTotal": 107660 }
  ],
  "retained": 12
}
```

### `GET /api/v1/dataset/{id}/validation`

Role: analyst.

```json
{
  "datasetVersionId": 41,
  "batchId": 118,
  "findings": [
    {
      "ruleId": "V-M01", "severity": "CAVEAT", "feed": "pr",
      "message": "Requested delivery date is not distinct from release date…",
      "affectedRows": 19989,
      "measured": { "expected": ">=50%", "actual": "0.60%", "total": 20110, "differing": 121 },
      "disablesKpis": ["demand_realism"],
      "drillToken": "eyJhbGciOi…"
    },
    {
      "ruleId": "V-B10", "severity": "WARNING", "feed": "po",
      "message": "241 PO lines across 89 POs have no release strategy and are not deleted. Marked release-exempt; included in pipeline analytics, excluded from the pending-approval queue.",
      "affectedRows": 241,
      "measured": { "lines": 241, "pos": 89, "valueIdr": 1506586519 },
      "drillToken": "eyJhbGciOi…"
    },
    {
      "ruleId": "V-B08", "severity": "WARNING", "feed": "gr",
      "message": "0 PO lines have a receipt date preceding their first movement-type-101 posting.",
      "affectedRows": 0,
      "measured": { "expected": 0, "actual": 0 }
    }
  ]
}
```

Every finding with `affectedRows > 0` carries a `drillToken`.

---

## 5. Analytics

### `GET /api/v1/kpi`

Role: viewer. Accepts the common filters (§1.8).

| Query | Type | Notes |
|---|---|---|
| `kpiId` | string, repeatable | Optional. Omit for the full set |

```json
{
  "datasetVersionId": 41,
  "asOfDate": "2026-07-27",
  "appliedFilters": { "excludeSto": true, "includeDeleted": false },
  "kpis": [
    {
      "kpiId": "demand_realism",
      "status": "disabled",
      "value": null, "numerator": null, "denominator": null, "sampleSize": null,
      "unit": "percent", "currencyBasis": null,
      "statusReason": "Requested delivery date not present in this export (V-M01). See PRD 13.1.1.",
      "drillToken": null
    },
    {
      "kpiId": "expedite_effectiveness",
      "status": "ok",
      "value": 0.5, "numerator": 6, "denominator": 12, "sampleSize": 10143,
      "unit": "ratio", "currencyBasis": null,
      "statusReason": null,
      "severity": "good",
      "detail": { "urgentMedianDays": 6, "standardMedianDays": 12, "urgentSample": 2568, "standardSample": 7575 },
      "drillToken": "eyJhbGciOi…"
    },
    {
      "kpiId": "grir_over_60d",
      "status": "ok",
      "value": 58.6, "numerator": 15414539447, "denominator": 26304673800, "sampleSize": 986,
      "unit": "percent", "currencyBasis": "usd_strict",
      "statusReason": null, "severity": "warning",
      "drillToken": "eyJhbGciOi…"
    },
    {
      "kpiId": "wbs_compliance",
      "status": "ok",
      "value": 1119, "numerator": 1119, "denominator": 1247, "sampleSize": 20110,
      "unit": "count", "currencyBasis": null,
      "statusReason": null, "severity": "critical",
      "detail": {
        "violationItems": 1119, "violationPrs": 339, "valueAtRiskIdr": 3482267279089,
        "indeterminateItems": 4211,
        "thresholdLabel": "≥ IDR 30M material / ≥ IDR 150M service · per item · effective 2026-08-01"
      },
      "drillToken": "eyJhbGciOi…"
    },
    {
      "kpiId": "cycle_e2e",
      "status": "insufficient_sample",
      "value": null, "sampleSize": 14,
      "unit": "days", "statusReason": "Fewer than 30 observations in this slice.",
      "drillToken": null
    }
  ]
}
```

`severity` ∈ `good` | `neutral` | `warning` | `critical`, computed server-side from the configured thresholds so the client never encodes business judgement.

`detail.thresholdLabel` must be displayed on the WBS card — the rule in force has to be visible wherever the number is.

### `GET /api/v1/chart/{chartId}`

Role: viewer. Accepts the common filters.

```json
{
  "datasetVersionId": 41,
  "asOfDate": "2026-07-27",
  "chartId": "delivery_ordered_vs_received_by_month",
  "title": "Ordered vs received by PO month",
  "unit": "count",
  "currencyBasis": null,
  "buckets": [
    { "key": "2026-01", "label": "Jan 2026", "ordinal": 1 },
    { "key": "2026-02", "label": "Feb 2026", "ordinal": 2 }
  ],
  "series": [
    {
      "key": "ordered", "label": "PO lines",
      "points": [
        { "bucketKey": "2026-01", "value": 3184, "rowCount": 3184, "drillToken": "eyJ…" },
        { "bucketKey": "2026-02", "value": 2907, "rowCount": 2907, "drillToken": "eyJ…" }
      ]
    },
    {
      "key": "received", "label": "Lines with GR",
      "points": [
        { "bucketKey": "2026-01", "value": 2761, "rowCount": 2761, "drillToken": "eyJ…" },
        { "bucketKey": "2026-02", "value": 2402, "rowCount": 2402, "drillToken": "eyJ…" }
      ]
    }
  ],
  "notes": ["STO lines included in delivery analytics"]
}
```

**Every point carries its own `drillToken`.** `rowCount` is the count the drill will return — asserted in CI for every chart (TECH 01 §9.2).

An empty chart returns `buckets: []` with a `notes` entry naming the reason, e.g. `"No PO lines with dates in the selected range"`. Clients render that text rather than empty axes.

`"Others"` buckets carry the assembled predicate of their members and drill correctly.

### `GET /api/v1/chart`

Role: viewer. Chart catalogue — `chartId`, title, grain, tab, supported filters. Lets the frontend enumerate rather than hard-code.

---

## 6. Drill-down

### `GET /api/v1/drill/{token}`

Role: analyst.

| Query | Type | Notes |
|---|---|---|
| `cursor` | string | Pagination cursor |
| `limit` | int | Default 100, max 1,000 |
| `sort` | string | `field:asc` / `field:desc`, whitelisted fields only |

```json
{
  "datasetVersionId": 41,
  "asOfDate": "2026-07-27",
  "label": "Open PRs above WBS threshold without WBS Element (mat ≥ 30M · svc ≥ 150M IDR)",
  "grain": "pr_item",
  "totalCount": 1119,
  "note": null,
  "columns": [
    { "key": "prNo",         "label": "PR No",     "type": "string" },
    { "key": "prItem",       "label": "Item",      "type": "int" },
    { "key": "shortText",    "label": "Desc",      "type": "string" },
    { "key": "totalValueIdr","label": "Value IDR", "type": "money", "currency": "IDR" },
    { "key": "wbsStatus",    "label": "WBS",       "type": "enum" },
    { "key": "agingDays",    "label": "Aging (d)", "type": "int" }
  ],
  "rows": [
    { "id": "1000009640|1", "prNo": "1000009640", "prItem": 1, "shortText": "BIOSOLAR (INDUSTRI)",
      "totalValueIdr": 198640596, "wbsStatus": "violation", "agingDays": 208, "flags": [] }
  ],
  "nextCursor": "eyJpZCI6…"
}
```

`flags` may contain `sto` (🚚), `tokenPrice` (⚠), `releaseExempt` (⚑), `danglingLink`, `fallbackJoin`, `fxFallback`. Clients render the corresponding marker with its tooltip.

`note` carries drill-specific context, e.g. `"direct POs (no PR link)"` for slices assembled from PO lines with no requisition.

**Errors**

| Status | Type | Cause |
|---|---|---|
| 401 | `drill-token-expired` | Older than 15 minutes. Client re-fetches the aggregate to get a fresh token |
| 401 | `drill-token-invalid` | Malformed or undecryptable |
| 403 | `drill-token-foreign` | Belongs to another session. Audited as `drill.token_replay` |

A token whose embedded scope no longer intersects the caller's scope returns **200 with `totalCount: 0`**, not an error — the correct behaviour after a scope revocation.

---

## 7. Detail rows & lineage

### `GET /api/v1/rows`

Role: analyst. The detail table. Server-side filter, sort and pagination.

| Query | Type | Notes |
|---|---|---|
| `grain` | enum | `pr_item` \| `po_line` \| `gr_posting`. Default `pr_item` |
| `q` | string | Free-text over description, material, vendor (trigram) |
| `sort` | string | Whitelisted fields only |
| plus the common filters (§1.8) | | |

```json
{
  "datasetVersionId": 41,
  "asOfDate": "2026-07-27",
  "grain": "po_line",
  "totalCount": 20804,
  "appliedFilters": { "excludeSto": false, "includeDeleted": false },
  "columns": [],
  "rows": [
    {
      "id": "1002119630|1",
      "poNo": "1002119630", "poItem": 1,
      "prNo": null, "prItem": null, "linkStatus": null,
      "shortText": "BIAYA PENGIRIMAN BARANG EUP TJ PURA",
      "vendorCode": "LN12000095", "vendorName": "MANDIRI JAYA SELARAS PT.",
      "plant": "EU93", "docType": "EU21", "isSto": false,
      "orderQty": 1, "netPrice": 3250000, "priceUnit": 1, "unitPrice": 3250000,
      "currencyCode": "IDR", "netOrderValue": 3250000, "netOrderValueUsd": 180.72,
      "fxPeriod": "2026-01", "fxDerivation": "direct",
      "documentDate": "2026-01-01", "deliveryDate": "2026-01-05",
      "poReleaseState": "approved", "releaseExempt": false,
      "receiptDate": null, "receiptQtyNet": null, "grCompletionPct": 0,
      "status": "PO-No GR", "agingDays": 208,
      "flags": ["directPo"]
    }
  ],
  "nextCursor": "eyJpZCI6…"
}
```

Note `prNo: null` — a direct PO. **43.7% of PO lines are direct** and appear here as first-class rows, not only in fallback popups as in v1.

### `GET /api/v1/rows/{grain}/{id}/lineage`

Role: analyst. Row provenance — the Auditor persona's evidence path.

```json
{
  "grain": "po_line",
  "id": "1002119630|1",
  "datasetVersionId": 41,
  "batchId": 118,
  "source": {
    "feed": "po",
    "filename": "PO Report EU 1 Jan 2026 31 July 2026.XLSX",
    "sheet": "Sheet1",
    "sourceRow": 4,
    "sha256": "c91e4a77…",
    "sourceKind": "synology",
    "ingestedAt": "2026-07-30T02:12:41Z"
  },
  "derivations": [
    { "field": "isSto",             "rule": "sto.endsWith",        "inputs": { "docType": "EU21", "suffix": "70" },                       "result": false },
    { "field": "poReleaseState",    "rule": "status.poReleaseState","inputs": { "deletionIndicator": null, "releaseIndicator": "2", "releaseGroup": "HO" }, "result": "approved" },
    { "field": "netOrderValueUsd",  "rule": "fx.periodMatched",     "inputs": { "amount": 3250000, "currency": "IDR", "period": "2026-01", "usdPerUnit": 5.561e-5 }, "result": 180.72 },
    { "field": "receiptDate",       "rule": "gr.min101",            "inputs": { "postings": 0 },                                          "result": null },
    { "field": "agingDays",         "rule": "aging.fromAsOf",       "inputs": { "asOfDate": "2026-07-27", "refDate": "2026-01-01" },       "result": 208 }
  ],
  "rawPayload": { "Purchasing Document": "1002119630", "Item": "1" }
}
```

`rawPayload` is the staging row exactly as received. `derivations` names the rule function that produced each derived field — so "why does this say 208 days" is answerable without reading code.

---

## 8. Entity views

### `GET /api/v1/entity/vendor/{vendorCode}`

Role: analyst.

```json
{
  "datasetVersionId": 41,
  "vendorCode": "LN12000179",
  "vendorName": "MAXIMA LINERS PT.",
  "bio": {
    "firstSeen": "2026-01-01", "lastSeen": "2026-07-21",
    "poCount": 47, "lineCount": 112,
    "spendUsd": 1284933.11,
    "spendByCurrency": [
      { "currency": "IDR", "amount": 21894330000, "amountUsd": 1217593.11, "rated": true },
      { "currency": "CNY", "amount": 457200,      "amountUsd":   67340.00, "rated": true }
    ],
    "currencyBasis": "usd_strict",
    "onTimeDeliveryPct": 71.4,
    "onTimeCaveat": "EINDT equals document date on 37.4% of this vendor's lines",
    "reversalRatePct": 1.8
  },
  "spendByMonth": [{ "monthKey": "2026-01", "amountUsd": 198640.60, "drillToken": "eyJ…" }],
  "topMaterials": [
    { "materialCode": "929.001.005", "description": "BIOSOLAR (INDUSTRI)",
      "lineCount": 31, "amountUsd": 604211.02, "drillToken": "eyJ…" }
  ]
}
```

If any currency is unrated, `spendUsd` is `null`, `currencyBasis` becomes `per_currency`, and the unrated entries carry `"rated": false` with `amountUsd: null`. The bio never silently converts.

### `GET /api/v1/entity/material/{materialCode}`

Role: analyst. Full PO history, deduped, newest first.

```json
{
  "datasetVersionId": 41,
  "materialCode": "956.201.028",
  "description": "UPS ICA-1082B 2000VA 1000W 165-250VAC 50",
  "materialGroup": "956",
  "kpis": { "lineCount": 14, "vendorCount": 3, "totalQty": 22,
            "avgUnitPriceUsd": 129.32, "priceTrendPct": 4.1 },
  "vendorShare":  [{ "vendorCode": "LN11000132", "vendorName": "SLS BEARINDO PT", "sharePct": 57.1 }],
  "poHistory": [
    {
      "poNo": "1007006562", "poItem": 1, "documentDate": "2026-01-01",
      "vendorCode": null, "vendorName": "EU73 EUP GENERAL TJ.PURA",
      "qty": 2, "unit": "UN",
      "netPrice": 0, "priceUnit": 1, "unitPrice": null,
      "currencyCode": "IDR", "netOrderValue": 0, "netOrderValueUsd": null,
      "status": "Delivered", "receiptDate": "2026-01-06",
      "flags": ["sto"],
      "note": "Stock transport order — unpriced, excluded from price analytics"
    }
  ]
}
```

STO lines appear in history for completeness, tagged `sto`, with `unitPrice: null` — visible but never contributing to price statistics.

### `GET /api/v1/entity/category/{materialGroup}`

Role: analyst. Level-2 grouping, spend, vendor concentration, quantity trend, cycle-time medians.

---

## 9. Export

Asynchronous — no request holds a connection for minutes.

### `POST /api/v1/export`

Role: analyst.

```json
{
  "kind": "rows",
  "grain": "po_line",
  "format": "xlsx",
  "filters": { "plant": ["EU71"], "status": ["PO-No GR"] },
  "columns": ["poNo", "poItem", "vendorName", "netOrderValue", "currencyCode", "status", "agingDays"]
}
```

`kind` ∈ `rows` | `drill` | `kpi_summary` | `validation_report`. For `drill`, supply `drillToken` instead of filters.

**202**

```json
{ "jobId": "exp_01J9Z8…", "status": "queued", "estimatedRows": 3184 }
```

### `GET /api/v1/export/{jobId}`

```json
{
  "jobId": "exp_01J9Z8…", "status": "ready",
  "rowCount": 3184, "byteSize": 412880,
  "downloadUrl": "/api/v1/export/exp_01J9Z8…/download?t=…",
  "expiresAt": "2026-07-30T03:20:00Z"
}
```

`status` ∈ `queued` | `running` | `ready` | `failed` | `expired`. `downloadUrl` is single-use and expires in 15 minutes.

Every export includes a **header sheet** recording dataset version, as-of date, applied filters, the caller's scope, the rule snapshot and the generation timestamp — so a spreadsheet circulating by email still states what it is.

**Formula-injection neutralisation is mandatory.** Any cell value beginning `=`, `+`, `-`, `@`, tab or carriage return is prefixed with an apostrophe. SAP free-text fields contain user-entered content, and a CSV opened in Excel is a code-execution path. Asserted in tests.

All exports are audited: actor, filters, scope, row count.

---

## 10. Ingestion

### `GET /api/v1/ingest/batches`

Role: analyst.

```json
{
  "batches": [
    { "id": 118, "sourceKind": "synology", "state": "PUBLISHED", "submittedBy": null,
      "startedAt": "2026-07-30T02:10:03Z", "finishedAt": "2026-07-30T02:15:22Z",
      "datasetVersionId": 41, "fileCount": 6,
      "findingCounts": { "blocker": 0, "caveat": 1, "warning": 6, "info": 12 } },
    { "id": 117, "sourceKind": "synology", "state": "FAILED", "submittedBy": null,
      "startedAt": "2026-07-29T14:40:01Z", "finishedAt": "2026-07-29T14:41:12Z",
      "failureReason": "1 blocker(s): V-S02 required column 'Net Order Value' unresolvable in PO Report",
      "fileCount": 6, "findingCounts": { "blocker": 1, "caveat": 0, "warning": 3, "info": 6 } }
  ],
  "nextCursor": null
}
```

### `GET /api/v1/ingest/batches/{id}`

Role: analyst. Per-file results, per-stage timings, findings.

```json
{
  "id": 118, "sourceKind": "synology", "sourceDetail": "/mnt/sap_exports",
  "state": "PUBLISHED", "bundleHash": "4f1a…",
  "timings": { "scanning": 8.2, "parsing": 61.4, "validating": 19.7, "transforming": 128.3, "publishing": 0.9 },
  "files": [
    { "id": 701, "originalFilename": "PO Report EU 1 Jan 2026 31 July 2026.XLSX",
      "sheetName": "Sheet1", "byteSize": 5705186, "sha256": "c91e4a77…",
      "detectedFeed": "po", "templateVersionId": 3, "matchOutcome": "exact",
      "rowCount": 20804, "avScanResult": "clean" }
  ],
  "findings": []
}
```

`matchOutcome` ∈ `exact` | `healed` | `drift` | `unrecognised`. A `healed` match lists which aliases or steward mappings fired.

### `POST /api/v1/ingest/upload`

Role: steward. `multipart/form-data`, field `files` (1–6).

Server-side gates run in order — extension, magic bytes (`PK\x03\x04` plus `[Content_Types].xml`), size, ClamAV, XLSX safety limits, then header-signature classification. Client-side checks are advisory only.

**201**

```json
{
  "batchId": 119, "state": "DISCOVERED",
  "files": [
    { "originalFilename": "PR Report EU 1 Jan 2026 31 July 2026.XLSX",
      "detectedFeed": "pr", "matchOutcome": "exact", "rowCount": 20110, "byteSize": 2850316 },
    { "originalFilename": "budget-draft.xlsx",
      "detectedFeed": null, "matchOutcome": "unrecognised", "rowCount": null, "byteSize": 18422 }
  ],
  "bundleComplete": false,
  "missingFeeds": ["prel", "po", "por", "gr", "fx"],
  "requiresConfirmation": true
}
```

Nothing is processed until confirmed. The unrecognised file is reported, never forced into a feed slot.

`originalFilename` is user-supplied — escape it before rendering.

**Errors**

| Status | Type |
|---|---|
| 400 | `upload-invalid-extension`, `upload-too-many-files`, `upload-not-xlsx` |
| 413 | `upload-too-large` |
| 422 | `upload-virus-detected`, `upload-unsafe-workbook` |

### `POST /api/v1/ingest/batches/{id}/confirm`

Role: steward.

```json
{ "mode": "full_replace" }
```

`mode` ∈ `full_replace` (default) | `replace_selected_feeds`. The latter forks the published version, substitutes only the named feeds, and **re-runs transformation and validation in full** — it is not a partial update. It requires `feeds: ["po", "gr"]` and is separately audited.

**202** `{ "batchId": 119, "state": "SCANNING" }`

**409** `batch-not-confirmable` if already terminal, or `batch-queue-busy` with `queuePosition` if another batch is transforming.

### `POST /api/v1/ingest/batches/{id}/cancel`

Role: steward. Cancels before publish; discards staged data. **204**. **409** `batch-not-cancellable` once publishing has begun — the API does not pretend a publish can be half-stopped.

### `POST /api/v1/ingest/sync`

Role: steward. Triggers a Synology poll immediately.

```json
{ "outcome": "started", "batchId": 120 }
```

`outcome` ∈ `started` | `noop_unchanged` | `incomplete_bundle` | `source_unavailable`. `noop_unchanged` is the normal, healthy answer when nothing new has landed.

### `POST /api/v1/dataset/{id}/publish`

Role: **admin**. Publishes a `READY` version. **200** with the new `dataset/current` payload. **409** `version-not-ready`.

### `POST /api/v1/dataset/{id}/rollback`

Role: **admin**.

```json
{ "reason": "GR feed truncated in the 07:00 export" }
```

`reason` is required, audited, and included in the `data.rolled_back` notification. **200** with the new `dataset/current` payload. Target ≤ 2 minutes end to end.

---

## 11. Administration

All admin endpoints require `admin` unless noted, and every mutation is audited with before/after values.

### Users & access

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/admin/users` | List; filter by role, scope, auth method, active |
| `POST` | `/api/v1/admin/users` | Create a local account (requires `approvalNote` and `expiresAt`) |
| `PATCH` | `/api/v1/admin/users/{id}` | Activate/deactivate, rename |
| `PUT` | `/api/v1/admin/users/{id}/roles` | Replace role assignment |
| `PUT` | `/api/v1/admin/users/{id}/scopes` | Replace data scope |
| `POST` | `/api/v1/admin/users/{id}/revoke-sessions` | Immediate revocation of all sessions |
| `POST` | `/api/v1/admin/users/{id}/reset-mfa` | Clear TOTP enrolment |

```json
PUT /api/v1/admin/users/8f3e…/scopes
{
  "scopes": [
    { "companyCode": "EU", "plant": "EU71", "purchOrg": "*" },
    { "companyCode": "EU", "plant": "EU73", "purchOrg": "*" }
  ]
}
```

Granting `{"companyCode":"*","plant":"*","purchOrg":"*"}` is itself an audited privilege and requires a `justification`.

### Business rules

| Method | Path |
|---|---|
| `GET` | `/api/v1/admin/rules` |
| `PUT` | `/api/v1/admin/rules/{ruleKey}` |
| `GET` | `/api/v1/admin/rules/{ruleKey}/history` |

```json
PUT /api/v1/admin/rules/wbs.material_threshold_idr
{ "value": 50000000, "effectiveFrom": "2026-09-01", "note": "Board revision Aug 2026" }
```

```json
{
  "ruleKey": "wbs.material_threshold_idr",
  "value": 50000000,
  "effectiveFrom": "2026-09-01",
  "appliesFromNextPublish": true,
  "publishedVersionsUnaffected": true
}
```

Editable keys: `wbs.material_threshold_idr`, `wbs.service_threshold_idr`, `wbs.basis`, `sto.doctype_suffix`, `aging.threshold_days`, `fx.policy`, `release.no_strategy_policy`, `asof.source`, `freshness.ageing_days`, `freshness.stale_days`, plus exclusion lists.

Changing a rule never alters published versions — each carries its own `ruleSnapshot`. A separate audited action recomputes the current version if immediate effect is wanted.

### Templates

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/admin/templates` | steward | Contract versions per feed |
| `GET` | `/api/v1/admin/templates/{feed}/{version}` | steward | Column list, aliases, mappings |
| `POST` | `/api/v1/admin/templates/{feed}/versions` | steward | New contract version |
| `PUT` | `/api/v1/admin/templates/{feed}/{version}/activate` | admin | Make active |
| `PUT` | `/api/v1/admin/templates/{feed}/{version}/mappings` | steward | Steward column mappings |
| `GET` | `/api/v1/admin/templates/{feed}/blank` | steward | Download a blank template (XLSX) generated from the active contract |

### Notifications

| Method | Path |
|---|---|
| `GET` | `/api/v1/admin/notifications/events` |
| `GET` | `/api/v1/admin/notifications/subscriptions` |
| `POST` | `/api/v1/admin/notifications/subscriptions` |
| `PATCH` | `/api/v1/admin/notifications/subscriptions/{id}` |
| `DELETE` | `/api/v1/admin/notifications/subscriptions/{id}` |
| `POST` | `/api/v1/admin/notifications/test` |
| `GET` | `/api/v1/admin/notifications/deliveries` |

```json
POST /api/v1/admin/notifications/subscriptions
{
  "eventCode": "data.published",
  "userId": "8f3e1c22-…",
  "companyCode": "EU", "plant": "EU71", "purchOrg": "*",
  "deliveryMode": "digest",
  "digestAt": "07:00",
  "severityFloor": "info",
  "quietFrom": "19:00",
  "quietTo": "07:00"
}
```

An external address requires `externalEmail` plus `approvalNote`, is flagged `isExternal`, and represents data egress — audited as such.

```json
GET /api/v1/admin/notifications/deliveries?eventCode=data.published&status=failed
{
  "deliveries": [
    { "id": 9012, "eventCode": "data.published", "recipientEmail": "ops@energi-up.com",
      "datasetVersionId": 41, "status": "failed", "attemptCount": 5,
      "smtpResponse": "451 Temporary local problem",
      "queuedAt": "2026-07-30T02:15:31Z", "sentAt": null }
  ]
}
```

`POST /api/v1/admin/notifications/test` sends a clearly-marked sample to one subscription and is audited.

### System

| Method | Path | Purpose |
|---|---|---|
| `GET` / `PUT` | `/api/v1/admin/smtp` | SMTP settings. `password` is write-only and never returned |
| `GET` | `/api/v1/admin/source` | Synology mount status, last poll, last bundle hash |
| `GET` / `PUT` | `/api/v1/admin/retention` | Retained version count |

---

## 12. Audit

### `GET /api/v1/audit`

Role: auditor or admin.

| Query | Type |
|---|---|
| `action` | string, repeatable |
| `actorUserId` | uuid |
| `objectType`, `objectId` | string |
| `outcome` | `success` \| `failure` \| `denied` |
| `from`, `to` | ISO timestamp |

```json
{
  "entries": [
    { "id": 884213, "occurredAt": "2026-07-30T02:15:22Z", "actorUserId": null, "actorEmail": null,
      "actorIp": null, "action": "dataset.publish", "objectType": "dataset_version", "objectId": "41",
      "outcome": "success", "detail": { "sourceKind": "synology", "batchId": 118 },
      "requestId": "req_01J9Z…" },
    { "id": 884198, "occurredAt": "2026-07-30T01:58:11Z", "actorEmail": "jerry.hakim@energi-up.com",
      "actorIp": "10.4.12.88", "action": "admin.rule.update", "objectType": "rule_config",
      "objectId": "wbs.material_threshold_idr", "outcome": "success",
      "detail": { "before": 30000000, "after": 50000000, "effectiveFrom": "2026-09-01" } }
  ],
  "nextCursor": "eyJpZCI6…"
}
```

Append-only and hash-chained. There is no write, update or delete endpoint.

### `GET /api/v1/audit/verify`

Role: admin. Verifies the hash chain.

```json
{ "verified": true, "entriesChecked": 884213, "firstBreakAtId": null, "checkedAt": "2026-07-30T03:00:00Z" }
```

---

## 13. Health

### `GET /api/v1/health`

Public. Liveness only — no internal detail, safe to expose to a load balancer.

```json
{ "status": "ok", "version": "2.0.4", "gitSha": "a1b2c3d", "builtAt": "2026-07-28T09:12:00Z" }
```

### `GET /api/v1/ready`

Internal network only. Readiness with dependency probes.

```json
{
  "status": "degraded",
  "checks": [
    { "name": "database",      "status": "ok",   "latencyMs": 3 },
    { "name": "redis",         "status": "ok",   "latencyMs": 1 },
    { "name": "nas_mount",     "status": "fail", "detail": "/mnt/sap_exports not readable" },
    { "name": "oidc_discovery","status": "ok",   "latencyMs": 118 },
    { "name": "smtp",          "status": "ok",   "latencyMs": 42 }
  ]
}
```

**503** when `status` is `fail`; **200** when `degraded`. A NAS outage degrades ingestion but must not take the dashboard offline — users can still read the last published version, correctly labelled with its as-of date.

---

## 14. Error catalogue

RFC 9457 `application/problem+json`:

```json
{
  "type": "https://procurement.energi-up.com/problems/scope-empty",
  "title": "No data access granted",
  "status": 403,
  "detail": "Your account has no data scope. Ask an administrator to grant access.",
  "requestId": "req_01J9Z8…"
}
```

| Status | `type` | Meaning |
|---|---|---|
| 400 | `invalid-parameter` | Unknown or malformed query parameter (unknown parameters are rejected, not ignored) |
| 400 | `invalid-body` | Request body failed schema validation |
| 401 | `not-authenticated` | No valid session |
| 401 | `session-expired` | Idle or absolute timeout reached |
| 401 | `invalid-credentials` | Local login failed |
| 401 | `invalid-mfa-code` | TOTP rejected |
| 401 | `drill-token-expired` | Re-fetch the aggregate for a fresh token |
| 401 | `drill-token-invalid` | Malformed or undecryptable |
| 403 | `insufficient-role` | Role rank below the endpoint requirement |
| 403 | `scope-empty` | Authenticated but no data scope granted |
| 403 | `drill-token-foreign` | Token belongs to another session; audited |
| 403 | `external-recipient-unapproved` | External notification address lacks approval |
| 404 | `not-found` | Resource does not exist, or is outside the caller's scope |
| 409 | `version-not-ready` | Publish attempted on a non-`READY` version |
| 409 | `batch-not-confirmable` | Batch already in a terminal state |
| 409 | `batch-not-cancellable` | Publishing has begun |
| 409 | `batch-queue-busy` | Another batch is transforming; `queuePosition` included |
| 413 | `upload-too-large` | Exceeds the per-file or per-batch cap |
| 422 | `upload-not-xlsx` | Magic-byte check failed |
| 422 | `upload-virus-detected` | ClamAV positive; file quarantined |
| 422 | `upload-unsafe-workbook` | Zip-bomb ratio, cell count, or external references |
| 423 | `account-locked` | Too many failed local logins |
| 429 | `rate-limited` | `Retry-After` header included |
| 503 | `source-unavailable` | Synology mount unreachable |
| 503 | `not-ready` | A required dependency is failing |

`404` is deliberately returned for resources outside the caller's scope, so the API does not confirm the existence of documents a user may not see.

---

## 15. Rate limits

| Scope | Limit |
|---|---|
| Reads per session | 100 / minute |
| `POST /auth/local/login` per IP | 10 / minute, then lockout |
| `POST /api/v1/export` per session | 10 / minute |
| `POST /api/v1/ingest/upload` per session | 5 / hour |
| `POST /api/v1/ingest/sync` per session | 6 / hour |
| `POST /api/v1/admin/notifications/test` per session | 10 / hour |

Exceeding a limit returns **429** with `Retry-After`. Limits are enforced in Redis, so they hold across backend processes.

---

*End of TECH 02. See [TECH 01 — Architecture](TECH_01_Architecture_and_Implementation.md) and [TECH 03 — Deployment & Operations](TECH_03_Deployment_and_Operations.md).*
