/**
 * Release state and row status derivation — PRD §12.4, Annex A §A.4.1.
 *
 * Two corrections from v1 live here:
 *
 *  1. Deletion comes from `Deletion indicator`, NOT from a blank release
 *     indicator. v1 mapped blank -> 'PO-Deleted', which hid 241 live lines
 *     across 89 POs worth IDR 1,506,586,519.
 *
 *  2. Release-strategy exemption is its own state (decision D2 = flag_only):
 *     never folded into approved or pending, marked with a flag, status driven
 *     by the physical receipt state, excluded from the pending-approval queue.
 */

export type PoReleaseState = 'approved' | 'pending' | 'not_subject_to_release' | 'deleted';

export type NoReleaseStrategyPolicy =
  | 'flag_only'
  | 'treat_as_approved'
  | 'treat_as_pending'
  | 'exclude_flagged';

export const DEFAULT_NO_RELEASE_STRATEGY_POLICY: NoReleaseStrategyPolicy = 'flag_only';

export interface PoReleaseInput {
  readonly deletionIndicator: string | null;
  readonly releaseIndicator: string | null;
  readonly releaseGroup: string | null;
}

/**
 * Reference distribution: releaseIndicator '2' 19,722 / blank 964 / 'X' 106 /
 * '1' 12. Of the 964 blanks, 723 are also deletionIndicator='L' (genuinely
 * deleted) and 241 are live orders with no release strategy at all.
 */
export function poReleaseState(po: PoReleaseInput): PoReleaseState {
  // Deletion is evaluated first and wins.
  if ((po.deletionIndicator ?? '').trim().toUpperCase() === 'L') return 'deleted';

  const ri = (po.releaseIndicator ?? '').trim().toUpperCase();
  const rg = (po.releaseGroup ?? '').trim();

  if (ri === '1' || ri === '2' || ri === 'C') return 'approved';
  if (ri === 'X') return 'pending';

  // Blank indicator AND blank group => no release strategy applies to this line.
  if (ri === '' && rg === '') return 'not_subject_to_release';

  // Blank indicator but a group exists => subject to a strategy, not yet released.
  return 'pending';
}

export function isReleaseExempt(state: PoReleaseState): boolean {
  return state === 'not_subject_to_release';
}

export type RowStatus =
  | 'PR-Deleted'
  | 'Unapproved PR'
  | 'PR Approved-No PO'
  | 'PO-Deleted'
  | 'HOLD PO'
  | 'PO-Not Approved'
  | 'PO-No GR'
  | 'Partially Delivered'
  | 'Delivered'
  | 'Fully Reversed';

export const OPEN_STATUSES: readonly RowStatus[] = [
  'Unapproved PR',
  'PR Approved-No PO',
  'PO-Not Approved',
  'HOLD PO',
  'PO-No GR',
  'Partially Delivered',
];

export interface RowStatusInput {
  readonly prDeleted: boolean;
  readonly hasPo: boolean;
  readonly prFullyReleased: boolean;
  readonly poReleaseState: PoReleaseState | null;
  readonly poIncomplete: boolean;
  readonly orderedQty: number | null;
  readonly netReceiptQty: number | null;
  readonly receiptPostings: number;
}

export interface RowStatusResult {
  readonly status: RowStatus;
  readonly releaseExempt: boolean;
}

/**
 * Evaluated in a fixed order: deletion -> hold -> release state -> receipt state.
 *
 * Release-exempt lines skip the 'PO-Not Approved' test and fall through to their
 * receipt-driven status, carrying releaseExempt=true so the UI can render the
 * flag marker. Under flag_only this means they flow like approved POs for
 * pipeline purposes — the marker is what keeps that assumption visible.
 */
export function rowStatus(
  r: RowStatusInput,
  policy: NoReleaseStrategyPolicy = DEFAULT_NO_RELEASE_STRATEGY_POLICY,
): RowStatusResult {
  const exempt = r.poReleaseState === 'not_subject_to_release';

  if (r.prDeleted) return { status: 'PR-Deleted', releaseExempt: false };

  if (!r.hasPo) {
    return {
      status: r.prFullyReleased ? 'PR Approved-No PO' : 'Unapproved PR',
      releaseExempt: false,
    };
  }

  if (r.poReleaseState === 'deleted') return { status: 'PO-Deleted', releaseExempt: false };
  if (r.poIncomplete) return { status: 'HOLD PO', releaseExempt: exempt };

  if (r.poReleaseState === 'pending') return { status: 'PO-Not Approved', releaseExempt: false };

  if (exempt && policy === 'treat_as_pending') {
    return { status: 'PO-Not Approved', releaseExempt: true };
  }

  const net = r.netReceiptQty ?? 0;

  if (r.receiptPostings > 0 && net <= 0) return { status: 'Fully Reversed', releaseExempt: exempt };
  if (net <= 0) return { status: 'PO-No GR', releaseExempt: exempt };
  if (r.orderedQty !== null && r.orderedQty > 0 && net < r.orderedQty) {
    return { status: 'Partially Delivered', releaseExempt: exempt };
  }
  return { status: 'Delivered', releaseExempt: exempt };
}

export function isOpenStatus(s: RowStatus): boolean {
  return OPEN_STATUSES.includes(s);
}

/**
 * A release-exempt PO can never be approved — it has no release record at all.
 * Under flag_only it is therefore excluded from the pending-approval queue,
 * because leaving it there would strand it permanently.
 */
export function countsInPendingApprovalQueue(
  state: PoReleaseState,
  policy: NoReleaseStrategyPolicy = DEFAULT_NO_RELEASE_STRATEGY_POLICY,
): boolean {
  if (state === 'pending') return true;
  if (state === 'not_subject_to_release') return policy === 'treat_as_pending';
  return false;
}
