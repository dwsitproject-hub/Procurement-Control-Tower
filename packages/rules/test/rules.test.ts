import { describe, it, expect } from 'vitest';
import {
  // movement
  lookupMovement,
  signedQty,
  establishesReceiptDate,
  // sto
  isSto,
  isTokenPrice,
  isZeroPriceAnomaly,
  unitPrice,
  // wbs
  wbsStatus,
  wbsStatusPrTotal,
  wbsThresholdLabel,
  DEFAULT_WBS_CONFIG,
  // aging
  agingDays,
  dayDiff,
  agingBand,
  computeAsOfDate,
  freshnessState,
  // status
  poReleaseState,
  rowStatus,
  countsInPendingApprovalQueue,
  // gr
  aggregateGrLine,
  grCompletionPct,
  wouldHaveContaminatedDate,
  postingQty,
  // linkage
  buildLinkage,
  fillReleaseContinuations,
  isContinuationRow,
  derivePrApproval,
  type ReleaseRowRaw,
} from '../src/index.js';

describe('movement register', () => {
  it('registers the four types present in the reference data plus 122', () => {
    expect(lookupMovement('101')?.cls).toBe('receipt');
    expect(lookupMovement('102')?.cls).toBe('reversal');
    expect(lookupMovement('641')?.cls).toBe('transfer');
    expect(lookupMovement('642')?.cls).toBe('transfer_reversal');
    expect(lookupMovement('122')?.cls).toBe('reversal');
  });

  it('returns null for an unregistered type (BLOCKER V-R07, never a guess)', () => {
    expect(lookupMovement('901')).toBeNull();
    expect(lookupMovement(null)).toBeNull();
    expect(() => signedQty('901', 10)).toThrow(/Unregistered movement type/);
  });

  it('derives the sign from the movement type, not from the data', () => {
    // The reference export happens to sign 102 negative. Deriving the sign makes
    // netting correct even if a future export emits absolute values.
    expect(signedQty('101', 10)).toBe(10);
    expect(signedQty('102', 10)).toBe(-10);
    expect(signedQty('102', -10)).toBe(-10); // already negative — still -10
    expect(signedQty('641', 5)).toBe(5);
    expect(signedQty('642', 5)).toBe(-5);
  });

  it('only 101 establishes the receipt date', () => {
    expect(establishesReceiptDate('101')).toBe(true);
    expect(establishesReceiptDate('641')).toBe(false);
    expect(establishesReceiptDate('102')).toBe(false);
  });

  it('641/642 do not count toward receipts', () => {
    expect(lookupMovement('641')?.countsAsReceipt).toBe(false);
    expect(lookupMovement('642')?.countsAsReceipt).toBe(false);
    expect(lookupMovement('101')?.countsAsReceipt).toBe(true);
    expect(lookupMovement('102')?.countsAsReceipt).toBe(true);
  });
});

describe('STO classification', () => {
  it('is exactly ends-with-70', () => {
    expect(isSto('EU70')).toBe(true);
    expect(isSto('EU20')).toBe(false);
    expect(isSto('EU21')).toBe(false);
    // Other series in the reference data flow as normal purchases
    expect(isSto('EO21')).toBe(false);
    expect(isSto('SC21')).toBe(false);
    expect(isSto('PS21')).toBe(false);
    expect(isSto('JP21')).toBe(false);
  });

  it('handles blanks', () => {
    expect(isSto(null)).toBe(false);
    expect(isSto('')).toBe(false);
    expect(isSto('   ')).toBe(false);
  });

  it('honours a configured suffix', () => {
    expect(isSto('EU80', '80')).toBe(true);
    expect(isSto('EU70', '80')).toBe(false);
  });
});

describe('token and zero price', () => {
  it('excludes STO lines from the token warning', () => {
    // Including STO reports 4,527 "token" lines on the reference data instead of
    // the genuine 107.
    expect(isTokenPrice(1, false)).toBe(true);
    expect(isTokenPrice(1, true)).toBe(false);
    expect(isTokenPrice(0.5, false)).toBe(true);
  });

  it('does not treat 0 as a token price', () => {
    expect(isTokenPrice(0, false)).toBe(false);
    expect(isZeroPriceAnomaly(0, false)).toBe(true);
    expect(isZeroPriceAnomaly(0, true)).toBe(false); // all 4,453 STO lines are 0
  });

  it('ignores nulls', () => {
    expect(isTokenPrice(null, false)).toBe(false);
    expect(isZeroPriceAnomaly(null, false)).toBe(false);
  });
});

describe('unit price divides by price unit', () => {
  it('divides — 398 reference lines have price_unit > 1', () => {
    expect(unitPrice(6000, 1)).toBe(6000);
    expect(unitPrice(6000, 10)).toBe(600);
    expect(unitPrice(6000, 100)).toBe(60);
  });

  it('treats a missing or zero price unit as 1', () => {
    expect(unitPrice(500, null)).toBe(500);
    expect(unitPrice(500, 0)).toBe(500);
  });

  it('propagates null price', () => {
    expect(unitPrice(null, 10)).toBeNull();
  });
});

describe('WBS policy', () => {
  it('classifies a material item over threshold without WBS as a violation', () => {
    expect(
      wbsStatus({ materialCode: '929.001.005', totalValueIdr: 198_640_596, wbsElement: null }),
    ).toBe('violation');
  });

  it('classifies a material item over threshold with WBS as compliant', () => {
    expect(
      wbsStatus({ materialCode: '929.001.005', totalValueIdr: 198_640_596, wbsElement: 'P-1234' }),
    ).toBe('compliant');
  });

  it('uses the higher service threshold when there is no material code', () => {
    // 100M is over the 30M material threshold but under the 150M service one
    expect(wbsStatus({ materialCode: null, totalValueIdr: 100_000_000, wbsElement: null })).toBe(
      'not_required',
    );
    expect(wbsStatus({ materialCode: '', totalValueIdr: 200_000_000, wbsElement: null })).toBe(
      'violation',
    );
  });

  it('reports zero or missing valuation as indeterminate, NEVER compliant', () => {
    // 4,211 reference items (20.9%) land here. Absence of data is not compliance.
    expect(wbsStatus({ materialCode: 'X', totalValueIdr: 0, wbsElement: null })).toBe('indeterminate');
    expect(wbsStatus({ materialCode: 'X', totalValueIdr: null, wbsElement: null })).toBe('indeterminate');
    expect(wbsStatus({ materialCode: 'X', totalValueIdr: -5, wbsElement: null })).toBe('indeterminate');
  });

  it('respects configurable thresholds (decision D1)', () => {
    const cfg = { ...DEFAULT_WBS_CONFIG, materialThresholdIdr: 50_000_000 };
    const item = { materialCode: 'X', totalValueIdr: 40_000_000, wbsElement: null };
    expect(wbsStatus(item)).toBe('violation'); // 40M >= 30M default
    expect(wbsStatus(item, cfg)).toBe('not_required'); // 40M < 50M configured
  });

  it('supports the per-PR-total basis', () => {
    const items = [
      { materialCode: 'A', totalValueIdr: 20_000_000, wbsElement: null },
      { materialCode: 'B', totalValueIdr: 20_000_000, wbsElement: null },
    ];
    // Each item is under 30M, but the PR total is 40M
    expect(items.every((i) => wbsStatus(i) === 'not_required')).toBe(true);
    expect(wbsStatusPrTotal(items)).toBe('violation');
  });

  it('renders the threshold label that must appear on the card', () => {
    expect(wbsThresholdLabel(DEFAULT_WBS_CONFIG, '2026-08-01')).toBe(
      '≥ IDR 30M material / ≥ IDR 150M service · per item · effective 2026-08-01',
    );
  });
});

describe('aging is measured from the as-of date, never the clock', () => {
  it('computes from the supplied as-of date', () => {
    expect(agingDays('2026-07-27', '2026-01-01')).toBe(207);
    expect(agingDays('2026-07-27', '2026-07-27')).toBe(0);
  });

  it('is stable regardless of when the test runs', () => {
    // The v1 defect: wall-clock aging inflated every >60d KPI by ~180 days when
    // an unchanged export was reopened six months later.
    const a = agingDays('2026-07-27', '2026-05-01');
    const b = agingDays('2026-07-27', '2026-05-01');
    expect(a).toBe(b);
    expect(a).toBe(87);
  });

  it('returns null for a missing reference date', () => {
    expect(agingDays('2026-07-27', null)).toBeNull();
  });

  it('computes day differences across year boundaries', () => {
    expect(dayDiff('2026-01-01', '2025-12-31')).toBe(1);
    expect(dayDiff('2026-01-24', '2023-12-28')).toBe(758);
  });

  it('bands aging', () => {
    expect(agingBand(0)).toBe('0-30');
    expect(agingBand(30)).toBe('0-30');
    expect(agingBand(61)).toBe('61-90');
    expect(agingBand(207)).toBe('180+');
    expect(agingBand(null)).toBeNull();
  });

  it('derives the as-of date as the max business date', () => {
    expect(computeAsOfDate('2026-07-27', '2026-07-26')).toBe('2026-07-27');
    expect(computeAsOfDate('2026-07-20', '2026-07-27')).toBe('2026-07-27');
    expect(computeAsOfDate(null, '2026-07-27')).toBe('2026-07-27');
    expect(computeAsOfDate(null, null)).toBeNull();
  });

  it('derives freshness state from as-of lag', () => {
    expect(freshnessState('2026-07-27', '2026-07-28')).toBe('current');
    expect(freshnessState('2026-07-27', '2026-07-31')).toBe('ageing');
    expect(freshnessState('2026-07-27', '2026-08-15')).toBe('stale');
  });
});

describe('PO release state — the v1 correction', () => {
  it('reads deletion from the deletion indicator, not a blank release indicator', () => {
    expect(
      poReleaseState({ deletionIndicator: 'L', releaseIndicator: '2', releaseGroup: 'HO' }),
    ).toBe('deleted');
  });

  it('treats blank indicator AND blank group as release-exempt, not deleted', () => {
    // v1 mapped this to PO-Deleted, hiding 241 live lines / IDR 1.51bn.
    expect(
      poReleaseState({ deletionIndicator: null, releaseIndicator: null, releaseGroup: null }),
    ).toBe('not_subject_to_release');
  });

  it('classifies approved and pending', () => {
    expect(poReleaseState({ deletionIndicator: null, releaseIndicator: '2', releaseGroup: 'HO' })).toBe('approved');
    expect(poReleaseState({ deletionIndicator: null, releaseIndicator: '1', releaseGroup: 'HO' })).toBe('approved');
    expect(poReleaseState({ deletionIndicator: null, releaseIndicator: 'C', releaseGroup: 'HO' })).toBe('approved');
    expect(poReleaseState({ deletionIndicator: null, releaseIndicator: 'X', releaseGroup: 'HO' })).toBe('pending');
  });

  it('treats a blank indicator WITH a group as pending, not exempt', () => {
    expect(
      poReleaseState({ deletionIndicator: null, releaseIndicator: null, releaseGroup: 'HO' }),
    ).toBe('pending');
  });
});

describe('row status', () => {
  const base = {
    prDeleted: false,
    hasPo: true,
    prFullyReleased: true,
    poReleaseState: 'approved' as const,
    poIncomplete: false,
    orderedQty: 10,
    netReceiptQty: 0,
    receiptPostings: 0,
  };

  it('evaluates deletion first', () => {
    expect(rowStatus({ ...base, prDeleted: true }).status).toBe('PR-Deleted');
    expect(rowStatus({ ...base, poReleaseState: 'deleted' }).status).toBe('PO-Deleted');
  });

  it('handles PR-only rows', () => {
    expect(rowStatus({ ...base, hasPo: false, prFullyReleased: false }).status).toBe('Unapproved PR');
    expect(rowStatus({ ...base, hasPo: false, prFullyReleased: true }).status).toBe('PR Approved-No PO');
  });

  it('derives receipt-driven statuses', () => {
    expect(rowStatus({ ...base, netReceiptQty: 0 }).status).toBe('PO-No GR');
    expect(rowStatus({ ...base, netReceiptQty: 4 }).status).toBe('Partially Delivered');
    expect(rowStatus({ ...base, netReceiptQty: 10 }).status).toBe('Delivered');
    expect(rowStatus({ ...base, netReceiptQty: 12 }).status).toBe('Delivered');
  });

  it('has a Fully Reversed state that v1 lacked (139 reference line keys)', () => {
    expect(rowStatus({ ...base, netReceiptQty: 0, receiptPostings: 2 }).status).toBe('Fully Reversed');
    expect(rowStatus({ ...base, netReceiptQty: -5, receiptPostings: 3 }).status).toBe('Fully Reversed');
  });

  it('flags release-exempt lines and drives status from receipts (decision D2 flag_only)', () => {
    const r = rowStatus({ ...base, poReleaseState: 'not_subject_to_release', netReceiptQty: 10 });
    expect(r.status).toBe('Delivered');
    expect(r.releaseExempt).toBe(true);
  });

  it('honours treat_as_pending if the policy is changed', () => {
    const r = rowStatus(
      { ...base, poReleaseState: 'not_subject_to_release', netReceiptQty: 10 },
      'treat_as_pending',
    );
    expect(r.status).toBe('PO-Not Approved');
    expect(r.releaseExempt).toBe(true);
  });

  it('excludes release-exempt POs from the pending-approval queue under flag_only', () => {
    // They have no release record at all, so "pending" would strand them forever.
    expect(countsInPendingApprovalQueue('pending')).toBe(true);
    expect(countsInPendingApprovalQueue('not_subject_to_release')).toBe(false);
    expect(countsInPendingApprovalQueue('not_subject_to_release', 'treat_as_pending')).toBe(true);
    expect(countsInPendingApprovalQueue('approved')).toBe(false);
  });
});

describe('GR aggregation — the three v1 corrections', () => {
  it('takes the receipt date from 101 only, ignoring earlier 641 transfers', () => {
    // This is the 11.2% / 7-day defect: a 641 transfer posted a week before the
    // actual receipt would have become the GR date.
    const agg = aggregateGrLine([
      { movementType: '641', postingDate: '2026-01-01', qtyInUnitOfEntry: 100 },
      { movementType: '641', postingDate: '2026-01-01', qtyInUnitOfEntry: -100 },
      { movementType: '101', postingDate: '2026-01-08', qtyInUnitOfEntry: 100 },
    ]);
    expect(agg.receiptDate).toBe('2026-01-08');
    expect(agg.earliestAnyPostingDate).toBe('2026-01-01');
    expect(wouldHaveContaminatedDate(agg)).toBe(true);
  });

  it('nets 102 reversals against 101 receipts', () => {
    const agg = aggregateGrLine([
      { movementType: '101', postingDate: '2026-01-08', qtyInUnitOfEntry: 100 },
      { movementType: '102', postingDate: '2026-01-10', qtyInUnitOfEntry: -30 },
    ]);
    expect(agg.receiptQtyNet).toBe(70);
    expect(agg.reversalCount).toBe(1);
  });

  it('nets reversals correctly even when the source sends absolute values', () => {
    const agg = aggregateGrLine([
      { movementType: '101', postingDate: '2026-01-08', qtyInUnitOfEntry: 100 },
      { movementType: '102', postingDate: '2026-01-10', qtyInUnitOfEntry: 30 }, // positive!
    ]);
    expect(agg.receiptQtyNet).toBe(70);
  });

  it('keeps 641/642 transit quantities out of receipt quantities', () => {
    // Transfer legs arrive signed in the source: the 642 reversal leg is negative.
    const agg = aggregateGrLine([
      { movementType: '641', postingDate: '2026-01-01', qtyInUnitOfEntry: 500 },
      { movementType: '642', postingDate: '2026-01-02', qtyInUnitOfEntry: -500 },
      { movementType: '101', postingDate: '2026-01-05', qtyInUnitOfEntry: 20 },
    ]);
    expect(agg.receiptQtyNet).toBe(20);
    expect(agg.transitQtyNet).toBe(0);
    expect(agg.transferCount).toBe(2);
  });

  it('does not present a transfer-only line as received (47 reference line keys)', () => {
    const agg = aggregateGrLine([
      { movementType: '641', postingDate: '2026-01-01', qtyInUnitOfEntry: 100 },
      { movementType: '641', postingDate: '2026-01-02', qtyInUnitOfEntry: -100 },
    ]);
    expect(agg.receiptDate).toBeNull();
    expect(agg.receiptQtyNet).toBeNull();
    expect(agg.transitQtyNet).toBe(0);
    expect(agg.fullyReversed).toBe(false);
  });

  it('detects a fully reversed line', () => {
    const agg = aggregateGrLine([
      { movementType: '101', postingDate: '2026-01-08', qtyInUnitOfEntry: 50 },
      { movementType: '102', postingDate: '2026-01-09', qtyInUnitOfEntry: -50 },
    ]);
    expect(agg.receiptQtyNet).toBe(0);
    expect(agg.fullyReversed).toBe(true);
  });

  it('throws on an unregistered movement type', () => {
    expect(() =>
      aggregateGrLine([{ movementType: '901', postingDate: '2026-01-01', qtyInUnitOfEntry: 1 }]),
    ).toThrow(/Unregistered movement type/);
  });
});

describe('grCompletionPct', () => {
  it('divides by price unit', () => {
    expect(grCompletionPct(100, 10, 1, false)).toBe(1000);
    expect(grCompletionPct(100, 10, 10, false)).toBe(100);
  });

  it('caps services at 100%', () => {
    expect(grCompletionPct(500, 1, 1, true)).toBe(100);
    expect(grCompletionPct(500, 1, 1, false)).toBe(50000);
  });

  it('returns null rather than 0 when inputs are missing', () => {
    expect(grCompletionPct(null, 10, 1, false)).toBeNull();
    expect(grCompletionPct(10, null, 1, false)).toBeNull();
    expect(grCompletionPct(10, 0, 1, false)).toBeNull();
  });
});

describe('PR to PO linkage', () => {
  const known = new Set(['1000009640|1', '1000009590|12', '1000008301|1']);

  it('builds the bridge and counts split sourcing', () => {
    const r = buildLinkage(
      [
        { poNo: 'PO1', poItem: 1, prNo: '1000009640', prItem: 1, documentDate: '2026-01-01' },
        { poNo: 'PO2', poItem: 1, prNo: '1000009640', prItem: 1, documentDate: '2026-02-01' },
        { poNo: 'PO3', poItem: 1, prNo: '1000009590', prItem: 12, documentDate: '2026-01-05' },
      ],
      known,
    );
    expect(r.bridge).toHaveLength(3);
    expect(r.splitSourcedPrItems).toBe(1);
    expect(r.maxPoLinesPerPrItem).toBe(2);
    expect(r.prItemsWithPo).toBe(2);

    const split = r.bridge.filter((b) => b.prNo === '1000009640');
    expect(split.map((s) => s.splitSeq)).toEqual([1, 2]);
    expect(split.every((s) => s.splitTotal === 2)).toBe(true);
  });

  it('keeps dangling references as dangling, never fabricating a PR', () => {
    const r = buildLinkage(
      [{ poNo: 'PO9', poItem: 1, prNo: '9999999999', prItem: 1, documentDate: '2026-01-01' }],
      known,
    );
    expect(r.bridge).toHaveLength(0);
    expect(r.dangling).toHaveLength(1);
  });

  it('counts direct POs separately', () => {
    const r = buildLinkage(
      [
        { poNo: 'PO1', poItem: 1, prNo: null, prItem: null, documentDate: '2026-01-01' },
        { poNo: 'PO2', poItem: 1, prNo: null, prItem: null, documentDate: '2026-01-01' },
      ],
      known,
    );
    expect(r.directPoCount).toBe(2);
    expect(r.bridge).toHaveLength(0);
  });
});

describe('PR Release continuation rows', () => {
  const row = (o: Partial<ReleaseRowRaw>): ReleaseRowRaw => ({
    rowNumber: 0,
    prNo: null,
    prItem: null,
    prCreatedDate: null,
    relSeq: null,
    relCode: null,
    picRelease: null,
    loginName: null,
    approveDate: null,
    approveTime: null,
    status: null,
    plant: null,
    purchOrg: null,
    docType: null,
    ...o,
  });

  it('recognises the continuation signature: blank PR No and PR Item = 0', () => {
    expect(isContinuationRow(row({ prNo: null, prItem: 0 }))).toBe(true);
    expect(isContinuationRow(row({ prNo: null, prItem: null }))).toBe(true);
    expect(isContinuationRow(row({ prNo: '1000008301', prItem: 1 }))).toBe(false);
  });

  it('fills identifiers from the parent row', () => {
    // Reproduces rows 111-114 of the reference export
    const r = fillReleaseContinuations([
      row({ rowNumber: 111, prNo: '1000008301', prItem: 1, relSeq: 1, relCode: '25', approveDate: '2025-04-10' }),
      row({ rowNumber: 112, prNo: null, prItem: 0, relSeq: 2, relCode: '11', approveDate: '2025-04-14' }),
      row({ rowNumber: 113, prNo: '1000008301', prItem: 2, relSeq: 1, relCode: '25', approveDate: '2025-04-10' }),
      row({ rowNumber: 114, prNo: null, prItem: 0, relSeq: 2, relCode: '11', approveDate: '2025-04-14' }),
    ]);

    expect(r.continuationCount).toBe(2);
    expect(r.orderViolations).toBe(0);
    expect(r.duplicateKeys).toBe(0);
    expect(r.l2BeforeL1).toBe(0);
    expect(r.unattached).toBe(0);

    expect(r.rows[1]!.prNo).toBe('1000008301');
    expect(r.rows[1]!.prItem).toBe(1);
    expect(r.rows[1]!.wasContinuation).toBe(true);
    expect(r.rows[3]!.prItem).toBe(2);
  });

  it('detects an out-of-order export (BLOCKER V-R04) instead of silently misattributing', () => {
    // This is the guard v1 lacked entirely: a re-sorted export would have
    // reattached every level-2 approval to the wrong PR, with no warning.
    const r = fillReleaseContinuations([
      row({ prNo: '1000008301', prItem: 1, relSeq: 1, approveDate: '2025-04-10' }),
      row({ prNo: null, prItem: 0, relSeq: 2, approveDate: '2025-04-14' }),
      row({ prNo: null, prItem: 0, relSeq: 2, approveDate: '2025-04-15' }), // follows a seq-2 row
    ]);
    expect(r.orderViolations).toBe(1);
  });

  it('detects level 2 approved before level 1 (WARNING V-R05)', () => {
    const r = fillReleaseContinuations([
      row({ prNo: 'PR1', prItem: 1, relSeq: 1, approveDate: '2025-04-20' }),
      row({ prNo: null, prItem: 0, relSeq: 2, approveDate: '2025-04-10' }),
    ]);
    expect(r.l2BeforeL1).toBe(1);
  });

  it('counts continuation rows that have no parent', () => {
    const r = fillReleaseContinuations([row({ prNo: null, prItem: 0, relSeq: 2 })]);
    expect(r.unattached).toBe(1);
    expect(r.rows).toHaveLength(0);
  });
});

describe('derivePrApproval', () => {
  const filled = (relSeq: number, approveDate: string | null, pic = 'PIC') => ({
    rowNumber: 0,
    prNo: 'PR1',
    prItem: 1,
    prCreatedDate: '2026-01-01',
    relSeq,
    relCode: '25',
    picRelease: pic,
    loginName: null,
    approveDate,
    approveTime: null,
    status: approveDate ? 'Release' : 'Outstanding',
    plant: 'EU71',
    purchOrg: 'PUR1',
    docType: 'EUNB',
    wasContinuation: relSeq >= 2,
  });

  it('uses the level-2 date as final when a level-2 row exists', () => {
    const a = derivePrApproval([filled(1, '2026-01-02'), filled(2, '2026-01-05')]);
    expect(a.l1Date).toBe('2026-01-02');
    expect(a.l2Date).toBe('2026-01-05');
    expect(a.finalDate).toBe('2026-01-05');
    expect(a.fullyReleased).toBe(true);
  });

  it('uses level 1 as final when there is no level-2 row (single-layer workflow)', () => {
    const a = derivePrApproval([filled(1, '2026-01-02')]);
    expect(a.finalDate).toBe('2026-01-02');
    expect(a.fullyReleased).toBe(true);
  });

  it('treats a level-2 row with no approve date as not yet fully released', () => {
    const a = derivePrApproval([filled(1, '2026-01-02'), filled(2, null, 'Head Unit')]);
    expect(a.finalDate).toBeNull();
    expect(a.fullyReleased).toBe(false);
    expect(a.nextApprover).toBe('Head Unit');
  });
});

describe('transfer leg signs are preserved, receipt signs are derived', () => {
  it('a balanced 641 pair nets to zero, not to a doubled positive', () => {
    // Reference data: 8,612 rows of 641, exactly 4,306 negative, summing to 0.
    // abs() x signFactor would fabricate transit stock that does not exist.
    const agg = aggregateGrLine([
      { movementType: '641', postingDate: '2026-01-01', qtyInUnitOfEntry: 8230400 },
      { movementType: '641', postingDate: '2026-01-01', qtyInUnitOfEntry: -8230400 },
    ]);
    expect(agg.transitQtyNet).toBe(0);
    expect(agg.receiptQtyNet).toBeNull();
  });

  it('a balanced 642 pair also nets to zero', () => {
    const agg = aggregateGrLine([
      { movementType: '642', postingDate: '2026-01-01', qtyInUnitOfEntry: 5000264 },
      { movementType: '642', postingDate: '2026-01-01', qtyInUnitOfEntry: -5000264 },
    ]);
    expect(agg.transitQtyNet).toBe(0);
  });

  it('postingQty derives for receipts and preserves for transfers', () => {
    expect(postingQty('101', 100)).toBe(100);
    expect(postingQty('102', 30)).toBe(-30);   // derived: 102 is always a reversal
    expect(postingQty('102', -30)).toBe(-30);  // derived: same answer either way
    expect(postingQty('641', -100)).toBe(-100); // preserved: this is an issue leg
    expect(postingQty('641', 100)).toBe(100);   // preserved: this is a receipt leg
    expect(postingQty('642', -50)).toBe(-50);
  });
});
