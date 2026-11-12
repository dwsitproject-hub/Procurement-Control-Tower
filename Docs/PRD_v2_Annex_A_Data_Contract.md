# Annex A — Data Contract & Template Specification

**Parent document:** [PRD v2 — Production](PRD_v2_Production.md) · **Version** 2.0 · **Date** 30 July 2026

This annex is the authoritative specification of the six upload templates. It **replaces §6 of PRD v1**, which described the feeds in prose and, in at least two places, incorrectly.

Every column list, type, nullability figure, domain value and cardinality below was measured from the files in `Assets/` (EU entity, 1 Jan – 27 Jul 2026). Percentages are the share of **blank** values unless stated otherwise.

---

## Contents

- [A.1 Conventions](#a1-conventions)
- [A.2 Feed 1 — PR Report](#a2-feed-1--pr-report)
- [A.3 Feed 2 — PR Release](#a3-feed-2--pr-release)
- [A.4 Feed 3 — PO Report](#a4-feed-3--po-report)
- [A.5 Feed 4 — PO Release](#a5-feed-4--po-release)
- [A.6 Feed 5 — GR List](#a6-feed-5--gr-list)
- [A.7 Feed 6 — FX Rate table](#a7-feed-6--fx-rate-table)
- [A.8 Header signatures](#a8-header-signatures)
- [A.9 Sentinel & coercion rules](#a9-sentinel--coercion-rules)
- [A.10 Semantic assertions](#a10-semantic-assertions)
- [A.11 Cross-feed referential rules](#a11-cross-feed-referential-rules)
- [A.12 Known dead columns](#a12-known-dead-columns)
- [A.13 Feeds 7-10 — SAP reference exports (optional)](#a13-feeds-7-10--sap-reference-exports-optional)

---

## A.1 Conventions

### Column status

| Status | Meaning |
|---|---|
| **PK** | Part of the primary key. Must be present and non-blank on every row. |
| **REQ** | Required. Absence is a `BLOCKER`; blank values are permitted only where the nullability column says so. |
| **OPT** | Optional. Absence produces a `WARNING` and disables dependent features gracefully. |
| **IGN** | Present in the export, ingested for lineage, not used analytically. |
| **DEAD** | Present but carries no information in the current export (100% blank or single-valued). Ingested but never read. |

### Types

`str` · `int` · `dec(p,s)` · `date` (no time component) · `time` · `bool` · `enum`

All files are single-sheet XLSX. Header is row 1. Data starts at row 2. No merged cells in the header. No subtotal or footer rows.

### General rules

1. **Files are classified by header signature, never by filename.** Current filenames embed a date range that changes every refresh.
2. Header matching normalises to lowercase and strips all non-alphanumeric characters: `Deliv. date(From/to)` → `delivdatefromto`.
3. Column **order is not significant**. Position is used only as a guarded last resort (see A.8).
4. Every ingested row retains `source_file`, `source_sheet` and `source_row` for lineage.
5. Encoding is UTF-8 throughout. Data content is mixed Indonesian and English.

---

## A.2 Feed 1 — PR Report

| | |
|---|---|
| **Source** | SAP ME5A (list of purchase requisitions) |
| **Sample file** | `PR Report EU 1 Jan 2026 31 July 2026.XLSX` |
| **Rows** | 20,110 · **Columns** 28 |
| **Primary key** | `Purchase Requisition` + `Item of requisition` — **verified unique, 0 duplicates** |
| **Grain** | One row per PR item |
| **Role** | Demand backbone; WBS/AR policy input; urgency and requisitioner analytics |

| # | Column | Type | Status | Blank % | Distinct | Notes |
|--:|---|---|:--:|--:|--:|---|
| 1 | `Purchase Requisition` | str | **PK** | 0 | 1,479 | 10-digit document number; keep as string, never numeric |
| 2 | `Item of requisition` | int | **PK** | 0 | 380 | |
| 3 | `Material` | str | REQ | **13.95** | 8,934 | **Blank = service item** (2,805 items). This is the material/service discriminator for the WBS rule |
| 4 | `Requirement Urgency` | enum | REQ | 0 | 5 | `3` 15,068 · `2` 4,437 · `0` 277 · `1` 224 · `4` 104. Urgent = {1,2}; `0` is undefined and excluded from expedite arms |
| 5 | `Requirement Priority` | enum | OPT | 0 | 5 | Identical distribution to `Requirement Urgency` in current data — verify before relying on it as an independent field |
| 6 | `Short Text` | str | REQ | 0 | 11,110 | Item description |
| 7 | `Quantity requested` | dec(18,3) | REQ | 0 | 432 | |
| 8 | `Unit of Measure` | str | REQ | 0 | 28 | |
| 9 | `Requisitioner` | str | REQ | 0 | **368** | ⚠️ **Personal data** — see PRD §19.7 |
| 10 | `Plant` | str | REQ | 0 | **19** | Drives data scope |
| 11 | `Purchasing Group` | str | REQ | 0 | 17 | |
| 12 | `Valuation Price` | dec(18,2) | REQ | 0 | 5,764 | **2,744 rows (13.6%) are zero** |
| 13 | `Total Value` | dec(18,2) | REQ | 0 | 7,107 | **4,211 rows (20.9%) are zero** → WBS `indeterminate` bucket. IDR |
| 14 | `Purch. organization` | str | REQ | 0 | **12** | Drives data scope |
| 15 | `Created by` | str | IGN | 0 | 44 | ⚠️ Personal data |
| 16 | `Requisition date` | date | REQ | 0 | 394 | Range 2023-12-26 → 2026-07-27. Includes open backlog older than the window — correct and expected |
| 17 | `Release indicator` | enum | REQ | 0 | 2 | `2` 19,491 · `X` 619 |
| 18 | `Deletion indicator` | bool | REQ | 0 | 2 | Literal `true` / `false` strings. `true` = 1,853 (9.2%) |
| 19 | `Document Type` | enum | REQ | 0 | 2 | `EUNB` 19,928 · `EUEM` 182 |
| 20 | `Material Group` | str | REQ | 0 | 83 | Category grouping |
| 21 | `Batch` | str | DEAD | 95.7 | 2 | |
| 22 | `Delivery` | str | **DEAD** | **100** | 0 | Entirely empty |
| 23 | `Deliv. date(From/to)` | date | OPT | 0 | 422 | 🔴 **Not a delivery date in this export.** See A.10 / V-M01 |
| 24 | `Closed` | str | DEAD | 98.9 | 1 | |
| 25 | `Goods receipt` | str | **DEAD** | 0 | **1** | Single value `Yes` on all 20,110 rows — carries no information |
| 26 | `Release strategy` | str | OPT | 0 | 8 | |
| 27 | `Release Date` | date | REQ | 0 | 415 | |
| 28 | `WBS Element` | str | OPT | **88.9** | 425 | Only 2,233 rows (11.1%) populated. Powers the WBS/AR compliance card |

### A.2.1 Requested column additions

| Column | SAP field | Status | Why |
|---|---|---|---|
| **Deliv. date** | `EBAN-LFDAT` | **Required** | The genuine item need-by date. Without it Demand Realism (PRD §13.1) cannot be computed. The existing `Deliv. date(From/to)` column is not this field — it equals `Release Date` on 99.40% of rows. |
| **Deliv. date cat.** | `EBAN-LPEIN` | Requested | Delivery-date category (day / week / month). If requesters express need-by as a week or month, the analytics must know the granularity rather than implying false day-level precision. |

Full change request, worked example, SAP GUI steps and verification method: **PRD §13.1.1**. Decision D4.

When `EBAN-LFDAT` arrives it populates `core.fact_pr_item.need_by_date`. The existing column continues to load into `deliv_date_raw` for lineage and comparison. Assertion V-M01 gates activation, so a cosmetic change that still mirrors `Release Date` cannot silently enable a fake KPI.

---

## A.3 Feed 2 — PR Release

| | |
|---|---|
| **Source** | SAP PR release-strategy list |
| **Sample file** | `PR Release EU 1 Jan 2026 31 July 2026.XLSX` |
| **Rows** | 27,742 · **Columns** 20 |
| **Primary key** | `PR No` + `PR Item` + `Rel Seq` — unique **only after continuation-row resolution** |
| **Grain** | One row per release event (PR item × release sequence) |
| **Role** | Approval flow, bottleneck analysis, pending queues |

| # | Column | Type | Status | Blank % | Distinct | Notes |
|--:|---|---|:--:|--:|--:|---|
| 1 | `Doc Type` | enum | REQ | 48.1 | 2 | Blank on continuation rows |
| 2 | `PR No` | str | **PK** | **48.1** | 1,251 | **Blank on all 13,338 continuation rows** — see A.3.1 |
| 3 | `PR Created Date` | date | REQ | 48.1 | 315 | Blank on continuation rows |
| 4 | `PR Item` | int | **PK** | 0 | 378 | ⚠️ **Literal `0` on continuation rows** — a sentinel, not a value |
| 5 | `Plant` | str | REQ | 48.1 | 18 | |
| 6 | `Pur.Org` | str | REQ | 48.1 | 11 | |
| 7 | `Material` | str | OPT | 56.3 | 6,893 | |
| 8 | `Short Text` | str | REQ | 48.1 | 8,524 | |
| 9 | `Material Group` | str | REQ | 48.1 | 83 | |
| 10 | `Qty` | dec(18,3) | OPT | 0 | 351 | ⚠️ Literal `0` on continuation rows |
| 11 | `UOM` | str | REQ | 48.1 | 26 | Blank on continuation rows |
| 12 | `Status` | enum | REQ | 0 | 2 | `Release` 27,560 · `Outstanding` 182 |
| 13 | `Rel Seq` | int | **PK** | 0 | 2 | `1` 14,404 · `2` 13,338 |
| 14 | `Rel Code` | str | REQ | 0 | 6 | See A.3.2 |
| 15 | `PIC Release` | str | REQ | 0 | 6 | Approver role name — safe to display |
| 16 | `Login Name` | str | REQ | 0.7 | 17 | ⚠️ **Personal data — ingested, never displayed** below Auditor |
| 17 | `Approve Date` | date | OPT | 0.7 | 285 | Blank = not yet approved at this level |
| 18 | `Approve Time` | time | OPT | 0 | 6,826 | |
| 19 | `Approved Lead Time - PR Created` | int | IGN | 0 | 52 | SAP-precomputed; recomputed independently |
| 20 | `GAP Approval Lead Time` | int | IGN | 0 | 51 | SAP-precomputed |

### A.3.1 Continuation rows — mandatory handling

**48% of this feed (13,338 rows) is unidentifiable as delivered.** The export is in SAP's grouped/merged format: a release-sequence-2 row leaves its identifying columns blank because they are visually merged with the parent row above.

Measured shape of the continuation block:

| Column | Populated in seq-2 rows |
|---|---|
| `PR Item`, `Qty`, `Status`, `Rel Seq`, `Rel Code`, `PIC Release`, `Approve Time`, lead times | 100% — but `PR Item` and `Qty` are **literal `0`** |
| `Login Name`, `Approve Date` | 99.26% |
| `PR No`, `PR Created Date`, `Doc Type`, `Plant`, `Pur.Org`, `Material`, `Short Text`, `Material Group`, `UOM` | **0%** |

Observed arrangement (rows 111–118 of the sample file):

```
row   PR No        Created      Item  Qty  Seq  Code  PIC Release           Approve Date
111   1000008301   2025-04-10     1     8    1    25   HQ-Project Div Head   2025-04-10
112   (blank)      (blank)        0     0    2    11   Head Unit Legacy      2025-04-14
113   1000008301   2025-04-10     2     6    1    25   HQ-Project Div Head   2025-04-10
114   (blank)      (blank)        0     0    2    11   Head Unit Legacy      2025-04-14
```

**Required resolution:**

1. Treat blank `PR No` **and** `PR Item = 0` **and** `Qty = 0` as the continuation-row signature.
2. Forward-fill `PR No`, `PR Item`, `PR Created Date`, `Doc Type`, `Plant`, `Pur.Org`, `Material`, `Short Text`, `Material Group`, `UOM` from the most recent non-continuation row.
3. **Validate, do not assume** — this is `BLOCKER` V-R04:
   - Every continuation row must be immediately preceded by a `Rel Seq = 1` row. *Measured: 0 violations.*
   - After filling, `(PR No, PR Item, Rel Seq)` must be unique. *Measured: 0 duplicates.*
   - `WARNING` V-R05: L2 `Approve Date` ≥ L1 `Approve Date`. *Measured: 0 violations.*

The v1 prototype performed the forward-fill correctly but without any of these guards, and only handled `PR Item = 0` because JavaScript treats `Number('0')` as falsy — accidental correctness. An export re-sort would silently reattach every level-2 approval to the wrong PR. **The guards are the requirement; the fill is the mechanism.**

### A.3.2 Release sequences and codes

| Rel Seq | Rel Code | PIC Release | Rows |
|:--:|:--:|---|--:|
| 1 | `25` | HQ-Project Div Head | 13,338 |
| 1 | `19` | HQ-Head Dept. HRGA | 546 |
| 1 | `02` | HQ-Asst Mgr Log Exim | 417 |
| 1 | `01` | HQ-Asst Mgr Log Locl | 103 |
| 2 | `11` | Head Unit Legacy | 11,998 |
| 2 | `04` | HQ-Proj Mgr DWS | 1,340 |

Semantics: `Rel Seq 1` is the first approval level, `Rel Seq 2` the second. Final approval date = seq-2 date where a seq-2 row exists, otherwise the seq-1 date. A seq-2 row present with a blank `Approve Date` means not yet approved at level 2 — that is a genuine pending state (99 rows), distinct from having no level 2 at all.

---

## A.4 Feed 3 — PO Report

| | |
|---|---|
| **Source** | SAP ME2N (purchasing documents by document number) |
| **Sample file** | `PO Report EU 1 Jan 2026 31 July 2026.XLSX` |
| **Rows** | 20,804 · **Columns** 53 |
| **Primary key** | `Purchasing Document` + `Item` — **verified unique, 0 duplicates** |
| **Grain** | One row per PO line |
| **Role** | Order facts; authoritative PR link; STO identification; commitment and GR/IR exposure |

| # | Column | Type | Status | Blank % | Distinct | Notes |
|--:|---|---|:--:|--:|--:|---|
| 1 | `Deletion indicator` | enum | REQ | 94.4 | 1 | `L` = deleted, 1,168 lines (5.6%). **This is the deletion source — not a blank release indicator** |
| 2 | `Purchasing Document` | str | **PK** | 0 | 9,519 | |
| 3 | `Item` | int | **PK** | 0 | 156 | |
| 4 | `Req. Tracking Number` | str | REQ | 68.9 | 2,005 | For STO lines carries the originating purchase PO. **100% populated on STO; 12.3% on non-STO** |
| 5 | `Purchasing Doc. Type` | enum | REQ | 0 | 7 | `EU20` 10,531 · `EU21` 5,808 · `EU70` 4,453 · `EO21` 4 · `SC21` 4 · `PS21` 2 · `JP21` 2. **Ends-with-`70` ⇒ STO** |
| 6 | `Purch. Doc. Category` | enum | IGN | 0 | 1 | `F` throughout |
| 7 | `Purchasing Group` | str | REQ | 0 | 28 | |
| 8 | `PO history/release documentation` | str | **DEAD** | **100** | 0 | |
| 9 | `Document Date` | date | REQ | 0 | 202 | Range 2026-01-01 → 2026-07-27. Aging basis; FX period basis |
| 10 | `Supplier/Supplying Plant` | str | REQ | 0 | 1,050 | Format `CODE  NAME`; for STO the supplying plant |
| 11 | `Material` | str | REQ | 28.1 | 6,253 | Blank = service line |
| 12 | `Short Text` | str | REQ | 0 | 9,751 | |
| 13 | `Acct Assignment Cat.` | enum | OPT | 60.7 | 3 | `U` 5,414 · `Q` 2,339 · `P` 414 |
| 14 | `Plant` | str | REQ | 0 | 17 | Data scope |
| 15 | `Order Quantity` | dec(18,3) | REQ | 0 | 614 | |
| 16 | `Stockkeeping unit` | str | OPT | 28.1 | 24 | |
| 17 | `Net Price` | dec(18,4) | REQ | 0 | 6,468 | **4,527 zeros total, of which 4,453 are STO** → 74 genuine non-STO zeros |
| 18 | `Price unit` | int | REQ | 0 | 47 | Price is per this many units. **398 lines have > 1** — unit price must divide by it. v1's PRD called this `Per` |
| 19 | `Still to be delivered (qty)` | dec(18,3) | REQ | 0 | 271 | |
| 20 | `Still to be delivered (value)` | dec(18,2) | REQ | 0 | 2,832 | Open commitment basis |
| 21 | `Still to be invoiced (qty)` | dec(18,3) | REQ | 0 | 276 | |
| 22 | `Still to be invoiced (val.)` | dec(18,2) | REQ | 0 | 2,712 | GR/IR exposure basis |
| 23 | `Purch. organization` | str | REQ | 0 | 11 | Data scope |
| 24 | `Item category` | enum | OPT | 0 | 3 | |
| 25 | `Purchasing info rec.` | str | IGN | 50.4 | 6,602 | |
| 26 | `Package number` | str | IGN | 0 | 5,828 | |
| 27 | `Release group` | str | REQ | **4.63** | 2 | ⚠️ **Blank on exactly the same 964 lines as `Release indicator`** — together they mean "no release strategy applies" |
| 28 | `Release Strategy` | str | OPT | 4.63 | 24 | |
| 29 | `Release State` | str | OPT | 5.14 | 4 | `X` 16,920 · `XX` 1,802 · `XXX` 787 · `XXXX` 226 |
| 30 | `Release indicator` | enum | REQ | **4.63** | 3 | `2` 19,722 · `X` 106 · `1` 12 · **blank 964**. See A.4.1 |
| 31 | `Order Price Unit` | str | OPT | 0 | 26 | |
| 32 | `Incomplete` | enum | OPT | 98.7 | 1 | `X` ⇒ HOLD PO |
| 33 | `Material Group` | str | REQ | 0 | 83 | |
| 34 | `Item Category` | str | OPT | 50.6 | 2 | |
| 35 | `Storage location` | str | OPT | 42.3 | 5 | |
| 36 | `Order Unit` | str | REQ | 0 | 27 | |
| 37 | `Quantity in SKU` | dec(18,3) | OPT | 0 | 616 | |
| 38 | `Currency` | enum | REQ | 0 | 8 | `IDR` 19,936 · `CNY` 432 · **`US$` 328** · `EUR` 39 · `SGD` 38 · `MYR` 26 · **`USD` 4** · `GBP` 1. ⚠️ `US$` and `USD` both occur — normalisation mandatory |
| 39 | `Outline agreement` | str | **DEAD** | **100** | 0 | |
| 40 | `Control indicator` | str | IGN | 78.6 | 1 | |
| 41 | `Name of Supplier` | str | REQ | 0 | 1,050 | Vendor display name |
| 42 | `Tax Code` | str | DEAD | 99.8 | 1 | |
| 43 | `Tax Jurisdiction` | str | **DEAD** | **100** | 0 | |
| 44 | `Net Order Value` | dec(18,2) | REQ | 0 | 7,574 | Line value in document currency |
| 45 | `Requirement Urgency` | enum | OPT | 0 | 5 | |
| 46 | `Reqmt Priority` | enum | OPT | 0 | 5 | |
| 47 | `Incoterms` | str | OPT | 80.5 | 11 | |
| 48 | `Incoterms (Part 2)` | str | OPT | 88.3 | 20 | |
| 49 | `Contract Ext` | str | **DEAD** | **100** | 0 | |
| 50 | `Created by` | str | IGN | 0 | 49 | ⚠️ Personal data |
| 51 | `Purchase Requisition` | str | REQ | **43.7** | 1,077 | PR link. Blank ⇒ direct PO (9,094 lines) |
| 52 | `Item of requisition` | int | REQ | 0 | 353 | ⚠️ **`'0'` is the null sentinel** — 9,094 rows, exactly matching the blank PR count. Must normalise to NULL |
| 53 | `Delivery date` | date | REQ | 0 | 355 | SAP EINDT. Range 2024-08-21 → 2027-06-30. **Equals `Document Date` on 37.4% of lines** — disclosed caveat on OTD analytics |

### A.4.1 Release-indicator semantics

| `Release indicator` | `Release group` | Lines | Meaning | v1 treatment | v2 treatment |
|---|---|--:|---|---|---|
| `1`, `2`, `C` | populated | 19,734 | Released / approved | approved ✓ | `approved` |
| `X` | populated | 106 | Pending release | not approved ✓ | `pending` |
| blank | **blank** | 964 | **No release strategy applies** | ❌ `PO-Deleted` | `not_subject_to_release` |

Of the 964 blank rows, 723 also carry `Deletion indicator = 'L'` and are genuinely deleted. The remaining **241 lines across 89 POs, IDR 1,506,586,519**, are live orders that v1 silently classified as deleted. Those 89 POs have **no record at all in PO Release**, so they can never be approved — classifying them as "pending" instead would strand them permanently.

**Resolution (decision D2, 30 Jul 2026): `flag_only`.** These lines keep `po_release_state = 'not_subject_to_release'` — never folded into approved or pending — carry a `release_exempt` flag rendered as a `⚑` marker on every surface, take their status from their receipt state, are excluded from the pending-approval queue, and remain fully included in open-pipeline, commitment and delivery analytics. Count and value are reported every load as `WARNING` V-B10. See PRD §12.4.

---

## A.5 Feed 4 — PO Release

| | |
|---|---|
| **Source** | SAP PO release-strategy list |
| **Sample file** | `PO Release EU 1 Jan 2026 31 July 2026.XLSX` |
| **Rows** | 10,807 · **Columns** 15 |
| **Primary key** | `PO No` + `Rel Seq` + `Rel Code` — **verified unique, 0 duplicates** |
| **Grain** | One row per PO release event |
| **Role** | PO approval flow, pending queue, approval lead time |

| # | Column | Type | Status | Blank % | Distinct | Notes |
|--:|---|---|:--:|--:|--:|---|
| 1 | `PO No` | str | **PK** | 0 | 8,994 | 0 orphans against PO Report |
| 2 | `PO Date` | date | REQ | 0 | 202 | |
| 3 | `PO Create Date` | date | REQ | 0 | 198 | |
| 4 | `Vendor` | str | REQ | 2.0 | 879 | Vendor code |
| 5 | `Vendor Name` | str | REQ | 2.0 | 879 | |
| 6 | `Company Code` | str | REQ | 0 | **1** | `EU` throughout. Data scope; designed for multiple values |
| 7 | `P.Org` | str | REQ | 0 | 11 | |
| 8 | `Ccy` | enum | REQ | 0 | 7 | `IDR` 10,191 · `CNY` 282 · `US$` 268 · `SGD` 33 · `MYR` 16 · `EUR` 16 · `GBP` 1 |
| 9 | `Amount` | dec(18,2) | REQ | 0 | 5,209 | Document-currency PO total |
| 10 | `Rel Seq` | int | **PK** | 0 | 4 | Up to 4 approval levels — deeper than PR |
| 11 | `Rel Code` | str | **PK** | 0 | 17 | |
| 12 | `PIC Release` | str | REQ | 0 | 18 | Approver role name — safe to display |
| 13 | `Login Name` | str | REQ | 0.5 | 23 | ⚠️ Personal data — not displayed below Auditor |
| 14 | `Approve Date` | date | OPT | 0.5 | 192 | Blank = pending. **55 rows / 53 POs pending** |
| 15 | `Approve Time` | time | OPT | 0 | 9,331 | |

**Note:** unlike PR Release, this feed has **no continuation-row problem** — every row carries its `PO No`. Do not apply the A.3.1 forward-fill here.

**Coverage gap:** 525 of 9,519 POs in PO Report (5.5%) have no PO Release record. 89 of those are the `not_subject_to_release` POs from A.4.1. Reported as `WARNING` V-B09.

---

## A.6 Feed 5 — GR List

| | |
|---|---|
| **Source** | SAP MB51 (material document list) |
| **Sample file** | `GR List EU 1 Jan 2026 31 July 2026.XLSX` |
| **Rows** | 28,897 · **Columns** 36 |
| **Primary key** | `Purchase order` + `Item` + `Material Document` + `Material Doc.Item` — **verified unique, 0 duplicates** |
| **Grain** | One row per material-document posting |
| **Role** | Receipt joining at PO-line level; reversal netting; in-transit analytics |

| # | Column | Type | Status | Blank % | Distinct | Notes |
|--:|---|---|:--:|--:|--:|---|
| 1 | `Purchase order` | str | **PK** | 0 | 6,989 | **0 orphans against PO Report** |
| 2 | `Item` | int | **PK** | 0 | 156 | |
| 3 | `Plant` | str | REQ | 0 | 15 | |
| 4 | `Storage location` | str | OPT | 38.0 | 8 | |
| 5 | `Movement type` | enum | REQ | 0 | 4 | `101` 19,200 · `641` 8,612 · `102` 741 · `642` 344. **`122` never occurs.** See A.6.1 |
| 6 | `Material` | str | OPT | 22.4 | 4,689 | |
| 7 | `Material description` | str | REQ | 0 | 7,148 | |
| 8 | `Entry Date` | date | IGN | 0 | 180 | System entry date |
| 9 | `Posting Date` | date | REQ | 0 | 206 | Range 2025-12-31 → 2026-07-27. **Receipt-date basis, but only for movement type `101`** |
| 10 | `Document Date` | date | OPT | 0 | 232 | |
| 11 | `Qty in unit of entry` | dec(18,3) | REQ | 0 | 1,243 | ✅ **The correct quantity column.** Zero on 0 rows. **Signed** — 5,219 negative rows |
| 12 | `Unit of Entry` | str | REQ | 0 | 33 | |
| 13 | `Batch` | str | OPT | 37.9 | 2,072 | |
| 14 | `Valuation Type` | str | OPT | 22.5 | 38 | |
| 15 | `Movement Type Text` | str | REQ | 0 | 14 | Human-readable movement description |
| 16 | `Material Document` | str | **PK** | 0 | 13,367 | |
| 17 | `User Name` | str | IGN | 0 | 38 | ⚠️ **Personal data** — not displayed below Auditor |
| 18 | `Amt.in Loc.Cur.` | dec(18,2) | REQ | 0 | 13,364 | 6,142 rows are zero |
| 19 | `Document Header Text` | str | OPT | 76.8 | 1,046 | |
| 20 | `Name 1` | str | OPT | 0 | 15 | Plant/supplier name |
| 21 | `Company Code` | str | REQ | 0 | **1** | `EU` |
| 22 | `Qty in OPUn` | dec(18,3) | OPT | 0 | 919 | Order price-unit quantity |
| 23 | `Order Price Unit` | str | OPT | 31.0 | 32 | |
| 24 | `Order Unit` | str | REQ | 0 | 33 | |
| 25 | `Qty in order unit` | dec(18,3) | OPT | 0 | 1,259 | |
| 26 | `Time of Entry` | time | IGN | 0 | 11,152 | |
| 27 | `Material Doc.Item` | int | **PK** | 0 | 78 | |
| 28 | `Ext. Amount in Local Currency` | dec | **DEAD** | 0 | **1** | All zero |
| 29 | `Sales Value` | dec | **DEAD** | 0 | **1** | All zero |
| 30 | `Movement indicator` | enum | OPT | 0 | 2 | |
| 31 | `Consumption` | str | OPT | 77.5 | 1 | |
| 32 | `Receipt Indicator` | str | OPT | 51.9 | 1 | |
| 33 | `Vendor` | str | OPT | 48.1 | 756 | |
| 34 | `Base Unit of Measure` | str | OPT | 22.4 | 23 | |
| 35 | `Quantity` | dec(18,3) | **IGN** | 0 | 1,237 | 🔴 **Do NOT use.** Zero on **6,485 rows (22.4%)** and differs from column 11 on 6,562 rows. PRD v1 nominated this column; following that would zero out 22% of receipts |
| 36 | `Sales Value inc. VAT` | dec | **DEAD** | 0 | **1** | All zero |

### A.6.1 Movement-type register

Every movement type must be registered with an explicit class and sign factor. An unregistered type is `BLOCKER` V-R07 — **never guessed**.

| Type | Text (as exported) | Class | Sign | Counts toward receipts | Rows |
|---|---|---|:--:|:--:|--:|
| `101` | GR goods receipt / GR for acct assgmnt / GR stock in transit / GR STO project stock / GR for project stock | `receipt` | +1 | ✅ yes | 19,200 |
| `102` | GR for PO reversal / GR for acc.assgt rev / GR:st.in transit rev / GR for proj.st. rev. / GR STO proj.st. rev. | `reversal` | −1 | ✅ yes (nets) | 741 |
| `641` | TF to stck in trans. / TF plant plant proj. / TR to stck in trans. | `transfer` | +1 | ❌ transit only | 8,612 |
| `642` | TR plant plant proj. (reversal) | `transfer_reversal` | −1 | ❌ transit only | 344 |
| `122` | Return delivery | `reversal` | −1 | ✅ yes (nets) | **0** — registered but absent |

Measured sign behaviour in the current export:

| Type | Count | Min qty | Max qty | Sum | Negative rows |
|---|--:|--:|--:|--:|--:|
| `101` | 19,200 | 0.107 | 8,342,900 | 387,681,500 | 0 |
| `102` | 741 | −5,000,264 | −0.107 | −33,654,920 | **741 (all)** |
| `641` | 8,612 | −8,230,400 | 8,230,400 | **0** | 4,306 (exactly half) |
| `642` | 344 | −5,000,264 | 5,000,264 | **0** | 172 (exactly half) |

**Two rules follow:**

1. **`signed_qty = ABS(qty_in_unit_of_entry) × sign_factor`.** The export happens to sign reversals negative, so v1's naive `qty += qty` netted correctly — by luck, not design. Deriving the sign from the movement type makes correctness independent of the export's convention.
2. **`receipt_date = MIN(posting_date) WHERE movement_type = '101'`.** v1 took the earliest posting across all types. Because `641` transfers precede receipts, **1,695 of 15,134 line keys (11.2%)** got a receipt date a median **7 days** too early. 47 line keys carry only transfers with no `101` and must not present as received.

`641`/`642` are **31.0% of this feed** and were entirely undocumented in v1.

---

## A.7 Feed 6 — FX Rate table

| | |
|---|---|
| **Source** | SAP rate table export |
| **Sample file** | `Rate Conversion - Copy.xlsx` (sheet `Sheet2`) |
| **Rows** | 230 · **Columns** 4 |
| **Primary key** | `Month` + `From` + `To` |
| **Role** | USD consolidation |

| # | Column | Type | Status | Notes |
|--:|---|---|:--:|---|
| 1 | `Month` | str | **PK** | `1.Jan` … `7.Jul`. ⚠️ **No year** — see A.7.2 |
| 2 | `From` | str | **PK** | Source currency. 16 values incl. both `US$` (94 rows) and `USD` (7 rows) |
| 3 | `To` | str | **PK** | Target currency. `IDR` 94 · `MYR` 56 · 13 others at 7 each |
| 4 | `Average of Rate` | dec(18,8) | REQ | Units of `To` per 1 unit of `From` |

### A.7.1 Currency coverage

Rates are present for **AUD, CAD, CHF, CNH, CNY, EUR, GBP, HKD, IDR, INR, JPY, KRW, MYR, SGD, US$/USD**. The seven currencies present in PO Report — IDR, CNY, USD, EUR, SGD, MYR, GBP — are **all covered**, so the strict-USD rule passes on current data.

Both directions exist: `X → IDR` rows (94) and `US$ → X` rows (7 per currency). After `US$ → USD` normalisation, direct `USD → X` pairs exist for every currency, which is why v1's refusal to triangulate happened to cause no loss. Triangulating via IDR agrees with the direct rates to within 0.01% (e.g. AUD 0.6919410 direct vs 0.6919970 triangulated), confirming the table is internally consistent.

`CAD` appears only for May–July (3 of 7 months) — irrelevant today since CAD does not occur in the PO feed, but it demonstrates that per-month coverage is not guaranteed and the period-matched fallback chain (PRD §12.6) is necessary.

### A.7.2 Required layout changes

| Change | Reason |
|---|---|
| **Add a year** — `2026.01` or a `Year` column | `Month` values `1.Jan`…`7.Jul` cannot be anchored. v1 parsed the ordinal against a hardcoded **year 2000** and displayed a 2000 date to users; a bundle spanning December→January would order the months wrongly. Until the export changes, v2 anchors the year from the batch's date range and records the resolved year explicitly; a bundle whose year cannot be determined unambiguously is a `BLOCKER`. |
| Normalise `US$` → `USD` at source (optional) | v2 normalises on ingest regardless, but a single spelling removes a class of confusion. |

### A.7.3 Accepted alternative layouts

| Layout | Columns | Handling |
|---|---|---|
| SAP dated pair table | `Date` \| `From` \| `To` \| `Rate` \[\| `Ratio`\] | `rate ÷ ratio`; period-matched by date |
| SAP monthly pair table (**current**) | `Month` \| `From` \| `To` \| `Average of Rate` | Period-matched by month; year anchored per A.7.2 |
| Simple table | `Currency` \| `Rate` | Rate is USD per unit; applied to all periods with a `fx_single_rate` caveat |

---

## A.8 Header signatures

Matching is on normalised headers (lowercase, non-alphanumerics stripped), evaluated most-specific first. A file matching no signature is reported as unrecognised — **never forced into a slot**.

| Feed | Required signature | Discriminator |
|---|---|---|
| `po` | `purchasingdocument` + (`netordervalue` \| `netprice` \| `orderquantity` \| `stilltobedeliveredvalue`) | must **not** contain `pono` or `prno` |
| `gr` | `movementtype` + `postingdate` | — |
| `por` | `pono` + (`picrelease` \| `approvedate`) | must **not** contain `purchasingdocument` |
| `prel` | `prno` + (`picrelease` \| `gapapprovalleadtime`) | — |
| `pr` | `purchaserequisition` + (`itemofrequisition` \| `requisitiondate` \| `quantityrequested`) | must **not** contain `purchasingdocument` |
| `fx` | (`from` + `to` + a `rate`-like column) \| (`currency` + `rate`, ≤ 4 columns) | — |

**Positional fallback.** Position may be used only when a header is unresolvable by name *and* the candidate column's own header does not look like a different field (v1's `_posOk` guard, worth preserving). Any positional resolution is recorded in the validation report as a `WARNING` — it is never silent.

**Filename is never used**, not even as a tiebreaker. v1 retained a filename fallback; the current filenames embed a date range that changes every refresh, making them actively misleading.

---

## A.9 Sentinel & coercion rules

| Rule | Applies to | Behaviour |
|---|---|---|
| **Null sentinel `'0'`** | PO Report `Item of requisition` | `'0'` ⇒ NULL. 9,094 rows. Without this, every direct PO joins to a phantom PR item 0 |
| **Continuation sentinel** | PR Release `PR Item`, `Qty` | `0` on continuation rows ⇒ treat as blank and forward-fill (A.3.1) |
| **Boolean strings** | PR Report `Deletion indicator` | Literal `'true'`/`'false'` strings, not Excel booleans |
| **Deletion flag** | PO Report `Deletion indicator` | `'L'` ⇒ deleted; blank ⇒ not deleted |
| **Currency normalisation** | all currency fields | `US$` ⇒ `USD`; trim and uppercase; `IDR` is the local currency |
| **SAP trailing minus** | all numeric fields | `1.234,56-` ⇒ `-1234.56`. Trailing sign must be handled |
| **Thousands separators** | all numeric fields | Strip `,` and locale separators before parsing |
| **Document numbers as strings** | all `*No`, `Purchasing Document`, `Purchase Requisition`, `Material Document` | Never coerce to number — leading zeros and length matter |
| **Dates** | all date fields | Prefer Excel serial dates; accept `dd.MM.yyyy` and `yyyy-MM-dd`. Store as `DATE`, no time component, no timezone conversion |
| **Times** | `Approve Time`, `Time of Entry` | Store as `TIME`; combine with the date only in Asia/Jakarta when a timestamp is needed |
| **Blank vs zero** | all numeric fields | A blank is NULL, never `0`. `0` is a real value with meaning (e.g. STO prices) |
| **Whitespace** | all string fields | Trim leading and trailing whitespace; collapse internal runs only in display, never in keys |
| **Unresolvable FX** | derived USD values | NULL — never `0`, never defaulted to IDR |

---

## A.10 Semantic assertions

Structural validation cannot catch a column that keeps its name and changes meaning. These assertions run on every load. A failure raises a `CAVEAT` and disables dependent KPIs — it does not block publication.

| ID | Feed | Assertion | Threshold | Current | Result | Gates |
|---|---|---|---|---|:--:|---|
| **V-M01** | PR Report | `Deliv. date(From/to)` differs from `Release Date` | ≥ 50% of rows | **0.60%** | 🔴 **FAIL** | Demand Realism |
| V-M02 | PR Report | `Requisition date` ≤ `Deliv. date` | ≥ 95% | 98.6% | ✅ | requested-lead measures |
| V-M03 | PO Report | `Delivery date` differs from `Document Date` | ≥ 50% | 62.6% | ✅ (borderline) | vendor OTD |
| V-M04 | GR List | `Qty in unit of entry` non-zero | ≥ 99% | 100% | ✅ | receipt quantities |
| V-M05 | GR List | Movement types ⊆ registered set | 100% | 100% | ✅ | all receipt logic |
| V-M06 | PO Report | Currencies ⊆ FX coverage after normalisation | 100% | 100% (7/7) | ✅ | USD consolidation |
| V-M07 | PR Report | `WBS Element` populated | ≥ 10% | 11.1% | ⚠️ info | WBS compliance |
| V-M08 | PO Report | STO lines are zero-priced | ≥ 95% | 100% | ✅ | STO exclusion rule |
| V-M09 | PO Report | STO lines carry a `Req. Tracking Number` | ≥ 95% | 100% | ✅ | STO back-reference |
| V-M10 | PR Release | Continuation rows follow a seq-1 row | 100% | 100% | ✅ | approval attribution |

**V-M01 is the assertion that matters.** `Deliv. date(From/to)` is present, correctly typed and fully populated — it passes every structural check — yet equals `Release Date` on 19,989 of 20,110 rows. It is not a delivery date. Demand Realism therefore ships disabled (PRD §13.1) rather than rendering a fabricated 0.3%. When SAP `EBAN-LFDAT` is added (A.2.1 / decision D4) the assertion passes and the KPI activates with no code change.

---

## A.11 Cross-feed referential rules

| ID | Rule | Severity | Current data |
|---|---|:--:|---|
| V-R01 | GR `Purchase order` + `Item` exists in PO Report | `WARNING` | **0 orphans** across all 28,897 rows |
| V-R02 | PO Release `PO No` exists in PO Report | `WARNING` | 0 orphans across 8,994 POs |
| V-R03 | PO `Purchase Requisition` + `Item of requisition` exists in PR Report, where present | `WARNING` | **291 of 11,710 (2.5%)** dangling |
| V-R04 | PR Release continuation rows each follow a seq-1 row; key unique after fill | `BLOCKER` | 0 violations; 13,338/13,338 attached |
| V-R05 | Release L2 approve date ≥ L1 approve date | `WARNING` | 0 violations |
| V-R06 | Every PO currency has a rate after normalisation | `CAVEAT` | pass (7 of 7) |
| V-R07 | Every GR movement type is registered | `BLOCKER` | pass (101, 102, 641, 642) |
| V-R08 | PO Report POs present in PO Release | `WARNING` | 525 of 9,519 (5.5%) absent |
| V-R09 | PR items reaching a PO | `INFO` | 10,378 of 20,110 (51.6%) |
| V-R10 | PO lines with no PR reference | `INFO` | 9,094 of 20,804 (43.7%) |

**The GR join is the cleanest link in the bundle** — zero orphans in either direction. v1 carried material-level and PO-level fallback joins and an "orphan reconstruction" path for incomplete GR exports. On this feed none is needed: both fallbacks default to **off**, are available behind a flag, and any row they attach is tagged `join_method` and surfaced in Data Check.

---

## A.12 Known dead columns

Ingested for lineage completeness; never read analytically. Reported once per template version, not per load.

| Feed | Columns |
|---|---|
| PR Report | `Delivery` (100% blank) · `Goods receipt` (single value `Yes`) · `Closed` (98.9% blank) · `Batch` (95.7% blank) |
| PO Report | `PO history/release documentation` · `Outline agreement` · `Tax Jurisdiction` · `Contract Ext` (all 100% blank) · `Tax Code` (99.8% blank) · `Purch. Doc. Category` (single value `F`) |
| GR List | `Ext. Amount in Local Currency` · `Sales Value` · `Sales Value inc. VAT` (all single-valued at 0) |

If a future export populates any of these, V-S03 raises a `WARNING` so the change is noticed rather than absorbed silently.

---

## A.13 Feeds 7-10 — SAP reference exports (optional)

Added 20 Aug 2026. Four SAP master-data exports that describe what a code
*means*. They differ from feeds 1-6 in three ways, each of which is a deliberate
design property rather than an accident of implementation:

| | Feeds 1-6 (transactional) | Feeds 7-10 (reference) |
|---|---|---|
| Required for a publish | **Yes** — all six or nothing | **No** — absent is a no-op |
| Destination | version-partitioned facts | global `core.dim_*` tables |
| Cadence | daily | when master data changes |
| Format | XLSX workbook | 3 of 4 are tab-delimited text named `.csv` |

**Why optional.** A purchasing group is created once a quarter; PR and PO exports
land daily. Requiring these would stop the daily pickup because nobody
re-exported a file that had not changed. `REQUIRED_FEEDS` in
`Backend/src/modules/ingest/contracts.ts` therefore still lists exactly the six
transactional feeds.

**Why global rather than version-scoped.** Facts are partitioned by
`dataset_version_id` so a published figure never moves. Reference data is the
opposite: it answers "what does this code mean *today*", and a corrected
description should appear everywhere at once. Nothing here can move a published
number — every attribute a figure depends on is already denormalised onto the
fact at transform time.

**An absent feed never deletes.** Reference rows persist across bundles that do
not re-supply them, so a six-file pickup does not wipe master data loaded by an
earlier ten-file one. Verified by publishing a bundle with two reference files
removed and confirming both tables retained their row counts.

### A.13.1 Feed 7 — Purchasing groups (`pgrp`)

Reference file `P Grp.csv` · 300 rows · tab-delimited · header on line 2.

| Column | Status | Field | Notes |
|---|---|---|---|
| `PGr` | PK | `code` | |
| `Description` | REQ | `description` | buyer desk or person's name |
| `Telephone` | IGN | — | present in the header, empty in all 300 rows |
| `Fax Number` | IGN | — | as above |

Target `core.dim_purch_group`. `is_ho` is **recomputed** with migration 017's
rule (code starts `@`, or description starts `HO`, or contains `HO-`) because the
file carries no such column: 48 Head Office desks, 252 site units.

This feed replaces a hardcoded 299-row seed. The export adds `P61` (Dela
Oktakia) and disagrees on one description — `L3C` is `Supian Suri` in the seed
and `INACTIVESupianSuri` in SAP, which is live status a hardcoded map cannot
know. A `source` column records whether a row came from the seed or the export.

Note that two rows carry an inactive marker typed by hand and inconsistently
(`INACTIVESupianSuri`, `Inactive-Marrdiana`). Two rows is not a convention, so
the text is carried through verbatim rather than parsed into a status flag.

### A.13.2 Feed 8 — Purchasing organisations (`porg`)

Reference file `P Org.csv` · 491 rows · tab-delimited.

| Column | Status | Field |
|---|---|---|
| `POrg` | PK | `code` |
| `Purch. org. descr.` | REQ | `description` |

Target `core.dim_purch_org` (new). Covers 100% of the `purch_org` values present
in the PR and PO facts.

### A.13.3 Feed 9 — Material master (`matm`)

Reference file `Mat group.xlsx` · 11,134 rows → 11,131 codes.

| Column | Status | Field | Notes |
|---|---|---|---|
| `No` | IGN | — | row counter in the export, not a business key |
| `Code` | PK | `materialCode` | |
| `Desc` | REQ | `description` | |
| `Category` | REQ | `category` | SAP spend category |

**The filename is misleading**: this is keyed by material CODE, not material
group. The export contains 3 duplicate codes, so the upsert keeps the last
occurrence in file order.

13 categories: MRO GENERAL (6,523), MRO SPECIFIC (2,177), HEVE (795), OFFICE IT
(673), CAPEX (367), CHEMICAL (346), PACKAGING (139), FUEL & ENERGY (104), COAL
(4), METHANOL (1), FUEL (1), SERVICES (1), one blank.

> **This is NOT `material_category`.** The `material_category` column on the
> facts is v1's rule keyed by material GROUP, and it rests on a parity heuristic
> — even group number becomes Spare Parts-General, odd becomes Spare
> Parts-Factory — which `packages/rules/src/category.ts` explicitly flags as
> unconfirmed. `dim_material_master.category` is a **different vocabulary at a
> different grain from an authoritative source**. Repointing the existing charts
> at it would silently restate every category figure and break v1 parity, so it
> is stored alongside and nothing is repointed. Whether it *should* replace the
> heuristic is a business decision for the category managers.

### A.13.4 Feed 10 — SAP user directory (`zuser`)

Reference file `zuser <yyyymmdd>.csv` · 2,073 rows · title line, **pipe**-delimited
header, **tab**-delimited data.

| Column | Status | Field | Notes |
|---|---|---|---|
| `Client` | PK | `client` | `300` throughout |
| `User` | PK | `userId` | |
| `First Name` | OPT | `firstName` | blank for background-job users |
| `Last Name` | REQ | `lastName` | |

Target `core.dim_sap_user` (new). Turns the SAP user id into a person: covers
**100%** of the distinct `created_by` values on the PR and PO facts and of
`login_name` on PR release steps, background jobs included.

`display_name` is precomputed because either name part can be blank, so it is
not simply `first || ' ' || last`; when both are blank the id itself is the
label, never an empty string.

> **Personal data.** `fact_pr_item.requisitioner` and `.created_by` are already
> annotated "personal data: restricted display" in migration 002. This feed does
> not widen *who* can see a document — it makes an id already on screen legible —
> but it does turn an opaque code into a named employee. It is therefore kept as
> its own table, joined for display, rather than materialised onto the facts, so
> there is one place to gate, mask or purge it. No masking is currently enforced
> anywhere in the API.

Note that `requisitioner` is **not** a user id and does not join here: it is a
free-text SAP field holding values like `FAIQ MTC` alongside non-names such as
`STANDARD` and `URGENT`.

### A.13.5 Reading SAP list output

Three of these four are not spreadsheets. The reader
(`Backend/src/modules/ingest/parse.ts`) is driven by what the files actually
contain:

- The header is **found**, not assumed to be row 0 — line 1 is blank in `P Grp`
  and `P Org`, and `zuser` opens with a report title and page number.
- Data rows begin with the delimiter, giving an empty leading field that must be
  dropped or every column shifts by one.
- In `zuser` the header is pipe-delimited while its data rows are tab-delimited.
  Each line is split on its own delimiter; one guess for the whole file yields a
  single-column sheet.
- Format is decided by **content, not extension**: a ZIP signature goes to the
  workbook reader, anything else is checked for C0 control bytes and refused if
  binary.

---

*End of Annex A. See [PRD v2](PRD_v2_Production.md) and [Annex B — Database Schema](PRD_v2_Annex_B_Database_Schema.md).*
