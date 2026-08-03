export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  requestId?: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly problem: Problem) {
    super(problem.title);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    // Single origin: the session cookie is first-party.
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let problem: Problem = { type: 'about:blank', title: res.statusText, status: res.status };
    try {
      problem = (await res.json()) as Problem;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, problem);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b),
};

// ─────────────────────────────────────────────────────────────────── types

export interface Me {
  userId: string;
  email: string;
  displayName: string;
  authMethod: 'sso' | 'local';
  roles: string[];
  scope: { companyCode: string; plant: string; purchOrg: string }[];
  capabilities: string[];
  ssoEnabled: boolean;
}

export interface FeedInfo {
  feed: string;
  filename: string;
  rowCount: number;
  rowDelta: number | null;
  sha256Short: string;
}

export interface DatasetCurrent {
  datasetVersionId: number | null;
  state?: string;
  message?: string;
  asOfDate: string;
  asOfSource: string;
  publishedAt: string;
  publishedBy: string | null;
  sourceKind: string;
  sourceLabel: string;
  freshnessState: 'current' | 'ageing' | 'stale' | 'caveats' | 'loading';
  timeFreshness: string;
  fxPolicy: string;
  feeds: FeedInfo[];
  validationSummary: { blocker: number; caveat: number; warning: number; info: number };
  activeCaveats: { ruleId: string; message: string; disablesKpis: string[] }[];
  ruleSnapshot: Record<string, unknown>;
  metrics: Record<string, unknown>;
}

export interface Kpi {
  kpiId: string;
  title: string;
  status: 'ok' | 'insufficient_sample' | 'disabled' | 'unavailable';
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  sampleSize: number | null;
  unit: string;
  currencyBasis: string | null;
  severity: string | null;
  statusReason: string | null;
  detail: Record<string, unknown> | null;
  drillToken: string | null;
}

export interface ChartResponse {
  chartId: string;
  title: string;
  unit: string;
  buckets: { key: string; label: string; ordinal: number }[];
  series: {
    key: string;
    label: string;
    points: { bucketKey: string; value: number | null; rowCount: number; drillToken: string | null }[];
  }[];
  notes: string[];
}

export interface DrillPage {
  label: string;
  grain: string;
  totalCount: number;
  note: string | null;
  columns: { key: string; label: string; type: string; currency?: string }[];
  rows: Record<string, unknown>[];
  nextCursor: string | null;
  totals: { idrSum: number | null; usdSum: number | null; usdComplete: boolean } | null;
  detailHandoff: { params: Record<string, string>; unmapped: string[] } | null;
}

export interface Finding {
  ruleId: string;
  severity: 'BLOCKER' | 'CAVEAT' | 'WARNING' | 'INFO';
  feed: string | null;
  message: string;
  affectedRows: number | null;
  measured: Record<string, unknown> | null;
  disablesKpis: string[];
}
