import { createHmac } from 'node:crypto';
import { config } from './config';
import { logger } from './util/log';
import * as repo from './db/repo';
import { depositToJson } from './api/serialize';
import type { DepositRow } from './db/repo';

const log = logger('ipn');

/**
 * Outgoing callbacks to your exchange.
 *
 * Every deposit fires twice: once when it is first seen (status "pending") and
 * once when it clears its confirmation threshold (status "completed"). Credit
 * the user's account on "completed" — "pending" is for showing them that their
 * money has arrived and is being confirmed.
 *
 * Each request carries:
 *   X-Gateway-Signature: hex( HMAC-SHA256( key = IPN_SECRET, msg = raw body ) )
 *
 * Verify that signature before trusting the payload, and treat the callback as
 * at-least-once: the same transaction id can arrive more than once, so make
 * your handler idempotent on `id`.
 */

export function queueDepositIpn(deposit: DepositRow, addressIpnUrl: string | null) {
  const url = addressIpnUrl || process.env.DEFAULT_IPN_URL || '';
  if (!url) {
    log.debug(`no IPN url for deposit ${deposit.uid}; skipping callback`);
    return;
  }
  repo.enqueueIpn(`deposit.${deposit.status}`, url, depositToJson(deposit));
}

export function signPayload(body: string): string {
  return createHmac('sha256', config.ipnSecret || '').update(body).digest('hex');
}

async function deliver(item: { id: number; event: string; url: string; payload: string; attempts: number }) {
  const body = item.payload;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.ipnTimeoutMs);
  try {
    const res = await fetch(item.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-event': item.event,
        'x-gateway-signature': signPayload(body),
      },
      body,
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    repo.markIpnDelivered(item.id);
    log.info(`delivered ${item.event} to ${hostOf(item.url)}`);
  } catch (e) {
    const attempts = item.attempts + 1;
    // Exponential backoff, capped at an hour, so a downed endpoint recovers
    // without us hammering it.
    const delayMs = Math.min(60 * 60_000, 2 ** attempts * 1000);
    const nextAt = new Date(Date.now() + delayMs);
    repo.markIpnRetry(item.id, attempts, nextAt, (e as Error).message, config.ipnMaxAttempts);
    log.warn(`${item.event} to ${hostOf(item.url)} failed (attempt ${attempts}/${config.ipnMaxAttempts}): `
      + (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function flushIpnQueue() {
  if (running) return;
  running = true;
  try {
    const due = repo.dueIpns(25);
    for (const item of due) await deliver(item);
  } finally {
    running = false;
  }
}

export function startIpnWorker(intervalMs = 5000) {
  if (!config.ipnSecret) {
    log.warn('IPN_SECRET is not set — callbacks will be signed with an empty key');
  }
  timer = setInterval(() => void flushIpnQueue(), intervalMs);
  return timer;
}

export function stopIpnWorker() {
  if (timer) { clearInterval(timer); timer = null; }
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
