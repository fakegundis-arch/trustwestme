import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { fetchJson, setRateLimit, endpointList, tryEndpoints } from '../src/util/http';

/**
 * The plumbing that keeps scanning alive against free public endpoints:
 * a User-Agent (whose absence Cloudflare answers with a 403), per-host pacing,
 * and falling through to another endpoint rather than giving up.
 */

function server(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  const s = http.createServer(handler);
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as any).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() });
    });
  });
}

test('every request carries a User-Agent', async () => {
  // Node's fetch sends none by default, and Cloudflare-fronted endpoints
  // answer a request without one with a 403 and an HTML page.
  let seen: string | undefined;
  const s = await server((req, res) => {
    seen = req.headers['user-agent'];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  try {
    await fetchJson(`${s.url}/anything`);
    assert.ok(seen, 'no User-Agent was sent');
    assert.match(seen!, /trustwestme/);
  } finally { s.close(); }
});

test('requests to a host are paced to its rate limit', async () => {
  const stamps: number[] = [];
  const s = await server((_req, res) => {
    stamps.push(Date.now());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  try {
    const host = new URL(s.url).host;
    setRateLimit(host, 4); // four per second

    const started = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => fetchJson(`${s.url}/x`)));
    const elapsed = Date.now() - started;

    assert.equal(stamps.length, 8);
    // Four are free from the initial bucket; the rest wait for refill, so eight
    // cannot all land instantly.
    assert.ok(elapsed > 500, `8 requests at 4/s finished in ${elapsed}ms — no pacing happened`);
  } finally { s.close(); }
});

test('a 429 is retried rather than treated as fatal', async () => {
  let hits = 0;
  const s = await server((_req, res) => {
    hits++;
    if (hits === 1) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      return res.end('{"Error":"rate exceeded"}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  try {
    const result = await fetchJson<{ ok: boolean }>(`${s.url}/x`, { retries: 2 });
    assert.equal(result.ok, true);
    assert.equal(hits, 2, 'the 429 should have been retried once');
  } finally { s.close(); }
});

test('a 403 is not retried, since it will not change', async () => {
  let hits = 0;
  const s = await server((_req, res) => {
    hits++;
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<!DOCTYPE html><html>blocked</html>');
  });
  try {
    await assert.rejects(() => fetchJson(`${s.url}/x`, { retries: 3 }), /403/);
    assert.equal(hits, 1, 'a 403 was retried, wasting the rate-limit budget');
  } finally { s.close(); }
});

test('endpoint lists are parsed and trailing slashes trimmed', () => {
  assert.deepEqual(
    endpointList('https://a.example/, https://b.example , '),
    ['https://a.example', 'https://b.example'],
  );
  assert.deepEqual(endpointList('https://only.example'), ['https://only.example']);
  assert.deepEqual(endpointList(''), []);
});

test('a failing endpoint falls through to the next', async () => {
  const bad = await server((_req, res) => { res.writeHead(500); res.end('down'); });
  const good = await server((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"from":"second"}');
  });
  try {
    const result = await tryEndpoints<{ from: string }>(
      [bad.url, good.url],
      (base) => fetchJson(`${base}/x`, { retries: 0 }),
    );
    assert.equal(result.from, 'second');
  } finally { bad.close(); good.close(); }
});

test('when every endpoint fails, the last error surfaces', async () => {
  const a = await server((_req, res) => { res.writeHead(500); res.end('a down'); });
  const b = await server((_req, res) => { res.writeHead(503); res.end('b down'); });
  try {
    await assert.rejects(
      () => tryEndpoints([a.url, b.url], (base) => fetchJson(`${base}/x`, { retries: 0 })),
      /503/,
    );
  } finally { a.close(); b.close(); }
});
