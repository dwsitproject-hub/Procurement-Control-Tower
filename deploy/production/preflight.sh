#!/usr/bin/env bash
# PCT production preflight - READ-ONLY. Changes nothing on this host.
#
#   bash /opt/pct/src/deploy/production/preflight.sh be     # on the BE server
#   bash /opt/pct/src/deploy/production/preflight.sh fe     # on the FE server
#
# Reports what the guide (Docs/DEPLOY_PRODUCTION.md) needs before anything is
# installed on a host that other applications share:
#   - whether PCT's port is free - from `ss`, which also sees host services
#     (nginx, a package-installed DB) that `docker ps` cannot;
#   - every Docker subnet and route, and a /24 for PCT_SUBNET that collides
#     with none of them, nor with this LAN, nor with the NAS;
#   - the NAS mounts other apps already use (listed, never touched);
#   - reachability of the NAS, the database, the Hub and Coupa.
# Every line starts with OK / WARN / FAIL / INFO, so the output can be pasted
# back for review as is.
#
# Settings (environment, all optional):
#   NAS_IP    (172.30.1.94)  the Synology NAS
#   API_PORT  (4100)         BE: host port for pct-api
#   WEB_PORT  (3050)         FE: loopback port for pct-web
#   RDS_HOST  (pgm-d9jn3khh0b3907w4.pgsql.ap-southeast-5.rds.aliyuncs.com)
#   HUB_URL   (https://dwshub.kpndomain.com)
#   APP_HOST  (pct.kpndomain.com)
set -u
ROLE="${1:-}"
NAS_IP="${NAS_IP:-172.30.1.94}"
API_PORT="${API_PORT:-4100}"
WEB_PORT="${WEB_PORT:-3050}"
RDS_HOST="${RDS_HOST:-pgm-d9jn3khh0b3907w4.pgsql.ap-southeast-5.rds.aliyuncs.com}"
HUB_URL="${HUB_URL:-https://dwshub.kpndomain.com}"
APP_HOST="${APP_HOST:-pct.kpndomain.com}"

if [ "$ROLE" != "be" ] && [ "$ROLE" != "fe" ]; then
  echo "usage: preflight.sh be|fe"; exit 2
fi

say() { printf '%-5s %s\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }
tcp() { timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

echo "== PCT production preflight: $ROLE on $(hostname) ($(hostname -I 2>/dev/null | awk '{print $1}')) $(date '+%F %T')"

# ── tools ──
for t in docker ss ip python3 curl findmnt; do
  if have "$t"; then say OK "tool $t"; else say FAIL "tool $t is missing"; fi
done
docker compose version >/dev/null 2>&1 && say OK "docker compose v2: $(docker compose version --short 2>/dev/null)" \
  || say FAIL "docker compose v2 not available"
say INFO "disk free on /: $(df -h / | awk 'NR==2{print $4}')   on /var/lib/docker: $(df -h /var/lib/docker 2>/dev/null | awk 'NR==2{print $4}')"

# ── ports ──
PORT=$([ "$ROLE" = be ] && echo "$API_PORT" || echo "$WEB_PORT")
LISTEN=$(ss -ltnH 2>/dev/null | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\1/' | sort -n | uniq)
say INFO "listening TCP ports: $(echo $LISTEN | tr '\n' ' ')"
if echo "$LISTEN" | grep -qx "$PORT"; then
  say FAIL "port $PORT is IN USE: $(ss -ltnpH "( sport = :$PORT )" 2>/dev/null | head -2 | tr -s ' ')"
  for p in $(seq "$PORT" $((PORT + 40))); do
    if ! echo "$LISTEN" | grep -qx "$p" && ! docker ps --format '{{.Ports}}' | grep -q ":$p->"; then
      say INFO "first free port at or above $PORT: $p   (set it in /opt/pct/.env, see the guide)"; break
    fi
  done
elif docker ps -a --format '{{.Ports}}' | grep -q ":$PORT->"; then
  say WARN "port $PORT is reserved by a STOPPED container (docker ps -a) - it will clash when that container starts"
else
  say OK "port $PORT is free"
fi

# ── docker networks and a safe subnet for PCT ──
SUBNETS=$(docker network ls -q 2>/dev/null | xargs -r docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null)
say INFO "docker networks:"
echo "$SUBNETS" | sed 's/^/        /'
ROUTES=$(ip -4 route show | awk '{print $1}' | grep -E '^[0-9]' || true)
ADDRS=$(ip -4 -o addr show | awk '{print $4}')
if docker network inspect pct_net >/dev/null 2>&1; then
  say INFO "pct_net already exists: $(docker network inspect pct_net --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}') - keep that value as PCT_SUBNET"
fi
SUGGEST=$(NAS_IP="$NAS_IP" SUBNETS="$SUBNETS" ROUTES="$ROUTES" ADDRS="$ADDRS" python3 - <<'PY'
import ipaddress, os
taken = []
for tok in (os.environ["SUBNETS"] + " " + os.environ["ROUTES"] + " " + os.environ["ADDRS"]).split():
    try:
        taken.append(ipaddress.ip_network(tok, strict=False))
    except ValueError:
        pass
# Never the servers' LAN (172.28/16), nor 172.29-172.31 (the NAS sits in 172.30).
fence = [ipaddress.ip_network(x) for x in ("172.28.0.0/16", "172.29.0.0/16", "172.30.0.0/16", "172.31.0.0/16")]
fence.append(ipaddress.ip_network(os.environ["NAS_IP"] + "/16", strict=False))
for second in range(27, 16, -1):          # 172.27 down to 172.17, highest first
    for third in range(250, 0, -1):
        cand = ipaddress.ip_network(f"172.{second}.{third}.0/24")
        if any(cand.overlaps(t) for t in taken + fence):
            continue
        print(cand)
        raise SystemExit
print("NONE")
PY
)
if [ "$SUGGEST" = "NONE" ]; then
  say FAIL "no free /24 found in 172.17-172.27 - choose PCT_SUBNET by hand"
else
  say OK "suggested PCT_SUBNET=$SUGGEST  (overlaps no Docker network, route, local address, the LAN or the NAS range)"
fi
if echo "$SUBNETS" | grep -Eq ' 172\.30\.'; then
  say WARN "a Docker network ALREADY holds a 172.30.x range - the NAS ($NAS_IP) may be shadowed for every app on this host (DEPLOY_STAGING.md 10)"
fi

# ── NAS ──
say INFO "NAS mounts already on this host (other apps - DO NOT change them):"
findmnt -rn -t cifs,smb3,nfs,nfs4 -o TARGET,SOURCE,OPTIONS 2>/dev/null | sed 's/^/        /' || true
if [ "$ROLE" = be ]; then
  R=$(ip route get "$NAS_IP" 2>/dev/null | head -1)
  case "$R" in
    *" dev br-"*|*" dev docker"*) say FAIL "route to the NAS goes into a DOCKER BRIDGE: $R" ;;
    "") say FAIL "no route to the NAS $NAS_IP" ;;
    *) say OK "route to the NAS: $R" ;;
  esac
  if tcp "$NAS_IP" 445; then say OK "NAS $NAS_IP:445 reachable"; else say FAIL "NAS $NAS_IP:445 NOT reachable (firewall / security group / route)"; fi
  if findmnt -rn /mnt/pct-nas >/dev/null 2>&1; then
    say OK "/mnt/pct-nas is mounted: $(findmnt -rn -o SOURCE,FSTYPE,OPTIONS /mnt/pct-nas | cut -c1-120)"
  elif [ -e /mnt/pct-nas ]; then
    say WARN "/mnt/pct-nas exists but is NOT a mount - a local folder (step 5 not done yet)"
  else
    say INFO "/mnt/pct-nas not created yet (step 5)"
  fi
  have smbclient && say INFO "smbclient present" || say INFO "smbclient missing (apt-get install -y smbclient cifs-utils in step 5)"
  have mount.cifs && say OK "cifs-utils present" || say INFO "cifs-utils missing (installed in step 5)"
fi

# ── outbound ──
if [ "$ROLE" = be ]; then
  if getent hosts "$RDS_HOST" >/dev/null; then say OK "RDS resolves: $(getent hosts "$RDS_HOST" | awk '{print $1}')"; else say FAIL "RDS host does not resolve: $RDS_HOST"; fi
  if tcp "$RDS_HOST" 5432; then say OK "RDS :5432 reachable"; else say FAIL "RDS :5432 NOT reachable - add this server's private IP to the RDS whitelist"; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$HUB_URL/api/sso/.well-known/openid-configuration"); \
    [ "$code" = 200 ] && say OK "Hub OIDC discovery 200 ($HUB_URL)" || say WARN "Hub OIDC discovery returned $code ($HUB_URL) - needed only for SSO"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://kpn.coupahost.com/); \
    [ "$code" != 000 ] && say OK "Coupa reachable (HTTP $code)" || say WARN "Coupa not reachable - needed only for the Coupa sync"
  tcp mail.energi-up.com 465 && say OK "SMTP mail.energi-up.com:465 reachable" || say WARN "SMTP :465 not reachable - notifications would fail"
fi
if [ "$ROLE" = fe ]; then
  OWNER=$(ss -ltnpH '( sport = :80 )' 2>/dev/null | head -1)
  case "$OWNER" in
    *nginx*) say OK "port 80 is the host nginx (shared front proxy) - install the vhost (step 7)" ;;
    *docker-proxy*) say WARN "port 80 is held by a CONTAINER, not host nginx - the vhost goes into that container's config instead" ;;
    "") say WARN "nothing listens on 80 - a front proxy is needed for $APP_HOST" ;;
    *) say WARN "port 80 owner: $OWNER" ;;
  esac
  if have nginx; then
    nginx -T 2>/dev/null | grep -E '^\s*server_name' | sort -u | sed 's/^/        /'
    nginx -T 2>/dev/null | grep -q "server_name.*$APP_HOST" && say WARN "a server block for $APP_HOST ALREADY exists" || say OK "no existing server block for $APP_HOST"
  fi
  getent hosts "$APP_HOST" >/dev/null && say INFO "$APP_HOST resolves here to $(getent hosts "$APP_HOST" | awk '{print $1}')" || say INFO "$APP_HOST does not resolve on this server yet (DNS, step 1)"
  tcp 172.28.80.51 "$API_PORT" && say OK "BE 172.28.80.51:$API_PORT reachable" || say INFO "BE 172.28.80.51:$API_PORT not reachable yet (fine before the API is up)"
fi

# ── code access ──
[ -f ~/.ssh/pct_deploy ] && say OK "deploy key ~/.ssh/pct_deploy exists" || say INFO "no ~/.ssh/pct_deploy yet (step 2)"
[ -d /opt/pct/src/.git ] && say INFO "checkout: $(git -C /opt/pct/src log --oneline -1 2>/dev/null) on $(git -C /opt/pct/src rev-parse --abbrev-ref HEAD 2>/dev/null)"
echo "== done"
