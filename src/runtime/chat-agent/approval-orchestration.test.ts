import { describe, expect, it, vi } from 'vitest';

import type { AgentContext, UserMessage } from '../../agent/types.js';
import {
  continuePendingActionAfterApproval,
  handleApprovalMessage,
  syncPendingApprovalsFromExecutor,
} from './approval-orchestration.js';

describe('approval-orchestration', () => {
  it('suppresses generic tool-completed copy when a graph approval resumes into a final response', async () => {
    const pendingAction = {
      id: 'pending-1',
      scope: {
        agentId: 'chat',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'owner',
      },
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve note save',
        approvalIds: ['approval-1'],
      },
      intent: {
        route: 'personal_assistant_task',
        operation: 'create',
        originalUserContent: 'Save this note.',
      },
      resume: {
        kind: 'execution_graph',
        payload: {
          graphId: 'graph-1',
          nodeId: 'node-1',
          resumeToken: 'resume-1',
          artifactIds: [],
        },
      },
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    } as const;

    const message: UserMessage = {
      id: 'msg-1',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
      content: 'yes',
      timestamp: Date.now(),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'test' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await handleApprovalMessage({
      message,
      ctx,
      tools: {
        decideApproval: vi.fn(async () => ({
          success: true,
          message: "Tool 'second_brain_note_upsert' completed.",
        })),
        getApprovalSummaries: vi.fn(() => new Map()),
        listPendingApprovalIdsForUser: vi.fn(() => []),
      },
      getPendingApprovalAction: vi.fn(() => pendingAction as never),
      setPendingApprovals: vi.fn(),
      setPendingApprovalAction: vi.fn(() => ({ action: pendingAction })),
      completePendingAction: vi.fn(),
      takeApprovalFollowUp: vi.fn(() => null),
      clearApprovalFollowUp: vi.fn(),
      resumeStoredExecutionGraphPendingAction: vi.fn(async () => ({
        content: 'Note created: Smoke Test Note',
      })),
      normalizeApprovalContinuationResponse: vi.fn((response) => response),
      withCurrentPendingActionMetadata: vi.fn((metadata) => metadata),
      formatResolvedApprovalResultResponse: vi.fn(() => null),
      formatPendingApprovalPrompt: vi.fn(() => 'Approve it'),
      resolveApprovalTargets: vi.fn(() => ({ ids: ['approval-1'], errors: [] })),
    });

    expect(result?.content).toBe('Note created: Smoke Test Note');
  });

  it('does not synthesize a pending approval action on unrelated turns when only live approvals remain', () => {
    const setPendingApprovals = vi.fn();

    syncPendingApprovalsFromExecutor({
      tools: {
        isEnabled: () => true,
        listPendingApprovalIdsForUser: () => ['approval-1'],
      },
      sourceUserId: 'owner',
      sourceChannel: 'web',
      targetUserId: 'owner',
      targetChannel: 'web',
      surfaceId: 'web-guardian-chat',
      getPendingApprovalAction: () => null,
      setPendingApprovals,
      updatePendingAction: vi.fn(),
    });

    expect(setPendingApprovals).not.toHaveBeenCalled();
  });

  it('preserves execution binding when partial approval resolution rebuilds the pending approval action', async () => {
    const pendingAction = {
      id: 'pending-1',
      scope: {
        agentId: 'chat',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'owner',
      },
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the remaining actions',
        approvalIds: ['approval-1', 'approval-2'],
      },
      intent: {
        route: 'coding_task',
        operation: 'update',
        originalUserContent: 'Refactor the orchestration stack.',
      },
      executionId: 'exec-1',
      rootExecutionId: 'exec-root',
      codeSessionId: 'session-1',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    } as const;

    const setPendingApprovalAction = vi.fn(() => ({ action: pendingAction }));

    const result = await handleApprovalMessage({
      message: {
        id: 'msg-2',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'owner',
        content: 'approve the first one',
        timestamp: Date.now(),
      },
      ctx: {
        agentId: 'chat',
        emit: vi.fn(async () => {}),
        checkAction: vi.fn(),
        capabilities: [],
      },
      tools: {
        decideApproval: vi.fn(async () => ({
          success: true,
          message: 'Approved and executed.',
        })),
        getApprovalSummaries: vi.fn(() => new Map()),
        listPendingApprovalIdsForUser: vi.fn(() => ['approval-2']),
      },
      getPendingApprovalAction: vi.fn(() => pendingAction as never),
      setPendingApprovals: vi.fn(),
      setPendingApprovalAction,
      completePendingAction: vi.fn(),
      takeApprovalFollowUp: vi.fn(() => null),
      clearApprovalFollowUp: vi.fn(),
      resumeStoredExecutionGraphPendingAction: vi.fn(async () => null),
      normalizeApprovalContinuationResponse: vi.fn((response) => response),
      withCurrentPendingActionMetadata: vi.fn((metadata) => metadata),
      formatResolvedApprovalResultResponse: vi.fn(() => null),
      formatPendingApprovalPrompt: vi.fn(() => 'Approve the remaining action'),
      resolveApprovalTargets: vi.fn(() => ({ ids: ['approval-1'], errors: [] })),
    });

    expect(result?.content).toContain('Approve the remaining action');
    expect(setPendingApprovalAction).toHaveBeenCalledWith(
      'owner',
      'web',
      'owner',
      expect.objectContaining({
        executionId: 'exec-1',
        rootExecutionId: 'exec-root',
        codeSessionId: 'session-1',
      }),
    );
  });

  it('resumes execution graph pending actions after the final approval resolves', async () => {
    const pendingAction = {
      id: 'pending-graph-1',
      scope: {
        agentId: 'chat',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'owner',
      },
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve graph write',
        approvalIds: ['approval-graph-1'],
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        originalUserContent: 'Write the redacted scan output.',
      },
      resume: {
        kind: 'execution_graph',
        payload: {
          graphId: 'graph-1',
          nodeId: 'node-mutate',
          resumeToken: 'resume-1',
          artifactIds: ['write-spec-1'],
        },
      },
      graphInterrupt: {
        graphId: 'graph-1',
        nodeId: 'node-mutate',
        nodeKind: 'mutate',
        resumeToken: 'resume-1',
        artifactRefs: [],
      },
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    } as const;
    const resumeStoredExecutionGraphPendingAction = vi.fn(async () => ({
      content: 'Graph mutation resumed and verified.',
      metadata: { graphId: 'graph-1' },
    }));
    const completePendingAction = vi.fn();

    const result = await handleApprovalMessage({
      message: {
        id: 'msg-graph',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'owner',
        content: 'approve',
        timestamp: Date.now(),
      },
      ctx: {
        agentId: 'chat',
        emit: vi.fn(async () => {}),
        checkAction: vi.fn(),
        capabilities: [],
      },
      tools: {
        decideApproval: vi.fn(async () => ({
          success: true,
          message: "Tool 'fs_write' completed.",
        })),
        getApprovalSummaries: vi.fn(() => new Map()),
        listPendingApprovalIdsForUser: vi.fn(() => []),
      },
      getPendingApprovalAction: vi.fn(() => pendingAction as never),
      setPendingApprovals: vi.fn(),
      setPendingApprovalAction: vi.fn(() => ({ action: pendingAction })),
      completePendingAction,
      takeApprovalFollowUp: vi.fn(() => null),
      clearApprovalFollowUp: vi.fn(),
      resumeStoredExecutionGraphPendingAction,
      normalizeApprovalContinuationResponse: vi.fn((response) => response),
      withCurrentPendingActionMetadata: vi.fn((metadata) => metadata),
      formatResolvedApprovalResultResponse: vi.fn(() => null),
      formatPendingApprovalPrompt: vi.fn(() => 'Approve graph write'),
      resolveApprovalTargets: vi.fn(() => ({ ids: ['approval-graph-1'], errors: [] })),
    });

    expect(result).toEqual({
      content: 'Graph mutation resumed and verified.',
      metadata: { graphId: 'graph-1' },
    });
    expect(resumeStoredExecutionGraphPendingAction).toHaveBeenCalledWith(
      pendingAction,
      expect.objectContaining({ approvalId: 'approval-graph-1' }),
    );
    expect(completePendingAction).not.toHaveBeenCalled();
  });

  it('completes graph pending actions when the graph resume handler is unavailable', async () => {
    const pendingAction = {
      id: 'pending-graph-missing-handler',
      scope: {
        agentId: 'chat',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'owner',
      },
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve graph write',
        approvalIds: ['approval-graph-missing-handler'],
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        originalUserContent: 'Write the redacted scan output.',
      },
      resume: {
        kind: 'execution_graph',
        payload: {
          graphId: 'graph-missing-handler',
          nodeId: 'node-mutate',
          resumeToken: 'resume-missing-handler',
          artifactIds: ['write-spec-1'],
        },
      },
      graphInterrupt: {
        graphId: 'graph-missing-handler',
        nodeId: 'node-mutate',
        nodeKind: 'mutate',
        resumeToken: 'resume-missing-handler',
        artifactRefs: [],
      },
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    } as const;
    const completePendingAction = vi.fn();

    const result = await handleApprovalMessage({
      message: {
        id: 'msg-graph-missing-handler',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'owner',
        content: 'approve',
        timestamp: Date.now(),
      },
      ctx: {
        agentId: 'chat',
        emit: vi.fn(async () => {}),
        checkAction: vi.fn(),
        capabilities: [],
      },
      tools: {
        decideApproval: vi.fn(async () => ({
          success: true,
          approved: true,
          message: "Tool 'fs_write' completed.",
        })),
        getApprovalSummaries: vi.fn(() => new Map()),
        listPendingApprovalIdsForUser: vi.fn(() => []),
      },
      getPendingApprovalAction: vi.fn(() => pendingAction as never),
      setPendingApprovals: vi.fn(),
      setPendingApprovalAction: vi.fn(() => ({ action: pendingAction })),
      completePendingAction,
      takeApprovalFollowUp: vi.fn(() => null),
      clearApprovalFollowUp: vi.fn(),
      resumeStoredExecutionGraphPendingAction: vi.fn(async () => null),
      normalizeApprovalContinuationResponse: vi.fn((response) => response),
      withCurrentPendingActionMetadata: vi.fn((metadata) => metadata),
      formatResolvedApprovalResultResponse: vi.fn(() => null),
      formatPendingApprovalPrompt: vi.fn(() => 'Approve graph write'),
      resolveApprovalTargets: vi.fn(() => ({ ids: ['approval-graph-missing-handler'], errors: [] })),
    });

    expect(result?.content).toContain('persisted execution graph could not be resumed');
    expect(result?.metadata).toEqual({
      executionGraph: {
        graphId: 'graph-missing-handler',
        status: 'failed',
        reason: 'execution_graph_resume_unavailable',
      },
    });
    expect(completePendingAction).toHaveBeenCalledWith('pending-graph-missing-handler');
  });

  it('uses the shared continuation path for externally approved execution graph actions', async () => {
    const pendingAction = {
      id: 'pending-graph-api',
      scope: {
        agentId: 'chat',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'owner',
      },
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve graph write',
        approvalIds: ['approval-graph-api'],
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        originalUserContent: 'Write the redacted scan output.',
      },
      resume: {
        kind: 'execution_graph',
        payload: {
          graphId: 'graph-api',
          nodeId: 'node-mutate',
          resumeToken: 'resume-api',
          artifactIds: ['write-spec-api'],
        },
      },
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    } as const;
    const resumeStoredExecutionGraphPendingAction = vi.fn(async () => ({
      content: 'Graph resumed from API approval.',
      metadata: { executionGraph: { graphId: 'graph-api', status: 'succeeded' } },
    }));
    const completePendingAction = vi.fn();

    const response = await continuePendingActionAfterApproval({
      pendingAction,
      approvalId: 'approval-graph-api',
      decision: 'approved',
      approvalResult: {
        success: true,
        approved: true,
        message: "Tool 'fs_write' completed.",
      },
      stateAgentId: 'chat',
      completePendingAction,
      resumeStoredExecutionGraphPendingAction,
      normalizeApprovalContinuationResponse: vi.fn((result) => result),
      withCurrentPendingActionMetadata: vi.fn((metadata) => metadata),
    });

    expect(response?.content).toBe('Graph resumed from API approval.');
    expect(resumeStoredExecutionGraphPendingAction).toHaveBeenCalledWith(
      pendingAction,
      {
        approvalId: 'approval-graph-api',
        approvalResult: expect.objectContaining({ approved: true }),
      },
    );
    expect(completePendingAction).not.toHaveBeenCalled();
  });
});
