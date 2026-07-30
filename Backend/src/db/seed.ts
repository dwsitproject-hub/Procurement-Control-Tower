/**
 * Seed data: roles, movement-type register, notification events, rule config,
 * template contracts, chart metadata, and a local development admin.
 *
 * Idempotent — safe to re-run.
 */

import argon2 from 'argon2';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './client.js';
import { loadEnv } from '../config/env.js';
import { TEMPLATE_CONTRACTS } from '../modules/ingest/contracts.js';
import { CHART_META } from '../modules/analytics/charts.js';

const env = loadEnv();

async function seedRoles(): Promise<void> {
  await pool.query(`
    INSERT INTO app.role (code, name, rank) VALUES
      ('viewer','Viewer',10), ('analyst','Analyst',20), ('manager','Manager',30),
      ('auditor','Auditor',40), ('steward','Data Steward',50), ('admin','Administrator',90)
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, rank = EXCLUDED.rank
  `);
}

/**
 * Movement-type register — Annex A §A.6.1.
 * An unregistered type is a BLOCKER at ingest; nothing is ever guessed.
 */
async function seedMovementTypes(): Promise<void> {
  await pool.query(`
    INSERT INTO core.dim_movement_type (movement_type, class, sign_factor, counts_as_receipt, description) VALUES
      ('101','receipt',            1, true,  'Goods receipt against purchase order'),
      ('102','reversal',          -1, true,  'Reversal of goods receipt'),
      ('122','reversal',          -1, true,  'Return delivery (registered; absent from reference data)'),
      ('641','transfer',           1, false, 'Transfer posting to stock in transit (STO)'),
      ('642','transfer_reversal', -1, false, 'Reversal of transfer to stock in transit')
    ON CONFLICT (movement_type) DO UPDATE
      SET class = EXCLUDED.class, sign_factor = EXCLUDED.sign_factor,
          counts_as_receipt = EXCLUDED.counts_as_receipt, description = EXCLUDED.description
  `);
}

async function seedNotificationEvents(): Promise<void> {
  await pool.query(`
    INSERT INTO app.notification_event (code, name, severity, admin_only, description) VALUES
      ('data.published',              'New data published',     'info',    false, 'A new dataset version became active'),
      ('data.published.with_caveats', 'Published with caveats', 'warning', false, 'Published while CAVEAT findings are active'),
      ('ingest.failed',               'Ingestion failed',       'error',   true,  'A batch reached FAILED'),
      ('ingest.template_drift',       'Template drift detected','error',   true,  'A required column was unresolvable or unexpected columns appeared'),
      ('ingest.incomplete_bundle',    'Incomplete file bundle', 'warning', true,  'A poll found a partial file set'),
      ('ingest.stalled',              'Ingestion stalled',      'error',   true,  'Bundle incomplete for N consecutive cycles'),
      ('ingest.source_unavailable',   'Source unavailable',     'error',   true,  'Share folder unreachable'),
      ('data.stale',                  'Data is stale',          'warning', false, 'as-of date older than the stale threshold'),
      ('data.rolled_back',            'Dataset rolled back',    'warning', true,  'An administrator rolled back a version')
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, severity = EXCLUDED.severity
  `);
}

/**
 * Rule configuration. These are the values decisions D1-D3 settled.
 * Administrators edit them at runtime; this only bootstraps.
 */
async function seedRuleConfig(): Promise<void> {
  const rules: Array<[string, unknown, string]> = [
    ['wbs.material_threshold_idr', 30_000_000, 'D1 — admin-editable at runtime'],
    ['wbs.service_threshold_idr', 150_000_000, 'D1 — admin-editable at runtime'],
    ['wbs.basis', 'per_item', 'D1 resolved 30 Jul 2026'],
    ['sto.doctype_suffix', '70', 'Exactly ends-with'],
    ['aging.threshold_days', 60, ''],
    ['fx.policy', 'period_matched', 'D3 resolved 30 Jul 2026'],
    ['release.no_strategy_policy', 'flag_only', 'D2 resolved 30 Jul 2026'],
    ['asof.source', 'data_max', ''],
    ['freshness.ageing_days', 3, ''],
    ['freshness.stale_days', 7, ''],
    ['kpi.min_sample', 30, ''],
  ];

  for (const [key, value, note] of rules) {
    await pool.query(
      `INSERT INTO app.rule_config (rule_key, rule_value, effective_from, note)
       VALUES ($1, $2::jsonb, DATE '2026-01-01', $3)
       ON CONFLICT (rule_key, effective_from) DO NOTHING`,
      [key, JSON.stringify(value), note],
    );
  }
}

/**
 * Template contracts. Files are classified by header signature, never by
 * filename — the reference filenames embed a date range that changes every refresh.
 */
async function seedTemplates(): Promise<void> {
  for (const contract of TEMPLATE_CONTRACTS) {
    const existing = await pool.query<{ id: string }>(
      'SELECT id FROM app.template_version WHERE feed = $1 AND version = 1',
      [contract.feed],
    );

    let versionId: string;
    if (existing.rows.length > 0) {
      versionId = existing.rows[0]!.id;
      await pool.query('DELETE FROM app.template_column WHERE template_version_id = $1', [versionId]);
      await pool.query('DELETE FROM app.template_alias WHERE template_version_id = $1', [versionId]);
    } else {
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO app.template_version (feed, version, is_active, note)
         VALUES ($1, 1, true, $2) RETURNING id`,
        [contract.feed, contract.note ?? null],
      );
      versionId = ins.rows[0]!.id;
    }

    for (const [i, col] of contract.columns.entries()) {
      await pool.query(
        `INSERT INTO app.template_column
           (template_version_id, ordinal, header, header_norm, data_type, status, canonical_field, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (template_version_id, header_norm) DO NOTHING`,
        [versionId, i + 1, col.header, col.headerNorm, col.type, col.status, col.field ?? null, col.notes ?? null],
      );
    }

    for (const alias of contract.aliases ?? []) {
      await pool.query(
        `INSERT INTO app.template_alias (template_version_id, canonical_field, alias_norm)
         VALUES ($1,$2,$3) ON CONFLICT (template_version_id, alias_norm) DO NOTHING`,
        [versionId, alias.field, alias.aliasNorm],
      );
    }
  }
}

async function seedChartMeta(): Promise<void> {
  for (const c of CHART_META) {
    await pool.query(
      `INSERT INTO mart.chart_meta (chart_id, title, tab, grain, unit, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (chart_id) DO UPDATE
         SET title = EXCLUDED.title, tab = EXCLUDED.tab, grain = EXCLUDED.grain,
             unit = EXCLUDED.unit, notes = EXCLUDED.notes`,
      [c.chartId, c.title, c.tab, c.grain, c.unit, c.notes ?? []],
    );
  }
}

/**
 * Development admin. Local auth only — the DWS Hub is unreachable from a laptop.
 *
 * In production LOCAL_AUTH_REQUIRE_MFA is enforced at boot and break-glass
 * accounts require documented approval and an expiry date.
 */
async function seedDevAdmin(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    process.stdout.write('  skipping dev admin (NODE_ENV=production)\n');
    return;
  }

  const email = 'admin@energi-up.com';
  const password = 'ChangeMe!Local2026';

  const existing = await pool.query<{ id: string }>('SELECT id FROM app.app_user WHERE email = $1', [
    email,
  ]);
  if (existing.rows.length > 0) {
    process.stdout.write(`  dev admin already present: ${email}\n`);
    return;
  }

  const ins = await pool.query<{ id: string }>(
    `INSERT INTO app.app_user (email, display_name, auth_method, is_active)
     VALUES ($1, $2, 'local', true) RETURNING id`,
    [email, 'Local Administrator'],
  );
  const userId = ins.rows[0]!.id;

  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });

  await pool.query(
    `INSERT INTO app.local_credential (user_id, password_hash, mfa_enabled, approval_note)
     VALUES ($1, $2, false, 'Local development seed')`,
    [userId, hash],
  );

  await pool.query(
    `INSERT INTO app.user_role (user_id, role_code) VALUES ($1,'admin'), ($1,'steward')`,
    [userId],
  );

  // Full scope for local development. In production, granting '*' is an audited
  // privilege requiring a justification.
  await pool.query(
    `INSERT INTO app.data_scope (user_id, company_code, plant, purch_org) VALUES ($1,'*','*','*')`,
    [userId],
  );

  process.stdout.write(`  dev admin created: ${email} / ${password}\n`);
}

export async function seed(): Promise<void> {
  process.stdout.write('Seeding reference data…\n');
  await seedRoles();
  await seedMovementTypes();
  await seedNotificationEvents();
  await seedRuleConfig();
  await seedTemplates();
  await seedChartMeta();
  await seedDevAdmin();
  process.stdout.write('Seed complete.\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  seed()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      process.stderr.write(`SEED FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
