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
import { query, queryOne } from '../../db/client.js';
import { FEED_LABELS, type Feed } from '@pct/contracts';
import { executeDrill, type DrillPredicate } from '../analytics/drill.js';
import type { ScopeEntry } from '../authz/scope.js';

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
 * A validation finding that can name its own rows.
 *
 * Most findings carry the same `drill_predicate` that powers click-through from
 * the Data Check page — `{grain:'po_line', filters:{isSto:true}}` and the like.
 * That predicate IS a row selector, so listing the rows behind a finding needs
 * no per-rule plumbing: run the predicate, write the rows. On the last real
 * batch, 8 of 11 findings carried one.
 *
 * The three that do not are the ones that should not be listed anyway: V-M01 and
 * V-M03 are statements about the shape of the whole export (19,989 and 7,776
 * rows are the population, not the problem), and V-I01 is a linkage summary.
 */
export interface FindingRows {
  ruleId: string;
  severity: string;
  feed: string | null;
  message: string;
  affectedRows: number | null;
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
  /** Set when the sheet holds fewer rows than the finding counts. */
  truncatedAt: number | null;
}

/**
 * The rows behind each finding of a batch that carries a selector.
 *
 * `scope` is the REQUESTER's data scope, threaded through executeDrill: a
 * workbook must never show rows the person downloading it could not see on
 * screen. That is also why this cannot be precomputed and cached — the answer is
 * different per reader.
 *
 * Findings are read from the batch, but the ROWS come from the dataset version
 * that batch produced. A batch that failed never produced one, so there are no
 * facts to select and this returns nothing — the per-cell V-P sheets are then
 * the whole report, which is correct: a failed batch's rows never reached a fact
 * table to be judged by a business rule.
 */
export async function loadFindingRows(
  batchId: number,
  scope: ScopeEntry[],
  perSheetLimit = 10000,
): Promise<FindingRows[]> {
  const ver = await queryOne<{ id: number }>(
    `SELECT id FROM core.dataset_version WHERE batch_id = $1 ORDER BY id DESC LIMIT 1`,
    [batchId],
  );
  if (!ver) return [];

  const findings = await query<{
    rule_id: string; severity: string; feed: string | null; message: string;
    affected_rows: number | null; drill_predicate: DrillPredicate;
  }>(
    `SELECT rule_id, severity, feed, message, affected_rows, drill_predicate
       FROM ingest.validation_finding
      WHERE batch_id = $1 AND drill_predicate IS NOT NULL
        -- INFO is excluded. Its definition is "recorded for trend comparison",
        -- not a problem with a row: V-M03 flags 7,776 PO lines whose delivery
        -- date equals their document date, which is a statement about how SAP is
        -- used, not 7,776 records anyone should go and correct. Including it made
        -- the workbook 3.6 MB and buried the 291 rows that do need attention.
        AND severity <> 'INFO'
      ORDER BY affected_rows DESC NULLS LAST`,
    [batchId],
  );

  const out: FindingRows[] = [];
  for (const f of findings) {
    try {
      const page = await executeDrill(
        {
          ...f.drill_predicate,
          v: ver.id,
          scope,
          // executeDrill reads neither of these; they belong to the token
          // envelope, and this call bypasses tokens entirely because the caller
          // is already authorised for the batch.
          sid: '',
          exp: 0,
        },
        perSheetLimit,
        0,
      );
      out.push({
        ruleId: f.rule_id,
        severity: f.severity,
        feed: f.feed,
        message: f.message,
        affectedRows: f.affected_rows,
        columns: page.columns.map((c) => ({ key: c.key, label: c.label })),
        rows: page.rows,
        truncatedAt: page.totalCount > page.rows.length ? page.rows.length : null,
      });
    } catch {
      // A predicate this build cannot compile must not lose the rest of the
      // report. The finding still appears in the Summary sheet with its count.
      out.push({
        ruleId: f.rule_id, severity: f.severity, feed: f.feed, message: f.message,
        affectedRows: f.affected_rows, columns: [], rows: [], truncatedAt: null,
      });
    }
  }
  return out;
}

/**
 * Build the workbook.
 *
 * Returns null when there is nothing to report, so the caller can answer 404
 * rather than hand back an empty file that looks like a failure of the download.
 */
export function buildErrorWorkbook(
  batchId: number,
  rows: RowErrorRow[],
  findings: FindingRows[] = [],
): Buffer | null {
  if (rows.length === 0 && findings.length === 0) return null;

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

  // Two kinds of problem, one summary, with a Kind column so the difference is
  // explicit rather than inferred from the rule prefix:
  //   "unreadable value" — a cell that could not be parsed at all (V-P**)
  //   "flagged by a rule" — a row the validators flagged. Most of these are
  //                         KEPT in the dataset, so the sheet says so per row
  //                         rather than implying the data was rejected.
  const summary: Record<string, unknown>[] = [...byFeed.entries()].flatMap(([feed, e]) =>
    [...e.reasons.entries()].map(([reason, count]) => ({
      Kind: 'unreadable value',
      Feed: FEED_LABELS[feed as Feed] ?? feed,
      'Feed id': feed,
      Problem: reason,
      Rows: e.rows.size,
      Cells: count,
      'Listed in this file': 'yes',
    })));

  for (const f of findings) {
    summary.push({
      Kind: 'flagged by a rule',
      Feed: f.feed ? (FEED_LABELS[f.feed as Feed] ?? f.feed) : 'any',
      'Feed id': f.feed ?? '',
      Problem: `${f.ruleId} (${f.severity}) — ${f.message}`,
      Rows: f.affectedRows ?? '',
      Cells: '',
      // Stated per finding: a rule whose predicate this build cannot compile, or
      // one truncated by the per-sheet cap, must not look complete.
      'Listed in this file': f.rows.length === 0
        ? 'no — no rows could be selected'
        : f.truncatedAt !== null
          ? `first ${f.truncatedAt} of ${f.affectedRows ?? '?'}`
          : 'yes',
    });
  }
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

  // One sheet per finding that named rows. Sheet names are the RULE ID, not the
  // message: Excel caps a tab at 31 characters and forbids several punctuation
  // marks, and the messages are sentences.
  for (const f of findings) {
    if (f.rows.length === 0) continue;
    const sheet = f.rows.map((r) => {
      const o: Record<string, unknown> = { Rule: f.ruleId, Severity: f.severity };
      for (const c of f.columns) {
        const v = r[c.key];
        o[c.label] = v === null || v === undefined ? '' : (v as string | number | boolean);
      }
      return o;
    });
    XLSX.utils.book_append_sheet(
      wb, XLSX.utils.json_to_sheet(sheet), f.ruleId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 31),
    );
  }

  // compression on: these sheets repeat a handful of reason strings thousands of
  // times, so the saving is large and the CPU cost trivial.
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
}

export function errorWorkbookName(batchId: number): string {
  return `pct-ingest-errors-batch-${batchId}.xlsx`;
}
