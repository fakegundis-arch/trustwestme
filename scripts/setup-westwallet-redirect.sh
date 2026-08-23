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

green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { red "Run this as root (sudo bash $0)"; exit 1; }
command -v openssl >/dev/null || { red "openssl is required: apt install -y openssl"; exit 1; }

# ---------------------------------------------------------------------------
step "1/5  Checking the gateway is running on port ${GATEWAY_PORT}"
if curl -fsS --max-time 5 "http://127.0.0.1:${GATEWAY_PORT}/health" | grep -q trustwestme; then
  green "    gateway is up"
else
  red "    nothing answering on http://127.0.0.1:${GATEWAY_PORT}/health"
  red "    Start it first (npm start), or pass the right port: sudo bash $0 <port>"
  exit 1
fi

# ---------------------------------------------------------------------------
step "2/5  Creating a local CA and a certificate for ${HOSTNAME_TO_HIJACK}"
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
green "    certificate issued for ${HOSTNAME_TO_HIJACK}"

# ---------------------------------------------------------------------------
step "3/5  Trusting the CA in the Java truststore"
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

# ---------------------------------------------------------------------------
step "4/5  Pointing ${HOSTNAME_TO_HIJACK} at this machine"
if grep -qE "^[^#]*\s${HOSTNAME_TO_HIJACK}(\s|$)" /etc/hosts; then
  yellow "    /etc/hosts already redirects it"
else
  cp /etc/hosts "/etc/hosts.backup-$(date +%Y%m%d%H%M%S)"
  printf '\n# trustwestme: send WestWallet API calls to the local gateway\n127.0.0.1 %s\n' \
    "$HOSTNAME_TO_HIJACK" >> /etc/hosts
  green "    /etc/hosts updated (backup taken)"
fi

# ---------------------------------------------------------------------------
step "5/5  Serving ${HOSTNAME_TO_HIJACK} over TLS"
PORT_443_OWNER="$(ss -tlnp 2>/dev/null | awk '$4 ~ /:443$/ {print $NF; exit}')"

if echo "$PORT_443_OWNER" | grep -qi nginx || (command -v nginx >/dev/null && [ -n "$PORT_443_OWNER" ]); then
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
  green "    port 443 is free — use the built-in TLS proxy:"
  echo
  echo "      TLS_TARGET_PORT=${GATEWAY_PORT} npm run tls-proxy"
  echo
  echo "    Run it under systemd so it survives a reboot; docs/REDIRECT-WESTWALLET.md"
  echo "    has a unit file ready to copy."
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

Next:
  1. Restart your exchange application so it picks up the new truststore.
  2. Verify from this machine:

       curl -sS https://${HOSTNAME_TO_HIJACK}/health

     That should print the gateway's JSON. A certificate error means the CA
     import did not take; anything else means the gateway is not reachable.

  3. Put your gateway's API keys into the exchange admin panel, where the
     WestWallet keys used to go.

To undo everything:  sudo bash scripts/undo-westwallet-redirect.sh

$(yellow "Note: this captures ${HOSTNAME_TO_HIJACK} for the whole machine.")
$(yellow "Nothing on this server can reach the real WestWallet while it is in place.")
EOF
