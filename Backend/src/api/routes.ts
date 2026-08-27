/**
 * HTTP routes — TECH 02.
 *
 * Every route declares its access explicitly via `pub()` or `role()`. There is no
 * implicit default, so a forgotten guard is visible in the route table rather
 * than silently public.
 */

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { freshnessState, type FreshnessState } from '@pct/rules';
import { FEEDS, KPI_TITLES, ROLE_RANK, type Role } from '@pct/contracts';
import {
  buildErrorWorkbook, errorWorkbookName, loadFindingRows, loadRowErrors,
} from '../modules/ingest/error_report.js';
import { resolvePages } from '../modules/authz/pages.js';
import { loadEnv } from '../config/env.js';
import { healthCheck, query, queryOne } from '../db/client.js';
import {
  AuthError, buildAuthorizeUrl, changeLocalPassword, ensureOidcReady, handleOidcCallback,
  loadPrincipal, localLogin, oidcEnabled,
  type Principal,
} from '../modules/auth/auth.js';
import {
  destroySession, loadSession, sessionFingerprint, sessionStoreHealthy, sessionStoreKind,
} from '../modules/auth/session.js';
import { resolveScope, type ScopeEntry } from '../modules/authz/scope.js';
import { recordAudit, listAudit, verifyAuditChain } from '../modules/audit/audit.js';
import {
  DrillTokenError, executeDrill, issueDrillToken, openDrillToken, type DrillPredicate,
} from '../modules/analytics/drill.js';
import { CHART_BY_ID, CHART_META } from '../modules/analytics/charts.js';
import { getFindings, publishVersion, runIngest } from '../modules/ingest/pipeline.js';
import { ManualUploadSource, type DiscoveredFile } from '../modules/ingest/sources.js';
import { PerFeedShareSource, archiveAfterRun, loadShareConfig } from '../modules/ingest/share_poller.js';
import { notify } from '../modules/notify/mailer.js';
import { ingestFailureBody } from '../modules/notify/messages.js';
import { loadRuleSnapshot, listRuleHistory, setRule } from '../modules/admin/rules.js';
import { queryDetail, DETAIL_COLUMNS, type DetailFilters } from '../modules/analytics/detail.js';
import {
  describeFilter, isEmptyFilter, parseGlobalFilter, type GlobalFilter,
} from '../modules/analytics/globalfilter.js';
import {
  computeLiveChart, computeLiveChartSeries, computeLiveKpis, globalFilterOptions, liveChartAvailable,
} from '../modules/analytics/live.js';
import { mountExtraRoutes } from './routes_extra.js';

const env = loadEnv();

// ─────────────────────────────────────────────────────────────── middleware

interface Ctx {
  principal: Principal;
  scope: ScopeEntry[];
  sid: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: Ctx;
      requestId?: string;
    }
  }
}

export class HttpProblem extends Error {
  constructor(
    public readonly status: number,
    public readonly type: string,
    public readonly title: string,
    public readonly detail?: string,
  ) {
    super(title);
  }
}

/** Reachable while must_change_password is set — nothing else is. */
const PASSWORD_CHANGE_ALLOWLIST = new Set([
  '/api/v1/me',
  '/auth/local/change-password',
  '/auth/logout',
]);

function pub(handler: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res);
    } catch (e) {
      next(e);
    }
  };
}

function role(min: Role, handler: (req: Request, res: Response, ctx: Ctx) => Promise<void> | void) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await loadSession(req);
      if (!session) {
        throw new HttpProblem(401, 'not-authenticated', 'Not signed in');
      }
      const principal = await loadPrincipal(session.data.userId);
      if (!principal) {
        throw new HttpProblem(401, 'not-authenticated', 'Session no longer valid');
      }
      const rank = Math.max(...principal.roles.map((r) => ROLE_RANK[r] ?? 0), 0);
      if (rank < ROLE_RANK[min]) {
        await recordAudit({
          action: 'authz.denied', actorUserId: principal.userId, actorEmail: principal.email,
          outcome: 'denied', detail: { required: min, path: req.path }, ip: req.ip,
        });
        throw new HttpProblem(403, 'insufficient-role', `Requires ${min}`);
      }
      // Forced rotation (011): while the flag is set the ONLY reachable
      // endpoints are the ones needed to change it. Enforced here, in the one
      // guard every authenticated route goes through — not merely in the UI.
      if (principal.mustChangePassword && !PASSWORD_CHANGE_ALLOWLIST.has(req.path)) {
        throw new HttpProblem(
          403, 'password-change-required',
          'Your temporary password must be changed before using the application.',
        );
      }
      const scope = await resolveScope(principal.userId);
      const ctx: Ctx = { principal, scope, sid: session.sid };
      req.ctx = ctx;
      await handler(req, res, ctx);
    } catch (e) {
      next(e);
    }
  };
}

/**
 * A writable spool root. The configured path is a mounted volume; if it was
 * created before the image set its ownership it is root-owned and this process
 * (uid 1001) cannot write there. Rather than failing every manual upload, fall
 * back to the OS temp dir and say so — spooled files are request-scoped and
 * deleted when the batch reaches a terminal state, so durability is irrelevant.
 */
let spoolRootCache: string | null = null;
async function spoolRoot(): Promise<string> {
  if (spoolRootCache) return spoolRootCache;
  const configured = env.UPLOAD_SPOOL_PATH;
  try {
    await mkdir(configured, { recursive: true });
    const probe = join(configured, `.probe-${randomUUID()}`);
    await writeFile(probe, '');
    await unlink(probe).catch(() => undefined);
    spoolRootCache = configured;
  } catch (err) {
    const fallback = join(tmpdir(), 'pct-spool');
    await mkdir(fallback, { recursive: true });
    process.stderr.write(
      `WARNING: upload spool ${configured} is not writable ` +
      `(${err instanceof Error ? err.message : String(err)}); using ${fallback}. ` +
      `Fix the volume's ownership to uid 1001 to silence this.
`,
    );
    spoolRootCache = fallback;
  }
  return spoolRootCache;
}

// ────────────────────────────────────────────────────────────── helpers

async function currentVersion(): Promise<{
  id: number; asOfDate: string; publishedAt: string; asOfSource: string; fxPolicy: string;
  ruleSnapshot: Record<string, unknown>; sourceKind: 'synology' | 'manual';
  publishedBy: string | null; batchId: number; feedRowCounts: Record<string, number>;
  feedRowDeltas: Record<string, number> | null; metrics: Record<string, unknown>;
} | null> {
  const r = await queryOne<{
    id: number; as_of_date: string; published_at: string; as_of_source: string; fx_policy: string;
    rule_snapshot: Record<string, unknown>; source_kind: 'synology' | 'manual'; email: string | null;
    batch_id: number; feed_row_counts: Record<string, number>;
    feed_row_deltas: Record<string, number> | null; metrics: Record<string, unknown>;
  }>(
    `SELECT v.id, v.as_of_date, v.published_at, v.as_of_source, v.fx_policy, v.rule_snapshot,
            b.source_kind, u.email, v.batch_id, v.feed_row_counts, v.feed_row_deltas, v.metrics
       FROM core.dataset_pointer p
       JOIN core.dataset_version v ON v.id = p.current_version_id
       JOIN ingest.batch b ON b.id = v.batch_id
       LEFT JOIN app.app_user u ON u.id = v.published_by
      WHERE p.id = 1`,
  );
  if (!r) return null;
  return {
    id: r.id,
    asOfDate: r.as_of_date,
    publishedAt: new Date(r.published_at).toISOString(),
    asOfSource: r.as_of_source,
    fxPolicy: r.fx_policy,
    ruleSnapshot: r.rule_snapshot,
    sourceKind: r.source_kind,
    publishedBy: r.email,
    batchId: r.batch_id,
    feedRowCounts: r.feed_row_counts,
    feedRowDeltas: r.feed_row_deltas,
    metrics: r.metrics,
  };
}

function requireScope(ctx: Ctx): void {
  if (ctx.scope.length === 0) {
    throw new HttpProblem(
      403,
      'scope-empty',
      'No data access granted',
      'Your account has no data scope. Ask an administrator to grant access.',
    );
  }
}

// ───────────────────────────────────────────────────────────────── router

export function buildRouter(): Router {
  const r = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    // FEEDS.length, not 6: the bundle grew by four optional reference files
    // (018) and multer silently rejects the surplus, which would surface as a
    // confusing "incomplete bundle" for a user who selected all ten.
    limits: { fileSize: env.UPLOAD_MAX_FILE_MB * 1024 * 1024, files: FEEDS.length },
  });

  // ── auth ──

  r.get('/auth/oidc/login', pub(async (req, res) => {
    if (!oidcEnabled()) {
      throw new HttpProblem(404, 'not-found', 'SSO is not configured in this environment');
    }
    // Discovery may have failed at boot (Hub down / booted later): retry here,
    // and answer 503 while it stays unreachable so the login page hides the
    // SSO button instead of offering a dead link. Local login is unaffected.
    if (!(await ensureOidcReady())) {
      throw new HttpProblem(503, 'sso-unavailable', 'The DWS Hub is not reachable right now');
    }
    res.redirect(302, buildAuthorizeUrl(req.query.returnTo as string | undefined));
  }));

  r.get('/auth/oidc/callback', pub(async (req, res) => {
    if (!oidcEnabled()) throw new HttpProblem(404, 'not-found', 'SSO is not configured');
    if (!(await ensureOidcReady())) {
      throw new HttpProblem(503, 'sso-unavailable', 'The DWS Hub is not reachable right now');
    }
    const out = await handleOidcCallback(
      {
        code: req.query.code as string | undefined,
        state: req.query.state as string | undefined,
        // Present ONLY in the IdP-initiated flow: the Hub created the PKCE
        // challenge itself. Branching on this is what makes both flows work.
        code_verifier: req.query.code_verifier as string | undefined,
      },
      req,
      res,
    );
    // 303 so the browser issues a GET carrying the fresh cookie.
    res.redirect(303, out.returnTo);
  }));

  r.post('/auth/local/login', pub(async (req, res) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    if (!email || !password) throw new HttpProblem(400, 'invalid-body', 'email and password are required');
    try {
      const principal = await localLogin(email, password, req, res);
      res.json({ userId: principal.userId, email: principal.email, displayName: principal.displayName });
    } catch (e) {
      if (e instanceof AuthError) {
        // 'disabled' is only ever thrown AFTER the password verified, so its
        // message is safe to pass through; 401 keeps one uniform sentence so a
        // wrong password and an unknown user stay indistinguishable.
        const status = e.code === 'account-locked' ? 423 : e.code === 'disabled' ? 403 : 401;
        throw new HttpProblem(
          status, e.code, 'Sign-in failed',
          status === 401 ? 'Invalid email or password.' : e.message,
        );
      }
      throw e;
    }
  }));

  r.post('/auth/local/change-password', role('viewer', async (req, res, ctx) => {
    const { currentPassword, newPassword } = (req.body ?? {}) as {
      currentPassword?: string; newPassword?: string;
    };
    if (!currentPassword || !newPassword) {
      throw new HttpProblem(400, 'invalid-body', 'currentPassword and newPassword are required');
    }
    try {
      await changeLocalPassword(ctx.principal.userId, currentPassword, newPassword);
    } catch (e) {
      if (e instanceof AuthError) {
        await recordAudit({
          action: 'auth.password_change', actorUserId: ctx.principal.userId,
          actorEmail: ctx.principal.email, outcome: 'failure',
          detail: { reason: e.message }, ip: req.ip,
        });
        throw new HttpProblem(400, 'invalid-credentials', e.message);
      }
      throw e;
    }
    await recordAudit({
      action: 'auth.password_change', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success', detail: {}, ip: req.ip,
    });
    res.json({ ok: true });
  }));

  r.post('/auth/logout', pub(async (req, res) => {
    const session = await loadSession(req);
    if (session) {
      await destroySession(res, session.sid);
      await recordAudit({ action: 'auth.logout', actorUserId: session.data.userId, outcome: 'success', ip: req.ip });
    }
    res.status(204).end();
  }));

  r.get('/api/v1/me', role('viewer', async (_req, res, ctx) => {
    const caps = ['view'];
    const rank = Math.max(...ctx.principal.roles.map((x) => ROLE_RANK[x] ?? 0), 0);
    if (rank >= ROLE_RANK.analyst) caps.push('drill', 'export');
    if (rank >= ROLE_RANK.steward) caps.push('ingest');
    if (rank >= ROLE_RANK.admin) caps.push('admin', 'publish');
    res.json({
      userId: ctx.principal.userId,
      email: ctx.principal.email,
      displayName: ctx.principal.displayName,
      authMethod: ctx.principal.authMethod,
      roles: ctx.principal.roles,
      scope: ctx.scope,
      capabilities: caps,
      department: ctx.principal.department,
      jobRole: ctx.principal.jobRole,
      pages: await resolvePages(ctx.principal.userId, ctx.principal.roles),
      mustChangePassword: ctx.principal.mustChangePassword,
      ssoEnabled: oidcEnabled(),
    });
  }));


  // ── per-user UI preferences (v1 used browser localStorage) ──

  r.get('/api/v1/me/preferences/:key', role('viewer', async (req, res, ctx) => {
    const row = await queryOne<{ pref_value: unknown }>(
      `SELECT pref_value FROM app.user_preference WHERE user_id = $1 AND pref_key = $2`,
      [ctx.principal.userId, req.params.key],
    );
    res.json({ key: req.params.key, value: row?.pref_value ?? null });
  }));

  r.put('/api/v1/me/preferences/:key', role('viewer', async (req, res, ctx) => {
    const value = (req.body ?? {}).value;
    if (value === undefined) throw new HttpProblem(400, 'invalid-body', 'value is required');
    await query(
      `INSERT INTO app.user_preference (user_id, pref_key, pref_value)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (user_id, pref_key)
         DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = now()`,
      [ctx.principal.userId, req.params.key, JSON.stringify(value)],
    );
    res.json({ key: req.params.key, value });
  }));

  // ── dataset & freshness ──

  r.get('/api/v1/dataset/current', role('viewer', async (_req, res) => {
    const v = await currentVersion();
    if (!v) {
      res.json({ datasetVersionId: null, state: 'no_data', message: 'No dataset has been published yet.' });
      return;
    }
    const findings = await getFindings(v.batchId);
    const caveats = findings.filter((f) => f.severity === 'CAVEAT');
    const today = new Date().toISOString().slice(0, 10);
    const base: FreshnessState = freshnessState(v.asOfDate, today, {
      ageingDays: Number(v.ruleSnapshot['freshness.ageing_days'] ?? 3),
      staleDays: Number(v.ruleSnapshot['freshness.stale_days'] ?? 7),
    });

    const files = await query<{ detected_feed: string; original_filename: string; row_count: number; sha256: string }>(
      `SELECT detected_feed, original_filename, row_count, sha256
         FROM ingest.batch_file WHERE batch_id = $1 AND detected_feed IS NOT NULL`,
      [v.batchId],
    );

    // v1's Overview header shows the requisition-date span of the data.
    const prRange = await queryOne<{ min: string | null; max: string | null }>(
      `SELECT min(requisition_date)::text AS min, max(requisition_date)::text AS max
         FROM core.fact_pr_item WHERE dataset_version_id = $1`,
      [v.id],
    );

    // The PO commitment period, which is NOT prDateRange. Requisitions in this
    // extract reach back to 2023 while the orders are 2026 — so an Executive
    // Summary headed with the PR span would claim a period the value figures do
    // not cover. Same population as the page: purchase lines only.
    const poRange = await queryOne<{ min: string | null; max: string | null }>(
      `SELECT min(document_date)::text AS min, max(document_date)::text AS max
         FROM core.fact_po_line
        WHERE dataset_version_id = $1 AND NOT is_sto AND NOT is_deleted`,
      [v.id],
    );

    res.json({
      datasetVersionId: v.id,
      prDateRange: prRange && prRange.min ? { from: prRange.min, to: prRange.max } : null,
      poDateRange: poRange && poRange.min ? { from: poRange.min, to: poRange.max } : null,
      asOfDate: v.asOfDate,
      asOfSource: v.asOfSource,
      publishedAt: v.publishedAt,
      publishedBy: v.publishedBy,
      sourceKind: v.sourceKind,
      sourceLabel: v.sourceKind === 'synology' ? 'Share folder sync' : `Manual upload${v.publishedBy ? ` — ${v.publishedBy}` : ''}`,
      // Caveats override the time-based state: the reader needs to know a KPI is
      // disabled more urgently than that the data is two days old.
      freshnessState: caveats.length > 0 ? 'caveats' : base,
      timeFreshness: base,
      fxPolicy: v.fxPolicy,
      feeds: files.map((f) => ({
        feed: f.detected_feed,
        filename: f.original_filename,
        rowCount: f.row_count,
        rowDelta: v.feedRowDeltas?.[f.detected_feed] ?? null,
        sha256Short: f.sha256.slice(0, 8),
      })),
      validationSummary: {
        blocker: findings.filter((f) => f.severity === 'BLOCKER').length,
        caveat: caveats.length,
        warning: findings.filter((f) => f.severity === 'WARNING').length,
        info: findings.filter((f) => f.severity === 'INFO').length,
      },
      activeCaveats: caveats.map((c) => ({
        ruleId: c.ruleId,
        message: c.message,
        disablesKpis: c.disablesKpis,
      })),
      ruleSnapshot: v.ruleSnapshot,
      metrics: v.metrics,
    });
  }));

  r.get('/api/v1/dataset/versions', role('viewer', async (_req, res) => {
    const rows = await query(
      `SELECT v.id, v.as_of_date AS "asOfDate", v.published_at AS "publishedAt", v.status,
              b.source_kind AS "sourceKind", u.email AS "publishedBy",
              (SELECT sum(x)::int FROM jsonb_each_text(v.feed_row_counts) AS t(k, x2),
                      LATERAL (SELECT x2::int AS x) s) AS "rowTotal"
         FROM core.dataset_version v
         JOIN ingest.batch b ON b.id = v.batch_id
         LEFT JOIN app.app_user u ON u.id = v.published_by
        ORDER BY v.id DESC LIMIT 25`,
    );
    res.json({ versions: rows, retained: env.DATASET_VERSIONS_RETAINED });
  }));

  r.get('/api/v1/dataset/:id/validation', role('analyst', async (req, res) => {
    const id = Number(req.params.id);
    const v = await queryOne<{ batch_id: number }>(
      `SELECT batch_id FROM core.dataset_version WHERE id = $1`,
      [id],
    );
    if (!v) throw new HttpProblem(404, 'not-found', 'Dataset version not found');
    res.json({ datasetVersionId: id, batchId: v.batch_id, findings: await getFindings(v.batch_id) });
  }));

  // ── KPIs ──

  r.get('/api/v1/filters', role('viewer', async (_req, res, ctx) => {
    requireScope(ctx);
    const v = await currentVersion();
    if (!v) throw new HttpProblem(404, 'not-found', 'No published dataset');
    res.json({ datasetVersionId: v.id, ...(await globalFilterOptions(v.id)) });
  }));

  r.get('/api/v1/kpi', role('viewer', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await currentVersion();
    if (!v) throw new HttpProblem(404, 'not-found', 'No published dataset');

    const gf: GlobalFilter = parseGlobalFilter(req.query as Record<string, unknown>);

    /**
     * Optional `?ids=a,b,c` — return only these KPIs.
     *
     * The dashboard asks for the KPIs of the page being opened rather than all
     * 71 on first paint, and asks again on every page change so the figures are
     * current. Filtering here rather than in the browser is what makes that
     * cheap: under a global filter each KPI is recomputed from the facts, so
     * sending ids turns a full recompute into one for the dozen the page shows.
     *
     * Unknown ids are ignored rather than rejected: a browser running an older
     * build must degrade to "that card is missing", never to a failed request
     * that empties the whole page.
     */
    const idsParam = String((req.query as Record<string, unknown>)['ids'] ?? '').trim();
    const wanted = idsParam === ''
      ? null
      : new Set(idsParam.split(',').map((x) => x.trim()).filter((x) => x !== '').slice(0, 200));

    // A filtered request recomputes from the facts using the SAME spec SQL the
    // mart precomputes. The precomputed path below is untouched, so a bug in the
    // live path cannot affect the default dashboard.
    if (!isEmptyFilter(gf)) {
      const fpLive = sessionFingerprint(ctx.sid);
      const liveAll = await computeLiveKpis(v.id, gf);
      const live = wanted ? liveAll.filter((k) => wanted.has(k.kpiId)) : liveAll;
      // Membership is tested against EVERY live KPI, not just the requested
      // ones: a KPI that recomputes live must not be listed as unavailable
      // merely because this page did not ask for it.
      const liveIds = new Set(liveAll.map((k) => k.kpiId));

      // The 18 original mart KPIs (cycle times, GR/IR share, expedite, WBS…)
      // have no live recomputation yet. Under a filter they must NOT silently
      // vanish, and they must NOT show their unfiltered value as if filtered —
      // so they render as unavailable with the reason stated.
      const martOnly = await query<{ kpi_id: string; unit: string }>(
        `SELECT kpi_id, unit FROM mart.kpi_value
          WHERE dataset_version_id = $1 ORDER BY kpi_id`,
        [v.id],
      );

      const filteredOut = martOnly
        .filter((m) => !liveIds.has(m.kpi_id))
        .filter((m) => !wanted || wanted.has(m.kpi_id))
        .map((m) => ({
          kpiId: m.kpi_id,
          title: KPI_TITLES[m.kpi_id as keyof typeof KPI_TITLES] ?? m.kpi_id,
          status: 'unavailable' as const,
          value: null,
          numerator: null,
          denominator: null,
          sampleSize: null,
          unit: m.unit,
          currencyBasis: null,
          severity: null,
          statusReason: 'This figure does not support the global filter yet.',
          detail: null,
          drillToken: null,
        }));

      res.json({
        datasetVersionId: v.id,
        asOfDate: v.asOfDate,
        appliedFilters: describeFilter(gf),
        computed: 'live',
        kpis: [
          ...live.map((k) => ({
            kpiId: k.kpiId,
            title: KPI_TITLES[k.kpiId as keyof typeof KPI_TITLES] ?? k.kpiId,
            status: k.status,
            value: k.value,
            numerator: k.numerator,
            denominator: k.denominator,
            sampleSize: k.sampleSize,
            unit: k.unit,
            currencyBasis: k.currencyBasis,
            severity: k.severity,
            statusReason: k.statusReason,
            detail: k.detail,
            drillToken:
              k.drillPredicate && k.status === 'ok'
                ? issueDrillToken(k.drillPredicate as unknown as DrillPredicate, v.id, ctx.scope, fpLive)
                : null,
          })),
          ...filteredOut,
        ],
      });
      return;
    }

    const rows = await query<{
      kpi_id: string; status: string; value_num: number | null; numerator: number | null;
      denominator: number | null; sample_size: number | null; unit: string;
      currency_basis: string | null; severity: string | null; status_reason: string | null;
      detail: Record<string, unknown> | null; drill_predicate: DrillPredicate | null;
    }>(
      `SELECT kpi_id, status, value_num, numerator, denominator, sample_size, unit,
              currency_basis, severity, status_reason, detail, drill_predicate
         FROM mart.kpi_value
        WHERE dataset_version_id = $1
          AND ($2::text[] IS NULL OR kpi_id = ANY($2::text[]))
        ORDER BY kpi_id`,
      [v.id, wanted ? [...wanted] : null],
    );

    const fp = sessionFingerprint(ctx.sid);
    res.json({
      datasetVersionId: v.id,
      asOfDate: v.asOfDate,
      appliedFilters: {},
      computed: 'precomputed',
      kpis: rows.map((k) => ({
        kpiId: k.kpi_id,
        title: KPI_TITLES[k.kpi_id as keyof typeof KPI_TITLES] ?? k.kpi_id,
        status: k.status,
        value: k.value_num,
        numerator: k.numerator,
        denominator: k.denominator,
        sampleSize: k.sample_size,
        unit: k.unit,
        currencyBasis: k.currency_basis,
        severity: k.severity,
        statusReason: k.status_reason,
        detail: k.detail,
        // A disabled KPI gets no drill token: there is nothing behind it.
        drillToken:
          k.drill_predicate && k.status === 'ok'
            ? issueDrillToken(k.drill_predicate, v.id, ctx.scope, fp)
            : null,
      })),
    });
  }));

  // ── charts ──

  r.get('/api/v1/chart', role('viewer', async (_req, res) => {
    res.json({ charts: CHART_META });
  }));

  r.get('/api/v1/chart/:chartId', role('viewer', async (req, res, ctx) => {
    requireScope(ctx);
    const meta = CHART_BY_ID.get(req.params.chartId!);
    if (!meta) throw new HttpProblem(404, 'not-found', 'Unknown chart');

    const v = await currentVersion();
    if (!v) throw new HttpProblem(404, 'not-found', 'No published dataset');

    const gf: GlobalFilter = parseGlobalFilter(req.query as Record<string, unknown>);

    // Same rule as the KPI endpoint: filtered requests recompute live from the
    // spec SQL; the precomputed path is left alone.
    if (!isEmptyFilter(gf) && liveChartAvailable(meta.chartId)) {
      // Every series, not just the first: computeLiveChart used to return one,
      // so a filtered multi-series panel silently lost the rest.
      const liveSeries = await computeLiveChartSeries(v.id, meta.chartId, gf);
      if (liveSeries) {
        const fpLive = sessionFingerprint(ctx.sid);
        // Buckets are the UNION across series, ordered by the ordinal the specs
        // assigned. A series may legitimately miss a bucket — a size band with
        // only Delivered rows has no Open segment — so taking them from one
        // series would drop columns from the axis.
        const bucketOrder = new Map<string, { key: string; label: string; ordinal: number }>();
        for (const one of liveSeries) {
          for (const pt of one.points) {
            if (!bucketOrder.has(pt.bucketKey)) {
              bucketOrder.set(pt.bucketKey, {
                key: pt.bucketKey, label: pt.bucketLabel, ordinal: pt.ordinal,
              });
            }
          }
        }
        res.json({
          datasetVersionId: v.id,
          asOfDate: v.asOfDate,
          chartId: meta.chartId,
          title: meta.title,
          unit: meta.unit,
          currencyBasis: null,
          computed: 'live',
          appliedFilters: describeFilter(gf),
          buckets: [...bucketOrder.values()].sort((a, b) => a.ordinal - b.ordinal),
          series: liveSeries.map((one) => ({
            key: one.seriesKey,
            label: one.seriesLabel,
            points: one.points.map((pt) => ({
              bucketKey: pt.bucketKey,
              value: pt.value,
              rowCount: pt.rowCount,
              drillToken: issueDrillToken(
                {
                  ...(pt.drillPredicate as unknown as DrillPredicate),
                  label: `${meta.title} — ${one.seriesLabel} — ${pt.bucketLabel}`,
                },
                v.id,
                ctx.scope,
                fpLive,
              ),
            })),
          })),
          notes: liveSeries.length === 0
            ? ['No rows match the active filter']
            : (meta.notes ?? []),
        });
        return;
      }
    }

    const rows = await query<{
      series_key: string; series_label: string; bucket_key: string; bucket_label: string;
      bucket_ordinal: number; value_num: number | null; row_count: number;
      drill_predicate: DrillPredicate;
    }>(
      `SELECT series_key, series_label, bucket_key, bucket_label, bucket_ordinal,
              value_num, row_count, drill_predicate
         FROM mart.chart_series
        WHERE dataset_version_id = $1 AND chart_id = $2
        ORDER BY bucket_ordinal, series_key`,
      [v.id, meta.chartId],
    );

    const fp = sessionFingerprint(ctx.sid);
    const bucketMap = new Map<string, { key: string; label: string; ordinal: number }>();
    const seriesMap = new Map<string, { key: string; label: string; points: unknown[] }>();

    for (const row of rows) {
      if (!bucketMap.has(row.bucket_key)) {
        bucketMap.set(row.bucket_key, {
          key: row.bucket_key,
          label: row.bucket_label,
          ordinal: row.bucket_ordinal,
        });
      }
      let s = seriesMap.get(row.series_key);
      if (!s) {
        s = { key: row.series_key, label: row.series_label, points: [] };
        seriesMap.set(row.series_key, s);
      }
      s.points.push({
        bucketKey: row.bucket_key,
        value: row.value_num,
        // The count the drill will return — asserted equal in CI for every chart.
        rowCount: row.row_count,
        drillToken: issueDrillToken(
          { ...row.drill_predicate, label: `${meta.title} — ${row.bucket_label}` },
          v.id,
          ctx.scope,
          fp,
        ),
      });
    }

    // Charts without a live recomputation path fall back to the precomputed
    // (unfiltered) series. Showing an unfiltered figure while a filter is
    // active would be silently wrong, so the fallback is declared.
    const filterNotApplied =
      !isEmptyFilter(gf) && !liveChartAvailable(meta.chartId)
        ? ['⚠ Global filter NOT applied to this chart — showing all data']
        : [];

    res.json({
      datasetVersionId: v.id,
      asOfDate: v.asOfDate,
      chartId: meta.chartId,
      title: meta.title,
      unit: meta.unit,
      currencyBasis: null,
      computed: 'precomputed',
      buckets: [...bucketMap.values()].sort((a, b) => a.ordinal - b.ordinal),
      series: [...seriesMap.values()],
      notes: [
        ...filterNotApplied,
        ...(rows.length === 0
          ? ['No rows with the required dates in this dataset']
          : (meta.notes ?? [])),
      ],
    });
  }));

  // ── drill ──

  r.get('/api/v1/drill/:token', role('analyst', async (req, res, ctx) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const offset = Number(req.query.cursor ?? 0);
    try {
      const payload = openDrillToken(req.params.token!, sessionFingerprint(ctx.sid), ctx.scope);
      const page = await executeDrill(payload, limit, offset);
      res.json({ ...page, asOfDate: (await currentVersion())?.asOfDate ?? null });
    } catch (e) {
      if (e instanceof DrillTokenError) {
        if (e.code === 'foreign') {
          await recordAudit({
            action: 'drill.token_replay', actorUserId: ctx.principal.userId,
            actorEmail: ctx.principal.email, outcome: 'denied', ip: req.ip,
          });
          throw new HttpProblem(403, 'drill-token-foreign', 'Drill token does not belong to this session');
        }
        throw new HttpProblem(
          401,
          e.code === 'expired' ? 'drill-token-expired' : 'drill-token-invalid',
          e.code === 'expired' ? 'Drill token expired' : 'Invalid drill token',
        );
      }
      throw e;
    }
  }));

  // ── detail rows ──

  r.get('/api/v1/rows', role('analyst', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await currentVersion();
    if (!v) throw new HttpProblem(404, 'not-found', 'No published dataset');

    const grain = (req.query.grain as string) ?? 'po_line';
    if (!['pr_item', 'po_line', 'gr_posting'].includes(grain)) {
      throw new HttpProblem(400, 'invalid-parameter', 'Unsupported grain');
    }
    const filters: Record<string, unknown> = {};
    if (req.query.status) filters['status'] = String(req.query.status);
    if (req.query.plant) filters['plant'] = String(req.query.plant);

    const payload = openDrillToken(
      issueDrillToken({ grain: grain as DrillPredicate['grain'], filters, label: 'Detail table' }, v.id, ctx.scope, sessionFingerprint(ctx.sid)),
      sessionFingerprint(ctx.sid),
      ctx.scope,
    );
    const page = await executeDrill(
      payload,
      Math.min(Number(req.query.limit ?? 100), 1000),
      Number(req.query.cursor ?? 0),
    );
    res.json({ ...page, asOfDate: v.asOfDate, appliedFilters: filters });
  }));


  // ── detail table (v1 pg-dt, 41 columns) ──

  r.get('/api/v1/detail/columns', role('analyst', async (_req, res) => {
    res.json({ columns: DETAIL_COLUMNS.map(({ sql: _s, ...rest }) => rest) });
  }));

  r.get('/api/v1/detail', role('analyst', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await currentVersion();
    if (!v) throw new HttpProblem(404, 'not-found', 'No published dataset');

    const list = (name: string): string[] | undefined => {
      const raw = req.query[name];
      if (raw === undefined) return undefined;
      const arr = Array.isArray(raw) ? raw.map(String) : String(raw).split(',');
      const cleaned = arr.map((x) => x.trim()).filter((x) => x !== '');
      return cleaned.length > 0 ? cleaned : undefined;
    };
    const flag = (name: string): boolean => String(req.query[name] ?? '') === 'true';

    const filters: DetailFilters = {
      status: list('status'),
      matCat: list('matCat'),
      matGroup: list('matGroup'),
      plant: list('plant'),
      company: list('company'),
      purchOrg: list('purchOrg'),
      purchGroup: list('purchGroup'),
      priority: list('priority'),
      monthKey: list('monthKey'),
      search: req.query.q === undefined ? undefined : String(req.query.q),
      excludeSto: flag('excludeSto'),
      includeDeleted: flag('includeDeleted'),
      onlyOpen: flag('onlyOpen'),
      onlyDirectPo: flag('onlyDirectPo'),
      onlyReleaseExempt: flag('onlyReleaseExempt'),
    };

    // Unknown parameters are rejected, not ignored: a typo must not silently
    // return unfiltered data.
    const allowed = new Set([
      'status','matCat','matGroup','plant','company','purchOrg','purchGroup','priority','monthKey',
      'q','excludeSto','includeDeleted','onlyOpen','onlyDirectPo','onlyReleaseExempt',
      'sort','dir','limit','cursor','facets',
    ]);
    for (const k of Object.keys(req.query)) {
      if (!allowed.has(k)) {
        throw new HttpProblem(400, 'invalid-parameter', `Unknown query parameter: ${k}`);
      }
    }

    const sortKey = req.query.sort === undefined ? null : String(req.query.sort);
    const sortDir = String(req.query.dir ?? 'asc') === 'desc' ? 'desc' : 'asc';

    const page = await queryDetail(
      v.id,
      v.asOfDate,
      ctx.scope,
      filters,
      sortKey ? { key: sortKey, dir: sortDir } : null,
      Math.min(Number(req.query.limit ?? 200), 1000),
      Number(req.query.cursor ?? 0),
      String(req.query.facets ?? '') === 'true',
    );
    res.json(page);
  }));

  // ── ingestion ──

  r.get('/api/v1/ingest/batches', role('analyst', async (_req, res) => {
    const rows = await query(
      `SELECT b.id, b.source_kind AS "sourceKind", b.state, b.started_at AS "startedAt",
              b.finished_at AS "finishedAt", b.failure_reason AS "failureReason",
              b.timings, u.email AS "submittedBy",
              (SELECT count(*)::int FROM ingest.batch_file f WHERE f.batch_id = b.id) AS "fileCount",
              (SELECT id FROM core.dataset_version v WHERE v.batch_id = b.id) AS "datasetVersionId",
              (SELECT jsonb_build_object(
                 'blocker', count(*) FILTER (WHERE severity='BLOCKER'),
                 'caveat',  count(*) FILTER (WHERE severity='CAVEAT'),
                 'warning', count(*) FILTER (WHERE severity='WARNING'),
                 'info',    count(*) FILTER (WHERE severity='INFO'))
                 FROM ingest.validation_finding vf WHERE vf.batch_id = b.id) AS "findingCounts"
         FROM ingest.batch b
         LEFT JOIN app.app_user u ON u.id = b.submitted_by
        ORDER BY b.id DESC LIMIT 50`,
    );
    res.json({ batches: rows });
  }));

  r.post('/api/v1/ingest/sync', role('steward', async (req, res, ctx) => {
    // Same per-feed folders/patterns the scheduler uses, so "Sync now" and the
    // scheduled pickup can never read different files.
    const shareCfg = await loadShareConfig();
    const source = new PerFeedShareSource(shareCfg);
    const force = Boolean((req.body ?? {}).force);
    const out = await runIngest({ source, submittedBy: ctx.principal.userId, autoPublish: true, force });
    // The same after-run filing the scheduled pickup does. Sharing one helper is
    // the point: these two paths already share the source so they cannot read
    // different files, and they must not diverge on what happens next either.
    const archive = await archiveAfterRun(source, out.outcome, 'batchId' in out ? out.batchId : null, shareCfg);
    await recordAudit({
      action: 'ingest.sync', actorUserId: ctx.principal.userId, actorEmail: ctx.principal.email,
      outcome: out.outcome === 'failed' ? 'failure' : 'success',
      detail: { outcome: out.outcome, force, archive }, ip: req.ip,
    });
    // A manual sync notifies on FAILURE only: the person who pressed the button
    // is already looking at the result, but a failure is worth telling the team.
    if (['failed', 'incomplete_bundle', 'source_unavailable'].includes(out.outcome)) {
      const m = await ingestFailureBody({
        trigger: 'manual',
        outcome: out.outcome,
        detail: 'missing' in out ? `missing ${out.missing.join(',')}`
          : 'path' in out ? out.path
          : 'reason' in out ? out.reason : undefined,
        batchId: 'batchId' in out && out.batchId !== null ? out.batchId : undefined,
      });
      await notify('ingest.failure', m.subject, m.body);
    }
    res.json(out);
  }));

  /**
   * The failing rows of a batch, as a workbook.
   *
   * A separate endpoint rather than bytes inlined in the ingest response: the
   * report can be tens of thousands of rows, an operator often wants it minutes
   * later rather than at the moment of failure, and a download must be
   * re-requestable without re-running an ingest.
   *
   * Scoped to steward like the ingest itself. The workbook contains source data,
   * so it must not be more widely readable than the ingest that produced it.
   */
  r.get('/api/v1/ingest/batch/:id/errors.xlsx', role('steward', async (req, res, ctx) => {
    const batchId = Number(req.params.id);
    if (!Number.isInteger(batchId) || batchId <= 0) {
      throw new HttpProblem(400, 'invalid-body', 'batch id must be a positive integer');
    }
    const rows = await loadRowErrors(batchId);
    // The requester's own scope, so the workbook can never contain rows they
    // could not open on screen.
    const findings = await loadFindingRows(batchId, ctx.scope);
    const wb = buildErrorWorkbook(batchId, rows, findings);
    if (wb === null) {
      throw new HttpProblem(
        404, 'not-found',
        `Batch ${batchId} has nothing to report: no unreadable cells and no rule flagged any `
        + 'rows it could name. Either the data is clean, or the batch predates row-level '
        + 'capture, or its staging rows have been pruned.',
      );
    }
    await recordAudit({
      action: 'ingest.errors.download', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success',
      detail: {
        batchId,
        cellErrors: rows.length,
        findingSheets: findings.filter((f) => f.rows.length > 0).length,
        findingRows: findings.reduce((a, f) => a + f.rows.length, 0),
      },
      ip: req.ip,
    });
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${errorWorkbookName(batchId)}"`);
    res.send(wb);
  }));

  // Multer parses the multipart body first; role() then authorises before any
  // file is written to the spool.
  r.post('/api/v1/ingest/upload', upload.array('files', FEEDS.length), role('steward', async (req, res, ctx) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw new HttpProblem(400, 'invalid-body', 'No files supplied');

    const spool = join(await spoolRoot(), randomUUID());
    await mkdir(spool, { recursive: true });

    const staged: DiscoveredFile[] = [];
    try {
      for (const f of files) {
        // The user's filename is NEVER used as a path component.
        const handle = join(spool, `${randomUUID()}.xlsx`);
        await writeFile(handle, f.buffer);
        staged.push({
          handle,
          displayName: f.originalname,
          byteSize: f.size,
          mtime: new Date(),
        });
      }

      const out = await runIngest({
        source: new ManualUploadSource(staged),
        submittedBy: ctx.principal.userId,
        // Manual batches wait for confirmation; automatic batches publish at once.
        autoPublish: req.query.publish === 'true',
      });

      await recordAudit({
        action: 'ingest.upload', actorUserId: ctx.principal.userId, actorEmail: ctx.principal.email,
        outcome: out.outcome === 'failed' ? 'failure' : 'success',
        detail: { outcome: out.outcome, files: staged.map((s) => s.displayName) }, ip: req.ip,
      });
      res.status(201).json(out);
    } finally {
      // Spooled uploads are deleted once the batch reaches a terminal state; only
      // metadata and hashes are retained.
      for (const s of staged) await unlink(s.handle).catch(() => undefined);
    }
  }));

  r.post('/api/v1/dataset/:id/publish', role('admin', async (req, res, ctx) => {
    const id = Number(req.params.id);
    await publishVersion(id, ctx.principal.userId);
    await recordAudit({
      action: 'dataset.publish', actorUserId: ctx.principal.userId, actorEmail: ctx.principal.email,
      objectType: 'dataset_version', objectId: String(id), outcome: 'success', ip: req.ip,
    });
    res.json({ datasetVersionId: id, published: true });
  }));

  r.post('/api/v1/dataset/:id/rollback', role('admin', async (req, res, ctx) => {
    const id = Number(req.params.id);
    const reason = (req.body?.reason as string | undefined)?.trim();
    if (!reason) throw new HttpProblem(400, 'invalid-body', 'A reason is required and is audited');
    await publishVersion(id, ctx.principal.userId);
    await recordAudit({
      action: 'dataset.rollback', actorUserId: ctx.principal.userId, actorEmail: ctx.principal.email,
      objectType: 'dataset_version', objectId: String(id), outcome: 'success',
      detail: { reason }, ip: req.ip,
    });
    res.json({ datasetVersionId: id, rolledBack: true, reason });
  }));

  // ── admin ──

  r.get('/api/v1/admin/rules', role('admin', async (_req, res) => {
    res.json({ rules: await loadRuleSnapshot() });
  }));

  r.get('/api/v1/admin/rules/:key/history', role('admin', async (req, res) => {
    res.json({ history: await listRuleHistory(req.params.key!) });
  }));

  r.put('/api/v1/admin/rules/:key', role('admin', async (req, res, ctx) => {
    const { value, effectiveFrom, note } = (req.body ?? {}) as {
      value?: unknown; effectiveFrom?: string; note?: string;
    };
    if (value === undefined || !effectiveFrom) {
      throw new HttpProblem(400, 'invalid-body', 'value and effectiveFrom are required');
    }
    const before = await loadRuleSnapshot();
    await setRule(req.params.key!, value, effectiveFrom, note ?? null, ctx.principal.userId);
    await recordAudit({
      action: 'admin.rule.update', actorUserId: ctx.principal.userId, actorEmail: ctx.principal.email,
      objectType: 'rule_config', objectId: req.params.key!, outcome: 'success',
      detail: { before: before[req.params.key!], after: value, effectiveFrom }, ip: req.ip,
    });
    res.json({
      ruleKey: req.params.key,
      value,
      effectiveFrom,
      // Published versions carry their own snapshot, so nothing changes retroactively.
      appliesFromNextPublish: true,
      publishedVersionsUnaffected: true,
    });
  }));

  r.get('/api/v1/audit', role('auditor', async (req, res) => {
    res.json({ entries: await listAudit(Number(req.query.limit ?? 100), Number(req.query.offset ?? 0)) });
  }));

  r.get('/api/v1/audit/verify', role('admin', async (_req, res) => {
    res.json({ ...(await verifyAuditChain()), checkedAt: new Date().toISOString() });
  }));

  // ── W3 entity views, W6 steward tooling, W7 custom builder ──
  mountExtraRoutes(r, { role, requireScope, currentVersion, HttpProblem });

  // ── health ──

  r.get('/api/v1/health', pub((_req, res) => {
    res.json({
      status: 'ok',
      version: process.env.APP_VERSION ?? '2.0.0-local',
      gitSha: process.env.GIT_SHA ?? 'dev',
      builtAt: process.env.BUILT_AT ?? null,
    });
  }));

  r.get('/api/v1/ready', pub(async (_req, res) => {
    const db = await healthCheck();
    const redis = await sessionStoreHealthy();
    const checks = [
      { name: 'database', status: db.ok ? 'ok' : 'fail', latencyMs: db.latencyMs },
      { name: 'session_store', status: redis ? 'ok' : 'fail', detail: sessionStoreKind() },
    ];
    const status = checks.some((c) => c.status === 'fail' && c.name === 'database') ? 'fail' : 'ok';
    res.status(status === 'fail' ? 503 : 200).json({ status, checks });
  }));

  return r;
}

// ─────────────────────────────────────────────────── problem+json error filter

export function problemHandler() {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const requestId = req.requestId ?? 'unknown';
    if (err instanceof HttpProblem) {
      res.status(err.status).type('application/problem+json').json({
        type: `/problems/${err.type}`,
        title: err.title,
        status: err.status,
        detail: err.detail,
        requestId,
      });
      return;
    }
    // Never leak stack traces, SQL, file paths or internal hostnames.
    // eslint-disable-next-line no-console
    console.error(`[${requestId}]`, err);
    res.status(500).type('application/problem+json').json({
      type: '/problems/internal-error',
      title: 'Internal error',
      status: 500,
      detail: 'An internal error occurred.',
      requestId,
    });
  };
}
