import { randomUUID } from 'node:crypto';
import { getDb } from './index';
import { logger } from '../util/log';

const log = logger('repo');
const now = () => new Date().toISOString();

export interface UserRow {
  id: number; external_id: string; derivation_index: number; label: string | null; created_at: string;
}
export interface AddressRow {
  id: number; user_id: number; chain: string; address: string; tag: string | null;
  path: string | null; ipn_url: string | null; created_at: string;
}
export interface DepositRow {
  id: number; uid: string; user_id: number; address_id: number; chain: string; currency: string;
  address: string; tag: string | null; txid: string; output_index: number; amount_units: string;
  confirmations: number; block_height: number | null; status: string; credited: number;
  created_at: string; updated_at: string;
}
export interface WithdrawalRow {
  id: number; uid: string; currency: string; chain: string; address: string; tag: string | null;
  amount_units: string; status: string; txid: string | null; error: string | null;
  description: string | null; request_id: string | null; created_at: string; updated_at: string;
}

// ---------------------------------------------------------------- users ----

/**
 * Find or create the user, assigning the next free derivation index.
 * The index is what ties a user to their addresses on every chain, so it is
 * allocated once and never reused.
 */
export function getOrCreateUser(externalId: string, label?: string): UserRow {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE external_id = ?').get(externalId) as UserRow | undefined;
  if (existing) return existing;

  const tx = db.transaction((extId: string, lbl: string | null): UserRow => {
    const again = db.prepare('SELECT * FROM users WHERE external_id = ?').get(extId) as UserRow | undefined;
    if (again) return again;
    const row = db.prepare('SELECT COALESCE(MAX(derivation_index), -1) AS m FROM users').get() as { m: number };
    // Index 0 is reserved for the gateway's own/shared accounts.
    const next = Math.max(row.m + 1, 1);
    const info = db.prepare(
      'INSERT INTO users (external_id, derivation_index, label, created_at) VALUES (?, ?, ?, ?)',
    ).run(extId, next, lbl, now());
    return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as UserRow;
  });
  const user = tx(externalId, label ?? null);
  log.info(`user ${externalId} -> derivation index ${user.derivation_index}`);
  return user;
}

export function getUserByExternalId(externalId: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE external_id = ?').get(externalId) as UserRow | undefined;
}
export function getUserById(id: number): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}
export function listUsers(): UserRow[] {
  return getDb().prepare('SELECT * FROM users ORDER BY derivation_index').all() as UserRow[];
}

// ------------------------------------------------------------ addresses ----

export function getAddress(userId: number, chain: string): AddressRow | undefined {
  return getDb().prepare('SELECT * FROM addresses WHERE user_id = ? AND chain = ?')
    .get(userId, chain) as AddressRow | undefined;
}

export function saveAddress(a: {
  userId: number; chain: string; address: string; tag: string | null;
  path: string | null; ipnUrl: string | null;
}): AddressRow {
  const db = getDb();
  db.prepare(`INSERT INTO addresses (user_id, chain, address, tag, path, ipn_url, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, chain) DO UPDATE SET
                ipn_url = COALESCE(excluded.ipn_url, addresses.ipn_url)`)
    .run(a.userId, a.chain, a.address, a.tag, a.path, a.ipnUrl, now());
  return getAddress(a.userId, a.chain)!;
}

/** Every watched address on a chain, for the scanner. */
export function addressesForChain(chain: string): AddressRow[] {
  return getDb().prepare('SELECT * FROM addresses WHERE chain = ?').all(chain) as AddressRow[];
}

export function findAddress(chain: string, address: string): AddressRow | undefined {
  return getDb().prepare('SELECT * FROM addresses WHERE chain = ? AND LOWER(address) = LOWER(?)')
    .get(chain, address) as AddressRow | undefined;
}

/** Resolve a tag/memo back to the user who owns it, on shared-address chains. */
export function findAddressByTag(chain: string, tag: string): AddressRow | undefined {
  return getDb().prepare('SELECT * FROM addresses WHERE chain = ? AND tag = ?')
    .get(chain, String(tag)) as AddressRow | undefined;
}

// -------------------------------------------------------------- deposits ---

export interface RecordDepositInput {
  userId: number; addressId: number; chain: string; currency: string; address: string;
  tag: string | null; txid: string; outputIndex: number; amountUnits: bigint;
  confirmations: number; blockHeight: number | null; status: 'pending' | 'completed';
}

/**
 * Insert a newly seen deposit, or update the confirmation count of one we
 * already know. Returns the row plus what actually changed, so the caller knows
 * whether to fire an IPN.
 *
 * The UNIQUE(chain, txid, output_index, currency) constraint is what makes this
 * safe to call repeatedly on every scan.
 */
export function recordDeposit(input: RecordDepositInput): {
  row: DepositRow; isNew: boolean; becameCompleted: boolean;
} {
  const db = getDb();
  const tx = db.transaction(() => {
    const existing = db.prepare(
      'SELECT * FROM deposits WHERE chain = ? AND txid = ? AND output_index = ? AND currency = ?',
    ).get(input.chain, input.txid, input.outputIndex, input.currency) as DepositRow | undefined;

    if (!existing) {
      const uid = randomUUID();
      db.prepare(`INSERT INTO deposits
        (uid, user_id, address_id, chain, currency, address, tag, txid, output_index,
         amount_units, confirmations, block_height, status, credited, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(
        uid, input.userId, input.addressId, input.chain, input.currency, input.address, input.tag,
        input.txid, input.outputIndex, input.amountUnits.toString(), input.confirmations,
        input.blockHeight, input.status, now(), now(),
      );
      const row = db.prepare('SELECT * FROM deposits WHERE uid = ?').get(uid) as DepositRow;
      return { row, isNew: true, becameCompleted: input.status === 'completed' };
    }

    const wasCompleted = existing.status === 'completed';
    // Never walk a completed deposit backwards; confirmations only climb.
    const status = wasCompleted ? 'completed' : input.status;
    const confirmations = Math.max(existing.confirmations, input.confirmations);
    db.prepare('UPDATE deposits SET confirmations = ?, status = ?, block_height = ?, updated_at = ? WHERE id = ?')
      .run(confirmations, status, input.blockHeight ?? existing.block_height, now(), existing.id);
    const row = db.prepare('SELECT * FROM deposits WHERE id = ?').get(existing.id) as DepositRow;
    return { row, isNew: false, becameCompleted: !wasCompleted && status === 'completed' };
  });
  return tx();
}

/**
 * Move a completed deposit into the user's spendable balance. Guarded by the
 * `credited` flag inside a transaction, so a deposit can never be credited
 * twice even if two watcher passes race.
 */
export function creditDeposit(depositId: number): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    const d = db.prepare('SELECT * FROM deposits WHERE id = ?').get(depositId) as DepositRow | undefined;
    if (!d || d.credited === 1 || d.status !== 'completed') return false;
    db.prepare(`INSERT INTO balances (user_id, currency, available_units, pending_units)
                VALUES (?, ?, '0', '0') ON CONFLICT(user_id, currency) DO NOTHING`)
      .run(d.user_id, d.currency);
    const bal = db.prepare('SELECT available_units FROM balances WHERE user_id = ? AND currency = ?')
      .get(d.user_id, d.currency) as { available_units: string };
    const updated = BigInt(bal.available_units) + BigInt(d.amount_units);
    db.prepare('UPDATE balances SET available_units = ? WHERE user_id = ? AND currency = ?')
      .run(updated.toString(), d.user_id, d.currency);
    db.prepare('UPDATE deposits SET credited = 1, updated_at = ? WHERE id = ?').run(now(), depositId);
    return true;
  });
  return tx();
}

export function getDepositByUid(uid: string): DepositRow | undefined {
  return getDb().prepare('SELECT * FROM deposits WHERE uid = ?').get(uid) as DepositRow | undefined;
}

/**
 * Look a transaction up by either identifier. WestWallet clients hold the
 * numeric id; anything of ours may hold the UUID.
 */
export function findTransaction(id: string): { deposit?: DepositRow; withdrawal?: WithdrawalRow } {
  const db = getDb();
  if (/^\d+$/.test(id)) {
    const n = Number(id);
    const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(n) as DepositRow | undefined;
    if (deposit) return { deposit };
    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(n) as WithdrawalRow | undefined;
    if (withdrawal) return { withdrawal };
    return {};
  }
  const deposit = getDepositByUid(id);
  if (deposit) return { deposit };
  return { withdrawal: getWithdrawalByUid(id) };
}

export function pendingDeposits(chain?: string): DepositRow[] {
  const db = getDb();
  return chain
    ? db.prepare("SELECT * FROM deposits WHERE status = 'pending' AND chain = ?").all(chain) as DepositRow[]
    : db.prepare("SELECT * FROM deposits WHERE status = 'pending'").all() as DepositRow[];
}

export function listDeposits(filter: {
  userId?: number; currency?: string; status?: string; limit?: number; offset?: number;
}): DepositRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.userId !== undefined) { where.push('user_id = ?'); args.push(filter.userId); }
  if (filter.currency) { where.push('currency = ?'); args.push(filter.currency); }
  if (filter.status) { where.push('status = ?'); args.push(filter.status); }
  const sql = `SELECT * FROM deposits ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY id DESC LIMIT ? OFFSET ?`;
  args.push(Math.min(filter.limit ?? 100, 500), filter.offset ?? 0);
  return getDb().prepare(sql).all(...args) as DepositRow[];
}

// -------------------------------------------------------------- balances ---

export function getBalance(userId: number, currency: string): { available: bigint; pending: bigint } {
  const row = getDb().prepare('SELECT * FROM balances WHERE user_id = ? AND currency = ?')
    .get(userId, currency) as { available_units: string; pending_units: string } | undefined;
  return {
    available: BigInt(row?.available_units ?? '0'),
    pending: BigInt(row?.pending_units ?? '0'),
  };
}

/** Gateway-wide total across all users for a currency. */
export function getTotalBalance(currency: string): bigint {
  const rows = getDb().prepare('SELECT available_units FROM balances WHERE currency = ?')
    .all(currency) as { available_units: string }[];
  return rows.reduce((a, r) => a + BigInt(r.available_units), 0n);
}

export function debitBalance(userId: number, currency: string, amount: bigint): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT available_units FROM balances WHERE user_id = ? AND currency = ?')
      .get(userId, currency) as { available_units: string } | undefined;
    const available = BigInt(row?.available_units ?? '0');
    if (available < amount) return false;
    db.prepare('UPDATE balances SET available_units = ? WHERE user_id = ? AND currency = ?')
      .run((available - amount).toString(), userId, currency);
    return true;
  });
  return tx();
}

// ----------------------------------------------------------- withdrawals ---

export function createWithdrawal(w: {
  currency: string; chain: string; address: string; tag: string | null;
  amountUnits: bigint; description: string | null; requestId: string | null;
}): WithdrawalRow {
  const db = getDb();
  if (w.requestId) {
    const dup = db.prepare('SELECT * FROM withdrawals WHERE request_id = ?')
      .get(w.requestId) as WithdrawalRow | undefined;
    if (dup) return dup;
  }
  const uid = randomUUID();
  db.prepare(`INSERT INTO withdrawals
    (uid, currency, chain, address, tag, amount_units, status, description, request_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?, 'created', ?,?,?,?)`)
    .run(uid, w.currency, w.chain, w.address, w.tag, w.amountUnits.toString(),
         w.description, w.requestId, now(), now());
  return db.prepare('SELECT * FROM withdrawals WHERE uid = ?').get(uid) as WithdrawalRow;
}

export function getWithdrawalByUid(uid: string): WithdrawalRow | undefined {
  return getDb().prepare('SELECT * FROM withdrawals WHERE uid = ?').get(uid) as WithdrawalRow | undefined;
}

export function listWithdrawals(filter: { currency?: string; status?: string; limit?: number; offset?: number }): WithdrawalRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.currency) { where.push('currency = ?'); args.push(filter.currency); }
  if (filter.status) { where.push('status = ?'); args.push(filter.status); }
  const sql = `SELECT * FROM withdrawals ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY id DESC LIMIT ? OFFSET ?`;
  args.push(Math.min(filter.limit ?? 100, 500), filter.offset ?? 0);
  return getDb().prepare(sql).all(...args) as WithdrawalRow[];
}

// ----------------------------------------------------------- chain state ---

export function getCursor(chain: string): string | null {
  const row = getDb().prepare('SELECT cursor FROM chain_state WHERE chain = ?')
    .get(chain) as { cursor: string | null } | undefined;
  return row?.cursor ?? null;
}

export function setCursor(chain: string, cursor: string | null, error?: string | null) {
  getDb().prepare(`INSERT INTO chain_state (chain, cursor, last_run_at, last_error)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(chain) DO UPDATE SET
                     cursor = excluded.cursor,
                     last_run_at = excluded.last_run_at,
                     last_error = excluded.last_error`)
    .run(chain, cursor, now(), error ?? null);
}

export function chainStates(): { chain: string; cursor: string | null; last_run_at: string | null; last_error: string | null }[] {
  return getDb().prepare('SELECT * FROM chain_state').all() as any[];
}

// ------------------------------------------------------------- ipn queue ---

export function enqueueIpn(event: string, url: string, payload: unknown) {
  getDb().prepare(`INSERT INTO ipn_queue (event, url, payload, attempts, next_at, status, created_at)
                   VALUES (?, ?, ?, 0, ?, 'queued', ?)`)
    .run(event, url, JSON.stringify(payload), now(), now());
}

export function dueIpns(limit = 25) {
  return getDb().prepare(`SELECT * FROM ipn_queue WHERE status = 'queued' AND next_at <= ?
                          ORDER BY id LIMIT ?`).all(now(), limit) as {
    id: number; event: string; url: string; payload: string; attempts: number;
  }[];
}

export function markIpnDelivered(id: number) {
  getDb().prepare("UPDATE ipn_queue SET status = 'delivered', last_error = NULL WHERE id = ?").run(id);
}

export function markIpnRetry(id: number, attempts: number, nextAt: Date, error: string, maxAttempts: number) {
  const status = attempts >= maxAttempts ? 'failed' : 'queued';
  getDb().prepare('UPDATE ipn_queue SET attempts = ?, next_at = ?, status = ?, last_error = ? WHERE id = ?')
    .run(attempts, nextAt.toISOString(), status, error.slice(0, 500), id);
}

// ------------------------------------------------------------- api keys ----

export function findApiKey(publicKey: string): { public_key: string; private_key: string; active: number } | undefined {
  return getDb().prepare('SELECT * FROM api_keys WHERE public_key = ? AND active = 1')
    .get(publicKey) as any;
}

export function insertApiKey(publicKey: string, privateKey: string, label: string | null) {
  getDb().prepare('INSERT INTO api_keys (public_key, private_key, label, active, created_at) VALUES (?,?,?,1,?)')
    .run(publicKey, privateKey, label, now());
}

/** Returns false if this nonce was already used by this key (replay attempt). */
export function consumeNonce(publicKey: string, nonce: string, windowSec: number): boolean {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - windowSec * 2;
  db.prepare('DELETE FROM used_nonces WHERE seen_at < ?').run(cutoff);
  try {
    db.prepare('INSERT INTO used_nonces (public_key, nonce, seen_at) VALUES (?, ?, ?)')
      .run(publicKey, nonce, Math.floor(Date.now() / 1000));
    return true;
  } catch {
    return false;
  }
}
