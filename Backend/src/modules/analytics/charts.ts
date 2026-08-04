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
  { chartId: 'items_by_category',        title: 'Items by material category',       tab: 'pr',        grain: 'pr_item', unit: 'count' },
  { chartId: 'sourcing_by_priority',     title: 'Sourcing lead time by priority',   tab: 'po',        grain: 'po_line', unit: 'days', notes: ['STO lines excluded'] },
  { chartId: 'po_approval_by_priority',  title: 'PO approval by priority',          tab: 'po',        grain: 'po_line', unit: 'days', notes: ['STO lines excluded'] },
  { chartId: 'po_approval_distribution', title: 'PO approval distribution',         tab: 'po',        grain: 'po_line', unit: 'count' },
  { chartId: 'sourcing_by_category',     title: 'Sourcing LT by material category', tab: 'po',        grain: 'po_line', unit: 'days' },
  { chartId: 'po_by_plant',              title: 'PO value by plant',                tab: 'po',        grain: 'po_line', unit: 'usd', notes: ['STO lines excluded'] },
  { chartId: 'po_value_by_category',     title: 'PO value by material category',    tab: 'po',        grain: 'po_line', unit: 'usd', notes: ['STO lines excluded'] },
  { chartId: 'po_value_by_purch_org',    title: 'PO value by purchasing org',       tab: 'po',        grain: 'po_line', unit: 'usd', notes: ['STO lines excluded'] },
  { chartId: 'commitment_aging',         title: 'Open commitment aging',            tab: 'po',        grain: 'po_line', unit: 'usd', notes: ['Aging from the dataset as-of date'] },
  { chartId: 'top_materials_spend',      title: 'Top materials by spend',           tab: 'po',        grain: 'po_line', unit: 'usd', notes: ['STO lines excluded'] },
  { chartId: 'delivery_by_category',     title: 'Delivery LT by material category', tab: 'delivery',  grain: 'po_line', unit: 'days' },
  { chartId: 'delivery_by_priority',     title: 'Delivery LT by priority',          tab: 'delivery',  grain: 'po_line', unit: 'days' },
  { chartId: 'delivery_distribution',    title: 'Delivery LT distribution',         tab: 'delivery',  grain: 'po_line', unit: 'count' },
  { chartId: 'e2e_by_month',             title: 'End-to-end by month',              tab: 'delivery',  grain: 'po_line', unit: 'days' },
  { chartId: 'e2e_by_category',          title: 'End-to-end by material category',  tab: 'delivery',  grain: 'pr_item', unit: 'days' },
];

export const CHART_BY_ID = new Map(CHART_META.map((c) => [c.chartId, c]));
