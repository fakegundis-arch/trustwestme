import { config } from '../../config';
import { currenciesForChain } from '../../currencies';
import { fetchJson } from '../../util/http';
import { toBaseUnits } from '../../util/decimal';
import { sharedAddressFor } from '../../wallet/derive';
import { logger } from '../../util/log';
import type { ChainProvider, RawDeposit, ScanContext, ScanResult } from '../types';

/**
 * Stellar: one gateway account, users separated by memo.
 *
 * Horizon's payments feed is a cursor-paged stream, so the cursor is stored and
 * resumed. `join=transactions` pulls the memo in with the payment instead of
 * costing a second request per record.
 */
export function stellarProvider(): ChainProvider {
  const log = logger('watch:stellar');
  const native = currenciesForChain('stellar').find((c) => c.kind === 'native')!;
  const base = config.rpc.stellar.replace(/\/$/, '');

  return {
    chain: 'stellar',
    async scan(ctx: ScanContext): Promise<ScanResult> {
      const account = sharedAddressFor('stellar');
      const params = new URLSearchParams({
        limit: '100',
        order: 'asc',
        join: 'transactions',
      });
      if (ctx.cursor) params.set('cursor', ctx.cursor);

      const url = `${base}/accounts/${account}/payments?${params}`;
      let resp: any;
      try {
        resp = await fetchJson<any>(url, { timeoutMs: 25000 });
      } catch (e) {
        // A brand new account has no payment history yet.
        if ((e as Error).message.includes('404')) return { deposits: [], cursor: ctx.cursor };
        throw e;
      }

      const records: any[] = resp?._embedded?.records ?? [];
      const deposits: RawDeposit[] = [];
      let cursor = ctx.cursor;

      for (const r of records) {
        cursor = r.paging_token ?? cursor;

        if (r.type !== 'payment' && r.type !== 'create_account') continue;
        if (r.transaction_successful === false) continue;
        // Only native XLM; issued assets are not accepted.
        if (r.type === 'payment' && r.asset_type !== 'native') continue;
        const to = r.to ?? r.account;
        if (to !== account) continue;

        const amountStr = r.amount ?? r.starting_balance;
        if (!amountStr) continue;
        let amount: bigint;
        try { amount = toBaseUnits(String(amountStr), native.decimals); } catch { continue; }
        if (amount <= 0n) continue;

        const memo = r.transaction?.memo;
        const memoType = r.transaction?.memo_type;
        if (!memo || memoType === 'none') {
          log.warn(`XLM payment ${r.transaction_hash} arrived with no memo — cannot attribute`);
          continue;
        }

        deposits.push({
          currency: native.ticker,
          address: account,
          tag: String(memo),
          txid: r.transaction_hash,
          // Several payments can share one transaction hash; the operation id
          // is what keeps them distinct.
          outputIndex: Number(String(r.id).slice(-6)) || 0,
          amount,
          confirmations: 1, // a closed Stellar ledger is final
          blockHeight: null,
        });
      }

      return { deposits, cursor };
    },
  };
}
