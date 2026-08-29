import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { setupEnv } from './helpers';

setupEnv('holdings');

/**
 * The live-balance scan, driven against stand-in chain endpoints so the
 * aggregation, the shared-address handling and the ledger comparison are all
 * really exercised.
 */

let servers: { close: () => void }[] = [];
let evmCalls = 0;
let tronCalls = 0;
let xrpCalls = 0;

function start(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push({ close: () => s.close() });
  return new Promise((r) => s.listen(0, '127.0.0.1',
    () => r(`http://127.0.0.1:${(s.address() as any).port}`)));
}

const json = (res: http.ServerResponse, body: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

let repo: typeof import('../src/db/repo');
let scanHoldings: typeof import('../src/services/holdings').scanHoldings;
let nonZero: typeof import('../src/services/holdings').nonZero;
let discrepancies: typeof import('../src/services/holdings').discrepancies;
let ethAddress: string;

before(async () => {
  // Ethereum: 1.5 ETH native, 25 USDT (6 decimals) from the token call.
  const evm = await start((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      evmCalls++;
      const rpcCall = JSON.parse(body || '{}');
      if (rpcCall.method === 'eth_getBalance') {
        return json(res, { jsonrpc: '2.0', id: 1, result: '0x14d1120d7b160000' }); // 1.5e18
      }
      if (rpcCall.method === 'eth_call') {
        return json(res, { jsonrpc: '2.0', id: 1, result: '0x00000000000000000000000000000000000000000000000000000000017d7840' }); // 25000000
      }
      return json(res, { jsonrpc: '2.0', id: 1, result: '0x0' });
    });
  });

  // Tron: one response carries TRX and every TRC-20 balance.
  const tron = await start((_req, res) => {
    tronCalls++;
    json(res, {
      data: [{
        balance: 5_000_000, // 5 TRX (6 decimals)
        trc20: [
          { 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t': '12000000' }, // 12 USDT
          { 'TSomeOtherTokenWeDoNotList0000000000': '99999999' },
        ],
      }],
    });
  });

  // XRP: one shared gateway account.
  const xrp = await start((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      xrpCalls++;
      json(res, { result: { account_data: { Balance: '7000000' } } }); // 7 XRP
    });
  });

  process.env.ETH_RPC_URL = evm;
  process.env.TRON_API_URL = tron;
  process.env.XRP_RPC_URL = xrp;
  process.env.XRP_ADDRESS = 'rGatewayTestAccount00000000000';
  // Keep the other chains out of this test; they have no stand-in here.
  process.env.WATCHER_CHAINS = '';

  repo = await import('../src/db/repo');
  ({ scanHoldings, nonZero, discrepancies } = await import('../src/services/holdings'));

  const { getDepositIdentity } = await import('../src/services/addresses');
  const eth = await getDepositIdentity({ userExternalId: 'holdings-user', currency: 'ETH' });
  ethAddress = eth.address;
  await getDepositIdentity({ userExternalId: 'holdings-user', currency: 'USDTTRC' });
  await getDepositIdentity({ userExternalId: 'holdings-user', currency: 'XRP' });
  await getDepositIdentity({ userExternalId: 'holdings-user-2', currency: 'XRP' });
});

after(() => { for (const s of servers) s.close(); });

test('reports the live balance of every currency on a chain', async () => {
  const report = await scanHoldings({ chain: 'ethereum' });
  const eth = report.holdings.find((h) => h.ticker === 'ETH')!;
  const usdt = report.holdings.find((h) => h.ticker === 'USDTERC20')!;

  assert.equal(eth.onChain, 1_500_000_000_000_000_000n, 'ETH balance wrong');
  assert.equal(usdt.onChain, 25_000_000n, 'the ERC-20 balance was not read');
  assert.equal(report.addressesScanned, 1);
});

test('one Tron request yields both TRX and its TRC-20 tokens', async () => {
  const before = tronCalls;
  const report = await scanHoldings({ chain: 'tron' });

  const trx = report.holdings.find((h) => h.ticker === 'TRX')!;
  const usdt = report.holdings.find((h) => h.ticker === 'USDTTRC')!;
  const usdc = report.holdings.find((h) => h.ticker === 'USDCTRC20')!;

  assert.equal(trx.onChain, 5_000_000n);
  assert.equal(usdt.onChain, 12_000_000n);
  assert.equal(usdc.onChain, 0n, 'a token we hold none of should read zero, not be absent');
  assert.equal(tronCalls - before, 1, 'Tron should cost one request per address');
});

test('a shared gateway account is counted once, not once per user', async () => {
  // Two users share the XRP address; counting per user would double it.
  const report = await scanHoldings({ chain: 'xrp' });
  const xrp = report.holdings.find((h) => h.ticker === 'XRP')!;
  assert.equal(xrp.onChain, 7_000_000n, 'the shared balance was multiplied by the user count');
  assert.equal(report.addressesScanned, 1);
});

test('the report shows which addresses hold the funds', async () => {
  const report = await scanHoldings({ chain: 'ethereum' });
  const eth = report.holdings.find((h) => h.ticker === 'ETH')!;
  assert.equal(eth.addresses.length, 1);
  assert.equal(eth.addresses[0].address, ethAddress);
  assert.equal(eth.addresses[0].user, 'holdings-user');
});

test('nonZero lists only what is actually held', async () => {
  const report = await scanHoldings({ chain: 'ethereum' });
  const held = nonZero(report);
  assert.ok(held.every((h) => h.onChain > 0n));
  assert.ok(held.some((h) => h.ticker === 'ETH'));
  assert.ok(!held.some((h) => h.ticker === 'BTC'), 'an unscanned currency was reported as held');
});

test('a gap between the chain and the credited ledger is surfaced', async () => {
  const report = await scanHoldings({ chain: 'ethereum' });
  const gaps = discrepancies(report);
  // Nothing has been credited, but 1.5 ETH is really there — that is a gap
  // worth seeing, and the direction matters.
  const eth = gaps.find((h) => h.ticker === 'ETH');
  assert.ok(eth, 'a chain balance with no credited counterpart should be flagged');
  assert.ok(eth!.onChain > eth!.credited);
});

test('a chain that cannot be read is reported, not silently skipped', async () => {
  // EOS has no gateway account configured in this test environment.
  const report = await scanHoldings({ chain: 'eos' });
  assert.ok(report.failures.some((f) => f.chain === 'eos'),
    'an unreadable chain should appear in failures');
});

test('an unreachable endpoint fails that chain without stopping the scan', async () => {
  process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1'; // nothing listening
  const { getDepositIdentity } = await import('../src/services/addresses');
  await getDepositIdentity({ userExternalId: 'holdings-user', currency: 'SOL' });

  const report = await scanHoldings({ chain: 'solana' });
  assert.ok(report.failures.some((f) => f.chain === 'solana'));
  // The report still comes back rather than the scan throwing.
  assert.ok(Array.isArray(report.holdings));
});
