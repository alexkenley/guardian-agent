import { PerformanceActionPreview, ApprovedPerformanceAction, PerformanceSnapshot } from '../../channels/web-types.js';

export interface PerformanceAdapter {
  getCapabilities(): { canManageProcesses: boolean; canManagePower: boolean };
  collectSnapshot(): Promise<PerformanceSnapshot>;
  previewAction(actionId: string): Promise<PerformanceActionPreview>;
  runAction(action: ApprovedPerformanceAction): Promise<{ success: boolean; message: string }>;
  applyProfile(profileId: string): Promise<{ success: boolean; message: string }>;
}
