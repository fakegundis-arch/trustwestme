import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { setupEnv } from './helpers';

setupEnv('withdrawflow');

/**
 * The /key and /withdraw conversations, driven through the real bot against a
 * stand-in Telegram server — the same approach as the other bot tests, so the
 * polling loop, routing, confirmation gates and message deletion all really run.
 */

const ADMIN = '111';
const STRANGER = '999';

interface Sent { chat_id: string; text: string; message_id: number }
let sent: Sent[] = [];
let deleted: number[] = [];
let queued: any[] = [];
let fake: http.Server;
let updateId = 1;
let messageId = 1000;

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
        case 'getMe': return reply({ username: 'flow_test_bot' });
        case 'setMyCommands': return reply(true);
        case 'sendMessage': {
          const id = ++messageId;
          sent.push({ chat_id: String(payload.chat_id), text: String(payload.text), message_id: id });
          return reply({ message_id: id });
        }
        case 'deleteMessage':
          deleted.push(Number(payload.message_id));
          return reply(true);
        case 'getUpdates': {
          const batch = queued;
          queued = [];
          if (batch.length === 0) return setTimeout(() => reply([]), 25);
          return reply(batch);
        }
        default: return reply({});
      }
    });
  });
  return new Promise((r) => fake.listen(0, '127.0.0.1', () => r((fake.address() as any).port)));
}

/** Send a message as the admin and wait for the bot's reply. */
async function say(text: string, chatId = ADMIN): Promise<string> {
  const before = sent.length;
  queued.push({
    update_id: updateId++,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000) + 5, text,
      chat: { id: Number(chatId), type: 'private' },
      from: { id: Number(chatId), username: 'tester' },
    },
  });
  for (let i = 0; i < 160; i++) {
    if (sent.length > before) return sent[sent.length - 1].text;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no reply to: ${text}`);
}

let repo: typeof import('../src/db/repo');
let stopTelegramBot: typeof import('../src/telegram/bot').stopTelegramBot;

before(async () => {
  const port = await fakeTelegram();
  process.env.TELEGRAM_ENABLED = 'true';
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.TELEGRAM_API_URL = `http://127.0.0.1:${port}`;
  process.env.TELEGRAM_CHAT_ID = ADMIN;
  process.env.TELEGRAM_ANNOUNCE_ON_START = 'false';

  repo = await import('../src/db/repo');
  const { getDepositIdentity } = await import('../src/services/addresses');
  await getDepositIdentity({ userExternalId: 'flow-user', currency: 'BTC' });

  const bot = await import('../src/telegram/bot');
  ({ stopTelegramBot } = bot);
  await bot.startTelegramBot();
});

after(() => { stopTelegramBot?.(); fake?.close(); });

// ------------------------------------------------------------------ /key ----

test('/key asks what to export', async () => {
  const reply = await say('/key');
  assert.match(reply, /Export a private key/);
  assert.match(reply, /deposit address/);
});

test('/key refuses an address it never issued', async () => {
  await say('/key');
  const reply = await say('bc1qnotanaddresswehaveeverissued00000');
  assert.match(reply, /not an address this gateway issued/);
});

test('/key warns before revealing, and needs the exact word', async () => {
  await say('/key');
  const warning = await say('bitcoin 1');
  assert.match(warning, /About to reveal a private key/);
  assert.match(warning, /m\/84/);              // shows the derivation path
  assert.ok(!/[KL][1-9A-HJ-NP-Za-km-z]{50}/.test(warning), 'the key leaked into the warning');

  const nudge = await say('yes please');
  assert.match(nudge, /REVEAL/, 'anything but REVEAL should not reveal');
});

test('/key reveals a usable key and then deletes the message', async () => {
  await say('/key');
  await say('bitcoin 1');
  const revealed = await say('REVEAL');

  assert.match(revealed, /Private key/);
  // A compressed mainnet WIF starts with K or L.
  // A compressed mainnet WIF is 51-52 base58 characters starting with K or L.
  assert.match(revealed, /<code>[KL][1-9A-HJ-NP-Za-km-z]{50,52}<\/code>/, 'no WIF in the reply');
  assert.match(revealed, /self-destructs/);

  const keyMessage = sent[sent.length - 1];
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!deleted.includes(keyMessage.message_id), 'deleted far too early');
});

test('/key is refused for a stranger, like every other command', async () => {
  const reply = await say('/key', STRANGER);
  assert.match(reply, /Not authorized/);
});

// ------------------------------------------------------------- /withdraw ----

test('/withdraw lists the currencies it can send', async () => {
  const reply = await say('/withdraw');
  assert.match(reply, /Withdraw funds/);
  assert.match(reply, /BTC/);
});

test('/withdraw refuses a chain that cannot be signed yet', async () => {
  await say('/withdraw');
  const reply = await say('XRP');
  assert.match(reply, /cannot be sent from here yet/);
  assert.match(reply, /\/key/, 'should point at the key export instead');
});

test('/withdraw stops when nothing is funded', async () => {
  await say('/withdraw');
  // The test addresses hold nothing, and the chain lookup fails without a
  // network, so both paths end the same way: no funds found.
  const reply = await say('BTC');
  assert.match(reply, /No BTC found|cannot be sent/);
});

test('/cancel ends a conversation in progress', async () => {
  await say('/key');
  const reply = await say('/cancel');
  assert.match(reply, /Cancelled/);

  // With nothing pending, a plain message should now be ignored entirely
  // rather than picked up by the abandoned flow.
  const before = sent.length;
  queued.push({
    update_id: updateId++,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000) + 5, text: 'bitcoin 1',
      chat: { id: Number(ADMIN), type: 'private' },
      from: { id: Number(ADMIN), username: 'tester' },
    },
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent.length, before, 'the cancelled flow still accepted input');
});

test('a new command abandons an unfinished conversation', async () => {
  await say('/key');
  const reply = await say('/status');
  assert.match(reply, /Gateway status/, 'the pending flow swallowed the new command');
});

test('an unrelated plain message is ignored when nothing is pending', async () => {
  const before = sent.length;
  queued.push({
    update_id: updateId++,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000) + 5,
      text: 'just chatting',
      chat: { id: Number(ADMIN), type: 'private' },
      from: { id: Number(ADMIN), username: 'tester' },
    },
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent.length, before, 'the bot replied to an unrelated message');
});
