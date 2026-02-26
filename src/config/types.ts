/**
 * Configuration types for GuardianAgent.
 *
 * Loaded from ~/.guardianagent/config.yaml with environment variable
 * interpolation and deep-merged with defaults.
 */

/** Top-level configuration. */
export interface GuardianAgentConfig {
  /** LLM provider configurations. */
  llm: Record<string, LLMConfig>;
  /** Default LLM provider name (key in llm map). */
  defaultProvider: string;
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
}

/** Configuration for a single LLM provider. */
export interface LLMConfig {
  /** Provider type: 'ollama' | 'anthropic' | 'openai'. */
  provider: 'ollama' | 'anthropic' | 'openai';
  /** API key (supports ${ENV_VAR} interpolation). */
  apiKey?: string;
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
      mode?: 'bearer_required' | 'localhost_no_auth' | 'disabled';
      /** Bearer token value (supports ${ENV_VAR} interpolation). */
      token?: string;
      /** Rotate token on startup and persist generated value. */
      rotateOnStartup?: boolean;
      /** Optional client session TTL hint in minutes. */
      sessionTtlMinutes?: number;
      /** Runtime metadata about where the active token came from. */
      tokenSource?: 'config' | 'env' | 'ephemeral';
    };
    /** Allowed CORS origins (default: none / same-origin). */
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
  /** Sentinel agent configuration. */
  sentinel?: {
    /** Enable Sentinel agent (default: true). */
    enabled: boolean;
    /** Cron schedule for analysis (default: every 5 min). */
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
}

/** Personal assistant feature configuration. */
export interface AssistantConfig {
  setup: AssistantSetupConfig;
  identity: AssistantIdentityConfig;
  memory: AssistantMemoryConfig;
  analytics: AssistantAnalyticsConfig;
  quickActions: AssistantQuickActionsConfig;
  threatIntel: AssistantThreatIntelConfig;
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
    },
    inputSanitization: {
      enabled: true,
      blockThreshold: 3,
    },
    outputScanning: {
      enabled: true,
      redactSecrets: true,
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
    },
  },
  runtime: {
    maxStallDurationMs: 60_000,
    watchdogIntervalMs: 10_000,
    logLevel: 'warn',
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
    memory: {
      enabled: true,
      maxTurns: 12,
      maxMessageChars: 4000,
      maxContextChars: 12000,
      retentionDays: 30,
    },
    analytics: {
      enabled: true,
      retentionDays: 30,
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
      ],
      allowedDomains: [
        'localhost',
        '127.0.0.1',
        'moltbook.com',
        'gmail.googleapis.com',
        'www.googleapis.com',
      ],
    },
  },
};
