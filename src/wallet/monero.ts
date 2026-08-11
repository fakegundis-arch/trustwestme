import { createHash } from 'node:crypto';
import { config } from '../config';
import { logger } from '../util/log';

const log = logger('monero');

/**
 * Monero support, via `monero-wallet-rpc`.
 *
 * Trust Wallet Core cannot derive Monero addresses — Monero's key scheme and
 * its need to scan every block with a view key put it outside what a stateless
 * derivation library can do. So XMR is the one chain here that needs a daemon:
 *
 *   monero-wallet-rpc --wallet-file gateway --daemon-address <node>:18081 \
 *                     --rpc-bind-port 18083 --disable-rpc-login
 *
 * The model still matches every other chain: one wallet, one subaddress per
 * user, all recoverable from a single seed.
 */

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

let digestAuth: { realm: string; nonce: string; qop: string; opaque?: string; nc: number } | null = null;

async function moneroRpc<T>(method: string, params: unknown = {}): Promise<T> {
  const url = `${config.rpc.monero.replace(/\/$/, '')}/json_rpc`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params });

  const send = async (authHeader?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authHeader) headers.authorization = authHeader;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30000);
    try {
      return await fetch(url, { method: 'POST', headers, body, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await send(digestAuth ? buildDigest(method) : undefined);

  // monero-wallet-rpc uses HTTP digest auth when credentials are configured.
  if (res.status === 401 && config.rpc.moneroUser) {
    const challenge = res.headers.get('www-authenticate') ?? '';
    digestAuth = parseChallenge(challenge);
    if (digestAuth) res = await send(buildDigest(method));
  }

  if (!res.ok) throw new Error(`monero-wallet-rpc HTTP ${res.status}`);
  const json = await res.json() as RpcResponse<T>;
  if (json.error) throw new Error(`monero-wallet-rpc ${method}: ${json.error.message}`);
  return json.result as T;
}

function parseChallenge(header: string) {
  if (!header.toLowerCase().startsWith('digest ')) return null;
  const out: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/(\w+)="?([^",]+)"?/g)) out[m[1]] = m[2];
  if (!out.realm || !out.nonce) return null;
  return { realm: out.realm, nonce: out.nonce, qop: out.qop ?? 'auth', opaque: out.opaque, nc: 0 };
}

function buildDigest(_method: string): string | undefined {
  if (!digestAuth || !config.rpc.moneroUser) return undefined;
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');
  const uri = '/json_rpc';
  const cnonce = Math.random().toString(36).slice(2, 10);
  digestAuth.nc += 1;
  const nc = digestAuth.nc.toString(16).padStart(8, '0');
  const ha1 = md5(`${config.rpc.moneroUser}:${digestAuth.realm}:${config.rpc.moneroPass}`);
  const ha2 = md5(`POST:${uri}`);
  const response = md5(`${ha1}:${digestAuth.nonce}:${nc}:${cnonce}:${digestAuth.qop}:${ha2}`);
  return `Digest username="${config.rpc.moneroUser}", realm="${digestAuth.realm}", nonce="${digestAuth.nonce}", `
    + `uri="${uri}", qop=${digestAuth.qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`
    + (digestAuth.opaque ? `, opaque="${digestAuth.opaque}"` : '');
}

/**
 * Create (or look up) the subaddress for a user index.
 * `label` carries the gateway's user index so the mapping survives a restore
 * from seed — the wallet file itself remembers which index belongs to whom.
 */
export async function createSubaddress(index: number): Promise<{ address: string; addressIndex: number }> {
  const label = `user:${index}`;

  // Reuse an existing subaddress carrying this label rather than minting a new
  // one, so repeated calls for the same user are stable.
  try {
    const existing = await moneroRpc<{ addresses: { address: string; address_index: number; label: string }[] }>(
      'get_address', { account_index: 0 },
    );
    const found = existing.addresses?.find((a) => a.label === label);
    if (found) return { address: found.address, addressIndex: found.address_index };
  } catch (e) {
    log.warn('get_address failed, will try to create', (e as Error).message);
  }

  const created = await moneroRpc<{ address: string; address_index: number }>(
    'create_address', { account_index: 0, label },
  );
  log.info(`created subaddress ${created.address_index} for user index ${index}`);
  return { address: created.address, addressIndex: created.address_index };
}

export interface MoneroTransfer {
  txid: string;
  amount: bigint;
  confirmations: number;
  height: number | null;
  address: string;
  subaddrIndex: number;
}

/** Incoming transfers at or above `minHeight`. */
export async function getIncomingTransfers(minHeight: number): Promise<MoneroTransfer[]> {
  const res = await moneroRpc<{ in?: any[] }>('get_transfers', {
    in: true,
    pending: true,
    pool: true,
    account_index: 0,
    filter_by_height: minHeight > 0,
    min_height: Math.max(0, minHeight),
  });
  return (res.in ?? []).map((t) => ({
    txid: String(t.txid),
    amount: BigInt(t.amount ?? 0),
    confirmations: Number(t.confirmations ?? 0),
    height: Number(t.height ?? 0) || null,
    address: String(t.address ?? ''),
    subaddrIndex: Number(t.subaddr_index?.minor ?? 0),
  }));
}

export async function walletHeight(): Promise<number> {
  const r = await moneroRpc<{ height: number }>('get_height');
  return Number(r.height ?? 0);
}
