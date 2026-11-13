/**
 * Cross-cutting HTTP guards (security review, 12-13 Nov 2026).
 *
 *   requestIdGuard   - a well-formed request id on every request, set BEFORE body
 *                      parsing so even a malformed-JSON 400 carries one (SEC-S-29)
 *   apiNoStore       - API responses are never cached by browsers or proxies (SEC-S-32)
 *   sameOriginWrites - a state-changing request from a page on another origin is
 *                      refused (SEC-S-08). SameSite=Lax alone does not stop pages on
 *                      the same host or site - every other app on 172.28.80.50 is
 *                      "same-site" to PCT.
 *   rateLimit        - fixed-window limiter for the endpoints worth guessing at
 *                      (SEC-S-13). In-process: PCT runs one API instance; a second
 *                      instance would need the session store's Redis instead.
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

export function requestIdGuard() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const given = req.get('x-request-id');
    req.requestId = given && /^[A-Za-z0-9-]{8,64}$/.test(given) ? given : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  };
}

export function apiNoStore() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

/**
 * The origins a browser may legitimately send from: APP_BASE_URL, plus the
 * exact host:port the request was addressed to (nginx forwards it as
 * X-Forwarded-Host = $http_host). Without that header (an older proxy config)
 * the host name alone is compared, so the deployment keeps working.
 */
function allowed(req: Request, origin: string): boolean {
  const base = originOf(env.APP_BASE_URL);
  if (base && origin === base) return true;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const fwdHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (fwdHost) return o.host.toLowerCase() === fwdHost.toLowerCase();
  const host = (req.get('host') ?? '').toLowerCase();
  return o.host.toLowerCase() === host || o.hostname.toLowerCase() === host.split(':')[0];
}

export function sameOriginWrites() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE.has(req.method)) return next();
    const origin = req.get('origin');
    const site = req.get('sec-fetch-site');
    // Browsers send Origin on every cross-origin write and Sec-Fetch-Site on all
    // requests. A request with neither is not from a browser page (curl, the
    // CLI, a server) and carries no ambient-cookie risk.
    const bad =
      (origin !== undefined && origin !== 'null' && !allowed(req, origin))
      || origin === 'null'
      || (origin === undefined && site !== undefined && site !== 'same-origin' && site !== 'none');
    if (!bad) return next();
    res.status(403).type('application/problem+json').json({
      type: '/problems/cross-origin-refused',
      title: 'Request refused: it came from another site',
      status: 403,
      requestId: req.requestId,
    });
  };
}

interface Bucket { n: number; reset: number }

export function rateLimit(opts: { windowMs: number; max: number; name: string; key?: (req: Request) => string }) {
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    if (now - lastSweep > opts.windowMs) {
      for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
      lastSweep = now;
    }
    const k = (opts.key ?? ((r: Request) => r.ip ?? 'unknown'))(req);
    let b = buckets.get(k);
    if (!b || b.reset <= now) {
      b = { n: 0, reset: now + opts.windowMs };
      buckets.set(k, b);
    }
    b.n++;
    if (b.n > opts.max) {
      const retry = Math.ceil((b.reset - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      res.status(429).type('application/problem+json').json({
        type: '/problems/rate-limited',
        title: 'Too many requests - please wait and try again',
        status: 429,
        detail: `Limit for ${opts.name}: ${opts.max} per ${Math.round(opts.windowMs / 1000)} s. Retry in ${retry} s.`,
        requestId: req.requestId,
      });
      return;
    }
    next();
  };
}

/**
 * A query-string integer, clamped. Number('abc') is NaN and Number('-5') is -5;
 * both used to reach LIMIT/OFFSET and surface as a 500 (security review
 * SEC-S-26). Anything that is not a finite number falls back to the default.
 */
export function qint(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
