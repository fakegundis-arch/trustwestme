import type { CurrencyDef } from '../../currencies';

export interface SendRequest {
  currency: CurrencyDef;
  /** Derivation index of the address the funds are spent from. */
  fromIndex: number;
  fromAddress: string;
  toAddress: string;
  /** Base units. Ignored when `sweep` is set. */
  amount: bigint;
  /** Send everything the address holds, net of fees. */
  sweep: boolean;
}

export interface SendResult {
  txid: string;
  /** Base units actually sent, which for a sweep is the balance less fees. */
  sent: bigint;
  fee: bigint;
  explorerUrl?: string;
}

export interface ChainSigner {
  /** What an address holds right now, in base units. */
  balance(currency: CurrencyDef, address: string): Promise<bigint>;
  send(request: SendRequest): Promise<SendResult>;
}

/** Big-endian minimal-length bytes, which is how the protos want numbers. */
export function toBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('negative amount');
  if (value === 0n) return new Uint8Array([0]);
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
