# Withdrawals

## What exists

`POST /wallet/send` currently:

1. validates the currency, address and amount;
2. debits the user's balance (atomically — no overdraft);
3. records the withdrawal with status `created`;
4. returns it, with an id you can poll.

It stops there. **Nothing is signed and nothing is broadcast.** Withdrawals sit
in `created` until someone processes them.

`request_id` is honoured as an idempotency key: sending the same one twice
returns the original withdrawal instead of paying twice. Use it — a retried HTTP
request is the classic way to double-pay a customer.

## Why it stops there

Two reasons, both worth taking seriously.

**Signing 15 chains is a project, not a feature.** Each family needs its own
transaction construction: UTXO selection and change for the Bitcoin-likes, nonce
and gas management for EVM, energy and bandwidth for Tron, sequence numbers for
XRP, blockhash lifetimes for Solana, and Monero's ring signatures. Trust Wallet
Core can sign all of them — `AnySigner` is already available in the dependency —
but each chain needs its own input construction, fee estimation and broadcast
path, and each needs testing with real money before it can be trusted.

**An automated hot wallet is the most dangerous thing an exchange runs.** A
service that both holds keys and decides when to move funds is the component
attackers go for, and a bug in it spends real money irreversibly. Shipping that
untested, alongside everything else here, would have been the wrong call.

The deposit path — where an error costs you a missed credit, not a drained wallet
— is complete and tested.

## Processing withdrawals today

Pull the queue and pay them from the Trust Wallet app holding the master seed:

```sql
SELECT uid, currency, address, tag, amount_units, created_at
FROM withdrawals WHERE status = 'created' ORDER BY id;
```

Then record what you did, so the API reports it correctly:

```sql
UPDATE withdrawals
SET status = 'completed', txid = '<hash>', updated_at = datetime('now')
WHERE uid = '<uid>';
```

Manual processing is genuinely reasonable at low volume, and it is how most
exchanges start. It also gives you a human check on every outgoing payment,
which is worth more than it sounds.

## Finishing it

If you want it automated, the shape to build:

1. **A signer per chain family**, behind one interface:
   `sign(currency, to, tag, amount) -> rawTx`. Trust Wallet Core's `AnySigner`
   does the cryptography; you supply inputs (UTXOs, nonce, fee, blockhash).
2. **A hot wallet at a known index** — derivation index 0 is reserved for exactly
   this. Sweep deposits into it, pay withdrawals out of it, keep the float small
   and the rest in cold storage.
3. **A broadcaster** per chain, plus confirmation tracking that flips
   `pending` to `completed` the same way deposits do.
4. **Approval gates** before any of it moves money: a per-transaction cap, a
   daily total cap, an allowlist for large destinations, and manual review above
   a threshold. Build these first, not last.
5. **Run the signer on a separate machine** from the public API, reachable only
   through a queue. The box that faces the internet should not hold spend keys —
   this is what `WATCH_ONLY=true` is for.

The withdrawal table, statuses, idempotency and balance debiting are already in
place, so a signer can be added without reworking the schema.
