export function collapseIntentGatewayWhitespace(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

export function normalizeIntentGatewayRepairText(content: string | undefined): string {
  return collapseIntentGatewayWhitespace(content ?? '').toLowerCase();
}
