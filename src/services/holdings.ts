import { CHAINS } from '../chains';
import { CURRENCIES, listCurrencies } from '../currencies';
import { fromBaseUnits } from '../util/decimal';
import { mapLimit } from '../util/http';
import { addressBalances, canReadBalance } from '../wallet/balance';
import { sharedAddressFor } from '../wallet/derive';
import * as repo from '../db/repo';
import { logger } from '../util/log';

const log = logger('holdings');

/**
 * What the gateway actually holds on chain, right now.
 *
 * This is a different question from `/balances`, which reports the credited
 * ledger — what users have been given. This walks the chains and asks what is
 * really there. The two should agree; when they do not, something is wrong and
 * it is worth knowing which way.
 */

export interface CurrencyHolding {
  ticker: string;
  name: string;
  chain: string;
  /** Live on-chain total, in base units. */
  onChain: bigint;
  /** What the ledger says users are owed, in base units. */
  credited: bigint;
  decimals: number;
  /** Addresses holding a non-zero amount of this currency. */
  addresses: { address: string; amount: bigint; user: string | null }[];
}

export interface HoldingsReport {
  holdings: CurrencyHolding[];
  /** Chains that could not be read, with the reason. */
  failures: { chain: string; reason: string }[];
  addressesScanned: number;
  requestsMade: number;
  startedAt: Date;
  finishedAt: Date;
  truncated: boolean;
}

export interface ScanOptions {
  /** Cap on addresses per chain, so one busy chain cannot stall the scan. */
  maxAddressesPerChain?: number;
  /** Restrict to one chain. */
  chain?: string;
  onProgress?: (done: number, total: number, chain: string) => void;
}

export async function scanHoldings(options: ScanOptions = {}): Promise<HoldingsReport> {
  const startedAt = new Date();
  const maxPerChain = options.maxAddressesPerChain ?? 100;

  const totals = new Map<string, bigint>();
  const perAddress = new Map<string, { address: string; amount: bigint; user: string | null }[]>();
  const failures: { chain: string; reason: string }[] = [];
  let addressesScanned = 0;
  let requestsMade = 0;
  let truncated = false;

  const chains = Object.keys(CHAINS).filter((c) => !options.chain || c === options.chain);

  // Work out what to query before querying anything, so progress is meaningful.
  const work: { chain: string; address: string; user: string | null }[] = [];
  for (const chain of chains) {
    if (!canReadBalance(chain)) {
      failures.push({ chain, reason: 'no balance lookup for this chain' });
      continue;
    }
    const def = CHAINS[chain];

    if (def.addressMode === 'shared') {
      // Every user shares one account, so it is counted once — querying it per
      // user would multiply the balance by the number of users.
      try {
        work.push({ chain, address: sharedAddressFor(chain), user: null });
      } catch {
        failures.push({ chain, reason: 'no gateway account configured' });
      }
      continue;
    }

    if (def.addressMode === 'monero') {
      // The wallet daemon reports one balance for every subaddress together.
      if (repo.addressesForChain(chain).length > 0) {
        work.push({ chain, address: 'wallet', user: null });
      }
      continue;
    }

    const rows = repo.addressesForChain(chain);
    if (rows.length > maxPerChain) truncated = true;
    for (const row of rows.slice(0, maxPerChain)) {
      const user = repo.getUserById(row.user_id);
      work.push({ chain, address: row.address, user: user?.external_id ?? null });
    }
  }

  let done = 0;
  // Two at a time: the per-host rate limiter does the real pacing, and a deep
  // queue behind a slow endpoint helps nobody.
  await mapLimit(work, 2, async (item) => {
    try {
      const balances = await addressBalances(item.chain, item.address);
      requestsMade++;
      addressesScanned++;

      for (const [ticker, amount] of balances) {
        totals.set(ticker, (totals.get(ticker) ?? 0n) + amount);
        if (amount > 0n) {
          if (!perAddress.has(ticker)) perAddress.set(ticker, []);
          perAddress.get(ticker)!.push({ address: item.address, amount, user: item.user });
        }
      }
    } catch (e) {
      const reason = (e as Error).message;
      log.warn(`${item.chain} balance failed for ${item.address}`, reason);
      if (!failures.some((f) => f.chain === item.chain)) {
        failures.push({ chain: item.chain, reason: reason.slice(0, 160) });
      }
    } finally {
      done++;
      options.onProgress?.(done, work.length, item.chain);
    }
  });

  const holdings: CurrencyHolding[] = listCurrencies().map((currency) => ({
    ticker: currency.ticker,
    name: currency.name,
    chain: currency.chain,
    onChain: totals.get(currency.ticker) ?? 0n,
    credited: repo.getTotalBalance(currency.ticker),
    decimals: currency.decimals,
    addresses: (perAddress.get(currency.ticker) ?? [])
      .sort((a, b) => (b.amount > a.amount ? 1 : -1)),
  }));

  return {
    holdings,
    failures,
    addressesScanned,
    requestsMade,
    startedAt,
    finishedAt: new Date(),
    truncated,
  };
}

/** Currencies actually holding something, largest first. */
export function nonZero(report: HoldingsReport): CurrencyHolding[] {
  return report.holdings
    .filter((h) => h.onChain > 0n)
    .sort((a, b) => {
      // No exchange rates here, so order by chain then ticker rather than
      // pretending amounts across currencies are comparable.
      if (a.chain !== b.chain) return a.chain.localeCompare(b.chain);
      return a.ticker.localeCompare(b.ticker);
    });
}

/** Currencies where the chain and the ledger disagree. */
export function discrepancies(report: HoldingsReport): CurrencyHolding[] {
  return report.holdings.filter((h) => h.onChain !== h.credited
    && (h.onChain > 0n || h.credited > 0n));
}

export function formatAmount(holding: CurrencyHolding, amount: bigint): string {
  return fromBaseUnits(amount, holding.decimals ?? CURRENCIES[holding.ticker]?.decimals ?? 8);
}
