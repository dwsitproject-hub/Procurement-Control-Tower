/**
 * Open Items — the stage pipeline and the desk table.
 *
 * Design spec: "Open Items — page redesign", 16 Sep 2026.
 *
 * ── Counted over core.v_detail, on purpose ──────────────────────────────────
 *
 * The first version of this module counted core.fact_pr_item and
 * core.fact_po_line. It was rewritten on 17 Sep 2026, when every figure on a
 * card became clickable and so had to open the rows behind it: the table those
 * clicks filter is v_detail, and the facts are NOT the same population.
 *
 *   v_detail is PR x PO grain — one requisition with two order lines is two
 *   rows — while fact_po_line is one row per order line;
 *
 *   its `status` is COALESCE(pol.status, pri.status), which is exactly "the
 *   stage this line is in", and the whole pipeline is built on that idea;
 *
 *   its `p_cat` is the REQUISITION's priority, and is null for an order that
 *   never had a requisition.
 *
 * Counting the facts while filtering the view disagreed by 156 rows on "PO not
 * delivered" and by 2,513 on the largest desk: small enough to look like
 * rounding, large enough to make a reader stop trusting the page. The cards now
 * count the rows the table shows, so a click returns the number that was
 * clicked by construction rather than by coincidence.
 *
 * Two consequences worth stating. STO lines are INCLUDED, because the detail
 * table includes them by default and its "Exclude STO" toggle belongs to the
 * reader. Deleted requisitions are excluded, because the table excludes them by
 * default.
 *
 * ── The SLA boundary ────────────────────────────────────────────────────────
 *
 * Policy is approval within 3 days; the dataset's smallest age band is 15 days.
 * The decision taken for this build is to read "past SLA" at 15 days and SAY SO
 * on screen, rather than print a 3-day figure the banded data cannot support.
 * PAST_SLA_DAYS is the one place that choice lives.
 */

import { query } from '../../db/client.js';
import { mintScopedQuery, scopeSql, type ScopeEntry } from '../authz/scope.js';
import { buildFilterClause, type GlobalFilter } from './globalfilter.js';

/** The age boundary this page reads "past SLA" at. See the header. */
export const PAST_SLA_DAYS = 15;

/**
 * The five stages, in pipeline order.
 *
 * An open line sits in exactly one of them: v_detail.status holds one value per
 * row, so the statuses are disjoint by construction and the page can say so
 * without qualification.
 */
export const OPEN_STAGES = [
  { key: 'pr_not_approved', name: 'PR not approved', sub: 'Waiting on requisition release', status: 'Unapproved PR' },
  { key: 'pr_no_po', name: 'PR approved, no PO', sub: 'Released but no order raised', status: 'PR Approved-No PO' },
  { key: 'po_pending_approval', name: 'PO pending approval', sub: 'Order awaiting release', status: 'PO-Not Approved' },
  { key: 'po_hold', name: 'PO on hold', sub: 'Blocked by buyer or requester', status: 'HOLD PO' },
  { key: 'po_not_delivered', name: 'PO not delivered', sub: 'Ordered, no goods receipt', status: 'PO-No GR' },
] as const;

/** Every stage status, for the filter that reproduces the whole pipeline. */
const ALL_STAGE_STATUSES = OPEN_STAGES.map((s) => s.status).join(',');

/** The priority values a click on the `standard` figure filters by. */
const STANDARD_LABELS = ['03-Standard', '04-Planned'];

export interface StageRow {
  key: string;
  name: string;
  sub: string;
  count: number;
  /** 0-15, 16-30, 31-90, over 90 — the bands the aging chart already uses. */
  bands: [number, number, number, number];
  /** Lines past PAST_SLA_DAYS. bands[1] + bands[2] + bands[3]. */
  pastSla: number;
  oldest: number | null;
  emergency: number;
  urgent: number;
  standard: number;
  /**
   * Rows whose requisition priority is absent — an order with no requisition.
   *
   * Counted and named so the four buckets sum to the stage's count, but the
   * page does not make it clickable: the detail filter matches values and
   * cannot ask for null, so the click would open a table that came back short.
   * Better a figure that does nothing than one that quietly disagrees.
   */
  prioUnset: number;
  standardLabels: string[];
  /** The detail filter that reproduces THIS card's population. */
  detailFilter: Record<string, string>;
}

export interface DeskRow {
  desk: string;
  label: string;
  open: number;
  over90: number;
  oldest: number | null;
  bands: [number, number, number, number];
  detailFilter: Record<string, string>;
}

export interface OpenItemsSummary {
  asOfDate: string;
  pastSlaDays: number;
  stages: StageRow[];
  desks: DeskRow[];
  totalOpen: number;
  totalPastSla: number;
  /** The filter for "every open line this page counts". */
  detailFilter: Record<string, string>;
}

/**
 * The shared measures, written once.
 *
 * The stage query and the desk query group the same population by a different
 * key, so the measures must not be allowed to differ between them — the desk
 * totals have to add up to the pipeline totals.
 */
const MEASURES = `
  count(*)::int                                                           AS n,
  count(*) FILTER (WHERE d.age_days <= 15)::int                           AS b0,
  count(*) FILTER (WHERE d.age_days > 15  AND d.age_days <= 30)::int      AS b1,
  count(*) FILTER (WHERE d.age_days > 30  AND d.age_days <= 90)::int      AS b2,
  count(*) FILTER (WHERE d.age_days > 90)::int                            AS b3,
  max(d.age_days)::int                                                    AS oldest,
  count(*) FILTER (WHERE d.p_cat = '01-Emergency')::int                   AS emergency,
  count(*) FILTER (WHERE d.p_cat = '02-Urgent')::int                      AS urgent,
  count(*) FILTER (WHERE d.p_cat IN ('03-Standard','04-Planned'))::int    AS standard,
  count(*) FILTER (WHERE d.p_cat IS NULL
                      OR d.p_cat NOT IN ('01-Emergency','02-Urgent',
                                         '03-Standard','04-Planned'))::int AS prio_unset`;

/**
 * Version, scope, the page's global filter, and the page's own definition of
 * "open" — all on core.v_detail.
 *
 * The filter matters as much as the scope: the KPI tiles and the charts beside
 * this pipeline are recomputed under the global filter bar, so a pipeline that
 * ignored it would state unfiltered totals on a filtered page, and the headline
 * sentence built from these numbers would describe a backlog nobody is looking
 * at.
 */
function buildWhere(
  versionId: number,
  scope: readonly ScopeEntry[],
  filter: GlobalFilter,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [versionId];
  const s = scopeSql(mintScopedQuery('openitems', scope), 'd', params);
  // v_detail carries both grains in one row set, so the PO-line dimensions are
  // the ones to filter on.
  const f = buildFilterClause(filter, 'po_line', 'd', params.length + 1);
  params.push(...f.params);
  params.push(OPEN_STAGES.map((x) => x.status));
  return {
    sql: `d.dataset_version_id = $1 AND ${s}${f.sql}
          AND NOT d.pr_deleted
          AND d.status = ANY($${params.length})`,
    params,
  };
}

export async function openItemsSummary(
  versionId: number,
  asOfDate: string,
  scope: readonly ScopeEntry[],
  filter: GlobalFilter,
): Promise<OpenItemsSummary> {
  const w = buildWhere(versionId, scope, filter);

  const rows = await query<Record<string, unknown>>(
    `SELECT d.status AS k, ${MEASURES}
       FROM core.v_detail d WHERE ${w.sql} GROUP BY 1`,
    w.params,
  );
  const byStatus = new Map(rows.map((r) => [String(r['k']), r]));

  const stages: StageRow[] = OPEN_STAGES.map((s) => {
    const r = byStatus.get(s.status);
    const n = (k: string): number => Number(r?.[k] ?? 0);
    const bands: [number, number, number, number] = [n('b0'), n('b1'), n('b2'), n('b3')];
    return {
      key: s.key,
      name: s.name,
      sub: s.sub,
      count: n('n'),
      bands,
      // Everything outside the first band. The band boundary IS the SLA line
      // this page reads at, so the two can never drift apart.
      pastSla: bands[1] + bands[2] + bands[3],
      // Null, not 0, for an empty stage: the page prints a dash rather than
      // claiming something is 0 days old.
      oldest: r && r['oldest'] !== null && r['oldest'] !== undefined ? Number(r['oldest']) : null,
      emergency: n('emergency'),
      urgent: n('urgent'),
      standard: n('standard'),
      prioUnset: n('prio_unset'),
      standardLabels: STANDARD_LABELS,
      detailFilter: { status: s.status },
    };
  });

  // ── desks ────────────────────────────────────────────────────────────
  //
  // Purchasing group, decided 16 Sep 2026 over buyer name: it is on the view,
  // dim_purch_group gives it a description, and it carries no personal data —
  // the facts mark created_by and requisitioner as restricted.
  const dw = buildWhere(versionId, scope, filter);
  const desks = await query<Record<string, unknown>>(
    `SELECT COALESCE(NULLIF(d.purch_group, ''), '(none)') AS desk,
            COALESCE(NULLIF(g.description, ''), NULLIF(d.purch_group, ''),
                     '(no purchasing group)') AS label,
            ${MEASURES}
       FROM core.v_detail d
       LEFT JOIN core.dim_purch_group g ON g.code = d.purch_group
      WHERE ${dw.sql}
      GROUP BY 1, 2
      ORDER BY b3 DESC, n DESC`,
    dw.params,
  );

  return {
    asOfDate,
    pastSlaDays: PAST_SLA_DAYS,
    stages,
    desks: desks.map((r) => ({
      desk: String(r['desk']),
      label: String(r['label']),
      open: Number(r['n']),
      over90: Number(r['b3']),
      oldest: r['oldest'] === null ? null : Number(r['oldest']),
      bands: [Number(r['b0']), Number(r['b1']), Number(r['b2']), Number(r['b3'])],
      // '(none)' is a display label, not a value the filter can match, so a
      // desk with no purchasing group is reported and left unclickable.
      detailFilter: (r['desk'] === '(none)'
        ? {}
        : { status: ALL_STAGE_STATUSES, purchGroup: String(r['desk']) }) as Record<string, string>,
    })),
    totalOpen: stages.reduce((a, s) => a + s.count, 0),
    totalPastSla: stages.reduce((a, s) => a + s.pastSla, 0),
    detailFilter: { status: ALL_STAGE_STATUSES },
  };
}
