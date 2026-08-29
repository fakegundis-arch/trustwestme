import { logger } from './log';

const log = logger('http-client');

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
}

/**
 * Node's fetch sends no User-Agent, and several public endpoints — Trezor's
 * Blockbook instances among them — sit behind Cloudflare, which rejects a
 * request without one outright. That produces a 403 with an HTML body, which
 * looks nothing like a rate limit and is easy to misdiagnose.
 */
const USER_AGENT = 'trustwestme/1.0 (+https://github.com/fakegundis-arch/trustwestme)';

/**
 * Per-host rate limiting.
 *
 * Public endpoints publish tight limits — TronGrid allows three requests a
 * second without a key — and exceeding them gets the whole host suspended for
 * seconds at a time, so scanning fails in bursts rather than gracefully.
 * A token bucket per host keeps every caller under the limit collectively.
 */
interface Bucket { tokens: number; lastRefill: number; rps: number; capacity: number }
const buckets = new Map<string, Bucket>();

/**
 * Requests per second allowed to a host. Values below 1 are meaningful — some
 * free APIs allow one request every couple of seconds — so the bucket holds at
 * least one token however slow the refill, otherwise a rate under 1/s could
 * never accumulate enough to send anything.
 */
export function setRateLimit(host: string, rps: number): void {
  const capacity = Math.max(1, rps);
  const existing = buckets.get(host);
  if (existing) {
    existing.rps = rps;
    existing.capacity = capacity;
  } else {
    buckets.set(host, { tokens: capacity, lastRefill: Date.now(), rps, capacity });
  }
}

async function acquireSlot(host: string): Promise<void> {
  const bucket = buckets.get(host);
  if (!bucket) return; // unlimited unless a limit was set

  for (;;) {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.rps);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    // Wait for the next token rather than firing and being refused.
    await sleep(Math.ceil(((1 - bucket.tokens) / bucket.rps) * 1000));
  }
}

/** JSON fetch with a timeout and bounded retries on transient failures. */
export async function fetchJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const { method = 'GET', headers = {}, body, timeoutMs = 20000, retries = 2 } = opts;
  let lastErr: unknown;

  const host = hostOf(url);

  for (let attempt = 0; attempt <= retries; attempt++) {
    await acquireSlot(host);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // A rate limit is worth waiting out; other 4xx will not change on retry.
        if (res.status === 429) {
          // Respect Retry-After when the server sends one.
          const retryAfter = Number(res.headers.get('retry-after'));
          throw new RateLimitError(
            `HTTP 429 from ${host}: ${text.slice(0, 160)}`,
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
          );
        }
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`HTTP ${res.status} from ${host}: ${text.slice(0, 300)}`);
        }
        throw new TransientError(`HTTP ${res.status} from ${host}: ${text.slice(0, 200)}`);
      }
      return text ? JSON.parse(text) as T : ({} as T);
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof TransientError || e instanceof RateLimitError
        || (e as Error)?.name === 'AbortError'
        || (e as Error)?.message?.includes('fetch failed');
      if (!retryable || attempt === retries) break;
      const backoff = e instanceof RateLimitError && e.retryAfterMs
        ? e.retryAfterMs
        : 1000 * 2 ** attempt;
      log.debug(`retrying ${host} in ${backoff}ms: ${(e as Error).message}`);
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** JSON-RPC 2.0 helper (Ethereum, BSC, Solana, XRP). */
export async function rpc<T = any>(url: string, method: string, params: unknown[] | object = [], opts: FetchOpts = {}): Promise<T> {
  const res = await fetchJson<{ result?: T; error?: { message?: string; code?: number } }>(url, {
    ...opts,
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method, params },
  });
  if (res.error) throw new Error(`${method} failed: ${res.error.message ?? JSON.stringify(res.error)}`);
  return res.result as T;
}

export class TransientError extends Error {}

/** A 429. Carries the server's own Retry-After when it gave one. */
export class RateLimitError extends Error {
  constructor(message: string, public retryAfterMs?: number) {
    super(message);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Split a comma-separated endpoint setting into a list of base URLs. */
export function endpointList(setting: string): string[] {
  return setting.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
}

/**
 * Run `attempt` against each endpoint until one succeeds.
 *
 * Public endpoints fail in ways that have nothing to do with the request —
 * rate limits, Cloudflare blocks, outages — so an alternative is usually worth
 * more than a retry against the same host. The last error is thrown if all of
 * them fail.
 */
export async function tryEndpoints<T>(
  endpoints: string[],
  attempt: (base: string) => Promise<T>,
): Promise<T> {
  if (endpoints.length === 0) throw new Error('no endpoint configured');
  let lastError: unknown;
  for (const base of endpoints) {
    try {
      return await attempt(base);
    } catch (e) {
      lastError = e;
      if (endpoints.length > 1) {
        log.debug(`${hostOf(base)} failed, trying the next endpoint: ${(e as Error).message}`);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** Run tasks with bounded concurrency so we do not stampede a public endpoint. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
