import { describe, expect, it, vi } from 'vitest';

import { buildApprovalContinuationSummaryPart, decideChatApproval } from '../../web/public/js/chat-approval.js';

describe('decideChatApproval', () => {
  it('normalizes continuation summaries to stable tool outcomes', () => {
    expect(buildApprovalContinuationSummaryPart(
      { success: true, message: "Policy updated: add_path '/tmp'." },
      { toolName: 'update_tool_policy' },
      'approved',
    )).toBe('update_tool_policy: Approved and executed');

    expect(buildApprovalContinuationSummaryPart(
      { success: false, message: 'Approval timed out.' },
      { toolName: 'fs_write' },
      'approved',
    )).toBe('Failed: fs_write: Approval timed out.');
  });

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
      userId: 'web-user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    });
    expect(result).toEqual({ success: true, message: 'Approved globally.' });
  });

  it('falls back to the shared tool approval endpoint when a stale code-session approval route has a transport failure', async () => {
    const apiClient = {
      codeSessionDecideApproval: vi.fn().mockRejectedValue(new Error('NetworkError when attempting to fetch resource.')),
      decideToolApproval: vi.fn().mockResolvedValue({ success: true, message: 'Approved after fallback.' }),
    };

    const result = await decideChatApproval({
      apiClient,
      approvalId: 'approval-transport',
      decision: 'approved',
      webUserId: 'web-user-1',
      focusedSessionId: 'stale-session',
      surfaceId: 'web-guardian-chat',
    });

    expect(apiClient.codeSessionDecideApproval).toHaveBeenCalledOnce();
    expect(apiClient.decideToolApproval).toHaveBeenCalledWith({
      approvalId: 'approval-transport',
      decision: 'approved',
      actor: 'web-user',
      userId: 'web-user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    });
    expect(result).toEqual({ success: true, message: 'Approved after fallback.' });
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
