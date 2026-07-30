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
  smembers(k: string): Promise<string[]>;
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
  async smembers(k: string): Promise<string[]> {
    return [...(this.sets.get(k) ?? [])];
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
  async smembers(k: string) {
    return this.c.sMembers(k);
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

  res.cookie(env.SESSION_COOKIE_NAME, sid, {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: env.SESSION_COOKIE_SAMESITE.toLowerCase() as 'lax' | 'strict' | 'none',
    path: '/',
    // No `domain`: a host-only cookie, scoped to the single origin.
  });
  return sid;
}

export async function loadSession(req: Request): Promise<{ sid: string; data: SessionData } | null> {
  const sid = req.cookies?.[env.SESSION_COOKIE_NAME] as string | undefined;
  if (!sid) return null;

  const raw = await store.get(key(sid));
  if (!raw) return null;

  const data = JSON.parse(raw) as SessionData;

  // Idle timeout is enforced here, on read — not by cookie expiry, which the
  // client controls.
  const idleMs = env.SESSION_IDLE_TIMEOUT_MIN * 60_000;
  if (Date.now() - data.lastSeenAt > idleMs) {
    await store.del(key(sid));
    return null;
  }

  data.lastSeenAt = Date.now();
  const remaining = Math.max(
    60,
    Math.floor((data.createdAt + env.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600_000 - Date.now()) / 1000),
  );
  await store.set(key(sid), JSON.stringify(data), remaining);

  return { sid, data };
}

export async function destroySession(res: Response, sid: string): Promise<void> {
  await store.del(key(sid));
  res.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' });
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const sids = await store.smembers(userKey(userId));
  for (const sid of sids) await store.del(key(sid));
  return sids.length;
}

/** Session-binding hash for drill tokens: the id itself never leaves the server. */
export function sessionFingerprint(sid: string): string {
  return createHash('sha256').update(sid).digest('hex').slice(0, 32);
}
