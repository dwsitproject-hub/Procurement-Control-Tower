# Shared helpers for the ApsaraDB migration scripts. Sourced, not run.
#
# Two rules this file exists to enforce:
#
#  1. Every value comes from migrate.env. No script contains a host, a port or
#     a password, so there is no placeholder anyone can paste over and no
#     second copy to drift.
#  2. Passwords never appear in a command line (ps, shell history, docker
#     inspect). They are passed as PGPASSWORD in the container environment via
#     --env-file, which is why S() and R() exist instead of a bare psql call.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$HERE/migrate.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: $ENV_FILE not found. Copy migrate.env.template and fill it." >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

for v in SRC_HOST SRC_PORT SRC_DB SRC_USER SRC_PASSWORD \
         DST_HOST DST_PORT DST_DB DST_USER DST_PASSWORD WORKDIR; do
  if [ -z "${!v:-}" ]; then
    echo "FATAL: $v is empty in $ENV_FILE" >&2
    exit 1
  fi
done

mkdir -p "$WORKDIR"
chmod 700 "$WORKDIR"

# The client container's major version must match the DESTINATION, never the
# source: pg_restore refuses an archive newer than itself, and a 16 client
# cannot write an 18 catalogue. 01-preflight.sh detects the destination version
# and writes it here; until then we bootstrap with a client new enough to talk
# to anything, purely to run SHOW server_version.
CLIENT_VERSION_FILE="$WORKDIR/client-image"
BOOTSTRAP_CLIENT="postgres:18-bookworm"
if [ -f "$CLIENT_VERSION_FILE" ]; then
  CLIENT_IMAGE="$(cat "$CLIENT_VERSION_FILE")"
else
  CLIENT_IMAGE="$BOOTSTRAP_CLIENT"
fi

# The client container runs on the host network by default: that reaches a
# remote host, a NAT'd endpoint and a port published on 127.0.0.1 alike, which
# is what the BE server needs. Override with CLIENT_NETWORK=bridge to rehearse
# the whole sequence against a database reachable only as
# host.docker.internal (Docker Desktop), which is how these scripts were
# tested before they were pointed at anything real.
CLIENT_NETWORK="${CLIENT_NETWORK:-host}"

# Credentials are written to two 0600 files rather than interpolated into the
# docker command line.
SRC_ENV="$WORKDIR/.src.env"
DST_ENV="$WORKDIR/.dst.env"
umask 077
printf 'PGPASSWORD=%s\n' "$SRC_PASSWORD" > "$SRC_ENV"
printf 'PGPASSWORD=%s\n' "$DST_PASSWORD" > "$DST_ENV"

# S "SQL"  -> run against the SOURCE, tuples only, pipe-separated
# R "SQL"  -> run against the DESTINATION, same
# Both take extra psql arguments after the SQL, so a caller can add -f or
# change the output format.
S() {
  local sql="$1"; shift || true
  docker run --rm --network "$CLIENT_NETWORK" --env-file "$SRC_ENV" \
    -v "$WORKDIR:/w" "$CLIENT_IMAGE" \
    psql -h "$SRC_HOST" -p "$SRC_PORT" -U "$SRC_USER" -d "$SRC_DB" \
         -v ON_ERROR_STOP=1 -At -F'|' -c "$sql" "$@"
}
R() {
  local sql="$1"; shift || true
  docker run --rm --network "$CLIENT_NETWORK" --env-file "$DST_ENV" \
    -v "$WORKDIR:/w" "$CLIENT_IMAGE" \
    psql -h "$DST_HOST" -p "$DST_PORT" -U "$DST_USER" -d "$DST_DB" \
         -v ON_ERROR_STOP=1 -At -F'|' -c "$sql" "$@"
}

# The eight schemas this application owns. Every count, diff and drop is
# confined to these: an ApsaraDB instance carries provider schemas of its own,
# and a migration that touches them breaks the instance, not the app.
PCT_SCHEMAS="'app','audit','core','ingest','mart','ops','public','staging'"

say()  { printf '\n=== %s\n' "$*"; }
ok()   { printf '  OK    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }
