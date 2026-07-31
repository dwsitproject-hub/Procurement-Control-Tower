/**
 * W3/W6/W7 routes — entity views, steward tooling, custom builder.
 *
 * Split from routes.ts to keep each file reviewable. Same conventions: every
 * route declares its role, scope applies in the data layer, problems are RFC
 * 9457, and nothing user-supplied reaches SQL as text.
 */

import type { Router } from 'express';
import { queryOne, query } from '../db/client.js';
import { recordAudit } from '../modules/audit/audit.js';
import { issueDrillToken, type DrillPredicate } from '../modules/analytics/drill.js';
import { sessionFingerprint } from '../modules/auth/session.js';
import {
  materialDetail, materialGroupPage, vendorDetail, vendorList,
} from '../modules/analytics/entity.js';
import {
  exclusionOptions, fxTable, loadExclusions, mappingStatus, saveExclusions, saveMapping,
} from '../modules/admin/steward.js';
import {
  computeCustomChart, computeCustomKpi, customVocabulary, validateSpec,
  type CustomChartSpec, type CustomKpiSpec,
} from '../modules/analytics/custom.js';
import type { Feed } from '@pct/contracts';

// Injected from routes.ts so both files share one implementation.
export interface RouteHelpers {
  role: (
    min: 'viewer' | 'analyst' | 'manager' | 'auditor' | 'steward' | 'admin',
    handler: (req: any, res: any, ctx: any) => Promise<void> | void,
  ) => any;
  requireScope: (ctx: any) => void;
  currentVersion: () => Promise<{ id: number; asOfDate: string } | null>;
  HttpProblem: new (status: number, type: string, title: string, detail?: string) => Error;
}

const FEEDS: Feed[] = ['pr', 'prel', 'po', 'por', 'gr', 'fx'];

export function mountExtraRoutes(r: Router, h: RouteHelpers): void {
  const { role, requireScope, currentVersion, HttpProblem } = h;

  const version = async () => {
    const v = await currentVersion();
    if (!v) throw new HttpProblem(404, 'not-found', 'No published dataset');
    return v;
  };

  // ── W3: entity views ─────────────────────────────────────────────────────

  r.get('/api/v1/entity/vendors', role('analyst', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    const out = await vendorList(
      v.id,
      ctx.scope,
      String(req.query.q ?? ''),
      Math.min(Number(req.query.limit ?? 50), 200),
    );
    res.json({ datasetVersionId: v.id, asOfDate: v.asOfDate, ...out });
  }));

  r.get('/api/v1/entity/vendor/:code', role('analyst', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    const detail = await vendorDetail(v.id, ctx.scope, String(req.params.code));
    if (!detail) throw new HttpProblem(404, 'not-found', 'Vendor not found or outside your data scope');

    // Drill tokens for the vendor's own populations, so the popup's figures obey
    // the same count-equals-count rule as everything else.
    const fp = sessionFingerprint(ctx.sid);
    const mk = (filters: Record<string, unknown>, label: string) =>
      issueDrillToken(
        { grain: 'po_line', filters, label } as DrillPredicate, v.id, ctx.scope, fp,
      );
    res.json({
      datasetVersionId: v.id,
      asOfDate: v.asOfDate,
      ...detail,
      drill: {
        allLines: mk({ vendorCode: req.params.code }, `Vendor ${req.params.code} — all PO lines`),
        openCommitment: mk(
          { vendorCode: req.params.code, notSto: true, notDeleted: true, hasOpenCommitment: true },
          `Vendor ${req.params.code} — open commitment`,
        ),
      },
    });
  }));

  r.get('/api/v1/entity/material/:code', role('analyst', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    const detail = await materialDetail(v.id, ctx.scope, String(req.params.code));
    if (!detail) throw new HttpProblem(404, 'not-found', 'Material not found or outside your data scope');

    const fp = sessionFingerprint(ctx.sid);
    res.json({
      datasetVersionId: v.id,
      asOfDate: v.asOfDate,
      ...detail,
      drill: {
        allLines: issueDrillToken(
          { grain: 'po_line', filters: { materialCode: req.params.code }, label: `Material ${req.params.code} — all PO lines` } as DrillPredicate,
          v.id, ctx.scope, fp,
        ),
      },
    });
  }));

  r.get('/api/v1/entity/material-groups', role('analyst', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    const out = await materialGroupPage(
      v.id,
      ctx.scope,
      req.query.category === undefined ? null : String(req.query.category),
      String(req.query.q ?? ''),
    );
    res.json({ datasetVersionId: v.id, asOfDate: v.asOfDate, ...out });
  }));

  // ── W6: steward tooling ──────────────────────────────────────────────────

  r.get('/api/v1/admin/fx', role('analyst', async (_req, res) => {
    const v = await version();
    res.json({ datasetVersionId: v.id, ...(await fxTable(v.id)) });
  }));

  r.get('/api/v1/admin/exclusions', role('steward', async (_req, res) => {
    const v = await version();
    res.json({
      current: await loadExclusions(),
      options: await exclusionOptions(v.id),
      note: 'Changes apply on the next recompute (Admin > Recompute), not instantly.',
    });
  }));

  r.put('/api/v1/admin/exclusions', role('admin', async (req, res, ctx) => {
    const b = (req.body ?? {}) as { docTypes?: unknown; purchGroups?: unknown; purchOrgs?: unknown };
    const list = (x: unknown): string[] =>
      Array.isArray(x) ? x.map(String).map((v2) => v2.trim()).filter((v2) => v2 !== '').slice(0, 50) : [];
    const next = { docTypes: list(b.docTypes), purchGroups: list(b.purchGroups), purchOrgs: list(b.purchOrgs) };

    const before = await loadExclusions();
    await saveExclusions(next, ctx.principal.userId);
    await recordAudit({
      action: 'admin.exclusions.update', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success',
      detail: { before, after: next }, ip: req.ip,
    });
    res.json({ saved: next, appliesFromNextRecompute: true });
  }));

  r.get('/api/v1/admin/mappings/:feed', role('steward', async (req, res) => {
    const feed = String(req.params.feed) as Feed;
    if (!FEEDS.includes(feed)) throw new HttpProblem(400, 'invalid-parameter', 'Unknown feed');
    res.json(await mappingStatus(feed));
  }));

  r.put('/api/v1/admin/mappings/:feed', role('steward', async (req, res, ctx) => {
    const feed = String(req.params.feed) as Feed;
    if (!FEEDS.includes(feed)) throw new HttpProblem(400, 'invalid-parameter', 'Unknown feed');
    const { field, sourceHeader } = (req.body ?? {}) as { field?: string; sourceHeader?: string | null };
    if (!field) throw new HttpProblem(400, 'invalid-body', 'field is required');

    await saveMapping(feed, field, sourceHeader ?? null, ctx.principal.userId);
    await recordAudit({
      action: 'admin.mapping.update', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success',
      objectType: 'column_mapping', objectId: `${feed}.${field}`,
      detail: { sourceHeader: sourceHeader ?? null }, ip: req.ip,
    });
    res.json({ feed, field, sourceHeader: sourceHeader ?? null, appliesFromNextIngest: true });
  }));

  // ── W7: custom KPIs and charts ───────────────────────────────────────────

  r.get('/api/v1/custom/vocabulary', role('analyst', async (_req, res) => {
    res.json(customVocabulary());
  }));

  // Preview computes without saving; the same endpoint powers saved cards.
  r.post('/api/v1/custom/kpi', role('analyst', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    let spec: CustomKpiSpec;
    try {
      spec = validateSpec(req.body, false) as CustomKpiSpec;
    } catch (e) {
      throw new HttpProblem(400, 'invalid-body', e instanceof Error ? e.message : 'invalid spec');
    }
    const out = await computeCustomKpi(spec, v.id, ctx.scope);
    res.json({
      datasetVersionId: v.id,
      asOfDate: v.asOfDate,
      title: spec.title,
      value: out.value,
      sampleSize: out.sampleSize,
      // User-defined: outside packages/rules, no golden-number guarantee.
      // The UI is required to show this.
      userDefined: true,
      drillToken: issueDrillToken(
        { ...(out.predicate as unknown as DrillPredicate), label: `Custom KPI: ${spec.title}` },
        v.id, ctx.scope, sessionFingerprint(ctx.sid),
      ),
    });
  }));

  r.post('/api/v1/custom/chart', role('analyst', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    let spec: CustomChartSpec;
    try {
      spec = validateSpec(req.body, true) as CustomChartSpec;
    } catch (e) {
      throw new HttpProblem(400, 'invalid-body', e instanceof Error ? e.message : 'invalid spec');
    }
    const out = await computeCustomChart(spec, v.id, ctx.scope);
    const fp = sessionFingerprint(ctx.sid);
    res.json({
      datasetVersionId: v.id,
      asOfDate: v.asOfDate,
      title: spec.title,
      userDefined: true,
      points: out.points.map((pt) => ({
        bucket: pt.bucket,
        value: pt.value,
        rowCount: pt.rowCount,
        drillToken: issueDrillToken(
          { ...(pt.predicate as unknown as DrillPredicate), label: `${spec.title} — ${pt.bucket}` },
          v.id, ctx.scope, fp,
        ),
      })),
    });
  }));

  // Saved specs live in user preferences, per user, like the table layout.
  r.get('/api/v1/custom/saved', role('analyst', async (_req, res, ctx) => {
    const row = await queryOne<{ pref_value: unknown }>(
      `SELECT pref_value FROM app.user_preference WHERE user_id = $1 AND pref_key = 'custom_specs'`,
      [ctx.principal.userId],
    );
    res.json({ specs: row?.pref_value ?? { kpis: [], charts: [] } });
  }));

  r.put('/api/v1/custom/saved', role('analyst', async (req, res, ctx) => {
    const b = (req.body ?? {}) as { kpis?: unknown[]; charts?: unknown[] };
    // Every saved spec is re-validated: a stale or hand-edited spec must fail
    // loudly here, not at render time.
    const kpis = (b.kpis ?? []).slice(0, 20).map((x) => validateSpec(x, false));
    const charts = (b.charts ?? []).slice(0, 20).map((x) => validateSpec(x, true));
    await query(
      `INSERT INTO app.user_preference (user_id, pref_key, pref_value)
       VALUES ($1, 'custom_specs', $2::jsonb)
       ON CONFLICT (user_id, pref_key)
         DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = now()`,
      [ctx.principal.userId, JSON.stringify({ kpis, charts })],
    );
    res.json({ saved: { kpis: kpis.length, charts: charts.length } });
  }));
}
