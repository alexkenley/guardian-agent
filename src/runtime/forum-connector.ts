import type { IntelContentType, IntelSeverity } from './threat-intel.js';

export interface ForumConnectorFinding {
  target: string;
  summary: string;
  url?: string;
  contentType?: IntelContentType;
  severity?: IntelSeverity;
  confidence?: number;
  labels?: string[];
}

export interface ForumConnectorStatus {
  id: string;
  enabled: boolean;
  hostile: boolean;
  mode: string;
  lastScanAt?: number;
  lastError?: string;
}

export interface ForumConnector {
  readonly id: string;
  readonly sourceType: 'forum';
  scan(targets: string[]): Promise<ForumConnectorFinding[]>;
  status(): ForumConnectorStatus;
  allowsActivePublishing(): boolean;
}
