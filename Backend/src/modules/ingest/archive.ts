/**
 * Move source files aside once a run has finished with them.
 *
 * Requested 20 Aug 2026: successfully ingested files go to a `succeed` folder,
 * files that failed go to a `failed` folder, so the pickup folder shows only
 * what is still waiting.
 *
 * Four decisions in here are not obvious, so they are stated rather than left in
 * the code to be re-derived:
 *
 * 1. AN ARCHIVE FAILURE NEVER FAILS THE INGEST. The dataset is already
 *    published and its figures are already correct by the time this runs;
 *    turning "published, but the file could not be moved" into a failed run
 *    would throw away good data over a filesystem permission. Every problem is
 *    collected and reported, and nothing throws.
 *
 * 2. ONLY `published` AND `failed` MOVE ANYTHING. In particular an INCOMPLETE
 *    bundle is left alone, which matters more than it looks: the scheduler picks
 *    up per feed, so a folder legitimately holds a partial set while the rest of
 *    the day's exports arrive. Moving those to `failed` would mean the bundle
 *    could never complete — the PR export would be filed away at 08:00 before
 *    the PO export landed at 09:00.
 *
 * 3. EACH RUN GETS ITS OWN SUBFOLDER, named by date and batch. These filenames
 *    repeat — `Mat group.xlsx` is the same every time — so a flat destination
 *    would overwrite yesterday's file with today's, silently destroying the
 *    lineage this feature exists to preserve.
 *
 * 4. AN UNRECOGNISED FILE GOES TO `failed` EVEN ON A SUCCESSFUL RUN. A file the
 *    pipeline read but whose headers matched no template is exactly the "data
 *    that got failed" worth separating out, even though the run as a whole
 *    succeeded without it.
 *
 *    The boundary is narrower than it sounds, so state it precisely: this covers
 *    only files the pipeline actually READ. A file matching no feed NAME PATTERN
 *    is never listed by the source, so it is never seen here and stays where it
 *    is. That is the right outcome — an unrelated file someone keeps in the
 *    folder is not failed data, and moving it would be this feature reaching
 *    past the exports it is responsible for — but it does mean the pickup folder
 *    is not guaranteed to end up empty.
 */

import { copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { query } from '../../db/client.js';
import { buildErrorWorkbook, errorWorkbookName, loadRowErrors } from './error_report.js';

export interface ArchiveConfig {
  enabled: boolean;
  succeedDir: string;
  failedDir: string;
}

export interface ArchivedFile {
  displayName: string;
  to: 'succeed' | 'failed';
  destination: string;
  moved: boolean;
  error?: string;
}

/** The workbook of unreadable rows, filed next to the failed files. */
export interface RowErrorReport {
  written: boolean;
  path: string;
  /** Distinct source rows, and individual cells, that could not be read. */
  rows: number;
  cells: number;
  error?: string;
}

export interface ArchiveReport {
  attempted: number;
  moved: number;
  failed: number;
  files: ArchivedFile[];
  /** Set when the whole step was skipped, with why. */
  skipped?: string;
  /** Absent when the run had no unreadable rows to report. */
  rowErrors?: RowErrorReport;
}

/** What the pipeline returned, narrowed to what this decision needs. */
export type ArchiveOutcome =
  | 'published' | 'ready' | 'failed' | 'noop_unchanged'
  | 'incomplete_bundle' | 'source_unavailable' | 'locked' | string;

/**
 * Which files the batch recognised, from the database rather than from the
 * caller's memory: ingest.batch_file is what the pipeline actually decided, so
 * a file whose header matched no template is identified here the same way the
 * validation report identifies it.
 */
async function recognisedNames(batchId: number): Promise<Set<string>> {
  const rows = await query<{ original_filename: string; detected_feed: string | null }>(
    `SELECT original_filename, detected_feed FROM ingest.batch_file WHERE batch_id = $1`,
    [batchId],
  );
  return new Set(
    rows.filter((r) => r.detected_feed !== null).map((r) => r.original_filename),
  );
}

/** `2026-08-20_batch61` — sortable, and traceable back to the batch. */
function runFolder(batchId: number | null, at: Date): string {
  const day = at.toISOString().slice(0, 10);
  return batchId === null ? `${day}_norun` : `${day}_batch${batchId}`;
}

/**
 * Move one file, tolerating a destination on a different filesystem.
 *
 * `rename` is one atomic operation and is what should normally happen — source
 * and destination are both on the share. It fails with EXDEV when they are not,
 * and on some CIFS servers for its own reasons, so the fallback copies and then
 * unlinks. The unlink is last: a copy that succeeded and an unlink that failed
 * leaves a duplicate, which is recoverable, whereas the other order can lose
 * the file.
 */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') throw err;
    await copyFile(from, to);
    await unlink(from);
  }
}

export async function archiveBundle(opts: {
  files: { handle: string; displayName: string }[];
  outcome: ArchiveOutcome;
  batchId: number | null;
  cfg: ArchiveConfig;
  at?: Date;
}): Promise<ArchiveReport> {
  const { files, outcome, batchId, cfg } = opts;
  const at = opts.at ?? new Date();
  const empty: ArchiveReport = { attempted: 0, moved: 0, failed: 0, files: [] };

  if (!cfg.enabled) return { ...empty, skipped: 'archiving is switched off' };
  if (files.length === 0) return { ...empty, skipped: 'no source files in this run' };

  // Decision 2: only a definite success or a definite failure moves anything.
  if (outcome !== 'published' && outcome !== 'ready' && outcome !== 'failed') {
    return {
      ...empty,
      skipped: `outcome "${outcome}" leaves the files in place`
        + (outcome === 'incomplete_bundle'
          ? ' so the rest of the bundle can still arrive'
          : ''),
    };
  }

  const recognised = batchId === null ? new Set<string>() : await recognisedNames(batchId);
  const folder = runFolder(batchId, at);
  const out: ArchivedFile[] = [];

  // Created lazily and remembered, so a run that moves nothing to `failed` does
  // not leave an empty folder behind on the share.
  const ensured = new Set<string>();
  const ensure = async (dir: string): Promise<void> => {
    if (ensured.has(dir)) return;
    await mkdir(dir, { recursive: true });
    ensured.add(dir);
  };

  for (const f of files) {
    // Decision 4: on a successful run, only the files the pipeline could not
    // identify are treated as failures.
    const to: 'succeed' | 'failed' =
      outcome === 'failed' ? 'failed'
        : recognised.has(f.displayName) ? 'succeed' : 'failed';

    const dir = join(to === 'succeed' ? cfg.succeedDir : cfg.failedDir, folder);
    // basename, not the supplied name: the destination must never be steered by
    // a path separator arriving in a filename.
    const destination = join(dir, basename(f.displayName));

    try {
      await ensure(dir);
      await moveFile(f.handle, destination);
      out.push({ displayName: f.displayName, to, destination, moved: true });
    } catch (err) {
      // Decision 1: recorded, never thrown.
      out.push({
        displayName: f.displayName,
        to,
        destination,
        moved: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    attempted: out.length,
    moved: out.filter((x) => x.moved).length,
    failed: out.filter((x) => !x.moved).length,
    files: out,
  };
}

/**
 * File the rows that could not be read, as a workbook, into `failed`.
 *
 * The folders are per FILE: a recognised export goes to `succeed` whole, even
 * when some of its rows were unreadable. That left the 11 bad rows of a 65,250
 * row GR export with nowhere to land on the share, which is not what was asked
 * for — the request was that failed DATA end up in the failed folder, and 11
 * rows inside a successful file are exactly that.
 *
 * So the rows are filed as the same workbook the Admin panel offers, in the
 * same dated run folder the files use, and the file itself still goes to
 * `succeed` where it belongs.
 *
 * ONLY THE UNREADABLE ROWS GO IN. The panel's download can also carry a sheet
 * per validation finding, and those are deliberately left out here: a finding
 * flags rows that WERE accepted, so they are not failed data, and selecting
 * them needs a requester's data scope. An unattended run has no requester, and
 * an empty scope fails closed by design, so there is no honest scope to select
 * them under. The full report stays one click away in Admin -> SAP Data Upload,
 * where a real user's scope applies.
 */
export async function fileRowErrors(opts: {
  batchId: number | null;
  outcome: ArchiveOutcome;
  cfg: ArchiveConfig;
  at?: Date;
}): Promise<RowErrorReport | undefined> {
  const { batchId, outcome, cfg } = opts;
  const at = opts.at ?? new Date();

  // The same gates the files pass through, so the two cannot disagree about
  // whether a run was finished with.
  if (!cfg.enabled || batchId === null) return undefined;
  if (outcome !== 'published' && outcome !== 'ready' && outcome !== 'failed') return undefined;

  const rows = await loadRowErrors(batchId);
  if (rows.length === 0) return undefined;

  const book = buildErrorWorkbook(batchId, rows, []);
  if (book === null) return undefined;

  const dir = join(cfg.failedDir, runFolder(batchId, at));
  const path = join(dir, errorWorkbookName(batchId));
  const counts = {
    rows: new Set(rows.map((r) => `${r.feed}#${r.source_row}`)).size,
    cells: rows.length,
  };

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, book);
    return { written: true, path, ...counts };
  } catch (err) {
    // Same rule as moving a file: recorded, never thrown. The dataset is
    // already published and correct.
    return {
      written: false, path, ...counts,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** One line for the run log and the panel. */
export function archiveSummary(r: ArchiveReport): string | undefined {
  const bits: string[] = [];
  if (!r.skipped && r.attempted > 0) {
    bits.push(`archived ${r.moved}/${r.attempted}`);
    const toFailed = r.files.filter((f) => f.moved && f.to === 'failed').length;
    if (toFailed > 0) bits.push(`${toFailed} to failed`);
    if (r.failed > 0) bits.push(`${r.failed} could not be moved`);
  }
  // Mentioned even when no FILE moved: on a clean run this workbook is the only
  // thing in `failed`, so silence here would read as "nothing was filed".
  if (r.rowErrors) {
    bits.push(r.rowErrors.written
      ? `${r.rowErrors.rows} unreadable row(s) reported to failed`
      : `unreadable-row report could not be written (${r.rowErrors.error ?? 'unknown error'})`);
  }
  return bits.length > 0 ? bits.join(', ') : undefined;
}
