function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toStructured(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function unwrapAutomationListPayload(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  const structured = toStructured(value);
  if (!isRecord(structured)) return structured;
  if (Array.isArray(structured.automations)) return structured;
  if (Object.prototype.hasOwnProperty.call(structured, 'output')) {
    return unwrapAutomationListPayload(structured.output, depth + 1);
  }
  if (Object.prototype.hasOwnProperty.call(structured, 'result')) {
    return unwrapAutomationListPayload(structured.result, depth + 1);
  }
  return structured;
}

export function extractAutomationListEntries(value: unknown): Record<string, unknown>[] | null {
  const payload = unwrapAutomationListPayload(value);
  if (!isRecord(payload) || !Array.isArray(payload.automations)) {
    return null;
  }
  return payload.automations
    .filter(isRecord)
    .map((entry) => ({ ...entry }));
}
