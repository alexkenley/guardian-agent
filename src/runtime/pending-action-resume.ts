import type { PendingActionRecord } from './pending-actions.js';

const GENERIC_PENDING_ACTION_CONTINUATION_PATTERN = /^(?:ok(?:ay)?[,\s]*)?(?:now\s+)?(?:please\s+)?(?:go\s+ahead|continue|carry\s+on|resume|do\s+(?:that|it|the\s+previous\s+(?:request|task)|the\s+previous\s+one)|run\s+(?:that|it|the\s+previous\s+(?:request|task)))\.?$/i;

export function isGenericPendingActionContinuationRequest(content: string): boolean {
  return GENERIC_PENDING_ACTION_CONTINUATION_PATTERN.test(content.trim());
}

export function isWorkspaceSwitchPendingActionSatisfied(
  pendingAction: PendingActionRecord | null | undefined,
  currentSessionId: string | null | undefined,
): boolean {
  if (!pendingAction || pendingAction.blocker.kind !== 'workspace_switch') {
    return false;
  }
  const targetSessionId = pendingAction.blocker.targetSessionId?.trim();
  if (!targetSessionId) {
    return false;
  }
  return targetSessionId === (currentSessionId?.trim() || '');
}
