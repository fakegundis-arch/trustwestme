import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { listCurrencies, CURRENCIES } from '../currencies';
import { CHAINS, getChain } from '../chains';
import { fromBaseUnits, toBaseUnits } from '../util/decimal';
import { getDepositIdentity, requireCurrency, ApiError } from '../services/addresses';
import { depositToJson, withdrawalToJson, requiredConfirmations } from './serialize';
import * as repo from '../db/repo';
import { logger } from '../util/log';

const log = logger('api');

export const routes = Router();

/** Wrap async handlers so a rejected promise becomes a clean 4xx/5xx. */
const h = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) => {
    fn(req, res).catch((e: unknown) => {
      if (e instanceof ApiError) return res.status(e.status).json({ error: 'bad_request', message: e.message });
      log.error(`${req.method} ${req.path} failed`, String(e));
      res.status(500).json({ error: 'internal_error', message: e instanceof Error ? e.message : String(e) });
    });
  };

function param(req: Request, name: string): string | undefined {
  const v = (req.body?.[name] ?? req.query?.[name]) as unknown;
  if (v === undefined || v === null || v === '') return undefined;
  return String(v);
}

// ---------------------------------------------------------------------------
// POST /address/generate
// Issue (or return) a user's deposit address for a currency.
//
//   { "currency": "USDTTRC", "label": "user-4471", "ipn_url": "https://..." }
//
// `label` is the identifier of the user in YOUR system — it is what ties the
// deposit back to an account. `user_id` is accepted as an explicit alias.
// ---------------------------------------------------------------------------
routes.post('/address/generate', h(async (req, res) => {
  const currency = param(req, 'currency');
  if (!currency) throw new ApiError(400, 'currency is required');

  // WestWallet's generateAddress() takes only a currency, and the merchant
  // stores the address-to-user mapping itself. That still works here: with no
  // label we allocate a fresh identity and hand back a fresh address, and the
  // caller maps it their own way. Passing a label is better where you can —
  // the gateway then keeps the mapping, and repeat calls for the same user
  // return the same address instead of consuming a new one each time.
  const explicitUser = param(req, 'user_id') ?? param(req, 'label');
  const userId = explicitUser ?? `auto-${randomUUID()}`;

  const identity = await getDepositIdentity({
    userExternalId: userId,
    currency,
    ipnUrl: param(req, 'ipn_url') ?? null,
    label: param(req, 'label') ?? null,
  });

  res.json({
    address: identity.address,
    dest_tag: identity.tag,
    tag_name: identity.tagName,
    currency: identity.currency,
    blockchain: identity.chain,
    label: userId,
    shared_with: identity.sharedWith,
    required_confirmations: requiredConfirmations(identity.currency),
    min_deposit: CURRENCIES[identity.currency].minDeposit,
  });
}));

// ---------------------------------------------------------------------------
// GET /wallet/balance?currency=BTC[&label=user-4471]
// Without a label: the gateway-wide credited balance. With one: that user's.
// ---------------------------------------------------------------------------
routes.get('/wallet/balance', h(async (req, res) => {
  const cur = requireCurrency(param(req, 'currency') ?? '');
  const label = param(req, 'label') ?? param(req, 'user_id');

  if (label) {
    const user = repo.getUserByExternalId(label);
    if (!user) throw new ApiError(404, `unknown user: ${label}`);
    const b = repo.getBalance(user.id, cur.ticker);
    return res.json({
      currency: cur.ticker,
      label,
      balance: fromBaseUnits(b.available, cur.decimals),
      pending: fromBaseUnits(b.pending, cur.decimals),
    });
  }

  const total = repo.getTotalBalance(cur.ticker);
  res.json({ currency: cur.ticker, balance: fromBaseUnits(total, cur.decimals) });
}));

// GET /wallet/balances — every currency at once.
routes.get('/wallet/balances', h(async (_req, res) => {
  const out = listCurrencies().map((c) => ({
    currency: c.ticker,
    balance: fromBaseUnits(repo.getTotalBalance(c.ticker), c.decimals),
  }));
  res.json({ balances: out });
}));

// ---------------------------------------------------------------------------
// GET /wallet/transactions?currency=&status=&label=&limit=&offset=
// ---------------------------------------------------------------------------
routes.get('/wallet/transactions', h(async (req, res) => {
  const currencyRaw = param(req, 'currency');
  const currency = currencyRaw ? requireCurrency(currencyRaw).ticker : undefined;
  const label = param(req, 'label') ?? param(req, 'user_id');
  const status = param(req, 'status');
  const limit = Number(param(req, 'limit') ?? 100);
  const offset = Number(param(req, 'offset') ?? 0);

  let userId: number | undefined;
  if (label) {
    const user = repo.getUserByExternalId(label);
    if (!user) throw new ApiError(404, `unknown user: ${label}`);
    userId = user.id;
  }

  const type = param(req, 'type');
  const result: unknown[] = [];
  if (type !== 'withdrawal') {
    result.push(...repo.listDeposits({ userId, currency, status, limit, offset }).map(depositToJson));
  }
  if (type !== 'deposit' && !userId) {
    result.push(...repo.listWithdrawals({ currency, status, limit, offset }).map(withdrawalToJson));
  }
  res.json({ transactions: result, count: result.length });
}));

// /wallet/transaction?id=<uid>
// The WestWallet SDKs POST to this; GET is accepted too.
const transactionHandler = h(async (req: Request, res: Response) => {
  const id = param(req, 'id');
  if (!id) throw new ApiError(400, 'id is required');
  const dep = repo.getDepositByUid(id);
  if (dep) return res.json(depositToJson(dep));
  const wd = repo.getWithdrawalByUid(id);
  if (wd) return res.json(withdrawalToJson(wd));
  throw new ApiError(404, `no transaction with id ${id}`);
});
routes.get('/wallet/transaction', transactionHandler);
routes.post('/wallet/transaction', transactionHandler);

// ---------------------------------------------------------------------------
// POST /wallet/send — queue a withdrawal.
//
// IMPORTANT: this records and validates the request and debits the user, but it
// does NOT sign or broadcast. See docs/WITHDRAWALS.md — signing across 15
// chains is deliberately out of scope for this build. Withdrawals sit in
// `created` until an operator processes them.
// ---------------------------------------------------------------------------
const withdrawalHandler = h(async (req: Request, res: Response) => {
  const cur = requireCurrency(param(req, 'currency') ?? '');
  const address = param(req, 'address');
  const amountRaw = param(req, 'amount');
  if (!address) throw new ApiError(400, 'address is required');
  if (!amountRaw) throw new ApiError(400, 'amount is required');

  let amount: bigint;
  try {
    amount = toBaseUnits(amountRaw, cur.decimals);
  } catch (e) {
    throw new ApiError(400, e instanceof Error ? e.message : 'invalid amount');
  }
  if (amount <= 0n) throw new ApiError(400, 'amount must be positive');

  const label = param(req, 'label') ?? param(req, 'user_id');
  if (label) {
    const user = repo.getUserByExternalId(label);
    if (!user) throw new ApiError(404, `unknown user: ${label}`);
    if (!repo.debitBalance(user.id, cur.ticker, amount)) {
      throw new ApiError(400, `insufficient ${cur.ticker} balance for ${label}`);
    }
  }

  const w = repo.createWithdrawal({
    currency: cur.ticker,
    chain: cur.chain,
    address,
    tag: param(req, 'dest_tag') ?? param(req, 'memo') ?? null,
    amountUnits: amount,
    description: param(req, 'description') ?? null,
    requestId: param(req, 'request_id') ?? null,
  });
  log.info(`withdrawal ${w.uid} queued: ${amountRaw} ${cur.ticker} -> ${address}`);
  res.json(withdrawalToJson(w));
});
// `/wallet/create_withdrawal` is the name the WestWallet SDKs call.
routes.post('/wallet/send', withdrawalHandler);
routes.post('/wallet/create_withdrawal', withdrawalHandler);

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------
routes.get('/wallet/currency_info', h(async (req, res) => {
  const cur = requireCurrency(param(req, 'currency') ?? '');
  const chain = getChain(cur.chain);
  res.json({
    currency: cur.ticker,
    name: cur.name,
    blockchain: cur.chain,
    kind: cur.kind,
    decimals: cur.decimals,
    contract: cur.contract ?? null,
    min_deposit: cur.minDeposit,
    required_confirmations: requiredConfirmations(cur.ticker),
    address_mode: chain.addressMode,
    tag_name: chain.tagName ?? null,
    aliases: cur.aliases,
  });
}));

routes.get('/currencies', h(async (_req, res) => {
  res.json({
    currencies: listCurrencies().map((c) => ({
      currency: c.ticker,
      name: c.name,
      blockchain: c.chain,
      kind: c.kind,
      decimals: c.decimals,
      contract: c.contract ?? null,
      min_deposit: c.minDeposit,
      required_confirmations: requiredConfirmations(c.ticker),
      tag_name: CHAINS[c.chain].tagName ?? null,
      aliases: c.aliases,
    })),
  });
}));

// Watcher health: per-chain cursor, last run and last error.
routes.get('/status', h(async (_req, res) => {
  res.json({
    watcher_enabled: config.watcherEnabled,
    interval_ms: config.watcherIntervalMs,
    watch_only: config.watchOnly,
    chains: repo.chainStates(),
  });
}));
