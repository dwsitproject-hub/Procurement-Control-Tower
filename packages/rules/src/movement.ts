/**
 * GR movement-type register — Annex A §A.6.1.
 *
 * The reference export contains 101 (19,200), 641 (8,612), 102 (741) and
 * 642 (344). Movement type 122 never occurs but is registered because it is a
 * documented reversal type. 641/642 are 31.0% of the feed and were entirely
 * undocumented in v1.
 */

export type PostingClass = 'receipt' | 'reversal' | 'transfer' | 'transfer_reversal';

export interface MovementRule {
  readonly cls: PostingClass;
  readonly signFactor: 1 | -1;
  readonly countsAsReceipt: boolean;
  readonly description: string;
}

export const MOVEMENT_REGISTER: Readonly<Record<string, MovementRule>> = Object.freeze({
  '101': {
    cls: 'receipt',
    signFactor: 1,
    countsAsReceipt: true,
    description: 'Goods receipt against purchase order',
  },
  '102': {
    cls: 'reversal',
    signFactor: -1,
    countsAsReceipt: true,
    description: 'Reversal of goods receipt',
  },
  '122': {
    cls: 'reversal',
    signFactor: -1,
    countsAsReceipt: true,
    description: 'Return delivery (registered; absent from reference data)',
  },
  '641': {
    cls: 'transfer',
    signFactor: 1,
    countsAsReceipt: false,
    description: 'Transfer posting to stock in transit (STO)',
  },
  '642': {
    cls: 'transfer_reversal',
    signFactor: -1,
    countsAsReceipt: false,
    description: 'Reversal of transfer to stock in transit',
  },
});

/**
 * Unregistered movement types are a BLOCKER (validation rule V-R07).
 * Returning null is how the caller detects that — never guess a sign.
 */
export function lookupMovement(mvt: string | null): MovementRule | null {
  if (mvt === null) return null;
  return MOVEMENT_REGISTER[mvt.trim()] ?? null;
}

/**
 * Sign derivation for RECEIPT-CLASS postings (101 / 102 / 122).
 *
 * For these the movement type unambiguously determines direction, so the sign is
 * derived and the source sign ignored. The reference export happens to send all
 * 741 rows of movement type 102 already negative, so v1's naive `qty += qty`
 * netted correctly — by luck, not design. Deriving makes it correct either way.
 */
export function signedQty(mvt: string, qtyInUnitOfEntry: number): number {
  const rule = lookupMovement(mvt);
  if (rule === null) throw new Error(`Unregistered movement type: ${mvt}`);
  return Math.abs(qtyInUnitOfEntry) * rule.signFactor;
}

/**
 * Quantity for any posting, respecting the different meaning of sign per class.
 *
 * This distinction is easy to get wrong and matters:
 *
 *   Receipt class (101/102/122) — the movement type IS the direction. A 102 is a
 *     reversal whatever sign the export sends, so we derive.
 *
 *   Transfer class (641/642) — the source sign is a debit/credit LEG, not a
 *     reversal. A stock-transfer posting emits an issue leg and a receipt leg
 *     under the SAME movement type: the reference export has 8,612 rows of 641
 *     of which exactly 4,306 are negative, and 344 rows of 642 of which exactly
 *     172 are negative. Each type sums to precisely zero. Applying
 *     abs() x signFactor here would turn a balanced pair into a doubled positive
 *     and fabricate transit stock that does not exist.
 *
 * So transfers preserve the source sign, and only receipts derive it.
 */
export function postingQty(mvt: string, qtyInUnitOfEntry: number): number {
  const rule = lookupMovement(mvt);
  if (rule === null) throw new Error(`Unregistered movement type: ${mvt}`);
  return rule.countsAsReceipt
    ? Math.abs(qtyInUnitOfEntry) * rule.signFactor
    : qtyInUnitOfEntry;
}

export function isReceiptPosting(mvt: string | null): boolean {
  return lookupMovement(mvt)?.countsAsReceipt ?? false;
}

/** Only movement type 101 establishes the receipt DATE. See gr.ts. */
export function establishesReceiptDate(mvt: string | null): boolean {
  return (mvt?.trim() ?? '') === '101';
}
