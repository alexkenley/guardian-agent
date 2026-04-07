import { describe, expect, it, vi } from 'vitest';

import { createPerformanceDashboardCallbacks } from './performance-dashboard-callbacks.js';

describe('createPerformanceDashboardCallbacks', () => {
  it('delegates performance dashboard actions to the service', async () => {
    const service = {
      getStatus: vi.fn(async () => ({ activeProfile: 'coding-focus', os: 'win32', snapshot: {}, capabilities: {}, profiles: [], latencyTargets: [], history: [] })),
      getProcesses: vi.fn(async () => ([{ targetId: 'pid:200', pid: 200, name: 'Discord.exe', memoryMb: 300 }])),
      applyProfile: vi.fn(async (_profileId: string) => ({ success: true, message: 'applied' })),
      previewAction: vi.fn(async (_actionId: string) => ({ previewId: 'preview-1', processTargets: [], cleanupTargets: [] })),
      runAction: vi.fn(async (_action: { previewId: string }) => ({ success: true, message: 'ran' })),
    } as never;

    const callbacks = createPerformanceDashboardCallbacks(service);

    await expect(callbacks.onPerformanceStatus?.()).resolves.toMatchObject({ activeProfile: 'coding-focus' });
    await expect(callbacks.onPerformanceProcesses?.()).resolves.toEqual([
      { targetId: 'pid:200', pid: 200, name: 'Discord.exe', memoryMb: 300 },
    ]);
    await expect(callbacks.onPerformanceApplyProfile?.('coding-focus')).resolves.toEqual({ success: true, message: 'applied' });
    await expect(callbacks.onPerformancePreviewAction?.('cleanup')).resolves.toMatchObject({ previewId: 'preview-1' });
    await expect(callbacks.onPerformanceRunAction?.({
      previewId: 'preview-1',
      selectedProcessTargetIds: [],
      selectedCleanupTargetIds: [],
    })).resolves.toEqual({ success: true, message: 'ran' });

    expect(service.getStatus).toHaveBeenCalledOnce();
    expect(service.getProcesses).toHaveBeenCalledOnce();
    expect(service.applyProfile).toHaveBeenCalledWith('coding-focus');
    expect(service.previewAction).toHaveBeenCalledWith('cleanup');
    expect(service.runAction).toHaveBeenCalledWith({
      previewId: 'preview-1',
      selectedProcessTargetIds: [],
      selectedCleanupTargetIds: [],
    });
  });
});
