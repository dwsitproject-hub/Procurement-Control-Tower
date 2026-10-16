/**
 * Excel export for the two places rows are shown: the Detail table and the
 * drill panel.
 *
 * The contract is "what you see is what you get" — the file carries the
 * columns currently on screen, in their current order, filtered and sorted the
 * way the screen is. That is the whole point of the button: a spreadsheet that
 * disagrees with the page it came from is worse than no spreadsheet.
 *
 * Three things are deliberate:
 *
 *  - **Values stay values.** A number is written as a number and a date as a
 *    date, with a display format applied, rather than as the pre-formatted
 *    string the table shows. "1.4 M" and "14 Aug 2026" are for reading; a
 *    spreadsheet is for sorting, pivoting and summing, and text cells cannot
 *    do any of those. The formatting the reader sees is still the table's,
 *    because the number format carries it.
 *
 *  - **A null stays empty.** The table renders an em dash; writing that
 *    character into a numeric column would turn the column to text in Excel.
 *
 *  - **Truncation is stated, never silent.** Above MAX_EXPORT_ROWS the file
 *    holds the first N rows in the sorted order and the Export info sheet says
 *    so, with both counts. A file that quietly stops at 50,000 of 132,000 rows
 *    is how someone reports a total that is wrong by a factor of three.
 *
 * Scope is not enforced here — it is applied by the queries that produce the
 * rows (`queryDetail`, `executeDrill`), so an export can never contain a row
 * its requester could not have opened on screen.
 */

import * as XLSX from 'xlsx';

/**
 * Row cap.
 *
 * Not a database limit — the view answers far larger queries happily, and this
 * value is also the query's LIMIT so nothing larger is ever fetched — but a
 * limit on how long one request may hold the event loop, and how much heap it
 * may take while doing it. SheetJS builds the whole workbook in memory before
 * it can write a byte, one cell is an object, and the build is SYNCHRONOUS: for
 * as long as it runs, this single-process API answers nobody.
 *
 * RAISED 22 Sep 2026, from 50,000. The detail table had grown to ~54,000 rows,
 * so the one export a reader actually wanted was the one that came back
 * truncated. Re-measured first, against the real writer with the 14 default
 * columns (Node 22, --max-old-space-size=2048 as in the Dockerfile):
 *
 *     rows      time     file      heap (writer only)
 *     30,000     1.3 s    5.8 MB   115 MB
 *     60,000     7.7 s   11.5 MB   139 MB
 *    120,000    17.6 s   23.0 MB   275 MB
 *    200,000    34.0 s   38.5 MB   493 MB
 *
 * Time, not memory, is what picks the number: 493 MB is a quarter of the heap,
 * but 34 seconds is 34 seconds in which every other request waits. 150,000
 * costs roughly 22 s and ~350 MB, leaves years of headroom over today's 54,000,
 * and keeps the worst case inside nginx's 300 s ceiling with room to spare.
 *
 * Growth is not linear — the number-format pass walks every cell — so raising
 * this again means re-running that measurement, not interpolating it. If the
 * table ever needs more than this, the fix is not a bigger number here: it is
 * building the workbook off the event loop, in a worker thread, so a long
 * export stops being everyone's problem.
 *
 * Excel's own sheet limit is 1,048,576 rows, so this is well inside what the
 * file format allows.
 */
export const MAX_EXPORT_ROWS = 150_000;

export interface ExportColumn {
  key: string;
  label: string;
  type: string;
  currency?: string;
}

export interface ExportMeta {
  /** Worksheet name and the name in the info sheet. Excel caps tabs at 31. */
  sheetName: string;
  title: string;
  datasetVersionId: number;
  asOfDate: string;
  generatedBy: string;
  /** Rows matching the filter, which may exceed what the file holds. */
  totalRows: number;
  /** Human-readable "column = values" pairs describing the active filters. */
  filters: Array<[string, string]>;
}

/**
 * Number formats, chosen to match how the same value reads on screen.
 *
 * `pct` is the one worth naming: these values are 0-100, not 0-1, so Excel's
 * built-in percent format would multiply by another hundred and report 4,200%
 * where the page says 42%. The literal "%" suffix keeps the number itself
 * untouched and sortable.
 */
const NUMBER_FORMAT: Record<string, string> = {
  money: '#,##0.00',
  number: '#,##0.###',
  int: '#,##0',
  pct: '0.0"%"',
  date: 'yyyy-mm-dd',
};

/** Column widths in characters: enough for the header, more for free text. */
const TYPE_WIDTH: Record<string, number> = {
  money: 16, number: 12, int: 9, pct: 9, date: 12, enum: 16, string: 18,
};

/**
 * Excel's own date encoding: whole days since 1899-12-30.
 *
 * Computed here rather than by handing SheetJS a `Date`, and that is not
 * fussiness. SheetJS converts a Date to a serial through the LOCAL timezone,
 * and on a server set to Asia/Jakarta that left a residue:
 *
 *     14 Aug 2026  ->  46248.0000462963      (four seconds past midnight)
 *
 * It still renders as "2026-08-14" under a date format, so it looks perfectly
 * correct — while `=A2=DATE(2026,8,14)` is FALSE, VLOOKUP on a date misses,
 * and a pivot grouped by day can split one day in two. Deriving the serial
 * from the calendar parts through Date.UTC removes the timezone from the
 * calculation entirely, and the result is always a whole number.
 */
function excelSerial(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

/**
 * Coerce one database value into something Excel can hold as its own type.
 *
 * `date` columns arrive from node-postgres as JS Dates at local midnight, so
 * the LOCAL calendar parts are the true date and are what the serial is built
 * from. A date that arrives as a string instead (an ISO date down a JSON path)
 * is read the same way, so the two routes cannot produce files that behave
 * differently.
 */
function cellValue(v: unknown, type: string): string | number | Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'date') {
    if (v instanceof Date) {
      return Number.isNaN(v.getTime())
        ? null
        : excelSerial(v.getFullYear(), v.getMonth() + 1, v.getDate());
    }
    const s = String(v);
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return excelSerial(Number(m[1]), Number(m[2]), Number(m[3]));
    const d = new Date(s);
    return Number.isNaN(d.getTime())
      ? s
      : excelSerial(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  if (type === 'money' || type === 'number' || type === 'int' || type === 'pct') {
    const n = Number(v);
    // A numeric column holding something unparseable is written as the text it
    // is, rather than as NaN — which Excel shows as an error in every cell.
    return Number.isFinite(n) ? n : String(v);
  }
  if (v instanceof Date) return v;
  return String(v);
}

export function buildExportWorkbook(
  columns: readonly ExportColumn[],
  rows: readonly Record<string, unknown>[],
  meta: ExportMeta,
): Buffer {
  const wb = XLSX.utils.book_new();

  const header = columns.map((c) => c.label);
  const body = rows.map((r) => columns.map((c) => cellValue(r[c.key], c.type)));
  // No cellDates option: dates are already Excel serials by this point, which
  // is how the file format stores them anyway.
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);

  // Number formats are applied per column rather than per cell: the type is a
  // property of the column, and walking 600,000 cells to set the same string
  // on each is the slowest part of the whole export.
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  columns.forEach((c, i) => {
    const z = NUMBER_FORMAT[c.type];
    if (!z) return;
    for (let row = 1; row <= range.e.r; row += 1) {
      const cell = ws[XLSX.utils.encode_cell({ c: i, r: row })];
      if (cell && (cell.t === 'n' || cell.t === 'd')) cell.z = z;
    }
  });

  ws['!cols'] = columns.map((c) => ({
    wch: Math.max(c.label.length + 2, TYPE_WIDTH[c.type] ?? 14),
  }));
  // Autofilter on the header row: the first thing anyone does with an export
  // is filter it, and doing it here saves them finding the button.
  if (rows.length > 0) ws['!autofilter'] = { ref: ws['!ref'] as string };

  XLSX.utils.book_append_sheet(wb, ws, meta.sheetName.slice(0, 31));

  // ── Provenance ────────────────────────────────────────────────────────
  //
  // Every figure in this application is read from an immutable dataset
  // version. Once a spreadsheet leaves the app that context is gone, and
  // "which extract is this from?" becomes unanswerable at exactly the moment
  // someone is comparing two files. So the version, the as-of date and the
  // filters that produced the rows travel with it.
  const truncated = meta.totalRows > rows.length;
  const info: Array<[string, string]> = [
    ['Report', meta.title],
    ['Dataset version', `v${meta.datasetVersionId}`],
    ['Data as of', meta.asOfDate],
    ['Exported at', new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'],
    ['Exported by', meta.generatedBy],
    ['Rows matching the filter', String(meta.totalRows)],
    ['Rows in this file', String(rows.length)],
    [
      'Complete',
      truncated
        ? `NO — truncated at the ${MAX_EXPORT_ROWS.toLocaleString('en-US')}-row export limit. `
          + 'Narrow the filters and export again to get the rest.'
        : 'yes — every matching row is in this file',
    ],
    ['Columns', columns.map((c) => c.label).join(', ')],
    ['', ''],
    ['Filters applied', meta.filters.length === 0 ? '(none — the whole dataset)' : ''],
    ...meta.filters,
  ];
  const infoWs = XLSX.utils.aoa_to_sheet(info);
  infoWs['!cols'] = [{ wch: 26 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, infoWs, 'Export info');

  // Compression on: these sheets repeat status, plant and vendor strings
  // thousands of times, so the saving is large and the CPU cost trivial.
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
}

/** A filesystem-safe filename stamped with the day, so downloads do not collide. */
export function exportFileName(prefix: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = prefix.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `pct-${safe || 'export'}-${stamp}.xlsx`;
}
