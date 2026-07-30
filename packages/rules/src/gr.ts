/**
 * Goods-receipt derivation — PRD §12.3.
 *
 * Three corrections from v1, each fixing a defect measured on the reference data:
 *
 *  (a) The receipt DATE comes from movement type 101 only. v1 took the earliest
 *      posting date across ALL movement types; because 641 stock-transfer
 *      postings are in the same feed, 1,695 of 15,134 PO-line keys (11.2%)
 *      received a receipt date a median 7 days too early.
 *
 *  (b) Quantity comes from `Qty in unit of entry` and the sign is DERIVED from
 *      the movement type. The column named `Quantity` is zero on 22.4% of rows.
 *
 *  (c) Transfer postings (641/642) are segregated, not summed into receipts.
 *      47 line keys carry transfers with no 101 at all and must not present as
 *      received.
 */

import { lookupMovement, postingQty } from './movement.js';

export interface GrPostingInput {
  readonly movementType: string;
  readonly postingDate: string | null;
  /** Raw `Qty in unit of entry` — may already be signed in the source. */
  readonly qtyInUnitOfEntry: number | null;
}

export interface GrLineAggregate {
  /** MIN(posting_date) WHERE movement_type = '101'. Null if never received. */
  readonly receiptDate: string | null;
  /** Net of receipt-class postings only (101 + 102/122 reversals). */
  readonly receiptQtyNet: number | null;
  /** Net of transfer-class postings only (641/642). Kept separate. */
  readonly transitQtyNet: number | null;
  readonly receiptCount: number;
  readonly reversalCount: number;
  readonly transferCount: number;
  /** True when postings exist but net to <= 0 — the 'Fully Reversed' state. */
  readonly fullyReversed: boolean;
  /**
   * Diagnostic for validation rule V-B08: the earliest posting of ANY movement
   * type, so the pipeline can assert it never precedes receiptDate.
   */
  readonly earliestAnyPostingDate: string | null;
}

/**
 * Aggregate all postings for one PO line.
 * Throws on an unregistered movement type — that is BLOCKER V-R07, never a guess.
 */
export function aggregateGrLine(postings: readonly GrPostingInput[]): GrLineAggregate {
  let receiptDate: string | null = null;
  let earliestAny: string | null = null;
  let receiptNet = 0;
  let transitNet = 0;
  let receiptCount = 0;
  let reversalCount = 0;
  let transferCount = 0;
  let hasReceiptClassPosting = false;

  for (const p of postings) {
    const rule = lookupMovement(p.movementType);
    if (rule === null) throw new Error(`Unregistered movement type: ${p.movementType}`);

    if (p.postingDate !== null) {
      if (earliestAny === null || p.postingDate < earliestAny) earliestAny = p.postingDate;
    }

    // (a) Only 101 establishes the receipt date.
    if (p.movementType.trim() === '101' && p.postingDate !== null) {
      if (receiptDate === null || p.postingDate < receiptDate) receiptDate = p.postingDate;
      receiptCount += 1;
    }

    if (rule.cls === 'reversal') reversalCount += 1;
    if (rule.cls === 'transfer' || rule.cls === 'transfer_reversal') transferCount += 1;

    if (p.qtyInUnitOfEntry === null) continue;

    // (b) Sign handling differs by class — see postingQty. Receipts derive the
    // sign from the movement type; transfers preserve the source leg sign,
    // because a 641 pair is an issue leg and a receipt leg, not a reversal.
    const q = postingQty(p.movementType, p.qtyInUnitOfEntry);

    // (c) Receipt and transit quantities never mix.
    if (rule.countsAsReceipt) {
      receiptNet += q;
      hasReceiptClassPosting = true;
    } else {
      transitNet += q;
    }
  }

  const anyPosting = postings.length > 0;

  return {
    receiptDate,
    receiptQtyNet: hasReceiptClassPosting ? round3(receiptNet) : null,
    transitQtyNet: transferCount > 0 ? round3(transitNet) : null,
    receiptCount,
    reversalCount,
    transferCount,
    fullyReversed: hasReceiptClassPosting && receiptCount > 0 && round3(receiptNet) <= 0,
    earliestAnyPostingDate: anyPosting ? earliestAny : null,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * GR completion percentage.
 *
 * Services are capped at 100%: a service PR quantity of 1 against a receipt
 * expressed in a price unit can otherwise exceed 100% spuriously.
 */
export function grCompletionPct(
  receiptQtyNet: number | null,
  orderedQty: number | null,
  priceUnit: number | null,
  isService: boolean,
): number | null {
  if (receiptQtyNet === null || orderedQty === null || orderedQty <= 0) return null;
  const pu = priceUnit === null || priceUnit <= 0 ? 1 : priceUnit;
  const pct = (receiptQtyNet / pu / orderedQty) * 100;
  if (!Number.isFinite(pct)) return null;
  const bounded = isService ? Math.min(pct, 100) : pct;
  return Math.round(bounded * 100) / 100;
}

/**
 * Validation diagnostic for V-B08.
 *
 * Returns true when the earliest posting of any movement type precedes the first
 * 101 — meaning a naive "earliest posting" implementation would have produced a
 * contaminated receipt date. On the reference data this was true for 1,695 line
 * keys; after the fix the pipeline asserts a count of 0.
 */
export function wouldHaveContaminatedDate(agg: GrLineAggregate): boolean {
  if (agg.receiptDate === null || agg.earliestAnyPostingDate === null) return false;
  return agg.earliestAnyPostingDate < agg.receiptDate;
}
