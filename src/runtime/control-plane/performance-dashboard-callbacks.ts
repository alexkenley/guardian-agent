import { PerformanceService } from '../performance-service.js';
import { DashboardCallbacks } from '../../channels/web-types.js';

export function createPerformanceDashboardCallbacks(service: PerformanceService): Partial<DashboardCallbacks> {
  return {
    onPerformanceStatus: async () => service.getStatus(),
    onPerformanceProcesses: async () => service.getProcesses(),
    onPerformanceApplyProfile: async (profileId: string) => service.applyProfile(profileId),
    onPerformancePreviewAction: async (actionId: string) => service.previewAction(actionId),
    onPerformanceRunAction: async (action) => service.runAction(action),
  };
}
