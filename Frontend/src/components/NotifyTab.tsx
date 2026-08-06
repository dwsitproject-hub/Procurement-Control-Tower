import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { DASH, formatDateTime } from '../lib/format';

/**
 * Notifications (6 Aug 2026) — who gets emailed when a scheduled run finishes
 * or a sync errors.
 *
 * Split by design: recipients and event toggles are operational settings and
 * live in the rule store, editable here. The SMTP server and its password are
 * environment configuration — a password must never sit in a table the API can
 * read — so they are shown read-only for confirmation.
 */

interface NotifyCfg {
  enabled: boolean;
  recipients: string[];
  onIngestSuccess: boolean;
  onIngestFailure: boolean;
  onCoupaError: boolean;
  ratePerHour: number;
  smtp: {
    host: string; port: number; secure: string;
    user: string | null; from: string; hasPassword: boolean;
  };
  recent: {
    id: number; sentAt: string; event: string; subject: string;
    recipients: string[]; status: string; error: string | null;
  }[];
}

const STATUS_PILL: Record<string, string> = {
  sent: 'sd', failed: 'spdel', suppressed: 'sl',
};

export function NotifyTab({ isAdmin }: { isAdmin: boolean }) {
  const [cfg, setCfg] = useState<NotifyCfg | null>(null);
  const [recipients, setRecipients] = useState('');
  const [onOk, setOnOk] = useState(true);
  const [onFail, setOnFail] = useState(true);
  const [onCoupa, setOnCoupa] = useState(true);
  const [testTo, setTestTo] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<NotifyCfg>('/api/v1/admin/notify')
      .then((x) => {
        setCfg(x);
        setRecipients(x.recipients.join(', '));
        setOnOk(x.onIngestSuccess);
        setOnFail(x.onIngestFailure);
        setOnCoupa(x.onCoupaError);
      })
      .catch((e: Error) => setMsg(e.message));
  }, []);
  useEffect(load, [load]);

  if (!cfg) {
    return <div className="panel"><h2>📧 Notifications</h2><div className="spinner" /></div>;
  }

  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      const out = await api.put<NotifyCfg>('/api/v1/admin/notify', {
        recipients: recipients.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean),
        onIngestSuccess: onOk, onIngestFailure: onFail, onCoupaError: onCoupa,
      });
      setMsg(out.recipients.length === 0
        ? 'Saved — but no recipients are configured, so nothing will be emailed.'
        : `Saved — ${out.recipients.length} recipient(s).`);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'save failed');
    } finally { setBusy(null); }
  };

  const sendTest = async () => {
    setBusy('test'); setMsg('Sending…');
    try {
      const out = await api.post<{ status: string; reason?: string; recipients: string[] }>(
        '/api/v1/admin/notify/test', testTo.trim() === '' ? {} : { to: testTo.trim() },
      );
      setMsg(
        out.status === 'sent' ? `Sent to ${out.recipients.join(', ')} — check the inbox.`
        : out.status === 'suppressed' ? `Not sent: ${out.reason}`
        : `Delivery failed: ${out.reason}`,
      );
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'test failed');
    } finally { setBusy(null); }
  };

  return (
    <div className="panel">
      <h2>📧 Notifications</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Emails the outcome of scheduled runs. A mail problem never affects an ingest or a
        sync — sends happen after the work is done, and a failure is recorded here rather
        than raised into the pipeline.
      </p>

      {!cfg.enabled && (
        <p className="note">
          <strong>Sending is disabled for this environment</strong> (<code>NOTIFY_ENABLED</code>).
          Settings below can be prepared, but nothing will leave the server.
        </p>
      )}

      <h3 className="pr-tbl-h">Recipients</h3>
      <label className="cu-field" style={{ display: 'block', maxWidth: 620 }}>
        Email addresses — comma or space separated
        <textarea
          rows={2}
          value={recipients}
          disabled={!isAdmin}
          onChange={(e) => setRecipients(e.target.value)}
          placeholder="procurement.lead@energi-up.com, it.support@energi-up.com"
          style={{ width: '100%', fontFamily: 'inherit', fontSize: '.74rem' }}
        />
      </label>

      <h3 className="pr-tbl-h">When to send</h3>
      <div className="dt-toolbar" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="dt-check">
          <input type="checkbox" checked={onOk} disabled={!isAdmin}
            onChange={(e) => setOnOk(e.target.checked)} />
          SAP sync succeeded — rows loaded per file and the change vs the previous version
        </label>
      </div>
      <div className="dt-toolbar" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="dt-check">
          <input type="checkbox" checked={onFail} disabled={!isAdmin}
            onChange={(e) => setOnFail(e.target.checked)} />
          SAP sync failed — files accepted vs rejected, and the reason for each
        </label>
      </div>
      <div className="dt-toolbar" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="dt-check">
          <input type="checkbox" checked={onCoupa} disabled={!isAdmin}
            onChange={(e) => setOnCoupa(e.target.checked)} />
          Coupa sync errors only — objects succeeded vs failed, with each error message
        </label>
      </div>
      <p className="note">
        A clean Coupa sync runs every few minutes, so only its errors are emailed —
        success notices would be noise. At most {cfg.ratePerHour} emails per hour are
        sent; beyond that they are recorded as suppressed instead of flooding inboxes.
      </p>

      <div className="dt-toolbar" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {isAdmin && (
          <button className="btn" style={{ width: 'auto' }} disabled={busy !== null}
            onClick={() => void save()}>
            {busy === 'save' ? 'Saving…' : 'Save notification settings'}
          </button>
        )}
        {isAdmin && (
          <>
            <label className="cu-field">Send a test to (optional)
              <input value={testTo} onChange={(e) => setTestTo(e.target.value)}
                placeholder="leave blank to use the list above" style={{ width: 260 }} />
            </label>
            <button className="dt-btn" disabled={busy !== null} onClick={() => void sendTest()}>
              {busy === 'test' ? 'Sending…' : 'Send test email'}
            </button>
          </>
        )}
      </div>
      {msg && <p className="note"><strong>{msg}</strong></p>}

      <h3 className="pr-tbl-h">Mail server <span className="muted">— environment configuration</span></h3>
      <div className="table-wrap">
        <table className="data dd-tbl">
          <tbody>
            <tr className="re"><td>Host</td><td><code>{cfg.smtp.host}</code></td></tr>
            <tr><td>Port</td><td><code>{cfg.smtp.port}</code></td></tr>
            <tr className="re">
              <td>Encryption</td>
              <td>
                <code>{cfg.smtp.secure}</code>{' '}
                <span className="muted">
                  {cfg.smtp.secure === 'starttls' ? '(STARTTLS — the usual choice on port 587)'
                    : cfg.smtp.secure === 'tls' ? '(implicit TLS — port 465)'
                    : '(no encryption — local test server only)'}
                </span>
              </td>
            </tr>
            <tr><td>Username</td><td><code>{cfg.smtp.user ?? DASH}</code></td></tr>
            <tr className="re">
              <td>Password</td>
              <td>
                {cfg.smtp.hasPassword
                  ? <span className="bs sd">configured</span>
                  : <span className="bs sa">not set — authenticated sending will fail</span>}
              </td>
            </tr>
            <tr><td>From</td><td><code>{cfg.smtp.from}</code></td></tr>
          </tbody>
        </table>
      </div>
      <p className="note">
        These come from the backend environment (<code>SMTP_HOST</code>, <code>SMTP_PORT</code>,{' '}
        <code>SMTP_SECURE</code>, <code>SMTP_USER</code>, <code>SMTP_PASSWORD</code>,{' '}
        <code>SMTP_FROM</code>) and are shown here read-only: a mail password must never live
        in a table the API can read. Change them in the server env file and restart the API.
      </p>

      {cfg.recent.length > 0 && (
        <>
          <h3 className="pr-tbl-h">Recent notifications</h3>
          <div className="table-wrap" style={{ maxHeight: 280, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead>
                <tr><th>Sent</th><th>Event</th><th>Subject</th><th>To</th><th>Status</th></tr>
              </thead>
              <tbody>
                {cfg.recent.map((r, i) => (
                  <tr key={r.id} className={i % 2 ? '' : 're'}>
                    <td>{formatDateTime(r.sentAt)}</td>
                    <td><code>{r.event}</code></td>
                    <td>{r.subject}</td>
                    <td className="muted">{r.recipients.join(', ') || DASH}</td>
                    <td>
                      <span className={`bs ${STATUS_PILL[r.status] ?? 'sl'}`} title={r.error ?? ''}>
                        {r.status}
                      </span>
                      {r.error ? <span className="muted"> {r.error.slice(0, 60)}</span> : null}
                    </td>
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
