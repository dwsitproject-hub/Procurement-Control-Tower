---
name: pct-production-deploy
description: Prepare (or refresh) the Procurement Control Tower PRODUCTION deployment - free-port analysis on the shared FE/BE servers, Synology-safe NAS mount and Docker subnet, ApsaraDB setup, the deploy/production files, Docs/DEPLOY_PRODUCTION.md, and the per-server steps for the release in hand. Use whenever the user asks to deploy PCT to production, prepare or update the production deployment guide, check production ports, or plan a production release - even if they do not name this skill.
---

# PCT production deployment preparation

Produces a deployment the user can run from PuTTY on two SHARED servers without breaking the other
applications on them. The reference implementation is already in the repo - refresh it, do not start over:

| File | Role |
|---|---|
| `Docs/DEPLOY_PRODUCTION.md` | the runbook (first deploy + every release) |
| `deploy/production/be.compose.yml`, `fe.compose.yml` | pinned network subnet, private-IP / loopback port binds |
| `deploy/production/production.env` | env template (no secrets; `FILL_...` markers) |
| `deploy/production/secrets.production.env.example`, `fe-build.env.example` | integrations / Hub SDK key |
| `deploy/production/nginx/production.conf`, `host-vhost-pct.conf` | container nginx + host vhost |
| `deploy/production/preflight.sh` | read-only server check: ports, subnets, NAS, RDS, front proxy |
| `scripts/ports.py` (this skill) | free-port analysis from pasted `docker ps` / `ss` text |

Staging's runbook `Docs/DEPLOY_STAGING.md` is the record of what went wrong before (sections 8.2 host nginx,
10 Docker took the NAS subnet, 11 ApsaraDB). Read the relevant section before changing the matching part.

## 1. Gather the inputs (ask only for what is unknown or may have changed)

| Input | Last known value (12 Nov 2026) |
|---|---|
| FE server private IP | 172.28.80.50 |
| BE server private IP | 172.28.80.51 |
| ApsaraDB host | pgm-d9jn3khh0b3907w4.pgsql.ap-southeast-5.rds.aliyuncs.com (db `pct`, account `pct`) |
| Hostname / TLS | pct.kpndomain.com, **HTTP** (so `NODE_ENV=staging`; see guide §12) |
| Branch | `main` (released by PR sit2 -> main) |
| NAS | 172.30.1.94, share `APPs`, folder `PCT` at the share ROOT, host mount `/mnt/pct-nas` |
| Ports | FE 127.0.0.1:3050, BE 172.28.80.51:4100 |
| Hub | https://dwshub.kpndomain.com (production) |

**Port lists**: ask for `docker ps` from BOTH servers (screenshots are fine) and, better, the preflight
output (`bash /opt/pct/src/deploy/production/preflight.sh be|fe`), whose `ss` view also shows host services
that `docker ps` cannot (the host nginx on 80, package-installed databases). Transcribe screenshots into
text and run `python .claude/skills/pct-production-deploy/scripts/ports.py 3050 < fe.txt` (and 4100 for the
BE). Only HOST ports clash - `3000/tcp` without `->` is container-internal and irrelevant.

If the user changes any input, use AskUserQuestion only for genuine decisions (hostname/TLS, branch, NAS
folder); everything else is read from the repo or the servers.

## 2. Find what this release changes (the repo is the source of truth)

```bash
git fetch -q origin
git log --oneline origin/main..origin/sit2            # what reaches production
git diff --stat origin/main..origin/sit2 -- Backend/src/db/migrations Backend/src/config/env.ts \
  Frontend/Dockerfile Backend/Dockerfile deploy docker-compose.yml
```

For each hit, carry it into the production files and guide:

- **New migration** -> runs at API start automatically; note it in the release steps (and any manual SQL
  it documents, e.g. a new extension on ApsaraDB needs the privileged account in DMS - see guide §3).
- **New/changed env var in `Backend/src/config/env.ts`** -> add it to `production.env` (or the secrets
  example if it is a credential) with a comment; flag it as "edit `/opt/pct/production.env` on the BE
  server" in the release steps - the filled file there is never overwritten from the template.
- **New build arg in `Frontend/Dockerfile`** -> `fe-build.env.example` + the FE build line.
- **Change to `deploy/staging/*` compose or nginx** -> mirror it in `deploy/production/*` unless it is
  staging-specific.
- **New outbound dependency** (a host the API calls) -> request table in guide §1 and a check in
  `preflight.sh`.
- **New production-mode check in env.ts `superRefine`** -> re-evaluate the `NODE_ENV=staging` decision.

## 3. Rules that keep the shared hosts safe (never relax these)

1. **Ports**: bind PCT only to the BE private IP (API) and 127.0.0.1 (web). Never 0.0.0.0, never 80/443.
   A port is free only if neither `docker ps` (incl. stopped containers) nor `ss -ltn` shows it.
2. **Docker subnet**: `pct_net` always has an explicit `PCT_SUBNET` from the preflight, outside 172.28/16
   (the LAN) and 172.29-172.31 (the NAS is 172.30.1.94). An auto-allocated subnet in 172.30 cut every app on
   staging off from the NAS - twice.
3. **NAS**: mount only `//NAS/APPs/PCT` at PCT's own mountpoint with PCT's own credentials file and fstab
   line (`_netdev,nofail`, `uid=1001,gid=1001`). Never unmount, remount or edit another mount; verify with
   `findmnt -t cifs` that the others are unchanged.
4. **Host nginx**: add one vhost file, never `default_server`, always `nginx -t` before reload.
5. **Never** `systemctl restart docker`, edit `daemon.json`, prune, or remove another app's network or
   container. If the preflight shows another app shadowing the NAS, report it - do not fix their stack.
6. **Database**: PCT's own account owning `pct`; extensions created once by the privileged account.
7. **Secrets**: none in the repo or the chat. Templates carry `FILL_...`; passwords go in with `nano` on the
   server. Never read the gitignored secrets files.

## 4. Writing conventions for every command in the guide

From the staging deploy's failures (memory: deployment-guide-lessons):
label the machine on every block ("PuTTY on 172.28.80.51 (BE)"); build on the servers from git, never ship
images; deploy keys per server via the `github-pct` SSH alias (a global `Host github.com` block hijacks other
apps' pulls); no `<placeholder>` inside shell blocks (use `FILL_...` and say "edit before Enter"); no `read`
in paste blocks; config-file lines are appended with `printf ... >>`, never pasted as commands; give the
expected output after each check; guarded `git reset --hard origin/main` only when the checkout has no
changes of its own; `--force-recreate` after every rebuild.

## 5. Validate before handing over

```bash
bash -n deploy/production/preflight.sh
npx tsc -p Backend --noEmit && npx tsc -p Frontend --noEmit
```

Compose files, from a scratch copy laid out like `/opt/pct` (an `.env` with a test `PCT_SUBNET`, the env
file / nginx conf next to it): `docker compose -f compose.yml config` must parse, show the private-IP /
loopback binds and the pinned subnet, and must FAIL without `.env` (the subnet is mandatory).

## 6. Deliver

- The refreshed files, committed on sit2 (ask before pushing).
- A short release sheet in the reply: what is new since the last production release, any new env vars or
  manual SQL, then the guarded update commands per server (guide §10) and whether a **Rebuild** in SAP Data
  Sync is needed (any change to how data is loaded or excluded).
- For a first deployment: the request table (guide §1) - those are the items the user must chase.
