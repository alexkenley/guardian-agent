/**
 * Web dashboard API response types.
 *
 * Shared data shapes for all dashboard API endpoints and SSE events.
 * Keeps web.ts and index.ts decoupled from internal runtime types.
 */

import type { AuditEvent, AuditEventType, AuditFilter, AuditSeverity, AuditSummary } from '../guardian/audit-log.js';
import type { WatchdogResult } from '../runtime/watchdog.js';
import type { BudgetRecord } from '../runtime/budget.js';
import type { ReferenceGuide } from '../reference-guide.js';
import type { QuickActionDefinition } from '../quick-actions.js';
import type { SetupStatus, SetupApplyInput, SearchConfigInput } from '../runtime/setup.js';
import type { AnalyticsSummary, AnalyticsEventInput } from '../runtime/analytics.js';
import type { ConversationSessionInfo } from '../runtime/conversation.js';
import type { AssistantOrchestratorState } from '../runtime/orchestrator.js';
import type { AssistantConnectorPackConfig, AssistantConnectorPlaybookDefinition, ConnectorExecutionMode } from '../config/types.js';
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
import type { ConnectorFrameworkState, ConnectorPlaybookRunResult } from '../runtime/connectors.js';
import type { ToolApprovalRequest, ToolCategory, ToolDefinition, ToolJobRecord, ToolPolicySnapshot, ToolRunResponse, ToolRuntimeNotice } from '../tools/types.js';
import type { ScheduledTaskDefinition, ScheduledTaskCreateInput, ScheduledTaskUpdateInput, ScheduledTaskPreset, ScheduledTaskStatus } from '../runtime/scheduled-tasks.js';
import type { QMDStatusResponse } from '../runtime/qmd-search.js';
import type { QMDSourceConfig } from '../config/types.js';
import type { NetworkAlert, NetworkBaselineSnapshot } from '../runtime/network-baseline.js';
import type { SandboxHealth } from '../sandbox/index.js';
import type { SkillRisk } from '../skills/types.js';

/** Agent info returned by GET /api/agents. */
export interface DashboardAgentInfo {
  id: string;
  name: string;
  state: string;
  canChat?: boolean;
  /** Internal agents are used by tier routing and hidden from user-facing selectors. */
  internal?: boolean;
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
    telegram?: {
      enabled: boolean;
      botTokenConfigured?: boolean;
      allowedChatIds?: number[];
      defaultAgent?: string;
    };
    web?: {
      enabled: boolean;
      port?: number;
      host?: string;
      auth?: {
        mode: 'bearer_required';
        tokenConfigured: boolean;
        tokenSource?: 'config' | 'env' | 'ephemeral';
        rotateOnStartup: boolean;
        sessionTtlMinutes?: number;
      };
    };
  };
  guardian: {
    enabled: boolean;
    rateLimit?: { maxPerMinute: number; maxPerHour: number; burstAllowed: number };
    inputSanitization?: { enabled: boolean; blockThreshold: number };
    outputScanning?: { enabled: boolean; redactSecrets: boolean };
    guardianAgent?: { enabled: boolean; llmProvider: string; failOpen: boolean; timeoutMs?: number };
    sentinel?: { enabled: boolean; schedule: string };
    policy?: { enabled: boolean; mode: string; rulesPath?: string };
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
    soul: {
      enabled: boolean;
      path?: string;
      primaryMode: 'full' | 'summary' | 'disabled';
      delegatedMode: 'full' | 'summary' | 'disabled';
      maxChars: number;
      summaryMaxChars: number;
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
    network: {
      deviceIntelligence: {
        enabled: boolean;
        ouiDatabase: 'bundled' | 'remote';
        autoClassify: boolean;
      };
      baseline: {
        enabled: boolean;
        minSnapshotsForBaseline: number;
        dedupeWindowMs: number;
      };
      fingerprinting: {
        enabled: boolean;
        bannerTimeout: number;
        maxConcurrentPerDevice: number;
        autoFingerprint: boolean;
      };
      wifi: {
        enabled: boolean;
        platform: 'auto' | 'linux' | 'macos' | 'windows';
        scanInterval: number;
      };
      trafficAnalysis: {
        enabled: boolean;
        dataSource: 'ss' | 'conntrack' | 'router-api';
        flowRetention: number;
      };
      connectionCount: number;
    };
    connectors: {
      enabled: boolean;
      executionMode: 'plan_then_execute' | 'direct_execute';
      maxConnectorCallsPerRun: number;
      packCount: number;
      enabledPackCount: number;
      playbookCount: number;
      playbooks: {
        enabled: boolean;
        maxSteps: number;
        maxParallelSteps: number;
        defaultStepTimeoutMs: number;
        requireSignedDefinitions: boolean;
        requireDryRunOnFirstExecution: boolean;
      };
      studio: {
        enabled: boolean;
        mode: 'read_only' | 'builder';
        requirePrivilegedTicket: boolean;
      };
    };
    tools: {
      enabled: boolean;
      policyMode: 'approve_each' | 'approve_by_policy' | 'autonomous';
      allowExternalPosting: boolean;
      allowedPathsCount: number;
      allowedCommandsCount: number;
      allowedDomainsCount: number;
      webSearch?: {
        provider: string;
        perplexityConfigured: boolean;
        openRouterConfigured: boolean;
        braveConfigured: boolean;
      };
      qmd?: {
        enabled: boolean;
        sourceCount: number;
        defaultMode: string;
      };
      agentPolicyUpdates?: {
        allowedPaths: boolean;
        allowedCommands: boolean;
        allowedDomains: boolean;
      };
    };
  };
  fallbacks?: string[];
}

export interface DashboardAuthStatus {
  mode: 'bearer_required';
  tokenConfigured: boolean;
  tokenSource: 'config' | 'env' | 'ephemeral';
  tokenPreview?: string;
  rotateOnStartup: boolean;
  sessionTtlMinutes?: number;
  host?: string;
  port?: number;
}

export interface DashboardToolsState {
  enabled: boolean;
  tools: ToolDefinition[];
  policy: ToolPolicySnapshot;
  approvals: ToolApprovalRequest[];
  jobs: ToolJobRecord[];
  notices?: ToolRuntimeNotice[];
  sandbox?: SandboxHealth;
  /** All tool categories with current enable/disable status. */
  categories?: Array<{
    category: ToolCategory;
    label: string;
    description: string;
    toolCount: number;
    enabled: boolean;
    disabledReason?: string;
  }>;
  /** Currently disabled categories. */
  disabledCategories?: ToolCategory[];
  /** Per-tool/per-category LLM provider routing preferences (user overrides only). */
  providerRouting?: Record<string, 'local' | 'external' | 'default'>;
  /** Whether smart provider routing is enabled (default: true). When false, all tools use the default provider. */
  providerRoutingEnabled?: boolean;
  /** Locality of the default LLM provider ('local' for Ollama, 'external' for cloud). */
  defaultProviderLocality?: 'local' | 'external';
  /** Computed per-category defaults based on available providers. External categories route to external when both providers exist. */
  categoryDefaults?: Record<string, 'local' | 'external'>;
}

export interface DashboardSkillsState {
  enabled: boolean;
  autoSelect: boolean;
  maxActivePerRequest: number;
  managedProviders: Array<{
    id: string;
    enabled: boolean;
  }>;
  skills: Array<{
    id: string;
    name: string;
    version: string;
    description: string;
    tags: string[];
    enabled: boolean;
    risk: SkillRisk;
    rootDir: string;
    sourcePath: string;
    tools: string[];
    requiredCapabilities: string[];
    requiredManagedProvider?: string;
    providerReady?: boolean;
    disabledReason?: string;
  }>;
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

/** Assistant orchestrator snapshot for UI/CLI visibility. */
export interface DashboardAssistantState {
  orchestrator: AssistantOrchestratorState;
  jobs: {
    summary: {
      total: number;
      running: number;
      succeeded: number;
      failed: number;
      lastStartedAt?: number;
      lastCompletedAt?: number;
    };
    jobs: Array<{
      id: string;
      type: string;
      source: 'manual' | 'scheduled' | 'system';
      status: 'running' | 'succeeded' | 'failed';
      startedAt: number;
      completedAt?: number;
      durationMs?: number;
      detail?: string;
      error?: string;
      metadata?: Record<string, unknown>;
    }>;
  };
  lastPolicyDecisions: Array<{
    id: string;
    timestamp: number;
    type: AuditEventType;
    severity: AuditSeverity;
    agentId: string;
    controller?: string;
    reason?: string;
  }>;
  defaultProvider: string;
  guardianEnabled: boolean;
  providerCount: number;
  providers: string[];
  scheduledJobs: Array<{
    agentId: string;
    cron: string;
    nextRun?: number;
  }>;
}

/** SSE event pushed to dashboard clients. */
export interface SSEEvent {
  type: 'audit' | 'metrics' | 'watchdog' | 'security.alert' | 'chat.thinking' | 'chat.tool_call' | 'chat.token' | 'chat.done' | 'chat.error';
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
  onAuditVerifyChain?: () => Promise<{ valid: boolean; totalEntries: number; brokenAt?: number }>;
  onConfig?: () => RedactedConfig;
  onBudget?: () => DashboardBudgetInfo;
  onWatchdog?: () => WatchdogResult[];
  onProviders?: () => DashboardProviderInfo[];
  onProvidersStatus?: () => Promise<DashboardProviderInfo[]>;
  onAssistantState?: () => DashboardAssistantState;
  onSSESubscribe?: (listener: SSEListener) => () => void;
  onDispatch?: (agentId: string, message: { content: string; userId?: string; channel?: string }, routeDecision?: { fallbackAgentId?: string; complexityScore?: number; tier?: string }) => Promise<{ content: string; metadata?: Record<string, unknown> }>;
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
  onSearchConfigUpdate?: (input: SearchConfigInput) => Promise<{ success: boolean; message: string }>;
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
  onAuthStatus?: () => DashboardAuthStatus;
  onAuthUpdate?: (input: {
    mode?: 'bearer_required';
    token?: string;
    rotateOnStartup?: boolean;
    sessionTtlMinutes?: number;
  }) => Promise<{ success: boolean; message: string; status?: DashboardAuthStatus }> | { success: boolean; message: string; status?: DashboardAuthStatus };
  onAuthRotate?: () => Promise<{ success: boolean; message: string; token?: string; status?: DashboardAuthStatus }> | { success: boolean; message: string; token?: string; status?: DashboardAuthStatus };
  onAuthReveal?: () => Promise<{ success: boolean; token?: string }> | { success: boolean; token?: string };
  onToolsState?: (args?: { limit?: number }) => DashboardToolsState;
  onToolsPendingApprovals?: (args: {
    userId: string;
    channel: string;
    limit?: number;
  }) => Array<{
    id: string;
    toolName: string;
    argsPreview: string;
  }>;
  onSkillsState?: () => DashboardSkillsState;
  onSkillsUpdate?: (input: { skillId: string; enabled: boolean }) => { success: boolean; message: string };
  onToolsCategories?: () => Array<{ category: ToolCategory; label: string; description: string; toolCount: number; enabled: boolean; disabledReason?: string }>;
  onToolsCategoryToggle?: (input: { category: ToolCategory; enabled: boolean }) => { success: boolean; message: string };
  onToolsProviderRoutingUpdate?: (input: { routing?: Record<string, 'local' | 'external' | 'default'>; enabled?: boolean }) => { success: boolean; message: string };
  onToolsRun?: (input: {
    toolName: string;
    args?: Record<string, unknown>;
    origin?: 'assistant' | 'cli' | 'web';
    agentId?: string;
    userId?: string;
    channel?: string;
  }) => Promise<ToolRunResponse> | ToolRunResponse;
  onToolsPolicyUpdate?: (input: {
    mode?: 'approve_each' | 'approve_by_policy' | 'autonomous';
    toolPolicies?: Record<string, 'auto' | 'policy' | 'manual' | 'deny'>;
    sandbox?: {
      allowedPaths?: string[];
      allowedCommands?: string[];
      allowedDomains?: string[];
    };
  }) => { success: boolean; message: string; policy?: ToolPolicySnapshot };
  onBrowserConfigUpdate?: (input: {
    enabled?: boolean;
    allowedDomains?: string[];
    sessionIdleTimeoutMs?: number;
    maxSessions?: number;
  }) => { success: boolean; message: string };
  onBrowserConfigState?: () => { enabled: boolean; allowedDomains: string[]; sessionIdleTimeoutMs: number; maxSessions: number };
  onToolsApprovalDecision?: (input: {
    approvalId: string;
    decision: 'approved' | 'denied';
    actor: string;
    reason?: string;
  }) => Promise<{ success: boolean; message: string }> | { success: boolean; message: string };
  onConnectorsState?: (args?: { limitRuns?: number }) => ConnectorFrameworkState;
  onConnectorsTemplates?: () => Array<{ id: string; name: string; description: string; category: string; installed: boolean; playbookCount: number }>;
  onConnectorsTemplateInstall?: (templateId: string) => { success: boolean; message: string };
  onNetworkDevices?: () => {
    devices: Array<{
      ip: string;
      mac: string;
      hostname: string | null;
      openPorts: number[];
      vendor?: string;
      deviceType?: string;
      deviceTypeConfidence?: number;
      services?: Array<{ port: number; protocol: 'tcp' | 'udp'; service: string; version?: string }>;
      userLabel?: string;
      trusted?: boolean;
      firstSeen: number;
      lastSeen: number;
      status: 'online' | 'offline';
    }>;
  };
  onNetworkScan?: () => Promise<{ success: boolean; message: string; devicesFound: number }>;
  onNetworkBaseline?: () => NetworkBaselineSnapshot;
  onNetworkThreats?: (args?: { includeAcknowledged?: boolean; limit?: number }) => {
    alerts: NetworkAlert[];
    activeAlertCount: number;
    bySeverity: { low: number; medium: number; high: number; critical: number };
    baselineReady: boolean;
    snapshotCount: number;
  };
  onNetworkThreatAcknowledge?: (alertId: string) => { success: boolean; message: string };
  onConnectorsSettingsUpdate?: (input: {
    enabled?: boolean;
    executionMode?: ConnectorExecutionMode;
    maxConnectorCallsPerRun?: number;
    playbooks?: {
      enabled?: boolean;
      maxSteps?: number;
      maxParallelSteps?: number;
      defaultStepTimeoutMs?: number;
      requireSignedDefinitions?: boolean;
      requireDryRunOnFirstExecution?: boolean;
    };
    studio?: {
      enabled?: boolean;
      mode?: 'read_only' | 'builder';
      requirePrivilegedTicket?: boolean;
    };
  }) => { success: boolean; message: string };
  onConnectorsPackUpsert?: (pack: AssistantConnectorPackConfig) => { success: boolean; message: string };
  onConnectorsPackDelete?: (packId: string) => { success: boolean; message: string };
  onPlaybookUpsert?: (playbook: AssistantConnectorPlaybookDefinition) => { success: boolean; message: string };
  onPlaybookDelete?: (playbookId: string) => { success: boolean; message: string };
  onPlaybookRun?: (input: {
    playbookId: string;
    dryRun?: boolean;
    origin?: 'assistant' | 'cli' | 'web';
    agentId?: string;
    userId?: string;
    channel?: string;
    requestedBy?: string;
  }) => Promise<ConnectorPlaybookRunResult> | ConnectorPlaybookRunResult;
  onStreamDispatch?: (
    agentId: string,
    message: { content: string; userId?: string; channel?: string },
    emitSSE: (event: SSEEvent) => void,
  ) => Promise<{ requestId: string; content: string; metadata?: Record<string, unknown> }>;
  onTelegramReload?: () => Promise<{ success: boolean; message: string }>;
  onKillswitch?: () => void;
  onFactoryReset?: (args: { scope: 'data' | 'config' | 'all' }) => Promise<{
    success: boolean;
    message: string;
    deletedFiles: string[];
    errors: string[];
  }>;
  onRoutingMode?: () => { tierMode: string; complexityThreshold: number; fallbackOnFailure: boolean };
  onRoutingModeUpdate?: (mode: 'auto' | 'local-only' | 'external-only') => { success: boolean; message: string; tierMode: string };
  onScheduledTasks?: () => ScheduledTaskDefinition[];
  onScheduledTaskGet?: (id: string) => ScheduledTaskDefinition | null;
  onScheduledTaskCreate?: (input: ScheduledTaskCreateInput) => { success: boolean; message: string; task?: ScheduledTaskDefinition };
  onScheduledTaskUpdate?: (id: string, input: ScheduledTaskUpdateInput) => { success: boolean; message: string };
  onScheduledTaskDelete?: (id: string) => { success: boolean; message: string };
  onScheduledTaskRunNow?: (id: string) => Promise<{ success: boolean; message: string }>;
  onScheduledTaskPresets?: () => ScheduledTaskPreset[];
  onScheduledTaskInstallPreset?: (presetId: string) => { success: boolean; message: string; task?: ScheduledTaskDefinition };
  onScheduledTaskHistory?: () => Array<{
    taskId: string;
    taskName: string;
    timestamp: number;
    status: ScheduledTaskStatus;
    durationMs: number;
    message: string;
  }>;
  onQMDStatus?: () => Promise<QMDStatusResponse> | QMDStatusResponse;
  onQMDSources?: () => QMDSourceConfig[];
  onQMDSourceAdd?: (source: QMDSourceConfig) => { success: boolean; message: string };
  onQMDSourceRemove?: (id: string) => { success: boolean; message: string };
  onQMDSourceToggle?: (id: string, enabled: boolean) => { success: boolean; message: string };
  onQMDReindex?: (collection?: string) => Promise<{ success: boolean; message: string }>;
  onGwsStatus?: () => Promise<GwsConnectionStatus>;
  /** Guardian Agent inline evaluation config and status. */
  onGuardianAgentStatus?: () => {
    enabled: boolean;
    llmProvider: 'local' | 'external' | 'auto';
    failOpen: boolean;
    timeoutMs: number;
    actionTypes: string[];
  };
  onGuardianAgentUpdate?: (input: {
    enabled?: boolean;
    llmProvider?: 'local' | 'external' | 'auto';
    failOpen?: boolean;
    timeoutMs?: number;
  }) => { success: boolean; message: string };
  /** Policy-as-Code engine status. */
  onPolicyStatus?: () => {
    enabled: boolean;
    mode: 'off' | 'shadow' | 'enforce';
    families: { tool: string; admin: string; guardian: string; event: string };
    rulesPath: string;
    ruleCount: number;
    mismatchLogLimit: number;
    shadowStats?: {
      totalComparisons: number;
      totalMismatches: number;
      matchRate: number;
      mismatchesByClass: Record<string, number>;
    };
  };
  /** Update Policy-as-Code engine config. */
  onPolicyUpdate?: (input: {
    enabled?: boolean;
    mode?: 'off' | 'shadow' | 'enforce';
    families?: { tool?: string; admin?: string; guardian?: string; event?: string };
    mismatchLogLimit?: number;
  }) => { success: boolean; message: string };
  /** Reload policy rules from disk. */
  onPolicyReload?: () => { success: boolean; message: string; loaded: number; skipped: number; errors: string[] };
  /** Sentinel audit: run on-demand and return results. */
  onSentinelAuditRun?: (windowMs?: number) => Promise<{
    success: boolean;
    anomalies: Array<{ type: string; severity: string; description: string; agentId?: string }>;
    llmFindings: Array<{ severity: string; description: string; recommendation: string }>;
    timestamp: number;
    windowMs: number;
  }>;
}

export interface GwsConnectionStatus {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  authMethod?: string;
  services: string[];
  enabled: boolean;
}

/** Fields that can be updated via POST /api/config. */
export interface ConfigUpdate {
  defaultProvider?: string;
  llm?: Record<string, {
    provider?: string;
    model?: string;
    apiKey?: string;
    credentialRef?: string;
    baseUrl?: string;
  }>;
  channels?: {
    telegram?: {
      enabled?: boolean;
      botToken?: string;
      allowedChatIds?: number[];
      polling?: boolean;
      defaultAgent?: string;
    };
  };
  assistant?: {
    tools?: {
      qmd?: {
        enabled?: boolean;
      };
      mcp?: {
        enabled?: boolean;
        managedProviders?: {
          gws?: {
            enabled?: boolean;
            services?: string[];
            command?: string;
          };
        };
      };
      sandbox?: {
        enforcementMode?: 'strict' | 'permissive';
      };
      agentPolicyUpdates?: {
        allowedPaths?: boolean;
        allowedCommands?: boolean;
        allowedDomains?: boolean;
      };
    };
  };
}
