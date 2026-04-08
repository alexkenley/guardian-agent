import { describe, expect, it, vi } from 'vitest';
import type { AgentContext, UserMessage } from './agent/types.js';
import { createChatAgentClass } from './chat-agent.js';
import { ContinuityThreadStore } from './runtime/continuity-threads.js';
import { attachSelectedExecutionProfileMetadata } from './runtime/execution-profiles.js';
import type { PendingActionRecord } from './runtime/pending-actions.js';

describe('LLMChatAgent direct intent metadata', () => {
  it('backfills responseSource for direct intent responses so the UI does not show them as system output', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    const message: UserMessage = {
      id: 'msg-1',
      userId: 'owner',
      channel: 'web',
      content: 'Search the repo for "ollama_cloud" and tell me which files define its routing.',
      timestamp: Date.now(),
      metadata: attachSelectedExecutionProfileMetadata(undefined, {
        id: 'managed_cloud_direct',
        providerName: 'ollama-cloud-general',
        providerType: 'ollama_cloud',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'direct',
        expectedContextPressure: 'low',
        contextBudget: 80000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['ollama-cloud-general'],
        reason: 'managed-cloud role binding',
      }),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama_cloud' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const response = await (agent as any).buildDirectIntentResponse({
      candidate: 'filesystem',
      result: 'I searched "S:\\Development\\GuardianAgent" for "ollama_cloud".',
      message,
      routingMessage: message,
      intentGateway: {
        available: true,
        decision: {
          route: 'coding_task',
          operation: 'search',
          summary: 'Search the repo.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {},
        },
      },
      ctx,
      activeSkills: [],
      conversationKey: { userId: 'owner', channel: 'web' },
    });

    expect(response.metadata?.responseSource).toMatchObject({
      locality: 'external',
      providerName: 'ollama_cloud',
      providerProfileName: 'ollama-cloud-general',
      providerTier: 'managed_cloud',
      usedFallback: false,
    });
  });

  it('tags direct Second Brain responses as Second Brain instead of the selected managed-cloud profile', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    const message: UserMessage = {
      id: 'msg-2',
      userId: 'owner',
      channel: 'web',
      content: 'Give me a concise plan for organizing my week.',
      timestamp: Date.now(),
      metadata: attachSelectedExecutionProfileMetadata(undefined, {
        id: 'managed_cloud_direct',
        providerName: 'ollama-cloud-direct',
        providerType: 'ollama_cloud',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'direct',
        expectedContextPressure: 'low',
        contextBudget: 24000,
        toolContextMode: 'tight',
        maxAdditionalSections: 1,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['ollama-cloud-direct'],
        reason: 'managed-cloud direct role binding',
      }),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama_cloud' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const response = await (agent as any).buildDirectIntentResponse({
      candidate: 'personal_assistant',
      result: 'Second Brain overview:\n- Top tasks: Test',
      message,
      routingMessage: message,
      intentGateway: {
        available: true,
        decision: {
          route: 'personal_assistant_task',
          operation: 'read',
          summary: 'Reads the Second Brain overview.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: { personalItemType: 'overview' },
        },
      },
      ctx,
      activeSkills: [],
      conversationKey: { userId: 'owner', channel: 'web' },
    });

    expect(response.metadata?.responseSource).toMatchObject({
      locality: 'local',
      providerName: 'second_brain',
      usedFallback: false,
    });
    expect(response.metadata?.responseSource).not.toMatchObject({
      providerProfileName: 'ollama-cloud-direct',
      providerTier: 'managed_cloud',
    });
  });

  it('formats direct provider inventory reads through provider tools instead of falling through to the worker', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string) => {
        expect(toolName).toBe('llm_provider_list');
        return {
          success: true,
          output: {
            providerCount: 2,
            providers: [
              {
                name: 'ollama',
                type: 'ollama',
                model: 'gemma4:26b',
                tier: 'local',
                connected: true,
                isPreferredLocal: true,
              },
              {
                name: 'ollama-cloud-tools',
                type: 'ollama_cloud',
                model: 'glm-4.7',
                tier: 'managed_cloud',
                connected: true,
                isPreferredManagedCloud: true,
              },
            ],
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getPersonById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama_cloud' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await (agent as any).tryDirectProviderRead(
      {
        id: 'msg-provider-list',
        userId: 'owner',
        channel: 'web',
        content: 'List my configured AI providers.',
        timestamp: Date.now(),
      },
      ctx,
      {
        route: 'general_assistant',
        operation: 'read',
        confidence: 'high',
        summary: 'Lists configured AI providers.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'provider_crud',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
        entities: { uiSurface: 'config' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Configured AI providers:');
    expect(content).toContain('ollama [local · ollama] model gemma4:26b');
    expect(content).toContain('ollama-cloud-tools [managed cloud · ollama_cloud] model glm-4.7');
  });

  it('reuses persisted paged-list continuation state for follow-up automation catalog requests', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const continuityThreadStore = new ContinuityThreadStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-continuity.test.sqlite',
      retentionDays: 30,
      now: () => 1_710_000_000_000,
    });
    const automations = Array.from({ length: 45 }, (_, index) => {
      const ordinal = index + 1;
      return {
        id: `automation-${ordinal}`,
        name: `Automation ${ordinal}`,
        kind: 'assistant_task',
        enabled: true,
        task: {
          id: `automation-${ordinal}`,
          name: `Automation ${ordinal}`,
          type: 'agent',
          target: 'default',
          cron: `${ordinal % 60} 8 * * 1-5`,
          enabled: true,
          createdAt: ordinal,
        },
      };
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string) => {
        if (toolName === 'automation_list') {
          return {
            success: true,
            output: { automations },
          };
        }
        throw new Error(`Unexpected tool ${toolName}`);
      }),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).continuityThreadStore = continuityThreadStore;
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const firstMessage: UserMessage = {
      id: 'msg-1',
      userId: 'code-session:session-1',
      channel: 'web',
      content: 'List my automations.',
      timestamp: Date.now(),
    };
    const secondMessage: UserMessage = {
      id: 'msg-2',
      userId: 'code-session:session-1',
      channel: 'web',
      content: 'Can you list the additional 25 automations?',
      timestamp: Date.now(),
    };

    const firstResponse = await (agent as any).tryDirectAutomationControl(
      firstMessage,
      ctx,
      'owner:web',
      {
        route: 'automation_control',
        confidence: 'high',
        operation: 'read',
        turnRelation: 'new_request',
        resolution: 'ready',
        summary: 'List the automation catalog.',
        missingFields: [],
        entities: {},
      },
      continuityThreadStore.get({ assistantId: 'chat', userId: 'owner' }),
    );
    expect(firstResponse?.content).toContain('Automation catalog (45): showing 1-20');
    expect(firstResponse?.metadata?.continuationState).toEqual({
      kind: 'automation_catalog_list',
      payload: { offset: 0, limit: 20, total: 45 },
    });

    const secondResponse = await (agent as any).tryDirectAutomationControl(
      secondMessage,
      ctx,
      'owner:web',
      {
        route: 'automation_control',
        confidence: 'high',
        operation: 'read',
        turnRelation: 'follow_up',
        resolution: 'ready',
        summary: 'List more automations.',
        missingFields: [],
        entities: {},
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'automation_catalog_list',
          payload: { offset: 0, limit: 20, total: 45 },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect(secondResponse?.content).toContain('Automation catalog (45): showing 21-45');
    expect(secondResponse?.content).toContain('Automation 25');
    expect(secondResponse?.content).toContain('Automation 1');
    expect(secondResponse?.content).not.toContain('Automation 45');
    expect(secondResponse?.metadata?.continuationState).toEqual({
      kind: 'automation_catalog_list',
      payload: { offset: 20, limit: 25, total: 45 },
    });
  });

  it('persists shared direct continuation state on the surface scope instead of the code-session scope', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    const updateDirectContinuationState = vi
      .spyOn(agent as any, 'updateDirectContinuationState')
      .mockReturnValue(null);
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const message: UserMessage = {
      id: 'msg-1',
      userId: 'code-session:session-1',
      channel: 'code-session',
      surfaceId: 'web-guardian-chat',
      content: 'List my automations.',
      timestamp: Date.now(),
    };

    const response = await (agent as any).buildDirectIntentResponse({
      candidate: 'automation_control',
      result: {
        content: 'Automation catalog (45): showing 1-20',
        metadata: {
          continuationState: {
            kind: 'automation_catalog_list',
            payload: { offset: 0, limit: 20, total: 45 },
          },
        },
      },
      message,
      routingMessage: message,
      intentGateway: {
        available: true,
        decision: {
          route: 'automation_control',
          operation: 'read',
          summary: 'List the automation catalog.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {},
        },
      },
      ctx,
      activeSkills: [],
      conversationKey: { userId: 'owner', channel: 'web' },
      surfaceUserId: 'owner',
      surfaceChannel: 'web',
      surfaceId: 'web-guardian-chat',
    });

    expect(response.metadata?.continuationState).toBeUndefined();
    expect(updateDirectContinuationState).toHaveBeenCalledWith(
      'owner',
      'web',
      'web-guardian-chat',
      {
        kind: 'automation_catalog_list',
        payload: { offset: 0, limit: 20, total: 45 },
      },
    );
    expect(updateDirectContinuationState).not.toHaveBeenCalledWith(
      'code-session:session-1',
      'code-session',
      'web-guardian-chat',
      {
        kind: 'automation_catalog_list',
        payload: { offset: 0, limit: 20, total: 45 },
      },
    );
  });

  it('continues Gmail unread lists from the prior window on follow-up requests', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        if (args.method === 'list') {
          return {
            success: true,
            output: {
              messages: Array.from({ length: 5 }, (_, index) => ({ id: `gmail-${index + 1}` })),
              resultSizeEstimate: 5,
            },
          };
        }
        if (args.method === 'get') {
          const params = args.params as Record<string, unknown>;
          const id = String(params.messageId ?? params.id);
          const ordinal = Number(id.split('-').pop() ?? '0');
          return {
            success: true,
            output: {
              payload: {
                headers: [
                  { name: 'From', value: `Sender ${ordinal} <sender${ordinal}@example.com>` },
                  { name: 'Subject', value: `Subject ${ordinal}` },
                  { name: 'Date', value: `2026-04-0${ordinal}T08:00:00Z` },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected tool args ${JSON.stringify(args)}`);
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getPersonById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const response = await (agent as any).tryDirectGoogleWorkspaceRead(
      {
        id: 'msg-gmail',
        userId: 'owner',
        channel: 'web',
        content: 'Show me the additional 2 emails.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'email_task',
        confidence: 'high',
        operation: 'read',
        turnRelation: 'follow_up',
        resolution: 'ready',
        summary: 'Show more unread Gmail messages.',
        missingFields: [],
        entities: { emailProvider: 'gmail' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'gmail_unread_list',
          payload: { offset: 0, limit: 3, total: 5 },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    const content = typeof response === 'string' ? response : response?.content ?? '';
    expect(content).toContain('Subject 4');
    expect(content).toContain('Subject 5');
    expect(content).not.toContain('Subject 1');
    expect(content).not.toContain('Subject 2');
    expect(content).not.toContain('Subject 3');
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'gws',
      expect.objectContaining({
        method: 'list',
        params: expect.objectContaining({ maxResults: 5 }),
      }),
      expect.anything(),
    );
  });

  it('returns no additional Gmail messages when a natural follow-up exceeds the prior window', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        if (args.method === 'list') {
          return {
            success: true,
            output: {
              messages: [{ id: 'gmail-1' }],
              resultSizeEstimate: 1,
            },
          };
        }
        if (args.method === 'get') {
          return {
            success: true,
            output: {
              payload: {
                headers: [
                  { name: 'From', value: 'Sender 1 <sender1@example.com>' },
                  { name: 'Subject', value: 'Subject 1' },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected tool args ${JSON.stringify(args)}`);
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getPersonById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const response = await (agent as any).tryDirectGoogleWorkspaceRead(
      {
        id: 'msg-gmail-2',
        userId: 'owner',
        channel: 'web',
        content: 'Show me 2 more emails.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'email_task',
        confidence: 'high',
        operation: 'read',
        turnRelation: 'new_request',
        resolution: 'ready',
        summary: 'Show more unread Gmail messages.',
        missingFields: [],
        entities: { emailProvider: 'gmail' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'gmail_unread_list',
          payload: { offset: 0, limit: 1, total: 1 },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect(response).toBe('No additional Gmail messages remain.');
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'gws',
      expect.objectContaining({
        method: 'list',
        params: expect.objectContaining({ maxResults: 2 }),
      }),
      expect.anything(),
    );
  });

  it('uses the gateway mailbox read mode to list the latest Gmail inbox messages', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        if (args.method === 'list') {
          return {
            success: true,
            output: {
              messages: Array.from({ length: 5 }, (_, index) => ({ id: `gmail-latest-${index + 1}` })),
              resultSizeEstimate: 5,
            },
          };
        }
        if (args.method === 'get') {
          const params = args.params as Record<string, unknown>;
          const id = String(params.messageId ?? params.id);
          const ordinal = Number(id.split('-').pop() ?? '0');
          return {
            success: true,
            output: {
              payload: {
                headers: [
                  { name: 'From', value: `Sender ${ordinal} <sender${ordinal}@example.com>` },
                  { name: 'Subject', value: `Latest Subject ${ordinal}` },
                  { name: 'Date', value: `2026-04-0${ordinal}T08:00:00Z` },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected tool args ${JSON.stringify(args)}`);
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getPersonById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const response = await (agent as any).tryDirectGoogleWorkspaceRead(
      {
        id: 'msg-gmail-latest',
        userId: 'owner',
        channel: 'web',
        content: 'Can you show me the newest five emails in Gmail?',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'email_task',
        confidence: 'high',
        operation: 'read',
        turnRelation: 'new_request',
        resolution: 'ready',
        summary: 'Shows the latest Gmail inbox messages.',
        missingFields: [],
        executionClass: 'provider_crud',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
        entities: { emailProvider: 'gws', mailboxReadMode: 'latest' },
      },
      null,
    );

    const content = typeof response === 'string' ? response : response?.content ?? '';
    expect(content).toContain('Here are the last 5 emails:');
    expect(content).toContain('Latest Subject 1');
    expect(content).toContain('Latest Subject 5');
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'gws',
      expect.objectContaining({
        method: 'list',
        params: expect.not.objectContaining({ q: 'is:unread' }),
      }),
      expect.anything(),
    );
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'gws',
      expect.objectContaining({
        method: 'get',
        params: expect.objectContaining({ messageId: 'gmail-latest-1' }),
      }),
      expect.anything(),
    );
  });

  it('formats direct Second Brain library reads as library items instead of falling back to overview', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listLinks: vi.fn(() => [{
        id: 'link-1',
        title: 'Example Reference',
        kind: 'reference',
        url: 'https://example.com/',
        summary: 'Library smoke test URL',
      }]),
    };

    const result = await (agent as any).tryDirectSecondBrainRead(
      {
        id: 'msg-library',
        userId: 'owner',
        channel: 'web',
        content: 'Show my library items.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads Second Brain library items.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'library' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Library items:');
    expect(content).toContain('Example Reference [reference] - https://example.com/');
    expect(content).not.toContain('Second Brain overview:');
  });

  it('formats direct Second Brain brief reads as saved briefs instead of falling back to overview', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listBriefs: vi.fn(() => [{
        id: 'brief-1',
        kind: 'manual',
        title: 'Second Brain brief smoke test',
        content: 'This is a brief for smoke testing.',
        generatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      }]),
    };

    const result = await (agent as any).tryDirectSecondBrainRead(
      {
        id: 'msg-briefs',
        userId: 'owner',
        channel: 'web',
        content: 'Show my briefs.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads saved Second Brain briefs.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'brief' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Saved briefs:');
    expect(content).toContain('Second Brain brief smoke test [Manual]');
    expect(content).not.toContain('Second Brain overview:');
  });

  it('returns an explicit empty state for disabled Second Brain routine reads', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listRoutines: vi.fn(() => [{
        id: 'morning-brief',
        name: 'Morning Brief',
        category: 'scheduled',
        enabledByDefault: true,
        enabled: true,
        trigger: { mode: 'cron', cron: '0 7 * * *' },
        workloadClass: 'B',
        externalCommMode: 'none',
        budgetProfileId: 'daily-low',
        deliveryDefaults: ['web'],
        defaultRoutingBias: 'local_first',
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        lastRunAt: null,
      }]),
      listRoutineCatalog: vi.fn(() => []),
    };

    const result = await (agent as any).tryDirectSecondBrainRead(
      {
        id: 'msg-routines-disabled',
        userId: 'owner',
        channel: 'web',
        content: 'Show only my disabled routines.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads disabled routines.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine', enabled: false },
      },
    );

    expect(result).toBe('Second Brain has no disabled routines.');
  });

  it('filters direct Second Brain routines by topical query', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listRoutines: vi.fn(() => [
        {
          id: 'follow-up-watch',
          name: 'Follow-Up Watch',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
          workloadClass: 'B',
          externalCommMode: 'draft_only',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
        {
          id: 'morning-brief',
          name: 'Morning Brief',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'cron', cron: '0 7 * * *' },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'local_first',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
      ]),
      listRoutineCatalog: vi.fn(() => [
        {
          templateId: 'follow-up-watch',
          name: 'Follow-Up Watch',
          description: 'Drafts follow-up packets for recently ended meetings that do not already have one.',
          category: 'follow_up',
          seedByDefault: false,
          manifest: {
            id: 'follow-up-watch',
            name: 'Follow-Up Watch',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
            workloadClass: 'B',
            externalCommMode: 'draft_only',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
          },
          configured: true,
          configuredRoutineId: 'follow-up-watch',
        },
        {
          templateId: 'morning-brief',
          name: 'Morning Brief',
          description: 'Creates the daily morning brief after the local workday starts.',
          category: 'daily',
          seedByDefault: true,
          manifest: {
            id: 'morning-brief',
            name: 'Morning Brief',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'cron', cron: '0 7 * * *' },
            workloadClass: 'B',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'local_first',
          },
          configured: true,
          configuredRoutineId: 'morning-brief',
        },
      ]),
    };

    const result = await (agent as any).tryDirectSecondBrainRead(
      {
        id: 'msg-routines-email',
        userId: 'owner',
        channel: 'web',
        content: 'What routines are related to email or inbox processing?',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads routines related to email.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine', query: 'email or inbox processing' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Second Brain routines related to "email inbox":');
    expect(content).toContain('Follow-Up Watch');
    expect(content).not.toContain('Morning Brief');
    expect(content).not.toContain('Second Brain overview:');
  });

  it('keeps meeting prep routine retrieval scoped to the pre-meeting routine', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listRoutines: vi.fn(() => [
        {
          id: 'follow-up-watch',
          name: 'Follow-Up Watch',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
          workloadClass: 'B',
          externalCommMode: 'draft_only',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
        {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 90 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web', 'telegram'],
          defaultRoutingBias: 'quality_first',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
      ]),
      listRoutineCatalog: vi.fn(() => [
        {
          templateId: 'follow-up-watch',
          name: 'Follow-Up Watch',
          description: 'Drafts follow-up packets for recently ended meetings that do not already have one.',
          category: 'follow_up',
          seedByDefault: false,
          manifest: {
            id: 'follow-up-watch',
            name: 'Follow-Up Watch',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
            workloadClass: 'B',
            externalCommMode: 'draft_only',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
          },
          configured: true,
          configuredRoutineId: 'follow-up-watch',
        },
        {
          templateId: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
          category: 'meeting',
          seedByDefault: false,
          manifest: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 90 },
            workloadClass: 'B',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web', 'telegram'],
            defaultRoutingBias: 'quality_first',
          },
          configured: true,
          configuredRoutineId: 'pre-meeting-brief',
        },
      ]),
    };

    const result = await (agent as any).tryDirectSecondBrainRead(
      {
        id: 'msg-routines-meeting-prep',
        userId: 'owner',
        channel: 'web',
        content: 'Show only my enabled routines related to meeting prep.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads routines related to meeting prep.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine', enabled: true, query: 'meeting prep' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Enabled Second Brain routines related to "meeting prep":');
    expect(content).toContain('Pre-Meeting Brief');
    expect(content).not.toContain('Follow-Up Watch');
  });

  it('keeps follow up routine retrieval scoped to follow-up routines', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listRoutines: vi.fn(() => [
        {
          id: 'follow-up-watch',
          name: 'Follow-Up Watch',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
          workloadClass: 'B',
          externalCommMode: 'draft_only',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
        {
          id: 'next-24-hours-radar',
          name: 'Next 24 Hours Radar',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'horizon', lookaheadMinutes: 1440 },
          workloadClass: 'A',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'local_first',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
        {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 90 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web', 'telegram'],
          defaultRoutingBias: 'quality_first',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
      ]),
      listRoutineCatalog: vi.fn(() => [
        {
          templateId: 'follow-up-watch',
          name: 'Follow-Up Watch',
          description: 'Drafts follow-up packets for recently ended meetings that do not already have one.',
          category: 'follow_up',
          seedByDefault: false,
          manifest: {
            id: 'follow-up-watch',
            name: 'Follow-Up Watch',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
            workloadClass: 'B',
            externalCommMode: 'draft_only',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
          },
          configured: true,
          configuredRoutineId: 'follow-up-watch',
        },
        {
          templateId: 'next-24-hours-radar',
          name: 'Next 24 Hours Radar',
          description: 'Marks the horizon scan when upcoming events or open tasks make the next day worth reviewing.',
          category: 'daily',
          seedByDefault: false,
          manifest: {
            id: 'next-24-hours-radar',
            name: 'Next 24 Hours Radar',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'horizon', lookaheadMinutes: 1440 },
            workloadClass: 'A',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'local_first',
          },
          configured: true,
          configuredRoutineId: 'next-24-hours-radar',
        },
        {
          templateId: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
          category: 'meeting',
          seedByDefault: false,
          manifest: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 90 },
            workloadClass: 'B',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web', 'telegram'],
            defaultRoutingBias: 'quality_first',
          },
          configured: true,
          configuredRoutineId: 'pre-meeting-brief',
        },
      ]),
    };

    const result = await (agent as any).tryDirectSecondBrainRead(
      {
        id: 'msg-routines-follow-up',
        userId: 'owner',
        channel: 'web',
        content: 'Show only my enabled routines related to follow up.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads routines related to follow up.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine', enabled: true, query: 'follow up' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Enabled Second Brain routines related to "follow up":');
    expect(content).toContain('Follow-Up Watch');
    expect(content).not.toContain('Next 24 Hours Radar');
    expect(content).not.toContain('Pre-Meeting Brief');
  });

  it('returns routine focus metadata for direct Second Brain routine reads', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listRoutines: vi.fn(() => [
        {
          id: 'follow-up-watch',
          name: 'Follow-Up Watch',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
          workloadClass: 'B',
          externalCommMode: 'draft_only',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
        {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
      ]),
      listRoutineCatalog: vi.fn(() => [
        {
          templateId: 'follow-up-watch',
          name: 'Follow-Up Watch',
          description: 'Drafts follow-up packets for recently ended meetings that do not already have one.',
          category: 'follow_up',
          seedByDefault: false,
          manifest: {
            id: 'follow-up-watch',
            name: 'Follow-Up Watch',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
            workloadClass: 'B',
            externalCommMode: 'draft_only',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
          },
          configured: true,
          configuredRoutineId: 'follow-up-watch',
        },
        {
          templateId: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
          category: 'meeting',
          seedByDefault: false,
          manifest: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
            workloadClass: 'B',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
          },
          configured: true,
          configuredRoutineId: 'pre-meeting-brief',
        },
      ]),
    };

    const result = await (agent as any).tryDirectSecondBrainRead(
      {
        id: 'msg-routines-focus',
        userId: 'owner',
        channel: 'web',
        content: 'Show my routines.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads Second Brain routines.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'routine',
            itemType: 'routine',
            focusId: 'pre-meeting-brief',
            items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
            byType: {
              routine: {
                focusId: 'pre-meeting-brief',
                items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toContain('Second Brain routines:');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'routine',
        itemType: 'routine',
        focusId: 'pre-meeting-brief',
      },
    });
  });

  it('disables the focused Second Brain routine directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_routine_update');
        expect(args).toMatchObject({
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          enabled: false,
          defaultRoutingBias: 'balanced',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
        });
        return {
          success: true,
          output: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [
        {
          templateId: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
          category: 'meeting',
          seedByDefault: false,
          manifest: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
            category: 'scheduled',
            enabledByDefault: true,
            trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
            workloadClass: 'B',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
          },
          configured: true,
          configuredRoutineId: 'pre-meeting-brief',
        },
      ]),
      listRoutines: vi.fn(() => [
        {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          enabled: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
          createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
          lastRunAt: null,
        },
      ]),
      getRoutineById: vi.fn((id: string) => id === 'pre-meeting-brief'
        ? {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
            category: 'scheduled',
            enabledByDefault: true,
            enabled: true,
            trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
            workloadClass: 'B',
            externalCommMode: 'none',
            budgetProfileId: 'daily-low',
            deliveryDefaults: ['web'],
            defaultRoutingBias: 'balanced',
            createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
            updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
            lastRunAt: null,
          }
        : null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await (agent as any).tryDirectSecondBrainWrite(
      {
        id: 'msg-routine-disable',
        userId: 'owner',
        channel: 'web',
        content: 'Disable that routine.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'toggle',
        confidence: 'high',
        summary: 'Disables the focused routine.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine', enabled: false },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'routine',
            itemType: 'routine',
            focusId: 'pre-meeting-brief',
            items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
            byType: {
              routine: {
                focusId: 'pre-meeting-brief',
                items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect((result as { content: string }).content).toBe('Routine updated: Pre-Meeting Brief');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'routine',
        itemType: 'routine',
        focusId: 'pre-meeting-brief',
      },
    });
  });

  it('updates focused Second Brain routine settings directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_routine_update');
        expect(args).toMatchObject({
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          enabled: true,
          defaultRoutingBias: 'quality_first',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web', 'telegram'],
          trigger: {
            mode: 'event',
            eventType: 'upcoming_event',
            lookaheadMinutes: 90,
          },
        });
        return {
          success: true,
          output: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const routineRecord = {
      id: 'pre-meeting-brief',
      name: 'Pre-Meeting Brief',
      category: 'scheduled',
      enabledByDefault: true,
      enabled: true,
      trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
      workloadClass: 'B',
      externalCommMode: 'none',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['web'],
      defaultRoutingBias: 'balanced',
      createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      lastRunAt: null,
    };
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'pre-meeting-brief',
        name: 'Pre-Meeting Brief',
        description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
        category: 'meeting',
        seedByDefault: false,
        manifest: {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
        },
        configured: true,
        configuredRoutineId: 'pre-meeting-brief',
      }]),
      listRoutines: vi.fn(() => [routineRecord]),
      getRoutineById: vi.fn(() => routineRecord),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await (agent as any).tryDirectSecondBrainWrite(
      {
        id: 'msg-routine-settings',
        userId: 'owner',
        channel: 'web',
        content: 'Update that routine to use the quality_first routing bias, deliver on web and telegram, and use a 90 minute lookahead window.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates routine settings.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'routine',
            itemType: 'routine',
            focusId: 'pre-meeting-brief',
            items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
            byType: {
              routine: {
                focusId: 'pre-meeting-brief',
                items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect((result as { content: string }).content).toBe('Routine updated: Pre-Meeting Brief');
  });

  it('canonicalizes legacy routine event trigger values before lookahead updates', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_routine_update');
        expect(args).toMatchObject({
          id: 'pre-meeting-brief',
          trigger: {
            mode: 'event',
            eventType: 'upcoming_event',
            lookaheadMinutes: 90,
          },
        });
        return {
          success: true,
          output: {
            id: 'pre-meeting-brief',
            name: 'Pre-Meeting Brief',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const routineRecord = {
      id: 'pre-meeting-brief',
      name: 'Pre-Meeting Brief',
      category: 'scheduled',
      enabledByDefault: true,
      enabled: true,
      trigger: { mode: 'event', eventType: 'upcoming-event', lookaheadMinutes: 60 },
      workloadClass: 'B',
      externalCommMode: 'none',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['web'],
      defaultRoutingBias: 'balanced',
      createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      lastRunAt: null,
    };
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'pre-meeting-brief',
        name: 'Pre-Meeting Brief',
        description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
        category: 'meeting',
        seedByDefault: false,
        manifest: {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
        },
        configured: true,
        configuredRoutineId: 'pre-meeting-brief',
      }]),
      listRoutines: vi.fn(() => [routineRecord]),
      getRoutineById: vi.fn(() => routineRecord),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await (agent as any).tryDirectSecondBrainWrite(
      {
        id: 'msg-routine-legacy-lookahead',
        userId: 'owner',
        channel: 'web',
        content: 'Update that routine to use a 90 minute lookahead window.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates routine lookahead.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'routine',
            itemType: 'routine',
            focusId: 'pre-meeting-brief',
            items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
            byType: {
              routine: {
                focusId: 'pre-meeting-brief',
                items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect((result as { content: string }).content).toBe('Routine updated: Pre-Meeting Brief');
  });

  it('focuses the existing routine when create targets a routine that is already configured', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'pre-meeting-brief',
        name: 'Pre-Meeting Brief',
        description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
        category: 'meeting',
        seedByDefault: false,
        manifest: {
          id: 'pre-meeting-brief',
          name: 'Pre-Meeting Brief',
          category: 'scheduled',
          enabledByDefault: true,
          trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
          workloadClass: 'B',
          externalCommMode: 'none',
          budgetProfileId: 'daily-low',
          deliveryDefaults: ['web'],
          defaultRoutingBias: 'balanced',
        },
        configured: true,
        configuredRoutineId: 'pre-meeting-brief',
      }]),
      listRoutines: vi.fn(() => []),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await (agent as any).tryDirectSecondBrainWrite(
      {
        id: 'msg-routine-create-existing',
        userId: 'owner',
        channel: 'web',
        content: 'Create the Pre-Meeting Brief routine in Second Brain.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a Second Brain routine.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
    );

    expect(tools.executeModelTool).not.toHaveBeenCalled();
    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Routine already exists: Pre-Meeting Brief');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'routine',
        itemType: 'routine',
        focusId: 'pre-meeting-brief',
        items: [{ id: 'pre-meeting-brief', label: 'Pre-Meeting Brief' }],
      },
    });
  });

  it('honors a gateway-provided calendar day window for direct Second Brain calendar reads', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    const listEvents = vi.fn(() => [{
      id: 'event-1',
      title: 'Team Check-in',
      startsAt: Date.UTC(2026, 3, 10, 9, 30, 0),
      endsAt: null,
      location: 'Brisbane office',
      description: 'Team check-in at the Brisbane office.',
      source: 'local',
      createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
    }]);
    (agent as any).secondBrainService = { listEvents };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 3, 7, 8, 0, 0));

    try {
      const result = await (agent as any).tryDirectSecondBrainRead(
        {
          id: 'msg-calendar',
          userId: 'owner',
          channel: 'web',
          content: 'Show my calendar events for the next 7 days.',
          timestamp: Date.now(),
        },
        {
          route: 'personal_assistant_task',
          operation: 'read',
          confidence: 'high',
          summary: 'Reads calendar events for the next seven days.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: { personalItemType: 'calendar', calendarWindowDays: 7 },
        },
      );

      const content = typeof result === 'string' ? result : result?.content ?? '';
      expect(content).toContain('Calendar events for the next 7 days:');
      expect(listEvents).toHaveBeenCalledWith(expect.objectContaining({
        includePast: false,
        fromTime: Date.UTC(2026, 3, 7, 8, 0, 0),
        toTime: Date.UTC(2026, 3, 14, 8, 0, 0),
      }));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('updates the focused Second Brain note directly instead of falling through to briefs', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_note_upsert');
        expect(args).toMatchObject({
          id: 'note-2',
          title: 'Smoke Test Note',
          content: 'Second Brain write smoke test note updated.',
        });
        return {
          success: true,
          output: {
            id: 'note-2',
            title: 'Smoke Test Note',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await (agent as any).tryDirectSecondBrainWrite(
      {
        id: 'msg-note-update',
        userId: 'owner',
        channel: 'web',
        content: 'Update that note to say: "Second Brain write smoke test note updated."',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates a local note.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'note' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            itemType: 'note',
            focusId: 'note-2',
            items: [
              { id: 'note-1', label: 'Test' },
              { id: 'note-2', label: 'Smoke Test Note' },
            ],
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Note updated: Smoke Test Note');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'note',
        itemType: 'note',
        focusId: 'note-2',
        items: [{ id: 'note-2', label: 'Smoke Test Note' }],
      },
    });
  });

  it('creates a local Second Brain brief directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_brief_upsert');
        expect(args).toMatchObject({
          kind: 'manual',
          title: 'Second Brain brief smoke test',
          content: 'This is a brief for smoke testing.',
        });
        return {
          success: true,
          output: {
            id: 'brief-1',
            title: 'Second Brain brief smoke test',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await (agent as any).tryDirectSecondBrainWrite(
      {
        id: 'msg-brief-create',
        userId: 'owner',
        channel: 'web',
        content: 'Create a brief called "Second Brain brief smoke test" that says "This is a brief for smoke testing."',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local brief.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'brief' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Brief created: Second Brain brief smoke test');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'brief',
        itemType: 'brief',
        focusId: 'brief-1',
      },
    });
  });

  it('creates a local Second Brain person directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_person_upsert');
        expect(args).toMatchObject({
          name: 'Smoke Test Person',
          email: 'smoke@example.com',
        });
        return {
          success: true,
          output: {
            id: 'person-1',
            name: 'Smoke Test Person',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getPersonById: vi.fn(() => null),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await (agent as any).tryDirectSecondBrainWrite(
      {
        id: 'msg-person-create',
        userId: 'owner',
        channel: 'web',
        content: 'Create a person in my Second Brain named "Smoke Test Person" with email "smoke@example.com".',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local person.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Person created: Smoke Test Person');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'person',
        itemType: 'person',
        focusId: 'person-1',
      },
    });
  });

  it('updates the focused Second Brain person directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_person_upsert');
        expect(args).toMatchObject({
          id: 'person-1',
          name: 'Smoke Test Person',
          email: 'smoke@example.com',
        });
        return {
          success: true,
          output: {
            id: 'person-1',
            name: 'Smoke Test Person',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getPersonById: vi.fn(() => ({
        id: 'person-1',
        name: 'Smoke Test Person',
        relationship: 'other',
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
      })),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await (agent as any).tryDirectSecondBrainWrite(
      {
        id: 'msg-person-update',
        userId: 'owner',
        channel: 'web',
        content: 'Update that person to include email "smoke@example.com".',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates a local person.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            itemType: 'person',
            focusId: 'person-1',
            items: [{ id: 'person-1', label: 'Smoke Test Person' }],
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Person updated: Smoke Test Person');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'person',
        itemType: 'person',
        focusId: 'person-1',
      },
    });
  });

  it('preserves the focused Second Brain note across note list reads', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listNotes: vi.fn(() => [
        {
          id: 'note-1',
          title: 'Test',
          content: 'Testicles',
        },
        {
          id: 'note-2',
          title: 'Smoke Test Note',
          content: 'Second Brain write smoke test note.',
        },
      ]),
    };

    const result = await (agent as any).tryDirectSecondBrainRead(
      {
        id: 'msg-notes',
        userId: 'owner',
        channel: 'web',
        content: 'Show my notes.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads recent notes.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'note' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            itemType: 'note',
            focusId: 'note-2',
            items: [{ id: 'note-2', label: 'Smoke Test Note' }],
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toContain('Recent notes:');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'note',
        itemType: 'note',
        focusId: 'note-2',
        items: [
          { id: 'note-1', label: 'Test' },
          { id: 'note-2', label: 'Smoke Test Note' },
        ],
      },
    });
  });

  it('marks the focused Second Brain task done directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        expect(args).toMatchObject({
          id: 'task-1',
          title: 'Second Brain task smoke test',
          status: 'done',
        });
        return {
          success: true,
          output: {
            id: 'task-1',
            title: 'Second Brain task smoke test',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getTaskById: vi.fn(() => ({
        id: 'task-1',
        title: 'Second Brain task smoke test',
        details: undefined,
        priority: 'medium',
        dueAt: Date.UTC(2026, 3, 8, 15, 0, 0),
        status: 'todo',
      })),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await (agent as any).tryDirectSecondBrainWrite(
      {
        id: 'msg-task-done',
        userId: 'owner',
        channel: 'web',
        content: 'Mark that task as done.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Completes a local task.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'task' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            itemType: 'task',
            focusId: 'task-1',
            items: [{ id: 'task-1', label: 'Second Brain task smoke test' }],
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect((result as { content: string }).content).toBe('Task completed: Second Brain task smoke test');
  });

  it('moves the focused local calendar event directly', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 3, 7, 8, 0, 0));
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        expect(args.id).toBe('event-1');
        expect(args.title).toBe('Second Brain calendar smoke test');
        expect(args.startsAt).toBe(Date.UTC(2026, 3, 8, 7, 0, 0));
        return {
          success: true,
          output: {
            id: 'event-1',
            title: 'Second Brain calendar smoke test',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getEventById: vi.fn(() => ({
        id: 'event-1',
        title: 'Second Brain calendar smoke test',
        startsAt: Date.UTC(2026, 3, 8, 16, 0, 0),
        endsAt: Date.UTC(2026, 3, 8, 17, 0, 0),
        source: 'local',
        createdAt: Date.UTC(2026, 3, 7, 8, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 8, 0, 0),
      })),
    };
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    try {
      const result = await (agent as any).tryDirectSecondBrainWrite(
        {
          id: 'msg-event-move',
          userId: 'owner',
          channel: 'web',
          content: 'Move that event to tomorrow at 5:00 PM.',
          timestamp: Date.now(),
        },
        ctx,
        'owner:web',
        {
          route: 'personal_assistant_task',
          operation: 'update',
          confidence: 'high',
          summary: 'Moves a local event.',
          turnRelation: 'follow_up',
          resolution: 'ready',
          missingFields: [],
          entities: { personalItemType: 'calendar', calendarTarget: 'local' },
        },
        {
          continuityKey: 'chat:owner',
          scope: { assistantId: 'chat', userId: 'owner' },
          linkedSurfaces: [],
          continuationState: {
            kind: 'second_brain_focus',
            payload: {
              itemType: 'calendar',
              focusId: 'event-1',
              items: [{ id: 'event-1', label: 'Second Brain calendar smoke test' }],
            },
          },
          createdAt: 1,
          updatedAt: 1,
          expiresAt: 2,
        },
      );

      expect((result as { content: string }).content).toBe('Calendar event updated: Second Brain calendar smoke test');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('infers the active Second Brain item type for follow-up task reads when the gateway omits it', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = {
      listTasks: vi.fn(() => [{
        id: 'task-1',
        title: 'Second Brain task smoke test',
        details: undefined,
        priority: 'medium',
        dueAt: Date.UTC(2026, 3, 8, 15, 0, 0),
        status: 'todo',
      }]),
    };

    const result = await (agent as any).tryDirectSecondBrainRead(
      {
        id: 'msg-task-read-follow-up',
        userId: 'owner',
        channel: 'web',
        content: 'Show my tasks again.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads the same local task list again.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: {},
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'task',
            itemType: 'task',
            focusId: 'task-1',
            items: [{ id: 'task-1', label: 'Second Brain task smoke test' }],
            byType: {
              task: {
                focusId: 'task-1',
                items: [{ id: 'task-1', label: 'Second Brain task smoke test' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect((result as { content: string }).content).toContain('Open tasks:');
    expect((result as { content: string }).content).toContain('Second Brain task smoke test');
  });

  it('keeps note focus available after later calendar activity for note deletion follow-ups', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe('second_brain_note_delete');
        expect(args).toEqual({ id: 'note-2' });
        return {
          success: true,
          output: {
            id: 'note-2',
            title: 'Smoke Test Note',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await (agent as any).tryDirectSecondBrainWrite(
      {
        id: 'msg-note-delete',
        userId: 'owner',
        channel: 'web',
        content: 'Delete that note.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'delete',
        confidence: 'high',
        summary: 'Deletes the previously focused note.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'note' },
      },
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: {
          kind: 'second_brain_focus',
          payload: {
            activeItemType: 'calendar',
            itemType: 'calendar',
            focusId: 'event-1',
            items: [{ id: 'event-1', label: 'Second Brain calendar smoke test' }],
            byType: {
              note: {
                focusId: 'note-2',
                items: [{ id: 'note-2', label: 'Smoke Test Note' }],
              },
              calendar: {
                focusId: 'event-1',
                items: [{ id: 'event-1', label: 'Second Brain calendar smoke test' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    expect((result as { content: string }).content).toBe('Note deleted: Smoke Test Note');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'calendar',
        itemType: 'calendar',
        focusId: 'event-1',
      },
    });
  });

  it('resumes direct Second Brain mutations after approval and persists the focused item', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const continuityThreadStore = new ContinuityThreadStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-second-brain-focus.test.sqlite',
      retentionDays: 30,
      now: () => 1_710_000_000_000,
    });
    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).continuityThreadStore = continuityThreadStore;
    const updateDirectContinuationState = vi.spyOn(agent as any, 'updateDirectContinuationState');

    const pendingAction: PendingActionRecord = {
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
        originalUserContent: 'Create a note that says: "Second Brain write smoke test note."',
      },
      resume: {
        kind: 'direct_route',
        payload: {
          type: 'second_brain_mutation',
          toolName: 'second_brain_note_upsert',
          args: { content: 'Second Brain write smoke test note.' },
          originalUserContent: 'Create a note that says: "Second Brain write smoke test note."',
          itemType: 'note',
          action: 'create',
        },
      },
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    };

    const result = await (agent as any).continueDirectRouteAfterApproval(
      pendingAction,
      'approval-1',
      'approved',
      {
        success: true,
        message: "Tool 'second_brain_note_upsert' completed.",
        result: {
          success: true,
          status: 'succeeded',
          message: "Tool 'second_brain_note_upsert' completed.",
          output: {
            id: 'note-2',
            title: 'Smoke Test Note',
          },
        },
      },
    );

    expect(result?.content).toBe('Note created: Smoke Test Note');
    expect(tools.executeModelTool).not.toHaveBeenCalled();
    expect(updateDirectContinuationState).toHaveBeenCalledWith(
      'owner',
      'web',
      'owner',
      expect.objectContaining({
        kind: 'second_brain_focus',
        payload: expect.objectContaining({
          activeItemType: 'note',
          itemType: 'note',
          focusId: 'note-2',
        }),
      }),
    );
  });

  it('replays the last actionable request for retry-like follow-ups after a transient Ollama failure', () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).conversationService = {
      getSessionHistory: vi.fn(() => [
        {
          role: 'assistant',
          content: 'Could not reach Ollama at http://127.0.0.1:11434. Check that the local Ollama server is running. (fetch failed)',
        },
      ]),
    };

    const result = (agent as any).resolveRetryAfterFailureContinuationContent(
      'Ollama was disabled. Try that again now',
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        lastActionableRequest: 'Create a brief called "Second Brain brief smoke test" that says "This is a brief for smoke testing."',
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
      {
        agentId: 'chat',
        userId: 'owner',
        channel: 'web',
      },
    );

    expect(result).toBe('Create a brief called "Second Brain brief smoke test" that says "This is a brief for smoke testing."');
  });
});
