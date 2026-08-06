import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { DASH, formatNumber } from '../lib/format';

/**
 * Coupa integration — TECH_04. Two pieces:
 *
 * CoupaPanel (Admin tab): scheduler config + per-object sync health.
 * The data pages live in CoupaPages.tsx (Sourcing / Invoices & Payment).
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

  // A cold sync runs for minutes in the background (the request returns at
  // once), so poll while any object is still 'running'.
  const running = ((d?.status ?? []) as WatermarkRow[]).some((w) => w.last_status === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [running, load]);

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
            ? 'Another sync is already running — watch the table below for progress.'
            : out.outcome === 'started'
              ? 'Sync started in the background. A first (cold) run pages every object and can take several minutes — this table refreshes itself.'
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
        The poller pulls sourcing events, POs, receipts, invoices (payments ride inside invoices)
        and exchange rates incrementally by <code>updated-at</code> watermark. Data lands in the Coupa tab; the SAP
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
                <td>
                  {w.last_status === 'ok' ? '✓ ok'
                    : w.last_status === 'running' ? <span className="dt-appr-next">⟳ running…</span>
                    : w.last_status === 'error' ? `✗ ${(w.last_error ?? '').slice(0, 60)}`
                    : DASH}
                </td>
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
