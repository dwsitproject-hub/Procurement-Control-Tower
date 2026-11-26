/**
 * Event-loop and heap watchdog (26 Nov 2026).
 *
 * The 25 Nov 2026 production wedge left nothing in the log: the process sat in
 * garbage collection at its heap limit, so nobody could tell what it had been
 * doing. This writes one line when the event loop has been blocked for more
 * than two seconds, or the heap passes 85% of its limit, naming the background
 * jobs running at that moment - so the next incident says what caused it.
 *
 * A fully blocked loop cannot log while blocked; the delay histogram keeps the
 * stall, and the line is written the moment the loop runs again. The heap
 * warning comes earlier, on the way up.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import v8 from 'node:v8';

const active = new Map<number, string>();
let seq = 0;

/** Name a background job for as long as it runs (shown in the watchdog's lines). */
export function trackJob<T>(name: string, run: Promise<T>): Promise<T> {
  const id = ++seq;
  active.set(id, name);
  return run.finally(() => active.delete(id));
}

export function activeJobs(): string[] {
  return [...active.values()];
}

const mb = (n: number): number => Math.round(n / 1048576);

let started = false;

export function startWatchdog(log: (msg: string) => void): void {
  if (started) return;
  started = true;
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let lastHeapWarn = 0;
  setInterval(() => {
    const maxMs = delay.max / 1e6;
    delay.reset();
    const h = v8.getHeapStatistics();
    const jobs = activeJobs().join(', ') || 'none';
    const heap = `heap ${mb(h.used_heap_size)}/${mb(h.heap_size_limit)} MB`;
    if (maxMs > 2000) {
      log(`watchdog: event loop blocked up to ${(maxMs / 1000).toFixed(1)} s in the last 10 s (${heap}; running: ${jobs})`);
    }
    if (h.used_heap_size > 0.85 * h.heap_size_limit && Date.now() - lastHeapWarn > 60_000) {
      lastHeapWarn = Date.now();
      log(`watchdog: heap at ${Math.round((h.used_heap_size / h.heap_size_limit) * 100)}% of its limit (${heap}; running: ${jobs})`);
    }
  }, 10_000).unref();
}
