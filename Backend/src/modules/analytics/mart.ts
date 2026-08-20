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
  expediteEffectiveness, mean, median, percentile, shareOverThreshold, sizeBandLabel,
} from '@pct/rules';
import type { KpiId } from '@pct/contracts';
import { insertMany } from '../../db/client.js';
import { CHART_META } from './charts.js';
import { wbsLabel, type RuleSnapshot } from '../admin/rules.js';
import { buildParityMart } from './mart_parity.js';

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
    const rows = await q<{ req_lead: number | null; material_group: string | null }>(
      `SELECT (need_by_date - requisition_date) AS req_lead, material_group
         FROM core.fact_pr_item
        WHERE dataset_version_id = $1 AND need_by_date IS NOT NULL AND requisition_date IS NOT NULL
          AND NOT is_deleted`,
      [versionId],
    );
    const actual = await q<{ material_group: string | null; lead: number | null }>(
      `SELECT pri.material_group, (pol.receipt_date - pri.requisition_date) AS lead
         FROM core.fact_po_line pol
         JOIN core.fact_pr_item pri
           ON pri.dataset_version_id = pol.dataset_version_id
          AND pri.pr_no = pol.pr_no AND pri.pr_item = pol.pr_item
        WHERE pol.dataset_version_id = $1 AND pol.receipt_date IS NOT NULL`,
      [versionId],
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
            drillPredicate: { grain: 'pr_item', filters: { demandUnrealistic: true } },
          },
    );
  }

  // ─────────────────────────── On-Time vs Requested (blocked by D4 / V-M01)
  //
  // v1's v3x-otdr: receipt on or before the REQUESTED date (EBAN-LFDAT), not
  // the PO promise date. Same gate as Demand Realism — the pathway is fully
  // built and lights up on the first ingest whose PR export carries a genuine
  // need-by column, with no code change.

  if (disabledKpis.has('otd_vs_requested')) {
    kpis.push({
      kpiId: 'otd_vs_requested',
      status: 'disabled',
      value: null,
      numerator: null,
      denominator: null,
      sampleSize: null,
      unit: 'percent',
      currencyBasis: null,
      severity: null,
      statusReason:
        'Requested delivery date not present in this export (V-M01). On-time is measurable only against the PO promise date (see vendor OTD). Fix: add SAP EBAN-LFDAT to the ME5A variant. See PRD 13.1.1.',
      detail: null,
      drillPredicate: null,
    });
  } else {
    const [row] = await q<{ ok: number; tot: number }>(
      `SELECT count(*) FILTER (WHERE receipt_date <= need_by_date)::int AS ok,
              count(*)::int AS tot
         FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND NOT is_deleted AND NOT is_sto
          AND receipt_date IS NOT NULL AND need_by_date IS NOT NULL`,
      [versionId],
    );
    const tot = row?.tot ?? 0;
    kpis.push(
      tot < minSample
        ? nullKpi('otd_vs_requested', 'percent', `Fewer than ${minSample} lines carry both a receipt and a requested date.`, tot)
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
            drillPredicate: {
              grain: 'po_line',
              filters: { notDeleted: true, notSto: true, otdrEvaluable: true },
            },
          },
    );
  }

  // ───────────────────────────────────────────── Expedite Effectiveness

  {
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
          AND pri.requisition_date IS NOT NULL AND pol.document_date IS NOT NULL`,
      [versionId],
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
            drillPredicate: { grain: 'pr_item', filters: { urgencyIn: [1, 2] } },
          }
        : nullKpi('expedite_effectiveness', 'ratio', 'Not enough matched requisitions in each arm.', e.urgentSample + e.standardSample),
    );
  }

  // ───────────────────────────────── GR/IR and open commitment > threshold

  {
    const rows = await q<{ val: number | null; usd: number | null; aging: number | null; ccy: string }>(
      `SELECT still_invoice_val AS val, still_invoice_val_usd AS usd, aging_days AS aging, currency_code AS ccy
         FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
          AND COALESCE(still_deliver_qty, 0) = 0 AND COALESCE(still_invoice_val, 0) > 0`,
      [versionId],
    );
    kpis.push(shareKpi('grir_over_60d', rows, agingThreshold, 'warning'));
  }

  {
    const rows = await q<{ val: number | null; usd: number | null; aging: number | null; ccy: string }>(
      `SELECT still_deliver_val AS val, still_deliver_val_usd AS usd, aging_days AS aging, currency_code AS ccy
         FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
          AND COALESCE(still_deliver_val, 0) > 0`,
      [versionId],
    );
    kpis.push(shareKpi('commitment_over_60d', rows, agingThreshold, 'warning'));
  }

  // ──────────────────────────────────────────────────── WBS compliance

  {
    const rows = await q<{ violations: number; prs: number; over: number; indet: number; value: number | null }>(
      `SELECT count(*) FILTER (WHERE wbs_status = 'violation')::int AS violations,
              count(DISTINCT pr_no) FILTER (WHERE wbs_status = 'violation')::int AS prs,
              count(*) FILTER (WHERE wbs_status IN ('violation','compliant'))::int AS over,
              count(*) FILTER (WHERE wbs_status = 'indeterminate')::int AS indet,
              COALESCE(sum(total_value_idr) FILTER (WHERE wbs_status = 'violation'), 0) AS value
         FROM core.fact_pr_item
        WHERE dataset_version_id = $1`,
      [versionId],
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
      drillPredicate: { grain: 'pr_item', filters: { wbsStatus: 'violation' } },
    });
  }

  // ──────────────────────────────────────────────────── cycle-time KPIs

  // Every cycle card drills to its own evaluable lines (user ask 5 Aug 2026);
  // the filters reproduce the exact >= 0 population the values come from.
  const cycles: Array<[KpiId, string, string, Record<string, unknown>]> = [
    ['cycle_pr_approval', 'release_final_date - requisition_date', 'pr',
      { grain: 'pr_item', filters: { released: true } }],
    ['cycle_sourcing', 'sourcing_days', 'po',
      { grain: 'po_line', filters: { measureNonNeg: 'sourcing' } }],
    ['cycle_po_approval', 'po_approval_days', 'po',
      { grain: 'po_line', filters: { measureNonNeg: 'po_approval' } }],
    ['cycle_delivery', 'delivery_days', 'po',
      { grain: 'po_line', filters: { measureNonNeg: 'delivery' } }],
  ];
  for (const [kpiId, expr, src, drill] of cycles) {
    const table = src === 'pr' ? 'core.fact_pr_item' : 'core.fact_po_line';
    const rows = await q<{ d: number | null }>(
      `SELECT (${expr}) AS d FROM ${table} WHERE dataset_version_id = $1 AND (${expr}) IS NOT NULL`,
      [versionId],
    );
    const vals = rows.map((x) => x.d!).filter((d) => d !== null && d >= 0);
    // Average headline (decision 3 Aug 2026, v1 parity); median in the subtitle.
    kpis.push(cycleKpi(kpiId, vals, minSample, disabledKpis, 'avg', drill));
  }

  {
    const rows = await q<{ d: number | null }>(
      `SELECT (pol.receipt_date - pri.requisition_date) AS d
         FROM core.fact_po_line pol
         JOIN core.fact_pr_item pri
           ON pri.dataset_version_id = pol.dataset_version_id
          AND pri.pr_no = pol.pr_no AND pri.pr_item = pol.pr_item
        WHERE pol.dataset_version_id = $1 AND pol.receipt_date IS NOT NULL`,
      [versionId],
    );
    kpis.push(cycleKpi('cycle_e2e', rows.map((x) => x.d!).filter((d) => d !== null && d >= 0),
      minSample, disabledKpis, 'median',
      { grain: 'po_line', filters: { e2eEvaluable: true } }));
  }

  // ─────────────────────────────────────────────── operational counts

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
       FROM core.fact_po_line WHERE dataset_version_id = $1`,
    [versionId],
  );
  const c = counts[0]!;

  kpis.push(simpleCount('sto_share', (c.sto_lines / Math.max(c.po_lines, 1)) * 100, 'percent', c.po_lines,
    { stoLines: c.sto_lines, totalLines: c.po_lines }, { grain: 'po_line', filters: { isSto: true } }));

  kpis.push(simpleCount('direct_po_share', (c.direct_po / Math.max(c.po_lines, 1)) * 100, 'percent', c.po_lines,
    { directLines: c.direct_po, danglingLines: c.dangling, totalLines: c.po_lines },
    { grain: 'po_line', filters: { directPo: true } }));

  kpis.push(simpleCount('retro_po_rate', c.retro, 'count', c.po_lines, { retroLines: c.retro },
    { grain: 'po_line', filters: { isRetroPo: true } }));

  kpis.push(simpleCount('open_items', c.open_items, 'count', c.po_lines,
    {
      chip_emergency: c.open_emg, chip_urgent: c.open_urg,
      chip_standard: c.open_items - c.open_emg - c.open_urg,
    },
    { grain: 'po_line', filters: { statusIn: ['PO-Not Approved', 'HOLD PO', 'PO-No GR', 'Partially Delivered'] } }));

  const split = await q<{ items: number; maxlines: number }>(
    `SELECT count(DISTINCT (pr_no, pr_item)) FILTER (WHERE split_total > 1)::int AS items,
            COALESCE(max(split_total), 0)::int AS maxlines
       FROM core.bridge_pr_po WHERE dataset_version_id = $1`,
    [versionId],
  );
  kpis.push(simpleCount('split_sourcing', split[0]!.items, 'count', null,
    { maxPoLinesPerPrItem: split[0]!.maxlines, entityUnit: 'PR items' }, { grain: 'po_line', filters: { splitSourced: true } }));

  const rev = await q<{ receipts: number; reversals: number }>(
    `SELECT count(*) FILTER (WHERE movement_type = '101')::int AS receipts,
            count(*) FILTER (WHERE posting_class = 'reversal')::int AS reversals
       FROM core.fact_gr_posting WHERE dataset_version_id = $1`,
    [versionId],
  );
  const rv = rev[0]!;
  kpis.push(simpleCount('reversal_rate', rv.receipts > 0 ? (rv.reversals / rv.receipts) * 100 : 0, 'percent',
    rv.receipts, { receipts: rv.receipts, reversals: rv.reversals },
    { grain: 'gr_posting', filters: { postingClass: 'reversal' } }));

  const pendPr = await q<{ n: number }>(
    `SELECT count(DISTINCT (pr_no, pr_item))::int AS n FROM core.fact_pr_release
      WHERE dataset_version_id = $1 AND approve_date IS NULL`,
    [versionId],
  );
  kpis.push(simpleCount('pending_pr_approvals', pendPr[0]!.n, 'count', null, { entityUnit: 'PR items' },
    { grain: 'pr_release', filters: { pending: true } }));

  // Release-exempt POs are excluded: they have no release record and can never be
  // approved, so leaving them in the queue would strand them permanently.
  const pendPo = await q<{ n: number }>(
    `SELECT count(DISTINCT po_no)::int AS n FROM core.fact_po_line
      WHERE dataset_version_id = $1 AND po_release_state = 'pending'`,
    [versionId],
  );
  kpis.push(simpleCount('pending_po_approvals', pendPo[0]!.n, 'count', null,
    { releaseExemptExcluded: c.exempt, entityUnit: 'POs' },
    { grain: 'po_line', filters: { poReleaseState: 'pending' } }));

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

// ────────────────────────────────────────────────────────────────── helpers

function nullKpi(kpiId: KpiId, unit: KpiRow['unit'], reason: string, sample: number | null): KpiRow {
  return {
    kpiId, status: 'insufficient_sample', value: null, numerator: null, denominator: null,
    sampleSize: sample, unit, currencyBasis: null, severity: null, statusReason: reason,
    detail: null, drillPredicate: null,
  };
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

  // ── Executive Summary: committed value by spend category (020) ──
  // Purchase lines only: STO is an internal transfer and deleted lines are not
  // commitments, so including either would overstate the value the page leads
  // with. The drill predicate carries the same two flags, which is what lets the
  // parity sweep confirm the figure and its detail agree.
  {
    const r = await client.query<{ cat: string; v: string; n: number }>(
      `SELECT spend_category AS cat, sum(net_order_value_idr)::text AS v, count(*)::int AS n
         FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
          AND spend_category IS NOT NULL
        GROUP BY 1 ORDER BY sum(net_order_value_idr) DESC NULLS LAST`,
      [versionId],
    );
    r.rows.forEach((x, i) =>
      push('exec_value_by_category', 'value', 'Committed value', x.cat, x.cat, i + 1,
        Number(x.v), x.n, 'idr',
        { grain: 'po_line', filters: { spendCategory: x.cat, notSto: true, notDeleted: true } }),
    );
  }

  // ── Executive Summary: transaction size, value against volume (020) ──
  // Two series on ONE band axis, ordered by band key so the bands can never be
  // drawn out of sequence. Percentages are computed here rather than in the
  // page: the denominator is the banded population (lines with an IDR value),
  // and computing it client-side from whatever points arrived would silently
  // change the denominator if a band were ever empty.
  {
    const r = await client.query<{ band: string; v: string; n: number }>(
      `SELECT size_band AS band, sum(net_order_value_idr)::text AS v, count(*)::int AS n
         FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
          AND size_band IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
      [versionId],
    );
    const totalV = r.rows.reduce((a, x) => a + Number(x.v), 0);
    const totalN = r.rows.reduce((a, x) => a + x.n, 0);
    r.rows.forEach((x, i) => {
      const label = sizeBandLabel(x.band) ?? x.band;
      const pred = { grain: 'po_line', filters: { sizeBand: x.band, notSto: true, notDeleted: true } };
      // count on BOTH series is the line count, because that is what a drill
      // from either bar returns — the sweep compares the drill's row count, not
      // the plotted percentage.
      push('exec_txn_size', 'value_share', '% of committed value', x.band, label, i + 1,
        totalV > 0 ? (Number(x.v) / totalV) * 100 : 0, x.n, 'percent', pred);
      push('exec_txn_size', 'line_share', '% of PO lines', x.band, label, i + 1,
        totalN > 0 ? (x.n / totalN) * 100 : 0, x.n, 'percent', pred);
    });
  }

  // status mix
  {
    const r = await client.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM core.fact_po_line
        WHERE dataset_version_id = $1 GROUP BY status ORDER BY n DESC`,
      [versionId],
    );
    r.rows.forEach((x, i) =>
      push('status_mix', 'lines', 'PO lines', x.status, x.status, i + 1, x.n, x.n, 'count',
        { grain: 'po_line', filters: { status: x.status } }),
    );
  }

  // PR by month
  {
    const r = await client.query<{ mk: string; n: number }>(
      `SELECT to_char(requisition_date, 'YYYY-MM') AS mk, count(*)::int AS n
         FROM core.fact_pr_item
        WHERE dataset_version_id = $1 AND requisition_date IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
      [versionId],
    );
    r.rows.forEach((x, i) =>
      push('pr_by_month', 'items', 'PR items', x.mk, monthLabel(x.mk), i + 1, x.n, x.n, 'count',
        { grain: 'pr_item', filters: { monthKey: x.mk } }),
    );
  }

  // PO value by month (STO excluded from spend)
  {
    const r = await client.query<{ mk: string; usd: number | null; idr: number | null; unrated_idr: number; n: number }>(
      `SELECT to_char(document_date, 'YYYY-MM') AS mk,
              sum(net_order_value_usd) AS usd,
              sum(net_order_value_idr) AS idr,
              count(*) FILTER (WHERE net_order_value IS NOT NULL AND net_order_value_idr IS NULL)::int AS unrated_idr,
              count(*)::int AS n
         FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted
        GROUP BY 1 ORDER BY 1`,
      [versionId],
    );
    r.rows.forEach((x, i) => {
      // Must mirror the aggregate's WHERE exactly, or the drill over-counts.
      const drill = { grain: 'po_line', filters: { monthKey: x.mk, notSto: true, notDeleted: true } };
      push('po_value_by_month', 'value', 'Net order value (USD)', x.mk, monthLabel(x.mk), i + 1,
        x.usd, x.n, 'usd', drill);
      // IDR display twin — same rows, same drill, strict per-line FX.
      push('po_value_by_month', 'value_idr', 'Net order value (IDR)', x.mk, monthLabel(x.mk), i + 1,
        x.unrated_idr > 0 ? null : x.idr, x.n, 'idr', drill);
    });
  }

  // ordered vs received by PO month (STO included in delivery)
  {
    const r = await client.query<{ mk: string; ordered: number; received: number }>(
      `SELECT to_char(document_date, 'YYYY-MM') AS mk,
              count(*)::int AS ordered,
              count(*) FILTER (WHERE receipt_date IS NOT NULL)::int AS received
         FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND NOT is_deleted
        GROUP BY 1 ORDER BY 1`,
      [versionId],
    );
    r.rows.forEach((x, i) => {
      push('delivery_ordered_vs_received', 'ordered', 'PO lines', x.mk, monthLabel(x.mk), i + 1,
        x.ordered, x.ordered, 'count',
        { grain: 'po_line', filters: { monthKey: x.mk, notDeleted: true } });
      push('delivery_ordered_vs_received', 'received', 'Lines with GR', x.mk, monthLabel(x.mk), i + 1,
        x.received, x.received, 'count',
        { grain: 'po_line', filters: { monthKey: x.mk, hasReceipt: true, notDeleted: true } });
    });
  }

  // aging bands on open lines
  {
    const r = await client.query<{ band: string; n: number }>(
      `SELECT CASE WHEN aging_days <= 30 THEN '0-30'
                   WHEN aging_days <= 60 THEN '31-60'
                   WHEN aging_days <= 90 THEN '61-90'
                   WHEN aging_days <= 180 THEN '91-180'
                   ELSE '180+' END AS band,
              count(*)::int AS n
         FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND aging_days IS NOT NULL
          AND status IN ('PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered')
        GROUP BY 1`,
      [versionId],
    );
    const order = ['0-30', '31-60', '61-90', '91-180', '180+'];
    const byBand = new Map(r.rows.map((x) => [x.band, x.n]));
    order.forEach((band, i) =>
      push('aging_bands', 'lines', 'Open PO lines', band, `${band} days`, i + 1,
        byBand.get(band) ?? 0, byBand.get(band) ?? 0, 'count',
        { grain: 'po_line', filters: { agingBand: band, open: true } }),
    );
  }

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

  // pending PR approvals by PIC
  {
    const r = await client.query<{ pic: string | null; n: number }>(
      `SELECT pic_release AS pic, count(*)::int AS n FROM core.fact_pr_release
        WHERE dataset_version_id = $1 AND approve_date IS NULL
        GROUP BY 1 ORDER BY n DESC LIMIT 20`,
      [versionId],
    );
    r.rows.forEach((x, i) =>
      push('pending_pr_by_pic', 'pending', 'Pending', x.pic ?? '?', x.pic ?? '(unknown)', i + 1,
        x.n, x.n, 'count', { grain: 'pr_release', filters: { picRelease: x.pic, pending: true } }),
    );
  }

  // WBS violations by plant
  {
    const r = await client.query<{ plant: string; n: number }>(
      `SELECT plant, count(*)::int AS n FROM core.fact_pr_item
        WHERE dataset_version_id = $1 AND wbs_status = 'violation'
        GROUP BY 1 ORDER BY n DESC LIMIT 20`,
      [versionId],
    );
    r.rows.forEach((x, i) =>
      push('wbs_by_plant', 'violations', 'Violations', x.plant, x.plant, i + 1, x.n, x.n, 'count',
        { grain: 'pr_item', filters: { wbsStatus: 'violation', plant: x.plant } }),
    );
  }

  // movement type mix
  {
    const r = await client.query<{ mt: string; cls: string; n: number }>(
      `SELECT movement_type AS mt, posting_class AS cls, count(*)::int AS n
         FROM core.fact_gr_posting WHERE dataset_version_id = $1
        GROUP BY 1,2 ORDER BY n DESC`,
      [versionId],
    );
    r.rows.forEach((x, i) =>
      push('movement_mix', 'postings', 'Postings', x.mt, `${x.mt} (${x.cls})`, i + 1, x.n, x.n, 'count',
        { grain: 'gr_posting', filters: { movementType: x.mt } }),
    );
  }

  await insertMany(client, 'mart.chart_series', CHART_COLS, rows);
  void agingThreshold;
}

function monthLabel(mk: string): string {
  const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m] = mk.split('-');
  return `${names[Number(m)] ?? m} ${y}`;
}

export { CHART_META };
