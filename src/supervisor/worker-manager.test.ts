import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../config/types.js';
import { APPROVAL_OUTCOME_CONTINUATION_METADATA_KEY } from '../runtime/approval-continuations.js';
import { attachPreRoutedIntentGatewayMetadata } from '../runtime/intent-gateway.js';

const workerNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];
let workerMessageHandler:
  | ((params: Record<string, unknown>) => Promise<{ content: string; metadata?: Record<string, unknown> }> | { content: string; metadata?: Record<string, unknown> })
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

function automationAuthoringMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return attachPreRoutedIntentGatewayMetadata(metadata, {
    mode: 'primary',
    available: true,
    model: 'test-model',
    latencyMs: 1,
    decision: {
      route: 'automation_authoring',
      confidence: 'high',
      operation: 'create',
      summary: 'Creates a Guardian automation.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      entities: {},
    },
  });
}

function repoGroundedCodingMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return attachPreRoutedIntentGatewayMetadata(metadata, {
    mode: 'primary',
    available: true,
    model: 'test-model',
    latencyMs: 1,
    decision: {
      route: 'coding_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Inspects the repository and reports grounded findings.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      requiresRepoGrounding: true,
      entities: {},
    },
  });
}

function securityReviewMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return attachPreRoutedIntentGatewayMetadata(metadata, {
    mode: 'primary',
    available: true,
    model: 'test-model',
    latencyMs: 1,
    decision: {
      route: 'security_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Reviews source files for security or control-flow risks.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'security_analysis',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      preferredAnswerPath: 'chat_synthesis',
      entities: {},
    },
  });
}

function filesystemMutationMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return attachPreRoutedIntentGatewayMetadata(metadata, {
    mode: 'primary',
    available: true,
    model: 'test-model',
    latencyMs: 1,
    decision: {
      route: 'filesystem_task',
      confidence: 'high',
      operation: 'save',
      summary: 'Writes the requested file in the active workspace.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      preferredAnswerPath: 'tool_loop',
      entities: {},
    },
  });
}

function createExecutionProfileTestConfig(): GuardianAgentConfig {
  const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
  config.llm['ollama-cloud-coding'] = {
    provider: 'ollama_cloud',
    model: 'qwen3-coder-next',
    credentialRef: 'llm.ollama_cloud.coding',
  };
  config.llm['openai-frontier'] = {
    provider: 'openai',
    model: 'gpt-5.4',
    apiKey: 'test-key',
  };
  config.assistant.tools.preferredProviders = {
    local: 'ollama',
    managedCloud: 'ollama-cloud-coding',
    frontier: 'openai-frontier',
  };
  config.assistant.tools.modelSelection = {
    ...(config.assistant.tools.modelSelection ?? {}),
    autoPolicy: 'balanced',
    preferManagedCloudForLowPressureExternal: true,
    preferFrontierForRepoGrounded: true,
    preferFrontierForSecurity: true,
    managedCloudRouting: {
      enabled: true,
      roleBindings: {
        coding: 'ollama-cloud-coding',
      },
    },
  };
  return config;
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
          Promise.resolve(workerMessageHandler?.(message.params ?? {}) ?? { content: 'ok' })
            .then((response) => {
              this.stdout.write(`${JSON.stringify({
                jsonrpc: '2.0',
                method: 'message.response',
                params: response,
              })}\n`);
            });
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
        registry: {
          get: (agentId: string) => agentId === 'local'
            ? {
                agent: { name: 'Local Agent' },
                definition: {
                  orchestration: {
                    role: 'coordinator',
                    label: 'Primary Coordinator',
                  },
                },
              }
            : undefined,
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
      knowledgeBases: [],
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

  it('spawns separate workers for the same surface session when the agent lane changes', async () => {
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
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-lane-1',
        userId: 'tester',
        channel: 'web',
        content: 'hello',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
    };

    await manager.handleMessage({
      ...baseRequest,
      agentId: 'local',
    });
    await manager.handleMessage({
      ...baseRequest,
      agentId: 'external',
      message: {
        ...baseRequest.message,
        id: 'm-lane-2',
        content: 'hello again',
      },
    });

    expect(vi.mocked(sandbox.sandboxedSpawn)).toHaveBeenCalledTimes(2);

    manager.shutdown();
  });

  it('serializes overlapping dispatches on a reused worker', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

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

    const starts: string[] = [];
    const finishers: Array<() => void> = [];
    workerMessageHandler = (params) => new Promise((resolve) => {
      const message = params.message as { id?: string };
      const messageId = String(message.id ?? 'unknown');
      starts.push(messageId);
      finishers.push(() => resolve({ content: `done:${messageId}` }));
    });

    const baseRequest = {
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
    };

    const first = manager.handleMessage({
      ...baseRequest,
      message: {
        id: 'm-queue-1',
        userId: 'tester',
        channel: 'web',
        content: 'first',
        timestamp: Date.now(),
      },
    });

    while (starts.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const second = manager.handleMessage({
      ...baseRequest,
      message: {
        id: 'm-queue-2',
        userId: 'tester',
        channel: 'web',
        content: 'second',
        timestamp: Date.now(),
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toEqual(['m-queue-1']);

    finishers[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toEqual(['m-queue-1', 'm-queue-2']);

    finishers[1]?.();
    await expect(first).resolves.toMatchObject({ content: 'done:m-queue-1' });
    await expect(second).resolves.toMatchObject({ content: 'done:m-queue-2' });

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
      knowledgeBases: [
        { scope: 'global', content: 'Remembered preference.' },
        { scope: 'coding_session', content: 'Parser workspace note.' },
      ],
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
      knowledgeBases: [
        { scope: 'global', content: 'Remembered preference.' },
        { scope: 'coding_session', content: 'Parser workspace note.' },
      ],
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
        registry: {
          get: (agentId: string) => agentId === 'local'
            ? {
                agent: { name: 'Local Agent' },
                definition: {
                  orchestration: {
                    role: 'coordinator',
                    label: 'Primary Coordinator',
                  },
                },
              }
            : undefined,
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
      knowledgeBases: [],
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      delegation: {
        requestId: 'm-delegated',
        executionId: 'exec-delegated',
        rootExecutionId: 'exec-root',
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
          agentId: 'local',
          agentName: 'Local Agent',
          orchestration: {
            role: 'coordinator',
            label: 'Primary Coordinator',
          },
          requestId: 'm-delegated',
          executionId: 'exec-delegated',
          rootExecutionId: 'exec-root',
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

  it('publishes delegated worker observability into the shared routing trace and run timeline', async () => {
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

    const intentRoutingTrace = {
      record: vi.fn(),
    };
    const runTimeline = {
      ingestDelegatedWorkerProgress: vi.fn(),
    };

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        auditLog: { record: vi.fn() },
        registry: {
          get: (agentId: string) => agentId === 'local'
            ? {
                agent: { name: 'Local Agent' },
                definition: {
                  orchestration: {
                    role: 'coordinator',
                    label: 'Primary Coordinator',
                  },
                },
              }
            : undefined,
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
      undefined,
      {
        intentRoutingTrace,
        runTimeline,
        now: () => 123_456,
      },
    );

    await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-observe',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        content: 'Continue the report export.',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      executionProfile: {
        id: 'managed_cloud_tool',
        providerName: 'ollama-cloud-coding',
        providerType: 'ollama_cloud',
        providerModel: 'qwen3-coder-next',
        providerLocality: 'remote',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'tool_loop',
        expectedContextPressure: 'medium',
        contextBudget: 16_000,
        toolContextMode: 'standard',
        maxAdditionalSections: 8,
        maxRuntimeNotices: 6,
        fallbackProviderOrder: ['ollama-cloud-coding', 'openai-frontier'],
        reason: 'delegated coding role selected managed-cloud coding profile',
        selectionSource: 'delegated_role',
      },
      delegation: {
        requestId: 'm-observe',
        executionId: 'exec-observe',
        rootExecutionId: 'exec-root',
        originChannel: 'web',
        originSurfaceId: 'web-chat',
        continuityKey: 'continuity-1',
        activeExecutionRefs: ['code_session:Repo Fix'],
        pendingActionId: 'pending-1',
        codeSessionId: 'code-1',
      },
    });

    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_worker_completed',
    ]);
    expect(intentRoutingTrace.record.mock.calls[0]?.[0]).toMatchObject({
      stage: 'delegated_worker_started',
      requestId: 'm-observe',
      channel: 'web',
      details: {
        originSurfaceId: 'web-chat',
        executionId: 'exec-observe',
        rootExecutionId: 'exec-root',
        taskExecutionId: expect.stringMatching(/^delegated-task:job-[^:]+$/),
        continuityKey: 'continuity-1',
        activeExecutionRefs: ['code_session:Repo Fix'],
        pendingActionId: 'pending-1',
        codeSessionId: 'code-1',
        agentName: 'Local Agent',
        orchestrationLabel: 'Primary Coordinator',
        executionProfileId: 'managed_cloud_tool',
        executionProfileName: 'ollama-cloud-coding',
        executionProfileModel: 'qwen3-coder-next',
        executionProfileTier: 'managed-cloud',
        executionProfileLocality: 'remote',
        executionProfileRequestedTier: 'external',
        executionProfileSelectionSource: 'delegated_role',
        executionProfilePreferredAnswerPath: 'tool_loop',
        executionProfileExpectedContextPressure: 'medium',
        executionProfileContextBudget: 16000,
        executionProfileToolContextMode: 'standard',
        executionProfileMaxAdditionalSections: 8,
        executionProfileMaxRuntimeNotices: 6,
        executionProfileReason: 'delegated coding role selected managed-cloud coding profile',
        taskRunId: expect.stringMatching(/^delegated-task:job-[^:]+$/),
        lifecycle: 'running',
      },
    });
    expect(intentRoutingTrace.record.mock.calls[2]?.[0]).toMatchObject({
      stage: 'delegated_worker_completed',
      requestId: 'm-observe',
      details: {
        taskRunId: expect.stringMatching(/^delegated-task:job-[^:]+$/),
        executionId: 'exec-observe',
        rootExecutionId: 'exec-root',
        taskExecutionId: expect.stringMatching(/^delegated-task:job-[^:]+$/),
        lifecycle: 'blocked',
        unresolvedBlockerKind: 'approval',
        approvalCount: 1,
        reportingMode: 'held_for_approval',
        reason: 'Waiting for approval to write the final report.',
        handoffSummary: 'Waiting for approval to write the final report.',
        handoffNextAction: 'Resolve the pending approval(s) to continue the delegated run.',
      },
    });

    expect(runTimeline.ingestDelegatedWorkerProgress.mock.calls.map(([event]) => event.kind)).toEqual([
      'started',
      'running',
      'blocked',
    ]);
    expect(runTimeline.ingestDelegatedWorkerProgress.mock.calls[1]?.[0]).toMatchObject({
      id: expect.stringMatching(/^delegated-worker:job-[^:]+:running$/),
      kind: 'running',
      requestId: 'm-observe',
      runId: 'exec-observe',
      parentRunId: 'exec-observe',
      executionId: 'exec-observe',
      rootExecutionId: 'exec-root',
      taskExecutionId: expect.stringMatching(/^delegated-task:job-[^:]+$/),
      codeSessionId: 'code-1',
      agentId: 'local',
      agentName: 'Local Agent',
      orchestrationLabel: 'Primary Coordinator',
      executionProfileName: 'ollama-cloud-coding',
      executionProfileModel: 'qwen3-coder-next',
      executionProfileTier: 'managed-cloud',
      originChannel: 'web',
      continuityKey: 'continuity-1',
      activeExecutionRefs: ['code_session:Repo Fix'],
      timestamp: 123_456,
      detail: 'Primary Coordinator is working using managed-cloud profile ollama-cloud-coding (qwen3-coder-next) in code session code-1.',
    });
    expect(runTimeline.ingestDelegatedWorkerProgress.mock.calls[2]?.[0]).toMatchObject({
      id: expect.stringMatching(/^delegated-worker:job-[^:]+:completed$/),
      kind: 'blocked',
      executionId: 'exec-observe',
      rootExecutionId: 'exec-root',
      taskExecutionId: expect.stringMatching(/^delegated-task:job-[^:]+$/),
      executionProfileName: 'ollama-cloud-coding',
      executionProfileModel: 'qwen3-coder-next',
      executionProfileTier: 'managed-cloud',
      reportingMode: 'held_for_approval',
      unresolvedBlockerKind: 'approval',
      approvalCount: 1,
      detail: 'Resolve the pending approval(s) to continue the delegated run.',
    });

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
      knowledgeBases: [],
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
      knowledgeBases: [],
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

  it('marks delegated workers as failed when the worker loop reports a non-terminal execution state', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = () => ({
      content: 'I will inspect the repository first and then start fixing the bug.',
      metadata: {
        workerExecution: {
          lifecycle: 'failed',
          source: 'tool_loop',
          completionReason: 'intermediate_response',
          responseQuality: 'intermediate',
          toolCallCount: 0,
          toolResultCount: 0,
        },
      },
    });

    const intentRoutingTrace = {
      record: vi.fn(),
    };
    const runTimeline = {
      ingestDelegatedWorkerProgress: vi.fn(),
    };

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
      undefined,
      {
        intentRoutingTrace,
        runTimeline,
        now: () => 123_456,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-failed-delegated',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        content: 'Inspect the repo and fix the bug.',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      delegation: {
        requestId: 'm-failed-delegated',
        originChannel: 'web',
      },
    });

    expect(result.content).toContain('Delegated work failed.');
    expect(result.content).toContain('progress update instead of a terminal result');

    const state = manager.getJobState(5);
    expect(state.jobs[0]).toMatchObject({
      type: 'delegated_worker',
      status: 'failed',
      metadata: {
        delegation: {
          kind: 'brokered_worker',
          lifecycle: 'failed',
          handoff: {
            reportingMode: 'inline_response',
            nextAction: 'Inspect the delegated worker failure details before retrying.',
          },
        },
      },
    });

    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_worker_failed',
    ]);
    expect(intentRoutingTrace.record.mock.calls[2]?.[0]).toMatchObject({
      stage: 'delegated_worker_failed',
      requestId: 'm-failed-delegated',
      contentPreview: 'Delegated worker returned a progress update instead of a terminal result.',
      details: {
        taskRunId: expect.stringMatching(/^delegated-task:job-[^:]+$/),
        lifecycle: 'failed',
        reason: 'Delegated worker returned a progress update instead of a terminal result.',
        handoffSummary: 'Delegated worker returned a progress update instead of a terminal result.',
        handoffNextAction: 'Inspect the delegated worker failure details before retrying.',
        workerExecutionSource: 'tool_loop',
        workerExecutionCompletionReason: 'intermediate_response',
        workerExecutionResponseQuality: 'intermediate',
        workerExecutionToolCallCount: 0,
        workerExecutionToolResultCount: 0,
      },
    });

    expect(runTimeline.ingestDelegatedWorkerProgress.mock.calls.map(([event]) => event.kind)).toEqual([
      'started',
      'running',
      'failed',
    ]);
    expect(runTimeline.ingestDelegatedWorkerProgress.mock.calls[2]?.[0]).toMatchObject({
      id: expect.stringMatching(/^delegated-worker:job-[^:]+:failed$/),
      kind: 'failed',
      requestId: 'm-failed-delegated',
      detail: 'Delegated worker returned a progress update instead of a terminal result.',
    });

    manager.shutdown();
  });

  it('fails repo-grounded delegated runs that complete without any repo evidence or tool results', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = () => ({
      content: "I'll search the repo for the relevant files next.",
      metadata: {
        workerExecution: {
          lifecycle: 'completed',
          source: 'tool_loop',
          completionReason: 'answer_first_response',
          responseQuality: 'final',
          toolCallCount: 0,
          toolResultCount: 0,
          successfulToolResultCount: 0,
        },
      },
    });

    const intentRoutingTrace = {
      record: vi.fn(),
    };
    const runTimeline = {
      ingestDelegatedWorkerProgress: vi.fn(),
    };

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
      undefined,
      {
        intentRoutingTrace,
        runTimeline,
        now: () => 123_456,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-repo-grounding-failed',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        content: 'Inspect the repo and tell me which files implement delegated worker progress.',
        metadata: repoGroundedCodingMetadata(),
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      delegation: {
        requestId: 'm-repo-grounding-failed',
        originChannel: 'web',
      },
    });

    expect(result.content).toContain('Delegated work failed.');
    expect(result.content).toContain('repo-grounded answer without collecting successful tool results or evidence');

    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_worker_failed',
    ]);
    expect(intentRoutingTrace.record.mock.calls[2]?.[0]).toMatchObject({
      stage: 'delegated_worker_failed',
      requestId: 'm-repo-grounding-failed',
      details: {
        lifecycle: 'failed',
        reason: 'Delegated worker returned a repo-grounded answer without collecting successful tool results or evidence.',
        handoffSummary: 'Delegated worker returned a repo-grounded answer without collecting successful tool results or evidence.',
        handoffNextAction: 'Inspect the delegated worker failure details before retrying.',
        workerExecutionCompletionReason: 'answer_first_response',
        workerExecutionToolCallCount: 0,
        workerExecutionToolResultCount: 0,
        workerExecutionSuccessfulToolResultCount: 0,
      },
    });
    expect(runTimeline.ingestDelegatedWorkerProgress.mock.calls[2]?.[0]).toMatchObject({
      kind: 'failed',
      requestId: 'm-repo-grounding-failed',
      detail: 'Delegated worker returned a repo-grounded answer without collecting successful tool results or evidence.',
    });

    manager.shutdown();
  });

  it('retries insufficient exact-file delegated repo inspections with an escalated frontier profile', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const dispatchProfiles: Array<string | undefined> = [];
    workerMessageHandler = (params) => {
      const executionProfile = params.executionProfile as { providerName?: string; providerTier?: string } | undefined;
      dispatchProfiles.push(executionProfile?.providerName);
      if (executionProfile?.providerTier === 'frontier') {
        return {
          content: [
            'The delegated worker progress implementation lives in `src/supervisor/worker-manager.ts` and `src/runtime/run-timeline.ts`.',
            'The web-side timeline matching/rendering path lives in `web/public/js/chat-run-tracking.js` and `web/public/js/chat-panel.js`.',
          ].join('\n'),
          metadata: {
            workerExecution: {
              lifecycle: 'completed',
              source: 'tool_loop',
              completionReason: 'model_response',
              responseQuality: 'final',
              toolCallCount: 4,
              toolResultCount: 4,
              successfulToolResultCount: 4,
            },
          },
        };
      }
      return {
        content: 'The searches confirmed the files exist, but the detailed match output was truncated so I cannot give you exact file paths with confidence. Would you like me to run narrower searches?',
        metadata: {
          workerExecution: {
            lifecycle: 'completed',
            source: 'tool_loop',
            completionReason: 'tool_result_recovery',
            responseQuality: 'final',
            toolCallCount: 4,
            toolResultCount: 4,
            successfulToolResultCount: 4,
          },
        },
      };
    };

    const intentRoutingTrace = {
      record: vi.fn(),
    };
    const runTimeline = {
      ingestDelegatedWorkerProgress: vi.fn(),
    };
    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        getConfigSnapshot: () => createExecutionProfileTestConfig(),
        auditLog: { record: vi.fn() },
        registry: {
          get: (agentId: string) => agentId === 'local'
            ? {
                agent: { name: 'Guardian Agent' },
                definition: {
                  orchestration: {
                    role: 'explorer',
                    label: 'Workspace Explorer',
                    lenses: ['coding-workspace'],
                  },
                },
              }
            : undefined,
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
      undefined,
      {
        intentRoutingTrace,
        runTimeline,
        now: () => 321_000,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-retry-exact-files',
        userId: 'tester',
        channel: 'web',
        content: 'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.',
        metadata: repoGroundedCodingMetadata(),
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      additionalSections: [],
      toolContext: '',
      runtimeNotices: [],
      executionProfile: {
        id: 'managed_cloud_tool',
        providerName: 'ollama-cloud-coding',
        providerType: 'ollama_cloud',
        providerModel: 'qwen3-coder-next',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'tool_loop',
        expectedContextPressure: 'medium',
        contextBudget: 32_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['ollama-cloud-coding', 'openai-frontier'],
        reason: 'delegated coding role selected managed-cloud coding profile',
        routingMode: 'auto',
        selectionSource: 'delegated_role',
      },
      delegation: {
        requestId: 'm-retry-exact-files',
        executionId: 'exec-retry-exact-files',
        rootExecutionId: 'exec-retry-root',
        originChannel: 'web',
        orchestration: {
          role: 'explorer',
          label: 'Workspace Explorer',
          lenses: ['coding-workspace'],
        },
      },
    });

    expect(dispatchProfiles).toEqual(['ollama-cloud-coding', 'openai-frontier']);
    expect(result.content).toContain('src/supervisor/worker-manager.ts');
    expect(result.content).toContain('src/runtime/run-timeline.ts');
    expect(result.content).toContain('web/public/js/chat-run-tracking.js');
    expect(result.content).toContain('web/public/js/chat-panel.js');

    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_worker_retrying',
      'delegated_worker_completed',
    ]);
    expect(intentRoutingTrace.record.mock.calls[2]?.[0]).toMatchObject({
      stage: 'delegated_worker_retrying',
      requestId: 'm-retry-exact-files',
      details: {
        executionProfileName: 'openai-frontier',
        executionProfileTier: 'frontier',
      },
    });
    expect(runTimeline.ingestDelegatedWorkerProgress.mock.calls.map(([event]) => event.kind)).toEqual([
      'started',
      'running',
      'running',
      'completed',
    ]);
    expect(runTimeline.ingestDelegatedWorkerProgress.mock.calls[2]?.[0]).toMatchObject({
      kind: 'running',
      executionProfileName: 'openai-frontier',
      executionProfileTier: 'frontier',
      detail: expect.stringContaining('Retrying Workspace Explorer'),
    });

    manager.shutdown();
  });

  it('fails exact-file delegated repo inspections when no stronger escalation profile is available', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = () => ({
      content: 'The searches confirmed the files exist, but the detailed match output was truncated so I cannot give you exact file paths with confidence.',
      metadata: {
        workerExecution: {
          lifecycle: 'completed',
          source: 'tool_loop',
          completionReason: 'tool_result_recovery',
          responseQuality: 'final',
          toolCallCount: 3,
          toolResultCount: 3,
          successfulToolResultCount: 3,
        },
      },
    });

    const intentRoutingTrace = {
      record: vi.fn(),
    };
    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        getConfigSnapshot: () => {
          const config = createExecutionProfileTestConfig();
          delete config.llm['openai-frontier'];
          config.assistant.tools.preferredProviders = {
            ...config.assistant.tools.preferredProviders,
            frontier: '',
          };
          return config;
        },
        auditLog: { record: vi.fn() },
        registry: {
          get: () => undefined,
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
      undefined,
      {
        intentRoutingTrace,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-fail-exact-files',
        userId: 'tester',
        channel: 'web',
        content: 'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.',
        metadata: repoGroundedCodingMetadata(),
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      additionalSections: [],
      toolContext: '',
      runtimeNotices: [],
      executionProfile: {
        id: 'managed_cloud_tool',
        providerName: 'ollama-cloud-coding',
        providerType: 'ollama_cloud',
        providerModel: 'qwen3-coder-next',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'tool_loop',
        expectedContextPressure: 'medium',
        contextBudget: 32_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['ollama-cloud-coding'],
        reason: 'delegated coding role selected managed-cloud coding profile',
        routingMode: 'auto',
        selectionSource: 'delegated_role',
      },
      delegation: {
        requestId: 'm-fail-exact-files',
        originChannel: 'web',
      },
    });

    expect(result.content).toContain('Delegated work failed.');
    expect(result.content).toContain('exact file references requested');
    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_worker_failed',
    ]);

    manager.shutdown();
  });

  it('escalates exact-file delegated repo inspections from derived workspace intent when pre-routed metadata is unavailable', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const dispatchProfiles: Array<string | undefined> = [];
    workerMessageHandler = (params) => {
      const executionProfile = params.executionProfile as { providerName?: string; providerTier?: string } | undefined;
      dispatchProfiles.push(executionProfile?.providerName);
      if (executionProfile?.providerTier === 'frontier') {
        return {
          content: [
            'Delegated worker progress is implemented in `src/supervisor/worker-manager.ts` and `src/runtime/run-timeline.ts`.',
            'Run timeline rendering is implemented in `web/public/js/chat-panel.js` and `web/public/js/chat-run-tracking.js`.',
          ].join('\n'),
          metadata: {
            workerExecution: {
              lifecycle: 'completed',
              source: 'tool_loop',
              completionReason: 'model_response',
              responseQuality: 'final',
              toolCallCount: 4,
              toolResultCount: 4,
              successfulToolResultCount: 4,
            },
          },
        };
      }
      return {
        content: 'The searches confirmed the files exist, but the detailed match output was truncated so I cannot give you exact file paths with confidence. Would you like me to run narrower searches?',
        metadata: {
          workerExecution: {
            lifecycle: 'completed',
            source: 'tool_loop',
            completionReason: 'tool_result_recovery',
            responseQuality: 'final',
            toolCallCount: 3,
            toolResultCount: 3,
            successfulToolResultCount: 3,
          },
        },
      };
    };

    const intentRoutingTrace = {
      record: vi.fn(),
    };
    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        getConfigSnapshot: () => createExecutionProfileTestConfig(),
        auditLog: { record: vi.fn() },
        registry: {
          get: (agentId: string) => agentId === 'local'
            ? {
                agent: { name: 'Guardian Agent' },
                definition: {
                  orchestration: {
                    role: 'explorer',
                    label: 'Workspace Explorer',
                    lenses: ['coding-workspace'],
                  },
                },
              }
            : undefined,
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
      undefined,
      {
        intentRoutingTrace,
        now: () => 654_321,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-retry-derived-exact-files',
        userId: 'tester',
        channel: 'web',
        content: 'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      additionalSections: [],
      toolContext: '',
      runtimeNotices: [],
      executionProfile: {
        id: 'managed_cloud_tool',
        providerName: 'ollama-cloud-coding',
        providerType: 'ollama_cloud',
        providerModel: 'minimax-m2.7',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'tool_loop',
        expectedContextPressure: 'medium',
        contextBudget: 32_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['ollama-cloud-coding', 'openai-frontier'],
        reason: 'delegated coding role selected managed-cloud coding profile',
        routingMode: 'auto',
        selectionSource: 'delegated_role',
      },
      delegation: {
        requestId: 'm-retry-derived-exact-files',
        executionId: 'exec-retry-derived-exact-files',
        rootExecutionId: 'exec-retry-derived-root',
        originChannel: 'web',
        orchestration: {
          role: 'explorer',
          label: 'Workspace Explorer',
          lenses: ['coding-workspace'],
        },
      },
    });

    expect(dispatchProfiles).toEqual(['ollama-cloud-coding', 'openai-frontier']);
    expect(result.content).toContain('src/supervisor/worker-manager.ts');
    expect(result.content).toContain('src/runtime/run-timeline.ts');
    expect(result.content).toContain('web/public/js/chat-panel.js');
    expect(result.content).toContain('web/public/js/chat-run-tracking.js');
    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_worker_retrying',
      'delegated_worker_completed',
    ]);
    expect(intentRoutingTrace.record.mock.calls[0]?.[0]).toMatchObject({
      stage: 'delegated_worker_started',
      details: {
        delegatedIntentSource: 'delegated_derived',
        delegatedIntentRoute: 'coding_task',
        delegatedIntentExecutionClass: 'repo_grounded',
        delegatedIntentRequiresRepoGrounding: true,
      },
    });

    manager.shutdown();
  });

  it('retries non-terminal delegated workspace progress updates on a stronger frontier profile', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const dispatchProfiles: Array<string | undefined> = [];
    workerMessageHandler = (params) => {
      const executionProfile = params.executionProfile as { providerName?: string; providerTier?: string } | undefined;
      dispatchProfiles.push(executionProfile?.providerName);
      if (executionProfile?.providerTier === 'frontier') {
        return {
          content: 'The delegated worker progress implementation lives in `src/supervisor/worker-manager.ts`, and the run timeline rendering path lives in `web/public/js/chat-panel.js`.',
          metadata: {
            workerExecution: {
              lifecycle: 'completed',
              source: 'tool_loop',
              completionReason: 'model_response',
              responseQuality: 'final',
              toolCallCount: 2,
              toolResultCount: 2,
              successfulToolResultCount: 2,
            },
          },
        };
      }
      return {
        content: 'I will inspect the repository first and then return the exact files.',
        metadata: {
          workerExecution: {
            lifecycle: 'failed',
            source: 'tool_loop',
            completionReason: 'intermediate_response',
            responseQuality: 'intermediate',
            toolCallCount: 1,
            toolResultCount: 0,
          },
        },
      };
    };

    const intentRoutingTrace = {
      record: vi.fn(),
    };
    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        getConfigSnapshot: () => createExecutionProfileTestConfig(),
        auditLog: { record: vi.fn() },
        registry: {
          get: (agentId: string) => agentId === 'local'
            ? {
                agent: { name: 'Guardian Agent' },
                definition: {
                  orchestration: {
                    role: 'explorer',
                    label: 'Workspace Explorer',
                    lenses: ['coding-workspace'],
                  },
                },
              }
            : undefined,
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
      undefined,
      {
        intentRoutingTrace,
        now: () => 777_000,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-retry-terminal-result',
        userId: 'tester',
        channel: 'web',
        content: 'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.',
        metadata: repoGroundedCodingMetadata(),
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      additionalSections: [],
      toolContext: '',
      runtimeNotices: [],
      executionProfile: {
        id: 'managed_cloud_tool',
        providerName: 'ollama-cloud-coding',
        providerType: 'ollama_cloud',
        providerModel: 'glm-5.1',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'tool_loop',
        expectedContextPressure: 'medium',
        contextBudget: 32_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['ollama-cloud-coding', 'openai-frontier'],
        reason: 'delegated coding role selected managed-cloud coding profile',
        routingMode: 'auto',
        selectionSource: 'delegated_role',
      },
      delegation: {
        requestId: 'm-retry-terminal-result',
        executionId: 'exec-retry-terminal-result',
        rootExecutionId: 'exec-retry-terminal-root',
        originChannel: 'web',
        orchestration: {
          role: 'explorer',
          label: 'Workspace Explorer',
          lenses: ['coding-workspace'],
        },
      },
    });

    expect(dispatchProfiles).toEqual(['ollama-cloud-coding', 'openai-frontier']);
    expect(result.content).toContain('src/supervisor/worker-manager.ts');
    expect(result.content).toContain('web/public/js/chat-panel.js');
    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_worker_retrying',
      'delegated_worker_completed',
    ]);
    expect(intentRoutingTrace.record.mock.calls[2]?.[0]).toMatchObject({
      stage: 'delegated_worker_retrying',
      details: {
        reason: expect.stringContaining('progress update'),
        executionProfileName: 'openai-frontier',
        executionProfileTier: 'frontier',
      },
    });

    manager.shutdown();
  });

  it('fails source-backed delegated security reviews that finish without any successful tool evidence', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = () => ({
      content: 'High: src/delegate/resume.ts allows stale approvals to resume the task.',
      metadata: {
        workerExecution: {
          lifecycle: 'completed',
          source: 'tool_loop',
          completionReason: 'model_response',
          responseQuality: 'final',
          toolCallCount: 3,
          toolResultCount: 3,
          successfulToolResultCount: 0,
        },
      },
    });

    const intentRoutingTrace = {
      record: vi.fn(),
    };

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
      undefined,
      {
        intentRoutingTrace,
        now: () => 123_456,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-security-evidence-failed',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        content: 'Review the delegated execution, approval, and resume flow for security or control-flow risks. Cite exact files.',
        metadata: securityReviewMetadata(),
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      delegation: {
        requestId: 'm-security-evidence-failed',
        originChannel: 'web',
        codeSessionId: 'code-1',
      },
    });

    expect(result.content).toContain('Delegated work failed.');
    expect(result.content).toContain('source-backed security findings without collecting successful tool results or evidence');
    expect(intentRoutingTrace.record.mock.calls[2]?.[0]).toMatchObject({
      stage: 'delegated_worker_failed',
      requestId: 'm-security-evidence-failed',
      details: {
        lifecycle: 'failed',
        reason: 'Delegated worker returned source-backed security findings without collecting successful tool results or evidence.',
        handoffSummary: 'Delegated worker returned source-backed security findings without collecting successful tool results or evidence.',
        workerExecutionToolCallCount: 3,
        workerExecutionToolResultCount: 3,
        workerExecutionSuccessfulToolResultCount: 0,
      },
    });

    manager.shutdown();
  });

  it('keeps filesystem mutation turns blocked when a real approval is pending', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = () => ({
      content: 'Waiting for approval to add D:\\GuardianTraceApprovalSmoke before writing notes.md.',
      metadata: {
        pendingAction: {
          status: 'pending',
          blocker: {
            kind: 'approval',
            prompt: 'Waiting for approval.',
            approvalSummaries: [
              { id: 'approval-path-1', toolName: 'update_tool_policy', argsPreview: '{"path":"D:\\\\GuardianTraceApprovalSmoke"}' },
            ],
          },
        },
        workerExecution: {
          lifecycle: 'blocked',
          source: 'tool_loop',
          completionReason: 'approval_pending',
          responseQuality: 'final',
          blockerKind: 'approval',
          toolCallCount: 1,
          toolResultCount: 1,
          successfulToolResultCount: 0,
          pendingApprovalCount: 1,
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
        id: 'm-filesystem-approval-pending',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        content: 'Create D:\\GuardianTraceApprovalSmoke\\notes.md with 3 bullets about delegated trace troubleshooting.',
        metadata: filesystemMutationMetadata(),
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      delegation: {
        requestId: 'm-filesystem-approval-pending',
        originChannel: 'web',
      },
    });

    expect(result.content).toContain('Waiting for approval to add D:\\GuardianTraceApprovalSmoke');
    expect(result.content).not.toContain('Delegated work failed.');

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
      knowledgeBases: [],
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
        metadata: automationAuthoringMetadata(),
        content: 'Build a weekday lead research workflow that reads ./companies.csv, researches each company\'s website and public presence, scores fit from 1-5 using a simple B2B SaaS ICP, writes results to ./lead-research-output.csv, and creates ./lead-research-summary.md. Use built-in Guardian tools only. Do not create any shell script, Python script, or code file.',
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
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
        metadata: automationAuthoringMetadata(),
        content: `Create a daily 8:00 AM automation that reads ./companies.csv, writes a summary report to ${externalPath}, and uses built-in Guardian tools only.`,
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
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
        metadata: automationAuthoringMetadata(),
        content: `Create a sequential Guardian workflow that first reads ./companies.csv, then runs a fixed summarization step, then writes ${externalPath}.`,
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
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
      const message = (params.message ?? {}) as {
        metadata?: Record<string, unknown>;
      };
      const continuation = message.metadata?.[APPROVAL_OUTCOME_CONTINUATION_METADATA_KEY] as
        | { type?: string; approvalId?: string; decision?: string; resultMessage?: string }
        | undefined;
      if (continuation?.type === 'approval_outcome') {
        expect(continuation).toMatchObject({
          approvalId: 'approval-outlook-1',
          decision: 'approved',
          resultMessage: 'Outlook draft created.',
        });
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
      knowledgeBases: [],
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
      knowledgeBases: [],
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
      workerSessionKey: 'tester:web::local',
      agentId: 'local',
      authorizedBy: 'tester',
      grantedCapabilities: [],
      process: new FakeWorkerChild(),
      brokerServer: { sendNotification: vi.fn() },
      workspacePath,
      lastActivityMs: Date.now(),
      status: 'ready' as 'starting' | 'ready' | 'error' | 'shutting_down',
      dispatchQueue: Promise.resolve(),
    };

    const managerState = manager as unknown as {
      workers: Map<string, typeof worker>;
      sessionToWorker: Map<string, string>;
      removeWorkspacePath: (workspacePath: string) => void;
    };

    managerState.workers.set(worker.id, worker);
    managerState.sessionToWorker.set(worker.workerSessionKey, worker.id);
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
