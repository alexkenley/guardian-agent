import { describe, expect, it, vi } from 'vitest';

import { buildToolLoopResumePayload } from './tool-loop-resume.js';
import {
  buildBlockedToolLoopPendingApprovalResume,
  resumeStoredToolLoopPendingAction,
} from './tool-loop-runtime.js';
import type { PendingActionRecord } from '../pending-actions.js';

describe('tool-loop-runtime', () => {
  it('builds blocked approval resumes after pruning pending observations and deferred calls', () => {
    const llmMessages = [
      { role: 'system' as const, content: 'system prompt' },
      { role: 'user' as const, content: 'Run the remote test.' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [
          { id: 'pending-call', name: 'fs_write', arguments: '{}' },
          { id: 'deferred-call', name: 'code_test', arguments: '{}' },
        ],
      },
      {
        role: 'tool' as const,
        toolCallId: 'pending-call',
        content: '{"status":"pending_approval"}',
      },
      {
        role: 'tool' as const,
        toolCallId: 'deferred-call',
        content: '{"status":"deferred_remote_sandbox_step"}',
      },
    ];

    const resume = buildBlockedToolLoopPendingApprovalResume({
      toolResults: [
        {
          status: 'fulfilled',
          value: {
            toolCall: { id: 'pending-call', name: 'fs_write', arguments: '{}' },
            result: {
              status: 'pending_approval',
              approvalId: 'approval-1',
              jobId: 'job-1',
            },
          },
        },
        {
          status: 'fulfilled',
          value: {
            toolCall: { id: 'deferred-call', name: 'code_test', arguments: '{}' },
            result: {
              status: 'deferred_remote_sandbox_step',
            },
          },
        },
      ],
      llmMessages,
      deferredRemoteToolCallIds: new Set(['deferred-call']),
      originalMessage: {
        id: 'msg-1',
        userId: 'owner',
        channel: 'web',
        timestamp: 1,
        content: 'Run the remote test.',
      },
      requestText: 'Run the remote test.',
      referenceTime: 1,
      allowModelMemoryMutation: false,
      activeSkillIds: [],
      contentTrustLevel: 'trusted',
      taintReasons: [],
    });

    expect(resume?.kind).toBe('tool_loop');
    expect(llmMessages.at(-1)).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'pending-call', name: 'fs_write', arguments: '{}' },
      ],
    });
    expect(resume?.payload).toMatchObject({
      type: 'suspended_tool_loop',
      pendingTools: [
        {
          approvalId: 'approval-1',
          toolCallId: 'pending-call',
          jobId: 'job-1',
          name: 'fs_write',
        },
      ],
    });
  });

  it('recovers a final answer from the approved tool result when the first resume turn is empty', async () => {
    const pendingAction: PendingActionRecord = {
      id: 'pending-1',
      scope: {
        agentId: 'chat',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      status: 'pending',
      transferPolicy: 'linked_surfaces_same_user',
      blocker: {
        kind: 'approval',
        prompt: 'Approve web search.',
        approvalIds: ['approval-1'],
      },
      intent: {
        route: 'search_task',
        operation: 'search',
        originalUserContent: 'Search the web for approval workflow practices and compare them to this repo.',
        summary: 'Search web approval practices.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: {},
      },
      resume: {
        kind: 'tool_loop',
        payload: buildToolLoopResumePayload({
          llmMessages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'Search the web for approval workflow practices and compare them to this repo.' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'tool-call-1',
                  name: 'web_search',
                  arguments: JSON.stringify({ query: 'AI agent approval workflow patterns' }),
                },
              ],
            },
          ],
          pendingTools: [
            {
              approvalId: 'approval-1',
              toolCallId: 'tool-call-1',
              jobId: 'job-1',
              name: 'web_search',
            },
          ],
          originalMessage: {
            id: 'msg-1',
            userId: 'owner',
            channel: 'web',
            surfaceId: 'web-guardian-chat',
            timestamp: 1,
            content: 'Search the web for approval workflow practices and compare them to this repo.',
          },
          requestText: 'Search the web for approval workflow practices and compare them to this repo.',
          referenceTime: 1,
          allowModelMemoryMutation: false,
          activeSkillIds: [],
          contentTrustLevel: 'trusted',
          taintReasons: [],
          intentDecision: {
            route: 'search_task',
            operation: 'search',
            summary: 'Search web approval practices.',
            confidence: 'high',
            turnRelation: 'new_request',
            resolution: 'ready',
            missingFields: [],
            executionClass: 'tool_orchestration',
            preferredTier: 'external',
            requiresRepoGrounding: false,
            requiresToolSynthesis: true,
            expectedContextPressure: 'medium',
            preferredAnswerPath: 'tool_loop',
            simpleVsComplex: 'complex',
            entities: {},
          },
        }),
      },
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    };

    let callNumber = 0;
    const chatFn = vi.fn(async (messages, options) => {
      callNumber += 1;
      if (callNumber === 1) {
        return {
          content: '',
          toolCalls: [],
          model: 'test-model',
          finishReason: 'stop' as const,
        };
      }
      expect(options?.tools).toEqual([]);
      expect(messages.map((message) => message.content).join('\n')).toContain('AI agent approval workflow patterns');
      return {
        content: 'Recent practice is human-in-the-loop approval with scoped resumable tool execution.',
        toolCalls: [],
        model: 'test-model',
        finishReason: 'stop' as const,
      };
    });

    const result = await resumeStoredToolLoopPendingAction({
      pendingAction,
      options: {
        approvalId: 'approval-1',
        approvalResult: {
          success: true,
          approved: true,
          executionSucceeded: true,
          message: "Tool 'web_search' completed.",
          result: {
            success: true,
            status: 'succeeded',
            output: {
              query: 'AI agent approval workflow patterns',
              results: [
                { title: 'Human-in-the-loop approvals', url: 'https://example.test/approval' },
              ],
            },
          },
        },
      },
      agentId: 'chat',
      tools: {
        executeModelTool: vi.fn(),
        getApprovalSummaries: vi.fn(() => new Map()),
        getToolDefinition: vi.fn(() => undefined),
        isEnabled: vi.fn(() => true),
        listAlwaysLoadedDefinitions: vi.fn(() => []),
        listCodeSessionEagerToolDefinitions: vi.fn(() => []),
        listJobs: vi.fn(() => []),
      },
      secondBrainService: null,
      maxToolRounds: 2,
      contextBudget: 32_000,
      normalizePrincipalRole: () => 'owner',
      buildChatRunner: () => ({
        providerLocality: 'external',
        chatFn,
      }),
      completePendingAction: vi.fn(),
      sanitizeToolResultForLlm: vi.fn((_toolName, result) => ({
        sanitized: result,
        threats: [],
        trustLevel: 'trusted',
        taintReasons: [],
      })),
      setPendingApprovalAction: vi.fn(() => {
        throw new Error('unexpected pending approval');
      }),
      buildPendingApprovalBlockedResponse: vi.fn(() => {
        throw new Error('unexpected blocked response');
      }),
      lacksUsableAssistantContent: (content) => !content?.trim(),
    });

    expect(chatFn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      content: 'Recent practice is human-in-the-loop approval with scoped resumable tool execution.',
    });
  });

  it('does not treat intermediate retry narration as a completed resumed tool-loop answer', async () => {
    const pendingAction: PendingActionRecord = {
      id: 'pending-1',
      scope: {
        agentId: 'chat',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      status: 'pending',
      transferPolicy: 'linked_surfaces_same_user',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the remote command.',
        approvalIds: ['approval-1'],
      },
      intent: {
        route: 'coding_task',
        operation: 'run',
        originalUserContent: 'Run `pwd` in the remote sandbox.',
        summary: 'Run a remote sandbox command.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: {},
      },
      resume: {
        kind: 'tool_loop',
        payload: buildToolLoopResumePayload({
          llmMessages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'Run `pwd` in the remote sandbox.' },
          ],
          pendingTools: [
            {
              approvalId: 'approval-1',
              toolCallId: 'tool-call-1',
              jobId: 'job-1',
              name: 'code_remote_exec',
            },
          ],
          originalMessage: {
            id: 'msg-1',
            userId: 'owner',
            channel: 'web',
            surfaceId: 'web-guardian-chat',
            timestamp: 1,
            content: 'Run `pwd` in the remote sandbox.',
          },
          requestText: 'Run `pwd` in the remote sandbox.',
          referenceTime: 1,
          allowModelMemoryMutation: false,
          activeSkillIds: [],
          contentTrustLevel: 'trusted',
          taintReasons: [],
          intentDecision: {
            route: 'coding_task',
            operation: 'run',
            summary: 'Run a remote sandbox command.',
            confidence: 'high',
            turnRelation: 'new_request',
            resolution: 'ready',
            missingFields: [],
            executionClass: 'repo_grounded',
            preferredTier: 'external',
            requiresRepoGrounding: true,
            requiresToolSynthesis: true,
            expectedContextPressure: 'medium',
            preferredAnswerPath: 'tool_loop',
            simpleVsComplex: 'complex',
            entities: {},
          },
        }),
      },
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    };

    const chatFn = vi.fn(async () => ({
      content: 'Let me retry once to rule out a transient issue:',
      toolCalls: [],
      model: 'test-model',
      finishReason: 'stop' as const,
    }));

    const result = await resumeStoredToolLoopPendingAction({
      pendingAction,
      options: {
        approvalId: 'approval-1',
        approvalResult: {
          success: true,
          approved: true,
          executionSucceeded: false,
          message: "Tool 'code_remote_exec' failed.",
          result: {
            success: false,
            error: 'Remote sandbox command failed on Daytona Main.',
          },
        },
      },
      agentId: 'chat',
      tools: {
        executeModelTool: vi.fn(),
        getApprovalSummaries: vi.fn(() => new Map()),
        getToolDefinition: vi.fn(() => undefined),
        isEnabled: vi.fn(() => true),
        listAlwaysLoadedDefinitions: vi.fn(() => []),
        listCodeSessionEagerToolDefinitions: vi.fn(() => []),
        listJobs: vi.fn(() => []),
      },
      secondBrainService: null,
      maxToolRounds: 2,
      contextBudget: 32_000,
      normalizePrincipalRole: () => 'owner',
      buildChatRunner: () => ({
        providerLocality: 'external',
        chatFn,
      }),
      completePendingAction: vi.fn(),
      sanitizeToolResultForLlm: vi.fn((_toolName, result) => ({
        sanitized: result,
        threats: [],
        trustLevel: 'trusted',
        taintReasons: [],
      })),
      isResponseDegraded: vi.fn(() => false),
      setPendingApprovalAction: vi.fn(() => {
        throw new Error('unexpected pending approval');
      }),
      buildPendingApprovalBlockedResponse: vi.fn(() => {
        throw new Error('unexpected blocked response');
      }),
    });

    expect(chatFn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      content: 'Attempted code_remote_exec, but it did not complete successfully.',
    });
  });
});
