/**
 * Batch pipeline — PRD §10.
 *
 * DISCOVERED -> SCANNING -> PARSING -> VALIDATING -> TRANSFORMING -> READY -> PUBLISHED
 *
 * A batch is only ever published atomically. On any failure the previously
 * published version keeps serving, untouched — the v1 rule "analysis does not run
 * on a partial bundle", enforced by the database rather than by UI flow.
 *
 * PARTIAL LOADS (5 Nov 2026, rule ingest.partial_load, on by default when
 * merging). A bad row no longer fails the run; it is SET ASIDE - kept out of
 * the load, written to ingest.row_error with its reason, and so filed in the
 * failed folder's workbook - while the rest of its file loads:
 *
 *   row level   V-R07 unregistered GR movement type; V-R04 a PR Release
 *               continuation row out of order; V-R04a a repeated release step.
 *   file level  only where no row of the file is usable: V-S05 an empty file,
 *               V-S02 a required column missing, a PR Release file so out of
 *               order it looks re-sorted (V-R04), a rate file whose year cannot
 *               be anchored (V-R06a). That file is filed to failed and its feed
 *               carried forward from the last upload that carried it - the
 *               merge already does exactly that for a file that did not arrive.
 *   run level   still fails: no exchange rates at all (V-R08), every file set
 *               aside, or no loaded data to carry a set-aside feed forward from.
 *
 * The published version is still built atomically from what was accepted.
 */

import type { BatchState, Feed } from '@pct/contracts';
import { exec, insertMany, pool, query, queryOne, transaction } from '../../db/client.js';
import { loadRuleSnapshot, type RuleSnapshot } from '../admin/rules.js';
import { buildMart } from '../analytics/mart.js';
import { runTransform } from '../transform/transform.js';
import {
  checkFile, checkMetrics, checkStaged, disabledKpis, type Finding,
} from '../validate/validate.js';
import { classifyHeaders } from './classify.js';
import { loadMappings } from '../admin/steward.js';
import { REQUIRED_FEEDS } from './contracts.js';
import {
  MERGE_FEEDS, recordSourceRows, resolveParent, type MergeFeed, type MergeSummary,
} from './merge.js';
import { extractRowChecked, readSheetFromBuffer } from './parse.js';
import {
  assertFileSize, assertMagicBytes, bundleHash, DEFAULT_SAFETY, sha256,
  SourceUnavailableError, type FileSource, type SafetyLimits,
} from './sources.js';

export interface IngestOptions {
  source: FileSource;
  submittedBy?: string | null;
  /** Automatic batches publish immediately; manual batches wait for confirmation. */
  autoPublish?: boolean;
  /**
   * Re-process even when the bundle hash matches the published version. Needed
   * when the transform's behaviour changed without the source changing —
   * exclusion edits, new fact columns, rule updates.
   */
  force?: boolean;
  safety?: SafetyLimits;
  onProgress?: (stage: string, detail?: string) => void;
}

/**
 * What each file contributed, per feed.
 *
 * `rowsRead` is what the sheet held; `rowsWithError` is how many of those carry
 * at least one cell that could not be read (023). `rowsAccepted` is the
 * difference — and it is a count of rows STAGED, not of rows that reached the
 * facts: a row with an unreadable optional cell is still staged and still
 * contributes, so calling it "failed" would overstate the damage. When the batch
 * as a whole fails, nothing reaches the facts regardless, which the outcome
 * already says.
 */
export interface FeedRowSummary {
  feed: string;
  filename: string;
  rowsRead: number;
  rowsWithError: number;
  rowsAccepted: number;
  /** null when the file's headers matched no template at all. */
  matched: boolean;
  /** Why the whole file was set aside (partial loads); absent when it loaded. */
  setAside?: string;
}

export type IngestOutcome =
  | {
    outcome: 'published'; batchId: number; datasetVersionId: number;
    findings: Finding[]; rowSummary: FeedRowSummary[];
  }
  | {
    outcome: 'ready'; batchId: number; datasetVersionId: number;
    findings: Finding[]; rowSummary: FeedRowSummary[];
  }
  | {
    outcome: 'failed'; batchId: number; reason: string;
    findings: Finding[]; rowSummary: FeedRowSummary[];
  }
  | { outcome: 'noop_unchanged'; batchId: number | null }
  | {
      outcome: 'incomplete_bundle';
      missing: Feed[];
      /**
       * Every file that was read, and what its columns identified it as.
       *
       * Reported out of the pipeline because this is the only moment anyone
       * holds them: an incomplete bundle never creates a batch, so nothing is
       * written to ingest.batch_file and there is nothing to look up later.
       *
       * All files, not only the unrecognised ones, because a feed can be
       * missing while its file sits right there — if that file's columns
       * identified it as a DIFFERENT feed. "Found it, but it looks like a PO
       * export" is a different problem from "found it, recognised nothing",
       * and the operator should not have to guess which happened.
       */
      filesRead: { displayName: string; sheetName: string; headers: string[]; feed: Feed | null }[];
    }
  | { outcome: 'source_unavailable'; path: string }
  /**
   * The pickup folder is empty because a previous run filed its contents away,
   * and the next exports have not landed yet. The normal state between exports
   * once after-run filing is on — NOT a fault, which is the whole point of
   * separating it from `incomplete_bundle`.
   */
  | { outcome: 'awaiting_exports'; filedBatchId: number; filedAt: string; hoursAgo: number };

/**
 * How long an empty pickup folder stays "waiting" before it becomes "overdue".
 *
 * Four days, because the exports are daily and the gap that matters is a long
 * weekend: Friday's run files Friday's exports away, and the next set may not
 * land until Monday or Tuesday. Past that, an empty folder is worth an email
 * again — the point of this outcome is to stop crying wolf between exports, not
 * to go quiet when the exports really have stopped.
 *
 * Overridable in rule_config so a site with a weekly cadence can widen it
 * without a deployment.
 */
const DEFAULT_AWAITING_GRACE_HOURS = 96;

async function awaitingGraceHours(): Promise<number> {
  const raw = (await loadRuleSnapshot())['ingest.awaiting_grace_hours'];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_AWAITING_GRACE_HOURS;
}

/** The most recent run that moved its own source files out of the pickup folder. */
async function lastFiling(): Promise<
  { filedBatchId: number; filedAt: string; hoursAgo: number } | null
> {
  try {
    const r = await queryOne<{ batch_id: string; filed_at: string; hours: string }>(
      `SELECT batch_id, filed_at::text AS filed_at,
              (EXTRACT(EPOCH FROM (now() - filed_at)) / 3600)::text AS hours
         FROM ops.ingest_filing ORDER BY filed_at DESC LIMIT 1`,
    );
    if (!r) return null;
    return {
      filedBatchId: Number(r.batch_id),
      filedAt: r.filed_at,
      hoursAgo: Math.round(Number(r.hours)),
    };
  } catch {
    // ops.ingest_filing absent (pre-024): fall back to the old behaviour rather
    // than claiming a filing that cannot be proven.
    return null;
  }
}

export async function runIngest(opts: IngestOptions): Promise<IngestOutcome> {
  const log = opts.onProgress ?? (() => undefined);
  const safety = opts.safety ?? DEFAULT_SAFETY;

  // ── discover ──
  let discovered;
  try {
    log('scanning', 'enumerating source');
    discovered = await opts.source.list();
  } catch (err) {
    if (err instanceof SourceUnavailableError) {
      return { outcome: 'source_unavailable', path: err.path };
    }
    throw err;
  }

  if (discovered.length === 0) {
    // An empty folder has two very different causes and they look identical on
    // disk: either a previous run filed the exports away and the next ones have
    // not arrived, or the exports stopped coming. ops.ingest_filing is the
    // record of the first, written only when a run actually moved files.
    const filed = await lastFiling();
    if (filed !== null && filed.hoursAgo <= (await awaitingGraceHours())) {
      return { outcome: 'awaiting_exports', ...filed };
    }
    // No filing on record, or one old enough that the next export is genuinely
    // overdue. Either way this is worth an alert, so it keeps the outcome it
    // always had.
    return { outcome: 'incomplete_bundle', missing: [...REQUIRED_FEEDS], filesRead: [] };
  }

  // ── read, gate, classify ──
  interface Prepared {
    displayName: string;
    byteSize: number;
    sha: string;
    mtime: Date | null;
    sheetName: string;
    headers: string[];
    rows: unknown[][];
    cls: ReturnType<typeof classifyHeaders>;
  }

  const prepared: Prepared[] = [];
  for (const f of discovered) {
    log('scanning', f.displayName);
    assertFileSize(f.byteSize, f.displayName, safety);
    const buf = await opts.source.read(f.handle);
    assertMagicBytes(buf, f.displayName);
    const sheet = readSheetFromBuffer(buf);
    // First pass identifies the feed; steward mappings are per feed, so a
    // second pass applies them once the feed is known. Cheap (headers only).
    let cls = classifyHeaders(sheet.headers);
    if (cls.feed !== null) {
      const mappings = await loadMappings(cls.feed);
      if (mappings.size > 0) cls = classifyHeaders(sheet.headers, mappings);
    }
    prepared.push({
      displayName: f.displayName,
      byteSize: f.byteSize,
      sha: sha256(buf),
      mtime: f.mtime,
      sheetName: sheet.sheetName,
      headers: sheet.headers,
      rows: sheet.rows,
      cls,
    });
  }

  // ── idempotency: identical bundle already published is a no-op ──
  // Unless forced: a recompute after an exclusion or rule change must re-run
  // the transform even though the source files are byte-identical.
  const bHash = bundleHash(prepared.map((p) => p.sha));
  if (!opts.force) {
    const already = await queryOne<{ id: string }>(
      `SELECT id FROM ingest.batch WHERE bundle_hash = $1 AND state = 'PUBLISHED'`,
      [bHash],
    );
    if (already) {
      return { outcome: 'noop_unchanged', batchId: Number(already.id) };
    }
  }

  // ── completeness ──
  //
  // Merging (035, the default): an upload adds to what is already loaded, so
  // ONE recognised SAP file of any kind is enough (11 Nov 2026: a SAP Users
  // file on its own used to be refused for carrying none of the five
  // transaction exports). Whatever it lacks is carried forward unchanged - the
  // five exports by the merge, the reference lists (P Grp, P Org, Mat group,
  // ZUSER) and the rates because they are only ever updated when a file
  // brings them. Without a base to merge into - the first load ever, merging
  // switched off, or a base whose rows were pruned - an upload is a full load
  // as before and must carry all five.
  const foundFeeds = new Set(prepared.map((p) => p.cls.feed).filter((f): f is Feed => f !== null));
  const merging = await mergeEnabled();
  const base = merging ? await mergeBaseAvailable() : false;
  // Partial loads need something to carry a set-aside feed forward FROM.
  const partial = base && (await partialEnabled());
  const missing = REQUIRED_FEEDS.filter((f) => !foundFeeds.has(f));
  const incomplete = base
    ? foundFeeds.size === 0
    : missing.length > 0;
  if (incomplete) {
    return {
      outcome: 'incomplete_bundle',
      missing,
      filesRead: prepared.map((p) => ({
        displayName: p.displayName,
        sheetName: p.sheetName,
        headers: p.headers,
        feed: p.cls.feed,
      })),
    };
  }

  // ── create the batch ──
  const batchIns = await queryOne<{ id: string }>(
    `INSERT INTO ingest.batch (source_kind, source_detail, state, submitted_by, bundle_hash)
     VALUES ($1, $2, 'SCANNING', $3, $4) RETURNING id`,
    [opts.source.kind, null, opts.submittedBy ?? null, bHash],
  );
  const batchId = Number(batchIns!.id);
  const t0 = Date.now();
  const timings: Record<string, number> = {};

  const setState = async (state: BatchState, reason?: string) => {
    await exec(
      `UPDATE ingest.batch SET state = $2, failure_reason = $3,
              finished_at = CASE WHEN $2 IN ('PUBLISHED','FAILED','CANCELLED') THEN now() ELSE finished_at END,
              timings = $4::jsonb
         WHERE id = $1`,
      [batchId, state, reason ?? null, JSON.stringify(timings)],
    );
  };

  const findings: Finding[] = [];
  /** Feeds whose file was set aside whole, with why (partial loads). */
  const setAsideFeeds = new Map<Feed, string>();

  /**
   * Set one feed's file aside: its staged rows leave the batch, the file is
   * marked rejected (archive files it to failed), the blockers raised on it
   * become warnings, and one V-Q01 says what happened in words. The merge then
   * carries the feed forward, as for a file that never arrived.
   */
  const setAsideFile = async (feed: Feed, why: string): Promise<void> => {
    if (setAsideFeeds.has(feed)) return;
    setAsideFeeds.set(feed, why);
    await exec('DELETE FROM staging.raw_row WHERE batch_id = $1 AND feed = $2', [batchId, feed]);
    const files = await query<{ original_filename: string }>(
      `UPDATE ingest.batch_file SET rejected_reason = $3
        WHERE batch_id = $1 AND detected_feed = $2 RETURNING original_filename`,
      [batchId, feed, why.slice(0, 1000)],
    );
    for (const f of findings) {
      if (f.feed === feed && f.severity === 'BLOCKER') {
        f.severity = 'WARNING';
        f.message = `Set aside: ${f.message}`;
      }
    }
    const label = FEED_NAMES[feed as MergeFeed] ?? (feed === 'fx' ? 'Rate Conversion' : feed);
    findings.push({
      ruleId: 'V-Q01',
      severity: 'WARNING',
      feed,
      message: `${label} file ${files.map((x) => `"${x.original_filename}"`).join(', ') || ''} was set aside and filed to `
        + `the failed folder - ${why} The rest of the upload was loaded; ${label} figures are carried forward `
        + 'from the last upload that carried a usable file.',
      affectedRows: null,
      measured: { reason: why, files: files.map((x) => x.original_filename) },
      disablesKpis: [],
      drillPredicate: null,
    });
  };

  /** Rows already set aside, written as failed rows the workbook carries. */
  const recordSetAsideRows = async (
    client: import('pg').PoolClient | null,
    rows: { feed: string; sourceRow: number; field: string; header: string; raw: string; ruleId: string; reason: string }[],
  ): Promise<void> => {
    if (rows.length === 0) return;
    const values = rows.map((r) => [batchId, r.feed, r.sourceRow, r.field, r.header, r.raw.slice(0, 500), r.ruleId, r.reason]);
    if (client) {
      await insertMany(client, 'ingest.row_error',
        ['batch_id', 'feed', 'source_row', 'field', 'header', 'raw_value', 'rule_id', 'reason'], values, 1000);
    } else {
      await transaction((c) => insertMany(c, 'ingest.row_error',
        ['batch_id', 'feed', 'source_row', 'field', 'header', 'raw_value', 'rule_id', 'reason'], values, 1000));
    }
  };

  /**
   * Declared out here, not inside the try, because the catch below can be
   * reached before parsing has run at all — a read failure, a safety-gate
   * rejection. An empty summary is then the truthful answer rather than a
   * reference error hiding the real cause.
   */
  let rowSummary: FeedRowSummary[] = [];

  try {
    // prior row counts, for the ±60% drift warning
    const prior = await queryOne<{ feed_row_counts: Record<string, number> }>(
      `SELECT feed_row_counts FROM core.dataset_version
        WHERE status = 'PUBLISHED' ORDER BY published_at DESC LIMIT 1`,
    );
    const priorCounts = prior?.feed_row_counts ?? {};

    // ── PARSING ──
    await setState('PARSING');
    const parseStart = Date.now();
    // Rows (not cells) carrying at least one unreadable value, per feed. Counted
    // here rather than queried later so the number reported to the operator is
    // the one this run actually produced.
    const rowErrorCounts: Record<string, number> = {};

    for (const p of prepared) {
      const fileIns = await queryOne<{ id: string }>(
        `INSERT INTO ingest.batch_file
           (batch_id, original_filename, sheet_name, byte_size, sha256, source_mtime,
            detected_feed, match_outcome, row_count, av_scan_result)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'skipped') RETURNING id`,
        [
          batchId, p.displayName, p.sheetName, p.byteSize, p.sha, p.mtime,
          p.cls.feed, p.cls.outcome, p.rows.length,
        ],
      );
      const fileId = Number(fileIns!.id);

      findings.push(
        ...checkFile({
          feed: p.cls.feed,
          displayName: p.displayName,
          outcome: p.cls.outcome,
          missingRequired: p.cls.missingRequired,
          unexpectedHeaders: p.cls.unexpectedHeaders,
          healedFields: p.cls.healedFields,
          rowCount: p.rows.length,
          // Not when merging: a file may now carry one month on purpose, and
          // its size says nothing about the population. The merge summary
          // reports what actually changed instead.
          priorRowCount: base ? null : p.cls.feed ? (priorCounts[p.cls.feed] ?? null) : null,
        }),
      );

      if (p.cls.feed === null) continue;

      log('parsing', `${p.cls.feed}: ${p.rows.length} rows`);

      const feed = p.cls.feed;
      /**
       * Extract and collect per-cell errors in the same pass.
       *
       * source_row is idx + 2 because the header is row 1 — the same number the
       * operator sees in Excel, which is the only number that makes an error
       * report actionable.
       */
      const staged: unknown[][] = [];
      const rowErrors: unknown[][] = [];
      p.rows.forEach((raw, idx) => {
        const sourceRow = idx + 2;
        const { row, errors } = extractRowChecked(feed, p.cls, raw);
        staged.push([batchId, fileId, feed, sourceRow, JSON.stringify(row)]);
        for (const e of errors) {
          rowErrors.push([
            batchId, feed, sourceRow, e.field, e.header,
            e.rawValue.slice(0, 500), e.ruleId, e.reason,
          ]);
        }
      });
      rowErrorCounts[feed] = (rowErrorCounts[feed] ?? 0)
        + new Set(rowErrors.map((r) => r[2])).size;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await insertMany(
          client,
          'staging.raw_row',
          ['batch_id', 'batch_file_id', 'feed', 'source_row', 'payload'],
          staged,
          1000,
        );
        if (rowErrors.length > 0) {
          await insertMany(
            client,
            'ingest.row_error',
            ['batch_id', 'feed', 'source_row', 'field', 'header', 'raw_value', 'rule_id', 'reason'],
            rowErrors,
            1000,
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
    timings.parsing = (Date.now() - parseStart) / 1000;

    // The per-feed tally, assembled from this run's own numbers rather than
    // re-queried, so what the operator is told is what actually happened.
    rowSummary = prepared.map((p) => {
      const feed = p.cls.feed;
      const withError = feed === null ? 0 : (rowErrorCounts[feed] ?? 0);
      return {
        feed: feed ?? '(unrecognised)',
        filename: p.displayName,
        rowsRead: p.rows.length,
        rowsWithError: withError,
        rowsAccepted: feed === null ? 0 : p.rows.length - withError,
        matched: feed !== null,
      };
    });

    // ── VALIDATING (pre-transform) ──
    await setState('VALIDATING');
    const valStart = Date.now();
    log('validating');
    findings.push(...(await checkStaged(batchId)));
    timings.validating = (Date.now() - valStart) / 1000;

    if (partial) {
      // File level: a file none of whose rows is usable.
      for (const f of [...findings]) {
        if (f.severity === 'BLOCKER' && f.feed !== null && FILE_SCOPED_PRE.has(f.ruleId)) {
          await setAsideFile(f.feed, f.ruleId === 'V-S05'
            ? 'it holds no data rows (usually an export that ran but returned nothing).'
            : `a required column is missing (${((f.measured?.['missing'] as string[] | undefined) ?? []).join(', ')}).`);
        }
      }
      // Row level: GR rows with a movement type nobody has registered. Only
      // those rows leave the load; the rest of the GR file stays.
      const r07 = findings.find((f) => f.ruleId === 'V-R07' && f.severity === 'BLOCKER');
      if (r07 && !setAsideFeeds.has('gr')) {
        const bad = await query<{ source_row: number; mvt: string; po: string | null }>(
          `DELETE FROM staging.raw_row r
            WHERE r.batch_id = $1 AND r.feed = 'gr'
              AND r.payload->>'movementType' IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM core.dim_movement_type m
                               WHERE m.movement_type = r.payload->>'movementType')
           RETURNING r.source_row, r.payload->>'movementType' AS mvt, r.payload->>'poNo' AS po`,
          [batchId],
        );
        await recordSetAsideRows(null, bad.map((b) => ({
          feed: 'gr', sourceRow: b.source_row, field: 'movementType', header: 'Movement type', raw: b.mvt,
          ruleId: 'V-R07',
          reason: `Movement type ${b.mvt} is not registered, so whether it adds or removes received quantity is unknown`
            + `${b.po ? ` (PO ${b.po})` : ''}. Register it, then re-feed this row.`,
        })));
        r07.severity = 'WARNING';
        r07.affectedRows = bad.length;
        r07.message = `Set aside ${bad.length} GR row(s): ${r07.message} The rest of the GR file was loaded; `
          + 'the rows are in the failed folder\'s workbook.';
        const left = await queryOne<{ n: number }>(
          `SELECT count(*)::int AS n FROM staging.raw_row WHERE batch_id = $1 AND feed = 'gr'`, [batchId],
        );
        if ((left?.n ?? 0) === 0) await setAsideFile('gr', 'every row had an unregistered movement type.');
      }
      // Nothing left to load at all is still a failure.
      const accepted = [...foundFeeds].filter((f) => !setAsideFeeds.has(f));
      if (accepted.length === 0) {
        findings.push({
          ruleId: 'V-Q02', severity: 'BLOCKER', feed: null,
          message: 'Every SAP file in this upload was set aside, so there is nothing to load.',
          affectedRows: null, measured: { setAside: [...setAsideFeeds.keys()] }, disablesKpis: [], drillPredicate: null,
        });
      }
    }

    if (findings.some((f) => f.severity === 'BLOCKER')) {
      await persistFindings(batchId, findings);
      const reason = blockerReason(findings);
      await setState('FAILED', reason);
      return { outcome: 'failed', batchId, reason, findings, rowSummary };
    }

    // ── TRANSFORMING ──
    await setState('TRANSFORMING');
    const txStart = Date.now();
    log('transforming');
    const rules: RuleSnapshot = await loadRuleSnapshot();

    const build = () => transaction(async (client) => {
      // Write this upload's records into the store, on top of the version
      // being served (035). Same transaction as the transform: a load that
      // fails anywhere below leaves the store as it was.
      let parentBatchId: number | null = null;
      if (base) {
        const par = await resolveParent(client);
        parentBatchId = par.parentBatchId;
        if (par.bootstrapped) log('merging', `recorded base batch ${parentBatchId}`);
      }
      log('merging');
      const merge = await recordSourceRows(client, batchId, parentBatchId, { setAsideBad: partial });
      // PR Release rows the order guards set aside: filed as failed rows. In
      // this transaction, so a run that fails later records none of them.
      await recordSetAsideRows(client, (merge.prelSetAside ?? []).map((x) => ({
        feed: 'prel', sourceRow: x.sourceRow, field: x.ruleId === 'V-R04' ? 'relSeq' : 'prNo',
        header: x.ruleId === 'V-R04' ? 'Release sequence' : 'Purchase Requisition',
        raw: x.prNo ?? '', ruleId: x.ruleId, reason: x.reason,
      })));

      const tr = await runTransform(client, batchId, rules);
      // The PR Release order guards now run where the continuation rows are
      // filled - when they are stored - and describe THIS upload's file.
      const fill = merge.prelFill;
      tr.metrics.continuationRowsAttached = fill?.continuationRowsAttached ?? 0;
      tr.metrics.continuationOrderViolations = fill?.continuationOrderViolations ?? 0;
      tr.metrics.continuationDuplicateKeys = fill?.continuationDuplicateKeys ?? 0;
      tr.metrics.l2BeforeL1 = fill?.l2BeforeL1 ?? 0;

      findings.push(...mergeFindings(merge, parentBatchId, setAsideFeeds, opts.source.kind === 'manual'));
      if (parentBatchId !== null) findings.push(...(await carriedCaveats(client, parentBatchId, merge)));

      const postFindings = checkMetrics(tr.metrics, rules);
      // Rows the order guards already set aside are not a reason to stop: the
      // rest of the PR Release file is clean and stored.
      const setAsideCount = (rule: string) => (merge.prelSetAside ?? []).filter((x) => x.ruleId === rule).length;
      for (const f of postFindings) {
        if ((f.ruleId === 'V-R04' || f.ruleId === 'V-R04a') && f.severity === 'BLOCKER'
          && !fill?.looksResorted && setAsideCount(f.ruleId) > 0) {
          f.severity = 'WARNING';
          const n = setAsideCount(f.ruleId);
          f.affectedRows = n;
          // Its own words: the guard's message says the export looks
          // re-sorted, which is what it does NOT look like when a few rows
          // could be set aside.
          f.message = (f.ruleId === 'V-R04'
            ? `Set aside ${n} PR Release continuation row(s) that were not directly below a sequence-1 row: `
              + 'their PR cannot be told from the row above, so they were not attached to one.'
            : `Set aside ${n} repeated PR Release step(s) - the same PR, item and sequence as an earlier row, `
              + 'which was kept.')
            + ' The rest of the PR Release file was loaded; the rows are in the failed folder\'s workbook.';
        }
      }
      findings.push(...postFindings);

      if (postFindings.some((f) => f.severity === 'BLOCKER')) {
        throw new BlockerError(blockerReason(postFindings), tr.datasetVersionId, postFindings);
      }

      await buildMart(client, tr.datasetVersionId, tr.asOfDate, rules, disabledKpis(findings));
      return tr;
    });

    // A post-transform blocker that condemns one FILE (a re-sorted PR Release,
    // an unanchored rate file) is retried once without that file. The failed
    // attempt rolled back, so the store is as it was; its findings go too.
    const mark = findings.length;
    let result: Awaited<ReturnType<typeof build>>;
    try {
      result = await build();
    } catch (err) {
      const blockers = err instanceof BlockerError
        ? err.findings.filter((f) => f.severity === 'BLOCKER') : [];
      const retryable = partial && blockers.length > 0
        && blockers.every((f) => f.feed !== null && FILE_SCOPED_POST.has(f.ruleId));
      if (!retryable) throw err;
      findings.length = mark;
      await exec('DELETE FROM ingest.row_error WHERE batch_id = $1 AND rule_id IN (\'V-R04\', \'V-R04a\')', [batchId]);
      for (const f of blockers) {
        await setAsideFile(f.feed!, f.ruleId === 'V-R06a'
          ? 'its month column carries no year that can be anchored (V-R06a). Rates stay as already stored.'
          : `it looks re-sorted - ${f.message}`);
      }
      const accepted = [...foundFeeds].filter((f) => !setAsideFeeds.has(f));
      if (accepted.length === 0) throw new BlockerError('Every SAP file in this upload was set aside, so there is nothing to load.', 0, []);
      log('transforming', `again, without ${[...setAsideFeeds.keys()].join(', ')}`);
      result = await build();
    }
    timings.transforming = (Date.now() - txStart) / 1000;

    // deltas vs the previous published version
    await exec(
      `UPDATE core.dataset_version SET feed_row_deltas = (
          SELECT jsonb_object_agg(k, (v.value)::int - COALESCE((p.feed_row_counts->>k)::int, 0))
            FROM jsonb_each_text(feed_row_counts) AS v(k, value)
            LEFT JOIN (SELECT feed_row_counts FROM core.dataset_version
                        WHERE status = 'PUBLISHED' ORDER BY published_at DESC LIMIT 1) p ON true
        ) WHERE id = $1`,
      [result.datasetVersionId],
    );

    rowSummary = await acceptedRowSummary(batchId, rowSummary);
    await persistFindings(batchId, findings);
    await setState('READY');

    if (opts.autoPublish !== false) {
      log('publishing');
      const pubStart = Date.now();
      await publishVersion(result.datasetVersionId, opts.submittedBy ?? null);
      timings.publishing = (Date.now() - pubStart) / 1000;
      timings.total = (Date.now() - t0) / 1000;
      // A forced re-run reprocesses a byte-identical bundle, and only one batch
      // per bundle hash may hold PUBLISHED (ux_batch_bundle_published). The old
      // batch's version has just been superseded by the pointer swap above, so
      // its state follows.
      await query(
        `UPDATE ingest.batch SET state = 'SUPERSEDED'
          WHERE bundle_hash = $1 AND state = 'PUBLISHED' AND id <> $2`,
        [bHash, batchId],
      );
      await setState('PUBLISHED');
      await pruneOldVersions();
      return {
        outcome: 'published', batchId,
        datasetVersionId: result.datasetVersionId, findings, rowSummary,
      };
    }

    timings.total = (Date.now() - t0) / 1000;
    await setState('READY');
    return {
      outcome: 'ready', batchId,
      datasetVersionId: result.datasetVersionId, findings, rowSummary,
    };
  } catch (err) {
    const reason =
      err instanceof BlockerError ? err.message : err instanceof Error ? err.message : String(err);
    await persistFindings(batchId, findings).catch(() => undefined);
    await setState('FAILED', reason).catch(() => undefined);
    return { outcome: 'failed', batchId, reason, findings, rowSummary };
  }
}

class BlockerError extends Error {
  constructor(
    message: string,
    public readonly versionId: number,
    public readonly findings: readonly Finding[] = [],
  ) {
    super(message);
    this.name = 'BlockerError';
  }
}

/**
 * The per-file tally after partial loading: a set-aside file accepted nothing,
 * and rows set aside inside a file count against it (ingest.row_error).
 */
async function acceptedRowSummary(batchId: number, before: FeedRowSummary[]): Promise<FeedRowSummary[]> {
  const files = await query<{ original_filename: string; rejected_reason: string | null }>(
    `SELECT original_filename, rejected_reason FROM ingest.batch_file WHERE batch_id = $1`, [batchId],
  );
  const bad = await query<{ feed: string; n: number }>(
    `SELECT feed, count(DISTINCT source_row)::int AS n FROM ingest.row_error WHERE batch_id = $1 GROUP BY feed`,
    [batchId],
  );
  const rejected = new Map(files.map((f) => [f.original_filename, f.rejected_reason]));
  const badBy = new Map(bad.map((b) => [b.feed, b.n]));
  return before.map((r) => {
    const why = rejected.get(r.filename) ?? null;
    if (why) return { ...r, rowsWithError: r.rowsRead, rowsAccepted: 0, setAside: why };
    if (!r.matched) return r;
    const withError = badBy.get(r.feed) ?? r.rowsWithError;
    return { ...r, rowsWithError: withError, rowsAccepted: Math.max(0, r.rowsRead - withError) };
  });
}

function blockerReason(findings: readonly Finding[]): string {
  const blockers = findings.filter((f) => f.severity === 'BLOCKER');
  return `${blockers.length} blocker(s): ${blockers.map((b) => `${b.ruleId} ${b.message}`).join(' | ')}`;
}

/** Rule `ingest.merge_enabled`, default ON. OFF restores full-replace loads. */
async function mergeEnabled(): Promise<boolean> {
  const v = (await loadRuleSnapshot())['ingest.merge_enabled'];
  return !(v === false || v === 'false');
}

/** Rule `ingest.partial_load`, default ON. OFF restores all-or-nothing runs. */
async function partialEnabled(): Promise<boolean> {
  const v = (await loadRuleSnapshot())['ingest.partial_load'];
  return !(v === false || v === 'false');
}

/** Blockers that condemn the whole FILE they were raised on, and nothing else. */
const FILE_SCOPED_PRE = new Set(['V-S02', 'V-S05']);
/** Post-transform blockers that condemn one file: retried without it. */
const FILE_SCOPED_POST = new Set(['V-R04', 'V-R04a', 'V-R06a']);

/** Whether the version being served can be built on (see resolveParent). */
async function mergeBaseAvailable(): Promise<boolean> {
  const r = await queryOne<{ ok: boolean }>(
    `SELECT (b.source_recorded OR EXISTS (
               SELECT 1 FROM staging.raw_row s WHERE s.batch_id = b.id)) AS ok
       FROM core.dataset_pointer p
       JOIN core.dataset_version v ON v.id = p.current_version_id
       JOIN ingest.batch b ON b.id = v.batch_id
      WHERE p.id = 1`,
  );
  return r?.ok === true;
}

const FEED_NAMES: Record<MergeFeed, string> = {
  pr: 'PR List', prel: 'PR Release', po: 'PO List', por: 'PO Release', gr: 'GR List',
};

const fmt = (n: number): string => n.toLocaleString('en-US');

/**
 * What the merge did, per feed - the operator's answer to "what did this file
 * change?". INFO for a feed that came with the upload; WARNING for one that did
 * not, because its figures are now as old as the upload that last carried it.
 */
function mergeFindings(
  m: MergeSummary,
  parentBatchId: number | null,
  setAside: ReadonlyMap<Feed, string> = new Map(),
  /**
   * A manual upload (11 Nov 2026). Someone chose which files to send, so a
   * feed it leaves out is a decision, not a missing export: reported as INFO,
   * or uploading one SAP Users file would add five warnings to Data Check.
   * A file it sent that was set aside is still a WARNING.
   */
  manual = false,
): Finding[] {
  const out: Finding[] = [];
  for (const feed of MERGE_FEEDS) {
    const f = m[feed];
    if (f.inFile > 0) {
      const extra = [
        f.replacedSteps > 0 ? `${fmt(f.replacedSteps)} release step(s) no longer listed were replaced` : '',
        f.duplicates > 0 ? `${fmt(f.duplicates)} repeated row(s) ignored` : '',
        f.unkeyed > 0 ? `${fmt(f.unkeyed)} row(s) without a key skipped` : '',
      ].filter((x) => x !== '');
      const tail = extra.length > 0 ? `; ${extra.join('; ')}` : '';
      out.push({
        ruleId: 'V-I02',
        severity: 'INFO',
        feed,
        message: parentBatchId === null
          ? `${FEED_NAMES[feed]}: full load of ${fmt(f.total)} record(s)${tail}.`
          : `${FEED_NAMES[feed]}: ${fmt(f.inFile)} row(s) in the file - ${fmt(f.inserted)} new, `
            + `${fmt(f.updated)} updated, ${fmt(f.unchanged)} unchanged. `
            + `${fmt(f.total)} record(s) in total after the merge${tail}.`,
        affectedRows: f.inserted + f.updated,
        measured: { ...f },
        disablesKpis: [],
        drillPredicate: null,
      });
    } else {
      out.push({
        ruleId: 'V-I03',
        severity: manual && !setAside.has(feed) ? 'INFO' : 'WARNING',
        feed,
        message: (setAside.has(feed)
          ? `The ${FEED_NAMES[feed]} file in this upload was set aside (see V-Q01): its ${fmt(f.total)} record(s) were carried forward `
          : `No ${FEED_NAMES[feed]} file in this upload: its ${fmt(f.total)} record(s) were carried forward `)
          + `unchanged from earlier uploads. Figures that depend on it are as current as the last ${FEED_NAMES[feed]} file.`,
        affectedRows: f.total,
        measured: { ...f },
        disablesKpis: [],
        drillPredicate: null,
      });
    }
  }
  return out;
}

/**
 * Data caveats raised on a feed this upload did not carry. The checks that
 * raise them read the upload's own file, so without this a caveated measure
 * (V-M01's need-by date, for one) would be switched back ON by any upload that
 * happened to omit the file - while the data it was raised on is still the
 * data being shown.
 */
async function carriedCaveats(
  client: import('pg').PoolClient,
  parentBatchId: number,
  m: MergeSummary,
): Promise<Finding[]> {
  const absent = MERGE_FEEDS.filter((f) => m[f].inFile === 0);
  if (absent.length === 0) return [];
  const r = await client.query<{
    rule_id: string; feed: Feed; message: string; affected_rows: number | null;
    measured: Record<string, unknown> | null; disables_kpis: string[];
  }>(
    `SELECT rule_id, feed, message, affected_rows, measured, disables_kpis
       FROM ingest.validation_finding
      WHERE batch_id = $1 AND severity = 'CAVEAT' AND feed = ANY($2)`,
    [parentBatchId, absent],
  );
  return r.rows.map((x) => ({
    ruleId: x.rule_id,
    severity: 'CAVEAT' as const,
    feed: x.feed,
    message: x.message.includes('(carried forward')
      ? x.message
      : `${x.message} (carried forward: this upload had no ${FEED_NAMES[x.feed as MergeFeed] ?? x.feed} file)`,
    affectedRows: x.affected_rows,
    measured: x.measured,
    disablesKpis: x.disables_kpis ?? [],
    drillPredicate: null,
  }));
}

async function persistFindings(batchId: number, findings: readonly Finding[]): Promise<void> {
  await exec('DELETE FROM ingest.validation_finding WHERE batch_id = $1', [batchId]);
  if (findings.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertMany(
      client,
      'ingest.validation_finding',
      ['batch_id', 'rule_id', 'severity', 'feed', 'message', 'affected_rows', 'measured', 'disables_kpis', 'drill_predicate'],
      findings.map((f) => [
        batchId, f.ruleId, f.severity, f.feed, f.message, f.affectedRows,
        f.measured === null ? null : JSON.stringify(f.measured),
        f.disablesKpis,
        f.drillPredicate === null ? null : JSON.stringify(f.drillPredicate),
      ]),
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Atomic: one transaction, one pointer row. */
export async function publishVersion(versionId: number, userId: string | null): Promise<void> {
  await exec('SELECT core.publish_version($1, $2)', [versionId, userId]);
}

export async function pruneOldVersions(): Promise<number> {
  const keep = Number(process.env.DATASET_VERSIONS_RETAINED ?? 12);
  const r = await queryOne<{ n: number }>('SELECT core.prune_versions($1) AS n', [keep]);
  return r?.n ?? 0;
}

export async function getFindings(batchId: number): Promise<Finding[]> {
  const rows = await query<{
    rule_id: string; severity: string; feed: string | null; message: string;
    affected_rows: number | null; measured: Record<string, unknown> | null;
    disables_kpis: string[]; drill_predicate: Record<string, unknown> | null;
  }>(
    `SELECT rule_id, severity, feed, message, affected_rows, measured, disables_kpis, drill_predicate
       FROM ingest.validation_finding WHERE batch_id = $1
      ORDER BY CASE severity WHEN 'BLOCKER' THEN 1 WHEN 'CAVEAT' THEN 2 WHEN 'WARNING' THEN 3 ELSE 4 END, rule_id`,
    [batchId],
  );
  return rows.map((r) => ({
    ruleId: r.rule_id,
    severity: r.severity as Finding['severity'],
    feed: r.feed as Feed | null,
    message: r.message,
    affectedRows: r.affected_rows,
    measured: r.measured,
    disablesKpis: r.disables_kpis ?? [],
    drillPredicate: r.drill_predicate,
  }));
}
