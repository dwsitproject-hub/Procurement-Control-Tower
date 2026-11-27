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
| Address | **http://pct.kpndomain.com** (live 16 Nov 2026, §7b); http://172.28.80.50:3050 still answers. HTTP for now — see §12 |
| FE server | **172.28.80.50** — container `pct-web`, published on the private IP **172.28.80.50:3050**; later also reached through the host's nginx on :80 |
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
| FE 172.28.80.50 | 2001, 3001, 3002, 3010, 3020, 3040, 3042, 3070, 3080, 3081, 3100, 3160, 8000, 8080, 8081, 8090, 8443, 9999 (+ the host nginx on 80 and 443) | **3050**, on the private IP 172.28.80.50 only — the same port as staging. Confirmed free by the preflight, 12 Nov 2026 |
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
| 1 | Infra (DNS) | A record **pct.kpndomain.com → 172.28.80.50** on the internal resolver — *requested; until then PCT is used by IP* | §7b |
| 1b | Infra (network) | **Users' office / VPN networks → 172.28.80.50 TCP 3050** (access by IP) | §7 |
| 2 | Infra (network) | **172.28.80.50 → 172.28.80.51 TCP 4100** (FE nginx to API) | §7 |
| 3 | Infra (network) | **172.28.80.51 → 172.30.1.94 TCP 445** (BE to the NAS) | §5 |
| 4 | Infra (network) | **172.28.80.51 → outbound 443** to `kpn.coupahost.com`, `dwshub.kpndomain.com`, the Data Hub; **465** to `mail.energi-up.com`; **22** to `github.com` (both servers) | §2, §6 |
| 5 | DBA / RDS console | Add **172.28.80.51** to the RDS instance's **whitelist**; create account **`pct`** (standard) and database **`pct`** owned by it | §3 |
| 6 | NAS owner | Folder **`APPs/PCT`** (uppercase, at the share ROOT — not under `dev`), and an SMB account with **read/write on that folder only** | §5 |
| 7 | Hub admin (optional) | Register PCT in the **production** Hub: application address `http://172.28.80.50:3050`, redirect URI **`http://172.28.80.50:3050/auth/oidc/callback`**, public client / PKCE → `client_id`; and the SDK key (`dwsk_…`). Both addresses change to the hostname in §7b | §8 |
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
   GRANT CONNECT, CREATE, TEMPORARY ON DATABASE pct TO pct;
   CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public;
   CREATE EXTENSION IF NOT EXISTS pg_trgm  SCHEMA public;
   CREATE EXTENSION IF NOT EXISTS citext   SCHEMA public;
   GRANT USAGE ON SCHEMA public TO pct;
   SELECT current_database() AS db, has_database_privilege('pct', 'pct', 'CREATE') AS pct_can_create;
   SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1;
   ```

   Expect `db = pct`, `pct_can_create = true`, and all three extensions in **`public`**. Learned on
   12 Nov 2026: a database created in the console can be owned by the privileged account, so the first
   migration fails with *permission denied for database pct* (the `GRANT`); and without `SCHEMA public` an
   extension can land in a schema named after the privileged account, giving *type "citext" does not
   exist* (fix: `ALTER EXTENSION citext SET SCHEMA public;`, same for the other two).

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
cd /opt/pct/src && docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) --build-arg BUILT_AT=$(date -u +%FT%TZ) -f Backend/Dockerfile -t pct-api:production .
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
curl -s -o /dev/null -w 'container %{http_code}\n' http://172.28.80.50:3050/
```

`.env` gets the **FE** preflight's subnet (`172.16.250.0/24` on 12 Nov 2026). Then, still on the FE server:

```bash
curl -s -o /dev/null -w 'root %{http_code}\n' http://172.28.80.50:3050/
curl -s -o /dev/null -w 'deep link %{http_code}\n' http://172.28.80.50:3050/po-analysis
curl -s -o /dev/null -w 'api %{http_code}\n' http://172.28.80.50:3050/api/v1/kpi
```

Expect `200`, `200`, `401` - the SPA is served and the API answers through it (the 401 is correct: no
session). Open **http://172.28.80.50:3050** in a browser on the office network or VPN; if it times out
there while the server's own `curl` works, it is request #1b (the security group).

**Until the domain is ready, PCT is used by IP.** Nothing is added to the host nginx yet, and
`APP_BASE_URL` in `/opt/pct/production.env` stays `http://172.28.80.50:3050` (the cookie and any absolute
link follow it).

### 7b. When pct.kpndomain.com is ready

Once the A record resolves to 172.28.80.50 for the users, add the hostname in front of the same container -
no container is rebuilt or rebound.

**PuTTY on 172.28.80.50 (FE).** Port 80 belongs to the nginx shared by every app on this server — never stop
it, never take its port. See what it already serves, then add PCT as one more vhost:

```bash
nginx -v && ls /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ 2>/dev/null
nginx -T 2>/dev/null | grep -E 'server_name|listen ' | sort -u | head -40
cp /opt/pct/src/deploy/production/nginx/host-vhost-pct.conf /etc/nginx/conf.d/pct.conf
nginx -t && systemctl reload nginx
```

**`nginx -t` before the reload is not optional**: a syntax error in a shared nginx takes every site on the
host down. If this host keeps vhosts in `sites-available` + `sites-enabled` instead of `conf.d`, put the
file there the same way the others are.

**PuTTY on 172.28.80.51 (BE)** — tell the API its new address:

```bash
cd /opt/pct && sed -i 's|^APP_BASE_URL=.*|APP_BASE_URL=http://pct.kpndomain.com|' production.env && grep '^APP_BASE_URL' production.env
docker compose -f compose.yml up -d --force-recreate api
```

Verify from a PC on the network:

```bash
curl -s -o /dev/null -w 'root %{http_code}\n' http://pct.kpndomain.com/
curl -s -o /dev/null -w 'api %{http_code}\n' http://pct.kpndomain.com/api/v1/kpi
```

Expect `200`, `401`. Everyone signs in once more (cookies were issued for the IP address).

**SSO and the Hub SDK** (registered by IP in §8): in the production Hub, **Admin → Applications → Procurement
Control Tower**, change the application address to `http://pct.kpndomain.com` and the redirect URI to
`http://pct.kpndomain.com/auth/oidc/callback` (add the new one before removing the IP one, if the Hub allows
two, so nobody is locked out in between). Then on the BE server:

```bash
cd /opt/pct && sed -i 's|^OIDC_REDIRECT_URI=.*|OIDC_REDIRECT_URI=http://pct.kpndomain.com/auth/oidc/callback|' production.env && grep '^OIDC_REDIRECT_URI' production.env
docker compose -f compose.yml up -d --force-recreate api
```

Sign in through the Hub once to confirm. Until both sides match, Hub sign-in fails with a redirect-URI
error while local sign-in keeps working. The IP address keeps working for local sign-in; SSO follows the
one registered redirect URI.

---

## 8. In the application (browser, as the first admin)

Sign in at **http://172.28.80.50:3050** (or the hostname, after §7b) with the account from §6.

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
7. **SSO (when request #7 is done)** — registered by IP for now (§7b moves it to the hostname). First
   check the BE server reaches the production Hub:
   `curl -s -o /dev/null -w '%{http_code}\n' https://dwshub.kpndomain.com/api/sso/.well-known/openid-configuration`
   (expect `200`). Then uncomment the three `OIDC_*` lines in `/opt/pct/production.env`, set
   `OIDC_CLIENT_ID` from the Hub, keep `OIDC_REDIRECT_URI=http://172.28.80.50:3050/auth/oidc/callback`
   (it must equal the Hub's redirect URI character for character), then
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
| Card = drill, everywhere (workstation, optional) | `npx tsx Backend/src/cli/sweep.ts --base http://172.28.80.50:3050 --email` + admin e-mail + `--password` + its password → `mismatches=0 errors=0`. The password lands in shell history: clear it afterwards, or use a temporary account |

---

## 10. Every release after this one

1. Merge `sit2` → `main` by pull request (§2a).
2. **PuTTY on 172.28.80.51 (BE)** — the guarded update: it refuses if the checkout has local changes, keeps
   the previous image as `:prev`, and migrations run at start:

   ```bash
   cd /opt/pct/src && git fetch origin && if [ -z "$(git diff --stat origin/main...HEAD)" ] && [ -z "$(git status --porcelain --untracked-files=no)" ]; then docker tag pct-api:production pct-api:prev && git reset --hard origin/main && git log --oneline -1 && docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) --build-arg BUILT_AT=$(date -u +%FT%TZ) -f Backend/Dockerfile -t pct-api:production . && docker compose -f /opt/pct/compose.yml up -d --force-recreate api; else echo 'STOP - this checkout has its own changes, check git status -sb'; fi
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

### 10a. Release of 13 Nov 2026 — security and review fixes

On top of the usual §10 steps, this release changes two files that live in `/opt/pct` on the servers:

**PuTTY on 172.28.80.50 (FE)** — the nginx config now forwards `X-Forwarded-Host` (the API uses it to refuse
cross-site writes) and a request id on `/auth/`:

```bash
cd /opt/pct && cp production.conf production.conf.bak && cp src/deploy/production/nginx/production.conf production.conf && docker compose -f compose.yml up -d --force-recreate web
```

**PuTTY on 172.28.80.51 (BE)** — the compose file gained log rotation. Compare first, then carry it over
(`.env` and the env files are untouched):

```bash
cd /opt/pct && diff src/deploy/production/be.compose.yml compose.yml; cp compose.yml compose.yml.bak && cp src/deploy/production/be.compose.yml compose.yml && docker compose -f compose.yml up -d --force-recreate api redis
```

The FE compose (`fe.compose.yml`) gained the same log rotation; copy it the same way on the FE server when
convenient. After the API is up, `curl -s http://172.28.80.51:4100/api/v1/health` shows the git SHA of the
build, and `/api/v1/ready` reports `storage` and `session_store` as well as the database.

**In the application:** Admin → SAP Data Sync → **Rebuild** once (figures are recomputed with the SAP FX
rates only — functional test FT-05). Audit entries written from now on use hash version 2; `/api/v1/audit/verify`
reports the older entries as `legacyEntries`.

### 10b. Release of 13 Nov 2026 (later the same day) — speed, image size, staging cleanup

The usual §10 BE and FE updates. Nothing to copy by hand. What changes:

- **Faster pages.** Computed charts, KPIs and summaries are cached per dataset version and pre-computed
  after every publish and at start-up (the log shows `cache warm: version N, 61 views ready in … s`).
  PO Analysis went from ~13 s to ~1.5 s locally on first load; Material Group from 3.6 s to 0.2 s.
- **Smaller API image** (488 MB → 370 MB): the runtime holds only the API's production dependencies.
- **Staging retention (migration 044).** After every publish, `core.prune_staging(14)` removes the staged
  source rows of batches that never became a dataset version and are over 14 days old, and marks runs stuck
  "in progress" for over a day as failed. Rows of every existing version are kept.

**One-off: reclaim the space now (optional, BE server, a quiet moment).** The database copied from staging
carries those orphan rows; the first publish after this release deletes them, or run it now. Deleting frees
the space for reuse inside the database; `VACUUM FULL` returns it to ApsaraDB's disk but locks
`staging.raw_row` while it rewrites it (27 s locally for 3.2 GB → 0.5 GB) — a pickup in that window waits.

```bash
export DBURL="$(grep '^DATABASE_URL=' /opt/pct/production.env | cut -d= -f2-)"
docker run --rm -i -e DBURL postgres:18 sh -c 'psql "$DBURL"' <<'SQL'
SELECT pg_size_pretty(pg_total_relation_size('staging.raw_row')) AS before;
SELECT * FROM core.prune_staging(14);
VACUUM (FULL, ANALYZE) staging.raw_row;
SELECT pg_size_pretty(pg_total_relation_size('staging.raw_row')) AS after;
SQL
unset DBURL
```

### 10c. Release of 19 Nov 2026 — Local / Import, sourcing comparison, page enhancements

The usual §10 BE and FE updates; nothing to copy by hand. **Migration 046** runs at API start. It adds the
Coupa quote-line table, the paid-PO view and the vendor-type lookup, and backfills a vendor type for every
stored supplier response (about 30 s on the staging-sized Coupa store; production's is smaller). Then:

- **Admin → SAP Data Sync → Rebuild** once. The Delivery cards' Local / Import chips and the new PR-to-PO
  price-variance basis live in the precomputed figures; until the rebuild only a filtered view shows them.
- **Sourcing comparison** needs no backfill: each older event fetches its quote lines from Coupa the first
  time someone opens it, then keeps them; the Coupa sync stores them for every new response. This needs
  production's Coupa sync to be running (on 19 Nov its last run was 12 Nov - see Admin → Coupa).
- **Open Items "PO not delivered — paid / DP"** counts POs with a payment or down payment in **Coupa**
  (the SAP exports carry no payment field). Expect it near 0 even with the sync running: Coupa invoices
  follow goods receipt, and SAP down payments are not in Coupa (checked 19 Nov against the full Coupa store).

What changed for users: Vendor Type filter (Local = vendor code LN…, Import = IN…) on the Material Group
popups and the Sourcing page; quantity in the popup chart hover; Sourcing event pipeline and supplier
comparison; Master → SAP Users filters; Purchasing Organization column in drill tables; the PO-not-delivered
split; PR-to-PO price variance without token PR prices (≤ 1) or free PO lines (0); Local / Import on the five
Delivery cards.

### 10d. Release of 19 Nov 2026 (later the same day) — Coupa scoped to this dashboard's business units

The usual §10 BE and FE updates. **Migration 047** runs at API start (seconds). Coupa is shared with
business units outside the Procurement Control Tower — Upstream's 11…/12…-series POs and their sourcing
events, plus other sites the SAP files never mention. 047 adds a **Coupa plant** exclusion and seeds it with
the 27 plant groups that have no plant in the SAP files (AC AM BU HS IU KB SI SN TS WS, AJ BS GN IP KU NJ PN
PT WW, CR JJ TH, CM PD SA SU, JN). The seed is skipped where an admin has already saved a list.

- No Rebuild needed: the rule is applied by the Coupa views and is live at once. SAP figures do not move.
- Check **Admin → Data Exclusions → Coupa plants**: 27 ticked, each marked *not in SAP files*. Tick or
  untick a site and Save to change the scope; it applies immediately.
- Expect the Coupa figures to drop to the in-scope sites: on the 19 Nov store, sourcing events 23,041 →
  8,003, Coupa PO lines 52,733 → 15,188, invoices 236 → 51.

### 10e. Release of 20 Nov 2026 — purchasing-desk drills

The usual §10 BE and FE updates; no migration. Then **Admin → SAP Data Sync → Rebuild** once: the four desk
figures store their drill in the precomputed KPIs, so until the rebuild an unfiltered page still opens the
old PO-line list (a filtered page shows the new one at once).

What changed for users: on the Executive Summary's "purchasing desks" page, Active purchasing desks, Desks
holding 80% of value and the two Head Office shares open one row per purchasing group - code, name, number
of POs, PO lines, PO amount (IDR and USD), share and cumulative share. The 80% drill lists exactly the desks
counted; the Head Office drills list the desks behind the HQ part. Every PO-line drill (including the three
purchasing-group / purchasing-org charts) gains Purchasing Group and Purchasing Group Name columns.

### 10f. Release of 20 Nov 2026 (later) — SAP user organisations editable; click-through fixes

The usual §10 BE and FE updates. **Migration 048** runs at API start (instant): the business file's
user → organisation rows move to `core.dim_user_purch_org_file`, admin edits go to
`core.dim_user_org_manual`, and `core.dim_user_purch_org` becomes a view of the two (same columns, so
nothing that reads it changes). No Rebuild is needed for this release; an HO/Unit edit reaches the
precomputed "Manage by HO or Site" figures at the next Rebuild, filtered pages at once.

What changed for users:
- **Master → SAP Users → Edit**: Purchasing Organization (several, searchable) and HO/Unit are editable.
  HO/Unit needs at least one organisation. Revert hands the user back to the business file.
- **Executive Summary**: a Delivered / Not-yet-delivered figure (category bars, size bands, every Monthly
  Spend cell and total) opens its Overview on THAT state instead of All, so the first card equals the
  figure clicked (it was wrong for 190 of 254 figures on the 2026 page). The toggle still widens it.
  PR Outstanding segments open their own requisitions instead of the unsliced Overview.
- **Material 360** opened from Vendor 360, Material Group or Category 360 follows the page's filter bar,
  as the vendor and category popups already did.
- **Every PO-line drill popup**: the "Σ … B IDR" header now adds up every line in rupiah at the dataset
  rate, the basis of every IDR card and chart. It counted IDR-currency lines only, so 72 of 195 money
  figures on the 2026 pages opened a smaller total (Total PO Amount IDR 2,432 B, header 1,442 B). Drills
  behind Open PO Commitment, commitment aging and GR/IR add up what is still to deliver / still to
  invoice, with those two columns added, instead of the full line value.

### 10g. Production rollout of 10c–10f together (20 Nov 2026, `df81309`)

Production went from `8dc39d6`/`9ca6c0d` straight to `df81309`, so migrations 046, 047 and 048 run in one
start. Production connects as its own `pct` account, not a superuser: 046–048 replace existing views and
rename `core.dim_user_purch_org`, which only the OWNER may do. Before the §10 update, check it read-only
from the running API:

**PuTTY on 172.28.80.51 (BE):**

```bash
docker exec pct-api node -e 'const {Client}=require("pg");const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query("select current_user as me, n.nspname||chr(46)||c.relname as obj, pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname||chr(46)||c.relname = any($1) order by 2",[["core.dim_user_purch_org","ops.coupa_supplier_response","ops.v_coupa_supplier_response","ops.v_coupa_po_line","ops.v_coupa_sourcing_event","ops.v_coupa_invoice"]])).then(r=>{console.table(r.rows);return c.end()}).catch(e=>{console.error(e.message);process.exit(1)})'
```

Expect six rows, every `me` and `owner` = `pct`. Any other owner: stop - the privileged account must
`ALTER TABLE/VIEW … OWNER TO pct` in DMS first, or the API will fail its migrations at start (the §11
rollback brings the old image back either way).

After the update: **Rebuild** once (10c, 10e), and the Coupa sync must be running (10c).

### 10h. Release of 21 Nov 2026 — PR Analysis cards

The usual §10 BE and FE updates; no migration. Then **Rebuild** once: Max PR Approval and Oldest Unreleased
store their drill in the precomputed KPIs, so until then an unfiltered page still opens the old lists.

What changed for users (PR Analysis):
- Avg PR Approval, Median PR Approval, PR Approval Lead Time (median) and Avg PR Line Value are one card,
  "PR Approval & Value", which is not clickable. The same figures elsewhere (Approvals, Executive Summary)
  are unchanged.
- **Max PR Approval** and **Oldest Unreleased (d)** no longer show "n = …"; a click lists only the PR items
  AT that maximum (computed inside the same filters), with the days as the first column.

### 10i. Release of 21 Nov 2026 — Sourcing page click-through

The usual §10 BE and FE updates; no migration, no Rebuild (the Sourcing page reads the live Coupa store).

What changed for users (Sourcing):
- Planned savings (IDR) is gone. Event cycle (median) and Avg bids per event are one card, "Event cycle &
  bids", with events-with-bids as a third line; a cycle under a day shows in hours or minutes.
- Every other figure opens its rows in the Sourcing data table's columns: the cards, each month bar, each
  commodity and supplier row, each pipeline stage and each funnel step. Event figures list events (with the
  awarded supplier and amount); bid figures list bids. The popup's count is the figure's count, Vendor Type
  filter included (76 figures checked on 21 Nov, 0 mismatches).
- Later the same day: "Event cycle & bids" is not clickable. **"SAP PR" is now "PR No"** and is resolved:
  the old column showed Coupa's free-text sourcing-ref (0 real PRs). PR No comes from the event's Coupa
  requisition → its Coupa PO lines → SAP PR, else a 10-digit number in the description from an SAP PR
  series (PR and PO series never share their first four digits). 94.5% of events have one (was 0%). The
  rest need Coupa requisitions, which the integration user may not read (HTTP 403 - a Coupa admin can add
  the requisition read scope).

### 10j. Release of 21 Nov 2026 — shared page layouts; flow chart numbers

The usual §10 BE and FE updates. **Migration 049** runs at API start (instant): `app.ui_layout`, one layout
per page. No Rebuild.

What changed for users:
- **Edit layout** is shown to Admins only, and what an Admin arranges is what every user sees (the same rule
  as Edit Titles). Pages open on their built-in arrangement until an Admin edits them; personal layouts and
  the personal "View" picker are no longer used (nothing is deleted).
- PR Analysis, "Requisition flow by month — in against out": a **Show numbers** switch, off by default,
  prints each segment's count (raised above, became-PO below, brought-forward bands inside).

### 10k. Release of 21 Nov 2026 — PO Analysis cards, price variance, readable chart numbers

The usual §10 BE and FE updates; no migration. Then **Rebuild** once: PR to PO Price Variance is
precomputed, so an unfiltered page keeps the old figure until then.

What changed for users:
- PO Analysis: Avg Sourcing LT, Avg PO Approval and Avg PO Value (IDR) are one card, "Sourcing, Approval &
  PO Value", not clickable.
- **PR to PO Price Variance** now compares IDR lines only and leaves out unit mismatches (a PO price 10x or
  more above, or a tenth or less of, the PR estimate - per-1,000 vs per-unit pricing). With the token-price
  and free-line rules already there, it reads 8.4% for 2026 locally (was 194,584%); the drill opens the same
  lines.
- Chart numbers never print over each other: a label is horizontal when it fits its bar, upright when it
  does not, inside the bar when there is no room above, and skipped (tooltip only) when it would still
  touch another. Doughnut slices show the value where it fits the slice, else the percentage.

### 10l. Release of 21 Nov 2026 — Delivery page

The usual §10 BE and FE updates; no migration. Then **Rebuild** once: the Delivery cards store their drill
(now with the delivery columns) in the precomputed KPIs.

What changed for users (Delivery):
- Avg Delivery LT and End to end (median) are one card, "Delivery Lead Time", not clickable, each line
  with its Local / Import value.
- Delivered (GR) shows its Local / Import split on its own line (it was clamped out of the subtitle).
- A **Vendor Type** filter (Local = LN…, Import = IN…) on the page: every card, chart and drill follows it;
  it applies to this page only. Vendor Type is a filter dimension server-side (orders directly, requisitions
  through their orders, goods receipts through their order line); the sweep under vendorType=local found 0
  mismatches over 79 KPIs and 1,554 chart points.
- Every Delivery drill shows Vendor Type, Planned delivery, GR vs plan (d), PO release → GR (d) and
  PR → GR (d) beside the usual columns.

### 10m. Release of 21 Nov 2026 — Invoicing & Payment click-through and PO numbers

The usual §10 BE and FE updates; no migration, no Rebuild (the page reads the live Coupa store).

What changed for users (Invoicing & Payment):
- Every card, both month charts, every supplier figure and every status row opens the invoices or
  payments it counts (counts and IDR amounts equal the figure - 39 figures checked, 0 mismatches).
- Every invoice row - in those popups and in the Recent invoices / Recent payments tables - shows its
  **PO No**: the SAP PO number(s) its lines were posted against, with Coupa's PO number beside it.
- Clicking an invoice opens it line by line: SAP PO and item, Coupa PO, item, description, quantity, price,
  total, match status, and the payments recorded on it.

### 10n. Release of 23 Nov 2026 — Invoicing & Payment: payment aging

The usual §10 BE and FE updates; no migration, no Rebuild.

What changed for users (Invoicing & Payment):
- **Payment aging** everywhere an invoice is listed: due date (invoice date + the payment term's days -
  I30, D30, D60, I90… - the invoice carries no due date of its own), age in days, days overdue (open) or
  days paid late (paid), and an aging bucket. Payments show days to pay and days paid late.
- A new **Open payables aging** panel: open invoices by days past due (not yet due, 1-30, 31-60, 61-90,
  91-180, >180, no term), each bucket clickable; the buckets add up to the Open card.
- "Avg days to pay" is no longer clickable; every other figure still opens its invoices or payments.

### 10o. Release of 23 Nov 2026 — Approvals fixes and chart; Invoicing layout and currency

The usual §10 BE and FE updates; no migration. **Then Rebuild** (Admin → Rebuild): the Approvals drills
and the new chart are precomputed in the mart, so until a Rebuild the old drills (and no chart bars) show.

What changed for users:
- **Approvals:**
  - "Avg PR approval", "Avg PO approval" and "Oldest unreleased PR" are now one card, "Approval Cycle",
    which is not clickable.
  - **Every approval-queue figure counts LINES**, like the PR card always did. **PO lines pending
    approval** (was "POs pending approval") now counts PO lines, the same lines its popup lists.
    Before, the card counted POs but the popup listed lines (91 vs 254 on staging). "PRs pending
    approval" is renamed **PR lines pending approval**. Both popups gain a **Waiting on** column (the
    approver of the first open release step); the PO popup also shows Created in (SAP or
    Coupa → SAP) and Coupa PO.
  - **PR lines pending approval by approver** counts each pending PR line once, at its current
    approver. Before, it counted open release steps: a line waiting on three approvers counted three
    times, so the bars added up to more than the card.
  - **Approved within 3d %** opens only the PR items approved within 3 days (the numerator), with a
    "PR approval (days)" column. Before, it opened every approved item. The days-since-PR "Aging"
    column is gone from this popup, because it read as an approval time.
  - New chart **PO lines pending approval by approver**: pending PO lines by the approver whose SAP
    release step is open, split into Created in SAP vs Created in Coupa → SAP. Coupa has no PO
    approval queue, so every PO approval waits in SAP. Each bar opens its lines.
- **Invoicing & Payment:**
  - The layout is configurable like the other pages: Admin only, and shared by every user.
  - Every amount follows the IDR / USD switch, each invoice or payment converted at its own month's
    rate. Invoices with no rate for their month are counted but left out of the amount, marked ⚠.
- **Governance page removed:** gone from the menu and from the Admin page-access matrix. An old
  `/governance` link opens the Executive Summary. Stored Governance grants are ignored, with no data
  change. Its figures are still computed, and those used elsewhere (Retro POs on Approvals, the
  Executive Summary cards) are unchanged.

### 10p. Production rollout of 10h–10o together (24 Nov 2026, `acd62eb`)

`main` is fast-forwarded to `sit2` at `acd62eb`. One migration, **049** (`app.ui_layout`, the shared page
layouts). It only creates a table in schema `app`, where 039 already created `app.ui_label` on production,
so the `pct` account can create there. Check it read-only from the running API before the update:

**PuTTY on 172.28.80.51 (BE):**

```bash
docker exec pct-api node -e 'const {Client}=require("pg");const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query("select current_user as me, has_schema_privilege($1,$2) as can_create, to_regclass($3) as already",["app","CREATE","app.ui_layout"])).then(r=>{console.table(r.rows);return c.end()}).catch(e=>{console.error(e.message);process.exit(1)})'
```

Expect `me` = `pct`, `can_create` = `true`, `already` = `null`. If `can_create` is false, stop: the
privileged account must `GRANT CREATE ON SCHEMA app TO pct` in DMS first.

Then the usual §10 steps 2-4 (BE, then FE). No new environment variables, and no files under
`deploy/production/` changed.

After the update:
- **Rebuild** once (Admin → SAP Data Sync → Rebuild). 10h, 10k, 10l and 10o store their drills and
  the new Approvals chart in the mart.
- **Page layouts** (10j): every user now sees one shared layout per page, which only an Admin arranges.
  Layouts users arranged for themselves are no longer read (they are kept, not deleted). Until an
  Admin arranges a page, it shows the built-in layout.
- The Governance page is gone from the menu (10o).

### 10q. Release of 24 Nov 2026 — performance: every page, figure and popup under 2 seconds

The usual §10 BE update; **no FE change, no Rebuild**. One migration, **050**, which replaces three Coupa
views (`ops.v_coupa_invoice`, `ops.v_coupa_invoice_line`, `ops.v_coupa_receipt`) with faster
equivalents that return the same rows. Replacing a view needs its OWNER, so check it read-only from the
running API before the update:

**PuTTY on 172.28.80.51 (BE):**

```bash
docker exec pct-api node -e 'const {Client}=require("pg");const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query("select current_user as me, n.nspname||chr(46)||c.relname as obj, pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname||chr(46)||c.relname = any($1) order by 2",[["ops.v_coupa_invoice","ops.v_coupa_invoice_line","ops.v_coupa_receipt"]])).then(r=>{console.table(r.rows);return c.end()}).catch(e=>{console.error(e.message);process.exit(1)})'
```

Expect three rows, with every `me` and `owner` = `pct`. Any other owner: stop. The privileged account must
`ALTER VIEW … OWNER TO pct` in DMS first, or the API fails migration 050 at start (§11 brings the old image
back).

What changed (measured locally on the reference data; production on ApsaraDB should gain at least as much):

| Where | Before | After |
|---|---|---|
| Popups from the PR flow and PO bracket charts | 4–10 s | under 0.7 s |
| Any page after a filter change not seen before (e.g. Vendor Type) | 1.8–8.7 s | under 1.5 s |
| Invoicing & Payment page / its popups | 5.5 s / 1.2–2.8 s | 0.1 s / under 0.5 s |
| Sourcing page | 3 s | 0.1 s (cached) |
| Open Items / Detail Table | 2.2–3 s | 0.3–1.2 s |
| Cache warm-up after an API start | 31 s | 14 s |

- **JIT off on every database session.** Postgres compiled each analytic query with LLVM before
  running it: 3.3 s of compile for a 0.4 s query.
- **Filtered cards:** a page now computes only its own cards (not all ~80), in parallel, each cached on
  its own, and a chart's series run in parallel. The PR flow chart computes its shared base once for all
  ten series.
- **Detail table:** the count, rows and 11 filter lists run together, and the count and filter lists
  are cached.
- **Coupa pages:** their queries run together and are cached until the next Coupa sync, FX change or
  dataset version. Migration 050 stops the three views from re-evaluating every Coupa order line on each
  read: invoices 1,490 ms → 18 ms.
- No figure changes. Old and new code gave byte-identical results for every card and live chart under
  four filters, and the views returned the same rows. The drill sweep and the invoice checks pass.

### 10r. Release of 25 Nov 2026 — SAP down payments ("DP All" export)

The usual §10 BE and FE updates; **no Rebuild**. One migration, **051**:
- **New feed id:** adds the feed id `dp` to two CHECK constraints (`app.template_version`,
  `ingest.batch_file`).
- **New store:** creates the per-version store `ops.sap_dp_line` and the view `ops.v_sap_dp_line`.
- **Replaced views:** replaces `ops.v_coupa_invoice` (050's) and `ops.v_coupa_paid_sap_po` (046's), so a
  Coupa invoice that IS an SAP DP is counted once.

All of that needs the `pct` account to own those objects and to create in `ops`. Check it read-only
before the update:

**PuTTY on 172.28.80.51 (BE):**

```bash
docker exec pct-api node -e 'const {Client}=require("pg");const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query("select current_user as me, n.nspname||chr(46)||c.relname as obj, pg_get_userbyid(c.relowner) as owner, has_schema_privilege($2,$3) as can_create_in_ops from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname||chr(46)||c.relname = any($1) order by 2",[["app.template_version","ingest.batch_file","core.dataset_version","ops.v_coupa_invoice","ops.v_coupa_paid_sap_po"],"ops","CREATE"])).then(r=>{console.table(r.rows);return c.end()}).catch(e=>{console.error(e.message);process.exit(1)})'
```

Expect five rows, every `me` and `owner` = `pct`, and `can_create_in_ops` = `true`. Anything else: stop.
The privileged account must `ALTER TABLE/VIEW … OWNER TO pct` (or `GRANT CREATE ON SCHEMA ops TO pct`)
in DMS first.

**Loading the file:** put the SAP "DP All" export (`DP All*.XLSX`) in the SAP folder with the PR/PO
files. Every scheduled pickup reads it, and its folder defaults to the PR Report's. Or upload it in
Admin → SAP Data Upload; tick "Publish immediately", or confirm the batch afterwards. Until a DP file is
loaded, the Invoicing page's DP section says so and Open Items is unchanged.

How the data is read (user rule, 25 Nov 2026):
- **Clearing Date empty** = the DP is **outstanding**. **Filled** = settled against the final invoice:
  the PO is **fully paid**. The amount is the DP amount; the final balance payment is not in this
  file.
- **Per dataset version**, like the facts: a batch awaiting confirmation, a rejected one or a rollback
  never changes the published figures. A new file replaces, per company code, the rows inside the
  posting-date range it covers and keeps the rest. A batch without a DP file carries the last snapshot
  forward.
- **PCT scope:**
  - POs excluded by PCT rules (purchasing org PRO3 / OPS3 / PRO2 / HRG1 / LGL1, held, deleted) and
    intercompany vendors (`exclusions.interco_vendor_prefixes`) are left out.
  - So are rows with no PO, such as insurance premiums or a tax DP.
  - A "TEMP" PO placeholder takes the real PO from Assignment.
- **No double counting:** a Coupa invoice whose number is an SAP DP document number on the same PO is
  counted once, as the SAP DP. On the 23 Nov file that was 1 invoice (IDR 346,875), so Coupa invoices
  dropped from 51 to 50 locally.

What changed for users:
- **Invoicing & Payment**, a new SAP DP section, movable and hideable like the rest:
  - Cards: SAP DP outstanding (net of the deductions taken so far), POs with DP outstanding, SAP DP
    settled, POs fully paid.
  - Panels: outstanding DP by age of the advance, DP posted by month, largest outstanding DPs by PO.
  - Every figure opens its line items.
  - POs whose file holds only deductions are shown apart, because their DP was posted before the file's
    range (the 23 Nov export starts 2 Jan 2026).
- **Open Items:** "PO not delivered — paid / DP" now counts SAP down payments as well as Coupa payments.
  Locally it went from 0 to 102 lines on 36 POs.

Worth asking SAP for (it improves the figures, nothing breaks without it):
- Add the **Fiscal Year, Line item and Clearing Document** columns, so every row is uniquely identified
  and a settled DP ties to its clearing.
- **Include every open DP item whatever its posting date**, so the deductions-only POs get their DP.

### 10s. Release of 26 Nov 2026 — fix for the 25 Nov API wedge

**What happened (25 Nov 2026).** About 60 seconds after every start, `pct-api` stopped answering. It
held 100% CPU and 2.28 GB of memory, kept its port open, and wrote nothing more to its log.

The heap was pinned at its 2 GB limit (`NODE_OPTIONS=--max-old-space-size=2048`), so V8 spent all its
time in garbage collection. That is a hang, not a crash: no exit, no restart, and a port probe still
connects.

**The cause.** The scheduled SAP folder pickup parsed and transformed the exports **on the API's own
thread**. Reproduced locally with the 25 Sep exports under the same 2 GB cap, one full ingest:
- peaked at **1.78 GB**;
- blocked the API for up to **10.8 s at a stretch** (31 s in total).

Production has more merged history and runs the start-up cache warm alongside, which is enough to
cross 2 GB.

**Why it repeated on every restart.** A slot was marked done only **after** its run finished. A run
that never finished left the slot due, and the first poller tick after every start (T+60 s) fired it
again. The DHM FX sync also runs at T+60 s and logs a line straight away, which is why it looked
like the culprit. It completes normally and is not the cause.

**Confirm it on production** (read-only, ApsaraDB DMS):

```sql
-- the pickup slots of 25-26 Nov: missing or never-finished rows confirm the loop
SELECT feed, slot, ran_on, ran_at, outcome FROM ops.ingest_slot_run
 WHERE ran_on >= DATE '2026-11-25' ORDER BY ran_at;
-- batches the wedged runs left behind (state stuck in SCANNING / PARSING / ...)
SELECT id, source_kind, state, started_at, finished_at FROM ingest.batch ORDER BY id DESC LIMIT 8;
```

**Until this release is deployed, pause the scheduled pickup.** Run this in DMS, then `docker restart
pct-api`. Do not use Sync now or Upload until the release is in, because both run the same in-process
ingest:

```sql
INSERT INTO app.rule_config (rule_key, rule_value, effective_from, note)
VALUES ('ingest.autopoll_enabled', 'false'::jsonb, CURRENT_DATE, 'paused for the 25 Nov 2026 wedge - re-enable after 10s');
```

After the release, switch the schedule back on in Admin → SAP Data Upload → SAP Data Sync.

**What changed:**
- **Every SAP load runs in a worker thread:** scheduled pickup, Sync now and upload. It has its own heap
  and its own database pool. Measured locally on the same exports:
  - the API answered every health check within 0.05 s throughout an 88 s ingest (before: 7–11 s
    stalls);
  - an ingest that runs out of memory ends only its worker. The API keeps serving and answers "The
    load ran out of memory and was stopped; the dashboard is unaffected", and a stranded batch is
    marked FAILED.
  - The output is identical: same rows, totals and per-line hash as the in-process run.
  - `INGEST_IN_WORKER=false` is an emergency fallback to the old behaviour.
- **Less memory per ingest:** workbooks are read in SheetJS dense mode (PO List 669 → 345 MB), and each
  file's rows are released once staged. An in-process ingest now peaks at 1.04 GB instead of 1.78 GB.
- **A pickup slot is marked "running" before the run.** A run that dies no longer re-fires on every
  restart; its files wait for the next slot or Sync now. A failure the process lives through still
  unmarks the slot for the back-off retry.
- **The background jobs wait 180 s after a start** (`BACKGROUND_START_DELAY_SECONDS`): folder pickup,
  Coupa sync and DHM FX sync. They no longer pile onto the start-up cache warm.
- **Watchdog:** a log line when the event loop was blocked for more than 2 s, or the heap passes 85%,
  naming the job that was running. For example: `watchdog: event loop blocked up to 8.3 s … (heap
  440/2096 MB; running: upload)`. Pickups also log `share sync: starting […]` and
  `ingest worker: started (…), heap limit … MB`.
- **`DHM_FX_ENABLED=false`** switches off the scheduled Data Hub sync without removing its keys.

**Deploy:** the usual §10 BE update, with no FE change, no migration and no Rebuild. This release
**also changes `deploy/production/be.compose.yml`**:
- the `api` service gets `mem_limit: 5g` (the API's 2 GB heap, plus the worker's own 2 GB, plus native
  memory).

Carry that line into `/opt/pct/compose.yml` by hand (§10 step 5), then apply it with
`docker compose -f /opt/pct/compose.yml up -d --force-recreate api`. A plain `docker restart` keeps the
old container configuration.

**On the incident report's other findings:**
- **`NODE_ENV=staging` is intentional** while the site is plain HTTP; the template explains why (§12).
  The database, cache and features are chosen by their own variables, not by `NODE_ENV`.
- **`DHM_BASE_URL` pointing at the FE host** (172.28.80.50:2001) is the production Data Hub, which is
  correct for production.
- **An autoheal container would not have helped:** each restart re-fired the slot and wedged again.

### 10t. Release of 26 Nov 2026 — plant names, cascading filters, column layouts, material unit prices

**What changed:**
- **Open Items:**
  - the headline "total open PR PO Lines" number clicks through to every open line;
  - the "PO not delivered - paid / DP" rows carry **DP Amount** (sum of the PO's SAP down payments, IDR)
    and **DP Date** (first DP posting). Both are PO-level, repeated on each line, and blank for a line
    whose payment is in Coupa only. Both are also in the Detail table's column chooser.
- **Plant master from the Data Hub, once a day:**
  - `modules/dhm/plant.ts` reads the hub's `plant` master (same `DHM_*` key pair as the FX rates; the
    PCT application needs `plant` on its allowlist) into `core.dim_plant`;
  - names change, new plants are added, nothing is deleted;
  - a name an administrator set in Master always wins;
  - status and **Sync now** are under Admin → Column mapping → Data Hub plant master.
- **"CODE — Name" wherever a plant code shows:**
  - Detail table (column, facet and search);
  - drill tables;
  - the plant charts (PR / PO / WBS by plant);
  - the Material and Category 360 popups;
  - the filter bar already showed the name with the code.
- **Company and Plant narrow each other:**
  - in the filter bar;
  - in the Detail table's filters (main tab and floating panel). Picking a company lists only its
    plants, and picking a plant lists only its company.
- **Tables:**
  - every Detail column sorts (PO Split was the one that did not);
  - **Reset to default columns** in the Detail table, the drill tables and the popup tables clears
    the reader's own saved order and choice. Layouts were already saved per user.
- **Material Group page:**
  - the material explorer has a **Quantity** column, mass in KG and volume in L (MT, G, KL, M3 converted;
    other units as ordered; "mixed units" when they do not convert). The Material 360's Total qty uses
    the same rule;
  - Material 360 and Category 360 show **unit price by month (IDR per KG/L)**, with a **Top vendors /
    Top plants** toggle. The hover names the plants that bought from that vendor, or the vendors that
    plant bought from. The Category 360's old spend-by-month chart is replaced;
  - every popup PO list has **GR Quantity** and **Outstanding Quantity** (= Qty − GR Quantity), in the
    PO's order unit. GR postings in another unit (a PO in MT received in KG) are converted; a unit that
    does not convert falls back to SAP's own still-to-be-delivered.

**Deploy:** the usual §10 BE and FE updates, with no migration. Then:
1. **Admin → SAP Data Sync → Rebuild** once, so the precomputed plant charts carry the names. Filtered
   views compute live and show them straight away.
2. Ask the Data Hub integrator to add `plant` to PCT's allowlist, then use **Sync now** in the plant
   box. The daily run starts by itself 3.5 minutes after the API starts.

New optional settings in `/opt/pct/secrets.production.env` (defaults shown):
- `DHM_PLANT_ENTITY=plant`: the hub master's slug;
- `DHM_PLANT_SYNC_HOURS=24`: the interval;
- `DHM_PLANT_ENABLED=true`: `false` stops the scheduled run, and Sync now still works.

### 10u. Release of 27 Nov 2026 — exclusions recompute from the loaded data

**What happened (staging, 26 Nov 2026).** Purchasing Orgs were excluded and saved three times, but
every figure stayed the same.
- "Save exclusions & recompute" re-read the SAP exports from the pickup folder and parsed them again.
- On the staging BE host (2 vCPU, 3.5 GB RAM shared by about 30 containers, 3.1 of 4 GB swap in use) that
  pushed the server into swap. The API stalled for up to 18 s at a time, its database connections timed
  out, and the run died before writing anything.
- That failure path also wrote no audit entry, so it looked as if nothing had happened.
- Even on a healthy host it would have failed: after-run filing had already moved the exports out of the
  pickup folder, so there was nothing to re-read.

**What changed:**
- **Save exclusions & recompute** now calls `POST /api/v1/ingest/recompute` (admin). It rebuilds every
  fact from the records already loaded, under the exclusions and rules in force now:
  - no file is read, so the pickup folder does not matter;
  - nothing is parsed. Measured locally on the 25 Sep data: about 60–70 s and about 690 MB, against about
    1.8 GB for a file load;
  - reverting an exclusion and recomputing reproduced the original version exactly (row counts, IDR
    totals and all 79 KPIs).
- The batch is listed as `manual` with source detail `recompute`. Its Data Check line is
  "Recompute: every figure rebuilt from the records already loaded…".
- A Sync now or recompute that fails is **audited with its reason** (`ingest.sync` / `ingest.recompute`,
  outcome failure).
- An excluded Purchasing Org also removes PO lines raised from its requisitions, even when the PO line
  carries another org. This is the existing rule, not new: on the local data, excluding LBG1 removed its
  2,542 PO lines plus 2,616 PUR1/PCP1 lines raised from LBG1 requisitions.

**Deploy:** the usual §10 BE and FE updates, with no migration, no new setting and no Rebuild. Then, in
Admin → Exclusions, press **Save exclusions & recompute** once to apply the saved list.

**Staging host:** the scheduled file pickup still needs about 1.8 GB. With the BE host already deep in swap,
ask infra for more RAM there (or fewer co-tenants). A recompute is lighter but not free.

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
