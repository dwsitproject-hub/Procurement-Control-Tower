/**
 * Ingest runs off the API's thread (26 Nov 2026).
 *
 * Production wedge, 25 Nov 2026: about a minute after every start the API
 * stopped answering - 100% CPU, port open, 2.28 GB resident against a 2 GB
 * heap limit, no log line. The scheduled share pickup (a missed slot fires on
 * the first tick after a start) parsed and transformed the SAP exports on the
 * API's own thread; a full ingest takes 1.8 GB of heap and blocks the thread
 * for up to ten seconds at a stretch even on the reference data. With the
 * start-up warm-up alongside, the heap reached its limit and the process spent
 * its time in garbage collection, forever.
 *
 * Every ingest - scheduled pickup, Sync now, manual upload - now runs in a
 * worker thread: its own V8 heap, its own database pool. The API's event loop
 * stays free whatever the ingest does; if the ingest runs out of memory, only
 * the worker ends, its batch is marked failed, and the API reports it and keeps
 * serving. INGEST_IN_WORKER=false runs it in-process as before (an escape
 * hatch, not a recommendation).
 *
 * The worker's heap is as large as the process's (NODE_OPTIONS
 * --max-old-space-size, 2 GB in the image): that V8 flag applies to every
 * isolate and wins over a worker's resourceLimits, measured 26 Nov 2026. The
 * two heaps are separate, so the container can use up to twice that - size
 * mem_limit for it.
 */

import { Worker } from 'node:worker_threads';
import { loadEnv } from '../../config/env.js';
import { exec } from '../../db/client.js';
import { clearResultCache } from '../analytics/cache.js';
import { warmDefaultView } from '../analytics/warm.js';
import { trackJob } from '../ops/watchdog.js';
import type { IngestJob, IngestJobResult } from './ingest_job.js';

const env = loadEnv();

/** The ingest thread failed or ran out of memory; the API itself is fine. */
export class IngestWorkerError extends Error {}

function inWorker(job: IngestJob): Promise<IngestJobResult> {
  // Same extension as this module: .js in the built image, .ts under tsx in
  // development - where the worker must register tsx's loader itself, since a
  // loader registered in the main thread does not reach a worker's imports.
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const entry = new URL(`./ingest_worker${ext}`, import.meta.url);
  const options = { workerData: job };
  const worker = ext === '.js'
    ? new Worker(entry, options)
    // Development (tsx): a tiny bootstrap registers tsx in the worker, honouring
    // the tsconfig tsx was started with, then loads the TypeScript entry.
    : new Worker(
      `import('tsx/esm/api')
         .then(({ register }) => { register({ tsconfig: process.env.TSX_TSCONFIG_PATH }); return import(${JSON.stringify(entry.href)}); })
         .catch((e) => { require('node:worker_threads').parentPort.postMessage({ ok: false, error: String(e) }); });`,
      { ...options, eval: true },
    );
  return new Promise<IngestJobResult>((resolve, reject) => {
    let settled = false;
    worker.once('message', (m: { ok: boolean; result?: IngestJobResult; error?: string }) => {
      settled = true;
      if (m.ok && m.result) resolve(m.result);
      else reject(new Error(m.error ?? 'ingest worker failed'));
    });
    worker.once('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`ingest worker ended with code ${code} before reporting a result`));
    });
  });
}

/**
 * A worker that died mid-run (out of memory) could not mark its own batch: do it
 * here, so the batch list does not show a load "parsing" forever.
 */
async function failStranded(since: Date, reason: string): Promise<void> {
  await exec(
    `UPDATE ingest.batch SET state = 'FAILED', failure_reason = $2, finished_at = now()
      WHERE started_at >= $1 AND state IN ('DISCOVERED','SCANNING','PARSING','VALIDATING','TRANSFORMING')`,
    [since, reason.slice(0, 1000)],
  ).catch(() => undefined);
}

export async function runIngestIsolated(job: IngestJob, label: string): Promise<IngestJobResult> {
  if (!env.INGEST_IN_WORKER) {
    const { runIngestJob } = await import('./ingest_job.js');
    return trackJob(label, runIngestJob(job));
  }
  const since = new Date(Date.now() - 1000);
  let result: IngestJobResult;
  try {
    result = await trackJob(label, inWorker(job));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failStranded(since, `The ingest stopped: ${msg}`);
    throw new IngestWorkerError(
      (e as { code?: string }).code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? 'The load ran out of memory and was stopped; the dashboard is unaffected and still shows the previous data.'
        : `The load stopped: ${msg}`,
    );
  }
  // The worker's own result cache is not the API's: a version it published is
  // made current here, and the default view warmed for it in this thread.
  if (result.out.outcome === 'published') {
    clearResultCache();
    void trackJob('cache warm', warmDefaultView((m) => process.stdout.write(`${m}\n`))).catch(() => undefined);
  }
  return result;
}
