/**
 * Scheduled share-folder sync (user request 6 Aug 2026).
 *
 * SHARE_POLL_CRON_MINUTES and INGEST_AUTOPOLL_ENABLED existed in the
 * environment since W1 but NOTHING read them — the share ingest only ever ran
 * when a steward pressed Sync. That is why "the auto sync from the share
 * folder is not running": it was never scheduled. This module is that
 * scheduler, and its settings live in rule_config so an admin can change the
 * path, the file-name filter and the interval at runtime, exactly like the
 * Coupa poller.
 */

import { readdir, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../../db/client.js';
import { loadRuleSnapshot } from '../admin/rules.js';
import { loadEnv } from '../../config/env.js';
import { runIngest } from './pipeline.js';
import { ShareFolderSource } from './sources.js';

const env = loadEnv();

/** Stable lock id for "share ingest" — distinct from the Coupa one (0xc00fa). */
const ADVISORY_LOCK_KEY = 0x5ade0;

export interface ShareConfig {
  enabled: boolean;
  path: string;
  intervalMinutes: number;
  /** Glob-ish patterns; a file must match one to be considered. Empty = all. */
  filePatterns: string[];
  settleSeconds: number;
}

export async function loadShareConfig(): Promise<ShareConfig> {
  const rules = await loadRuleSnapshot();
  const raw = rules['ingest.file_patterns'];
  const patterns = Array.isArray(raw)
    ? raw.map(String).filter((x) => x.trim() !== '')
    : typeof raw === 'string' && raw.trim() !== ''
      ? raw.split(',').map((x) => x.trim()).filter(Boolean)
      : [];
  return {
    enabled: rules['ingest.autopoll_enabled'] === true || rules['ingest.autopoll_enabled'] === 'true',
    path: String(rules['ingest.share_path'] ?? env.SHARE_PATH),
    // Clamped here, not in the UI: the backend owns its own limits.
    intervalMinutes: Math.min(Math.max(Number(rules['ingest.poll_interval_minutes'] ?? 30), 5), 1440),
    filePatterns: patterns,
    settleSeconds: env.INGEST_FILE_SETTLE_SECONDS,
  };
}

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

export function matchesPatterns(name: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => patternToRegExp(p).test(name));
}

export interface ScanEntry {
  name: string;
  byteSize: number;
  mtime: string;
  matched: boolean;
  /** Why the poller would skip it, if it would. */
  skipReason: string | null;
}

/**
 * Preview what the poller sees — the diagnostic an admin needs while
 * configuring the path and the name filter. Reads directory metadata only;
 * it never ingests.
 */
export async function scanShare(cfg: ShareConfig): Promise<{
  ok: boolean;
  path: string;
  error?: string;
  entries: ScanEntry[];
}> {
  try {
    await access(cfg.path, constants.R_OK);
  } catch (err) {
    return {
      ok: false,
      path: cfg.path,
      error: `not readable: ${err instanceof Error ? err.message : String(err)}`,
      entries: [],
    };
  }

  const names = await readdir(cfg.path);
  const now = Date.now();
  const entries: ScanEntry[] = [];

  for (const name of names) {
    let skip: string | null = null;
    if (name.startsWith('~$')) skip = 'Excel lock file';
    else if (!/\.xlsx$/i.test(name)) skip = 'not an .xlsx file';

    let size = 0;
    let mtime = new Date(0);
    if (skip === null) {
      try {
        const st = await stat(join(cfg.path, name));
        if (!st.isFile()) skip = 'not a file';
        size = st.size;
        mtime = st.mtime;
        if (skip === null && cfg.settleSeconds > 0 && now - st.mtimeMs < cfg.settleSeconds * 1000) {
          skip = `still settling (< ${cfg.settleSeconds}s old)`;
        }
      } catch (err) {
        skip = err instanceof Error ? err.message : String(err);
      }
    }

    const matched = skip === null && matchesPatterns(name, cfg.filePatterns);
    if (skip === null && !matched) skip = 'no name pattern matches';

    entries.push({
      name,
      byteSize: size,
      mtime: mtime.toISOString(),
      matched,
      skipReason: skip,
    });
  }

  return { ok: true, path: cfg.path, entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** A source that also applies the admin's name filter. */
export class FilteredShareSource extends ShareFolderSource {
  constructor(
    root: string,
    settleSeconds: number,
    private readonly patterns: readonly string[],
    sizeMemo?: Map<string, number>,
  ) {
    super(root, settleSeconds, sizeMemo);
  }

  override async list() {
    const all = await super.list();
    return all.filter((f) => matchesPatterns(f.displayName, this.patterns));
  }
}

export interface ShareRunResult {
  outcome: string;
  detail?: string;
}

/**
 * One scheduled pass. Advisory-locked so overlapping ticks (or a manual sync
 * running at the same moment) cannot ingest the same files twice.
 */
export async function runShareSync(trigger: 'scheduled' | 'manual'): Promise<ShareRunResult> {
  const cfg = await loadShareConfig();
  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS ok`, [ADVISORY_LOCK_KEY],
    );
    if (!lock.rows[0]?.ok) return { outcome: 'locked' };

    const source = new FilteredShareSource(cfg.path, cfg.settleSeconds, cfg.filePatterns);
    const out = await runIngest({ source, autoPublish: true });
    void trigger;
    return {
      outcome: out.outcome,
      detail: 'missing' in out ? `missing ${out.missing.join(',')}`
        : 'datasetVersionId' in out ? `v${out.datasetVersionId}`
        : 'path' in out ? out.path
        : undefined,
    };
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

let pollerStarted = false;
let lastRunAt = 0;
let lastResult: { at: string; outcome: string; detail?: string } | null = null;

export function shareLastResult(): typeof lastResult {
  return lastResult;
}

/**
 * Checks every 60s whether a scheduled share sync is due. Enable switch, path,
 * name filter and interval all come from rule_config, so changes take effect
 * without a restart.
 */
export function startSharePoller(log: (msg: string) => void): void {
  if (pollerStarted) return;
  pollerStarted = true;

  setInterval(() => {
    void (async () => {
      try {
        const cfg = await loadShareConfig();
        if (!cfg.enabled) return;
        if (Date.now() - lastRunAt < cfg.intervalMinutes * 60_000) return;
        lastRunAt = Date.now();
        const r = await runShareSync('scheduled');
        lastResult = { at: new Date().toISOString(), outcome: r.outcome, detail: r.detail };
        // 'noop_unchanged' is the normal steady state; log at the same level so
        // an operator can see the poller is alive rather than guessing.
        log(`share sync (${r.outcome})${r.detail ? `: ${r.detail}` : ''}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastResult = { at: new Date().toISOString(), outcome: 'error', detail: msg };
        log(`share poller error: ${msg}`);
      }
    })();
  }, 60_000).unref();
}
