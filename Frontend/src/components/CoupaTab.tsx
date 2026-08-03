import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { DASH, formatNumber } from '../lib/format';

/**
 * Coupa integration — TECH_04. Two pieces:
 *
 * CoupaPanel (Admin tab): scheduler config + per-object sync health.
 * CoupaTab: sourcing + invoice/payment view over ops.coupa_* — every figure
 * is shown next to the rows behind it (drill tokens for Coupa grains are C4b).
 */

interface WatermarkRow {
  object: string;
  last_updated_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  rows_upserted: number;
  runs?: number;
}

// ─────────────────────────────────────────────────────────── admin panel

export function CoupaPanel({ isAdmin }: { isAdmin: boolean }) {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [interval, setIntervalMin] = useState(10);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<Record<string, any>>('/api/v1/admin/coupa')
      .then((x) => {
        setD(x);
        setEnabled(x.config.enabled);
        setIntervalMin(x.config.intervalMinutes);
      })
      .catch((e: Error) => setMsg(e.message));
  }, []);
  useEffect(load, [load]);

  if (!d) return <div className="panel"><h2>🔄 Coupa sync</h2><div className="spinner" /></div>;

  const saveConfig = async () => {
    setBusy('save');
    setMsg(null);
    try {
      const out = await api.put<{ enabled: boolean; intervalMinutes: number }>(
        '/api/v1/admin/coupa/config', { enabled, intervalMinutes: interval },
      );
      setMsg(`Saved — ${out.enabled ? `polling every ${out.intervalMinutes} min` : 'polling disabled'}.`);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'save failed');
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    setBusy('sync');
    setMsg('Syncing from Coupa…');
    try {
      const out = await api.post<Record<string, any>>('/api/v1/admin/coupa/sync');
      setMsg(
        out.outcome === 'not_configured'
          ? 'Coupa credentials are not configured on this environment.'
          : out.outcome === 'locked'
            ? 'Another sync is already running.'
            : `Sync ${out.outcome}: ` +
              out.objects.map((o: any) => `${o.object} ${o.status === 'ok' ? `+${o.rowsUpserted}` : '✗'}`).join(' · '),
      );
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'sync failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel">
      <h2>🔄 Coupa sync <span className="muted">— {d.configured ? d.host : 'not configured'}</span></h2>
      <p className="note" style={{ marginBottom: '.6rem' }}>
        The poller pulls sourcing events, POs, receipts and invoices (payments ride inside invoices)
        incrementally by <code>updated-at</code> watermark. Data lands in the Coupa tab; the SAP
        pipeline and its dataset versions are untouched.
        {!d.configured && ' Set COUPA_BASE_URL / COUPA_CLIENT_ID / COUPA_CLIENT_SECRET on the backend to enable.'}
      </p>

      {isAdmin && d.configured && (
        <div className="dt-toolbar" style={{ alignItems: 'flex-end' }}>
          <label className="dt-check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Scheduled sync
          </label>
          <label className="cu-field">Interval (minutes, 5–60)
            <input
              type="number" min={5} max={60} value={interval}
              onChange={(e) => setIntervalMin(Number(e.target.value))}
              style={{ width: 90 }}
            />
          </label>
          <button className="btn" style={{ width: 'auto' }} disabled={busy !== null} onClick={() => void saveConfig()}>
            {busy === 'save' ? 'Saving…' : 'Save schedule'}
          </button>
          <button className="dt-btn" disabled={busy !== null} onClick={() => void syncNow()}>
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      )}

      <div className="table-wrap" style={{ marginTop: '.6rem' }}>
        <table className="data">
          <thead>
            <tr><th>Object</th><th>Watermark (updated-at)</th><th>Last run</th><th>Status</th><th style={{ textAlign: 'right' }}>Rows upserted</th></tr>
          </thead>
          <tbody>
            {(d.status as WatermarkRow[]).length === 0 && (
              <tr><td colSpan={5} className="muted">No sync has run yet.</td></tr>
            )}
            {(d.status as WatermarkRow[]).map((w) => (
              <tr key={w.object}>
                <td><code>{w.object}</code></td>
                <td>{w.last_updated_at ?? DASH}</td>
                <td>{w.last_run_at ?? DASH}</td>
                <td>{w.last_status === 'ok' ? '✓ ok' : w.last_status === 'error' ? `✗ ${(w.last_error ?? '').slice(0, 60)}` : DASH}</td>
                <td className="num">{formatNumber(w.rows_upserted)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.counts && (
        <p className="note" style={{ marginTop: '.5rem' }}>
          Stored: {formatNumber(d.counts.sourcing_events)} sourcing events · {formatNumber(d.counts.supplier_responses)} bids ·{' '}
          {formatNumber(d.counts.po_lines)} PO lines · {formatNumber(d.counts.receipts)} receipts ·{' '}
          {formatNumber(d.counts.invoices)} invoices · {formatNumber(d.counts.payments)} payments
        </p>
      )}
      {msg && <p className="note" style={{ marginTop: '.5rem' }}>{msg}</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── the tab

export function CoupaTab() {
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<Record<string, any>>('/api/v1/coupa/summary').then(setD).catch((e: Error) => setErr(e.message));
  }, []);

  if (err) return <div className="panel"><h2>Coupa</h2><p className="err">{err}</p></div>;
  if (!d) return <div className="center-msg"><div className="spinner" />Loading Coupa data…</div>;

  if (!d.configured) {
    return (
      <div className="panel">
        <h2>Coupa</h2>
        <p className="note">
          Coupa is not configured on this environment. An administrator must set the backend
          COUPA_* variables and enable the scheduler in the Admin tab.
        </p>
      </div>
    );
  }

  const s = d.sourcing ?? {};
  const inv = d.invoice ?? {};
  const link = d.linkage ?? {};
  const card = (v: unknown, label: string, sub: string) => (
    <div className="kpi" data-sev="neutral">
      <div className="v">{v === null || v === undefined ? DASH : String(v)}</div>
      <div className="l">{label}</div>
      <div className="s">{sub}</div>
    </div>
  );

  return (
    <>
      <div className="panel" style={{ borderLeft: '3px solid var(--accent)' }}>
        <p className="note" style={{ margin: 0 }}>
          Live from Coupa ({d.watermarks?.length ? `as of ${d.watermarks.map((w: any) => `${w.object.split('_')[0]} ${w.last_updated_at ? String(w.last_updated_at).slice(0, 16) : '—'}`).join(' · ')}` : 'no sync yet'}).
          These figures come from the Coupa operational store, separate from the SAP dataset version —
          drill tokens for Coupa data arrive with C4b; until then every aggregate is shown with its rows below.
        </p>
      </div>

      <div className="panel">
        <h2>Sourcing</h2>
        <div className="kpi-grid">
          {card(formatNumber(Number(s.events ?? 0)), 'Sourcing events', 'excluding templates')}
          {card(formatNumber(Number(s.open_events ?? 0)), 'Open events', 'not complete or canceled')}
          {card(formatNumber(Number(s.completed ?? 0)), 'Completed events', '')}
          {card(
            s.median_cycle_days === null || s.median_cycle_days === undefined ? DASH : `${Number(s.median_cycle_days).toFixed(1)} d`,
            'Event cycle (median)', 'submit → end',
          )}
          {card(
            d.responses?.avg_bids_per_event ?? DASH, 'Avg bids per event',
            `${formatNumber(Number(d.responses?.responses ?? 0))} submitted bids`,
          )}
        </div>
        <h3 className="ent-h">Recent events</h3>
        <div className="table-wrap" style={{ maxHeight: 300, overflow: 'auto' }}>
          <table className="data">
            <thead><tr><th>ID</th><th>Type</th><th>State</th><th>Description</th><th>Submitted</th><th>Plant</th><th>SAP PR</th><th style={{ textAlign: 'right' }}>Suppliers</th><th style={{ textAlign: 'right' }}>Lines</th></tr></thead>
            <tbody>
              {(d.recentEvents ?? []).map((e: any) => (
                <tr key={e.id}>
                  <td>{e.id}</td><td>{e.event_type ?? DASH}</td><td>{e.state}</td>
                  <td>{(e.description ?? '').slice(0, 40)}</td>
                  <td>{e.submit_time ? String(e.submit_time).slice(0, 10) : DASH}</td>
                  <td>{e.plant ?? DASH}</td><td>{e.sap_pr_no ?? DASH}</td>
                  <td className="num">{e.supplier_count}</td><td className="num">{e.line_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Invoices &amp; payments</h2>
        <div className="kpi-grid">
          {card(formatNumber(Number(inv.invoices ?? 0)), 'Invoices', `${inv.currencies ?? 0} currencies`)}
          {card(formatNumber(Number(inv.paid_count ?? 0)), 'Paid', '')}
          {card(formatNumber(Number(inv.open_count ?? 0)), 'Open (unpaid)', 'excl. drafts and voided')}
          {card(
            inv.open_idr === null || inv.open_idr === undefined ? DASH : `${(Number(inv.open_idr) / 1e9).toFixed(2)} B IDR`,
            'Open payables (IDR)', 'IDR invoices only — other currencies listed below',
          )}
        </div>
        <h3 className="ent-h">Recent invoices</h3>
        <div className="table-wrap" style={{ maxHeight: 300, overflow: 'auto' }}>
          <table className="data">
            <thead><tr><th>Invoice #</th><th>Date</th><th>Status</th><th>Paid</th><th>Payment date</th><th style={{ textAlign: 'right' }}>Gross</th><th>Ccy</th><th>Supplier</th><th>Term</th></tr></thead>
            <tbody>
              {(d.recentInvoices ?? []).map((i: any) => (
                <tr key={i.id}>
                  <td>{i.invoice_number ?? i.id}</td>
                  <td>{i.invoice_date ? String(i.invoice_date).slice(0, 10) : DASH}</td>
                  <td>{i.status}</td>
                  <td>{i.paid ? '✓' : '—'}</td>
                  <td>{i.payment_date ? String(i.payment_date).slice(0, 10) : DASH}</td>
                  <td className="num">{i.gross_total === null ? DASH : formatNumber(Number(i.gross_total))}</td>
                  <td>{i.currency ?? DASH}</td>
                  <td>{(i.supplier_name ?? '').slice(0, 30)}</td>
                  <td>{i.payment_term ?? DASH}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note" style={{ marginTop: '.5rem' }}>
          SAP linkage: {formatNumber(Number(link.with_sap_po ?? 0))} of {formatNumber(Number(link.coupa_po_lines ?? 0))} Coupa PO
          lines carry a SAP PO reference · {formatNumber(Number(link.with_need_by ?? 0))} carry a requested delivery date
          (the D4 field the SAP export lacks).
        </p>
      </div>
    </>
  );
}
