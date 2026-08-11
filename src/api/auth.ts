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
 * AUTH_MODE=hmac (default, WestWallet-compatible):
 *   X-API-KEY:   <public key>
 *   X-Nonce:     <unix seconds, must be fresh and never reused>
 *   X-Signature: hex( HMAC-SHA256( key = private key, msg = nonce + public key ) )
 *
 * AUTH_MODE=simple (easier to wire up, only safe over TLS):
 *   X-API-KEY:    <public key>
 *   X-API-SECRET: <private key>
 *
 * If your existing WestWallet integration signs slightly differently, change
 * `buildSignature` below — it is the single place the scheme is defined.
 */

export interface AuthedRequest extends Request {
  apiKey?: string;
}

function buildSignature(privateKey: string, nonce: string, publicKey: string): string {
  return createHmac('sha256', privateKey).update(nonce + publicKey).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function resolveKey(publicKey: string): { public_key: string; private_key: string } | null {
  // Bootstrap credentials from the environment, plus any keys issued later.
  if (config.apiPublicKey && publicKey === config.apiPublicKey && config.apiPrivateKey) {
    return { public_key: config.apiPublicKey, private_key: config.apiPrivateKey };
  }
  const row = findApiKey(publicKey);
  return row ? { public_key: row.public_key, private_key: row.private_key } : null;
}

export function authenticate(req: AuthedRequest, res: Response, next: NextFunction) {
  const publicKey = header(req, 'x-api-key');
  if (!publicKey) return deny(res, 'missing X-API-KEY header');

  const key = resolveKey(publicKey);
  // Same message whether the key is unknown or the signature is wrong, so the
  // endpoint cannot be used to enumerate valid public keys.
  if (!key) return deny(res, 'invalid credentials');

  if (config.authMode === 'simple') {
    const secret = header(req, 'x-api-secret');
    if (!secret || !safeEqual(secret, key.private_key)) return deny(res, 'invalid credentials');
    req.apiKey = publicKey;
    return next();
  }

  const nonce = header(req, 'x-nonce');
  const signature = header(req, 'x-signature');
  if (!nonce || !signature) return deny(res, 'missing X-Nonce or X-Signature header');

  const nonceNum = Number(nonce);
  if (!Number.isFinite(nonceNum)) return deny(res, 'X-Nonce must be a unix timestamp');
  const skew = Math.abs(Math.floor(Date.now() / 1000) - nonceNum);
  if (skew > config.authNonceWindowSec) {
    return deny(res, `X-Nonce is outside the ${config.authNonceWindowSec}s window`);
  }

  const expected = buildSignature(key.private_key, nonce, publicKey);
  if (!safeEqual(signature.toLowerCase(), expected)) return deny(res, 'invalid credentials');

  // Reject replays of an otherwise valid signed request.
  if (!consumeNonce(publicKey, nonce, config.authNonceWindowSec)) {
    return deny(res, 'nonce already used');
  }

  req.apiKey = publicKey;
  next();
}

function header(req: Request, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
}

function deny(res: Response, message: string) {
  log.warn(`auth rejected: ${message}`);
  res.status(401).json({ error: 'unauthorized', message });
}

/** Helper your integration can mirror; also used by the test suite. */
export function signRequest(publicKey: string, privateKey: string, nonce = Math.floor(Date.now() / 1000)) {
  return {
    'X-API-KEY': publicKey,
    'X-Nonce': String(nonce),
    'X-Signature': buildSignature(privateKey, String(nonce), publicKey),
  };
}
