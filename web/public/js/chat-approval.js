function isCodeSessionApprovalNotFoundError(error) {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'CODE_SESSION_APPROVAL_NOT_FOUND',
  );
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
      if (!isCodeSessionApprovalNotFoundError(error)) {
        throw error;
      }
    }
  }

  return apiClient.decideToolApproval({
    approvalId,
    decision,
    actor: 'web-user',
  });
}
