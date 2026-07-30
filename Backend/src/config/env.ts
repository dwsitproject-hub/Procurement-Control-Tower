/**
 * Configuration — TECH 01 §6.1.
 *
 * The process REFUSES TO START on invalid or incomplete configuration. There is
 * no silent default for anything security- or correctness-relevant.
 */

import { z } from 'zod';

/**
 * Single-value guard. Comma-joining OIDC_REDIRECT_URI yields `invalid_grant`
 * from the token endpoint; comma-joining APP_BASE_URL yields a port-parse crash.
 * Both are documented failure modes — reject at boot, loudly.
 */
const singleUrl = z
  .string()
  .url()
  .refine((v) => !v.includes(','), {
    message:
      'must be exactly one URL — register multiple redirect URIs on the Hub, configure one here',
  })
  .refine((v) => !/[<>]|%3c|%3e/i.test(v), {
    message: 'contains an unreplaced <placeholder>',
  });

const bool = z
  .string()
  .transform((v) => v.toLowerCase() === 'true' || v === '1')
  .or(z.boolean());

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
    APP_BASE_URL: singleUrl.default('http://localhost:8080'),
    PORT: z.coerce.number().int().positive().default(3000),
    TRUST_PROXY: z.coerce.number().int().min(0).default(1),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

    // ── DWS Hub OIDC (public client, PKCE — NO client secret exists) ──
    // Optional locally: the Hub is unreachable from a laptop, so the routes are
    // gated on complete configuration rather than failing at boot.
    OIDC_DISCOVERY_URL: singleUrl.optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_REDIRECT_URI: singleUrl.optional(),
    OIDC_SCOPES: z.string().default('openid email profile'),

    SESSION_SECRET: z.string().min(32),
    SESSION_COOKIE_NAME: z.string().default('pct_sid'),
    SESSION_COOKIE_SAMESITE: z.enum(['Lax', 'Strict', 'None']).default('Lax'),
    SESSION_COOKIE_SECURE: bool.default(false),
    SESSION_IDLE_TIMEOUT_MIN: z.coerce.number().int().positive().default(60),
    SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().positive().default(12),

    LOCAL_AUTH_ENABLED: bool.default(true),
    LOCAL_AUTH_REQUIRE_MFA: bool.default(false),
    LOCAL_AUTH_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    LOCAL_AUTH_LOCKOUT_MIN: z.coerce.number().int().positive().default(15),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).optional(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    DATASET_VERSIONS_RETAINED: z.coerce.number().int().min(2).default(12),

    // Local stand-in for the Synology share: any readable directory.
    SHARE_PATH: z.string().default('/mnt/sap_exports'),
    SHARE_POLL_CRON_MINUTES: z.coerce.number().int().positive().default(30),
    UPLOAD_SPOOL_PATH: z.string().default('/var/lib/pct/spool'),
    UPLOAD_MAX_FILE_MB: z.coerce.number().int().positive().default(60),
    UPLOAD_MAX_BATCH_MB: z.coerce.number().int().positive().default(200),
    INGEST_FILE_SETTLE_SECONDS: z.coerce.number().int().min(0).default(30),
    INGEST_STALL_CYCLES: z.coerce.number().int().positive().default(4),
    INGEST_AUTOPOLL_ENABLED: bool.default(true),

    SMTP_HOST: z.string().default('mailhog'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_SECURE: z.enum(['none', 'starttls', 'tls']).default('none'),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().default('Procurement Control Tower <pct-notify@energi-up.com>'),
    NOTIFY_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(20),
    NOTIFY_ENABLED: bool.default(true),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (!env.SESSION_COOKIE_SECURE) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_COOKIE_SECURE'],
          message: 'must be true in production',
        });
      }
      if (env.LOCAL_AUTH_ENABLED && !env.LOCAL_AUTH_REQUIRE_MFA) {
        ctx.addIssue({
          code: 'custom',
          path: ['LOCAL_AUTH_REQUIRE_MFA'],
          message: 'local auth in production requires MFA',
        });
      }
    }
    if (env.SESSION_COOKIE_SAMESITE === 'None' && !env.SESSION_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SAMESITE'],
        message: 'SameSite=None requires Secure=true — browsers reject otherwise',
      });
    }
    // OIDC is all-or-nothing: a partial configuration produces a 404 login route
    // that is far harder to diagnose than a boot failure.
    const oidcKeys = [env.OIDC_DISCOVERY_URL, env.OIDC_CLIENT_ID, env.OIDC_REDIRECT_URI];
    const set = oidcKeys.filter(Boolean).length;
    if (set > 0 && set < 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['OIDC_DISCOVERY_URL'],
        message:
          'OIDC is partially configured — set OIDC_DISCOVERY_URL, OIDC_CLIENT_ID and OIDC_REDIRECT_URI together, or none of them',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    // eslint-disable-next-line no-console
    console.error(`FATAL: invalid configuration\n${lines.join('\n')}`);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

export function isOidcConfigured(env: Env): boolean {
  return Boolean(env.OIDC_DISCOVERY_URL && env.OIDC_CLIENT_ID && env.OIDC_REDIRECT_URI);
}
