# Staging deployment guide — Procurement Control Tower v2

Three-server staging (Alibaba Cloud VPC, audited 5 Aug 2026):

| Role | Host          | What runs                     | Published port                | Why this port |
|------|---------------|-------------------------------|-------------------------------|---------------|
| FE   | 172.28.92.56  | `pct-web` (nginx: SPA + proxy)| `0.0.0.0:3050 → 80`           | 3000/3001/3020/3030/3040/3042/3080/3090/3100/8010 already taken |
| BE   | 172.28.92.57  | `pct-api` + `pct-redis`       | `172.28.92.57:4100 → 3000`    | 3000/3001/3003/4000/5000/5001/5002/5050/13000 already taken |
| DB   | 172.28.92.60  | `pct-postgres` (16.4)         | `172.28.92.60:5436 → 5432`    | 5432/5433/5434/5440/5442 already taken |

Traffic flow: browser → FE `:3050` → (nginx proxies `/api` + `/auth`) → BE `:4100` → DB `:5436`.
Single origin at the FE keeps the session cookie first-party; the API and DB
ports bind to private IPs only. Redis is never published.

All deployment artifacts live in the repo:

```
deploy/staging/db.compose.yml     # DB server
deploy/staging/be.compose.yml     # BE server
deploy/staging/fe.compose.yml     # FE server
deploy/nginx/staging.conf         # FE nginx (upstream → 172.28.92.57:4100)
deploy/env/staging.env            # BE env template — fill placeholders
deploy/env/secrets.staging.env.example  # Coupa credentials template
```

---

## 0. Prerequisites (one-time)

- Security groups / firewalls must allow: **your office → 56:3050**,
  **56 → 57:4100**, **57 → 60:5436**, and **57 → kpn-test.coupahost.com:443**
  (Coupa) plus the SAP share if mounted.
- Docker + Compose v2 on all three servers (already present per `docker ps`).
- Note: all three hosts show "System restart required" from unattended
  upgrades — schedule reboots before go-live, not during this deployment.

## 1. Build and ship the images (on the workstation)

Build once, ship the exact same bytes to both servers — no source code or
toolchain on the servers.

```bash
cd "D:/Claude/Procurement Dashboard"
docker compose build api web
docker tag pct-api pct-api:staging
docker tag pct-web pct-web:staging
docker save pct-api:staging | gzip > pct-api-staging.tar.gz
docker save pct-web:staging | gzip > pct-web-staging.tar.gz
scp pct-api-staging.tar.gz root@172.28.92.57:/opt/pct/
scp pct-web-staging.tar.gz root@172.28.92.56:/opt/pct/
```

(Create `/opt/pct` on each server first: `ssh root@<host> mkdir -p /opt/pct`.)

## 2. DB server — 172.28.92.60

```bash
ssh root@172.28.92.60
mkdir -p /opt/pct && cd /opt/pct
# copy deploy/staging/db.compose.yml here as compose.yml (scp from workstation)
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 24)" > db.env
chmod 600 db.env
docker compose -f compose.yml up -d
docker exec pct-postgres pg_isready -U pct -d pct   # expect "accepting connections"
```

Keep `db.env` safe — its password goes into the BE `DATABASE_URL` next.

## 3. BE server — 172.28.92.57

```bash
ssh root@172.28.92.57
mkdir -p /opt/pct/assets && cd /opt/pct
docker load < pct-api-staging.tar.gz
# copy from the workstation:
#   deploy/staging/be.compose.yml        -> /opt/pct/compose.yml
#   deploy/env/staging.env               -> /opt/pct/staging.env
#   deploy/env/secrets.staging.env.example -> /opt/pct/secrets.staging.env (fill in)
```

Edit `/opt/pct/staging.env`:
- `SESSION_SECRET` → paste output of `openssl rand -base64 48`
- `DATABASE_URL`   → `postgres://pct:<password from db.env>@172.28.92.60:5436/pct`

Fill `/opt/pct/secrets.staging.env` with the kpn-test Coupa credentials
(`chmod 600` both env files).

Put the SAP export files in the share stand-in (from the workstation):

```bash
scp "Assets/"*.XLSX "Assets/"*.xlsx root@172.28.92.57:/opt/pct/assets/
```

(When the real Synology/CIFS share is available, mount it read-only at
`/opt/pct/assets` instead — the compose file already mounts it `:ro`.)

Start, migrate, seed, ingest:

```bash
cd /opt/pct
docker compose -f compose.yml up -d
docker logs -f pct-api          # wait for "listening on :3000"; Ctrl-C
docker exec pct-api node dist/db/migrate.js   # applies 001..010
docker exec pct-api node dist/db/seed.js      # roles + dev admin (dev-mode only)
curl -s http://172.28.92.57:4100/ -o /dev/null -w '%{http_code}\n'   # 404 = API up
```

Trigger the first ingest (as the seeded admin):

```bash
curl -s -c /tmp/pct.jar -X POST http://172.28.92.57:4100/auth/local/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@energi-up.com","password":"ChangeMe!Local2026"}'
curl -s -b /tmp/pct.jar -X POST http://172.28.92.57:4100/api/v1/ingest/sync \
  -H 'Content-Type: application/json' -d '{}' -m 580
```

Expect `"outcome":"published"` with a dataset version id.

## 4. FE server — 172.28.92.56

```bash
ssh root@172.28.92.56
mkdir -p /opt/pct && cd /opt/pct
docker load < pct-web-staging.tar.gz
# copy from the workstation:
#   deploy/staging/fe.compose.yml -> /opt/pct/compose.yml
#   deploy/nginx/staging.conf     -> /opt/pct/staging.conf
docker compose -f compose.yml up -d
```

## 5. Smoke test

1. `http://172.28.92.56:3050` from a browser in the VPC/VPN — login page loads.
2. Sign in `admin@energi-up.com` / `ChangeMe!Local2026` — **change this
   password immediately** (it is the well-known dev seed).
3. Overview shows figures; a card click opens the drill popup (proves
   FE→BE→DB end to end, cookies included).
4. Admin → Coupa: "Sync now" — every object reports `ok` (proves egress to
   kpn-test). Enable the scheduler (5–10 min) and "Save schedule".
5. Admin → FX rates: `sap` and `coupa` source pills both present.
6. Full verification from the workstation (card = drill on every figure):
   `npx tsx Backend/src/cli/sweep.ts --base http://172.28.92.56:3050`
   — expect `mismatches=0 errors=0` (pass `--password` if you already
   rotated the admin credential).

## 6. Updating staging (each release)

```bash
# workstation
docker compose build api web
docker tag pct-api pct-api:staging && docker tag pct-web pct-web:staging
docker save pct-api:staging | gzip > pct-api-staging.tar.gz    # scp to 57
docker save pct-web:staging | gzip > pct-web-staging.tar.gz    # scp to 56
# BE server
docker load < pct-api-staging.tar.gz && docker compose -f /opt/pct/compose.yml up -d api
docker exec pct-api node dist/db/migrate.js   # idempotent
# FE server
docker load < pct-web-staging.tar.gz && docker compose -f /opt/pct/compose.yml up -d web
```

Rollback = keep the previous tarball and `docker load` it again. The database
never rolls back — migrations are additive and dataset versions immutable.

## Known staging caveats

- **HTTP only** → runs `NODE_ENV=development` (secure-cookie boot validation
  would refuse production over HTTP). Before production: TLS at the FE,
  `NODE_ENV=production`, `SESSION_COOKIE_SECURE=true`, OIDC on, and the dev
  admin seed will refuse to run.
- **Coupa staging FX rates are test junk** (USD→IDR ≈ 17.8): periods the SAP
  rate file covers are safe (SAP wins on recency), but uncovered periods
  convert at junk rates — e.g. PR Pipeline shows ≈ $76 B. Self-corrects
  against production Coupa. Admin → FX rates shows the source per rate.
- Coupa production credentials are over-scoped (TECH_04 §2) — keep staging on
  the kpn-test client until the read-only production client exists.
