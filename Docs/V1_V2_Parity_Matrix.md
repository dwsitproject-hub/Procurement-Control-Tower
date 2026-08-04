# v1 → v2 Parity Matrix

**Date:** 30 July 2026
**v1 reference:** `Docs/Procurement_Dashboard_Final_50 (9).html` (build v50.7), served at `http://localhost:8099`
**v2 build:** `http://localhost:8081` (dataset version 3, as-of 27 Jul 2026)

Extracted from v1's source, not from screenshots: 10 page containers, **73 KPI cards**, **41 charts**, **18 tables**, **14 modals**, 9 filter controls.

**Baseline at the time of writing:** v2 implemented **18 of 73 KPIs (25%)**, **10 of 41 charts (24%)**, **0 of 18 tables**, **1 of 14 modals**. Four whole pages missing.

---

## 0. Progress log

The per-item tables in §2–§6 are the **original baseline** and are deliberately not
rewritten row by row — that would risk introducing claims I have not measured.
This log is the current state.

| Date | Wave | Delivered | Verified |
|---|---|---|---|
| 30 Jul 2026 | **W1** | Detail Table (49 columns, 7 facet filters, server-side sort/search/paging, per-user layout); reference data recovered from v1 (21 companies, 183 plant names, 19 category overrides); `materialCategory` / `priorityLabel` ported into `packages/rules` | ✅ 28,664 rows served; golden numbers unchanged; 107 unit tests |
| 30 Jul 2026 | **W4** | 35 further KPI cards → **53 of 73 (73%)**. Cycle cards now show median headline with avg and p90 in the subtitle (agreed decision) | ⚠️ 53 KPIs / 52 ok confirmed; final drill sweep pending |
| 30 Jul 2026 | **W5** | 24 further charts → **34 of 41 (83%)** | ⚠️ 34 registered, 0 empty, 0 errors confirmed; final drill sweep pending |
| 31 Jul 2026 | **W2** | Global filters (plant / purch org / month) recompute KPIs and charts live from the same spec SQL; drill predicates carry the filter | ✅ sweep 0/0 unfiltered (318 pts) and 0/0 filtered (107 pts) |
| 31 Jul 2026 | **W3** | Vendor 360 tab (top-50 list + 11-KPI bio popup with spend-by-month, by-area, materials, PO/GR history) and Materials tab (category summary, material popup with IDR price trend, vendor/area share, sole-source list) | ✅ vendor popup drill parity verified (allLines = lineCount); D4 card stays null with reason |
| 31 Jul 2026 | **W6** | Admin tab: exclusion config (applied at transform, V-C01 reports counts), server-side column mapping (2nd classify pass), per-version FX table | ✅ PUT round-trips verified; exclusions default empty so golden numbers unchanged |
| 31 Jul 2026 | **W7** | Custom tab: KPI/chart builder from server-side whitelists, per-user saved specs, mandatory user-defined banner | ✅ custom drill-count parity (19,636 = 19,636); buckets partition population; injection attempt rejected 400 |
| 31 Jul 2026 | **Gaps** | `po_irc` (info-record column persisted; 49.3% on reference data), On-Time vs Requested activation path (still disabled by V-M01 — the export's date column equals Release Date on 99.4% of rows; the KPI, vendor-bio figure and drill filter light up automatically when EBAN-LFDAT arrives), drag-to-reorder detail columns, `{force:true}` recompute | ✅ sweeps 0/0 on v14; 60/60 E2E; golden numbers unchanged |
| 3 Aug 2026 | **G1–G6** | Interaction parity from the click-action audit: drill Σ totals + Detail-tab handoff, chart alt-click cross-filtering, urgency chips, inline anomaly banners, tab badge, global scope toggle (All/Open/Complete, grain-aware EXISTS on PR side), vendors×months pivot + all-vendors OTD chart + popup donut/aging/Σ, full-catalogue Materials explorer with category drills, per-user layout editing (move/hide/swap/add, server-side), static snapshot export, theme toggle, emergency % re-based to urg ≤ 2 (11.25%), 14 v1-only KPIs promoted → **catalogue 69** | ✅ v17: sweeps 0/0 × 4 modes (318/107/193/156 pts); 81/81 E2E; 107 tests; golden numbers unchanged |

### Current position

| | v1 | v2 |
|---|---:|---:|
| KPI cards | 73 | **53 (73%)** — remainder blocked (D4 / info-record column) or superseded |
| Charts | 41 | **34 (83%)** — remainder are v1 duplicates or blocked on D4 |
| Tables | 18 | Detail Table + vendor/material/category tables (entity tabs) |
| Filters | 9 | 7 detail facets + 3 global (plant, purch org, month) |
| Pages with no equivalent | — | 0 — Vendor 360, Materials and Custom tabs shipped 31 Jul 2026 |

End-to-end run of 31 Jul 2026: 50/50 API checks passed (entity endpoints,
exclusion and mapping round-trips, custom drill parity, golden numbers intact,
53 KPIs). All four new tabs verified rendering in the browser on dataset v12.

### Drill-parity defects found and fixed during W4/W5

The "drill count equals aggregate count" guarantee was broken in four distinct
ways. All four are now closed in code:

1. **Aggregate filters missing from predicates.** `po_value_by_month`,
   `delivery_ordered_vs_received` and `top_vendors_spend` applied
   `NOT is_sto` / `NOT is_deleted` in the aggregate but not in the stored
   predicate. This was the original 29 mismatches.
2. **`open` covered only the four PO statuses**, omitting `Unapproved PR` and
   `PR Approved-No PO`, so every PR-grain "open" drill under-counted. Roughly 40
   further mismatches.
3. **Histogram buckets carried no range.** Each bar in the four distribution
   charts drilled to the entire population, because the range lived in the
   aggregate's `CASE` and never reached the predicate. Fixed by a `distBucket`
   filter whose boundaries mirror the `CASE` exactly.
4. **Null handling diverged on one bar.** `unreleased_aging_buckets` let a null
   aging fall through the `CASE` into `60+` while the drill filter excluded it.
   The aggregate now filters nulls explicitly.

### Entity counts are not defects

Five cards count **entities** while their drill returns the underlying **rows** —
"# POs" 8,340 drills to 15,271 PO lines. v1 behaves the same way. Rather than
leave that looking broken, these cards declare an `entityUnit` and say so in the
subtitle: *"distinct POs — drill opens the lines"*. Affected:
`po_hold`, `total_po_count`, `unique_suppliers`, `sole_source_materials`,
`split_sourcing`, plus both pending-approval cards.

### Remaining

Vendor 360, Material and Material Group pages (11 KPIs, 9 charts, 10 tables),
the 3 global filters, and the customisation suite (confirmed in scope).
Roughly **10–14 working days**, down from 18–24.

---

## 1. Page-level status

| # | v1 page | v1 content | v2 tab | Status |
|---|---|---|---|---|
| 1 | **pg-up** Data Loader | folder pick, drag-drop, per-feed status, hourly auto-update | (server-side ingest) | ✅ **superseded** — better in v2 |
| 2 | **pg-ov** Overview | 14 KPIs, 3 charts | Executive | ⚠️ 8 KPIs, 2 charts |
| 3 | **pg-op** Open Items | 11 KPIs, 4 charts, 4 filters, open table | Open Items | ⚠️ 4 KPIs, 2 charts, no table, no filters |
| 4 | **pg-pr** PR Analysis | 16 KPIs, 6 charts, 2 tables | PR | ⚠️ 4 KPIs, 2 charts, no tables |
| 5 | **pg-po** PO Analysis | 16 KPIs, 11 charts, 2 tables | PO | ⚠️ 6 KPIs, 3 charts, no tables |
| 6 | **pg-v360** Vendor 360 | 11 KPIs, 1 chart, table, vendor search | — | 🔴 **missing entirely** |
| 7 | **pg-dl** Delivery | 4 KPIs, 5 charts | Delivery | ⚠️ 3 KPIs, 2 charts |
| 8 | **pg-mg** Material Group | 2 charts, 4 tables, group/category selects | — | 🔴 **missing entirely** |
| 9 | **pg-dt** Detail Table | 41 columns, search, drag-drop, 6 filters | — | 🔴 **missing entirely** |
| 10 | **pg-dq** Data Quality | structural warnings, column mapping | Data Check | ⚠️ report only; no remap UI |
| — | Governance | (spread across v1 pages) | Governance | ✅ v2 addition |
| — | Approvals | (spread across v1 pages) | Approvals | ✅ v2 addition |

---

## 2. KPI parity — 18 of 73

### 2.1 Overview / Executive (pg-ov, 14 KPIs)

| v1 id | v1 KPI | v2 |
|---|---|:--:|
| `ex-open` | Open PO Commitment | 🔴 |
| `ex-grir` | Received, Not Invoiced (GR/IR) | 🔴 (v2 has the >60d share, not the absolute value) |
| `ex-pipe` | PR Pipeline Value (no PO) | 🔴 |
| `ex-e2e` | End-to-End Lead Time (median) | ✅ `cycle_e2e` |
| `ex-emg` | Emergency Purchasing % (value) | 🔴 |
| `ex-otdr` | On-Time vs Requested Date | 🔴 **blocked** — needs `EBAN-LFDAT` (D4) |
| `k-tot` | Total PR Items | 🔴 |
| `k-gr` | Delivered (GR) | 🔴 |
| `k-op` | Open Items | ✅ `open_items` |
| `k-pra` | Avg PR Approval (d) | ⚠️ v2 has **median**, not avg |
| `k-src` | Avg Sourcing LT (d) | ⚠️ median |
| `k-poa` | Avg PO Approval (d) | ⚠️ median |
| `k-del` | Avg Delivery LT (d) | ⚠️ median |
| `k-e2e` | Avg End-to-End (d) | ⚠️ median |

### 2.2 Open Items (pg-op, 11 KPIs)

| v1 id | v1 KPI | v2 |
|---|---|:--:|
| `op-a` | PR Not Approved | 🔴 |
| `op-b` | PR No PO | 🔴 |
| `op-h` | PO Hold | 🔴 |
| `op-g` | PO Not Approved | ⚠️ via `pending_po_approvals` |
| `op-c` | PO Not Delivered | 🔴 |
| `op-tot` | Total Open Items | ✅ `open_items` |
| `op-d` | Emergency Open | 🔴 |
| `op-e` | Urgent Open | 🔴 |
| `op-f` | Avg Unreleased Age | 🔴 |
| `op-upo` | Urgent PO (PO before PR) | ✅ `retro_po_rate` |
| `op-nowbs` | Open PR w/o WBS | ✅ `open_pr_no_wbs` — v1-exact since v30 (took over the definition from the interim `wbs_open_violations`, now removed; `open_pr_with_wbs` is its compliant-side counter under the same open rule). v1's open rule reverse-engineered from `_noWbsViol` + `OPEN_ST` + the status derivation (any GR on the row ⇒ 'Delivered' ⇒ not open). v2: violation ∧ not deleted ∧ (no PO yet ∨ (a PO line in Not-Approved/Hold/No-GR ∧ NO linked line with any GR)). Full scope: v1 186 PRs / 599 items · v2 186 PRs / 594 items — the 5-item residue is v1 judging multi-PO items by its first file row's PO only, where v2 checks all linked lines. |

### 2.3 PR Analysis (pg-pr, 16 KPIs)

| v1 id | v1 KPI | v2 |
|---|---|:--:|
| `pr-av` | Avg PR Approval | ⚠️ median |
| `pr-md` | Median PR Approval | ✅ `cycle_pr_approval` |
| `pr-mx` | Max PR Approval | 🔴 |
| `pr-un` | Unreleased Items | 🔴 |
| `pr-tot` | Total PR Items (scope) | 🔴 |
| `pr-cvr` | PR→PO Conversion % | 🔴 (data exists: 51.6%) |
| `pr-sla` | Approved ≤3d % | 🔴 |
| `pr-old` | Oldest Unreleased (d) | 🔴 |
| `pr-eu` | Emergency+Urgent Share % | 🔴 |
| `pr-alt` | PR Approval Lead Time (median) | ✅ `cycle_pr_approval` |
| `pr-risk` | At-Risk Demand (no PO, past req. date) | 🔴 |
| `pr-cxl` | PR Cancellation Rate | 🔴 |
| `pr-del` | PR Deleted | 🔴 |
| `pr-nowbs` | PR w/o WBS | ✅ `wbs_compliance` |
| `pr-realism` | Demand Realism | ✅ (correctly disabled, V-M01) |
| `pr-exped` | Expedite Effectiveness | ✅ `expedite_effectiveness` |

### 2.4 PO Analysis (pg-po, 16 KPIs)

| v1 id | v1 KPI | v2 |
|---|---|:--:|
| `po-amt` | Total PO Amount | 🔴 |
| `po-num` | Total # of PO | 🔴 |
| `po-sv` | Avg Sourcing LT | ⚠️ median |
| `po-pv` | Avg PO Approval | ⚠️ median |
| `po-cn` | PO Line Items | 🔴 |
| `po-sup` | Unique Suppliers | 🔴 |
| `po-grir60` | GR/IR >60d | ✅ `grir_over_60d` |
| `po-cmt60` | Commitment >60d | ✅ `commitment_over_60d` |
| `po-pnd` | Lines Pending PO Approval | 🔴 |
| `po-hold` | HOLD PO Lines | 🔴 |
| `po-grc` | GR Coverage % (of approved) | 🔴 |
| `po-cyc` | PO Approval Cycle (median) | ✅ `cycle_po_approval` |
| `po-pendq` | POs Pending Approval | ✅ `pending_po_approvals` |
| `po-irc` | Info-Record Coverage % | 🔴 |
| `po-pvar` | PR→PO Price Variance | 🔴 |
| `po-tail` | Tail Spend % | 🔴 |

### 2.5 Delivery (pg-dl, 4 KPIs)

| v1 id | v1 KPI | v2 |
|---|---|:--:|
| `dl-av` | Avg Delivery LT | ⚠️ median |
| `dl-md` | Median Delivery LT | ✅ `cycle_delivery` |
| `dl-e2` | Avg End-to-End | ⚠️ median |
| `dl-cn` | Items Delivered | 🔴 |

### 2.6 Vendor 360 & Material popups (11 KPIs) — all missing

`v3-amt` Total Spending · `v3-po` # POs · `v3-mat` Materials Supplied · `v3-area` Areas Served · `v3-otd` On-Time % (≤ Deliv+7d) · `v3-late` Avg Days Late · `v3x-open` Open Exposure · `v3x-inv` Delivered Not Invoiced · `v3x-rev` GR Reversal Rate · `v3x-sole` Sole-Source Materials · `v3x-otdr` On-Time vs Requested %

🔴 All missing. `v3x-rev` partially exists as v2's `reversal_rate`.

### 2.7 v2-only KPIs (not in v1)

`sto_share`, `direct_po_share`, `split_sourcing`, `pending_pr_approvals` — these expose the STO segregation, direct-PO share and split-sourcing facts the v1 review identified.

---

## 3. Chart parity — 10 of 41

| v1 page | v1 chart | Title | v2 |
|---|---|---|:--:|
| ov | `ch-stat` | PR Status Distribution | ✅ `status_mix` |
| ov | `ch-pvol` | Items by Priority Category | 🔴 |
| ov | `ch-page` | Avg Aging by Priority | 🔴 |
| op | `ch-opprio` | Open Items by Priority | 🔴 |
| op | `ch-opmat` | Unapproved by Material Category | 🔴 |
| op | `ch-opbkt` | Unreleased Aging Buckets | ⚠️ `aging_bands` (PO grain, not unreleased-PR) |
| op | `ch-opsev` | Unreleased Aging Severity | 🔴 |
| pr | `ch-prpr` | Avg PR Approval by Priority | 🔴 |
| pr | `ch-pr-area` | PR Items by Area | 🔴 |
| pr | `ch-prl1` | Avg Layer-1 Aging by Priority | 🔴 |
| pr | `ch-prds` | PR Approval Distribution | 🔴 |
| pr | `ch-prub` | Unreleased PR Aging Buckets | 🔴 |
| pr | `ch-prnopo` | Monthly PR with No PO | 🔴 |
| po | `ch-posp` | Sourcing Lead Time by Priority | 🔴 |
| po | `ch-poap` | PO Approval by Priority | 🔴 |
| po | `ch-pods` | PO Approval Distribution | 🔴 |
| po | `ch-posm` | Sourcing LT by Material Category | 🔴 |
| po | `ch-po-plant` | PO by Plant | 🔴 |
| po | `ch-po-matval` | PO Amount by Material Category | 🔴 |
| po | `ch-po-pgrp` | Outstanding by Purchasing Group | 🔴 |
| po | `ch-po-porg` | PO Value by Purchasing Org | 🔴 |
| po | `ch-po-pgpie` | PO Value by Purchasing Group (pie) | ⚠️ `purch_group_workload` is line count, not value |
| po | `ch-po-age` | Open Commitment Aging | 🔴 |
| po | `ch-po-vendor` | Spending per Vendor | ✅ `top_vendors_spend` |
| dl | `ch-dlmc` | Delivery LT by Material Category | 🔴 |
| dl | `ch-dlpr` | Delivery LT by Priority | 🔴 |
| dl | `ch-dlds` | Delivery LT Distribution | 🔴 |
| dl | `ch-dlmo` | E2E by Month | 🔴 |
| dl | `ch-dlgr` | PO Lines per Month — ordered vs received | ✅ `delivery_ordered_vs_received` |
| mg | `ch-mgvl` | Items by Material Category | 🔴 |
| mg | `ch-mge2` | Avg E2E by Material Category | 🔴 |
| v360 | `ch-v3-otd` | Vendor OTD | 🔴 |
| popup | `mgx-ch` | Price history — monthly avg unit price | 🔴 |
| popup | `mgx-conc` | Spend concentration — top materials | 🔴 |
| popup | `mgx-mo` | Monthly spend | 🔴 |
| popup | `v3-area-ch` | Supply to Area / Plant | 🔴 |
| popup | `ch-v3-aging` | Delivery aging (GR vs PO delivery date) | 🔴 |
| popup | `ch-mx-price` | Material price trend | 🔴 |
| popup | `mx-ven-ch` | Suppliers share of PO amount | 🔴 |
| popup | `mx-area-ch` | Areas purchased share | 🔴 |

**v2-only:** `pr_by_month`, `po_value_by_month`, `wbs_by_plant`, `movement_mix`.

---

## 4. Tables — 0 of 18

| v1 table | Page | Purpose | v2 |
|---|---|---|:--:|
| `pr-bneck` | PR | Approval bottleneck by approver | 🔴 |
| `pr-reqr` | PR | Requisitioner workload | 🔴 |
| `po-routine` | PO | Routine materials (STO excluded) | 🔴 |
| `po-pend-tbl` | PO | POs pending approval | 🔴 |
| `mgt` | MG | Material-group summary | 🔴 |
| `mxt` | MG | Material detail | 🔴 |
| `mg-vol` | MG | Volume leaders | 🔴 |
| `mg-ss` | MG | Sole-source materials | 🔴 |
| `v3-all` | V360 | All vendors, sortable/expandable | 🔴 |
| `v3-mt`, `v3-posum`, `v3-po-tbl`, `v3-gr-tbl` | V360 popup | Vendor materials, PO summary, PO history, GR history | 🔴 |
| `mgx-mat`, `mgx-ven` | MG popup | Category materials and vendors | 🔴 |
| `mx-po-tbl` | Material popup | Full PO history for a material | 🔴 |
| `dd-tbl` | Drill modal | Drill rows | ✅ implemented |
| `fx-tbl` | FX modal | Rate table | 🔴 |

**Detail Table (pg-dt) — 41 columns, none present in v2:**

`PR No · Item · Desc · Company · Company Description · Plant · Plant Name · PR Qty · UoM · Total GR Qty · GR/PR % · Mat Grp · Category · Priority · Status · PR Next Approver · PR Date · PR Approval 1 · PR Approval 2 · PRA(d) · Unrel(d) · Sourcing Aging(d) · PO No · PO Item · PO Split · PO Mat Desc · PO Qty · PO UoM · Order Price Unit · Price Unit · PO Date · PO Final Approved Date · Vendor Code · Vendor Name · PO Next Approver · POA(d) · GR Date · Deliv(d) · Src(d) · DelvsGR(d) · E2E(d) · WBS`

v2's `/api/v1/rows` endpoint exists but returns 13 columns and has no UI.

---

## 5. Modals / interactive features — 1 of 14

| v1 modal | Purpose | v2 |
|---|---|:--:|
| `dd-modal` | Exact-set drill | ✅ implemented (count-exact for KPIs) |
| `v3-modal` | Vendor 360 popup | 🔴 |
| `mx-modal` | Material popup with full PO history | 🔴 |
| `mgx-modal` | Material-group / category popup | 🔴 |
| `cv-modal` | Data check + per-column source/header remap | ⚠️ report only, no remap UI |
| `fx-modal` | FX rate table view + manual upload | 🔴 (server-side only) |
| `cfg-modal` | **Data Exclusion Config** — doc types, purch groups, orgs | 🔴 |
| `col-modal` | Column chooser / drag-drop order | 🔴 |
| `cu-modal` | **Custom KPI builder** | 🔴 |
| `ce-modal` | **Custom chart editor** (dimension, palette, type, size) | 🔴 |
| `cd-modal` | Card designer (KPI, size) | 🔴 |
| `te-modal` | Table editor (size) | 🔴 |
| `hd-modal` | Header/help detail | 🔴 |
| `gasld-modal` | Drive load progress | ✅ superseded by server ingest |

---

## 6. Filters — 0 of 9

| v1 control | Scope | v2 |
|---|---|:--:|
| `gms('co')` | Global — company code | 🔴 |
| `gms('mo')` | Global — month | 🔴 |
| `gms('pl')` | Global — plant | 🔴 |
| `ms('st')` | Detail — status | 🔴 |
| `ms('pr')` | Detail — priority | 🔴 |
| `ms('mc')` | Detail — material category | 🔴 |
| `ms('mg')` | Detail — material group | 🔴 |
| `ms('pl')` | Detail — plant | 🔴 |
| `ms('mo')` | Detail — month | 🔴 |
| `of-cat/pr/mc/pl` | Open Items — 4 selects | 🔴 |
| `tf-sr`, `v3-*-sr`, `mx-sr` | Free-text search | 🔴 |

v2 accepts `plant` and `status` as query parameters on `/api/v1/rows` but exposes no UI, and the KPI/chart endpoints ignore filters entirely (`appliedFilters: {}`).

---

## 7. What v2 has that v1 does not

Not parity items, but the reason v2 exists:

| Capability | Detail |
|---|---|
| Server-side ingestion | No per-session folder pick; share-folder sync + audited upload behind one interface |
| Authentication & authorisation | Login, RBAC, row-level data scope enforced in the data layer |
| Versioned datasets | Immutable versions, atomic publish, one-transaction rollback, rule snapshot per version |
| Validation severities | BLOCKER / CAVEAT / WARNING / INFO, including **semantic** assertions (V-M01 disables Demand Realism) |
| Freshness | as-of date, load time, source, state on every screen; aging never uses wall-clock |
| Lineage | Source file, sheet and row number per fact row |
| Audit | Hash-chained append-only log |
| Corrected rules | 101-only receipt date, movement-class signs, deletion source, release-exempt flag, period-matched FX, `'0'` sentinel |
| No CDN | Vendored bundle, strict CSP |
| Tests | 100 unit tests + golden-number gate on 21 measured facts |

---

## 8. Closing the gap — proposed waves

Ordered by analyst value per unit of work. Each wave is independently shippable.

| Wave | Contents | Rough size |
|---|---|---|
| **W1** | **Detail Table** — all 41 columns, server-side sort/filter/search/paging, column chooser with persisted layout | 2–3 days |
| **W2** | **Filters** — global company/month/plant + 6 detail filters; thread through KPI, chart and drill endpoints so `appliedFilters` is real | 2 days |
| **W3** | **Entity views** — Vendor 360 (11 KPIs, OTD chart, 4 tables), Material popup (price trend, vendor/area share, full PO history), Material Group / Category | 4–5 days |
| **W4** | **KPI breadth** — the 55 missing KPIs, plus avg-alongside-median where v1 shows avg | 3–4 days |
| **W5** | **Chart breadth** — the 31 missing charts, incl. distribution histograms and priority breakdowns | 3–4 days |
| **W6** | **Config & data steward** — exclusion config, column-remap UI, FX table view | 2–3 days |
| **W7** | **Customisation** — custom KPI builder, chart editor, card/table designers | 4–5 days (lowest value; confirm it is wanted) |

**Total ≈ 20–27 working days**, consistent with PRD v2 §27 Phase 3 (3 weeks) plus the customisation features that phase did not scope.

### Two prerequisites before W4/W5

1. **Fix the 29 chart-drill count mismatches** first. Adding 31 charts on top of a broken predicate contract multiplies the problem — the mart aggregate applies `NOT is_sto` / `NOT is_deleted` filters that the stored `drill_predicate` does not carry.
2. **Decide avg vs median.** v1 shows *averages* on 8 cards; v2 computes *medians*. Medians are more robust on this data (PR→GR ranges 0–758 days), but the numbers will not match v1 and users will notice. Recommend showing median as the headline with avg and p90 in the subtitle.

### One item that cannot reach parity

`ex-otdr` **On-Time vs Requested Date** and `v3x-otdr` **On-Time vs Requested %** both need the requester's need-by date. That is decision D4 — blocked on adding `EBAN-LFDAT` to the ME5A export. v1 renders these cards from `Deliv. date(From/to)`, which equals `Release Date` on 99.40% of rows, so **v1's version of these figures is not measuring what its label claims.** v2 must leave them disabled until the feed changes.
