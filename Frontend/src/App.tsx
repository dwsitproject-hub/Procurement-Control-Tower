import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type DatasetCurrent, type Finding, type Kpi, type Me } from './lib/api';
import { formatNumber } from './lib/format';
import { FreshnessBanner } from './components/FreshnessBanner';
import { KpiCard } from './components/KpiCard';
import { ChartPanel } from './components/Chart';
import { DrillModal } from './components/DrillModal';
import { DetailTable } from './components/DetailTable';

type Tab = 'executive' | 'pr' | 'po' | 'delivery' | 'approvals' | 'governance' | 'openitems' | 'detail' | 'datacheck';

const TABS: { id: Tab; label: string }[] = [
  { id: 'executive', label: 'Executive' },
  { id: 'openitems', label: 'Open Items' },
  { id: 'pr', label: 'PR' },
  { id: 'po', label: 'PO' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'governance', label: 'Governance' },
  { id: 'detail', label: 'Detail Table' },
  { id: 'datacheck', label: 'Data Check' },
];

const TAB_KPIS: Record<Tab, string[]> = {
  executive: [
    'demand_realism', 'expedite_effectiveness', 'grir_over_60d', 'commitment_over_60d',
    'wbs_compliance', 'open_items', 'cycle_e2e', 'split_sourcing',
  ],
  openitems: ['open_items', 'pending_pr_approvals', 'pending_po_approvals', 'commitment_over_60d'],
  pr: ['demand_realism', 'expedite_effectiveness', 'cycle_pr_approval', 'pending_pr_approvals'],
  po: ['direct_po_share', 'sto_share', 'cycle_sourcing', 'cycle_po_approval', 'retro_po_rate', 'grir_over_60d'],
  delivery: ['cycle_delivery', 'cycle_e2e', 'reversal_rate'],
  approvals: ['pending_pr_approvals', 'pending_po_approvals', 'cycle_pr_approval', 'cycle_po_approval'],
  governance: ['wbs_compliance', 'retro_po_rate', 'sto_share', 'direct_po_share'],
  detail: [],
  datacheck: [],
};

const TAB_CHARTS: Record<Tab, string[]> = {
  executive: ['status_mix', 'po_value_by_month'],
  openitems: ['aging_bands', 'status_mix'],
  pr: ['pr_by_month', 'wbs_by_plant'],
  po: ['po_value_by_month', 'top_vendors_spend', 'purch_group_workload'],
  delivery: ['delivery_ordered_vs_received', 'movement_mix'],
  approvals: ['pending_pr_by_pic'],
  governance: ['wbs_by_plant'],
  detail: [],
  datacheck: [],
};

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [tab, setTab] = useState<Tab>('executive');
  const [dataset, setDataset] = useState<DatasetCurrent | null>(null);
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [drill, setDrill] = useState<{ token: string; label: string } | null>(null);

  const onDrill = useCallback((token: string, label: string) => setDrill({ token, label }), []);

  useEffect(() => {
    api
      .get<Me>('/api/v1/me')
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!me) return;
    api.get<DatasetCurrent>('/api/v1/dataset/current').then(setDataset).catch(() => undefined);
    api
      .get<{ kpis: Kpi[] }>('/api/v1/kpi')
      .then((d) => setKpis(d.kpis))
      .catch(() => setKpis([]));
  }, [me]);

  if (!authChecked) {
    return <div className="center-msg"><div className="spinner" />Loading…</div>;
  }
  if (!me) return <Login onSignedIn={setMe} />;

  // A newly provisioned SSO user is authenticated but has no data scope.
  if (me.scope.length === 0) {
    return (
      <div className="login-wrap">
        <div className="login">
          <h1>No data access granted</h1>
          <p className="sub">
            You are signed in as {me.email}, but your account has no data scope yet. Ask an
            administrator to grant access to the plants and purchasing organisations you need.
          </p>
          <button className="btn secondary" onClick={() => void logout()}>Sign out</button>
        </div>
      </div>
    );
  }

  const visibleKpis = TAB_KPIS[tab]
    .map((id) => kpis.find((k) => k.kpiId === id))
    .filter((k): k is Kpi => k !== undefined);

  return (
    <div className="app">
      <div className="topbar">
        <h1>Procurement Control Tower</h1>
        <span className="spacer" />
        <span className="who">
          {me.displayName} · {me.roles.join(', ')}
        </span>
        <button className="btn secondary" style={{ width: 'auto' }} onClick={() => void logout()}>
          Sign out
        </button>
      </div>

      {dataset && dataset.datasetVersionId !== null ? (
        <FreshnessBanner data={dataset} />
      ) : (
        <div className="freshness" data-state="stale">
          <span className="dot" aria-hidden="true" />
          <strong>No dataset published</strong>
          <span className="muted">— run an ingestion to load the SAP exports.</span>
        </div>
      )}

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <main>
        {dataset?.datasetVersionId == null ? (
          <div className="panel">
            <h2>No data yet</h2>
            <p className="note">
              Publish a dataset first: <code>npm run ingest -w @pct/backend</code>
            </p>
          </div>
        ) : tab === 'detail' ? (
          <DetailTable />
        ) : tab === 'datacheck' ? (
          <DataCheck versionId={dataset.datasetVersionId} />
        ) : (
          <>
            {visibleKpis.length > 0 && (
              <div className="kpi-grid" style={{ marginBottom: '1rem' }}>
                {visibleKpis.map((k) => (
                  <KpiCard key={k.kpiId} kpi={k} onDrill={onDrill} />
                ))}
              </div>
            )}
            <div className="chart-grid">
              {TAB_CHARTS[tab].map((c) => (
                <ChartPanel key={c} chartId={c} onDrill={onDrill} />
              ))}
            </div>
          </>
        )}
      </main>

      {drill && (
        <DrillModal token={drill.token} label={drill.label} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}

async function logout(): Promise<void> {
  await api.post('/auth/logout').catch(() => undefined);
  window.location.reload();
}

// ────────────────────────────────────────────────────────────────── login

function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [email, setEmail] = useState('admin@energi-up.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);

  useEffect(() => {
    // The login route is gated on complete OIDC configuration, so probing it
    // tells us whether to offer the SSO button at all.
    fetch('/auth/oidc/login', { method: 'HEAD', redirect: 'manual' })
      .then((r) => setSsoEnabled(r.status !== 404))
      .catch(() => setSsoEnabled(false));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/local/login', { email, password });
      const me = await api.get<Me>('/api/v1/me');
      onSignedIn(me);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 423
          ? 'Account temporarily locked after repeated failures.'
          : 'Invalid email or password.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <h1>Procurement Control Tower</h1>
        <p className="sub">Sign in to continue</p>

        {ssoEnabled && (
          <>
            <a className="btn" href="/auth/oidc/login" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
              Sign in with DWS Hub
            </a>
            <p className="sub" style={{ textAlign: 'center', margin: '.75rem 0' }}>or</p>
          </>
        )}

        <label>
          Email
          <input
            type="email"
            value={email}
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <p className="err">{error}</p>}
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── data check

function DataCheck({ versionId }: { versionId: number }) {
  const [findings, setFindings] = useState<Finding[] | null>(null);

  useEffect(() => {
    api
      .get<{ findings: Finding[] }>(`/api/v1/dataset/${versionId}/validation`)
      .then((d) => setFindings(d.findings))
      .catch(() => setFindings([]));
  }, [versionId]);

  if (!findings) return <div className="center-msg"><div className="spinner" />Loading validation report…</div>;

  const order: Finding['severity'][] = ['BLOCKER', 'CAVEAT', 'WARNING', 'INFO'];

  return (
    <div className="panel">
      <h2>Validation report — dataset version {versionId}</h2>
      {findings.length === 0 && <p className="note">No findings.</p>}
      {order.map((sev) => {
        const group = findings.filter((f) => f.severity === sev);
        if (group.length === 0) return null;
        return (
          <div key={sev} style={{ marginBottom: '1rem' }}>
            <h3 style={{ fontSize: '.85rem', margin: '.5rem 0' }}>
              <span className={`sev sev-${sev}`}>{sev}</span> {group.length}
            </h3>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Feed</th>
                    <th style={{ textAlign: 'right' }}>Rows</th>
                    <th style={{ whiteSpace: 'normal', minWidth: 420 }}>Finding</th>
                  </tr>
                </thead>
                <tbody>
                  {group.map((f) => (
                    <tr key={f.ruleId}>
                      <td><code>{f.ruleId}</code></td>
                      <td>{f.feed ?? '—'}</td>
                      <td className="num">
                        {f.affectedRows === null ? '—' : formatNumber(f.affectedRows)}
                      </td>
                      <td style={{ whiteSpace: 'normal' }}>
                        {f.message}
                        {f.disablesKpis.length > 0 && (
                          <> <em>Disables: {f.disablesKpis.join(', ')}.</em></>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
