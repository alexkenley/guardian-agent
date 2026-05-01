import { isSensitiveKeyName, redactSensitiveText } from './crypto-guardrails.js';

const LOG_REDACTED_VALUE = '[REDACTED]';

export function redactLogValue<T>(value: T): T {
  return redactLogValueInner(value, new WeakSet<object>()) as T;
}

function redactLogValueInner(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value, LOG_REDACTED_VALUE);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((item) => redactLogValueInner(item, seen));
  }
  if (value instanceof Error) {
    return redactErrorForLog(value, seen);
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      isSensitiveKeyName(key) ? LOG_REDACTED_VALUE : redactLogValueInner(child, seen),
    ]));
  }
  return value;
}

function redactErrorForLog(err: Error, seen: WeakSet<object>): Record<string, unknown> {
  if (seen.has(err)) return { type: err.name || 'Error', message: '[Circular]' };
  seen.add(err);

  const redacted: Record<string, unknown> = {
    type: err.name || 'Error',
    message: redactSensitiveText(err.message, LOG_REDACTED_VALUE),
  };
  if (err.stack) {
    redacted.stack = redactSensitiveText(err.stack, LOG_REDACTED_VALUE);
  }
  if ('cause' in err && err.cause !== undefined) {
    redacted.cause = redactLogValueInner(err.cause, seen);
  }
  for (const [key, child] of Object.entries(err as unknown as Record<string, unknown>)) {
    if (key === 'message' || key === 'stack' || key === 'cause') continue;
    redacted[key] = isSensitiveKeyName(key) ? LOG_REDACTED_VALUE : redactLogValueInner(child, seen);
  }
  return redacted;
}
