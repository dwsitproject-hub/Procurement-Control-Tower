# Synology integration — shared server apps

How another application on the **same app server** stores files on the shared Synology NAS.

**Already done (do not repeat):** NAS share, SMB, host mount, and folder layout under the share are provisioned by IT/infra. You only configure **your app** so uploads go into **your** project folder.

---

## Shared layout (reference only)

On the server, the share is already mounted. Apps share one root and isolate by deployment + project slug:

```text
APPs/                    ← Synology shared folder (File Station)
  dev/
    EOS/                 ← EOS development
    YOUR_APP/            ← your app development
  prod/
    EOS/
    YOUR_APP/
```

| Fixed (same for every app on this server) | Per app (you choose / are given) |
|-------------------------------------------|----------------------------------|
| Host mount, e.g. `/mnt/synology/eos` | `STORAGE_PROJECT_SLUG` (e.g. `EOS`, `YOUR_APP`) |
| `dev` / `prod` folders under that mount | `STORAGE_DEPLOYMENT` = `dev` or `prod` |
| File Station: `APPs → {deployment} → {slug}` | Bind mount path **inside** your container (must match env) |

Resolved upload root:

```text
{STORAGE_SYNOLOGY_ROOT}/{STORAGE_DEPLOYMENT}/{STORAGE_PROJECT_SLUG}
```

Example for EOS on this server: `/mnt/synology/eos/dev/EOS`.

---

## What your app must do

### 1. Set storage env vars

Use the Option B pattern (recommended). Values below match the **EOS** integration; replace the slug for your app.

```env
STORAGE_TYPE=local
STORAGE_SYNOLOGY_ROOT=/mnt/synology/eos
STORAGE_DEPLOYMENT=dev
STORAGE_PROJECT_SLUG=YOUR_APP
```

Resolved base path: **`/mnt/synology/eos/dev/YOUR_APP`**

Rules:

- Do **not** set `STORAGE_LOCAL_PATH` when using Option B (it overrides the composed path).
- Use `STORAGE_DEPLOYMENT=prod` only for production (or staging that must mirror prod), with the prod slug/path your team confirms.
- Confirm your project folder exists under `APPs/{deployment}/` (or that the app may create subfolders under an agreed slug). Ask infra only if the **folder for your slug** is missing — not for mounting the NAS.

**Option A** — if you are given one full path instead:

```env
STORAGE_LOCAL_PATH=/mnt/synology/eos/dev/YOUR_APP
```

### 2. Align Docker bind mounts (if the API runs in a container)

`STORAGE_SYNOLOGY_ROOT` (or `STORAGE_LOCAL_PATH`) must be a path **inside the container**. Bind the host mount into that path.

EOS reference (staging / production):

- `docker-compose.staging.backend.yml`
- `docker-compose.production.backend.yml`
- Root `.env` / `.env.example`: `STORAGE_HOST_MOUNT` if the host path differs from the compose default

After changing storage env or volumes, recreate the backend container so the bind takes effect.

### 3. Verify

1. App starts with no storage config errors.
2. Upload a file through your app.
3. Confirm it on the host (or `docker exec … ls` on the resolved path).
4. Optionally check File Station: `APPs → {deployment} → {YOUR_APP}`.
5. Download the same file through the app.

---

## Laptop / local without NAS

Machines without the Synology mount should **not** use Option B. Use a local folder only:

```env
STORAGE_LOCAL_PATH=./uploads
```

Those files stay on the laptop; they are not on the NAS.

---

## Path resolution (EOS backend reference)

See `backend/src/config/index.ts`. Order:

1. **`STORAGE_LOCAL_PATH`** if set → used as-is.
2. Else if `STORAGE_SYNOLOGY_ROOT` + `STORAGE_DEPLOYMENT` + `STORAGE_PROJECT_SLUG` are all set → `{root}/{deployment}/{project}/`.
3. Else → `./uploads`.

---

## Troubleshooting (app config only)

| Symptom | Check |
|---------|--------|
| Upload works but File Station empty / wrong folder | Wrong `STORAGE_DEPLOYMENT` or `STORAGE_PROJECT_SLUG` |
| Files visible in container but not on NAS | Bind mount missing or host/container paths disagree — fix compose and recreate |
| Works on server, not on laptop | Expected without NAS; use `STORAGE_LOCAL_PATH=./uploads` locally |

Mount, firewall, and DSM issues are infra — escalate only after your slug/path and bind mount match the table above.

---

## Related files (EOS)

| File | Purpose |
|------|---------|
| `backend/.env.example` | Storage variables (Option B / A / local) |
| Root `.env.example` | `STORAGE_HOST_MOUNT` for Compose |
| `docker-compose.staging.backend.yml` | Staging NAS bind example |
| `docker-compose.production.backend.yml` | Production NAS bind example |
| `backend/src/config/index.ts` | Path resolution |
| `docs/TSD.md` | Broader document storage strategy |
| `docs/SETUP.md` | General EOS setup (Node, DB, migrations) |

---

# PCT integration (this repository)

Implemented 7 Aug 2026. This section records what Procurement Control Tower
actually does, so the next app on this server can copy it.

## The direction is reversed, and it matters

The reference app (EOS) **writes** uploads to the NAS. PCT **reads**: the six
SAP exports (PR Report, PO Report, GR List, PR Release, PO Release, Rate
Conversion) are dropped into its project folder, and a scheduled pickup
assembles them into one dataset version.

Consequences of that difference, all deliberate:

| Decision | Why |
|---|---|
| The NAS is bound **read-only** (`:ro`) | PCT has no reason to write to the exports, and a read-only mount makes it impossible for an ingest defect to modify or delete a source file. This matches the convention the repo already used for `/mnt/sap_exports`. |
| Nothing is created on the NAS | So the project folder must already exist. Ask infra only for `APPs/{deployment}/PCT`. |
| The upload spool stays on a **local** volume | It is scratch space for one ingest and is deleted afterwards; putting it on SMB would add network latency to every manual upload for no durability gain. `UPLOAD_SPOOL_PATH` is unchanged. |

## Configuration

Option B, per this doc. Staging:

```env
STORAGE_TYPE=local
STORAGE_SYNOLOGY_ROOT=/mnt/synology-apps
STORAGE_DEPLOYMENT=dev
STORAGE_PROJECT_SLUG=pct
```

Resolved: `/mnt/synology-apps/dev/pct` — File Station `APPs → dev → pct`.

**The host mount differs per server.** This doc's `/mnt/synology/eos` is the EOS
app server's; on the PCT staging BE (172.28.92.57) the APPs share belongs at
`/mnt/synology-apps` (its neighbour is `dev/klip`, lowercase — case matters on
the mount). Confirm with `stat -f`, never by looking at the folder tree: on
7 Aug 2026 all of those paths existed on that VM as **local ext4 directories**
and the share had never been mounted there at all.

Two additions to the doc's resolution order, both to protect existing
deployments:

1. **Step 3 is `SHARE_PATH`, not `./uploads`.** `SHARE_PATH` is PCT's original
   variable and every deployment sets it, so an upgrade that adds no `STORAGE_*`
   variables reads exactly the folder it read before.
2. **A partial Option B is refused at boot.** Set all three or none. Falling
   through silently is the worst outcome available: a dashboard that looks
   healthy while reading the wrong folder.

## The failure this cost us, and how it is now caught

Docker **does not fail when a bind mount's host path is missing** — it creates
an empty directory inside the container. The path then looks perfectly correct
and the pickup simply reports "no files found", which sends you looking at
patterns and schedules instead of at the mount.

So the app probes it rather than trusting the configuration: it compares the
resolved folder's filesystem device against the container root. A bind mount
differs; a folder Docker invented does not. The verdict appears in three places:

- boot log — `WARNING storage: ... is on the container's own filesystem, not a mount`
- Admin → SAP Data Upload → the Synology NAS block (status, resolved folder,
  deployment, project folder, write access)
- `GET /api/v1/admin/ingest/config` → `storage`

## Precedence, in full

Per-feed folders saved in the Admin panel are explicit user intent and are never
rewritten by the server, so they outrank the environment. Order:

1. the per-feed folder saved in Admin → SAP Data Upload
2. the resolved storage root, when `STORAGE_*` is configured
3. the pre-012 `ingest.share_path` rule row (dead key, no UI writes it)
4. `SHARE_PATH`

2 outranks 3 deliberately: an installation that once saved that row would
otherwise have it shadow the NAS root forever. And because 1 outranks
everything, pointing an existing installation at the NAS is **two** steps —
set the environment, then move the six folders in the panel. The panel flags
rows that sit outside the resolved root and offers a one-click fix, so the
mismatch cannot pass unnoticed.

## Related files (PCT)

| File | Purpose |
|---|---|
| `Backend/src/config/storage.ts` | Path resolution and the mount probe |
| `Backend/src/config/env.ts` | `STORAGE_*` variables and boot validation |
| `Backend/src/modules/ingest/share_poller.ts` | Per-feed folder precedence |
| `deploy/staging/be.compose.yml` | Staging bind mount (`STORAGE_HOST_MOUNT`) |
| `deploy/env/staging.env` | The staging `STORAGE_*` block |
| `Frontend/src/components/SapUploadTab.tsx` | Admin panel: NAS status, stray-folder warning |
| `Docs/DEPLOY_STAGING.md` §3a | Mount check and cut-over steps |

---

## After-run filing (succeed / failed)

Added 20 Aug 2026. With **Admin → SAP Data Upload → After a run** switched on,
the files a run consumed are moved out of the pickup folder — into `succeed`
when a dataset was published, into `failed` when the run failed.

**This needs write access, and the share is deliberately mounted read-only.**
Three separate gates must all be opened, in this order. Opening only some of
them produces a run that publishes correctly and then silently files nothing —
which is why the panel names the problem instead of leaving it to be discovered.

1. **On the NAS (infra team).** The share user (`app-prj`) needs write
   permission on `APPs/dev/PCT`. Nothing below matters until this is granted.

2. **A second host mount, of the project folder only.** Leave the APPs share
   mounted read-only. Filing needs write on ONE folder, and widening the whole
   share to get it would hand this container write and delete over every other
   project stored on the NAS.

   Mount the subtree separately — CIFS can mount a path below the share:

   ```
   //<nas>/APPs/dev/PCT /mnt/synology-pct cifs rw,credentials=/etc/smb-eos.creds,uid=1001,gid=1001,forceuid,forcegid,dir_mode=0770,file_mode=0660,vers=3.0,iocharset=utf8,serverino,mapposix,soft,_netdev 0 0
   ```

   Both the `rw` flag AND the mode bits matter: the read-only mount's
   `dir_mode=0550,file_mode=0440` carries no write bit for anyone, so `rw` on
   its own would still fail. `uid`/`gid` 1001 is the container's user
   (`USER 1001` in `Backend/Dockerfile`); with `forceuid,forcegid` every file
   presents as owned by it.

   Confirm before going further:

   ```
   mount | grep synology && touch /mnt/synology-pct/.wtest && rm /mnt/synology-pct/.wtest && echo writable
   ```

3. **The container bind.** `be.compose.yml` lays the writable subtree over the
   read-only share, deeper destination first, so only that folder becomes
   writable inside the container. In `/opt/pct/.env`:

   ```
   STORAGE_PROJECT_HOST_MOUNT=/mnt/synology-pct
   STORAGE_PROJECT_MOUNT_MODE=rw
   ```

   Leave `STORAGE_MOUNT_MODE` alone — the share itself stays `ro`. Set
   `STORAGE_PROJECT_CONTAINER_PATH` too if `STORAGE_DEPLOYMENT`/
   `STORAGE_PROJECT_SLUG` are not `dev`/`PCT`; Compose cannot read the
   `env_file` for interpolation, so that path is stated, not derived.

   Then **recreate** the container — a bind mode is fixed at creation, so
   `restart` will not pick it up:

   ```
   cd /opt/pct && docker compose -f compose.yml up -d --force-recreate api
   ```

   Nothing here is conditional in Compose, so unset these and the extra bind
   re-binds the same folder read-only: an exact no-op, and the feature stays off
   until all three gates are opened deliberately.

Only then switch the feature on in the panel. The **Resolved folder** block
reports whether the folder is writable, and the panel refuses to let the
succeeded and failed folders be the same value.

### What it does and does not move

| Run outcome | What happens |
|---|---|
| `published` | files the pipeline recognised → `succeed`; files it read but could not identify → `failed` |
| `failed` | every file in the bundle → `failed` |
| `incomplete_bundle` | **nothing moves** |
| `noop_unchanged`, `source_unavailable` | nothing moves |

Leaving an incomplete bundle alone is the important one. The scheduler picks up
per feed, so the folder legitimately holds a partial set while the rest of the
day's exports arrive; filing those away would mean the bundle could never
complete — the PR export would be moved at 08:00 before the PO export landed at
09:00.

Each run files into its own dated subfolder, `succeed/2026-08-20_batch62/`.
These filenames repeat (`Mat group.xlsx` is the same every day), so a flat
destination would overwrite yesterday's export with today's and destroy the
lineage the feature exists to preserve.

A file matching **no feed name pattern** is never picked up in the first place,
so it is never filed either — an unrelated file kept in the folder is not failed
data. The pickup folder is therefore not guaranteed to end up empty.

**A filing failure never fails the run.** The dataset is published and its
figures are already correct by the time this happens; the outcome stays
`published`, the per-file errors are reported in the panel and logged, and the
run detail reads e.g. `v62 · archived 8/10, 2 could not be moved`. Where a move
falls back to copy-then-delete and the delete fails, the file is left in both
places — recoverable, and reported, rather than lost.
