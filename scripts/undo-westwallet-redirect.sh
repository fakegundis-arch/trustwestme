#!/usr/bin/env bash
#
# Reverse scripts/setup-westwallet-redirect.sh.
#
# Run as root:  sudo bash scripts/undo-westwallet-redirect.sh
#
set -euo pipefail

HOSTNAME_TO_HIJACK="api.westwallet.io"
TLS_DIR="/etc/gateway-tls"
NGINX_CONF="/etc/nginx/conf.d/westwallet-gateway.conf"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root"; exit 1; }

# 1. Stop redirecting the hostname — this alone restores normal behaviour.
if grep -qE "^[^#]*\s${HOSTNAME_TO_HIJACK}(\s|$)" /etc/hosts; then
  cp /etc/hosts "/etc/hosts.backup-$(date +%Y%m%d%H%M%S)"
  sed -i "/# trustwestme: send WestWallet API calls to the local gateway/d" /etc/hosts
  sed -i "\#^127\.0\.0\.1[[:space:]]\+${HOSTNAME_TO_HIJACK}\$#d" /etc/hosts
  green "removed the /etc/hosts entry"
else
  yellow "no /etc/hosts entry to remove"
fi

# 2. Remove the nginx server block.
if [ -f "$NGINX_CONF" ]; then
  rm -f "$NGINX_CONF"
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    green "removed the nginx server block and reloaded"
  else
    yellow "nginx config test failed after removal — check: nginx -t"
  fi
fi

# 3. Drop the CA from the Java truststore.
JAVA_BIN="$(command -v java || true)"
if [ -n "$JAVA_BIN" ]; then
  JAVA_HOME_DIR="$(dirname "$(dirname "$(readlink -f "$JAVA_BIN")")")"
  KEYTOOL="$JAVA_HOME_DIR/bin/keytool"
  if "$KEYTOOL" -delete -cacerts -storepass changeit -alias trustwestme-local >/dev/null 2>&1 \
    || "$KEYTOOL" -delete -keystore "$JAVA_HOME_DIR/lib/security/cacerts" \
         -storepass changeit -alias trustwestme-local >/dev/null 2>&1; then
    green "removed the CA from the Java truststore"
  else
    yellow "no CA found in the Java truststore"
  fi
fi

# 4. The certificates themselves are harmless; keep them unless asked.
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$TLS_DIR"
  green "deleted $TLS_DIR"
else
  yellow "left $TLS_DIR in place (pass --purge to delete it)"
fi

green "Done. Restart your exchange application."
