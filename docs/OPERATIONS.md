# Operations

## Keeping the seed safe

The mnemonic is the whole exchange. Anyone who reads it can take every user
deposit; if you lose it, every deposit is gone permanently and no backup of the
database will bring it back.

Practical arrangement:

- **Generate it offline.** `npm run seed` on a machine that has never been on the
  internet is not paranoid here.
- **Two paper copies**, in two physical locations. Metal if you can.
- **The internet-facing box runs `WATCH_ONLY=true`.** It serves addresses out of
  the database and never loads the seed, so a web compromise cannot spend.
- **Pre-generate addresses** on a separate machine that does hold the seed, so
  the watch-only box always has addresses to hand out.

The database stores which user owns which derivation index. Losing the database
does not lose the money — the seed still controls it — but it does lose the
mapping from index back to user, which is painful to reconstruct. Back it up.

```bash
sqlite3 data/gateway.db ".backup 'backup-$(date +%F).db'"
```

## Sweeping deposits

Deposits sit at each user's derived address. Nothing moves them automatically.

- **UTXO chains** (BTC, LTC, DOGE, DASH, BCH, ZEC) — sweep whenever you like;
  fees scale with the number of inputs, so batch them.
- **EVM chains** (ETH, BSC) — a token deposit is stranded until the address holds
  native gas. You must send a little ETH/BNB to the address before you can move
  the USDT out of it. Budget for this: at scale it is a real cost.
- **Tron** — the same problem, in TRX and energy.
- **Tag chains** (XRP, XLM, EOS) — nothing to sweep, funds are already in the one
  gateway account.
- **Monero** — already in one wallet; subaddresses are not separate wallets.

Since the whole tree is one seed, the simplest sweep is to import the mnemonic
into the Trust Wallet app and move funds by hand while volumes are low.

## Scaling the watcher

The default scan is per-address on the UTXO chains, Tron and Solana: one request
per address per pass. That is fine into the low thousands of addresses and starts
to hurt past that.

When you outgrow it:

1. **Split chains across processes** with `WATCHER_CHAINS=bitcoin,litecoin` so
   each has its own budget and a stall on one chain does not delay the others.
2. **Use xpub scanning on the UTXO chains.** Blockbook exposes
   `/api/v2/xpub/{xpub}`, which returns the whole HD wallet's activity in one
   request regardless of address count. This is the single biggest win available.
3. **Run your own nodes.** The EVM providers already scan by block range and are
   node-friendly; a private RPC removes the rate limits entirely.
4. **Raise `WATCHER_INTERVAL_MS`** for slow chains. Dogecoin does not need a
   30-second poll.

The EVM and tag-chain providers already scale properly — token scanning is one
`eth_getLogs` per contract per pass no matter how many users you have, and XRP,
XLM, EOS and Tezos are one request per pass total.

## Monero

XMR is the one chain that needs its own daemon, because Monero deposits can only
be found by scanning the chain with the wallet's view key — there is no address
to look up in an explorer.

```bash
monero-wallet-rpc \
  --wallet-file gateway-wallet \
  --daemon-address node.example:18081 \
  --rpc-bind-port 18083 \
  --disable-rpc-login          # use --rpc-login user:pass in production
```

The gateway calls `create_address` for each user, labelled `user:<index>`, so
the mapping survives restoring the wallet from its seed. The model is the same
as everywhere else — one wallet, one subaddress per user.

If you do not want to run this, drop XMR from `src/currencies.ts`. Everything
else works without it.

## Confirmations

Set in `src/chains.ts`, overridable per currency. The defaults are ordinary
exchange values (BTC 2, ETH 12, BSC 15, TRX 20, DOGE 20). Raising them costs
your users time; lowering them costs you money when a chain reorganises. Do not
lower them for high-value assets.

## Logs

Everything is written twice: to the console, which systemd captures into its
journal, and to a file at `data/gateway.log`.

```bash
tail -f /opt/gateway/app/data/gateway.log       # follow, no root needed
grep ERROR /opt/gateway/app/data/gateway.log    # just the failures
journalctl -u gateway -f                         # the same output via systemd
```

The file rotates at 10 MB, keeping five older copies (`gateway.log.1` and so
on), so it cannot fill the disk. `LOG_FILE`, `LOG_MAX_BYTES` and `LOG_KEEP`
control it; an empty `LOG_FILE` turns the file off and leaves the journal.

`/logs` in the Telegram bot shows the last lines from the same file, and
`/logs errors` filters to warnings and errors — useful for checking on the
gateway from a phone.

Two reasons the file exists alongside the journal. The journal is volatile
unless `/var/log/journal` exists — without that directory it lives in RAM and
every reboot wipes your history:

```bash
ls -d /var/log/journal || (mkdir -p /var/log/journal && systemctl restart systemd-journald)
```

And the file needs no root and no systemd, so it is there when the gateway is
run by hand, in a container, or anywhere the journal is not.

Writing the log is never allowed to interrupt the gateway. If the file cannot
be written the logger says so once, disables itself and carries on to the
console — losing a log line is acceptable, refusing to credit a deposit
because of one is not.

## Monitoring

`GET /status` reports each chain's cursor, last run time and last error. Alert on:

- a chain whose `last_run_at` is not advancing — its scanner is wedged;
- a non-null `last_error` that persists across passes;
- `ipn_queue` rows in `failed` — your exchange missed a deposit notification;
- deposits stuck `pending` far longer than their confirmation window.

```sql
SELECT status, COUNT(*) FROM ipn_queue GROUP BY status;
SELECT chain, currency, COUNT(*) FROM deposits WHERE status='pending' GROUP BY 1,2;
```

## Adding a currency

For a token on a chain that already works, add an entry to `src/currencies.ts`
with its contract address and decimals — the watcher picks it up automatically,
and users deposit to the address they already have.

For a new chain, add it to `src/chains.ts` and write a provider in
`src/watcher/providers/`. The interface is one method: given the watched
addresses and a cursor, return what you saw.
