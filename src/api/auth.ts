import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { findApiKey, consumeNonce } from '../db/repo';
import { logger } from '../util/log';

const log = logger('auth');

/**
 * Two API keys, exactly as WestWallet issues them:
 *
 *   public key  — identifies you, sent in the clear as `X-API-KEY`
 *   private key — never transmitted; used to sign each request
 *
 * Three signing schemes are understood. `AUTH_MODE=auto` (the default) accepts
 * whichever one the caller used, which is what lets an existing WestWallet
 * integration keep working untouched while new code can use something simpler.
 * All three require the private key, so accepting any of them costs nothing.
 *
 * --- westwallet (what the official WestWallet SDKs send) -------------------
 *   X-API-KEY:           <public key>
 *   X-ACCESS-TIMESTAMP:  <unix seconds>
 *   X-ACCESS-SIGN:       hex( HMAC-SHA256( private key, timestamp + body ) )
 *
 *   `body` is the JSON request body exactly as the client serialised it — for
 *   GET requests, the JSON serialisation of the query parameters. Because
 *   different languages serialise JSON differently (Python puts a space after
 *   ':' and ',', most others do not), GET requests are checked against several
 *   plausible encodings. POST is verified against the raw bytes received, so
 *   it is exact.
 *
 * --- hmac ------------------------------------------------------------------
 *   X-API-KEY / X-Nonce / X-Signature
 *   signature = hex( HMAC-SHA256( private key, nonce + public key ) )
 *
 * --- simple (only acceptable behind TLS or on localhost) -------------------
 *   X-API-KEY / X-API-SECRET
 */

export interface AuthedRequest extends Request {
  apiKey?: string;
  rawBody?: string;
}

function hmacHex(key: string, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function resolveKey(publicKey: string): { public_key: string; private_key: string } | null {
  if (config.apiPublicKey && publicKey === config.apiPublicKey && config.apiPrivateKey) {
    return { public_key: config.apiPublicKey, private_key: config.apiPrivateKey };
  }
  const row = findApiKey(publicKey);
  return row ? { public_key: row.public_key, private_key: row.private_key } : null;
}

function header(req: Request, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
}

/**
 * The payloads a WestWallet client might have signed for this request.
 *
 * For a POST we have the exact bytes. For a GET the client signed a JSON dump
 * of its query parameters, which we have to rebuild — hence several candidates
 * covering the serialisation styles different languages produce.
 */
function signedPayloadCandidates(req: AuthedRequest): string[] {
  const out: string[] = [];

  if (req.method !== 'GET') {
    const raw = req.rawBody ?? '';
    out.push(raw);
    // Some clients sign a compact re-encoding rather than what they transmit.
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        out.push(JSON.stringify(parsed), pythonJson(parsed), JSON.stringify(sortKeys(parsed)));
      } catch { /* not JSON; the raw form above is all we have */ }
    } else {
      out.push('{}', '');
    }
    return dedupe(out);
  }

  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) {
    query[k] = Array.isArray(v) ? String(v[0]) : String(v);
  }
  out.push(
    JSON.stringify(query),          // {"currency":"BTC"}
    pythonJson(query),              // {"currency": "BTC"}
    JSON.stringify(sortKeys(query)),
    pythonJson(sortKeys(query)),
    // The JS client signs the timestamp alone when it sends no body, even
    // though the parameters travel in the query string.
    '',
    '{}',
  );
  return dedupe(out);
}

/**
 * Serialise the way Python's json.dumps does by default, whose separators are
 * ", " and ": " rather than the "," and ":" every other language emits.
 * Written out properly rather than by patching JSON.stringify's output, which
 * cannot distinguish a separator from the same characters inside a string.
 */
function pythonJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(pythonJson).join(', ') + ']';
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}: ${pythonJson(v)}`);
    return '{' + entries.join(', ') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as object).sort()) {
    out[k] = (value as Record<string, unknown>)[k];
  }
  return out;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function timestampFresh(raw: string, res: Response): boolean {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    deny(res, 'timestamp header must be a unix timestamp');
    return false;
  }
  // Tolerate clients that send milliseconds.
  const seconds = value > 1e11 ? Math.floor(value / 1000) : value;
  const skew = Math.abs(Math.floor(Date.now() / 1000) - seconds);
  if (skew > config.authNonceWindowSec) {
    deny(res, `timestamp is ${skew}s off; allowed window is ${config.authNonceWindowSec}s. `
      + 'Check the clock on both machines (timedatectl).');
    return false;
  }
  return true;
}

export function authenticate(req: AuthedRequest, res: Response, next: NextFunction) {
  const publicKey = header(req, 'x-api-key');
  if (!publicKey) return deny(res, 'missing X-API-KEY header');

  const key = resolveKey(publicKey);
  // The same message whether the key is unknown or the signature is wrong, so
  // this cannot be used to enumerate valid public keys.
  if (!key) return deny(res, 'invalid credentials');

  const mode = config.authMode;
  const accessSign = header(req, 'x-access-sign');
  const accessTs = header(req, 'x-access-timestamp');
  const nonce = header(req, 'x-nonce');
  const signature = header(req, 'x-signature');
  const secret = header(req, 'x-api-secret');

  const allow = (scheme: string) => mode === 'auto' || mode === scheme;

  // --- WestWallet-compatible -----------------------------------------------
  if (allow('westwallet') && accessSign && accessTs) {
    if (!timestampFresh(accessTs, res)) return;

    const candidates = signedPayloadCandidates(req);
    const received = accessSign.toLowerCase();
    for (const payload of candidates) {
      if (safeEqual(received, hmacHex(key.private_key, accessTs + payload))) {
        req.apiKey = publicKey;
        return next();
      }
    }

    if (config.authDebug) {
      log.warn(`X-ACCESS-SIGN mismatch on ${req.method} ${req.originalUrl}`);
      log.warn(`  received signature: ${received}`);
      log.warn(`  timestamp: ${accessTs}`);
      log.warn(`  raw body: ${JSON.stringify(req.rawBody ?? '')}`);
      for (const payload of candidates) {
        log.warn(`  tried ${JSON.stringify(accessTs + payload)}`
          + ` -> ${hmacHex(key.private_key, accessTs + payload)}`);
      }
    }
    return deny(res, 'invalid signature'
      + (config.authDebug ? '' : ' (set AUTH_DEBUG=true to see what was signed)'));
  }

  // --- nonce + public key --------------------------------------------------
  if (allow('hmac') && nonce && signature) {
    if (!timestampFresh(nonce, res)) return;
    if (!safeEqual(signature.toLowerCase(), hmacHex(key.private_key, nonce + publicKey))) {
      return deny(res, 'invalid credentials');
    }
    // Reject replays of an otherwise valid signed request.
    if (!consumeNonce(publicKey, nonce, config.authNonceWindowSec)) {
      return deny(res, 'nonce already used');
    }
    req.apiKey = publicKey;
    return next();
  }

  // --- shared secret -------------------------------------------------------
  if (allow('simple') && secret) {
    if (!safeEqual(secret, key.private_key)) return deny(res, 'invalid credentials');
    req.apiKey = publicKey;
    return next();
  }

  return deny(res, 'no recognised authentication headers. Send either '
    + 'X-ACCESS-SIGN + X-ACCESS-TIMESTAMP (WestWallet style), '
    + 'X-Nonce + X-Signature, or X-API-SECRET.');
}

function deny(res: Response, message: string) {
  log.warn(`auth rejected: ${message}`);
  res.status(401).json({ error: 'unauthorized', message });
}

/** Build WestWallet-style headers. Mirrors what the official SDKs send. */
export function signWestWallet(
  publicKey: string, privateKey: string, body: string, timestamp = Math.floor(Date.now() / 1000),
) {
  return {
    'X-API-KEY': publicKey,
    'X-ACCESS-TIMESTAMP': String(timestamp),
    'X-ACCESS-SIGN': hmacHex(privateKey, String(timestamp) + body),
  };
}

/** Build headers for the nonce scheme. Used by the test suite and self-test. */
export function signRequest(publicKey: string, privateKey: string, nonce = Math.floor(Date.now() / 1000)) {
  return {
    'X-API-KEY': publicKey,
    'X-Nonce': String(nonce),
    'X-Signature': hmacHex(privateKey, String(nonce) + publicKey),
  };
}
