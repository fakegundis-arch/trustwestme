# Installing on a fresh VPS

A complete walkthrough, assuming you have never done this before. Every command
is meant to be copied exactly. Nothing is skipped.

Allow about 45 minutes.

**What you need before starting**

- A VPS running **Ubuntu 24.04** (or 22.04), with at least 2 vCPU, 4 GB RAM and
  40 GB disk
- The root password or SSH key your provider gave you
- A Telegram account
- About 15 minutes of undisturbed time for step 6, where you write down a seed
  phrase that controls all customer funds

Each step says what it does and how to tell it worked. If a check fails, stop
there — later steps assume the earlier ones succeeded.

---

## Step 1 — Log in to the server

From your own computer:

```bash
ssh root@YOUR_SERVER_IP
```

Replace `YOUR_SERVER_IP` with the address your provider gave you. On the first
connection it asks about authenticity; type `yes`.

**Check:** the prompt now ends in `#`, like `root@srv12345:~#`. You are on the
server. Every command from here on runs there.

---

## Step 2 — Update the system and install the basics

```bash
apt update && apt upgrade -y
apt install -y curl git build-essential python3 ufw sqlite3
```

The upgrade may take a few minutes and may ask about keeping configuration
files — accept the defaults by pressing Enter.

**Check:**

```bash
git --version
```

Prints a version number.

---

## Step 3 — Install Node.js 22

**This is the step most likely to go wrong, so do not substitute it.**
Ubuntu's own `apt install nodejs` gives you Node 18, which this project cannot
run: it crashes at startup with `Segmentation fault` and no useful message.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

**Check:**

```bash
node -v
```

Must print **v22.something**. If it prints v18 or v20, the NodeSource step did
not take effect — run the two commands again and watch for errors. Do not
continue until this says v22.

---

## Step 4 — Set the clock

API requests are signed with a timestamp and rejected if the server's clock is
more than five minutes out. A drifting clock breaks authentication in a way
that is very hard to diagnose later.

```bash
timedatectl set-ntp true
timedatectl
```

**Check:** the output includes `System clock synchronized: yes`.

---

## Step 5 — Create a user for the gateway and install the code

Running internet-facing software as root means any flaw in it has full control
of the machine. So the gateway gets its own account with no password and no
shell access.

```bash
adduser --system --group --home /opt/gateway gateway
```

Then download the code as that user, so every file belongs to it:

```bash
sudo -u gateway git clone https://github.com/fakegundis-arch/trustwestme.git /opt/gateway/app
cd /opt/gateway/app
sudo -u gateway git checkout claude/chat-session-lmpxdt
sudo -u gateway npm ci
sudo -u gateway npm run build
```

`npm ci` installs the exact dependency versions the project was tested with.
Use it rather than `npm install`, which can rewrite `package-lock.json` and
then block your next `git pull`.

**Check:**

```bash
ls dist/index.js
```

Prints the path. If it says "No such file", the build failed — scroll up for
the error.

---



# Run this command first- 
```bash

# 1. Let the gateway user read the certificate (the CA key stays root-only)
chmod 755 /etc/gateway-tls
chown gateway:gateway /etc/gateway-tls/server.crt /etc/gateway-tls/server.key
chmod 640 /etc/gateway-tls/server.key

# 2. Install the TLS proxy service
cat > /etc/systemd/system/gateway-tls.service <<'EOF'
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
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now gateway-tls
systemctl status gateway-tls --no-pager

```


## Step 6 — Create the master seed phrase

**Read this whole step before running the command.**

```bash
sudo -u gateway npm run seed
```

This prints 24 words. Those 24 words **are** the exchange:

- Anyone who reads them can take every customer deposit.
- If you lose them, every deposit is gone permanently and no backup brings it
  back. Not the database, not a server snapshot. Nothing.

What to do:

1. **Write them on paper, by hand.** Twice, in two different physical places.
2. Do not photograph them. Do not put them in a password manager, email, cloud
   note, or any chat — including with me.
3. Keep the terminal open for the next step, then clear it.

Then put the phrase into the configuration file in step 7.

**Do not set a passphrase.** There is a separate
`MASTER_MNEMONIC_PASSPHRASE` setting and it must stay **empty**. It is not a
second copy of the seed — it changes every address the gateway derives, and the
Trust Wallet app cannot restore a wallet that uses one, so you would lose the
ability to recover funds by importing your seed.

---

## Step 7 — Create the API keys

```bash
sudo -u gateway npm run keys
```

This prints two lines:

```
API_PUBLIC_KEY=...
API_PRIVATE_KEY=...
```

Copy both. They go in the configuration file next, and into your exchange's
admin panel later, where the WestWallet keys used to go.

---

## Step 8 — Create the configuration file

```bash
sudo -u gateway cp .env.example .env
sudo -u gateway nano .env
```

`nano` is a text editor. Arrow keys move the cursor. When finished:
**Ctrl+O**, Enter to save, then **Ctrl+X** to exit.

Fill in these five things, leaving everything else as it is:

```
MASTER_MNEMONIC=the twenty four words from step 6 separated by single spaces
MASTER_MNEMONIC_PASSPHRASE=
API_PUBLIC_KEY=the public key from step 7
API_PRIVATE_KEY=the private key from step 7
IPN_SECRET=
```

For `IPN_SECRET`, open a second terminal (or finish editing first) and run:

```bash
openssl rand -hex 32
```

Paste the result as the value. This secret signs the deposit notifications your
exchange receives, so your site can tell a genuine notification from a forged
one. Your exchange needs the same value later.

Leave `PORT=8787` and `HOST=127.0.0.1` alone. `127.0.0.1` means the gateway is
reachable only from this machine, which is what you want when your exchange
runs on the same server.

**Check:**

```bash
sudo -u gateway grep -c . /opt/gateway/app/.env
```

Prints a number above 50. And confirm the seed went in without the passphrase:

```bash
sudo -u gateway grep -E "^MASTER_MNEMONIC" /opt/gateway/app/.env | cut -c1-30
```

You should see `MASTER_MNEMONIC=abandon abi…` (your own words) and
`MASTER_MNEMONIC_PASSPHRASE=` with nothing after the `=`.

---

## Step 9 — Check the seed produces real addresses

```bash
sudo -u gateway npm run addresses -- 1
```

This prints one address per currency for user number 1.

**Check:** you see a list where BTC starts with `bc1`, ETH starts with `0x`,
TRX starts with `T`, and so on. XMR shows an error — that is expected, Monero
needs its own daemon and nothing else depends on it.

This is also your seed-recovery test. Those addresses come only from your 24
words; if you ever restore from paper, this command must print the same list.

---

## Step 10 — Set up the Telegram bot

The bot is how you watch the gateway: deposit alerts, balances, logs, and
moving funds out.

1. In Telegram, search for **@BotFather** and open it.
2. Send `/newbot`. It asks for a name (anything) and a username (must end in
   `bot`).
3. It replies with a token like `8123456789:AAH...`. Copy it.
4. Send your new bot any message — just "hello". This is needed so it can reply
   to you.

Then on the server:

```bash
sudo -u gateway nano /opt/gateway/app/.env
```

Set:

```
TELEGRAM_BOT_TOKEN=the token from BotFather
TELEGRAM_CHAT_ID=
```

Leave the chat id empty for now; the next step tells you what it is.

---

## Step 11 — First run, by hand

Start it in the foreground so you can see what happens:

```bash
cd /opt/gateway/app
sudo -u gateway npm start
```

**Check:** within a few seconds you see lines including:

```
INFO [db] database ready
INFO [http] API listening on http://127.0.0.1:8787
INFO [telegram] connected to Telegram as @your_bot
INFO [watcher] watching 15 chains
```

Now message your bot in Telegram. It replies:

```
Not authorized. Add this chat id to TELEGRAM_ADMIN_CHAT_IDS:
123456789
```

Copy that number. Press **Ctrl+C** to stop the gateway, then:

```bash
sudo -u gateway nano /opt/gateway/app/.env
```

Set `TELEGRAM_CHAT_ID=` to that number and save.

**If something went wrong instead:**

- `Segmentation fault` → Node is not v22. Go back to step 3.
- `port 8787 is already in use` → something else holds that port. Run
  `ss -tlnp | grep 8787` to see what, then either stop it or pick a different
  `PORT` in `.env`.
- `MASTER_MNEMONIC is not a valid BIP39 mnemonic` → the words were pasted with
  a line break or double space. Re-edit `.env`.

---

## Step 12 — Verify everything with the self-test

Start the gateway again in one terminal:

```bash
cd /opt/gateway/app && sudo -u gateway npm start
```

Open a **second** SSH session to the server and run:

```bash
cd /opt/gateway/app && sudo -u gateway npm run selftest
```

**Check:** you want ticks for the configuration, connectivity, authentication
and address generation sections. Two crosses are expected at this point and
fine:

- `DEFAULT_IPN_URL is empty` — you set that in step 15
- possibly `IPN_SECRET is empty` if you skipped it in step 8; go back and set it

A cross on **MASTER_MNEMONIC_PASSPHRASE is set** matters — empty it in `.env`,
delete `data/gateway.db`, and restart. Do that now rather than after money
arrives.

Stop the gateway with Ctrl+C when the self-test passes.

---

## Step 13 — Make it a permanent service

So far the gateway only runs while your terminal is open. systemd keeps it
running after you log out and restarts it on reboot.

```bash
cat > /etc/systemd/system/gateway.service <<'EOF'
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

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/gateway/app/data
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now gateway
systemctl status gateway --no-pager
```

**Check:** the status says `Active: active (running)`. Your Telegram bot also
posts a startup banner with the full command list.

If it says `failed`, read the reason:

```bash
journalctl -u gateway -n 30 --no-pager
```

From now on, **never run `npm start` again** — systemd owns the process. Use:

```bash
systemctl restart gateway    # after a code change
systemctl stop gateway
journalctl -u gateway -f     # watch it live
```

---

## Step 14 — Lock down the network and keep the logs

Firewall. This blocks everything except SSH, which is all you need since the
gateway listens only on `127.0.0.1`:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable
ufw status
```

If your exchange's website is on this same server and serves the public, also:

```bash
ufw allow 80/tcp
ufw allow 443/tcp
```

Make the system log survive reboots. Without this, journald keeps logs in
memory only and every restart wipes your history:

```bash
mkdir -p /var/log/journal
systemctl restart systemd-journald
```

The gateway also writes its own log file, which needs no setup and rotates
itself:

```bash
tail -f /opt/gateway/app/data/gateway.log
grep ERROR /opt/gateway/app/data/gateway.log
```

Or send `/logs` to your Telegram bot.

---

## Step 15 — Connect your exchange

Two things to change on your exchange.

**The API keys.** In your exchange's admin panel, wherever the WestWallet
public and private keys were entered, put the two keys from step 7.

**The API address.** Your exchange must call this gateway instead of
`api.westwallet.io`. Where to change it depends on your software:

- If it has a settings field for the API URL, set it to
  `http://127.0.0.1:8787`.
- If the URL is compiled in and cannot be configured (the yukitale exchange is
  like this), run the redirect script, which makes that hostname resolve to
  your gateway:

  ```bash
  cd /opt/gateway/app
  bash scripts/setup-westwallet-redirect.sh 8787
  ```

  Then restart your exchange application so it picks up the new certificate,
  and check it:

  ```bash
  curl -sS https://api.westwallet.io/health
  ```

  That should print the gateway's JSON. See `docs/REDIRECT-WESTWALLET.md` for
  what it changes and how to undo it.

**The deposit notifications.** Your exchange may poll for deposits, or it may
want callbacks. If it wants callbacks, set in `.env`:

```
DEFAULT_IPN_URL=http://127.0.0.1:YOUR_SITE_PORT/your/callback/path
```

using the path your exchange already used for WestWallet, and restart the
gateway. Your handler must verify the `X-Gateway-Signature` header against
`IPN_SECRET` — see the README.

**Check:** open your exchange, go to deposit, pick a coin, and click to show
the address. Watch the gateway at the same time:

```bash
journalctl -u gateway -f
```

A line ending in `-> 200` means it worked. A `WARN` line means something did
not match — set `AUTH_DEBUG=true` in `.env`, restart, try again, and the log
will say exactly what your exchange sent.

---

## Step 16 — Back up the database

Your seed controls the money, so losing the database does not lose funds. But
it holds which customer owns which address, and rebuilding that is miserable.

```bash
mkdir -p /opt/gateway/backups
cat > /etc/cron.daily/gateway-backup <<'EOF'
#!/bin/sh
sqlite3 /opt/gateway/app/data/gateway.db \
  ".backup '/opt/gateway/backups/gateway-$(date +%F).db'"
find /opt/gateway/backups -name 'gateway-*.db' -mtime +30 -delete
EOF
chmod +x /etc/cron.daily/gateway-backup
/etc/cron.daily/gateway-backup
ls -l /opt/gateway/backups
```

**Check:** a `.db` file is listed.

Copy those backups off the server regularly. A backup that only exists on the
machine it is backing up is not a backup.

---

## Step 17 — Before you take real money

Work through this. Each line is something that costs real money if skipped.

- [ ] `node -v` says v22
- [ ] Your 24 words are on paper, in two places, and nowhere digital
- [ ] `MASTER_MNEMONIC_PASSPHRASE` is empty
- [ ] `npm run selftest` passes
- [ ] `systemctl status gateway` says active, and survives `reboot`
- [ ] Telegram bot responds to `/status`
- [ ] Your exchange can fetch a deposit address
- [ ] **Send one small real deposit on each coin you intend to offer**, and
      watch it credit. Not optional — this is the only test that proves the
      whole path.
- [ ] `/holdings` in Telegram shows that deposit on chain
- [ ] **Verify every token contract address** in `src/currencies.ts` against a
      block explorer. A wrong contract or wrong decimals credits the wrong
      amount, by a factor of a trillion in the worst case.
- [ ] Database backups are running and copied off the server
- [ ] If you offer XRP, XLM or EOS, their gateway accounts are funded and set —
      run `npm run addresses -- --shared`
- [ ] A free TronGrid API key is set in `TRON_API_KEY`, or Tron scanning stays
      slow

---

## Updating later

```bash
sudo -u gateway git -C /opt/gateway/app pull
sudo -u gateway npm --prefix /opt/gateway/app ci
sudo -u gateway npm --prefix /opt/gateway/app run build
systemctl restart gateway
```

If the pull complains that `package-lock.json` would be overwritten, discard
the local copy — it is a generated file:

```bash
sudo -u gateway git -C /opt/gateway/app checkout -- package-lock.json
```

---

## If something breaks

| What you see | What it means |
|---|---|
| `Segmentation fault` | Node is not v22 — redo step 3 |
| `port ... already in use` | Another service has the port, or systemd already runs the gateway. `ss -tlnp \| grep 8787` |
| `EBADENGINE` during install | Node is too old |
| `dubious ownership` from git | You ran git as root on the gateway user's files. Prefix with `sudo -u gateway` |
| 401 in the log | Your exchange's signature did not match. Set `AUTH_DEBUG=true`, restart, retry |
| `HTTP 403 ... block page` | A free blockchain endpoint is refusing this server. It falls back automatically; a `BLOCKCHAIR_API_KEY` helps |
| Deposits detected but never credited | Check `/pending` in Telegram and the confirmation counts |
| Bot silent | `journalctl -u gateway -n 50`, check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` |

Useful commands to keep:

```bash
systemctl status gateway
journalctl -u gateway -f
cd /opt/gateway/app && sudo -u gateway npm run selftest
tail -50 /opt/gateway/app/data/gateway.log
```

Further reading: `README.md` for the API and bot commands,
`docs/OPERATIONS.md` for running it day to day, `docs/DEPLOYMENT.md` for the
reasoning behind these choices, `docs/WITHDRAWALS.md` for moving funds out.
