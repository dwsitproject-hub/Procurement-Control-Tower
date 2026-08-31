/**
 * Notification bodies.
 *
 * Deliberately plain text: these land in mail clients on phones, and a table of
 * numbers reads better than styled HTML that half of them will mangle.
 *
 * An honesty note that shapes the "new vs updated" wording: a publish is a full
 * immutable snapshot, not a row-by-row merge — the pipeline never updates a
 * fact in place. So the meaningful figures are the rows in this load and the
 * CHANGE against the previous published version, and that is what these
 * messages report. Calling a row-count delta "updated records" would be a
 * pleasing lie.
 */

import { queryOne, query } from '../../db/client.js';
import { nowInZone, SYNC_TIMEZONE } from '../ingest/share_poller.js';

const FEED_LABEL: Record<string, string> = {
  pr: 'PR Report', po: 'PO Report', gr: 'GR List',
  prel: 'PR Release', por: 'PO Release', fx: 'Rate Conversion',
};

function num(n: unknown): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString('en-GB') : '0';
}

function signed(n: unknown): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v === 0) return 'no change';
  return v > 0 ? `+${v.toLocaleString('en-GB')}` : v.toLocaleString('en-GB');
}

function stamp(): string {
  const z = nowInZone();
  return `${z.date} ${z.hhmm} ${SYNC_TIMEZONE}`;
}

export interface IngestNotifyInput {
  trigger: 'scheduled' | 'manual';
  outcome: string;
  datasetVersionId?: number;
  batchId?: number;
  detail?: string;
  /** archiveSummary() — what the after-run filing moved, if it is switched on. */
  archive?: string;
  /** Which pickup slots fired, e.g. "pr@06:00 po@06:00". */
  slots?: string;
}

/**
 * Per-file rows read, accepted and unreadable — the same table in the success
 * and the failure email, because the question "how much of my data made it" is
 * the same question either way.
 *
 * Read from ingest.batch_file and ingest.row_error rather than passed in, so the
 * email cannot disagree with what the batch actually recorded, and so a mail
 * resent later still tells the truth.
 *
 * "Unreadable" counts ROWS, not cells: two bad columns in one row is one row an
 * operator has to go and fix, and reporting 2 would overstate it. A row is still
 * accepted with an unreadable optional cell — it is staged and it contributes —
 * so `accepted` is deliberately not "rows that were perfect".
 */
async function perFeedRowLines(batchId: number | undefined): Promise<string[]> {
  if (!batchId) return [];
  const rows = await query<{
    detected_feed: string | null; original_filename: string;
    row_count: number | null; bad_rows: number;
  }>(
    `SELECT f.detected_feed, f.original_filename, f.row_count,
            COALESCE(e.bad_rows, 0)::int AS bad_rows
       FROM ingest.batch_file f
       LEFT JOIN (
         SELECT feed, count(DISTINCT source_row)::int AS bad_rows
           FROM ingest.row_error WHERE batch_id = $1 GROUP BY feed
       ) e ON e.feed = f.detected_feed
      WHERE f.batch_id = $1
      ORDER BY f.detected_feed NULLS LAST, f.original_filename`,
    [batchId],
  );
  if (rows.length === 0) return [];

  const lines: string[] = [];
  lines.push('Rows in each file — read, accepted, and could not be read:');
  lines.push('');
  lines.push('  FILE                          FEED    READ      ACCEPTED  UNREADABLE');
  let totalRead = 0; let totalBad = 0;
  for (const r of rows) {
    const read = r.row_count ?? 0;
    const bad = r.detected_feed === null ? read : r.bad_rows;
    const acc = read - bad;
    totalRead += read; totalBad += bad;
    const name = r.original_filename.length > 28
      ? `${r.original_filename.slice(0, 25)}...`
      : r.original_filename.padEnd(28);
    const feed = (r.detected_feed ?? 'NONE').padEnd(6);
    lines.push(`  ${name}  ${feed}  ${String(read).padStart(8)}  ${String(acc).padStart(8)}  ${String(bad).padStart(10)}`);
  }
  lines.push('');
  lines.push(`  TOTAL: ${totalRead.toLocaleString('en-GB')} rows read, `
    + `${(totalRead - totalBad).toLocaleString('en-GB')} accepted, `
    + `${totalBad.toLocaleString('en-GB')} could not be read.`);
  if (totalBad > 0) {
    lines.push('');
    lines.push('  A file with feed NONE matched no template and was skipped whole — its');
    lines.push('  rows are counted as unreadable because none of them were used.');
    lines.push('');
    lines.push('  The offending rows are downloadable as a workbook, with the value that');
    lines.push('  could not be read and the reason, from Admin -> SAP Data Upload. With');
    lines.push('  after-run filing switched on, the same workbook is also written into the');
    lines.push('  failed folder on the share, in the dated subfolder for that run.');
  }
  lines.push('');
  return lines;
}

/** SUCCESS: what landed, and how it differs from the previous version. */
export async function ingestSuccessBody(input: IngestNotifyInput): Promise<{ subject: string; body: string }> {
  const v = input.datasetVersionId
    ? await queryOne<{
        id: number; as_of_date: string; published_at: string;
        feed_row_counts: Record<string, number>;
        feed_row_deltas: Record<string, number> | null;
        metrics: Record<string, unknown>;
      }>(
        `SELECT id, as_of_date::text, published_at::text, feed_row_counts, feed_row_deltas, metrics
           FROM core.dataset_version WHERE id = $1`,
        [input.datasetVersionId],
      )
    : null;

  const findings = input.batchId
    ? await query<{ severity: string; n: number }>(
        `SELECT severity, count(*)::int AS n FROM ingest.validation_finding
          WHERE batch_id = $1 GROUP BY severity ORDER BY severity`,
        [input.batchId],
      )
    : [];

  const lines: string[] = [];
  lines.push(`SAP data sync completed — ${input.outcome}`);
  lines.push('');
  lines.push(`When:     ${stamp()}`);
  lines.push(`Trigger:  ${input.trigger}${input.slots ? ` (${input.slots})` : ''}`);
  if (v) {
    lines.push(`Version:  ${v.id}   (data as of ${v.as_of_date})`);
  }
  // Where the exports went afterwards. Worth a line of its own: this used to
  // travel inside `detail`, which the success body never printed, so a run that
  // filed its files said nothing about having done so.
  if (input.archive) lines.push(`Filed:    ${input.archive}`);
  lines.push('');

  // What each file contributed. Emitted unconditionally, NOT inside the
  // has-a-version branch: "how much of my data arrived" is the first question
  // whatever the outcome, and gating it on the version lookup meant it silently
  // disappeared whenever that lookup returned nothing.
  lines.push(...await perFeedRowLines(input.batchId));

  if (input.outcome === 'awaiting_exports') {
    lines.push('The pickup folder is empty because a previous run FILED ITS FILES AWAY');
    lines.push('after publishing them, and the next exports have not landed yet. Nothing');
    lines.push('is wrong and nothing needed doing.');
    lines.push('');
    lines.push('This used to be reported as a failed run with every file missing, which');
    lines.push('is what the after-run filing feature does on purpose. If the exports stop');
    lines.push('arriving for longer than the grace period, it becomes a failure notice');
    lines.push('again, so a real outage is still reported.');
  } else if (input.outcome === 'noop_unchanged') {
    lines.push('The share folders held the same files as the last publish, so no new');
    lines.push('dataset version was created. This is the normal result between exports.');
  } else if (v) {
    lines.push('Rows loaded per file (change vs the previous published version):');
    lines.push('');
    const counts = v.feed_row_counts ?? {};
    const deltas = v.feed_row_deltas ?? {};
    for (const feed of ['pr', 'po', 'gr', 'prel', 'por', 'fx']) {
      if (!(feed in counts)) continue;
      const label = (FEED_LABEL[feed] ?? feed).padEnd(16);
      lines.push(`  ${label}${num(counts[feed]).padStart(9)} rows   ${signed(deltas[feed])}`);
    }
    const total = Object.values(counts).reduce((a, b) => a + Number(b ?? 0), 0);
    lines.push(`  ${'TOTAL'.padEnd(16)}${num(total).padStart(9)} rows`);
    lines.push('');

    const m = v.metrics ?? {};
    lines.push('Business records built from that load:');
    lines.push(`  PR items                ${num(m['prItems'])}`);
    lines.push(`  PO lines                ${num(m['poLines'])}`);
    lines.push(`  GR postings             ${num(m['grPostings'])}`);
    lines.push(`  PR items with a PO      ${num(m['prItemsWithPo'])}`);
    lines.push(`  Direct POs (no PR)      ${num(m['directPoLines'])}`);
    lines.push('');
    lines.push('Each publish is a complete immutable snapshot — facts are never updated');
    lines.push('in place — so the figures above are "rows in this load" and the change');
    lines.push('against the previous version, not an insert/update tally.');
  }

  if (findings.length > 0) {
    lines.push('');
    lines.push('Data-quality findings on this batch:');
    for (const f of findings) lines.push(`  ${f.severity.padEnd(8)} ${num(f.n)}`);
    lines.push('');
    lines.push('WARNING and CAVEAT are known characteristics of the SAP export, not');
    lines.push('errors — the publish succeeded. Only BLOCKER stops a batch.');
  }

  const subject = input.outcome === 'awaiting_exports'
    ? `[PCT] SAP sync: waiting for the next exports (${stamp()})`
    : input.outcome === 'noop_unchanged'
      ? `[PCT] SAP sync: no changes (${stamp()})`
      : `[PCT] SAP sync OK: version ${v?.id ?? '?'} published (${stamp()})`;

  return { subject, body: lines.join('\n') };
}

/** FAILURE: what worked, what did not, and exactly why. */
export async function ingestFailureBody(input: IngestNotifyInput): Promise<{ subject: string; body: string }> {
  const lines: string[] = [];
  lines.push(`SAP data sync FAILED — ${input.outcome}`);
  lines.push('');
  lines.push(`When:     ${stamp()}`);
  lines.push(`Trigger:  ${input.trigger}${input.slots ? ` (${input.slots})` : ''}`);
  if (input.batchId) lines.push(`Batch:    ${input.batchId}`);
  if (input.archive) lines.push(`Filed:    ${input.archive}`);
  lines.push('');

  // The read/accepted/unreadable table first: on a failure the first question is
  // still how much of the data was usable, and the per-file classification
  // detail below answers the second one.
  lines.push(...await perFeedRowLines(input.batchId));

  // Per-file outcome: what was read, classified and parsed vs what was not.
  const files = input.batchId
    ? await query<{
        original_filename: string; detected_feed: string | null;
        match_outcome: string | null; row_count: number | null;
      }>(
        `SELECT original_filename, detected_feed, match_outcome, row_count
           FROM ingest.batch_file WHERE batch_id = $1 ORDER BY original_filename`,
        [input.batchId],
      )
    : [];

  if (input.outcome === 'incomplete_bundle') {
    const missing = (input.detail ?? '').replace(/^missing /, '');
    lines.push('A dataset is published complete or not at all, and these files were');
    lines.push('missing from the share folders, so nothing was published:');
    lines.push('');
    for (const feed of missing.split(',').map((x) => x.trim()).filter(Boolean)) {
      lines.push(`  MISSING   ${FEED_LABEL[feed] ?? feed}  (${feed})`);
    }
    lines.push('');
    lines.push('Check the folder and file-name pattern for each of those files in');
    lines.push('Admin -> SAP Data Upload -> SAP Data Sync, then press "Test / preview');
    lines.push('folders" to see what the scheduler can actually see.');
  } else if (input.outcome === 'source_unavailable') {
    lines.push('A configured share folder could not be read, so the run was abandoned');
    lines.push('rather than treated as "no new data":');
    lines.push('');
    lines.push(`  UNREADABLE  ${input.detail ?? '(path not reported)'}`);
    lines.push('');
    lines.push('Usually the mount is gone or its permissions changed. The dashboard');
    lines.push('keeps serving the last published version until this is fixed.');
  } else {
    lines.push(`Reason:   ${input.detail ?? 'not reported'}`);
  }

  if (files.length > 0) {
    const ok = files.filter((f) => f.match_outcome === 'exact' || f.match_outcome === 'mapped');
    const bad = files.filter((f) => !(f.match_outcome === 'exact' || f.match_outcome === 'mapped'));
    lines.push('');
    lines.push(`Files read: ${files.length}   accepted: ${ok.length}   rejected: ${bad.length}`);
    lines.push('');
    for (const f of files) {
      const state = f.match_outcome === 'exact' || f.match_outcome === 'mapped' ? 'OK     ' : 'REJECT ';
      lines.push(
        `  ${state}${f.original_filename}` +
        `\n           feed=${f.detected_feed ?? 'unrecognised'}` +
        ` match=${f.match_outcome ?? 'none'} rows=${num(f.row_count)}`,
      );
    }
  }

  // Blocking findings carry the actual reason a batch was stopped.
  const blockers = input.batchId
    ? await query<{ rule_id: string; feed: string | null; message: string; affected_rows: number | null }>(
        `SELECT rule_id, feed, message, affected_rows FROM ingest.validation_finding
          WHERE batch_id = $1 AND severity = 'BLOCKER' ORDER BY rule_id`,
        [input.batchId],
      )
    : [];

  if (blockers.length > 0) {
    lines.push('');
    lines.push(`Blocking findings (${blockers.length}):`);
    for (const b of blockers) {
      lines.push('');
      lines.push(`  ${b.rule_id}${b.feed ? ` [${b.feed}]` : ''}  rows: ${num(b.affected_rows)}`);
      lines.push(`    ${b.message}`);
    }
  }

  lines.push('');
  lines.push('The previously published dataset is untouched and the dashboard still');
  lines.push('serves it — a failed run never replaces good data with bad.');

  return { subject: `[PCT] SAP sync FAILED: ${input.outcome} (${stamp()})`, body: lines.join('\n') };
}

export interface CoupaObjectResult {
  object: string;
  status: 'ok' | 'error' | 'skipped';
  rowsUpserted: number;
  error?: string;
}

/** COUPA: only sent when something failed, per the request. */
export function coupaErrorBody(
  trigger: string,
  objects: CoupaObjectResult[],
): { subject: string; body: string } {
  const ok = objects.filter((o) => o.status === 'ok');
  const failed = objects.filter((o) => o.status === 'error');
  const skipped = objects.filter((o) => o.status === 'skipped');

  const lines: string[] = [];
  lines.push('Coupa sync reported errors');
  lines.push('');
  lines.push(`When:     ${stamp()}`);
  lines.push(`Trigger:  ${trigger}`);
  lines.push('');
  lines.push(`Objects:  ${objects.length}   succeeded: ${ok.length}   failed: ${failed.length}` +
    (skipped.length > 0 ? `   skipped: ${skipped.length}` : ''));
  lines.push('');

  if (ok.length > 0) {
    lines.push('Succeeded:');
    for (const o of ok) lines.push(`  OK      ${o.object.padEnd(24)}${num(o.rowsUpserted).padStart(8)} rows`);
    lines.push('');
  }

  lines.push('Failed:');
  for (const o of failed) {
    lines.push('');
    lines.push(`  FAILED  ${o.object}`);
    lines.push(`    ${o.error ?? 'no error message reported'}`);
  }

  lines.push('');
  lines.push('Coupa data is incremental: each object resumes from its own watermark,');
  lines.push('so a failed object retries on the next scheduled pass and nothing is');
  lines.push('lost. The SAP dataset and its published figures are unaffected.');

  return {
    subject: `[PCT] Coupa sync errors: ${failed.length} of ${objects.length} objects (${stamp()})`,
    body: lines.join('\n'),
  };
}

export function testBody(): { subject: string; body: string } {
  return {
    subject: `[PCT] Test notification (${stamp()})`,
    body: [
      'This is a test message from the Procurement Control Tower.',
      '',
      `Sent:  ${stamp()}`,
      '',
      'If you received it, SMTP delivery and the recipient list are working.',
      'Scheduled-run notifications will arrive at this address.',
    ].join('\n'),
  };
}
