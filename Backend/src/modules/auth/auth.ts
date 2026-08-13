/**
 * Authentication — local accounts and the DWS Hub OIDC skeleton.
 *
 * Local auth is the login path in local development because the Hub is
 * unreachable from a laptop. The OIDC implementation is present and follows the
 * Hub integration contract (public client, PKCE S256, JSON token body, both
 * SP- and IdP-initiated flows); it activates only when all three OIDC_* variables
 * are configured, so a partial config can never produce a half-working login.
 */

import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Role } from '@pct/contracts';
import { exec, query, queryOne } from '../../db/client.js';
import { isOidcConfigured, loadEnv } from '../../config/env.js';
import { recordAudit } from '../audit/audit.js';
import { createSession } from './session.js';

const env = loadEnv();

export interface Principal {
  userId: string;
  email: string;
  displayName: string;
  authMethod: 'sso' | 'local';
  roles: Role[];
  department: string | null;
  jobRole: string | null;
  /** Admin-issued default password not yet rotated (011). */
  mustChangePassword: boolean;
}

export async function loadPrincipal(userId: string): Promise<Principal | null> {
  const u = await queryOne<{
    id: string; email: string; display_name: string; auth_method: 'sso' | 'local'; is_active: boolean;
    department: string | null; job_role: string | null; must_change_password: boolean;
  }>(
    `SELECT id, email, display_name, auth_method, is_active,
            department, job_role, must_change_password
       FROM app.app_user WHERE id = $1`,
    [userId],
  );
  if (!u || !u.is_active) return null;

  const roles = await query<{ role_code: Role }>(
    `SELECT role_code FROM app.user_role WHERE user_id = $1`,
    [userId],
  );
  return {
    userId: u.id,
    email: u.email,
    displayName: u.display_name,
    authMethod: u.auth_method,
    roles: roles.map((r) => r.role_code),
    department: u.department,
    jobRole: u.job_role,
    mustChangePassword: u.must_change_password,
  };
}

/**
 * Rotate a local password. Used by the forced first-login change (011) and by
 * any user changing their own; verifies the current password first, then clears
 * the must-change flag. Sessions are left alone: the caller stays signed in.
 */
export async function changeLocalPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < 12) {
    throw new AuthError('invalid-credentials', 'The new password must be at least 12 characters.');
  }
  if (newPassword === currentPassword) {
    throw new AuthError('invalid-credentials', 'The new password must differ from the current one.');
  }
  const cred = await queryOne<{ password_hash: string }>(
    `SELECT password_hash FROM app.local_credential WHERE user_id = $1`,
    [userId],
  );
  if (!cred) throw new AuthError('invalid-credentials', 'This account has no local password.');
  if (!(await argon2.verify(cred.password_hash, currentPassword))) {
    throw new AuthError('invalid-credentials', 'The current password is incorrect.');
  }
  const hash = await argon2.hash(newPassword, {
    type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1,
  });
  await exec(
    `UPDATE app.local_credential SET password_hash = $2, password_set_at = now(),
            failed_attempts = 0, locked_until = NULL
      WHERE user_id = $1`,
    [userId, hash],
  );
  await exec(`UPDATE app.app_user SET must_change_password = false WHERE id = $1`, [userId]);
}

// ─────────────────────────────────────────────────────────── local accounts

export class AuthError extends Error {
  constructor(
    public readonly code: 'invalid-credentials' | 'account-locked' | 'mfa-required' | 'disabled',
    message: string,
  ) {
    super(message);
  }
}

export async function localLogin(
  email: string,
  password: string,
  req: Request,
  res: Response,
): Promise<Principal> {
  if (!env.LOCAL_AUTH_ENABLED) throw new AuthError('disabled', 'local authentication is disabled');

  const row = await queryOne<{
    id: string; email: string; display_name: string; is_active: boolean;
    password_hash: string | null; failed_attempts: number; locked_until: string | null;
    mfa_enabled: boolean; expires_at: string | null;
  }>(
    `SELECT u.id, u.email, u.display_name, u.is_active,
            c.password_hash, c.failed_attempts, c.locked_until, c.mfa_enabled, c.expires_at
       FROM app.app_user u
       LEFT JOIN app.local_credential c ON c.user_id = u.id
      WHERE u.email = $1 AND u.auth_method = 'local'`,
    [email.trim().toLowerCase()],
  );

  // Timing-safe-ish: always run a hash comparison so an unknown user costs the
  // same as a wrong password, and return an identical message either way.
  const hash = row?.password_hash ?? '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  let valid = false;
  try {
    valid = await argon2.verify(hash, password);
  } catch {
    valid = false;
  }

  if (row?.locked_until && new Date(row.locked_until) > new Date()) {
    await recordAudit({
      action: 'auth.login', actorEmail: email, outcome: 'denied',
      detail: { method: 'local', reason: 'locked' }, ip: req.ip,
    });
    throw new AuthError('account-locked', 'account is temporarily locked');
  }

  /**
   * A correct password on a disabled account is NOT a credential failure, and
   * saying "invalid email or password" for it sends the user to reset a
   * password that was never the problem — exactly what happened after an admin
   * reset the password of a deactivated account and the sign-in kept refusing
   * it.
   *
   * Disclosing the real reason is safe HERE and only here: the caller has
   * already proven they hold the credential, so naming the account state tells
   * them nothing they could not confirm anyway. Wrong password and unknown user
   * keep the single uniform message below, which is what stops enumeration.
   *
   * No failed-attempt is recorded either: the credential was right, and locking
   * a disabled account out of a lockout counter helps nobody.
   */
  if (row && valid && !row.is_active) {
    await recordAudit({
      action: 'auth.login', actorUserId: row.id, actorEmail: email, outcome: 'denied',
      detail: { method: 'local', reason: 'account-disabled' }, ip: req.ip,
    });
    throw new AuthError('disabled', 'this account is disabled — ask an administrator to re-enable it');
  }

  if (!row || !valid || !row.is_active) {
    if (row) {
      const attempts = row.failed_attempts + 1;
      const lock = attempts >= env.LOCAL_AUTH_MAX_ATTEMPTS;
      await exec(
        `UPDATE app.local_credential
            SET failed_attempts = $2,
                locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
          WHERE user_id = $1`,
        [row.id, lock ? 0 : attempts, lock, String(env.LOCAL_AUTH_LOCKOUT_MIN)],
      );
    }
    await recordAudit({
      action: 'auth.login', actorEmail: email, outcome: 'failure',
      detail: { method: 'local' }, ip: req.ip,
    });
    throw new AuthError('invalid-credentials', 'invalid email or password');
  }

  if (row.expires_at && row.expires_at < new Date().toISOString().slice(0, 10)) {
    throw new AuthError('disabled', 'this account has expired — ask an administrator to extend it');
  }

  if (env.LOCAL_AUTH_REQUIRE_MFA && !row.mfa_enabled) {
    throw new AuthError('mfa-required', 'multi-factor authentication is required');
  }

  await exec(
    `UPDATE app.local_credential SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1`,
    [row.id],
  );
  await exec(`UPDATE app.app_user SET last_login_at = now() WHERE id = $1`, [row.id]);

  const principal = await loadPrincipal(row.id);
  if (!principal) throw new AuthError('disabled', 'account is disabled');

  await createSession(res, row.id, {
    authMethod: 'local',
    ip: req.ip,
    ua: req.get('user-agent') ?? undefined,
  });
  await recordAudit({
    action: 'auth.login', actorUserId: row.id, actorEmail: principal.email, outcome: 'success',
    detail: { method: 'local' }, ip: req.ip,
  });
  return principal;
}

// ──────────────────────────────────────────────────────────────── DWS Hub OIDC

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discovery: Discovery | null = null;
let jwks: JWTVerifyGetKey | null = null;

export function oidcEnabled(): boolean {
  return isOidcConfigured(env);
}

/**
 * Lazy re-init: the Hub may boot after this app (or drop and return). Retried
 * at most once per minute so a dead Hub cannot slow the login page down.
 */
let lastInitAttempt = 0;
export async function ensureOidcReady(): Promise<boolean> {
  if (!oidcEnabled()) return false;
  if (discovery && jwks) return true;
  if (Date.now() - lastInitAttempt < 60_000) return false;
  lastInitAttempt = Date.now();
  const r = await initOidc();
  return r.ok;
}

export async function initOidc(): Promise<{ ok: boolean; error?: string }> {
  if (!oidcEnabled()) return { ok: false, error: 'not configured' };
  try {
    const res = await fetch(env.OIDC_DISCOVERY_URL!, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
    const d = (await res.json()) as Discovery;
    for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (!d[k]) throw new Error(`discovery missing ${k}`);
    }
    discovery = d;
    // Caches keys and refetches on an unknown `kid`, so Hub key rotation needs
    // no restart here.
    jwks = createRemoteJWKSet(new URL(d.jwks_uri), { cooldownDuration: 30_000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const b64url = (b: Buffer) => b.toString('base64url');

/** Short-lived PKCE/state store. In production this belongs in Redis. */
const flowStore = new Map<string, { nonce: string; verifier: string; returnTo: string; exp: number }>();

function putFlow(state: string, v: { nonce: string; verifier: string; returnTo: string }): void {
  flowStore.set(state, { ...v, exp: Date.now() + 600_000 });
  for (const [k, x] of flowStore) if (x.exp < Date.now()) flowStore.delete(k);
}

function takeFlow(state: string) {
  const v = flowStore.get(state);
  flowStore.delete(state); // single use
  return v && v.exp >= Date.now() ? v : null;
}

export function buildAuthorizeUrl(returnTo: string | undefined): string {
  if (!discovery) throw new Error('OIDC not initialised');

  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  putFlow(state, { nonce, verifier, returnTo: safeReturnTo(returnTo) });

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('client_id', env.OIDC_CLIENT_ID!);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', env.OIDC_REDIRECT_URI!);
  url.searchParams.set('scope', env.OIDC_SCOPES);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256'); // never 'plain'
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  return url.toString();
}

/** Open-redirect guard: only same-origin relative paths are honoured. */
function safeReturnTo(v: string | undefined): string {
  if (!v || !v.startsWith('/') || v.startsWith('//')) return '/';
  return v;
}

export interface OidcCallbackResult {
  principal: Principal;
  returnTo: string;
  flow: 'sp' | 'idp';
}

/**
 * The callback. Handles BOTH arrival paths — the highest-risk function in the
 * codebase, per the Hub integration guide.
 */
export async function handleOidcCallback(
  params: { code?: string; state?: string; code_verifier?: string },
  req: Request,
  res: Response,
): Promise<OidcCallbackResult> {
  if (!discovery || !jwks) throw new Error('OIDC not initialised');
  if (!params.code) throw new AuthError('invalid-credentials', 'missing code');

  let verifier: string;
  let expectedNonce: string | null = null;
  let returnTo = '/';
  let flow: 'sp' | 'idp';

  if (params.code_verifier) {
    // ── IdP-initiated: the user clicked our tile in the Hub dashboard. ──
    // /auth/oidc/login never ran, so there is no stored state and NOTHING to
    // compare it against. A stock OIDC library throws MismatchingStateError here.
    // The id_token signature is therefore the ONLY trust anchor, which is why the
    // iss/aud/exp verification below is mandatory, not optional.
    flow = 'idp';
    verifier = params.code_verifier;
  } else {
    flow = 'sp';
    if (!params.state) throw new AuthError('invalid-credentials', 'missing state');
    const stored = takeFlow(params.state);
    if (!stored) throw new AuthError('invalid-credentials', 'unknown or expired state');
    verifier = stored.verifier;
    expectedNonce = stored.nonce;
    returnTo = stored.returnTo;
  }

  // ── Token exchange ──
  // JSON body, NOT form-encoded: form encoding returns unsupported_grant_type.
  // redirect_uri is REQUIRED: omitting it returns invalid_request.
  // There is no client_secret — this is a public client.
  const tokenRes = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: params.code,
      code_verifier: verifier,
      redirect_uri: env.OIDC_REDIRECT_URI,
      client_id: env.OIDC_CLIENT_ID,
    }),
  });

  if (!tokenRes.ok) {
    // ALWAYS surface the OAuth error body. An opaque 400 is undiagnosable; the
    // body names the real problem.
    const body = await tokenRes.text();
    throw new AuthError(
      'invalid-credentials',
      `token endpoint ${tokenRes.status}: ${body.slice(0, 300)}`,
    );
  }

  const { id_token: idToken } = (await tokenRes.json()) as { id_token?: string };
  if (!idToken) throw new AuthError('invalid-credentials', 'no id_token in token response');

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: discovery.issuer,
    audience: env.OIDC_CLIENT_ID!,
    algorithms: ['RS256'],
    clockTolerance: 30,
  });

  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new AuthError('invalid-credentials', 'nonce mismatch');
  }

  // `sub` is the primary key. Email is a display attribute and it changes.
  const sub = typeof payload.sub === 'string' ? payload.sub : null;
  if (!sub) throw new AuthError('invalid-credentials', 'invalid token payload (no subject)');
  const email = String(payload.email ?? '').trim().toLowerCase();
  const name = String(payload.name ?? email);

  const userId = await upsertSsoUser(sub, email, name);
  const principal = await loadPrincipal(userId);
  if (!principal) throw new AuthError('disabled', 'account is disabled');

  await createSession(res, userId, {
    authMethod: 'sso',
    flow,
    ip: req.ip,
    ua: req.get('user-agent') ?? undefined,
  });
  await recordAudit({
    action: 'auth.login', actorUserId: userId, actorEmail: email, outcome: 'success',
    detail: { method: 'sso', flow }, ip: req.ip,
  });

  return { principal, returnTo, flow };
}

/**
 * First successful SSO login creates the user with role `viewer` and an EMPTY
 * data scope: they can sign in and see the shell, and no procurement data at all,
 * until an administrator grants scope. Nothing is inferred from an email domain.
 */
async function upsertSsoUser(sub: string, email: string, name: string): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM app.app_user WHERE sso_subject = $1`,
    [sub],
  );
  if (existing) {
    await exec(
      `UPDATE app.app_user SET email = $2, display_name = $3, last_login_at = now() WHERE id = $1`,
      [existing.id, email, name],
    );
    return existing.id;
  }

  const ins = await queryOne<{ id: string }>(
    `INSERT INTO app.app_user (sso_subject, email, display_name, auth_method, is_active, last_login_at)
     VALUES ($1, $2, $3, 'sso', true, now()) RETURNING id`,
    [sub, email, name],
  );
  const id = ins!.id;
  await exec(`INSERT INTO app.user_role (user_id, role_code) VALUES ($1, 'viewer')`, [id]);
  // Deliberately NO app.data_scope row.
  return id;
}
