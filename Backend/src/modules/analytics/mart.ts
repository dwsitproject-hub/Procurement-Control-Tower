/**
 * Mart build — PRD §13, §20.2.
 *
 * KPI values and chart series are computed ONCE at publish time, so read cost is
 * independent of user count. Each row stores the drill predicate that produced
 * it, which is what makes "drill count equals aggregate count" true by
 * construction rather than by convention.
 */

import type pg from 'pg';
import {
  expediteEffectiveness, mean, median, percentile, shareOverThreshold,
} from '@pct/rules';
import type { KpiId } from '@pct/contracts';
import { insertMany } from '../../db/client.js';
import { CHART_META } from './charts.js';
import { wbsLabel, type RuleSnapshot } from '../admin/rules.js';
import { buildParityMart } from './mart_parity.js';
import {
  buildFilterClause, isEmptyFilter, mergeIntoPredicate, type FactKind, type GlobalFilter,
} from './globalfilter.js';

type Sev = 'good' | 'neutral' | 'warning' | 'critical' | null;

interface KpiRow {
  kpiId: KpiId;
  status: 'ok' | 'insufficient_sample' | 'disabled' | 'unavailable';
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  sampleSize: number | null;
  unit: 'ratio' | 'percent' | 'days' | 'usd' | 'idr' | 'count';
  currencyBasis: 'usd_strict' | 'per_currency' | 'idr_based' | null;
  severity: Sev;
  statusReason: string | null;
  detail: Record<string, unknown> | null;
  drillPredicate: Record<string, unknown> | null;
}

const KPI_COLS = [
  'dataset_version_id', 'kpi_id', 'company_code', 'plant', 'purch_org', 'status', 'value_num',
  'numerator', 'denominator', 'sample_size', 'unit', 'currency_basis', 'severity',
  'status_reason', 'detail', 'drill_predicate',
] as const;

const CHART_COLS = [
  'dataset_version_id', 'chart_id', 'company_code', 'plant', 'purch_org', 'series_key',
  'series_label', 'bucket_key', 'bucket_label', 'bucket_ordinal', 'value_num', 'row_count',
  'unit', 'currency_basis', 'drill_predicate',
] as const;

export async function buildMart(
  client: pg.PoolClient,
  versionId: number,
  asOfDate: string,
  rules: RuleSnapshot,
  disabledKpis: ReadonlySet<string>,
): Promise<void> {
  const agingThreshold = Number(rules['aging.threshold_days'] ?? 60);
  const minSample = Number(rules['kpi.min_sample'] ?? 30);

  const kpis: KpiRow[] = [];
  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await client.query<T>(sql, params)).rows;

  // The fourteen inline KPIs and the five cycle times: one function each, shared
  // with the filtered path (live.ts), so a filtered figure is this SQL plus
  // the filter and never a second definition.
  kpis.push(...await inlineKpis(q, versionId, rules, disabledKpis, {}));
  kpis.push(...await cycleKpis(q, versionId, minSample, disabledKpis, {}));

  // ───────────────────────────────────────────────────────── persist KPIs

  await insertMany(
    client,
    'mart.kpi_value',
    KPI_COLS,
    kpis.map((k) => [
      versionId, k.kpiId, '*', '*', '*', k.status, k.value, k.numerator, k.denominator,
      k.sampleSize, k.unit, k.currencyBasis, k.severity, k.statusReason,
      k.detail === null ? null : JSON.stringify(k.detail),
      k.drillPredicate === null ? null : JSON.stringify(k.drillPredicate),
    ]),
  );

  await buildCharts(client, versionId, agingThreshold);
  // The v1 parity cards and charts (Docs/V1_V2_Parity_Matrix.md).
  await buildParityMart(client, versionId);
  void asOfDate;
}

/** The KPIs inlineKpis() produces, so the live path knows which ids it covers. */
export const INLINE_KPI_IDS: readonly KpiId[] = [
  'demand_realism', 'otd_vs_requested', 'expedite_effectiveness', 'grir_over_60d',
  'commitment_over_60d', 'wbs_compliance', 'sto_share', 'direct_po_share', 'retro_po_rate',
  'open_items', 'split_sourcing', 'reversal_rate', 'pending_pr_approvals', 'pending_po_approvals',
];

/**
 * The fourteen KPIs written directly in the mart build rather than as parity
 * specs, for the mart (empty filter) AND for a filtered request.
 *
 * Until 7 Oct 2026 they had no filtered path at all: under any global filter
 * they rendered "does not support the global filter yet". With the Year filter
 * now on by default (the current year, on every page) that would have been
 * fourteen dashes on first load, so each one now takes the filter - the SAME
 * query with the clause added, as the parity KPIs and the cycle times do.
 *
 * Each block filters the grain its drill opens, so the card and its drill
 * agree under a filter (the sweep checks this). A block whose grain cannot take
 * a filter (the scope toggle on GR postings, say) reports itself unavailable
 * under that filter instead of quietly returning the unfiltered number.
 */
export async function inlineKpis(
  q: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
  versionId: number,
  rules: RuleSnapshot,
  disabledKpis: ReadonlySet<string>,
  filter: GlobalFilter,
): Promise<KpiRow[]> {
  const agingThreshold = Number(rules['aging.threshold_days'] ?? 60);
  const minSample = Number(rules['kpi.min_sample'] ?? 30);
  const kpis: KpiRow[] = [];
  const filtered = !isEmptyFilter(filter);
  const drillOf = (d: Record<string, unknown>) => (filtered ? mergeIntoPredicate(d, filter) : d);
  /** The filter as a WHERE fragment for one grain, numbered after $1. */
  const fc = (kind: FactKind, alias: string) => buildFilterClause(filter, kind, alias, 2);
  /**
   * Run one block; under a filter, a block that cannot take it reports its
   * KPIs as unavailable. Unfiltered, a failure is a real fault and is thrown.
   */
  const block = async (ids: Array<[KpiId, KpiRow['unit']]>, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      if (!filtered) throw err;
      for (const [kpiId, unit] of ids) {
        kpis.push({
          kpiId, status: 'unavailable', value: null, numerator: null, denominator: null,
          sampleSize: null, unit, currencyBasis: null, severity: null,
          statusReason: `Could not compute under the active filter: ${
            err instanceof Error ? err.message.slice(0, 120) : 'unknown error'}`,
          detail: null, drillPredicate: null,
        });
      }
    }
  };

  // ─────────────────────────────────── Demand Realism (disabled by V-M01)

  if (disabledKpis.has('demand_realism')) {
    kpis.push({
      kpiId: 'demand_realism',
      status: 'disabled',
      value: null,
      numerator: null,
      denominator: null,
      sampleSize: null,
      unit: 'percent',
      currencyBasis: null,
      severity: null,
      // Rendered verbatim in the card tooltip. NOT a fabricated 0.3%.
      statusReason:
        'Requested delivery date not present in this export (V-M01). Fix: add SAP EBAN-LFDAT to the ME5A variant. See PRD 13.1.1.',
      detail: null,
      drillPredicate: null,
    });
  } else {
    await block([['demand_realism', 'percent']], async () => {
      const cp = fc('pr_item', '');
      const rows = await q<{ req_lead: number | null; material_group: string | null }>(
        `SELECT (need_by_date - requisition_date) AS req_lead, material_group
           FROM core.fact_pr_item
          WHERE dataset_version_id = $1 AND need_by_date IS NOT NULL AND requisition_date IS NOT NULL
            AND NOT is_deleted${cp.sql}`,
        [versionId, ...cp.params],
      );
      // The benchmark (actual lead time per material group) is filtered the same
      // way, on the requisition: "realistic" means realistic for this slice.
      const ca = fc('pr_item', 'pri.');
      const actual = await q<{ material_group: string | null; lead: number | null }>(
        `SELECT pri.material_group, (pol.receipt_date - pri.requisition_date) AS lead
           FROM core.fact_po_line pol
           JOIN core.fact_pr_item pri
             ON pri.dataset_version_id = pol.dataset_version_id
            AND pri.pr_no = pol.pr_no AND pri.pr_item = pol.pr_item
          WHERE pol.dataset_version_id = $1 AND pol.receipt_date IS NOT NULL${ca.sql}`,
        [versionId, ...ca.params],
      );
      const byGroup = new Map<string, number[]>();
      const all: number[] = [];
      for (const r of actual) {
        if (r.lead === null) continue;
        all.push(r.lead);
        const k = r.material_group ?? '?';
        const list = byGroup.get(k);
        if (list) list.push(r.lead);
        else byGroup.set(k, [r.lead]);
      }
      const overall = median(all);
      let evaluated = 0;
      let realistic = 0;
      for (const r of rows) {
        if (r.req_lead === null) continue;
        const bench = median(byGroup.get(r.material_group ?? '?') ?? []) ?? overall;
        if (bench === null) continue;
        evaluated += 1;
        if (r.req_lead >= bench) realistic += 1;
      }
      kpis.push(
        evaluated < minSample
          ? nullKpi('demand_realism', 'percent', `Fewer than ${minSample} evaluable requisitions.`, evaluated)
          : {
              kpiId: 'demand_realism',
              status: 'ok',
              value: (realistic / evaluated) * 100,
              numerator: realistic,
              denominator: evaluated,
              sampleSize: evaluated,
              unit: 'percent',
              currencyBasis: null,
              severity: realistic / evaluated < 0.4 ? 'critical' : 'good',
              statusReason: null,
              detail: { actualMedianDays: overall },
              drillPredicate: drillOf({ grain: 'pr_item', filters: { demandUnrealistic: true } }),
            },
      );
    });
  }

  // ───────────────────────────── On-Time vs the PO Delivery Date (7 Oct 2026)
  //
  // Was: receipt on or before the REQUESTED date (the PR's need-by, EBAN-LFDAT),
  // which the PR export does not carry, so the card had been disabled by V-M01
  // since it was built. Now, as asked: the GR date against the PO's own
  // Delivery Date (EINDT) - the date the order promised. V-M03 still applies:
  // on about a quarter of lines that date equals the PO date, which makes such
  // a line late by construction unless it is received the day it is ordered.

  await block([['otd_vs_requested', 'percent']], async () => {
    const c = fc('po_line', '');
    const [row] = await q<{ ok: number; tot: number }>(
      `SELECT count(*) FILTER (WHERE receipt_date <= delivery_date)::int AS ok,
              count(*)::int AS tot
         FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND NOT is_deleted AND NOT is_sto
          AND receipt_date IS NOT NULL AND delivery_date IS NOT NULL${c.sql}`,
      [versionId, ...c.params],
    );
    const tot = row?.tot ?? 0;
    kpis.push(
      tot < minSample
        ? nullKpi('otd_vs_requested', 'percent', `Fewer than ${minSample} lines carry both a receipt and a PO delivery date.`, tot)
        : {
            kpiId: 'otd_vs_requested',
            status: 'ok',
            value: ((row?.ok ?? 0) / tot) * 100,
            numerator: row?.ok ?? 0,
            denominator: tot,
            sampleSize: tot,
            unit: 'percent',
            currencyBasis: null,
            severity: (row?.ok ?? 0) / tot < 0.5 ? 'critical' : (row?.ok ?? 0) / tot < 0.8 ? 'warning' : 'good',
            statusReason: null,
            detail: null,
            drillPredicate: drillOf({
              grain: 'po_line',
              filters: { notDeleted: true, notSto: true, otdrEvaluable: true },
            }),
          },
    );
  });

  // ───────────────────────────────────────────── Expedite Effectiveness

  await block([['expedite_effectiveness', 'ratio']], async () => {
    // On the requisition, which is the grain the drill opens.
    const c = fc('pr_item', 'pri.');
    const rows = await q<{ urgency: number | null; days: number | null }>(
      `SELECT pri.urgency, (pol.document_date - pri.requisition_date) AS days
         FROM core.bridge_pr_po b
         JOIN core.fact_pr_item pri
           ON pri.dataset_version_id = b.dataset_version_id
          AND pri.pr_no = b.pr_no AND pri.pr_item = b.pr_item
         JOIN core.fact_po_line pol
           ON pol.dataset_version_id = b.dataset_version_id
          AND pol.po_no = b.po_no AND pol.po_item = b.po_item
        WHERE b.dataset_version_id = $1 AND b.split_seq = 1
          AND NOT pri.is_deleted AND NOT pol.is_sto
          AND pri.requisition_date IS NOT NULL AND pol.document_date IS NOT NULL${c.sql}`,
      [versionId, ...c.params],
    );
    // Urgent = {1,2}; standard = {3,4}. Urgency 0 is undefined in the source and
    // excluded from both arms.
    const urgent = rows.filter((r) => r.urgency === 1 || r.urgency === 2).map((r) => r.days!).filter((d) => d !== null);
    const standard = rows.filter((r) => r.urgency === 3 || r.urgency === 4).map((r) => r.days!).filter((d) => d !== null);
    const e = expediteEffectiveness(urgent, standard, minSample);

    kpis.push(
      e.status === 'ok'
        ? {
            kpiId: 'expedite_effectiveness',
            status: 'ok',
            value: e.ratio,
            numerator: e.urgentMedian,
            denominator: e.standardMedian,
            sampleSize: e.urgentSample + e.standardSample,
            unit: 'ratio',
            currencyBasis: null,
            // >= 1 means the urgent lane is no faster, i.e. the flag is abused.
            severity: (e.ratio ?? 0) >= 1 ? 'critical' : (e.ratio ?? 0) < 0.8 ? 'good' : 'warning',
            statusReason: null,
            detail: {
              urgentMedianDays: e.urgentMedian,
              standardMedianDays: e.standardMedian,
              urgentSample: e.urgentSample,
              standardSample: e.standardSample,
            },
            drillPredicate: drillOf({ grain: 'pr_item', filters: { urgencyIn: [1, 2] } }),
          }
        : nullKpi('expedite_effectiveness', 'ratio', 'Not enough matched requisitions in each arm.', e.urgentSample + e.standardSample),
    );
  });

  // ───────────────────────────────── GR/IR and open commitment > threshold

  await block([['grir_over_60d', 'percent']], async () => {
    const c = fc('po_line', '');
    const rows = await q<{ val: number | null; usd: number | null; aging: number | null; ccy: string }>(
      `SELECT still_invoice_val AS val, still_invoice_val_usd AS usd, aging_days AS aging, currency_code AS ccy
         FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
          AND COALESCE(still_deliver_qty, 0) = 0 AND COALESCE(still_invoice_val, 0) > 0${c.sql}`,
      [versionId, ...c.params],
    );
    kpis.push(withDrill(shareKpi('grir_over_60d', rows, agingThreshold, 'warning'), drillOf));
  });

  await block([['commitment_over_60d', 'percent']], async () => {
    const c = fc('po_line', '');
    const rows = await q<{ val: number | null; usd: number | null; aging: number | null; ccy: string }>(
      `SELECT still_deliver_val AS val, still_deliver_val_usd AS usd, aging_days AS aging, currency_code AS ccy
         FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
          AND COALESCE(still_deliver_val, 0) > 0${c.sql}`,
      [versionId, ...c.params],
    );
    kpis.push(withDrill(shareKpi('commitment_over_60d', rows, agingThreshold, 'warning'), drillOf));
  });

  // ──────────────────────────────────────────────────── WBS compliance

  await block([['wbs_compliance', 'count']], async () => {
    const c = fc('pr_item', '');
    const rows = await q<{ violations: number; prs: number; over: number; indet: number; value: number | null }>(
      `SELECT count(*) FILTER (WHERE wbs_status = 'violation')::int AS violations,
              count(DISTINCT pr_no) FILTER (WHERE wbs_status = 'violation')::int AS prs,
              count(*) FILTER (WHERE wbs_status IN ('violation','compliant'))::int AS over,
              count(*) FILTER (WHERE wbs_status = 'indeterminate')::int AS indet,
              COALESCE(sum(total_value_idr) FILTER (WHERE wbs_status = 'violation'), 0) AS value
         FROM core.fact_pr_item
        WHERE dataset_version_id = $1${c.sql}`,
      [versionId, ...c.params],
    );
    const r = rows[0]!;
    kpis.push({
      kpiId: 'wbs_compliance',
      status: 'ok',
      value: r.violations,
      numerator: r.violations,
      denominator: r.over,
      sampleSize: r.over,
      unit: 'count',
      currencyBasis: 'idr_based',
      severity: r.over > 0 && r.violations / r.over > 0.5 ? 'critical' : r.violations > 0 ? 'warning' : 'good',
      statusReason: null,
      detail: {
        violationItems: r.violations,
        violationPrs: r.prs,
        overThresholdItems: r.over,
        indeterminateItems: r.indet,
        valueAtRiskIdr: r.value,
        // The rule in force must appear wherever the number does.
        thresholdLabel: wbsLabel(rules),
      },
      drillPredicate: drillOf({ grain: 'pr_item', filters: { wbsStatus: 'violation' } }),
    });
  });

  // ─────────────────────────────────────────────── operational counts

  let exemptLines = 0;
  await block(
    [['sto_share', 'percent'], ['direct_po_share', 'percent'], ['retro_po_rate', 'count'], ['open_items', 'count']],
    async () => {
      const cc = fc('po_line', '');
      const counts = await q<{
        po_lines: number; sto_lines: number; direct_po: number; dangling: number; retro: number;
        open_items: number; open_emg: number; open_urg: number; token: number; exempt: number;
      }>(
        `SELECT count(*)::int AS po_lines,
                count(*) FILTER (WHERE is_sto)::int AS sto_lines,
                -- A direct PO carries no requisition reference AT ALL. A dangling
                -- line DOES carry one that simply does not resolve — a different
                -- condition, counted separately so the two are never conflated.
                count(*) FILTER (WHERE link_status IS NULL)::int AS direct_po,
                count(*) FILTER (WHERE link_status = 'dangling')::int AS dangling,
                count(*) FILTER (WHERE is_retro_po)::int AS retro,
                count(*) FILTER (WHERE status IN ('PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered'))::int AS open_items,
                count(*) FILTER (WHERE status IN ('PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered') AND urgency <= 1)::int AS open_emg,
                count(*) FILTER (WHERE status IN ('PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered') AND urgency = 2)::int AS open_urg,
                count(*) FILTER (WHERE is_token_price)::int AS token,
                count(*) FILTER (WHERE release_exempt)::int AS exempt
           FROM core.fact_po_line WHERE dataset_version_id = $1${cc.sql}`,
        [versionId, ...cc.params],
      );
      const c = counts[0]!;
      exemptLines = c.exempt;

      kpis.push(simpleCount('sto_share', (c.sto_lines / Math.max(c.po_lines, 1)) * 100, 'percent', c.po_lines,
        { stoLines: c.sto_lines, totalLines: c.po_lines }, drillOf({ grain: 'po_line', filters: { isSto: true } })));

      kpis.push(simpleCount('direct_po_share', (c.direct_po / Math.max(c.po_lines, 1)) * 100, 'percent', c.po_lines,
        { directLines: c.direct_po, danglingLines: c.dangling, totalLines: c.po_lines },
        drillOf({ grain: 'po_line', filters: { directPo: true } })));

      kpis.push(simpleCount('retro_po_rate', c.retro, 'count', c.po_lines, { retroLines: c.retro },
        drillOf({ grain: 'po_line', filters: { isRetroPo: true } })));

      kpis.push(simpleCount('open_items', c.open_items, 'count', c.po_lines,
        {
          chip_emergency: c.open_emg, chip_urgent: c.open_urg,
          chip_standard: c.open_items - c.open_emg - c.open_urg,
        },
        drillOf({ grain: 'po_line', filters: { statusIn: ['PO-Not Approved', 'HOLD PO', 'PO-No GR', 'Partially Delivered'] } })));
    },
  );

  await block([['split_sourcing', 'count']], async () => {
    // Joined to the order line so the filter has columns to act on; every
    // bridge row has its order line, so the unfiltered count is unchanged.
    const c = fc('po_line', 'pol.');
    const split = await q<{ items: number; maxlines: number }>(
      `SELECT count(DISTINCT (b.pr_no, b.pr_item)) FILTER (WHERE b.split_total > 1)::int AS items,
              COALESCE(max(b.split_total), 0)::int AS maxlines
         FROM core.bridge_pr_po b
         JOIN core.fact_po_line pol
           ON pol.dataset_version_id = b.dataset_version_id
          AND pol.po_no = b.po_no AND pol.po_item = b.po_item
        WHERE b.dataset_version_id = $1${c.sql}`,
      [versionId, ...c.params],
    );
    kpis.push(simpleCount('split_sourcing', split[0]!.items, 'count', null,
      { maxPoLinesPerPrItem: split[0]!.maxlines, entityUnit: 'PR items' },
      drillOf({ grain: 'po_line', filters: { splitSourced: true } })));
  });

  await block([['reversal_rate', 'percent']], async () => {
    const c = fc('gr_posting', '');
    const rev = await q<{ receipts: number; reversals: number }>(
      `SELECT count(*) FILTER (WHERE movement_type = '101')::int AS receipts,
              count(*) FILTER (WHERE posting_class = 'reversal')::int AS reversals
         FROM core.fact_gr_posting WHERE dataset_version_id = $1${c.sql}`,
      [versionId, ...c.params],
    );
    const rv = rev[0]!;
    kpis.push(simpleCount('reversal_rate', rv.receipts > 0 ? (rv.reversals / rv.receipts) * 100 : 0, 'percent',
      rv.receipts, { receipts: rv.receipts, reversals: rv.reversals },
      drillOf({ grain: 'gr_posting', filters: { postingClass: 'reversal' } })));
  });

  await block([['pending_pr_approvals', 'count']], async () => {
    /*
     * PR items in the facts with an approval step still open. Counted on the
     * REQUISITION since 7 Oct 2026 (was: distinct items among the release rows)
     * so a Year or Month filter means the year the requisition was raised: on
     * the release rows themselves the only date is the approval date, which an
     * open step does not have, and every pending item vanished under the
     * default Year filter. 14 release-only items whose requisition is not in
     * the facts (excluded, or not in the PR List) no longer count - they could
     * never be opened as requisitions anyway.
     */
    const c = fc('pr_item', '');
    const pendPr = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.fact_pr_item
        WHERE dataset_version_id = $1
          AND EXISTS (SELECT 1 FROM core.fact_pr_release r
                       WHERE r.dataset_version_id = core.fact_pr_item.dataset_version_id
                         AND r.pr_no = core.fact_pr_item.pr_no AND r.pr_item = core.fact_pr_item.pr_item
                         AND r.approve_date IS NULL)${c.sql}`,
      [versionId, ...c.params],
    );
    kpis.push(simpleCount('pending_pr_approvals', pendPr[0]!.n, 'count', null, { entityUnit: 'PR items' },
      drillOf({ grain: 'pr_item', filters: { releasePending: true } })));
  });

  await block([['pending_po_approvals', 'count']], async () => {
    // Release-exempt POs are excluded: they have no release record and can
    // never be approved, so leaving them in the queue would strand them.
    const c = fc('po_line', '');
    const pendPo = await q<{ n: number }>(
      `SELECT count(DISTINCT po_no)::int AS n FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND po_release_state = 'pending'${c.sql}`,
      [versionId, ...c.params],
    );
    kpis.push(simpleCount('pending_po_approvals', pendPo[0]!.n, 'count', null,
      { releaseExemptExcluded: exemptLines, entityUnit: 'POs' },
      drillOf({ grain: 'po_line', filters: { poReleaseState: 'pending' } })));
  });

  return kpis;
}

/** A KPI built by a shared helper, with its drill re-issued under the filter. */
function withDrill(k: KpiRow, drillOf: (d: Record<string, unknown>) => Record<string, unknown> | null): KpiRow {
  return k.drillPredicate === null ? k : { ...k, drillPredicate: drillOf(k.drillPredicate) };
}

// ────────────────────────────────────────────────────────────────── helpers

function nullKpi(kpiId: KpiId, unit: KpiRow['unit'], reason: string, sample: number | null): KpiRow {
  return {
    kpiId, status: 'insufficient_sample', value: null, numerator: null, denominator: null,
    sampleSize: sample, unit, currencyBasis: null, severity: null, statusReason: reason,
    detail: null, drillPredicate: null,
  };
}

/** The KPIs cycleKpis() produces, so the live path knows which ids it covers. */
export const CYCLE_KPI_IDS: readonly KpiId[] = [
  'cycle_pr_approval', 'cycle_sourcing', 'cycle_po_approval', 'cycle_delivery', 'cycle_e2e',
];

/**
 * The five cycle-time KPIs, for the mart (empty filter) AND for a filtered
 * request.
 *
 * They were computed inline in buildMart, so a global filter had no way to
 * recompute them and the Executive Summary's four cycle tiles went to a dash the
 * moment anyone touched the filter bar (reported 25 Sep 2026) - while the
 * YTD/MTD lines under the same tiles, which read the rows directly, carried on
 * showing filtered figures. One function now serves both paths, so the
 * filtered figure is the unfiltered SQL with the filter added, as the parity
 * KPIs already are.
 */
export async function cycleKpis(
  q: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
  versionId: number,
  minSample: number,
  disabledKpis: ReadonlySet<string>,
  filter: GlobalFilter,
): Promise<KpiRow[]> {
  const out: KpiRow[] = [];
  const drillOf = (drill: Record<string, unknown>) =>
    isEmptyFilter(filter) ? drill : mergeIntoPredicate(drill, filter);

  // Every cycle card drills to its own evaluable lines (user ask 5 Aug 2026);
  // the filters reproduce the exact population the values come from - >= 0
  // for the three spans, every value for delivery (below).
  const cycles: Array<[KpiId, string, FactKind, Record<string, unknown>, boolean?]> = [
    ['cycle_pr_approval', 'release_final_date - requisition_date', 'pr_item',
      { grain: 'pr_item', filters: { released: true } }],
    ['cycle_sourcing', 'sourcing_days', 'po_line',
      { grain: 'po_line', filters: { measureNonNeg: 'sourcing' } }],
    ['cycle_po_approval', 'po_approval_days', 'po_line',
      { grain: 'po_line', filters: { measureNonNeg: 'po_approval' } }],
    /*
     * "Plan Deliv. -> GR" since 7 Oct 2026 (was PO released -> GR): the GR date
     * against the PO's own Delivery Date (EINDT), i.e. how late against the
     * promise. Early receipts are NEGATIVE and are kept: they are 37% of
     * received lines, and dropping them would report only the late half and
     * call it the average (25.3 days vs 11.6 on the reference data).
     */
    ['cycle_delivery', 'delivery_vs_promise_days', 'po_line',
      { grain: 'po_line', filters: { deliveryVsPlanEvaluable: true } }, true],
  ];
  for (const [kpiId, expr, kind, drill, keepNegative] of cycles) {
    const table = kind === 'pr_item' ? 'core.fact_pr_item' : 'core.fact_po_line';
    const clause = buildFilterClause(filter, kind, '', 2);
    const rows = await q<{ d: number | null }>(
      `SELECT (${expr}) AS d FROM ${table}
        WHERE dataset_version_id = $1 AND (${expr}) IS NOT NULL${clause.sql}`,
      [versionId, ...clause.params],
    );
    const vals = rows.map((x) => x.d!).filter((d) => d !== null && (keepNegative === true || d >= 0));
    // Average headline (decision 3 Aug 2026, v1 parity); median in the subtitle.
    out.push(cycleKpi(kpiId, vals, minSample, disabledKpis, 'avg', drillOf(drill)));
  }

  {
    // Filtered on the order line, which is the grain the drill opens.
    const clause = buildFilterClause(filter, 'po_line', 'pol.', 2);
    const rows = await q<{ d: number | null }>(
      `SELECT (pol.receipt_date - pri.requisition_date) AS d
         FROM core.fact_po_line pol
         JOIN core.fact_pr_item pri
           ON pri.dataset_version_id = pol.dataset_version_id
          AND pri.pr_no = pol.pr_no AND pri.pr_item = pol.pr_item
        WHERE pol.dataset_version_id = $1 AND pol.receipt_date IS NOT NULL${clause.sql}`,
      [versionId, ...clause.params],
    );
    out.push(cycleKpi('cycle_e2e', rows.map((x) => x.d!).filter((d) => d !== null && d >= 0),
      minSample, disabledKpis, 'median',
      drillOf({ grain: 'po_line', filters: { e2eEvaluable: true } })));
  }
  return out;
}

function cycleKpi(
  kpiId: KpiId,
  vals: number[],
  minSample: number,
  disabled: ReadonlySet<string>,
  basis: 'median' | 'avg' = 'median',
  drill: Record<string, unknown> | null = null,
): KpiRow {
  if (disabled.has(kpiId)) {
    return {
      kpiId, status: 'disabled', value: null, numerator: null, denominator: null,
      sampleSize: vals.length, unit: 'days', currencyBasis: null, severity: null,
      statusReason: 'Disabled by an active data caveat.', detail: null, drillPredicate: null,
    };
  }
  if (vals.length < minSample) {
    return nullKpi(kpiId, 'days', `Fewer than ${minSample} observations.`, vals.length);
  }
  // Both bases always travel together so the two stay reconcilable: whichever
  // is the headline, the other sits in the subtitle. The four stage cards use
  // the average (v1 parity, user decision 3 Aug 2026); E2E keeps the median
  // because 0-758-day outliers drag its average badly.
  const avg = mean(vals) === null ? null : Math.round(mean(vals)! * 10) / 10;
  const med = median(vals);
  return {
    kpiId, status: 'ok', value: basis === 'avg' ? avg : med,
    numerator: null, denominator: null,
    sampleSize: vals.length, unit: 'days', currencyBasis: null, severity: 'neutral',
    statusReason: null,
    drillPredicate: drill,
    detail: {
      ...(basis === 'avg' ? { median: med } : { avg }),
      p90: percentile(vals, 0.9),
      max: vals.length ? Math.max(...vals) : null,
    },
  };
}

/**
 * Share-of-value KPI with the strict no-silent-conversion rule.
 *
 * A USD figure is produced only when EVERY currency in scope converted. Otherwise
 * the share falls back to IDR-denominated documents only, labelled `idr_based` so
 * the caller can render "(IDR-based %)".
 */
function shareKpi(
  kpiId: KpiId,
  rows: readonly { val: number | null; usd: number | null; aging: number | null; ccy: string }[],
  thresholdDays: number,
  sev: Sev,
): KpiRow {
  const anyUnconverted = rows.some((r) => r.val !== null && r.usd === null);

  const basis: KpiRow['currencyBasis'] = anyUnconverted ? 'idr_based' : 'usd_strict';
  const usable = anyUnconverted
    ? rows.filter((r) => r.ccy === 'IDR').map((r) => ({ value: r.val ?? 0, agingDays: r.aging }))
    : rows.map((r) => ({ value: r.usd ?? 0, agingDays: r.aging }));

  const s = shareOverThreshold(usable, thresholdDays);
  if (s.pct === null) {
    return nullKpi(kpiId, 'percent', 'No qualifying documents in scope.', s.sampleSize);
  }
  return {
    kpiId, status: 'ok', value: s.pct, numerator: s.numerator, denominator: s.denominator,
    sampleSize: s.sampleSize, unit: 'percent', currencyBasis: basis,
    severity: s.pct > 50 ? 'critical' : s.pct > 25 ? sev : 'good',
    statusReason: null,
    detail: { thresholdDays, unconvertedPresent: anyUnconverted },
    drillPredicate: { grain: 'po_line', filters: { agingGt: thresholdDays } },
  };
}

function simpleCount(
  kpiId: KpiId,
  value: number,
  unit: KpiRow['unit'],
  sample: number | null,
  detail: Record<string, unknown> | null,
  predicate: Record<string, unknown> | null,
): KpiRow {
  return {
    kpiId, status: 'ok', value, numerator: null, denominator: null, sampleSize: sample,
    unit, currencyBasis: null, severity: 'neutral', statusReason: null, detail,
    drillPredicate: predicate,
  };
}

// ───────────────────────────────────────────────────────────────── charts

async function buildCharts(client: pg.PoolClient, versionId: number, agingThreshold: number): Promise<void> {
  const rows: unknown[][] = [];
  const push = (
    chartId: string, seriesKey: string, seriesLabel: string, bucketKey: string,
    bucketLabel: string, ordinal: number, value: number | null, count: number,
    unit: string, predicate: Record<string, unknown>,
  ) => {
    rows.push([
      versionId, chartId, '*', '*', '*', seriesKey, seriesLabel, bucketKey, bucketLabel,
      ordinal, value, count, unit, null, JSON.stringify(predicate),
    ]);
  };

  // The Executive Summary charts are NOT built here. They live in PARITY_CHARTS,
  // and buildParityMart() already runs every spec in that registry into
  // mart.chart_series — so writing them here as well violated the unique key on
  // (version, chart, series, bucket). One registry, one writer.
  //
  // That is also why they are filterable: liveChartAvailable() consults the same
  // registry, so the panel recomputes under the global filter instead of
  // silently ignoring it.


  // status_mix and po_value_by_month used to be built here. They moved into
  // PARITY_CHARTS on 16 Sep 2026 for the reason the paragraph above gives:
  // only a spec in that registry can be recomputed under a filter. As inline
  // builders they were the two charts that kept showing unfiltered totals with
  // a "filter NOT applied" warning, on the Overview and inside every focus
  // panel — including the spend-category panel, where the whole point is that
  // the figures describe the category.

  // PR by month moved to PARITY_CHARTS on 22 Sep 2026, when it became the
  // four-series requisition flow. An inline builder here can never be
  // recomputed under a filter, and this chart is on a page whose filter bar is
  // the first thing a reader touches.

  // delivery_ordered_vs_received moved to PARITY_CHARTS on 7 Oct 2026 (filterable).

  // aging bands on open lines
  // aging_bands moved to PARITY_CHARTS on 23 Sep 2026, with the shared six
  // bands. As an inline builder it had its own cut (0-30/31-60/61-90/91-180/
  // 180+) that matched no other aging figure on the page, and could never be
  // recomputed under a filter.


  // top vendors by spend
  {
    const r = await client.query<{
      vendor_code: string | null; vendor_name: string | null; usd: number | null;
      idr: number | null; unrated_idr: number; n: number;
    }>(
      `SELECT vendor_code, max(vendor_name) AS vendor_name, sum(net_order_value_usd) AS usd,
              sum(net_order_value_idr) AS idr,
              count(*) FILTER (WHERE net_order_value IS NOT NULL AND net_order_value_idr IS NULL)::int AS unrated_idr,
              count(*)::int AS n
         FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted AND vendor_code IS NOT NULL
        GROUP BY vendor_code ORDER BY usd DESC NULLS LAST LIMIT 15`,
      [versionId],
    );
    r.rows.forEach((x, i) => {
      const drill = { grain: 'po_line', filters: { vendorCode: x.vendor_code, notSto: true, notDeleted: true } };
      push('top_vendors_spend', 'spend', 'Spend (USD)', x.vendor_code ?? '?',
        x.vendor_name ?? x.vendor_code ?? '?', i + 1, x.usd, x.n, 'usd', drill);
      // IDR display twin — same rows, same drill, strict per-line FX.
      push('top_vendors_spend', 'spend_idr', 'Spend (IDR)', x.vendor_code ?? '?',
        x.vendor_name ?? x.vendor_code ?? '?', i + 1, x.unrated_idr > 0 ? null : x.idr, x.n, 'idr', drill);
    });
  }

  // purchasing group workload
  {
    const r = await client.query<{ g: string | null; n: number }>(
      `SELECT purch_group AS g, count(*)::int AS n FROM core.fact_po_line
        WHERE dataset_version_id = $1 GROUP BY 1 ORDER BY n DESC LIMIT 20`,
      [versionId],
    );
    r.rows.forEach((x, i) =>
      push('purch_group_workload', 'lines', 'PO lines', x.g ?? '?', x.g ?? '(none)', i + 1,
        x.n, x.n, 'count', { grain: 'po_line', filters: { purchGroup: x.g } }),
    );
  }

  // pending_pr_by_pic, wbs_by_plant and movement_mix moved to PARITY_CHARTS on
  // 7 Oct 2026, so they recompute under the global filter.

  await insertMany(client, 'mart.chart_series', CHART_COLS, rows);
  void agingThreshold;
}

export { CHART_META };
