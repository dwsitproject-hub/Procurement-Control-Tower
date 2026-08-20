/**
 * Sheet reading and typed extraction.
 *
 * The reader sits behind a narrow interface so the library choice is isolated.
 * Cell coercion is NOT delegated to the reader: every value goes through
 * @pct/rules/coerce, which is unit-tested against the Annex A §A.9 rules. That
 * is more testable than parity-by-library, and it is why the 22%-zero `Quantity`
 * trap and the '0' requisition-item sentinel are handled deterministically.
 */

import * as XLSX from 'xlsx';
import { readFile } from 'node:fs/promises';
import { normHeader, parseDate, parseTime, parseVal, parseDocNo, parseIntStrict } from '@pct/rules';
import type { Feed } from '@pct/contracts';
import { CONTRACT_BY_FEED } from './contracts.js';
import type { ClassifyResult } from './classify.js';

export interface SheetData {
  sheetName: string;
  headers: string[];
  /** Data rows only; index 0 is the first row after the header. */
  rows: unknown[][];
}

/**
 * Read the first worksheet of an XLSX file.
 *
 * `cellDates` is deliberately OFF.
 *
 * With cellDates enabled, SheetJS constructs Date objects using the LOCAL
 * timezone (`new Date(y, m, d)`). On a UTC+7 host a cell holding 2026-07-27
 * becomes 2026-07-26T17:00:00Z, and reading its UTC components yields
 * 2026-07-26 — every date silently shifted back a day. Day differences survive
 * that (both ends shift equally), so aging and cycle times still looked right
 * while absolute dates were wrong and documents crossed month boundaries.
 *
 * Leaving it off means date cells arrive as Excel serial numbers, which
 * `parseDate` converts with pure UTC arithmetic. That is deterministic and
 * independent of the host timezone.
 */
export async function readSheet(path: string): Promise<SheetData> {
  const buf = await readFile(path);
  return readSheetFromBuffer(buf);
}

/**
 * Does this buffer look like an XLSX (a ZIP container) rather than text?
 *
 * Checked by content, not by extension, because the SAP reference exports are
 * tab-delimited TEXT named `.csv` — trusting the name would send them to the
 * workbook reader and fail with a confusing ZIP error.
 */
function looksLikeZip(buf: Buffer | Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/**
 * Read SAP list output — the plain-text form of an ALV list, saved with a .csv
 * extension but delimited with TABS.
 *
 * Everything here is driven by the actual files, not by a general CSV notion:
 *
 *   * The first line is blank and the header is on the second (P Grp, P Org),
 *     or the first line is a report title with a page number and the header is
 *     on the third (zuser). So the header is FOUND, not assumed to be row 0.
 *   * Data rows begin with the delimiter, giving an empty leading field. It is
 *     dropped, otherwise every column is off by one.
 *   * In the user listing the header is PIPE-delimited (`|Client|User |...`)
 *     while its data rows are TAB-delimited. The two are split on their own
 *     delimiters rather than one guess for the whole file — this is the detail
 *     that makes a naive reader silently produce a single-column sheet.
 *   * Blank separator lines between the header and the data are skipped.
 *
 * Values come back as strings; coercion stays where it already lives, in the
 * contract-driven extraction below.
 */
function readSapListFromBuffer(buf: Buffer | Uint8Array): SheetData {
  const text = Buffer.from(buf).toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);

  const split = (line: string): string[] => {
    // Pick the delimiter per line: the header may use a different one from the
    // data it describes.
    const TAB = '\t';
    const delim = line.includes(TAB) ? TAB : line.includes('|') ? '|' : TAB;
    const parts = line.split(delim).map((c) => c.trim());
    // A leading delimiter yields an empty first field; likewise a trailing one.
    while (parts.length > 0 && parts[0] === '') parts.shift();
    while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    return parts;
  };

  // The header is the first line that yields two or more non-empty fields. A
  // title line ("07.08.2026   User_Listing (07.08.2026)   1") collapses to one
  // field once split, which is exactly what disqualifies it.
  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < lines.length && i < 50; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    const parts = split(line);
    if (parts.length >= 2 && parts.every((x) => x !== '')) {
      headerIdx = i;
      headers = parts;
      break;
    }
  }
  if (headerIdx < 0) throw new Error('no header row found in list output');

  const rows: unknown[][] = [];
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    const parts = split(line);
    if (parts.length === 0) continue;
    // Pad or trim to the header width so downstream indexing is positional.
    const row: unknown[] = headers.map((_, c) => (parts[c] === undefined ? null : parts[c]));
    if (row.some((c) => c !== null && c !== '')) rows.push(row);
  }

  return { sheetName: 'list', headers, rows };
}

export function readSheetFromBuffer(buf: Buffer | Uint8Array): SheetData {
  if (!looksLikeZip(buf)) return readSapListFromBuffer(buf);

  const wb = XLSX.read(buf, {
    type: 'buffer',
    cellDates: false,
    cellNF: false,
    cellText: false,
    // Formulas are never evaluated — the reader takes cached values only.
    cellFormula: false,
  });

  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('workbook contains no worksheets');

  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`worksheet "${sheetName}" is unreadable`);

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
    blankrows: false,
    raw: true,
  });

  const headerRow = matrix[0];
  if (!headerRow) throw new Error('worksheet is empty');

  const headers = headerRow.map((h) => (h === null || h === undefined ? '' : String(h).trim()));
  const rows = matrix.slice(1).filter((r) => r.some((c) => c !== null && c !== undefined && c !== ''));

  return { sheetName, headers, rows };
}

/** One extracted row: canonical field -> coerced value. */
export type ParsedRow = Record<string, string | number | boolean | null>;

/**
 * Extract a row into canonical fields using the classification result, coercing
 * each value by its declared contract type.
 */
export function extractRow(feed: Feed, cls: ClassifyResult, raw: readonly unknown[]): ParsedRow {
  const contract = CONTRACT_BY_FEED[feed];
  const out: ParsedRow = {};

  for (const c of contract.columns) {
    if (!c.field) continue;
    const idx = cls.fieldIndex.get(c.field);
    if (idx === undefined || idx < 0) {
      out[c.field] = null;
      continue;
    }
    out[c.field] = coerce(raw[idx], c.type);
  }
  return out;
}

function coerce(v: unknown, type: string): string | number | boolean | null {
  switch (type) {
    case 'dec':
      return parseVal(v);
    case 'int':
      return parseIntStrict(v);
    case 'date':
      return parseDate(v);
    case 'time':
      return parseTime(v);
    case 'bool':
      // Kept as the raw trimmed string: PR uses 'true'/'false', PO uses 'L'.
      // The rules layer interprets each per feed.
      return parseDocNo(v);
    case 'str':
    case 'enum':
    default:
      return parseDocNo(v);
  }
}

/**
 * Header-mismatch diagnostic for the validation report: which sheet headers were
 * consumed, which were ignored, and how each field was resolved.
 */
export function describeResolution(cls: ClassifyResult): string[] {
  return cls.resolutions
    .filter((r) => r.via !== 'exact')
    .map((r) =>
      r.via === 'missing'
        ? `${r.field}: NOT FOUND`
        : `${r.field}: resolved via ${r.via} to "${r.header}"`,
    );
}

export { normHeader };
