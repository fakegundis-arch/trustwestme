# Deployment

## Linux, not Windows

Use a Linux VPS. This is not a preference — four things in this project work
materially better there:

- **`better-sqlite3` is a native module.** On Linux it installs from a prebuilt
  binary and just works. On Windows, when no prebuild matches your Node version
  it falls back to compiling, which means installing Visual Studio Build Tools
  and Python. It is a recurring source of "it worked on my machine".
- **Process supervision.** `systemd` restarts the gateway on crash and on boot,
  in four lines of config. Windows needs NSSM or a wrapper service.
- **Monero.** If you enable XMR, `monero-wallet-rpc` and `monerod` are built for
  Linux first. Windows builds exist but are far less trodden.
- **Cost.** Windows Server licensing adds to every month's bill, and the GUI
  wants ~2 GB of RAM before your app starts.

There is no Windows-only dependency anywhere in this project.

**Recommended:** Ubuntu 24.04 LTS (or 22.04). Debian 12 is equally fine. Pick
the distro you can get help with — that matters more than the specific choice.

## Sizing

| | vCPU | RAM | Disk | Notes |
|---|---|---|---|---|
| Testing | 1 | 2 GB | 25 GB | fine to start |
| **Production** | **2** | **4 GB** | **80 GB** | **the sensible default** |
| With your own Monero node | 4 | 8 GB | 300 GB | `monerod` is the whole cost |

The gateway itself is light — roughly 200–300 MB of RAM, and CPU only in bursts
while scanning. The 4 GB recommendation is headroom, not need.

The disk number is about the database, which grows slowly (one row per deposit),
plus room for backups. **Only self-hosting a Monero node changes the picture** —
that is a ~250 GB chain, or ~60 GB pruned. Point `monero-wallet-rpc` at a public
remote node instead and you avoid all of it: the wallet still scans locally with
your view key, so a remote node cannot see your balances or spend anything.

Providers that work well: Hetzner (cheapest for the specs), DigitalOcean, Vultr,
Linode. Any of them is fine.

## Install

```bash
# --- as root, on a fresh Ubuntu 24.04 box ---

apt update && apt upgrade -y
apt install -y curl git build-essential python3 ufw fail2ban sqlite3

# Node 22 (the distro's Node is too old)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# A dedicated unprivileged user — never run this as root
adduser --system --group --home /opt/gateway gateway

# Clock accuracy matters here: API requests are signed with a timestamp and
# rejected outside a 5-minute window. A drifting clock breaks authentication.
timedatectl set-ntp true
```

```bash
# --- as the gateway user ---
sudo -u gateway -H bash
cd /opt/gateway
git clone https://github.com/fakegundis-arch/trustwestme.git app
cd app
npm ci
npm run build

npm run seed          # write the phrase down offline, then put it in .env
npm run keys
cp .env.example .env
nano .env

npm test              # confirm the box builds and behaves before going live
npm run addresses -- 1
```

## Run it as a service

`/etc/systemd/system/gateway.service`:

```ini
[Unit]
Description=trustwestme payment gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gateway
Group=gateway
WorkingDirectory=/opt/gateway/app
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# The seed lives in this process. Give it as little reach as possible.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/gateway/app/data
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
```

> **If your app lives under `/home` rather than `/opt`**, `ProtectHome=true`
> hides the whole of `/home` from the service and it will fail to start. Either
> move the app to `/opt/gateway/app`, or set `ProtectHome=false` and point
> `ReadWritePaths` at your actual data directory, e.g.
> `/home/gateway/app/data`.

```bash
systemctl daemon-reload
systemctl enable --now gateway
systemctl status gateway
journalctl -u gateway -f      # live logs
```

Your Telegram bot will announce the startup, which is a convenient way to know
the service came back after a reboot.

## Lock down the network

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 443/tcp        # only if your exchange connects from another machine
ufw enable
```

**Do not expose port 8080.** Two cases:

- **Exchange on the same box** — set `HOST=127.0.0.1` and leave 443 closed. The
  API is then unreachable from the internet entirely. This is the best option.
- **Exchange elsewhere** — put nginx in front with TLS, and restrict by source
  IP. The request signature protects against tampering but sends everything in
  the clear without TLS.

```nginx
server {
    listen 443 ssl;
    server_name gateway.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/gateway.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gateway.yourdomain.com/privkey.pem;

    # Only your exchange should be able to reach this at all.
    allow 203.0.113.10;
    deny all;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Also harden SSH in `/etc/ssh/sshd_config`: `PasswordAuthentication no` and
`PermitRootLogin no`, then `systemctl restart ssh`. Use keys.

## Back up the database

The seed controls the money, but the database holds which user owns which
derivation index. Losing it does not lose funds — it loses the mapping, which is
miserable to rebuild.

```bash
# /etc/cron.daily/gateway-backup
#!/bin/sh
sqlite3 /opt/gateway/app/data/gateway.db \
  ".backup '/opt/gateway/backups/gateway-$(date +%F).db'"
find /opt/gateway/backups -name 'gateway-*.db' -mtime +30 -delete
```

`chmod +x` it, and copy those backups off the machine. A backup that only exists
on the server it is backing up is not a backup.

## Once you have real volume

Split the seed away from the internet-facing box:

- **Public box** — runs with `WATCH_ONLY=true`. Serves the API and the watcher,
  hands out addresses already in the database, and holds no seed. If it is
  compromised, nothing can be spent.
- **Private box** — holds the seed, generates addresses in batches, and signs
  withdrawals. Never reachable from the internet.

That single change is the highest-value security step available, and the
`WATCH_ONLY` flag already exists for it.

## Health checks

```bash
curl localhost:8080/health         # liveness, no auth needed
systemctl status gateway
journalctl -u gateway --since '1 hour ago' | grep -i error
```

Or just send `/status` and `/chains` to your Telegram bot.
