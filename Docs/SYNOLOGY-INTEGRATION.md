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
STORAGE_SYNOLOGY_ROOT=/mnt/synology/eos
STORAGE_DEPLOYMENT=dev
STORAGE_PROJECT_SLUG=PCT
```

Resolved: `/mnt/synology/eos/dev/PCT` — File Station `APPs → dev → PCT`.

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
