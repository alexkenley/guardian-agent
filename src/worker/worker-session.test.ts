import { describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '../llm/types.js';
import { BrokeredWorkerSession } from './worker-session.js';

const baseParams = {
  systemPrompt: 'system',
  history: [],
  knowledgeBase: '',
  activeSkills: [],
  toolContext: '',
  runtimeNotices: [],
};

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
});
