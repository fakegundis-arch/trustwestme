import { createHmac } from 'node:crypto';
import { config } from '../config';

/**
 * End-to-end check of a running gateway, using the same credentials and the
 * same signing your exchange uses.
 *
 *   npm run selftest
 *
 * Run it on the gateway box while the service is running. It answers the one
 * question that matters when an integration will not work: is the gateway
 * broken, or is the caller wrong?
 */

const BASE = process.env.SELFTEST_URL
  || `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;

let pass = 0;
let fail = 0;

function ok(label: string, detail = '') {
  pass++;
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? '  ' + detail : ''}`);
}
function bad(label: string, detail = '') {
  fail++;
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? '\n      ' + detail : ''}`);
}

function sign(nonce: number) {
  return {
    'X-API-KEY': config.apiPublicKey,
    'X-Nonce': String(nonce),
    'X-Signature': createHmac('sha256', config.apiPrivateKey)
      .update(String(nonce) + config.apiPublicKey).digest('hex'),
    'content-type': 'application/json',
  };
}

let nonce = Math.floor(Date.now() / 1000);

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, { ...init, headers: sign(nonce++) });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function main() {
  console.log(`\nTesting gateway at ${BASE}\n`);

  // --- configuration ------------------------------------------------------
  console.log('Configuration');
  if (config.apiPublicKey) ok('API_PUBLIC_KEY is set');
  else bad('API_PUBLIC_KEY is empty', 'Run `npm run keys` and put the pair in .env');

  if (config.apiPrivateKey) ok('API_PRIVATE_KEY is set');
  else bad('API_PRIVATE_KEY is empty', 'Run `npm run keys` and put the pair in .env');

  if (config.mnemonic) ok('MASTER_MNEMONIC is set');
  else bad('MASTER_MNEMONIC is empty', 'No addresses can be derived without it');

  if (config.mnemonicPassphrase) {
    bad('MASTER_MNEMONIC_PASSPHRASE is set',
      'This changes every derived address AND the Trust Wallet app cannot restore\n'
      + '      a wallet that uses one. Unless you set it deliberately, empty it,\n'
      + '      delete data/gateway.db and restart.');
  } else {
    ok('MASTER_MNEMONIC_PASSPHRASE is empty', '(correct for Trust Wallet recovery)');
  }

  if (config.ipnSecret) ok('IPN_SECRET is set');
  else bad('IPN_SECRET is empty', 'Callbacks are signed with an empty key — anyone could forge one');

  const ipnUrl = process.env.DEFAULT_IPN_URL || '';
  if (ipnUrl) ok('DEFAULT_IPN_URL is set', ipnUrl);
  else bad('DEFAULT_IPN_URL is empty',
    'Deposits will credit inside the gateway but your site will never be told');

  // --- reachability -------------------------------------------------------
  console.log('\nConnectivity');
  try {
    const res = await fetch(BASE + '/health');
    const text = await res.text();

    if (res.ok && text.includes('trustwestme')) {
      ok('gateway is reachable', BASE);
    } else if (text.trimStart().startsWith('<')) {
      // Something answered, but it served HTML — so it is a different program.
      bad('THIS PORT IS NOT THE GATEWAY',
        `Port ${config.port} answered with an HTML page, so another service — very\n`
        + '      likely your website — already owns it. The gateway either failed to\n'
        + '      bind or is not running.\n\n'
        + '      Find out what holds the port:\n'
        + '        sudo ss -tlnp | grep :' + config.port + '\n\n'
        + '      Then pick a free port in .env (for example PORT=8787), restart, and\n'
        + '      point your website at the new port.');
      return summary();
    } else {
      bad(`/health returned HTTP ${res.status}`, text.slice(0, 200));
      return summary();
    }
  } catch (e) {
    bad('cannot reach the gateway',
      `${(e as Error).message}\n`
      + '      Nothing is listening on this port. Is the gateway running?\n'
      + '        systemctl status gateway   (or: npm start)');
    return summary();
  }

  // --- authentication -----------------------------------------------------
  console.log('\nAuthentication');
  const currencies = await call('/currencies');
  if (currencies.status === 200) {
    ok('signed request accepted', `${currencies.body.currencies?.length ?? 0} currencies available`);
  } else if (currencies.status === 401) {
    bad('signed request REJECTED (401)',
      `${currencies.body?.message ?? ''}\n`
      + '      The keys in .env do not match what the signature was built from,\n'
      + '      or the server clock is off. Check: timedatectl');
    return summary();
  } else {
    bad(`unexpected status ${currencies.status}`, JSON.stringify(currencies.body).slice(0, 200));
  }

  // Unsigned requests must be refused.
  const unsigned = await fetch(BASE + '/currencies');
  if (unsigned.status === 401) ok('unsigned request correctly refused');
  else bad(`unsigned request returned ${unsigned.status}`, 'the API should require credentials');

  // --- address generation -------------------------------------------------
  console.log('\nAddress generation');
  const label = `selftest-${Date.now()}`;
  for (const currency of ['BTC', 'ETH', 'USDTTRC', 'USDTERC20']) {
    const res = await call('/address/generate', {
      method: 'POST',
      body: JSON.stringify({ currency, label }),
    });
    if (res.status === 200 && res.body.address) {
      ok(`${currency.padEnd(10)} ${res.body.address}`);
    } else {
      bad(`${currency} failed (HTTP ${res.status})`, JSON.stringify(res.body).slice(0, 200));
    }
  }

  // The same user must always get the same address back.
  const first = await call('/address/generate', { method: 'POST', body: JSON.stringify({ currency: 'BTC', label }) });
  const second = await call('/address/generate', { method: 'POST', body: JSON.stringify({ currency: 'BTC', label }) });
  if (first.body?.address && first.body.address === second.body?.address) {
    ok('repeat calls return the same address');
  } else {
    bad('repeat calls returned DIFFERENT addresses', 'this would break deposit pages');
  }

  summary();
}

function summary() {
  console.log(`\n${'─'.repeat(60)}`);
  if (fail === 0) {
    console.log(`\x1b[32mAll ${pass} checks passed.\x1b[0m The gateway is working.`);
    console.log('\nIf your website still cannot fetch an address, the problem is on the');
    console.log('caller side. Check, in this order:');
    console.log('  1. Is your site pointed at this gateway, or still at api.westwallet.io?');
    console.log('  2. Does it send the label/user_id field? It is required here.');
    console.log('  3. Does it sign as hex(HMAC-SHA256(private_key, nonce + public_key))?');
    console.log('     If not, set AUTH_MODE=simple and send X-API-KEY + X-API-SECRET.');
  } else {
    console.log(`\x1b[31m${fail} check(s) failed\x1b[0m, ${pass} passed. Fix the ✗ items above.`);
  }
  console.log('');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nself-test crashed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
