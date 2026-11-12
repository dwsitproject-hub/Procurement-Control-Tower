/**
 * File sources — TECH 01 §6.5.1.
 *
 * Both the automatic share watcher and the manual upload path implement the same
 * interface, so "manual upload runs identical validation" is structurally true
 * rather than a policy someone has to remember.
 */

import { createHash } from 'node:crypto';
import { readdir, stat, readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export interface DiscoveredFile {
  /** Absolute path or spool id. Internally generated — never user-supplied. */
  handle: string;
  /** Original filename. ESCAPE before display. */
  displayName: string;
  byteSize: number;
  mtime: Date | null;
}

export interface FileSource {
  readonly kind: 'synology' | 'manual';
  list(): Promise<DiscoveredFile[]>;
  read(handle: string): Promise<Buffer>;
}

export class SourceUnavailableError extends Error {
  constructor(public readonly path: string) {
    super(`share not readable: ${path}`);
    this.name = 'SourceUnavailableError';
  }
}

/**
 * The share-folder source.
 *
 * Locally this is any readable directory (e.g. the Assets folder); in production
 * it is the read-only CIFS mount of the Synology share. The mount being
 * read-only is why there is no archive mode: an application defect can never
 * modify or delete a source file.
 */
export class ShareFolderSource implements FileSource {
  readonly kind = 'synology' as const;

  constructor(
    private readonly root: string,
    private readonly settleSeconds: number,
    /** Previous poll's sizes, so a still-growing file is skipped. */
    private readonly sizeMemo: Map<string, number> = new Map(),
  ) {}

  async list(): Promise<DiscoveredFile[]> {
    try {
      await access(this.root, constants.R_OK);
    } catch {
      // An unreadable mount must NOT look like "no new data".
      throw new SourceUnavailableError(this.root);
    }

    const names = await readdir(this.root);
    const out: DiscoveredFile[] = [];
    const now = Date.now();

    for (const name of names) {
      // Workbooks and SAP list output. The reference exports are TAB-delimited
      // text saved as .csv (018); the content is still verified by
      // assertMagicBytes below, so the extension only decides what to look at,
      // never what to trust.
      if (!/\.(xlsx|csv)$/i.test(name)) continue;
      if (name.startsWith('~$')) continue; // Excel lock file

      const full = join(this.root, name);
      const st = await stat(full);
      if (!st.isFile()) continue;

      // Settle check: skip a file the export job may still be writing. Two
      // conditions — recently modified, or size changed since the previous poll.
      if (this.settleSeconds > 0 && now - st.mtimeMs < this.settleSeconds * 1000) {
        continue;
      }
      const prev = this.sizeMemo.get(name);
      this.sizeMemo.set(name, st.size);
      if (prev !== undefined && prev !== st.size) {
        continue;
      }

      out.push({ handle: full, displayName: name, byteSize: st.size, mtime: st.mtime });
    }

    return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async read(handle: string): Promise<Buffer> {
    // Path-traversal guard even though handles are internally generated.
    const root = resolve(this.root);
    const target = resolve(handle);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error('refusing to read a path outside the share');
    }
    return readFile(target);
  }
}

/** Manual upload source over already-spooled files. */
export class ManualUploadSource implements FileSource {
  readonly kind = 'manual' as const;

  constructor(private readonly files: DiscoveredFile[]) {}

  async list(): Promise<DiscoveredFile[]> {
    return this.files;
  }

  async read(handle: string): Promise<Buffer> {
    const f = this.files.find((x) => x.handle === handle);
    if (!f) throw new Error('unknown upload handle');
    return readFile(handle);
  }
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Bundle hash: the identity of a set of source files.
 *
 * Backed by a unique partial index on published batches, so the same bundle can
 * never be published twice. This is what makes a 30-minute poll over unchanged
 * files inherently safe rather than merely wasteful.
 */
export function bundleHash(hashes: readonly string[]): string {
  return createHash('sha256').update([...hashes].sort().join('\n')).digest('hex');
}

/**
 * XLSX safety gates — TECH 03 §6.4 / PRD §19.6.
 * Applied to every file regardless of source.
 */
export interface SafetyLimits {
  maxFileBytes: number;
  maxCells: number;
  maxSheets: number;
}

export const DEFAULT_SAFETY: SafetyLimits = {
  maxFileBytes: 60 * 1024 * 1024,
  maxCells: 2_000_000,
  maxSheets: 20,
};

export function assertMagicBytes(buf: Buffer, displayName: string): void {
  const isZip = buf.length >= 4
    && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

  if (isZip) {
    // A real XLSX always contains the content-types part. A renamed .zip will not.
    if (!buf.includes(Buffer.from('[Content_Types].xml'))) {
      throw new Error(`${displayName}: not a valid XLSX file (missing [Content_Types].xml)`);
    }
    return;
  }

  // Not a ZIP: the only other thing the reader accepts is SAP list output —
  // tab-delimited text saved with a .csv extension. It is admitted on CONTENT,
  // not on the extension, and only if it is genuinely text: a binary blob must
  // still be refused here rather than reaching a parser that would misread it.
  //
  // Tab, LF and CR are exactly what these exports are made of, so they are
  // allowed; a NUL or any other C0 byte means binary.
  if (buf.length === 0) {
    throw new Error(`${displayName}: file is empty`);
  }
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  for (const byte of probe) {
    const isTextControl = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (byte < 0x20 && !isTextControl) {
      throw new Error(
        `${displayName}: not a valid XLSX or text export (binary content at byte 0x${
          byte.toString(16).padStart(2, '0')})`,
      );
    }
  }
}

export function assertFileSize(byteSize: number, displayName: string, limits: SafetyLimits): void {
  if (byteSize > limits.maxFileBytes) {
    throw new Error(
      `${displayName}: ${(byteSize / 1024 / 1024).toFixed(1)} MB exceeds the ${(
        limits.maxFileBytes / 1024 / 1024
      ).toFixed(0)} MB limit`,
    );
  }
}
