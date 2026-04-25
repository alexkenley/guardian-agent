import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatOptions, ChatResponse } from '../llm/types.js';
import type { ToolExecutionRequest } from '../tools/types.js';
import type { IntentGatewayDecision, IntentGatewayRecord } from './intent/types.js';
import type { SelectedExecutionProfile } from './execution-profiles.js';
import {
  executeDirectReasoningToolCall,
  handleDirectReasoningMode,
  shouldHandleDirectReasoningMode,
} from './direct-reasoning-mode.js';
import { normalizeIntentGatewayDecision } from './intent/structured-recovery.js';

function decision(overrides: Partial<IntentGatewayDecision> = {}): IntentGatewayDecision {
  return {
    route: 'coding_task',
    confidence: 'high',
    operation: 'inspect',
    summary: 'Inspect repo implementation.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    resolvedContent: 'Inspect this repo and cite exact file paths and symbol names.',
    executionClass: 'repo_grounded',
    preferredTier: 'external',
    requiresRepoGrounding: true,
    requiresToolSynthesis: true,
    expectedContextPressure: 'high',
    preferredAnswerPath: 'chat_synthesis',
    entities: {},
    ...overrides,
  };
}

function gateway(overrides: Partial<IntentGatewayDecision> = {}): IntentGatewayRecord {
  return {
    mode: 'primary',
    available: true,
    model: 'test-gateway',
    latencyMs: 1,
    decision: decision(overrides),
  };
}

function profile(overrides: Partial<SelectedExecutionProfile> = {}): SelectedExecutionProfile {
  return {
    id: 'managed_cloud_direct',
    providerName: 'ollama-cloud-coding',
    providerType: 'ollama_cloud',
    providerModel: 'glm-5.1',
    providerLocality: 'external',
    providerTier: 'managed_cloud',
    requestedTier: 'external',
    preferredAnswerPath: 'chat_synthesis',
    expectedContextPressure: 'high',
    contextBudget: 16_000,
    toolContextMode: 'tight',
    maxAdditionalSections: 3,
    maxRuntimeNotices: 3,
    fallbackProviderOrder: ['ollama-cloud-coding'],
    reason: 'test',
    ...overrides,
  };
}

function chatResponse(overrides: Partial<ChatResponse>): ChatResponse {
  return {
    content: '',
    model: 'test-model',
    finishReason: 'stop',
    ...overrides,
  };
}

describe('direct reasoning mode', () => {
  it('only selects brokered direct reasoning for non-local read-only repo-grounded requests', () => {
    expect(shouldHandleDirectReasoningMode({
      gateway: gateway(),
      selectedExecutionProfile: profile(),
    })).toBe(true);

    expect(shouldHandleDirectReasoningMode({
      gateway: gateway(),
      selectedExecutionProfile: profile({ providerTier: 'local', providerLocality: 'local', providerName: 'ollama', providerType: 'ollama' }),
    })).toBe(false);

    expect(shouldHandleDirectReasoningMode({
      gateway: gateway(),
      selectedExecutionProfile: null,
    })).toBe(false);

    expect(shouldHandleDirectReasoningMode({
      gateway: gateway({ operation: 'update' }),
      selectedExecutionProfile: profile(),
    })).toBe(false);

    expect(shouldHandleDirectReasoningMode({
      gateway: gateway({
        operation: 'run',
        preferredAnswerPath: 'tool_loop',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
      }),
      selectedExecutionProfile: profile(),
    })).toBe(false);

    expect(shouldHandleDirectReasoningMode({
      gateway: gateway({ executionClass: 'security_analysis' }),
      selectedExecutionProfile: profile(),
    })).toBe(false);
  });

  it('does not select brokered direct reasoning when structured repo inspection plans require writes', () => {
    expect(shouldHandleDirectReasoningMode({
      gateway: gateway({
        route: 'coding_task',
        operation: 'inspect',
        executionClass: 'repo_grounded',
        requiresRepoGrounding: true,
        requiresToolSynthesis: false,
        preferredAnswerPath: 'chat_synthesis',
        plannedSteps: [
          { kind: 'search', summary: 'Search src/runtime for planned_steps.', required: true },
          {
            kind: 'write',
            summary: 'Write a grounded summary to tmp/manual-web/planned-steps-summary.txt.',
            expectedToolCategories: ['fs_write'],
            required: true,
            dependsOn: ['step_1'],
          },
        ],
      }),
      selectedExecutionProfile: profile(),
    })).toBe(false);
  });

  it('does not select brokered direct reasoning when synthesized repo plans require writes', () => {
    const sourceContent = 'Search src/runtime for planned_steps. Write a concise summary of what you find to tmp/orchestration-openrouter/planned-steps-summary.txt.';
    const normalized = normalizeIntentGatewayDecision({
      route: 'coding_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Search src/runtime for planned_steps and write a concise summary to tmp/orchestration-openrouter/planned-steps-summary.txt.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: false,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
    }, { sourceContent });

    expect(normalized.plannedSteps?.some((step) => step.kind === 'write')).toBe(true);
    expect(shouldHandleDirectReasoningMode({
      gateway: { ...gateway(), decision: normalized },
      selectedExecutionProfile: profile(),
    })).toBe(false);
  });

  it('runs an iterative read-only tool loop with trace and tool execution context', async () => {
    const messagesByCall: ChatMessage[][] = [];
    const optionsByCall: Array<ChatOptions | undefined> = [];
    const chat = vi.fn(async (messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      messagesByCall.push(messages);
      optionsByCall.push(options);
      if (messagesByCall.length === 1) {
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'call-1',
              name: 'fs_search',
              arguments: JSON.stringify({ query: 'IntentGateway', mode: 'content' }),
            },
          ],
        });
      }
      return chatResponse({
        content: 'The route classifier is in `src/runtime/intent-gateway.ts` via `IntentGateway`.',
      });
    });
    const executeTool = vi.fn(async (
      toolName: string,
      args: Record<string, unknown>,
      request: Partial<Omit<ToolExecutionRequest, 'toolName' | 'args'>>,
    ) => ({
      success: true,
      status: 'succeeded',
      message: 'ok',
      output: {
        query: args.query,
        matches: [
          {
            relativePath: 'src/runtime/intent-gateway.ts',
            matchType: 'content',
            snippet: 'export class IntentGateway',
          },
        ],
      },
      request,
      toolName,
    }));
    const traceEntries: Array<Record<string, unknown>> = [];
    const graphEvents: Array<Record<string, unknown>> = [];

    const result = await handleDirectReasoningMode({
      message: 'Which files define the IntentGateway route classifier?',
      gateway: gateway(),
      selectedExecutionProfile: profile(),
      workspaceRoot: 'S:/Development/GuardianAgent',
      traceContext: {
        requestId: 'req-1',
        messageId: 'msg-1',
        userId: 'user-1',
        channel: 'web',
        agentId: 'guardian',
        codeSessionId: 'code-1',
      },
      toolRequest: {
        origin: 'assistant',
        requestId: 'req-1',
        agentId: 'guardian',
        userId: 'user-1',
        surfaceId: 'surface-1',
        principalId: 'principal-1',
        principalRole: 'owner',
        channel: 'web',
        codeContext: { workspaceRoot: 'S:/Development/GuardianAgent', sessionId: 'code-1' },
        toolContextMode: 'tight',
        activeSkills: ['skill-1'],
      },
    }, {
      chat,
      executeTool,
      trace: {
        record: (entry) => traceEntries.push(entry as unknown as Record<string, unknown>),
      },
      graphEvents: {
        emit: (event) => graphEvents.push(event as unknown as Record<string, unknown>),
      },
    });

    expect(result.content).toContain('src/runtime/intent-gateway.ts');
    expect(result.metadata?.directReasoningMode).toBe('brokered_readonly');
    expect(result.metadata?.directReasoningStats).toMatchObject({
      toolCallCount: 1,
      evidenceCount: 1,
      synthesized: true,
    });
    expect(chat).toHaveBeenCalledTimes(3);
    expect(optionsByCall[2]?.tools).toEqual([]);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0]?.[0]).toBe('fs_search');
    expect(executeTool.mock.calls[0]?.[2]).toMatchObject({
      requestId: 'req-1',
      userId: 'user-1',
      surfaceId: 'surface-1',
      principalId: 'principal-1',
      channel: 'web',
      codeContext: { workspaceRoot: 'S:/Development/GuardianAgent', sessionId: 'code-1' },
      toolContextMode: 'tight',
      activeSkills: ['skill-1'],
    });
    expect(messagesByCall[1]?.some((message) => (
      message.role === 'tool'
      && message.content.includes('Search results for "IntentGateway"')
    ))).toBe(true);
    expect(traceEntries.map((entry) => entry.stage)).toEqual([
      'direct_reasoning_started',
      'direct_reasoning_llm_call_started',
      'direct_reasoning_llm_call_completed',
      'direct_reasoning_tool_call',
      'direct_reasoning_tool_call',
      'direct_reasoning_llm_call_started',
      'direct_reasoning_llm_call_completed',
      'direct_reasoning_synthesis_started',
      'direct_reasoning_llm_call_started',
      'direct_reasoning_llm_call_completed',
      'direct_reasoning_synthesis_completed',
      'direct_reasoning_completed',
    ]);
    expect(traceEntries[0]).toMatchObject({
      requestId: 'req-1',
      messageId: 'msg-1',
      userId: 'user-1',
      channel: 'web',
      agentId: 'guardian',
    });
    const completedToolTrace = traceEntries.find((entry) => (
      entry.stage === 'direct_reasoning_tool_call'
      && (entry.details as Record<string, unknown> | undefined)?.phase === 'completed'
    ));
    expect(completedToolTrace?.details).toMatchObject({
      phase: 'completed',
      artifactCreated: true,
      artifactType: 'SearchResultSet',
      evidenceCountAfter: 1,
      artifactCountAfter: 1,
      resultShape: expect.objectContaining({
        hasNestedOutput: false,
        outputKeys: expect.arrayContaining(['query', 'matches']),
      }),
    });
    expect(graphEvents.map((entry) => entry.kind)).toEqual(expect.arrayContaining([
      'graph_started',
      'node_started',
      'tool_call_started',
      'tool_call_completed',
      'artifact_created',
      'llm_call_started',
      'llm_call_completed',
      'node_completed',
      'graph_completed',
    ]));
    expect(graphEvents.filter((entry) => entry.kind === 'artifact_created').map((entry) => (entry.payload as Record<string, unknown>).artifactType)).toEqual([
      'SearchResultSet',
      'EvidenceLedger',
      'SynthesisDraft',
    ]);
    expect(graphEvents.find((entry) => entry.kind === 'tool_call_started')).toMatchObject({
      graphId: 'execution-graph:req-1:direct-reasoning',
      executionId: 'req-1',
      rootExecutionId: 'req-1',
      requestId: 'req-1',
      runId: 'req-1',
      nodeKind: 'explore_readonly',
      producer: 'brokered_worker',
      channel: 'web',
      agentId: 'guardian',
      codeSessionId: 'code-1',
      payload: expect.objectContaining({
        toolName: 'fs_search',
        argsPreview: expect.stringContaining('IntentGateway'),
      }),
    });
    expect(result.metadata?.directReasoningStats).toMatchObject({
      artifactCount: 3,
      artifactIds: expect.arrayContaining([
        'execution-graph:req-1:direct-reasoning:turn-1:call-1:artifact',
        'execution-graph:req-1:direct-reasoning:evidence-ledger',
        'execution-graph:req-1:direct-reasoning:synthesis-draft',
      ]),
    });
  });

  it('uses the execution id for direct-reasoning trace and graph correlation when present', async () => {
    const chat = vi.fn(async (): Promise<ChatResponse> => chatResponse({
      content: 'No repository evidence was needed.',
    }));
    const traceEntries: Array<Record<string, unknown>> = [];
    const graphEvents: Array<Record<string, unknown>> = [];

    await handleDirectReasoningMode({
      message: 'Answer from context only.',
      gateway: gateway(),
      selectedExecutionProfile: profile(),
      workspaceRoot: 'S:/Development/GuardianAgent',
      traceContext: {
        requestId: 'internal-message-id',
        messageId: 'message-1',
        executionId: 'web-request-id',
        rootExecutionId: 'web-request-id',
        channel: 'web',
        agentId: 'guardian',
      },
    }, {
      chat,
      executeTool: vi.fn(),
      trace: {
        record: (entry) => traceEntries.push(entry as unknown as Record<string, unknown>),
      },
      graphEvents: {
        emit: (event) => graphEvents.push(event as unknown as Record<string, unknown>),
      },
    });

    expect(traceEntries.length).toBeGreaterThan(0);
    expect(traceEntries.every((entry) => entry.requestId === 'web-request-id')).toBe(true);
    expect(traceEntries[0]).toMatchObject({
      messageId: 'message-1',
      channel: 'web',
      agentId: 'guardian',
    });
    expect(graphEvents.find((entry) => entry.kind === 'graph_started')).toMatchObject({
      graphId: 'execution-graph:web-request-id:direct-reasoning',
      executionId: 'web-request-id',
      rootExecutionId: 'web-request-id',
      requestId: 'web-request-id',
      runId: 'web-request-id',
    });
  });

  it('traces and retries a first exploration model call that returns no response', async () => {
    const chat = vi.fn(async (_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      const callNumber = chat.mock.calls.length;
      if (callNumber === 1) {
        throw new Error('transient provider stall');
      }
      if (callNumber === 2) {
        expect(_messages[0]?.content).toContain('previous model turn did not complete');
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'retry-call-1',
              name: 'fs_search',
              arguments: JSON.stringify({ query: 'run timeline rendering', mode: 'content' }),
            },
          ],
        });
      }
      if (options?.tools && options.tools.length > 0) {
        return chatResponse({
          content: 'Draft answer from read evidence.',
        });
      }
      return chatResponse({
        content: 'Run timeline rendering is implemented by `web/public/js/chat-panel.js`.',
      });
    });
    const executeTool = vi.fn(async () => ({
      success: true,
      status: 'succeeded',
      message: 'ok',
      output: {
        query: 'run timeline rendering',
        matches: [
          {
            relativePath: 'web/public/js/chat-panel.js',
            matchType: 'content',
            snippet: 'function updateActiveChatIndicatorTimeline(run) {}',
          },
        ],
      },
    }));
    const traceEntries: Array<Record<string, unknown>> = [];

    const result = await handleDirectReasoningMode({
      message: 'Inspect this repo and tell me which files implement run timeline rendering.',
      gateway: gateway(),
      selectedExecutionProfile: profile(),
      workspaceRoot: 'S:/Development/GuardianAgent',
      traceContext: {
        requestId: 'req-retry',
        messageId: 'msg-retry',
      },
    }, {
      chat,
      executeTool,
      trace: {
        record: (entry) => traceEntries.push(entry as unknown as Record<string, unknown>),
      },
    });

    expect(result.content).toContain('web/public/js/chat-panel.js');
    expect(chat).toHaveBeenCalledTimes(4);
    expect(executeTool).toHaveBeenCalledTimes(1);
    const llmStarted = traceEntries.filter((entry) => entry.stage === 'direct_reasoning_llm_call_started');
    const llmCompleted = traceEntries.filter((entry) => entry.stage === 'direct_reasoning_llm_call_completed');
    expect(llmStarted[0]?.details).toMatchObject({ phase: 'exploration', turn: 1, attempt: 1 });
    expect(llmCompleted[0]?.details).toMatchObject({
      phase: 'exploration',
      turn: 1,
      attempt: 1,
      resultStatus: 'timed_out_or_failed',
    });
    expect(llmStarted[1]?.details).toMatchObject({
      phase: 'exploration',
      turn: 1,
      attempt: 2,
      retryReason: 'first_call_no_response',
    });
    expect(llmCompleted[1]?.details).toMatchObject({
      phase: 'exploration',
      turn: 1,
      attempt: 2,
      resultStatus: 'succeeded',
      toolCallCount: 1,
    });
  });

  it('refuses tools outside the read-only direct reasoning allowlist', async () => {
    const executeTool = vi.fn();
    const result = await executeDirectReasoningToolCall({
      toolCall: {
        id: 'call-1',
        name: 'fs_write',
        arguments: JSON.stringify({ path: 'tmp/test.txt', content: 'nope' }),
      },
      input: {
        message: 'write a file',
        gateway: gateway(),
        selectedExecutionProfile: profile(),
      },
      deps: {
        chat: vi.fn(),
        executeTool,
      },
      turn: 1,
    });

    expect(result).toContain('not available in direct reasoning mode');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('bounds broad direct fs_search calls to the workspace search root', async () => {
    const executeTool = vi.fn(async (_toolName: string, args: Record<string, unknown>) => ({
      success: true,
      status: 'succeeded',
      output: {
        query: args.query,
        path: args.path,
        matches: [],
      },
    }));

    await executeDirectReasoningToolCall({
      toolCall: {
        id: 'call-1',
        name: 'fs_search',
        arguments: JSON.stringify({ query: 'direct_reasoning_tool_call' }),
      },
      input: {
        message: 'Inspect this repo and tell me where direct reasoning tool calls are recorded.',
        gateway: gateway(),
        selectedExecutionProfile: profile(),
        workspaceRoot: 'S:/Development/GuardianAgent',
      },
      deps: {
        chat: vi.fn(),
        executeTool,
      },
      turn: 1,
    });

    expect(executeTool).toHaveBeenCalledWith('fs_search', expect.objectContaining({
      path: '.',
      maxResults: 40,
      maxDepth: 12,
      maxFiles: 2500,
      maxFileBytes: 1000000,
    }), expect.any(Object));
  });

  it('keeps direct reasoning search and read evidence budgets large enough for source files', async () => {
    const executeTool = vi.fn(async () => ({
      success: true,
      status: 'succeeded',
      output: { matches: [], content: 'export function renderRunTimeline() {}', bytes: 40 },
    }));

    await executeDirectReasoningToolCall({
      toolCall: {
        id: 'call-search-small-budget',
        name: 'fs_search',
        arguments: JSON.stringify({
          query: 'timeline',
          path: 'web',
          mode: 'content',
          maxResults: 1,
          maxDepth: 1,
          maxFiles: 50,
          maxFileBytes: 500,
        }),
      },
      input: {
        message: 'Inspect this repo and tell me which files implement run timeline rendering.',
        gateway: gateway(),
        selectedExecutionProfile: profile(),
        workspaceRoot: 'S:/Development/GuardianAgent',
      },
      deps: {
        chat: vi.fn(),
        executeTool,
      },
      turn: 1,
    });

    expect(executeTool).toHaveBeenCalledWith('fs_search', expect.objectContaining({
      maxResults: 40,
      maxDepth: 12,
      maxFiles: 2500,
      maxFileBytes: 1000000,
    }), expect.any(Object));

    await executeDirectReasoningToolCall({
      toolCall: {
        id: 'call-read-small-budget',
        name: 'fs_read',
        arguments: JSON.stringify({
          path: 'web/public/js/chat-panel.js',
          maxBytes: 500,
        }),
      },
      input: {
        message: 'Inspect this repo and tell me which files implement run timeline rendering.',
        gateway: gateway(),
        selectedExecutionProfile: profile(),
        workspaceRoot: 'S:/Development/GuardianAgent',
      },
      deps: {
        chat: vi.fn(),
        executeTool,
      },
      turn: 1,
    });

    expect(executeTool).toHaveBeenLastCalledWith('fs_read', expect.objectContaining({
      path: 'web/public/js/chat-panel.js',
      maxBytes: 256000,
    }), expect.any(Object));
  });

  it('feeds workspace-relative search paths back to the model', async () => {
    const executeTool = vi.fn(async () => ({
      success: true,
      status: 'succeeded',
      output: {
        root: 'S:/Development/GuardianAgent/src',
        query: 'run-timeline',
        matches: [
          {
            relativePath: 'runtime/run-timeline.ts',
            matchType: 'name',
            snippet: 'export class RunTimelineStore',
          },
        ],
      },
    }));

    const result = await executeDirectReasoningToolCall({
      toolCall: {
        id: 'call-search-paths',
        name: 'fs_search',
        arguments: JSON.stringify({ query: 'run-timeline', path: 'src' }),
      },
      input: {
        message: 'Inspect this repo and tell me which files implement run timeline rendering.',
        gateway: gateway(),
        selectedExecutionProfile: profile(),
        workspaceRoot: 'S:/Development/GuardianAgent',
      },
      deps: {
        chat: vi.fn(),
        executeTool,
      },
      turn: 1,
    });

    expect(result).toContain('src/runtime/run-timeline.ts');
  });

  it('resolves direct fs_read paths relative to the default repo search root', async () => {
    const executeTool = vi.fn(async () => ({
      success: false,
      status: 'failed',
      message: 'not read in this test',
    }));

    await executeDirectReasoningToolCall({
      toolCall: {
        id: 'call-read-path',
        name: 'fs_read',
        arguments: JSON.stringify({ path: 'runtime/run-timeline.ts' }),
      },
      input: {
        message: 'Inspect this repo and tell me which files implement run timeline rendering.',
        gateway: gateway(),
        selectedExecutionProfile: profile(),
        workspaceRoot: 'S:/Development/GuardianAgent',
      },
      deps: {
        chat: vi.fn(),
        executeTool,
      },
      turn: 1,
    });

    expect(executeTool).toHaveBeenCalledWith('fs_read', expect.objectContaining({
      path: 'src/runtime/run-timeline.ts',
    }), expect.any(Object));
  });

  it('canonicalizes nested top-level web paths for direct read and search tools', async () => {
    const executeTool = vi.fn(async () => ({
      success: true,
      status: 'succeeded',
      output: {
        root: 'S:/Development/GuardianAgent/web',
        query: 'chat-panel',
        matches: [],
      },
    }));

    await executeDirectReasoningToolCall({
      toolCall: {
        id: 'call-search-web',
        name: 'fs_search',
        arguments: JSON.stringify({ query: 'chat-panel', path: 'src/web' }),
      },
      input: {
        message: 'Inspect run timeline rendering in the web UI.',
        gateway: gateway(),
        selectedExecutionProfile: profile(),
        workspaceRoot: 'S:/Development/GuardianAgent',
      },
      deps: {
        chat: vi.fn(),
        executeTool,
      },
      turn: 1,
    });

    expect(executeTool).toHaveBeenCalledWith('fs_search', expect.objectContaining({
      path: 'web',
    }), expect.any(Object));

    await executeDirectReasoningToolCall({
      toolCall: {
        id: 'call-read-web',
        name: 'fs_read',
        arguments: JSON.stringify({ path: 'src/web/public/js/chat-panel.js' }),
      },
      input: {
        message: 'Inspect run timeline rendering in the web UI.',
        gateway: gateway(),
        selectedExecutionProfile: profile(),
        workspaceRoot: 'S:/Development/GuardianAgent',
      },
      deps: {
        chat: vi.fn(),
        executeTool,
      },
      turn: 1,
    });

    expect(executeTool).toHaveBeenLastCalledWith('fs_read', expect.objectContaining({
      path: 'web/public/js/chat-panel.js',
    }), expect.any(Object));
  });

  it('uses a no-tools grounded synthesis call when tool exploration reaches the turn budget without a final answer', async () => {
    const chat = vi.fn(async (_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      if (options?.tools && options.tools.length > 0) {
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'call-1',
              name: 'fs_read',
              arguments: JSON.stringify({ path: 'src/runtime/direct-reasoning-mode.ts' }),
            },
          ],
        });
      }
      return chatResponse({
        content: 'Planned steps are defined in `src/runtime/intent/types.ts` by `IntentGatewayPlannedStep`.',
      });
    });
    const largeRead = [
      'export function buildDirectReasoningToolSet() {}',
      'export async function executeDirectReasoningToolCall() {}',
      'x'.repeat(50_000),
    ].join('\n');
    const executeTool = vi.fn(async () => ({
      success: true,
      status: 'succeeded',
      output: {
        query: 'plannedSteps',
        path: 'src/runtime/direct-reasoning-mode.ts',
        bytes: largeRead.length,
        content: largeRead,
      },
    }));
    const traceEntries: Array<Record<string, unknown>> = [];

    const result = await handleDirectReasoningMode({
      message: 'Find the files that define IntentGateway planned steps.',
      gateway: gateway({ operation: 'search' }),
      selectedExecutionProfile: profile(),
      maxTurns: 1,
      traceContext: {
        requestId: 'req-recovery',
        messageId: 'msg-recovery',
      },
    }, {
      chat,
      executeTool,
      trace: {
        record: (entry) => traceEntries.push(entry as unknown as Record<string, unknown>),
      },
    });

    expect(result.content).toContain('src/runtime/intent/types.ts');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1]?.[1]?.tools).toEqual([]);
    const recoveryMessages = chat.mock.calls[1]?.[0] ?? [];
    const recoveryPrompt = recoveryMessages.map((message) => message.content).join('\n');
    expect(recoveryPrompt).toContain('Typed evidence');
    expect(recoveryPrompt).toContain('evidenceLedgerArtifactId:');
    expect(recoveryPrompt).toContain('executeDirectReasoningToolCall');
    expect(recoveryPrompt.length).toBeLessThan(30_000);
    expect(traceEntries.map((entry) => entry.stage)).toContain('direct_reasoning_synthesis_started');
    expect(traceEntries.map((entry) => entry.stage)).toContain('direct_reasoning_synthesis_completed');
  });

  it('bounds broad grounded synthesis prompts while preserving selected artifact telemetry', async () => {
    const readToolCalls = Array.from({ length: 16 }, (_, index) => ({
      id: `call-${index + 1}`,
      name: 'fs_read',
      arguments: JSON.stringify({ path: `src/runtime/broad-${index + 1}.ts` }),
    }));
    let synthesisPrompt = '';
    let noToolCallCount = 0;
    const chat = vi.fn(async (messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      if (options?.tools && options.tools.length > 0) {
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: readToolCalls,
        });
      }
      noToolCallCount += 1;
      if (noToolCallCount === 1) {
        synthesisPrompt = messages.map((message) => message.content).join('\n');
      }
      return chatResponse({
        content: 'Grounded synthesis cites compact selected artifacts.',
      });
    });
    const executeTool = vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
      const path = String(args.path ?? 'src/runtime/broad.ts');
      return {
        success: true,
        status: 'succeeded',
        output: {
          path,
          bytes: 20_000,
          content: [
            `export function ${path.replace(/[^a-z0-9]/gi, '')}() {}`,
            'x'.repeat(20_000),
          ].join('\n'),
        },
      };
    });
    const traceEntries: Array<Record<string, unknown>> = [];

    const result = await handleDirectReasoningMode({
      message: 'Inspect this repo and explain broad runtime architecture. Do not edit anything.',
      gateway: gateway({ operation: 'inspect' }),
      selectedExecutionProfile: profile(),
      maxTurns: 1,
    }, {
      chat,
      executeTool,
      trace: {
        record: (entry) => traceEntries.push(entry as unknown as Record<string, unknown>),
      },
    });

    expect(result.content).toContain('Grounded synthesis cites compact selected artifacts.');
    expect(synthesisPrompt).toContain('Typed evidence');
    expect(synthesisPrompt).toContain('[excerpt shortened for synthesis]');
    expect(synthesisPrompt.length).toBeLessThan(18_000);
    const synthesisStarted = traceEntries.find((entry) => entry.stage === 'direct_reasoning_synthesis_started');
    const details = synthesisStarted?.details as Record<string, unknown> | undefined;
    expect(details?.selectedArtifactCount).toBe(10);
    expect(details?.promptChars).toBeLessThan(18_000);
    expect(details?.maxEvidenceChars).toBe(10_000);
    expect(details?.maxSelectedArtifacts).toBe(10);
  });

  it('does not report timedOut when budget-limited exploration still completes grounded synthesis', async () => {
    const chat = vi.fn(async (_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      if (options?.tools && options.tools.length > 0) {
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'call-1',
              name: 'fs_read',
              arguments: JSON.stringify({ path: 'src/runtime/direct-reasoning-mode.ts' }),
            },
          ],
        });
      }
      return chatResponse({
        content: 'Grounded synthesis cites `src/runtime/direct-reasoning-mode.ts`.',
      });
    });
    const executeTool = vi.fn(async () => ({
      success: true,
      status: 'succeeded',
      output: {
        path: 'src/runtime/direct-reasoning-mode.ts',
        content: [
          'export async function handleDirectReasoningMode() {',
          '  items.map((item) => item.content).forEach((content) => output.push(content));',
          '}',
        ].join('\n'),
      },
    }));
    const nowValues = [0, 0, 4_500, 4_500, 4_500];
    let nowIndex = 0;
    const now = () => nowValues[Math.min(nowIndex++, nowValues.length - 1)];

    const result = await handleDirectReasoningMode({
      message: 'Inspect this repo and cite direct reasoning implementation files. Do not edit anything.',
      gateway: gateway({ operation: 'inspect' }),
      selectedExecutionProfile: profile(),
      maxTotalTimeMs: 5_000,
    }, {
      chat,
      executeTool,
      now,
    });

    expect(result.content).toContain('src/runtime/direct-reasoning-mode.ts');
    expect(result.metadata?.directReasoningStats).toMatchObject({
      toolCallCount: 1,
      timedOut: false,
      synthesized: true,
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1]?.[1]?.tools).toEqual([]);
  });

  it('keeps timedOut when budget-limited exploration only produces deterministic fallback evidence', async () => {
    const chat = vi.fn(async (_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      if (options?.tools && options.tools.length > 0) {
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'call-1',
              name: 'fs_read',
              arguments: JSON.stringify({ path: 'src/runtime/direct-reasoning-mode.ts' }),
            },
          ],
        });
      }
      return chatResponse({ content: '' });
    });
    const executeTool = vi.fn(async () => ({
      success: true,
      status: 'succeeded',
      output: {
        path: 'src/runtime/direct-reasoning-mode.ts',
        content: 'export async function handleDirectReasoningMode() {}',
      },
    }));
    const nowValues = [0, 0, 4_500, 4_500, 4_500];
    let nowIndex = 0;
    const now = () => nowValues[Math.min(nowIndex++, nowValues.length - 1)];

    const result = await handleDirectReasoningMode({
      message: 'Inspect this repo and cite direct reasoning implementation files. Do not edit anything.',
      gateway: gateway({ operation: 'inspect' }),
      selectedExecutionProfile: profile(),
      maxTotalTimeMs: 5_000,
    }, {
      chat,
      executeTool,
      now,
    });

    expect(result.content).toContain('Relevant implementation evidence found from brokered read-only tools:');
    expect(result.content).toContain('`handleDirectReasoningMode`');
    expect(result.content).not.toContain('`push`');
    expect(result.content).not.toContain('`content`');
    expect(result.metadata?.directReasoningStats).toMatchObject({
      toolCallCount: 1,
      timedOut: true,
      synthesized: false,
    });
  });

  it('reports timedOut when grounded synthesis times out before deterministic fallback evidence', async () => {
    vi.useFakeTimers();
    try {
      const chat = vi.fn(async (_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
        if (options?.tools && options.tools.length > 0) {
          return chatResponse({
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'call-1',
                name: 'fs_read',
                arguments: JSON.stringify({ path: 'src/runtime/direct-reasoning-mode.ts' }),
              },
            ],
          });
        }
        return new Promise<ChatResponse>(() => {});
      });
      const executeTool = vi.fn(async () => ({
        success: true,
        status: 'succeeded',
        output: {
          path: 'src/runtime/direct-reasoning-mode.ts',
          content: 'export async function handleDirectReasoningMode() {}',
        },
      }));

      const pending = handleDirectReasoningMode({
        message: 'Inspect this repo and cite direct reasoning implementation files. Do not edit anything.',
        gateway: gateway({ operation: 'inspect' }),
        selectedExecutionProfile: profile(),
        maxTurns: 1,
        maxTotalTimeMs: 5_000,
      }, {
        chat,
        executeTool,
        now: () => 0,
      });

      await vi.advanceTimersByTimeAsync(5_001);
      const result = await pending;

      expect(result.content).toContain('Relevant implementation evidence found from brokered read-only tools:');
      expect(result.metadata?.directReasoningStats).toMatchObject({
        toolCallCount: 1,
        timedOut: true,
        synthesized: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces an unsupported exploration draft with the grounded synthesis answer', async () => {
    const chat = vi.fn(async (_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      if (chat.mock.calls.length === 1) {
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'call-1',
              name: 'fs_read',
              arguments: JSON.stringify({ path: 'src/runtime/direct-reasoning-mode.ts' }),
            },
            {
              id: 'call-2',
              name: 'fs_read',
              arguments: JSON.stringify({ path: 'src/runtime/intent-routing-trace.ts' }),
            },
          ],
        });
      }
      if (options?.tools && options.tools.length > 0) {
        return chatResponse({
          content: 'Direct reasoning tool calls are recorded through `src/runtime/orchestrator.ts` and `AssistantDispatchTrace`.',
        });
      }
      return chatResponse({
        content: 'Direct reasoning records tool-call timeline evidence in `src/runtime/direct-reasoning-mode.ts` via `executeDirectReasoningToolCall()` and `recordDirectReasoningTrace()`, using the `direct_reasoning_tool_call` stage defined in `src/runtime/intent-routing-trace.ts`.',
      });
    });
    const executeTool = vi.fn(async (_toolName: string, args: Record<string, unknown>) => ({
      success: true,
      status: 'succeeded',
      output: {
        path: args.path,
        content: args.path === 'src/runtime/direct-reasoning-mode.ts'
          ? [
              "recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_tool_call', {",
              'export async function executeDirectReasoningToolCall() {}',
              'function recordDirectReasoningTrace() {}',
            ].join('\n')
          : "export type IntentRoutingTraceStage = 'direct_reasoning_tool_call' | 'direct_reasoning_completed';",
      },
    }));

    const result = await handleDirectReasoningMode({
      message: 'Inspect this repo and tell me where direct reasoning tool calls are recorded in the run timeline. Cite exact files and function names.',
      gateway: gateway({ operation: 'inspect' }),
      selectedExecutionProfile: profile(),
      workspaceRoot: 'S:/Development/GuardianAgent',
      maxTurns: 2,
    }, {
      chat,
      executeTool,
    });

    expect(chat).toHaveBeenCalledTimes(3);
    expect(chat.mock.calls[2]?.[1]?.tools).toEqual([]);
    expect(result.content).toContain('src/runtime/direct-reasoning-mode.ts');
    expect(result.content).toContain('recordDirectReasoningTrace');
    expect(result.content).toContain('src/runtime/intent-routing-trace.ts');
    expect(result.content).not.toContain('AssistantDispatchTrace');
    expect(result.content).not.toContain('src/runtime/orchestrator.ts');
  });

  it('falls back to compact evidence when grounded synthesis is empty and paths are absolute Windows paths', async () => {
    const chat = vi.fn(async (_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      if (options?.tools && options.tools.length > 0) {
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'call-1',
              name: 'fs_read',
              arguments: JSON.stringify({ path: 'S:\\Development\\GuardianAgent\\src\\runtime\\direct-reasoning-mode.ts' }),
            },
          ],
        });
      }
      return chatResponse({ content: '' });
    });
    const executeTool = vi.fn(async () => ({
      success: true,
      status: 'succeeded',
      output: {
        path: 'S:\\Development\\GuardianAgent\\src\\runtime\\direct-reasoning-mode.ts',
        bytes: 96,
        content: [
          'export async function executeDirectReasoningToolCall() {}',
          'export function recordDirectReasoningTrace() {}',
        ].join('\n'),
      },
    }));

    const result = await handleDirectReasoningMode({
      message: 'Inspect this repo and tell me where direct reasoning tool calls are recorded.',
      gateway: gateway({ operation: 'inspect' }),
      selectedExecutionProfile: profile(),
      workspaceRoot: 'S:/Development/GuardianAgent',
      maxTurns: 1,
    }, {
      chat,
      executeTool,
    });

    expect(result.metadata?.directReasoningFailed).toBeUndefined();
    expect(result.content).toContain('src/runtime/direct-reasoning-mode.ts');
    expect(result.content).toContain('executeDirectReasoningToolCall');
    expect(result.content).toContain('recordDirectReasoningTrace');
    expect(result.content).not.toContain('src//runtime');
  });

  it('prioritizes implementation files over noisy test hits in deterministic fallback evidence', async () => {
    const chat = vi.fn(async (_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      if (options?.tools && options.tools.length > 0) {
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'call-1',
              name: 'fs_search',
              arguments: JSON.stringify({ path: 'src', query: 'run timeline rendering', mode: 'content' }),
            },
          ],
        });
      }
      return chatResponse({ content: '' });
    });
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'fs_read') {
        const path = String(args.path ?? '');
        return {
          success: true,
          status: 'succeeded',
          output: {
            path,
            bytes: 120,
            content: path === 'web/public/js/chat-panel.js'
              ? 'function summarizeTimelineRun(run) { return humanizeTimelineStatus(run.status); }'
              : path === 'web/public/js/pages/code.js'
                ? 'function renderSessionRunTimeline(session) { return session.timelineItems; }'
                : 'export class RunTimelineStore { ingestExecutionGraphEvent() {} }',
          },
        };
      }
      return {
        success: true,
        status: 'succeeded',
        output: {
          query: 'run timeline rendering',
          matches: [
            {
              relativePath: 'runtime/run-timeline.test.ts',
              matchType: 'content',
              snippet: 'it("renders timeline items", () => expect(store.getRun("run-1")).toBeTruthy())',
            },
            {
              relativePath: 'runtime/direct-reasoning-mode.test.ts',
              matchType: 'content',
              snippet: 'expect(result.content).toContain("RunTimelineStore")',
            },
            {
              relativePath: 'runtime/run-timeline.ts',
              matchType: 'content',
              snippet: 'export class RunTimelineStore { ingestExecutionGraphEvent() {} }',
            },
            {
              relativePath: 'web/public/js/chat-panel.js',
              matchType: 'content',
              snippet: 'function summarizeTimelineRun(run) { return humanizeTimelineStatus(run.status); }',
            },
            {
              relativePath: 'web/public/js/pages/code.js',
              matchType: 'content',
              snippet: 'function renderSessionRunTimeline(session) { return session.timelineItems; }',
            },
          ],
        },
      };
    });

    const result = await handleDirectReasoningMode({
      message: 'Inspect this repo and tell me which files implement run timeline rendering. Do not edit anything.',
      gateway: gateway({ operation: 'inspect' }),
      selectedExecutionProfile: profile(),
      workspaceRoot: 'S:/Development/GuardianAgent',
      maxTurns: 1,
    }, {
      chat,
      executeTool,
    });

    expect(result.metadata?.directReasoningFailed).toBeUndefined();
    expect(result.content).toContain('Relevant implementation evidence found from brokered read-only tools:');
    expect(result.content).toContain('src/runtime/run-timeline.ts');
    expect(result.content).toContain('web/public/js/chat-panel.js');
    expect(result.content).toContain('web/public/js/pages/code.js');
    expect(result.content).not.toContain('runtime/run-timeline.test.ts');
    expect(result.content).not.toContain('runtime/direct-reasoning-mode.test.ts');
    expect(executeTool).toHaveBeenCalledWith('fs_read', expect.objectContaining({
      path: 'web/public/js/chat-panel.js',
    }), expect.any(Object));
    expect(executeTool).toHaveBeenCalledWith('fs_read', expect.objectContaining({
      path: 'web/public/js/pages/code.js',
    }), expect.any(Object));
  });

  it('reserves final synthesis once enough concrete repo evidence has been collected', async () => {
    const explorationCalls: ToolCall[] = [
      {
        id: 'read-1',
        name: 'fs_read',
        arguments: JSON.stringify({ path: 'src/runtime/run-timeline.ts' }),
      },
      {
        id: 'read-2',
        name: 'fs_read',
        arguments: JSON.stringify({ path: 'web/public/js/chat-panel.js' }),
      },
      {
        id: 'search-1',
        name: 'fs_search',
        arguments: JSON.stringify({ path: '.', query: 'timeline', mode: 'auto' }),
      },
      {
        id: 'search-2',
        name: 'fs_search',
        arguments: JSON.stringify({ path: 'web', query: 'run.timeline', mode: 'content' }),
      },
      {
        id: 'search-3',
        name: 'fs_search',
        arguments: JSON.stringify({ path: 'web', query: 'renderRunTimeline', mode: 'content' }),
      },
      {
        id: 'search-4',
        name: 'fs_search',
        arguments: JSON.stringify({ path: 'web', query: 'timeline-item', mode: 'content' }),
      },
    ];
    const chat = vi.fn(async (_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      if (options?.tools && options.tools.length > 0) {
        const call = explorationCalls.shift() ?? {
          id: 'extra-search',
          name: 'fs_search',
          arguments: JSON.stringify({ path: '.', query: 'extra', mode: 'auto' }),
        };
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: [call],
        });
      }
      return chatResponse({
        content: 'Synthesized answer from reserved evidence.',
      });
    });
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'fs_read') {
        return {
          success: true,
          status: 'succeeded',
          output: {
            path: args.path,
            bytes: 100,
            content: `export function ${String(args.path).includes('chat-panel') ? 'summarizeTimelineRun' : 'ingestExecutionGraphEvent'}() {}`,
          },
        };
      }
      return {
        success: true,
        status: 'succeeded',
        output: {
          query: args.query,
          matches: [
            { relativePath: 'src/runtime/run-timeline.ts', matchType: 'content', snippet: 'export class RunTimelineStore {}' },
            { relativePath: 'src/runtime/execution-graph/timeline-adapter.ts', matchType: 'content', snippet: 'export function projectExecutionGraphEventToTimeline() {}' },
            { relativePath: 'web/public/js/chat-panel.js', matchType: 'content', snippet: 'function summarizeTimelineRun(run) {}' },
            { relativePath: 'web/public/js/pages/code.js', matchType: 'content', snippet: 'function renderSessionRunTimeline(session) {}' },
            { relativePath: 'web/public/js/pages/system.js', matchType: 'content', snippet: 'function renderRuntimeExecutionTimelineItems(items) {}' },
            { relativePath: 'web/public/js/pages/automations.js', matchType: 'content', snippet: 'function renderExecutionTimelineItems(items) {}' },
          ],
        },
      };
    });

    const result = await handleDirectReasoningMode({
      message: 'Inspect this repo and tell me which files implement run timeline rendering. Do not edit anything.',
      gateway: gateway({ operation: 'inspect' }),
      selectedExecutionProfile: profile(),
      workspaceRoot: 'S:/Development/GuardianAgent',
      maxTurns: 8,
    }, {
      chat,
      executeTool,
    });

    expect(result.content).toContain('Synthesized answer from reserved evidence.');
    expect(result.metadata?.directReasoningStats).toMatchObject({
      turns: 5,
      synthesized: true,
    });
    const explorationCallCount = chat.mock.calls.filter(([, options]) => (options?.tools?.length ?? 0) > 0).length;
    expect(explorationCallCount).toBe(5);
  });

  it('revises grounded synthesis when the draft omits high-confidence implementation coverage', async () => {
    const explorationCalls: ToolCall[] = [
      {
        id: 'read-1',
        name: 'fs_read',
        arguments: JSON.stringify({ path: 'src/runtime/run-timeline.ts' }),
      },
      {
        id: 'read-2',
        name: 'fs_read',
        arguments: JSON.stringify({ path: 'web/public/js/chat-panel.js' }),
      },
      {
        id: 'search-1',
        name: 'fs_search',
        arguments: JSON.stringify({ path: '.', query: 'timeline', mode: 'auto' }),
      },
      {
        id: 'search-2',
        name: 'fs_search',
        arguments: JSON.stringify({ path: 'web', query: 'run.timeline', mode: 'content' }),
      },
      {
        id: 'search-3',
        name: 'fs_search',
        arguments: JSON.stringify({ path: 'web', query: 'renderRunTimeline', mode: 'content' }),
      },
    ];
    let noToolCallCount = 0;
    const chat = vi.fn(async (messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      if (options?.tools && options.tools.length > 0) {
        const call = explorationCalls.shift() ?? {
          id: 'extra-search',
          name: 'fs_search',
          arguments: JSON.stringify({ path: '.', query: 'extra', mode: 'auto' }),
        };
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: [call],
        });
      }
      noToolCallCount += 1;
      if (noToolCallCount === 1) {
        expect(messages[messages.length - 1]?.content).toContain('Deterministic evidence coverage:');
        return chatResponse({
          content: 'The run timeline pipeline is in `src/runtime/run-timeline.ts`.',
        });
      }
      expect(messages[messages.length - 1]?.content).toContain('Coverage files omitted by the draft:');
      return chatResponse({
        content: [
          'Run timeline rendering is implemented by `src/runtime/run-timeline.ts`, `web/public/js/chat-panel.js`, `web/public/js/pages/code.js`, `web/public/js/pages/system.js`, and `web/public/js/pages/automations.js`.',
          'The graph projection is in `src/runtime/execution-graph/timeline-adapter.ts`.',
        ].join('\n'),
      });
    });
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'fs_read') {
        const path = String(args.path ?? '');
        const contentByPath: Record<string, string> = {
          'src/runtime/run-timeline.ts': 'export class RunTimelineStore { ingestExecutionGraphEvent() {} }',
          'web/public/js/chat-panel.js': 'function summarizeTimelineRun(run) { return humanizeTimelineStatus(run.status); }',
          'web/public/js/pages/code.js': 'function renderSessionRunTimeline(session) { return session.timelineItems; }',
          'web/public/js/pages/system.js': 'function renderRuntimeExecutionTimelineItems(items) { return items.map(renderItem); }',
          'web/public/js/pages/automations.js': 'function renderExecutionTimelineItems(items) { return items.map(renderItem); }',
        };
        return {
          success: true,
          status: 'succeeded',
          output: {
            path: `S:/Development/GuardianAgent/${path}`,
            bytes: contentByPath[path]?.length ?? 0,
            content: contentByPath[path] ?? 'export function unrelated() {}',
          },
        };
      }
      return {
        success: true,
        status: 'succeeded',
        output: {
          query: args.query,
          matches: [
            { relativePath: 'src/runtime/run-timeline.ts', matchType: 'content', snippet: 'export class RunTimelineStore {}' },
            { relativePath: 'src/runtime/execution-graph/timeline-adapter.ts', matchType: 'content', snippet: 'export function projectExecutionGraphEventToTimeline() {}' },
            { relativePath: 'web/public/js/chat-panel.js', matchType: 'content', snippet: 'function summarizeTimelineRun(run) {}' },
            { relativePath: 'web/public/js/pages/code.js', matchType: 'content', snippet: 'function renderSessionRunTimeline(session) {}' },
            { relativePath: 'web/public/js/pages/system.js', matchType: 'content', snippet: 'function renderRuntimeExecutionTimelineItems(items) {}' },
            { relativePath: 'web/public/js/pages/automations.js', matchType: 'content', snippet: 'function renderExecutionTimelineItems(items) {}' },
          ],
        },
      };
    });
    const traceEntries: Array<Record<string, unknown>> = [];

    const result = await handleDirectReasoningMode({
      message: 'Inspect this repo and tell me which files implement run timeline rendering. Do not edit anything.',
      gateway: gateway({
        operation: 'inspect',
        resolvedContent: 'Inspect this repo and tell me which files implement run timeline rendering. Do not edit anything.',
        requireExactFileReferences: true,
      }),
      selectedExecutionProfile: profile(),
      workspaceRoot: 'S:/Development/GuardianAgent',
      maxTurns: 8,
    }, {
      chat,
      executeTool,
      trace: {
        record: (entry) => traceEntries.push(entry as unknown as Record<string, unknown>),
      },
    });

    expect(result.content).toContain('web/public/js/pages/code.js');
    expect(result.content).toContain('web/public/js/pages/system.js');
    expect(result.content).toContain('web/public/js/pages/automations.js');
    expect(noToolCallCount).toBe(2);
    const synthesisStarted = traceEntries.find((entry) => entry.stage === 'direct_reasoning_synthesis_started');
    const selectedArtifacts = (synthesisStarted?.details as Record<string, unknown> | undefined)?.selectedArtifacts as Array<Record<string, unknown>> | undefined;
    expect(selectedArtifacts?.some((artifact) => (
      artifact.artifactType === 'FileReadSet'
      && Array.isArray(artifact.refs)
      && artifact.refs.includes('web/public/js/pages/code.js')
    ))).toBe(true);
    expect(selectedArtifacts?.some((artifact) => (
      artifact.artifactType === 'FileReadSet'
      && Array.isArray(artifact.refs)
      && artifact.refs.includes('web/public/js/chat-panel.js')
    ))).toBe(true);
    expect(traceEntries.some((entry) => (
      entry.stage === 'direct_reasoning_synthesis_coverage_revision'
      && (entry.details as Record<string, unknown> | undefined)?.phase === 'started'
    ))).toBe(true);
  });

  it('appends deterministic coverage when revision keeps an incomplete exact-file draft', async () => {
    let noToolCallCount = 0;
    const chat = vi.fn(async (messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      if (options?.tools && options.tools.length > 0) {
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'search-1',
              name: 'fs_search',
              arguments: JSON.stringify({ path: '.', query: 'run timeline rendering', mode: 'content' }),
            },
          ],
        });
      }
      noToolCallCount += 1;
      if (noToolCallCount === 1) {
        expect(messages[messages.length - 1]?.content).toContain('Deterministic evidence coverage:');
        return chatResponse({
          content: 'Run timeline rendering is implemented by `src/runtime/run-timeline.ts` and `web/public/js/pages/system.js`.',
        });
      }
      expect(messages[messages.length - 1]?.content).toContain('Coverage files omitted by the draft:');
      return chatResponse({ content: '' });
    });
    const contentByPath: Record<string, string> = {
      'src/runtime/run-timeline.ts': 'export class RunTimelineStore { ingestExecutionGraphEvent() {} }',
      'src/runtime/execution-graph/timeline-adapter.ts': 'export function projectExecutionGraphEventToTimeline() {}',
      'web/public/js/chat-panel.js': 'function summarizeTimelineRun(run) { return humanizeTimelineStatus(run.status); }',
      'web/public/js/components/run-timeline-context.js': 'export function renderRunTimelineContextAssembly() {}',
      'web/public/js/pages/code.js': 'function renderSessionRunTimeline(session) { return session.timelineItems; }',
      'web/public/js/pages/system.js': 'function renderRuntimeExecutionTimelineItems(items) { return items.map(renderItem); }',
      'web/public/js/pages/automations.js': 'function renderExecutionTimelineItems(items) { return items.map(renderItem); }',
      'src/runtime/intent/route-classifier.ts': 'export function classifyWithIntentGateway() {}',
      'src/supervisor/worker-manager.ts': 'export class WorkerManager {}',
    };
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'fs_read') {
        const path = String(args.path ?? '');
        const content = contentByPath[path] ?? 'export function unrelated() {}';
        return {
          success: true,
          status: 'succeeded',
          output: {
            path,
            bytes: content.length,
            content,
          },
        };
      }
      return {
        success: true,
        status: 'succeeded',
        output: {
          query: args.query,
          matches: Object.entries(contentByPath).map(([relativePath, content]) => ({
            relativePath,
            matchType: 'content',
            snippet: content,
          })),
        },
      };
    });
    const traceEntries: Array<Record<string, unknown>> = [];

    const result = await handleDirectReasoningMode({
      message: 'Inspect this repo and tell me which files implement run timeline rendering. Do not edit anything.',
      gateway: gateway({
        operation: 'inspect',
        resolvedContent: 'Inspect this repo and tell me which files implement run timeline rendering. Do not edit anything.',
        requireExactFileReferences: true,
      }),
      selectedExecutionProfile: profile(),
      workspaceRoot: 'S:/Development/GuardianAgent',
      maxTurns: 1,
    }, {
      chat,
      executeTool,
      trace: {
        record: (entry) => traceEntries.push(entry as unknown as Record<string, unknown>),
      },
    });

    expect(result.content).toContain('Additional directly evidenced implementation files:');
    expect(result.content).toContain('web/public/js/chat-panel.js');
    expect(result.content).toContain('web/public/js/components/run-timeline-context.js');
    expect(result.content).toContain('web/public/js/pages/code.js');
    expect(result.content).toContain('web/public/js/pages/automations.js');
    expect(result.content).toContain('src/runtime/execution-graph/timeline-adapter.ts');
    expect(result.content).not.toContain('src/runtime/intent/route-classifier.ts');
    expect(result.content).not.toContain('src/supervisor/worker-manager.ts');
    expect(noToolCallCount).toBe(2);
    expect(traceEntries.some((entry) => (
      entry.stage === 'direct_reasoning_synthesis_coverage_revision'
      && (entry.details as Record<string, unknown> | undefined)?.phase === 'deterministic_completion'
      && (entry.details as Record<string, unknown> | undefined)?.resultStatus === 'appended'
    ))).toBe(true);
  });

  it('completes directly evidenced web-page consumers without requiring gateway exact-file flags', async () => {
    let noToolCallCount = 0;
    const chat = vi.fn(async (_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      if (options?.tools && options.tools.length > 0) {
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'read-component',
              name: 'fs_read',
              arguments: JSON.stringify({ path: 'web/public/js/components/run-timeline-context.js' }),
            },
            {
              id: 'read-automations',
              name: 'fs_read',
              arguments: JSON.stringify({ path: 'web/public/js/pages/automations.js' }),
            },
            {
              id: 'read-code',
              name: 'fs_read',
              arguments: JSON.stringify({ path: 'web/public/js/pages/code.js' }),
            },
            {
              id: 'read-system',
              name: 'fs_read',
              arguments: JSON.stringify({ path: 'web/public/js/pages/system.js' }),
            },
            {
              id: 'read-app',
              name: 'fs_read',
              arguments: JSON.stringify({ path: 'web/public/js/app.js' }),
            },
            {
              id: 'read-api',
              name: 'fs_read',
              arguments: JSON.stringify({ path: 'web/public/js/api.js' }),
            },
          ],
        });
      }
      noToolCallCount += 1;
      if (noToolCallCount === 1) {
        return chatResponse({
          content: 'The automations page consumes it through `web/public/js/pages/automations.js`.',
        });
      }
      return chatResponse({ content: '' });
    });
    const contentByPath: Record<string, string> = {
      'web/public/js/components/run-timeline-context.js': [
        'export function normalizeRunTimelineContextAssembly(value) { return value; }',
        'export function renderRunTimelineContextAssembly(contextAssembly, esc) { return esc(contextAssembly); }',
      ].join('\n'),
      'web/public/js/pages/automations.js': [
        "import { normalizeRunTimelineContextAssembly, renderRunTimelineContextAssembly } from '../components/run-timeline-context.js';",
        'function renderExecutionTimelineItems(items) { return renderRunTimelineContextAssembly(items[0]?.contextAssembly, esc); }',
      ].join('\n'),
      'web/public/js/pages/code.js': [
        "import { normalizeRunTimelineContextAssembly, renderRunTimelineContextAssembly } from '../components/run-timeline-context.js';",
        'function renderSessionRunTimeline(session) { return renderRunTimelineContextAssembly(session.contextAssembly, esc); }',
      ].join('\n'),
      'web/public/js/pages/system.js': [
        "import { normalizeRunTimelineContextAssembly, renderRunTimelineContextAssembly } from '../components/run-timeline-context.js';",
        'function renderRuntimeExecutionTimelineItems(items) { return renderRunTimelineContextAssembly(items[0]?.contextAssembly, esc); }',
      ].join('\n'),
      'web/public/js/app.js': "import { renderAutomations } from './pages/automations.js';",
      'web/public/js/api.js': 'export async function apiFetch(path) { return fetch(path); }',
    };
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      expect(toolName).toBe('fs_read');
      const path = String(args.path ?? '');
      const content = contentByPath[path] ?? '';
      return {
        success: true,
        status: 'succeeded',
        output: {
          path,
          bytes: content.length,
          content,
        },
      };
    });
    const traceEntries: Array<Record<string, unknown>> = [];

    const request = 'Inspect this repo and tell me which web pages consume run-timeline-context.js. Do not edit anything.';
    const result = await handleDirectReasoningMode({
      message: request,
      gateway: gateway({
        operation: 'inspect',
        resolvedContent: request,
        requireExactFileReferences: false,
      }),
      selectedExecutionProfile: profile(),
      workspaceRoot: 'S:/Development/GuardianAgent',
      maxTurns: 1,
    }, {
      chat,
      executeTool,
      trace: {
        record: (entry) => traceEntries.push(entry as unknown as Record<string, unknown>),
      },
    });

    expect(result.content).toContain('Additional directly evidenced implementation files:');
    expect(result.content).toContain('web/public/js/pages/automations.js');
    expect(result.content).toContain('web/public/js/pages/code.js');
    expect(result.content).toContain('web/public/js/pages/system.js');
    expect(result.content).not.toContain('web/public/js/components/run-timeline-context.js');
    expect(result.content).not.toContain('web/public/js/app.js');
    expect(result.content).not.toContain('web/public/js/api.js');
    expect(noToolCallCount).toBe(2);
    expect(traceEntries.some((entry) => (
      entry.stage === 'direct_reasoning_synthesis_coverage_revision'
      && (entry.details as Record<string, unknown> | undefined)?.phase === 'deterministic_completion'
      && (entry.details as Record<string, unknown> | undefined)?.resultStatus === 'appended'
    ))).toBe(true);
  });

  it('expands read evidence through concrete code references before exact-file synthesis', async () => {
    let noToolCallCount = 0;
    const chat = vi.fn(async (_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      if (options?.tools && options.tools.length > 0) {
        return chatResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'search-1',
              name: 'fs_search',
              arguments: JSON.stringify({ path: '.', query: 'timeline', mode: 'name' }),
            },
          ],
        });
      }
      noToolCallCount += 1;
      return chatResponse({
        content: noToolCallCount === 1
          ? 'Run timeline context rendering is in `web/public/js/components/run-timeline-context.js`.'
          : '',
      });
    });
    const contentByPath: Record<string, string> = {
      'web/public/js/components/run-timeline-context.js': [
        'export function normalizeRunTimelineContextAssembly(value) { return value; }',
        'export function renderRunTimelineContextAssembly(contextAssembly, esc) { return esc(contextAssembly); }',
      ].join('\n'),
      'web/public/js/pages/automations.js': [
        "import { normalizeRunTimelineContextAssembly, renderRunTimelineContextAssembly } from '../components/run-timeline-context.js';",
        "function bindRunTimelineUpdates() { onSSE('run.timeline', runTimelineHandler); }",
        'function renderExecutionTimelineItems(items, runId) { return renderRunTimelineContextAssembly(items[0]?.contextAssembly, esc); }',
      ].join('\n'),
      'web/public/js/pages/code.js': [
        "import { normalizeRunTimelineContextAssembly, renderRunTimelineContextAssembly } from '../components/run-timeline-context.js';",
        "function bindRunTimelineListeners() { onSSE('run.timeline', onRunTimeline); }",
        'function renderSessionRunTimeline(session) { return renderRunTimelineContextAssembly(session.contextAssembly, esc); }',
      ].join('\n'),
      'web/public/js/pages/system.js': [
        "import { normalizeRunTimelineContextAssembly, renderRunTimelineContextAssembly } from '../components/run-timeline-context.js';",
        "function bindRunTimelineUpdates() { onSSE('run.timeline', runTimelineHandler); }",
        'function renderRuntimeExecutionTimelineItems(items, runId) { return renderRunTimelineContextAssembly(items[0]?.contextAssembly, esc); }',
      ].join('\n'),
      'web/public/js/chat-panel.js': [
        "import { matchesRunTimelineRequest } from './chat-run-tracking.js';",
        "function attachChatTimeline() { onSSE('run.timeline', onRunTimeline); }",
        'function summarizeTimelineRun(run) { return humanizeTimelineStatus(run.status); }',
      ].join('\n'),
      'web/public/js/chat-run-tracking.js': 'export function matchesRunTimelineRequest(detail, expected = {}) { return Boolean(detail && expected); }',
    };
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'fs_read') {
        const path = String(args.path ?? '');
        const content = contentByPath[path] ?? '';
        return {
          success: true,
          status: 'succeeded',
          output: {
            path,
            bytes: content.length,
            content,
          },
        };
      }
      const query = String(args.query ?? '');
      const matches: Array<{ relativePath: string; matchType: string; snippet: string }> = [];
      if (query === 'timeline') {
        matches.push({
          relativePath: 'web/public/js/components/run-timeline-context.js',
          matchType: 'name',
          snippet: 'run-timeline-context.js',
        });
      }
      if (query === 'run-timeline-context.js' || query === 'renderRunTimelineContextAssembly') {
        matches.push(
          {
            relativePath: 'web/public/js/pages/automations.js',
            matchType: 'content',
            snippet: "import { normalizeRunTimelineContextAssembly, renderRunTimelineContextAssembly } from '../components/run-timeline-context.js';",
          },
          {
            relativePath: 'web/public/js/pages/code.js',
            matchType: 'content',
            snippet: "import { normalizeRunTimelineContextAssembly, renderRunTimelineContextAssembly } from '../components/run-timeline-context.js';",
          },
          {
            relativePath: 'web/public/js/pages/system.js',
            matchType: 'content',
            snippet: "import { normalizeRunTimelineContextAssembly, renderRunTimelineContextAssembly } from '../components/run-timeline-context.js';",
          },
        );
      }
      if (query === 'run.timeline') {
        matches.push({
          relativePath: 'web/public/js/chat-panel.js',
          matchType: 'content',
          snippet: "onSSE('run.timeline', onRunTimeline);",
        });
      }
      if (query === 'chat-run-tracking.js' || query === 'matchesRunTimelineRequest') {
        matches.push({
          relativePath: 'web/public/js/chat-run-tracking.js',
          matchType: 'content',
          snippet: 'export function matchesRunTimelineRequest(detail, expected = {}) {',
        });
      }
      return {
        success: true,
        status: 'succeeded',
        output: {
          query,
          matches,
        },
      };
    });
    const traceEntries: Array<Record<string, unknown>> = [];

    const result = await handleDirectReasoningMode({
      message: 'Inspect this repo and tell me which files implement run timeline rendering. Do not edit anything.',
      gateway: gateway({
        operation: 'inspect',
        resolvedContent: 'Inspect this repo and tell me which files implement run timeline rendering. Do not edit anything.',
        requireExactFileReferences: true,
      }),
      selectedExecutionProfile: profile(),
      workspaceRoot: 'S:/Development/GuardianAgent',
      maxTurns: 1,
    }, {
      chat,
      executeTool,
      trace: {
        record: (entry) => traceEntries.push(entry as unknown as Record<string, unknown>),
      },
    });

    expect(result.content).toContain('web/public/js/components/run-timeline-context.js');
    expect(result.content).toContain('web/public/js/pages/automations.js');
    expect(result.content).toContain('web/public/js/pages/code.js');
    expect(result.content).toContain('web/public/js/pages/system.js');
    expect(result.content).toContain('web/public/js/chat-panel.js');
    expect(result.content).toContain('web/public/js/chat-run-tracking.js');
    expect(executeTool).toHaveBeenCalledWith('fs_search', expect.objectContaining({
      query: 'renderRunTimelineContextAssembly',
    }), expect.any(Object));
    expect(executeTool).toHaveBeenCalledWith('fs_search', expect.objectContaining({
      query: 'run.timeline',
    }), expect.any(Object));
    expect(executeTool).toHaveBeenCalledWith('fs_read', expect.objectContaining({
      path: 'web/public/js/chat-run-tracking.js',
    }), expect.any(Object));
    expect(traceEntries.some((entry) => (
      entry.stage === 'direct_reasoning_evidence_hydration'
      && (entry.details as Record<string, unknown> | undefined)?.phase === 'expansion_search_started'
    ))).toBe(true);
  });
});
