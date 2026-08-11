import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { setupEnv } from './helpers';

setupEnv('telegram');

/**
 * The bot is exercised against a stand-in Telegram server, so the polling loop,
 * command routing, authorization and alert delivery are all really executed —
 * only api.telegram.org is replaced.
 */

const TOKEN = 'test-token';
const ADMIN_CHAT = '111';
const STRANGER_CHAT = '999';

interface SentMessage { chat_id: string; text: string }

let sent: SentMessage[] = [];
let queuedUpdates: any[] = [];
let registeredCommands: { command: string; description: string }[] = [];
let fake: http.Server;
let updateId = 1;

function fakeTelegram(): Promise<number> {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      const method = (req.url ?? '').split('/').pop();
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      };

      switch (method) {
        case 'getMe':
          return reply({ username: 'trustwestme_test_bot', first_name: 'Gateway' });
        case 'setMyCommands':
          registeredCommands = payload.commands ?? [];
          return reply(true);
        case 'sendMessage':
          sent.push({ chat_id: String(payload.chat_id), text: String(payload.text) });
          return reply({ message_id: sent.length });
        case 'getUpdates': {
          const batch = queuedUpdates;
          queuedUpdates = [];
          if (batch.length === 0) {
            // Stand in for a long poll without making the test wait 30s.
            return setTimeout(() => reply([]), 30);
          }
          return reply(batch);
        }
        default:
          return reply({});
      }
    });
  });
  return new Promise((resolve) => {
    fake.listen(0, '127.0.0.1', () => resolve((fake.address() as any).port));
  });
}

/** Queue an inbound message and wait for the bot to answer it. */
async function send(text: string, chatId = ADMIN_CHAT): Promise<string> {
  const before = sent.length;
  queuedUpdates.push({
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000) + 5, // comfortably after startup
      text,
      chat: { id: Number(chatId), type: 'private' },
      from: { id: Number(chatId), username: 'tester' },
    },
  });
  for (let i = 0; i < 100; i++) {
    if (sent.length > before) return sent[sent.length - 1].text;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`bot never answered ${text}`);
}

let repo: typeof import('../src/db/repo');
let events: typeof import('../src/events').events;
let stopTelegramBot: typeof import('../src/telegram/bot').stopTelegramBot;

before(async () => {
  const port = await fakeTelegram();
  process.env.TELEGRAM_ENABLED = 'true';
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_API_URL = `http://127.0.0.1:${port}`;
  process.env.TELEGRAM_CHAT_ID = ADMIN_CHAT;
  process.env.TELEGRAM_ANNOUNCE_ON_START = 'true';

  repo = await import('../src/db/repo');
  ({ events } = await import('../src/events'));
  const bot = await import('../src/telegram/bot');
  ({ stopTelegramBot } = bot);
  await bot.startTelegramBot();
});

after(() => {
  stopTelegramBot?.();
  fake?.close();
});

test('announces itself with the full command list on startup', () => {
  assert.ok(sent.length > 0, 'nothing was sent on startup');
  const banner = sent.map((s) => s.text).join('\n');
  assert.match(banner, /Gateway started/);
  assert.match(banner, /\/help/);
  assert.match(banner, /\/status/);
  assert.match(banner, /\/balances/);
  assert.equal(sent[0].chat_id, ADMIN_CHAT, 'the banner went to the wrong chat');
});

test('registers its commands with Telegram for the in-app menu', () => {
  assert.ok(registeredCommands.length >= 14, 'expected the full command set to be registered');
  const names = registeredCommands.map((c) => c.command);
  for (const expected of ['help', 'status', 'stats', 'balances', 'balance', 'user',
    'address', 'deposits', 'pending', 'tx', 'withdrawals', 'chains', 'currencies',
    'scan', 'ipn', 'users']) {
    assert.ok(names.includes(expected), `command /${expected} was not registered`);
  }
  // Telegram rejects descriptions longer than 256 characters.
  for (const c of registeredCommands) assert.ok(c.description.length <= 256);
});

test('/help lists every command', async () => {
  const reply = await send('/help');
  assert.match(reply, /control bot/);
  for (const expected of ['/status', '/balance', '/user', '/address', '/deposits',
    '/pending', '/tx', '/chains', '/scan', '/ipn']) {
    assert.ok(reply.includes(expected), `/help did not mention ${expected}`);
  }
});

test('/start is treated as /help', async () => {
  const reply = await send('/start');
  assert.match(reply, /control bot/);
});

test('a command addressed to the bot by name still works', async () => {
  const reply = await send('/help@trustwestme_test_bot');
  assert.match(reply, /control bot/);
});

test('/status reports gateway health', async () => {
  const reply = await send('/status');
  assert.match(reply, /Gateway status/);
  assert.match(reply, /Watcher/);
});

test('/currencies lists all 21', async () => {
  const reply = await send('/currencies');
  assert.match(reply, /21 currencies/);
  assert.match(reply, /BTC/);
  assert.match(reply, /USDTTRC/);
});

test('/address issues a real deposit address', async () => {
  const reply = await send('/address tg-user-1 BTC');
  assert.match(reply, /BTC deposit address/);
  assert.match(reply, /bc1q/);
  assert.ok(repo.getUserByExternalId('tg-user-1'), 'the user was not created');
});

test('/address surfaces the destination tag on tag chains', async () => {
  const reply = await send('/address tg-user-2 XRP');
  assert.match(reply, /destination_tag/);
  assert.match(reply, /required, or the deposit is lost/);
});

test('/user shows addresses and balances', async () => {
  await send('/address tg-user-3 ETH');
  const reply = await send('/user tg-user-3');
  assert.match(reply, /tg-user-3/);
  assert.match(reply, /Derivation index/);
  assert.match(reply, /0x[0-9a-fA-F]{40}/);
});

test('an unknown user is reported, not crashed on', async () => {
  const reply = await send('/user nobody-here');
  assert.match(reply, /No user/);
});

test('an unknown command is reported', async () => {
  const reply = await send('/definitelynotacommand');
  assert.match(reply, /Unknown command/);
});

test('a bad currency is reported, not crashed on', async () => {
  const reply = await send('/balance NOTACOIN');
  assert.match(reply, /Unknown currency/);
});

test('commands from an unauthorized chat are refused', async () => {
  const reply = await send('/balances', STRANGER_CHAT);
  assert.match(reply, /Not authorized/);
  // The refusal must go back to the stranger, never leak data to them.
  assert.equal(sent[sent.length - 1].chat_id, STRANGER_CHAT);
  assert.ok(!/Balances/.test(reply), 'balance data leaked to an unauthorized chat');
});

test('a credited deposit raises an alert in the master chat', async () => {
  const user = repo.getOrCreateUser('tg-deposit-user');
  repo.saveAddress({
    userId: user.id, chain: 'bitcoin', address: 'bc1qtelegramtest000000000000000',
    tag: null, path: "m/84'/0'/0'/0/99", ipnUrl: null,
  });
  const { row } = repo.recordDeposit({
    userId: user.id, addressId: repo.getAddress(user.id, 'bitcoin')!.id,
    chain: 'bitcoin', currency: 'BTC', address: 'bc1qtelegramtest000000000000000',
    tag: null, txid: 'tgtx1', outputIndex: 0, amountUnits: 250_000n,
    confirmations: 3, blockHeight: 1, status: 'completed',
  });

  const before = sent.length;
  events.emitEvent('deposit.completed', row);
  for (let i = 0; i < 100 && sent.length === before; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const alert = sent[sent.length - 1];
  assert.equal(alert.chat_id, ADMIN_CHAT);
  assert.match(alert.text, /Deposit credited/);
  assert.match(alert.text, /0\.0025 BTC/);
  assert.match(alert.text, /tg-deposit-user/);
  assert.match(alert.text, /\/tx /);
});

test('a pending deposit raises a distinct alert showing confirmations', async () => {
  const user = repo.getUserByExternalId('tg-deposit-user')!;
  const { row } = repo.recordDeposit({
    userId: user.id, addressId: repo.getAddress(user.id, 'bitcoin')!.id,
    chain: 'bitcoin', currency: 'BTC', address: 'bc1qtelegramtest000000000000000',
    tag: null, txid: 'tgtx2', outputIndex: 0, amountUnits: 100_000n,
    confirmations: 1, blockHeight: 2, status: 'pending',
  });

  const before = sent.length;
  events.emitEvent('deposit.pending', row);
  for (let i = 0; i < 100 && sent.length === before; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const alert = sent[sent.length - 1].text;
  assert.match(alert, /Deposit detected/);
  assert.match(alert, /1\/2/, 'the pending alert should show progress toward confirmation');
});

test('HTML in a user label cannot break the message', async () => {
  const reply = await send('/user <script>alert(1)</script>');
  // Escaped, not passed through raw.
  assert.ok(!reply.includes('<script>'), 'raw HTML reached the message body');
});
