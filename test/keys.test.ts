import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers';

setupEnv('keys');

/**
 * Key export correctness.
 *
 * An exported key that does not actually control its address is worse than no
 * export at all — it looks like recovery and loses the funds. So every format
 * is checked by importing it back and confirming it reproduces the address.
 */

let exportPrivateKey: typeof import('../src/wallet/keys').exportPrivateKey;
let deriveIdentity: typeof import('../src/wallet/derive').deriveIdentity;
let core: any;

before(async () => {
  ({ exportPrivateKey } = await import('../src/wallet/keys'));
  ({ deriveIdentity } = await import('../src/wallet/derive'));
  core = await (await import('../src/wallet/core')).getCore();
});

test('an exported WIF controls the address it came from', async () => {
  for (const chain of ['bitcoin', 'litecoin', 'dogecoin', 'dash', 'bitcoincash', 'zcash']) {
    const exported = await exportPrivateKey(chain, 1);
    assert.ok(exported.wif, `${chain} produced no WIF`);

    // Decode the WIF and rebuild the address from it.
    const decoded = core.Base58.decode(exported.wif!);
    assert.ok(decoded, `${chain} WIF failed its checksum`);
    // version || 32-byte key || 0x01
    assert.equal(decoded.length, 34, `${chain} WIF has the wrong payload length`);
    const keyBytes = decoded.slice(1, 33);

    const key = core.PrivateKey.createWithData(keyBytes);
    const coinName = chain === 'bitcoincash' ? 'bitcoinCash' : chain;
    const coin = (core.CoinType as any)[coinName];
    const rebuilt = core.AnyAddress
      .createWithPublicKey(key.getPublicKeySecp256k1(true), coin).description();

    assert.equal(rebuilt, exported.address,
      `${chain}: the exported WIF does not control ${exported.address}`);
  }
});

test('an exported EVM key controls its address', async () => {
  for (const chain of ['ethereum', 'bsc']) {
    const exported = await exportPrivateKey(chain, 2);
    assert.match(exported.hex, /^0x[0-9a-f]{64}$/, `${chain} hex key is malformed`);

    const keyBytes = core.HexCoding.decode(exported.hex);
    const key = core.PrivateKey.createWithData(keyBytes);
    const coin = chain === 'bsc' ? core.CoinType.smartChain : core.CoinType.ethereum;
    const rebuilt = core.AnyAddress
      .createWithPublicKey(key.getPublicKeySecp256k1(false), coin).description();

    assert.equal(rebuilt.toLowerCase(), exported.address.toLowerCase(),
      `${chain}: the exported key does not control ${exported.address}`);
  }
});

test('an exported Tron key controls its address', async () => {
  const exported = await exportPrivateKey('tron', 3);
  const key = core.PrivateKey.createWithData(core.HexCoding.decode(exported.hex));
  const rebuilt = core.AnyAddress
    .createWithPublicKey(key.getPublicKeySecp256k1(false), core.CoinType.tron).description();
  assert.equal(rebuilt, exported.address);
});

test('an exported Solana secret controls its address', async () => {
  const exported = await exportPrivateKey('solana', 4);
  assert.ok(exported.base58, 'no base58 secret for Solana');
  const decoded = core.Base58.decodeNoCheck(exported.base58!);
  assert.equal(decoded.length, 64, 'a Solana secret key is 64 bytes: private then public');

  const key = core.PrivateKey.createWithData(decoded.slice(0, 32));
  const rebuilt = core.AnyAddress
    .createWithPublicKey(key.getPublicKeyEd25519(), core.CoinType.solana).description();
  assert.equal(rebuilt, exported.address);
});

test('the export reports the path it used, so it can be reproduced by hand', async () => {
  const exported = await exportPrivateKey('bitcoin', 7);
  const identity = await deriveIdentity('bitcoin', 7);
  assert.equal(exported.path, identity.path);
  assert.equal(exported.address, identity.address);
  assert.match(exported.path, /^m\/84'\/0'\/0'\/0\/7$/);
});

test('different indexes export different keys', async () => {
  const a = await exportPrivateKey('bitcoin', 1);
  const b = await exportPrivateKey('bitcoin', 2);
  assert.notEqual(a.hex, b.hex);
  assert.notEqual(a.address, b.address);
});

test('chains without a per-user key say so instead of returning something wrong', async () => {
  // XRP, XLM and EOS share one gateway account, so there is no per-user key.
  for (const chain of ['xrp', 'stellar', 'eos']) {
    await assert.rejects(() => exportPrivateKey(chain, 1), /gateway account|per-user key/,
      `${chain} should refuse a per-user export`);
  }
  // Monero's keys live in the wallet daemon, not the seed.
  await assert.rejects(() => exportPrivateKey('monero', 1), /monero-wallet-rpc/);
});
