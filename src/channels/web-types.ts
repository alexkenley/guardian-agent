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
import type { NetworkAlert, NetworkBaselineSnapshot } from '../runtime/network-baseline.js';
import type { HostMonitorAlert, HostMonitorStatus, HostMonitorReport } from '../runtime/host-monitor.js';
import type { GatewayMonitorAlert, GatewayMonitorStatus, GatewayMonitorReport } from '../runtime/gateway-monitor.js';
import type {
  SecurityAlertSeverity,
  SecurityAlertSource,
  UnifiedSecurityAlert,
} from '../runtime/security-alerts.js';
import type { SecurityAlertStatus } from '../runtime/security-alert-lifecycle.js';
import type {
  DeploymentProfile,
  SecurityOperatingMode,
  SecurityPostureAssessment,
} from '../runtime/security-posture.js';
import type { SecurityTriageLlmProvider } from '../runtime/security-controls.js';
import type { SecurityContainmentState } from '../runtime/containment-service.js';
import type {
  SecurityActivityListResult,
  SecurityActivityStatus,
} from '../runtime/security-activity-log.js';
import type { WindowsDefenderAlert, WindowsDefenderProviderStatus } from '../runtime/windows-defender-provider.js';
import type { SandboxHealth } from '../sandbox/index.js';
import type { SkillRisk } from '../skills/types.js';
import type {
  CodeSessionAttachmentMode,
  CodeSessionAttachmentRecord,
  CodeSessionRecord,
  CodeSessionStatus,
  CodeSessionUiState,
  CodeSessionWorkState,
} from '../runtime/code-sessions.js';

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
  providerType?: string;
  providerModel?: string;
  providerLocality?: 'local' | 'external';
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

export interface RedactedCloudCpanelProfile {
  id: string;
  name: string;
  type: 'cpanel' | 'whm';
  host: string;
  port?: number;
  username: string;
  credentialRef?: string;
  apiTokenConfigured: boolean;
  ssl: boolean;
  allowSelfSigned: boolean;
  defaultCpanelUser?: string;
}

export interface RedactedCloudVercelProfile {
  id: string;
  name: string;
  apiBaseUrl?: string;
  credentialRef?: string;
  apiTokenConfigured: boolean;
  teamId?: string;
  slug?: string;
}

export interface RedactedCloudCloudflareProfile {
  id: string;
  name: string;
  apiBaseUrl?: string;
  credentialRef?: string;
  apiTokenConfigured: boolean;
  accountId?: string;
  defaultZoneId?: string;
}

export interface RedactedCloudAwsProfile {
  id: string;
  name: string;
  region: string;
  accessKeyIdCredentialRef?: string;
  secretAccessKeyCredentialRef?: string;
  sessionTokenCredentialRef?: string;
  accessKeyIdConfigured: boolean;
  secretAccessKeyConfigured: boolean;
  sessionTokenConfigured: boolean;
  endpoints?: {
    sts?: string;
    ec2?: string;
    s3?: string;
    route53?: string;
    lambda?: string;
    cloudwatch?: string;
    cloudwatchLogs?: string;
    rds?: string;
    iam?: string;
    costExplorer?: string;
  };
}

export interface RedactedCloudGcpProfile {
  id: string;
  name: string;
  projectId: string;
  location?: string;
  accessTokenCredentialRef?: string;
  serviceAccountCredentialRef?: string;
  accessTokenConfigured: boolean;
  serviceAccountConfigured: boolean;
  endpoints?: {
    oauth2Token?: string;
    cloudResourceManager?: string;
    serviceUsage?: string;
    compute?: string;
    run?: string;
    storage?: string;
    dns?: string;
    logging?: string;
  };
}

export interface RedactedCloudAzureProfile {
  id: string;
  name: string;
  subscriptionId: string;
  tenantId?: string;
  accessTokenCredentialRef?: string;
  accessTokenConfigured: boolean;
  clientIdCredentialRef?: string;
  clientIdConfigured: boolean;
  clientSecretCredentialRef?: string;
  clientSecretConfigured: boolean;
  defaultResourceGroup?: string;
  blobBaseUrl?: string;
  endpoints?: {
    oauth2Token?: string;
    management?: string;
  };
}

export interface RedactedCloudConfig {
  enabled: boolean;
  cpanelProfiles: RedactedCloudCpanelProfile[];
  vercelProfiles: RedactedCloudVercelProfile[];
  cloudflareProfiles: RedactedCloudCloudflareProfile[];
  awsProfiles: RedactedCloudAwsProfile[];
  gcpProfiles: RedactedCloudGcpProfile[];
  azureProfiles: RedactedCloudAzureProfile[];
  profileCounts: {
    cpanel: number;
    vercel: number;
    cloudflare: number;
    aws: number;
    gcp: number;
    azure: number;
    total: number;
  };
  security: {
    inlineSecretProfileCount: number;
    credentialRefCount: number;
    selfSignedProfileCount: number;
    customEndpointProfileCount: number;
  };
}

/** Redacted config returned by GET /api/config. */
export interface RedactedConfig {
  llm: Record<string, { provider: string; model: string; baseUrl?: string; credentialRef?: string }>;
  defaultProvider: string;
  channels: {
    cli?: { enabled: boolean };
    telegram?: {
      enabled: boolean;
      botTokenConfigured?: boolean;
      botTokenCredentialRef?: string;
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
    notifications: {
      enabled: boolean;
      minSeverity: AuditSeverity;
      auditEventTypes: AuditEventType[];
      suppressedDetailTypes: string[];
      cooldownMs: number;
      deliveryMode: 'all' | 'selected';
      destinations: {
        web: boolean;
        cli: boolean;
        telegram: boolean;
      };
    };
    quickActions: {
      enabled: boolean;
    };
    security?: {
      deploymentProfile: DeploymentProfile;
      operatingMode: SecurityOperatingMode;
      triageLlmProvider: SecurityTriageLlmProvider;
    };
    credentials: {
      refs: Record<string, {
        source: 'env' | 'local';
        env?: string;
        description?: string;
      }>;
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
    hostMonitoring: {
      enabled: boolean;
      scanIntervalSec: number;
      dedupeWindowMs: number;
      monitorProcesses: boolean;
      monitorPersistence: boolean;
      monitorSensitivePaths: boolean;
      monitorNetwork: boolean;
      monitorFirewall: boolean;
      sensitivePathCount: number;
      suspiciousProcessCount: number;
    };
    gatewayMonitoring: {
      enabled: boolean;
      scanIntervalSec: number;
      dedupeWindowMs: number;
      monitorCount: number;
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
      preferredProviders?: {
        local?: string;
        external?: string;
      };
      webSearch?: {
        provider: string;
        perplexityConfigured: boolean;
        perplexityCredentialRef?: string;
        openRouterConfigured: boolean;
        openRouterCredentialRef?: string;
        braveConfigured: boolean;
        braveCredentialRef?: string;
      };
      search?: {
        enabled: boolean;
        sourceCount: number;
        defaultMode: string;
      };
      cloud?: RedactedCloudConfig;
      agentPolicyUpdates?: {
        allowedPaths: boolean;
        allowedCommands: boolean;
        allowedDomains: boolean;
        toolPolicies: boolean;
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

/** Provider types available from the runtime registry. */
export interface DashboardProviderTypeInfo {
  name: string;
  displayName: string;
  compatible: boolean;
  locality: 'local' | 'external';
}

export interface DashboardProviderModelsInput {
  providerType: string;
  model?: string;
  apiKey?: string;
  credentialRef?: string;
  baseUrl?: string;
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

export interface UIInvalidationEvent {
  topics: string[];
  reason: string;
  path: string;
  timestamp: number;
}

export interface ScheduledTaskHistoryStep {
  toolName: string;
  status: ScheduledTaskStatus;
  message: string;
  durationMs: number;
  output?: unknown;
}

export interface DashboardSecurityAlertsArgs {
  query?: string;
  source?: SecurityAlertSource;
  sources?: SecurityAlertSource[];
  severity?: SecurityAlertSeverity;
  status?: SecurityAlertStatus;
  type?: string;
  limit?: number;
  includeAcknowledged?: boolean;
  includeInactive?: boolean;
}

export interface DashboardSecurityAlertsResult {
  alerts: UnifiedSecurityAlert[];
  totalMatches: number;
  returned: number;
  searchedSources: SecurityAlertSource[];
  includeAcknowledged: boolean;
  includeInactive?: boolean;
  query?: string;
  severity?: SecurityAlertSeverity;
  status?: SecurityAlertStatus;
  type?: string;
  bySource: Record<SecurityAlertSource, number>;
  bySeverity: Record<SecurityAlertSeverity, number>;
}

export interface DashboardSecurityAlertAckInput {
  alertId: string;
  source?: SecurityAlertSource;
}

export interface DashboardSecurityAlertAckResult {
  success: boolean;
  message: string;
  source?: SecurityAlertSource;
}

export interface DashboardSecurityAlertSuppressInput extends DashboardSecurityAlertAckInput {
  suppressedUntil: number;
  reason?: string;
}

export interface DashboardSecurityPostureInput {
  profile?: DeploymentProfile;
  currentMode?: SecurityOperatingMode;
  includeAcknowledged?: boolean;
}

export interface DashboardSecurityContainmentInput {
  profile?: DeploymentProfile;
  currentMode?: SecurityOperatingMode;
}

export interface DashboardSecurityActivityLogArgs {
  limit?: number;
  status?: SecurityActivityStatus;
  agentId?: string;
}

export interface DashboardWindowsDefenderStatusResult {
  status: WindowsDefenderProviderStatus;
  alerts: WindowsDefenderAlert[];
}

export interface DashboardWindowsDefenderScanInput {
  type: 'quick' | 'full' | 'custom';
  path?: string;
}

export interface DashboardWindowsDefenderActionResult {
  success: boolean;
  message: string;
}

/** SSE event pushed to dashboard clients. */
export interface SSEEvent {
  type: 'audit' | 'metrics' | 'watchdog' | 'security.alert' | 'security.triage' | 'assistant.notice' | 'chat.thinking' | 'chat.tool_call' | 'chat.token' | 'chat.done' | 'chat.error' | 'ui.invalidate' | 'terminal.output' | 'terminal.exit';
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
  onProviderTypes?: () => DashboardProviderTypeInfo[];
  onProvidersStatus?: () => Promise<DashboardProviderInfo[]>;
  onProviderModels?: (input: DashboardProviderModelsInput) => Promise<{ models: string[] }>;
  onAssistantState?: () => DashboardAssistantState;
  onSSESubscribe?: (listener: SSEListener) => () => void;
  onDispatch?: (
    agentId: string,
    message: {
      content: string;
      userId?: string;
      principalId?: string;
      principalRole?: import('../tools/types.js').PrincipalRole;
      channel?: string;
      metadata?: Record<string, unknown>;
    },
    routeDecision?: { fallbackAgentId?: string; complexityScore?: number; tier?: string },
    options?: { priority?: 'high' | 'normal' | 'low'; requestType?: string },
  ) => Promise<{ content: string; metadata?: Record<string, unknown> }>;
  onConfigUpdate?: (updates: ConfigUpdate) => Promise<{ success: boolean; message: string }>;
  onConversationReset?: (args: {
    agentId: string;
    userId: string;
    channel: string;
  }) => Promise<{ success: boolean; message: string }> | { success: boolean; message: string };
  onCodeSessionsList?: (args: {
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
  }) => DashboardCodeSessionsList;
  onCodeSessionGet?: (args: {
    sessionId: string;
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
    historyLimit?: number;
  }) => DashboardCodeSessionSnapshot | null;
  onCodeSessionCreate?: (args: {
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
    title: string;
    workspaceRoot: string;
    agentId?: string | null;
    attach?: boolean;
  }) => DashboardCodeSessionSnapshot;
  onCodeSessionUpdate?: (args: {
    sessionId: string;
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
    title?: string;
    workspaceRoot?: string;
    agentId?: string | null;
    status?: CodeSessionStatus;
    uiState?: Partial<CodeSessionUiState>;
    workState?: Partial<CodeSessionWorkState>;
  }) => DashboardCodeSessionSnapshot | null;
  onCodeSessionDelete?: (args: {
    sessionId: string;
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
  }) => { success: boolean; currentSessionId: string | null };
  onCodeSessionAttach?: (args: {
    sessionId: string;
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
    mode?: CodeSessionAttachmentMode;
  }) => { success: boolean; snapshot?: DashboardCodeSessionSnapshot };
  onCodeSessionDetach?: (args: {
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
  }) => { success: boolean };
  onCodeSessionMessage?: (args: {
    sessionId: string;
    userId: string;
    principalId?: string;
    principalRole?: import('../tools/types.js').PrincipalRole;
    channel: string;
    surfaceId: string;
    content: string;
  }) => Promise<{
    content: string;
    metadata?: Record<string, unknown>;
  }>;
  onCodeSessionApprovalDecision?: (input: {
    sessionId: string;
    approvalId: string;
    decision: 'approved' | 'denied';
    userId: string;
    principalId?: string;
    principalRole?: import('../tools/types.js').PrincipalRole;
    channel: string;
    surfaceId: string;
    reason?: string;
  }) => Promise<{
    success: boolean;
    message: string;
    continueConversation?: boolean;
    displayMessage?: string;
    continuedResponse?: {
      content: string;
      metadata?: Record<string, unknown>;
    };
  }>;
  onCodeSessionResetConversation?: (args: {
    sessionId: string;
    userId: string;
    channel: string;
  }) => { success: boolean; message: string };
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
    principalId?: string;
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
    principalId?: string;
    principalRole?: import('../tools/types.js').PrincipalRole;
    contentTrustLevel?: import('../tools/types.js').ContentTrustLevel;
    taintReasons?: string[];
    derivedFromTaintedContent?: boolean;
    scheduleId?: string;
    channel?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<ToolRunResponse> | ToolRunResponse;
  onToolsPreflight?: (input: { tools?: string[]; requests?: Array<{ name: string; args?: Record<string, unknown> }> }) => {
    results: Array<{
      name: string;
      found: boolean;
      risk: string;
      decision: 'allow' | 'deny' | 'require_approval';
      reason: string;
      fixes: Array<{ type: 'tool_policy' | 'domain' | 'command' | 'path'; value: string; description: string }>;
    }>;
    policy: { mode: string; allowedPaths?: string[]; allowedCommands?: string[]; allowedDomains?: string[] };
  };
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
    playwrightEnabled?: boolean;
    lightpandaEnabled?: boolean;
    playwrightBrowser?: string;
    playwrightCaps?: string;
  }) => { success: boolean; message: string };
  onBrowserConfigState?: () => { enabled: boolean; allowedDomains: string[]; playwrightEnabled: boolean; lightpandaEnabled: boolean; playwrightBrowser: string; playwrightCaps: string };
  onToolsApprovalDecision?: (input: {
    approvalId: string;
    decision: 'approved' | 'denied';
    actor: string;
    actorRole?: import('../tools/types.js').PrincipalRole;
    reason?: string;
  }) => Promise<{
    success: boolean;
    message: string;
    continueConversation?: boolean;
    displayMessage?: string;
  }> | {
    success: boolean;
    message: string;
    continueConversation?: boolean;
    displayMessage?: string;
  };
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
  onNetworkScan?: () => Promise<{ success: boolean; message: string; devicesFound: number; run?: ConnectorPlaybookRunResult['run'] }>;
  onNetworkBaseline?: () => NetworkBaselineSnapshot;
  onNetworkThreats?: (args?: { includeAcknowledged?: boolean; limit?: number }) => {
    alerts: NetworkAlert[];
    activeAlertCount: number;
    bySeverity: { low: number; medium: number; high: number; critical: number };
    baselineReady: boolean;
    snapshotCount: number;
  };
  onNetworkThreatAcknowledge?: (alertId: string) => { success: boolean; message: string };
  onSecurityAlerts?: (args?: DashboardSecurityAlertsArgs) => DashboardSecurityAlertsResult;
  onSecurityAlertAcknowledge?: (input: DashboardSecurityAlertAckInput) => DashboardSecurityAlertAckResult;
  onSecurityAlertResolve?: (input: DashboardSecurityAlertAckInput & { reason?: string }) => DashboardSecurityAlertAckResult;
  onSecurityAlertSuppress?: (input: DashboardSecurityAlertSuppressInput) => DashboardSecurityAlertAckResult;
  onSecurityPosture?: (args?: DashboardSecurityPostureInput) => SecurityPostureAssessment;
  onSecurityContainmentStatus?: (args?: DashboardSecurityContainmentInput) => SecurityContainmentState;
  onSecurityActivityLog?: (args?: DashboardSecurityActivityLogArgs) => SecurityActivityListResult;
  onWindowsDefenderStatus?: () => DashboardWindowsDefenderStatusResult;
  onWindowsDefenderRefresh?: () => Promise<DashboardWindowsDefenderStatusResult> | DashboardWindowsDefenderStatusResult;
  onWindowsDefenderScan?: (input: DashboardWindowsDefenderScanInput) => Promise<DashboardWindowsDefenderActionResult> | DashboardWindowsDefenderActionResult;
  onWindowsDefenderUpdateSignatures?: () => Promise<DashboardWindowsDefenderActionResult> | DashboardWindowsDefenderActionResult;
  onHostMonitorStatus?: () => HostMonitorStatus;
  onHostMonitorAlerts?: (args?: { includeAcknowledged?: boolean; limit?: number }) => {
    alerts: HostMonitorAlert[];
    activeAlertCount: number;
    bySeverity: { low: number; medium: number; high: number; critical: number };
    baselineReady: boolean;
    lastUpdatedAt: number;
  };
  onHostMonitorAcknowledge?: (alertId: string) => { success: boolean; message: string };
  onHostMonitorCheck?: () => Promise<HostMonitorReport> | HostMonitorReport;
  onGatewayMonitorStatus?: () => GatewayMonitorStatus;
  onGatewayMonitorAlerts?: (args?: { includeAcknowledged?: boolean; limit?: number }) => {
    alerts: GatewayMonitorAlert[];
    activeAlertCount: number;
    bySeverity: { low: number; medium: number; high: number; critical: number };
    baselineReady: boolean;
    lastUpdatedAt: number;
  };
  onGatewayMonitorAcknowledge?: (alertId: string) => { success: boolean; message: string };
  onGatewayMonitorCheck?: () => Promise<GatewayMonitorReport> | GatewayMonitorReport;
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
    message: {
      content: string;
      userId?: string;
      principalId?: string;
      principalRole?: import('../tools/types.js').PrincipalRole;
      channel?: string;
      metadata?: Record<string, unknown>;
    },
    emitSSE: (event: SSEEvent) => void,
  ) => Promise<{ requestId: string; content: string; metadata?: Record<string, unknown> }>;
  onTelegramReload?: () => Promise<{ success: boolean; message: string }>;
  onCloudTest?: (provider: string, profileId: string) => Promise<{ success: boolean; message: string }>;
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
    id: string;
    taskId: string;
    taskName: string;
    taskType: 'tool' | 'playbook' | 'agent';
    target: string;
    timestamp: number;
    status: ScheduledTaskStatus;
    durationMs: number;
    message: string;
    output?: unknown;
    steps?: ScheduledTaskHistoryStep[];
  }>;
  onSearchStatus?: () => any;
  onSearchSources?: () => any;
  onSearchSourceAdd?: (source: any) => any;
  onSearchSourceRemove?: (id: string) => any;
  onSearchSourceToggle?: (id: string, enabled: boolean) => any;
  onSearchReindex?: (collection?: string) => Promise<any>;
  onSearchPickPath?: (input: { kind: 'directory' | 'file' }) => Promise<{
    success: boolean;
    path?: string;
    canceled?: boolean;
    message: string;
  }>;
  onGwsStatus?: () => Promise<GwsConnectionStatus>;
  /** Native Google Workspace status. */
  onGoogleStatus?: () => Promise<{
    authenticated: boolean;
    tokenExpiry?: number;
    services: string[];
    mode: 'native';
  }>;
  /** Start native Google OAuth flow. */
  onGoogleAuthStart?: (services: string[]) => Promise<{
    success: boolean;
    authUrl?: string;
    state?: string;
    message?: string;
  }>;
  /** Upload client_secret.json credentials. */
  onGoogleCredentials?: (credentials: string) => Promise<{ success: boolean; message: string }>;
  /** Disconnect native Google integration. */
  onGoogleDisconnect?: () => Promise<{ success: boolean; message: string }>;
  /** Native Microsoft 365 status. */
  onMicrosoftStatus?: () => Promise<{
    authenticated: boolean;
    tokenExpiry?: number;
    services: string[];
    clientId?: string;
    tenantId?: string;
  }>;
  /** Start native Microsoft OAuth flow. */
  onMicrosoftAuthStart?: (services: string[]) => Promise<{
    success: boolean;
    authUrl?: string;
    state?: string;
    message?: string;
  }>;
  /** Save Microsoft client ID / tenant ID config. */
  onMicrosoftConfig?: (config: { clientId: string; tenantId?: string }) => Promise<{ success: boolean; message: string }>;
  /** Disconnect native Microsoft integration. */
  onMicrosoftDisconnect?: () => Promise<{ success: boolean; message: string }>;
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
      botTokenCredentialRef?: string;
      allowedChatIds?: number[];
      polling?: boolean;
      defaultAgent?: string;
    };
  };
  assistant?: {
    security?: {
      deploymentProfile?: DeploymentProfile;
      operatingMode?: SecurityOperatingMode;
      triageLlmProvider?: SecurityTriageLlmProvider;
    };
    credentials?: {
      refs?: Record<string, {
        source?: 'env' | 'local';
        env?: string;
        secretId?: string;
        secretValue?: string;
        description?: string;
      }>;
    };
    notifications?: {
      enabled?: boolean;
      minSeverity?: AuditSeverity;
      auditEventTypes?: AuditEventType[];
      suppressedDetailTypes?: string[];
      cooldownMs?: number;
      deliveryMode?: 'all' | 'selected';
      destinations?: {
        web?: boolean;
        cli?: boolean;
        telegram?: boolean;
      };
    };
    tools?: {
      preferredProviders?: {
        local?: string;
        external?: string;
      };
      cloud?: {
        enabled?: boolean;
        cpanelProfiles?: Array<{
          id: string;
          name: string;
          type: 'cpanel' | 'whm';
          host: string;
          port?: number;
          username: string;
          apiToken?: string;
          credentialRef?: string;
          ssl?: boolean;
          allowSelfSigned?: boolean;
          defaultCpanelUser?: string;
        }>;
        vercelProfiles?: Array<{
          id: string;
          name: string;
          apiBaseUrl?: string;
          apiToken?: string;
          credentialRef?: string;
          teamId?: string;
          slug?: string;
        }>;
        cloudflareProfiles?: Array<{
          id: string;
          name: string;
          apiBaseUrl?: string;
          apiToken?: string;
          credentialRef?: string;
          accountId?: string;
          defaultZoneId?: string;
        }>;
        awsProfiles?: Array<{
          id: string;
          name: string;
          region: string;
          accessKeyId?: string;
          accessKeyIdCredentialRef?: string;
          secretAccessKey?: string;
          secretAccessKeyCredentialRef?: string;
          sessionToken?: string;
          sessionTokenCredentialRef?: string;
          endpoints?: {
            sts?: string;
            ec2?: string;
            s3?: string;
            route53?: string;
            lambda?: string;
            cloudwatch?: string;
            cloudwatchLogs?: string;
            rds?: string;
            iam?: string;
            costExplorer?: string;
          };
        }>;
        gcpProfiles?: Array<{
          id: string;
          name: string;
          projectId: string;
          location?: string;
          accessToken?: string;
          accessTokenCredentialRef?: string;
          serviceAccountJson?: string;
          serviceAccountCredentialRef?: string;
          endpoints?: {
            oauth2Token?: string;
            cloudResourceManager?: string;
            serviceUsage?: string;
            compute?: string;
            run?: string;
            storage?: string;
            dns?: string;
            logging?: string;
          };
        }>;
        azureProfiles?: Array<{
          id: string;
          name: string;
          subscriptionId: string;
          tenantId?: string;
          accessToken?: string;
          accessTokenCredentialRef?: string;
          clientId?: string;
          clientIdCredentialRef?: string;
          clientSecret?: string;
          clientSecretCredentialRef?: string;
          defaultResourceGroup?: string;
          blobBaseUrl?: string;
          endpoints?: {
            oauth2Token?: string;
            management?: string;
          };
        }>;
      };
      search?: {
        enabled?: boolean;
        sources?: Array<{
          id: string;
          name: string;
          type: 'directory' | 'git' | 'url' | 'file';
          path: string;
          globs?: string[];
          branch?: string;
          enabled?: boolean;
          description?: string;
        }>;
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
        toolPolicies?: boolean;
      };
    };
  };
}

export interface DashboardCodeSessionSnapshot {
  session: CodeSessionRecord;
  history: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
  }>;
  attached: boolean;
  attachment?: CodeSessionAttachmentRecord | null;
}

export interface DashboardCodeSessionsList {
  sessions: CodeSessionRecord[];
  currentSessionId: string | null;
}
