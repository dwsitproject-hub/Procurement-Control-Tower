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
];

export const CHART_BY_ID = new Map(CHART_META.map((c) => [c.chartId, c]));
