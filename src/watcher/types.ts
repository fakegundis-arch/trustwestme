import type { AddressRow } from '../db/repo';

/** A deposit as observed on-chain, before it is matched to a user and stored. */
export interface RawDeposit {
  currency: string;      // canonical ticker
  address: string;
  tag: string | null;    // destination tag / memo, on shared-address chains
  txid: string;
  /** Distinguishes several credits inside one transaction (vout, log index). */
  outputIndex: number;
  amount: bigint;        // base units
  confirmations: number;
  blockHeight: number | null;
}

export interface ScanContext {
  /** Every address this gateway is watching on the chain. */
  watched: AddressRow[];
  /** Provider-defined resume point (block height, ledger index, cursor token). */
  cursor: string | null;
}

export interface ScanResult {
  deposits: RawDeposit[];
  /** New cursor to persist. Return the incoming cursor to leave it unchanged. */
  cursor: string | null;
  /**
   * Current chain height, when the provider knows it.
   *
   * Cursor-based providers never look at a block twice, so a deposit first seen
   * below its confirmation threshold would never be revisited and would stay
   * pending forever. Reporting the head lets the watcher recompute
   * confirmations for deposits it already knows about, which needs no extra
   * requests: confirmations are just head minus the deposit's block height.
   */
  chainHead?: number;
}

export interface ChainProvider {
  chain: string;
  scan(ctx: ScanContext): Promise<ScanResult>;
}
