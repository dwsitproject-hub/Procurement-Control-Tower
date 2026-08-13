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

The SMTP block in `staging.env` is pre-filled for **`mail.energi-up.com:465`
with implicit TLS** (`SMTP_SECURE=tls`, user `noreply.sys@energi-up.com`) —
**fill `SMTP_PASSWORD`** there, on the server only. Recipients are set later in
the app (Admin → Notifications), not in this file.

> **Use 465, not 587.** Tested against the live server 6 Aug 2026: port 587
> offers no STARTTLS (it answers `503 TLS is not allowed`), so mail and
> credentials would cross the network unencrypted. Port 465 accepts implicit
> TLS and passes full certificate verification, so it is both the working and
> the secure choice.

Put the SAP export files in the share stand-in (**workstation**):

```bash
pscp "Assets/*.XLSX" "Assets/*.xlsx" root@172.28.92.57:/opt/pct/assets/
```

This is the fallback source, used until the NAS is wired up in step 3a.

### 3a. Read the exports from the shared Synology NAS

Do this instead of maintaining `/opt/pct/assets` by hand. The app-side contract
is in `Docs/SYNOLOGY-INTEGRATION.md`; the mount itself belongs to infra.

**Check the mount FIRST — do not configure the app before this passes.** A
folder existing proves nothing; only the filesystem type does:

```bash
findmnt -t cifs,nfs,nfs4,smb3
stat -f -c '%T  %n' /mnt/synology-apps /mnt/synology-apps/dev
ls -la /mnt/synology-apps/dev
```

- `stat -f` says **`cifs`** and the path appears in `findmnt` → it is the NAS.
- `stat -f` says **`ext2/ext3`** → it is a LOCAL folder on this server's disk,
  whatever it looks like in a file browser. Stop here.

> **Checked on 172.28.92.57, 7 Aug 2026: it was NOT mounted.**
> `findmnt` printed nothing and `/mnt/synology-apps`, `/mnt/synology-apps/dev`
> and `/mnt/synology/eos` were all `ext2/ext3` — plain local directories, with
> an empty `dev/klip` skeleton left behind. The Synology doc describes the *EOS
> app server*; this staging BE is a different VM and the share had never been
> mounted on it. Files dropped in those folders stay on the BE server's disk and
> never reach File Station.

Mounting the share is infra's job. What it needs (read-only is sufficient — the
app never writes to the NAS):

> **Status on 172.28.92.57 as of 7 Aug 2026: BLOCKED at the network layer.**
> The SMB server is **172.30.1.94** (from `/etc/smb-eos.creds`, left behind by an
> EOS setup that was never completed on this VM — there is no fstab entry). It is
> **unreachable from the BE server**: `nc -zv 172.30.1.94 445` returns
> `No route to host` and `smbclient -L` returns `NT_STATUS_HOST_UNREACHABLE`.
> `172.28.92.x` and `172.30.1.x` are different subnets with no route between them.
>
> Credentials are NOT the problem, and neither is the app. What infra must do:
> allow **TCP 445 from 172.28.92.57 to 172.30.1.94** — on Alibaba Cloud that is
> usually the NAS's security group plus VPC peering/route if the two sit in
> different VPCs. Until then leave `STORAGE_*` commented out; staging keeps
> reading `assets/`, and Admin → SAP Data Upload (manual upload) is unaffected.

First, from infra — none of this can be guessed:

| Needed | Notes |
|---|---|
| DSM hostname or IP | Must be reachable from 172.28.92.57 |
| Share name | `APPs` unless they say otherwise |
| A service account + password | **Read access is enough** |

If another server already mounts this share, its `/etc/fstab` has all three —
faster than a ticket.

Write the credentials file with an editor, not a shell one-liner: a pasted
`<placeholder>` makes bash treat `<` as input redirection and the command dies
with `No such file or directory`.

```bash
apt-get install -y cifs-utils
nano /etc/pct-nas.cred      # two lines: username=... and password=...
chmod 600 /etc/pct-nas.cred
```

Then set the host once and mount (edit the first line before pasting):

```bash
NAS_HOST='10.0.0.5'
nc -zv "$NAS_HOST" 445
mount -t cifs "//$NAS_HOST/APPs" /mnt/synology-apps   -o ro,credentials=/etc/pct-nas.cred,uid=1001,gid=1001,dir_mode=0550,file_mode=0440,vers=3.0,iocharset=utf8
stat -f -c '%T  %n' /mnt/synology-apps && ls -la /mnt/synology-apps/dev
```

`stat -f` must now print `cifs`. If it still prints `ext2/ext3`, the mount did
not happen — read the error rather than continuing.

Two options there are load-bearing:

- **`ro`** — the app only reads the exports, so a read-only mount makes it
  impossible for an ingest defect to modify or delete a source file.
- **`uid=1001,gid=1001`** — CIFS ignores the server's POSIX ownership, and the
  API container runs as uid 1001. Without these the container cannot read the
  files even though the mount itself is healthy (the same cause as the earlier
  upload-spool `EACCES`).

Only once that prints `cifs`, persist it — otherwise a reboot silently drops
back to an empty local folder. Append it as a command (do not paste an fstab
line into the shell; it is a file format, not a command):

```bash
printf '//%s/APPs /mnt/synology-apps cifs ro,credentials=/etc/pct-nas.cred,uid=1001,gid=1001,dir_mode=0550,file_mode=0440,vers=3.0,iocharset=utf8,_netdev 0 0
' "$NAS_HOST" >> /etc/fstab
mount -a && findmnt /mnt/synology-apps
```

Then confirm the project folder exists (`APPs → dev → pct`; create it or ask
infra — note the neighbouring app uses a lowercase slug, and case matters), and
uncomment the four `STORAGE_*` lines in `/opt/pct/staging.env`:

```env
STORAGE_TYPE=local
STORAGE_SYNOLOGY_ROOT=/mnt/synology-apps
STORAGE_DEPLOYMENT=dev
STORAGE_PROJECT_SLUG=pct
```

Resolved folder: `/mnt/synology-apps/dev/pct`. All three of root/deployment/slug
must be set together — a partial set is refused at boot on purpose, because
falling back silently gives you a healthy-looking dashboard reading the wrong
folder.

If this server mounts the share somewhere else, tell **Compose** (not
`staging.env` — the bind mount is substituted before the container starts):

```bash
echo 'STORAGE_HOST_MOUNT=/srv/synology' > /opt/pct/.env
```

Recreate the container so the bind takes effect, then confirm:

```bash
cd /opt/pct
docker compose -f compose.yml up -d --force-recreate api
docker logs pct-api 2>&1 | grep -iE 'storage|WARNING'
```

Expect `storage=synology:/mnt/synology-apps/dev/pct` and **no** `WARNING
storage:` line.

> **Why the API checks this itself.** Docker does not fail when a bind source is
> missing — it creates an empty folder — so a missing mount looks exactly like
> "no files found". The API compares the folder's filesystem against the
> container root at boot and says `WARNING storage: ... is on the container's
> own filesystem, not a mount` when the bind did not happen. Admin → SAP Data
> Upload shows the same verdict in the UI.

Last step, and it is easy to miss: **folders already saved in the panel win over
the environment.** Open Admin → SAP Data Upload. If the six rows still point at
`/mnt/sap_exports` the page says so ("outside the storage folder") and offers
**Use the NAS folder for all** — click it, then **Save schedule**, then
**Test / preview folders** to confirm all six exports are found. The mount is
bound read-only, so an ingest can never modify a source export.

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
7. Admin → **Notifications**: confirm the mail-server rows read
   `mail.energi-up.com` / `587` / `starttls` and Password = *configured*, add
   the recipients, then **Send test email** — it must report `sent` and arrive.
   Failure notices are the ones that matter; a clean Coupa sync is not emailed
   on purpose (it runs every few minutes).
8. **Both login paths** (when SSO is enabled): the login page shows
   "Sign in with DWS Hub" above the credential form — test the SP-initiated
   flow (button) AND the IdP-initiated flow (the app's tile in the Hub
   dashboard); both must land signed in. If the button is missing, the Hub was
   unreachable from the BE server (boot log shows the discovery warning).
9. Full verification from the workstation (card = drill on every figure):
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

---

## 8. Put staging behind http://test-pct.kpndomain.com

No rebuild is involved. The frontend calls the API with relative paths and the
CSP is entirely `'self'`, so nothing in the bundle knows its own hostname — this
is DNS, one published port, and three lines of config.

### 8.1 DNS (infra)

An **A record** `test-pct.kpndomain.com` → **172.28.92.56**. That is a private
address, so it has to be the internal resolver; a public zone cannot answer for
it usefully. Confirm from a machine that will actually use the dashboard, not
from the server:

```bash
nslookup test-pct.kpndomain.com
```

### 8.2 Port 80 belongs to the host's nginx — proxy, do not take it

Checked on 172.28.92.56 (13 Aug 2026): port 80 is held by a **package-installed
nginx**, serving its default "Welcome to nginx!" page.

```bash
ss -ltnp | grep -w ':80'
# LISTEN [::]:80  users:(("nginx",pid=954429,...),("nginx",pid=954428,...))
```

Those are nginx worker processes, not `docker-proxy`, so this is the host's own
nginx rather than a container. **This server also runs klip, slms, eos and
others** — that nginx is the shared front door for them, so stopping it or
taking its port would break applications that have nothing to do with this one.

So the dashboard stays on 3050 and the subdomain reaches it through a vhost.
See first what the host nginx already serves, so the new file cannot collide:

```bash
nginx -v && systemctl is-enabled nginx
ls /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ 2>/dev/null
nginx -T 2>/dev/null | grep -E 'server_name|listen ' | head -40
```

Then install the vhost from the repo — it is written to be additive, with no
`default_server`, so an unknown Host keeps reaching whatever answered before:

```bash
cd /opt/pct/src && git pull
cp deploy/nginx/host-vhost-test-pct.conf /etc/nginx/conf.d/test-pct.conf
nginx -t
systemctl reload nginx
```

`nginx -t` before the reload is not optional: a syntax error in a shared nginx
takes every other site on the host down with it.

Make sure the container is up on 3050 (it should already be):

```bash
cd /opt/pct
cp src/deploy/staging/fe.compose.yml compose.yml
cp src/deploy/nginx/staging.conf staging.conf
docker compose -f compose.yml up -d
curl -s -o /dev/null -w 'container direct: %{http_code}
' http://127.0.0.1:3050/
```

> **Why the vhost sets `client_max_body_size 210m`.** The SAP upload posts six
> files of up to 60 MB. nginx defaults to 1 MB, and the outer proxy rejects the
> request with a 413 long before the container's own 210m limit is consulted —
> so the limit has to be raised in BOTH places.

### 8.3 Tell the backend where it lives (172.28.92.57)

`APP_BASE_URL` is what the backend uses to build absolute links and the OIDC
redirect, so it must match what the browser typed:

```bash
cd /opt/pct
sed -i 's|^APP_BASE_URL=.*|APP_BASE_URL=http://test-pct.kpndomain.com|' staging.env
grep APP_BASE_URL staging.env
docker compose -f compose.yml up -d --force-recreate api
```

### 8.4 Verify

```bash
curl -s -o /dev/null -w 'root %{http_code}
' http://test-pct.kpndomain.com/
curl -s -o /dev/null -w 'deep link %{http_code}
' http://test-pct.kpndomain.com/po-analysis
curl -s -o /dev/null -w 'api %{http_code}
' http://test-pct.kpndomain.com/api/v1/kpi
```

Expect `200`, `200`, `401`. The 401 is correct — the API is reachable and
refusing an unauthenticated call. If the root returns the nginx welcome page
instead, the request reached the host nginx but not the vhost: check
`server_name` matches the hostname exactly and that `nginx -T` lists the file. Then sign in through the browser and confirm
the session sticks across a page reload: that exercises the cookie, which is the
part a hostname change breaks if `proxy_set_header Host $host` were missing (it
is present).

Existing sessions do NOT carry over — cookies were issued for the old host, so
everyone signs in once more.

### 8.5 Enable DWS Hub SSO

The Hub runs on the SAME nginx as the dashboard —
`test-dwshub.kpndomain.com`, found in that host's vhost list — so it is
reachable from the BE server without any network change.

**1. Confirm the discovery document FROM THE BE SERVER (172.28.92.57).** The
backend performs the token exchange server-to-server, so the browser reaching
the Hub proves nothing. Try both schemes; the vhost list shows the Hub on
port 80, so plain HTTP is the likely answer:

```bash
for u in https://test-dwshub.kpndomain.com http://test-dwshub.kpndomain.com; do
  printf '%s -> ' "$u"
  curl -s -o /dev/null -w '%{http_code}
' --max-time 8     "$u/api/sso/.well-known/openid-configuration"
done
```

Whichever returns `200`, read it and keep the issuer and endpoints:

```bash
curl -s http://test-dwshub.kpndomain.com/api/sso/.well-known/openid-configuration | head -c 600
```

**2. Register the dashboard in the Hub** (Admin → Applications):

| Field | Value |
|---|---|
| Redirect URI | `http://test-pct.kpndomain.com/auth/oidc/callback` |
| Client type | **public / PKCE** — no client secret exists |

The Hub matches the redirect URI **byte-exactly**: a trailing slash, `https`
instead of `http`, or the old `172.28.92.56:3050` form all fail with
`invalid_grant`. Note the `client_id` it assigns.

**3. Fill the three variables** in `/opt/pct/staging.env` — all three or none,
which boot validation enforces:

```env
OIDC_DISCOVERY_URL=http://test-dwshub.kpndomain.com/api/sso/.well-known/openid-configuration
OIDC_CLIENT_ID=<the client_id the Hub assigned>
OIDC_REDIRECT_URI=http://test-pct.kpndomain.com/auth/oidc/callback
```

```bash
cd /opt/pct && docker compose -f compose.yml up -d --force-recreate api
docker logs pct-api --tail 5 | grep -o 'sso=[a-z]*'
```

Expect `sso=configured`. While the Hub is unreachable or misconfigured the login
page simply hides the SSO button and local credentials keep working, so a
mistake here cannot lock anyone out.

**4. The first SSO sign-in needs an admin afterwards.** A user arriving through
the Hub is provisioned with the `viewer` role and **deliberately no data scope**
(`app.data_scope` is left empty on purpose), so they will see *"No data access
granted"* rather than the dashboard. That is the intended default — access is
granted, never assumed. In Admin → Users, for that account:

- **Grant all data** (or **Scope…** for specific company/plant/purchasing org), and
- set their **Department** and **Role**, which is what the page-permission
  matrix reads. With neither set, every page resolves to `none`.

> **SSO over plain HTTP.** The authorization code and the returned ID token
> cross the network in clear text. PKCE stops another application replaying the
> code, but it does not hide the token from anyone watching the wire. This is
> the same exposure as the password login today, and the same argument for
> putting a certificate on `test-pct.kpndomain.com` before real users arrive
> (see 8.6).

### 8.6 The TLS question this raises

A real hostname is the point at which HTTP stops being defensible: sessions and
passwords cross the network in clear text. Worth planning now, because two
settings are coupled to it and boot validation enforces both:

| | Today (HTTP) | With TLS |
|---|---|---|
| `SESSION_COOKIE_SECURE` | `false` | `true` |
| `NODE_ENV` | `development` | `production` |
| `LOCAL_AUTH_REQUIRE_MFA` | `false` | **`true` — production refuses local auth without it** |

So `NODE_ENV=production` is not a flag to flip on its own: it demands a
certificate AND MFA enrolment for every local account, and it also stops the dev
admin seed from running. Staging stays in development mode until those are in
place, which is why the cookie is not Secure today.
