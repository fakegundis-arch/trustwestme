import { config } from '../config';
import { getChain } from '../chains';
import { getCore, coinTypeByName } from './core';
import { deriveIdentity } from './derive';
import { logger } from '../util/log';

const log = logger('keys');

/**
 * Private key export.
 *
 * Every deposit address is derived from the master seed, so its key can always
 * be reproduced — this turns a derivation index back into something a wallet
 * app will import. That is the recovery path when funds land on an address the
 * Trust Wallet app does not display, which is any index above zero.
 *
 * Everything here is as sensitive as the seed itself. Nothing in this file is
 * ever logged or written to disk.
 */

/** WIF version byte per UTXO chain. */
const WIF_VERSION: Record<string, number> = {
  bitcoin: 0x80,
  litecoin: 0xb0,
  dogecoin: 0x9e,
  dash: 0xcc,
  bitcoincash: 0x80,
  zcash: 0x80,
};

export interface ExportedKey {
  chain: string;
  address: string;
  path: string;
  index: number;
  /** Raw key as hex. EVM chains expect the 0x prefix; others do not use one. */
  hex: string;
  /** Wallet Import Format — what Electrum and friends expect. */
  wif?: string;
  /** Base58 of the 64-byte secret, which is what Solana wallets import. */
  base58?: string;
  /** Which of the above to paste, in words. */
  importAs: string;
}

export async function exportPrivateKey(chainId: string, index: number): Promise<ExportedKey> {
  if (config.watchOnly) {
    throw new Error('WATCH_ONLY mode: this server holds no keys. Export from the machine that has the seed.');
  }
  if (!config.mnemonic) throw new Error('MASTER_MNEMONIC is not configured');

  const chain = getChain(chainId);
  if (chain.addressMode === 'monero') {
    throw new Error('Monero keys live in monero-wallet-rpc, not in the seed. '
      + 'Use the wallet daemon to spend XMR.');
  }
  if (chain.addressMode === 'shared') {
    throw new Error(`${chainId} uses one gateway account for every user, so there is no `
      + 'per-user key. Export index 0 for the account itself.');
  }

  const identity = await deriveIdentity(chainId, index);
  const core = await getCore();
  const coin = coinTypeByName(core, chain.walletCoreCoin!);
  const wallet = core.HDWallet.createWithMnemonic(config.mnemonic, config.mnemonicPassphrase);
  const key = wallet.getKey(coin, identity.path!);
  const raw = key.data();

  const result: ExportedKey = {
    chain: chainId,
    address: identity.address,
    path: identity.path!,
    index,
    hex: toHex(raw),
    importAs: 'raw hex private key',
  };

  const version = WIF_VERSION[chainId];
  if (version !== undefined) {
    // WIF is base58check over: version || 32-byte key || 0x01 for a
    // compressed public key.
    const payload = new Uint8Array(34);
    payload[0] = version;
    payload.set(raw, 1);
    payload[33] = 0x01;
    result.wif = core.Base58.encode(payload);
    result.importAs = 'WIF (starts with K, L, 6, Q or T depending on the coin)';
  } else if (chain.keyMode === 'ed25519' && chainId === 'solana') {
    // Solana wallets import base58 of the 64-byte secret: private then public.
    const pub = key.getPublicKeyEd25519().data();
    const combined = new Uint8Array(64);
    combined.set(raw, 0);
    combined.set(pub, 32);
    result.base58 = core.Base58.encodeNoCheck(combined);
    result.importAs = 'base58 secret key (Phantom, Solflare)';
  } else if (chainId === 'ethereum' || chainId === 'bsc' || chainId === 'tron') {
    result.hex = '0x' + toHex(raw).replace(/^0x/, '');
    result.importAs = chainId === 'tron'
      ? 'hex private key (TronLink accepts it without the 0x)'
      : 'hex private key (MetaMask, Trust Wallet)';
  }

  log.info(`exported the key for ${chainId} index ${index}`); // never the key itself
  return result;
}

/** Raw key bytes for signing. Kept out of any string that could be logged. */
export async function privateKeyBytes(chainId: string, index: number): Promise<Uint8Array> {
  if (config.watchOnly) throw new Error('WATCH_ONLY mode: cannot sign');
  if (!config.mnemonic) throw new Error('MASTER_MNEMONIC is not configured');
  const chain = getChain(chainId);
  const identity = await deriveIdentity(chainId, index);
  const core = await getCore();
  const coin = coinTypeByName(core, chain.walletCoreCoin!);
  const wallet = core.HDWallet.createWithMnemonic(config.mnemonic, config.mnemonicPassphrase);
  return wallet.getKey(coin, identity.path!).data();
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
