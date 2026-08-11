import { CHAINS } from '../chains';
import { listCurrencies } from '../currencies';
import { deriveIdentity, deriveSharedCandidate } from '../wallet/derive';

/**
 * Show every address the seed produces for a user index.
 *
 *   npm run addresses -- 1          # user at derivation index 1
 *   npm run addresses -- --shared   # the gateway accounts for XRP/XLM/EOS
 *
 * Useful for verifying that a restored seed reproduces the same addresses
 * before you trust it with real money.
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--shared')) {
    console.log('\nGateway accounts for the tag/memo chains.');
    console.log('These must exist and be funded before deposits can arrive:\n');
    for (const id of ['xrp', 'stellar', 'eos']) {
      try {
        const address = await deriveSharedCandidate(id);
        console.log(`  ${id.padEnd(9)} ${address}`);
      } catch (e) {
        console.log(`  ${id.padEnd(9)} <error: ${(e as Error).message}>`);
      }
    }
    console.log('\n  XRP needs a base reserve before the account exists.');
    console.log('  XLM needs a base reserve before the account exists.');
    console.log('  EOS needs a registered account name — set EOS_ACCOUNT to it.\n');
    return;
  }

  const index = Number(args[0] ?? 1);
  if (!Number.isInteger(index) || index < 0) {
    console.error('usage: npm run addresses -- <index>');
    process.exit(1);
  }

  console.log(`\nAddresses for derivation index ${index}\n`);
  const seen = new Map<string, { address: string; tag: string | null }>();

  for (const chainId of Object.keys(CHAINS)) {
    try {
      const id = await deriveIdentity(chainId, index);
      seen.set(chainId, { address: id.address, tag: id.tag });
    } catch (e) {
      seen.set(chainId, { address: `<error: ${(e as Error).message}>`, tag: null });
    }
  }

  for (const cur of listCurrencies()) {
    const entry = seen.get(cur.chain);
    if (!entry) continue;
    const tag = entry.tag ? `   ${CHAINS[cur.chain].tagName}=${entry.tag}` : '';
    console.log(`  ${cur.ticker.padEnd(10)} ${entry.address}${tag}`);
  }
  console.log('\nCurrencies on the same chain intentionally share one address.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
