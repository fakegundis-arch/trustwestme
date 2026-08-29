import { config } from '../../config';
import { currenciesForChain } from '../../currencies';
import { fetchJson, mapLimit, endpointList, tryEndpoints } from '../../util/http';
import { logger } from '../../util/log';
import type { ChainProvider, RawDeposit, ScanContext, ScanResult } from '../types';

/**
 * Blockbook-backed provider for the UTXO chains: BTC, LTC, DOGE, DASH, BCH, ZEC.
 * One identical REST API serves all six, which is why they share an implementation.
 *
 * Scanning is per-address. That is simple and exact, but it costs one request
 * per address per pass — see docs/OPERATIONS.md for the xpub-based approach
 * once you outgrow it.
 */

interface BbVout { value: string; n: number; addresses?: string[]; isAddress?: boolean }
interface BbVin { addresses?: string[]; isAddress?: boolean }
interface BbTx {
  txid: string;
  blockHeight?: number;
  confirmations?: number;
  vin?: BbVin[];
  vout?: BbVout[];
}
interface BbAddressResp { transactions?: BbTx[] }

export function blockbookProvider(chain: string, baseUrlSetting: string): ChainProvider {
  const log = logger(`watch:${chain}`);
  // Each UTXO chain carries exactly one currency.
  const currency = currenciesForChain(chain)[0];
  const endpoints = endpointList(baseUrlSetting);

  return {
    chain,
    async scan(ctx: ScanContext): Promise<ScanResult> {
      if (!currency) return { deposits: [], cursor: ctx.cursor };
      if (ctx.watched.length === 0) return { deposits: [], cursor: ctx.cursor };

      const watchedSet = new Set(ctx.watched.map((a) => normalize(chain, a.address)));
      const deposits: RawDeposit[] = [];

      // Concurrency stays low deliberately: these are shared public instances,
      // and the per-host rate limiter paces the requests anyway.
      const perAddress = await mapLimit(ctx.watched, 2, async (row) => {
        try {
          const resp = await tryEndpoints(endpoints, (base) => fetchJson<BbAddressResp>(
            `${base}/api/v2/address/${encodeURIComponent(row.address)}?details=txs&pageSize=50`,
            { timeoutMs: 25000 },
          ));
          return { row, txs: resp.transactions ?? [] };
        } catch (e) {
          log.warn(`address scan failed for ${row.address}`, describeEndpointFailure(e));
          return { row, txs: [] as BbTx[] };
        }
      });

      for (const { row, txs } of perAddress) {
        const target = normalize(chain, row.address);
        for (const tx of txs) {
          // Skip transactions we sent ourselves — otherwise change returning to
          // a user's own address would be credited as a fresh deposit.
          const selfSpend = (tx.vin ?? []).some((vin) =>
            (vin.addresses ?? []).some((a) => watchedSet.has(normalize(chain, a))));
          if (selfSpend) continue;

          for (const vout of tx.vout ?? []) {
            if (!(vout.addresses ?? []).some((a) => normalize(chain, a) === target)) continue;
            let value: bigint;
            try { value = BigInt(vout.value); } catch { continue; }
            if (value <= 0n) continue;

            deposits.push({
              currency: currency.ticker,
              address: row.address,
              tag: null,
              txid: tx.txid,
              outputIndex: vout.n ?? 0,
              amount: value,
              confirmations: Math.max(0, tx.confirmations ?? 0),
              blockHeight: tx.blockHeight && tx.blockHeight > 0 ? tx.blockHeight : null,
            });
          }
        }
      }

      return { deposits, cursor: ctx.cursor };
    },
  };
}

/**
 * A wall of HTML in the log is useless. Cloudflare and similar return a whole
 * page on a block, so say what it means instead of printing the page.
 */
export function describeEndpointFailure(e: unknown): string {
  const message = (e as Error)?.message ?? String(e);
  if (message.includes('<!DOCTYPE') || message.includes('<html')) {
    const status = message.match(/HTTP (\d{3})/)?.[1] ?? '';
    return `HTTP ${status} — the endpoint returned a block page rather than data. `
      + 'It is rate limiting or refusing this server. Configure another endpoint, '
      + 'or run your own node.';
  }
  return message.slice(0, 300);
}

/** BCH addresses appear with and without the `bitcoincash:` prefix. */
function normalize(chain: string, address: string): string {
  const a = address.trim();
  if (chain === 'bitcoincash') return a.replace(/^bitcoincash:/i, '').toLowerCase();
  return a.toLowerCase();
}

export function buildBlockbookProviders(): ChainProvider[] {
  return [
    blockbookProvider('bitcoin', config.rpc.bitcoin),
    blockbookProvider('litecoin', config.rpc.litecoin),
    blockbookProvider('dogecoin', config.rpc.dogecoin),
    blockbookProvider('dash', config.rpc.dash),
    blockbookProvider('bitcoincash', config.rpc.bitcoincash),
    blockbookProvider('zcash', config.rpc.zcash),
  ];
}
