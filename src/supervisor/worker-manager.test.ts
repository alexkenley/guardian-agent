import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const workerNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];
let workerMessageHandler:
  | ((params: Record<string, unknown>) => { content: string; metadata?: Record<string, unknown> })
  | undefined;

function approvalPendingActionMetadata(
  approvals: Array<{ id: string; toolName: string; argsPreview?: string }>,
): Record<string, unknown> {
  return {
    pendingAction: {
      status: 'pending',
      blocker: {
        kind: 'approval',
        prompt: 'Waiting for approval.',
        approvalSummaries: approvals.map((approval) => ({
          argsPreview: '{}',
          ...approval,
        })),
      },
    },
  };
}

class FakeWorkerChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');

    let buffer = '';
    this.stdin.on('data', (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const newlineIndex = buffer.indexOf('\n');
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { method?: string; params?: Record<string, unknown> };
        if (!message.method) continue;
        workerNotifications.push({ method: message.method, params: message.params ?? {} });
        if (message.method === 'worker.initialize') {
          this.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'worker.ready',
            params: { agentId: String(message.params?.agentId ?? 'unknown') },
          })}\n`);
        }
        if (message.method === 'message.handle') {
          const response = workerMessageHandler?.(message.params ?? {}) ?? { content: 'ok' };
          this.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'message.response',
            params: response,
          })}\n`);
        }
      }
    });
  }

  kill(): boolean {
    this.emit('exit', 0, null);
    return true;
  }
}

vi.mock('../sandbox/index.js', () => ({
  sandboxedSpawn: vi.fn(async () => new FakeWorkerChild()),
  detectSandboxHealth: vi.fn(async () => ({ availability: 'degraded' })),
  DEFAULT_SANDBOX_CONFIG: {
    resourceLimits: {
      maxMemoryMb: 2048,
      maxCpuSeconds: 0,
    },
  },
}));

describe('WorkerManager', () => {
  beforeEach(() => {
    workerNotifications.length = 0;
    workerMessageHandler = undefined;
    vi.clearAllMocks();
  });

  it('refreshes the capability token when reusing a live worker', async () => {
    const { WorkerManager } = await import('./worker-manager.js');
    const sandbox = await import('../sandbox/index.js');

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        auditLog: { record: vi.fn() },
      } as never,
      {
        workerEntryPoint: 'src/worker/worker-entry.ts',
        workerMaxMemoryMb: 2048,
        workerIdleTimeoutMs: 300_000,
        workerShutdownGracePeriodMs: 10,
        capabilityTokenTtlMs: 600_000,
        capabilityTokenMaxToolCalls: 0,
      } as never,
    );

    const baseRequest = {
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm1',
        userId: 'tester',
        channel: 'web',
        content: 'hello',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBase: '',
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
    };

    await manager.handleMessage(baseRequest);
    const firstSpawnArgs = vi.mocked(sandbox.sandboxedSpawn).mock.calls[0]?.[1] ?? [];
    const firstSpawnSandboxConfig = vi.mocked(sandbox.sandboxedSpawn).mock.calls[0]?.[2];
    expect(firstSpawnArgs[0]).toBe('--import');
    expect(String(firstSpawnArgs[1]).replaceAll('\\', '/')).toContain('node_modules/tsx/dist/loader.mjs');
    expect(firstSpawnSandboxConfig?.resourceLimits?.maxMemoryMb).toBe(0);
    const normalizedReadPaths = (firstSpawnSandboxConfig?.additionalReadPaths ?? [])
      .map((value) => String(value).replaceAll('\\', '/'));
    const expectedRepoRoot = resolve(process.cwd()).replaceAll('\\', '/');
    expect(
      normalizedReadPaths,
    ).toContain(expectedRepoRoot);
    workerNotifications.length = 0;

    await manager.handleMessage({
      ...baseRequest,
      message: {
        ...baseRequest.message,
        id: 'm2',
        content: 'second message',
      },
    });

    expect(workerNotifications.map((entry) => entry.method)).toEqual([
      'capability.refreshed',
      'message.handle',
    ]);
    expect(typeof workerNotifications[0]?.params.capabilityToken).toBe('string');

    manager.shutdown();
  });

  it('forwards structured prompt-assembly context to the worker', async () => {
    const { WorkerManager } = await import('./worker-manager.js');
    const sandbox = await import('../sandbox/index.js');

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        auditLog: { record: vi.fn() },
      } as never,
      {
        workerEntryPoint: 'src/worker/worker-entry.ts',
        workerMaxMemoryMb: 2048,
        workerIdleTimeoutMs: 300_000,
        workerShutdownGracePeriodMs: 10,
        capabilityTokenTtlMs: 600_000,
        capabilityTokenMaxToolCalls: 0,
      } as never,
    );

    await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-context',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        content: 'Continue the current task.',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [{ role: 'user', content: 'Earlier request.' }],
      knowledgeBase: 'Remembered preference.',
      knowledgeBaseScope: 'coding_session',
      activeSkills: [{ id: 'writing-plans', name: 'Writing Plans', description: 'plan helper', summary: 'Creates plans.', sourcePath: '/tmp/skill', score: 1 }],
      toolContext: 'Allowed roots: /tmp',
      runtimeNotices: [{ level: 'info', message: 'Notice one' }],
      continuity: {
        continuityKey: 'continuity-1',
        linkedSurfaceCount: 2,
        focusSummary: 'Continue the same task.',
      },
      pendingAction: {
        kind: 'clarification',
        prompt: 'Which provider should I use?',
        field: 'email_provider',
        transferPolicy: 'linked_surfaces_same_user',
      },
      pendingApprovalNotice: 'One unrelated approval is pending.',
    });

    const notification = workerNotifications.find((entry) => entry.method === 'message.handle');
    expect(notification?.params).toMatchObject({
      knowledgeBase: 'Remembered preference.',
      knowledgeBaseScope: 'coding_session',
      toolContext: 'Allowed roots: /tmp',
      runtimeNotices: [{ level: 'info', message: 'Notice one' }],
      continuity: {
        continuityKey: 'continuity-1',
        linkedSurfaceCount: 2,
        focusSummary: 'Continue the same task.',
      },
      pendingAction: {
        kind: 'clarification',
        prompt: 'Which provider should I use?',
        field: 'email_provider',
        transferPolicy: 'linked_surfaces_same_user',
      },
      pendingApprovalNotice: 'One unrelated approval is pending.',
    });
    expect(vi.mocked(sandbox.sandboxedSpawn)).toHaveBeenCalledTimes(1);

    manager.shutdown();
  });

  it('tracks delegated worker lineage and bounded handoff summaries in job state', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = () => ({
      content: 'Updated the importer validation flow and left one approval pending for the final write.',
      metadata: {
        responseSource: {
          locality: 'external',
          providerName: 'fallback-provider',
        },
        pendingAction: {
          blocker: {
            kind: 'approval',
            approvalSummaries: [
              { id: 'approval-1', toolName: 'fs_write', argsPreview: '{"path":"./tmp/out.md"}' },
            ],
          },
        },
      },
    });

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
      } as never,
      {
        getFallbackProviderConfig: () => ({ provider: 'fallback' }),
        auditLog: { record: vi.fn() },
      } as never,
      {
        workerEntryPoint: 'src/worker/worker-entry.ts',
        workerMaxMemoryMb: 2048,
        workerIdleTimeoutMs: 300_000,
        workerShutdownGracePeriodMs: 10,
        capabilityTokenTtlMs: 600_000,
        capabilityTokenMaxToolCalls: 0,
      } as never,
    );

    await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-delegated',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        surfaceId: 'web-chat',
        content: 'Continue the importer repair.',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBase: '',
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      delegation: {
        requestId: 'm-delegated',
        originChannel: 'web',
        originSurfaceId: 'web-chat',
        continuityKey: 'continuity-1',
        activeExecutionRefs: ['code_session:Repo Fix'],
        pendingActionId: 'pending-1',
        codeSessionId: 'code-1',
      },
    });

    const state = manager.getJobState(5);
    expect(state.summary.total).toBe(1);
    expect(state.jobs[0]).toMatchObject({
      type: 'delegated_worker',
      status: 'succeeded',
      metadata: {
        delegation: {
          kind: 'brokered_worker',
          lifecycle: 'blocked',
          requestId: 'm-delegated',
          originChannel: 'web',
          originSurfaceId: 'web-chat',
          continuityKey: 'continuity-1',
          activeExecutionRefs: ['code_session:Repo Fix'],
          pendingActionId: 'pending-1',
          codeSessionId: 'code-1',
          handoff: {
            unresolvedBlockerKind: 'approval',
            approvalCount: 1,
            reportingMode: 'held_for_approval',
          },
        },
      },
    });
    expect((state.jobs[0]?.detail ?? '')).toContain('Updated the importer validation flow');

    manager.shutdown();
  });

  it('normalizes clarification-blocked delegated responses into status-only output', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = () => ({
      content: 'I need you to choose which mail provider to use before I continue.',
      metadata: {
        pendingAction: {
          blocker: {
            kind: 'clarification',
            prompt: 'Which provider should I use?',
          },
        },
      },
    });

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        auditLog: { record: vi.fn() },
      } as never,
      {
        workerEntryPoint: 'src/worker/worker-entry.ts',
        workerMaxMemoryMb: 2048,
        workerIdleTimeoutMs: 300_000,
        workerShutdownGracePeriodMs: 10,
        capabilityTokenTtlMs: 600_000,
        capabilityTokenMaxToolCalls: 0,
      } as never,
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-status-only',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        content: 'Continue the draft workflow.',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBase: '',
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      delegation: {
        requestId: 'm-status-only',
        originChannel: 'web',
      },
    });

    expect(result.content).toContain('Delegated work is paused: clarification required.');
    expect(result.content).toContain('Which provider should I use?');
    expect(result.metadata).toMatchObject({
      delegatedHandoff: {
        reportingMode: 'status_only',
        unresolvedBlockerKind: 'clarification',
      },
    });

    manager.shutdown();
  });

  it('keeps approval-blocked delegated responses inline while exposing follow-up metadata', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = () => ({
      content: 'Waiting for approval to write the final report.',
      metadata: {
        pendingAction: {
          blocker: {
            kind: 'approval',
            approvalSummaries: [
              { id: 'approval-write-1', toolName: 'fs_write', argsPreview: '{"path":"./report.md"}' },
            ],
          },
        },
      },
    });

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        auditLog: { record: vi.fn() },
      } as never,
      {
        workerEntryPoint: 'src/worker/worker-entry.ts',
        workerMaxMemoryMb: 2048,
        workerIdleTimeoutMs: 300_000,
        workerShutdownGracePeriodMs: 10,
        capabilityTokenTtlMs: 600_000,
        capabilityTokenMaxToolCalls: 0,
      } as never,
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-held-approval',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        content: 'Continue the report export.',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBase: '',
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      delegation: {
        requestId: 'm-held-approval',
        originChannel: 'web',
      },
    });

    expect(result.content).toBe('Waiting for approval to write the final report.');
    expect(result.metadata).toMatchObject({
      delegatedHandoff: {
        reportingMode: 'held_for_approval',
        unresolvedBlockerKind: 'approval',
        approvalCount: 1,
      },
    });

    manager.shutdown();
  });

  it('holds long-running delegated results for operator replay and dismissal', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = () => ({
      content: 'Digest complete.\n- README reviewed\n- package.json reviewed',
      metadata: {},
    });

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        auditLog: { record: vi.fn() },
        outputGuardian: {
          scanResponse: vi.fn((content: string) => ({ clean: true, secrets: [], sanitized: content })),
        },
      } as never,
      {
        workerEntryPoint: 'src/worker/worker-entry.ts',
        workerMaxMemoryMb: 2048,
        workerIdleTimeoutMs: 300_000,
        workerShutdownGracePeriodMs: 10,
        capabilityTokenTtlMs: 600_000,
        capabilityTokenMaxToolCalls: 0,
      } as never,
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-held-operator',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        content: 'Run the long repository digest.',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBase: '',
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      delegation: {
        requestId: 'm-held-operator',
        originChannel: 'web',
        runClass: 'long_running',
      },
    });

    expect(result.content).toContain('Delegated work completed and is held for operator review.');
    expect(result.metadata).toMatchObject({
      delegatedHandoff: {
        reportingMode: 'held_for_operator',
        runClass: 'long_running',
        operatorState: 'pending',
      },
    });

    const state = manager.getJobState(5);
    const jobId = state.jobs[0]?.id;
    expect(jobId).toBeTruthy();
    expect(state.jobs[0]?.metadata).toMatchObject({
      delegation: {
        runClass: 'long_running',
        handoff: {
          reportingMode: 'held_for_operator',
          operatorState: 'pending',
        },
      },
    });

    const replayed = manager.applyJobFollowUpAction(jobId!, 'replay');
    expect(replayed).toMatchObject({
      success: true,
      details: {
        content: 'Digest complete.\n- README reviewed\n- package.json reviewed',
        redacted: false,
      },
    });

    const afterReplay = manager.getJobState(5);
    expect(afterReplay.jobs[0]?.metadata).toMatchObject({
      delegation: {
        handoff: {
          operatorState: 'replayed',
        },
      },
    });

    const dismissed = manager.applyJobFollowUpAction(jobId!, 'dismiss');
    expect(dismissed).toMatchObject({
      success: true,
      message: `Dismissed held delegated result for ${jobId}.`,
    });

    const replayAfterDismiss = manager.applyJobFollowUpAction(jobId!, 'replay');
    expect(replayAfterDismiss).toMatchObject({
      success: false,
      errorCode: 'JOB_ALREADY_DISMISSED',
    });

    manager.shutdown();
  });

  it('intercepts automation authoring before brokered worker dispatch', async () => {
    const { WorkerManager } = await import('./worker-manager.js');
    const sandbox = await import('../sandbox/index.js');

    const executeModelTool = vi.fn(async (toolName: string) => {
      if (toolName === 'automation_list') {
        return { success: true, output: { automations: [] } };
      }
      if (toolName === 'automation_save') {
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-automation-1',
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
        executeModelTool,
        getApprovalSummaries: () => new Map([
          ['approval-automation-1', { toolName: 'automation_save', argsPreview: '{"name":"Weekday Lead Research"}' }],
        ]),
        decideApproval: vi.fn(),
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        auditLog: { record: vi.fn() },
      } as never,
      {
        workerEntryPoint: 'src/worker/worker-entry.ts',
        workerMaxMemoryMb: 2048,
        workerIdleTimeoutMs: 300_000,
        workerShutdownGracePeriodMs: 10,
        capabilityTokenTtlMs: 600_000,
        capabilityTokenMaxToolCalls: 0,
      } as never,
    );

    const response = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-automation',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        content: 'Build a weekday lead research workflow that reads ./companies.csv, researches each company\'s website and public presence, scores fit from 1-5 using a simple B2B SaaS ICP, writes results to ./lead-research-output.csv, and creates ./lead-research-summary.md. Use built-in Guardian tools only. Do not create any shell script, Python script, or code file.',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBase: '',
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
    });

    expect(response.content).toContain('native Guardian scheduled assistant task');
    expect(response.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          approvalSummaries: [
            {
              id: 'approval-automation-1',
              toolName: 'automation_save',
            },
          ],
        },
      },
    });
    expect(executeModelTool).toHaveBeenNthCalledWith(
      1,
      'automation_list',
      {},
      expect.objectContaining({ channel: 'web', userId: 'tester' }),
    );
    expect(executeModelTool.mock.calls.some((call) => (
      call[0] === 'automation_save'
      && call[1]?.name === 'Weekday Lead Research'
      && call[1]?.kind === 'assistant_task'
    ))).toBe(true);
    expect(vi.mocked(sandbox.sandboxedSpawn)).not.toHaveBeenCalled();

    manager.shutdown();
  });

  it('continues automation creation after remediation approvals are granted', async () => {
    const { WorkerManager } = await import('./worker-manager.js');
    const sandbox = await import('../sandbox/index.js');

    let pathAllowed = false;
    const externalPath = 'D:\\Reports\\lead-summary.md';
    const executeModelTool = vi.fn(async (toolName: string, args?: Record<string, unknown>) => {
      if (toolName === 'update_tool_policy') {
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-policy-1',
        };
      }
      if (toolName === 'automation_list') {
        return { success: true, output: { automations: [] } };
      }
      if (toolName === 'automation_save') {
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-task-1',
        };
      }
      throw new Error(`Unexpected tool ${toolName} ${JSON.stringify(args)}`);
    });

    const decideApproval = vi.fn(async (approvalId: string) => {
      if (approvalId === 'approval-policy-1') {
        pathAllowed = true;
        return { success: true, message: `Policy updated: add_path '${externalPath}'.` };
      }
      if (approvalId === 'approval-task-1') {
        return { success: true, message: "Scheduled assistant task 'Daily Lead Summary' created." };
      }
      return { success: false, message: `Unknown approval ${approvalId}` };
    });

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
        executeModelTool,
        decideApproval,
        getApprovalSummaries: () => new Map([
          ['approval-policy-1', { toolName: 'update_tool_policy', argsPreview: `{"action":"add_path","value":"${externalPath}"}` }],
          ['approval-task-1', { toolName: 'automation_save', argsPreview: '{"name":"Daily Lead Summary"}' }],
        ]),
        getPolicy: () => ({
          sandbox: {
            allowedPaths: pathAllowed
              ? [process.cwd(), externalPath]
              : [process.cwd()],
          },
        }),
        preflightTools: (requests: Array<{ name: string; args?: Record<string, unknown> }>) => requests.map((request) => {
          if (request.name === 'fs_write' && !pathAllowed) {
            return {
              name: request.name,
              found: true,
              decision: 'deny' as const,
              reason: 'Path is not in allowedPaths',
              fixes: [{ type: 'path' as const, value: externalPath, description: `Add ${externalPath} to allowed paths` }],
            };
          }
          return {
            name: request.name,
            found: true,
            decision: 'allow' as const,
            reason: 'ok',
            fixes: [],
          };
        }),
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        auditLog: { record: vi.fn() },
      } as never,
      {
        workerEntryPoint: 'src/worker/worker-entry.ts',
        workerMaxMemoryMb: 2048,
        workerIdleTimeoutMs: 300_000,
        workerShutdownGracePeriodMs: 10,
        capabilityTokenTtlMs: 600_000,
        capabilityTokenMaxToolCalls: 0,
      } as never,
    );

    const createRequest = {
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-remediation',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner' as const,
        channel: 'web' as const,
        content: `Create a daily 8:00 AM automation that reads ./companies.csv, writes a summary report to ${externalPath}, and uses built-in Guardian tools only.`,
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBase: '',
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
    };

    const initial = await manager.handleMessage(createRequest);
    expect(initial.content).toContain('fixable policy blockers');
    expect(initial.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          approvalSummaries: [
            {
              id: 'approval-policy-1',
              toolName: 'update_tool_policy',
            },
          ],
        },
      },
      resumeAutomationAfterApprovals: true,
    });

    const approved = await manager.handleMessage({
      ...createRequest,
      message: {
        ...createRequest.message,
        id: 'm-remediation-approve',
        content: 'yes',
      },
    });

    expect(approved.content).toContain(`Policy updated: add_path '${externalPath}'.`);
    expect(approved.content).toContain('native Guardian scheduled assistant task');
    expect(approved.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          approvalSummaries: [
            {
              id: 'approval-task-1',
              toolName: 'automation_save',
            },
          ],
        },
      },
    });
    expect(pathAllowed).toBe(true);
    expect(vi.mocked(sandbox.sandboxedSpawn)).not.toHaveBeenCalled();

    manager.shutdown();
  });

  it('continues workflow creation after remediation approvals are granted', async () => {
    const { WorkerManager } = await import('./worker-manager.js');
    const sandbox = await import('../sandbox/index.js');

    let pathAllowed = false;
    const externalPath = 'D:\\Reports\\lead-research-summary.md';
    const executeModelTool = vi.fn(async (toolName: string, args?: Record<string, unknown>) => {
      if (toolName === 'update_tool_policy') {
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-workflow-policy-1',
        };
      }
      if (toolName === 'automation_list') {
        return { success: true, output: { automations: [] } };
      }
      if (toolName === 'automation_save') {
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-workflow-create-1',
        };
      }
      throw new Error(`Unexpected tool ${toolName} ${JSON.stringify(args)}`);
    });

    const decideApproval = vi.fn(async (approvalId: string) => {
      if (approvalId === 'approval-workflow-policy-1') {
        pathAllowed = true;
        return { success: true, message: `Policy updated: add_path '${externalPath}'.` };
      }
      if (approvalId === 'approval-workflow-create-1') {
        return { success: true, message: "Workflow 'Lead Research Summary Workflow' created." };
      }
      return { success: false, message: `Unknown approval ${approvalId}` };
    });

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
        executeModelTool,
        decideApproval,
        getApprovalSummaries: () => new Map([
          ['approval-workflow-policy-1', { toolName: 'update_tool_policy', argsPreview: `{"action":"add_path","value":"${externalPath}"}` }],
          ['approval-workflow-create-1', { toolName: 'automation_save', argsPreview: '{"name":"Lead Research Summary Workflow"}' }],
        ]),
        listPendingApprovalIdsForUser: () => pathAllowed ? [] : ['approval-workflow-policy-1'],
        getPolicy: () => ({
          sandbox: {
            allowedPaths: pathAllowed
              ? [process.cwd(), externalPath]
              : [process.cwd()],
          },
        }),
        preflightTools: (requests: Array<{ name: string; args?: Record<string, unknown> }>) => requests.map((request) => {
          if (request.name === 'fs_write' && !pathAllowed) {
            return {
              name: request.name,
              found: true,
              decision: 'deny' as const,
              reason: 'Path is not in allowedPaths',
              fixes: [{ type: 'path' as const, value: externalPath, description: `Add ${externalPath} to allowed paths` }],
            };
          }
          return {
            name: request.name,
            found: true,
            decision: 'allow' as const,
            reason: 'ok',
            fixes: [],
          };
        }),
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        auditLog: { record: vi.fn() },
      } as never,
      {
        workerEntryPoint: 'src/worker/worker-entry.ts',
        workerMaxMemoryMb: 2048,
        workerIdleTimeoutMs: 300_000,
        workerShutdownGracePeriodMs: 10,
        capabilityTokenTtlMs: 600_000,
        capabilityTokenMaxToolCalls: 0,
      } as never,
    );

    const createRequest = {
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-workflow-remediation',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner' as const,
        channel: 'web' as const,
        content: `Create a sequential Guardian workflow that first reads ./companies.csv, then runs a fixed summarization step, then writes ${externalPath}.`,
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBase: '',
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
    };

    const initial = await manager.handleMessage(createRequest);
    expect(initial.content).toContain('fixable policy blockers');
    expect(initial.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          approvalSummaries: [
            {
              id: 'approval-workflow-policy-1',
              toolName: 'update_tool_policy',
            },
          ],
        },
      },
      resumeAutomationAfterApprovals: true,
    });

    const approved = await manager.handleMessage({
      ...createRequest,
      message: {
        ...createRequest.message,
        id: 'm-workflow-remediation-approve',
        content: 'yes',
      },
    });

    expect(approved.content).toContain(`Policy updated: add_path '${externalPath}'.`);
    expect(approved.content).toContain("native Guardian step-based automation");
    expect(approved.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          approvalSummaries: [
            {
              id: 'approval-workflow-create-1',
              toolName: 'automation_save',
            },
          ],
        },
      },
    });
    expect(pathAllowed).toBe(true);
    expect(executeModelTool.mock.calls.some((call) => call[0] === 'automation_save')).toBe(true);
    expect(vi.mocked(sandbox.sandboxedSpawn)).not.toHaveBeenCalled();

    manager.shutdown();
  });

  it('resumes suspended worker sessions after approvals are granted out of band', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = (params) => {
      const message = (params.message ?? {}) as { content?: string };
      if (typeof message.content === 'string' && message.content.includes('[User approved the pending tool action(s). Result:')) {
        return { content: 'The Outlook draft is present in Drafts.' };
      }
      return {
        content: 'Waiting for approval to create the Outlook draft.',
        metadata: {
          continueConversationAfterApproval: true,
          ...approvalPendingActionMetadata([
            {
              id: 'approval-outlook-1',
              toolName: 'outlook_draft',
              argsPreview: '{"to":"alex@example.com","subject":"Test One"}',
            },
          ]),
        },
      };
    };

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
        listApprovals: vi.fn(() => []),
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        auditLog: { record: vi.fn() },
      } as never,
      {
        workerEntryPoint: 'src/worker/worker-entry.ts',
        workerMaxMemoryMb: 2048,
        workerIdleTimeoutMs: 300_000,
        workerShutdownGracePeriodMs: 10,
        capabilityTokenTtlMs: 600_000,
        capabilityTokenMaxToolCalls: 0,
      } as never,
    );

    const initial = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-outlook',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        content: 'Draft an Outlook email to alex@example.com.',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBase: '',
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
    });

    expect(initial.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          approvalSummaries: [
            {
              id: 'approval-outlook-1',
              toolName: 'outlook_draft',
            },
          ],
        },
      },
    });
    expect(manager.hasSuspendedApproval('approval-outlook-1')).toBe(true);

    const resumed = await manager.continueAfterApproval(
      'approval-outlook-1',
      'approved',
      'Outlook draft created.',
    );

    expect(resumed?.content).toBe('The Outlook draft is present in Drafts.');
    expect(manager.hasSuspendedApproval('approval-outlook-1')).toBe(false);

    manager.shutdown();
  });

  it('does not mark direct pending approvals as resumable worker conversations without an explicit continuation flag', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = () => ({
      content: 'Waiting for approval to run the automation.',
      metadata: approvalPendingActionMetadata([
        {
          id: 'approval-auto-run-1',
          toolName: 'automation_run',
          argsPreview: '{"automationId":"browser-read-smoke"}',
        },
      ]),
    });

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
        listApprovals: vi.fn(() => []),
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        auditLog: { record: vi.fn() },
      } as never,
      {
        workerEntryPoint: 'src/worker/worker-entry.ts',
        workerMaxMemoryMb: 2048,
        workerIdleTimeoutMs: 300_000,
        workerShutdownGracePeriodMs: 10,
        capabilityTokenTtlMs: 600_000,
        capabilityTokenMaxToolCalls: 0,
      } as never,
    );

    await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-auto-run',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        content: 'Run Browser Read Smoke now.',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBase: '',
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
    });

    expect(manager.hasSuspendedApproval('approval-auto-run-1')).toBe(false);

    manager.shutdown();
  });

  it('does not abort shutdown when worker workspace cleanup is busy', async () => {
    const { WorkerManager } = await import('./worker-manager.js');
    const workspacePath = join(tmpdir(), `ga-worker-busy-${Date.now()}`);
    mkdirSync(workspacePath, { recursive: true });

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        auditLog: { record: vi.fn() },
      } as never,
      {
        workerEntryPoint: 'src/worker/worker-entry.ts',
        workerMaxMemoryMb: 2048,
        workerIdleTimeoutMs: 300_000,
        workerShutdownGracePeriodMs: 10,
        capabilityTokenTtlMs: 600_000,
        capabilityTokenMaxToolCalls: 0,
      } as never,
    );

    const worker = {
      id: 'worker-busy',
      sessionId: 'tester:web',
      agentId: 'local',
      authorizedBy: 'tester',
      grantedCapabilities: [],
      process: new FakeWorkerChild(),
      brokerServer: { sendNotification: vi.fn() },
      workspacePath,
      lastActivityMs: Date.now(),
      status: 'ready' as 'starting' | 'ready' | 'error' | 'shutting_down',
    };

    const managerState = manager as unknown as {
      workers: Map<string, typeof worker>;
      sessionToWorker: Map<string, string>;
      removeWorkspacePath: (workspacePath: string) => void;
    };

    managerState.workers.set(worker.id, worker);
    managerState.sessionToWorker.set(worker.sessionId, worker.id);
    const removeWorkspacePath = vi.fn(() => {
      throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    });
    managerState.removeWorkspacePath = removeWorkspacePath;

    expect(() => manager.shutdown()).not.toThrow();
    expect(worker.status).toBe('shutting_down');
    expect(removeWorkspacePath).toHaveBeenCalledWith(worker.workspacePath);
    expect(managerState.workers.size).toBe(0);
    expect(managerState.sessionToWorker.size).toBe(0);

    rmSync(workspacePath, { recursive: true, force: true });
  });
});
