/**
 * Scheduled share-folder sync — per-feed folders, patterns and pickup times
 * (user request 6 Aug 2026).
 *
 * SHARE_POLL_CRON_MINUTES and INGEST_AUTOPOLL_ENABLED existed in the
 * environment since W1 but NOTHING read them: the share ingest only ever ran
 * when a steward pressed Sync. That is why "the auto sync from the share folder
 * is not running" — it was never scheduled.
 *
 * Each of the six feeds now carries its own folder, its own file-name pattern
 * and up to three daily pickup times expressed in **Asia/Jakarta**. Settings
 * live in rule_config, so an admin changes them at runtime.
 *
 * A note on what a per-feed slot means, because the honest answer matters: the
 * pipeline publishes a COMPLETE bundle or nothing (a half-loaded dataset is
 * never published). So a feed's slot decides WHEN THAT FEED'S FOLDER IS READ
 * AGAIN; when a slot fires, the newest matching file from every feed's own
 * folder is assembled into one bundle and ingested. If nothing has changed
 * since the last publish the pipeline reports noop_unchanged and no new
 * dataset version appears.
 */

import { readdir, stat, access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Feed } from '@pct/contracts';
import { pool, query } from '../../db/client.js';
import { loadRuleSnapshot } from '../admin/rules.js';
import { loadEnv } from '../../config/env.js';
import { resolveStorage } from '../../config/storage.js';
import { runIngest } from './pipeline.js';
import {
  archiveBundle, archiveSummary, fileRowErrors,
  type ArchiveConfig, type ArchiveReport,
} from './archive.js';
import { notify } from '../notify/mailer.js';
import { ingestFailureBody, ingestSuccessBody } from '../notify/messages.js';
import {
  SourceUnavailableError, type DiscoveredFile, type FileSource,
} from './sources.js';

const env = loadEnv();

/** Stable lock id for "share ingest" — distinct from the Coupa one (0xc00fa). */
const ADVISORY_LOCK_KEY = 0x5ade0;

export const SYNC_TIMEZONE = 'Asia/Jakarta';

/** The six feeds, with the labels the panel shows. */
export const FEED_META: { feed: Feed; label: string; defaultPattern: string }[] = [
  { feed: 'pr', label: 'PR Report', defaultPattern: 'PR Report*.XLSX' },
  { feed: 'po', label: 'PO Report', defaultPattern: 'PO Report*.XLSX' },
  { feed: 'gr', label: 'GR List', defaultPattern: 'GR List*.XLSX' },
  { feed: 'prel', label: 'PR Release', defaultPattern: 'PR Release*.XLSX' },
  { feed: 'por', label: 'PO Release', defaultPattern: 'PO Release*.XLSX' },
  { feed: 'fx', label: 'Rate Conversion', defaultPattern: 'Rate Conversion*.xlsx' },
  // Reference/master data (018). Optional: a slot left empty simply means this
  // file is not picked up on a schedule, and the six transactional feeds keep
  // publishing without it. Patterns are name-anchored so the extra files that
  // share these folders are never mistaken for one another — note that the user
  // listing embeds its export date in the filename.
  { feed: 'pgrp', label: 'Purchasing Groups', defaultPattern: 'P Grp*.csv' },
  { feed: 'porg', label: 'Purchasing Orgs', defaultPattern: 'P Org*.csv' },
  { feed: 'matm', label: 'Material Master', defaultPattern: 'Mat group*.xlsx' },
  { feed: 'zuser', label: 'SAP Users', defaultPattern: 'zuser*.csv' },
];

export interface FeedConfig {
  feed: Feed;
  path: string;
  pattern: string;
  /** Up to three 'HH:MM' pickup times, Asia/Jakarta. Empty string = unused. */
  slots: [string, string, string];
}

export interface ShareConfig {
  enabled: boolean;
  timezone: string;
  settleSeconds: number;
  feeds: FeedConfig[];
  /** Move files aside once a run is done with them (see archive.ts). */
  archive: ArchiveConfig;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function normaliseSlots(raw: unknown): [string, string, string] {
  const list = Array.isArray(raw) ? raw.map((x) => String(x ?? '').trim()) : [];
  const out: string[] = [];
  for (let i = 0; i < 3; i += 1) out.push(HHMM.test(list[i] ?? '') ? list[i]! : '');
  return [out[0]!, out[1]!, out[2]!];
}

export async function loadShareConfig(): Promise<ShareConfig> {
  const rules = await loadRuleSnapshot();
  const stored = (rules['ingest.feeds'] ?? {}) as Record<string, unknown>;

  /**
   * The folder a feed uses when the panel has not saved one for it. Precedence,
   * most specific first:
   *
   *   1. a per-feed folder saved in the panel  (handled below, per feed)
   *   2. the resolved storage root, WHEN STORAGE_* is configured
   *   3. the pre-012 `ingest.share_path` rule row
   *   4. SHARE_PATH
   *
   * 2 deliberately outranks 3. `ingest.share_path` is a dead key — no UI writes
   * it any more, the panel writes `ingest.feeds` — so an installation that once
   * saved it would otherwise have that row shadow the NAS root forever: the
   * panel would report a healthy Synology mount at the top while every feed
   * quietly read the old folder. Configuring STORAGE_* in the environment is
   * the newer and more deliberate statement of intent, so it wins.
   *
   * When no STORAGE_* variable is set, resolveStorage() returns SHARE_PATH and
   * the order collapses to exactly what it was before: rule row, then env.
   */
  const storage = resolveStorage(env);
  const defaultPath = storage.mode === 'legacy_share_path'
    ? String(rules['ingest.share_path'] ?? storage.basePath)
    : storage.basePath;

  const feeds = FEED_META.map(({ feed, defaultPattern }) => {
    const f = (stored[feed] ?? {}) as Record<string, unknown>;
    return {
      feed,
      path: String(f['path'] ?? defaultPath),
      pattern: String(f['pattern'] ?? defaultPattern),
      slots: normaliseSlots(f['slots']),
    };
  });

  /**
   * Archiving defaults to the resolved storage root, so the folders sit next to
   * the exports themselves: <root>/succeed and <root>/failed.
   *
   * It defaults to OFF, and that is deliberate rather than timid. The share is
   * mounted READ-ONLY by design (Docs/SYNOLOGY-INTEGRATION.md), so switching
   * this on before the mount is made writable would fail on every single run.
   * Off by default means the feature waits for the infrastructure instead of
   * filling the log with permission errors.
   */
  const archive: ArchiveConfig = {
    enabled: rules['ingest.archive_enabled'] === true || rules['ingest.archive_enabled'] === 'true',
    succeedDir: String(rules['ingest.archive_succeed_dir'] ?? join(defaultPath, 'succeed')),
    failedDir: String(rules['ingest.archive_failed_dir'] ?? join(defaultPath, 'failed')),
  };

  return {
    enabled: rules['ingest.autopoll_enabled'] === true || rules['ingest.autopoll_enabled'] === 'true',
    timezone: SYNC_TIMEZONE,
    settleSeconds: env.INGEST_FILE_SETTLE_SECONDS,
    feeds,
    archive,
  };
}

// ───────────────────────────────────────────────────────── name patterns

/**
 * Translate a shell-style pattern to a regex. Supports `*` and `?` only —
 * enough for export names like `PR Report*.XLSX`, and small enough to reason
 * about. Everything else is escaped, so a pattern can never inject a regex.
 */
export function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.trim() === '') return true;
  return patternToRegExp(pattern).test(name);
}

// ─────────────────────────────────────────────────────── Jakarta clock

/** 'YYYY-MM-DD' and minutes-since-midnight in the sync timezone. */
export function nowInZone(zone = SYNC_TIMEZONE, at: Date = new Date()): {
  date: string; minutes: number; hhmm: string;
} {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const hh = Number(get('hour'));
  const mm = Number(get('minute'));
  return { date, minutes: hh * 60 + mm, hhmm: `${get('hour')}:${get('minute')}` };
}

function slotMinutes(hhmm: string): number | null {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Slots whose Jakarta time has passed today and that have not fired yet. */
export async function dueSlots(cfg: ShareConfig, at: Date = new Date()): Promise<
  { feed: Feed; slot: number; hhmm: string }[]
> {
  const { date, minutes } = nowInZone(cfg.timezone, at);
  const ran = await query<{ feed: string; slot: number }>(
    `SELECT feed, slot FROM ops.ingest_slot_run WHERE ran_on = $1`, [date],
  );
  const already = new Set(ran.map((r) => `${r.feed}|${r.slot}`));

  const out: { feed: Feed; slot: number; hhmm: string }[] = [];
  for (const f of cfg.feeds) {
    f.slots.forEach((hhmm, i) => {
      const mins = slotMinutes(hhmm);
      if (mins === null) return;
      // Only fire slots already reached today; a missed slot (downtime) fires
      // on the next tick rather than being silently skipped.
      if (mins > minutes) return;
      if (already.has(`${f.feed}|${i + 1}`)) return;
      out.push({ feed: f.feed, slot: i + 1, hhmm });
    });
  }
  return out;
}

// ──────────────────────────────────────────────────── per-feed scanning

export interface FeedScan {
  feed: Feed;
  label: string;
  path: string;
  pattern: string;
  readable: boolean;
  error?: string;
  /** The file the poller would use — newest matching, settled. */
  chosen: { name: string; byteSize: number; mtime: string } | null;
  /** Everything else in the folder, with why it was not chosen. */
  others: { name: string; byteSize: number; mtime: string; reason: string }[];
}

async function scanFeed(f: FeedConfig, settleSeconds: number): Promise<FeedScan> {
  const meta = FEED_META.find((m) => m.feed === f.feed)!;
  const base: FeedScan = {
    feed: f.feed, label: meta.label, path: f.path, pattern: f.pattern,
    readable: false, chosen: null, others: [],
  };

  try {
    await access(f.path, constants.R_OK);
  } catch (err) {
    return { ...base, error: `not readable: ${err instanceof Error ? err.message : String(err)}` };
  }

  const names = await readdir(f.path);
  const now = Date.now();
  const candidates: { name: string; size: number; mtime: Date }[] = [];
  const others: FeedScan['others'] = [];

  for (const name of names) {
    let reason: string | null = null;
    if (name.startsWith('~$')) reason = 'Excel lock file';
    else if (!/\.(xlsx|csv)$/i.test(name)) reason = 'not an .xlsx or .csv file';
    else if (!matchesPattern(name, f.pattern)) reason = 'does not match the pattern';

    let size = 0;
    let mtime = new Date(0);
    if (reason === null) {
      try {
        const st = await stat(join(f.path, name));
        size = st.size;
        mtime = st.mtime;
        if (!st.isFile()) reason = 'not a file';
        else if (settleSeconds > 0 && now - st.mtimeMs < settleSeconds * 1000) {
          reason = `still being written (< ${settleSeconds}s old)`;
        }
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
    }

    if (reason === null) candidates.push({ name, size, mtime });
    else others.push({ name, byteSize: size, mtime: mtime.toISOString(), reason });
  }

  // Newest wins: a share folder usually accumulates dated exports.
  candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const [best, ...rest] = candidates;
  for (const r of rest) {
    others.push({
      name: r.name, byteSize: r.size, mtime: r.mtime.toISOString(),
      reason: 'an older match than the chosen file',
    });
  }

  return {
    ...base,
    readable: true,
    chosen: best ? { name: best.name, byteSize: best.size, mtime: best.mtime.toISOString() } : null,
    others: others.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function scanShare(cfg: ShareConfig): Promise<{ feeds: FeedScan[]; complete: boolean }> {
  const feeds: FeedScan[] = [];
  for (const f of cfg.feeds) feeds.push(await scanFeed(f, cfg.settleSeconds));
  return { feeds, complete: feeds.every((f) => f.chosen !== null) };
}

// ────────────────────────────────────────────────────────── the source

/**
 * A source spanning the six per-feed folders: the newest matching file from
 * each. Reads are confined to the configured roots, so a handle can never
 * escape them even though handles are internally generated.
 */
export class PerFeedShareSource implements FileSource {
  readonly kind = 'synology' as const;

  /**
   * The files this source handed to the pipeline on its last list().
   *
   * Remembered so the archive step can move exactly those, rather than
   * re-scanning afterwards and possibly picking up a file that arrived in the
   * meantime — which would file away an export nothing had read.
   */
  private listed: DiscoveredFile[] = [];

  get lastListed(): readonly DiscoveredFile[] {
    return this.listed;
  }

  constructor(private readonly cfg: ShareConfig) {}

  async list(): Promise<DiscoveredFile[]> {
    const scan = await scanShare(this.cfg);
    // An unreadable folder must NOT look like "no new data" — that is the
    // difference between "nothing to load" and "the mount is broken".
    const dead = scan.feeds.find((f) => !f.readable);
    if (dead) throw new SourceUnavailableError(dead.path);

    const out: DiscoveredFile[] = [];
    for (const f of scan.feeds) {
      if (!f.chosen) continue;
      out.push({
        handle: join(f.path, f.chosen.name),
        displayName: f.chosen.name,
        byteSize: f.chosen.byteSize,
        mtime: new Date(f.chosen.mtime),
      });
    }
    this.listed = out;
    return out;
  }

  async read(handle: string): Promise<Buffer> {
    const target = resolve(handle);
    const allowed = this.cfg.feeds.some((f) => {
      const root = resolve(f.path);
      return target === root || target.startsWith(root + sep);
    });
    if (!allowed) throw new Error('refusing to read a path outside the configured folders');
    return readFile(target);
  }
}

// ───────────────────────────────────────────────────────────── the run

export interface ShareRunResult {
  outcome: string;
  detail?: string;
  batchId?: number;
  datasetVersionId?: number;
  archive?: ArchiveReport;
}

/** Outcomes that mean "nothing was published and something is wrong". */
const FAILURE_OUTCOMES = new Set(['failed', 'incomplete_bundle', 'source_unavailable']);

/**
 * File the consumed exports away, after the pipeline and never inside it.
 *
 * Exported because BOTH entry points must do this: the scheduled pickup and the
 * "Sync now" button. They already share PerFeedShareSource so they can never
 * read different files — they must not diverge on what happens afterwards
 * either, which is precisely what happened when this lived inline in the
 * scheduled path and a manual sync quietly filed nothing.
 *
 * Never throws: the dataset is published and its figures are already correct by
 * the time this runs, so a filesystem permission cannot be allowed to turn a
 * good run bad.
 */
export async function archiveAfterRun(
  source: PerFeedShareSource,
  outcome: string,
  batchId: number | null,
  cfg: ShareConfig,
): Promise<ArchiveReport> {
  const at = new Date();
  const moved = await archiveBundle({
    files: source.lastListed.map((f) => ({ handle: f.handle, displayName: f.displayName })),
    outcome,
    batchId,
    cfg: cfg.archive,
    at,
  });
  // The rows that could not be read are filed too, into the same dated folder
  // under `failed`. Same clock as the files, so both land together rather than
  // in two folders either side of midnight.
  const rowErrors = await fileRowErrors({ batchId, outcome, cfg: cfg.archive, at });
  const archive: ArchiveReport = rowErrors ? { ...moved, rowErrors } : moved;

  lastArchive = archive;
  if (archive.rowErrors && !archive.rowErrors.written) {
    console.warn(`archive: unreadable-row report could not be written - ${archive.rowErrors.error}`);
  }
  if (archive.failed > 0) {
    // Worth its own log line: the run itself succeeded, so nothing else in the
    // output would mention that the share could not be written.
    console.warn(
      `archive: ${archive.failed} file(s) could not be moved - `
      + archive.files.filter((f) => !f.moved).map((f) => `${f.displayName}: ${f.error}`).join('; '),
    );
  }
  return archive;
}

/**
 * One pass. Advisory-locked so overlapping ticks — or a manual sync at the same
 * moment — cannot ingest the same files twice.
 */
export async function runShareSync(_trigger: 'scheduled' | 'manual'): Promise<ShareRunResult> {
  const cfg = await loadShareConfig();
  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS ok`, [ADVISORY_LOCK_KEY],
    );
    if (!lock.rows[0]?.ok) return { outcome: 'locked' };

    const source = new PerFeedShareSource(cfg);
    const out = await runIngest({ source, autoPublish: true });
    const archive = await archiveAfterRun(source, out.outcome, 'batchId' in out ? out.batchId : null, cfg);

    const base = 'missing' in out ? `missing ${out.missing.join(',')}`
      : 'datasetVersionId' in out ? `v${out.datasetVersionId}`
      : 'path' in out ? out.path
      : 'reason' in out ? out.reason
      : undefined;
    const arch = archiveSummary(archive);
    return {
      outcome: out.outcome,
      detail: [base, arch].filter(Boolean).join(' · ') || undefined,
      batchId: 'batchId' in out && out.batchId !== null ? out.batchId : undefined,
      datasetVersionId: 'datasetVersionId' in out ? out.datasetVersionId : undefined,
      archive,
    };
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

let pollerStarted = false;
let lastArchive: ArchiveReport | null = null;
let lastResult: { at: string; outcome: string; detail?: string; slots?: string } | null = null;

export function shareLastResult(): typeof lastResult {
  return lastResult;
}

/** The most recent archive attempt, for the Admin panel. */
export function shareLastArchive(): ArchiveReport | null {
  return lastArchive;
}

export async function recentSlotRuns(limit = 20): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT feed, slot, ran_on::text AS "ranOn", ran_at AS "ranAt", outcome, detail
       FROM ops.ingest_slot_run ORDER BY ran_at DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`,
  );
}

/**
 * Ticks every 60s: if any feed's Jakarta pickup time has arrived and has not
 * fired today, assemble the bundle and ingest once. All settings are re-read
 * each tick, so changes apply without a restart.
 */
export function startSharePoller(log: (msg: string) => void): void {
  if (pollerStarted) return;
  pollerStarted = true;

  setInterval(() => {
    void (async () => {
      try {
        const cfg = await loadShareConfig();
        if (!cfg.enabled) return;
        const due = await dueSlots(cfg);
        if (due.length === 0) return;

        const r = await runShareSync('scheduled');
        // 'locked' means another run holds the lock; leave the slots unmarked
        // so the next tick retries rather than losing the pickup.
        if (r.outcome === 'locked') return;

        const label = due.map((d) => `${d.feed}@${d.hhmm}`).join(' ');

        // Email the outcome. Never let a mail problem fail the ingest: notify()
        // swallows its own errors and records them.
        try {
          const input = {
            trigger: 'scheduled' as const,
            outcome: r.outcome,
            detail: r.detail,
            archive: r.archive ? archiveSummary(r.archive) : undefined,
            batchId: r.batchId,
            datasetVersionId: r.datasetVersionId,
            slots: label,
          };
          if (FAILURE_OUTCOMES.has(r.outcome)) {
            const m = await ingestFailureBody(input);
            await notify('ingest.failure', m.subject, m.body);
          } else {
            const m = await ingestSuccessBody(input);
            await notify('ingest.success', m.subject, m.body);
          }
        } catch (mailErr) {
          log(`share sync notification failed: ${mailErr instanceof Error ? mailErr.message : String(mailErr)}`);
        }
        for (const d of due) {
          await query(
            `INSERT INTO ops.ingest_slot_run (feed, slot, ran_on, outcome, detail)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (feed, slot, ran_on)
               DO UPDATE SET ran_at = now(), outcome = EXCLUDED.outcome, detail = EXCLUDED.detail`,
            [d.feed, d.slot, nowInZone(cfg.timezone).date, r.outcome, r.detail ?? null],
          );
        }
        lastResult = {
          at: new Date().toISOString(), outcome: r.outcome, detail: r.detail, slots: label,
        };
        log(`share sync (${r.outcome})${r.detail ? `: ${r.detail}` : ''} [${label}]`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastResult = { at: new Date().toISOString(), outcome: 'error', detail: msg };
        log(`share poller error: ${msg}`);
      }
    })();
  }, 60_000).unref();
}
