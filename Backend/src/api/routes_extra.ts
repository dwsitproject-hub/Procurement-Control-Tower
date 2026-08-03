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
  vendorPivot, vendorPivotMaterials, vendorOtdChart,
} from '../modules/analytics/entity.js';
import {
  exclusionOptions, fxTable, loadExclusions, mappingStatus, saveExclusions, saveMapping,
} from '../modules/admin/steward.js';
import {
  computeCustomChart, computeCustomKpi, customVocabulary, validateSpec,
  type CustomChartSpec, type CustomKpiSpec,
} from '../modules/analytics/custom.js';
import type { Feed } from '@pct/contracts';
import { coupaConfigured, coupaHost } from '../modules/coupa/client.js';
import { COUPA_OBJECTS, runCoupaSync } from '../modules/coupa/sync.js';
import { loadRuleSnapshot } from '../modules/admin/rules.js';

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
      req.query.materialGroup === undefined ? null : String(req.query.materialGroup),
      Math.min(Number(req.query.limit ?? 150), 500),
      Math.max(Number(req.query.offset ?? 0), 0),
    );
    // v1's mgx drill: each category's counts open as rows (G3.4).
    const fp = sessionFingerprint(ctx.sid);
    const categories = (out['categories'] as Record<string, unknown>[]).map((c) => ({
      ...c,
      drillAll: issueDrillToken(
        { grain: 'po_line', filters: { notSto: true, notDeleted: true, matCat: c['category'] }, label: `${c['category']} — all PO lines` } as DrillPredicate,
        v.id, ctx.scope, fp,
      ),
      drillOpen: issueDrillToken(
        { grain: 'po_line', filters: { notSto: true, notDeleted: true, matCat: c['category'], open: true }, label: `${c['category']} — open lines` } as DrillPredicate,
        v.id, ctx.scope, fp,
      ),
    }));
    res.json({ datasetVersionId: v.id, asOfDate: v.asOfDate, ...out, categories });
  }));

  // ── G3.1/G3.2: vendor pivot and the all-vendors OTD chart ──
  r.get('/api/v1/entity/vendor-pivot', role('analyst', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    const out = await vendorPivot(
      v.id, ctx.scope, String(req.query.q ?? ''),
      Math.min(Number(req.query.limit ?? 40), 200),
      Math.max(Number(req.query.offset ?? 0), 0),
    );
    res.json({ datasetVersionId: v.id, asOfDate: v.asOfDate, ...out });
  }));

  r.get('/api/v1/entity/vendor-pivot/:code', role('analyst', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    res.json({
      datasetVersionId: v.id,
      materials: await vendorPivotMaterials(v.id, ctx.scope, String(req.params.code)),
    });
  }));

  r.get('/api/v1/entity/vendor-otd', role('analyst', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    res.json({
      datasetVersionId: v.id,
      note: 'On-time = receipt within 7 days of the PO delivery date (EINDT). EINDT equals the document date on 37.4% of lines — treat as indicative.',
      vendors: await vendorOtdChart(v.id, ctx.scope, Math.min(Number(req.query.limit ?? 40), 100)),
    });
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

  // ── Coupa integration (TECH_04) ──────────────────────────────────────────

  r.get('/api/v1/admin/coupa', role('steward', async (_req, res) => {
    const rules = await loadRuleSnapshot();
    const status = await query(
      `SELECT object, last_updated_at, last_run_at, last_status, last_error, last_trigger,
              rows_upserted, runs
         FROM ops.coupa_watermark ORDER BY object`,
    );
    const counts = await queryOne<Record<string, number>>(
      `SELECT (SELECT count(*) FROM ops.coupa_sourcing_event)::int AS sourcing_events,
              (SELECT count(*) FROM ops.coupa_supplier_response)::int AS supplier_responses,
              (SELECT count(*) FROM ops.coupa_po_line)::int AS po_lines,
              (SELECT count(*) FROM ops.coupa_receipt)::int AS receipts,
              (SELECT count(*) FROM ops.coupa_invoice)::int AS invoices,
              (SELECT count(*) FROM ops.coupa_payment)::int AS payments`,
    );
    res.json({
      configured: coupaConfigured(),
      host: coupaHost(),
      objects: COUPA_OBJECTS,
      config: {
        enabled: rules['coupa.sync_enabled'] === true || rules['coupa.sync_enabled'] === 'true',
        intervalMinutes: Number(rules['coupa.sync_interval_minutes'] ?? 10),
        lookbackMinutes: Number(rules['coupa.lookback_minutes'] ?? 15),
      },
      status,
      counts,
    });
  }));

  r.put('/api/v1/admin/coupa/config', role('admin', async (req, res, ctx) => {
    const bdy = (req.body ?? {}) as { enabled?: unknown; intervalMinutes?: unknown };
    const enabled = bdy.enabled === true;
    // The backend owns the clamp: the PRD requirement is 5-10 minutes, the
    // panel offers 5-60; anything outside is corrected, not rejected.
    const interval = Math.min(Math.max(Number(bdy.intervalMinutes ?? 10) || 10, 5), 60);
    const today = new Date().toISOString().slice(0, 10);
    for (const [key, value] of [
      ['coupa.sync_enabled', enabled],
      ['coupa.sync_interval_minutes', interval],
    ] as const) {
      await query(
        `INSERT INTO app.rule_config (rule_key, rule_value, effective_from, note, created_by)
         VALUES ($1, $2::jsonb, $3, 'Coupa panel', $4)
         ON CONFLICT (rule_key, effective_from)
           DO UPDATE SET rule_value = EXCLUDED.rule_value, note = EXCLUDED.note, created_by = EXCLUDED.created_by`,
        [key, JSON.stringify(value), today, ctx.principal.userId],
      );
    }
    await recordAudit({
      action: 'admin.coupa.config', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success',
      detail: { enabled, intervalMinutes: interval }, ip: req.ip,
    });
    res.json({ enabled, intervalMinutes: interval });
  }));

  r.post('/api/v1/admin/coupa/sync', role('steward', async (req, res, ctx) => {
    const out = await runCoupaSync('manual');
    await recordAudit({
      action: 'coupa.sync', actorUserId: ctx.principal.userId, actorEmail: ctx.principal.email,
      outcome: out.outcome === 'error' ? 'failure' : 'success',
      detail: {
        outcome: out.outcome,
        objects: out.objects.map((o) => ({ object: o.object, status: o.status, rows: o.rowsUpserted })),
      },
      ip: req.ip,
    });
    res.json(out);
  }));

  // The Coupa tab's data: sourcing + invoice/payment aggregates WITH the rows
  // behind them in one payload. Figures and their rows travel together until
  // Coupa grains join the drill-token machinery (C4b).
  r.get('/api/v1/coupa/summary', role('analyst', async (_req, res) => {
    const [sourcing] = await query<Record<string, unknown>>(
      `SELECT count(*)::int AS events,
              count(*) FILTER (WHERE state NOT IN ('complete','canceled','template'))::int AS open_events,
              count(*) FILTER (WHERE state = 'complete')::int AS completed,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (end_time - submit_time))/86400.0)
                FILTER (WHERE submit_time IS NOT NULL AND end_time IS NOT NULL) AS median_cycle_days
         FROM ops.coupa_sourcing_event WHERE state <> 'template'`,
    );
    const [responses] = await query<Record<string, unknown>>(
      `SELECT count(*)::int AS responses,
              count(DISTINCT quote_request_id)::int AS events_with_bids,
              round(count(*)::numeric / NULLIF(count(DISTINCT quote_request_id), 0), 1) AS avg_bids_per_event
         FROM ops.coupa_supplier_response WHERE state = 'submitted'`,
    );
    const [invoice] = await query<Record<string, unknown>>(
      `SELECT count(*)::int AS invoices,
              count(*) FILTER (WHERE paid)::int AS paid_count,
              count(*) FILTER (WHERE NOT paid AND status NOT IN ('voided','draft'))::int AS open_count,
              sum(gross_total) FILTER (WHERE NOT paid AND status NOT IN ('voided','draft') AND currency = 'IDR') AS open_idr,
              count(DISTINCT currency)::int AS currencies
         FROM ops.coupa_invoice`,
    );
    const [linkage] = await query<Record<string, unknown>>(
      `SELECT count(*)::int AS coupa_po_lines,
              count(*) FILTER (WHERE sap_po_no IS NOT NULL)::int AS with_sap_po,
              count(*) FILTER (WHERE need_by_date IS NOT NULL)::int AS with_need_by
         FROM ops.coupa_po_line`,
    );
    const recentEvents = await query(
      `SELECT id, event_type, state, description, submit_time, end_time, plant, purch_org, sap_pr_no,
              supplier_count, line_count
         FROM ops.coupa_sourcing_event WHERE state <> 'template'
        ORDER BY updated_at DESC NULLS LAST LIMIT 25`,
    );
    const recentInvoices = await query(
      `SELECT i.id, i.invoice_number, i.invoice_date, i.status, i.paid, i.payment_date,
              i.gross_total, i.currency, i.supplier_name, i.payment_term,
              (SELECT count(*) FROM ops.coupa_invoice_line l WHERE l.invoice_id = i.id)::int AS lines
         FROM ops.coupa_invoice i
        ORDER BY i.updated_at DESC NULLS LAST LIMIT 25`,
    );
    const wm = await query(
      `SELECT object, last_updated_at, last_run_at, last_status FROM ops.coupa_watermark ORDER BY object`,
    );
    res.json({
      configured: coupaConfigured(),
      sourcing, responses, invoice, linkage, recentEvents, recentInvoices, watermarks: wm,
    });
  }));

  // ── G5.1: static HTML snapshot (v1's Save & Share) ───────────────────────
  //
  // Server-rendered from the published mart under the CALLER's data scope, so
  // a forwarded file can never show more than its creator was allowed to see.
  // Static by design: no drills, no tokens, a visible "snapshot" stamp.

  r.get('/api/v1/snapshot', role('analyst', async (_req, res, ctx) => {
    const v = await version();
    const esc = (x: unknown) =>
      String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const kpis = await query<Record<string, unknown>>(
      `SELECT kpi_id, status, value_num AS value, numerator, denominator, sample_size, unit, status_reason
         FROM mart.kpi_value WHERE dataset_version_id = $1 AND company_code = '*' ORDER BY kpi_id`,
      [v.id],
    );
    const charts = await query<Record<string, unknown>>(
      `SELECT chart_id, bucket_label, value_num, row_count
         FROM mart.chart_series WHERE dataset_version_id = $1 AND company_code = '*'
        ORDER BY chart_id, bucket_ordinal`,
      [v.id],
    );

    const byChart = new Map<string, Record<string, unknown>[]>();
    for (const c of charts) {
      const id = String(c['chart_id']);
      if (!byChart.has(id)) byChart.set(id, []);
      byChart.get(id)!.push(c);
    }

    const fmt = (val: unknown, unit: unknown): string => {
      if (val === null || val === undefined) return '&mdash;';
      const n2 = Number(val);
      if (unit === 'percent') return `${n2.toFixed(1)}%`;
      if (unit === 'usd') return `$${Math.round(n2).toLocaleString('en-US')}`;
      if (unit === 'idr') return `${(n2 / 1e9).toFixed(2)} B IDR`;
      if (unit === 'days') return `${n2.toFixed(0)} d`;
      if (unit === 'ratio') return n2.toFixed(2);
      return Math.round(n2).toLocaleString('en-US');
    };

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Procurement Control Tower — snapshot v${v.id}</title>
<style>
 body{font:14px/1.5 "Segoe UI",Arial,sans-serif;color:#1c2126;background:#fafaf8;margin:2rem auto;max-width:1100px;padding:0 1rem}
 h1{font-size:1.3rem}h2{font-size:1rem;margin-top:1.6rem;border-top:1px solid #ddd;padding-top:.8rem}
 .stamp{background:#f7efdd;border:1px solid #e2d9c2;border-radius:6px;padding:.5rem .8rem;font-size:.85rem;margin:.8rem 0}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:.6rem}
 .kpi{background:#fff;border:1px solid #e2e2dc;border-radius:8px;padding:.5rem .7rem}
 .kpi .v{font-size:1.2rem;font-weight:650}.kpi .l{font-size:.78rem;color:#5d6570}
 table{border-collapse:collapse;font-size:.8rem;width:100%;background:#fff}
 td,th{border:1px solid #e2e2dc;padding:.25rem .5rem;text-align:left}
 td.n{text-align:right;font-variant-numeric:tabular-nums}
</style></head><body>
<h1>Procurement Control Tower &mdash; static snapshot</h1>
<div class="stamp"><strong>Snapshot</strong> of dataset v${v.id} (as of ${esc(v.asOfDate)}), generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC
 for ${esc(ctx.principal.email)} under their data scope. Figures are frozen; nothing here drills or refreshes.
 Disabled figures render as &mdash; with their reason, never as 0.</div>
<h2>KPIs (${kpis.length})</h2>
<div class="grid">
${kpis.map((k) => `<div class="kpi"><div class="v">${k['status'] === 'ok' ? fmt(k['value'], k['unit']) : '&mdash;'}</div>
<div class="l">${esc(k['kpi_id'])}${k['status'] !== 'ok' ? ` &middot; ${esc(k['status_reason'] ?? k['status'])}` : ''}</div></div>`).join('\n')}
</div>
${[...byChart.entries()].map(([id, rows]) => `<h2>${esc(id)}</h2>
<table><tr><th>Bucket</th><th>Value</th><th>Rows</th></tr>
${rows.map((r2) => `<tr><td>${esc(r2['bucket_label'])}</td><td class="n">${r2['value_num'] === null ? '&mdash;' : Number(r2['value_num']).toLocaleString('en-US')}</td><td class="n">${Number(r2['row_count']).toLocaleString('en-US')}</td></tr>`).join('\n')}
</table>`).join('\n')}
</body></html>`;

    await recordAudit({
      action: 'snapshot.export', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success',
      detail: { datasetVersionId: v.id }, ip: _req.ip,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pct-snapshot-v${v.id}.html"`);
    res.send(html);
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
