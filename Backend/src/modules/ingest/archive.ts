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

import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { query } from '../../db/client.js';

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

export interface ArchiveReport {
  attempted: number;
  moved: number;
  failed: number;
  files: ArchivedFile[];
  /** Set when the whole step was skipped, with why. */
  skipped?: string;
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

/** One line for the run log and the panel. */
export function archiveSummary(r: ArchiveReport): string | undefined {
  if (r.skipped) return undefined;
  if (r.attempted === 0) return undefined;
  const bits = [`archived ${r.moved}/${r.attempted}`];
  const toFailed = r.files.filter((f) => f.moved && f.to === 'failed').length;
  if (toFailed > 0) bits.push(`${toFailed} to failed`);
  if (r.failed > 0) bits.push(`${r.failed} could not be moved`);
  return bits.join(', ');
}
