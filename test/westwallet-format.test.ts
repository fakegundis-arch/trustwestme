import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { setupEnv } from './helpers';

setupEnv('wwformat');

/**
 * Response-shape compatibility.
 *
 * The WestWallet clients decide success with `if (response.error != "ok")`, and
 * their transaction model declares `id` as an integer. Both are easy to get
 * wrong in ways that produce a 200 the caller still rejects, so they are
 * pinned here.
 */

const PUB = 'testpublickey';
const PRIV = 'testprivatekey';

let server: Server;
let base: string;
let repo: typeof import('../src/db/repo');

before(async () => {
  const { createServer } = await import('../src/api/server');
  repo = await import('../src/db/repo');
  await import('../src/db/index').then((m) => m.getDb());
  server = createServer().listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => { server?.close(); });

async function post(path: string, bodyObject: unknown) {
  const dumped = JSON.stringify(bodyObject);
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-API-KEY': PUB,
      'X-ACCESS-TIMESTAMP': String(ts),
      'X-ACCESS-SIGN': createHmac('sha256', PRIV).update(`${ts}${dumped}`, 'utf8').digest('hex'),
    },
    body: dumped,
  });
  return { status: res.status, body: await res.json() as any };
}

async function get(path: string) {
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(base + path, {
    headers: {
      'X-API-KEY': PUB,
      'X-ACCESS-TIMESTAMP': String(ts),
      'X-ACCESS-SIGN': createHmac('sha256', PRIV).update(`${ts}`, 'utf8').digest('hex'),
    },
  });
  return { status: res.status, body: await res.json() as any };
}

test('a successful response says error:"ok"', async () => {
  // Their clients treat anything else as a failure, so this one field decides
  // whether a working call looks working.
  const { status, body } = await post('/address/generate', { currency: 'BTC', label: 'fmt-1' });
  assert.equal(status, 200);
  assert.equal(body.error, 'ok');
});

test('every endpoint sets error:"ok"', async () => {
  for (const path of ['/currencies', '/wallet/balances', '/wallet/balance?currency=BTC',
    '/wallet/transactions', '/status']) {
    const { status, body } = await get(path);
    assert.equal(status, 200, `${path} returned ${status}`);
    assert.equal(body.error, 'ok', `${path} did not report error:"ok"`);
  }
});

test('a failure reports a non-"ok" error', async () => {
  const { body } = await post('/address/generate', { currency: 'NOTACOIN', label: 'x' });
  assert.notEqual(body.error, 'ok');
  assert.equal(typeof body.error, 'string');
});

test('address generation returns the documented fields', async () => {
  const { body } = await post('/address/generate', { currency: 'XRP', label: 'fmt-2' });
  // APIAddress: address, dest_tag, currency, label, error
  for (const field of ['address', 'dest_tag', 'currency', 'label', 'error']) {
    assert.ok(field in body, `missing field ${field}`);
  }
  assert.equal(typeof body.address, 'string');
  assert.equal(body.currency, 'XRP');
});

test('balance returns the documented fields', async () => {
  const { body } = await get('/wallet/balance?currency=BTC');
  // APIBalance: balance, currency, error
  for (const field of ['balance', 'currency', 'error']) {
    assert.ok(field in body, `missing field ${field}`);
  }
  assert.equal(typeof body.balance, 'string', 'balance must be a string, not a float');
});

test('a transaction id is a number, as the SDKs declare it', async () => {
  const user = repo.getOrCreateUser('fmt-tx-user');
  repo.saveAddress({
    userId: user.id, chain: 'bitcoin', address: 'bc1qformattest0000000000',
    tag: null, path: "m/84'/0'/0'/0/1", ipnUrl: null,
  });
  repo.recordDeposit({
    userId: user.id, addressId: repo.getAddress(user.id, 'bitcoin')!.id,
    chain: 'bitcoin', currency: 'BTC', address: 'bc1qformattest0000000000',
    tag: null, txid: 'fmttx1', outputIndex: 0, amountUnits: 500_000n,
    confirmations: 5, blockHeight: 1, status: 'completed',
  });

  const { body } = await get('/wallet/transactions');
  assert.ok(Array.isArray(body.transactions));
  const tx = body.transactions[0];
  assert.equal(typeof tx.id, 'number', 'id must be numeric — Go declares it as int');
  assert.equal(typeof tx.uid, 'string', 'the UUID should still be available as uid');

  // APITransaction fields
  for (const field of ['id', 'amount', 'address', 'dest_tag', 'currency', 'status',
    'type', 'blockchain_confirmations', 'blockchain_hash']) {
    assert.ok(field in tx, `transaction is missing ${field}`);
  }
  assert.equal(typeof tx.amount, 'string', 'amount must be a string to avoid float error');
  assert.equal(typeof tx.blockchain_confirmations, 'number');
});

test('a transaction can be fetched by its numeric id', async () => {
  const list = await get('/wallet/transactions');
  const tx = list.body.transactions[0];

  const byNumber = await post('/wallet/transaction', { id: tx.id });
  assert.equal(byNumber.status, 200, 'numeric id lookup failed');
  assert.equal(byNumber.body.id, tx.id);

  // The UUID must keep working too.
  const byUuid = await post('/wallet/transaction', { id: tx.uid });
  assert.equal(byUuid.status, 200, 'uuid lookup failed');
  assert.equal(byUuid.body.id, tx.id);
});

test('the transactions list is offered under several keys', async () => {
  const { body } = await get('/wallet/transactions');
  // `transactions` at the root is the one the yukitale exchange reads; the
  // others cover clients that wrap the list differently.
  assert.ok(Array.isArray(body.transactions));
  assert.ok(Array.isArray(body.result));
  assert.ok(Array.isArray(body.data?.transactions));
  assert.equal(body.transactions.length, body.result.length);
  assert.equal(body.transactions.length, body.data.transactions.length);
  assert.equal(typeof body.count, 'number');
});

test('a top-level status:"ok" is added where there is none', async () => {
  const { body } = await post('/address/generate', { currency: 'BTC', label: 'status-1' });
  assert.equal(body.status, 'ok');
  assert.equal(body.error, 'ok');
});

test("a transaction's own status is never overwritten with ok", async () => {
  // The injected top-level status must not clobber a real one. If it did, a
  // settled deposit would report "ok" instead of "completed" and the caller
  // would never credit it.
  const list = await get('/wallet/transactions');
  const tx = list.body.transactions[0];
  assert.ok(['pending', 'completed', 'created', 'error', 'orphaned'].includes(tx.status),
    `transaction status was clobbered: ${tx.status}`);

  const single = await post('/wallet/transaction', { id: tx.id });
  assert.equal(single.body.status, tx.status);
  assert.notEqual(single.body.status, 'ok', 'the transaction status was replaced by the wrapper');
});

test('an error response does not claim status:"ok"', async () => {
  const { status, body } = await post('/address/generate', { currency: 'NOTACOIN' });
  assert.equal(status, 400);
  assert.notEqual(body.status, 'ok', 'a failure must not report status "ok"');
  assert.notEqual(body.error, 'ok');
});

test('the fields the exchange reads are all present on a transaction', async () => {
  const { body } = await get('/wallet/transactions');
  const tx = body.transactions[0];
  // Read out of each transaction by WestWalletService.
  for (const field of ['address', 'amount', 'currency', 'status', 'blockchain_hash', 'dest_tag']) {
    assert.ok(field in tx, `transaction is missing ${field}`);
  }
  // status is compared against the literal "completed", so that spelling matters.
  const settled = body.transactions.filter((t: any) => t.status === 'completed');
  assert.ok(settled.length > 0, 'expected at least one completed transaction in the fixture');
});

test('deposit and withdrawal types match the SDK vocabulary', async () => {
  const { body } = await get('/wallet/transactions');
  for (const tx of body.transactions) {
    assert.ok(['deposit', 'withdrawal'].includes(tx.type));
    assert.ok(['pending', 'completed', 'created', 'error', 'orphaned'].includes(tx.status));
  }
});
