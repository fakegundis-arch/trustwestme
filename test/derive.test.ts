import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers';

setupEnv('derive');

// Imported lazily in `before`, after the environment above is in place.
let deriveIdentity: typeof import('../src/wallet/derive').deriveIdentity;
let CHAINS: typeof import('../src/chains').CHAINS;

before(async () => {
  ({ deriveIdentity } = await import('../src/wallet/derive'));
  ({ CHAINS } = await import('../src/chains'));
});

test('derives the published BIP39 vectors for Bitcoin and Ethereum', async () => {
  // These two addresses are canonical test vectors for this mnemonic. If
  // wallet-core ever changes derivation behaviour, this test catches it before
  // real deposits go to addresses nobody holds keys for.
  const btc = await deriveIdentity('bitcoin', 0);
  assert.equal(btc.address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');

  const eth = await deriveIdentity('ethereum', 0);
  assert.equal(eth.address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
});

test('every per-user chain gives a distinct address per index', async () => {
  const perUserChains = Object.values(CHAINS)
    .filter((c) => c.addressMode === 'derived')
    .map((c) => c.id);

  assert.ok(perUserChains.length >= 11, 'expected the derived chains to be present');

  for (const chain of perUserChains) {
    const a = await deriveIdentity(chain, 1);
    const b = await deriveIdentity(chain, 2);
    assert.ok(a.address.length > 0, `${chain} produced an empty address`);
    assert.notEqual(a.address, b.address, `${chain} reused one address for two users`);
  }
});

test('derivation is deterministic — the same index always gives the same address', async () => {
  for (const chain of ['bitcoin', 'ethereum', 'tron', 'solana', 'litecoin', 'tezos']) {
    const first = await deriveIdentity(chain, 7);
    const second = await deriveIdentity(chain, 7);
    assert.equal(first.address, second.address, `${chain} derivation is not stable`);
  }
});

test('Ethereum and BSC share one address but stay separate chains', async () => {
  const eth = await deriveIdentity('ethereum', 5);
  const bsc = await deriveIdentity('bsc', 5);
  assert.equal(eth.address, bsc.address);
  assert.notEqual(eth.chain, bsc.chain);
});

test('tag chains return the shared address plus a per-user tag', async () => {
  const xrp = await deriveIdentity('xrp', 42);
  assert.equal(xrp.address, process.env.XRP_ADDRESS);
  assert.equal(xrp.tag, '42');

  const xlm = await deriveIdentity('stellar', 43);
  assert.equal(xlm.tag, '43');

  // Two users share the address but never the tag.
  const other = await deriveIdentity('xrp', 44);
  assert.equal(other.address, xrp.address);
  assert.notEqual(other.tag, xrp.tag);
});

test('addresses look like the format each chain expects', async () => {
  const cases: [string, RegExp][] = [
    ['bitcoin', /^bc1[a-z0-9]{20,}$/],
    ['litecoin', /^ltc1[a-z0-9]{20,}$/],
    ['dogecoin', /^D[1-9A-HJ-NP-Za-km-z]{25,}$/],
    ['dash', /^X[1-9A-HJ-NP-Za-km-z]{25,}$/],
    ['bitcoincash', /^bitcoincash:[qp][a-z0-9]{38,}$/],
    ['zcash', /^t1[1-9A-HJ-NP-Za-km-z]{25,}$/],
    ['ethereum', /^0x[0-9a-fA-F]{40}$/],
    ['bsc', /^0x[0-9a-fA-F]{40}$/],
    ['tron', /^T[1-9A-HJ-NP-Za-km-z]{33}$/],
    ['solana', /^[1-9A-HJ-NP-Za-km-z]{32,44}$/],
    ['tezos', /^tz[123][1-9A-HJ-NP-Za-km-z]{33}$/],
  ];

  for (const [chain, pattern] of cases) {
    const { address } = await deriveIdentity(chain, 3);
    assert.match(address, pattern, `${chain} address ${address} does not match its expected format`);
  }
});

test('rejects an out-of-range derivation index', async () => {
  await assert.rejects(() => deriveIdentity('bitcoin', -1));
  await assert.rejects(() => deriveIdentity('bitcoin', 1.5));
});
