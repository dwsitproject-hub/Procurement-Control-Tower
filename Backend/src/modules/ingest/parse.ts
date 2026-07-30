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

export function readSheetFromBuffer(buf: Buffer | Uint8Array): SheetData {
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
