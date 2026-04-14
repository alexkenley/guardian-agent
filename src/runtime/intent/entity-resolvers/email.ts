import type { IntentGatewayEntities, IntentGatewayOperation, IntentGatewayRoute } from '../types.js';

export function inferEmailProviderFromSource(
  content: string,
  route: IntentGatewayRoute,
  personalItemType: IntentGatewayEntities['personalItemType'] | undefined,
): IntentGatewayEntities['emailProvider'] | undefined {
  if (!content) return undefined;
  const canCarryEmailProvider = route === 'email_task'
    || (route === 'personal_assistant_task' && personalItemType === 'brief');
  if (!canCarryEmailProvider) return undefined;
  const normalized = content.toLowerCase();
  if (/\b(?:outlook|microsoft 365|office 365|m365)\b/.test(normalized)) {
    return 'm365';
  }
  if (/\b(?:gmail|google workspace|google mail|gws)\b/.test(normalized)) {
    return 'gws';
  }
  return undefined;
}

export function inferMailboxReadModeFromSource(
  content: string,
  route: IntentGatewayRoute,
  operation: IntentGatewayOperation,
): IntentGatewayEntities['mailboxReadMode'] | undefined {
  if (!content || route !== 'email_task' || operation !== 'read') return undefined;
  const normalized = content.toLowerCase();
  if (/\b(?:unread|new)\b/.test(normalized)) {
    return 'unread';
  }
  if (/\b(?:newest|latest|recent|last)\b/.test(normalized)) {
    return 'latest';
  }
  return undefined;
}
