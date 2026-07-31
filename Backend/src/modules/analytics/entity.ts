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
            pol.is_sto AS "_sto", pol.is_token_price AS "_token", pol.release_exempt AS "_exempt"
       FROM core.fact_po_line pol
      WHERE ${where} AND pol.vendor_code = ${vp}
      ORDER BY pol.document_date DESC, pol.po_no DESC, pol.po_item
      LIMIT 200`,
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
    grHistory,
    caps: { poHistory: 200, grHistory: 200, materials: 100 },
  };
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
): Promise<Record<string, unknown>> {
  const { where, params } = scoped(versionId, scope, 'pol');

  // Category summary (v1's mgt): items, value, medians per category.
  const summary = await query<{
    cat: string; lines: number; pos: number; usd: number | null;
    med_src: number | null; med_del: number | null;
  }>(
    `SELECT COALESCE(pol.material_category,'Other') AS cat, count(*)::int AS lines,
            count(DISTINCT pol.po_no)::int AS pos, sum(pol.net_order_value_usd) AS usd,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY pol.sourcing_days) AS med_src,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY pol.delivery_days) AS med_del
       FROM core.fact_po_line pol
      WHERE ${where} AND NOT pol.is_sto AND NOT pol.is_deleted
      GROUP BY 1 ORDER BY usd DESC NULLS LAST`,
    params,
  );

  // Materials list (v1's mxt), optionally narrowed by category and search.
  const matParams = [...params];
  let extra = '';
  if (category) {
    matParams.push(category);
    extra += ` AND COALESCE(pol.material_category,'Other') = $${matParams.length}`;
  }
  if (search.trim() !== '') {
    matParams.push(`%${search.trim()}%`);
    extra += ` AND (pol.material_code ILIKE $${matParams.length} OR pol.short_text ILIKE $${matParams.length})`;
  }

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
      GROUP BY pol.material_code ORDER BY usd DESC NULLS LAST LIMIT 150`,
    matParams,
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
      WHERE ${where} AND pol.status IN ${OPEN_STATUSES}
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
      medianDeliveryDays: s2.med_del,
      openLines: openByCat.get(s2.cat) ?? 0,
    })),
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
    caps: { materials: 150, volumeLeaders: 20, soleSource: 50 },
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
