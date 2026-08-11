import * as fs from 'node:fs';

/**
 * Test configuration must be in place before `src/config.ts` is first imported,
 * and static imports are hoisted above any assignment we write here. So tests
 * set the environment through this module and then pull modules in lazily.
 */
export const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

export function setupEnv(dbName: string) {
  const dbPath = `/tmp/trustwestme-test-${dbName}.db`;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix); } catch { /* not present */ }
  }

  process.env.MASTER_MNEMONIC = TEST_MNEMONIC;
  process.env.MASTER_MNEMONIC_PASSPHRASE = '';
  process.env.DB_PATH = dbPath;
  process.env.WATCHER_ENABLED = 'false';
  process.env.LOG_LEVEL = 'error';
  process.env.API_PUBLIC_KEY = 'testpublickey';
  process.env.API_PRIVATE_KEY = 'testprivatekey';
  process.env.IPN_SECRET = 'testipnsecret';
  process.env.XRP_ADDRESS = 'rGatewayTestAccount00000000000';
  process.env.STELLAR_ADDRESS = 'GTESTGATEWAYACCOUNT000000000000000000000000000000000000';
  process.env.EOS_ACCOUNT = 'gatewayacct1';
  return dbPath;
}
