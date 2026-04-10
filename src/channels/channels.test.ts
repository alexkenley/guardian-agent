import { describe, it, expect, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { CLIChannel } from './cli.js';
import type { AgentInfo, RuntimeStatus } from './cli.js';
import { WebChannel } from './web.js';
import type { DashboardCallbacks, DashboardAgentInfo, DashboardAgentDetail } from './web-types.js';
import type { UserMessage, AgentResponse } from '../agent/types.js';
import { randomUUID } from 'node:crypto';

function approvalPendingActionMetadata(
  approvals: Array<{ id: string; toolName: string; argsPreview: string }>,
): Record<string, unknown> {
  return {
    pendingAction: {
      status: 'pending',
      blocker: {
        kind: 'approval',
        approvalSummaries: approvals,
      },
    },
  };
}

describe('CLIChannel', () => {
  it('should start and stop without errors', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cli = new CLIChannel({ input, output });

    const handler = async (_msg: UserMessage): Promise<AgentResponse> => {
      return { content: 'response' };
    };

    await cli.start(handler);
    await cli.stop();
  });

  it('should route messages to handler', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cli = new CLIChannel({ input, output });
    const received: UserMessage[] = [];

    const handler = async (msg: UserMessage): Promise<AgentResponse> => {
      received.push(msg);
      return { content: `Echo: ${msg.content}` };
    };

    await cli.start(handler);

    // Simulate user typing
    input.write('Hello world\n');

    // Give async handler time to process
    await new Promise(r => setTimeout(r, 50));

    expect(received.length).toBe(1);
    expect(received[0].content).toBe('Hello world');
    expect(received[0].channel).toBe('cli');

    await cli.stop();
  });

  it('coalesces pasted multi-line chat input into a single user message', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cli = new CLIChannel({ input, output });
    const received: UserMessage[] = [];

    await cli.start(async (msg) => {
      received.push(msg);
      return { content: `Echo: ${msg.content}` };
    });

    input.write('Use Codex to create docs/proposals/CODEX-SMOKE-TEST-5.md with title\n');
    input.write('"# Codex Smoke Test 5" and bullets "CLI attach test" and "Status\n');
    input.write('follow-up", then tell me exactly what changed.\n');

    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(received).toHaveLength(1);
    expect(received[0]?.content).toBe([
      'Use Codex to create docs/proposals/CODEX-SMOKE-TEST-5.md with title',
      '"# Codex Smoke Test 5" and bullets "CLI attach test" and "Status',
      'follow-up", then tell me exactly what changed.',
    ].join('\n'));

    await cli.stop();
  });

  it('shows response source labels for chat replies', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cli = new CLIChannel({ input, output });

    await cli.start(async () => ({
      content: 'Created the workflow.',
      metadata: {
        responseSource: {
          locality: 'external',
          usedFallback: true,
        },
      },
    }));

    input.write('create it\n');
    await new Promise(r => setTimeout(r, 50));

    const text = output.read()?.toString() ?? '';
    expect(text).toContain('[external · fallback] Created the workflow.');

    await cli.stop();
  });

  it('shows deduped live progress for streamed CLI replies', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cli = new CLIChannel({
      input,
      output,
      dashboard: {
        onStreamDispatch: async (_agentId, msg, emitSSE) => {
          expect(msg.surfaceId).toBe('cli-guardian-chat');
          const runId = msg.requestId || 'cli-progress-run';
          emitSSE({
            type: 'run.timeline',
            data: {
              summary: { runId, status: 'queued' },
              items: [{ id: 'queued', runId, type: 'run_queued', status: 'info', source: 'system', timestamp: Date.now(), title: 'Queued chat' }],
            },
          });
          emitSSE({
            type: 'run.timeline',
            data: {
              summary: { runId, status: 'running' },
              items: [{ id: 'started', runId, type: 'run_started', status: 'running', source: 'system', timestamp: Date.now(), title: 'Started chat' }],
            },
          });
          emitSSE({
            type: 'run.timeline',
            data: {
              summary: { runId, status: 'running' },
              items: [{
                id: 'inspect',
                runId,
                type: 'tool_call_started',
                status: 'running',
                source: 'system',
                timestamp: Date.now(),
                title: 'Inspecting workspace',
                detail: 'fs_list',
              }],
            },
          });
          emitSSE({
            type: 'run.timeline',
            data: {
              summary: { runId, status: 'running' },
              items: [{
                id: 'inspect',
                runId,
                type: 'tool_call_started',
                status: 'running',
                source: 'system',
                timestamp: Date.now(),
                title: 'Inspecting workspace',
                detail: 'fs_list',
              }],
            },
          });
          emitSSE({
            type: 'run.timeline',
            data: {
              summary: { runId, status: 'awaiting_approval' },
              items: [{
                id: 'approval',
                runId,
                type: 'approval_requested',
                status: 'warning',
                source: 'system',
                timestamp: Date.now(),
                title: 'Waiting for approval',
                detail: 'fs_write',
              }],
            },
          });
          return {
            requestId: runId,
            runId,
            content: 'Completed.',
            metadata: {
              responseSource: {
                locality: 'external',
                providerName: 'anthropic',
              },
            },
          };
        },
      },
    });

    await cli.start(async () => ({ content: 'fallback' }));
    output.read();

    input.write('inspect repo\n');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const text = output.read()?.toString() ?? '';
    expect(text).toContain('[progress] Inspecting workspace — fs_list');
    expect(text).toContain('[progress] Waiting for approval — fs_write');
    expect(text).not.toContain('Queued chat');
    expect(text).not.toContain('Started chat');
    expect(text.match(/\[progress\] Inspecting workspace — fs_list/g)?.length ?? 0).toBe(1);
    expect(text).toContain('[frontier] Completed.');

    await cli.stop();
  });

  it('should handle /agents command', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const agents: AgentInfo[] = [
      { id: 'chat', name: 'ChatAgent', state: 'idle', capabilities: ['read_files'] },
      { id: 'sentinel', name: 'Sentinel', state: 'idle', capabilities: [] },
    ];
    const cli = new CLIChannel({ input, output, onAgents: () => agents });

    await cli.start(async () => ({ content: 'ok' }));

    input.write('/agents\n');
    await new Promise(r => setTimeout(r, 50));

    const text = output.read()?.toString() ?? '';
    expect(text).toContain('ChatAgent');
    expect(text).toContain('chat');
    expect(text).toContain('idle');
    expect(text).toContain('Sentinel');

    await cli.stop();
  });

  it('does not re-prompt after /kill requests shutdown', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const onKillswitch = vi.fn();
    const cli = new CLIChannel({
      input,
      output,
      prompt: 'test> ',
      dashboard: { onKillswitch },
    });

    await cli.start(async () => ({ content: 'response' }));
    output.read();

    input.write('/kill\n');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const text = output.read()?.toString() ?? '';
    expect(onKillswitch).toHaveBeenCalledTimes(1);
    expect(text).toContain('KILLSWITCH');
    expect(text).not.toContain('test> ');

    await cli.stop();
  });

  it('should handle /status command', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const status: RuntimeStatus = {
      running: true,
      agentCount: 2,
      guardianEnabled: true,
      providers: ['ollama'],
    };
    const cli = new CLIChannel({ input, output, onStatus: () => status });

    await cli.start(async () => ({ content: 'ok' }));

    input.write('/status\n');
    await new Promise(r => setTimeout(r, 50));

    const text = output.read()?.toString() ?? '';
    expect(text).toContain('yes');
    expect(text).toContain('2');
    expect(text).toContain('enabled');
    expect(text).toContain('ollama');

    await cli.stop();
  });

  it('should handle /help command without sending to handler', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cli = new CLIChannel({ input, output });
    const received: UserMessage[] = [];

    const handler = async (msg: UserMessage): Promise<AgentResponse> => {
      received.push(msg);
      return { content: 'response' };
    };

    await cli.start(handler);

    input.write('/help\n');
    await new Promise(r => setTimeout(r, 50));

    // /help should not be sent as a message
    expect(received.length).toBe(0);

    await cli.stop();
  });

  it('should route /approve and /deny commands to handler for chat-level approvals', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cli = new CLIChannel({ input, output });
    const received: UserMessage[] = [];

    const handler = async (msg: UserMessage): Promise<AgentResponse> => {
      received.push(msg);
      return { content: `ack: ${msg.content}` };
    };

    await cli.start(handler);

    input.write('/approve abc-123\n');
    await new Promise(r => setTimeout(r, 50));
    input.write('/deny abc-456\n');
    await new Promise(r => setTimeout(r, 50));

    expect(received.length).toBe(2);
    expect(received[0].content).toBe('/approve abc-123');
    expect(received[1].content).toBe('/deny abc-456');
    expect(received.every((msg) => msg.channel === 'cli')).toBe(true);

    await cli.stop();
  });

  it('should handle /exit as alias for /quit', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cli = new CLIChannel({ input, output });

    await cli.start(async () => ({ content: 'ok' }));

    input.write('/exit\n');
    await new Promise(r => setTimeout(r, 50));

    const text = output.read()?.toString() ?? '';
    expect(text).toContain('Shutting down');

    await cli.stop();
  });

  it('should show unknown command for invalid commands', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cli = new CLIChannel({ input, output });

    await cli.start(async () => ({ content: 'ok' }));

    input.write('/foobar\n');
    await new Promise(r => setTimeout(r, 50));

    const text = output.read()?.toString() ?? '';
    expect(text).toContain('Unknown command');
    expect(text).toContain('foobar');

    await cli.stop();
  });

  it('should load only slash commands into CLI history with most recent first', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const historyDir = join('/tmp', `guardian-cli-history-${randomUUID()}`);
    const historyPath = join(historyDir, 'cli-history');
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(historyPath, 'hello world\n/status\n/help\nplain text\n/agents\n');

    const cli = new CLIChannel({ input, output, historyPath, historyEnabled: true });
    await cli.start(async () => ({ content: 'ok' }));

    const history = ((cli as unknown as { rl?: { history?: string[] } }).rl?.history) ?? [];
    expect(history).toEqual(['/agents', '/help', '/status']);

    await cli.stop();
    rmSync(historyDir, { recursive: true, force: true });
  });

  it('should persist only slash commands to CLI history', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const historyDir = join('/tmp', `guardian-cli-history-${randomUUID()}`);
    const historyPath = join(historyDir, 'cli-history');

    const cli = new CLIChannel({ input, output, historyPath, historyEnabled: true });
    await cli.start(async () => ({ content: 'ok' }));

    input.write('hello world\n');
    input.write('/status\n');
    await new Promise(r => setTimeout(r, 50));

    const saved = readFileSync(historyPath, 'utf-8');
    expect(saved).toBe('/status\n');

    await cli.stop();
    rmSync(historyDir, { recursive: true, force: true });
  });
});

// ─── CLI Dashboard Integration ───────────────────────────────

describe('CLIChannel with DashboardCallbacks', () => {
  const mockAgents: DashboardAgentInfo[] = [
    { id: 'agent-1', name: 'TestAgent', state: 'idle', capabilities: ['read_files'], lastActivityMs: Date.now(), consecutiveErrors: 0 },
    { id: 'agent-2', name: 'Sentinel', state: 'running', capabilities: [], provider: 'ollama', lastActivityMs: Date.now(), consecutiveErrors: 2 },
  ];

  const mockDetail: DashboardAgentDetail = {
    ...mockAgents[0],
    resourceLimits: { maxInvocationBudgetMs: 120000, maxTokensPerMinute: 0, maxConcurrentTools: 0, maxQueueDepth: 1000 },
  };

  const mockDashboard: DashboardCallbacks = {
    onAgents: () => mockAgents,
    onAgentDetail: (id) => id === 'agent-1' ? mockDetail : null,
    onAuditQuery: (filter) => [{
      id: 'audit-1', timestamp: Date.now(), type: 'action_denied' as const,
      severity: 'warn' as const, agentId: 'agent-1', controller: 'CapabilityController',
      details: { reason: 'test' },
    }],
    onAuditSummary: (windowMs) => ({
      totalEvents: 5, byType: { action_denied: 2, secret_detected: 1 }, bySeverity: { info: 1, warn: 3, critical: 1 },
      topDeniedAgents: [{ agentId: 'agent-1', count: 2 }],
      topControllers: [{ controller: 'CapabilityController', count: 3 }],
      windowStart: Date.now() - windowMs, windowEnd: Date.now(),
    }),
    onConfig: () => ({
      llm: { ollama: { provider: 'ollama', model: 'llama3.2' }, claude: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' } },
      defaultProvider: 'ollama',
      channels: {
        cli: { enabled: true },
        web: {
          enabled: true,
          port: 3000,
          auth: {
            mode: 'bearer_required',
            tokenConfigured: true,
            tokenSource: 'config',
            rotateOnStartup: false,
          },
        },
      },
      guardian: {
        enabled: true,
        rateLimit: { maxPerMinute: 60, maxPerHour: 500, burstAllowed: 5 },
        inputSanitization: { enabled: true, blockThreshold: 0.8 },
        outputScanning: { enabled: true, redactSecrets: true },
        sentinel: { enabled: true, schedule: '*/5 * * * *' },
      },
      runtime: { maxStallDurationMs: 60000, watchdogIntervalMs: 10000, logLevel: 'info' },
      assistant: {
        setupCompleted: false,
        identity: { mode: 'single_user', primaryUserId: 'owner' },
        soul: {
          enabled: true,
          path: 'SOUL.md',
          primaryMode: 'full',
          delegatedMode: 'summary',
          maxChars: 8000,
          summaryMaxChars: 1000,
        },
        memory: { enabled: true, retentionDays: 30 },
        analytics: { enabled: true, retentionDays: 30 },
        quickActions: { enabled: true },
        threatIntel: {
          enabled: true,
          allowDarkWeb: false,
          responseMode: 'assisted',
          watchlistCount: 0,
          autoScanIntervalMinutes: 180,
          moltbook: {
            enabled: false,
            mode: 'mock',
            allowActiveResponse: false,
          },
        },
        connectors: {
          enabled: true,
          executionMode: 'plan_then_execute',
          maxConnectorCallsPerRun: 12,
          packCount: 1,
          enabledPackCount: 1,
          playbookCount: 1,
          playbooks: {
            enabled: true,
            maxSteps: 12,
            maxParallelSteps: 3,
            defaultStepTimeoutMs: 15000,
            requireSignedDefinitions: true,
            requireDryRunOnFirstExecution: true,
          },
          studio: {
            enabled: true,
            mode: 'builder',
            requirePrivilegedTicket: true,
          },
        },
        tools: {
          enabled: true,
          policyMode: 'approve_by_policy',
          allowExternalPosting: false,
          allowedPathsCount: 1,
          allowedCommandsCount: 3,
          allowedDomainsCount: 2,
        },
      },
    }),
    onBudget: () => ({
      agents: [
        { agentId: 'agent-1', tokensPerMinute: 100, concurrentInvocations: 1, overrunCount: 0 },
        { agentId: 'agent-2', tokensPerMinute: 0, concurrentInvocations: 0, overrunCount: 2 },
      ],
      recentOverruns: [{ agentId: 'agent-2', invocationType: 'message', budgetMs: 5000, usedMs: 7500, overrun: true }],
    }),
    onWatchdog: () => [
      { agentId: 'agent-1', action: 'ok' as const },
      { agentId: 'agent-2', action: 'stalled' as const, stalledMs: 75000 },
    ],
    onProviders: () => [
      { name: 'ollama', type: 'ollama', model: 'llama3.2', locality: 'local' as const, connected: true },
      { name: 'claude', type: 'anthropic', model: 'claude-sonnet-4-20250514', locality: 'external' as const, connected: false },
    ],
    onProvidersStatus: async () => [
      { name: 'ollama', type: 'ollama', model: 'llama3.2', locality: 'local' as const, connected: true, availableModels: ['llama3.2', 'llama3.3', 'mistral'] },
      { name: 'claude', type: 'anthropic', model: 'claude-sonnet-4-20250514', locality: 'external' as const, connected: false },
    ],
    onAssistantState: () => ({
      orchestrator: {
        summary: {
          startedAt: Date.now() - 60_000,
          uptimeMs: 60_000,
          sessionCount: 1,
          runningCount: 0,
          queuedCount: 0,
          totalRequests: 3,
          completedRequests: 3,
          failedRequests: 0,
          avgExecutionMs: 180,
          avgEndToEndMs: 240,
          queuedByPriority: {
            high: 0,
            normal: 0,
            low: 0,
          },
        },
        sessions: [],
        traces: [],
      },
      jobs: {
        summary: {
          total: 2,
          running: 0,
          succeeded: 2,
          failed: 0,
          lastStartedAt: Date.now() - 30_000,
          lastCompletedAt: Date.now() - 20_000,
        },
        jobs: [],
      },
      lastPolicyDecisions: [],
      defaultProvider: 'ollama',
      guardianEnabled: true,
      providerCount: 2,
      providers: ['ollama', 'claude'],
      scheduledJobs: [],
    }),
    onDispatch: async (agentId, msg) => ({ content: `Reply from ${agentId}: ${msg.content}` }),
    onConfigUpdate: async (updates) => ({ success: true, message: 'Config saved. Restart to apply changes.' }),
    onThreatIntelSummary: () => ({
      enabled: true,
      lastScanAt: Date.now(),
      watchlistCount: 1,
      darkwebEnabled: false,
      responseMode: 'assisted',
      forumConnectors: [
        { id: 'moltbook', enabled: true, hostile: true, mode: 'mock' },
      ],
      findings: { total: 2, new: 1, highOrCritical: 1 },
    }),
    onThreatIntelPlan: () => ({
      title: 'Threat Intel Plan',
      principles: [],
      phases: [
        { phase: 'Phase 1', objective: 'Discover', deliverables: ['watchlist scans'] },
      ],
    }),
    onThreatIntelWatchlist: () => ['alexkenley'],
    onThreatIntelWatchAdd: (target) => ({ success: true, message: `Added ${target}` }),
    onThreatIntelWatchRemove: (target) => ({ success: true, message: `Removed ${target}` }),
    onThreatIntelScan: () => ({
      success: true,
      message: 'Scan completed',
      findings: [{
        id: randomUUID(),
        createdAt: Date.now(),
        target: 'alexkenley',
        sourceType: 'social',
        contentType: 'text',
        severity: 'high',
        confidence: 0.82,
        summary: 'Potential impersonation post',
        status: 'new',
        labels: ['social', 'impersonation'],
      }],
    }),
    onThreatIntelFindings: () => [{
      id: 'finding-1',
      createdAt: Date.now(),
      target: 'alexkenley',
      sourceType: 'social',
      contentType: 'text',
      severity: 'high',
      confidence: 0.8,
      summary: 'Potential impersonation',
      status: 'new',
      labels: ['impersonation'],
    }],
    onThreatIntelUpdateFindingStatus: ({ findingId, status }) => ({
      success: true,
      message: `${findingId} -> ${status}`,
    }),
    onThreatIntelActions: () => [{
      id: 'action-1',
      findingId: 'finding-1',
      createdAt: Date.now(),
      type: 'report',
      status: 'proposed',
      requiresApproval: true,
      rationale: 'Potential abuse',
    }],
    onThreatIntelDraftAction: ({ findingId, type }) => ({
      success: true,
      message: `Drafted ${type} for ${findingId}`,
      action: {
        id: 'action-2',
        findingId,
        createdAt: Date.now(),
        type,
        status: 'proposed',
        requiresApproval: true,
        rationale: 'Drafted in test',
      },
    }),
    onThreatIntelSetResponseMode: (mode) => ({ success: true, message: `mode=${mode}` }),
    onToolsCategories: () => [
      { category: 'filesystem' as const, label: 'Filesystem', description: 'File operations', toolCount: 5, enabled: true },
      { category: 'network' as const, label: 'Network', description: 'Network tools', toolCount: 7, enabled: true },
    ],
    onToolsCategoryToggle: (input) => ({ success: true, message: `${input.category} ${input.enabled ? 'enabled' : 'disabled'}` }),
  };

  const makeCli = (dashboardOverride?: Partial<DashboardCallbacks>) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cli = new CLIChannel({
      input,
      output,
      defaultAgent: 'agent-1',
      dashboard: { ...mockDashboard, ...dashboardOverride },
    });
    return { input, output, cli };
  };

  const readOutput = (output: PassThrough): string => output.read()?.toString() ?? '';

  const sendCommand = async (input: PassThrough, cmd: string) => {
    input.write(`${cmd}\n`);
    await new Promise(r => setTimeout(r, 50));
  };

  const connectorState = () => ({
    summary: {
      enabled: true,
      executionMode: 'plan_then_execute' as const,
      maxConnectorCallsPerRun: 12,
      packCount: 1,
      enabledPackCount: 1,
      playbookCount: 1,
      enabledPlaybookCount: 1,
      runCount: 2,
      dryRunQualifiedCount: 1,
    },
    packs: [],
    playbooks: [],
    runs: [],
    playbooksConfig: {
      enabled: true,
      maxSteps: 12,
      maxParallelSteps: 3,
      defaultStepTimeoutMs: 15000,
      requireSignedDefinitions: true,
      requireDryRunOnFirstExecution: true,
    },
    studio: {
      enabled: true,
      mode: 'builder' as const,
      requirePrivilegedTicket: true,
    },
  });

  // ─── /help ─────────────────────────────────────────────

  it('/help should show all command categories', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/help');
    const text = readOutput(output);

    expect(text).toContain('/chat');
    expect(text).toContain('/code');
    expect(text).toContain('/help <command>');
    expect(text).toContain('/agents');
    expect(text).toContain('/agent');
    expect(text).toContain('/approve');
    expect(text).toContain('/deny');
    expect(text).toContain('/providers');
    expect(text).toContain('/budget');
    expect(text).toContain('/watchdog');
    expect(text).toContain('/assistant');
    expect(text).toContain('/config');
    expect(text).toContain('/audit');
    expect(text).toContain('/security');
    expect(text).toContain('/models');
    expect(text).toContain('/clear');
    expect(text).toContain('/quit');

    await cli.stop();
  });

  it('/help code should show coding-session controls', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/help code');
    const text = readOutput(output);

    expect(text).toContain('/code attach <sessionId-or-match>');
    expect(text).toContain('/code detach');
    expect(text).toContain('/code create <workspaceRoot> [| title]');

    await cli.stop();
  });

  it('/code list and current should show CLI coding session focus', async () => {
    const codeSessions = {
      currentSessionId: 'code-2',
      referencedSessionIds: ['code-1'],
      sessions: [
        {
          id: 'code-1',
          title: 'Repo One',
          workspaceRoot: '/work/repo-one',
          resolvedRoot: '/work/repo-one',
          workState: { workspaceTrust: { state: 'trusted' } },
        },
        {
          id: 'code-2',
          title: 'Repo Two',
          workspaceRoot: '/work/repo-two',
          resolvedRoot: '/work/repo-two',
          workState: { workspaceTrust: { state: 'caution' } },
        },
      ],
    } as unknown as ReturnType<NonNullable<DashboardCallbacks['onCodeSessionsList']>>;
    const { input, output, cli } = makeCli({
      onCodeSessionsList: () => codeSessions,
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/code list');
    let text = readOutput(output);
    expect(text).toContain('code-1');
    expect(text).toContain('Repo Two');
    expect(text).toContain('current');
    expect(text).toContain('referenced');

    await sendCommand(input, '/code current');
    text = readOutput(output);
    expect(text).toContain('Current Coding Session');
    expect(text).toContain('Repo Two');
    expect(text).toContain('/work/repo-two');

    await cli.stop();
  });

  it('/code attach should resolve a unique session match and forward CLI surface context', async () => {
    const seen: Array<{ sessionId: string; surfaceId: string; channel: string; userId: string }> = [];
    const codeSessions = {
      currentSessionId: null,
      referencedSessionIds: [],
      sessions: [
        {
          id: 'code-1',
          title: 'Test Tactical Game App',
          workspaceRoot: '/work/test-app',
          resolvedRoot: '/work/test-app',
          workState: { workspaceTrust: null },
        },
      ],
    } as unknown as ReturnType<NonNullable<DashboardCallbacks['onCodeSessionsList']>>;
    const { input, output, cli } = makeCli({
      onCodeSessionsList: () => codeSessions,
      onCodeSessionAttach: (args) => {
        seen.push({
          sessionId: args.sessionId,
          surfaceId: args.surfaceId,
          channel: args.channel,
          userId: args.userId,
        });
        return { success: true };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/code attach tactical');
    const text = readOutput(output);
    expect(text).toContain('Attached');
    expect(seen).toEqual([
      {
        sessionId: 'code-1',
        surfaceId: 'cli-guardian-chat',
        channel: 'cli',
        userId: 'owner',
      },
    ]);

    await cli.stop();
  });

  it('/code attach should resolve spaced queries against condensed session titles', async () => {
    const seen: Array<{ sessionId: string; surfaceId: string; channel: string; userId: string }> = [];
    const codeSessions = {
      currentSessionId: null,
      referencedSessionIds: [],
      sessions: [
        {
          id: 'code-1',
          title: 'TempInstallTest',
          workspaceRoot: '/work/temp-install-test',
          resolvedRoot: '/work/temp-install-test',
          workState: { workspaceTrust: null },
        },
      ],
    } as unknown as ReturnType<NonNullable<DashboardCallbacks['onCodeSessionsList']>>;
    const { input, output, cli } = makeCli({
      onCodeSessionsList: () => codeSessions,
      onCodeSessionAttach: (args) => {
        seen.push({
          sessionId: args.sessionId,
          surfaceId: args.surfaceId,
          channel: args.channel,
          userId: args.userId,
        });
        return { success: true };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/code attach temp install test');
    const text = readOutput(output);
    expect(text).toContain('Attached');
    expect(seen).toEqual([
      {
        sessionId: 'code-1',
        surfaceId: 'cli-guardian-chat',
        channel: 'cli',
        userId: 'owner',
      },
    ]);

    await cli.stop();
  });

  it('/code detach should forward CLI surface context', async () => {
    const seen: Array<{ surfaceId: string; channel: string; userId: string }> = [];
    const codeSessions = {
      currentSessionId: 'code-1',
      referencedSessionIds: [],
      sessions: [
        {
          id: 'code-1',
          title: 'Repo One',
          workspaceRoot: '/work/repo-one',
          resolvedRoot: '/work/repo-one',
          workState: { workspaceTrust: null },
        },
      ],
    } as unknown as ReturnType<NonNullable<DashboardCallbacks['onCodeSessionsList']>>;
    const { input, output, cli } = makeCli({
      onCodeSessionsList: () => codeSessions,
      onCodeSessionDetach: (args) => {
        seen.push({
          surfaceId: args.surfaceId,
          channel: args.channel,
          userId: args.userId,
        });
        return { success: true };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/code detach');
    const text = readOutput(output);
    expect(text).toContain('Detached the current coding session');
    expect(seen).toEqual([
      {
        surfaceId: 'cli-guardian-chat',
        channel: 'cli',
        userId: 'owner',
      },
    ]);

    await cli.stop();
  });

  it('/code create should create and attach a new CLI coding session', async () => {
    const seen: Array<{ title: string; workspaceRoot: string; surfaceId: string; attach?: boolean }> = [];
    const { input, output, cli } = makeCli({
      onCodeSessionsList: () => ({
        currentSessionId: null,
        referencedSessionIds: [],
        sessions: [],
      }),
      onCodeSessionCreate: (args) => {
        seen.push({
          title: args.title,
          workspaceRoot: args.workspaceRoot,
          surfaceId: args.surfaceId,
          attach: args.attach,
        });
        return {
          session: {
            id: 'code-new',
            title: args.title,
            workspaceRoot: args.workspaceRoot,
          },
          history: [],
          attached: true,
        } as ReturnType<NonNullable<DashboardCallbacks['onCodeSessionCreate']>>;
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/code create /work/new-repo | New Repo');
    const text = readOutput(output);
    expect(text).toContain('Created and attached');
    expect(seen).toEqual([
      {
        title: 'New Repo',
        workspaceRoot: '/work/new-repo',
        surfaceId: 'cli-guardian-chat',
        attach: true,
      },
    ]);

    await cli.stop();
  });

  it('/help models should show model validation guidance', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/help models');
    const text = readOutput(output);

    expect(text).toContain('/models <provider>');
    expect(text).toContain('/config set <provider> model <model>');
    expect(text).toContain('updates Guardian config only');
    expect(text).toContain('ollama run <model> "hello"');

    await cli.stop();
  });

  it('/help should accept slash-prefixed topics', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/help /tools');
    const text = readOutput(output);

    expect(text).toContain('/tools run <tool> [jsonArgs]');
    expect(text).toContain('jsonArgs must be a valid JSON object');
    expect(text).toContain('/tools policy commands <comma,separated,prefixes>');

    await cli.stop();
  });

  it('/campaign help should show campaign workflow commands', async () => {
    const { input, output, cli } = makeCli({
      onToolsRun: async () => ({
        success: true,
        status: 'succeeded',
        jobId: randomUUID(),
        message: 'ok',
      }),
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/campaign help');
    const text = readOutput(output);

    expect(text).toContain('/campaign discover');
    expect(text).toContain('/campaign run');

    await cli.stop();
  });

  it('/connectors status should show connector framework summary', async () => {
    const { input, output, cli } = makeCli({
      onConnectorsState: () => connectorState(),
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/connectors status');
    const text = readOutput(output);

    expect(text).toContain('Connector Framework');
    expect(text).toContain('plan_then_execute');
    expect(text).toContain('Max calls/run: 12');

    await cli.stop();
  });

  it('/connectors settings playbooks max-steps should update full playbook settings from CLI', async () => {
    let received: Parameters<NonNullable<DashboardCallbacks['onConnectorsSettingsUpdate']>>[0] | null = null;
    const { input, output, cli } = makeCli({
      onConnectorsState: () => connectorState(),
      onConnectorsSettingsUpdate: (input) => {
        received = input;
        return { success: true, message: 'Connector settings updated.' };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/connectors settings playbooks max-steps 18');
    const text = readOutput(output);

    expect(text).toContain('OK');
    expect(received).toEqual({ playbooks: { maxSteps: 18 } });

    await cli.stop();
  });

  it('/connectors settings studio mode should update studio guardrails from CLI', async () => {
    let received: Parameters<NonNullable<DashboardCallbacks['onConnectorsSettingsUpdate']>>[0] | null = null;
    const { input, output, cli } = makeCli({
      onConnectorsState: () => connectorState(),
      onConnectorsSettingsUpdate: (input) => {
        received = input;
        return { success: true, message: 'Connector settings updated.' };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/connectors settings studio mode read_only');
    const text = readOutput(output);

    expect(text).toContain('OK');
    expect(received).toEqual({ studio: { mode: 'read_only' } });

    await cli.stop();
  });

  it('/connectors settings json should allow bulk connector updates from CLI', async () => {
    let received: Parameters<NonNullable<DashboardCallbacks['onConnectorsSettingsUpdate']>>[0] | null = null;
    const { input, output, cli } = makeCli({
      onConnectorsState: () => connectorState(),
      onConnectorsSettingsUpdate: (input) => {
        received = input;
        return { success: true, message: 'Connector settings updated.' };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/connectors settings json {"playbooks":{"defaultStepTimeoutMs":20000},"studio":{"requirePrivilegedTicket":false}}');
    const text = readOutput(output);

    expect(text).toContain('OK');
    expect(received).toEqual({
      playbooks: { defaultStepTimeoutMs: 20000 },
      studio: { requirePrivilegedTicket: false },
    });

    await cli.stop();
  });

  it('/automations run should execute a saved automation via callback', async () => {
    const { input, output, cli } = makeCli({
      onAutomationCatalog: () => [{
        id: 'infra-audit',
        name: 'Infra Audit',
        description: '',
        category: 'system',
        kind: 'pipeline',
        mode: 'sequential',
        steps: [],
        enabled: true,
        cron: null,
        runOnce: false,
        emitEvent: '',
        outputHandling: { notify: 'off', sendToSecurity: 'off', persistArtifacts: 'run_history_only' },
        scheduleEnabled: false,
        taskId: null,
        lastRunAt: null,
        lastRunStatus: null,
        runCount: 0,
        source: 'saved_workflow',
        sourceKind: 'playbook',
        builtin: false,
        workflow: null,
        task: null,
      }],
      onAutomationRun: async ({ automationId, dryRun }) => ({
        success: true,
        status: 'succeeded',
        message: `${automationId} ${dryRun ? 'dry' : 'live'} run complete`,
        run: {
          id: 'run-1',
          automationId,
          createdAt: Date.now(),
          startedAt: Date.now(),
          completedAt: Date.now(),
          durationMs: 100,
          dryRun: !!dryRun,
          status: 'succeeded',
          message: 'done',
          steps: [],
          origin: 'cli',
        },
      }),
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/automations run infra-audit --dry-run');
    const text = readOutput(output);

    expect(text).toContain('dry run complete');
    expect(text).toContain('run-1');

    await cli.stop();
  });

  // ─── /chat ─────────────────────────────────────────────

  it('/chat should show current agent and available list', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/chat');
    const text = readOutput(output);

    expect(text).toContain('agent-1');
    expect(text).toContain('TestAgent');
    expect(text).toContain('Sentinel');

    await cli.stop();
  });

  it('/chat <agentId> should switch active agent', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/chat agent-1');
    const text = readOutput(output);

    expect(text).toContain('Switched to agent');
    expect(text).toContain('agent-1');

    await cli.stop();
  });

  it('normalizes CLI approval flow copy and status messages', async () => {
    const decisions: Array<{ approvalId: string; decision: string }> = [];
    const dispatches: Array<{ agentId: string; content: string }> = [];
    const { input, output, cli } = makeCli({
      onDispatch: async (agentId, msg) => {
        dispatches.push({ agentId, content: msg.content });
        if (msg.content.trim().toLowerCase() === 'y') {
          throw new Error('CLI approval prompt answer leaked into onDispatch');
        }
        if (dispatches.length === 1) {
          return {
            content: 'Action: fs_write — {"path":"S:/Development/test50.txt","content":"This is test50.txt","append":false}\nApproval ID: approval-write-1\nReply "yes" to approve or "no" to deny (expires in 30 minutes).\nOptional: /approve or /deny',
            metadata: approvalPendingActionMetadata([
              {
                id: 'approval-write-1',
                toolName: 'fs_write',
                argsPreview: '{"path":"S:/Development/test50.txt","content":"This is test50.txt","append":false}',
              },
            ]),
          };
        }
        if (dispatches.length === 2) {
          return {
            content: 'Waiting for approval to add S:\\Development to allowed paths.',
            metadata: approvalPendingActionMetadata([
              {
                id: 'approval-path-1',
                toolName: 'update_tool_policy',
                argsPreview: '{"action":"add_path","value":"S:\\\\Development"}',
              },
            ]),
          };
        }
        return {
          content: 'Done – `test50.txt` has been created in `S:\\Development`.',
        };
      },
      onToolsApprovalDecision: async ({ approvalId, decision }) => {
        decisions.push({ approvalId, decision });
        return {
          success: true,
          message: approvalId === 'approval-path-1'
            ? "Tool 'update_tool_policy' completed."
            : "Tool 'fs_write' completed.",
        };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/chat agent-1');
    readOutput(output);
    await sendCommand(input, 'Create a new test file called test50.txt in the s Drive Development Directory.');
    await sendCommand(input, 'y');
    await sendCommand(input, 'y');
    await new Promise(r => setTimeout(r, 100));

    const text = readOutput(output);
    expect(text).toContain('Waiting for approval to write S:/Development/test50.txt.');
    expect(text).toContain('Waiting for approval to add S:\\Development to allowed paths.');
    expect(text).toContain('Done – `test50.txt` has been created in `S:\\Development`.');
    expect(text).not.toContain('Approval ID:');
    expect(text).not.toContain('Reply "yes" to approve');
    expect(text).not.toContain("Tool 'fs_write' completed.");
    expect(text).not.toContain("Tool 'update_tool_policy' completed.");
    expect(dispatches.map((dispatch) => dispatch.content.trim().toLowerCase())).not.toContain('y');
    expect(decisions).toEqual([
      { approvalId: 'approval-write-1', decision: 'approved' },
      { approvalId: 'approval-path-1', decision: 'approved' },
    ]);
    expect(dispatches[1]?.content).toContain('Please continue with the current request only. Do not resume older unrelated pending tasks.');
    expect(dispatches[2]?.content).toContain('Please continue with the current request only. Do not resume older unrelated pending tasks.');

    await cli.stop();
  });

  it('refreshes stale CLI approval IDs and re-prompts with current pending approvals', async () => {
    const decisions: Array<{ approvalId: string; decision: string }> = [];
    const dispatches: Array<{ agentId: string; content: string }> = [];
    const { input, output, cli } = makeCli({
      onDispatch: async (agentId, msg) => {
        dispatches.push({ agentId, content: msg.content });
        if (dispatches.length === 1) {
          return {
            content: 'Waiting for approval to write S:/Development/Test60.txt.',
            metadata: approvalPendingActionMetadata([
              {
                id: 'stale-write-1',
                toolName: 'fs_write',
                argsPreview: '{"path":"S:/Development/Test60.txt","content":"This is Test60.txt","append":false}',
              },
            ]),
          };
        }
        return {
          content: 'Done – `Test60.txt` has been created in `S:\\Development`.',
        };
      },
      onToolsApprovalDecision: async ({ approvalId, decision }) => {
        decisions.push({ approvalId, decision });
        if (approvalId === 'stale-write-1') {
          return { success: false, message: "Approval 'stale-write-1' not found." };
        }
        return { success: true, message: "Tool 'fs_write' completed." };
      },
      onToolsPendingApprovals: () => [
        {
          id: 'fresh-write-1',
          toolName: 'fs_write',
          argsPreview: '{"path":"S:/Development/Test60.txt","content":"This is Test60.txt","append":false}',
        },
      ],
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/chat agent-1');
    readOutput(output);
    await sendCommand(input, 'Create a test file called Test60 in the S Drive development directory.');
    await sendCommand(input, 'y');
    await sendCommand(input, 'y');
    await new Promise(r => setTimeout(r, 100));

    const text = readOutput(output);
    expect(text).toContain('Waiting for approval to write S:/Development/Test60.txt.');
    expect(text).toContain('Done – `Test60.txt` has been created in `S:\\Development`.');
    expect(text).not.toContain("Approval 'stale-write-1' not found.");
    expect(decisions).toEqual([
      { approvalId: 'stale-write-1', decision: 'approved' },
      { approvalId: 'fresh-write-1', decision: 'approved' },
    ]);

    await cli.stop();
  });

  it('continues after an approved CLI action fails so the next turn is not hijacked', async () => {
    const decisions: Array<{ approvalId: string; decision: string }> = [];
    const dispatches: Array<{ agentId: string; content: string }> = [];
    const { input, output, cli } = makeCli({
      onDispatch: async (agentId, msg) => {
        dispatches.push({ agentId, content: msg.content });
        if (dispatches.length === 1) {
          return {
            content: 'Waiting for approval to write S:/Development/Test100.',
            metadata: approvalPendingActionMetadata([
              {
                id: 'approval-empty-1',
                toolName: 'fs_write',
                argsPreview: '{"path":"S:/Development/Test100","content":"","append":false}',
              },
            ]),
          };
        }
        if (dispatches.length === 2) {
          expect(msg.content).toContain('Some actions failed');
          return {
            content: 'The requested write failed. I have finished that request and will wait for your next instruction.',
          };
        }
        return {
          content: 'It used fs_write.',
        };
      },
      onToolsApprovalDecision: async ({ approvalId, decision }) => {
        decisions.push({ approvalId, decision });
        return { success: false, message: "'content' must be a non-empty string." };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/chat agent-1');
    readOutput(output);
    await sendCommand(input, 'Create an empty file called Test100 in the S Drive development directory.');
    await sendCommand(input, 'y');
    await new Promise(r => setTimeout(r, 100));
    await sendCommand(input, 'What exact tool did you use?');
    await new Promise(r => setTimeout(r, 100));

    const text = readOutput(output);
    expect(text).toContain('Waiting for approval to write S:/Development/Test100.');
    expect(text).toContain("'content' must be a non-empty string.");
    expect(text).toContain('The requested write failed. I have finished that request and will wait for your next instruction.');
    expect(text).toContain('It used fs_write.');
    expect(decisions).toEqual([{ approvalId: 'approval-empty-1', decision: 'approved' }]);
    expect(dispatches[1]?.content).toContain('Some actions failed — adjust your approach accordingly. Focus only on the current request.');

    await cli.stop();
  });

  it('uses direct approval continuation responses in CLI without dispatching a second follow-up turn', async () => {
    const dispatches: Array<{ agentId: string; content: string }> = [];
    const { input, output, cli } = makeCli({
      onDispatch: async (agentId, msg) => {
        dispatches.push({ agentId, content: msg.content });
        return {
          content: 'Waiting for approval to run codex.',
          metadata: approvalPendingActionMetadata([
            {
              id: 'approval-codex-1',
              toolName: 'coding_backend_run',
              argsPreview: '{"backend":"codex"}',
            },
          ]),
        };
      },
      onToolsApprovalDecision: async () => ({
        success: true,
        message: "Tool 'coding_backend_run' completed.",
        displayMessage: 'OpenAI Codex CLI completed.',
        continuedResponse: {
          content: 'Created `docs/proposals/CODEX-SMOKE-TEST-6.md`.\n\nNo other files changed.',
        },
      }),
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/chat agent-1');
    readOutput(output);
    await sendCommand(input, 'Use Codex to create the smoke test file.');
    await sendCommand(input, 'y');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const text = readOutput(output);
    expect(text).toContain('Waiting for approval to run codex.');
    expect(text).toContain('✓ coding_backend_run: OpenAI Codex CLI completed.');
    expect(text).toContain('Created `docs/proposals/CODEX-SMOKE-TEST-6.md`.');
    expect(text).not.toContain('Please continue with the current request only.');
    expect(dispatches).toHaveLength(1);

    await cli.stop();
  });

  it('intercepts leaked yes/no input locally when an inline CLI approval is active', async () => {
    const decisions: Array<{ approvalId: string; decision: string }> = [];
    const dispatches: Array<string> = [];
    const { input, output, cli } = makeCli({
      onDispatch: async (_agentId, msg) => {
        dispatches.push(msg.content);
        return { content: 'should not be called for leaked inline approval input' };
      },
      onToolsApprovalDecision: async ({ approvalId, decision }) => {
        decisions.push({ approvalId, decision });
        return { success: true, message: "Tool 'fs_write' completed." };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));
    readOutput(output);

    (cli as unknown as {
      pendingInlineApprovalState: {
        approvals: Array<{ id: string; toolName: string; argsPreview: string }>;
        agentId?: string;
        depth: number;
      } | null;
      pendingPromptResolver: ((answer: string) => void) | null;
    }).pendingInlineApprovalState = {
      approvals: [
        {
          id: 'approval-leaked-1',
          toolName: 'fs_write',
          argsPreview: '{"path":"S:/Development/test.txt","content":"This is test.txt","append":false}',
        },
      ],
      agentId: 'agent-1',
      depth: 0,
    };
    (cli as unknown as { pendingPromptResolver: ((answer: string) => void) | null }).pendingPromptResolver = null;

    await sendCommand(input, 'y');
    await new Promise(r => setTimeout(r, 100));

    const text = readOutput(output);
    expect(decisions).toEqual([{ approvalId: 'approval-leaked-1', decision: 'approved' }]);
    expect(dispatches).toEqual([
      '[User approved the pending tool action(s). Result: ✓ fs_write: Approved and executed] Please continue with the current request only. Do not resume older unrelated pending tasks.',
    ]);
    expect(text).toContain('fs_write: Approved and executed');

    await cli.stop();
  });

  it('/chat <invalid> should show error for unknown agent', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/chat nonexistent');
    const text = readOutput(output);

    expect(text).toContain('not found');

    await cli.stop();
  });

  it('messages should dispatch to active agent via dashboard', async () => {
    const dispatched: Array<{ agentId: string; content: string }> = [];
    const { input, output, cli } = makeCli({
      onDispatch: async (agentId, msg) => {
        dispatched.push({ agentId, content: msg.content });
        return { content: `Reply from ${agentId}` };
      },
    });
    await cli.start(async () => ({ content: 'fallback' }));

    // Switch to agent-1 first
    await sendCommand(input, '/chat agent-1');
    readOutput(output); // clear

    // Send a message
    await sendCommand(input, 'Hello there');
    const text = readOutput(output);

    expect(dispatched.length).toBe(1);
    expect(dispatched[0].agentId).toBe('agent-1');
    expect(dispatched[0].content).toBe('Hello there');
    expect(text).toContain('Reply from agent-1');

    await cli.stop();
  });

  // ─── /auth ─────────────────────────────────────────────

  it('/auth disable should update web auth mode', async () => {
    const onAuthUpdate = vi.fn(async (input: { mode?: 'bearer_required' | 'disabled' }) => ({
      success: true,
      message: 'Web auth settings saved.',
      status: {
        mode: input.mode ?? 'bearer_required',
        tokenConfigured: true,
        tokenSource: 'ephemeral' as const,
        rotateOnStartup: false,
        host: 'localhost',
        port: 3000,
      },
    }));
    const { input, output, cli } = makeCli({
      onAuthStatus: () => ({
        mode: 'bearer_required',
        tokenConfigured: true,
        tokenSource: 'config',
        rotateOnStartup: false,
        host: 'localhost',
        port: 3000,
      }),
      onAuthUpdate,
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/auth disable');
    const text = readOutput(output);

    expect(onAuthUpdate).toHaveBeenCalledWith({ mode: 'disabled' });
    expect(text).toContain('Web auth settings saved.');
    expect(text).toContain('Mode: disabled');
    expect(text).toContain('dashboard is now open without bearer-token protection');

    await cli.stop();
  });

  // ─── /agents ───────────────────────────────────────────

  it('/agents should show enhanced table with dashboard data', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/agents');
    const text = readOutput(output);

    expect(text).toContain('TestAgent');
    expect(text).toContain('Sentinel');
    expect(text).toContain('ollama');
    expect(text).toContain('read_files');

    await cli.stop();
  });

  // ─── /agent <id> ──────────────────────────────────────

  it('/agent <id> should show detailed agent info', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/agent agent-1');
    const text = readOutput(output);

    expect(text).toContain('TestAgent');
    expect(text).toContain('agent-1');
    expect(text).toContain('120000');
    expect(text).toContain('read_files');

    await cli.stop();
  });

  it('/agent <unknown> should show not found', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/agent unknown-agent');
    const text = readOutput(output);

    expect(text).toContain('not found');

    await cli.stop();
  });

  it('/agent with no args should show usage', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/agent');
    const text = readOutput(output);

    expect(text).toContain('Usage');

    await cli.stop();
  });

  // ─── /status ──────────────────────────────────────────

  it('/status should show enhanced status with dashboard', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/status');
    const text = readOutput(output);

    expect(text).toContain('ollama');
    expect(text).toContain('60000');

    await cli.stop();
  });

  it('/assistant should show orchestrator summary', async () => {
    const { input, output, cli } = makeCli({
      onAssistantState: () => ({
        orchestrator: {
          summary: {
            startedAt: Date.now() - 10_000,
            uptimeMs: 10_000,
            sessionCount: 2,
            runningCount: 1,
            queuedCount: 1,
            totalRequests: 5,
            completedRequests: 4,
            failedRequests: 1,
            avgExecutionMs: 230,
            avgEndToEndMs: 420,
            queuedByPriority: {
              high: 0,
              normal: 1,
              low: 0,
            },
          },
          sessions: [
            {
              sessionId: 'cli:owner:agent-1',
              channel: 'cli',
              userId: 'owner',
              agentId: 'agent-1',
              status: 'running',
              queueDepth: 1,
              totalRequests: 3,
              successCount: 2,
              errorCount: 1,
              avgExecutionMs: 220,
              avgEndToEndMs: 410,
              lastExecutionMs: 250,
              lastEndToEndMs: 470,
            },
          ],
          traces: [],
        },
        jobs: {
          summary: {
            total: 3,
            running: 1,
            succeeded: 2,
            failed: 0,
            lastStartedAt: Date.now() - 1_000,
            lastCompletedAt: Date.now() - 2_000,
          },
          jobs: [],
        },
        lastPolicyDecisions: [],
        defaultProvider: 'ollama',
        guardianEnabled: true,
        providerCount: 2,
        providers: ['ollama', 'claude'],
        scheduledJobs: [],
      }),
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/assistant');
    const text = readOutput(output);

    expect(text).toContain('Assistant Orchestrator');
    expect(text).toContain('ollama');
    expect(text).toContain('Requests');
    expect(text).toContain('Avg exec latency');

    await cli.stop();
  });

  it('/assistant traces should show request trace table', async () => {
    const now = Date.now();
    const { input, output, cli } = makeCli({
      onAssistantState: () => ({
        orchestrator: {
          summary: {
            startedAt: now - 10_000,
            uptimeMs: 10_000,
            sessionCount: 1,
            runningCount: 0,
            queuedCount: 0,
            totalRequests: 1,
            completedRequests: 1,
            failedRequests: 0,
            avgExecutionMs: 150,
            avgEndToEndMs: 180,
            queuedByPriority: {
              high: 0,
              normal: 0,
              low: 0,
            },
          },
          sessions: [],
          traces: [
            {
              requestId: 'req-1',
              sessionId: 'cli:owner:agent-1',
              agentId: 'agent-1',
              userId: 'owner',
              channel: 'cli',
              requestType: 'chat',
              priority: 'high',
              status: 'succeeded',
              queuedAt: now - 500,
              startedAt: now - 450,
              completedAt: now - 300,
              queueWaitMs: 50,
              executionMs: 150,
              endToEndMs: 200,
              steps: [
                { name: 'queue_wait', status: 'succeeded', startedAt: now - 500, completedAt: now - 450, durationMs: 50 },
                { name: 'runtime_dispatch_message', status: 'succeeded', startedAt: now - 450, completedAt: now - 300, durationMs: 150 },
              ],
              nodes: [
                {
                  id: 'compile-1',
                  kind: 'compile',
                  name: 'Assembled context',
                  startedAt: now - 448,
                  completedAt: now - 447,
                  status: 'succeeded',
                  metadata: {
                    summary: 'global memory loaded | continuity 2 surfaces',
                  },
                },
              ],
            },
          ],
        },
        jobs: {
          summary: {
            total: 0,
            running: 0,
            succeeded: 0,
            failed: 0,
          },
          jobs: [],
        },
        lastPolicyDecisions: [],
        defaultProvider: 'ollama',
        guardianEnabled: true,
        providerCount: 1,
        providers: ['ollama'],
        scheduledJobs: [],
      }),
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/assistant traces');
    const text = readOutput(output);

    expect(text).toContain('runtime_dispatch_message');
    expect(text).toContain('chat');
    expect(text).toContain('high');
    expect(text).toContain('global memory loaded');

    await cli.stop();
  });

  it('/assistant traces should filter by continuity key and active execution ref', async () => {
    const now = Date.now();
    const { input, output, cli } = makeCli({
      onAssistantState: () => ({
        orchestrator: {
          summary: {
            startedAt: now - 10_000,
            uptimeMs: 10_000,
            sessionCount: 1,
            runningCount: 0,
            queuedCount: 0,
            totalRequests: 2,
            completedRequests: 2,
            failedRequests: 0,
            avgExecutionMs: 150,
            avgEndToEndMs: 180,
            queuedByPriority: {
              high: 0,
              normal: 0,
              low: 0,
            },
          },
          sessions: [],
          traces: [
            {
              requestId: 'req-1',
              sessionId: 'cli:owner:agent-1',
              agentId: 'agent-1',
              userId: 'owner',
              channel: 'cli',
              requestType: 'chat',
              priority: 'high',
              status: 'succeeded',
              queuedAt: now - 500,
              startedAt: now - 450,
              completedAt: now - 300,
              queueWaitMs: 50,
              executionMs: 150,
              endToEndMs: 200,
              steps: [
                { name: 'runtime_dispatch_message', status: 'succeeded', startedAt: now - 450, completedAt: now - 300, durationMs: 150 },
              ],
              nodes: [
                {
                  id: 'compile-1',
                  kind: 'compile',
                  name: 'Assembled context',
                  startedAt: now - 448,
                  completedAt: now - 447,
                  status: 'succeeded',
                  metadata: {
                    summary: 'global memory loaded | continuity 2 surfaces',
                    continuityKey: 'continuity-keep',
                    activeExecutionRefs: ['code_session:Repo Fix'],
                  },
                },
              ],
            },
            {
              requestId: 'req-2',
              sessionId: 'cli:owner:agent-1',
              agentId: 'agent-1',
              userId: 'owner',
              channel: 'cli',
              requestType: 'automation',
              priority: 'normal',
              status: 'succeeded',
              queuedAt: now - 250,
              startedAt: now - 240,
              completedAt: now - 200,
              queueWaitMs: 10,
              executionMs: 40,
              endToEndMs: 50,
              steps: [
                { name: 'runtime_dispatch_message', status: 'succeeded', startedAt: now - 240, completedAt: now - 200, durationMs: 40 },
              ],
              nodes: [
                {
                  id: 'compile-2',
                  kind: 'compile',
                  name: 'Assembled context',
                  startedAt: now - 239,
                  completedAt: now - 238,
                  status: 'succeeded',
                  metadata: {
                    summary: 'global memory loaded | continuity 1 surface',
                    continuityKey: 'continuity-other',
                    activeExecutionRefs: ['pending_action:approval-2'],
                  },
                },
              ],
            },
          ],
        },
        jobs: {
          summary: {
            total: 0,
            running: 0,
            succeeded: 0,
            failed: 0,
          },
          jobs: [],
        },
        lastPolicyDecisions: [],
        defaultProvider: 'ollama',
        guardianEnabled: true,
        providerCount: 1,
        providers: ['ollama'],
        scheduledJobs: [],
      }),
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/assistant traces continuity=continuity-keep exec=repo');
    const text = readOutput(output);

    expect(text).toContain('chat');
    expect(text).toContain('global memory loaded');
    expect(text).not.toContain('automation');

    await cli.stop();
  });

  it('/assistant routing should show filtered durable routing trace entries', async () => {
    const now = Date.now();
    const { input, output, cli } = makeCli({
      onIntentRoutingTrace: async () => ({
        entries: [
          {
            id: 'route-1',
            timestamp: now - 200,
            stage: 'gateway_classified',
            userId: 'owner',
            channel: 'cli',
            agentId: 'agent-1',
            contentPreview: 'Use Codex to fix the repo',
            details: {
              route: 'coding_task',
              continuityKey: 'continuity-keep',
              activeExecutionRefs: ['code_session:Repo Fix'],
            },
          },
        ],
      }),
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/assistant routing continuity=continuity-keep exec=repo');
    const text = readOutput(output);

    expect(text).toContain('gateway_classified');
    expect(text).toContain('continuity continuity-keep');
    expect(text).toContain('Use Codex to fix the repo');

    await cli.stop();
  });

  it('/assistant jobs followup should invoke delegated job follow-up controls', async () => {
    const onAssistantJobFollowUpAction = vi.fn(async () => ({
      success: true,
      message: 'Replayed held delegated result.',
      details: {
        content: 'Held delegated output',
      },
    }));
    const { input, output, cli } = makeCli({
      onAssistantJobFollowUpAction,
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/assistant jobs followup job-123 replay');
    const text = readOutput(output);

    expect(onAssistantJobFollowUpAction).toHaveBeenCalledWith({
      jobId: 'job-123',
      action: 'replay',
    });
    expect(text).toContain('Success: Replayed held delegated result.');
    expect(text).toContain('Held delegated output');

    await cli.stop();
  });

  it('/assistant jobs should prioritize operator-relevant jobs over routine successful delegated background work', async () => {
    const { input, output, cli } = makeCli({
      onAssistantState: () => ({
        orchestrator: {
          summary: {
            startedAt: Date.now() - 60_000,
            uptimeMs: 60_000,
            sessionCount: 1,
            runningCount: 0,
            queuedCount: 0,
            totalRequests: 3,
            completedRequests: 3,
            failedRequests: 0,
            avgExecutionMs: 180,
            avgEndToEndMs: 240,
            queuedByPriority: {
              high: 0,
              normal: 0,
              low: 0,
            },
          },
          sessions: [],
          traces: [],
        },
        jobs: {
          summary: {
            total: 2,
            running: 0,
            succeeded: 2,
            failed: 0,
            lastStartedAt: Date.now() - 30_000,
            lastCompletedAt: Date.now() - 20_000,
          },
          jobs: [
            {
              id: 'job-routine',
              type: 'delegated_worker',
              source: 'system',
              status: 'succeeded',
              startedAt: Date.now() - 5_000,
              durationMs: 25,
              detail: "scheduled • continuity security-triage:owner • I could not find an automation named 'scans'.",
              metadata: {
                delegation: {
                  kind: 'brokered_worker',
                  lifecycle: 'completed',
                  originChannel: 'scheduled',
                  continuityKey: 'security-triage:owner',
                  handoff: {
                    summary: "I could not find an automation named 'scans'.",
                    reportingMode: 'inline_response',
                    runClass: 'short_lived',
                  },
                },
              },
              display: {
                originSummary: 'scheduled • continuity security-triage:owner',
                outcomeSummary: "I could not find an automation named 'scans'.",
              },
            },
            {
              id: 'job-relevant',
              type: 'delegated_worker',
              source: 'manual',
              status: 'succeeded',
              startedAt: Date.now() - 10_000,
              durationMs: 190,
              detail: 'web • continuity __tier_shared__:owner • Approval pending',
              metadata: {
                delegation: {
                  kind: 'brokered_worker',
                  lifecycle: 'blocked',
                  originChannel: 'web',
                  continuityKey: '__tier_shared__:owner',
                  handoff: {
                    summary: 'Waiting for approval to run Codex.',
                    unresolvedBlockerKind: 'approval',
                    approvalCount: 1,
                    nextAction: 'Approve the pending coding backend run.',
                    reportingMode: 'held_for_approval',
                    runClass: 'short_lived',
                  },
                },
              },
              display: {
                originSummary: 'web • continuity __tier_shared__:owner',
                outcomeSummary: 'Waiting for approval to run Codex.',
                followUp: {
                  reportingMode: 'held_for_approval',
                  label: 'Approval pending',
                  needsOperatorAction: true,
                  approvalCount: 1,
                  nextAction: 'Approve the pending coding backend run.',
                },
              },
            },
          ],
        },
        lastPolicyDecisions: [],
        defaultProvider: 'ollama',
        guardianEnabled: true,
        providerCount: 2,
        providers: ['ollama', 'claude'],
        scheduledJobs: [],
      }),
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/assistant jobs 1');
    const text = readOutput(output);

    expect(text).toContain('Approval pending');
    expect(text).toContain('Showing operator-relevant jobs.');
    expect(text).not.toContain("automation named 'scans'");

    await cli.stop();
  });

  // ─── /providers ───────────────────────────────────────

  it('/providers should show connectivity table', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/providers');
    const text = readOutput(output);

    expect(text).toContain('ollama');
    expect(text).toContain('claude');
    expect(text).toContain('PASS');
    expect(text).toContain('FAIL');
    expect(text).toContain('llama3.2');
    expect(text).toContain('llama3.3');
    expect(text).toContain('mistral');

    await cli.stop();
  });

  // ─── /budget ──────────────────────────────────────────

  it('/budget should show per-agent resource usage', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/budget');
    const text = readOutput(output);

    expect(text).toContain('agent-1');
    expect(text).toContain('agent-2');
    expect(text).toContain('100');
    expect(text).toContain('overrun');

    await cli.stop();
  });

  // ─── /watchdog ────────────────────────────────────────

  it('/watchdog should show check results', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/watchdog');
    const text = readOutput(output);

    expect(text).toContain('agent-1');
    expect(text).toContain('OK');
    expect(text).toContain('agent-2');
    expect(text).toContain('STALLED');

    await cli.stop();
  });

  // ─── /config ──────────────────────────────────────────

  it('/config should show full redacted config', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/config');
    const text = readOutput(output);

    expect(text).toContain('ollama');
    expect(text).toContain('llama3.2');
    expect(text).toContain('anthropic');
    expect(text).toContain('claude-sonnet');
    expect(text).toContain('enabled');
    expect(text).toContain('60/min');
    expect(text).toContain('Sentinel');

    await cli.stop();
  });

  it('/config provider <name> should show specific provider', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/config provider ollama');
    const text = readOutput(output);

    expect(text).toContain('ollama');
    expect(text).toContain('llama3.2');

    await cli.stop();
  });

  it('/config provider <unknown> should show not found', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/config provider nonexistent');
    const text = readOutput(output);

    expect(text).toContain('not found');

    await cli.stop();
  });

  it('/config set default <provider> should explain that the primary provider is derived', async () => {
    const { input, output, cli } = makeCli({
      onConfigUpdate: async () => ({ success: true, message: 'Config saved.' }),
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/config set default claude');
    const text = readOutput(output);

    expect(text).toContain('derived automatically');
    expect(text).toContain('managed-cloud, local, or frontier defaults');

    await cli.stop();
  });

  it('/config set <provider> model <value> should update provider field', async () => {
    const updates: unknown[] = [];
    const { input, output, cli } = makeCli({
      onConfigUpdate: async (u) => {
        updates.push(u);
        return { success: true, message: 'Saved.' };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/config set ollama model llama3.3');
    const text = readOutput(output);

    expect(text).toContain('OK');
    expect(updates.length).toBe(1);
    const update = updates[0] as { llm: Record<string, { model: string }> };
    expect(update.llm.ollama.model).toBe('llama3.3');

    await cli.stop();
  });

  it('/config add should create new provider', async () => {
    const updates: unknown[] = [];
    const { input, output, cli } = makeCli({
      onConfigUpdate: async (u) => {
        updates.push(u);
        return { success: true, message: 'Added.' };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/config add myollama ollama mistral');
    const text = readOutput(output);

    expect(text).toContain('OK');
    expect(updates.length).toBe(1);
    const update = updates[0] as { llm: Record<string, { provider: string; model: string }> };
    expect(update.llm.myollama.provider).toBe('ollama');
    expect(update.llm.myollama.model).toBe('mistral');

    await cli.stop();
  });

  it('/config test should show connectivity results', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/config test');
    const text = readOutput(output);

    expect(text).toContain('PASS');
    expect(text).toContain('FAIL');

    await cli.stop();
  });

  it('/config test <provider> should filter to specific provider', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/config test ollama');
    const text = readOutput(output);

    expect(text).toContain('ollama');
    expect(text).toContain('PASS');

    await cli.stop();
  });

  it('/config telegram status should show telegram setup info', async () => {
    const { input, output, cli } = makeCli({
      onConfig: () => ({
        ...mockDashboard.onConfig!(),
        channels: {
          ...mockDashboard.onConfig!().channels,
          telegram: {
            enabled: true,
            botTokenConfigured: true,
            allowedChatIds: [12345, -1001234567890],
          },
        },
      }),
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/config telegram status');
    const text = readOutput(output);

    expect(text).toContain('Telegram Channel');
    expect(text).toContain('configured');
    expect(text).toContain('12345');

    await cli.stop();
  });

  it('/config telegram on should update telegram channel config', async () => {
    const updates: unknown[] = [];
    const { input, output, cli } = makeCli({
      onConfigUpdate: async (u) => {
        updates.push(u);
        return { success: true, message: 'Saved.' };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/config telegram on');
    const text = readOutput(output);

    expect(text).toContain('OK');
    expect(updates.length).toBe(1);
    const update = updates[0] as { channels: { telegram: { enabled: boolean } } };
    expect(update.channels.telegram.enabled).toBe(true);

    await cli.stop();
  });

  it('/config telegram chatids should parse and update allowlist', async () => {
    const updates: unknown[] = [];
    const { input, output, cli } = makeCli({
      onConfigUpdate: async (u) => {
        updates.push(u);
        return { success: true, message: 'Saved.' };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/config telegram chatids 12345,-100999');
    const text = readOutput(output);

    expect(text).toContain('OK');
    expect(updates.length).toBe(1);
    const update = updates[0] as { channels: { telegram: { allowedChatIds: number[] } } };
    expect(update.channels.telegram.allowedChatIds).toEqual([12345, -100999]);

    await cli.stop();
  });

  // ─── /audit ───────────────────────────────────────────

  it('/audit should show recent events', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/audit');
    const text = readOutput(output);

    expect(text).toContain('action_denied');
    expect(text).toContain('agent-1');
    expect(text).toContain('CapabilityController');

    await cli.stop();
  });

  it('/audit <limit> should pass limit', async () => {
    const filters: unknown[] = [];
    const { input, output, cli } = makeCli({
      onAuditQuery: (filter) => {
        filters.push(filter);
        return [];
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/audit 5');
    readOutput(output);

    expect(filters.length).toBe(1);
    expect((filters[0] as { limit: number }).limit).toBe(5);

    await cli.stop();
  });

  it('/audit filter type <value> should filter by type', async () => {
    const filters: unknown[] = [];
    const { input, output, cli } = makeCli({
      onAuditQuery: (filter) => {
        filters.push(filter);
        return [];
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/audit filter type secret_detected');
    readOutput(output);

    expect(filters.length).toBe(1);
    expect((filters[0] as { type: string }).type).toBe('secret_detected');

    await cli.stop();
  });

  it('/audit filter severity <value> should filter by severity', async () => {
    const filters: unknown[] = [];
    const { input, output, cli } = makeCli({
      onAuditQuery: (filter) => {
        filters.push(filter);
        return [];
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/audit filter severity critical');
    readOutput(output);

    expect(filters.length).toBe(1);
    expect((filters[0] as { severity: string }).severity).toBe('critical');

    await cli.stop();
  });

  it('/audit summary should show stats', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/audit summary');
    const text = readOutput(output);

    expect(text).toContain('Total events: 5');
    expect(text).toContain('agent-1');
    expect(text).toContain('CapabilityController');

    await cli.stop();
  });

  it('/audit summary <windowMs> should use custom window', async () => {
    const windows: number[] = [];
    const { input, output, cli } = makeCli({
      onAuditSummary: (windowMs) => {
        windows.push(windowMs);
        return {
          totalEvents: 0, byType: {}, bySeverity: { info: 0, warn: 0, critical: 0 },
          topDeniedAgents: [], topControllers: [],
          windowStart: Date.now() - windowMs, windowEnd: Date.now(),
        };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/audit summary 300000');
    readOutput(output);

    expect(windows.length).toBe(1);
    expect(windows[0]).toBe(300000);

    await cli.stop();
  });

  // ─── /security ────────────────────────────────────────

  it('/security should show combined overview', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/security');
    const text = readOutput(output);

    expect(text).toContain('Security Overview');
    expect(text).toContain('ENABLED');
    expect(text).toContain('60/min');
    expect(text).toContain('Total events');
    expect(text).toContain('Denials');

    await cli.stop();
  });

  // ─── /models ──────────────────────────────────────────

  it('/models should list available models per provider', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/models');
    const text = readOutput(output);

    expect(text).toContain('ollama');
    expect(text).toContain('llama3.2');
    expect(text).toContain('llama3.3');
    expect(text).toContain('mistral');
    expect(text).toContain('active');

    await cli.stop();
  });

  it('/models <provider> should filter to specific provider', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/models ollama');
    const text = readOutput(output);

    expect(text).toContain('ollama');
    expect(text).toContain('llama3.2');

    await cli.stop();
  });

  // ─── /intel ───────────────────────────────────────────

  it('/intel should show threat-intel summary', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/intel');
    const text = readOutput(output);

    expect(text).toContain('Threat Intel Summary');
    expect(text).toContain('enabled');
    expect(text).toContain('high/critical');

    await cli.stop();
  });

  it('/intel watch add should update watchlist', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/intel watch add guardian-agent');
    const text = readOutput(output);

    expect(text).toContain('Added guardian-agent');

    await cli.stop();
  });

  it('/intel scan should show findings', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/intel scan');
    const text = readOutput(output);

    expect(text).toContain('Scan completed');
    expect(text).toContain('New findings');

    await cli.stop();
  });

  // ─── /clear ───────────────────────────────────────────

  it('/clear should write ANSI clear sequence', async () => {
    const { input, output, cli } = makeCli();
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/clear');
    const text = readOutput(output);

    expect(text).toContain('\x1b[2J');

    await cli.stop();
  });

  // ─── Backward compatibility ───────────────────────────

  it('should work without dashboard callbacks (legacy mode)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const agents: AgentInfo[] = [
      { id: 'chat', name: 'ChatAgent', state: 'idle', capabilities: ['read_files'] },
    ];
    const status: RuntimeStatus = {
      running: true, agentCount: 1, guardianEnabled: true, providers: ['ollama'],
    };
    const cli = new CLIChannel({
      input, output,
      onAgents: () => agents,
      onStatus: () => status,
    });

    await cli.start(async () => ({ content: 'ok' }));

    // /agents should use legacy format
    input.write('/agents\n');
    await new Promise(r => setTimeout(r, 50));
    const text1 = output.read()?.toString() ?? '';
    expect(text1).toContain('ChatAgent');
    expect(text1).toContain('chat');

    // /status should use legacy format
    input.write('/status\n');
    await new Promise(r => setTimeout(r, 50));
    const text2 = output.read()?.toString() ?? '';
    expect(text2).toContain('yes');
    expect(text2).toContain('enabled');

    await cli.stop();
  });

  it('should show not available when dashboard callback missing', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cli = new CLIChannel({ input, output, dashboard: {} });

    await cli.start(async () => ({ content: 'ok' }));

    input.write('/budget\n');
    await new Promise(r => setTimeout(r, 50));
    const text = output.read()?.toString() ?? '';
    expect(text).toContain('not available');

    await cli.stop();
  });
});

describe('WebChannel', () => {
  const TEST_TOKEN = 'test-token-for-tests';
  const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}` };
  let web: WebChannel | null = null;

  async function issuePrivilegedTicket(port: number, action: string): Promise<string> {
    const res = await fetch(`http://localhost:${port}/api/auth/ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ action }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ticket: string };
    return body.ticket;
  }

  afterEach(async () => {
    if (web) {
      await web.stop();
      web = null;
    }
  });

  it('should start and stop a server', async () => {
    web = new WebChannel({ port: 0, authToken: TEST_TOKEN }); // port 0 = random

    // For testing, we need a valid port. Use a high port.
    web = new WebChannel({ port: 18923, authToken: TEST_TOKEN });

    const handler = async (_msg: UserMessage): Promise<AgentResponse> => {
      return { content: 'response' };
    };

    await web.start(handler);
    await web.stop();
    web = null;
  });

  it('should respond to health check', async () => {
    web = new WebChannel({ port: 18924, authToken: TEST_TOKEN });

    await web.start(async () => ({ content: 'ok' }));

    const res = await fetch('http://localhost:18924/health');
    const body = await res.json() as { status: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
  });

  it('should handle POST /api/message', async () => {
    web = new WebChannel({ port: 18925, authToken: TEST_TOKEN });
    const received: UserMessage[] = [];

    await web.start(async (msg) => {
      received.push(msg);
      return { content: `Echo: ${msg.content}` };
    });

    const res = await fetch('http://localhost:18925/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ content: 'Hello', surfaceId: 'web-guardian-chat' }),
    });

    const body = await res.json() as { content: string };

    expect(res.status).toBe(200);
    expect(body.content).toBe('Echo: Hello');
    expect(received.length).toBe(1);
    expect(received[0]?.surfaceId).toBe('web-guardian-chat');
  });

  it('should return 400 for missing content', async () => {
    web = new WebChannel({ port: 18926, authToken: TEST_TOKEN });

    await web.start(async () => ({ content: 'ok' }));

    const res = await fetch('http://localhost:18926/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('should return 400 for non-string content', async () => {
    web = new WebChannel({ port: 18966, authToken: TEST_TOKEN });

    await web.start(async () => ({ content: 'ok' }));

    const res = await fetch('http://localhost:18966/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ content: { text: 'Hello' } }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('content is required');
  });

  it('should return 400 for whitespace-only content', async () => {
    web = new WebChannel({ port: 18967, authToken: TEST_TOKEN });

    await web.start(async () => ({ content: 'ok' }));

    const res = await fetch('http://localhost:18967/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ content: '   ' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('content is required');
  });

  it('should return 404 for unknown routes', async () => {
    web = new WebChannel({ port: 18927, authToken: TEST_TOKEN });

    await web.start(async () => ({ content: 'ok' }));

    const res = await fetch('http://localhost:18927/unknown', { headers: authHeaders });
    expect(res.status).toBe(404);
  });

  it('blocks manual code terminals when dashboard policy denies them', async () => {
    web = new WebChannel({
      port: 18928,
      authToken: TEST_TOKEN,
      dashboard: {
        onCodeTerminalAccessCheck: () => ({
          allowed: false,
          reason: 'Manual code terminals are disabled by security policy.',
        }),
      },
    });

    await web.start(async () => ({ content: 'ok' }));

    const res = await fetch('http://localhost:18928/api/code/terminals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({}),
    });
    const body = await res.json() as { error: string };

    expect(res.status).toBe(403);
    expect(body.error).toContain('disabled by security policy');
  });

  it('requires a privileged ticket for sensitive memory config updates', async () => {
    const updates: unknown[] = [];
    web = new WebChannel({
      port: 18969,
      authToken: TEST_TOKEN,
      dashboard: {
        onConfigUpdate: async (u) => {
          updates.push(u);
          return { success: true, message: 'Saved.' };
        },
      },
    });

    await web.start(async () => ({ content: 'ok' }));

    const unauthorized = await fetch('http://localhost:18969/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ assistant: { memory: { knowledgeBase: { readOnly: true } } } }),
    });
    expect(unauthorized.status).toBe(401);
    expect(updates).toHaveLength(0);

    const ticket = await issuePrivilegedTicket(18969, 'memory.config');
    const authorized = await fetch('http://localhost:18969/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ assistant: { memory: { knowledgeBase: { readOnly: true } } }, ticket }),
    });
    expect(authorized.status).toBe(200);
    expect(updates).toHaveLength(1);
  });

  it('requires a privileged ticket for security config updates', async () => {
    const updates: unknown[] = [];
    web = new WebChannel({
      port: 18970,
      authToken: TEST_TOKEN,
      dashboard: {
        onConfigUpdate: async (u) => {
          updates.push(u);
          return { success: true, message: 'Saved.' };
        },
      },
    });

    await web.start(async () => ({ content: 'ok' }));

    const unauthorized = await fetch('http://localhost:18970/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ assistant: { security: { operatingMode: 'guarded' } } }),
    });
    expect(unauthorized.status).toBe(401);
    expect(updates).toHaveLength(0);

    const ticket = await issuePrivilegedTicket(18970, 'config.security');
    const authorized = await fetch('http://localhost:18970/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ assistant: { security: { operatingMode: 'guarded' } }, ticket }),
    });
    expect(authorized.status).toBe(200);
    expect(updates).toHaveLength(1);
  });

  it('requires a privileged ticket for tools policy changes', async () => {
    const updates: unknown[] = [];
    web = new WebChannel({
      port: 18971,
      authToken: TEST_TOKEN,
      dashboard: {
        onToolsPolicyUpdate: (u) => {
          updates.push(u);
          return { success: true, message: 'Updated.' };
        },
      },
    });

    await web.start(async () => ({ content: 'ok' }));

    const unauthorized = await fetch('http://localhost:18971/api/tools/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ mode: 'autonomous' }),
    });
    expect(unauthorized.status).toBe(401);
    expect(updates).toHaveLength(0);

    const ticket = await issuePrivilegedTicket(18971, 'tools.policy');
    const authorized = await fetch('http://localhost:18971/api/tools/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ mode: 'autonomous', ticket }),
    });
    expect(authorized.status).toBe(200);
    expect(updates).toHaveLength(1);
  });

  it('GET /api/performance/status should return performance status', async () => {
    web = new WebChannel({
      port: 18982,
      authToken: TEST_TOKEN,
      dashboard: {
        onPerformanceStatus: async () => ({
          activeProfile: 'coding-focus',
          os: 'win32',
          snapshot: {
            cpuPercent: 41,
            memoryMb: 4096,
            diskFreeMb: 120000,
            activeProfile: 'coding-focus',
            sampledAt: Date.now(),
          },
          capabilities: {
            canManageProcesses: true,
            canManagePower: false,
            canRunCleanup: false,
            canProbeLatency: true,
            supportedActionIds: ['cleanup'],
          },
          profiles: [{
            id: 'coding-focus',
            name: 'Coding Focus',
            autoActionsEnabled: false,
            allowedActionIds: [],
            terminateProcessNames: ['Discord.exe'],
            protectProcessNames: ['node'],
          }],
          latencyTargets: [],
          history: [],
        }),
      },
    });

    await web.start(async () => ({ content: 'ok' }));

    const res = await fetch('http://localhost:18982/api/performance/status', { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { activeProfile: string; capabilities: { canManageProcesses: boolean } };
    expect(body.activeProfile).toBe('coding-focus');
    expect(body.capabilities.canManageProcesses).toBe(true);
  });

  it('GET /api/performance/processes should return the live process list', async () => {
    web = new WebChannel({
      port: 18985,
      authToken: TEST_TOKEN,
      dashboard: {
        onPerformanceProcesses: async () => ([
          {
            targetId: 'pid:200',
            pid: 200,
            name: 'Discord.exe',
            memoryMb: 300,
            protected: false,
          },
        ]),
      },
    });

    await web.start(async () => ({ content: 'ok' }));

    const res = await fetch('http://localhost:18985/api/performance/processes', { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { processes: Array<{ name: string; pid: number }> };
    expect(body.processes).toEqual([
      expect.objectContaining({
        name: 'Discord.exe',
        pid: 200,
      }),
    ]);
  });

  it('requires a privileged ticket for performance profile apply', async () => {
    const appliedProfiles: string[] = [];
    web = new WebChannel({
      port: 18983,
      authToken: TEST_TOKEN,
      dashboard: {
        onPerformanceApplyProfile: async (profileId) => {
          appliedProfiles.push(profileId);
          return { success: true, message: `applied:${profileId}` };
        },
      },
    });

    await web.start(async () => ({ content: 'ok' }));

    const unauthorized = await fetch('http://localhost:18983/api/performance/profile/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ profileId: 'coding-focus' }),
    });
    expect(unauthorized.status).toBe(401);
    expect(appliedProfiles).toHaveLength(0);

    const ticket = await issuePrivilegedTicket(18983, 'performance.manage');
    const authorized = await fetch('http://localhost:18983/api/performance/profile/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ profileId: 'coding-focus', ticket }),
    });
    expect(authorized.status).toBe(200);
    expect(appliedProfiles).toEqual(['coding-focus']);
  });

  it('requires a privileged ticket for performance action runs', async () => {
    const actions: Array<{ previewId: string; selectedProcessTargetIds: string[]; selectedCleanupTargetIds: string[] }> = [];
    web = new WebChannel({
      port: 18984,
      authToken: TEST_TOKEN,
      dashboard: {
        onPerformanceRunAction: async (action) => {
          actions.push(action);
          return { success: true, message: 'ran' };
        },
      },
    });

    await web.start(async () => ({ content: 'ok' }));

    const unauthorized = await fetch('http://localhost:18984/api/performance/action/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        previewId: 'preview-1',
        selectedProcessTargetIds: ['pid:200'],
        selectedCleanupTargetIds: [],
      }),
    });
    expect(unauthorized.status).toBe(401);
    expect(actions).toHaveLength(0);

    const ticket = await issuePrivilegedTicket(18984, 'performance.manage');
    const authorized = await fetch('http://localhost:18984/api/performance/action/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        previewId: 'preview-1',
        selectedProcessTargetIds: ['pid:200'],
        selectedCleanupTargetIds: [],
        ticket,
      }),
    });
    expect(authorized.status).toBe(200);
    expect(actions).toEqual([{
      previewId: 'preview-1',
      selectedProcessTargetIds: ['pid:200'],
      selectedCleanupTargetIds: [],
    }]);
  });

  it('propagates baseline rejections from direct config updates', async () => {
    web = new WebChannel({
      port: 18973,
      authToken: TEST_TOKEN,
      dashboard: {
        onConfigUpdate: async () => ({
          success: false,
          message: 'Security baseline prevents this change.',
          statusCode: 403,
          errorCode: 'security_baseline_enforced',
        }),
      },
    });

    await web.start(async () => ({ content: 'ok' }));

    const ticket = await issuePrivilegedTicket(18973, 'config.security');
    const res = await fetch('http://localhost:18973/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ guardian: { enabled: false }, ticket }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'security_baseline_enforced',
    });
  });

  it('propagates baseline rejections from guardian agent updates', async () => {
    web = new WebChannel({
      port: 18974,
      authToken: TEST_TOKEN,
      dashboard: {
        onGuardianAgentUpdate: () => ({
          success: false,
          message: 'Security baseline prevents this change.',
          statusCode: 403,
          errorCode: 'security_baseline_enforced',
        }),
      },
    });

    await web.start(async () => ({ content: 'ok' }));

    const ticket = await issuePrivilegedTicket(18974, 'guardian.config');
    const res = await fetch('http://localhost:18974/api/guardian-agent/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ enabled: false, ticket }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'security_baseline_enforced',
    });
  });

  it('propagates baseline rejections from policy engine updates', async () => {
    web = new WebChannel({
      port: 18975,
      authToken: TEST_TOKEN,
      dashboard: {
        onPolicyUpdate: () => ({
          success: false,
          message: 'Security baseline prevents this change.',
          statusCode: 403,
          errorCode: 'security_baseline_enforced',
        }),
      },
    });

    await web.start(async () => ({ content: 'ok' }));

    const ticket = await issuePrivilegedTicket(18975, 'policy.config');
    const res = await fetch('http://localhost:18975/api/policy/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ enabled: false, ticket }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'security_baseline_enforced',
    });
  });

  it('rate limits privileged ticket minting', async () => {
    web = new WebChannel({ port: 18972, authToken: TEST_TOKEN });
    await web.start(async () => ({ content: 'ok' }));

    for (let i = 0; i < 24; i += 1) {
      const res = await fetch('http://localhost:18972/api/auth/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ action: 'killswitch' }),
      });
      expect(res.status).toBe(200);
    }

    const limited = await fetch('http://localhost:18972/api/auth/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ action: 'killswitch' }),
    });
    expect(limited.status).toBe(429);
  });

  it('scopes privileged ticket minting limits per action', async () => {
    web = new WebChannel({ port: 18976, authToken: TEST_TOKEN });
    await web.start(async () => ({ content: 'ok' }));

    for (let i = 0; i < 24; i += 1) {
      const res = await fetch('http://localhost:18976/api/auth/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ action: 'search.pick-path' }),
      });
      expect(res.status).toBe(200);
    }

    const differentAction = await fetch('http://localhost:18976/api/auth/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ action: 'tools.policy' }),
    });
    expect(differentAction.status).toBe(200);
  });

  it('requires a privileged ticket for killswitch', async () => {
    let killswitchCalls = 0;
    web = new WebChannel({
      port: 18973,
      authToken: TEST_TOKEN,
      dashboard: {
        onKillswitch: () => {
          killswitchCalls += 1;
        },
      },
    });

    await web.start(async () => ({ content: 'ok' }));

    const unauthorized = await fetch('http://localhost:18973/api/killswitch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({}),
    });
    expect(unauthorized.status).toBe(401);
    expect(killswitchCalls).toBe(0);

    const ticket = await issuePrivilegedTicket(18973, 'killswitch');
    const authorized = await fetch('http://localhost:18973/api/killswitch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ ticket }),
    });
    expect(authorized.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(killswitchCalls).toBe(1);
  });

  // ─── Fix #4: Web Channel Security Hardening ───────────────────

  describe('Fix #4: Bearer token authentication', () => {
    it('should require auth when authToken is configured', async () => {
      web = new WebChannel({ port: 18930, authToken: 'secret-token-123' });
      await web.start(async () => ({ content: 'ok' }));

      // No auth header → 401
      const res = await fetch('http://localhost:18930/api/status');
      expect(res.status).toBe(401);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Authentication required');
    });

    it('should reject invalid token', async () => {
      web = new WebChannel({ port: 18931, authToken: 'secret-token-123' });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18931/api/status', {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Invalid token');
    });

    it('should accept valid token', async () => {
      web = new WebChannel({ port: 18932, authToken: 'secret-token-123' });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18932/api/status', {
        headers: { Authorization: 'Bearer secret-token-123' },
      });
      expect(res.status).toBe(200);
    });

    it('should allow health check without auth', async () => {
      web = new WebChannel({ port: 18933, authToken: 'secret-token-123' });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18933/health');
      expect(res.status).toBe(200);
    });

    it('should rate limit repeated auth failures', async () => {
      web = new WebChannel({ port: 18965, authToken: 'secret-token-123' });
      await web.start(async () => ({ content: 'ok' }));

      let lastResponse: Response | null = null;
      for (let i = 0; i < 10; i++) {
        lastResponse = await fetch('http://localhost:18965/api/status', {
          headers: { Authorization: `Bearer wrong-token-${i}` },
        });
      }

      expect(lastResponse).not.toBeNull();
      expect(lastResponse!.status).toBe(429);
      expect(lastResponse!.headers.get('retry-after')).not.toBeNull();
      const body = await lastResponse!.json() as { error: string };
      expect(body.error).toBe('Too many authentication failures. Try again later.');
    });

    it('should still accept a valid token after previous auth failures', async () => {
      web = new WebChannel({ port: 18966, authToken: 'secret-token-123' });
      await web.start(async () => ({ content: 'ok' }));

      for (let i = 0; i < 10; i++) {
        await fetch('http://localhost:18966/api/status', {
          headers: { Authorization: `Bearer wrong-token-${i}` },
        });
      }

      const res = await fetch('http://localhost:18966/api/status', {
        headers: { Authorization: 'Bearer secret-token-123' },
      });
      expect(res.status).toBe(200);
    });

    it('should allow API access without auth when web auth is disabled', async () => {
      web = new WebChannel({
        port: 18978,
        auth: {
          mode: 'disabled',
          token: 'secret-token-123',
          tokenSource: 'config',
        },
      });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18978/api/status');
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('running');
    });

    it('should report disabled mode in auth status', async () => {
      const dashboard: DashboardCallbacks = {
        onAuthStatus: () => ({
          mode: 'disabled',
          tokenConfigured: false,
          tokenSource: 'ephemeral',
          rotateOnStartup: false,
          host: 'localhost',
          port: 18979,
        }),
      };
      web = new WebChannel({
        port: 18979,
        auth: { mode: 'disabled' },
        dashboard,
      });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18979/api/auth/status');
      expect(res.status).toBe(200);
      const body = await res.json() as { mode: string; tokenConfigured: boolean };
      expect(body.mode).toBe('disabled');
      expect(body.tokenConfigured).toBe(false);
    });
  });

  describe('Fix #4: CORS origin allowlist', () => {
    it('should not set Access-Control-Allow-Origin when no origins configured', async () => {
      web = new WebChannel({ port: 18934, authToken: TEST_TOKEN });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18934/health', {
        headers: { Origin: 'https://evil.com' },
      });
      expect(res.status).toBe(200);
      // No ACAO header since origin is not in allowed list
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('should reflect allowed origin', async () => {
      web = new WebChannel({ port: 18935, authToken: TEST_TOKEN, allowedOrigins: ['https://myapp.com'] });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18935/health', {
        headers: { Origin: 'https://myapp.com' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('https://myapp.com');
    });

    it('should reject disallowed origin', async () => {
      web = new WebChannel({ port: 18936, authToken: TEST_TOKEN, allowedOrigins: ['https://myapp.com'] });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18936/health', {
        headers: { Origin: 'https://evil.com' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('Fix #4: Request body size limit', () => {
    it('should reject oversized request body', async () => {
      web = new WebChannel({ port: 18937, maxBodyBytes: 100, authToken: TEST_TOKEN });
      await web.start(async () => ({ content: 'ok' }));

      const largeContent = 'x'.repeat(200);
      // Server destroys the socket mid-stream, so fetch may get a socket error
      // or a 413 response depending on timing. Either outcome means the body was rejected.
      try {
        const res = await fetch('http://localhost:18937/api/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ content: largeContent }),
        });
        // If we get a response, it should be 413
        expect(res.status).toBe(413);
      } catch (err) {
        // Socket error is expected when server destroys connection mid-stream
        expect((err as Error).message).toContain('fetch failed');
      }
    });

    it('should accept body within limit', async () => {
      web = new WebChannel({ port: 18938, maxBodyBytes: 10000, authToken: TEST_TOKEN });
      await web.start(async (msg) => ({ content: `Echo: ${msg.content}` }));

      const res = await fetch('http://localhost:18938/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ content: 'small' }),
      });
      expect(res.status).toBe(200);
    });

    it('should return 400 for invalid JSON', async () => {
      web = new WebChannel({ port: 18939, authToken: TEST_TOKEN });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18939/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: 'not-json{{{',
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Invalid JSON');
    });
  });

  // ─── Dashboard API Endpoints ─────────────────────────────────

  describe('Dashboard API', () => {
    const mockAgents: DashboardAgentInfo[] = [
      { id: 'agent-1', name: 'TestAgent', state: 'idle', capabilities: ['read_files'], lastActivityMs: Date.now(), consecutiveErrors: 0 },
      { id: 'agent-2', name: 'Sentinel', state: 'running', capabilities: [], provider: 'ollama', lastActivityMs: Date.now(), consecutiveErrors: 0 },
    ];

    const mockDetail: DashboardAgentDetail = {
      ...mockAgents[0],
      resourceLimits: { maxInvocationBudgetMs: 120000, maxTokensPerMinute: 0, maxConcurrentTools: 0, maxQueueDepth: 1000 },
    };

    const mockDashboard: DashboardCallbacks = {
      onAgents: () => mockAgents,
      onAgentDetail: (id) => id === 'agent-1' ? mockDetail : null,
      onAuditQuery: (filter) => [{
        id: 'audit-1', timestamp: Date.now(), type: 'action_denied' as const,
        severity: 'warn' as const, agentId: 'agent-1', details: { reason: 'test' },
      }],
      onAuditSummary: (windowMs) => ({
        totalEvents: 5, byType: { action_denied: 2 }, bySeverity: { info: 1, warn: 3, critical: 1 },
        topDeniedAgents: [{ agentId: 'agent-1', count: 2 }], topControllers: [],
        windowStart: Date.now() - windowMs, windowEnd: Date.now(),
      }),
      onConfig: () => ({
        llm: { ollama: { provider: 'ollama', model: 'llama3.2' } },
        defaultProvider: 'ollama',
        channels: {
          cli: { enabled: true },
          web: {
            enabled: true,
            port: 3000,
            auth: {
              mode: 'bearer_required',
              tokenConfigured: true,
              tokenSource: 'config',
              rotateOnStartup: false,
            },
          },
        },
        guardian: { enabled: true },
        runtime: { maxStallDurationMs: 60000, watchdogIntervalMs: 10000, logLevel: 'info' },
        assistant: {
          setupCompleted: false,
          identity: { mode: 'single_user', primaryUserId: 'owner' },
          soul: {
            enabled: true,
            path: 'SOUL.md',
            primaryMode: 'full',
            delegatedMode: 'summary',
            maxChars: 8000,
            summaryMaxChars: 1000,
          },
          memory: { enabled: true, retentionDays: 30 },
          analytics: { enabled: true, retentionDays: 30 },
          quickActions: { enabled: true },
          threatIntel: {
            enabled: true,
            allowDarkWeb: false,
            responseMode: 'assisted',
            watchlistCount: 0,
            autoScanIntervalMinutes: 180,
            moltbook: {
              enabled: false,
              mode: 'mock',
              allowActiveResponse: false,
            },
          },
          connectors: {
            enabled: false,
            executionMode: 'plan_then_execute',
            maxConnectorCallsPerRun: 12,
            packCount: 0,
            enabledPackCount: 0,
            playbookCount: 0,
            playbooks: {
              enabled: true,
              maxSteps: 12,
              maxParallelSteps: 3,
              defaultStepTimeoutMs: 15000,
              requireSignedDefinitions: true,
              requireDryRunOnFirstExecution: true,
            },
            studio: {
              enabled: true,
              mode: 'builder',
              requirePrivilegedTicket: true,
            },
          },
          tools: {
            enabled: true,
            policyMode: 'approve_by_policy',
            allowExternalPosting: false,
            allowedPathsCount: 1,
            allowedCommandsCount: 3,
            allowedDomainsCount: 2,
          },
        },
      }),
      onBudget: () => ({
        agents: [{ agentId: 'agent-1', tokensPerMinute: 100, concurrentInvocations: 1, overrunCount: 0 }],
        recentOverruns: [],
      }),
      onWatchdog: () => [{ agentId: 'agent-1', action: 'ok' as const }],
      onProviders: () => [{ name: 'ollama', type: 'ollama', model: 'llama3.2', locality: 'local' as const, connected: true }],
      onAssistantState: () => ({
        orchestrator: {
          summary: {
            startedAt: Date.now() - 120_000,
            uptimeMs: 120_000,
            sessionCount: 2,
            runningCount: 1,
            queuedCount: 1,
            totalRequests: 9,
            completedRequests: 8,
            failedRequests: 1,
            avgExecutionMs: 210,
            avgEndToEndMs: 320,
            queuedByPriority: {
              high: 1,
              normal: 0,
              low: 0,
            },
          },
          sessions: [],
          traces: [],
        },
        jobs: {
          summary: {
            total: 4,
            running: 1,
            succeeded: 2,
            failed: 1,
            lastStartedAt: Date.now() - 5_000,
            lastCompletedAt: Date.now() - 2_500,
          },
          jobs: [],
        },
        lastPolicyDecisions: [],
        defaultProvider: 'ollama',
        guardianEnabled: true,
        providerCount: 1,
        providers: ['ollama'],
        scheduledJobs: [],
      }),
      onThreatIntelSummary: () => ({
        enabled: true,
        watchlistCount: 1,
        darkwebEnabled: false,
        responseMode: 'assisted',
        forumConnectors: [
          { id: 'moltbook', enabled: true, hostile: true, mode: 'mock' },
        ],
        findings: { total: 1, new: 1, highOrCritical: 1 },
      }),
      onThreatIntelPlan: () => ({
        title: 'Threat Plan',
        principles: ['Protect users'],
        phases: [{ phase: 'Phase 1', objective: 'Discover', deliverables: ['watchlist scans'] }],
      }),
      onThreatIntelWatchlist: () => ['target-a'],
      onThreatIntelWatchAdd: (target) => ({ success: true, message: `added:${target}` }),
      onThreatIntelWatchRemove: (target) => ({ success: true, message: `removed:${target}` }),
      onThreatIntelScan: () => ({
        success: true,
        message: 'scan complete',
        findings: [{
          id: 'finding-1',
          createdAt: Date.now(),
          target: 'target-a',
          sourceType: 'social',
          contentType: 'text',
          severity: 'high',
          confidence: 0.8,
          summary: 'Potential impersonation',
          status: 'new',
          labels: ['impersonation'],
        }],
      }),
      onThreatIntelFindings: () => [{
        id: 'finding-1',
        createdAt: Date.now(),
        target: 'target-a',
        sourceType: 'social',
        contentType: 'text',
        severity: 'high',
        confidence: 0.8,
        summary: 'Potential impersonation',
        status: 'new',
        labels: ['impersonation'],
      }],
      onThreatIntelUpdateFindingStatus: ({ findingId, status }) => ({ success: true, message: `${findingId}:${status}` }),
      onThreatIntelActions: () => [{
        id: 'action-1',
        findingId: 'finding-1',
        createdAt: Date.now(),
        type: 'report',
        status: 'proposed',
        requiresApproval: true,
        rationale: 'Test action',
      }],
      onThreatIntelDraftAction: ({ findingId, type }) => ({
        success: true,
        message: `drafted:${findingId}:${type}`,
      }),
      onThreatIntelSetResponseMode: (mode) => ({ success: true, message: `mode:${mode}` }),
      onToolsCategories: () => [
        { category: 'filesystem' as const, label: 'Filesystem', description: 'File operations', toolCount: 5, enabled: true },
      ],
      onToolsCategoryToggle: (input) => ({ success: true, message: `${input.category} toggled` }),
      onNetworkBaseline: () => ({
        snapshotCount: 4,
        minSnapshotsForBaseline: 3,
        baselineReady: true,
        lastUpdatedAt: Date.now(),
        knownDevices: [],
      }),
      onNetworkThreats: () => ({
        alerts: [{
          id: 'net-alert-1',
          type: 'new_device',
          severity: 'medium',
          timestamp: Date.now(),
          mac: 'aa:bb:cc:dd:ee:ff',
          ip: '192.168.1.25',
          description: 'New device detected',
          dedupeKey: 'new_device:aa:bb:cc:dd:ee:ff',
          evidence: {},
          acknowledged: false,
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
          occurrenceCount: 1,
        }],
        activeAlertCount: 1,
        bySeverity: { low: 0, medium: 1, high: 0, critical: 0 },
        baselineReady: true,
        snapshotCount: 4,
      }),
      onNetworkThreatAcknowledge: (alertId) => ({ success: true, message: `acked:${alertId}` }),
      onSecurityAlerts: () => ({
        alerts: [{
          id: 'net-alert-1',
          source: 'network',
          type: 'new_device',
          severity: 'medium',
          timestamp: Date.now(),
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
          occurrenceCount: 1,
          acknowledged: false,
          description: 'New device detected',
          dedupeKey: 'new_device:aa:bb:cc:dd:ee:ff',
          evidence: { ip: '192.168.1.25', macs: ['aa:bb:cc:dd:ee:ff'] },
          subject: '192.168.1.25',
        }],
        totalMatches: 1,
        returned: 1,
        searchedSources: ['network'],
        includeAcknowledged: false,
        bySource: { host: 0, network: 1, gateway: 0, native: 0, assistant: 0, install: 0 },
        bySeverity: { low: 0, medium: 1, high: 0, critical: 0 },
      }),
      onSecurityAlertAcknowledge: ({ alertId, source }) => ({ success: true, message: `security-acked:${source || 'auto'}:${alertId}`, source: source || 'network' }),
      onSecurityPosture: () => ({
        profile: 'personal',
        currentMode: 'monitor',
        recommendedMode: 'guarded',
        shouldEscalate: true,
        summary: "Profile 'personal' has 1 active alerts. Escalate from 'monitor' to 'guarded'.",
        reasons: ['A high-severity alert is active and should tighten approvals and outbound actions.'],
        counts: { total: 1, low: 0, medium: 1, high: 0, critical: 0 },
        bySource: { host: 0, network: 1, gateway: 0, native: 0, assistant: 0, install: 0 },
        availableSources: ['network'],
        topAlerts: [{
          id: 'net-alert-1',
          source: 'network',
          type: 'new_device',
          severity: 'medium',
          description: 'New device detected',
        }],
      }),
      onSecurityActivityLog: () => ({
        entries: [{
          id: 'security-activity-1',
          timestamp: Date.now(),
          agentId: 'security-triage-dispatcher',
          targetAgentId: 'security-triage',
          status: 'completed',
          severity: 'warn',
          title: 'Completed triage for beaconing',
          summary: 'Likely benign telemetry sync. Stay in monitor.',
          triggerEventType: 'security:network:threat',
          triggerDetailType: 'beaconing',
          dedupeKey: 'security:network:threat:beaconing',
        }],
        totalMatches: 1,
        returned: 1,
        byStatus: { started: 0, skipped: 0, completed: 1, failed: 0 },
      }),
      onWindowsDefenderStatus: () => ({
        status: {
          platform: 'win32',
          supported: true,
          available: true,
          provider: 'windows_defender',
          lastUpdatedAt: Date.now(),
          antivirusEnabled: true,
          realtimeProtectionEnabled: true,
          behaviorMonitorEnabled: true,
          controlledFolderAccessEnabled: true,
          firewallEnabled: true,
          signatureVersion: '1.2.3.4',
          engineVersion: '5.6.7.8',
          signatureAgeHours: 6,
          quickScanAgeHours: 12,
          fullScanAgeHours: 72,
          activeAlertCount: 1,
          bySeverity: { low: 0, medium: 1, high: 0, critical: 0 },
          summary: 'AV enabled • real-time enabled • firewall enabled • CFA enabled • 1 detection',
        },
        alerts: [{
          id: 'wd-1',
          type: 'defender_threat_detected',
          severity: 'medium',
          timestamp: Date.now(),
          description: 'Windows Defender detected a threat.',
          dedupeKey: 'wd:threat:1',
          evidence: { threatName: 'TestThreat' },
          acknowledged: false,
          status: 'active',
          lastStateChangedAt: Date.now(),
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
          occurrenceCount: 1,
        }],
      }),
      onWindowsDefenderRefresh: async () => mockDashboard.onWindowsDefenderStatus!(),
      onWindowsDefenderScan: async ({ type }) => ({ success: true, message: `scan:${type}` }),
      onWindowsDefenderUpdateSignatures: async () => ({ success: true, message: 'signatures:updated' }),
    };

    it('GET /api/agents should return agent list', async () => {
      web = new WebChannel({ port: 18940, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18940/api/agents', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as DashboardAgentInfo[];
      expect(body.length).toBe(2);
      expect(body[0].id).toBe('agent-1');
      expect(body[1].state).toBe('running');
    });

    it('GET /api/agents/:id should return agent detail', async () => {
      web = new WebChannel({ port: 18941, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18941/api/agents/agent-1', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as DashboardAgentDetail;
      expect(body.id).toBe('agent-1');
      expect(body.resourceLimits.maxInvocationBudgetMs).toBe(120000);
    });

    it('GET /api/agents/:id should return 404 for unknown agent', async () => {
      web = new WebChannel({ port: 18942, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18942/api/agents/unknown-agent', { headers: authHeaders });
      expect(res.status).toBe(404);
    });

    it('GET /api/audit should return filtered events', async () => {
      web = new WebChannel({ port: 18943, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18943/api/audit?type=action_denied&limit=10', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as unknown[];
      expect(body.length).toBeGreaterThan(0);
    });

    it('GET /api/audit/summary should return summary', async () => {
      web = new WebChannel({ port: 18944, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18944/api/audit/summary?windowMs=60000', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as { totalEvents: number };
      expect(body.totalEvents).toBe(5);
    });

    it('GET /api/config should return redacted config', async () => {
      web = new WebChannel({ port: 18945, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18945/api/config', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as { defaultProvider: string; llm: Record<string, unknown> };
      expect(body.defaultProvider).toBe('ollama');
      // Should not contain apiKey
      const ollamaConfig = body.llm['ollama'] as Record<string, unknown>;
      expect(ollamaConfig).not.toHaveProperty('apiKey');
    });

    it('GET /api/budget should return budget info', async () => {
      web = new WebChannel({ port: 18946, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18946/api/budget', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as { agents: unknown[] };
      expect(body.agents.length).toBe(1);
    });

    it('GET /api/watchdog should return watchdog results', async () => {
      web = new WebChannel({ port: 18947, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18947/api/watchdog', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ agentId: string; action: string }>;
      expect(body[0].agentId).toBe('agent-1');
      expect(body[0].action).toBe('ok');
    });

    it('GET /api/providers should return provider list', async () => {
      web = new WebChannel({ port: 18948, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18948/api/providers', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ name: string; type: string }>;
      expect(body[0].name).toBe('ollama');
    });

    it('GET /api/code/sessions should forward the explicit surfaceId query parameter', async () => {
      const seen: Array<{ userId: string; channel: string; surfaceId: string }> = [];
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
        onCodeSessionsList: (args) => {
          seen.push({
            userId: args.userId,
            channel: args.channel,
            surfaceId: args.surfaceId,
          });
          return { sessions: [], currentSessionId: null, referencedSessionIds: [] };
        },
      };

      web = new WebChannel({ port: 18974, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18974/api/code/sessions?userId=web-user&channel=web&surfaceId=web-guardian-chat', {
        headers: authHeaders,
      });

      expect(res.status).toBe(200);
      expect(seen).toEqual([{
        userId: 'web-user',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      }]);
    });

    it('POST /api/code/sessions/references should forward referenced session ids with surface context', async () => {
      const seen: Array<{ userId: string; channel: string; surfaceId: string; referencedSessionIds: string[] }> = [];
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
        onCodeSessionSetReferences: (args) => {
          seen.push({
            userId: args.userId,
            channel: args.channel,
            surfaceId: args.surfaceId,
            referencedSessionIds: args.referencedSessionIds,
          });
          return {
            sessions: [],
            currentSessionId: 'code-1',
            referencedSessionIds: ['code-2'],
          };
        },
      };

      web = new WebChannel({ port: 18978, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18978/api/code/sessions/references', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: 'web-user',
          channel: 'web',
          surfaceId: 'web-guardian-chat',
          referencedSessionIds: ['code-2'],
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        sessions: [],
        currentSessionId: 'code-1',
        referencedSessionIds: ['code-2'],
      });
      expect(seen).toEqual([{
        userId: 'web-user',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
        referencedSessionIds: ['code-2'],
      }]);
    });

    it('GET /api/code/sessions/:id/structure should return deterministic structure data for the selected file', async () => {
      const workspaceRoot = join(process.cwd(), `__test_code_structure_${randomUUID()}`);
      const sourceDir = join(workspaceRoot, 'src');
      const sourcePath = join(sourceDir, 'example.ts');
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(sourcePath, [
        'export function getAnswer() {',
        '  return computeAnswer();',
        '}',
        '',
        'function computeAnswer() {',
        '  return 42;',
        '}',
      ].join('\n'));

      try {
        const dashboard: DashboardCallbacks = {
          ...mockDashboard,
          onCodeSessionGet: () => ({
            session: {
              id: 'code-session-structure',
              ownerUserId: 'web-user',
              ownerPrincipalId: 'owner-principal',
              title: 'Structure Test',
              workspaceRoot,
              resolvedRoot: workspaceRoot,
              agentId: 'agent-1',
              status: 'active',
              attachmentPolicy: 'same_principal',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              lastActivityAt: Date.now(),
              conversationUserId: 'web-user',
              conversationChannel: 'code-session',
              uiState: {
                currentDirectory: workspaceRoot,
                selectedFilePath: sourcePath,
                showDiff: false,
                expandedDirs: [],
                terminalCollapsed: false,
                terminalTabs: [],
              },
              workState: {
                focusSummary: '',
                planSummary: '',
                compactedSummary: '',
                workspaceProfile: null,
                workspaceTrust: null,
                workspaceTrustReview: null,
                workspaceMap: null,
                workingSet: null,
                activeSkills: [],
                pendingApprovals: [],
                recentJobs: [],
                changedFiles: [],
                verification: [],
              },
            },
            history: [],
            attachments: [],
          }),
        };

        web = new WebChannel({ port: 18975, authToken: TEST_TOKEN, dashboard });
        await web.start(async () => ({ content: 'ok' }));

        const res = await fetch('http://localhost:18975/api/code/sessions/code-session-structure/structure', {
          headers: authHeaders,
        });
        expect(res.status).toBe(200);
        const body = await res.json() as {
          success: boolean;
          path: string;
          supported: boolean;
          language: string;
          symbols: Array<{
            name: string;
            kind: string;
            callers: string[];
            callees: string[];
          }>;
        };
        expect(body.success).toBe(true);
        expect(body.path).toBe('src/example.ts');
        expect(body.supported).toBe(true);
        expect(body.language).toBe('TypeScript');
        expect(body.symbols.map((symbol) => symbol.name)).toEqual(['getAnswer', 'computeAnswer']);
        expect(body.symbols[0]).toMatchObject({
          name: 'getAnswer',
          kind: 'function',
          callees: ['computeAnswer'],
        });
        expect(body.symbols[1]).toMatchObject({
          name: 'computeAnswer',
          callers: ['getAnswer'],
        });
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('POST /api/code/sessions/:id/structure-preview should analyze unsaved editor content', async () => {
      const workspaceRoot = join(process.cwd(), `__test_code_structure_preview_${randomUUID()}`);
      const sourceDir = join(workspaceRoot, 'src');
      const sourcePath = join(sourceDir, 'example.ts');
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(sourcePath, 'export function getAnswer() {\n  return 42;\n}\n');

      try {
        const dashboard: DashboardCallbacks = {
          ...mockDashboard,
          onCodeSessionGet: () => ({
            session: {
              id: 'code-session-structure-preview',
              ownerUserId: 'web-user',
              ownerPrincipalId: 'owner-principal',
              title: 'Structure Preview Test',
              workspaceRoot,
              resolvedRoot: workspaceRoot,
              agentId: 'agent-1',
              status: 'active',
              attachmentPolicy: 'same_principal',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              lastActivityAt: Date.now(),
              conversationUserId: 'web-user',
              conversationChannel: 'code-session',
              uiState: {
                currentDirectory: workspaceRoot,
                selectedFilePath: sourcePath,
                showDiff: false,
                expandedDirs: [],
                terminalCollapsed: false,
                terminalTabs: [],
              },
              workState: {
                focusSummary: '',
                planSummary: '',
                compactedSummary: '',
                workspaceProfile: null,
                workspaceTrust: null,
                workspaceTrustReview: null,
                workspaceMap: null,
                workingSet: null,
                activeSkills: [],
                pendingApprovals: [],
                recentJobs: [],
                changedFiles: [],
                verification: [],
              },
            },
            history: [],
            attachments: [],
          }),
        };

        web = new WebChannel({ port: 18977, authToken: TEST_TOKEN, dashboard });
        await web.start(async () => ({ content: 'ok' }));

        const res = await fetch('http://localhost:18977/api/code/sessions/code-session-structure-preview/structure-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            path: sourcePath,
            content: 'export function getAnswer(seed: number) {\n  return seed + 1;\n}\n',
          }),
        });
        expect(res.status).toBe(200);
        const body = await res.json() as {
          success: boolean;
          path: string;
          symbols: Array<{ name: string; params: string[]; summary: string }>;
        };
        expect(body.success).toBe(true);
        expect(body.path).toBe('src/example.ts');
        expect(body.symbols[0]).toMatchObject({
          name: 'getAnswer',
          params: ['seed'],
          summary: expect.stringContaining('accepts 1 parameter (seed)'),
        });
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('GET /api/code/sessions/:id/structure should reject paths outside the workspace root', async () => {
      const workspaceRoot = join(process.cwd(), `__test_code_structure_denied_${randomUUID()}`);
      mkdirSync(workspaceRoot, { recursive: true });

      try {
        const dashboard: DashboardCallbacks = {
          ...mockDashboard,
          onCodeSessionGet: () => ({
            session: {
              id: 'code-session-structure-denied',
              ownerUserId: 'web-user',
              ownerPrincipalId: 'owner-principal',
              title: 'Structure Denied Test',
              workspaceRoot,
              resolvedRoot: workspaceRoot,
              agentId: 'agent-1',
              status: 'active',
              attachmentPolicy: 'same_principal',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              lastActivityAt: Date.now(),
              conversationUserId: 'web-user',
              conversationChannel: 'code-session',
              uiState: {
                currentDirectory: workspaceRoot,
                selectedFilePath: null,
                showDiff: false,
                expandedDirs: [],
                terminalCollapsed: false,
                terminalTabs: [],
              },
              workState: {
                focusSummary: '',
                planSummary: '',
                compactedSummary: '',
                workspaceProfile: null,
                workspaceTrust: null,
                workspaceTrustReview: null,
                workspaceMap: null,
                workingSet: null,
                activeSkills: [],
                pendingApprovals: [],
                recentJobs: [],
                changedFiles: [],
                verification: [],
              },
            },
            history: [],
            attachments: [],
          }),
        };

        web = new WebChannel({ port: 18976, authToken: TEST_TOKEN, dashboard });
        await web.start(async () => ({ content: 'ok' }));

        const res = await fetch('http://localhost:18976/api/code/sessions/code-session-structure-denied/structure?path=../outside.ts', {
          headers: authHeaders,
        });
        expect(res.status).toBe(403);
        const body = await res.json() as { success: boolean; error: string };
        expect(body.success).toBe(false);
        expect(body.error).toMatch(/coding session workspace/i);
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('GET /api/assistant/state should return orchestrator state', async () => {
      web = new WebChannel({ port: 18960, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18960/api/assistant/state', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        orchestrator: { summary: { totalRequests: number; sessionCount: number } };
        defaultProvider: string;
      };
      expect(body.defaultProvider).toBe('ollama');
      expect(body.orchestrator.summary.totalRequests).toBe(9);
      expect(body.orchestrator.summary.sessionCount).toBe(2);
    });

    it('POST /api/assistant/jobs/follow-up should forward operator actions for delegated jobs', async () => {
      let received: Record<string, unknown> | null = null;
      web = new WebChannel({
        port: 18961,
        authToken: TEST_TOKEN,
        dashboard: {
          onAssistantJobFollowUpAction: async (input) => {
            received = input as Record<string, unknown>;
            return {
              success: true,
              message: 'Replayed held delegated result.',
              details: {
                content: 'Held delegated output',
              },
            };
          },
        },
      });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18961/api/assistant/jobs/follow-up', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jobId: 'job-123',
          action: 'replay',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        success: boolean;
        message: string;
        details?: { content?: string };
      };
      expect(body).toMatchObject({
        success: true,
        message: 'Replayed held delegated result.',
        details: {
          content: 'Held delegated output',
        },
      });
      expect(received).toEqual({
        jobId: 'job-123',
        action: 'replay',
      });
    });

    it('GET /api/routing/trace should forward continuity and execution-ref filters', async () => {
      let receivedArgs: Record<string, unknown> | null = null;
      web = new WebChannel({
        port: 18980,
        authToken: TEST_TOKEN,
        dashboard: {
          onIntentRoutingTrace: async (args) => {
            receivedArgs = args as Record<string, unknown>;
            return { entries: [] };
          },
        },
      });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch(
        'http://localhost:18980/api/routing/trace?limit=7&continuityKey=continuity-1&activeExecutionRef=code_session%3ARepo%20Fix',
        { headers: authHeaders },
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { entries: unknown[] };
      expect(body.entries).toEqual([]);
      expect(receivedArgs).toEqual({
        limit: 7,
        continuityKey: 'continuity-1',
        activeExecutionRef: 'code_session:Repo Fix',
      });
    });

    it('GET /api/routing/trace should return matched run and code session links when provided', async () => {
      web = new WebChannel({
        port: 18978,
        authToken: TEST_TOKEN,
        dashboard: {
          onIntentRoutingTrace: async () => ({
            entries: [
              {
                id: 'route-1',
                timestamp: Date.now(),
                stage: 'dispatch_response',
                requestId: 'req-1',
                matchedRun: {
                  runId: 'req-1',
                  title: 'Fix repo',
                  status: 'completed',
                  kind: 'assistant_dispatch',
                  href: '#/automations?assistantRunId=req-1',
                  codeSessionId: 'session-1',
                  codeSessionHref: '#/code?sessionId=session-1&assistantRunId=req-1&assistantRunItemId=item-context',
                  focusItemId: 'item-context',
                  focusItemTitle: 'Assembled context',
                  focusItemHref: '#/automations?assistantRunId=req-1&assistantRunItemId=item-context',
                },
              },
            ],
          }),
        },
      });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18978/api/routing/trace?limit=1', { headers: authHeaders });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        entries: Array<{
          matchedRun?: {
            runId: string;
            codeSessionId?: string;
            codeSessionHref?: string;
            focusItemId?: string;
            focusItemHref?: string;
          };
        }>;
      };
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]?.matchedRun).toEqual({
        runId: 'req-1',
        title: 'Fix repo',
        status: 'completed',
        kind: 'assistant_dispatch',
        href: '#/automations?assistantRunId=req-1',
        codeSessionId: 'session-1',
        codeSessionHref: '#/code?sessionId=session-1&assistantRunId=req-1&assistantRunItemId=item-context',
        focusItemId: 'item-context',
        focusItemTitle: 'Assembled context',
        focusItemHref: '#/automations?assistantRunId=req-1&assistantRunItemId=item-context',
      });
    });

    it('GET /api/assistant/runs should forward continuity and execution-ref filters', async () => {
      let receivedArgs: Record<string, unknown> | null = null;
      web = new WebChannel({
        port: 18979,
        authToken: TEST_TOKEN,
        dashboard: {
          onAssistantRuns: (args) => {
            receivedArgs = args as Record<string, unknown>;
            return { runs: [] };
          },
        },
      });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch(
        'http://localhost:18979/api/assistant/runs?limit=5&continuityKey=continuity-1&activeExecutionRef=code_session%3ARepo%20Fix',
        { headers: authHeaders },
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { runs: unknown[] };
      expect(body.runs).toEqual([]);
      expect(receivedArgs).toEqual({
        limit: 5,
        continuityKey: 'continuity-1',
        activeExecutionRef: 'code_session:Repo Fix',
      });
    });

    it('GET /api/threat-intel/summary should return threat summary', async () => {
      web = new WebChannel({ port: 18958, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18958/api/threat-intel/summary', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as { enabled: boolean; findings: { highOrCritical: number } };
      expect(body.enabled).toBe(true);
      expect(body.findings.highOrCritical).toBe(1);
    });

    it('POST /api/threat-intel/scan should run scan callback', async () => {
      web = new WebChannel({ port: 18959, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18959/api/threat-intel/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ query: 'target-a' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; findings: unknown[] };
      expect(body.success).toBe(true);
      expect(body.findings.length).toBeGreaterThan(0);
    });

    it('GET /api/network/baseline should return baseline status', async () => {
      web = new WebChannel({ port: 18961, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18961/api/network/baseline', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as { baselineReady: boolean; snapshotCount: number };
      expect(body.baselineReady).toBe(true);
      expect(body.snapshotCount).toBe(4);
    });

    it('GET /api/network/threats should return active network alerts', async () => {
      web = new WebChannel({ port: 18962, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18962/api/network/threats?limit=10', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as { activeAlertCount: number; alerts: Array<{ id: string }> };
      expect(body.activeAlertCount).toBe(1);
      expect(body.alerts[0].id).toBe('net-alert-1');
    });

    it('POST /api/network/threats/ack should acknowledge alert', async () => {
      web = new WebChannel({ port: 18963, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18963/api/network/threats/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ alertId: 'net-alert-1' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toBe('acked:net-alert-1');
    });

    it('GET /api/security/alerts should return unified local security alerts', async () => {
      web = new WebChannel({ port: 18969, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18969/api/security/alerts?source=network&severity=medium&limit=10', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        totalMatches: number;
        searchedSources: string[];
        alerts: Array<{ id: string; source: string; subject: string }>;
      };
      expect(body.totalMatches).toBe(1);
      expect(body.searchedSources).toEqual(['network']);
      expect(body.alerts[0].id).toBe('net-alert-1');
      expect(body.alerts[0].subject).toBe('192.168.1.25');
    });

    it('POST /api/security/alerts/ack should acknowledge unified security alerts', async () => {
      web = new WebChannel({ port: 18970, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18970/api/security/alerts/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ alertId: 'net-alert-1', source: 'network' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; message: string; source: string };
      expect(body.success).toBe(true);
      expect(body.message).toBe('security-acked:network:net-alert-1');
      expect(body.source).toBe('network');
    });

    it('GET /api/security/posture should return advisory posture', async () => {
      web = new WebChannel({ port: 18971, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18971/api/security/posture?profile=personal&currentMode=monitor', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        recommendedMode: string;
        shouldEscalate: boolean;
        summary: string;
      };
      expect(body.recommendedMode).toBe('guarded');
      expect(body.shouldEscalate).toBe(true);
      expect(body.summary).toContain("Escalate from 'monitor' to 'guarded'");
    });

    it('GET /api/security/posture should validate query parameters', async () => {
      web = new WebChannel({ port: 18972, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18972/api/security/posture?profile=invalid', { headers: authHeaders });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('profile must be one of');
    });

    it('GET /api/security/activity should return persisted agentic security activity', async () => {
      web = new WebChannel({ port: 18974, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18974/api/security/activity?status=completed&agentId=security-triage&limit=10', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        totalMatches: number;
        entries: Array<{ status: string; targetAgentId?: string; summary: string }>;
        byStatus: Record<string, number>;
      };
      expect(body.totalMatches).toBe(1);
      expect(body.entries[0]?.status).toBe('completed');
      expect(body.entries[0]?.targetAgentId).toBe('security-triage');
      expect(body.byStatus.completed).toBe(1);
    });

    it('GET /api/windows-defender/status should return native provider status', async () => {
      web = new WebChannel({ port: 18973, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18973/api/windows-defender/status', { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json() as { status: { provider: string; supported: boolean }; alerts: Array<{ id: string }> };
      expect(body.status.provider).toBe('windows_defender');
      expect(body.status.supported).toBe(true);
      expect(body.alerts[0].id).toBe('wd-1');
    });

    it('POST /api/windows-defender/scan should validate scan payload and call the dashboard action', async () => {
      web = new WebChannel({ port: 18974, authToken: TEST_TOKEN, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18974/api/windows-defender/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ type: 'quick' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toBe('scan:quick');
    });

    it('should return 404 when dashboard callback is not set', async () => {
      web = new WebChannel({ port: 18949, authToken: TEST_TOKEN, dashboard: {} });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18949/api/agents', { headers: authHeaders });
      expect(res.status).toBe(404);
    });

    it('should require auth for dashboard endpoints when authToken is set', async () => {
      web = new WebChannel({ port: 18950, authToken: 'test-token', dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      // No auth → 401
      const res1 = await fetch('http://localhost:18950/api/agents');
      expect(res1.status).toBe(401);

      // With auth → 200
      const res2 = await fetch('http://localhost:18950/api/agents', {
        headers: { Authorization: 'Bearer test-token' },
      });
      expect(res2.status).toBe(200);
    });

    it('POST /api/message with agentId should use onDispatch and forward requestId', async () => {
      const dispatched: Array<{ agentId: string; content: string; requestId?: string }> = [];
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
        onDispatch: async (agentId, msg, _routeDecision, options) => {
          dispatched.push({ agentId, content: msg.content, requestId: options?.requestId });
          return { content: `Reply from ${agentId}` };
        },
      };

      web = new WebChannel({ port: 18951, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'fallback' }));

      const res = await fetch('http://localhost:18951/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ content: 'Hello', agentId: 'agent-1', requestId: 'req-message-1' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { content: string };
      expect(body.content).toBe('Reply from agent-1');
      expect(dispatched.length).toBe(1);
      expect(dispatched[0].agentId).toBe('agent-1');
      expect(dispatched[0].requestId).toBe('req-message-1');
    });

    it('POST /api/tools/run forwards surfaceId to onToolsRun', async () => {
      const calls: Array<{ toolName: string; userId?: string; surfaceId?: string; channel?: string }> = [];
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
        onToolsRun: async (input) => {
          calls.push({
            toolName: input.toolName,
            userId: input.userId,
            surfaceId: input.surfaceId,
            channel: input.channel,
          });
          return {
            success: true,
            status: 'succeeded',
            jobId: 'job-tools-run',
            message: 'ok',
            output: { ok: true },
          };
        },
      };

      web = new WebChannel({ port: 18970, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'fallback' }));

      const res = await fetch('http://localhost:18970/api/tools/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          toolName: 'code_session_current',
          userId: 'web-user',
          channel: 'web',
          surfaceId: 'web-guardian-chat',
        }),
      });

      expect(res.status).toBe(200);
      expect(calls).toEqual([{
        toolName: 'code_session_current',
        userId: 'web-user',
        surfaceId: 'web-guardian-chat',
        channel: 'web',
      }]);
    });

    it('POST /api/tools/approvals/decision forwards surface identity to onToolsApprovalDecision', async () => {
      const calls: Array<{ approvalId: string; userId?: string; channel?: string; surfaceId?: string }> = [];
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
        onToolsApprovalDecision: async (input) => {
          calls.push({
            approvalId: input.approvalId,
            userId: input.userId,
            channel: input.channel,
            surfaceId: input.surfaceId,
          });
          return { success: true, message: 'Approved.' };
        },
      };

      web = new WebChannel({ port: 18978, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'fallback' }));

      const res = await fetch('http://localhost:18978/api/tools/approvals/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          approvalId: 'approval-memory-1',
          decision: 'approved',
          userId: 'web-user',
          channel: 'web',
          surfaceId: 'web-guardian-chat',
        }),
      });

      expect(res.status).toBe(200);
      expect(calls).toEqual([{
        approvalId: 'approval-memory-1',
        userId: 'web-user',
        channel: 'web',
        surfaceId: 'web-guardian-chat',
      }]);
    });

    it('GET /api/chat/pending-action returns the current surface-scoped pending action', async () => {
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
        onPendingActionCurrent: ({ userId, channel, surfaceId }) => ({
          pendingAction: {
            status: 'pending',
            blocker: {
              kind: 'approval',
              approvalSummaries: [{ id: 'approval-1', toolName: 'update_tool_policy', argsPreview: 'add S:\\Temp' }],
            },
            scope: { userId, channel, surfaceId },
          },
        }),
      };

      web = new WebChannel({ port: 18979, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'fallback' }));

      const res = await fetch('http://localhost:18979/api/chat/pending-action?userId=web-user&channel=web&surfaceId=web-guardian-chat', {
        headers: authHeaders,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { pendingAction?: { blocker?: { kind?: string; approvalSummaries?: Array<{ id: string }> } } };
      expect(body.pendingAction?.blocker?.kind).toBe('approval');
      expect(body.pendingAction?.blocker?.approvalSummaries?.[0]?.id).toBe('approval-1');
    });

    it('GET /api/chat/pending-action returns 404 when the callback is unavailable', async () => {
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
      };
      delete dashboard.onPendingActionCurrent;

      web = new WebChannel({ port: 18980, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'fallback' }));

      const res = await fetch('http://localhost:18980/api/chat/pending-action?userId=web-user&channel=web&surfaceId=web-guardian-chat', {
        headers: authHeaders,
      });

      expect(res.status).toBe(404);
    });

    it('GET /api/chat/pending-action requires auth', async () => {
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
        onPendingActionCurrent: () => ({ pendingAction: null }),
      };

      web = new WebChannel({ port: 18981, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'fallback' }));

      const res = await fetch('http://localhost:18981/api/chat/pending-action?userId=web-user&channel=web&surfaceId=web-guardian-chat');
      expect(res.status).toBe(401);
    });

    it('POST /api/message/stream rejects non-string content', async () => {
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
        onStreamDispatch: async () => ({ requestId: 'req-1', runId: 'req-1', content: 'Reply from stream' }),
      };

      web = new WebChannel({ port: 18968, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'fallback' }));

      const res = await fetch('http://localhost:18968/api/message/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ content: 123, agentId: 'agent-1' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('content is required');
    });

    it('POST /api/message/stream forwards requestId, surfaceId, and allows default routing', async () => {
      const calls: Array<{ agentId?: string; requestId?: string; content: string; surfaceId?: string }> = [];
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
        onStreamDispatch: async (agentId, message) => {
          calls.push({
            agentId,
            requestId: message.requestId,
            content: message.content,
            surfaceId: message.surfaceId,
          });
          return { requestId: message.requestId || 'req-fallback', runId: message.requestId || 'req-fallback', content: 'Reply from stream' };
        },
      };

      web = new WebChannel({ port: 18969, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'fallback' }));

      const res = await fetch('http://localhost:18969/api/message/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ content: 'Hello', requestId: 'req-stream-1', surfaceId: 'web-guardian-chat' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { requestId: string; runId: string; content: string };
      expect(body.requestId).toBe('req-stream-1');
      expect(body.runId).toBe('req-stream-1');
      expect(body.content).toBe('Reply from stream');
      expect(calls).toEqual([{
        agentId: undefined,
        requestId: 'req-stream-1',
        content: 'Hello',
        surfaceId: 'web-guardian-chat',
      }]);
    });

    it('POST /api/message/cancel forwards request cancel requests', async () => {
      const calls: Array<{ requestId: string; userId?: string; channel?: string; agentId?: string; reason?: string }> = [];
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
        onStreamCancel: async (input) => {
          calls.push({
            requestId: input.requestId,
            userId: input.userId,
            channel: input.channel,
            agentId: input.agentId,
            reason: input.reason,
          });
          return {
            success: true,
            canceled: true,
            message: 'Request canceled by operator.',
            requestId: input.requestId,
            runId: input.requestId,
            errorCode: 'REQUEST_CANCELED',
          };
        },
      };

      web = new WebChannel({ port: 19020, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'fallback' }));

      const res = await fetch('http://localhost:19020/api/message/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          requestId: 'req-stream-1',
          userId: 'web-user',
          channel: 'web',
          agentId: 'agent-1',
          reason: 'Stop requested',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; canceled: boolean; requestId: string; errorCode?: string };
      expect(body.success).toBe(true);
      expect(body.canceled).toBe(true);
      expect(body.requestId).toBe('req-stream-1');
      expect(body.errorCode).toBe('REQUEST_CANCELED');
      expect(calls).toEqual([{
        requestId: 'req-stream-1',
        userId: 'web-user',
        channel: 'web',
        agentId: 'agent-1',
        reason: 'Stop requested',
      }]);
    });

    it('POST /api/message/cancel returns 404 when callback is unavailable', async () => {
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
      };
      delete dashboard.onStreamCancel;

      web = new WebChannel({ port: 19021, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'fallback' }));

      const res = await fetch('http://localhost:19021/api/message/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ requestId: 'req-stream-1' }),
      });

      expect(res.status).toBe(404);
    });

    it('does not expose internal error details from dashboard callbacks', async () => {
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
        onConfigUpdate: async () => {
          throw new Error('stack trace detail: secret-token');
        },
      };

      web = new WebChannel({ port: 18964, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18964/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ defaultProvider: 'ollama' }),
      });

      expect(res.status).toBe(500);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Update failed');
      expect(body.error).not.toContain('secret-token');
    });
  });

  // ─── SSE ─────────────────────────────────────────────────────

  describe('SSE', () => {
    it('GET /sse should establish event stream', async () => {
      let listenerFn: ((event: { type: string; data: unknown }) => void) | null = null;
      const dashboard: DashboardCallbacks = {
        onSSESubscribe: (listener) => {
          listenerFn = listener;
          return () => { listenerFn = null; };
        },
      };

      web = new WebChannel({ port: 18952, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'ok' }));

      const controller = new AbortController();
      const res = await fetch('http://localhost:18952/sse', { signal: controller.signal, headers: authHeaders });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');

      // Cleanup
      controller.abort();
      await new Promise(r => setTimeout(r, 50));
    });

    it('GET /sse should require auth via bearer header or session cookie', async () => {
      const dashboard: DashboardCallbacks = {
        onSSESubscribe: (listener) => () => {},
      };

      web = new WebChannel({ port: 18953, authToken: 'sse-token', dashboard });
      await web.start(async () => ({ content: 'ok' }));

      // No token → 401
      const res1 = await fetch('http://localhost:18953/sse');
      expect(res1.status).toBe(401);

      // Query token is no longer accepted for SSE auth.
      const res2 = await fetch('http://localhost:18953/sse?token=sse-token');
      expect(res2.status).toBe(401);

      // Bearer header → 200
      const controller = new AbortController();
      const res3 = await fetch('http://localhost:18953/sse', {
        signal: controller.signal,
        headers: { Authorization: 'Bearer sse-token' },
      });
      expect(res3.status).toBe(200);
      controller.abort();
      await new Promise(r => setTimeout(r, 50));
    });

    it('WebChannel.send should emit assistant.notice over SSE', async () => {
      const dashboard: DashboardCallbacks = {
        onSSESubscribe: () => () => {},
      };

      web = new WebChannel({ port: 18967, authToken: TEST_TOKEN, dashboard });
      await web.start(async () => ({ content: 'ok' }));

      const controller = new AbortController();
      const res = await fetch('http://localhost:18967/sse', {
        signal: controller.signal,
        headers: authHeaders,
      });

      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      expect(reader).toBeDefined();

      const firstChunk = await reader!.read();
      const firstPayload = new TextDecoder().decode(firstChunk.value);
      expect(firstPayload).toContain(':connected');

      await web.send('owner', 'Scheduled assistant report');

      const chunk = await reader!.read();
      const payload = new TextDecoder().decode(chunk.value);
      expect(payload).toContain('event: assistant.notice');
      expect(payload).toContain('Scheduled assistant report');

      controller.abort();
      await new Promise(r => setTimeout(r, 50));
    });
  });

  // ─── Static File Serving ──────────────────────────────────

  describe('Static file serving', () => {
    const tmpDir = join(process.cwd(), '__test_static__');

    // Set up temp static directory
    const setup = () => {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(join(tmpDir, 'index.html'), '<html><body>Dashboard</body></html>');
      writeFileSync(join(tmpDir, 'test.css'), 'body { color: red; }');
    };

    const cleanup = () => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    };

    it('should serve static files', async () => {
      setup();
      try {
        web = new WebChannel({ port: 18954, authToken: TEST_TOKEN, staticDir: tmpDir });
        await web.start(async () => ({ content: 'ok' }));

        const res = await fetch('http://localhost:18954/test.css');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/css');
        const text = await res.text();
        expect(text).toContain('color: red');
      } finally {
        cleanup();
      }
    });

    it('should serve index.html for root', async () => {
      setup();
      try {
        web = new WebChannel({ port: 18955, authToken: TEST_TOKEN, staticDir: tmpDir });
        await web.start(async () => ({ content: 'ok' }));

        const res = await fetch('http://localhost:18955/');
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('Dashboard');
      } finally {
        cleanup();
      }
    });

    it('should fallback to index.html for SPA routes', async () => {
      setup();
      try {
        web = new WebChannel({ port: 18956, authToken: TEST_TOKEN, staticDir: tmpDir });
        await web.start(async () => ({ content: 'ok' }));

        // Path without extension should serve index.html (SPA fallback)
        const res = await fetch('http://localhost:18956/dashboard');
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('Dashboard');
      } finally {
        cleanup();
      }
    });

    it('should not serve static files from outside staticDir (path traversal)', async () => {
      setup();
      try {
        web = new WebChannel({ port: 18957, authToken: TEST_TOKEN, staticDir: tmpDir });
        await web.start(async () => ({ content: 'ok' }));

        const res = await fetch('http://localhost:18957/../../../etc/passwd');
        // Should get 404 or index.html fallback, not the file
        expect(res.status).toBe(200); // SPA fallback
        const text = await res.text();
        expect(text).toContain('Dashboard'); // served index.html, not /etc/passwd
      } finally {
        cleanup();
      }
    });
  });
});
