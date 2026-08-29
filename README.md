# trustwestme

A self-hosted crypto payment gateway that replaces WestWallet. It speaks a
WestWallet-shaped API, derives every user's deposit addresses from one Trust
Wallet seed phrase, watches 15 chains for incoming money, and calls your
exchange back when a deposit lands.

21 currencies: BTC, ETH, SOL, USDT (TRC-20 / ERC-20 / BEP-20), USDC (TRC-20),
TRX, XRP, BNB, EOS, XTZ, XMR, ZEC, BCH, BUSD (BEP-20), SHIB (BEP-20), DOGE,
LTC, XLM, DASH.

---

## Read this first: what "using Trust Wallet" actually means here

You asked for one main Trust Wallet account with a sub-account per user, all
from the same seed phrase. That is exactly what this does — but it is worth
being precise about the mechanism, because two parts of the original plan work
differently than expected.

**1. The wallet: yes, this is genuinely Trust Wallet.**

Trust Wallet the *app* has no server API — you cannot call it to make accounts.
What it has is **Trust Wallet Core**, the open-source library the app itself is
built on. That library is in here (`@trustwallet/wallet-core`), and it does the
precise thing you described: from one BIP39 seed phrase it derives a separate
address for every user, on every chain, using standard BIP44 paths.

Your user #1 gets index 1, user #2 gets index 2, and so on. One number
identifies a user's whole set of addresses across all 15 chains.

The payoff is real: **your seed phrase alone controls every user's deposit
address and every coin in them.** Nothing is custodial to a third party, and
there is no account with anyone to lose.

One caveat worth knowing before you need it: importing the seed into the Trust
Wallet app shows you index 0 only. User addresses start at index 1, so their
balances do not appear in the app even though the same phrase controls them.
Use `/key` or `/withdraw` in the Telegram bot to reach those — see
[Recovering funds](#recovering-funds-from-a-deposit-address).

**2. Detecting deposits cannot come from Trust Wallet.**

This is the one place the original plan cannot work as stated. You asked to skip
node providers and "get everything from Trust Wallet" — but Trust Wallet does
not offer deposit notifications. Nothing about holding keys tells you money
arrived; that information only exists on the blockchains themselves. Any gateway
— WestWallet included — has to read the chains.

So the watcher reads them, and I kept it as close to your intent as possible:
**no accounts, no API keys, no signups.** Every chain has a working public
endpoint already configured in `.env.example`. You can run this today without
registering anywhere. Each one is a single config line you can point at your own
node later, and only Tron benefits from a (free) key under real load.

That is the honest version of "just Trust Wallet": Trust Wallet Core owns all
the keys and addresses; public read-only endpoints answer the question "did money
arrive?".

---

## How a deposit works

```
  your exchange                trustwestme                    blockchains
       │                            │                              │
       │  POST /address/generate    │                              │
       │  {currency, label:"u-42"}  │                              │
       ├───────────────────────────►│                              │
       │                            │ derive from seed @ index 42  │
       │  {address, dest_tag}       │                              │
       │◄───────────────────────────┤                              │
       │                            │                              │
       │                            │  poll every 30s              │
       │                            ├─────────────────────────────►│
       │                            │  "0.01 BTC to that address"  │
       │                            │◄─────────────────────────────┤
       │   IPN: status=pending      │                              │
       │◄───────────────────────────┤  (recorded, not spendable)   │
       │                            │                              │
       │                            │  ...2 confirmations later    │
       │   IPN: status=completed    │                              │
       │◄───────────────────────────┤  balance credited            │
```

Credit the user when you receive **`completed`**. `pending` is for showing them
"we see your deposit, it's confirming".

---

## Setup

```bash
npm install

# 1. Generate the master seed. Write it down offline. This IS the exchange.
npm run seed

# 2. Generate your API keypair.
npm run keys

# 3. Configure.
cp .env.example .env    # paste the seed, the keys, and your IPN url

# 4. Check the seed produces sane addresses before trusting it.
npm run addresses -- 1

# 5. Run.
npm run build && npm start
```

### Before real money: the tag/memo chains

XRP, XLM and EOS need one gateway account that must exist before deposits can
arrive:

```bash
npm run addresses -- --shared
```

- **XRP** — fund the address with the base reserve (~1 XRP) to activate it.
- **XLM** — fund with the base reserve (~1 XLM) to activate it.
- **EOS** — accounts are *named*; register a 12-character name and set
  `EOS_ACCOUNT` to it. The derived key is the one to assign as its owner.

Then paste the live values into `XRP_ADDRESS`, `STELLAR_ADDRESS`, `EOS_ACCOUNT`.

### Why those three share one address

On those chains an account has to be created and funded before it can receive
anything. Giving every user their own would mean pre-funding a reserve for every
signup — money you would never get back from users who never deposit. So they
get one shared address and a **per-user destination tag / memo**, which is what
every exchange does. The API returns `dest_tag` alongside `address`; your deposit
page must show both, and a deposit arriving without a tag cannot be attributed
(the watcher logs these loudly so you can credit them by hand).

---

## API

Base URL is your own server. All endpoints except `/health` need credentials.

### Authentication

Two keys — one public, one private. The private key never leaves your server.

**The default (`AUTH_MODE=auto`) accepts any of the three schemes below**, so an
existing WestWallet integration works without touching it.

**WestWallet-compatible** — what the official WestWallet SDKs send:

| Header | Value |
|---|---|
| `X-API-KEY` | your public key |
| `X-ACCESS-TIMESTAMP` | current unix seconds |
| `X-ACCESS-SIGN` | `hex(HMAC-SHA256(private_key, timestamp + body))` |

`body` is the JSON request body exactly as your client serialised it — for GET
requests, the JSON serialisation of the query parameters. The signature is
checked against the raw bytes received, and GET requests are matched against
several serialisation styles (Python's `json.dumps` adds a space after `:` and
`,`; most other languages do not), so any language's client verifies.

```python
sign = hmac.new(secret_key.encode('utf-8'),
                "{}{}".format(timestamp, dumped).encode('utf-8'),
                hashlib.sha256).hexdigest()
```

**Nonce scheme** — `X-API-KEY` + `X-Nonce` + `X-Signature`, where the signature
is `hex(HMAC-SHA256(private_key, nonce + public_key))`. Nonces are single-use,
so a captured request cannot be replayed.

**Simple** — `X-API-KEY` + `X-API-SECRET`. Only acceptable behind TLS or on
localhost.

If a signature is being rejected and you cannot tell why, set `AUTH_DEBUG=true`.
The log then shows the timestamp, the raw body, every payload variant that was
tried and the signature each produced — enough to see exactly where your client
differs.

### `POST /address/generate`

```json
{ "currency": "USDTTRC", "label": "user-4471", "ipn_url": "https://you/hook" }
```

`label` is **optional**, matching WestWallet's `generateAddress("BTC")`. Without
it you get a fresh address per call and keep your own address-to-user mapping,
exactly as WestWallet works. With it, the gateway keeps the mapping instead:
repeat calls for the same user return the same address, deposits arrive already
attributed, and `/wallet/balance?label=…` works per user. Pass one where you can.

```json
{
  "address": "TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK",
  "dest_tag": null,
  "tag_name": null,
  "currency": "USDTTRC",
  "blockchain": "tron",
  "label": "user-4471",
  "shared_with": ["TRX", "USDCTRC20"],
  "required_confirmations": 20,
  "min_deposit": "1"
}
```

`shared_with` tells you which other currencies land on that same address.

### Other endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/wallet/balance?currency=BTC&label=user-1` | one user's balance (omit `label` for the gateway total) |
| `GET` | `/wallet/balances` | every currency at once |
| `GET` | `/wallet/transactions?currency=&label=&status=` | deposit / withdrawal history |
| `GET` | `/wallet/transaction?id=<uuid>` | a single transaction |
| `POST` | `/wallet/send` | queue a withdrawal (see below) |
| `GET` | `/wallet/currency_info?currency=BTC` | decimals, contract, confirmations |
| `GET` | `/currencies` | all 21 currencies |
| `GET` | `/status` | watcher health per chain |
| `GET` | `/health` | liveness, no auth |

### Currency names

Canonical tickers are `BTC`, `USDTTRC`, `USDTERC20`, `USDTBEP20`, `USDCTRC20`,
`BUSDBEP20`, `SHIBBEP20`, and so on — but aliases are accepted, so
`USDT-TRC20`, `usdt.trc20`, `bitcoin` and `ripple` all resolve correctly. Your
existing integration can keep sending whatever spelling it already uses. See
`GET /currencies` for every accepted alias.

---

## Telegram control bot

A bot that watches the gateway and answers commands, so you can check on things
without SSH. It uses long polling — no public URL, no webhook, works behind NAT.

### Setup

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token
   into `TELEGRAM_BOT_TOKEN`.
2. Send your new bot any message.
3. Start the gateway. If the chat is not yet authorized the bot replies with the
   chat id — paste it into `TELEGRAM_CHAT_ID` and restart.

On startup it posts a banner and the full command list to your master chat, so
you know it came up. Commands are also registered with Telegram, so typing `/`
in the chat shows the menu.

### Commands

| Command | What it does |
|---|---|
| `/help` | Every command (also sent on startup) |
| `/status` | Watcher health, error count, pending deposits |
| `/stats` | Deposit, withdrawal and balance totals |
| `/balances` | Credited ledger — what users are owed |
| `/holdings [chain]` | Live scan of every address: what is really on chain |
| `/balance <CUR> [user]` | One currency, optionally for one user |
| `/user <label>` | A user's addresses and balances |
| `/address <label> <CUR>` | Show or create a deposit address |
| `/deposits [n]` | Most recent deposits |
| `/pending` | Deposits still confirming |
| `/tx <id>` | Full detail on one transaction |
| `/withdrawals [n]` | Most recent withdrawals |
| `/chains` | Per-chain watcher state, green/red |
| `/currencies` | All 21 currencies by chain |
| `/scan [chain]` | Force a scan instead of waiting for the timer |
| `/ipn` | Callback queue health and recent failures |
| `/users [n]` | Recently created users |
| `/key [address]` | Reveal a private key, after a confirmation |
| `/withdraw [CUR]` | Send funds out — asks destination and amount |
| `/cancel` | Stop a command that is waiting on an answer |

### Knowing what you actually hold

`/balances` and `/holdings` answer different questions, and the difference
matters:

- **`/balances`** reads the database — what users have been credited, i.e. what
  you owe them. Instant.
- **`/holdings`** walks every address on every chain and asks the network what
  is really there. One request per address against rate-limited endpoints, so
  it takes a minute or two; the bot acknowledges immediately and sends the
  report when it is done.

`/holdings` also compares the two and flags every currency where they disagree,
with the direction marked: `▲` means the chain holds more than you have
credited (an uncredited deposit, or your own float), `▼` means you have credited
more than exists on chain — which is the one to investigate straight away.

It lists the addresses holding each currency too, so a sweep can be aimed
without a second lookup. `/holdings bitcoin` restricts the scan to one chain,
which is much quicker.

### Recovering funds from a deposit address

Deposits land on per-user addresses at derivation index 1 and above. **The
Trust Wallet app only displays index 0**, so those balances are invisible in the
app even though the seed controls them. Two ways to reach them:

`/key` exports the private key for one address, in the format that address's
wallet expects — WIF for BTC/LTC/DOGE/DASH/BCH/ZEC, hex for ETH/BSC/TRON, base58
for Solana. Import it with **Import Wallet → Private Key** and the funds appear.
The bot asks for confirmation first and deletes the message after 90 seconds.

`/withdraw` moves funds without exposing a key: pick a currency, give a
destination, then an amount or a percentage (`100%`, `50%`, `0.01`). It shows
what will be sent and needs an explicit `YES` before broadcasting.

Sending is implemented for **BTC, LTC, DOGE, DASH, BCH, ZEC, ETH, BNB and the
ERC-20/BEP-20 tokens** — signed with Trust Wallet Core and broadcast directly.
The other chains need their own transaction construction and are not built yet;
`/withdraw` says so and points you at `/key` instead.

A token sweep needs gas on the address it spends from. Moving USDT out of a
deposit address means sending a little ETH or BNB there first — `/withdraw`
tells you when that is the blocker rather than failing obscurely.

### Deposit alerts

Every deposit posts to your master chat — once on sight, once on crediting:

```
🟡 Deposit detected
0.0025 BTC
User: user-4471
Confirmations: 1/2
Address: bc1q...

✅ Deposit credited
0.0025 BTC
User: user-4471
Address: bc1q...
View on explorer
/tx 8f14e45f-ceea-467a-9f6b-2c1d3e4a5b60
```

Set `TELEGRAM_NOTIFY_PENDING=false` if you only want the credited alert.

### Access control

Only chats in `TELEGRAM_ADMIN_CHAT_IDS` may run commands; everyone else is
refused before any handler runs. This matters — the bot can read every balance
and every user's addresses, so treat the token like a password. It cannot move
money: there is no withdrawal or spend command, by design.

A Telegram outage cannot affect deposits. The bot subscribes to gateway events
rather than sitting in the crediting path, and failures are logged and dropped.

---

## Deposit callbacks (IPN)

Each deposit fires twice — once on first sight, once on confirmation:

```json
{
  "id": "8f14e45f-ceea-467a-9f6b-2c1d3e4a5b60",
  "type": "deposit",
  "currency": "BTC",
  "address": "bc1q...",
  "dest_tag": null,
  "amount": "0.01",
  "status": "completed",
  "blockchain_hash": "9a2f...",
  "blockchain_confirmations": 2,
  "required_confirmations": 2,
  "label": "user-4471",
  "explorer_url": "https://blockchair.com/bitcoin/transaction/9a2f..."
}
```

Verify the signature before trusting it:

```js
const expected = crypto.createHmac('sha256', IPN_SECRET)
                       .update(rawRequestBody).digest('hex');
// compare against the X-Gateway-Signature header
```

Delivery is **at-least-once** with exponential backoff, so make your handler
idempotent on `id`. Failed callbacks retry for about a day before giving up.

---

## What is deliberately not built

**Withdrawals do not sign or broadcast.** `POST /wallet/send` validates the
request, debits the user and records it — then stops, leaving the withdrawal in
`created` for an operator to process. Transaction signing across 15 chains is a
project of its own, and an automated hot wallet that can move funds is the single
most dangerous component an exchange runs. See `docs/WITHDRAWALS.md` for the
design and how to finish it.

Everything on the deposit path — derivation, watching, confirming, crediting,
callbacks — is complete.

---

## Before you go live

- [ ] **Verify every token contract address** in `src/currencies.ts` against a
      block explorer. A wrong address credits worthless tokens as real ones.
- [ ] Send a small real deposit on each chain you enable and watch it credit.
- [ ] Confirm the seed restores: `npm run addresses -- 1`, wipe, restore, compare.
- [ ] Put the API behind TLS. The signature protects the body, not the contents.
- [ ] Run the public box with `WATCH_ONLY=true`.
- [ ] Back up `data/gateway.db` — it holds the user-to-index mapping.
- [ ] Read `docs/DEPLOYMENT.md` (Linux VPS, systemd, firewall) and
      `docs/OPERATIONS.md`.

---

## Testing

```bash
npm test
```

66 tests cover derivation against published BIP39 vectors, address formats for
every chain, tag attribution, dust rejection, request signing and replay
rejection, the Telegram command surface against a stand-in Telegram server,
and — most importantly — that a deposit seen on twenty consecutive scans is
credited exactly once.

---

## Layout

```
src/
  chains.ts          how each chain derives addresses and gets watched
  currencies.ts      the 21 assets, their decimals and contracts
  wallet/            Trust Wallet Core derivation, Monero RPC
  db/                SQLite schema and queries
  api/               HTTP server, auth, WestWallet-shaped routes
  watcher/providers/ one deposit scanner per chain family
  telegram/          control bot: commands and deposit alerts
  events.ts          domain events the bot subscribes to
  ipn.ts             signed callbacks with retries
```
