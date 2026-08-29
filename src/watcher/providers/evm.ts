import { config } from '../../config';
import { currenciesForChain } from '../../currencies';
import { rpc, mapLimit, endpointList, tryEndpoints } from '../../util/http';
import { parseHexOrDec } from '../../util/decimal';
import { logger } from '../../util/log';
import type { ChainProvider, RawDeposit, ScanContext, ScanResult } from '../types';

/**
 * Ethereum and BNB Smart Chain.
 *
 * Native coins (ETH, BNB) are found by walking blocks and matching `tx.to`.
 * Tokens (USDT-ERC20, USDT/BUSD/SHIB-BEP20) are found with a single
 * `eth_getLogs` per contract per pass, filtered server-side on the Transfer
 * topic AND the recipient — so token scanning costs one call regardless of how
 * many users you have.
 */

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Max blocks per pass. Public RPCs reject very wide getLogs ranges. */
const MAX_RANGE = 200;
/** Recipients per getLogs call — keeps the topic filter within node limits. */
const TOPIC_CHUNK = 100;

export function evmProvider(chain: string, urlSetting: string): ChainProvider {
  const log = logger(`watch:${chain}`);
  const currencies = currenciesForChain(chain);
  const native = currencies.find((c) => c.kind === 'native');
  const tokens = currencies.filter((c) => c.kind === 'token' && c.contract);
  const endpoints = endpointList(urlSetting);

  /** Same JSON-RPC call against each configured endpoint until one answers. */
  const call = <T>(method: string, params: unknown[] = []): Promise<T> =>
    tryEndpoints(endpoints, (base) => rpc<T>(base, method, params));

  return {
    chain,
    async scan(ctx: ScanContext): Promise<ScanResult> {
      if (ctx.watched.length === 0) return { deposits: [], cursor: ctx.cursor };

      const latest = Number(parseHexOrDec(await call<string>('eth_blockNumber')));
      if (!Number.isFinite(latest) || latest <= 0) throw new Error('eth_blockNumber returned nothing usable');

      // First run: start a short way back rather than replaying the whole chain.
      let from = ctx.cursor ? Number(ctx.cursor) + 1 : Math.max(0, latest - config.reorgDepth);

      // Free RPC providers refuse requests for blocks far behind the head,
      // calling them archive requests. After a long outage the cursor would sit
      // there and every pass would fail, so skip forward and say what was
      // missed instead of stalling silently.
      const oldest = Math.max(0, latest - config.evmMaxLookback);
      if (from < oldest) {
        log.warn(`cursor was ${latest - from} blocks behind, beyond what a public RPC will `
          + `serve. Skipping to block ${oldest} — deposits between ${from} and ${oldest} `
          + 'will not be seen. Use an archive-capable RPC to backfill.');
        from = oldest;
      }

      if (from > latest) return { deposits: [], cursor: String(latest) };
      const to = Math.min(latest, from + MAX_RANGE - 1);

      const byAddress = new Map<string, string>(); // lowercase -> stored form
      for (const a of ctx.watched) byAddress.set(a.address.toLowerCase(), a.address);

      const deposits: RawDeposit[] = [];

      // ---- native coin -----------------------------------------------------
      if (native) {
        const blocks = await mapLimit(range(from, to), 4, async (n) => {
          try {
            return await call<any>('eth_getBlockByNumber', ['0x' + n.toString(16), true]);
          } catch (e) {
            log.warn(`block ${n} fetch failed`, (e as Error).message);
            return null;
          }
        });

        for (const block of blocks) {
          if (!block?.transactions) continue;
          const height = Number(parseHexOrDec(block.number));
          for (const tx of block.transactions) {
            const to_ = (tx.to ?? '').toLowerCase();
            if (!to_ || !byAddress.has(to_)) continue;
            const value = parseHexOrDec(tx.value ?? '0x0');
            if (value <= 0n) continue;

            // A transaction can be included and still have reverted; only a
            // successful receipt actually moved the money.
            let ok = true;
            try {
              const receipt = await call<any>('eth_getTransactionReceipt', [tx.hash]);
              ok = receipt && parseHexOrDec(receipt.status ?? '0x1') === 1n;
            } catch (e) {
              log.warn(`receipt lookup failed for ${tx.hash}`, (e as Error).message);
              ok = false; // do not credit what we could not verify
            }
            if (!ok) continue;

            deposits.push({
              currency: native.ticker,
              address: byAddress.get(to_)!,
              tag: null,
              txid: tx.hash,
              outputIndex: 0,
              amount: value,
              confirmations: Math.max(0, latest - height + 1),
              blockHeight: height,
            });
          }
        }
      }

      // ---- tokens ----------------------------------------------------------
      for (const token of tokens) {
        const recipients = [...byAddress.keys()].map(padTopic);
        for (const chunk of chunked(recipients, TOPIC_CHUNK)) {
          let logs: any[];
          try {
            logs = await call<any[]>('eth_getLogs', [{
              fromBlock: '0x' + from.toString(16),
              toBlock: '0x' + to.toString(16),
              address: token.contract,
              topics: [TRANSFER_TOPIC, null, chunk],
            }]);
          } catch (e) {
            log.warn(`getLogs failed for ${token.ticker}`, (e as Error).message);
            continue;
          }

          for (const l of logs ?? []) {
            if (l.removed) continue;
            const toTopic = l.topics?.[2];
            if (!toTopic) continue;
            const recipient = '0x' + String(toTopic).slice(-40).toLowerCase();
            const stored = byAddress.get(recipient);
            if (!stored) continue;
            const amount = parseHexOrDec(l.data && l.data !== '0x' ? l.data : '0x0');
            if (amount <= 0n) continue;
            const height = Number(parseHexOrDec(l.blockNumber));

            deposits.push({
              currency: token.ticker,
              address: stored,
              tag: null,
              txid: l.transactionHash,
              // Log index keeps two transfers in one transaction distinct.
              outputIndex: Number(parseHexOrDec(l.logIndex ?? '0x0')),
              amount,
              confirmations: Math.max(0, latest - height + 1),
              blockHeight: height,
            });
          }
        }
      }

      return { deposits, cursor: String(to) };
    },
  };
}

function padTopic(address: string): string {
  return '0x' + address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}
function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out.length ? out : [[]];
}

export function buildEvmProviders(): ChainProvider[] {
  return [
    evmProvider('ethereum', config.rpc.ethereum),
    evmProvider('bsc', config.rpc.bsc),
  ];
}
