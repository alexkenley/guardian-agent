import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../config/types.js';
import { AuditLog } from '../guardian/audit-log.js';
import type { PerformanceAdapter } from './performance-adapters/types.js';
import { PerformanceService } from './performance-service.js';

function createConfig(): GuardianAgentConfig {
  return structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
}

function createAdapter(overrides: Partial<PerformanceAdapter> = {}): PerformanceAdapter {
  return {
    getCapabilities: () => ({
      canManageProcesses: true,
      canManagePower: false,
      canRunCleanup: false,
      canProbeLatency: true,
      supportedActionIds: ['cleanup'],
    }),
    collectSnapshot: async () => ({
      cpuPercent: 42,
      memoryMb: 2048,
      memoryTotalMb: 8192,
      memoryPercent: 25,
      diskFreeMb: 100_000,
      diskTotalMb: 200_000,
      diskPercentFree: 50,
      activeProfile: 'balanced',
      processCount: 2,
      topProcesses: [
        { targetId: 'pid:100', pid: 100, name: 'Code.exe', cpuPercent: 10, memoryMb: 512 },
        { targetId: 'pid:200', pid: 200, name: 'Discord.exe', cpuPercent: 8, memoryMb: 256 },
      ],
      sampledAt: 1_700_000_000_000,
    }),
    listProcesses: async () => [
      { targetId: 'pid:100', pid: 100, name: 'node', cpuPercent: 5, memoryMb: 200 },
      { targetId: 'pid:200', pid: 200, name: 'Discord.exe', cpuPercent: 15, memoryMb: 300 },
      { targetId: 'pid:300', pid: 300, name: 'Spotify.exe', cpuPercent: 2, memoryMb: 250 },
    ],
    terminateProcesses: async () => ({ success: true, message: 'terminated' }),
    runCleanupActions: async () => ({ success: true, message: 'cleanup complete' }),
    applyProfile: async () => ({ success: true, message: 'profile applied' }),
    ...overrides,
  };
}

describe('PerformanceService', () => {
  it('returns config-backed status with protected process annotations', async () => {
    const config = createConfig();
    config.assistant.performance!.profiles = [{
      id: 'coding-focus',
      name: 'Coding Focus',
      processRules: {
        protect: ['Code.exe'],
        terminate: ['Discord.exe'],
      },
      latencyTargets: [],
    }];

    const service = new PerformanceService({
      adapter: createAdapter(),
      getConfig: () => config,
    });

    const status = await service.getStatus();

    expect(status.activeProfile).toBe('coding-focus');
    expect(status.profiles).toHaveLength(1);
    expect(status.snapshot.topProcesses?.[0]).toMatchObject({
      name: 'Code.exe',
      protected: true,
    });
    expect(status.latencyTargets).toEqual([]);
  });

  it('builds preview targets from active profile terminate and protect rules', async () => {
    const config = createConfig();
    config.assistant.performance!.profiles = [{
      id: 'coding-focus',
      name: 'Coding Focus',
      processRules: {
        terminate: ['Discord.exe', 'node'],
        protect: ['node'],
      },
      latencyTargets: [],
    }];

    const service = new PerformanceService({
      adapter: createAdapter(),
      getConfig: () => config,
    });

    const preview = await service.previewAction('cleanup');

    expect(preview.profileId).toBe('coding-focus');
    expect(preview.processTargets.length).toBeGreaterThanOrEqual(2);
    expect(preview.processTargets.find((target) => target.name === 'Discord.exe')).toMatchObject({
      selectable: true,
      checkedByDefault: true,
    });
    expect(preview.processTargets.find((target) => target.name === 'node')).toMatchObject({
      selectable: false,
      blockedReason: expect.any(String),
    });
  });

  it('falls back to heuristic recommendations when terminate rules do not match the live process list', async () => {
    const config = createConfig();
    config.assistant.performance!.profiles = [{
      id: 'coding-focus',
      name: 'Coding Focus',
      processRules: {
        terminate: ['Teams.exe'],
        protect: ['node'],
      },
      latencyTargets: [],
    }];

    const service = new PerformanceService({
      adapter: createAdapter(),
      getConfig: () => config,
    });

    const preview = await service.previewAction('cleanup');
    const discordTarget = preview.processTargets.find((target) => target.name === 'Discord.exe');

    expect(discordTarget).toMatchObject({
      selectable: true,
      checkedByDefault: true,
      suggestedReason: expect.stringContaining('background app'),
    });
    expect(preview.processTargets.some((target) => target.name === 'node')).toBe(false);
  });

  it('runs only the selected preview targets and records history', async () => {
    const terminateProcesses = vi.fn(async () => ({ success: true, message: 'terminated selected process' }));
    const config = createConfig();
    config.assistant.performance!.profiles = [{
      id: 'coding-focus',
      name: 'Coding Focus',
      processRules: {
        terminate: ['Discord.exe', 'Spotify.exe'],
      },
      latencyTargets: [],
    }];

    const service = new PerformanceService({
      adapter: createAdapter({ terminateProcesses }),
      getConfig: () => config,
    });

    const preview = await service.previewAction('cleanup');
    const discordTarget = preview.processTargets.find((target) => target.name === 'Discord.exe');
    expect(discordTarget).toBeDefined();

    const result = await service.runAction({
      previewId: preview.previewId,
      selectedProcessTargetIds: [discordTarget!.targetId],
      selectedCleanupTargetIds: [],
    });

    expect(result).toEqual({ success: true, message: 'terminated selected process' });
    expect(terminateProcesses).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'Discord.exe', pid: 200 }),
    ]);

    const status = await service.getStatus();
    expect(status.history[0]).toMatchObject({
      actionId: 'cleanup',
      success: true,
      selectedProcessCount: 1,
      selectedCleanupCount: 0,
    });
  });

  it('switches the active profile even when the adapter reports no host power change', async () => {
    const config = createConfig();
    config.assistant.performance!.profiles = [
      { id: 'coding-focus', name: 'Coding Focus', latencyTargets: [] },
      { id: 'quiet', name: 'Quiet', latencyTargets: [] },
    ];

    const service = new PerformanceService({
      adapter: createAdapter({
        applyProfile: async () => ({ success: false, message: 'Host power-mode changes are not supported.' }),
      }),
      getConfig: () => config,
    });

    const result = await service.applyProfile('quiet');

    expect(result.success).toBe(true);
    expect(result.message).toContain('Active profile set to Quiet');
    await expect(service.getStatus()).resolves.toMatchObject({ activeProfile: 'quiet' });
  });

  it('surfaces durable history from the audit log when available', async () => {
    const config = createConfig();
    config.assistant.performance!.profiles = [
      {
        id: 'coding-focus',
        name: 'Coding Focus',
        processRules: { terminate: ['Discord.exe'] },
        latencyTargets: [],
      },
      { id: 'quiet', name: 'Quiet', latencyTargets: [] },
    ];
    const auditLog = new AuditLog();
    const service = new PerformanceService({
      adapter: createAdapter(),
      getConfig: () => config,
      auditLog,
    });

    const preview = await service.previewAction('cleanup');
    await service.runAction({
      previewId: preview.previewId,
      selectedProcessTargetIds: ['pid:200'],
      selectedCleanupTargetIds: [],
    });
    await service.applyProfile('quiet');

    const status = await service.getStatus();
    expect(status.history).toHaveLength(2);
    expect(status.history[0]).toMatchObject({
      actionId: 'apply_profile',
      success: true,
      selectedProcessCount: 0,
    });
    expect(status.history[1]).toMatchObject({
      actionId: 'cleanup',
      success: true,
      selectedProcessCount: 1,
    });
  });
});
