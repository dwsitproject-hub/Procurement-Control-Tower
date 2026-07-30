# Technical Documentation 1 — Architecture & Implementation Guide

**Product:** Procurement Control Tower v2
**Version:** 1.0 · **Date:** 30 July 2026
**Audience:** Engineers building and maintaining the system
**Requirements source:** [PRD v2](PRD_v2_Production.md) · [Annex A — Data Contract](PRD_v2_Annex_A_Data_Contract.md) · [Annex B — Database Schema](PRD_v2_Annex_B_Database_Schema.md)
**Companion documents:** [TECH 02 — API Reference](TECH_02_API_Reference.md) · [TECH 03 — Deployment & Operations](TECH_03_Deployment_and_Operations.md)

---

## Contents

1. [How to read this document](#1-how-to-read-this-document)
2. [Architecture](#2-architecture)
3. [Repository layout](#3-repository-layout)
4. [Local development setup](#4-local-development-setup)
5. [Shared packages](#5-shared-packages)
6. [Backend implementation](#6-backend-implementation)
7. [Frontend implementation](#7-frontend-implementation)
8. [Coding standards](#8-coding-standards)
9. [Testing](#9-testing)

---

## 1. How to read this document

Code in this document is **normative for the load-bearing parts** — authentication, scope enforcement, drill tokens, ingestion, coercion, publish. Those are where a plausible-looking mistake produces silently wrong numbers or a security hole, so they are written out rather than described.

Everything else is described and left to the implementer.

Three rules govern the whole codebase. If you remember nothing else:

1. **No business logic outside `packages/rules`.** If a number is computed, it is computed by a pure, unit-tested function in that package. Controllers orchestrate; SQL aggregates; the frontend renders.
2. **No query without a scope.** There is no code path that reads a fact table without a user scope composed into the predicate. This is enforced structurally (§6.5.3), not by review.
3. **Never fabricate a value.** Unknown is `null`, and `null` renders as `—`. No `DEFAULT 0`, no defaulted currency, no coalesce-to-zero on a measure. This is the property that made the v1 prototype trustworthy and it is the easiest one to lose.

---

## 2. Architecture

### 2.1 Instance topology

Three instances per environment. The frontend instance is the sole public entry point and reverse-proxies to the backend, which is what makes the session cookie first-party (§2.3).

```
                        ┌───────────────────────────────────────────────┐
  browser ─── HTTPS ───▶│ INSTANCE 1 — Edge                             │
                        │  nginx: TLS · static SPA · reverse proxy      │
                        │  procurement.energi-up.com                    │
                        │    /api/*  /auth/*  ──▶ backend               │
                        │    /*                ──▶ /var/www/pct         │
                        └──────────────────┬────────────────────────────┘
                                           │ :3000  private network
                        ┌──────────────────▼────────────────────────────┐
                        │ INSTANCE 2 — Application                      │
                        │  ┌─────────────────┐  ┌────────────────────┐  │
                        │  │ api (NestJS)    │  │ worker (BullMQ)    │  │
                        │  │ HTTP only       │  │ ingest·transform·  │  │
                        │  │ no jobs         │  │ notify·schedule    │  │
                        │  └─────────────────┘  └────────────────────┘  │
                        │  /mnt/sap_exports  (CIFS, read-only)          │
                        │  /var/lib/pct/spool (uploads)                 │
                        └────────┬───────────────────────┬──────────────┘
                          :5432  │                       │ :6379
                        ┌────────▼───────────────────────▼──────────────┐
                        │ INSTANCE 3 — Data                             │
                        │  PostgreSQL 16          Redis 7               │
                        └───────────────────────────────────────────────┘
```

The API and worker are **separate processes from the same image**, differing only by entrypoint. A five-minute transformation therefore cannot degrade interactive latency, and the two scale independently.

### 2.2 Request path

```
browser
  └─▶ nginx (instance 1)
        ├─ static asset?      ─▶ /var/www/pct, immutable cache headers
        └─ /api/* | /auth/*   ─▶ http://10.0.0.20:3000
              └─▶ NestJS
                    ├─ SessionMiddleware   → load session from Redis by cookie
                    ├─ AuthGuard           → is there an authenticated principal?
                    ├─ RolesGuard          → does the role satisfy @RequireRole?
                    ├─ ScopeInterceptor    → attach resolved DataScope to the request
                    ├─ Controller          → validate DTO (Zod), orchestrate
                    ├─ Service             → compose SQL with scope, or enqueue a job
                    └─ Repository          → Drizzle / raw SQL against the current version view
```

### 2.3 Why single-origin is not negotiable

If the SPA and the API are on different origins, the session cookie must be `SameSite=None; Secure`, and `Secure` requires HTTPS. Over plain HTTP a split origin **cannot** hold a session: login appears to succeed server-side, the browser silently drops the cookie, and every subsequent API call returns 401 in a redirect loop back to login.

Serving everything from one hostname makes the cookie first-party, so `SameSite=Lax` works on HTTP and HTTPS alike, and **CORS is disabled entirely** — removing a whole class of misconfiguration.

| Layout | Scheme | SameSite | Secure | Works |
|---|---|---|---|:--:|
| Single origin | HTTP | `Lax` | false | ✅ |
| Single origin | HTTPS | `Lax` | true | ✅ |
| Split origins | HTTPS | `None` | true | ✅ (needs CORS + credentials) |
| Split origins | HTTP | either | either | ❌ |

### 2.4 Sequence — SP-initiated SSO

```
browser          nginx        api                     DWS Hub
  │  GET /auth/oidc/login     │                          │
  ├────────────▶├────────────▶│                          │
  │             │             │ generate state, nonce,   │
  │             │             │ PKCE verifier+challenge  │
  │             │             │ store in Redis (10 min)  │
  │  302 → Hub /api/sso/authorize?…code_challenge…       │
  │◀────────────┤◀────────────┤                          │
  │  GET /api/sso/authorize                              │
  ├─────────────────────────────────────────────────────▶│
  │  user authenticates at the Hub                        │
  │  302 → /auth/oidc/callback?code=…&state=…            │
  │◀─────────────────────────────────────────────────────┤
  │  GET /auth/oidc/callback  │                          │
  ├────────────▶├────────────▶│ load+delete flow state   │
  │             │             │ verify state matches     │
  │             │             │ POST /api/sso/token      │
  │             │             │  (JSON body!)            │
  │             │             ├─────────────────────────▶│
  │             │             │  { id_token }            │
  │             │             │◀─────────────────────────┤
  │             │             │ verify RS256 vs JWKS,    │
  │             │             │ iss / aud / exp / nonce  │
  │             │             │ upsert user by `sub`     │
  │             │             │ create session in Redis  │
  │  303 → /  + Set-Cookie: pct_sid                      │
  │◀────────────┤◀────────────┤                          │
```

### 2.5 Sequence — IdP-initiated SSO (the flow that breaks stock libraries)

The user clicks the app tile in the Hub dashboard. **`/auth/oidc/login` never runs.** The Hub creates the PKCE challenge itself and redirects straight to the callback, passing the verifier in the query string.

```
browser                              api                     DWS Hub
  │ click app tile in Hub dashboard                            │
  ├───────────────────────────────────────────────────────────▶│
  │ 302 → /auth/oidc/callback?code=…&state=…&code_verifier=…   │
  │◀───────────────────────────────────────────────────────────┤
  │ GET /auth/oidc/callback     │                              │
  ├────────────────────────────▶│ no flow state in Redis       │
  │                             │ code_verifier IS in query    │
  │                             │  ⇒ IdP-initiated branch      │
  │                             │ POST /api/sso/token (JSON)   │
  │                             ├─────────────────────────────▶│
  │                             │  { id_token }                │
  │                             │◀─────────────────────────────┤
  │                             │ ⚠ NO state to check.         │
  │                             │ The id_token signature is    │
  │                             │ the ONLY trust anchor.       │
  │                             │ Verify RS256 vs JWKS +       │
  │                             │ iss / aud / exp. Never skip. │
  │ 303 → / + Set-Cookie        │                              │
  │◀────────────────────────────┤                              │
```

A stock OIDC client fails here with a state-mismatch error, because it expects to have stored `state` itself. Both branches must be implemented (§6.2.4).

### 2.6 Sequence — automatic ingestion

```
scheduler (repeatable job, every 30 min)
  │
  ├─▶ SynologyCifsSource.list()            /mnt/sap_exports
  │     ├─ mount readable?  no → ingest.source_unavailable, stop
  │     ├─ settle check: skip mtime < 30s ago, or size changed since last poll
  │     └─ sha256 each candidate
  │
  ├─▶ bundleHash = sha256(sorted file hashes)
  │     └─ already PUBLISHED? → no-op, log, stop         ← idempotency
  │
  ├─▶ classify by header signature
  │     └─ incomplete bundle? → ingest.incomplete_bundle, stop
  │
  └─▶ createBatch(source='synology') ──▶ ingest queue
        │
        ├─ SCANNING     safety checks
        ├─ PARSING      stream rows → staging.raw_row (COPY)
        ├─ VALIDATING   structural → referential → semantic → business
        │                 any BLOCKER → FAILED, prior version keeps serving
        ├─ TRANSFORMING create partitions, build facts/dims/bridge, refresh mart
        ├─ READY        complete but not active
        └─ PUBLISHED    single-row pointer swap (atomic)
              └─▶ notify queue: data.published
```

### 2.7 Sequence — KPI read and drill

```
GET /api/v1/kpi?plant=EU71
  └─▶ resolve scope from session
      └─▶ cache key = (versionId, filterHash, scopeHash)
            ├─ hit  → return
            └─ miss → SELECT FROM mart.kpi_value WHERE version_id=… AND scope…
                        └─▶ each row carries drill_predicate
                              └─▶ sign → drillToken (15 min, session-bound)

GET /api/v1/drill/{token}
  └─▶ verify signature, expiry, session binding
      └─▶ predicate.scope ∩ session.scope   (intersection, never union)
            └─▶ compile predicate → parameterised SQL against the SAME version
                  └─▶ rows, paginated

  Counts are equal by construction: the aggregate and the drill are the same
  predicate against the same immutable version.
```

---

## 3. Repository layout

One repository, separate deployables. The API contract and its consumer stay in lockstep; the instances stay independent.

```
procurement-control-tower/
├── Backend/
│   ├── src/
│   │   ├── main.ts                     # API entrypoint
│   │   ├── worker.ts                   # worker entrypoint (same image)
│   │   ├── app.module.ts
│   │   ├── config/
│   │   │   ├── env.schema.ts           # Zod; process refuses to start if invalid
│   │   │   └── config.module.ts
│   │   ├── common/
│   │   │   ├── guards/                 # AuthGuard, RolesGuard
│   │   │   ├── interceptors/           # ScopeInterceptor, RequestIdInterceptor
│   │   │   ├── decorators/             # @RequireRole, @Public, @CurrentUser, @Scope
│   │   │   ├── filters/                # ProblemJsonExceptionFilter
│   │   │   └── logging/                # Pino config, redaction
│   │   ├── db/
│   │   │   ├── schema/                 # Drizzle table definitions (mirrors Annex B)
│   │   │   ├── client.ts               # pool, transaction helper
│   │   │   └── sql/                    # reviewed analytics SQL, one file per query
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   ├── authz/
│   │   │   ├── ingest/
│   │   │   │   ├── sources/            # FileSource implementations
│   │   │   │   ├── parse/              # SheetRowStream adapter
│   │   │   │   ├── classify/           # header-signature matching
│   │   │   │   └── pipeline/           # batch state machine
│   │   │   ├── validate/
│   │   │   │   └── checks/             # one file per rule id (V-S01, V-M01, …)
│   │   │   ├── transform/
│   │   │   │   ├── facts/
│   │   │   │   ├── mart/
│   │   │   │   └── publish.ts
│   │   │   ├── analytics/
│   │   │   │   ├── kpi/
│   │   │   │   ├── charts/
│   │   │   │   └── drill/
│   │   │   ├── export/
│   │   │   ├── notify/
│   │   │   │   └── templates/
│   │   │   ├── admin/
│   │   │   ├── audit/
│   │   │   └── health/
│   │   └── queues/                     # queue definitions, processors, scheduler
│   ├── test/
│   ├── Dockerfile
│   └── package.json
│
├── Frontend/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── app/                        # router, providers, AuthGate, ErrorBoundary
│   │   ├── features/
│   │   │   ├── executive/  pr/  po/  delivery/  approvals/
│   │   │   ├── governance/ openitems/ datacheck/
│   │   │   ├── entity/                 # vendor360, material, category
│   │   │   ├── ingest/                 # upload, batch history, validation report
│   │   │   └── admin/
│   │   ├── components/
│   │   │   ├── FreshnessBanner.tsx
│   │   │   ├── KpiCard.tsx
│   │   │   ├── ChartFrame.tsx
│   │   │   ├── DrillModal.tsx
│   │   │   └── DataTable/
│   │   ├── lib/
│   │   │   ├── api.ts                  # fetch wrapper, problem+json handling
│   │   │   ├── format.ts               # adaptive units, dates, currency
│   │   │   └── drill.ts
│   │   └── vendor/                     # pinned libraries — NO CDN
│   ├── Dockerfile                      # build stage only; output is static
│   └── package.json
│
├── packages/
│   ├── contracts/                      # DTOs, Zod schemas, KPI ids, enums
│   └── rules/                          # PURE business rules — the correctness core
│       ├── src/
│       │   ├── coerce.ts               # Annex A §A.9
│       │   ├── sto.ts
│       │   ├── wbs.ts
│       │   ├── movement.ts
│       │   ├── status.ts
│       │   ├── fx.ts
│       │   ├── aging.ts
│       │   └── linkage.ts
│       └── test/                       # ≥95% branch coverage required
│
├── db/
│   ├── migrations/                     # forward-only, reviewed
│   └── seed/                           # roles, movement types, events, templates
│
├── tests/
│   ├── fixtures/                       # frozen anonymised dataset
│   ├── golden/                         # expected KPI values
│   └── e2e/                            # Playwright
│
├── deploy/
│   ├── compose/                        # docker-compose per instance
│   ├── nginx/
│   ├── systemd/                        # CIFS mount unit
│   └── env/                            # .env.example per environment
│
└── Docs/
```

---

## 4. Local development setup

### 4.1 Prerequisites

Node.js 22 LTS · pnpm 9 · Docker + Compose · `openssl`.

### 4.2 Bring up dependencies

```bash
docker compose -f deploy/compose/dev-deps.yml up -d
```

Starts PostgreSQL 16 on `5432`, Redis 7 on `6379`, ClamAV on `3310`, and MailHog on `8025` (captures all outbound mail so nobody is ever emailed from a dev machine).

### 4.3 Install and configure

```bash
pnpm install
cp deploy/env/.env.development Backend/.env
openssl rand -base64 48
```

Paste that value into `SESSION_SECRET`. Then apply schema and seed:

```bash
pnpm --filter backend db:migrate
pnpm --filter backend db:seed
```

### 4.4 Load the test fixture

```bash
pnpm --filter backend fixture:load
```

Ingests `tests/fixtures/` through the real pipeline and publishes a dataset version, so a fresh clone has queryable data in about a minute.

### 4.5 Run

```bash
pnpm dev
```

Runs the API on `3000`, the worker, and the Vite dev server on `5173`. **Vite proxies `/api` and `/auth` to `localhost:3000`**, reproducing the single-origin layout locally — so cookie behaviour in development matches production instead of differing in exactly the way that hides auth bugs.

```ts
// Frontend/vite.config.ts
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api':  { target: 'http://localhost:3000', changeOrigin: false },
      '/auth': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
});
```

### 4.6 Developing without the DWS Hub

The Hub is usually unreachable from a developer machine. Set `LOCAL_AUTH_ENABLED=true` and `LOCAL_AUTH_REQUIRE_MFA=false` in development only; the seed creates `dev.admin@energi-up.com` / `dev-password-change-me` with `admin` and scope `*`.

**Both SSO flows must still be exercised against staging before any auth change merges.** Local-account login does not test the OIDC paths at all.

### 4.7 Useful commands

```bash
pnpm test                              # unit + contract
pnpm --filter rules test --coverage    # must be ≥95% branch
pnpm test:golden                       # KPI regression vs fixture
pnpm test:e2e                          # Playwright
pnpm lint && pnpm typecheck
pnpm --filter backend db:generate      # new migration from schema diff
pnpm --filter backend fixture:regen    # regenerate golden numbers (needs review)
```

---

## 5. Shared packages

### 5.1 `packages/rules` — the correctness core

Pure functions over plain data. No database, no HTTP, no clock, no environment. Everything time-dependent takes the as-of date as a parameter, which is what makes aging deterministic and testable.

#### 5.1.1 Coercion (Annex A §A.9)

Written explicitly rather than inherited from a parser's implicit behaviour, because these rules are the difference between 22% of receipts being counted and being silently zeroed.

```ts
// packages/rules/src/coerce.ts

/** SAP numeric: thousands separators, trailing minus, blank-vs-zero.
 *  Returns null for blank/unparseable — NEVER 0. */
export function parseVal(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  let s = String(raw).trim();
  if (s === '') return null;

  let negative = false;
  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1).trim(); }  // SAP trailing minus
  else if (s.startsWith('-')) { negative = true; s = s.slice(1).trim(); }

  s = s.replace(/\s/g, '');
  // 1.234.567,89 (European) vs 1,234,567.89 (Anglo)
  if (/,\d{1,2}$/.test(s) && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');

  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Document numbers stay strings: leading zeros and length are significant. */
export function parseDocNo(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/** '0' is the null sentinel for PO Report `Item of requisition` (9,094 rows). */
export function parseReqItem(raw: unknown): number | null {
  const s = parseDocNo(raw);
  if (s === null || s === '0') return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Dates: Excel serial, ISO, dd.MM.yyyy. Returns a plain yyyy-mm-dd — no
 *  timezone conversion ever, because a posting date is a calendar date. */
export function parseDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  if (raw instanceof Date) return toIsoDate(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate());

  if (typeof raw === 'number') {           // Excel serial, 1900 system with the 1900 leap bug
    if (raw < 1 || raw > 2958465) return null;
    const ms = Math.round((raw - 25569) * 86400000);
    const d = new Date(ms);
    return toIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  const s = String(raw).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return toIsoDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);        // 14.01.2026
  if (m) return toIsoDate(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);        // ambiguous — see note
  if (m) return toIsoDate(+m[3], +m[2], +m[1]);         // dd/MM/yyyy, per the SAP locale
  return null;
}

function toIsoDate(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Currency normalisation: `US$` and `USD` both occur in one export. */
export function normCurrency(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (s === '') return null;
  return s === 'US$' ? 'USD' : s;
}

/** Header normalisation for signature matching and alias healing. */
export function normHeader(raw: unknown): string {
  return String(raw ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** PR Report `Deletion indicator` is the literal string 'true'/'false'. */
export function parseBoolString(raw: unknown): boolean | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'true' || s === 'x') return true;
  if (s === 'false') return false;
  if (s === '') return null;
  return null;
}
```

> **`dd/MM/yyyy` is ambiguous.** The parser assumes day-first, matching the SAP export locale. If a feed ever arrives month-first, dates 1–12 silently transpose. Contract check V-S06 asserts every parsed date falls inside the batch's plausible range, which catches gross transposition but not `03/04` vs `04/03`. Prefer ISO or `dd.MM.yyyy` at source.

#### 5.1.2 Movement types (Annex A §A.6.1)

```ts
// packages/rules/src/movement.ts
export type PostingClass = 'receipt' | 'reversal' | 'transfer' | 'transfer_reversal';

export interface MovementRule {
  readonly class: PostingClass;
  readonly signFactor: 1 | -1;
  readonly countsAsReceipt: boolean;
}

export const MOVEMENT_REGISTER: Readonly<Record<string, MovementRule>> = Object.freeze({
  '101': { class: 'receipt',           signFactor:  1, countsAsReceipt: true  },
  '102': { class: 'reversal',          signFactor: -1, countsAsReceipt: true  },
  '122': { class: 'reversal',          signFactor: -1, countsAsReceipt: true  },
  '641': { class: 'transfer',          signFactor:  1, countsAsReceipt: false },
  '642': { class: 'transfer_reversal', signFactor: -1, countsAsReceipt: false },
});

/** Unregistered types are a BLOCKER (V-R07). Never guess. */
export function lookupMovement(mvt: string): MovementRule | null {
  return MOVEMENT_REGISTER[mvt.trim()] ?? null;
}

/** The sign is DERIVED from the movement type, never trusted from the export.
 *  The current export happens to sign reversals negative, so v1's `qty += qty`
 *  netted by luck. This makes it independent of that convention. */
export function signedQty(mvt: string, qtyInUnitOfEntry: number): number {
  const rule = lookupMovement(mvt);
  if (!rule) throw new Error(`Unregistered movement type: ${mvt}`);
  return Math.abs(qtyInUnitOfEntry) * rule.signFactor;
}
```

#### 5.1.3 STO, WBS, aging, FX

```ts
// packages/rules/src/sto.ts
/** Exactly ends-with. EU70 qualifies; EO21/SC21/PS21/JP21 do not. */
export function isSto(docType: string | null, suffix = '70'): boolean {
  return (docType ?? '').trim().endsWith(suffix);
}
```

```ts
// packages/rules/src/wbs.ts
export type WbsStatus = 'compliant' | 'violation' | 'not_required' | 'indeterminate';

export interface WbsConfig {
  materialThresholdIdr: number;   // admin-configurable (D1)
  serviceThresholdIdr: number;
  basis: 'per_item' | 'per_pr_total';
}

export function wbsStatus(
  item: { materialCode: string | null; totalValueIdr: number | null; wbsElement: string | null },
  cfg: WbsConfig,
): WbsStatus {
  // Zero or missing valuation cannot be tested at ANY threshold.
  // 4,211 items (20.9%) land here. Never 'compliant' — absence of data is not compliance.
  if (item.totalValueIdr === null || item.totalValueIdr === 0) return 'indeterminate';

  const isService = (item.materialCode ?? '').trim() === '';
  const threshold = isService ? cfg.serviceThresholdIdr : cfg.materialThresholdIdr;

  if (item.totalValueIdr < threshold) return 'not_required';
  return (item.wbsElement ?? '').trim() !== '' ? 'compliant' : 'violation';
}
```

```ts
// packages/rules/src/aging.ts
/** Aging is ALWAYS relative to the dataset's as-of date. There is deliberately
 *  no access to the clock here: v1 used wall-clock time, so reopening an
 *  unchanged export six months later inflated every >60d KPI by ~180 days. */
export function agingDays(asOfDate: string, refDate: string | null): number | null {
  if (!refDate) return null;
  return Math.floor((Date.parse(asOfDate + 'T00:00:00Z') - Date.parse(refDate + 'T00:00:00Z')) / 86400000);
}
```

```ts
// packages/rules/src/fx.ts
export interface FxRate { currency: string; year: number; month: number; usdPerUnit: number; }
export type FxDerivation = 'direct' | 'inverted' | 'triangulated';

export interface FxResolution {
  usdPerUnit: number | null;
  year: number | null;
  month: number | null;
  basis: 'period_matched' | 'nearest_earlier' | 'fallback_latest' | 'unavailable';
}

/** Period-matched (D3): a document converts at its OWN month's average rate.
 *  v1 used only the newest month, so January POs were valued at July rates. */
export function resolveRate(
  table: ReadonlyMap<string, FxRate>,   // key: `${currency}|${year}|${month}`
  currency: string,
  documentDate: string,
): FxResolution {
  if (currency === 'USD') return { usdPerUnit: 1, year: null, month: null, basis: 'period_matched' };

  const year = +documentDate.slice(0, 4);
  const month = +documentDate.slice(5, 7);

  const exact = table.get(`${currency}|${year}|${month}`);
  if (exact) return { usdPerUnit: exact.usdPerUnit, year, month, basis: 'period_matched' };

  const earlier = [...table.values()]
    .filter(r => r.currency === currency && (r.year < year || (r.year === year && r.month <= month)))
    .sort((a, b) => b.year - a.year || b.month - a.month)[0];
  if (earlier) return { usdPerUnit: earlier.usdPerUnit, year: earlier.year, month: earlier.month, basis: 'nearest_earlier' };

  const latest = [...table.values()]
    .filter(r => r.currency === currency)
    .sort((a, b) => b.year - a.year || b.month - a.month)[0];
  if (latest) return { usdPerUnit: latest.usdPerUnit, year: latest.year, month: latest.month, basis: 'fallback_latest' };

  // No rate: null, NEVER 0, NEVER defaulted to IDR.
  return { usdPerUnit: null, year: null, month: null, basis: 'unavailable' };
}

/** Strict no-silent-conversion: a USD total exists only if EVERY currency
 *  present in scope is convertible. Otherwise the caller renders per currency. */
export function strictUsdTotal(
  amountsByCurrency: ReadonlyMap<string, number>,
  rate: (ccy: string) => number | null,
): { usd: number | null; missing: string[] } {
  let total = 0;
  const missing: string[] = [];
  for (const [ccy, amt] of amountsByCurrency) {
    const r = rate(ccy);
    if (r === null) missing.push(ccy);
    else total += amt * r;
  }
  return missing.length > 0 ? { usd: null, missing } : { usd: total, missing: [] };
}
```

```ts
// packages/rules/src/status.ts
export type PoReleaseState = 'approved' | 'pending' | 'not_subject_to_release' | 'deleted';

/** Annex A §A.4.1. Deletion comes from `Deletion indicator`, NOT from a blank
 *  release indicator — v1's error, which hid 241 live lines / IDR 1.51bn. */
export function poReleaseState(po: {
  deletionIndicator: string | null;
  releaseIndicator: string | null;
  releaseGroup: string | null;
}): PoReleaseState {
  if ((po.deletionIndicator ?? '').trim().toUpperCase() === 'L') return 'deleted';

  const ri = (po.releaseIndicator ?? '').trim();
  const rg = (po.releaseGroup ?? '').trim();

  if (ri === '1' || ri === '2' || ri === 'C') return 'approved';
  if (ri === 'X') return 'pending';
  if (ri === '' && rg === '') return 'not_subject_to_release';   // D2: flag_only
  return 'pending';
}

export type RowStatus =
  | 'PR-Deleted' | 'Unapproved PR' | 'PR Approved-No PO' | 'PO-Deleted' | 'HOLD PO'
  | 'PO-Not Approved' | 'PO-No GR' | 'Partially Delivered' | 'Delivered' | 'Fully Reversed';

/** Evaluated in a fixed order: deletion → hold → release → receipt.
 *  Release-exempt lines skip the not-approved test and fall through to their
 *  receipt-driven status, carrying releaseExempt=true for the flag marker. */
export function rowStatus(r: {
  prDeleted: boolean;
  hasPo: boolean;
  prFullyReleased: boolean;
  poReleaseState: PoReleaseState | null;
  poIncomplete: boolean;
  orderedQty: number | null;
  netReceiptQty: number | null;
  receiptPostings: number;
}): { status: RowStatus; releaseExempt: boolean } {
  const exempt = r.poReleaseState === 'not_subject_to_release';

  if (r.prDeleted) return { status: 'PR-Deleted', releaseExempt: exempt };

  if (!r.hasPo) {
    return { status: r.prFullyReleased ? 'PR Approved-No PO' : 'Unapproved PR', releaseExempt: false };
  }

  if (r.poReleaseState === 'deleted') return { status: 'PO-Deleted', releaseExempt: false };
  if (r.poIncomplete)                 return { status: 'HOLD PO', releaseExempt: exempt };
  if (r.poReleaseState === 'pending') return { status: 'PO-Not Approved', releaseExempt: false };

  const net = r.netReceiptQty ?? 0;
  if (r.receiptPostings > 0 && net <= 0) return { status: 'Fully Reversed', releaseExempt: exempt };
  if (net <= 0)                          return { status: 'PO-No GR', releaseExempt: exempt };
  if (r.orderedQty !== null && net < r.orderedQty)
                                         return { status: 'Partially Delivered', releaseExempt: exempt };
  return { status: 'Delivered', releaseExempt: exempt };
}
```

### 5.2 `packages/contracts`

Zod schemas that are the single source of truth for request and response shapes. Types are inferred, never hand-written twice.

```ts
// packages/contracts/src/kpi.ts
import { z } from 'zod';

export const KPI_IDS = [
  'demand_realism', 'expedite_effectiveness', 'grir_over_60d', 'commitment_over_60d',
  'wbs_compliance', 'cycle_pr_approval', 'cycle_sourcing', 'cycle_po_approval',
  'cycle_delivery', 'cycle_e2e', 'retro_po_rate', 'split_sourcing', 'reversal_rate',
  'sto_share', 'direct_po_share',
] as const;
export type KpiId = (typeof KPI_IDS)[number];

export const KpiValueSchema = z.object({
  kpiId: z.enum(KPI_IDS),
  status: z.enum(['ok', 'insufficient_sample', 'disabled', 'unavailable']),
  /** null unless status === 'ok'. The frontend renders '—'. */
  value: z.number().nullable(),
  numerator: z.number().nullable(),
  denominator: z.number().nullable(),
  sampleSize: z.number().int().nullable(),
  unit: z.enum(['ratio', 'percent', 'days', 'usd', 'idr', 'count']),
  currencyBasis: z.enum(['usd_strict', 'per_currency', 'idr_based']).nullable(),
  /** Rendered verbatim in the card tooltip when status !== 'ok'. */
  statusReason: z.string().nullable(),
  drillToken: z.string().nullable(),
});

export const KpiResponseSchema = z.object({
  datasetVersionId: z.number().int(),
  asOfDate: z.string(),
  kpis: z.array(KpiValueSchema),
});
export type KpiResponse = z.infer<typeof KpiResponseSchema>;
```

---

## 6. Backend implementation

### 6.1 Bootstrap and configuration

The process must refuse to start on invalid configuration. A silent default on anything security- or correctness-relevant is a defect.

```ts
// Backend/src/config/env.schema.ts
import { z } from 'zod';

/** Single-value guard. Comma-joining OIDC_REDIRECT_URI yields `invalid_grant`
 *  from the token endpoint; comma-joining APP_BASE_URL yields a port-parse
 *  crash. Both are documented failure modes — reject at boot, loudly. */
const singleUrl = z.string().url().refine(v => !v.includes(','), {
  message: 'must be exactly one URL — register multiple redirect URIs on the Hub, configure one here',
});

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']),
  APP_BASE_URL: singleUrl,
  PORT: z.coerce.number().int().positive().default(3000),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),

  OIDC_DISCOVERY_URL: singleUrl.refine(v => !/[<>]|%3c|%3e/i.test(v), {
    message: 'contains an unreplaced <placeholder>',
  }),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_REDIRECT_URI: singleUrl,
  OIDC_SCOPES: z.string().default('openid email profile'),

  SESSION_SECRET: z.string().min(32),
  SESSION_COOKIE_NAME: z.string().default('pct_sid'),
  SESSION_COOKIE_SAMESITE: z.enum(['Lax', 'Strict', 'None']).default('Lax'),
  SESSION_COOKIE_SECURE: z.coerce.boolean(),
  SESSION_IDLE_TIMEOUT_MIN: z.coerce.number().int().positive().default(60),
  SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().positive().default(12),

  LOCAL_AUTH_ENABLED: z.coerce.boolean().default(false),
  LOCAL_AUTH_REQUIRE_MFA: z.coerce.boolean().default(true),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  DATASET_VERSIONS_RETAINED: z.coerce.number().int().min(2).default(12),

  SYNOLOGY_MOUNT_PATH: z.string().min(1),
  SYNOLOGY_POLL_CRON: z.string().min(1),
  UPLOAD_SPOOL_PATH: z.string().min(1),
  UPLOAD_MAX_FILE_MB: z.coerce.number().int().positive().default(60),
  UPLOAD_MAX_BATCH_MB: z.coerce.number().int().positive().default(200),
  INGEST_FILE_SETTLE_SECONDS: z.coerce.number().int().min(5).default(30),
  CLAMAV_HOST: z.string().min(1),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_SECURE: z.enum(['none', 'starttls', 'tls']),
  SMTP_FROM: z.string().min(1),
  NOTIFY_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(20),
})
.superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production') {
    if (!env.SESSION_COOKIE_SECURE)
      ctx.addIssue({ code: 'custom', message: 'SESSION_COOKIE_SECURE must be true in production' });
    if (env.LOCAL_AUTH_ENABLED && !env.LOCAL_AUTH_REQUIRE_MFA)
      ctx.addIssue({ code: 'custom', message: 'local auth in production requires MFA' });
  }
  if (env.SESSION_COOKIE_SAMESITE === 'None' && !env.SESSION_COOKIE_SECURE)
    ctx.addIssue({ code: 'custom', message: 'SameSite=None requires Secure=true — browsers reject otherwise' });
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('FATAL: invalid configuration\n' +
      parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
    process.exit(1);
  }
  return parsed.data;
}
```

### 6.2 Authentication

#### 6.2.1 Approach

Discovery and JWKS verification use `jose` and direct `fetch` rather than a full OIDC client library. Three reasons:

1. The Hub's token endpoint requires a **JSON body**, which most OAuth libraries do not emit — they send form encoding and get `unsupported_grant_type`.
2. The IdP-initiated flow has **no stored state**, which stock libraries treat as a fatal CSRF error.
3. The security requirements (verify RS256 against JWKS, enforce `iss`/`aud`/`exp`) are short, explicit and directly testable when written out.

`jose` handles JWKS fetching, caching and key rotation.

#### 6.2.2 Discovery

```ts
// Backend/src/modules/auth/oidc-discovery.service.ts
import { createRemoteJWKSet } from 'jose';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

@Injectable()
export class OidcDiscoveryService implements OnModuleInit {
  private discovery!: Discovery;
  private jwks!: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly cfg: ConfigService, private readonly log: Logger) {}

  async onModuleInit() {
    // Fail fast at boot rather than on a user's first login.
    await this.refresh();
  }

  private async refresh() {
    const res = await fetch(this.cfg.get('OIDC_DISCOVERY_URL'), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    const d = (await res.json()) as Discovery;

    for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (!d[k]) throw new Error(`OIDC discovery missing ${k}`);
    }
    this.discovery = d;
    // createRemoteJWKSet caches keys and refetches on unknown `kid` — key
    // rotation on the Hub needs no restart here.
    this.jwks = createRemoteJWKSet(new URL(d.jwks_uri), { cooldownDuration: 30_000 });
    this.log.log({ issuer: d.issuer }, 'OIDC discovery loaded');
  }

  get meta() { return this.discovery; }
  get keys() { return this.jwks; }
}
```

> **Verify the backend's own network path to the Hub**, not just the browser's. The browser needs `/authorize`; the backend needs discovery, `/token` and `/jwks`. From inside instance 2:
> ```bash
> curl -s -o /dev/null -w '%{http_code}\n' "$OIDC_DISCOVERY_URL"
> ```

#### 6.2.3 Starting SP-initiated login

```ts
// Backend/src/modules/auth/oidc.controller.ts
import { createHash, randomBytes } from 'node:crypto';

const b64url = (b: Buffer) => b.toString('base64url');

@Public()
@Get('oidc/login')
async login(@Res() res: Response, @Query('returnTo') returnTo?: string) {
  const state    = b64url(randomBytes(32));
  const nonce    = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  // Flow state in Redis, keyed by state, 10-minute TTL, single-use.
  await this.flowStore.put(state, { nonce, verifier, returnTo: safeReturnTo(returnTo) }, 600);

  const url = new URL(this.discovery.meta.authorization_endpoint);
  url.searchParams.set('client_id', this.cfg.get('OIDC_CLIENT_ID'));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', this.cfg.get('OIDC_REDIRECT_URI'));
  url.searchParams.set('scope', this.cfg.get('OIDC_SCOPES'));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');   // never 'plain'
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);

  res.redirect(302, url.toString());
}

/** Open-redirect guard: only same-origin relative paths are honoured. */
function safeReturnTo(v: string | undefined): string {
  if (!v || !v.startsWith('/') || v.startsWith('//')) return '/';
  return v;
}
```

#### 6.2.4 The callback — both flows

This is the highest-risk function in the codebase. Read the comments before changing it.

```ts
@Public()
@Get('oidc/callback')
async callback(
  @Query('code') code: string,
  @Query('state') state: string | undefined,
  @Query('code_verifier') queryVerifier: string | undefined,
  @Req() req: Request,
  @Res() res: Response,
) {
  if (!code) throw new BadRequestException('missing code');

  let verifier: string;
  let expectedNonce: string | null = null;
  let returnTo = '/';
  let flow: 'sp' | 'idp';

  if (queryVerifier) {
    // ── IdP-initiated: the user clicked our tile in the Hub dashboard. ──
    // /auth/oidc/login never ran, so there is no stored state and NO state to
    // compare. A stock OIDC library throws MismatchingStateError here.
    // The id_token signature is therefore the ONLY trust anchor: iss, aud and
    // exp verification below are mandatory, not optional.
    flow = 'idp';
    verifier = queryVerifier;
  } else {
    // ── SP-initiated: we started it, so state must match exactly. ──
    flow = 'sp';
    if (!state) throw new UnauthorizedException('missing state');
    const stored = await this.flowStore.take(state);     // atomic get+delete: single use
    if (!stored) throw new UnauthorizedException('unknown or expired state');
    verifier = stored.verifier;
    expectedNonce = stored.nonce;
    returnTo = stored.returnTo;
  }

  // ── Token exchange ──
  // JSON body, NOT form-encoded: form encoding returns unsupported_grant_type.
  // redirect_uri is REQUIRED: omitting it returns invalid_request.
  // No client_secret exists — this is a public client.
  const tokenRes = await fetch(this.discovery.meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: this.cfg.get('OIDC_REDIRECT_URI'),
      client_id: this.cfg.get('OIDC_CLIENT_ID'),
    }),
  });

  if (!tokenRes.ok) {
    // ALWAYS log the OAuth error body. An opaque 400 is undiagnosable; the body
    // names the actual problem (unsupported_grant_type, invalid_grant, ...).
    const body = await tokenRes.text();
    this.log.warn({ status: tokenRes.status, body: body.slice(0, 500), flow }, 'token exchange failed');
    throw new UnauthorizedException('SSO login failed');
  }

  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  if (!id_token) throw new UnauthorizedException('no id_token in token response');

  // ── Verify. Never skip, never accept alg:none. ──
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(id_token, this.discovery.keys, {
      issuer: this.discovery.meta.issuer,
      audience: this.cfg.get('OIDC_CLIENT_ID'),
      algorithms: ['RS256'],
      clockTolerance: 30,
    }));
  } catch (err) {
    this.log.warn({ err: String(err), flow }, 'id_token verification failed');
    throw new UnauthorizedException('SSO login failed');
  }

  if (expectedNonce && claims.nonce !== expectedNonce) {
    throw new UnauthorizedException('nonce mismatch');
  }

  // `sub` is the primary key. Email is a display attribute and it changes.
  const sub = typeof claims.sub === 'string' ? claims.sub : null;
  if (!sub) throw new BadRequestException('invalid token payload (no subject)');
  const email = String(claims.email ?? '').trim().toLowerCase();

  const user = await this.users.upsertFromSso({ sub, email, name: String(claims.name ?? email) });
  if (!user.isActive) throw new ForbiddenException('account is disabled');

  await this.sessions.create(res, user.id, { flow, ip: req.ip, ua: req.get('user-agent') });
  await this.audit.record({ action: 'auth.login', actorUserId: user.id, outcome: 'success',
                            detail: { method: 'sso', flow } });

  // 303 so the browser issues a GET carrying the fresh cookie.
  res.redirect(303, returnTo);
}
```

#### 6.2.5 First-login provisioning

```ts
async upsertFromSso(p: { sub: string; email: string; name: string }) {
  const existing = await this.repo.findBySsoSubject(p.sub);
  if (existing) {
    await this.repo.touchLogin(existing.id, p.email, p.name);   // email may have changed
    return existing;
  }
  // New SSO user: Viewer role, ZERO data scope. They can log in and see the
  // shell, and no procurement data at all, until an Admin grants scope.
  // Never infer role or scope from an email domain or an unmapped Hub group.
  return this.repo.createSsoUser({ ...p, role: 'viewer', scopes: [] });
}
```

#### 6.2.6 Sessions

```ts
// Backend/src/modules/auth/session.service.ts
@Injectable()
export class SessionService {
  async create(res: Response, userId: string, meta: SessionMeta): Promise<void> {
    const sid = randomBytes(32).toString('base64url');   // opaque; no claims in the cookie
    const now = Date.now();
    await this.redis.set(
      `sess:${sid}`,
      JSON.stringify({ userId, createdAt: now, lastSeenAt: now, ...meta }),
      'EX', this.cfg.get('SESSION_ABSOLUTE_TIMEOUT_HOURS') * 3600,
    );
    await this.redis.sadd(`sess:user:${userId}`, sid);    // enables admin revoke-all

    res.cookie(this.cfg.get('SESSION_COOKIE_NAME'), sid, {
      httpOnly: true,
      secure: this.cfg.get('SESSION_COOKIE_SECURE'),
      sameSite: this.cfg.get('SESSION_COOKIE_SAMESITE').toLowerCase() as 'lax',
      path: '/',
      // No `domain` — host-only cookie, scoped to the single origin.
    });
  }

  /** Idle timeout is enforced here, on read, not by cookie expiry. */
  async load(sid: string): Promise<SessionData | null> {
    const raw = await this.redis.get(`sess:${sid}`);
    if (!raw) return null;
    const s = JSON.parse(raw) as SessionData;

    const idleMs = this.cfg.get('SESSION_IDLE_TIMEOUT_MIN') * 60_000;
    if (Date.now() - s.lastSeenAt > idleMs) { await this.destroy(sid); return null; }

    s.lastSeenAt = Date.now();
    await this.redis.set(`sess:${sid}`, JSON.stringify(s), 'KEEPTTL');
    return s;
  }
}
```

Session id rotates on any privilege change:

```ts
async rotate(res: Response, oldSid: string): Promise<void> {
  const s = await this.load(oldSid);
  if (!s) return;
  await this.destroy(oldSid);
  await this.create(res, s.userId, { ip: s.ip, ua: s.ua, flow: s.flow });
}
```

### 6.3 Authorization

#### 6.3.1 Explicit access declaration on every route

A missing declaration is a **lint error**, not a silent public endpoint.

```ts
// Backend/src/common/decorators/require-role.decorator.ts
export const RequireRole = (...roles: RoleCode[]) => SetMetadata('roles', roles);
export const Public = () => SetMetadata('public', true);
```

```js
// eslint.config.js — custom rule
// Every method on a class decorated with @Controller must carry exactly one of
// @Public or @RequireRole. Enforced at build time so "I forgot the guard"
// cannot reach production.
'pct/require-explicit-access': 'error',
```

#### 6.3.2 Scope resolution

```ts
// Backend/src/modules/authz/scope.service.ts
export interface ScopeEntry { companyCode: string; plant: string; purchOrg: string; }

@Injectable()
export class ScopeService {
  /** Cached per user for 60s; invalidated on any scope change. */
  async resolve(userId: string): Promise<ScopeEntry[]> {
    const cached = await this.redis.get(`scope:${userId}`);
    if (cached) return JSON.parse(cached);
    const rows = await this.repo.findScopes(userId);
    await this.redis.set(`scope:${userId}`, JSON.stringify(rows), 'EX', 60);
    return rows;
  }
}
```

#### 6.3.3 Structural enforcement — no query without a scope

Discipline is not enough; the type system does the work. Every fact query takes a `ScopedQuery` that only `ScopeService` can mint.

```ts
// Backend/src/modules/authz/scoped-query.ts
declare const brand: unique symbol;

/** Branded type. Cannot be constructed outside this module, so a repository
 *  method requiring it CANNOT be called without a resolved scope. */
export interface ScopedQuery {
  readonly [brand]: 'ScopedQuery';
  readonly entries: readonly ScopeEntry[];
  readonly userId: string;
}

export function mintScopedQuery(userId: string, entries: readonly ScopeEntry[]): ScopedQuery {
  return { entries, userId } as ScopedQuery;
}

/** Compose scope into SQL. Empty scope yields FALSE — a user with no grant
 *  sees nothing, which is the default state of every new SSO user. */
export function scopePredicate(sq: ScopedQuery, alias: string): SQL {
  if (sq.entries.length === 0) return sql`false`;

  const clauses = sq.entries.map(e => {
    const parts: SQL[] = [];
    if (e.companyCode !== '*') parts.push(sql`${sql.identifier(alias)}.company_code = ${e.companyCode}`);
    if (e.plant       !== '*') parts.push(sql`${sql.identifier(alias)}.plant        = ${e.plant}`);
    if (e.purchOrg    !== '*') parts.push(sql`${sql.identifier(alias)}.purch_org    = ${e.purchOrg}`);
    return parts.length ? sql`(${sql.join(parts, sql` AND `)})` : sql`true`;
  });

  return sql`(${sql.join(clauses, sql` OR `)})`;
}
```

```ts
// Every fact repository method has this shape. There is no overload without `sq`.
async findPoLines(sq: ScopedQuery, f: PoLineFilter, page: Page): Promise<PoLineRow[]> {
  return this.db.execute(sql`
    SELECT ${POL_COLUMNS}
      FROM core.v_po_line pol
     WHERE ${scopePredicate(sq, 'pol')}
       AND ${poLineFilterPredicate(f, 'pol')}
     ORDER BY ${orderBy(page.sort, 'pol')}
     LIMIT ${page.limit} OFFSET ${page.offset}
  `);
}
```

### 6.4 Drill tokens

The mechanism that makes "drill count equals chart count" true by construction.

```ts
// Backend/src/modules/analytics/drill/drill-token.service.ts
import { CompactEncrypt, compactDecrypt } from 'jose';

export interface DrillPredicate {
  grain: 'pr_item' | 'po_line' | 'gr_posting' | 'pr_release' | 'po_release';
  datasetVersionId: number;
  filters: Record<string, unknown>;     // whitelisted keys only
  scope: readonly ScopeEntry[];         // the scope in force when the figure was computed
  label: string;
}

@Injectable()
export class DrillTokenService {
  private readonly key: Uint8Array;     // derived from SESSION_SECRET via HKDF

  /** Encrypted, not merely signed: the predicate reveals filter internals and
   *  the issuing scope, neither of which belongs in a client-visible string. */
  async issue(p: DrillPredicate, sessionId: string): Promise<string> {
    const payload = JSON.stringify({
      ...p,
      sid: sha256(sessionId),                       // binding, not the id itself
      exp: Math.floor(Date.now() / 1000) + 900,     // 15 minutes
    });
    return new CompactEncrypt(new TextEncoder().encode(payload))
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .encrypt(this.key);
  }

  async open(token: string, sessionId: string, currentScope: readonly ScopeEntry[]): Promise<DrillPredicate> {
    let parsed;
    try {
      const { plaintext } = await compactDecrypt(token, this.key);
      parsed = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      throw new UnauthorizedException('invalid drill token');
    }

    if (parsed.exp < Math.floor(Date.now() / 1000)) throw new UnauthorizedException('drill token expired');

    // Session binding: a token shared or replayed by another session is rejected.
    if (parsed.sid !== sha256(sessionId)) {
      await this.audit.record({ action: 'drill.token_replay', outcome: 'denied',
                                detail: { grain: parsed.grain } });
      throw new ForbiddenException('drill token does not belong to this session');
    }

    // Defence in depth: INTERSECT the embedded scope with the caller's current
    // scope. A token issued before a scope was revoked cannot outlive it, and a
    // token can never widen access.
    return { ...parsed, scope: intersectScopes(parsed.scope, currentScope) };
  }
}
```

```ts
// Compiling a predicate to SQL: whitelist keys, parameterise values.
// A predicate never becomes a SQL string fragment.
const FILTER_COMPILERS: Record<string, (v: unknown, a: string) => SQL> = {
  status:        (v, a) => sql`${sql.identifier(a)}.status = ${String(v)}`,
  statusIn:      (v, a) => sql`${sql.identifier(a)}.status = ANY(${asStringArray(v)})`,
  monthKey:      (v, a) => sql`to_char(${sql.identifier(a)}.document_date,'YYYY-MM') = ${String(v)}`,
  vendorCode:    (v, a) => sql`${sql.identifier(a)}.vendor_code = ${String(v)}`,
  isSto:         (v, a) => sql`${sql.identifier(a)}.is_sto = ${Boolean(v)}`,
  releaseExempt: (v, a) => sql`${sql.identifier(a)}.release_exempt = ${Boolean(v)}`,
  agingGt:       (v, a) => sql`${sql.identifier(a)}.aging_days > ${asInt(v)}`,
  wbsStatus:     (v, a) => sql`${sql.identifier(a)}.wbs_status = ${String(v)}`,
  // ...
};

export function compilePredicate(p: DrillPredicate, alias: string): SQL {
  const parts = Object.entries(p.filters).map(([k, v]) => {
    const c = FILTER_COMPILERS[k];
    if (!c) throw new Error(`unknown drill filter: ${k}`);   // fail closed
    return c(v, alias);
  });
  const scoped = scopePredicate(mintScopedQuery(p.scope), alias);
  return parts.length ? sql`${scoped} AND ${sql.join(parts, sql` AND `)}` : scoped;
}
```

### 6.5 Ingestion

#### 6.5.1 Source abstraction

```ts
// Backend/src/modules/ingest/sources/file-source.ts
export interface DiscoveredFile {
  handle: string;            // absolute path, or spool id
  displayName: string;       // original filename — ESCAPE before display
  byteSize: number;
  mtime: Date | null;
}

export interface FileSource {
  readonly kind: 'synology' | 'manual';
  list(): Promise<DiscoveredFile[]>;
  open(handle: string): Promise<Readable>;
}
```

Both implementations feed the same pipeline. That is what makes "manual upload runs identical validation" structural rather than a policy someone has to remember.

#### 6.5.2 Synology source with the settle check

```ts
// Backend/src/modules/ingest/sources/synology-cifs.source.ts
@Injectable()
export class SynologyCifsSource implements FileSource {
  readonly kind = 'synology' as const;

  async list(): Promise<DiscoveredFile[]> {
    const root = this.cfg.get('SYNOLOGY_MOUNT_PATH');

    // Mount health: an unreadable mount must NOT look like "no new data".
    try { await fs.access(root, fs.constants.R_OK); }
    catch {
      await this.events.emit('ingest.source_unavailable', { path: root });
      throw new ServiceUnavailableException(`share not readable: ${root}`);
    }

    const settleMs = this.cfg.get('INGEST_FILE_SETTLE_SECONDS') * 1000;
    const now = Date.now();
    const out: DiscoveredFile[] = [];

    for (const name of await fs.readdir(root)) {
      if (!/\.xlsx$/i.test(name)) continue;
      const full = path.join(root, name);
      const st = await fs.stat(full);
      if (!st.isFile()) continue;

      // Settle check: skip a file SAP may still be writing. Two conditions —
      // recently modified, or size changed since the previous poll. A file must
      // present a stable size across two consecutive observations.
      if (now - st.mtimeMs < settleMs) { this.log.debug({ name }, 'skipped: too recent'); continue; }
      const prev = await this.redis.get(`ingest:size:${name}`);
      await this.redis.set(`ingest:size:${name}`, String(st.size), 'EX', 86400);
      if (prev !== null && prev !== String(st.size)) { this.log.debug({ name }, 'skipped: size changed'); continue; }

      out.push({ handle: full, displayName: name, byteSize: st.size, mtime: st.mtime });
    }
    return out;
  }

  /** Streamed. The mount is read-only, so nothing here can modify source files. */
  async open(handle: string): Promise<Readable> {
    const root = path.resolve(this.cfg.get('SYNOLOGY_MOUNT_PATH'));
    const resolved = path.resolve(handle);
    // Path-traversal guard even though handles are internally generated.
    if (!resolved.startsWith(root + path.sep)) throw new ForbiddenException('path outside share');
    return createReadStream(resolved);
  }
}
```

#### 6.5.3 Idempotency

```ts
export function bundleHash(files: { sha256: string }[]): string {
  const sorted = files.map(f => f.sha256).sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}
```

```ts
const hash = bundleHash(scanned);
const already = await this.batchRepo.findPublishedByBundleHash(hash);
if (already) {
  this.log.info({ batchId: already.id, hash }, 'bundle unchanged — no-op');
  return { outcome: 'noop' };
}
```

Backed by `ux_batch_bundle_published` (Annex B §B.6), so the guarantee holds even if two workers race. This is what makes a 30-minute poll safe.

#### 6.5.4 Row streaming adapter

```ts
// Backend/src/modules/ingest/parse/sheet-row-stream.ts
export interface SheetRow { rowNumber: number; values: (string | number | Date | null)[]; }

export interface SheetRowStream {
  headers(): Promise<string[]>;
  rows(): AsyncIterable<SheetRow>;
}
```

> **Implementation note.** The adapter exists to isolate the reader library. The reference implementation uses `exceljs`'s streaming `WorkbookReader` for bounded memory; verify the exact iteration API against the pinned version, and keep the isolation so swapping readers touches one file. Do **not** rely on any reader's implicit cell coercion — all coercion goes through `packages/rules/coerce.ts` (§5.1.1), which is unit-tested against the Annex A §A.9 rules.

#### 6.5.5 Classification

```ts
// Backend/src/modules/ingest/classify/signature.ts
type Feed = 'pr' | 'prel' | 'po' | 'por' | 'gr' | 'fx';

interface Signature { feed: Feed; all?: string[]; any?: string[]; none?: string[]; }

/** Order matters: most specific first. Filename plays NO role — the current
 *  filenames embed a date range that changes every refresh. */
const SIGNATURES: Signature[] = [
  { feed: 'po',   all: ['purchasingdocument'],
                  any: ['netordervalue','netprice','orderquantity','stilltobedeliveredvalue'],
                  none:['pono','prno'] },
  { feed: 'gr',   all: ['movementtype','postingdate'] },
  { feed: 'por',  all: ['pono'], any: ['picrelease','approvedate'], none: ['purchasingdocument'] },
  { feed: 'prel', all: ['prno'], any: ['picrelease','gapapprovalleadtime'] },
  { feed: 'pr',   all: ['purchaserequisition'],
                  any: ['itemofrequisition','requisitiondate','quantityrequested'],
                  none:['purchasingdocument'] },
];

export function classify(headers: string[]): Feed | null {
  const set = new Set(headers.map(normHeader).filter(Boolean));
  const has = (k: string) => set.has(k);

  for (const s of SIGNATURES) {
    if (s.all?.some(k => !has(k))) continue;
    if (s.any && !s.any.some(has)) continue;
    if (s.none?.some(has)) continue;
    return s.feed;
  }
  if (isRateTable(set)) return 'fx';
  return null;      // unrecognised — reported, NEVER forced into a slot
}

function isRateTable(set: Set<string>): boolean {
  const rateish = [...set].some(h => h.includes('rate') && h !== 'ratio');
  const pair = set.has('from') && set.has('to');
  const simple = ['currency','ccy','curr','currencycode'].some(h => set.has(h)) && rateish && set.size <= 4;
  return (pair && rateish) || simple;
}
```

#### 6.5.6 Batch state machine

```ts
// Backend/src/modules/ingest/pipeline/batch.processor.ts
@Processor('ingest')
export class BatchProcessor {
  async process(job: Job<{ batchId: number }>) {
    const { batchId } = job.data;
    const log = this.log.child({ batchId });

    try {
      await this.advance(batchId, 'SCANNING');     await this.scan(batchId);
      await this.advance(batchId, 'PARSING');      await this.parse(batchId);
      await this.advance(batchId, 'VALIDATING');
      const findings = await this.validate(batchId);

      if (findings.some(f => f.severity === 'BLOCKER')) {
        // Prior published version keeps serving, untouched.
        await this.fail(batchId, `${findings.filter(f => f.severity === 'BLOCKER').length} blocker(s)`);
        await this.events.emit('ingest.failed', { batchId, findings });
        return;
      }

      await this.advance(batchId, 'TRANSFORMING');
      const versionId = await this.transform.run(batchId);
      await this.advance(batchId, 'READY');

      // Automatic batches publish immediately; manual batches wait for confirmation.
      const batch = await this.batchRepo.get(batchId);
      if (batch.sourceKind === 'synology') {
        await this.publish.run(versionId, null);
        await this.events.emit(
          findings.some(f => f.severity === 'CAVEAT') ? 'data.published.with_caveats' : 'data.published',
          { versionId },
        );
      }
    } catch (err) {
      log.error({ err }, 'batch failed');
      await this.fail(batchId, errorMessage(err));
      await this.events.emit('ingest.failed', { batchId, reason: errorMessage(err) });
      throw err;     // let BullMQ record the failure
    }
  }
}
```

Concurrency is bounded to one transforming batch at a time:

```ts
new Worker('ingest', processor, { connection, concurrency: 1 });
```

### 6.6 Validation

One file per rule id, each self-describing, so the validation report and the code cannot drift.

```ts
// Backend/src/modules/validate/checks/check.ts
export interface Check {
  id: string;                                    // 'V-S02', 'V-M01', 'V-B08'
  severity: 'BLOCKER' | 'CAVEAT' | 'WARNING' | 'INFO';
  feed?: Feed;
  run(ctx: ValidationContext): Promise<Finding[]>;
}
```

```ts
// Backend/src/modules/validate/checks/v-m01-deliv-date-semantic.ts
/** The check v1 lacked entirely: a column can keep its name and change meaning.
 *  `Deliv. date(From/to)` is present, populated and correctly typed — it passes
 *  every structural check — yet equals `Release Date` on 99.40% of rows.
 *  Failing this disables Demand Realism instead of rendering a fabricated 0.3%. */
export const VM01: Check = {
  id: 'V-M01',
  severity: 'CAVEAT',
  feed: 'pr',
  async run(ctx) {
    const { total, differing } = await ctx.db.one<{ total: number; differing: number }>(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (
               WHERE deliv_date_raw IS DISTINCT FROM release_date
             )::int AS differing
        FROM staging.pr_item_typed
       WHERE batch_id = ${ctx.batchId}
    `);

    const pct = total === 0 ? 0 : (differing / total) * 100;
    if (pct >= 50) return [];

    return [{
      ruleId: 'V-M01',
      severity: 'CAVEAT',
      feed: 'pr',
      message:
        `Requested delivery date is not distinct from release date ` +
        `(${pct.toFixed(2)}% of rows differ, expected >= 50%). ` +
        `The column is not a need-by date. Demand Realism remains disabled. See PRD 13.1.1.`,
      affectedRows: total - differing,
      measured: { expected: '>=50%', actual: `${pct.toFixed(2)}%`, total, differing },
      disablesKpis: ['demand_realism'],
    }];
  },
};
```

### 6.7 Transformation and publish

```ts
// Backend/src/modules/transform/publish.ts
@Injectable()
export class PublishService {
  /** Atomic: one transaction, one pointer row. Users never observe a partial
   *  dataset, and a failure leaves the prior version serving. */
  async run(versionId: number, userId: string | null): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.execute(sql`SELECT core.publish_version(${versionId}, ${userId})`);
    });

    // Every cache key embeds the version id, so publishing invalidates
    // everything at once with no per-key bookkeeping.
    await this.cache.bumpVersionEpoch();

    await this.audit.record({
      action: 'dataset.publish', actorUserId: userId, objectType: 'dataset_version',
      objectId: String(versionId), outcome: 'success',
    });

    await this.queues.retention.add('prune', { keep: this.cfg.get('DATASET_VERSIONS_RETAINED') });
  }
}
```

Receipt derivation, showing the two corrected rules together:

```sql
-- Backend/src/db/sql/build_receipts.sql
WITH receipts AS (
  SELECT po_no, po_item,
         -- Corrected (a): the receipt DATE comes from movement type 101 ONLY.
         -- v1 used the earliest posting across all types, so 641 stock-transfer
         -- postings pulled 1,695 of 15,134 line keys a median 7 days too early.
         MIN(posting_date) FILTER (WHERE movement_type = '101')        AS receipt_date,
         -- Corrected (b): sign DERIVED from the movement register, and only
         -- receipt-class postings count. 641/642 are tracked separately.
         SUM(signed_qty)   FILTER (WHERE counts_as_receipt)            AS receipt_qty_net,
         SUM(signed_qty)   FILTER (WHERE NOT counts_as_receipt)        AS transit_qty_net,
         count(*)          FILTER (WHERE movement_type = '101')        AS receipt_count,
         count(*)          FILTER (WHERE posting_class = 'reversal')   AS reversal_count
    FROM core.fact_gr_posting
   WHERE dataset_version_id = $1
   GROUP BY po_no, po_item
)
UPDATE core.fact_po_line pol
   SET receipt_date    = r.receipt_date,
       receipt_qty_net = r.receipt_qty_net,
       transit_qty_net = r.transit_qty_net,
       receipt_count   = COALESCE(r.receipt_count, 0),
       reversal_count  = COALESCE(r.reversal_count, 0)
  FROM receipts r
 WHERE pol.dataset_version_id = $1
   AND pol.po_no = r.po_no AND pol.po_item = r.po_item;
```

### 6.8 Notifications

```ts
// Backend/src/modules/notify/notify.service.ts
@Injectable()
export class NotifyService {
  async emit(eventCode: string, payload: EventPayload): Promise<void> {
    const event = await this.repo.getEvent(eventCode);
    const subs = await this.repo.findEnabledSubscriptions(eventCode);

    for (const sub of subs) {
      if (!scopeOverlaps(sub, payload.affectedScope)) continue;
      if (severityRank(event.severity) < severityRank(sub.severityFloor)) continue;

      const inQuiet = isWithinQuietHours(sub, new Date());
      if (inQuiet && event.severity !== 'error') continue;    // errors override quiet hours

      const dedupeKey = `${eventCode}|${payload.datasetVersionId ?? payload.batchId}|${recipientOf(sub)}`;

      await this.queues.notify.add(
        sub.deliveryMode === 'digest' ? 'digest' : 'immediate',
        { subscriptionId: sub.id, eventCode, payload, dedupeKey },
        { attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
      );
    }
  }
}
```

```ts
// Backend/src/modules/notify/notify.processor.ts
@Processor('notify')
export class NotifyProcessor {
  async process(job: Job<NotifyJob>) {
    const { subscriptionId, eventCode, payload, dedupeKey } = job.data;

    // Unique index on dedupe_key makes duplicate sends impossible even on retry.
    const claimed = await this.repo.claimDelivery(dedupeKey, subscriptionId, eventCode, payload);
    if (!claimed) return;

    if (await this.rateLimiter.exceeded()) {
      await this.repo.markSuppressed(claimed.id, 'hourly rate limit — coalesced into digest');
      await this.queues.notify.add('digest', job.data, { delay: 3_600_000 });
      return;
    }

    const mail = this.templates.render(eventCode, payload);
    // Emails carry counts, dates and validation summaries only — never vendor
    // names, values or line detail. Email is not an access-controlled channel.
    assertNoBusinessData(mail);

    try {
      const info = await this.mailer.send({ to: claimed.recipientEmail, ...mail });
      await this.repo.markSent(claimed.id, info.response);
    } catch (err) {
      await this.repo.markAttemptFailed(claimed.id, errorMessage(err));
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        // Alerting channel, not email — email is what is broken.
        this.metrics.smtpFailures.inc();
        this.log.error({ err, dedupeKey }, 'notification delivery exhausted retries');
      }
      throw err;
    }
  }
}
```

A publish is **never** rolled back because email failed. Notification is a side effect.

### 6.9 Errors, logging, metrics

```ts
// Backend/src/common/filters/problem-json.filter.ts
/** RFC 9457. Never leaks stack traces, SQL, file paths or internal hostnames. */
@Catch()
export class ProblemJsonExceptionFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const requestId = req.headers['x-request-id'] as string;

    const { status, type, title, detail } = mapError(err);

    if (status >= 500) this.log.error({ err, requestId }, 'unhandled error');
    else this.log.warn({ type, status, requestId }, 'request rejected');

    res.status(status).type('application/problem+json').json({
      type: `https://procurement.energi-up.com/problems/${type}`,
      title, status,
      detail: status >= 500 ? 'An internal error occurred.' : detail,
      requestId,   // shown in the UI so a user can quote it to support
    });
  }
}
```

```ts
// Backend/src/common/logging/pino.config.ts
export const pinoConfig = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.cookie', 'req.headers.authorization',
      '*.code', '*.code_verifier', '*.id_token', '*.access_token',
      '*.password', '*.password_hash', '*.totp_secret_enc',
      '*.smtp_password',
    ],
    censor: '[redacted]',
  },
  formatters: { level: (label: string) => ({ level: label }) },
};
```

Never log `code`, `code_verifier` or raw tokens. Never log row-level business data.

Metrics to expose:

| Metric | Type | Labels |
|---|---|---|
| `http_request_duration_seconds` | histogram | route, method, status |
| `ingest_stage_duration_seconds` | histogram | stage, source |
| `ingest_batch_total` | counter | source, outcome |
| `validation_findings_total` | gauge | severity, rule_id |
| `dataset_as_of_lag_days` | gauge | — |
| `notification_delivery_total` | counter | event, status |
| `queue_depth` | gauge | queue |
| `cache_hit_ratio` | gauge | cache |
| `nas_mount_available` | gauge | — |
| `auth_login_total` | counter | method, flow, outcome |

---

## 7. Frontend implementation

### 7.1 Auth gate

```tsx
// Frontend/src/app/AuthGate.tsx
export function AuthGate({ children }: { children: ReactNode }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['me'], queryFn: () => api.get('/api/v1/me'), retry: false,
  });

  if (isLoading) return <FullPageSpinner />;

  if (error instanceof ApiError && error.status === 401) {
    // Preserve the deep link across the SSO round trip.
    const returnTo = encodeURIComponent(location.pathname + location.search);
    return <LoginScreen ssoUrl={`/auth/oidc/login?returnTo=${returnTo}`} />;
  }

  if (data && data.scope.length === 0) {
    // New SSO users land here: authenticated, no data scope granted yet.
    return <NoScopeScreen email={data.email} />;
  }

  return <SessionProvider value={data}>{children}</SessionProvider>;
}
```

### 7.2 API client

```ts
// Frontend/src/lib/api.ts
export class ApiError extends Error {
  constructor(readonly status: number, readonly problem: Problem) {
    super(problem.title);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',       // single origin: cookie is first-party
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const problem = res.headers.get('content-type')?.includes('problem+json')
      ? ((await res.json()) as Problem)
      : { type: 'about:blank', title: res.statusText, status: res.status };
    throw new ApiError(res.status, problem);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
```

### 7.3 Freshness banner

Persistently visible on every screen, never behind a click.

```tsx
// Frontend/src/components/FreshnessBanner.tsx
export function FreshnessBanner() {
  const { data } = useQuery({
    queryKey: ['dataset', 'current'],
    queryFn: () => api.get<DatasetCurrent>('/api/v1/dataset/current'),
    refetchInterval: 60_000,
  });
  const [open, setOpen] = useState(false);
  if (!data) return null;

  const state = FRESHNESS[data.freshnessState];

  return (
    <div className="freshness-banner" data-state={data.freshnessState}>
      <span className="dot" aria-hidden="true" />
      {/* Severity is never colour-only: the icon and text carry it too (WCAG 2.1 AA). */}
      <span className="sr-only">{state.srLabel}</span>
      <strong>Data as of {formatDate(data.asOfDate)}</strong>
      <span className="sep">·</span>
      <span>loaded {formatDateTime(data.publishedAt)} ({data.sourceLabel})</span>
      <span className="sep">·</span>
      <span className="state">{state.icon} {state.label}</span>

      {data.activeCaveats.length > 0 && (
        <button className="caveat-link" onClick={() => setOpen(true)}>
          {data.activeCaveats.length} caveat{data.activeCaveats.length > 1 ? 's' : ''}
        </button>
      )}
      <button className="details" aria-expanded={open} onClick={() => setOpen(!open)}>Details</button>
      {open && <FreshnessDetails data={data} onClose={() => setOpen(false)} />}
    </div>
  );
}
```

### 7.4 KPI card — the honesty rule in the UI

```tsx
// Frontend/src/components/KpiCard.tsx
export function KpiCard({ kpi, title }: { kpi: KpiValue; title: string }) {
  const onDrill = useDrill();

  // A KPI that is not 'ok' renders an em dash and the reason. Never 0,
  // never a blank, never a plausible-looking substitute.
  if (kpi.status !== 'ok' || kpi.value === null) {
    return (
      <div className="kpi-card kpi-card--unavailable">
        <div className="kpi-value" title={kpi.statusReason ?? ''}>—</div>
        <div className="kpi-title">{title}</div>
        <div className="kpi-sub">{kpi.statusReason}</div>
      </div>
    );
  }

  return (
    <button
      className="kpi-card"
      data-severity={severityOf(kpi)}
      onClick={() => kpi.drillToken && onDrill(kpi.drillToken)}
      disabled={!kpi.drillToken}
    >
      <div className="kpi-value">{formatValue(kpi.value, kpi.unit)}</div>
      <div className="kpi-title">{title}</div>
      <div className="kpi-sub">
        {kpi.currencyBasis === 'idr_based' && <span className="basis-note">(IDR-based %)</span>}
        {kpi.sampleSize !== null && <span>n = {kpi.sampleSize.toLocaleString()}</span>}
      </div>
    </button>
  );
}
```

### 7.5 Adaptive units

```ts
// Frontend/src/lib/format.ts
/** Millions only at >= 1,000,000. Below that the full amount — the v1 review's
 *  2,325 USD case, which must never render as "0M". */
export function formatMoney(v: number | null, ccy: string): string {
  if (v === null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) {
    return `${ccy} ${(v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}M`;
  }
  return `${ccy} ${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
```

### 7.6 Drill modal

```tsx
// Frontend/src/components/DrillModal.tsx
export function DrillModal({ token, onClose }: { token: string; onClose: () => void }) {
  const { data, error, fetchNextPage, hasNextPage } = useInfiniteQuery({
    queryKey: ['drill', token],
    queryFn: ({ pageParam }) => api.get<DrillPage>(`/api/v1/drill/${token}?cursor=${pageParam ?? ''}`),
    getNextPageParam: p => p.nextCursor,
  });

  if (error instanceof ApiError && error.status === 401) {
    return <Modal onClose={onClose}><ExpiredDrill onRetry={onClose} /></Modal>;
  }

  return (
    <Modal onClose={onClose} labelledBy="drill-title">
      <h2 id="drill-title">{data?.pages[0].label}</h2>
      <p className="drill-count">
        {data?.pages[0].totalCount.toLocaleString()} rows
        {data?.pages[0].note && <span className="drill-note"> · {data.pages[0].note}</span>}
      </p>
      <DataTable rows={data?.pages.flatMap(p => p.rows) ?? []} />
      {hasNextPage && <button onClick={() => fetchNextPage()}>Load more</button>}
    </Modal>
  );
}
```

### 7.7 Vendoring — no CDN

```ts
// Frontend/vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: { output: { manualChunks: { charts: ['chart.js'], vendor: ['react', 'react-dom'] } } },
    assetsInlineLimit: 0,
  },
});
```

No `<script src="https://…">` anywhere. Fonts are self-hosted. This is what allows the strict CSP in TECH 03 §6.4 with no `unsafe-inline`, and it removes v1's contradiction between requiring cdnjs and claiming offline capability.

---

## 8. Coding standards

### 8.1 TypeScript

`strict: true`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. `any` is banned by lint; `unknown` plus a type guard is the alternative. No non-null assertions (`!`) in `packages/rules` — a null there is a real case that must be handled.

### 8.2 Nulls and money

- A measure that is unknown is `null`. Never `0`, never `COALESCE(x, 0)` on a measure. Aggregations may coalesce **counts**, never **values**.
- Money is `numeric` in the database and handled as a string at the boundary if precision matters; never `float`.
- A currency amount is always carried with its currency code. There is no bare "amount" in any DTO.

### 8.3 SQL

- Analytics SQL lives in `Backend/src/db/sql/*.sql`, reviewed as code. No query builder for aggregates.
- Every value is parameterised. Identifiers via `sql.identifier`. No string concatenation of user input, ever.
- Every fact query reads a `core.v_*` current-version view, or takes an explicit `dataset_version_id`.
- Every fact query carries a scope predicate. Reviewers should reject any that does not.

### 8.4 Naming

`snake_case` in the database, `camelCase` in TypeScript, mapped at the repository boundary. Rule ids (`V-M01`) and KPI ids (`demand_realism`) are stable identifiers — never renamed, because they appear in stored validation reports and golden-number fixtures.

### 8.5 Commits and reviews

Conventional Commits. One reviewer minimum; **two for `packages/rules`, one of them from the procurement side** — those functions define what the numbers mean. Any change to a golden number requires the PR body to state which rule changed and why.

---

## 9. Testing

### 9.1 Layers

| Layer | Location | Gate |
|---|---|---|
| Unit — rules | `packages/rules/test` | ≥ 95% branch coverage |
| Unit — services | `Backend/test/unit` | ≥ 80% |
| Contract — parse/validate | `Backend/test/contract` | fixture + corrupted variants |
| Integration — API | `Backend/test/integration` | real PostgreSQL in Docker |
| Golden numbers | `tests/golden` | every KPI to the digit |
| Security | `Backend/test/security` | authz matrix, scope leakage, drill replay, upload gates |
| E2E | `tests/e2e` | Playwright, both SSO flows |
| Accessibility | `tests/e2e` | axe-core, zero violations |

### 9.2 Golden numbers

```ts
// tests/golden/kpi.spec.ts
import expected from './expected-kpis.json';

describe('golden numbers', () => {
  let versionId: number;
  beforeAll(async () => { versionId = await ingestFixture(); });

  // Any drift here fails CI. Changing an expected value requires a PR stating
  // which rule changed and why — a KPI cannot move without a recorded decision.
  for (const [kpiId, exp] of Object.entries(expected.kpis)) {
    it(`${kpiId} reproduces exactly`, async () => {
      const actual = await getKpi(versionId, kpiId);
      expect(actual.status).toBe(exp.status);
      if (exp.status === 'ok') {
        expect(actual.value).toBeCloseTo(exp.value, 6);
        expect(actual.sampleSize).toBe(exp.sampleSize);
      }
    });
  }

  it('every chart drill count equals its aggregate count', async () => {
    for (const chartId of ALL_CHART_IDS) {
      const series = await getChart(versionId, chartId);
      for (const point of series.points) {
        const drill = await openDrill(point.drillToken);
        expect(drill.totalCount).toBe(point.rowCount);   // equal by construction
      }
    }
  });
});
```

Seed values, from the current export:

```json
{
  "feedRowCounts": { "pr": 20110, "prel": 27742, "po": 20804, "por": 10807, "gr": 28897, "fx": 230 },
  "integrity": {
    "splitSourcedPrItems": 645,
    "maxPoLinesPerPrItem": 33,
    "stoLines": 4453,
    "stoPos": 767,
    "directPoLines": 9094,
    "prItemsWithPo": 10378,
    "danglingPrRefs": 291,
    "grOrphans": 0,
    "continuationRowsAttached": 13338,
    "continuationOrderViolations": 0,
    "tokenPriceLinesNonSto": 107,
    "zeroPriceLinesNonSto": 74,
    "contaminatedGrDates": 0,
    "releaseExemptLines": 241,
    "releaseExemptPos": 89,
    "fullyReversedLineKeys": 92,
    "wbsViolationItems": 1119,
    "wbsViolationPrs": 339,
    "wbsIndeterminateItems": 4211
  },
  "kpis": {
    "demand_realism":         { "status": "disabled", "reason": "V-M01" },
    "expedite_effectiveness": { "status": "ok", "value": 0.50 },
    "grir_over_60d":          { "status": "ok", "value": 91.67 },
    "commitment_over_60d":    { "status": "ok", "value": 55.9 }
  }
}
```

`contaminatedGrDates: 0` is a **regression guard**: v1 produced 1,695. If a refactor reintroduces the earliest-any-movement date, this test fails.

### 9.3 Fixture generation

```bash
pnpm fixture:generate -- --source "Assets/" --out tests/fixtures/
```

Replaces vendor names, requisitioner names, `Created by`, `Login Name` and GR `User Name` with stable pseudonyms; **preserves document numbers, dates, quantities and values exactly** so every count and cycle time is unchanged. The script asserts that no source personal name or login identifier survives, and fails if any does. Generation is reviewed like code.

### 9.4 Security tests

```ts
// Backend/test/security/scope-leakage.spec.ts
describe('data scope', () => {
  it('a plant-scoped user never receives another plant’s rows', async () => {
    const user = await createUser({ role: 'analyst', scopes: [{ companyCode: 'EU', plant: 'EU71', purchOrg: '*' }] });
    for (const path of ALL_DATA_ENDPOINTS) {
      const res = await as(user).get(path);
      expectEveryRow(res, r => r.plant === 'EU71');
    }
  });

  it('a user with no scope receives no rows anywhere', async () => {
    const user = await createUser({ role: 'analyst', scopes: [] });
    for (const path of ALL_DATA_ENDPOINTS) {
      expect(await as(user).get(path)).toHaveRowCount(0);
    }
  });

  it('a drill token cannot be replayed by another session', async () => {
    const a = await createUser({ role: 'analyst', scopes: [{ companyCode: 'EU', plant: '*', purchOrg: '*' }] });
    const b = await createUser({ role: 'analyst', scopes: [{ companyCode: 'EU', plant: '*', purchOrg: '*' }] });
    const token = (await as(a).get('/api/v1/kpi')).kpis[0].drillToken;
    await expect(as(b).get(`/api/v1/drill/${token}`)).rejects.toHaveStatus(403);
  });

  it('a drill token cannot outlive a scope revocation', async () => {
    const u = await createUser({ role: 'analyst', scopes: [{ companyCode: 'EU', plant: '*', purchOrg: '*' }] });
    const token = (await as(u).get('/api/v1/kpi')).kpis[0].drillToken;
    await revokeAllScopes(u);
    expect(await as(u).get(`/api/v1/drill/${token}`)).toHaveRowCount(0);
  });
});
```

### 9.5 Both SSO flows

```ts
// tests/e2e/auth.spec.ts
test('SP-initiated login', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /sign in with dws hub/i }).click();
  await hubLogin(page, E2E_USER);
  await expect(page.getByText(/data as of/i)).toBeVisible();
  expect(await page.context().cookies()).toContainEqual(expect.objectContaining({ name: 'pct_sid' }));
});

test('IdP-initiated login (Hub tile)', async ({ page }) => {
  // Must be tested explicitly: it exercises the branch a stock OIDC library
  // fails on, and it is the only path where the id_token signature is the
  // sole trust anchor.
  await page.goto(HUB_DASHBOARD_URL);
  await hubLogin(page, E2E_USER);
  await page.getByRole('link', { name: /procurement control tower/i }).click();
  await expect(page.getByText(/data as of/i)).toBeVisible();
});
```

---

*End of TECH 01. Continue to [TECH 02 — API Reference](TECH_02_API_Reference.md) and [TECH 03 — Deployment & Operations](TECH_03_Deployment_and_Operations.md).*
