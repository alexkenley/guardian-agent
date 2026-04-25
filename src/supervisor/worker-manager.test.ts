import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../config/types.js';
import { buildDelegatedExecutionMetadata } from '../runtime/execution/metadata.js';
import {
  buildFileReadSetArtifact,
  buildSearchResultSetArtifact,
} from '../runtime/execution-graph/graph-artifacts.js';
import { ExecutionGraphStore } from '../runtime/execution-graph/graph-store.js';
import {
  buildStepReceipts,
  computeWorkerRunStatus,
  findAnswerStepId,
  matchPlannedStepForTool,
} from '../runtime/execution/task-plan.js';
import { buildDelegatedTaskContract } from '../runtime/execution/verifier.js';
import { APPROVAL_OUTCOME_CONTINUATION_METADATA_KEY } from '../runtime/approval-continuations.js';
import { requestNeedsExactFileReferences } from '../runtime/intent/request-patterns.js';
import { attachPreRoutedIntentGatewayMetadata, readPreRoutedIntentGatewayMetadata } from '../runtime/intent-gateway.js';
import type { PendingActionRecord } from '../runtime/pending-actions.js';

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
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'chat_synthesis',
      entities: {},
    },
  });
}

function filesystemSearchWriteMetadata(
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
      operation: 'run',
      summary: 'Search src/runtime for planned_steps. Write a short summary of what you find to tmp/manual-web/planned-steps-summary.txt.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: false,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search src/runtime for planned_steps.', required: true },
        { kind: 'write', summary: 'Write a short summary of what you find to tmp/manual-web/planned-steps-summary.txt.', required: true },
      ],
      entities: {},
    },
  });
}

function generalAssistantDirectMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return attachPreRoutedIntentGatewayMetadata(metadata, {
    mode: 'primary',
    available: true,
    model: 'test-model',
    latencyMs: 1,
    decision: {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'read',
      summary: 'User asks for a concise project summary.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'direct_assistant',
      preferredTier: 'local',
      requiresRepoGrounding: false,
      requiresToolSynthesis: false,
      requireExactFileReferences: false,
      expectedContextPressure: 'low',
      preferredAnswerPath: 'direct',
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
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: true,
      expectedContextPressure: 'high',
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
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: false,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      entities: {},
    },
  });
}

function buildTestGatewayDecisionFromRequest(params: Record<string, unknown> | undefined) {
  const request = params?.message as { content?: string; metadata?: Record<string, unknown> } | undefined;
  const requestContent = typeof request?.content === 'string' ? request.content : '';
  const preRouted = readPreRoutedIntentGatewayMetadata(request?.metadata);
  if (preRouted?.decision) {
    const decision = preRouted.decision;
    return {
      ...decision,
      ...(typeof decision.requireExactFileReferences === 'boolean'
        ? {}
        : {
            requireExactFileReferences: (
              decision.requiresRepoGrounding === true
              || decision.executionClass === 'repo_grounded'
              || decision.executionClass === 'security_analysis'
            ) && requestNeedsExactFileReferences(requestContent),
          }),
    };
  }

  const repoGrounded = /\b(?:repo|repository|workspace|codebase|files?|functions?|paths?)\b/i.test(requestContent);
  if (repoGrounded) {
    return {
      route: 'coding_task',
      confidence: 'low',
      operation: 'inspect',
      summary: 'Recovered repo-grounded delegated test request.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: requestNeedsExactFileReferences(requestContent),
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'chat_synthesis',
      entities: {},
    } as const;
  }

  return {
    route: 'general_assistant',
    confidence: 'low',
    operation: 'inspect',
    summary: 'Recovered direct-answer delegated test request.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'direct_assistant',
    preferredTier: 'external',
    requiresRepoGrounding: false,
    requiresToolSynthesis: false,
    requireExactFileReferences: false,
    expectedContextPressure: 'low',
    preferredAnswerPath: 'direct',
    entities: {},
  } as const;
}

function extractTestFileReferences(content: string): string[] {
  const matches = new Set<string>();
  const pattern = /(?:^|[\s`'"])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|rs|py|go|java|yml|yaml|txt|toml))/g;
  for (const match of content.matchAll(pattern)) {
    const ref = match[1]?.trim();
    if (ref) {
      matches.add(ref.replaceAll('\\', '/'));
    }
  }
  return [...matches];
}

function ensureDelegatedResultEnvelopeForTest(
  response: { content: string; metadata?: Record<string, unknown> },
  params: Record<string, unknown> | undefined,
): { content: string; metadata?: Record<string, unknown> } {
  const metadata = response.metadata ? { ...response.metadata } : undefined;
  if (metadata?.skipTestDelegatedEnvelope === true) {
    delete metadata.skipTestDelegatedEnvelope;
    return metadata ? { ...response, metadata } : response;
  }
  if (metadata?.delegatedResult) {
    return response;
  }

  const decision = buildTestGatewayDecisionFromRequest(params);
  const taskContract = buildDelegatedTaskContract(decision);
  const workerExecution = metadata?.workerExecution as Record<string, unknown> | undefined;
  const toolResultCount = typeof workerExecution?.toolResultCount === 'number'
    ? Math.max(0, Math.trunc(workerExecution.toolResultCount))
    : 0;
  const successfulToolResultCount = typeof workerExecution?.successfulToolResultCount === 'number'
    ? Math.max(0, Math.trunc(workerExecution.successfulToolResultCount))
    : 0;
  const fileRefs = extractTestFileReferences(response.content);
  const exactFileReadReceipts = taskContract.requireExactFileReferences
    && taskContract.plan.steps.some((step) => step.kind === 'read')
    && fileRefs.length > 0;
  const receipts = Array.from({ length: successfulToolResultCount }, (_, index) => ({
    receiptId: `test-receipt-${index + 1}`,
    sourceType: 'tool_call' as const,
    toolName: exactFileReadReceipts && index > 0 ? 'fs_read' : 'fs_search',
    status: 'succeeded' as const,
    refs: exactFileReadReceipts && index > 0
      ? [fileRefs[Math.min(index - 1, fileRefs.length - 1)]!]
      : [],
    summary: exactFileReadReceipts && index > 0
      ? `Read ${fileRefs[Math.min(index - 1, fileRefs.length - 1)]!}`
      : `Test receipt ${index + 1}`,
    startedAt: index + 1,
    endedAt: index + 1,
  }));
  if (
    toolResultCount > 0
    && successfulToolResultCount === 0
    && workerExecution?.lifecycle === 'failed'
  ) {
    receipts.push({
      receiptId: 'test-receipt-failed',
      sourceType: 'tool_call',
      toolName: 'tool_call',
      status: 'failed',
      refs: [],
      summary: 'Delegated tool execution failed.',
      startedAt: toolResultCount + 1,
      endedAt: toolResultCount + 1,
    });
  }
  const readReceiptIds = receipts
    .filter((receipt) => receipt.toolName === 'fs_read' && receipt.status === 'succeeded')
    .map((receipt) => receipt.receiptId);
  const claims = [
    ...fileRefs.map((ref, index) => ({
      claimId: `test-file-${index + 1}`,
      kind: 'file_reference' as const,
      subject: ref,
      value: ref,
      evidenceReceiptIds: readReceiptIds.length > 0
        ? [readReceiptIds[Math.min(index, readReceiptIds.length - 1)]!]
        : receipts.length > 0
          ? [receipts[Math.min(index, receipts.length - 1)]!.receiptId]
        : [],
      confidence: 0.8,
    })),
    ...(taskContract.kind === 'filesystem_mutation' && receipts.length > 0
      ? [{
          claimId: 'test-filesystem-mutation',
          kind: 'filesystem_mutation' as const,
          subject: 'filesystem',
          value: response.content.trim() || 'Filesystem mutation completed.',
          evidenceReceiptIds: [receipts[0]!.receiptId],
          confidence: 0.9,
        }]
      : []),
  ];
  const pendingAction = metadata?.pendingAction as {
    blocker?: {
      kind?: string;
      prompt?: string;
      approvalSummaries?: Array<{ id: string; toolName: string; argsPreview?: string }>;
    };
  } | undefined;
  const interruptions = pendingAction?.blocker?.kind
    ? [{
        interruptionId: `test-${pendingAction.blocker.kind}`,
        kind: pendingAction.blocker.kind === 'approval'
          || pendingAction.blocker.kind === 'clarification'
          || pendingAction.blocker.kind === 'workspace_switch'
          ? pendingAction.blocker.kind
          : 'policy_blocked',
        prompt: pendingAction.blocker.prompt ?? 'Delegated worker is waiting for operator input.',
        ...(pendingAction.blocker.kind === 'approval'
          ? {
              approvalSummaries: (pendingAction.blocker.approvalSummaries ?? []).map((summary) => ({
                ...summary,
              })),
            }
          : {}),
      }]
    : [];
  const events = interruptions.length > 0
    ? [{
        eventId: `${interruptions[0]!.interruptionId}:requested`,
        type: 'interruption_requested' as const,
        timestamp: 1,
        payload: {
          kind: interruptions[0]!.kind,
          prompt: interruptions[0]!.prompt,
        },
      }]
    : response.content.trim()
      ? [{
          eventId: 'test-claim',
          type: 'claim_emitted' as const,
          timestamp: 1,
          payload: {
            kind: 'answer',
            content: response.content.trim(),
          },
        }]
      : [];
  const receiptStepIds = new Map<string, string>();
  for (const receipt of receipts) {
    const matchedStepId = matchPlannedStepForTool({
      plannedTask: taskContract.plan,
      toolName: receipt.toolName ?? 'tool_call',
      args: { refs: receipt.refs },
    });
    if (matchedStepId) {
      receiptStepIds.set(receipt.receiptId, matchedStepId);
    }
  }
  const answerStepId = findAnswerStepId(taskContract.plan);
  const answerReceipt = response.content.trim() && interruptions.length === 0 && answerStepId
    ? {
        receiptId: 'test-answer-receipt',
        sourceType: 'model_answer' as const,
        status: 'succeeded' as const,
        refs: [] as string[],
        summary: response.content.trim(),
        startedAt: Math.max(1, receipts.length + 1),
        endedAt: Math.max(1, receipts.length + 1),
      }
    : null;
  if (answerReceipt && answerStepId) {
    receiptStepIds.set(answerReceipt.receiptId, answerStepId);
  }
  const evidenceReceipts = answerReceipt ? [...receipts, answerReceipt] : receipts;
  const stopReason = interruptions.length > 0 ? 'approval_required' : 'end_turn';
  const stepReceipts = buildStepReceipts({
    plannedTask: taskContract.plan,
    evidenceReceipts,
    toolReceiptStepIds: receiptStepIds,
    ...(answerReceipt ? { finalAnswerReceiptId: answerReceipt.receiptId } : {}),
    interruptions,
  });
  const runStatus = computeWorkerRunStatus(
    taskContract.plan,
    stepReceipts,
    interruptions,
    stopReason,
  );

  return {
    ...response,
    metadata: {
      ...(metadata ?? {}),
      ...buildDelegatedExecutionMetadata({
        taskContract,
        runStatus,
        stopReason,
        stepReceipts,
        ...(response.content.trim() && interruptions.length === 0 && runStatus === 'completed'
          ? { finalUserAnswer: response.content.trim() }
          : {}),
        operatorSummary: response.content.trim() || 'Delegated worker completed.',
        claims,
        evidenceReceipts,
        interruptions,
        artifacts: [],
        events,
      }),
    },
  };
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
              const normalizedResponse = ensureDelegatedResultEnvelopeForTest(
                response,
                message.params ?? {},
              );
              this.stdout.write(`${JSON.stringify({
                jsonrpc: '2.0',
                method: 'message.response',
                params: normalizedResponse,
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
    expect(String(firstSpawnArgs[1])).toMatch(/^file:\/\//);
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

  it('appends the code session registry section to delegated worker prompt context when available', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const buildRegistrySection = vi.fn(() => ({
      section: 'Code Session Registry',
      content: '<code-session-registry>\ncurrentSessionId: code-1\n</code-session-registry>',
      mode: 'metadata',
      itemCount: 2,
    }));
    const intentRoutingTrace = {
      record: vi.fn(),
    };

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
        buildCodeSessionRegistryAdditionalSection: buildRegistrySection,
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
      },
    );

    await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-registry',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        surfaceId: 'web-chat',
        channel: 'web',
        content: 'Switch back to the main repo session and inspect auth routing.',
        metadata: {
          codeContext: {
            workspaceRoot: '/repo',
            sessionId: 'code-1',
          },
        },
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      additionalSections: [{
        section: 'Existing Context',
        content: 'existing',
      }],
      toolContext: '',
      runtimeNotices: [],
    });

    expect(buildRegistrySection).toHaveBeenCalledWith({
      userId: 'tester',
      principalId: 'tester',
      principalRole: 'owner',
      channel: 'web',
      surfaceId: 'web-chat',
      codeContext: {
        workspaceRoot: '/repo',
        sessionId: 'code-1',
      },
    });
    const messageHandle = workerNotifications.find((entry) => entry.method === 'message.handle');
    expect(messageHandle?.params.additionalSections).toEqual([
      {
        section: 'Existing Context',
        content: 'existing',
      },
      {
        section: 'Code Session Registry',
        content: '<code-session-registry>\ncurrentSessionId: code-1\n</code-session-registry>',
        mode: 'metadata',
        itemCount: 2,
      },
    ]);
    const runningTrace = intentRoutingTrace.record.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.stage === 'delegated_worker_running');
    expect(runningTrace).toMatchObject({
      stage: 'delegated_worker_running',
      details: {
        taskContractKind: 'general_answer',
        promptAdditionalSectionCount: 2,
        promptAdditionalSectionNames: ['Existing Context', 'Code Session Registry'],
        codeSessionRegistryAttached: true,
        codeSessionRegistryItemCount: 2,
      },
    });

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
      ingestExecutionGraphEvent: vi.fn(),
    };
    const executionGraphStore = new ExecutionGraphStore({
      now: () => 123_456,
    });

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
        executionGraphStore,
        now: () => 123_456,
      },
    );

    const result = await manager.handleMessage({
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
        metadata: generalAssistantDirectMetadata(),
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
      'delegated_worker_contract_reconciled',
      'delegated_interruption_requested',
      'delegated_verification_decided',
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
        taskContractKind: 'general_answer',
        taskContractAllowsAnswerFirst: true,
        taskContractRequiresEvidence: false,
        taskRunId: expect.stringMatching(/^delegated-task:job-[^:]+$/),
        lifecycle: 'running',
      },
    });
    const completedTrace = intentRoutingTrace.record.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.stage === 'delegated_worker_completed');
    expect(completedTrace).toMatchObject({
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
    const graphEvents = runTimeline.ingestExecutionGraphEvent.mock.calls.map(([event]) => event);
    expect(graphEvents.map((event) => event.kind)).toEqual([
      'graph_started',
      'node_started',
      'artifact_created',
      'verification_completed',
      'interruption_requested',
    ]);
    expect(graphEvents[3]).toMatchObject({
      kind: 'verification_completed',
      nodeKind: 'delegated_worker',
      payload: {
        decision: 'blocked',
        valid: false,
      },
    });
    expect(graphEvents[4]).toMatchObject({
      kind: 'interruption_requested',
      nodeKind: 'delegated_worker',
      payload: {
        kind: 'approval',
        approvalCount: 1,
        reportingMode: 'held_for_approval',
      },
    });
    const delegatedGraphId = graphEvents[0]?.graphId ?? '';
    const delegatedSnapshot = executionGraphStore.getSnapshot(delegatedGraphId);
    expect(delegatedSnapshot?.graph.status).toBe('awaiting_approval');
    expect(delegatedSnapshot?.graph.nodes.map((node) => [node.kind, node.status])).toEqual([
      ['delegated_worker', 'awaiting_approval'],
    ]);
    expect(executionGraphStore.listArtifacts(delegatedGraphId).map((artifact) => artifact.artifactType)).toEqual([
      'VerificationResult',
    ]);
    expect(result.metadata?.executionGraph).toMatchObject({
      graphId: delegatedGraphId,
      status: 'awaiting_approval',
      lifecycle: 'blocked',
      verificationArtifactId: expect.stringContaining(':verification'),
    });

    manager.shutdown();
  });

  it('completes delegated worker graph projections for satisfied brokered runs', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = () => ({
      content: 'The report export path is ready.',
    });

    const runTimeline = {
      ingestDelegatedWorkerProgress: vi.fn(),
      ingestExecutionGraphEvent: vi.fn(),
    };
    const executionGraphStore = new ExecutionGraphStore({
      now: () => 123_789,
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
      undefined,
      {
        runTimeline,
        executionGraphStore,
        now: () => 123_789,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-completed-delegated-graph',
        userId: 'tester',
        channel: 'web',
        content: 'Summarize the report export path.',
        metadata: generalAssistantDirectMetadata(),
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      delegation: {
        requestId: 'm-completed-delegated-graph',
        executionId: 'exec-completed-delegated-graph',
        rootExecutionId: 'exec-completed-root',
        originChannel: 'web',
      },
    });

    expect(result.content).toBe('The report export path is ready.');
    expect(runTimeline.ingestDelegatedWorkerProgress.mock.calls.map(([event]) => event.kind)).toEqual([
      'started',
      'running',
      'completed',
    ]);
    const graphEvents = runTimeline.ingestExecutionGraphEvent.mock.calls.map(([event]) => event);
    expect(graphEvents.map((event) => event.kind)).toEqual([
      'graph_started',
      'node_started',
      'artifact_created',
      'verification_completed',
      'node_completed',
      'graph_completed',
    ]);
    const graphId = graphEvents[0]?.graphId ?? '';
    const snapshot = executionGraphStore.getSnapshot(graphId);
    expect(snapshot?.graph.status).toBe('completed');
    expect(snapshot?.graph.nodes.map((node) => [node.kind, node.status])).toEqual([
      ['delegated_worker', 'completed'],
    ]);
    expect(executionGraphStore.listArtifacts(graphId).map((artifact) => artifact.artifactType)).toEqual([
      'VerificationResult',
    ]);
    expect(result.metadata?.executionGraph).toMatchObject({
      graphId,
      status: 'completed',
      lifecycle: 'completed',
      verificationArtifactId: expect.stringContaining(':verification'),
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
    expect(result.content).toContain('Delegated worker stopped before satisfying every required planned step.');

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
            nextAction: expect.stringContaining('step_1'),
          },
        },
      },
    });

    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'recovery_advisor_started',
      'recovery_advisor_rejected',
      'delegated_worker_contract_reconciled',
      'delegated_claim_emitted',
      'delegated_verification_decided',
      'delegated_worker_failed',
    ]);
    const failedTrace = intentRoutingTrace.record.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.stage === 'delegated_worker_failed');
    expect(failedTrace).toMatchObject({
      stage: 'delegated_worker_failed',
      requestId: 'm-failed-delegated',
      contentPreview: 'Delegated worker stopped before satisfying every required planned step.',
      details: {
        taskRunId: expect.stringMatching(/^delegated-task:job-[^:]+$/),
        lifecycle: 'failed',
        reason: 'Delegated worker stopped before satisfying every required planned step.',
        handoffSummary: 'Delegated worker stopped before satisfying every required planned step.',
        handoffNextAction: expect.stringContaining('step_1'),
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
      detail: 'Delegated worker stopped before satisfying every required planned step.',
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
    expect(result.content).toContain('Delegated worker did not return the exact file references requested after repo inspection.');

    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'recovery_advisor_started',
      'recovery_advisor_rejected',
      'delegated_worker_contract_reconciled',
      'delegated_claim_emitted',
      'delegated_verification_decided',
      'delegated_worker_failed',
    ]);
    const repoFailureTrace = intentRoutingTrace.record.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.stage === 'delegated_worker_failed');
    expect(repoFailureTrace).toMatchObject({
      stage: 'delegated_worker_failed',
      requestId: 'm-repo-grounding-failed',
      details: {
        lifecycle: 'failed',
        reason: 'Delegated worker did not return the exact file references requested after repo inspection.',
        handoffSummary: 'Delegated worker did not return the exact file references requested after repo inspection.',
        handoffNextAction: expect.stringContaining('step_1'),
        workerExecutionCompletionReason: 'answer_first_response',
        workerExecutionToolCallCount: 0,
        workerExecutionToolResultCount: 0,
        workerExecutionSuccessfulToolResultCount: 0,
      },
    });
    expect(runTimeline.ingestDelegatedWorkerProgress.mock.calls[2]?.[0]).toMatchObject({
      kind: 'failed',
      requestId: 'm-repo-grounding-failed',
      detail: 'Delegated worker did not return the exact file references requested after repo inspection.',
    });

    manager.shutdown();
  });

  it('allows delegated direct general-assistant turns to complete without repo evidence even when a code session is visible', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = () => ({
      content: 'GuardianAgent is a security-first AI assistant for daily use, guarded workstation operations, and coding workflows.',
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
        now: () => 123_556,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-general-assistant-direct',
        userId: 'tester',
        principalId: 'tester',
        principalRole: 'owner',
        channel: 'web',
        content: 'In one sentence, what is this project?',
        metadata: generalAssistantDirectMetadata(),
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      delegation: {
        requestId: 'm-general-assistant-direct',
        originChannel: 'web',
        codeSessionId: 'code-1',
        orchestration: {
          role: 'coordinator',
          label: 'Guardian Coordinator',
        },
      },
    });

    expect(result.content).toBe('GuardianAgent is a security-first AI assistant for daily use, guarded workstation operations, and coding workflows.');
    expect(result.content).not.toContain('Delegated work failed.');
    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_worker_contract_reconciled',
      'delegated_claim_emitted',
      'delegated_verification_decided',
      'delegated_worker_completed',
    ]);
    expect(intentRoutingTrace.record.mock.calls[0]?.[0]).toMatchObject({
      stage: 'delegated_worker_started',
      requestId: 'm-general-assistant-direct',
      details: {
        delegatedIntentRoute: 'general_assistant',
        delegatedIntentExecutionClass: 'direct_assistant',
        delegatedIntentRequiresRepoGrounding: false,
        delegatedIntentPreferredAnswerPath: 'direct',
      },
    });
    const generalAssistantCompletedTrace = intentRoutingTrace.record.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.stage === 'delegated_worker_completed');
    expect(generalAssistantCompletedTrace).toMatchObject({
      stage: 'delegated_worker_completed',
      requestId: 'm-general-assistant-direct',
      details: {
        lifecycle: 'completed',
        workerExecutionCompletionReason: 'answer_first_response',
        workerExecutionToolCallCount: 0,
        workerExecutionToolResultCount: 0,
        workerExecutionSuccessfulToolResultCount: 0,
      },
    });
    expect(runTimeline.ingestDelegatedWorkerProgress.mock.calls.map(([event]) => event.kind)).toEqual([
      'started',
      'running',
      'completed',
    ]);

    manager.shutdown();
  });

  it('fails delegated worker results that omit the typed result envelope', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    workerMessageHandler = () => ({
      content: 'The delegated worker progress implementation lives in src/supervisor/worker-manager.ts.',
      metadata: {
        skipTestDelegatedEnvelope: true,
        workerExecution: {
          lifecycle: 'failed',
          source: 'tool_loop',
          completionReason: 'degraded_response',
          responseQuality: 'degraded',
          terminationReason: 'disconnect',
          toolCallCount: 0,
          toolResultCount: 0,
          successfulToolResultCount: 0,
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
        id: 'm-missing-envelope',
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
      delegation: {
        requestId: 'm-missing-envelope',
        originChannel: 'web',
      },
    });

    expect(result.content).toContain('Delegated work failed.');
    expect(result.content).toContain('typed result envelope');

    manager.shutdown();
  });

  it('retries missing-envelope delegated runs when the worker shows partial progress and hits its budget', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const dispatchProfiles: Array<string | undefined> = [];
    workerMessageHandler = (params) => {
      const executionProfile = params.executionProfile as { providerName?: string; providerTier?: string } | undefined;
      dispatchProfiles.push(executionProfile?.providerName);
      if (executionProfile?.providerTier === 'frontier') {
        return {
          content: 'The delegated worker completion contract is defined in src/runtime/execution/types.ts, src/runtime/execution/task-plan.ts, src/runtime/execution/verifier.ts, and src/runtime/execution/metadata.ts.',
          metadata: {
            workerExecution: {
              lifecycle: 'completed',
              source: 'tool_loop',
              completionReason: 'model_response',
              responseQuality: 'final',
              terminationReason: 'clean_exit',
              toolCallCount: 4,
              toolResultCount: 4,
              successfulToolResultCount: 4,
            },
          },
        };
      }
      return {
        content: 'I searched the repo and started reading the contract files, but I ran out of turns before I could finish the final grounded answer.',
        metadata: {
          skipTestDelegatedEnvelope: true,
          workerExecution: {
            lifecycle: 'failed',
            source: 'tool_loop',
            completionReason: 'degraded_response',
            responseQuality: 'degraded',
            terminationReason: 'max_rounds',
            roundCount: 30,
            toolCallCount: 2,
            toolResultCount: 1,
            successfulToolResultCount: 1,
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
        listJobs: vi.fn(() => [
          {
            id: 'job-contract-search',
            toolName: 'fs_search',
            status: 'succeeded',
            requestId: 'm-missing-envelope-budget',
            argsPreview: '{"path":"src/runtime","pattern":"DelegatedResultEnvelope"}',
            resultPreview: '{"matches":["src/runtime/execution/types.ts"]}',
            createdAt: 10,
            startedAt: 20,
            completedAt: 30,
          },
          {
            id: 'job-contract-read',
            toolName: 'fs_read',
            status: 'running',
            requestId: 'm-missing-envelope-budget',
            argsPreview: '{"path":"src/runtime/execution/verifier.ts"}',
            createdAt: 40,
            startedAt: 50,
          },
        ]),
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
        now: () => 654_000,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-missing-envelope-budget',
        userId: 'tester',
        channel: 'web',
        content: 'Inspect this repo and tell me which files and functions or types now define the delegated worker completion contract. Cite exact file names and symbol names.',
        metadata: attachPreRoutedIntentGatewayMetadata(undefined, {
          mode: 'primary',
          available: true,
          model: 'test-model',
          latencyMs: 1,
          decision: {
            route: 'coding_task',
            confidence: 'high',
            operation: 'inspect',
            summary: 'Inspect the repo and identify the delegated worker completion contract files and symbols.',
            turnRelation: 'new_request',
            resolution: 'ready',
            missingFields: [],
            executionClass: 'repo_grounded',
            preferredTier: 'external',
            requiresRepoGrounding: true,
            requiresToolSynthesis: true,
            requireExactFileReferences: true,
            expectedContextPressure: 'high',
            preferredAnswerPath: 'chat_synthesis',
            plannedSteps: [
              { kind: 'search', summary: 'Search the repo for the delegated worker completion contract files.', required: true },
              { kind: 'answer', summary: 'Answer with exact file names and symbol names grounded in the repo evidence.', required: true, dependsOn: ['step_1'] },
            ],
            entities: {},
          },
        }),
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
        expectedContextPressure: 'high',
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
        requestId: 'm-missing-envelope-budget',
        executionId: 'exec-missing-envelope-budget',
        rootExecutionId: 'exec-missing-envelope-root',
        originChannel: 'web',
        orchestration: {
          role: 'explorer',
          label: 'Workspace Explorer',
          lenses: ['coding-workspace'],
        },
      },
    });

    expect(dispatchProfiles).toEqual(['ollama-cloud-coding', 'openai-frontier']);
    expect(result.content).toContain('src/runtime/execution/types.ts');
    expect(result.content).toContain('src/runtime/execution/verifier.ts');
    expect(result.content).not.toContain('Delegated work failed.');
    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_job_wait_expired',
      'delegated_worker_retrying',
      'delegated_job_wait_expired',
      'delegated_worker_contract_reconciled',
      'delegated_claim_emitted',
      'delegated_verification_decided',
      'delegated_worker_completed',
    ]);

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
      'delegated_worker_contract_reconciled',
      'delegated_claim_emitted',
      'delegated_verification_decided',
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

  it('fails exact-file delegated repo inspections after exhausting a same-profile corrective retry when no stronger escalation profile is available', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const dispatchProfiles: Array<string | undefined> = [];
    workerMessageHandler = (params) => {
      const executionProfile = params.executionProfile as { providerName?: string } | undefined;
      dispatchProfiles.push(executionProfile?.providerName);
      return {
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

    expect(dispatchProfiles).toEqual(['ollama-cloud-coding', 'ollama-cloud-coding', 'ollama-cloud-coding']);
    expect(result.content).toContain('Delegated work failed.');
    expect(result.content).toContain('exact file references requested');
    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_worker_retrying',
      'recovery_advisor_started',
      'recovery_advisor_rejected',
      'delegated_worker_contract_reconciled',
      'delegated_claim_emitted',
      'delegated_verification_decided',
      'delegated_worker_failed',
    ]);

    manager.shutdown();
  });

  it('records verifier-failure trace diagnostics with tool previews without exposing them in returned metadata', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const gatewayDecision = readPreRoutedIntentGatewayMetadata(repoGroundedCodingMetadata())?.decision;
    const intentRoutingTrace = {
      record: vi.fn(),
    };

    workerMessageHandler = () => ({
      content: 'The search output was truncated, so I cannot provide exact grounded file references yet.',
      metadata: {
        delegatedResult: {
          taskContract: buildDelegatedTaskContract(gatewayDecision),
          operatorSummary: 'Search output was truncated before exact file references could be proven.',
          claims: [],
          evidenceReceipts: [],
          interruptions: [],
          artifacts: [],
          events: [{
            eventId: 'tool-1:completed',
            nodeId: 'tool-1',
            type: 'tool_call_completed',
            timestamp: 1,
            payload: {
              toolCallId: 'tool-1',
              toolName: 'fs_search',
              resultStatus: 'succeeded',
              resultMessage: 'Search completed.',
              traceResultPreview: '{"success":true,"output":{"matches":["src/runtime/intent-routing-trace.ts [content] trace details"]}}',
            },
          }],
        },
        workerExecution: {
          lifecycle: 'completed',
          source: 'tool_loop',
          completionReason: 'model_response',
          responseQuality: 'final',
          toolCallCount: 1,
          toolResultCount: 1,
          successfulToolResultCount: 1,
        },
      },
    });

    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
        listJobs: () => [{
          id: 'job-1',
          toolName: 'fs_search',
          risk: 'read_only',
          origin: 'assistant',
          argsPreview: '{"query":"trace"}',
          status: 'succeeded',
          createdAt: 1,
          requestId: 'm-trace-failure',
          resultPreview: '{"matches":["src/runtime/intent-routing-trace.ts"]}',
          requiresApproval: false,
        }],
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
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-trace-failure',
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
      delegation: {
        requestId: 'm-trace-failure',
        originChannel: 'web',
      },
    });

    const verificationTrace = intentRoutingTrace.record.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.stage === 'delegated_verification_decided');
    expect(verificationTrace?.details.verificationFailureDiagnostics).toMatchObject({
      requestId: 'm-trace-failure',
      jobSnapshots: [{
        toolName: 'fs_search',
        resultPreview: '{"matches":["src/runtime/intent-routing-trace.ts"]}',
      }],
    });
    expect(JSON.stringify(result.metadata ?? {})).not.toContain('traceResultPreview');

    manager.shutdown();
  });

  it('retries exact-file delegated repo inspections on the same frontier profile when truncated search output can be corrected without escalation', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const dispatchProfiles: Array<string | undefined> = [];
    let attempts = 0;
    workerMessageHandler = (params) => {
      const executionProfile = params.executionProfile as { providerName?: string } | undefined;
      dispatchProfiles.push(executionProfile?.providerName);
      attempts += 1;
      if (attempts > 1) {
        return {
          content: [
            'Live progress in chat is rendered in `web/public/js/chat-panel.js` and matched in `web/public/js/chat-run-tracking.js`.',
            'Repo timelines are rendered in `web/public/js/pages/code.js`, `web/public/js/pages/system.js`, and `web/public/js/pages/automations.js`.',
          ].join('\n'),
          metadata: {
            workerExecution: {
              lifecycle: 'completed',
              source: 'tool_loop',
              completionReason: 'model_response',
              responseQuality: 'final',
              toolCallCount: 5,
              toolResultCount: 5,
              successfulToolResultCount: 5,
            },
          },
        };
      }
      return {
        content: [
          'The filename searches found matches for "progress" and "timeline", but the tool output was truncated and I cannot surface the exact file names yet.',
          'I would need to drill into likely directories next.',
        ].join(' '),
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
        getConfigSnapshot: () => {
          const config = createExecutionProfileTestConfig();
          delete config.llm['ollama-cloud-coding'];
          config.assistant.tools.preferredProviders = {
            ...config.assistant.tools.preferredProviders,
            managedCloud: '',
          };
          return config;
        },
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
        now: () => 400_200,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-retry-same-profile-exact-files',
        userId: 'tester',
        channel: 'web',
        content: 'Inspect the repo and name the client-side files that render live progress or timeline activity. Do not edit anything.',
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
        id: 'openai-frontier',
        providerName: 'openai-frontier',
        providerType: 'openai',
        providerModel: 'gpt-5.4',
        providerLocality: 'external',
        providerTier: 'frontier',
        requestedTier: 'external',
        preferredAnswerPath: 'tool_loop',
        expectedContextPressure: 'medium',
        contextBudget: 32_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['openai-frontier'],
        reason: 'frontier repo inspection profile selected',
        routingMode: 'auto',
        selectionSource: 'delegated_role',
      },
      delegation: {
        requestId: 'm-retry-same-profile-exact-files',
        executionId: 'exec-retry-same-profile-exact-files',
        rootExecutionId: 'exec-retry-same-profile-exact-files-root',
        originChannel: 'web',
        orchestration: {
          role: 'explorer',
          label: 'Workspace Explorer',
          lenses: ['coding-workspace'],
        },
      },
    });

    expect(dispatchProfiles).toEqual(['openai-frontier', 'openai-frontier']);
    expect(result.content).toContain('web/public/js/chat-panel.js');
    expect(result.content).toContain('web/public/js/chat-run-tracking.js');
    expect(result.content).toContain('web/public/js/pages/code.js');
    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_worker_retrying',
      'delegated_worker_contract_reconciled',
      'delegated_claim_emitted',
      'delegated_verification_decided',
      'delegated_worker_completed',
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
      'delegated_worker_contract_reconciled',
      'delegated_claim_emitted',
      'delegated_verification_decided',
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

  it('retries delegated repo inspections that answer code-path requests with an ungrounded "not found" summary', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const dispatchProfiles: Array<string | undefined> = [];
    workerMessageHandler = (params) => {
      const executionProfile = params.executionProfile as { providerName?: string; providerTier?: string } | undefined;
      dispatchProfiles.push(executionProfile?.providerName);
      if (executionProfile?.providerTier === 'frontier') {
        return {
          content: [
            'Delegated worker progress is rendered in `web/public/js/chat-panel.js`.',
            'The run timeline client-side updates are normalized in `web/public/js/chat-run-tracking.js`.',
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
        content: [
          'The search found no client-side files matching "progress", "timeline", "activity", or "live render" patterns.',
          'This aligns with the repo profile: GuardianAgent is a backend Node.js/TypeScript agent project, not a frontend UI application.',
          'Repo map directories show no client/, ui/, or src/ client folders listed.',
        ].join(' '),
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
        now: () => 777_100,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-retry-code-paths',
        userId: 'tester',
        channel: 'web',
        content: 'Inspect the repo and summarize where delegated worker progress is rendered in the web UI. Name the client-side code paths only.',
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
        requestId: 'm-retry-code-paths',
        executionId: 'exec-retry-code-paths',
        rootExecutionId: 'exec-retry-code-paths-root',
        originChannel: 'web',
        orchestration: {
          role: 'explorer',
          label: 'Workspace Explorer',
          lenses: ['coding-workspace'],
        },
      },
    });

    expect(dispatchProfiles).toEqual(['ollama-cloud-coding', 'openai-frontier']);
    expect(result.content).toContain('web/public/js/chat-panel.js');
    expect(result.content).toContain('web/public/js/chat-run-tracking.js');
    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_worker_retrying',
      'delegated_worker_contract_reconciled',
      'delegated_claim_emitted',
      'delegated_verification_decided',
      'delegated_worker_completed',
    ]);

    manager.shutdown();
  });

  it('retries imperative client-side file requests when the delegated worker stops at truncated filename-search summaries', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const dispatchProfiles: Array<string | undefined> = [];
    workerMessageHandler = (params) => {
      const executionProfile = params.executionProfile as { providerName?: string; providerTier?: string } | undefined;
      dispatchProfiles.push(executionProfile?.providerName);
      if (executionProfile?.providerTier === 'frontier') {
        return {
          content: [
            'Live progress in chat is rendered in `web/public/js/chat-panel.js` and matched in `web/public/js/chat-run-tracking.js`.',
            'Broader timeline activity is rendered in `web/public/js/pages/code.js`, `web/public/js/pages/system.js`, and `web/public/js/pages/automations.js`.',
          ].join('\n'),
          metadata: {
            workerExecution: {
              lifecycle: 'completed',
              source: 'tool_loop',
              completionReason: 'model_response',
              responseQuality: 'final',
              toolCallCount: 5,
              toolResultCount: 5,
              successfulToolResultCount: 5,
            },
          },
        };
      }
      return {
        content: [
          'The filename searches this time did find matches, but the tool output was truncated and I cannot see the actual file names from the serialized results.',
          'The repo has a `demo/` directory and an `examples/` directory at the top level, which are the most likely locations for any client-side rendering code.',
          'To get you the specific file names, I would need to do a focused `fs_list` on those directories or read the search results at a narrower scope. Want me to drill into those directories next?',
        ].join(' '),
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
        now: () => 777_150,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-retry-client-side-files',
        userId: 'tester',
        channel: 'web',
        content: 'Inspect the repo and name the client-side files that render live progress or timeline activity. Do not edit anything.',
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
        requestId: 'm-retry-client-side-files',
        executionId: 'exec-retry-client-side-files',
        rootExecutionId: 'exec-retry-client-side-files-root',
        originChannel: 'web',
        orchestration: {
          role: 'explorer',
          label: 'Workspace Explorer',
          lenses: ['coding-workspace'],
        },
      },
    });

    expect(dispatchProfiles).toEqual(['ollama-cloud-coding', 'openai-frontier']);
    expect(result.content).toContain('web/public/js/chat-panel.js');
    expect(result.content).toContain('web/public/js/chat-run-tracking.js');
    expect(result.content).toContain('web/public/js/pages/system.js');
    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_worker_retrying',
      'delegated_worker_contract_reconciled',
      'delegated_claim_emitted',
      'delegated_verification_decided',
      'delegated_worker_completed',
    ]);

    manager.shutdown();
  });

  it('retries delegated repo inspections that claim they cannot identify the requested files and functions', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const dispatchProfiles: Array<string | undefined> = [];
    workerMessageHandler = (params) => {
      const executionProfile = params.executionProfile as { providerName?: string; providerTier?: string } | undefined;
      dispatchProfiles.push(executionProfile?.providerName);
      if (executionProfile?.providerTier === 'frontier') {
        return {
          content: [
            'Delegated local model selection is aligned in `src/runtime/execution-profiles.ts`.',
            'The explicit local default provider resolution is applied in `resolveDelegatedExecutionDecision` and `selectEscalatedDelegatedExecutionProfile`.',
          ].join('\n'),
          metadata: {
            workerExecution: {
              lifecycle: 'completed',
              source: 'tool_loop',
              completionReason: 'model_response',
              responseQuality: 'final',
              toolCallCount: 3,
              toolResultCount: 3,
              successfulToolResultCount: 3,
            },
          },
        };
      }
      return {
        content: 'Based on the tool results available in this conversation, I cannot identify any files or functions that keep delegated local model selection aligned with an explicit local default provider.',
        metadata: {
          workerExecution: {
            lifecycle: 'completed',
            source: 'tool_loop',
            completionReason: 'model_response',
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
                    label: 'Provider Explorer',
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
        now: () => 777_200,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-retry-files-and-functions',
        userId: 'tester',
        channel: 'web',
        content: 'Inspect the repo and tell me which files and functions now keep delegated local model selection aligned with an explicit local default provider. Cite exact file names and function names.',
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
        providerName: 'ollama-cloud-tools',
        providerType: 'ollama_cloud',
        providerModel: 'glm-4.7',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'tool_loop',
        expectedContextPressure: 'medium',
        contextBudget: 32_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['ollama-cloud-tools', 'openai-frontier'],
        reason: 'delegated explorer selected managed-cloud tools profile',
        routingMode: 'auto',
        selectionSource: 'delegated_role',
      },
      delegation: {
        requestId: 'm-retry-files-and-functions',
        executionId: 'exec-retry-files-and-functions',
        rootExecutionId: 'exec-retry-files-and-functions-root',
        originChannel: 'web',
        orchestration: {
          role: 'explorer',
          label: 'Provider Explorer',
          lenses: ['coding-workspace'],
        },
      },
    });

    expect(dispatchProfiles).toEqual(['ollama-cloud-tools', 'openai-frontier']);
    expect(result.content).toContain('src/runtime/execution-profiles.ts');
    expect(result.content).toContain('resolveDelegatedExecutionDecision');
    expect(result.content).toContain('selectEscalatedDelegatedExecutionProfile');
    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual([
      'delegated_worker_started',
      'delegated_worker_running',
      'delegated_worker_retrying',
      'delegated_worker_contract_reconciled',
      'delegated_claim_emitted',
      'delegated_verification_decided',
      'delegated_worker_completed',
    ]);

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
      'delegated_worker_contract_reconciled',
      'delegated_claim_emitted',
      'delegated_verification_decided',
      'delegated_worker_completed',
    ]);
    expect(intentRoutingTrace.record.mock.calls[2]?.[0]).toMatchObject({
      stage: 'delegated_worker_retrying',
      details: {
        reason: expect.stringContaining('required steps remain unsatisfied'),
        executionProfileName: 'openai-frontier',
        executionProfileTier: 'frontier',
      },
    });

    manager.shutdown();
  });

  it('keeps delegated retry guidance advisory without carrying prior receipts into the worker', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const retryDirectives: string[] = [];
    let dispatchCount = 0;
    workerMessageHandler = (params) => {
      dispatchCount += 1;
      const retryDirective = Array.isArray(params.additionalSections)
        ? (params.additionalSections as Array<{ section?: string; content?: string }>)
            .find((section) => section.section === 'Delegated Retry Directive')?.content ?? ''
        : '';
      retryDirectives.push(retryDirective);

      if (dispatchCount === 1) {
        const gatewayDecision = readPreRoutedIntentGatewayMetadata(repoGroundedCodingMetadata())?.decision;
        const taskContract = buildDelegatedTaskContract(gatewayDecision);
        return {
          content: 'I found likely files, but I still need to inspect them directly.',
          metadata: buildDelegatedExecutionMetadata({
            taskContract,
            runStatus: 'incomplete',
            stopReason: 'end_turn',
            stepReceipts: [
              {
                stepId: 'step_1',
                status: 'satisfied',
                evidenceReceiptIds: ['receipt-search'],
                summary: 'Search found candidate files.',
                startedAt: 1,
                endedAt: 2,
              },
              {
                stepId: 'step_2',
                status: 'failed',
                evidenceReceiptIds: [],
                summary: 'Read the specific implementation files needed to ground the exact file references.',
                startedAt: 0,
                endedAt: 0,
              },
              {
                stepId: 'step_3',
                status: 'satisfied',
                evidenceReceiptIds: ['receipt-answer'],
                summary: 'The likely files are src/support/workerProgress.ts and src/timeline/renderTimeline.ts.',
                startedAt: 3,
                endedAt: 4,
              },
            ],
            operatorSummary: 'The likely files are src/support/workerProgress.ts and src/timeline/renderTimeline.ts.',
            claims: [],
            evidenceReceipts: [
              {
                receiptId: 'receipt-search',
                sourceType: 'tool_call',
                toolName: 'fs_search',
                status: 'succeeded',
                refs: [
                  'src/supervisor/worker-manager.ts',
                  'src/runtime/run-timeline.ts',
                  'web/public/js/chat-panel.js',
                  'web/public/js/chat-run-tracking.js',
                ],
                summary: 'Search found candidate implementation files.',
                startedAt: 1,
                endedAt: 2,
              },
              {
                receiptId: 'receipt-answer',
                sourceType: 'model_answer',
                status: 'succeeded',
                refs: [],
                summary: 'The likely files are src/support/workerProgress.ts and src/timeline/renderTimeline.ts.',
                startedAt: 3,
                endedAt: 4,
              },
            ],
            interruptions: [],
            artifacts: [],
            events: [],
          }),
        };
      }

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
        now: () => 888_000,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-exact-file-retry-deps',
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
        requestId: 'm-exact-file-retry-deps',
        executionId: 'exec-exact-file-retry-deps',
        rootExecutionId: 'exec-exact-file-retry-root',
        originChannel: 'web',
        orchestration: {
          role: 'explorer',
          label: 'Workspace Explorer',
          lenses: ['coding-workspace'],
        },
      },
    });

    expect(result.content).toContain('src/supervisor/worker-manager.ts');
    expect(result.content).toContain('web/public/js/chat-panel.js');
    expect(retryDirectives[1]).toContain('Grounded file/path candidates from already satisfied steps:');
    expect(retryDirectives[1]).toContain('src/supervisor/worker-manager.ts');
    expect(retryDirectives[1]).toContain('src/runtime/run-timeline.ts');
    expect(retryDirectives[1]).toContain('web/public/js/chat-panel.js');
    expect(retryDirectives[1]).toContain('Reuse those grounded candidates before starting any new speculative search.');
    expect(intentRoutingTrace.record.mock.calls[2]?.[0]).toMatchObject({
      stage: 'delegated_worker_retrying',
    });

    manager.shutdown();
  });

  it('records validated recovery-advisor guidance as advisory graph recovery without a final worker retry', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const dispatchModes: string[] = [];
    workerMessageHandler = (params) => {
      if (params.recoveryAdvisor) {
        dispatchModes.push('advisor');
        return {
          content: JSON.stringify({
            decision: 'retry',
            reason: 'The write step has no filesystem mutation receipt.',
            actions: [{
              stepId: 'step_2',
              strategy: 'complete_missing_write',
              toolName: 'fs_write',
            }],
          }),
          metadata: {
            recoveryAdvisor: {
              available: true,
              proposal: {
                decision: 'retry',
                reason: 'The write step has no filesystem mutation receipt.',
                actions: [{
                  stepId: 'step_2',
                  strategy: 'complete_missing_write',
                  toolName: 'fs_write',
                }],
              },
            },
          },
        };
      }

      dispatchModes.push('worker');

      const gatewayDecision = readPreRoutedIntentGatewayMetadata(filesystemSearchWriteMetadata())?.decision;
      const taskContract = buildDelegatedTaskContract(gatewayDecision);
      return {
        content: 'I searched src/runtime for planned_steps but did not write the summary file.',
        metadata: buildDelegatedExecutionMetadata({
          taskContract,
          runStatus: 'incomplete',
          stopReason: 'end_turn',
          stepReceipts: taskContract.plan.steps.map((step) => ({
            stepId: step.stepId,
            status: step.stepId === 'step_1' ? 'satisfied' as const : 'failed' as const,
            evidenceReceiptIds: step.stepId === 'step_1'
              ? [`receipt-${step.stepId}`]
              : [],
            summary: step.summary,
            startedAt: 1,
            endedAt: 2,
          })),
          operatorSummary: 'I searched src/runtime for planned_steps but did not write the summary file.',
          claims: [],
          evidenceReceipts: [
            {
              receiptId: 'receipt-step_1',
              sourceType: 'tool_call',
              toolName: 'fs_search',
              status: 'succeeded',
              refs: ['src/runtime/intent/route-classifier.ts'],
              summary: 'Searched src/runtime for planned_steps.',
              startedAt: 1,
              endedAt: 2,
            },
          ],
          interruptions: [],
          artifacts: [],
          events: [],
        }),
      };
    };

    const jobs = [
      {
        id: 'job-planned-steps-search',
        toolName: 'fs_search',
        status: 'succeeded',
        requestId: 'm-search-write-recovery',
        argsPreview: '{"path":"src/runtime","query":"planned_steps","mode":"content"}',
        resultPreview: '{"matches":[{"path":"src/runtime/intent/route-classifier.ts"}]}',
        createdAt: 10,
        startedAt: 20,
        completedAt: 30,
      },
      {
        id: 'job-planned-steps-write',
        toolName: 'fs_write',
        status: 'succeeded',
        requestId: 'm-search-write-recovery',
        argsPreview: '{"path":"tmp/manual-web/planned-steps-summary.txt","content":"planned_steps summary"}',
        resultPreview: '{"path":"tmp/manual-web/planned-steps-summary.txt","bytesWritten":21}',
        createdAt: 40,
        startedAt: 50,
        completedAt: 60,
      },
    ];
    const intentRoutingTrace = {
      record: vi.fn(),
    };
    const runTimeline = {
      ingestDelegatedWorkerProgress: vi.fn(),
      ingestDelegatedExecutionEvents: vi.fn(),
      ingestExecutionGraphEvent: vi.fn(),
    };
    const executionGraphStore = new ExecutionGraphStore({
      now: () => 1_010_000,
    });
    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
        listJobs: vi.fn(() => jobs.slice(0, 1)),
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        auditLog: { record: vi.fn() },
        registry: {
          get: (agentId: string) => agentId === 'local'
            ? {
                agent: { name: 'Guardian Agent' },
                definition: {
                  orchestration: {
                    role: 'implementer',
                    label: 'Workspace Implementer',
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
        executionGraphStore,
        now: () => 1_010_000,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-search-write-recovery',
        userId: 'tester',
        channel: 'web',
        content: 'Search src/runtime for planned_steps. Write a short summary of what you find to tmp/manual-web/planned-steps-summary.txt.',
        metadata: filesystemSearchWriteMetadata(),
        timestamp: Date.now(),
      },
      systemPrompt: 'system',
      history: [],
      knowledgeBases: [],
      activeSkills: [],
      additionalSections: [],
      toolContext: '',
      runtimeNotices: [],
      delegation: {
        requestId: 'm-search-write-recovery',
        executionId: 'exec-search-write-recovery',
        rootExecutionId: 'exec-search-write-root',
        originChannel: 'web',
        orchestration: {
          role: 'implementer',
          label: 'Workspace Implementer',
          lenses: ['coding-workspace'],
        },
      },
    });

    expect(dispatchModes).toEqual(['worker', 'advisor']);
    expect(result.content).toContain('Delegated work failed.');
    expect(result.content).toContain('step_2 (Write a short summary');
    expect(result.metadata?.executionGraphRecovery).toMatchObject({
      adviceSource: 'llm',
      actionKinds: ['retry_node'],
    });
    const recoveryMetadata = result.metadata?.executionGraphRecovery as { graphId?: string } | undefined;
    const graphId = recoveryMetadata?.graphId ?? '';
    const graphEvents = runTimeline.ingestExecutionGraphEvent.mock.calls.map(([event]) => event);
    const delegatedEvents = graphEvents.filter((event) => event.graphId.endsWith(':delegated-worker'));
    expect(delegatedEvents.map((event) => event.kind)).toEqual([
      'graph_started',
      'node_started',
      'artifact_created',
      'verification_completed',
      'node_failed',
      'graph_failed',
    ]);
    const delegatedSnapshot = executionGraphStore.getSnapshot(delegatedEvents[0]?.graphId ?? '');
    expect(delegatedSnapshot?.graph.status).toBe('failed');
    expect(delegatedSnapshot?.graph.nodes.map((node) => [node.kind, node.status])).toEqual([
      ['delegated_worker', 'failed'],
    ]);
    expect(executionGraphStore.listArtifacts(delegatedEvents[0]?.graphId ?? '').map((artifact) => artifact.artifactType)).toEqual([
      'VerificationResult',
    ]);
    expect(result.metadata?.executionGraph).toMatchObject({
      graphId: delegatedEvents[0]?.graphId,
      status: 'failed',
      lifecycle: 'failed',
      verificationArtifactId: expect.stringContaining(':verification'),
    });
    const recoveryEvents = graphEvents.filter((event) => event.graphId === graphId);
    expect(recoveryEvents.map((event) => event.kind)).toEqual([
      'graph_started',
      'node_started',
      'artifact_created',
      'recovery_proposed',
      'node_completed',
      'graph_completed',
    ]);
    const recoverySnapshot = executionGraphStore.getSnapshot(graphId);
    expect(recoverySnapshot?.graph.status).toBe('completed');
    expect(recoverySnapshot?.graph.nodes.map((node) => [node.kind, node.status])).toEqual([
      ['delegated_worker', 'failed'],
      ['recover', 'completed'],
    ]);
    expect(recoverySnapshot?.events.map((event) => event.kind)).toEqual([
      'graph_started',
      'node_started',
      'artifact_created',
      'recovery_proposed',
      'node_completed',
      'graph_completed',
    ]);
    expect(executionGraphStore.listArtifacts(graphId).map((artifact) => artifact.artifactType)).toEqual([
      'RecoveryProposal',
    ]);
    expect(intentRoutingTrace.record.mock.calls.map(([entry]) => entry.stage)).toEqual(expect.arrayContaining([
      'recovery_advisor_started',
      'recovery_advisor_completed',
      'delegated_worker_failed',
    ]));

    manager.shutdown();
  });

  it('runs read/write repo tasks through the graph controller without delegated handoff', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const dispatchModes: string[] = [];
    workerMessageHandler = (params) => {
      const directReasoning = params.directReasoning === true;
      const groundedSynthesis = !!params.groundedSynthesis;
      dispatchModes.push(directReasoning ? 'direct' : groundedSynthesis ? 'synthesis' : 'delegated');
      const gateway = readPreRoutedIntentGatewayMetadata(
        (params.message as { metadata?: Record<string, unknown> } | undefined)?.metadata,
      );

      if (directReasoning) {
        expect(gateway?.decision.operation).toBe('search');
        expect(gateway?.decision.executionClass).toBe('repo_grounded');
        expect((params.message as { content?: string } | undefined)?.content).toContain('Read-only execution graph exploration node');
        const context = params.directReasoningGraphContext as { graphId: string; nodeId: string };
        return {
          content: 'Found planned_steps references in src/runtime/intent/route-classifier.ts.',
          metadata: {
            skipTestDelegatedEnvelope: true,
            directReasoning: true,
            directReasoningMode: 'brokered_readonly',
            executionGraphArtifacts: [
              buildSearchResultSetArtifact({
                graphId: context.graphId,
                nodeId: context.nodeId,
                query: 'planned_steps',
                matches: [{ path: 'src/runtime/intent/route-classifier.ts', line: 42, snippet: 'planned_steps' }],
                createdAt: 1_111_000,
              }),
              buildFileReadSetArtifact({
                graphId: context.graphId,
                nodeId: context.nodeId,
                path: 'src/runtime/intent/route-classifier.ts',
                content: 'planned_steps appears in src/runtime/intent/route-classifier.ts.\n',
                createdAt: 1_111_000,
              }),
            ],
          },
        };
      }

      if (groundedSynthesis) {
        expect(params.groundedSynthesis).toMatchObject({
          responseFormat: {
            type: 'json_schema',
            name: 'graph_write_spec_candidate',
          },
        });
        return {
          content: JSON.stringify({
            path: 'tmp/manual-web/planned-steps-summary.txt',
            content: 'planned_steps appears in src/runtime/intent/route-classifier.ts.\n',
            append: false,
            summary: 'Summarize grounded planned_steps evidence.',
          }),
          metadata: {
            skipTestDelegatedEnvelope: true,
            groundedSynthesis: { available: true },
          },
        };
      }

      throw new Error('Delegated worker path should not run for graph-controlled read/write tasks.');
    };

    const intentRoutingTrace = {
      record: vi.fn(),
    };
    const runTimeline = {
      ingestExecutionGraphEvent: vi.fn(),
    };
    const executeModelTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'fs_write') {
        return {
          success: true,
          status: 'succeeded',
          jobId: 'job-graph-write',
          message: 'Tool fs_write completed.',
          output: { path: args.path },
        };
      }
      if (toolName === 'fs_read') {
        return {
          success: true,
          status: 'succeeded',
          jobId: 'job-graph-readback',
          message: 'Tool fs_read completed.',
          output: {
            path: args.path,
            content: 'planned_steps appears in src/runtime/intent/route-classifier.ts.\n',
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });
    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
        listJobs: vi.fn(() => []),
        executeModelTool,
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
                    role: 'implementer',
                    label: 'Workspace Implementer',
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
        now: () => 1_111_000,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-search-write-graph',
        userId: 'tester',
        channel: 'web',
        content: 'Search src/runtime for planned_steps. Write a short summary of what you find to tmp/manual-web/planned-steps-summary.txt.',
        metadata: filesystemSearchWriteMetadata(),
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
        expectedContextPressure: 'high',
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
        requestId: 'm-search-write-graph',
        executionId: 'exec-search-write-graph',
        rootExecutionId: 'exec-search-write-root',
        originChannel: 'web',
        orchestration: {
          role: 'implementer',
          label: 'Workspace Implementer',
          lenses: ['coding-workspace'],
        },
      },
    });

    expect(dispatchModes).toEqual(['direct', 'synthesis']);
    expect(executeModelTool.mock.calls.map(([toolName]) => toolName)).toEqual(['fs_write', 'fs_read']);
    expect(runTimeline.ingestExecutionGraphEvent.mock.calls.map(([event]) => event.kind)).toEqual(expect.arrayContaining([
      'graph_started',
      'node_started',
      'tool_call_started',
      'verification_completed',
      'graph_completed',
    ]));
    const verificationEvent = runTimeline.ingestExecutionGraphEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.kind === 'verification_completed');
    expect(verificationEvent).toMatchObject({
      nodeKind: 'verify',
      nodeId: expect.stringContaining(':verify'),
    });
    expect(result.content).toContain('Wrote tmp/manual-web/planned-steps-summary.txt and verified');
    expect(result.metadata?.executionGraph).toMatchObject({
      status: 'succeeded',
      writeSpecArtifactId: expect.stringContaining('write-spec'),
      verificationArtifactId: expect.stringContaining('verification'),
    });

    manager.shutdown();
  });

  it('pauses graph-controlled mutation with an execution-graph pending action when approval is required', async () => {
    const { WorkerManager } = await import('./worker-manager.js');

    const dispatchModes: string[] = [];
    workerMessageHandler = (params) => {
      const directReasoning = params.directReasoning === true;
      const groundedSynthesis = !!params.groundedSynthesis;
      dispatchModes.push(directReasoning ? 'direct' : groundedSynthesis ? 'synthesis' : 'delegated');
      if (directReasoning) {
        const context = params.directReasoningGraphContext as { graphId: string; nodeId: string };
        return {
          content: 'Found planned_steps references in src/runtime/intent/route-classifier.ts.',
          metadata: {
            skipTestDelegatedEnvelope: true,
            directReasoning: true,
            directReasoningMode: 'brokered_readonly',
            executionGraphArtifacts: [
              buildSearchResultSetArtifact({
                graphId: context.graphId,
                nodeId: context.nodeId,
                query: 'planned_steps',
                matches: [{ path: 'src/runtime/intent/route-classifier.ts', line: 42, snippet: 'planned_steps' }],
                createdAt: 1_112_000,
              }),
            ],
          },
        };
      }
      if (groundedSynthesis) {
        return {
          content: JSON.stringify({
            path: 'tmp/manual-web/planned-steps-summary.txt',
            content: 'planned_steps appears in src/runtime/intent/route-classifier.ts.\n',
            append: false,
            summary: 'Summarize grounded planned_steps evidence.',
          }),
          metadata: {
            skipTestDelegatedEnvelope: true,
            groundedSynthesis: { available: true },
          },
        };
      }
      throw new Error('Delegated worker path should not run for graph-controlled approval pauses.');
    };

    const intentRoutingTrace = {
      record: vi.fn(),
    };
    const runTimeline = {
      ingestExecutionGraphEvent: vi.fn(),
    };
    let capturedPendingAction: PendingActionRecord | undefined;
    const pendingActionStore = {
      replaceActive: vi.fn((_scope, draft) => {
        capturedPendingAction = {
        id: 'pending-graph-1',
        scope: _scope,
        ...draft,
          createdAt: 1_112_000,
          updatedAt: 1_112_000,
        } as PendingActionRecord;
        return capturedPendingAction;
      }),
    };
    const executionGraphStore = new ExecutionGraphStore({
      now: () => 1_112_000,
    });
    const synthesizedContent = 'planned_steps appears in src/runtime/intent/route-classifier.ts.\n';
    const executeModelTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'fs_write') {
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-graph-write',
          jobId: 'job-graph-write',
          message: 'Approval required.',
        };
      }
      if (toolName === 'fs_read') {
        return {
          success: true,
          status: 'succeeded',
          jobId: 'job-graph-readback',
          output: {
            path: args.path,
            bytes: Buffer.byteLength(synthesizedContent, 'utf-8'),
            truncated: false,
            content: synthesizedContent,
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });
    const manager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
        listJobs: vi.fn(() => []),
        executeModelTool,
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
                    role: 'implementer',
                    label: 'Workspace Implementer',
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
        pendingActionStore,
        executionGraphStore,
        now: () => 1_112_000,
      },
    );

    const result = await manager.handleMessage({
      sessionId: 'tester:web',
      agentId: 'local',
      userId: 'tester',
      grantedCapabilities: [],
      message: {
        id: 'm-search-write-graph-approval',
        userId: 'tester',
        channel: 'web',
        content: 'Search src/runtime for planned_steps. Write a short summary of what you find to tmp/manual-web/planned-steps-summary.txt.',
        metadata: filesystemSearchWriteMetadata(),
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
        expectedContextPressure: 'high',
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
        requestId: 'm-search-write-graph-approval',
        executionId: 'exec-search-write-graph-approval',
        rootExecutionId: 'exec-search-write-root',
        originChannel: 'web',
        orchestration: {
          role: 'implementer',
          label: 'Workspace Implementer',
          lenses: ['coding-workspace'],
        },
      },
    });

    expect(dispatchModes).toEqual(['direct', 'synthesis']);
    expect(result.metadata?.executionGraph).toMatchObject({
      status: 'awaiting_approval',
      receiptArtifactId: expect.stringContaining('mutation-receipt'),
    });
    expect(result.metadata?.pendingAction).toMatchObject({
      status: 'pending',
      blocker: {
        kind: 'approval',
        approvalSummaries: [expect.objectContaining({ id: 'approval-graph-write', toolName: 'fs_write' })],
      },
    });
    expect(pendingActionStore.replaceActive).toHaveBeenCalledOnce();
    expect(runTimeline.ingestExecutionGraphEvent.mock.calls.map(([event]) => event.kind)).toEqual(expect.arrayContaining([
      'approval_requested',
    ]));
    const executionGraphMetadata = result.metadata?.executionGraph as { graphId?: string } | undefined;
    const graphId = executionGraphMetadata?.graphId ?? '';
    const snapshot = executionGraphStore.getSnapshot(graphId);
    expect(snapshot?.graph.status).toBe('awaiting_approval');
    expect(snapshot?.graph.nodes.find((node) => node.kind === 'mutate')?.status).toBe('awaiting_approval');
    expect(snapshot?.graph.nodes.find((node) => node.kind === 'verify')?.status).toBe('pending');
    expect(snapshot?.graph.checkpoints.map((checkpoint) => checkpoint.reason)).toContain('approval_interrupt');
    expect(executionGraphStore.listArtifacts(graphId).map((artifact) => artifact.artifactType)).toEqual(expect.arrayContaining([
      'SearchResultSet',
      'EvidenceLedger',
      'SynthesisDraft',
      'WriteSpec',
      'MutationReceipt',
    ]));

    const resumeManager = new WorkerManager(
      {
        listAlwaysLoadedDefinitions: () => [],
        listJobs: vi.fn(() => []),
        executeModelTool,
      } as never,
      {
        getFallbackProviderConfig: () => undefined,
        getConfigSnapshot: () => createExecutionProfileTestConfig(),
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
        runTimeline,
        executionGraphStore,
        now: () => 1_112_100,
      },
    );
    const resumed = await resumeManager.resumeExecutionGraphPendingAction(
      capturedPendingAction!,
      {
        approvalId: 'approval-graph-write',
        approvalResult: {
          success: true,
          approved: true,
          executionSucceeded: true,
          message: 'Approved and executed.',
          job: { id: 'job-graph-write', status: 'succeeded' } as never,
          result: {
            success: true,
            output: {
              size: Buffer.byteLength(synthesizedContent, 'utf-8'),
            },
          } as never,
        },
      },
    );
    expect(resumed?.content).toContain('Wrote tmp/manual-web/planned-steps-summary.txt');
    expect(resumed?.metadata?.executionGraph).toMatchObject({
      graphId,
      status: 'succeeded',
      verificationArtifactId: expect.stringContaining('verification'),
    });
    const resumedSnapshot = executionGraphStore.getSnapshot(graphId);
    expect(resumedSnapshot?.graph.status).toBe('completed');
    expect(resumedSnapshot?.graph.nodes.find((node) => node.kind === 'mutate')?.status).toBe('completed');
    expect(resumedSnapshot?.graph.nodes.find((node) => node.kind === 'verify')?.status).toBe('completed');
    expect(executionGraphStore.listArtifacts(graphId).map((artifact) => artifact.artifactType)).toEqual(expect.arrayContaining([
      'VerificationResult',
    ]));
    expect(executeModelTool).toHaveBeenCalledWith(
      'fs_read',
      expect.objectContaining({ path: 'tmp/manual-web/planned-steps-summary.txt' }),
      expect.objectContaining({ requestId: 'm-search-write-graph-approval', userId: 'tester' }),
    );

    resumeManager.shutdown();
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
    expect(result.content).toContain('Delegated worker stopped before satisfying every required planned step.');
    const verificationTrace = intentRoutingTrace.record.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.stage === 'delegated_verification_decided');
    expect(verificationTrace).toMatchObject({
      stage: 'delegated_verification_decided',
      requestId: 'm-security-evidence-failed',
      details: {
        decision: 'insufficient',
        summary: 'Delegated worker stopped before satisfying every required planned step.',
        missingEvidenceKinds: ['read'],
        unsatisfiedStepIds: ['step_1'],
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
        metadata: generalAssistantDirectMetadata(),
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
