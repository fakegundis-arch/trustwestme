import { generateMnemonic } from '../wallet/derive';

/**
 * Generate the master seed for the gateway.
 *
 *   npm run seed
 *
 * This one mnemonic backs every user address on every chain. Write it down
 * offline, store it in a secrets manager, and never commit it.
 */
async function main() {
  const mnemonic = await generateMnemonic(256);
  console.log('\n=====================  MASTER SEED  =====================\n');
  console.log('  ' + mnemonic);
  console.log('\n=========================================================\n');
  console.log('This phrase controls every deposit address the gateway issues.');
  console.log('Import it into the Trust Wallet app and you hold all user funds.\n');
  console.log('  1. Write it on paper. Store it somewhere a fire will not reach.');
  console.log('  2. Put it in MASTER_MNEMONIC in .env (or a secrets manager).');
  console.log('  3. Never commit it, never log it, never paste it into a chat.\n');
  console.log('Anyone who reads this phrase can drain the exchange. Anyone who');
  console.log('loses it loses every user deposit permanently.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
