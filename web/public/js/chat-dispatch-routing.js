export function resolveChatDispatchAgentId(input = {}) {
  const hasInternalOnly = input?.hasInternalOnly === true;
  if (hasInternalOnly) {
    return undefined;
  }
  const selectedAgentId = typeof input?.selectedAgentId === 'string'
    ? input.selectedAgentId.trim()
    : '';
  return selectedAgentId || undefined;
}
