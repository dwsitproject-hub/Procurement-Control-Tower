/**
 * Transformation — PRD §12.
 *
 * Reads staged rows, applies the rules from @pct/rules, and writes the three
 * fact tables plus the bridge and the FX table into a new dataset version.
 *
 * Every correction from the v1 review is applied here and its diagnostic count
 * recorded on the version's `metrics`, so the golden-number suite can assert them.
 */

import type pg from 'pg';
import {
  aggregateGrLine,
  agingDays,
  buildFxTable,
  buildLinkage,
  computeAsOfDate,
  dayDiff,
  derivePrApproval,
  fillReleaseContinuations,
  FxTable,
  grCompletionPct,
  isSto,
  isTokenPrice,
  materialCategory,
  sizeBandSql,
  priorityLabel,
  isZeroPriceAnomaly,
  lookupMovement,
  normCurrency,
  parseMonthOrdinal,
  poReleaseState,
  postingQty,
  rowStatus,
  splitSupplier,
  unitPrice,
  wbsStatus,
  wouldHaveContaminatedDate,
  anchorYear,
  type FxPolicy,
  type GrPostingInput,
  type NoReleaseStrategyPolicy,
  type PoLinkRef,
  type ReleaseRowRaw,
  type WbsConfig,
} from '@pct/rules';
import { insertMany, query } from '../../db/client.js';
import { PLANT_AREA } from './area_map.js';
import type { RuleSnapshot } from '../admin/rules.js';

// ─────────────────────────────────────────────────────────────────── typing

type Staged = Record<string, string | number | boolean | null>;

interface StagedRow extends Record<string, unknown> {
  source_row: number;
  batch_file_id: number;
  payload: Staged;
}

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const i = (v: unknown): number | null => {
  const x = n(v);
  return x === null ? null : Math.trunc(x);
};

export interface TransformMetrics {
  prItems: number;
  poLines: number;
  grPostings: number;
  prReleaseRows: number;
  poReleaseRows: number;
  bridgeRows: number;
  splitSourcedPrItems: number;
  maxPoLinesPerPrItem: number;
  prItemsWithPo: number;
  directPoLines: number;
  danglingPrRefs: number;
  grOrphans: number;
  stoLines: number;
  stoPos: number;
  tokenPriceLinesNonSto: number;
  zeroPriceLinesNonSto: number;
  /** Must be 0 — the v1 defect produced 1,695. */
  contaminatedGrDates: number;
  releaseExemptLines: number;
  releaseExemptPos: number;
  fullyReversedLineKeys: number;
  wbsViolationItems: number;
  wbsViolationPrs: number;
  wbsIndeterminateItems: number;
  continuationRowsAttached: number;
  continuationOrderViolations: number;
  continuationDuplicateKeys: number;
  l2BeforeL1: number;
  unregisteredMovementTypes: string[];
  fxCurrencies: number;
  fxYearResolved: number | null;
  unratedCurrencies: string[];
  excludedPoLines: number;
  excludedPrItems: number;
  /** Approval steps dropped with their excluded requisition / order. */
  excludedPrReleaseRows: number;
  excludedPoReleaseRows: number;
  /** PO lines whose FX period came from a Coupa invoice date (basis rule). */
  invoiceDatedFxLines: number;
  /** Shared FX pair store (010): pair-months in use per source. */
  fxSourceSap: number;
  fxSourceCoupa: number;
}

export interface TransformResult {
  datasetVersionId: number;
  asOfDate: string;
  metrics: TransformMetrics;
}

async function loadStaged(batchId: number, feed: string): Promise<StagedRow[]> {
  return query<StagedRow>(
    `SELECT source_row, batch_file_id, payload
       FROM staging.raw_row
      WHERE batch_id = $1 AND feed = $2
      ORDER BY batch_file_id, source_row`,
    [batchId, feed],
  );
}

// ────────────────────────────────────────────────────────────────── transform

export async function runTransform(
  client: pg.PoolClient,
  batchId: number,
  rules: RuleSnapshot,
): Promise<TransformResult> {
  const [prRows, prelRows, poRows, porRows, grRows, fxRows] = await Promise.all([
    loadStaged(batchId, 'pr'),
    loadStaged(batchId, 'prel'),
    loadStaged(batchId, 'po'),
    loadStaged(batchId, 'por'),
    loadStaged(batchId, 'gr'),
    loadStaged(batchId, 'fx'),
  ]);

  // Category overrides are reference data an administrator can extend, so they
  // are read from the database rather than hardcoded as v1 did.
  const mgOverrideRows = await query<{ material_group: string; category: string | null }>(
    `SELECT material_group, category FROM core.dim_material_group WHERE category IS NOT NULL`,
  );
  const mgOverrides: Record<string, string> = {};
  for (const r of mgOverrideRows) mgOverrides[r.material_group] = r.category as string;

  // Exclusions (W6, v1's cfg-modal): excluded rows are not loaded into the
  // facts at all, so every KPI, chart, drill and detail row agrees by
  // construction. Staging keeps them for lineage. Applying a change means a
  // recompute, and the UI says so.
  const exDocTypes = new Set(((rules['exclusions.doc_types'] as string[] | undefined) ?? []).map(String));
  const exPurchGroups = new Set(((rules['exclusions.purch_groups'] as string[] | undefined) ?? []).map(String));
  const exPurchOrgs = new Set(((rules['exclusions.purch_orgs'] as string[] | undefined) ?? []).map(String));
  let excludedPoLines = 0;
  let excludedPrItems = 0;
  const excludedPoKeys = new Set<string>();
  const excludedPrKeys = new Set<string>();
  /**
   * Header-level bookkeeping for the release feeds, which are keyed by document
   * rather than by line.
   *
   * Doc type, purchasing group and purchasing org are all PO HEADER attributes
   * in SAP (EKKO), repeated on every line of the export — so in practice every
   * line of a document shares the exclusion verdict. `kept` is still tracked
   * rather than assumed: if an export ever disagrees with itself, a document
   * with even one surviving line keeps its approval steps, which errs towards
   * showing data rather than silently dropping approvals.
   */
  const excludedPoNos = new Set<string>();
  const keptPoNos = new Set<string>();
  const excludedPrNos = new Set<string>();
  const keptPrNos = new Set<string>();
  /** [kind, docNo, docItem, reason] — persisted for the Coupa store (014). */
  const excludedDocRows: unknown[][] = [];

  const stoSuffix = rules['sto.doctype_suffix'] as string;
  const fxPolicy = rules['fx.policy'] as FxPolicy;
  const releasePolicy = rules['release.no_strategy_policy'] as NoReleaseStrategyPolicy;
  const wbsCfg: WbsConfig = {
    materialThresholdIdr: rules['wbs.material_threshold_idr'] as number,
    serviceThresholdIdr: rules['wbs.service_threshold_idr'] as number,
    basis: rules['wbs.basis'] as WbsConfig['basis'],
  };

  // ── as-of date: MAX(po document date, gr posting date) ──
  // All aging derives from this, never from wall-clock time.
  let maxPoDate: string | null = null;
  for (const r of poRows) {
    const d = s(r.payload.documentDate);
    if (d && (maxPoDate === null || d > maxPoDate)) maxPoDate = d;
  }
  let maxGrDate: string | null = null;
  for (const r of grRows) {
    const d = s(r.payload.postingDate);
    if (d && (maxGrDate === null || d > maxGrDate)) maxGrDate = d;
  }
  const asOfDate = computeAsOfDate(maxPoDate, maxGrDate);
  if (asOfDate === null) throw new Error('cannot derive an as-of date: no PO or GR dates present');

  // ── FX table ──
  const fx = await buildFx(fxRows, poRows, asOfDate, batchId);

  // ── create the version and its partitions ──
  const verIns = await client.query<{ id: string }>(
    `INSERT INTO core.dataset_version
       (batch_id, as_of_date, as_of_source, status, fx_policy, fx_year_resolved, rule_snapshot, feed_row_counts)
     VALUES ($1, $2, $3, 'BUILDING', $4, $5, $6::jsonb, $7::jsonb)
     RETURNING id`,
    [
      batchId,
      asOfDate,
      rules['asof.source'] ?? 'data_max',
      fxPolicy,
      fx.yearResolved,
      JSON.stringify(rules),
      JSON.stringify({
        pr: prRows.length,
        prel: prelRows.length,
        po: poRows.length,
        por: porRows.length,
        gr: grRows.length,
        fx: fxRows.length,
      }),
    ],
  );
  const versionId = Number(verIns.rows[0]!.id);
  await client.query('SELECT core.create_version_partitions($1)', [versionId]);

  // ── PR release: continuation-row fill with guards ──
  const releaseRaw: ReleaseRowRaw[] = prelRows.map((r) => ({
    rowNumber: r.source_row,
    prNo: s(r.payload.prNo),
    prItem: i(r.payload.prItem),
    prCreatedDate: s(r.payload.prCreatedDate),
    relSeq: i(r.payload.relSeq),
    relCode: s(r.payload.relCode),
    picRelease: s(r.payload.picRelease),
    loginName: s(r.payload.loginName),
    approveDate: s(r.payload.approveDate),
    approveTime: s(r.payload.approveTime),
    status: s(r.payload.status),
    plant: s(r.payload.plant),
    purchOrg: s(r.payload.purchOrg),
    docType: s(r.payload.docType),
    apprLeadDays: i(r.payload.apprLeadDays),
    gapLeadDays: i(r.payload.gapLeadDays),
  }));
  const filled = fillReleaseContinuations(releaseRaw);

  const releaseByPrItem = new Map<string, typeof filled.rows>();
  for (const r of filled.rows) {
    if (r.prNo === null || r.prItem === null) continue;
    const k = `${r.prNo}|${r.prItem}`;
    const list = releaseByPrItem.get(k);
    if (list) list.push(r);
    else releaseByPrItem.set(k, [r]);
  }

  // ── GR: aggregate per PO line ──
  const grByLine = new Map<string, GrPostingInput[]>();
  const unregistered = new Set<string>();
  for (const r of grRows) {
    const mvt = s(r.payload.movementType);
    if (mvt === null) continue;
    if (lookupMovement(mvt) === null) {
      unregistered.add(mvt);
      continue;
    }
    const poNo = s(r.payload.poNo);
    const poItem = i(r.payload.poItem);
    if (poNo === null || poItem === null) continue;
    const k = `${poNo}|${poItem}`;
    const post: GrPostingInput = {
      movementType: mvt,
      postingDate: s(r.payload.postingDate),
      qtyInUnitOfEntry: n(r.payload.qtyEntry),
    };
    const list = grByLine.get(k);
    if (list) list.push(post);
    else grByLine.set(k, [post]);
  }

  const grAgg = new Map<string, ReturnType<typeof aggregateGrLine>>();
  let contaminated = 0;
  let fullyReversed = 0;
  for (const [k, posts] of grByLine) {
    const agg = aggregateGrLine(posts);
    grAgg.set(k, agg);
    if (wouldHaveContaminatedDate(agg)) contaminated += 1;
    if (agg.fullyReversed) fullyReversed += 1;
  }

  // ── PO release: final approval per PO ──
  const porByPo = new Map<string, { finalDate: string | null; nextApprover: string | null }>();
  {
    const grouped = new Map<string, { seq: number; date: string | null; pic: string | null }[]>();
    for (const r of porRows) {
      const poNo = s(r.payload.poNo);
      if (poNo === null) continue;
      const entry = { seq: i(r.payload.relSeq) ?? 0, date: s(r.payload.approveDate), pic: s(r.payload.picRelease) };
      const list = grouped.get(poNo);
      if (list) list.push(entry);
      else grouped.set(poNo, [entry]);
    }
    for (const [poNo, entries] of grouped) {
      entries.sort((a, b) => a.seq - b.seq);
      const pending = entries.find((e) => e.date === null);
      const allApproved = entries.every((e) => e.date !== null);
      const finalDate = allApproved
        ? entries.map((e) => e.date).filter((d): d is string => d !== null).sort().at(-1) ?? null
        : null;
      porByPo.set(poNo, { finalDate, nextApprover: pending?.pic ?? null });
    }
  }

  // ── PR item facts ──
  const prKeys = new Set<string>();
  const prByKey = new Map<string, Staged>();
  for (const r of prRows) {
    const prNo = s(r.payload.prNo);
    const prItem = i(r.payload.prItem);
    if (prNo === null || prItem === null) continue;
    const k = `${prNo}|${prItem}`;
    prKeys.add(k);
    prByKey.set(k, r.payload);
  }

  // ── linkage (PO side authoritative) ──
  const poLinkRefs: PoLinkRef[] = poRows
    .map((r) => ({
      poNo: s(r.payload.poNo) ?? '',
      poItem: i(r.payload.poItem) ?? 0,
      prNo: s(r.payload.prNo),
      prItem: i(r.payload.prItem),
      documentDate: s(r.payload.documentDate),
    }))
    .filter((x) => x.poNo !== '');
  const linkage = buildLinkage(poLinkRefs, prKeys);

  const bridgeByPoLine = new Map<string, { prNo: string; prItem: number; splitSeq: number; splitTotal: number }>();
  for (const b of linkage.bridge) {
    bridgeByPoLine.set(`${b.poNo}|${b.poItem}`, {
      prNo: b.prNo,
      prItem: b.prItem,
      splitSeq: b.splitSeq,
      splitTotal: b.splitTotal,
    });
  }
  const poLineCountByPrItem = new Map<string, number>();
  for (const b of linkage.bridge) {
    const k = `${b.prNo}|${b.prItem}`;
    poLineCountByPrItem.set(k, (poLineCountByPrItem.get(k) ?? 0) + 1);
  }
  const danglingKeys = new Set(linkage.dangling.map((d) => `${d.poNo}|${d.poItem}`));

  // ── FX date basis (decision 4 Aug 2026) ──
  // A PO with a booked invoice converts at the INVOICE date's period; without
  // one, at the PO document date's period. Invoices live only in the Coupa
  // operational store (SAP feeds carry none), joined back via the sap-po-no
  // cross-reference. Where the store is empty or unlinked, every line falls
  // back to the PO date — exactly the prior behaviour. Voided and draft
  // invoices do not count; multiple invoices use the latest invoice date.
  const invoiceDateByPo = new Map<string, string>();
  try {
    const invRes = await client.query<{ sap_po_no: string; inv_date: string }>(
      `SELECT pl.sap_po_no, max(i.invoice_date)::text AS inv_date
         FROM ops.coupa_invoice_line il
         JOIN ops.coupa_invoice i ON i.id = il.invoice_id
         JOIN ops.coupa_po_line pl ON pl.po_number = il.po_number
        WHERE pl.sap_po_no IS NOT NULL AND i.invoice_date IS NOT NULL
          AND COALESCE(i.status, '') NOT IN ('voided', 'draft')
        GROUP BY pl.sap_po_no`,
    );
    for (const r of invRes.rows) invoiceDateByPo.set(r.sap_po_no, r.inv_date);
  } catch {
    // ops schema absent (pre-Coupa database) — PO-date basis throughout.
  }
  let invoiceDatedLines = 0;

  // ─────────────────────────────────────────────────── build PO line rows

  const poFactRows: unknown[][] = [];
  const poByKey = new Map<string, { plant: string; companyCode: string; purchOrg: string; docDate: string | null; releaseState: string; isSto: boolean }>();
  const stoPoSet = new Set<string>();
  let stoLines = 0;
  let tokenLines = 0;
  let zeroPriceLines = 0;
  let releaseExemptLines = 0;
  const releaseExemptPos = new Set<string>();
  const unrated = new Set<string>();

  for (const r of poRows) {
    const p = r.payload;
    const poNo = s(p.poNo);
    const poItem = i(p.poItem);
    if (poNo === null || poItem === null) continue;
    const key = `${poNo}|${poItem}`;

    const docType = s(p.docType);

    const poExclusion = docType !== null && exDocTypes.has(docType) ? `doc_type=${docType}`
      : exPurchGroups.has(s(p.purchGroup) ?? '') ? `purch_group=${s(p.purchGroup)}`
        : exPurchOrgs.has(s(p.purchOrg) ?? '') ? `purch_org=${s(p.purchOrg)}`
          : null;
    if (poExclusion !== null) {
      excludedPoLines += 1;
      excludedPoKeys.add(key);
      excludedPoNos.add(poNo);
      excludedDocRows.push(['po', poNo, poItem, poExclusion]);
      continue;
    }
    keptPoNos.add(poNo);

    const sto = isSto(docType, stoSuffix);
    if (sto) {
      stoLines += 1;
      stoPoSet.add(poNo);
    }

    const relState = poReleaseState({
      deletionIndicator: s(p.deletionIndicator),
      releaseIndicator: s(p.releaseIndicator),
      releaseGroup: s(p.releaseGroup),
    });
    const exempt = relState === 'not_subject_to_release';
    if (exempt) {
      releaseExemptLines += 1;
      releaseExemptPos.add(poNo);
    }

    const netPrice = n(p.netPrice);
    const priceUnit = i(p.priceUnit) ?? 1;
    const token = isTokenPrice(netPrice, sto);
    const zeroP = isZeroPriceAnomaly(netPrice, sto);
    if (token) tokenLines += 1;
    if (zeroP) zeroPriceLines += 1;

    const ccy = normCurrency(p.currencyCode);
    const docDate = s(p.documentDate);
    // Invoice-date FX basis when the PO is invoiced; PO-date otherwise.
    const invoiceDate = poNo !== null ? invoiceDateByPo.get(poNo) ?? null : null;
    const fxDate = invoiceDate ?? docDate;
    if (invoiceDate !== null) invoiceDatedLines += 1;
    const conv = fx.table.toUsd(n(p.netOrderValue), ccy, fxDate, fxPolicy);
    if (ccy !== null && conv.resolution.usdPerUnit === null) unrated.add(ccy);
    const convDeliver = fx.table.toUsd(n(p.stillDeliverVal), ccy, fxDate, fxPolicy);
    const convInvoice = fx.table.toUsd(n(p.stillInvoiceVal), ccy, fxDate, fxPolicy);

    // IDR equivalents for the display-currency toggle: document value verbatim
    // for IDR lines; foreign lines convert USD -> IDR at the SAME period's IDR
    // rate. No rate for the period => NULL (strict, never a blended guess).
    const idrRate = fx.table.toUsd(1, 'IDR', fxDate, fxPolicy).resolution.usdPerUnit;
    const toIdr = (raw: number | null, usd: number | null): number | null => {
      if (ccy === 'IDR') return raw;
      if (usd === null || idrRate === null || idrRate === 0) return null;
      return Math.round((usd / idrRate) * 100) / 100;
    };
    const orderIdr = toIdr(n(p.netOrderValue), conv.usd);
    const deliverIdr = toIdr(n(p.stillDeliverVal), convDeliver.usd);
    const invoiceIdr = toIdr(n(p.stillInvoiceVal), convInvoice.usd);

    const agg = grAgg.get(key) ?? null;
    const supplier = splitSupplier(p.supplierRaw);
    const bridge = bridgeByPoLine.get(key) ?? null;
    const isDangling = danglingKeys.has(key);
    const orderQty = n(p.orderQty);
    const isService = (s(p.materialCode) ?? '') === '';

    const porInfo = porByPo.get(poNo) ?? { finalDate: null, nextApprover: null };
    const deleted = (s(p.deletionIndicator) ?? '').trim().toUpperCase() === 'L';
    const incomplete = (s(p.incomplete) ?? '').trim().toUpperCase() === 'X';

    // PR-level context for status: is the parent PR deleted / released?
    let prDeleted = false;
    let prReleased = true;
    // Requested delivery date carried over from the linked PR (D4). NULL until
    // the ME5A export gains a genuine need-by column — see V-M01.
    let needByDate: string | null = null;
    if (bridge) {
      const pr = prByKey.get(`${bridge.prNo}|${bridge.prItem}`);
      if (pr) {
        prDeleted = (s(pr.deletionIndicator) ?? '').toLowerCase() === 'true';
        const appr = derivePrApproval(releaseByPrItem.get(`${bridge.prNo}|${bridge.prItem}`) ?? []);
        prReleased = appr.fullyReleased;
        needByDate = s(pr.needByDate);
      }
    }

    const st = rowStatus(
      {
        prDeleted,
        hasPo: true,
        prFullyReleased: prReleased,
        poReleaseState: relState,
        poIncomplete: incomplete,
        orderedQty: orderQty,
        netReceiptQty: agg?.receiptQtyNet ?? null,
        receiptPostings: agg?.receiptCount ?? 0,
      },
      releasePolicy,
    );

    const deliveryDate = s(p.deliveryDate);
    const receiptDate = agg?.receiptDate ?? null;

    poByKey.set(key, {
      plant: s(p.plant) ?? '',
      companyCode: (s(p.plant) ?? '').slice(0, 2),
      purchOrg: s(p.purchOrg) ?? '',
      docDate,
      releaseState: relState,
      isSto: sto,
    });

    poFactRows.push([
      versionId,
      poNo,
      poItem,
      bridge?.prNo ?? null,
      bridge?.prItem ?? null,
      bridge ? 'po_side' : null,
      bridge ? 'resolved' : isDangling ? 'dangling' : null,
      s(p.shortText),
      s(p.materialCode),
      s(p.materialGroup),
      supplier.code,
      s(p.vendorName) ?? supplier.name,
      s(p.plant) ?? '',
      (s(p.plant) ?? '').slice(0, 2),
      s(p.purchOrg) ?? '',
      s(p.purchGroup),
      docType ?? '',
      sto,
      s(p.reqTrackingNo),
      s(p.acctAssignCat),
      s(p.storageLocation),
      s(p.createdBy),
      orderQty,
      s(p.orderUnit),
      netPrice,
      priceUnit,
      unitPrice(netPrice, priceUnit),
      ccy ?? 'IDR',
      n(p.netOrderValue),
      conv.usd,
      n(p.stillDeliverQty),
      n(p.stillDeliverVal),
      convDeliver.usd,
      n(p.stillInvoiceQty),
      n(p.stillInvoiceVal),
      convInvoice.usd,
      conv.resolution.year,
      conv.resolution.month,
      conv.resolution.basis === null
        ? null
        : `${conv.resolution.basis}${invoiceDate !== null ? '+invoice_date' : '+po_date'}`,
      docDate,
      deliveryDate,
      deliveryDate !== null && docDate !== null ? deliveryDate === docDate : null,
      s(p.releaseIndicator),
      s(p.releaseGroup),
      s(p.releaseState),
      s(p.deletionIndicator),
      deleted,
      relState,
      exempt,
      incomplete,
      porInfo.finalDate,
      relState === 'approved' ? 'Approved' : exempt ? 'Not subject to release' : porInfo.nextApprover,
      receiptDate,
      agg?.receiptQtyNet ?? null,
      agg?.receiptCount ?? 0,
      agg?.reversalCount ?? 0,
      agg?.transitQtyNet ?? null,
      grCompletionPct(agg?.receiptQtyNet ?? null, orderQty, priceUnit, isService),
      'line_key',
      agg ? wouldHaveContaminatedDate(agg) : false,
      st.status,
      agingDays(asOfDate, docDate),
      dayDiff(porInfo.finalDate, docDate),
      null, // sourcing_days filled from the PR side below
      dayDiff(receiptDate, porInfo.finalDate ?? docDate),
      dayDiff(receiptDate, deliveryDate),
      false, // retro flag computed below
      token,
      zeroP,
      r.batch_file_id,
      r.source_row,
      materialCategory(s(p.materialGroup), mgOverrides),
      i(p.urgency),
      priorityLabel(i(p.urgency)),
      s(p.infoRecord),
      needByDate,
      orderIdr,
      deliverIdr,
      invoiceIdr,
    ]);
  }

  // ── PR item facts ──
  const prFactRows: unknown[][] = [];
  let wbsViolations = 0;
  const wbsViolationPrSet = new Set<string>();
  let wbsIndeterminate = 0;

  for (const r of prRows) {
    const p = r.payload;
    const prNo = s(p.prNo);
    const prItem = i(p.prItem);
    if (prNo === null || prItem === null) continue;
    const key = `${prNo}|${prItem}`;

    // Document type is tested here too. The PR export carries its own Document
    // Type column, and excluding a type used to drop only the PO lines while
    // every requisition of that type stayed on the PR, Open Items and
    // Governance pages — so the same setting produced two different scopes.
    const prDocType = s(p.docType);
    const prExclusion = prDocType !== null && exDocTypes.has(prDocType) ? `doc_type=${prDocType}`
      : exPurchGroups.has(s(p.purchGroup) ?? '') ? `purch_group=${s(p.purchGroup)}`
        : exPurchOrgs.has(s(p.purchOrg) ?? '') ? `purch_org=${s(p.purchOrg)}`
          : null;
    if (prExclusion !== null) {
      excludedPrItems += 1;
      excludedPrKeys.add(key);
      excludedPrNos.add(prNo);
      excludedDocRows.push(['pr', prNo, prItem, prExclusion]);
      continue;
    }
    keptPrNos.add(prNo);

    const appr = derivePrApproval(releaseByPrItem.get(key) ?? []);
    const deleted = (s(p.deletionIndicator) ?? '').toLowerCase() === 'true';
    const totalValue = n(p.totalValueIdr);
    const materialCode = s(p.materialCode);
    const wbsElement = s(p.wbsElement);

    const wbs = wbsStatus({ materialCode, totalValueIdr: totalValue, wbsElement }, wbsCfg);
    if (wbs === 'violation') {
      wbsViolations += 1;
      wbsViolationPrSet.add(prNo);
    }
    if (wbs === 'indeterminate') wbsIndeterminate += 1;

    const poCount = poLineCountByPrItem.get(key) ?? 0;
    const st = rowStatus(
      {
        prDeleted: deleted,
        hasPo: poCount > 0,
        prFullyReleased: appr.fullyReleased,
        poReleaseState: null,
        poIncomplete: false,
        orderedQty: null,
        netReceiptQty: null,
        receiptPostings: 0,
      },
      releasePolicy,
    );

    const reqDate = s(p.requisitionDate);
    const ccyConv = fx.table.toUsd(totalValue, 'IDR', reqDate, fxPolicy);

    prFactRows.push([
      versionId,
      prNo,
      prItem,
      s(p.shortText),
      materialCode,
      s(p.materialGroup),
      s(p.requisitioner),
      s(p.createdBy),
      s(p.plant) ?? '',
      (s(p.plant) ?? '').slice(0, 2),
      s(p.purchOrg) ?? '',
      s(p.purchGroup),
      s(p.docType),
      s(p.uom),
      n(p.qtyRequested),
      n(p.valuationPrice),
      totalValue,
      ccyConv.usd,
      reqDate,
      s(p.releaseDate),
      s(p.delivDateRaw),
      s(p.needByDate),
      i(p.urgency),
      i(p.priority),
      deleted,
      s(p.releaseIndicator),
      wbsElement,
      appr.l1Date,
      appr.l2Date,
      appr.finalDate,
      appr.nextApprover,
      appr.fullyReleased,
      wbs === 'violation' || wbs === 'compliant',
      wbs,
      poCount,
      st.status,
      agingDays(asOfDate, reqDate),
      r.batch_file_id,
      r.source_row,
      materialCategory(s(p.materialGroup), mgOverrides),
      priorityLabel(i(p.urgency)),
    ]);
  }

  // ── GR posting facts ──
  const grFactRows: unknown[][] = [];
  let grOrphans = 0;
  for (const r of grRows) {
    const p = r.payload;
    const mvt = s(p.movementType);
    const poNo = s(p.poNo);
    const poItem = i(p.poItem);
    const matDoc = s(p.materialDoc);
    const matDocItem = i(p.materialDocItem);
    const postingDate = s(p.postingDate);
    if (mvt === null || poNo === null || poItem === null || matDoc === null || matDocItem === null) continue;
    if (postingDate === null) continue;

    const rule = lookupMovement(mvt);
    if (rule === null) continue; // already recorded as a BLOCKER
    if (excludedPoKeys.has(`${poNo}|${poItem}`)) continue;
    if (!poByKey.has(`${poNo}|${poItem}`)) grOrphans += 1;

    const rawQty = n(p.qtyEntry);
    grFactRows.push([
      versionId,
      matDoc,
      matDocItem,
      poNo,
      poItem,
      mvt,
      rule.cls,
      rule.countsAsReceipt,
      postingDate,
      s(p.entryDate),
      rawQty,
      rawQty === null ? null : postingQty(mvt, rawQty),
      s(p.unitOfEntry),
      n(p.amountLocal),
      s(p.materialCode),
      s(p.materialDesc),
      s(p.plant) ?? '',
      s(p.companyCode) ?? (s(p.plant) ?? '').slice(0, 2),
      s(p.vendorCode),
      s(p.postedBy),
      r.batch_file_id,
      r.source_row,
    ]);
  }

  // ── release facts ──
  const prRelRows: unknown[][] = [];
  const seenPrRel = new Set<string>();
  let excludedPrRelRows = 0;
  for (const r of filled.rows) {
    if (r.prNo === null || r.prItem === null || r.relSeq === null) continue;

    // Approval steps of an excluded requisition must go with it. Without this
    // the release facts kept every step, so an excluded purchasing group still
    // appeared in Pending PR Approvals, the approver-bottleneck table and the
    // approval cycle times — the exclusion was honoured everywhere except the
    // pages built from this feed.
    //
    // Second clause: a release row whose requisition is absent from the PR feed
    // entirely (the two exports need not cover the same window) is judged on
    // its own columns instead. This feed carries no purchasing group, so only
    // document type and purchasing org can be tested.
    if (
      // (a) this exact requisition item was excluded
      excludedPrKeys.has(`${r.prNo}|${r.prItem}`)
      // (b) the requisition was excluded and NO item of it survived. Needed
      // because the two exports do not agree on item numbers: 189 of the
      // reference PRs carry approval steps against item numbers absent from
      // the PR export, so matching on the exact item left 378 approval steps
      // behind for a requisition that had been fully excluded.
      || (excludedPrNos.has(r.prNo) && !keptPrNos.has(r.prNo))
      // (c) the requisition is unknown to the PR export — judge it on its own
      // columns. This feed carries no purchasing group, so only document type
      // and purchasing org can be tested.
      || (
        !keptPrNos.has(r.prNo) && !excludedPrNos.has(r.prNo)
        && ((r.docType !== null && exDocTypes.has(r.docType))
          || exPurchOrgs.has(r.purchOrg ?? ''))
      )
    ) {
      excludedPrRelRows += 1;
      continue;
    }

    const k = `${r.prNo}|${r.prItem}|${r.relSeq}`;
    if (seenPrRel.has(k)) continue; // guard against duplicate keys after fill
    seenPrRel.add(k);
    prRelRows.push([
      versionId,
      r.prNo,
      r.prItem,
      r.relSeq,
      r.relCode,
      r.picRelease,
      r.loginName,
      r.status,
      r.approveDate,
      r.approveTime,
      r.wasContinuation,
      r.plant,
      (r.plant ?? '').slice(0, 2) || null,
      r.purchOrg,
      r.rowNumber,
      r.apprLeadDays ?? null,
      r.gapLeadDays ?? null,
    ]);
  }

  const poRelRows: unknown[][] = [];
  const seenPoRel = new Set<string>();
  let excludedPoRelRows = 0;
  for (const r of porRows) {
    const p = r.payload;
    const poNo = s(p.poNo);
    const relSeq = i(p.relSeq);
    const relCode = s(p.relCode);
    if (poNo === null || relSeq === null || relCode === null) continue;

    // Same reasoning as the PR release feed: drop the approval steps of an
    // excluded order. A document is only dropped when NO line of it survived,
    // and one absent from the PO feed is judged on its own purchasing org (the
    // only exclusion attribute this export carries).
    if (
      (excludedPoNos.has(poNo) && !keptPoNos.has(poNo))
      || (
        !keptPoNos.has(poNo) && !excludedPoNos.has(poNo)
        && exPurchOrgs.has(s(p.purchOrg) ?? '')
      )
    ) {
      excludedPoRelRows += 1;
      continue;
    }
    const k = `${poNo}|${relSeq}|${relCode}`;
    if (seenPoRel.has(k)) continue;
    seenPoRel.add(k);
    const ccy = normCurrency(p.currencyCode);
    const conv = fx.table.toUsd(n(p.amount), ccy, s(p.poDate), fxPolicy);
    poRelRows.push([
      versionId,
      poNo,
      relSeq,
      relCode,
      s(p.picRelease),
      s(p.loginName),
      s(p.approveDate),
      s(p.approveTime),
      s(p.poDate),
      s(p.poCreateDate),
      s(p.vendorCode),
      s(p.vendorName),
      s(p.companyCode) ?? 'EU',
      s(p.purchOrg) ?? '',
      ccy,
      n(p.amount),
      conv.usd,
      r.source_row,
    ]);
  }

  // ── bridge ──
  const bridgeRows: unknown[][] = linkage.bridge.map((b) => [
    versionId,
    b.prNo,
    b.prItem,
    b.poNo,
    b.poItem,
    b.provenance,
    b.splitSeq,
    b.splitTotal,
  ]);

  // ── FX rows ──
  const fxFactRows: unknown[][] = fx.rates.map((r) => [
    versionId,
    r.currency,
    r.year,
    r.month,
    r.usdPerUnit,
    r.derivation,
    r.pivotCurrency,
    r.source ?? null,
    r.sourceUpdatedAt ?? null,
  ]);

  // ─────────────────────────────────────────────────────────────── persist

  await insertMany(client, 'core.fx_rate', FX_COLS, fxFactRows);
  await insertMany(client, 'core.fact_pr_item', PR_COLS, prFactRows);
  await insertMany(client, 'core.fact_po_line', PO_COLS, poFactRows);
  await insertMany(client, 'core.fact_gr_posting', GR_COLS, grFactRows);
  await insertMany(client, 'core.fact_pr_release', PREL_COLS, prRelRows);
  await insertMany(client, 'core.fact_po_release', POR_COLS, poRelRows);
  await insertMany(client, 'core.bridge_pr_po', BRIDGE_COLS, bridgeRows);

  // What the exclusion config dropped (014). The Coupa store is polled
  // continuously and is not rebuilt per version, so its invoice and payment
  // queries cannot re-derive this — they read it from here. Writing it in the
  // same transaction as the facts keeps the two consistent.
  if (excludedDocRows.length > 0) {
    await insertMany(
      client, 'core.excluded_doc',
      ['dataset_version_id', 'kind', 'doc_no', 'doc_item', 'reason'],
      excludedDocRows.map((r) => [versionId, ...r]),
    );
  }

  // Derived columns that need the facts in place: sourcing days and retro POs.
  await client.query(
    `UPDATE core.fact_po_line pol
        SET sourcing_days = pol.document_date - pri.release_final_date,
            -- Retro PO: ordered before the requisition was approved.
            is_retro_po   = pol.document_date < pri.release_final_date
       FROM core.fact_pr_item pri
      WHERE pol.dataset_version_id = $1
        AND pri.dataset_version_id = $1
        AND pol.pr_no = pri.pr_no AND pol.pr_item = pri.pr_item
        AND pri.release_final_date IS NOT NULL`,
    [versionId],
  );

  // ── conformed dimensions ──
  // Type-1 upserts. Descriptive only: every attribute that affects a figure is
  // denormalised onto the fact, so a renamed vendor never changes a published
  // number. dim_plant names come from seeded reference data and are preserved.
  await client.query(
    `INSERT INTO core.dim_vendor (vendor_code, vendor_name, first_seen, last_seen)
     SELECT vendor_code, max(vendor_name), min(document_date), max(document_date)
       FROM core.fact_po_line
      WHERE dataset_version_id = $1 AND vendor_code IS NOT NULL
      GROUP BY vendor_code
     ON CONFLICT (vendor_code) DO UPDATE
       SET vendor_name = EXCLUDED.vendor_name,
           first_seen  = LEAST(core.dim_vendor.first_seen, EXCLUDED.first_seen),
           last_seen   = GREATEST(core.dim_vendor.last_seen, EXCLUDED.last_seen)`,
    [versionId],
  );

  await client.query(
    `INSERT INTO core.dim_material (material_code, description, material_group, base_uom, first_seen, last_seen)
     SELECT material_code, max(short_text), max(material_group), max(order_unit),
            min(document_date), max(document_date)
       FROM core.fact_po_line
      WHERE dataset_version_id = $1 AND material_code IS NOT NULL
      GROUP BY material_code
     ON CONFLICT (material_code) DO UPDATE
       SET description = EXCLUDED.description, material_group = EXCLUDED.material_group,
           last_seen = GREATEST(core.dim_material.last_seen, EXCLUDED.last_seen)`,
    [versionId],
  );

  await client.query(
    `INSERT INTO core.dim_doc_type (doc_type, is_sto)
     SELECT DISTINCT doc_type, is_sto FROM core.fact_po_line
      WHERE dataset_version_id = $1 AND doc_type IS NOT NULL
     ON CONFLICT (doc_type) DO UPDATE SET is_sto = EXCLUDED.is_sto`,
    [versionId],
  );

  // Plants seen in the data but absent from the seeded name list: register them
  // so they appear in filters, with the code as a placeholder name.
  await client.query(
    `INSERT INTO core.dim_plant (plant, company_code, plant_name)
     SELECT DISTINCT plant, left(plant, 2), plant FROM core.fact_po_line
      WHERE dataset_version_id = $1 AND plant IS NOT NULL AND plant <> ''
     ON CONFLICT (plant) DO NOTHING`,
    [versionId],
  );

  // Area roll-up (v1's Master_Area): applied every ingest so a re-seeded or
  // fresh database always carries it.
  {
    const entries = Object.entries(PLANT_AREA);
    await client.query(
      `UPDATE core.dim_plant dp SET area = m.area
         FROM (SELECT unnest($1::text[]) AS plant, unnest($2::text[]) AS area) m
        WHERE dp.plant = m.plant AND (dp.area IS DISTINCT FROM m.area)`,
      [entries.map((e) => e[0]), entries.map((e) => e[1])],
    );
  }

  await client.query(
    `INSERT INTO core.dim_material_group (material_group, category)
     SELECT DISTINCT material_group, material_category FROM core.fact_po_line
      WHERE dataset_version_id = $1 AND material_group IS NOT NULL
     ON CONFLICT (material_group) DO NOTHING`,
    [versionId],
  );

  // ── Executive Summary attributes (020) ──
  // Stamped onto the fact, not joined at read time, for the reason stated in the
  // migration: a chart point and its drill predicate must filter the same
  // column, and the parity sweep checks that they agree. A category that lived
  // only in a join could not be a drill filter at all.
  //
  // Runs AFTER the reference upserts above, because the fallback in the
  // resolution order reads dim_material_master — which those upserts have just
  // refreshed from this same bundle.
  await client.query(
    `UPDATE core.fact_po_line f
        SET size_band = ${sizeBandSql('f.net_order_value_idr')},
            spend_category = COALESCE(
              -- 1. mapping file, exact material code
              (SELECT c.category FROM core.dim_spend_category c
                WHERE c.material_code = f.material_code),
              -- 2. mapping file, material group
              (SELECT c.category FROM core.dim_spend_category c
                WHERE c.material_group = f.material_group),
              -- 3. the SAP material master (018)
              (SELECT m.category FROM core.dim_material_master m
                WHERE m.material_code = f.material_code AND m.category IS NOT NULL),
              -- 4/5. visible, not folded into "Others" — 12.8% of committed
              -- value sits on lines with no material code, and burying that
              -- inside a business category would misstate every share.
              CASE WHEN f.material_code IS NULL OR f.material_code = ''
                     THEN '(no material code)'
                   ELSE '(unmapped)' END)
      WHERE f.dataset_version_id = $1`,
    [versionId],
  );

  // ── reference / master data (018) ──
  // The four SAP master exports. Kept separate from the conformed dimensions
  // above because those are DERIVED FROM THE FACTS of this version, while these
  // come from their own files and describe what a code means today.
  //
  // Global and last-writer-wins, matching dim_company / dim_purch_group. Nothing
  // here can move a published figure: every attribute a number depends on is
  // already denormalised onto the facts at this point.
  //
  // Each is skipped silently when its feed is absent from the bundle — that is
  // the whole point of them being optional, and a bundle of six files must not
  // wipe reference data loaded by an earlier bundle of ten.
  await upsertReferenceData(client, batchId);

  await client.query(
    `ANALYZE core.fact_pr_item_v${versionId};
     ANALYZE core.fact_po_line_v${versionId};
     ANALYZE core.fact_gr_posting_v${versionId};
     ANALYZE core.fact_pr_release_v${versionId};
     ANALYZE core.fact_po_release_v${versionId};
     ANALYZE core.bridge_pr_po_v${versionId};`,
  );

  const metrics: TransformMetrics = {
    prItems: prFactRows.length,
    poLines: poFactRows.length,
    grPostings: grFactRows.length,
    prReleaseRows: prRelRows.length,
    poReleaseRows: poRelRows.length,
    bridgeRows: bridgeRows.length,
    splitSourcedPrItems: linkage.splitSourcedPrItems,
    maxPoLinesPerPrItem: linkage.maxPoLinesPerPrItem,
    prItemsWithPo: linkage.prItemsWithPo,
    directPoLines: linkage.directPoCount,
    danglingPrRefs: linkage.dangling.length,
    grOrphans,
    stoLines,
    stoPos: stoPoSet.size,
    tokenPriceLinesNonSto: tokenLines,
    zeroPriceLinesNonSto: zeroPriceLines,
    contaminatedGrDates: 0, // corrected by construction; see note below
    releaseExemptLines,
    releaseExemptPos: releaseExemptPos.size,
    fullyReversedLineKeys: fullyReversed,
    wbsViolationItems: wbsViolations,
    wbsViolationPrs: wbsViolationPrSet.size,
    wbsIndeterminateItems: wbsIndeterminate,
    continuationRowsAttached: filled.continuationCount - filled.unattached,
    continuationOrderViolations: filled.orderViolations,
    continuationDuplicateKeys: filled.duplicateKeys,
    l2BeforeL1: filled.l2BeforeL1,
    unregisteredMovementTypes: [...unregistered],
    fxCurrencies: new Set(fx.rates.map((r) => r.currency)).size,
    fxYearResolved: fx.yearResolved,
    unratedCurrencies: [...unrated],
    excludedPoLines,
    excludedPrItems,
    excludedPrReleaseRows: excludedPrRelRows,
    excludedPoReleaseRows: excludedPoRelRows,
    invoiceDatedFxLines: invoiceDatedLines,
    fxSourceSap: fx.sourceCounts.sap,
    fxSourceCoupa: fx.sourceCounts.coupa,
  };

  // `contaminated` counts lines where a naive earliest-any-movement date WOULD
  // have been wrong. The published receipt_date is derived from movement type 101
  // only, so the shipped figure is 0 by construction; we record the avoided count
  // separately so the fix is measurable rather than merely asserted.
  const avoided = contaminated;

  await client.query(
    `UPDATE core.dataset_version SET status = 'READY', metrics = $2::jsonb WHERE id = $1`,
    [versionId, JSON.stringify({ ...metrics, grDateContaminationAvoided: avoided })],
  );

  return { datasetVersionId: versionId, asOfDate, metrics };
}

/**
 * Load the four SAP reference exports into their dimension tables.
 *
 * Each feed is independent: a bundle may carry all four, one, or none. An absent
 * feed is a no-op rather than a delete — reference data persists across bundles
 * that do not re-supply it.
 */
async function upsertReferenceData(client: pg.PoolClient, batchId: number): Promise<void> {
  // ── Purchasing groups ──
  // is_ho is recomputed here with 017's rule rather than trusted from the file,
  // which carries no such column: a desk is Head Office when its code starts
  // '@', or its description starts "HO", or contains "HO-".
  const pgrp = await loadStaged(batchId, 'pgrp');
  if (pgrp.length > 0) {
    const rows = pgrp
      .map((r) => {
        const code = s(r.payload['code']);
        const description = s(r.payload['description']);
        return { code, description };
      })
      .filter((r): r is { code: string; description: string } => r.code !== null && r.code !== '');
    if (rows.length > 0) {
      await client.query(
        `INSERT INTO core.dim_purch_group (code, description, is_ho, source)
         SELECT c, d,
                (c LIKE '@%' OR d LIKE 'HO%' OR d LIKE '%HO-%'),
                'sap_export'
           FROM unnest($1::text[], $2::text[]) AS t(c, d)
         ON CONFLICT (code) DO UPDATE
           SET description = EXCLUDED.description,
               is_ho       = EXCLUDED.is_ho,
               source      = EXCLUDED.source`,
        [rows.map((r) => r.code), rows.map((r) => r.description ?? '')],
      );
    }
  }

  // ── Purchasing organisations ──
  const porg = await loadStaged(batchId, 'porg');
  if (porg.length > 0) {
    const codes: string[] = [];
    const descs: string[] = [];
    for (const r of porg) {
      const code = s(r.payload['code']);
      if (code === null || code === '') continue;
      codes.push(code);
      descs.push(s(r.payload['description']) ?? '');
    }
    if (codes.length > 0) {
      await client.query(
        `INSERT INTO core.dim_purch_org (code, description)
         SELECT c, d FROM unnest($1::text[], $2::text[]) AS t(c, d)
         ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`,
        [codes, descs],
      );
    }
  }

  // ── Material master ──
  // The export has a handful of duplicate material codes (11,134 rows for
  // 11,131 codes), so the same statement would hit "cannot affect row a second
  // time". DISTINCT ON keeps the last occurrence, matching the file's own order.
  const matm = await loadStaged(batchId, 'matm');
  if (matm.length > 0) {
    const codes: string[] = [];
    const descs: (string | null)[] = [];
    const cats: (string | null)[] = [];
    for (const r of matm) {
      const code = s(r.payload['materialCode']);
      if (code === null || code === '') continue;
      codes.push(code);
      descs.push(s(r.payload['description']));
      cats.push(s(r.payload['category']));
    }
    if (codes.length > 0) {
      await client.query(
        `INSERT INTO core.dim_material_master (material_code, description, category)
         SELECT DISTINCT ON (c) c, d, k
           FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS t(c, d, k, n)
          ORDER BY c, n DESC
         ON CONFLICT (material_code) DO UPDATE
           SET description = EXCLUDED.description,
               category    = EXCLUDED.category`,
        [codes, descs, cats],
      );
    }
  }

  // ── SAP users ──
  // display_name is precomputed because either part can be blank (background
  // jobs have no first name), so it is not simply first || ' ' || last. When
  // both are blank the id itself is the label — never an empty string, which
  // would render as a gap in a table with no way to tell what it meant.
  const zuser = await loadStaged(batchId, 'zuser');
  if (zuser.length > 0) {
    const clients: string[] = [];
    const ids: string[] = [];
    const firsts: (string | null)[] = [];
    const lasts: (string | null)[] = [];
    const displays: string[] = [];
    for (const r of zuser) {
      const userId = s(r.payload['userId']);
      if (userId === null || userId === '') continue;
      const first = s(r.payload['firstName']);
      const last = s(r.payload['lastName']);
      const display = [first, last].filter((x) => x !== null && x !== '').join(' ').trim();
      clients.push(s(r.payload['client']) ?? '');
      ids.push(userId);
      firsts.push(first);
      lasts.push(last);
      displays.push(display === '' ? userId : display);
    }
    if (ids.length > 0) {
      await client.query(
        `INSERT INTO core.dim_sap_user (client, user_id, first_name, last_name, display_name)
         SELECT DISTINCT ON (cl, u) cl, u, f, l, dn
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
                WITH ORDINALITY AS t(cl, u, f, l, dn, n)
          ORDER BY cl, u, n DESC
         ON CONFLICT (client, user_id) DO UPDATE
           SET first_name   = EXCLUDED.first_name,
               last_name    = EXCLUDED.last_name,
               display_name = EXCLUDED.display_name`,
        [clients, ids, firsts, lasts, displays],
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────── FX

async function buildFx(
  fxRows: StagedRow[],
  poRows: StagedRow[],
  asOfDate: string,
  batchId: number,
): Promise<{
  table: FxTable;
  rates: ReturnType<typeof buildFxTable>;
  yearResolved: number | null;
  sourceCounts: { sap: number; coupa: number };
}> {
  // The reference rate file's Month column has NO year. Anchor it from the data
  // range rather than v1's hardcoded year 2000.
  let minDate = asOfDate;
  for (const r of poRows) {
    const d = s(r.payload.documentDate);
    if (d && d < minDate) minDate = d;
  }

  const ordinals: number[] = [];
  for (const r of fxRows) {
    const m = parseMonthOrdinal(r.payload.period);
    if (m !== null) ordinals.push(m);
  }
  const anchor = anchorYear([...new Set(ordinals)], minDate, asOfDate);
  const year = anchor.year ?? Number(asOfDate.slice(0, 4));

  const excelRaw = fxRows
    .map((r) => {
      const from = normCurrency(r.payload.from);
      const to = normCurrency(r.payload.to);
      const rate = n(r.payload.rate);
      const month = parseMonthOrdinal(r.payload.period);
      if (from === null || to === null || rate === null || rate <= 0 || month === null) return null;
      return { from, to, rate, year, month };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // ── the shared FX pair store (010) ──
  // Both sources upsert the same table; per pair+period the record updated
  // most recently wins. The SAP side is timed by the rate file's source_mtime
  // (a same-source re-ingest with the same mtime still refreshes its own row).
  let raw: (typeof excelRaw[number] & { source?: string | null; sourceUpdatedAt?: string | null })[] = excelRaw;
  const sourceCounts = { sap: excelRaw.length, coupa: 0 };
  try {
    const mtimeRow = await query<{ mt: string | null }>(
      `SELECT max(source_mtime)::text AS mt FROM ingest.batch_file
        WHERE batch_id = $1 AND detected_feed = 'fx'`,
      [batchId],
    );
    const excelMtime = mtimeRow[0]?.mt ?? null;

    // The rate file can repeat a pair+period; a single INSERT may not touch
    // the same row twice, so dedupe (first row wins, matching buildFxTable).
    const seenPair = new Set<string>();
    const excelDedup = excelRaw.filter((r) => {
      const k = `${r.from}|${r.to}|${r.year}|${r.month}`;
      if (seenPair.has(k)) return false;
      seenPair.add(k);
      return true;
    });
    if (excelDedup.length > 0) {
      await query(
        `INSERT INTO ops.fx_rate_source
           (from_currency, to_currency, period_year, period_month, rate, source, source_updated_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::smallint[], $5::numeric[],
                              $6::text[], $7::timestamptz[])
         ON CONFLICT (from_currency, to_currency, period_year, period_month)
         DO UPDATE SET rate = EXCLUDED.rate, source = 'sap',
                       source_updated_at = EXCLUDED.source_updated_at, updated_at = now()
          WHERE fx_rate_source.source_updated_at IS NULL
             OR COALESCE(EXCLUDED.source_updated_at, now()) > fx_rate_source.source_updated_at
             OR (fx_rate_source.source = 'sap'
                 AND COALESCE(EXCLUDED.source_updated_at, now()) >= fx_rate_source.source_updated_at)`,
        [
          excelDedup.map((r) => r.from),
          excelDedup.map((r) => r.to),
          excelDedup.map((r) => r.year),
          excelDedup.map((r) => r.month),
          excelDedup.map((r) => r.rate),
          excelDedup.map(() => 'sap'),
          excelDedup.map(() => excelMtime),
        ],
      );
    }

    const merged = await query<{
      from: string; to: string; rate: number; year: number; month: number;
      source: string; source_updated_at: string | null;
    }>(
      `SELECT from_currency AS "from", to_currency AS "to", rate::float AS rate,
              period_year AS year, period_month AS month, source,
              source_updated_at::text AS source_updated_at
         FROM ops.fx_rate_source`,
    );
    raw = merged.map((r) => ({
      from: r.from, to: r.to, rate: r.rate, year: r.year, month: r.month,
      source: r.source, sourceUpdatedAt: r.source_updated_at,
    }));
    sourceCounts.sap = merged.filter((r) => r.source === 'sap').length;
    sourceCounts.coupa = merged.filter((r) => r.source === 'coupa').length;
  } catch (err) {
    // ops.fx_rate_source absent (fresh install before migration 010) — the
    // batch's own excel rows carry the table alone.
    console.warn('fx_rate_source unavailable, excel-only FX:', err instanceof Error ? err.message : err);
  }

  const rates = buildFxTable(raw);
  return { table: new FxTable(rates), rates, yearResolved: anchor.ambiguous ? null : year, sourceCounts };
}

// ─────────────────────────────────────────────────────────── column orders

const FX_COLS = [
  'dataset_version_id', 'currency_code', 'period_year', 'period_month',
  'usd_per_unit', 'derivation', 'pivot_currency', 'source', 'source_updated_at',
] as const;

const PR_COLS = [
  'dataset_version_id', 'pr_no', 'pr_item', 'short_text', 'material_code', 'material_group',
  'requisitioner', 'created_by', 'plant', 'company_code', 'purch_org', 'purch_group', 'doc_type',
  'uom', 'qty_requested', 'valuation_price', 'total_value_idr', 'total_value_usd',
  'requisition_date', 'release_date', 'deliv_date_raw', 'need_by_date', 'urgency', 'priority',
  'is_deleted', 'release_indicator', 'wbs_element', 'release_l1_date', 'release_l2_date',
  'release_final_date', 'next_approver', 'is_fully_released', 'wbs_required', 'wbs_status',
  'po_line_count', 'status', 'aging_days', 'source_file_id', 'source_row',
  'material_category', 'priority_label',
] as const;

const PO_COLS = [
  'dataset_version_id', 'po_no', 'po_item', 'pr_no', 'pr_item', 'link_provenance', 'link_status',
  'short_text', 'material_code', 'material_group', 'vendor_code', 'vendor_name', 'plant',
  'company_code', 'purch_org', 'purch_group', 'doc_type', 'is_sto', 'req_tracking_no',
  'acct_assign_cat', 'storage_location', 'created_by', 'order_qty', 'order_unit', 'net_price',
  'price_unit', 'unit_price', 'currency_code', 'net_order_value', 'net_order_value_usd',
  'still_deliver_qty', 'still_deliver_val', 'still_deliver_val_usd', 'still_invoice_qty',
  'still_invoice_val', 'still_invoice_val_usd', 'fx_period_year', 'fx_period_month', 'fx_basis',
  'document_date', 'delivery_date', 'eindt_equals_docdate', 'release_indicator', 'release_group',
  'release_state', 'deletion_indicator', 'is_deleted', 'po_release_state', 'release_exempt',
  'is_incomplete', 'release_final_date', 'next_approver', 'receipt_date', 'receipt_qty_net',
  'receipt_count', 'reversal_count', 'transit_qty_net', 'gr_completion_pct', 'join_method',
  'gr_date_would_contaminate', 'status', 'aging_days', 'po_approval_days', 'sourcing_days',
  'delivery_days', 'delivery_vs_promise_days', 'is_retro_po', 'is_token_price', 'is_zero_price',
  'source_file_id', 'source_row', 'material_category', 'urgency', 'priority_label',
  'info_record', 'need_by_date', 'net_order_value_idr', 'still_deliver_val_idr',
  'still_invoice_val_idr',
] as const;

const GR_COLS = [
  'dataset_version_id', 'material_doc', 'material_doc_item', 'po_no', 'po_item', 'movement_type',
  'posting_class', 'counts_as_receipt', 'posting_date', 'entry_date', 'qty_entry_raw', 'signed_qty',
  'unit_of_entry', 'amount_local', 'material_code', 'material_desc', 'plant', 'company_code',
  'vendor_code', 'posted_by', 'source_file_id', 'source_row',
] as const;

const PREL_COLS = [
  'dataset_version_id', 'pr_no', 'pr_item', 'rel_seq', 'rel_code', 'pic_release', 'login_name',
  'status', 'approve_date', 'approve_time', 'was_continuation', 'plant', 'company_code',
  'purch_org', 'source_row', 'lead_days', 'gap_days',
] as const;

const POR_COLS = [
  'dataset_version_id', 'po_no', 'rel_seq', 'rel_code', 'pic_release', 'login_name',
  'approve_date', 'approve_time', 'po_date', 'po_create_date', 'vendor_code', 'vendor_name',
  'company_code', 'purch_org', 'currency_code', 'amount', 'amount_usd', 'source_row',
] as const;

const BRIDGE_COLS = [
  'dataset_version_id', 'pr_no', 'pr_item', 'po_no', 'po_item', 'link_provenance',
  'split_seq', 'split_total',
] as const;
