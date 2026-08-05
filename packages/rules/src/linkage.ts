/**
 * PR <-> PO linkage — PRD §12.2.
 *
 * The PO side is authoritative. Reference data: 11,710 PO lines carry a PR
 * reference, of which 291 (2.5%) are dangling; 645 PR items are split-sourced
 * with a maximum of 33 PO lines on one item; 9,094 lines (43.7%) are direct POs
 * with no requisition at all.
 */

export type LinkProvenance = 'po_side' | 'pr_side';
export type LinkStatus = 'resolved' | 'dangling';

export interface PoLinkRef {
  readonly poNo: string;
  readonly poItem: number;
  readonly prNo: string | null;
  readonly prItem: number | null;
  readonly documentDate: string | null;
}

export interface BridgeRow {
  readonly prNo: string;
  readonly prItem: number;
  readonly poNo: string;
  readonly poItem: number;
  readonly provenance: LinkProvenance;
  readonly splitSeq: number;
  readonly splitTotal: number;
}

export interface LinkageResult {
  readonly bridge: BridgeRow[];
  /** PO lines whose PR reference does not exist in the PR feed. */
  readonly dangling: PoLinkRef[];
  /** PO lines with no PR reference at all — direct POs. */
  readonly directPoCount: number;
  readonly splitSourcedPrItems: number;
  readonly maxPoLinesPerPrItem: number;
  readonly prItemsWithPo: number;
}

function prKey(prNo: string, prItem: number): string {
  return `${prNo}|${prItem}`;
}

/**
 * Build the bridge from PO-side references.
 *
 * `knownPrItems` is the set of PR keys present in the PR feed; a reference that
 * is not in it stays a dangling PO line rather than fabricating a PR row.
 */
export function buildLinkage(
  poLines: readonly PoLinkRef[],
  knownPrItems: ReadonlySet<string>,
): LinkageResult {
  const grouped = new Map<string, PoLinkRef[]>();
  const dangling: PoLinkRef[] = [];
  let directPoCount = 0;

  for (const line of poLines) {
    if (line.prNo === null || line.prItem === null) {
      directPoCount += 1;
      continue;
    }
    const k = prKey(line.prNo, line.prItem);
    if (!knownPrItems.has(k)) {
      dangling.push(line);
      continue;
    }
    const list = grouped.get(k);
    if (list) list.push(line);
    else grouped.set(k, [line]);
  }

  const bridge: BridgeRow[] = [];
  let splitSourced = 0;
  let maxLines = 0;

  for (const [k, lines] of grouped) {
    // Deterministic ordering so splitSeq is stable across runs: by document
    // date, then PO number, then item.
    lines.sort(
      (a, b) =>
        (a.documentDate ?? '').localeCompare(b.documentDate ?? '') ||
        a.poNo.localeCompare(b.poNo) ||
        a.poItem - b.poItem,
    );

    const total = lines.length;
    if (total > 1) splitSourced += 1;
    if (total > maxLines) maxLines = total;

    const sep = k.lastIndexOf('|');
    const prNo = k.slice(0, sep);
    const prItem = Number(k.slice(sep + 1));

    lines.forEach((line, i) => {
      bridge.push({
        prNo,
        prItem,
        poNo: line.poNo,
        poItem: line.poItem,
        provenance: 'po_side',
        splitSeq: i + 1,
        splitTotal: total,
      });
    });
  }

  return {
    bridge,
    dangling,
    directPoCount,
    splitSourcedPrItems: splitSourced,
    maxPoLinesPerPrItem: maxLines,
    prItemsWithPo: grouped.size,
  };
}

/**
 * PR Release continuation rows — Annex A §A.3.1.
 *
 * 48% of the release feed (13,338 rows) is release-sequence-2 rows whose
 * identifying columns are blank because SAP merges them with the parent row.
 * `PR Item` and `Qty` arrive as literal 0, which is a sentinel, not a value.
 *
 * v1 forward-filled correctly but with NO guards, and only handled PR Item = 0
 * because JavaScript treats Number('0') as falsy — accidental correctness. An
 * export re-sort would silently reattach every level-2 approval to the wrong PR.
 * The guards below are the requirement; the fill is just the mechanism.
 */
export interface ReleaseRowRaw {
  readonly rowNumber: number;
  readonly prNo: string | null;
  readonly prItem: number | null;
  readonly prCreatedDate: string | null;
  readonly relSeq: number | null;
  readonly relCode: string | null;
  readonly picRelease: string | null;
  readonly loginName: string | null;
  readonly approveDate: string | null;
  readonly approveTime: string | null;
  readonly status: string | null;
  readonly plant: string | null;
  readonly purchOrg: string | null;
  readonly docType: string | null;
  /** SAP-precomputed 'Approved Lead Time - PR Created' (008; v1 pr-alt card). */
  readonly apprLeadDays?: number | null;
  /** SAP-precomputed 'GAP Approval Lead Time' (008; v1 bottlenecks table). */
  readonly gapLeadDays?: number | null;
}

export interface ReleaseRowFilled extends ReleaseRowRaw {
  readonly wasContinuation: boolean;
}

export interface ReleaseFillResult {
  readonly rows: ReleaseRowFilled[];
  readonly continuationCount: number;
  /** BLOCKER V-R04: a continuation row not immediately preceded by a seq-1 row. */
  readonly orderViolations: number;
  /** BLOCKER V-R04: duplicate (prNo, prItem, relSeq) after filling. */
  readonly duplicateKeys: number;
  /** WARNING V-R05: level-2 approved before level 1. */
  readonly l2BeforeL1: number;
  /** Continuation rows that could not be attached to any parent. */
  readonly unattached: number;
}

export function isContinuationRow(r: ReleaseRowRaw): boolean {
  // Signature: blank PR No, and PR Item arriving as the 0 sentinel (or blank).
  return r.prNo === null && (r.prItem === null || r.prItem === 0);
}

export function fillReleaseContinuations(raw: readonly ReleaseRowRaw[]): ReleaseFillResult {
  const rows: ReleaseRowFilled[] = [];
  const seen = new Set<string>();

  let lastPrNo: string | null = null;
  let lastPrItem: number | null = null;
  let lastCreated: string | null = null;
  let lastPlant: string | null = null;
  let lastOrg: string | null = null;
  let lastDocType: string | null = null;
  let lastSeq1ApproveDate: string | null = null;
  let prevSeq: number | null = null;

  let continuationCount = 0;
  let orderViolations = 0;
  let duplicateKeys = 0;
  let l2BeforeL1 = 0;
  let unattached = 0;

  for (const r of raw) {
    const cont = isContinuationRow(r);

    if (cont) {
      continuationCount += 1;

      // GUARD V-R04: a continuation row must immediately follow a seq-1 row.
      if (prevSeq !== 1) orderViolations += 1;

      if (lastPrNo === null || lastPrItem === null) {
        unattached += 1;
        prevSeq = r.relSeq;
        continue;
      }

      // GUARD V-R05: level 2 must not be approved before level 1.
      if (r.approveDate !== null && lastSeq1ApproveDate !== null && r.approveDate < lastSeq1ApproveDate) {
        l2BeforeL1 += 1;
      }

      const filled: ReleaseRowFilled = {
        ...r,
        prNo: lastPrNo,
        prItem: lastPrItem,
        prCreatedDate: r.prCreatedDate ?? lastCreated,
        plant: r.plant ?? lastPlant,
        purchOrg: r.purchOrg ?? lastOrg,
        docType: r.docType ?? lastDocType,
        wasContinuation: true,
      };

      const k = `${filled.prNo}|${filled.prItem}|${filled.relSeq}`;
      if (seen.has(k)) duplicateKeys += 1;
      seen.add(k);
      rows.push(filled);
    } else {
      if (r.prNo !== null) {
        lastPrNo = r.prNo;
        lastPrItem = r.prItem;
        lastCreated = r.prCreatedDate;
        lastPlant = r.plant;
        lastOrg = r.purchOrg;
        lastDocType = r.docType;
      }
      if (r.relSeq === 1) lastSeq1ApproveDate = r.approveDate;

      const k = `${r.prNo}|${r.prItem}|${r.relSeq}`;
      if (seen.has(k)) duplicateKeys += 1;
      seen.add(k);
      rows.push({ ...r, wasContinuation: false });
    }
    prevSeq = r.relSeq;
  }

  return { rows, continuationCount, orderViolations, duplicateKeys, l2BeforeL1, unattached };
}

/**
 * Final approval date for a PR item: the level-2 date when a level-2 row exists,
 * otherwise the level-1 date. A level-2 row present with a blank approve date
 * means not yet approved at level 2 — a genuine pending state, distinct from
 * having no level 2 at all.
 */
export interface PrApproval {
  readonly l1Date: string | null;
  readonly l2Date: string | null;
  readonly finalDate: string | null;
  readonly fullyReleased: boolean;
  readonly nextApprover: string | null;
}

export function derivePrApproval(rowsForItem: readonly ReleaseRowFilled[]): PrApproval {
  const seq1 = rowsForItem.filter((r) => r.relSeq === 1);
  const seq2Plus = rowsForItem.filter((r) => (r.relSeq ?? 0) >= 2);

  const l1Date = seq1.map((r) => r.approveDate).filter((d): d is string => d !== null).sort().at(-1) ?? null;
  const l2Date = seq2Plus.map((r) => r.approveDate).filter((d): d is string => d !== null).sort().at(-1) ?? null;

  const hasL2Row = seq2Plus.length > 0;
  const finalDate = hasL2Row ? l2Date : l1Date;
  const fullyReleased = finalDate !== null;

  let nextApprover: string | null = null;
  if (!fullyReleased) {
    const pending = rowsForItem
      .filter((r) => r.approveDate === null)
      .sort((a, b) => (a.relSeq ?? 0) - (b.relSeq ?? 0));
    nextApprover = pending[0]?.picRelease ?? null;
  }

  return { l1Date, l2Date, finalDate, fullyReleased, nextApprover };
}
