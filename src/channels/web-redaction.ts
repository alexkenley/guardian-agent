import { redactSensitiveText, redactSensitiveValue } from '../util/crypto-guardrails.js';

export function redactWebResponse<T>(value: T): T {
  return redactWebValue(value) as T;
}

function redactWebValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactWebValue(item));
  }
  if (value && typeof value === 'object') {
    const keyRedacted = redactSensitiveValue(value);
    if (!keyRedacted || typeof keyRedacted !== 'object' || Array.isArray(keyRedacted)) {
      return redactWebValue(keyRedacted);
    }
    return Object.fromEntries(Object.entries(keyRedacted as Record<string, unknown>)
      .map(([key, child]) => [key, redactWebValue(child)]));
  }
  return value;
}
