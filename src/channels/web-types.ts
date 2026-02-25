/**
 * Web dashboard API response types.
 *
 * Shared data shapes for all dashboard API endpoints and SSE events.
 * Keeps web.ts and index.ts decoupled from internal runtime types.
 */

import type { AuditEvent, AuditFilter, AuditSummary } from '../guardian/audit-log.js';
import type { WatchdogResult } from '../runtime/watchdog.js';
import type { BudgetRecord } from '../runtime/budget.js';
import type { ReferenceGuide } from '../reference-guide.js';
import type { QuickActionDefinition } from '../quick-actions.js';
import type { SetupStatus, SetupApplyInput } from '../runtime/setup.js';
import type { AnalyticsSummary, AnalyticsEventInput } from '../runtime/analytics.js';
import type { ConversationSessionInfo } from '../runtime/conversation.js';
import type {
  ThreatIntelSummary,
  ThreatIntelPlan,
  ThreatIntelFinding,
  ThreatIntelAction,
  ThreatIntelScanInput,
  IntelStatus,
  IntelActionType,
  IntelResponseMode,
} from '../runtime/threat-intel.js';

/** Agent info returned by GET /api/agents. */
export interface DashboardAgentInfo {
  id: string;
  name: string;
  state: string;
  canChat?: boolean;
  capabilities: readonly string[];
  provider?: string;
  schedule?: string;
  lastActivityMs: number;
  consecutiveErrors: number;
}

/** Detailed agent info returned by GET /api/agents/:id. */
export interface DashboardAgentDetail extends DashboardAgentInfo {
  resourceLimits: {
    maxInvocationBudgetMs: number;
    maxTokensPerMinute: number;
    maxConcurrentTools: number;
    maxQueueDepth: number;
  };
}

/** Redacted config returned by GET /api/config. */
export interface RedactedConfig {
  llm: Record<string, { provider: string; model: string; baseUrl?: string }>;
  defaultProvider: string;
  channels: {
    cli?: { enabled: boolean };
    telegram?: { enabled: boolean };
    web?: { enabled: boolean; port?: number; host?: string };
  };
  guardian: {
    enabled: boolean;
    rateLimit?: { maxPerMinute: number; maxPerHour: number; burstAllowed: number };
    inputSanitization?: { enabled: boolean; blockThreshold: number };
    outputScanning?: { enabled: boolean; redactSecrets: boolean };
    sentinel?: { enabled: boolean; schedule: string };
  };
  runtime: {
    maxStallDurationMs: number;
    watchdogIntervalMs: number;
    logLevel: string;
  };
  assistant: {
    setupCompleted: boolean;
    identity: {
      mode: 'single_user' | 'channel_user';
      primaryUserId: string;
    };
    memory: {
      enabled: boolean;
      retentionDays: number;
    };
    analytics: {
      enabled: boolean;
      retentionDays: number;
    };
    quickActions: {
      enabled: boolean;
    };
    threatIntel: {
      enabled: boolean;
      allowDarkWeb: boolean;
      responseMode: 'manual' | 'assisted' | 'autonomous';
      watchlistCount: number;
      autoScanIntervalMinutes: number;
      moltbook: {
        enabled: boolean;
        mode: 'mock' | 'api';
        baseUrl?: string;
        allowActiveResponse: boolean;
      };
    };
  };
}

/** Budget info returned by GET /api/budget. */
export interface DashboardBudgetInfo {
  agents: Array<{
    agentId: string;
    tokensPerMinute: number;
    concurrentInvocations: number;
    overrunCount: number;
  }>;
  recentOverruns: readonly BudgetRecord[];
}

/** Provider info returned by GET /api/providers. */
export interface DashboardProviderInfo {
  name: string;
  type: string;
  model: string;
  baseUrl?: string;
  /** 'local' for Ollama/local endpoints, 'external' for cloud APIs. */
  locality: 'local' | 'external';
  /** Whether the provider is currently reachable. */
  connected: boolean;
  /** Available models (for Ollama discovery). */
  availableModels?: string[];
}

/** SSE event pushed to dashboard clients. */
export interface SSEEvent {
  type: 'audit' | 'metrics' | 'watchdog';
  data: unknown;
}

/** SSE listener callback for real-time events. */
export type SSEListener = (event: SSEEvent) => void;

/** Dashboard API callbacks supplied by index.ts to WebChannel. */
export interface DashboardCallbacks {
  onAgents?: () => DashboardAgentInfo[];
  onAgentDetail?: (id: string) => DashboardAgentDetail | null;
  onAuditQuery?: (filter: AuditFilter) => AuditEvent[];
  onAuditSummary?: (windowMs: number) => AuditSummary;
  onConfig?: () => RedactedConfig;
  onBudget?: () => DashboardBudgetInfo;
  onWatchdog?: () => WatchdogResult[];
  onProviders?: () => DashboardProviderInfo[];
  onProvidersStatus?: () => Promise<DashboardProviderInfo[]>;
  onSSESubscribe?: (listener: SSEListener) => () => void;
  onDispatch?: (agentId: string, message: { content: string; userId?: string; channel?: string }) => Promise<{ content: string }>;
  onConfigUpdate?: (updates: ConfigUpdate) => Promise<{ success: boolean; message: string }>;
  onConversationReset?: (args: {
    agentId: string;
    userId: string;
    channel: string;
  }) => Promise<{ success: boolean; message: string }> | { success: boolean; message: string };
  onConversationSessions?: (args: {
    userId: string;
    channel: string;
    agentId?: string;
  }) => ConversationSessionInfo[];
  onConversationUseSession?: (args: {
    agentId: string;
    userId: string;
    channel: string;
    sessionId: string;
  }) => { success: boolean; message: string };
  onReferenceGuide?: () => ReferenceGuide;
  onQuickActions?: () => QuickActionDefinition[];
  onQuickActionRun?: (args: {
    actionId: string;
    details: string;
    agentId: string;
    userId: string;
    channel: string;
  }) => Promise<{ content: string }>;
  onSetupStatus?: () => Promise<SetupStatus> | SetupStatus;
  onSetupApply?: (input: SetupApplyInput) => Promise<{ success: boolean; message: string }>;
  onAnalyticsTrack?: (event: AnalyticsEventInput) => void;
  onAnalyticsSummary?: (windowMs: number) => AnalyticsSummary;
  onThreatIntelSummary?: () => ThreatIntelSummary;
  onThreatIntelPlan?: () => ThreatIntelPlan;
  onThreatIntelWatchlist?: () => string[];
  onThreatIntelWatchAdd?: (target: string) => { success: boolean; message: string };
  onThreatIntelWatchRemove?: (target: string) => { success: boolean; message: string };
  onThreatIntelScan?: (input: ThreatIntelScanInput) => {
    success: boolean;
    message: string;
    findings: ThreatIntelFinding[];
  } | Promise<{
    success: boolean;
    message: string;
    findings: ThreatIntelFinding[];
  }>;
  onThreatIntelFindings?: (args: {
    limit?: number;
    status?: IntelStatus;
  }) => ThreatIntelFinding[];
  onThreatIntelUpdateFindingStatus?: (args: {
    findingId: string;
    status: IntelStatus;
  }) => { success: boolean; message: string };
  onThreatIntelActions?: (limit?: number) => ThreatIntelAction[];
  onThreatIntelDraftAction?: (args: {
    findingId: string;
    type: IntelActionType;
  }) => { success: boolean; message: string; action?: ThreatIntelAction };
  onThreatIntelSetResponseMode?: (mode: IntelResponseMode) => { success: boolean; message: string };
}

/** Fields that can be updated via POST /api/config. */
export interface ConfigUpdate {
  defaultProvider?: string;
  llm?: Record<string, {
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  }>;
}
