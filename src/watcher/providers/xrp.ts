import { config } from '../../config';
import { currenciesForChain } from '../../currencies';
import { fetchJson } from '../../util/http';
import { sharedAddressFor } from '../../wallet/derive';
import { logger } from '../../util/log';
import type { ChainProvider, RawDeposit, ScanContext, ScanResult } from '../types';

/**
 * XRP: one gateway account, users separated by destination tag.
 *
 * A single `account_tx` call returns every payment to the account, so this
 * scales to any number of users at constant cost. Payments arriving with no
 * destination tag cannot be attributed and are skipped — the matcher logs them
 * so you can credit them by hand.
 */
export function xrpProvider(): ChainProvider {
  const log = logger('watch:xrp');
  const native = currenciesForChain('xrp').find((c) => c.kind === 'native')!;

  return {
    chain: 'xrp',
    async scan(ctx: ScanContext): Promise<ScanResult> {
      const account = sharedAddressFor('xrp');
      const minLedger = ctx.cursor ? Number(ctx.cursor) + 1 : -1;

      const resp = await fetchJson<any>(config.rpc.xrp, {
        method: 'POST',
        timeoutMs: 25000,
        body: {
          method: 'account_tx',
          params: [{
            account,
            ledger_index_min: minLedger,
            ledger_index_max: -1,
            binary: false,
            forward: true,
            limit: 200,
          }],
        },
      });

      const result = resp?.result;
      if (!result || result.status === 'error') {
        throw new Error(`account_tx failed: ${result?.error_message ?? result?.error ?? 'unknown'}`);
      }

      const deposits: RawDeposit[] = [];
      let maxLedger = ctx.cursor ? Number(ctx.cursor) : 0;

      for (const entry of result.transactions ?? []) {
        const tx = entry.tx ?? entry.tx_json ?? entry;
        const meta = entry.meta ?? entry.metaData;
        const ledger = Number(tx?.ledger_index ?? entry.ledger_index ?? 0);
        if (ledger > maxLedger) maxLedger = ledger;

        if (tx?.TransactionType !== 'Payment') continue;
        if (tx?.Destination !== account) continue;
        if (meta?.TransactionResult !== 'tesSUCCESS') continue;

        // delivered_amount is authoritative — it accounts for partial payments.
        const delivered = meta?.delivered_amount ?? meta?.DeliveredAmount ?? tx?.Amount;
        // A string amount is drops of XRP; an object is an issued token, which
        // this gateway does not accept.
        if (typeof delivered !== 'string') continue;

        let amount: bigint;
        try { amount = BigInt(delivered); } catch { continue; }
        if (amount <= 0n) continue;

        const tag = tx?.DestinationTag;
        if (tag === undefined || tag === null) {
          log.warn(`XRP payment ${tx.hash} arrived with no destination tag — cannot attribute`);
          continue;
        }

        deposits.push({
          currency: native.ticker,
          address: account,
          tag: String(tag),
          txid: tx.hash,
          outputIndex: 0,
          amount,
          confirmations: 1, // a validated ledger is final
          blockHeight: ledger || null,
        });
      }

      return { deposits, cursor: maxLedger ? String(maxLedger) : ctx.cursor };
    },
  };
}
