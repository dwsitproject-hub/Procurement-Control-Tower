/**
 * Drill tokens — TECH 01 §6.4, PRD §13.8.
 *
 * The mechanism that makes "drill count equals aggregate count" true by
 * construction: the aggregate stores the predicate it was computed from, and the
 * drill re-executes that same predicate against the same immutable version.
 *
 * Tokens are ENCRYPTED, not merely signed: the predicate reveals filter internals
 * and the issuing scope, neither of which belongs in a client-visible string.
 * They are session-bound and scope-intersected on open, so a token cannot be
 * replayed by another session, cannot widen access, and cannot outlive a scope
 * revocation.
 */

import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { loadEnv } from '../../config/env.js';
import { query, queryOne } from '../../db/client.js';
import {
  intersectScopes, mintScopedQuery, scopeSql, type ScopeEntry,
} from '../authz/scope.js';
import { compileCustomFilter } from './custom.js';

const env = loadEnv();

// Derived from SESSION_SECRET, so rotating that also invalidates every token.
const KEY = createHash('sha256').update(`drill:${env.SESSION_SECRET}`).digest();

const TOKEN_TTL_SECONDS = 900; // 15 minutes

export type Grain = 'pr_item' | 'po_line' | 'gr_posting' | 'pr_release' | 'po_release';

export interface DrillPredicate {
  grain: Grain;
  filters: Record<string, unknown>;
  label?: string;
}

interface TokenPayload extends DrillPredicate {
  v: number; // dataset version — the drill reads the SAME version as the aggregate
  scope: ScopeEntry[];
  sid: string;
  exp: number;
}

export function issueDrillToken(
  predicate: DrillPredicate,
  datasetVersionId: number,
  scope: readonly ScopeEntry[],
  sessionFingerprint: string,
): string {
  const payload: TokenPayload = {
    ...predicate,
    v: datasetVersionId,
    scope: [...scope],
    sid: sessionFingerprint,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64url');
}

export class DrillTokenError extends Error {
  constructor(public readonly code: 'expired' | 'invalid' | 'foreign', message: string) {
    super(message);
  }
}

export function openDrillToken(
  token: string,
  sessionFingerprint: string,
  currentScope: readonly ScopeEntry[],
): TokenPayload {
  let payload: TokenPayload;
  try {
    const buf = Buffer.from(token, 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    payload = JSON.parse(pt) as TokenPayload;
  } catch {
    throw new DrillTokenError('invalid', 'invalid drill token');
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new DrillTokenError('expired', 'drill token expired');
  }
  if (payload.sid !== sessionFingerprint) {
    throw new DrillTokenError('foreign', 'drill token does not belong to this session');
  }

  // Defence in depth: intersect, never union.
  return { ...payload, scope: intersectScopes(payload.scope, currentScope) };
}

// ─────────────────────────────────────────────────────── predicate compiler

const TABLES: Record<Grain, { table: string; alias: string; order: string; id: string }> = {
  pr_item: { table: 'core.fact_pr_item', alias: 'f', order: 'f.pr_no, f.pr_item', id: "f.pr_no || '|' || f.pr_item" },
  po_line: { table: 'core.fact_po_line', alias: 'f', order: 'f.po_no, f.po_item', id: "f.po_no || '|' || f.po_item" },
  gr_posting: { table: 'core.fact_gr_posting', alias: 'f', order: 'f.material_doc, f.material_doc_item', id: "f.material_doc || '|' || f.material_doc_item" },
  pr_release: { table: 'core.fact_pr_release', alias: 'f', order: 'f.pr_no, f.pr_item, f.rel_seq', id: "f.pr_no || '|' || f.pr_item || '|' || f.rel_seq" },
  po_release: { table: 'core.fact_po_release', alias: 'f', order: 'f.po_no, f.rel_seq', id: "f.po_no || '|' || f.rel_seq" },
};

/**
 * Whitelisted filter compilers. An unknown key throws — fail closed. A predicate
 * never becomes a SQL string fragment; every value is a bound parameter.
 */
type Compiler = (v: unknown, alias: string, params: unknown[], grain: Grain) => string;

const asInt = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`expected an integer, got ${String(v)}`);
  return n;
};

const p = (params: unknown[], v: unknown): string => {
  params.push(v);
  return `$${params.length}`;
};

/**
 * The primary date column differs per grain. Hardcoding `document_date` here
 * produced a missing-column error the moment a PR-grain chart drilled by month,
 * so the mapping is explicit and a grain without a primary date fails loudly.
 */
const PRIMARY_DATE: Record<Grain, string | null> = {
  pr_item: 'requisition_date',
  po_line: 'document_date',
  gr_posting: 'posting_date',
  pr_release: 'approve_date',
  po_release: 'po_date',
};

function monthExpr(alias: string, grain: Grain): string {
  const col = PRIMARY_DATE[grain];
  if (col === null) throw new Error(`grain ${grain} has no primary date column to bucket by month`);
  return `to_char(${alias}.${col}, 'YYYY-MM')`;
}

const FILTERS: Record<string, Compiler> = {
  // Filters the mart aggregates apply. Every predicate must carry the SAME
  // filters as the query that produced its number — the omission of these two is
  // what made 29 chart points drill to a higher count than they displayed.
  notSto: (_v, a) => `NOT ${a}.is_sto`,
  notDeleted: (_v, a) => `NOT ${a}.is_deleted`,
  deletedOnly: (_v, a) => `${a}.is_deleted`,
  hasOpenCommitment: (_v, a) => `COALESCE(${a}.still_deliver_val, 0) > 0`,
  grirOpen: (_v, a) =>
    `COALESCE(${a}.still_deliver_qty, 0) = 0 AND COALESCE(${a}.still_invoice_val, 0) > 0`,
  urgencyLte: (v, a, ps) => `${a}.urgency <= ${p(ps, asInt(v))}`,
  priorityLabel: (v, a, ps) =>
    v === null ? `${a}.priority_label IS NULL` : `${a}.priority_label = ${p(ps, String(v))}`,
  matCat: (v, a, ps) =>
    v === null ? `${a}.material_category IS NULL` : `${a}.material_category = ${p(ps, String(v))}`,
  prNoPo: (_v, a) => `${a}.po_line_count = 0`,
  hasPo: (_v, a) => `${a}.po_line_count > 0`,
  hasPr: (_v, a) => `${a}.pr_no IS NOT NULL`,
  unreleased: (_v, a) => `${a}.release_final_date IS NULL`,
  released: (_v, a) => `${a}.release_final_date IS NOT NULL`,
  purchOrg: (v, a, ps) => `${a}.purch_org = ${p(ps, String(v))}`,
  /**
   * Histogram bucket. Without this every bar in a distribution chart drilled to
   * the whole population, because the bucket range was in the aggregate's CASE
   * expression but not in the stored predicate.
   *
   * Boundaries mirror the aggregate's CASE exactly, including that '0-3' catches
   * negative values the way v1's buckets do.
   */
  distBucket: (v, a, ps) => {
    const o = v as { measure?: string; bucket?: string };
    const COL: Record<string, string> = {
      pr_approval: `(${a}.release_final_date - ${a}.requisition_date)`,
      po_approval: `${a}.po_approval_days`,
      delivery: `${a}.delivery_days`,
      aging: `${a}.aging_days`,
    };
    const col = COL[o.measure ?? ''];
    if (!col) throw new Error(`unknown distribution measure: ${String(o.measure)}`);

    const UPPER: Record<string, [number | null, number | null]> = {
      '0-3': [null, 3],
      '4-7': [3, 7],
      '8-14': [7, 14],
      '15-30': [14, 30],
      '31-60': [30, 60],
      '60+': [60, null],
    };
    const r = UPPER[o.bucket ?? ''];
    if (!r) throw new Error(`unknown distribution bucket: ${String(o.bucket)}`);

    const parts: string[] = [`${col} IS NOT NULL`];
    if (r[0] !== null) parts.push(`${col} > ${p(ps, r[0])}`);
    if (r[1] !== null) parts.push(`${col} <= ${p(ps, r[1])}`);
    return `(${parts.join(' AND ')})`;
  },
  // ── global filters (W2) ──
  // Merged into every predicate issued from a filtered figure, so a card and its
  // drill can never disagree once a filter is applied.
  companyCodeIn: (v, a, ps) => `${a}.company_code = ANY(${p(ps, (v as unknown[]).map(String))})`,
  plantIn: (v, a, ps) => `${a}.plant = ANY(${p(ps, (v as unknown[]).map(String))})`,
  purchOrgIn: (v, a, ps) => `${a}.purch_org = ANY(${p(ps, (v as unknown[]).map(String))})`,
  monthKeyIn: (v, a, ps, grain) =>
    `${monthExpr(a, grain)} = ANY(${p(ps, (v as unknown[]).map(String))})`,

  /**
   * A lead-time chart only aggregates rows where its measure exists (a sourcing
   * time needs a PR release; an approval time needs a release record). The
   * predicate must say so too, or the drill returns every line and over-counts.
   */
  measureNotNull: (v, a) => {
    const COL: Record<string, string> = {
      sourcing: 'sourcing_days',
      po_approval: 'po_approval_days',
      delivery: 'delivery_days',
    };
    const col = COL[String(v)];
    if (!col) throw new Error(`unknown measure: ${String(v)}`);
    return `${a}.${col} IS NOT NULL`;
  },
  status: (v, a, ps) => `${a}.status = ${p(ps, String(v))}`,
  statusIn: (v, a, ps) => `${a}.status = ANY(${p(ps, (v as unknown[]).map(String))})`,
  plant: (v, a, ps) => `${a}.plant = ${p(ps, String(v))}`,
  companyCode: (v, a, ps) => `${a}.company_code = ${p(ps, String(v))}`,
  purchGroup: (v, a, ps) =>
    v === null ? `${a}.purch_group IS NULL` : `${a}.purch_group = ${p(ps, String(v))}`,
  vendorCode: (v, a, ps) => `${a}.vendor_code = ${p(ps, String(v))}`,
  materialCode: (v, a, ps) => `${a}.material_code = ${p(ps, String(v))}`,
  materialGroup: (v, a, ps) => `${a}.material_group = ${p(ps, String(v))}`,
  monthKey: (v, a, ps, grain) => `${monthExpr(a, grain)} = ${p(ps, String(v))}`,
  isSto: (v, a, ps) => `${a}.is_sto = ${p(ps, Boolean(v))}`,
  isTokenPrice: (v, a, ps) => `${a}.is_token_price = ${p(ps, Boolean(v))}`,
  isZeroPrice: (v, a, ps) => `${a}.is_zero_price = ${p(ps, Boolean(v))}`,
  isRetroPo: (v, a, ps) => `${a}.is_retro_po = ${p(ps, Boolean(v))}`,
  releaseExempt: (v, a, ps) => `${a}.release_exempt = ${p(ps, Boolean(v))}`,
  // A direct PO carries no requisition reference at all; a dangling line carries
  // one that does not resolve. Deliberately separate filters.
  directPo: () => `f.link_status IS NULL`,
  linkStatus: (v, a, ps) => `${a}.link_status = ${p(ps, String(v))}`,
  splitSourced: () =>
    `EXISTS (SELECT 1 FROM core.bridge_pr_po b WHERE b.dataset_version_id = f.dataset_version_id
              AND b.po_no = f.po_no AND b.po_item = f.po_item AND b.split_total > 1)`,
  poReleaseState: (v, a, ps) => `${a}.po_release_state = ${p(ps, String(v))}`,
  wbsStatus: (v, a, ps) => `${a}.wbs_status = ${p(ps, String(v))}`,
  urgencyIn: (v, a, ps) => `${a}.urgency = ANY(${p(ps, (v as unknown[]).map(Number))})`,
  agingGt: (v, a, ps) => `${a}.aging_days > ${p(ps, Number(v))}`,
  agingBand: (v, a, ps) => {
    const band = String(v);
    const ranges: Record<string, string> = {
      '0-30': `${a}.aging_days <= 30`,
      '31-60': `${a}.aging_days > 30 AND ${a}.aging_days <= 60`,
      '61-90': `${a}.aging_days > 60 AND ${a}.aging_days <= 90`,
      '91-180': `${a}.aging_days > 90 AND ${a}.aging_days <= 180`,
      '180+': `${a}.aging_days > 180`,
    };
    const clause = ranges[band];
    if (!clause) throw new Error(`unknown aging band: ${band}`);
    void ps;
    return clause;
  },
  // The full open set. Listing only the PO-side statuses made every PR-grain
  // "open" drill under-count, because 'Unapproved PR' and 'PR Approved-No PO'
  // were silently excluded.
  open: (_v, a) =>
    `${a}.status IN ('Unapproved PR','PR Approved-No PO','PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered')`,
  hasReceipt: (v, a) => (v ? `${a}.receipt_date IS NOT NULL` : `${a}.receipt_date IS NULL`),
  movementType: (v, a, ps) => `${a}.movement_type = ${p(ps, String(v))}`,
  postingClass: (v, a, ps) => `${a}.posting_class = ${p(ps, String(v))}`,
  picRelease: (v, a, ps) =>
    v === null ? `${a}.pic_release IS NULL` : `${a}.pic_release = ${p(ps, String(v))}`,
  pending: (v, a) => (v ? `${a}.approve_date IS NULL` : `${a}.approve_date IS NOT NULL`),
  eindtEqualsDocdate: (v, a, ps) => `${a}.eindt_equals_docdate = ${p(ps, Boolean(v))}`,
  demandUnrealistic: (_v, a) => `${a}.need_by_date IS NOT NULL`,
  hasInfoRecord: (v, a) => (v ? `${a}.info_record IS NOT NULL` : `${a}.info_record IS NULL`),
  valuedIdr: (_v, a) => `COALESCE(${a}.total_value_idr, 0) > 0`,
  // v1's four age bands (Open Items page). NULL aging never matches a band.
  ageBand4: (v, a) => {
    const ranges: Record<string, string> = {
      '0-15': `${a}.aging_days <= 15`,
      '15-30': `${a}.aging_days > 15 AND ${a}.aging_days <= 30`,
      '31-90': `${a}.aging_days > 30 AND ${a}.aging_days <= 90`,
      '>90': `${a}.aging_days > 90`,
    };
    const r = ranges[String(v)];
    if (!r) throw new Error(`unknown ageBand4: ${String(v)}`);
    return `(${r})`;
  },
  // v1's 'Urgent PO (PO before PR)': the PO document predates its requisition.
  poBeforePr: (_v, a) =>
    `EXISTS (SELECT 1 FROM core.fact_pr_item _pr
              WHERE _pr.dataset_version_id = ${a}.dataset_version_id
                AND _pr.pr_no = ${a}.pr_no AND _pr.pr_item = ${a}.pr_item
                AND ${a}.document_date < _pr.requisition_date)`,
  currencyIs: (v, a, ps) => `${a}.currency_code = ${p(ps, String(v))}`,
  foreignCcy: (_v, a) => `${a}.currency_code <> 'IDR'`,
  // The global scope toggle (G2.2), grain-aware to mirror buildFilterClause
  // EXACTLY — a converted PR item's own status never reaches 'Delivered', so
  // the PR grain consults its PO lines. Any drift here would break the
  // card-equals-drill guarantee under scope.
  scopeOpen: (_v, a, _ps, grain) =>
    grain === 'pr_item'
      ? `(${a}.status IN ('Unapproved PR','PR Approved-No PO')
          OR EXISTS (SELECT 1 FROM core.fact_po_line _pl
                      WHERE _pl.dataset_version_id = ${a}.dataset_version_id
                        AND _pl.pr_no = ${a}.pr_no AND _pl.pr_item = ${a}.pr_item
                        AND _pl.status IN ('PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered')))`
      : `${a}.status IN ('Unapproved PR','PR Approved-No PO','PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered')`,
  scopeComplete: (_v, a, _ps, grain) =>
    grain === 'pr_item'
      ? `EXISTS (SELECT 1 FROM core.fact_po_line _pl
                  WHERE _pl.dataset_version_id = ${a}.dataset_version_id
                    AND _pl.pr_no = ${a}.pr_no AND _pl.pr_item = ${a}.pr_item
                    AND _pl.status = 'Delivered')`
      : `${a}.status = 'Delivered'`,
  // On-Time vs Requested (D4): a line is evaluable only when both the receipt
  // and the requested date exist. Empty until EBAN-LFDAT reaches the export.
  otdrEvaluable: (_v, a) => `${a}.receipt_date IS NOT NULL AND ${a}.need_by_date IS NOT NULL`,
  // v1's open definition (OPEN_ST + "any GR means Delivered"): a PR item is
  // open while no PO exists, or while its POs are unapproved/held/awaiting GR
  // AND no linked line has received ANY goods. Differs from scopeOpen, which
  // treats partially-delivered items as still open (the v2 house definition).
  openBeforeGr: (_v, a, _ps, grain) => {
    if (grain !== 'pr_item') throw new Error('openBeforeGr is a PR-item filter');
    return `(${a}.status IN ('Unapproved PR','PR Approved-No PO')
             OR (EXISTS (SELECT 1 FROM core.fact_po_line _pl
                          WHERE _pl.dataset_version_id = ${a}.dataset_version_id
                            AND _pl.pr_no = ${a}.pr_no AND _pl.pr_item = ${a}.pr_item
                            AND _pl.status IN ('PO-Not Approved','HOLD PO','PO-No GR'))
                 AND NOT EXISTS (SELECT 1 FROM core.fact_po_line _pl2
                          WHERE _pl2.dataset_version_id = ${a}.dataset_version_id
                            AND _pl2.pr_no = ${a}.pr_no AND _pl2.pr_item = ${a}.pr_item
                            AND _pl2.status IN ('Delivered','Partially Delivered'))))`;
  },
};

export interface DrillPage {
  label: string;
  grain: Grain;
  datasetVersionId: number;
  totalCount: number;
  note: string | null;
  columns: { key: string; label: string; type: string; currency?: string }[];
  rows: Record<string, unknown>[];
  nextCursor: string | null;
  /**
   * Value totals over the WHOLE drill population (not the page) — v1's dd-modal
   * header. Only for money-bearing grains. usdSum obeys the strict-FX rule:
   * null when any line's currency is unrated, with usdComplete saying so.
   */
  totals: { idrSum: number | null; usdSum: number | null; usdComplete: boolean } | null;
  /**
   * "Open in Detail tab" (v1's dd-modal button): the drill filters translated
   * into Detail-table query params, with any untranslatable keys named so the
   * UI can say the handoff is approximate rather than pretending.
   */
  detailHandoff: { params: Record<string, string>; unmapped: string[] } | null;
}

/** Drill-filter keys → detail-table query params. Anything absent is unmapped. */
function detailHandoffFor(filters: Record<string, unknown>): DrillPage['detailHandoff'] {
  const params: Record<string, string> = {};
  const unmapped: string[] = [];
  for (const [k, v] of Object.entries(filters)) {
    switch (k) {
      case 'status': params['status'] = String(v); break;
      case 'matCat': params['matCat'] = String(v); break;
      case 'plant': params['plant'] = String(v); break;
      case 'plantIn': params['plant'] = (v as unknown[]).map(String).join(','); break;
      case 'purchOrg': params['purchOrg'] = String(v); break;
      case 'purchOrgIn': params['purchOrg'] = (v as unknown[]).map(String).join(','); break;
      case 'purchGroup': params['purchGroup'] = String(v); break;
      case 'companyCode': params['company'] = String(v); break;
      case 'companyCodeIn': params['company'] = (v as unknown[]).map(String).join(','); break;
      case 'priorityLabel': params['priority'] = String(v); break;
      case 'notSto': if (v) params['excludeSto'] = 'true'; break;
      case 'open': params['onlyOpen'] = 'true'; break;
      case 'vendorCode': case 'materialCode': params['q'] = String(v); break;
      case 'notDeleted': break; // detail excludes deleted by default
      default: unmapped.push(k);
    }
  }
  return { params, unmapped };
}

const COLUMNS: Record<Grain, DrillPage['columns']> = {
  pr_item: [
    { key: 'prNo', label: 'PR No', type: 'string' },
    { key: 'prItem', label: 'Item', type: 'int' },
    { key: 'shortText', label: 'Description', type: 'string' },
    { key: 'plant', label: 'Plant', type: 'string' },
    { key: 'totalValueIdr', label: 'Value IDR', type: 'money', currency: 'IDR' },
    { key: 'wbsStatus', label: 'WBS', type: 'enum' },
    { key: 'status', label: 'Status', type: 'enum' },
    { key: 'requisitionDate', label: 'PR date', type: 'date' },
    { key: 'agingDays', label: 'Aging (d)', type: 'int' },
  ],
  po_line: [
    { key: 'poNo', label: 'PO No', type: 'string' },
    { key: 'poItem', label: 'Item', type: 'int' },
    { key: 'prNo', label: 'PR No', type: 'string' },
    { key: 'shortText', label: 'Description', type: 'string' },
    { key: 'vendorName', label: 'Vendor', type: 'string' },
    { key: 'plant', label: 'Plant', type: 'string' },
    { key: 'netOrderValue', label: 'Value', type: 'money' },
    { key: 'currencyCode', label: 'Ccy', type: 'string' },
    { key: 'netOrderValueUsd', label: 'Value USD', type: 'money', currency: 'USD' },
    { key: 'status', label: 'Status', type: 'enum' },
    { key: 'documentDate', label: 'PO date', type: 'date' },
    { key: 'receiptDate', label: 'GR date', type: 'date' },
    { key: 'agingDays', label: 'Aging (d)', type: 'int' },
  ],
  gr_posting: [
    { key: 'materialDoc', label: 'Mat. doc', type: 'string' },
    { key: 'poNo', label: 'PO No', type: 'string' },
    { key: 'poItem', label: 'Item', type: 'int' },
    { key: 'movementType', label: 'Mvt', type: 'string' },
    { key: 'postingClass', label: 'Class', type: 'enum' },
    { key: 'postingDate', label: 'Posting date', type: 'date' },
    { key: 'signedQty', label: 'Signed qty', type: 'number' },
    { key: 'materialDesc', label: 'Material', type: 'string' },
  ],
  pr_release: [
    { key: 'prNo', label: 'PR No', type: 'string' },
    { key: 'prItem', label: 'Item', type: 'int' },
    { key: 'relSeq', label: 'Seq', type: 'int' },
    { key: 'picRelease', label: 'Approver', type: 'string' },
    { key: 'status', label: 'Status', type: 'enum' },
    { key: 'approveDate', label: 'Approved', type: 'date' },
    { key: 'wasContinuation', label: 'Filled', type: 'string' },
  ],
  po_release: [
    { key: 'poNo', label: 'PO No', type: 'string' },
    { key: 'relSeq', label: 'Seq', type: 'int' },
    { key: 'picRelease', label: 'Approver', type: 'string' },
    { key: 'amount', label: 'Amount', type: 'money' },
    { key: 'currencyCode', label: 'Ccy', type: 'string' },
    { key: 'approveDate', label: 'Approved', type: 'date' },
  ],
};

const SELECTS: Record<Grain, string> = {
  pr_item: `f.pr_no AS "prNo", f.pr_item AS "prItem", f.short_text AS "shortText", f.plant,
            f.total_value_idr AS "totalValueIdr", f.wbs_status AS "wbsStatus", f.status,
            f.requisition_date AS "requisitionDate", f.aging_days AS "agingDays"`,
  po_line: `f.po_no AS "poNo", f.po_item AS "poItem", f.pr_no AS "prNo", f.short_text AS "shortText",
            f.vendor_name AS "vendorName", f.plant, f.net_order_value AS "netOrderValue",
            f.currency_code AS "currencyCode", f.net_order_value_usd AS "netOrderValueUsd",
            f.status, f.document_date AS "documentDate", f.receipt_date AS "receiptDate",
            f.aging_days AS "agingDays", f.is_sto AS "_sto", f.release_exempt AS "_exempt",
            f.is_token_price AS "_token", f.link_status AS "_link"`,
  gr_posting: `f.material_doc AS "materialDoc", f.po_no AS "poNo", f.po_item AS "poItem",
               f.movement_type AS "movementType", f.posting_class AS "postingClass",
               f.posting_date AS "postingDate", f.signed_qty AS "signedQty",
               f.material_desc AS "materialDesc"`,
  pr_release: `f.pr_no AS "prNo", f.pr_item AS "prItem", f.rel_seq AS "relSeq",
               f.pic_release AS "picRelease", f.status, f.approve_date AS "approveDate",
               f.was_continuation AS "wasContinuation"`,
  po_release: `f.po_no AS "poNo", f.rel_seq AS "relSeq", f.pic_release AS "picRelease",
               f.amount, f.currency_code AS "currencyCode", f.approve_date AS "approveDate"`,
};

export async function executeDrill(
  payload: TokenPayload,
  limit: number,
  offset: number,
): Promise<DrillPage> {
  const t = TABLES[payload.grain];
  const params: unknown[] = [payload.v];
  const where: string[] = [`${t.alias}.dataset_version_id = $1`];

  const sq = mintScopedQuery('drill', payload.scope);
  where.push(scopeSql(sq, t.alias, params));

  for (const [k, v] of Object.entries(payload.filters ?? {})) {
    // User-defined specs (W7) prefix their filters `custom:` and compile against
    // their own whitelist, keeping this static one closed.
    if (k.startsWith('custom:')) {
      where.push(compileCustomFilter(k, v, t.alias, params, payload.grain));
      continue;
    }
    const compiler = FILTERS[k];
    if (!compiler) throw new Error(`unknown drill filter: ${k}`);
    where.push(compiler(v, t.alias, params, payload.grain));
  }

  const whereSql = where.join(' AND ');

  // Count and value totals in one pass. IDR sum is exact (document currency);
  // the USD sum follows the strict no-silent-conversion rule.
  const TOTAL_EXPR: Partial<Record<Grain, string>> = {
    pr_item: `sum(${t.alias}.total_value_idr) AS idr_sum, NULL::numeric AS usd_sum, 0::int AS unrated`,
    po_line: `sum(${t.alias}.net_order_value) FILTER (WHERE ${t.alias}.currency_code = 'IDR') AS idr_sum,
              sum(${t.alias}.net_order_value_usd) AS usd_sum,
              count(*) FILTER (WHERE ${t.alias}.net_order_value IS NOT NULL AND ${t.alias}.net_order_value_usd IS NULL)::int AS unrated`,
  };
  const totalExpr = TOTAL_EXPR[payload.grain];
  const countRow = await queryOne<{ n: number; idr_sum: number | null; usd_sum: number | null; unrated: number }>(
    `SELECT count(*)::int AS n${totalExpr ? `, ${totalExpr}` : ''}
       FROM ${t.table} ${t.alias} WHERE ${whereSql}`,
    params,
  );
  const total = countRow?.n ?? 0;
  const totals = totalExpr && countRow
    ? {
        idrSum: countRow.idr_sum === null ? null : Number(countRow.idr_sum),
        usdSum: countRow.unrated > 0 || countRow.usd_sum === null ? null : Number(countRow.usd_sum),
        usdComplete: countRow.unrated === 0,
      }
    : null;

  const pageParams = [...params, limit, offset];
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECTS[payload.grain]} FROM ${t.table} ${t.alias}
      WHERE ${whereSql} ORDER BY ${t.order}
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );

  // Row flags drive the UI markers: STO, token price, release-exempt, dangling.
  const decorated = rows.map((r) => {
    const flags: string[] = [];
    if (r['_sto']) flags.push('sto');
    if (r['_token']) flags.push('tokenPrice');
    if (r['_exempt']) flags.push('releaseExempt');
    if (r['_link'] === 'dangling') flags.push('danglingLink');
    if (payload.grain === 'po_line' && r['_link'] === null) flags.push('directPo');
    for (const k of ['_sto', '_token', '_exempt', '_link']) delete r[k];
    return { ...r, flags };
  });

  const note =
    payload.grain === 'po_line' && payload.filters['directPo']
      ? 'direct POs (no PR link)'
      : payload.scope.length === 0
        ? 'no rows are within your data scope'
        : null;

  return {
    label: payload.label ?? describeFilters(payload),
    grain: payload.grain,
    datasetVersionId: payload.v,
    totalCount: total,
    note,
    columns: COLUMNS[payload.grain],
    rows: decorated,
    nextCursor: offset + rows.length < total ? String(offset + rows.length) : null,
    totals,
    // Detail rows are PR×PO grain; only pr/po drills translate meaningfully.
    detailHandoff:
      payload.grain === 'po_line' || payload.grain === 'pr_item'
        ? detailHandoffFor(payload.filters ?? {})
        : null,
  };
}

function describeFilters(payload: DrillPredicate): string {
  const parts = Object.entries(payload.filters ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return parts.length > 0 ? `${payload.grain}: ${parts.join(', ')}` : payload.grain;
}
