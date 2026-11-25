/**
 * Downstream Hub SDK (11 Nov 2026) - usage analytics, JS errors and bug reports
 * for PCT in the Hub's Admin -> Analytic, which Sentinel analyses.
 * D:/Initiative/2026/DWS Hub/SDK-INTEGRATION-GUIDE v2.md.
 *
 * ── Why the script is added from here, not pasted into index.html ──────────
 *
 * The guide's snippet is an inline <script> plus an inline onerror attribute.
 * PCT's CSP is `script-src 'self'` with no 'unsafe-inline' (no CDN, no inline
 * code - deploy/nginx/security-headers.conf), so both would be blocked. The
 * same three things are done here in bundled code instead: the call queue is
 * created first, then the SDK tag is appended with its data-* options and an
 * error handler. The SDK finds its tag through document.currentScript, which
 * holds for a classic script added this way. The Hub's origin is added to
 * script-src and connect-src at image build (Frontend/Dockerfile).
 *
 * Per environment, at build time: VITE_HUB_SDK_URL (the Hub's base address)
 * and VITE_HUB_SDK_KEY (the publishable dwsk_ key from Admin -> Applications
 * -> SDK). Either missing - every local build - and the SDK is simply off:
 * every call below still queues harmlessly and nothing is sent anywhere.
 */

type HubCall = [string, ...unknown[]];
type HubQueue = HubCall[] & { push: (call: HubCall) => number };

declare global {
  interface Window {
    DwsHub?: HubQueue | { push: (call: HubCall) => unknown };
  }
}

const HUB_URL = (import.meta.env['VITE_HUB_SDK_URL'] as string | undefined)?.replace(/\/+$/, '') ?? '';
const HUB_KEY = (import.meta.env['VITE_HUB_SDK_KEY'] as string | undefined) ?? '';
const RELEASE = (import.meta.env['VITE_GIT_SHA'] as string | undefined) ?? '';

export const hubEnabled = HUB_URL !== '' && HUB_KEY !== '';

/** Every call goes through the queue, so it works before the SDK has loaded. */
function hub(...call: HubCall): void {
  // The guide's `push` form: `window.DwsHub?.identify(...)` would be skipped
  // silently while the deferred SDK is still loading.
  (window.DwsHub = window.DwsHub ?? ([] as unknown as HubQueue)).push(call);
}

/** Add the SDK once, at start-up. A no-op when this build has no key. */
export function loadHubSdk(): void {
  if (!hubEnabled || document.querySelector('script[data-pct-hub]')) return;
  window.DwsHub = window.DwsHub ?? ([] as unknown as HubQueue);
  const s = document.createElement('script');
  s.src = `${HUB_URL}/api/sdk/v1/hub-sdk.js`;
  s.defer = true;
  s.setAttribute('data-app-key', HUB_KEY);
  if (RELEASE) s.setAttribute('data-release', RELEASE);
  s.setAttribute('data-pct-hub', '');
  s.onerror = () => {
    console.warn('[DwsHub] the Downstream Hub SDK could not be loaded (blocked or unreachable)');
  };
  document.head.appendChild(s);
}

/**
 * The signed-in user. Called whenever PCT knows who it is - after sign-in AND
 * when a stored session is restored on page load, which is the case the guide
 * warns about. Idempotent on the SDK's side. `hubSubject` is the Hub user id
 * (OIDC `sub`) for SSO users; a local-password user is identified by email
 * alone and shows in the Hub as "Not a Hub account".
 */
export function hubIdentify(me: { email: string; hubSubject?: string | null }): void {
  hub('identify', me.hubSubject ? { id: me.hubSubject, email: me.email } : { email: me.email });
}

/** On sign-out: forget the user and start a new anonymous session. */
export function hubReset(): void {
  hub('reset');
}

/**
 * A business action, under the Hub's "Tracked actions". Names follow the
 * guide's rule (letters, numbers, `_ . : / -`, at most 80); properties stay
 * small and never carry document numbers, names or anything personal.
 */
export function hubTrack(name: string, props?: Record<string, string | number | boolean | null>): void {
  hub('track', name, props ?? {});
}
