import { describe, expect, it, vi } from 'vitest';

import { decideChatApproval } from '../../web/public/js/chat-approval.js';

describe('decideChatApproval', () => {
  it('uses the code-session approval endpoint when the approval belongs to the focused session', async () => {
    const apiClient = {
      codeSessionDecideApproval: vi.fn().mockResolvedValue({ success: true, message: 'Approved in code session.' }),
      decideToolApproval: vi.fn(),
    };

    const result = await decideChatApproval({
      apiClient,
      approvalId: 'approval-1',
      decision: 'approved',
      webUserId: 'web-user-1',
      focusedSessionId: 'session-1',
      surfaceId: 'web-guardian-chat',
    });

    expect(apiClient.codeSessionDecideApproval).toHaveBeenCalledWith('session-1', 'approval-1', {
      decision: 'approved',
      userId: 'web-user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    });
    expect(apiClient.decideToolApproval).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, message: 'Approved in code session.' });
  });

  it('falls back to the shared tool approval endpoint when the focused code session does not own the approval', async () => {
    const error = Object.assign(new Error('Approval not found for code session.'), {
      code: 'CODE_SESSION_APPROVAL_NOT_FOUND',
    });
    const apiClient = {
      codeSessionDecideApproval: vi.fn().mockRejectedValue(error),
      decideToolApproval: vi.fn().mockResolvedValue({ success: true, message: 'Approved globally.' }),
    };

    const result = await decideChatApproval({
      apiClient,
      approvalId: 'approval-2',
      decision: 'approved',
      webUserId: 'web-user-1',
      focusedSessionId: 'session-1',
      surfaceId: 'web-guardian-chat',
    });

    expect(apiClient.codeSessionDecideApproval).toHaveBeenCalledOnce();
    expect(apiClient.decideToolApproval).toHaveBeenCalledWith({
      approvalId: 'approval-2',
      decision: 'approved',
      actor: 'web-user',
    });
    expect(result).toEqual({ success: true, message: 'Approved globally.' });
  });

  it('does not swallow unrelated code-session approval failures', async () => {
    const error = Object.assign(new Error('Code session unavailable.'), {
      code: 'CODE_SESSION_UNAVAILABLE',
    });
    const apiClient = {
      codeSessionDecideApproval: vi.fn().mockRejectedValue(error),
      decideToolApproval: vi.fn(),
    };

    await expect(decideChatApproval({
      apiClient,
      approvalId: 'approval-3',
      decision: 'denied',
      webUserId: 'web-user-1',
      focusedSessionId: 'session-1',
      surfaceId: 'web-guardian-chat',
    })).rejects.toThrow('Code session unavailable.');
    expect(apiClient.decideToolApproval).not.toHaveBeenCalled();
  });
});
