/**
 * Renamed section and card titles (039).
 *
 * Every page asks for the whole set - it is a few dozen short rows at most -
 * and re-asks on a timer, so a rename by an Admin reaches everyone else's open
 * page within the poll interval without a reload. `version` is the newest
 * change's time, so a page can tell that nothing moved.
 */

import { exec, query } from '../../db/client.js';

export class LabelError extends Error {}

const MAX_KEY = 300;
const MAX_LABEL = 200;

export interface LabelSet {
  labels: Record<string, string>;
  /** ISO time of the newest change, or null when nothing is renamed. */
  version: string | null;
}

export async function listLabels(): Promise<LabelSet> {
  const rows = await query<{ label_key: string; label: string; updated_at: string }>(
    `SELECT label_key, label, updated_at FROM app.ui_label`,
  );
  let version: string | null = null;
  for (const r of rows) {
    const t = new Date(r.updated_at).toISOString();
    if (version === null || t > version) version = t;
  }
  return { labels: Object.fromEntries(rows.map((r) => [r.label_key, r.label])), version };
}

/** Collapse whitespace and refuse control characters; titles are one line. */
function clean(v: unknown, max: number, what: string): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (s === '') throw new LabelError(`${what} is empty`);
  if (s.length > max) throw new LabelError(`${what} is longer than ${max} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new LabelError(`${what} contains control characters`);
  return s;
}

export async function setLabel(
  key: unknown, label: unknown, defaultText: unknown, actor: string,
): Promise<{ key: string; label: string }> {
  const k = clean(key, MAX_KEY, 'The title key');
  const l = clean(label, MAX_LABEL, 'The title');
  const d = defaultText === undefined || defaultText === null ? null
    : String(defaultText).replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL) || null;
  // Renaming a title back to its built-in text is a reset, not a rename.
  if (d !== null && l === d) {
    await exec(`DELETE FROM app.ui_label WHERE label_key = $1`, [k]);
    return { key: k, label: l };
  }
  await exec(
    `INSERT INTO app.ui_label (label_key, label, default_text, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (label_key) DO UPDATE
       SET label = EXCLUDED.label,
           default_text = COALESCE(EXCLUDED.default_text, app.ui_label.default_text),
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [k, l, d, actor],
  );
  return { key: k, label: l };
}

export async function resetLabel(key: unknown): Promise<boolean> {
  const k = clean(key, MAX_KEY, 'The title key');
  return (await exec(`DELETE FROM app.ui_label WHERE label_key = $1`, [k])) > 0;
}
