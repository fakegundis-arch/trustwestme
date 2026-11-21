#!/usr/bin/env bash
#
# Point a hardcoded https://api.westwallet.io at this gateway.
#
# Some exchange software compiles the WestWallet URL in, with no setting to
# change it. Rather than patch the binary, this makes that hostname resolve to
# this machine and serves it over TLS with a certificate the JVM trusts.
#
# Everything it does is listed at the end, and scripts/undo-westwallet-redirect.sh
# reverses all of it.
#
# Run as root:  sudo bash scripts/setup-westwallet-redirect.sh [gateway_port]
#
set -euo pipefail

HOSTNAME_TO_HIJACK="api.westwallet.io"
GATEWAY_PORT="${1:-8787}"
TLS_DIR="/etc/gateway-tls"
NGINX_CONF="/etc/nginx/conf.d/westwallet-gateway.conf"
TLS_UNIT="/etc/systemd/system/gateway-tls.service"
# Where the gateway is installed. The TLS proxy runs from here, as the account
# that owns it, so both are derived rather than assumed.
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { red "Run this as root (sudo bash $0)"; exit 1; }
command -v openssl >/dev/null || { red "openssl is required: apt install -y openssl"; exit 1; }
# Without ss, port ownership cannot be read and the script would guess wrong
# about what is already serving 443.
command -v ss >/dev/null || { red "ss is required: apt install -y iproute2"; exit 1; }

# ---------------------------------------------------------------------------
step "1/6  Checking the gateway is running on port ${GATEWAY_PORT}"
# Wait rather than check once. "systemctl restart gateway" returns as soon as
# systemd has forked, while the gateway binds a few hundred milliseconds later
# once the database is open, so running this script immediately afterwards --
# the obvious thing to do, and what the instructions say -- failed on a
# gateway that was starting perfectly well.
GATEWAY_UP=""
for attempt in $(seq 1 15); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${GATEWAY_PORT}/health" 2>/dev/null \
      | grep -q trustwestme; then
    GATEWAY_UP=yes
    break
  fi
  [ "$attempt" -eq 1 ] && yellow "    waiting for the gateway to answer..."
  sleep 1
done

if [ -n "$GATEWAY_UP" ]; then
  green "    gateway is up"
else
  red "    nothing answering on http://127.0.0.1:${GATEWAY_PORT}/health after 15s"
  red "    Start it first (npm start), or pass the right port: sudo bash $0 <port>"
  red "    If it is supposed to be running:  journalctl -u gateway -n 30 --no-pager"
  exit 1
fi

# ---------------------------------------------------------------------------
step "2/6  Creating a local CA and a certificate for ${HOSTNAME_TO_HIJACK}"
mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR"

if [ -f "$TLS_DIR/ca.crt" ]; then
  yellow "    reusing the CA already in $TLS_DIR"
else
  openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
    -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" \
    -subj "/CN=trustwestme local CA" 2>/dev/null
  green "    CA created"
fi

cat > "$TLS_DIR/san.cnf" <<EOF
subjectAltName = DNS:${HOSTNAME_TO_HIJACK}
extendedKeyUsage = serverAuth
basicConstraints = CA:FALSE
EOF

openssl req -newkey rsa:2048 -nodes \
  -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.csr" \
  -subj "/CN=${HOSTNAME_TO_HIJACK}" 2>/dev/null

openssl x509 -req -in "$TLS_DIR/server.csr" \
  -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" -CAcreateserial \
  -out "$TLS_DIR/server.crt" -days 3650 -extfile "$TLS_DIR/san.cnf" 2>/dev/null
chmod 600 "$TLS_DIR"/*.key

# The TLS proxy runs as the account that owns the install, not as root, so it
# has to be able to read the server certificate and key -- and to traverse the
# directory holding them. The directory mode is the part that bites: with the
# files chowned but the directory left at 700 root-only, the proxy cannot reach
# files it owns, and an existence check cannot tell that apart from a missing
# file, so it reports the certificate as absent while it sits right there.
#
# This runs on every invocation, directly after the certificate is issued.
# Doing it only when installing a fresh service meant a re-run reset the mode
# above and never restored it, breaking a setup that had been working.
SERVICE_USER="$(stat -c '%U' "$APP_DIR" 2>/dev/null || echo root)"
chmod 755 "$TLS_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$TLS_DIR/server.crt" "$TLS_DIR/server.key"
chmod 640 "$TLS_DIR/server.key"
# The CA's signing key stays root-only. Anything holding it can issue
# certificates this machine trusts, so it must not follow the server key.
chmod 600 "$TLS_DIR/ca.key"
green "    certificate issued for ${HOSTNAME_TO_HIJACK}"
green "    readable by ${SERVICE_USER} (ca.key stays root-only)"

# ---------------------------------------------------------------------------
step "3/6  Trusting the CA in the Java truststore"
JAVA_BIN="$(command -v java || true)"
if [ -z "$JAVA_BIN" ]; then
  red "    java not found on PATH — import $TLS_DIR/ca.crt into your JVM manually"
else
  JAVA_HOME_DIR="$(dirname "$(dirname "$(readlink -f "$JAVA_BIN")")")"
  KEYTOOL="$JAVA_HOME_DIR/bin/keytool"
  green "    JVM: $JAVA_HOME_DIR"

  # Java 9+ keeps the truststore at lib/security/cacerts and accepts -cacerts.
  if "$KEYTOOL" -list -cacerts -storepass changeit -alias trustwestme-local >/dev/null 2>&1; then
    yellow "    already trusted, replacing it"
    "$KEYTOOL" -delete -cacerts -storepass changeit -alias trustwestme-local >/dev/null 2>&1 || true
  fi
  if "$KEYTOOL" -importcert -trustcacerts -cacerts -storepass changeit \
      -alias trustwestme-local -file "$TLS_DIR/ca.crt" -noprompt >/dev/null 2>&1; then
    green "    CA imported into the JVM truststore"
  else
    # Older JVMs need the file named explicitly.
    if "$KEYTOOL" -importcert -trustcacerts \
        -keystore "$JAVA_HOME_DIR/lib/security/cacerts" -storepass changeit \
        -alias trustwestme-local -file "$TLS_DIR/ca.crt" -noprompt >/dev/null 2>&1; then
      green "    CA imported (legacy truststore path)"
    else
      red "    could not import automatically. Run this yourself:"
      red "      $KEYTOOL -importcert -trustcacerts -cacerts -storepass changeit \\"
      red "        -alias trustwestme-local -file $TLS_DIR/ca.crt -noprompt"
    fi
  fi
fi

# Also trust the CA system-wide. The JVM import above is what actually matters,
# but without this `curl https://api.westwallet.io/health` fails on an unknown
# issuer — which looks like a broken setup when nothing is wrong.
if [ -d /usr/local/share/ca-certificates ] && command -v update-ca-certificates >/dev/null; then
  cp "$TLS_DIR/ca.crt" /usr/local/share/ca-certificates/trustwestme-local.crt
  if update-ca-certificates >/dev/null 2>&1; then
    green "    CA also added to the system trust store (so curl can verify it)"
  fi
fi

# ---------------------------------------------------------------------------
step "4/6  Pointing ${HOSTNAME_TO_HIJACK} at this machine"
if grep -qE "^[^#]*\s${HOSTNAME_TO_HIJACK}(\s|$)" /etc/hosts; then
  yellow "    /etc/hosts already redirects it"
else
  cp /etc/hosts "/etc/hosts.backup-$(date +%Y%m%d%H%M%S)"
  printf '\n# trustwestme: send WestWallet API calls to the local gateway\n127.0.0.1 %s\n' \
    "$HOSTNAME_TO_HIJACK" >> /etc/hosts
  green "    /etc/hosts updated (backup taken)"
fi

# ---------------------------------------------------------------------------
step "5/6  Serving ${HOSTNAME_TO_HIJACK} over TLS"
PORT_443_OWNER="$(ss -tlnp 2>/dev/null | awk '$4 ~ /:443$/ {print $NF; exit}')"

# Our own TLS proxy already serving 443 is the normal state on a re-run, and the
# script must be safe to re-run: a partly-finished setup is exactly when it gets
# run again. Recognise it rather than reporting it as a foreign process.
if [ -n "$PORT_443_OWNER" ] && { systemctl is-active gateway-tls >/dev/null 2>&1 \
    || echo "$PORT_443_OWNER" | grep -q 'node'; } \
    && [ -f "$TLS_UNIT" ]; then
  green "    the gateway's own TLS proxy already holds port 443"
  systemctl restart gateway-tls >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do
    if curl -sS --noproxy '*' --cacert "$TLS_DIR/ca.crt" --max-time 3 \
        "https://${HOSTNAME_TO_HIJACK}/health" 2>/dev/null | grep -q trustwestme; then
      green "    and it is serving ${HOSTNAME_TO_HIJACK} correctly"
      TLS_PROXY_OK=yes
      break
    fi
    sleep 1
  done
  if [ -z "${TLS_PROXY_OK:-}" ]; then
    red "    but it is not answering for ${HOSTNAME_TO_HIJACK}. Diagnose with:"
    red "      systemctl status gateway-tls --no-pager"
    red "      journalctl -u gateway-tls -n 30 --no-pager"
  fi

elif echo "$PORT_443_OWNER" | grep -qi nginx || (command -v nginx >/dev/null && [ -n "$PORT_443_OWNER" ]); then
  green "    nginx already owns port 443 — adding a server block for it"
  cat > "$NGINX_CONF" <<EOF
# Serves the hardcoded WestWallet hostname from the local gateway.
# Written by scripts/setup-westwallet-redirect.sh — remove with the undo script.
server {
    listen 443 ssl;
    server_name ${HOSTNAME_TO_HIJACK};

    ssl_certificate     ${TLS_DIR}/server.crt;
    ssl_certificate_key ${TLS_DIR}/server.key;

    # Only this machine should reach it.
    allow 127.0.0.1;
    deny all;

    location / {
        proxy_pass http://127.0.0.1:${GATEWAY_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        # Pass the body through byte for byte — the request signature covers it.
        proxy_request_buffering off;
    }
}
EOF
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    green "    nginx configured and reloaded"
  else
    red "    nginx config test failed. Inspect: nginx -t"
    rm -f "$NGINX_CONF"
    exit 1
  fi
elif [ -n "$PORT_443_OWNER" ]; then
  red "    port 443 is held by something that is not nginx:"
  red "      $PORT_443_OWNER"
  red "    Add a virtual host for ${HOSTNAME_TO_HIJACK} there yourself, proxying to"
  red "    http://127.0.0.1:${GATEWAY_PORT}. Certificate: $TLS_DIR/server.crt"
  exit 1
else
  # Port 443 is free, so nothing is serving the hostname we just redirected.
  # Printing instructions here is not enough: /etc/hosts now sends the
  # exchange's API calls to a port with nothing on it, so leaving this step to
  # the reader turns a working integration into "connection refused".
  green "    port 443 is free — installing the TLS proxy as a service"

  cat > "$TLS_UNIT" <<EOF
[Unit]
Description=TLS front end for the payment gateway
After=network-online.target gateway.service
Wants=gateway.service

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=TLS_CERT=${TLS_DIR}/server.crt
Environment=TLS_KEY=${TLS_DIR}/server.key
Environment=TLS_PROXY_PORT=443
Environment=TLS_PROXY_HOST=127.0.0.1
Environment=TLS_TARGET_PORT=${GATEWAY_PORT}
ExecStart=$(command -v node) dist/cli/tls-proxy.js
Restart=always
RestartSec=10

# Binding 443 normally needs root; this grants that one capability instead.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now gateway-tls >/dev/null 2>&1 || true

  # Confirm it is really serving, rather than assuming the unit started.
  for _ in $(seq 1 10); do
    if curl -sS --noproxy '*' --cacert "$TLS_DIR/ca.crt" --max-time 3 \
        "https://${HOSTNAME_TO_HIJACK}/health" 2>/dev/null | grep -q trustwestme; then
      green "    TLS proxy is serving ${HOSTNAME_TO_HIJACK} on 443"
      TLS_PROXY_OK=yes
      break
    fi
    sleep 1
  done

  if [ -z "${TLS_PROXY_OK:-}" ]; then
    red "    the TLS proxy did not come up. Diagnose with:"
    red "      systemctl status gateway-tls --no-pager"
    red "      journalctl -u gateway-tls -n 30 --no-pager"
    red "    Until it does, the exchange's API calls will be refused, because"
    red "    /etc/hosts now points ${HOSTNAME_TO_HIJACK} at this machine."
  fi
fi

# ---------------------------------------------------------------------------
# Verify all three pieces before claiming success.
#
# The redirect only works if the hostname resolves here, Java trusts the
# certificate, and something serves 443. Reporting "Done." with any of them
# missing is worse than failing: the exchange then calls the real WestWallet,
# is rejected, and shows nothing, while the gateway log stays empty because
# nothing reached it. That is a genuinely hard failure to diagnose from either
# end, so each piece is checked here by its effect, not by whether a command
# earlier appeared to work.
step "6/6  Verifying"
VERIFY_FAILED=""

if grep -qE "^[^#]*\s${HOSTNAME_TO_HIJACK}(\s|$)" /etc/hosts; then
  green "    /etc/hosts sends ${HOSTNAME_TO_HIJACK} here"
else
  red "    /etc/hosts does NOT redirect ${HOSTNAME_TO_HIJACK}"
  VERIFY_FAILED="yes"
fi

if [ -n "${KEYTOOL:-}" ] && "$KEYTOOL" -list -cacerts -storepass changeit \
    -alias trustwestme-local >/dev/null 2>&1; then
  green "    Java trusts the certificate"
elif [ -n "${KEYTOOL:-}" ] && "$KEYTOOL" -list \
    -keystore "${JAVA_HOME_DIR:-}/lib/security/cacerts" -storepass changeit \
    -alias trustwestme-local >/dev/null 2>&1; then
  green "    Java trusts the certificate (legacy truststore)"
else
  red "    Java does NOT trust the certificate — the exchange will refuse the"
  red "    connection. Import it by hand:"
  red "      ${KEYTOOL:-keytool} -importcert -trustcacerts -cacerts \\"
  red "        -storepass changeit -alias trustwestme-local \\"
  red "        -file $TLS_DIR/ca.crt -noprompt"
  VERIFY_FAILED="yes"
fi

if curl -sS --noproxy '*' --cacert "$TLS_DIR/ca.crt" --max-time 5 \
    "https://${HOSTNAME_TO_HIJACK}/health" 2>/dev/null | grep -q trustwestme; then
  green "    https://${HOSTNAME_TO_HIJACK} reaches the gateway"
else
  red "    https://${HOSTNAME_TO_HIJACK} does NOT reach the gateway"
  VERIFY_FAILED="yes"
fi

if [ -n "$VERIFY_FAILED" ]; then
  echo
  red "SETUP INCOMPLETE — the items marked above must be fixed."
  red "Until they are, your exchange cannot reach the gateway and deposit"
  red "addresses will not appear. Re-running this script is safe."
  exit 1
fi

# ---------------------------------------------------------------------------
cat <<EOF

$(green "Done.")

Changed:
  * ${TLS_DIR}/           CA and certificate for ${HOSTNAME_TO_HIJACK}
  * Java truststore       trusts that CA (alias trustwestme-local)
  * /etc/hosts            ${HOSTNAME_TO_HIJACK} -> 127.0.0.1 (backup taken)
  * ${NGINX_CONF}
                          (only if nginx is serving 443)
  * ${TLS_UNIT}
                          (only if port 443 was free)

All three pieces were verified above: the hostname resolves here, Java trusts
the certificate, and the hostname reaches the gateway.

Next:
  1. Restart your exchange application so it picks up the new truststore.
     Nothing takes effect inside a JVM that was already running.
  2. Put your gateway's API keys into the exchange admin panel, where the
     WestWallet keys used to go.
  3. Click "show address" on your site, then confirm the request arrived:

       grep address/generate ${APP_DIR}/data/gateway.log | tail -n 5

To undo everything:  sudo bash scripts/undo-westwallet-redirect.sh

$(yellow "Note: this captures ${HOSTNAME_TO_HIJACK} for the whole machine.")
$(yellow "Nothing on this server can reach the real WestWallet while it is in place.")
EOF
