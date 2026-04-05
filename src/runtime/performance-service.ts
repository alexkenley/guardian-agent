import { PerformanceAdapter } from './performance-adapters/types.js';
import { PerformanceActionPreview, ApprovedPerformanceAction, PerformanceStatus } from '../channels/web-types.js';

export class PerformanceService {
  constructor(private readonly adapter: PerformanceAdapter) {}

  async getStatus(): Promise<PerformanceStatus> {
    const snapshot = await this.adapter.collectSnapshot();
    return {
      activeProfile: snapshot.activeProfile,
      os: process.platform,
      snapshot,
    };
  }

  async previewAction(actionId: string): Promise<PerformanceActionPreview> {
    return this.adapter.previewAction(actionId);
  }

  async runAction(action: ApprovedPerformanceAction): Promise<{ success: boolean; message: string }> {
    return this.adapter.runAction(action);
  }

  async applyProfile(profileId: string): Promise<{ success: boolean; message: string }> {
    return this.adapter.applyProfile(profileId);
  }
}
