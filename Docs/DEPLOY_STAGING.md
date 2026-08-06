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
- **For DWS Hub SSO** (users get two login paths: local credentials AND the
  Hub): the **browser → Hub** and the **BE server (57) → Hub** paths must both
  be open — the token exchange is server-to-server. Register the app with the
  Hub admin ahead of time (details in step 6): redirect URI
  `http://172.28.92.56:3050/auth/oidc/callback`, public client / PKCE, and
  collect the assigned `client_id`. SSO can also be enabled later without a
  redeploy — it is env-only.
- Docker + Compose v2 on all three servers (already present per `docker ps`).
- Note: all three hosts show "System restart required" from unattended
  upgrades — schedule reboots before go-live, not during this deployment.

## 1. Get the code onto the app servers (from GitHub)

The repo lives at `git@github.com:dwsitproject-hub/Procurement-Control-Tower.git`.
The FE and BE servers build their own images from a checkout — the same
pattern as the other apps on these hosts. The DB server needs no code.

### 1a. Give each app server read-only GitHub access (one-time)

A fresh server has no GitHub key, so a clone fails with
`git@github.com: Permission denied (publickey)` — set the key up FIRST.
Do this on **both** app servers (57 and 56), each with its **own** key
(GitHub rejects a deploy key that is already registered elsewhere).

In the server's PuTTY session:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/pct_deploy -N '' -C "pct-staging-$(hostname)"
cat ~/.ssh/pct_deploy.pub
```

Add the printed key on GitHub → repo → Settings → **Deploy keys** →
*Add deploy key* — **read-only** (leave "Allow write access" unticked;
servers only pull). Then point SSH at it:

```bash
printf 'Host github.com\n  User git\n  IdentityFile ~/.ssh/pct_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
```

> **If this server already reaches GitHub for other apps:** the appended
> `Host github.com` block takes over ALL github.com traffic on this box —
> SSH uses the first matching block in `~/.ssh/config`. If another repo's
> `git pull` breaks later, check the block ordering in that file.

### 1b. Clone

In the PuTTY session on **each app server** (57 and 56):

```bash
mkdir -p /opt/pct && cd /opt/pct
git clone -b sit2 git@github.com:dwsitproject-hub/Procurement-Control-Tower.git src
```

First contact prints GitHub's host-key fingerprint — answer `yes`.

> If a clone attempt failed half-way earlier, git leaves the empty target
> directory behind and the retry refuses to clone into it —
> `rm -rf` the leftover directory first.

> **Working from Windows with PuTTY:** server commands run in a PuTTY session
> per host (as `root`). The only file transfer left is the SAP data files,
> via **`pscp`** from the workstation (installed with PuTTY — if not on PATH,
> call `"C:\Program Files\PuTTY\pscp.exe"`).

## 2. DB server — 172.28.92.60

Fully self-contained in the PuTTY session on **172.28.92.60** — the compose
file is written in place (this host has no repo checkout, and pasting beats
a cross-machine copy):

```bash
mkdir -p /opt/pct && cd /opt/pct
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 24)" > db.env
chmod 600 db.env

cat > compose.yml << 'EOF'
name: pct

services:
  postgres:
    image: postgres:16.4-bookworm
    container_name: pct-postgres
    restart: unless-stopped
    env_file:
      - ./db.env
    environment:
      POSTGRES_DB: pct
      POSTGRES_USER: pct
      POSTGRES_INITDB_ARGS: "--data-checksums"
      TZ: Asia/Jakarta
    command:
      - postgres
      - -c
      - shared_buffers=512MB
      - -c
      - effective_cache_size=1536MB
      - -c
      - work_mem=32MB
      - -c
      - maintenance_work_mem=256MB
      - -c
      - max_connections=100
      - -c
      - random_page_cost=1.1
      - -c
      - default_statistics_target=200
      - -c
      - enable_partition_pruning=on
      - -c
      - enable_partitionwise_join=on
      - -c
      - enable_partitionwise_aggregate=on
      - -c
      - log_min_duration_statement=1000
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "172.28.92.60:5436:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pct -d pct"]
      interval: 5s
      timeout: 5s
      retries: 20
    shm_size: 512mb

volumes:
  pgdata:
EOF

docker compose -f compose.yml up -d
sleep 5
docker exec pct-postgres pg_isready -U pct -d pct   # expect "accepting connections"
```

The file it writes is `deploy/staging/db.compose.yml` from the repo — if the
repo version changes later, re-paste from there.

Keep `db.env` safe — its password goes into the BE `DATABASE_URL` next.

## 3. BE server — 172.28.92.57

Everything below runs in the PuTTY session on **172.28.92.57** (except the
Assets transfer, marked workstation).

Build the API image from the checkout:

```bash
cd /opt/pct/src
docker build -f Backend/Dockerfile -t pct-api:staging .
```

Lay out the runtime files from the repo's templates:

```bash
cd /opt/pct
cp src/deploy/staging/be.compose.yml compose.yml
cp src/deploy/env/staging.env staging.env
cp src/deploy/env/secrets.staging.env.example secrets.staging.env
mkdir -p assets
chmod 600 staging.env secrets.staging.env
```

Edit `/opt/pct/staging.env` (e.g. `nano staging.env`):
- `SESSION_SECRET` → paste output of `openssl rand -base64 48`
- `DATABASE_URL`   → `postgres://pct:<password from db.env>@172.28.92.60:5436/pct`
- **SSO (if the Hub registration is done):** uncomment the `OIDC_*` block and
  fill the Hub hostname + `client_id` — see step 6. Leave it commented to ship
  with local login only and enable SSO later.

Edit `/opt/pct/secrets.staging.env` with the kpn-test Coupa credentials.

Put the SAP export files in the share stand-in (**workstation**):

```bash
pscp "Assets/*.XLSX" "Assets/*.xlsx" root@172.28.92.57:/opt/pct/assets/
```

(When the real Synology/CIFS share is available, mount it read-only at
`/opt/pct/assets` instead — the compose file already mounts it `:ro`.)

Start, seed, ingest — **the API migrates its own schema at boot**
(idempotent, advisory-locked), so there is no separate migrate step:

```bash
cd /opt/pct
docker compose -f compose.yml up -d
docker logs -f pct-api          # wait for "listening on :3000"; Ctrl-C
docker exec pct-api node dist/db/seed.js      # roles + dev admin (dev-mode only)
curl -s http://172.28.92.57:4100/ -o /dev/null -w '%{http_code}\n'   # 404 = API up
```

> On a first boot the log shows `migrations applied at boot: 001... 010...`.
> (Images built before 6 Aug 2026 don't self-migrate — run
> `docker exec pct-api node dist/db/migrate.js` once, or rebuild.)

Trigger the first ingest (as the seeded admin):

```bash
curl -s -c /tmp/pct.jar -X POST http://172.28.92.57:4100/auth/local/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@energi-up.com","password":"ChangeMe!Local2026"}'
curl -s -b /tmp/pct.jar -X POST http://172.28.92.57:4100/api/v1/ingest/sync \
  -H 'Content-Type: application/json' -d '{}' -m 580
```

Expect `"outcome":"published"` with a dataset version id (`1` on a fresh
database).

### Reading the ingest response

The response carries the full data-quality report, which looks alarming and is
not: `WARNING` findings are **known characteristics of the SAP export**, not
deployment problems — the publish already succeeded. Confirm the staging
figures match the reference ingest of the same six files:

| Rule | Expected | Meaning |
|---|---:|---|
| `V-M01` CAVEAT | 19,989 | No true need-by date in the export → Demand Realism and On-Time-vs-Requested stay disabled (PRD 13.1.1) |
| `V-M03` INFO | 7,776 | PO delivery date equals doc date on 37.4% of lines → vendor OTD carries this caveat |
| `V-R03` WARNING | 291 | PO lines referencing a requisition absent from the PR feed — kept and flagged, never fabricated |
| `V-B01` WARNING | 107 | Token prices (0 < net ≤ 1) |
| `V-B02` WARNING | 74 | Zero net price |
| `V-B03` WARNING | 4,453 | STO lines across 767 POs — excluded from spend, retained in delivery |
| `V-B04` WARNING | 4,211 | PR items with no valuation → WBS status indeterminate, never "compliant" |
| `V-B07` WARNING | 92 | PO lines netting to zero after reversal |
| `V-B10` WARNING | 241 | Release-exempt lines across 89 POs |
| `V-I01` INFO | — | Linkage: 10,378 PR items reached a PO · 645 split-sourced (max 33) · 9,094 direct POs |
| **`V-B08` INFO** | **0** | **Must be 0** — receipt-date contamination (the v1 defect that produced 1,695). Anything above 0 is a real problem |

A different row count here means staging ingested different files — check
`/opt/pct/assets` before trusting any figure on the dashboard.

## 4. FE server — 172.28.92.56

In the PuTTY session on **172.28.92.56**:

```bash
cd /opt/pct/src
docker build -f Frontend/Dockerfile -t pct-web:staging .

cd /opt/pct
cp src/deploy/staging/fe.compose.yml compose.yml
cp src/deploy/nginx/staging.conf staging.conf
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
5. Admin → FX Rates: `sap` and `coupa` source pills both present.
6. Admin → SAP Data Upload → **SAP Data Sync**: each of the six files has its
   own folder, name pattern and up to three daily pickup times in
   **Asia/Jakarta**. Press *Test / preview folders* — every row should show the
   file it would use (the newest match). Then tick **Scheduled sync** and
   *Save schedule*. Use *Same folder for all* / *Same times for all* when the
   exports share one directory. The panel shows the last run and a
   recent-pickups log. (This scheduler is new as of 6 Aug 2026 — before that
   the share ingest only ran when someone pressed Sync, which is why auto-sync
   appeared dead.)
   Note: a dataset publishes complete or not at all, so a pickup time decides
   when that file's folder is re-read; each firing assembles the newest file
   from every folder into one bundle. Unchanged files report `noop_unchanged`.
7. **Both login paths** (when SSO is enabled): the login page shows
   "Sign in with DWS Hub" above the credential form — test the SP-initiated
   flow (button) AND the IdP-initiated flow (the app's tile in the Hub
   dashboard); both must land signed in. If the button is missing, the Hub was
   unreachable from the BE server (boot log shows the discovery warning).
8. Full verification from the workstation (card = drill on every figure):
   `npx tsx Backend/src/cli/sweep.ts --base http://172.28.92.56:3050`
   — expect `mismatches=0 errors=0` (pass `--password` if you already
   rotated the admin credential).

## 6. Enable DWS Hub SSO (the second login path)

The app supports two login paths side by side: local credentials and DWS Hub
OIDC (Authorization Code + PKCE, public client — implemented per
SSO-TARGET-APP-INTEGRATION.md, both SP- and IdP-initiated flows).

1. **Register with the Hub admin** (Hub → Admin → Applications):
   - Redirect URI: `http://172.28.92.56:3050/auth/oidc/callback` — must match
     byte-for-byte; it goes through the FE proxy, never an internal port.
   - Client type: public / PKCE. There is **no client secret** — don't ask.
   - Collect the assigned `client_id`.
2. **Verify reachability from the BE server** (token exchange is
   server-to-server):
   `curl -s https://<hub-host>/api/sso/.well-known/openid-configuration`
3. **Uncomment and fill the OIDC block** in `/opt/pct/staging.env`, then
   `docker compose -f /opt/pct/compose.yml up -d api`. Boot logs show either
   `OIDC discovery loaded — DWS Hub SSO available` or a warning.
4. **Test both flows** (the guide's biggest gotcha is the second one):
   - SP-initiated: login page → "Sign in with DWS Hub" → authenticate → back
     in, signed in.
   - IdP-initiated: click the app's tile **in the Hub dashboard** → same
     result (the Hub passes `code_verifier` to the callback).
5. First SSO login creates the user as `viewer` with an **empty data scope** —
   an admin must grant scope before they see any data. Nothing is inferred
   from the email domain.

If the Hub is down, the login page automatically hides the SSO button
(the probe gets 503, not a redirect) and local login is unaffected.

## 7. Updating staging (each release)

```bash
# workstation: push the release
git push origin sit2

# BE server (PuTTY session)
cd /opt/pct/src && git pull
docker build -f Backend/Dockerfile -t pct-api:staging .
docker compose -f /opt/pct/compose.yml up -d api   # migrations apply at boot

# FE server (PuTTY session)
cd /opt/pct/src && git pull
docker build -f Frontend/Dockerfile -t pct-web:staging .
docker compose -f /opt/pct/compose.yml up -d web
```

If a release changed the compose files, env template, or nginx conf, re-copy
them from `src/deploy/...` (compare first — your filled `staging.env` /
`secrets.staging.env` are local to the server and must not be overwritten).

Rollback = `git checkout <previous commit>` in `/opt/pct/src`, rebuild, `up -d` — or keep the previous image tagged (`docker tag pct-api:staging pct-api:prev`) before rebuilding and retag it back. The database
never rolls back — migrations are additive and dataset versions immutable.

## Known staging caveats

- **HTTP only** → runs `NODE_ENV=development` (secure-cookie boot validation
  would refuse production over HTTP). Before production: TLS at the FE,
  `NODE_ENV=production`, `SESSION_COOKIE_SECURE=true`, OIDC on, and the dev
  admin seed will refuse to run.
- **SSO over HTTP works** only because the FE is a single origin (nginx
  proxies `/auth/*`), keeping the session cookie first-party with
  `SameSite=Lax` — the exact Option-A layout from
  SSO-TARGET-APP-INTEGRATION.md step 2. Never point the Hub's redirect URI at
  an internal port that bypasses the proxy, and confirm the Hub accepts an
  `http://` redirect URI for this internal domain.
- **First SSO login = viewer with an empty data scope.** Brief the admin: new
  Hub users see the shell but zero data until Admin → Users grants scope.
  Local and SSO identities are separate accounts unless deliberately mapped.
- **Coupa staging FX rates are test junk** (USD→IDR ≈ 17.8): periods the SAP
  rate file covers are safe (SAP wins on recency), but uncovered periods
  convert at junk rates — e.g. PR Pipeline shows ≈ $76 B. Self-corrects
  against production Coupa. Admin → FX rates shows the source per rate.
- Coupa production credentials are over-scoped (TECH_04 §2) — keep staging on
  the kpn-test client until the read-only production client exists.
