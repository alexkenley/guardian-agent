function isCodeSessionApprovalNotFoundError(error) {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'CODE_SESSION_APPROVAL_NOT_FOUND',
  );
}

function isStaleCodeSessionApprovalTransportError(error) {
  if (isCodeSessionApprovalNotFoundError(error)) return true;
  const message = error instanceof Error ? error.message : String(error || '');
  return message === 'NetworkError when attempting to fetch resource.'
    || message === 'Failed to fetch'
    || message.includes('/api/code/sessions/');
}

export function buildApprovalContinuationSummaryPart(result, approval, decision) {
  const toolName = typeof approval?.toolName === 'string' && approval.toolName.trim()
    ? approval.toolName.trim()
    : 'tool';
  if (result?.success === false) {
    const message = typeof result?.message === 'string' && result.message.trim()
      ? result.message.trim()
      : 'unknown error';
    return `Failed: ${toolName}: ${message}`;
  }
  return `${toolName}: ${decision === 'approved' ? 'Approved and executed' : 'Denied'}`;
}

export async function decideChatApproval(input) {
  const {
    apiClient,
    approvalId,
    decision,
    webUserId,
    focusedSessionId,
    surfaceId,
  } = input;

  if (focusedSessionId) {
    try {
      return await apiClient.codeSessionDecideApproval(focusedSessionId, approvalId, {
        decision,
        userId: webUserId,
        channel: 'web',
        surfaceId,
      });
    } catch (error) {
      if (!isStaleCodeSessionApprovalTransportError(error)) {
        throw error;
      }
    }
  }

  return apiClient.decideToolApproval({
    approvalId,
    decision,
    actor: 'web-user',
    userId: webUserId,
    channel: 'web',
    surfaceId,
  });
}
