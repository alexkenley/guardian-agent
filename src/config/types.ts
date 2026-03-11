/**
 * Configuration types for GuardianAgent.
 *
 * Loaded from ~/.guardianagent/config.yaml with environment variable
 * interpolation and deep-merged with defaults.
 */

import { DEFAULT_PII_ENTITIES, type PiiEntityType, type PiiRedactionMode } from '../guardian/pii-scanner.js';
import type { ToolCategory, ToolRisk } from '../tools/types.js';

/** Top-level configuration. */
export interface GuardianAgentConfig {
  /** LLM provider configurations. */
  llm: Record<string, LLMConfig>;
  /** Default LLM provider name (key in llm map). */
  defaultProvider: string;
  /** Fallback provider names tried when the default provider fails (keys in llm map). */
  fallbacks?: string[];
  /** Agent configurations. */
  agents: AgentConfig[];
  /** Channel configurations. */
  channels: ChannelsConfig;
  /** Guardian security configuration. */
  guardian: GuardianConfig;
  /** Runtime configuration. */
  runtime: RuntimeConfig;
  /** Personal assistant UX and persistence features. */
  assistant: AssistantConfig;
  /** LLM provider failover configuration. */
  failover?: FailoverConfig;
  /** Quality-based fallback: retry with external LLM when local model produces degraded responses (default: true). */
  qualityFallback?: boolean;
  /** Message routing configuration for multi-agent dispatch. */
  routing?: RoutingConfig;
}

/** Failover configuration for LLM providers. */
export interface FailoverConfig {
  /** Enable provider failover (default: true). */
  enabled: boolean;
  /** Failures before circuit opens (default: 3). */
  failureThreshold: number;
  /** Time in ms before recovery attempt (default: 30000). */
  resetTimeoutMs: number;
}

/** Environment-backed credential reference. */
export interface CredentialRefConfig {
  /** Credential source type. */
  source: 'env';
  /** Environment variable to read when resolving the credential. */
  env: string;
  /** Optional human-readable purpose/description for operators. */
  description?: string;
}

/** Shared credential reference registry for provider/tool integrations. */
export interface AssistantCredentialsConfig {
  /** Named credential references resolved at runtime. */
  refs: Record<string, CredentialRefConfig>;
}

/** Configuration for a single LLM provider. */
export interface LLMConfig {
  /** Provider type: 'ollama' | 'anthropic' | 'openai'. */
  provider: 'ollama' | 'anthropic' | 'openai';
  /** API key (supports ${ENV_VAR} interpolation). */
  apiKey?: string;
  /** Reference into assistant.credentials.refs (preferred over inline apiKey). */
  credentialRef?: string;
  /** Base URL for the API. */
  baseUrl?: string;
  /** Default model to use. */
  model: string;
  /** Maximum tokens in response. */
  maxTokens?: number;
  /** Temperature for generation. */
  temperature?: number;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Priority for failover ordering (lower = higher priority, default: 10). */
  priority?: number;
}

/** Configuration for an agent instance. */
export interface AgentConfig {
  /** Unique agent identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Which LLM provider to use (key in llm map). */
  provider?: string;
  /** System prompt for this agent. */
  systemPrompt?: string;
  /** Cron schedule for periodic execution. */
  schedule?: string;
  /** Capabilities granted to this agent. */
  capabilities?: string[];
  /** Resource limits. */
  resourceLimits?: Partial<AgentResourceLimitsConfig>;
  /** Agent role for routing purposes. */
  role?: 'local' | 'external' | 'general';
}

/** Routing rule for a specific agent. */
export interface RoutingRuleConfig {
  /** Regex patterns for keyword matching. */
  patterns?: string[];
  /** Domain groups: 'filesystem', 'code', 'network', 'email'. */
  domains?: string[];
  /** Priority (lower = higher priority, default 10). */
  priority?: number;
}

/** Message routing configuration. */
export interface RoutingConfig {
  /** Routing strategy (default: 'keyword'). */
  strategy: 'keyword' | 'capability' | 'explicit';
  /** Fallback agent ID when no route matches (default: first agent or 'local'). */
  fallbackAgent?: string;
  /** Per-agent routing rules, keyed by agent ID. */
  rules?: Record<string, RoutingRuleConfig>;
  /** Tier routing mode: auto scores complexity, local-only/external-only force a tier (default: 'auto'). */
  tierMode?: 'auto' | 'local-only' | 'external-only';
  /** Complexity threshold: score >= threshold routes to external (default: 0.5). */
  complexityThreshold?: number;
  /** Retry with the opposite tier when the primary tier agent fails (default: true). */
  fallbackOnFailure?: boolean;
  /** Maximum fallback attempts before propagating the error (default: 1). */
  maxFallbackAttempts?: number;
}

/** Resource limits for an agent (config layer). */
export interface AgentResourceLimitsConfig {
  /** Maximum wall-clock ms per invocation. */
  maxInvocationBudgetMs: number;
  /** Maximum LLM tokens per minute (0 = unlimited). */
  maxTokensPerMinute: number;
  /** Maximum concurrent tool executions (0 = unlimited). */
  maxConcurrentTools: number;
  /** Maximum pending events in agent's queue (0 = unlimited). */
  maxQueueDepth: number;
}

/** Channel adapter configurations. */
export interface ChannelsConfig {
  /** CLI channel configuration. */
  cli?: {
    enabled: boolean;
    /** Default agent to route messages to. */
    defaultAgent?: string;
  };
  /** Telegram channel configuration. */
  telegram?: {
    enabled: boolean;
    /** Bot token (supports ${ENV_VAR} interpolation). */
    botToken?: string;
    /** Allowed chat IDs (empty = allow all). */
    allowedChatIds?: number[];
    /** Default agent to route messages to. */
    defaultAgent?: string;
    /** Use polling (true) or webhook (false). */
    polling?: boolean;
  };
  /** Web UI channel configuration. */
  web?: {
    enabled: boolean;
    /** Port to listen on. */
    port?: number;
    /** Host to bind to. */
    host?: string;
    /** Default agent to route messages to. */
    defaultAgent?: string;
    /** Bearer token for authentication. If set, all non-health requests require it. */
    authToken?: string;
    /** Structured auth configuration (preferred over authToken). */
    auth?: {
      /** Auth mode for web/API endpoints. */
      mode?: 'bearer_required';
      /** Bearer token value (supports ${ENV_VAR} interpolation). */
      token?: string;
      /** Rotate token on startup and persist generated value. */
      rotateOnStartup?: boolean;
      /** Optional client session TTL hint in minutes. */
      sessionTtlMinutes?: number;
      /** Runtime metadata about where the active token came from. */
      tokenSource?: 'config' | 'env' | 'ephemeral';
    };
    /** Allowed CORS origins (default: none / same-origin). Wildcard '*' is rejected. */
    allowedOrigins?: string[];
    /** Maximum request body size in bytes (default: 1 MB). */
    maxBodyBytes?: number;
  };
}

/** Guardian security configuration. */
export interface GuardianConfig {
  /** Enable/disable the Guardian. */
  enabled: boolean;
  /** Paths that are always denied. */
  deniedPaths?: string[];
  /** Additional secret patterns (regex strings). */
  additionalSecretPatterns?: string[];
  /** Whether to log denied actions. */
  logDenials?: boolean;
  /** Rate limiting configuration. */
  rateLimit?: {
    /** Maximum requests per minute per agent (default: 30). */
    maxPerMinute: number;
    /** Maximum requests per hour per agent (default: 500). */
    maxPerHour: number;
    /** Maximum burst requests within 10 seconds (default: 5). */
    burstAllowed: number;
    /** Optional maximum requests per minute per user across agents. */
    maxPerMinutePerUser?: number;
    /** Optional maximum requests per hour per user across agents. */
    maxPerHourPerUser?: number;
    /** Optional maximum requests per minute across all agents/users. */
    maxGlobalPerMinute?: number;
    /** Optional maximum requests per hour across all agents/users. */
    maxGlobalPerHour?: number;
  };
  /** Input sanitization configuration. */
  inputSanitization?: {
    /** Enable input sanitization (default: true). */
    enabled: boolean;
    /** Injection score threshold to block (default: 3). */
    blockThreshold: number;
  };
  /** Output scanning configuration. */
  outputScanning?: {
    /** Enable output scanning (default: true). */
    enabled: boolean;
    /** Redact secrets (true) vs block entirely (false). Default: true. */
    redactSecrets: boolean;
  };
  /** PII redaction for tool results before reinjection into LLM context. */
  piiRedaction?: {
    /** Enable tool-result PII redaction (default: true). */
    enabled: boolean;
    /** Replace with redactions or deterministic anonymized placeholders. */
    mode: PiiRedactionMode;
    /** PII entity types to scan for. */
    entities: PiiEntityType[];
    /** Apply to all providers or only external models. */
    providerScope: 'all' | 'external';
  };
  /** Guardian Agent inline LLM evaluation configuration. */
  guardianAgent?: {
    /** Enable inline LLM-powered action evaluation (default: true). */
    enabled: boolean;
    /** LLM provider mode: 'local' (Ollama), 'external' (OpenAI/Anthropic), 'auto' (default). */
    llmProvider: 'local' | 'external' | 'auto';
    /** Action types that trigger inline evaluation. */
    actionTypes?: string[];
    /** Allow actions when LLM is unavailable (default: false — fail-closed). */
    failOpen: boolean;
    /** Timeout for inline evaluation in ms (default: 8000). */
    timeoutMs?: number;
  };
  /** Sentinel audit configuration (retrospective analysis). */
  sentinel?: {
    /** Enable Sentinel audit (default: true). */
    enabled: boolean;
    /** Cron schedule for automatic audit (default: every 5 min). */
    schedule: string;
    /** Anomaly detection thresholds. */
    anomalyThresholds?: {
      /** Denial rate multiplier to trigger volume spike (default: 3). */
      volumeSpikeMultiplier: number;
      /** Max denied action types before capability probe alert (default: 5). */
      capabilityProbeThreshold: number;
      /** Max secret detections per agent before alert (default: 3). */
      secretDetectionThreshold: number;
    };
  };
  /** Audit log configuration. */
  auditLog?: {
    /** Maximum events to keep in memory (default: 10000). */
    maxEvents: number;
    /** Enable persistent audit log with hash chain (default: true). */
    persistenceEnabled?: boolean;
    /** Directory for persistent audit files (default: ~/.guardianagent/audit/). */
    auditDir?: string;
  };
  /** Trust preset for quick security posture configuration. */
  trustPreset?: 'locked' | 'safe' | 'balanced' | 'power';
  /** Policy-as-Code engine configuration. */
  policy?: {
    /** Enable the policy engine (default: true). */
    enabled: boolean;
    /** Operating mode: 'off' (disabled), 'shadow' (compare only), 'enforce' (authoritative). */
    mode: 'off' | 'shadow' | 'enforce';
    /** Per-family mode overrides (inherit from top-level mode if absent). */
    families?: {
      tool?: 'off' | 'shadow' | 'enforce';
      admin?: 'off' | 'shadow' | 'enforce';
      guardian?: 'off' | 'shadow' | 'enforce';
      event?: 'off' | 'shadow' | 'enforce';
    };
    /** Path to policy rule files directory (default: policies/). */
    rulesPath?: string;
    /** Maximum shadow mismatches to log before throttling (default: 1000). */
    mismatchLogLimit?: number;
  };
}

/** Runtime configuration. */
export interface RuntimeConfig {
  /** Watchdog stall detection timeout (ms). */
  maxStallDurationMs: number;
  /** Watchdog check interval (ms). */
  watchdogIntervalMs: number;
  /** Log level. */
  logLevel: string;
}

/** Optional setup/config state and preferences. */
export interface AssistantSetupConfig {
  /** Whether initial setup has been completed by the user. */
  completed: boolean;
}

/** User identity strategy across channels. */
export interface AssistantIdentityConfig {
  /**
   * single_user: all channels map to one canonical identity.
   * channel_user: each channel user is unique unless alias-mapped.
   */
  mode: 'single_user' | 'channel_user';
  /** Canonical user ID used in single_user mode. */
  primaryUserId: string;
  /** Optional map: "<channel>:<channelUserId>" -> canonical user ID. */
  aliases?: Record<string, string>;
}

/** SOUL prompt injection settings for agent identity/intent context. */
export interface AssistantSoulConfig {
  /** Enable SOUL prompt injection. */
  enabled: boolean;
  /** Path to SOUL markdown file (absolute or relative to process cwd). */
  path?: string;
  /** Hard cap for loaded SOUL file characters. */
  maxChars: number;
  /** Injection mode for the primary user-facing agent. */
  primaryMode: 'full' | 'summary' | 'disabled';
  /** Injection mode for delegated/non-primary agents. */
  delegatedMode: 'full' | 'summary' | 'disabled';
  /** Character cap for derived summary mode prompt text. */
  summaryMaxChars: number;
}

/** Conversation memory persistence settings. */
export interface AssistantMemoryConfig {
  /** Enable conversation memory. */
  enabled: boolean;
  /** SQLite database path for memory persistence. */
  sqlitePath?: string;
  /** Maximum user+assistant turns per session. */
  maxTurns: number;
  /** Maximum chars for one persisted message. */
  maxMessageChars: number;
  /** Maximum chars included in LLM context history. */
  maxContextChars: number;
  /** Remove records older than this many days. */
  retentionDays: number;
  /** Per-agent persistent knowledge base settings. */
  knowledgeBase?: AssistantKnowledgeBaseConfig;
}

/** Per-agent persistent knowledge base settings. */
export interface AssistantKnowledgeBaseConfig {
  /** Enable the per-agent knowledge base (default: true). */
  enabled: boolean;
  /** Base directory for memory files (default: ~/.guardianagent/memory). */
  basePath?: string;
  /** Maximum characters loaded into LLM context from the knowledge base (default: 4000). */
  maxContextChars: number;
  /** Maximum total file size in characters (default: 20000). */
  maxFileChars: number;
  /** Enable automatic memory flush before context trimming (default: true). */
  autoFlush: boolean;
}

/** Analytics storage and retention settings. */
export interface AssistantAnalyticsConfig {
  /** Enable analytics collection. */
  enabled: boolean;
  /** SQLite database path for analytics events. */
  sqlitePath?: string;
  /** Remove analytics older than this many days. */
  retentionDays: number;
}

/** Automated operator notifications for security/anomaly events. */
export interface AssistantNotificationsConfig {
  /** Enable automated notifications (default: true). */
  enabled: boolean;
  /** Minimum audit severity that should notify. */
  minSeverity: 'info' | 'warn' | 'critical';
  /** Audit event types that should generate notifications. */
  auditEventTypes: import('../guardian/audit-log.js').AuditEventType[];
  /** Suppress duplicate notifications for this many milliseconds. */
  cooldownMs: number;
  /** Delivery destinations. */
  destinations: {
    /** Emit web/dashboard notifications over SSE/event bus. */
    web: boolean;
    /** Show notifications on the local CLI when active. */
    cli: boolean;
    /** Send notifications to configured Telegram chats when enabled. */
    telegram: boolean;
  };
}

/** Quick action templates for structured assistant workflows. */
export interface AssistantQuickActionsConfig {
  /** Enable quick actions. */
  enabled: boolean;
  /**
   * Prompt templates by action id.
   * Must include "{details}" placeholder for injected user input.
   */
  templates: Record<string, string>;
}

/** Threat-intel monitoring and response settings. */
export interface AssistantThreatIntelConfig {
  /** Enable threat-intel monitoring features. */
  enabled: boolean;
  /** Allow darkweb source category in scan requests. */
  allowDarkWeb: boolean;
  /** Response automation level. */
  responseMode: 'manual' | 'assisted' | 'autonomous';
  /** Default watchlist entries (names, handles, brands, domains, etc.). */
  watchlist: string[];
  /** Background scan cadence in minutes (0 disables interval scan). */
  autoScanIntervalMinutes: number;
  /** Moltbook hostile-forum connector configuration. */
  moltbook: AssistantThreatIntelMoltbookConfig;
}

/** Hostile forum connector settings for Moltbook. */
export interface AssistantThreatIntelMoltbookConfig {
  /** Enable Moltbook ingestion. */
  enabled: boolean;
  /** mock = synthetic feed, api = live API requests. */
  mode: 'mock' | 'api';
  /** API base URL (required for api mode). */
  baseUrl?: string;
  /** Optional bearer token for Moltbook API. */
  apiKey?: string;
  /** Search endpoint path relative to baseUrl. */
  searchPath: string;
  /** Request timeout per query in milliseconds. */
  requestTimeoutMs: number;
  /** Maximum posts to request per target query. */
  maxPostsPerQuery: number;
  /** Maximum response size accepted from site. */
  maxResponseBytes: number;
  /** Allowed hosts for hostile-site guardrail enforcement. */
  allowedHosts: string[];
  /** Allow active publish responses to Moltbook (disabled by default). */
  allowActiveResponse: boolean;
}

/** Network connection type for network monitoring/scanning. */
export type AssistantNetworkConnectionType = 'lan' | 'wifi' | 'vpn' | 'remote';

/** Network connection profile definition. */
export interface AssistantNetworkConnectionConfig {
  /** Unique connection id. */
  id: string;
  /** Connection type. */
  type: AssistantNetworkConnectionType;
  /** Interface name (lan/wifi/vpn). */
  interface?: string;
  /** Subnet CIDR (lan/wifi/vpn). */
  subnet?: string;
  /** WiFi SSID for wifi connections. */
  ssid?: string;
  /** Cron schedule for scans. */
  scanSchedule?: string;
  /** Enable baseline updates for this connection. */
  autoBaseline?: boolean;
  /** Enable WiFi monitoring for this connection. */
  wifiMonitoring?: boolean;
  /** Trigger scans when connection comes online (vpn). */
  scanOnConnect?: boolean;
  /** Remote host for remote scanning. */
  host?: string;
  /** SSH username for remote scanning. */
  sshUser?: string;
  /** Remote scan command for remote connection mode. */
  remoteScanCommand?: string;
}

/** Generic anomaly rule config with enable and severity. */
export interface AssistantNetworkAnomalyRuleConfig {
  enabled: boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/** Assistant network intelligence, baseline, and threat monitoring configuration. */
export interface AssistantNetworkConfig {
  deviceIntelligence: {
    enabled: boolean;
    ouiDatabase: 'bundled' | 'remote';
    autoClassify: boolean;
  };
  baseline: {
    enabled: boolean;
    minSnapshotsForBaseline: number;
    dedupeWindowMs: number;
    anomalyRules: {
      newDevice: AssistantNetworkAnomalyRuleConfig;
      portChange: AssistantNetworkAnomalyRuleConfig;
      arpSpoofing: AssistantNetworkAnomalyRuleConfig;
      unusualService: AssistantNetworkAnomalyRuleConfig;
      deviceGone: AssistantNetworkAnomalyRuleConfig;
      massPortOpen: AssistantNetworkAnomalyRuleConfig;
    };
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
    threatRules: {
      dataExfiltration: {
        enabled: boolean;
        thresholdMB: number;
        windowMinutes: number;
      };
      portScanning: {
        enabled: boolean;
        portThreshold: number;
        windowSeconds: number;
      };
      beaconing: {
        enabled: boolean;
        minIntervals: number;
        tolerancePercent: number;
      };
    };
  };
  connections: AssistantNetworkConnectionConfig[];
}

export type HostMonitorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface AssistantHostMonitoringConfig {
  enabled: boolean;
  scanIntervalSec: number;
  dedupeWindowMs: number;
  monitorProcesses: boolean;
  monitorPersistence: boolean;
  monitorSensitivePaths: boolean;
  monitorNetwork: boolean;
  sensitivePaths: string[];
  suspiciousProcessNames: string[];
}

/** Connector execution mode. */
export type ConnectorExecutionMode = 'plan_then_execute' | 'direct_execute';

/** Connector authentication mode. */
export type ConnectorAuthMode = 'none' | 'api_key' | 'oauth2' | 'certificate';

/** Declarative connector pack for infrastructure operations. */
export interface AssistantConnectorPackConfig {
  /** Unique identifier for the pack. */
  id: string;
  /** Human-readable pack name. */
  name: string;
  /** Enable or disable this pack without deleting config. */
  enabled: boolean;
  /** Optional description shown in UI/tooling. */
  description?: string;
  /** Logical capabilities this pack can expose. */
  allowedCapabilities: string[];
  /** Network host allowlist for this pack. */
  allowedHosts: string[];
  /** Filesystem roots this pack can access. */
  allowedPaths: string[];
  /** Shell command prefixes this pack can execute. */
  allowedCommands: string[];
  /** Primary authentication mode for this pack. */
  authMode: ConnectorAuthMode;
  /** Force human approval for mutating actions from this pack. */
  requireHumanApprovalForWrites: boolean;
}

/** Playbook runtime controls for connector workflows. */
export interface AssistantConnectorPlaybooksConfig {
  /** One named connector playbook definition. */
  definitions: AssistantConnectorPlaybookDefinition[];
  /** Enable playbook execution engine. */
  enabled: boolean;
  /** Maximum number of steps in a playbook run. */
  maxSteps: number;
  /** Maximum parallelized steps within a playbook run. */
  maxParallelSteps: number;
  /** Default per-step timeout budget in milliseconds. */
  defaultStepTimeoutMs: number;
  /** Require signed playbook definitions before execution. */
  requireSignedDefinitions: boolean;
  /** Require dry-run before first live execution of a playbook revision. */
  requireDryRunOnFirstExecution: boolean;
}

/** One playbook step definition. */
export interface AssistantConnectorPlaybookStepDefinition {
  /** Unique step id within a playbook. */
  id: string;
  /** Optional human label for operators. */
  name?: string;
  /** Optional access profile id used for this step. Empty/default means built-in tool access. */
  packId: string;
  /** Tool name to execute. */
  toolName: string;
  /** Tool arguments for this step. */
  args?: Record<string, unknown>;
  /** Continue playbook after this step fails. */
  continueOnError?: boolean;
  /** Optional per-step timeout override. */
  timeoutMs?: number;
}

/** One connector playbook definition. */
export interface AssistantConnectorPlaybookDefinition {
  /** Unique playbook id. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Enable or disable this playbook. */
  enabled: boolean;
  /** Execution strategy for this playbook. */
  mode: 'sequential' | 'parallel';
  /** Optional description for operators. */
  description?: string;
  /** Optional signature blob (required when signed definitions enforced). */
  signature?: string;
  /** Optional cron schedule for automatic execution. */
  schedule?: string;
  /** Ordered list of playbook steps. */
  steps: AssistantConnectorPlaybookStepDefinition[];
}

/** Visual connector studio controls. */
export interface AssistantConnectorStudioConfig {
  /** Enable connector studio surfaces (web/CLI). */
  enabled: boolean;
  /** Studio mode for operators. */
  mode: 'read_only' | 'builder';
  /** Require privileged auth ticket for studio mutations. */
  requirePrivilegedTicket: boolean;
}

/** Connector and playbook framework configuration. */
export interface AssistantConnectorsConfig {
  /** Master toggle for connector framework. */
  enabled: boolean;
  /** Execution strategy for connector runs. */
  executionMode: ConnectorExecutionMode;
  /** Maximum connector calls allowed in one run. */
  maxConnectorCallsPerRun: number;
  /** Declarative connector packs. */
  packs: AssistantConnectorPackConfig[];
  /** Playbook engine controls. */
  playbooks: AssistantConnectorPlaybooksConfig;
  /** Visual studio controls. */
  studio: AssistantConnectorStudioConfig;
}

/** Configuration for a single MCP server connection. */
export interface MCPServerEntry {
  /** Unique identifier for this server. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Command to start the MCP server process. */
  command: string;
  /** Arguments for the command. */
  args?: string[];
  /** Environment variables to pass to the server process (supports ${ENV_VAR}). */
  env?: Record<string, string>;
  /** Working directory for the server process. */
  cwd?: string;
  /** Request timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
  /** Optional trust-level override for all tools exposed by this server. */
  trustLevel?: ToolRisk;
  /** Optional per-server call rate limit. */
  maxCallsPerMinute?: number;
}

/** MCP tool server configuration. */
export interface AssistantMCPConfig {
  /** Enable MCP tool server connections. */
  enabled: boolean;
  /** MCP server configurations. */
  servers: MCPServerEntry[];
  /** Managed provider wrappers that materialize MCP servers internally. */
  managedProviders?: {
    gws?: {
      enabled: boolean;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      timeoutMs?: number;
      services?: string[];
      exposeSkills?: boolean;
      /** Reserved for future multi-account support; validated but not yet implemented. */
      accountMode?: 'single_user' | 'multi_account';
      /** LLM provider name to use for workspace tool-calling (e.g. 'anthropic', 'openai'). Falls back to default provider. */
      model?: string;
    };
  };
}

/** Native skills configuration. */
export interface AssistantSkillsConfig {
  /** Enable local skill loading and prompt injection. */
  enabled: boolean;
  /** Roots to scan for skill bundles. */
  roots: string[];
  /** Automatically select skills based on request context. */
  autoSelect: boolean;
  /** Maximum active skills to inject into one request. */
  maxActivePerRequest: number;
  /** Explicitly disabled skills by id. */
  disabledSkills: string[];
}

/** QMD source protocol type. */
export type QMDSourceType = 'directory' | 'git' | 'url' | 'file';

/** Configuration for a single QMD document source. */
export interface QMDSourceConfig {
  /** Unique identifier — becomes the QMD collection name. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Source type / protocol. */
  type: QMDSourceType;
  /** Source location: directory path, git repo URL, HTTP URL, or single file path. */
  path: string;
  /** File glob patterns to index (default: md and txt files). Only applies to directory/git sources. */
  globs?: string[];
  /** Whether this source is active. */
  enabled: boolean;
  /** Optional branch for git sources. */
  branch?: string;
  /** Optional description. */
  description?: string;
}

/** QMD hybrid search engine configuration. */
export interface QMDConfig {
  /** Enable QMD search integration (default: true). */
  enabled: boolean;
  /** Path to the qmd binary (default: bundled @tobilu/qmd, fallback: PATH `qmd`). */
  binaryPath?: string;
  /** Timeout for QMD queries in milliseconds (default: 30000). */
  queryTimeoutMs?: number;
  /** Default search mode: 'search' (BM25), 'vsearch' (vector), 'query' (hybrid + LLM re-rank). */
  defaultMode?: 'search' | 'vsearch' | 'query';
  /** Maximum results returned per query (default: 20). */
  maxResults?: number;
  /** Document sources to index and search. Supports directories, git repos, URLs, and individual files. */
  sources: QMDSourceConfig[];
}

/** Browser automation configuration (agent-browser). */
export interface BrowserConfig {
  /** Enable browser automation tools (default: false). */
  enabled: boolean;
  /** Path to agent-browser binary (default: 'agent-browser'). */
  binaryPath?: string;
  /** Close idle browser sessions after this many ms (default: 300000 = 5min). */
  sessionIdleTimeoutMs?: number;
  /** Maximum concurrent browser sessions (default: 3). */
  maxSessions?: number;
  /** Allowed domains for browser navigation (falls back to tools.allowedDomains). */
  allowedDomains?: string[];
}

/** Web search provider configuration. */
export interface WebSearchConfig {
  /**
   * Preferred search provider.
   * - 'auto' selects based on available API keys (Brave > Perplexity > DuckDuckGo).
   * - 'brave' returns structured results + free AI-synthesized summary (recommended, one key).
   * - 'perplexity' returns AI-synthesized answers with citations.
   * - 'duckduckgo' scrapes HTML results (fragile, last-resort).
   */
  provider?: 'auto' | 'duckduckgo' | 'brave' | 'perplexity';
  /** Brave Search API key (or ${ENV_VAR}). Free tier: 2000 queries/month. Covers both search + free Summarizer API. */
  braveApiKey?: string;
  /** Credential reference for Brave Search API key. */
  braveCredentialRef?: string;
  /** Perplexity API key (or ${ENV_VAR}). */
  perplexityApiKey?: string;
  /** Credential reference for Perplexity API key. */
  perplexityCredentialRef?: string;
  /** OpenRouter API key — can be used to access Perplexity via OpenRouter (or ${ENV_VAR}). */
  openRouterApiKey?: string;
  /** Credential reference for OpenRouter API key. */
  openRouterCredentialRef?: string;
  /** Search result cache TTL in milliseconds (default: 600000 = 10 min). */
  cacheTtlMs?: number;
}

/** A cPanel or WHM server profile for hosted operations. */
export interface AssistantCloudCpanelProfileConfig {
  /** Unique profile id referenced by cloud tools. */
  id: string;
  /** Human-readable label for operator-facing output. */
  name: string;
  /** Endpoint type. */
  type: 'cpanel' | 'whm';
  /** cPanel/WHM hostname. */
  host: string;
  /** Port override. Defaults to 2083/2082 for cPanel, 2087/2086 for WHM based on ssl. */
  port?: number;
  /** API username for Authorization header. */
  username: string;
  /** Inline API token (supports ${ENV_VAR}). Prefer credentialRef instead. */
  apiToken?: string;
  /** Credential reference for the API token. */
  credentialRef?: string;
  /** Use HTTPS/TLS. Default true. */
  ssl?: boolean;
  /** Allow invalid/self-signed certificates. Default false. */
  allowSelfSigned?: boolean;
  /** Default cPanel account to target when calling account-level actions through WHM. */
  defaultCpanelUser?: string;
}

/** A Vercel account or team profile for cloud operations. */
export interface AssistantCloudVercelProfileConfig {
  /** Unique profile id referenced by Vercel tools. */
  id: string;
  /** Human-readable label for operator-facing output. */
  name: string;
  /** Base URL override. Defaults to https://api.vercel.com. */
  apiBaseUrl?: string;
  /** Inline bearer token (supports ${ENV_VAR}). Prefer credentialRef instead. */
  apiToken?: string;
  /** Credential reference for the bearer token. */
  credentialRef?: string;
  /** Optional team identifier for scoped operations. */
  teamId?: string;
  /** Optional team slug for scoped operations. */
  slug?: string;
}

/** A Cloudflare account profile for cloud operations. */
export interface AssistantCloudCloudflareProfileConfig {
  /** Unique profile id referenced by Cloudflare tools. */
  id: string;
  /** Human-readable label for operator-facing output. */
  name: string;
  /** Base URL override. Defaults to https://api.cloudflare.com/client/v4. */
  apiBaseUrl?: string;
  /** Inline bearer token (supports ${ENV_VAR}). Prefer credentialRef instead. */
  apiToken?: string;
  /** Credential reference for the bearer token. */
  credentialRef?: string;
  /** Optional account identifier for account-scoped operations. */
  accountId?: string;
  /** Optional default zone identifier for zone-scoped operations. */
  defaultZoneId?: string;
}

/** An AWS account profile for cloud operations. */
export interface AssistantCloudAwsProfileConfig {
  /** Unique profile id referenced by AWS tools. */
  id: string;
  /** Human-readable label for operator-facing output. */
  name: string;
  /** Default AWS region for regional service calls. */
  region: string;
  /** Optional inline access key id (supports ${ENV_VAR}). */
  accessKeyId?: string;
  /** Optional credential reference for access key id. */
  accessKeyIdCredentialRef?: string;
  /** Optional inline secret access key (supports ${ENV_VAR}). */
  secretAccessKey?: string;
  /** Optional credential reference for secret access key. */
  secretAccessKeyCredentialRef?: string;
  /** Optional inline session token (supports ${ENV_VAR}). */
  sessionToken?: string;
  /** Optional credential reference for session token. */
  sessionTokenCredentialRef?: string;
  /** Optional per-service endpoint overrides for local emulators or tests. */
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

/** A GCP project profile for cloud operations. */
export interface AssistantCloudGcpProfileConfig {
  /** Unique profile id referenced by GCP tools. */
  id: string;
  /** Human-readable label for operator-facing output. */
  name: string;
  /** Default GCP project id. */
  projectId: string;
  /** Optional default regional/locational scope for compute and Cloud Run operations. */
  location?: string;
  /** Optional inline OAuth bearer token (supports ${ENV_VAR}). */
  accessToken?: string;
  /** Optional credential reference for the OAuth bearer token. */
  accessTokenCredentialRef?: string;
  /** Optional inline service account JSON string (supports ${ENV_VAR}). */
  serviceAccountJson?: string;
  /** Optional credential reference for the service account JSON string. */
  serviceAccountCredentialRef?: string;
  /** Optional per-service endpoint overrides for tests or emulators. */
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

/** An Azure subscription profile for cloud operations. */
export interface AssistantCloudAzureProfileConfig {
  /** Unique profile id referenced by Azure tools. */
  id: string;
  /** Human-readable label for operator-facing output. */
  name: string;
  /** Azure subscription id. */
  subscriptionId: string;
  /** Optional tenant id/domain for OAuth token acquisition. */
  tenantId?: string;
  /** Optional inline OAuth bearer token (supports ${ENV_VAR}). */
  accessToken?: string;
  /** Optional credential reference for the OAuth bearer token. */
  accessTokenCredentialRef?: string;
  /** Optional inline service principal client id. */
  clientId?: string;
  /** Optional credential reference for service principal client id. */
  clientIdCredentialRef?: string;
  /** Optional inline service principal client secret. */
  clientSecret?: string;
  /** Optional credential reference for service principal client secret. */
  clientSecretCredentialRef?: string;
  /** Optional default resource group for group-scoped operations. */
  defaultResourceGroup?: string;
  /** Optional custom blob base URL used instead of https://<account>.blob.core.windows.net. */
  blobBaseUrl?: string;
  /** Optional per-service endpoint overrides for tests or sovereign clouds. */
  endpoints?: {
    oauth2Token?: string;
    management?: string;
  };
}

/** Hosting and cloud-provider tool configuration. */
export interface AssistantCloudConfig {
  /** Enable built-in hosting/cloud tools. */
  enabled: boolean;
  /** Available cPanel/WHM profiles. */
  cpanelProfiles?: AssistantCloudCpanelProfileConfig[];
  /** Available Vercel profiles. */
  vercelProfiles?: AssistantCloudVercelProfileConfig[];
  /** Available Cloudflare profiles. */
  cloudflareProfiles?: AssistantCloudCloudflareProfileConfig[];
  /** Available AWS profiles. */
  awsProfiles?: AssistantCloudAwsProfileConfig[];
  /** Available GCP profiles. */
  gcpProfiles?: AssistantCloudGcpProfileConfig[];
  /** Available Azure profiles. */
  azureProfiles?: AssistantCloudAzureProfileConfig[];
}

/** Controls which policy areas the assistant can modify with user approval via chat. */
export interface AgentPolicyUpdatesConfig {
  /** Allow the assistant to add filesystem paths to the allowlist (always requires approval). */
  allowedPaths: boolean;
  /** Allow the assistant to add shell commands to the allowlist (always requires approval). */
  allowedCommands: boolean;
  /** Allow the assistant to add domains to the allowlist (always requires approval). */
  allowedDomains: boolean;
}

/** Assistant tool execution policy and sandbox settings. */
export interface AssistantToolsConfig {
  /** Enable assistant tool runtime and LLM tool-calling. */
  enabled: boolean;
  /** Global approval strategy. */
  policyMode: 'approve_each' | 'approve_by_policy' | 'autonomous';
  /** Optional per-tool overrides. */
  toolPolicies: Record<string, 'auto' | 'policy' | 'manual' | 'deny'>;
  /** Whether external posting tools are allowed. */
  allowExternalPosting: boolean;
  /** Allowed filesystem roots for tool operations. */
  allowedPaths: string[];
  /** Allowed command prefixes for shell tools. */
  allowedCommands: string[];
  /** Allowed domains for network/browser tools. */
  allowedDomains: string[];
  /** Default dry-run mode for mutating tools (default: false). */
  dryRunDefault?: boolean;
  /** MCP tool server configuration. */
  mcp?: AssistantMCPConfig;
  /** Web search tool configuration. Auto-selects best available provider (Brave > Perplexity > DuckDuckGo). */
  webSearch?: WebSearchConfig;
  /** Browser automation configuration (agent-browser). Enables JS-rendered page interaction. */
  browser?: BrowserConfig;
  /** Cloud and hosting provider integrations. */
  cloud?: AssistantCloudConfig;
  /** QMD hybrid search engine. Indexes local document collections for BM25 + vector + LLM re-ranked search. */
  qmd?: QMDConfig;
  /** Tool categories to disable. Tools in disabled categories are hidden from the LLM and blocked at execution. */
  disabledCategories?: ToolCategory[];
  /** OS-level process sandbox configuration. Uses bubblewrap (bwrap) on Linux, ulimit fallback elsewhere. */
  sandbox?: import('../sandbox/types.js').SandboxConfig;
  /** Controls which policy areas the assistant can modify via chat (always requires user approval). */
  agentPolicyUpdates?: AgentPolicyUpdatesConfig;
  /** Deferred tool loading: only send always-loaded tools to LLM, rest discoverable via find_tools. */
  deferredLoading?: {
    /** Enable deferred tool loading (default: true). */
    enabled: boolean;
    /** Tool names that are always loaded regardless of deferral. */
    alwaysLoaded?: string[];
  };
  /** Maximum approximate token budget for tool results in context (default: 80000). */
  contextBudget?: number;
  /** Per-tool or per-category LLM provider routing.
   * Keys are tool names (e.g. 'fs_write') or category names (e.g. 'workspace').
   * Values: 'local' (force local/Ollama), 'external' (force external/cloud), 'default' (no override). */
  providerRouting?: Record<string, 'local' | 'external' | 'default'>;
  /** When true, tools are automatically routed between local and external providers based on task type.
   * When false, all tools use the default provider only. Default: true. */
  providerRoutingEnabled?: boolean;
}

/** Personal assistant feature configuration. */
export interface AssistantConfig {
  setup: AssistantSetupConfig;
  identity: AssistantIdentityConfig;
  credentials: AssistantCredentialsConfig;
  soul: AssistantSoulConfig;
  skills: AssistantSkillsConfig;
  memory: AssistantMemoryConfig;
  analytics: AssistantAnalyticsConfig;
  notifications: AssistantNotificationsConfig;
  quickActions: AssistantQuickActionsConfig;
  threatIntel: AssistantThreatIntelConfig;
  network: AssistantNetworkConfig;
  hostMonitoring: AssistantHostMonitoringConfig;
  connectors: AssistantConnectorsConfig;
  tools: AssistantToolsConfig;
}

/** Default configuration values. */
export const DEFAULT_CONFIG: GuardianAgentConfig = {
  llm: {
    ollama: {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'llama3.2',
      maxTokens: 2048,
      temperature: 0.7,
      timeoutMs: 120_000,
    },
  },
  defaultProvider: 'ollama',
  agents: [],
  channels: {
    cli: { enabled: true },
    telegram: { enabled: false, polling: true },
    web: {
      enabled: true,
      port: 3000,
      host: 'localhost',
      auth: {
        mode: 'bearer_required',
        rotateOnStartup: false,
      },
    },
  },
  guardian: {
    enabled: true,
    deniedPaths: [],
    additionalSecretPatterns: [],
    logDenials: true,
    rateLimit: {
      maxPerMinute: 30,
      maxPerHour: 500,
      burstAllowed: 5,
      maxPerMinutePerUser: 30,
      maxPerHourPerUser: 500,
      maxGlobalPerMinute: 300,
      maxGlobalPerHour: 5000,
    },
    inputSanitization: {
      enabled: true,
      blockThreshold: 3,
    },
    outputScanning: {
      enabled: true,
      redactSecrets: true,
    },
    piiRedaction: {
      enabled: true,
      mode: 'redact',
      entities: [...DEFAULT_PII_ENTITIES],
      providerScope: 'external',
    },
    sentinel: {
      enabled: true,
      schedule: '*/5 * * * *',
      anomalyThresholds: {
        volumeSpikeMultiplier: 3,
        capabilityProbeThreshold: 5,
        secretDetectionThreshold: 3,
      },
    },
    auditLog: {
      maxEvents: 10_000,
      persistenceEnabled: true,
    },
    policy: {
      enabled: true,
      mode: 'shadow',
      rulesPath: 'policies/',
      mismatchLogLimit: 1000,
    },
  },
  runtime: {
    maxStallDurationMs: 180_000,
    watchdogIntervalMs: 10_000,
    logLevel: 'warn',
  },
  failover: {
    enabled: true,
    failureThreshold: 3,
    resetTimeoutMs: 30_000,
  },
  routing: {
    strategy: 'keyword',
    tierMode: 'auto',
    complexityThreshold: 0.5,
    fallbackOnFailure: true,
    maxFallbackAttempts: 1,
  },
  assistant: {
    setup: {
      completed: false,
    },
    identity: {
      mode: 'single_user',
      primaryUserId: 'owner',
      aliases: {},
    },
    credentials: {
      refs: {},
    },
    soul: {
      enabled: true,
      path: 'SOUL.md',
      maxChars: 8000,
      primaryMode: 'full',
      delegatedMode: 'summary',
      summaryMaxChars: 1000,
    },
    skills: {
      enabled: true,
      roots: ['./skills'],
      autoSelect: true,
      maxActivePerRequest: 3,
      disabledSkills: [],
    },
    memory: {
      enabled: true,
      maxTurns: 12,
      maxMessageChars: 4000,
      maxContextChars: 12000,
      retentionDays: 30,
      knowledgeBase: {
        enabled: true,
        maxContextChars: 4000,
        maxFileChars: 20000,
        autoFlush: true,
      },
    },
    analytics: {
      enabled: true,
      retentionDays: 30,
    },
    notifications: {
      enabled: true,
      minSeverity: 'warn',
      auditEventTypes: [
        'anomaly_detected',
        'host_alert',
        'action_denied',
        'secret_detected',
        'policy_changed',
        'policy_mode_changed',
        'policy_shadow_mismatch',
        'agent_error',
        'agent_stalled',
      ],
      cooldownMs: 60_000,
      destinations: {
        web: true,
        cli: true,
        telegram: true,
      },
    },
    quickActions: {
      enabled: true,
      templates: {
        email: 'Draft a concise, professional email based on these details:\n{details}\n\nInclude: subject, greeting, body, and sign-off.',
        task: 'Turn this into a clear prioritized task list with owner/time suggestions:\n{details}',
        calendar: 'Create a calendar-ready event plan from these details:\n{details}\n\nInclude: title, agenda, time estimate, and follow-ups.',
      },
    },
    threatIntel: {
      enabled: true,
      allowDarkWeb: false,
      responseMode: 'assisted',
      watchlist: [],
      autoScanIntervalMinutes: 180,
      moltbook: {
        enabled: false,
        mode: 'mock',
        baseUrl: 'https://moltbook.com',
        searchPath: '/api/v1/posts/search',
        requestTimeoutMs: 8_000,
        maxPostsPerQuery: 20,
        maxResponseBytes: 262_144,
        allowedHosts: ['moltbook.com', 'api.moltbook.com'],
        allowActiveResponse: false,
      },
    },
    network: {
      deviceIntelligence: {
        enabled: true,
        ouiDatabase: 'bundled',
        autoClassify: true,
      },
      baseline: {
        enabled: true,
        minSnapshotsForBaseline: 3,
        dedupeWindowMs: 1_800_000,
        anomalyRules: {
          newDevice: { enabled: true, severity: 'medium' },
          portChange: { enabled: true, severity: 'low' },
          arpSpoofing: { enabled: true, severity: 'critical' },
          unusualService: { enabled: true, severity: 'medium' },
          deviceGone: { enabled: true, severity: 'low' },
          massPortOpen: { enabled: true, severity: 'high' },
        },
      },
      fingerprinting: {
        enabled: true,
        bannerTimeout: 3000,
        maxConcurrentPerDevice: 5,
        autoFingerprint: false,
      },
      wifi: {
        enabled: false,
        platform: 'auto',
        scanInterval: 300,
      },
      trafficAnalysis: {
        enabled: false,
        dataSource: 'ss',
        flowRetention: 86_400_000,
        threatRules: {
          dataExfiltration: { enabled: true, thresholdMB: 100, windowMinutes: 60 },
          portScanning: { enabled: true, portThreshold: 20, windowSeconds: 60 },
          beaconing: { enabled: true, minIntervals: 10, tolerancePercent: 5 },
        },
      },
      connections: [],
    },
    hostMonitoring: {
      enabled: true,
      scanIntervalSec: 300,
      dedupeWindowMs: 1_800_000,
      monitorProcesses: true,
      monitorPersistence: true,
      monitorSensitivePaths: true,
      monitorNetwork: true,
      sensitivePaths: [
        '{HOME}/.guardianagent',
        '{HOME}/.ssh',
        '{HOME}/.aws',
        '{HOME}/.config/gcloud',
        '{HOME}/.azure',
        '{HOME}/.kube/config',
        '{HOME}/.npmrc',
        '{HOME}/.git-credentials',
        '{HOME}/.bashrc',
        '{HOME}/.zshrc',
        '{HOME}/.profile',
        '{HOME}/Documents/WindowsPowerShell/profile.ps1',
        '{HOME}/Documents/PowerShell/Profile.ps1',
        '{HOME}/Library/LaunchAgents',
      ],
      suspiciousProcessNames: [
        'wscript.exe',
        'cscript.exe',
        'mshta.exe',
        'rundll32.exe',
        'regsvr32.exe',
        'bitsadmin.exe',
        'certutil.exe',
        'psexec.exe',
        'osascript',
        'launchctl',
        'socat',
        'nc',
      ],
    },
    connectors: {
      enabled: false,
      executionMode: 'plan_then_execute',
      maxConnectorCallsPerRun: 12,
      packs: [],
      playbooks: {
        definitions: [],
        enabled: true,
        maxSteps: 12,
        maxParallelSteps: 3,
        defaultStepTimeoutMs: 15_000,
        requireSignedDefinitions: false,
        requireDryRunOnFirstExecution: false,
      },
      studio: {
        enabled: true,
        mode: 'builder',
        requirePrivilegedTicket: true,
      },
    },
    tools: {
      enabled: true,
      policyMode: 'approve_by_policy',
      toolPolicies: {
        forum_post: 'manual',
      },
      allowExternalPosting: false,
      allowedPaths: ['.'],
      allowedCommands: [
        'node',
        'npm',
        'npx',
        'git status',
        'git diff',
        'git log',
        'ollama',
        'ls',
        'dir',
        'pwd',
        'echo',
        'cat',
        'head',
        'tail',
        'whoami',
        'hostname',
        'uname',
        'date',
      ],
      allowedDomains: [
        'localhost',
        '127.0.0.1',
        'moltbook.com',
        'gmail.googleapis.com',
        'www.googleapis.com',
        'googleapis.com',
        'management.azure.com',
        'login.microsoftonline.com',
        'blob.core.windows.net',
        'html.duckduckgo.com',
        'api.search.brave.com',
        'api.perplexity.ai',
        'openrouter.ai',
      ],
      browser: { enabled: true },
      cloud: {
        enabled: false,
        cpanelProfiles: [],
        vercelProfiles: [],
        cloudflareProfiles: [],
        awsProfiles: [],
        gcpProfiles: [],
        azureProfiles: [],
      },
      qmd: {
        enabled: true,
        defaultMode: 'query',
        queryTimeoutMs: 30_000,
        maxResults: 20,
        sources: [],
      },
      agentPolicyUpdates: {
        allowedPaths: true,
        allowedCommands: false,
        allowedDomains: true,
      },
      deferredLoading: {
        enabled: true,
        alwaysLoaded: ['find_tools', 'web_search', 'fs_read', 'shell_safe', 'memory_search', 'memory_save'],
      },
      contextBudget: 80_000,
      providerRouting: {},
      providerRoutingEnabled: true,
      disabledCategories: [],
      sandbox: {
        enabled: true,
        enforcementMode: 'strict',
        mode: 'workspace-write',
        networkAccess: false,
        additionalWritePaths: [],
        additionalReadPaths: [],
        resourceLimits: {
          maxMemoryMb: 512,
          maxCpuSeconds: 60,
          maxFileSizeKb: 10_240,
          maxProcesses: 0,
        },
      },
    },
  },
};
