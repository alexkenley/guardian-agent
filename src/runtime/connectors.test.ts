import { describe, it, expect, vi } from 'vitest';
import { ConnectorPlaybookService } from './connectors.js';
import type { AssistantConnectorsConfig } from '../config/types.js';
import type { ToolExecutionRequest, ToolRunResponse } from '../tools/types.js';

function makeConfig(): AssistantConnectorsConfig {
  return {
    enabled: true,
    executionMode: 'plan_then_execute',
    maxConnectorCallsPerRun: 10,
    packs: [
      {
        id: 'infra-core',
        name: 'Infrastructure Core',
        enabled: true,
        allowedCapabilities: ['filesystem.read', 'network.http', 'shell.execute'],
        allowedHosts: ['localhost', 'example.com'],
        allowedPaths: ['./workspace', './docs'],
        allowedCommands: ['echo', 'ssh'],
        authMode: 'oauth2',
        requireHumanApprovalForWrites: true,
      },
    ],
    playbooks: {
      definitions: [
        {
          id: 'infra-audit',
          name: 'Infra Audit',
          enabled: true,
          mode: 'sequential',
          signature: 'signed-v1',
          steps: [
            {
              id: 'list-docs',
              packId: 'infra-core',
              toolName: 'fs_list',
              args: { path: './docs' },
            },
          ],
        },
      ],
      enabled: true,
      maxSteps: 10,
      maxParallelSteps: 3,
      defaultStepTimeoutMs: 5000,
      requireSignedDefinitions: true,
      requireDryRunOnFirstExecution: true,
    },
    studio: {
      enabled: true,
      mode: 'builder',
      requirePrivilegedTicket: true,
    },
  };
}

describe('ConnectorPlaybookService', () => {
  it('returns connector state summary', () => {
    const service = new ConnectorPlaybookService({
      config: makeConfig(),
      runTool: async () => ({ success: true, status: 'succeeded', jobId: 'job-1', message: 'ok' }),
    });
    const state = service.getState(20);
    expect(state.summary.enabled).toBe(true);
    expect(state.summary.packCount).toBe(1);
    expect(state.summary.playbookCount).toBe(1);
    expect(state.playbooks[0].id).toBe('infra-audit');
  });

  it('requires dry-run before live execution when configured', async () => {
    const runTool = vi.fn(async (): Promise<ToolRunResponse> => ({
      success: true,
      status: 'succeeded',
      jobId: 'job-1',
      message: 'ok',
    }));
    const service = new ConnectorPlaybookService({ config: makeConfig(), runTool });

    const live = await service.runPlaybook({
      playbookId: 'infra-audit',
      dryRun: false,
      origin: 'cli',
    });
    expect(live.success).toBe(false);
    expect(live.status).toBe('failed');
    expect(live.message).toContain('requires a successful dry-run');

    const dryRun = await service.runPlaybook({
      playbookId: 'infra-audit',
      dryRun: true,
      origin: 'cli',
    });
    expect(dryRun.success).toBe(true);

    const liveAfterDryRun = await service.runPlaybook({
      playbookId: 'infra-audit',
      dryRun: false,
      origin: 'cli',
    });
    expect(liveAfterDryRun.success).toBe(true);
    expect(runTool).toHaveBeenCalledTimes(2);
  });

  it('runs playbook steps through ToolExecutor callback', async () => {
    const calls: ToolExecutionRequest[] = [];
    const service = new ConnectorPlaybookService({
      config: makeConfig(),
      runTool: async (request) => {
        calls.push(request);
        return { success: true, status: 'succeeded', jobId: 'job-1', message: 'ok' };
      },
    });

    const result = await service.runPlaybook({
      playbookId: 'infra-audit',
      dryRun: true,
      origin: 'web',
      userId: 'tester',
      channel: 'web',
    });
    expect(result.success).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].toolName).toBe('fs_list');
    expect(calls[0].dryRun).toBe(true);
  });

  it('blocks host/path/command violations at pack boundary', async () => {
    const config = makeConfig();
    config.playbooks.requireDryRunOnFirstExecution = false;
    config.playbooks.definitions = [
      {
        id: 'violations',
        name: 'Violations',
        enabled: true,
        mode: 'sequential',
        signature: 'signed-v1',
        steps: [
          { id: 'bad-path', packId: 'infra-core', toolName: 'fs_read', args: { path: '../secret' } },
          { id: 'bad-url', packId: 'infra-core', toolName: 'http_fetch', args: { url: 'https://evil.com/x' } },
          { id: 'bad-cmd', packId: 'infra-core', toolName: 'shell_safe', args: { command: 'rm -rf /' } },
        ],
      },
    ];

    const service = new ConnectorPlaybookService({
      config,
      runTool: async () => ({ success: true, status: 'succeeded', jobId: 'job-1', message: 'ok' }),
    });

    const result = await service.runPlaybook({
      playbookId: 'violations',
      origin: 'cli',
      dryRun: true,
    });
    expect(result.success).toBe(false);
    expect(result.run.steps[0].status).toBe('failed');
    expect(result.run.steps[0].message).toContain('outside the allowed paths for this access profile');
  });

  it('propagates pending approvals from tool executor', async () => {
    const config = makeConfig();
    config.playbooks.requireDryRunOnFirstExecution = false;
    const service = new ConnectorPlaybookService({
      config,
      runTool: async () => ({
        success: false,
        status: 'pending_approval',
        jobId: 'job-123',
        approvalId: 'approval-123',
        message: 'Needs approval',
      }),
    });

    const result = await service.runPlaybook({
      playbookId: 'infra-audit',
      origin: 'web',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('awaiting_approval');
    expect(result.run.steps[0].status).toBe('pending_approval');
    expect(result.run.steps[0].approvalId).toBe('approval-123');
  });

  it('treats default packId as built-in tool access', async () => {
    const config = makeConfig();
    config.playbooks.requireDryRunOnFirstExecution = false;
    config.playbooks.definitions = [
      {
        id: 'built-in-tool',
        name: 'Built-in Tool',
        enabled: true,
        mode: 'sequential',
        signature: 'signed-v1',
        steps: [
          { id: 'arp-scan', packId: 'default', toolName: 'net_arp_scan', args: {} },
        ],
      },
    ];

    const runTool = vi.fn(async (): Promise<ToolRunResponse> => ({
      success: true,
      status: 'succeeded',
      jobId: 'job-arp',
      message: 'scan complete',
    }));
    const service = new ConnectorPlaybookService({ config, runTool });

    const result = await service.runPlaybook({
      playbookId: 'built-in-tool',
      origin: 'web',
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(result.run.steps[0].packId).toBe('');
    expect(result.run.steps[0].message).toBe('scan complete');
  });

  it('treats blank packId as built-in tool access', async () => {
    const config = makeConfig();
    config.playbooks.requireDryRunOnFirstExecution = false;
    config.playbooks.definitions = [
      {
        id: 'blank-pack',
        name: 'Blank Pack',
        enabled: true,
        mode: 'sequential',
        signature: 'signed-v1',
        steps: [
          { id: 'arp-scan', packId: '', toolName: 'net_arp_scan', args: {} },
        ],
      },
    ];

    const runTool = vi.fn(async (): Promise<ToolRunResponse> => ({
      success: true,
      status: 'succeeded',
      jobId: 'job-arp',
      message: 'scan complete',
    }));
    const service = new ConnectorPlaybookService({ config, runTool });

    const result = await service.runPlaybook({
      playbookId: 'blank-pack',
      origin: 'web',
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(result.run.steps[0].packId).toBe('');
  });
});
