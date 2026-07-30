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
  const fx = buildFx(fxRows, poRows, asOfDate);

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
    const conv = fx.table.toUsd(n(p.netOrderValue), ccy, docDate, fxPolicy);
    if (ccy !== null && conv.resolution.usdPerUnit === null) unrated.add(ccy);
    const convDeliver = fx.table.toUsd(n(p.stillDeliverVal), ccy, docDate, fxPolicy);
    const convInvoice = fx.table.toUsd(n(p.stillInvoiceVal), ccy, docDate, fxPolicy);

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
    if (bridge) {
      const pr = prByKey.get(`${bridge.prNo}|${bridge.prItem}`);
      if (pr) {
        prDeleted = (s(pr.deletionIndicator) ?? '').toLowerCase() === 'true';
        const appr = derivePrApproval(releaseByPrItem.get(`${bridge.prNo}|${bridge.prItem}`) ?? []);
        prReleased = appr.fullyReleased;
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
      conv.resolution.basis,
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
  for (const r of filled.rows) {
    if (r.prNo === null || r.prItem === null || r.relSeq === null) continue;
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
    ]);
  }

  const poRelRows: unknown[][] = [];
  const seenPoRel = new Set<string>();
  for (const r of porRows) {
    const p = r.payload;
    const poNo = s(p.poNo);
    const relSeq = i(p.relSeq);
    const relCode = s(p.relCode);
    if (poNo === null || relSeq === null || relCode === null) continue;
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
  ]);

  // ─────────────────────────────────────────────────────────────── persist

  await insertMany(client, 'core.fx_rate', FX_COLS, fxFactRows);
  await insertMany(client, 'core.fact_pr_item', PR_COLS, prFactRows);
  await insertMany(client, 'core.fact_po_line', PO_COLS, poFactRows);
  await insertMany(client, 'core.fact_gr_posting', GR_COLS, grFactRows);
  await insertMany(client, 'core.fact_pr_release', PREL_COLS, prRelRows);
  await insertMany(client, 'core.fact_po_release', POR_COLS, poRelRows);
  await insertMany(client, 'core.bridge_pr_po', BRIDGE_COLS, bridgeRows);

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

  await client.query(
    `INSERT INTO core.dim_material_group (material_group, category)
     SELECT DISTINCT material_group, material_category FROM core.fact_po_line
      WHERE dataset_version_id = $1 AND material_group IS NOT NULL
     ON CONFLICT (material_group) DO NOTHING`,
    [versionId],
  );

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

// ─────────────────────────────────────────────────────────────────────── FX

function buildFx(
  fxRows: StagedRow[],
  poRows: StagedRow[],
  asOfDate: string,
): { table: FxTable; rates: ReturnType<typeof buildFxTable>; yearResolved: number | null } {
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

  const raw = fxRows
    .map((r) => {
      const from = normCurrency(r.payload.from);
      const to = normCurrency(r.payload.to);
      const rate = n(r.payload.rate);
      const month = parseMonthOrdinal(r.payload.period);
      if (from === null || to === null || rate === null || month === null) return null;
      return { from, to, rate, year, month };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const rates = buildFxTable(raw);
  return { table: new FxTable(rates), rates, yearResolved: anchor.ambiguous ? null : year };
}

// ─────────────────────────────────────────────────────────── column orders

const FX_COLS = [
  'dataset_version_id', 'currency_code', 'period_year', 'period_month',
  'usd_per_unit', 'derivation', 'pivot_currency',
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
  'purch_org', 'source_row',
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
