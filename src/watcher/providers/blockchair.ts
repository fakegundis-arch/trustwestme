import { config } from '../../config';
import { fetchJson } from '../../util/http';
import { logger } from '../../util/log';

const log = logger('blockchair');

/**
 * Blockchair as a second source for the UTXO chains.
 *
 * Trezor's public Blockbook instances refuse some servers outright, and not
 * every chain has a second Trezor host to fall back to. Blockchair covers all
 * six with one API and is independent of Trezor entirely, so a block on one
 * does not take a chain offline.
 *
 * Its free tier is slow — roughly one request every couple of seconds — so it
 * is a fallback rather than the primary. An API key raises that considerably.
 */

/** Blockchair's name for each chain. */
const SLUG: Record<string, string> = {
  bitcoin: 'bitcoin',
  litecoin: 'litecoin',
  dogecoin: 'dogecoin',
  dash: 'dash',
  bitcoincash: 'bitcoin-cash',
  zcash: 'zcash',
};

export function supportsChain(chain: string): boolean {
  return chain in SLUG;
}

/** One output paying an address, in the shape the watcher wants. */
export interface AddressOutput {
  txid: string;
  outputIndex: number;
  value: bigint;
  confirmations: number;
  blockHeight: number | null;
}

interface BcOutput {
  block_id: number;
  transaction_hash: string;
  index: number;
  value: number;
  recipient: string;
}

interface BcResponse {
  data?: BcOutput[];
  context?: { state?: number };
}

/**
 * Outputs paying `address`, most recent first.
 *
 * Blockchair's `outputs` endpoint answers this in one call, which is exactly
 * what deposit detection needs — no walking transactions to find the ones that
 * paid us.
 */
export async function fetchAddressOutputs(chain: string, address: string): Promise<AddressOutput[]> {
  const slug = SLUG[chain];
  if (!slug) throw new Error(`blockchair does not cover ${chain}`);

  // Bitcoin Cash is queried without the "bitcoincash:" prefix.
  const query = chain === 'bitcoincash' ? address.replace(/^bitcoincash:/i, '') : address;

  const params = new URLSearchParams({
    q: `recipient(${query})`,
    limit: '50',
    s: 'block_id(desc)',
  });
  if (config.rpc.blockchairKey) params.set('key', config.rpc.blockchairKey);

  const url = `${config.rpc.blockchair.replace(/\/$/, '')}/${slug}/outputs?${params}`;
  const resp = await fetchJson<BcResponse>(url, { timeoutMs: 30000, retries: 1 });

  const head = Number(resp.context?.state ?? 0);
  const outputs: AddressOutput[] = [];

  for (const row of resp.data ?? []) {
    const value = BigInt(Math.trunc(Number(row.value ?? 0)));
    if (value <= 0n) continue;
    // Blockchair marks an unconfirmed output with a negative block id.
    const height = Number(row.block_id ?? -1);
    const confirmed = height > 0;
    outputs.push({
      txid: String(row.transaction_hash),
      outputIndex: Number(row.index ?? 0),
      value,
      confirmations: confirmed && head ? Math.max(0, head - height + 1) : 0,
      blockHeight: confirmed ? height : null,
    });
  }

  log.debug(`${chain}: ${outputs.length} outputs for ${address}`);
  return outputs;
}
