/**
 * Header-signature classification — Annex A §A.8.
 *
 * Files are matched by their columns, evaluated most-specific first. A file that
 * matches no signature is reported as UNRECOGNISED and never forced into a slot.
 *
 * Filename plays no role at all — not even as a tiebreaker. v1 kept a filename
 * fallback, but the reference filenames embed a date range that changes every
 * refresh, so they are actively misleading.
 */

import { normHeader } from '@pct/rules';
import type { Feed } from '@pct/contracts';
import { TEMPLATE_CONTRACTS, CONTRACT_BY_FEED, type ContractColumn } from './contracts.js';

export type MatchOutcome = 'exact' | 'healed' | 'drift' | 'unrecognised';

export interface FieldResolution {
  field: string;
  /** Column index in the sheet, or -1 when unresolved. */
  index: number;
  header: string | null;
  via: 'exact' | 'alias' | 'mapping' | 'missing';
}

export interface ClassifyResult {
  feed: Feed | null;
  outcome: MatchOutcome;
  /** Canonical field -> sheet column index. */
  fieldIndex: Map<string, number>;
  resolutions: FieldResolution[];
  missingRequired: string[];
  unexpectedHeaders: string[];
  healedFields: string[];
}

/**
 * Order matters: most specific signature first.
 *
 * The four reference feeds are evaluated LAST on purpose. Their signatures are
 * short — a two-column file cannot say much about itself — so letting them run
 * first risks a transactional export matching a master-data contract. Checking
 * the six rich signatures first means a tie can only ever resolve in favour of
 * the transactional feed.
 */
const EVALUATION_ORDER: Feed[] = [
  'po', 'gr', 'por', 'prel', 'pr', 'fx',
  'matm', 'zuser', 'pgrp', 'porg',
];

export function classifyHeaders(
  headers: readonly string[],
  stewardMappings: ReadonlyMap<string, string> = new Map(),
): ClassifyResult {
  const norms = headers.map((h) => normHeader(h));
  const normSet = new Set(norms.filter(Boolean));
  const has = (k: string) => normSet.has(k);

  let feed: Feed | null = null;
  for (const candidate of EVALUATION_ORDER) {
    const sig = CONTRACT_BY_FEED[candidate].signature;
    if (sig.all.some((k) => !has(k))) continue;
    if (sig.any && !sig.any.some(has)) continue;
    if (sig.none?.some(has)) continue;
    feed = candidate;
    break;
  }

  if (feed === null) {
    // Rate tables can also present as Currency|Rate with very few columns.
    if (isCompactRateTable(normSet)) feed = 'fx';
  }

  if (feed === null) {
    return {
      feed: null,
      outcome: 'unrecognised',
      fieldIndex: new Map(),
      resolutions: [],
      missingRequired: [],
      unexpectedHeaders: headers.filter((h) => normHeader(h) !== ''),
      healedFields: [],
    };
  }

  const contract = CONTRACT_BY_FEED[feed];
  const aliasByField = new Map<string, string[]>();
  for (const a of contract.aliases ?? []) {
    const list = aliasByField.get(a.field);
    if (list) list.push(a.aliasNorm);
    else aliasByField.set(a.field, [a.aliasNorm]);
  }

  const fieldIndex = new Map<string, number>();
  const resolutions: FieldResolution[] = [];
  const missingRequired: string[] = [];
  const healedFields: string[] = [];
  const consumed = new Set<number>();

  const findIndex = (norm: string): number => norms.findIndex((n, i) => n === norm && !consumed.has(i));

  for (const c of contract.columns) {
    if (!c.field) continue;

    // 1. exact header match
    let idx = findIndex(c.headerNorm);
    let via: FieldResolution['via'] = 'exact';

    // 2. registered alias
    if (idx < 0) {
      for (const alias of aliasByField.get(c.field) ?? []) {
        idx = findIndex(alias);
        if (idx >= 0) {
          via = 'alias';
          break;
        }
      }
    }

    // 3. steward mapping (server-side, audited)
    if (idx < 0) {
      const mapped = stewardMappings.get(c.field);
      if (mapped) {
        idx = findIndex(normHeader(mapped));
        if (idx >= 0) via = 'mapping';
      }
    }

    if (idx >= 0) {
      consumed.add(idx);
      fieldIndex.set(c.field, idx);
      resolutions.push({ field: c.field, index: idx, header: headers[idx] ?? null, via });
      if (via !== 'exact') healedFields.push(c.field);
    } else {
      resolutions.push({ field: c.field, index: -1, header: null, via: 'missing' });
      if (c.status === 'PK' || c.status === 'REQ') missingRequired.push(`${c.header} (${c.field})`);
    }
  }

  const contractNorms = new Set(contract.columns.map((c) => c.headerNorm));
  const unexpectedHeaders = headers.filter(
    (h) => normHeader(h) !== '' && !contractNorms.has(normHeader(h)),
  );

  const outcome: MatchOutcome =
    missingRequired.length > 0 ? 'drift' : healedFields.length > 0 ? 'healed' : 'exact';

  return { feed, outcome, fieldIndex, resolutions, missingRequired, unexpectedHeaders, healedFields };
}

function isCompactRateTable(normSet: ReadonlySet<string>): boolean {
  const rateish = [...normSet].some((h) => h.includes('rate') && h !== 'ratio');
  const hasCurrency = ['currency', 'currencycode', 'ccy', 'curr'].some((h) => normSet.has(h));
  return rateish && hasCurrency && normSet.size <= 4;
}

/** Columns declared DEAD on the active contract, for the Data Check report. */
export function deadColumns(feed: Feed): ContractColumn[] {
  return CONTRACT_BY_FEED[feed].columns.filter((c) => c.status === 'DEAD');
}

export function requiredFields(feed: Feed): string[] {
  return CONTRACT_BY_FEED[feed]
    .columns.filter((c) => c.field && (c.status === 'PK' || c.status === 'REQ'))
    .map((c) => c.field as string);
}

export { TEMPLATE_CONTRACTS };
