/**
 * Data Hub Management (DHM) REST client - Docs/CLIENT_INTEGRATION.md.
 *
 * PCT is a read-only consumer (pattern C, local replica): it never posts to
 * /v1/inbound, and never uses the legacy /v1/ingest.
 *
 * Auth is the application key pair exchanged for a bearer token (guide §4B),
 * cached and refreshed ten minutes before it expires, single-flight so
 * concurrent callers share one refresh; a 401 on a call drops the token and
 * retries once. 429 honours Retry-After, 5xx backs off exponentially, and
 * every call times out at 10 s (guide §13). Errors carry DHM's `code`, which
 * callers branch on rather than the message (guide §11).
 *
 * Credentials come from env only; the private key is sent to /auth/token and
 * nowhere else, and never logged.
 */

import { loadEnv } from '../../config/env.js';

const env = loadEnv();
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 4;

export function dhmConfigured(): boolean {
  return Boolean(env.DHM_BASE_URL && env.DHM_PUBLIC_KEY && env.DHM_PRIVATE_KEY);
}

export function dhmHost(): string | null {
  return env.DHM_BASE_URL ?? null;
}

/** A DHM error, with its machine `code` (UNAUTHENTICATED, NOT_PERMITTED...). */
export class DhmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

const base = (): string => env.DHM_BASE_URL!.replace(/\/+$/, '');

let token: { value: string; refreshAfter: number } | null = null;
let refreshing: Promise<string> | null = null;

/** "8h" / "30m" / "3600s" / 3600 -> milliseconds; unknown -> 1 hour. */
function ttlMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v * 1000;
  const m = /^(\d+)\s*([smhd])?$/.exec(String(v ?? '').trim());
  if (!m) return 3_600_000;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? 's') as 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    // Node's fetch says only "fetch failed"; the reason (ENOTFOUND = the name
    // does not resolve here, ECONNREFUSED, ETIMEDOUT, EHOSTUNREACH...) is on
    // `cause`, and it is the part an operator can act on.
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const why = cause?.code ? `${cause.code}${cause.message ? ` (${cause.message})` : ''}` : (e as Error).message;
    const msg = (e as Error).name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000}s` : why;
    throw new DhmError(`Data Hub unreachable at ${new URL(url).host}: ${msg}`, 0, 'UNAVAILABLE');
  } finally {
    clearTimeout(t);
  }
}

async function errorOf(res: Response): Promise<DhmError> {
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
  const code = typeof body['code'] === 'string' ? body['code'] : null;
  const msg = typeof body['error'] === 'string' ? body['error'] : res.statusText;
  return new DhmError(`Data Hub ${res.status}${code ? ` ${code}` : ''}: ${msg}`, res.status, code);
}

async function fetchToken(): Promise<string> {
  const res = await timedFetch(`${base()}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ publicKey: env.DHM_PUBLIC_KEY, privateKey: env.DHM_PRIVATE_KEY }),
  });
  if (!res.ok) throw await errorOf(res);
  const j = (await res.json()) as { token?: string; expiresIn?: unknown };
  if (!j.token) throw new DhmError('Data Hub issued no token', res.status, null);
  // Refresh ten minutes early, but never sooner than half the lifetime.
  const life = ttlMs(j.expiresIn);
  token = { value: j.token, refreshAfter: Date.now() + Math.max(life - 600_000, life / 2) };
  return j.token;
}

async function bearer(): Promise<string> {
  if (token && Date.now() < token.refreshAfter) return token.value;
  if (!refreshing) refreshing = fetchToken().finally(() => { refreshing = null; });
  return refreshing;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a DHM path (e.g. '/v1/catalog/exchange_rate') and parse the JSON. */
export async function dhmGet<T>(path: string): Promise<T> {
  if (!dhmConfigured()) throw new DhmError('Data Hub is not configured', 0, 'NOT_CONFIGURED');
  let retried401 = false;
  for (let attempt = 1; ; attempt += 1) {
    const res = await timedFetch(`${base()}${path}`, {
      headers: { Authorization: `Bearer ${await bearer()}`, Accept: 'application/json' },
    });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 401 && !retried401) {
      // Revoked or expired early: one fresh token, one retry.
      retried401 = true;
      token = null;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    throw await errorOf(res);
  }
}
