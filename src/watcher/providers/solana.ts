import { config } from '../../config';
import { currenciesForChain } from '../../currencies';
import { rpc, mapLimit } from '../../util/http';
import { logger } from '../../util/log';
import type { ChainProvider, RawDeposit, ScanContext, ScanResult } from '../types';

/**
 * Solana native SOL deposits.
 *
 * Credit is computed from the balance delta in the transaction metadata rather
 * than by parsing instructions, so transfers that arrive through a program
 * (not just SystemProgram) are still detected.
 */
export function solanaProvider(): ChainProvider {
  const log = logger('watch:solana');
  const url = config.rpc.solana;
  const native = currenciesForChain('solana').find((c) => c.kind === 'native')!;

  return {
    chain: 'solana',
    async scan(ctx: ScanContext): Promise<ScanResult> {
      if (ctx.watched.length === 0) return { deposits: [], cursor: ctx.cursor };
      const deposits: RawDeposit[] = [];

      await mapLimit(ctx.watched, 3, async (row) => {
        let sigs: any[];
        try {
          sigs = await rpc<any[]>(url, 'getSignaturesForAddress', [row.address, { limit: 25 }]) ?? [];
        } catch (e) {
          log.warn(`signature lookup failed for ${row.address}`, (e as Error).message);
          return;
        }

        for (const sig of sigs) {
          if (sig.err) continue; // failed transaction moved nothing

          let tx: any;
          try {
            tx = await rpc<any>(url, 'getTransaction', [
              sig.signature,
              { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
            ]);
          } catch (e) {
            log.warn(`getTransaction failed for ${sig.signature}`, (e as Error).message);
            continue;
          }
          if (!tx?.meta || tx.meta.err) continue;

          const keys: any[] = tx.transaction?.message?.accountKeys ?? [];
          const idx = keys.findIndex((k) => (typeof k === 'string' ? k : k?.pubkey) === row.address);
          if (idx < 0) continue;

          const pre = BigInt(tx.meta.preBalances?.[idx] ?? 0);
          const post = BigInt(tx.meta.postBalances?.[idx] ?? 0);
          const delta = post - pre;
          if (delta <= 0n) continue; // outgoing or fee-only

          deposits.push({
            currency: native.ticker,
            address: row.address,
            tag: null,
            txid: sig.signature,
            outputIndex: 0,
            amount: delta,
            // Solana has no confirmation count; finalized is final.
            confirmations: sig.confirmationStatus === 'finalized' ? 1 : 0,
            blockHeight: Number(sig.slot ?? 0) || null,
          });
        }
      });

      return { deposits, cursor: ctx.cursor };
    },
  };
}
