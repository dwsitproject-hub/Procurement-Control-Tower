/**
 * Validation — PRD §11.
 *
 * Findings carry a severity that determines the outcome:
 *   BLOCKER — batch fails, nothing published, prior version keeps serving
 *   CAVEAT  — publishes, but the dependent KPIs are disabled and a banner shows
 *   WARNING — publishes; reported in Data Check with counts and drill-through
 *   INFO    — recorded for trend comparison
 *
 * The semantic checks (V-M*) are the class v1 lacked entirely: a column can keep
 * its name, its type and its population and still change meaning.
 */

import type { Feed, Severity } from '@pct/contracts';
import { query } from '../../db/client.js';
import type { TransformMetrics } from '../transform/transform.js';

export interface Finding {
  ruleId: string;
  severity: Severity;
  feed: Feed | null;
  message: string;
  affectedRows: number | null;
  measured: Record<string, unknown> | null;
  disablesKpis: string[];
  drillPredicate: Record<string, unknown> | null;
}

const ok = (): Finding[] => [];

// ───────────────────────────────────────────────────────── structural checks

export interface FileCheckInput {
  feed: Feed | null;
  displayName: string;
  outcome: 'exact' | 'healed' | 'drift' | 'unrecognised';
  missingRequired: string[];
  unexpectedHeaders: string[];
  healedFields: string[];
  rowCount: number;
  priorRowCount: number | null;
}

export function checkFile(f: FileCheckInput): Finding[] {
  const out: Finding[] = [];

  if (f.feed === null) {
    out.push({
      ruleId: 'V-S01',
      severity: 'WARNING',
      feed: null,
      message: `"${f.displayName}" does not match any feed signature and was skipped. Nothing was guessed into a feed slot.`,
      affectedRows: null,
      measured: { unexpectedHeaders: f.unexpectedHeaders.slice(0, 20) },
      disablesKpis: [],
      drillPredicate: null,
    });
    return out;
  }

  if (f.missingRequired.length > 0) {
    out.push({
      ruleId: 'V-S02',
      severity: 'BLOCKER',
      feed: f.feed,
      message: `${f.feed}: required column(s) unresolvable — ${f.missingRequired.join(', ')}. Add a steward mapping or restore the column at source.`,
      affectedRows: null,
      measured: { missing: f.missingRequired },
      disablesKpis: [],
      drillPredicate: null,
    });
  }

  if (f.healedFields.length > 0) {
    out.push({
      ruleId: 'V-S02a',
      severity: 'INFO',
      feed: f.feed,
      message: `${f.feed}: ${f.healedFields.length} column(s) resolved via an alias or steward mapping — ${f.healedFields.join(', ')}.`,
      affectedRows: null,
      measured: { healed: f.healedFields },
      disablesKpis: [],
      drillPredicate: null,
    });
  }

  if (f.unexpectedHeaders.length > 0) {
    out.push({
      ruleId: 'V-S03',
      severity: 'WARNING',
      feed: f.feed,
      message: `${f.feed}: ${f.unexpectedHeaders.length} unexpected column(s) present — ${f.unexpectedHeaders.slice(0, 8).join(', ')}${f.unexpectedHeaders.length > 8 ? ' …' : ''}. The export layout may have changed.`,
      affectedRows: null,
      measured: { unexpected: f.unexpectedHeaders },
      disablesKpis: [],
      drillPredicate: null,
    });
  }

  if (f.rowCount === 0) {
    out.push({
      ruleId: 'V-S05',
      severity: 'BLOCKER',
      feed: f.feed,
      message: `${f.feed}: the file contains no data rows.`,
      affectedRows: 0,
      measured: null,
      disablesKpis: [],
      drillPredicate: null,
    });
  } else if (f.priorRowCount !== null && f.priorRowCount > 0) {
    const change = (f.rowCount - f.priorRowCount) / f.priorRowCount;
    if (Math.abs(change) > 0.6) {
      out.push({
        ruleId: 'V-S05',
        severity: 'WARNING',
        feed: f.feed,
        message: `${f.feed}: row count moved ${(change * 100).toFixed(0)}% versus the previous version (${f.priorRowCount} → ${f.rowCount}). Confirm the export selection criteria.`,
        affectedRows: f.rowCount,
        measured: { prior: f.priorRowCount, current: f.rowCount, changePct: change * 100 },
        disablesKpis: [],
        drillPredicate: null,
      });
    }
  }

  return out;
}

// ─────────────────────────────────────────── referential & semantic checks

/**
 * Checks that need the staged data. Run before transform so a BLOCKER stops the
 * batch without building a version.
 */
export async function checkStaged(batchId: number): Promise<Finding[]> {
  const out: Finding[] = [];

  // ── V-R07 (BLOCKER): every GR movement type must be registered ──
  const unregistered = await query<{ movement_type: string; n: number }>(
    `SELECT payload->>'movementType' AS movement_type, count(*)::int AS n
       FROM staging.raw_row r
      WHERE r.batch_id = $1 AND r.feed = 'gr'
        AND payload->>'movementType' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM core.dim_movement_type m
           WHERE m.movement_type = r.payload->>'movementType')
      GROUP BY 1 ORDER BY 2 DESC`,
    [batchId],
  );
  if (unregistered.length > 0) {
    out.push({
      ruleId: 'V-R07',
      severity: 'BLOCKER',
      feed: 'gr',
      message: `Unregistered GR movement type(s): ${unregistered.map((u) => `${u.movement_type} (${u.n} rows)`).join(', ')}. Register each with its class and sign factor after confirming the semantics with the SAP team — a sign must never be guessed.`,
      affectedRows: unregistered.reduce((s, u) => s + u.n, 0),
      measured: { types: unregistered },
      disablesKpis: [],
      drillPredicate: null,
    });
  }

  // ── V-M01 (CAVEAT): is `Deliv. date(From/to)` actually a need-by date? ──
  // The check v1 lacked. The column is present, populated and correctly typed —
  // it passes every structural test — yet equals Release Date on 99.40% of rows.
  const delivSemantic = await query<{ total: number; differing: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (
              WHERE payload->>'delivDateRaw' IS DISTINCT FROM payload->>'releaseDate'
            )::int AS differing
       FROM staging.raw_row
      WHERE batch_id = $1 AND feed = 'pr'`,
    [batchId],
  );
  const dv = delivSemantic[0];
  if (dv && dv.total > 0) {
    const pct = (dv.differing / dv.total) * 100;
    // A genuine need-by column would be present and would differ materially.
    const hasNeedBy = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM staging.raw_row
        WHERE batch_id = $1 AND feed = 'pr' AND payload->>'needByDate' IS NOT NULL`,
      [batchId],
    );
    const needByPresent = (hasNeedBy[0]?.n ?? 0) > 0;

    if (!needByPresent && pct < 50) {
      out.push({
        ruleId: 'V-M01',
        severity: 'CAVEAT',
        feed: 'pr',
        message: `Requested delivery date is not distinct from release date (${pct.toFixed(2)}% of rows differ, expected >= 50%). The column is not a need-by date, so Demand Realism remains disabled. Fix: add SAP EBAN-LFDAT to the ME5A export variant (PRD 13.1.1).`,
        affectedRows: dv.total - dv.differing,
        measured: { expected: '>=50%', actual: `${pct.toFixed(2)}%`, total: dv.total, differing: dv.differing },
        disablesKpis: ['demand_realism'],
        drillPredicate: null,
      });
    }
  }

  // ── V-M03 (INFO): EINDT usefulness for vendor OTD ──
  const eindt = await query<{ total: number; differing: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (
              WHERE payload->>'deliveryDate' IS DISTINCT FROM payload->>'documentDate'
            )::int AS differing
       FROM staging.raw_row
      WHERE batch_id = $1 AND feed = 'po'`,
    [batchId],
  );
  const ei = eindt[0];
  if (ei && ei.total > 0) {
    const samePct = ((ei.total - ei.differing) / ei.total) * 100;
    out.push({
      ruleId: 'V-M03',
      severity: samePct > 50 ? 'CAVEAT' : 'INFO',
      feed: 'po',
      message: `PO delivery date (EINDT) equals document date on ${samePct.toFixed(1)}% of lines. Vendor on-time-delivery analytics carry this caveat.`,
      affectedRows: ei.total - ei.differing,
      measured: { samePct },
      disablesKpis: samePct > 50 ? ['cycle_delivery'] : [],
      drillPredicate: { grain: 'po_line', filters: { eindtEqualsDocdate: true } },
    });
  }

  // ── V-M04 (INFO): the correct GR quantity column is populated ──
  const grQty = await query<{ total: number; entry_zero: number; quantity_zero: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE COALESCE((payload->>'qtyEntry')::numeric, 0) = 0)::int AS entry_zero,
            count(*) FILTER (WHERE payload->>'qtyEntry' IS NULL)::int AS quantity_zero
       FROM staging.raw_row
      WHERE batch_id = $1 AND feed = 'gr'`,
    [batchId],
  );
  const gq = grQty[0];
  if (gq && gq.total > 0 && gq.entry_zero / gq.total > 0.01) {
    out.push({
      ruleId: 'V-M04',
      severity: 'WARNING',
      feed: 'gr',
      message: `"Qty in unit of entry" is zero on ${((gq.entry_zero / gq.total) * 100).toFixed(1)}% of GR rows. Receipt quantities may be understated.`,
      affectedRows: gq.entry_zero,
      measured: { total: gq.total, zero: gq.entry_zero },
      disablesKpis: [],
      drillPredicate: null,
    });
  }

  return out;
}

// ──────────────────────────────────── post-transform checks (metrics based)

export function checkMetrics(m: TransformMetrics, rules: Record<string, unknown>): Finding[] {
  const out: Finding[] = [];

  // ── V-R04 (BLOCKER): PR Release continuation-row order ──
  // The guard v1 lacked. The forward-fill is correct only if each continuation
  // row physically follows its parent; a re-sorted export would silently
  // reattach every level-2 approval to the wrong PR.
  if (m.continuationOrderViolations > 0) {
    out.push({
      ruleId: 'V-R04',
      severity: 'BLOCKER',
      feed: 'prel',
      message: `${m.continuationOrderViolations} PR Release continuation row(s) are not immediately preceded by a sequence-1 row. The export appears re-sorted; forward-filling would misattribute level-2 approvals. Request the export in its original order.`,
      affectedRows: m.continuationOrderViolations,
      measured: { violations: m.continuationOrderViolations },
      disablesKpis: [],
      drillPredicate: null,
    });
  }
  if (m.continuationDuplicateKeys > 0) {
    out.push({
      ruleId: 'V-R04a',
      severity: 'BLOCKER',
      feed: 'prel',
      message: `${m.continuationDuplicateKeys} duplicate (PR, item, sequence) key(s) after continuation-row fill.`,
      affectedRows: m.continuationDuplicateKeys,
      measured: null,
      disablesKpis: [],
      drillPredicate: null,
    });
  }
  if (m.l2BeforeL1 > 0) {
    out.push({
      ruleId: 'V-R05',
      severity: 'WARNING',
      feed: 'prel',
      message: `${m.l2BeforeL1} release row(s) show level 2 approved before level 1.`,
      affectedRows: m.l2BeforeL1,
      measured: null,
      disablesKpis: [],
      drillPredicate: null,
    });
  }

  if (m.grOrphans > 0) {
    out.push({
      ruleId: 'V-R01',
      severity: 'WARNING',
      feed: 'gr',
      message: `${m.grOrphans} GR posting(s) reference a PO line absent from the PO Report. They are reported, never force-attached.`,
      affectedRows: m.grOrphans,
      measured: null,
      disablesKpis: [],
      drillPredicate: null,
    });
  }

  if (m.danglingPrRefs > 0) {
    out.push({
      ruleId: 'V-R03',
      severity: 'WARNING',
      feed: 'po',
      message: `${m.danglingPrRefs} PO line(s) reference a requisition absent from the PR Report. The PO lines are kept intact and flagged, never fabricating PR attributes.`,
      affectedRows: m.danglingPrRefs,
      measured: null,
      disablesKpis: [],
      drillPredicate: { grain: 'po_line', filters: { linkStatus: 'dangling' } },
    });
  }

  if (m.unratedCurrencies.length > 0) {
    out.push({
      ruleId: 'V-R06',
      severity: 'CAVEAT',
      feed: 'fx',
      message: `No FX rate for ${m.unratedCurrencies.join(', ')}. USD-consolidated figures involving these currencies render per currency instead — never silently converted.`,
      affectedRows: null,
      measured: { missing: m.unratedCurrencies },
      disablesKpis: [],
      drillPredicate: null,
    });
  }

  if (m.fxYearResolved === null) {
    out.push({
      ruleId: 'V-R06a',
      severity: 'BLOCKER',
      feed: 'fx',
      message: `The rate file's month column carries no year and the period cannot be anchored unambiguously from the data range. Add a year to the rate export.`,
      affectedRows: null,
      measured: null,
      disablesKpis: [],
      drillPredicate: null,
    });
  }

  // ── business anomalies (WARNING, drillable) ──
  const warn = (
    ruleId: string,
    feed: Feed,
    count: number,
    message: string,
    predicate: Record<string, unknown> | null = null,
  ) => {
    if (count > 0) {
      out.push({
        ruleId,
        severity: 'WARNING',
        feed,
        message,
        affectedRows: count,
        measured: { count },
        disablesKpis: [],
        drillPredicate: predicate,
      });
    }
  };

  warn('V-B01', 'po', m.tokenPriceLinesNonSto,
    `${m.tokenPriceLinesNonSto} non-STO line(s) carry a token price (0 < net price <= 1). Spend is understated for these vendors.`,
    { grain: 'po_line', filters: { isTokenPrice: true } });

  warn('V-B02', 'po', m.zeroPriceLinesNonSto,
    `${m.zeroPriceLinesNonSto} non-STO line(s) have a zero net price.`,
    { grain: 'po_line', filters: { isZeroPrice: true } });

  warn('V-B03', 'po', m.stoLines,
    `${m.stoLines} stock-transport line(s) across ${m.stoPos} POs. Excluded from price, spend and PO-count analytics; retained in delivery.`,
    { grain: 'po_line', filters: { isSto: true } });

  warn('V-B04', 'pr', m.wbsIndeterminateItems,
    `${m.wbsIndeterminateItems} PR item(s) have zero or missing valuation and cannot be tested against any WBS threshold. Reported as indeterminate — never counted as compliant.`,
    { grain: 'pr_item', filters: { wbsStatus: 'indeterminate' } });

  warn('V-B07', 'gr', m.fullyReversedLineKeys,
    `${m.fullyReversedLineKeys} PO line(s) net to zero or below after reversal netting.`,
    { grain: 'po_line', filters: { status: 'Fully Reversed' } });

  warn('V-B10', 'po', m.releaseExemptLines,
    `${m.releaseExemptLines} PO line(s) across ${m.releaseExemptPos} POs have no release strategy and are not deleted. Marked release-exempt: included in pipeline, commitment and delivery analytics, excluded from the pending-approval queue.`,
    { grain: 'po_line', filters: { releaseExempt: true } });

  // ── INFO metrics for trend comparison ──
  out.push({
    ruleId: 'V-I01',
    severity: 'INFO',
    feed: null,
    message: `Linkage: ${m.prItemsWithPo} PR item(s) reached a PO; ${m.splitSourcedPrItems} split-sourced (max ${m.maxPoLinesPerPrItem} PO lines on one item); ${m.directPoLines} direct PO line(s) with no requisition.`,
    affectedRows: null,
    measured: {
      prItemsWithPo: m.prItemsWithPo,
      splitSourced: m.splitSourcedPrItems,
      maxPoLines: m.maxPoLinesPerPrItem,
      directPoLines: m.directPoLines,
    },
    disablesKpis: [],
    drillPredicate: null,
  });

  if (m.excludedPoLines > 0 || m.excludedPrItems > 0) {
    out.push({
      ruleId: 'V-C01',
      severity: 'WARNING',
      feed: null,
      message: `Exclusion config removed ${m.excludedPoLines} PO line(s) and ${m.excludedPrItems} PR item(s) from every view. Edit under Admin > Exclusions; changes apply on the next recompute.`,
      affectedRows: m.excludedPoLines + m.excludedPrItems,
      measured: { excludedPoLines: m.excludedPoLines, excludedPrItems: m.excludedPrItems },
      disablesKpis: [],
      drillPredicate: null,
    });
  }

  out.push({
    ruleId: 'V-B08',
    severity: 'INFO',
    feed: 'gr',
    message: `Receipt dates derive from movement type 101 only. ${m.contaminatedGrDates} published line(s) have a receipt date preceding their first 101 posting.`,
    affectedRows: m.contaminatedGrDates,
    measured: { contaminated: m.contaminatedGrDates },
    disablesKpis: [],
    drillPredicate: null,
  });

  void rules;
  return out;
}

export function worstSeverity(findings: readonly Finding[]): Severity | null {
  if (findings.some((f) => f.severity === 'BLOCKER')) return 'BLOCKER';
  if (findings.some((f) => f.severity === 'CAVEAT')) return 'CAVEAT';
  if (findings.some((f) => f.severity === 'WARNING')) return 'WARNING';
  if (findings.length > 0) return 'INFO';
  return null;
}

export function disabledKpis(findings: readonly Finding[]): Set<string> {
  const out = new Set<string>();
  for (const f of findings) {
    if (f.severity === 'BLOCKER' || f.severity === 'CAVEAT') {
      for (const k of f.disablesKpis) out.add(k);
    }
  }
  return out;
}

export { ok };
