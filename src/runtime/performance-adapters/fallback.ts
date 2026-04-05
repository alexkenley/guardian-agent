import { PerformanceAdapter } from './types.js';
import { PerformanceActionPreview, ApprovedPerformanceAction, PerformanceSnapshot } from '../../channels/web-types.js';

export class FallbackPerformanceAdapter implements PerformanceAdapter {
  getCapabilities() {
    return { canManageProcesses: false, canManagePower: false };
  }

  async collectSnapshot(): Promise<PerformanceSnapshot> {
    return {
      cpuPercent: Math.random() * 100,
      memoryMb: Math.random() * 16000,
      diskFreeMb: Math.random() * 500000,
      activeProfile: 'balanced',
    };
  }

  async previewAction(_actionId: string): Promise<PerformanceActionPreview> {
    return {
      previewId: `preview-${Date.now()}`,
      processTargets: [],
      cleanupTargets: [],
    };
  }

  async runAction(_action: ApprovedPerformanceAction): Promise<{ success: boolean; message: string }> {
    return { success: false, message: 'Actions not supported on this OS.' };
  }

  async applyProfile(_profileId: string): Promise<{ success: boolean; message: string }> {
    return { success: false, message: 'Profiles not supported on this OS.' };
  }
}
