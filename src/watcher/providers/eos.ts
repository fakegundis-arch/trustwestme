import { config } from '../../config';
import { currenciesForChain } from '../../currencies';
import { fetchJson } from '../../util/http';
import { toBaseUnits } from '../../util/decimal';
import { sharedAddressFor } from '../../wallet/derive';
import { logger } from '../../util/log';
import type { ChainProvider, RawDeposit, ScanContext, ScanResult } from '../types';

/**
 * EOS: one named gateway account, users separated by transfer memo.
 *
 * EOS accounts are named resources that must be created and paid for, so a
 * per-user account is not viable — memos are the standard exchange model.
 * Only `eosio.token` transfers of the native EOS symbol are credited, which
 * blocks the classic fake-token deposit trick.
 */
export function eosProvider(): ChainProvider {
  const log = logger('watch:eos');
  const base = config.rpc.eos.replace(/\/$/, '');
  const native = currenciesForChain('eos').find((c) => c.kind === 'native')!;

  return {
    chain: 'eos',
    async scan(ctx: ScanContext): Promise<ScanResult> {
      const account = sharedAddressFor('eos');
      const pos = ctx.cursor ? Number(ctx.cursor) + 1 : -1;

      let resp: any;
      try {
        resp = await fetchJson<any>(`${base}/v1/history/get_actions`, {
          method: 'POST',
          timeoutMs: 25000,
          // A negative pos with a negative offset asks for the most recent
          // actions; from a stored cursor we page forward instead.
          body: pos < 0
            ? { account_name: account, pos: -1, offset: -100 }
            : { account_name: account, pos, offset: 100 },
        });
      } catch (e) {
        log.warn('get_actions failed', (e as Error).message);
        return { deposits: [], cursor: ctx.cursor };
      }

      const actions: any[] = resp?.actions ?? [];
      const deposits: RawDeposit[] = [];
      let cursor = ctx.cursor ? Number(ctx.cursor) : 0;

      for (const a of actions) {
        const seq = Number(a.account_action_seq ?? a.global_action_seq ?? 0);
        if (seq > cursor) cursor = seq;

        const act = a.action_trace?.act;
        if (!act || act.name !== 'transfer') continue;
        // Only the real system token contract issues real EOS.
        if (act.account !== 'eosio.token') continue;

        const data = act.data ?? {};
        if (data.to !== account) continue;

        // quantity looks like "12.3456 EOS"
        const [amountStr, symbol] = String(data.quantity ?? '').trim().split(/\s+/);
        if (symbol !== 'EOS' || !amountStr) continue;
        let amount: bigint;
        try { amount = toBaseUnits(amountStr, native.decimals); } catch { continue; }
        if (amount <= 0n) continue;

        const memo = String(data.memo ?? '').trim();
        if (!memo) {
          log.warn(`EOS transfer ${a.action_trace?.trx_id} arrived with no memo — cannot attribute`);
          continue;
        }

        deposits.push({
          currency: native.ticker,
          address: account,
          tag: memo,
          txid: a.action_trace?.trx_id ?? String(seq),
          outputIndex: seq % 1000000,
          amount,
          confirmations: 1,
          blockHeight: Number(a.block_num ?? 0) || null,
        });
      }

      return { deposits, cursor: cursor ? String(cursor) : ctx.cursor };
    },
  };
}
