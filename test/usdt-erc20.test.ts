import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { setupEnv } from './helpers';

setupEnv('usdterc20');

/**
 * A USDT ERC-20 deposit, end to end through the real Ethereum watcher.
 *
 * Token deposits travel a completely different path from native ETH — found by
 * eth_getLogs on the Transfer topic rather than by walking transactions — so
 * this drives the actual provider against a stand-in Ethereum node returning a
 * real-shaped Transfer log.
 */

/** keccak256("Transfer(address,uint256)") */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const LATEST_BLOCK = 21_000_000;
const DEPOSIT_BLOCK = 20_999_995;   // 6 blocks back: not yet 12 confirmations
const DEPOSIT_TX = '0x' + 'ab'.repeat(32);

let rpcServer: http.Server;
let getLogsRequests: any[] = [];
/** Blocks mined since the deposit landed — how confirmations actually accrue. */
let headAdvance = 0;

let repo: typeof import('../src/db/repo');
let scanChain: typeof import('../src/watcher/index').scanChain;
let evmProvider: typeof import('../src/watcher/providers/evm').evmProvider;
let userAddress: string;

const pad = (address: string) => '0x' + address.replace(/^0x/, '').toLowerCase().padStart(64, '0');

function startRpc(): Promise<string> {
  rpcServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const call = JSON.parse(body || '{}');
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
      };

      switch (call.method) {
        case 'eth_blockNumber':
          // The head advances as blocks are mined; the deposit stays where it is.
          return reply('0x' + (LATEST_BLOCK + headAdvance).toString(16));

        case 'eth_getBlockByNumber':
          // No native ETH transfers in this test; only the token log matters.
          return reply({ number: call.params[0], transactions: [] });

        case 'eth_getLogs': {
          getLogsRequests.push(call.params[0]);
          const filter = call.params[0];
          // Only answer for the USDT contract, as a real node would.
          if (String(filter.address).toLowerCase() !== USDT_CONTRACT.toLowerCase()) {
            return reply([]);
          }
          return reply([{
            address: USDT_CONTRACT,
            topics: [
              TRANSFER_TOPIC,
              pad('0x1111111111111111111111111111111111111111'), // sender
              pad(userAddress),                                   // recipient
            ],
            // 25 USDT. USDT on Ethereum has SIX decimals, not eighteen.
            data: '0x' + (25_000_000).toString(16).padStart(64, '0'),
            blockNumber: '0x' + DEPOSIT_BLOCK.toString(16),
            transactionHash: DEPOSIT_TX,
            logIndex: '0x4',
            removed: false,
          }]);
        }

        default:
          return reply('0x0');
      }
    });
  });
  return new Promise((r) => rpcServer.listen(0, '127.0.0.1',
    () => r(`http://127.0.0.1:${(rpcServer.address() as any).port}`)));
}

before(async () => {
  const url = await startRpc();
  process.env.ETH_RPC_URL = url;
  process.env.REORG_DEPTH = '3';   // keep the block walk small

  repo = await import('../src/db/repo');
  ({ scanChain } = await import('../src/watcher/index'));
  ({ evmProvider } = await import('../src/watcher/providers/evm'));

  // The address the exchange would have handed the depositor.
  const { getDepositIdentity } = await import('../src/services/addresses');
  const identity = await getDepositIdentity({
    userExternalId: 'usdt-depositor', currency: 'USDTERC20',
  });
  userAddress = identity.address;
});

after(() => { rpcServer?.close(); });

test('the USDT-ERC20 deposit address is the user Ethereum address', async () => {
  const { getDepositIdentity } = await import('../src/services/addresses');
  const usdt = await getDepositIdentity({ userExternalId: 'usdt-depositor', currency: 'USDTERC20' });
  const eth = await getDepositIdentity({ userExternalId: 'usdt-depositor', currency: 'ETH' });

  assert.equal(usdt.address, eth.address, 'USDT-ERC20 should arrive at the Ethereum address');
  assert.match(usdt.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(usdt.chain, 'ethereum');
  // The deposit page must say ETH also lands here.
  assert.ok(usdt.sharedWith.includes('ETH'));
});

test('the watcher asks the node for USDT Transfer logs', async () => {
  getLogsRequests = [];
  await scanChain(evmProvider('ethereum', process.env.ETH_RPC_URL!));

  const usdtQuery = getLogsRequests.find(
    (q) => String(q.address).toLowerCase() === USDT_CONTRACT.toLowerCase());
  assert.ok(usdtQuery, 'the watcher never queried the USDT contract');
  assert.equal(usdtQuery.topics[0], TRANSFER_TOPIC, 'wrong event topic');
  // The recipient filter must include our address, or the node returns nothing.
  const recipients = usdtQuery.topics[2];
  assert.ok(Array.isArray(recipients) && recipients.includes(pad(userAddress)),
    'our address was not in the recipient filter');
});

test('an unconfirmed USDT deposit is recorded as pending, not credited', async () => {
  const user = repo.getUserByExternalId('usdt-depositor')!;
  const deposits = repo.listDeposits({ userId: user.id, currency: 'USDTERC20' });

  assert.equal(deposits.length, 1, 'the USDT deposit was not detected');
  const deposit = deposits[0];
  assert.equal(deposit.currency, 'USDTERC20');
  assert.equal(deposit.txid, DEPOSIT_TX);
  // 25 USDT at 6 decimals.
  assert.equal(deposit.amount_units, '25000000');
  assert.equal(deposit.status, 'pending', 'credited before reaching 12 confirmations');
  assert.equal(repo.getBalance(user.id, 'USDTERC20').available, 0n);
});

test('it credits once the deposit has 12 confirmations', async () => {
  // Twenty more blocks are mined. The log is now far behind the scan cursor,
  // so the watcher must bring its confirmations up to date from the head
  // alone — it will never be handed this transfer again.
  headAdvance = 20;
  await scanChain(evmProvider('ethereum', process.env.ETH_RPC_URL!));

  const user = repo.getUserByExternalId('usdt-depositor')!;
  const deposits = repo.listDeposits({ userId: user.id, currency: 'USDTERC20' });

  assert.equal(deposits.length, 1, 'the same transfer produced a second deposit row');
  assert.equal(deposits[0].status, 'completed');
  assert.equal(repo.getBalance(user.id, 'USDTERC20').available, 25_000_000n,
    'the balance was not credited with 25 USDT');
});

test('re-scanning does not credit the same transfer twice', async () => {
  const user = repo.getUserByExternalId('usdt-depositor')!;
  for (let i = 0; i < 3; i++) {
    await scanChain(evmProvider('ethereum', process.env.ETH_RPC_URL!));
  }
  assert.equal(repo.getBalance(user.id, 'USDTERC20').available, 25_000_000n,
    'the deposit was credited more than once');
  assert.equal(repo.listDeposits({ userId: user.id, currency: 'USDTERC20' }).length, 1);
});

test('the amount is read with 6 decimals, as USDT on Ethereum uses', async () => {
  const { depositToJson } = await import('../src/api/serialize');
  const user = repo.getUserByExternalId('usdt-depositor')!;
  const deposit = repo.listDeposits({ userId: user.id, currency: 'USDTERC20' })[0];

  // Reading 25000000 at 18 decimals would show 0.000000000025 USDT.
  assert.equal(depositToJson(deposit).amount, '25',
    'the decimals are wrong — the credited amount would be off by orders of magnitude');
});

test('USDT-ERC20 is watched on Ethereum with the mainnet contract', async () => {
  const { CURRENCIES } = await import('../src/currencies');
  const usdt = CURRENCIES.USDTERC20;
  assert.equal(usdt.chain, 'ethereum');
  assert.equal(usdt.kind, 'token');
  assert.equal(usdt.decimals, 6);
  assert.equal(usdt.contract, USDT_CONTRACT);

  // And the Ethereum watcher is in the set the gateway runs.
  const { buildProviders } = await import('../src/watcher/index');
  assert.ok(buildProviders().some((p) => p.chain === 'ethereum'),
    'no Ethereum watcher is registered');
});
