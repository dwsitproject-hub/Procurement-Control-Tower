/**
 * Outbound email — SMTP notifications for scheduled runs (user request
 * 6 Aug 2026).
 *
 * SMTP_* and NOTIFY_ENABLED have been in the environment since W1 with nothing
 * reading them, the same way the share poller's settings were inert. This is
 * the implementation.
 *
 * Server settings (host, port, TLS, credentials) stay in the environment — a
 * password must never live in a database an API can read. Everything an
 * operator legitimately changes day to day (recipients, which events fire)
 * lives in rule_config and is editable from the Admin panel.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { query, queryOne } from '../../db/client.js';
import { loadEnv } from '../../config/env.js';
import { loadRuleSnapshot } from '../admin/rules.js';

const env = loadEnv();

export type NotifyEvent =
  | 'ingest.success'
  | 'ingest.failure'
  | 'coupa.error'
  | 'test';

export interface NotifyConfig {
  /** Master switch, from the environment. */
  enabled: boolean;
  recipients: string[];
  onIngestSuccess: boolean;
  onIngestFailure: boolean;
  onCoupaError: boolean;
  ratePerHour: number;
  smtp: {
    host: string;
    port: number;
    secure: string;
    user: string | null;
    from: string;
    /** Whether a password is configured — never the password itself. */
    hasPassword: boolean;
  };
}

const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

export function isEmail(x: string): boolean {
  return EMAIL.test(x.trim());
}

export async function loadNotifyConfig(): Promise<NotifyConfig> {
  const rules = await loadRuleSnapshot();
  const raw = rules['notify.recipients'];
  const recipients = (Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[,;\s]+/) : [])
    .map((x) => x.trim())
    .filter((x) => x !== '' && isEmail(x));

  const bool = (k: string, dflt: boolean) => {
    const v = rules[k];
    return v === undefined ? dflt : v === true || v === 'true';
  };

  return {
    enabled: env.NOTIFY_ENABLED,
    recipients,
    onIngestSuccess: bool('notify.on_ingest_success', true),
    onIngestFailure: bool('notify.on_ingest_failure', true),
    onCoupaError: bool('notify.on_coupa_error', true),
    ratePerHour: env.NOTIFY_RATE_LIMIT_PER_HOUR,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER ?? null,
      from: env.SMTP_FROM,
      hasPassword: Boolean(env.SMTP_PASSWORD),
    },
  };
}

let transport: Transporter | null = null;

function transporter(): Transporter {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 'tls' means implicit TLS (port 465); 'starttls' upgrades a plain
    // connection (port 587). nodemailer calls the first one `secure`.
    secure: env.SMTP_SECURE === 'tls',
    requireTLS: env.SMTP_SECURE === 'starttls',
    auth: env.SMTP_USER && env.SMTP_PASSWORD
      ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
      : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  return transport;
}

/** Drop the cached transport so a settings change is picked up. */
export function resetTransport(): void {
  transport = null;
}

export interface SendResult {
  status: 'sent' | 'failed' | 'suppressed';
  reason?: string;
  recipients: string[];
}

/**
 * Send one notification. Never throws: a broken mail server must not fail the
 * ingest or sync that triggered it — the outcome is recorded and returned.
 */
export async function notify(
  event: NotifyEvent,
  subject: string,
  bodyText: string,
  opts: { to?: string[]; ignoreToggles?: boolean } = {},
): Promise<SendResult> {
  const cfg = await loadNotifyConfig();
  const to = opts.to ?? cfg.recipients;

  const suppress = async (reason: string): Promise<SendResult> => {
    await log(event, subject, to, 'suppressed', reason, bodyText);
    return { status: 'suppressed', reason, recipients: to };
  };

  if (!cfg.enabled) return suppress('notifications are disabled (NOTIFY_ENABLED)');
  if (to.length === 0) return suppress('no recipients configured');
  if (!opts.ignoreToggles) {
    if (event === 'ingest.success' && !cfg.onIngestSuccess) return suppress('success notices are off');
    if (event === 'ingest.failure' && !cfg.onIngestFailure) return suppress('failure notices are off');
    if (event === 'coupa.error' && !cfg.onCoupaError) return suppress('Coupa error notices are off');
  }

  // Rate limit against real sends, so a restart cannot reset it and a storm of
  // failures cannot mail-bomb the recipients.
  const recent = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM ops.notify_log
      WHERE status = 'sent' AND sent_at > now() - interval '1 hour'`,
  );
  if ((recent?.n ?? 0) >= cfg.ratePerHour) {
    return suppress(`hourly limit reached (${cfg.ratePerHour})`);
  }

  try {
    await transporter().sendMail({
      from: cfg.smtp.from,
      to: to.join(', '),
      subject,
      text: bodyText,
    });
    await log(event, subject, to, 'sent', null, bodyText);
    return { status: 'sent', recipients: to };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await log(event, subject, to, 'failed', reason, bodyText);
    return { status: 'failed', reason, recipients: to };
  }
}

async function log(
  event: string, subject: string, recipients: string[],
  status: 'sent' | 'failed' | 'suppressed', error: string | null, body: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO ops.notify_log (event, subject, recipients, status, error, body_text)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [event, subject, recipients, status, error, body.slice(0, 20_000)],
    );
  } catch {
    // ops schema absent (pre-013) — a missing log must not break a send.
  }
}

export async function recentNotifications(limit = 15): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT id, sent_at AS "sentAt", event, subject, recipients, status, error
       FROM ops.notify_log ORDER BY sent_at DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`,
  );
}
