import { randomBytes } from 'node:crypto';
import { insertApiKey } from '../db/repo';

/**
 * Issue an API keypair for your exchange.
 *
 *   npm run keys                 # print a pair
 *   npm run keys -- --save mysite  # also store it so it works immediately
 */
function main() {
  const args = process.argv.slice(2);
  const saveIdx = args.indexOf('--save');
  const label = saveIdx >= 0 ? (args[saveIdx + 1] ?? 'default') : null;

  const publicKey = randomBytes(16).toString('hex');
  const privateKey = randomBytes(32).toString('hex');

  if (label) {
    insertApiKey(publicKey, privateKey, label);
    console.log(`Stored API key "${label}" in the database.\n`);
  }

  console.log('API_PUBLIC_KEY=' + publicKey);
  console.log('API_PRIVATE_KEY=' + privateKey);
  console.log('\nThe public key identifies you and travels in the X-API-KEY header.');
  console.log('The private key signs requests and must never leave your server.');
  if (!label) console.log('\nPut both in .env, or re-run with --save <label> to store the pair.');
}

main();
