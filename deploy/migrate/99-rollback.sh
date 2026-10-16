#!/usr/bin/env bash
#
# Rollback — put the API back on the container-hosted database.
#
# Deliberately standalone: it does not source 00-lib.sh, does not read
# migrate.env, and needs no ApsaraDB credentials. A rollback is run when
# something is wrong, sometimes by someone who was not driving the migration,
# and it must not be able to fail because a config file is missing. Everything
# it needs is on disk, written by 05-cutover.sh.
#
# What it does NOT do: touch either database. The old one was never written to
# after the dump; the new one is simply left alone. Rolling back is a config
# change and a container recreate, nothing more.
#
# Usage:  ./99-rollback.sh
#         ./99-rollback.sh /opt/pct/staging.env.pre-apsaradb-20260911-101500

set -euo pipefail

ENV_TARGET="${ENV_TARGET:-/opt/pct/staging.env}"
COMPOSE="${COMPOSE:-/opt/pct/compose.yml}"
POINTER="/opt/pct/migrate/ENV_BACKUP"

BACKUP="${1:-}"
if [ -z "$BACKUP" ]; then
  if [ -f "$POINTER" ]; then
    BACKUP="$(cat "$POINTER")"
  else
    BACKUP="$(ls -1t "$ENV_TARGET".pre-apsaradb-* 2>/dev/null | head -1 || true)"
  fi
fi

if [ -z "$BACKUP" ] || [ ! -f "$BACKUP" ]; then
  echo "FATAL: no pre-cutover backup of $ENV_TARGET found." >&2
  echo "Candidates:" >&2
  ls -1t "$ENV_TARGET".pre-apsaradb-* 2>/dev/null >&2 || echo "  (none)" >&2
  echo >&2
  echo "If none exist, edit $ENV_TARGET by hand and set:" >&2
  echo "  DATABASE_URL=postgres://pct:<POSTGRES_PASSWORD from 172.28.92.60:/opt/pct/db.env>@172.28.92.60:5436/pct" >&2
  echo "then: docker compose -f $COMPOSE up -d --force-recreate api" >&2
  exit 1
fi

echo "=== Restoring $ENV_TARGET from $BACKUP"
cp -p "$ENV_TARGET" "$ENV_TARGET.rolledback-$(date +%Y%m%d-%H%M%S)"
cat "$BACKUP" > "$ENV_TARGET"
chmod 600 "$ENV_TARGET"
grep '^DATABASE_URL=' "$ENV_TARGET" | sed -E 's#//([^:]+):[^@]*@#//\1:***@#' | sed 's/^/  restored: /'

# The old database must still be there. If the container was removed, the
# config is right and the rollback is still incomplete -- say so now rather
# than let the API fail to boot.
echo "=== Checking the old database is still up"
if docker -H "ssh://root@172.28.92.60" ps --filter name=pct-postgres --format '{{.Status}}' 2>/dev/null | grep -q Up; then
  echo "  pct-postgres is running on 172.28.92.60"
else
  echo "  WARNING: could not confirm pct-postgres on 172.28.92.60 from here."
  echo "  Check on the DB server:  docker ps --filter name=pct-postgres"
fi

# --force-recreate, not start: an env_file is read at container creation.
echo "=== Recreating the API container"
docker compose -f "$COMPOSE" up -d --force-recreate api

# Duplicated from 00-lib.sh deliberately: this script has to work when
# migrate.env or the library is gone. Five minutes, and "starting" is not a
# failure -- the healthcheck needs up to 140s to reach a verdict.
waited=0
while [ "$waited" -lt 300 ]; do
  H="$(docker inspect pct-api \
         --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
       2>/dev/null || echo missing)"
  if [ "$H" = "healthy" ]; then break; fi
  if [ "$H" = "unhealthy" ]; then
    STREAK="$(docker inspect pct-api --format '{{.State.Health.FailingStreak}}' 2>/dev/null || echo 0)"
    if [ "${STREAK:-0}" -ge 3 ]; then break; fi
  fi
  sleep 5
  waited=$(( waited + 5 ))
done
echo "  health: $H after ${waited}s"
if [ "$H" != "healthy" ]; then
  echo "  API still not healthy after rollback. Logs:" >&2
  docker logs --tail 40 pct-api >&2
  exit 1
fi
echo "=== Rolled back. The API is on 172.28.92.60:5436/pct again."
