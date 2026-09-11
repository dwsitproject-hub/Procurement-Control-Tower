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

# Wait for a container to become healthy, distinguishing "still booting" from
# "failed".
#
# The API's healthcheck is start_period 20s + interval 10s + retries 12, so
# Docker can take 140 SECONDS to decide a fresh container is unhealthy. An
# earlier version of this waited 120s and then told the operator to roll back
# -- a false failure, and on a first boot against a REMOTE database (every
# migration verified over the network) the likely outcome rather than an edge
# case.
#
# So: wait up to five minutes, treat "starting" as patience rather than
# failure, and bail out early only on a real failing streak, which a fresh
# container cannot report until its start period and retries are exhausted.
wait_healthy() {
  local name="$1" budget="${2:-300}" waited=0 st streak running
  while [ "$waited" -lt "$budget" ]; do
    # A container that EXITED will never report a health status, so waiting the
    # full budget on one is pure delay -- and an API that cannot reach its
    # database exits at boot, which makes this the most likely failure of a
    # cutover rather than an unlikely one. Ten seconds of grace, because
    # compose reports "created" for a moment before it starts.
    running="$(docker inspect "$name" --format '{{.State.Running}}' 2>/dev/null || echo missing)"
    if [ "$running" != "true" ] && [ "$waited" -ge 10 ]; then
      printf '  container is not running after %ss (state=%s, exit code %s)\n' \
        "$waited" "$running" \
        "$(docker inspect "$name" --format '{{.State.ExitCode}}' 2>/dev/null || echo '?')"
      return 1
    fi
    st="$(docker inspect "$name" \
            --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
          2>/dev/null || echo missing)"
    if [ "$st" = "healthy" ]; then
      printf '  healthy after %ss\n' "$waited"; return 0
    fi
    if [ "$st" = "none" ] && [ "$running" = "true" ]; then
      # No healthcheck on this container: running is all we can assert.
      printf '  running after %ss (container defines no healthcheck)\n' "$waited"; return 0
    fi
    if [ "$st" = "unhealthy" ]; then
      streak="$(docker inspect "$name" --format '{{.State.Health.FailingStreak}}' 2>/dev/null || echo 0)"
      if [ "${streak:-0}" -ge 3 ]; then
        printf '  unhealthy after %ss (failing streak %s)\n' "$waited" "$streak"; return 1
      fi
    fi
    sleep 5
    waited=$(( waited + 5 ))
  done
  printf '  gave up after %ss -- last status: %s\n' "$budget" "$st"
  return 1
}

# The last thing the healthcheck actually printed, which is usually the answer.
health_detail() {
  docker inspect "$1" --format \
    '{{if .State.Health}}{{range .State.Health.Log}}{{.ExitCode}} {{.Output}}{{end}}{{end}}' \
    2>/dev/null | sed '/^$/d' | tail -5
}

say()  { printf '\n=== %s\n' "$*"; }
ok()   { printf '  OK    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }
