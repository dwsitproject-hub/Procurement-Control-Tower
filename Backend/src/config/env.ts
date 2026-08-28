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

/**
 * Optional variable where an EMPTY assignment means "not set".
 *
 * `FOO=` in an env file, and a Compose `environment:` entry with no value, both
 * arrive as an empty string rather than as absent. Without this an operator who
 * leaves a blank line in place of a value gets a boot failure complaining that
 * '' is not a valid choice, which reads like a bug in the app rather than a
 * blank they forgot to fill in.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

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

    // ── Shared Synology NAS (Docs/SYNOLOGY-INTEGRATION.md) ──
    // Option B (recommended): root + deployment + slug compose the app folder.
    // Option A: STORAGE_LOCAL_PATH gives one full path and overrides Option B.
    // Neither: SHARE_PATH is used, so an upgrade with no STORAGE_* variables
    // reads the same folder as before. See config/storage.ts.
    STORAGE_TYPE: optional(z.enum(['local']).default('local')),
    STORAGE_SYNOLOGY_ROOT: optional(z.string().optional()),
    STORAGE_DEPLOYMENT: optional(z.enum(['dev', 'prod']).optional()),
    STORAGE_PROJECT_SLUG: optional(z.string().min(1).optional()),
    STORAGE_LOCAL_PATH: optional(z.string().optional()),

    // Fallback share folder, and the local stand-in for the NAS in dev: any
    // readable directory holding the six SAP exports.
    SHARE_PATH: z.string().default('/mnt/sap_exports'),
    SHARE_POLL_CRON_MINUTES: z.coerce.number().int().positive().default(30),
    UPLOAD_SPOOL_PATH: z.string().default('/var/lib/pct/spool'),
    UPLOAD_MAX_FILE_MB: z.coerce.number().int().positive().default(60),
    UPLOAD_MAX_BATCH_MB: z.coerce.number().int().positive().default(200),
    INGEST_FILE_SETTLE_SECONDS: z.coerce.number().int().min(0).default(30),
    INGEST_STALL_CYCLES: z.coerce.number().int().positive().default(4),
    INGEST_AUTOPOLL_ENABLED: bool.default(true),

    // Coupa API (TECH_04). All optional: without them the poller stays off and
    // the Admin panel says "not configured". Staging vs production is only here.
    COUPA_BASE_URL: z.string().url().optional(),
    COUPA_CLIENT_ID: z.string().optional(),
    COUPA_CLIENT_SECRET: z.string().optional(),
    COUPA_SCOPES: z
      .string()
      .default(
        'core.sourcing.read core.sourcing.response.read core.purchase_order.read ' +
          'core.inventory.receiving.read core.invoice.read core.pay.payments.read ' +
          // Supplier master (payload doc §1.8) — carries the PO email address
          // shown in Vendor 360. Omitting it made /api/suppliers answer 403;
          // the client is granted this scope, the app simply never asked.
          'core.supplier.read core.common.read',
      ),

    SMTP_HOST: z.string().default('mailhog'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    // NOT a boolean. nodemailer's own option is `secure: true|false`, so
    // `SMTP_SECURE=false` is the natural thing for an operator to write — and it
    // is rejected on purpose rather than coerced: 'false' cannot say whether the
    // session should still be upgraded with STARTTLS, and guessing 'none' would
    // put the mail password on the wire in clear text. The message names the
    // value to use instead, because this failure stops the whole API booting.
    SMTP_SECURE: z
      .enum(['none', 'starttls', 'tls'], {
        errorMap: () => ({
          message:
            "must be 'tls' (implicit TLS, port 465), 'starttls' (upgrade a plain "
            + "connection, port 587) or 'none' (no encryption, local test server only) "
            + '- not true/false: the app has to know WHICH kind of TLS to negotiate',
        }),
      })
      .default('none'),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    // Verify the mail server's certificate. On by default, and worth leaving on:
    // setting it false accepts ANY certificate, which makes the session
    // interceptable by anything on the path. Only a server with a self-signed
    // certificate needs it off.
    SMTP_REJECT_UNAUTHORIZED: bool.default(true),
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
    // Synology Option B is all-or-nothing for the same reason as OIDC below: a
    // partial set silently falls through to SHARE_PATH, and the operator is
    // then looking at a working dashboard that is reading the wrong folder.
    const storageKeys = [
      env.STORAGE_SYNOLOGY_ROOT,
      env.STORAGE_DEPLOYMENT,
      env.STORAGE_PROJECT_SLUG,
    ];
    const storageSet = storageKeys.filter(Boolean).length;
    if (storageSet > 0 && storageSet < 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_SYNOLOGY_ROOT'],
        message:
          'Synology storage is partially configured — set STORAGE_SYNOLOGY_ROOT, ' +
          'STORAGE_DEPLOYMENT and STORAGE_PROJECT_SLUG together, or none of them ' +
          '(use STORAGE_LOCAL_PATH for a single explicit folder)',
      });
    }
    if (env.STORAGE_SYNOLOGY_ROOT && !env.STORAGE_SYNOLOGY_ROOT.startsWith('/')) {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_SYNOLOGY_ROOT'],
        message: 'must be an absolute path INSIDE the container, e.g. /mnt/synology/eos',
      });
    }
    // A slug with a separator would escape the app's own folder on the share.
    if (env.STORAGE_PROJECT_SLUG && /[\\/]/.test(env.STORAGE_PROJECT_SLUG)) {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_PROJECT_SLUG'],
        message: 'is one folder name, not a path — it must not contain / or \\',
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
