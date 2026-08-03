import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type DatasetCurrent, type Finding, type Kpi, type Me } from './lib/api';
import { formatNumber } from './lib/format';
import { FreshnessBanner } from './components/FreshnessBanner';
import { KpiCard } from './components/KpiCard';
import { ChartPanel } from './components/Chart';
import { DrillModal } from './components/DrillModal';
import { DetailTable } from './components/DetailTable';
import {
  EMPTY_FILTER, GlobalFilterBar, globalFilterQuery, type GlobalFilterState,
} from './components/GlobalFilterBar';
import { MaterialsTab, VendorsTab } from './components/EntityViews';
import { AdminTab } from './components/AdminTab';
import { CustomTab } from './components/CustomTab';
import { CoupaTab } from './components/CoupaTab';
import { CustomKpiCard, CustomChartPanel } from './components/CustomTab';
import {
  LayoutControls, LayoutEditBar, applyLayout, useTabLayout,
} from './components/LayoutEdit';

type Tab =
  | 'executive' | 'pr' | 'po' | 'delivery' | 'approvals' | 'governance' | 'openitems'
  | 'vendors' | 'materials' | 'coupa' | 'detail' | 'custom' | 'admin' | 'datacheck';

const TABS: { id: Tab; label: string }[] = [
  { id: 'executive', label: 'Executive' },
  { id: 'openitems', label: 'Open Items' },
  { id: 'pr', label: 'PR' },
  { id: 'po', label: 'PO' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'governance', label: 'Governance' },
  { id: 'vendors', label: 'Vendor 360' },
  { id: 'materials', label: 'Materials' },
  { id: 'coupa', label: 'Coupa' },
  { id: 'detail', label: 'Detail Table' },
  { id: 'custom', label: 'Custom' },
  { id: 'admin', label: 'Admin' },
  { id: 'datacheck', label: 'Data Check' },
];

const TAB_KPIS: Record<Tab, string[]> = {
  // Ordered to mirror v1's page layouts.
  executive: [
    'open_po_commitment', 'grir_value', 'pr_pipeline_value', 'cycle_e2e',
    'emergency_pct_value', 'demand_realism', 'expedite_effectiveness', 'wbs_compliance',
    'total_pr_items', 'delivered_gr', 'open_items',
    'cycle_pr_approval', 'cycle_sourcing', 'cycle_po_approval', 'cycle_delivery',
  ],
  openitems: [
    'pr_not_approved', 'pr_no_po', 'po_hold', 'lines_pending_po_approval',
    'po_not_delivered', 'open_items', 'emergency_open', 'urgent_open',
    'avg_unreleased_age', 'retro_po_rate', 'open_pr_no_wbs', 'wbs_open_violations',
    'commitment_over_60d',
  ],
  pr: [
    'cycle_pr_approval', 'max_pr_approval', 'unreleased_items', 'total_pr_items',
    'pr_to_po_conversion', 'approved_within_3d', 'oldest_unreleased',
    'emergency_urgent_share', 'at_risk_demand', 'pr_cancellation_rate', 'pr_deleted',
    'wbs_compliance', 'demand_realism', 'expedite_effectiveness', 'pending_pr_approvals',
    'valuation_coverage_pct', 'unique_requisitioners', 'avg_pr_line_value_idr',
  ],
  po: [
    'total_po_amount', 'total_po_count', 'cycle_sourcing', 'cycle_po_approval',
    'po_line_items', 'unique_suppliers', 'grir_over_60d', 'commitment_over_60d',
    'lines_pending_po_approval', 'hold_po_lines', 'gr_coverage_pct',
    'pending_po_approvals', 'pr_po_price_variance', 'tail_spend_pct',
    'direct_po_share', 'sto_share', 'split_sourcing', 'po_irc',
    'tail_spend_po_pct', 'avg_po_value_idr', 'avg_value_per_po_usd', 'foreign_ccy_po_share',
  ],
  delivery: [
    'cycle_delivery', 'cycle_e2e', 'items_delivered', 'delivered_gr', 'reversal_rate',
    'otd_vs_requested',
  ],
  approvals: [
    'pending_pr_approvals', 'pending_po_approvals', 'cycle_pr_approval',
    'cycle_po_approval', 'approved_within_3d', 'oldest_unreleased', 'retro_po_rate',
    'worst_approver_gap', 'auto_release_share_pct',
  ],
  governance: [
    'wbs_compliance', 'open_pr_no_wbs', 'retro_po_rate', 'sto_share',
    'direct_po_share', 'sole_source_materials', 'tail_spend_pct',
    'pr_cancellation_rate', 'emergency_pct_value',
    'single_source_spend_idr', 'top_vendor_share_pct', 'top5_vendor_share_pct',
    'avg_suppliers_per_material',
  ],
  vendors: [],
  materials: [],
  coupa: [],
  detail: [],
  custom: [],
  admin: [],
  datacheck: [],
};

const TAB_CHARTS: Record<Tab, string[]> = {
  executive: ['status_mix', 'po_value_by_month', 'items_by_priority', 'aging_by_priority'],
  openitems: ['aging_bands', 'open_by_priority', 'unapproved_by_category', 'unreleased_aging_buckets'],
  pr: [
    'pr_by_month', 'items_by_category', 'pr_approval_by_priority',
    'pr_approval_distribution', 'monthly_pr_no_po', 'pr_by_plant', 'wbs_by_plant',
  ],
  po: [
    'po_value_by_month', 'top_vendors_spend', 'po_value_by_category', 'po_by_plant',
    'po_value_by_purch_org', 'purch_group_workload', 'sourcing_by_priority',
    'po_approval_by_priority', 'po_approval_distribution', 'sourcing_by_category',
    'commitment_aging', 'top_materials_spend',
  ],
  delivery: [
    'delivery_ordered_vs_received', 'delivery_by_category', 'delivery_by_priority',
    'delivery_distribution', 'e2e_by_month', 'e2e_by_category', 'movement_mix',
  ],
  approvals: ['pending_pr_by_pic'],
  governance: ['wbs_by_plant', 'unapproved_by_category'],
  vendors: [],
  materials: [],
  coupa: [],
  detail: [],
  custom: [],
  admin: [],
  datacheck: [],
};

// Charts whose bucket key maps onto a global-filter dimension (Alt-click filters).
const CHART_FILTER_DIM: Record<string, 'monthKey' | 'plant' | 'purchOrg'> = {
  po_value_by_month: 'monthKey',
  pr_by_month: 'monthKey',
  e2e_by_month: 'monthKey',
  monthly_pr_no_po: 'monthKey',
  delivery_ordered_vs_received: 'monthKey',
  po_by_plant: 'plant',
  pr_by_plant: 'plant',
  wbs_by_plant: 'plant',
  po_value_by_purch_org: 'purchOrg',
};

// Which validation findings surface inline on which tab (G1.5). The Data Check
// tab always shows everything; these are the "you should know while reading
// this page" callouts.
const TAB_FINDINGS: Partial<Record<Tab, string[]>> = {
  pr: ['V-M01', 'V-R03', 'V-R04'],
  po: ['V-B01', 'V-B02', 'V-B03'],
  delivery: ['V-M03', 'V-B07'],
  openitems: ['V-B04'],
};

type ThemeMode = 'auto' | 'light' | 'dark';
function applyTheme(mode: ThemeMode) {
  if (mode === 'auto') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = mode;
  try { localStorage.setItem('pct_theme', mode); } catch { /* private mode */ }
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [tab, setTab] = useState<Tab>('executive');
  const [gf, setGf] = useState<GlobalFilterState>(EMPTY_FILTER);
  const [dataset, setDataset] = useState<DatasetCurrent | null>(null);
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [drill, setDrill] = useState<{ token: string; label: string } | null>(null);
  const [detailInit, setDetailInit] = useState<{ params: Record<string, string>; label: string } | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [editing, setEditing] = useState(false);
  const { layout, update: updateLayout } = useTabLayout(tab);
  const [savedCustom, setSavedCustom] = useState<{ kpis: any[]; charts: any[] }>({ kpis: [], charts: [] });
  const [chartCatalog, setChartCatalog] = useState<{ chartId: string; title?: string }[]>([]);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try { return (localStorage.getItem('pct_theme') as ThemeMode) ?? 'auto'; } catch { return 'auto'; }
  });
  useEffect(() => { applyTheme(theme); }, [theme]);

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
  }, [me]);

  useEffect(() => {
    if (!me) return;
    api.get<{ specs: { kpis: any[]; charts: any[] } }>('/api/v1/custom/saved')
      .then((d) => setSavedCustom(d.specs ?? { kpis: [], charts: [] }))
      .catch(() => undefined);
    api.get<{ charts: { chartId: string; title?: string }[] }>('/api/v1/chart')
      .then((d) => setChartCatalog(d.charts))
      .catch(() => undefined);
  }, [me]);

  // Inline anomaly banners (G1.5): the findings for the published version.
  useEffect(() => {
    if (!me || !dataset || dataset.datasetVersionId === null) return;
    api
      .get<{ findings: Finding[] }>(`/api/v1/dataset/${dataset.datasetVersionId}/validation`)
      .then((d) => setFindings(d.findings))
      .catch(() => setFindings([]));
  }, [me, dataset]);

  // Refetch KPIs whenever the global filter changes. The query string is empty
  // when nothing is selected, which keeps the fast precomputed path in play.
  const gfQuery = globalFilterQuery(gf);
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    api
      .get<{ kpis: Kpi[] }>(`/api/v1/kpi${gfQuery ? `?${gfQuery}` : ''}`)
      .then((d) => {
        if (!cancelled) setKpis(d.kpis);
      })
      .catch(() => {
        if (!cancelled) setKpis([]);
      });
    return () => {
      cancelled = true;
    };
  }, [me, gfQuery]);

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

  // G4: the user's layout reorders/hides/swaps the tab's default slots.
  const kpiSlots = applyLayout(TAB_KPIS[tab], layout, 'kpi');
  const chartSlots = applyLayout(TAB_CHARTS[tab], layout, 'chart');
  const visibleKpis = kpiSlots
    .map((slot) => ({ slot, kpi: kpis.find((k) => k.kpiId === (layout.replaced[slot] ?? slot)) }))
    .filter((x): x is { slot: string; kpi: Kpi } => x.kpi !== undefined);
  const shownCustomKpis = savedCustom.kpis.filter((k) => layout.customKpis.includes(k.title));
  const shownCustomCharts = savedCustom.charts.filter((c) => layout.customCharts.includes(c.title));

  return (
    <div className="app">
      <div className="topbar">
        <h1>Procurement Control Tower</h1>
        <span className="spacer" />
        <span className="who">
          {me.displayName} · {me.roles.join(', ')}
        </span>
        <a
          className="btn secondary"
          style={{ width: 'auto', textDecoration: 'none' }}
          href="/api/v1/snapshot"
          download
          title="Download a static HTML snapshot of the current dashboard (frozen figures, your data scope)"
        >
          ⤓ Snapshot
        </a>
        <button
          className="btn secondary"
          style={{ width: 'auto' }}
          title="Theme: auto follows your system"
          onClick={() => setTheme(theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto')}
        >
          {theme === 'auto' ? '◑ Auto' : theme === 'light' ? '☀ Light' : '☾ Dark'}
        </button>
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

      {dataset?.datasetVersionId != null && <GlobalFilterBar value={gf} onChange={setGf} />}

      <div className="tabs" role="tablist">
        {TABS.map((t) => {
          // v1 shows the open-item total on the menu; PR-side + PO-side open.
          const openBadge =
            t.id === 'openitems'
              ? ['pr_not_approved', 'pr_no_po', 'open_items'].reduce((acc, id) => {
                  const k = kpis.find((x) => x.kpiId === id);
                  return k?.value !== null && k?.value !== undefined ? acc + Number(k.value) : acc;
                }, 0)
              : 0;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {openBadge > 0 && <span className="tab-badge">{formatNumber(openBadge)}</span>}
            </button>
          );
        })}
      </div>

      <main>
        {dataset?.datasetVersionId == null ? (
          <div className="panel">
            <h2>No data yet</h2>
            <p className="note">
              Publish a dataset first: <code>npm run ingest -w @pct/backend</code>
            </p>
          </div>
        ) : tab === 'vendors' ? (
          <VendorsTab onDrill={onDrill} />
        ) : tab === 'materials' ? (
          <MaterialsTab onDrill={onDrill} />
        ) : tab === 'coupa' ? (
          <CoupaTab />
        ) : tab === 'custom' ? (
          <CustomTab onDrill={onDrill} />
        ) : tab === 'admin' ? (
          <AdminTab isAdmin={me.roles.includes('admin')} />
        ) : tab === 'detail' ? (
          <DetailTable
            key={detailInit ? JSON.stringify(detailInit.params) : 'plain'}
            initial={detailInit?.params}
            initialLabel={detailInit?.label}
          />
        ) : tab === 'datacheck' ? (
          <DataCheck versionId={dataset.datasetVersionId} />
        ) : (
          <>
            <LayoutEditBar
              editing={editing}
              setEditing={setEditing}
              layout={layout}
              update={updateLayout}
              kpiOptions={kpis.map((k) => ({ id: k.kpiId, title: k.title })).sort((a, b) => a.title.localeCompare(b.title))}
              chartOptions={chartCatalog.map((c) => ({ id: c.chartId, title: c.title ?? c.chartId }))}
              customOptions={{
                kpis: savedCustom.kpis.map((k) => k.title),
                charts: savedCustom.charts.map((c) => c.title),
              }}
            />
            {(TAB_FINDINGS[tab] ?? []).length > 0 && findings.length > 0 && (
              <div className="anomaly-strip">
                {findings
                  .filter((f) => (TAB_FINDINGS[tab] ?? []).includes(f.ruleId))
                  .filter((f) => f.severity === 'WARNING' || f.severity === 'CAVEAT')
                  .slice(0, 3)
                  .map((f) => (
                    <p key={f.ruleId} className="anomaly">
                      <span className={`sev sev-${f.severity}`}>{f.severity}</span> {f.message}
                    </p>
                  ))}
              </div>
            )}
            {(visibleKpis.length > 0 || shownCustomKpis.length > 0) && (
              <div className="kpi-grid" style={{ marginBottom: '1rem' }}>
                {visibleKpis.map(({ slot, kpi: k }) => (
                  <div key={slot} className={editing ? 'ly-slot' : undefined}>
                    {editing && (
                      <LayoutControls
                        id={slot}
                        kind="kpi"
                        layout={layout}
                        update={updateLayout}
                        currentIds={kpiSlots}
                        swapOptions={kpis.map((x) => ({ id: x.kpiId, title: x.title })).sort((a, b) => a.title.localeCompare(b.title))}
                      />
                    )}
                    <KpiCard kpi={k} onDrill={onDrill} />
                  </div>
                ))}
                {shownCustomKpis.map((spec) => (
                  <div key={`cu-${spec.title}`} className={editing ? 'ly-slot' : undefined}>
                    {editing && (
                      <button
                        className="ly-btn ly-hide" style={{ position: 'absolute', top: 2, right: 2, zIndex: 2 }}
                        title="Remove from this tab"
                        onClick={() => updateLayout((cur) => ({ ...cur, customKpis: cur.customKpis.filter((t) => t !== spec.title) }))}
                      >✕</button>
                    )}
                    <CustomKpiCard spec={spec} onDrill={onDrill} onRemove={() => undefined} />
                  </div>
                ))}
              </div>
            )}
            <div className="chart-grid">
              {chartSlots.map((c) => (
                <div key={c} className={editing ? 'ly-slot' : undefined}>
                  {editing && (
                    <LayoutControls id={c} kind="chart" layout={layout} update={updateLayout} currentIds={chartSlots} />
                  )}
                <ChartPanel
                  chartId={c}
                  onDrill={onDrill}
                  filterQuery={gfQuery}
                  onApplyFilter={
                    CHART_FILTER_DIM[c]
                      ? (bucketKey) => {
                          const dim = CHART_FILTER_DIM[c]!;
                          setGf((cur) =>
                            cur[dim].includes(bucketKey) ? cur : { ...cur, [dim]: [...cur[dim], bucketKey] },
                          );
                        }
                      : undefined
                  }
                />
                </div>
              ))}
              {shownCustomCharts.map((spec) => (
                <div key={`cu-${spec.title}`} className={editing ? 'ly-slot' : undefined}>
                  {editing && (
                    <button
                      className="ly-btn ly-hide" style={{ position: 'absolute', top: 2, right: 2, zIndex: 2 }}
                      title="Remove from this tab"
                      onClick={() => updateLayout((cur) => ({ ...cur, customCharts: cur.customCharts.filter((t) => t !== spec.title) }))}
                    >✕</button>
                  )}
                  <CustomChartPanel spec={spec} onDrill={onDrill} onRemove={() => undefined} />
                </div>
              ))}
            </div>
          </>
        )}
      </main>

      {drill && (
        <DrillModal
          token={drill.token}
          label={drill.label}
          onClose={() => setDrill(null)}
          onOpenDetail={(params, label) => {
            setDetailInit({ params, label });
            setDrill(null);
            setTab('detail');
          }}
        />
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
