import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { CLIChannel } from './cli.js';
import type { AgentInfo, RuntimeStatus } from './cli.js';
import { WebChannel } from './web.js';
import type { DashboardCallbacks, DashboardAgentInfo, DashboardAgentDetail } from './web-types.js';
import type { UserMessage, AgentResponse } from '../agent/types.js';
import { randomUUID } from 'node:crypto';

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

  it('/playbooks run should execute playbook via callback', async () => {
    const { input, output, cli } = makeCli({
      onConnectorsState: () => ({
        summary: {
          enabled: true,
          executionMode: 'plan_then_execute',
          maxConnectorCallsPerRun: 12,
          packCount: 1,
          enabledPackCount: 1,
          playbookCount: 1,
          enabledPlaybookCount: 1,
          runCount: 0,
          dryRunQualifiedCount: 0,
        },
        packs: [],
        playbooks: [{
          id: 'infra-audit',
          name: 'Infra Audit',
          enabled: true,
          mode: 'sequential',
          steps: [{
            id: 'step-1',
            packId: 'infra-core',
            toolName: 'fs_list',
          }],
        }],
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
          mode: 'builder',
          requirePrivilegedTicket: true,
        },
      }),
      onPlaybookRun: async ({ playbookId, dryRun }) => ({
        success: true,
        status: 'succeeded',
        message: `${playbookId} ${dryRun ? 'dry' : 'live'} run complete`,
        run: {
          id: 'run-1',
          playbookId,
          playbookName: 'Infra Audit',
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

    await sendCommand(input, '/playbooks run infra-audit --dry-run');
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

  it('/config set default <provider> should update config', async () => {
    const updates: unknown[] = [];
    const { input, output, cli } = makeCli({
      onConfigUpdate: async (u) => {
        updates.push(u);
        return { success: true, message: 'Config saved.' };
      },
    });
    await cli.start(async () => ({ content: 'ok' }));

    await sendCommand(input, '/config set default claude');
    const text = readOutput(output);

    expect(text).toContain('OK');
    expect(text).toContain('Config saved');
    expect(updates.length).toBe(1);
    expect((updates[0] as { defaultProvider: string }).defaultProvider).toBe('claude');

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
  let web: WebChannel | null = null;

  afterEach(async () => {
    if (web) {
      await web.stop();
      web = null;
    }
  });

  it('should start and stop a server', async () => {
    web = new WebChannel({ port: 0 }); // port 0 = random

    // For testing, we need a valid port. Use a high port.
    web = new WebChannel({ port: 18923 });

    const handler = async (_msg: UserMessage): Promise<AgentResponse> => {
      return { content: 'response' };
    };

    await web.start(handler);
    await web.stop();
    web = null;
  });

  it('should respond to health check', async () => {
    web = new WebChannel({ port: 18924 });

    await web.start(async () => ({ content: 'ok' }));

    const res = await fetch('http://localhost:18924/health');
    const body = await res.json() as { status: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
  });

  it('should handle POST /api/message', async () => {
    web = new WebChannel({ port: 18925 });
    const received: UserMessage[] = [];

    await web.start(async (msg) => {
      received.push(msg);
      return { content: `Echo: ${msg.content}` };
    });

    const res = await fetch('http://localhost:18925/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Hello' }),
    });

    const body = await res.json() as { content: string };

    expect(res.status).toBe(200);
    expect(body.content).toBe('Echo: Hello');
    expect(received.length).toBe(1);
  });

  it('should return 400 for missing content', async () => {
    web = new WebChannel({ port: 18926 });

    await web.start(async () => ({ content: 'ok' }));

    const res = await fetch('http://localhost:18926/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('should return 404 for unknown routes', async () => {
    web = new WebChannel({ port: 18927 });

    await web.start(async () => ({ content: 'ok' }));

    const res = await fetch('http://localhost:18927/unknown');
    expect(res.status).toBe(404);
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
  });

  describe('Fix #4: CORS origin allowlist', () => {
    it('should not set Access-Control-Allow-Origin when no origins configured', async () => {
      web = new WebChannel({ port: 18934 });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18934/health', {
        headers: { Origin: 'https://evil.com' },
      });
      expect(res.status).toBe(200);
      // No ACAO header since origin is not in allowed list
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('should reflect allowed origin', async () => {
      web = new WebChannel({ port: 18935, allowedOrigins: ['https://myapp.com'] });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18935/health', {
        headers: { Origin: 'https://myapp.com' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('https://myapp.com');
    });

    it('should reject disallowed origin', async () => {
      web = new WebChannel({ port: 18936, allowedOrigins: ['https://myapp.com'] });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18936/health', {
        headers: { Origin: 'https://evil.com' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('Fix #4: Request body size limit', () => {
    it('should reject oversized request body', async () => {
      web = new WebChannel({ port: 18937, maxBodyBytes: 100 });
      await web.start(async () => ({ content: 'ok' }));

      const largeContent = 'x'.repeat(200);
      // Server destroys the socket mid-stream, so fetch may get a socket error
      // or a 413 response depending on timing. Either outcome means the body was rejected.
      try {
        const res = await fetch('http://localhost:18937/api/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
      web = new WebChannel({ port: 18938, maxBodyBytes: 10000 });
      await web.start(async (msg) => ({ content: `Echo: ${msg.content}` }));

      const res = await fetch('http://localhost:18938/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'small' }),
      });
      expect(res.status).toBe(200);
    });

    it('should return 400 for invalid JSON', async () => {
      web = new WebChannel({ port: 18939 });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18939/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    };

    it('GET /api/agents should return agent list', async () => {
      web = new WebChannel({ port: 18940, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18940/api/agents');
      expect(res.status).toBe(200);
      const body = await res.json() as DashboardAgentInfo[];
      expect(body.length).toBe(2);
      expect(body[0].id).toBe('agent-1');
      expect(body[1].state).toBe('running');
    });

    it('GET /api/agents/:id should return agent detail', async () => {
      web = new WebChannel({ port: 18941, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18941/api/agents/agent-1');
      expect(res.status).toBe(200);
      const body = await res.json() as DashboardAgentDetail;
      expect(body.id).toBe('agent-1');
      expect(body.resourceLimits.maxInvocationBudgetMs).toBe(120000);
    });

    it('GET /api/agents/:id should return 404 for unknown agent', async () => {
      web = new WebChannel({ port: 18942, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18942/api/agents/unknown-agent');
      expect(res.status).toBe(404);
    });

    it('GET /api/audit should return filtered events', async () => {
      web = new WebChannel({ port: 18943, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18943/api/audit?type=action_denied&limit=10');
      expect(res.status).toBe(200);
      const body = await res.json() as unknown[];
      expect(body.length).toBeGreaterThan(0);
    });

    it('GET /api/audit/summary should return summary', async () => {
      web = new WebChannel({ port: 18944, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18944/api/audit/summary?windowMs=60000');
      expect(res.status).toBe(200);
      const body = await res.json() as { totalEvents: number };
      expect(body.totalEvents).toBe(5);
    });

    it('GET /api/config should return redacted config', async () => {
      web = new WebChannel({ port: 18945, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18945/api/config');
      expect(res.status).toBe(200);
      const body = await res.json() as { defaultProvider: string; llm: Record<string, unknown> };
      expect(body.defaultProvider).toBe('ollama');
      // Should not contain apiKey
      const ollamaConfig = body.llm['ollama'] as Record<string, unknown>;
      expect(ollamaConfig).not.toHaveProperty('apiKey');
    });

    it('GET /api/budget should return budget info', async () => {
      web = new WebChannel({ port: 18946, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18946/api/budget');
      expect(res.status).toBe(200);
      const body = await res.json() as { agents: unknown[] };
      expect(body.agents.length).toBe(1);
    });

    it('GET /api/watchdog should return watchdog results', async () => {
      web = new WebChannel({ port: 18947, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18947/api/watchdog');
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ agentId: string; action: string }>;
      expect(body[0].agentId).toBe('agent-1');
      expect(body[0].action).toBe('ok');
    });

    it('GET /api/providers should return provider list', async () => {
      web = new WebChannel({ port: 18948, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18948/api/providers');
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ name: string; type: string }>;
      expect(body[0].name).toBe('ollama');
    });

    it('GET /api/assistant/state should return orchestrator state', async () => {
      web = new WebChannel({ port: 18960, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18960/api/assistant/state');
      expect(res.status).toBe(200);
      const body = await res.json() as {
        orchestrator: { summary: { totalRequests: number; sessionCount: number } };
        defaultProvider: string;
      };
      expect(body.defaultProvider).toBe('ollama');
      expect(body.orchestrator.summary.totalRequests).toBe(9);
      expect(body.orchestrator.summary.sessionCount).toBe(2);
    });

    it('GET /api/threat-intel/summary should return threat summary', async () => {
      web = new WebChannel({ port: 18958, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18958/api/threat-intel/summary');
      expect(res.status).toBe(200);
      const body = await res.json() as { enabled: boolean; findings: { highOrCritical: number } };
      expect(body.enabled).toBe(true);
      expect(body.findings.highOrCritical).toBe(1);
    });

    it('POST /api/threat-intel/scan should run scan callback', async () => {
      web = new WebChannel({ port: 18959, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18959/api/threat-intel/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'target-a' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; findings: unknown[] };
      expect(body.success).toBe(true);
      expect(body.findings.length).toBeGreaterThan(0);
    });

    it('GET /api/network/baseline should return baseline status', async () => {
      web = new WebChannel({ port: 18961, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18961/api/network/baseline');
      expect(res.status).toBe(200);
      const body = await res.json() as { baselineReady: boolean; snapshotCount: number };
      expect(body.baselineReady).toBe(true);
      expect(body.snapshotCount).toBe(4);
    });

    it('GET /api/network/threats should return active network alerts', async () => {
      web = new WebChannel({ port: 18962, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18962/api/network/threats?limit=10');
      expect(res.status).toBe(200);
      const body = await res.json() as { activeAlertCount: number; alerts: Array<{ id: string }> };
      expect(body.activeAlertCount).toBe(1);
      expect(body.alerts[0].id).toBe('net-alert-1');
    });

    it('POST /api/network/threats/ack should acknowledge alert', async () => {
      web = new WebChannel({ port: 18963, dashboard: mockDashboard });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18963/api/network/threats/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'net-alert-1' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toBe('acked:net-alert-1');
    });

    it('should return 404 when dashboard callback is not set', async () => {
      web = new WebChannel({ port: 18949, dashboard: {} });
      await web.start(async () => ({ content: 'ok' }));

      const res = await fetch('http://localhost:18949/api/agents');
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

    it('POST /api/message with agentId should use onDispatch', async () => {
      const dispatched: Array<{ agentId: string; content: string }> = [];
      const dashboard: DashboardCallbacks = {
        ...mockDashboard,
        onDispatch: async (agentId, msg) => {
          dispatched.push({ agentId, content: msg.content });
          return { content: `Reply from ${agentId}` };
        },
      };

      web = new WebChannel({ port: 18951, dashboard });
      await web.start(async () => ({ content: 'fallback' }));

      const res = await fetch('http://localhost:18951/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello', agentId: 'agent-1' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { content: string };
      expect(body.content).toBe('Reply from agent-1');
      expect(dispatched.length).toBe(1);
      expect(dispatched[0].agentId).toBe('agent-1');
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

      web = new WebChannel({ port: 18952, dashboard });
      await web.start(async () => ({ content: 'ok' }));

      const controller = new AbortController();
      const res = await fetch('http://localhost:18952/sse', { signal: controller.signal });

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
        web = new WebChannel({ port: 18954, staticDir: tmpDir });
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
        web = new WebChannel({ port: 18955, staticDir: tmpDir });
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
        web = new WebChannel({ port: 18956, staticDir: tmpDir });
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
        web = new WebChannel({ port: 18957, staticDir: tmpDir });
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
