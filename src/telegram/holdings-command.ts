import { CHAINS } from '../chains';
import { scanHoldings, nonZero, discrepancies, formatAmount, type HoldingsReport }
  from '../services/holdings';
import { logger } from '../util/log';
import { esc, sendMessage } from './api';

const log = logger('telegram:holdings');

/**
 * `/holdings` — walk every address on chain and report what is actually there.
 *
 * The scan makes one request per address and public endpoints are rate limited,
 * so it can run for a while. Rather than leaving the chat silent, an
 * acknowledgement goes out first and the report follows when it is done.
 */

const b = (s: unknown) => `<b>${esc(s)}</b>`;
const code = (s: unknown) => `<code>${esc(s)}</code>`;

/** One scan at a time per chat: they are slow and hammer the same endpoints. */
const running = new Set<number>();

export async function runHoldingsScan(chatId: number, chainArg?: string): Promise<string> {
  if (running.has(chatId)) {
    return 'A scan is already running. Wait for it to finish.';
  }

  const chain = chainArg?.toLowerCase();
  if (chain && !CHAINS[chain]) {
    return `Unknown chain ${code(chain)}. Try ${code('/chains')} for the list, `
      + `or ${code('/holdings')} for everything.`;
  }

  running.add(chatId);

  // Answer immediately, then do the work — a scan can outlast Telegram's
  // patience for a single reply.
  await sendMessage(chatId, [
    b('Scanning live balances…'),
    '',
    chain ? `Chain: ${code(chain)}` : 'Every chain, every address.',
    '',
    '<i>One request per address against rate-limited endpoints, so this may',
    'take a minute or two. The report follows when it is done.</i>',
  ].join('\n'));

  try {
    const report = await scanHoldings({ chain });
    await sendMessage(chatId, formatReport(report, chain));
  } catch (e) {
    log.error('holdings scan failed', (e as Error).message);
    await sendMessage(chatId, `${b('Scan failed')}\n\n${code((e as Error).message)}`);
  } finally {
    running.delete(chatId);
  }

  // The messages above are sent directly; nothing further to return.
  return '';
}

function formatReport(report: HoldingsReport, chain?: string): string {
  const held = nonZero(report);
  const seconds = Math.round((report.finishedAt.getTime() - report.startedAt.getTime()) / 1000);

  const lines = [
    b(chain ? `Live holdings — ${chain}` : 'Live holdings'),
    '',
    `Scanned ${code(report.addressesScanned)} addresses in ${code(seconds + 's')}`,
    '',
  ];

  if (held.length === 0) {
    lines.push('Nothing held on any scanned address.');
  } else {
    lines.push(b('Held on chain'));
    lines.push('');
    let lastChain = '';
    for (const holding of held) {
      if (holding.chain !== lastChain) {
        lines.push(`<u>${esc(holding.chain)}</u>`);
        lastChain = holding.chain;
      }
      lines.push(`  ${b(holding.ticker)}: ${code(formatAmount(holding, holding.onChain))}`);
      // Show where it sits, so a sweep can be aimed without another lookup.
      for (const entry of holding.addresses.slice(0, 3)) {
        const who = entry.user ? ` (${esc(entry.user)})` : '';
        lines.push(`      ${code(entry.address)}${who}`);
        lines.push(`      ${esc(formatAmount(holding, entry.amount))}`);
      }
      if (holding.addresses.length > 3) {
        lines.push(`      …and ${holding.addresses.length - 3} more addresses`);
      }
    }
  }

  // The ledger and the chain should agree; where they do not, say so.
  const mismatched = discrepancies(report);
  if (mismatched.length > 0) {
    lines.push('', b('Chain vs credited ledger'));
    lines.push('<i>Credited is what users are owed; on-chain is what is really there.</i>');
    lines.push('');
    for (const holding of mismatched.slice(0, 12)) {
      const onChain = formatAmount(holding, holding.onChain);
      const credited = formatAmount(holding, holding.credited);
      const symbol = holding.onChain > holding.credited ? '▲' : '▼';
      lines.push(`  ${symbol} ${b(holding.ticker)} — chain ${code(onChain)}, `
        + `credited ${code(credited)}`);
    }
    if (mismatched.length > 12) lines.push(`  …and ${mismatched.length - 12} more`);
  }

  if (report.failures.length > 0) {
    lines.push('', b('Could not read'));
    for (const failure of report.failures.slice(0, 10)) {
      lines.push(`  ${esc(failure.chain)}: ${esc(failure.reason)}`);
    }
  }

  if (report.truncated) {
    lines.push('', '<i>Some chains have more addresses than one scan covers; '
      + 'the totals above are partial.</i>');
  }

  return lines.join('\n');
}
