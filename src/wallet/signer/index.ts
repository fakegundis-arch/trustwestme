import type { CurrencyDef } from '../../currencies';
import { evmSigner } from './evm';
import { utxoSigner } from './utxo';
import type { ChainSigner } from './types';

export type { ChainSigner, SendRequest, SendResult } from './types';

/**
 * Chains this build can spend from.
 *
 * Every chain here is signed with Trust Wallet Core and broadcast directly.
 * The rest are not yet implemented — each needs its own transaction
 * construction (Tron's energy model, Solana's blockhash lifetime, XRP's
 * sequence numbers), and shipping one half-tested would risk real money.
 * For those, export the private key and spend from a wallet app instead.
 */
const SIGNERS: Record<string, () => ChainSigner> = {
  ethereum: () => evmSigner('ethereum'),
  bsc: () => evmSigner('bsc'),
  bitcoin: () => utxoSigner('bitcoin'),
  litecoin: () => utxoSigner('litecoin'),
  dogecoin: () => utxoSigner('dogecoin'),
  dash: () => utxoSigner('dash'),
  bitcoincash: () => utxoSigner('bitcoincash'),
  zcash: () => utxoSigner('zcash'),
};

export function canSign(chainId: string): boolean {
  return chainId in SIGNERS;
}

export function signerFor(chainId: string): ChainSigner {
  const make = SIGNERS[chainId];
  if (!make) {
    throw new Error(`sending ${chainId} is not implemented yet. Use /key to export the `
      + 'private key and spend from a wallet app.');
  }
  return make();
}

/** Currencies that can be sent from here. */
export function canSendCurrency(currency: CurrencyDef): boolean {
  return canSign(currency.chain);
}
