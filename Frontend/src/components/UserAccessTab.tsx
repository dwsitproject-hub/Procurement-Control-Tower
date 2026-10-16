import { useCallback, useEffect, useState } from 'react';
import {
  JOB_ROLE_LABELS, PAGE_KEYS, PAGE_LABELS, type JobRole, type PageAccess, type PageKey,
} from '@pct/contracts';
import { api } from '../lib/api';
import { DASH, formatDateTime } from '../lib/format';

/**
 * User Access (011) — register users, set their department and job role, and
 * edit the per-page permission matrix.
 *
 * Two dimensions grant access: job role and department. A user's effective
 * access to a page is the MORE PERMISSIVE of the two, so granting on either
 * works and neither silently blocks the other. Admins always have full access.
 */

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
  jobRole: JobRole | null;
  authMethod: 'local' | 'sso';
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  roles: string[] | null;
  scopeCount: number;
  scopeAll: number;
}
interface MatrixRow {
  subjectKind: 'job_role' | 'department';
  subjectCode: string;
  pageKey: PageKey;
  access: PageAccess;
}
interface Payload {
  users: UserRow[];
  departments: { code: string; name: string }[];
  jobRoles: { code: JobRole; name: string; rank: number; baseRole: string }[];
  matrix: MatrixRow[];
}

const ACCESS_CYCLE: PageAccess[] = ['none', 'view', 'edit'];
const ACCESS_PILL: Record<PageAccess, string> = { none: 'sl', view: 'su', edit: 'sd' };

export function UserAccessTab({ section }: { section: 'users' | 'matrix' }) {
  const [d, setD] = useState<Payload | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // register form
  const [nm, setNm] = useState('');
  const [em, setEm] = useState('');
  const [pw, setPw] = useState('');
  const [dep, setDep] = useState('');
  const [jr, setJr] = useState<JobRole>('staff');

  // matrix editing buffer: only what the admin actually changed is sent
  const [pending, setPending] = useState<Record<string, PageAccess>>({});
  const [subjectKind, setSubjectKind] = useState<'job_role' | 'department'>('job_role');

  const load = useCallback(() => {
    api.get<Payload>('/api/v1/admin/users')
      .then((x) => { setD(x); setPending({}); })
      .catch((e: Error) => setMsg(e.message));
  }, []);
  useEffect(load, [load]);

  if (!d) {
    return (
      <div className="panel">
        <h2>{section === 'users' ? '👥 Users' : '🔐 Page Permission'}</h2>
        <div className="spinner" />
      </div>
    );
  }

  const register = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.post('/api/v1/admin/users', {
        displayName: nm, email: em, password: pw,
        department: dep || null, jobRole: jr,
      });
      setMsg(`Created ${em}. They must change this password at first login.`);
      setNm(''); setEm(''); setPw(''); setDep('');
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'create failed');
    } finally { setBusy(false); }
  };

  const patch = async (id: string, body: Record<string, unknown>, note: string) => {
    setBusy(true); setMsg(null);
    try {
      await api.put(`/api/v1/admin/users/${id}`, body);
      setMsg(note);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'update failed');
    } finally { setBusy(false); }
  };

  const setScope = async (id: string, entries: unknown[], note: string) => {
    setBusy(true); setMsg(null);
    try {
      await api.put(`/api/v1/admin/users/${id}/scope`, { entries });
      setMsg(note);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'scope update failed');
    } finally { setBusy(false); }
  };

  const grantSlice = async (u: UserRow) => {
    const co = window.prompt('Company code (or * for all)', '*');
    if (co === null) return;
    const pl = window.prompt('Plant (or * for all)', '*');
    if (pl === null) return;
    const po = window.prompt('Purchasing org (or * for all)', '*');
    if (po === null) return;
    await setScope(u.id, [{ companyCode: co, plant: pl, purchOrg: po }],
      `Scope set for ${u.email}: ${co} / ${pl} / ${po}.`);
  };

  const resetPassword = async (u: UserRow) => {
    const pwd = window.prompt(
      `New temporary password for ${u.email} (min 12 chars). They will be forced to change it at next login.`,
    );
    if (!pwd) return;
    await patch(u.id, { resetPassword: pwd }, `Temporary password set for ${u.email}.`);
  };

  const subjects = subjectKind === 'job_role'
    ? d.jobRoles.map((x) => ({ code: x.code as string, name: x.name }))
    : d.departments.map((x) => ({ code: x.code, name: x.name }));

  const cellKey = (code: string, page: PageKey) => `${subjectKind}|${code}|${page}`;
  const current = (code: string, page: PageKey): PageAccess => {
    const k = cellKey(code, page);
    if (pending[k]) return pending[k]!;
    const hit = d.matrix.find(
      (m) => m.subjectKind === subjectKind && m.subjectCode === code && m.pageKey === page,
    );
    return hit?.access ?? 'none';
  };
  const cycle = (code: string, page: PageKey) => {
    const now = current(code, page);
    const next = ACCESS_CYCLE[(ACCESS_CYCLE.indexOf(now) + 1) % ACCESS_CYCLE.length]!;
    setPending((p) => ({ ...p, [cellKey(code, page)]: next }));
  };

  const saveMatrix = async () => {
    const entries = Object.entries(pending).map(([k, access]) => {
      const [kind, code, pageKey] = k.split('|');
      return { subjectKind: kind, subjectCode: code, pageKey, access };
    });
    if (entries.length === 0) { setMsg('Nothing changed.'); return; }
    setBusy(true); setMsg(null);
    try {
      await api.put('/api/v1/admin/page-permissions', { entries });
      setMsg(`Saved ${entries.length} permission change(s). Users see it at their next page load.`);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'save failed');
    } finally { setBusy(false); }
  };

  return (
    <div className="panel">
      <h2>
        {section === 'users' ? '👥 Users' : '🔐 Page Permission'}{' '}
        <span className="muted">
          — {d.users.length} users · {d.departments.length} departments
        </span>
      </h2>

      {msg && <p className="note" style={{ marginTop: '.4rem' }}>{msg}</p>}

      {section === 'users' ? (
        <>
          <h3 className="pr-tbl-h">Register a new user</h3>
          <div className="dt-toolbar" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label className="cu-field">Name
              <input value={nm} onChange={(e) => setNm(e.target.value)} placeholder="Full name" />
            </label>
            <label className="cu-field">Email
              <input type="email" value={em} onChange={(e) => setEm(e.target.value)} placeholder="user@energi-up.com" />
            </label>
            <label className="cu-field">Default password
              <input type="text" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="min 12 characters" />
            </label>
            <label className="cu-field">Department
              <select value={dep} onChange={(e) => setDep(e.target.value)}>
                <option value="">(none)</option>
                {d.departments.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
              </select>
            </label>
            <label className="cu-field">Role
              <select value={jr} onChange={(e) => setJr(e.target.value as JobRole)}>
                {d.jobRoles.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
              </select>
            </label>
            <button className="btn" style={{ width: 'auto' }} disabled={busy} onClick={() => void register()}>
              {busy ? 'Working…' : 'Register user'}
            </button>
          </div>
          <p className="note">
            The default password is single-use: the account is flagged and the API refuses every
            other request until the user changes it at first login. Passwords are argon2id-hashed
            and never shown again — note it down before leaving this screen.
            <br />
            A new account starts with <strong>no data scope</strong> (deny by default): it can sign
            in but sees nothing until you grant access with <em>Grant all data</em> or{' '}
            <em>Scope…</em> in the table below.
          </p>

          <h3 className="pr-tbl-h">Users</h3>
          <div className="table-wrap dt-scroll">
            <table className="data dd-tbl">
              <thead>
                <tr>
                  <th>Name</th><th>Email</th><th>Department</th><th>Role</th>
                  <th>Access tier</th><th>Data scope</th><th>Login</th><th>Status</th><th>Last login</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {d.users.map((u, i) => (
                  <tr key={u.id} className={i % 2 ? '' : 're'}>
                    <td>{u.displayName}</td>
                    <td className="muted">{u.email}</td>
                    <td>
                      <select
                        className="ly-swap"
                        value={u.department ?? ''}
                        onChange={(e) => void patch(u.id, { department: e.target.value || null }, `${u.email} moved.`)}
                      >
                        <option value="">(none)</option>
                        {d.departments.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <select
                        className="ly-swap"
                        value={u.jobRole ?? 'staff'}
                        onChange={(e) => void patch(u.id, { jobRole: e.target.value }, `${u.email} role changed.`)}
                      >
                        {d.jobRoles.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
                      </select>
                    </td>
                    <td className="muted">{(u.roles ?? []).join(', ') || DASH}</td>
                    <td>
                      {u.scopeCount === 0 ? (
                        <span className="bs sa" title="This user can see no data at all">none</span>
                      ) : u.scopeAll > 0 ? (
                        <span className="bs sd">all data</span>
                      ) : (
                        <span className="bs su">{u.scopeCount} slice(s)</span>
                      )}
                    </td>
                    <td>{u.authMethod === 'sso' ? 'DWS Hub' : 'Password'}</td>
                    <td>
                      <span className={`bs ${u.isActive ? 'sd' : 'spdel'}`}>
                        {u.isActive ? 'active' : 'disabled'}
                      </span>
                      {u.mustChangePassword && (
                        <span className="bs sn" style={{ marginLeft: '.25rem' }} title="Must change password at next login">
                          pending change
                        </span>
                      )}
                    </td>
                    <td className="muted">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : DASH}</td>
                    <td>
                      <button className="dt-btn" disabled={busy}
                        onClick={() => void setScope(u.id, [{ companyCode: '*', plant: '*', purchOrg: '*' }],
                          `${u.email} can now see all data.`)}>
                        Grant all data
                      </button>{' '}
                      <button className="dt-btn" disabled={busy} onClick={() => void grantSlice(u)}>
                        Scope…
                      </button>{' '}
                      {u.scopeCount > 0 && (
                        <button className="dt-btn" disabled={busy}
                          onClick={() => void setScope(u.id, [], `Data access removed for ${u.email}.`)}>
                          Clear scope
                        </button>
                      )}{' '}
                      <button className="dt-btn" disabled={busy} onClick={() => void resetPassword(u)}>
                        Reset password
                      </button>{' '}
                      <button
                        className="dt-btn" disabled={busy}
                        onClick={() => void patch(u.id, { isActive: !u.isActive },
                          `${u.email} ${u.isActive ? 'disabled' : 'enabled'}.`)}
                      >
                        {u.isActive ? 'Disable' : 'Enable'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div className="dt-toolbar">
            {(['job_role', 'department'] as const).map((k) => (
              <button key={k} className="dt-btn" aria-pressed={subjectKind === k}
                style={subjectKind === k ? { borderColor: 'var(--accent)', fontWeight: 600 } : {}}
                onClick={() => setSubjectKind(k)}>
                {k === 'job_role' ? 'By role' : 'By department'}
              </button>
            ))}
            <button className="btn" style={{ width: 'auto' }} disabled={busy || Object.keys(pending).length === 0}
              onClick={() => void saveMatrix()}>
              {busy ? 'Saving…' : `Save ${Object.keys(pending).length || ''} change(s)`}
            </button>
          </div>
          <p className="note">
            Click a cell to cycle <span className="bs sl">none</span> →{' '}
            <span className="bs su">view</span> → <span className="bs sd">edit</span>. A user's
            effective access is the more permissive of their role and department grant; the Admin
            role always keeps full access so this screen cannot lock you out.
          </p>
          <div className="table-wrap dt-scroll">
            <table className="data dd-tbl">
              <thead>
                <tr>
                  <th>{subjectKind === 'job_role' ? 'Role' : 'Department'}</th>
                  {PAGE_KEYS.map((p) => <th key={p} style={{ fontSize: '.6rem' }}>{PAGE_LABELS[p]}</th>)}
                </tr>
              </thead>
              <tbody>
                {subjects.map((sub, i) => (
                  <tr key={sub.code} className={i % 2 ? '' : 're'}>
                    <td style={{ fontWeight: 700 }}>
                      {subjectKind === 'job_role'
                        ? JOB_ROLE_LABELS[sub.code as JobRole] ?? sub.name
                        : sub.name}
                    </td>
                    {PAGE_KEYS.map((p) => {
                      const a = current(sub.code, p);
                      const dirty = pending[cellKey(sub.code, p)] !== undefined;
                      return (
                        <td
                          key={p}
                          style={{ cursor: 'pointer', outline: dirty ? '2px solid var(--accent)' : undefined }}
                          title={`${sub.name} · ${PAGE_LABELS[p]} — click to change`}
                          onClick={() => cycle(sub.code, p)}
                        >
                          <span className={`bs ${ACCESS_PILL[a]}`}>{a}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
