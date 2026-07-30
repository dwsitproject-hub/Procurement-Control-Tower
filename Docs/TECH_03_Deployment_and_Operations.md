# Technical Documentation 3 — Deployment & Operations

**Product:** Procurement Control Tower v2
**Version:** 1.0 · **Date:** 30 July 2026
**Audience:** Platform engineers, SRE, administrators
**Companions:** [TECH 01 — Architecture](TECH_01_Architecture_and_Implementation.md) · [TECH 02 — API Reference](TECH_02_API_Reference.md) · [PRD v2](PRD_v2_Production.md)

---

## Contents

1. [Environments](#1-environments)
2. [Instance provisioning](#2-instance-provisioning)
3. [Instance 3 — Data](#3-instance-3--data)
4. [Instance 2 — Application](#4-instance-2--application)
5. [Instance 1 — Edge](#5-instance-1--edge)
6. [Security hardening checklist](#6-security-hardening-checklist)
7. [Configuration reference](#7-configuration-reference)
8. [DWS Hub registration](#8-dws-hub-registration)
9. [CI/CD](#9-cicd)
10. [Database operations](#10-database-operations)
11. [Observability](#11-observability)
12. [Runbooks](#12-runbooks)
13. [Troubleshooting](#13-troubleshooting)
14. [Backup & disaster recovery](#14-backup--disaster-recovery)
15. [Go-live checklist](#15-go-live-checklist)

---

## 1. Environments

| | Staging | Production |
|---|---|---|
| Hostname | `procurement-stg.energi-up.com` | `procurement.energi-up.com` |
| TLS | Required (internal CA acceptable) | Required (trusted certificate) |
| Hub client id | `procurement-control-tower-stg` | `procurement-control-tower` |
| Redirect URI | `https://procurement-stg.energi-up.com/auth/oidc/callback` | `https://procurement.energi-up.com/auth/oidc/callback` |
| Synology folder | `/SAP_Exports_Staging` | `/SAP_Exports` |
| Notification recipients | Project team only | Live distribution lists |
| Local accounts | Permitted, MFA optional | Break-glass only, MFA mandatory, individually approved and expiring |
| Debug endpoints | Enabled | Removed at build time |
| Retained versions | 4 | 12 |

The two environments never share a database, a Redis instance, a Hub client registration, or a Synology folder. A staging load must never be able to publish into production.

### 1.1 Addressing

| Instance | Staging | Production |
|---|---|---|
| 1 — Edge | `10.20.0.10` | `10.10.0.10` |
| 2 — Application | `10.20.0.20` | `10.10.0.20` |
| 3 — Data | `10.20.0.30` | `10.10.0.30` |
| Synology NAS | `synology.energi-up.local` | same |

Substitute your actual addresses; the examples below use the production set.

---

## 2. Instance provisioning

### 2.1 Base build (all three)

Ubuntu Server 24.04 LTS. Applies to every instance:

```bash
apt-get update && apt-get -y upgrade
apt-get -y install ca-certificates curl gnupg ufw chrony unattended-upgrades

timedatectl set-timezone Asia/Jakarta      # log timestamps match business hours
systemctl enable --now chrony              # aging and cron correctness depend on clock sanity

# Docker Engine from the official repository
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin

useradd --system --create-home --shell /usr/sbin/nologin pct
```

Timezone matters: notification digest times, cron schedules and log correlation are all read by people working in Jakarta.

### 2.2 Firewall

Default deny inbound everywhere. Instances 2 and 3 have **no route from the corporate LAN**.

```bash
# ── Instance 1 — Edge (the only public instance) ──
ufw default deny incoming && ufw default allow outgoing
ufw allow from 10.0.0.0/8 to any port 22 proto tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

```bash
# ── Instance 2 — Application ──
ufw default deny incoming && ufw default allow outgoing
ufw allow from 10.0.0.0/8 to any port 22 proto tcp
ufw allow from 10.10.0.10 to any port 3000 proto tcp     # edge only
ufw allow from 10.10.0.10 to any port 9464 proto tcp     # metrics scrape
ufw --force enable
```

```bash
# ── Instance 3 — Data (default-deny egress too) ──
ufw default deny incoming && ufw default deny outgoing
ufw allow from 10.0.0.0/8 to any port 22 proto tcp
ufw allow from 10.10.0.20 to any port 5432 proto tcp     # application only
ufw allow from 10.10.0.20 to any port 6379 proto tcp
ufw allow out to 10.10.0.40 port 22 proto tcp            # backup target
ufw allow out 53                                          # DNS
ufw allow out 123                                         # NTP
ufw --force enable
```

Verify the matrix after provisioning:

| From | To | Port | Expected |
|---|---|---|---|
| Corporate LAN | 1 | 443 | open |
| Corporate LAN | 2 | 3000 | **refused** |
| Corporate LAN | 3 | 5432 | **refused** |
| 1 | 2 | 3000 | open |
| 2 | 3 | 5432, 6379 | open |
| 2 | Synology | 445 | open |
| 2 | DWS Hub | 443 | open |
| 2 | Mail relay | 587 | open |

---

## 3. Instance 3 — Data

### 3.1 Compose

```yaml
# /opt/pct/docker-compose.yml  (instance 3)
services:
  postgres:
    image: postgres:16.4-bookworm
    restart: unless-stopped
    environment:
      POSTGRES_DB: pct
      POSTGRES_USER: pct_admin
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_admin_pw
      POSTGRES_INITDB_ARGS: "--data-checksums"   # detects silent corruption
    volumes:
      - /data/postgres:/var/lib/postgresql/data
      - /opt/pct/postgres/postgresql.conf:/etc/postgresql/postgresql.conf:ro
      - /data/wal-archive:/wal-archive
    command: ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"]
    ports: ["10.10.0.30:5432:5432"]              # bound to the private NIC only
    secrets: [pg_admin_pw]
    shm_size: 1gb
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pct_admin -d pct"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7.4-alpine
    restart: unless-stopped
    command: >
      redis-server
      --requirepass-file /run/secrets/redis_pw
      --maxmemory 2gb
      --maxmemory-policy noeviction
      --appendonly yes
      --appendfsync everysec
    volumes: ["/data/redis:/data"]
    ports: ["10.10.0.30:6379:6379"]
    secrets: [redis_pw]

secrets:
  pg_admin_pw: { file: /opt/pct/secrets/pg_admin_pw }
  redis_pw:    { file: /opt/pct/secrets/redis_pw }
```

> **`maxmemory-policy noeviction` is deliberate.** Redis holds sessions and BullMQ queues, not just cache. Under `allkeys-lru` a memory spike would silently evict queued ingestion jobs and log every user out. `noeviction` fails loudly instead, which is the correct trade for this workload. Cache entries carry their own TTLs.

### 3.2 PostgreSQL configuration

```ini
# /opt/pct/postgres/postgresql.conf  — 4 vCPU / 16 GB baseline
listen_addresses = '*'
max_connections = 200

shared_buffers = 4GB
effective_cache_size = 12GB
work_mem = 64MB
maintenance_work_mem = 1GB

max_parallel_workers_per_gather = 4
max_parallel_workers = 4
random_page_cost = 1.1                      # SSD
default_statistics_target = 200             # facts carry several correlated predicates

wal_level = replica                         # ready for a read replica without a restart
archive_mode = on
archive_command = 'test ! -f /wal-archive/%f && cp %p /wal-archive/%f'
checkpoint_completion_target = 0.9
max_wal_size = 4GB

# Partitioned fact tables: let the planner prune, and prune at execution too
enable_partition_pruning = on
enable_partitionwise_join = on
enable_partitionwise_aggregate = on

log_min_duration_statement = 500ms
log_checkpoints = on
log_lock_waits = on
log_line_prefix = '%m [%p] %u@%d %a '
log_temp_files = 0

ssl = on
ssl_cert_file = '/etc/postgresql/server.crt'
ssl_key_file  = '/etc/postgresql/server.key'
```

`pg_hba.conf` — TLS-only, no `trust`, no `md5`:

```
# TYPE  DATABASE  USER          ADDRESS        METHOD
local   all       pct_admin                    scram-sha-256
hostssl pct       pct_app       10.10.0.20/32  scram-sha-256
hostssl pct       pct_migrate   10.10.0.20/32  scram-sha-256
hostssl pct       pct_readonly  10.10.0.20/32  scram-sha-256
# no other host entries
```

### 3.3 Roles

```sql
CREATE DATABASE pct WITH ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8';
\c pct

CREATE ROLE pct_migrate  LOGIN PASSWORD :'migrate_pw';   -- DDL, used only by CI
CREATE ROLE pct_app      LOGIN PASSWORD :'app_pw';       -- DML, used by api + worker
CREATE ROLE pct_readonly LOGIN PASSWORD :'ro_pw';        -- SELECT, for BI and support

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON DATABASE pct FROM PUBLIC;
```

`pct_app` has no DDL rights, so an application defect cannot alter the schema. The `audit` schema grants `SELECT, INSERT` only — never `UPDATE` or `DELETE` — so append-only is enforced by the database, not by convention (Annex B §B.2).

---

## 4. Instance 2 — Application

### 4.1 Synology mount

A dedicated DSM service account with **read-only** permission on the export folder and no access to any other share.

```bash
install -d -m 0700 /etc/pct
cat > /etc/pct/synology.cred <<'EOF'
username=pct_reader
password=<from vault>
domain=WORKGROUP
EOF
chmod 0600 /etc/pct/synology.cred
chown root:root /etc/pct/synology.cred

install -d -o pct -g pct -m 0750 /mnt/sap_exports
apt-get -y install cifs-utils
```

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
Options=credentials=/etc/pct/synology.cred,ro,vers=3.1.1,uid=pct,gid=pct,file_mode=0440,dir_mode=0550,noserverino,soft,_netdev,actimeo=30

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/mnt-sap_exports.automount
[Unit]
Description=Automount Synology SAP export share

[Automount]
Where=/mnt/sap_exports
TimeoutIdleSec=600

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now mnt-sap_exports.automount
ls -l /mnt/sap_exports          # must list the six exports
touch /mnt/sap_exports/x 2>&1   # MUST fail: read-only
```

Option rationale:

| Option | Why |
|---|---|
| `ro` | An application defect can never modify or delete a source file. This is why `SYNOLOGY_ARCHIVE_MODE=none` is the only supported mode |
| `vers=3.1.1` | SMB 3.1.1 — encryption and integrity. Never `vers=1.0` |
| `soft` | A NAS outage returns an error instead of hanging backend threads forever |
| `noserverino` | Avoids inode collisions some DSM versions produce |
| `actimeo=30` | Bounds attribute caching so the settle check sees real sizes |
| `uid=pct,gid=pct` | Files readable by the application user only |

If infrastructure policy forbids CIFS, the alternative is Synology's FileStation REST API over HTTPS; only the `FileSource` adapter changes (TECH 01 §6.5.1).

### 4.2 Directories

```bash
install -d -o pct -g pct -m 0700 /var/lib/pct/spool     # upload spool
install -d -o pct -g pct -m 0750 /var/log/pct
```

The spool is on its own volume with a quota, so an upload flood cannot fill the root filesystem.

### 4.3 Compose

```yaml
# /opt/pct/docker-compose.yml  (instance 2)
x-app-base: &app-base
  image: registry.energi-up.com/pct/backend:${APP_VERSION}
  restart: unless-stopped
  env_file: [/opt/pct/env/backend.env]
  user: "1001:1001"                 # non-root
  read_only: true                   # immutable root filesystem
  cap_drop: ["ALL"]
  security_opt: ["no-new-privileges:true"]
  tmpfs: ["/tmp:size=512m"]
  volumes:
    - /mnt/sap_exports:/mnt/sap_exports:ro
    - /var/lib/pct/spool:/var/lib/pct/spool
  secrets: [session_secret, db_password, redis_password, smtp_password, synology_note]
  logging:
    driver: json-file
    options: { max-size: "50m", max-file: "5" }

services:
  api:
    <<: *app-base
    command: ["node", "dist/main.js"]
    ports:
      - "10.10.0.20:3000:3000"
      - "10.10.0.20:9464:9464"      # Prometheus metrics
    healthcheck:
      test: ["CMD", "node", "dist/healthcheck.js"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 30s
    deploy:
      resources: { limits: { cpus: "2.0", memory: 3G } }

  worker:
    <<: *app-base
    command: ["node", "dist/worker.js"]
    # Ingestion peaks are memory-bounded by streaming, but a parse worker is
    # capped so one bad workbook cannot take the instance down.
    deploy:
      resources: { limits: { cpus: "2.0", memory: 4G } }

  clamav:
    image: clamav/clamav:1.4
    restart: unless-stopped
    volumes: ["/data/clamav:/var/lib/clamav"]
    ports: ["127.0.0.1:3310:3310"]
    deploy:
      resources: { limits: { memory: 2G } }

secrets:
  session_secret:  { file: /opt/pct/secrets/session_secret }
  db_password:     { file: /opt/pct/secrets/db_password }
  redis_password:  { file: /opt/pct/secrets/redis_password }
  smtp_password:   { file: /opt/pct/secrets/smtp_password }
  synology_note:   { file: /opt/pct/secrets/synology_note }
```

Secrets are root-owned `0400` files, delivered by the deploy pipeline from the corporate vault, never in the repository, never in `docker-compose.yml`, never in the image.

### 4.4 Backend Dockerfile

```dockerfile
# Backend/Dockerfile
FROM node:22.11-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/rules/package.json     packages/rules/
COPY Backend/package.json            Backend/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/ packages/
COPY Backend/  Backend/
RUN pnpm --filter rules build \
 && pnpm --filter contracts build \
 && pnpm --filter backend build \
 && pnpm --filter backend deploy --prod /out

FROM node:22.11-bookworm-slim AS runtime
RUN groupadd -g 1001 pct && useradd -u 1001 -g 1001 -m pct
WORKDIR /app
COPY --from=build --chown=1001:1001 /out ./
ENV NODE_ENV=production NODE_OPTIONS="--max-old-space-size=3072"
USER 1001
EXPOSE 3000 9464
CMD ["node", "dist/main.js"]
```

Base images are pinned by digest in CI. `--max-old-space-size` is set below the container memory limit so Node GCs rather than being OOM-killed mid-transform.

---

## 5. Instance 1 — Edge

### 5.1 nginx

```nginx
# /etc/nginx/conf.d/pct.conf

upstream pct_api {
    server 10.10.0.20:3000 max_fails=3 fail_timeout=15s;
    # add further backend processes here for horizontal scale
    keepalive 32;
}

limit_req_zone $binary_remote_addr zone=pct_login:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=pct_api:10m   rate=300r/m;

server {
    listen 80;
    listen [::]:80;
    server_name procurement.energi-up.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name procurement.energi-up.com;

    ssl_certificate     /etc/ssl/pct/fullchain.pem;
    ssl_certificate_key /etc/ssl/pct/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_tickets off;
    ssl_stapling on;
    ssl_stapling_verify on;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options    "nosniff" always;
    add_header X-Frame-Options           "DENY" always;
    add_header Referrer-Policy           "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy        "camera=(), microphone=(), geolocation=(), payment=()" always;
    # No CDN anywhere, so no 'unsafe-inline' is needed. See §6.4.
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'" always;

    server_tokens off;
    client_max_body_size 210m;          # 6 files x 60 MB cap plus multipart overhead
    client_body_timeout 300s;

    gzip on;
    gzip_types application/json application/javascript text/css image/svg+xml;
    gzip_min_length 1024;

    # ── API and auth ──
    location /api/ {
        limit_req zone=pct_api burst=100 nodelay;
        proxy_pass http://pct_api;
        proxy_http_version 1.1;
        proxy_set_header Connection        "";
        proxy_set_header Host              $host;          # REQUIRED — see §13.1
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id      $request_id;
        proxy_read_timeout 300s;
        proxy_buffering off;                                # progress endpoints stream
    }

    location = /auth/local/login {
        limit_req zone=pct_login burst=5 nodelay;
        proxy_pass http://pct_api;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /auth/ {
        proxy_pass http://pct_api;
        proxy_set_header Host              $host;          # REQUIRED
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ── Static SPA ──
    location /assets/ {
        root /var/www/pct;
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    location / {
        root /var/www/pct;
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";               # index.html must never be cached
    }

    access_log /var/log/nginx/pct-access.log combined;
    error_log  /var/log/nginx/pct-error.log warn;
}
```

> **`proxy_set_header Host $host` on every proxied location.** Without it the backend sets the session cookie for an internal IP, the browser never sends it back, and login appears to succeed in the server log while the user is bounced to the login screen forever. This is the single most common failure in this deployment.

### 5.2 Frontend deployment

The frontend is a static bundle, deployed atomically by symlink swap so there is no window where `index.html` references assets that are not yet present.

```bash
#!/usr/bin/env bash
# /opt/pct/deploy-frontend.sh
set -euo pipefail
VERSION="$1"
RELEASE="/var/www/pct-releases/${VERSION}"

install -d "$RELEASE"
tar -xzf "/opt/pct/artifacts/frontend-${VERSION}.tar.gz" -C "$RELEASE"
test -f "$RELEASE/index.html"

# No external origins may appear in the bundle — enforced, not assumed.
if grep -rEl 'https?://(cdn|unpkg|jsdelivr|fonts\.googleapis)' "$RELEASE" >/dev/null 2>&1; then
  echo "FATAL: external origin reference found in bundle" >&2
  exit 1
fi

ln -sfn "$RELEASE" /var/www/pct.new && mv -Tf /var/www/pct.new /var/www/pct
nginx -t && systemctl reload nginx

ls -1dt /var/www/pct-releases/* | tail -n +6 | xargs -r rm -rf   # keep 5
```

---

## 6. Security hardening checklist

### 6.1 Host

- [ ] SSH: key-only, `PermitRootLogin no`, `PasswordAuthentication no`, jump-host only
- [ ] `unattended-upgrades` enabled for security updates
- [ ] `ufw` matrix verified from outside (§2.2)
- [ ] Instances 2 and 3 unreachable from the corporate LAN
- [ ] Instance 3 default-deny **egress**
- [ ] Timezone `Asia/Jakarta`, NTP synchronised
- [ ] Docker daemon not exposed on TCP
- [ ] `/var/lib/pct/spool` on its own quota-limited volume

### 6.2 Containers

- [ ] Non-root user (`1001`)
- [ ] `read_only: true` root filesystem, `tmpfs` for `/tmp`
- [ ] `cap_drop: ALL`, `no-new-privileges`
- [ ] Base images pinned by digest
- [ ] Image scan in CI; build fails on high or critical
- [ ] Memory and CPU limits set on every service

### 6.3 Secrets

- [ ] `SESSION_SECRET` generated with `openssl rand -base64 48`, unique per environment
- [ ] All secrets are root-owned `0400` files from the vault
- [ ] No secret in the repository, image, compose file, or environment listing
- [ ] `git-secrets` / Gitleaks in CI
- [ ] Rotation schedule documented: DB and SMTP passwords annually, `SESSION_SECRET` on suspicion (invalidates all sessions by design)

### 6.4 Application

- [ ] `SESSION_COOKIE_SECURE=true`, `SameSite=Lax`, `HttpOnly`, host-only
- [ ] `LOCAL_AUTH_REQUIRE_MFA=true`
- [ ] Boot-time config validation confirmed by deliberately starting with a bad value
- [ ] Strict CSP active with **no** `unsafe-inline` — verified in browser devtools with zero violations
- [ ] No external origin in the built bundle (enforced by the deploy script)
- [ ] CORS not enabled
- [ ] Upload gates verified individually: oversized, wrong extension, renamed non-XLSX, EICAR test file, zip bomb
- [ ] Export formula-injection neutralisation verified with a cell beginning `=`
- [ ] Rate limits verified
- [ ] Every route carries `@Public` or `@RequireRole` (lint gate green)
- [ ] Scope-leakage test suite green
- [ ] Audit hash chain verifies

### 6.5 Data

- [ ] PostgreSQL TLS-only, `scram-sha-256`, no `trust`
- [ ] `pct_app` has no DDL rights
- [ ] `audit` schema has no `UPDATE`/`DELETE` grant
- [ ] Data checksums enabled
- [ ] Redis password set, bound to the private NIC, `noeviction`
- [ ] Encryption at rest on the data volume
- [ ] Backup restore tested

### 6.6 Pre-go-live

- [ ] Authenticated penetration test covering both SSO flows, uploads, scope enforcement, drill-token replay
- [ ] All high and critical findings closed
- [ ] Patch SLA agreed: critical 7 days, high 30 days

---

## 7. Configuration reference

`/opt/pct/env/backend.env`. Every variable is validated at boot; the process exits on anything invalid or missing.

### 7.1 Runtime

| Variable | Example | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enables production-only assertions |
| `APP_BASE_URL` | `https://procurement.energi-up.com` | **Exactly one URL.** A comma causes a port-parse crash |
| `PORT` | `3000` | |
| `TRUST_PROXY` | `1` | Number of proxy hops; makes `X-Forwarded-For` trustworthy for rate limits and audit |
| `LOG_LEVEL` | `info` | |

### 7.2 DWS Hub OIDC

| Variable | Example | Notes |
|---|---|---|
| `OIDC_DISCOVERY_URL` | `https://hub.energi-up.com/api/sso/.well-known/openid-configuration` | Must be reachable **from instance 2** |
| `OIDC_CLIENT_ID` | `procurement-control-tower` | Not secret; appears in browser URLs |
| `OIDC_REDIRECT_URI` | `https://procurement.energi-up.com/auth/oidc/callback` | **Exactly one**, byte-identical to a registered value |
| `OIDC_SCOPES` | `openid email profile` | |

There is **no `OIDC_CLIENT_SECRET`.** This is a public client using PKCE. Do not add one.

Two failure modes are rejected at boot: a comma in `OIDC_REDIRECT_URI` (produces `invalid_grant`), and an unreplaced `<placeholder>` (produces a DNS failure on `%3chub-host%3e`).

### 7.3 Session

| Variable | Production | Notes |
|---|---|---|
| `SESSION_SECRET` | `openssl rand -base64 48` | This app's own key, unrelated to the Hub. Rotating it logs everyone out |
| `SESSION_COOKIE_NAME` | `pct_sid` | |
| `SESSION_COOKIE_SAMESITE` | `Lax` | Viable because of the single-origin layout |
| `SESSION_COOKIE_SECURE` | `true` | Boot rejects `false` in production |
| `SESSION_IDLE_TIMEOUT_MIN` | `60` | |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | `12` | |

### 7.4 Local accounts

| Variable | Production | Notes |
|---|---|---|
| `LOCAL_AUTH_ENABLED` | `true` | Break-glass only; set `false` if not needed |
| `LOCAL_AUTH_REQUIRE_MFA` | `true` | Boot rejects `false` in production when local auth is on |
| `LOCAL_AUTH_MAX_ATTEMPTS` | `5` | |
| `LOCAL_AUTH_LOCKOUT_MIN` | `15` | |

### 7.5 Data

| Variable | Example |
|---|---|
| `DATABASE_URL` | `postgres://pct_app:${DB_PASSWORD}@10.10.0.30:5432/pct?sslmode=verify-full` |
| `REDIS_URL` | `redis://:${REDIS_PASSWORD}@10.10.0.30:6379` |
| `DATASET_VERSIONS_RETAINED` | `12` |
| `DB_POOL_MAX` | `20` |

Use `sslmode=verify-full`, not `require` — `require` encrypts without authenticating the server.

### 7.6 Ingestion

| Variable | Example | Notes |
|---|---|---|
| `SYNOLOGY_MOUNT_PATH` | `/mnt/sap_exports` | |
| `SYNOLOGY_POLL_CRON` | `0 */30 * * * *` | Six fields (seconds first). Every 30 minutes |
| `SYNOLOGY_ARCHIVE_MODE` | `none` | Only supported value; the mount is read-only |
| `UPLOAD_SPOOL_PATH` | `/var/lib/pct/spool` | |
| `UPLOAD_MAX_FILE_MB` | `60` | Largest current template is ~6 MB |
| `UPLOAD_MAX_BATCH_MB` | `200` | |
| `INGEST_FILE_SETTLE_SECONDS` | `30` | Raise if the SAP export job writes slowly |
| `INGEST_STALL_CYCLES` | `4` | Incomplete bundles before escalating to `ingest.stalled` |
| `CLAMAV_HOST` / `CLAMAV_PORT` | `127.0.0.1` / `3310` | |

### 7.7 Notifications

| Variable | Example |
|---|---|
| `SMTP_HOST` | `mail.energi-up.com` |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `starttls` |
| `SMTP_USER` | `pct-notify@energi-up.com` |
| `SMTP_FROM` | `Procurement Control Tower <pct-notify@energi-up.com>` |
| `NOTIFY_RATE_LIMIT_PER_HOUR` | `20` |

### 7.8 Business rules

Bootstrap defaults only. Once seeded, `app.rule_config` is authoritative and administrators edit values through the console (TECH 02 §11).

| Variable | Default | Decision |
|---|---|---|
| `RULE_STO_DOCTYPE_SUFFIX` | `70` | |
| `RULE_WBS_MATERIAL_THRESHOLD_IDR` | `30000000` | D1 — admin-editable |
| `RULE_WBS_SERVICE_THRESHOLD_IDR` | `150000000` | D1 — admin-editable |
| `RULE_WBS_BASIS` | `per_item` | D1 |
| `RULE_NO_RELEASE_STRATEGY_POLICY` | `flag_only` | D2 |
| `RULE_FX_POLICY` | `period_matched` | D3 |
| `RULE_AGING_THRESHOLD_DAYS` | `60` | |
| `RULE_ASOF_SOURCE` | `data_max` | |
| `RULE_FRESHNESS_AGEING_DAYS` | `3` | |
| `RULE_FRESHNESS_STALE_DAYS` | `7` | |

---

## 8. DWS Hub registration

Do this **before** writing or deploying any auth configuration. The URL layout decision drives everything else.

### 8.1 Confirm the Hub is reachable

From instance 2, not from a laptop:

```bash
curl -s https://hub.energi-up.com/api/sso/.well-known/openid-configuration | jq .
curl -s https://hub.energi-up.com/api/sso/jwks | jq '.keys | length'
```

Expected discovery values:

```json
{
  "issuer": "https://hub.energi-up.com",
  "authorization_endpoint": "https://hub.energi-up.com/api/sso/authorize",
  "token_endpoint": "https://hub.energi-up.com/api/sso/token",
  "jwks_uri": "https://hub.energi-up.com/api/sso/jwks",
  "response_types_supported": ["code"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["openid", "profile", "email"],
  "token_endpoint_auth_methods_supported": ["none"]
}
```

`"token_endpoint_auth_methods_supported": ["none"]` confirms a public client — there is no secret to request.

### 8.2 Register

In the Hub: **Admin → Applications**. Agree three things:

| Item | Value | Secret? |
|---|---|---|
| Client id | `procurement-control-tower` | No |
| Client type | Public / PKCE | — |
| Redirect URI | `https://procurement.energi-up.com/auth/oidc/callback` | No |

Redirect-URI rules learned the hard way:

- Must match the application's configured value **byte for byte** — scheme, host, port, path, no trailing-slash difference.
- Register the URL that goes **through the reverse proxy**, never an internal container port. A static-frontend port that does not proxy `/auth/*` will 404.
- Several URIs may be registered on the Hub, but the application must send **exactly one**.
- Register staging and production separately, under separate client ids.

### 8.3 Verify

```bash
# 1. The login route builds a proper authorize redirect
curl -si https://procurement.energi-up.com/auth/oidc/login | grep -iE '^(HTTP|location)'
```

In the `location` header confirm: `client_id`, `response_type=code`, `code_challenge_method=S256`, `state`, `nonce`, and a `redirect_uri` matching the registered value exactly.

```bash
# 2. The backend can reach the Hub (server-to-server path)
docker compose exec api node -e "fetch(process.env.OIDC_DISCOVERY_URL).then(r=>console.log(r.status))"
```

Then, in a real browser:

1. **SP-initiated** — open the app, click *Sign in with DWS Hub*, authenticate, land back logged in.
2. **IdP-initiated** — from the Hub dashboard, click the app tile. **Test this explicitly**; it exercises a completely different code branch.
3. DevTools → Application → Cookies: confirm `pct_sid` exists **for the app hostname**. If it is missing or set for an IP, see §13.1.

---

## 9. CI/CD

### 9.1 Pipeline

```
push / PR
  ├─ lint + typecheck
  ├─ unit tests            (rules ≥95% branch, overall ≥80%)
  ├─ contract tests
  ├─ build backend + frontend
  ├─ integration tests     (real PostgreSQL in Docker)
  ├─ GOLDEN NUMBER TESTS   ← blocks on any unexplained KPI drift
  ├─ dependency audit, SAST (CodeQL), secret scan (Gitleaks), image scan (Trivy)
  └─ container build + sign

main
  ├─ deploy STAGING (migrate → blue-green api/worker → frontend swap)
  ├─ smoke tests
  ├─ E2E (Playwright, BOTH SSO flows) + axe-core
  └─ ⏸ MANUAL APPROVAL
        └─ deploy PRODUCTION (migrate → blue-green → frontend swap)
              └─ smoke tests → audit entry → deploy notification
```

### 9.2 Deploy script

```bash
#!/usr/bin/env bash
# /opt/pct/deploy.sh — run on instance 2
set -euo pipefail
VERSION="$1"
cd /opt/pct

echo "==> pulling ${VERSION}"
APP_VERSION="$VERSION" docker compose pull api worker

echo "==> migrating (pct_migrate role; forward-only)"
docker run --rm --env-file /opt/pct/env/migrate.env \
  "registry.energi-up.com/pct/backend:${VERSION}" node dist/migrate.js

echo "==> restarting worker (drains in-flight jobs first)"
APP_VERSION="$VERSION" docker compose up -d --no-deps worker

echo "==> restarting api"
APP_VERSION="$VERSION" docker compose up -d --no-deps --wait api

echo "==> readiness"
for i in $(seq 1 30); do
  if curl -fsS http://10.10.0.20:3000/api/v1/ready | grep -q '"status":"ok"'; then
    echo "ready"; exit 0
  fi
  sleep 2
done
echo "FAILED readiness — rolling back" >&2
APP_VERSION="$PREVIOUS_VERSION" docker compose up -d --no-deps --wait api worker
exit 1
```

**Migration rules.** Forward-only. Additive first: add a nullable column, deploy code that writes it, backfill, then make it `NOT NULL` in a later release. Never drop a column in the same release that stops using it — that removes the rollback path.

**Worker restarts before the API** so a new job shape is never enqueued by new API code into an old worker.

### 9.3 Version visibility

`GET /api/v1/health` returns `version`, `gitSha` and `builtAt`, and the UI footer shows them. "It is still running old code" is always answerable.

---

## 10. Database operations

### 10.1 Migrations

```bash
pnpm --filter backend db:generate     # generate from schema diff
pnpm --filter backend db:migrate      # apply (CI does this in deploy)
pnpm --filter backend db:status       # what is applied
```

Every migration is reviewed in a PR and states its rollback path in a comment.

### 10.2 Partitions

Fact partitions are created by the pipeline at batch start and dropped by retention (Annex B §B.10.6, §B.13). Manual inspection:

```sql
-- Partitions per fact table
SELECT c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'core' AND c.relname LIKE 'fact_po_line_v%'
 ORDER BY c.relname DESC;

-- Retained versions and the active pointer
SELECT v.id, v.as_of_date, v.status, v.published_at,
       (v.id = p.current_version_id) AS is_current
  FROM core.dataset_version v CROSS JOIN core.dataset_pointer p
 ORDER BY v.id DESC LIMIT 20;
```

Orphan partitions (created by a failed batch that never published) are cleaned by the retention job. Force it:

```sql
SELECT core.prune_versions(12);
```

### 10.3 Post-load maintenance

The transform stage runs this before publish; the planner needs statistics on a brand-new partition or the first queries against it are catastrophically slow:

```sql
ANALYZE core.fact_pr_item_v41;
ANALYZE core.fact_po_line_v41;
ANALYZE core.fact_gr_posting_v41;
ANALYZE core.fact_pr_release_v41;
ANALYZE core.fact_po_release_v41;
ANALYZE core.bridge_pr_po_v41;
```

Facts are insert-only per partition, so autovacuum has little to do. Monitor bloat monthly on `app.*` and `audit.audit_log`, which do see updates.

### 10.4 Health queries

```sql
-- Slowest statements
SELECT calls, round(mean_exec_time::numeric,1) AS mean_ms,
       round(total_exec_time::numeric/1000,1) AS total_s, left(query, 120) AS q
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;

-- Connection saturation
SELECT state, count(*) FROM pg_stat_activity WHERE datname='pct' GROUP BY state;

-- Unused indexes (candidates for removal after a full business cycle)
SELECT relname, indexrelname, idx_scan
  FROM pg_stat_user_indexes WHERE idx_scan = 0 AND schemaname IN ('core','mart')
 ORDER BY relname;
```

---

## 11. Observability

### 11.1 Log fields

Every log line is JSON and carries, where applicable: `requestId`, `userId`, `sessionId`, `batchId`, `datasetVersionId`, `queue`, `jobId`, `ruleId`, `durationMs`.

Redacted always: cookies, authorization headers, `code`, `code_verifier`, `id_token`, `access_token`, passwords, hashes, TOTP secrets, SMTP passwords. Row-level business data is never logged.

### 11.2 Key metrics

| Metric | Type | Alert when |
|---|---|---|
| `http_request_duration_seconds` | histogram | p95 > 500 ms for 10 min (KPI routes) |
| `http_requests_total{status=~"5.."}` | counter | > 1% of requests over 5 min |
| `ingest_batch_total{outcome="failed"}` | counter | any increase |
| `ingest_stage_duration_seconds` | histogram | full pipeline > 8 min |
| `dataset_as_of_lag_days` | gauge | > `freshness.stale_days` |
| `validation_findings_total{severity="BLOCKER"}` | gauge | > 0 |
| `nas_mount_available` | gauge | = 0 |
| `notification_delivery_total{status="failed"}` | counter | > 3 in 1 h |
| `queue_depth` | gauge | > 50 sustained 15 min |
| `cache_hit_ratio` | gauge | < 0.6 for 30 min |
| `auth_login_total{outcome="failure"}` | counter | > 20 in 5 min from one IP |
| `pg_database_size_bytes` | gauge | > 80% of volume |
| `ssl_cert_expiry_days` | gauge | < 30 |

### 11.3 Dashboards

1. **Service health** — request rate, latency percentiles, error rate, readiness.
2. **Ingestion** — batch outcomes, per-stage duration, findings by severity, bundle-hash no-op rate.
3. **Data freshness** — as-of lag, publish timeline, active caveats.
4. **Auth** — logins by method and flow, failures, lockouts, active sessions.
5. **Notifications** — sends by event, delivery latency, failures.

### 11.4 Alert routing

`error`-severity alerts go to the on-call channel and, for administrators, the alerting channel — **not** email, because email is precisely what may be broken.

---

## 12. Runbooks

### 12.1 Ingestion failed

**Symptom:** `ingest.failed` received, or a batch shows `FAILED`.

1. `GET /api/v1/ingest/batches/{id}` — read `failureReason` and the findings.
2. If a `BLOCKER` validation rule fired:
   - `V-S02` (required column unresolvable) → template drift. Compare the file's headers against the active contract in Admin → Templates. Either add a steward mapping, or ask the SAP owner to restore the column. Nothing was published; the prior version is still serving.
   - `V-R04` (PR Release continuation-row order) → the export was re-sorted. **Do not bypass this check.** Ask for the export in its original order; forward-filling out-of-order rows would silently misattribute every level-2 approval.
   - `V-R07` (unregistered GR movement type) → a new movement type appeared. Add it to `core.dim_movement_type` with its class and sign factor **after confirming the semantics with the SAP team**. Never guess a sign.
   - `V-S06`/`V-S07` (parse failure) → check for a corrupt or truncated export.
3. Fix the cause, then re-run: `POST /api/v1/ingest/sync`, or re-upload manually.
4. **Nothing is published on failure.** Users continue on the last good version, correctly labelled.

### 12.2 Synology share unreachable

**Symptom:** `ingest.source_unavailable`; `/api/v1/ready` shows `nas_mount: fail`.

```bash
systemctl status mnt-sap_exports.mount
ls -l /mnt/sap_exports
journalctl -u mnt-sap_exports.mount -n 50
smbclient -L //synology.energi-up.local -A /etc/pct/synology.cred
```

Common causes: DSM service-account password rotated or expired; share permissions changed; NAS rebooted; SMB version disabled on DSM; network path blocked.

```bash
systemctl restart mnt-sap_exports.mount
```

The dashboard keeps serving the last published version throughout. This degrades ingestion, not availability — which is why `/ready` reports `degraded` (200) rather than `fail` (503) for a NAS outage alone.

### 12.3 DWS Hub unavailable

**Symptom:** users cannot log in; `/api/v1/ready` shows `oidc_discovery: fail`.

1. Confirm from instance 2: `curl -s -o /dev/null -w '%{http_code}\n' "$OIDC_DISCOVERY_URL"`.
2. Existing sessions are unaffected — they live in Redis and do not touch the Hub.
3. Administrators use the local break-glass account (MFA required). Its use is audited and alerted.
4. Notify users that login is unavailable; the dashboard itself is up.
5. No code change or redeploy is needed when the Hub returns.

### 12.4 Roll back a bad dataset

**Symptom:** published data is wrong (e.g. a truncated feed passed validation).

1. `GET /api/v1/dataset/versions` — identify the last good version.
2. `POST /api/v1/dataset/{id}/rollback` with a `reason` (required and audited).
3. Verify `GET /api/v1/dataset/current` shows the expected version and as-of date.
4. `data.rolled_back` notifies administrators and subscribers.
5. Investigate why validation did not catch it, and **add a check**. A rollback without a new check means the same load will pass again tomorrow.

Target: ≤ 2 minutes. It is one transaction against one pointer row.

### 12.5 SMTP failing

**Symptom:** `system.smtp_failure` in the alerting channel; failed deliveries in the log.

1. `GET /api/v1/admin/notifications/deliveries?status=failed` — read `smtpResponse`.
2. Test the relay from instance 2:
   ```bash
   docker compose exec api node dist/tools/smtp-test.js recipient@energi-up.com
   ```
3. Common causes: credential rotation, relay IP allowlist, TLS negotiation change, recipient mailbox full.
4. Fix, then re-queue: `POST /api/v1/admin/notifications/retry-failed`.
5. **Data publication is never affected.** Notifications are a side effect.

### 12.6 Slow dashboard

1. Check `cache_hit_ratio`. A low ratio right after a publish is normal — every key changes at once. Sustained low means filter combinations are too fragmented, or the mart is missing a slice.
2. Check `pg_stat_statements` for the slowest query.
3. Confirm partition pruning is happening:
   ```sql
   EXPLAIN (ANALYZE, BUFFERS) SELECT … FROM core.v_po_line WHERE …;
   ```
   The plan must touch **one** partition. If it scans all of them, the version predicate has been lost — that is a bug, not a tuning problem.
4. Check that `ANALYZE` ran on the current partitions (§10.3).
5. If aggregation is happening at request time, the mart is missing that slice. Add it to the mart build rather than optimising the ad-hoc query.

### 12.7 Suspected data-scope leak

Treat as a security incident.

1. Capture the reporting user, the endpoint, the request id, and a screenshot.
2. `GET /api/v1/audit?actorUserId=…` around the timestamp.
3. Confirm the user's scope: `GET /api/v1/admin/users/{id}`.
4. Reproduce in staging with the same scope.
5. If confirmed: revoke the affected sessions, restrict the endpoint, patch, and add a case to the scope-leakage suite before shipping the fix.

### 12.8 Certificate renewal

```bash
# Replace fullchain.pem and privkey.pem in /etc/ssl/pct, then:
nginx -t && systemctl reload nginx
echo | openssl s_client -connect procurement.energi-up.com:443 2>/dev/null \
  | openssl x509 -noout -dates
```

Alert fires at 30 days remaining. Renewal needs no application restart.

### 12.9 Adding a user

1. The user logs in via SSO once. This creates their record with role `viewer` and **empty scope** — they see the shell and no data.
2. Admin → Users: assign the role and the data scope.
3. The user reloads. Scope cache expires within 60 seconds.

Never grant `*` scope as a convenience. It requires a justification and is audited.

---

## 13. Troubleshooting

### 13.1 Authentication

| Symptom | Cause | Fix |
|---|---|---|
| Login succeeds in the server log, browser bounces back to login | Session cookie dropped | Check the browser actually stored `pct_sid`. `Secure=true` over plain HTTP, or a split origin, both cause this |
| Cookie set for an internal IP, not the hostname | Reverse proxy not passing the original host | Add `proxy_set_header Host $host;` to **every** proxied location |
| `state not equal in request and response` | IdP-initiated flow reached the SP-initiated branch | The callback must branch on the presence of `code_verifier` in the query (TECH 01 §6.2.4) |
| `{"error":"unsupported_grant_type"}` | Token request sent form-encoded | Send a **JSON** body |
| `{"error":"invalid_request"}` | `redirect_uri` omitted from the token request | Include it |
| `{"error":"invalid_grant"}` | `redirect_uri` mismatch (often comma-joined), or the code was reused or expired | Send exactly one byte-identical URI; always start from a fresh click |
| `Failed to resolve '%3chub-host%3e'` | Unreplaced `<placeholder>` in `OIDC_DISCOVERY_URL` | Boot validation rejects this — check the env file |
| Connection timeout to the Hub | The **backend** cannot reach the Hub (only the browser can) | Open the network path and DNS from instance 2 |
| Port-parse crash on boot | `APP_BASE_URL` has two comma-joined URLs | One value only |
| `/auth/oidc/login` returns 404 | `OIDC_*` incomplete | Set all four variables |
| Signature verification fails after a Hub key rotation | JWKS cache stale | `createRemoteJWKSet` refetches on unknown `kid`; if not, restart the API and check the `jwks_uri` |
| nginx logs `499` on the callback with no app log line | Backend hung (usually a stalled database) | Check DB health; restart the API |

### 13.2 Ingestion

| Symptom | Cause | Fix |
|---|---|---|
| Poll finds nothing, files are present | Settle check skipping them | Confirm `mtime` older than `INGEST_FILE_SETTLE_SECONDS` and size stable across two polls |
| Poll reports `noop_unchanged` after a new export | Identical content — the bundle hash matches | Confirm SAP actually wrote new data; identical exports are correctly a no-op |
| A file classifies as `unrecognised` | Header signature did not match | Compare normalised headers against the contract; add an alias or a steward mapping. Never rename the file to "fix" it — filename plays no role |
| Batch stuck in `PARSING` | Parse worker OOM or timeout | Check worker logs and memory limit; confirm the workbook is not pathological |
| Upload rejected as `upload-not-xlsx` | Magic-byte check failed | The file is renamed `.xls`, CSV, or corrupt. Re-export as real XLSX |
| `V-S05` row-count warning | Row count moved more than ±60% | Usually a legitimately different date range; confirm the selection criteria |
| Two batches queued, neither progressing | Transform mutex held by a stuck job | Check BullMQ `ingest` queue; a stalled job releases after its lock TTL |

### 13.3 Numbers look wrong

Work down this list before assuming a code bug:

1. **Which version?** The freshness banner names the as-of date and load time. Two people comparing figures may be on different versions.
2. **Which scope?** `GET /api/v1/me` shows it. A plant-scoped user sees different totals — correctly.
3. **Which filters?** `appliedFilters` on the response is authoritative, including `excludeSto`.
4. **Which rule snapshot?** `ruleSnapshot` on `dataset/current`. A threshold changed since a figure was quoted does not change that figure.
5. **Any caveats?** An active `CAVEAT` disables dependent KPIs; those render `—`.
6. **Aging is from the as-of date, not today.** A figure that "should have moved" will not move until new data lands. This is intentional.
7. **STO exclusion.** Price, PO-count and vendor-spend analytics exclude the 4,453 `EU70` lines. Delivery analytics include them.
8. **Release-exempt lines.** 241 lines / IDR 1.51bn carry `⚑` and flow like approved POs in commitment figures, and are excluded from the pending-approval queue.
9. Only now, check the drill. Drill count must equal the aggregate count — if it does not, that is a genuine bug; capture the request id and the drill token.

### 13.4 Frontend

| Symptom | Cause | Fix |
|---|---|---|
| UI stuck on "Loading…" | API base URL wrong or backend unreachable | Single origin means the client uses relative paths; check the nginx proxy and `/api/v1/health` |
| Charts blank, console CSP errors | An external origin crept into the bundle | The deploy script blocks this; check for a newly added dependency loading a remote asset |
| Stale UI after deploy | `index.html` cached | `index.html` must be `no-cache`; only `/assets/` is immutable |
| Drill modal shows "expired" quickly | Drill tokens live 15 minutes | Re-fetch the aggregate; do not extend the lifetime |

---

## 14. Backup & disaster recovery

### 14.1 Targets

| Asset | Method | RPO | RTO |
|---|---|---|---|
| PostgreSQL | Nightly base backup + continuous WAL archiving to separate storage | 15 min | 2 h |
| Redis | Sessions and queues are rebuildable | n/a | n/a |
| Config & secrets | Version-controlled config; secrets in the corporate vault | n/a | 1 h |
| Container images | Registry with retained tagged builds | n/a | 30 min |
| Source exports | Remain on the Synology NAS under its own backup regime | n/a | n/a |

This application never becomes the system of record for source files. The NAS is.

### 14.2 Backup

```bash
#!/usr/bin/env bash
# /opt/pct/backup.sh — nightly on instance 3
set -euo pipefail
STAMP=$(date +%Y%m%d-%H%M)
DEST="/backup/pct/${STAMP}"
install -d "$DEST"

docker compose exec -T postgres pg_basebackup -U pct_admin -D - -Ft -z -Xs -P \
  > "${DEST}/base.tar.gz"

docker compose exec -T postgres pg_dumpall -U pct_admin --globals-only \
  > "${DEST}/globals.sql"

sha256sum "${DEST}"/* > "${DEST}/SHA256SUMS"
rsync -a --delete "$DEST" backup@10.10.0.40:/vault/pct/
find /backup/pct -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
```

WAL segments archive continuously to `/data/wal-archive` and are synced to the same off-instance target.

### 14.3 Restore

```bash
docker compose stop api worker            # on instance 2 first
docker compose stop postgres              # instance 3
mv /data/postgres /data/postgres.broken
install -d -o 999 -g 999 /data/postgres
tar -xzf /backup/pct/<stamp>/base.tar.gz -C /data/postgres

cat > /data/postgres/recovery.signal <<'EOF'
EOF
cat >> /data/postgres/postgresql.auto.conf <<'EOF'
restore_command = 'cp /wal-archive/%f %p'
recovery_target_time = '2026-07-30 02:00:00+07'
recovery_target_action = 'promote'
EOF

docker compose up -d postgres
docker compose logs -f postgres           # watch recovery complete
```

Then verify before letting users back in:

```sql
SELECT id, as_of_date, status, published_at FROM core.dataset_version ORDER BY id DESC LIMIT 5;
SELECT current_version_id FROM core.dataset_pointer;
```

```bash
docker compose exec api node dist/tools/verify-audit-chain.js
docker compose up -d api worker
pnpm test:smoke -- --base-url https://procurement.energi-up.com
```

### 14.4 Restore drill

**Quarterly, into staging, with the result recorded.** An untested backup is not a backup. The drill must produce: restore duration, the recovered as-of date, and confirmation that the audit hash chain verifies.

---

## 15. Go-live checklist

### Infrastructure
- [ ] Three instances provisioned, hardened, patched
- [ ] Firewall matrix verified from outside
- [ ] TLS certificate installed, chain valid, expiry alert configured
- [ ] Synology mount read-only and verified (`touch` fails)
- [ ] Timezone and NTP correct on all three

### Data
- [ ] Schema migrated; seeds applied (roles, movement types, notification events, template contracts)
- [ ] `core.dim_movement_type` contains 101, 102, 122, 641, 642
- [ ] Rule config seeded: WBS thresholds, `wbs.basis=per_item`, `release.no_strategy_policy=flag_only`, `fx.policy=period_matched`, `aging.threshold_days=60`
- [ ] Backup running; **restore drill completed and recorded**

### Authentication
- [ ] Production Hub client registered; redirect URI byte-exact
- [ ] Backend-to-Hub path verified from instance 2
- [ ] **SP-initiated login verified in a browser**
- [ ] **IdP-initiated login (Hub tile) verified in a browser**
- [ ] `pct_sid` confirmed present for the app hostname
- [ ] Break-glass local account created, MFA enrolled, expiry set, approval recorded
- [ ] New-SSO-user path confirmed: role `viewer`, empty scope, no data visible

### Application
- [ ] Config validation confirmed by starting with a deliberately bad value
- [ ] CSP active, zero violations in devtools
- [ ] No external origin in the bundle (deploy-script gate green)
- [ ] Upload gates verified: oversized, wrong extension, renamed non-XLSX, EICAR, zip bomb
- [ ] Export formula-injection neutralisation verified
- [ ] Rate limits verified
- [ ] Scope-leakage suite green; drill-token replay rejected and audited
- [ ] Audit hash chain verifies

### Data pipeline
- [ ] First production bundle ingested end to end
- [ ] Golden numbers reproduce: 645/33 splits, 4,453 STO lines, 9,094 direct PO lines, 291 dangling, 0 GR orphans, 13,338 continuation rows attached, **0 contaminated GR dates**, 241/89 release-exempt, 92 fully reversed, 1,119/339 WBS violations, 4,211 indeterminate
- [ ] Demand Realism confirmed **disabled** with V-M01 stated on the card
- [ ] Expedite Effectiveness reads **0.50×**; GR/IR > 60d **91.67%**; commitment > 60d **58.65%**
- [ ] Every chart's drill count equals its aggregate count
- [ ] Freshness banner shows the correct as-of date, load time and source
- [ ] Rollback exercised and timed (≤ 2 min)

### Notifications
- [ ] SMTP verified from instance 2
- [ ] Subscriptions configured for `data.published`, `ingest.failed`, `ingest.template_drift`, `data.stale`
- [ ] Test send received and legible
- [ ] Confirmed emails contain **no** vendor names, values or line detail
- [ ] External recipients (if any) approved and audited

### Operations
- [ ] Dashboards live; alerts routed and tested
- [ ] Runbooks reviewed with the on-call team
- [ ] Patch SLA agreed
- [ ] Penetration test complete; high and critical findings closed
- [ ] Accessibility audit complete
- [ ] UAT signed off by all six personas
- [ ] Training delivered to analysts, stewards and administrators
- [ ] D4 change request raised with the ME5A owner and tracked

---

*End of TECH 03. See [TECH 01 — Architecture](TECH_01_Architecture_and_Implementation.md) and [TECH 02 — API Reference](TECH_02_API_Reference.md).*
