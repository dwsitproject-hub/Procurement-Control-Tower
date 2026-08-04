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
            sum(pol.still_deliver_val_usd) FILTER (WHERE COALESCE(pol.still_deliver_val,0) > 0) AS open_usd
       FROM core.fact_po_line pol
      WHERE ${where}${searchSql} AND pol.vendor_code IS NOT NULL AND NOT pol.is_sto
      GROUP BY pol.vendor_code
      ORDER BY spend_usd DESC NULLS LAST
      LIMIT $${params.length}`,
    params,
  );

  return {
    totalVendors: total?.n ?? 0,
    rows: rows.map((r) => ({
      vendorCode: r.vendor_code,
      vendorName: r.vendor_name,
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

  const totalUnconverted = byCcy.reduce((s2, c) => s2 + c.unconv, 0);
  return {
    vendorCode,
    vendorName: bio.vendor_name,
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

  const byVendor = new Map<string, { code: string; name: string | null; byMonth: Record<string, number | null>; total: number; anyUnrated: boolean }>();
  for (const r of rows) {
    let v = byVendor.get(r.code);
    if (!v) {
      v = { code: r.code, name: r.name, byMonth: {}, total: 0, anyUnrated: false };
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

  // v1's material-360 line chart: unit price (= spend / qty, per line, IDR
  // lines only) averaged per month, one series per top-6 vendor by amount.
  const priceByVendor = await query<{ code: string | null; name: string | null; mk: string; price: number | null; n: number }>(
    `WITH v6 AS (
       SELECT pol.vendor_code, max(pol.vendor_name) AS vendor_name,
              sum(pol.net_order_value) AS amt
         FROM core.fact_po_line pol
        WHERE ${where} AND pol.material_code = ${mp}
          AND pol.currency_code = 'IDR' AND NOT pol.is_sto AND NOT pol.is_token_price
        GROUP BY pol.vendor_code ORDER BY amt DESC NULLS LAST LIMIT 6)
     SELECT pol.vendor_code AS code, max(v6.vendor_name) AS name,
            to_char(pol.document_date,'YYYY-MM') AS mk,
            avg(pol.net_order_value / NULLIF(pol.order_qty, 0)) AS price,
            count(*)::int AS n
       FROM core.fact_po_line pol
       JOIN v6 ON v6.vendor_code = pol.vendor_code
      WHERE ${where} AND pol.material_code = ${mp}
        AND pol.currency_code = 'IDR' AND NOT pol.is_sto AND NOT pol.is_token_price
        AND pol.order_qty > 0 AND pol.document_date IS NOT NULL
      GROUP BY pol.vendor_code, 3 ORDER BY 3`,
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

  // Category summary (v1's mgt): items, value, per-stage cycle medians (G3.4).
  const summary = await query<{
    cat: string; lines: number; pos: number; usd: number | null;
    med_src: number | null; med_appr: number | null; med_del: number | null;
  }>(
    `SELECT COALESCE(pol.material_category,'Other') AS cat, count(*)::int AS lines,
            count(DISTINCT pol.po_no)::int AS pos, sum(pol.net_order_value_usd) AS usd,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY pol.sourcing_days) AS med_src,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY pol.po_approval_days) AS med_appr,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY pol.delivery_days) AS med_del
       FROM core.fact_po_line pol
      WHERE ${where} AND NOT pol.is_sto AND NOT pol.is_deleted
      GROUP BY 1 ORDER BY usd DESC NULLS LAST`,
    params,
  );

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
    code: string; descr: string; grp: string | null; lines: number; vendors: number;
    qty: number | null; usd: number | null;
  }>(
    `SELECT pol.material_code AS code, left(max(pol.short_text), 60) AS descr,
            max(pol.material_group) AS grp, count(*)::int AS lines,
            count(DISTINCT pol.vendor_code)::int AS vendors,
            sum(pol.order_qty) AS qty, sum(pol.net_order_value_usd) AS usd
       FROM core.fact_po_line pol
      WHERE ${where} AND NOT pol.is_sto AND pol.material_code IS NOT NULL${extra}
      GROUP BY pol.material_code ORDER BY usd DESC NULLS LAST
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );

  // Volume leaders (v1's mg-vol) and sole-source (v1's mg-ss).
  const volume = await query<{ code: string; descr: string; qty: number | null; unit: string | null }>(
    `SELECT pol.material_code AS code, left(max(pol.short_text), 60) AS descr,
            sum(pol.order_qty) AS qty, max(pol.order_unit) AS unit
       FROM core.fact_po_line pol
      WHERE ${where} AND NOT pol.is_sto AND pol.material_code IS NOT NULL
      GROUP BY pol.material_code ORDER BY qty DESC NULLS LAST LIMIT 20`,
    params,
  );

  const soleSource = await query<{
    code: string; descr: string; vendor: string | null; lines: number; usd: number | null;
  }>(
    `SELECT pol.material_code AS code, left(max(pol.short_text), 60) AS descr,
            max(pol.vendor_name) AS vendor, count(*)::int AS lines,
            sum(pol.net_order_value_usd) AS usd
       FROM core.fact_po_line pol
      WHERE ${where} AND NOT pol.is_sto AND pol.material_code IS NOT NULL
      GROUP BY pol.material_code
     HAVING count(DISTINCT pol.vendor_code) = 1
      ORDER BY usd DESC NULLS LAST LIMIT 50`,
    params,
  );

  // Open items by category (v1 showed open exposure per group).
  const open = await query<{ cat: string; n: number }>(
    `SELECT COALESCE(pol.material_category,'Other') AS cat, count(*)::int AS n
       FROM core.fact_po_line pol
      WHERE ${where} AND NOT pol.is_sto AND NOT pol.is_deleted
        AND pol.status IN ${OPEN_STATUSES}
      GROUP BY 1`,
    params,
  );
  const openByCat = new Map(open.map((o) => [o.cat, o.n]));

  return {
    categories: summary.map((s2) => ({
      category: s2.cat,
      lines: s2.lines,
      pos: s2.pos,
      spendUsd: s2.usd,
      medianSourcingDays: s2.med_src,
      medianPoApprovalDays: s2.med_appr,
      medianDeliveryDays: s2.med_del,
      openLines: openByCat.get(s2.cat) ?? 0,
    })),
    materialGroups: groups.map((g) => g.grp),
    totalMaterials: matCount?.n ?? 0,
    materials: materials.map((m) => ({
      materialCode: m.code,
      description: m.descr,
      materialGroup: m.grp,
      lines: m.lines,
      vendors: m.vendors,
      qty: m.qty,
      spendUsd: m.usd,
      soleSource: m.vendors === 1,
    })),
    volumeLeaders: volume.map((x) => ({ materialCode: x.code, description: x.descr, qty: x.qty, unit: x.unit })),
    soleSource: soleSource.map((x) => ({
      materialCode: x.code, description: x.descr, vendorName: x.vendor, lines: x.lines, spendUsd: x.usd,
    })),
    caps: { materials: limit, volumeLeaders: 20, soleSource: 50 },
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
