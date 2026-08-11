import { config } from '../config';
import { getChain, type ChainDef } from '../chains';
import { getCore, coinTypeByName, type WalletCore } from './core';
import { logger } from '../util/log';

const log = logger('derive');

export interface DerivedIdentity {
  chain: string;
  /** The on-chain address funds are sent to. */
  address: string;
  /** Destination tag / memo, for shared-address chains. */
  tag: string | null;
  /** BIP44 path used, for auditing and recovery. */
  path: string | null;
  index: number;
}

let wallet: unknown = null;

async function getWallet(core: WalletCore) {
  if (wallet) return wallet as any;
  if (config.watchOnly) throw new Error('WATCH_ONLY mode: cannot derive new addresses');
  if (!config.mnemonic) throw new Error('MASTER_MNEMONIC is not configured');
  if (!core.Mnemonic.isValid(config.mnemonic)) {
    throw new Error('MASTER_MNEMONIC is not a valid BIP39 mnemonic');
  }
  wallet = core.HDWallet.createWithMnemonic(config.mnemonic, config.mnemonicPassphrase);
  return wallet as any;
}

/**
 * Derive the deposit identity for a user on a chain.
 *
 * `index` is the user's slot in the HD tree — user 1 gets index 1 on every
 * chain, so one number identifies a user's whole set of addresses. On shared
 * (tag/memo) chains the address is fixed and the index becomes the tag.
 */
export async function deriveIdentity(chainId: string, index: number): Promise<DerivedIdentity> {
  const chain = getChain(chainId);
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) {
    throw new Error(`derivation index out of range: ${index}`);
  }

  if (chain.addressMode === 'shared') {
    return { chain: chainId, address: sharedAddressFor(chainId), tag: String(index), path: chain.path, index };
  }
  if (chain.addressMode === 'monero') {
    // Monero subaddresses come from monero-wallet-rpc, not from wallet-core.
    const { createSubaddress } = await import('./monero');
    const sub = await createSubaddress(index);
    return { chain: chainId, address: sub.address, tag: null, path: `subaddress:${sub.addressIndex}`, index };
  }

  const core = await getCore();
  const w = await getWallet(core);
  const coin = coinTypeByName(core, chain.walletCoreCoin!);
  const path = chain.path!.replace('{i}', String(index));

  let address: string;
  try {
    const key = w.getKey(coin, path);
    const pub = publicKeyFor(key, chain);
    address = core.AnyAddress.createWithPublicKey(pub, coin).description();
  } catch (e) {
    log.error(`derivation failed for ${chainId} index ${index}`, String(e));
    throw new Error(`could not derive ${chainId} address at index ${index}`);
  }
  if (!address) throw new Error(`wallet-core returned an empty ${chainId} address at index ${index}`);

  return { chain: chainId, address, tag: null, path, index };
}

function publicKeyFor(key: any, chain: ChainDef) {
  switch (chain.keyMode) {
    case 'ed25519':
      return key.getPublicKeyEd25519();
    case 'secp256k1-uncompressed':
      return key.getPublicKeySecp256k1(false);
    case 'secp256k1-compressed':
    default:
      return key.getPublicKeySecp256k1(true);
  }
}

/** The gateway's single receiving address on a tag/memo chain. */
export function sharedAddressFor(chainId: string): string {
  switch (chainId) {
    case 'xrp':
      if (!config.shared.xrpAddress) throw new Error('XRP_ADDRESS is not configured');
      return config.shared.xrpAddress;
    case 'stellar':
      if (!config.shared.stellarAddress) throw new Error('STELLAR_ADDRESS is not configured');
      return config.shared.stellarAddress;
    case 'eos':
      if (!config.shared.eosAccount) throw new Error('EOS_ACCOUNT is not configured');
      return config.shared.eosAccount;
    default:
      throw new Error(`${chainId} is not a shared-address chain`);
  }
}

/**
 * Derive the address that SHOULD be configured as the shared address for a
 * tag/memo chain, straight from the seed. Used by the setup CLI so you know
 * which account to activate and fund.
 */
export async function deriveSharedCandidate(chainId: string): Promise<string> {
  const chain = getChain(chainId);
  if (chain.addressMode !== 'shared') throw new Error(`${chainId} is not a shared-address chain`);
  const core = await getCore();
  const w = await getWallet(core);
  const coin = coinTypeByName(core, chain.walletCoreCoin!);
  const key = w.getKey(coin, chain.path!);
  return core.AnyAddress.createWithPublicKey(publicKeyFor(key, chain), coin).description();
}

/** Generate a fresh BIP39 mnemonic using wallet-core's own entropy. */
export async function generateMnemonic(strength: 128 | 256 = 256): Promise<string> {
  const core = await getCore();
  return core.HDWallet.create(strength, '').mnemonic();
}
