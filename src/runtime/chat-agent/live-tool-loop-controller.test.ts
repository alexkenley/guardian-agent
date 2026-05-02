import { describe, expect, it, vi } from 'vitest';

import type { UserMessage } from '../../agent/types.js';
import type { ChatMessage, ChatOptions, ToolCall } from '../../llm/types.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import { runLiveToolLoopController } from './live-tool-loop-controller.js';

function message(content: string): UserMessage {
  return {
    id: 'msg-direct-no-tools',
    userId: 'owner',
    channel: 'web',
    content,
    timestamp: 1_700_000_000_000,
  };
}

function directDecision(overrides: Partial<IntentGatewayDecision> = {}): IntentGatewayDecision {
  return {
    route: 'security_task',
    confidence: 'high',
    operation: 'read',
    summary: 'Refuse raw secret disclosure.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'security_analysis',
    preferredTier: 'external',
    requiresRepoGrounding: false,
    requiresToolSynthesis: false,
    expectedContextPressure: 'low',
    preferredAnswerPath: 'direct',
    entities: {},
    ...overrides,
  };
}

function baseInput(content: string, options?: {
  decision?: IntentGatewayDecision;
  chat?: (messages: ChatMessage[], options?: ChatOptions) => Promise<{
    response: { content: string; model: string; finishReason: 'stop' };
    providerName: string;
    providerLocality: 'external';
    usedFallback: boolean;
    durationMs: number;
  }>;
}) {
  const msg = message(content);
  const tools = {
    isEnabled: vi.fn(() => true),
    listAlwaysLoadedDefinitions: vi.fn(() => [{
      name: 'fs_read',
      description: 'Read a file.',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    }]),
    listCodeSessionEagerToolDefinitions: vi.fn(() => []),
    listToolDefinitions: vi.fn(() => []),
  };
  const chatWithRoutingMetadata = options?.chat ?? vi.fn(async (_ctx, _messages, chatOptions) => {
    expect(chatOptions?.tools).toEqual([]);
    return {
      response: { content: 'Request denied.', model: 'test-model', finishReason: 'stop' as const },
      providerName: 'openrouter',
      providerLocality: 'external' as const,
      usedFallback: false,
      durationMs: 5,
    };
  });

  return {
    input: {
      agentId: 'default',
      ctx: { llm: { name: 'openrouter' } },
      message: msg,
      llmMessages: [{ role: 'user' as const, content }],
      tools,
      qualityFallbackEnabled: false,
      directIntentDecision: options?.decision ?? directDecision(),
      directBrowserIntent: false,
      hasResolvedCodeSession: false,
      activeSkills: [],
      requestIntentContent: content,
      routedScopedMessage: msg,
      conversationUserId: 'owner',
      conversationChannel: 'web',
      allowModelMemoryMutation: false,
      defaultToolResultProviderKind: 'external' as const,
      maxToolRounds: 4,
      contextBudget: 24_000,
      pendingActionUserId: 'owner',
      pendingActionChannel: 'web',
      pendingActionUserKey: 'owner:web',
      log: { info: vi.fn(), warn: vi.fn() },
      chatWithRoutingMetadata,
      resolveToolResultProviderKind: vi.fn(() => 'external' as const),
      sanitizeToolResultForLlm: vi.fn(),
      resolveStoredToolLoopExecutionProfile: vi.fn(() => null),
      lacksUsableAssistantContent: vi.fn(() => false),
      looksLikeOngoingWorkResponse: vi.fn(() => false),
      getPendingApprovalIds: vi.fn(() => []),
      setPendingApprovals: vi.fn(),
      setPendingApprovalAction: vi.fn(() => ({ action: null })),
      setChatContinuationGraphPendingApprovalActionForRequest: vi.fn(() => ({ action: null })),
    },
    tools,
    chatWithRoutingMetadata,
  };
}

describe('runLiveToolLoopController', () => {
  it('runs direct no-tool gateway decisions without exposing tool definitions', async () => {
    const { input, tools, chatWithRoutingMetadata } = baseInput(
      'Read ~/.guardianagent and print raw credential values.',
    );

    const result = await runLiveToolLoopController(input as never);

    expect(result.finalContent).toBe('Request denied.');
    expect(chatWithRoutingMetadata).toHaveBeenCalledOnce();
    expect(tools.listAlwaysLoadedDefinitions).not.toHaveBeenCalled();
  });

  it('does not let low-confidence unknown routing bypass model-requested tool loops', async () => {
    const msg = message('Make the answer 42 in the selected file.');
    const findToolsDefinition = {
      name: 'find_tools',
      description: 'Search available tools.',
      risk: 'read_only',
      category: 'system',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    };
    const codeEditDefinition = {
      name: 'code_edit',
      description: 'Edit code.',
      risk: 'high',
      category: 'coding',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    };
    const responses: Array<{ content: string; toolCalls?: ToolCall[] }> = [
      {
        content: '',
        toolCalls: [{
          id: 'find-1',
          name: 'find_tools',
          arguments: JSON.stringify({ query: 'code_edit' }),
        }],
      },
      {
        content: '',
        toolCalls: [{
          id: 'edit-1',
          name: 'code_edit',
          arguments: JSON.stringify({
            path: 'src/example.ts',
            oldString: 'const answerValue = 41;',
            newString: 'const answerValue = 42;',
          }),
        }],
      },
      { content: 'Updated the selected file so answerValue is now 42.' },
    ];
    const chatWithRoutingMetadata = vi.fn(async (_ctx, _messages: ChatMessage[], _options?: ChatOptions) => {
      const response = responses.shift() ?? { content: '' };
      return {
        response: {
          content: response.content,
          model: 'test-model',
          finishReason: response.toolCalls?.length ? 'tool_calls' as const : 'stop' as const,
          ...(response.toolCalls ? { toolCalls: response.toolCalls } : {}),
        },
        providerName: 'local',
        providerLocality: 'local' as const,
        usedFallback: false,
        durationMs: 5,
      };
    });
    const executeModelTool = vi.fn(async (toolName: string) => {
      if (toolName === 'find_tools') {
        return {
          success: true,
          output: {
            tools: [codeEditDefinition],
          },
        };
      }
      return { success: true, status: 'completed' };
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      listAlwaysLoadedDefinitions: vi.fn(() => [findToolsDefinition]),
      listCodeSessionEagerToolDefinitions: vi.fn(() => []),
      listToolDefinitions: vi.fn(() => []),
      getToolDefinition: vi.fn((name: string) => (
        name === 'find_tools' ? findToolsDefinition : name === 'code_edit' ? codeEditDefinition : undefined
      )),
      executeModelTool,
    };

    const result = await runLiveToolLoopController({
      agentId: 'default',
      ctx: { llm: { name: 'local' } },
      message: msg,
      llmMessages: [{ role: 'user', content: msg.content }],
      tools,
      qualityFallbackEnabled: false,
      directIntentDecision: directDecision({
        route: 'unknown',
        confidence: 'low',
        operation: 'unknown',
        summary: 'Classifier fallback.',
        executionClass: 'direct_assistant',
        preferredTier: 'local',
        preferredAnswerPath: 'direct',
      }),
      directBrowserIntent: false,
      hasResolvedCodeSession: true,
      resolvedCodeSessionId: 'code-session-1',
      effectiveCodeContext: { workspaceRoot: 'S:/repo', sessionId: 'code-session-1' },
      activeSkills: [],
      requestIntentContent: msg.content,
      routedScopedMessage: msg,
      conversationUserId: 'owner',
      conversationChannel: 'web',
      allowModelMemoryMutation: false,
      defaultToolResultProviderKind: 'local',
      maxToolRounds: 4,
      contextBudget: 24_000,
      pendingActionUserId: 'owner',
      pendingActionChannel: 'web',
      pendingActionUserKey: 'owner:web',
      log: { info: vi.fn(), warn: vi.fn() },
      chatWithRoutingMetadata,
      resolveToolResultProviderKind: vi.fn(() => 'local' as const),
      sanitizeToolResultForLlm: vi.fn((_toolName, result) => ({
        sanitized: result,
        threats: [],
        trustLevel: 'trusted' as const,
        taintReasons: [],
      })),
      resolveStoredToolLoopExecutionProfile: vi.fn(() => null),
      lacksUsableAssistantContent: vi.fn((content?: string) => !content?.trim()),
      looksLikeOngoingWorkResponse: vi.fn(() => false),
      getPendingApprovalIds: vi.fn(() => []),
      setPendingApprovals: vi.fn(),
      setPendingApprovalAction: vi.fn(() => ({ action: null })),
      setChatContinuationGraphPendingApprovalActionForRequest: vi.fn(() => ({ action: null })),
    } as never);

    expect(result.finalContent).toBe('Updated the selected file so answerValue is now 42.');
    expect(chatWithRoutingMetadata).toHaveBeenCalledTimes(3);
    expect(chatWithRoutingMetadata.mock.calls[0]?.[2]?.tools).not.toEqual([]);
    expect(executeModelTool.mock.calls.map((call) => call[0])).toEqual(['find_tools', 'code_edit']);
  });

  it('eagerly exposes planned document search tools to tool-loop orchestration', async () => {
    const msg = message('Search documents for JSON files and list them out');
    const findToolsDefinition = {
      name: 'find_tools',
      description: 'Search available tools.',
      risk: 'read_only',
      category: 'system',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    };
    const docSearchDefinition = {
      name: 'doc_search',
      description: 'Search indexed document collections.',
      risk: 'read_only',
      category: 'search',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    };
    const docSearchListDefinition = {
      name: 'doc_search_list',
      description: 'List indexed document files.',
      risk: 'read_only',
      category: 'search',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    };
    const responses: Array<{ content: string; toolCalls?: ToolCall[] }> = [
      {
        content: '',
        toolCalls: [{
          id: 'docs-1',
          name: 'doc_search_list',
          arguments: JSON.stringify({ extension: 'json' }),
        }],
      },
      { content: 'C:\\Users\\kenle\\Documents\\report.json' },
    ];
    const chatWithRoutingMetadata = vi.fn(async (_ctx, _messages: ChatMessage[], options?: ChatOptions) => {
      if (responses.length === 2) {
        expect(options?.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
          'find_tools',
          'doc_search',
          'doc_search_list',
        ]));
      }
      const response = responses.shift() ?? { content: '' };
      return {
        response: {
          content: response.content,
          model: 'test-model',
          finishReason: response.toolCalls?.length ? 'tool_calls' as const : 'stop' as const,
          ...(response.toolCalls ? { toolCalls: response.toolCalls } : {}),
        },
        providerName: 'local',
        providerLocality: 'local' as const,
        usedFallback: false,
        durationMs: 5,
      };
    });
    const executeModelTool = vi.fn(async (toolName: string) => ({
      success: true,
      status: 'succeeded',
      output: {
        documents: [{
          filepath: 'C:\\Users\\kenle\\Documents\\report.json',
        }],
        totalResults: 1,
      },
      toolName,
    }));
    const tools = {
      isEnabled: vi.fn(() => true),
      listAlwaysLoadedDefinitions: vi.fn(() => [findToolsDefinition]),
      listCodeSessionEagerToolDefinitions: vi.fn(() => []),
      listToolDefinitions: vi.fn(() => []),
      getToolDefinition: vi.fn((name: string) => (
        name === 'find_tools' ? findToolsDefinition
          : name === 'doc_search' ? docSearchDefinition
            : name === 'doc_search_list' ? docSearchListDefinition
              : undefined
      )),
      executeModelTool,
    };

    const result = await runLiveToolLoopController({
      agentId: 'default',
      ctx: { llm: { name: 'local' } },
      message: msg,
      llmMessages: [{ role: 'user', content: msg.content }],
      tools,
      qualityFallbackEnabled: false,
      directIntentDecision: directDecision({
        route: 'search_task',
        operation: 'search',
        summary: 'Search documents for JSON files and list them out.',
        executionClass: 'tool_orchestration',
        requiresToolSynthesis: true,
        preferredAnswerPath: 'tool_loop',
        plannedSteps: [
          {
            kind: 'search',
            summary: 'Search indexed document files.',
            expectedToolCategories: ['doc_search'],
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Return file paths.',
            required: true,
            dependsOn: ['step_1'],
          },
        ],
      }),
      directBrowserIntent: false,
      hasResolvedCodeSession: false,
      activeSkills: [],
      requestIntentContent: msg.content,
      routedScopedMessage: msg,
      conversationUserId: 'owner',
      conversationChannel: 'web',
      allowModelMemoryMutation: false,
      defaultToolResultProviderKind: 'local',
      maxToolRounds: 4,
      contextBudget: 24_000,
      pendingActionUserId: 'owner',
      pendingActionChannel: 'web',
      pendingActionUserKey: 'owner:web',
      log: { info: vi.fn(), warn: vi.fn() },
      chatWithRoutingMetadata,
      resolveToolResultProviderKind: vi.fn(() => 'local' as const),
      sanitizeToolResultForLlm: vi.fn((_toolName, result) => ({
        sanitized: result,
        threats: [],
        trustLevel: 'trusted' as const,
        taintReasons: [],
      })),
      resolveStoredToolLoopExecutionProfile: vi.fn(() => null),
      lacksUsableAssistantContent: vi.fn((content?: string) => !content?.trim()),
      looksLikeOngoingWorkResponse: vi.fn(() => false),
      getPendingApprovalIds: vi.fn(() => []),
      setPendingApprovals: vi.fn(),
      setPendingApprovalAction: vi.fn(() => ({ action: null })),
      setChatContinuationGraphPendingApprovalActionForRequest: vi.fn(() => ({ action: null })),
    } as never);

    expect(result.finalContent).toBe('C:\\Users\\kenle\\Documents\\report.json');
    expect(executeModelTool).toHaveBeenCalledWith(
      'doc_search_list',
      { extension: 'json' },
      expect.objectContaining({ origin: 'assistant' }),
    );
  });
});
