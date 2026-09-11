#!/usr/bin/env bash
#
# Phase 2 — quiesce the application, take a custom-format dump, and refuse to
# hand on a dump that is provably incomplete.
#
# The API is stopped first. pg_dump takes a consistent snapshot, so a dump
# taken while the app runs is internally consistent -- but anything written
# after the snapshot is silently left behind, and on this application that
# means an ingest run or a published dataset version that exists on the old
# database and nowhere else. Stopping is a minute of downtime; losing a
# version is a re-ingest.

. "$(dirname "$0")/00-lib.sh"

[ -f "$WORKDIR/SOURCE_PLAIN_TABLES.txt" ] || {
  bad "no baseline found -- run ./01-preflight.sh first"; exit 1; }

EXPECTED="$(cat "$WORKDIR/SOURCE_PLAIN_TABLES.txt")"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="$WORKDIR/pct-$STAMP.dump"

# -- 1. Quiesce ---------------------------------------------------------
say "Stopping the API so nothing is written after the snapshot"
if docker inspect pct-api >/dev/null 2>&1; then
  RUNNING="$(docker inspect pct-api --format '{{.State.Running}}')"
  if [ "$RUNNING" = "true" ]; then
    docker stop pct-api
    echo "stopped" > "$WORKDIR/API_WAS_RUNNING"
    ok "pct-api stopped (05-cutover.sh brings it back on the new database;"
    ok "99-rollback.sh brings it back on the old one)"
  else
    ok "pct-api already stopped"
  fi
else
  warn "pct-api not on this host -- stop whatever writes to the source yourself"
fi

# Anything still connected after this point would be a second writer.
say "Sessions still connected to the source"
S "SELECT count(*)||' other session(s): '||COALESCE(string_agg(DISTINCT application_name, ', '),'-')
     FROM pg_stat_activity WHERE datname = '$SRC_DB' AND pid <> pg_backend_pid()" | sed 's/^/  /'

# -- 2. Dump ------------------------------------------------------------
#
# -Fc (custom) rather than plain SQL: it is the only format pg_restore can
# list, and the completeness gate below depends on that listing. Compression
# is pg_dump's default for this format.
say "Dumping to $(basename "$DUMP")"
docker run --rm --network "$CLIENT_NETWORK" --env-file "$SRC_ENV" \
  -v "$WORKDIR:/w" "$CLIENT_IMAGE" \
  pg_dump -h "$SRC_HOST" -p "$SRC_PORT" -U "$SRC_USER" -d "$SRC_DB" \
          -Fc --verbose -f "/w/$(basename "$DUMP")" 2> "$WORKDIR/dump-$STAMP.log"

[ -s "$DUMP" ] || { bad "dump file is empty -- see dump-$STAMP.log"; exit 1; }
ok "dump written: $(du -h "$DUMP" | cut -f1)"
sha256sum "$DUMP" | tee "$DUMP.sha256" | sed 's/^/  /'

# -- 3. The completeness gate -------------------------------------------
#
# PCT-SPECIFIC, and the one place the KLIP runbook must not be followed
# literally. Its gate is "TABLE DATA count == number of base tables". This
# schema has six LIST-partitioned parents, and pg_dump emits NO TABLE DATA
# entry for a partitioned parent -- the rows belong to the partitions, which
# get their own entries. Measured: 137 base tables, 6 of them parents, 131
# TABLE DATA entries. The unmodified gate would reject a perfectly good dump.
#
# So the expectation is the count of relkind='r' relations (plain tables,
# partitions included), captured by 01-preflight.sh.
say "Completeness gate"
LIST="$WORKDIR/toc-$STAMP.txt"
docker run --rm -v "$WORKDIR:/w" "$CLIENT_IMAGE" \
  pg_restore -l "/w/$(basename "$DUMP")" > "$LIST"
FOUND="$(grep -c 'TABLE DATA' "$LIST" || true)"
echo "  TABLE DATA entries in the dump: $FOUND"
echo "  plain tables on the source:     $EXPECTED  (relkind='r', partitions included)"
if [ "$FOUND" = "$EXPECTED" ]; then
  ok "every table that can carry data is represented"
else
  bad "MISMATCH -- do not restore this dump."
  bad "Compare the listing in $(basename "$LIST") against SOURCE_ROWS.txt to find what is missing."
  exit 1
fi

# A dump can pass the count and still have lost a partition's rows, so record
# what the archive claims to contain, per table, for 04-verify.sh to read.
grep 'TABLE DATA' "$LIST" | awk '{print $(NF-1)"."$NF}' | sort > "$WORKDIR/DUMP_TABLES.txt"
ok "table list recorded -> DUMP_TABLES.txt"

echo "$DUMP" > "$WORKDIR/LATEST_DUMP"
say "Next"
ok "./03-restore.sh   (restores $(basename "$DUMP") into ApsaraDB)"
