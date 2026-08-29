# Redirecting a hardcoded WestWallet URL

Some exchange software compiles the WestWallet endpoint into the binary. The
yukitale Spring Boot exchange does exactly this — its `WestWalletService` class
holds these as string constants:

```
https://api.westwallet.io/address/generate
https://api.westwallet.io/wallet/transactions
```

Only the public and private keys are configurable (admin panel →
`payment_settings`). There is no property or database column for the URL, so it
cannot be pointed at another host by configuration.

The answer is to make that hostname resolve to this machine and serve it over
TLS with a certificate the JVM trusts. The application keeps calling
`https://api.westwallet.io` and reaches your gateway instead.

## Run it

```bash
sudo bash scripts/setup-westwallet-redirect.sh 8787   # your gateway's port
```

The script refuses to proceed unless the gateway is already answering, then:

1. creates a local CA and a certificate for `api.westwallet.io`
2. imports that CA into the Java truststore (`keytool -importcert -cacerts`)
3. adds `127.0.0.1 api.westwallet.io` to `/etc/hosts`, keeping a backup
4. serves it on 443 — an nginx server block if nginx already owns the port,
   otherwise the built-in TLS proxy

Then **restart your exchange application** so it reloads the truststore, and
check from that machine:

```bash
curl -sS https://api.westwallet.io/health
```

That should print the gateway's JSON. A certificate error means the CA import
did not take; a connection error means the gateway is not reachable.

Finally, put your gateway's API keys into the admin panel where the WestWallet
keys used to go.

## Undoing it

```bash
sudo bash scripts/undo-westwallet-redirect.sh
```

Removes the hosts entry, the nginx block and the CA. Add `--purge` to delete the
certificates too. The `/etc/hosts` line alone is what redirects traffic, so
deleting that one line restores normal behaviour immediately.

## If port 443 is free

The setup script tells you when nothing owns 443, and the built-in proxy handles
it. Run it under systemd so it survives a reboot.

The certificate is created root-owned, so first let the service account read it.
The CA's private key stays readable only by root — that one must never be
exposed, since anything holding it can issue certificates this machine trusts:

```bash
chmod 755 /etc/gateway-tls
chown gateway:gateway /etc/gateway-tls/server.crt /etc/gateway-tls/server.key
chmod 640 /etc/gateway-tls/server.key
ls -l /etc/gateway-tls          # ca.key must still be root-only
```

```ini
# /etc/systemd/system/gateway-tls.service
[Unit]
Description=TLS front end for the payment gateway
After=network-online.target gateway.service
Wants=gateway.service

[Service]
Type=simple
User=gateway
Group=gateway
WorkingDirectory=/opt/gateway/app
Environment=TLS_CERT=/etc/gateway-tls/server.crt
Environment=TLS_KEY=/etc/gateway-tls/server.key
Environment=TLS_PROXY_PORT=443
Environment=TLS_PROXY_HOST=127.0.0.1
Environment=TLS_TARGET_PORT=8787
ExecStart=/usr/bin/node dist/cli/tls-proxy.js
Restart=always
RestartSec=10

# Binding 443 normally needs root; this grants just that one capability
# instead, so the proxy runs as an ordinary account.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now gateway-tls
systemctl status gateway-tls --no-pager
```

It listens on `127.0.0.1` only, so nothing outside the machine can reach it.

## What this costs you

The redirect captures `api.westwallet.io` for the **whole machine**. Nothing on
that server can reach the real WestWallet while it is in place. That is the
point when you are migrating away, but do not do it on a box that still needs
them.

It is otherwise contained: no traffic leaves the machine, the certificate is
trusted only by this server's JVM, and the nginx block written by the script
accepts connections from `127.0.0.1` only.

## The alternative

You could decompile `WestWalletService`, edit the URL and recompile that one
class back into the jar. It is cleaner in principle — no hosts file, no
certificate — but it needs a matching JDK and the right classpath, and it has to
be redone after every application update. The hosts-plus-TLS approach survives
updates untouched, which is why the script does it that way.

Patching the constant in place without recompiling does not work: Java string
constants are length-prefixed, so a replacement URL would have to be exactly 42
and 45 characters to match the two existing ones.
