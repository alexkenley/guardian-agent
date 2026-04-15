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
import type {
  MemoryArtifactClass,
  MemorySourceType,
  MemoryStatus,
  MemoryTrustLevel,
  StoredMemoryEntry,
} from '../runtime/agent-memory-store.js';
import type { QuickActionDefinition } from '../quick-actions.js';
import type { SetupStatus, SetupApplyInput, SearchConfigInput } from '../runtime/setup.js';
import type { AnalyticsSummary, AnalyticsEventInput } from '../runtime/analytics.js';
import type { ConversationSessionInfo } from '../runtime/conversation.js';
import type {
  SecondBrainBriefRecord,
  SecondBrainBriefFilter,
  SecondBrainBriefUpdateInput,
  SecondBrainGenerateBriefInput,
  SecondBrainEventFilter,
  SecondBrainEventRecord,
  SecondBrainEventUpsertInput,
  SecondBrainLinkFilter,
  SecondBrainLinkRecord,
  SecondBrainLinkUpsertInput,
  SecondBrainNoteFilter,
  SecondBrainNoteRecord,
  SecondBrainNoteUpsertInput,
  SecondBrainOverview,
  SecondBrainPersonFilter,
  SecondBrainPersonRecord,
  SecondBrainPersonUpsertInput,
  SecondBrainRoutineCreateInput,
  SecondBrainRoutineTypeView,
  SecondBrainRoutineUpdateInput,
  SecondBrainRoutineView,
  SecondBrainTaskFilter,
  SecondBrainTaskRecord,
  SecondBrainTaskUpsertInput,
  SecondBrainUsageSummary,
} from '../runtime/second-brain/types.js';
import type { ResponseSourceMetadata } from '../runtime/model-routing-ux.js';
import type { AssistantOrchestratorState } from '../runtime/orchestrator.js';
import type { RouteDecision } from '../runtime/message-router.js';
import type { ProviderLocality, ProviderTier } from '../llm/provider-metadata.js';
import type {
  AssistantConnectorPackConfig,
  AssistantConnectorPlaybookDefinition,
  AssistantResponseStyleLevel,
  ConnectorExecutionMode,
  OllamaOptionsConfig,
  OllamaThinkConfig,
  RoutingTierMode,
} from '../config/types.js';
import type {
  AiSecurityFinding,
  AiSecurityFindingStatus,
  AiSecurityProfile,
  AiSecurityRun,
  AiSecurityScanInput,
  AiSecurityScanResult,
  AiSecuritySummary,
  AiSecurityTarget,
} from '../runtime/ai-security.js';
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
import type { ScheduledTaskDefinition, ScheduledTaskCreateInput, ScheduledTaskUpdateInput, ScheduledTaskStatus } from '../runtime/scheduled-tasks.js';
import type { AutomationCatalogCreateResult } from '../runtime/automation-catalog-actions.js';
import type { AutomationCatalogViewEntry } from '../runtime/automation-catalog-view.js';
import type { AutomationRunHistoryEntry } from '../runtime/automation-run-history.js';
import type { AutomationSaveInput, AutomationSaveResult } from '../runtime/automation-save.js';
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
import type {
  AssistantSecurityAutoContainmentCategory,
  AssistantSecurityAutoContainmentSeverity,
  AssistantSecurityMonitoringProfile,
  SecurityTriageLlmProvider,
} from '../runtime/security-controls.js';
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
  CodeSessionManagedSandbox,
  CodeSessionRecord,
  CodeSessionStatus,
  CodeSessionUiState,
  CodeSessionWorkState,
} from '../runtime/code-sessions.js';
import type { RemoteExecutionTargetDescriptor } from '../runtime/remote-execution/policy.js';
import type {
  DashboardCodeSessionTimelineResponse,
  DashboardRunDetail,
  DashboardRunKind,
  DashboardRunListResponse,
  DashboardRunStatus,
} from '../runtime/run-timeline.js';

/** Agent info returned by GET /api/agents. */
export interface DashboardAgentInfo {
  id: string;
  name: string;
  state: string;
  canChat?: boolean;
  /** Internal agents are used by tier routing and hidden from user-facing selectors. */
  internal?: boolean;
  /** Tier-routing role when this agent is the runtime's local or external lane. */
  routingRole?: 'local' | 'external';
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

export interface DashboardMemoryArtifactSummary {
  activeEntries: number;
  inactiveEntries: number;
  quarantinedEntries: number;
  operatorEntries: number;
  derivedEntries: number;
  contextFlushEntries: number;
  categories: string[];
  lastCreatedAt?: string;
}

export interface DashboardChatProviderOption {
  value: string;
  label: string;
  providerName?: string;
  providerType?: string;
  providerTier?: ProviderTier;
  providerLocality?: ProviderLocality;
  model?: string;
}

export interface DashboardMemoryScopeView {
  scope: 'global' | 'code_session';
  scopeId: string;
  title: string;
  description: string;
  editable: boolean;
  reviewOnly: boolean;
  summary: DashboardMemoryArtifactSummary;
  entries: DashboardMemoryEntryView[];
  wikiPages: DashboardMemoryWikiPageView[];
  lintFindings: DashboardMemoryLintFinding[];
  renderedMarkdown: string;
}

export interface DashboardMemoryResponse {
  generatedAt: string;
  principalAgentId: string;
  canEdit: boolean;
  global: DashboardMemoryScopeView;
  codeSessions: DashboardMemoryScopeView[];
  maintenance: DashboardMemoryMaintenanceSummary;
  recentAudit: DashboardMemoryAuditEventView[];
  recentJobs: DashboardMemoryMaintenanceJobView[];
}

export interface DashboardMemoryEntryView extends StoredMemoryEntry {
  sourceClass: MemoryArtifactClass;
  displayTitle: string;
  editable: boolean;
  reviewOnly: boolean;
}

export interface DashboardMemoryWikiPageView {
  id: string;
  entryId?: string;
  scope: 'global' | 'code_session';
  scopeId: string;
  title: string;
  slug: string;
  kind: 'curated_page' | 'topic_index' | 'decision_index' | 'automation_index' | 'review_queue' | 'context_flush_index';
  sourceClass: MemoryArtifactClass;
  editable: boolean;
  reviewOnly: boolean;
  status: MemoryStatus;
  summary?: string;
  body: string;
  renderedMarkdown: string;
  tags: string[];
  createdAt?: string;
  updatedAt?: string;
  createdByPrincipal?: string;
  reason?: string;
  sourceEntryIds?: string[];
}

export interface DashboardMemoryLintFinding {
  id: string;
  scope: 'global' | 'code_session';
  scopeId: string;
  severity: AuditSeverity;
  kind: 'duplicate' | 'stale' | 'oversized' | 'orphan_reference' | 'review_queue';
  title: string;
  detail: string;
  entryIds?: string[];
  relatedEntries?: DashboardMemoryLintRelatedEntry[];
}

export interface DashboardMemoryLintRelatedEntry {
  id: string;
  title: string;
  sourceClass: MemoryArtifactClass;
  status: MemoryStatus;
  reviewOnly: boolean;
  editable: boolean;
}

export interface DashboardMemoryAuditEventView {
  id: string;
  timestamp: number;
  severity: AuditSeverity;
  type: string;
  summary: string;
  detail?: string;
  actor?: string;
  entryId?: string;
  scope?: 'global' | 'code_session';
  scopeId?: string;
}

export interface DashboardMemoryMaintenanceJobView {
  id: string;
  type: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: number;
  completedAt?: number;
  detail?: string;
  scope?: string;
  artifact?: string;
}

export interface DashboardMemoryMaintenanceSummary {
  readOnly: boolean;
  scopeCount: number;
  wikiPageCount: number;
  lintFindingCount: number;
  reviewOnlyCount: number;
  operatorPageCount: number;
  recentAuditCount: number;
  recentMaintenanceCount: number;
}

export interface DashboardMemoryFilterInput {
  includeInactive?: boolean;
  includeCodeSessions?: boolean;
  codeSessionId?: string;
  query?: string;
  sourceType?: MemorySourceType;
  trustLevel?: MemoryTrustLevel;
  status?: MemoryStatus;
  limit?: number;
}

export interface DashboardMemoryMutationInput {
  action: 'create' | 'update' | 'archive';
  scope: 'global' | 'code_session';
  codeSessionId?: string;
  entryId?: string;
  title?: string;
  content?: string;
  summary?: string;
  tags?: string[];
  reason?: string;
  actor?: string;
}

export interface DashboardMemoryMaintenanceInput {
  scope: 'global' | 'code_session';
  codeSessionId?: string;
  maintenanceType?: 'consolidation' | 'idle_sweep';
  actor?: string;
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
  sandbox?: {
    enabled: boolean;
    ready: boolean;
    projectId?: string;
    baseSnapshotId?: string;
    defaultTimeoutMs?: number;
    defaultVcpus?: number;
    allowNetwork: boolean;
    allowedDomains?: string[];
  };
}

export interface RedactedCloudDaytonaProfile {
  id: string;
  name: string;
  apiUrl?: string;
  credentialRef?: string;
  apiKeyConfigured: boolean;
  target?: string;
  language?: string;
  snapshot?: string;
  enabled: boolean;
  ready: boolean;
  defaultTimeoutMs?: number;
  defaultVcpus?: number;
  allowNetwork: boolean;
  allowedCidrs?: string[];
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
  defaultRemoteExecutionTargetId?: string;
  cpanelProfiles: RedactedCloudCpanelProfile[];
  vercelProfiles: RedactedCloudVercelProfile[];
  daytonaProfiles: RedactedCloudDaytonaProfile[];
  cloudflareProfiles: RedactedCloudCloudflareProfile[];
  awsProfiles: RedactedCloudAwsProfile[];
  gcpProfiles: RedactedCloudGcpProfile[];
  azureProfiles: RedactedCloudAzureProfile[];
  profileCounts: {
    cpanel: number;
    vercel: number;
    daytona: number;
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
  llm: Record<string, {
    provider: string;
    enabled?: boolean;
    model: string;
    baseUrl?: string;
    credentialRef?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    keepAlive?: string | number;
    think?: OllamaThinkConfig;
    ollamaOptions?: OllamaOptionsConfig;
  }>;
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
        mode: 'bearer_required' | 'disabled';
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
    secondBrain?: {
      enabled: boolean;
      onboarding: {
        completed: boolean;
        dismissed: boolean;
      };
      profile: {
        timezone?: string;
        workdayStart?: string;
        workdayEnd?: string;
        proactivityLevel: 'minimal' | 'balanced' | 'proactive';
      };
      delivery: {
        defaultChannels: Array<'web' | 'cli' | 'telegram'>;
      };
      knowledge: {
        prioritizeConnectedSources: boolean;
        defaultRetrievalMode: 'hybrid' | 'library_first' | 'search_first';
        rerankerEnabled: boolean;
      };
    };
    responseStyle?: {
      enabled: boolean;
      level: AssistantResponseStyleLevel;
    };
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
      continuousMonitoring: {
        enabled: boolean;
        profileId: AssistantSecurityMonitoringProfile;
        cron: string;
      };
      autoContainment: {
        enabled: boolean;
        minSeverity: AssistantSecurityAutoContainmentSeverity;
        minConfidence: number;
        categories: AssistantSecurityAutoContainmentCategory[];
      };
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
      allowedDomains: string[];
      preferredProviders?: {
        local?: string;
        managedCloud?: string;
        frontier?: string;
        external?: string;
      };
      modelSelection?: {
        autoPolicy: 'balanced' | 'quality_first';
        preferManagedCloudForLowPressureExternal: boolean;
        preferFrontierForRepoGrounded: boolean;
        preferFrontierForSecurity: boolean;
        managedCloudRouting?: {
          enabled: boolean;
          roleBindings?: {
            general?: string;
            direct?: string;
            toolLoop?: string;
            coding?: string;
          };
        };
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
      sandbox?: {
        enforcementMode: 'strict' | 'permissive';
        degradedFallback: {
          allowNetworkTools: boolean;
          allowBrowserTools: boolean;
          allowMcpServers: boolean;
          allowPackageManagers: boolean;
          allowManualCodeTerminals: boolean;
        };
      };
      browser?: {
        enabled: boolean;
        allowedDomains: string[];
        playwrightEnabled: boolean;
        playwrightBrowser: string;
        playwrightCaps: string;
      };
      codingBackends?: {
        enabled: boolean;
        defaultBackend?: string;
        maxConcurrentSessions: number;
        autoUpdate: boolean;
        versionCheckIntervalMs: number;
        backends: DashboardCodingBackendInfo[];
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
  mode: 'bearer_required' | 'disabled';
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
  /** Whether smart provider routing is enabled (default: true). When false, all tools use the derived primary provider. */
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
  /** Explicit provider tier used for managed-cloud vs frontier badging. */
  tier?: 'local' | 'managed_cloud' | 'frontier';
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
  tier: 'local' | 'managed_cloud' | 'frontier';
  requiresCredential: boolean;
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
  intentRoutingTrace?: {
    enabled: boolean;
    filePath: string;
    lastError?: string;
  };
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
      display?: {
        originSummary: string;
        outcomeSummary: string;
        followUp?: {
          reportingMode: 'inline_response' | 'held_for_approval' | 'status_only' | 'held_for_operator';
          label: string;
          needsOperatorAction: boolean;
          blockerKind?: string;
          approvalCount?: number;
          nextAction?: string;
          operatorState?: 'pending' | 'kept_held' | 'replayed' | 'dismissed';
          actions?: Array<'replay' | 'keep_held' | 'dismiss'>;
        };
      };
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

export interface DashboardIntentRoutingTraceEntry {
  id: string;
  timestamp: number;
  stage: string;
  requestId?: string;
  messageId?: string;
  userId?: string;
  channel?: string;
  agentId?: string;
  contentPreview?: string;
  details?: Record<string, unknown>;
  matchedRun?: {
    runId: string;
    title: string;
    status: string;
    kind: string;
    href: string;
    codeSessionId?: string;
    codeSessionHref?: string;
    focusItemId?: string;
    focusItemTitle?: string;
    focusItemHref?: string;
  };
}

export interface DashboardIntentRoutingTraceResponse {
  entries: DashboardIntentRoutingTraceEntry[];
}

export interface UIInvalidationEvent {
  topics: string[];
  reason: string;
  path: string;
  timestamp: number;
}

export interface DashboardCodeTerminalEvent {
  action: 'opened' | 'exited';
  terminalId: string;
  shell: string;
  cwd: string;
  cols?: number;
  rows?: number;
  codeSessionId?: string | null;
  exitCode?: number;
  signal?: number;
}

export interface DashboardCodingBackendInfo {
  id: string;
  name: string;
  configured: boolean;
  preset: boolean;
  enabled: boolean;
  shell?: string;
  command: string;
  args: string[];
  versionCommand?: string;
  updateCommand?: string;
  timeoutMs?: number;
  nonInteractive?: boolean;
  envKeys?: string[];
  installedVersion?: string;
  updateAvailable?: boolean;
  lastVersionCheck?: number;
}

export interface DashboardCodingBackendSession {
  id: string;
  backendId: string;
  backendName: string;
  codeSessionId: string;
  terminalId: string;
  task: string;
  status: 'running' | 'succeeded' | 'failed' | 'timed_out';
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  durationMs?: number;
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
  type: 'audit' | 'metrics' | 'watchdog' | 'security.alert' | 'security.triage' | 'assistant.notice' | 'chat.thinking' | 'chat.tool_call' | 'chat.token' | 'chat.done' | 'chat.error' | 'ui.invalidate' | 'terminal.output' | 'terminal.exit' | 'run.timeline';
  data: unknown;
}

/** SSE listener callback for real-time events. */
export type SSEListener = (event: SSEEvent) => void;

export interface DashboardMutationResult {
  success: boolean;
  message: string;
  statusCode?: number;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export type DashboardSecondBrainOverview = SecondBrainOverview;
export type DashboardSecondBrainBrief = SecondBrainBriefRecord;
export type DashboardSecondBrainEvent = SecondBrainEventRecord;
export type DashboardSecondBrainTask = SecondBrainTaskRecord;
export type DashboardSecondBrainNote = SecondBrainNoteRecord;
export type DashboardSecondBrainPerson = SecondBrainPersonRecord;
export type DashboardSecondBrainLink = SecondBrainLinkRecord;
export type DashboardSecondBrainRoutine = SecondBrainRoutineView;
export type DashboardSecondBrainRoutineCatalogEntry = SecondBrainRoutineTypeView;
export type DashboardSecondBrainUsage = SecondBrainUsageSummary;

export interface PerformanceActionPreviewTarget {
  targetId: string;
  name?: string;
  label?: string;
  pid?: number;
  cpuPercent?: number;
  memoryMb?: number;
  suggestedReason: string;
  checkedByDefault: boolean;
  selectable: boolean;
  blockedReason?: string;
  risk: 'low' | 'medium' | 'high';
}

export interface PerformanceActionPreview {
  previewId: string;
  profileId?: string;
  processTargets: PerformanceActionPreviewTarget[];
  cleanupTargets: PerformanceActionPreviewTarget[];
}

export interface ApprovedPerformanceAction {
  previewId: string;
  selectedProcessTargetIds: string[];
  selectedCleanupTargetIds: string[];
}

export interface PerformanceProcessSummary {
  targetId: string;
  pid: number;
  name: string;
  cpuPercent?: number;
  cpuTimeSec?: number;
  memoryMb?: number;
  executablePath?: string;
  protected?: boolean;
  protectionReason?: string;
}

export interface PerformanceProfileSummary {
  id: string;
  name: string;
  powerMode?: 'balanced' | 'high_performance' | 'power_saver';
  autoActionsEnabled: boolean;
  allowedActionIds: string[];
  terminateProcessNames: string[];
  protectProcessNames: string[];
  latencyTargets?: Array<{
    id: string;
    kind: 'internet' | 'api';
    target?: string;
    targetRef?: string;
  }>;
}

export interface PerformanceLatencyStatus {
  id: string;
  kind: 'internet' | 'api';
  label: string;
  target?: string;
  state: 'ok' | 'error' | 'disabled' | 'idle';
  latencyMs?: number;
  detail?: string;
}

export interface PerformanceActionHistoryEntry {
  id: string;
  actionId: string;
  executedAt: number;
  success: boolean;
  message: string;
  selectedProcessCount: number;
  selectedCleanupCount: number;
}

export interface PerformanceCapabilities {
  canManageProcesses: boolean;
  canManagePower: boolean;
  canRunCleanup: boolean;
  canProbeLatency: boolean;
  supportedActionIds: string[];
}

export interface PerformanceSnapshot {
  cpuPercent: number;
  memoryMb: number;
  memoryTotalMb?: number;
  memoryPercent?: number;
  diskFreeMb: number;
  diskTotalMb?: number;
  diskPercentFree?: number;
  activeProfile: string;
  processCount?: number;
  topProcesses?: PerformanceProcessSummary[];
  sampledAt: number;
}

export interface PerformanceStatus {
  activeProfile: string;
  os: string;
  snapshot: PerformanceSnapshot;
  capabilities: PerformanceCapabilities;
  profiles: PerformanceProfileSummary[];
  latencyTargets: PerformanceLatencyStatus[];
  history: PerformanceActionHistoryEntry[];
}

/** Dashboard API callbacks supplied by index.ts to WebChannel. */
export interface DashboardCallbacks {
  onPerformanceStatus?: () => Promise<PerformanceStatus>;
  onPerformanceProcesses?: () => Promise<PerformanceProcessSummary[]>;
  onPerformanceApplyProfile?: (profileId: string) => Promise<{ success: boolean; message: string }>;
  onPerformancePreviewAction?: (actionId: string) => Promise<PerformanceActionPreview>;
  onPerformanceRunAction?: (action: ApprovedPerformanceAction) => Promise<{ success: boolean; message: string }>;
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
  onCodingBackendStatus?: (sessionId?: string) => DashboardCodingBackendSession[];
  onAssistantState?: () => DashboardAssistantState;
  onAssistantJobFollowUpAction?: (input: {
    jobId: string;
    action: 'replay' | 'keep_held' | 'dismiss';
  }) => Promise<DashboardMutationResult> | DashboardMutationResult;
  onAssistantRuns?: (args: {
    limit?: number;
    status?: DashboardRunStatus;
    kind?: DashboardRunKind;
    channel?: string;
    agentId?: string;
    codeSessionId?: string;
    continuityKey?: string;
    activeExecutionRef?: string;
  }) => DashboardRunListResponse;
  onIntentRoutingTrace?: (args: {
    limit?: number;
    continuityKey?: string;
    activeExecutionRef?: string;
    stage?: string;
    channel?: string;
    agentId?: string;
    userId?: string;
    requestId?: string;
  }) => Promise<DashboardIntentRoutingTraceResponse> | DashboardIntentRoutingTraceResponse;
  onAssistantRunDetail?: (runId: string) => DashboardRunDetail | null;
  onSSESubscribe?: (listener: SSEListener) => () => void;
  onDispatch?: (
    agentId: string,
    message: {
      content: string;
      userId?: string;
      surfaceId?: string;
      principalId?: string;
      principalRole?: import('../tools/types.js').PrincipalRole;
      channel?: string;
      metadata?: Record<string, unknown>;
    },
    routeDecision?: RouteDecision,
    options?: { priority?: 'high' | 'normal' | 'low'; requestType?: string; requestId?: string },
    precomputedIntentGateway?: import('../runtime/intent-gateway.js').IntentGatewayRecord | null,
  ) => Promise<{ content: string; metadata?: Record<string, unknown> }>;
  onConfigUpdate?: (updates: ConfigUpdate) => Promise<DashboardMutationResult>;
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
  onCodeSessionTimeline?: (args: {
    sessionId: string;
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
    limit?: number;
  }) => DashboardCodeSessionTimelineResponse | null;
  onCodeSessionSandboxes?: (args: {
    sessionId: string;
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
  }) => Promise<DashboardCodeSessionSandboxesResponse | null> | DashboardCodeSessionSandboxesResponse | null;
  onCodeTerminalAccessCheck?: () => {
    allowed: boolean;
    reason?: string;
  };
  onCodeTerminalEvent?: (event: DashboardCodeTerminalEvent) => void;
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
  onCodeSessionSandboxCreate?: (args: {
    sessionId: string;
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
    targetId?: string;
    profileId?: string;
    runtime?: string;
    vcpus?: number;
  }) => Promise<DashboardCodeSessionSandboxesResponse> | DashboardCodeSessionSandboxesResponse;
  onCodeSessionSandboxDelete?: (args: {
    sessionId: string;
    leaseId: string;
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
  }) => Promise<DashboardCodeSessionSandboxesResponse> | DashboardCodeSessionSandboxesResponse;
  onCodeSessionDelete?: (args: {
    sessionId: string;
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
  }) => Promise<{ success: boolean; currentSessionId: string | null }> | { success: boolean; currentSessionId: string | null };
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
  onCodeSessionSetReferences?: (args: {
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
    referencedSessionIds: string[];
  }) => DashboardCodeSessionsList;
  onCodeSessionSetTarget?: (args: {
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
    targetSessionId?: string | null;
  }) => DashboardCodeSessionsList;
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
  onMemoryView?: (args?: DashboardMemoryFilterInput) => DashboardMemoryResponse;
  onMemoryCurate?: (input: DashboardMemoryMutationInput) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onMemoryMaintenance?: (input: DashboardMemoryMaintenanceInput) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainOverview?: () => DashboardSecondBrainOverview;
  onSecondBrainGenerateBrief?: (input: SecondBrainGenerateBriefInput) => DashboardSecondBrainBrief | Promise<DashboardSecondBrainBrief>;
  onSecondBrainCalendar?: (args?: SecondBrainEventFilter) => DashboardSecondBrainEvent[];
  onSecondBrainCalendarUpsert?: (input: SecondBrainEventUpsertInput) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainCalendarDelete?: (id: string) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainTasks?: (args?: SecondBrainTaskFilter) => DashboardSecondBrainTask[];
  onSecondBrainTaskUpsert?: (input: SecondBrainTaskUpsertInput) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainTaskDelete?: (id: string) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainNotes?: (args?: SecondBrainNoteFilter) => DashboardSecondBrainNote[];
  onSecondBrainNoteUpsert?: (input: SecondBrainNoteUpsertInput) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainNoteDelete?: (id: string) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainPeople?: (args?: SecondBrainPersonFilter) => DashboardSecondBrainPerson[];
  onSecondBrainPersonUpsert?: (input: SecondBrainPersonUpsertInput) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainPersonDelete?: (id: string) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainLinks?: (args?: SecondBrainLinkFilter) => DashboardSecondBrainLink[];
  onSecondBrainLinkUpsert?: (input: SecondBrainLinkUpsertInput) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainBriefs?: (args?: SecondBrainBriefFilter) => DashboardSecondBrainBrief[];
  onSecondBrainBriefUpdate?: (input: SecondBrainBriefUpdateInput) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainBriefDelete?: (id: string) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainLinkDelete?: (id: string) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainRoutineCatalog?: () => DashboardSecondBrainRoutineCatalogEntry[];
  onSecondBrainRoutines?: () => DashboardSecondBrainRoutine[];
  onSecondBrainRoutineCreate?: (input: SecondBrainRoutineCreateInput) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainRoutineUpdate?: (input: SecondBrainRoutineUpdateInput) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainRoutineDelete?: (id: string) => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainSyncNow?: () => DashboardMutationResult | Promise<DashboardMutationResult>;
  onSecondBrainUsage?: () => DashboardSecondBrainUsage;
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
  onAiSecuritySummary?: () => AiSecuritySummary;
  onAiSecurityProfiles?: () => AiSecurityProfile[];
  onAiSecurityTargets?: () => AiSecurityTarget[];
  onAiSecurityRuns?: (limit?: number) => AiSecurityRun[];
  onAiSecurityScan?: (input: AiSecurityScanInput) => AiSecurityScanResult | Promise<AiSecurityScanResult>;
  onAiSecurityFindings?: (args: {
    limit?: number;
    status?: AiSecurityFindingStatus;
  }) => AiSecurityFinding[];
  onAiSecurityUpdateFindingStatus?: (args: {
    findingId: string;
    status: AiSecurityFindingStatus;
  }) => { success: boolean; message: string };
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
    mode?: 'bearer_required' | 'disabled';
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
    actionLabel?: string;
    requestId?: string;
    codeSessionId?: string;
  }>;
  onPendingActionCurrent?: (args: {
    userId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
  }) => {
    pendingAction?: Record<string, unknown> | null;
  };
  onPendingActionReset?: (args: {
    userId: string;
    principalId?: string;
    principalRole?: import('../tools/types.js').PrincipalRole;
    channel: string;
    surfaceId: string;
  }) => DashboardMutationResult | Promise<DashboardMutationResult>;
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
    surfaceId?: string;
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
    playwrightBrowser?: string;
    playwrightCaps?: string;
  }) => Promise<{ success: boolean; message: string }> | { success: boolean; message: string };
  onBrowserConfigState?: () => { enabled: boolean; allowedDomains: string[]; playwrightEnabled: boolean; playwrightBrowser: string; playwrightCaps: string };
  onToolsApprovalDecision?: (input: {
    approvalId: string;
    decision: 'approved' | 'denied';
    actor: string;
    actorRole?: import('../tools/types.js').PrincipalRole;
    userId?: string;
    channel?: string;
    surfaceId?: string;
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
  }> | {
    success: boolean;
    message: string;
    continueConversation?: boolean;
    displayMessage?: string;
    continuedResponse?: {
      content: string;
      metadata?: Record<string, unknown>;
    };
  };
  onConnectorsState?: (args?: { limitRuns?: number }) => ConnectorFrameworkState;
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
  onStreamDispatch?: (
    agentId: string | undefined,
    message: {
      requestId?: string;
      content: string;
      userId?: string;
      surfaceId?: string;
      principalId?: string;
      principalRole?: import('../tools/types.js').PrincipalRole;
      channel?: string;
      metadata?: Record<string, unknown>;
    },
    emitSSE: (event: SSEEvent) => void,
  ) => Promise<{
    requestId: string;
    runId: string;
    content: string;
    metadata?: Record<string, unknown>;
    error?: string;
    errorCode?: string;
  }>;
  onStreamCancel?: (input: {
    requestId: string;
    userId?: string;
    channel?: string;
    agentId?: string;
    reason?: string;
  }) => Promise<{
    success: boolean;
    canceled: boolean;
    message: string;
    requestId: string;
    runId: string;
    errorCode?: string;
  }>;
  onTelegramReload?: () => Promise<{ success: boolean; message: string }>;
  onCloudTest?: (provider: string, profileId: string) => Promise<{ success: boolean; message: string }>;
  onKillswitch?: () => void;
  onFactoryReset?: (args: { scope: 'data' | 'config' | 'all' }) => Promise<{
    success: boolean;
    message: string;
    deletedFiles: string[];
    errors: string[];
  }>;
  onRoutingMode?: () => {
    tierMode: RoutingTierMode;
    availableModes: RoutingTierMode[];
    complexityThreshold: number;
    fallbackOnFailure: boolean;
    providerOptions: DashboardChatProviderOption[];
  };
  onRoutingModeUpdate?: (mode: RoutingTierMode) => {
    success: boolean;
    message: string;
    tierMode: RoutingTierMode;
    availableModes: RoutingTierMode[];
  };
  onAutomationCatalog?: () => AutomationCatalogViewEntry[];
  onAutomationRunHistory?: () => AutomationRunHistoryEntry[];
  onAutomationCreate?: (automationId: string) => AutomationCatalogCreateResult;
  onAutomationSave?: (input: AutomationSaveInput) => AutomationSaveResult;
  onAutomationDefinitionSave?: (
    automationId: string,
    workflow: AssistantConnectorPlaybookDefinition,
  ) => AutomationSaveResult;
  onAutomationSetEnabled?: (automationId: string, enabled: boolean) => { success: boolean; message: string };
  onAutomationDelete?: (automationId: string) => { success: boolean; message: string };
  onAutomationRun?: (input: {
    automationId: string;
    dryRun?: boolean;
    origin?: 'assistant' | 'cli' | 'web';
    agentId?: string;
    userId?: string;
    channel?: string;
    requestedBy?: string;
  }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  onScheduledTasks?: () => ScheduledTaskDefinition[];
  onScheduledTaskGet?: (id: string) => ScheduledTaskDefinition | null;
  onScheduledTaskCreate?: (input: ScheduledTaskCreateInput) => { success: boolean; message: string; task?: ScheduledTaskDefinition };
  onScheduledTaskUpdate?: (id: string, input: ScheduledTaskUpdateInput) => { success: boolean; message: string };
  onScheduledTaskDelete?: (id: string) => { success: boolean; message: string };
  onScheduledTaskRunNow?: (id: string) => Promise<{ success: boolean; message: string }>;
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
    authPending?: boolean;
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
  /** Cancel an in-progress native Google OAuth flow. */
  onGoogleAuthCancel?: () => Promise<{ success: boolean; message: string }>;
  /** Disconnect native Google integration. */
  onGoogleDisconnect?: () => Promise<{ success: boolean; message: string }>;
  /** Native Microsoft 365 status. */
  onMicrosoftStatus?: () => Promise<{
    authenticated: boolean;
    authPending?: boolean;
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
  /** Cancel an in-progress native Microsoft OAuth flow. */
  onMicrosoftAuthCancel?: () => Promise<{ success: boolean; message: string }>;
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
  }) => DashboardMutationResult;
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
    families?: { tool?: 'off' | 'shadow' | 'enforce'; admin?: 'off' | 'shadow' | 'enforce'; guardian?: 'off' | 'shadow' | 'enforce'; event?: 'off' | 'shadow' | 'enforce' };
    mismatchLogLimit?: number;
  }) => DashboardMutationResult;
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
  llm?: Record<string, {
    remove?: boolean;
    provider?: string;
    enabled?: boolean;
    model?: string;
    apiKey?: string;
    credentialRef?: string;
    baseUrl?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    keepAlive?: string | number;
    think?: OllamaThinkConfig;
    ollamaOptions?: OllamaOptionsConfig;
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
    secondBrain?: {
      enabled?: boolean;
      onboarding?: {
        completed?: boolean;
        dismissed?: boolean;
      };
      profile?: {
        timezone?: string;
        workdayStart?: string;
        workdayEnd?: string;
        proactivityLevel?: 'minimal' | 'balanced' | 'proactive';
      };
      delivery?: {
        defaultChannels?: Array<'web' | 'cli' | 'telegram'>;
      };
      knowledge?: {
        prioritizeConnectedSources?: boolean;
        defaultRetrievalMode?: 'hybrid' | 'library_first' | 'search_first';
        rerankerEnabled?: boolean;
      };
    };
    responseStyle?: {
      enabled?: boolean;
      level?: AssistantResponseStyleLevel;
    };
    security?: {
      deploymentProfile?: DeploymentProfile;
      operatingMode?: SecurityOperatingMode;
      triageLlmProvider?: SecurityTriageLlmProvider;
      continuousMonitoring?: {
        enabled?: boolean;
        profileId?: AssistantSecurityMonitoringProfile;
        cron?: string;
      };
      autoContainment?: {
        enabled?: boolean;
        minSeverity?: AssistantSecurityAutoContainmentSeverity;
        minConfidence?: number;
        categories?: AssistantSecurityAutoContainmentCategory[];
      };
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
    memory?: {
      knowledgeBase?: {
        enabled?: boolean;
        basePath?: string;
        readOnly?: boolean;
        maxContextChars?: number;
        maxFileChars?: number;
        maxEntryChars?: number;
        maxEntriesPerScope?: number;
        maxEmbeddingCacheBytes?: number;
        autoFlush?: boolean;
      };
    };
    performance?: {
      enabled?: boolean;
      sampleIntervalSec?: number;
      trendRetentionDays?: number;
      protectedProcesses?: {
        names?: string[];
        honorActiveCodeSessions?: boolean;
      };
      profiles?: Array<{
        id: string;
        name: string;
        powerMode?: 'balanced' | 'high_performance' | 'power_saver';
        autoActions?: {
          enabled?: boolean;
          allowedActionIds?: string[];
        };
        processRules?: {
          terminate?: string[];
          protect?: string[];
        };
        latencyTargets?: Array<{
          kind: 'internet' | 'api';
          id: string;
          target?: string;
          targetRef?: string;
        }>;
      }>;
    };
    tools?: {
      preferredProviders?: {
        local?: string;
        managedCloud?: string;
        frontier?: string;
        external?: string;
      };
      modelSelection?: {
        autoPolicy?: 'balanced' | 'quality_first';
        preferManagedCloudForLowPressureExternal?: boolean;
        preferFrontierForRepoGrounded?: boolean;
        preferFrontierForSecurity?: boolean;
        managedCloudRouting?: {
          enabled?: boolean;
          roleBindings?: {
            general?: string;
            direct?: string;
            toolLoop?: string;
            coding?: string;
          };
        };
      };
      codingBackends?: {
        enabled?: boolean;
        defaultBackend?: string;
        maxConcurrentSessions?: number;
        autoUpdate?: boolean;
        versionCheckIntervalMs?: number;
        backends?: Array<{
          id: string;
          name: string;
          enabled?: boolean;
          shell?: string;
          command: string;
          args: string[];
          versionCommand?: string;
          updateCommand?: string;
          env?: Record<string, string>;
          timeoutMs?: number;
          nonInteractive?: boolean;
        }>;
      };
      cloud?: {
        enabled?: boolean;
        defaultRemoteExecutionTargetId?: string;
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
          sandbox?: {
            enabled?: boolean;
            projectId?: string;
            baseSnapshotId?: string;
            defaultTimeoutMs?: number;
            defaultVcpus?: number;
            allowNetwork?: boolean;
            allowedDomains?: string[];
          };
        }>;
        daytonaProfiles?: Array<{
          id: string;
          name: string;
          apiUrl?: string;
          apiKey?: string;
          credentialRef?: string;
          target?: string;
          language?: string;
          snapshot?: string;
          enabled?: boolean;
          defaultTimeoutMs?: number;
          defaultVcpus?: number;
          allowNetwork?: boolean;
          allowedCidrs?: string[];
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
        degradedFallback?: {
          allowNetworkTools?: boolean;
          allowBrowserTools?: boolean;
          allowMcpServers?: boolean;
          allowPackageManagers?: boolean;
          allowManualCodeTerminals?: boolean;
        };
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
    responseSource?: ResponseSourceMetadata;
  }>;
  attached: boolean;
  attachment?: CodeSessionAttachmentRecord | null;
}

export interface DashboardCodeSessionSandboxesResponse {
  codeSessionId: string;
  defaultTargetId: string | null;
  targets: RemoteExecutionTargetDescriptor[];
  sandboxes: CodeSessionManagedSandbox[];
}

export interface DashboardCodeSessionsList {
  sessions: CodeSessionRecord[];
  currentSessionId: string | null;
  referencedSessionIds: string[];
  targetSessionId: string | null;
}

/** Programmatic terminal control for the CodingBackendService.
 * Implemented by WebChannel and injected during bootstrap. */
export interface CodingBackendTerminalControl {
  /** Open a new PTY terminal in a code session. */
  openTerminal(params: {
    codeSessionId: string;
    shell: string;
    cwd: string;
    name?: string;
    cols?: number;
    rows?: number;
  }): Promise<{ terminalId: string }>;

  /** Write input to a terminal's stdin. */
  writeTerminalInput(terminalId: string, input: string): void;

  /** Kill and close a terminal. */
  closeTerminal(terminalId: string): void;

  /** Subscribe to terminal output. Returns unsubscribe function. */
  onTerminalOutput(terminalId: string, cb: (data: string) => void): () => void;

  /** Subscribe to terminal exit. Returns unsubscribe function. */
  onTerminalExit(terminalId: string, cb: (exitCode: number, signal: number) => void): () => void;
}
