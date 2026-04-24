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
      'direct_reasoning_tool_call',
      'direct_reasoning_tool_call',
      'direct_reasoning_synthesis_started',
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
    expect(graphEvents.map((entry) => entry.kind)).toEqual([
      'graph_started',
      'node_started',
      'tool_call_started',
      'tool_call_completed',
      'llm_call_started',
      'llm_call_completed',
      'node_completed',
      'graph_completed',
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

  it('bounds broad direct fs_search calls to a repo subdirectory', async () => {
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
      path: 'src',
      maxResults: 40,
      maxDepth: 12,
      maxFiles: 2500,
      maxFileBytes: 40000,
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
    expect(recoveryPrompt).toContain('Evidence gathered');
    expect(recoveryPrompt).toContain('executeDirectReasoningToolCall');
    expect(recoveryPrompt.length).toBeLessThan(30_000);
    expect(traceEntries.map((entry) => entry.stage)).toContain('direct_reasoning_synthesis_started');
    expect(traceEntries.map((entry) => entry.stage)).toContain('direct_reasoning_synthesis_completed');
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
});
