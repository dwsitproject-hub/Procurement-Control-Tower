import { useEffect, useState } from 'react';

/**
 * URL routing.
 *
 * The app used to hold the current page in React state, so every page lived at
 * `/` — the address bar never changed, the browser Back button left the app
 * entirely, and a page could not be bookmarked, shared or reloaded in place.
 * Each page now has a real path.
 *
 * Hand-rolled rather than pulled from a library: the route space is a flat list
 * of pages plus one optional sub-page under Admin and Master, which is a
 * `pathname` lookup
 * and a `popstate` listener. A router dependency would be more code shipped to
 * the browser than the entire feature.
 *
 * Deep links work because both nginx configs already end with
 * `try_files $uri $uri/ /index.html`, so a reload on /pr-analysis serves the
 * app rather than a 404.
 */

export type Tab =
  | 'execsummary' | 'executive' | 'pr' | 'po' | 'delivery' | 'approvals' | 'governance' | 'openitems'
  | 'vendors' | 'materials' | 'coupa_src' | 'coupa_inv' | 'detail' | 'master' | 'custom' | 'admin'
  | 'datacheck';

/**
 * Paths are written for a human reading the address bar, so they follow the
 * menu labels rather than the internal tab ids (which are historical: the PO
 * page is `po`, the Sourcing page is `coupa_src`).
 */
export const TAB_PATH: Record<Tab, string> = {
  execsummary: '/executive-summary',
  executive: '/overview',
  openitems: '/open-items',
  pr: '/pr-analysis',
  coupa_src: '/sourcing',
  po: '/po-analysis',
  delivery: '/delivery',
  coupa_inv: '/invoicing-payment',
  approvals: '/approvals',
  materials: '/material-group',
  vendors: '/vendor-360',
  governance: '/governance',
  detail: '/detail-table',
  master: '/master',
  custom: '/custom',
  admin: '/admin',
  datacheck: '/data-quality',
};

/**
 * Where a session lands: the Executive Summary, not the Overview.
 *
 * It is also first in the menu and first in PAGE_KEYS, so the three agree. The
 * redirect in App is permission-aware — a user without access to this page is
 * sent to the first page they DO have — so making it the default cannot lock
 * anyone out of the app.
 */
export const DEFAULT_TAB: Tab = 'execsummary';

const PATH_TAB = new Map<string, Tab>(
  (Object.entries(TAB_PATH) as [Tab, string][]).map(([tab, path]) => [path, tab]),
);

export interface Route {
  tab: Tab;
  /** Second path segment — the Admin sub-page (`/admin/exclusions`). */
  sub: string | null;
}

export function hrefFor(tab: Tab, sub?: string | null): string {
  return sub ? `${TAB_PATH[tab]}/${sub}` : TAB_PATH[tab];
}

export function parsePath(pathname: string): Route {
  // Trailing slashes and an empty path both mean "the default page".
  const clean = pathname.replace(/\/+$/, '');
  if (clean === '') return { tab: DEFAULT_TAB, sub: null };

  const [, first = '', second = ''] = clean.split('/');
  const tab = PATH_TAB.get(`/${first}`);
  if (!tab) return { tab: DEFAULT_TAB, sub: null };
  return { tab, sub: second === '' ? null : second };
}

/** Fired by navigate() so the hook re-reads the URL — popstate covers only the
 *  browser's own Back/Forward. */
const NAV_EVENT = 'pct:navigate';

export function navigate(tab: Tab, sub?: string | null, replace = false): void {
  const href = hrefFor(tab, sub);
  if (href === window.location.pathname) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', href);
  window.dispatchEvent(new Event(NAV_EVENT));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));

  useEffect(() => {
    const sync = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener('popstate', sync);
    window.addEventListener(NAV_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAV_EVENT, sync);
    };
  }, []);

  return route;
}

/**
 * Click handler for a nav link. The nav renders real anchors so the browser's
 * own affordances work — hover preview, copy link, and ctrl/cmd/middle-click to
 * open a page in a new tab — and only a plain left click is intercepted for
 * client-side navigation.
 */
export function linkHandler(tab: Tab, sub?: string | null) {
  return (e: React.MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate(tab, sub);
  };
}
