import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { setupEnv } from './helpers';

setupEnv('fallback');

/**
 * What happens when Blockbook refuses a chain outright, as Trezor's public
 * instances do for some servers. Blockchair has to take over, and the change
 * from our own sweeps must not be credited as a fresh deposit — Blockchair
 * reports outputs without inputs, so a self-send cannot be spotted from the
 * response alone.
 */

let blockbookHits = 0;
let blockchairHits = 0;
let servers: { close: () => void }[] = [];

const DEPOSIT_TXID = 'aa'.repeat(32);
const OUR_SWEEP_TXID = 'bb'.repeat(32);

function start(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push({ close: () => s.close() });
  return new Promise((r) => s.listen(0, '127.0.0.1',
    () => r(`http://127.0.0.1:${(s.address() as any).port}`)));
}

let repo: typeof import('../src/db/repo');
let scanChain: typeof import('../src/watcher/index').scanChain;
let blockbookProvider: typeof import('../src/watcher/providers/blockbook').blockbookProvider;
let address: string;

before(async () => {
  // Blockbook stands in for Trezor refusing with a Cloudflare block page.
  const blockbook = await start((_req, res) => {
    blockbookHits++;
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<!DOCTYPE html><html><head><title>Attention Required</title></head></html>');
  });

  // Blockchair answers with the outputs paying the address: one genuine
  // deposit, plus the change from a sweep this gateway itself broadcast.
  const blockchair = await start((req, res) => {
    blockchairHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: [
        { block_id: 900000, transaction_hash: DEPOSIT_TXID, index: 0, value: 250000, recipient: 'x' },
        { block_id: 900010, transaction_hash: OUR_SWEEP_TXID, index: 1, value: 90000, recipient: 'x' },
      ],
      context: { state: 900020 },
    }));
    void req;
  });

  process.env.LTC_BLOCKBOOK_URL = blockbook;
  process.env.BLOCKCHAIR_API_URL = blockchair;
  process.env.BLOCKCHAIR_RPS = '50'; // do not slow the test down

  repo = await import('../src/db/repo');
  ({ scanChain } = await import('../src/watcher/index'));
  ({ blockbookProvider } = await import('../src/watcher/providers/blockbook'));

  const { getDepositIdentity } = await import('../src/services/addresses');
  const identity = await getDepositIdentity({ userExternalId: 'fallback-user', currency: 'LTC' });
  address = identity.address;
});

after(() => { for (const s of servers) s.close(); });

test('a refused Blockbook falls through to Blockchair', async () => {
  const { config } = await import('../src/config');
  const provider = blockbookProvider('litecoin', config.rpc.litecoin);

  const result = await scanChain(provider);
  assert.ok(blockbookHits > 0, 'blockbook was never tried');
  assert.ok(blockchairHits > 0, 'blockchair was never used as a fallback');

  const user = repo.getUserByExternalId('fallback-user')!;
  const deposits = repo.listDeposits({ userId: user.id });
  assert.ok(deposits.length > 0, 'the fallback produced no deposits');
  assert.equal(deposits[0].currency, 'LTC');
  assert.equal(deposits[0].address, address);
  void result;
});

test('change from our own sweep is not credited as a deposit', async () => {
  const user = repo.getUserByExternalId('fallback-user')!;

  // Record the sweep, exactly as /withdraw does after broadcasting.
  repo.recordSentTransaction({
    currency: 'LTC', chain: 'litecoin', address: 'ltc1qsomewhereelse',
    tag: null, amountUnits: 500000n, txid: OUR_SWEEP_TXID,
    description: 'test sweep',
  });
  assert.equal(repo.isOwnTransaction('litecoin', OUR_SWEEP_TXID), true);
  assert.equal(repo.isOwnTransaction('litecoin', DEPOSIT_TXID), false);

  // Clear what the first scan stored so this pass starts clean.
  const before = repo.listDeposits({ userId: user.id });
  for (const d of before) {
    (await import('../src/db/index')).getDb()
      .prepare('DELETE FROM deposits WHERE id = ?').run(d.id);
  }

  const { config } = await import('../src/config');
  await scanChain(blockbookProvider('litecoin', config.rpc.litecoin));

  const after = repo.listDeposits({ userId: user.id });
  const txids = after.map((d) => d.txid);
  assert.ok(txids.includes(DEPOSIT_TXID), 'the genuine deposit was missed');
  assert.ok(!txids.includes(OUR_SWEEP_TXID),
    'change from our own sweep was credited as a deposit');
});

test('recording the same sent transaction twice is harmless', async () => {
  const first = repo.recordSentTransaction({
    currency: 'LTC', chain: 'litecoin', address: 'ltc1qelsewhere', tag: null,
    amountUnits: 1000n, txid: 'cc'.repeat(32), description: 'once',
  });
  const second = repo.recordSentTransaction({
    currency: 'LTC', chain: 'litecoin', address: 'ltc1qelsewhere', tag: null,
    amountUnits: 1000n, txid: 'cc'.repeat(32), description: 'again',
  });
  assert.equal(first.uid, second.uid, 'a duplicate created a second withdrawal row');
});
