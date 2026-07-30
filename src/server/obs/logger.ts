/**
 * Structured logging.
 *
 * Emits one JSON object per line in production (ready for any log shipper) and
 * a readable coloured form in development. Child loggers carry bound context —
 * a job id, a workspace id — so a render failure can be traced without
 * threading a correlation id through every function signature.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const COLORS: Record<LogLevel, string> = {
  debug: '[2;37m',
  info: '[36m',
  warn: '[33m',
  error: '[31m',
};

export type LogContext = Record<string, unknown>;

/** Keys whose values are replaced with `[redacted]` wherever they appear. */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'secret',
  'clientsecret',
  'apikey',
  'api_key',
  'sessiontoken',
  'codeverifier',
]);

/**
 * Recursively redact sensitive values. Logs are the most common way secrets
 * leak, so this runs on every context object rather than relying on callers to
 * remember.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, depth + 1));
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ''))
        ? '[redacted]'
        : redact(item, depth + 1);
    }
    return result;
  }

  if (typeof value === 'string' && value.length > 4000) {
    return `${value.slice(0, 4000)}…[truncated]`;
  }

  return value;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

function currentLevel(): LogLevel {
  const configured = (process.env['LOG_LEVEL'] ?? '').toLowerCase();
  if (configured in LEVEL_ORDER) return configured as LogLevel;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

function isPretty(): boolean {
  return process.env['LOG_FORMAT'] === 'pretty' || process.env.NODE_ENV !== 'production';
}

function createLogger(bound: LogContext = {}): Logger {
  const write = (level: LogLevel, message: string, context?: LogContext) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;

    const merged = { ...bound, ...(context ?? {}) };
    const payload = redact(merged) as LogContext;
    const timestamp = new Date().toISOString();

    if (isPretty()) {
      const details = Object.keys(payload).length > 0 ? ` ${JSON.stringify(payload)}` : '';
      const line = `${COLORS[level]}${level.toUpperCase().padEnd(5)}[0m ${timestamp} ${message}${details}`;
      (level === 'error' || level === 'warn' ? console.error : console.log)(line);
      return;
    }

    const line = JSON.stringify({ level, time: timestamp, message, ...payload });
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  };

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
    child: (context) => createLogger({ ...bound, ...context }),
  };
}

export const logger: Logger = createLogger({ service: 'phantom' });

/** Time an async operation and log its duration and outcome. */
export async function timed<T>(
  log: Logger,
  operation: string,
  fn: () => Promise<T>,
  context: LogContext = {},
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    log.info(`${operation} succeeded`, { ...context, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    log.error(`${operation} failed`, {
      ...context,
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}
