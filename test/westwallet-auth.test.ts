import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { setupEnv } from './helpers';

setupEnv('wwauth');

/**
 * Compatibility with the official WestWallet SDKs.
 *
 * Their Python client signs like this:
 *
 *   sign = hmac.new(secret_key.encode('utf-8'),
 *                   "{}{}".format(timestamp, dumped).encode('utf-8'),
 *                   hashlib.sha256).hexdigest()
 *
 * with headers X-API-KEY, X-ACCESS-SIGN and X-ACCESS-TIMESTAMP. These tests
 * reproduce that byte-for-byte, including Python's json.dumps spacing, so an
 * existing integration is known to work rather than assumed to.
 */

const PUB = 'testpublickey';
const PRIV = 'testprivatekey';

let server: Server;
let base: string;

before(async () => {
  const { createServer } = await import('../src/api/server');
  await import('../src/db/index').then((m) => m.getDb());
  server = createServer().listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => { server?.close(); });

/** Exactly what the SDKs compute. */
function sign(timestamp: number, dumped: string, secret = PRIV): string {
  return createHmac('sha256', secret).update(`${timestamp}${dumped}`, 'utf8').digest('hex');
}

async function post(path: string, bodyObject: unknown, opts: { secret?: string; skew?: number } = {}) {
  // The body is serialised ONCE and both signed and sent, exactly as a client does.
  const dumped = JSON.stringify(bodyObject);
  const ts = Math.floor(Date.now() / 1000) + (opts.skew ?? 0);
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-API-KEY': PUB,
      'X-ACCESS-TIMESTAMP': String(ts),
      'X-ACCESS-SIGN': sign(ts, dumped, opts.secret ?? PRIV),
    },
    body: dumped,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

test('accepts a WestWallet-signed address generation call', async () => {
  const { status, body } = await post('/address/generate', { currency: 'BTC' });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.match(body.address, /^bc1/);
  assert.equal(body.currency, 'BTC');
});

test('generateAddress works with no label, as the SDKs call it', async () => {
  // client.generateAddress("BTC") sends only a currency.
  const { status, body } = await post('/address/generate', { currency: 'ETH' });
  assert.equal(status, 200);
  assert.match(body.address, /^0x[0-9a-fA-F]{40}$/);
});

test('a label still pins the address to one user', async () => {
  const a = await post('/address/generate', { currency: 'BTC', label: 'ww-user-1' });
  const b = await post('/address/generate', { currency: 'BTC', label: 'ww-user-1' });
  assert.equal(a.status, 200);
  assert.equal(a.body.address, b.body.address);
});

test('two unlabelled calls get different addresses', async () => {
  const a = await post('/address/generate', { currency: 'LTC' });
  const b = await post('/address/generate', { currency: 'LTC' });
  assert.notEqual(a.body.address, b.body.address);
});

test('rejects a signature made with the wrong secret', async () => {
  const { status } = await post('/address/generate', { currency: 'BTC' }, { secret: 'wrong-secret' });
  assert.equal(status, 401);
});

test('rejects a stale timestamp', async () => {
  const { status, body } = await post('/address/generate', { currency: 'BTC' }, { skew: -99999 });
  assert.equal(status, 401);
  assert.match(body.message, /timestamp/);
});

test("verifies against Python's json.dumps spacing", async () => {
  // Python's json.dumps({"currency": "BTC"}) produces '{"currency": "BTC"}'
  // — note the space. The signature must still verify.
  const dumped = '{"currency": "BTC", "label": "python-style"}';
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(base + '/address/generate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-API-KEY': PUB,
      'X-ACCESS-TIMESTAMP': String(ts),
      'X-ACCESS-SIGN': sign(ts, dumped),
    },
    body: dumped,
  });
  assert.equal(res.status, 200);
});

test('verifies a GET request signed over its query parameters', async () => {
  const ts = Math.floor(Date.now() / 1000);
  // A GET signs the JSON dump of its query parameters.
  const dumped = JSON.stringify({ currency: 'BTC' });
  const res = await fetch(base + '/wallet/balance?currency=BTC', {
    headers: {
      'X-API-KEY': PUB,
      'X-ACCESS-TIMESTAMP': String(ts),
      'X-ACCESS-SIGN': sign(ts, dumped),
    },
  });
  assert.equal(res.status, 200, `GET signature verification failed (${res.status})`);
});

test("verifies a GET signed with Python's spacing too", async () => {
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(base + '/wallet/balance?currency=BTC', {
    headers: {
      'X-API-KEY': PUB,
      'X-ACCESS-TIMESTAMP': String(ts),
      'X-ACCESS-SIGN': sign(ts, '{"currency": "BTC"}'),
    },
  });
  assert.equal(res.status, 200);
});

test('serves the endpoint names the SDKs use', async () => {
  // POST /wallet/transaction, not just GET.
  const tx = await post('/wallet/transaction', { id: 'nope' });
  assert.equal(tx.status, 404, 'POST /wallet/transaction should reach the handler');

  // /wallet/create_withdrawal is the SDK name for sending funds.
  const wd = await post('/wallet/create_withdrawal', {
    currency: 'BTC', amount: '0.001', address: 'bc1qexample',
  });
  assert.equal(wd.status, 200, `create_withdrawal returned ${wd.status}`);
  assert.equal(wd.body.type, 'withdrawal');
});

test('the older nonce scheme still works alongside it', async () => {
  const { signRequest } = await import('../src/api/auth');
  const headers = signRequest(PUB, PRIV, Math.floor(Date.now() / 1000)) as unknown as Record<string, string>;
  const res = await fetch(base + '/currencies', { headers });
  assert.equal(res.status, 200, 'auto mode should still accept X-Nonce/X-Signature');
});

test('a request with no auth headers at all is refused', async () => {
  const res = await fetch(base + '/currencies', { headers: { 'X-API-KEY': PUB } });
  assert.equal(res.status, 401);
  const body = await res.json() as any;
  assert.match(body.message, /X-ACCESS-SIGN/);
});
