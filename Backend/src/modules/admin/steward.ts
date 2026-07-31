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

/** Options for the exclusion editor, drawn from the data itself. */
export async function exclusionOptions(versionId: number): Promise<{
  docTypes: { value: string; count: number }[];
  purchGroups: { value: string; count: number }[];
  purchOrgs: { value: string; count: number }[];
}> {
  const q3 = async (col: string) =>
    query<{ value: string; count: number }>(
      `SELECT ${col} AS value, count(*)::int AS count FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND ${col} IS NOT NULL AND ${col} <> ''
        GROUP BY 1 ORDER BY 2 DESC LIMIT 60`,
      [versionId],
    );
  return {
    docTypes: await q3('doc_type'),
    purchGroups: await q3('purch_group'),
    purchOrgs: await q3('purch_org'),
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
            usd_per_unit AS "usdPerUnit", derivation, pivot_currency AS "pivotCurrency"
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
