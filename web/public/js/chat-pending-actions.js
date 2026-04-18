const ACTIVE_PENDING_ACTION_STATUSES = new Set([
  'pending',
  'resolving',
  'running',
]);

export function canClearPendingActionFromChat(pendingAction, options = {}) {
  if (!pendingAction || typeof pendingAction !== 'object') {
    return false;
  }

  const pendingId = typeof pendingAction.id === 'string' ? pendingAction.id.trim() : '';
  if (!pendingId) {
    return false;
  }

  const blockerKind = typeof pendingAction.blocker?.kind === 'string'
    ? pendingAction.blocker.kind.trim()
    : '';
  if (blockerKind === 'approval') {
    return false;
  }

  const status = typeof pendingAction.status === 'string' ? pendingAction.status.trim() : '';
  if (ACTIVE_PENDING_ACTION_STATUSES.has(status)) {
    return true;
  }

  return options.syntheticPendingAction === true;
}

export function describePendingActionClearLabel(pendingAction) {
  const blockerKind = typeof pendingAction?.blocker?.kind === 'string'
    ? pendingAction.blocker.kind.trim()
    : '';
  if (blockerKind === 'clarification') {
    return 'Clear question';
  }
  if (blockerKind === 'workspace_switch') {
    return 'Clear workspace switch';
  }
  return 'Clear blocked request';
}
