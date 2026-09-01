/**
 * W3/W6/W7 routes — entity views, steward tooling, custom builder.
 *
 * Split from routes.ts to keep each file reviewable. Same conventions: every
 * route declares its role, scope applies in the data layer, problems are RFC
 * 9457, and nothing user-supplied reaches SQL as text.
 */

import type { Router } from 'express';
import { PAGE_ACCESS, PAGE_KEYS } from '@pct/contracts';
import argon2 from 'argon2';
import { queryOne, query } from '../db/client.js';
import { recordAudit } from '../modules/audit/audit.js';
import { issueDrillToken, type DrillPredicate } from '../modules/analytics/drill.js';
import { sessionFingerprint } from '../modules/auth/session.js';
import {
  approverBottlenecks, materialDetail, materialGroupPage, requisitionerDemand,
  topMaterialsSpend, vendorDetail, vendorList, vendorPivot, vendorPivotMaterials, vendorOtdChart,
} from '../modules/analytics/entity.js';
import {
  coupaExclusionOptions, exclusionOptions, fxTable, loadExclusions, mappingStatus,
  saveExclusions, saveMapping,
} from '../modules/admin/steward.js';
import {
  computeCustomChart, computeCustomKpi, customVocabulary, validateSpec,
  type CustomChartSpec, type CustomKpiSpec,
} from '../modules/analytics/custom.js';
import type { Feed } from '@pct/contracts';
import { coupaConfigured, coupaHost } from '../modules/coupa/client.js';
import { COUPA_OBJECTS, coupaSyncInFlight, notifyCoupaErrors, runCoupaSync } from '../modules/coupa/sync.js';
import { loadRuleSnapshot } from '../modules/admin/rules.js';
import { isEmail, loadNotifyConfig, notify, recentNotifications } from '../modules/notify/mailer.js';
import { loadMasterPage, masterIndex } from '../modules/analytics/master.js';
import { testBody } from '../modules/notify/messages.js';
import {
  FEED_META, loadShareConfig, nowInZone, recentSlotRuns, scanShare, shareLastArchive,
  shareLastResult,
} from '../modules/ingest/share_poller.js';
import { loadEnv } from '../config/env.js';
import { storageBasePath, storageHealth } from '../config/storage.js';

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

/**
 * The folder the container resolved from its environment — informational, not
 * editable: an admin cannot arrange a mount from a web form.
 */
function shareEnvPath(): string {
  return storageBasePath(loadEnv());
}

/** Argon2id with the same parameters as the seeder and the login path. */
async function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}

export function mountExtraRoutes(r: Router, h: RouteHelpers): void {
  const { role, requireScope, currentVersion, HttpProblem } = h;

  const version = async () => {
    const v = await currentVersion();
    if (!v) throw new HttpProblem(404, 'not-found', 'No published dataset');
    return v;
  };

  // ── Master data (31 Aug 2026) ────────────────────────────────────────────
  //
  // Reference code lists, one page per master. `viewer` rather than `analyst`
  // because these are the least sensitive data in the system — a plant list
  // says which plants exist, not what was bought at them — and every figure
  // derived from them stays scoped exactly as it was. The Master tab itself is
  // gated by the page-permission matrix like every other page.

  r.get('/api/v1/master', role('viewer', async (_req, res) => {
    const v = await version();
    res.json({ datasetVersionId: v.id, pages: await masterIndex(v.id) });
  }));

  r.get('/api/v1/master/:id', role('viewer', async (req, res) => {
    const v = await version();
    const q = String((req.query as Record<string, unknown>)['q'] ?? '');
    // The id selects a fixed query from the registry; it never reaches SQL, so
    // an unknown id is a 404 rather than a malformed statement.
    const page = await loadMasterPage(String(req.params.id), v.id, q);
    if (!page) throw new HttpProblem(404, 'not-found', `No master data called "${String(req.params.id)}"`);
    res.json({ datasetVersionId: v.id, ...page });
  }));

  // ── W3: entity views ─────────────────────────────────────────────────────

  r.get('/api/v1/entity/vendors', role('analyst', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    const out = await vendorList(
      v.id,
      ctx.scope,
      String(req.query.q ?? ''),
      Math.min(Number(req.query.limit ?? 50), 200),
      Math.max(Number(req.query.offset ?? 0), 0),
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

  // ── Notifications: recipients, event toggles, log, test send ──────────────
  //
  // The SMTP server and its password come from the environment (a password must
  // never live in a table an API can read); everything an operator changes day
  // to day lives in rule_config.

  r.get('/api/v1/admin/notify', role('steward', async (_req, res) => {
    const cfg = await loadNotifyConfig();
    res.json({ ...cfg, recent: await recentNotifications(15) });
  }));

  r.put('/api/v1/admin/notify', role('admin', async (req, res, ctx) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(b['recipients'])
      ? (b['recipients'] as unknown[]).map(String)
      : String(b['recipients'] ?? '').split(/[,;\s]+/);
    const recipients: string[] = [];
    for (const one of raw.map((x) => x.trim()).filter(Boolean)) {
      if (!isEmail(one)) throw new HttpProblem(400, 'invalid-body', `Not a valid email: ${one}`);
      if (!recipients.includes(one)) recipients.push(one);
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const [key, value] of [
      ['notify.recipients', recipients],
      ['notify.on_ingest_success', b['onIngestSuccess'] === true],
      ['notify.on_ingest_failure', b['onIngestFailure'] === true],
      ['notify.on_coupa_error', b['onCoupaError'] === true],
    ] as const) {
      await query(
        `INSERT INTO app.rule_config (rule_key, rule_value, effective_from, note, created_by)
         VALUES ($1, $2::jsonb, $3, 'Notifications panel', $4)
         ON CONFLICT (rule_key, effective_from)
           DO UPDATE SET rule_value = EXCLUDED.rule_value, note = EXCLUDED.note,
                         created_by = EXCLUDED.created_by`,
        [key, JSON.stringify(value), today, ctx.principal.userId],
      );
    }
    await recordAudit({
      action: 'admin.notify.config', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success',
      detail: { recipients, ...b }, ip: req.ip,
    });
    res.json(await loadNotifyConfig());
  }));

  // Test send: goes to the saved recipients (or an address supplied for the
  // test) and ignores the event toggles, since the point is to prove delivery.
  r.post('/api/v1/admin/notify/test', role('admin', async (req, res, ctx) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const one = String(b['to'] ?? '').trim();
    if (one !== '' && !isEmail(one)) {
      throw new HttpProblem(400, 'invalid-body', `Not a valid email: ${one}`);
    }
    const m = testBody();
    const out = await notify('test', m.subject, m.body, {
      to: one === '' ? undefined : [one],
      ignoreToggles: true,
    });
    await recordAudit({
      action: 'admin.notify.test', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      outcome: out.status === 'sent' ? 'success' : 'failure',
      detail: { status: out.status, reason: out.reason, recipients: out.recipients }, ip: req.ip,
    });
    res.json(out);
  }));

  // ── SAP Data Sync: the scheduled share-folder ingest ─────────────────────
  //
  // The env vars for this existed from the start but nothing read them, so the
  // "auto sync" never ran. Settings now live in rule_config and the poller
  // re-reads them every tick, so a change takes effect without a restart.

  /**
   * The full panel payload. Shared by the GET and the PUT deliberately: when the
   * PUT answered with only the stored config, a client that used the response as
   * its new state silently lost `storage` — and the panel, which reads
   * storage.basePath while rendering, threw and blanked the page on Save.
   */
  const ingestConfigPayload = async () => {
    const cfg = await loadShareConfig();
    return {
      ...cfg,
      // The mount itself is environment-level: the container must be able to
      // see the path, which an admin cannot arrange from a web form.
      envPath: shareEnvPath(),
      // Where that path comes from and whether it is really the NAS. Probing
      // here rather than trusting the configuration is the point: a missing
      // bind mount leaves a folder that looks fine and is empty.
      storage: await storageHealth(),
      nowInZone: nowInZone().hhmm,
      lastResult: shareLastResult(),
      lastArchive: shareLastArchive(),
      recentRuns: await recentSlotRuns(12),
    };
  };

  r.get('/api/v1/admin/ingest/config', role('steward', async (_req, res) => {
    res.json(await ingestConfigPayload());
  }));

  r.put('/api/v1/admin/ingest/config', role('admin', async (req, res, ctx) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const enabled = b['enabled'] === true;
    const incoming = Array.isArray(b['feeds']) ? (b['feeds'] as Record<string, unknown>[]) : [];

    const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const feeds: Record<string, unknown> = {};
    for (const meta of FEED_META) {
      const row = incoming.find((x) => String(x['feed']) === meta.feed);
      if (!row) continue;
      const path = String(row['path'] ?? '').trim();
      if (path === '') {
        throw new HttpProblem(400, 'invalid-body', `A folder is required for ${meta.label}`);
      }
      // Reject a Windows-shaped path here rather than at pickup time. The API
      // reads a LOCAL filesystem path; it never speaks SMB itself — the host
      // mounts the NAS and Docker binds it in, so this value must be the path AS
      // THE CONTAINER SEES IT. A UNC address or a drive letter used to save
      // cleanly and then fail hours later as an unexplained "not readable",
      // which is exactly how this reached us.
      //
      // The backslash is built with a char code on purpose: a literal one here
      // is a hazard every time this file is edited by a tool.
      const BACKSLASH = String.fromCharCode(92);
      const unc = path.startsWith('//') || path.startsWith(BACKSLASH);
      // A colon in second position is a drive letter; no POSIX folder starts so.
      const drive = /^[A-Za-z]:/.test(path);
      if (unc || drive) {
        throw new HttpProblem(
          400, 'invalid-body',
          `${meta.label}: "${path}" is a ${unc ? 'network (UNC)' : 'Windows'} path. `
          + 'Enter the folder as this server sees it, not the address you use from File '
          + `Explorer — the share is already mounted here, so use ${shareEnvPath()} `
          + '(the resolved folder shown on this page).',
        );
      }
      if (!path.startsWith('/')) {
        throw new HttpProblem(
          400, 'invalid-body',
          `${meta.label}: "${path}" is not an absolute folder — it must start with "/".`,
        );
      }
      const rawSlots = Array.isArray(row['slots']) ? (row['slots'] as unknown[]) : [];
      const slots: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const v = String(rawSlots[i] ?? '').trim();
        if (v !== '' && !HHMM.test(v)) {
          throw new HttpProblem(400, 'invalid-body', `${meta.label}: "${v}" is not a HH:MM time`);
        }
        slots.push(v);
      }
      feeds[meta.feed] = {
        path,
        pattern: String(row['pattern'] ?? meta.defaultPattern).trim(),
        slots,
      };
    }

    /**
     * Archive settings. The folders are validated exactly like a feed folder —
     * same reasoning, same failure to avoid: a UNC address saved here would look
     * fine and then fail at move time, long after anyone was watching.
     */
    const ab = (b['archive'] ?? {}) as Record<string, unknown>;
    const archiveEnabled = ab['enabled'] === true;
    const archiveDir = (raw: unknown, label: string, fallback: string): string => {
      const v = String(raw ?? '').trim();
      if (v === '') return fallback;
      const BACKSLASH = String.fromCharCode(92);
      if (v.startsWith('//') || v.startsWith(BACKSLASH) || /^[A-Za-z]:/.test(v)) {
        throw new HttpProblem(
          400, 'invalid-body',
          `${label}: "${v}" is a network or Windows path. Use the folder as this server sees it, `
          + `for example ${shareEnvPath()}/succeed.`,
        );
      }
      if (!v.startsWith('/')) {
        throw new HttpProblem(400, 'invalid-body', `${label}: "${v}" must start with "/".`);
      }
      return v;
    };
    const current = await loadShareConfig();
    const archive = {
      enabled: archiveEnabled,
      succeedDir: archiveDir(ab['succeedDir'], 'Succeeded folder', current.archive.succeedDir),
      failedDir: archiveDir(ab['failedDir'], 'Failed folder', current.archive.failedDir),
    };
    if (archive.succeedDir === archive.failedDir) {
      throw new HttpProblem(
        400, 'invalid-body',
        'The succeeded and failed folders must differ, otherwise a failed run is '
        + 'indistinguishable from a good one.',
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const [key, value] of [
      ['ingest.autopoll_enabled', enabled],
      ['ingest.feeds', feeds],
      ['ingest.archive_enabled', archive.enabled],
      ['ingest.archive_succeed_dir', archive.succeedDir],
      ['ingest.archive_failed_dir', archive.failedDir],
    ] as const) {
      await query(
        `INSERT INTO app.rule_config (rule_key, rule_value, effective_from, note, created_by)
         VALUES ($1, $2::jsonb, $3, 'SAP Data Sync panel', $4)
         ON CONFLICT (rule_key, effective_from)
           DO UPDATE SET rule_value = EXCLUDED.rule_value, note = EXCLUDED.note,
                         created_by = EXCLUDED.created_by`,
        [key, JSON.stringify(value), today, ctx.principal.userId],
      );
    }
    await recordAudit({
      action: 'admin.ingest.config', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success',
      detail: { enabled, feeds, archive }, ip: req.ip,
    });
    res.json(await ingestConfigPayload());
  }));

  // Preview only — reads directory metadata, never ingests. This is how an
  // admin confirms each folder, pattern and schedule before switching the
  // poller on. Scans the values in the FORM, so nothing must be saved first.
  r.post('/api/v1/admin/ingest/scan', role('steward', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cfg = await loadShareConfig();
    if (Array.isArray(b['feeds'])) {
      const incoming = b['feeds'] as Record<string, unknown>[];
      cfg.feeds = cfg.feeds.map((f) => {
        const row = incoming.find((x) => String(x['feed']) === f.feed);
        if (!row) return f;
        return {
          ...f,
          path: String(row['path'] ?? f.path).trim() || f.path,
          pattern: String(row['pattern'] ?? f.pattern),
        };
      });
    }
    const out = await scanShare(cfg);
    res.json({ ...out, timezone: cfg.timezone, nowInZone: nowInZone(cfg.timezone).hhmm });
  }));

  // ── User Access (011): users, departments, and the page matrix ───────────
  //
  // Admin-only. Every mutation is audited. A user's capability tier comes from
  // their job role (app.job_role.base_role) so the existing route guards keep
  // enforcing the four-tier model; the matrix adds per-page view/edit.

  r.get('/api/v1/admin/users', role('admin', async (_req, res) => {
    const users = await query(
      `SELECT u.id, u.email, u.display_name AS "displayName", u.department, u.job_role AS "jobRole",
              u.auth_method AS "authMethod", u.is_active AS "isActive",
              -- Whether a PASSWORD sign-in is possible, which is not implied by
              -- auth_method: a Hub-provisioned account gains one the moment an
              -- admin issues it, and an admin needs to see that state.
              EXISTS (SELECT 1 FROM app.local_credential lc WHERE lc.user_id = u.id) AS "hasPassword",
              u.must_change_password AS "mustChangePassword",
              u.last_login_at AS "lastLoginAt",
              (SELECT array_agg(ur.role_code ORDER BY ur.role_code)
                 FROM app.user_role ur WHERE ur.user_id = u.id) AS roles,
              (SELECT count(*)::int FROM app.data_scope ds WHERE ds.user_id = u.id) AS "scopeCount",
              (SELECT count(*)::int FROM app.data_scope ds
                WHERE ds.user_id = u.id AND ds.company_code = '*'
                  AND ds.plant = '*' AND ds.purch_org = '*') AS "scopeAll" 
         FROM app.app_user u ORDER BY u.display_name`,
    );
    const departments = await query(
      `SELECT code, name FROM app.department WHERE is_active ORDER BY name`,
    );
    const jobRoles = await query(
      `SELECT code, name, rank, base_role AS "baseRole" FROM app.job_role ORDER BY rank`,
    );
    const matrix = await query(
      `SELECT subject_kind AS "subjectKind", subject_code AS "subjectCode",
              page_key AS "pageKey", access
         FROM app.page_permission`,
    );
    res.json({ users, departments, jobRoles, matrix });
  }));

  r.post('/api/v1/admin/users', role('admin', async (req, res, ctx) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const email = String(b['email'] ?? '').trim().toLowerCase();
    const displayName = String(b['displayName'] ?? '').trim();
    const password = String(b['password'] ?? '');
    const department = b['department'] === undefined || b['department'] === null || b['department'] === ''
      ? null : String(b['department']);
    const jobRole = String(b['jobRole'] ?? '');

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new HttpProblem(400, 'invalid-body', 'A valid email is required');
    }
    if (displayName.length < 2) throw new HttpProblem(400, 'invalid-body', 'A name is required');
    if (password.length < 12) {
      throw new HttpProblem(400, 'invalid-body', 'The default password must be at least 12 characters');
    }
    const jr = await queryOne<{ code: string; base_role: string }>(
      `SELECT code, base_role FROM app.job_role WHERE code = $1`, [jobRole],
    );
    if (!jr) throw new HttpProblem(400, 'invalid-body', 'Unknown job role');
    if (department !== null) {
      const d = await queryOne(`SELECT code FROM app.department WHERE code = $1`, [department]);
      if (!d) throw new HttpProblem(400, 'invalid-body', 'Unknown department');
    }
    const dupe = await queryOne(`SELECT id FROM app.app_user WHERE email = $1`, [email]);
    if (dupe) throw new HttpProblem(409, 'conflict', 'A user with that email already exists');

    // must_change_password: the admin-issued default is single-use by design.
    const ins = await queryOne<{ id: string }>(
      `INSERT INTO app.app_user
         (email, display_name, auth_method, is_active, department, job_role, must_change_password)
       VALUES ($1, $2, 'local', true, $3, $4, true) RETURNING id`,
      [email, displayName, department, jr.code],
    );
    const userId = ins!.id;
    await query(
      `INSERT INTO app.local_credential (user_id, password_hash, approval_note)
       VALUES ($1, $2, 'User Access: admin-issued default, rotation forced')`,
      [userId, await hashPassword(password)],
    );
    await query(
      `INSERT INTO app.user_role (user_id, role_code) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, jr.base_role],
    );
    await recordAudit({
      action: 'admin.user.create', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success',
      detail: { userId, email, jobRole: jr.code, department, baseRole: jr.base_role },
      ip: req.ip,
    });
    // Never echo the password back.
    res.status(201).json({ id: userId, email, displayName, department, jobRole: jr.code });
  }));

  r.put('/api/v1/admin/users/:id', role('admin', async (req, res, ctx) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const id = req.params.id;
    const target = await queryOne<{ id: string; email: string; auth_method: string }>(
      `SELECT id, email, auth_method FROM app.app_user WHERE id = $1`, [id],
    );
    if (!target) throw new HttpProblem(404, 'not-found', 'No such user');

    const detail: Record<string, unknown> = {};
    if (b['displayName'] !== undefined) {
      await query(`UPDATE app.app_user SET display_name = $2 WHERE id = $1`,
        [id, String(b['displayName']).trim()]);
      detail['displayName'] = b['displayName'];
    }
    if (b['department'] !== undefined) {
      const dep = b['department'] === null || b['department'] === '' ? null : String(b['department']);
      await query(`UPDATE app.app_user SET department = $2 WHERE id = $1`, [id, dep]);
      detail['department'] = dep;
    }
    if (b['jobRole'] !== undefined) {
      const jr = await queryOne<{ code: string; base_role: string }>(
        `SELECT code, base_role FROM app.job_role WHERE code = $1`, [String(b['jobRole'])],
      );
      if (!jr) throw new HttpProblem(400, 'invalid-body', 'Unknown job role');
      await query(`UPDATE app.app_user SET job_role = $2 WHERE id = $1`, [id, jr.code]);
      // Keep the capability tier in step with the job role.
      await query(`DELETE FROM app.user_role WHERE user_id = $1`, [id]);
      await query(`INSERT INTO app.user_role (user_id, role_code) VALUES ($1, $2)`, [id, jr.base_role]);
      detail['jobRole'] = jr.code;
      detail['baseRole'] = jr.base_role;
    }
    if (b['isActive'] !== undefined) {
      const active = b['isActive'] === true;
      // Guard: never deactivate the last active administrator.
      if (!active) {
        const admins = await queryOne<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.app_user u
             JOIN app.user_role ur ON ur.user_id = u.id AND ur.role_code = 'admin'
            WHERE u.is_active AND u.id <> $1`, [id],
        );
        if ((admins?.n ?? 0) === 0) {
          throw new HttpProblem(409, 'conflict', 'This is the last active administrator');
        }
      }
      await query(`UPDATE app.app_user SET is_active = $2 WHERE id = $1`, [id, active]);
      detail['isActive'] = active;
    }
    if (typeof b['resetPassword'] === 'string' && b['resetPassword'] !== '') {
      const pw = String(b['resetPassword']);
      if (pw.length < 12) {
        throw new HttpProblem(400, 'invalid-body', 'The default password must be at least 12 characters');
      }
      await query(
        `INSERT INTO app.local_credential (user_id, password_hash, approval_note)
         VALUES ($1, $2, 'User Access: admin reset, rotation forced')
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash,
           password_set_at = now(), failed_attempts = 0, locked_until = NULL`,
        [id, await hashPassword(pw)],
      );
      await query(`UPDATE app.app_user SET must_change_password = true WHERE id = $1`, [id]);
      detail['passwordReset'] = true;
      // Worth recording explicitly: for a Hub-provisioned account this does not
      // just rotate a password, it ADDS password sign-in to an account that had
      // only SSO. The audit trail should show that decision rather than leave it
      // to be inferred.
      detail['passwordLoginEnabledFor'] = target.auth_method;
    }

    await recordAudit({
      action: 'admin.user.update', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success',
      detail: { userId: id, email: target.email, ...detail }, ip: req.ip,
    });
    res.json({ ok: true });
  }));

  // Data scope: a new user has NONE by design (deny by default), so the
  // registration screen must be able to grant it or the account is useless.
  // '*' means every value of that dimension.
  r.put('/api/v1/admin/users/:id/scope', role('admin', async (req, res, ctx) => {
    const id = req.params.id;
    const entries = ((req.body ?? {}) as { entries?: unknown[] }).entries ?? [];
    if (!Array.isArray(entries)) throw new HttpProblem(400, 'invalid-body', 'entries[] required');
    const target = await queryOne<{ email: string }>(
      `SELECT email FROM app.app_user WHERE id = $1`, [id],
    );
    if (!target) throw new HttpProblem(404, 'not-found', 'No such user');

    // Replace the whole set: the UI always sends the intended final state.
    await query(`DELETE FROM app.data_scope WHERE user_id = $1`, [id]);
    for (const raw of entries) {
      const e = raw as Record<string, unknown>;
      await query(
        `INSERT INTO app.data_scope (user_id, company_code, plant, purch_org)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [
          id,
          String(e['companyCode'] ?? '*').trim() || '*',
          String(e['plant'] ?? '*').trim() || '*',
          String(e['purchOrg'] ?? '*').trim() || '*',
        ],
      );
    }
    await recordAudit({
      action: 'admin.user.scope', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success',
      detail: { userId: id, email: target.email, entries: entries.length }, ip: req.ip,
    });
    res.json({ ok: true, entries: entries.length });
  }));

  r.put('/api/v1/admin/page-permissions', role('admin', async (req, res, ctx) => {
    const entries = ((req.body ?? {}) as { entries?: unknown[] }).entries ?? [];
    if (!Array.isArray(entries)) throw new HttpProblem(400, 'invalid-body', 'entries[] required');

    let written = 0;
    for (const raw of entries) {
      const e = raw as Record<string, unknown>;
      const kind = String(e['subjectKind'] ?? '');
      const code = String(e['subjectCode'] ?? '');
      const page = String(e['pageKey'] ?? '');
      const access = String(e['access'] ?? '');
      if (kind !== 'job_role' && kind !== 'department') {
        throw new HttpProblem(400, 'invalid-body', `bad subjectKind: ${kind}`);
      }
      if (!(PAGE_KEYS as readonly string[]).includes(page)) {
        throw new HttpProblem(400, 'invalid-body', `unknown page: ${page}`);
      }
      if (!(PAGE_ACCESS as readonly string[]).includes(access)) {
        throw new HttpProblem(400, 'invalid-body', `bad access: ${access}`);
      }
      // The Admin page must stay reachable by the Admin job role, or the next
      // save could lock every administrator out of this very screen.
      if (kind === 'job_role' && code === 'admin' && page === 'admin' && access !== 'edit') {
        throw new HttpProblem(409, 'conflict', "The Admin role must keep 'edit' on the Admin page");
      }
      await query(
        `INSERT INTO app.page_permission (subject_kind, subject_code, page_key, access, updated_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (subject_kind, subject_code, page_key)
           DO UPDATE SET access = EXCLUDED.access, updated_at = now(),
                         updated_by = EXCLUDED.updated_by`,
        [kind, code, page, access, ctx.principal.userId],
      );
      written += 1;
    }
    await recordAudit({
      action: 'admin.page_permissions.update', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success',
      detail: { entries: written }, ip: req.ip,
    });
    res.json({ ok: true, written });
  }));

  r.post('/api/v1/admin/departments', role('admin', async (req, res, ctx) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const code = String(b['code'] ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    const name = String(b['name'] ?? '').trim();
    if (!code || !name) throw new HttpProblem(400, 'invalid-body', 'code and name are required');
    await query(
      `INSERT INTO app.department (code, name) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, is_active = true`,
      [code, name],
    );
    await recordAudit({
      action: 'admin.department.upsert', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success', detail: { code, name }, ip: req.ip,
    });
    res.status(201).json({ code, name });
  }));

  // ── v1's PO-page top-spend tables (aggregates only, so viewer role) ──
  r.get('/api/v1/entity/top-vendors-spend', role('viewer', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    const out = await vendorList(v.id, ctx.scope, '', Math.min(Number(req.query.limit ?? 10), 50));
    res.json({ datasetVersionId: v.id, totalVendors: out.totalVendors, rows: out.rows });
  }));

  r.get('/api/v1/entity/top-materials-spend', role('viewer', async (req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    const out = await topMaterialsSpend(v.id, ctx.scope, Number(req.query.limit ?? 10));
    res.json({ datasetVersionId: v.id, ...out });
  }));

  // ── v1's PR Analysis tables: approval bottlenecks + requisitioner demand ──
  r.get('/api/v1/entity/approver-bottlenecks', role('viewer', async (_req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    const out = await approverBottlenecks(v.id, ctx.scope);
    const fp = sessionFingerprint(ctx.sid);
    // v1's row click: the PIC's pending release steps.
    const rows = out.rows.map((b) => ({
      ...b,
      drillPending: issueDrillToken(
        { grain: 'pr_release', filters: { picRelease: b.pic, pending: true },
          label: `Pending PR approval · ${b.pic}` } as DrillPredicate,
        v.id, ctx.scope, fp,
      ),
    }));
    res.json({ datasetVersionId: v.id, rows });
  }));

  r.get('/api/v1/entity/requisitioner-demand', role('viewer', async (_req, res, ctx) => {
    requireScope(ctx);
    const v = await version();
    const out = await requisitionerDemand(v.id, ctx.scope);
    const fp = sessionFingerprint(ctx.sid);
    const rows = out.rows.map((q) => ({
      ...q,
      drill: issueDrillToken(
        { grain: 'pr_item', filters: { requisitioner: q.requisitioner },
          label: `Requisitioner: ${q.requisitioner}` } as DrillPredicate,
        v.id, ctx.scope, fp,
      ),
    }));
    res.json({ datasetVersionId: v.id, rows });
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
    // The mgt summary counts PR items (v1's grain), so its drills do too.
    const categories = (out['categories'] as Record<string, unknown>[]).map((c) => ({
      ...c,
      drillAll: issueDrillToken(
        { grain: 'pr_item', filters: { notDeleted: true, matCat: c['category'] }, label: `${c['category']} — all PR items` } as DrillPredicate,
        v.id, ctx.scope, fp,
      ),
      drillOpen: issueDrillToken(
        { grain: 'pr_item', filters: { notDeleted: true, matCat: c['category'], scopeOpen: true }, label: `${c['category']} — open items` } as DrillPredicate,
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
      coupaOptions: await coupaExclusionOptions(),
      note: 'Changes apply on the next recompute (Admin > Recompute), not instantly.',
      // The Coupa list is the exception and the UI says so: it is enforced by
      // views over a continuously-polled store, not by the transform, so it
      // needs no rebuild.
      coupaNote: 'Coupa purchasing-group exclusions apply immediately on save — no recompute needed.',
    });
  }));

  r.put('/api/v1/admin/exclusions', role('admin', async (req, res, ctx) => {
    const b = (req.body ?? {}) as {
      docTypes?: unknown; purchGroups?: unknown; purchOrgs?: unknown; coupaPurchGroups?: unknown;
      holdPos?: unknown; intercoVendorPrefixes?: unknown;
    };
    const list = (x: unknown, cap = 50): string[] =>
      Array.isArray(x) ? x.map(String).map((v2) => v2.trim()).filter((v2) => v2 !== '').slice(0, cap) : [];
    const next = {
      docTypes: list(b.docTypes),
      purchGroups: list(b.purchGroups),
      purchOrgs: list(b.purchOrgs),
      // A larger cap: Coupa carries far more purchasing groups than the SAP
      // facts do, and the first real request named 16 at once.
      coupaPurchGroups: list(b.coupaPurchGroups, 300),
      holdPos: b.holdPos === true || b.holdPos === 'true',
      intercoVendorPrefixes: list(b.intercoVendorPrefixes),
    };

    const before = await loadExclusions();
    await saveExclusions(next, ctx.principal.userId);
    await recordAudit({
      action: 'admin.exclusions.update', actorUserId: ctx.principal.userId,
      actorEmail: ctx.principal.email, outcome: 'success',
      detail: { before, after: next }, ip: req.ip,
    });
    // Whether a rebuild is actually needed, so the UI does not spend a minute
    // recomputing every fact when only the Coupa list moved (that list is
    // enforced by views and is live the moment it is committed).
    const sapChanged =
      JSON.stringify([before.docTypes, before.purchGroups, before.purchOrgs,
        before.holdPos, before.intercoVendorPrefixes])
      !== JSON.stringify([next.docTypes, next.purchGroups, next.purchOrgs,
        next.holdPos, next.intercoVendorPrefixes]);
    res.json({ saved: next, appliesFromNextRecompute: sapChanged, recomputeRequired: sapChanged });
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
      // RAW tables on purpose, unlike the analytics endpoints below: this is the
      // sync diagnostic. It answers "did the poller store what Coupa has", so it
      // must report everything fetched — applying data exclusions here would
      // make a working sync look like it had lost rows.
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
    // Fire-and-forget: a COLD run pages every object and can exceed any HTTP
    // timeout (nginx cuts at 300s), which made a healthy sync look failed.
    // The advisory lock inside runCoupaSync still prevents overlap, and the
    // per-object 'running' watermark lets the panel poll for progress.
    if (coupaSyncInFlight()) {
      res.json({ outcome: 'locked', trigger: 'manual', objects: [] });
      return;
    }
    void runCoupaSync('manual')
      .then(async (out) => {
        await notifyCoupaErrors('manual', out);
        await recordAudit({
          action: 'coupa.sync', actorUserId: ctx.principal.userId, actorEmail: ctx.principal.email,
          outcome: out.outcome === 'error' ? 'failure' : 'success',
          detail: {
            outcome: out.outcome,
            objects: out.objects.map((o) => ({ object: o.object, status: o.status, rows: o.rowsUpserted })),
          },
          ip: req.ip,
        });
      })
      .catch(() => undefined);
    res.status(202).json({ outcome: 'started', trigger: 'manual', objects: [] });
  }));

  // The Coupa tab's data: sourcing + invoice/payment aggregates WITH the rows
  // behind them in one payload. Figures and their rows travel together until
  // Coupa grains join the drill-token machinery (C4b).
  // ── Coupa Sourcing page (modelled on Coupa Analytics 1013/1012) ──────────
  r.get('/api/v1/coupa/sourcing', role('analyst', async (_req, res) => {
    const [kpis] = await query<Record<string, unknown>>(
      `SELECT count(*)::int AS events,
              count(*) FILTER (WHERE state NOT IN ('complete','canceled','template'))::int AS open_events,
              count(*) FILTER (WHERE state = 'complete')::int AS completed,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (end_time - submit_time))/86400.0)
                FILTER (WHERE submit_time IS NOT NULL AND end_time IS NOT NULL) AS median_cycle_days,
              sum(planned_savings) FILTER (WHERE currency = 'IDR') AS planned_savings_idr,
              count(*) FILTER (WHERE planned_savings IS NOT NULL AND currency <> 'IDR')::int AS savings_other_ccy
         FROM ops.v_coupa_sourcing_event WHERE state <> 'template'`,
    );
    const [bids] = await query<Record<string, unknown>>(
      `SELECT count(*)::int AS responses,
              count(DISTINCT quote_request_id)::int AS events_with_bids,
              count(DISTINCT supplier_name)::int AS suppliers,
              round(count(*)::numeric / NULLIF(count(DISTINCT quote_request_id), 0), 1) AS avg_bids_per_event,
              count(*) FILTER (WHERE awarded)::int AS awarded
         FROM ops.v_coupa_supplier_response WHERE state = 'submitted'`,
    );
    const eventsByMonth = await query(
      `SELECT to_char(created_at,'YYYY-MM') AS mk, count(*)::int AS events,
              count(*) FILTER (WHERE state = 'complete')::int AS completed
         FROM ops.v_coupa_sourcing_event
        WHERE state <> 'template' AND created_at IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
    );
    // Coupa's 'Spend by Commodity / Supplier and Event Type': awarded bid
    // amounts, IDR documents only (strict - other currencies are counted, not
    // converted, because the ops store has no per-line FX equivalents).
    const byCommodity = await query(
      `SELECT COALESCE(e.commodity,'(none)') AS commodity,
              count(*)::int AS awarded_bids,
              sum(r.total_amount) FILTER (WHERE COALESCE(NULLIF(r.currency,''), e.currency, 'IDR') = 'IDR') AS amount_idr,
              count(*) FILTER (WHERE COALESCE(NULLIF(r.currency,''), e.currency, 'IDR') <> 'IDR')::int AS other_ccy
         FROM ops.v_coupa_supplier_response r
         JOIN ops.v_coupa_sourcing_event e ON e.id = r.quote_request_id
        WHERE r.awarded
        GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 12`,
    );
    const bySupplier = await query(
      `SELECT r.supplier_name,
              count(*)::int AS awarded_bids,
              sum(r.total_amount) FILTER (WHERE COALESCE(NULLIF(r.currency,''), e.currency, 'IDR') = 'IDR') AS amount_idr,
              count(*) FILTER (WHERE COALESCE(NULLIF(r.currency,''), e.currency, 'IDR') <> 'IDR')::int AS other_ccy
         FROM ops.v_coupa_supplier_response r
         JOIN ops.v_coupa_sourcing_event e ON e.id = r.quote_request_id
        WHERE r.awarded AND r.supplier_name IS NOT NULL
        GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 12`,
    );
    // Coupa's Sourcing Data Table (1012), response grain.
    const dataTable = await query(
      `SELECT r.quote_request_id AS event_id, e.event_type, e.state AS event_state,
              e.commodity, left(e.description, 60) AS description, e.sap_pr_no,
              r.supplier_name, r.awarded, r.submitted_at, r.total_amount,
              COALESCE(NULLIF(r.currency,''), e.currency) AS currency
         FROM ops.v_coupa_supplier_response r
         JOIN ops.v_coupa_sourcing_event e ON e.id = r.quote_request_id
        ORDER BY r.submitted_at DESC NULLS LAST, r.quote_request_id DESC
        LIMIT 200`,
    );
    const wm = await query(
      `SELECT object, last_updated_at, last_run_at, last_status FROM ops.coupa_watermark
        WHERE object IN ('quote_requests') ORDER BY object`,
    );
    res.json({ configured: coupaConfigured(), kpis, bids, eventsByMonth, byCommodity, bySupplier, dataTable, watermarks: wm });
  }));

  // ── Coupa Invoices & Payment page (modelled on Coupa Analytics 3148) ─────
  r.get('/api/v1/coupa/invoices', role('analyst', async (_req, res) => {
    const [kpis] = await query<Record<string, unknown>>(
      `SELECT count(*)::int AS invoices,
              count(*) FILTER (WHERE paid)::int AS paid_count,
              count(*) FILTER (WHERE NOT paid AND status NOT IN ('voided','draft'))::int AS open_count,
              sum(gross_total) FILTER (WHERE NOT paid AND status NOT IN ('voided','draft') AND currency = 'IDR') AS open_idr,
              sum(gross_total) FILTER (WHERE status NOT IN ('voided','draft') AND currency = 'IDR') AS gross_idr,
              sum(tax_amount) FILTER (WHERE status NOT IN ('voided','draft') AND currency = 'IDR') AS tax_idr,
              count(*) FILTER (WHERE currency <> 'IDR')::int AS other_ccy,
              count(DISTINCT currency)::int AS currencies,
              avg((payment_date::date - invoice_date)::numeric)
                FILTER (WHERE paid AND payment_date IS NOT NULL AND invoice_date IS NOT NULL) AS avg_days_to_pay
         FROM ops.v_coupa_invoice`,
    );
    const [pay] = await query<Record<string, unknown>>(
      `SELECT count(*)::int AS payments,
              sum(p.amount_paid) FILTER (WHERE i.currency = 'IDR') AS paid_idr,
              count(*) FILTER (WHERE p.sap_payment_doc IS NOT NULL)::int AS with_sap_doc
         FROM ops.coupa_payment p
         JOIN ops.v_coupa_invoice i ON i.id = p.invoice_id`,
    );
    const invoicesByMonth = await query(
      `SELECT to_char(invoice_date,'YYYY-MM') AS mk, count(*)::int AS invoices,
              count(*) FILTER (WHERE paid)::int AS paid,
              sum(gross_total) FILTER (WHERE currency = 'IDR' AND status NOT IN ('voided','draft')) AS gross_idr
         FROM ops.v_coupa_invoice WHERE invoice_date IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
    );
    const paymentsByMonth = await query(
      `SELECT to_char(p.payment_date,'YYYY-MM') AS mk, count(*)::int AS payments,
              sum(p.amount_paid) FILTER (WHERE i.currency = 'IDR') AS paid_idr
         FROM ops.coupa_payment p
         JOIN ops.v_coupa_invoice i ON i.id = p.invoice_id
        WHERE p.payment_date IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
    );
    const statusMix = await query(
      `SELECT status, count(*)::int AS n FROM ops.v_coupa_invoice GROUP BY 1 ORDER BY 2 DESC`,
    );
    const topSuppliers = await query(
      `SELECT supplier_name, count(*)::int AS invoices,
              sum(gross_total) FILTER (WHERE currency = 'IDR' AND status NOT IN ('voided','draft')) AS gross_idr,
              count(*) FILTER (WHERE paid)::int AS paid,
              count(*) FILTER (WHERE currency <> 'IDR')::int AS other_ccy
         FROM ops.v_coupa_invoice
        WHERE supplier_name IS NOT NULL
        GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 12`,
    );
    const recentInvoices = await query(
      `SELECT i.id, i.invoice_number, i.invoice_date, i.status, i.paid, i.payment_date,
              i.gross_total, i.tax_amount, i.currency, i.supplier_name, i.payment_term,
              (SELECT count(*) FROM ops.v_coupa_invoice_line l WHERE l.invoice_id = i.id)::int AS lines
         FROM ops.v_coupa_invoice i
        ORDER BY i.invoice_date DESC NULLS LAST, i.id DESC LIMIT 50`,
    );
    const recentPayments = await query(
      `SELECT p.payment_date, p.amount_paid, p.sap_payment_doc,
              i.invoice_number, i.supplier_name, i.currency
         FROM ops.coupa_payment p
         JOIN ops.v_coupa_invoice i ON i.id = p.invoice_id
        ORDER BY p.payment_date DESC NULLS LAST LIMIT 50`,
    );
    const wm = await query(
      `SELECT object, last_updated_at, last_run_at, last_status FROM ops.coupa_watermark
        WHERE object IN ('invoices') ORDER BY object`,
    );
    res.json({
      configured: coupaConfigured(), kpis, pay, invoicesByMonth, paymentsByMonth,
      statusMix, topSuppliers, recentInvoices, recentPayments, watermarks: wm,
    });
  }));

  r.get('/api/v1/coupa/summary', role('analyst', async (_req, res) => {
    const [sourcing] = await query<Record<string, unknown>>(
      `SELECT count(*)::int AS events,
              count(*) FILTER (WHERE state NOT IN ('complete','canceled','template'))::int AS open_events,
              count(*) FILTER (WHERE state = 'complete')::int AS completed,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (end_time - submit_time))/86400.0)
                FILTER (WHERE submit_time IS NOT NULL AND end_time IS NOT NULL) AS median_cycle_days
         FROM ops.v_coupa_sourcing_event WHERE state <> 'template'`,
    );
    const [responses] = await query<Record<string, unknown>>(
      `SELECT count(*)::int AS responses,
              count(DISTINCT quote_request_id)::int AS events_with_bids,
              round(count(*)::numeric / NULLIF(count(DISTINCT quote_request_id), 0), 1) AS avg_bids_per_event
         FROM ops.v_coupa_supplier_response WHERE state = 'submitted'`,
    );
    const [invoice] = await query<Record<string, unknown>>(
      `SELECT count(*)::int AS invoices,
              count(*) FILTER (WHERE paid)::int AS paid_count,
              count(*) FILTER (WHERE NOT paid AND status NOT IN ('voided','draft'))::int AS open_count,
              sum(gross_total) FILTER (WHERE NOT paid AND status NOT IN ('voided','draft') AND currency = 'IDR') AS open_idr,
              count(DISTINCT currency)::int AS currencies
         FROM ops.v_coupa_invoice`,
    );
    const [linkage] = await query<Record<string, unknown>>(
      `SELECT count(*)::int AS coupa_po_lines,
              count(*) FILTER (WHERE sap_po_no IS NOT NULL)::int AS with_sap_po,
              count(*) FILTER (WHERE need_by_date IS NOT NULL)::int AS with_need_by
         FROM ops.v_coupa_po_line`,
    );
    const recentEvents = await query(
      `SELECT id, event_type, state, description, submit_time, end_time, plant, purch_org, sap_pr_no,
              supplier_count, line_count
         FROM ops.v_coupa_sourcing_event WHERE state <> 'template'
        ORDER BY updated_at DESC NULLS LAST LIMIT 25`,
    );
    const recentInvoices = await query(
      `SELECT i.id, i.invoice_number, i.invoice_date, i.status, i.paid, i.payment_date,
              i.gross_total, i.currency, i.supplier_name, i.payment_term,
              (SELECT count(*) FROM ops.v_coupa_invoice_line l WHERE l.invoice_id = i.id)::int AS lines
         FROM ops.v_coupa_invoice i
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
