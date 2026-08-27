import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { SavedViews } from './components/SavedViews';
import { PrTables } from './components/PrTables';
import { PoTables } from './components/PoTables';
import {
  DEFAULT_TAB, TAB_PATH, type Tab, hrefFor, linkHandler, navigate, useRoute,
} from './lib/router';

/**
 * Pages behind their own chunks. Everything used to ship in one bundle, so
 * opening Overview also downloaded Admin, the Coupa pages, the entity views and
 * the custom builder. Each of these is now fetched the first time its page is
 * opened — and most users never open Admin at all.
 *
 * Overview's own building blocks (cards, charts, tables) stay eager: they are
 * the first paint, and deferring them would only add a round trip.
 */
import { ErrorBoundary } from './components/ErrorBoundary';

const ExecSummaryTab = lazy(() => import('./components/ExecSummaryTab').then((m) => ({ default: m.ExecSummaryTab })));
const AdminTab = lazy(() => import('./components/AdminTab').then((m) => ({ default: m.AdminTab })));
const CustomTab = lazy(() => import('./components/CustomTab').then((m) => ({ default: m.CustomTab })));
// Pinned custom cards render on ordinary pages, but only for users who have
// built one — so they are loaded on demand too. Importing them eagerly kept
// the whole builder module in the main bundle for everybody.
const CustomKpiCard = lazy(() => import('./components/CustomTab').then((m) => ({ default: m.CustomKpiCard })));
const CustomChartPanel = lazy(() => import('./components/CustomTab').then((m) => ({ default: m.CustomChartPanel })));
const MaterialsTab = lazy(() => import('./components/EntityViews').then((m) => ({ default: m.MaterialsTab })));
const VendorsTab = lazy(() => import('./components/EntityViews').then((m) => ({ default: m.VendorsTab })));
const CoupaSourcingTab = lazy(() => import('./components/CoupaPages').then((m) => ({ default: m.CoupaSourcingTab })));
const CoupaInvoicesTab = lazy(() => import('./components/CoupaPages').then((m) => ({ default: m.CoupaInvoicesTab })));
import { OverviewCard } from './components/OverviewCards';
import {
  LayoutControls, LayoutEditBar, applyLayout, useTabLayout, type TabLayout,
} from './components/LayoutEdit';

// v1's sidebar: grouped nav with icons (.sb / .nsec / .ni).
const NAV_GROUPS: { section: string; items: { id: Tab; label: string; icon: string }[] }[] = [
  {
    section: 'Main',
    items: [
      // First in the menu: it is the page an executive opens and the only one
      // that states a conclusion rather than presenting a measurement.
      { id: 'execsummary', label: 'Executive Summary', icon: '🎯' },
      { id: 'executive', label: 'Overview', icon: '📊' },
      { id: 'openitems', label: 'Open Items', icon: '🔥' },
    ],
  },
  {
    // Menu order per user decision 5 Aug 2026 (follows the procure-to-pay flow).
    section: 'Analysis',
    items: [
      { id: 'pr', label: 'PR Analysis', icon: '📋' },
      { id: 'coupa_src', label: 'Sourcing', icon: '🛒' },
      { id: 'po', label: 'PO Analysis', icon: '📦' },
      { id: 'delivery', label: 'Delivery', icon: '🚚' },
      { id: 'coupa_inv', label: 'Invoicing & Payment', icon: '💳' },
      { id: 'approvals', label: 'Approvals', icon: '✅' },
      { id: 'materials', label: 'Material Group', icon: '🧱' },
      { id: 'vendors', label: 'Vendor 360', icon: '🏆' },
      { id: 'governance', label: 'Governance', icon: '🏛️' },
    ],
  },
  {
    section: 'Data',
    items: [
      { id: 'detail', label: 'Detail Table', icon: '🧾' },
      { id: 'custom', label: 'Custom', icon: '🧮' },
      { id: 'admin', label: 'Admin', icon: '⚙️' },
      { id: 'datacheck', label: 'Data Quality', icon: '✔️' },
    ],
  },
];

const TAB_KPIS: Record<Tab, string[]> = {
  /**
   * Executive Summary. The first four are the headline tiles; the rest are the
   * two claims the page makes — concentration and fragmentation — computed
   * rather than written into the prose, so they cannot go stale.
   *
   * total_po_amount, po_line_items and unique_suppliers are REUSED, not
   * redefined: they already carry the purchase population (STO and deleted
   * excluded) and are already covered by the parity sweep. A second definition
   * of "committed value" is exactly how two pages come to disagree.
   */
  execsummary: [
    'total_po_amount', 'po_line_items', 'unique_suppliers', 'active_purch_groups',
    'top5_category_share_pct', 'lines_under_25jt_pct', 'value_under_25jt_pct',
    'desks_for_80pct_value', 'vendors_for_80pct_value',
    'ho_share_value_pct', 'ho_share_lines_pct',
  ],
  // Ordered to mirror v1's page layouts.
  executive: [
    'open_po_commitment', 'grir_value', 'pr_pipeline_value', 'cycle_e2e',
    'emergency_pct_value', 'otd_vs_requested', 'demand_realism', 'expedite_effectiveness',
    'wbs_compliance',
    'total_pr_items', 'delivered_gr', 'open_items',
    'cycle_pr_approval', 'cycle_sourcing', 'cycle_po_approval', 'cycle_delivery',
  ],
  openitems: [
    'pr_not_approved', 'pr_no_po', 'po_hold', 'lines_pending_po_approval',
    'po_not_delivered', 'open_items',
    'emergency_open', 'urgent_open', 'avg_unreleased_age', 'urgent_po_before_pr',
    'retro_po_rate', 'open_pr_no_wbs', 'open_pr_with_wbs',
    'commitment_over_60d',
  ],
  pr: [
    'cycle_pr_approval', 'median_pr_approval', 'max_pr_approval', 'unreleased_items', 'total_pr_items',
    'pr_to_po_conversion', 'approved_within_3d', 'oldest_unreleased',
    'emergency_urgent_share', 'pr_approval_lead_time', 'at_risk_demand', 'pr_cancellation_rate', 'pr_deleted',
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
    'cycle_delivery', 'cycle_e2e', 'delivered_gr', 'reversal_rate',
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
  coupa_src: [],
  coupa_inv: [],
  detail: [],
  custom: [],
  admin: [],
  datacheck: [],
};

const TAB_CHARTS: Record<Tab, string[]> = {
  execsummary: ['exec_value_by_category', 'exec_txn_size'],
  executive: ['status_mix', 'po_value_by_month', 'items_by_priority', 'aging_by_priority'],
  openitems: ['aging_severity_by_stage', 'aging_bands', 'open_by_priority', 'unapproved_by_category', 'unreleased_aging_buckets'],
  pr: [
    'pr_by_month', 'items_by_category', 'pr_approval_by_priority',
    'pr_approval_distribution', 'monthly_pr_no_po', 'pr_by_plant', 'wbs_by_plant',
    // v1's Outstanding-PR family + demand shape and first-layer aging (7 Aug 2026).
    'pr_items_by_area', 'pr_outstanding_by_company', 'pr_outstanding_by_porg',
    'pr_outstanding_by_pgrp', 'pr_layer1_aging_by_priority',
  ],
  po: [
    'po_amount_by_area', 'po_amount_by_matcat', 'po_value_by_month', 'po_value_by_category',
    'po_by_plant', 'po_value_by_purch_org', 'po_value_by_pgrp', 'pr_status_by_pgrp',
    'sourcing_by_priority', 'po_approval_by_priority', 'po_approval_distribution',
    'sourcing_by_category', 'commitment_aging',
    // v1's value-bracket and buyer-desk family (7 Aug 2026).
    'po_bracket_value', 'po_bracket_count', 'po_issued_by', 'po_items_by_pgrp',
    'po_count_by_category',
  ],
  delivery: [
    'delivery_ordered_vs_received', 'delivery_by_category', 'delivery_by_priority',
    'delivery_distribution', 'e2e_by_month', 'e2e_by_category', 'movement_mix',
  ],
  approvals: ['pending_pr_by_pic'],
  governance: ['wbs_by_plant', 'unapproved_by_category'],
  vendors: [],
  materials: [],
  coupa_src: [],
  coupa_inv: [],
  detail: [],
  custom: [],
  admin: [],
  datacheck: [],
};

// v1's Overview is three titled sections; ids not listed fall into 'Overview'
// so user-added cards keep appearing. Slot membership survives layout edits.
const EXEC_SECTIONS: { title: string; ids: string[] }[] = [
  {
    title: '📊 Executive Summary',
    ids: [
      'open_po_commitment', 'grir_value', 'pr_pipeline_value', 'cycle_e2e',
      'emergency_pct_value', 'otd_vs_requested', 'demand_realism',
      'expedite_effectiveness', 'wbs_compliance',
    ],
  },
  {
    title: '📋 Overview',
    ids: [
      'total_pr_items', 'delivered_gr', 'open_items',
      'cycle_pr_approval', 'cycle_sourcing', 'cycle_po_approval', 'cycle_delivery',
    ],
  },
];

// v1's status donut; every other chart stays a bar.
const DONUT_CHARTS = new Set(['status_mix', 'po_amount_by_area', 'po_value_by_pgrp']);

// Cards that render v1's wide layout (value left, breakdown rows right).
const TAB_WIDE_IDS: Partial<Record<Tab, string[]>> = {
  executive: ['total_pr_items', 'delivered_gr', 'open_items'],
  openitems: [
    'pr_not_approved', 'pr_no_po', 'po_hold', 'lines_pending_po_approval',
    'po_not_delivered', 'open_items',
  ],
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

/**
 * Boundary for a lazily-loaded page. The fallback is the same spinner the
 * panels use, inside a panel-sized box so the sidebar and header do not jump
 * while the chunk downloads (typically one cached round trip, once per page
 * per deployment).
 */
function PageChunk({ children, tab }: { children: React.ReactNode; tab?: Tab }) {
  return (
    // The boundary is INSIDE main, so a page that throws does not take the header
    // and sidebar with it and the user can still navigate away.
    <ErrorBoundary resetKey={tab}>
      <Suspense fallback={<div className="panel" style={{ minHeight: 220 }}><div className="spinner" /></div>}>
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}
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
  const route = useRoute();
  const tab = route.tab;
  const [gf, setGf] = useState<GlobalFilterState>(EMPTY_FILTER);
  const [dataset, setDataset] = useState<DatasetCurrent | null>(null);
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [drill, setDrill] = useState<{ token: string; label: string } | null>(null);
  const [detailInit, setDetailInit] = useState<{ params: Record<string, string>; label: string } | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [editing, setEditing] = useState(false);
  const { layout, update: updateLayout } = useTabLayout(tab);
  /**
   * Replace the working layout outright — what applying a saved view does.
   * Expressed through the same update() so it persists by the same path a hand
   * edit does; a view that applied only in memory would vanish on reload.
   */
  const replaceLayout = useCallback(
    (next: TabLayout) => updateLayout(() => next),
    [updateLayout],
  );
  const [savedCustom, setSavedCustom] = useState<{ kpis: any[]; charts: any[] }>({ kpis: [], charts: [] });
  const [chartCatalog, setChartCatalog] = useState<{ chartId: string; title?: string }[]>([]);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try { return (localStorage.getItem('pct_theme') as ThemeMode) ?? 'auto'; } catch { return 'auto'; }
  });
  useEffect(() => { applyTheme(theme); }, [theme]);
  const [currency, setCurrency] = useState<'USD' | 'IDR'>(() => {
    try { return (localStorage.getItem('pct_currency') as 'USD' | 'IDR') ?? 'USD'; } catch { return 'USD'; }
  });
  useEffect(() => { try { localStorage.setItem('pct_currency', currency); } catch { /* private mode */ } }, [currency]);

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

  // Saved custom cards are only needed where they can appear: the Custom page,
  // the layout editor, or a page that has pinned one. The chart catalogue is
  // only read by the layout editor and the builder. Neither belongs in the
  // first paint of Overview.
  const needsCustom = tab === 'custom' || editing
    || layout.customKpis.length > 0 || layout.customCharts.length > 0;
  const needsCatalog = tab === 'custom' || editing;
  const loadedCustom = useRef(false);
  const loadedCatalog = useRef(false);

  useEffect(() => {
    if (!me || !needsCustom || loadedCustom.current) return;
    loadedCustom.current = true;
    api.get<{ specs: { kpis: any[]; charts: any[] } }>('/api/v1/custom/saved')
      .then((d) => setSavedCustom(d.specs ?? { kpis: [], charts: [] }))
      .catch(() => { loadedCustom.current = false; });
  }, [me, needsCustom]);

  useEffect(() => {
    if (!me || !needsCatalog || loadedCatalog.current) return;
    loadedCatalog.current = true;
    api.get<{ charts: { chartId: string; title?: string }[] }>('/api/v1/chart')
      .then((d) => setChartCatalog(d.charts))
      .catch(() => { loadedCatalog.current = false; });
  }, [me, needsCatalog]);

  // Inline anomaly banners (G1.5): the findings for the published version.
  useEffect(() => {
    if (!me || !dataset || dataset.datasetVersionId === null) return;
    api
      .get<{ findings: Finding[] }>(`/api/v1/dataset/${dataset.datasetVersionId}/validation`)
      .then((d) => setFindings(d.findings))
      .catch(() => setFindings([]));
  }, [me, dataset]);

  const gfQuery = globalFilterQuery(gf);

  /**
   * KPIs are fetched PER PAGE, and again on every page change.
   *
   * Previously one request pulled all 71 KPIs once and every page read from
   * that snapshot, so opening the dashboard paid for pages nobody visited, and
   * — the reason this changed — the figures were whatever they had been at
   * first paint. Moving between pages after a recompute or a filter change
   * showed stale numbers until a manual reload.
   *
   * Values already fetched stay on screen while the new request is in flight,
   * so navigation never flashes empty cards; each response is merged over the
   * cache. The cache is keyed by dataset version AND filter, so it is dropped
   * whenever either changes — a stale value from a previous filter must never
   * survive into a page opened after it.
   */
  const cacheKey = `${dataset?.datasetVersionId ?? 'none'}|${gfQuery}`;
  const cacheKeyRef = useRef(cacheKey);
  const [kpiLoading, setKpiLoading] = useState(false);

  // Always requested, whatever the page: the header item count and the Open
  // Items badge are chrome, and would otherwise be blank until their own page
  // was opened.
  const CHROME_KPIS = ['total_pr_items', 'pr_not_approved', 'pr_no_po', 'open_items'];

  /**
   * The id list as a STRING, deliberately — the effect below keys on its
   * content, not on an array's identity.
   *
   * useTabLayout re-fetches the saved layout on every page change, so `layout`
   * arrives as a fresh object shortly after the page opens. Keying on identity
   * therefore fired the request twice per navigation. With a content key the
   * second pass is a no-op whenever the resolved ids are unchanged, which is
   * every page that has not been customised; a customised layout still issues
   * a correcting second request rather than rendering the wrong cards.
   */
  const neededKey = useMemo(() => {
    const slots = applyLayout(TAB_KPIS[tab], layout, 'kpi');
    // Layout can swap a slot for a different KPI — ask for what is shown.
    return [...new Set([...slots.map((sl) => layout.replaced[sl] ?? sl), ...CHROME_KPIS])].join(',');
  }, [tab, layout]);

  useEffect(() => {
    if (!me) return;
    // Wait for the published version: it is half the cache key, so fetching
    // before it lands means one request against key "none" and an immediate
    // second one against the real key. There is also nothing to show without a
    // dataset — the page renders "No data yet".
    if (!dataset || dataset.datasetVersionId === null) return;
    if (cacheKeyRef.current !== cacheKey) {
      cacheKeyRef.current = cacheKey;
      setKpis([]);
    }
    if (neededKey === '') return;

    let cancelled = false;
    setKpiLoading(true);
    const qs = new URLSearchParams(gfQuery);
    qs.set('ids', neededKey);
    api
      .get<{ kpis: Kpi[] }>(`/api/v1/kpi?${qs.toString()}`)
      .then((d) => {
        if (cancelled) return;
        setKpis((prev) => {
          const byId = new Map(prev.map((k) => [k.kpiId, k]));
          for (const k of d.kpis) byId.set(k.kpiId, k);
          return [...byId.values()];
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setKpiLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [me, dataset, cacheKey, gfQuery, neededKey]);

  // A page opened from a URL the user has no access to must not render blank.
  const allowedTabs = useMemo(
    () => NAV_GROUPS.flatMap((g) => g.items)
      .filter((t) => !me?.pages || (me.pages[t.id] ?? 'none') !== 'none')
      .map((t) => t.id),
    [me],
  );
  useEffect(() => {
    if (!me || allowedTabs.length === 0) return;
    if (!allowedTabs.includes(tab)) {
      navigate(allowedTabs.includes(DEFAULT_TAB) ? DEFAULT_TAB : allowedTabs[0]!, null, true);
    }
  }, [me, tab, allowedTabs]);

  // An unknown or malformed path (/not-a-real-page, /overview/stray) renders
  // the default page — so rewrite the address bar to match what is on screen,
  // or a reload and a bookmark would disagree with it. Admin is excluded: it
  // owns its own second segment and canonicalises that itself.
  useEffect(() => {
    if (!me || tab === 'admin') return;
    if (window.location.pathname !== hrefFor(tab)) navigate(tab, null, true);
  }, [me, tab, route.sub]);

  // Opening a page part-scrolled is disorienting — the browser only restores a
  // position for real navigations, and these are pushState.
  useEffect(() => { window.scrollTo(0, 0); }, [tab, route.sub]);

  if (!authChecked) {
    return <div className="center-msg"><div className="spinner" />Loading…</div>;
  }
  if (!me) return <Login onSignedIn={setMe} />;

  // An admin-issued default password must be rotated first: the API refuses
  // every other endpoint until it is, so there is nothing useful to render.
  if (me.mustChangePassword) return <ChangePassword me={me} onDone={setMe} />;

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

  const totalItemsBadge = (() => {
    const k = kpis.find((x) => x.kpiId === 'total_pr_items');
    return k?.value !== null && k?.value !== undefined ? Number(k.value) : null;
  })();
  const dataCheckCount = findings.filter((f) => f.severity === 'WARNING' || f.severity === 'CAVEAT' || f.severity === 'BLOCKER').length;

  return (
    <div className="app">
      {/* v1's .bar: navy sticky header */}
      <div className="topbar">
        <span aria-hidden="true" style={{ fontSize: '1.1rem' }}>🏭</span>
        <h1>Procurement Control Tower</h1>
        {totalItemsBadge !== null && <span className="hdr-badge">{formatNumber(totalItemsBadge)} items</span>}
        {dataCheckCount > 0 && (
          <button className="hdr-chip" onClick={() => navigate('datacheck')} title="Open Data Quality">
            ⚠ Data Check ({dataCheckCount})
          </button>
        )}
        <span className="spacer" />
        <span className="who">
          {me.displayName} · {me.roles.join(', ')}
        </span>
        <button
          className="tbtn"
          title="Display currency: money cards and charts switch when an exact per-line conversion exists"
          onClick={() => setCurrency(currency === 'USD' ? 'IDR' : 'USD')}
        >
          {currency === 'USD' ? '$ USD' : 'Rp IDR'}
        </button>
        <a
          className="tbtn"
          href="/api/v1/snapshot"
          download
          title="Download a static HTML snapshot of the current dashboard (frozen figures, your data scope)"
        >
          ⤓ Snapshot
        </a>
        <button
          className="tbtn"
          title="Theme: auto follows your system"
          onClick={() => setTheme(theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto')}
        >
          {theme === 'auto' ? '◑ Auto' : theme === 'light' ? '☀ Light' : '☾ Dark'}
        </button>
        <button className="tbtn" onClick={() => void logout()}>
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

      <div className="shell">
        {/* v1's .sb sidebar: grouped nav, orange active border, open-items badge */}
        <nav className="sb" role="tablist" aria-orientation="vertical">
          {NAV_GROUPS.map((g) => {
            // Pages the user has no access to are not rendered at all (011).
            // An absent map (older API) means "show everything", so a version
            // skew can never lock a user out of their own dashboard.
            const items = g.items.filter(
              (t) => !me.pages || (me.pages[t.id] ?? 'none') !== 'none',
            );
            if (items.length === 0) return null;
            return (
            <div key={g.section}>
              <div className="nsec">{g.section}</div>
              {items.map((t) => {
                const openBadge =
                  t.id === 'openitems'
                    ? ['pr_not_approved', 'pr_no_po', 'open_items'].reduce((acc, id) => {
                        const k = kpis.find((x) => x.kpiId === id);
                        return k?.value !== null && k?.value !== undefined ? acc + Number(k.value) : acc;
                      }, 0)
                    : 0;
                return (
                  // An anchor, not a button: the address bar now reflects the
                  // page, so ctrl/cmd/middle-click should open it in a new tab
                  // and "copy link" should produce something that works.
                  <a
                    key={t.id}
                    href={hrefFor(t.id)}
                    className="ni"
                    role="tab"
                    aria-selected={tab === t.id}
                    aria-current={tab === t.id ? 'page' : undefined}
                    onClick={linkHandler(t.id)}
                  >
                    <span className="ic" aria-hidden="true">{t.icon}</span>
                    {t.label}
                    {openBadge > 0 && <span className="tab-badge">{formatNumber(openBadge)}</span>}
                  </a>
                );
              })}
            </div>
            );
          })}
        </nav>

      <div className="content">
      {dataset?.datasetVersionId != null && <GlobalFilterBar
          value={gf}
          onChange={setGf}
          datasetVersionId={dataset.datasetVersionId}
        />}
      <main>
        {dataset?.datasetVersionId == null ? (
          <div className="panel">
            <h2>No data yet</h2>
            <p className="note">
              Publish a dataset first: <code>npm run ingest -w @pct/backend</code>
            </p>
          </div>
        ) : tab === 'execsummary' ? (
          <>
            {/*
              The same view picker and edit bar the other pages get. Its adders
              are hidden: this page's sections are a fixed set, so the "+ Add…"
              pickers would be empty dropdowns inviting a click that does
              nothing. Hide, move, restore and reset all still apply.
            */}
            <SavedViews
              tab={tab}
              layout={layout}
              applyToWorking={replaceLayout}
              editing={editing}
            />
            <LayoutEditBar
              editing={editing}
              setEditing={setEditing}
              layout={layout}
              update={updateLayout}
              kpiOptions={[]}
              chartOptions={[]}
              customOptions={{ kpis: [], charts: [] }}
              showAdders={false}
            />
            <PageChunk tab={tab}>
            <ExecSummaryTab
              kpis={kpis}
              onDrill={onDrill}
              currency={currency}
              // poDateRange, NOT prDateRange: requisitions here reach back to
              // 2023 while the orders are 2026, and this page reports orders.
              asOfDate={dataset?.poDateRange?.to ?? dataset?.asOfDate ?? null}
              firstDate={dataset?.poDateRange?.from ?? null}
              filterQuery={gfQuery}
              overviewKpis={TAB_KPIS.executive}
              overviewCharts={TAB_CHARTS.executive}
              layout={layout}
              update={updateLayout}
              editing={editing}
            />
            </PageChunk>
          </>
        ) : tab === 'vendors' ? (
          <PageChunk tab={tab}><VendorsTab onDrill={onDrill} /></PageChunk>
        ) : tab === 'materials' ? (
          <PageChunk tab={tab}><MaterialsTab onDrill={onDrill} /></PageChunk>
        ) : tab === 'coupa_src' ? (
          <PageChunk tab={tab}><CoupaSourcingTab /></PageChunk>
        ) : tab === 'coupa_inv' ? (
          <PageChunk tab={tab}><CoupaInvoicesTab /></PageChunk>
        ) : tab === 'custom' ? (
          <PageChunk tab={tab}><CustomTab onDrill={onDrill} /></PageChunk>
        ) : tab === 'admin' ? (
          <PageChunk tab={tab}>
            <AdminTab
              isAdmin={me.roles.includes('admin')}
              canIngest={me.capabilities.includes('ingest')}
              section={route.sub}
              onSection={(id) => navigate('admin', id)}
            />
          </PageChunk>
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
            <SavedViews
              tab={tab}
              layout={layout}
              applyToWorking={replaceLayout}
              editing={editing}
            />
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
            {(visibleKpis.length > 0 || shownCustomKpis.length > 0) && (tab === 'executive' ? (
              <>
                {EXEC_SECTIONS.map((sec) => {
                  const inSec = visibleKpis.filter(({ slot }) => sec.ids.includes(slot));
                  if (inSec.length === 0) return null;
                  // v1's Overview row: the three wide cards first, cycles below.
                  const isOverviewSec = sec.title.includes('Overview');
                  const wideIds = TAB_WIDE_IDS['executive'] ?? [];
                  const wide = isOverviewSec ? inSec.filter(({ slot }) => wideIds.includes(slot)) : [];
                  const rest = isOverviewSec ? inSec.filter(({ slot }) => !wideIds.includes(slot)) : inSec;
                  const controls = (slot: string) => editing && (
                    <LayoutControls
                      id={slot} kind="kpi" layout={layout} update={updateLayout}
                      currentIds={kpiSlots}
                      swapOptions={kpis.map((x) => ({ id: x.kpiId, title: x.title })).sort((a, b) => a.title.localeCompare(b.title))}
                    />
                  );
                  return (
                    <div key={sec.title}>
                      <h2 className="sec-h">
                        {sec.title}
                        {isOverviewSec && dataset?.prDateRange && (
                          <span className="sec-sub">
                            PR Date: {dataset.prDateRange.from} → {dataset.prDateRange.to}
                          </span>
                        )}
                      </h2>
                      {wide.length > 0 && (
                        <div className="ovc-grid">
                          {wide.map(({ slot, kpi: k }) => (
                            <div key={slot} className={editing ? 'ly-slot' : undefined}>
                              {controls(slot)}
                              <OverviewCard kpi={k} onDrill={onDrill} />
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="kpi-grid" style={{ marginBottom: '1rem' }}>
                        {rest.map(({ slot, kpi: k }) => (
                          <div key={slot} className={editing ? 'ly-slot' : undefined}>
                            {controls(slot)}
                            <KpiCard kpi={k} onDrill={onDrill} currency={currency} />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {/* anything user-added or not in a named section */}
                {(() => {
                  const secIds = new Set(EXEC_SECTIONS.flatMap((x) => x.ids));
                  const rest = visibleKpis.filter(({ slot }) => !secIds.has(slot));
                  if (rest.length === 0 && shownCustomKpis.length === 0) return null;
                  return (
                    <div className="kpi-grid" style={{ marginBottom: '1rem' }}>
                      {rest.map(({ slot, kpi: k }) => (
                        <div key={slot} className={editing ? 'ly-slot' : undefined}>
                          {editing && (
                            <LayoutControls
                              id={slot} kind="kpi" layout={layout} update={updateLayout}
                              currentIds={kpiSlots}
                              swapOptions={kpis.map((x) => ({ id: x.kpiId, title: x.title })).sort((a, b) => a.title.localeCompare(b.title))}
                            />
                          )}
                          <KpiCard kpi={k} onDrill={onDrill} currency={currency} />
                        </div>
                      ))}
                      {shownCustomKpis.map((spec) => (
                        <Suspense key={`cu-${spec.title}`} fallback={null}>
                          <Suspense fallback={null}>
                      <CustomKpiCard spec={spec} onDrill={onDrill} onRemove={() => undefined} />
                    </Suspense>
                        </Suspense>
                      ))}
                    </div>
                  );
                })()}
                {/* v1's 🔥 Open Items — Action Required strip */}
                <h2 className="sec-h">🔥 Open Items — Action Required <span className="sec-sub">click a card to see the rows · full page under Open Items</span></h2>
                <div className="act-grid">
                  {([
                    ['pr_not_approved', 'Unapproved PRs', 'var(--crit)', 'avg_wait', 'Avg wait'],
                    ['pr_no_po', 'No PO', '#c2410c', 'avg_wait', 'Avg sourcing wait'],
                    ['po_not_delivered', 'No GR', '#1d4ed8', 'avg_po_appr', 'Avg PO approval'],
                  ] as const).map(([id, label, color, waitKey, waitLabel]) => {
                    const k = kpis.find((x) => x.kpiId === id);
                    if (!k || k.value === null) return null;
                    const wait = k.detail?.[waitKey];
                    return (
                      <button
                        key={id}
                        className="act-card"
                        style={{ ['--c' as string]: color }}
                        onClick={() => k.drillToken && onDrill(k.drillToken, k.title)}
                      >
                        <span className="act-v">{formatNumber(Number(k.value))}</span>
                        <span className="act-l">{label}</span>
                        {wait !== null && wait !== undefined && (
                          <span className="act-wait">{waitLabel}: {formatNumber(Number(wait))} days</span>
                        )}
                        <span className="act-go" onClick={(e) => { e.stopPropagation(); navigate('openitems'); }}>
                          View Details →
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
              {(TAB_WIDE_IDS[tab] ?? []).length > 0 && (
                <div className="ovc-grid">
                  {visibleKpis
                    .filter(({ slot }) => (TAB_WIDE_IDS[tab] ?? []).includes(slot))
                    .map(({ slot, kpi: k }) => (
                      <div key={slot} className={editing ? 'ly-slot' : undefined}>
                        {editing && (
                          <LayoutControls
                            id={slot} kind="kpi" layout={layout} update={updateLayout}
                            currentIds={kpiSlots}
                            swapOptions={kpis.map((x) => ({ id: x.kpiId, title: x.title })).sort((a, b) => a.title.localeCompare(b.title))}
                          />
                        )}
                        <OverviewCard kpi={k} onDrill={onDrill} />
                      </div>
                    ))}
                </div>
              )}
              <div className="kpi-grid" style={{ marginBottom: '1rem' }}>
                {visibleKpis
                  .filter(({ slot }) => !(TAB_WIDE_IDS[tab] ?? []).includes(slot))
                  .map(({ slot, kpi: k }) => (
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
                    <KpiCard kpi={k} onDrill={onDrill} currency={currency} />
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
              </>
            ))}
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
                  variant={DONUT_CHARTS.has(c) ? 'doughnut' : 'bar'}
                  currency={currency}
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
                  <Suspense fallback={null}>
                    <CustomChartPanel spec={spec} onDrill={onDrill} onRemove={() => undefined} />
                  </Suspense>
                </div>
              ))}
            </div>

            {/* v1's PR-page tables: approval bottlenecks + requisitioner demand. */}
            {tab === 'pr' && <PrTables onDrill={onDrill} />}

            {/* v1's PO-page top-spend tables with Vendor/Material 360 popups. */}
            {tab === 'po' && <PoTables onDrill={onDrill} />}

            {/* v1's "Open Items Detail" table: the open rows themselves, with
                the detail facets (category / priority / mat cat / plant) and a
                live row count — server-side, same engine as the Detail tab. */}
            {tab === 'openitems' && (
              <div style={{ marginTop: '1rem' }}>
                <DetailTable
                  key="openitems-detail"
                  initial={{ onlyOpen: 'true' }}
                  initialLabel="Open items only"
                />
              </div>
            )}
          </>
        )}
      </main>
      </div>
      </div>

      {drill && (
        <DrillModal
          token={drill.token}
          label={drill.label}
          onClose={() => setDrill(null)}
          onOpenDetail={(params, label) => {
            setDetailInit({ params, label });
            setDrill(null);
            navigate('detail');
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

// ─────────────────────────────────────────────── forced password change (011)

/**
 * Shown when an admin-issued default password has not been rotated. The API
 * refuses every other endpoint until it is, so this is not merely cosmetic.
 */
function ChangePassword({ me, onDone }: { me: Me; onDone: (me: Me) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (next !== confirm) { setErr('The new passwords do not match.'); return; }
    if (next.length < 12) { setErr('The new password must be at least 12 characters.'); return; }
    setBusy(true);
    try {
      await api.post('/auth/local/change-password', { currentPassword: current, newPassword: next });
      onDone(await api.get<Me>('/api/v1/me'));
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.problem.title : 'Could not change the password.');
    } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <h1>Change your password</h1>
        <p className="sub">
          Signed in as {me.email}. This is a temporary password issued by an administrator —
          choose your own before continuing.
        </p>
        <label>Current (temporary) password
          <input type="password" value={current} autoComplete="current-password"
            onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label>New password
          <input type="password" value={next} autoComplete="new-password"
            onChange={(e) => setNext(e.target.value)} required minLength={12} />
        </label>
        <label>Confirm new password
          <input type="password" value={confirm} autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)} required minLength={12} />
        </label>
        {err && <p className="err">{err}</p>}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set new password'}
        </button>
        <p className="sub" style={{ marginTop: '.6rem' }}>
          At least 12 characters, and different from the temporary one.
        </p>
      </form>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────── login

function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [email, setEmail] = useState('admin@energi-up.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);

  useEffect(() => {
    // The login route redirects (302) only when OIDC is configured AND the
    // Hub is reachable; 404 = not configured, 503 = Hub down. Offer the button
    // only for a real redirect, so users never click a dead SSO link.
    // (redirect:'manual' surfaces a redirect as an opaqueredirect, status 0.)
    fetch('/auth/oidc/login', { method: 'HEAD', redirect: 'manual' })
      .then((r) => setSsoEnabled(r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)))
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
          // 403 means the credential was accepted and the ACCOUNT was refused —
          // disabled or expired. Showing "invalid password" there sends people
          // to reset a password that already works.
          : err instanceof ApiError && err.status === 403
            ? (err.problem.detail || 'This account cannot sign in — ask an administrator.')
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
