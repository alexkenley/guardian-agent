export type WorkspaceIntegrationProvider = 'google' | 'microsoft';

export interface WorkspaceIntegrationSyncHealth {
  provider: WorkspaceIntegrationProvider;
  status: 'healthy' | 'warning' | 'skipped';
  lastSyncStartedAt: number;
  lastSyncFinishedAt: number;
  reason: string;
  skipped: boolean;
  skipReason?: string;
  eventsSynced: number;
  peopleSynced: number;
  connectorCalls: number;
  error?: string;
}

export type WorkspaceIntegrationSyncHealthProvider = (
  provider: WorkspaceIntegrationProvider,
) => WorkspaceIntegrationSyncHealth | undefined;
