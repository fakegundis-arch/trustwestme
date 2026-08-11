/**
 * Money handling. Every amount is stored and compared as an integer number of
 * base units (satoshi, wei, sun, drop, ...) held in a BigInt. Decimal strings
 * are only used at the API boundary. Never use JS floats for balances.
 */

/** "0.0015" @ 8 decimals -> 150000n */
export function toBaseUnits(amount: string | number, decimals: number): bigint {
  const s = typeof amount === 'number' ? formatFloat(amount) : amount.trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '' || s === '.' || s === '-') {
    throw new Error(`invalid decimal amount: ${amount}`);
  }
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [whole = '0', frac = ''] = body.split('.');
  if (frac.length > decimals) {
    // Refuse silent truncation of value; callers must round explicitly.
    const significant = frac.slice(decimals).replace(/0+$/, '');
    if (significant.length > 0) {
      throw new Error(`amount ${amount} has more precision than ${decimals} decimals allows`);
    }
  }
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const v = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
  return neg ? -v : v;
}

/** 150000n @ 8 decimals -> "0.0015" */
export function fromBaseUnits(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const div = 10n ** BigInt(decimals);
  const whole = v / div;
  const frac = v % div;
  let out = whole.toString();
  if (decimals > 0) {
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    if (fracStr) out += '.' + fracStr;
  }
  return neg ? '-' + out : out;
}

function formatFloat(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`invalid amount: ${n}`);
  // Avoid exponential notation for very small/large numbers.
  if (Math.abs(n) < 1e-6 || Math.abs(n) >= 1e21) {
    return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  }
  return String(n);
}

/** Parse a hex quantity ("0x1a", or plain decimal string) into a BigInt. */
export function parseHexOrDec(v: string | number | bigint): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  const s = v.trim();
  if (s.startsWith('0x') || s.startsWith('0X')) return BigInt(s);
  return BigInt(s);
}
