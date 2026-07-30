/**
 * @pct/contracts — shared DTOs and Zod schemas.
 *
 * Single source of truth for every request and response shape. Types are
 * inferred from the schemas, never hand-written twice.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────── feeds & roles

export const FEEDS = ['pr', 'prel', 'po', 'por', 'gr', 'fx'] as const;
export type Feed = (typeof FEEDS)[number];

export const FEED_LABELS: Record<Feed, string> = {
  pr: 'PR Report',
  prel: 'PR Release',
  po: 'PO Report',
  por: 'PO Release',
  gr: 'GR List',
  fx: 'FX Rates',
};

export const ROLES = ['viewer', 'analyst', 'manager', 'auditor', 'steward', 'admin'] as const;
export type Role = (typeof ROLES)[number];

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
] as const;
export type KpiId = (typeof KPI_IDS)[number];

export const KPI_TITLES: Record<KpiId, string> = {
  demand_realism: 'Demand Realism',
  expedite_effectiveness: 'Expedite Effectiveness',
  grir_over_60d: 'GR/IR > 60 days',
  commitment_over_60d: 'Open Commitment > 60 days',
  wbs_compliance: 'PR without WBS (AR required)',
  cycle_pr_approval: 'PR Approval (median days)',
  cycle_sourcing: 'Sourcing (median days)',
  cycle_po_approval: 'PO Approval (median days)',
  cycle_delivery: 'Delivery (median days)',
  cycle_e2e: 'End-to-end (median days)',
  retro_po_rate: 'Retro POs',
  split_sourcing: 'Split-sourced PR items',
  reversal_rate: 'GR reversal rate',
  sto_share: 'STO share of PO lines',
  direct_po_share: 'Direct POs (no PR)',
  open_items: 'Open items',
  pending_pr_approvals: 'PRs pending approval',
  pending_po_approvals: 'POs pending approval',
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
