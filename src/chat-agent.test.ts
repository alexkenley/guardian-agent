import { describe, expect, it, vi } from 'vitest';
import type { AgentContext, UserMessage } from './agent/types.js';
import { createChatAgentClass } from './chat-agent.js';
import { CodeSessionStore } from './runtime/code-sessions.js';
import { ContinuityThreadStore } from './runtime/continuity-threads.js';
import { attachSelectedExecutionProfileMetadata } from './runtime/execution-profiles.js';
import { attachPreRoutedIntentGatewayMetadata } from './runtime/intent-gateway.js';
import { PendingActionStore, type PendingActionRecord } from './runtime/pending-actions.js';

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
        providerModel: 'gpt-oss:120b',
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
      model: 'gpt-oss:120b',
      providerTier: 'managed_cloud',
      usedFallback: false,
    });
  });

  it('prefers routed execution-profile metadata for direct intent response source labels', async () => {
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
      content: 'List my coding workspaces.',
      timestamp: Date.now(),
    };
    const routingMessage: UserMessage = {
      ...message,
      metadata: attachSelectedExecutionProfileMetadata(undefined, {
        id: 'managed_cloud_direct',
        providerName: 'ollama-cloud-coding',
        providerType: 'ollama_cloud',
        providerModel: 'qwen3-coder-next',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'direct',
        expectedContextPressure: 'low',
        contextBudget: 80000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['ollama-cloud-coding'],
        reason: 'managed-cloud coding role binding',
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
      candidate: 'coding_session_control',
      result: 'Available coding workspaces:\n- CURRENT: Guardian Agent',
      message,
      routingMessage,
      intentGateway: {
        available: true,
        decision: {
          route: 'coding_session_control',
          operation: 'navigate',
          summary: 'Lists coding workspaces.',
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
      providerProfileName: 'ollama-cloud-coding',
      model: 'qwen3-coder-next',
      providerTier: 'managed_cloud',
      usedFallback: false,
    });
  });

  it('auto-switches to an explicitly named coding workspace before delegated coding work runs', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-code-sessions.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: '/tmp/guardian-agent',
    });
    const targetSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'TempInstallTest',
      workspaceRoot: '/tmp/guardian-ui-package-test',
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        if (toolName === 'code_session_attach') {
          const requestedSessionId = String(args.sessionId);
          const attachment = codeSessionStore.attachSession({
            sessionId: requestedSessionId,
            userId: 'owner',
            principalId: 'owner',
            channel: 'web',
            surfaceId: 'web-guardian-chat',
            mode: 'controller',
          });
          const session = codeSessionStore.getSession(requestedSessionId, 'owner');
          return {
            success: !!attachment && !!session,
            output: {
              session: session
                ? {
                    id: session.id,
                    title: session.title,
                    workspaceRoot: session.workspaceRoot,
                    resolvedRoot: session.resolvedRoot,
                  }
                : null,
            },
          };
        }
        if (toolName === 'coding_backend_run') {
          return {
            success: true,
            output: {
              backendName: 'Codex',
              output: 'Created test1 in the requested workspace.',
            },
          };
        }
        throw new Error(`Unexpected tool ${toolName}`);
      }),
      listToolDefinitions: vi.fn(() => []),
      getToolContext: vi.fn(() => ''),
      getRuntimeNotices: vi.fn(() => []),
      listPendingApprovalIdsForUser: vi.fn(() => []),
      listPendingApprovalsForCodeSession: vi.fn(() => []),
      listJobsForCodeSession: vi.fn(() => []),
      listJobs: vi.fn(() => []),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      tools as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const message: UserMessage = {
      id: 'msg-code-target',
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Use Codex in the TempInstallTest coding workspace to create test1 in the top-level directory.',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        decision: {
          route: 'coding_task',
          operation: 'run',
          summary: 'Create a file in the explicitly named coding workspace.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'repo_grounded',
          preferredTier: 'local',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          entities: {
            codingBackend: 'codex',
            codingBackendRequested: true,
            sessionTarget: 'TempInstallTest coding workspace',
          },
        },
      }),
    };

    const response = await agent.onMessage!(message, ctx);

    expect(response.content).toContain('Switched this chat to:');
    expect(response.content).toContain('TempInstallTest');
    expect(response.content).toContain('Created test1 in the requested workspace.');
    expect(response.metadata).toMatchObject({
      codeSessionResolved: true,
      codeSessionId: targetSession.id,
      codeSessionFocusChanged: true,
    });
    expect(codeSessionStore.resolveForRequest({
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      touchAttachment: false,
    })?.session.id).toBe(targetSession.id);
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      1,
      'code_session_attach',
      { sessionId: targetSession.id },
      expect.objectContaining({
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      }),
    );
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      2,
      'coding_backend_run',
      { task: 'Use Codex in the TempInstallTest coding workspace to create test1 in the top-level directory.', backend: 'codex' },
      expect.objectContaining({
        codeContext: {
          sessionId: targetSession.id,
          workspaceRoot: targetSession.resolvedRoot,
        },
      }),
    );
  });

  it('keeps the current attachment when a coding-backend request only says "current attached coding session"', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-current-attached-coding-backend.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: '/tmp/guardian-agent',
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string) => {
        if (toolName === 'coding_backend_run') {
          return {
            success: true,
            output: {
              backendName: 'Codex',
              output: 'Test run completed in the current workspace.',
            },
          };
        }
        throw new Error(`Unexpected tool ${toolName}`);
      }),
      listToolDefinitions: vi.fn(() => []),
      getToolContext: vi.fn(() => ''),
      getRuntimeNotices: vi.fn(() => []),
      listPendingApprovalIdsForUser: vi.fn(() => []),
      listPendingApprovalsForCodeSession: vi.fn(() => []),
      listJobsForCodeSession: vi.fn(() => []),
      listJobs: vi.fn(() => []),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      tools as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const message: UserMessage = {
      id: 'msg-current-attached-coding-backend',
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'In the current attached coding session, use the Codex coding assistant to run the unit tests for the tools executor by executing npm test -- src/tools/executor.test.ts.',
      timestamp: Date.now(),
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        decision: {
          route: 'coding_task',
          operation: 'run',
          summary: 'Run the requested test in the current coding session via Codex.',
          confidence: 'high',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'repo_grounded',
          preferredTier: 'local',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          entities: {
            codingBackend: 'codex',
            codingBackendRequested: true,
            sessionTarget: 'current attached',
          },
        },
      }),
    };

    const response = await agent.onMessage!(message, ctx);

    expect(response.content).toContain('Test run completed in the current workspace.');
    expect(response.metadata).toMatchObject({
      codingBackendDelegated: true,
      codingBackendId: 'codex',
      codeSessionResolved: true,
      codeSessionId: guardianSession.id,
    });
    expect(codeSessionStore.resolveForRequest({
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      touchAttachment: false,
    })?.session.id).toBe(guardianSession.id);
    expect(tools.executeModelTool).toHaveBeenCalledTimes(1);
    expect(tools.executeModelTool).toHaveBeenCalledWith(
      'coding_backend_run',
      {
        task: 'In the current attached coding session, use the Codex coding assistant to run the unit tests for the tools executor by executing npm test -- src/tools/executor.test.ts.',
        backend: 'codex',
      },
      expect.objectContaining({
        codeContext: {
          sessionId: guardianSession.id,
          workspaceRoot: guardianSession.resolvedRoot,
        },
      }),
    );
  });

  it('auto-switches to an explicitly named coding workspace even when the gateway response is unstructured', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-unstructured-gateway-workspace-switch.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: '/tmp/guardian-agent',
    });
    const tacticalSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Test Tactical Game App',
      workspaceRoot: '/tmp/test-tactical-game-app',
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const tools = {
      isEnabled: vi.fn(() => true),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        if (toolName === 'code_session_attach') {
          const requestedSessionId = String(args.sessionId);
          const attachment = codeSessionStore.attachSession({
            sessionId: requestedSessionId,
            userId: 'owner',
            principalId: 'owner',
            channel: 'web',
            surfaceId: 'web-guardian-chat',
            mode: 'controller',
          });
          const session = codeSessionStore.getSession(requestedSessionId, 'owner');
          return {
            success: !!attachment && !!session,
            output: {
              session: session
                ? {
                    id: session.id,
                    title: session.title,
                    workspaceRoot: session.workspaceRoot,
                    resolvedRoot: session.resolvedRoot,
                  }
                : null,
            },
          };
        }
        if (toolName === 'coding_backend_run') {
          return {
            success: true,
            output: {
              backendName: 'Codex',
              output: 'Created test-switch-a in the requested workspace.',
            },
          };
        }
        throw new Error(`Unexpected tool ${toolName}`);
      }),
      listToolDefinitions: vi.fn(() => []),
      getToolContext: vi.fn(() => ''),
      getRuntimeNotices: vi.fn(() => []),
      listPendingApprovalIdsForUser: vi.fn(() => []),
      listPendingApprovalsForCodeSession: vi.fn(() => []),
      listJobsForCodeSession: vi.fn(() => []),
      listJobs: vi.fn(() => []),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      tools as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: {
        name: 'ollama',
        chat: vi.fn(async () => ({
          content: 'This looks like a coding request.',
          model: 'test-model',
          finishReason: 'stop',
        })),
      } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };
    const message: UserMessage = {
      id: 'msg-unstructured-gateway-switch',
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Use Codex in the Test Tactical Game App coding workspace to create test-switch-a in the top-level directory.',
      timestamp: Date.now(),
    };

    const response = await agent.onMessage!(message, ctx);

    expect(response.content).toContain('Switched this chat to:');
    expect(response.content).toContain('Test Tactical Game App');
    expect(response.content).toContain('Created test-switch-a in the requested workspace.');
    expect(codeSessionStore.resolveForRequest({
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      touchAttachment: false,
    })?.session.id).toBe(tacticalSession.id);
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      1,
      'code_session_attach',
      { sessionId: tacticalSession.id },
      expect.objectContaining({
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      }),
    );
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      2,
      'coding_backend_run',
      {
        task: 'Use Codex in the Test Tactical Game App coding workspace to create test-switch-a in the top-level directory.',
        backend: 'codex',
      },
      expect.objectContaining({
        codeContext: {
          sessionId: tacticalSession.id,
          workspaceRoot: tacticalSession.resolvedRoot,
        },
      }),
    );
  });

  it('accepts affirmative workspace-switch continuations by attaching the target session before resuming the blocked task', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const codeSessionStore = new CodeSessionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-workspace-switch-continuation.test.sqlite',
    });
    const guardianSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Guardian Agent',
      workspaceRoot: '/tmp/guardian-agent',
    });
    const tacticalSession = codeSessionStore.createSession({
      ownerUserId: 'owner',
      title: 'Test Tactical Game App',
      workspaceRoot: '/tmp/test-tactical-game-app',
    });
    codeSessionStore.attachSession({
      sessionId: guardianSession.id,
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      mode: 'controller',
    });

    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-workspace-switch-pending.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    pendingActionStore.replaceActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    }, {
      status: 'pending',
      transferPolicy: 'linked_surfaces_same_user',
      blocker: {
        kind: 'workspace_switch',
        prompt: 'Switch this chat to Test Tactical Game App first, then ask me to run it there.',
        currentSessionId: guardianSession.id,
        currentSessionLabel: `Guardian Agent — ${guardianSession.workspaceRoot}`,
        targetSessionId: tacticalSession.id,
        targetSessionLabel: `Test Tactical Game App — ${tacticalSession.workspaceRoot}`,
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        summary: 'Create a test file in the tactical game workspace.',
        turnRelation: 'new_request',
        resolution: 'ready',
        originalUserContent: 'Use Codex in the Test Tactical Game App coding workspace to create test 51 in the top-level directory.',
        entities: {
          codingBackend: 'codex',
          codingBackendRequested: true,
          sessionTarget: 'Test Tactical Game App coding workspace',
        },
      },
      codeSessionId: guardianSession.id,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    const tools = {
      isEnabled: vi.fn(() => true),
      listPendingApprovalIdsForUser: vi.fn(() => []),
      getApprovalSummaries: vi.fn(() => new Map()),
      listToolDefinitions: vi.fn(() => []),
      getToolContext: vi.fn(() => ''),
      getRuntimeNotices: vi.fn(() => []),
      listPendingApprovalsForCodeSession: vi.fn(() => []),
      listJobsForCodeSession: vi.fn(() => []),
      listJobs: vi.fn(() => []),
      executeModelTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
        if (toolName === 'code_session_current') {
          const current = codeSessionStore.resolveForRequest({
            userId: 'owner',
            principalId: 'owner',
            channel: 'web',
            surfaceId: 'web-guardian-chat',
            touchAttachment: false,
          })?.session ?? null;
          return {
            success: true,
            output: {
              session: current
                ? {
                    id: current.id,
                    title: current.title,
                    workspaceRoot: current.workspaceRoot,
                    resolvedRoot: current.resolvedRoot,
                  }
                : null,
            },
          };
        }
        if (toolName === 'code_session_attach') {
          const requestedSessionId = String(args.sessionId);
          const attachment = codeSessionStore.attachSession({
            sessionId: requestedSessionId,
            userId: 'owner',
            principalId: 'owner',
            channel: 'web',
            surfaceId: 'web-guardian-chat',
            mode: 'controller',
          });
          const session = codeSessionStore.getSession(requestedSessionId, 'owner');
          return {
            success: !!attachment && !!session,
            output: {
              session: session
                ? {
                    id: session.id,
                    title: session.title,
                    workspaceRoot: session.workspaceRoot,
                    resolvedRoot: session.resolvedRoot,
                  }
                : null,
            },
          };
        }
        if (toolName === 'coding_backend_run') {
          return {
            success: true,
            output: {
              backendName: 'Codex',
              output: 'Created test 51 in the requested workspace.',
            },
          };
        }
        throw new Error(`Unexpected tool ${toolName}`);
      }),
    };
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      undefined,
      tools as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      codeSessionStore,
    );
    (agent as any).pendingActionStore = pendingActionStore;
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      checkAction: vi.fn(),
      capabilities: [],
    };
    const message: UserMessage = {
      id: 'msg-workspace-switch-continue',
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Yes switch to coding session',
      timestamp: Date.now(),
    };

    const response = await agent.onMessage!(message, ctx);

    expect(response.content).toContain('Switched this chat to:');
    expect(response.content).toContain('Test Tactical Game App');
    expect(response.content).toContain('Created test 51 in the requested workspace.');
    expect(codeSessionStore.resolveForRequest({
      userId: 'owner',
      principalId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      touchAttachment: false,
    })?.session.id).toBe(tacticalSession.id);
    expect(pendingActionStore.getActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    })).toBeNull();
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      1,
      'code_session_current',
      {},
      expect.objectContaining({
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      }),
    );
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      2,
      'code_session_attach',
      { sessionId: tacticalSession.id },
      expect.objectContaining({
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      }),
    );
    expect(tools.executeModelTool).toHaveBeenNthCalledWith(
      3,
      'coding_backend_run',
      {
        task: 'Use Codex in the Test Tactical Game App coding workspace to create test 51 in the top-level directory.',
        backend: 'codex',
      },
      expect.objectContaining({
        codeContext: {
          sessionId: tacticalSession.id,
          workspaceRoot: tacticalSession.resolvedRoot,
        },
      }),
    );
  });

  it('keeps the selected execution profile on direct Second Brain responses', async () => {
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
        providerModel: 'minimax-m2.1',
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
      locality: 'external',
      providerName: 'ollama_cloud',
      providerProfileName: 'ollama-cloud-direct',
      model: 'minimax-m2.1',
      providerTier: 'managed_cloud',
      usedFallback: false,
      notice: 'Handled directly by Second Brain.',
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

  it('filters direct Second Brain library reads by a query derived from the user message', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const listLinks = vi.fn((filter?: Record<string, unknown>) => {
      expect(filter).toMatchObject({ limit: 8, query: 'Harbor' });
      return [{
        id: 'link-1',
        title: 'Harbor launch checklist',
        kind: 'reference',
        url: 'https://example.com/',
        summary: 'Reference for the Harbor launch review.',
      }];
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = { listLinks };

    const result = await (agent as any).tryDirectSecondBrainRead(
      {
        id: 'msg-library-query',
        userId: 'owner',
        channel: 'web',
        content: 'Show my library items about Harbor.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads library items related to Harbor.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'library' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Library items related to "Harbor":');
    expect(content).toContain('Harbor launch checklist [reference] - https://example.com/');
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

  it('filters direct Second Brain person reads to the requested quoted name', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const listPeople = vi.fn((filter?: Record<string, unknown>) => {
      expect(filter).toMatchObject({ limit: 6, query: 'Jordan Lee' });
      return [
        {
          id: 'person-1',
          name: 'Jordan Lee',
          email: 'jordan.lee@example.com',
          title: 'Design Lead',
          company: 'Harbor Labs',
        },
        {
          id: 'person-2',
          name: 'VentraIP Australia',
          email: 'noreply@ventraip.com.au',
        },
      ];
    });
    const agent = new ChatAgent('chat', 'Chat');
    (agent as any).secondBrainService = { listPeople };

    const result = await (agent as any).tryDirectSecondBrainRead(
      {
        id: 'msg-person-query',
        userId: 'owner',
        channel: 'web',
        content: 'Find the person "Jordan Lee" in my Second Brain.',
        timestamp: Date.now(),
      },
      {
        route: 'personal_assistant_task',
        operation: 'read',
        confidence: 'high',
        summary: 'Reads the requested person in Second Brain.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toContain('Contacts in Second Brain matching "Jordan Lee":');
    expect(content).toContain('Jordan Lee - jordan.lee@example.com · Design Lead · Harbor Labs');
    expect(content).not.toContain('VentraIP Australia');
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

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine updated: Pre-Meeting Brief');
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

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine updated: Pre-Meeting Brief');
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

  it('creates a topic watch routine from a natural-language notify request', async () => {
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
        expect(toolName).toBe('second_brain_routine_create');
        expect(args).toMatchObject({
          templateId: 'topic-watch',
          config: { topicQuery: 'Harbor launch' },
        });
        return {
          success: true,
          output: {
            id: 'topic-watch:harbor-launch',
            name: 'Topic Watch: Harbor launch',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'topic-watch',
        name: 'Topic Watch',
        description: 'Scans Second Brain records for a topic and alerts you when new matching context appears.',
        category: 'watch',
        seedByDefault: false,
        allowMultiple: true,
        configured: false,
        defaultTiming: {
          kind: 'background',
          label: 'Background check across the next 1440 minutes',
          editable: false,
          minutes: 1440,
        },
        supportedTiming: ['background'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: false,
        supportsTopicQuery: true,
        supportsDeadlineWindow: false,
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
        id: 'msg-routine-create-topic-watch',
        userId: 'owner',
        channel: 'web',
        content: 'Create a Second Brain routine to message me when anything mentions "Harbor launch".',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a topic watch routine.',
        turnRelation: 'current_turn',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine created: Topic Watch: Harbor launch');
  });

  it('creates a deadline watch routine from a natural-language notify request', async () => {
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
        expect(toolName).toBe('second_brain_routine_create');
        expect(args).toMatchObject({
          templateId: 'deadline-watch',
          config: { dueWithinHours: 24 },
        });
        return {
          success: true,
          output: {
            id: 'deadline-watch:next-24-hours',
            name: 'Deadline Watch: next 24 hours',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'deadline-watch',
        name: 'Deadline Watch',
        description: 'Alerts you when open tasks enter a bounded due-soon window.',
        category: 'watch',
        seedByDefault: false,
        allowMultiple: true,
        configured: false,
        defaultTiming: {
          kind: 'background',
          label: 'Background check across the next 1440 minutes',
          editable: false,
          minutes: 1440,
        },
        supportedTiming: ['background'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: false,
        supportsTopicQuery: false,
        supportsDeadlineWindow: true,
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
        id: 'msg-routine-create-deadline-watch',
        userId: 'owner',
        channel: 'web',
        content: 'Create a Second Brain routine to message me when I have something due tomorrow.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a deadline watch routine.',
        turnRelation: 'current_turn',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine created: Deadline Watch: next 24 hours');
  });

  it('updates a topic watch routine query directly from chat', async () => {
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
          id: 'topic-watch:harbor-launch',
          name: 'Topic Watch: Harbor launch',
          config: { topicQuery: 'Board prep' },
          delivery: ['telegram'],
        });
        return {
          success: true,
          output: {
            id: 'topic-watch:harbor-launch',
            name: 'Topic Watch: Board prep',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'topic-watch',
        name: 'Topic Watch',
        description: 'Scans Second Brain records for a topic and alerts you when new matching context appears.',
        category: 'watch',
        seedByDefault: false,
        allowMultiple: true,
        configured: true,
        defaultTiming: {
          kind: 'scheduled',
          label: 'Daily at 8 a.m.',
          editable: true,
          schedule: { cadence: 'daily', time: '08:00' },
        },
        supportedTiming: ['scheduled', 'manual'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: false,
        supportsTopicQuery: true,
        supportsDeadlineWindow: false,
      }]),
      listRoutines: vi.fn(() => [{
        id: 'topic-watch:harbor-launch',
        templateId: 'topic-watch',
        capability: 'topic_watch',
        name: 'Topic Watch: Harbor launch',
        description: 'Scans Second Brain records for a topic and alerts you when new matching context appears.',
        category: 'watch',
        enabled: true,
        timing: {
          kind: 'scheduled',
          label: 'Daily at 8 a.m.',
          editable: true,
          schedule: { cadence: 'daily', time: '08:00' },
        },
        delivery: ['telegram'],
        topicQuery: 'Harbor launch',
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        lastRunAt: null,
      }]),
      getRoutineById: vi.fn(() => null),
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
        id: 'msg-routine-update-topic-watch',
        userId: 'owner',
        channel: 'web',
        content: 'Update that routine to watch "Board prep".',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates a topic watch routine.',
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
            focusId: 'topic-watch:harbor-launch',
            items: [{ id: 'topic-watch:harbor-launch', label: 'Topic Watch: Harbor launch' }],
            byType: {
              routine: {
                focusId: 'topic-watch:harbor-launch',
                items: [{ id: 'topic-watch:harbor-launch', label: 'Topic Watch: Harbor launch' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine updated: Topic Watch: Board prep');
  });

  it('updates a scheduled routine timing from plain-English chat', async () => {
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
          id: 'morning-brief',
          name: 'Morning Brief',
          timing: {
            kind: 'scheduled',
            schedule: { cadence: 'daily', time: '18:00' },
          },
          delivery: ['telegram', 'web'],
        });
        return {
          success: true,
          output: {
            id: 'morning-brief',
            name: 'Morning Brief',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'morning-brief',
        name: 'Morning Brief',
        description: 'Prepare a morning brief with today’s events, open tasks, and recent context.',
        category: 'daily',
        seedByDefault: true,
        allowMultiple: false,
        configured: true,
        configuredRoutineId: 'morning-brief',
        defaultTiming: {
          kind: 'scheduled',
          label: 'Daily at 7 a.m.',
          editable: true,
          schedule: { cadence: 'daily', time: '07:00' },
        },
        supportedTiming: ['scheduled', 'manual'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: true,
        supportsTopicQuery: false,
        supportsDeadlineWindow: false,
      }]),
      listRoutines: vi.fn(() => [{
        id: 'morning-brief',
        templateId: 'morning-brief',
        capability: 'morning_brief',
        name: 'Morning Brief',
        description: 'Prepare a morning brief with today’s events, open tasks, and recent context.',
        category: 'daily',
        enabled: true,
        timing: {
          kind: 'scheduled',
          label: 'Daily at 7 a.m.',
          editable: true,
          schedule: { cadence: 'daily', time: '07:00' },
        },
        delivery: ['telegram', 'web'],
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        lastRunAt: null,
      }]),
      getRoutineById: vi.fn(() => null),
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
        id: 'msg-routine-update-schedule',
        userId: 'owner',
        channel: 'web',
        content: 'Update that routine to run daily at 6 pm.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates a routine schedule.',
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
            focusId: 'morning-brief',
            items: [{ id: 'morning-brief', label: 'Morning Brief' }],
            byType: {
              routine: {
                focusId: 'morning-brief',
                items: [{ id: 'morning-brief', label: 'Morning Brief' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine updated: Morning Brief');
  });

  it('creates a scoped weekly review routine from chat', async () => {
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
        expect(toolName).toBe('second_brain_routine_create');
        expect(args).toMatchObject({
          templateId: 'weekly-review',
          timing: {
            kind: 'scheduled',
            schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '09:00' },
          },
          config: { focusQuery: 'Board prep' },
        });
        return {
          success: true,
          output: {
            id: 'weekly-review:board-prep',
            name: 'Weekly Review: Board prep',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'weekly-review',
        name: 'Weekly Review',
        description: 'Prepare a weekly review with upcoming commitments, open work, and recent context.',
        category: 'weekly',
        seedByDefault: true,
        allowMultiple: false,
        configured: true,
        configuredRoutineId: 'weekly-review',
        defaultTiming: {
          kind: 'scheduled',
          label: 'Weekly on Monday at 9 a.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '09:00' },
        },
        supportedTiming: ['scheduled', 'manual'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: true,
        supportsTopicQuery: false,
        supportsDeadlineWindow: false,
      }]),
      listRoutines: vi.fn(() => [{
        id: 'weekly-review',
        templateId: 'weekly-review',
        capability: 'weekly_review',
        name: 'Weekly Review',
        description: 'Prepare a weekly review with upcoming commitments, open work, and recent context.',
        category: 'weekly',
        enabled: true,
        timing: {
          kind: 'scheduled',
          label: 'Weekly on Monday at 9 a.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '09:00' },
        },
        delivery: ['telegram', 'web'],
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        lastRunAt: null,
      }]),
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
        id: 'msg-routine-create-scoped-weekly-review',
        userId: 'owner',
        channel: 'web',
        content: 'Create a Weekly Review for Board prep every Monday at 9 am.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a scoped weekly review routine.',
        turnRelation: 'current_turn',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine created: Weekly Review: Board prep');
  });

  it('creates a scheduled review routine from plain-language chat', async () => {
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
        expect(toolName).toBe('second_brain_routine_create');
        expect(args).toMatchObject({
          templateId: 'scheduled-review',
          timing: {
            kind: 'scheduled',
            schedule: { cadence: 'weekly', dayOfWeek: 'friday', time: '16:00' },
          },
          config: { focusQuery: 'Board prep' },
        });
        return {
          success: true,
          output: {
            id: 'scheduled-review:board-prep',
            name: 'Scheduled Review: Board prep',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'scheduled-review',
        name: 'Scheduled Review',
        description: 'Prepare a reusable scheduled review with upcoming commitments, open work, and saved context.',
        category: 'review',
        seedByDefault: false,
        allowMultiple: true,
        configured: false,
        defaultTiming: {
          kind: 'scheduled',
          label: 'Weekly on Monday at 8 a.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '08:00' },
        },
        supportedTiming: ['scheduled', 'manual'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: true,
        supportsTopicQuery: false,
        supportsDeadlineWindow: false,
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
        id: 'msg-routine-create-scheduled-review',
        userId: 'owner',
        channel: 'web',
        content: 'Create a review for Board prep every Friday at 4 pm.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a scheduled review routine.',
        turnRelation: 'current_turn',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine created: Scheduled Review: Board prep');
  });

  it('reuses an existing matching scheduled review instead of preparing a duplicate create', async () => {
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
      executeModelTool: vi.fn(async () => {
        throw new Error('duplicate create should not reach tool execution');
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'scheduled-review',
        name: 'Scheduled Review',
        description: 'Prepare a reusable scheduled review with upcoming commitments, open work, and saved context.',
        category: 'review',
        seedByDefault: false,
        allowMultiple: true,
        configured: true,
        defaultTiming: {
          kind: 'scheduled',
          label: 'Weekly on Monday at 8 a.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '08:00' },
        },
        supportedTiming: ['scheduled', 'manual'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: true,
        supportsTopicQuery: false,
        supportsDeadlineWindow: false,
      }]),
      listRoutines: vi.fn(() => [{
        id: 'scheduled-review:board-prep',
        templateId: 'scheduled-review',
        capability: 'scheduled_review',
        name: 'Friday Board Review',
        description: 'Prepare a reusable scheduled review with upcoming commitments, open work, and saved context.',
        category: 'review',
        enabled: false,
        timing: {
          kind: 'scheduled',
          label: 'Weekly on Friday at 4 p.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'friday', time: '16:00' },
        },
        delivery: ['web', 'telegram'],
        focusQuery: 'Board prep',
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        lastRunAt: null,
      }]),
      listRoutineRecords: vi.fn(() => []),
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
        id: 'msg-routine-create-duplicate-scheduled-review',
        userId: 'owner',
        channel: 'web',
        content: 'Create a review for Board prep every Friday at 4 pm.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a scheduled review routine.',
        turnRelation: 'current_turn',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'routine' },
      },
    );

    expect(tools.executeModelTool).not.toHaveBeenCalled();
    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Routine already exists: Friday Board Review');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'routine',
        itemType: 'routine',
        focusId: 'scheduled-review:board-prep',
        items: [{ id: 'scheduled-review:board-prep', label: 'Friday Board Review' }],
      },
    });
  });

  it('updates a scoped routine focus from plain-language chat', async () => {
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
          id: 'weekly-review:board-prep',
          name: 'Weekly Review: Board prep',
          config: { focusQuery: 'Harbor launch' },
          delivery: ['telegram', 'web'],
        });
        return {
          success: true,
          output: {
            id: 'weekly-review:board-prep',
            name: 'Weekly Review: Harbor launch',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      listRoutineCatalog: vi.fn(() => [{
        templateId: 'weekly-review',
        name: 'Weekly Review',
        description: 'Prepare a weekly review with upcoming commitments, open work, and recent context.',
        category: 'weekly',
        seedByDefault: true,
        allowMultiple: false,
        configured: true,
        defaultTiming: {
          kind: 'scheduled',
          label: 'Weekly on Monday at 9 a.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '09:00' },
        },
        supportedTiming: ['scheduled', 'manual'],
        defaultDelivery: ['telegram', 'web'],
        supportsFocusQuery: true,
        supportsTopicQuery: false,
        supportsDeadlineWindow: false,
      }]),
      listRoutines: vi.fn(() => [{
        id: 'weekly-review:board-prep',
        templateId: 'weekly-review',
        capability: 'weekly_review',
        name: 'Weekly Review: Board prep',
        description: 'Prepare a weekly review with upcoming commitments, open work, and recent context.',
        category: 'weekly',
        enabled: true,
        timing: {
          kind: 'scheduled',
          label: 'Weekly on Monday at 9 a.m.',
          editable: true,
          schedule: { cadence: 'weekly', dayOfWeek: 'monday', time: '09:00' },
        },
        delivery: ['telegram', 'web'],
        focusQuery: 'Board prep',
        createdAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        updatedAt: Date.UTC(2026, 3, 7, 0, 0, 0),
        lastRunAt: null,
      }]),
      getRoutineById: vi.fn(() => null),
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
        id: 'msg-routine-update-scoped-focus',
        userId: 'owner',
        channel: 'web',
        content: 'Update that routine to focus on Harbor launch.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates a scoped routine focus.',
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
            focusId: 'weekly-review:board-prep',
            items: [{ id: 'weekly-review:board-prep', label: 'Weekly Review: Board prep' }],
            byType: {
              routine: {
                focusId: 'weekly-review:board-prep',
                items: [{ id: 'weekly-review:board-prep', label: 'Weekly Review: Board prep' }],
              },
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    const content = typeof result === 'string' ? result : result?.content ?? '';
    expect(content).toBe('Routine updated: Weekly Review: Harbor launch');
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

  it('creates a titled local Second Brain note directly', async () => {
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
          title: 'Second Brain write smoke test note',
          content: 'Second Brain write smoke test note.',
        });
        return {
          success: true,
          output: {
            id: 'note-create-1',
            title: 'Second Brain write smoke test note',
            content: 'Second Brain write smoke test note.',
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
        id: 'msg-note-create',
        userId: 'owner',
        channel: 'web',
        content: 'Use Second Brain to create a note titled "Second Brain write smoke test note" with content "Second Brain write smoke test note."',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'save',
        confidence: 'high',
        summary: 'Creates a local note.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'note' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Note created: Second Brain write smoke test note');
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
            title: 'Design Lead',
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
        content: 'Create a contact in my Second Brain named "Smoke Test Person" with email "smoke@example.com".',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local contact.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Contact created: Smoke Test Person');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'person',
        itemType: 'person',
        focusId: 'person-1',
      },
    });
  });

  it('creates a local Second Brain person from loose unquoted phrasing with long whitespace', async () => {
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
          name: 'Angela Lee',
          phone: '0887 895 687',
        });
        return {
          success: true,
          output: {
            id: 'person-2',
            name: 'Angela Lee',
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
    const longWhitespace = ' '.repeat(2048);

    const result = await (agent as any).tryDirectSecondBrainWrite(
      {
        id: 'msg-person-create-unquoted',
        userId: 'owner',
        channel: 'web',
        content: `Create a contact in my Second Brain${longWhitespace}Angela Lee ... phone number 0887 895 687`,
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local contact.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Contact created: Angela Lee');
  });

  it('creates a local Second Brain person with structured phone and location fields', async () => {
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
          name: 'Jordan Lee',
          email: 'jordan.lee@example.com',
          phone: '+61 409 555 111',
          location: 'Brisbane',
          title: 'Design Lead',
          company: 'Harbor Labs',
        });
        return {
          success: true,
          output: {
            id: 'person-structured',
            name: 'Jordan Lee',
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
        id: 'msg-person-create-structured',
        userId: 'owner',
        channel: 'web',
        content: 'Create a contact in my Second Brain named "Jordan Lee" with email "jordan.lee@example.com", phone "+61 409 555 111", title "Design Lead", company "Harbor Labs", and location "Brisbane".',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local contact.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Contact created: Jordan Lee');
  });

  it('creates a local Second Brain person directly from pasted multiline fields', async () => {
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
          name: 'Jordan Lee',
          email: 'jordan.lee@example.com',
          title: 'Design Lead',
          company: 'Harbor Labs',
          notes: 'Owner for the Harbor launch review.',
        });
        return {
          success: true,
          output: {
            id: 'person-multiline',
            name: 'Jordan Lee',
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
        id: 'msg-person-create-multiline',
        userId: 'owner',
        channel: 'web',
        content: 'Create a contact in my Second Brain named "Jordan Lee" with  \n  email "jordan.lee@example.com", title "Design Lead", company   \n  "Harbor Labs", and notes "Owner for the Harbor launch review."',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local contact.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Contact created: Jordan Lee');
  });

  it('creates a clarification pending action when person create is missing both name and email', async () => {
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
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-pending-actions.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getPersonById: vi.fn(() => null),
    };
    (agent as any).pendingActionStore = pendingActionStore;
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    const result = await (agent as any).tryDirectSecondBrainWrite(
      {
        id: 'msg-person-create-missing',
        userId: 'owner',
        channel: 'web',
        content: 'Create a contact in my Second Brain.',
        surfaceId: 'owner',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local contact.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'person' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('To create a local contact, I need at least a name or email address.');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.pendingAction).toMatchObject({
      blocker: {
        kind: 'clarification',
        field: 'person_identity',
      },
      intent: {
        route: 'personal_assistant_task',
        operation: 'create',
      },
    });
    expect(tools.executeModelTool).not.toHaveBeenCalled();
  });

  it('creates a local Second Brain library item directly', async () => {
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
        expect(toolName).toBe('second_brain_library_upsert');
        expect(args).toMatchObject({
          title: 'Harbor launch checklist',
          url: 'https://example.com',
          summary: 'Reference for the Harbor launch review.',
        });
        return {
          success: true,
          output: {
            id: 'link-1',
            title: 'Harbor launch checklist',
            url: 'https://example.com/',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getLinkById: vi.fn(() => null),
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
        id: 'msg-library-create',
        userId: 'owner',
        channel: 'web',
        content: 'Save this link in my library with title "Harbor launch checklist", url "https://example.com", and notes "Reference for the Harbor launch review."',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'save',
        confidence: 'high',
        summary: 'Creates a local library item.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'library' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Library item created: Harbor launch checklist');
    expect((result as { metadata?: Record<string, unknown> }).metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'library',
        itemType: 'library',
        focusId: 'link-1',
      },
    });
  });

  it('creates a local Second Brain library item directly from pasted multiline fields with a wrapped title fragment', async () => {
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
        expect(toolName).toBe('second_brain_library_upsert');
        expect(args).toMatchObject({
          title: 'Harbor launch checklist',
          url: 'https://example.com',
          summary: 'Reference for the Harbor launch review.',
        });
        return {
          success: true,
          output: {
            id: 'link-multiline',
            title: 'Harbor launch checklist',
            url: 'https://example.com/',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getLinkById: vi.fn(() => null),
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
        id: 'msg-library-create-multiline',
        userId: 'owner',
        channel: 'web',
        content: 'Save this link in my library with title "Harbor launch chec \n  klist", url "https://example.com", and notes "Reference for the\nHarbor launch review."',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'save',
        confidence: 'high',
        summary: 'Creates a local library item.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'library' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Library item created: Harbor launch checklist');
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
        summary: 'Updates a local contact.',
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
    expect((result as { content: string }).content).toBe('Contact updated: Smoke Test Person');
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

  it('creates a local Second Brain task directly from a pasted multiline prompt', async () => {
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
        expect(toolName).toBe('second_brain_task_upsert');
        expect(args).toMatchObject({
          title: 'Send Harbor launch review deck',
          dueAt: expect.any(Number),
        });
        return {
          success: true,
          output: {
            id: 'task-created',
            title: 'Send Harbor launch review deck',
          },
        };
      }),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getTaskById: vi.fn(() => null),
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
        id: 'msg-task-create-multiline',
        userId: 'owner',
        channel: 'web',
        content: 'Create a task called "Send Harbor launch review deck" due   \n  April 9, 2026 at 4 PM.',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'create',
        confidence: 'high',
        summary: 'Creates a local task.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: { personalItemType: 'task' },
      },
    );

    expect(typeof result).toBe('object');
    expect((result as { content: string }).content).toBe('Task created: Send Harbor launch review deck');
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

  it('stores the renamed title in pending approval payloads for focused task updates', async () => {
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
      getApprovalSummaries: vi.fn(() => new Map()),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        expect(args).toMatchObject({
          id: 'task-1',
          title: 'Send Harbor launch review deck and notes',
          status: 'todo',
          priority: 'medium',
          dueAt: Date.UTC(2026, 3, 9, 6, 0, 0),
        });
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-1',
        };
      }),
    };
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-task-rename-pending.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).secondBrainService = {
      getTaskById: vi.fn(() => ({
        id: 'task-1',
        title: 'Send Harbor launch review deck',
        details: undefined,
        priority: 'medium',
        dueAt: Date.UTC(2026, 3, 9, 6, 0, 0),
        status: 'todo',
      })),
    };
    (agent as any).pendingActionStore = pendingActionStore;
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: { name: 'ollama' } as never,
      checkAction: vi.fn(),
      capabilities: [],
    };

    await (agent as any).tryDirectSecondBrainWrite(
      {
        id: 'msg-task-rename',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'owner',
        content: 'Rename the task "Send Harbor launch review deck" to "Send   \n  Harbor launch review deck and notes".',
        timestamp: Date.now(),
      },
      ctx,
      'owner:web',
      {
        route: 'personal_assistant_task',
        operation: 'update',
        confidence: 'high',
        summary: 'Updates a local task.',
        turnRelation: 'new_request',
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
            items: [{ id: 'task-1', label: 'Send Harbor launch review deck' }],
          },
        },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    );

    const pending = pendingActionStore.getActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
    });
    expect(pending?.resume?.payload).toMatchObject({
      type: 'second_brain_mutation',
      toolName: 'second_brain_task_upsert',
      args: expect.objectContaining({
        id: 'task-1',
        title: 'Send Harbor launch review deck and notes',
      }),
    });
  });

  it('reconciles stale approval blockers before reusing them in later turns', () => {
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
      listPendingApprovalIdsForUser: vi.fn(() => []),
      getApprovalSummaries: vi.fn(() => new Map()),
      executeModelTool: vi.fn(),
    };
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-stale-approvals.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const created = pendingActionStore.replaceActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'telegram',
      surfaceId: 'telegram-chat',
    }, {
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the calendar update.',
        approvalIds: ['approval-stale-1'],
        approvalSummaries: [
          { id: 'approval-stale-1', toolName: 'second_brain_calendar_upsert', argsPreview: '{"title":"Harbor launch review"}' },
        ],
      },
      intent: {
        route: 'personal_assistant_task',
        operation: 'update',
        originalUserContent: 'Move that calendar event to tomorrow at 2 PM.',
      },
      expiresAt: 1_710_000_000_000 + 30 * 60 * 1000,
    });
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).pendingActionStore = pendingActionStore;

    const pendingIds = (agent as any).getPendingApprovalIds('owner', 'telegram', 'telegram-chat', 1_710_000_000_000);

    expect(pendingIds).toEqual([]);
    expect(pendingActionStore.get(created.id)?.status).toBe('completed');
  });

  it('answers approval-status queries from live approval state instead of stale pending-action text', async () => {
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
      listPendingApprovalIdsForUser: vi.fn(() => []),
      getApprovalSummaries: vi.fn(() => new Map()),
      executeModelTool: vi.fn(),
    };
    const futureBase = Date.now();
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-approval-status.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const created = pendingActionStore.replaceActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'telegram',
      surfaceId: 'telegram-chat',
    }, {
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the file write.',
        approvalIds: ['approval-stale-1'],
        approvalSummaries: [
          { id: 'approval-stale-1', toolName: 'fs_write', argsPreview: '{"path":"S:\\\\Development\\\\test.txt"}' },
        ],
      },
      intent: {
        route: 'filesystem_task',
        operation: 'create',
        originalUserContent: 'Create a file in S:\\Development.',
      },
      expiresAt: futureBase + 30 * 60 * 1000,
    });
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).pendingActionStore = pendingActionStore;
    const ctx: AgentContext = {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      checkAction: vi.fn(),
      capabilities: [],
    };

    const response = await agent.onMessage!({
      id: 'msg-approval-status',
      userId: 'owner',
      channel: 'telegram',
      surfaceId: 'telegram-chat',
      content: 'What pending approvals do I have right now?',
      timestamp: futureBase,
      metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
        available: true,
        mode: 'primary',
        model: 'test-model',
        latencyMs: 1,
        decision: {
          route: 'general_assistant',
          operation: 'inspect',
          summary: 'General status question.',
          confidence: 'low',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'local',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          expectedContextPressure: 'low',
          preferredAnswerPath: 'direct',
          entities: {},
        },
      }),
    }, ctx);

    expect(response.content).toBe('There are no pending approvals.');
    expect(pendingActionStore.get(created.id)?.status).toBe('completed');
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
        expect(args.startsAt).toBe(1775631600000); // Or the correct expected value based on the test

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

  it('stores a structured tool-loop resume payload for approval-blocked remote sandbox runs', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-remote-tool-loop.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const llm = {
      name: 'ollama_cloud',
      chat: vi.fn(async () => ({
        content: '',
        toolCalls: [
          {
            id: 'tool-call-1',
            name: 'code_remote_exec',
            arguments: JSON.stringify({ command: 'npm ci', profile: 'Daytona' }),
          },
        ],
        model: 'gpt-oss:120b',
        finishReason: 'tool_calls',
      })),
    };
    const tools = {
      isEnabled: vi.fn(() => true),
      getRuntimeNotices: vi.fn(() => []),
      getToolContext: vi.fn(() => ''),
      listAlwaysLoadedDefinitions: vi.fn(() => []),
      listCodeSessionEagerToolDefinitions: vi.fn(() => [
        {
          name: 'code_remote_exec',
          description: 'Run a command in the remote sandbox.',
          shortDescription: 'Remote exec',
          risk: 'mutating',
          category: 'coding',
          parameters: { type: 'object', properties: {} },
        },
      ]),
      getToolDefinition: vi.fn(() => ({
        name: 'code_remote_exec',
        description: 'Run a command in the remote sandbox.',
        shortDescription: 'Remote exec',
        risk: 'mutating',
        category: 'coding',
        parameters: { type: 'object', properties: {} },
      })),
      executeModelTool: vi.fn(async () => ({
        success: false,
        status: 'pending_approval',
        approvalId: 'approval-1',
        jobId: 'job-1',
        message: 'Approval required.',
      })),
      getApprovalSummaries: vi.fn(() => new Map([
        ['approval-1', {
          toolName: 'code_remote_exec',
          argsPreview: '{"command":"npm ci","profile":"Daytona"}',
          actionLabel: 'run npm ci remotely',
        }],
      ])),
      listPendingApprovalIdsForUser: vi.fn(() => []),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).pendingActionStore = pendingActionStore;

    const response = await agent.onMessage({
      id: 'msg-remote-pending',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
      content: 'In the Guardian workspace, run `npm ci` in the remote sandbox using the Daytona profile for this coding session, then run `npm test` in the same remote sandbox.',
      timestamp: 1_710_000_000_000,
      metadata: attachSelectedExecutionProfileMetadata(
        attachPreRoutedIntentGatewayMetadata(
          {
            codeContext: {
              workspaceRoot: '/repo',
              sessionId: 'session-123',
            },
          },
          {
            available: true,
            mode: 'primary',
            model: 'test-model',
            latencyMs: 1,
            decision: {
              route: 'coding_task',
              operation: 'run',
              summary: 'Run repo commands in the remote sandbox.',
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
              entities: {
                codingRemoteExecRequested: true,
                profileId: 'Daytona',
              },
            },
          },
        ),
        {
          id: 'managed_cloud_tool',
          providerName: 'ollama-cloud-coding',
          providerType: 'ollama_cloud',
          providerModel: 'gpt-oss:120b',
          providerLocality: 'external',
          providerTier: 'managed_cloud',
          requestedTier: 'external',
          preferredAnswerPath: 'tool_loop',
          expectedContextPressure: 'medium',
          contextBudget: 80000,
          toolContextMode: 'tight',
          maxAdditionalSections: 2,
          maxRuntimeNotices: 2,
          fallbackProviderOrder: ['ollama-cloud-coding'],
          reason: 'coding profile',
        },
      ),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: llm as never,
      checkAction: vi.fn(),
      capabilities: [],
    });

    expect(response.metadata?.pendingAction).toBeTruthy();
    const pending = pendingActionStore.getActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
    });
    expect(pending?.resume?.kind).toBe('tool_loop');
    expect(pending?.resume?.payload).toMatchObject({
      type: 'suspended_tool_loop',
      codeContext: {
        workspaceRoot: '/repo',
        sessionId: 'session-123',
      },
      selectedExecutionProfile: {
        providerName: 'ollama-cloud-coding',
      },
      pendingTools: [
        {
          approvalId: 'approval-1',
          toolCallId: 'tool-call-1',
          jobId: 'job-1',
          name: 'code_remote_exec',
        },
      ],
    });
  });

  it('resumes approval-blocked remote tool loops with the stored code session context', async () => {
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
      listJobs: vi.fn(() => []),
      listAlwaysLoadedDefinitions: vi.fn(() => []),
      listCodeSessionEagerToolDefinitions: vi.fn(() => [
        {
          name: 'code_remote_exec',
          description: 'Run a command in the remote sandbox.',
          shortDescription: 'Remote exec',
          risk: 'mutating',
          category: 'coding',
          parameters: { type: 'object', properties: {} },
        },
      ]),
      getToolDefinition: vi.fn(() => ({
        name: 'code_remote_exec',
        description: 'Run a command in the remote sandbox.',
        shortDescription: 'Remote exec',
        risk: 'mutating',
        category: 'coding',
        parameters: { type: 'object', properties: {} },
      })),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>, request: Record<string, unknown>) => {
        expect(args).toMatchObject({
          command: 'npm test',
          profile: 'Daytona',
        });
        expect(request.codeContext).toMatchObject({
          workspaceRoot: '/repo',
          sessionId: 'session-123',
        });
        return {
          success: true,
          output: {
            stdout: 'tests ok',
            stderr: '',
          },
        };
      }),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).fallbackChain = {
      chatWithProviderOrder: vi.fn()
        .mockResolvedValueOnce({
          providerName: 'ollama-cloud-coding',
          usedFallback: false,
          skipped: [],
          response: {
            content: '',
            toolCalls: [
              {
                id: 'tool-call-2',
                name: 'code_remote_exec',
                arguments: JSON.stringify({ command: 'npm test' }),
              },
            ],
            model: 'gpt-oss:120b',
            finishReason: 'tool_calls',
          },
        })
        .mockResolvedValueOnce({
          providerName: 'ollama-cloud-coding',
          usedFallback: false,
          skipped: [],
          response: {
            content: 'Remote sandbox sequence completed.',
            toolCalls: [],
            model: 'gpt-oss:120b',
            finishReason: 'stop',
          },
        }),
    };

    const selectedExecutionProfile = {
      id: 'managed_cloud_tool' as const,
      providerName: 'ollama-cloud-coding',
      providerType: 'ollama_cloud',
      providerModel: 'gpt-oss:120b',
      providerLocality: 'external' as const,
      providerTier: 'managed_cloud' as const,
      requestedTier: 'external' as const,
      preferredAnswerPath: 'tool_loop' as const,
      expectedContextPressure: 'medium' as const,
      contextBudget: 80000,
      toolContextMode: 'tight' as const,
      maxAdditionalSections: 2,
      maxRuntimeNotices: 2,
      fallbackProviderOrder: ['ollama-cloud-coding'],
      reason: 'coding profile',
    };
    const originalMetadata = attachSelectedExecutionProfileMetadata({
      codeContext: {
        workspaceRoot: '/repo',
        sessionId: 'session-123',
      },
    }, selectedExecutionProfile);
    const pendingAction: PendingActionRecord = {
      id: 'pending-remote-1',
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
        prompt: 'Approve remote execution.',
        approvalIds: ['approval-1'],
      },
      intent: {
        route: 'coding_task',
        operation: 'run',
        originalUserContent: 'Run npm ci and then npm test in the same remote sandbox.',
        entities: {
          codingRemoteExecRequested: true,
          profileId: 'Daytona',
        },
      },
      resume: {
        kind: 'tool_loop',
        payload: (agent as any).buildToolLoopResumePayload({
          llmMessages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'Run npm ci and then npm test in the same remote sandbox.' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'tool-call-1',
                  name: 'code_remote_exec',
                  arguments: JSON.stringify({ command: 'npm ci', profile: 'Daytona' }),
                },
              ],
            },
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
            id: 'msg-remote-1',
            userId: 'owner',
            channel: 'web',
            surfaceId: 'owner',
            principalId: 'owner',
            principalRole: 'owner',
            content: 'Run npm ci and then npm test in the same remote sandbox.',
            timestamp: 1_710_000_000_000,
            metadata: originalMetadata,
          },
          requestText: 'Run npm ci and then npm test in the same remote sandbox.',
          referenceTime: 1_710_000_000_000,
          allowModelMemoryMutation: false,
          activeSkillIds: [],
          contentTrustLevel: 'trusted',
          taintReasons: [],
          intentDecision: {
            route: 'coding_task',
            operation: 'run',
            summary: 'Run remote sandbox commands.',
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
            entities: {
              codingRemoteExecRequested: true,
              profileId: 'Daytona',
            },
          },
          codeContext: {
            workspaceRoot: '/repo',
            sessionId: 'session-123',
          },
          selectedExecutionProfile,
        }),
      },
      codeSessionId: 'session-123',
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
        message: "Tool 'code_remote_exec' completed.",
        result: {
          success: true,
          status: 'succeeded',
          output: {
            stdout: 'installed',
            stderr: '',
            leaseId: 'lease-1',
            sandboxId: 'sandbox-1',
          },
        },
      },
    );

    expect(result?.content).toBe('Remote sandbox sequence completed.');
    expect(tools.executeModelTool).toHaveBeenCalledTimes(1);
  });

  it('suspends a multi-step remote sandbox turn with only the first remote step pending approval', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const pendingActionStore = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-chat-agent-remote-sequencing.test.sqlite',
      now: () => 1_710_000_000_000,
    });
    const llm = {
      name: 'ollama_cloud',
      chat: vi.fn(async () => ({
        content: '',
        toolCalls: [
          {
            id: 'tool-call-1',
            name: 'code_remote_exec',
            arguments: JSON.stringify({ command: 'npm ci' }),
          },
          {
            id: 'tool-call-2',
            name: 'code_remote_exec',
            arguments: JSON.stringify({ command: 'npm test' }),
          },
        ],
        model: 'gpt-oss:120b',
        finishReason: 'tool_calls',
      })),
    };
    const tools = {
      isEnabled: vi.fn(() => true),
      getRuntimeNotices: vi.fn(() => []),
      getToolContext: vi.fn(() => ''),
      listAlwaysLoadedDefinitions: vi.fn(() => []),
      listCodeSessionEagerToolDefinitions: vi.fn(() => [
        {
          name: 'code_remote_exec',
          description: 'Run a command in the remote sandbox.',
          shortDescription: 'Remote exec',
          risk: 'mutating',
          category: 'coding',
          parameters: { type: 'object', properties: {} },
        },
      ]),
      getToolDefinition: vi.fn(() => ({
        name: 'code_remote_exec',
        description: 'Run a command in the remote sandbox.',
        shortDescription: 'Remote exec',
        risk: 'mutating',
        category: 'coding',
        parameters: { type: 'object', properties: {} },
      })),
      executeModelTool: vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
        expect(args).toMatchObject({
          command: 'npm ci',
          profile: 'Daytona',
        });
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-1',
          jobId: 'job-1',
          message: 'Approval required.',
        };
      }),
      getApprovalSummaries: vi.fn(() => new Map([
        ['approval-1', {
          toolName: 'code_remote_exec',
          argsPreview: '{"command":"npm ci","profile":"Daytona"}',
          actionLabel: 'run npm ci remotely',
        }],
      ])),
      listPendingApprovalIdsForUser: vi.fn(() => []),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    (agent as any).pendingActionStore = pendingActionStore;

    const response = await agent.onMessage({
      id: 'msg-remote-sequencing',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
      content: 'In the current coding workspace, run `npm ci` in the remote sandbox using the Daytona profile for this coding session, then run `npm test` in the same remote sandbox.',
      timestamp: 1_710_000_000_000,
      metadata: attachSelectedExecutionProfileMetadata(
        attachPreRoutedIntentGatewayMetadata(
          {
            codeContext: {
              workspaceRoot: '/repo',
              sessionId: 'session-123',
            },
          },
          {
            available: true,
            mode: 'primary',
            model: 'test-model',
            latencyMs: 1,
            decision: {
              route: 'coding_task',
              operation: 'run',
              summary: 'Run repo commands in the remote sandbox.',
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
              entities: {
                codingRemoteExecRequested: true,
                profileId: 'Daytona',
              },
            },
          },
        ),
        {
          id: 'managed_cloud_tool',
          providerName: 'ollama-cloud-coding',
          providerType: 'ollama_cloud',
          providerModel: 'gpt-oss:120b',
          providerLocality: 'external',
          providerTier: 'managed_cloud',
          requestedTier: 'external',
          preferredAnswerPath: 'tool_loop',
          expectedContextPressure: 'medium',
          contextBudget: 80000,
          toolContextMode: 'tight',
          maxAdditionalSections: 2,
          maxRuntimeNotices: 2,
          fallbackProviderOrder: ['ollama-cloud-coding'],
          reason: 'coding profile',
        },
      ),
    }, {
      agentId: 'chat',
      emit: vi.fn(async () => {}),
      llm: llm as never,
      checkAction: vi.fn(),
      capabilities: [],
    });

    expect(response.metadata?.pendingAction).toBeTruthy();
    expect(tools.executeModelTool).toHaveBeenCalledTimes(1);
    const pending = pendingActionStore.getActive({
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'owner',
    });
    expect(pending?.resume?.kind).toBe('tool_loop');
    expect(pending?.resume?.payload).toMatchObject({
      pendingTools: [
        {
          approvalId: 'approval-1',
          toolCallId: 'tool-call-1',
          jobId: 'job-1',
          name: 'code_remote_exec',
        },
      ],
    });
    expect(((pending?.resume?.payload as Record<string, unknown>).llmMessages as Array<Record<string, unknown>>)
      .find((message) => message.role === 'assistant')?.toolCalls).toEqual([
      {
        id: 'tool-call-1',
        name: 'code_remote_exec',
        arguments: JSON.stringify({ command: 'npm ci' }),
      },
    ]);
  });

  it('replays failed approval-backed remote tool results into the resumed tool loop', async () => {
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
      listJobs: vi.fn(() => []),
      listAlwaysLoadedDefinitions: vi.fn(() => []),
      listCodeSessionEagerToolDefinitions: vi.fn(() => [
        {
          name: 'code_remote_exec',
          description: 'Run a command in the remote sandbox.',
          shortDescription: 'Remote exec',
          risk: 'mutating',
          category: 'coding',
          parameters: { type: 'object', properties: {} },
        },
      ]),
      getToolDefinition: vi.fn(() => ({
        name: 'code_remote_exec',
        description: 'Run a command in the remote sandbox.',
        shortDescription: 'Remote exec',
        risk: 'mutating',
        category: 'coding',
        parameters: { type: 'object', properties: {} },
      })),
      getApprovalSummaries: vi.fn(() => new Map()),
    };
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools as never);
    const fallbackChain = {
      chatWithProviderOrder: vi.fn(async (_providerOrder: string[], msgs: Array<{ role: string; content?: string }>) => {
        const replayedFailure = msgs.find((message) =>
          message.role === 'tool'
          && typeof message.content === 'string'
          && message.content.includes('"stderr":"OOM"'),
        );
        expect(replayedFailure).toBeTruthy();
        return {
          providerName: 'ollama-cloud-coding',
          usedFallback: false,
          skipped: [],
          response: {
            content: 'Observed the remote sandbox failure.',
            toolCalls: [],
            model: 'gpt-oss:120b',
            finishReason: 'stop',
          },
        };
      }),
    };
    (agent as any).fallbackChain = fallbackChain;

    const selectedExecutionProfile = {
      id: 'managed_cloud_tool' as const,
      providerName: 'ollama-cloud-coding',
      providerType: 'ollama_cloud',
      providerModel: 'gpt-oss:120b',
      providerLocality: 'external' as const,
      providerTier: 'managed_cloud' as const,
      requestedTier: 'external' as const,
      preferredAnswerPath: 'tool_loop' as const,
      expectedContextPressure: 'medium' as const,
      contextBudget: 80000,
      toolContextMode: 'tight' as const,
      maxAdditionalSections: 2,
      maxRuntimeNotices: 2,
      fallbackProviderOrder: ['ollama-cloud-coding'],
      reason: 'coding profile',
    };
    const originalMetadata = attachSelectedExecutionProfileMetadata({
      codeContext: {
        workspaceRoot: '/repo',
        sessionId: 'session-123',
      },
    }, selectedExecutionProfile);
    const pendingAction: PendingActionRecord = {
      id: 'pending-remote-failure-1',
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
        prompt: 'Approve remote execution.',
        approvalIds: ['approval-1'],
      },
      intent: {
        route: 'coding_task',
        operation: 'run',
        originalUserContent: 'Run npm ci and then npm test in the same remote sandbox.',
        entities: {
          codingRemoteExecRequested: true,
          profileId: 'Daytona',
        },
      },
      resume: {
        kind: 'tool_loop',
        payload: (agent as any).buildToolLoopResumePayload({
          llmMessages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'Run npm ci and then npm test in the same remote sandbox.' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'tool-call-1',
                  name: 'code_remote_exec',
                  arguments: JSON.stringify({ command: 'npm ci', profile: 'Daytona' }),
                },
              ],
            },
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
            id: 'msg-remote-failure-1',
            userId: 'owner',
            channel: 'web',
            surfaceId: 'owner',
            principalId: 'owner',
            principalRole: 'owner',
            content: 'Run npm ci and then npm test in the same remote sandbox.',
            timestamp: 1_710_000_000_000,
            metadata: originalMetadata,
          },
          requestText: 'Run npm ci and then npm test in the same remote sandbox using the Daytona profile.',
          referenceTime: 1_710_000_000_000,
          allowModelMemoryMutation: false,
          activeSkillIds: [],
          contentTrustLevel: 'trusted',
          taintReasons: [],
          intentDecision: {
            route: 'coding_task',
            operation: 'run',
            summary: 'Run remote sandbox commands.',
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
            entities: {
              codingRemoteExecRequested: true,
              profileId: 'Daytona',
            },
          },
          codeContext: {
            workspaceRoot: '/repo',
            sessionId: 'session-123',
          },
          selectedExecutionProfile,
        }),
      },
      codeSessionId: 'session-123',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    };

    const result = await (agent as any).continueDirectRouteAfterApproval(
      pendingAction,
      'approval-1',
      'approved',
      {
        success: false,
        message: "Tool 'code_remote_exec' failed.",
        result: {
          success: false,
          error: 'Remote sandbox command failed on Daytona Main.',
          output: {
            stdout: '',
            stderr: 'OOM',
            leaseId: 'lease-1',
            sandboxId: 'sandbox-1',
            leaseMode: 'managed',
          },
        },
      },
    );

    expect(result?.content).toBe('Observed the remote sandbox failure.');
    expect(fallbackChain.chatWithProviderOrder).toHaveBeenCalledTimes(1);
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

  it('replays the last actionable request for natural recovery follow-ups after provider connection failures', () => {
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
          content: 'I’m unable to fetch Google Calendar data because the Google Workspace integration isn’t currently connected in this environment.',
        },
      ]),
    };

    const result = (agent as any).resolveRetryAfterFailureContinuationContent(
      'It is connected now.',
      {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        lastActionableRequest: 'List my Google Calendar entries for the next 7 days.',
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
      {
        agentId: 'chat',
        userId: 'owner',
        channel: 'telegram',
      },
    );

    expect(result).toBe('List my Google Calendar entries for the next 7 days.');
  });
});
