import { config } from '../config';
import { CHAINS, getChain } from '../chains';
import { CURRENCIES } from '../currencies';
import { toBaseUnits, fromBaseUnits } from '../util/decimal';
import { logger } from '../util/log';
import * as repo from '../db/repo';
import { requiredConfirmations } from '../api/serialize';
import { queueDepositIpn } from '../ipn';
import { events } from '../events';
import type { ChainProvider, RawDeposit } from './types';

import { buildBlockbookProviders } from './providers/blockbook';
import { buildEvmProviders } from './providers/evm';
import { tronProvider } from './providers/tron';
import { solanaProvider } from './providers/solana';
import { xrpProvider } from './providers/xrp';
import { stellarProvider } from './providers/stellar';
import { eosProvider } from './providers/eos';
import { tezosProvider } from './providers/tezos';
import { moneroProvider } from './providers/monero';

const log = logger('watcher');

export function buildProviders(): ChainProvider[] {
  const all: ChainProvider[] = [
    ...buildBlockbookProviders(),
    ...buildEvmProviders(),
    tronProvider(),
    solanaProvider(),
    xrpProvider(),
    stellarProvider(),
    eosProvider(),
    tezosProvider(),
    moneroProvider(),
  ];
  if (config.watcherChains.length === 0) return all;
  return all.filter((p) => config.watcherChains.includes(p.chain));
}

/**
 * Run one scan pass for a chain: fetch what is on-chain, attribute each credit
 * to a user, store it, and credit the balance once it is confirmed enough.
 */
export async function scanChain(provider: ChainProvider): Promise<{ seen: number; credited: number }> {
  const chain = getChain(provider.chain);
  const watched = repo.addressesForChain(provider.chain);

  // Shared-address chains have one gateway account and must be scanned even
  // before a user exists; per-user chains have nothing to look at until then.
  if (watched.length === 0 && chain.addressMode !== 'shared') {
    return { seen: 0, credited: 0 };
  }

  const cursor = repo.getCursor(provider.chain);
  const result = await provider.scan({ watched, cursor });

  let credited = 0;
  for (const raw of result.deposits) {
    try {
      if (await handleDeposit(provider.chain, raw)) credited++;
    } catch (e) {
      log.error(`failed to record ${provider.chain} deposit ${raw.txid}`, (e as Error).message);
    }
  }

  repo.setCursor(provider.chain, result.cursor, null);
  return { seen: result.deposits.length, credited };
}

/** Attribute, persist, and (when confirmed) credit a single observed deposit. */
async function handleDeposit(chainId: string, raw: RawDeposit): Promise<boolean> {
  const chain = getChain(chainId);
  const currency = CURRENCIES[raw.currency];
  if (!currency) {
    log.warn(`${chainId}: ignoring unknown currency ${raw.currency}`);
    return false;
  }

  // Attribute to a user: by address on per-user chains, by tag/memo on shared ones.
  const addressRow = chain.addressMode === 'shared'
    ? (raw.tag ? repo.findAddressByTag(chainId, raw.tag) : undefined)
    : repo.findAddress(chainId, raw.address);

  if (!addressRow) {
    log.warn(`${chainId}: deposit ${raw.txid} could not be attributed`
      + (chain.addressMode === 'shared' ? ` (tag ${raw.tag})` : ` (address ${raw.address})`));
    return false;
  }

  // Ignore dust below the currency's minimum.
  const min = toBaseUnits(currency.minDeposit, currency.decimals);
  if (raw.amount < min) {
    log.debug(`${chainId}: ignoring dust ${fromBaseUnits(raw.amount, currency.decimals)} ${currency.ticker}`);
    return false;
  }

  const needed = requiredConfirmations(currency.ticker);
  const status: 'pending' | 'completed' = raw.confirmations >= needed ? 'completed' : 'pending';

  const { row, isNew, becameCompleted } = repo.recordDeposit({
    userId: addressRow.user_id,
    addressId: addressRow.id,
    chain: chainId,
    currency: currency.ticker,
    address: raw.address,
    tag: raw.tag,
    txid: raw.txid,
    outputIndex: raw.outputIndex,
    amountUnits: raw.amount,
    confirmations: raw.confirmations,
    blockHeight: raw.blockHeight,
    status,
  });

  const user = repo.getUserById(addressRow.user_id);
  const amountStr = fromBaseUnits(raw.amount, currency.decimals);

  if (isNew) {
    log.info(`${chainId}: new ${status} deposit ${amountStr} ${currency.ticker} `
      + `for ${user?.external_id} (${raw.txid})`);
    queueDepositIpn(row, addressRow.ipn_url);
    // Only announce as "detected" while it is still confirming; a deposit that
    // arrives already confirmed gets the credited alert below instead.
    if (status === 'pending') events.emitEvent('deposit.pending', row);
  }

  if (becameCompleted) {
    // creditDeposit is the single place a balance grows, and it is idempotent.
    const didCredit = repo.creditDeposit(row.id);
    if (didCredit) {
      log.info(`${chainId}: credited ${amountStr} ${currency.ticker} to ${user?.external_id}`);
      const completed = { ...row, status: 'completed', credited: 1 };
      queueDepositIpn(completed, addressRow.ipn_url);
      events.emitEvent('deposit.completed', completed);
      return true;
    }
  }

  return false;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function runOnce(): Promise<void> {
  if (running) {
    log.debug('previous pass still running, skipping this tick');
    return;
  }
  running = true;
  const providers = buildProviders();
  try {
    for (const p of providers) {
      try {
        const { seen, credited } = await scanChain(p);
        if (seen > 0) log.debug(`${p.chain}: ${seen} observed, ${credited} credited`);
      } catch (e) {
        const message = (e as Error).message;
        log.error(`${p.chain} scan failed`, message);
        repo.setCursor(p.chain, repo.getCursor(p.chain), message);
      }
    }
  } finally {
    running = false;
  }
}

export function startWatcher() {
  if (!config.watcherEnabled) {
    log.info('watcher disabled (WATCHER_ENABLED=false)');
    return;
  }
  const chains = buildProviders().map((p) => p.chain);
  log.info(`watching ${chains.length} chains every ${config.watcherIntervalMs}ms: ${chains.join(', ')}`);
  void runOnce();
  timer = setInterval(() => void runOnce(), config.watcherIntervalMs);
  return timer;
}

export function stopWatcher() {
  if (timer) { clearInterval(timer); timer = null; }
}

export { CHAINS };
