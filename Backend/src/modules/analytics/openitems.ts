/**
 * Open Items — the figures the redesigned page needs that the KPI and chart
 * registries do not already carry.
 *
 * Design spec: "Open Items — page redesign", 16 Sep 2026. The page is built
 * from the existing openitems KPIs and charts wherever it can be; this module
 * exists for the three things that had no source:
 *
 *   1. the OLDEST open age per stage,
 *   2. the emergency / urgent / standard split per stage,
 *   3. the backlog-by-desk table.
 *
 * ── Why the stage counts are computed here too ──────────────────────────────
 *
 * They could have been read from the KPI tiles and the age bands from
 * aging_severity_by_stage, which is what the spec suggests. Computing all four
 * numbers for a stage in ONE pass instead means the count, the bands, the
 * oldest age and the priority split cannot disagree with each other — they are
 * literally the same GROUP BY. A pipeline card whose bands do not add up to its
 * own headline number is worse than one that is a few rows off a tile
 * elsewhere, because the contradiction is visible in a single glance.
 *
 * The status sets below are taken verbatim from the aging_severity_by_stage
 * spec so the two still agree.
 *
 * ── The SLA boundary ────────────────────────────────────────────────────────
 *
 * The stated policy is approval within 3 days. The decision taken for this
 * build (16 Sep 2026) is to keep the dataset's 15-day age boundary as the
 * "past SLA" line and to SAY SO on screen, rather than report a 3-day figure
 * the banded data cannot support. PAST_SLA_DAYS is the one place that choice
 * lives; moving it to 3 is a one-line change here plus the caption.
 */

import { query } from '../../db/client.js';
import { mintScopedQuery, scopeSql, type ScopeEntry } from '../authz/scope.js';
import { buildFilterClause, type GlobalFilter } from './globalfilter.js';

/** The age boundary this page reads "past SLA" at. See the header. */
export const PAST_SLA_DAYS = 15;

/**
 * The five stages, in pipeline order.
 *
 * An open line sits in exactly one of them — the statuses are disjoint, which
 * is what lets the page say "an open line sits in exactly one stage" without
 * qualification.
 */
export const OPEN_STAGES = [
  { key: 'pr_not_approved', name: 'PR not approved', sub: 'Waiting on requisition release', grain: 'pr' as const, status: 'Unapproved PR' },
  { key: 'pr_no_po', name: 'PR approved, no PO', sub: 'Released but no order raised', grain: 'pr' as const, status: 'PR Approved-No PO' },
  { key: 'po_pending_approval', name: 'PO pending approval', sub: 'Order awaiting release', grain: 'po' as const, status: 'PO-Not Approved' },
  { key: 'po_hold', name: 'PO on hold', sub: 'Blocked by buyer or requester', grain: 'po' as const, status: 'HOLD PO' },
  { key: 'po_not_delivered', name: 'PO not delivered', sub: 'Ordered, no goods receipt', grain: 'po' as const, status: 'PO-No GR' },
] as const;

export interface StageRow {
  key: string;
  name: string;
  sub: string;
  count: number;
  /** 0-15, 16-30, 31-90, over 90 — the bands the aging chart already uses. */
  bands: [number, number, number, number];
  /** Lines at or past PAST_SLA_DAYS. bands[1] + bands[2] + bands[3]. */
  pastSla: number;
  oldest: number | null;
  emergency: number;
  urgent: number;
  standard: number;
}

export interface DeskRow {
  desk: string;
  label: string;
  open: number;
  over90: number;
  oldest: number | null;
  bands: [number, number, number, number];
}

export interface OpenItemsSummary {
  asOfDate: string;
  pastSlaDays: number;
  stages: StageRow[];
  desks: DeskRow[];
  totalOpen: number;
  /** Open lines at or past the SLA boundary, across every stage. */
  totalPastSla: number;
}

/**
 * Age bands and priority, expressed once and reused on both grains.
 *
 * `aging_days` and `priority_label` exist on fact_pr_item and fact_po_line
 * alike, so the two halves of the union are the same shape and a stage cannot
 * be banded differently depending on which table it came from.
 */
const BAND_COLS = (a: string) => `
  count(*) FILTER (WHERE ${a}.aging_days <= 15)::int                              AS b0,
  count(*) FILTER (WHERE ${a}.aging_days > 15  AND ${a}.aging_days <= 30)::int    AS b1,
  count(*) FILTER (WHERE ${a}.aging_days > 30  AND ${a}.aging_days <= 90)::int    AS b2,
  count(*) FILTER (WHERE ${a}.aging_days > 90)::int                               AS b3,
  max(${a}.aging_days)::int                                                       AS oldest,
  count(*) FILTER (WHERE ${a}.priority_label = '01-Emergency')::int               AS emergency,
  count(*) FILTER (WHERE ${a}.priority_label = '02-Urgent')::int                  AS urgent,
  count(*) FILTER (WHERE ${a}.priority_label NOT IN ('01-Emergency','02-Urgent')
                      OR ${a}.priority_label IS NULL)::int                        AS standard`;

/**
 * Version, scope AND the page's global filter, for one grain.
 *
 * The filter matters as much as the scope here. The KPI tiles and the charts
 * beside this pipeline are all recomputed under the global filter bar, so a
 * pipeline that ignored it would sit on a filtered page stating unfiltered
 * totals — and the headline sentence, which is built from these numbers, would
 * describe a backlog the rest of the page is not showing.
 *
 * A filter the grain cannot express throws, and the caller turns that into an
 * empty result rather than a wrong one.
 */
function scoped(
  versionId: number,
  scope: readonly ScopeEntry[],
  alias: string,
  filter: GlobalFilter,
  kind: 'pr_item' | 'po_line',
  params: unknown[] = [versionId],
): { where: string; params: unknown[] } {
  const s = scopeSql(mintScopedQuery('openitems', scope), alias, params);
  const f = buildFilterClause(filter, kind, alias, params.length + 1);
  params.push(...f.params);
  return { where: `${alias}.dataset_version_id = $1 AND ${s}${f.sql}`, params };
}

export async function openItemsSummary(
  versionId: number,
  asOfDate: string,
  scope: readonly ScopeEntry[],
  filter: GlobalFilter,
): Promise<OpenItemsSummary> {
  const pr = scoped(versionId, scope, 'pri', filter, 'pr_item');
  const po = scoped(versionId, scope, 'pol', filter, 'po_line');

  // ── stages ───────────────────────────────────────────────────────────
  const prStages = await query<Record<string, number | string>>(
    `SELECT pri.status AS k, count(*)::int AS n, ${BAND_COLS('pri')}
       FROM core.fact_pr_item pri
      WHERE ${pr.where} AND NOT pri.is_deleted
        AND pri.status IN ('Unapproved PR','PR Approved-No PO')
      GROUP BY 1`,
    pr.params,
  );
  const poStages = await query<Record<string, number | string>>(
    `SELECT pol.status AS k, count(*)::int AS n, ${BAND_COLS('pol')}
       FROM core.fact_po_line pol
      WHERE ${po.where} AND NOT pol.is_sto AND NOT pol.is_deleted
        AND pol.status IN ('PO-Not Approved','HOLD PO','PO-No GR')
      GROUP BY 1`,
    po.params,
  );
  const byStatus = new Map<string, Record<string, number | string>>();
  for (const r of [...prStages, ...poStages]) byStatus.set(String(r['k']), r);

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
      // A stage with no rows has no oldest age — null, not 0, so the page can
      // print a dash rather than claim something is 0 days old.
      oldest: r && r['oldest'] !== null && r['oldest'] !== undefined ? Number(r['oldest']) : null,
      emergency: n('emergency'),
      urgent: n('urgent'),
      standard: n('standard'),
    };
  });

  // ── desks ────────────────────────────────────────────────────────────
  //
  // Purchasing group, decided 16 Sep 2026 over buyer name: it is on both
  // facts, dim_purch_group gives it a description, and it carries no personal
  // data — the PR/PO facts mark created_by and requisitioner as restricted.
  //
  // Both grains union into one desk, because a desk's open work is its
  // unreleased requisitions AND its undelivered orders; splitting them would
  // answer a question nobody asked.
  // One params array, two scope clauses appended to it in turn, so the second
  // grain's placeholders are numbered from where the first stopped. Renumbering
  // a pre-built clause by string substitution does not work here: a scope can
  // contribute several parameters, so only $1 would have been corrected and
  // $2 onward would have silently addressed the wrong value.
  const deskParams: unknown[] = [versionId];
  const deskPr = scoped(versionId, scope, 'pri', filter, 'pr_item', deskParams).where;
  const deskPo = scoped(versionId, scope, 'pol', filter, 'po_line', deskParams).where;

  const desks = await query<Record<string, number | string | null>>(
    `WITH o AS (
       SELECT pri.purch_group AS g, pri.aging_days AS age, pri.priority_label AS prio
         FROM core.fact_pr_item pri
        WHERE ${deskPr} AND NOT pri.is_deleted
          AND pri.status IN ('Unapproved PR','PR Approved-No PO')
       UNION ALL
       SELECT pol.purch_group, pol.aging_days, pol.priority_label
         FROM core.fact_po_line pol
        WHERE ${deskPo} AND NOT pol.is_sto AND NOT pol.is_deleted
          AND pol.status IN ('PO-Not Approved','HOLD PO','PO-No GR')
     )
     SELECT COALESCE(NULLIF(o.g, ''), '(none)') AS desk,
            COALESCE(NULLIF(d.description, ''), NULLIF(o.g, ''), '(no purchasing group)') AS label,
            count(*)::int AS open,
            count(*) FILTER (WHERE o.age > 90)::int AS over90,
            max(o.age)::int AS oldest,
            count(*) FILTER (WHERE o.age <= 15)::int AS b0,
            count(*) FILTER (WHERE o.age > 15 AND o.age <= 30)::int AS b1,
            count(*) FILTER (WHERE o.age > 30 AND o.age <= 90)::int AS b2,
            count(*) FILTER (WHERE o.age > 90)::int AS b3
       FROM o
       LEFT JOIN core.dim_purch_group d ON d.code = o.g
      GROUP BY 1, 2
      ORDER BY over90 DESC, open DESC`,
    deskParams,
  );

  return {
    asOfDate,
    pastSlaDays: PAST_SLA_DAYS,
    stages,
    desks: desks.map((r) => ({
      desk: String(r['desk']),
      label: String(r['label']),
      open: Number(r['open']),
      over90: Number(r['over90']),
      oldest: r['oldest'] === null ? null : Number(r['oldest']),
      bands: [Number(r['b0']), Number(r['b1']), Number(r['b2']), Number(r['b3'])],
    })),
    totalOpen: stages.reduce((a, s) => a + s.count, 0),
    totalPastSla: stages.reduce((a, s) => a + s.pastSla, 0),
  };
}
