import { config } from '../config';
import { logger } from '../util/log';

const log = logger('telegram');

/** Telegram caps a message at 4096 characters; leave room for the wrapper. */
const MAX_MESSAGE = 3900;

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number; type: string; title?: string; username?: string };
    from?: { id: number; username?: string; first_name?: string };
  };
}

function apiUrl(method: string): string {
  return `${config.telegram.apiUrl.replace(/\/$/, '')}/bot${config.telegram.token}/${method}`;
}

async function call<T>(method: string, body: unknown, timeoutMs = 15000): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const json = await res.json() as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(json.description ?? `telegram ${method} failed`);
    return json.result as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Escape text for Telegram's HTML parse mode. Everything user- or chain-derived
 * must go through this — an address or label containing `<` would otherwise
 * break the message or, worse, be swallowed silently.
 */
export function esc(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Send a message, splitting it if it exceeds Telegram's limit. */
export async function sendMessage(chatId: string | number, html: string): Promise<void> {
  for (const chunk of splitMessage(html)) {
    try {
      await call('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (e) {
      log.warn(`could not send message to ${chatId}`, (e as Error).message);
      return; // do not spam the rest of a failed multi-part message
    }
  }
}

/** Split on line boundaries so formatting is never cut mid-tag. */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE) return [text];
  const out: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > MAX_MESSAGE) {
      if (current) out.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Long-poll for updates. Returns [] on a timeout, which is the normal case. */
export async function getUpdates(offset: number, timeoutSec = 30): Promise<TelegramUpdate[]> {
  return call<TelegramUpdate[]>(
    'getUpdates',
    { offset, timeout: timeoutSec, allowed_updates: ['message'] },
    (timeoutSec + 10) * 1000,
  );
}

/** Register the command list so Telegram shows a menu in the chat. */
export async function setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
  try {
    await call('setMyCommands', { commands });
  } catch (e) {
    log.warn('could not register the command menu', (e as Error).message);
  }
}

export async function getMe(): Promise<{ username?: string; first_name?: string }> {
  return call('getMe', {});
}
