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
  /** Which pickup slots fired, e.g. "pr@06:00 po@06:00". */
  slots?: string;
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
  lines.push('');

  if (input.outcome === 'noop_unchanged') {
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

  const subject = input.outcome === 'noop_unchanged'
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
  lines.push('');

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
