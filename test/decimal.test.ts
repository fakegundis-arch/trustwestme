import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBaseUnits, fromBaseUnits, parseHexOrDec } from '../src/util/decimal';

test('converts decimal strings to base units', () => {
  assert.equal(toBaseUnits('1', 8), 100_000_000n);
  assert.equal(toBaseUnits('0.001', 8), 100_000n);
  assert.equal(toBaseUnits('0.00000001', 8), 1n);
  assert.equal(toBaseUnits('1.5', 6), 1_500_000n);
  assert.equal(toBaseUnits('0', 18), 0n);
  assert.equal(toBaseUnits('123.456789', 6), 123_456_789n);
});

test('handles the 18-decimal chains without precision loss', () => {
  // A float would silently mangle this; BigInt must not.
  assert.equal(toBaseUnits('1.234567890123456789', 18), 1_234_567_890_123_456_789n);
  assert.equal(fromBaseUnits(1_234_567_890_123_456_789n, 18), '1.234567890123456789');
});

test('round-trips values exactly', () => {
  const cases: [string, number][] = [
    ['0.00000001', 8], ['12345.6789', 8], ['0.000001', 6],
    ['999999999.999999999', 9], ['1', 4], ['0.000000000001', 12],
  ];
  for (const [value, decimals] of cases) {
    assert.equal(fromBaseUnits(toBaseUnits(value, decimals), decimals), value);
  }
});

test('formats base units back to decimal strings', () => {
  assert.equal(fromBaseUnits(100_000_000n, 8), '1');
  assert.equal(fromBaseUnits(0n, 8), '0');
  assert.equal(fromBaseUnits(1n, 8), '0.00000001');
  assert.equal(fromBaseUnits(150n, 2), '1.5');
});

test('refuses amounts with more precision than the currency has', () => {
  // Silently truncating here would credit a user less than they sent.
  assert.throws(() => toBaseUnits('0.000000001', 8), /precision/);
  assert.throws(() => toBaseUnits('1.0000001', 6), /precision/);
  // Trailing zeros beyond the precision are harmless.
  assert.equal(toBaseUnits('1.500000000', 6), 1_500_000n);
});

test('rejects malformed amounts rather than guessing', () => {
  for (const bad of ['', 'abc', '1.2.3', '.', '-', '1e5', '0x10', ' ']) {
    assert.throws(() => toBaseUnits(bad, 8), undefined, `"${bad}" should be rejected`);
  }
});

test('parses hex and decimal quantities from RPC responses', () => {
  assert.equal(parseHexOrDec('0x1a'), 26n);
  assert.equal(parseHexOrDec('0x0'), 0n);
  assert.equal(parseHexOrDec('42'), 42n);
  assert.equal(parseHexOrDec(7), 7n);
  assert.equal(parseHexOrDec(123n), 123n);
});
