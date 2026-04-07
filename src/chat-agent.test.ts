import { describe, expect, it, vi } from 'vitest';
import type { AgentContext, UserMessage } from './agent/types.js';
import { createChatAgentClass } from './chat-agent.js';
import { ContinuityThreadStore } from './runtime/continuity-threads.js';

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
      providerTier: 'managed_cloud',
      usedFallback: false,
    });
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
          const id = String((args.params as Record<string, unknown>).id);
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
          const id = String((args.params as Record<string, unknown>).id);
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
  });
});
