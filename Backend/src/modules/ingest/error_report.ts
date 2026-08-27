/**
 * The failing-rows workbook.
 *
 * When an ingest reports that some rows could not be read, this turns those rows
 * back into a spreadsheet the operator can hand to whoever produced the export:
 * the row number as Excel shows it, the column, the value that could not be
 * read, the reason, and the rest of that row's data for context.
 *
 * Two decisions worth stating:
 *
 *  * ONE SHEET PER FEED. A mixed sheet would need a feed column and would put
 *    unrelated column sets side by side; per feed, each sheet's columns are that
 *    feed's own.
 *  * THE ROW'S OTHER VALUES ARE INCLUDED. A report that says "row 4,812 has a
 *    bad date" sends someone hunting through a 20,000-row export. Carrying the
 *    document number and the rest of the parsed row means the offending record
 *    can be recognised on sight.
 *
 * The values come from staging.raw_row, which survives a failed batch precisely
 * so this is possible — the transform never ran, but the staged rows are there.
 */

import * as XLSX from 'xlsx';
import { query } from '../../db/client.js';
import { FEED_LABELS, type Feed } from '@pct/contracts';

export interface RowErrorRow {
  // Index signature so this satisfies the db layer's Row constraint; the named
  // fields below are what the query actually selects.
  [key: string]: unknown;
  feed: string;
  source_row: number;
  field: string | null;
  header: string | null;
  raw_value: string | null;
  rule_id: string;
  reason: string;
  payload: Record<string, unknown> | null;
}

/** Errors for a batch, joined to the staged row they belong to. */
export async function loadRowErrors(batchId: number, limit = 20000): Promise<RowErrorRow[]> {
  return query<RowErrorRow>(
    `SELECT e.feed, e.source_row, e.field, e.header, e.raw_value, e.rule_id, e.reason,
            r.payload
       FROM ingest.row_error e
       LEFT JOIN staging.raw_row r
              ON r.batch_id = e.batch_id AND r.feed = e.feed AND r.source_row = e.source_row
      WHERE e.batch_id = $1
      ORDER BY e.feed, e.source_row, e.field
      LIMIT $2`,
    [batchId, limit],
  );
}

/** Per-feed error counts, for the summary line without pulling every row. */
export async function rowErrorCounts(batchId: number): Promise<
  { feed: string; rows: number; cells: number }[]
> {
  return query<{ feed: string; rows: number; cells: number }>(
    `SELECT feed, count(DISTINCT source_row)::int AS rows, count(*)::int AS cells
       FROM ingest.row_error WHERE batch_id = $1 GROUP BY feed ORDER BY feed`,
    [batchId],
  );
}

/**
 * Build the workbook.
 *
 * Returns null when there is nothing to report, so the caller can answer 404
 * rather than hand back an empty file that looks like a failure of the download.
 */
export function buildErrorWorkbook(batchId: number, rows: RowErrorRow[]): Buffer | null {
  if (rows.length === 0) return null;

  const wb = XLSX.utils.book_new();

  // A summary sheet first: someone opening this wants the shape of the problem
  // before the detail, and a workbook whose first tab is 8,000 rows of detail
  // buries it.
  const byFeed = new Map<string, { rows: Set<number>; cells: number; reasons: Map<string, number> }>();
  for (const r of rows) {
    let e = byFeed.get(r.feed);
    if (!e) { e = { rows: new Set(), cells: 0, reasons: new Map() }; byFeed.set(r.feed, e); }
    e.rows.add(r.source_row);
    e.cells += 1;
    // Group by the RULE and column, not the full message: the message embeds the
    // offending value, so counting raw messages would produce one group per row.
    const key = `${r.rule_id} · ${r.header ?? r.field ?? '(row)'}`;
    e.reasons.set(key, (e.reasons.get(key) ?? 0) + 1);
  }

  const summary = [...byFeed.entries()].flatMap(([feed, e]) =>
    [...e.reasons.entries()].map(([reason, count]) => ({
      Feed: FEED_LABELS[feed as Feed] ?? feed,
      'Feed id': feed,
      Problem: reason,
      Cells: count,
      'Rows affected in this feed': e.rows.size,
    })));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary');

  // One detail sheet per feed.
  for (const [feed, _e] of byFeed) {
    const feedRows = rows.filter((r) => r.feed === feed);
    // Every payload key seen in this feed, so the sheet carries the row's own
    // data. Union rather than the first row's keys: a spec's optional fields may
    // be absent from one row and present in another.
    const dataCols = [...new Set(feedRows.flatMap((r) => Object.keys(r.payload ?? {})))];
    const sheet = feedRows.map((r) => {
      const base: Record<string, unknown> = {
        'Excel row': r.source_row,
        Column: r.header ?? r.field ?? '',
        'Value that could not be read': r.raw_value ?? '',
        Reason: r.reason,
        Rule: r.rule_id,
      };
      for (const k of dataCols) {
        const v = (r.payload ?? {})[k];
        base[k] = v === null || v === undefined ? '' : (v as string | number | boolean);
      }
      return base;
    });
    const name = (FEED_LABELS[feed as Feed] ?? feed).slice(0, 28);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), name);
  }

  // compression on: these sheets repeat a handful of reason strings thousands of
  // times, so the saving is large and the CPU cost trivial.
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
}

export function errorWorkbookName(batchId: number): string {
  return `pct-ingest-errors-batch-${batchId}.xlsx`;
}
