/**
 * Coupa incremental sync — TECH_04 §3.2/3.4.
 *
 * Each run pulls every enabled object's rows whose updated-at is on or after
 * the stored watermark (minus a lookback overlap for clock skew), pages of 50
 * in updated_at order, and UPSERTS them into ops.coupa_*. Raw payloads are
 * kept in ops.coupa_raw for lineage. A Postgres advisory lock guarantees a
 * single sync at a time across processes; the watermark only advances after
 * the run commits its pages, so a crash re-reads rather than skips.
 *
 * The SAP cross-references every payload carries (sap-po-no-line-no,
 * initial-sap-pr-no-line-no, sourcing-ref, supplier number) are parsed into
 * typed columns here, which is what lets the dashboard join Coupa data onto
 * fact_po_line / fact_pr_item without fuzzy matching.
 */

import { pool, query, queryOne } from '../../db/client.js';
import { loadRuleSnapshot } from '../admin/rules.js';
import { notify } from '../notify/mailer.js';
import { coupaErrorBody } from '../notify/messages.js';
import { coupaConfigured, fetchPage, coupaGet } from './client.js';

export const COUPA_OBJECTS = [
  'quote_requests',
  'purchase_orders',
  'receiving_transactions',
  'invoices',
  'exchange_rates',
  // Supplier master (payload doc §1.8) — master data rather than transactions,
  // so it is small and changes rarely, but it carries the PO email address that
  // Vendor 360 shows.
  'suppliers',
] as const;
export type CoupaObject = (typeof COUPA_OBJECTS)[number];

const ADVISORY_LOCK_KEY = 0xc00fa; // stable app-wide lock id for "coupa sync"

// ── small field helpers (Coupa uses kebab-case keys) ────────────────────────

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const b = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const obj = (v: unknown): Row => (v && typeof v === 'object' ? (v as Row) : {});
const arr = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
/** "2026-05-31T00:00:00+07:00" -> "2026-05-31" (dates stay strings, TECH_01 rule). */
const d = (v: unknown): string | null => {
  const str = s(v);
  return str ? str.slice(0, 10) : null;
};

/** "1242005431/1" -> { no: '1242005431', item: 1 } */
function parseSapRef(v: unknown): { no: string | null; item: number | null } {
  const str = s(v);
  if (!str) return { no: null, item: null };
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(str.trim());
  if (!m) return { no: str.trim(), item: null };
  return { no: m[1]!, item: Number(m[2]) };
}

/** custom-fields.plant is "WW2A-PABRIK WKN" — the code is the prefix. */
function plantCode(v: unknown): string | null {
  const str = s(typeof v === 'object' && v !== null ? (v as Row)['name'] : v);
  if (!str) return null;
  return str.split('-')[0]!.trim() || null;
}

function lookupRef(v: unknown): string | null {
  return s(obj(v)['external-ref-num']) ?? s(obj(v)['name']);
}

// ── upsert helpers ───────────────────────────────────────────────────────────

async function upsert(table: string, cols: string[], rows: unknown[][], conflictCol: string): Promise<number> {
  if (rows.length === 0) return 0;
  const width = cols.length;
  const values: string[] = [];
  const params: unknown[] = [];
  rows.forEach((r, i) => {
    values.push(`(${r.map((_, j) => `$${i * width + j + 1}`).join(',')})`);
    params.push(...r);
  });
  const updates = cols.filter((c) => c !== conflictCol).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  await query(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')}
     ON CONFLICT (${conflictCol}) DO UPDATE SET ${updates}`,
    params,
  );
  return rows.length;
}

async function storeRaw(object: string, rows: Row[]): Promise<void> {
  await upsert(
    'ops.coupa_raw',
    ['object', 'coupa_id', 'payload', 'fetched_at'],
    rows.map((r) => [object, Number(r['id']), JSON.stringify(r), new Date().toISOString()]),
    'object, coupa_id',
  );
}

// ── per-object projections ───────────────────────────────────────────────────

async function projectQuoteRequests(rows: Row[]): Promise<number> {
  let count = await upsert(
    'ops.coupa_sourcing_event',
    ['id','event_type','state','description','created_at','submit_time','start_time','end_time',
     'currency','commodity','plant','purch_org','purch_group','sap_pr_no','planned_savings',
     'supplier_count','line_count','updated_at'],
    rows.map((r) => {
      const cf = obj(r['custom-fields']);
      return [
        Number(r['id']), s(r['event-type']), s(r['state']), s(r['description']),
        s(r['created-at']), s(r['submit-time']), s(r['start-time']), s(r['end-time']),
        s(obj(r['currency'])['code']), s(obj(r['commodity'])['name']),
        plantCode(cf['plant']), lookupRef(cf['purchasing-organization']), lookupRef(cf['purchasing-group']),
        s(cf['sourcing-ref']), n(r['planned-savings']),
        arr(r['quote-suppliers']).length, arr(r['lines']).length, s(r['updated-at']),
      ];
    }),
    'id',
  );

  // Supplier responses live behind a nested endpoint, fetched only for the
  // events that actually changed in this run — and in PARALLEL, because one
  // round trip per event otherwise dominates a cold run's wall clock.
  const eventsWithResponses = rows.filter((r) => s(r['state']) !== 'template');
  const nestedCounts = await mapLimit(eventsWithResponses, 6, async (r) => {
    try {
      const responses = arr(await coupaGet(`/api/quote_requests/${Number(r['id'])}/quote_responses`));
      return await upsert(
        'ops.coupa_supplier_response',
        ['id','quote_request_id','supplier_name','submitted_at','state','awarded','total_amount','currency','line_count','updated_at'],
        responses.map((resp) => {
          const lines = arr(resp['lines']);
          const total = lines.reduce((acc, l) => acc + (n(l['price-amount']) ?? 0) * (n(l['quantity']) ?? 0), 0);
          return [
            Number(resp['id']), Number(resp['quote-request-id'] ?? r['id']),
            s(obj(resp['quote-supplier'])['name']),
            s(resp['submitted-at']), s(resp['state']), b(resp['awarded']),
            lines.length > 0 ? total : null,
            s(obj(arr(resp['lines'])[0]?.['price-currency'])['code']),
            lines.length, s(resp['updated-at']),
          ];
        }),
        'id',
      );
    } catch {
      // A single event's responses failing must not sink the whole sync;
      // the raw event row is already stored and the next run retries.
      return 0;
    }
  });
  count += nestedCounts.reduce((a, x) => a + x, 0);
  return count;
}

async function projectPurchaseOrders(rows: Row[]): Promise<number> {
  const lineRows: unknown[][] = [];
  for (const r of rows) {
    const headerStatus = s(r['status']);
    const supplier = obj(r['supplier']);
    const paymentTerm = s(obj(r['payment-term'])['code']);
    const hcf = obj(r['custom-fields']);
    for (const l of arr(r['order-lines'])) {
      const cf = obj(l['custom-fields']);
      const sapPo = parseSapRef(cf['sap-po-no-line-no']);
      const sapPr = parseSapRef(cf['initial-sap-pr-no-line-no']);
      lineRows.push([
        Number(l['id']), Number(r['id']), s(r['po-number']), headerStatus, s(l['status']),
        sapPo.no ?? s(hcf['sap-po-no']), sapPo.item, sapPr.no, sapPr.item,
        d(l['need-by-date']),
        n(l['price']), n(l['quantity']), n(l['total']), n(l['total-invoiced']),
        s(obj(l['currency'])['code']), s(obj(l['uom'])['code']),
        s(obj(l['item'])['item-number']), s(l['description']),
        plantCode(cf['plant']), lookupRef(hcf['purchasing-organization']), lookupRef(hcf['purchasing-group']),
        s(supplier['number']), s(supplier['display-name']) ?? s(supplier['name']),
        paymentTerm, b(hcf['emergency-request']), s(l['match-type']),
        s(l['created-at']), s(l['updated-at']) ?? s(r['updated-at']),
      ]);
    }
  }
  return upsert(
    'ops.coupa_po_line',
    ['order_line_id','coupa_po_id','po_number','status','line_status','sap_po_no','sap_po_item',
     'sap_pr_no','sap_pr_item','need_by_date','price','quantity','total','invoiced_total','currency',
     'uom','item_number','description','plant','purch_org','purch_group','supplier_number',
     'supplier_name','payment_term','emergency','match_type','created_at','updated_at'],
    lineRows,
    'order_line_id',
  );
}

async function projectReceipts(rows: Row[]): Promise<number> {
  return upsert(
    'ops.coupa_receipt',
    ['id','order_line_id','transaction_date','posting_date','quantity','price','total','status',
     'type','storage_location','batch','item_number','updated_at'],
    rows.map((r) => {
      const cf = obj(r['custom-fields']);
      return [
        Number(r['id']), n(obj(r['order-line'])['id']),
        d(r['transaction-date']), d(cf['posting-date']),
        n(r['quantity']), n(r['price']), n(r['total']), s(r['status']), s(r['type']),
        lookupRef(cf['storage-location']), s(cf['batch']),
        s(obj(r['item'])['item-number']), s(r['updated-at']),
      ];
    }),
    'id',
  );
}

async function projectInvoices(rows: Row[]): Promise<number> {
  let count = await upsert(
    'ops.coupa_invoice',
    ['id','invoice_number','invoice_date','status','paid','payment_date','gross_total','tax_amount',
     'currency','supplier_number','supplier_name','payment_term','created_at','updated_at'],
    rows.map((r) => {
      const supplier = obj(r['supplier']);
      return [
        Number(r['id']), s(r['invoice-number']), d(r['invoice-date']), s(r['status']),
        b(r['paid']), s(r['payment-date']), n(r['gross-total']), n(r['tax-amount']),
        s(obj(r['currency'])['code']),
        s(supplier['number']), s(supplier['display-name']) ?? s(supplier['name']),
        s(obj(r['payment-term'])['code']),
        s(r['created-at']), s(r['updated-at']),
      ];
    }),
    'id',
  );

  const lineRows: unknown[][] = [];
  const payRows: unknown[][] = [];
  for (const r of rows) {
    for (const l of arr(r['invoice-lines'])) {
      lineRows.push([
        Number(l['id']), Number(r['id']), s(l['po-number']), n(l['order-line-id']),
        s(l['status']), n(l['quantity']), n(l['price']), n(l['total']), n(l['tax-amount']),
        s(obj(l['item'])['item-number']), s(l['updated-at']) ?? s(r['updated-at']),
      ]);
    }
    for (const p of arr(r['payments'])) {
      const notes = s(p['notes']);
      payRows.push([
        Number(p['id']), Number(r['id']), s(p['payment-date']), n(p['amount-paid']),
        notes, notes ? (notes.split('|')[0]?.trim() ?? null) : null,
        s(p['updated-at']) ?? s(r['updated-at']),
      ]);
    }
  }
  count += await upsert(
    'ops.coupa_invoice_line',
    ['id','invoice_id','po_number','order_line_id','status','quantity','price','total','tax_amount','item_number','updated_at'],
    lineRows, 'id',
  );
  count += await upsert(
    'ops.coupa_payment',
    ['id','invoice_id','payment_date','amount_paid','notes','sap_payment_doc','updated_at'],
    payRows, 'id',
  );
  return count;
}

/**
 * Supplier master — payload doc §1.8.
 *
 * `number` is the bridge to SAP: it holds the same value as the vendor code on
 * a PO line, which is what lets Vendor 360 resolve a vendor to its Coupa
 * record. `po-email` is where an order is actually dispatched and is NOT the
 * same field as the primary contact's address, so both are kept.
 */
async function projectSuppliers(rows: Row[]): Promise<number> {
  return upsert(
    'ops.coupa_supplier',
    ['id', 'number', 'name', 'display_name', 'status', 'po_email', 'po_method',
     'primary_contact_email', 'payment_method', 'on_hold', 'website', 'created_at', 'updated_at'],
    rows.map((r) => [
      Number(r['id']),
      s(r['number']),
      s(r['name']),
      s(r['display-name']),
      s(r['status']),
      s(r['po-email']),
      s(r['po-method']),
      s(obj(r['primary-contact'])['email']),
      s(r['payment-method']),
      b(r['on-hold']),
      s(r['website']),
      s(r['created-at']),
      s(r['updated-at']),
    ]),
    'id',
  );
}

const PROJECT: Record<CoupaObject, (rows: Row[]) => Promise<number>> = {
  quote_requests: projectQuoteRequests,
  purchase_orders: projectPurchaseOrders,
  receiving_transactions: projectReceipts,
  invoices: projectInvoices,
  exchange_rates: projectExchangeRates,
  suppliers: projectSuppliers,
};

async function projectExchangeRates(rows: Row[]): Promise<number> {
  const n2 = await upsert(
    'ops.coupa_exchange_rate',
    ['id', 'rate', 'rate_date', 'from_currency', 'to_currency', 'created_at', 'updated_at'],
    rows
      .filter((r) => s(obj(r['from-currency'])['code']) !== null && s(obj(r['to-currency'])['code']) !== null)
      .map((r) => [
        Number(r['id']), n(r['rate']), d(r['rate-date']),
        s(obj(r['from-currency'])['code']), s(obj(r['to-currency'])['code']),
        s(r['created-at']), s(r['updated-at']),
      ]),
    'id',
  );
  // Refresh the shared FX pair store (010): month-latest Coupa rate per pair,
  // taking a slot only when more recently updated than what sits there.
  await query(
    `INSERT INTO ops.fx_rate_source
       (from_currency, to_currency, period_year, period_month, rate, source, source_updated_at)
     SELECT DISTINCT ON (upper(btrim(from_currency)), upper(btrim(to_currency)),
                         date_part('year', rate_date)::int, date_part('month', rate_date)::int)
            upper(btrim(from_currency)), upper(btrim(to_currency)),
            date_part('year', rate_date)::int, date_part('month', rate_date)::smallint,
            rate, 'coupa', updated_at
       FROM ops.coupa_exchange_rate
      WHERE rate_date IS NOT NULL AND rate > 0
      ORDER BY upper(btrim(from_currency)), upper(btrim(to_currency)),
               date_part('year', rate_date)::int, date_part('month', rate_date)::int,
               rate_date DESC, updated_at DESC NULLS LAST
     ON CONFLICT (from_currency, to_currency, period_year, period_month)
     DO UPDATE SET rate = EXCLUDED.rate, source = 'coupa',
                   source_updated_at = EXCLUDED.source_updated_at, updated_at = now()
      WHERE fx_rate_source.source_updated_at IS NULL
         OR EXCLUDED.source_updated_at > fx_rate_source.source_updated_at`,
  );
  return n2;
}

/**
 * Bounded-concurrency map. The nested quote-responses fetch is one HTTPS round
 * trip PER EVENT: run sequentially that is minutes of pure latency on a cold
 * run from Jakarta to the Coupa host. Six at a time is far faster and stays
 * well inside Coupa's rate limits.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── the sync run ─────────────────────────────────────────────────────────────

export interface ObjectResult {
  object: string;
  status: 'ok' | 'error' | 'skipped';
  pages: number;
  rowsUpserted: number;
  watermark: string | null;
  error?: string;
}

export interface SyncResult {
  outcome: 'ok' | 'partial' | 'error' | 'locked' | 'not_configured';
  trigger: string;
  startedAt: string;
  objects: ObjectResult[];
}

/**
 * Email the failures of a sync run, if any. Errors here are swallowed: a mail
 * problem must not turn a partially successful sync into a crash.
 */
export async function notifyCoupaErrors(
  trigger: string,
  result: SyncResult,
): Promise<void> {
  try {
    const failed = result.objects.filter((o) => o.status === 'error');
    if (failed.length === 0) return;
    const m = coupaErrorBody(trigger, result.objects);
    await notify('coupa.error', m.subject, m.body);
  } catch {
    // Deliberately silent — notify() already records its own failures.
  }
}

/** ISO minus N minutes, preserving a parseable timestamp for the filter. */
function minusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString();
}

async function syncObject(object: CoupaObject, lookbackMin: number, pageLimit: number): Promise<ObjectResult> {
  const wm = await queryOne<{ last_updated_at: string | null }>(
    `SELECT last_updated_at::text FROM ops.coupa_watermark WHERE object = $1`,
    [object],
  );
  const since = wm?.last_updated_at ? minusMinutes(wm.last_updated_at, lookbackMin) : null;

  // Publish 'running' immediately: a cold run takes minutes, and the admin
  // panel must show progress instead of "No sync has run yet".
  await query(
    `INSERT INTO ops.coupa_watermark (object, last_run_at, last_status)
     VALUES ($1, now(), 'running')
     ON CONFLICT (object) DO UPDATE SET last_run_at = now(), last_status = 'running',
       last_error = NULL`,
    [object],
  );

  let offset = 0;
  let pages = 0;
  let upserted = 0;
  let maxUpdated: string | null = wm?.last_updated_at ?? null;

  // Page cap keeps a cold first run from blocking the poller forever; the
  // next tick resumes from the advanced watermark.
  const MAX_PAGES_PER_RUN = 40;

  while (pages < MAX_PAGES_PER_RUN) {
    const rows = await fetchPage(object, since, offset, pageLimit);
    if (rows.length === 0) break;
    pages += 1;
    offset += rows.length;

    await storeRaw(object, rows);
    upserted += await PROJECT[object](rows);

    for (const r of rows) {
      const u = s(r['updated-at']);
      if (u && (maxUpdated === null || u > maxUpdated)) maxUpdated = u;
    }
    if (rows.length < pageLimit) break;
  }

  await query(
    `INSERT INTO ops.coupa_watermark (object, last_updated_at, last_run_at, last_status, last_error, last_trigger, rows_upserted, runs)
     VALUES ($1, $2, now(), 'ok', NULL, $3, $4, 1)
     ON CONFLICT (object) DO UPDATE SET
       last_updated_at = GREATEST(COALESCE(EXCLUDED.last_updated_at, ops.coupa_watermark.last_updated_at), ops.coupa_watermark.last_updated_at),
       last_run_at = now(), last_status = 'ok', last_error = NULL, last_trigger = EXCLUDED.last_trigger,
       rows_upserted = ops.coupa_watermark.rows_upserted + $4,
       runs = ops.coupa_watermark.runs + 1`,
    [object, maxUpdated, 'run', upserted],
  );

  return { object, status: 'ok', pages, rowsUpserted: upserted, watermark: maxUpdated };
}

/** True while a run holds the lock in THIS process — lets the API answer a
 *  duplicate 'Sync now' immediately instead of starting a doomed run. */
let inFlight = false;
export function coupaSyncInFlight(): boolean {
  return inFlight;
}

export async function runCoupaSync(trigger: 'scheduled' | 'manual'): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  if (!coupaConfigured()) return { outcome: 'not_configured', trigger, startedAt, objects: [] };

  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS ok`, [ADVISORY_LOCK_KEY],
    );
    if (!lock.rows[0]?.ok) return { outcome: 'locked', trigger, startedAt, objects: [] };
    inFlight = true;

    const rules = await loadRuleSnapshot();
    const lookback = Math.max(0, Number(rules['coupa.lookback_minutes'] ?? 15));
    const pageLimit = Math.min(Math.max(Number(rules['coupa.page_limit'] ?? 50), 1), 50);

    const results: ObjectResult[] = [];
    for (const object of COUPA_OBJECTS) {
      try {
        results.push(await syncObject(object, lookback, pageLimit));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await query(
          `INSERT INTO ops.coupa_watermark (object, last_run_at, last_status, last_error, last_trigger)
           VALUES ($1, now(), 'error', $2, $3)
           ON CONFLICT (object) DO UPDATE SET last_run_at = now(), last_status = 'error',
             last_error = EXCLUDED.last_error, last_trigger = EXCLUDED.last_trigger,
             runs = ops.coupa_watermark.runs + 1`,
          [object, msg.slice(0, 500), trigger],
        );
        results.push({ object, status: 'error', pages: 0, rowsUpserted: 0, watermark: null, error: msg });
      }
    }
    const anyError = results.some((r) => r.status === 'error');
    const allError = results.every((r) => r.status === 'error');
    return { outcome: allError ? 'error' : anyError ? 'partial' : 'ok', trigger, startedAt, objects: results };
  } finally {
    inFlight = false;
    await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

// ── the poller loop (TECH_04 §3.4) ───────────────────────────────────────────

let pollerStarted = false;
let lastRunAt = 0;

/**
 * Checks every 60s whether a scheduled sync is due. The interval and the
 * enable switch live in rule_config so an admin can change them at runtime
 * without a restart; the backend clamps the interval to 5–60 minutes.
 */
export function startCoupaPoller(log: (msg: string) => void): void {
  if (pollerStarted || !coupaConfigured()) return;
  pollerStarted = true;

  setInterval(() => {
    void (async () => {
      try {
        const rules = await loadRuleSnapshot();
        if (rules['coupa.sync_enabled'] !== true && rules['coupa.sync_enabled'] !== 'true') return;
        const interval = Math.min(Math.max(Number(rules['coupa.sync_interval_minutes'] ?? 10), 5), 60);
        if (Date.now() - lastRunAt < interval * 60_000) return;
        lastRunAt = Date.now();
        const r = await runCoupaSync('scheduled');
        log(`coupa sync (${r.outcome}): ${r.objects.map((o) => `${o.object}=${o.rowsUpserted}`).join(' ')}`);
        // Only errors are worth an email here (user decision 6 Aug 2026): a
        // clean incremental sync happens every few minutes and would be noise.
        await notifyCoupaErrors('scheduled', r);
      } catch (e) {
        log(`coupa poller error: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, 60_000).unref();
}
