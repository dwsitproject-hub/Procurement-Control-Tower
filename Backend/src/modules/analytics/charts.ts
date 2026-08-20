/**
 * Chart catalogue. Each entry declares its grain and unit so the frontend can
 * enumerate rather than hard-code, and so the drill predicate is built from the
 * same definition that produced the aggregate.
 */

export interface ChartMeta {
  chartId: string;
  title: string;
  tab: string;
  grain: 'pr_item' | 'po_line' | 'gr_posting' | 'pr_release' | 'po_release';
  unit: 'count' | 'usd' | 'idr' | 'days' | 'percent';
  notes?: string[];
}

export const CHART_META: ChartMeta[] = [
  // ── Executive Summary (020) ──
  // Committed value, NOT "spend". net_order_value_idr is what was ORDERED; the
  // reference design headed this figure "spend", which would disagree with
  // finance. Naming it plainly here is the cheapest way to stop that argument.
  {
    chartId: 'exec_value_by_category',
    title: 'Committed value by spend category',
    tab: 'execsummary',
    grain: 'po_line',
    // Base unit is USD with an *_idr twin, so the header's currency toggle
    // switches the panel instead of it always reading rupiah.
    unit: 'usd',
    notes: [
      'STO and deleted lines excluded',
      'Category resolves: mapping file, then SAP material master, then unmapped',
      '"(no material code)" is shown rather than folded into a category',
    ],
  },
  {
    chartId: 'exec_txn_size',
    title: 'Transaction size: value against volume',
    tab: 'execsummary',
    grain: 'po_line',
    unit: 'percent',
    notes: [
      'Two series on one band axis: share of committed value, share of PO lines',
      'Bands ordered by size, never by measure',
    ],
  },
  {
    chartId: 'status_mix',
    title: 'Documents by status',
    tab: 'executive',
    grain: 'pr_item',
    unit: 'count',
  },
  {
    chartId: 'pr_by_month',
    title: 'Requisitions raised by month',
    tab: 'pr',
    grain: 'pr_item',
    unit: 'count',
  },
  {
    chartId: 'po_value_by_month',
    title: 'PO net order value by month',
    tab: 'po',
    grain: 'po_line',
    unit: 'usd',
    notes: ['STO lines excluded from spend analytics'],
  },
  {
    chartId: 'delivery_ordered_vs_received',
    title: 'Ordered vs received by PO month',
    tab: 'delivery',
    grain: 'po_line',
    unit: 'count',
    notes: ['STO lines included in delivery analytics'],
  },
  {
    chartId: 'aging_bands',
    title: 'Open items by aging band',
    tab: 'openitems',
    grain: 'po_line',
    unit: 'count',
    notes: ['Aging measured from the dataset as-of date, not today'],
  },
  {
    chartId: 'top_vendors_spend',
    title: 'Top vendors by spend',
    tab: 'po',
    grain: 'po_line',
    unit: 'usd',
    notes: ['STO lines excluded'],
  },
  {
    chartId: 'purch_group_workload',
    title: 'PO lines by purchasing group',
    tab: 'po',
    grain: 'po_line',
    unit: 'count',
  },
  {
    chartId: 'pending_pr_by_pic',
    title: 'PRs pending approval by approver',
    tab: 'approvals',
    grain: 'pr_release',
    unit: 'count',
  },
  {
    chartId: 'wbs_by_plant',
    title: 'WBS violations by plant',
    tab: 'governance',
    grain: 'pr_item',
    unit: 'count',
  },
  {
    chartId: 'movement_mix',
    title: 'GR postings by movement type',
    tab: 'delivery',
    grain: 'gr_posting',
    unit: 'count',
    notes: ['641/642 are stock-transfer postings, not receipts'],
  },
  // v1 parity charts — Docs/V1_V2_Parity_Matrix.md section 3
  { chartId: 'items_by_priority',        title: 'Items by priority category',       tab: 'executive', grain: 'pr_item', unit: 'count' },
  { chartId: 'aging_by_priority',        title: 'Avg aging by priority (days)',     tab: 'executive', grain: 'pr_item', unit: 'days' },
  { chartId: 'open_by_priority',         title: 'Open items by priority',           tab: 'openitems', grain: 'pr_item', unit: 'count' },
  { chartId: 'unapproved_by_category',   title: 'Unapproved by material category',  tab: 'openitems', grain: 'pr_item', unit: 'count' },
  { chartId: 'unreleased_aging_buckets', title: 'Unreleased PR aging buckets',      tab: 'openitems', grain: 'pr_item', unit: 'count' },
  { chartId: 'aging_severity_by_stage',   title: 'Aging severity by open stage — item count in age bands', tab: 'openitems', grain: 'pr_item', unit: 'count' },
  { chartId: 'pr_approval_by_priority',  title: 'PR approval by priority',          tab: 'pr',        grain: 'pr_item', unit: 'days' },
  { chartId: 'pr_by_plant',              title: 'PR items by plant',                tab: 'pr',        grain: 'pr_item', unit: 'count' },
  { chartId: 'pr_approval_distribution', title: 'PR approval distribution',         tab: 'pr',        grain: 'pr_item', unit: 'count' },
  { chartId: 'monthly_pr_no_po',         title: 'Monthly PR with no PO',            tab: 'pr',        grain: 'pr_item', unit: 'count' },
  { chartId: 'items_by_category',        title: 'Items by Material Category',       tab: 'pr',        grain: 'pr_item', unit: 'count' },
  { chartId: 'sourcing_by_priority',     title: 'Sourcing lead time by priority',   tab: 'po',        grain: 'po_line', unit: 'days', notes: ['STO lines excluded'] },
  { chartId: 'po_approval_by_priority',  title: 'PO approval by priority',          tab: 'po',        grain: 'po_line', unit: 'days', notes: ['STO lines excluded'] },
  { chartId: 'po_approval_distribution', title: 'PO approval distribution',         tab: 'po',        grain: 'po_line', unit: 'count' },
  { chartId: 'sourcing_by_category',     title: 'Sourcing LT by material category', tab: 'po',        grain: 'po_line', unit: 'days' },
  { chartId: 'po_by_plant',              title: 'PO value by plant',                tab: 'po',        grain: 'po_line', unit: 'usd', notes: ['STO lines excluded'] },
  { chartId: 'po_value_by_category',     title: 'PO value by material category',    tab: 'po',        grain: 'po_line', unit: 'usd', notes: ['STO lines excluded'] },
  { chartId: 'po_value_by_purch_org',    title: 'PO value by purchasing org',       tab: 'po',        grain: 'po_line', unit: 'usd', notes: ['STO lines excluded'] },
  { chartId: 'commitment_aging',         title: 'Open commitment aging',            tab: 'po',        grain: 'po_line', unit: 'usd', notes: ['Aging from the dataset as-of date'] },
  { chartId: 'top_materials_spend',      title: 'Top materials by spend',           tab: 'po',        grain: 'po_line', unit: 'usd', notes: ['STO lines excluded'] },
  { chartId: 'po_amount_by_area',        title: 'PO Amount by Area',                tab: 'po',        grain: 'po_line', unit: 'usd', notes: ['STO lines excluded', 'Plants rolled up to areas'] },
  { chartId: 'po_amount_by_matcat',      title: 'PO Amount by Material Category',   tab: 'po',        grain: 'po_line', unit: 'usd', notes: ['STO lines excluded'] },
  { chartId: 'pr_status_by_pgrp',        title: "PR Status by Purchasing Group — Outstanding (PR's group) vs Converted (processed by, per PO List)", tab: 'po', grain: 'po_line', unit: 'count' },
  { chartId: 'po_value_by_pgrp',         title: 'PO Value by Purchasing Group — share of IDR spend', tab: 'po', grain: 'po_line', unit: 'idr', notes: ['IDR document-currency lines only'] },
  { chartId: 'delivery_by_category',     title: 'Delivery LT by material category', tab: 'delivery',  grain: 'po_line', unit: 'days' },
  { chartId: 'delivery_by_priority',     title: 'Delivery LT by priority',          tab: 'delivery',  grain: 'po_line', unit: 'days' },
  { chartId: 'delivery_distribution',    title: 'Delivery LT distribution',         tab: 'delivery',  grain: 'po_line', unit: 'count' },
  { chartId: 'e2e_by_month',             title: 'End-to-end by month',              tab: 'delivery',  grain: 'po_line', unit: 'days' },
  { chartId: 'e2e_by_category',          title: 'Avg E2E by Material Category (days)',  tab: 'delivery',  grain: 'pr_item', unit: 'days' },

  // ── v1's Outstanding-PR family (7 Aug 2026) ──
  // "Outstanding" is v1's word for an active requisition that has not yet
  // produced a PO, so these three describe the backlog that procurement still
  // owes an order for.
  { chartId: 'pr_outstanding_by_company', title: 'Outstanding PR Per Company',  tab: 'pr', grain: 'pr_item', unit: 'count', notes: ['PR items with no PO · deleted excluded'] },
  { chartId: 'pr_outstanding_by_porg',    title: 'Outstanding PR Per P. Org',   tab: 'pr', grain: 'pr_item', unit: 'count', notes: ['PR items with no PO · deleted excluded'] },
  { chartId: 'pr_outstanding_by_pgrp',    title: 'Outstanding PR By PIC',       tab: 'pr', grain: 'pr_item', unit: 'count', notes: ['PR items with no PO · deleted excluded', 'PIC = the buyer desk (SAP purchasing group)', 'Stacked by age since the requisition date'] },
  { chartId: 'pr_items_by_area',          title: 'PR Items by Area — share of demand', tab: 'pr', grain: 'pr_item', unit: 'count', notes: ['Every PR item', 'Plants rolled up to areas'] },
  { chartId: 'pr_layer1_aging_by_priority', title: 'Avg Layer-1 Aging by Priority (days)', tab: 'pr', grain: 'pr_item', unit: 'days', notes: ['Requisition date to the FIRST release level'] },

  // ── v1's PO value-bracket and buyer-desk family (7 Aug 2026) ──
  { chartId: 'po_bracket_value',      title: 'Bracket PO — Value of PO',   tab: 'po', grain: 'po_line', unit: 'idr', notes: ['Bracketed on the PO DOCUMENT total', 'IDR document-currency lines only', 'JT = juta / million IDR', 'Bars are billions of IDR; the drill opens the lines'] },
  { chartId: 'po_bracket_count',      title: 'Bracket PO — # of PO',       tab: 'po', grain: 'po_line', unit: 'count', notes: ['Bracketed on the PO DOCUMENT total', 'IDR document-currency lines only', 'Counts documents — the drill opens their lines'] },
  { chartId: 'po_issued_by',          title: 'PO Issued By',               tab: 'po', grain: 'po_line', unit: 'count', notes: ['HO vs site UNIT, from the purchasing-group master', 'Counts documents — the drill opens their lines'] },
  { chartId: 'po_items_by_pgrp',      title: '# of PO Item Per PIC',       tab: 'po', grain: 'po_line', unit: 'count', notes: ['PIC = the buyer desk (SAP purchasing group)', 'STO and deleted lines excluded'] },
  { chartId: 'po_count_by_category',  title: '# of PO Per Category',       tab: 'po', grain: 'po_line', unit: 'count', notes: ['Line items and distinct documents side by side', 'STO and deleted lines excluded'] },
];

export const CHART_BY_ID = new Map(CHART_META.map((c) => [c.chartId, c]));
