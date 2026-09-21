#!/usr/bin/env bash
#
# Purge the Coupa store after a tenant change, safely.
#
# Run this ON the API server (staging: 172.28.92.57), from the folder that holds
# the compose files and staging.env:
#
#   cd /opt/pct
#   bash purge-coupa-tenant-data.sh              # dry run: shows what it would do
#   bash purge-coupa-tenant-data.sh --yes        # does it
#
# It does four things in order, and stops at the first that looks wrong:
#
#   1. reads COUPA_BASE_URL out of the RUNNING container and refuses if it still
#      names the tenant being left behind -- purging while still pointed at the
#      old tenant just re-downloads the data this file deleted;
#   2. prints the row counts that are about to disappear;
#   3. dumps every affected table to a timestamped .sql file, because the
#      database cannot undo what comes next;
#   4. runs purge-coupa-tenant-data.sql.
#
# The re-sync is NOT done here. Trigger it from Admin -> Coupa -> Sync now, so a
# cold full run against the new tenant is watched by a person rather than
# started by a script that has already exited.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-./staging.env}"
CONTAINER="${CONTAINER:-pct-api}"
CLIENT_IMAGE="${CLIENT_IMAGE:-postgres:18-bookworm}"
# Substring that identifies the tenant being LEFT. The script refuses to purge
# while the container still points at it.
OLD_HOST_MATCH="${OLD_HOST_MATCH:--test.}"
BACKUP_DIR="${BACKUP_DIR:-./coupa-purge-backup}"

APPLY=0
[ "${1:-}" = "--yes" ] && APPLY=1

say() { printf '\n== %s ==\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

# -- 1. the tenant the app is actually talking to --------------------------
say "which Coupa tenant is the container on"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container $CONTAINER is not running here"
HOST="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' \
        | sed -n 's/^COUPA_BASE_URL=//p' | head -1)"
[ -n "$HOST" ] || die "COUPA_BASE_URL is not set in $CONTAINER -- the sync is not configured, so there is nothing to re-pull"
echo "COUPA_BASE_URL = $HOST"
case "$HOST" in
  *"$OLD_HOST_MATCH"*)
    die "that is still the OLD tenant ($OLD_HOST_MATCH). Point the container at the new one and restart it first:
       edit secrets.staging.env, then: docker compose -f be.compose.yml up -d --force-recreate api" ;;
esac
echo "not the old tenant -- ok"

# -- the database, taken from the same env file the app uses ---------------
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found (set ENV_FILE=/path/to/staging.env)"
DB_URL="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | head -1)"
[ -n "$DB_URL" ] || die "DATABASE_URL is not in $ENV_FILE"
# Never print the URL: it carries the password.
echo "database  = $(printf '%s' "$DB_URL" | sed 's#://[^@]*@#://***@#')"

psql_() {
  docker run --rm -i --network host -e PGURL="$DB_URL" "$CLIENT_IMAGE" \
    sh -c 'psql "$PGURL" "$@"' sh "$@"
}

# -- 2. what is about to go ------------------------------------------------
say "what this would delete"
psql_ -v ON_ERROR_STOP=1 -q -c "
  SELECT 'ops.coupa_raw' AS table, count(*) FROM ops.coupa_raw
  UNION ALL SELECT 'ops.coupa_sourcing_event',    count(*) FROM ops.coupa_sourcing_event
  UNION ALL SELECT 'ops.coupa_supplier_response', count(*) FROM ops.coupa_supplier_response
  UNION ALL SELECT 'ops.coupa_supplier',          count(*) FROM ops.coupa_supplier
  UNION ALL SELECT 'ops.coupa_po_line',           count(*) FROM ops.coupa_po_line
  UNION ALL SELECT 'ops.coupa_receipt',           count(*) FROM ops.coupa_receipt
  UNION ALL SELECT 'ops.coupa_invoice',           count(*) FROM ops.coupa_invoice
  UNION ALL SELECT 'ops.coupa_invoice_line',      count(*) FROM ops.coupa_invoice_line
  UNION ALL SELECT 'ops.coupa_payment',           count(*) FROM ops.coupa_payment
  UNION ALL SELECT 'ops.coupa_exchange_rate',     count(*) FROM ops.coupa_exchange_rate
  UNION ALL SELECT 'ops.coupa_watermark',         count(*) FROM ops.coupa_watermark
  UNION ALL SELECT 'fx_rate_source coupa (goes)', count(*) FROM ops.fx_rate_source WHERE source = 'coupa'
  UNION ALL SELECT 'fx_rate_source sap (KEPT)',   count(*) FROM ops.fx_rate_source WHERE source = 'sap'
  ORDER BY 1;"

if [ "$APPLY" -ne 1 ]; then
  say "dry run"
  echo "Nothing was changed. Re-run with --yes to take the backup and purge."
  exit 0
fi

# -- 3. the backup ---------------------------------------------------------
say "backup"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/coupa-ops-$STAMP.sql"
docker run --rm -e PGURL="$DB_URL" "$CLIENT_IMAGE" \
  sh -c 'pg_dump "$PGURL" --data-only --no-owner \
           -t "ops.coupa_*" -t ops.fx_rate_source' > "$OUT"
[ -s "$OUT" ] || die "the dump came out empty -- refusing to purge"
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
echo "restore, if ever needed:  psql \"\$DATABASE_URL\" -f $OUT"

# -- 4. the purge ----------------------------------------------------------
say "purge"
psql_ -v ON_ERROR_STOP=1 -f - < "$HERE/purge-coupa-tenant-data.sql"

say "next"
cat <<'NEXT'
1. Admin -> Coupa -> Sync now. Watermarks are cleared, so this is a COLD FULL
   pull and takes far longer than a poll tick; the page shows per-object
   progress and the run keeps going after the request returns.
2. When every object reads ok, Admin -> SAP Data Upload -> Recompute. The
   published dataset still carries core.fx_rate rows converted at the OLD
   tenant's rates; nothing on screen changes until a recompute rebuilds them.
NEXT
