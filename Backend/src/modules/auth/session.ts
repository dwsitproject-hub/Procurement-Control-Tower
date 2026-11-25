/**
 * Sessions — TECH 01 §6.2.6.
 *
 * Server-side sessions; the cookie carries only an opaque id, never claims.
 * Redis is preferred; an in-process fallback keeps local development working if
 * Redis is unavailable (and is refused outright in production, where losing
 * sessions on restart is not acceptable).
 */

import { randomBytes, createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { createClient, type RedisClientType } from 'redis';
import { loadEnv } from '../../config/env.js';

const env = loadEnv();

export interface SessionData {
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  authMethod: 'sso' | 'local';
  flow?: string;
  ip?: string;
  ua?: string;
}

interface Store {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, ttlSeconds: number): Promise<void>;
  del(k: string): Promise<void>;
  sadd(k: string, v: string): Promise<void>;
  srem(k: string, v: string): Promise<void>;
  smembers(k: string): Promise<string[]>;
  expire(k: string, ttlSeconds: number): Promise<void>;
  ping(): Promise<boolean>;
}

class MemoryStore implements Store {
  private readonly map = new Map<string, { v: string; exp: number }>();
  private readonly sets = new Map<string, Set<string>>();

  async get(k: string): Promise<string | null> {
    const e = this.map.get(k);
    if (!e) return null;
    if (e.exp < Date.now()) {
      this.map.delete(k);
      return null;
    }
    return e.v;
  }
  async set(k: string, v: string, ttl: number): Promise<void> {
    this.map.set(k, { v, exp: Date.now() + ttl * 1000 });
  }
  async del(k: string): Promise<void> {
    this.map.delete(k);
  }
  async sadd(k: string, v: string): Promise<void> {
    const s = this.sets.get(k) ?? new Set<string>();
    s.add(v);
    this.sets.set(k, s);
  }
  async srem(k: string, v: string): Promise<void> {
    this.sets.get(k)?.delete(v);
  }
  async smembers(k: string): Promise<string[]> {
    return [...(this.sets.get(k) ?? [])];
  }
  async expire(): Promise<void> {
    // Sets in the development store live as long as the process.
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

class RedisStore implements Store {
  constructor(private readonly c: RedisClientType) {}
  async get(k: string) {
    return this.c.get(k);
  }
  async set(k: string, v: string, ttl: number) {
    await this.c.set(k, v, { EX: ttl });
  }
  async del(k: string) {
    await this.c.del(k);
  }
  async sadd(k: string, v: string) {
    await this.c.sAdd(k, v);
  }
  async srem(k: string, v: string) {
    await this.c.sRem(k, v);
  }
  async smembers(k: string) {
    return this.c.sMembers(k);
  }
  async expire(k: string, ttl: number) {
    await this.c.expire(k, ttl);
  }
  async ping() {
    try {
      await this.c.ping();
      return true;
    } catch {
      return false;
    }
  }
}

let store: Store = new MemoryStore();
let usingRedis = false;

export async function initSessionStore(): Promise<void> {
  if (!env.REDIS_URL) {
    if (env.NODE_ENV === 'production') throw new Error('REDIS_URL is required in production');
    return;
  }
  try {
    const client = createClient({ url: env.REDIS_URL }) as RedisClientType;
    client.on('error', () => undefined); // handled by the ping check
    await client.connect();
    await client.ping();
    store = new RedisStore(client);
    usingRedis = true;
  } catch (err) {
    if (env.NODE_ENV === 'production') {
      throw new Error(`Redis unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Development only: sessions do not survive a restart.
    store = new MemoryStore();
  }
}

export function sessionStoreKind(): 'redis' | 'memory' {
  return usingRedis ? 'redis' : 'memory';
}

export async function sessionStoreHealthy(): Promise<boolean> {
  return store.ping();
}

/**
 * Over HTTPS the cookie gets the __Host- prefix: the browser then refuses it
 * unless it is Secure, host-only and Path=/, so no other app on the same host
 * or a sub-domain can set or overwrite it (security review SEC-S-02/SEC-S-37).
 * Over HTTP the prefix is impossible (it requires Secure), so the configured
 * name is used as is.
 */
const COOKIE = env.SESSION_COOKIE_SECURE && !env.SESSION_COOKIE_NAME.startsWith('__Host-')
  ? `__Host-${env.SESSION_COOKIE_NAME}`
  : env.SESSION_COOKIE_NAME;

const key = (sid: string) => `sess:${sid}`;
const userKey = (userId: string) => `sess:user:${userId}`;

export async function createSession(
  res: Response,
  userId: string,
  meta: Omit<SessionData, 'userId' | 'createdAt' | 'lastSeenAt'>,
): Promise<string> {
  const sid = randomBytes(32).toString('base64url');
  const now = Date.now();
  const data: SessionData = { userId, createdAt: now, lastSeenAt: now, ...meta };

  await store.set(key(sid), JSON.stringify(data), env.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600);
  await store.sadd(userKey(userId), sid);
  // The per-user index lives no longer than the newest session in it.
  await store.expire(userKey(userId), env.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600);

  res.cookie(COOKIE, sid, {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: env.SESSION_COOKIE_SAMESITE.toLowerCase() as 'lax' | 'strict' | 'none',
    path: '/',
    // No `domain`: a host-only cookie, scoped to the single origin.
  });
  return sid;
}

export async function loadSession(req: Request): Promise<{ sid: string; data: SessionData } | null> {
  const sid = req.cookies?.[COOKIE] as string | undefined;
  if (!sid) return null;

  const raw = await store.get(key(sid));
  if (!raw) return null;

  const data = JSON.parse(raw) as SessionData;
  const now = Date.now();

  // Both timeouts are enforced here, on read - not by cookie expiry, which the
  // client controls.
  //
  // Absolute: a session ends SESSION_ABSOLUTE_TIMEOUT_HOURS after sign-in no
  // matter how active it is. This used to re-arm itself for 60 s on every
  // request (Math.max(60, remaining)), so a busy tab kept a session alive for
  // ever (architecture review, 12 Nov 2026).
  const absoluteEnd = data.createdAt + env.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600_000;
  const idleMs = env.SESSION_IDLE_TIMEOUT_MIN * 60_000;
  if (now >= absoluteEnd || now - data.lastSeenAt > idleMs) {
    await store.del(key(sid));
    await store.srem(userKey(data.userId), sid);
    return null;
  }

  // Background requests (the title poller, the dataset-version check) send
  // X-PCT-Background: 1. They may read, but they are not the user being active,
  // so they must not hold an unattended tab's session open.
  if (req.get('x-pct-background') !== '1') {
    data.lastSeenAt = now;
    const remaining = Math.ceil((absoluteEnd - now) / 1000);
    await store.set(key(sid), JSON.stringify(data), remaining);
  }

  return { sid, data };
}

export async function destroySession(res: Response, sid: string, userId?: string): Promise<void> {
  await store.del(key(sid));
  if (userId) await store.srem(userKey(userId), sid);
  res.clearCookie(COOKIE, { path: '/', secure: env.SESSION_COOKIE_SECURE });
}

/**
 * End every session of a user - on a password change or reset, deactivation or
 * a role downgrade, so the change takes effect now rather than when the old
 * sessions happen to expire. `keepSid` spares the caller's own session (a
 * self-service password change keeps you signed in, everywhere else ends).
 */
export async function revokeAllSessions(userId: string, keepSid?: string): Promise<number> {
  const sids = await store.smembers(userKey(userId));
  let n = 0;
  for (const sid of sids) {
    if (sid === keepSid) continue;
    await store.del(key(sid));
    await store.srem(userKey(userId), sid);
    n++;
  }
  return n;
}

/**
 * Short-lived single-use values (the OIDC state/PKCE record) in the session
 * store: bounded by TTL, shared by every API instance, kept across a restart.
 * Replaces an unbounded in-process Map (security review SEC-S-20).
 */
export async function putEphemeral(k: string, v: unknown, ttlSeconds: number): Promise<void> {
  await store.set(`eph:${k}`, JSON.stringify(v), ttlSeconds);
}

export async function takeEphemeral<T>(k: string): Promise<T | null> {
  const raw = await store.get(`eph:${k}`);
  if (raw === null) return null;
  await store.del(`eph:${k}`); // single use
  return JSON.parse(raw) as T;
}

/** Session-binding hash for drill tokens: the id itself never leaves the server. */
export function sessionFingerprint(sid: string): string {
  return createHash('sha256').update(sid).digest('hex').slice(0, 32);
}
