import { config } from './config';
import { getDb, closeDb } from './db/index';
import { startServer } from './api/server';
import { startWatcher, stopWatcher } from './watcher/index';
import { startIpnWorker, stopIpnWorker } from './ipn';
import { startTelegramBot, stopTelegramBot } from './telegram/bot';
import { logger } from './util/log';

const log = logger('main');

async function main() {
  log.info(`starting trustwestme (${config.env})`);
  getDb();

  const server = startServer();

  // Start the bot before the watcher so the first deposits of the run are
  // already being announced. A Telegram failure must not stop the gateway.
  await startTelegramBot().catch((e) => {
    log.error('telegram bot failed to start', (e as Error).message);
  });

  startWatcher();
  startIpnWorker();

  const shutdown = (signal: string) => {
    log.info(`${signal} received, shutting down`);
    stopWatcher();
    stopIpnWorker();
    stopTelegramBot();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    // Do not hang forever if a connection refuses to drain.
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error('fatal startup error', e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
