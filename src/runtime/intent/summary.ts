export const INTENT_GATEWAY_MISSING_SUMMARY = 'No classification summary provided.';
export const INTENT_GATEWAY_UNSTRUCTURED_SUMMARY = 'Intent gateway response was not structured.';
export const INTENT_GATEWAY_HARNESS_NO_ROUTE_SUMMARY = 'No direct route for this coding harness turn.';

const INTENT_GATEWAY_INTERNAL_PLACEHOLDER_SUMMARIES = new Set([
  INTENT_GATEWAY_MISSING_SUMMARY,
  INTENT_GATEWAY_UNSTRUCTURED_SUMMARY,
  INTENT_GATEWAY_HARNESS_NO_ROUTE_SUMMARY,
]);

const PROVIDER_FAILURE_SUMMARY_PATTERNS = [
  /\brate limit exceeded\b/i,
  /\bquota depleted\b/i,
  /\btimed out after \d+ms\b/i,
  /\bprovider\b.*\btimed out\b/i,
  /\bapi error\s+\d{3}\b/i,
  /\bservice temporarily unavailable\b/i,
];

export function isIntentGatewayPlaceholderSummary(value: string | null | undefined): boolean {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 && INTENT_GATEWAY_INTERNAL_PLACEHOLDER_SUMMARIES.has(trimmed);
}

export function isIntentGatewayOperationalFailureSummary(value: string | null | undefined): boolean {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.length > 300) return false;
  return PROVIDER_FAILURE_SUMMARY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function normalizeUserFacingIntentGatewaySummary(
  value: string | null | undefined,
): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (
    !trimmed
    || isIntentGatewayPlaceholderSummary(trimmed)
    || isIntentGatewayOperationalFailureSummary(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}
