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
      responseSource: {
        locality: 'external',
        providerName: 'anthropic',
      },
    });
    expect(result.metadata).not.toHaveProperty('pendingApprovals');
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
    expect(resumed.content).toContain('I have generated and executed a DAG plan');
    expect(resumed.content).toContain('"status": "completed"');
    expect(resumed.content).toContain('"search-repo"');
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
    expect(result.content).toContain('cannot safely execute');
    expect(result.content).toContain('delegate_task');
  });
});
