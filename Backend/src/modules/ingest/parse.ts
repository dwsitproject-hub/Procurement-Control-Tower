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

  /**
   * Split one line into fields.
   *
   * The delimiter is chosen PER LINE, by whichever candidate yields the most
   * fields. That is not over-engineering - it is what these files require:
   *
   *   * the user listing has a PIPE-delimited header over TAB-delimited data, so
   *     one delimiter for the whole file produces a single-column sheet;
   *   * the purchasing-group and org exports arrived TAB-delimited and were later
   *     re-saved from Excel as ordinary COMMA-delimited CSV. The reader accepted
   *     only tab and pipe and threw "no header row found" on a perfectly good
   *     file. A .csv saved from Excel is the most ordinary thing an operator can
   *     produce, and it stopped the ingest.
   *
   * Quoted fields are honoured, because Excel quotes any value containing the
   * delimiter and a naive split would tear "Jakarta, Pusat" into two columns.
   */
  const DELIMS = ['\t', ',', ';', '|'];

  const splitOn = (line: string, delim: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i += 1; } else { inQuotes = !inQuotes; }
      } else if (ch === delim && !inQuotes) {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };

  const split = (line: string): string[] => {
    let best: string[] = [line.trim()];
    for (const d of DELIMS) {
      const parts = splitOn(line, d);
      if (parts.length > best.length) best = parts;
    }
    const parts = [...best];
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
export interface RowError {
  field: string;
  header: string;
  rawValue: string;
  ruleId: string;
  reason: string;
}

/** Human names for the coercion types, for a message an operator can act on. */
const TYPE_NAME: Record<string, string> = {
  dec: 'number', int: 'whole number', date: 'date', time: 'time',
  bool: 'true/false value', str: 'text', enum: 'value',
};

/**
 * Was the cell empty, or did it hold something unreadable?
 *
 * The distinction is the whole point of the row-error capture. coerce() returns
 * null for both, so without asking this question first every blank optional cell
 * would be reported as bad data and the report would be useless noise.
 */
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

export function extractRow(feed: Feed, cls: ClassifyResult, raw: readonly unknown[]): ParsedRow {
  return extractRowChecked(feed, cls, raw).row;
}

/**
 * Extract a row AND report the cells that could not be read.
 *
 * Two conditions produce an error, and only two — a narrow definition on
 * purpose, because a report that cries wolf is one nobody opens:
 *
 *   V-C01  the cell HAS a value but it cannot be read as the declared type.
 *          A blank cell never qualifies: blank is a legitimate value for most
 *          columns and is already handled by the required-field rules.
 *   V-C02  a PRIMARY KEY column is blank. Such a row cannot be identified, so
 *          nothing downstream can reference, dedupe or drill to it.
 *
 * An OPT column that is merely blank is not an error, and neither is a column
 * the file does not contain at all — that is a structural finding about the
 * file, reported once by checkFile rather than once per row.
 */
export function extractRowChecked(
  feed: Feed,
  cls: ClassifyResult,
  raw: readonly unknown[],
): { row: ParsedRow; errors: RowError[] } {
  const contract = CONTRACT_BY_FEED[feed];
  const out: ParsedRow = {};
  const errors: RowError[] = [];

  for (const c of contract.columns) {
    if (!c.field) continue;
    const idx = cls.fieldIndex.get(c.field);
    if (idx === undefined || idx < 0) {
      out[c.field] = null;
      continue;
    }
    const cell = raw[idx];
    const value = coerce(cell, c.type);
    out[c.field] = value;

    const blank = isBlank(cell);
    if (value === null && !blank) {
      errors.push({
        field: c.field,
        header: c.header,
        rawValue: String(cell),
        ruleId: 'V-C01',
        reason: `Not a valid ${TYPE_NAME[c.type] ?? c.type}: "${String(cell).slice(0, 60)}"`,
      });
    } else if (c.status === 'PK' && blank && !contract.continuationRows) {
      // Skipped for continuation-row feeds: a blank key there is the export's
      // documented shape, not bad data — the transform fills it from the row
      // above. Without this, PR Release reported 13,338 of 27,742 rows as
      // unreadable when nothing was wrong with any of them.
      errors.push({
        field: c.field,
        header: c.header,
        rawValue: '',
        ruleId: 'V-C02',
        reason: `${c.header} is empty, and it is a key column — the row cannot be identified.`,
      });
    }
  }
  return { row: out, errors };
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
