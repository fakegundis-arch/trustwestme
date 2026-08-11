import { initWasm } from '@trustwallet/wallet-core';

/**
 * Trust Wallet Core is a WASM module. Instantiating it is expensive and, more
 * importantly, a failed call inside the module aborts the whole instance, so we
 * keep exactly one and guard every call that can throw.
 */
export type WalletCore = Awaited<ReturnType<typeof initWasm>>;

let corePromise: Promise<WalletCore> | null = null;

export function getCore(): Promise<WalletCore> {
  if (!corePromise) corePromise = initWasm();
  return corePromise;
}

/**
 * Resolve a wallet-core CoinType by its exported name.
 *
 * CoinType values are opaque WASM handles, not plain numbers, so the return
 * type is the module's own CoinType rather than `number`.
 */
export type CoinTypeValue = WalletCore['CoinType'][keyof WalletCore['CoinType']];

export function coinTypeByName(core: WalletCore, name: string): CoinTypeValue {
  const ct = (core.CoinType as unknown as Record<string, CoinTypeValue | undefined>)[name];
  if (ct === undefined) throw new Error(`wallet-core has no CoinType "${name}"`);
  return ct;
}
