import { config } from '../../config';
import { currenciesForChain } from '../../currencies';
import { fetchJson } from '../../util/http';
import { logger } from '../../util/log';
import type { ChainProvider, RawDeposit, ScanContext, ScanResult } from '../types';

/**
 * Tezos, via the TzKT indexer.
 *
 * One query returns transactions to any of our addresses, filtered and ordered
 * server-side by operation id, so this is a single request per pass.
 */
export function tezosProvider(): ChainProvider {
  const log = logger('watch:tezos');
  const base = config.rpc.tezos.replace(/\/$/, '');
  const native = currenciesForChain('tezos').find((c) => c.kind === 'native')!;

  return {
    chain: 'tezos',
    async scan(ctx: ScanContext): Promise<ScanResult> {
      if (ctx.watched.length === 0) return { deposits: [], cursor: ctx.cursor };

      let head = 0;
      try {
        const h = await fetchJson<any>(`${base}/v1/head`, { timeoutMs: 15000 });
        head = Number(h?.level ?? 0);
      } catch (e) {
        log.warn('could not read chain head', (e as Error).message);
      }

      const byAddress = new Map(ctx.watched.map((a) => [a.address, a.address]));
      const params = new URLSearchParams({
        'target.in': [...byAddress.keys()].join(','),
        'status': 'applied',
        'sort.asc': 'id',
        'limit': '200',
        'select': 'id,hash,level,amount,target,sender',
      });
      if (ctx.cursor) params.set('id.gt', ctx.cursor);

      const rows = await fetchJson<any[]>(`${base}/v1/operations/transactions?${params}`, { timeoutMs: 25000 });
      const deposits: RawDeposit[] = [];
      let cursor = ctx.cursor;

      for (const r of rows ?? []) {
        cursor = String(r.id);
        const target = typeof r.target === 'string' ? r.target : r.target?.address;
        if (!target || !byAddress.has(target)) continue;
        let amount: bigint;
        try { amount = BigInt(r.amount ?? 0); } catch { continue; }
        if (amount <= 0n) continue;
        const level = Number(r.level ?? 0) || null;

        deposits.push({
          currency: native.ticker,
          address: target,
          tag: null,
          txid: r.hash,
          outputIndex: Number(String(r.id).slice(-6)) || 0,
          amount,
          confirmations: head && level ? Math.max(0, head - level + 1) : 0,
          blockHeight: level,
        });
      }

      return { deposits, cursor };
    },
  };
}
