# Downstream Hub SDK and Sentinel — PCT

PCT reports usage, JavaScript errors and bug reports to the Downstream Hub
(**Admin → Analytic → Procurement Control Tower**), where **Sentinel** analyses them
against PCT's source code. Source guides: `D:\Initiative\2026\DWS Hub\SDK-INTEGRATION-GUIDE v2.md`
and `SENTINEL-GUIDE.md`. Added 11 Nov 2026.

## What PCT does

| Guide step | In PCT |
|---|---|
| Add the script | `Frontend/src/lib/hub.ts` → `loadHubSdk()`, called first in `main.tsx`. **Not** the guide's inline snippet: PCT's CSP is `script-src 'self'` with no `'unsafe-inline'`, which blocks an inline `<script>` and an inline `onerror`. The same queue, tag, `data-*` options and load-error warning are created from bundled code instead. |
| Identify | `hubIdentify(me)` whenever `me` is known — after sign-in, after the SSO callback, and on a restored session. SSO users send the Hub `sub` (`/api/v1/me` → `hubSubject`, from `app_user.sso_subject`) and email; local-password users send email only ("Not a Hub account"). Always the `push` form. |
| Sign-out | `hubReset()` in `logout()`. |
| Track actions | `report_exported` (Detail Table / drill Excel, with row count), `snapshot_downloaded`, `sap_upload` (files, publish), `sap_sync_now`, `sap_rebuild`, `master_row_added` / `master_row_edited` (relation), `title_renamed`. Properties never carry document numbers, names or anything personal. |
| `data-release` | The git commit, from the `GIT_SHA` build arg. |
| Readable stacks | `esbuild: { keepNames: true }` in `Frontend/vite.config.ts`. |
| CSP | `Frontend/Dockerfile` adds the Hub's origin to `script-src` and `connect-src` — nothing else — and only when the image is built with `HUB_SDK_URL`. |

Without `HUB_SDK_URL` **and** `HUB_SDK_KEY` at build time (every local build) the SDK is off:
no script, no requests, CSP unchanged; the calls above queue harmlessly.

## Staging setup (once)

1. **Hub (staging, `http://test-dwshub.kpndomain.com`)** — an Admin opens **Admin → Applications →
   Procurement Control Tower → SDK** and copies the key (`dwsk_…`). `http://test-pct.kpndomain.com` is
   PCT's registered address there, so no extra allowed origin is needed.
2. **FE server (PuTTY on 172.28.92.56)** — keep the settings beside the compose file. The key is
   *publishable* (it is in the page source by design), so this file is not a secret, but it is per
   environment and stays on the server:

   ```bash
   printf 'HUB_SDK_URL=http://test-dwshub.kpndomain.com\nHUB_SDK_KEY=%s\n' 'dwsk_PASTE_THE_KEY' > /opt/pct/fe-build.env
   ```
   (Edit `dwsk_PASTE_THE_KEY` before pressing Enter.)
3. **Build** with those settings and the release (this replaces the plain `docker build` line in
   `DEPLOY_STAGING.md` §7):

   ```bash
   cd /opt/pct/src && docker build $(grep -E '^[A-Z_]+=' /opt/pct/fe-build.env | sed 's/^/--build-arg /') --build-arg GIT_SHA=$(git rev-parse --short HEAD) -f Frontend/Dockerfile -t pct-web:staging . && docker compose -f /opt/pct/compose.yml up -d --force-recreate web
   ```
4. **Check** — the CSP names the Hub, and the Hub says *Receiving data* within a minute of using PCT:

   ```bash
   curl -sI http://127.0.0.1:3050/ | grep -o "script-src[^;]*"
   ```
   Expect `script-src 'self' http://test-dwshub.kpndomain.com`.

**Production** uses the production Hub and its own key: `HUB_SDK_URL=https://dwshub.kpndomain.com`.
An HTTPS PCT must use the HTTPS Hub (an HTTP Hub would be blocked as mixed content).

## Sentinel settings for PCT (on the Hub)

**Admin → Analytic → Procurement Control Tower → Sentinel settings**:

| Field | Value |
|---|---|
| GitHub repository | `dwsitproject-hub/Procurement-Control-Tower` |
| Branch | `sit2` (staging); the production branch on the production Hub. Used only when a report carries no release — PCT always sends one. |
| Application folder | *(blank — the whole repository is PCT: `Frontend/`, `Backend/`, `packages/`)* |
| Analyse automatically | ✓ |

The Hub's `SENTINEL_GITHUB_TOKEN` must list this repository (fine-grained tokens name repositories
explicitly); **Test repository access** should show the branch and its latest commit.

**Notes for Sentinel** (paste as is):

> Procurement Control Tower (PCT): procurement analytics over SAP exports. React 18 + Vite SPA in
> `Frontend/` (pages in `Frontend/src/components/*Tab.tsx`, charts in `Chart.tsx`, popups in
> `*Modal.tsx` / `EntityViews.tsx`); Express API in `Backend/` under `/api/v1`; shared business rules
> in `packages/rules`. Data: SAP exports (PR List, PR Release, PO List, PO Release, GR List) are picked
> up from a NAS folder twice a day, validated, merged and published as immutable dataset versions; every
> figure is read from the published version and its precomputed chart mart. Coupa (invoices, payments,
> sourcing) syncs every few minutes; exchange rates come from Data Hub. Normal: a chart's count and the
> rows its drill opens are always equal - a difference is a bug. Known quirks: the
> SAP PR Release export carries continuation rows (blank PR No) that rely on file order; a scheduled
> pickup can publish PARTIAL when a file or rows are set aside. Strict CSP: no inline scripts.

## Privacy

The SDK never sends query strings, form contents or request bodies; PCT's tracked actions carry counts
and feature names only. Sentinel pseudonymises email addresses and strips secrets before anything leaves
the Hub (see `SENTINEL-GUIDE.md` → *Privacy and security*).
