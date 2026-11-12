# Seed production's database from staging — dump, carry, restore

One-off, for the first production deployment (12 Nov 2026): production starts with staging's full SAP
history instead of only the exports in the NAS folder. Staging is **read only** throughout.

| | Machine | Database |
|---|---|---|
| Source | **Staging BE 172.28.92.57** (`pct-api`) | ApsaraDB `pgm-d9jx9o06qae8gf3h` (PostgreSQL 18.4), database `pct` |
| Carrier | **Your PC** (PuTTY's `pscp`) | — |
| Target | **Production BE 172.28.80.51** (`pct-api`) | ApsaraDB `pgm-d9jn3khh0b3907w4`, database `pct`, account `pct` |

**Precondition:** staging's SAP data comes from the **production SAP** exports. If staging was ever fed
from an SAP test system, do not do this.

**No password is typed or shown.** Each side reads its own `DATABASE_URL`: staging from the running
`pct-api` container, production from `/opt/pct/production.env`. The tools run in a throw-away `postgres:18`
container (`pg_dump` must be at least as new as the 18.4 source).

**The dump holds personal data and password hashes.** It lives in root-only folders and is deleted at the
end on all three machines (§5).

---

## What comes across, and what is removed afterwards (§4)

Kept: every SAP fact, staging row and dataset version; users with their roles, departments and data scopes;
page permissions; renamed titles; exclusions; notification recipients; master overrides; the audit history.

Removed straight after the restore, because it is staging's and would be wrong in production:

| From staging | Why it must go |
|---|---|
| Coupa store and watermarks (`ops.coupa_*`) | the **kpn-test** tenant; production syncs its own from scratch |
| Data Hub store (`ops.dhm_*`) and non-SAP FX rates | the staging Data Hub, and Coupa's junk test rates (USD→IDR ≈ 17.8) |
| All local passwords (`app.local_credential`) | test accounts and possibly the development admin's well-known password |
| Hub identities (`sso_subject`) | they belong to the **staging** Hub; left in place, every production Hub sign-in is refused. Cleared, the first sign-in links each person to their account by e-mail |
| SAP Data Sync folders, filing and schedule, Coupa schedule | staging's paths; production sets its own in §6 |
| Run history (`ops.ingest_filing`, `ops.ingest_slot_run`) | staging's runs; it would also make an empty production folder look "filed" |

---

## 1. Staging BE — 172.28.92.57 (PuTTY)

**Staging is stopped for the few minutes of the dump.** Its API writes all the time — the Coupa poller, the
audit log of anyone using staging — and the row counts taken after the dump must describe exactly what was
dumped, or §3 cannot prove the copy (the local rehearsal showed four Coupa tables drifting between the two).
Choose a moment outside staging's pickup times.

```bash
install -d -m 700 /root/pct-export && cd /root/pct-export
```

The row-count query, used on both sides (every PCT table, exact counts):

```bash
cat > /root/pct-export/count.sql <<'SQL'
SELECT table_schema || '.' || table_name,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
  FROM information_schema.tables
 WHERE table_schema IN ('app','audit','core','ingest','mart','ops','staging') AND table_type = 'BASE TABLE'
 ORDER BY 1;
SQL
```

Take staging's connection from the running API (nothing is printed), then stop the API:

```bash
export DBURL="$(docker exec pct-api printenv DATABASE_URL)" && test -n "$DBURL" && docker stop pct-api
```

Dump PCT's seven schemas and the migration ledger, then count and describe the source — about two minutes:

```bash
docker run --rm -v /root/pct-export:/w -e DBURL postgres:18 sh -c 'pg_dump "$DBURL" -Fc --no-owner --no-privileges -n app -n audit -n core -n ingest -n mart -n ops -n staging -f /w/stg.dump && pg_dump "$DBURL" -Fc --no-owner --no-privileges -t public.schema_migration -f /w/ledger.dump && psql "$DBURL" -At -f /w/count.sql > /w/stg.cnt && psql "$DBURL" -At -c "show server_version" -c "show timezone" > /w/stg.info'; docker start pct-api; unset DBURL
```

Staging is back up whatever the dump did (`docker start` runs either way). Then checksum and pack:

```bash
cd /root/pct-export && wc -l stg.cnt && cat stg.info && sha256sum stg.dump ledger.dump count.sql stg.cnt stg.info > SHA256SUMS && cd /root && tar -cf pct-export.tar pct-export && chmod 600 pct-export.tar && ls -lh pct-export.tar && sha256sum pct-export.tar
```

Write down the last line (the archive's checksum). `stg.cnt` should list about 140 tables.

## 2. Carry it — your PC

PowerShell or Command Prompt, with PuTTY's `pscp` (installed with PuTTY):

```bash
mkdir C:\pct-transfer
```

```bash
pscp root@172.28.92.57:/root/pct-export.tar C:\pct-transfer\
```

```bash
pscp C:\pct-transfer\pct-export.tar root@172.28.80.51:/root/
```

WinSCP works the same way if you prefer it. Do not put this file on a shared drive, e-mail or chat.

## 3. Production BE — 172.28.80.51 (PuTTY)

**Stop PCT** so nothing writes while the database is replaced:

```bash
cd /opt/pct && docker compose -f compose.yml stop api
```

**Check the archive arrived intact** — the first line must equal the checksum from §1, the rest must say `OK`:

```bash
cd /root && sha256sum pct-export.tar && tar -xf pct-export.tar && cd pct-export && sha256sum -c SHA256SUMS
```

**Connect to production** (this session only; nothing is printed):

```bash
export DBURL="$(grep '^DATABASE_URL=' /opt/pct/production.env | cut -d= -f2-)"; PG="docker run --rm -i -v /root/pct-export:/w -e DBURL postgres:18"
```

```bash
$PG sh -c 'psql "$DBURL" -At -c "show server_version" -c "show timezone"'; cat /root/pct-export/stg.info
```

The first block is production, the second staging. A different `timezone` is not a blocker (every timestamp
column is `timestamptz`), but note it.

**Replace production's schemas with staging's.** This drops PCT's seven schemas in the **production**
database — today they hold only the empty installation:

```bash
$PG sh -c 'psql "$DBURL" -v ON_ERROR_STOP=1 -c "SET client_min_messages = warning" -c "DROP SCHEMA IF EXISTS app, audit, core, ingest, mart, ops, staging CASCADE" -c "DROP TABLE IF EXISTS public.schema_migration"'
```

Prints `SET`, `DROP SCHEMA`, `DROP TABLE`. Then restore — several minutes for staging's ~3 million rows:

```bash
$PG sh -c 'pg_restore -d "$DBURL" --no-owner --no-privileges -j 4 /w/stg.dump; pg_restore -d "$DBURL" --no-owner --no-privileges /w/ledger.dump' 2> /root/pct-export/restore.err; grep -i 'error' /root/pct-export/restore.err | grep -viE 'transaction_timeout|errors ignored' | head -5; echo "real errors: $(grep -i 'error' /root/pct-export/restore.err | grep -viEc 'transaction_timeout|errors ignored')"
```

Must end `real errors: 0`. Filtered out on purpose: a PostgreSQL 18 dump sets `transaction_timeout`, which an
older server does not know — rehearsed 12 Nov 2026 against PostgreSQL 16, nine such lines and nothing else.
Any other error: stop and look.

**Prove the copy is complete** — every table's row count must match staging's:

```bash
$PG sh -c 'psql "$DBURL" -c "SET client_min_messages = error" -c "ANALYZE" > /dev/null && psql "$DBURL" -At -f /w/count.sql' > /root/pct-export/prd.cnt; wc -l /root/pct-export/*.cnt; diff /root/pct-export/stg.cnt /root/pct-export/prd.cnt && echo IDENTICAL
```

It must print `IDENTICAL`. Do not continue past a difference.

## 4. Remove what is staging's (production, one transaction)

```bash
$PG sh -c 'psql "$DBURL" -v ON_ERROR_STOP=1' <<'SQL'
BEGIN;
-- Staging Hub identities: cleared so each person's first production Hub sign-in links by e-mail.
-- auth_method 'sso' requires a subject, so these accounts are marked 'local' until they link.
UPDATE app.app_user SET sso_subject = NULL, auth_method = 'local' WHERE sso_subject IS NOT NULL;
-- No staging password reaches production.
DELETE FROM app.local_credential;
-- kpn-test Coupa tenant, staging Data Hub, staging run history.
TRUNCATE ops.coupa_raw, ops.coupa_po_line, ops.coupa_receipt, ops.coupa_invoice, ops.coupa_invoice_line,
         ops.coupa_payment, ops.coupa_sourcing_event, ops.coupa_supplier_response, ops.coupa_supplier,
         ops.coupa_exchange_rate, ops.coupa_watermark, ops.dhm_exchange_rate, ops.dhm_sync_state,
         ops.ingest_filing, ops.ingest_slot_run;
DELETE FROM ops.fx_rate_source WHERE source <> 'sap';
-- Staging's folders and schedules: production sets its own (section 6).
DELETE FROM app.rule_config WHERE rule_key IN ('ingest.feeds', 'ingest.share_path', 'ingest.archive_enabled',
  'ingest.archive_succeed_dir', 'ingest.archive_failed_dir', 'ingest.autopoll_enabled', 'coupa.sync_enabled');
COMMIT;
SELECT count(*) AS users,
       count(*) FILTER (WHERE email = 'jerry.hakim@energi-up.com') AS you,
       (SELECT count(*) FROM core.dataset_version) AS dataset_versions
  FROM app.app_user;
SQL
```

Ends with `COMMIT` and one row of counts. Any `ERROR` rolls the whole block back — paste it.

**Start PCT:**

```bash
cd /opt/pct && docker compose -f compose.yml up -d api && docker logs -f pct-api
```

Expect `applied 010a_base_roles.sql` (staging never needed it) and `listening on :3000`. Ctrl-C.

**Your local password** — §4 removed every password. If the counts said `you = 1`:

```bash
docker exec -it pct-api node dist/cli/set-password.js --email jerry.hakim@energi-up.com
```

If `you = 0`, add `--create-admin --name "Jerry Pratama Hakim"` to that line. Hub sign-in works either way:
it links to your account by e-mail on first use.

## 5. Delete every copy

**Production BE (172.28.80.51):**

```bash
unset DBURL PG; rm -rf /root/pct-export /root/pct-export.tar && ls /root | grep -c pct-export
```

**Staging BE (172.28.92.57):**

```bash
rm -rf /root/pct-export /root/pct-export.tar && ls /root | grep -c pct-export
```

Both must print `0`. **Your PC:**

```bash
del C:\pct-transfer\pct-export.tar && rmdir C:\pct-transfer
```

## 6. In PCT (browser)

1. Sign in at **http://172.28.80.50:3050** — Hub tile or the password from §4. Every other user signs in
   through the Hub: their account, roles and data scope are already there and link on first sign-in.
2. **Admin → SAP Data Upload → SAP Data Sync** — folder **`/mnt/pct-nas`** for all feeds, and the name
   patterns the production exports actually use. The defaults expect `PR Report*` / `PO Report*`; the files
   in `APPs\PCT` are named **`PR List …`** and **`PO List …`**, so set **PR = `PR List*.XLSX`**,
   **PO = `PO List*.XLSX`** (GR List, PR Release and PO Release already match). After-run filing on:
   `/mnt/pct-nas/succeed`, `/mnt/pct-nas/failed`. *Test / preview folders*, then save.
3. **Rebuild** once — the facts were built with the FX rates removed in §4; this recomputes them from SAP's.
4. **Sync now** — loads the exports in the folder on top of staging's history (feeds merge, nothing is lost).
   The `Initial …` and `Additional …` files match no feed and are left alone.
5. Check: Overview shows figures; Data Quality **V-B08 = 0**; Detail Table finds a recent PO.
6. **Coupa Sync** once the read-only production client is in `secrets.production.env` — starts from an
   empty store, so the first run takes a few minutes.

## Rollback

Nothing on staging changed. On production, before §6, the database can be returned to an empty install:
stop `api`, run the `DROP SCHEMA … CASCADE` line from §3 (it needs the `export DBURL` / `PG` line first),
start `api` (migrations rebuild it), then
`seed.js` and `set-password.js --create-admin` as in `DEPLOY_PRODUCTION.md` §6.
