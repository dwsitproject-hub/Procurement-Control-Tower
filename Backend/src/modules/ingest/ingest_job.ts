/**
 * One ingest run as a plain description in and a plain result out (26 Nov
 * 2026), so it can run in a worker thread - see isolated.ts.
 *
 * Why: parsing the six SAP exports and transforming every record is seconds of
 * synchronous work at a time and, on the reference data, 1.8 GB of heap. On the
 * API's own thread that stopped it answering for ten seconds at a stretch, and
 * in production, with more history and the start-up warm-up running alongside,
 * it took the 2 GB heap to its limit: the process sat at 100% CPU in garbage
 * collection with its port open and nothing answered (25 Nov 2026).
 *
 * Everything a caller needs back is in the result - the outcome, the archive
 * summary, the share scan behind "why is a feed missing" - because the source
 * object itself stays in the thread that ran it.
 */

import { runIngest, type IngestOutcome } from './pipeline.js';
import { ManualUploadSource, type DiscoveredFile } from './sources.js';
import { PerFeedShareSource, archiveAfterRun, loadShareConfig, type FeedScan } from './share_poller.js';

export type IngestJob =
  /** The per-feed share folders: the scheduled pickup and "Sync now". */
  | { kind: 'share'; submittedBy?: string | null; force?: boolean }
  /** Rebuild from the stored records under today's rules - no file (27 Nov 2026). */
  | { kind: 'recompute'; submittedBy?: string | null }
  /** Files an operator uploaded, already spooled to disk. */
  | { kind: 'manual'; files: DiscoveredFile[]; submittedBy?: string | null; autoPublish: boolean };

export interface IngestJobResult {
  out: IngestOutcome;
  archive?: Awaited<ReturnType<typeof archiveAfterRun>>;
  lastScan?: FeedScan[];
}

export async function runIngestJob(job: IngestJob): Promise<IngestJobResult> {
  if (job.kind === 'share') {
    const cfg = await loadShareConfig();
    const source = new PerFeedShareSource(cfg);
    const out = await runIngest({
      source, submittedBy: job.submittedBy ?? null, autoPublish: true, force: job.force ?? false,
    });
    const archive = await archiveAfterRun(source, out.outcome, 'batchId' in out ? out.batchId : null, cfg);
    return { out, archive, lastScan: [...source.lastScan] };
  }
  if (job.kind === 'recompute') {
    // An empty source: the files are not read, the store is.
    const out = await runIngest({
      source: new ManualUploadSource([]), submittedBy: job.submittedBy ?? null,
      autoPublish: true, force: true, recompute: true,
    });
    return { out };
  }
  const out = await runIngest({
    source: new ManualUploadSource(job.files),
    submittedBy: job.submittedBy ?? null,
    autoPublish: job.autoPublish,
  });
  return { out };
}
