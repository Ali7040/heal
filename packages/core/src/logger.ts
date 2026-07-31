/**
 * Minimal structured logging.
 *
 * The loop's log is not decoration — it is the only window into an autonomous
 * process that edits code. Every line is one event with its fields attached, so a
 * run can be replayed from a transcript, and so the demo output and the debugging
 * output are the same thing rather than two formats that drift.
 */
import type { Logger } from './contracts/context.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface ConsoleLoggerOptions {
  readonly level?: LogLevel;
  /** JSON lines instead of human-readable text — for piping into anything else. */
  readonly json?: boolean;
  readonly write?: (line: string) => void;
}

export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const minimum = ORDER[options.level ?? 'info'];
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < minimum) return;

    if (options.json === true) {
      write(JSON.stringify({ level, message, ...fields, at: new Date().toISOString() }));
      return;
    }

    const suffix =
      fields === undefined || Object.keys(fields).length === 0
        ? ''
        : ` ${Object.entries(fields)
            .map(([key, value]) => `${key}=${format(value)}`)
            .join(' ')}`;
    write(`${level.padEnd(5)} ${message}${suffix}`);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

function format(value: unknown): string {
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value;
  return JSON.stringify(value) ?? String(value);
}

/** For tests and dry runs that should stay silent. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
