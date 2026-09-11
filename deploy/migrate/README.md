# Staging database → ApsaraDB RDS for PostgreSQL

Moves the staging database from the container-hosted Postgres on
`172.28.92.60:5436` to the managed instance
`pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com`.

Adapted from `PostgreSQL_to_ApsaraDB_RDS_Dump_Restore_Runbook.docx` (written
from the KLIP migration). **Three things in that runbook do not transfer to
PCT** and are the reason these scripts exist rather than a copy of its
commands:

| Runbook step | Why it differs here |
|---|---|
| Gate: `TABLE DATA` count **must equal the number of base tables** | This schema has **6 LIST-partitioned parents**, and `pg_dump` emits no `TABLE DATA` entry for a partitioned parent — the rows belong to the partitions. Measured: 137 base tables, 131 `TABLE DATA` entries. The runbook's gate would reject a good dump. The gate here compares against `relkind='r'` (plain tables, partitions included). |
| Two config files hold `DB_*`, with a precedence trap | PCT has **one** `DATABASE_URL` in **one** file, `/opt/pct/staging.env`. The compose `environment:` block never mentions the database. There is no precedence question — but the value is a **URI**, so the password must be percent-encoded. `05-cutover.sh` does that. |
| Naive `timestamp` columns silently change meaning at a UTC→Jakarta cutover (132 columns, two weeks of work on KLIP) | **Every timestamp column in this schema is `timestamptz`** — 67 of them, zero naive. A `timestamptz` stores an absolute instant, so a server timezone difference changes display, not meaning. Matching the timezone is still worth doing (276 plain `date` columns make day boundaries timezone-sensitive) but it is a tidiness item here, not a data-integrity one. |

## Order

```bash
cd /opt/pct/migrate
./01-preflight.sh     # read-only, both sides. Run it as often as you like.
./02-dump.sh          # stops pct-api, dumps, gates on completeness
./03-restore.sh       # restores + ANALYZE
./04-verify.sh        # ten checks against baselines captured before the dump
./05-cutover.sh       # rewrites one line, recreates the API container
```

Every script refuses to run if the one before it did not finish. Nothing
before `05-cutover.sh` changes anything the application reads, and nothing at
any point writes to the source database.

`01-preflight.sh` compares `migrate.env` against the `DATABASE_URL` of the
**running** `pct-api` container and stops if they disagree — the runbook's
Phase 1 near-miss, where the config file named one host and the process used
another. It is a real gate: it fired during the rehearsal.

`./99-rollback.sh` puts the API back on `172.28.92.60:5436`. It is standalone —
no `migrate.env`, no ApsaraDB credentials — because a rollback must not be able
to fail for want of a config file.

## Setup, once

```bash
mkdir -p /opt/pct/migrate && cd /opt/pct/migrate
cp /opt/pct/src/deploy/migrate/* .
cp migrate.env.template migrate.env
# fill DST_USER, DST_PASSWORD, and SRC_PASSWORD; check DST_PORT and DST_DB
chmod 600 migrate.env && chmod +x *.sh
```

Read each value from the file that already holds it rather than retyping it:

- `SRC_PASSWORD` — `POSTGRES_PASSWORD` in `/opt/pct/db.env` on 172.28.92.60,
  or the password already inside `DATABASE_URL` in `/opt/pct/staging.env`.
- `DST_USER` / `DST_PASSWORD` — the ApsaraDB account, from the RDS console.

`migrate.env` is gitignored. Do not commit a filled copy.

## Before you start

Three things must be true, and `01-preflight.sh` fails loudly on each:

1. **The BE server's IP is in the ApsaraDB whitelist.** Add 172.28.92.57 —
   that is where `pct-api` runs and where these scripts are run from. (.56 is
   the FE server; it never talks to the database.)
2. **`citext`, `pg_trgm` and `pgcrypto` are available on the instance.** All
   three are *trusted* extensions from PG13 on, so the database owner can
   create them without superuser — but they must be installed on the instance,
   and on a managed service that is the provider's decision.
3. **The target database is empty of application objects.** The runbook's hard
   rule holds: never `DROP SCHEMA` on a managed instance — it can cascade into
   provider objects. If the target is not empty, use a fresh database rather
   than clearing this one. `./01-preflight.sh --list-target` shows what is
   there.

Set the instance's `timezone` parameter to `Asia/Jakarta` to match the source
while you are in the console.

## Rehearsed, not just written

The whole sequence was run end to end before it was pointed at anything real:
source = the local development database (identical schema, 2,926,775 rows),
destination = a fresh empty database on the same server. Measured:

| Phase | Time | Result |
|---|---|---|
| `02-dump.sh` | 2m 29s | 116 MB dump, gate 131 = 131 |
| `03-restore.sh` | 2m 03s | 0 errors, every non-empty table analysed |
| `04-verify.sh` | 0m 51s | 137 tables, 3,232 columns, 446 indexes, 240 constraints, 4 functions, 6 partitioned parents, 16 sequences with values, 2,926,775 rows — all identical |
| `05-cutover.sh` | — | one line of 132 rewritten, URI-hostile password encoded and proven to authenticate |
| `99-rollback.sh` | — | `staging.env` restored byte-identical |

`05-cutover.sh` and `99-rollback.sh` — the pair that edits `staging.env` in
place — were rehearsed separately against a throwaway copy of the file and a
dummy compose service, with a deliberately URI-hostile password
(`p@ss:w/rd#1`) on a throwaway database role. Verified: the encoded URI
(`p%40ss%3Aw%2Frd%231`) actually authenticates, **exactly one line** of a
132-line file changes, and the rollback restores it **byte-identical**.

The rehearsal is how the scripts got fixed rather than shipped broken. Three
queries failed against a real catalogue: `relkind` is a `"char"`, so
concatenating it is an ambiguous operator; `GROUP BY 1` over an expression
containing `count(*)` is rejected outright; and `pg_inherits` carries
partitioned **index** parents as well as tables, which turned "6 parents" into
"32". A fourth would have failed on the real target only — the function diff
originally compared all 118 functions in these schemas, 114 of which belong to
`citext`, `pg_trgm` and `pgcrypto`, so a minor extension version difference on
ApsaraDB would have failed verification for a reason unrelated to the
migration. It now compares this application's own four.

The fifth was the worst, and it only showed up in the cutover rehearsal: the
health wait gave up after 120 seconds, but this API's healthcheck is
`start_period 20s` + `interval 10s` + `retries 12`, so Docker needs up to
**140 seconds** just to reach a verdict. The script would have declared a
successful cutover a failure and told the operator to roll back. `wait_healthy`
in `00-lib.sh` now waits five minutes, treats "starting" as patience, and
fails fast in two cases that genuinely cannot improve: a real failing streak,
and a container that has **exited** — which is what an API that cannot reach
its database does, and therefore the single most likely way a cutover fails.
All four paths are tested; the failure message carries the last healthcheck
output rather than just a status word.

`CLIENT_NETWORK=bridge` is what made that rehearsal possible: the client
container runs on the host network by default (right for the BE server, which
reaches the source by IP), and on `bridge` it can reach a database published
on `127.0.0.1` via `host.docker.internal`.

## The staging run, 11 Sep 2026

Ran clean: PostgreSQL 16.4 to **ApsaraDB RDS 18.4** (a two-major jump), 110 MB
dump, gate 89 = 89, `pg_restore` exit 0 with **zero** errors, and all ten
verification checks identical over **3,152,780 rows**. The API came back
`healthy` on the new database and skipped all 26 migrations, as check 10
predicted.

The migration was not what went wrong. `05-cutover.sh` could not start the
container:

```
error while creating mount source path '/mnt/synology-apps':
mkdir /mnt/synology-apps: file exists
```

Another stack had taken `172.30.0.0/16`, the subnet the Synology NAS lives on,
which leaves CIFS in a state where `findmnt` still lists the mount and every
read fails with *Host is down* -- and Docker refuses to bind a mount source it
cannot stat. Two lessons are now built in:

* `01-preflight.sh` stats **every bind source of the running container**, so
  this is caught while the app is still up and stopping costs nothing.
* `05-cutover.sh` no longer re-swaps an env file that already names the
  destination. The natural response to that failure is to re-run the script,
  which would have taken a second backup -- one already containing the new URL
  -- and pointed the rollback at it.

## Downtime

From `02-dump.sh` stopping the API to `05-cutover.sh` reporting healthy.
The rehearsal took **5½ minutes** over loopback. On staging the dump and the
restore both cross the network, so **budget 15–30 minutes** and do it outside
working hours. The dashboard is unreachable for that window; nothing is lost,
because the API is stopped before the snapshot rather than after it.

## What the scripts leave behind, in `/opt/pct/migrate`

| File | Why it matters |
|---|---|
| `SOURCE_ROWS.txt`, `SOURCE_SEQS.txt`, `SOURCE_OBJECTS.txt`, `SOURCE_PARTITIONS.txt`, `SOURCE_MIGRATIONS.txt` | Baselines captured **before** the dump. `04-verify.sh` diffs against these files, never against a number someone remembers. |
| `pct-<stamp>.dump` + `.sha256` | The dump, and the checksum `03-restore.sh` re-checks before restoring. |
| `toc-<stamp>.txt` | `pg_restore -l` listing — where to look when the completeness gate fails. |
| `restore-<stamp>.log` | Full `pg_restore` output. Its exit status decides nothing; the script classifies the errors instead. |
| `verify-<stamp>.txt` | The verdict. `05-cutover.sh` refuses to run without a `PASS`. |
| `ENV_BACKUP` | Points at the pre-cutover `staging.env`, which is what `99-rollback.sh` restores. |

## After cutover

- **Leave `pct-postgres` on 172.28.92.60 running and untouched for a few
  days.** It is the rollback. `99-rollback.sh` is a one-liner only while it
  still exists.
- Migrations are applied by the API at boot (`Backend/src/db/migrate.ts`,
  table `public.schema_migration` — singular). The restore carries those rows,
  so the API skips them rather than re-applying them over restored data.
  `04-verify.sh` check 10 proves the count matches.
- Two pieces of staging state live in the database, not in code, and survive
  the move because they are dumped with everything else: the **Hold PO
  exclusion toggle** and the **intercompany vendor prefixes** in
  Admin → Data Exclusions. Confirm them on the Admin page after cutover
  anyway — it is one page load and it proves the app is reading the new
  database.
- Once the old instance is retired, delete `/opt/pct/migrate/*.dump` — it
  contains every row of the staging dataset.
