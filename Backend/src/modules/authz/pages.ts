/**
 * Per-page access resolution — User Access (migration 011).
 *
 * A user's effective access to a page is the MOST PERMISSIVE of the grants for
 * their job role and their department. Granting on either dimension therefore
 * works, and neither silently blocks the other; anything ungranted is 'none'
 * (deny by default). Holders of the `admin` capability tier always get 'edit'
 * everywhere, so a matrix edit can never lock the last administrator out.
 */

import { PAGE_KEYS, ROLE_RANK, type PageAccess, type PageKey, type Role } from '@pct/contracts';
import { query, queryOne } from '../../db/client.js';

const RANK: Record<PageAccess, number> = { none: 0, view: 1, edit: 2 };

function higher(a: PageAccess, b: PageAccess): PageAccess {
  return RANK[a] >= RANK[b] ? a : b;
}

export type PageMap = Partial<Record<PageKey, PageAccess>>;

/** Every page at 'edit' — the administrator's map. */
function allEdit(): PageMap {
  const out: PageMap = {};
  for (const k of PAGE_KEYS) out[k] = 'edit';
  return out;
}

export async function resolvePages(
  userId: string,
  roles: readonly Role[],
): Promise<PageMap> {
  const rank = Math.max(...roles.map((r) => ROLE_RANK[r] ?? 0), 0);
  if (rank >= ROLE_RANK.admin) return allEdit();

  const u = await queryOne<{ department: string | null; job_role: string | null }>(
    `SELECT department, job_role FROM app.app_user WHERE id = $1`,
    [userId],
  );
  if (!u) return {};

  const rows = await query<{ page_key: string; access: PageAccess }>(
    `SELECT page_key, access FROM app.page_permission
      WHERE (subject_kind = 'job_role'   AND subject_code = $1)
         OR (subject_kind = 'department' AND subject_code = $2)`,
    [u.job_role ?? '', u.department ?? ''],
  );

  const out: PageMap = {};
  for (const r of rows) {
    if (!(PAGE_KEYS as readonly string[]).includes(r.page_key)) continue;
    const k = r.page_key as PageKey;
    out[k] = higher(out[k] ?? 'none', r.access);
  }
  return out;
}

/** Does this map allow at least `need` on `page`? */
export function allows(pages: PageMap, page: PageKey, need: 'view' | 'edit'): boolean {
  return RANK[pages[page] ?? 'none'] >= RANK[need];
}
