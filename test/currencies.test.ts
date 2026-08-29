import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCurrency, listCurrencies, CURRENCIES } from '../src/currencies';

/**
 * Currency naming.
 *
 * A deposit form sends whatever it shows the user — "Binance Coin BEP 20",
 * not "BNB" — so resolution has to be forgiving about separators and full
 * names. Getting this wrong shows the user an "unsupported currency" error on
 * a coin that is fully supported.
 */

test('the labels from a deposit form resolve', () => {
  // Coin picker shows "Binance coin"; the network picker offers BEP 2 and BEP 20.
  const cases: [string, string][] = [
    ['Binance Coin', 'BNB'],
    ['binance coin', 'BNB'],
    ['Binance Coin BEP 20', 'BNB'],
    ['Binance Coin Bep 2', 'BNB'],
    ['BNB-BEP20', 'BNB'],
    ['BNB_BEP20', 'BNB'],
    ['BNB BEP2', 'BNB'],
    ['bnbbep2', 'BNB'],
    ['Shiba Inu BEP 20', 'SHIBBEP20'],
    ['Binance USD BEP 20', 'BUSDBEP20'],
    ['Ripple XRP', 'XRP'],
    ['Bitcoin Cash', 'BCH'],
    ['USD Coin TRC 20', 'USDCTRC20'],
    ['usdt trc 20', 'USDTTRC'],
    ['USDT ERC 20', 'USDTERC20'],
    ['Tron TRX', 'TRX'],
  ];
  for (const [input, expected] of cases) {
    const resolved = resolveCurrency(input);
    assert.ok(resolved, `"${input}" did not resolve at all`);
    assert.equal(resolved!.ticker, expected, `"${input}" resolved to the wrong currency`);
  }
});

test('separators are ignored wherever they appear', () => {
  for (const spelling of ['USDT-TRC20', 'USDT_TRC20', 'USDT.TRC20', 'USDT TRC20',
    'usdt-trc-20', 'U S D T T R C 2 0']) {
    assert.equal(resolveCurrency(spelling)?.ticker, 'USDTTRC', `${spelling} failed`);
  }
});

test("every currency's display name resolves to itself", () => {
  // The form usually sends the label it displays.
  for (const currency of listCurrencies()) {
    const resolved = resolveCurrency(currency.name);
    assert.ok(resolved, `the name "${currency.name}" does not resolve`);
    assert.equal(resolved!.ticker, currency.ticker,
      `"${currency.name}" resolves to ${resolved!.ticker}, not ${currency.ticker}`);
  }
});

test('every ticker resolves to itself', () => {
  for (const currency of listCurrencies()) {
    assert.equal(resolveCurrency(currency.ticker)?.ticker, currency.ticker);
  }
});

test('no two currencies answer to the same name', () => {
  // The registry throws on a collision at import; this states the property
  // directly, since a collision would send deposits to the wrong chain.
  const seen = new Map<string, string>();
  const normalize = (s: string) => s.trim().toUpperCase().replace(/[\s._\-()/]/g, '');

  for (const currency of listCurrencies()) {
    for (const name of [currency.ticker, currency.name, ...currency.aliases]) {
      const key = normalize(name);
      const claimed = seen.get(key);
      assert.ok(!claimed || claimed === currency.ticker,
        `"${name}" is claimed by both ${claimed} and ${currency.ticker}`);
      seen.set(key, currency.ticker);
    }
  }
});

test('BNB is the BSC native coin, sharing its address with the BEP-20 tokens', () => {
  const bnb = CURRENCIES.BNB;
  assert.equal(bnb.chain, 'bsc');
  assert.equal(bnb.kind, 'native');
  assert.equal(bnb.decimals, 18);

  // BEP-2 spellings deliberately land on the BSC coin: the Beacon Chain is
  // retired, so anyone selecting it will in fact send over BSC.
  assert.equal(resolveCurrency('BNB BEP2')?.chain, 'bsc');

  for (const token of ['USDTBEP20', 'BUSDBEP20', 'SHIBBEP20']) {
    assert.equal(CURRENCIES[token].chain, 'bsc',
      `${token} should settle on the same chain as BNB`);
  }
});

test('an unknown currency still returns null rather than guessing', () => {
  for (const nonsense of ['', '   ', 'NOTACOIN', 'BNB BEP99', 'random text']) {
    assert.equal(resolveCurrency(nonsense), null, `"${nonsense}" should not resolve`);
  }
});
