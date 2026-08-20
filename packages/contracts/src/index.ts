/**
 * @pct/contracts — shared DTOs and Zod schemas.
 *
 * Single source of truth for every request and response shape. Types are
 * inferred from the schemas, never hand-written twice.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────── feeds & roles

/**
 * Every feed the ingest can recognise.
 *
 * The first six are TRANSACTIONAL and required: a dataset publishes with all of
 * them or not at all, so a figure can never be assembled from a partial bundle.
 * The last four are REFERENCE data — SAP master exports that describe what a
 * code means. They are optional by design (see REQUIRED_FEEDS in
 * Backend/src/modules/ingest/contracts.ts): they refresh on their own cadence,
 * and a missing one must not stop the daily PR/PO pickup.
 */
export const FEEDS = [
  'pr', 'prel', 'po', 'por', 'gr', 'fx',
  'pgrp', 'porg', 'matm', 'zuser',
] as const;
export type Feed = (typeof FEEDS)[number];

/** Feeds that carry reference/master data rather than transactions. */
export const REFERENCE_FEEDS = ['pgrp', 'porg', 'matm', 'zuser'] as const;
export type ReferenceFeed = (typeof REFERENCE_FEEDS)[number];

export const FEED_LABELS: Record<Feed, string> = {
  pr: 'PR Report',
  prel: 'PR Release',
  po: 'PO Report',
  por: 'PO Release',
  gr: 'GR List',
  fx: 'FX Rates',
  pgrp: 'Purchasing Groups',
  porg: 'Purchasing Orgs',
  matm: 'Material Master',
  zuser: 'SAP Users',
};

export const ROLES = ['viewer', 'analyst', 'manager', 'auditor', 'steward', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/**
 * User Access (011): organisational job roles, the per-page permission matrix,
 * and the page keys it is keyed by. The four-tier capability Role above is
 * unchanged — a job role maps onto it, the matrix layers page access on top.
 */
export const JOB_ROLES = [
  'staff', 'section_head', 'dept_head', 'division_head', 'management', 'admin',
] as const;
export type JobRole = (typeof JOB_ROLES)[number];

export const JOB_ROLE_LABELS: Record<JobRole, string> = {
  staff: 'Staff',
  section_head: 'Section Head',
  dept_head: 'Dept Head',
  division_head: 'Division Head',
  management: 'Management',
  admin: 'Admin',
};

export const PAGE_ACCESS = ['none', 'view', 'edit'] as const;
export type PageAccess = (typeof PAGE_ACCESS)[number];

/** Every page the matrix can grant, in menu order. */
export const PAGE_KEYS = [
  'execsummary',
  'executive', 'openitems', 'pr', 'coupa_src', 'po', 'delivery', 'coupa_inv',
  'approvals', 'materials', 'vendors', 'governance',
  'detail', 'custom', 'admin', 'datacheck',
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export const PAGE_LABELS: Record<PageKey, string> = {
  execsummary: 'Executive Summary',
  executive: 'Overview',
  openitems: 'Open Items',
  pr: 'PR Analysis',
  coupa_src: 'Sourcing',
  po: 'PO Analysis',
  delivery: 'Delivery',
  coupa_inv: 'Invoicing & Payment',
  approvals: 'Approvals',
  materials: 'Material Group',
  vendors: 'Vendor 360',
  governance: 'Governance',
  detail: 'Detail Table',
  custom: 'Custom',
  admin: 'Admin',
  datacheck: 'Data Quality',
};

export const ROLE_RANK: Record<Role, number> = {
  viewer: 10,
  analyst: 20,
  manager: 30,
  auditor: 40,
  steward: 50,
  admin: 90,
};

// ────────────────────────────────────────────────────────────────────── scope

export const ScopeEntrySchema = z.object({
  companyCode: z.string(),
  plant: z.string(),
  purchOrg: z.string(),
});
export type ScopeEntry = z.infer<typeof ScopeEntrySchema>;

export const MeSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  authMethod: z.enum(['sso', 'local']),
  roles: z.array(z.enum(ROLES)),
  scope: z.array(ScopeEntrySchema),
  capabilities: z.array(z.string()),
  department: z.string().nullable().optional(),
  jobRole: z.enum(JOB_ROLES).nullable().optional(),
  /** Effective per-page access; absent keys mean 'none'. */
  pages: z.record(z.enum(PAGE_ACCESS)).optional(),
  /** True until an admin-issued default password has been rotated. */
  mustChangePassword: z.boolean().optional(),
});
export type Me = z.infer<typeof MeSchema>;

// ──────────────────────────────────────────────────────────────── validation

export const SEVERITIES = ['BLOCKER', 'CAVEAT', 'WARNING', 'INFO'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FindingSchema = z.object({
  ruleId: z.string(),
  severity: z.enum(SEVERITIES),
  feed: z.enum(FEEDS).nullable(),
  message: z.string(),
  affectedRows: z.number().int().nullable(),
  measured: z.record(z.unknown()).nullable(),
  disablesKpis: z.array(z.string()),
  drillToken: z.string().nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

// ─────────────────────────────────────────────────────────────────── dataset

export const FRESHNESS_STATES = ['current', 'ageing', 'stale', 'caveats', 'loading'] as const;
export type FreshnessStateUi = (typeof FRESHNESS_STATES)[number];

export const FeedInfoSchema = z.object({
  feed: z.enum(FEEDS),
  filename: z.string(),
  rowCount: z.number().int(),
  rowDelta: z.number().int().nullable(),
  sha256Short: z.string(),
});

export const DatasetCurrentSchema = z.object({
  datasetVersionId: z.number().int(),
  asOfDate: z.string(),
  asOfSource: z.string(),
  publishedAt: z.string(),
  publishedBy: z.string().nullable(),
  sourceKind: z.enum(['synology', 'manual']),
  sourceLabel: z.string(),
  freshnessState: z.enum(FRESHNESS_STATES),
  fxPolicy: z.string(),
  feeds: z.array(FeedInfoSchema),
  validationSummary: z.object({
    blocker: z.number().int(),
    caveat: z.number().int(),
    warning: z.number().int(),
    info: z.number().int(),
  }),
  activeCaveats: z.array(
    z.object({
      ruleId: z.string(),
      message: z.string(),
      disablesKpis: z.array(z.string()),
    }),
  ),
  ruleSnapshot: z.record(z.unknown()),
});
export type DatasetCurrent = z.infer<typeof DatasetCurrentSchema>;

// ─────────────────────────────────────────────────────────────────────── KPI

export const KPI_IDS = [
  'demand_realism',
  'expedite_effectiveness',
  'grir_over_60d',
  'commitment_over_60d',
  'wbs_compliance',
  'cycle_pr_approval',
  'cycle_sourcing',
  'cycle_po_approval',
  'cycle_delivery',
  'cycle_e2e',
  'retro_po_rate',
  'split_sourcing',
  'reversal_rate',
  'sto_share',
  'direct_po_share',
  'open_items',
  'pending_pr_approvals',
  'pending_po_approvals',
  'open_po_commitment','grir_value','pr_pipeline_value','emergency_pct_value',
  'total_pr_items','delivered_gr','pr_not_approved','pr_no_po','po_hold',
  'po_not_delivered','emergency_open','urgent_open','avg_unreleased_age',
  'open_pr_no_wbs','max_pr_approval','unreleased_items','pr_to_po_conversion',
  'approved_within_3d','oldest_unreleased','emergency_urgent_share','at_risk_demand',
  'pr_cancellation_rate','pr_deleted','total_po_amount','total_po_count',
  'po_line_items','unique_suppliers','lines_pending_po_approval','hold_po_lines',
  'gr_coverage_pct','pr_po_price_variance','tail_spend_pct',
  'sole_source_materials','delivered_not_invoiced','po_irc','otd_vs_requested',
  // G6.3 — the v1-only registry KPIs, promoted
  'tail_spend_po_pct','valuation_coverage_pct','unique_requisitioners','avg_pr_line_value_idr',
  'avg_po_value_idr','avg_value_per_po_usd','foreign_ccy_po_share','single_source_spend_idr',
  'top_vendor_share_pct','top5_vendor_share_pct','avg_suppliers_per_material',
  'worst_approver_gap','auto_release_share_pct',
  'urgent_po_before_pr','open_pr_with_wbs','median_pr_approval','pr_approval_lead_time',
  // Executive Summary (020). Concentration and fragmentation, the two facts the
  // page is built to state.
  'active_purch_groups','desks_for_80pct_value','vendors_for_80pct_value',
  'top5_category_share_pct','lines_under_25jt_pct','value_under_25jt_pct',
] as const;
export type KpiId = (typeof KPI_IDS)[number];

export const KPI_TITLES: Record<KpiId, string> = {
  demand_realism: 'Demand Realism',
  expedite_effectiveness: 'Expedite Effectiveness',
  grir_over_60d: 'GR/IR > 60 days',
  commitment_over_60d: 'Open Commitment > 60 days',
  wbs_compliance: 'PR without WBS (AR required)',
  cycle_pr_approval: 'Avg PR Approval (days)',
  cycle_sourcing: 'Avg Sourcing LT (days)',
  cycle_po_approval: 'Avg PO Approval (days)',
  cycle_delivery: 'Avg Delivery LT (days)',
  cycle_e2e: 'End-to-end (median days)',
  retro_po_rate: 'Retro POs',
  split_sourcing: 'Split-sourced PR items',
  reversal_rate: 'GR reversal rate',
  sto_share: 'STO share of PO lines',
  direct_po_share: 'Direct POs (no PR)',
  open_items: 'Open items',
  pending_pr_approvals: 'PRs pending approval',
  pending_po_approvals: 'POs pending approval',
  open_po_commitment: 'Open PO Commitment',
  grir_value: 'Received, Not Invoiced (GR/IR)',
  pr_pipeline_value: 'PR Pipeline Value (no PO)',
  emergency_pct_value: 'Emergency Purchasing % (value)',
  total_pr_items: 'Total PR Items',
  delivered_gr: 'Delivered (GR)',
  pr_not_approved: 'PR Not Approved',
  pr_no_po: 'PR No PO',
  po_hold: 'PO Hold',
  po_not_delivered: 'PO Not Delivered',
  emergency_open: 'Emergency Open',
  urgent_open: 'Urgent Open',
  avg_unreleased_age: 'Avg Unreleased Age',
  open_pr_no_wbs: 'Open PR w/o WBS',
  max_pr_approval: 'Max PR Approval',
  unreleased_items: 'Unreleased Items',
  pr_to_po_conversion: 'PR to PO Conversion %',
  approved_within_3d: 'Approved within 3d %',
  oldest_unreleased: 'Oldest Unreleased (d)',
  emergency_urgent_share: 'Emergency + Urgent Share %',
  at_risk_demand: 'At-Risk Demand (no PO, past req. date)',
  pr_cancellation_rate: 'PR Cancellation Rate',
  pr_deleted: 'PR Deleted',
  total_po_amount: 'Total PO Amount',
  total_po_count: 'Total # of PO',
  po_line_items: 'PO Line Items',
  unique_suppliers: 'Unique Suppliers',
  lines_pending_po_approval: 'Lines Pending PO Approval',
  hold_po_lines: 'HOLD PO Lines',
  gr_coverage_pct: 'GR Coverage % (of approved)',
  pr_po_price_variance: 'PR to PO Price Variance',
  tail_spend_pct: 'Tail Spend %',
  sole_source_materials: 'Sole-Source Materials',
  delivered_not_invoiced: 'Delivered, Not Invoiced',
  po_irc: 'Info-Record Coverage %',
  otd_vs_requested: 'On-Time vs Requested %',
  tail_spend_po_pct: 'Tail Spend % (by PO)',
  valuation_coverage_pct: 'Valuation Coverage %',
  unique_requisitioners: 'Unique Requisitioners',
  avg_pr_line_value_idr: 'Avg PR Line Value (IDR)',
  avg_po_value_idr: 'Avg PO Value (IDR)',
  avg_value_per_po_usd: 'Avg Value / PO (USD)',
  foreign_ccy_po_share: 'Foreign-Currency PO Share',
  single_source_spend_idr: 'Single-Source Spend (IDR)',
  top_vendor_share_pct: 'Top Vendor Share %',
  top5_vendor_share_pct: 'Top 5 Vendor Share %',
  avg_suppliers_per_material: 'Avg Suppliers per Material',
  worst_approver_gap: 'Worst Approver Gap (median days)',
  auto_release_share_pct: 'Auto-Release Share %',
  urgent_po_before_pr: 'Urgent PO (PO before PR)',
  open_pr_with_wbs: 'Open PR with WBS',
  median_pr_approval: 'Median PR Approval',
  pr_approval_lead_time: 'PR Approval Lead Time (median)',
  active_purch_groups: 'Active purchasing desks',
  desks_for_80pct_value: 'Desks holding 80% of value',
  vendors_for_80pct_value: 'Vendors holding 80% of value',
  top5_category_share_pct: 'Top 5 categories (% of value)',
  lines_under_25jt_pct: 'PO lines under Rp 25 Jt',
  value_under_25jt_pct: 'Value on lines under Rp 25 Jt',
};

export const KpiValueSchema = z.object({
  kpiId: z.enum(KPI_IDS),
  status: z.enum(['ok', 'insufficient_sample', 'disabled', 'unavailable']),
  /** null unless status === 'ok'. The UI renders an em dash. */
  value: z.number().nullable(),
  numerator: z.number().nullable(),
  denominator: z.number().nullable(),
  sampleSize: z.number().int().nullable(),
  unit: z.enum(['ratio', 'percent', 'days', 'usd', 'idr', 'count']),
  currencyBasis: z.enum(['usd_strict', 'per_currency', 'idr_based']).nullable(),
  severity: z.enum(['good', 'neutral', 'warning', 'critical']).nullable(),
  statusReason: z.string().nullable(),
  detail: z.record(z.unknown()).nullable(),
  drillToken: z.string().nullable(),
});
export type KpiValue = z.infer<typeof KpiValueSchema>;

export const KpiResponseSchema = z.object({
  datasetVersionId: z.number().int(),
  asOfDate: z.string(),
  appliedFilters: z.record(z.unknown()),
  kpis: z.array(KpiValueSchema),
});
export type KpiResponse = z.infer<typeof KpiResponseSchema>;

// ───────────────────────────────────────────────────────────────────── charts

export const ChartPointSchema = z.object({
  bucketKey: z.string(),
  value: z.number().nullable(),
  rowCount: z.number().int(),
  drillToken: z.string().nullable(),
});

export const ChartResponseSchema = z.object({
  datasetVersionId: z.number().int(),
  asOfDate: z.string(),
  chartId: z.string(),
  title: z.string(),
  unit: z.string(),
  currencyBasis: z.string().nullable(),
  buckets: z.array(z.object({ key: z.string(), label: z.string(), ordinal: z.number().int() })),
  series: z.array(
    z.object({ key: z.string(), label: z.string(), points: z.array(ChartPointSchema) }),
  ),
  notes: z.array(z.string()),
});
export type ChartResponse = z.infer<typeof ChartResponseSchema>;

// ────────────────────────────────────────────────────────────────────── drill

export const ROW_FLAGS = [
  'sto',
  'tokenPrice',
  'releaseExempt',
  'danglingLink',
  'directPo',
  'fxFallback',
  'zeroValuation',
  'indeterminateWbs',
] as const;
export type RowFlag = (typeof ROW_FLAGS)[number];

export const DrillColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['string', 'int', 'number', 'money', 'date', 'enum', 'pct']),
  currency: z.string().optional(),
});

export const DrillResponseSchema = z.object({
  datasetVersionId: z.number().int(),
  asOfDate: z.string(),
  label: z.string(),
  grain: z.string(),
  totalCount: z.number().int(),
  note: z.string().nullable(),
  columns: z.array(DrillColumnSchema),
  rows: z.array(z.record(z.unknown())),
  nextCursor: z.string().nullable(),
});
export type DrillResponse = z.infer<typeof DrillResponseSchema>;

// ─────────────────────────────────────────────────────────────────── ingestion

export const BATCH_STATES = [
  'DISCOVERED',
  'SCANNING',
  'PARSING',
  'VALIDATING',
  'TRANSFORMING',
  'READY',
  'PUBLISHED',
  'FAILED',
  'SUPERSEDED',
  'CANCELLED',
] as const;
export type BatchState = (typeof BATCH_STATES)[number];

export const BatchSummarySchema = z.object({
  id: z.number().int(),
  sourceKind: z.enum(['synology', 'manual']),
  state: z.enum(BATCH_STATES),
  submittedBy: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  datasetVersionId: z.number().int().nullable(),
  fileCount: z.number().int(),
  findingCounts: z.object({
    blocker: z.number().int(),
    caveat: z.number().int(),
    warning: z.number().int(),
    info: z.number().int(),
  }),
});
export type BatchSummary = z.infer<typeof BatchSummarySchema>;

// ─────────────────────────────────────────────────────────────────── problems

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  requestId: z.string().optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

export const PROBLEM_TYPES = {
  invalidParameter: 'invalid-parameter',
  invalidBody: 'invalid-body',
  notAuthenticated: 'not-authenticated',
  sessionExpired: 'session-expired',
  invalidCredentials: 'invalid-credentials',
  insufficientRole: 'insufficient-role',
  scopeEmpty: 'scope-empty',
  notFound: 'not-found',
  drillTokenExpired: 'drill-token-expired',
  drillTokenInvalid: 'drill-token-invalid',
  drillTokenForeign: 'drill-token-foreign',
  versionNotReady: 'version-not-ready',
  batchNotConfirmable: 'batch-not-confirmable',
  batchQueueBusy: 'batch-queue-busy',
  uploadTooLarge: 'upload-too-large',
  uploadNotXlsx: 'upload-not-xlsx',
  rateLimited: 'rate-limited',
  sourceUnavailable: 'source-unavailable',
  internal: 'internal-error',
} as const;
