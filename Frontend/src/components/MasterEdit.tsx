import { useState } from 'react';
import { api } from '../lib/api';
import { FloatControls } from './FloatControls';
import { hubTrack } from '../lib/hub';

/**
 * Master data editing, for Admins (032).
 *
 * Everything here is driven by the `edit` block the server attaches to a table
 * - which fields exist, which are keys, which are read-only and WHY. The page
 * holds no copy of that, so a field the server stops allowing cannot survive in
 * a form here.
 *
 * Edits are overrides the SAP sync re-applies, so they persist; every edited or
 * hidden row can be put back to what SAP had.
 */

export interface EditField {
  col: string; key: string; label: string;
  kind: 'text' | 'bool' | 'int' | 'number' | 'date' | 'choice' | 'multichoice';
  effect: 'label' | 'recompute' | 'mart';
  required?: boolean;
  /** A choice field's allowed values, stated by the server. */
  options?: string[];
  /** Readable names for those values (purchasing organisations). */
  optionLabels?: Record<string, string>;
  /**
   * A choice that can be left to the rules. Empty means Automatic, and the row
   * value at `viaKey` says whether the current value was chosen by hand.
   */
  auto?: { viaKey: string; manualValue: string; label: string };
}
export interface EditKey { col: string; key: string; label: string; kind: EditField['kind'] }
export interface EditBlock {
  keys: EditKey[];
  fields: EditField[];
  readOnly: { key: string; reason: string; label?: string }[];
  allowAdd: boolean;
  allowDelete: boolean;
  note: string;
  fx: boolean;
}
export interface RowMark {
  key: Record<string, unknown>;
  state: 'edited' | 'added' | 'hidden';
  by: string;
  at: string;
}

/**
 * When a change reaches the figures. Stated on the field itself, because
 * "I changed it and nothing moved" is the question every one of these invites.
 */
const EFFECT_NOTE: Record<EditField['effect'], string | null> = {
  label: null,
  recompute: 'Takes effect at the next Recompute - the published dataset does not change.',
  mart: 'Takes effect at the next "Recompute charts and KPIs".',
};

/**
 * A row's key in the server's display names.
 *
 * FX is the one master whose key the page shows differently: a single
 * "YYYY-MM" period, where the key is a year and a month. Split here so the
 * server keeps one explicit key shape.
 */
export function rowKey(edit: EditBlock, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of edit.keys) out[k.key] = row[k.key];
  if (edit.fx && typeof row['period'] === 'string') {
    const [y, m] = String(row['period']).split('-');
    out['periodYear'] = Number(y);
    out['periodMonth'] = Number(m);
  }
  return out;
}

export function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  return ka.length > 0 && ka.every((k) => String(a[k]) === String(b[k]));
}

export function MasterEditDialog({
  relation, tableName, edit, row, onClose, onSaved,
}: {
  relation: string;
  tableName: string;
  edit: EditBlock;
  /** null to ADD a row. */
  row: Record<string, unknown> | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const adding = row === null;
  const initial: Record<string, string> = {};
  for (const k of edit.keys) initial[k.key] = adding ? '' : String(rowKey(edit, row)[k.key] ?? '');
  for (const f of edit.fields) {
    const v = row?.[f.key];
    initial[f.key] = v === null || v === undefined ? '' : String(v);
    // A value the rules produced is not a choice someone made: the form starts
    // on Automatic, and saving without touching it changes nothing.
    if (f.auto && row && row[f.auto.viaKey] !== f.auto.manualValue) initial[f.key] = '';
    if (f.kind === 'date') initial[f.key] = (initial[f.key] ?? '').slice(0, 10);
  }
  const [form, setForm] = useState<Record<string, string>>(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setSaving(true);
    setErr(null);
    try {
      const values: Record<string, unknown> = {};
      for (const k of edit.keys) values[k.key] = form[k.key];
      // An edit sends only what changed, so it overrides that column and no
      // other; an add sends everything.
      for (const f of edit.fields) {
        if (adding || form[f.key] !== initial[f.key]) values[f.key] = form[f.key];
      }
      if (!adding && edit.fields.every((f) => form[f.key] === initial[f.key])) {
        onClose();
        return;
      }
      if (adding) await api.post('/api/v1/admin/master/rows', { relation, values });
      else await api.patch('/api/v1/admin/master/rows', { relation, values });
      hubTrack(adding ? 'master_row_added' : 'master_row_edited', { relation });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const input = (key: string, kind: EditField['kind'], disabled: boolean, field?: EditField) => (
    kind === 'multichoice' ? (
      <MultiChoice
        value={form[key] ?? ''}
        options={field?.options ?? []}
        labels={field?.optionLabels}
        disabled={disabled}
        onChange={(v) => setForm({ ...form, [key]: v })}
      />
    ) : kind === 'choice' ? (
      <select
        className="gf-search-in"
        value={form[key] ?? ''}
        disabled={disabled}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      >
        <option value="">
          {field?.auto
            ? `${field.auto.label}${row && row[key] ? ` (now: ${String(row[key])})` : ''}`
            : '—'}
        </option>
        {(field?.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    ) : kind === 'bool' ? (
      <select
        value={form[key] === 'true' || form[key] === 'yes' ? 'yes' : form[key] === '' ? '' : 'no'}
        disabled={disabled}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      >
        <option value="">—</option>
        <option value="yes">yes</option>
        <option value="no">no</option>
      </select>
    ) : (
      <input
        className="gf-search-in"
        type={kind === 'text' ? 'text' : kind === 'date' ? 'date' : 'number'}
        step={kind === 'number' ? 'any' : '1'}
        value={form[key] ?? ''}
        disabled={disabled}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    )
  );

  return (
    <div className="modal-backdrop" role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal me-modal" role="dialog" aria-modal="true" aria-label={`${adding ? 'Add to' : 'Edit'} ${tableName}`}>
        <header>
          <h3>{adding ? `Add to ${tableName}` : `Edit ${tableName}`}</h3>
          <span className="spacer" />
          <FloatControls onClose={onClose} />
          <button type="button" className="dd-x" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="body">
          <p className="note" style={{ marginTop: 0 }}>{edit.note}</p>

          <div className="me-grid">
            {edit.keys.map((k) => (
              <label key={k.key} className="me-field">
                <span className="me-label">{k.label} <span className="muted">(key)</span></span>
                {input(k.key, k.kind, !adding)}
              </label>
            ))}
            {edit.fields.map((f) => (
              <label key={f.key} className={`me-field${f.kind === 'multichoice' ? ' me-field-wide' : ''}`}>
                <span className="me-label">
                  {f.label}{f.required ? ' *' : ''}
                </span>
                {input(f.key, f.kind, false, f)}
                {EFFECT_NOTE[f.effect] && <span className="me-effect">{EFFECT_NOTE[f.effect]}</span>}
              </label>
            ))}
          </div>

          {/* The fields that LOOK editable and are not, with the reason. Hiding
              them would leave the reader wondering why the form is missing the
              very column they came to change. */}
          {edit.readOnly.length > 0 && (
            <div className="me-ro">
              <p className="me-ro-h">Not editable here</p>
              <ul>
                {edit.readOnly.map((r) => (
                  <li key={r.key}><strong>{r.label ?? r.key}</strong> — {r.reason}</li>
                ))}
              </ul>
            </div>
          )}

          {err && <p className="note"><span className="bs spdel">error</span> {err}</p>}
          <div className="me-actions">
            <button type="button" className="dt-btn" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="button" className="dt-btn dt-btn-primary" onClick={() => { void save(); }} disabled={saving}>
              {saving ? 'Saving…' : adding ? 'Add row' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Several values from a long list - a user's purchasing organisations (491 to
 * choose from). Chosen ones sit on top as removable chips; a search box narrows
 * the list. The value is "A, B", sorted, which is exactly how the Master table
 * shows the column, so an untouched field compares equal and is not sent.
 */
function MultiChoice({ value, options, labels, disabled, onChange }: {
  value: string;
  options: string[];
  labels: Record<string, string> | undefined;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const [q, setQ] = useState('');
  const chosen = value.split(',').map((x) => x.trim()).filter((x) => x !== '');
  const set = (next: string[]) => onChange([...new Set(next)].sort().join(', '));
  const name = (o: string) => (labels?.[o] ? `${o} — ${labels[o]}` : o);
  const needle = q.trim().toLowerCase();
  const shown = options
    .filter((o) => !chosen.includes(o))
    .filter((o) => needle === '' || name(o).toLowerCase().includes(needle))
    .slice(0, 50);
  return (
    <div className="me-multi">
      <div className="me-multi-chips">
        {chosen.length === 0 && <span className="muted">None</span>}
        {chosen.map((o) => (
          <span key={o} className="me-multi-chip" title={name(o)}>
            {o}
            {!disabled && (
              <button type="button" aria-label={`Remove ${o}`}
                onClick={(e) => { e.preventDefault(); set(chosen.filter((x) => x !== o)); }}>✕</button>
            )}
          </span>
        ))}
      </div>
      {!disabled && (
        <>
          <input
            className="gf-search-in"
            type="search"
            placeholder="Search code or name to add…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {needle !== '' && (
            <ul className="me-multi-list" role="listbox">
              {shown.length === 0 && <li className="muted">No match</li>}
              {shown.map((o) => (
                <li key={o}>
                  <button type="button" onClick={(e) => { e.preventDefault(); set([...chosen, o]); setQ(''); }}>
                    {name(o)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
