import { resolveCurrency, currenciesForChain, type CurrencyDef } from '../currencies';
import { getChain } from '../chains';
import { deriveIdentity } from '../wallet/derive';
import { getOrCreateUser, getAddress, saveAddress, type AddressRow } from '../db/repo';
import { logger } from '../util/log';

const log = logger('addresses');

export interface DepositIdentity {
  currency: string;
  chain: string;
  address: string;
  /** Destination tag / memo. Non-null only on XRP, XLM and EOS. */
  tag: string | null;
  tagName: string | null;
  userExternalId: string;
  derivationIndex: number;
  /** Other currencies that arrive at this same address. */
  sharedWith: string[];
}

/**
 * Get (or create) the deposit identity for a user in a currency.
 *
 * Idempotent: calling it twice for the same user and currency returns the same
 * address. That matters — a user who reloads the deposit page must not be
 * handed a different address each time, and the HD tree must not burn indexes.
 */
export async function getDepositIdentity(opts: {
  userExternalId: string;
  currency: string;
  ipnUrl?: string | null;
  label?: string | null;
}): Promise<DepositIdentity> {
  const currency = resolveCurrency(opts.currency);
  if (!currency) throw new ApiError(400, `unsupported currency: ${opts.currency}`);

  const chain = getChain(currency.chain);
  const user = getOrCreateUser(opts.userExternalId, opts.label ?? undefined);

  let row: AddressRow | undefined = getAddress(user.id, chain.id);
  if (!row) {
    const derived = await deriveIdentity(chain.id, user.derivation_index);
    row = saveAddress({
      userId: user.id,
      chain: chain.id,
      address: derived.address,
      tag: derived.tag,
      path: derived.path,
      ipnUrl: opts.ipnUrl ?? null,
    });
    log.info(`issued ${chain.id} address for user ${opts.userExternalId} (index ${user.derivation_index})`);
  } else if (opts.ipnUrl && row.ipn_url !== opts.ipnUrl) {
    row = saveAddress({
      userId: user.id, chain: chain.id, address: row.address, tag: row.tag,
      path: row.path, ipnUrl: opts.ipnUrl,
    });
  }

  return {
    currency: currency.ticker,
    chain: chain.id,
    address: row.address,
    tag: row.tag,
    tagName: chain.tagName ?? null,
    userExternalId: opts.userExternalId,
    derivationIndex: user.derivation_index,
    sharedWith: currenciesForChain(chain.id)
      .filter((c) => c.ticker !== currency.ticker)
      .map((c) => c.ticker),
  };
}

export function requireCurrency(input: string): CurrencyDef {
  const c = resolveCurrency(input);
  if (!c) throw new ApiError(400, `unsupported currency: ${input}`);
  return c;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
