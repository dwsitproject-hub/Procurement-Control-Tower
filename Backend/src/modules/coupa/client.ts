/**
 * Coupa REST client — TECH_04 §3.2.
 *
 * OAuth2 client-credentials with a cached token (refreshed 5 minutes before
 * expiry, single-flight so concurrent callers share one refresh), Bearer GETs
 * with one automatic retry on 401 (token revoked server-side) and exponential
 * backoff on 429/5xx.
 *
 * Credentials come from env only. Nothing here touches rule_config: an admin
 * can change the schedule at runtime but can never read or write the secret.
 */

import { loadEnv } from '../../config/env.js';

const env = loadEnv();

export function coupaConfigured(): boolean {
  return Boolean(env.COUPA_BASE_URL && env.COUPA_CLIENT_ID && env.COUPA_CLIENT_SECRET);
}

export function coupaHost(): string | null {
  return env.COUPA_BASE_URL ?? null;
}

interface TokenState {
  token: string;
  /** epoch ms after which we refresh (expiry minus a 5-minute margin). */
  refreshAfter: number;
}

let tokenState: TokenState | null = null;
let refreshInFlight: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.COUPA_CLIENT_ID!,
    client_secret: env.COUPA_CLIENT_SECRET!,
    scope: env.COUPA_SCOPES,
  });
  const res = await fetch(`${env.COUPA_BASE_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Coupa token request failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Coupa token response had no access_token');
  tokenState = {
    token: json.access_token,
    refreshAfter: Date.now() + Math.max((json.expires_in ?? 3600) - 300, 60) * 1000,
  };
  return tokenState.token;
}

async function getToken(force = false): Promise<string> {
  if (!force && tokenState && Date.now() < tokenState.refreshAfter) return tokenState.token;
  if (!refreshInFlight) {
    refreshInFlight = fetchToken().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

const MAX_ATTEMPTS = 4;

/**
 * GET a Coupa API path with query params. Retries once with a fresh token on
 * 401 and backs off on 429/5xx. Returns the parsed JSON.
 */
export async function coupaGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  if (!coupaConfigured()) throw new Error('Coupa is not configured (COUPA_BASE_URL / credentials missing)');

  const qs = new URLSearchParams(params).toString();
  const url = `${env.COUPA_BASE_URL}${path}${qs ? `?${qs}` : ''}`;

  let retriedAuth = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const token = await getToken(retriedAuth);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    if (res.status === 401 && !retriedAuth) {
      retriedAuth = true; // token revoked or expired early — refresh once
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const wait = Math.min(2 ** attempt * 1000, 15_000);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Coupa GET ${path} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }
  throw new Error(`Coupa GET ${path}: retries exhausted`);
}

/**
 * One page of an object collection, incrementally: rows whose updated-at is on
 * or after the watermark, in updated_at order so the watermark only moves
 * forward. Coupa pages at 50 by default; both limit and offset are supported
 * (verified against the kpn-test sandbox, 31 Jul 2026).
 */
export async function fetchPage(
  object: string,
  updatedSince: string | null,
  offset: number,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const params: Record<string, string> = {
    limit: String(limit),
    offset: String(offset),
    order_by: 'updated_at',
  };
  if (updatedSince) params['updated-at[gt_or_eq]'] = updatedSince;
  const out = await coupaGet(`/api/${object}`, params);
  if (!Array.isArray(out)) throw new Error(`Coupa ${object}: expected an array page, got ${typeof out}`);
  return out as Record<string, unknown>[];
}
