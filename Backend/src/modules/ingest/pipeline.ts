/**
 * Batch pipeline — PRD §10.
 *
 * DISCOVERED -> SCANNING -> PARSING -> VALIDATING -> TRANSFORMING -> READY -> PUBLISHED
 *
 * A batch is only ever published atomically. On any failure the previously
 * published version keeps serving, untouched — the v1 rule "analysis does not run
 * on a partial bundle", enforced by the database rather than by UI flow.
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
  | { outcome: 'incomplete_bundle'; missing: Feed[] }
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
    return { outcome: 'incomplete_bundle', missing: [...REQUIRED_FEEDS] };
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

  // ── completeness: a partial set does not start a batch ──
  const foundFeeds = new Set(prepared.map((p) => p.cls.feed).filter((f): f is Feed => f !== null));
  const missing = REQUIRED_FEEDS.filter((f) => !foundFeeds.has(f));
  if (missing.length > 0) {
    return { outcome: 'incomplete_bundle', missing };
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
          priorRowCount: p.cls.feed ? (priorCounts[p.cls.feed] ?? null) : null,
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

    const result = await transaction(async (client) => {
      const tr = await runTransform(client, batchId, rules);
      const postFindings = checkMetrics(tr.metrics, rules);
      findings.push(...postFindings);

      if (postFindings.some((f) => f.severity === 'BLOCKER')) {
        throw new BlockerError(blockerReason(postFindings), tr.datasetVersionId);
      }

      await buildMart(client, tr.datasetVersionId, tr.asOfDate, rules, disabledKpis(findings));
      return tr;
    });
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
  constructor(message: string, public readonly versionId: number) {
    super(message);
    this.name = 'BlockerError';
  }
}

function blockerReason(findings: readonly Finding[]): string {
  const blockers = findings.filter((f) => f.severity === 'BLOCKER');
  return `${blockers.length} blocker(s): ${blockers.map((b) => `${b.ruleId} ${b.message}`).join(' | ')}`;
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
