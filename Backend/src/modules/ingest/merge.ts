/**
 * SAP uploads merge into what is already loaded (035).
 *
 * Requested 6 Oct 2026: a new file must UPDATE the records it carries and ADD
 * the ones that are new, and must not take away what earlier files brought.
 * Until then a dataset version was built from one batch's files alone.
 *
 * The design keeps everything downstream unchanged. The transform still builds
 * a complete, immutable version from a complete set of rows - statuses, ageing,
 * PR/PO linkage, exclusions and the mart all need the whole population, not a
 * delta - and only the place it reads those rows from changes: instead of one
 * batch's staging rows it reads the batch's EFFECTIVE rows, i.e. the newest
 * copy of every document across the batch's lineage. See 035 for the store and
 * the keys.
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { fillReleaseContinuations, type ReleaseRowRaw } from '@pct/rules';
import { insertMany } from '../../db/client.js';

/** Feeds whose records accumulate. fx has its own shared store; reference feeds upsert dimensions. */
export const MERGE_FEEDS = ['pr', 'prel', 'po', 'por', 'gr'] as const;
export type MergeFeed = (typeof MERGE_FEEDS)[number];

export interface FeedMerge {
  /** Rows this upload's file(s) carried for the feed (0: no file, carried forward). */
  inFile: number;
  /** Records seen for the first time. */
  inserted: number;
  /** Records already loaded whose content changed. */
  updated: number;
  /** Records already loaded and identical. */
  unchanged: number;
  /** Release steps a newer file no longer lists for a document it carries. */
  replacedSteps: number;
  /** Rows that could not be keyed (no document number, no posting date...). */
  unkeyed: number;
  /** Repeats of a key within this upload; the first copy was kept. */
  duplicates: number;
  /** Records in the version after the merge. */
  total: number;
}

export type MergeSummary = Record<MergeFeed, FeedMerge> & {
  /** Present when this upload carried a PR Release file. */
  prelFill?: PrelFillStats;
  /**
   * PR Release rows set aside by the V-R04 guards (5 Nov 2026, setAsideBad):
   * the rest of the file was stored. The caller files them as failed rows.
   */
  prelSetAside?: { batchFileId: number; sourceRow: number; ruleId: string; reason: string; prNo: string | null }[];
};

interface Row {
  source_row: number;
  batch_file_id: number;
  payload: Record<string, unknown>;
}

// The transform's own coercions, so a key here is the key the facts use.
const s = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const i = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? Math.trunc(x) : null;
};

/**
 * The record key and the document key of one row, or null when the row has no
 * usable key - the transform skips such rows too, so nothing is lost by not
 * storing them.
 */
export function keysOf(feed: MergeFeed, p: Record<string, unknown>): { rec: string; doc: string } | null {
  switch (feed) {
    case 'pr': {
      const no = s(p['prNo']); const it = i(p['prItem']);
      if (no === null || it === null) return null;
      const k = `${no}|${it}`;
      return { rec: k, doc: k };
    }
    case 'po': {
      const no = s(p['poNo']); const it = i(p['poItem']);
      if (no === null || it === null) return null;
      const k = `${no}|${it}`;
      return { rec: k, doc: k };
    }
    case 'gr': {
      // SAP numbers material documents per fiscal year (034).
      const d = s(p['postingDate']); const doc = s(p['materialDoc']); const it = i(p['materialDocItem']);
      if (d === null || doc === null || it === null) return null;
      const k = `${d.slice(0, 4)}|${doc}|${it}`;
      return { rec: k, doc: k };
    }
    case 'prel': {
      const no = s(p['prNo']); const it = i(p['prItem']); const seq = i(p['relSeq']);
      if (no === null || it === null || seq === null) return null;
      return { rec: `${no}|${it}|${seq}`, doc: `${no}|${it}` };
    }
    case 'por': {
      const no = s(p['poNo']); const seq = i(p['relSeq']); const code = s(p['relCode']);
      if (no === null || seq === null) return null;
      return { rec: `${no}|${seq}|${code ?? ''}`, doc: no };
    }
  }
}

/**
 * PR Release continuation rows carry a blank PR No and inherit it from the row
 * above. That depends on the FILE's row order, which means nothing once rows
 * from several uploads are combined - so the inherited values are written into
 * the row before it is stored. The transform's own fill is then a no-op on
 * stored rows (none of them is a continuation row any more).
 */
/** The fill's guards for this upload's PR Release file, as the transform used to report them. */
export interface PrelFillStats {
  continuationRowsAttached: number;
  continuationOrderViolations: number;
  continuationDuplicateKeys: number;
  l2BeforeL1: number;
  /**
   * So many rows broke the order that the export looks re-sorted: setting a
   * few rows aside would not help, because the rows that DO follow a
   * sequence-1 row may follow the wrong one. Nothing was set aside, and V-R04
   * stays a blocker for the whole PR Release file.
   */
  looksResorted?: boolean;
}

/**
 * Above this, out-of-order continuation rows are read as a re-sorted export
 * rather than a few bad rows: 20 rows, or 1% of the continuation rows if more.
 */
const RESORTED_MIN = 20;
const RESORTED_SHARE = 0.01;

function fillPrel(rows: Row[], setAsideBad = false): {
  rows: Row[]; stats: PrelFillStats; setAside: NonNullable<MergeSummary['prelSetAside']>;
} {
  // rowNumber is the row's INDEX here, not its file row: an upload may carry
  // several PR Release files, whose row numbers repeat.
  const raw: ReleaseRowRaw[] = rows.map((r, idx) => ({
    rowNumber: idx,
    prNo: s(r.payload['prNo']),
    prItem: i(r.payload['prItem']),
    prCreatedDate: s(r.payload['prCreatedDate']),
    relSeq: i(r.payload['relSeq']),
    relCode: s(r.payload['relCode']),
    picRelease: s(r.payload['picRelease']),
    loginName: s(r.payload['loginName']),
    approveDate: s(r.payload['approveDate']),
    approveTime: s(r.payload['approveTime']),
    status: s(r.payload['status']),
    plant: s(r.payload['plant']),
    purchOrg: s(r.payload['purchOrg']),
    docType: s(r.payload['docType']),
    apprLeadDays: i(r.payload['apprLeadDays']),
    gapLeadDays: i(r.payload['gapLeadDays']),
  }));
  // Continuation rows that cannot be attached to a parent are dropped, as the
  // transform drops them. With setAsideBad, the rows the V-R04 guards catch are
  // taken out and returned - unless there are so many that the file itself is
  // the problem (looksResorted), when it is filled as before and blocked.
  let res = fillReleaseContinuations(raw, { setAsideBad });
  const looksResorted = setAsideBad
    && res.orderViolations > Math.max(RESORTED_MIN, res.continuationCount * RESORTED_SHARE);
  if (looksResorted) res = fillReleaseContinuations(raw);
  const out = res.rows.map((f) => {
    const src = rows[f.rowNumber]!;
    return {
      ...src,
      payload: {
        ...src.payload,
        prNo: f.prNo,
        prItem: f.prItem,
        prCreatedDate: f.prCreatedDate,
        plant: f.plant,
        purchOrg: f.purchOrg,
        docType: f.docType,
        // fact_pr_release.was_continuation, which the drill shows as "Filled".
        ...(f.wasContinuation ? { _continuation: true } : {}),
      },
    };
  });
  return {
    rows: out,
    stats: {
      continuationRowsAttached: res.continuationCount - res.unattached - res.setAside.filter((x) => x.ruleId === 'V-R04').length,
      continuationOrderViolations: res.orderViolations,
      continuationDuplicateKeys: res.duplicateKeys,
      l2BeforeL1: res.l2BeforeL1,
      ...(looksResorted ? { looksResorted: true } : {}),
    },
    setAside: res.setAside.map((x) => {
      const src = rows[x.rowNumber]!;
      return {
        batchFileId: src.batch_file_id,
        sourceRow: src.source_row,
        ruleId: x.ruleId,
        reason: x.reason,
        prNo: s(src.payload['prNo']),
      };
    }),
  };
}

const hashOf = (payload: unknown): string =>
  createHash('sha1').update(JSON.stringify(payload)).digest('hex');

/** The batches a batch builds on, nearest first: itself, its parent, ... */
const LINEAGE_CTE = `
  WITH RECURSIVE chain(id, depth) AS (
    SELECT $1::bigint, 0
    UNION ALL
    SELECT b.parent_batch_id, c.depth + 1
      FROM chain c JOIN ingest.batch b ON b.id = c.id
     WHERE b.parent_batch_id IS NOT NULL AND c.depth < 10000
  ),
  pick AS (
    SELECT DISTINCT ON (r.doc_key) r.doc_key, r.batch_id
      FROM ingest.source_record r JOIN chain c ON c.id = r.batch_id
     WHERE r.feed = $2
     ORDER BY r.doc_key, c.depth
  )`;

/**
 * A batch's effective rows for one feed: for every document, the copy from the
 * nearest batch in its lineage that carried it. Ordered by batch then file row,
 * so a row's position is stable from one run to the next.
 */
export async function loadEffective(
  client: pg.PoolClient,
  batchId: number,
  feed: MergeFeed,
): Promise<Row[]> {
  const r = await client.query<Row>(
    `${LINEAGE_CTE}
     SELECT s.source_row, s.batch_file_id, s.payload
       FROM ingest.source_record s
       JOIN pick p ON p.batch_id = s.batch_id AND p.doc_key = s.doc_key
      WHERE s.feed = $2
      ORDER BY s.batch_id, s.batch_file_id, s.source_row`,
    [batchId, feed],
  );
  return r.rows;
}

/** The parent's record keys and content hashes, grouped by document. */
async function effectiveIndex(
  client: pg.PoolClient,
  batchId: number,
  feed: MergeFeed,
): Promise<Map<string, Map<string, string>>> {
  const r = await client.query<{ doc_key: string; record_key: string; payload_hash: string }>(
    `${LINEAGE_CTE}
     SELECT s.doc_key, s.record_key, s.payload_hash
       FROM ingest.source_record s
       JOIN pick p ON p.batch_id = s.batch_id AND p.doc_key = s.doc_key
      WHERE s.feed = $2`,
    [batchId, feed],
  );
  const out = new Map<string, Map<string, string>>();
  for (const x of r.rows) {
    let m = out.get(x.doc_key);
    if (!m) { m = new Map(); out.set(x.doc_key, m); }
    m.set(x.record_key, x.payload_hash);
  }
  return out;
}

/**
 * Write a batch's records into the store, building on `parentBatchId` (or on
 * nothing, for a full load that stands alone).
 *
 * Only documents that are new or changed are written: an unchanged document
 * resolves to its parent's copy through the lineage, which is identical.
 * Runs inside the caller's transaction, so a load that fails later writes
 * nothing here either.
 */
export async function recordSourceRows(
  client: pg.PoolClient,
  batchId: number,
  parentBatchId: number | null,
  /** Set aside the PR Release rows the V-R04 guards catch (5 Nov 2026). */
  opts: { setAsideBad?: boolean } = {},
): Promise<MergeSummary> {
  const summary = {} as MergeSummary;

  for (const feed of MERGE_FEEDS) {
    const fm: FeedMerge = {
      inFile: 0, inserted: 0, updated: 0, unchanged: 0, replacedSteps: 0,
      unkeyed: 0, duplicates: 0, total: 0,
    };
    let rows = (await client.query<Row>(
      `SELECT source_row, batch_file_id, payload FROM staging.raw_row
        WHERE batch_id = $1 AND feed = $2 ORDER BY batch_file_id, source_row`,
      [batchId, feed],
    )).rows;
    fm.inFile = rows.length;
    if (feed === 'prel' && rows.length > 0) {
      const f = fillPrel(rows, opts.setAsideBad === true);
      rows = f.rows;
      summary.prelFill = f.stats;
      if (f.setAside.length > 0) summary.prelSetAside = f.setAside;
    }

    // This upload's documents, first copy of a key wins (as in the transform).
    const docs = new Map<string, { rec: string; hash: string; row: Row }[]>();
    const seen = new Set<string>();
    for (const row of rows) {
      const k = keysOf(feed, row.payload);
      if (k === null) { fm.unkeyed += 1; continue; }
      if (seen.has(k.rec)) { fm.duplicates += 1; continue; }
      seen.add(k.rec);
      const list = docs.get(k.doc) ?? [];
      list.push({ rec: k.rec, hash: hashOf(row.payload), row });
      docs.set(k.doc, list);
    }

    const parent = parentBatchId === null
      ? new Map<string, Map<string, string>>()
      : await effectiveIndex(client, parentBatchId, feed);

    const toWrite: unknown[][] = [];
    for (const [doc, recs] of docs) {
      const before = parent.get(doc);
      let changed = before === undefined || before.size !== recs.length;
      for (const r of recs) {
        const h = before?.get(r.rec);
        if (h === undefined) fm.inserted += 1;
        else if (h !== r.hash) { fm.updated += 1; changed = true; } else fm.unchanged += 1;
        if (h === undefined && before !== undefined) changed = true;
      }
      if (before !== undefined) {
        const now = new Set(recs.map((r) => r.rec));
        for (const rec of before.keys()) if (!now.has(rec)) fm.replacedSteps += 1;
      }
      if (!changed) continue;
      for (const r of recs) {
        toWrite.push([
          feed, r.rec, doc, batchId, JSON.stringify(r.row.payload), r.hash,
          r.row.batch_file_id, r.row.source_row,
        ]);
      }
    }

    if (toWrite.length > 0) {
      await insertMany(
        client,
        'ingest.source_record',
        ['feed', 'record_key', 'doc_key', 'batch_id', 'payload', 'payload_hash', 'batch_file_id', 'source_row'],
        toWrite,
        1000,
      );
    }

    // Documents after the merge: the parent's, plus the new ones.
    let total = 0;
    for (const [doc, recs] of parent) if (!docs.has(doc)) total += recs.size;
    for (const recs of docs.values()) total += recs.length;
    fm.total = total;
    summary[feed] = fm;
  }

  await client.query(
    `UPDATE ingest.batch SET parent_batch_id = $2, source_recorded = true, merge_summary = $3::jsonb
      WHERE id = $1`,
    [batchId, parentBatchId, JSON.stringify(summary)],
  );
  return summary;
}

/**
 * The batch an upload builds on: the batch of the version being served right
 * now. Recorded into the store on first use when it predates 035 - from its
 * own staging rows, which a retained version still has. Returns null when
 * there is nothing to build on (first ever load, or the base's staging rows
 * were already pruned), and the upload is then a full load as before.
 */
export async function resolveParent(client: pg.PoolClient): Promise<{
  parentBatchId: number | null;
  bootstrapped: boolean;
  reason: string | null;
}> {
  const cur = (await client.query<{ batch_id: string; source_recorded: boolean }>(
    `SELECT v.batch_id, b.source_recorded
       FROM core.dataset_pointer p
       JOIN core.dataset_version v ON v.id = p.current_version_id
       JOIN ingest.batch b ON b.id = v.batch_id
      WHERE p.id = 1`,
  )).rows[0];
  if (!cur) return { parentBatchId: null, bootstrapped: false, reason: 'no published version yet' };
  const parentBatchId = Number(cur.batch_id);
  if (cur.source_recorded) return { parentBatchId, bootstrapped: false, reason: null };

  const staged = (await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM staging.raw_row WHERE batch_id = $1 AND feed = ANY($2)`,
    [parentBatchId, [...MERGE_FEEDS]],
  )).rows[0];
  if (Number(staged?.n ?? 0) === 0) {
    return {
      parentBatchId: null, bootstrapped: false,
      reason: `the published version's source rows (batch ${parentBatchId}) are no longer staged`,
    };
  }
  // A pre-035 batch was a full load: it builds on nothing.
  await recordSourceRows(client, parentBatchId, null);
  return { parentBatchId, bootstrapped: true, reason: null };
}
