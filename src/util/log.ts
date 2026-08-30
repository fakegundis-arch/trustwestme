import * as fs from 'node:fs';
import * as path from 'node:path';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

/**
 * Logging goes to the console always, and to a file when one is configured.
 *
 * The console output is what systemd captures into its journal. The file is
 * independent of that: it survives a journal wipe, can be read without root,
 * and is there whether or not the process was started by systemd at all.
 *
 * Nothing here may ever throw. A gateway that stops crediting deposits because
 * its log file could not be written would be a far worse failure than losing
 * the log line, so every disk error degrades to console-only.
 */

const DEFAULT_LOG_FILE = path.resolve(process.cwd(), 'data/gateway.log');

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const settings = {
  // Empty LOG_FILE disables the file; unset uses the default beside the database.
  file: process.env.LOG_FILE === '' ? '' : (process.env.LOG_FILE || DEFAULT_LOG_FILE),
  maxBytes: envInt('LOG_MAX_BYTES', 10 * 1024 * 1024),
  keep: envInt('LOG_KEEP', 5),
};

class FileSink {
  /**
   * A raw file descriptor with synchronous writes, deliberately not a
   * WriteStream. A stream registers a handle that keeps the event loop alive,
   * which would stop every CLI command from exiting, and it buffers — so a
   * crash loses exactly the lines that explain the crash.
   */
  private fd: number | null = null;
  private bytes = 0;
  private disabled = false;

  constructor(private readonly file: string, private readonly maxBytes: number,
              private readonly keep: number) {}

  write(line: string): void {
    if (this.disabled || !this.file) return;
    try {
      if (this.fd === null) this.open();
      if (this.fd === null) return;

      const data = line + '\n';
      this.bytes += Buffer.byteLength(data);
      fs.writeSync(this.fd, data);

      if (this.bytes >= this.maxBytes) this.rotate();
    } catch (e) {
      this.giveUp(e);
    }
  }

  private open(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    this.fd = fs.openSync(this.file, 'a');
  }

  /** gateway.log -> gateway.log.1, .1 -> .2, and so on; the oldest is dropped. */
  private rotate(): void {
    this.closeFd();
    this.bytes = 0;

    try {
      const oldest = `${this.file}.${this.keep}`;
      if (fs.existsSync(oldest)) fs.rmSync(oldest);
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
      }
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
    } catch (e) {
      this.giveUp(e);
    }
  }

  private closeFd(): void {
    if (this.fd === null) return;
    try { fs.closeSync(this.fd); } catch { /* already gone */ }
    this.fd = null;
  }

  private giveUp(e: unknown): void {
    if (this.disabled) return;
    this.disabled = true;
    this.closeFd();
    // Straight to the console: going through the logger would recurse.
    console.error(`${new Date().toISOString()} ERROR [log] file logging disabled, `
      + `continuing to the console only: ${(e as Error)?.message ?? e}`);
  }

  close(): void {
    this.closeFd();
  }
}

const sink = new FileSink(settings.file, settings.maxBytes, settings.keep);

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (LEVELS[level] > threshold) return;
  const detail = extra === undefined ? ''
    : ' ' + (typeof extra === 'string' ? extra : safeStringify(extra));
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${detail}`;

  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(line);
  sink.write(line);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function logger(scope: string) {
  return {
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
  };
}

/** Where the log file is, or null when file logging is off. */
export function logFilePath(): string | null {
  return settings.file || null;
}

/**
 * The last `lines` lines of the log.
 *
 * Reads from the end of the file rather than loading it whole, so this stays
 * cheap on a log that has grown to the rotation limit.
 */
export function readLogTail(lines = 40, filter?: RegExp): string[] {
  const file = settings.file;
  if (!file || !fs.existsSync(file)) return [];

  const size = fs.statSync(file).size;
  // Enough for the requested lines at a generous average length.
  const readBytes = Math.min(size, Math.max(64 * 1024, lines * 400));
  const buffer = Buffer.alloc(readBytes);

  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, readBytes, size - readBytes);
  } finally {
    fs.closeSync(fd);
  }

  let all = buffer.toString('utf8').split('\n').filter(Boolean);
  // The first line is probably cut in half by where the read started.
  if (readBytes < size && all.length > 0) all = all.slice(1);
  if (filter) all = all.filter((l) => filter.test(l));
  return all.slice(-lines);
}

export function closeLogFile(): void {
  sink.close();
}
