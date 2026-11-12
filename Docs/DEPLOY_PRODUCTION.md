# Production deployment guide — Procurement Control Tower

First production deployment of PCT, and every release after it. Prepared 12 Nov 2026 from the staging
runbook (`Docs/DEPLOY_STAGING.md`) and everything it learned the hard way. Regenerate or re-check it with
the `pct-production-deploy` skill (`.claude/skills/pct-production-deploy/`).

**Conventions.** Every command block says which machine it runs on. Server commands run as `root` in a
PuTTY session; nothing is copied from a workstation except where marked. Passwords are typed into `nano`,
never onto a command line (shell history, the process list). A shell block never contains `<...>`: bash
reads `<` as a redirect. Values to edit are shown as `FILL_...` and edited before pressing Enter.

---

## 0. At a glance

| | Production |
|---|---|
| Address | **http://pct.kpndomain.com** (HTTP for now — see §12 *Going to HTTPS*) |
| FE server | **172.28.80.50** — container `pct-web`, published on **127.0.0.1:3050**, reached through the host's nginx on :80 |
| BE server | **172.28.80.51** — containers `pct-api` (published on **172.28.80.51:4100**) and `pct-redis` (not published) |
| Database | ApsaraDB RDS for PostgreSQL **pgm-d9jn3khh0b3907w4.pgsql.ap-southeast-5.rds.aliyuncs.com:5432**, database `pct`, account `pct` |
| SAP exports | Synology share `APPs/PCT` → BE host `/mnt/synology-apps/PCT` (existing share mount, §5a) → container `/mnt/pct-nas` |
| Code | GitHub `dwsitproject-hub/Procurement-Control-Tower`, branch **`main`**, built on each server |
| Runtime folder | `/opt/pct` on both servers (`/opt/pct/src` is the checkout) |
| Docker network | `pct_net`, a **fixed** subnet per server (`PCT_SUBNET`, from the preflight) |

### Why these ports (both hosts are shared)

From `docker ps` on 12 Nov 2026 — host services that Docker does not show are checked by the preflight
(§4) with `ss`, which sees everything listening:

| Server | Already published | PCT takes |
|---|---|---|
| FE 172.28.80.50 | 2001, 3001, 3002, 3020, 3040, 3042, 3070, 3080, 3100, 3160, 8000, 8080, 8081, 8090, 8443 (+ the host nginx on 80) | **3050**, on 127.0.0.1 only — the same port as staging |
| BE 172.28.80.51 | 3000, 3003, 4000, 4001, 4160, 5000, 5001, 5003, 5010, 5050, 5070, 5433, 5434, 8001, 8091, 13000 | **4100**, on 172.28.80.51 only — the same port as staging |

PCT's Redis is never published (the API reaches it on the private Docker network), so it cannot clash with
the other apps' Redis containers. If the preflight reports either port taken, it prints the next free one:
put it in `/opt/pct/.env` (`PCT_API_BIND=172.28.80.51:NNNN` or `PCT_WEB_BIND=127.0.0.1:NNNN`) and use the
same number in `production.conf` / `host-vhost-pct.conf`.

### Why nothing here can break the other apps' Synology access

Staging lost the NAS twice — and every app on the host lost it too — because **a Docker network was created
in 172.30.0.0/16, the NAS's own range** (the NAS is 172.30.1.94). The host then routed NAS traffic into an
empty bridge (`DEPLOY_STAGING.md` §10). Production avoids both ways that could happen:

1. **PCT's network has a fixed subnet** (`PCT_SUBNET`), chosen by the preflight to overlap no existing
   Docker network, route, local address, the servers' LAN (172.28/16) or 172.29–172.31. Docker never picks
   one for PCT. The compose file refuses to start without it.
2. **PCT mounts only its own folder** — `//172.30.1.94/APPs/PCT` at `/mnt/pct-nas` — with its own
   credentials file and its own fstab line. No existing mount is changed, remounted or unmounted, and the
   other apps' folders are not visible to PCT's container at all.

Nothing in this guide restarts Docker or edits `/etc/docker/daemon.json`; both would restart every app on
the host. (Hardening the pools as in staging §10 Phase 3 is worth doing, in a maintenance window agreed
with the other apps' owners — it is not needed for PCT.)

---

## 1. Requests to make first (infra / admins)

None of these can be done from the servers. Send them together; the guide stops at the step that needs each.

| # | Who | What | Needed at |
|---|---|---|---|
| 1 | Infra (DNS) | A record **pct.kpndomain.com → 172.28.80.50** on the internal resolver | §7 |
| 2 | Infra (network) | **172.28.80.50 → 172.28.80.51 TCP 4100** (FE nginx to API) | §7 |
| 3 | Infra (network) | **172.28.80.51 → 172.30.1.94 TCP 445** (BE to the NAS) | §5 |
| 4 | Infra (network) | **172.28.80.51 → outbound 443** to `kpn.coupahost.com`, `dwshub.kpndomain.com`, the Data Hub; **465** to `mail.energi-up.com`; **22** to `github.com` (both servers) | §2, §6 |
| 5 | DBA / RDS console | Add **172.28.80.51** to the RDS instance's **whitelist**; create account **`pct`** (standard) and database **`pct`** owned by it | §3 |
| 6 | NAS owner | Folder **`APPs/PCT`** (uppercase, at the share ROOT — not under `dev`), and an SMB account with **read/write on that folder only** | §5 |
| 7 | Hub admin (optional) | Register PCT in the **production** Hub: redirect URI `http://pct.kpndomain.com/auth/oidc/callback`, public client / PKCE → `client_id`; and the SDK key (`dwsk_…`) | §8 |
| 8 | Coupa admin | Production OAuth client (client id + secret) for `https://kpn.coupahost.com` | §6 |
| 9 | Data Hub integrator (optional) | A PCT application with `exchange_rate` on its allowlist → key pair | §6 |
| 10 | You | **`main` up to date**: a pull request merging `sit2` into `main`, reviewed and merged | §2 |

---

## 2. Code on both servers

### 2a. Bring `main` up to date (workstation, GitHub)

Production builds from `main`. Open a pull request **sit2 → main** on GitHub, review, merge. Every later
release is the same: merge to `main`, then §10.

### 2b. A read-only deploy key per server (BE 172.28.80.51, then FE 172.28.80.50)

Each server gets its **own** key (GitHub rejects a key already registered elsewhere). It is wired to an
SSH **alias**, `github-pct`, not to `github.com` itself, so other apps' `git pull` on this shared host is
untouched.

**PuTTY on each server:**

```bash
ssh-keygen -t ed25519 -f ~/.ssh/pct_deploy -N '' -C "pct-production-$(hostname)"
cat ~/.ssh/pct_deploy.pub
```

Add the printed key on GitHub → the repository → Settings → **Deploy keys** → *Add deploy key*, **read-only**
(leave *Allow write access* unticked). Then:

```bash
printf '\nHost github-pct\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/pct_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
chmod 600 ~/.ssh/config
ssh -T git@github-pct
```

The last line answers *"Hi dwsitproject-hub/Procurement-Control-Tower! You've successfully authenticated"* —
type `yes` first if it asks about the host key.

### 2c. Clone (each server)

```bash
mkdir -p /opt/pct && cd /opt/pct
git clone -b main git@github-pct:dwsitproject-hub/Procurement-Control-Tower.git src
git -C /opt/pct/src log --oneline -1
```

If a clone fails half-way, remove the leftover `/opt/pct/src` before retrying (git refuses a non-empty target).

---

## 3. Database (ApsaraDB console and DMS)

1. **Whitelist** (RDS console → the instance → *Whitelist and SecGroup*): add **172.28.80.51**.
2. **Account** (*Accounts*): create **`pct`**, type **Standard**. Keep the password for §6 — into `nano`,
   never a chat or a ticket.
3. **Database** (*Databases*): create **`pct`**, owner **`pct`**, encoding UTF8.
4. **Extensions** — PCT's first migration creates three; on ApsaraDB a standard account may not, so create
   them once **as the instance's privileged account** in **DMS**, connected to database `pct`:

   ```sql
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE EXTENSION IF NOT EXISTS citext;
   SELECT extname, extversion FROM pg_extension ORDER BY 1;
   ```

   The last query must list all three.

PCT then creates its own schemas and tables at its first start (migrations run at boot, advisory-locked).
It connects as `pct`, the database owner — **not** the privileged account, unlike staging today.

---

## 4. Preflight (read-only) — BE then FE

The script changes nothing. It reports ports, Docker subnets and a safe `PCT_SUBNET`, existing NAS mounts,
and reachability. Paste its output into the review if anything says `FAIL`.

**PuTTY on 172.28.80.51 (BE):**

```bash
bash /opt/pct/src/deploy/production/preflight.sh be
```

**PuTTY on 172.28.80.50 (FE):**

```bash
bash /opt/pct/src/deploy/production/preflight.sh fe
```

Write down each server's `suggested PCT_SUBNET=...` line — the two servers get their own values.

| Line | Must be | If not |
|---|---|---|
| `port 4100 is free` / `port 3050 is free` | OK | use the free port it prints (§0) |
| `suggested PCT_SUBNET=` | OK | choose by hand from `docker networks` |
| `route to the NAS` | OK, via `eth0` | a `br-*` device means another app's network shadows the NAS — tell that app's owner; do not delete their network yourself |
| `NAS 172.30.1.94:445 reachable` | OK | request #3 |
| `RDS :5432 reachable` | OK | request #5 (whitelist) |
| FE `port 80 is the host nginx` | OK | §7 has the alternatives |

---

## 5. PCT's NAS folder on the BE server (172.28.80.51)

### 5a. Production BE today: use the existing share mount (no host change)

The preflight on 12 Nov 2026 found the whole `APPs` share already mounted at **`/mnt/synology-apps`**
(`rw`, `uid=1001,gid=1001` — PCT's container user) and **`APPs/PCT` already present**
(`drwxrwxr-x 1001 1001 /mnt/synology-apps/PCT`). So PCT binds just that subfolder into its container and adds
no mount, credentials file or fstab line. Only `/mnt/synology-apps/PCT` is visible inside the container.

**PuTTY on 172.28.80.51:**

```bash
findmnt /mnt/synology-apps && stat -f -c '%T  %n' /mnt/synology-apps/PCT
grep -n 'synology-apps' /etc/fstab
```

`stat` must print `cifs`, and `grep` must show an fstab line for `/mnt/synology-apps` (so it returns after a
reboot). Then in §6 add **`PCT_NAS_HOST_PATH=/mnt/synology-apps/PCT`** to `/opt/pct/.env`.

The NAS route is protected by a static host route (`172.30.1.94 via 172.28.95.253 dev eth0 proto static`):
another app's network (`tas-production_tas_production_network`) holds 172.30.0.0/16 on this host, and the
single-address route is what keeps the NAS reachable. Do not remove it.

### 5b. A host without that mount: a dedicated mount of `APPs/PCT`

Only `APPs/PCT` is mounted, at `/mnt/pct-nas`, read/write (after-run filing moves each export to
`succeed/` or `failed/` inside it). Nothing else on the share is reachable from PCT. Existing mounts are
not touched.

**PuTTY on 172.28.80.51:**

```bash
apt-get install -y cifs-utils smbclient
nano /etc/pct-nas.cred
```

Two lines in that file, the account from request #6:

```text
username=FILL_THE_ACCOUNT
password=FILL_THE_PASSWORD
```

```bash
chmod 600 /etc/pct-nas.cred
smbclient //172.30.1.94/APPs -A /etc/pct-nas.cred -c 'ls PCT/*' | head
mkdir -p /mnt/pct-nas
mount -t cifs //172.30.1.94/APPs/PCT /mnt/pct-nas -o rw,credentials=/etc/pct-nas.cred,uid=1001,gid=1001,dir_mode=0770,file_mode=0660,vers=3.0,iocharset=utf8,nofail
stat -f -c '%T  %n' /mnt/pct-nas
```

`stat` must print **`cifs`**. Anything else (`ext2/ext3`) means it is a local folder — stop and read the
mount error. `uid=1001` is the API container's user: without it the mount is healthy and unreadable.

Persist it (a command that appends — not an fstab line pasted into the shell):

```bash
printf '//172.30.1.94/APPs/PCT /mnt/pct-nas cifs rw,credentials=/etc/pct-nas.cred,uid=1001,gid=1001,dir_mode=0770,file_mode=0660,vers=3.0,iocharset=utf8,_netdev,nofail 0 0\n' >> /etc/fstab
mount -a && findmnt /mnt/pct-nas
findmnt -t cifs
```

`nofail` keeps the server booting if the NAS is down. The last command lists every NAS mount on the host:
the other apps' mounts must still be there, unchanged.

---

## 6. BE server (172.28.80.51)

**PuTTY on 172.28.80.51.** Build the API image from the checkout:

```bash
cd /opt/pct/src && docker build -f Backend/Dockerfile -t pct-api:production .
```

Lay out the runtime files:

```bash
cd /opt/pct
cp src/deploy/production/be.compose.yml compose.yml
cp src/deploy/production/production.env production.env
cp src/deploy/production/secrets.production.env.example secrets.production.env
chmod 600 production.env secrets.production.env
printf 'PCT_SUBNET=FILL_FROM_PREFLIGHT\n' > .env
nano .env
```

In `.env`, replace `FILL_FROM_PREFLIGHT` with the BE preflight's subnet — **`172.16.250.0/24`** on
12 Nov 2026, once infra confirms no office / VPN network uses it — and, with §5a, add a second line
`PCT_NAS_HOST_PATH=/mnt/synology-apps/PCT`.

Fill `production.env` (`nano production.env`):

| Variable | Value |
|---|---|
| `SESSION_SECRET` | output of `openssl rand -base64 48` (run it, paste) |
| `DATABASE_URL` | replace `FILL_ON_THE_SERVER` with the `pct` password from §3 — **percent-encode** `@ : / ? # [ ] & = +` or space |
| `SMTP_PASSWORD` | the `noreply.sys@energi-up.com` password |
| `OIDC_*` | leave commented until §8 |

Fill `secrets.production.env` (`nano secrets.production.env`) with the Coupa production client (request #8),
and the Data Hub keys if you have them (request #9).

Start, migrate (automatic), seed the reference data:

```bash
cd /opt/pct && docker compose -f compose.yml up -d
docker logs -f pct-api
```

Wait for `migrations applied at boot` and `listening on :3000`, then Ctrl-C. Then:

```bash
docker exec pct-api node dist/db/seed.js
docker logs pct-api 2>&1 | grep -iE 'storage|WARNING' | tail -3
curl -s -o /dev/null -w 'api %{http_code}\n' http://172.28.80.51:4100/api/v1/kpi
```

- `seed.js` must print `skipping dev admin (NODE_ENV=staging)` — production never gets the well-known
  development password.
- The start-up line must include `storage=path:/mnt/pct-nas`, with **no** `WARNING storage:` line.
- `api 401` is correct: the API is up and refusing an unauthenticated call.

**The first administrator** (prompts for the password twice, nothing is echoed). Edit the e-mail and name
before pressing Enter:

```bash
docker exec -it pct-api node dist/cli/set-password.js --email FILL_ADMIN_EMAIL --create-admin --name "FILL_FULL_NAME"
```

It creates a local account with roles admin + steward and access to all data, and is refused if the
address already exists.

---

## 7. FE server (172.28.80.50)

**PuTTY on 172.28.80.50.** Optional — the Downstream Hub SDK (usage, errors, bug reports; request #7):

```bash
cp /opt/pct/src/deploy/production/fe-build.env.example /opt/pct/fe-build.env
nano /opt/pct/fe-build.env
```

Put the production Hub's `dwsk_…` key in, or delete both lines to build without the SDK.

Build and start:

```bash
cd /opt/pct/src && docker build $(grep -sE '^[A-Z_]+=' /opt/pct/fe-build.env | sed 's/^/--build-arg /') --build-arg GIT_SHA=$(git rev-parse --short HEAD) -f Frontend/Dockerfile -t pct-web:production .
cd /opt/pct
cp src/deploy/production/fe.compose.yml compose.yml
cp src/deploy/production/nginx/production.conf production.conf
printf 'PCT_SUBNET=FILL_FROM_PREFLIGHT\n' > .env
nano .env
docker compose -f compose.yml up -d
curl -s -o /dev/null -w 'container %{http_code}\n' http://127.0.0.1:3050/
```

`.env` gets the **FE** preflight's subnet. `container 200` means the SPA is served.

**The host's front proxy.** Port 80 belongs to the nginx shared by every app on this server — never stop
it, never take its port. See what it already serves, then add PCT as one more vhost:

```bash
nginx -v && ls /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ 2>/dev/null
nginx -T 2>/dev/null | grep -E 'server_name|listen ' | sort -u | head -40
cp /opt/pct/src/deploy/production/nginx/host-vhost-pct.conf /etc/nginx/conf.d/pct.conf
nginx -t && systemctl reload nginx
```

**`nginx -t` before the reload is not optional**: a syntax error in a shared nginx takes every site on the
host down. If this host keeps vhosts in `sites-available` + `sites-enabled` instead of `conf.d`, put the
file there the same way the others are. If the preflight said port 80 is a **container**, add the server
block to that container's configuration instead and reload that container.

Verify (from a PC on the network, once DNS is in):

```bash
curl -s -o /dev/null -w 'root %{http_code}\n' http://pct.kpndomain.com/
curl -s -o /dev/null -w 'deep link %{http_code}\n' http://pct.kpndomain.com/po-analysis
curl -s -o /dev/null -w 'api %{http_code}\n' http://pct.kpndomain.com/api/v1/kpi
```

Expect `200`, `200`, `401`. The nginx welcome page instead of PCT means the request reached the host nginx
but not the vhost: check `server_name` and that `nginx -T` lists the file.

---

## 8. In the application (browser, as the first admin)

Sign in at **http://pct.kpndomain.com** with the account from §6.

1. **Admin → Data exclusions** — production starts with none. Staging's are: purchasing groups **TG4,
   TL4**; purchasing orgs **LGL1, TL04, TSE1**; intercompany vendor prefixes **LN2, IN2**. Confirm with the
   business which apply to production before setting them; they decide what every figure counts.
2. **Admin → SAP Data Upload → SAP Data Sync** — the six file rows: folder **/mnt/pct-nas** (*Use the NAS
   folder for all*), name patterns as the exports are named, up to three daily pickup times (Asia/Jakarta)
   after the SAP export job. **After a run**: on, `succeed` folder `/mnt/pct-nas/succeed`, `failed`
   folder `/mnt/pct-nas/failed`. *Test / preview folders*, then tick **Scheduled sync**, *Save schedule*.
3. **Reference lists** — upload the P Grp, P Org, Mat group and ZUSER files once (Admin → SAP Data Upload;
   one file at a time is fine).
4. **Admin → Notifications** — recipients, both SAP toggles on, **Send test email** must report `sent`.
5. **Admin → Coupa Sync** — *Sync now*: every object `ok`; then enable the schedule.
6. **Admin → FX rates** — Data Hub box: *Sync now* and check the *Fields read* line if configured.
7. **SSO (when request #7 is done)** — on the BE server, uncomment the three `OIDC_*` lines in
   `/opt/pct/production.env`, set `OIDC_CLIENT_ID`, then
   `cd /opt/pct && docker compose -f compose.yml up -d --force-recreate api`. A user arriving through the
   Hub gets the viewer role and **no data**: grant scope, department and role on the User Access page.

---

## 9. First load and acceptance

Drop the five SAP exports into `\\172.30.1.94\APPs\PCT` (or let the SAP job do it) and press **Sync now**
in SAP Data Sync — or wait for the first scheduled slot. Expect `published`, the files moved to
`succeed/`, and the email. Then:

| Check | Expect |
|---|---|
| Overview | figures; a card click opens its rows (FE → BE → DB, cookies) |
| Data Quality | **V-B08 = 0**; V-C02 lists PR items following excluded orders / PO-Deleted |
| Open Items | stage cards and the backlog table populated |
| Detail Table | search a known PO; Excel export downloads |
| Reload any page | still signed in (cookie works over the hostname) |
| Card = drill, everywhere (workstation, optional) | `npx tsx Backend/src/cli/sweep.ts --base http://pct.kpndomain.com --email` + admin e-mail + `--password` + its password → `mismatches=0 errors=0`. The password lands in shell history: clear it afterwards, or use a temporary account |

---

## 10. Every release after this one

1. Merge `sit2` → `main` by pull request (§2a).
2. **PuTTY on 172.28.80.51 (BE)** — the guarded update: it refuses if the checkout has local changes, keeps
   the previous image as `:prev`, and migrations run at start:

   ```bash
   cd /opt/pct/src && git fetch origin && if [ -z "$(git diff --stat origin/main...HEAD)" ] && [ -z "$(git status --porcelain --untracked-files=no)" ]; then docker tag pct-api:production pct-api:prev && git reset --hard origin/main && git log --oneline -1 && docker build -f Backend/Dockerfile -t pct-api:production . && docker compose -f /opt/pct/compose.yml up -d --force-recreate api; else echo 'STOP - this checkout has its own changes, check git status -sb'; fi
   ```

3. **PuTTY on 172.28.80.50 (FE):**

   ```bash
   cd /opt/pct/src && git fetch origin && if [ -z "$(git diff --stat origin/main...HEAD)" ] && [ -z "$(git status --porcelain --untracked-files=no)" ]; then docker tag pct-web:production pct-web:prev && git reset --hard origin/main && git log --oneline -1 && docker build $(grep -sE '^[A-Z_]+=' /opt/pct/fe-build.env | sed 's/^/--build-arg /') --build-arg GIT_SHA=$(git rev-parse --short HEAD) -f Frontend/Dockerfile -t pct-web:production . && docker compose -f /opt/pct/compose.yml up -d --force-recreate web; else echo 'STOP - this checkout has its own changes, check git status -sb'; fi
   ```

4. Browser: Ctrl+Shift+R. If the release changes how data is loaded, **Rebuild** in SAP Data Sync.
5. If the release changed a file under `deploy/production/`, compare it with the copy in `/opt/pct`
   (`diff /opt/pct/src/deploy/production/be.compose.yml /opt/pct/compose.yml`) and carry the change over by
   hand — never overwrite the filled `production.env` or `secrets.production.env`.

`--force-recreate` is required: Compose compares the image *name*, not its contents, so a plain `up -d`
after a rebuild keeps the old code running. `docker compose --build` does nothing here (these compose files
have no build context).

## 11. Rollback

**On the affected server:**

```bash
docker tag pct-api:prev pct-api:production && docker compose -f /opt/pct/compose.yml up -d --force-recreate api
```

(FE: `pct-web:prev` → `pct-web:production`, service `web`.) Migrations are additive and dataset versions
immutable, so the database is never rolled back; the previous code reads the newer schema.

## 12. Going to HTTPS (a go-live item, not optional for long)

Over HTTP, passwords and session cookies cross the network in clear text. When a certificate for
`pct.kpndomain.com` exists:

1. FE host nginx: a `listen 443 ssl;` server with the certificate (same `location /` as
   `host-vhost-pct.conf`), and the port-80 server returning `301` to https.
2. `production.env`: `APP_BASE_URL=https://pct.kpndomain.com`, `SESSION_COOKIE_SECURE=true`,
   `NODE_ENV=production`, and **`LOCAL_AUTH_ENABLED=false`** — production mode refuses local sign-in
   without MFA, which PCT does not implement, so sign-in becomes **Hub SSO only**. Make sure at least one
   SSO account holds the admin role **before** this switch (User Access page), or no one can administer.
3. The Hub: change the redirect URI to `https://pct.kpndomain.com/auth/oidc/callback` and update
   `OIDC_REDIRECT_URI`.
4. `docker compose -f compose.yml up -d --force-recreate api` (BE), and rebuild the FE only if the SDK URL
   changes.

## 13. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `required variable PCT_SUBNET is missing` | `/opt/pct/.env` missing | §6 / §7 |
| `Pool overlaps with other one on this address space` | the chosen subnet is taken now | run the preflight again, take the new suggestion |
| `bind: address already in use` on 4100 / 3050 | another app took the port | preflight prints a free one; set `PCT_API_BIND` / `PCT_WEB_BIND` and the matching nginx port |
| `WARNING storage: /mnt/pct-nas is on the container's own filesystem` | the host mount is missing | `findmnt /mnt/pct-nas`, `mount -a`, recreate `api` |
| NAS `ls` says *Host is down*, `findmnt` still shows it | stale CIFS after a network change | `umount -l /mnt/pct-nas; mount -a` |
| Sign-in succeeds, then back to the login page | `Host` not forwarded, or `APP_BASE_URL` wrong | both nginx configs forward `Host $host`; check `production.env` |
| Upload fails with 413 | a proxy's body limit | `client_max_body_size 210m` in BOTH nginx configs |
| API exits at start with `DATABASE_URL` / connection error | whitelist, password encoding | request #5; percent-encode the password |
| `SESSION_COOKIE_SECURE: must be true in production` | `NODE_ENV=production` over HTTP | keep `NODE_ENV=staging` until §12 |
| `seed.js` prints `dev admin created` | `NODE_ENV=development` set by mistake | set `staging`, delete that account on the User Access page |

## 14. Never on these shared hosts

- Stop, restart or reconfigure the host nginx beyond adding `pct.conf` (and `nginx -t` first).
- `systemctl restart docker`, edit `daemon.json`, `docker network prune`, `docker system prune`, or remove
  another app's network or container.
- Unmount, remount or edit another app's NAS mount or fstab line.
- Publish PCT on `0.0.0.0`, on 80/443, or on any port the preflight did not confirm free.
- Commit a filled `production.env`, `secrets.production.env`, `/etc/pct-nas.cred` or any password.
