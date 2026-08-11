import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers';

setupEnv('deposits');

type Repo = typeof import('../src/db/repo');
type Watcher = typeof import('../src/watcher/index');
type Addresses = typeof import('../src/services/addresses');
type RawDeposit = import('../src/watcher/types').RawDeposit;
type ChainProvider = import('../src/watcher/types').ChainProvider;

let repo: Repo;
let scanChain: Watcher['scanChain'];
let getDepositIdentity: Addresses['getDepositIdentity'];

before(async () => {
  repo = await import('../src/db/repo');
  ({ scanChain } = await import('../src/watcher/index'));
  ({ getDepositIdentity } = await import('../src/services/addresses'));
});

/** A provider that replays a fixed set of observations, like a real chain would. */
function stubProvider(chain: string, deposits: RawDeposit[]): ChainProvider {
  return { chain, async scan() { return { deposits, cursor: null }; } };
}

const btcDeposit = (address: string, over: Partial<RawDeposit> = {}): RawDeposit => ({
  currency: 'BTC',
  address,
  tag: null,
  txid: 'a'.repeat(64),
  outputIndex: 0,
  amount: 100_000n, // 0.001 BTC
  confirmations: 0,
  blockHeight: 800_000,
  ...over,
});

test('a deposit is recorded pending, then credited exactly once when it confirms', async () => {
  const id = await getDepositIdentity({ userExternalId: 'user-1', currency: 'BTC' });
  const user = repo.getUserByExternalId('user-1')!;

  // Seen in the mempool: recorded, but not spendable yet.
  await scanChain(stubProvider('bitcoin', [btcDeposit(id.address, { confirmations: 0 })]));
  let deposits = repo.listDeposits({ userId: user.id });
  assert.equal(deposits.length, 1);
  assert.equal(deposits[0].status, 'pending');
  assert.equal(repo.getBalance(user.id, 'BTC').available, 0n);

  // BTC needs 2 confirmations; one is still not enough.
  await scanChain(stubProvider('bitcoin', [btcDeposit(id.address, { confirmations: 1 })]));
  assert.equal(repo.getBalance(user.id, 'BTC').available, 0n);

  // Threshold reached: credited.
  await scanChain(stubProvider('bitcoin', [btcDeposit(id.address, { confirmations: 2 })]));
  deposits = repo.listDeposits({ userId: user.id });
  assert.equal(deposits.length, 1, 'the same output must not create a second deposit row');
  assert.equal(deposits[0].status, 'completed');
  assert.equal(repo.getBalance(user.id, 'BTC').available, 100_000n);

  // The watcher re-sees confirmed transactions on every pass. It must never
  // credit them again — this is the property that keeps balances honest.
  for (const confirmations of [3, 10, 100]) {
    await scanChain(stubProvider('bitcoin', [btcDeposit(id.address, { confirmations })]));
  }
  assert.equal(repo.getBalance(user.id, 'BTC').available, 100_000n,
    'a re-observed deposit was credited more than once');
  assert.equal(repo.listDeposits({ userId: user.id }).length, 1);
});

test('two outputs in one transaction are credited separately', async () => {
  const id = await getDepositIdentity({ userExternalId: 'user-2', currency: 'BTC' });
  const user = repo.getUserByExternalId('user-2')!;
  const txid = 'b'.repeat(64);

  await scanChain(stubProvider('bitcoin', [
    btcDeposit(id.address, { txid, outputIndex: 0, amount: 50_000n, confirmations: 5 }),
    btcDeposit(id.address, { txid, outputIndex: 1, amount: 70_000n, confirmations: 5 }),
  ]));

  assert.equal(repo.listDeposits({ userId: user.id }).length, 2);
  assert.equal(repo.getBalance(user.id, 'BTC').available, 120_000n);
});

test('dust below the currency minimum is ignored', async () => {
  const id = await getDepositIdentity({ userExternalId: 'user-3', currency: 'BTC' });
  const user = repo.getUserByExternalId('user-3')!;

  // BTC minimum is 0.00005 (5000 sat).
  await scanChain(stubProvider('bitcoin', [
    btcDeposit(id.address, { txid: 'c'.repeat(64), amount: 100n, confirmations: 10 }),
  ]));

  assert.equal(repo.listDeposits({ userId: user.id }).length, 0);
  assert.equal(repo.getBalance(user.id, 'BTC').available, 0n);
});

test('a deposit to an address we never issued is not credited to anyone', async () => {
  const before = repo.listDeposits({}).length;
  await scanChain(stubProvider('bitcoin', [
    btcDeposit('bc1qunknownaddressnobodyissued00000000000', {
      txid: 'd'.repeat(64), confirmations: 10,
    }),
  ]));
  assert.equal(repo.listDeposits({}).length, before, 'an unattributable deposit created a row');
});

test('tag chains attribute by destination tag, not by address', async () => {
  const alice = await getDepositIdentity({ userExternalId: 'xrp-alice', currency: 'XRP' });
  const bob = await getDepositIdentity({ userExternalId: 'xrp-bob', currency: 'XRP' });
  assert.equal(alice.address, bob.address, 'XRP users should share the gateway address');
  assert.notEqual(alice.tag, bob.tag);

  const aliceUser = repo.getUserByExternalId('xrp-alice')!;
  const bobUser = repo.getUserByExternalId('xrp-bob')!;

  await scanChain(stubProvider('xrp', [
    { currency: 'XRP', address: alice.address, tag: alice.tag, txid: 'X1', outputIndex: 0,
      amount: 5_000_000n, confirmations: 1, blockHeight: 1 },
    { currency: 'XRP', address: bob.address, tag: bob.tag, txid: 'X2', outputIndex: 0,
      amount: 9_000_000n, confirmations: 1, blockHeight: 1 },
  ]));

  assert.equal(repo.getBalance(aliceUser.id, 'XRP').available, 5_000_000n);
  assert.equal(repo.getBalance(bobUser.id, 'XRP').available, 9_000_000n);
});

test('an XRP payment with no destination tag is not credited', async () => {
  const alice = await getDepositIdentity({ userExternalId: 'xrp-alice', currency: 'XRP' });
  const before = repo.listDeposits({}).length;

  await scanChain(stubProvider('xrp', [
    { currency: 'XRP', address: alice.address, tag: null, txid: 'X3', outputIndex: 0,
      amount: 5_000_000n, confirmations: 1, blockHeight: 2 },
  ]));

  assert.equal(repo.listDeposits({}).length, before);
});

test('the same user always gets the same address back', async () => {
  const first = await getDepositIdentity({ userExternalId: 'stable-user', currency: 'ETH' });
  const second = await getDepositIdentity({ userExternalId: 'stable-user', currency: 'ETH' });
  assert.equal(first.address, second.address);

  // ...and the ERC-20 shares it, because it settles on the same chain.
  const usdt = await getDepositIdentity({ userExternalId: 'stable-user', currency: 'USDTERC20' });
  assert.equal(usdt.address, first.address);
  assert.notEqual(usdt.currency, first.currency);
});

test('token and native deposits to one address stay separate currencies', async () => {
  const id = await getDepositIdentity({ userExternalId: 'multi-user', currency: 'ETH' });
  const user = repo.getUserByExternalId('multi-user')!;

  await scanChain(stubProvider('ethereum', [
    { currency: 'ETH', address: id.address, tag: null, txid: 'e'.repeat(64), outputIndex: 0,
      amount: 2_000_000_000_000_000_000n, confirmations: 20, blockHeight: 100 },
    { currency: 'USDTERC20', address: id.address, tag: null, txid: 'e'.repeat(64), outputIndex: 7,
      amount: 25_000_000n, confirmations: 20, blockHeight: 100 },
  ]));

  assert.equal(repo.getBalance(user.id, 'ETH').available, 2_000_000_000_000_000_000n);
  assert.equal(repo.getBalance(user.id, 'USDTERC20').available, 25_000_000n);
});

test('balances cannot be spent below zero', async () => {
  const id = await getDepositIdentity({ userExternalId: 'spend-user', currency: 'BTC' });
  const user = repo.getUserByExternalId('spend-user')!;
  await scanChain(stubProvider('bitcoin', [
    btcDeposit(id.address, { txid: 'f'.repeat(64), amount: 200_000n, confirmations: 6 }),
  ]));

  assert.equal(repo.debitBalance(user.id, 'BTC', 150_000n), true);
  assert.equal(repo.getBalance(user.id, 'BTC').available, 50_000n);
  assert.equal(repo.debitBalance(user.id, 'BTC', 60_000n), false, 'overdraft was allowed');
  assert.equal(repo.getBalance(user.id, 'BTC').available, 50_000n);
});

test('each user gets their own derivation index', async () => {
  await getDepositIdentity({ userExternalId: 'idx-a', currency: 'BTC' });
  await getDepositIdentity({ userExternalId: 'idx-b', currency: 'BTC' });
  const a = repo.getUserByExternalId('idx-a')!;
  const b = repo.getUserByExternalId('idx-b')!;
  assert.notEqual(a.derivation_index, b.derivation_index);
  // Index 0 is reserved for the gateway's own accounts.
  assert.ok(a.derivation_index >= 1 && b.derivation_index >= 1);
});
