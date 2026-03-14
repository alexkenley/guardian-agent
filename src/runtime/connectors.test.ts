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

  // ─── Instruction step tests ─────────────────────────────

  it('executes instruction step with prior results as context', async () => {
    const config = makeConfig();
    config.playbooks.requireDryRunOnFirstExecution = false;
    config.playbooks.requireSignedDefinitions = false;
    config.playbooks.definitions = [
      {
        id: 'instruction-pipeline',
        name: 'Instruction Pipeline',
        enabled: true,
        mode: 'sequential',
        steps: [
          { id: 'fetch-data', packId: '', toolName: 'fs_list', args: { path: './docs' } },
          {
            id: 'summarize',
            type: 'instruction',
            packId: '',
            toolName: '',
            instruction: 'Summarize the files listed above.',
          },
        ],
      },
    ];

    const runTool = vi.fn(async (): Promise<ToolRunResponse> => ({
      success: true,
      status: 'succeeded',
      jobId: 'job-1',
      message: 'ok',
      output: ['file1.md', 'file2.md'],
    }));
    const runInstruction = vi.fn(async (prompt: string) => {
      return 'Summary: 2 markdown files found.';
    });

    const service = new ConnectorPlaybookService({
      config,
      runTool,
      runInstruction,
    });

    const result = await service.runPlaybook({
      playbookId: 'instruction-pipeline',
      origin: 'web',
    });

    expect(result.success).toBe(true);
    expect(result.run.steps).toHaveLength(2);
    expect(result.run.steps[0].toolName).toBe('fs_list');
    expect(result.run.steps[0].status).toBe('succeeded');
    expect(result.run.steps[1].toolName).toBe('_instruction');
    expect(result.run.steps[1].status).toBe('succeeded');
    expect(result.run.steps[1].output).toBe('Summary: 2 markdown files found.');
    expect(runInstruction).toHaveBeenCalledTimes(1);

    // Verify the LLM prompt contains prior step output.
    const prompt = runInstruction.mock.calls[0][0];
    expect(prompt).toContain('file1.md');
    expect(prompt).toContain('Summarize the files listed above.');
  });

  it('fails instruction step when no instruction text provided', async () => {
    const config = makeConfig();
    config.playbooks.requireDryRunOnFirstExecution = false;
    config.playbooks.requireSignedDefinitions = false;
    config.playbooks.definitions = [
      {
        id: 'empty-instruction',
        name: 'Empty Instruction',
        enabled: true,
        mode: 'sequential',
        steps: [
          {
            id: 'bad-step',
            type: 'instruction',
            packId: '',
            toolName: '',
            instruction: '',
          },
        ],
      },
    ];

    const service = new ConnectorPlaybookService({
      config,
      runTool: async () => ({ success: true, status: 'succeeded', jobId: 'j', message: 'ok' }),
      runInstruction: async () => 'should not be called',
    });

    const result = await service.runPlaybook({
      playbookId: 'empty-instruction',
      origin: 'cli',
    });

    expect(result.success).toBe(false);
    expect(result.run.steps[0].status).toBe('failed');
    expect(result.run.steps[0].message).toContain('no instruction text');
  });

  it('fails instruction step when no runInstruction callback provided', async () => {
    const config = makeConfig();
    config.playbooks.requireDryRunOnFirstExecution = false;
    config.playbooks.requireSignedDefinitions = false;
    config.playbooks.definitions = [
      {
        id: 'no-llm',
        name: 'No LLM',
        enabled: true,
        mode: 'sequential',
        steps: [
          {
            id: 'orphan',
            type: 'instruction',
            packId: '',
            toolName: '',
            instruction: 'Do something.',
          },
        ],
      },
    ];

    const service = new ConnectorPlaybookService({
      config,
      runTool: async () => ({ success: true, status: 'succeeded', jobId: 'j', message: 'ok' }),
      // runInstruction intentionally omitted
    });

    const result = await service.runPlaybook({
      playbookId: 'no-llm',
      origin: 'cli',
    });

    expect(result.success).toBe(false);
    expect(result.run.steps[0].status).toBe('failed');
    expect(result.run.steps[0].message).toContain('LLM provider');
  });

  it('instruction step returns dry-run output without calling LLM', async () => {
    const config = makeConfig();
    config.playbooks.requireDryRunOnFirstExecution = false;
    config.playbooks.requireSignedDefinitions = false;
    config.playbooks.definitions = [
      {
        id: 'dry-instruction',
        name: 'Dry Instruction',
        enabled: true,
        mode: 'sequential',
        steps: [
          {
            id: 'summarize',
            type: 'instruction',
            packId: '',
            toolName: '',
            instruction: 'Summarize.',
          },
        ],
      },
    ];

    const runInstruction = vi.fn(async () => 'should not be called');
    const service = new ConnectorPlaybookService({
      config,
      runTool: async () => ({ success: true, status: 'succeeded', jobId: 'j', message: 'ok' }),
      runInstruction,
    });

    const result = await service.runPlaybook({
      playbookId: 'dry-instruction',
      origin: 'cli',
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.run.steps[0].status).toBe('succeeded');
    expect(result.run.steps[0].toolName).toBe('_instruction');
    expect(result.run.steps[0].output).toContain('dry-run');
    expect(runInstruction).not.toHaveBeenCalled();
  });

  it('instruction step output is scanned when scanOutput is provided', async () => {
    const config = makeConfig();
    config.playbooks.requireDryRunOnFirstExecution = false;
    config.playbooks.requireSignedDefinitions = false;
    config.playbooks.definitions = [
      {
        id: 'scanned-instruction',
        name: 'Scanned Instruction',
        enabled: true,
        mode: 'sequential',
        steps: [
          {
            id: 'gen',
            type: 'instruction',
            packId: '',
            toolName: '',
            instruction: 'Generate output.',
          },
        ],
      },
    ];

    const scanOutput = vi.fn(async (text: string) => text.replace('SECRET', '[REDACTED]'));
    const service = new ConnectorPlaybookService({
      config,
      runTool: async () => ({ success: true, status: 'succeeded', jobId: 'j', message: 'ok' }),
      runInstruction: async () => 'The password is SECRET',
      scanOutput,
    });

    const result = await service.runPlaybook({
      playbookId: 'scanned-instruction',
      origin: 'web',
    });

    expect(result.success).toBe(true);
    expect(result.run.steps[0].output).toBe('The password is [REDACTED]');
    expect(scanOutput).toHaveBeenCalledWith('The password is SECRET');
  });

  it('mixes tool and instruction steps in sequential pipeline', async () => {
    const config = makeConfig();
    config.playbooks.requireDryRunOnFirstExecution = false;
    config.playbooks.requireSignedDefinitions = false;
    config.playbooks.definitions = [
      {
        id: 'mixed-pipeline',
        name: 'Mixed Pipeline',
        enabled: true,
        mode: 'sequential',
        steps: [
          { id: 'step-1', packId: '', toolName: 'net_arp_scan', args: {} },
          {
            id: 'step-2',
            type: 'instruction',
            packId: '',
            toolName: '',
            instruction: 'Analyze network scan results.',
          },
          { id: 'step-3', packId: '', toolName: 'memory_save', args: { key: 'scan-analysis' } },
        ],
      },
    ];

    const toolCalls: string[] = [];
    const runTool = vi.fn(async (req: ToolExecutionRequest): Promise<ToolRunResponse> => {
      toolCalls.push(req.toolName);
      return {
        success: true,
        status: 'succeeded',
        jobId: `job-${req.toolName}`,
        message: 'ok',
        output: { devices: ['192.168.1.1', '192.168.1.2'] },
      };
    });
    const runInstruction = vi.fn(async () => 'Found 2 devices on the network.');

    const service = new ConnectorPlaybookService({
      config,
      runTool,
      runInstruction,
    });

    const result = await service.runPlaybook({
      playbookId: 'mixed-pipeline',
      origin: 'cli',
    });

    expect(result.success).toBe(true);
    expect(result.run.steps).toHaveLength(3);
    expect(toolCalls).toEqual(['net_arp_scan', 'memory_save']);
    expect(result.run.steps[1].toolName).toBe('_instruction');
    expect(runInstruction).toHaveBeenCalledTimes(1);
  });
});
