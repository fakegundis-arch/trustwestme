/**
 * Currency registry — the 21 assets this gateway supports.
 *
 * A "currency" is what your exchange trades and what the API talks about.
 * A "chain" is where the money physically lands. Several currencies share one
 * chain (and therefore one deposit address per user): USDT.ERC20 and ETH both
 * arrive at the user's Ethereum address; USDT.BEP20, BUSD.BEP20, SHIB.BEP20
 * and BNB all arrive at their BSC address; USDT.TRC20, USDC.TRC20 and TRX all
 * arrive at their Tron address.
 *
 * TICKER FORMAT: base symbol, optionally suffixed with the network, matching
 * the convention WestWallet uses (BTC, ETH, USDTTRC, USDTERC20, ...). Aliases
 * let your existing integration keep sending whatever spelling it already uses.
 *
 * !! VERIFY CONTRACT ADDRESSES against a block explorer before going live.
 *    A wrong contract address means crediting worthless tokens as real ones.
 */

export type CurrencyKind = 'native' | 'token';

export interface CurrencyDef {
  /** Canonical ticker used in API requests and responses. */
  ticker: string;
  name: string;
  chain: string;
  kind: CurrencyKind;
  decimals: number;
  /** Token contract address (EVM) or issuer contract (Tron). */
  contract?: string;
  /** Alternative spellings accepted on input. */
  aliases: string[];
  /** Minimum credited deposit, in whole units. Dust below this is ignored. */
  minDeposit: string;
  /** Overrides the chain default when set. */
  confirmations?: number;
}

const D: CurrencyDef[] = [
  // ---- UTXO chains -------------------------------------------------------
  {
    ticker: 'BTC', name: 'Bitcoin', chain: 'bitcoin', kind: 'native', decimals: 8,
    aliases: ['BITCOIN', 'XBT'], minDeposit: '0.00005',
  },
  {
    ticker: 'LTC', name: 'Litecoin', chain: 'litecoin', kind: 'native', decimals: 8,
    aliases: ['LITECOIN'], minDeposit: '0.001',
  },
  {
    ticker: 'DOGE', name: 'Dogecoin', chain: 'dogecoin', kind: 'native', decimals: 8,
    aliases: ['DOGECOIN'], minDeposit: '5',
  },
  {
    ticker: 'DASH', name: 'Dash', chain: 'dash', kind: 'native', decimals: 8,
    aliases: [], minDeposit: '0.005',
  },
  {
    ticker: 'BCH', name: 'Bitcoin Cash', chain: 'bitcoincash', kind: 'native', decimals: 8,
    aliases: ['BITCOINCASH', 'BCHN'], minDeposit: '0.001',
  },
  {
    ticker: 'ZEC', name: 'Zcash', chain: 'zcash', kind: 'native', decimals: 8,
    aliases: ['ZCASH'], minDeposit: '0.001',
  },

  // ---- Ethereum ----------------------------------------------------------
  {
    ticker: 'ETH', name: 'Ethereum', chain: 'ethereum', kind: 'native', decimals: 18,
    aliases: ['ETHEREUM'], minDeposit: '0.001',
  },
  {
    ticker: 'USDTERC20', name: 'Tether USD (ERC-20)', chain: 'ethereum', kind: 'token', decimals: 6,
    contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    aliases: ['USDT.ERC20', 'USDT_ERC20', 'USDTERC', 'USDT-ERC20'], minDeposit: '1',
  },

  // ---- BNB Smart Chain ---------------------------------------------------
  {
    ticker: 'BNB', name: 'BNB (BEP-20)', chain: 'bsc', kind: 'native', decimals: 18,
    aliases: ['BINANCECOIN', 'BNBBSC', 'BNB.BEP20'], minDeposit: '0.005',
  },
  {
    ticker: 'USDTBEP20', name: 'Tether USD (BEP-20)', chain: 'bsc', kind: 'token', decimals: 18,
    contract: '0x55d398326f99059fF775485246999027B3197955',
    aliases: ['USDT.BEP20', 'USDT_BEP20', 'USDTBSC', 'USDT-BEP20'], minDeposit: '1',
  },
  {
    ticker: 'BUSDBEP20', name: 'Binance USD (BEP-20)', chain: 'bsc', kind: 'token', decimals: 18,
    contract: '0xe9e7CEA3DedcA5984780BafC599bD69ADd087D56',
    aliases: ['BUSD', 'BUSD.BEP20', 'BUSD_BEP20', 'BUSD-BEP20'], minDeposit: '1',
  },
  {
    ticker: 'SHIBBEP20', name: 'Shiba Inu (BEP-20)', chain: 'bsc', kind: 'token', decimals: 18,
    contract: '0x2859e4544C4bB03966803b044A93563Bd2D0DD4D',
    aliases: ['SHIB', 'SHIB.BEP20', 'SHIB_BEP20', 'SHIB-BEP20'], minDeposit: '100000',
  },

  // ---- Tron --------------------------------------------------------------
  {
    ticker: 'TRX', name: 'TRON', chain: 'tron', kind: 'native', decimals: 6,
    aliases: ['TRON'], minDeposit: '5',
  },
  {
    ticker: 'USDTTRC', name: 'Tether USD (TRC-20)', chain: 'tron', kind: 'token', decimals: 6,
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    aliases: ['USDT.TRC20', 'USDTTRC20', 'USDT_TRC20', 'USDT-TRC20', 'USDT'], minDeposit: '1',
  },
  {
    ticker: 'USDCTRC20', name: 'USD Coin (TRC-20)', chain: 'tron', kind: 'token', decimals: 6,
    contract: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
    aliases: ['USDC.TRC20', 'USDCTRC', 'USDC_TRC20', 'USDC-TRC20', 'USDC'], minDeposit: '1',
  },

  // ---- Other L1s ---------------------------------------------------------
  {
    ticker: 'SOL', name: 'Solana', chain: 'solana', kind: 'native', decimals: 9,
    aliases: ['SOLANA'], minDeposit: '0.01',
  },
  {
    ticker: 'XTZ', name: 'Tezos', chain: 'tezos', kind: 'native', decimals: 6,
    aliases: ['TEZOS'], minDeposit: '0.5',
  },
  {
    ticker: 'XMR', name: 'Monero', chain: 'monero', kind: 'native', decimals: 12,
    aliases: ['MONERO'], minDeposit: '0.005',
  },

  // ---- Tag / memo chains -------------------------------------------------
  {
    ticker: 'XRP', name: 'XRP', chain: 'xrp', kind: 'native', decimals: 6,
    aliases: ['RIPPLE'], minDeposit: '1',
  },
  {
    ticker: 'XLM', name: 'Stellar Lumens', chain: 'stellar', kind: 'native', decimals: 7,
    aliases: ['STELLAR'], minDeposit: '1',
  },
  {
    ticker: 'EOS', name: 'EOS', chain: 'eos', kind: 'native', decimals: 4,
    aliases: [], minDeposit: '0.5',
  },
];

export const CURRENCIES: Record<string, CurrencyDef> = Object.fromEntries(
  D.map((c) => [c.ticker, c]),
);

const LOOKUP = new Map<string, string>();
for (const c of D) {
  LOOKUP.set(c.ticker.toUpperCase(), c.ticker);
  for (const a of c.aliases) LOOKUP.set(a.toUpperCase(), c.ticker);
}

/** Resolve any accepted spelling to the canonical currency definition. */
export function resolveCurrency(input: string): CurrencyDef | null {
  if (!input) return null;
  const key = LOOKUP.get(input.trim().toUpperCase());
  return key ? CURRENCIES[key] : null;
}

export function listCurrencies(): CurrencyDef[] {
  return D.slice();
}

/** All currencies that settle on a given chain. */
export function currenciesForChain(chain: string): CurrencyDef[] {
  return D.filter((c) => c.chain === chain);
}
