import { logger } from './log';

const log = logger('http-client');

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
}

/** JSON fetch with a timeout and bounded retries on transient failures. */
export async function fetchJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const { method = 'GET', headers = {}, body, timeoutMs = 20000, retries = 2 } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // 4xx other than 429 will not succeed on retry.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`HTTP ${res.status} from ${hostOf(url)}: ${text.slice(0, 300)}`);
        }
        throw new TransientError(`HTTP ${res.status} from ${hostOf(url)}: ${text.slice(0, 200)}`);
      }
      return text ? JSON.parse(text) as T : ({} as T);
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof TransientError || (e as Error)?.name === 'AbortError'
        || (e as Error)?.message?.includes('fetch failed');
      if (!retryable || attempt === retries) break;
      const backoff = 500 * 2 ** attempt;
      log.debug(`retrying ${hostOf(url)} in ${backoff}ms: ${(e as Error).message}`);
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

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
