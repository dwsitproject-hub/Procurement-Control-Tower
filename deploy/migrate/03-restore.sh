#!/usr/bin/env bash
#
# Phase 3 — restore into ApsaraDB, then plan it.
#
# Two deliberate choices:
#
#   --no-owner --no-privileges   The source objects are owned by the role
#     `pct`, which does not exist on the managed instance and cannot be created
#     there. Without these the restore reports an error per object and leaves
#     ownership wherever it lands.
#
#   ANALYZE, immediately, not "later"                A freshly restored
#     database has no statistics. Every planner decision is then made on
#     guesses, and on this schema that is the difference between a partition
#     scan and a sequential scan of every version -- the KLIP migration
#     measured a six-fold slowdown from exactly this omission. It is part of
#     the restore, not an optimisation.

. "$(dirname "$0")/00-lib.sh"

[ -f "$WORKDIR/LATEST_DUMP" ] || { bad "no dump recorded -- run ./02-dump.sh"; exit 1; }
DUMP="$(cat "$WORKDIR/LATEST_DUMP")"
[ -s "$DUMP" ] || { bad "$DUMP is missing or empty"; exit 1; }
BASE="$(basename "$DUMP")"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$WORKDIR/restore-$STAMP.log"

say "Verifying the dump has not changed since it was gated"
sha256sum -c "$DUMP.sha256" | sed 's/^/  /'

# -- 1. Extensions, explicitly ------------------------------------------
#
# Done as its own step so a managed-instance permission refusal is one clear
# failure here, rather than three lines buried in a restore log. All three are
# trusted extensions from PG13 on, so the database owner is enough.
say "Creating extensions on the target"
for e in citext pg_trgm pgcrypto; do
  R "CREATE EXTENSION IF NOT EXISTS $e" >/dev/null && ok "$e"
done

# -- 2. Restore ---------------------------------------------------------
#
# -j 4 restores table data and indexes in parallel. It is safe with
# partitioned tables and it is most of the wall-clock saving on a 116 MB dump
# with 420 indexes to rebuild.
#
# No --clean and no DROP SCHEMA: 01-preflight.sh already refused to continue
# against a non-empty target, which is the safe way to get the same guarantee
# on an instance whose provider schemas must survive.
say "Restoring $BASE into $DST_DB on ApsaraDB"
set +e
docker run --rm --network "$CLIENT_NETWORK" --env-file "$DST_ENV" \
  -v "$WORKDIR:/w" "$CLIENT_IMAGE" \
  pg_restore -h "$DST_HOST" -p "$DST_PORT" -U "$DST_USER" -d "$DST_DB" \
             --no-owner --no-privileges --no-tablespaces \
             -j 4 --verbose "/w/$BASE" > "$LOG" 2>&1
RC=$?
set -e
echo "  pg_restore exit status: $RC"

# pg_restore exits non-zero for a single ignorable warning, so the status alone
# decides nothing. Classify the errors instead.
ERRORS="$(grep -c '^pg_restore: error' "$LOG" || true)"
BENIGN="$(grep '^pg_restore: error' "$LOG" | grep -c -E 'already exists|must be owner of (schema|extension) ' || true)"
REAL=$(( ERRORS - BENIGN ))
echo "  errors reported: $ERRORS   ignorable (already-exists / provider-owned schema): $BENIGN"
if [ "$REAL" -gt 0 ]; then
  bad "$REAL error(s) need reading before you trust this restore:"
  grep '^pg_restore: error' "$LOG" | grep -v -E 'already exists|must be owner of (schema|extension) ' | head -20 | sed 's/^/    /'
  bad "full log: $LOG"
  bad "Stop here. Do not cut over. 99-rollback.sh is not needed yet -- nothing"
  bad "has been pointed at the new database."
  exit 1
fi
ok "no unexplained restore errors"

# -- 3. Statistics ------------------------------------------------------
say "ANALYZE (not optional -- see the header)"
docker run --rm --network "$CLIENT_NETWORK" --env-file "$DST_ENV" \
  -v "$WORKDIR:/w" "$CLIENT_IMAGE" \
  vacuumdb -h "$DST_HOST" -p "$DST_PORT" -U "$DST_USER" -d "$DST_DB" \
           --analyze-only -j 4 2>&1 | tail -3 | sed 's/^/  /'

STALE="$(R "SELECT count(*) FROM pg_stat_user_tables t
             JOIN pg_class c ON c.oid = t.relid
            WHERE t.last_analyze IS NULL AND t.last_autoanalyze IS NULL
              AND c.relkind = 'r' AND c.reltuples <> 0")"
if [ "$STALE" = "0" ]; then
  ok "every non-empty table has statistics"
else
  warn "$STALE non-empty table(s) still have no statistics -- re-run the ANALYZE step"
fi

say "Next"
ok "./04-verify.sh   (diffs the new database against the baselines)"
