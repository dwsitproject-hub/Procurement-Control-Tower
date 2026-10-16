/**
 * Shared Synology NAS storage — Docs/SYNOLOGY-INTEGRATION.md.
 *
 * The NAS share, SMB and host mount are provisioned by infra; this module is
 * only the app-side half: WHERE under the share this app reads and writes, and
 * whether that location is actually usable from inside the container.
 *
 * What this app uses the NAS for is the OPPOSITE direction from the reference
 * app in the doc, and the difference matters for review: EOS *writes* uploads
 * there, whereas PCT *reads* the six SAP exports that land in its folder. So
 * the share is mounted READ-ONLY (the convention this repo already applies to
 * /mnt/sap_exports), and nothing here ever creates or modifies a file on the
 * NAS. The upload spool deliberately stays on a local volume: it is scratch
 * space for a single ingest, deleted afterwards, and putting it on SMB would
 * add network latency to every upload for no durability benefit.
 *
 * Resolution order is the doc's, unchanged:
 *   1. STORAGE_LOCAL_PATH                      → used as-is
 *   2. root + deployment + slug (all three)    → {root}/{deployment}/{slug}
 *   3. neither                                 → SHARE_PATH
 * Step 3 differs from the doc's `./uploads` on purpose: SHARE_PATH is this
 * app's original variable and every existing deployment sets it, so an upgrade
 * that adds no STORAGE_* variables keeps reading exactly the folder it read
 * before.
 */

import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { loadEnv, type Env } from './env.js';

/** How basePath was decided. */
export type StorageMode =
  /** STORAGE_LOCAL_PATH — the doc's Option A, and the laptop case. */
  | 'explicit_path'
  /** The doc's Option B: composed from root + deployment + slug. */
  | 'synology_composed'
  /** No STORAGE_* variables at all: this app's pre-existing SHARE_PATH. */
  | 'legacy_share_path';

export interface StorageResolution {
  mode: StorageMode;
  type: Env['STORAGE_TYPE'];
  /** The resolved folder, as seen from INSIDE the container. */
  basePath: string;
  synologyRoot: string | null;
  deployment: string | null;
  projectSlug: string | null;
  /** Option B was used, so a NAS bind mount is expected at basePath. */
  expectsNas: boolean;
  /**
   * Both options are configured. Option A wins (the doc: "Do not set
   * STORAGE_LOCAL_PATH when using Option B — it overrides the composed path"),
   * so this is surfaced rather than silently resolved.
   */
  optionsConflict: boolean;
}

/**
 * Join POSIX-style. Container paths are POSIX even when the API runs on
 * Windows in development, and the result must match the compose bind mount
 * byte-for-byte — node:path would emit backslashes here on win32.
 */
function joinPosix(head: string, ...rest: string[]): string {
  const base = head.replace(/\/+$/g, '');
  const tail = rest.map((p) => p.replace(/^\/+|\/+$/g, '')).filter((p) => p !== '');
  return tail.length === 0 ? base : `${base}/${tail.join('/')}`;
}

export function resolveStorage(env: Env = loadEnv()): StorageResolution {
  const root = env.STORAGE_SYNOLOGY_ROOT?.trim() || null;
  const deployment = env.STORAGE_DEPLOYMENT ?? null;
  const slug = env.STORAGE_PROJECT_SLUG?.trim() || null;
  const explicit = env.STORAGE_LOCAL_PATH?.trim() || null;
  const composable = Boolean(root && deployment && slug);

  const common = {
    type: env.STORAGE_TYPE,
    synologyRoot: root,
    deployment,
    projectSlug: slug,
    optionsConflict: Boolean(explicit) && composable,
  };

  if (explicit) {
    return { ...common, mode: 'explicit_path', basePath: explicit, expectsNas: false };
  }
  if (composable) {
    return {
      ...common,
      mode: 'synology_composed',
      basePath: joinPosix(root!, deployment!, slug!),
      expectsNas: true,
    };
  }
  return { ...common, mode: 'legacy_share_path', basePath: env.SHARE_PATH, expectsNas: false };
}

/** The folder feeds default to when no per-feed path has been configured. */
export function storageBasePath(env: Env = loadEnv()): string {
  return resolveStorage(env).basePath;
}

export interface StorageHealth extends StorageResolution {
  exists: boolean;
  readable: boolean;
  /** Expected to be false: the NAS is mounted read-only on purpose. */
  writable: boolean;
  error: string | null;
  /**
   * Whether basePath sits on a different filesystem than `/`. A bind mount
   * does; a folder Docker auto-created because the mount was MISSING does not.
   * null when the question cannot be answered (win32 development).
   */
  separateDevice: boolean | null;
  /** Populated when the evidence says the bind mount is not in place. */
  mountWarning: string | null;
}

/**
 * Probe the resolved folder. This exists because of the single most confusing
 * failure in the doc's troubleshooting table — "files visible in container but
 * not on NAS". Its cause is a missing bind mount, and the symptom is a folder
 * that looks perfectly fine: Docker creates an empty directory in the
 * container's own filesystem when it cannot mount the host path. Comparing the
 * device id against `/` distinguishes the two, so the panel can say "this is
 * not the NAS" instead of "no files found".
 */
export async function storageHealth(env: Env = loadEnv()): Promise<StorageHealth> {
  const res = resolveStorage(env);
  const out: StorageHealth = {
    ...res,
    exists: false,
    readable: false,
    writable: false,
    error: null,
    separateDevice: null,
    mountWarning: null,
  };

  try {
    const st = await stat(res.basePath);
    out.exists = true;
    if (!st.isDirectory()) {
      out.error = 'exists but is not a directory';
      return out;
    }
    if (process.platform !== 'win32') {
      try {
        const rootSt = await stat('/');
        out.separateDevice = st.dev !== rootSt.dev;
      } catch {
        out.separateDevice = null;
      }
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }

  if (out.exists) {
    out.readable = await access(res.basePath, constants.R_OK).then(() => true, () => false);
    out.writable = await access(res.basePath, constants.W_OK).then(() => true, () => false);
  }

  // Only meaningful for Option B: a plain local folder is SUPPOSED to live on
  // the container's own filesystem, so the device test would cry wolf there.
  if (res.expectsNas) {
    if (!out.exists) {
      out.mountWarning =
        `${res.basePath} does not exist inside the container — the bind mount is missing, ` +
        'or the deployment/slug folder has not been created on the NAS.';
    } else if (out.separateDevice === false) {
      out.mountWarning =
        `${res.basePath} is on the container's own filesystem, not a mount — anything read ` +
        'here is NOT the NAS. Add the bind mount and recreate the container.';
    } else if (!out.readable) {
      out.mountWarning = `${res.basePath} is mounted but not readable by the API user.`;
    }
  }

  return out;
}

/** One line for the boot banner. */
export function storageSummary(res: StorageResolution = resolveStorage()): string {
  return res.mode === 'synology_composed'
    ? `synology:${res.basePath}`
    : res.mode === 'explicit_path'
      ? `path:${res.basePath}`
      : `share:${res.basePath}`;
}
