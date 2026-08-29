import { config } from '../config';
import { logger } from '../util/log';
import { events } from '../events';
import { CHAINS } from '../chains';
import { CURRENCIES } from '../currencies';
import { fromBaseUnits } from '../util/decimal';
import { requiredConfirmations } from '../api/serialize';
import * as repo from '../db/repo';
import { sendMessage, getUpdates, setMyCommands, getMe, esc, type TelegramUpdate } from './api';
import { buildCommands, helpText, type Command } from './commands';
import { hasFlow, cancelFlow, continueFlow } from './conversation';

const log = logger('telegram');

let running = false;
let offset = 0;
let startedAt = 0;
let commands: Command[] = [];

/** Only chats on the admin list may issue commands. */
function isAuthorized(chatId: number | string): boolean {
  if (config.telegram.adminChatIds.length === 0) return false;
  return config.telegram.adminChatIds.includes(String(chatId));
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  // Ignore anything sent before this process started, so a restart does not
  // replay a backlog of stale commands.
  if (startedAt && msg.date * 1000 < startedAt) return;

  const chatId = msg.chat.id;
  if (!isAuthorized(chatId)) {
    log.warn(`ignoring command from unauthorized chat ${chatId}`
      + (msg.from?.username ? ` (@${msg.from.username})` : ''));
    // Reply once so a legitimate owner can discover their own chat id.
    await sendMessage(chatId, `Not authorized. Add this chat id to TELEGRAM_ADMIN_CHAT_IDS:\n<code>${chatId}</code>`);
    return;
  }

  const text = msg.text.trim();

  // A plain reply belongs to whatever multi-step command is waiting on it.
  if (!text.startsWith('/')) {
    if (hasFlow(chatId)) {
      const reply = await continueFlow(chatId, text);
      // An empty reply means the step sent its own message already.
      if (reply) await sendMessage(chatId, reply);
    }
    return;
  }

  // "/balance@my_bot BTC" -> name "balance", args ["BTC"]
  const [rawName, ...args] = text.slice(1).split(/\s+/);
  const name = rawName.split('@')[0].toLowerCase();

  // A command other than /cancel abandons an unfinished flow, so a stale
  // conversation cannot swallow the next thing typed.
  if (hasFlow(chatId) && name !== 'cancel') cancelFlow(chatId);

  const command = commands.find((c) => c.name === name)
    // /start is the conventional Telegram entry point; treat it as help.
    ?? (name === 'start' ? commands.find((c) => c.name === 'help') : undefined);

  if (!command) {
    await sendMessage(chatId, `Unknown command ${esc('/' + name)}. Send /help for the list.`);
    return;
  }

  try {
    const reply = await command.run(args, chatId);
    if (reply) await sendMessage(chatId, reply);
  } catch (e) {
    log.error(`/${name} failed`, (e as Error).message);
    await sendMessage(chatId, `${esc('/' + name)} failed: <code>${esc((e as Error).message)}</code>`);
  }
}

// ---------------------------------------------------------------- alerts ----

function depositAlert(deposit: repo.DepositRow, credited: boolean): string {
  const currency = CURRENCIES[deposit.currency];
  const decimals = currency?.decimals ?? 8;
  const value = fromBaseUnits(BigInt(deposit.amount_units), decimals);
  const user = repo.getUserById(deposit.user_id);
  const needed = requiredConfirmations(deposit.currency);
  const link = CHAINS[deposit.chain]?.explorerTx?.replace('{tx}', deposit.txid);

  const lines = credited
    ? [`✅ <b>Deposit credited</b>`, '']
    : [`🟡 <b>Deposit detected</b>`, ''];

  lines.push(`<b>${esc(value)} ${esc(deposit.currency)}</b>`);
  lines.push(`User: <code>${esc(user?.external_id ?? 'unknown')}</code>`);
  if (!credited) lines.push(`Confirmations: <code>${deposit.confirmations}/${needed}</code>`);
  lines.push(`Address: <code>${esc(deposit.address)}</code>`);
  if (deposit.tag) lines.push(`${esc(CHAINS[deposit.chain]?.tagName ?? 'Tag')}: <code>${esc(deposit.tag)}</code>`);
  if (link) lines.push(`<a href="${esc(link)}">View on explorer</a>`);
  lines.push('');
  lines.push(`<code>/tx ${esc(deposit.uid)}</code>`);
  return lines.join('\n');
}

/** Push a message to the master chat. Safe to call when Telegram is off. */
export async function notify(html: string): Promise<void> {
  if (!config.telegram.enabled || !config.telegram.chatId) return;
  await sendMessage(config.telegram.chatId, html);
}

function subscribeToEvents() {
  events.onEvent('deposit.pending', (deposit) => {
    if (!config.telegram.notifyPending) return;
    void notify(depositAlert(deposit, false));
  });
  events.onEvent('deposit.completed', (deposit) => {
    void notify(depositAlert(deposit, true));
  });
}

// ----------------------------------------------------------------- loop -----

async function poll(): Promise<void> {
  let backoff = 1000;
  while (running) {
    try {
      const updates = await getUpdates(offset, 30);
      backoff = 1000;
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        await handleUpdate(update);
      }
    } catch (e) {
      if (!running) return;
      // Network blips and Telegram hiccups are expected; never exit the loop.
      log.warn(`polling error, retrying in ${backoff}ms`, (e as Error).message);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

export async function startTelegramBot(): Promise<void> {
  if (!config.telegram.enabled) {
    log.info('telegram bot disabled');
    return;
  }
  if (!config.telegram.token) {
    log.warn('TELEGRAM_BOT_TOKEN is not set — the bot will not start');
    return;
  }
  if (config.telegram.adminChatIds.length === 0) {
    log.warn('no TELEGRAM_CHAT_ID / TELEGRAM_ADMIN_CHAT_IDS set — every command will be refused');
  }

  commands = buildCommands();
  startedAt = Date.now();
  running = true;

  subscribeToEvents();

  let username = 'bot';
  try {
    const me = await getMe();
    username = me.username ?? me.first_name ?? 'bot';
    log.info(`connected to Telegram as @${username}`);
  } catch (e) {
    log.error('could not reach Telegram — check TELEGRAM_BOT_TOKEN', (e as Error).message);
    running = false;
    return;
  }

  // Populate the in-app command menu.
  await setMyCommands(commands.map((c) => ({
    command: c.name,
    description: c.description.slice(0, 256),
  })));

  // Drop any backlog that accumulated while the gateway was down, so a restart
  // does not execute commands sent hours ago.
  try {
    const stale = await getUpdates(-1, 0);
    if (stale.length) offset = stale[stale.length - 1].update_id + 1;
  } catch {
    /* the poll loop will recover */
  }

  if (config.telegram.announceOnStart && config.telegram.chatId) {
    const banner = [
      '🟢 <b>Gateway started</b>',
      '',
      `Watcher: <code>${config.watcherEnabled ? 'on' : 'off'}</code>`,
      `Mode: <code>${config.watchOnly ? 'watch-only' : 'full'}</code>`,
      '',
    ].join('\n');
    await notify(banner + helpText(commands));
  }

  void poll();
  log.info(`telegram bot listening (${commands.length} commands)`);
}

export function stopTelegramBot(): void {
  running = false;
}

/** Exposed for tests. */
export const _internal = { isAuthorized, depositAlert, handleUpdate };
