/**
 * Business-rule configuration — PRD §12, decisions D1-D3.
 *
 * Values are administrator-editable at runtime with an effective date and an
 * author. Each dataset version stores the snapshot in force when it was built,
 * so editing a threshold never changes a figure that has already been published.
 */

import { query } from '../../db/client.js';

export type RuleSnapshot = Record<string, unknown>;

export const RULE_DEFAULTS: RuleSnapshot = {
  'wbs.material_threshold_idr': 30_000_000,
  'wbs.service_threshold_idr': 150_000_000,
  'wbs.basis': 'per_item',
  'sto.doctype_suffix': '70',
  'aging.threshold_days': 60,
  'fx.policy': 'period_matched',
  'release.no_strategy_policy': 'flag_only',
  'asof.source': 'data_max',
  'freshness.ageing_days': 3,
  'freshness.stale_days': 7,
  'kpi.min_sample': 30,
  // Scheduled share-folder ingest. Admin-configurable at runtime; the env
  // values are only the initial defaults (SHARE_PATH is still env-only,
  // because the container has to be able to see the mount).
  'ingest.autopoll_enabled': false,
  'ingest.poll_interval_minutes': 30,
  'ingest.file_patterns': [],
  // Coupa poller (TECH_04 §3.4). Credentials are env-only, never here.
  'coupa.sync_enabled': false,
  'coupa.sync_interval_minutes': 10,
  'coupa.lookback_minutes': 15,
  'coupa.page_limit': 50,
};

/**
 * The rules in force on a given date: the latest row per key whose
 * effective_from is on or before that date.
 */
export async function loadRuleSnapshot(onDate?: string): Promise<RuleSnapshot> {
  const asOf = onDate ?? new Date().toISOString().slice(0, 10);
  const rows = await query<{ rule_key: string; rule_value: unknown; effective_from: string }>(
    `SELECT DISTINCT ON (rule_key) rule_key, rule_value, effective_from
       FROM app.rule_config
      WHERE effective_from <= $1::date
      ORDER BY rule_key, effective_from DESC`,
    [asOf],
  );

  const snapshot: RuleSnapshot = { ...RULE_DEFAULTS };
  for (const r of rows) snapshot[r.rule_key] = r.rule_value;
  // Recorded so the UI can show "effective <date>" next to affected figures.
  snapshot['_effectiveFrom'] = rows.reduce<string | null>(
    (max, r) => (max === null || r.effective_from > max ? r.effective_from : max),
    null,
  );
  return snapshot;
}

export async function listRuleHistory(ruleKey: string) {
  return query(
    `SELECT rc.rule_key, rc.rule_value, rc.effective_from, rc.note, rc.created_at, u.email AS created_by
       FROM app.rule_config rc
       LEFT JOIN app.app_user u ON u.id = rc.created_by
      WHERE rc.rule_key = $1
      ORDER BY rc.effective_from DESC`,
    [ruleKey],
  );
}

export async function setRule(
  ruleKey: string,
  value: unknown,
  effectiveFrom: string,
  note: string | null,
  userId: string | null,
): Promise<void> {
  if (!(ruleKey in RULE_DEFAULTS)) {
    throw new Error(`unknown rule key: ${ruleKey}`);
  }
  await query(
    `INSERT INTO app.rule_config (rule_key, rule_value, effective_from, note, created_by)
     VALUES ($1, $2::jsonb, $3::date, $4, $5)
     ON CONFLICT (rule_key, effective_from)
       DO UPDATE SET rule_value = EXCLUDED.rule_value, note = EXCLUDED.note, created_by = EXCLUDED.created_by`,
    [ruleKey, JSON.stringify(value), effectiveFrom, note, userId],
  );
}

/** Human label for the WBS threshold in force. Must appear wherever the number does. */
export function wbsLabel(rules: RuleSnapshot): string {
  const mat = Number(rules['wbs.material_threshold_idr']) / 1_000_000;
  const svc = Number(rules['wbs.service_threshold_idr']) / 1_000_000;
  const basis = rules['wbs.basis'] === 'per_item' ? 'per item' : 'per PR total';
  const eff = rules['_effectiveFrom'] ? ` · effective ${rules['_effectiveFrom']}` : '';
  return `≥ IDR ${mat}M material / ≥ IDR ${svc}M service · ${basis}${eff}`;
}
