import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import type { AgentContext, UserMessage } from './agent/types.js';
import { createChatAgentClass } from './chat-agent.js';
import { ConversationService, type ConversationKey } from './runtime/conversation.js';
import { PendingActionStore, type PendingActionRecord } from './runtime/pending-actions.js';
import { ExecutionGraphStore } from './runtime/execution-graph/graph-store.js';
import { recordGraphPendingActionInterrupt } from './runtime/execution-graph/pending-action-adapter.js';
import { recordChatContinuationGraphApproval } from './runtime/chat-agent/chat-continuation-graph.js';
import { CAPABILITY_CONTINUATION_TYPE_FILESYSTEM_SAVE_OUTPUT } from './runtime/chat-agent/capability-continuation-resume.js';
import type { ToolPolicySnapshot } from './tools/types.js';

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    rmSync(file, { force: true });
  }
});

function createSQLitePath(prefix: string): string {
  const file = join(tmpdir(), `guardianagent-${prefix}-${randomUUID()}.sqlite`);
  createdFiles.push(file);
  return file;
}

function createConversationService(): ConversationService {
  return new ConversationService({
    enabled: true,
    sqlitePath: createSQLitePath('conversation'),
    maxTurns: 6,
    maxMessageChars: 1000,
    maxContextChars: 5000,
    retentionDays: 30,
  });
}

function createPendingActionStore(): PendingActionStore {
  return new PendingActionStore({
    enabled: true,
    sqlitePath: createSQLitePath('pending-actions'),
  });
}

function createCtx(): AgentContext {
  return {
    agentId: 'chat',
    emit: vi.fn(async () => {}),
    llm: { name: 'ollama' } as never,
    checkAction: vi.fn(),
    capabilities: [],
  };
}

function createMessage(content: string): UserMessage {
  return {
    id: 'msg-1',
    userId: 'owner',
    channel: 'web',
    surfaceId: 'web-guardian-chat',
    content,
    timestamp: Date.now(),
  };
}

function createPolicy(): ToolPolicySnapshot {
  return {
    mode: 'approve_by_policy',
    toolPolicies: {},
    sandbox: {
      allowedPaths: ['S:\\Development\\GuardianAgent'],
      allowedCommands: [],
      allowedDomains: [],
    },
  };
}

function createFilesystemGraphPendingAction(input: {
  approvalId: string;
  targetPath: string;
  content: string;
  originalUserContent: string;
  codeContext?: { workspaceRoot: string; sessionId?: string };
}): {
  pendingAction: PendingActionRecord;
  pendingActionStore: PendingActionStore;
  executionGraphStore: ExecutionGraphStore;
} {
  const pendingActionStore = createPendingActionStore();
  const executionGraphStore = new ExecutionGraphStore();
  const result = recordChatContinuationGraphApproval({
    graphStore: executionGraphStore,
    userKey: 'owner:web',
    userId: 'owner',
    channel: 'web',
    surfaceId: 'web-guardian-chat',
    agentId: 'chat',
    requestId: 'msg-resume',
    action: {
      prompt: 'Approve path change',
      approvalIds: [input.approvalId],
      originalUserContent: input.originalUserContent,
      route: 'filesystem_task',
      operation: 'save',
      summary: 'Resume the file save after path approval.',
      turnRelation: 'new_request',
      resolution: 'ready',
      continuation: {
        type: CAPABILITY_CONTINUATION_TYPE_FILESYSTEM_SAVE_OUTPUT,
        targetPath: input.targetPath,
        content: input.content,
        originalUserContent: input.originalUserContent,
        codeContext: input.codeContext,
        allowPathRemediation: false,
      },
    },
    setGraphPendingActionForRequest: (_userKey, _surfaceId, action, nowMs) => ({
      action: recordGraphPendingActionInterrupt({
        store: pendingActionStore,
        scope: {
          agentId: 'chat',
          userId: 'owner',
          channel: 'web',
          surfaceId: 'web-guardian-chat',
        },
        event: action.event,
        originalUserContent: action.originalUserContent,
        intent: action.intent,
        artifactRefs: action.artifactRefs,
        approvalSummaries: action.approvalSummaries,
        transferPolicy: action.transferPolicy,
        expiresAt: action.expiresAt,
        nowMs,
      }),
    }),
    nowMs: 1,
  });
  if (!result.action) {
    throw new Error('Expected graph pending action');
  }
  return { pendingAction: result.action, pendingActionStore, executionGraphStore };
}

describe('LLMChatAgent direct filesystem save', () => {
  it('stores a resumable pending action with the full previous assistant output when path approval is required', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const conversationService = createConversationService();
    const pendingActionStore = createPendingActionStore();
    const executeModelTool = vi.fn(async (toolName: string) => {
      if (toolName === 'fs_write') {
        return {
          success: false,
          message: 'Path \'S:\\Development\\test5\' is outside allowed paths. Allowed roots: S:\\Development\\GuardianAgent. Use the update_tool_policy tool to add the path.',
        };
      }
      if (toolName === 'update_tool_policy') {
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-path-1',
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });
    const tools = {
      isEnabled: () => true,
      getPolicy: () => createPolicy(),
      executeModelTool,
      getApprovalSummaries: () => new Map([
        ['approval-path-1', {
          toolName: 'update_tool_policy',
          argsPreview: '{"action":"add_path","value":"S:\\\\Development"}',
          actionLabel: 'add S:\\Development',
        }],
      ]),
    } as never;
    const executionGraphStore = new ExecutionGraphStore();
    const agent = new ChatAgent(
      'chat',
      'Chat',
      undefined,
      conversationService,
      tools,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chat',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pendingActionStore,
    );
    agent.capabilityExecutionGraphStore = executionGraphStore;
    const conversationKey: ConversationKey = {
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
    };
    const previousOutput = 'Top 3 risks:\n1. Replayable approval outcome.\n2. Policy bypass via broker.\n3. Stuck running lifecycle.';
    conversationService.recordTurn(conversationKey, 'Review the security files.', previousOutput);

    const response = await (agent as any).tryDirectFilesystemIntent(
      createMessage('Can you save that last output to a file called test5 in S:\\Development'),
      createCtx(),
      'owner:web',
      conversationKey,
      undefined,
      undefined,
      {
        route: 'filesystem_task',
        operation: 'save',
        summary: 'Save the last output.',
        confidence: 'high',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: { path: 'S:\\Development' },
      },
    );

    expect(typeof response === 'string' ? response : response.content).toContain('add "S:\\Development" to the allowed paths');
    const pendingAction = (agent as any).getActivePendingAction('owner', 'web', 'web-guardian-chat') as PendingActionRecord | null;
    expect(pendingAction?.resume?.kind).toBe('execution_graph');
    const artifactId = pendingAction?.graphInterrupt?.artifactRefs[0]?.artifactId;
    expect(artifactId).toBeTruthy();
    expect(executionGraphStore.getArtifact(pendingAction!.graphInterrupt!.graphId, artifactId!)).toMatchObject({
      artifactType: 'ChatContinuation',
      content: {
        payload: {
          type: 'filesystem_save_output',
          targetPath: 'S:\\Development\\test5',
          content: previousOutput,
          originalUserContent: 'Can you save that last output to a file called test5 in S:\\Development',
          allowPathRemediation: false,
        },
      },
    });

    conversationService.close();
    pendingActionStore.close();
  });

  it('continues a stored capability save after path approval using the captured output snapshot', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const executeModelTool = vi.fn(async () => ({
      success: true,
      output: {
        path: 'S:\\Development\\test5',
        append: false,
        size: 27,
      },
    }));
    const tools = {
      isEnabled: () => true,
      executeModelTool,
    } as never;
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'chat');
    const { pendingAction, pendingActionStore, executionGraphStore } = createFilesystemGraphPendingAction({
      approvalId: 'approval-path-1',
      targetPath: 'S:\\Development\\test5',
      content: 'full assistant output snapshot',
      originalUserContent: 'Save that last output to test5',
      codeContext: {
        workspaceRoot: 'S:\\Development\\GuardianAgent',
        sessionId: 'code-session-1',
      },
    });
    agent.pendingActionStore = pendingActionStore;
    agent.capabilityExecutionGraphStore = executionGraphStore;

    const response = await agent.continuePendingActionAfterApproval(pendingAction, 'approval-path-1', 'approved', {
      success: true,
      approved: true,
      message: 'Approved.',
    });
    pendingActionStore.close();

    expect(response?.content).toBe('I saved the previous assistant output to `S:\\Development\\test5`.');
    expect(executeModelTool).toHaveBeenCalledWith(
      'fs_write',
      {
        path: 'S:\\Development\\test5',
        content: 'full assistant output snapshot',
        append: false,
      },
      expect.objectContaining({
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      }),
    );
    expect(executeModelTool.mock.calls[0]?.[2]).not.toHaveProperty('codeContext');
  });

  it('keeps code workspace scoping when the direct save target stays inside the attached workspace', async () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const executeModelTool = vi.fn(async () => ({
      success: true,
      output: {
        path: 'S:\\Development\\GuardianAgent\\artifacts\\review.txt',
        append: false,
        size: 27,
      },
    }));
    const tools = {
      isEnabled: () => true,
      executeModelTool,
    } as never;
    const agent = new ChatAgent('chat', 'Chat', undefined, undefined, tools, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'chat');
    const { pendingAction, pendingActionStore, executionGraphStore } = createFilesystemGraphPendingAction({
      approvalId: 'approval-write-1',
      targetPath: 'S:\\Development\\GuardianAgent\\artifacts\\review.txt',
      content: 'full assistant output snapshot',
      originalUserContent: 'Save that last output to review.txt',
      codeContext: {
        workspaceRoot: 'S:\\Development\\GuardianAgent',
        sessionId: 'code-session-1',
      },
    });
    agent.pendingActionStore = pendingActionStore;
    agent.capabilityExecutionGraphStore = executionGraphStore;

    const response = await agent.continuePendingActionAfterApproval(pendingAction, 'approval-write-1', 'approved', {
      success: true,
      approved: true,
      message: 'Approved.',
    });
    pendingActionStore.close();

    expect(response?.content).toBe('I saved the previous assistant output to `S:\\Development\\GuardianAgent\\artifacts\\review.txt`.');
    expect(executeModelTool.mock.calls[0]?.[2]).toMatchObject({
      codeContext: {
        workspaceRoot: 'S:\\Development\\GuardianAgent',
        sessionId: 'code-session-1',
      },
    });
  });

  it('uses stored clarification resolved content for generic yes continuations', () => {
    const ChatAgent = createChatAgentClass({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const agent = new ChatAgent('chat', 'Chat');
    const pendingAction: PendingActionRecord = {
      id: 'pending-clarification-1',
      scope: {
        agentId: 'chat',
        userId: 'owner',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      },
      status: 'pending',
      transferPolicy: 'linked_surfaces_same_user',
      blocker: {
        kind: 'clarification',
        field: 'filesystem_target',
        prompt: 'Do you want me to save it to the workspace path instead?',
      },
      intent: {
        route: 'filesystem_task',
        operation: 'save',
        originalUserContent: 'Save the last output to S:\\Development\\test5',
        resolvedContent: 'Save the last output to S:\\Development\\GuardianAgent\\test5 instead.',
      },
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    };

    expect((agent as any).resolvePendingActionContinuationContent('Yes', pendingAction)).toBe(
      'Save the last output to S:\\Development\\GuardianAgent\\test5 instead.',
    );
  });
});
