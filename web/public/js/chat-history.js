export function resolveChatHistoryKey(baseKey) {
  return typeof baseKey === 'string' ? baseKey.trim() : '';
}
