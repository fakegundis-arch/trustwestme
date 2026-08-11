import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../config';
import { logger } from '../util/log';

const log = logger('db');

let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id       TEXT    NOT NULL UNIQUE,
  derivation_index  INTEGER NOT NULL UNIQUE,
  label             TEXT,
  created_at        TEXT    NOT NULL
);

-- One row per (user, chain). Several currencies can share it: ETH and
-- USDT-ERC20 both land on the user's single Ethereum address.
CREATE TABLE IF NOT EXISTS addresses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  chain        TEXT    NOT NULL,
  address      TEXT    NOT NULL,
  tag          TEXT,
  path         TEXT,
  ipn_url      TEXT,
  created_at   TEXT    NOT NULL,
  UNIQUE(user_id, chain)
);
CREATE INDEX IF NOT EXISTS idx_addresses_lookup ON addresses(chain, address);
CREATE INDEX IF NOT EXISTS idx_addresses_tag    ON addresses(chain, tag);

CREATE TABLE IF NOT EXISTS deposits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  uid            TEXT    NOT NULL UNIQUE,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  address_id     INTEGER NOT NULL REFERENCES addresses(id),
  chain          TEXT    NOT NULL,
  currency       TEXT    NOT NULL,
  address        TEXT    NOT NULL,
  tag            TEXT,
  txid           TEXT    NOT NULL,
  output_index   INTEGER NOT NULL DEFAULT 0,
  amount_units   TEXT    NOT NULL,
  confirmations  INTEGER NOT NULL DEFAULT 0,
  block_height   INTEGER,
  status         TEXT    NOT NULL,           -- pending | completed | orphaned
  credited       INTEGER NOT NULL DEFAULT 0, -- 1 once the user balance moved
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  -- The idempotency guarantee: one on-chain output can only ever produce one
  -- deposit row, no matter how many times the watcher sees it.
  UNIQUE(chain, txid, output_index, currency)
);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE INDEX IF NOT EXISTS idx_deposits_user   ON deposits(user_id, currency);

CREATE TABLE IF NOT EXISTS withdrawals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT    NOT NULL UNIQUE,
  currency      TEXT    NOT NULL,
  chain         TEXT    NOT NULL,
  address       TEXT    NOT NULL,
  tag           TEXT,
  amount_units  TEXT    NOT NULL,
  status        TEXT    NOT NULL,   -- created | pending | completed | error
  txid          TEXT,
  error         TEXT,
  description   TEXT,
  request_id    TEXT UNIQUE,        -- caller-supplied idempotency key
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS balances (
  user_id          INTEGER NOT NULL REFERENCES users(id),
  currency         TEXT    NOT NULL,
  available_units  TEXT    NOT NULL DEFAULT '0',
  pending_units    TEXT    NOT NULL DEFAULT '0',
  PRIMARY KEY(user_id, currency)
);

-- Watcher cursor per chain.
CREATE TABLE IF NOT EXISTS chain_state (
  chain        TEXT PRIMARY KEY,
  cursor       TEXT,
  last_run_at  TEXT,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS ipn_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event         TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  payload       TEXT    NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_at       TEXT    NOT NULL,
  status        TEXT    NOT NULL,   -- queued | delivered | failed
  last_error    TEXT,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ipn_pending ON ipn_queue(status, next_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  public_key   TEXT    NOT NULL UNIQUE,
  private_key  TEXT    NOT NULL,
  label        TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL
);

-- Replay protection for signed API requests.
CREATE TABLE IF NOT EXISTS used_nonces (
  public_key  TEXT    NOT NULL,
  nonce       TEXT    NOT NULL,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY(public_key, nonce)
);
CREATE INDEX IF NOT EXISTS idx_nonce_seen ON used_nonces(seen_at);
`;

export function getDb(): Database.Database {
  if (db) return db;
  const dir = path.dirname(config.dbPath);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  log.info(`database ready at ${config.dbPath}`);
  return db;
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}
