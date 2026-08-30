import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * File logging.
 *
 * Two properties matter more than the rest: the file must actually contain
 * what the console showed, and a disk problem must never take the gateway down
 * with it — losing a log line is acceptable, refusing to credit a deposit
 * because a log could not be written is not.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-'));
const logFile = path.join(dir, 'gateway.log');

let logger: typeof import('../src/util/log').logger;
let readLogTail: typeof import('../src/util/log').readLogTail;
let logFilePath: typeof import('../src/util/log').logFilePath;
let closeLogFile: typeof import('../src/util/log').closeLogFile;

before(async () => {
  process.env.LOG_FILE = logFile;
  process.env.LOG_LEVEL = 'debug';
  process.env.LOG_MAX_BYTES = '2000';   // rotate quickly so the test is fast
  process.env.LOG_KEEP = '3';
  ({ logger, readLogTail, logFilePath, closeLogFile } = await import('../src/util/log'));
});

after(() => {
  closeLogFile?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 120));

test('log lines are written to the file', async () => {
  const log = logger('filetest');
  log.info('a deposit was credited');
  log.warn('an endpoint refused us');
  log.error('something broke');
  await settle();

  assert.ok(fs.existsSync(logFile), 'no log file was created');
  const contents = fs.readFileSync(logFile, 'utf8');
  assert.match(contents, /a deposit was credited/);
  assert.match(contents, /an endpoint refused us/);
  assert.match(contents, /something broke/);
});

test('each line carries a timestamp, level and scope', async () => {
  logger('scopecheck').info('hello');
  await settle();
  const line = fs.readFileSync(logFile, 'utf8').split('\n')
    .find((l) => l.includes('hello'))!;
  assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+INFO\s+\[scopecheck\] hello/);
});

test('the extra detail argument reaches the file', async () => {
  logger('detail').warn('failed', 'HTTP 403 from example.com');
  logger('detail').error('object detail', { code: 42 });
  await settle();
  const contents = fs.readFileSync(logFile, 'utf8');
  assert.match(contents, /HTTP 403 from example\.com/);
  assert.match(contents, /"code":42/);
});

test('the level threshold applies to the file too', async () => {
  // LOG_LEVEL is debug here, so everything should be present.
  logger('levels').debug('a debug line');
  await settle();
  assert.match(fs.readFileSync(logFile, 'utf8'), /a debug line/);
});

test('the file rotates and old files are kept', async () => {
  const log = logger('rotate');
  // LOG_MAX_BYTES is 2000, so this crosses it several times.
  for (let i = 0; i < 120; i++) log.info(`filler line ${i} ${'x'.repeat(60)}`);
  await settle();

  assert.ok(fs.existsSync(logFile), 'the live log file is missing after rotation');
  assert.ok(fs.existsSync(`${logFile}.1`), 'no rotated file was produced');

  // LOG_KEEP is 3, so nothing beyond .3 should survive.
  assert.ok(!fs.existsSync(`${logFile}.4`), 'more rotated files kept than LOG_KEEP allows');
});

test('rotation does not lose the newest lines', async () => {
  logger('rotate').info('THE-MOST-RECENT-LINE');
  await settle();
  const tail = readLogTail(20);
  assert.ok(tail.some((l) => l.includes('THE-MOST-RECENT-LINE')),
    'the newest line was lost');
});

test('readLogTail returns the last lines, newest last', async () => {
  const log = logger('tail');
  for (let i = 0; i < 10; i++) log.info(`tail-line-${i}`);
  await settle();

  const tail = readLogTail(5);
  assert.equal(tail.length, 5);
  assert.ok(tail[tail.length - 1].includes('tail-line-9'), 'the last line is not the newest');
});

test('readLogTail can filter to errors and warnings', async () => {
  logger('filter').info('an ordinary line');
  logger('filter').error('a bad thing');
  await settle();

  const errors = readLogTail(30, /\b(ERROR|WARN)\b/);
  assert.ok(errors.some((l) => l.includes('a bad thing')));
  assert.ok(!errors.some((l) => l.includes('an ordinary line')),
    'an info line leaked into the error filter');
});

test('logFilePath reports where the file is', () => {
  assert.equal(logFilePath(), logFile);
});

test('an unwritable log path degrades to console instead of crashing', async () => {
  // Run in a separate process so a second logger instance can be configured.
  // /etc/hostname is a file, so treating it as a directory fails immediately.
  const result = await runInChild(`
    process.env.LOG_FILE = '/etc/hostname/gateway.log';
    process.env.LOG_LEVEL = 'info';
    const { logger } = require(${JSON.stringify(path.resolve('dist/util/log.js'))});
    logger('probe').info('first line');
    logger('probe').info('second line');
    console.log('SURVIVED');
  `);

  assert.match(result.output, /SURVIVED/, 'a bad log path crashed the process');
  assert.match(result.output, /first line/, 'console logging stopped when the file failed');
  assert.match(result.output, /second line/, 'logging stopped after the first file error');
  assert.match(result.output, /file logging disabled/, 'the failure was not reported');
  assert.equal(result.code, 0, 'the process exited non-zero over a log failure');
});

test('an open log file does not keep the process alive', async () => {
  // A WriteStream would hold the event loop open and every CLI command
  // (npm run addresses, keys, selftest) would hang instead of exiting.
  const target = path.join(dir, 'exit-test.log');
  const result = await runInChild(`
    process.env.LOG_FILE = ${JSON.stringify(target)};
    const { logger } = require(${JSON.stringify(path.resolve('dist/util/log.js'))});
    logger('probe').info('a line');
    console.log('SURVIVED');
  `);

  assert.equal(result.code, 0, 'the process did not exit on its own — it hung');
  assert.match(result.output, /SURVIVED/);
  assert.ok(fs.existsSync(target), 'the line was not written before exit');
});

/** Run a snippet in a child node process, with a timeout that detects a hang. */
function runInChild(source: string): Promise<{ output: string; code: number | null }> {
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 15000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ output, code }); });
  });
}
