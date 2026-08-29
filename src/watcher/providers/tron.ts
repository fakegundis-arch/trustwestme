import { config } from '../../config';
import { currenciesForChain } from '../../currencies';
import { fetchJson, mapLimit } from '../../util/http';
import { logger } from '../../util/log';
import type { ChainProvider, RawDeposit, ScanContext, ScanResult } from '../types';

/**
 * Tron: native TRX plus the TRC-20 tokens (USDT-TRC20, USDC-TRC20).
 * Backed by TronGrid's REST API. A free API key raises the rate limit
 * considerably — set TRON_API_KEY once you have real traffic.
 */
export function tronProvider(): ChainProvider {
  const log = logger('watch:tron');
  const base = config.rpc.tron.replace(/\/$/, '');
  const currencies = currenciesForChain('tron');
  const native = currencies.find((c) => c.kind === 'native')!;
  const tokensByContract = new Map(
    currencies.filter((c) => c.kind === 'token' && c.contract).map((c) => [c.contract!.toLowerCase(), c]),
  );

  const headers: Record<string, string> = config.rpc.tronApiKey
    ? { 'TRON-PRO-API-KEY': config.rpc.tronApiKey }
    : {};

  return {
    chain: 'tron',
    async scan(ctx: ScanContext): Promise<ScanResult> {
      if (ctx.watched.length === 0) return { deposits: [], cursor: ctx.cursor };

      let head = 0;
      try {
        const blk = await fetchJson<any>(`${base}/wallet/getnowblock`, { method: 'POST', body: {}, headers });
        head = Number(blk?.block_header?.raw_data?.number ?? 0);
      } catch (e) {
        log.warn('could not read chain head', (e as Error).message);
      }

      const deposits: RawDeposit[] = [];

      // TronGrid allows three requests a second without an API key, and this
      // provider makes two or three calls per address. The per-host rate
      // limiter paces them; keeping concurrency at one avoids piling up a long
      // queue of waiting requests behind it.
      await mapLimit(ctx.watched, 1, async (row) => {
        // ---- native TRX ---------------------------------------------------
        try {
          const resp = await fetchJson<any>(
            `${base}/v1/accounts/${row.address}/transactions?only_to=true&limit=50`,
            { headers, timeoutMs: 25000 },
          );
          for (const tx of resp?.data ?? []) {
            const contract = tx?.raw_data?.contract?.[0];
            if (contract?.type !== 'TransferContract') continue;
            if (tx?.ret?.[0]?.contractRet !== 'SUCCESS') continue;
            const amount = BigInt(contract?.parameter?.value?.amount ?? 0);
            if (amount <= 0n) continue;
            const height = Number(tx.blockNumber ?? 0) || null;
            deposits.push({
              currency: native.ticker,
              address: row.address,
              tag: null,
              txid: tx.txID,
              outputIndex: 0,
              amount,
              confirmations: head && height ? Math.max(0, head - height + 1) : 0,
              blockHeight: height,
            });
          }
        } catch (e) {
          log.warn(`TRX scan failed for ${row.address}`, (e as Error).message);
        }

        // ---- TRC-20 tokens --------------------------------------------------
        try {
          const resp = await fetchJson<any>(
            `${base}/v1/accounts/${row.address}/transactions/trc20?only_to=true&limit=50`,
            { headers, timeoutMs: 25000 },
          );
          for (const ev of resp?.data ?? []) {
            const contractAddr = String(ev?.token_info?.address ?? '').toLowerCase();
            const currency = tokensByContract.get(contractAddr);
            if (!currency) continue; // a token we do not list
            if (String(ev.to) !== row.address) continue;
            let amount: bigint;
            try { amount = BigInt(ev.value); } catch { continue; }
            if (amount <= 0n) continue;

            // The TRC-20 event feed carries no block height or success flag, so
            // resolve both from the transaction itself. Without this a token
            // deposit could be credited before it is confirmed — or after it
            // reverted.
            const info = await txInfo(base, headers, ev.transaction_id, log);
            if (!info || !info.success) continue;

            deposits.push({
              currency: currency.ticker,
              address: row.address,
              tag: null,
              txid: ev.transaction_id,
              // TronGrid does not expose a log index; the contract keeps two
              // different tokens in the same tx from colliding.
              outputIndex: stableIndex(contractAddr),
              amount,
              confirmations: head && info.height ? Math.max(0, head - info.height + 1) : 0,
              blockHeight: info.height,
            });
          }
        } catch (e) {
          log.warn(`TRC20 scan failed for ${row.address}`, (e as Error).message);
        }
      });

      return { deposits, cursor: ctx.cursor };
    },
  };
}

/** Resolve a Tron transaction's block height and success flag. */
async function txInfo(
  base: string,
  headers: Record<string, string>,
  txid: string,
  log: ReturnType<typeof logger>,
): Promise<{ height: number | null; success: boolean } | null> {
  try {
    const info = await fetchJson<any>(`${base}/wallet/gettransactioninfobyid`, {
      method: 'POST', body: { value: txid }, headers, timeoutMs: 20000,
    });
    if (!info || Object.keys(info).length === 0) return null; // not yet in a block
    const result = info?.receipt?.result;
    // Plain TRC-20 transfers report SUCCESS; absence of a result field on a
    // mined transaction also means no revert.
    const success = result === undefined || result === 'SUCCESS';
    return { height: Number(info.blockNumber ?? 0) || null, success };
  } catch (e) {
    log.warn(`transaction info failed for ${txid}`, (e as Error).message);
    return null;
  }
}

/** Small deterministic integer from a contract address, used as an output index. */
function stableIndex(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
  return h;
}
