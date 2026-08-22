import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { setupEnv } from './helpers';

setupEnv('api');

let server: Server;
let base: string;
let signRequest: typeof import('../src/api/auth').signRequest;

const PUB = 'testpublickey';
const PRIV = 'testprivatekey';

before(async () => {
  const { createServer } = await import('../src/api/server');
  ({ signRequest } = await import('../src/api/auth'));
  await import('../src/db/index').then((m) => m.getDb());

  server = createServer().listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

after(() => { server?.close(); });

/** Nonces are single-use, so each call needs a fresh one. */
let nonceCounter = Math.floor(Date.now() / 1000);
function authHeaders() {
  return signRequest(PUB, PRIV, nonceCounter++) as unknown as Record<string, string>;
}

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

test('health is reachable without credentials', async () => {
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json() as any).ok, true);
});

test('requests without credentials are rejected', async () => {
  const res = await fetch(base + '/currencies');
  assert.equal(res.status, 401);
});

test('a wrong signature is rejected', async () => {
  const res = await fetch(base + '/currencies', {
    headers: { 'X-API-KEY': PUB, 'X-Nonce': String(nonceCounter++), 'X-Signature': 'deadbeef' },
  });
  assert.equal(res.status, 401);
});

test('a signature from the wrong private key is rejected', async () => {
  const bad = signRequest(PUB, 'not-the-private-key', nonceCounter++) as unknown as Record<string, string>;
  const res = await fetch(base + '/currencies', { headers: bad });
  assert.equal(res.status, 401);
});

test('a replayed nonce is rejected', async () => {
  const nonce = nonceCounter++;
  const headers = signRequest(PUB, PRIV, nonce) as unknown as Record<string, string>;
  const first = await fetch(base + '/currencies', { headers });
  assert.equal(first.status, 200);
  // Same signature again — a captured request must not work twice.
  const second = await fetch(base + '/currencies', { headers });
  assert.equal(second.status, 401);
});

test('a stale nonce is rejected', async () => {
  const stale = Math.floor(Date.now() / 1000) - 99999;
  const headers = signRequest(PUB, PRIV, stale) as unknown as Record<string, string>;
  const res = await fetch(base + '/currencies', { headers });
  assert.equal(res.status, 401);
});

test('lists all 21 supported currencies', async () => {
  const { status, body } = await call('/currencies');
  assert.equal(status, 200);
  assert.equal(body.currencies.length, 21);

  const tickers = body.currencies.map((c: any) => c.currency);
  for (const expected of ['BTC', 'ETH', 'SOL', 'USDTTRC', 'USDTERC20', 'USDTBEP20', 'USDCTRC20',
    'TRX', 'XRP', 'BNB', 'EOS', 'XTZ', 'XMR', 'ZEC', 'BCH', 'BUSDBEP20', 'SHIBBEP20',
    'DOGE', 'LTC', 'XLM', 'DASH']) {
    assert.ok(tickers.includes(expected), `missing currency ${expected}`);
  }
});

test('generates a deposit address', async () => {
  const { status, body } = await call('/address/generate', {
    method: 'POST',
    body: JSON.stringify({ currency: 'BTC', label: 'api-user-1' }),
  });
  assert.equal(status, 200);
  assert.match(body.address, /^bc1/);
  assert.equal(body.currency, 'BTC');
  assert.equal(body.dest_tag, null);
  assert.equal(body.required_confirmations, 2);
});

test('address generation is idempotent for a user', async () => {
  const a = await call('/address/generate', {
    method: 'POST', body: JSON.stringify({ currency: 'LTC', label: 'api-user-2' }),
  });
  const b = await call('/address/generate', {
    method: 'POST', body: JSON.stringify({ currency: 'LTC', label: 'api-user-2' }),
  });
  assert.equal(a.body.address, b.body.address);
});

test('tag currencies return a destination tag', async () => {
  const { body } = await call('/address/generate', {
    method: 'POST', body: JSON.stringify({ currency: 'XRP', label: 'api-user-3' }),
  });
  assert.ok(body.dest_tag, 'XRP address must come with a destination tag');
  assert.equal(body.tag_name, 'destination_tag');
});

test('currency aliases resolve to the canonical ticker', async () => {
  for (const [alias, canonical] of [['USDT-TRC20', 'USDTTRC'], ['usdt.erc20', 'USDTERC20'],
    ['bitcoin', 'BTC'], ['ripple', 'XRP']]) {
    const { body } = await call('/address/generate', {
      method: 'POST', body: JSON.stringify({ currency: alias, label: 'alias-user' }),
    });
    assert.equal(body.currency, canonical, `${alias} should resolve to ${canonical}`);
  }
});

test('an unsupported currency is a clean 400', async () => {
  const { status, body } = await call('/address/generate', {
    method: 'POST', body: JSON.stringify({ currency: 'NOTACOIN', label: 'x' }),
  });
  assert.equal(status, 400);
  assert.match(body.message, /unsupported currency/);
});

test('address generation works without a label, as WestWallet does', async () => {
  // client.generateAddress("BTC") sends only a currency, and the caller keeps
  // its own address-to-user mapping. Each unlabelled call gets a fresh address.
  const first = await call('/address/generate', {
    method: 'POST', body: JSON.stringify({ currency: 'BTC' }),
  });
  assert.equal(first.status, 200);
  assert.match(first.body.address, /^bc1/);

  const second = await call('/address/generate', {
    method: 'POST', body: JSON.stringify({ currency: 'BTC' }),
  });
  assert.notEqual(second.body.address, first.body.address);
});

test('balance for a fresh user is zero', async () => {
  await call('/address/generate', {
    method: 'POST', body: JSON.stringify({ currency: 'BTC', label: 'bal-user' }),
  });
  const { status, body } = await call('/wallet/balance?currency=BTC&label=bal-user');
  assert.equal(status, 200);
  assert.equal(body.balance, '0');
});

test('currency_info describes the asset', async () => {
  const { body } = await call('/wallet/currency_info?currency=USDTTRC');
  assert.equal(body.currency, 'USDTTRC');
  assert.equal(body.blockchain, 'tron');
  assert.equal(body.kind, 'token');
  assert.equal(body.decimals, 6);
  assert.ok(body.contract);
});

test('a withdrawal without balance is refused', async () => {
  await call('/address/generate', {
    method: 'POST', body: JSON.stringify({ currency: 'BTC', label: 'wd-user' }),
  });
  const { status, body } = await call('/wallet/send', {
    method: 'POST',
    body: JSON.stringify({ currency: 'BTC', amount: '1.0', address: 'bc1qxyz', label: 'wd-user' }),
  });
  assert.equal(status, 400);
  assert.match(body.message, /insufficient/);
});

test('an unknown transaction id is a 404', async () => {
  const { status } = await call('/wallet/transaction?id=does-not-exist');
  assert.equal(status, 404);
});
