import { config } from '../config';
import { getChain } from '../chains';
import { currenciesForChain, type CurrencyDef } from '../currencies';
import { fetchJson, rpc, endpointList, tryEndpoints } from '../util/http';
import { parseHexOrDec, toBaseUnits } from '../util/decimal';
import { logger } from '../util/log';
import { utxoSigner } from './signer/utxo';
import { evmSigner } from './signer/evm';

const log = logger('balance');

/**
 * Live on-chain balances.
 *
 * Deliberately keyed by ADDRESS rather than by currency: several currencies
 * share one address, and some chains report all of them in a single response.
 * Asking per currency would multiply the requests against endpoints that are
 * already rate limited.
 */
export type AddressBalances = Map<string, bigint>; // ticker -> base units

/** Balances of every currency that settles on `chain` at `address`. */
export async function addressBalances(chain: string, address: string): Promise<AddressBalances> {
  const out: AddressBalances = new Map();
  const currencies = currenciesForChain(chain);
  if (currencies.length === 0) return out;

  switch (chain) {
    case 'bitcoin': case 'litecoin': case 'dogecoin':
    case 'dash': case 'bitcoincash': case 'zcash': {
      const currency = currencies[0];
      out.set(currency.ticker, await utxoBalance(chain, address));
      return out;
    }

    case 'ethereum': case 'bsc': {
      const signer = evmSigner(chain);
      // One call for the native coin, one per token contract.
      for (const currency of currencies) {
        try {
          out.set(currency.ticker, await signer.balance(currency, address));
        } catch (e) {
          log.warn(`${currency.ticker} balance failed for ${address}`, (e as Error).message);
        }
      }
      return out;
    }

    case 'tron': return tronBalances(address, currencies);
    case 'solana': return singleton(currencies[0], await solanaBalance(address));
    case 'xrp': return singleton(currencies[0], await xrpBalance(address));
    case 'stellar': return singleton(currencies[0], await stellarBalance(address));
    case 'eos': return singleton(currencies[0], await eosBalance(address));
    case 'tezos': return singleton(currencies[0], await tezosBalance(address));
    case 'monero': return singleton(currencies[0], await moneroBalance());

    default:
      throw new Error(`no balance lookup for ${chain}`);
  }
}

function singleton(currency: CurrencyDef, amount: bigint): AddressBalances {
  return new Map([[currency.ticker, amount]]);
}

// ------------------------------------------------------------------ UTXO ----

async function utxoBalance(chain: string, address: string): Promise<bigint> {
  try {
    return await utxoSigner(chain).balance(currenciesForChain(chain)[0], address);
  } catch (e) {
    // Blockbook refused; Blockchair reports the same figure.
    const { supportsChain, fetchAddressOutputs } = await import('../watcher/providers/blockchair');
    if (!supportsChain(chain)) throw e;
    const outputs = await fetchAddressOutputs(chain, address);
    // Only unspent outputs count, and the outputs feed does not say which are
    // spent, so this is the received total rather than the balance. Flagged in
    // the report rather than presented as exact.
    return outputs.reduce((sum, o) => sum + o.value, 0n);
  }
}

// ------------------------------------------------------------------ Tron ----

/**
 * TronGrid returns TRX and every TRC-20 balance in one response, so the whole
 * chain costs a single request per address.
 */
async function tronBalances(address: string, currencies: CurrencyDef[]): Promise<AddressBalances> {
  const out: AddressBalances = new Map();
  const headers: Record<string, string> = config.rpc.tronApiKey
    ? { 'TRON-PRO-API-KEY': config.rpc.tronApiKey } : {};

  const resp = await fetchJson<any>(
    `${config.rpc.tron.replace(/\/$/, '')}/v1/accounts/${address}`,
    { headers, timeoutMs: 25000 },
  );
  const account = resp?.data?.[0];
  if (!account) return out; // an account with no activity does not exist yet

  const native = currencies.find((c) => c.kind === 'native');
  if (native) out.set(native.ticker, BigInt(Math.trunc(Number(account.balance ?? 0))));

  // trc20 is a list of single-entry objects: [{ "<contract>": "<amount>" }]
  const holdings = new Map<string, string>();
  for (const entry of account.trc20 ?? []) {
    for (const [contract, amount] of Object.entries(entry as Record<string, string>)) {
      holdings.set(contract.toLowerCase(), amount);
    }
  }
  for (const currency of currencies) {
    if (currency.kind !== 'token' || !currency.contract) continue;
    const raw = holdings.get(currency.contract.toLowerCase());
    out.set(currency.ticker, raw ? BigInt(raw) : 0n);
  }
  return out;
}

// ------------------------------------------------------------ other chains --

async function solanaBalance(address: string): Promise<bigint> {
  const result = await rpc<{ value?: number }>(config.rpc.solana, 'getBalance', [address]);
  return BigInt(Math.trunc(Number(result?.value ?? 0)));
}

async function xrpBalance(address: string): Promise<bigint> {
  const resp = await fetchJson<any>(config.rpc.xrp, {
    method: 'POST',
    timeoutMs: 20000,
    body: { method: 'account_info', params: [{ account: address, ledger_index: 'validated' }] },
  });
  const result = resp?.result;
  // An account that has never been funded does not exist on the ledger.
  if (result?.error === 'actNotFound') return 0n;
  const drops = result?.account_data?.Balance;
  return drops ? BigInt(drops) : 0n;
}

async function stellarBalance(address: string): Promise<bigint> {
  try {
    const resp = await fetchJson<any>(
      `${config.rpc.stellar.replace(/\/$/, '')}/accounts/${address}`, { timeoutMs: 20000 });
    const native = (resp?.balances ?? []).find((b: any) => b.asset_type === 'native');
    return native ? toBaseUnits(String(native.balance), 7) : 0n;
  } catch (e) {
    if ((e as Error).message.includes('404')) return 0n; // unfunded
    throw e;
  }
}

async function eosBalance(account: string): Promise<bigint> {
  const resp = await fetchJson<string[]>(
    `${config.rpc.eos.replace(/\/$/, '')}/v1/chain/get_currency_balance`,
    { method: 'POST', body: { code: 'eosio.token', account, symbol: 'EOS' }, timeoutMs: 20000 },
  );
  // Comes back as ["12.3456 EOS"], or empty when the account holds none.
  const first = (resp ?? [])[0];
  if (!first) return 0n;
  const [amount] = String(first).trim().split(/\s+/);
  return toBaseUnits(amount, 4);
}

async function tezosBalance(address: string): Promise<bigint> {
  const balance = await fetchJson<number>(
    `${config.rpc.tezos.replace(/\/$/, '')}/v1/accounts/${address}/balance`, { timeoutMs: 20000 });
  return BigInt(Math.trunc(Number(balance ?? 0)));
}

async function moneroBalance(): Promise<bigint> {
  // One wallet holds every subaddress, so this is the whole XMR position.
  const { getIncomingTransfers } = await import('./monero');
  const transfers = await getIncomingTransfers(0);
  return transfers.reduce((sum, t) => sum + t.amount, 0n);
}

/** Chains whose balance this can read at all. */
export function canReadBalance(chain: string): boolean {
  return [
    'bitcoin', 'litecoin', 'dogecoin', 'dash', 'bitcoincash', 'zcash',
    'ethereum', 'bsc', 'tron', 'solana', 'xrp', 'stellar', 'eos', 'tezos', 'monero',
  ].includes(chain);
}

export { getChain, endpointList, tryEndpoints, parseHexOrDec };
