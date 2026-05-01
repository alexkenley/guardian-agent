/**
 * Structured logging via pino.
 *
 * Behaviour:
 * - In tests (VITEST / NODE_ENV=test): level = error
 * - If LOG_LEVEL is set explicitly: respect it
 * - If stdout is a TTY (interactive CLI): default to silent so JSON logs
 *   don't interleave with the readline prompt
 * - Otherwise (piped, production): default to warn
 *
 * LOG_FILE: if set, pino logs to that file instead of stdout, allowing
 * full debug logging without polluting the CLI.
 */

import pino from 'pino';
import { redactLogValue } from './log-redaction.js';

type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

function normalizeLogLevel(level: string | undefined, fallback: LogLevel): LogLevel {
  const normalized = (level ?? '').trim().toLowerCase();
  if (normalized === 'fatal' || normalized === 'error' || normalized === 'warn' || normalized === 'info'
    || normalized === 'debug' || normalized === 'trace' || normalized === 'silent') {
    return normalized;
  }
  return fallback;
}

function defaultLogLevel(): LogLevel {
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
    return 'error';
  }
  // If LOG_FILE is set the user explicitly wants logs routed to a file,
  // so default to 'info' to capture useful output.
  if (process.env['LOG_FILE']) {
    return 'info';
  }
  // Quiet-by-default when running in an interactive terminal so JSON logs
  // do not interleave with the readline CLI prompt.
  if (process.stdout.isTTY && !process.env['LOG_LEVEL']) {
    return 'silent';
  }
  return 'warn';
}

function buildTransport(): pino.TransportSingleOptions | undefined {
  const logFile = process.env['LOG_FILE'];
  if (logFile) {
    return { target: 'pino/file', options: { destination: logFile, mkdir: true } };
  }
  if (process.env['NODE_ENV'] !== 'production') {
    return { target: 'pino/file', options: { destination: 1 } };
  }
  return undefined;
}

export const logger = pino({
  level: normalizeLogLevel(process.env['LOG_LEVEL'], defaultLogLevel()),
  transport: buildTransport(),
  serializers: {
    err: (err) => redactLogValue(err),
  },
  formatters: {
    log(object) {
      const redacted = redactLogValue(object);
      return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
        ? redacted as Record<string, unknown>
        : { value: redacted };
    },
  },
});

/** Create a child logger with component context. */
export function createLogger(component: string): pino.Logger {
  return logger.child({ component });
}

/** Update global logger level at runtime. */
export function setLogLevel(level: string | undefined): LogLevel {
  const normalized = normalizeLogLevel(level, defaultLogLevel());
  logger.level = normalized;
  return normalized;
}

/** Read current global logger level. */
export function getLogLevel(): string {
  return logger.level;
}
