/**
 * Worker-thread entry for one ingest run (26 Nov 2026) - see isolated.ts.
 *
 * Its own V8 heap (resourceLimits set by the parent) and its own database pool,
 * closed when the run ends. Running out of memory here ends this thread only;
 * the API keeps serving and reports the failure.
 */

import v8 from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';
import { closePool } from '../../db/client.js';
import { runIngestJob, type IngestJob } from './ingest_job.js';

try {
  const limit = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);
  process.stdout.write(`ingest worker: started (${(workerData as IngestJob).kind}), heap limit ${limit} MB\n`);
  const result = await runIngestJob(workerData as IngestJob);
  parentPort?.postMessage({ ok: true, result });
} catch (e) {
  parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
} finally {
  await closePool().catch(() => undefined);
}
