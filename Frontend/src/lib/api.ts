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

export interface DownloadResult {
  filename: string;
  /** Rows in the file, and rows that matched, when the server reports them. */
  rows: number | null;
  total: number | null;
}

/**
 * Download a file the API generates, through fetch rather than a plain link.
 *
 * A bare `<a download href>` is simpler and is what the ingest error workbook
 * uses -- correctly, because that file is small and the link is incidental.
 * An export is different in two ways that matter:
 *
 *  - it can take several seconds to build tens of thousands of rows, and a
 *    link gives the page no way to say "preparing"; people click again, and
 *    each click is another full query.
 *  - when it fails -- an expired drill token, a filter that selects nothing,
 *    a session that timed out in another tab -- a link hands the browser a
 *    JSON problem document, which it either displays as raw text or saves as
 *    a broken .xlsx. Neither tells the user what happened.
 *
 * The cost is that the file passes through memory as a blob. At the server's
 * 50,000-row cap that is a few megabytes, which is worth paying for an error
 * message.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<DownloadResult> {
  const res = await fetch(path, { method: 'GET', credentials: 'same-origin' });

  if (!res.ok) {
    let problem: Problem = { type: 'about:blank', title: res.statusText, status: res.status };
    try {
      problem = (await res.json()) as Problem;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, problem);
  }

  // The server names the file; the fallback only covers a proxy that strips
  // the header.
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = match?.[1] ?? fallbackName;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoked on a tick, not immediately: Safari cancels a download whose
    // object URL is revoked in the same task as the click.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  const num = (h: string): number | null => {
    const raw = res.headers.get(h);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return { filename, rows: num('x-export-rows'), total: num('x-export-total') };
}

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
  department?: string | null;
  jobRole?: string | null;
  /** Effective per-page access (011); absent keys mean 'none'. */
  pages?: Record<string, 'none' | 'view' | 'edit'>;
  mustChangePassword?: boolean;
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
  prDateRange?: { from: string; to: string } | null;
  /** PO document-date span. Distinct from prDateRange, which reaches further back. */
  poDateRange?: { from: string; to: string } | null;
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
