import { config } from '../config';
import { CHAINS } from '../chains';
import { CURRENCIES, listCurrencies, resolveCurrency } from '../currencies';
import { fromBaseUnits } from '../util/decimal';
import { requiredConfirmations } from '../api/serialize';
import { getDepositIdentity } from '../services/addresses';
import * as repo from '../db/repo';
import { getDb } from '../db/index';
import { esc } from './api';

export interface Command {
  name: string;
  args?: string;
  description: string;
  /** `chatId` is passed so multi-step commands can track their conversation. */
  run: (args: string[], chatId: number) => Promise<string>;
}

const b = (s: unknown) => `<b>${esc(s)}</b>`;
const code = (s: unknown) => `<code>${esc(s)}</code>`;

/** Format a base-unit amount for display. */
function amount(units: string | bigint, currency: string): string {
  const decimals = CURRENCIES[currency]?.decimals ?? 8;
  return fromBaseUnits(typeof units === 'bigint' ? units : BigInt(units), decimals);
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(secs)) return 'unknown';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function buildCommands(): Command[] {
  const commands: Command[] = [
    {
      name: 'help',
      description: 'Show every command',
      run: async () => helpText(commands),
    },

    {
      name: 'status',
      description: 'Gateway and watcher health',
      run: async () => {
        const states = repo.chainStates();
        const errored = states.filter((s) => s.last_error);
        const lines = [
          b('Gateway status'),
          '',
          `Mode: ${code(config.watchOnly ? 'WATCH-ONLY' : 'full')}`,
          `Watcher: ${code(config.watcherEnabled ? 'on' : 'off')} every ${config.watcherIntervalMs / 1000}s`,
          `Chains tracked: ${code(states.length)}`,
          `Chains with errors: ${code(errored.length)}`,
          '',
        ];
        if (errored.length) {
          lines.push(b('Errors'));
          for (const s of errored.slice(0, 8)) {
            lines.push(`• ${esc(s.chain)}: ${code(String(s.last_error).slice(0, 120))}`);
          }
          lines.push('');
        }
        const pending = repo.pendingDeposits().length;
        lines.push(`Pending deposits: ${code(pending)}`);
        lines.push(`Users: ${code(repo.listUsers().length)}`);
        return lines.join('\n');
      },
    },

    {
      name: 'stats',
      description: 'Totals across the whole gateway',
      run: async () => {
        const db = getDb();
        const deposits = db.prepare(
          `SELECT status, COUNT(*) AS n FROM deposits GROUP BY status`,
        ).all() as { status: string; n: number }[];
        const withdrawals = db.prepare(
          `SELECT status, COUNT(*) AS n FROM withdrawals GROUP BY status`,
        ).all() as { status: string; n: number }[];

        const lines = [b('Gateway stats'), ''];
        lines.push(`Users: ${code(repo.listUsers().length)}`);
        lines.push('');
        lines.push(b('Deposits'));
        if (!deposits.length) lines.push('  none yet');
        for (const d of deposits) lines.push(`  ${esc(d.status)}: ${code(d.n)}`);
        lines.push('');
        lines.push(b('Withdrawals'));
        if (!withdrawals.length) lines.push('  none yet');
        for (const w of withdrawals) lines.push(`  ${esc(w.status)}: ${code(w.n)}`);

        const held = listCurrencies()
          .map((c) => ({ ticker: c.ticker, total: repo.getTotalBalance(c.ticker) }))
          .filter((x) => x.total > 0n);
        lines.push('');
        lines.push(b('Credited balances'));
        if (!held.length) lines.push('  nothing credited yet');
        for (const h of held) lines.push(`  ${esc(h.ticker)}: ${code(amount(h.total, h.ticker))}`);
        return lines.join('\n');
      },
    },

    {
      name: 'balances',
      description: 'Every currency with a non-zero balance',
      run: async () => {
        const rows = listCurrencies()
          .map((c) => ({ ticker: c.ticker, total: repo.getTotalBalance(c.ticker) }))
          .filter((r) => r.total > 0n);
        if (!rows.length) return `${b('Balances')}\n\nNothing credited yet.`;
        return [b('Balances'), '', ...rows.map((r) => `${esc(r.ticker)}: ${code(amount(r.total, r.ticker))}`)]
          .join('\n');
      },
    },

    {
      name: 'balance',
      args: '<CURRENCY> [user]',
      description: 'Balance for a currency, optionally for one user',
      run: async ([currencyRaw, label]) => {
        if (!currencyRaw) return 'Usage: /balance &lt;CURRENCY&gt; [user]';
        const cur = resolveCurrency(currencyRaw);
        if (!cur) return `Unknown currency ${code(currencyRaw)}. Try /currencies`;

        if (label) {
          const user = repo.getUserByExternalId(label);
          if (!user) return `No user ${code(label)}`;
          const bal = repo.getBalance(user.id, cur.ticker);
          return [
            b(`${cur.ticker} — ${label}`), '',
            `Available: ${code(amount(bal.available, cur.ticker))}`,
            `Pending: ${code(amount(bal.pending, cur.ticker))}`,
          ].join('\n');
        }
        return `${b(cur.ticker)}\n\nTotal credited: ${code(amount(repo.getTotalBalance(cur.ticker), cur.ticker))}`;
      },
    },

    {
      name: 'user',
      args: '<label>',
      description: 'A user\'s addresses and balances',
      run: async ([label]) => {
        if (!label) return 'Usage: /user &lt;label&gt;';
        const user = repo.getUserByExternalId(label);
        if (!user) return `No user ${code(label)}`;

        const lines = [b(`User ${label}`), '', `Derivation index: ${code(user.derivation_index)}`,
          `Created: ${esc(user.created_at)}`, ''];

        const addresses = getDb().prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY chain')
          .all(user.id) as repo.AddressRow[];
        lines.push(b('Addresses'));
        if (!addresses.length) lines.push('  none issued yet');
        for (const a of addresses) {
          const tag = a.tag ? ` (${CHAINS[a.chain]?.tagName ?? 'tag'}: ${esc(a.tag)})` : '';
          lines.push(`  ${esc(a.chain)}: ${code(a.address)}${tag}`);
        }

        const balances = getDb().prepare(
          "SELECT currency, available_units FROM balances WHERE user_id = ? AND available_units != '0'",
        ).all(user.id) as { currency: string; available_units: string }[];
        lines.push('');
        lines.push(b('Balances'));
        if (!balances.length) lines.push('  nothing credited');
        for (const bal of balances) {
          lines.push(`  ${esc(bal.currency)}: ${code(amount(bal.available_units, bal.currency))}`);
        }
        return lines.join('\n');
      },
    },

    {
      name: 'address',
      args: '<label> <CURRENCY>',
      description: 'Show or create a deposit address',
      run: async ([label, currency]) => {
        if (!label || !currency) return 'Usage: /address &lt;label&gt; &lt;CURRENCY&gt;';
        try {
          const id = await getDepositIdentity({ userExternalId: label, currency });
          const lines = [
            b(`${id.currency} deposit address`), '',
            `User: ${code(label)}`,
            `Address: ${code(id.address)}`,
          ];
          if (id.tag) lines.push(`${b(id.tagName ?? 'Tag')}: ${code(id.tag)} — required, or the deposit is lost`);
          lines.push(`Chain: ${esc(id.chain)}`);
          lines.push(`Confirmations needed: ${code(requiredConfirmations(id.currency))}`);
          if (id.sharedWith.length) lines.push(`Also receives: ${esc(id.sharedWith.join(', '))}`);
          return lines.join('\n');
        } catch (e) {
          return `Could not issue an address: ${code((e as Error).message)}`;
        }
      },
    },

    {
      name: 'deposits',
      args: '[count]',
      description: 'Most recent deposits',
      run: async ([countRaw]) => {
        const limit = Math.min(Number(countRaw) || 10, 30);
        const rows = repo.listDeposits({ limit });
        if (!rows.length) return 'No deposits yet.';
        return [b(`Last ${rows.length} deposits`), '', ...rows.map(depositLine)].join('\n');
      },
    },

    {
      name: 'pending',
      description: 'Deposits still waiting on confirmations',
      run: async () => {
        const rows = repo.pendingDeposits();
        if (!rows.length) return 'Nothing pending.';
        return [b(`${rows.length} pending`), '', ...rows.slice(0, 25).map(depositLine)].join('\n');
      },
    },

    {
      name: 'tx',
      args: '<id>',
      description: 'Look up one transaction',
      run: async ([id]) => {
        if (!id) return 'Usage: /tx &lt;id&gt;';
        const dep = repo.getDepositByUid(id);
        if (dep) {
          const user = repo.getUserById(dep.user_id);
          const link = CHAINS[dep.chain]?.explorerTx?.replace('{tx}', dep.txid);
          return [
            b('Deposit'), '',
            `Id: ${code(dep.uid)}`,
            `User: ${code(user?.external_id ?? '?')}`,
            `Amount: ${code(amount(dep.amount_units, dep.currency))} ${esc(dep.currency)}`,
            `Status: ${code(dep.status)}${dep.credited ? ' (credited)' : ''}`,
            `Confirmations: ${code(`${dep.confirmations}/${requiredConfirmations(dep.currency)}`)}`,
            `Address: ${code(dep.address)}`,
            dep.tag ? `Tag: ${code(dep.tag)}` : '',
            `Hash: ${code(dep.txid)}`,
            link ? `<a href="${esc(link)}">View on explorer</a>` : '',
            `Seen: ${esc(dep.created_at)}`,
          ].filter(Boolean).join('\n');
        }
        const wd = repo.getWithdrawalByUid(id);
        if (wd) {
          return [
            b('Withdrawal'), '',
            `Id: ${code(wd.uid)}`,
            `Amount: ${code(amount(wd.amount_units, wd.currency))} ${esc(wd.currency)}`,
            `To: ${code(wd.address)}`,
            `Status: ${code(wd.status)}`,
            wd.txid ? `Hash: ${code(wd.txid)}` : '',
          ].filter(Boolean).join('\n');
        }
        return `No transaction ${code(id)}`;
      },
    },

    {
      name: 'withdrawals',
      args: '[count]',
      description: 'Most recent withdrawals',
      run: async ([countRaw]) => {
        const limit = Math.min(Number(countRaw) || 10, 30);
        const rows = repo.listWithdrawals({ limit });
        if (!rows.length) return 'No withdrawals yet.';
        return [b(`Last ${rows.length} withdrawals`), '', ...rows.map((w) =>
          `${statusIcon(w.status)} ${code(amount(w.amount_units, w.currency))} ${esc(w.currency)} → `
          + `${code(w.address.slice(0, 16) + '…')} ${esc(w.status)}`)].join('\n');
      },
    },

    {
      name: 'chains',
      description: 'Per-chain watcher state',
      run: async () => {
        const states = new Map(repo.chainStates().map((s) => [s.chain, s]));
        const lines = [b('Chains'), ''];
        for (const chain of Object.keys(CHAINS)) {
          const s = states.get(chain);
          const icon = !s ? '⚪' : s.last_error ? '🔴' : '🟢';
          const detail = !s ? 'not scanned yet'
            : s.last_error ? `error: ${String(s.last_error).slice(0, 60)}`
            : `ok, ${ago(s.last_run_at)}`;
          lines.push(`${icon} ${esc(chain)} — ${esc(detail)}`);
        }
        return lines.join('\n');
      },
    },

    {
      name: 'currencies',
      description: 'Every supported currency',
      run: async () => {
        const byChain = new Map<string, string[]>();
        for (const c of listCurrencies()) {
          if (!byChain.has(c.chain)) byChain.set(c.chain, []);
          byChain.get(c.chain)!.push(c.ticker);
        }
        const lines = [b(`${listCurrencies().length} currencies`), ''];
        for (const [chain, tickers] of byChain) {
          lines.push(`${b(chain)}: ${esc(tickers.join(', '))}`);
        }
        return lines.join('\n');
      },
    },

    {
      name: 'scan',
      args: '[chain]',
      description: 'Force a scan now instead of waiting',
      run: async ([chain]) => {
        const { runOnce, buildProviders } = await import('../watcher/index');
        if (chain) {
          const provider = buildProviders().find((p) => p.chain === chain);
          if (!provider) return `No watcher for ${code(chain)}. Try /chains`;
          const { scanChain } = await import('../watcher/index');
          const res = await scanChain(provider);
          return `Scanned ${b(chain)}: ${code(res.seen)} observed, ${code(res.credited)} credited.`;
        }
        // Deliberately not awaited — a full sweep outlasts Telegram's timeout.
        void runOnce();
        return 'Scan started across every chain. Watch /status or wait for alerts.';
      },
    },

    {
      name: 'ipn',
      description: 'Callback queue health',
      run: async () => {
        const rows = getDb().prepare('SELECT status, COUNT(*) AS n FROM ipn_queue GROUP BY status')
          .all() as { status: string; n: number }[];
        if (!rows.length) return 'No callbacks queued yet.';
        const lines = [b('IPN queue'), '', ...rows.map((r) => `${esc(r.status)}: ${code(r.n)}`)];
        const failed = getDb().prepare(
          "SELECT event, url, last_error FROM ipn_queue WHERE status = 'failed' ORDER BY id DESC LIMIT 5",
        ).all() as { event: string; url: string; last_error: string }[];
        if (failed.length) {
          lines.push('', b('Recent failures'));
          for (const f of failed) {
            lines.push(`• ${esc(f.event)} → ${esc(String(f.last_error).slice(0, 80))}`);
          }
        }
        return lines.join('\n');
      },
    },

    {
      name: 'logs',
      args: '[count] [errors]',
      description: 'Recent log lines from the log file',
      run: async (args) => {
        const { readLogTail, logFilePath } = await import('../util/log');
        const file = logFilePath();
        if (!file) {
          return `File logging is off. Set ${code('LOG_FILE')} in .env to enable it.`;
        }

        const count = Math.min(Number(args.find((a) => /^\d+$/.test(a))) || 25, 60);
        const onlyErrors = args.some((a) => /^(error|errors|err|warn)$/i.test(a));
        const lines = readLogTail(count, onlyErrors ? /\b(ERROR|WARN)\b/ : undefined);

        if (lines.length === 0) {
          return onlyErrors
            ? 'No errors or warnings in the recent log.'
            : `Nothing in the log yet.\n\nFile: ${code(file)}`;
        }
        return [
          b(`Last ${lines.length} lines${onlyErrors ? ' (errors and warnings)' : ''}`),
          '',
          // <pre> keeps the alignment readable on a phone.
          `<pre>${esc(lines.join('\n'))}</pre>`,
        ].join('\n');
      },
    },

    {
      name: 'holdings',
      args: '[chain]',
      description: 'Scan every address on chain and report what is really held',
      run: async (args, chatId) => {
        const { runHoldingsScan } = await import('./holdings-command');
        return runHoldingsScan(chatId, args[0]);
      },
    },

    {
      name: 'key',
      args: '[address|chain index]',
      description: 'Reveal a private key (asks for confirmation first)',
      run: async (args, chatId) => {
        const { beginKey } = await import('./conversation');
        return beginKey(chatId, args);
      },
    },

    {
      name: 'withdraw',
      args: '[CURRENCY]',
      description: 'Send funds out — asks for destination and amount',
      run: async (args, chatId) => {
        const { beginWithdraw } = await import('./conversation');
        return beginWithdraw(chatId, args);
      },
    },

    {
      name: 'cancel',
      description: 'Stop whatever command is waiting on an answer',
      run: async (_args, chatId) => {
        const { cancelFlow } = await import('./conversation');
        return cancelFlow(chatId) ? 'Cancelled.' : 'Nothing in progress.';
      },
    },

    {
      name: 'users',
      args: '[count]',
      description: 'Most recently created users',
      run: async ([countRaw]) => {
        const limit = Math.min(Number(countRaw) || 10, 30);
        const rows = repo.listUsers().slice(-limit).reverse();
        if (!rows.length) return 'No users yet.';
        return [b(`${rows.length} users`), '', ...rows.map((u) =>
          `${code(u.external_id)} — index ${u.derivation_index}`)].join('\n');
      },
    },
  ];

  return commands;
}

function statusIcon(status: string): string {
  switch (status) {
    case 'completed': return '✅';
    case 'pending': return '🟡';
    case 'error': return '🔴';
    default: return '⚪';
  }
}

function depositLine(d: repo.DepositRow): string {
  const user = repo.getUserById(d.user_id);
  const conf = d.status === 'pending' ? ` (${d.confirmations}/${requiredConfirmations(d.currency)})` : '';
  return `${statusIcon(d.status)} ${code(amount(d.amount_units, d.currency))} ${esc(d.currency)}`
    + ` — ${esc(user?.external_id ?? '?')}${esc(conf)}`;
}

export function helpText(commands: Command[]): string {
  const lines = [
    b('trustwestme control bot'),
    '',
    'Commands:',
    '',
  ];
  for (const c of commands) {
    const usage = c.args ? `/${c.name} ${c.args}` : `/${c.name}`;
    lines.push(`${code(usage)}\n   ${esc(c.description)}`);
  }
  lines.push('');
  lines.push('Deposit alerts arrive here automatically.');
  return lines.join('\n');
}
