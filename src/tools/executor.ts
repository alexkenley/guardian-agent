/**
 * Tool execution runtime with policy, sandboxing, and approvals.
 */

import Ajv from 'ajv';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve, sep } from 'node:path';
import { sanitizeShellArgs, scanWriteContent, validateArgSize } from '../guardian/argument-sanitizer.js';
import {
  classifyParsedCommandExecution,
  getExecutionIdentityBlockReason,
  splitCommands,
  tokenize,
  validateShellCommand,
  type ParsedCommand,
  type ShellExecutionClass,
} from '../guardian/shell-validator.js';
import { normalizeHttpUrlInput, normalizeHttpUrlRecord, normalizeOptionalHttpUrlInput } from '../config/input-normalization.js';
import type { ThreatIntelService } from '../runtime/threat-intel.js';
import type {
  AiSecurityRunSource,
  AiSecurityScanResult,
  AiSecurityService,
} from '../runtime/ai-security.js';
import type { CodingBackendService } from '../runtime/coding-backend-service.js';
import type { PackageInstallTrustService } from '../runtime/package-install-trust-service.js';
import {
  isInstallLikePackageManagerCommand,
  parseManagedPackageInstallCommand,
} from '../runtime/package-install-trust.js';
import {
  isRemoteExecutionTargetReady,
  listRemoteExecutionTargets,
  prioritizeReadyRemoteExecutionTargets,
  type RemoteExecutionTargetDescriptor,
} from '../runtime/remote-execution/policy.js';
import {
  RemoteExecutionService,
  RemoteExecutionTargetUnavailableError,
} from '../runtime/remote-execution/remote-execution-service.js';
import { DaytonaRemoteExecutionProvider } from '../runtime/remote-execution/providers/daytona-remote-execution.js';
import { VercelRemoteExecutionProvider } from '../runtime/remote-execution/providers/vercel-remote-execution.js';
import type {
  RemoteExecutionLease,
  RemoteExecutionResolvedTarget,
  RemoteExecutionRunRequest,
  RemoteExecutionRunResult,
  RemoteExecutionServiceLike,
} from '../runtime/remote-execution/types.js';
import { MarketingStore } from './marketing-store.js';
import { ToolApprovalStore } from './approvals.js';
import { ToolRegistry } from './registry.js';
import { canonicalizePolicyPathValue, normalizePathForHost } from './path-normalization.js';
import { hashRedactedObject, redactSensitiveValue } from '../util/crypto-guardrails.js';
import type {
  ToolApprovalRequest,
  ToolCategory,
  ToolDecision,
  ToolDefinition,
  ToolExecutionRequest,
  ToolJobRecord,
  ToolJobRemoteExecutionInfo,
  ToolJobStatus,
  ToolPolicyMode,
  ToolPolicySetting,
  ToolPolicySnapshot,
  ToolResult,
  ToolRunResponse,
  ToolRuntimeNotice,
} from './types.js';
import { TOOL_CATEGORIES, BUILTIN_TOOL_CATEGORIES } from './types.js';
import { MCPClientManager } from './mcp-client.js';
import { HybridBrowserService, type HybridBrowserMode } from './browser-hybrid.js';
import {
  DEFAULT_TOOL_ALLOWED_COMMANDS,
  type AssistantCloudConfig,
  type AssistantNetworkConfig,
  type BrowserConfig,
  type WebSearchConfig,
} from '../config/types.js';
import type { ConversationService } from '../runtime/conversation.js';
import type { AgentMemoryStore } from '../runtime/agent-memory-store.js';
import type {
  CodeSessionManagedSandbox,
  CodeSessionRecord,
  CodeSessionStore,
} from '../runtime/code-sessions.js';
import { resolveCodeSessionTarget } from '../runtime/code-session-targets.js';
import { getEffectiveCodeWorkspaceTrustState } from '../runtime/code-workspace-trust.js';
import { isPrivateAddress } from '../guardian/ssrf-protection.js';
import { sandboxedExec, sandboxedSpawn, type SandboxConfig, DEFAULT_SANDBOX_CONFIG } from '../sandbox/index.js';
import type { SandboxHealth, SandboxProfile } from '../sandbox/types.js';
import {
  isBrowserMcpToolName,
  isDegradedSandboxFallbackActive,
  isStrictSandboxLockdown,
  listEnabledDegradedFallbackAllowances,
  resolveDegradedFallbackConfig,
} from '../sandbox/security-controls.js';
import { realpath } from 'node:fs/promises';
import type { DeviceInventoryService } from '../runtime/device-inventory.js';
import type { NetworkBaselineService } from '../runtime/network-baseline.js';
import type { NetworkTrafficService } from '../runtime/network-traffic.js';
import type { HostMonitoringService, HostMonitorReport } from '../runtime/host-monitor.js';
import type { GatewayFirewallMonitoringService, GatewayMonitorReport } from '../runtime/gateway-monitor.js';
import type { ContainmentService } from '../runtime/containment-service.js';
import type { WindowsDefenderProvider } from '../runtime/windows-defender-provider.js';
import type { SavedAutomationCatalogEntry } from '../runtime/automation-catalog.js';
import type { AutomationSaveInput } from '../runtime/automation-save.js';
import type { AutomationOutputStore } from '../runtime/automation-output-store.js';
import type { PersistMemoryEntryResult } from '../runtime/memory-mutation-service.js';
import type { PerformanceService } from '../runtime/performance-service.js';
import type { ScheduledTaskEventTrigger } from '../runtime/scheduled-tasks.js';
import {
  getMemoryMutationIntentDeniedMessage,
  isDirectMemoryMutationToolName,
  isElevatedMemoryMutationToolName,
  isMemoryMutationToolName,
} from '../util/memory-intent.js';
import { describePendingApproval, type PendingApprovalSummary } from '../runtime/pending-approval-copy.js';
import type { AwsClient, AwsInstanceConfig } from './cloud/aws-client.js';
import type { AzureClient, AzureInstanceConfig, AzureServiceName } from './cloud/azure-client.js';
import type { CpanelClient, CpanelInstanceConfig } from './cloud/cpanel-client.js';
import { normalizeCpanelConnectionConfig } from './cloud/cpanel-profile.js';
import type { CloudflareClient, CloudflareInstanceConfig } from './cloud/cloudflare-client.js';
import type { GcpClient, GcpInstanceConfig, GcpServiceName } from './cloud/gcp-client.js';
import type { VercelClient, VercelInstanceConfig } from './cloud/vercel-client.js';
import {
  WorkspaceDependencyLedger,
  captureJsDependencySnapshot,
  detectJsDependencyMutationIntent,
  diffJsDependencySnapshots,
  type JsDependencyMutationIntent,
  type JsDependencySnapshot,
} from '../runtime/workspace-dependency-ledger.js';
import { registerBuiltinWebTools } from './builtin/web-tools.js';
import { registerBuiltinAutomationTools } from './builtin/automation-tools.js';
import { registerBuiltinContactsEmailTools } from './builtin/contacts-email-tools.js';
import { registerBuiltinCodingTools } from './builtin/coding-tools.js';
import { registerBuiltinFilesystemTools } from './builtin/filesystem-tools.js';
import { registerBuiltinMemoryTools } from './builtin/memory-tools.js';
import { registerBuiltinNetworkSystemTools } from './builtin/network-system-tools.js';
import { registerBuiltinPolicyTools } from './builtin/policy-tools.js';
import { registerBuiltinProviderTools } from './builtin/provider-tools.js';
import { registerBuiltinPerformanceTools } from './builtin/performance-tools.js';
import { registerBuiltinSecurityIntelTools } from './builtin/security-intel-tools.js';
import { registerBuiltinSearchTools } from './builtin/search-tools.js';
import { registerBuiltinSecondBrainTools } from './builtin/second-brain-tools.js';
import { registerBuiltinWorkspaceTools } from './builtin/workspace-tools.js';
import { registerBuiltinCloudTools } from './builtin/cloud-tools.js';
import { syncBuiltinBrowserTools } from './builtin/browser-tools.js';
import { buildToolContext, type ToolContextCloudProfileSummary } from './tool-context.js';
import type { ConfigUpdate, DashboardMutationResult } from '../channels/web-types.js';
export { validateHostParam } from './builtin/network-system-tools.js';

const MAX_JOBS = 200;
const MAX_APPROVALS = 200;
const MAX_READ_BYTES = 1_000_000;
const MAX_FETCH_BYTES = 500_000;
const MAX_WEB_FETCH_CHARS = 20_000;
const MAX_CAMPAIGN_RECIPIENTS = 500;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILES = 100_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const SEARCH_CACHE_TTL_MS = 300_000; // 5 minutes
const MAX_TOOL_ARG_BYTES = 128_000;
const TOOL_CHAIN_TTL_MS = 10 * 60_000;
const MAX_TOOL_CALLS_PER_CHAIN = 24;
const MAX_NON_READ_ONLY_CALLS_PER_CHAIN = 8;
const MAX_IDENTICAL_CALLS_PER_CHAIN = 3;
const MAX_IDENTICAL_FAILURES_PER_CHAIN = 2;
const MANAGED_SANDBOX_RECONCILE_INTERVAL_MS = 30_000;
const DEGRADED_PACKAGE_MANAGER_HINT = 'assistant.tools.sandbox.degradedFallback.allowPackageManagers';
const POSIX_SHELL_BUILTINS = new Set(['type']);
const WINDOWS_SHELL_BUILTINS = new Set(['cd', 'dir', 'echo', 'type']);
const WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS = new Set(['.com', '.exe']);
type PersistentMemorySearchMatch = {
  id: string;
  createdAt: string;
  category?: string;
  summary?: string;
  content: string;
  trustLevel?: string;
  status?: string;
  tags?: string[];
  provenance?: Record<string, unknown>;
  matchScore: number;
};
type ConversationMemorySearchCandidate = {
  key: string;
  source: 'conversation';
  type: 'conversation_message';
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  channel: string;
  sessionId: string;
  scoreHint: number;
};
type PersistentMemorySearchCandidate = {
  key: string;
  source: 'global' | 'code_session';
  type: 'memory_entry';
  entryId: string;
  createdAt: string;
  category?: string;
  summary?: string;
  content: string;
  trustLevel?: string;
  status?: string;
  tags?: string[];
  provenance?: Record<string, unknown>;
  scoreHint: number;
};
type UnifiedMemorySearchCandidate = ConversationMemorySearchCandidate | PersistentMemorySearchCandidate;
type PersistentMemoryContextTarget = {
  source: 'global' | 'code_session';
  id: string;
  store?: AgentMemoryStore;
  guardPath: string;
};
const CODE_ASSISTANT_ALLOWED_COMMANDS = [
  'git',
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'python',
  'python3',
  'pip',
  'pip3',
  'uv',
  'pytest',
  'cargo',
  'rustc',
  'go',
  'gofmt',
  'java',
  'javac',
  'gradle',
  'mvn',
  'dotnet',
  'php',
  'composer',
  'ruby',
  'bundle',
  'gem',
  'deno',
  'make',
  'cmake',
  'ollama',
  'ls',
  'dir',
  'pwd',
  'echo',
  'cat',
  'head',
  'tail',
  'wc',
  'which',
  'type',
  'file',
  'find',
  'rg',
  'grep',
  'sed',
  'awk',
] as const;
const CODE_DISALLOWED_SHELL_TOKENS = new Map<string, string>([
  ['-C', 'Directory override flags like git -C are blocked in the Coding Workspace. Use cwd or the session workspace root instead.'],
  ['--git-dir', 'Git repository indirection is blocked in the Coding Workspace.'],
  ['--work-tree', 'Git work tree overrides are blocked in the Coding Workspace.'],
  ['--super-prefix', 'Git prefix overrides are blocked in the Coding Workspace.'],
  ['--exec-path', 'Git exec-path overrides are blocked in the Coding Workspace.'],
  ['--prefix', 'Prefix overrides are blocked in the Coding Workspace.'],
  ['--cwd', 'Working-directory override flags are blocked in the Coding Workspace. Use the tool cwd field instead.'],
  ['--cache', 'Cache path overrides are blocked in the Coding Workspace.'],
  ['--cache-dir', 'Cache path overrides are blocked in the Coding Workspace.'],
  ['--userconfig', 'User config overrides are blocked in the Coding Workspace.'],
  ['--globalconfig', 'Global config overrides are blocked in the Coding Workspace.'],
  ['-g', 'Global installs are blocked in the Coding Workspace.'],
  ['--global', 'Global installs are blocked in the Coding Workspace.'],
  ['global', 'Global installs are blocked in the Coding Workspace.'],
  ['--location=global', 'Global installs are blocked in the Coding Workspace.'],
  ['--user', 'User-level installs are blocked in the Coding Workspace.'],
]);
const CODE_DISALLOWED_SHELL_TOKEN_PREFIXES = new Map<string, string>([
  ['--git-dir=', 'Git repository indirection is blocked in the Coding Workspace.'],
  ['--work-tree=', 'Git work tree overrides are blocked in the Coding Workspace.'],
  ['--prefix=', 'Prefix overrides are blocked in the Coding Workspace.'],
  ['--cwd=', 'Working-directory override flags are blocked in the Coding Workspace.'],
  ['--cache=', 'Cache path overrides are blocked in the Coding Workspace.'],
  ['--cache-dir=', 'Cache path overrides are blocked in the Coding Workspace.'],
  ['--userconfig=', 'User config overrides are blocked in the Coding Workspace.'],
  ['--globalconfig=', 'Global config overrides are blocked in the Coding Workspace.'],
]);
const CODE_SESSION_SAFE_AUTO_APPROVED_TOOLS = new Set([
  'code_edit',
  'code_patch',
  'code_create',
  'code_plan',
  'code_git_diff',
  'code_symbol_search',
  'fs_read',
  'fs_write',
  'fs_search',
  'fs_list',
  'fs_mkdir',
  'fs_move',
  'fs_copy',
  'fs_delete',
  'memory_search',
  'memory_recall',
  'doc_create',
]);
const CODE_SESSION_TRUSTED_EXECUTION_TOOLS = new Set([
  'shell_safe',
  'code_git_commit',
  'code_test',
  'code_build',
  'code_lint',
  'automation_save',
  'automation_set_enabled',
  'automation_run',
  'automation_delete',
]);
const CODE_SESSION_UNTRUSTED_APPROVAL_TOOLS = new Set([
  'shell_safe',
  ...CODE_SESSION_TRUSTED_EXECUTION_TOOLS,
]);

type ShellExecMode = 'direct_exec' | 'shell_fallback';

interface ShellCommandPlan {
  commands: ParsedCommand[];
  entryCommand: string;
  argv: string[];
  executionClass: ShellExecutionClass;
  requestedViaShell: boolean;
  execMode: ShellExecMode;
  resolvedExecutable?: string;
}

interface ShellCommandCheck {
  safe: boolean;
  reason?: string;
  plan?: ShellCommandPlan;
}

interface PendingJsDependencyTracking {
  intent: JsDependencyMutationIntent;
  before: JsDependencySnapshot | null;
  workspaceRoot: string;
  cwd: string;
}

function normalizeShellCommandName(command: string): string {
  const trimmed = command.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const basename = trimmed.split(/[\\/]/).pop();
  return (basename || trimmed).toLowerCase();
}
type AwsServiceName =
  | 'sts'
  | 'ec2'
  | 's3'
  | 'route53'
  | 'lambda'
  | 'cloudwatch'
  | 'cloudwatchLogs'
  | 'rds'
  | 'iam'
  | 'costExplorer';

function emptyCloudConfig(): AssistantCloudConfig {
  return {
    enabled: false,
    cpanelProfiles: [],
    vercelProfiles: [],
    cloudflareProfiles: [],
    awsProfiles: [],
    gcpProfiles: [],
    azureProfiles: [],
  };
}

function normalizeHttpUrlLikeInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

type ToolPreflightRequest = string | { name: string; args?: Record<string, unknown> };

type ToolPreflightFix = {
  type: 'tool_policy' | 'domain' | 'command' | 'path';
  value: string;
  description: string;
};

type ToolPreflightResult = {
  name: string;
  found: boolean;
  risk: string;
  decision: 'allow' | 'deny' | 'require_approval';
  reason: string;
  fixes: ToolPreflightFix[];
};

export interface ToolExecutorOptions {
  enabled: boolean;
  workspaceRoot: string;
  policyMode: ToolPolicyMode;
  toolPolicies?: Record<string, ToolPolicySetting>;
  allowedPaths?: string[];
  allowedCommands?: string[];
  allowedDomains?: string[];
  threatIntel?: ThreatIntelService;
  assistantSecurity?: AiSecurityService;
  packageInstallTrust?: PackageInstallTrustService;
  runAssistantSecurityScan?: (input: {
    profileId?: string;
    targetIds?: string[];
    source?: AiSecurityRunSource;
    requestedBy?: string;
  }) => Promise<AiSecurityScanResult>;
  allowExternalPosting?: boolean;
  /** MCP client manager for external tool server integration. */
  mcpManager?: MCPClientManager;
  /** Web search configuration. Auto-selects best available provider (Brave > Perplexity > DuckDuckGo). */
  webSearch?: WebSearchConfig;
  /** Browser automation configuration (Playwright MCP wrappers). */
  browserConfig?: BrowserConfig;
  /** Allow wrapper tools to fall back to direct Playwright when managed MCP is unavailable. */
  enableDirectPlaywrightFallback?: boolean;
  /** Cloud and hosting provider integrations. */
  cloudConfig?: AssistantCloudConfig;
  /** Remote execution orchestration for bounded isolated jobs. */
  remoteExecutionService?: RemoteExecutionServiceLike;
  /** Tool categories to disable at startup. */
  disabledCategories?: ToolCategory[];
  /** Conversation service for memory_search tool. */
  conversationService?: ConversationService;
  /** Agent memory store for memory_get/memory_save tools. */
  agentMemoryStore?: AgentMemoryStore;
  /** Private historical output store for saved automation runs. */
  automationOutputStore?: AutomationOutputStore;
  /** Dedicated memory store for backend-owned coding sessions. */
  codeSessionMemoryStore?: AgentMemoryStore;
  /** Backend-owned coding session store for multi-surface coding workflows. */
  codeSessionStore?: CodeSessionStore;
  /** Shared runtime memory mutation path for dedupe/upsert-aware durable writes. */
  persistMemoryEntry?: (input: {
    target: {
      scope: 'global' | 'code_session';
      scopeId: string;
      store: AgentMemoryStore;
      auditAgentId: string;
    };
    intent: 'assistant_save' | 'context_flush';
    entry: import('../runtime/agent-memory-store.js').MemoryEntry;
    actor?: string;
    runMaintenance?: boolean;
  }) => PersistMemoryEntryResult;
  /** Resolve logical state identity for chat memory/session operations. */
  resolveStateAgentId?: (agentId?: string) => string | undefined;
  /** Document search service for indexed document collections (hybrid BM25 + vector). */
  docSearch?: import('../search/search-service.js').SearchService;
  /** Shared Second Brain runtime service for notes, tasks, routines, and usage. */
  secondBrainService?: import('../runtime/second-brain/second-brain-service.js').SecondBrainService;
  /** Shared performance runtime service for host status, profile switching, and reviewed cleanup actions. */
  performanceService?: PerformanceService;
  /** Shared Second Brain briefing service for deterministic brief generation. */
  secondBrainBriefingService?: import('../runtime/second-brain/briefing-service.js').BriefingService;
  /** Shared Second Brain horizon scanner for deterministic maintenance runs. */
  secondBrainHorizonScanner?: import('../runtime/second-brain/horizon-scanner.js').HorizonScanner;
  /** Native Google Workspace service (googleapis SDK, replaces gws CLI). */
  googleService?: import('../google/google-service.js').GoogleService;
  /** Native Microsoft 365 service (Graph REST API). */
  microsoftService?: import('../microsoft/microsoft-service.js').MicrosoftService;
  /** Device inventory for network intelligence/baseline tools. */
  deviceInventory?: DeviceInventoryService;
  /** Network baseline and anomaly service. */
  networkBaseline?: NetworkBaselineService;
  /** Traffic baseline + threat analysis service. */
  networkTraffic?: NetworkTrafficService;
  /** Host workstation monitoring service. */
  hostMonitor?: HostMonitoringService;
  /** Centralized host-monitor check wrapper so alerts are audited/notified consistently. */
  runHostMonitorCheck?: (source: string) => Promise<HostMonitorReport>;
  /** Gateway firewall monitoring service. */
  gatewayMonitor?: GatewayFirewallMonitoringService;
  /** Centralized gateway-monitor check wrapper so alerts are audited/notified consistently. */
  runGatewayMonitorCheck?: (source: string) => Promise<GatewayMonitorReport>;
  /** Native Windows Defender status and action provider. */
  windowsDefender?: WindowsDefenderProvider;
  /** Security containment evaluation for effective mode and bounded response state. */
  containmentService?: ContainmentService;
  /** Network feature configuration. */
  networkConfig?: AssistantNetworkConfig;
  /** External coding CLI backend orchestration service. */
  codingBackendService?: CodingBackendService;
  /** OS-level process sandbox configuration. */
  sandboxConfig?: SandboxConfig;
  /** Current sandbox health summary. */
  sandboxHealth?: SandboxHealth;
  now?: () => number;
  onCheckAction?: (action: {
    type: string;
    params: Record<string, unknown>;
    agentId: string;
    origin: ToolExecutionRequest['origin'];
  }) => void;
  /** Controls which policy areas the assistant can modify via chat (always requires approval). */
  agentPolicyUpdates?: import('../config/types.js').AgentPolicyUpdatesConfig;
  /** Callback to persist policy changes to config file after update_tool_policy modifies them. */
  onPolicyUpdate?: (
    policy: ToolPolicySnapshot,
    meta?: { browserAllowedDomains?: string[] },
  ) => void;
  /** Inspect configured LLM provider profiles and routing flags. */
  listLlmProviders?: () => Promise<Array<{
    name: string;
    type: string;
    model: string;
    baseUrl?: string;
    locality: 'local' | 'external';
    tier: 'local' | 'managed_cloud' | 'frontier';
    connected: boolean;
    availableModels?: string[];
    isDefault?: boolean;
    isPreferredLocal?: boolean;
    isPreferredManagedCloud?: boolean;
    isPreferredFrontier?: boolean;
  }>>;
  /** Load the available models for one configured LLM provider profile. */
  listModelsForLlmProvider?: (providerName: string) => Promise<string[]>;
  /** Persist approval-gated provider/default/preferred routing updates. */
  onLlmProviderConfigUpdate?: (updates: ConfigUpdate) => Promise<DashboardMutationResult>;
  /** Async pre-execution hook (Guardian Agent inline evaluation). Called after
   *  sync Guardian checks pass but before the tool handler runs. Can deny. */
  onPreExecute?: (action: {
    type: string;
    toolName: string;
    category?: ToolCategory;
    params: Record<string, unknown>;
    agentId: string;
    origin: ToolExecutionRequest['origin'];
    scheduleId?: string;
    channel?: string;
    principalId?: string;
  }) => Promise<{ allowed: boolean; reason?: string }>;
  /** Executed tool trajectories for eval/tracing. */
  onToolExecuted?: (
    toolName: string,
    args: Record<string, unknown>,
    result: { success: boolean; status: string; message?: string; durationMs: number; error?: string; approvalId?: string },
    request: ToolExecutionRequest
  ) => void;
  onApprovalDecided?: (
    approvalId: string,
    decision: 'approved' | 'denied',
    result: ToolApprovalDecisionResult,
  ) => void | Promise<void>;
}

export interface ToolPolicyUpdate {
  mode?: ToolPolicyMode;
  toolPolicies?: Record<string, ToolPolicySetting>;
  sandbox?: {
    allowedPaths?: string[];
    allowedCommands?: string[];
    allowedDomains?: string[];
  };
}

export interface ToolApprovalDecisionResult {
  success: boolean;
  message: string;
  job?: ToolJobRecord;
  result?: ToolRunResponse;
}

interface PendingApprovalContext {
  request: ToolExecutionRequest;
  args: Record<string, unknown>;
}

interface ToolChainBudgetState {
  totalCalls: number;
  nonReadOnlyCalls: number;
  signatureCounts: Map<string, number>;
  signatureFailureCounts: Map<string, number>;
  lastSeenAt: number;
}

interface AutomationWorkflowSummary {
  id: string;
  name: string;
  enabled: boolean;
  mode: string;
  description?: string;
  schedule?: string;
  steps?: Array<Record<string, unknown>>;
}

interface AutomationTaskSummary {
  id: string;
  name: string;
  description?: string;
  type: 'tool' | 'playbook' | 'agent';
  target: string;
  cron?: string;
  eventTrigger?: ScheduledTaskEventTrigger;
  enabled: boolean;
  args?: Record<string, unknown>;
  prompt?: string;
  channel?: string;
  userId?: string;
  deliver?: boolean;
  runOnce?: boolean;
  approvalExpiresAt?: number;
  approvedByPrincipal?: string;
  scopeHash?: string;
  maxRunsPerWindow?: number;
  dailySpendCap?: number;
  providerSpendCap?: number;
  consecutiveFailureCount?: number;
  consecutiveDeniedCount?: number;
  autoPausedReason?: string;
  emitEvent?: string;
}

interface AutomationControlPlane {
  listAutomations: () => SavedAutomationCatalogEntry[];
  saveAutomation: (input: AutomationSaveInput) => { success: boolean; message: string; automationId?: string; taskId?: string };
  setAutomationEnabled: (automationId: string, enabled: boolean) => { success: boolean; message: string };
  deleteAutomation: (automationId: string) => { success: boolean; message: string };
  runAutomation: (input: {
    automationId: string;
    dryRun?: boolean;
    origin?: ToolExecutionRequest['origin'];
    agentId?: string;
    userId?: string;
    channel?: string;
    requestedBy?: string;
  }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  listWorkflows: () => AutomationWorkflowSummary[];
  upsertWorkflow: (workflow: Record<string, unknown>) => { success: boolean; message: string };
  deleteWorkflow: (workflowId: string) => { success: boolean; message: string };
  runWorkflow: (input: {
    workflowId: string;
    dryRun?: boolean;
    origin?: ToolExecutionRequest['origin'];
    agentId?: string;
    userId?: string;
    channel?: string;
    requestedBy?: string;
  }) => Promise<{ success: boolean; message: string; status: string; run?: unknown }> | { success: boolean; message: string; status: string; run?: unknown };
  listTasks: () => AutomationTaskSummary[];
  createTask: (input: Record<string, unknown>) => { success: boolean; message: string; task?: AutomationTaskSummary };
  updateTask: (id: string, input: Record<string, unknown>) => { success: boolean; message: string };
  runTask: (id: string) => Promise<{ success: boolean; message: string }> | { success: boolean; message: string };
  deleteTask: (id: string) => { success: boolean; message: string };
}

export class ToolExecutor {
  private readonly registry = new ToolRegistry();
  private readonly approvals = new ToolApprovalStore();
  private readonly dependencyLedgers = new Map<string, WorkspaceDependencyLedger>();
  private readonly jobs: ToolJobRecord[] = [];
  private readonly jobsById = new Map<string, ToolJobRecord>();
  private readonly pendingApprovalContexts = new Map<string, PendingApprovalContext>();
  private readonly toolChainBudgets = new Map<string, ToolChainBudgetState>();
  private readonly options: ToolExecutorOptions;
  private automationControlPlane?: AutomationControlPlane;
  private readonly marketingStore: MarketingStore;
  private readonly mcpManager?: MCPClientManager;
  private readonly hybridBrowser?: HybridBrowserService;
  private webSearchConfig: WebSearchConfig;
  private readonly searchCache = new Map<string, { results: unknown; timestamp: number }>();
  private readonly now: () => number;
  private readonly disabledCategories: Set<string>;
  private readonly sandboxConfig: SandboxConfig;
  private readonly sandboxHealth?: SandboxHealth;
  private readonly networkConfig: AssistantNetworkConfig;
  private cloudConfig: AssistantCloudConfig;
  private policy: ToolPolicySnapshot;
  private readonly runtimeNotices: ToolRuntimeNotice[] = [];
  private remoteExecutionService?: RemoteExecutionServiceLike;
  private cpanelClientModulePromise?: Promise<typeof import('./cloud/cpanel-client.js')>;
  private vercelClientModulePromise?: Promise<typeof import('./cloud/vercel-client.js')>;
  private cloudflareClientModulePromise?: Promise<typeof import('./cloud/cloudflare-client.js')>;
  private awsClientModulePromise?: Promise<typeof import('./cloud/aws-client.js')>;
  private gcpClientModulePromise?: Promise<typeof import('./cloud/gcp-client.js')>;
  private azureClientModulePromise?: Promise<typeof import('./cloud/azure-client.js')>;

  constructor(options: ToolExecutorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.disabledCategories = new Set(options.disabledCategories ?? []);
    this.mcpManager = options.mcpManager;
    this.hybridBrowser = this.mcpManager ? new HybridBrowserService(this.mcpManager, {
      now: this.now,
      browserConfig: options.browserConfig,
      enableDirectPlaywright: options.enableDirectPlaywrightFallback === true,
    }) : undefined;
    this.webSearchConfig = options.webSearch ?? {};
    this.sandboxConfig = options.sandboxConfig ?? DEFAULT_SANDBOX_CONFIG;
    this.sandboxHealth = options.sandboxHealth;
    this.cloudConfig = options.cloudConfig ?? emptyCloudConfig();
    this.remoteExecutionService = options.remoteExecutionService;
    this.networkConfig = options.networkConfig ?? {
      deviceIntelligence: { enabled: true, ouiDatabase: 'bundled', autoClassify: true },
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
      fingerprinting: { enabled: true, bannerTimeout: 3000, maxConcurrentPerDevice: 5, autoFingerprint: false },
      wifi: { enabled: false, platform: 'auto', scanInterval: 300 },
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
    };
    this.marketingStore = new MarketingStore(options.workspaceRoot, this.now);
    this.policy = {
      mode: options.policyMode,
      toolPolicies: { ...(options.toolPolicies ?? {}) },
      sandbox: {
        allowedPaths: options.allowedPaths?.length
          ? [...options.allowedPaths]
          : [options.workspaceRoot],
        allowedCommands: options.allowedCommands?.length
          ? [...options.allowedCommands]
          : [...DEFAULT_TOOL_ALLOWED_COMMANDS],
        allowedDomains: options.allowedDomains?.length
          ? [...options.allowedDomains]
          : ['localhost', '127.0.0.1', 'moltbook.com'],
      },
    };
    this.initializeSandboxNotices();
    this.registerBuiltinTools();
    if (this.mcpManager) {
      this.refreshDynamicMcpTooling();
    }
  }

  /**
   * Register all tools discovered from connected MCP servers.
   *
   * Each MCP tool is registered with a handler that delegates to
   * MCPClientManager.callTool(). The tool name is namespaced as
   * mcp-<serverId>-<toolName> to prevent collisions.
   *
   * Call this again after connecting new MCP servers to refresh.
   */
  registerMCPTools(): void {
    this.refreshDynamicMcpTooling();
  }

  refreshDynamicMcpTooling(): void {
    if (!this.mcpManager) return;

    const definitions = this.mcpManager.getAllToolDefinitions();
    const currentNames = new Set(definitions.map((definition) => definition.name));
    for (const registered of this.registry.listDefinitions()) {
      if (registered.name.startsWith('mcp-') && !currentNames.has(registered.name)) {
        this.registry.unregister(registered.name);
      }
    }

    for (const def of definitions) {
      const normalizedDef = !def.category
        ? {
          ...def,
          category: isBrowserMcpToolName(def.name) ? 'browser' as const : 'mcp' as const,
        }
        : def;
      const manager = this.mcpManager;
      this.registry.register(normalizedDef, async (args, request) => {
        const guard = inferMCPGuardAction(normalizedDef);
        if (guard) {
          this.guardAction(request, guard.type, {
            toolName: normalizedDef.name,
            ...guard.params,
          });
        }
        return manager.callTool(normalizedDef.name, args);
      });
    }

    this.syncHybridBrowserTools();
  }

  setBrowserConfig(browserConfig: BrowserConfig | undefined): void {
    this.options.browserConfig = browserConfig;
    this.hybridBrowser?.setBrowserConfig(browserConfig);
  }

  setCodingBackendService(codingBackendService: CodingBackendService | undefined): void {
    this.options.codingBackendService = codingBackendService;
  }

  private syncHybridBrowserTools(): void {
    syncBuiltinBrowserTools({
      registry: this.registry,
      hybridBrowser: this.hybridBrowser,
      browserConfig: this.options.browserConfig,
      getHybridBrowserScopeKey: (request) => this.getHybridBrowserScopeKey(request),
      normalizeBrowserUrlArg: (toolName, value) => this.normalizeBrowserUrlArg(toolName, value),
      normalizeHybridBrowserMode: (value) => this.normalizeHybridBrowserMode(value),
      asString,
      guardAction: (request, action, details) => this.guardAction(request, action, details),
    });
  }

  private getHybridBrowserScopeKey(request: Partial<ToolExecutionRequest>): string {
    const codeSessionId = request.codeContext?.sessionId?.trim();
    if (codeSessionId) return `code:${codeSessionId}`;
    const principalId = request.principalId?.trim();
    if (principalId) return `principal:${request.channel ?? 'unknown'}:${principalId}`;
    const userId = request.userId?.trim();
    if (userId) return `user:${request.channel ?? 'unknown'}:${userId}`;
    const requestId = request.requestId?.trim();
    if (requestId) return `request:${requestId}`;
    return `agent:${request.agentId ?? 'assistant-tools'}`;
  }

  private normalizeBrowserUrlArg(
    toolName: string,
    value: unknown,
  ): { url?: string; error?: string } {
    const raw = asString(value, '').trim();
    if (!raw) return {};
    const urlText = normalizeHttpUrlLikeInput(raw);
    let parsed: URL;
    try {
      parsed = new URL(urlText);
    } catch {
      return { error: `Invalid URL '${raw}'.` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: 'Browser tools only support http and https URLs.' };
    }
    if (isPrivateAddress(parsed.hostname)) {
      return { error: `Blocked: ${parsed.hostname} is a private/internal address (SSRF protection).` };
    }
    const host = parsed.hostname.toLowerCase();
    if (!this.isHostAllowedForTool(toolName, host)) {
      return {
        error: this.isBrowserFacingTool(toolName)
          ? `Host '${host}' is not in the browser allowedDomains.`
          : `Host '${host}' is not in allowedDomains.`,
      };
    }
    return { url: urlText };
  }

  private normalizeHybridBrowserMode(value: unknown): HybridBrowserMode {
    const mode = asString(value, 'auto').trim().toLowerCase();
    return mode === 'read' || mode === 'interactive' ? mode : 'auto';
  }

  isEnabled(): boolean {
    return this.options.enabled;
  }

  getBrowserCapabilities(): { available: boolean; read: string; interact: string; directBackend: boolean; mcpTools: number } {
    const capabilities = this.hybridBrowser?.getCapabilities();
    return {
      available: capabilities?.available ?? false,
      read: capabilities?.preferredReadBackend ?? 'none',
      interact: capabilities?.preferredInteractionBackend ?? 'none',
      directBackend: !!capabilities?.backends.playwright.moduleName || !!capabilities?.backends.playwright.unavailableReason,
      mcpTools: this.mcpManager?.getAllToolDefinitions().filter(d => d.name.startsWith('mcp-playwright-')).length ?? 0,
    };
  }

  getRemoteExecutionTargets(): RemoteExecutionTargetDescriptor[] {
    return listRemoteExecutionTargets(this.cloudConfig, {
      healthByTargetId: this.remoteExecutionService?.getKnownTargetHealth?.(),
    });
  }

  private resolveRemoteExecutionTargetDescriptorByProfileHint(
    targets: RemoteExecutionTargetDescriptor[],
    profileHint: string | undefined,
  ): RemoteExecutionTargetDescriptor | null {
    const trimmedHint = profileHint?.trim();
    if (!trimmedHint) return null;
    const exact = targets.find((entry) => entry.profileId === trimmedHint);
    if (exact) return exact;
    const normalize = (value: string | undefined): string => (
      (value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ')
    );
    const normalizedHint = normalize(trimmedHint);
    if (!normalizedHint) return null;
    const normalizedMatch = targets.find((entry) => (
      normalize(entry.profileId) === normalizedHint
      || normalize(entry.profileName) === normalizedHint
    ));
    if (normalizedMatch) return normalizedMatch;
    const familyMatches = targets.filter((entry) => normalize(entry.providerFamily) === normalizedHint);
    return familyMatches.length === 1 ? familyMatches[0] : null;
  }

  resolveRemoteExecutionTarget(profileId?: string, commandString?: string): RemoteExecutionResolvedTarget | null {
    const descriptor = this.resolveRemoteExecutionTargetDescriptors(profileId, commandString)[0];
    return descriptor ? this.getResolvedRemoteExecutionTargetFromDescriptor(descriptor) : null;
  }

  private resolveRemoteExecutionTargetDescriptors(
    profileId?: string,
    _commandString?: string,
    preferredTargetIds: string[] = [],
  ): RemoteExecutionTargetDescriptor[] {
    const targets = this.getRemoteExecutionTargets();
    const requestedProfileId = profileId?.trim();

    if (requestedProfileId) {
      const descriptor = this.resolveRemoteExecutionTargetDescriptorByProfileHint(targets, requestedProfileId);
      if (!descriptor || !isRemoteExecutionTargetReady(descriptor)) {
        return [];
      }
      const prioritized = prioritizeReadyRemoteExecutionTargets(targets, preferredTargetIds);
      return [
        descriptor,
        ...prioritized.filter((entry) => entry.id !== descriptor.id),
      ];
    }

    return prioritizeReadyRemoteExecutionTargets(targets, [
      ...preferredTargetIds,
      this.cloudConfig.defaultRemoteExecutionTargetId?.trim(),
    ]);
  }

  private getResolvedRemoteExecutionTargetFromDescriptor(
    descriptor: RemoteExecutionTargetDescriptor,
  ): RemoteExecutionResolvedTarget | null {
    if (descriptor.backendKind === 'vercel_sandbox') {
      return this.getResolvedVercelSandboxTarget(descriptor.profileId);
    }
    if (descriptor.backendKind === 'daytona_sandbox') {
      return this.getResolvedDaytonaSandboxTarget(descriptor.profileId);
    }
    return null;
  }

  private getCodeSessionRecord(
    sessionId: string,
    ownerUserId?: string,
  ): CodeSessionRecord | null {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || !this.options.codeSessionStore) {
      return null;
    }
    const trimmedOwnerUserId = ownerUserId?.trim();
    return trimmedOwnerUserId
      ? this.options.codeSessionStore.getSession(normalizedSessionId, trimmedOwnerUserId) ?? null
      : this.options.codeSessionStore.getSession(normalizedSessionId) ?? null;
  }

  private toRemoteExecutionLease(record: CodeSessionManagedSandbox): RemoteExecutionLease {
    return {
      id: record.leaseId,
      targetId: record.targetId,
      backendKind: record.backendKind,
      profileId: record.profileId,
      profileName: record.profileName,
      sandboxId: record.sandboxId,
      localWorkspaceRoot: record.localWorkspaceRoot,
      remoteWorkspaceRoot: record.remoteWorkspaceRoot,
      codeSessionId: undefined,
      acquiredAt: record.acquiredAt,
      lastUsedAt: record.lastUsedAt,
      expiresAt: record.expiresAt ?? Number.MAX_SAFE_INTEGER,
      runtime: record.runtime,
      vcpus: record.vcpus,
      trackedRemotePaths: Array.isArray(record.trackedRemotePaths)
        ? [...record.trackedRemotePaths]
        : [],
      leaseMode: 'managed',
    };
  }

  private mergeCodeSessionManagedSandboxes(
    session: CodeSessionRecord,
    updates: CodeSessionManagedSandbox[],
  ): CodeSessionManagedSandbox[] {
    const existing = Array.isArray(session.workState.managedSandboxes)
      ? session.workState.managedSandboxes
      : [];
    const next = new Map<string, CodeSessionManagedSandbox>();
    for (const record of existing) {
      next.set(record.leaseId, { ...record });
    }
    for (const record of updates) {
      next.set(record.leaseId, { ...record });
    }
    return [...next.values()]
      .filter((record) => record.status === 'active')
      .sort((left, right) => (right.lastUsedAt || right.acquiredAt) - (left.lastUsedAt || left.acquiredAt));
  }

  private syncCodeSessionManagedSandboxRecord(input: {
    sessionId: string;
    ownerUserId?: string;
    descriptor: RemoteExecutionTargetDescriptor;
    result: Pick<RemoteExecutionRunResult, 'leaseId' | 'sandboxId' | 'leaseMode' | 'healthState' | 'healthReason'>;
  }): void {
    if (input.result.leaseMode !== 'managed' || !input.result.leaseId || !this.options.codeSessionStore) {
      return;
    }
    const session = this.getCodeSessionRecord(input.sessionId, input.ownerUserId);
    if (!session) return;
    const existing = session.workState.managedSandboxes.find((record) =>
      record.leaseId === input.result.leaseId
      || record.targetId === input.descriptor.id
      || record.sandboxId === input.result.sandboxId,
    );
    if (!existing) return;
    const activeLease = (this.remoteExecutionService?.listActiveLeases?.() ?? [])
      .find((lease) => lease.id === input.result.leaseId);
    const nextRecords = session.workState.managedSandboxes.map((record) => {
      if (record.leaseId !== existing.leaseId) return record;
      const nextStatus: CodeSessionManagedSandbox['status'] = input.result.healthState === 'unreachable'
        ? 'unreachable'
        : 'active';
      return {
        ...record,
        sandboxId: input.result.sandboxId || record.sandboxId,
        status: nextStatus,
        lastUsedAt: this.now(),
        trackedRemotePaths: activeLease?.trackedRemotePaths
          ? [...activeLease.trackedRemotePaths]
          : (Array.isArray(record.trackedRemotePaths) ? [...record.trackedRemotePaths] : []),
        healthState: input.result.healthState ?? record.healthState,
        healthReason: input.result.healthReason ?? record.healthReason,
        healthCheckedAt: this.now(),
      };
    });
    this.options.codeSessionStore.updateSession({
      sessionId: session.id,
      ownerUserId: session.ownerUserId,
      workState: {
        managedSandboxes: nextRecords,
      },
    });
  }

  private buildCodeSessionManagedSandboxRecord(
    descriptor: RemoteExecutionTargetDescriptor,
    lease: RemoteExecutionLease,
  ): CodeSessionManagedSandbox {
    return {
      leaseId: lease.id,
      targetId: descriptor.id,
      backendKind: descriptor.backendKind,
      profileId: descriptor.profileId,
      profileName: descriptor.profileName,
      sandboxId: lease.sandboxId,
      localWorkspaceRoot: lease.localWorkspaceRoot,
      remoteWorkspaceRoot: lease.remoteWorkspaceRoot,
      status: descriptor.healthState === 'unreachable' ? 'unreachable' : 'active',
      acquiredAt: lease.acquiredAt,
      lastUsedAt: lease.lastUsedAt,
      expiresAt: lease.expiresAt,
      runtime: lease.runtime,
      vcpus: lease.vcpus,
      trackedRemotePaths: [...lease.trackedRemotePaths],
      healthState: descriptor.healthState,
      healthReason: descriptor.healthReason,
      healthCheckedAt: this.now(),
      healthDurationMs: descriptor.healthDurationMs,
    };
  }

  private mergeCodeSessionManagedSandboxRuntimeState(input: {
    record: CodeSessionManagedSandbox;
    target?: RemoteExecutionTargetDescriptor;
    activeLease?: RemoteExecutionLease;
  }): CodeSessionManagedSandbox {
    const activeLeaseReason = input.activeLease
      ? (input.activeLease.codeSessionId
          ? `Active leased sandbox is attached to code session '${input.activeLease.codeSessionId}'.`
          : 'Active leased sandbox is available.')
      : undefined;
    const targetUnavailable = input.target?.healthState === 'unreachable';
    return {
      ...input.record,
      sandboxId: input.activeLease?.sandboxId ?? input.record.sandboxId,
      remoteWorkspaceRoot: input.activeLease?.remoteWorkspaceRoot ?? input.record.remoteWorkspaceRoot,
      lastUsedAt: input.activeLease?.lastUsedAt ?? input.record.lastUsedAt,
      expiresAt: input.activeLease?.expiresAt ?? input.record.expiresAt,
      runtime: input.activeLease?.runtime ?? input.record.runtime,
      vcpus: input.activeLease?.vcpus ?? input.record.vcpus,
      trackedRemotePaths: input.activeLease?.trackedRemotePaths
        ? [...input.activeLease.trackedRemotePaths]
        : (Array.isArray(input.record.trackedRemotePaths) ? [...input.record.trackedRemotePaths] : []),
      status: input.record.status === 'released'
        ? 'released'
        : input.activeLease
          ? 'active'
          : (targetUnavailable ? 'unreachable' : input.record.status),
      healthState: input.activeLease
        ? 'healthy'
        : (targetUnavailable ? 'unreachable' : input.record.healthState),
      healthReason: input.activeLease
        ? activeLeaseReason
        : (targetUnavailable ? (input.target?.healthReason ?? input.record.healthReason) : input.record.healthReason),
      healthCheckedAt: input.activeLease
        ? input.activeLease.lastUsedAt
        : (targetUnavailable ? (input.target?.healthCheckedAt ?? input.record.healthCheckedAt) : input.record.healthCheckedAt),
      healthDurationMs: targetUnavailable
        ? (input.target?.healthDurationMs ?? input.record.healthDurationMs)
        : input.record.healthDurationMs,
    };
  }

  private async reconcileCodeSessionManagedSandboxRecords(input: {
    session: CodeSessionRecord;
    targets: RemoteExecutionTargetDescriptor[];
  }): Promise<CodeSessionManagedSandbox[]> {
    const existing = Array.isArray(input.session.workState.managedSandboxes)
      ? input.session.workState.managedSandboxes
      : [];
    if (existing.length === 0) return [];
    const service = this.remoteExecutionService ?? (input.targets.length > 0 ? this.getOrCreateRemoteExecutionService() : undefined);
    const targetById = new Map(input.targets.map((entry) => [entry.id, entry]));
    const serviceLeases = new Map(
      (service?.listActiveLeases?.() ?? []).map((lease) => [lease.id, lease]),
    );
    let changed = false;
    const nextRecords: CodeSessionManagedSandbox[] = [];
    for (const record of existing) {
      const target = targetById.get(record.targetId);
      const activeLease = serviceLeases.get(record.leaseId);
      let nextRecord = this.mergeCodeSessionManagedSandboxRuntimeState({
        record,
        target,
        activeLease,
      });
      const lastCheckedAt = typeof nextRecord.healthCheckedAt === 'number'
        ? nextRecord.healthCheckedAt
        : 0;
      const shouldInspect = !activeLease
        && nextRecord.status !== 'released'
        && !!service?.inspectLease
        && (!lastCheckedAt || (this.now() - lastCheckedAt) >= MANAGED_SANDBOX_RECONCILE_INTERVAL_MS);
      if (shouldInspect && target) {
        const resolvedTarget = this.getResolvedRemoteExecutionTargetFromDescriptor(target);
        if (resolvedTarget) {
          const inspection = await service.inspectLease!({
            target: resolvedTarget,
            lease: this.toRemoteExecutionLease(record),
          });
          nextRecord = {
            ...nextRecord,
            sandboxId: inspection.sandboxId ?? nextRecord.sandboxId,
            remoteWorkspaceRoot: inspection.remoteWorkspaceRoot ?? nextRecord.remoteWorkspaceRoot,
            status: inspection.healthState === 'unreachable' ? 'unreachable' : 'active',
            healthState: inspection.healthState,
            healthReason: inspection.reason,
            healthCheckedAt: inspection.checkedAt,
            healthDurationMs: inspection.durationMs,
          };
        }
      }
      if (JSON.stringify(nextRecord) !== JSON.stringify(record)) {
        changed = true;
      }
      nextRecords.push(nextRecord);
    }
    if (changed && this.options.codeSessionStore) {
      this.options.codeSessionStore.updateSession({
        sessionId: input.session.id,
        ownerUserId: input.session.ownerUserId,
        workState: {
          managedSandboxes: nextRecords,
        },
      });
    }
    return nextRecords;
  }

  async getCodeSessionManagedSandboxStatus(input: {
    sessionId: string;
    ownerUserId?: string;
  }): Promise<{
    codeSessionId: string;
    defaultTargetId: string | null;
    targets: RemoteExecutionTargetDescriptor[];
    sandboxes: CodeSessionManagedSandbox[];
  }> {
    const session = this.getCodeSessionRecord(input.sessionId, input.ownerUserId);
    if (!session) {
      throw new Error(`Code session '${input.sessionId}' was not found.`);
    }
    const targets = this.getRemoteExecutionTargets();
    const sandboxes = (await this.reconcileCodeSessionManagedSandboxRecords({
      session,
      targets,
    }))
      .filter((record) => record.status === 'active' || record.status === 'unreachable')
      .sort((left, right) => (right.lastUsedAt || right.acquiredAt) - (left.lastUsedAt || left.acquiredAt));
    return {
      codeSessionId: session.id,
      defaultTargetId: this.cloudConfig.defaultRemoteExecutionTargetId?.trim() || null,
      targets,
      sandboxes,
    };
  }

  async createManagedSandboxForCodeSession(input: {
    sessionId: string;
    ownerUserId?: string;
    profileId?: string;
    targetId?: string;
    runtime?: string;
    vcpus?: number;
  }): Promise<{
    codeSessionId: string;
    defaultTargetId: string | null;
    targets: RemoteExecutionTargetDescriptor[];
    sandboxes: CodeSessionManagedSandbox[];
  }> {
    if (!this.options.codeSessionStore) {
      throw new Error('Code session store is not available.');
    }
    const session = this.getCodeSessionRecord(input.sessionId, input.ownerUserId);
    if (!session) {
      throw new Error(`Code session '${input.sessionId}' was not found.`);
    }

    const targets = this.getRemoteExecutionTargets();
    const requestedTargetId = input.targetId?.trim();
    const requestedProfileId = input.profileId?.trim();
    const descriptor = requestedTargetId
      ? targets.find((entry) => entry.id === requestedTargetId)
      : requestedProfileId
        ? this.resolveRemoteExecutionTargetDescriptorByProfileHint(targets, requestedProfileId)
        : prioritizeReadyRemoteExecutionTargets(targets, [
          ...session.workState.managedSandboxes.map((record) => record.targetId),
          this.cloudConfig.defaultRemoteExecutionTargetId?.trim(),
        ])[0];
    if (!descriptor || !isRemoteExecutionTargetReady(descriptor)) {
      throw new Error(requestedTargetId || requestedProfileId
        ? 'The requested remote sandbox target is not ready.'
        : 'No ready remote sandbox target is configured.');
    }

    const target = this.getResolvedRemoteExecutionTargetFromDescriptor(descriptor);
    if (!target) {
      throw new Error(`Remote execution target '${descriptor.profileName}' could not be resolved.`);
    }

    const existingRecord = session.workState.managedSandboxes.find((record) => record.targetId === descriptor.id);
    const lease = await this.getOrCreateRemoteExecutionService().acquireLease?.({
      target,
      localWorkspaceRoot: session.resolvedRoot,
      codeSessionId: session.id,
      runtime: input.runtime,
      vcpus: input.vcpus,
      leaseMode: 'managed',
      existingLease: existingRecord ? this.toRemoteExecutionLease(existingRecord) : undefined,
    });
    if (!lease) {
      throw new Error('Managed remote sandbox creation is not available.');
    }

    const nextRecord = this.buildCodeSessionManagedSandboxRecord(descriptor, lease);
    const nextManagedSandboxes = this.mergeCodeSessionManagedSandboxes(session, [nextRecord])
      .filter((record) => record.targetId !== descriptor.id || record.leaseId === nextRecord.leaseId);
    this.options.codeSessionStore.updateSession({
      sessionId: session.id,
      ownerUserId: session.ownerUserId,
      workState: {
        managedSandboxes: nextManagedSandboxes,
      },
    });
    return await this.getCodeSessionManagedSandboxStatus({
      sessionId: session.id,
      ownerUserId: session.ownerUserId,
    });
  }

  async deleteManagedSandboxForCodeSession(input: {
    sessionId: string;
    ownerUserId?: string;
    leaseId: string;
  }): Promise<{
    codeSessionId: string;
    defaultTargetId: string | null;
    targets: RemoteExecutionTargetDescriptor[];
    sandboxes: CodeSessionManagedSandbox[];
  }> {
    if (!this.options.codeSessionStore) {
      throw new Error('Code session store is not available.');
    }
    const session = this.getCodeSessionRecord(input.sessionId, input.ownerUserId);
    if (!session) {
      throw new Error(`Code session '${input.sessionId}' was not found.`);
    }
    const record = session.workState.managedSandboxes.find((entry) => entry.leaseId === input.leaseId.trim());
    if (!record) {
      throw new Error(`Managed sandbox '${input.leaseId}' was not found.`);
    }
    const descriptor = this.getRemoteExecutionTargets().find((entry) => entry.id === record.targetId);
    if (!descriptor) {
      throw new Error(
        `Managed sandbox '${record.profileName}' can no longer be resolved. Re-enable or reconfigure that remote target before releasing it.`,
      );
    }
    const target = this.getResolvedRemoteExecutionTargetFromDescriptor(descriptor);
    if (!target) {
      throw new Error(`Managed sandbox target '${record.profileName}' could not be resolved.`);
    }
    const service = this.getOrCreateRemoteExecutionService();
    if (!service.disposeLease) {
      throw new Error('Managed remote sandbox release is not available.');
    }
    await service.disposeLease({
      target,
      lease: this.toRemoteExecutionLease(record),
    });
    this.options.codeSessionStore.updateSession({
      sessionId: session.id,
      ownerUserId: session.ownerUserId,
      workState: {
        managedSandboxes: session.workState.managedSandboxes.filter((entry) => entry.leaseId !== record.leaseId),
      },
    });
    return await this.getCodeSessionManagedSandboxStatus({
      sessionId: session.id,
      ownerUserId: session.ownerUserId,
    });
  }

  async releaseManagedSandboxesForCodeSession(input: {
    sessionId: string;
    ownerUserId?: string;
  }): Promise<void> {
    const session = this.getCodeSessionRecord(input.sessionId, input.ownerUserId);
    if (!session) {
      throw new Error(`Code session '${input.sessionId}' was not found.`);
    }
    for (const record of session.workState.managedSandboxes) {
      await this.deleteManagedSandboxForCodeSession({
        sessionId: session.id,
        ownerUserId: session.ownerUserId,
        leaseId: record.leaseId,
      });
    }
  }

  async runRemoteExecutionJob(
    input: Omit<RemoteExecutionRunRequest, 'target' | 'codeSessionId' | 'requestId'> & {
      profileId?: string;
      request?: Partial<ToolExecutionRequest>;
    },
  ): Promise<RemoteExecutionRunResult> {
    const codeSessionId = input.request?.codeContext?.sessionId?.trim() || undefined;
    const session = codeSessionId ? this.getCodeSessionRecord(codeSessionId) : null;
    const managedSandboxes = session?.workState.managedSandboxes.filter((record) => record.status === 'active') ?? [];
    const descriptors = this.resolveRemoteExecutionTargetDescriptors(
      input.profileId,
      input.command.requestedCommand,
      managedSandboxes.map((record) => record.targetId),
    );
    if (descriptors.length === 0) {
      const requestedProfile = input.profileId?.trim();
      throw new Error(
        requestedProfile
          ? `Remote execution target '${requestedProfile}' is not ready.`
          : 'No ready remote execution target is configured.',
      );
    }

    const service = this.getOrCreateRemoteExecutionService();
    const requestId = input.request?.requestId?.trim() || undefined;
    let lastUnavailableMessage = '';

    for (const descriptor of descriptors) {
      const target = this.getResolvedRemoteExecutionTargetFromDescriptor(descriptor);
      if (!target) {
        continue;
      }
      const preferredManagedSandbox = managedSandboxes.find((record) => record.targetId === descriptor.id);
      try {
        const result = await service.runBoundedJob({
          ...input,
          target,
          codeSessionId,
          requestId,
          preferredLease: preferredManagedSandbox ? this.toRemoteExecutionLease(preferredManagedSandbox) : undefined,
          leaseMode: preferredManagedSandbox ? 'managed' : input.leaseMode,
        });
        if (codeSessionId) {
          this.syncCodeSessionManagedSandboxRecord({
            sessionId: codeSessionId,
            descriptor,
            result,
          });
        }
        return result;
      } catch (error) {
        if (error instanceof RemoteExecutionTargetUnavailableError) {
          lastUnavailableMessage = error.message;
          if (input.profileId?.trim()) {
            throw error;
          }
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      lastUnavailableMessage || 'No reachable remote execution target is configured.',
    );
  }

  private getOrCreateRemoteExecutionService(): RemoteExecutionServiceLike {
    if (!this.remoteExecutionService) {
      this.remoteExecutionService = new RemoteExecutionService({
        providers: [
          new VercelRemoteExecutionProvider(),
          new DaytonaRemoteExecutionProvider(),
        ],
      });
    }
    return this.remoteExecutionService;
  }

  setAutomationControlPlane(controlPlane: AutomationControlPlane | undefined): void {
    this.automationControlPlane = controlPlane;
  }

  /** Look up a single tool definition by name. */
  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.registry.get(name)?.definition;
  }

  listToolDefinitions(): ToolDefinition[] {
    return this.registry.listDefinitions().filter(
      (def) => this.isAssistantVisibleTool(def)
        && this.isCategoryEnabled(def.category)
        && !this.getSandboxBlockReason(def.name, def.category),
    );
  }

  /** Return only always-loaded (non-deferred) tool definitions, respecting category/sandbox filters. */
  listAlwaysLoadedDefinitions(): ToolDefinition[] {
    const definitions = [...this.registry.listAlwaysLoaded()];
    if (this.options.googleService) {
      for (const toolName of ['gws', 'gws_schema', 'gmail_draft']) {
        const def = this.registry.get(toolName)?.definition;
        if (def) definitions.push(def);
      }
    }
    if (this.options.microsoftService) {
      for (const toolName of ['m365', 'm365_schema', 'outlook_draft']) {
        const def = this.registry.get(toolName)?.definition;
        if (def) definitions.push(def);
      }
    }

    return uniqueBy(definitions, (def) => def.name).filter(
      (def) => this.isAssistantVisibleTool(def)
        && this.isCategoryEnabled(def.category)
        && !this.getSandboxBlockReason(def.name, def.category),
    );
  }

  /** Return coding-category tool definitions (normally deferred) for eager loading in code sessions. */
  listCodingToolDefinitions(): ToolDefinition[] {
    const codingToolNames = [
      'code_edit', 'code_patch', 'code_create', 'code_plan', 'code_git_diff',
      'code_remote_exec',
      'code_test', 'code_build', 'code_lint', 'code_symbol_search',
      'fs_write', 'fs_mkdir', 'fs_move', 'fs_copy', 'fs_delete',
      'doc_create',
      'automation_list', 'automation_output_search', 'automation_output_read',
      'automation_save', 'automation_set_enabled', 'automation_run', 'automation_delete',
    ];
    const defs: ToolDefinition[] = [];
    for (const name of codingToolNames) {
      const entry = this.registry.get(name);
      if (entry && this.isCategoryEnabled(entry.definition.category)) {
        defs.push(entry.definition);
      }
    }
    return defs;
  }

  /** Return a small read-first coding subset for the first code-session tool round. */
  listCodeSessionEagerToolDefinitions(): ToolDefinition[] {
    const eagerToolNames = [
      'code_plan',
      'code_remote_exec',
      'code_symbol_search',
      'code_git_diff',
      'code_test',
      'code_build',
      'code_lint',
      'fs_write',
      'fs_mkdir',
    ];
    const defs: ToolDefinition[] = [];
    for (const name of eagerToolNames) {
      const entry = this.registry.get(name);
      if (entry && this.isCategoryEnabled(entry.definition.category)) {
        defs.push(entry.definition);
      }
    }
    return defs;
  }

  /** Return deferred tools that remain hidden until explicitly loaded via find_tools. */
  listDeferredToolDefinitions(): ToolDefinition[] {
    return this.registry.listDefinitions().filter(
      (def) => def.deferLoading
        && this.isAssistantVisibleTool(def)
        && this.isCategoryEnabled(def.category)
        && !this.getSandboxBlockReason(def.name, def.category),
    );
  }

  /** Search tools by keyword, returning full definitions (including deferred). */
  searchTools(query: string, maxResults: number = 10): ToolDefinition[] {
    return this.registry.searchTools(query, maxResults).filter(
      (def) => this.isAssistantVisibleTool(def)
        && this.isCategoryEnabled(def.category)
        && !this.getSandboxBlockReason(def.name, def.category),
    );
  }

  getRuntimeNotices(): ToolRuntimeNotice[] {
    return [...this.runtimeNotices];
  }

  setGoogleService(googleService: import('../google/google-service.js').GoogleService | undefined): void {
    this.options.googleService = googleService;
  }

  setMicrosoftService(microsoftService: import('../microsoft/microsoft-service.js').MicrosoftService | undefined): void {
    this.options.microsoftService = microsoftService;
  }

  setCloudConfig(cloudConfig: AssistantCloudConfig | undefined): void {
    this.cloudConfig = cloudConfig ?? emptyCloudConfig();
  }

  setDocSearch(docSearch: import('../search/search-service.js').SearchService | undefined): void {
    this.options.docSearch = docSearch;
  }

  /** Context summary for LLM system prompt — workspace root, allowed paths, policy mode. */
  getToolContext(request?: Partial<ToolExecutionRequest>): string {
    const enabledCategories = this.getCategoryInfo()
      .filter((category) => category.enabled)
      .map((category) => `${category.category} (${category.toolCount})`);
    const effectiveWorkspaceRoot = this.getEffectiveWorkspaceRoot(request);
    const effectiveAllowedPaths = uniqueNonEmpty(this.getEffectiveAllowedPaths(request));
    const effectiveAllowedCommands = uniqueNonEmpty(this.getEffectiveAllowedCommands(request));
    const codeWorkspaceRoot = this.getCodeWorkspaceRoot(request);
    const browserCapabilities = this.hybridBrowser?.getCapabilities();

    return buildToolContext({
      request,
      workspaceRoot: effectiveWorkspaceRoot,
      policyMode: this.policy.mode,
      enabledCategories,
      allowedPaths: effectiveAllowedPaths,
      allowedCommands: effectiveAllowedCommands,
      allowedDomains: this.policy.sandbox.allowedDomains,
      browserAllowedDomains: this.getBrowserAllowedDomains(),
      browserUsesDedicatedAllowlist: Array.isArray(this.options.browserConfig?.allowedDomains)
        && this.options.browserConfig.allowedDomains.length > 0,
      browserAvailable: !!browserCapabilities?.available,
      browserReadBackend: browserCapabilities?.preferredReadBackend ?? undefined,
      browserInteractBackend: browserCapabilities?.preferredInteractionBackend ?? undefined,
      dependencyLines: this.getDependencyAwarenessContextLines(effectiveWorkspaceRoot),
      deferredInventoryLines: this.describeDeferredToolInventoryLines(),
      providerContextLines: this.describeProviderContextLines(),
      googleContextLines: this.describeGoogleContextLines(),
      cloudEnabled: this.cloudConfig.enabled,
      cloudSummaryLines: this.describeCompactCloudProfilesForContext(),
      cloudProfileLines: this.describeCloudProfilesForContext(),
      codeWorkspaceRoot,
      policyUpdateActions: this.describePolicyUpdateActions(),
    });
  }

  private formatCompactInventory(values: string[], maxInlineItems: number): string {
    const unique = uniqueNonEmpty(values);
    if (unique.length === 0) return '';
    const shown = unique.slice(0, maxInlineItems);
    const suffix = unique.length > maxInlineItems
      ? ` (+${unique.length - maxInlineItems} more)`
      : '';
    return `${shown.join(', ')}${suffix}`;
  }

  private describeCloudProfilesForContext(): ToolContextCloudProfileSummary[] {
    return [
      ...(this.cloudConfig.cpanelProfiles ?? []).map((profile) => {
        const normalized = normalizeCpanelConnectionConfig({
          id: profile.id,
          name: profile.name,
          host: profile.host,
          port: profile.port,
          username: profile.username,
          apiToken: profile.apiToken ?? '',
          type: profile.type,
          ssl: profile.ssl,
          allowSelfSigned: profile.allowSelfSigned,
          defaultCpanelUser: profile.defaultCpanelUser,
        });
        const endpoint = this.describeCloudEndpoint(normalized);
        const suggestedTool = profile.type === 'whm' ? 'whm_status' : 'cpanel_account';
        const defaultAccount = profile.defaultCpanelUser?.trim()
          ? ` defaultCpanelUser=${profile.defaultCpanelUser.trim()}`
          : '';
        return {
          family: 'cpanel' as const,
          id: profile.id,
          label: profile.name,
          keywords: [profile.id, profile.name, profile.host, profile.username, profile.type, suggestedTool].filter(Boolean),
          line: `- ${profile.id}: provider=${profile.type} label="${profile.name}" endpoint=${endpoint} username=${profile.username} credential=${profile.apiToken?.trim() ? 'ready' : 'missing'} hostAllowlisted=${this.isHostAllowed(normalized.host) ? 'yes' : 'no'} suggestedReadOnlyTest=${suggestedTool}${defaultAccount}`,
        };
      }),
      ...(this.cloudConfig.vercelProfiles ?? []).map((profile) => {
        const endpoint = this.describeVercelEndpoint({
          id: profile.id,
          name: profile.name,
          apiBaseUrl: profile.apiBaseUrl,
          apiToken: profile.apiToken ?? '',
          teamId: profile.teamId,
          slug: profile.slug,
        });
        const host = new URL(endpoint).hostname;
        return {
          family: 'vercel' as const,
          id: profile.id,
          label: profile.name,
          keywords: [
            profile.id,
            profile.name,
            profile.slug,
            profile.teamId,
            profile.sandbox?.baseSnapshotId,
            'vercel_status',
          ].filter((value): value is string => Boolean(value)),
          line: `- ${profile.id}: provider=vercel label="${profile.name}" endpoint=${endpoint} credential=${profile.apiToken?.trim() ? 'ready' : 'missing'} hostAllowlisted=${this.isHostAllowed(host) ? 'yes' : 'no'} baseSnapshot=${profile.sandbox?.baseSnapshotId?.trim() || 'none'} suggestedReadOnlyTest=vercel_status`,
        };
      }),
      ...(this.cloudConfig.daytonaProfiles ?? []).map((profile) => {
        const endpoint = normalizeOptionalHttpUrlInput(profile.apiUrl) || 'https://app.daytona.io/api';
        const host = new URL(endpoint).hostname;
        return {
          family: 'daytona' as const,
          id: profile.id,
          label: profile.name,
          keywords: [profile.id, profile.name, profile.target, profile.language, profile.snapshot, 'daytona_status']
            .filter((value): value is string => Boolean(value)),
          line: `- ${profile.id}: provider=daytona label="${profile.name}" endpoint=${endpoint} credential=${profile.apiKey?.trim() ? 'ready' : 'missing'} hostAllowlisted=${this.isHostAllowed(host) ? 'yes' : 'no'} target=${profile.target?.trim() || 'default'} language=${profile.language?.trim() || 'typescript'} snapshot=${profile.snapshot?.trim() || 'default'} isolation=${profile.enabled === true ? 'enabled' : 'disabled'} suggestedReadOnlyTest=daytona_status`,
        };
      }),
      ...(this.cloudConfig.cloudflareProfiles ?? []).map((profile) => {
        const endpoint = this.describeCloudflareEndpoint({
          id: profile.id,
          name: profile.name,
          apiBaseUrl: profile.apiBaseUrl,
          apiToken: profile.apiToken ?? '',
          accountId: profile.accountId,
          defaultZoneId: profile.defaultZoneId,
        });
        const host = new URL(endpoint).hostname;
        return {
          family: 'cloudflare' as const,
          id: profile.id,
          label: profile.name,
          keywords: [profile.id, profile.name, profile.accountId, profile.defaultZoneId, 'cf_status'].filter((value): value is string => Boolean(value)),
          line: `- ${profile.id}: provider=cloudflare label="${profile.name}" endpoint=${endpoint} credential=${profile.apiToken?.trim() ? 'ready' : 'missing'} hostAllowlisted=${this.isHostAllowed(host) ? 'yes' : 'no'} suggestedReadOnlyTest=cf_status`,
        };
      }),
      ...(this.cloudConfig.awsProfiles ?? []).map((profile) => {
        const endpoint = this.describeAwsEndpoint({
          id: profile.id,
          name: profile.name,
          region: profile.region,
          accessKeyId: profile.accessKeyId,
          secretAccessKey: profile.secretAccessKey,
          sessionToken: profile.sessionToken,
          endpoints: profile.endpoints,
        }, 'sts');
        const host = new URL(endpoint).hostname;
        const hasCredential = !!profile.accessKeyId?.trim() && !!profile.secretAccessKey?.trim();
        return {
          family: 'aws' as const,
          id: profile.id,
          label: profile.name,
          keywords: [profile.id, profile.name, profile.region, 'aws_status'].filter((value): value is string => Boolean(value)),
          line: `- ${profile.id}: provider=aws label="${profile.name}" region=${profile.region} endpoint=${endpoint} credential=${hasCredential || !!profile.sessionToken?.trim() ? 'ready' : 'ambient-or-missing'} hostAllowlisted=${this.isHostAllowed(host) ? 'yes' : 'no'} suggestedReadOnlyTest=aws_status`,
        };
      }),
      ...(this.cloudConfig.gcpProfiles ?? []).map((profile) => {
        const endpoint = this.describeGcpEndpoint({
          id: profile.id,
          name: profile.name,
          projectId: profile.projectId,
          location: profile.location,
          accessToken: profile.accessToken,
          serviceAccountJson: profile.serviceAccountJson,
          endpoints: profile.endpoints,
        }, 'cloudResourceManager');
        const host = new URL(endpoint).hostname;
        const hasCredential = !!profile.accessToken?.trim() || !!profile.serviceAccountJson?.trim();
        return {
          family: 'gcp' as const,
          id: profile.id,
          label: profile.name,
          keywords: [profile.id, profile.name, profile.projectId, profile.location, 'gcp_status'].filter((value): value is string => Boolean(value)),
          line: `- ${profile.id}: provider=gcp label="${profile.name}" project=${profile.projectId} endpoint=${endpoint} credential=${hasCredential ? 'ready' : 'missing'} hostAllowlisted=${this.isHostAllowed(host) ? 'yes' : 'no'} suggestedReadOnlyTest=gcp_status`,
        };
      }),
      ...(this.cloudConfig.azureProfiles ?? []).map((profile) => {
        const endpoint = this.describeAzureEndpoint({
          id: profile.id,
          name: profile.name,
          subscriptionId: profile.subscriptionId,
          tenantId: profile.tenantId,
          accessToken: profile.accessToken,
          clientId: profile.clientId,
          clientSecret: profile.clientSecret,
          defaultResourceGroup: profile.defaultResourceGroup,
          blobBaseUrl: profile.blobBaseUrl,
          endpoints: profile.endpoints,
        }, 'management');
        const host = new URL(endpoint).hostname;
        const hasCredential = !!profile.accessToken?.trim() || (!!profile.clientId?.trim() && !!profile.clientSecret?.trim());
        return {
          family: 'azure' as const,
          id: profile.id,
          label: profile.name,
          keywords: [profile.id, profile.name, profile.subscriptionId, profile.tenantId, profile.defaultResourceGroup, 'azure_status'].filter((value): value is string => Boolean(value)),
          line: `- ${profile.id}: provider=azure label="${profile.name}" subscription=${profile.subscriptionId} endpoint=${endpoint} credential=${hasCredential ? 'ready' : 'missing'} hostAllowlisted=${this.isHostAllowed(host) ? 'yes' : 'no'} suggestedReadOnlyTest=azure_status`,
        };
      }),
    ];
  }

  private describeCompactCloudProfilesForContext(): string[] {
    const families = [
      ['cpanel/whm', this.cloudConfig.cpanelProfiles?.length ?? 0] as [string, number],
      ['vercel', this.cloudConfig.vercelProfiles?.length ?? 0] as [string, number],
      ['daytona', this.cloudConfig.daytonaProfiles?.length ?? 0] as [string, number],
      ['cloudflare', this.cloudConfig.cloudflareProfiles?.length ?? 0] as [string, number],
      ['aws', this.cloudConfig.awsProfiles?.length ?? 0] as [string, number],
      ['gcp', this.cloudConfig.gcpProfiles?.length ?? 0] as [string, number],
      ['azure', this.cloudConfig.azureProfiles?.length ?? 0] as [string, number],
    ].filter((entry) => entry[1] > 0);
    if (families.length === 0) {
      return ['Configured cloud profiles: none'];
    }
    return [`Configured cloud profiles: ${families.map(([family, count]) => `${family}=${count}`).join(', ')}`];
  }

  private describeProviderInventoryHintLines(): string[] {
    return [
      'Provider/model summary: use llm_provider_list for configured providers and llm_provider_models for detailed model catalogs.',
    ];
  }

  private describeContextLineLimit(lines: string[], maxLines: number): string[] {
    if (lines.length <= maxLines) return lines;
    return [...lines.slice(0, maxLines - 1), `... (+${lines.length - (maxLines - 1)} more lines)`];
  }

  private describePolicyUpdateActions(): string {
    const updates = this.options.agentPolicyUpdates;
    const enabledActions: string[] = [];
    if (updates?.allowedPaths) enabledActions.push('add_path', 'remove_path');
    if (updates?.allowedCommands) enabledActions.push('add_command', 'remove_command');
    if (updates?.allowedDomains) enabledActions.push('add_domain', 'remove_domain');
    if (enabledActions.length === 0) {
      return 'Policy updates via chat: disabled';
    }
    return `Policy updates via chat: enabled via update_tool_policy (${enabledActions.join(', ')})`;
  }

  private describeDeferredToolInventoryLines(): string[] {
    const deferredDefinitions = this.listDeferredToolDefinitions();
    if (deferredDefinitions.length === 0) return [];

    const grouped = new Map<string, string[]>();
    for (const definition of deferredDefinitions) {
      const category = definition.category ?? 'other';
      const existing = grouped.get(category) ?? [];
      existing.push(definition.name);
      grouped.set(category, existing);
    }

    const lines = [
      'Deferred tool inventory (compact names only). If you need one of these tools and it is not already in your current tool list, call find_tools with the tool name or category keyword first to load its schema.',
    ];

    for (const category of Object.keys(TOOL_CATEGORIES) as ToolCategory[]) {
      const names = grouped.get(category);
      if (!names || names.length === 0) continue;
      lines.push(`Deferred ${category} tools (${names.length}): ${this.formatCompactInventory(names, 8)}`);
    }

    const uncategorized = grouped.get('other');
    if (uncategorized?.length) {
      lines.push(`Deferred other tools (${uncategorized.length}): ${this.formatCompactInventory(uncategorized, 8)}`);
    }

    return lines;
  }


  private describeGoogleContextLines(): string[] {
    const googleSvc = this.options.googleService;
    if (!googleSvc) {
      return ['Google Workspace: unavailable'];
    }

    const services = googleSvc.getEnabledServices();
    const status = googleSvc.isAuthenticated() ? 'connected' : 'not connected';
    return this.describeContextLineLimit([
      `Google Workspace: ${status}`,
      `Google Workspace services: ${this.formatCompactInventory(services, 6) || '(none)'}`,
      'Google Workspace authentication is automatic for gws/gmail tools. Do not ask the user for OAuth access tokens.',
      ...(!googleSvc.isAuthenticated()
        ? ['If a Google action fails for auth, tell the user to connect Google Workspace in Settings instead of asking for raw tokens.']
        : []),
    ], 4);
  }

  private describeProviderContextLines(): string[] {
    return this.describeProviderInventoryHintLines();
  }


  getSandboxHealth(): SandboxHealth | undefined {
    return this.sandboxHealth;
  }

  getPolicy(): ToolPolicySnapshot {
    return {
      mode: this.policy.mode,
      toolPolicies: { ...this.policy.toolPolicies },
      sandbox: {
        allowedPaths: [...this.policy.sandbox.allowedPaths],
        allowedCommands: [...this.policy.sandbox.allowedCommands],
        allowedDomains: [...this.policy.sandbox.allowedDomains],
      },
    };
  }

  updatePolicy(update: ToolPolicyUpdate): ToolPolicySnapshot {
    if (update.mode) {
      this.policy.mode = update.mode;
    }
    if (update.toolPolicies) {
      this.policy.toolPolicies = {
        ...this.policy.toolPolicies,
        ...update.toolPolicies,
      };
    }
    if (update.sandbox?.allowedPaths) {
      this.policy.sandbox.allowedPaths = uniqueNonEmpty(update.sandbox.allowedPaths);
    }
    if (update.sandbox?.allowedCommands) {
      this.policy.sandbox.allowedCommands = uniqueNonEmpty(update.sandbox.allowedCommands);
    }
    if (update.sandbox?.allowedDomains) {
      this.policy.sandbox.allowedDomains = uniqueNonEmpty(update.sandbox.allowedDomains.map((host) => host.toLowerCase()));
    }
    return this.getPolicy();
  }

  private getCodeWorkspaceRoot(request?: Partial<ToolExecutionRequest>): string | undefined {
    const rawRoot = request?.codeContext?.workspaceRoot?.trim();
    if (!rawRoot) return undefined;
    const normalizedRoot = normalizePathForHost(rawRoot);
    return isAbsolute(normalizedRoot)
      ? resolve(normalizedRoot)
      : resolve(this.options.workspaceRoot, normalizedRoot);
  }

  private getEffectiveWorkspaceRoot(request?: Partial<ToolExecutionRequest>): string {
    return this.getCodeWorkspaceRoot(request) ?? this.options.workspaceRoot;
  }

  private getEffectiveAllowedPaths(request?: Partial<ToolExecutionRequest>): string[] {
    const codeWorkspaceRoot = this.getCodeWorkspaceRoot(request);
    if (codeWorkspaceRoot) {
      return [codeWorkspaceRoot];
    }
    return this.policy.sandbox.allowedPaths.length > 0
      ? this.policy.sandbox.allowedPaths
      : [this.options.workspaceRoot];
  }

  private getEffectiveAllowedCommands(request?: Partial<ToolExecutionRequest>): string[] {
    if (this.getCodeWorkspaceRoot(request)) {
      return [...CODE_ASSISTANT_ALLOWED_COMMANDS];
    }
    return this.policy.sandbox.allowedCommands;
  }

  private getDependencyLedger(workspaceRoot: string): WorkspaceDependencyLedger {
    const normalizedWorkspaceRoot = resolve(workspaceRoot);
    let ledger = this.dependencyLedgers.get(normalizedWorkspaceRoot);
    if (!ledger) {
      ledger = new WorkspaceDependencyLedger(normalizedWorkspaceRoot);
      this.dependencyLedgers.set(normalizedWorkspaceRoot, ledger);
    }
    return ledger;
  }

  private getDependencyAwarenessContextLines(workspaceRoot: string): string[] {
    try {
      return this.getDependencyLedger(workspaceRoot).buildPromptLines();
    } catch {
      return [];
    }
  }

  private prepareJsDependencyTracking(
    commands: ParsedCommand[],
    cwd: string,
    request?: Partial<ToolExecutionRequest>,
  ): PendingJsDependencyTracking | null {
    const intent = commands
      .map((parsedCommand) => detectJsDependencyMutationIntent(parsedCommand))
      .find((value): value is JsDependencyMutationIntent => value !== null);
    if (!intent) return null;

    const workspaceRoot = this.getEffectiveWorkspaceRoot(request);
    try {
      return {
        intent,
        before: captureJsDependencySnapshot(workspaceRoot, cwd),
        workspaceRoot,
        cwd,
      };
    } catch {
      return null;
    }
  }

  private finalizeJsDependencyTracking(tracking: PendingJsDependencyTracking | null, command: string): void {
    if (!tracking) return;
    try {
      const after = captureJsDependencySnapshot(tracking.workspaceRoot, tracking.cwd);
      if (!after) return;
      const diff = diffJsDependencySnapshots(tracking.before, after);
      if (!diff) return;

      this.getDependencyLedger(tracking.workspaceRoot).recordMutation({
        intent: tracking.intent,
        command,
        cwd: tracking.cwd,
        before: tracking.before,
        after,
        diff,
        now: this.now,
      });
    } catch {
      // Dependency-awareness bookkeeping should not make the shell command fail.
    }
  }

  private isCodeWorkspacePolicyNoOp(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    request?: Partial<ToolExecutionRequest>,
  ): boolean {
    if (definition.name !== 'update_tool_policy') return false;
    const codeWorkspaceRoot = this.getCodeWorkspaceRoot(request);
    if (!codeWorkspaceRoot) return false;
    const action = asString(args.action, '').trim();
    const value = asString(args.value, '').trim();
    if (action !== 'add_path' || !value) return false;
    const normalizedValue = normalizePathForHost(value);
    const resolvedValue = isAbsolute(normalizedValue)
      ? resolve(normalizedValue)
      : resolve(codeWorkspaceRoot, normalizedValue);
    return isPathInside(resolvedValue, codeWorkspaceRoot);
  }

  private getCanonicalPolicyPathValue(
    value: string,
    request?: Partial<ToolExecutionRequest>,
  ): string {
    return canonicalizePolicyPathValue(
      value,
      this.getCodeWorkspaceRoot(request) ?? this.options.workspaceRoot,
    );
  }

  private isPathAlreadyAllowedForPolicy(
    value: string,
    request?: Partial<ToolExecutionRequest>,
  ): boolean {
    const canonicalValue = this.getCanonicalPolicyPathValue(value, request);
    return this.getEffectiveAllowedPaths(request).some((candidate) => (
      isPathInside(canonicalValue, this.getCanonicalPolicyPathValue(candidate, request))
    ));
  }

  private isCommandAlreadyAllowedForPolicy(value: string): boolean {
    const normalizedValue = value.trim();
    if (!normalizedValue) return false;
    return validateShellCommand(normalizedValue, this.policy.sandbox.allowedCommands).valid;
  }

  private isDomainAllowedByList(value: string, allowedDomains: string[]): boolean {
    const normalizedValue = value.trim().toLowerCase();
    if (!normalizedValue) return false;
    return this.isHostAllowed(normalizedValue, allowedDomains);
  }

  private isDomainAlreadyAllowedForPolicy(value: string): boolean {
    const normalizedValue = value.trim().toLowerCase();
    if (!normalizedValue) return false;
    if (!this.isDomainAllowedByList(normalizedValue, this.policy.sandbox.allowedDomains)) {
      return false;
    }
    const browserAllowedDomains = this.getExplicitBrowserAllowedDomains();
    return !browserAllowedDomains || this.isDomainAllowedByList(normalizedValue, browserAllowedDomains);
  }

  private isPolicyUpdateNoOp(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    request?: Partial<ToolExecutionRequest>,
  ): boolean {
    if (definition.name !== 'update_tool_policy') return false;

    const action = asString(args.action, '').trim();
    const value = asString(args.value, '').trim();
    if (!action || !value) return false;

    if (action === 'add_path' && this.isCodeWorkspacePolicyNoOp(definition, args, request)) {
      return true;
    }

    switch (action) {
      case 'add_path':
        return this.isPathAlreadyAllowedForPolicy(value, request);
      case 'add_command':
        return this.isCommandAlreadyAllowedForPolicy(value);
      case 'add_domain':
        return this.isDomainAlreadyAllowedForPolicy(value);
      case 'set_tool_policy_auto':
        return this.policy.toolPolicies[value] === 'auto';
      case 'set_tool_policy_manual':
        return this.policy.toolPolicies[value] === 'manual';
      case 'set_tool_policy_deny':
        return this.policy.toolPolicies[value] === 'deny';
      default:
        return false;
    }
  }

  /** Auto-approve tools that belong to the coding workflow when operating inside the code session workspace. */
  private isCodeSessionWorkspaceTool(
    definition: ToolDefinition,
    request?: Partial<ToolExecutionRequest>,
  ): boolean {
    if (!this.getCodeWorkspaceRoot(request)) return false;
    return CODE_SESSION_SAFE_AUTO_APPROVED_TOOLS.has(definition.name)
      || (
        this.isCodeSessionTrustCleared(request)
        && (
          CODE_SESSION_TRUSTED_EXECUTION_TOOLS.has(definition.name)
          || isDirectMemoryMutationToolName(definition.name)
        )
      );
  }

  private getCodeSessionSurfaceId(request?: Partial<ToolExecutionRequest>): string {
    const surfaceId = request?.surfaceId?.trim();
    const userId = request?.userId?.trim();
    return surfaceId || userId || 'default-surface';
  }

  private listOwnedCodeSessions(request?: Partial<ToolExecutionRequest>) {
    const ownerUserId = request?.userId?.trim();
    if (!ownerUserId || !this.options.codeSessionStore) return [];
    return this.options.codeSessionStore.listSessionsForUser(ownerUserId);
  }

  private getOwnedCodeSession(sessionId: string, request?: Partial<ToolExecutionRequest>) {
    const ownerUserId = request?.userId?.trim();
    if (!ownerUserId || !this.options.codeSessionStore) return null;
    return this.options.codeSessionStore.getSession(sessionId, ownerUserId);
  }

  private resolveOwnedCodeSessionTarget(
    target: string,
    request?: Partial<ToolExecutionRequest>,
  ): {
    session?: ReturnType<ToolExecutor['listOwnedCodeSessions']>[number];
    error?: string;
  } {
    return resolveCodeSessionTarget(target, this.listOwnedCodeSessions(request));
  }

  private getCurrentCodeSessionRecord(request?: Partial<ToolExecutionRequest>) {
    const sessionId = request?.codeContext?.sessionId?.trim();
    if (!sessionId) return null;
    return this.getOwnedCodeSession(sessionId, request)
      ?? this.options.codeSessionStore?.getSession(sessionId)
      ?? null;
  }

  private getCurrentCodeSessionTrustState(request?: Partial<ToolExecutionRequest>): string | null {
    const session = this.getCurrentCodeSessionRecord(request);
    return getEffectiveCodeWorkspaceTrustState(
      session?.workState.workspaceTrust,
      session?.workState.workspaceTrustReview,
    ) ?? null;
  }

  private isCodeSessionTrustCleared(request?: Partial<ToolExecutionRequest>): boolean {
    return this.getCurrentCodeSessionTrustState(request) === 'trusted';
  }

  private isReadOnlyShellCommand(command: string): boolean {
    const fullCmd = command.trim();
    if (!fullCmd) return false;
    const firstWord = fullCmd.split(/\s+/)[0];
    const readOnlyCommands = ['ls', 'dir', 'pwd', 'whoami', 'hostname', 'uname', 'date', 'echo',
      'cat', 'head', 'tail', 'wc', 'file', 'which', 'type'];
    const readOnlyPrefixed = ['git status', 'git diff', 'git log', 'git branch', 'git remote',
      'git tag', 'node --version', 'npm --version', 'npm ls'];
    return readOnlyCommands.includes(firstWord)
      || readOnlyPrefixed.some((candidate) => fullCmd === candidate || fullCmd.startsWith(`${candidate} `));
  }

  private decideCodeSessionTrust(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    request?: Partial<ToolExecutionRequest>,
  ): ToolDecision | null {
    if (!this.getCodeWorkspaceRoot(request)) return null;
    const trustState = this.getCurrentCodeSessionTrustState(request);
    if (!trustState || trustState === 'trusted') return null;

    if (definition.name === 'shell_safe') {
      const command = asString(args.command).trim();
      return this.isReadOnlyShellCommand(command) ? 'allow' : 'require_approval';
    }

    if (isMemoryMutationToolName(definition.name)) {
      return 'require_approval';
    }

    return CODE_SESSION_UNTRUSTED_APPROVAL_TOOLS.has(definition.name)
      ? 'require_approval'
      : null;
  }

  private getCurrentCodeSessionMemoryContext(
    request?: Partial<ToolExecutionRequest>,
  ): { sessionId: string; store?: AgentMemoryStore } | null {
    const sessionId = request?.codeContext?.sessionId?.trim();
    if (!sessionId) return null;
    return {
      sessionId,
      store: this.options.codeSessionMemoryStore,
    };
  }

  private resolveCodeSessionMemoryContext(
    sessionId: string | undefined,
    request?: Partial<ToolExecutionRequest>,
  ): { sessionId: string; store?: AgentMemoryStore } | null {
    const trimmed = sessionId?.trim();
    if (!trimmed) {
      return this.getCurrentCodeSessionMemoryContext(request);
    }
    if (request?.codeContext?.sessionId?.trim() === trimmed) {
      return {
        sessionId: trimmed,
        store: this.options.codeSessionMemoryStore,
      };
    }
    const owned = this.getOwnedCodeSession(trimmed, request);
    if (!owned) return null;
    return {
      sessionId: trimmed,
      store: this.options.codeSessionMemoryStore,
    };
  }

  private getGlobalMemoryContext(
    request?: Partial<ToolExecutionRequest>,
    explicitAgentId?: string,
  ): {
    agentId: string;
    store?: AgentMemoryStore;
  } {
    const requestAgentId = explicitAgentId?.trim() || asString(request?.agentId);
    const stateAgentId = this.options.resolveStateAgentId?.(requestAgentId) ?? requestAgentId;
    return {
      agentId: stateAgentId || 'default',
      store: this.options.agentMemoryStore,
    };
  }

  private searchPersistentMemoryEntries(
    store: AgentMemoryStore,
    targetId: string,
    query: string,
    limit: number,
  ): PersistentMemorySearchMatch[] {
    const normalizedQuery = this.normalizePersistentMemorySearchText(query);
    if (!normalizedQuery) {
      return [];
    }

    const queryTerms = this.extractPersistentMemorySearchTerms(normalizedQuery);
    const identifierFragments = this.extractPersistentMemorySearchIdentifiers(query);
    const preview = (value: string) => value.length > 500 ? `${value.slice(0, 500)}...` : value;

    const matches: Array<PersistentMemorySearchMatch & {
      recencyIndex: number;
      fullComparableHit: boolean;
      matchedIdentifierCount: number;
    }> = [];
    store.getEntries(targetId).forEach((entry, index) => {
      const content = this.normalizePersistentMemorySearchText(entry.content);
      const summary = this.normalizePersistentMemorySearchText(entry.summary ?? '');
      const category = this.normalizePersistentMemorySearchText(entry.category ?? '');
      const tags = Array.isArray(entry.tags) ? this.normalizePersistentMemorySearchText(entry.tags.join(' ')) : '';
      const comparableContent = this.buildPersistentMemoryComparable(content);
      const comparableSummary = this.buildPersistentMemoryComparable(summary);
      const comparableCategory = this.buildPersistentMemoryComparable(category);
      const comparableTags = this.buildPersistentMemoryComparable(tags);
      const comparableQuery = this.buildPersistentMemoryComparable(normalizedQuery);
      const fullComparableHit = comparableQuery.length > 0 && (
        comparableContent.includes(comparableQuery)
        || comparableSummary.includes(comparableQuery)
        || comparableCategory.includes(comparableQuery)
        || comparableTags.includes(comparableQuery)
      );
      const matchedIdentifierCount = identifierFragments.filter((fragment) => (
        comparableContent.includes(fragment)
        || comparableSummary.includes(fragment)
        || comparableCategory.includes(fragment)
        || comparableTags.includes(fragment)
      )).length;

      let matchScore = 0;
      if (fullComparableHit) matchScore += 240;
      if (content.includes(normalizedQuery)) matchScore += 120;
      if (summary.includes(normalizedQuery)) matchScore += 150;
      if (category.includes(normalizedQuery)) matchScore += 90;
      if (tags.includes(normalizedQuery)) matchScore += 60;
      if (content.startsWith(normalizedQuery) || summary.startsWith(normalizedQuery)) matchScore += 20;

      for (const term of queryTerms) {
        if (term.length < 2) continue;
        if (content.includes(term)) matchScore += 12;
        if (summary.includes(term)) matchScore += 18;
        if (category.includes(term)) matchScore += 10;
        if (tags.includes(term)) matchScore += 6;
      }

      if (matchScore < 1) {
        return;
      }

      matches.push({
        id: entry.id,
        createdAt: entry.createdAt,
        category: entry.category,
        summary: entry.summary,
        content: preview(entry.content),
        trustLevel: entry.trustLevel,
        status: entry.status,
        tags: entry.tags ? [...entry.tags] : undefined,
        provenance: entry.provenance ? { ...entry.provenance } as Record<string, unknown> : undefined,
        matchScore,
        recencyIndex: index,
        fullComparableHit,
        matchedIdentifierCount,
      });
    });

    const filtered = identifierFragments.length > 0
      ? matches.filter((entry) => entry.matchedIdentifierCount > 0)
      : (matches.some((entry) => entry.fullComparableHit)
          ? matches.filter((entry) => entry.fullComparableHit)
          : matches);

    return filtered
      .sort((a, b) => b.matchScore - a.matchScore || a.recencyIndex - b.recencyIndex)
      .slice(0, limit)
      .map(({ recencyIndex: _recencyIndex, fullComparableHit: _fullComparableHit, matchedIdentifierCount: _matchedIdentifierCount, ...entry }) => entry);
  }

  private normalizePersistentMemorySearchText(value: string): string {
    return value
      .toLowerCase()
      .replace(/\s*-\s*/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractPersistentMemorySearchTerms(value: string): string[] {
    return [...new Set(
      value
        .split(/[^a-z0-9]+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    )];
  }

  private extractPersistentMemorySearchIdentifiers(query: string): string[] {
    return [...new Set(
      query
        .split(/\b(?:and|or)\b|[,;]+/i)
        .map((fragment) => this.buildPersistentMemoryComparable(fragment))
        .filter((fragment) => fragment.length >= 10 && /\d/.test(fragment)),
    )];
  }

  private buildPersistentMemoryComparable(value: string): string {
    return value.replace(/[^a-z0-9]+/g, '');
  }

  private normalizeMemorySearchScope(input: unknown): 'conversation' | 'persistent' | 'both' | null {
    const scope = asString(input, 'both').trim().toLowerCase();
    if (scope === 'conversation' || scope === 'persistent' || scope === 'both') {
      return scope;
    }
    return null;
  }

  private normalizePersistentMemoryScope(
    input: unknown,
    request?: Partial<ToolExecutionRequest>,
    fallbackScope?: 'global' | 'code_session' | 'both',
  ): 'global' | 'code_session' | 'both' | null {
    const explicit = typeof input === 'string' && input.trim().length > 0;
    const fallback = fallbackScope ?? (request?.codeContext?.sessionId?.trim() ? 'both' : 'global');
    const scope = asString(input, explicit ? '' : fallback).trim().toLowerCase();
    if (!scope) return fallback;
    if (scope === 'global' || scope === 'code_session' || scope === 'both') {
      return scope;
    }
    return null;
  }

  private normalizeMemoryMutationScope(input: unknown): 'global' | 'code_session' | null {
    const scope = asString(input, 'global').trim().toLowerCase();
    if (scope === 'global' || scope === 'code_session') {
      return scope;
    }
    return null;
  }

  private resolvePersistentMemoryContexts(
    targetScope: 'global' | 'code_session' | 'both',
    sessionId: string | undefined,
    request?: Partial<ToolExecutionRequest>,
    explicitGlobalAgentId?: string,
  ): { contexts: PersistentMemoryContextTarget[]; error?: string } {
    const contexts: PersistentMemoryContextTarget[] = [];
    if (targetScope === 'global' || targetScope === 'both') {
      const globalMemory = this.getGlobalMemoryContext(request, explicitGlobalAgentId);
      contexts.push({
        source: 'global',
        id: globalMemory.agentId,
        store: globalMemory.store,
        guardPath: 'memory:knowledge_base',
      });
    }
    if (targetScope === 'code_session' || targetScope === 'both') {
      const codeMemory = this.resolveCodeSessionMemoryContext(sessionId, request);
      if (!codeMemory) {
        return {
          contexts,
          error: 'A reachable code session is required to access code-session memory.',
        };
      }
      contexts.push({
        source: 'code_session',
        id: codeMemory.sessionId,
        store: codeMemory.store,
        guardPath: `memory:code_session:${codeMemory.sessionId}`,
      });
    }
    return { contexts };
  }

  private fuseRankedMemorySearchResults(
    sources: UnifiedMemorySearchCandidate[][],
    limit: number,
  ): Array<UnifiedMemorySearchCandidate & { score: number; rank: number }> {
    const fused = new Map<string, { item: UnifiedMemorySearchCandidate; score: number }>();
    const reciprocalRankOffset = 60;

    for (const source of sources) {
      source.forEach((item, index) => {
        const contribution = 1 / (reciprocalRankOffset + index + 1);
        const existing = fused.get(item.key);
        if (existing) {
          existing.score += contribution;
        } else {
          fused.set(item.key, { item, score: contribution });
        }
      });
    }

    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry, index) => ({
        ...entry.item,
        score: Number(entry.score.toFixed(6)),
        rank: index + 1,
      }));
  }

  private summarizeCodeSession(session: {
    id: string;
    title: string;
    workspaceRoot: string;
    resolvedRoot: string;
    agentId: string | null;
    status: string;
    lastActivityAt: number;
    workState: {
      focusSummary: string;
      planSummary: string;
      compactedSummary: string;
      pendingApprovals: unknown[];
      recentJobs: unknown[];
      activeSkills: string[];
      workspaceProfile?: {
        repoName?: string;
        repoKind?: string;
        summary?: string;
        stack?: string[];
      } | null;
      workspaceMap?: {
        indexedFileCount?: number;
        totalDiscoveredFiles?: number;
        truncated?: boolean;
        notableFiles?: string[];
      } | null;
      workingSet?: {
        query?: string;
        rationale?: string;
        files?: Array<{ path?: string }>;
      } | null;
    };
  }) {
    const pendingApprovals = Array.isArray(session.workState.pendingApprovals)
      ? session.workState.pendingApprovals.length
      : 0;
    const recentJobs = Array.isArray(session.workState.recentJobs)
      ? session.workState.recentJobs.length
      : 0;
    return {
      id: session.id,
      title: session.title,
      workspaceRoot: session.workspaceRoot,
      resolvedRoot: session.resolvedRoot,
      agentId: session.agentId,
      status: session.status,
      lastActivityAt: session.lastActivityAt,
      pendingApprovalCount: pendingApprovals,
      recentJobCount: recentJobs,
      activeSkills: Array.isArray(session.workState.activeSkills) ? [...session.workState.activeSkills] : [],
      focusSummary: session.workState.focusSummary || '',
      planSummary: session.workState.planSummary || '',
      compactedSummary: session.workState.compactedSummary || '',
      workspaceProfile: session.workState.workspaceProfile
        ? {
            repoName: session.workState.workspaceProfile.repoName || '',
            repoKind: session.workState.workspaceProfile.repoKind || '',
            summary: session.workState.workspaceProfile.summary || '',
            stack: Array.isArray(session.workState.workspaceProfile.stack)
              ? [...session.workState.workspaceProfile.stack]
              : [],
          }
        : null,
      workspaceMap: session.workState.workspaceMap
        ? {
            indexedFileCount: Number(session.workState.workspaceMap.indexedFileCount) || 0,
            totalDiscoveredFiles: Number(session.workState.workspaceMap.totalDiscoveredFiles) || 0,
            truncated: !!session.workState.workspaceMap.truncated,
            notableFiles: Array.isArray(session.workState.workspaceMap.notableFiles)
              ? [...session.workState.workspaceMap.notableFiles]
              : [],
          }
        : null,
      workingSet: session.workState.workingSet
        ? {
            query: session.workState.workingSet.query || '',
            rationale: session.workState.workingSet.rationale || '',
            files: Array.isArray(session.workState.workingSet.files)
              ? session.workState.workingSet.files.map((entry) => ({ path: entry.path || '' }))
              : [],
          }
        : null,
    };
  }

  private buildCodeShellEnv(workspaceRoot: string): Record<string, string> {
    const cacheRoot = resolve(workspaceRoot, '.guardianagent', 'cache');
    return {
      npm_config_cache: resolve(cacheRoot, 'npm'),
      NPM_CONFIG_CACHE: resolve(cacheRoot, 'npm'),
      YARN_CACHE_FOLDER: resolve(cacheRoot, 'yarn'),
      PNPM_STORE_DIR: resolve(cacheRoot, 'pnpm'),
      PIP_CACHE_DIR: resolve(cacheRoot, 'pip'),
      UV_CACHE_DIR: resolve(cacheRoot, 'uv'),
      CARGO_HOME: resolve(cacheRoot, 'cargo'),
      RUSTUP_HOME: resolve(cacheRoot, 'rustup'),
      GOCACHE: resolve(cacheRoot, 'go-build'),
      GOMODCACHE: resolve(cacheRoot, 'go-mod'),
      BUNDLE_PATH: resolve(cacheRoot, 'bundle'),
      COMPOSER_HOME: resolve(cacheRoot, 'composer'),
      DOTNET_CLI_HOME: resolve(cacheRoot, 'dotnet'),
    };
  }

  private looksLikePathToken(token: string): boolean {
    if (!token) return false;
    if (token === '.' || token === '..') return true;
    if (token.startsWith('./') || token.startsWith('../')) return true;
    if (token.startsWith('~')) return true;
    if (token.includes('/') || token.includes('\\')) return true;
    return /^[a-zA-Z]:[\\/]/.test(token);
  }

  private isCodePathTokenDenied(token: string, workspaceRoot: string, cwd: string): boolean {
    const trimmed = token.trim();
    if (!trimmed) return false;
    if (!this.looksLikePathToken(trimmed)) return false;
    if (trimmed.startsWith('~')) return true;
    const normalized = normalizePathForHost(trimmed);
    const resolvedTokenPath = isAbsolute(normalized)
      ? resolve(normalized)
      : resolve(cwd, normalized);
    return !isPathInside(resolvedTokenPath, workspaceRoot);
  }

  private getCodeShellTokenBlockReason(commands: ParsedCommand[]): string | undefined {
    for (const command of commands) {
      for (const token of command.args) {
        const exact = CODE_DISALLOWED_SHELL_TOKENS.get(token);
        if (exact) return exact;
        for (const [prefix, reason] of CODE_DISALLOWED_SHELL_TOKEN_PREFIXES.entries()) {
          if (token.startsWith(prefix)) return reason;
        }
      }
    }
    return undefined;
  }

  private getShellBuiltinCommands(): ReadonlySet<string> {
    return process.platform === 'win32' ? WINDOWS_SHELL_BUILTINS : POSIX_SHELL_BUILTINS;
  }

  private buildShellCommandPlan(commands: ParsedCommand[]): ShellCommandPlan {
    const entry = commands[0]!;
    const entryCommand = entry.command;
    const argv = [...entry.args];
    const requestedViaShell = commands.length > 1
      || entry.redirects.length > 0
      || this.getShellBuiltinCommands().has(normalizeShellCommandName(entryCommand));

    return {
      commands,
      entryCommand,
      argv,
      executionClass: classifyParsedCommandExecution(entry),
      requestedViaShell,
      execMode: requestedViaShell ? 'shell_fallback' : 'direct_exec',
    };
  }

  private async canExecuteResolvedPath(candidate: string): Promise<boolean> {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) {
        return false;
      }
      if (process.platform === 'win32') {
        return true;
      }
      await access(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private getEnvPathValue(env?: Record<string, string>): string {
    return env?.PATH
      ?? env?.Path
      ?? env?.path
      ?? process.env.PATH
      ?? process.env.Path
      ?? '';
  }

  private getWindowsPathExtensions(env?: Record<string, string>): string[] {
    const pathExt = env?.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
    return pathExt
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => value.toLowerCase());
  }

  private async resolveShellExecutable(
    entryCommand: string,
    cwd: string,
    env?: Record<string, string>,
  ): Promise<string | undefined> {
    const trimmed = entryCommand.trim();
    if (!trimmed) return undefined;

    if (this.looksLikePathToken(trimmed)) {
      const normalized = normalizePathForHost(trimmed);
      const candidate = isAbsolute(normalized)
        ? resolve(normalized)
        : resolve(cwd, normalized);
      return await this.canExecuteResolvedPath(candidate) ? candidate : undefined;
    }

    const pathEntries = this.getEnvPathValue(env)
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (pathEntries.length === 0) {
      return undefined;
    }

    const hasExtension = /\.[^\\/]+$/.test(trimmed);
    const windowsExts = process.platform === 'win32'
      ? (hasExtension ? [''] : this.getWindowsPathExtensions(env))
      : [''];

    for (const dir of pathEntries) {
      for (const ext of windowsExts) {
        const candidate = resolve(dir, process.platform === 'win32' ? `${trimmed}${ext}` : trimmed);
        if (await this.canExecuteResolvedPath(candidate)) {
          return candidate;
        }
      }
    }

    return undefined;
  }

  private async finalizeShellCommandPlan(
    plan: ShellCommandPlan,
    cwd: string,
    env?: Record<string, string>,
  ): Promise<ShellCommandPlan> {
    const resolvedExecutable = await this.resolveShellExecutable(plan.entryCommand, cwd, env);
    if (process.platform !== 'win32') {
      return { ...plan, resolvedExecutable };
    }

    if (plan.execMode !== 'direct_exec') {
      return { ...plan, resolvedExecutable };
    }

    const lowerResolved = resolvedExecutable?.toLowerCase() ?? '';
    const nativeExecutable = lowerResolved && [...WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS].some((ext) => lowerResolved.endsWith(ext));
    if (!nativeExecutable) {
      return {
        ...plan,
        resolvedExecutable,
        execMode: 'shell_fallback',
      };
    }

    return { ...plan, resolvedExecutable };
  }

  private validateShellCommandForRequest(
    command: string,
    request?: Partial<ToolExecutionRequest>,
    cwd?: string,
  ): ShellCommandCheck {
    const allowedCommands = this.getEffectiveAllowedCommands(request);
    const codeWorkspaceRoot = this.getCodeWorkspaceRoot(request);
    if (!codeWorkspaceRoot) {
      const shellCheck = sanitizeShellArgs(command, allowedCommands);
      if (!shellCheck.safe) {
        return shellCheck;
      }
      try {
        const commands = splitCommands(tokenize(command));
        if (commands.length === 0) {
          return { safe: false, reason: 'Command failed shell parsing.' };
        }
        return { safe: true, plan: this.buildShellCommandPlan(commands) };
      } catch {
        return { safe: false, reason: 'Command failed shell parsing.' };
      }
    }

    const effectiveCwd = cwd ?? codeWorkspaceRoot;
    const validation = validateShellCommand(
      command,
      allowedCommands,
      (candidate) => this.isCodePathTokenDenied(candidate, codeWorkspaceRoot, effectiveCwd),
    );
    if (!validation.valid) {
      return {
        safe: false,
        reason: validation.reason ?? 'Command failed Coding Workspace shell validation.',
      };
    }

    const tokenBlockReason = this.getCodeShellTokenBlockReason(validation.commands);
    if (tokenBlockReason) {
      return { safe: false, reason: tokenBlockReason };
    }

    const executionIdentityReason = getExecutionIdentityBlockReason(validation.commands);
    if (executionIdentityReason) {
      return { safe: false, reason: executionIdentityReason };
    }

    return { safe: true, plan: this.buildShellCommandPlan(validation.commands) };
  }

  /**
   * Pre-flight validation: check what approval decision each tool would get
   * under the current policy, and suggest fixes the user can apply.
   */
  preflightTools(requests: ToolPreflightRequest[]): ToolPreflightResult[] {
    return requests.map((request) => {
      const name = typeof request === 'string' ? request : request.name;
      const args = isRecord(request) && isRecord(request.args) ? request.args : {};
      const entry = this.registry.get(name);
      if (!entry) {
        return { name, found: false, risk: 'unknown', decision: 'deny' as const, reason: 'Tool not found', fixes: [] };
      }
      const def = entry.definition;
      const baseDecision = this.decide(def, args);
      let decision = baseDecision;
      const fixes: ToolPreflightFix[] = [];

      if (baseDecision === 'require_approval') {
        // Suggest per-tool auto policy override
        fixes.push({
          type: 'tool_policy',
          value: name,
          description: `Set per-tool policy for "${name}" to auto-approve`,
        });
      }

      const sandboxCheck = this.preflightSandbox(def.name, args);
      let reason = this.describePreflightDecision(def, name, baseDecision);
      if (sandboxCheck) {
        decision = 'deny';
        reason = baseDecision === 'require_approval'
          ? `${sandboxCheck.reason} Also requires approval under the current tool policy.`
          : sandboxCheck.reason;
        if (sandboxCheck.fix) fixes.push(sandboxCheck.fix);
      }

      return { name, found: true, risk: def.risk, decision, reason, fixes };
    });
  }

  private describePreflightDecision(definition: ToolDefinition, name: string, decision: ToolDecision): string {
    if (decision === 'allow') {
      if (isDirectMemoryMutationToolName(name)) {
        return 'Direct memory writes auto-approve after explicit remember intent and trust checks.';
      }
      return definition.risk === 'read_only' ? 'Read-only tool, auto-approved' : 'Approved by current policy';
    }
    if (decision === 'deny') {
      const explicit = this.policy.toolPolicies[name];
      return explicit === 'deny' ? 'Explicitly denied by per-tool policy' : 'Blocked by tool policy';
    }
    if (isElevatedMemoryMutationToolName(name)) {
      return 'Elevated memory mutations require approval.';
    }
    if (definition.risk === 'external_post') {
      return 'External post tools always require approval';
    }
    if (definition.risk === 'mutating') {
      return `Mutating tool requires approval in "${this.policy.mode}" mode`;
    }
    return `Tool risk "${definition.risk}" requires approval in "${this.policy.mode}" mode`;
  }

  private preflightSandbox(toolName: string, args: Record<string, unknown>): { reason: string; fix?: ToolPreflightFix } | null {
    if (toolName === 'code_remote_exec') {
      try {
        this.resolveRemoteExecutionTarget(asString(args.profile).trim() || undefined);
        // We only care about domain resolution errors from getResolvedVercelSandboxTarget or getResolvedDaytonaSandboxTarget
        // which throw Error(`Host '${apiUrl.hostname}' is not in allowedDomains.`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const match = message.match(/Host '([^']+)' is not in allowedDomains\./);
        if (match) {
          return {
            reason: message,
            fix: {
              type: 'domain',
              value: match[1],
              description: `Add '${match[1]}' to allowed domains`,
            },
          };
        }
        return { reason: message };
      }
      return null;
    }

    if (toolName === 'package_install') {
      const command = asString(args.command).trim();
      if (!command) return null;
      const degradedPackageManagerReason = this.getDegradedPackageManagerBlockReason(command);
      if (degradedPackageManagerReason) {
        return { reason: degradedPackageManagerReason };
      }
      const planned = parseManagedPackageInstallCommand(command);
      if (!planned.success) {
        return { reason: planned.error ?? 'Managed package install planning failed.' };
      }
      return null;
    }

    const pathCheck = this.preflightPathArgs(args);
    if (pathCheck) return pathCheck;

    const commandCheck = this.preflightCommandArgs(args);
    if (commandCheck) return commandCheck;

    const hostCheck = this.preflightHostArgs(toolName, args);
    if (hostCheck) return hostCheck;

    return null;
  }

  private preflightPathArgs(args: Record<string, unknown>): { reason: string; fix?: ToolPreflightFix } | null {
    const keys = ['path', 'filePath', 'targetPath', 'outputPath', 'workspacePath', 'csvPath'];
    for (const key of keys) {
      const value = args[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      if (this.isPathAllowedForPreflight(value)) continue;
      return {
        reason: `Path '${value}' is not in allowedPaths.`,
        fix: {
          type: 'path',
          value,
          description: `Add '${value}' to allowed paths`,
        },
      };
    }
    return null;
  }

  private preflightCommandArgs(args: Record<string, unknown>): { reason: string; fix?: ToolPreflightFix } | null {
    const keys = ['command', 'cmd'];
    for (const key of keys) {
      const value = args[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      const normalized = value.trim();
      const degradedPackageManagerReason = this.getDegradedPackageManagerBlockReason(normalized);
      if (degradedPackageManagerReason) {
        return { reason: degradedPackageManagerReason };
      }
      const shellCheck = sanitizeShellArgs(normalized, this.policy.sandbox.allowedCommands);
      if (shellCheck.safe) continue;
      const isAllowlistMiss = shellCheck.reason === `Command is not allowlisted: '${normalized}'.`;
      return isAllowlistMiss
        ? {
          reason: `Command '${normalized}' is not in allowedCommands.`,
          fix: {
            type: 'command',
            value: normalized,
            description: `Add '${normalized}' to allowed commands`,
          },
        }
        : {
          reason: shellCheck.reason ?? `Command '${normalized}' failed shell validation.`,
        };
    }
    return null;
  }

  private getDegradedPackageManagerBlockReason(command: string): string | null {
    if (!isDegradedSandboxFallbackActive(this.sandboxConfig, this.sandboxHealth)) return null;
    if (resolveDegradedFallbackConfig(this.sandboxConfig).allowPackageManagers) return null;
    const tokens = tokenize(command).map((token) => token.toLowerCase());
    if (tokens.length === 0) return null;

    const [first, second, third, fourth] = tokens;
    const isInstallLike = (
      first === 'npx'
      || (first === 'npm' && ['install', 'i', 'ci', 'add', 'update', 'exec'].includes(second ?? ''))
      || (first === 'pnpm' && ['install', 'i', 'add', 'dlx', 'update', 'up'].includes(second ?? ''))
      || (first === 'yarn' && ['install', 'add', 'dlx', 'upgrade', 'up'].includes(second ?? ''))
      || (first === 'bun' && ['install', 'add', 'x'].includes(second ?? ''))
      || ((first === 'pip' || first === 'pip3') && ['install', 'download'].includes(second ?? ''))
      || ((first === 'python' || first === 'python3') && second === '-m' && third === 'pip' && ['install', 'download'].includes(fourth ?? ''))
      || (first === 'uv' && (
        ['add', 'sync'].includes(second ?? '')
        || (second === 'pip' && ['install', 'sync'].includes(third ?? ''))
        || (second === 'tool' && ['install', 'run'].includes(third ?? ''))
      ))
      || (first === 'cargo' && ['install', 'add'].includes(second ?? ''))
      || (first === 'go' && ['get', 'install'].includes(second ?? ''))
      || (first === 'composer' && ['install', 'require', 'update'].includes(second ?? ''))
      || (first === 'bundle' && second === 'install')
      || (first === 'gem' && second === 'install')
      || (first === 'dotnet' && ['restore', 'add', 'tool'].includes(second ?? ''))
    );

    if (!isInstallLike) return null;
    return `Install-like package manager commands are blocked on degraded sandbox backends unless ${DEGRADED_PACKAGE_MANAGER_HINT} is enabled.`;
  }

  private preflightHostArgs(toolName: string, args: Record<string, unknown>): { reason: string; fix?: ToolPreflightFix } | null {
    const explicitHost = this.extractHostFromArgs(args);
    if (explicitHost) {
      if (explicitHost.invalidValue) {
        return {
          reason: `Invalid URL '${explicitHost.invalidValue}'.`,
        };
      }
      const host = explicitHost.host;
      if (!host) return null;
      if (isPrivateAddress(host)) {
        return {
          reason: `Blocked: ${host} is a private/internal address (SSRF protection).`,
        };
      }
      if (!this.isHostAllowedForTool(toolName, host)) {
        return {
          reason: this.isBrowserFacingTool(toolName)
            ? `Host '${host}' is not in the browser allowedDomains.`
            : `Host '${host}' is not in allowedDomains.`,
          fix: {
            type: 'domain',
            value: host,
            description: this.isBrowserFacingTool(toolName)
              ? `Add '${host}' to browser allowed domains`
              : `Add '${host}' to allowed domains`,
          },
        };
      }
      return null;
    }

    if (toolName === 'web_search') {
      const provider = this.resolveSearchProvider(asString(args.provider, 'auto'));
      const blocked = this.getWebSearchRequiredHosts(provider).find((host) => !this.isHostAllowed(host));
      if (blocked) {
        return {
          reason: `Web search provider '${provider}' is blocked by allowedDomains.`,
          fix: {
            type: 'domain',
            value: blocked,
            description: `Add '${blocked}' to allowed domains`,
          },
        };
      }
    }

    return null;
  }

  private extractHostFromArgs(args: Record<string, unknown>): { host: string; invalidValue?: undefined } | { host?: undefined; invalidValue: string } | null {
    const keys = ['url', 'baseUrl', 'endpoint', 'targetUrl'];
    for (const key of keys) {
      const value = args[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      try {
        return { host: new URL(normalizeHttpUrlLikeInput(value)).hostname.toLowerCase() };
      } catch {
        return { invalidValue: value };
      }
    }
    return null;
  }

  private isBrowserFacingTool(toolName: string): boolean {
    return toolName.startsWith('browser_') || isBrowserMcpToolName(toolName);
  }

  private isAssistantVisibleTool(definition: ToolDefinition): boolean {
    return !isBrowserMcpToolName(definition.name);
  }

  private getBrowserAllowedDomains(): string[] {
    return this.options.browserConfig?.allowedDomains?.length
      ? this.options.browserConfig.allowedDomains
      : this.policy.sandbox.allowedDomains;
  }

  private getExplicitBrowserAllowedDomains(): string[] | null {
    return Array.isArray(this.options.browserConfig?.allowedDomains) && this.options.browserConfig.allowedDomains.length > 0
      ? [...this.options.browserConfig.allowedDomains]
      : null;
  }

  private isHostAllowedForTool(toolName: string, host: string): boolean {
    return this.isBrowserFacingTool(toolName)
      ? this.isHostAllowed(host, this.getBrowserAllowedDomains())
      : this.isHostAllowed(host);
  }

  private isPathAllowedForPreflight(candidate: string): boolean {
    const trimmed = candidate.trim();
    if (!trimmed) return false;
    const normalizedCandidate = this.normalizePreflightPath(trimmed);
    const roots = this.policy.sandbox.allowedPaths.length > 0
      ? this.policy.sandbox.allowedPaths
      : [this.options.workspaceRoot];
    return roots.some((root) => {
      const normalizedRoot = this.normalizePreflightPath(root);
      return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
    });
  }

  private normalizePreflightPath(value: string): string {
    const resolvedPath = isAbsolute(value) ? resolve(value) : resolve(this.options.workspaceRoot, value);
    return resolvedPath.replaceAll('\\', '/').toLowerCase();
  }

  private getWebSearchRequiredHosts(provider: 'duckduckgo' | 'brave' | 'perplexity'): string[] {
    return provider === 'duckduckgo'
      ? ['html.duckduckgo.com']
      : provider === 'brave'
        ? ['api.search.brave.com']
        : this.webSearchConfig.perplexityApiKey
          ? ['api.perplexity.ai']
          : ['openrouter.ai'];
  }

  updateWebSearchConfig(cfg: WebSearchConfig): void {
    this.webSearchConfig = { ...cfg };
    // Clear cache so new provider takes effect immediately
    this.searchCache.clear();
  }

  /** Check whether a tool category is enabled. Undefined category remains enabled. */
  private isCategoryEnabled(category?: string): boolean {
    if (!category) return true;
    return !this.disabledCategories.has(category);
  }

  /** Return info about all 10 tool categories with current enable/disable status. */
  getCategoryInfo(): Array<{
    category: ToolCategory;
    label: string;
    description: string;
    toolCount: number;
    enabled: boolean;
    disabledReason?: string;
  }> {
    return (Object.keys(TOOL_CATEGORIES) as ToolCategory[]).map((cat) => ({
      category: cat,
      label: TOOL_CATEGORIES[cat].label,
      description: TOOL_CATEGORIES[cat].description,
      toolCount: BUILTIN_TOOL_CATEGORIES[cat].length,
      enabled: !this.disabledCategories.has(cat) && !this.getSandboxBlockedCategoryReason(cat),
      disabledReason: this.disabledCategories.has(cat)
        ? 'Disabled by policy.'
        : this.getSandboxBlockedCategoryReason(cat) ?? undefined,
    }));
  }

  /** Get currently disabled categories. */
  getDisabledCategories(): ToolCategory[] {
    return [...this.disabledCategories] as ToolCategory[];
  }

  /** Enable or disable a tool category at runtime (no restart required). */
  setCategoryEnabled(category: ToolCategory, enabled: boolean): void {
    if (enabled) {
      this.disabledCategories.delete(category);
    } else {
      this.disabledCategories.add(category);
    }
  }

  /** Dispose resources. Call on shutdown. */
  async dispose(): Promise<void> {
    // Browser sessions are now managed by MCP servers (no local cleanup needed)
    this.options.codingBackendService?.dispose();
  }

  listJobs(limit = 50): ToolJobRecord[] {
    return this.jobs.slice(0, Math.max(1, limit));
  }

  listApprovals(limit = 50, status?: 'pending' | 'approved' | 'denied') {
    return this.approvals.list(Math.min(MAX_APPROVALS, Math.max(1, limit)), status);
  }

  listPendingApprovalIdsForUser(
    userId: string | undefined,
    channel: string | undefined,
    options?: { includeUnscoped?: boolean; limit?: number; principalId?: string },
  ): string[] {
    const normalizedUserId = (userId ?? '').trim();
    const normalizedChannel = (channel ?? '').trim();
    const normalizedPrincipalId = (options?.principalId ?? '').trim();
    const includeUnscoped = options?.includeUnscoped === true;
    const limit = Math.min(MAX_APPROVALS, Math.max(1, options?.limit ?? MAX_APPROVALS));
    const pending = this.approvals.list(limit, 'pending');
    const ids: string[] = [];

    for (const approval of pending) {
      const job = this.jobsById.get(approval.jobId);
      if (!job) continue;
      const jobUserId = (job.userId ?? '').trim();
      const jobPrincipalId = (job.principalId ?? approval.requestedByPrincipal ?? '').trim();
      const jobChannel = (job.channel ?? '').trim();
      const scopedMatch = normalizedUserId.length > 0
        && normalizedChannel.length > 0
        && jobUserId === normalizedUserId
        && jobChannel === normalizedChannel;
      const principalMatch = normalizedPrincipalId.length > 0 && jobPrincipalId === normalizedPrincipalId;
      const unscopedMatch = includeUnscoped && jobUserId.length === 0 && jobChannel.length === 0;
      if ((principalMatch && (normalizedChannel.length === 0 || jobChannel === normalizedChannel)) || scopedMatch || unscopedMatch) {
        ids.push(approval.id);
      }
    }

    return ids;
  }

  listJobsForCodeSession(codeSessionId: string, limit = 50): ToolJobRecord[] {
    const normalizedCodeSessionId = codeSessionId.trim();
    if (!normalizedCodeSessionId) return [];
    return this.jobs
      .filter((job) => job.codeSessionId === normalizedCodeSessionId)
      .slice(0, Math.max(1, limit));
  }

  listPendingApprovalsForCodeSession(
    codeSessionId: string,
    limit = 50,
  ): Array<{
    id: string;
    toolName: string;
    argsPreview: string;
    actionLabel?: string;
    createdAt: number;
    risk: ToolDefinition['risk'];
    origin: ToolApprovalRequest['origin'];
    jobId?: string;
    requestId?: string;
  }> {
    const normalizedCodeSessionId = codeSessionId.trim();
    if (!normalizedCodeSessionId) return [];
    return this.approvals
      .list(Math.min(MAX_APPROVALS, Math.max(1, limit)), 'pending')
      .filter((approval) => approval.codeSessionId === normalizedCodeSessionId)
      .map((approval) => {
        const job = this.jobsById.get(approval.jobId);
        return {
          id: approval.id,
          toolName: approval.toolName,
          argsPreview: job?.argsPreview ?? JSON.stringify(approval.args).slice(0, 120),
          actionLabel: describePendingApproval({
            toolName: approval.toolName,
            argsPreview: job?.argsPreview ?? JSON.stringify(approval.args).slice(0, 120),
          }),
          createdAt: approval.createdAt,
          risk: approval.risk,
          origin: approval.origin,
          jobId: approval.jobId,
          requestId: job?.requestId,
        };
      });
  }

  approvalBelongsToCodeSession(approvalId: string, codeSessionId: string): boolean {
    const normalizedApprovalId = approvalId.trim();
    const normalizedCodeSessionId = codeSessionId.trim();
    if (!normalizedApprovalId || !normalizedCodeSessionId) return false;
    const approval = this.approvals.get(normalizedApprovalId);
    if (!approval) return false;
    if (approval.codeSessionId) return approval.codeSessionId === normalizedCodeSessionId;
    const job = this.jobsById.get(approval.jobId);
    return job?.codeSessionId === normalizedCodeSessionId;
  }

  /** Return approval ID → tool name + args preview for display in approval prompts. */
  getApprovalSummaries(approvalIds: string[]): Map<string, PendingApprovalSummary> {
    const result = new Map<string, PendingApprovalSummary>();
    for (const id of approvalIds) {
      const pending = this.approvals.list(MAX_APPROVALS, 'pending');
      const approval = pending.find(a => a.id === id);
      if (approval) {
        const job = this.jobsById.get(approval.jobId);
        const argsPreview = job?.argsPreview ?? JSON.stringify(approval.args).slice(0, 120);
        result.set(id, {
          toolName: approval.toolName,
          argsPreview,
          actionLabel: describePendingApproval({
            toolName: approval.toolName,
            argsPreview,
          }),
          ...(job?.requestId ? { requestId: job.requestId } : {}),
          ...(job?.codeSessionId ? { codeSessionId: job.codeSessionId } : {}),
        });
      }
    }
    return result;
  }

  async runTool(request: ToolExecutionRequest): Promise<ToolRunResponse> {
    if (!this.options.enabled) {
      return {
        success: false,
        status: 'denied',
        jobId: randomUUID(),
        message: 'Tools are disabled.',
      };
    }

    const args = request.args ?? {};
    const entry = this.registry.get(request.toolName);
    if (!entry) {
      return {
        success: false,
        status: 'failed',
        jobId: randomUUID(),
        message: `Unknown tool '${request.toolName}'.`,
      };
    }

    // Defense-in-depth: block tools in disabled categories even if registered
    if (!this.isCategoryEnabled(entry.definition.category)) {
      return {
        success: false,
        status: 'denied',
        jobId: randomUUID(),
        message: `Tool '${request.toolName}' is in disabled category '${entry.definition.category}'.`,
      };
    }

    const sandboxBlockReason = this.getSandboxBlockReason(entry.definition.name, entry.definition.category);
    if (sandboxBlockReason) {
      return {
        success: false,
        status: 'denied',
        jobId: randomUUID(),
        message: sandboxBlockReason,
      };
    }

    const sizeValidation = validateArgSize(args, MAX_TOOL_ARG_BYTES);
    if (!sizeValidation.valid) {
      return {
        success: false,
        status: 'failed',
        jobId: randomUUID(),
        message: sizeValidation.reason ?? 'Tool arguments exceeded the maximum size.',
      };
    }

    const job = this.createJob(entry.definition, request, args);
    const toolChainBudgetError = this.consumeToolChainBudget(entry.definition, request, job.argsHash);
    if (toolChainBudgetError) {
      job.status = 'denied';
      job.completedAt = this.now();
      job.durationMs = 0;
      job.error = sanitizePreview(toolChainBudgetError);
      this.recordToolChainOutcome(entry.definition, request, job.argsHash, job.status);
      return {
        success: false,
        status: job.status,
        jobId: job.id,
        message: toolChainBudgetError,
      };
    }
    const argsValidationError = this.validateToolArgs(entry.definition, args);
    if (argsValidationError) {
      job.status = 'failed';
      job.completedAt = this.now();
      job.durationMs = 0;
      job.error = sanitizePreview(argsValidationError);
      this.recordToolChainOutcome(entry.definition, request, job.argsHash, job.status);
      return {
        success: false,
        status: job.status,
        jobId: job.id,
        message: job.error,
      };
    }

    const memoryMutationIntentError = this.getMemoryMutationIntentError(entry.definition.name, request);
    if (memoryMutationIntentError) {
      job.status = 'denied';
      job.completedAt = this.now();
      job.durationMs = 0;
      job.error = sanitizePreview(memoryMutationIntentError);
      this.recordToolChainOutcome(entry.definition, request, job.argsHash, job.status);
      return {
        success: false,
        status: job.status,
        jobId: job.id,
        message: memoryMutationIntentError,
      };
    }

    const preApprovalError = await this.validateBeforeApproval(entry.definition.name, args, request);
    if (preApprovalError) {
      job.status = 'failed';
      job.completedAt = this.now();
      job.durationMs = 0;
      job.error = sanitizePreview(preApprovalError);
      this.recordToolChainOutcome(entry.definition, request, job.argsHash, job.status);
      return {
        success: false,
        status: job.status,
        jobId: job.id,
        message: preApprovalError,
      };
    }

    const decision = this.decide(entry.definition, args, request);
    if (decision === 'deny') {
      job.status = 'denied';
      job.completedAt = this.now();
      job.durationMs = 0;
      job.error = 'Blocked by tool policy.';
      this.recordToolChainOutcome(entry.definition, request, job.argsHash, job.status);
      return {
        success: false,
        status: job.status,
        jobId: job.id,
        message: job.error,
      };
    }

    if (decision === 'require_approval') {
      if (request.bypassApprovals) {
        return await this.execute(job, request, args, entry.handler);
      }

      // Caching / Retry Loop Fix: If the LLM just retried the exact same tool
      // call after it was already approved and executed, return the previous result.
      if (job.argsHash) {
        const recentApproved = this.approvals.list(50, 'approved').find(
          (a) => a.toolName === job.toolName
            && a.argsHash === job.argsHash
            && (a.codeSessionId ?? '') === (job.codeSessionId ?? '')
            && a.decidedAt
            && (this.now() - a.decidedAt) < 5 * 60_000
        );
        if (recentApproved) {
          const oldJob = this.jobsById.get(recentApproved.jobId);
          if (oldJob && oldJob.status === 'succeeded') {
            job.status = 'succeeded';
            job.completedAt = this.now();
            job.durationMs = 0;
            job.resultPreview = oldJob.resultPreview;
            return {
              success: true,
              status: 'succeeded',
              jobId: job.id,
              message: oldJob.resultPreview || 'Already approved and executed successfully.',
            };
          } else if (oldJob && oldJob.status === 'failed') {
            job.status = 'failed';
            job.completedAt = this.now();
            job.durationMs = 0;
            job.error = oldJob.error;
            return {
              success: false,
              status: 'failed',
              jobId: job.id,
              message: oldJob.error || 'Previously failed execution.',
            };
          }
          // If approved but somehow pending execution, execute it now!
          return await this.execute(job, request, args, entry.handler);
        }
      }

      const redactedArgs = redactSensitiveValue(args);
      const approvalArgs = isRecord(redactedArgs) ? redactedArgs : {};
      const approval = this.approvals.create(
        job,
        approvalArgs,
        job.argsHash,
        request.principalId ?? request.userId,
        request.principalRole ?? 'owner',
        this.now,
      );
      job.status = 'pending_approval';
      job.approvalId = approval.id;
      this.pendingApprovalContexts.set(approval.id, { request, args });
      return {
        success: false,
        status: job.status,
        jobId: job.id,
        approvalId: approval.id,
        message: `Tool '${request.toolName}' is awaiting approval.`,
      };
    }

    const result = await this.execute(job, request, args, entry.handler);
    return result;
  }

  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    actor: string,
    actorRole: import('./types.js').PrincipalRole = 'owner',
    reason?: string,
  ): Promise<ToolApprovalDecisionResult> {
    const existingApprovalStatus = this.approvals.get(approvalId)?.status;
    const wasAlreadySettled = existingApprovalStatus === 'approved' || existingApprovalStatus === 'denied';
    const approval = this.approvals.decide(approvalId, decision, actor, actorRole, reason, this.now);
    if (!approval) {
      return { success: false, message: `Approval '${approvalId}' not found.` };
    }
    if (approval.status === 'pending') {
      return { success: false, message: approval.reason ?? `Approval '${approvalId}' is not authorized for actor '${actor}'.` };
    }

    const job = this.jobsById.get(approval.jobId);
    if (!job) {
      return { success: false, message: `Job '${approval.jobId}' for approval '${approvalId}' was not found.` };
    }

    if (wasAlreadySettled) {
      if (approval.status === 'approved') {
        if (job.status === 'succeeded') {
          return {
            success: true,
            message: job.resultPreview || `Approval '${approvalId}' was already approved and executed successfully.`,
            job,
          };
        }
        if (job.status === 'failed') {
          return {
            success: false,
            message: job.error || `Approval '${approvalId}' was already approved, but execution failed.`,
            job,
          };
        }
        if (job.status === 'denied') {
          return {
            success: false,
            message: job.error || `Approval '${approvalId}' was already denied.`,
            job,
          };
        }
        return {
          success: false,
          message: `Approval '${approvalId}' was already approved, but its execution context is no longer available.`,
          job,
        };
      }
      return {
        success: false,
        message: `Approval '${approvalId}' was already denied.`,
        job,
      };
    }

    if (decision === 'denied') {
      job.status = 'denied';
      job.completedAt = this.now();
      job.durationMs = 0;
      job.error = reason?.trim() || 'Denied by user.';
      this.pendingApprovalContexts.delete(approvalId);
      const deniedResult: ToolApprovalDecisionResult = {
        success: true,
        message: `Denied approval '${approvalId}'.`,
        job,
      };
      try {
        await this.options.onApprovalDecided?.(approvalId, decision, deniedResult);
      } catch {
        // Approval side-effects should not change the approval outcome.
      }
      return deniedResult;
    }

    const pending = this.pendingApprovalContexts.get(approvalId);
    if (!pending) {
      return { success: false, message: `No pending context found for approval '${approvalId}'.` };
    }
    this.pendingApprovalContexts.delete(approvalId);

    const entry = this.registry.get(job.toolName);
    if (!entry) {
      job.status = 'failed';
      job.error = `Tool '${job.toolName}' no longer exists.`;
      job.completedAt = this.now();
      return { success: false, message: job.error, job };
    }

    const result = await this.execute(job, pending.request, pending.args, entry.handler);
    const approvalResult: ToolApprovalDecisionResult = {
      success: result.success,
      message: result.message,
      job,
      result,
    };
    try {
      await this.options.onApprovalDecided?.(approvalId, decision, approvalResult);
    } catch {
      // Approval side-effects should not change the approval outcome.
    }
    return approvalResult;
  }

  async executeModelTool(
    toolName: string,
    args: Record<string, unknown>,
    request: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  ): Promise<Record<string, unknown>> {
    const result = await this.runTool({
      ...request,
      toolName,
      args,
    });
    return {
      success: result.success,
      status: result.status,
      message: result.message,
      error: result.error,
      jobId: result.jobId,
      approvalId: result.approvalId,
      output: result.output,
    };
  }

  private createJob(
    definition: ToolDefinition,
    request: ToolExecutionRequest,
    args: Record<string, unknown>,
  ): ToolJobRecord {
    const redactedArgs = hashRedactedObject(args);
    const argsPreview = formatToolArgsPreview(definition.name, redactedArgs.redacted);
    const job: ToolJobRecord = {
      id: randomUUID(),
      toolName: definition.name,
      risk: definition.risk,
      origin: request.origin,
      ...(request.codeContext?.sessionId?.trim() ? { codeSessionId: request.codeContext.sessionId.trim() } : {}),
      agentId: request.agentId,
      userId: request.userId,
      principalId: request.principalId,
      principalRole: request.principalRole,
      channel: request.channel,
      requestId: request.requestId,
      argsHash: redactedArgs.hash,
      argsRedacted: (redactedArgs.redacted && typeof redactedArgs.redacted === 'object')
        ? redactedArgs.redacted as Record<string, unknown>
        : undefined,
      argsPreview,
      status: 'running',
      createdAt: this.now(),
      requiresApproval: false,
    };
    this.jobs.unshift(job);
    this.jobsById.set(job.id, job);
    while (this.jobs.length > MAX_JOBS) {
      const removed = this.jobs.pop();
      if (removed) this.jobsById.delete(removed.id);
    }
    return job;
  }

  private pruneToolChainBudgets(): void {
    const cutoff = this.now() - TOOL_CHAIN_TTL_MS;
    for (const [key, state] of this.toolChainBudgets.entries()) {
      if (state.lastSeenAt < cutoff) {
        this.toolChainBudgets.delete(key);
      }
    }
  }

  private resolveToolChainKey(request: Partial<ToolExecutionRequest>): string | null {
    const requestId = request.requestId?.trim();
    if (requestId) return `request:${requestId}`;
    const scheduleId = request.scheduleId?.trim();
    if (scheduleId) return `schedule:${scheduleId}`;
    return null;
  }

  private getToolChainBudget(request: Partial<ToolExecutionRequest>): ToolChainBudgetState | null {
    const key = this.resolveToolChainKey(request);
    if (!key) return null;
    this.pruneToolChainBudgets();
    const existing = this.toolChainBudgets.get(key);
    if (existing) {
      existing.lastSeenAt = this.now();
      return existing;
    }
    const created: ToolChainBudgetState = {
      totalCalls: 0,
      nonReadOnlyCalls: 0,
      signatureCounts: new Map(),
      signatureFailureCounts: new Map(),
      lastSeenAt: this.now(),
    };
    this.toolChainBudgets.set(key, created);
    return created;
  }

  private consumeToolChainBudget(
    definition: ToolDefinition,
    request: Partial<ToolExecutionRequest>,
    argsHash: string | undefined,
  ): string | null {
    const budget = this.getToolChainBudget(request);
    if (!budget) return null;

    const signature = argsHash ? `${definition.name}:${argsHash}` : undefined;
    if (signature) {
      const priorFailures = budget.signatureFailureCounts.get(signature) ?? 0;
      if (priorFailures >= MAX_IDENTICAL_FAILURES_PER_CHAIN) {
        return `Blocked runaway retry for '${definition.name}': the same action has already failed ${priorFailures} times in this execution chain.`;
      }
    }

    budget.totalCalls += 1;
    if (budget.totalCalls > MAX_TOOL_CALLS_PER_CHAIN) {
      return `Blocked runaway tool execution: exceeded ${MAX_TOOL_CALLS_PER_CHAIN} tool calls in one execution chain.`;
    }

    if (definition.risk !== 'read_only') {
      budget.nonReadOnlyCalls += 1;
      if (budget.nonReadOnlyCalls > MAX_NON_READ_ONLY_CALLS_PER_CHAIN) {
        return `Blocked runaway tool execution: exceeded ${MAX_NON_READ_ONLY_CALLS_PER_CHAIN} non-read-only tool calls in one execution chain.`;
      }
    }

    if (signature) {
      const count = (budget.signatureCounts.get(signature) ?? 0) + 1;
      budget.signatureCounts.set(signature, count);
      if (count > MAX_IDENTICAL_CALLS_PER_CHAIN) {
        return `Blocked runaway tool execution: '${definition.name}' was requested more than ${MAX_IDENTICAL_CALLS_PER_CHAIN} times with the same arguments in one execution chain.`;
      }
    }

    return null;
  }

  private recordToolChainOutcome(
    definition: ToolDefinition,
    request: Partial<ToolExecutionRequest>,
    argsHash: string | undefined,
    status: ToolJobStatus,
  ): void {
    const budget = this.getToolChainBudget(request);
    if (!budget || !argsHash) return;
    if (status !== 'failed' && status !== 'denied') return;
    const signature = `${definition.name}:${argsHash}`;
    budget.signatureFailureCounts.set(signature, (budget.signatureFailureCounts.get(signature) ?? 0) + 1);
  }

  private decide(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    request: Partial<ToolExecutionRequest> = {},
  ): ToolDecision {
    if (!this.options.enabled) return 'deny';

    const contentTrustLevel = request.contentTrustLevel ?? 'trusted';
    const derivedFromTaintedContent = request.derivedFromTaintedContent === true;
    const memoryMutationDecision = this.decideMemoryMutationTrust(definition.name, request);

    if (memoryMutationDecision) {
      return memoryMutationDecision;
    }

    if (contentTrustLevel === 'quarantined' && definition.risk !== 'read_only') {
      return 'deny';
    }
    if (derivedFromTaintedContent) {
      if (definition.risk !== 'read_only') {
        return 'require_approval';
      }
    }

    const explicit = this.policy.toolPolicies[definition.name];
    if (explicit === 'deny') {
      return 'deny';
    }

    const codeSessionTrustDecision = this.decideCodeSessionTrust(definition, args, request);
    if (codeSessionTrustDecision) {
      return codeSessionTrustDecision;
    }

    const defaultMemoryMutationDecision = this.decideDefaultMemoryMutationPolicy(definition.name);
    if (defaultMemoryMutationDecision) {
      return defaultMemoryMutationDecision;
    }

    if (explicit) {
      if (explicit === 'auto') return 'allow';
      if (explicit === 'manual') return 'require_approval';
    }

    const browserDecision = this.decideBrowserTool(definition.name, args);
    if (browserDecision) {
      return browserDecision;
    }

    const gwsDecision = this.decideGwsTool(definition.name, args);
    if (gwsDecision) {
      return gwsDecision;
    }

    if (this.isPolicyUpdateNoOp(definition, args, request)) {
      return 'allow';
    }

    // Auto-approve coding and filesystem tools operating within the code session workspace.
    // The user granted trust to this workspace by creating the session.
    if (this.isCodeSessionWorkspaceTool(definition, request)) {
      return 'allow';
    }

    const m365Decision = this.decideM365Tool(definition.name, args);
    if (m365Decision) {
      return m365Decision;
    }

    const cloudDecision = this.decideCloudTool(definition.name, args);
    if (cloudDecision) {
      return cloudDecision;
    }

    // Read-only shell commands skip approval even under approve_by_policy
    if (definition.name === 'shell_safe' && this.policy.mode !== 'approve_each') {
      const fullCmd = ((args as Record<string, unknown>).command as string ?? '').trim();
      if (this.isReadOnlyShellCommand(fullCmd)) {
        return 'allow';
      }
    }

    if (definition.risk === 'external_post') {
      return 'require_approval';
    }

    switch (this.policy.mode) {
      case 'approve_each':
        return definition.risk === 'read_only' ? 'allow' : 'require_approval';
      case 'autonomous':
        return 'allow';
      case 'approve_by_policy':
      default:
        if (definition.risk === 'read_only') return 'allow';
        if (definition.risk === 'network') return 'allow';
        return 'require_approval';
    }
  }

  private decideMemoryMutationTrust(
    toolName: string,
    request: Partial<ToolExecutionRequest>,
  ): ToolDecision | null {
    if (!isMemoryMutationToolName(toolName)) {
      return null;
    }
    const contentTrustLevel = request.contentTrustLevel ?? 'trusted';
    if (contentTrustLevel === 'quarantined') {
      return 'deny';
    }
    return request.derivedFromTaintedContent === true ? 'require_approval' : null;
  }

  private decideDefaultMemoryMutationPolicy(toolName: string): ToolDecision | null {
    if (isDirectMemoryMutationToolName(toolName)) {
      return 'allow';
    }
    if (isElevatedMemoryMutationToolName(toolName)) {
      return 'require_approval';
    }
    return null;
  }

  private decideBrowserTool(toolName: string, args: Record<string, unknown>): ToolDecision | null {
    if (toolName === 'browser_state') {
      return 'allow';
    }

    if (toolName === 'browser_act') {
      return hasValidBrowserMutationArgs(args)
        ? (this.policy.mode === 'autonomous' ? 'allow' : 'require_approval')
        : 'allow';
    }

    if (toolName !== 'browser_interact') {
      return null;
    }

    const action = asString(args.action, 'list').trim().toLowerCase();
    if (action === 'list') {
      return 'allow';
    }

    return hasValidBrowserMutationArgs(args)
      ? (this.policy.mode === 'autonomous' ? 'allow' : 'require_approval')
      : 'allow';
  }

  private decideGwsTool(toolName: string, args: Record<string, unknown>): ToolDecision | null {
    if (toolName !== 'gws') return null;

    const service = asString(args.service).trim().toLowerCase();
    const method = asString(args.method).trim().toLowerCase();
    const resource = asString(args.resource).trim().toLowerCase();
    const isWrite = /\b(create|insert|update|patch|delete|send|remove|modify)\b/i.test(method);

    // Reads for all services pass through to default policy (network → allow)
    if (!isWrite) return null;

    // Gmail send is always approval-gated regardless of policy mode
    if (service === 'gmail' && method === 'send') {
      return 'require_approval';
    }

    // Gmail drafts: approval-gated in non-autonomous modes
    if (service === 'gmail' && resource.includes('draft')) {
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    // All other GWS write operations: approval-gated in non-autonomous modes
    // Covers calendar, drive, docs, sheets, and any future services (fail-closed)
    return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
  }

  private decideM365Tool(toolName: string, args: Record<string, unknown>): ToolDecision | null {
    if (toolName !== 'm365') return null;

    const service = asString(args.service).trim().toLowerCase();
    const method = asString(args.method).trim().toLowerCase();
    const isWrite = /\b(create|insert|update|patch|delete|send|remove|modify|forward|reply)\b/i.test(method);

    // Reads for all services pass through to default policy (network → allow)
    if (!isWrite) return null;

    // Outlook send is always approval-gated regardless of policy mode
    if (service === 'mail' && method === 'send') {
      return 'require_approval';
    }

    // All other M365 write operations: approval-gated in non-autonomous modes
    return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
  }

  private decideCloudTool(toolName: string, args: Record<string, unknown>): ToolDecision | null {
    if (toolName === 'whm_accounts') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'cpanel_domains') {
      const action = asString(args.action).trim().toLowerCase();
      if (action === 'list' || action === 'list_redirects') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'cpanel_dns') {
      const action = asString(args.action).trim().toLowerCase();
      if (action === 'parse_zone') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'cpanel_backups') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'cpanel_ssl') {
      const action = asString(args.action).trim().toLowerCase();
      if (action === 'list_certs' || action === 'fetch_best_for_domain') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'vercel_projects') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list' || action === 'get') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'vercel_deployments') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list' || action === 'get') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'vercel_domains') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list' || action === 'get') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'vercel_env') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'vercel_status' || toolName === 'vercel_logs') {
      return 'allow';
    }

    if (toolName === 'cf_status') {
      return 'allow';
    }

    if (toolName === 'cf_dns') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list' || action === 'get') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'cf_ssl') {
      const action = asString(args.action, 'list_settings').trim().toLowerCase();
      if (action === 'list_settings' || action === 'get_setting') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'cf_cache') {
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'aws_status' || toolName === 'aws_cloudwatch' || toolName === 'aws_iam' || toolName === 'aws_costs') {
      return 'allow';
    }

    if (toolName === 'aws_ec2_instances') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list' || action === 'describe') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'aws_ec2_security_groups') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list' || action === 'describe') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'aws_s3_buckets') {
      const action = asString(args.action, 'list_buckets').trim().toLowerCase();
      if (action === 'list_buckets' || action === 'list_objects' || action === 'get_object') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'aws_route53') {
      const action = asString(args.action, 'list_zones').trim().toLowerCase();
      if (action === 'list_zones' || action === 'list_records') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'aws_lambda') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list' || action === 'get') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'aws_rds') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'gcp_status' || toolName === 'gcp_logs') {
      return 'allow';
    }

    if (toolName === 'gcp_compute') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list' || action === 'get') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'gcp_cloud_run') {
      const action = asString(args.action, 'list_services').trim().toLowerCase();
      if (action === 'list_services' || action === 'get_service' || action === 'list_revisions') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'gcp_storage') {
      const action = asString(args.action, 'list_buckets').trim().toLowerCase();
      if (action === 'list_buckets' || action === 'list_objects' || action === 'get_object') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'gcp_dns') {
      const action = asString(args.action, 'list_zones').trim().toLowerCase();
      if (action === 'list_zones' || action === 'list_records') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'azure_status' || toolName === 'azure_monitor') {
      return 'allow';
    }

    if (toolName === 'azure_vms') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list' || action === 'get') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'azure_app_service') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list' || action === 'get' || action === 'config') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'azure_storage') {
      const action = asString(args.action, 'list_accounts').trim().toLowerCase();
      if (action === 'list_accounts' || action === 'list_containers' || action === 'list_blobs') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'azure_dns') {
      const action = asString(args.action, 'list_zones').trim().toLowerCase();
      if (action === 'list_zones' || action === 'list_records') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'whm_dns') {
      const action = asString(args.action, 'list').trim().toLowerCase();
      if (action === 'list' || action === 'parse_zone') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'whm_ssl') {
      const action = asString(args.action).trim().toLowerCase();
      if (action === 'list_providers' || action === 'get_excluded_domains') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'whm_backup') {
      const action = asString(args.action).trim().toLowerCase();
      if (action === 'config_get' || action === 'destination_list' || action === 'date_list' || action === 'user_list') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    if (toolName === 'whm_services') {
      const action = asString(args.action).trim().toLowerCase();
      if (action === 'status' || action === 'get_config') return 'allow';
      return this.policy.mode === 'autonomous' ? 'allow' : 'require_approval';
    }

    return null;
  }

  private validateToolArgs(definition: ToolDefinition, args: Record<string, unknown>): string | null {
    const schema = definition.parameters;
    if (!isRecord(schema) || schema.type !== 'object') return null;

    try {
      const AjvClass = (Ajv as any).default || Ajv;
      const ajv = new AjvClass({ strict: false, allErrors: true, coerceTypes: false });
      const validate = ajv.compile(schema);
      const valid = validate(args);
      if (!valid && validate.errors) {
        return `Schema validation failed: ${ajv.errorsText(validate.errors)}`;
      }
    } catch (err) {
      return `Schema compilation failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    return null;
  }

  private async validateBeforeApproval(
    toolName: string,
    args: Record<string, unknown>,
    request?: Partial<ToolExecutionRequest>,
  ): Promise<string | null> {
    if (isMemoryMutationToolName(toolName)) {
      return this.getMemoryMutationReadOnlyError(args, request);
    }

    if (toolName === 'shell_safe') {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) {
        return null;
      }
      if (isInstallLikePackageManagerCommand(command)) {
        const plannedInstall = parseManagedPackageInstallCommand(command);
        return plannedInstall.success
          ? 'Install-like package manager commands must use package_install so Guardian can stage and review the package artifacts first.'
          : `Install-like package manager commands must use package_install. ${plannedInstall.error ?? 'This install form is not supported by managed package installs in v1.'}`;
      }
      const cwd = typeof args.cwd === 'string' && args.cwd.trim()
        ? await this.resolveAllowedPath(args.cwd.trim(), request)
        : this.getEffectiveWorkspaceRoot(request);
      const shellCheck = this.validateShellCommandForRequest(command, request, cwd);
      return shellCheck.safe ? null : shellCheck.reason ?? 'Command failed shell safety validation.';
    }

    if (toolName === 'package_install') {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) {
        return 'command is required';
      }
      const plannedInstall = parseManagedPackageInstallCommand(command);
      return plannedInstall.success ? null : (plannedInstall.error ?? 'Managed package install planning failed.');
    }

    if (toolName === 'fs_read' || toolName === 'fs_write' || toolName === 'fs_mkdir' || toolName === 'fs_delete' || toolName === 'doc_create') {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (path) {
        try {
          await this.resolveAllowedPath(path, request);
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }
    }

    if (toolName === 'fs_move' || toolName === 'fs_copy') {
      const source = typeof args.source === 'string' ? args.source.trim() : '';
      const destination = typeof args.destination === 'string' ? args.destination.trim() : '';
      for (const path of [source, destination]) {
        if (!path) continue;
        try {
          await this.resolveAllowedPath(path, request);
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }
    }

    if (this.isBrowserFacingTool(toolName)) {
      const validated = this.normalizeBrowserUrlArg(toolName, args.url);
      if (validated.error) {
        return validated.error;
      }
    }

    if (toolName === 'contacts_import_csv') {
      const csvPath = typeof args.csvPath === 'string' ? args.csvPath.trim() : '';
      if (csvPath) {
        try {
          await this.resolveAllowedPath(csvPath, request);
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }
    }

    if (toolName === 'whm_accounts') {
      try {
        this.assertWhmProfileConfigured(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (action === 'create') {
        if (!asString(args.username).trim()) return 'username is required for create';
        if (!asString(args.domain).trim()) return 'domain is required for create';
        if (!asString(args.password).trim()) return 'password is required for create';
      } else if (action === 'suspend' || action === 'unsuspend' || action === 'modify' || action === 'remove') {
        if (!asString(args.username).trim()) return `username is required for ${action}`;
      }
    }

    if (toolName === 'cpanel_domains') {
      try {
        this.assertCpanelAccountContextConfigured(requireString(args.profile, 'profile'), asString(args.account));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'add_subdomain' || action === 'delete_subdomain') && !asString(args.domain).trim()) {
        return `domain is required for ${action}`;
      }
      if ((action === 'add_subdomain' || action === 'delete_subdomain') && !asString(args.rootDomain).trim()) {
        return `rootDomain is required for ${action}`;
      }
      if (action === 'add_redirect') {
        if (!asString(args.domain).trim()) return 'domain is required for add_redirect';
        if (!asString(args.destination).trim()) return 'destination is required for add_redirect';
      }
      if (action === 'delete_redirect' && !asString(args.redirectId).trim()) {
        return 'redirectId is required for delete_redirect';
      }
    }

    if (toolName === 'cpanel_dns') {
      try {
        this.assertCpanelAccountContextConfigured(requireString(args.profile, 'profile'), asString(args.account));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!asString(args.zone).trim()) return 'zone is required for cpanel_dns actions';
      if (action === 'mass_edit_zone') {
        const add = Array.isArray(args.add) ? args.add.length : 0;
        const edit = Array.isArray(args.edit) ? args.edit.length : 0;
        const remove = Array.isArray(args.remove) ? args.remove.length : 0;
        if (add + edit + remove === 0) return 'mass_edit_zone requires at least one add, edit, or remove entry';
      }
    }

    if (toolName === 'cpanel_backups') {
      try {
        this.assertCpanelAccountContextConfigured(requireString(args.profile, 'profile'), asString(args.account));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      requireString(args.action, 'action');
    }

    if (toolName === 'cpanel_ssl') {
      try {
        this.assertCpanelAccountContextConfigured(requireString(args.profile, 'profile'), asString(args.account));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (action !== 'list_certs' && !asString(args.domain).trim()) return `domain is required for ${action}`;
      if (action === 'install_ssl') {
        if (!asString(args.certificate).trim()) return 'certificate is required for install_ssl';
        if (!asString(args.privateKey).trim()) return 'privateKey is required for install_ssl';
      }
    }

    if (toolName === 'vercel_status') {
      try {
        this.getCloudVercelProfile(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }

    if (toolName === 'vercel_projects') {
      try {
        this.getCloudVercelProfile(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'get' || action === 'update' || action === 'delete') && !asString(args.project).trim()) {
        return `project is required for ${action}`;
      }
      if (action === 'create' && !asString(args.name).trim() && !isRecord(args.settings)) {
        return 'name or settings object is required for create';
      }
      if (action === 'update' && !isRecord(args.settings) && !asString(args.name).trim()) {
        return 'settings object or name is required for update';
      }
    }

    if (toolName === 'vercel_deployments') {
      try {
        this.getCloudVercelProfile(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'get' || action === 'cancel') && !asString(args.deploymentId).trim()) {
        return `deploymentId is required for ${action}`;
      }
      if (action === 'promote') {
        if (!asString(args.project).trim()) return 'project is required for promote';
        if (!asString(args.deploymentId).trim()) return 'deploymentId is required for promote';
      }
      if (action === 'create' && !isRecord(args.deployment) && !asString(args.project).trim()) {
        return 'deployment object or project is required for create';
      }
    }

    if (toolName === 'vercel_domains') {
      try {
        this.getCloudVercelProfile(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!asString(args.project).trim()) return 'project is required for vercel_domains actions';
      if ((action === 'get' || action === 'add' || action === 'update' || action === 'remove' || action === 'verify') && !asString(args.domain).trim()) {
        return `domain is required for ${action}`;
      }
    }

    if (toolName === 'vercel_env') {
      try {
        this.getCloudVercelProfile(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!asString(args.project).trim()) return 'project is required for vercel_env actions';
      if ((action === 'update' || action === 'delete') && !asString(args.envId).trim()) {
        return `envId is required for ${action}`;
      }
      if ((action === 'create' || action === 'update') && !isRecord(args.env) && !asString(args.key).trim()) {
        return `env object or key is required for ${action}`;
      }
      if ((action === 'create' || action === 'update') && !isRecord(args.env) && !asString(args.value).trim()) {
        return `value is required for ${action}`;
      }
    }

    if (toolName === 'vercel_logs') {
      try {
        this.getCloudVercelProfile(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (action === 'runtime') {
        if (!asString(args.project).trim()) return 'project is required for runtime logs';
        if (!asString(args.deploymentId).trim()) return 'deploymentId is required for runtime logs';
      } else if (action === 'events') {
        if (!asString(args.deploymentId).trim()) return 'deploymentId is required for deployment events';
      }
    }

    if (toolName === 'cf_status') {
      try {
        this.getCloudflareProfile(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }

    if (toolName === 'cf_dns') {
      try {
        this.getCloudflareProfile(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'get' || action === 'update' || action === 'delete') && !asString(args.recordId).trim()) {
        return `recordId is required for ${action}`;
      }
      if ((action === 'create' || action === 'update') && !isRecord(args.record)) {
        if (!asString(args.type).trim()) return `type is required for ${action}`;
        if (!asString(args.name).trim()) return `name is required for ${action}`;
        if (!asString(args.content).trim()) return `content is required for ${action}`;
      }
    }

    if (toolName === 'cf_ssl') {
      try {
        this.getCloudflareProfile(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'get_setting' || action === 'update_setting') && !asString(args.settingId).trim()) {
        return `settingId is required for ${action}`;
      }
      if (action === 'update_setting' && args.value === undefined) {
        return 'value is required for update_setting';
      }
    }

    if (toolName === 'cf_cache') {
      try {
        this.getCloudflareProfile(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (action === 'purge_files' && asStringArray(args.files).length === 0) return 'files is required for purge_files';
      if (action === 'purge_tags' && asStringArray(args.tags).length === 0) return 'tags is required for purge_tags';
      if (action === 'purge_hosts' && asStringArray(args.hosts).length === 0) return 'hosts is required for purge_hosts';
      if (action === 'purge_prefixes' && asStringArray(args.prefixes).length === 0) return 'prefixes is required for purge_prefixes';
    }

    if (toolName === 'aws_status') {
      try {
        this.getCloudAwsProfile(requireString(args.profile, 'profile'), 'sts');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }

    if (toolName === 'aws_ec2_instances') {
      try {
        this.getCloudAwsProfile(requireString(args.profile, 'profile'), 'ec2');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'start' || action === 'stop' || action === 'reboot' || action === 'describe') && asStringArray(args.instanceIds).length === 0) {
        return `instanceIds is required for ${action}`;
      }
    }

    if (toolName === 'aws_ec2_security_groups') {
      try {
        this.getCloudAwsProfile(requireString(args.profile, 'profile'), 'ec2');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'authorize_ingress' || action === 'revoke_ingress') && !asString(args.groupId).trim()) {
        return `groupId is required for ${action}`;
      }
      if ((action === 'authorize_ingress' || action === 'revoke_ingress') && !asString(args.protocol).trim()) {
        return `protocol is required for ${action}`;
      }
    }

    if (toolName === 'aws_s3_buckets') {
      try {
        this.getCloudAwsProfile(requireString(args.profile, 'profile'), 's3');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'create_bucket' || action === 'delete_bucket' || action === 'list_objects' || action === 'get_object' || action === 'put_object' || action === 'delete_object') && !asString(args.bucket).trim()) {
        return `bucket is required for ${action}`;
      }
      if ((action === 'get_object' || action === 'put_object' || action === 'delete_object') && !asString(args.key).trim()) {
        return `key is required for ${action}`;
      }
      if (action === 'put_object' && !asString(args.body).trim()) {
        return 'body is required for put_object';
      }
    }

    if (toolName === 'aws_route53') {
      try {
        this.getCloudAwsProfile(requireString(args.profile, 'profile'), 'route53');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'list_records' || action === 'change_records') && !asString(args.hostedZoneId).trim()) {
        return `hostedZoneId is required for ${action}`;
      }
      if (action === 'change_records' && !Array.isArray(args.changes) && !asString(args.changeAction).trim()) {
        return 'changes array or changeAction is required for change_records';
      }
    }

    if (toolName === 'aws_lambda') {
      try {
        this.getCloudAwsProfile(requireString(args.profile, 'profile'), 'lambda');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'get' || action === 'invoke') && !asString(args.functionName).trim()) {
        return `functionName is required for ${action}`;
      }
    }

    if (toolName === 'aws_cloudwatch') {
      try {
        this.getCloudAwsProfile(requireString(args.profile, 'profile'), 'cloudwatch');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (action === 'logs' && !asString(args.logGroupName).trim()) {
        return 'logGroupName is required for logs';
      }
    }

    if (toolName === 'aws_rds') {
      try {
        this.getCloudAwsProfile(requireString(args.profile, 'profile'), 'rds');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'start' || action === 'stop' || action === 'reboot') && !asString(args.dbInstanceIdentifier).trim()) {
        return `dbInstanceIdentifier is required for ${action}`;
      }
    }

    if (toolName === 'aws_iam') {
      try {
        this.getCloudAwsProfile(requireString(args.profile, 'profile'), 'iam');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }

    if (toolName === 'aws_costs') {
      try {
        this.getCloudAwsProfile(requireString(args.profile, 'profile'), 'costExplorer');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      if (!isRecord(args.timePeriod)) return 'timePeriod object is required for aws_costs';
    }

    if (toolName === 'gcp_status') {
      try {
        this.getCloudGcpProfile(requireString(args.profile, 'profile'), 'cloudResourceManager');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }

    if (toolName === 'gcp_compute') {
      try {
        this.getCloudGcpProfile(requireString(args.profile, 'profile'), 'compute');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'get' || action === 'start' || action === 'stop' || action === 'reset') && !asString(args.zone).trim()) {
        return `zone is required for ${action}`;
      }
      if ((action === 'get' || action === 'start' || action === 'stop' || action === 'reset') && !asString(args.instance).trim()) {
        return `instance is required for ${action}`;
      }
    }

    if (toolName === 'gcp_cloud_run') {
      try {
        this.getCloudGcpProfile(requireString(args.profile, 'profile'), 'run');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'list_services' || action === 'list_revisions' || action === 'get_service' || action === 'update_traffic' || action === 'delete_service') && !this.resolveGcpLocation(args.location, requireString(args.profile, 'profile'), false)) {
        return `location is required for ${action} when the GCP profile has no default location`;
      }
      if ((action === 'get_service' || action === 'update_traffic' || action === 'delete_service') && !asString(args.service).trim()) {
        return `service is required for ${action}`;
      }
      if (action === 'update_traffic' && !Array.isArray(args.traffic)) {
        return 'traffic array is required for update_traffic';
      }
    }

    if (toolName === 'gcp_storage') {
      try {
        this.getCloudGcpProfile(requireString(args.profile, 'profile'), 'storage');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'create_bucket' || action === 'delete_bucket' || action === 'list_objects' || action === 'get_object' || action === 'put_object' || action === 'delete_object') && !asString(args.bucket).trim()) {
        return `bucket is required for ${action}`;
      }
      if ((action === 'get_object' || action === 'put_object' || action === 'delete_object') && !asString(args.object).trim()) {
        return `object is required for ${action}`;
      }
      if (action === 'put_object' && !asString(args.body).trim()) {
        return 'body is required for put_object';
      }
    }

    if (toolName === 'gcp_dns') {
      try {
        this.getCloudGcpProfile(requireString(args.profile, 'profile'), 'dns');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'list_records' || action === 'change_records') && !asString(args.managedZone).trim()) {
        return `managedZone is required for ${action}`;
      }
      if (action === 'change_records' && !Array.isArray(args.additions) && !Array.isArray(args.deletions)) {
        return 'additions or deletions array is required for change_records';
      }
    }

    if (toolName === 'gcp_logs') {
      try {
        this.getCloudGcpProfile(requireString(args.profile, 'profile'), 'logging');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }

    if (toolName === 'azure_status') {
      try {
        this.getCloudAzureProfile(requireString(args.profile, 'profile'), 'management');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }

    if (toolName === 'azure_vms') {
      try {
        this.getCloudAzureProfile(requireString(args.profile, 'profile'), 'management');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'get' || action === 'start' || action === 'stop' || action === 'restart' || action === 'deallocate') && !this.resolveAzureResourceGroup(args.resourceGroup, requireString(args.profile, 'profile'), false)) {
        return `resourceGroup is required for ${action} when the Azure profile has no default resource group`;
      }
      if ((action === 'get' || action === 'start' || action === 'stop' || action === 'restart' || action === 'deallocate') && !asString(args.vmName).trim()) {
        return `vmName is required for ${action}`;
      }
    }

    if (toolName === 'azure_app_service') {
      try {
        this.getCloudAzureProfile(requireString(args.profile, 'profile'), 'management');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'get' || action === 'config' || action === 'restart' || action === 'delete') && !this.resolveAzureResourceGroup(args.resourceGroup, requireString(args.profile, 'profile'), false)) {
        return `resourceGroup is required for ${action} when the Azure profile has no default resource group`;
      }
      if ((action === 'get' || action === 'config' || action === 'restart' || action === 'delete') && !asString(args.name).trim()) {
        return `name is required for ${action}`;
      }
    }

    if (toolName === 'azure_storage') {
      try {
        this.getCloudAzureProfile(
          requireString(args.profile, 'profile'),
          asString(args.action).trim().toLowerCase() === 'list_accounts' ? 'management' : 'blob',
        );
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'list_containers' || action === 'create_container' || action === 'delete_container' || action === 'list_blobs' || action === 'put_blob' || action === 'delete_blob') && !asString(args.accountName).trim()) {
        return `accountName is required for ${action}`;
      }
      if ((action === 'create_container' || action === 'delete_container' || action === 'list_blobs' || action === 'put_blob' || action === 'delete_blob') && !asString(args.container).trim()) {
        return `container is required for ${action}`;
      }
      if ((action === 'put_blob' || action === 'delete_blob') && !asString(args.blobName).trim()) {
        return `blobName is required for ${action}`;
      }
      if (action === 'put_blob' && !asString(args.body).trim()) {
        return 'body is required for put_blob';
      }
    }

    if (toolName === 'azure_dns') {
      try {
        this.getCloudAzureProfile(requireString(args.profile, 'profile'), 'management');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'list_zones' || action === 'list_records' || action === 'upsert_record_set' || action === 'delete_record_set') && !this.resolveAzureResourceGroup(args.resourceGroup, requireString(args.profile, 'profile'), false)) {
        return `resourceGroup is required for ${action} when the Azure profile has no default resource group`;
      }
      if ((action === 'list_records' || action === 'upsert_record_set' || action === 'delete_record_set') && !asString(args.zoneName).trim()) {
        return `zoneName is required for ${action}`;
      }
      if ((action === 'upsert_record_set' || action === 'delete_record_set') && !asString(args.recordType).trim()) {
        return `recordType is required for ${action}`;
      }
      if ((action === 'upsert_record_set' || action === 'delete_record_set') && !asString(args.relativeRecordSetName).trim()) {
        return `relativeRecordSetName is required for ${action}`;
      }
      if (action === 'upsert_record_set' && !isRecord(args.recordSet)) {
        return 'recordSet object is required for upsert_record_set';
      }
    }

    if (toolName === 'azure_monitor') {
      try {
        this.getCloudAzureProfile(requireString(args.profile, 'profile'), 'management');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (action === 'metrics' && !asString(args.resourceId).trim()) {
        return 'resourceId is required for metrics';
      }
      if (action === 'metrics' && !asString(args.metricnames).trim()) {
        return 'metricnames is required for metrics';
      }
    }

    if (toolName === 'whm_dns') {
      try {
        this.assertWhmProfileConfigured(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (action === 'parse_zone' && !asString(args.zone).trim()) return 'zone is required for parse_zone';
      if ((action === 'create_zone' || action === 'delete_zone' || action === 'reset_zone') && !asString(args.domain).trim()) {
        return `domain is required for ${action}`;
      }
      if (action === 'create_zone' && !asString(args.ip).trim()) return 'ip is required for create_zone';
    }

    if (toolName === 'whm_ssl') {
      try {
        this.assertWhmProfileConfigured(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'check_user' || action === 'get_excluded_domains' || action === 'set_excluded_domains') && !asString(args.username).trim()) {
        return `username is required for ${action}`;
      }
      if (action === 'set_provider' && !asString(args.provider).trim()) return 'provider is required for set_provider';
    }

    if (toolName === 'whm_backup') {
      try {
        this.assertWhmProfileConfigured(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (action === 'user_list' && !asString(args.restorePoint).trim()) return 'restorePoint is required for user_list';
      if (action === 'config_set' && !isRecord(args.settings)) return 'settings object is required for config_set';
    }

    if (toolName === 'whm_services') {
      try {
        this.assertWhmProfileConfigured(requireString(args.profile, 'profile'));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if ((action === 'get_config' || action === 'restart') && !asString(args.service).trim()) {
        return `service is required for ${action}`;
      }
    }

    if (toolName === 'fs_write' || toolName === 'doc_create') {
      const content = typeof args.content === 'string' ? args.content : '';
      if (!content) {
        return null;
      }
      const contentScan = scanWriteContent(content);
      if (contentScan.secrets.length > 0) {
        const patterns = [...new Set(contentScan.secrets.map((match) => match.pattern))];
        return `Write content contains secrets: ${patterns.join(', ')}.`;
      }
      if (contentScan.pii.length > 0) {
        const patterns = [...new Set(contentScan.pii.map((match) => match.label))];
        return `Write content contains PII: ${patterns.join(', ')}.`;
      }
    }

    return null;
  }

  private getMemoryMutationIntentError(
    toolName: string,
    request?: Partial<ToolExecutionRequest>,
  ): string | null {
    if (!isMemoryMutationToolName(toolName)) {
      return null;
    }
    if (request?.origin !== 'assistant') {
      return null;
    }
    return request.allowModelMemoryMutation === true
      ? null
      : getMemoryMutationIntentDeniedMessage(toolName);
  }

  private getMemoryMutationReadOnlyError(
    args?: Record<string, unknown>,
    request?: Partial<ToolExecutionRequest>,
  ): string | null {
    const targetScope = this.normalizeMemoryMutationScope(args?.scope);
    if (targetScope === 'code_session') {
      const codeMemory = this.resolveCodeSessionMemoryContext(asString(args?.sessionId), request);
      if (!codeMemory) {
        return 'A reachable code session is required to save code-session memory.';
      }
      if (codeMemory?.store?.isReadOnly()) {
        return 'Code-session memory is read-only.';
      }
      return null;
    }
    const globalMemory = this.getGlobalMemoryContext(request);
    if (globalMemory.store?.isReadOnly()) {
      return 'Persistent memory is read-only.';
    }
    return null;
  }

  private async execute(
    job: ToolJobRecord,
    request: ToolExecutionRequest,
    args: Record<string, unknown>,
    handler: (args: Record<string, unknown>, request: ToolExecutionRequest) => Promise<ToolResult>,
  ): Promise<ToolRunResponse> {
    job.status = 'running';
    job.startedAt = this.now();

    // Dry-run mode: validate but don't execute mutating operations
    if (request.dryRun && job.risk !== 'read_only') {
      job.status = 'succeeded';
      job.completedAt = this.now();
      job.durationMs = 0;
      job.resultPreview = '[dry-run preview]';
      const preview = this.buildDryRunPreview(job.toolName, args);
      return {
        success: true,
        status: job.status,
        jobId: job.id,
        message: `[DRY RUN] Tool '${job.toolName}' validated. ${preview}`,
        output: { dryRun: true, preview, args },
      };
    }

    // Guardian Agent inline LLM evaluation — runs before tool handler on non-read actions
    if (this.options.onPreExecute && job.risk !== 'read_only') {
      try {
        const evaluation = await this.options.onPreExecute({
          type: job.risk ?? 'mutating',
          toolName: job.toolName,
          category: this.registry.get(job.toolName)?.definition.category,
          params: args,
          agentId: request.agentId ?? 'assistant-tools',
          origin: request.origin,
          scheduleId: request.scheduleId,
          channel: request.channel,
          principalId: request.principalId,
        });
      if (!evaluation.allowed) {
        job.status = 'denied';
        job.completedAt = this.now();
        job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
        job.error = `Blocked by Guardian Agent: ${evaluation.reason ?? 'action deemed too risky'}`;
        const definition = this.registry.get(job.toolName)?.definition;
        if (definition) {
          this.recordToolChainOutcome(definition, request, job.argsHash, job.status);
        }
        return {
          success: false,
          status: job.status,
            jobId: job.id,
            message: job.error,
          };
        }
      } catch (err) {
        // Guardian Agent evaluation failed — fail-closed (block action)
        job.status = 'denied';
        job.completedAt = this.now();
        job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
        job.error = `Blocked: Guardian Agent evaluation unavailable — ${err instanceof Error ? err.message : String(err)}`;
        const definition = this.registry.get(job.toolName)?.definition;
        if (definition) {
          this.recordToolChainOutcome(definition, request, job.argsHash, job.status);
        }
        return {
          success: false,
          status: job.status,
          jobId: job.id,
          message: job.error,
        };
      }
    }

    try {
      const result = await handler(args, request);
      if (!result.success) {
        const fullError = result.error ?? 'Tool failed.';
        job.status = 'failed';
        job.error = sanitizePreview(fullError);
        job.remoteExecution = extractRemoteExecutionInfo(result.output);
        if (result.output !== undefined) {
          job.resultPreview = sanitizePreview(JSON.stringify(result.output));
        }
        job.completedAt = this.now();
        job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
        const definition = this.registry.get(job.toolName)?.definition;
        if (definition) {
          this.recordToolChainOutcome(definition, request, job.argsHash, job.status);
        }
        return {
          success: false,
          status: job.status,
          jobId: job.id,
          message: fullError,
        };
      }

      job.status = 'succeeded';
      job.completedAt = this.now();
      job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
      job.resultPreview = sanitizePreview(JSON.stringify(result.output ?? {}));
      job.remoteExecution = extractRemoteExecutionInfo(result.output);
      const verification = await this.verifyExecution(job.toolName, args, result);
      job.verificationStatus = verification.status;
      job.verificationEvidence = verification.evidence;
      const successMessage = extractToolSuccessMessage(job.toolName, result.output, result.message);
      
      const successResponse: ToolRunResponse = {
        success: true,
        status: job.status,
        jobId: job.id,
        message: successMessage,
        output: result.output,
        verificationStatus: verification.status,
      };
      
      this.options.onToolExecuted?.(
        request.toolName,
        args,
        {
          success: successResponse.success,
          status: successResponse.status,
          message: successResponse.message,
          durationMs: job.durationMs,
          approvalId: job.approvalId,
        },
        request
      );
      
      return successResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      job.status = 'failed';
      job.error = sanitizePreview(message);
      job.completedAt = this.now();
      job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
      const definition = this.registry.get(job.toolName)?.definition;
      if (definition) {
        this.recordToolChainOutcome(definition, request, job.argsHash, job.status);
      }
      
      const failedResponse: ToolRunResponse = {
        success: false,
        status: job.status,
        jobId: job.id,
        message,
      };
      
      this.options.onToolExecuted?.(
        request.toolName,
        args,
        {
          success: failedResponse.success,
          status: failedResponse.status,
          message: failedResponse.message,
          error: job.error,
          durationMs: job.durationMs,
          approvalId: job.approvalId,
        },
        request
      );
      
      return failedResponse;
    }
  }

  private async verifyExecution(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): Promise<{ status: import('./types.js').VerificationStatus; evidence: string }> {
    if (result.verificationStatus) {
      return {
        status: result.verificationStatus,
        evidence: result.verificationEvidence ?? 'Tool provided explicit verification state.',
      };
    }

    switch (toolName) {
      case 'memory_save': {
        const output = isRecord(result.output) ? result.output : {};
        const memoryStore = this.options.agentMemoryStore;
        const agentId = typeof output.agentId === 'string' ? output.agentId : '';
        const entryId = typeof output.entryId === 'string' ? output.entryId : '';
        if (memoryStore && agentId && entryId) {
          return memoryStore.isEntryActive(agentId, entryId)
            ? { status: 'verified', evidence: `Memory entry ${entryId} is active.` }
            : { status: 'unverified', evidence: `Memory entry ${entryId} is not active.` };
        }
        return { status: 'unverified', evidence: 'Memory entry identity missing from tool output.' };
      }
      case 'automation_save': {
        const automationId = typeof args.id === 'string' ? args.id.trim() : '';
        const automation = automationId
          ? this.automationControlPlane?.listAutomations().find((entry) => entry.id === automationId)
          : undefined;
        if (automation) {
          return { status: 'verified', evidence: `Automation ${automation.id} exists.` };
        }
        const output = isRecord(result.output) ? result.output : {};
        const savedId = asString(output.automationId).trim();
        if (savedId && this.automationControlPlane?.listAutomations().some((entry) => entry.id === savedId)) {
          return { status: 'verified', evidence: `Automation ${savedId} exists.` };
        }
        return { status: 'unverified', evidence: 'Automation was not found after save.' };
      }
      default:
        return { status: 'unverified', evidence: 'No verifier is defined for this tool.' };
    }
  }

  private buildDryRunPreview(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case 'fs_write':
        return `Would ${args.append ? 'append to' : 'write'} file '${args.path}' (${String(args.content ?? '').length} chars)`;
      case 'doc_create':
        return `Would create document '${args.filename}'`;
      case 'run_command':
        return `Would execute: ${args.command}`;
      case 'http_fetch':
        return `Would fetch URL: ${args.url}`;
      case 'web_search':
        return `Would search the web for: "${args.query}" (provider: ${args.provider || 'auto'})`;
      case 'web_fetch':
        return `Would fetch and extract content from: ${args.url}`;
      case 'forum_post':
        return `Would post to forum thread '${args.threadId}'`;
      case 'intel_action':
        return `Would perform intel action '${args.action}' on finding '${args.findingId}'`;
      case 'performance_profile_apply':
        return `Would apply performance profile '${args.profileId}'`;
      case 'performance_action_run': {
        const previewId = asString(args.previewId).trim();
        const actionId = asString(args.actionId, 'cleanup').trim() || 'cleanup';
        if (previewId) {
          const processCount = asStringArray(args.selectedProcessTargetIds).length;
          const cleanupCount = asStringArray(args.selectedCleanupTargetIds).length;
          return `Would run performance action '${actionId}' from preview '${previewId}' on ${processCount + cleanupCount} selected target(s)`;
        }
        const selectionMode = asString(args.selectionMode, 'checked_by_default').trim().toLowerCase() || 'checked_by_default';
        return `Would run performance action '${actionId}' using ${describePerformanceSelectionMode(selectionMode)}`;
      }
      case 'whm_accounts': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'create') {
          return `Would create WHM account '${args.username}' for domain '${args.domain}'`;
        }
        if (action === 'suspend' || action === 'unsuspend' || action === 'modify' || action === 'remove') {
          return `Would ${action} WHM account '${args.username}'`;
        }
        return `Would list WHM accounts for profile '${args.profile}'`;
      }
      case 'cpanel_domains': {
        const action = asString(args.action).trim().toLowerCase();
        if (action === 'add_subdomain') {
          return `Would add subdomain '${args.domain}' under '${args.rootDomain}'`;
        }
        if (action === 'delete_subdomain') {
          return `Would delete subdomain '${args.domain}' under '${args.rootDomain}'`;
        }
        if (action === 'add_redirect') {
          return `Would add redirect for '${args.domain}' to '${args.destination}'`;
        }
        if (action === 'delete_redirect') {
          return `Would delete redirect '${args.redirectId}'`;
        }
        return `Would inspect domains for profile '${args.profile}'`;
      }
      case 'cpanel_dns': {
        const action = asString(args.action).trim().toLowerCase();
        if (action === 'mass_edit_zone') {
          return `Would apply DNS changes to zone '${args.zone}'`;
        }
        return `Would parse DNS zone '${args.zone}'`;
      }
      case 'cpanel_backups':
        return asString(args.action, 'list').trim().toLowerCase() === 'create'
          ? `Would create a full backup for profile '${args.profile}'`
          : `Would list backups for profile '${args.profile}'`;
      case 'cpanel_ssl': {
        const action = asString(args.action).trim().toLowerCase();
        if (action === 'install_ssl') return `Would install SSL for '${args.domain}'`;
        if (action === 'delete_ssl') return `Would delete SSL for '${args.domain}'`;
        if (action === 'fetch_best_for_domain') return `Would inspect best SSL certificate for '${args.domain}'`;
        return `Would list SSL certificates for profile '${args.profile}'`;
      }
      case 'vercel_status':
        return `Would summarize Vercel account status for profile '${args.profile}'`;
      case 'vercel_projects': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'create') return `Would create Vercel project '${args.name ?? '(from settings)'}'`;
        if (action === 'update') return `Would update Vercel project '${args.project}'`;
        if (action === 'delete') return `Would delete Vercel project '${args.project}'`;
        if (action === 'get') return `Would inspect Vercel project '${args.project}'`;
        return `Would list Vercel projects for profile '${args.profile}'`;
      }
      case 'vercel_deployments': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'create') return `Would create a Vercel deployment for project '${args.project ?? '(from deployment payload)'}'`;
        if (action === 'cancel') return `Would cancel Vercel deployment '${args.deploymentId}'`;
        if (action === 'promote') return `Would promote deployment '${args.deploymentId}' for project '${args.project}'`;
        if (action === 'get') return `Would inspect Vercel deployment '${args.deploymentId}'`;
        return `Would list Vercel deployments for profile '${args.profile}'`;
      }
      case 'vercel_domains': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'add') return `Would add Vercel domain '${args.domain}' to project '${args.project}'`;
        if (action === 'update') return `Would update Vercel domain '${args.domain}' on project '${args.project}'`;
        if (action === 'remove') return `Would remove Vercel domain '${args.domain}' from project '${args.project}'`;
        if (action === 'verify') return `Would verify Vercel domain '${args.domain}' on project '${args.project}'`;
        if (action === 'get') return `Would inspect Vercel domain '${args.domain}' on project '${args.project}'`;
        return `Would list Vercel domains for project '${args.project}'`;
      }
      case 'vercel_env': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'create') return `Would create Vercel env '${args.key ?? '(from env payload)'}' on project '${args.project}'`;
        if (action === 'update') return `Would update Vercel env '${args.envId}' on project '${args.project}'`;
        if (action === 'delete') return `Would delete Vercel env '${args.envId}' on project '${args.project}'`;
        return `Would list Vercel env vars for project '${args.project}'`;
      }
      case 'vercel_logs':
        return asString(args.action, 'runtime').trim().toLowerCase() === 'events'
          ? `Would fetch Vercel deployment events for '${args.deploymentId}'`
          : `Would fetch Vercel runtime logs for deployment '${args.deploymentId}'`;
      case 'cf_status':
        return `Would summarize Cloudflare zones for profile '${args.profile}'`;
      case 'cf_dns': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'create') return `Would create Cloudflare DNS record '${args.type} ${args.name}'`;
        if (action === 'update') return `Would update Cloudflare DNS record '${args.recordId}'`;
        if (action === 'delete') return `Would delete Cloudflare DNS record '${args.recordId}'`;
        if (action === 'get') return `Would inspect Cloudflare DNS record '${args.recordId}'`;
        return `Would list Cloudflare DNS records for zone '${args.zoneId ?? args.zone ?? '(default)'}'`;
      }
      case 'cf_ssl': {
        const action = asString(args.action, 'list_settings').trim().toLowerCase();
        if (action === 'update_setting') return `Would set Cloudflare SSL setting '${args.settingId}'`;
        if (action === 'get_setting') return `Would inspect Cloudflare SSL setting '${args.settingId}'`;
        return `Would list Cloudflare SSL settings for zone '${args.zoneId ?? args.zone ?? '(default)'}'`;
      }
      case 'cf_cache': {
        const action = asString(args.action, 'purge_everything').trim().toLowerCase();
        if (action === 'purge_files') return `Would purge ${asStringArray(args.files).length} Cloudflare cached file URLs for zone '${args.zoneId ?? args.zone ?? '(default)'}'`;
        if (action === 'purge_tags') return `Would purge Cloudflare cache tags for zone '${args.zoneId ?? args.zone ?? '(default)'}'`;
        if (action === 'purge_hosts') return `Would purge Cloudflare cache hosts for zone '${args.zoneId ?? args.zone ?? '(default)'}'`;
        if (action === 'purge_prefixes') return `Would purge Cloudflare cache prefixes for zone '${args.zoneId ?? args.zone ?? '(default)'}'`;
        return `Would purge all Cloudflare cache for zone '${args.zoneId ?? args.zone ?? '(default)'}'`;
      }
      case 'aws_status':
        return `Would inspect AWS account status for profile '${args.profile}'`;
      case 'aws_ec2_instances': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'start' || action === 'stop' || action === 'reboot') return `Would ${action} EC2 instances '${asStringArray(args.instanceIds).join(', ')}'`;
        if (action === 'describe') return `Would describe EC2 instances '${asStringArray(args.instanceIds).join(', ')}'`;
        return `Would list EC2 instances for profile '${args.profile}'`;
      }
      case 'aws_ec2_security_groups': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'authorize_ingress' || action === 'revoke_ingress') return `Would ${action} on security group '${args.groupId}'`;
        return `Would list EC2 security groups for profile '${args.profile}'`;
      }
      case 'aws_s3_buckets': {
        const action = asString(args.action, 'list_buckets').trim().toLowerCase();
        if (action === 'create_bucket') return `Would create S3 bucket '${args.bucket}'`;
        if (action === 'delete_bucket') return `Would delete S3 bucket '${args.bucket}'`;
        if (action === 'put_object') return `Would put S3 object '${args.key}' in bucket '${args.bucket}'`;
        if (action === 'delete_object') return `Would delete S3 object '${args.key}' in bucket '${args.bucket}'`;
        if (action === 'get_object') return `Would fetch S3 object '${args.key}' from bucket '${args.bucket}'`;
        if (action === 'list_objects') return `Would list S3 objects in bucket '${args.bucket}'`;
        return `Would list S3 buckets for profile '${args.profile}'`;
      }
      case 'aws_route53': {
        const action = asString(args.action, 'list_zones').trim().toLowerCase();
        if (action === 'change_records') return `Would change Route53 records in hosted zone '${args.hostedZoneId}'`;
        if (action === 'list_records') return `Would list Route53 records in hosted zone '${args.hostedZoneId}'`;
        return `Would list Route53 hosted zones for profile '${args.profile}'`;
      }
      case 'aws_lambda': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'invoke') return `Would invoke Lambda function '${args.functionName}'`;
        if (action === 'get') return `Would inspect Lambda function '${args.functionName}'`;
        return `Would list Lambda functions for profile '${args.profile}'`;
      }
      case 'aws_cloudwatch': {
        const action = asString(args.action, 'metrics').trim().toLowerCase();
        if (action === 'logs') return `Would fetch CloudWatch logs for '${args.logGroupName}'`;
        if (action === 'alarms') return `Would list CloudWatch alarms for profile '${args.profile}'`;
        return `Would list CloudWatch metrics for profile '${args.profile}'`;
      }
      case 'aws_rds': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'start' || action === 'stop' || action === 'reboot') return `Would ${action} RDS instance '${args.dbInstanceIdentifier}'`;
        return `Would list RDS instances for profile '${args.profile}'`;
      }
      case 'aws_iam': {
        const action = asString(args.action, 'list_users').trim().toLowerCase();
        return `Would run AWS IAM action '${action}' for profile '${args.profile}'`;
      }
      case 'aws_costs':
        return `Would query AWS cost and usage for profile '${args.profile}'`;
      case 'gcp_status':
        return `Would inspect GCP project status for profile '${args.profile}'`;
      case 'gcp_compute': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'start' || action === 'stop' || action === 'reset') return `Would ${action} GCE instance '${args.instance}' in zone '${args.zone}'`;
        if (action === 'get') return `Would inspect GCE instance '${args.instance}' in zone '${args.zone}'`;
        return `Would list GCE instances for profile '${args.profile}'`;
      }
      case 'gcp_cloud_run': {
        const action = asString(args.action, 'list_services').trim().toLowerCase();
        if (action === 'get_service') return `Would inspect Cloud Run service '${args.service}'`;
        if (action === 'update_traffic') return `Would update Cloud Run traffic for service '${args.service}'`;
        if (action === 'delete_service') return `Would delete Cloud Run service '${args.service}'`;
        if (action === 'list_revisions') return `Would list Cloud Run revisions in location '${args.location ?? '(profile default)'}'`;
        return `Would list Cloud Run services in location '${args.location ?? '(profile default)'}'`;
      }
      case 'gcp_storage': {
        const action = asString(args.action, 'list_buckets').trim().toLowerCase();
        if (action === 'create_bucket') return `Would create GCS bucket '${args.bucket}'`;
        if (action === 'delete_bucket') return `Would delete GCS bucket '${args.bucket}'`;
        if (action === 'put_object') return `Would put GCS object '${args.object}' in bucket '${args.bucket}'`;
        if (action === 'delete_object') return `Would delete GCS object '${args.object}' from bucket '${args.bucket}'`;
        if (action === 'get_object') return `Would fetch GCS object '${args.object}' from bucket '${args.bucket}'`;
        if (action === 'list_objects') return `Would list GCS objects in bucket '${args.bucket}'`;
        return `Would list GCS buckets for profile '${args.profile}'`;
      }
      case 'gcp_dns': {
        const action = asString(args.action, 'list_zones').trim().toLowerCase();
        if (action === 'change_records') return `Would change Cloud DNS records in managed zone '${args.managedZone}'`;
        if (action === 'list_records') return `Would list Cloud DNS records in managed zone '${args.managedZone}'`;
        return `Would list Cloud DNS managed zones for profile '${args.profile}'`;
      }
      case 'gcp_logs':
        return `Would query Cloud Logging entries for profile '${args.profile}'`;
      case 'azure_status':
        return `Would inspect Azure subscription status for profile '${args.profile}'`;
      case 'azure_vms': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'start' || action === 'stop' || action === 'restart' || action === 'deallocate') return `Would ${action} Azure VM '${args.vmName}'`;
        if (action === 'get') return `Would inspect Azure VM '${args.vmName}'`;
        return `Would list Azure VMs for profile '${args.profile}'`;
      }
      case 'azure_app_service': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'delete') return `Would delete Azure Web App '${args.name}'`;
        if (action === 'restart') return `Would restart Azure Web App '${args.name}'`;
        if (action === 'config') return `Would inspect Azure Web App config for '${args.name}'`;
        if (action === 'get') return `Would inspect Azure Web App '${args.name}'`;
        return `Would list Azure Web Apps for profile '${args.profile}'`;
      }
      case 'azure_storage': {
        const action = asString(args.action, 'list_accounts').trim().toLowerCase();
        if (action === 'create_container') return `Would create Azure blob container '${args.container}' in account '${args.accountName}'`;
        if (action === 'delete_container') return `Would delete Azure blob container '${args.container}' in account '${args.accountName}'`;
        if (action === 'put_blob') return `Would upload blob '${args.blobName}' to container '${args.container}'`;
        if (action === 'delete_blob') return `Would delete blob '${args.blobName}' from container '${args.container}'`;
        if (action === 'list_blobs') return `Would list blobs in container '${args.container}'`;
        if (action === 'list_containers') return `Would list containers for storage account '${args.accountName}'`;
        return `Would list Azure storage accounts for profile '${args.profile}'`;
      }
      case 'azure_dns': {
        const action = asString(args.action, 'list_zones').trim().toLowerCase();
        if (action === 'upsert_record_set') return `Would upsert Azure DNS record set '${args.relativeRecordSetName}'`;
        if (action === 'delete_record_set') return `Would delete Azure DNS record set '${args.relativeRecordSetName}'`;
        if (action === 'list_records') return `Would list Azure DNS records for zone '${args.zoneName}'`;
        return `Would list Azure DNS zones for profile '${args.profile}'`;
      }
      case 'azure_monitor': {
        const action = asString(args.action, 'activity_logs').trim().toLowerCase();
        if (action === 'metrics') return `Would fetch Azure Monitor metrics for resource '${args.resourceId}'`;
        return `Would list Azure activity logs for profile '${args.profile}'`;
      }
      case 'whm_dns': {
        const action = asString(args.action, 'list').trim().toLowerCase();
        if (action === 'create_zone') return `Would create WHM DNS zone '${args.domain}'`;
        if (action === 'delete_zone') return `Would delete WHM DNS zone '${args.domain}'`;
        if (action === 'reset_zone') return `Would reset WHM DNS zone '${args.domain}'`;
        if (action === 'parse_zone') return `Would parse WHM DNS zone '${args.zone}'`;
        return `Would list WHM DNS zones for profile '${args.profile}'`;
      }
      case 'whm_ssl': {
        const action = asString(args.action).trim().toLowerCase();
        if (action === 'set_provider') return `Would set WHM AutoSSL provider to '${args.provider}'`;
        if (action === 'check_user') return `Would start AutoSSL check for '${args.username}'`;
        if (action === 'check_all') return 'Would start AutoSSL checks for all users';
        if (action === 'set_excluded_domains') return `Would update AutoSSL excluded domains for '${args.username}'`;
        if (action === 'get_excluded_domains') return `Would list AutoSSL excluded domains for '${args.username}'`;
        return `Would list WHM AutoSSL providers for profile '${args.profile}'`;
      }
      case 'whm_backup': {
        const action = asString(args.action).trim().toLowerCase();
        if (action === 'config_set') return `Would update WHM backup configuration for profile '${args.profile}'`;
        if (action === 'toggle_all') return `Would set WHM backup skip-all=${!!args.state} for version '${args.backupVersion ?? 'backup'}'`;
        if (action === 'user_list') return `Would list backup users for restore point '${args.restorePoint}'`;
        return `Would inspect WHM backup state with action '${action}'`;
      }
      case 'whm_services': {
        const action = asString(args.action).trim().toLowerCase();
        if (action === 'restart') return `Would restart WHM service '${args.service}'`;
        if (action === 'get_config') return `Would fetch WHM service config for '${args.service}'`;
        return `Would inspect WHM service status for profile '${args.profile}'`;
      }
      default:
        return `Would execute tool '${toolName}' with args: ${sanitizePreview(JSON.stringify(args))}`;
    }
  }

  private registerBuiltinTools(): void {
    // ── find_tools meta-tool (always loaded) ──
    this.registry.register(
      {
        name: 'find_tools',
        description: 'Search available tools by keyword. Returns matching tool names and schemas so you can call them. IMPORTANT: Most tools are not visible until you search for them. If a user asks you to use a specific tool by name, or you need a tool that is not in your current list, you MUST call find_tools first to load it.',
        shortDescription: 'Search and load tools by keyword. IMPORTANT: call this first to discover tools not in your current list.',
        risk: 'read_only',
        category: 'system',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keywords (e.g. "network scan", "file write", "email").' },
            maxResults: { type: 'number', description: 'Maximum tools to return (default: 10).' },
          },
          required: ['query'],
        },
        examples: [
          { input: { query: 'network scan' }, description: 'Find network scanning tools' },
          { input: { query: 'file write create' }, description: 'Find tools for creating/writing files' },
          { input: { query: 'email gmail send' }, description: 'Find email-related tools' },
        ],
      },
      async (args) => {
        const query = (args.query as string)?.trim();
        if (!query) return { success: false, error: 'query is required' };
        const maxResults = Math.min(20, Math.max(1, (args.maxResults as number) || 10));
        const matches = this.searchTools(query, maxResults);
        return {
          success: true,
          output: {
            query,
            matchCount: matches.length,
            tools: matches.map((def) => ({
              name: def.name,
              description: def.shortDescription ?? def.description,
              category: def.category,
              risk: def.risk,
              parameters: def.parameters,
              examples: def.examples,
            })),
          },
        };
      },
    );

    registerBuiltinFilesystemTools({
      registry: this.registry,
      requireString,
      requireStringAllowEmpty,
      asString,
      asNumber,
      guardAction: (request, action, details) => this.guardAction(request, action, details),
      resolveAllowedPath: (inputPath, request) => this.resolveAllowedPath(inputPath, request),
      maxSearchResults: MAX_SEARCH_RESULTS,
      maxSearchFiles: MAX_SEARCH_FILES,
      maxSearchFileBytes: MAX_SEARCH_FILE_BYTES,
      maxReadBytes: MAX_READ_BYTES,
    });

    registerBuiltinCodingTools({
      registry: this.registry,
      requireString,
      requireStringAllowEmpty,
      asString,
      asNumber,
      isRecord,
      guardAction: (request, action, details) => this.guardAction(request, action, details),
      resolveAllowedPath: (inputPath, request) => this.resolveAllowedPath(inputPath, request),
      getEffectiveWorkspaceRoot: (request) => this.getEffectiveWorkspaceRoot(request),
      getCodeWorkspaceRoot: (request) => this.getCodeWorkspaceRoot(request),
      buildCodeShellEnv: (workspaceRoot) => this.buildCodeShellEnv(workspaceRoot),
      validateShellCommandForRequest: (command, request, cwd) => this.validateShellCommandForRequest(command, request, cwd),
      getDegradedPackageManagerBlockReason: (command) => this.getDegradedPackageManagerBlockReason(command),
      finalizeShellCommandPlan: (plan, cwd, env) => this.finalizeShellCommandPlan(plan, cwd, env),
      prepareJsDependencyTracking: (commands, cwd, request) => this.prepareJsDependencyTracking(commands, cwd, request),
      finalizeJsDependencyTracking: (tracking, command) => this.finalizeJsDependencyTracking(tracking, command),
      sandboxExec: (command, profile, opts) => this.sandboxExec(command, profile, opts),
      sandboxExecFile: (file, argv, profile, opts) => this.sandboxExecFile(file, argv, profile, opts),
      packageInstallTrust: this.options.packageInstallTrust,
      codeSessionStore: this.options.codeSessionStore,
      codingBackendService: this.options.codingBackendService,
      getCodingBackendService: () => this.options.codingBackendService,
      listOwnedCodeSessions: (request) => this.listOwnedCodeSessions(request),
      summarizeCodeSession: (session) => this.summarizeCodeSession(session),
      getCodeSessionSurfaceId: (request) => this.getCodeSessionSurfaceId(request),
      resolveOwnedCodeSessionTarget: (target, request) => this.resolveOwnedCodeSessionTarget(target, request),
      getCurrentCodeSessionRecord: (request) => this.getCurrentCodeSessionRecord(request),
      getRemoteExecutionTargets: () => this.getRemoteExecutionTargets(),
      cloudConfig: this.cloudConfig,
      resolveRemoteExecutionTarget: (profileId) => this.resolveRemoteExecutionTarget(profileId),
      runRemoteExecutionJob: async (input) => {
        const req = input.request;
        const requestId = req?.requestId ?? 'unknown';
        const codeSessionId = req?.codeContext?.sessionId;
        const cbService = this.options.codingBackendService;
        return this.runRemoteExecutionJob({
          ...input,
          onProgress: cbService && codeSessionId ? (message) => {
            cbService.recordExternalProgress(requestId, codeSessionId, 'Remote Sandbox', input.command.requestedCommand, message);
          } : undefined,
        });
      },
    });

    registerBuiltinWebTools({
      registry: this.registry,
      requireString,
      asNumber,
      asString,
      normalizeHttpUrlLikeInput,
      stripHtml,
      extractReadableContent,
      isHostAllowed: (host) => this.isHostAllowed(host),
      guardAction: (request, action, details) => this.guardAction(request, action, details),
      resolveSearchProvider: (value) => this.resolveSearchProvider(value),
      assertWebSearchHostsAllowed: (provider) => this.assertWebSearchHostsAllowed(provider),
      searchCache: this.searchCache,
      webSearchConfig: this.webSearchConfig,
      getWebSearchConfig: () => this.webSearchConfig,
      defaultSearchCacheTtlMs: SEARCH_CACHE_TTL_MS,
      now: () => this.now(),
      searchBrave: (query, maxResults) => this.searchBrave(query, maxResults),
      searchPerplexity: (query, maxResults) => this.searchPerplexity(query, maxResults),
      searchDuckDuckGo: (query, maxResults) => this.searchDuckDuckGo(query, maxResults),
      maxFetchBytes: MAX_FETCH_BYTES,
      maxWebFetchChars: MAX_WEB_FETCH_CHARS,
    });

    registerBuiltinContactsEmailTools({
      registry: this.registry,
      marketingStore: this.marketingStore,
      requireString,
      asNumber,
      asString,
      asStringArray,
      isHostAllowed: (host) => this.isHostAllowed(host),
      guardAction: (request, action, details) => this.guardAction(request, action, details),
      resolveAllowedPath: (inputPath, request) => this.resolveAllowedPath(inputPath, request),
      getGoogleService: () => this.options.googleService,
      assertGmailHostAllowed: () => this.assertGmailHostAllowed(),
      maxFetchBytes: MAX_FETCH_BYTES,
      maxCampaignRecipients: MAX_CAMPAIGN_RECIPIENTS,
    });

    registerBuiltinSecurityIntelTools({
      registry: this.registry,
      requireString,
      asString,
      asStringArray,
      asNumber,
      guardAction: (request, action, details) => this.guardAction(request, action, details),
      isHostAllowed: (host) => this.isHostAllowed(host),
      threatIntel: this.options.threatIntel,
      assistantSecurity: this.options.assistantSecurity,
      runAssistantSecurityScan: this.options.runAssistantSecurityScan,
      allowExternalPosting: this.options.allowExternalPosting,
      hostMonitor: this.options.hostMonitor,
      runHostMonitorCheck: this.options.runHostMonitorCheck,
      gatewayMonitor: this.options.gatewayMonitor,
      runGatewayMonitorCheck: this.options.runGatewayMonitorCheck,
      windowsDefender: this.options.windowsDefender,
      networkBaseline: this.options.networkBaseline,
      packageInstallTrust: this.options.packageInstallTrust,
      containmentService: this.options.containmentService,
    });

    registerBuiltinNetworkSystemTools({
      registry: this.registry,
      requireString,
      asString,
      asNumber,
      guardAction: (request, action, details) => this.guardAction(request, action, details),
      sandboxExec: (command, profile, opts) => this.sandboxExec(command, profile, opts),
      networkConfig: this.networkConfig,
      deviceInventory: this.options.deviceInventory,
      networkBaseline: this.options.networkBaseline,
      networkTraffic: this.options.networkTraffic,
    });

    registerBuiltinPerformanceTools({
      registry: this.registry,
      requireString,
      asString,
      asStringArray,
      getPerformanceService: () => this.options.performanceService,
    });

    registerBuiltinCloudTools({
      registry: this.registry,
      requireString,
      asString,
      asNumber,
      asStringArray,
      guardAction: (request, action, details) => this.guardAction(request, action, details),
      createWhmClient: (profileId) => this.createWhmClient(profileId),
      resolveCpanelAccountContext: (profileId, requestedAccount) => this.resolveCpanelAccountContext(profileId, requestedAccount),
      createVercelClient: (profileId) => this.createVercelClient(profileId),
      createCloudflareClient: (profileId) => this.createCloudflareClient(profileId),
      createAwsClient: (profileId, service) => this.createAwsClient(profileId, service),
      createGcpClient: (profileId, service) => this.createGcpClient(profileId, service),
      createAzureClient: (profileId, service) => this.createAzureClient(profileId, service),
      describeCloudEndpoint: (profile) => this.describeCloudEndpoint(profile),
      describeVercelEndpoint: (profile) => this.describeVercelEndpoint(profile),
      describeCloudflareEndpoint: (profile) => this.describeCloudflareEndpoint(profile),
      describeAwsEndpoint: (profile, service) => this.describeAwsEndpoint(profile, service),
      describeGcpEndpoint: (profile, service) => this.describeGcpEndpoint(profile, service),
      describeAzureEndpoint: (profile, service, accountName) => this.describeAzureEndpoint(profile, service, accountName),
      resolveGcpLocation: (value, profileId, throwOnMissing) => this.resolveGcpLocation(value, profileId, throwOnMissing),
      resolveAzureResourceGroup: (value, profileId, throwOnMissing) => this.resolveAzureResourceGroup(value, profileId, throwOnMissing),
    });

    registerBuiltinMemoryTools({
      registry: this.registry,
      asString,
      asNumber,
      guardAction: (request, action, details) => this.guardAction(request, action, details),
      conversationService: this.options.conversationService,
      resolveStateAgentId: this.options.resolveStateAgentId,
      normalizeMemorySearchScope: (input) => this.normalizeMemorySearchScope(input),
      normalizePersistentMemoryScope: (input, request, fallbackScope) => this.normalizePersistentMemoryScope(input, request, fallbackScope),
      normalizeMemoryMutationScope: (input) => this.normalizeMemoryMutationScope(input),
      resolvePersistentMemoryContexts: (targetScope, sessionId, request, explicitGlobalAgentId) => this.resolvePersistentMemoryContexts(targetScope, sessionId, request, explicitGlobalAgentId),
      searchPersistentMemoryEntries: (store, targetId, query, limit) => this.searchPersistentMemoryEntries(store, targetId, query, limit),
      fuseRankedMemorySearchResults: (sources, limit) => this.fuseRankedMemorySearchResults(sources, limit),
      getGlobalMemoryContext: (request, explicitAgentId) => this.getGlobalMemoryContext(request, explicitAgentId),
      resolveCodeSessionMemoryContext: (sessionId, request) => this.resolveCodeSessionMemoryContext(sessionId, request),
      getMemoryMutationReadOnlyError: (args, request) => this.getMemoryMutationReadOnlyError(args, request),
      persistMemoryEntry: this.options.persistMemoryEntry,
    });

    registerBuiltinSearchTools({
      registry: this.registry,
      getDocSearch: () => this.options.docSearch,
      asString,
      asNumber,
    });

    registerBuiltinSecondBrainTools({
      registry: this.registry,
      getService: () => this.options.secondBrainService,
      getBriefingService: () => this.options.secondBrainBriefingService,
      getHorizonScanner: () => this.options.secondBrainHorizonScanner,
      asString,
      asNumber,
      guardAction: (request, action, details) => this.guardAction(request, action, details),
    });

    registerBuiltinWorkspaceTools({
      registry: this.registry,
      requireString,
      asString,
      asNumber,
      guardAction: (request, action, details) => this.guardAction(request, action, details),
      getGoogleService: () => this.options.googleService,
      getMicrosoftService: () => this.options.microsoftService,
    });

    registerBuiltinAutomationTools({
      registry: this.registry,
      requireString,
      requireBoolean,
      asString,
      asNumber,
      isRecord,
      guardAction: (request, action, details) => this.guardAction(request, action, details),
      getAutomationControlPlane: () => this.automationControlPlane,
      getAutomationOutputStore: () => this.options.automationOutputStore,
      hasTool: (toolName) => Boolean(this.registry.get(toolName)),
    });

    registerBuiltinPolicyTools({
      registry: this.registry,
      requireString,
      agentPolicyUpdates: this.options.agentPolicyUpdates,
      getPolicy: () => this.getPolicy(),
      updatePolicy: (update) => this.updatePolicy(update),
      persistPolicyUpdate: (policy, meta) => this.options.onPolicyUpdate?.(policy, meta),
      isCodeWorkspacePolicyNoOp: (action, value, request) => this.isCodeWorkspacePolicyNoOp({ name: 'update_tool_policy' } as ToolDefinition, { action, value }, request),
      isPathAlreadyAllowedForPolicy: (value, request) => this.isPathAlreadyAllowedForPolicy(value, request),
      isCommandAlreadyAllowedForPolicy: (value) => this.isCommandAlreadyAllowedForPolicy(value),
      isDomainAllowedByList: (value, allowedDomains) => this.isDomainAllowedByList(value, allowedDomains),
      canonicalizePolicyPathValue: (value, request) => this.getCanonicalPolicyPathValue(value, request),
      getEffectiveAllowedPaths: (request) => this.getEffectiveAllowedPaths(request),
      getExplicitBrowserAllowedDomains: () => this.getExplicitBrowserAllowedDomains(),
      setExplicitBrowserAllowedDomains: (domains) => {
        this.options.browserConfig = {
          ...(this.options.browserConfig ?? { enabled: true }),
          allowedDomains: domains,
        };
      },
    });

    registerBuiltinProviderTools({
      registry: this.registry,
      requireString,
      listProviders: this.options.listLlmProviders,
      listModelsForProvider: this.options.listModelsForLlmProvider,
      updateConfig: this.options.onLlmProviderConfigUpdate,
    });
  }

  private assertGmailHostAllowed(): void {
    const host = 'gmail.googleapis.com';
    if (!this.isHostAllowed(host)) {
      throw new Error(`Host '${host}' is not in allowedDomains. Add it in tools policy before sending.`);
    }
  }

  private async resolveAllowedPath(inputPath: string, request?: Partial<ToolExecutionRequest>): Promise<string> {
    const normalizedInput = normalizePathForHost(inputPath);
    let candidate = isAbsolute(normalizedInput)
      ? resolve(normalizedInput)
      : resolve(this.getEffectiveWorkspaceRoot(request), normalizedInput);
    // Resolve symlinks to prevent traversal via symlink to sensitive paths
    try {
      candidate = await realpath(candidate);
    } catch {
      // Path may not exist yet (e.g. write_file creating new file) — use resolved path
    }
    const roots = await Promise.all(
      uniqueNonEmpty(this.getEffectiveAllowedPaths(request))
        .map(async (root) => {
          const resolvedRoot = resolve(normalizePathForHost(root));
          try {
            return await realpath(resolvedRoot);
          } catch {
            return resolvedRoot;
          }
        }),
    );
    const allowed = roots.some((root) => isPathInside(candidate, root));
    if (!allowed) {
      const preview = roots.slice(0, 4).join(', ') || '(none)';
      throw new Error(
        `Path '${inputPath}' is outside allowed paths. Allowed roots: ${preview}. ` +
        'Use the update_tool_policy tool to add the path, or update manually via Tools policy > Allowed Paths (web) / /tools policy paths (CLI).',
      );
    }
    return candidate;
  }

  // ── Search provider helpers ───────────────────────────────────

  private resolveSearchProvider(requested: string): 'duckduckgo' | 'brave' | 'perplexity' {
    if (requested === 'brave') return 'brave';
    if (requested === 'perplexity') return 'perplexity';
    if (requested === 'duckduckgo') return 'duckduckgo';
    // Auto: prefer Brave (one API key covers search + free summarizer) > Perplexity > DuckDuckGo.
    // Keys come from config (with ${ENV_VAR} interpolation) — same as LLM API keys.
    const cfg = this.webSearchConfig;
    if (cfg.braveApiKey) return 'brave';
    if (cfg.perplexityApiKey || cfg.openRouterApiKey) return 'perplexity';
    return 'duckduckgo';
  }

  private async searchDuckDuckGo(
    query: string,
    maxResults: number,
  ): Promise<{ query: string; provider: 'duckduckgo'; results: Array<{ title: string; url: string; snippet: string }> }> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'GuardianAgent-Tools/1.0',
          'Accept': 'text/html',
        },
      });
      const html = await response.text();
      const results = parseDuckDuckGoResults(html, maxResults);
      return { query, provider: 'duckduckgo', results };
    } finally {
      clearTimeout(timer);
    }
  }

  private async searchBrave(
    query: string,
    maxResults: number,
  ): Promise<{ query: string; provider: 'brave'; results: Array<{ title: string; url: string; snippet: string }>; answer?: string }> {
    const apiKey = this.webSearchConfig.braveApiKey;
    if (!apiKey) throw new Error('Brave API key not configured. Set braveApiKey: ${BRAVE_API_KEY} in assistant.tools.webSearch config.');

    // Step 1: Web search with summary=1 to request a summarizer key.
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}&summary=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey,
        },
      });
      if (!response.ok) {
        throw new Error(`Brave API returned ${response.status}: ${await response.text().catch(() => '')}`);
      }
      const data = await response.json() as {
        web?: { results?: Array<{ title: string; url: string; description: string }> };
        summarizer?: { key?: string };
      };
      const results = (data.web?.results ?? []).slice(0, maxResults).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.description ?? '',
      }));

      // Step 2: If a summarizer key is available, fetch the synthesized answer (FREE — no extra cost).
      let answer: string | undefined;
      const summarizerKey = data.summarizer?.key;
      if (summarizerKey) {
        try {
          answer = await this.fetchBraveSummary(apiKey, summarizerKey, controller.signal);
        } catch {
          // Summarizer is best-effort; return structured results without answer.
        }
      }

      return { query, provider: 'brave', results, answer };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch a synthesized answer from the Brave Summarizer API.
   * Summarizer requests are FREE — only the initial web search counts toward quota.
   */
  private async fetchBraveSummary(apiKey: string, summarizerKey: string, signal: AbortSignal): Promise<string> {
    const url = `https://api.search.brave.com/res/v1/summarizer/search?key=${encodeURIComponent(summarizerKey)}&entity_info=1`;
    const response = await fetch(url, {
      method: 'GET',
      signal,
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });
    if (!response.ok) {
      throw new Error(`Brave Summarizer returned ${response.status}`);
    }
    const data = await response.json() as {
      title?: string;
      summary?: Array<{ type?: string; data?: string; children?: Array<{ data?: string }> }>;
    };

    // Extract text from the structured summary nodes.
    if (!data.summary?.length) return '';
    const parts: string[] = [];
    for (const node of data.summary) {
      if (node.data) parts.push(node.data);
      if (node.children) {
        for (const child of node.children) {
          if (child.data) parts.push(child.data);
        }
      }
    }
    return parts.join(' ').trim();
  }

  private async searchPerplexity(
    query: string,
    maxResults: number,
  ): Promise<{ query: string; provider: 'perplexity'; results: Array<{ title: string; url: string; snippet: string }>; answer?: string }> {
    // Support both direct Perplexity API and OpenRouter proxy.
    // Keys come from config with ${ENV_VAR} interpolation — same as LLM API keys.
    const cfg = this.webSearchConfig;
    const directKey = cfg.perplexityApiKey;
    const openRouterKey = cfg.openRouterApiKey;

    if (!directKey && !openRouterKey) {
      throw new Error('Perplexity API key not configured. Set perplexityApiKey: ${PERPLEXITY_API_KEY} (or openRouterApiKey: ${OPENROUTER_API_KEY}) in assistant.tools.webSearch config.');
    }

    const useOpenRouter = !directKey && !!openRouterKey;
    const apiKey = directKey || openRouterKey!;
    const apiUrl = useOpenRouter
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://api.perplexity.ai/chat/completions';
    const model = useOpenRouter ? 'perplexity/sonar' : 'sonar';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };
      if (useOpenRouter) {
        headers['HTTP-Referer'] = 'https://guardianagent.local';
        headers['X-Title'] = 'GuardianAgent';
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: query }],
        }),
      });
      if (!response.ok) {
        throw new Error(`Perplexity API returned ${response.status}: ${await response.text().catch(() => '')}`);
      }
      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        citations?: Array<string | { url: string; title?: string }>;
      };
      const answer = data.choices?.[0]?.message?.content ?? '';
      const citations = (data.citations ?? []).slice(0, maxResults);
      const results = citations.map((c, i) => {
        if (typeof c === 'string') return { title: `Source ${i + 1}`, url: c, snippet: '' };
        return { title: c.title ?? `Source ${i + 1}`, url: c.url, snippet: '' };
      });
      return { query, provider: 'perplexity', results, answer };
    } finally {
      clearTimeout(timer);
    }
  }

  private assertWebSearchHostsAllowed(provider: 'duckduckgo' | 'brave' | 'perplexity'): void {
    const requiredHosts = this.getWebSearchRequiredHosts(provider);
    const blocked = requiredHosts.filter((host) => !this.isHostAllowed(host));
    if (blocked.length > 0) {
      throw new Error(
        `Web search provider '${provider}' is blocked by allowedDomains. ` +
        `Add: ${blocked.join(', ')}`,
      );
    }
  }

  private loadCpanelClientModule(): Promise<typeof import('./cloud/cpanel-client.js')> {
    this.cpanelClientModulePromise ??= import('./cloud/cpanel-client.js');
    return this.cpanelClientModulePromise;
  }

  private loadVercelClientModule(): Promise<typeof import('./cloud/vercel-client.js')> {
    this.vercelClientModulePromise ??= import('./cloud/vercel-client.js');
    return this.vercelClientModulePromise;
  }

  private loadCloudflareClientModule(): Promise<typeof import('./cloud/cloudflare-client.js')> {
    this.cloudflareClientModulePromise ??= import('./cloud/cloudflare-client.js');
    return this.cloudflareClientModulePromise;
  }

  private loadAwsClientModule(): Promise<typeof import('./cloud/aws-client.js')> {
    this.awsClientModulePromise ??= import('./cloud/aws-client.js');
    return this.awsClientModulePromise;
  }

  private loadGcpClientModule(): Promise<typeof import('./cloud/gcp-client.js')> {
    this.gcpClientModulePromise ??= import('./cloud/gcp-client.js');
    return this.gcpClientModulePromise;
  }

  private loadAzureClientModule(): Promise<typeof import('./cloud/azure-client.js')> {
    this.azureClientModulePromise ??= import('./cloud/azure-client.js');
    return this.azureClientModulePromise;
  }

  private assertWhmProfileConfigured(profileId: string): void {
    const config = this.getCloudCpanelProfile(profileId);
    if (config.type !== 'whm') {
      throw new Error(`Profile '${profileId}' is not a WHM profile.`);
    }
  }

  private assertCpanelAccountContextConfigured(profileId: string, requestedAccount?: string): void {
    const config = this.getCloudCpanelProfile(profileId);
    if (config.type === 'whm' && !(requestedAccount?.trim() || config.defaultCpanelUser?.trim())) {
      throw new Error(`WHM profile '${profileId}' requires an account argument or defaultCpanelUser.`);
    }
  }

  private async createWhmClient(profileId: string): Promise<CpanelClient> {
    this.assertWhmProfileConfigured(profileId);
    const config = this.getCloudCpanelProfile(profileId);
    const { CpanelClient } = await this.loadCpanelClientModule();
    return new CpanelClient(config);
  }

  private async resolveCpanelAccountContext(profileId: string, requestedAccount?: string): Promise<{
    client: CpanelClient;
    account?: string;
  }> {
    const config = this.getCloudCpanelProfile(profileId);
    const { CpanelClient } = await this.loadCpanelClientModule();
    const client = new CpanelClient(config);
    if (config.type === 'cpanel') {
      return {
        client,
        account: config.username,
      };
    }

    const account = requestedAccount?.trim() || config.defaultCpanelUser?.trim();
    if (!account) {
      throw new Error(`WHM profile '${profileId}' requires an account argument or defaultCpanelUser.`);
    }
    return { client, account };
  }

  private getCloudCpanelProfile(profileId: string): CpanelInstanceConfig {
    if (!this.cloudConfig.enabled) {
      throw new Error('Cloud tools are disabled in assistant.tools.cloud.enabled.');
    }
    const id = profileId.trim();
    if (!id) {
      throw new Error('profile is required');
    }
    const profile = (this.cloudConfig.cpanelProfiles ?? []).find((entry) => entry.id === id);
    if (!profile) {
      throw new Error(`Unknown cloud profile '${id}'.`);
    }
    if (!profile.apiToken?.trim()) {
      throw new Error(`Cloud profile '${id}' does not have a resolved API token.`);
    }
    let normalized: CpanelInstanceConfig;
    try {
      normalized = normalizeCpanelConnectionConfig({
        id: profile.id,
        name: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        apiToken: profile.apiToken,
        type: profile.type,
        ssl: profile.ssl,
        allowSelfSigned: profile.allowSelfSigned,
        defaultCpanelUser: profile.defaultCpanelUser,
      });
    } catch (error) {
      throw new Error(`Cloud profile '${id}' has an invalid host: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!this.isHostAllowed(normalized.host)) {
      throw new Error(`Host '${normalized.host}' is not in allowedDomains.`);
    }

    return normalized;
  }

  private async createVercelClient(profileId: string): Promise<VercelClient> {
    const config = this.getCloudVercelProfile(profileId);
    const { VercelClient } = await this.loadVercelClientModule();
    return new VercelClient(config);
  }

  private async createCloudflareClient(profileId: string): Promise<CloudflareClient> {
    const config = this.getCloudflareProfile(profileId);
    const { CloudflareClient } = await this.loadCloudflareClientModule();
    return new CloudflareClient(config);
  }

  private async createAwsClient(profileId: string, service?: AwsServiceName): Promise<AwsClient> {
    const config = this.getCloudAwsProfile(profileId, service);
    const { AwsClient } = await this.loadAwsClientModule();
    return new AwsClient(config);
  }

  private async createGcpClient(profileId: string, service?: GcpServiceName): Promise<GcpClient> {
    const config = this.getCloudGcpProfile(profileId, service);
    const { GcpClient } = await this.loadGcpClientModule();
    return new GcpClient(config);
  }

  private async createAzureClient(profileId: string, service?: AzureServiceName): Promise<AzureClient> {
    const config = this.getCloudAzureProfile(profileId, service);
    const { AzureClient } = await this.loadAzureClientModule();
    return new AzureClient(config);
  }

  private getCloudVercelProfile(profileId: string): VercelInstanceConfig {
    if (!this.cloudConfig.enabled) {
      throw new Error('Cloud tools are disabled in assistant.tools.cloud.enabled.');
    }
    const id = profileId.trim();
    if (!id) {
      throw new Error('profile is required');
    }
    const profile = (this.cloudConfig.vercelProfiles ?? []).find((entry) => entry.id === id);
    if (!profile) {
      throw new Error(`Unknown Vercel profile '${id}'.`);
    }
    if (!profile.apiToken?.trim()) {
      throw new Error(`Vercel profile '${id}' does not have a resolved API token.`);
    }
    if (profile.teamId?.trim() && profile.slug?.trim()) {
      throw new Error(`Vercel profile '${id}' cannot set both teamId and slug.`);
    }

    let baseUrl: URL;
    try {
      baseUrl = new URL(normalizeOptionalHttpUrlInput(profile.apiBaseUrl) || 'https://api.vercel.com');
    } catch {
      throw new Error(`Vercel profile '${id}' has an invalid apiBaseUrl.`);
    }
    if (!this.isHostAllowed(baseUrl.hostname)) {
      throw new Error(`Host '${baseUrl.hostname}' is not in allowedDomains.`);
    }

    return {
      id: profile.id,
      name: profile.name,
      apiBaseUrl: normalizeHttpUrlInput(baseUrl.toString()),
      apiToken: profile.apiToken,
      teamId: profile.teamId,
      slug: profile.slug,
    };
  }

  private getResolvedVercelSandboxTarget(profileId: string): RemoteExecutionResolvedTarget {
    const profile = this.getCloudVercelProfile(profileId);
    const rawProfile = (this.cloudConfig.vercelProfiles ?? []).find((entry) => entry.id === profileId.trim());
    if (!rawProfile) {
      throw new Error(`Unknown Vercel profile '${profileId}'.`);
    }
    if (rawProfile.sandbox?.enabled !== true) {
      throw new Error(`Vercel profile '${profileId}' does not have sandbox execution enabled.`);
    }
    const projectId = rawProfile.sandbox.projectId?.trim();
    if (!projectId) {
      throw new Error(`Vercel profile '${profileId}' does not have a sandbox projectId.`);
    }
    const teamId = profile.teamId?.trim();
    if (!teamId) {
      throw new Error(`Vercel profile '${profileId}' requires a teamId for sandbox execution.`);
    }
    const descriptor = this.getRemoteExecutionTargets().find((entry) => entry.profileId === profile.id);
    return {
      id: descriptor?.id ?? `vercel:${profile.id}`,
      profileId: profile.id,
      profileName: profile.name,
      backendKind: 'vercel_sandbox',
      token: profile.apiToken,
      teamId,
      projectId,
      baseSnapshotId: rawProfile.sandbox.baseSnapshotId?.trim() || undefined,
      apiBaseUrl: profile.apiBaseUrl,
      defaultTimeoutMs: typeof rawProfile.sandbox.defaultTimeoutMs === 'number'
        ? rawProfile.sandbox.defaultTimeoutMs
        : undefined,
      defaultVcpus: typeof rawProfile.sandbox.defaultVcpus === 'number'
        ? rawProfile.sandbox.defaultVcpus
        : undefined,
      networkMode: descriptor?.networkMode ?? 'allow_all',
      allowedDomains: descriptor ? [...descriptor.allowedDomains] : [],
      allowedCidrs: descriptor ? [...descriptor.allowedCidrs] : [],
    };
  }

  private getResolvedDaytonaSandboxTarget(profileId: string): RemoteExecutionResolvedTarget {
    if (!this.cloudConfig.enabled) {
      throw new Error('Cloud tools are disabled in assistant.tools.cloud.enabled.');
    }
    const id = profileId.trim();
    if (!id) {
      throw new Error('profile is required');
    }
    const profile = (this.cloudConfig.daytonaProfiles ?? []).find((entry) => entry.id === id);
    if (!profile) {
      throw new Error(`Unknown Daytona profile '${id}'.`);
    }
    if (profile.enabled !== true) {
      throw new Error(`Daytona profile '${id}' does not have sandbox execution enabled.`);
    }
    if (!profile.apiKey?.trim()) {
      throw new Error(`Daytona profile '${id}' does not have a resolved API key.`);
    }

    let apiUrl: URL;
    try {
      apiUrl = new URL(normalizeOptionalHttpUrlInput(profile.apiUrl) || 'https://app.daytona.io/api');
    } catch {
      throw new Error(`Daytona profile '${id}' has an invalid apiUrl.`);
    }
    if (!this.isHostAllowed(apiUrl.hostname)) {
      throw new Error(`Host '${apiUrl.hostname}' is not in allowedDomains.`);
    }

    const descriptor = this.getRemoteExecutionTargets().find((entry) => entry.profileId === profile.id);
    return {
      id: descriptor?.id ?? `daytona:${profile.id}`,
      profileId: profile.id,
      profileName: profile.name,
      backendKind: 'daytona_sandbox',
      apiKey: profile.apiKey,
      apiUrl: normalizeHttpUrlInput(apiUrl.toString()),
      target: profile.target?.trim() || undefined,
      language: profile.language?.trim() || undefined,
      snapshot: profile.snapshot?.trim() || undefined,
      defaultTimeoutMs: typeof profile.defaultTimeoutMs === 'number'
        ? profile.defaultTimeoutMs
        : undefined,
      defaultVcpus: typeof profile.defaultVcpus === 'number'
        ? profile.defaultVcpus
        : undefined,
      networkMode: descriptor?.networkMode ?? 'allow_all',
      allowedDomains: descriptor ? [...descriptor.allowedDomains] : [],
      allowedCidrs: descriptor ? [...descriptor.allowedCidrs] : [],
    };
  }

  private getCloudflareProfile(profileId: string): CloudflareInstanceConfig {
    if (!this.cloudConfig.enabled) {
      throw new Error('Cloud tools are disabled in assistant.tools.cloud.enabled.');
    }
    const id = profileId.trim();
    if (!id) {
      throw new Error('profile is required');
    }
    const profile = (this.cloudConfig.cloudflareProfiles ?? []).find((entry) => entry.id === id);
    if (!profile) {
      throw new Error(`Unknown Cloudflare profile '${id}'.`);
    }
    if (!profile.apiToken?.trim()) {
      throw new Error(`Cloudflare profile '${id}' does not have a resolved API token.`);
    }

    let baseUrl: URL;
    try {
      baseUrl = new URL(normalizeOptionalHttpUrlInput(profile.apiBaseUrl) || 'https://api.cloudflare.com/client/v4');
    } catch {
      throw new Error(`Cloudflare profile '${id}' has an invalid apiBaseUrl.`);
    }
    if (!this.isHostAllowed(baseUrl.hostname)) {
      throw new Error(`Host '${baseUrl.hostname}' is not in allowedDomains.`);
    }

    return {
      id: profile.id,
      name: profile.name,
      apiBaseUrl: normalizeHttpUrlInput(baseUrl.toString()),
      apiToken: profile.apiToken,
      accountId: profile.accountId,
      defaultZoneId: profile.defaultZoneId,
    };
  }

  private getCloudAwsProfile(profileId: string, service?: AwsServiceName): AwsInstanceConfig {
    if (!this.cloudConfig.enabled) {
      throw new Error('Cloud tools are disabled in assistant.tools.cloud.enabled.');
    }
    const id = profileId.trim();
    if (!id) {
      throw new Error('profile is required');
    }
    const profile = (this.cloudConfig.awsProfiles ?? []).find((entry) => entry.id === id);
    if (!profile) {
      throw new Error(`Unknown AWS profile '${id}'.`);
    }
    const hasAccessKey = !!profile.accessKeyId?.trim();
    const hasSecretKey = !!profile.secretAccessKey?.trim();
    if (hasAccessKey !== hasSecretKey) {
      throw new Error(`AWS profile '${id}' must provide both accessKeyId and secretAccessKey when using explicit credentials.`);
    }

    const config: AwsInstanceConfig = {
      id: profile.id,
      name: profile.name,
      region: profile.region,
      accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.secretAccessKey,
      sessionToken: profile.sessionToken,
      endpoints: normalizeHttpUrlRecord(profile.endpoints),
    };
    const host = this.describeAwsEndpoint(config, service ?? 'sts');
    const parsed = new URL(host);
    if (!this.isHostAllowed(parsed.hostname)) {
      throw new Error(`Host '${parsed.hostname}' is not in allowedDomains.`);
    }
    return config;
  }

  private getCloudGcpProfile(profileId: string, service?: GcpServiceName): GcpInstanceConfig {
    if (!this.cloudConfig.enabled) {
      throw new Error('Cloud tools are disabled in assistant.tools.cloud.enabled.');
    }
    const id = profileId.trim();
    if (!id) {
      throw new Error('profile is required');
    }
    const profile = (this.cloudConfig.gcpProfiles ?? []).find((entry) => entry.id === id);
    if (!profile) {
      throw new Error(`Unknown GCP profile '${id}'.`);
    }
    const hasAccessToken = !!profile.accessToken?.trim();
    const hasServiceAccount = !!profile.serviceAccountJson?.trim();
    if (!hasAccessToken && !hasServiceAccount) {
      throw new Error(`GCP profile '${id}' does not have a resolved access token or service account JSON.`);
    }
    const config: GcpInstanceConfig = {
      id: profile.id,
      name: profile.name,
      projectId: profile.projectId,
      location: profile.location,
      accessToken: profile.accessToken,
      serviceAccountJson: profile.serviceAccountJson,
      endpoints: normalizeHttpUrlRecord(profile.endpoints),
    };
    const host = this.describeGcpEndpoint(config, service ?? 'cloudResourceManager');
    const parsed = new URL(host);
    if (!this.isHostAllowed(parsed.hostname)) {
      throw new Error(`Host '${parsed.hostname}' is not in allowedDomains.`);
    }
    for (const [endpointName, endpoint] of Object.entries(config.endpoints ?? {})) {
      if (!endpoint?.trim()) continue;
      const endpointHost = new URL(endpoint).hostname;
      if (!this.isHostAllowed(endpointHost)) {
        throw new Error(`Host '${endpointHost}' is not in allowedDomains for GCP endpoint '${endpointName}'.`);
      }
    }
    if (hasServiceAccount) {
      const tokenHost = new URL(this.describeGcpEndpoint(config, 'oauth2Token'));
      if (!this.isHostAllowed(tokenHost.hostname)) {
        throw new Error(`Host '${tokenHost.hostname}' is not in allowedDomains.`);
      }
    }
    if (!config.projectId.trim()) {
      throw new Error(`GCP profile '${id}' must define projectId.`);
    }
    return config;
  }

  private getCloudAzureProfile(profileId: string, service?: AzureServiceName): AzureInstanceConfig {
    if (!this.cloudConfig.enabled) {
      throw new Error('Cloud tools are disabled in assistant.tools.cloud.enabled.');
    }
    const id = profileId.trim();
    if (!id) {
      throw new Error('profile is required');
    }
    const profile = (this.cloudConfig.azureProfiles ?? []).find((entry) => entry.id === id);
    if (!profile) {
      throw new Error(`Unknown Azure profile '${id}'.`);
    }
    const hasAccessToken = !!profile.accessToken?.trim();
    const hasClientId = !!profile.clientId?.trim();
    const hasClientSecret = !!profile.clientSecret?.trim();
    if (!hasAccessToken && !(profile.tenantId?.trim() && hasClientId && hasClientSecret)) {
      throw new Error(`Azure profile '${id}' does not have a resolved access token or service principal credentials.`);
    }
    if (hasClientId !== hasClientSecret) {
      throw new Error(`Azure profile '${id}' must provide both clientId and clientSecret together.`);
    }
    const config: AzureInstanceConfig = {
      id: profile.id,
      name: profile.name,
      subscriptionId: profile.subscriptionId,
      tenantId: profile.tenantId,
      accessToken: profile.accessToken,
      clientId: profile.clientId,
      clientSecret: profile.clientSecret,
      defaultResourceGroup: profile.defaultResourceGroup,
      blobBaseUrl: normalizeOptionalHttpUrlInput(profile.blobBaseUrl),
      endpoints: normalizeHttpUrlRecord(profile.endpoints),
    };
    const endpoint = this.describeAzureEndpoint(config, service ?? 'management');
    const endpointHost = new URL(endpoint).hostname;
    if (!this.isHostAllowed(endpointHost)) {
      throw new Error(`Host '${endpointHost}' is not in allowedDomains.`);
    }
    if (config.blobBaseUrl?.trim()) {
      const blobHost = new URL(config.blobBaseUrl).hostname;
      if (!this.isHostAllowed(blobHost)) {
        throw new Error(`Host '${blobHost}' is not in allowedDomains.`);
      }
    } else if (service === 'blob' && !this.isHostAllowed('blob.core.windows.net')) {
      throw new Error(`Host 'blob.core.windows.net' is not in allowedDomains.`);
    }
    return config;
  }

  private describeCloudEndpoint(profile: CpanelInstanceConfig): string {
    const normalized = normalizeCpanelConnectionConfig(profile);
    const ssl = normalized.ssl !== false;
    const defaultPort = normalized.type === 'whm'
      ? (ssl ? 2087 : 2086)
      : (ssl ? 2083 : 2082);
    const port = normalized.port ?? defaultPort;
    return `${ssl ? 'https' : 'http'}://${normalized.host}:${port}`;
  }

  private describeVercelEndpoint(profile: VercelInstanceConfig): string {
    return normalizeHttpUrlInput(profile.apiBaseUrl?.trim() || 'https://api.vercel.com');
  }

  private describeCloudflareEndpoint(profile: CloudflareInstanceConfig): string {
    return normalizeHttpUrlInput(profile.apiBaseUrl?.trim() || 'https://api.cloudflare.com/client/v4');
  }

  private describeAwsEndpoint(profile: AwsInstanceConfig, service: AwsServiceName): string {
    const override = profile.endpoints?.[service];
    if (override?.trim()) {
      return normalizeHttpUrlInput(override);
    }
    const region = profile.region;
    switch (service) {
      case 'iam':
        return 'https://iam.amazonaws.com';
      case 'route53':
        return 'https://route53.amazonaws.com';
      case 'costExplorer':
        return 'https://ce.us-east-1.amazonaws.com';
      case 'cloudwatch':
        return `https://monitoring.${region}.amazonaws.com`;
      case 'cloudwatchLogs':
        return `https://logs.${region}.amazonaws.com`;
      case 's3':
        return `https://s3.${region}.amazonaws.com`;
      default:
        return `https://${service}.${region}.amazonaws.com`;
    }
  }

  private describeGcpEndpoint(profile: GcpInstanceConfig, service: GcpServiceName): string {
    const override = profile.endpoints?.[service];
    if (override?.trim()) {
      return normalizeHttpUrlInput(override);
    }
    switch (service) {
      case 'oauth2Token':
        return 'https://oauth2.googleapis.com/token';
      case 'cloudResourceManager':
        return 'https://cloudresourcemanager.googleapis.com';
      case 'serviceUsage':
        return 'https://serviceusage.googleapis.com';
      case 'compute':
        return 'https://compute.googleapis.com';
      case 'run':
        return 'https://run.googleapis.com';
      case 'storage':
        return 'https://storage.googleapis.com';
      case 'dns':
        return 'https://dns.googleapis.com';
      case 'logging':
        return 'https://logging.googleapis.com';
    }
  }

  private describeAzureEndpoint(profile: AzureInstanceConfig, service: AzureServiceName, accountName?: string): string {
    switch (service) {
      case 'oauth2Token':
        return profile.endpoints?.oauth2Token?.trim()
          ? normalizeHttpUrlInput(profile.endpoints.oauth2Token)
          : `https://login.microsoftonline.com/${encodeURIComponent(profile.tenantId?.trim() || 'common')}/oauth2/v2.0/token`;
      case 'blob':
        return normalizeOptionalHttpUrlInput(profile.blobBaseUrl) || `https://${accountName?.trim() || 'account'}.blob.core.windows.net`;
      case 'management':
      default:
        return profile.endpoints?.management?.trim()
          ? normalizeHttpUrlInput(profile.endpoints.management)
          : 'https://management.azure.com';
    }
  }

  private resolveGcpLocation(value: unknown, profileId: string, throwOnMissing: boolean = true): string {
    const explicit = asString(value).trim();
    if (explicit) return explicit;
    const profile = (this.cloudConfig.gcpProfiles ?? []).find((entry) => entry.id === profileId.trim());
    const fallback = profile?.location?.trim();
    if (fallback) return fallback;
    if (throwOnMissing) {
      throw new Error(`location is required when GCP profile '${profileId}' has no default location.`);
    }
    return '';
  }

  private resolveAzureResourceGroup(value: unknown, profileId: string, throwOnMissing: boolean = true): string {
    const explicit = asString(value).trim();
    if (explicit) return explicit;
    const profile = (this.cloudConfig.azureProfiles ?? []).find((entry) => entry.id === profileId.trim());
    const fallback = profile?.defaultResourceGroup?.trim();
    if (fallback) return fallback;
    if (throwOnMissing) {
      throw new Error(`resourceGroup is required when Azure profile '${profileId}' has no default resource group.`);
    }
    return '';
  }

  private isHostAllowed(host: string, allowedDomains: string[] = this.policy.sandbox.allowedDomains): boolean {
    const normalized = host.trim().toLowerCase();
    if (!normalized) return false;
    return allowedDomains.some((allowedHost) => {
      const allowed = allowedHost.trim().toLowerCase();
      return normalized === allowed || normalized.endsWith(`.${allowed}`);
    });
  }

  /** Execute a command through the OS-level sandbox. */
  private sandboxExec(
    command: string,
    profile: SandboxProfile,
    opts: { networkAccess?: boolean; cwd?: string; timeout?: number; maxBuffer?: number; env?: Record<string, string> } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return sandboxedExec(command, this.sandboxConfig, {
      profile,
      networkAccess: opts.networkAccess,
      cwd: opts.cwd ?? this.options.workspaceRoot,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
      env: opts.env,
    });
  }

  private async sandboxExecFile(
    command: string,
    args: string[],
    profile: SandboxProfile,
    opts: { networkAccess?: boolean; cwd?: string; timeout?: number; maxBuffer?: number; env?: Record<string, string> } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const child = await sandboxedSpawn(command, args, this.sandboxConfig, {
      profile,
      networkAccess: opts.networkAccess,
      cwd: opts.cwd ?? this.options.workspaceRoot,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsShell: false,
    });

    const maxBuffer = Math.max(1_024, opts.maxBuffer ?? 1_000_000);
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflow = false;
    const timeoutHandle = opts.timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeout)
      : null;

    const appendChunk = (chunk: string | Buffer, target: 'stdout' | 'stderr') => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const bytes = Buffer.byteLength(text);
      if (target === 'stdout') {
        stdoutBytes += bytes;
        if (stdoutBytes > maxBuffer) {
          overflow = true;
          child.kill();
          return;
        }
        stdout += text;
        return;
      }
      stderrBytes += bytes;
      if (stderrBytes > maxBuffer) {
        overflow = true;
        child.kill();
        return;
      }
      stderr += text;
    };

    return await new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
      child.stdout?.on('data', (chunk) => appendChunk(chunk, 'stdout'));
      child.stderr?.on('data', (chunk) => appendChunk(chunk, 'stderr'));
      child.on('error', (error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        rejectPromise(error);
      });
      child.on('close', (code, signal) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (timedOut) {
          rejectPromise(new Error(`Command timed out after ${opts.timeout}ms.`));
          return;
        }
        if (overflow) {
          rejectPromise(new Error(`Command output exceeded max buffer (${maxBuffer} bytes).`));
          return;
        }
        if ((code ?? 0) !== 0) {
          const detail = stderr.trim() || stdout.trim() || `exit code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
          rejectPromise(new Error(detail));
          return;
        }
        resolvePromise({ stdout, stderr });
      });
    });
  }

  private guardAction(
    request: ToolExecutionRequest,
    type: string,
    params: Record<string, unknown>,
  ): void {
    const effectiveParams = request.codeContext && type === 'execute_command'
      ? {
          ...params,
          allowedCommandsOverride: this.getEffectiveAllowedCommands(request),
        }
      : params;
    if (request.agentContext) {
      request.agentContext.checkAction({ type, params: effectiveParams });
      return;
    }
    if (!this.options.onCheckAction) return;
    this.options.onCheckAction({
      type,
      params: effectiveParams,
      origin: request.origin,
      agentId: request.agentId ?? 'assistant-tools',
    });
  }

  private initializeSandboxNotices(): void {
    const health = this.sandboxHealth;
    if (!health || !this.sandboxConfig.enabled) return;
    if (isStrictSandboxLockdown(this.sandboxConfig, health)) {
      this.runtimeNotices.push({
        level: 'warn',
        message: [
          `Strict sandbox mode is active: risky subprocess-backed tools are disabled on ${health.platform}.`,
          health.reasons[0] ?? '',
          'This host also lacks descendant executable identity enforcement for child processes, so strict mode fails closed for risky subprocess-backed tools.',
          'To unlock them safely, run on Linux/Unix with bubblewrap available, or use the Windows portable app with guardian-sandbox-win.exe AppContainer helper.',
          'If you still want degraded access, you must explicitly set assistant.tools.sandbox.enforcementMode: permissive.',
        ].join(' ').trim(),
      });
      return;
    }
    if ((health.enforcementMode ?? 'permissive') !== 'strict') {
      const enabledAllowances = listEnabledDegradedFallbackAllowances(this.sandboxConfig);
      this.runtimeNotices.push({
        level: health.availability === 'strong' ? 'info' : 'warn',
        message: [
          `Permissive sandbox mode is explicitly enabled on ${health.platform}.`,
          health.availability === 'strong'
            ? 'Strong sandboxing is available, but permissive mode still allows degraded fallbacks if your configuration changes.'
            : (
              enabledAllowances.length > 0
                ? `Degraded fallback overrides are enabled for ${enabledAllowances.join(', ')} while only ${health.availability} sandbox isolation is available.`
                : `Only ${health.availability} sandbox isolation is available, but degraded-backend overrides keep high-risk surfaces blocked by default.`
            ),
          'Current shell execution identity coverage is app-layer only: Guardian validates the requested command and may use direct exec for simple binaries, but it does not yet enforce descendant executable identity for child processes.',
          'Use this only if you accept higher host risk.',
          'Safer options: run on Linux/Unix with bubblewrap available, or use the Windows portable app with guardian-sandbox-win.exe AppContainer helper.',
        ].join(' '),
      });
    }
  }

  private getSandboxBlockedCategoryReason(category: ToolCategory): string | null {
    const health = this.sandboxHealth;
    if (!health || !this.sandboxConfig.enabled) return null;
    if (isStrictSandboxLockdown(this.sandboxConfig, health)) {
      const blockedCategories = new Set<ToolCategory>(['shell', 'browser', 'network', 'system', 'search']);
      if (!blockedCategories.has(category)) return null;
      return `Blocked by strict sandbox mode: no strong sandbox backend is available on ${health.platform}.`;
    }
    if (!isDegradedSandboxFallbackActive(this.sandboxConfig, health)) return null;

    const degradedFallback = resolveDegradedFallbackConfig(this.sandboxConfig);
    if (category === 'browser' && !degradedFallback.allowBrowserTools) {
      return 'Blocked on degraded sandbox backends by default: browser automation requires assistant.tools.sandbox.degradedFallback.allowBrowserTools.';
    }
    if (category === 'network' && !degradedFallback.allowNetworkTools) {
      return 'Blocked on degraded sandbox backends by default: network tools require assistant.tools.sandbox.degradedFallback.allowNetworkTools.';
    }
    return null;
  }

  private getSandboxBlockReason(toolName: string, category?: string): string | null {
    const health = this.sandboxHealth;
    if (!health || !this.sandboxConfig.enabled) return null;
    if (
      toolName === 'find_tools'
      || toolName === 'update_tool_policy'
      || toolName === 'llm_provider_list'
      || toolName === 'llm_provider_models'
      || toolName === 'llm_provider_update'
    ) {
      return null;
    }

    if (isStrictSandboxLockdown(this.sandboxConfig, health)) {
      if (toolName.startsWith('mcp-')) {
        return `Tool '${toolName}' is blocked by strict sandbox mode because MCP server processes require a strong sandbox backend on ${health.platform}.`;
      }
      if (category && this.getSandboxBlockedCategoryReason(category as ToolCategory)) {
        return `Tool '${toolName}' is blocked by strict sandbox mode because category '${category}' requires strong subprocess isolation on ${health.platform}.`;
      }
      return null;
    }
    if (isDegradedSandboxFallbackActive(this.sandboxConfig, health)) {
      const degradedFallback = resolveDegradedFallbackConfig(this.sandboxConfig);
      if (toolName === 'package_install' && !degradedFallback.allowPackageManagers) {
        return `Tool '${toolName}' is blocked on degraded sandbox backends by default because managed package installs require ${DEGRADED_PACKAGE_MANAGER_HINT}.`;
      }
      if (toolName === 'web_search' && !degradedFallback.allowNetworkTools) {
        return `Tool '${toolName}' is blocked on degraded sandbox backends by default because network and web search access require assistant.tools.sandbox.degradedFallback.allowNetworkTools.`;
      }
      if (toolName === 'chrome_job' && !degradedFallback.allowBrowserTools) {
        return `Tool '${toolName}' is blocked on degraded sandbox backends by default because browser automation requires assistant.tools.sandbox.degradedFallback.allowBrowserTools.`;
      }
      if (toolName.startsWith('mcp-') && !isBrowserMcpToolName(toolName) && !degradedFallback.allowMcpServers) {
        return `Tool '${toolName}' is blocked on degraded sandbox backends by default because third-party MCP servers require assistant.tools.sandbox.degradedFallback.allowMcpServers.`;
      }
      if (isBrowserMcpToolName(toolName) && !degradedFallback.allowBrowserTools) {
        return `Tool '${toolName}' is blocked on degraded sandbox backends by default because browser automation requires assistant.tools.sandbox.degradedFallback.allowBrowserTools.`;
      }
      if (category && this.getSandboxBlockedCategoryReason(category as ToolCategory)) {
        return `Tool '${toolName}' is blocked on degraded sandbox backends by default because category '${category}' remains restricted until you explicitly enable it.`;
      }
    }
    return null;
  }
}

function stripHtml(value: string): string {
  return htmlToText(value, { skipTagContent: new Set(['script', 'style', 'noscript', 'svg', 'canvas']) });
}

function sanitizePreview(value: string): string {
  if (!value) return '';
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 240 ? `${cleaned.slice(0, 240)}...` : cleaned;
}

/**
 * Extract readable text content from HTML.
 * Prefers <article> or <main> if present; strips nav/footer/header/script/style.
 */
function extractReadableContent(html: string): string {
  const article = findFirstElementInnerHtml(html, 'article');
  const main = findFirstElementInnerHtml(html, 'main');
  const body = article ?? main ?? html;
  const title = stripHtml(findFirstElementInnerHtml(html, 'title') ?? '').trim();
  const bodyText = htmlToText(body, {
    skipTagContent: new Set(['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'svg', 'canvas', 'iframe']),
  })
    .replace(/\s+/g, ' ')
    .trim();

  return title ? `${title}\n\n${bodyText}` : bodyText;
}

type ParsedHtmlElement = {
  tagName: string;
  attributes: Record<string, string>;
  innerHtml: string;
};

type HtmlTextOptions = {
  skipTagContent?: ReadonlySet<string>;
};

const BLOCK_HTML_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'br',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function parseDuckDuckGoResults(
  html: string,
  maxResults: number,
): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const resultBlocks = findHtmlElementsByClass(html, 'result');
  for (const block of resultBlocks) {
    if (results.length >= maxResults) break;
    const link = findHtmlElementsByClass(block.innerHtml, 'result__a', 'a')[0];
    if (!link) continue;
    const snippet = findHtmlElementsByClass(block.innerHtml, 'result__snippet')[0];
    const href = normalizeDuckDuckGoResultUrl(link.attributes.href ?? '');
    if (!href) continue;
    results.push({
      title: stripHtml(link.innerHtml).trim(),
      url: href,
      snippet: snippet ? stripHtml(snippet.innerHtml).replace(/\s+/g, ' ').trim() : '',
    });
  }
  return results;
}

function normalizeDuckDuckGoResultUrl(rawHref: string): string {
  const href = rawHref.trim();
  if (!href) return '';
  try {
    const parsed = new URL(href, 'https://html.duckduckgo.com');
    const redirected = parsed.searchParams.get('uddg');
    return redirected?.trim() || parsed.toString();
  } catch {
    return href;
  }
}

function htmlToText(value: string, options: HtmlTextOptions = {}): string {
  if (!value) return '';
  const skipTagContent = options.skipTagContent ?? new Set<string>();
  let text = '';
  const appendSeparator = () => {
    if (text && !/\s$/.test(text)) {
      text += ' ';
    }
  };
  let index = 0;
  while (index < value.length) {
    const ch = value[index];
    if (ch !== '<') {
      text += ch;
      index += 1;
      continue;
    }

    if (value.startsWith('<!--', index)) {
      const commentEnd = value.indexOf('-->', index + 4);
      index = commentEnd === -1 ? value.length : commentEnd + 3;
      appendSeparator();
      continue;
    }

    const tag = parseHtmlStartTag(value, index);
    if (!tag) {
      text += ch;
      index += 1;
      continue;
    }

    const tagName = tag.tagName.toLowerCase();
    if (!tag.isClosing && shouldSkipHtmlTag(tagName, tag.attributes, skipTagContent) && !VOID_HTML_TAGS.has(tagName)) {
      const close = findMatchingClosingTag(value, tagName, tag.startTagEnd + 1);
      index = close === -1 ? value.length : close + (`</${tagName}>`).length;
      appendSeparator();
      continue;
    }

    index = tag.startTagEnd + 1;
    if (BLOCK_HTML_TAGS.has(tagName)) {
      appendSeparator();
    }
  }

  return decodeHtmlEntities(text)
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldSkipHtmlTag(
  tagName: string,
  attributes: Record<string, string>,
  skipTagContent: ReadonlySet<string>,
): boolean {
  if (skipTagContent.has(tagName)) {
    return true;
  }
  if (tagName === 'template') {
    return true;
  }
  if (attributes.hidden !== undefined || attributes.inert !== undefined) {
    return true;
  }
  if ((attributes['aria-hidden'] ?? '').trim().toLowerCase() === 'true') {
    return true;
  }
  if (tagName === 'input' && (attributes.type ?? '').trim().toLowerCase() === 'hidden') {
    return true;
  }
  const style = (attributes.style ?? '').replace(/\s+/g, '').toLowerCase();
  return style.includes('display:none')
    || style.includes('visibility:hidden')
    || style.includes('content-visibility:hidden');
}

function findFirstElementInnerHtml(html: string, tagName: string): string | undefined {
  return findHtmlElementsByTagName(html, tagName)[0]?.innerHtml;
}

function findHtmlElementsByClass(html: string, className: string, tagName?: string): ParsedHtmlElement[] {
  const classToken = className.trim();
  if (!classToken) return [];
  const matches: ParsedHtmlElement[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) break;
    const tag = parseHtmlStartTag(html, open);
    if (!tag) {
      index = open + 1;
      continue;
    }
    index = tag.startTagEnd + 1;
    if (tag.isClosing) continue;
    if (tagName && tag.tagName !== tagName) continue;
    const classAttr = tag.attributes.class;
    if (!classAttr || !classAttr.split(/\s+/).includes(classToken)) continue;
    if (VOID_HTML_TAGS.has(tag.tagName)) continue;
    const close = findMatchingClosingTag(html, tag.tagName, tag.startTagEnd + 1);
    if (close === -1) continue;
    matches.push({
      tagName: tag.tagName,
      attributes: tag.attributes,
      innerHtml: html.slice(tag.startTagEnd + 1, close),
    });
  }
  return matches;
}

function findHtmlElementsByTagName(html: string, tagName: string): ParsedHtmlElement[] {
  const normalizedTag = tagName.toLowerCase();
  const matches: ParsedHtmlElement[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) break;
    const tag = parseHtmlStartTag(html, open);
    if (!tag) {
      index = open + 1;
      continue;
    }
    index = tag.startTagEnd + 1;
    if (tag.isClosing || tag.tagName !== normalizedTag || VOID_HTML_TAGS.has(tag.tagName)) continue;
    const close = findMatchingClosingTag(html, tag.tagName, tag.startTagEnd + 1);
    if (close === -1) continue;
    matches.push({
      tagName: tag.tagName,
      attributes: tag.attributes,
      innerHtml: html.slice(tag.startTagEnd + 1, close),
    });
  }
  return matches;
}

function parseHtmlStartTag(
  html: string,
  start: number,
): { tagName: string; attributes: Record<string, string>; startTagEnd: number; isClosing: boolean } | null {
  if (html[start] !== '<') return null;
  const next = html[start + 1];
  if (!next || next === '!' || next === '?') return null;
  const isClosing = next === '/';
  let cursor = start + (isClosing ? 2 : 1);
  while (cursor < html.length && /\s/.test(html[cursor])) cursor += 1;
  const nameStart = cursor;
  while (cursor < html.length && /[A-Za-z0-9:-]/.test(html[cursor])) cursor += 1;
  if (cursor === nameStart) return null;
  const tagName = html.slice(nameStart, cursor).toLowerCase();
  const startTagEnd = findTagEnd(html, cursor);
  if (startTagEnd === -1) return null;
  if (isClosing) {
    return { tagName, attributes: {}, startTagEnd, isClosing: true };
  }
  const attributes = parseHtmlAttributes(html.slice(cursor, startTagEnd));
  return { tagName, attributes, startTagEnd, isClosing: false };
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < html.length; index += 1) {
    const ch = html[index];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '>') return index;
  }
  return -1;
}

function parseHtmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /[\s/]/.test(source[index])) index += 1;
    if (index >= source.length) break;
    const nameStart = index;
    while (index < source.length && /[^\s=/>]/.test(source[index])) index += 1;
    const rawName = source.slice(nameStart, index).trim().toLowerCase();
    if (!rawName) {
      index += 1;
      continue;
    }
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (source[index] !== '=') {
      attributes[rawName] = '';
      continue;
    }
    index += 1;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length) {
      attributes[rawName] = '';
      break;
    }
    const quote = source[index];
    if (quote === '"' || quote === '\'') {
      index += 1;
      const valueStart = index;
      while (index < source.length && source[index] !== quote) index += 1;
      attributes[rawName] = decodeHtmlEntities(source.slice(valueStart, index));
      if (index < source.length) index += 1;
      continue;
    }
    const valueStart = index;
    while (index < source.length && /[^\s>]/.test(source[index])) index += 1;
    attributes[rawName] = decodeHtmlEntities(source.slice(valueStart, index));
  }
  return attributes;
}

function findMatchingClosingTag(html: string, tagName: string, fromIndex: number): number {
  const openNeedle = `<${tagName}`;
  const closeNeedle = `</${tagName}`;
  let depth = 0;
  let index = fromIndex;
  while (index < html.length) {
    const nextOpen = html.indexOf(openNeedle, index);
    const nextClose = html.indexOf(closeNeedle, index);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const nested = parseHtmlStartTag(html, nextOpen);
      if (nested && !nested.isClosing && nested.tagName === tagName && !VOID_HTML_TAGS.has(tagName)) {
        depth += 1;
        index = nested.startTagEnd + 1;
        continue;
      }
      index = nextOpen + openNeedle.length;
      continue;
    }
    const closing = parseHtmlStartTag(html, nextClose);
    if (!closing || !closing.isClosing || closing.tagName !== tagName) {
      index = nextClose + closeNeedle.length;
      continue;
    }
    if (depth === 0) return nextClose;
    depth -= 1;
    index = closing.startTagEnd + 1;
  }
  return -1;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-fA-F]+|\d+)|[a-zA-Z]+);/g, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'nbsp') return ' ';
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === '#39' || normalized === 'apos') return '\'';
    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(value);
  }
  return result;
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = sep === '\\' ? candidate.toLowerCase() : candidate;
  const normalizedRoot = sep === '\\' ? root.toLowerCase() : root;
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(
    normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`,
  );
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function looksLikeStableBrowserRef(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(value.trim());
}

function hasValidBrowserMutationArgs(args: Record<string, unknown>): boolean {
  const action = asString(args.action, 'click').trim().toLowerCase();
  const stateId = asString(args.stateId).trim();
  if (!stateId) return false;
  const hasRef = looksLikeStableBrowserRef(args.ref) || looksLikeStableBrowserRef(args.element);
  if (!hasRef) return false;
  if (action === 'type' || action === 'fill' || action === 'select') {
    return typeof args.value === 'string' && args.value.length > 0;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractRemoteExecutionInfo(value: unknown): ToolJobRemoteExecutionInfo | undefined {
  if (!isRecord(value)) return undefined;
  const backendKind = asString(value.backendKind).trim();
  const profileId = asString(value.profileId).trim();
  const profileName = asString(value.profileName).trim();
  const sandboxId = asString(value.sandboxId).trim();
  const leaseId = asString(value.leaseId).trim();
  const leaseScope = asString(value.leaseScope).trim();
  const healthState = asString(value.healthState).trim();
  const healthReason = asString(value.healthReason).trim();
  const leaseReused = typeof value.leaseReused === 'boolean' ? value.leaseReused : undefined;
  if (!backendKind && !profileId && !profileName && !sandboxId && !leaseId) {
    return undefined;
  }
  return {
    ...(backendKind ? { backendKind } : {}),
    ...(profileId ? { profileId } : {}),
    ...(profileName ? { profileName } : {}),
    ...(sandboxId ? { sandboxId } : {}),
    ...(leaseId ? { leaseId } : {}),
    ...(leaseScope ? { leaseScope } : {}),
    ...(typeof leaseReused === 'boolean' ? { leaseReused } : {}),
    ...(healthState ? { healthState } : {}),
    ...(healthReason ? { healthReason } : {}),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`'${field}' must be a non-empty string.`);
  }
  return value;
}

function requireStringAllowEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`'${field}' must be a string.`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`'${field}' must be a boolean.`);
  }
  return value;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferMCPGuardAction(def: ToolDefinition): { type: string; params?: Record<string, unknown> } | null {
  const parsed = MCPClientManager.parseToolName(def.name);
  if (!parsed) return { type: 'mcp_tool', params: { toolName: def.name } };
  if (parsed.serverId !== 'gws') {
    return { type: 'mcp_tool', params: { serverId: parsed.serverId, toolName: parsed.toolName } };
  }

  const capabilityAction = inferGoogleWorkspaceCapabilityAction(parsed.toolName, def.description);
  if (!capabilityAction) {
    return { type: 'mcp_tool', params: { serverId: parsed.serverId, toolName: parsed.toolName } };
  }

  return {
    type: capabilityAction,
    params: {
      serverId: parsed.serverId,
      toolName: parsed.toolName,
    },
  };
}

function inferGoogleWorkspaceCapabilityAction(toolName: string, description: string): string | null {
  const combined = `${toolName} ${description}`.toLowerCase();
  const isWrite = /\b(create|update|edit|modify|delete|insert|append|upload|move|trash|share|send|publish|write|draft)\b/.test(combined);
  const isDraft = /\bdraft\b/.test(combined);

  if (/\b(gmail|mail|message|email)\b/.test(combined)) {
    if (/\bsend\b/.test(combined)) return 'send_email';
    if (isDraft) return 'draft_email';
    return 'read_email';
  }
  if (/\b(calendar|event)\b/.test(combined)) {
    return isWrite ? 'write_calendar' : 'read_calendar';
  }
  if (/\b(drive|file|folder)\b/.test(combined)) {
    return isWrite ? 'write_drive' : 'read_drive';
  }
  if (/\b(docs|document)\b/.test(combined)) {
    return isWrite ? 'write_docs' : 'read_docs';
  }
  if (/\b(sheets|spreadsheet)\b/.test(combined)) {
    return isWrite ? 'write_sheets' : 'read_sheets';
  }

  return null;
}

function formatToolArgsPreview(toolName: string, redactedArgs: unknown): string {
  if (toolName === 'automation_save') {
    const summary = summarizeAutomationSavePreview(isRecord(redactedArgs) ? redactedArgs : {});
    if (summary) return sanitizePreview(summary);
  }
  if (toolName === 'automation_set_enabled') {
    const summary = summarizeAutomationTogglePreview(isRecord(redactedArgs) ? redactedArgs : {});
    if (summary) return sanitizePreview(summary);
  }
  if (toolName === 'automation_run') {
    const summary = summarizeAutomationRunPreview(isRecord(redactedArgs) ? redactedArgs : {});
    if (summary) return sanitizePreview(summary);
  }
  if (toolName === 'automation_delete') {
    const summary = summarizeAutomationDeletePreview(isRecord(redactedArgs) ? redactedArgs : {});
    if (summary) return sanitizePreview(summary);
  }
  if (toolName === 'gws') {
    const summary = summarizeGwsPreview(isRecord(redactedArgs) ? redactedArgs : {});
    if (summary) return sanitizePreview(summary);
  }
  if (toolName === 'performance_profile_apply') {
    const summary = summarizePerformanceProfilePreview(isRecord(redactedArgs) ? redactedArgs : {});
    if (summary) return sanitizePreview(summary);
  }
  if (toolName === 'performance_action_run') {
    const summary = summarizePerformanceActionRunPreview(isRecord(redactedArgs) ? redactedArgs : {});
    if (summary) return sanitizePreview(summary);
  }
  if (
    toolName === 'second_brain_routine_create'
    || toolName === 'second_brain_routine_update'
    || toolName === 'second_brain_routine_delete'
  ) {
    const summary = summarizeSecondBrainRoutinePreview(isRecord(redactedArgs) ? redactedArgs : {});
    if (summary) return sanitizePreview(summary);
  }
  return sanitizePreview(JSON.stringify(redactedArgs));
}

function summarizeAutomationSavePreview(args: Record<string, unknown>): string | null {
  const name = asString(args.name).trim() || asString(args.id).trim();
  const kind = asString(args.kind).trim();
  if (!name || !kind) return null;
  if (kind === 'assistant_task') {
    const schedule = isRecord(args.schedule) ? args.schedule : null;
    const cron = schedule ? asString(schedule.cron).trim() : '';
    return cron
      ? `save scheduled assistant automation ${name} on ${cron}`
      : `save manual assistant automation ${name}`;
  }
  if (kind === 'standalone_task') {
    const task = isRecord(args.task) ? args.task : null;
    const target = asString(task?.target).trim();
    const schedule = isRecord(args.schedule) ? args.schedule : null;
    const cron = schedule ? asString(schedule.cron).trim() : '';
    const runOnce = schedule?.runOnce === true;
    if (target === 'gws') {
      const gwsSummary = summarizeGwsPreview(isRecord(task?.args) ? task?.args : {});
      if (gwsSummary) {
        return `save ${runOnce ? 'one-shot' : cron ? 'scheduled' : 'manual'} tool automation ${name}: ${gwsSummary}${cron ? ` on ${cron}` : ''}`;
      }
    }
    return `save ${runOnce ? 'one-shot' : cron ? 'scheduled' : 'manual'} tool automation ${name}${target ? ` targeting ${target}` : ''}${cron ? ` on ${cron}` : ''}`;
  }
  const mode = asString(args.mode, 'sequential').trim() || 'sequential';
  const steps = Array.isArray(args.steps) ? args.steps.length : 0;
  const schedule = isRecord(args.schedule) ? args.schedule : null;
  const cron = schedule ? asString(schedule.cron).trim() : '';
  return `save automation ${name} (${mode}, ${steps} step${steps === 1 ? '' : 's'}${cron ? `, schedule ${cron}` : ''})`;
}

function summarizeAutomationTogglePreview(args: Record<string, unknown>): string | null {
  const automationId = asString(args.automationId).trim();
  if (!automationId || typeof args.enabled !== 'boolean') return null;
  return `${args.enabled ? 'enable' : 'disable'} automation ${automationId}`;
}

function summarizeAutomationRunPreview(args: Record<string, unknown>): string | null {
  const automationId = asString(args.automationId).trim();
  if (!automationId) return null;
  return `${args.dryRun === true ? 'dry-run' : 'run'} automation ${automationId}`;
}

function summarizeAutomationDeletePreview(args: Record<string, unknown>): string | null {
  const automationId = asString(args.automationId).trim();
  if (!automationId) return null;
  return `delete automation ${automationId}`;
}

function summarizePerformanceProfilePreview(args: Record<string, unknown>): string | null {
  const profileId = asString(args.profileId).trim();
  return profileId ? `apply performance profile ${profileId}` : null;
}

function describePerformanceSelectionMode(value: string): string {
  return value === 'all_selectable' ? 'all selectable targets' : 'default recommended selection';
}

function summarizePerformanceActionRunPreview(args: Record<string, unknown>): string | null {
  const actionId = asString(args.actionId, 'cleanup').trim() || 'cleanup';
  const previewId = asString(args.previewId).trim();
  if (previewId) {
    const totalTargets = asStringArray(args.selectedProcessTargetIds).length + asStringArray(args.selectedCleanupTargetIds).length;
    return `run performance action ${actionId} from preview ${previewId} on ${totalTargets} selected target(s)`;
  }
  const selectionMode = asString(args.selectionMode, 'checked_by_default').trim() || 'checked_by_default';
  return `run performance action ${actionId} using ${describePerformanceSelectionMode(selectionMode)}`;
}

function formatRoutineTemplateName(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '';
  return normalized
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveSecondBrainRoutineDisplayName(args: Record<string, unknown>): string {
  const explicitName = asString(args.name).trim();
  if (explicitName) return explicitName;

  const config = isRecord(args.config) ? args.config : null;
  const id = asString(args.id).trim();
  const templateId = asString(args.templateId).trim() || (id ? id.split(':')[0] : '');
  const baseName = formatRoutineTemplateName(templateId);
  const focusQuery = asString(config?.focusQuery).trim();
  const topicQuery = asString(config?.topicQuery).trim();

  if (templateId === 'topic-watch' && topicQuery) {
    return `Topic Watch: ${topicQuery}`;
  }
  if (templateId === 'deadline-watch') {
    const dueWithinHours = Number.isFinite(config?.dueWithinHours) ? Number(config?.dueWithinHours) : 24;
    const overdueSuffix = config?.includeOverdue === false ? '' : ' + overdue';
    return `Deadline Watch: next ${dueWithinHours} hour${dueWithinHours === 1 ? '' : 's'}${overdueSuffix}`;
  }
  if (baseName && focusQuery) {
    return `${baseName}: ${focusQuery}`;
  }
  return baseName || id;
}

function summarizeSecondBrainRoutinePreview(args: Record<string, unknown>): string | null {
  const id = asString(args.id).trim();
  const templateId = asString(args.templateId).trim() || (id ? id.split(':')[0] : '');
  const name = resolveSecondBrainRoutineDisplayName(args);
  const summary: Record<string, unknown> = {};
  if (id) summary.id = id;
  if (templateId) summary.templateId = templateId;
  if (name) summary.name = name;
  return Object.keys(summary).length > 0 ? JSON.stringify(summary) : null;
}

function summarizeGwsPreview(args: Record<string, unknown>): string | null {
  const service = asString(args.service).trim().toLowerCase();
  const resource = asString(args.resource).trim().toLowerCase();
  const method = asString(args.method).trim().toLowerCase();
  if (!service || !method) return null;

  if (service === 'gmail' && resource === 'users messages' && method === 'send') {
    const payload = extractRawMessageSummary(args);
    if (payload) {
      return `send Gmail to ${payload.to || '(unknown recipient)'}${payload.subject ? ` with subject "${payload.subject}"` : ''}`;
    }
    return 'send Gmail message';
  }

  if (service === 'gmail' && resource === 'users drafts' && method === 'create') {
    const payload = extractRawMessageSummary(args);
    if (payload) {
      return `draft Gmail to ${payload.to || '(unknown recipient)'}${payload.subject ? ` with subject "${payload.subject}"` : ''}`;
    }
    return 'create Gmail draft';
  }

  if (service === 'calendar' && resource === 'events' && method === 'list') {
    return 'list calendar events';
  }

  return `${service} ${resource || 'request'} ${method}`.trim();
}

function extractRawMessageSummary(args: Record<string, unknown>): { to?: string; subject?: string } | null {
  const json = isRecord(args.json) ? args.json : {};
  const raw = asString(json.raw) || asString(isRecord(json.message) ? json.message.raw : undefined);
  if (!raw) return null;
  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (normalized.length % 4 || 4)) % 4;
    const padded = normalized + '='.repeat(padLength);
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    const lines = decoded.split(/\r?\n/);
    const to = lines.find((line) => /^to:/i.test(line))?.replace(/^to:\s*/i, '').trim();
    const subject = lines.find((line) => /^subject:/i.test(line))?.replace(/^subject:\s*/i, '').trim();
    return { to: to || undefined, subject: subject || undefined };
  } catch {
    return null;
  }
}

function extractToolSuccessMessage(
  toolName: string,
  output: unknown,
  explicitMessage?: string,
): string {
  const message = explicitMessage?.trim()
    || extractAutomationSuccessMessage(toolName, output)
    || extractCodingBackendSuccessMessage(toolName, output)
    || extractOutputMessage(output);
  return message || `Tool '${toolName}' completed.`;
}

function extractAutomationSuccessMessage(toolName: string, output: unknown): string {
  if (!isRecord(output)) return '';

  if (toolName === 'automation_save') {
    const automationId = asString(output.automationId).trim();
    const taskId = asString(output.taskId).trim();
    const message = asString(output.message).trim();
    if (automationId) {
      return `${message || 'Saved.'}${taskId ? ` Automation id: ${automationId}. Linked task: ${taskId}.` : ` Automation id: ${automationId}.`}`;
    }
  }

  return '';
}

function extractCodingBackendSuccessMessage(toolName: string, output: unknown): string {
  if (toolName !== 'coding_backend_run' || !isRecord(output)) return '';
  const backendName = asString(output.backendName).trim() || 'Coding backend';
  const rawOutput = asString(output.output).trim();
  if (!rawOutput || rawOutput === '(no output captured)') {
    return `${backendName} completed.`;
  }
  return `${backendName} completed.\n\n${rawOutput}`;
}

function extractOutputMessage(output: unknown): string {
  if (!isRecord(output)) return '';
  return asString(output.message).trim();
}
