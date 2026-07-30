# Procurement Control Tower — Documentation Index

**Product owner:** Procurement / Supply Chain — KPN Downstream (Energi UP)
**Last updated:** 30 July 2026

---

## Document set

| # | Document | Purpose | Primary audience |
|---|---|---|---|
| 0 | [PRD Review & Data Analysis](PRD_Review_and_Data_Analysis.md) | Critical review of the v1 PRD and prototype, with every finding measured directly from the `Assets/` exports. The evidence base for everything else. | Product owner, engineers |
| 1 | [PRD v2 — Production](PRD_v2_Production.md) | The production requirement document. Scope, architecture, business rules, KPIs, functional and non-functional requirements, roadmap, risks, decisions. | Everyone |
| 1a | [Annex A — Data Contract](PRD_v2_Annex_A_Data_Contract.md) | Authoritative specification of the six upload templates: every column, type, nullability, sentinel, domain value and semantic assertion. Replaces v1 PRD §6. | Data stewards, engineers, SAP team |
| 1b | [Annex B — Database Schema](PRD_v2_Annex_B_Database_Schema.md) | Physical data model: PostgreSQL DDL, partitioning, publish/rollback/retention functions, sizing. | Engineers, DBA |
| 2 | [TECH 01 — Architecture & Implementation](TECH_01_Architecture_and_Implementation.md) | How to build it. Topology, sequence diagrams, repository layout, dev setup, normative code for the load-bearing parts, coding standards, testing. | Engineers |
| 3 | [TECH 02 — API Reference](TECH_02_API_Reference.md) | Full HTTP contract: every endpoint, schema, error type, rate limit. | Engineers, integrators |
| 4 | [TECH 03 — Deployment & Operations](TECH_03_Deployment_and_Operations.md) | How to run it. Provisioning all three instances, config reference, Hub registration, CI/CD, observability, runbooks, troubleshooting, DR, go-live checklist. | Platform engineers, SRE, administrators |

### Superseded

| Document | Status |
|---|---|
| `Procurement_Control_Tower_PRD.docx` | Superseded by PRD v2. Retained for history. |
| `Procurement_Dashboard_Final_50 (9).html` | v1 prototype. Validated functional reference; not maintained as part of v2. |

---

## Start here

**Product owner / stakeholder** → PRD v2 §1 (executive summary), §2 (success metrics), §29 (decisions), §27 (roadmap).

**Engineer joining the build** → PRD v2 §5–7 (architecture), then TECH 01 §1 (the three rules), §4 (local setup), §5 (business rules). Read Annex A before touching ingestion.

**Data steward** → Annex A in full, PRD v2 §10–11 (ingestion and validation), TECH 03 §12 (runbooks).

**Platform engineer** → TECH 03 end to end, in order.

**Auditor** → PRD v2 §19.7–19.8, TECH 02 §7 (lineage) and §12 (audit log).

**SAP / ME5A owner** → PRD v2 §13.1.1 and Annex A §A.2.1. That is the one change requested of you.

---

## Decisions

| # | Decision | Resolution | Status |
|---|---|---|---|
| D1 | WBS/AR threshold basis and validity | Per item. 89.7% non-compliance confirmed real. Thresholds administrator-configurable at runtime with effective date and author. 4,211 unvalued items reported as `indeterminate`, never compliant. | ✅ Resolved 30 Jul 2026 |
| D2 | POs with no release strategy (241 lines / 89 POs / IDR 1.51bn) | `flag_only` — left in the pipeline and marked `⚑`; never reclassified as approved, pending or deleted; excluded from the pending-approval queue; included in commitment and delivery analytics. | ✅ Resolved 30 Jul 2026 |
| D3 | FX basis | Period-matched monthly — each document converts at its own month's average rate, with the fallback chain and the resolved period shown on every converted figure. | ✅ Resolved 30 Jul 2026 |
| D4 | PR delivery date in the SAP export | Add `EBAN-LFDAT` to the ME5A export variant. **External dependency.** Demand Realism ships disabled until it lands, and activates automatically with no code change. | 🔴 Open — raise in week 1 |

Secondary decisions with working defaults are listed in PRD v2 §29 (D5–D10).

---

## Facts worth knowing before you read anything else

Measured from `Assets/` (EU entity, 1 Jan – 27 Jul 2026), 108,590 rows across six files:

| | |
|---|---|
| Referential integrity, GR → PO | **0 orphans** across all 28,897 rows |
| PO lines with no PR reference | **9,094 (43.7%)** — modelled as first-class, not fallback-only |
| PR items ever reaching a PO | 10,378 (51.6%) |
| Split-sourced PR items / max PO lines on one item | **645 / 33** |
| STO lines (`EU70`) | 4,453 (21.4%), 100% zero-priced, 100% carrying a tracking number |
| GR movement types | 101, 102, **641, 642** (31% of the feed, undocumented in v1); `122` never occurs |
| PR Release continuation rows | 13,338 (48%) with blank identifiers — forward-filled, now with guards |
| WBS Element populated | 11.1% — governance runs on that coverage |
| Requested delivery date usable | **2.8%** — the reason Demand Realism is blocked |

Four v1 reference figures did not reproduce (expedite 0.50× not 1.40×; GR/IR 91.67% not 44%; pending POs 53 not 14; token lines 107 not 49). One reproduced exactly (645/33). All are now pinned to a frozen fixture with golden-number CI gates.

---

## The three rules that govern the codebase

From TECH 01 §1, repeated because they are the whole point:

1. **No business logic outside `packages/rules`.** Every computed number comes from a pure, unit-tested function there.
2. **No query without a scope.** Enforced structurally by a branded type, not by review.
3. **Never fabricate a value.** Unknown is `null`; `null` renders as `—`. No `DEFAULT 0`, no defaulted currency, no coalesce-to-zero on a measure.
