export const INTENT_GATEWAY_MISSING_SUMMARY = 'No classification summary provided.';
export const INTENT_GATEWAY_UNSTRUCTURED_SUMMARY = 'Intent gateway response was not structured.';
export const INTENT_GATEWAY_HARNESS_NO_ROUTE_SUMMARY = 'No direct route for this coding harness turn.';

const INTENT_GATEWAY_INTERNAL_PLACEHOLDER_SUMMARIES = new Set([
  INTENT_GATEWAY_MISSING_SUMMARY,
  INTENT_GATEWAY_UNSTRUCTURED_SUMMARY,
  INTENT_GATEWAY_HARNESS_NO_ROUTE_SUMMARY,
]);

export function isIntentGatewayPlaceholderSummary(value: string | null | undefined): boolean {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 && INTENT_GATEWAY_INTERNAL_PLACEHOLDER_SUMMARIES.has(trimmed);
}

export function normalizeUserFacingIntentGatewaySummary(
  value: string | null | undefined,
): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || isIntentGatewayPlaceholderSummary(trimmed)) {
    return undefined;
  }
  return trimmed;
}
