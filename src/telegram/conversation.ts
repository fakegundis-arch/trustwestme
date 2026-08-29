import { CHAINS, getChain } from '../chains';
import { resolveCurrency, listCurrencies, type CurrencyDef } from '../currencies';
import { fromBaseUnits, toBaseUnits } from '../util/decimal';
import { mapLimit } from '../util/http';
import { exportPrivateKey } from '../wallet/keys';
import { canSign, signerFor } from '../wallet/signer';
import { deriveIdentity } from '../wallet/derive';
import * as repo from '../db/repo';
import { logger } from '../util/log';
import { esc, sendMessage, deleteMessage } from './api';

const log = logger('telegram:flow');

/**
 * Multi-step commands.
 *
 * /key and /withdraw each need a few answers, so the chat's position in the
 * flow is held here between messages. Only one flow runs per chat at a time,
 * and it expires so a half-finished conversation cannot be resumed hours later
 * by whoever next has the phone.
 */

const EXPIRY_MS = 5 * 60 * 1000;
/** How long a revealed private key stays in the chat. */
const KEY_VISIBLE_MS = 90 * 1000;
/** Cap on addresses inspected in one withdrawal, to bound the RPC calls. */
const MAX_ADDRESSES = 50;

interface Flow {
  name: 'key' | 'withdraw';
  step: string;
  data: Record<string, any>;
  expiresAt: number;
}

const flows = new Map<number, Flow>();

export function hasFlow(chatId: number): boolean {
  const flow = flows.get(chatId);
  if (!flow) return false;
  if (Date.now() > flow.expiresAt) {
    flows.delete(chatId);
    return false;
  }
  return true;
}

export function cancelFlow(chatId: number): boolean {
  return flows.delete(chatId);
}

function start(chatId: number, name: Flow['name'], step: string, data: Record<string, any> = {}) {
  flows.set(chatId, { name, step, data, expiresAt: Date.now() + EXPIRY_MS });
}

function advance(chatId: number, step: string, data: Record<string, any>) {
  const flow = flows.get(chatId)!;
  flow.step = step;
  flow.data = { ...flow.data, ...data };
  flow.expiresAt = Date.now() + EXPIRY_MS;
}

const b = (s: unknown) => `<b>${esc(s)}</b>`;
const code = (s: unknown) => `<code>${esc(s)}</code>`;

// ------------------------------------------------------------------ /key ----

export async function beginKey(chatId: number, args: string[]): Promise<string> {
  start(chatId, 'key', 'target');
  if (args[0]) return continueFlow(chatId, args.join(' '));
  return [
    b('Export a private key'),
    '',
    'Send one of:',
    `  • a deposit address, e.g. ${code('bc1q…')}`,
    `  • a chain and user index, e.g. ${code('bitcoin 1')}`,
    '',
    `Or ${code('/cancel')} to stop.`,
  ].join('\n');
}

async function resolveTarget(text: string): Promise<{ chain: string; index: number; address: string }> {
  const trimmed = text.trim();

  // "bitcoin 1" — a chain and an index.
  const parts = trimmed.split(/\s+/);
  if (parts.length === 2 && CHAINS[parts[0].toLowerCase()]) {
    const chain = parts[0].toLowerCase();
    const index = Number(parts[1]);
    if (!Number.isInteger(index) || index < 0) throw new Error(`"${parts[1]}" is not a user index`);
    const identity = await deriveIdentity(chain, index);
    return { chain, index, address: identity.address };
  }

  // Otherwise treat it as an address we have issued.
  for (const chain of Object.keys(CHAINS)) {
    const row = repo.findAddress(chain, trimmed);
    if (row) {
      const user = repo.getUserById(row.user_id);
      if (!user) throw new Error('that address has no user attached');
      return { chain, index: user.derivation_index, address: row.address };
    }
  }
  throw new Error(`"${trimmed}" is not an address this gateway issued. Send an address, `
    + 'or a chain and index like "bitcoin 1".');
}

// ------------------------------------------------------------- /withdraw ----

export async function beginWithdraw(chatId: number, args: string[]): Promise<string> {
  start(chatId, 'withdraw', 'currency');
  if (args[0]) return continueFlow(chatId, args[0]);

  const sendable = listCurrencies().filter((c) => canSign(c.chain));
  return [
    b('Withdraw funds'),
    '',
    'Which currency? Send its ticker, for example ' + code('BTC') + '.',
    '',
    b('Available:'),
    esc(sendable.map((c) => c.ticker).join(', ')),
    '',
    'Other chains cannot be sent from here yet — use ' + code('/key') + ' and spend',
    'from a wallet app instead.',
    '',
    `${code('/cancel')} to stop.`,
  ].join('\n');
}

/** Addresses on a chain that actually hold something, with their balances. */
async function fundedAddresses(currency: CurrencyDef) {
  const rows = repo.addressesForChain(currency.chain).slice(0, MAX_ADDRESSES);
  const signer = signerFor(currency.chain);

  const checked = await mapLimit(rows, 3, async (row) => {
    try {
      const balance = await signer.balance(currency, row.address);
      const user = repo.getUserById(row.user_id);
      return { row, balance, index: user?.derivation_index ?? 0 };
    } catch (e) {
      log.warn(`balance lookup failed for ${row.address}`, (e as Error).message);
      return { row, balance: 0n, index: 0 };
    }
  });

  return checked.filter((c) => c.balance > 0n).sort((a, b2) => (b2.balance > a.balance ? 1 : -1));
}

// ------------------------------------------------------- the state machine --

export async function continueFlow(chatId: number, text: string): Promise<string> {
  const flow = flows.get(chatId);
  if (!flow) return 'Nothing in progress. Send /help for the command list.';
  if (Date.now() > flow.expiresAt) {
    flows.delete(chatId);
    return 'That took too long, so it was cancelled. Start again when ready.';
  }

  const answer = text.trim();
  if (/^\/?cancel$/i.test(answer)) {
    flows.delete(chatId);
    return 'Cancelled.';
  }

  try {
    return flow.name === 'key'
      ? await stepKey(chatId, flow, answer)
      : await stepWithdraw(chatId, flow, answer);
  } catch (e) {
    flows.delete(chatId);
    return `${b('Stopped')}\n\n${code((e as Error).message)}`;
  }
}

async function stepKey(chatId: number, flow: Flow, answer: string): Promise<string> {
  if (flow.step === 'target') {
    const target = await resolveTarget(answer);
    const identity = await deriveIdentity(target.chain, target.index);
    advance(chatId, 'confirm', target);
    return [
      b('⚠️ About to reveal a private key'),
      '',
      `Chain: ${code(target.chain)}`,
      `Address: ${code(target.address)}`,
      `User index: ${code(target.index)}`,
      `Path: ${code(identity.path ?? 'n/a')}`,
      '',
      'Anyone who reads this key can take everything at that address.',
      `The message will be deleted after ${KEY_VISIBLE_MS / 1000} seconds, but Telegram may`,
      'have copied it to notifications or another device by then.',
      '',
      `Send ${code('REVEAL')} to continue, or ${code('/cancel')}.`,
    ].join('\n');
  }

  if (flow.step === 'confirm') {
    if (answer !== 'REVEAL') return `Send ${code('REVEAL')} exactly, or ${code('/cancel')}.`;
    flows.delete(chatId);

    const exported = await exportPrivateKey(flow.data.chain, flow.data.index);
    const secret = exported.wif ?? exported.base58 ?? exported.hex;

    const lines = [
      b('Private key'),
      '',
      `Address: ${code(exported.address)}`,
      `Path: ${code(exported.path)}`,
      `Import as: ${esc(exported.importAs)}`,
      '',
      code(secret),
    ];
    if (exported.wif) lines.push('', `Raw hex: ${code(exported.hex)}`);
    lines.push('', `<i>This message self-destructs in ${KEY_VISIBLE_MS / 1000}s.</i>`);

    const ids = await sendMessage(chatId, lines.join('\n'));
    setTimeout(() => {
      for (const id of ids) void deleteMessage(chatId, id);
    }, KEY_VISIBLE_MS).unref?.();

    // The reply itself is already sent above; nothing further to return.
    return '';
  }

  flows.delete(chatId);
  return 'Lost track of that conversation. Start again.';
}

async function stepWithdraw(chatId: number, flow: Flow, answer: string): Promise<string> {
  if (flow.step === 'currency') {
    const currency = resolveCurrency(answer);
    if (!currency) return `Unknown currency ${code(answer)}. Send a ticker like ${code('BTC')}.`;
    if (!canSign(currency.chain)) {
      flows.delete(chatId);
      return `${b(currency.ticker)} cannot be sent from here yet.\n\n`
        + `Use ${code('/key')} to export the private key and spend from a wallet app.`;
    }

    const funded = await fundedAddresses(currency);
    if (funded.length === 0) {
      flows.delete(chatId);
      return `No ${esc(currency.ticker)} found on any address this gateway has issued.`;
    }
    const total = funded.reduce((sum, f) => sum + f.balance, 0n);
    advance(chatId, 'address', {
      currency: currency.ticker,
      funded: funded.map((f) => ({ address: f.row.address, index: f.index, balance: f.balance.toString() })),
      total: total.toString(),
    });

    return [
      b(`${currency.ticker} available: ${fromBaseUnits(total, currency.decimals)}`),
      '',
      ...funded.slice(0, 10).map((f) =>
        `  ${code(f.row.address)}\n    ${esc(fromBaseUnits(f.balance, currency.decimals))}`),
      funded.length > 10 ? `  …and ${funded.length - 10} more` : '',
      '',
      'Where should it go? Send the destination address.',
    ].filter(Boolean).join('\n');
  }

  if (flow.step === 'address') {
    if (answer.length < 20 || /\s/.test(answer)) {
      return 'That does not look like an address. Send the destination address, '
        + `or ${code('/cancel')}.`;
    }
    advance(chatId, 'amount', { destination: answer });
    const currency = resolveCurrency(flow.data.currency)!;
    const total = BigInt(flow.data.total);
    return [
      `Destination: ${code(answer)}`,
      '',
      'How much? Send either:',
      `  • an amount, e.g. ${code('0.01')}`,
      `  • a percentage, e.g. ${code('100%')} or ${code('50%')}`,
      '',
      `Available: ${code(fromBaseUnits(total, currency.decimals))} ${esc(currency.ticker)}`,
    ].join('\n');
  }

  if (flow.step === 'amount') {
    const currency = resolveCurrency(flow.data.currency)!;
    const total = BigInt(flow.data.total);

    let requested: bigint;
    let sweepAll = false;
    const percent = answer.match(/^(\d+(?:\.\d+)?)\s*%$/);

    if (percent || /^(all|max|everything)$/i.test(answer)) {
      const pct = percent ? Number(percent[1]) : 100;
      if (!(pct > 0 && pct <= 100)) return 'A percentage must be above 0 and at most 100%.';
      sweepAll = pct === 100;
      // Percentages are of the total balance; the exact figure for a full
      // sweep is settled at signing time, once fees are known.
      requested = (total * BigInt(Math.round(pct * 100))) / 10000n;
    } else {
      try {
        requested = toBaseUnits(answer.replace(/,/g, ''), currency.decimals);
      } catch (e) {
        return `${esc((e as Error).message)}\n\nSend an amount like ${code('0.01')} or ${code('100%')}.`;
      }
      if (requested <= 0n) return 'The amount must be positive.';
      if (requested > total) {
        return `That is more than the ${code(fromBaseUnits(total, currency.decimals))} available.`;
      }
    }

    advance(chatId, 'confirm', { requested: requested.toString(), sweepAll });
    return [
      b('Confirm this withdrawal'),
      '',
      `Currency: ${code(currency.ticker)}`,
      `Amount: ${code(fromBaseUnits(requested, currency.decimals))}${sweepAll ? ' (everything, less fees)' : ''}`,
      `To: ${code(flow.data.destination)}`,
      `From: ${code(`${flow.data.funded.length} address(es)`)}`,
      '',
      'Network fees come out of this amount. The transaction cannot be reversed.',
      '',
      `Send ${code('YES')} to broadcast, or ${code('/cancel')}.`,
    ].join('\n');
  }

  if (flow.step === 'confirm') {
    if (answer !== 'YES') return `Send ${code('YES')} exactly to broadcast, or ${code('/cancel')}.`;
    flows.delete(chatId);

    const currency = resolveCurrency(flow.data.currency)!;
    const signer = signerFor(currency.chain);
    const funded: { address: string; index: number; balance: string }[] = flow.data.funded;
    const sweepAll: boolean = flow.data.sweepAll;
    let remaining = BigInt(flow.data.requested);

    const results: string[] = [];
    let sentTotal = 0n;

    // Spend address by address until the requested amount is covered. Each is a
    // separate transaction, so a later failure cannot undo an earlier success —
    // hence reporting them individually.
    for (const source of funded) {
      if (remaining <= 0n) break;
      const balance = BigInt(source.balance);
      const takeAll = sweepAll || balance <= remaining;
      const amount = takeAll ? balance : remaining;

      try {
        const result = await signer.send({
          currency,
          fromIndex: source.index,
          fromAddress: source.address,
          toAddress: flow.data.destination,
          amount,
          sweep: takeAll,
        });
        sentTotal += result.sent;
        remaining -= result.sent;
        const link = CHAINS[currency.chain]?.explorerTx?.replace('{tx}', result.txid);
        results.push(`✅ ${esc(fromBaseUnits(result.sent, currency.decimals))} ${esc(currency.ticker)}`
          + (link ? `\n   <a href="${esc(link)}">${esc(result.txid.slice(0, 20))}…</a>` : `\n   ${code(result.txid)}`));
        log.info(`withdrawal broadcast ${result.txid} from ${source.address}`);
      } catch (e) {
        results.push(`❌ ${code(source.address.slice(0, 24) + '…')}\n   ${esc((e as Error).message)}`);
        log.error(`withdrawal from ${source.address} failed`, (e as Error).message);
      }
    }

    return [
      b(sentTotal > 0n ? 'Withdrawal sent' : 'Withdrawal failed'),
      '',
      `Total: ${code(fromBaseUnits(sentTotal, currency.decimals))} ${esc(currency.ticker)}`,
      `To: ${code(flow.data.destination)}`,
      '',
      ...results,
    ].join('\n');
  }

  flows.delete(chatId);
  return 'Lost track of that conversation. Start again.';
}

export { getChain };
