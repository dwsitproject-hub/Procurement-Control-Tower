#!/usr/bin/env bash
#
# Phase 1 — prove what we are migrating, and prove the target can hold it.
#
# Nothing here writes to either database. It is safe to run as often as you
# like, and it should be run again right before the dump, because the answer to
# "is the target empty" changes.
#
# Run on the BE server (172.28.92.57), where both the API container and a route
# to ApsaraDB exist.

. "$(dirname "$0")/00-lib.sh"

FAILED=0

# -- 1. What is the application ACTUALLY connected to? -------------------
#
# The runbook's near-miss: the config file said one host and the running
# process used another. PCT keeps its connection in a single DATABASE_URL, so
# there is one place to be wrong -- but the authority is still the process, not
# the file.
say "Source of truth: the running API container"
if docker inspect pct-api >/dev/null 2>&1; then
  LIVE_URL="$(docker inspect pct-api --format '{{range .Config.Env}}{{println .}}{{end}}' \
               | grep '^DATABASE_URL=' | head -1 | cut -d= -f2-)"
  if [ -z "$LIVE_URL" ]; then
    bad "pct-api has no DATABASE_URL in its environment"
    FAILED=1
  else
    # Redact the password before anything is printed or logged.
    echo "  live DATABASE_URL: $(echo "$LIVE_URL" | sed -E 's#//([^:]+):[^@]*@#//\1:***@#')"
    LIVE_HOSTPORT="$(echo "$LIVE_URL" | sed -E 's#^[a-z]+://[^@]*@([^/?]+).*#\1#')"
    LIVE_DB="$(echo "$LIVE_URL" | sed -E 's#^[a-z]+://[^@]*@[^/]+/([^?]+).*#\1#')"
    if [ "$LIVE_HOSTPORT" = "$SRC_HOST:$SRC_PORT" ] && [ "$LIVE_DB" = "$SRC_DB" ]; then
      ok "migrate.env source matches the running container"
    else
      bad "migrate.env says $SRC_HOST:$SRC_PORT/$SRC_DB but the container uses $LIVE_HOSTPORT/$LIVE_DB"
      FAILED=1
    fi
  fi
else
  warn "pct-api not found on this host -- cannot cross-check the source"
fi

# -- 2. Both sides reachable, and on what --------------------------------
say "Server versions and session timezone"
SRC_VER="$(S 'SHOW server_version')" || { bad "cannot reach the source"; exit 1; }
SRC_TZ="$(S 'SHOW TimeZone')"
echo "  source      PostgreSQL $SRC_VER   TimeZone=$SRC_TZ"

DST_VER="$(R 'SHOW server_version')" || {
  bad "cannot reach ApsaraDB -- add this server's IP to the RDS whitelist"; exit 1; }
DST_TZ="$(R 'SHOW TimeZone')"
echo "  destination PostgreSQL $DST_VER   TimeZone=$DST_TZ"

DST_MAJOR="$(echo "$DST_VER" | cut -d. -f1)"
echo "postgres:${DST_MAJOR}-bookworm" > "$CLIENT_VERSION_FILE"
ok "client image pinned to postgres:${DST_MAJOR}-bookworm (matches the destination)"
CLIENT_IMAGE="postgres:${DST_MAJOR}-bookworm"

# A timezone difference is not fatal for PCT the way it was for KLIP: every
# timestamp column in this schema is timestamptz, which stores an absolute
# instant, so a session timezone changes how a value is displayed and never
# what it means. It still decides where a `date` column's day boundary falls,
# and 276 columns are plain dates, so a mismatch is reported and worth fixing.
if [ "$SRC_TZ" = "$DST_TZ" ]; then
  ok "timezones match"
else
  warn "timezone differs ($SRC_TZ -> $DST_TZ). All 67 timestamp columns are"
  warn "timestamptz so stored instants are unaffected, but set the ApsaraDB"
  warn "parameter group timezone to $SRC_TZ so date boundaries agree."
fi

# -- 3. Extensions ------------------------------------------------------
#
# PCT uses three beyond plpgsql. All three are 'trusted' from PG13 on, so the
# database owner can create them without superuser -- but they must be
# installed on the instance, and on a managed service that is the provider's
# decision, not ours. Find out now, not halfway through a restore.
say "Extensions"
S "SELECT extname||' '||extversion FROM pg_extension ORDER BY 1" | sed 's/^/  source      /'
R "SELECT extname||' '||extversion FROM pg_extension ORDER BY 1" | sed 's/^/  destination /'
for e in citext pg_trgm pgcrypto; do
  avail="$(R "SELECT count(*) FROM pg_available_extensions WHERE name = '$e'")"
  if [ "$avail" = "1" ]; then
    ok "$e is available on ApsaraDB"
  else
    bad "$e is NOT available on ApsaraDB -- enable it in the console first"
    FAILED=1
  fi
done

# -- 4. Is the target empty? --------------------------------------------
#
# The runbook's hard rule: never DROP SCHEMA to make room. On a managed
# instance that can cascade into provider objects. So we require an empty
# target instead and stop if it is not.
say "Target emptiness (only the eight schemas this app owns)"
EXISTING="$(R "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE c.relkind IN ('r','p','v','S') AND n.nspname IN ($PCT_SCHEMAS)")"
if [ "$EXISTING" = "0" ]; then
  ok "target has no application objects"
else
  bad "target already holds $EXISTING objects in the application schemas"
  bad "Do NOT drop schemas on a managed instance. Either use a fresh database,"
  bad "or review what is there:  ./01-preflight.sh --list-target"
  FAILED=1
fi
if [ "${1:-}" = "--list-target" ]; then
  R "SELECT n.nspname||'.'||c.relname||' ('||c.relkind::text||')'
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','v','S') AND n.nspname IN ($PCT_SCHEMAS) ORDER BY 1"
fi

# -- 4b. Can the API container actually be recreated? -------------------
#
# Learned the hard way on 11 Sep 2026. The migration itself went perfectly and
# then 05-cutover.sh could not start the container at all:
#
#   error while creating mount source path '/mnt/synology-apps':
#   mkdir /mnt/synology-apps: file exists
#
# The NAS had become unreachable (another stack's Docker network took
# 172.30.0.0/16), which leaves CIFS in a state where findmnt still lists the
# mount but every read fails with "Host is down" -- and Docker refuses to bind
# a mount source it cannot stat. Nothing to do with the database, but it turned
# a clean cutover into an outage of unknown length, discovered AFTER the API
# had been stopped.
#
# So every bind source the running container uses is stat'ed here, while the
# app is still up and stopping costs nothing. `timeout` because a read against
# a dead CIFS mount hangs rather than failing.
say "Host paths the API's bind mounts point at"
if docker inspect pct-api >/dev/null 2>&1; then
  docker inspect pct-api \
    --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\n"}}{{end}}{{end}}' \
    2>/dev/null | sed '/^$/d' > "$WORKDIR/.binds"
  # Read from a FILE, not a pipe: a piped while-loop runs in a subshell and its
  # FAILED=1 would be discarded.
  while IFS= read -r src; do
    if timeout 5 ls -d "$src" >/dev/null 2>&1; then
      ok "$src"
    else
      bad "$src is NOT accessible -- the container cannot be recreated"
      bad "  a stale CIFS mount looks mounted to findmnt and fails every read:"
      bad "  umount -l <path> && mount -a    (Docs/DEPLOY_STAGING.md section 10)"
      FAILED=1
    fi
  done < "$WORKDIR/.binds"
  rm -f "$WORKDIR/.binds"
else
  warn "pct-api not on this host -- cannot check its bind mounts"
fi

# -- 5. Baselines, to files ---------------------------------------------
#
# Written to disk rather than eyeballed, because 04-verify.sh diffs against
# them after the restore and a number remembered from a screen is not evidence.
say "Capturing source baselines"

ROWS_SQL="SELECT n.nspname||'.'||c.relname,
                 (xpath('/row/c/text()',
                        query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname),
                                     false, true, '')))[1]::text::bigint
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r','p') AND NOT c.relispartition
             AND n.nspname IN ($PCT_SCHEMAS)
           ORDER BY 1"
S "$ROWS_SQL" > "$WORKDIR/SOURCE_ROWS.txt"
ok "row counts: $(wc -l < "$WORKDIR/SOURCE_ROWS.txt") top-level tables -> SOURCE_ROWS.txt"

SEQS_SQL="SELECT schemaname||'.'||sequencename||'|'||COALESCE(last_value::text,'unset')
            FROM pg_sequences WHERE schemaname IN ($PCT_SCHEMAS) ORDER BY 1"
S "$SEQS_SQL" > "$WORKDIR/SOURCE_SEQS.txt"
ok "sequences: $(wc -l < "$WORKDIR/SOURCE_SEQS.txt") -> SOURCE_SEQS.txt"

# Object census. 'r' is what pg_dump emits TABLE DATA for; 'p' parents get
# none, which is the whole reason 02-dump.sh computes its gate from 'r' alone.
OBJ_SQL="SELECT c.relkind::text||'|'||count(*) FROM pg_class c
           JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ($PCT_SCHEMAS) AND c.relkind IN ('r','p','v','m','S','i')
          GROUP BY c.relkind ORDER BY 1"
S "$OBJ_SQL" > "$WORKDIR/SOURCE_OBJECTS.txt"
sed 's/^/  /' "$WORKDIR/SOURCE_OBJECTS.txt"
PLAIN_TABLES="$(grep '^r|' "$WORKDIR/SOURCE_OBJECTS.txt" | cut -d'|' -f2)"
echo "$PLAIN_TABLES" > "$WORKDIR/SOURCE_PLAIN_TABLES.txt"
ok "expected TABLE DATA entries in the dump: $PLAIN_TABLES"

# Partition layout, so a parent that arrives with fewer children is visible.
PARTS_SQL="SELECT p.relname||'|'||count(*) FROM pg_inherits i
             JOIN pg_class p ON p.oid = i.inhparent
             JOIN pg_namespace n ON n.oid = p.relnamespace
            WHERE n.nspname IN ($PCT_SCHEMAS) AND p.relkind = 'p'
            GROUP BY p.relname ORDER BY 1"
S "$PARTS_SQL" > "$WORKDIR/SOURCE_PARTITIONS.txt"
ok "partitions: $(awk -F'|' '{s+=$2} END {print s+0}' "$WORKDIR/SOURCE_PARTITIONS.txt") across $(wc -l < "$WORKDIR/SOURCE_PARTITIONS.txt") parents"

# Applied migrations. If the API boots against a target missing these rows it
# will try to re-run every migration against a populated schema.
S "SELECT count(*) FROM public.schema_migration" > "$WORKDIR/SOURCE_MIGRATIONS.txt"
ok "schema_migration rows: $(cat "$WORKDIR/SOURCE_MIGRATIONS.txt")"

# -- 6. Room to work ----------------------------------------------------
say "Disk"
df -h "$WORKDIR" | sed 's/^/  /'
SRC_SIZE="$(S "SELECT pg_size_pretty(pg_database_size('$SRC_DB'))")"
echo "  source database size: $SRC_SIZE"

say "Result"
if [ "$FAILED" = "0" ]; then
  ok "pre-flight passed -- safe to run 02-dump.sh"
else
  bad "pre-flight FAILED -- fix the items above before dumping"
  exit 1
fi
