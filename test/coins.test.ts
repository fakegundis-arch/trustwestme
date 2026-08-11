import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers';

setupEnv('coins');

/**
 * Deposit coverage for the chains that do not follow the plain
 * "one derived address per user" pattern: BNB (EVM native), XMR (subaddresses
 * from a wallet daemon) and the three tag/memo chains XRP, XLM and EOS.
 *
 * Each test drives the real attribution and crediting pipeline; only the chain
 * observation itself is stubbed.
 */

type RawDeposit = import('../src/watcher/types').RawDeposit;
type ChainProvider = import('../src/watcher/types').ChainProvider;

let repo: typeof import('../src/db/repo');
let scanChain: typeof import('../src/watcher/index').scanChain;
let getDepositIdentity: typeof import('../src/services/addresses').getDepositIdentity;

before(async () => {
  repo = await import('../src/db/repo');
  ({ scanChain } = await import('../src/watcher/index'));
  ({ getDepositIdentity } = await import('../src/services/addresses'));
});

const stub = (chain: string, deposits: RawDeposit[]): ChainProvider =>
  ({ chain, async scan() { return { deposits, cursor: null }; } });

test('BNB deposits credit on BSC', async () => {
  const id = await getDepositIdentity({ userExternalId: 'bnb-user', currency: 'BNB' });
  const user = repo.getUserByExternalId('bnb-user')!;
  assert.equal(id.chain, 'bsc');
  assert.match(id.address, /^0x[0-9a-fA-F]{40}$/);

  // BSC needs 15 confirmations — 3 is not enough.
  await scanChain(stub('bsc', [{
    currency: 'BNB', address: id.address, tag: null, txid: '0xbnb1', outputIndex: 0,
    amount: 2_000_000_000_000_000_000n, confirmations: 3, blockHeight: 100,
  }]));
  assert.equal(repo.getBalance(user.id, 'BNB').available, 0n);

  await scanChain(stub('bsc', [{
    currency: 'BNB', address: id.address, tag: null, txid: '0xbnb1', outputIndex: 0,
    amount: 2_000_000_000_000_000_000n, confirmations: 15, blockHeight: 100,
  }]));
  assert.equal(repo.getBalance(user.id, 'BNB').available, 2_000_000_000_000_000_000n);
});

test('BNB and BEP-20 tokens share one address but credit separately', async () => {
  const bnb = await getDepositIdentity({ userExternalId: 'bep-user', currency: 'BNB' });
  const usdt = await getDepositIdentity({ userExternalId: 'bep-user', currency: 'USDTBEP20' });
  const shib = await getDepositIdentity({ userExternalId: 'bep-user', currency: 'SHIBBEP20' });
  assert.equal(bnb.address, usdt.address);
  assert.equal(bnb.address, shib.address);

  const user = repo.getUserByExternalId('bep-user')!;
  await scanChain(stub('bsc', [
    { currency: 'BNB', address: bnb.address, tag: null, txid: '0xmix', outputIndex: 0,
      amount: 1_000_000_000_000_000_000n, confirmations: 20, blockHeight: 200 },
    { currency: 'USDTBEP20', address: bnb.address, tag: null, txid: '0xmix', outputIndex: 5,
      amount: 50_000_000_000_000_000_000n, confirmations: 20, blockHeight: 200 },
    { currency: 'SHIBBEP20', address: bnb.address, tag: null, txid: '0xmix', outputIndex: 6,
      amount: 900_000_000_000_000_000_000_000n, confirmations: 20, blockHeight: 200 },
  ]));

  assert.equal(repo.getBalance(user.id, 'BNB').available, 1_000_000_000_000_000_000n);
  assert.equal(repo.getBalance(user.id, 'USDTBEP20').available, 50_000_000_000_000_000_000n);
  assert.equal(repo.getBalance(user.id, 'SHIBBEP20').available, 900_000_000_000_000_000_000_000n);
});

test('XRP deposits credit by destination tag', async () => {
  const id = await getDepositIdentity({ userExternalId: 'xrp-u', currency: 'XRP' });
  const user = repo.getUserByExternalId('xrp-u')!;
  assert.ok(id.tag, 'XRP must issue a destination tag');
  assert.equal(id.tagName, 'destination_tag');

  await scanChain(stub('xrp', [{
    currency: 'XRP', address: id.address, tag: id.tag, txid: 'XRPTX1', outputIndex: 0,
    amount: 25_000_000n, confirmations: 1, blockHeight: 90_000_000,
  }]));
  assert.equal(repo.getBalance(user.id, 'XRP').available, 25_000_000n);
});

test('XLM deposits credit by memo', async () => {
  const id = await getDepositIdentity({ userExternalId: 'xlm-u', currency: 'XLM' });
  const user = repo.getUserByExternalId('xlm-u')!;
  assert.ok(id.tag, 'XLM must issue a memo');
  assert.equal(id.tagName, 'memo');

  await scanChain(stub('stellar', [{
    currency: 'XLM', address: id.address, tag: id.tag, txid: 'XLMTX1', outputIndex: 0,
    amount: 150_000_000n, confirmations: 1, blockHeight: null,
  }]));
  assert.equal(repo.getBalance(user.id, 'XLM').available, 150_000_000n);
});

test('EOS deposits credit by memo', async () => {
  const id = await getDepositIdentity({ userExternalId: 'eos-u', currency: 'EOS' });
  const user = repo.getUserByExternalId('eos-u')!;
  assert.ok(id.tag, 'EOS must issue a memo');
  assert.equal(id.address, process.env.EOS_ACCOUNT);

  await scanChain(stub('eos', [{
    currency: 'EOS', address: id.address, tag: id.tag, txid: 'EOSTX1', outputIndex: 0,
    amount: 100_000n, confirmations: 1, blockHeight: 300,
  }]));
  assert.equal(repo.getBalance(user.id, 'EOS').available, 100_000n);
});

test('tag chains never cross-credit between users', async () => {
  const a = await getDepositIdentity({ userExternalId: 'memo-a', currency: 'XLM' });
  const b = await getDepositIdentity({ userExternalId: 'memo-b', currency: 'XLM' });
  const ua = repo.getUserByExternalId('memo-a')!;
  const ub = repo.getUserByExternalId('memo-b')!;

  await scanChain(stub('stellar', [{
    currency: 'XLM', address: a.address, tag: a.tag, txid: 'XLMTX2', outputIndex: 0,
    amount: 70_000_000n, confirmations: 1, blockHeight: null,
  }]));

  assert.equal(repo.getBalance(ua.id, 'XLM').available, 70_000_000n);
  assert.equal(repo.getBalance(ub.id, 'XLM').available, 0n, 'the wrong user was credited');
});

test('XMR deposits credit to the right subaddress', async () => {
  // Monero addresses come from monero-wallet-rpc, which is not running in
  // tests, so the subaddress is registered directly. Everything after that is
  // the same code path the live watcher uses.
  const user = repo.getOrCreateUser('xmr-user');
  const subaddress = '8AnCkTVeCa2ZKCEmVCbGGgHXHfhqmgHhRRZaJgAoTJgTuvUWFNKJLPUeXbfDBoxLPTuJdCHNAtqqLYmLZxCWNzY9SbEXAmp';
  repo.saveAddress({
    userId: user.id, chain: 'monero', address: subaddress, tag: null,
    path: 'subaddress:1', ipnUrl: null,
  });

  // Monero needs 10 confirmations.
  await scanChain(stub('monero', [{
    currency: 'XMR', address: subaddress, tag: null, txid: 'XMRTX1', outputIndex: 1,
    amount: 500_000_000_000n, confirmations: 2, blockHeight: 3_000_000,
  }]));
  assert.equal(repo.getBalance(user.id, 'XMR').available, 0n, 'credited before confirming');

  await scanChain(stub('monero', [{
    currency: 'XMR', address: subaddress, tag: null, txid: 'XMRTX1', outputIndex: 1,
    amount: 500_000_000_000n, confirmations: 10, blockHeight: 3_000_000,
  }]));
  assert.equal(repo.getBalance(user.id, 'XMR').available, 500_000_000_000n);

  // And re-seeing it must not credit twice.
  await scanChain(stub('monero', [{
    currency: 'XMR', address: subaddress, tag: null, txid: 'XMRTX1', outputIndex: 1,
    amount: 500_000_000_000n, confirmations: 50, blockHeight: 3_000_000,
  }]));
  assert.equal(repo.getBalance(user.id, 'XMR').available, 500_000_000_000n);
});

test('all six chains in question have a registered watcher', async () => {
  const { buildProviders } = await import('../src/watcher/index');
  const chains = buildProviders().map((p) => p.chain);
  for (const chain of ['bsc', 'xrp', 'stellar', 'eos', 'monero']) {
    assert.ok(chains.includes(chain), `no watcher registered for ${chain}`);
  }
});
