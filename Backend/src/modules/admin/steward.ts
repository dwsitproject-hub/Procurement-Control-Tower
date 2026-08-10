/**
 * Steward tooling — W6. v1's cfg-modal (data exclusions), cv-modal (column
 * remapping) and fx-modal (rate table).
 *
 * Exclusion semantics follow v1: an excluded document type or purchasing group
 * is removed from EVERY view. That is implemented at transform time — excluded
 * rows are simply not loaded into the fact tables (staging keeps them for
 * lineage), so every KPI, chart, drill and detail row agrees by construction.
 * Changing exclusions therefore requires a recompute (re-ingest), which the UI
 * says explicitly rather than pretending the change is instant.
 */

import { query, queryOne, exec } from '../../db/client.js';
import { CONTRACT_BY_FEED, TEMPLATE_CONTRACTS } from '../ingest/contracts.js';
import type { Feed } from '@pct/contracts';

// ─────────────────────────────────────────────────────────────── exclusions

export interface Exclusions {
  docTypes: string[];
  purchGroups: string[];
  purchOrgs: string[];
}

export const EXCLUSION_KEYS = ['exclusions.doc_types', 'exclusions.purch_groups', 'exclusions.purch_orgs'] as const;

export async function loadExclusions(): Promise<Exclusions> {
  const rows = await query<{ rule_key: string; rule_value: unknown }>(
    `SELECT DISTINCT ON (rule_key) rule_key, rule_value
       FROM app.rule_config
      WHERE rule_key = ANY($1) AND effective_from <= CURRENT_DATE
      ORDER BY rule_key, effective_from DESC`,
    [[...EXCLUSION_KEYS]],
  );
  const get = (k: string): string[] => {
    const v = rows.find((r) => r.rule_key === k)?.rule_value;
    return Array.isArray(v) ? v.map(String) : [];
  };
  return {
    docTypes: get('exclusions.doc_types'),
    purchGroups: get('exclusions.purch_groups'),
    purchOrgs: get('exclusions.purch_orgs'),
  };
}

export async function saveExclusions(e: Exclusions, userId: string | null): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  for (const [key, value] of [
    ['exclusions.doc_types', e.docTypes],
    ['exclusions.purch_groups', e.purchGroups],
    ['exclusions.purch_orgs', e.purchOrgs],
  ] as const) {
    await exec(
      `INSERT INTO app.rule_config (rule_key, rule_value, effective_from, note, created_by)
       VALUES ($1, $2::jsonb, $3::date, 'exclusion config', $4)
       ON CONFLICT (rule_key, effective_from)
         DO UPDATE SET rule_value = EXCLUDED.rule_value, created_by = EXCLUDED.created_by`,
      [key, JSON.stringify(value), today, userId],
    );
  }
}

export interface ExclusionOption {
  value: string;
  /** PO lines + PR items — the total rows the value covers. */
  count: number;
  /** Split of `count`, because the two feeds are separate populations. */
  poLines: number;
  prItems: number;
  /** Currently excluded, so it is absent from the facts by construction. */
  excluded: boolean;
  /** False when the count came from staging rather than the facts. */
  inData: boolean;
}

/**
 * Options for the exclusion editor.
 *
 * These CANNOT be drawn from the facts alone, which is what the first version
 * did and why an exclusion could not be undone: excluded rows are never loaded
 * into the facts, so after the recompute the value had zero fact rows,
 * disappeared from this list, and the checkbox needed to clear it no longer
 * existed. The setting erased its own control.
 *
 * So the list is the UNION of what is in the facts and what is currently
 * excluded. Excluded values are counted from `staging.raw_row`, which keeps
 * every source row of the batch behind this version — that count is the honest
 * answer to the question an admin is actually asking, namely "how much comes
 * back if I re-include this?".
 *
 * The `LIMIT 60` on the fact side is unchanged, and the union protects that
 * too: an excluded value is always listed, even when it would rank below the
 * cut.
 */
export async function exclusionOptions(versionId: number): Promise<{
  docTypes: ExclusionOption[];
  purchGroups: ExclusionOption[];
  purchOrgs: ExclusionOption[];
}> {
  const current = await loadExclusions();

  // The batch this version was built from — its staging rows are pre-exclusion.
  const ver = await queryOne<{ batch_id: string }>(
    `SELECT batch_id FROM core.dataset_version WHERE id = $1`, [versionId],
  );
  const batchId = ver?.batch_id ?? null;

  const build = async (
    col: string, payloadKey: string, excluded: string[], prCol: string | null,
  ): Promise<ExclusionOption[]> => {
    /**
     * Values come from the PR feed as well as the PO feed.
     *
     * Listing only PO lines meant a document type, purchasing group or org that
     * appears exclusively on requisitions — anything not yet turned into an
     * order — could not be excluded at all: it was simply absent from the
     * editor. The requisition side is exactly where an exclusion matters most,
     * since that is where the pipeline starts.
     *
     * The two counts stay separate rather than being added into one opaque
     * number: they are different populations, and "12 PO lines · 4,300 PR
     * items" tells an admin something that "4,312 rows" does not.
     */
    const inFacts = await query<{ value: string; po_lines: number; pr_items: number }>(
      `WITH po AS (
         SELECT ${col} AS value, count(*)::int AS n FROM core.fact_po_line
          WHERE dataset_version_id = $1 AND ${col} IS NOT NULL AND ${col} <> ''
          GROUP BY 1
       ), pr AS (
         ${prCol === null
           ? `SELECT NULL::text AS value, 0::int AS n WHERE false`
           : `SELECT ${prCol} AS value, count(*)::int AS n FROM core.fact_pr_item
               WHERE dataset_version_id = $1 AND ${prCol} IS NOT NULL AND ${prCol} <> ''
               GROUP BY 1`}
       )
       SELECT COALESCE(po.value, pr.value) AS value,
              COALESCE(po.n, 0) AS po_lines,
              COALESCE(pr.n, 0) AS pr_items
         FROM po FULL OUTER JOIN pr ON pr.value = po.value
        ORDER BY (COALESCE(po.n, 0) + COALESCE(pr.n, 0)) DESC
        LIMIT 60`,
      [versionId],
    );

    const out: ExclusionOption[] = inFacts.map((r) => ({
      value: r.value,
      count: r.po_lines + r.pr_items,
      poLines: r.po_lines,
      prItems: r.pr_items,
      excluded: excluded.includes(r.value),
      inData: true,
    }));

    // Anything excluded that the facts no longer contain. Saved-but-not-yet-
    // recomputed exclusions are still in the facts and are already covered.
    const missing = excluded.filter((v) => !out.some((o) => o.value === v));
    if (missing.length === 0) return out;

    // Count from staging. Best effort: staging rows are pruned with their
    // batch, so an old exclusion may have nothing left to count — it is still
    // listed, because being able to undo it matters more than the number.
    const po = new Map<string, number>();
    const pr = new Map<string, number>();
    if (batchId !== null) {
      // Both feeds, so the "would return" figure covers the same populations
      // the live counts do.
      const rows = await query<{ feed: string; value: string; count: number }>(
        `SELECT feed, payload->>'${payloadKey}' AS value, count(*)::int AS count
           FROM staging.raw_row
          WHERE batch_id = $1 AND feed = ANY($2::text[])
            AND payload->>'${payloadKey}' = ANY($3)
          GROUP BY 1, 2`,
        [batchId, prCol === null ? ['po'] : ['po', 'pr'], missing],
      );
      for (const r of rows) (r.feed === 'pr' ? pr : po).set(r.value, r.count);
    }

    for (const v of missing) {
      const poN = po.get(v) ?? 0;
      const prN = pr.get(v) ?? 0;
      out.push({
        value: v, count: poN + prN, poLines: poN, prItems: prN,
        excluded: true, inData: false,
      });
    }
    return out;
  };

  return {
    // The PR feed carries its own Document Type, Purchasing Group and
    // Purch. organization columns, so all three dimensions read both feeds.
    docTypes: await build('doc_type', 'docType', current.docTypes, 'doc_type'),
    purchGroups: await build('purch_group', 'purchGroup', current.purchGroups, 'purch_group'),
    purchOrgs: await build('purch_org', 'purchOrg', current.purchOrgs, 'purch_org'),
  };
}

// ──────────────────────────────────────────────────────────── FX rate table

export async function fxTable(versionId: number): Promise<{
  rates: Record<string, unknown>[];
  yearResolved: number | null;
  policy: string;
}> {
  const rates = await query<Record<string, unknown>>(
    `SELECT currency_code AS "currency", period_year AS "year", period_month AS "month",
            usd_per_unit AS "usdPerUnit", derivation, pivot_currency AS "pivotCurrency",
            source, source_updated_at::text AS "sourceUpdatedAt"
       FROM core.fx_rate WHERE dataset_version_id = $1
      ORDER BY currency_code, period_year, period_month`,
    [versionId],
  );
  const v = await queryOne<{ fx_year_resolved: number | null; fx_policy: string }>(
    `SELECT fx_year_resolved, fx_policy FROM core.dataset_version WHERE id = $1`,
    [versionId],
  );
  return { rates, yearResolved: v?.fx_year_resolved ?? null, policy: v?.fx_policy ?? 'period_matched' };
}

// ─────────────────────────────────────────────────────────── column mapping

/**
 * Steward column mapping — v1's cv-modal, but server-side and audited instead of
 * per-browser localStorage where two users could silently see different numbers.
 */
export async function mappingStatus(feed: Feed): Promise<Record<string, unknown>> {
  const contract = CONTRACT_BY_FEED[feed];

  // Headers actually seen in the most recent batch file for this feed.
  const lastFile = await queryOne<{ id: number; original_filename: string; match_outcome: string }>(
    `SELECT bf.id, bf.original_filename, bf.match_outcome
       FROM ingest.batch_file bf
       JOIN ingest.batch b ON b.id = bf.batch_id
      WHERE bf.detected_feed = $1
      ORDER BY b.started_at DESC LIMIT 1`,
    [feed],
  );

  const tv = await queryOne<{ id: number }>(
    `SELECT id FROM app.template_version WHERE feed = $1 AND is_active`,
    [feed],
  );
  const mappings = tv
    ? await query<{ canonical_field: string; source_header: string }>(
        `SELECT canonical_field, source_header FROM app.column_mapping WHERE template_version_id = $1`,
        [tv.id],
      )
    : [];

  return {
    feed,
    lastFile: lastFile
      ? { filename: lastFile.original_filename, matchOutcome: lastFile.match_outcome }
      : null,
    columns: contract.columns
      .filter((c) => c.field)
      .map((c) => ({
        field: c.field,
        header: c.header,
        status: c.status,
        notes: c.notes ?? null,
        mappedTo: mappings.find((m) => m.canonical_field === c.field)?.source_header ?? null,
      })),
    aliases: contract.aliases ?? [],
  };
}

export async function saveMapping(
  feed: Feed,
  canonicalField: string,
  sourceHeader: string | null,
  userId: string | null,
): Promise<void> {
  const contract = CONTRACT_BY_FEED[feed];
  if (!contract.columns.some((c) => c.field === canonicalField)) {
    throw new Error(`unknown canonical field for ${feed}: ${canonicalField}`);
  }
  const tv = await queryOne<{ id: number }>(
    `SELECT id FROM app.template_version WHERE feed = $1 AND is_active`,
    [feed],
  );
  if (!tv) throw new Error(`no active template version for ${feed}`);

  if (sourceHeader === null || sourceHeader.trim() === '') {
    await exec(
      `DELETE FROM app.column_mapping WHERE template_version_id = $1 AND canonical_field = $2`,
      [tv.id, canonicalField],
    );
    return;
  }
  await exec(
    `INSERT INTO app.column_mapping (template_version_id, canonical_field, source_header, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (template_version_id, canonical_field)
       DO UPDATE SET source_header = EXCLUDED.source_header, created_by = EXCLUDED.created_by`,
    [tv.id, canonicalField, sourceHeader.trim(), userId],
  );
}

/** Loaded by the ingest pipeline so mappings actually apply at classification. */
export async function loadMappings(feed: Feed): Promise<Map<string, string>> {
  const rows = await query<{ canonical_field: string; source_header: string }>(
    `SELECT cm.canonical_field, cm.source_header
       FROM app.column_mapping cm
       JOIN app.template_version tv ON tv.id = cm.template_version_id
      WHERE tv.feed = $1 AND tv.is_active`,
    [feed],
  );
  return new Map(rows.map((r) => [r.canonical_field, r.source_header]));
}

export { TEMPLATE_CONTRACTS };
