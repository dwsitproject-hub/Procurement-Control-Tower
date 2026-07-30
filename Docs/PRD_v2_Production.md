# Product Requirement Document — Procurement Control Tower v2 (Production)

| | |
|---|---|
| **Document status** | Draft for review |
| **Version** | 2.0 — production architecture |
| **Date** | 30 July 2026 |
| **Supersedes** | `Procurement_Control_Tower_PRD.docx` v1.0 (build v50, single-file HTML) |
| **Product owner** | Procurement / Supply Chain — KPN Downstream (Energi UP) |
| **Basis of evidence** | [PRD_Review_and_Data_Analysis.md](PRD_Review_and_Data_Analysis.md) — findings measured directly from the `Assets/` exports |
| **Annexes** | [Annex A — Data Contract](PRD_v2_Annex_A_Data_Contract.md) · [Annex B — Database Schema](PRD_v2_Annex_B_Database_Schema.md) |
| **Target platform** | 3 instances (Frontend · Backend · Database), staging + production |

---

## Table of contents

**Part I — Product**
1. [Executive summary](#1-executive-summary)
2. [Objectives & success metrics](#2-objectives--success-metrics)
3. [Personas & permission matrix](#3-personas--permission-matrix)
4. [Scope](#4-scope)

**Part II — Architecture**
5. [Deployment topology](#5-deployment-topology)
6. [Technology stack](#6-technology-stack)
7. [Application architecture](#7-application-architecture)
8. [Environments & configuration](#8-environments--configuration)

**Part III — Data**
9. [Data contract & template governance](#9-data-contract--template-governance)
10. [Ingestion subsystem](#10-ingestion-subsystem)
11. [Validation & Data Check](#11-validation--data-check)
12. [Transformation & business rules](#12-transformation--business-rules)
13. [KPI specification](#13-kpi-specification)

**Part IV — Features**
14. [Data freshness & lineage](#14-data-freshness--lineage)
15. [Notification subsystem](#15-notification-subsystem)
16. [API specification](#16-api-specification)
17. [Frontend specification](#17-frontend-specification)
18. [Admin console](#18-admin-console)

**Part V — Cross-cutting**
19. [Security](#19-security)
20. [Scalability & performance](#20-scalability--performance)
21. [Observability](#21-observability)
22. [Backup, DR & retention](#22-backup-dr--retention)
23. [Testing strategy](#23-testing-strategy)
24. [CI/CD](#24-cicd)

**Part VI — Delivery**
25. [Functional requirements register](#25-functional-requirements-register)
26. [Non-functional requirements register](#26-non-functional-requirements-register)
27. [Phased roadmap](#27-phased-roadmap)
28. [Risks](#28-risks)
29. [Open decisions](#29-open-decisions)
30. [Glossary](#30-glossary)

---

# Part I — Product

## 1. Executive summary

The Procurement Control Tower is a server-based procure-to-receive analytics platform for KPN Downstream. It ingests six SAP list exports (PR Report, PR Release, PO Report, PO Release, GR List, FX rates), validates them against a published data contract, transforms them into a governed star schema, and serves executive KPIs, governance controls and line-level drill-downs to authenticated users.

v2 replaces the v1 single-file browser prototype. The prototype proved the analytics; it cannot meet production requirements for security, multi-user access, auditability, data lineage or scale. v2 keeps the prototype's most valuable property — **honesty of figures** (no silent currency conversion, `—` instead of fabricated values, drill counts that equal chart counts by construction) — and moves it into tested server-side code.

Three changes define v2:

1. **Server-side data pipeline.** Data is ingested once into PostgreSQL as an immutable, versioned dataset, not re-parsed in every user's browser. Every published figure is traceable to a source file, a row and an ingestion batch.
2. **Two governed ingestion paths.** An automatic watcher on the Synology share folder, and a manual upload for users who need an off-cycle refresh. Both run the identical validation and transformation pipeline — there is no "quick path" that skips checks.
3. **Correctness fixes from the v1 review.** Six defects measured against real data are corrected by specification, not left to implementation judgement: the delivery-date feed gap, GR date contamination by stock-transfer postings, release-strategy misclassification, wall-clock aging, latest-month-only FX, and the PR-centric row model that marginalised 43.7% of PO lines.

### 1.1 What the data looks like

Measured from the `Assets/` exports (EU entity, 1 Jan – 27 Jul 2026):

| Feed | Rows | Columns | Referential integrity |
|---|---:|---:|---|
| PR Report | 20,110 | 28 | key unique |
| PR Release | 27,742 | 20 | 48% continuation rows (see Annex A §A.3) |
| PO Report | 20,804 | 53 | key unique; 43.7% of lines have no PR reference |
| PO Release | 10,807 | 15 | key unique; 0 orphans vs PO Report |
| GR List | 28,897 | 36 | key unique; **0 orphans** vs PO Report |
| FX rates | 230 | 4 | monthly averages, Jan–Jul, 15 currencies |

Roughly 110,000 rows and 16 MB per refresh cycle. This is a small dataset by database standards; the engineering challenge is correctness, governance and access control, not volume.

---

## 2. Objectives & success metrics

Every metric below is measurable at acceptance. v1's success metrics were qualitative or pinned to an unversioned snapshot; these are not.

| # | Objective | Success metric | Measured how |
|---|---|---|---|
| O1 | Zero-touch data refresh | ≥ 95% of scheduled Synology sync cycles complete without human intervention over a 30-day window | Ingestion batch log |
| O2 | Trustworthy numbers | 100% of published KPIs reproduce the values generated from the frozen test fixture, to the digit | Golden-number regression suite (§23.2) |
| O3 | Traceability | Every figure on every screen can be drilled to source rows, and every row names its source file, sheet, row number and batch | Manual audit of 20 sampled figures |
| O4 | Data currency is never ambiguous | The as-of date, load time, source and staleness state are visible on every screen without navigation | UI review |
| O5 | Governance is actionable | WBS/AR non-compliance is countable and drillable at PR and item level, with the threshold rule configurable and dated | Feature acceptance |
| O6 | Notification reliability | ≥ 99% of ingestion-complete notifications delivered within 5 minutes of publish; 100% of failures produce an alert | Notification delivery log |
| O7 | Secure by default | Zero high/critical findings open at go-live from dependency scan, SAST and an authenticated penetration test | Security sign-off |
| O8 | Responsive at scale | p95 API latency ≤ 500 ms for KPI endpoints and ≤ 1.5 s for drill queries at 50 concurrent users | Load test |
| O9 | Ingestion throughput | A full six-file bundle validates, transforms and publishes in ≤ 5 minutes | Ingestion timing log |
| O10 | Recoverability | Any published dataset version can be rolled back to the prior version in ≤ 2 minutes with no data loss | DR drill |

---

## 3. Personas & permission matrix

### 3.1 Personas

| Persona | Needs | Primary features |
|---|---|---|
| **Procurement Analyst** | Daily operational view; find stuck documents; answer "where is my PR/PO" | Open Items, status drills, aging severity, search, detail table, export |
| **Procurement Manager** | Cycle times, workload, vendor spend, monthly trends, expedite abuse | Executive & PO tabs, P1 KPIs, purchasing-group charts, Vendor 360 |
| **Approver (PIC)** | Personal pending queue | Pending approvals by PIC, direct-PO fallback drill |
| **Auditor / Controls** | WBS/AR compliance, retro POs, deleted-after-approval, data lineage | WBS cards, Data Check, drill-to-line evidence, audit log (read) |
| **Data Steward** | Keep feeds healthy; resolve template drift; re-run loads | Ingestion console, validation report, column mapping, manual upload |
| **Administrator** | Users, roles, scopes, notification recipients, system config | Admin console, audit log, notification config, dataset rollback |

### 3.2 Roles & permissions

| Capability | Viewer | Analyst | Manager | Auditor | Data Steward | Admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| View dashboards within data scope | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Drill to line-level rows | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| Export to XLSX/CSV | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| Save personal layouts & filters | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| View Data Check / validation report | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| View audit log | — | — | — | ✓ | — | ✓ |
| Manual data upload | — | — | — | — | ✓ | ✓ |
| Trigger / re-run Synology sync | — | — | — | — | ✓ | ✓ |
| Edit column mappings & template versions | — | — | — | — | ✓ | ✓ |
| Publish / roll back a dataset version | — | — | — | — | — | ✓ |
| Manage users, roles, data scopes | — | — | — | — | — | ✓ |
| Manage notification recipients & events | — | — | — | — | — | ✓ |
| Edit business-rule configuration (thresholds, FX policy, exclusions) | — | — | — | — | — | ✓ |
| Manage SMTP / system settings | — | — | — | — | — | ✓ |

**Data scope (row-level security).** Independently of role, every user carries a scope: a set of company codes, plants and purchasing organisations. All queries are filtered by it server-side. The current data spans 1 company code, **19 plants** and **12 purchasing organisations** — scoping is a day-one requirement, not a future enhancement. A scope of `*` (all) is grantable and is itself an audited privilege.

> **Authorization is the application's responsibility.** A valid DWS Hub id_token proves *who* a user is, never *what* they may see. Role and scope are always resolved from the application database.

---

## 4. Scope

### 4.1 In scope

- Ingestion of the six SAP export templates via Synology share folder (automatic) and browser upload (manual), with identical validation.
- Template governance: versioned column contracts, drift detection, steward-managed remapping.
- Versioned, immutable datasets with atomic publish and one-click rollback.
- Transformation into a governed star schema: PR items, PO lines, GR postings, release events as first-class facts.
- Business rules: PR↔PO linking (both directions, 1 PR → N POs), GR joining at line level, status derivation, STO segregation, WBS/AR policy, period-matched FX consolidation, aging against an explicit as-of date.
- Analytics: executive KPIs, cycle times, governance controls, vendor/material/category entity views, exact-set drill-downs to source lines.
- Data freshness and lineage surfaced in the UI on every screen.
- Email notifications on data events with administrator-configurable recipients and event subscriptions.
- Authentication via DWS Hub SSO (OIDC) with local break-glass accounts; RBAC plus row-level data scoping.
- Audit logging of all authentication, administrative, ingestion and export events.
- Staging and production deployments across three instances.

### 4.2 Out of scope

- Writing back to SAP; approval or release actions. The product is read-only analytics.
- Live SAP connectivity (RFC / OData / CDS). Data arrives as exported files only.
- Forecasting, ML or optimisation.
- Mobile native applications (the web UI is responsive; that is the extent).
- Invoice/payment (FI) analytics beyond the GR/IR exposure derivable from PO "still to be invoiced".
- Replacing the v1 HTML prototype's offline mode. v2 is a served application; the prototype may remain in use as an offline fallback but is not maintained as part of v2.

### 4.3 Explicit non-goals carried from the v1 review

- **No CDN dependencies.** All frontend libraries are vendored and served from the frontend instance. v1's NFR required cdnjs reachability, which contradicted its own offline and privacy claims. v2 has no third-party runtime origin, which also allows a strict Content-Security-Policy.
- **No business logic in the browser.** All rules, aggregation and drill predicates execute server-side. The frontend renders and interacts; it does not compute KPIs.

---

# Part II — Architecture

## 5. Deployment topology

### 5.1 Instances

Three instances per environment (staging and production), sized independently.

| # | Instance | Runs | Public? | Suggested size |
|---|---|---|---|---|
| 1 | **Frontend / Edge** | nginx: TLS termination, static SPA bundle, reverse proxy | **Yes** — sole public entry point | 2 vCPU / 4 GB / 20 GB |
| 2 | **Backend** | NestJS API process + BullMQ worker process; CIFS mount of the Synology share | No | 4 vCPU / 8 GB / 50 GB (+ upload spool) |
| 3 | **Database** | PostgreSQL 16 + Redis 7 | No | 4 vCPU / 16 GB / 200 GB SSD |

### 5.2 Single-origin layout — mandatory

The DWS Hub integration guide is explicit: with a split frontend/backend origin, the session cookie requires `SameSite=None; Secure`, which requires HTTPS on both hosts, and over plain HTTP a split origin **cannot** hold a login session. Users get bounced to the login page indefinitely.

Therefore the frontend instance is a reverse proxy and everything is served from **one hostname**:

```
                          ┌──────────────────────────────────────────┐
   browser ──── HTTPS ───▶│ INSTANCE 1 — Frontend / Edge (nginx)     │
                          │  procurement.energi-up.com               │
                          │                                          │
                          │   /api/*   ──┐                           │
                          │   /auth/*  ──┼──▶ proxy_pass             │
                          │   /*       ──┴──▶ static SPA bundle      │
                          └──────────────┬───────────────────────────┘
                                         │ :3000  (private network only)
                          ┌──────────────▼───────────────────────────┐
                          │ INSTANCE 2 — Backend                     │
                          │   NestJS API  ·  BullMQ workers          │
                          │   CIFS mount: //synology/SAP_Exports     │
                          └───────┬──────────────────────┬───────────┘
                          :5432   │                      │  :6379
                          ┌───────▼──────────────────────▼───────────┐
                          │ INSTANCE 3 — Data                        │
                          │   PostgreSQL 16      Redis 7             │
                          └──────────────────────────────────────────┘
                                         ▲
                   ┌─────────────────────┴──────────────────┐
                   │  Synology NAS — SAP export share       │
                   │  (SMB/CIFS, read-only service account) │
                   └────────────────────────────────────────┘

   backend ──── HTTPS ───▶ DWS Hub  /api/sso/{token,jwks,.well-known}
   browser ──── HTTPS ───▶ DWS Hub  /api/sso/authorize
   backend ──── SMTP  ───▶ Mail relay
```

**nginx requirements (non-negotiable):**

```nginx
server {
    listen 443 ssl http2;
    server_name procurement.energi-up.com;

    # ... TLS config ...

    client_max_body_size 60m;          # largest template is ~6 MB; headroom for a 6-file batch

    location /api/  {
        proxy_pass http://10.0.0.20:3000;
        proxy_set_header Host              $host;          # REQUIRED — else the cookie is set for an internal IP
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;                            # long-running ingestion status calls
    }
    location /auth/ {
        proxy_pass http://10.0.0.20:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / {
        root /var/www/pct;
        try_files $uri $uri/ /index.html;                   # SPA history fallback
    }
}
```

`proxy_set_header Host $host` is the single most common cause of a "login succeeds in the log but the browser bounces back" failure. It is a requirement, not a suggestion.

### 5.3 Network & firewall matrix

| From | To | Port | Purpose |
|---|---|---|---|
| Corporate LAN / VPN | Instance 1 | 443 (and 80 → 301 redirect) | User access |
| Instance 1 | Instance 2 | 3000 | API + auth proxy |
| Instance 2 | Instance 3 | 5432 | PostgreSQL |
| Instance 2 | Instance 3 | 6379 | Redis |
| Instance 2 | Synology NAS | 445 | CIFS share (read-only) |
| Instance 2 | DWS Hub | 443 | Discovery, token exchange, JWKS |
| Instance 2 | Mail relay | 587 / 25 | SMTP notifications |
| Browser | DWS Hub | 443 | `/authorize` redirect and Hub login page |
| Ops jump host | All | 22 | Administration |

Instances 2 and 3 have **no inbound route from the corporate LAN**. Default-deny egress on instance 3.

> **Both network paths to the Hub must work.** The browser needs `/authorize`; the *backend* needs `/token`, `/jwks` and discovery. Verify from inside instance 2, not from a laptop:
> ```bash
> curl -s -o /dev/null -w '%{http_code}\n' https://<hub-host>/api/sso/.well-known/openid-configuration
> ```

### 5.4 Synology share mount

The backend mounts the NAS share read-only via a systemd mount unit, using a dedicated DSM service account that has **read-only** permission on the export folder and no other share.

```ini
# /etc/systemd/system/mnt-sap_exports.mount
[Unit]
Description=Synology SAP export share
After=network-online.target
Wants=network-online.target

[Mount]
What=//synology.energi-up.local/SAP_Exports
Where=/mnt/sap_exports
Type=cifs
Options=credentials=/etc/pct/synology.cred,ro,vers=3.1.1,uid=pct,gid=pct,file_mode=0440,dir_mode=0550,noserverino,soft,_netdev
```

- `/etc/pct/synology.cred` is `0600`, owned by root, and contains only the service credentials.
- `ro` at the mount level means an application defect can never modify or delete source files.
- `soft` prevents a NAS outage from hanging backend threads indefinitely.
- Mount health is a liveness signal: if `/mnt/sap_exports` is unreadable, the watcher reports degraded and raises the `ingest.source_unavailable` notification rather than silently finding zero files.

**Alternative (documented, not default):** Synology FileStation REST API over HTTPS, if mounting CIFS is not permitted by infrastructure policy. Same pipeline downstream; only the file-enumeration adapter changes. This is why file access sits behind a `FileSource` interface (§7.2).

---

## 6. Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | React 18 + TypeScript, Vite | Component model suits the tab/card/chart structure; Vite gives fast builds and clean vendored output |
| UI state / data | TanStack Query | Server-state caching, background refetch, request deduplication — matches a read-heavy analytics UI |
| Charts | Chart.js 4 (vendored) | Same library as the prototype, so chart behaviour ports without reinterpretation |
| Tables | TanStack Table + virtualised rows | Detail tables reach tens of thousands of rows; virtualisation plus server-side paging |
| Backend | Node.js 22 LTS + NestJS 10 + TypeScript | Shares language and types with the frontend; the prototype's rules port with minimal reinterpretation risk; mature DI, guards, validation |
| Excel parsing | Streaming row reader (`exceljs` `WorkbookReader`) behind a `SheetRowStream` adapter, with **explicit** cell coercion in `packages/rules` | Bounded memory regardless of file size. Cell coercion is written out and unit-tested per Annex A §A.9 rather than inherited from a library's implicit behaviour — more testable than parity-by-library, and the adapter keeps the reader swappable |
| DB access | Drizzle ORM + raw SQL for analytics | Typed schema and migrations; analytics queries written as reviewed SQL, not generated |
| Queues / jobs | BullMQ on Redis 7 | Ingestion, transformation and notification as durable, retryable, observable jobs |
| Scheduler | BullMQ repeatable jobs | Synology polling and staleness checks; survives restarts, unlike in-process timers |
| Sessions | Server-side sessions in Redis, cookie holds only an opaque id | Instant revocation; no token in browser storage |
| Auth | `openid-client` (OIDC certified) + Argon2id for local accounts | Handles discovery, PKCE S256, JWKS rotation, `iss`/`aud`/`exp` validation |
| Email | Nodemailer + SMTP relay | Simple, auditable, no third-party data egress |
| Database | PostgreSQL 16 | Declarative partitioning for dataset versions, JSONB for raw staging, strong analytic SQL, no licence cost |
| Cache | Redis 7 | Sessions, queues, KPI response cache |
| Migrations | Drizzle Kit, forward-only, versioned | Reviewed in PRs; applied by CI, never by hand |
| Containers | Docker + Compose per instance | Reproducible deploys without introducing Kubernetes for three hosts |
| Reverse proxy | nginx | TLS, static serving, single-origin routing |
| Observability | Pino → Loki; Prometheus metrics; Grafana | Structured logs correlated by request and batch id |
| CI/CD | GitHub Actions (or GitLab CI) | Build, test, scan, deploy staging → manual gate → production |

### 6.1 Repository layout

Frontend and backend are separate applications in one repository with a shared types package. One repository keeps the API contract and its consumer in lockstep; separate deployables satisfy the instance separation.

```
/Frontend            React SPA        → built to static assets, deployed to instance 1
/Backend             NestJS API +
                     workers          → container, deployed to instance 2
/packages/contracts  Shared TypeScript types, DTOs, Zod schemas, KPI ids
/packages/rules      Business-rule functions (pure, exhaustively unit-tested)
/db                  Migrations, seed data, fixtures
/tests/fixtures      Frozen anonymised dataset + expected KPI values
/deploy              Dockerfiles, Compose files, nginx config, systemd units
/Docs                This PRD and annexes
```

`packages/rules` is deliberately separate and dependency-free: STO classification, WBS policy, status derivation, FX conversion, aging and netting are pure functions over plain data. They are the most correctness-critical code in the system and must be testable without a database.

---

## 7. Application architecture

### 7.1 Backend modules

| Module | Responsibility |
|---|---|
| `auth` | DWS Hub OIDC (both flows), local accounts, session lifecycle, MFA for local accounts |
| `authz` | Role guards, data-scope resolution, scope injection into every query |
| `ingest` | File sources, batch orchestration, parsing, staging load |
| `validate` | Template contract checks, structural warnings, drift detection |
| `transform` | Rule application, fact/dim build, mart refresh, publish/rollback |
| `analytics` | KPI query services, chart series, drill resolution, entity views |
| `export` | XLSX/CSV generation with formula-injection neutralisation |
| `notify` | Event bus consumer, recipient resolution, template rendering, SMTP delivery, delivery log |
| `admin` | Users, roles, scopes, rule configuration, notification config, SMTP settings |
| `audit` | Append-only audit trail; queried by Auditor and Admin |
| `health` | Liveness, readiness, dependency probes (DB, Redis, NAS mount, Hub, SMTP) |

### 7.2 Ingestion abstraction

```ts
interface FileSource {
  readonly kind: 'synology' | 'manual';
  list(): Promise<DiscoveredFile[]>;        // name, size, mtime, opaque handle
  open(handle: string): Promise<Readable>;  // streamed, never fully buffered
}
```

`SynologyCifsSource` and `ManualUploadSource` both implement it. Everything downstream — parse, validate, transform, publish, notify — is source-agnostic. This is what makes "both paths run identical validation" structurally true rather than a policy someone has to remember.

### 7.3 Frontend structure

```
/Frontend/src
  app/           router, providers, error boundaries, auth gate
  features/
    executive/   overview tab
    pr/  po/  gr/  delivery/  approvals/  governance/  openitems/
    entity/      vendor-360, material, category views
    ingest/      upload UI, batch history, validation report
    admin/       users, scopes, notifications, rules, templates
  components/    cards, charts, tables, drill modal, freshness banner
  lib/           api client, formatters, drill-token handling
  vendor/        Chart.js and other pinned libraries (no CDN)
```

The frontend holds **no business rules**. Formatting rules it does own: adaptive units (values ≥ 1,000,000 render in millions with an `M` suffix; below that the full amount — the v1 review's `2,325 USD` case), thousands separators, and date display.

---

## 8. Environments & configuration

### 8.1 Environments

| | Staging | Production |
|---|---|---|
| Hostname | `procurement-stg.energi-up.com` | `procurement.energi-up.com` |
| TLS | Required (internal CA acceptable) | Required (trusted certificate) |
| Data | Anonymised copy or a dedicated staging Synology folder | Live Synology folder |
| Hub client id | Separate registration | Separate registration |
| Notification recipients | Restricted to the project team | Live distribution lists |
| Local accounts | Permitted | Break-glass only, MFA mandatory, individually approved |
| Debug endpoints | Enabled | Disabled at build time |

The Hub requires the redirect URI to match **byte-for-byte**, so each environment registers its own URI and configures exactly one:

```
https://procurement-stg.energi-up.com/auth/oidc/callback
https://procurement.energi-up.com/auth/oidc/callback
```

### 8.2 Configuration

All configuration comes from environment variables, validated at boot by a Zod schema. **The process must refuse to start on an invalid or incomplete configuration** — no silent defaults for anything security- or correctness-relevant.

```ini
# ── Runtime ─────────────────────────────────────────────────────────────
NODE_ENV=production
APP_BASE_URL=https://procurement.energi-up.com
PORT=3000
TRUST_PROXY=1

# ── DWS Hub OIDC (public client, PKCE — no client secret exists) ────────
OIDC_DISCOVERY_URL=https://<hub-host>/api/sso/.well-known/openid-configuration
OIDC_CLIENT_ID=procurement-control-tower
OIDC_REDIRECT_URI=https://procurement.energi-up.com/auth/oidc/callback
OIDC_SCOPES=openid email profile

# ── Session (this app's own key — unrelated to the Hub) ─────────────────
SESSION_SECRET=<openssl rand -base64 48>
SESSION_COOKIE_NAME=pct_sid
SESSION_COOKIE_SAMESITE=Lax
SESSION_COOKIE_SECURE=true
SESSION_IDLE_TIMEOUT_MIN=60
SESSION_ABSOLUTE_TIMEOUT_HOURS=12

# ── Local accounts ─────────────────────────────────────────────────────
LOCAL_AUTH_ENABLED=true
LOCAL_AUTH_REQUIRE_MFA=true
LOCAL_AUTH_MAX_ATTEMPTS=5
LOCAL_AUTH_LOCKOUT_MIN=15

# ── Data ───────────────────────────────────────────────────────────────
DATABASE_URL=postgres://pct_app:<pw>@10.0.0.30:5432/pct
REDIS_URL=redis://10.0.0.30:6379
DATASET_VERSIONS_RETAINED=12

# ── Ingestion ──────────────────────────────────────────────────────────
SYNOLOGY_MOUNT_PATH=/mnt/sap_exports
SYNOLOGY_POLL_CRON=0 */30 * * * *
SYNOLOGY_ARCHIVE_MODE=none
UPLOAD_SPOOL_PATH=/var/lib/pct/spool
UPLOAD_MAX_FILE_MB=60
UPLOAD_MAX_BATCH_MB=200
INGEST_FILE_SETTLE_SECONDS=30
CLAMAV_HOST=10.0.0.20
CLAMAV_PORT=3310

# ── Notifications ──────────────────────────────────────────────────────
SMTP_HOST=mail.energi-up.com
SMTP_PORT=587
SMTP_SECURE=starttls
SMTP_USER=pct-notify@energi-up.com
SMTP_PASSWORD=<secret>
SMTP_FROM="Procurement Control Tower <pct-notify@energi-up.com>"
NOTIFY_RATE_LIMIT_PER_HOUR=20

# ── Business rules (see §12; DB-configurable values override these) ────
RULE_STO_DOCTYPE_SUFFIX=70
RULE_WBS_MATERIAL_THRESHOLD_IDR=30000000
RULE_WBS_SERVICE_THRESHOLD_IDR=150000000
RULE_AGING_THRESHOLD_DAYS=60
RULE_FX_POLICY=period_matched
RULE_ASOF_SOURCE=data_max
```

**Single-value variables.** `OIDC_REDIRECT_URI` and `APP_BASE_URL` take exactly one value each. Comma-joining them produces `invalid_grant` from the token endpoint and malformed-port crashes respectively. Register multiple redirect URIs *on the Hub* if needed; configure one here. Boot validation rejects any value containing a comma.

**Secrets** are delivered as Docker secrets or root-owned `0600` files referenced by `*_FILE` variants, never committed, and rotated on a documented schedule. `SESSION_SECRET` rotation invalidates all sessions by design.

---

# Part III — Data

## 9. Data contract & template governance

The six files in `Assets/` **are** the templates. Their exact column layouts, types, nullability, sentinel conventions and domain values are specified in **[Annex A](PRD_v2_Annex_A_Data_Contract.md)**, which replaces v1 PRD §6.

### 9.1 Template versioning

Each feed has a versioned contract record in the database: ordered column list, normalised header keys, required/optional status, data type, and accepted aliases. A file is matched to a contract by **header signature**, never by filename — SAP exports get renamed constantly, and the current filenames embed a date range that changes every refresh.

Three outcomes on match:

| Outcome | Meaning | Action |
|---|---|---|
| **Exact** | Every required column present under a known name | Proceed |
| **Healed** | All required columns resolvable via registered aliases or a steward mapping | Proceed; record which aliases fired; warn in the validation report |
| **Drift** | A required column is unresolvable, or an unexpected column appears | Batch halts; steward is notified with the exact diff; nothing is published |

Drift never guesses. v1's per-row remapping UI is retained as a steward tool, but a mapping is now a **persisted, audited, server-side artefact** attached to a template version — not a per-browser `localStorage` preference that silently differs between users.

### 9.2 Semantic drift detection — the check v1 lacked

Structural validation cannot catch a column that keeps its name and changes meaning. That is exactly the failure the v1 review found: `Deliv. date(From/to)` is present, correctly typed, and 99.40% identical to `Release Date` — it is not a delivery date at all.

So each feed carries **semantic assertions** evaluated on every load, expressed as expectations with tolerances:

| Feed | Assertion | Expectation | Current data | Result |
|---|---|---|---|---|
| PR Report | `Deliv. date` distinct from `Release Date` | ≥ 50% of rows differ | 0.60% differ | 🔴 **fails today** |
| PR Report | `Requisition date` ≤ `Deliv. date` | ≥ 95% of rows | 98.6% | ✅ |
| PO Report | `Delivery date` distinct from `Document Date` | ≥ 50% of rows differ | 62.6% differ | ✅ (borderline) |
| GR List | `Qty in unit of entry` non-zero | ≥ 99% of rows | 100% | ✅ |
| GR List | Movement-type set ⊆ registered set | no unregistered types | 101, 102, 641, 642 all registered | ✅ |
| PO Report | Currency values ⊆ FX coverage after normalisation | 100% | 100% (7 of 7) | ✅ |
| PR Report | `WBS Element` population | ≥ 10% | 11.1% | ⚠️ (informational) |

A failing assertion does not block publication — it raises a **declared, visible caveat** and disables the KPIs that depend on it. That is how Demand Realism gets correctly disabled today (§13.1) instead of silently rendering 0.3%.

### 9.3 Template distribution

The Admin console publishes downloadable blank templates generated from the active contract version, so the people running the SAP exports always have the authoritative layout. Each template embeds its contract version in a hidden metadata sheet; the ingester reads it as a hint but still validates by signature.

---

## 10. Ingestion subsystem

### 10.1 Batch model

The unit of ingestion is a **batch**: a set of files submitted together, from one source, with one lifecycle.

```
DISCOVERED → SCANNING → PARSING → VALIDATING → TRANSFORMING → READY → PUBLISHED
                  │          │           │             │           │
                  └──────────┴───────────┴─────────────┴───────────┴──▶ FAILED
                                                                   └──▶ SUPERSEDED
```

| State | Meaning |
|---|---|
| `DISCOVERED` | Files identified; awaiting processing slot |
| `SCANNING` | Anti-virus and structural safety checks |
| `PARSING` | Streaming into staging tables with source row numbers retained |
| `VALIDATING` | Contract, semantic and referential checks |
| `TRANSFORMING` | Rules applied; facts, dimensions and marts built into a new dataset version |
| `READY` | Complete and queryable but not yet the active version |
| `PUBLISHED` | Active version; serving all users |
| `FAILED` | Halted; reason recorded; nothing published; prior version untouched |
| `SUPERSEDED` | A later version was published |

**A batch is only ever published atomically.** Users never see a partially loaded dataset. On any failure, the previously published version continues serving without interruption — the v1 prototype's "analysis does not run on a partial bundle" rule, enforced by the database rather than by UI flow.

### 10.2 Path 1 — Automatic Synology sync

1. A repeatable BullMQ job wakes on `SYNOLOGY_POLL_CRON` (default every 30 minutes).
2. Enumerate `*.xlsx` / `*.XLSX` in the configured folder, non-recursive by default.
3. **Settle check** — skip any file whose mtime is within `INGEST_FILE_SETTLE_SECONDS` (default 30 s) or whose size changed since the previous poll. This prevents reading a file still being written by the SAP export job. A file must present a stable size across two consecutive observations.
4. Compute SHA-256 of each candidate.
5. **Idempotency** — if the set of hashes exactly matches the currently published version's source set, do nothing and log a no-op. This is what makes a 30-minute poll safe.
6. Classify each file by header signature (§9.1).
7. Require a complete bundle: all five document feeds plus FX. An incomplete set does **not** start a batch; it raises `ingest.incomplete_bundle` naming the missing feeds, and retries next cycle. Repeated incompleteness beyond a configurable window (default 4 cycles) escalates to `ingest.stalled`.
8. On a complete, changed bundle: create a batch and run the shared pipeline.
9. Source files are **never modified, moved or deleted** — the mount is read-only. `SYNOLOGY_ARCHIVE_MODE=none` is the default and the only mode compatible with a read-only mount; if the business wants archival, the NAS does it, not this application.

### 10.3 Path 2 — Manual upload

1. A Data Steward or Admin opens **Data → Upload**.
2. Drag-and-drop or select up to six files. Client-side pre-checks (extension, size, count) give immediate feedback; they are advisory only — the server re-checks everything.
3. Each file streams to `UPLOAD_SPOOL_PATH` under a generated name. **The user's filename is never used as a path component** and is escaped wherever displayed.
4. Server-side gates, in order: size cap → extension → **magic-byte check** (a valid XLSX begins `PK\x03\x04` and must contain `[Content_Types].xml`) → ClamAV scan → XLSX safety limits (§19.6) → header-signature classification.
5. The classification result is shown before commitment: which file mapped to which feed, row counts, and any drift. The user confirms or cancels.
6. On confirmation, a batch is created and runs **the identical pipeline** as the automatic path.
7. Partial bundles: the steward may upload a partial set only when explicitly choosing **"replace selected feeds in the current dataset"**, which forks the published version, substitutes the named feeds, and re-runs transformation and validation in full. This is an audited operation and produces a new dataset version like any other. Default remains full-bundle replacement.

### 10.4 Concurrency and precedence

- A global mutex allows **one** batch to transform and publish at a time; others queue.
- If a manual batch is queued while an automatic batch is running, the manual batch waits and the user sees the queue position.
- A manual batch always wins on publish order: it represents a deliberate human action.
- If an automatic poll finds new files while a manual batch is `READY` but unpublished, the automatic batch is created but its publish waits for the manual decision.

### 10.5 Retention and rollback

- Every dataset version retains its staging rows, validation report and source-file metadata (name, size, SHA-256, mtime, source) — but **not** the source file bytes.
- `DATASET_VERSIONS_RETAINED` (default 12) versions are kept. Pruning drops whole partitions.
- **Rollback** re-points the active-version pointer to any retained version. It is one transaction and takes effect on the next query — target ≤ 2 minutes end to end (O10). It is Admin-only, audited, and triggers a notification.

---

## 11. Validation & Data Check

Every batch produces a **validation report**, persisted and viewable in the UI. Findings carry a severity that determines the outcome.

| Severity | Effect | Example |
|---|---|---|
| `BLOCKER` | Batch fails; nothing published | Required column unresolvable; unparseable file; PK duplicate within a feed |
| `CAVEAT` | Publishes, but dependent KPIs disabled and a banner shown | Semantic assertion failed (Demand Realism today) |
| `WARNING` | Publishes; shown in Data Check with counts and drill-through | Token prices, zero valuations, dangling PR references |
| `INFO` | Recorded for trend comparison | Row counts, alias substitutions, per-feed deltas vs prior version |

### 11.1 Structural checks

| ID | Check | Severity | Current data |
|---|---|---|---|
| V-S01 | Header signature resolves to exactly one feed | `BLOCKER` | pass |
| V-S02 | All required columns present (directly or via alias/mapping) | `BLOCKER` | pass |
| V-S03 | Unexpected extra columns | `WARNING` | pass |
| V-S04 | Primary key unique within feed | `BLOCKER` | pass (PR/PO/PO-Rel/GR); PR Release evaluated after continuation-fill |
| V-S05 | Row count > 0 and within ±60% of the prior version | `WARNING` | baseline |
| V-S06 | Date columns parse under the declared format | `BLOCKER` | pass |
| V-S07 | Numeric columns parse (SAP trailing-minus handled) | `BLOCKER` | pass |

### 11.2 Referential checks

| ID | Check | Severity | Current data |
|---|---|---|---|
| V-R01 | GR `PO`+`Item` exists in PO Report | `WARNING` | **0 orphans** |
| V-R02 | PO Release `PO No` exists in PO Report | `WARNING` | 0 orphans |
| V-R03 | PO `Purchase Requisition`+`Item` exists in PR Report (where present) | `WARNING` | 291 of 11,710 (2.5%) dangling |
| V-R04 | PR Release continuation rows each follow a sequence-1 row | `BLOCKER` | **0 violations** |
| V-R05 | Release L2 approve date ≥ L1 approve date | `WARNING` | 0 violations |
| V-R06 | Every PO currency has an FX rate after normalisation | `CAVEAT` | pass (7 of 7) |
| V-R07 | Every GR movement type is registered with a known sign convention | `BLOCKER` | pass (101, 102, 641, 642) |

V-R04 is the guard the v1 prototype lacked. The forward-fill of PR Release continuation rows is correct on current data, but it is order-dependent: an export re-sort would silently reattach every level-2 approval to the wrong PR. V-R04 makes that loud instead of silent.

### 11.3 Business-anomaly warnings

| ID | Warning | Rule | Current data |
|---|---|---|---|
| V-B01 | Token prices | `0 < Net Price ≤ 1`, excluding STO | 107 lines |
| V-B02 | Zero-price non-STO lines | `Net Price = 0`, excluding STO | 74 lines |
| V-B03 | STO population | share of lines with doc type ending `70` | 4,453 (21.4%) |
| V-B04 | Zero PR valuation | `Total Value = 0` | 4,211 items (20.9%) |
| V-B05 | WBS column coverage | share populated | 11.1% |
| V-B06 | Negative requested lead time | `Deliv. date < Requisition date` | 286 (1.4%) |
| V-B07 | Fully reversed receipts | line nets to ≤ 0 after 101/102 | 92 line keys |
| V-B08 | GR-date contamination | lines whose earliest posting precedes their first 101 | 1,695 (11.2%) |
| V-B09 | POs with no release record | in PO Report, absent from PO Release | 525 POs (5.5%) |
| V-B10 | Lines with no release strategy | `Release indicator` and `Release group` both blank | 964 lines / 241 not deleted |
| V-B11 | Deleted documents | PR `Deletion indicator = true`; PO `Deletion indicator = L` | 1,853 PR items; 1,168 PO lines |

Each warning is drillable to the exact rows, with lineage back to the source file and row number.

---

## 12. Transformation & business rules

All rules live in `packages/rules` as pure functions with exhaustive unit tests. Configurable values live in a dated `rule_config` table; the environment variables in §8.2 are bootstrap defaults only.

### 12.1 Data grain — three fact tables

v1 used a single denormalised grain: one row per PR item × PO link. That made **9,094 PO lines (43.7%)** — every direct PO with no PR reference — reachable only through fallback popups, and required `_dup` bookkeeping to stop PR-level counts double-counting.

v2 models three facts with explicit bridges:

| Fact | Grain | Rows (current) |
|---|---|---|
| `fact_pr_item` | one row per PR item | 20,110 |
| `fact_po_line` | one row per PO line | 20,804 |
| `fact_gr_posting` | one row per GR posting | 28,897 |
| `fact_pr_release` | one row per PR release event | 27,742 |
| `fact_po_release` | one row per PO release event | 10,807 |
| `bridge_pr_po` | PR item ↔ PO line, with link provenance | 11,419 resolved |

Each tab selects its own grain: PR analytics on `fact_pr_item`, spend and commitment on `fact_po_line`, delivery on `fact_gr_posting`, approvals on the release facts. The end-to-end pipeline view is a query joining through `bridge_pr_po` — an explicit, testable join rather than the implicit grain of a wide table.

### 12.2 PR ↔ PO linkage

- **Authoritative direction:** PO side. `fact_po_line.pr_no` + `pr_item` populate `bridge_pr_po`.
- `Item of requisition = '0'` is the **null sentinel** — 9,094 rows, exactly matching the blank `Purchase Requisition` count. It must be normalised to NULL before any join, or every direct PO joins to a phantom item 0.
- 1 PR item → N PO lines is normal: **645 split-sourced items, maximum 33 PO lines** on one item. `bridge_pr_po` carries `split_seq` and `split_total` so the UI can show "3/7" without the row model needing duplicate flags.
- **291 dangling references (2.5%)** — PO lines naming a PR absent from PR Report. These keep the PO line intact with `link_status = 'dangling'`; they are counted, drillable, and never fabricate PR attributes.
- Legacy PR-side references are honoured only when the PO-side link is absent, with `link_provenance = 'pr_side'`.

### 12.3 GR joining — corrected

Three specification changes from v1, each fixing a measured defect:

**(a) Receipt date comes from movement type 101 only.**

```
receipt_date(po_line) = MIN(posting_date) WHERE movement_type = '101'
```

v1 took the earliest posting date across all movement types. Because stock-transfer postings (`641`) are also in the feed, **1,695 of 15,134 line keys (11.2%)** received a GR date a median **7 days** earlier than their actual first receipt, understating delivery lead time, delivery-vs-promise and end-to-end cycle time on 11% of receipted lines.

**(b) Quantity comes from `Qty in unit of entry`, and the sign is derived from movement type, never trusted from the data.**

```
signed_qty = ABS(qty_in_unit_of_entry) × movement_type.sign_factor
```

| Movement type | Text | Class | Sign factor | Counts toward receipts? |
|---|---|---|---|---|
| `101` | GR goods receipt | receipt | +1 | yes |
| `102` | GR for PO reversal | reversal | −1 | yes (nets) |
| `641` | Transfer to stock in transit | transfer | +1 | no — transit analytics only |
| `642` | Transfer reversal | transfer reversal | −1 | no |
| `122` | Return delivery | reversal | −1 | yes (registered; absent from current data) |

Two facts justify this. First, the correct quantity column is `Qty in unit of entry`: the column named `Quantity` is **zero on 22.4% of rows** and differs on 6,562 rows. v1's PRD nominated `Quantity`; following it literally would zero out 6,485 receipts. Second, netting in v1 worked only because this export happens to sign reversal quantities negative (all 741 `102` rows). Deriving the sign from the movement type makes correctness independent of that convention. An unregistered movement type is `BLOCKER` V-R07 — no guessing.

**(c) Transfer postings are segregated, not summed into receipts.**

`641`/`642` are 8,956 rows (**31.0%** of the feed) and undocumented in v1. They sum to exactly zero per line today, so they did not corrupt quantities — but they did corrupt dates, and 47 line keys carry transfers with no `101` at all, presenting as "received" with zero quantity. They now populate `fact_gr_posting` with `posting_class = 'transfer'`, feed the Delivery tab's in-transit view, and are excluded from receipt quantity and receipt date.

**Fallback joins.** v1's material-level and PO-level fallbacks existed for incomplete GR exports. Current data has **zero orphans**, so both fallbacks are off by default, available behind a configuration flag, and any row attached by a fallback is tagged `join_method` and surfaced in Data Check. A fallback join is a reportable event, not a silent convenience.

### 12.4 Status derivation — corrected

v1 mapped a blank `Release indicator` to `PO-Deleted`. That is wrong: blank means **no release strategy applies** — `Release group` is blank on exactly the same 964 lines — while deletion is carried by `Deletion indicator = 'L'`. The consequence was **241 lines / 89 POs / IDR 1,506,586,519** of live orders silently removed from the pipeline as deleted. Those 89 POs also have **no PO Release record at all**, so classifying them as "pending" instead would strand them in the approval queue forever.

v2 reads deletion from the deletion indicator and treats release-strategy exemption as its own state:

| PO release state | Source condition |
|---|---|
| `approved` | `Release indicator ∈ {1, 2, C}` |
| `pending` | `Release indicator = 'X'` |
| `not_subject_to_release` | `Release indicator` blank **and** `Release group` blank |
| `deleted` | `Deletion indicator = 'L'` (evaluated first — deletion wins) |

**Decision D2 — resolved (30 Jul 2026): `flag_only`.** Release-exempt lines are left in the pipeline exactly as they are and marked, rather than being reclassified into `approved` or `pending`. Concretely:

- `po_release_state` stays `not_subject_to_release`. It is **never** folded into approved or pending.
- A separate boolean `release_exempt` is exposed on the line, rendered as a **`⚑` marker** wherever the line appears — cards, charts, drills, detail table, entity views and exports — with the tooltip "no release strategy applies to this PO; no release record exists".
- **The line's status is driven by its physical receipt state** (`PO-No GR`, `Partially Delivered`, `Delivered`), not by its release state. Release exemption is an orthogonal flag, not a status.
- **Excluded from the pending-approval queue and approval-bottleneck analytics**, because these POs have no release record and can therefore never be approved — leaving them in the queue would strand them permanently.
- **Included** in open-pipeline, commitment, spend and delivery analytics, so the IDR 1.51bn stays visible. This is the specific behaviour v1 got wrong by hiding them as deleted.
- Count and value are always reported in Data Check (`WARNING` V-B10), so the exemption is never invisible.

> **Consequence to be aware of:** for pipeline and commitment purposes these 241 lines therefore *flow like approved POs* — that is unavoidable, since the only alternatives are hiding them (v1's defect) or stranding them in a queue they can never leave. The `⚑` marker is what keeps the assumption visible rather than silent. `RULE_NO_RELEASE_STRATEGY_POLICY` remains configurable (`flag_only` | `treat_as_approved` | `treat_as_pending` | `exclude_flagged`) so this can be revisited without a code change.

Row status:

| Status | Condition |
|---|---|
| `PR-Deleted` | PR `Deletion indicator = true` |
| `Unapproved PR` | no PR release completed |
| `PR Approved-No PO` | PR fully released, no linked PO line |
| `PO-Deleted` | PO `Deletion indicator = 'L'` |
| `HOLD PO` | PO line `Incomplete = 'X'` |
| `PO-Not Approved` | PO release state `pending` |
| `PO-No GR` | PO approved **or release-exempt**, no `101` receipt |
| `Partially Delivered` | net receipt qty > 0 and < ordered qty |
| `Delivered` | net receipt qty ≥ ordered qty |
| `Fully Reversed` | net receipt qty ≤ 0 after netting, with at least one receipt posted (92 line keys today — v1 had no such state) |

Status is evaluated in the order listed: deletion wins over hold, hold over release state, release state over receipt state. Release-exempt lines skip the `PO-Not Approved` test and fall through to their receipt-driven status, carrying the `⚑` flag.

### 12.5 STO segregation

`Purchasing Doc. Type` ending in `70` is a Stock Transport Order. Validated: **`EU70` = 4,453 lines / 767 POs, 100% carrying a `Req. Tracking Number`, 100% with `Net Price = 0`.** No other doc type in the data ends in `70`.

- Excluded from: price and unit-price analytics, PO count and average value, category quantity, vendor spend, token-price warnings.
- Retained in: delivery and receipt analytics, in-transit views.
- `Req. Tracking Number` back-references the originating purchase PO and is exposed in drills.
- Tagged `🚚` in entity views and marked unpriced.
- The suffix is configurable (`RULE_STO_DOCTYPE_SUFFIX`). The rule is exactly *ends-with*; other series (`EO21`, `SC21`, `PS21`, `JP21` — 12 lines total) flow as normal purchases until the business specifies otherwise.

### 12.6 FX consolidation — period-matched

The rate file supplies **monthly averages for Jan–Jul across 15 currencies**. v1 kept only the newest month per pair, so January POs were valued at July rates.

v2 default (`RULE_FX_POLICY=period_matched`):

```
rate(currency, document_date) = rate for (currency, month_of(document_date))
   fallback 1: nearest earlier month available
   fallback 2: latest month available          → tagged 'fx_fallback_latest'
   fallback 3: none                            → value is NULL, never 0
```

- **Currency normalisation is mandatory.** The PO feed carries both `US$` (328 lines) and `USD` (4 lines); the rate file uses `US$`. Both normalise to `USD`.
- **Triangulation is supported.** Where a direct `X → USD` pair is absent but both `X → P` and `USD → P` exist for a pivot currency `P`, derive `X → USD = rate(X→P) / rate(USD→P)`. On current data the direct pairs are all present and triangulation agrees to within 0.01% — but v1 declined to triangulate at all, which would have silently lost every currency except IDR had the export variant changed. This is a resilience requirement, not an optimisation.
- **The month must carry a year.** The current file's `Month` values (`1.Jan` … `7.Jul`) have no year. v1 parsed the ordinal against a hardcoded year 2000 and displayed a 2000 date to users; a bundle spanning December→January would order the months wrongly. v2 requires the batch's period year, taken from the bundle's date range, and records the resolved year explicitly. A file whose months cannot be unambiguously anchored is `BLOCKER`.
- **Strict no-silent-conversion is preserved.** A USD-consolidated figure renders only when every currency present in its scope has a rate. Otherwise the figure renders per currency with an explicit note. An unresolvable currency is **NULL** — never `0`, and never defaulted to IDR as v1's `PO_Ccy` fallback did.

### 12.7 WBS / Appropriation Request policy

Current rule: per **item** — material items (with a material code) at or above IDR 30,000,000 and service items (no material code) at or above IDR 150,000,000 must carry a WBS Element.

Measured: **1,247 items over threshold, 1,119 (89.7%) missing WBS, across 339 PRs, IDR 3,482,267,279,089 at risk.** `WBS Element` is populated on only 11.1% of items, and 4,211 items (20.9%) have `Total Value = 0` and are therefore invisible to any threshold test.

**Decision D1 — resolved (30 Jul 2026).** The product owner has confirmed that the **89.7% non-compliance rate is real**, and that the thresholds must be **administrator-configurable**. The card therefore ships as a settled control metric with no provisional marker.

Requirements:
- **Thresholds are administrator-editable at runtime**, with an effective date and an author, via Admin → Business rules (§18). No redeploy, no code change. v1 hardcoded `30e6`/`150e6` in two separate places; v2 has exactly one source of truth (`app.rule_config`).
- The rule keys are `wbs.material_threshold_idr` (default 30,000,000), `wbs.service_threshold_idr` (default 150,000,000) and `wbs.basis` (default `per_item`). The basis remains configurable so a future policy change to `per_pr_total` needs no code change.
- **The threshold in force is displayed on the card and in every drill and export** — e.g. "≥ IDR 30M material / ≥ IDR 150M service · per item · effective 1 Aug 2026". A compliance number must never move without the reader being able to see why.
- Changing a threshold **recomputes on the next publish, and does not retroactively alter published versions.** Each dataset version carries its `rule_snapshot`, so a figure quoted last month still reproduces. Admins can additionally trigger a recompute of the current version if they want the change reflected immediately; that action is audited and issues `data.rolled_back`-class notification.
- Items with zero or missing valuation are reported as **`indeterminate`**, in their own count — never as compliant. **4,211 items (20.9%) fall here today** and cannot be tested at any threshold. Absence of data is not evidence of compliance.
- Both a total and an open-pipeline variant are provided.
- If the WBS column is absent from an export, the card reads "no WBS column in this export" and reports nothing as compliant.

### 12.8 As-of date and aging — corrected

v1 computed aging from wall-clock `new Date()`. Opening an unchanged export six months later inflated every `> 60 day` KPI by roughly 180 days with no change in the data.

```
as_of_date(dataset_version) = MAX(
    MAX(po_line.document_date),
    MAX(gr_posting.posting_date)
)
aging_days(ref_date) = as_of_date − ref_date
```

- Computed once per dataset version, stored on it, and displayed everywhere (§14).
- `RULE_ASOF_SOURCE` may be set to `data_max` (default) or `publish_time`; the choice is displayed alongside the date.
- An Analyst may override the as-of date for what-if analysis; the override is visibly flagged on screen and included in any export.
- The aging threshold (default 60 days) is configuration.

### 12.9 Additional derived measures

| Measure | Definition |
|---|---|
| PR approval lead time | `pr_release_final_date − requisition_date` |
| Sourcing lead time | `po_document_date − pr_release_final_date` |
| PO approval lead time | `po_release_final_date − po_document_date` |
| Delivery lead time | `receipt_date − COALESCE(po_release_final_date, po_document_date)` |
| End-to-end cycle time | `receipt_date − requisition_date` |
| Delivery vs promise | `receipt_date − po_delivery_date` (EINDT) |
| Retro PO | `po_document_date < pr_release_final_date` — ordered before approval |
| Reversal rate | reversal postings ÷ receipt postings, per line / vendor / month |
| GR completion % | `net_receipt_qty ÷ (ordered_qty × price_unit_factor)`, capped at 100% for services |

**Caveat on delivery-vs-promise:** PO `Delivery date` (EINDT) equals `Document Date` on **37.4%** of lines, so vendor on-time-delivery built on EINDT is weaker than v1's glossary implied. The KPI ships with that share disclosed on the card.

---

## 13. KPI specification

Every KPI is specified as numerator, denominator, filters and as-of basis, and has an expected value generated from the frozen fixture (§23.2). v1 described KPIs in prose and pinned acceptance to an unversioned snapshot; **four of five reference figures did not reproduce** on the real data.

### 13.1 Demand Realism — blocked, ships disabled

| | |
|---|---|
| **Intent** | Are requested delivery dates achievable? |
| **Formula** | share of PR items where `requested_lead_days ≥ median(actual_lead_days) by material group` |
| **Requires** | a genuine requested delivery date per PR item |
| **Status** | 🔴 **Not computable from the current feed** |

`Deliv. date(From/to)` equals `Release Date` on **99.40%** of rows and `Requisition date` on 95.73%; only **572 rows (2.8%)** show a delivery date later than the requisition date. Median requested lead is **0 days** (minimum −887); median actual lead is 17 days. Computed as specified, the KPI returns **0.3%** — permanently red, permanently uninformative.

**Requirements:**
- Semantic assertion V-M01 (§9.2) gates this KPI. While it fails, the card renders `—` with "requested delivery date not present in this export", and the KPI is excluded from any summary or export. It does **not** render 0.3%.
- Blocked on a feed change: the ME5A export variant must carry the requisition item's **delivery date** (SAP `EBAN-LFDAT`) as a displayed column. See §13.1.1.
- When the column arrives, the assertion passes and the KPI activates with no code change.

### 13.1.1 The D4 change request, in detail

**What the KPI needs.** One date per PR item: *when the requester said they needed the goods*. Nothing else in the bundle carries it.

**What the export gives instead.** The column `Deliv. date(From/to)` is present, fully populated and correctly typed — it passes every structural check — but empirically it is not a need-by date:

| Test | Result |
|---|---|
| `Deliv. date(From/to)` == `Release Date` | 19,989 / 20,110 = **99.40%** |
| `Deliv. date(From/to)` == `Requisition date` | 19,252 = **95.73%** → requested lead of exactly **0 days** |
| `Deliv. date(From/to)` **>** `Requisition date` (a usable future need date) | **572 = 2.8%** |
| `Deliv. date(From/to)` **<** `Requisition date` (impossible) | 286 = 1.4% |

Whatever SAP field this column is currently bound to in the variant, it is tracking the release/requisition date, not the requester's date. **This may well be a variant configuration issue rather than a missing field**, which would make the fix minutes rather than weeks — see the steps below.

**Worked example — why the KPI is currently measuring the defect, not the business.**

Two real PR items from the current export:

| | PR `1000007280` item 13 | PR `1000006257` item 48 |
|---|---|---|
| Material group | 912 | 962 |
| Requisition date | 2024-09-25 | 2023-12-28 |
| `Deliv. date(From/to)` | 2024-09-25 | 2024-01-05 |
| `Release Date` | 2024-09-25 | 2024-01-05 |
| **Requested lead (derived)** | **0 days** | **8 days** |
| First PO issued | 2026-04-27 | 2026-01-20 |
| First goods receipt (mvt 101) | 2026-05-22 | 2026-01-24 |
| **Actual lead, PR → GR** | **604 days** | **758 days** |

The KPI asks: *was the requested lead at least as long as what this category actually takes?*

Measured category medians (actual PR → GR days), from the current data:

```
974 → 22 d    962 → 24 d    977 → 25 d    907 → 38 d
9090 → 45 d   951 → 23 d    969 → 56 d    8080 → 78 d
Overall PR → GR median: 32 days   ·   PO → GR median: 18 days
```

- Item 13 requests **0 days**. Every category median exceeds 0, so it scores *unrealistic*.
- Item 48 requests **8 days** against a group-962 median of **24 days** — genuinely unrealistic, and a finding the KPI is designed to surface.

The problem is that **95.7% of all items report a requested lead of 0 days**, purely because the column mirrors the requisition date. So the KPI returns 0.3% and is measuring an export artefact rather than requester behaviour. There is no threshold or formula adjustment that recovers a real signal from a constant.

**Why no substitute works.** Each apparent workaround was evaluated and rejected:

| Candidate | Why it fails |
|---|---|
| Use PO `Delivery date` (EINDT) | **Circular.** EINDT is the date the buyer and vendor agreed *after* sourcing. Comparing it to actual receipt measures vendor on-time delivery — already a separate KPI (§12.9) — not whether the original demand was realistic. It cannot tell you the requester asked for something impossible, because by then the request has already been renegotiated. |
| Use only the 572 items where `Deliv. date > Requisition date` | Sample is 2.8% and **self-selected** — those are precisely the atypical requisitions. Any rate computed on them is unrepresentative, and the KPI would silently change population between loads. |
| Derive an expected need-by from material-group standard lead time | **Circular against the benchmark.** The KPI compares the request to the category actual; synthesising the request from the category actual makes the comparison trivially true. |
| Use `Release Date` as a proxy | It is the same value in 99.40% of rows. Identical result. |

**The request to raise.** Text that can be forwarded as-is:

> The Procurement Control Tower needs the requisition item's **delivery date** on the ME5A export used for the procurement data feed.
>
> Fields requested:
> 1. **`EBAN-LFDAT`** — item delivery date (typical column label *Deliv. date* / *Delivery date*). **Required.**
> 2. **`EBAN-LPEIN`** — delivery date category (day / week / month). *Requested.* If requesters express need-by as a week or month, we must know the granularity so the analytics do not imply false precision.
>
> The variant currently exports a column labelled `Deliv. date(From/to)` whose value equals `Release Date` on 99.40% of 20,110 rows and `Requisition date` on 95.73%. Please confirm which field that column is bound to, and add `EBAN-LFDAT` as a displayed column if it is not already present.
>
> Nothing else about the export needs to change: same transaction, same selection criteria, same file format. Column order does not matter — the system matches columns by name.

**Who owns it.** Either the procurement key user who maintains the ME5A layout/variant, or the SAP MM functional team. Start with the key user — if this is a layout change, they can make it themselves:

1. Transaction **ME5A**; load the variant used for the export and execute.
2. In the result list: **Settings → Layout → Change** (or the *Change Layout* toolbar button).
3. In the **Column Selection** / hidden-fields pane, locate **Deliv. date** (`LFDAT`) and **Deliv. date cat.** (`LPEIN`).
4. Move them into the displayed columns.
5. **Settings → Layout → Save**, overwriting the layout the export uses.
6. If a scheduled job or selection variant drives the export, save that variant too so the change persists.

Menu paths vary slightly by SAP release; the functional team can confirm.

**How we verify it landed.** No code change is needed. On the next ingestion, assertion **V-M01** re-evaluates: it requires the new column to differ from `Release Date` on ≥ 50% of rows. When it passes, `need_by_date` populates, Demand Realism activates automatically, and the caveat banner clears. If the new column *still* mirrors `Release Date`, V-M01 fails again and the card stays disabled — so a cosmetic change cannot silently produce a fake KPI.

**If it cannot be delivered.** Demand Realism is descoped permanently and removed from §2's objective set. Every other KPI is unaffected — this is the only figure with this dependency, which is why it ships cleanly disabled rather than blocking the build.

### 13.2 Expedite Effectiveness

| | |
|---|---|
| **Formula** | `median(pr_to_po_days WHERE urgency ∈ {1,2}) ÷ median(pr_to_po_days WHERE urgency ∈ {3,4})` |
| **`pr_to_po_days`** | `po_document_date − requisition_date`, first PO line by document date |
| **Filters** | exclude deleted PR items; exclude STO; require both dates present |
| **Minimum sample** | ≥ 30 matched PRs in each arm, else render `—` with "not enough matched PRs" |
| **Colour** | ≥ 1.0 red (urgent lane no faster); < 0.8 green |
| **Measured** | **0.50×** (urgent median 6 days, standard median 12 days; n = 2,568 / 7,575) |

v1's PRD claimed 1.40× as the reference value. Tested across six definition variants — PR date vs PR release date as start; urgent as {1,2} vs {0,1,2}; standard as {3,4} vs {3} — **every variant returns 0.50×**. The divergence is not formula ambiguity. On this data the urgent lane is genuinely twice as fast and the KPI reads green.

Note also the urgency distribution: `3` on 75% of items, with `0` (277 items) and `4` (104) undocumented in v1. Urgency `0` is excluded from both arms as undefined.

### 13.3 GR/IR exposure > 60 days

| | |
|---|---|
| **Formula** | `Σ still_to_be_invoiced_value WHERE aging > 60 ÷ Σ still_to_be_invoiced_value` |
| **Population** | PO lines with `still_to_be_delivered_qty = 0` and `still_to_be_invoiced_value > 0`; excluding STO |
| **Aging** | `as_of_date − po_document_date` |
| **Currency** | strict USD; per-currency fallback with an explicit `(IDR-based %)` note |
| **Measured** | **91.67%** on a USD-converted basis, across 986 lines. A raw mixed-currency sum gives 58.55% — that is what the original review reported, and it is the very error the strict-conversion rule prevents. |

v1 claimed 44%. Re-baseline against the fixture.

### 13.4 Open commitment > 60 days

| | |
|---|---|
| **Formula** | `Σ still_to_be_delivered_value WHERE aging > 60 ÷ Σ still_to_be_delivered_value` |
| **Population** | PO lines with `still_to_be_delivered_value > 0`; excluding STO; excluding deleted |
| **Measured** | **58.65%** on a USD-converted basis, across 4,414 lines (excluding deleted) |

### 13.5 WBS / AR compliance

| | |
|---|---|
| **Violation** | over-threshold item (per §12.7) with no WBS Element |
| **Reported as** | violating PR count, violating item count, value at risk, plus an `indeterminate` count for zero-valuation items |
| **Variants** | all PRs; open pipeline only |
| **Measured** | 1,119 items / 339 PRs / IDR 3.48 trillion; 4,211 items indeterminate |
| **Thresholds** | Administrator-configurable at runtime; the value in force is displayed on the card |
| **Status** | ✅ Confirmed real by the product owner (30 Jul 2026) — ships as a settled control metric |

### 13.6 Cycle-time KPIs

Median and p90 of each measure in §12.9, sliced by purchasing group, plant, material group, vendor and month. Each renders `—` below a 30-observation minimum for the slice rather than showing a median of three rows.

### 13.7 Operational counts

Open items by status and aging band; pending approvals by PIC (PR and PO); retro POs; split-sourced items (**645, max 33** — the one v1 reference figure that reproduces exactly); reversal rate; STO share; direct-PO share (**43.7%**); dangling links (291).

### 13.8 Drill-down guarantee

v1 guaranteed "drill count equals chart count" by stashing exact row sets in browser memory at render time. Server-side, the guarantee is stronger and cheaper:

- Every aggregate response includes a **`drillToken`**: a signed, short-lived (15 min), user-bound reference to the exact predicate — filter set, grouping key, bucket value, dataset version, scope — used to compute that figure.
- `GET /api/drill/{token}` re-executes that same predicate against the same dataset version and returns the rows, paginated.
- Because both the aggregate and the drill derive from one predicate against one immutable version, the counts are equal **by construction**, not by convention.
- The token is signed and bound to the session, so it cannot be used to widen scope or reach another user's data.
- "Others" buckets carry the assembled predicate of their members and drill correctly.
- Drills that resolve to zero rows return an explicit empty state naming the reason — never a blank modal.

---

# Part IV — Features

## 14. Data freshness & lineage

A specific requirement: the application must always show when the data was last updated.

### 14.1 Global freshness banner

Persistently visible in the application header on every screen, never behind a click:

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Data as of 27 Jul 2026   ·   loaded 30 Jul 2026 09:15 (Synology auto-sync)│
│  ● Current                                                    Details ▾    │
└────────────────────────────────────────────────────────────────────────────┘
```

| Element | Meaning |
|---|---|
| **Data as of** | `as_of_date` of the published version (§12.8) — the business date the data describes |
| **loaded** | `published_at` — when this version went live |
| **source** | `Synology auto-sync` or `Manual upload — <user display name>` |
| **state dot** | freshness state |

| State | Rule (configurable) | Presentation |
|---|---|---|
| ● **Current** | `as_of_date` within 2 days of today | green |
| ● **Ageing** | 3–7 days | amber |
| ● **Stale** | > 7 days | red + `data.stale` notification |
| ● **Caveats** | any `CAVEAT` finding active | amber with a link to the validation report |
| ● **Loading** | a batch is transforming | spinner; the current version keeps serving |

Because aging KPIs are computed against `as_of_date` and not wall-clock time, a stale dataset produces *stale* numbers, not *drifting* ones. The banner explains why they are not moving.

### 14.2 Details panel

Expanding **Details** shows, without leaving the page:

- Dataset version id, `as_of_date`, `published_at`, `published_by`, source path or upload
- Per feed: filename, SHA-256 (abbreviated), size, row count, and **delta vs the previous version** (e.g. `PO Report — 20,804 rows (+312)`)
- Validation summary by severity, linking to the full report
- Active caveats and the KPIs they disable
- Prior versions with as-of dates (Admin sees a Roll back action)

### 14.3 Row-level lineage

Every drill row can expose its provenance: source feed, source filename, source row number, ingestion batch id, and the join method and link provenance that produced it. This is what makes O3 and the Auditor persona real, and it is why staging rows are retained per version.

---

## 15. Notification subsystem

A specific requirement: email notification whenever new data arrives, with administrator-configurable recipients.

### 15.1 Events

| Event key | Trigger | Default severity | Default recipients |
|---|---|---|---|
| `data.published` | A new dataset version becomes active | info | Subscribed users |
| `data.published.with_caveats` | Published with active `CAVEAT` findings | warning | Subscribed + Data Stewards |
| `ingest.failed` | Batch reached `FAILED` | error | Data Stewards + Admins |
| `ingest.template_drift` | A required column unresolvable, or an unexpected column appeared | error | Data Stewards + Admins |
| `ingest.incomplete_bundle` | Poll found a partial file set | warning | Data Stewards |
| `ingest.stalled` | Bundle incomplete for N consecutive cycles | error | Data Stewards + Admins |
| `ingest.source_unavailable` | Synology mount unreachable | error | Admins |
| `data.stale` | `as_of_date` older than the stale threshold | warning | Subscribed + Admins |
| `data.rolled_back` | An Admin rolled back a version | warning | Admins + subscribed |
| `system.smtp_failure` | Notification delivery failed after retries | error | Admins (via the alerting channel, not email) |

### 15.2 Recipient configuration — Admin console

Fully administrator-managed, no code change or redeploy to alter:

- **Subscriptions** are a matrix of *recipient × event*. A recipient is an application user, an external email address, or a named distribution list.
- **Scope filter per subscription** — company code / plant / purchasing org. A plant controller receives notifications only for datasets touching their plant.
- **Delivery mode per subscription** — `immediate` or `daily digest` at a configured local time.
- **Severity floor per subscription** — e.g. "errors only".
- **Quiet hours** per subscription, with an override for `error` severity.
- **External addresses require Admin confirmation** and are marked as such in the audit log, since they represent data egress.
- **Test send** per subscription, delivering a clearly-marked sample. Test sends are audited.
- Users may unsubscribe themselves from `info` events; `error` subscriptions are Admin-controlled only.

### 15.3 Email content

Plain-text and HTML multipart, no remote images, no tracking pixels, no external assets.

```
Subject: [Procurement Control Tower] New data published — as of 27 Jul 2026

A new dataset version is live.

  Version      2026-07-30-01
  Data as of   27 Jul 2026
  Published    30 Jul 2026 09:15 (Synology auto-sync)
  Published by System

Feed changes vs previous version
  PR Report      20,110 rows   (+118)
  PR Release     27,742 rows   (+204)
  PO Report      20,804 rows   (+312)
  PO Release     10,807 rows   (+96)
  GR List        28,897 rows   (+441)
  FX rates          230 rows   (unchanged)

Validation
  Blockers 0 · Caveats 1 · Warnings 6

  CAVEAT  PR Report — requested delivery date is not distinct from release
          date (0.60% of rows differ). Demand Realism remains disabled.

Open the dashboard: https://procurement.energi-up.com

You receive this because you subscribe to "New data published".
Manage your notifications: https://procurement.energi-up.com/settings/notifications
```

Notification emails carry **no procurement figures beyond row counts and validation summaries** — no vendor names, no values, no line detail. Email is not an access-controlled channel, so it must not become a data-exfiltration path. Recipients follow a link and authenticate.

### 15.4 Delivery guarantees

- Notifications are BullMQ jobs with retry and exponential backoff (5 attempts over ~30 minutes).
- Every attempt is recorded in `notification_delivery` with recipient, event, status, SMTP response and timestamp — queryable in the Admin console.
- `NOTIFY_RATE_LIMIT_PER_HOUR` caps total sends; when exceeded, events coalesce into a single digest rather than being dropped.
- Deduplication: identical event + dataset version + recipient sends once.
- A publish is **never rolled back because email failed**. Notification is a side effect; delivery failure raises `system.smtp_failure` through the alerting channel.
- Target: 99% delivered within 5 minutes of publish (O6).

---

## 16. API specification

REST over JSON. Base path `/api/v1`. All responses carry `datasetVersionId` and `asOfDate` so a client can never render figures from two versions side by side without noticing.

### 16.1 Authentication

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/auth/oidc/login` | public | Begin SP-initiated SSO — redirect to the Hub |
| `GET` | `/auth/oidc/callback` | public | Receive the code; handles **both** SP- and IdP-initiated flows |
| `POST` | `/auth/local/login` | public | Local account login (rate-limited) |
| `POST` | `/auth/local/mfa` | partial session | TOTP verification |
| `POST` | `/auth/logout` | session | Destroy the server-side session |
| `GET` | `/api/v1/me` | session | Identity, roles, data scope, capabilities |

### 16.2 Data & analytics

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/dataset/current` | Viewer | Version, as-of date, freshness state, source, feed row counts |
| `GET` | `/api/v1/dataset/versions` | Viewer | Retained versions |
| `GET` | `/api/v1/dataset/{id}/validation` | Analyst | Full validation report |
| `GET` | `/api/v1/kpi` | Viewer | KPI set for the active filter context |
| `GET` | `/api/v1/chart/{chartId}` | Viewer | Series plus a `drillToken` per data point |
| `GET` | `/api/v1/drill/{token}` | Analyst | Exact rows behind a figure, paginated |
| `GET` | `/api/v1/rows` | Analyst | Detail table: server-side filter, sort, paginate |
| `GET` | `/api/v1/rows/{id}/lineage` | Analyst | Row provenance |
| `GET` | `/api/v1/entity/vendor/{code}` | Analyst | Vendor 360 |
| `GET` | `/api/v1/entity/material/{code}` | Analyst | Material view with full PO history |
| `GET` | `/api/v1/entity/category/{code}` | Analyst | Category view |
| `POST` | `/api/v1/export` | Analyst | Async export job; returns a job id |
| `GET` | `/api/v1/export/{jobId}` | Analyst | Status, then a one-time signed download URL |

### 16.3 Ingestion

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/ingest/batches` | Analyst | Batch history with states |
| `GET` | `/api/v1/ingest/batches/{id}` | Analyst | Batch detail, per-file results, timings |
| `POST` | `/api/v1/ingest/upload` | Data Steward | Multipart upload; returns a staged batch id |
| `POST` | `/api/v1/ingest/batches/{id}/confirm` | Data Steward | Confirm classification and run the pipeline |
| `POST` | `/api/v1/ingest/batches/{id}/cancel` | Data Steward | Cancel before publish; discards staged data |
| `POST` | `/api/v1/ingest/sync` | Data Steward | Trigger a Synology poll immediately |
| `POST` | `/api/v1/dataset/{id}/publish` | Admin | Publish a `READY` version |
| `POST` | `/api/v1/dataset/{id}/rollback` | Admin | Make a retained version active |

### 16.4 Administration

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/v1/admin/users` | Admin | Users, roles, data scopes |
| `GET`/`PUT` | `/api/v1/admin/notifications/subscriptions` | Admin | Recipient × event matrix |
| `POST` | `/api/v1/admin/notifications/test` | Admin | Test send |
| `GET` | `/api/v1/admin/notifications/deliveries` | Admin | Delivery log |
| `GET`/`PUT` | `/api/v1/admin/rules` | Admin | Rule configuration with effective dates |
| `GET`/`PUT` | `/api/v1/admin/templates` | Data Steward | Template contract versions, aliases, mappings |
| `GET` | `/api/v1/admin/templates/{feed}/blank` | Data Steward | Download a blank template |
| `GET`/`PUT` | `/api/v1/admin/smtp` | Admin | SMTP settings (write-only password) |
| `GET` | `/api/v1/audit` | Auditor, Admin | Audit log, filterable |
| `GET` | `/api/v1/health` · `/ready` | public / internal | Probes |

### 16.5 Conventions

- Errors follow RFC 9457 `application/problem+json` with a stable `type`, and never leak stack traces, SQL, file paths or internal hostnames.
- Every response carries `X-Request-Id`, logged and shown in UI error states for support.
- Pagination is cursor-based with a hard `limit` cap of 1,000.
- Rate limits: 100 req/min per session for reads, 10/min for exports, 5/hour for uploads.
- Long operations return `202` with a job id; clients poll. No request holds a connection for minutes.

---

## 17. Frontend specification

### 17.1 Tabs

| Tab | Grain | Content |
|---|---|---|
| **Executive** | mixed | P1 KPI cards, monthly trend, status mix, top movers |
| **Open Items** | PR item + PO line | Aging bands, severity, open WBS violations, drill-heavy table |
| **PR** | `fact_pr_item` | Demand profile, urgency mix, requisitioner and group workload, WBS compliance |
| **PO** | `fact_po_line` | Spend, commitment, GR/IR, vendor and purchasing-group views, price analytics (STO excluded), **direct POs as first-class** |
| **Delivery** | `fact_gr_posting` | Ordered vs received by month, in-transit (`641`), reversals, delivery vs promise with its EINDT caveat |
| **Approvals** | release facts | Bottlenecks by sequence and PIC, pending queues, retro POs |
| **Governance** | mixed | WBS/AR, STO share, token prices, deleted-after-approval, data anomalies |
| **Data Check** | batch | Validation report, feed health, template status, lineage |

Tabs render deferred: only the active tab issues queries.

### 17.2 Interaction

- Global filters (company, plant, purchasing org, date range, exclusions) apply to every tab and are encoded in the URL so a view is shareable — subject to the recipient's own scope, which is always re-applied server-side.
- Every card and chart element is clickable and opens a drill modal via its `drillToken`.
- Detail table: server-side sort, filter and pagination; drag-to-reorder and hide columns, persisted **server-side per user** (v1 used `localStorage`, which the v1 PRD itself conceded was unreliable in its hosting sandbox).
- Entity popups (Vendor 360, Material, Category) preserve v1's behaviour, including per-currency composition, Price Unit display, `🚚` STO tagging and `⚠` token-price flags.
- Adaptive value units: millions with an `M` suffix only at ≥ 1,000,000; below that the full amount.

### 17.3 Accessibility

WCAG 2.1 AA. Severity is never encoded by colour alone — always colour plus icon or text. Contrast ≥ 4.5:1 for text and ≥ 3:1 for graphical objects, verified in both light and dark themes. Full keyboard navigation including the drill modal, with focus trapping and restoration. Charts expose an accessible data table alternative. This was absent from v1 and matters for a dense, colour-coded analytics UI.

### 17.4 Empty, error and loading states

Every chart and card specifies all four states. A missing prerequisite renders `—` with a tooltip naming what is missing (v1's "needs GR + requested dates" pattern), never a zero or a blank canvas.

---

## 18. Admin console

| Section | Contents |
|---|---|
| **Users & access** | Users, role assignment, data scope, session revocation, local-account lifecycle, MFA reset |
| **Data & ingestion** | Batch history, validation reports, manual upload, trigger sync, publish, roll back, retention |
| **Templates** | Contract versions, column aliases, steward mappings, blank template download, drift history |
| **Business rules** | WBS thresholds and basis, STO suffix, aging threshold, FX policy, no-release-strategy policy, exclusions — each with an effective date and full change history |
| **Notifications** | Recipient × event matrix, scope filters, digests, quiet hours, test send, delivery log |
| **System** | SMTP, Synology source, freshness thresholds, retention, health dashboard |
| **Audit** | Filterable audit trail with export |

Every rule change is versioned with an effective date and an author, and is shown in the UI wherever the affected figure appears ("WBS basis: per item, effective 1 Aug 2026"). A KPI must never change silently because someone edited a threshold.

---

# Part V — Cross-cutting

## 19. Security

### 19.1 Authentication — DWS Hub OIDC

Per the Hub integration guide, the app is a **public client using Authorization Code + PKCE (S256)**. There is no `client_secret` — do not request or invent one.

| Property | Value |
|---|---|
| Flow | Authorization Code + PKCE `S256` |
| Client type | Public (`token_endpoint_auth_methods: ["none"]`) |
| `id_token` signing | RS256, verified against the Hub's JWKS |
| Scopes | `openid email profile` |
| Discovery | `/api/sso/.well-known/openid-configuration` |
| User key | the **`sub`** claim — `VARCHAR(255)`, never email |

**Both login flows must work.** This is the single largest integration risk and must be an explicit test case:

- **SP-initiated** — the user starts at our app; `/auth/oidc/login` stores `state`, `nonce` and the PKCE verifier in the session; the callback completes normally.
- **IdP-initiated** — the user clicks our tile in the Hub dashboard. `/auth/oidc/login` **never runs**. The Hub creates the PKCE challenge and redirects straight to our callback with `code_verifier` in the query string. A stock OIDC library fails here with a state-mismatch error. When `code_verifier` is present, the callback must perform the token exchange manually.

In the IdP-initiated flow there is no `state` to check, so the **id_token signature is the only trust anchor**. It must always be verified against the JWKS, with `iss` equal to the discovery issuer, `aud` equal to our `client_id`, and `exp`/`iat` enforced. Never skip verification, and never accept an unsigned or `alg: none` token.

Token-exchange contract — `POST /api/sso/token`:

| Field | Required | Note |
|---|---|---|
| `grant_type` | ✓ | `authorization_code` |
| `code` | ✓ | single-use, short-lived |
| `code_verifier` | ✓ | from the Hub (IdP-initiated) or the session (SP-initiated) |
| `redirect_uri` | ✓ | byte-exact; omitting it returns `invalid_request` |
| `client_id` | ✓ | public client |
| `client_secret` | ✗ | does not exist |

**The body must be JSON, not form-encoded.** Form encoding returns `unsupported_grant_type`. The HTTP client must log the OAuth error body on failure — an opaque `400` is otherwise undiagnosable.

Provisioning: first successful SSO login creates a user record keyed on `sub`, with role `Viewer` and **empty data scope** — visible to no data until an Admin grants scope. No auto-elevation, no scope inferred from an email domain or a Hub group without an explicit mapping an Admin has configured.

### 19.2 Authentication — local accounts

Local accounts exist as a break-glass path for when the Hub is unavailable, and for service or contractor accounts outside the Hub.

- Argon2id (`memory ≥ 64 MB`, `iterations ≥ 3`), unique salt.
- Policy: ≥ 12 characters, checked against a breached-password list, no forced rotation.
- **TOTP MFA mandatory** in production (`LOCAL_AUTH_REQUIRE_MFA=true`).
- Lockout after 5 failures for 15 minutes, per account and per source IP.
- Timing-safe comparison; identical response time and message for unknown user and wrong password.
- Every local account requires documented Admin approval, carries an expiry date, and appears on a monthly access review report.
- `LOCAL_AUTH_ENABLED=false` disables the path entirely for environments that do not need it.

### 19.3 Sessions

- Server-side sessions in Redis; the cookie carries only an opaque 256-bit id.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Secure=true` (production), `Path=/`, no `Domain` attribute.
- Session id rotates on privilege change and on login.
- Idle timeout 60 minutes; absolute timeout 12 hours.
- Logout destroys the server-side record — not just the cookie.
- Admins can revoke any session immediately.
- Concurrent sessions are permitted and listed in the user's profile.

Single origin (§5.2) is what makes `SameSite=Lax` viable and removes the need for CORS entirely. **CORS is disabled**, which eliminates a whole class of misconfiguration.

### 19.4 Authorization

- Route guards enforce role; a missing guard is a build-time failure via a lint rule requiring an explicit decorator on every controller method.
- **Data scope is applied in the data layer, not the controller.** Every analytics query takes a scope parameter from the session and composes it into the `WHERE` clause. There is no code path that can query facts without a scope.
- `drillToken` payloads embed the issuing user's scope; a replayed or shared token cannot widen access.
- Default deny: unmapped route, unknown role, or empty scope yields no data.

### 19.5 Transport & headers

- TLS 1.2 minimum, 1.3 preferred; modern cipher suites; HSTS with a 1-year max-age once TLS is confirmed stable.
- HTTP redirects to HTTPS.
- Because all assets are vendored, a strict CSP is achievable and required:

```
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data:;
font-src 'self';
connect-src 'self';
frame-ancestors 'none';
form-action 'self';
base-uri 'self';
object-src 'none'
```

- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy` denying camera, microphone and geolocation.
- No inline scripts or styles — no `unsafe-inline`. This is a direct benefit of dropping the single-file, CDN-dependent v1 architecture.

### 19.6 File-upload security

Uploads are the largest attack surface in the system. Every gate below is mandatory:

| Gate | Rule |
|---|---|
| Size | ≤ `UPLOAD_MAX_FILE_MB` per file; ≤ `UPLOAD_MAX_BATCH_MB` per batch; enforced at nginx and again in the app |
| Count | ≤ 6 files per batch |
| Extension | `.xlsx` / `.XLSX` only (`.xls` and `.xlsm` rejected — no legacy binary, no macros) |
| Magic bytes | Must begin `PK\x03\x04` and contain `[Content_Types].xml` |
| Filename | Never used as a filesystem path; stored under a generated UUID; HTML-escaped everywhere it is displayed |
| Storage | Outside the web root, mode `0600`, on a dedicated volume with a quota |
| Anti-virus | ClamAV scan before parsing; a failed scan quarantines and alerts |
| Zip-bomb | Reject if uncompressed size ÷ compressed size > 200, or total uncompressed > 500 MB |
| XML entity expansion | XXE and entity expansion disabled in the parser |
| Formula evaluation | Parser reads values only; formulas are never evaluated |
| External references | Rejected — no workbook links, no `oleObject`, no remote images |
| Sheet/cell limits | ≤ 20 sheets; ≤ 2,000,000 cells |
| Parse isolation | Parsing runs in a worker with a memory cap and a 5-minute timeout; a crash fails one batch, not the process |
| Retention | Spooled uploads deleted after the batch reaches a terminal state; only metadata and hashes are retained |

**Export-side formula injection:** any exported cell whose value begins `=`, `+`, `-`, `@`, tab or carriage return is prefixed with an apostrophe. SAP text fields contain user-entered content and a CSV opened in Excel is a code-execution path.

### 19.7 Data protection & privacy

The feeds contain personal data: GR `User Name`, release `Login Name`, `PIC Release` names, PR `Requisitioner` and `Created by` — **368 distinct requisitioners** in the current data. Under Indonesia's PDP Law (UU 27/2022) this requires a stated position.

- **Purpose limitation** — approval and requisition identities are processed solely for procurement process analytics (bottleneck and workload analysis). Documented in a privacy note linked from the footer.
- **Minimisation** — `Login Name` is ingested because it identifies approvers uniquely, but is **not displayed**; the UI shows `PIC Release` role names. Login identifiers are available only to Auditors and Admins.
- **Retention** — personal identifiers are retained only for the retained dataset versions (default 12). Pruning a version removes them.
- **Access control** — no persona below Analyst sees individual-level attribution; individual performance ranking is deliberately not a feature.
- **Egress control** — exports are audited; notification emails carry no personal data; external notification addresses require explicit Admin approval.
- **Encryption** — TLS in transit; encryption at rest on the database volume; database and NAS credentials in root-owned secret files.
- No procurement data is ever sent to a third-party service. There is no third-party runtime origin at all.

### 19.8 Audit log

Append-only, tamper-evident (hash-chained), retained 24 months minimum:

authentication (success, failure, method, source IP, user agent) · logout and session revocation · role and scope changes · rule-configuration changes with before/after values · template and mapping changes · ingestion batch lifecycle transitions · publish and rollback · exports (who, what scope, row count) · notification-subscription changes and test sends · admin logins to the console · all authorization denials.

### 19.9 Application security practices

- All queries parameterised; no string-concatenated SQL. Analytics SQL is reviewed and lives in version control, not generated from user input.
- Input validation with Zod at every boundary; unknown fields rejected, not ignored.
- Output encoding by default in React; `dangerouslySetInnerHTML` prohibited by lint rule.
- Dependency scanning (`npm audit`, Dependabot or Renovate) in CI; build fails on high or critical.
- SAST (CodeQL or Semgrep) and secret scanning (Gitleaks) in CI.
- Containers run as a non-root user, read-only root filesystem, no capabilities beyond those required, pinned base image digests.
- Penetration test against staging before go-live, including both SSO flows, upload handling, scope enforcement and drill-token replay.
- Documented patch SLA: critical within 7 days, high within 30.

---

## 20. Scalability & performance

### 20.1 Targets

| Metric | Target |
|---|---|
| p95 KPI endpoint latency | ≤ 500 ms |
| p95 drill query latency | ≤ 1.5 s (first page of 100 rows) |
| p95 detail-table page | ≤ 800 ms |
| Dashboard first contentful paint | ≤ 2 s on corporate LAN |
| Full-bundle ingestion (~110k rows) | ≤ 5 minutes |
| Concurrent active users | 50 sustained, 150 peak |
| Export of 100,000 rows | ≤ 60 s, delivered asynchronously |
| Availability (business hours) | 99.5% |

### 20.2 How the targets are met

**Precomputed marts.** KPI aggregates are computed once at publish time into `mart` tables, keyed by dataset version and the standard slicing dimensions. A KPI request is an indexed read of a small table, not an aggregation over 20,000 fact rows per user per page load. This is the single most important performance decision: read cost becomes independent of user count.

**Immutable versions make caching trivial.** A published dataset version never changes, so `(datasetVersionId, filterHash, scopeHash)` is a perfectly safe cache key with no invalidation logic. Redis holds KPI and chart responses; HTTP responses carry a long `max-age` with the version id in the ETag. Publishing a new version changes every key at once.

**Partitioning.** Fact tables are partitioned by `dataset_version_id` (Annex B). Every query is naturally partition-pruned to one version. Pruning old versions is `DROP TABLE` on a partition, not a mass `DELETE` with the vacuum cost that follows.

**Streaming ingestion.** XLSX files are parsed as streams into `COPY`-based bulk inserts. No feed is ever fully materialised in memory. Peak ingestion memory is bounded and independent of file size.

**Server-side everything for tables.** Filtering, sorting and pagination happen in SQL with covering indexes. v1 sorted and filtered ~21,000 rows in the browser on every interaction.

**Stateless backend.** Sessions and queues live in Redis, so the backend scales horizontally by adding processes (Node cluster mode across available cores) or additional instances behind the nginx upstream. Nothing in the design assumes a single process.

**Worker separation.** Ingestion and notification run in a separate process from the API. A five-minute transform cannot degrade interactive latency, and the two can be scaled independently.

### 20.3 Headroom

Current volume is ~110,000 rows per version. Twelve retained versions is ~1.3 million fact rows — comfortably inside single-node PostgreSQL. The design accommodates roughly 100× growth (more company codes, longer history, daily rather than periodic snapshots) before sharding or a columnar store becomes worth discussing. Growth levers, in order: raise instance-3 resources → add read replicas for analytics → move marts to columnar storage.

The scalability risk is not row count. It is **concurrent users against uncached aggregates**, which the mart design removes, and **ingestion contention**, which the single-publisher mutex and worker separation contain.

---

## 21. Observability

- **Structured logs** (Pino, JSON) with `requestId`, `userId`, `sessionId`, `batchId`, `datasetVersionId` where applicable. No secrets, no tokens, no `code`, no `code_verifier`, no row-level business data in logs.
- **Metrics** (Prometheus): request rate, latency histograms and error rate per route; queue depth, job duration and failure counts; ingestion duration per stage; validation findings by severity; notification delivery outcomes; DB pool utilisation; cache hit ratio; NAS mount availability.
- **Dashboards** (Grafana): system health, ingestion pipeline, data freshness, authentication outcomes.
- **Alerts**: ingestion failed · bundle stalled · NAS unreachable · SMTP failing · p95 latency breach · error-rate spike · disk above 80% · certificate expiring within 30 days · data stale beyond threshold.
- **Health endpoints**: `/api/v1/health` (liveness, unauthenticated, no internal detail) and `/api/v1/ready` (readiness — DB, Redis, NAS mount, Hub discovery reachability, SMTP).
- **Correlation**: `X-Request-Id` flows nginx → API → worker → logs, and is displayed in UI error states so a user can quote it to support.

---

## 22. Backup, DR & retention

| Asset | Method | RPO | RTO |
|---|---|---|---|
| PostgreSQL | Nightly full + continuous WAL archiving to separate storage | 15 min | 2 h |
| Redis | Sessions and queues are rebuildable; no backup required | n/a | n/a |
| Configuration & secrets | Version-controlled config; secrets in the corporate vault with documented restore | n/a | 1 h |
| Application images | Registry with retained tagged builds | n/a | 30 min |
| Source export files | Remain on the Synology NAS under its own backup regime — this application never becomes the system of record for source files | n/a | n/a |

- Restore is **tested quarterly**, into staging, with the result recorded. An untested backup is not a backup.
- Data retention: 12 dataset versions (configurable); audit log 24 months; notification delivery log 12 months; validation reports for the life of their dataset version.
- A documented runbook covers: rollback of a bad dataset, NAS outage, Hub outage (local break-glass login), SMTP outage, database restore, and certificate renewal.

---

## 23. Testing strategy

### 23.1 Layers

| Layer | Coverage |
|---|---|
| Unit | `packages/rules` — every business rule with boundary cases. Target ≥ 95% branch coverage on this package specifically |
| Contract | Parsing and validation against the frozen fixture and against deliberately corrupted variants |
| Integration | API endpoints against a real PostgreSQL in Docker, including scope enforcement |
| Golden-number | Full pipeline over the fixture, asserting every KPI to the digit (§23.2) |
| Security | Authn/authz matrix, scope leakage, drill-token replay, upload gates, injection, both SSO flows |
| Performance | Load test at 50 and 150 concurrent users against the target set in §20.1 |
| E2E | Playwright: login (both flows), navigate, filter, drill, upload, publish, roll back, notification config |
| Accessibility | axe-core in CI plus one manual keyboard and screen-reader pass per release |

### 23.2 Golden-number fixture — the key control

O2 depends on this, and it is the direct answer to v1's unverifiable "reproduces the reference figures" criterion.

1. Freeze an anonymised derivative of the `Assets/` exports into `/tests/fixtures` — vendor names, requisitioner names and login identifiers replaced by stable pseudonyms; document numbers, dates, quantities and values preserved exactly so all counts and cycle times are unchanged.
2. Run the full pipeline over it and commit the resulting KPI values as the expected set.
3. CI fails on any unexplained change to a golden number.
4. Changing a golden number requires a PR that states which rule changed and why. **A KPI cannot change without a reviewed, recorded decision.**

Known values from the current data, to seed the fixture:

| Assertion | Expected |
|---|---|
| Feed row counts | 20,110 / 27,742 / 20,804 / 10,807 / 28,897 / 230 |
| Split-sourced PR items; max PO lines on one item | **645 · 33** |
| STO lines / POs | 4,453 · 767 |
| PO lines with no PR reference | 9,094 (43.7%) |
| PR items reaching a PO | 10,378 (51.6%) |
| Dangling PR references | 291 |
| GR orphans against PO Report | **0** |
| PR Release continuation rows correctly attached | 13,338 of 13,338, 0 violations |
| Token-price lines (non-STO) | 107 |
| Zero-price non-STO lines | 74 |
| Expedite Effectiveness | **0.50×** (urgent 6 d, standard 12 d) |
| GR/IR > 60 d | **91.67%** |
| Open commitment > 60 d | **58.65%** |
| WBS violations: items / PRs | 1,119 · 339 |
| Lines whose GR date preceded their first 101 (v1 defect, must now be 0) | 1,695 → **0** |
| Non-deleted lines with no release strategy | 241 lines · 89 POs |
| Fully reversed line keys | 92 |
| Demand Realism | **disabled** (assertion V-M01 fails) |

Anonymisation must be verified: no real vendor name, personal name or login identifier may remain. Fixture generation is scripted and reviewed, not manual.

---

## 24. CI/CD

**Pipeline:** lint and type-check → unit tests → contract tests → build → integration tests → golden-number tests → dependency scan, SAST, secret scan → container build and sign → deploy to staging → E2E and accessibility on staging → **manual approval gate** → deploy to production → smoke tests.

- Trunk-based development with short-lived branches; every change via PR with at least one review. `packages/rules` requires two reviewers, one from the procurement side.
- Migrations are forward-only, reviewed in PRs, and applied by the pipeline. Every migration carries a documented rollback path.
- Deployment is blue-green on the backend behind the nginx upstream; the frontend is an atomic static-bundle swap. Zero-downtime for read traffic.
- The application version, git SHA and build time are exposed at `/api/v1/health` and shown in the UI footer, so "it is still running old code" is always answerable.
- Production deploys are audited and notified.

---

# Part VI — Delivery

## 25. Functional requirements register

v1's positive/negative story format is retained — it was the strongest part of that document. IDs are stable for traceability.

### F1 — Data acquisition

| ID | Type | Story | Acceptance criteria |
|---|---|---|---|
| F1.1+ | Positive | As a Data Steward, the system picks up new SAP exports from the Synology folder without me doing anything, so the dashboard tracks SAP automatically. | Poll on schedule; complete changed bundle detected by header signature; batch runs end to end; new version published; `data.published` sent. |
| F1.1− | Negative | As a Data Steward, a partial file set does not produce a partial dataset, so nobody reads half-loaded numbers. | Batch not created; `ingest.incomplete_bundle` names the missing feeds; previously published version keeps serving unchanged. |
| F1.2+ | Positive | As a Data Steward, I upload files manually for an off-cycle refresh. | Files staged; classification and row counts shown for confirmation; on confirm the identical pipeline runs; publish audited and attributed to me. |
| F1.2− | Negative | As a Data Steward, I upload a file that is not one of the six templates, so nothing is force-fitted. | Listed as unrecognised with its detected header signature; no feed slot guessed; batch cannot be confirmed until resolved. |
| F1.3+ | Positive | As a Data Steward, re-running a sync with unchanged files changes nothing. | Hash set matches the published version; no-op logged; no new version; no notification. |
| F1.3− | Negative | As a Data Steward, a file still being written by SAP is not read half-formed. | Settle check skips files modified within the window or whose size changed since the last poll; picked up on a later cycle. |
| F1.4+ | Positive | As an Admin, a bad load can be undone immediately. | Rollback re-points the active version; effective within 2 minutes; audited; `data.rolled_back` sent. |
| F1.4− | Negative | As an Admin, the NAS being unreachable does not look like "no new data". | `/ready` reports degraded; `ingest.source_unavailable` raised; UI shows the source as unavailable rather than reporting zero files found. |

### F2 — Template governance & validation

| ID | Type | Story | Acceptance criteria |
|---|---|---|---|
| F2.1+ | Positive | As a Data Steward, renamed export files still load, so I need not police filenames. | Classification by normalised header signature only; the date-range in the current filenames plays no role. |
| F2.2+ | Positive | As a Data Steward, I remap a renamed column once and future loads self-heal. | Mapping stored server-side against the template version, audited, applied to all users and all subsequent loads. |
| F2.2− | Negative | As a Data Steward, a genuinely missing required column produces a red flag, not silent zeros. | `BLOCKER`; batch fails naming the column; nothing published; dependent cards would show `—`, never a fabricated value. |
| F2.3+ | Positive | As an Auditor, structural anomalies are declared on every load. | Validation report enumerates every `WARNING` with counts and drill-through, including token prices, STO share, zero valuations and dangling links. |
| F2.3− | Negative | As an Auditor, STO zero-price lines are not mislabelled as token prices. | Token rule excludes doc types ending `70`; the fixture asserts 107 token lines, not 4,527. |
| F2.4+ | Positive | As a Data Steward, a column that keeps its name but changes meaning is caught. | Semantic assertions run every load; a failure raises a `CAVEAT`, disables dependent KPIs and notifies me. |
| F2.4− | Negative | As an Analyst, a failed semantic assertion never yields a plausible-looking wrong number. | Dependent KPIs render `—` with the reason; excluded from summaries and exports. |

### F3 — FX & currency

| ID | Type | Story | Acceptance criteria |
|---|---|---|---|
| F3.1+ | Positive | As a Manager, amounts convert to USD using the rate for the document's own month. | Period-matched rate applied; `US$` and `USD` normalised; fallbacks tagged; resolved year recorded. |
| F3.1− | Negative | As a Manager, a missing rate never becomes a zero or a guessed IDR value. | Unresolvable rate yields NULL; the figure renders per currency with an explicit note; currency is never defaulted to IDR. |
| F3.2+ | Positive | As a reader, USD totals appear only when every currency in scope is rated. | Strict rule enforced per aggregate; otherwise per-currency output with an `(IDR-based %)`-style suffix. |
| F3.2− | Negative | As a Category Manager, a mixed-currency vendor is never summed raw. | Aggregation per currency first; USD only if all components rated; unrated components stay in document currency. |
| F3.3+ | Positive | As a Data Steward, a rate file lacking direct USD pairs still works. | Triangulation through a shared pivot currency; derived rates tagged; agreement with direct rates asserted in tests. |

### F4 — Analysis engine

| ID | Type | Story | Acceptance criteria |
|---|---|---|---|
| F4.1+ | Positive | As an Analyst, split sourcing is visible and never double-counted. | `bridge_pr_po` carries `split_seq`/`split_total`; PR-level counts use PR grain; fixture asserts 645 items, max 33. |
| F4.1− | Negative | As an Analyst, a PO naming a missing PR still appears. | `link_status = 'dangling'`; PO line intact; counted (291) and drillable; no PR attributes fabricated. |
| F4.2+ | Positive | As a Logistics user, STOs are treated as transport, so purchase analytics stay clean. | Excluded from price, quantity, PO count and vendor spend; retained in delivery; RTN shown; `🚚` tagged. |
| F4.2− | Negative | As a Logistics user, an unspecified doc-type series is not guessed. | Rule is exactly ends-with-`70`; `EO21`/`SC21`/`PS21`/`JP21` flow as normal purchases. |
| F4.3+ | Positive | As a Controller, over-threshold PRs without WBS are counted and drillable. | PR count, item count and value at risk; open-pipeline variant; threshold value, basis and effective date shown on the card, in drills and in exports. Fixture asserts 1,119 items / 339 PRs. |
| F4.3− | Negative | As a Controller, items with no valuation are not counted as compliant. | Zero/missing valuation reported as `indeterminate` in its own count, never as compliant. Fixture asserts 4,211 items. |
| F4.3a+ | Positive | As an Admin, I change a WBS threshold myself without a redeploy. | Editable in Admin → Business rules with effective date and author; change audited; takes effect on the next publish; published versions do not change retroactively; the new value appears on the card. |
| F4.3a− | Negative | As an Auditor, a compliance figure never moves without an explanation. | Every published version carries its `rule_snapshot`; a figure quoted previously reproduces exactly; any recompute of the current version is audited and notified. |
| F4.4+ | Positive | As an Analyst, "Delivered" means delivered. | Receipt date from `101` only; sign derived from movement type; `102`/`122` net; fixture asserts 0 contaminated dates and 92 fully-reversed keys. |
| F4.4− | Negative | As an Analyst, an unregistered movement type stops the load rather than being guessed. | `BLOCKER` V-R07 names the unknown type; nothing published. |
| F4.5+ | Positive | As an Analyst, stock-transfer postings are visible as transit, not receipts. | `641`/`642` classified `transfer`; excluded from receipt qty and date; shown in the Delivery tab's in-transit view. |
| F4.6+ | Positive | As an Analyst, direct POs with no PR are first-class. | `fact_po_line` is queried directly on the PO tab; the 9,094 direct lines appear in cards, charts, table and exports — not only in fallback popups. |
| F4.7+ | Positive | As an Analyst, POs with no release strategy stay in the pipeline and are visibly marked. | Deletion read from `Deletion indicator`; `not_subject_to_release` kept as its own state and never folded into approved or pending; `⚑` marker with tooltip on every surface — cards, charts, drills, table, entity views, exports; status driven by receipt state. |
| F4.7− | Negative | As an Auditor, live POs are never silently dropped as deleted, nor stranded in a queue they cannot leave. | Fixture asserts 241 lines / 89 POs / IDR 1,506,586,519 present in open-pipeline and commitment figures, absent from the pending-approval queue, and never classified as deleted. |
| F4.7a+ | Positive | As a Data Steward, I can always see how many release-exempt lines exist. | `WARNING` V-B10 reports count and value every load, drillable to the exact lines, regardless of the active policy. |

### F5 — KPIs

| ID | Type | Story | Acceptance criteria |
|---|---|---|---|
| F5.1+ | Positive | As a Manager, Demand Realism shows whether requested dates are achievable. | Activates automatically once V-M01 passes; formula, filters and minimum sample as §13.1. |
| F5.1− | Negative | As a Manager, the card does not invent a score from an unusable column. | While V-M01 fails, renders `—` with the reason; excluded from summaries; fixture asserts disabled. |
| F5.2+ | Positive | As a Manager, Expedite Effectiveness exposes whether the urgent lane is faster. | Ratio per §13.2; fixture asserts **0.50×**; colour thresholds applied. |
| F5.2− | Negative | As a Manager, a thin sample produces no ratio. | Below 30 matched PRs per arm, renders `—` with "not enough matched PRs"; no colour. |
| F5.3+ | Positive | As a Finance partner, GR/IR and commitment aging quantify stale exposure. | Shares per §13.3–13.4 computed against `as_of_date`; strict-USD with per-currency fallback; drillable. |
| F5.3− | Negative | As a Finance partner, aging never drifts because time passed. | All aging computed from `as_of_date`; reopening an unchanged version yields identical values; asserted in tests. |
| F5.4+ | Positive | As a Manager, cycle-time medians are trustworthy on thin slices. | Below 30 observations for a slice, renders `—`; p90 shown alongside the median. |

### F6 — Charts & drill-downs

| ID | Type | Story | Acceptance criteria |
|---|---|---|---|
| F6.1+ | Positive | As a user, clicking any figure opens exactly the rows behind it. | `drillToken` re-executes the identical predicate against the same version; counts equal by construction; asserted for every chart in E2E. |
| F6.1− | Negative | As a user, a drill can never return someone else's rows. | Token is signed, session-bound, 15-minute lifetime, and carries the issuing scope; replay by another session is rejected and audited. |
| F6.2+ | Positive | As a Delivery manager, ordered vs received by month shows fulfilment catch-up. | Both series drillable; STOs included in delivery; invariant `received ≤ ordered` asserted in tests. |
| F6.2− | Negative | As a user, a chart with no dated rows degrades cleanly. | Explicit placeholder naming the reason; no empty axes. |
| F6.3+ | Positive | As a user, an "Others" bucket drills to its members. | Assembled predicate returns exactly the aggregated members. |

### F7 — Entity views

| ID | Type | Story | Acceptance criteria |
|---|---|---|---|
| F7.1+ | Positive | As a Buyer, the material view shows full PO history. | Deduped lines newest-first with qty, unit price, Price Unit, document currency and USD, status and GR date; STO `🚚` and unpriced; token prices `⚠`. |
| F7.1− | Negative | As a Buyer, a small foreign-currency value is readable, not rounded to zero. | Adaptive units: millions only at ≥ 1,000,000; the 2,325 USD case asserted in tests. |
| F7.2+ | Positive | As a Category Manager, vendor spend shows its currency composition. | USD total plus per-currency breakdown inline, full detail in tooltip. |
| F7.2− | Negative | As a Category Manager, an unrated currency is never silently converted. | Unrated components remain in document currency; USD shown only for the rated part. |

### F8 — Freshness, personalisation & export

| ID | Type | Story | Acceptance criteria |
|---|---|---|---|
| F8.1+ | Positive | As any user, I always know how current the data is. | Banner shows as-of date, load time, source and state on every screen; details panel gives version, per-feed deltas and validation summary. |
| F8.1− | Negative | As any user, stale data is called stale. | Beyond the threshold the state turns red and `data.stale` is raised; figures remain visible but flagged. |
| F8.2+ | Positive | As a power user, my column layout survives sessions and devices. | Order and visibility persisted server-side per user; new columns append without breaking a saved layout. |
| F8.3+ | Positive | As an Admin, an exclusion applies everywhere. | Exclusion configs apply consistently across cards, charts, drills, entity views and exports; each shown in the active-filter chips. |
| F8.3− | Negative | As an Admin, clearing an exclusion fully restores scope. | Removal takes effect on the next render with no residue; asserted in tests. |
| F8.4+ | Positive | As an Analyst, I export what I am looking at. | Async job; export carries dataset version, as-of date, active filters and scope in a header sheet; audited. |
| F8.4− | Negative | As an Analyst, an export cannot execute code in Excel. | Cells beginning `=`, `+`, `-`, `@`, tab or CR are apostrophe-prefixed; asserted in tests. |

### F9 — Notifications

| ID | Type | Story | Acceptance criteria |
|---|---|---|---|
| F9.1+ | Positive | As a subscriber, I am emailed when new data is published. | Email within 5 minutes with version, as-of date, source, per-feed deltas and validation summary; delivery logged. |
| F9.1− | Negative | As a subscriber, a failed load does not look like a successful one. | `ingest.failed` goes to Stewards and Admins with the reason and batch link; no `data.published` is sent. |
| F9.2+ | Positive | As an Admin, I choose who receives what without a redeploy. | Recipient × event matrix with scope filter, digest mode, severity floor and quiet hours; changes audited and effective immediately. |
| F9.2− | Negative | As an Admin, adding an external address is a deliberate act. | External addresses require explicit confirmation, are marked as external, and are audited. |
| F9.3+ | Positive | As an Admin, I can prove whether a notification was delivered. | Delivery log with recipient, event, attempts, status and SMTP response, filterable and exportable. |
| F9.3− | Negative | As an Admin, email problems never block data publication. | Publish succeeds independently; failures retry and then raise `system.smtp_failure` through the alerting channel. |
| F9.4+ | Positive | As an Admin, notifications never carry data that email should not. | Emails contain only counts, dates and validation summaries — no vendor names, values or line detail; asserted in tests. |

### F10 — Access & administration

| ID | Type | Story | Acceptance criteria |
|---|---|---|---|
| F10.1+ | Positive | As a staff user, I sign in with DWS Hub SSO from our app. | SP-initiated flow completes; session cookie present for the app hostname; user lands logged in. |
| F10.1− | Negative | As a staff user, I sign in by clicking the app tile in the Hub. | IdP-initiated flow with `code_verifier` in the query completes; id_token verified against JWKS with `iss`, `aud`, `exp` enforced; **explicitly tested**. |
| F10.2+ | Positive | As an Admin, I can still get in when the Hub is down. | Local break-glass account with mandatory TOTP; use is audited and alerted. |
| F10.2− | Negative | As an attacker, local login is not brute-forceable. | Argon2id, lockout after 5 attempts, per-IP throttle, identical response for unknown user and wrong password. |
| F10.3+ | Positive | As an Admin, a user sees only their own plants and orgs. | Scope applied in the data layer to every query, drill, export and notification; asserted by a scope-leakage test suite. |
| F10.3− | Negative | As a new SSO user, I see nothing until granted access. | First login creates a `Viewer` with empty scope and no data; no elevation inferred from email domain or Hub group without an Admin-configured mapping. |
| F10.4+ | Positive | As an Auditor, I can reconstruct who saw and changed what. | Hash-chained audit log covering authentication, admin changes, ingestion, publish, rollback and exports; retained 24 months. |
| F10.5+ | Positive | As an Admin, changing a business rule is visible in the numbers it affects. | Rule config is versioned with an effective date and author, and displayed alongside affected figures. |

---

## 26. Non-functional requirements register

| ID | Attribute | Requirement |
|---|---|---|
| N1 | Privacy | Procurement data never leaves the corporate perimeter. No third-party runtime origin. Personal identifiers minimised, access-restricted, and retained only for retained dataset versions. |
| N2 | Performance | §20.1 targets, verified by load test at 50 sustained and 150 peak concurrent users. |
| N3 | Ingestion | Full bundle (~110k rows, ~16 MB) validated, transformed and published in ≤ 5 minutes, memory-bounded via streaming. |
| N4 | Availability | 99.5% during business hours. Read traffic uninterrupted during deploys and during ingestion. |
| N5 | Reliability | No partial dataset is ever visible. Publish is atomic; failure leaves the prior version serving. Rollback ≤ 2 minutes. |
| N6 | Security | §19 in full. Zero open high/critical findings at go-live. Critical patches within 7 days. |
| N7 | Auditability | Every published figure traceable to source file, row and batch. Hash-chained audit log retained 24 months. |
| N8 | Honesty of figures | Strict conversion rule, adaptive units, anomaly tagging, `—` for unavailable, drill counts equal aggregate counts by construction. No fabricated or defaulted values anywhere. |
| N9 | Compatibility | Current Chrome, Edge and Firefox (latest two versions). Responsive from 1280 px; usable at 768 px. No CDN or external origin required. |
| N10 | Accessibility | WCAG 2.1 AA. Severity never conveyed by colour alone. Full keyboard operability. |
| N11 | Maintainability | ≥ 80% overall test coverage; ≥ 95% branch coverage on `packages/rules`. Forward-only reviewed migrations. Version and git SHA exposed at runtime. |
| N12 | Configurability | Business thresholds, FX policy, freshness thresholds, notification routing and exclusions are administrator-editable with effective dates — never code constants. |
| N13 | Scalability | Horizontal backend scaling with no code change. Headroom for ~100× current volume before architectural change. |
| N14 | Recoverability | RPO 15 minutes, RTO 2 hours for the database. Restore tested quarterly into staging. |
| N15 | Localisation | English UI. Data content may be mixed Indonesian/English and must render correctly (UTF-8 end to end). Dates displayed `dd MMM yyyy`; times in Asia/Jakarta with the zone shown. |
| N16 | Deployability | Reproducible container builds; identical artefacts to staging and production; configuration only by environment. |

---

## 27. Phased roadmap

Each phase is independently useful and independently testable.

### Phase 0 — Foundations (2 weeks)
Repository and CI skeleton · three-instance provisioning for staging · PostgreSQL and Redis · nginx single-origin layout · **DWS Hub SSO both flows working end to end** · local break-glass accounts · session handling · health endpoints · audit-log skeleton.

*Exit:* a user signs in via both SSO flows and sees an empty authenticated shell. Cookie behaviour verified in the browser. Because §5.2 and §19.1 are the highest-risk integration points, they are proven first, not last.

### Phase 1 — Ingestion & data contract (3 weeks)
Template contracts for all six feeds · header-signature classification · streaming parse to staging · structural, referential and semantic validation · dataset versioning with atomic publish and rollback · Synology watcher with settle and idempotency checks · manual upload with full security gates · validation report UI · **frozen fixture and golden-number harness**.

*Exit:* both ingestion paths produce a published, versioned dataset; the fixture reproduces the row counts and integrity assertions in §23.2.

### Phase 2 — Transformation & core analytics (4 weeks)
`packages/rules` complete and unit-tested · three fact tables, dimensions and the PR↔PO bridge · status derivation · STO segregation · corrected GR join · period-matched FX · as-of date and aging · marts · KPI and chart APIs · drill-token mechanism · Executive, PR, PO and Open Items tabs · freshness banner.

*Exit:* every golden number in §23.2 reproduces, including the corrected values (0 contaminated GR dates, 0.50× expedite, 91.67% GR/IR).

### Phase 3 — Full feature set (3 weeks)
Delivery, Approvals, Governance and Data Check tabs · entity views (Vendor 360, Material, Category) · detail table with server-side paging and persisted layouts · exports with injection neutralisation · notification subsystem with the admin matrix · admin console.

*Exit:* full feature parity with the v1 prototype, plus everything v1 lacked.

### Phase 4 — Hardening & go-live (3 weeks)
Load and performance tuning to §20.1 · penetration test and remediation · accessibility audit · backup and restore drill · runbooks · production provisioning · UAT with all six personas · training · go-live.

*Exit:* all §2 success metrics met; security sign-off; production live.

### Phase 5 — Post-go-live (ongoing)
Activate Demand Realism when the delivery-date feed change lands · confirm WBS and release-strategy policies against real usage · additional company codes as required.

**Total: approximately 15 weeks to production**, assuming the four blocking decisions in §29 are resolved during Phase 0–1.

---

## 28. Risks

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | The PR delivery-date export change is not delivered | Demand Realism never activates; a headline KPI is permanently absent | High | Raise in week 1; product ships with the KPI cleanly disabled so nothing else is blocked; assertion activates it automatically on arrival |
| R2 | SSO integration consumes disproportionate time | Phase 0 slips and everything downstream slips | Medium | Prove both flows first; follow the Hub guide's single-origin layout, JSON token body and IdP-initiated handling; budget the known failure modes |
| R3 | SAP export layout drift | Feeds stop classifying, or columns are misread | High | Signature classification + alias healing + steward mapping + `BLOCKER` on unresolvable columns + semantic assertions for meaning changes |
| R4 | WBS thresholds are revised and historical figures appear to change | Loss of confidence in a control metric | Low (D1 resolved) | Thresholds admin-editable with effective date and author; each version carries its `rule_snapshot` so published figures never change retroactively; the value in force is displayed on the card, drills and exports |
| R5 | The 89 release-exempt POs flow like approved orders under `flag_only` | Commitment and open-pipeline figures include orders whose approval status is genuinely unknown | Low (D2 resolved) | `⚑` marker on every surface makes the assumption visible; excluded from the pending queue; count and value reported every load as V-B10; policy remains configurable if the ruling changes |
| R6 | Synology share unavailable or permissions change | Silent absence of new data | Medium | Mount health in readiness probe; `ingest.source_unavailable` notification; stale-data state in the UI; read-only mount prevents damage |
| R7 | Malicious or malformed upload | Compromise or denial of service | Medium | Layered gates in §19.6; isolated parse worker; AV scan; strict CSP; audited uploads |
| R8 | Scope misconfiguration exposes data across plants | Confidentiality breach | Medium | Scope enforced in the data layer, not controllers; dedicated scope-leakage test suite; default-deny empty scope for new users |
| R9 | Golden numbers churn without decisions | Silent KPI drift returns | Medium | Fixture-based CI gate; changing a golden number requires a PR stating the rule change |
| R10 | Token/masked prices in source | Spend understated per vendor | High | Flagged per line and per load; excluded where it would mislead; upstream fix indicated |
| R11 | Notification fatigue leads users to ignore alerts | Real failures missed | Medium | Severity floors, digests, quiet hours, deduplication, rate limiting |
| R12 | Personal-data handling challenged under PDP Law | Compliance exposure | Low–Medium | Documented purpose, minimisation, retention and access restriction (§19.7); no individual performance ranking |
| R13 | Single database instance is a single point of failure | Outage stops all access | Medium | Documented RPO/RTO, tested restore, WAL archiving; read replica is the first scaling and resilience step |

---

## 29. Open decisions

Two of the four blocking decisions are resolved. D3 holds its recommended default; D4 is an external dependency being raised.

| # | Decision | Resolution | Status |
|---|---|---|---|
| **D1** | WBS/AR threshold basis and validity | **Per item. 89.7% non-compliance confirmed real. Thresholds administrator-configurable at runtime** with effective date and author; the value in force is displayed on the card and in exports. 4,211 unvalued items reported as `indeterminate`, never compliant. | ✅ **Resolved 30 Jul 2026** (§12.7) |
| **D2** | POs with no release strategy (241 lines / 89 POs / IDR 1.51bn) | **`flag_only`.** Left in the pipeline as-is and marked `⚑`; `po_release_state` stays `not_subject_to_release`; status driven by receipt state; excluded from the pending-approval queue; included in open-pipeline, commitment and delivery analytics; count and value always reported in Data Check. | ✅ **Resolved 30 Jul 2026** (§12.4) |
| **D3** | FX basis | **Period-matched monthly** (`RULE_FX_POLICY=period_matched`) — a document is converted at its own month's average rate, with the fallback chain in §12.6 and the policy plus resolved period shown on every converted figure. | ✅ **Resolved 30 Jul 2026** (§12.6) |
| **D4** | PR delivery date in the SAP export | Add SAP `EBAN-LFDAT` to the ME5A export variant, or permanently descope Demand Realism. **External dependency** — requires whoever owns the ME5A variant. | 🔴 **Open — raise in week 1** (§13.1, Annex A §A.2.1) |
| D5 | Movement types `641`/`642` presentation | in-transit view only · also a transit-aging KPI | In-transit view in Phase 3; KPI only if the business asks. | Phase 3 |
| D6 | Dataset retention | 12 versions | Confirm against the refresh cadence — 12 daily refreshes is under two weeks of rollback headroom. | Phase 1 |
| D7 | Doc-type series `EO21`/`SC21`/`PS21`/`JP21` (12 lines) | normal purchases · own classification | Treat as normal purchases; revisit if volume grows. | Phase 2 |
| D8 | Refresh cadence and expected as-of lag | daily · weekly | Determines the freshness thresholds in §14.1. | Phase 1 |
| D9 | Additional company codes beyond `EU` | now · later | Schema and scoping already support it; confirm whether any are in scope for go-live. | Phase 1 |
| D10 | Notification digest default time and quiet hours | — | Propose 07:00 Asia/Jakarta, quiet 19:00–07:00 with an error override. | Phase 3 |

---

## 30. Glossary

| Term | Meaning |
|---|---|
| **PR / PO / GR** | Purchase Requisition / Purchase Order / Goods Receipt (SAP documents) |
| **as-of date** | The business date a dataset version describes: `MAX(PO document date, GR posting date)`. All aging is computed from it, never from wall-clock time. |
| **batch** | One ingestion run: a set of files from one source with a single lifecycle |
| **dataset version** | An immutable, published set of facts derived from one batch; the unit of publish, cache key, partition key and rollback |
| **BLOCKER / CAVEAT / WARNING / INFO** | Validation severities. `BLOCKER` fails the batch; `CAVEAT` publishes but disables dependent KPIs; `WARNING` is reported and drillable; `INFO` is recorded for comparison |
| **continuation row** | A PR Release row for release sequence 2+ whose identifying columns are blank because the export merges them with the parent row — 13,338 rows (48%) in the current file |
| **data scope** | The company codes, plants and purchasing organisations a user may see. Enforced in the data layer on every query. |
| **direct PO** | A PO line with no PR reference — 9,094 lines (43.7%) in the current data |
| **drill token** | A signed, session-bound, short-lived reference to the exact predicate behind a displayed figure, used to re-execute it and return the underlying rows |
| **EINDT** | SAP PO item delivery date — the promised date. Equals Document Date on 37.4% of current lines, so vendor-OTD analytics built on it carry a disclosed caveat. |
| **GR/IR** | Goods received, invoice not yet posted — uninvoiced receipt value |
| **indeterminate (WBS)** | An item that cannot be tested against the WBS threshold because its valuation is zero or missing. Never counted as compliant. |
| **period-matched FX** | Converting using the rate for the document's own month, rather than the latest available month |
| **semantic assertion** | A validation rule about the *meaning* of a column, not its presence or type — e.g. that a delivery date must actually differ from a release date |
| **STO** | Stock Transport Order — doc type ending `70`; inter-site movement, not a purchase. `Req. Tracking Number` carries the originating purchase PO. |
| **token price** | A deliberate placeholder price in SAP (e.g. 1 per 10,000) — not real spend; flagged `⚠` |
| **WBS / AR** | Work Breakdown Structure element evidencing an approved Appropriation Request; mandatory above value thresholds |

---

*End of document. See [Annex A — Data Contract](PRD_v2_Annex_A_Data_Contract.md) and [Annex B — Database Schema](PRD_v2_Annex_B_Database_Schema.md).*
