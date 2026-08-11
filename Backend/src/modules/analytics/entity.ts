/**
 * Entity views — W3. v1's pg-v360 (Vendor 360), mx-modal (Material) and pg-mg
 * (Material Group) pages.
 *
 * Same honesty rules as everywhere else: unknown is null (never 0), USD totals
 * only when every currency converted, STO lines visible but tagged and excluded
 * from price/spend statistics, and every list capped explicitly rather than
 * silently truncated.
 */

import { query, queryOne } from '../../db/client.js';
import { mintScopedQuery, scopeSql, type ScopeEntry } from '../authz/scope.js';

const OPEN_STATUSES = `('Unapproved PR','PR Approved-No PO','PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered')`;

function scoped(versionId: number, scope: readonly ScopeEntry[], alias: string): { where: string; params: unknown[] } {
  const params: unknown[] = [versionId];
  const s = scopeSql(mintScopedQuery('entity', scope), alias, params);
  return { where: `${alias}.dataset_version_id = $1 AND ${s}`, params };
}

// ────────────────────────────────────────────────────────────── vendor list

export interface VendorRow {
  vendorCode: string;
  vendorName: string;
  /**
   * Where this vendor's orders are sent — Coupa's supplier master, matched on
   * the supplier number (payload doc §1.8). Null when the vendor has no Coupa
   * record, or has one with no address filled in; the table distinguishes the
   * two so a blank cell never has to be guessed at.
   */
  poEmail: string | null;
  inCoupa: boolean;
  poCount: number;
  lineCount: number;
  spendUsd: number | null;
  spendConverted: boolean;
  materials: number;
  areas: number;
  otdPct: number | null;
  avgDaysLate: number | null;
  openExposureUsd: number | null;
}

export async function vendorList(
  versionId: number,
  scope: readonly ScopeEntry[],
  search: string,
  limit: number,
  offset = 0,
): Promise<{ totalVendors: number; rows: VendorRow[] }> {
  const { where, params } = scoped(versionId, scope, 'pol');

  let searchSql = '';
  if (search.trim() !== '') {
    params.push(`%${search.trim()}%`);
    searchSql = ` AND (pol.vendor_name ILIKE $${params.length} OR pol.vendor_code ILIKE $${params.length})`;
  }

  const total = await queryOne<{ n: number }>(
    `SELECT count(DISTINCT vendor_code)::int AS n FROM core.fact_po_line pol
      WHERE ${where}${searchSql} AND pol.vendor_code IS NOT NULL AND NOT pol.is_sto`,
    params,
  );

  params.push(limit);
  const rows = await query<{
    vendor_code: string; vendor_name: string; po_count: number; line_count: number;
    spend_usd: number | null; unconverted: number; materials: number; areas: number;
    otd_num: number; otd_den: number; avg_late: number | null; open_usd: number | null;
    po_email: string | null; in_coupa: boolean;
  }>(
    `SELECT pol.vendor_code,
            max(pol.vendor_name) AS vendor_name,
            count(DISTINCT pol.po_no)::int AS po_count,
            count(*)::int AS line_count,
            sum(pol.net_order_value_usd) AS spend_usd,
            count(*) FILTER (WHERE pol.net_order_value IS NOT NULL AND pol.net_order_value_usd IS NULL)::int AS unconverted,
            count(DISTINCT pol.material_code)::int AS materials,
            count(DISTINCT pol.plant)::int AS areas,
            count(*) FILTER (WHERE pol.receipt_date IS NOT NULL AND pol.delivery_date IS NOT NULL
                             AND pol.receipt_date <= pol.delivery_date + 7)::int AS otd_num,
            count(*) FILTER (WHERE pol.receipt_date IS NOT NULL AND pol.delivery_date IS NOT NULL)::int AS otd_den,
            avg(pol.receipt_date - pol.delivery_date)
              FILTER (WHERE pol.receipt_date > pol.delivery_date) AS avg_late,
            sum(pol.still_deliver_val_usd) FILTER (WHERE COALESCE(pol.still_deliver_val,0) > 0) AS open_usd,
            -- Supplier master is current state, not a versioned fact, so it is
            -- read live and joined per vendor. A LATERAL keeps it one row even
            -- if the master ever holds duplicates of a number.
            max(sup.po_email) AS po_email,
            bool_or(sup.number IS NOT NULL) AS in_coupa
       FROM core.fact_po_line pol
       LEFT JOIN LATERAL (
         SELECT number, po_email FROM ops.coupa_supplier c
          WHERE c.number = pol.vendor_code
          ORDER BY c.updated_at DESC NULLS LAST LIMIT 1
       ) sup ON true
      WHERE ${where}${searchSql} AND pol.vendor_code IS NOT NULL AND NOT pol.is_sto
      GROUP BY pol.vendor_code
      ORDER BY spend_usd DESC NULLS LAST
      LIMIT $${params.length} OFFSET $${(params.push(offset), params.length)}`,
    params,
  );

  return {
    totalVendors: total?.n ?? 0,
    rows: rows.map((r) => ({
      vendorCode: r.vendor_code,
      vendorName: r.vendor_name,
      poEmail: r.po_email,
      inCoupa: r.in_coupa,
      poCount: r.po_count,
      lineCount: r.line_count,
      // Strict rule: if any line failed to convert, the USD total is incomplete
      // and must not present as a full figure.
      spendUsd: r.unconverted > 0 ? null : r.spend_usd,
      spendConverted: r.unconverted === 0,
      materials: r.materials,
      areas: r.areas,
      otdPct: r.otd_den > 0 ? Math.round((r.otd_num / r.otd_den) * 1000) / 10 : null,
      avgDaysLate: r.avg_late === null ? null : Math.round(Number(r.avg_late) * 10) / 10,
      openExposureUsd: r.open_usd,
    })),
  };
}

// ──────────────────────────────────────────────────────────── vendor detail

export async function vendorDetail(
  versionId: number,
  scope: readonly ScopeEntry[],
  vendorCode: string,
): Promise<Record<string, unknown> | null> {
  const { where, params } = scoped(versionId, scope, 'pol');
  params.push(vendorCode);
  const vp = `$${params.length}`;

  const bio = await queryOne<{
    vendor_name: string; po_count: number; line_count: number; spend_usd: number | null;
    unconverted: number; materials: number; areas: number; first_seen: string; last_seen: string;
    otd_num: number; otd_den: number; avg_late: number | null;
    open_usd: number | null; grir_usd: number | null; rev_101: number; rev_reversals: number;
    otdr_num: number; otdr_den: number;
  }>(
    `SELECT max(pol.vendor_name) AS vendor_name,
            count(DISTINCT pol.po_no)::int AS po_count,
            count(*)::int AS line_count,
            sum(pol.net_order_value_usd) AS spend_usd,
            count(*) FILTER (WHERE pol.net_order_value IS NOT NULL AND pol.net_order_value_usd IS NULL)::int AS unconverted,
            count(DISTINCT pol.material_code)::int AS materials,
            count(DISTINCT pol.plant)::int AS areas,
            min(pol.document_date)::text AS first_seen,
            max(pol.document_date)::text AS last_seen,
            count(*) FILTER (WHERE pol.receipt_date IS NOT NULL AND pol.delivery_date IS NOT NULL
                             AND pol.receipt_date <= pol.delivery_date + 7)::int AS otd_num,
            count(*) FILTER (WHERE pol.receipt_date IS NOT NULL AND pol.delivery_date IS NOT NULL)::int AS otd_den,
            avg(pol.receipt_date - pol.delivery_date)
              FILTER (WHERE pol.receipt_date > pol.delivery_date) AS avg_late,
            sum(pol.still_deliver_val_usd) FILTER (WHERE COALESCE(pol.still_deliver_val,0) > 0) AS open_usd,
            sum(pol.still_invoice_val_usd)
              FILTER (WHERE COALESCE(pol.still_deliver_qty,0) = 0 AND COALESCE(pol.still_invoice_val,0) > 0) AS grir_usd,
            sum(pol.receipt_count)::int AS rev_101,
            sum(pol.reversal_count)::int AS rev_reversals,
            count(*) FILTER (WHERE pol.receipt_date IS NOT NULL AND pol.need_by_date IS NOT NULL
                             AND pol.receipt_date <= pol.need_by_date)::int AS otdr_num,
            count(*) FILTER (WHERE pol.receipt_date IS NOT NULL AND pol.need_by_date IS NOT NULL)::int AS otdr_den
       FROM core.fact_po_line pol
      WHERE ${where} AND pol.vendor_code = ${vp} AND NOT pol.is_sto`,
    params,
  );
  if (!bio || bio.line_count === 0) return null;

  // Per-currency composition — the strict rule's honest fallback.
  const byCcy = await query<{ ccy: string; amount: number; usd: number | null; unconv: number }>(
    `SELECT pol.currency_code AS ccy, sum(pol.net_order_value) AS amount,
            sum(pol.net_order_value_usd) AS usd,
            count(*) FILTER (WHERE pol.net_order_value IS NOT NULL AND pol.net_order_value_usd IS NULL)::int AS unconv
       FROM core.fact_po_line pol
      WHERE ${where} AND pol.vendor_code = ${vp} AND NOT pol.is_sto
      GROUP BY 1 ORDER BY 2 DESC`,
    params,
  );

  const spendByMonth = await query<{ mk: string; usd: number | null; n: number }>(
    `SELECT to_char(pol.document_date,'YYYY-MM') AS mk, sum(pol.net_order_value_usd) AS usd, count(*)::int AS n
       FROM core.fact_po_line pol
      WHERE ${where} AND pol.vendor_code = ${vp} AND NOT pol.is_sto
      GROUP BY 1 ORDER BY 1`,
    params,
  );

  const byArea = await query<{ plant: string; plant_name: string; usd: number | null; n: number }>(
    `SELECT pol.plant, COALESCE(max(dp.plant_name), pol.plant) AS plant_name,
            sum(pol.net_order_value_usd) AS usd, count(*)::int AS n
       FROM core.fact_po_line pol
       LEFT JOIN core.dim_plant dp ON dp.plant = pol.plant
      WHERE ${where} AND pol.vendor_code = ${vp} AND NOT pol.is_sto
      GROUP BY pol.plant ORDER BY usd DESC NULLS LAST LIMIT 12`,
    params,
  );

  // Materials supplied (v1's v3-mt)
  const materials = await query<{
    material_code: string | null; descr: string; lines: number; qty: number | null;
    usd: number | null; last_po: string;
  }>(
    `SELECT pol.material_code, left(max(pol.short_text), 60) AS descr,
            count(*)::int AS lines, sum(pol.order_qty) AS qty,
            sum(pol.net_order_value_usd) AS usd, max(pol.document_date)::text AS last_po
       FROM core.fact_po_line pol
      WHERE ${where} AND pol.vendor_code = ${vp} AND NOT pol.is_sto
      GROUP BY pol.material_code ORDER BY usd DESC NULLS LAST LIMIT 100`,
    params,
  );

  // Full PO history (v1's v3-po-tbl), newest first, capped and saying so.
  const poHistory = await query<Record<string, unknown>>(
    `SELECT pol.po_no AS "poNo", pol.po_item AS "poItem", pol.document_date AS "documentDate",
            left(pol.short_text, 60) AS "shortText", pol.order_qty AS "orderQty",
            pol.order_unit AS "orderUnit", pol.unit_price AS "unitPrice", pol.price_unit AS "priceUnit",
            pol.currency_code AS "currencyCode", pol.net_order_value AS "netOrderValue",
            pol.net_order_value_usd AS "netOrderValueUsd", pol.status, pol.receipt_date AS "receiptDate",
            pol.gr_completion_pct AS "grCompletionPct",
            pol.is_sto AS "_sto", pol.is_token_price AS "_token", pol.release_exempt AS "_exempt"
       FROM core.fact_po_line pol
      WHERE ${where} AND pol.vendor_code = ${vp}
      ORDER BY pol.document_date DESC, pol.po_no DESC, pol.po_item
      LIMIT 200`,
    params,
  );

  // Σ over the vendor's WHOLE population — v1's PO-summary total row. Computed
  // in SQL, not by summing the capped page.
  const poTotals = await queryOne<{
    lines: number; pos: number; idr: number | null; usd: number | null; unrated: number;
  }>(
    `SELECT count(*)::int AS lines, count(DISTINCT pol.po_no)::int AS pos,
            sum(pol.net_order_value) FILTER (WHERE pol.currency_code = 'IDR') AS idr,
            sum(pol.net_order_value_usd) AS usd,
            count(*) FILTER (WHERE pol.net_order_value IS NOT NULL AND pol.net_order_value_usd IS NULL)::int AS unrated
       FROM core.fact_po_line pol
      WHERE ${where} AND pol.vendor_code = ${vp}`,
    params,
  );

  // Delivery aging histogram (v1's v3 popup chart): receipt vs promise date.
  const deliveryAging = await query<{ bucket: string; ord: number; n: number }>(
    `SELECT CASE
              WHEN pol.receipt_date <= pol.delivery_date THEN 'Early / on-time'
              WHEN pol.receipt_date <= pol.delivery_date + 7 THEN '1-7d (grace)'
              WHEN pol.receipt_date <= pol.delivery_date + 14 THEN '8-14d late'
              WHEN pol.receipt_date <= pol.delivery_date + 30 THEN '15-30d late'
              ELSE '>30d late' END AS bucket,
            min(CASE
              WHEN pol.receipt_date <= pol.delivery_date THEN 1
              WHEN pol.receipt_date <= pol.delivery_date + 7 THEN 2
              WHEN pol.receipt_date <= pol.delivery_date + 14 THEN 3
              WHEN pol.receipt_date <= pol.delivery_date + 30 THEN 4
              ELSE 5 END) AS ord,
            count(*)::int AS n
       FROM core.fact_po_line pol
      WHERE ${where} AND pol.vendor_code = ${vp} AND NOT pol.is_sto
        AND pol.receipt_date IS NOT NULL AND pol.delivery_date IS NOT NULL
      GROUP BY 1 ORDER BY 2`,
    params,
  );

  // GR history (v1's v3-gr-tbl)
  const grHistory = await query<Record<string, unknown>>(
    `SELECT g.material_doc AS "materialDoc", g.po_no AS "poNo", g.po_item AS "poItem",
            g.movement_type AS "movementType", g.posting_class AS "postingClass",
            g.posting_date AS "postingDate", g.signed_qty AS "signedQty",
            left(g.material_desc, 50) AS "materialDesc"
       FROM core.fact_gr_posting g
      WHERE g.dataset_version_id = $1 AND g.po_no IN (
              SELECT DISTINCT pol.po_no FROM core.fact_po_line pol
               WHERE ${where} AND pol.vendor_code = ${vp})
      ORDER BY g.posting_date DESC LIMIT 200`,
    params,
  );

  /**
   * The Coupa supplier record for this vendor (payload doc §1.8), matched on
   * the supplier number, which carries the same value as the SAP vendor code.
   *
   * Deliberately a LEFT lookup that may find nothing: the supplier master is
   * Coupa's, the vendor is SAP's, and a vendor that has never been onboarded in
   * Coupa simply has no record. The popup then says the address is not on file
   * rather than showing a blank field that reads like a bug.
   *
   * Not scoped by dataset version — supplier master data is current state, not
   * a versioned fact, so it is read live like the rest of the Coupa store.
   */
  const supplier = await queryOne<{
    number: string | null; name: string | null; status: string | null;
    po_email: string | null; primary_contact_email: string | null;
    po_method: string | null; on_hold: boolean | null; updated_at: string | null;
  }>(
    `SELECT number, COALESCE(display_name, name) AS name, status, po_email,
            primary_contact_email, po_method, on_hold, updated_at::text
       FROM ops.coupa_supplier
      WHERE number = $1
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1`,
    [vendorCode],
  );

  const totalUnconverted = byCcy.reduce((s2, c) => s2 + c.unconv, 0);
  return {
    vendorCode,
    vendorName: bio.vendor_name,
    coupaSupplier: supplier === null ? null : {
      number: supplier.number,
      name: supplier.name,
      status: supplier.status,
      poEmail: supplier.po_email,
      contactEmail: supplier.primary_contact_email,
      poMethod: supplier.po_method,
      onHold: supplier.on_hold,
      updatedAt: supplier.updated_at,
    },
    bio: {
      firstSeen: bio.first_seen,
      lastSeen: bio.last_seen,
      poCount: bio.po_count,
      lineCount: bio.line_count,
      spendUsd: totalUnconverted > 0 ? null : bio.spend_usd,
      spendByCurrency: byCcy.map((c) => ({
        currency: c.ccy,
        amount: c.amount,
        amountUsd: c.unconv > 0 ? null : c.usd,
        rated: c.unconv === 0,
      })),
      materialsSupplied: bio.materials,
      areasServed: bio.areas,
      otdPct: bio.otd_den > 0 ? Math.round((bio.otd_num / bio.otd_den) * 1000) / 10 : null,
      otdCaveat: 'On-time = receipt within 7 days of the PO delivery date (EINDT). EINDT equals the document date on 37.4% of all lines, so treat as indicative.',
      avgDaysLate: bio.avg_late === null ? null : Math.round(Number(bio.avg_late) * 10) / 10,
      openExposureUsd: bio.open_usd,
      deliveredNotInvoicedUsd: bio.grir_usd,
      reversalRatePct:
        bio.rev_101 > 0 ? Math.round((bio.rev_reversals / bio.rev_101) * 1000) / 10 : null,
      // v1's v3x-otdr. Computed against the requested date (EBAN-LFDAT) the
      // moment the export carries one; until then no line is evaluable and the
      // card stays an honest em dash with the D4 reason (never a fabricated 0).
      onTimeVsRequested:
        bio.otdr_den > 0 ? Math.round((bio.otdr_num / bio.otdr_den) * 1000) / 10 : null,
      onTimeVsRequestedReason:
        bio.otdr_den > 0
          ? `${bio.otdr_den} lines carry both a receipt and a requested date.`
          : 'Requested delivery date not present in this export (V-M01 / D4).',
    },
    spendByMonth: spendByMonth.map((m) => ({ monthKey: m.mk, usd: m.usd, lines: m.n })),
    byArea: byArea.map((a) => ({ plant: a.plant, plantName: a.plant_name, usd: a.usd, lines: a.n })),
    materials: materials.map((m) => ({
      materialCode: m.material_code,
      description: m.descr,
      lines: m.lines,
      qty: m.qty,
      usd: m.usd,
      lastPo: m.last_po,
    })),
    poHistory: decorate(poHistory),
    poTotals: poTotals
      ? {
          lines: poTotals.lines,
          pos: poTotals.pos,
          valueIdr: poTotals.idr,
          valueUsd: poTotals.unrated > 0 ? null : poTotals.usd,
          usdComplete: poTotals.unrated === 0,
        }
      : null,
    deliveryAging: deliveryAging.map((b) => ({ bucket: b.bucket, count: b.n })),
    grHistory,
    caps: { poHistory: 200, grHistory: 200, materials: 100 },
  };
}

// ─────────────────────────────── vendor pivot + OTD chart (G3.1 / G3.2)

/**
 * v1's "Vendors × Materials — monthly order value" matrix, vendor level.
 * USD-converted sums per month; a vendor with unrated lines shows null for the
 * affected cells rather than an understated number.
 */
export async function vendorPivot(
  versionId: number,
  scope: readonly ScopeEntry[],
  search: string,
  limit: number,
  offset: number,
): Promise<Record<string, unknown>> {
  const { where, params } = scoped(versionId, scope, 'pol');

  let extra = '';
  if (search.trim() !== '') {
    params.push(`%${search.trim()}%`);
    extra = ` AND (pol.vendor_name ILIKE $${params.length} OR pol.vendor_code ILIKE $${params.length})`;
  }
  const base = `${where}${extra} AND NOT pol.is_sto AND NOT pol.is_deleted AND pol.vendor_code IS NOT NULL`;

  const months = await query<{ mk: string }>(
    `SELECT DISTINCT to_char(pol.document_date, 'YYYY-MM') AS mk
       FROM core.fact_po_line pol WHERE ${base} ORDER BY 1`,
    params,
  );

  const totalRow = await queryOne<{ vendors: number; grand_usd: number | null; unrated: number }>(
    `SELECT count(DISTINCT pol.vendor_code)::int AS vendors,
            sum(pol.net_order_value_usd) AS grand_usd,
            count(*) FILTER (WHERE pol.net_order_value IS NOT NULL AND pol.net_order_value_usd IS NULL)::int AS unrated
       FROM core.fact_po_line pol WHERE ${base}`,
    params,
  );

  const pageParams = [...params, limit, offset];
  const rows = await query<{
    code: string; name: string | null; mk: string; usd: number | null; unrated: number;
  }>(
    `WITH top AS (
       SELECT pol.vendor_code AS code, sum(pol.net_order_value_usd) AS total
         FROM core.fact_po_line pol WHERE ${base}
        GROUP BY 1 ORDER BY total DESC NULLS LAST
        LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length})
     SELECT pol.vendor_code AS code, max(pol.vendor_name) AS name,
            to_char(pol.document_date, 'YYYY-MM') AS mk,
            sum(pol.net_order_value_usd) AS usd,
            count(*) FILTER (WHERE pol.net_order_value IS NOT NULL AND pol.net_order_value_usd IS NULL)::int AS unrated
       FROM core.fact_po_line pol JOIN top ON top.code = pol.vendor_code
      WHERE ${base}
      GROUP BY pol.vendor_code, to_char(pol.document_date, 'YYYY-MM')`,
    pageParams,
  );

  /**
   * PO emails for the vendors on this page only — one small query rather than a
   * join inside the month aggregation, which would have to be carried through
   * every grouped row for no benefit.
   */
  const codes = [...new Set(rows.map((r) => r.code))];
  const emails = new Map<string, string | null>();
  const inCoupa = new Set<string>();
  if (codes.length > 0) {
    const sup = await query<{ number: string; po_email: string | null }>(
      `SELECT DISTINCT ON (number) number, po_email FROM ops.coupa_supplier
        WHERE number = ANY($1) ORDER BY number, updated_at DESC NULLS LAST`,
      [codes],
    );
    for (const x of sup) { emails.set(x.number, x.po_email); inCoupa.add(x.number); }
  }

  const byVendor = new Map<string, { code: string; name: string | null; poEmail: string | null; inCoupa: boolean; byMonth: Record<string, number | null>; total: number; anyUnrated: boolean }>();
  for (const r of rows) {
    let v = byVendor.get(r.code);
    if (!v) {
      v = {
        code: r.code, name: r.name,
        poEmail: emails.get(r.code) ?? null,
        inCoupa: inCoupa.has(r.code),
        byMonth: {}, total: 0, anyUnrated: false,
      };
      byVendor.set(r.code, v);
    }
    v.byMonth[r.mk] = r.unrated > 0 ? null : r.usd === null ? null : Number(r.usd);
    if (r.unrated > 0) v.anyUnrated = true;
    if (r.usd !== null && r.unrated === 0) v.total += Number(r.usd);
  }

  return {
    months: months.map((m) => m.mk),
    totalVendors: totalRow?.vendors ?? 0,
    grandTotalUsd: (totalRow?.unrated ?? 0) > 0 ? null : totalRow?.grand_usd ?? null,
    rows: [...byVendor.values()].sort((a, b) => b.total - a.total),
    note: 'USD-converted, period-matched FX · STO and deleted lines excluded · cells with unrated currencies show —',
  };
}

/** Material × month sub-rows for one vendor (pivot expand). */
export async function vendorPivotMaterials(
  versionId: number,
  scope: readonly ScopeEntry[],
  vendorCode: string,
): Promise<Record<string, unknown>[]> {
  const { where, params } = scoped(versionId, scope, 'pol');
  params.push(vendorCode);
  const rows = await query<{
    code: string | null; descr: string | null; mk: string; usd: number | null; unrated: number;
  }>(
    `SELECT COALESCE(NULLIF(pol.material_code, ''), '(service)') AS code,
            left(max(pol.short_text), 50) AS descr,
            to_char(pol.document_date, 'YYYY-MM') AS mk,
            sum(pol.net_order_value_usd) AS usd,
            count(*) FILTER (WHERE pol.net_order_value IS NOT NULL AND pol.net_order_value_usd IS NULL)::int AS unrated
       FROM core.fact_po_line pol
      WHERE ${where} AND pol.vendor_code = $${params.length} AND NOT pol.is_sto AND NOT pol.is_deleted
      GROUP BY 1, to_char(pol.document_date, 'YYYY-MM')`,
    params,
  );
  const byMat = new Map<string, { code: string; descr: string | null; byMonth: Record<string, number | null>; total: number }>();
  for (const r of rows) {
    const key = r.code ?? '(service)';
    let m = byMat.get(key);
    if (!m) {
      m = { code: key, descr: r.descr, byMonth: {}, total: 0 };
      byMat.set(key, m);
    }
    m.byMonth[r.mk] = r.unrated > 0 ? null : r.usd === null ? null : Number(r.usd);
    if (r.usd !== null && r.unrated === 0) m.total += Number(r.usd);
  }
  return [...byMat.values()].sort((a, b) => b.total - a.total).slice(0, 60);
}

/** v1's all-vendors On-Time vs Late stacked chart (grace +7d, GR vs EINDT). */
export async function vendorOtdChart(
  versionId: number,
  scope: readonly ScopeEntry[],
  limit: number,
): Promise<Record<string, unknown>[]> {
  const { where, params } = scoped(versionId, scope, 'pol');
  params.push(limit);
  return query(
    `SELECT pol.vendor_code AS "vendorCode", max(pol.vendor_name) AS "vendorName",
            count(*) FILTER (WHERE pol.receipt_date <= pol.delivery_date + 7)::int AS "onTime",
            count(*) FILTER (WHERE pol.receipt_date > pol.delivery_date + 7)::int AS "late"
       FROM core.fact_po_line pol
      WHERE ${where} AND NOT pol.is_sto AND NOT pol.is_deleted
        AND pol.receipt_date IS NOT NULL AND pol.delivery_date IS NOT NULL
        AND pol.vendor_code IS NOT NULL
      GROUP BY pol.vendor_code
      ORDER BY count(*) DESC
      LIMIT $${params.length}`,
    params,
  );
}

// ─────────────────────────────────────────────────────────── material detail

export async function materialDetail(
  versionId: number,
  scope: readonly ScopeEntry[],
  materialCode: string,
): Promise<Record<string, unknown> | null> {
  const { where, params } = scoped(versionId, scope, 'pol');
  params.push(materialCode);
  const mp = `$${params.length}`;

  const head = await queryOne<{
    descr: string; grp: string | null; cat: string | null; lines: number; vendors: number;
    qty: number | null; usd: number | null; avg_price: number | null;
  }>(
    `SELECT left(max(pol.short_text), 80) AS descr, max(pol.material_group) AS grp,
            max(pol.material_category) AS cat, count(*)::int AS lines,
            count(DISTINCT pol.vendor_code)::int AS vendors, sum(pol.order_qty) AS qty,
            sum(pol.net_order_value_usd) AS usd,
            avg(pol.unit_price) FILTER (WHERE NOT pol.is_sto AND NOT pol.is_token_price AND pol.unit_price > 0) AS avg_price
       FROM core.fact_po_line pol
      WHERE ${where} AND pol.material_code = ${mp}`,
    params,
  );
  if (!head || head.lines === 0) return null;

  // Monthly average unit price (v1's ch-mx-price). Document currency mix would
  // corrupt an average, so this is computed on IDR lines only and says so.
  const priceHistory = await query<{ mk: string; avg_price: number | null; n: number }>(
    `SELECT to_char(pol.document_date,'YYYY-MM') AS mk,
            avg(pol.unit_price) AS avg_price, count(*)::int AS n
       FROM core.fact_po_line pol
      WHERE ${where} AND pol.material_code = ${mp}
        AND pol.currency_code = 'IDR' AND NOT pol.is_sto AND NOT pol.is_token_price
        AND pol.unit_price > 0
      GROUP BY 1 ORDER BY 1`,
    params,
  );

  // v1's material-360 line chart, on an honest axis. Two v1 crudenesses are
  // fixed here: v1 mixes document currencies into one 'IDR' axis (v2 uses the
  // per-line EXACT IDR equivalent, FX at invoice/PO date), and v1 divides by
  // the raw order quantity whatever its unit, so a per-MT vendor charts 1000x
  // above a per-KG vendor. v2 converts mass (G/KG/MT) and volume (ML/L/KL/M3)
  // units to the material's dominant base; lines in an incomparable unit are
  // excluded and counted. Monthly point = sum(value)/sum(qty), v1's ratio.
  const priceByVendor = await query<{
    code: string | null; name: string | null; mk: string; price: number | null;
    n: number; base: string;
  }>(
    `WITH l AS (
       SELECT pol.vendor_code, pol.vendor_name, pol.document_date,
              pol.net_order_value_idr AS val, pol.order_qty AS q,
              upper(COALESCE(pol.order_unit,'')) AS u
         FROM core.fact_po_line pol
        WHERE ${where} AND pol.material_code = ${mp}
          AND pol.net_order_value_idr > 0 AND NOT pol.is_sto AND NOT pol.is_token_price
          AND pol.order_qty > 0 AND pol.document_date IS NOT NULL),
     conv AS (
       SELECT *,
              CASE u WHEN 'MT' THEN 1000.0 WHEN 'TO' THEN 1000.0 WHEN 'TON' THEN 1000.0
                     WHEN 'KG' THEN 1.0 WHEN 'G' THEN 0.001
                     WHEN 'KL' THEN 1000.0 WHEN 'M3' THEN 1000.0 WHEN 'L' THEN 1.0 WHEN 'ML' THEN 0.001
                     ELSE 1.0 END AS f,
              CASE WHEN u IN ('MT','TO','TON','KG','G') THEN 'KG'
                   WHEN u IN ('KL','M3','L','ML') THEN 'L'
                   ELSE u END AS base
         FROM l),
     dom AS (SELECT base FROM conv GROUP BY base ORDER BY count(*) DESC, base LIMIT 1),
     c2 AS (SELECT conv.* FROM conv JOIN dom ON conv.base = dom.base),
     v6 AS (SELECT vendor_code, max(vendor_name) AS vendor_name, sum(val) AS amt
              FROM c2 GROUP BY 1 ORDER BY amt DESC NULLS LAST LIMIT 6)
     SELECT c2.vendor_code AS code, max(v6.vendor_name) AS name,
            to_char(c2.document_date,'YYYY-MM') AS mk,
            sum(c2.val) / NULLIF(sum(c2.q * c2.f), 0) AS price,
            count(*)::int AS n, max(c2.base) AS base
       FROM c2 JOIN v6 ON v6.vendor_code = c2.vendor_code
      GROUP BY c2.vendor_code, 3 ORDER BY 3`,
    [...params],
  );

  const vendorShare = await query<{ code: string | null; name: string | null; usd: number | null; n: number }>(
    `SELECT pol.vendor_code AS code, max(pol.vendor_name) AS name,
            sum(pol.net_order_value_usd) AS usd, count(*)::int AS n
       FROM core.fact_po_line pol
      WHERE ${where} AND pol.material_code = ${mp} AND NOT pol.is_sto
      GROUP BY pol.vendor_code ORDER BY usd DESC NULLS LAST LIMIT 10`,
    params,
  );

  const areaShare = await query<{ plant: string; plant_name: string; usd: number | null; n: number }>(
    `SELECT pol.plant, COALESCE(max(dp.plant_name), pol.plant) AS plant_name,
            sum(pol.net_order_value_usd) AS usd, count(*)::int AS n
       FROM core.fact_po_line pol
       LEFT JOIN core.dim_plant dp ON dp.plant = pol.plant
      WHERE ${where} AND pol.material_code = ${mp}
      GROUP BY pol.plant ORDER BY usd DESC NULLS LAST LIMIT 12`,
    params,
  );

  const poHistory = await query<Record<string, unknown>>(
    `SELECT pol.po_no AS "poNo", pol.po_item AS "poItem", pol.document_date AS "documentDate",
            pol.vendor_name AS "vendorName", pol.order_qty AS "orderQty", pol.order_unit AS "orderUnit",
            pol.unit_price AS "unitPrice", pol.price_unit AS "priceUnit",
            pol.currency_code AS "currencyCode", pol.net_order_value AS "netOrderValue",
            pol.net_order_value_usd AS "netOrderValueUsd", pol.status, pol.receipt_date AS "receiptDate",
            pol.is_sto AS "_sto", pol.is_token_price AS "_token", pol.release_exempt AS "_exempt"
       FROM core.fact_po_line pol
      WHERE ${where} AND pol.material_code = ${mp}
      ORDER BY pol.document_date DESC, pol.po_no DESC LIMIT 200`,
    params,
  );

  return {
    materialCode,
    description: head.descr,
    materialGroup: head.grp,
    category: head.cat,
    kpis: {
      lineCount: head.lines,
      vendorCount: head.vendors,
      totalQty: head.qty,
      spendUsd: head.usd,
      avgUnitPrice: head.avg_price === null ? null : Math.round(Number(head.avg_price) * 100) / 100,
      avgUnitPriceNote: 'IDR lines only, STO and token prices excluded',
      soleSource: head.vendors === 1,
    },
    priceHistory: priceHistory.map((x) => ({ monthKey: x.mk, avgUnitPrice: x.avg_price, lines: x.n })),
    priceByVendor: priceByVendor.map((x) => ({
      vendorCode: x.code, vendorName: x.name, monthKey: x.mk, unitPrice: x.price, lines: x.n,
    })),
    priceBasis: {
      baseUnit: priceByVendor[0]?.base ?? null,
      // Lines whose unit cannot be converted to the dominant base (or without
      // an IDR equivalent) are not in the trend; the modal says so.
      chartedLines: priceByVendor.reduce((a, x) => a + x.n, 0),
    },
    vendorShare: vendorShare.map((x) => ({ vendorCode: x.code, vendorName: x.name, usd: x.usd, lines: x.n })),
    areaShare: areaShare.map((x) => ({ plant: x.plant, plantName: x.plant_name, usd: x.usd, lines: x.n })),
    poHistory: decorate(poHistory),
    caps: { poHistory: 200 },
  };
}

// ───────────────────────────────────────────────────── material group page

export async function materialGroupPage(
  versionId: number,
  scope: readonly ScopeEntry[],
  category: string | null,
  search: string,
  materialGroup: string | null = null,
  limit = 150,
  offset = 0,
): Promise<Record<string, unknown>> {
  const { where, params } = scoped(versionId, scope, 'pol');

  // Category summary, v1's mgt exactly (5 Aug 2026): PR items + open share on
  // the PR grain, the five stage AVERAGES split across their natural grains
  // (PRA on PR items; SRC/POA/DLT/E2E on PO lines). Blank categories are
  // dropped like v1's Boolean filter.
  const priScoped = scoped(versionId, scope, 'pri');
  const priSummary = await query<{
    cat: string; items: number; open_n: number; avg_pra: number | null;
  }>(
    `SELECT pri.material_category AS cat, count(*)::int AS items,
            count(*) FILTER (WHERE pri.status IN ('Unapproved PR','PR Approved-No PO')
              OR EXISTS (SELECT 1 FROM core.fact_po_line _pl
                          WHERE _pl.dataset_version_id = pri.dataset_version_id
                            AND _pl.pr_no = pri.pr_no AND _pl.pr_item = pri.pr_item
                            AND _pl.status IN ('PO-Not Approved','HOLD PO','PO-No GR','Partially Delivered')))::int AS open_n,
            avg(pri.release_final_date - pri.requisition_date)
              FILTER (WHERE pri.release_final_date - pri.requisition_date >= 0) AS avg_pra
       FROM core.fact_pr_item pri
      WHERE ${priScoped.where} AND NOT pri.is_deleted AND pri.material_category IS NOT NULL
      GROUP BY 1`,
    priScoped.params,
  );
  const polSummary = await query<{
    cat: string; avg_src: number | null; avg_poa: number | null; avg_dlt: number | null; avg_e2e: number | null;
  }>(
    `SELECT pol.material_category AS cat,
            avg(pol.sourcing_days) FILTER (WHERE pol.sourcing_days >= 0) AS avg_src,
            avg(pol.po_approval_days) FILTER (WHERE pol.po_approval_days >= 0) AS avg_poa,
            avg(pol.delivery_days) FILTER (WHERE pol.delivery_days >= 0) AS avg_dlt,
            avg(pol.receipt_date - pri.requisition_date)
              FILTER (WHERE pol.receipt_date - pri.requisition_date >= 0) AS avg_e2e
       FROM core.fact_po_line pol
       LEFT JOIN core.fact_pr_item pri
         ON pri.dataset_version_id = pol.dataset_version_id
        AND pri.pr_no = pol.pr_no AND pri.pr_item = pol.pr_item
      WHERE ${where} AND NOT pol.is_sto AND NOT pol.is_deleted
        AND pol.material_category IS NOT NULL
      GROUP BY 1`,
    params,
  );
  const polByCat = new Map(polSummary.map((x) => [x.cat, x]));

  // Material Explorer (v1's mxt) over the FULL catalogue: category, material
  // group and search narrow it; limit/offset page it server-side.
  const matParams = [...params];
  let extra = '';
  if (category) {
    matParams.push(category);
    extra += ` AND COALESCE(pol.material_category,'Other') = $${matParams.length}`;
  }
  if (materialGroup) {
    matParams.push(materialGroup);
    extra += ` AND pol.material_group = $${matParams.length}`;
  }
  if (search.trim() !== '') {
    matParams.push(`%${search.trim()}%`);
    extra += ` AND (pol.material_code ILIKE $${matParams.length} OR pol.short_text ILIKE $${matParams.length})`;
  }

  const matCount = await queryOne<{ n: number }>(
    `SELECT count(DISTINCT pol.material_code)::int AS n
       FROM core.fact_po_line pol
      WHERE ${where} AND NOT pol.is_sto AND pol.material_code IS NOT NULL${extra}`,
    matParams,
  );

  const groups = await query<{ grp: string }>(
    `SELECT DISTINCT pol.material_group AS grp FROM core.fact_po_line pol
      WHERE ${where} AND NOT pol.is_sto AND pol.material_group IS NOT NULL ORDER BY 1`,
    params,
  );

  const pageParams = [...matParams, limit, offset];
  const materials = await query<{
    code: string; descr: string; grp: string | null; cat: string | null; lines: number;
    vendors: number; qty: number | null; usd: number | null; idr: number | null;
  }>(
    `SELECT pol.material_code AS code, left(max(pol.short_text), 60) AS descr,
            max(pol.material_group) AS grp, max(pol.material_category) AS cat, count(*)::int AS lines,
            count(DISTINCT pol.vendor_code)::int AS vendors,
            sum(pol.order_qty) AS qty, sum(pol.net_order_value_usd) AS usd,
            sum(pol.net_order_value_idr) AS idr
       FROM core.fact_po_line pol
      WHERE ${where} AND NOT pol.is_sto AND pol.material_code IS NOT NULL${extra}
      GROUP BY pol.material_code ORDER BY usd DESC NULLS LAST
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );

  // v1's mg-vol: price volatility - CV% over MONTHLY average unit prices
  // (spend/qty per line, IDR document-currency, STO/token excluded), needing
  // >= 3 months of history; worst first, top 50.
  const volatility = await query<{
    code: string; descr: string; months: number; cv: number | null; spend_idr: number | null;
  }>(
    `WITH mo AS (
       SELECT pol.material_code, max(pol.short_text) AS descr,
              to_char(pol.document_date,'YYYY-MM') AS mk,
              avg(pol.net_order_value / NULLIF(pol.order_qty, 0)) AS u,
              sum(pol.net_order_value) AS spend
         FROM core.fact_po_line pol
        WHERE ${where} AND pol.currency_code = 'IDR' AND NOT pol.is_sto AND NOT pol.is_token_price
          AND pol.net_order_value > 0 AND pol.order_qty > 0
          AND pol.document_date IS NOT NULL
          AND pol.material_code IS NOT NULL AND pol.material_code <> ''
        GROUP BY pol.material_code, 3)
     SELECT material_code AS code, left(max(descr), 60) AS descr, count(*)::int AS months,
            (stddev_pop(u) / NULLIF(avg(u), 0) * 100)::float AS cv,
            sum(spend)::float AS spend_idr
       FROM mo GROUP BY 1 HAVING count(*) >= 3
      ORDER BY 4 DESC NULLS LAST LIMIT 50`,
    params,
  );

  const soleSource = await query<{
    code: string; descr: string; vendor: string | null; lines: number;
    usd: number | null; idr: number | null;
  }>(
    `SELECT pol.material_code AS code, left(max(pol.short_text), 60) AS descr,
            max(pol.vendor_name) AS vendor, count(*)::int AS lines,
            sum(pol.net_order_value_usd) AS usd, sum(pol.net_order_value_idr) AS idr
       FROM core.fact_po_line pol
      WHERE ${where} AND NOT pol.is_sto AND pol.material_code IS NOT NULL
      GROUP BY pol.material_code
     HAVING count(DISTINCT pol.vendor_code) = 1
      ORDER BY idr DESC NULLS LAST LIMIT 50`,
    params,
  );

  return {
    categories: priSummary
      .sort((a, b) => b.items - a.items)
      .map((s2) => {
        const pol2 = polByCat.get(s2.cat);
        return {
          category: s2.cat,
          items: s2.items,
          open: s2.open_n,
          pctOpen: s2.items > 0 ? Math.round((s2.open_n / s2.items) * 1000) / 10 : 0,
          avgPra: s2.avg_pra,
          avgSrc: pol2?.avg_src ?? null,
          avgPoa: pol2?.avg_poa ?? null,
          avgDlt: pol2?.avg_dlt ?? null,
          avgE2e: pol2?.avg_e2e ?? null,
        };
      }),
    materialGroups: groups.map((g) => g.grp),
    totalMaterials: matCount?.n ?? 0,
    materials: materials.map((m) => ({
      materialCode: m.code,
      description: m.descr,
      materialGroup: m.grp,
      category: m.cat,
      lines: m.lines,
      vendors: m.vendors,
      qty: m.qty,
      spendUsd: m.usd,
      spendIdr: m.idr,
      soleSource: m.vendors === 1,
    })),
    priceVolatility: volatility.map((x) => ({
      materialCode: x.code, description: x.descr, months: x.months, cvPct: x.cv, spendIdr: x.spend_idr,
    })),
    soleSource: soleSource.map((x) => ({
      materialCode: x.code, description: x.descr, vendorName: x.vendor, lines: x.lines,
      spendUsd: x.usd, spendIdr: x.idr,
    })),
    caps: { materials: limit, priceVolatility: 50, soleSource: 50 },
    pagination: { limit, offset },
  };
}

// ────────────────────────────────────────────────────────────────── helpers

function decorate(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const flags: string[] = [];
    if (r['_sto']) flags.push('sto');
    if (r['_token']) flags.push('tokenPrice');
    if (r['_exempt']) flags.push('releaseExempt');
    for (const k of ['_sto', '_token', '_exempt']) delete r[k];
    return { ...r, flags };
  });
}

// ─────────────────────────────── v1's PR-page tables (pr-bneck / pr-reqr)

export type BottleneckRow = {
  pic: string;
  codes: string;
  avgGap: number;
  medGap: number;
  steps: number;
  pending: number;
};

/**
 * v1's "Approval Bottlenecks" table: per release PIC, the average and median
 * SAP GAP lead over positive-gap steps (>= 5 of them, like v1), total steps
 * and pending count - worst average first, top 10. Only steps whose PR exists
 * in the item feed count, exactly v1's scoping.
 */
export async function approverBottlenecks(
  versionId: number,
  scope: readonly ScopeEntry[],
): Promise<{ rows: BottleneckRow[] }> {
  const { where, params } = scoped(versionId, scope, 'r');
  const rows = await query<BottleneckRow>(
    `SELECT r.pic_release AS pic,
            string_agg(DISTINCT r.rel_code, ', ') AS codes,
            round(avg(r.gap_days) FILTER (WHERE r.gap_days > 0)::numeric, 1)::float AS "avgGap",
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY r.gap_days) FILTER (WHERE r.gap_days > 0))::numeric, 1)::float AS "medGap",
            count(*)::int AS steps,
            count(*) FILTER (WHERE r.approve_date IS NULL)::int AS pending
       FROM core.fact_pr_release r
      WHERE ${where} AND r.pic_release IS NOT NULL AND r.pic_release <> ''
        AND EXISTS (SELECT 1 FROM core.fact_pr_item i
                     WHERE i.dataset_version_id = r.dataset_version_id
                       AND i.pr_no = r.pr_no AND i.pr_item = r.pr_item)
      GROUP BY 1
     HAVING count(*) FILTER (WHERE r.gap_days > 0) >= 5
      ORDER BY avg(r.gap_days) FILTER (WHERE r.gap_days > 0) DESC
      LIMIT 10`,
    params,
  );
  return { rows };
}

export type RequisitionerRow = {
  requisitioner: string;
  items: number;
  valueIdr: number | null;
  /** Strict FX: null when any valued line is unrated. */
  valueUsd: number | null;
  emg: number;
  urg: number;
};

/** v1's "Demand by Requisitioner" table: top 10 by PR valuation. */
export async function requisitionerDemand(
  versionId: number,
  scope: readonly ScopeEntry[],
): Promise<{ rows: RequisitionerRow[] }> {
  const { where, params } = scoped(versionId, scope, 'i');
  const raw = await query<RequisitionerRow & { unrated: number }>(
    `SELECT i.requisitioner,
            count(*)::int AS items,
            sum(i.total_value_idr)::float AS "valueIdr",
            sum(i.total_value_usd)::float AS "valueUsd",
            count(*) FILTER (WHERE i.total_value_idr IS NOT NULL AND i.total_value_idr <> 0
                               AND i.total_value_usd IS NULL)::int AS unrated,
            count(*) FILTER (WHERE i.urgency <= 1)::int AS emg,
            count(*) FILTER (WHERE i.urgency = 2)::int AS urg
       FROM core.fact_pr_item i
      WHERE ${where} AND i.requisitioner IS NOT NULL AND i.requisitioner <> ''
      GROUP BY 1
      ORDER BY sum(i.total_value_idr) DESC NULLS LAST
      LIMIT 10`,
    params,
  );
  return {
    rows: raw.map(({ unrated, ...r }) => ({ ...r, valueUsd: unrated > 0 ? null : r.valueUsd })),
  };
}

// ─────────────────────────── v1's PO-page top-spend tables (items 1-2, 4 Aug)

export type TopMaterialRow = {
  materialCode: string;
  description: string | null;
  lines: number;
  qty: number | null;
  spendUsd: number | null;
  spendIdr: number | null;
  lastPo: string | null;
};

export async function topMaterialsSpend(
  versionId: number,
  scope: readonly ScopeEntry[],
  limit = 10,
): Promise<{ rows: TopMaterialRow[]; totalUsd: number | null }> {
  const { where, params } = scoped(versionId, scope, 'pol');
  const rows = await query<TopMaterialRow>(
    `SELECT pol.material_code AS "materialCode",
            left(max(pol.short_text), 60) AS description,
            count(*)::int AS lines,
            sum(pol.order_qty)::float AS qty,
            sum(pol.net_order_value_usd)::float AS "spendUsd",
            sum(pol.net_order_value_idr)::float AS "spendIdr",
            to_char(max(pol.document_date), 'YYYY-MM-DD') AS "lastPo"
       FROM core.fact_po_line pol
      WHERE ${where} AND NOT pol.is_sto AND NOT pol.is_deleted
        AND pol.material_code IS NOT NULL AND pol.material_code <> ''
      GROUP BY 1 ORDER BY sum(pol.net_order_value_usd) DESC NULLS LAST
      LIMIT ${Math.min(Math.max(limit, 1), 50)}`,
    params,
  );
  const tot = await queryOne<{ usd: number | null }>(
    `SELECT sum(pol.net_order_value_usd)::float AS usd
       FROM core.fact_po_line pol
      WHERE ${where} AND NOT pol.is_sto AND NOT pol.is_deleted`,
    params,
  );
  return { rows, totalUsd: tot?.usd ?? null };
}
