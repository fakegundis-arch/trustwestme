/**
 * Chain registry.
 *
 * Every chain declares how a per-user deposit identity is produced:
 *
 *  - 'derived'  : each user gets their own address, derived from the master
 *                 seed at a BIP44 index. No memo.
 *  - 'shared'   : ONE address for the whole gateway; users are distinguished
 *                 by a destination tag / memo. Used on chains where an account
 *                 must be funded with a reserve before it exists (XRP, XLM) or
 *                 where accounts are named resources (EOS). Deriving a fresh
 *                 address per user on those chains would require pre-funding
 *                 every single user, so tags are the correct model — and it is
 *                 what every exchange does.
 *  - 'monero'   : Monero subaddresses, produced by monero-wallet-rpc. Trust
 *                 Wallet Core has no Monero support, so this chain is the one
 *                 that needs an external wallet daemon.
 */

export type AddressMode = 'derived' | 'shared' | 'monero';

/** How to turn a derived private key into a public key for this chain. */
export type KeyMode = 'secp256k1-compressed' | 'secp256k1-uncompressed' | 'ed25519';

export interface ChainDef {
  id: string;
  /** Coin name as exported by @trustwallet/wallet-core's CoinType enum. */
  walletCoreCoin: string | null;
  addressMode: AddressMode;
  keyMode: KeyMode;
  /**
   * BIP44 path template. `{i}` is replaced with the user's derivation index.
   * Chains whose canonical path is hardened-only vary the *account* level,
   * because wallet-core ignores the address index on those paths.
   */
  path: string | null;
  /** Watcher provider implementation key. */
  provider: string;
  /** Human label for the memo field, if this chain uses one. */
  tagName?: string;
  /** Default confirmations before a deposit is credited. */
  confirmations: number;
  /** Explorer URL template for building transaction links. `{tx}` placeholder. */
  explorerTx?: string;
}

export const CHAINS: Record<string, ChainDef> = {
  bitcoin: {
    id: 'bitcoin',
    walletCoreCoin: 'bitcoin',
    addressMode: 'derived',
    keyMode: 'secp256k1-compressed',
    path: "m/84'/0'/0'/0/{i}",
    provider: 'blockbook',
    confirmations: 2,
    explorerTx: 'https://blockchair.com/bitcoin/transaction/{tx}',
  },
  litecoin: {
    id: 'litecoin',
    walletCoreCoin: 'litecoin',
    addressMode: 'derived',
    keyMode: 'secp256k1-compressed',
    path: "m/84'/2'/0'/0/{i}",
    provider: 'blockbook',
    confirmations: 6,
    explorerTx: 'https://blockchair.com/litecoin/transaction/{tx}',
  },
  dogecoin: {
    id: 'dogecoin',
    walletCoreCoin: 'dogecoin',
    addressMode: 'derived',
    keyMode: 'secp256k1-compressed',
    path: "m/44'/3'/0'/0/{i}",
    provider: 'blockbook',
    confirmations: 20,
    explorerTx: 'https://blockchair.com/dogecoin/transaction/{tx}',
  },
  dash: {
    id: 'dash',
    walletCoreCoin: 'dash',
    addressMode: 'derived',
    keyMode: 'secp256k1-compressed',
    path: "m/44'/5'/0'/0/{i}",
    provider: 'blockbook',
    confirmations: 6,
    explorerTx: 'https://blockchair.com/dash/transaction/{tx}',
  },
  bitcoincash: {
    id: 'bitcoincash',
    walletCoreCoin: 'bitcoinCash',
    addressMode: 'derived',
    keyMode: 'secp256k1-compressed',
    path: "m/44'/145'/0'/0/{i}",
    provider: 'blockbook',
    confirmations: 6,
    explorerTx: 'https://blockchair.com/bitcoin-cash/transaction/{tx}',
  },
  zcash: {
    id: 'zcash',
    walletCoreCoin: 'zcash',
    addressMode: 'derived',
    keyMode: 'secp256k1-compressed',
    // Transparent (t-) addresses only. Shielded addresses are not derivable here.
    path: "m/44'/133'/0'/0/{i}",
    provider: 'blockbook',
    confirmations: 10,
    explorerTx: 'https://blockchair.com/zcash/transaction/{tx}',
  },
  ethereum: {
    id: 'ethereum',
    walletCoreCoin: 'ethereum',
    addressMode: 'derived',
    keyMode: 'secp256k1-uncompressed',
    path: "m/44'/60'/0'/0/{i}",
    provider: 'evm',
    confirmations: 12,
    explorerTx: 'https://etherscan.io/tx/{tx}',
  },
  bsc: {
    id: 'bsc',
    walletCoreCoin: 'smartChain',
    addressMode: 'derived',
    keyMode: 'secp256k1-uncompressed',
    // Same coin type as Ethereum: a BSC address IS the user's ETH address.
    // The chains are still tracked separately, because USDT-ERC20 and
    // USDT-BEP20 arriving at that one address are different currencies.
    path: "m/44'/60'/0'/0/{i}",
    provider: 'evm',
    confirmations: 15,
    explorerTx: 'https://bscscan.com/tx/{tx}',
  },
  tron: {
    id: 'tron',
    walletCoreCoin: 'tron',
    addressMode: 'derived',
    keyMode: 'secp256k1-uncompressed',
    path: "m/44'/195'/0'/0/{i}",
    provider: 'tron',
    confirmations: 20,
    explorerTx: 'https://tronscan.org/#/transaction/{tx}',
  },
  solana: {
    id: 'solana',
    walletCoreCoin: 'solana',
    addressMode: 'derived',
    keyMode: 'ed25519',
    // Hardened-only path: the user index varies the account level.
    path: "m/44'/501'/{i}'",
    provider: 'solana',
    confirmations: 1, // Solana deposits are credited on finalized commitment.
    explorerTx: 'https://solscan.io/tx/{tx}',
  },
  tezos: {
    id: 'tezos',
    walletCoreCoin: 'tezos',
    addressMode: 'derived',
    keyMode: 'ed25519',
    path: "m/44'/1729'/{i}'/0'",
    provider: 'tezos',
    confirmations: 3,
    explorerTx: 'https://tzkt.io/{tx}',
  },
  xrp: {
    id: 'xrp',
    walletCoreCoin: 'xrp',
    addressMode: 'shared',
    keyMode: 'secp256k1-compressed',
    path: "m/44'/144'/0'/0/0",
    provider: 'xrp',
    tagName: 'destination_tag',
    confirmations: 1, // XRP ledgers are final once validated.
    explorerTx: 'https://xrpscan.com/tx/{tx}',
  },
  stellar: {
    id: 'stellar',
    walletCoreCoin: 'stellar',
    addressMode: 'shared',
    keyMode: 'ed25519',
    path: "m/44'/148'/0'",
    provider: 'stellar',
    tagName: 'memo',
    confirmations: 1, // Stellar ledgers are final on close.
    explorerTx: 'https://stellar.expert/explorer/public/tx/{tx}',
  },
  eos: {
    id: 'eos',
    walletCoreCoin: 'eos',
    addressMode: 'shared',
    keyMode: 'secp256k1-compressed',
    path: "m/44'/194'/0'/0/0",
    provider: 'eos',
    tagName: 'memo',
    confirmations: 1, // EOS blocks are irreversible after ~3 min; see provider.
    explorerTx: 'https://bloks.io/transaction/{tx}',
  },
  monero: {
    id: 'monero',
    walletCoreCoin: null, // not supported by wallet-core
    addressMode: 'monero',
    keyMode: 'ed25519',
    path: null,
    provider: 'monero',
    confirmations: 10,
    explorerTx: 'https://xmrchain.net/tx/{tx}',
  },
};

export function getChain(id: string): ChainDef {
  const c = CHAINS[id];
  if (!c) throw new Error(`unknown chain: ${id}`);
  return c;
}
