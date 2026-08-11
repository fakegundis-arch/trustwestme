import { CURRENCIES } from '../currencies';
import { CHAINS } from '../chains';
import { fromBaseUnits } from '../util/decimal';
import type { DepositRow, WithdrawalRow } from '../db/repo';
import { getUserById } from '../db/repo';

/** Wire format for a transaction, matching the shape WestWallet returns. */
export interface TransactionJson {
  id: string;
  type: 'deposit' | 'withdrawal';
  currency: string;
  blockchain: string;
  address: string;
  dest_tag: string | null;
  amount: string;
  status: string;
  blockchain_hash: string | null;
  blockchain_confirmations: number;
  required_confirmations: number;
  label: string | null;
  explorer_url: string | null;
  created_at: string;
  updated_at: string;
}

export function requiredConfirmations(currencyTicker: string): number {
  const cur = CURRENCIES[currencyTicker];
  if (!cur) return 0;
  return cur.confirmations ?? CHAINS[cur.chain]?.confirmations ?? 0;
}

function explorerUrl(chain: string, txid: string | null): string | null {
  const tpl = CHAINS[chain]?.explorerTx;
  return tpl && txid ? tpl.replace('{tx}', txid) : null;
}

export function depositToJson(d: DepositRow): TransactionJson {
  const decimals = CURRENCIES[d.currency]?.decimals ?? 8;
  const user = getUserById(d.user_id);
  return {
    id: d.uid,
    type: 'deposit',
    currency: d.currency,
    blockchain: d.chain,
    address: d.address,
    dest_tag: d.tag,
    amount: fromBaseUnits(BigInt(d.amount_units), decimals),
    status: d.status,
    blockchain_hash: d.txid,
    blockchain_confirmations: d.confirmations,
    required_confirmations: requiredConfirmations(d.currency),
    label: user?.external_id ?? null,
    explorer_url: explorerUrl(d.chain, d.txid),
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

export function withdrawalToJson(w: WithdrawalRow): TransactionJson {
  const decimals = CURRENCIES[w.currency]?.decimals ?? 8;
  return {
    id: w.uid,
    type: 'withdrawal',
    currency: w.currency,
    blockchain: w.chain,
    address: w.address,
    dest_tag: w.tag,
    amount: fromBaseUnits(BigInt(w.amount_units), decimals),
    status: w.status,
    blockchain_hash: w.txid,
    blockchain_confirmations: 0,
    required_confirmations: requiredConfirmations(w.currency),
    label: w.description,
    explorer_url: explorerUrl(w.chain, w.txid),
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}
