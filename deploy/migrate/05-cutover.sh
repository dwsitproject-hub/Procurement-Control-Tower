#!/usr/bin/env bash
#
# Phase 5 — repoint the API at ApsaraDB and bring it back up.
#
# The only file that changes is /opt/pct/staging.env, and only its
# DATABASE_URL line. PCT reads that one variable from that one file: the
# compose `environment:` block sets REDIS_URL, SHARE_PATH and
# UPLOAD_SPOOL_PATH and never touches the database, so there is no second copy
# to forget and no precedence question to get wrong.
#
# Refuses to run unless 04-verify.sh has passed.

. "$(dirname "$0")/00-lib.sh"

ENV_TARGET="${ENV_TARGET:-/opt/pct/staging.env}"
COMPOSE="${COMPOSE:-/opt/pct/compose.yml}"

say "Gate: verification must have passed"
LATEST_REPORT="$(ls -1t "$WORKDIR"/verify-*.txt 2>/dev/null | head -1 || true)"
if [ -z "$LATEST_REPORT" ] || ! grep -q '^result: PASS' "$LATEST_REPORT"; then
  bad "no passing verification report in $WORKDIR -- run ./04-verify.sh"
  exit 1
fi
ok "$(basename "$LATEST_REPORT") says PASS"

[ -f "$ENV_TARGET" ] || { bad "$ENV_TARGET not found"; exit 1; }
[ -f "$COMPOSE" ]    || { bad "$COMPOSE not found"; exit 1; }

# -- The password has to survive being put inside a URI ------------------
#
# DATABASE_URL is a URI, so any of : / ? # [ ] @ & = + or a space in the
# ApsaraDB password changes where the parser thinks the host begins. A
# password containing '@' will make the app connect to a hostname that is part
# of the password, and the error it prints will name a host nobody recognises.
# Percent-encoding everything outside the unreserved set removes the question.
urlenc() {
  local s="$1" out="" i c
  for (( i=0; i<${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9.~_-]) out="$out$c" ;;
      *) out="$out$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}
ENC_USER="$(urlenc "$DST_USER")"
ENC_PASS="$(urlenc "$DST_PASSWORD")"
NEW_URL="postgres://${ENC_USER}:${ENC_PASS}@${DST_HOST}:${DST_PORT}/${DST_DB}"
if [ "$ENC_PASS" != "$DST_PASSWORD" ]; then
  ok "password contained URI-significant characters -- percent-encoded"
fi

# Prove the encoded URL actually connects BEFORE it goes into the env file.
# Otherwise the first thing that tests it is the API, at boot, with the old
# configuration already overwritten.
say "Testing the exact URL that will be written"
docker run --rm --network "$CLIENT_NETWORK" "$CLIENT_IMAGE" \
  psql "$NEW_URL" -v ON_ERROR_STOP=1 -At -c "SELECT 'connected as '||current_user||' to '||current_database()" \
  | sed 's/^/  /'
ok "the URL string works as written"

# -- Swap ---------------------------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ENV_TARGET.pre-apsaradb-$STAMP"
cp -p "$ENV_TARGET" "$BACKUP"
chmod 600 "$BACKUP"
ok "backed up -> $BACKUP  (99-rollback.sh reads this)"
echo "$BACKUP" > "$WORKDIR/ENV_BACKUP"

OLD_URL="$(grep '^DATABASE_URL=' "$ENV_TARGET" | head -1 | cut -d= -f2-)"
printf '%s\n' "$OLD_URL" > "$WORKDIR/OLD_DATABASE_URL"
chmod 600 "$WORKDIR/OLD_DATABASE_URL"

TMP="$(mktemp)"
# Written with awk rather than sed -i so the password never becomes part of a
# sed expression, where a '&' or a '/' in it would be interpreted.
NEW_URL="$NEW_URL" awk '
  /^DATABASE_URL=/ { print "DATABASE_URL=" ENVIRON["NEW_URL"]; next }
  { print }
' "$ENV_TARGET" > "$TMP"
grep -q '^DATABASE_URL=' "$TMP" || { bad "DATABASE_URL line vanished -- aborting"; rm -f "$TMP"; exit 1; }
cat "$TMP" > "$ENV_TARGET"
rm -f "$TMP"
chmod 600 "$ENV_TARGET"

say "What changed in $ENV_TARGET"
redact() { sed -E 's#//([^:]+):[^@]*@#//\1:***@#'; }
echo "  was: $(printf '%s' "$OLD_URL" | redact)"
echo "  now: $(grep '^DATABASE_URL=' "$ENV_TARGET" | cut -d= -f2- | redact)"

# -- Recreate, not restart ----------------------------------------------
#
# `docker compose start` reuses the container's existing environment: an
# env_file is read when a container is CREATED. Without --force-recreate the
# API comes back on the old database and everything looks fine.
say "Recreating the API container"
docker compose -f "$COMPOSE" up -d --force-recreate api

say "Waiting for the container's own healthcheck"
for i in $(seq 1 24); do
  H="$(docker inspect pct-api --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown)"
  [ "$H" = "healthy" ] && break
  [ "$i" = "24" ] && break
  sleep 5
done
echo "  health: $H"
if [ "$H" != "healthy" ]; then
  bad "API did not become healthy. Logs:"
  docker logs --tail 40 pct-api | sed 's/^/    /'
  bad "Roll back with ./99-rollback.sh -- the old database is untouched."
  exit 1
fi
ok "pct-api healthy on ApsaraDB"

say "Confirming the running process is on the new host"
docker inspect pct-api --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep '^DATABASE_URL=' | redact | sed 's/^/  /'
curl -fsS http://127.0.0.1:3000/api/v1/health | head -c 400 | sed 's/^/  /'
echo

say "Done"
ok "Cut over. Leave the old container-hosted database running and untouched"
ok "for a few days -- it is the rollback, and 99-rollback.sh is a one-liner"
ok "only while it still exists."
