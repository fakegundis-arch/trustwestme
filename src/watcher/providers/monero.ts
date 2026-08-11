import { currenciesForChain } from '../../currencies';
import { getIncomingTransfers, walletHeight } from '../../wallet/monero';
import { logger } from '../../util/log';
import type { ChainProvider, RawDeposit, ScanContext, ScanResult } from '../types';

/**
 * Monero deposits, read from monero-wallet-rpc.
 *
 * The wallet daemon does the chain scanning, so this provider only has to ask
 * for incoming transfers and match them to the subaddress each user was issued.
 */
export function moneroProvider(): ChainProvider {
  const log = logger('watch:monero');
  const native = currenciesForChain('monero').find((c) => c.kind === 'native')!;

  return {
    chain: 'monero',
    async scan(ctx: ScanContext): Promise<ScanResult> {
      if (ctx.watched.length === 0) return { deposits: [], cursor: ctx.cursor };

      const known = new Set(ctx.watched.map((a) => a.address));
      const from = ctx.cursor ? Number(ctx.cursor) : 0;

      const transfers = await getIncomingTransfers(from);
      const deposits: RawDeposit[] = [];

      for (const t of transfers) {
        if (!known.has(t.address)) continue; // change or an unissued subaddress
        if (t.amount <= 0n) continue;
        deposits.push({
          currency: native.ticker,
          address: t.address,
          tag: null,
          txid: t.txid,
          outputIndex: t.subaddrIndex,
          amount: t.amount,
          confirmations: t.confirmations,
          blockHeight: t.height,
        });
      }

      // Rewind the cursor a little so a transfer seen while still in the pool is
      // revisited once it lands in a block.
      let cursor = ctx.cursor;
      try {
        cursor = String(Math.max(0, (await walletHeight()) - 20));
      } catch (e) {
        log.warn('could not read wallet height', (e as Error).message);
      }

      return { deposits, cursor };
    },
  };
}
