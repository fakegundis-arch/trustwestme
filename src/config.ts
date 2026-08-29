import * as fs from 'node:fs';
import * as path from 'node:path';

/** Minimal .env loader so there is no extra dependency. */
function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv(path.resolve(process.cwd(), '.env'));

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required env var ${key}`);
  }
  return v;
}
function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env var ${key} must be a number`);
  return n;
}
function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

export const config = {
  env: str('NODE_ENV', 'development'),
  port: num('PORT', 8080),
  host: str('HOST', '0.0.0.0'),
  dbPath: str('DB_PATH', path.resolve(process.cwd(), 'data/gateway.db')),

  /**
   * The master seed. Every user deposit address on every chain is derived from
   * this one mnemonic — this is the "one main wallet, a sub-account per user"
   * model. Import it into the Trust Wallet app and you see every user's funds.
   *
   * Treat this string as the entire value of the exchange. It should live in a
   * secrets manager, never in git, and ideally never on the machine that is
   * exposed to the internet (see WATCH_ONLY below).
   */
  mnemonic: process.env.MASTER_MNEMONIC || '',
  mnemonicPassphrase: str('MASTER_MNEMONIC_PASSPHRASE', ''),

  /**
   * Watch-only mode. When on, the process refuses to load the mnemonic and can
   * only serve addresses already recorded in the database, so a compromised web
   * box cannot spend. Generate addresses in advance with `npm run addresses`.
   */
  watchOnly: bool('WATCH_ONLY', false),

  /** API credentials issued to your exchange. See `npm run keys`. */
  apiPublicKey: process.env.API_PUBLIC_KEY || '',
  apiPrivateKey: process.env.API_PRIVATE_KEY || '',
  /**
   * 'auto'       accept any supported scheme (default — best for migration)
   * 'westwallet' X-ACCESS-SIGN + X-ACCESS-TIMESTAMP, as the WestWallet SDKs send
   * 'hmac'       X-Nonce + X-Signature over (nonce + public key)
   * 'simple'     X-API-KEY + X-API-SECRET
   */
  authMode: str('AUTH_MODE', 'auto') as 'auto' | 'westwallet' | 'hmac' | 'simple',
  /** Reject signed requests whose timestamp is further off than this. */
  authNonceWindowSec: num('AUTH_NONCE_WINDOW_SEC', 300),
  /**
   * Log what a failing signature was computed over. Invaluable when matching an
   * existing integration; leave off in normal running.
   */
  authDebug: bool('AUTH_DEBUG', false),

  /** Secret used to sign outgoing IPN callbacks to your exchange. */
  ipnSecret: process.env.IPN_SECRET || '',
  ipnTimeoutMs: num('IPN_TIMEOUT_MS', 15000),
  ipnMaxAttempts: num('IPN_MAX_ATTEMPTS', 12),

  /** Deposit scanner. */
  watcherEnabled: bool('WATCHER_ENABLED', true),
  watcherIntervalMs: num('WATCHER_INTERVAL_MS', 30000),
  /** Chains to scan; empty means all configured ones. */
  watcherChains: (process.env.WATCHER_CHAINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  /**
   * Per-chain data sources. All have working public defaults.
   *
   * Each accepts a comma-separated list and they are tried in order, because a
   * single free endpoint will eventually rate-limit, block or go down, and one
   * unreachable host should not stop a chain being scanned.
   */
  rpc: {
    bitcoin: str('BTC_BLOCKBOOK_URL', 'https://btc1.trezor.io,https://btc2.trezor.io'),
    litecoin: str('LTC_BLOCKBOOK_URL', 'https://ltc1.trezor.io,https://ltc2.trezor.io'),
    dogecoin: str('DOGE_BLOCKBOOK_URL', 'https://doge1.trezor.io,https://doge2.trezor.io'),
    dash: str('DASH_BLOCKBOOK_URL', 'https://dash1.trezor.io,https://dash2.trezor.io'),
    bitcoincash: str('BCH_BLOCKBOOK_URL', 'https://bch1.trezor.io,https://bch2.trezor.io'),
    zcash: str('ZEC_BLOCKBOOK_URL', 'https://zec1.trezor.io,https://zec2.trezor.io'),
    ethereum: str('ETH_RPC_URL',
      'https://eth.llamarpc.com,https://rpc.ankr.com/eth,https://ethereum-rpc.publicnode.com'),
    bsc: str('BSC_RPC_URL',
      'https://bsc-dataseed.binance.org,https://bsc-dataseed1.defibit.io,https://bsc-rpc.publicnode.com'),
    /**
     * Second source for the UTXO chains, used when Blockbook refuses. Free
     * without a key but heavily rate limited; a key raises the allowance.
     */
    blockchair: str('BLOCKCHAIR_API_URL', 'https://api.blockchair.com'),
    blockchairKey: process.env.BLOCKCHAIR_API_KEY || '',

    tron: str('TRON_API_URL', 'https://api.trongrid.io'),
    tronApiKey: process.env.TRON_API_KEY || '',
    solana: str('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
    xrp: str('XRP_RPC_URL', 'https://xrplcluster.com'),
    stellar: str('STELLAR_HORIZON_URL', 'https://horizon.stellar.org'),
    eos: str('EOS_API_URL', 'https://eos.greymass.com'),
    tezos: str('TEZOS_API_URL', 'https://api.tzkt.io'),
    monero: str('MONERO_WALLET_RPC_URL', 'http://127.0.0.1:18083'),
    moneroUser: process.env.MONERO_WALLET_RPC_USER || '',
    moneroPass: process.env.MONERO_WALLET_RPC_PASSWORD || '',
  },

  /**
   * The single receiving account on tag/memo chains. These are derived from
   * your seed at index 0, but XRP/XLM accounts must be activated with a reserve
   * and EOS needs a registered account name, so you set the live values here
   * once they exist.
   */
  shared: {
    xrpAddress: process.env.XRP_ADDRESS || '',
    stellarAddress: process.env.STELLAR_ADDRESS || '',
    eosAccount: process.env.EOS_ACCOUNT || '',
  },

  /** Number of blocks to re-scan on startup, to catch anything missed. */
  reorgDepth: num('REORG_DEPTH', 50),

  /**
   * How far behind the chain head the EVM scanner is willing to start.
   * Free RPC providers charge for, or refuse, requests for older blocks
   * ("archive requests"), so after a long outage the cursor is fast-forwarded
   * and the gap reported rather than every request failing.
   */
  evmMaxLookback: num('EVM_MAX_LOOKBACK_BLOCKS', 5000),

  /**
   * Requests per second per host. Public endpoints publish tight limits and
   * suspend the caller for seconds when they are exceeded, so it is better to
   * pace requests than to be refused.
   */
  rateLimits: {
    'api.trongrid.io': num('TRON_RPS', process.env.TRON_API_KEY ? 10 : 2),
    'btc1.trezor.io': num('BLOCKBOOK_RPS', 3),
    'btc2.trezor.io': num('BLOCKBOOK_RPS', 3),
    'ltc1.trezor.io': num('BLOCKBOOK_RPS', 3),
    'ltc2.trezor.io': num('BLOCKBOOK_RPS', 3),
    'doge1.trezor.io': num('BLOCKBOOK_RPS', 3),
    'doge2.trezor.io': num('BLOCKBOOK_RPS', 3),
    'dash1.trezor.io': num('BLOCKBOOK_RPS', 3),
    'dash2.trezor.io': num('BLOCKBOOK_RPS', 3),
    'bch1.trezor.io': num('BLOCKBOOK_RPS', 3),
    'bch2.trezor.io': num('BLOCKBOOK_RPS', 3),
    'zec1.trezor.io': num('BLOCKBOOK_RPS', 3),
    'zec2.trezor.io': num('BLOCKBOOK_RPS', 3),
    'api.mainnet-beta.solana.com': num('SOLANA_RPS', 4),
    // Blockchair's free tier is about one request every two seconds.
    'api.blockchair.com': num('BLOCKCHAIR_RPS', process.env.BLOCKCHAIR_API_KEY ? 5 : 0.5),
  } as Record<string, number>,

  /**
   * Telegram control bot. Uses long polling, so the gateway does not need a
   * public URL or a webhook — it works from behind NAT.
   */
  telegram: {
    enabled: bool('TELEGRAM_ENABLED', !!process.env.TELEGRAM_BOT_TOKEN),
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    apiUrl: str('TELEGRAM_API_URL', 'https://api.telegram.org'),
    /** The master chat: startup banner and deposit alerts land here. */
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    /**
     * Chats allowed to issue commands. Defaults to the master chat alone.
     * Anyone not on this list is ignored — without it, whoever finds the bot
     * could read every balance in the exchange.
     */
    adminChatIds: (process.env.TELEGRAM_ADMIN_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    /** Alert on first sight as well as on crediting. */
    notifyPending: bool('TELEGRAM_NOTIFY_PENDING', true),
    /** Send the command list to the master chat on startup. */
    announceOnStart: bool('TELEGRAM_ANNOUNCE_ON_START', true),
  },
};

export function assertSpendCapable() {
  if (config.watchOnly) throw new Error('server is in WATCH_ONLY mode');
  if (!config.mnemonic) throw new Error('MASTER_MNEMONIC is not configured');
}
