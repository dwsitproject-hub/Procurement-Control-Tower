# Procurement Control Tower — PRD Review, Data-Feed Analysis & Production Readiness Assessment

**Reviewer:** Claude (Opus 5) · **Date:** 30 July 2026
**Inputs reviewed:**
- `Docs/Procurement_Control_Tower_PRD.docx` — PRD v1.0 (build v50 series), dated 27 Jul 2026, 221 paragraphs + 22 tables
- `Docs/Procurement_Dashboard_Final_50 (9).html` — reference implementation, 7,227 lines / 506 KB, ~5,600 lines inline JS
- `Assets/` — 6 SAP exports (EU entity, 1 Jan – 27 Jul 2026): PR Report, PR Release, PO Report, PO Release, GR List, Rate Conversion

Every quantitative claim below was computed directly from the files in `Assets/`, not inferred from the PRD.

---

## 1. Verdict

The PRD is unusually strong on **process decomposition** (L0→L2), **honesty principles** (no silent FX conversion, exact-set drills, anomaly tagging), and **negative-path user stories** — that discipline is rare and worth preserving verbatim into the production spec. The reference implementation is also better than the PRD describes it: several places where I expected a data bug turned out to be handled correctly.

However, the PRD is **not yet a buildable production specification**, for three reasons:

1. **One headline KPI is not computable from this data feed at all.** Demand Realism depends on a PR delivery date. The column the PRD nominates (`Deliv. date(From/to)`) is not a delivery date in this export — it mirrors Release Date on 99.4% of rows. The KPI currently returns 0.3%, i.e. permanently red and meaningless.
2. **The acceptance criteria are pinned to an unversioned "reference data" snapshot, and most of the numbers do not reproduce** on the data in `Assets/`. One does reproduce exactly (645 split items / max 33 POs), which makes the mismatch harder, not easier, to dismiss.
3. **The PRD's own data spec has drifted from the implementation**, and in at least one case following the PRD literally would zero out 22% of goods receipts.

Add to that a set of genuine correctness defects (§5) and the architectural distance between a 506 KB single-file browser prototype and a production system (§7). `Backend/` and `Frontend/` are empty, so this is a greenfield build — the right moment to fix the specification rather than port the prototype.

**Recommendation:** treat the prototype as a validated *functional* reference and the PRD as a strong *narrative* reference, but re-derive the data contract, the KPI definitions, and the acceptance fixtures before writing production code. §8 lists what to lock down first.

---

## 2. Data-feed reality — derived data dictionary

The PRD's §6 "Data Feed Specification" lists key columns in prose. This is what the files actually contain. **This table should replace PRD §6.**

| Feed | File | Rows | Cols | Natural key | Key unique? |
|---|---|---:|---:|---|---|
| PR Report | `PR Report EU …XLSX` | 20,110 | 28 | `Purchase Requisition` + `Item of requisition` | ✅ 0 dups |
| PR Release | `PR Release EU …XLSX` | 27,742 | 20 | `PR No` + `PR Item` + `Rel Seq` | ⚠️ only after continuation-row fill (§5.8) |
| PO Report | `PO Report EU …XLSX` | 20,804 | 53 | `Purchasing Document` + `Item` | ✅ 0 dups |
| PO Release | `PO Release EU …XLSX` | 10,807 | 15 | `PO No` + `Rel Seq` + `Rel Code` | ✅ 0 dups |
| GR List | `GR List EU …XLSX` | 28,897 | 36 | `Purchase order` + `Item` + `Material Document` + `Material Doc.Item` | ✅ 0 dups |
| FX | `Rate Conversion - Copy.xlsx` | 230 | 4 | `Month` + `From` + `To` | ✅ |

### 2.1 Referential integrity — genuinely good

| Relationship | Result |
|---|---|
| GR List → PO Report (`PO`+`Item`) | **0 orphans** (all 6,989 GR POs and all 28,897 line keys resolve) |
| PO Release → PO Report | **0 orphans** (all 8,994 POs exist) |
| PO Report → PO Release | 525 of 9,519 POs (5.5%) have no release record |
| PO Report → PR Report (where PR ref present) | 291 of 11,710 (2.5%) dangling |
| PR Report items that ever reach a PO | 10,378 of 20,110 (**51.6%**) |
| PO lines with **no** PR reference (direct POs) | 9,094 of 20,804 (**43.7%**) |

The GR join is the cleanest link in the bundle. The PRD's provision for "orphan reconstruction" is unnecessary for this feed — worth simplifying rather than carrying forward.

### 2.2 Column-level cardinality traps

| Feed | Column | Finding | Consequence |
|---|---|---|---|
| PR Report | `WBS Element` | **88.9% blank** (2,233 of 20,110 populated) | Governance card runs on 11% coverage — §5.5 |
| PR Report | `Total Value` | **20.9% are zero** (4,211 items) | Invisible to any value threshold |
| PR Report | `Valuation Price` | 13.6% zero (2,744) | Fallback `price × qty` also fails on these |
| PR Report | `Delivery` | **100% blank** | Dead column |
| PR Report | `Goods receipt` | single value `Yes` for all 20,110 | Dead column |
| PR Report | `Closed` | 98.9% blank | Near-dead |
| PO Report | `Purchase Requisition` | 43.7% blank; `Item of requisition` uses **`"0"` as the null sentinel** (9,094 rows, exactly matching) | Blank-detection must treat `"0"` as null |
| PO Report | `Outline agreement`, `Tax Jurisdiction`, `Contract Ext`, `PO history/release documentation` | **100% blank** | Dead columns |
| PO Report | `Currency` | Both **`US$` (328 lines)** and **`USD` (4 lines)** present | Normalisation is mandatory, not cosmetic |
| GR List | `Quantity` (col AJ) | **22.4% are zero** (6,485 rows); differs from `Qty in unit of entry` on 6,562 rows | ⚠️ The PRD nominates this column. See §5.10 |
| GR List | `Qty in unit of entry` | 0 zeros, **signed** (5,219 negative rows) | This is the correct quantity column |
| GR List | `Ext. Amount in Local Currency`, `Sales Value`, `Sales Value inc. VAT` | single value (0) throughout | Dead columns |

### 2.3 Domain values the PRD does not enumerate

```
PO Purchasing Doc. Type   EU20 10,531 · EU21 5,808 · EU70 4,453 · EO21 4 · SC21 4 · PS21 2 · JP21 2
PO Currency               IDR 19,936 · CNY 432 · US$ 328 · EUR 39 · SGD 38 · MYR 26 · USD 4 · GBP 1
PO Release indicator      2 → 19,722 · blank → 964 · X → 106 · 1 → 12
PO Deletion indicator     blank → 19,636 · L → 1,168
PO Acct Assignment Cat.   blank → 12,637 · U → 5,414 · Q → 2,339 · P → 414
PR Requirement Urgency    3 → 15,068 · 2 → 4,437 · 0 → 277 · 1 → 224 · 4 → 104
PR Document Type          EUNB 19,928 · EUEM 182
PR Deletion indicator     false 18,257 · true 1,853
PR Release indicator      2 → 19,491 · X → 619
GR Movement type          101 → 19,200 · 641 → 8,612 · 102 → 741 · 642 → 344    (122 never occurs)
PR Release Rel Seq/Code   seq 1: code 25/19/02/01 (14,404) · seq 2: code 11/04 (13,338)
FX Month                  1.Jan … 7.Jul (no year) · To: IDR 94, MYR 56, + 13 single-currency targets
```

### 2.4 Date coverage

| Series | Range |
|---|---|
| PO `Document Date` | 2026-01-01 → 2026-07-27 (strictly in window) |
| GR `Posting Date` | 2025-12-31 → 2026-07-27 |
| PO `Delivery date` (EINDT) | 2024-08-21 → 2027-06-30; **equals Document Date on 37.4%** of lines |
| PR `Requisition date` | 2023-12-26 → 2026-07-27 (open backlog included — correct) |
| PR `Deliv. date(From/to)` | 2023-09-29 → 2026-07-27 — **not a delivery date, see §5.1** |

---

## 3. Business rules — validated against the data

| PRD rule | Verdict | Evidence |
|---|---|---|
| STO = doc type ends with `70` | ✅ **Confirmed** | `EU70` = 4,453 lines / 767 POs. 100% carry a `Req. Tracking Number`; 100% have `Net Price = 0`. No other doc type ends in 70. |
| STO exclusion keeps token-price warning meaningful | ✅ **Directionally confirmed** | All-lines zero price = 4,527; excluding STO = **74**. Token (0 < price ≤ 1) non-STO = **107**. |
| 1 PR → N POs; split sourcing visible | ✅ **Reproduces exactly** | **645 split-sourced PR items, max 33 PO lines** on one PR item — matches PRD F4.1+ to the digit. Expanded row model = 21,151 rows. |
| Dangling PR references survive | ✅ Handled | 291 PO lines (2.5%) reference a PR absent from PR Report. |
| GR reversals netted | ✅ **Works — by data convention** | `102` rows are **all 741 negative** in `Qty in unit of entry`, so the implementation's `qty += ...` nets correctly. Note this is accidental correctness — see §5.9. |
| STO transfers don't corrupt receipt quantity | ✅ Confirmed | `641`/`642` sum to **exactly 0** per movement type and leak into **0** of 15,181 PO-line keys. |
| `US$` normalised to `USD`; USD only when all currencies rated | ✅ **Confirmed working** | `ccyFix` maps `US$`→`USD`; the file carries direct `US$ → X` pairs for all 15 currencies, so **all 7 currencies present in PO Report get rates** and the strict-USD rule passes. Triangulating via IDR gives rates within 0.01% — the table is internally consistent. |
| WBS: material ≥ 30M IDR, service ≥ 150M IDR per item | ⚠️ Computable, but see §5.5 | 1,247 items over threshold; 1,119 (89.7%) missing WBS. |

**Note on FX:** I initially suspected the absorber would drop IDR because it skips "cross pairs not involving USD". It does skip them, but the file happens to supply direct `US$ → X` rows for every currency, so nothing is lost today. That is a latent single point of failure, not a current defect (§5.6).

---

## 4. What the prototype already gets right

Worth calling out explicitly, because a rewrite could easily regress these:

1. **GR quantity uses `Qty in unit of entry` first**, falling back to `Quantity` last. Following the PRD's literal spec instead would zero out 6,485 receipts.
2. **Signed-quantity netting** for reversals at line level.
3. **Content-based file detection** — the EU-layout headers classify correctly through the signature rules, with a scoring fallback and filename only as last resort.
4. **PR Release continuation-row handling** — verified correct on this data: 13,338/13,338 seq-2 rows attach to a PR, **0** duplicate keys, **0** rows where a seq-2 row isn't immediately preceded by a seq-1 row, **0** cases of L2 approved before L1.
5. **Guarded positional fallbacks** (`_posOk` blocks a positional column if its header looks like a different field) — a genuinely careful pattern.
6. **Strict no-silent-conversion discipline** carried consistently through `usdOf` / `toUSD` returning `null` rather than 0.
7. **Exact-set drill stashes** — the mechanism that makes "drill count == chart count" true by construction rather than by convention.

---

## 5. Defect register

Severity: **P1** blocks the KPI · **P2–P3** wrong numbers shown to users · **P4–P7** material but scoped · **P8–P11** spec/architecture debt.

### 5.1 · P1 · `Deliv. date(From/to)` is not a delivery date — Demand Realism is unbuildable

The PRD makes Demand Realism a P1 KPI (F5.1) and a §2 success metric. It requires a *requested* delivery date per PR item. Measured against the export:

| Test | Result |
|---|---|
| `Deliv. date(From/to)` == `Release Date` | **19,989 of 20,110 (99.40%)** |
| `Deliv. date(From/to)` == `Requisition date` | 19,252 (95.73%) |
| `Deliv. date` **>** `Requisition date` (a real future need date) | **572 rows (2.8%)** |
| Requested lead time (deliv − requisition) | median **0 days**, min **−887**, max 68 |
| Rows with negative requested lead | 286 (1.4%) |
| Actual lead time (PO date → first `101` receipt) | median **17 days** |

The column is a copy of the release/requisition date, not a need-by date. Computing the KPI as specified yields **0.3%** of PRs with a "realistic" requested lead — permanently red, permanently uninformative.

**This is a source-data problem, not a code problem.** Fix upstream: add the real SAP item delivery date (`EBAN-LFDAT`) to the ME5A export variant. Until then, F5.1 should be marked *blocked on feed change*, and the card must render `—` with "requested delivery date not present in this export" rather than a fabricated 0.3%.

Secondary: PO `Delivery date` (EINDT) equals `Document Date` on **37.4%** of lines, so vendor-OTD analytics built on EINDT are also weaker than the PRD's glossary implies ("the promised/confirmed date enabling true vendor OTD").

### 5.2 · P2 · Acceptance-criteria reference figures do not reproduce

The PRD's §2 success metric is "P1 KPI set reproduces the reference analysis figures on the same data." Measured on `Assets/`:

| PRD reference figure | PRD claim | Measured | Match |
|---|---|---|---|
| Split-sourced PR items / max POs | 645 / 33 | **645 / 33** | ✅ exact |
| Expedite Effectiveness ratio | 1.40× | **0.50×** (urgent median 6d vs standard 12d) | ❌ |
| GR/IR > 60d share of value | 44% | **91.67%** (commitment > 60d: 58.65%) | ❌ |
| Pending POs → fallback lines | 14 POs → 50 lines | **53 POs / 55 rows** pending in PO Release | ❌ |
| Token/zero-price lines | 49 (not 4,302) | 74 zero + 107 token non-STO (4,527 unfiltered) | ❌ |

I tested Expedite Effectiveness across six definition variants (PR date vs PR release date as the start; urgent = {1,2} vs {0,1,2}; standard = {3,4} vs {3}) — **every variant returns 0.50×**. The divergence is not a formula ambiguity. On this data the urgent lane is genuinely twice as fast, i.e. the KPI would read green, not the red the PRD anticipates.

The exact match on 645/33 alongside five mismatches suggests the PRD's KPI numbers were computed on a different vintage or scope of the export while the linkage figure was refreshed. Either way, **"reproduces the reference figures" is not a testable acceptance criterion** without a versioned fixture.

**Fix:** check a frozen anonymised fixture into the repo, express each KPI as an explicit formula (numerator, denominator, filters, as-of date), and generate the expected values from that fixture as a golden-number regression test.

### 5.3 · P3 · GR Date is contaminated by STO transfer postings

The GR map stores `date` as the **earliest posting date across all movement types**, while movement type is only consulted for reversal counters.

| Test | Result |
|---|---|
| PO-line keys where earliest-any-movement date < earliest `101` date | **1,695 of 15,134 (11.2%)** |
| Median days too early | **7 days** |
| Keys with `641`/`642` but **no** `101` at all | 47 (net qty 0, but a GR Date is still attached) |

Consequence: on 11% of receipted lines, `GR_Date` is a stock-transfer-out date, not a goods receipt. That understates **Deliv(d)**, **DelvsGR(d)** and **E2E(d)** by a median of 7 days, and the 47 no-`101` keys present as "received" with zero quantity.

**Fix:** derive the receipt date from `101` postings only (`min(Posting Date where Movement type = '101')`); keep `641`/`642` for transit analytics in the Delivery tab, keyed separately.

### 5.4 · P4 · Blank Release indicator is classified as `PO-Deleted`

The status machine reads:

```
1 / 2 / C → approved     X → PO-Not Approved     blank → PO-Deleted
```

But in this export a blank `Release indicator` means **no release strategy applies** — `Release group` is blank on exactly the same 964 lines. Deletion is carried separately by `Deletion indicator = L` (1,168 lines).

| Test | Result |
|---|---|
| Lines with blank `Release indicator` | 964 |
| …also flagged `Deletion indicator = L` | 723 |
| …**not** deleted, yet labelled `PO-Deleted` | **241 lines · 89 POs · IDR 1,506,586,519** |
| Those 89 POs' release records in PO Release | **0 — no release record exists at all** |

So 89 live POs worth ~IDR 1.5bn are silently removed from the open pipeline as "deleted". They also can never be approved (no release record), so the alternative classification — "pending" — would strand them in the approval queue forever.

**Fix:** read `Deletion indicator` for deletion. Treat "no release strategy" as a distinct third state and get a business ruling: are strategy-exempt POs auto-released (→ treat as approved) or genuinely unreleased?

### 5.5 · P5 · WBS compliance is measured on 11% column coverage

| Test | Result |
|---|---|
| `WBS Element` populated | 2,233 of 20,110 (**11.1%**) |
| Items over threshold (mat ≥ 30M / svc ≥ 150M) | 1,247 |
| …of which missing WBS | **1,119 (89.7%)**, across **339 PRs** |
| Value at risk | **IDR 3,482,267,279,089** (~3.48 trillion) |
| Under-threshold items that *do* carry WBS | 2,105 |
| Items with `Total Value = 0` (invisible to the test) | 4,211 (20.9%) |

The card will report near-total non-compliance. That is either a real and very large governance finding, or the rule is mis-specified — and the PRD already flags the ambiguity in its risk table ("per item vs per PR total"). Publishing a 90% non-compliance control metric without a business ruling is a credibility risk for the whole dashboard.

Also: the thresholds `30e6` / `150e6` are hardcoded in **two** places (the open-pipeline variant and the PR-tab variant). In production these belong in configuration with an effective-date, since IDR thresholds will be revised.

### 5.6 · P6 · FX uses only the newest month, and the anchor is fragile

The rate file supplies **monthly averages for Jan–Jul**. The absorber keeps only the latest row per currency pair, so every figure in a 7-month dataset is converted at the **July** average. January POs are valued at July rates.

Additional issues:
- `Month` has **no year** (`1.Jan` … `7.Jul`). The date parser maps the ordinal onto a hardcoded **year 2000**, so the UI's "latest: …" label displays a 2000 date. A bundle spanning Dec→Jan would order the months wrongly.
- Cross pairs not involving USD are deliberately skipped. Today the file carries direct `US$ → X` rows for all 15 currencies so nothing is lost — but a rate variant exporting only `X → IDR` would silently lose every currency except IDR, even though a USD anchor (`US$ → IDR`) is present and triangulation is exact to within 0.01%.
- `PO_Ccy` defaults to `'IDR'` when a PO's currency can't be resolved. A silent default currency contradicts the product's own no-silent-conversion principle.

**Fix:** period-matched conversion (join on the document's month) with latest-rate as an explicit fallback; parse the year or require it; implement triangulation through any shared pivot currency; make unresolved currency `null`, never `IDR`.

### 5.7 · P7 · The PR-centric row model marginalises 43.7% of the order book

The analytical grain is "one row per PR item × PO link". But **9,094 of 20,804 PO lines (43.7%) have no PR reference**, and only **51.6%** of PR items ever reach a PO. Direct POs are reachable only through fallback popups (PRD F6.1−).

For an operational dashboard that is a defensible prototype shortcut. For production it means nearly half of spend is a second-class citizen: not in the detail table, not in the row-model KPIs, only in fallbacks.

**Fix:** model PR items, PO lines and GR postings as three fact tables with explicit bridges, and let each tab choose its grain. This also removes the `_dup` / primary-row bookkeeping that currently protects PR-level counts from double-counting.

### 5.8 · P8 · PR Release continuation-row fill is order-dependent and unguarded

48% of the PR Release feed (13,338 rows) is `Rel Seq = 2` continuation rows with `PR No`, `PR Created Date`, `Plant`, `Material`, `Short Text` **all blank** and `PR Item` literally `0`. The implementation forward-fills the parent identifiers.

**Verified correct on this data** (§4.4). But correctness rests on two unstated conditions:
- Each continuation row must physically follow its parent row. True here (0 violations) — an export re-sort silently reattaches every L2 approval to the wrong PR.
- `PR Item = 0` must be treated as blank. It is, only because `toNum(0)` is falsy in JS. That is accidental, not designed.

Additionally, `_pickSeq` falls back to `Release Code` / `Release Indicator` when `Rel Seq` is absent. In this file `Rel Code` is 25/11/04 — those fallbacks would produce nonsense sequence numbers rather than failing loudly.

**Fix:** validate rather than assume — assert every continuation row follows a seq-1 row and that L2 date ≥ L1 date, count violations, and surface them in Data Check. Make the `PR Item = 0` sentinel explicit. Drop the misleading `_pickSeq` fallbacks.

### 5.9 · P9 · Movement-type handling is undocumented and partly accidental

The PRD names `101/102/122`. Reality: **`122` never occurs**, and **`641`/`642` are 8,956 rows (31.0%) of the feed** — entirely undocumented.

- Reversal netting works only because the export signs quantities. If a future variant exports absolute values with a sign column, `qty += ...` silently double-counts. The rule should be explicit: `signed_qty = qty × (movement type is a reversal ? −1 : +1)`, derived from movement type, not trusted from the sign.
- Reversal-rate analytics counts only `101`/`102`, excluding the 344 `642` reversals.
- **92 PO-line keys net to ≤ 0** after `101`/`102` netting — fully reversed receipts with no dedicated status. Today they may present as `Delivered`.

> **Two corrections to this section, made when the figures were re-derived in the built pipeline (see §12 below).** The fully-reversed count is **92**, not the 139 originally stated here: 139 included 47 PO lines that carry only `641`/`642` transfer postings and never received goods at all, so their receipt quantity is trivially zero rather than reversed. And the GR/IR and commitment shares above were originally computed on a **raw mixed-currency sum** — adding IDR, CNY and USD numerically without conversion. Converted properly to USD the figures are **91.67%** and **58.65%**. The naive sums reproduce the original 58.55% and 55.9%, which confirms the cause. That error is precisely the one the product's own no-silent-conversion rule exists to prevent, and it is why §5.2's recommendation to pin every KPI to a fixture with an explicit currency basis matters.

### 5.10 · P10 · PRD ↔ implementation drift in the data spec

| PRD §6 says | Implementation does | Who's right |
|---|---|---|
| GR quantity column: `Quantity` | `Qty in unit of entry` (fallback `Quantity`) | **Implementation.** The PRD would zero 22.4% of receipts. |
| PO price-unit column: `Per` | `Per` **or** `Price unit` | Implementation (EU layout uses `Price unit`) |
| Movement types `101/102/122` | 101/102 only | Neither — see §5.9 |
| — (not mentioned) | PR Release continuation-row format | Undocumented (§5.8) |
| — (not mentioned) | `Item of requisition = "0"` as null sentinel | Undocumented |
| — (not mentioned) | `US$` and `USD` coexisting in one export | Undocumented |
| Aging thresholds "> 60 days" | `_agingDays` uses **wall-clock today** | See §5.11 |

### 5.11 · P11 · Aging is measured against wall-clock today, not the data's as-of date

`_agingDays` computes `today − refDate` from `new Date()`. The bundle's latest document date is 2026-07-27; opened today (2026-07-30) every aging figure is +3 days. Re-open the same unchanged file in six months and all `> 60d` KPIs inflate by ~180 days with no data change.

**Fix (production requirement):** derive an explicit **as-of date** from the bundle (max of PO Document Date / GR Posting Date), display it prominently, and compute all aging against it. Allow an override for what-if analysis.

---

## 6. The PRD as a specification — gaps

Independent of the defects above, these are things a production build will need and the PRD does not provide:

**Data contract**
- No per-feed data dictionary with type, nullability, primary key, domain values, or sentinel conventions. §2 of this document is a starting point.
- No declared source variant/transaction per feed (ME5A / ME2N / MB51 + variant name), which is precisely what §5.1 turns out to hinge on.
- No schema-version or contract test. "Content detection + alias healing + per-row remap UI" mitigates drift at runtime but never *detects a semantic change* — a column that keeps its name and changes meaning (§5.1) passes every check the PRD describes.

**Definitions**
- KPIs are described in prose, not as formulas. Numerator, denominator, filters (STO? deleted? which currency basis?) and as-of date are unstated for every P1 KPI.
- "Open", "pending", "stuck" are used throughout without a single checkable definition.
- The 60-day aging threshold has no stated rationale or configurability.

**Targets and measurement**
- §2 success metrics are qualitative except "reproduces the reference figures", which §5.2 shows is unverifiable as written. No baselines, no target values, no measurement cadence.

**Non-functional**
- Compatibility NFR requires **cdnjs reachability**, which directly contradicts the offline/air-gapped positioning in §1 and the Privacy NFR. Vendor the libraries.
- Performance is stated as "within seconds on a standard laptop" for ~100k rows. Actual bundle is ~109k rows across five feeds / 16 MB. No concurrency target, no cold-start budget, no per-tab budget.
- No accessibility requirement (this is a dense analytics UI with colour-coded severity — WCAG contrast and non-colour encoding matter).
- No audit-log, data-retention, or PII position. The GR feed carries `User Name` and the release feeds carry `Login Name` and named approvers — that is personal data under Indonesian PDP law and needs an explicit stance.
- No row-level security model. The data spans **19 plants, 12 purchasing orgs, 368 requisitioners**; the GAS "execute as Me" model gives every viewer the owner's full read scope. The PRD notes the "audit trade-off" but does not raise scoping as a requirement.
- No i18n position (data is mixed Indonesian/English).
- No test strategy, fixtures, or regression suite.

**Scope**
- Out-of-scope omits multi-entity. This export is a single company code (`EU`) but 19 plants; the PRD's §5 references a "legacy multi-entity layout", so entity scoping needs an explicit decision.
- The risk table omits the two risks that actually materialised: **source field semantics drift** (§5.1) and **aging as-of ambiguity** (§5.11). It also omits timezone/date-parsing risk across locales.

---

## 7. Production-readiness assessment

| Dimension | Prototype | Gap for production |
|---|---|---|
| Structure | 1 HTML file, 7,227 lines, ~5,600 lines inline JS, no modules | Needs a real codebase: typed data layer, tested transforms, component UI |
| Tests | none | Golden-number KPI regression on a frozen fixture is the highest-value first test |
| Build | none | Vendored deps (removes the cdnjs/offline contradiction), CI, versioned releases |
| Data processing | full re-parse of 16 MB client-side on every load | Server-side ingest → typed store; incremental refresh; parsed-result caching |
| Persistence | `localStorage` for column maps, FX, exclusions | Server-side user prefs; the PRD already concedes GAS storage is unreliable |
| Auth / authz | web-app deployment setting; execute-as-owner | Real identity + row-level scoping by company/plant/purch-org |
| Auditability | none | Ingest lineage (which file, which sheet, which load, which row) — the "drill to evidence" persona demands it |
| Data freshness | implicit "now" | Explicit as-of date, load timestamp, staleness indicator |
| Observability | `console.log` | Structured logs on ingest outcomes, rejected rows, rule-violation counts |
| Numeric integrity | strong principles, correct in the paths I traced | Keep the principles; move them into typed, unit-tested functions |

**What to preserve:** the honesty rules (strict conversion, exact-set drills, anomaly tagging, `—` instead of fabricated values), the negative-path user stories, and the L0→L2 process model. These are the PRD's real assets.

---

## 8. Recommended sequence before writing production code

**Lock the data contract (blocking)**
1. Fix the PR delivery-date export (§5.1) — or formally descope Demand Realism. This is a request to whoever owns the ME5A variant and has the longest lead time, so raise it first.
2. Publish the data dictionary from §2 as the authoritative feed spec, replacing PRD §6. Include sentinels (`Item of requisition = "0"`, `PR Item = 0`), signed quantities, and the `US$`/`USD` duality.
3. Freeze an anonymised fixture from `Assets/` into the repo and generate expected KPI values from it (§5.2).

**Get business rulings (blocking on three)**
4. WBS threshold: per item or per PR total? And is 90% non-compliance real? (§5.5)
5. POs with no release strategy: auto-released or pending? (§5.4)
6. FX basis: period-matched monthly rate, or latest-rate for comparability? (§5.6)
7. Movement types `641`/`642`: in or out of delivery analytics, and how presented? (§5.9)

**Re-specify (non-blocking, do in parallel)**
8. Rewrite every P1 KPI as an explicit formula with filters and as-of date.
9. Add the as-of date requirement (§5.11) and a data-freshness indicator.
10. Add row-level security, audit lineage, PII stance, and accessibility to the NFRs.
11. Add contract tests that detect *semantic* drift, not just missing columns — e.g. assert that PR delivery date differs from release date on a material share of rows.

**Then build**
12. Three fact tables (PR item / PO line / GR posting) with explicit bridges (§5.7), not one denormalised PR-centric row model.
13. Port the honesty rules as tested functions first; build UI on top.

---

## Appendix — reproducing this analysis

Profiling scripts and raw outputs are in the session scratchpad:
`C:\Users\041250~1\AppData\Local\Temp\claude\D--Claude-Procurement-Dashboard\8af06481-de66-4e35-bf80-cabf8f5e848a\scratchpad\`
(`prof1.py`–`prof9.py`, `excel_structure.txt`, `prd_text.txt`). Move them into the repo if you want them retained — the scratchpad is session-scoped.
