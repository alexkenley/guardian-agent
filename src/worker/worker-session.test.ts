import { describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '../llm/types.js';
import { buildApprovalOutcomeContinuationMetadata } from '../runtime/approval-continuations.js';
import { attachPreRoutedIntentGatewayMetadata } from '../runtime/intent-gateway.js';
import { BrokeredWorkerSession } from './worker-session.js';

const baseParams = {
  systemPrompt: 'system',
  history: [],
  knowledgeBases: [],
  activeSkills: [],
  toolContext: '',
  runtimeNotices: [],
};

function buildComplexPlanningMetadata() {
  return attachPreRoutedIntentGatewayMetadata(undefined, {
    mode: 'primary',
    available: true,
    model: 'gateway-model',
    latencyMs: 12,
    decision: {
      route: 'complex_planning_task',
      confidence: 'high',
      operation: 'execute',
      summary: 'Plan and execute a multi-step task.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      entities: {},
    },
  });
}

describe('BrokeredWorkerSession automation control', () => {
  it('refreshes loaded tools for code-session turns so coding helpers are visible to the worker', async () => {
    let loadedTools = [
      {
        name: 'fs_list',
        description: 'List files.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'code_plan',
        description: 'Generate a coding plan.',
        parameters: { type: 'object', properties: { task: { type: 'string' } } },
      },
    ];
    const listLoadedTools = vi.fn(async () => loadedTools);
    const llmChat = vi.fn(async (_messages, options) => {
      const firstTool = options?.tools?.[0]?.name;
      if (firstTool === 'route_intent') {
        return {
          content: JSON.stringify({
            route: 'none',
            confidence: 'low',
            summary: 'Stay in the normal coding assistant path.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      return {
        content: 'Acceptance Gates\n- Keep the change bounded.\n\nExisting Checks To Reuse\n- Run the existing coding harness.',
        model: 'test-model',
        finishReason: 'stop',
        toolCalls: [],
        providerLocality: 'external',
        providerName: 'anthropic',
      } as ChatResponse;
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => loadedTools,
      listLoadedTools,
      llmChat,
      callTool: vi.fn(),
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-code-1',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Write an implementation plan before editing anything.',
        timestamp: Date.now(),
        metadata: {
          codeContext: {
            workspaceRoot: '/repo',
            sessionId: 'code-1',
          },
        },
      },
    });

    expect(listLoadedTools).toHaveBeenCalledWith({
      codeContext: {
        workspaceRoot: '/repo',
        sessionId: 'code-1',
      },
    });
    expect(llmChat).toHaveBeenCalled();
    const codingCall = llmChat.mock.calls.find((call) => Array.isArray(call[1]?.tools) && call[1]?.tools.some((tool: { name: string }) => tool.name === 'code_plan'));
    const seenTools = codingCall?.[1]?.tools?.map((tool: { name: string }) => tool.name) ?? [];
    expect(seenTools).toContain('code_plan');
  });

  it('uses the tool-free writing-plans pass before entering the brokered tool loop', async () => {
    const listLoadedTools = vi.fn(async () => [
      {
        name: 'code_plan',
        description: 'Generate a coding plan.',
        parameters: { type: 'object', properties: { task: { type: 'string' } } },
      },
    ]);
    const llmChat = vi.fn(async (_messages, options) => {
      const firstTool = options?.tools?.[0]?.name;
      if (firstTool === 'route_intent') {
        return {
          content: JSON.stringify({
            route: 'none',
            confidence: 'low',
            summary: 'Stay in the normal coding assistant path.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      if (Array.isArray(options?.tools) && options.tools.length === 0) {
        return {
          content: 'Acceptance Gates\n- Keep the archived-routines scope bounded.\n\nExisting Checks To Reuse\n- Reuse the current dashboard and coding harness coverage.',
          model: 'test-model',
          finishReason: 'stop',
          toolCalls: [],
          providerLocality: 'external',
          providerName: 'anthropic',
        } as ChatResponse;
      }
      throw new Error('The brokered worker should not enter the tool loop when answer-first succeeds.');
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [],
      listLoadedTools,
      llmChat,
      callTool: vi.fn(),
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      activeSkills: [{
        id: 'writing-plans',
        name: 'Writing Plans',
        summary: 'Write bounded implementation plans with acceptance gates and existing checks.',
      }],
      message: {
        id: 'msg-plan-answer-first',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Write an implementation plan for adding archived routines to this app. Break this down before editing anything.',
        timestamp: Date.now(),
        metadata: {
          codeContext: {
            workspaceRoot: '/repo',
            sessionId: 'code-1',
          },
        },
      },
    });

    expect(result.content).toContain('Acceptance Gates');
    expect(result.content).toContain('Existing Checks To Reuse');
    expect(result.metadata).toMatchObject({
      workerExecution: {
        lifecycle: 'completed',
        source: 'tool_loop',
        completionReason: 'model_response',
        responseQuality: 'final',
      },
    });
    expect(llmChat).toHaveBeenCalled();
    expect(llmChat.mock.calls.some((call) => Array.isArray(call[1]?.tools) && call[1]?.tools.length === 0)).toBe(true);
    expect(llmChat.mock.calls.some((call) => Array.isArray(call[1]?.tools) && call[1]?.tools.some((tool: { name: string }) => tool.name === 'code_plan'))).toBe(false);
  });

  it('suppresses approval-looking text when no real approval metadata exists', async () => {
    const llmChat = vi.fn(async (_messages, options) => {
      const firstTool = options?.tools?.[0]?.name;
      if (firstTool === 'route_intent') {
        return {
          content: JSON.stringify({
            route: 'none',
            confidence: 'low',
            summary: 'Stay in the normal assistant path.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      return {
        content: [
          'Great news — Claude Code is now enabled!',
          '',
          'Now let me run the connection test with Claude Code:',
          '',
          'Waiting for approval to run coding_backend_run - {"task":"Say hello and confirm you are working.","backend":"claude-code"}.',
        ].join('\n'),
        model: 'test-model',
        finishReason: 'stop',
        toolCalls: [],
        providerLocality: 'external',
        providerName: 'anthropic',
      } as ChatResponse;
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [],
      llmChat,
      callTool: vi.fn(),
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-phantom-approval',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Try Claude Code again.',
        timestamp: Date.now(),
      },
    });

    expect(result.content).toBe('I did not create a real approval request for that action. Please try again.');
    expect(result.metadata).toMatchObject({
      workerExecution: {
        lifecycle: 'failed',
        source: 'tool_loop',
        completionReason: 'phantom_approval_response',
        responseQuality: 'degraded',
      },
      responseSource: {
        locality: 'external',
        providerName: 'anthropic',
      },
    });
    expect(result.metadata).not.toHaveProperty('pendingApprovals');
  });

  it('marks narration-only worker replies as failed execution metadata instead of completed work', async () => {
    const llmChat = vi.fn(async (_messages, options) => {
      const firstTool = options?.tools?.[0]?.name;
      if (firstTool === 'route_intent') {
        return {
          content: JSON.stringify({
            route: 'none',
            confidence: 'low',
            summary: 'Stay in the normal assistant path.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      return {
        content: 'I will inspect the repository first and then start making the requested changes.',
        model: 'test-model',
        finishReason: 'stop',
        toolCalls: [],
        providerLocality: 'external',
        providerName: 'anthropic',
      } as ChatResponse;
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [],
      llmChat,
      callTool: vi.fn(),
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-intermediate-worker',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Inspect the repo and fix the bug.',
        timestamp: Date.now(),
      },
    });

    expect(result.content).toContain('inspect the repository first');
    expect(result.metadata).toMatchObject({
      workerExecution: {
        lifecycle: 'failed',
        source: 'tool_loop',
        completionReason: 'intermediate_response',
        responseQuality: 'intermediate',
        toolCallCount: 0,
        toolResultCount: 0,
      },
    });
  });

  it('marks quarantined tool results so the worker can explain inspection limits instead of inventing a summary', async () => {
    let assistantCallCount = 0;
    const llmChat = vi.fn(async (messages, options) => {
      const firstTool = options?.tools?.[0]?.name;
      if (firstTool === 'route_intent') {
        return {
          content: JSON.stringify({
            route: 'coding_task',
            confidence: 'high',
            operation: 'inspect',
            summary: 'Inspect the requested repository file.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }

      assistantCallCount += 1;
      if (assistantCallCount === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'call-1',
            name: 'fs_read',
            arguments: JSON.stringify({ path: 'SECURITY.md' }),
          }],
          model: 'test-model',
          finishReason: 'tool_calls',
        } satisfies ChatResponse;
      }

      const toolMessage = messages.findLast((message) => message.role === 'tool');
      const systemMessage = messages.findLast((message) => message.role === 'system');
      expect(typeof toolMessage?.content).toBe('string');
      expect(String(toolMessage?.content)).toContain('inspectionRestricted');
      expect(String(toolMessage?.content)).toContain('safeHandlingNote');
      expect(String(toolMessage?.content)).toContain('Do not claim you inspected or summarized the quarantined raw content');
      expect(typeof systemMessage?.content).toBe('string');
      expect(String(systemMessage?.content)).toContain('do not infer or fabricate a summary');
      return {
        content: 'I could not safely inspect the quarantined raw content.',
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse;
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [{
        name: 'fs_read',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
        risk: 'read_only',
      }],
      listLoadedTools: vi.fn(async () => []),
      llmChat,
      callTool: vi.fn(async () => ({
        success: true,
        status: 'succeeded',
        jobId: 'job-read-1',
        message: 'Read SECURITY.md.',
        output: {
          quarantined: true,
          trustLevel: 'quarantined',
          taintReasons: ['prompt_injection_signals'],
          preview: 'Raw content withheld.',
        },
        trustLevel: 'quarantined',
        taintReasons: ['prompt_injection_signals'],
      })),
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-quarantined-inspect',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Inspect SECURITY.md and summarize it.',
        timestamp: Date.now(),
        metadata: {
          codeContext: {
            workspaceRoot: '/repo',
            sessionId: 'code-1',
          },
        },
      },
    });

    expect(result.content).toBe('I could not safely inspect the quarantined raw content.');
  });

  it('resumes suspended approval-backed runs through structured continuation metadata without reclassifying the turn', async () => {
    const llmChat = vi.fn(async (_messages, options) => {
      const firstTool = options?.tools?.[0]?.name;
      if (firstTool === 'route_intent') {
        return {
          content: JSON.stringify({
            route: 'coding_task',
            confidence: 'high',
            operation: 'search',
            summary: 'Search the repo.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      const lastMessage = _messages.at(-1);
      if (lastMessage?.role === 'tool' && lastMessage.toolCallId === 'call-search-1') {
        return {
          content: 'The routing references are in src/config/types.ts and src/runtime/message-router.ts.',
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      if (options?.tools?.some((tool: { name: string }) => tool.name === 'fs_search')) {
        return {
          content: '',
          model: 'test-model',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'call-search-1',
            name: 'fs_search',
            arguments: JSON.stringify({ path: '.', pattern: 'ollama_cloud' }),
          }],
        } satisfies ChatResponse;
      }
      throw new Error(`Unexpected llmChat tool call ${firstTool ?? 'unknown'}`);
    });

    const callTool = vi.fn(async (request: { toolName: string }) => {
      if (request.toolName !== 'fs_search') {
        throw new Error(`Unexpected tool ${request.toolName}`);
      }
      return {
        success: false,
        status: 'pending_approval',
        jobId: 'job-search-1',
        approvalId: 'approval-search-1',
        message: 'fs_search is awaiting approval.',
        approvalSummary: {
          toolName: 'fs_search',
          argsPreview: '{"path":".","pattern":"ollama_cloud"}',
          actionLabel: 'Search the repo for ollama_cloud',
        },
      };
    });

    const getApprovalResult = vi.fn(async (approvalId: string) => {
      expect(approvalId).toBe('approval-search-1');
      return {
        success: true,
        message: 'Search completed.',
        output: {
          matches: [
            { path: 'src/config/types.ts' },
            { path: 'src/runtime/message-router.ts' },
          ],
        },
      };
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [{
        name: 'fs_search',
        description: 'Search files for a pattern.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            pattern: { type: 'string' },
          },
          required: ['path', 'pattern'],
        },
      }],
      listLoadedTools: vi.fn(async () => []),
      llmChat,
      callTool,
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult,
    } as never);

    const initial = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-approval-start',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Search the repo for ollama_cloud routing references.',
        timestamp: Date.now(),
      },
    });

    expect(initial.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          approvalSummaries: [
            {
              id: 'approval-search-1',
              toolName: 'fs_search',
            },
          ],
        },
      },
    });

    const resumed = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-approval-resume',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: '',
        metadata: buildApprovalOutcomeContinuationMetadata({
          approvalId: 'approval-search-1',
          decision: 'approved',
          resultMessage: 'Search completed.',
        }),
        timestamp: Date.now(),
      },
    });

    expect(resumed.content).toContain('src/config/types.ts');
    expect(resumed.content).toContain('src/runtime/message-router.ts');
    expect(getApprovalResult).toHaveBeenCalledWith('approval-search-1');
    expect(
      llmChat.mock.calls.filter(([, options]) => options?.tools?.[0]?.name === 'route_intent'),
    ).toHaveLength(1);
  });

  it('retries through fallback providers when the selected model fails with a retryable API error', async () => {
    const llmChat = vi.fn(async (_messages, _options, routing) => {
      if (routing?.useFallback === true) {
        return {
          content: 'Fallback provider completed the request.',
          model: 'grok-4.1-fast-reasoning',
          finishReason: 'stop',
          providerLocality: 'external',
          providerName: 'xai',
        } as ChatResponse;
      }
      throw new Error('Ollama Cloud API error 503: Service Temporarily Unavailable');
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [],
      listLoadedTools: vi.fn(async () => []),
      llmChat,
      callTool: vi.fn(),
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      hasFallbackProvider: true,
      executionProfile: {
        id: 'managed_cloud_direct',
        providerName: 'ollama-cloud-coding',
        providerType: 'ollama_cloud',
        providerModel: 'glm-5.1',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'direct',
        expectedContextPressure: 'low',
        contextBudget: 80_000,
        toolContextMode: 'standard',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['xai'],
        reason: 'test fallback profile',
      },
      message: {
        id: 'msg-fallback-retry',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Create a quick summary of the current workspace state.',
        timestamp: Date.now(),
        metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
          mode: 'primary',
          available: true,
          model: 'gateway-model',
          latencyMs: 5,
          decision: {
            route: 'general_assistant',
            confidence: 'high',
            operation: 'read',
            summary: 'Answer directly.',
            turnRelation: 'new_request',
            resolution: 'ready',
            missingFields: [],
            entities: {},
          },
        }),
      },
    });

    expect(result.content).toBe('Fallback provider completed the request.');
    expect(llmChat.mock.calls.some((call) => call[2]?.useFallback === true)).toBe(true);
    expect(result.metadata).toMatchObject({
      responseSource: {
        locality: 'external',
        providerName: 'xai',
        providerTier: 'frontier',
        model: 'grok-4.1-fast-reasoning',
        usedFallback: true,
        notice: 'Retried with an alternate model after the selected model failed to complete the request.',
      },
    });
  });

  it('resumes approval-blocked remote runs with the original request text so follow-up remote steps keep the same profile', async () => {
    const llmChat = vi.fn(async (messages, options) => {
      const firstTool = options?.tools?.[0]?.name;
      if (firstTool === 'route_intent') {
        throw new Error('The pre-routed coding intent should have been reused.');
      }
      if (Array.isArray(options?.tools) && options.tools.length === 0) {
        return {
          content: 'Approval is pending.',
          model: 'test-model',
          finishReason: 'stop',
          toolCalls: [],
          providerLocality: 'external',
          providerName: 'ollama-cloud-coding',
        } as ChatResponse;
      }
      const hasFirstToolResult = messages.some((entry) => entry.role === 'tool' && entry.toolCallId === 'tool-call-1');
      const hasSecondToolResult = messages.some((entry) => entry.role === 'tool' && entry.toolCallId === 'tool-call-2');
      if (!hasFirstToolResult) {
        return {
          content: '',
          model: 'test-model',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'tool-call-1',
            name: 'code_remote_exec',
            arguments: JSON.stringify({ command: 'pwd' }),
          }],
          providerLocality: 'external',
          providerName: 'ollama-cloud-coding',
        } as ChatResponse;
      }
      if (!hasSecondToolResult) {
        return {
          content: '',
          model: 'test-model',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'tool-call-2',
            name: 'code_remote_exec',
            arguments: JSON.stringify({ command: 'pwd' }),
          }],
          providerLocality: 'external',
          providerName: 'ollama-cloud-coding',
        } as ChatResponse;
      }
      return {
        content: 'Remote sandbox retry stayed pinned to the Daytona profile.',
        model: 'test-model',
        finishReason: 'stop',
        toolCalls: [],
        providerLocality: 'external',
        providerName: 'ollama-cloud-coding',
      } as ChatResponse;
    });

    let remoteCallCount = 0;
    const callTool = vi.fn(async (request: Record<string, unknown>) => {
      if (request.toolName !== 'code_remote_exec') {
        throw new Error(`Unexpected tool ${String(request.toolName)}`);
      }
      remoteCallCount += 1;
      if (remoteCallCount === 1) {
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-remote-1',
          jobId: 'job-remote-1',
          message: 'Approval required.',
          approvalSummary: {
            toolName: 'code_remote_exec',
            argsPreview: '{"command":"pwd","profile":"Daytona"}',
          },
        };
      }
      expect(request.args).toMatchObject({
        command: 'pwd',
        profile: 'Daytona',
      });
      expect(request.codeContext).toMatchObject({
        workspaceRoot: '/repo',
        sessionId: 'session-123',
      });
      return {
        success: true,
        status: 'succeeded',
        jobId: 'job-remote-2',
        message: 'Ran pwd in the resumed sandbox.',
        output: {
          stdout: '/workspace',
          stderr: '',
        },
      };
    });

    const getApprovalResult = vi.fn(async () => ({
      success: true,
      status: 'approved',
      jobId: 'job-remote-1',
      message: 'Approved and executed.',
      output: {
        stdout: '/workspace',
        stderr: '',
      },
    }));

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [{
        name: 'code_remote_exec',
        description: 'Run a command in the remote sandbox.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            profile: { type: 'string' },
          },
          required: ['command'],
        },
        risk: 'mutating',
      }],
      listLoadedTools: vi.fn(async () => []),
      llmChat,
      callTool,
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult,
    } as never);

    const initial = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-remote-start',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        surfaceId: 'surface-remote',
        channel: 'web',
        content: 'In the Guardian workspace, run `pwd` in the remote sandbox using the Daytona profile for this coding session, then run `pwd` again in the same remote sandbox.',
        timestamp: Date.now(),
        metadata: attachPreRoutedIntentGatewayMetadata({
          codeContext: {
            workspaceRoot: '/repo',
            sessionId: 'session-123',
          },
        }, {
          mode: 'primary',
          available: true,
          model: 'gateway-model',
          latencyMs: 5,
          decision: {
            route: 'coding_task',
            confidence: 'high',
            operation: 'run',
            summary: 'Run remote sandbox commands in the attached coding session.',
            turnRelation: 'new_request',
            resolution: 'ready',
            missingFields: [],
            entities: {
              codingRemoteExecRequested: true,
              profileId: 'Daytona',
            },
          },
        }),
      },
    });

    expect(initial.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          approvalSummaries: [
            {
              id: 'approval-remote-1',
              toolName: 'code_remote_exec',
            },
          ],
        },
      },
    });

    const resumed = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-remote-resume',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: '',
        metadata: buildApprovalOutcomeContinuationMetadata({
          approvalId: 'approval-remote-1',
          decision: 'approved',
          resultMessage: 'Approved and executed.',
        }),
        timestamp: Date.now(),
      },
    });

    expect(getApprovalResult).toHaveBeenCalledWith('approval-remote-1');
    expect(resumed.content).toBe('Remote sandbox retry stayed pinned to the Daytona profile.');
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('answers tool-report questions only after the gateway classifies the turn as general assistant', async () => {
    const llmChat = vi.fn(async (_messages, options) => {
      const firstTool = options?.tools?.[0]?.name;
      if (firstTool === 'route_intent') {
        return {
          content: JSON.stringify({
            route: 'general_assistant',
            confidence: 'high',
            operation: 'unknown',
            summary: 'General assistant question.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      throw new Error(`Unexpected llmChat tool ${firstTool}`);
    });
    const listJobs = vi.fn(async () => [{
      toolName: 'browser_read',
      status: 'succeeded',
      argsRedacted: { url: 'https://example.com' },
      completedAt: Date.now(),
    }]);

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [],
      llmChat,
      callTool: vi.fn(),
      listJobs,
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-tool-report',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'What tools did you use?',
        timestamp: Date.now(),
      },
    });

    expect(result.content).toContain('browser_read');
    expect(result.metadata).toMatchObject({
      intentGateway: {
        route: 'general_assistant',
      },
    });
    expect(listJobs).toHaveBeenCalledWith('owner', undefined, 50);
    expect(llmChat).toHaveBeenCalledTimes(1);
  });

  it('inspects saved automations through the canonical automation catalog in brokered sessions', async () => {
    const llmChat = vi.fn(async (_messages, options) => {
      const firstTool = options?.tools?.[0]?.name;
      if (firstTool === 'route_intent') {
        return {
          content: JSON.stringify({
            route: 'automation_control',
            confidence: 'high',
            operation: 'inspect',
            summary: 'Inspect an existing automation.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      if (firstTool === 'resolve_automation_name') {
        return {
          content: JSON.stringify({
            automationName: 'Browser Read Smoke',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      throw new Error(`Unexpected llmChat tool ${firstTool}`);
    });

    const callTool = vi.fn(async (request: { toolName: string }) => {
      if (request.toolName === 'automation_list') {
        return {
          success: true,
          status: 'succeeded',
          jobId: 'job-automation-list',
          message: 'Listed automations.',
          output: {
            count: 1,
            automations: [{
              id: 'browser-read-smoke',
              name: 'Browser Read Smoke',
              kind: 'workflow',
              enabled: true,
              workflow: {
                id: 'browser-read-smoke',
                name: 'Browser Read Smoke',
                enabled: true,
                mode: 'sequential',
                description: 'Reads example.com.',
                steps: [{ id: 'step-1', toolName: 'browser_navigate' }],
              },
            }],
          },
        };
      }
      throw new Error(`Unexpected tool ${request.toolName}`);
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [],
      llmChat,
      callTool,
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-1',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Show me the automation Browser Read Smoke.',
        timestamp: Date.now(),
      },
    });

    expect(result.content).toContain('Browser Read Smoke (workflow)');
    expect(result.content).toContain('Steps:');
    expect(result.metadata).toMatchObject({
      intentGateway: {
        route: 'automation_control',
        operation: 'inspect',
        entities: {
          automationName: 'Browser Read Smoke',
        },
      },
    });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'automation_list',
    }));
  });

  it('runs saved automations through automation_run in brokered sessions', async () => {
    const llmChat = vi.fn(async () => ({
      content: JSON.stringify({
        route: 'automation_control',
        confidence: 'high',
        operation: 'run',
        summary: 'Run an existing automation.',
        automationName: 'Browser Read Smoke',
      }),
      model: 'test-model',
      finishReason: 'stop',
    } satisfies ChatResponse));

    const callTool = vi.fn(async (request: { toolName: string; args?: Record<string, unknown> }) => {
      if (request.toolName === 'automation_list') {
        return {
          success: true,
          status: 'succeeded',
          jobId: 'job-automation-list',
          message: 'Listed automations.',
          output: {
            count: 1,
            automations: [{
              id: 'browser-read-smoke',
              name: 'Browser Read Smoke',
              kind: 'workflow',
              enabled: true,
              workflow: {
                id: 'browser-read-smoke',
                name: 'Browser Read Smoke',
                enabled: true,
                mode: 'sequential',
                steps: [{ id: 'step-1', toolName: 'browser_navigate' }],
              },
            }],
          },
        };
      }
      if (request.toolName === 'automation_run') {
        expect(request.args).toEqual({ automationId: 'browser-read-smoke' });
        return {
          success: true,
          status: 'succeeded',
          jobId: 'job-automation-run',
          message: "Ran 'Browser Read Smoke'.",
          output: {
            success: true,
            message: "Ran 'Browser Read Smoke'.",
          },
        };
      }
      throw new Error(`Unexpected tool ${request.toolName}`);
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [],
      llmChat,
      callTool,
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-2',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Run Browser Read Smoke now.',
        timestamp: Date.now(),
      },
    });

    expect(result.content).toContain("Ran 'Browser Read Smoke'.");
    expect(callTool.mock.calls.map((call) => call[0]?.toolName)).toEqual([
      'automation_list',
      'automation_run',
    ]);
  });

  it('normalizes local Second Brain calendar mutations in brokered sessions', async () => {
    const referenceTime = new Date(2026, 3, 5, 0, 20, 0, 0).getTime();
    const expectedStart = new Date(2026, 3, 6, 12, 0, 0, 0).getTime();
    const expectedEnd = new Date(2026, 3, 6, 13, 0, 0, 0).getTime();
    const llmChat = vi.fn(async (messages, options) => {
      const firstTool = options?.tools?.[0]?.name;
      if (firstTool === 'route_intent') {
        return {
          content: JSON.stringify({
            route: 'personal_assistant_task',
            confidence: 'high',
            operation: 'create',
            summary: 'Create a local calendar event.',
            personalItemType: 'calendar',
            calendarTarget: 'local',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === 'tool') {
        return {
          content: 'Saved the event in the local calendar.',
          model: 'test-model',
          finishReason: 'stop',
          toolCalls: [],
          providerLocality: 'external',
          providerName: 'anthropic',
        } as ChatResponse;
      }
      return {
        content: '',
        model: 'test-model',
        finishReason: 'tool_calls',
        toolCalls: [{
          id: 'tool-calendar-local',
          name: 'second_brain_calendar_upsert',
          arguments: JSON.stringify({
            title: "Doctor's Appointment",
            startsAt: expectedStart,
            endsAt: expectedStart,
            location: "Narangba doctor's surgery",
          }),
        }],
        providerLocality: 'external',
        providerName: 'anthropic',
      } as ChatResponse;
    });

    const callTool = vi.fn(async (request: { toolName: string; args: Record<string, unknown> }) => {
      expect(request.toolName).toBe('second_brain_calendar_upsert');
      expect(request.args).toMatchObject({
        title: "Doctor's Appointment",
        startsAt: expectedStart,
        endsAt: expectedEnd,
        location: "Narangba doctor's surgery",
      });
      return {
        success: true,
        status: 'succeeded',
        jobId: 'job-calendar-local',
        message: 'Saved event.',
        output: {
          event: {
            startsAt: expectedStart,
            endsAt: expectedEnd,
          },
        },
      };
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [{
        name: 'second_brain_calendar_upsert',
        description: 'Create or update a local calendar entry.',
        parameters: { type: 'object', properties: {} },
        risk: 'medium',
      }],
      llmChat,
      callTool,
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-local-calendar',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: "Add a calendar entry for tomorrow at 12 pm for a doctor's appointment at Narangba doctor's surgery.",
        timestamp: referenceTime,
      },
    });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('Saved the event in the local calendar.');
  });

  it('blocks provider calendar mutations when the routed turn is local Second Brain work', async () => {
    const llmChat = vi.fn(async (messages, options) => {
      const firstTool = options?.tools?.[0]?.name;
      if (firstTool === 'route_intent') {
        return {
          content: JSON.stringify({
            route: 'personal_assistant_task',
            confidence: 'high',
            operation: 'create',
            summary: 'Create a local calendar event.',
            personalItemType: 'calendar',
            calendarTarget: 'local',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      const systemPrompt = messages.find((entry) => entry.role === 'system')?.content ?? '';
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === 'tool') {
        expect(lastMessage.content).toContain('local Second Brain calendar');
        return {
          content: 'Stayed on the local calendar path.',
          model: 'test-model',
          finishReason: 'stop',
          toolCalls: [],
          providerLocality: 'external',
          providerName: 'anthropic',
        } as ChatResponse;
      }
      expect(systemPrompt).toContain('[routed-intent]');
      expect(systemPrompt).toContain('route: personal_assistant_task');
      expect(systemPrompt).toContain('Do not ask the user to choose Google or Microsoft for this turn.');
      return {
        content: '',
        model: 'test-model',
        finishReason: 'tool_calls',
        toolCalls: [{
          id: 'tool-gws-calendar',
          name: 'gws',
          arguments: JSON.stringify({
            method: 'calendar events create',
          }),
        }],
        providerLocality: 'external',
        providerName: 'anthropic',
      } as ChatResponse;
    });

    const callTool = vi.fn();
    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [{
        name: 'gws',
        description: 'Google Workspace integration.',
        parameters: { type: 'object', properties: {} },
        risk: 'high',
      }],
      llmChat,
      callTool,
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-gws-denied',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: "Add a calendar entry for tomorrow at 12 pm for a doctor's appointment at Narangba doctor's surgery.",
        timestamp: new Date(2026, 3, 5, 0, 20, 0, 0).getTime(),
      },
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(result.content).toBe('Stayed on the local calendar path.');
  });

  it('reuses pre-routed local calendar intent in brokered sessions so degraded worker classification cannot drift to provider calendar writes', async () => {
    const llmChat = vi.fn(async (messages, options) => {
      const firstTool = options?.tools?.[0]?.name;
      if (firstTool === 'route_intent') {
        return {
          content: JSON.stringify({
            route: 'unknown',
            confidence: 'low',
            operation: 'unknown',
            summary: 'Worker classifier degraded.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      const systemPrompt = messages.find((entry) => entry.role === 'system')?.content ?? '';
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === 'tool') {
        expect(lastMessage.content).toContain('local Second Brain calendar');
        return {
          content: 'Stayed on the local calendar path.',
          model: 'test-model',
          finishReason: 'stop',
          toolCalls: [],
          providerLocality: 'external',
          providerName: 'anthropic',
        } as ChatResponse;
      }
      expect(systemPrompt).toContain('[routed-intent]');
      expect(systemPrompt).toContain('route: personal_assistant_task');
      return {
        content: '',
        model: 'test-model',
        finishReason: 'tool_calls',
        toolCalls: [{
          id: 'tool-m365-calendar',
          name: 'm365',
          arguments: JSON.stringify({
            service: 'calendar',
            resource: 'me/events',
            method: 'create',
            json: {
              subject: 'Extended Toilet Break',
              start: { dateTime: '2026-04-07T13:00:00', timeZone: 'Pacific/Auckland' },
              end: { dateTime: '2026-04-07T13:30:00', timeZone: 'Pacific/Auckland' },
            },
          }),
        }],
        providerLocality: 'external',
        providerName: 'anthropic',
      } as ChatResponse;
    });

    const callTool = vi.fn();
    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [{
        name: 'm365',
        description: 'Microsoft 365 integration.',
        parameters: { type: 'object', properties: {} },
        risk: 'high',
      }],
      llmChat,
      callTool,
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-pre-routed-local-calendar',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Okay let’s add another appointment tomorrow at 1:00 p.m.',
        timestamp: new Date(2026, 3, 6, 10, 0, 0, 0).getTime(),
        metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
          mode: 'primary',
          available: true,
          model: 'gateway-model',
          latencyMs: 12,
          decision: {
            route: 'personal_assistant_task',
            confidence: 'high',
            operation: 'create',
            summary: 'Create a local calendar event.',
            turnRelation: 'new_request',
            resolution: 'ready',
            missingFields: [],
            entities: {
              personalItemType: 'calendar',
              calendarTarget: 'local',
            },
          },
        }),
      },
    });

    expect(llmChat.mock.calls.some((call) => call[1]?.tools?.[0]?.name === 'route_intent')).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
    expect(result.content).toBe('Stayed on the local calendar path.');
  });

  it('reuses unavailable pre-routed intent metadata in brokered sessions so worker reclassification cannot drift into coding-session control', async () => {
    const llmChat = vi.fn(async (messages, options) => {
      const firstTool = options?.tools?.[0]?.name;
      if (firstTool === 'route_intent') {
        return {
          content: JSON.stringify({
            route: 'coding_session_control',
            confidence: 'low',
            operation: 'navigate',
            summary: 'List coding workspaces.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      const systemPrompt = messages.find((entry) => entry.role === 'system')?.content ?? '';
      expect(systemPrompt).toContain('[routed-intent]');
      expect(systemPrompt).toContain('route: unknown');
      return {
        content: 'Preserved the original unavailable route without drifting into workspace listing.',
        model: 'test-model',
        finishReason: 'stop',
        toolCalls: [],
        providerLocality: 'external',
        providerName: 'anthropic',
      } as ChatResponse;
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [],
      llmChat,
      callTool: vi.fn(),
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-pre-routed-unavailable',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'In this workspace, write a short report to C:\\Sensitive\\round2-approval.txt and continue once approval is granted.',
        timestamp: Date.now(),
        metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
          mode: 'primary',
          available: false,
          model: 'unknown',
          latencyMs: 3,
          decision: {
            route: 'unknown',
            confidence: 'low',
            operation: 'unknown',
            summary: 'Routing provider unavailable.',
            turnRelation: 'new_request',
            resolution: 'ready',
            missingFields: [],
            entities: {},
          },
        }),
      },
    });

    expect(llmChat.mock.calls.some((call) => call[1]?.tools?.[0]?.name === 'route_intent')).toBe(false);
    expect(result.content).toBe('Preserved the original unavailable route without drifting into workspace listing.');
  });

  it('suspends and resumes complex planning tasks through brokered approval metadata', async () => {
    const llmChat = vi.fn(async (messages) => {
      const lastMessage = messages[messages.length - 1];
      const lastContent = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
      if (lastContent.includes('Please provide a JSON representation of an execution DAG')) {
        return {
          content: JSON.stringify({
            nodes: {
              'search-repo': {
                id: 'search-repo',
                description: 'Search the repo for brokered worker references.',
                dependencies: [],
                actionType: 'tool_call',
                target: 'fs_search',
                inputPrompt: JSON.stringify({ path: '.', pattern: 'brokered worker' }),
              },
            },
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      if (lastContent.includes('Did the execution result semantically satisfy the sub-task instruction?')) {
        return {
          content: JSON.stringify({ success: true, reason: 'The repo search completed.' }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      throw new Error(`Unexpected llmChat prompt: ${lastContent.slice(0, 80)}`);
    });

    const callTool = vi.fn(async (request: Record<string, unknown>) => ({
      success: false,
      status: 'pending_approval',
      jobId: 'job-plan-search-1',
      approvalId: 'approval-plan-search-1',
      message: 'fs_search is awaiting approval.',
      approvalSummary: {
        toolName: 'fs_search',
        argsPreview: '{"path":".","pattern":"brokered worker"}',
        actionLabel: 'Search the repo for brokered worker',
      },
    }));

    const getApprovalResult = vi.fn(async (approvalId: string) => {
      expect(approvalId).toBe('approval-plan-search-1');
      return {
        success: true,
        status: 'approved',
        message: 'Search completed.',
        output: {
          matches: [
            { path: 'src/worker/worker-session.ts' },
            { path: 'src/supervisor/worker-manager.ts' },
          ],
        },
      };
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [{
        name: 'fs_search',
        description: 'Search files for a pattern.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            pattern: { type: 'string' },
          },
          required: ['path', 'pattern'],
        },
        risk: 'read_only',
      }],
      listLoadedTools: vi.fn(async () => []),
      llmChat,
      callTool,
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult,
    } as never);

    const initial = await session.handleMessage({
      ...baseParams,
      executionProfile: {
        id: 'managed_cloud_tool',
        providerName: 'ollama-cloud',
        providerType: 'ollama_cloud',
        providerModel: 'gpt-oss:120b',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'tool_loop',
        expectedContextPressure: 'high',
        contextBudget: 80_000,
        toolContextMode: 'standard',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['ollama-cloud'],
        reason: 'test profile',
      },
      message: {
        id: 'msg-plan-start',
        userId: 'owner',
        surfaceId: 'surface-1',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Plan how to search the repo for brokered worker references.',
        timestamp: Date.now(),
        metadata: {
          ...buildComplexPlanningMetadata(),
          codeContext: {
            workspaceRoot: '/repo',
            sessionId: 'code-1',
          },
        },
      },
    });

    expect(initial.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          approvalSummaries: [
            {
              id: 'approval-plan-search-1',
              toolName: 'fs_search',
            },
          ],
        },
      },
    });
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'fs_search',
      userId: 'owner',
      surfaceId: 'surface-1',
      principalId: 'owner',
      principalRole: 'owner',
      requestId: 'msg-plan-start',
      contentTrustLevel: 'trusted',
      derivedFromTaintedContent: false,
      codeContext: {
        workspaceRoot: '/repo',
        sessionId: 'code-1',
      },
    }));

    const resumed = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-plan-resume',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: '',
        metadata: buildApprovalOutcomeContinuationMetadata({
          approvalId: 'approval-plan-search-1',
          decision: 'approved',
          resultMessage: 'Search completed.',
        }),
        timestamp: Date.now(),
      },
    });

    expect(getApprovalResult).toHaveBeenCalledWith('approval-plan-search-1');
    expect(resumed.content).toContain('I generated and executed a DAG plan');
    expect(resumed.content).toContain('Plan summary: 1 node, 1 completed.');
    expect(resumed.content).toContain('Completed nodes: search-repo.');
    expect(resumed.content).not.toContain('```json');
    expect(resumed.metadata).toMatchObject({
      workerExecution: {
        lifecycle: 'completed',
        source: 'planner',
        completionReason: 'planner_completed',
        responseQuality: 'final',
      },
      plannerExecution: {
        status: 'completed',
        totalNodes: 1,
        completedNodeIds: ['search-repo'],
      },
      responseSource: {
        locality: 'external',
        providerName: 'ollama_cloud',
        providerProfileName: 'ollama-cloud',
        providerTier: 'managed_cloud',
        model: 'gpt-oss:120b',
      },
    });
  });

  it('executes explicit complex-planning smoke requests through planner file writes including summary.md', async () => {
    const llmChat = vi.fn(async (messages) => {
      const lastMessage = messages[messages.length - 1];
      const lastContent = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
      if (lastContent.includes('Please provide a JSON representation of an execution DAG')) {
        return {
          content: JSON.stringify({
            nodes: {
              mkdir: {
                id: 'mkdir',
                description: 'Create the manual DAG smoke directory.',
                dependencies: [],
                actionType: 'tool_call',
                target: 'fs_mkdir',
                inputPrompt: JSON.stringify({ path: 'tmp/manual-dag-smoke' }),
              },
              risks: {
                id: 'risks',
                description: 'Write risks.txt.',
                dependencies: ['mkdir'],
                actionType: 'tool_call',
                target: 'fs_write',
                inputPrompt: JSON.stringify({
                  path: 'tmp/manual-dag-smoke/risks.txt',
                  content: '- Planner drift can bypass intended approval checkpoints.\n- Remote output can taint downstream file writes.\n- Long multi-step runs can hide partial failure behind a success summary.\n',
                }),
              },
              controls: {
                id: 'controls',
                description: 'Write controls.txt.',
                dependencies: ['risks'],
                actionType: 'tool_call',
                target: 'fs_write',
                inputPrompt: JSON.stringify({
                  path: 'tmp/manual-dag-smoke/controls.txt',
                  content: '- Supervisor-owned tool admission keeps writes brokered.\n- Trust-state propagation marks tainted downstream actions.\n- Approval mediation can pause and resume the DAG safely.\n',
                }),
              },
              gaps: {
                id: 'gaps',
                description: 'Write gaps.txt.',
                dependencies: ['controls'],
                actionType: 'tool_call',
                target: 'fs_write',
                inputPrompt: JSON.stringify({
                  path: 'tmp/manual-dag-smoke/gaps.txt',
                  content: '- Live UI progress is still too coarse during long planner runs.\n- Planner-path regression coverage must stay aligned with routing fallbacks.\n- End-to-end smoke coverage should include managed-cloud provider lanes.\n',
                }),
              },
              summary: {
                id: 'summary',
                description: 'Write summary.md.',
                dependencies: ['gaps'],
                actionType: 'tool_call',
                target: 'fs_write',
                inputPrompt: JSON.stringify({
                  path: 'tmp/manual-dag-smoke/summary.md',
                  content: '| Category | Notes |\n| --- | --- |\n| Risks | Planner drift, taint propagation, misleading completion copy. |\n| Controls | Brokered tool admission, trust-state tracking, approval mediation. |\n| Gaps | UI progress detail, regression coverage, managed-cloud validation. |\n\nBrokered agent isolation is directionally sound, but production readiness still depends on keeping planner routing explicit and improving run visibility during longer brokered executions.\n',
                }),
              },
            },
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      if (lastContent.includes('Did the execution result semantically satisfy the sub-task instruction?')) {
        return {
          content: JSON.stringify({ success: true, reason: 'The requested file operation completed.' }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      throw new Error(`Unexpected llmChat prompt: ${lastContent.slice(0, 120)}`);
    });

    const callRequests: Array<Record<string, unknown>> = [];
    const callTool = vi.fn(async (request: Record<string, unknown>) => {
      callRequests.push(request);
      if (request.toolName === 'fs_mkdir') {
        return {
          success: true,
          status: 'succeeded',
          jobId: 'job-mkdir-1',
          message: 'Created directory.',
          output: { path: 'tmp/manual-dag-smoke' },
        };
      }
      if (request.toolName === 'fs_write') {
        return {
          success: true,
          status: 'succeeded',
          jobId: `job-write-${callRequests.length}`,
          message: 'Wrote file.',
          output: { path: request.args && typeof request.args === 'object' ? (request.args as { path?: string }).path : undefined },
        };
      }
      throw new Error(`Unexpected tool ${(request.toolName as string) || 'unknown'}`);
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [
        {
          name: 'fs_mkdir',
          description: 'Create a directory.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          risk: 'mutating',
        },
        {
          name: 'fs_write',
          description: 'Write a file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
          risk: 'mutating',
        },
      ],
      listLoadedTools: vi.fn(async () => []),
      llmChat,
      callTool,
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-plan-manual-dag-smoke',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Use your complex-planning path for this request. In tmp/manual-dag-smoke, create risks.txt, controls.txt, and gaps.txt with 3 short bullet points each about brokered agent isolation. Then create summary.md that turns them into a markdown table plus a final recommendation paragraph. When you finish, include the DAG plan JSON you executed.',
        timestamp: Date.now(),
        metadata: buildComplexPlanningMetadata(),
      },
    });

    const writtenPaths = callRequests
      .map((request) => request.args)
      .filter((args): args is { path?: string } => !!args && typeof args === 'object')
      .map((args) => args.path)
      .filter((path): path is string => typeof path === 'string');

    expect(result.content).toContain('I generated and executed a DAG plan');
    expect(result.content).toContain('Plan summary: 5 nodes, 5 completed.');
    expect(result.content).toContain('Completed nodes: mkdir, risks, controls, gaps, summary.');
    expect(result.content).not.toContain('```json');
    expect(result.metadata).toMatchObject({
      plannerExecution: {
        status: 'completed',
        totalNodes: 5,
        completedNodeIds: ['mkdir', 'risks', 'controls', 'gaps', 'summary'],
      },
    });
    expect(callRequests).toHaveLength(5);
    expect(callRequests[0]).toMatchObject({
      toolName: 'fs_mkdir',
      requestId: 'msg-plan-manual-dag-smoke',
      contentTrustLevel: 'trusted',
      derivedFromTaintedContent: false,
    });
    expect(writtenPaths).toEqual([
      'tmp/manual-dag-smoke',
      'tmp/manual-dag-smoke/risks.txt',
      'tmp/manual-dag-smoke/controls.txt',
      'tmp/manual-dag-smoke/gaps.txt',
      'tmp/manual-dag-smoke/summary.md',
    ]);
  });

  it('constrains the brokered planner prompt to broker-safe action types', async () => {
    let plannerPrompt = '';
    const llmChat = vi.fn(async (messages) => {
      const lastMessage = messages[messages.length - 1];
      const lastContent = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
      if (lastContent.includes('Please provide a JSON representation of an execution DAG')) {
        plannerPrompt = lastContent;
        return {
          content: JSON.stringify({
            nodes: {
              mkdir: {
                id: 'mkdir',
                description: 'Create the target directory.',
                dependencies: [],
                actionType: 'tool_call',
                target: 'fs_mkdir',
                inputPrompt: JSON.stringify({ path: 'tmp/manual-dag-smoke' }),
              },
            },
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      if (lastContent.includes('Did the execution result semantically satisfy the sub-task instruction?')) {
        return {
          content: JSON.stringify({ success: true, reason: 'The requested file operation completed.' }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      throw new Error(`Unexpected llmChat prompt: ${lastContent.slice(0, 120)}`);
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [
        {
          name: 'fs_mkdir',
          description: 'Create a directory.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          risk: 'mutating',
        },
      ],
      listLoadedTools: vi.fn(async () => []),
      llmChat,
      callTool: vi.fn(async () => ({
        success: true,
        status: 'succeeded',
        jobId: 'job-mkdir-safe',
        message: 'Created directory.',
        output: { path: 'tmp/manual-dag-smoke' },
      })),
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-plan-broker-safe-prompt',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Use your complex-planning path for this request. In tmp/manual-dag-smoke, create a directory.',
        timestamp: Date.now(),
        metadata: buildComplexPlanningMetadata(),
      },
    });

    expect(plannerPrompt).toContain('"tool_call" | "execute_code"');
    expect(plannerPrompt).not.toContain('"skill_delegation"');
    expect(plannerPrompt).not.toContain('"delegate_task"');
    expect(plannerPrompt).toContain('Allowed brokered tool names in this runtime: fs_mkdir.');
    expect(plannerPrompt).toContain('Do not invent tool aliases such as "fs_readFile", "read_file", or "fs_writeFile".');
    expect(plannerPrompt).toContain('Do not emit unsupported action types');
  });

  it('normalizes common planner tool aliases before broker execution', async () => {
    const llmChat = vi.fn(async (messages) => {
      const lastMessage = messages[messages.length - 1];
      const lastContent = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
      if (lastContent.includes('Please provide a JSON representation of an execution DAG')) {
        return {
          content: JSON.stringify({
            nodes: {
              read: {
                id: 'read',
                description: 'Read the source file.',
                dependencies: [],
                actionType: 'tool_call',
                target: 'fs_readFile',
                inputPrompt: JSON.stringify({ path: 'src/chat-agent.ts' }),
              },
              write: {
                id: 'write',
                description: 'Write the summary.',
                dependencies: ['read'],
                actionType: 'tool_call',
                target: 'write_file',
                inputPrompt: JSON.stringify({ path: 'summary.md', content: 'done' }),
              },
            },
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      if (lastContent.includes('Did the execution result semantically satisfy the sub-task instruction?')) {
        return {
          content: JSON.stringify({ success: true, reason: 'The node completed.' }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      throw new Error(`Unexpected llmChat prompt: ${lastContent.slice(0, 120)}`);
    });

    const callRequests: Array<Record<string, unknown>> = [];
    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [
        {
          name: 'fs_read',
          description: 'Read a file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          risk: 'read_only',
        },
        {
          name: 'fs_write',
          description: 'Write a file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
          risk: 'mutating',
        },
      ],
      listLoadedTools: vi.fn(async () => []),
      llmChat,
      callTool: vi.fn(async (request: Record<string, unknown>) => {
        callRequests.push(request);
        return {
          success: true,
          status: 'succeeded',
          jobId: `job-${String(request.toolName)}`,
          message: 'Completed.',
          output: {},
        };
      }),
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-plan-alias-normalization',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Use your complex-planning path for this request. Read a file and write a summary.',
        timestamp: Date.now(),
        metadata: buildComplexPlanningMetadata(),
      },
    });

    expect(callRequests).toHaveLength(2);
    expect(callRequests[0]).toMatchObject({
      toolName: 'fs_read',
      args: { path: 'src/chat-agent.ts' },
    });
    expect(callRequests[1]).toMatchObject({
      toolName: 'fs_write',
      args: { path: 'summary.md', content: 'done' },
    });
  });

  it('extracts bounded execute_code commands from JSON command payloads', async () => {
    const llmChat = vi.fn(async (messages) => {
      const lastMessage = messages[messages.length - 1];
      const lastContent = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
      if (lastContent.includes('Please provide a JSON representation of an execution DAG')) {
        return {
          content: JSON.stringify({
            nodes: {
              run: {
                id: 'run',
                description: 'Run a bounded command.',
                dependencies: [],
                actionType: 'execute_code',
                target: 'node',
                inputPrompt: JSON.stringify({ command: 'pwd' }),
              },
            },
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      if (lastContent.includes('Did the execution result semantically satisfy the sub-task instruction?')) {
        return {
          content: JSON.stringify({ success: true, reason: 'The node completed.' }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      throw new Error(`Unexpected llmChat prompt: ${lastContent.slice(0, 120)}`);
    });

    const callTool = vi.fn(async () => ({
      success: true,
      status: 'succeeded',
      jobId: 'job-code-1',
      message: 'Ran command.',
      output: { stdout: '/repo' },
    }));
    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [],
      listLoadedTools: vi.fn(async () => []),
      llmChat,
      callTool,
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-plan-command-normalization',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Use your complex-planning path for this request. Run pwd.',
        timestamp: Date.now(),
        metadata: buildComplexPlanningMetadata(),
      },
    });

    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'code_remote_exec',
      args: { command: 'pwd' },
    }));
  });

  it('normalizes simple mkdir execute_code commands into fs_mkdir tool calls', async () => {
    const llmChat = vi.fn(async (messages) => {
      const lastMessage = messages[messages.length - 1];
      const lastContent = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
      if (lastContent.includes('Please provide a JSON representation of an execution DAG')) {
        return {
          content: JSON.stringify({
            nodes: {
              mkdir: {
                id: 'mkdir',
                description: 'Create the tmp directory.',
                dependencies: [],
                actionType: 'execute_code',
                target: 'node',
                inputPrompt: JSON.stringify({ command: 'mkdir -p tmp' }),
              },
            },
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      if (lastContent.includes('Did the execution result semantically satisfy the sub-task instruction?')) {
        return {
          content: JSON.stringify({ success: true, reason: 'The node completed.' }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      throw new Error(`Unexpected llmChat prompt: ${lastContent.slice(0, 120)}`);
    });

    const callTool = vi.fn(async () => ({
      success: true,
      status: 'succeeded',
      jobId: 'job-mkdir-1',
      message: 'Created directory.',
      output: { path: 'tmp' },
    }));
    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [{
        name: 'fs_mkdir',
        description: 'Create a directory.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        risk: 'mutating',
      }],
      listLoadedTools: vi.fn(async () => []),
      llmChat,
      callTool,
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-plan-mkdir-normalization',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Use your complex-planning path for this request. Create a tmp directory.',
        timestamp: Date.now(),
        metadata: buildComplexPlanningMetadata(),
      },
    });

    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'fs_mkdir',
      args: { path: 'tmp' },
    }));
    expect(callTool).not.toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'code_remote_exec',
    }));
  });

  it('propagates taint from earlier planner nodes into later node tool requests', async () => {
    const llmChat = vi.fn(async (messages) => {
      const lastMessage = messages[messages.length - 1];
      const lastContent = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
      if (lastContent.includes('Please provide a JSON representation of an execution DAG')) {
        return {
          content: JSON.stringify({
            nodes: {
              fetch: {
                id: 'fetch',
                description: 'Fetch remote data.',
                dependencies: [],
                actionType: 'tool_call',
                target: 'web_fetch',
                inputPrompt: JSON.stringify({ url: 'https://example.com/report' }),
              },
              persist: {
                id: 'persist',
                description: 'Persist a summary.',
                dependencies: ['fetch'],
                actionType: 'tool_call',
                target: 'fs_write',
                inputPrompt: JSON.stringify({ path: 'summary.txt', content: 'done' }),
              },
            },
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      if (lastContent.includes('Did the execution result semantically satisfy the sub-task instruction?')) {
        return {
          content: JSON.stringify({ success: true, reason: 'The node completed.' }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      throw new Error(`Unexpected llmChat prompt: ${lastContent.slice(0, 80)}`);
    });

    const callRequests: Array<Record<string, unknown>> = [];
    const callTool = vi.fn(async (request: Record<string, unknown>) => {
      callRequests.push(request);
      if (request.toolName === 'web_fetch') {
        return {
          success: true,
          status: 'succeeded',
          jobId: 'job-fetch-1',
          message: 'Fetched remote data.',
          output: { body: 'report' },
          trustLevel: 'low_trust',
          taintReasons: ['remote_content'],
        };
      }
      if (request.toolName === 'fs_write') {
        return {
          success: true,
          status: 'succeeded',
          jobId: 'job-write-1',
          message: 'Saved summary.',
          output: { path: 'summary.txt' },
        };
      }
      throw new Error(`Unexpected tool ${request.toolName}`);
    });

    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [
        {
          name: 'web_fetch',
          description: 'Fetch a web page.',
          parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
          risk: 'read_only',
        },
        {
          name: 'fs_write',
          description: 'Write a file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
          risk: 'mutating',
        },
      ],
      listLoadedTools: vi.fn(async () => []),
      llmChat,
      callTool,
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-plan-taint',
        userId: 'owner',
        surfaceId: 'surface-2',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Plan a remote fetch and then save the summary.',
        timestamp: Date.now(),
        metadata: {
          ...buildComplexPlanningMetadata(),
          codeContext: {
            workspaceRoot: '/repo',
            sessionId: 'code-2',
          },
        },
      },
    });

    expect(callRequests).toHaveLength(2);
    expect(callRequests[0]).toMatchObject({
      toolName: 'web_fetch',
      requestId: 'msg-plan-taint',
      principalId: 'owner',
      contentTrustLevel: 'trusted',
      derivedFromTaintedContent: false,
    });
    expect(callRequests[1]).toMatchObject({
      toolName: 'fs_write',
      requestId: 'msg-plan-taint',
      surfaceId: 'surface-2',
      principalId: 'owner',
      contentTrustLevel: 'low_trust',
      derivedFromTaintedContent: true,
      taintReasons: ['remote_content'],
      codeContext: {
        workspaceRoot: '/repo',
        sessionId: 'code-2',
      },
    });
  });

  it('fails closed when a complex planner DAG asks for unsupported delegated actions', async () => {
    const llmChat = vi.fn(async (messages) => {
      const lastMessage = messages[messages.length - 1];
      const lastContent = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
      if (lastContent.includes('Please provide a JSON representation of an execution DAG')) {
        return {
          content: JSON.stringify({
            nodes: {
              delegate: {
                id: 'delegate',
                description: 'Delegate the work to another agent.',
                dependencies: [],
                actionType: 'delegate_task',
                target: 'brokered-worker',
                inputPrompt: 'Handle the request in a new worker.',
              },
            },
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      }
      throw new Error(`Unexpected llmChat prompt: ${lastContent.slice(0, 80)}`);
    });

    const callTool = vi.fn();
    const session = new BrokeredWorkerSession({
      getAlwaysLoadedTools: () => [],
      llmChat,
      callTool,
      listJobs: vi.fn(async () => []),
      decideApproval: vi.fn(),
      getApprovalResult: vi.fn(),
    } as never);

    const result = await session.handleMessage({
      ...baseParams,
      message: {
        id: 'msg-plan-unsupported',
        userId: 'owner',
        principalId: 'owner',
        principalRole: 'owner',
        channel: 'web',
        content: 'Plan a delegated implementation approach.',
        timestamp: Date.now(),
        metadata: buildComplexPlanningMetadata(),
      },
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(result.content).toContain('could not execute it safely');
    expect(result.content).toContain('delegate_task');
    expect(result.content).toContain('Plan summary: 1 node, 1 pending.');
    expect(result.content).not.toContain('```json');
    expect(result.metadata).toMatchObject({
      workerExecution: {
        lifecycle: 'failed',
        source: 'planner',
        completionReason: 'unsupported_actions',
        responseQuality: 'final',
      },
      plannerExecution: {
        status: 'unsupported_actions',
        totalNodes: 1,
        unsupportedActions: ['delegate_task'],
      },
    });
  });
});
