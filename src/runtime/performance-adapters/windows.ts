import { PerformanceAdapter } from './types.js';
import { PerformanceActionPreview, ApprovedPerformanceAction, PerformanceSnapshot } from '../../channels/web-types.js';

export class WindowsPerformanceAdapter implements PerformanceAdapter {
  getCapabilities() {
    return { canManageProcesses: true, canManagePower: true };
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
      cleanupTargets: [
        {
          targetId: 'temp',
          label: 'Clear User Temp',
          suggestedReason: 'Free up disk space',
          checkedByDefault: false,
          selectable: true,
          risk: 'low'
        }
      ],
    };
  }

  async runAction(_action: ApprovedPerformanceAction): Promise<{ success: boolean; message: string }> {
    return { success: true, message: 'Action simulated on Windows.' };
  }

  async applyProfile(profileId: string): Promise<{ success: boolean; message: string }> {
    return { success: true, message: `Profile ${profileId} applied on Windows.` };
  }
}
