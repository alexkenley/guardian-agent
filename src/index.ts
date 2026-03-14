#!/usr/bin/env node
/**
 * Guardian Agent — Entry point.
 *
 * Load config → create Runtime → register agents → start channels →
 * handle SIGINT/SIGTERM for graceful shutdown.
 */

import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, DEFAULT_CONFIG_PATH, deepMerge, validateConfig } from './config/loader.js';
import type { BrowserConfig, CredentialRefConfig, GuardianAgentConfig, MCPServerEntry, WebSearchConfig } from './config/types.js';
import { normalizeHttpUrlRecord, normalizeOptionalHttpUrlInput } from './config/input-normalization.js';
import yaml from 'js-yaml';
import { Runtime } from './runtime/runtime.js';
import { CLIChannel } from './channels/cli.js';
import { TelegramChannel } from './channels/telegram.js';
import { WebChannel, type WebAuthRuntimeConfig } from './channels/web.js';
import type {
  ConfigUpdate,
  DashboardCallbacks,
  DashboardAgentInfo,
  DashboardAgentDetail,
  DashboardProviderInfo,
  RedactedCloudConfig,
  RedactedConfig,
  SSEListener,
} from './channels/web-types.js';
import type { LLMConfig } from './config/types.js';
import { BaseAgent } from './agent/agent.js';
import { createAgentDefinition } from './agent/agent.js';
import type { AgentContext, AgentResponse, UserMessage } from './agent/types.js';
import { GuardianAgentService, SentinelAuditService } from './runtime/sentinel.js';
import { createPolicyEngine, loadPolicyFiles, ShadowEvaluator } from './policy/index.js';
import type { PolicyModeConfig } from './policy/index.js';
import { createLogger, setLogLevel } from './util/logging.js';
import { ConversationService } from './runtime/conversation.js';
import { getReferenceGuide, formatGuideForTelegram } from './reference-guide.js';
import type { ChatMessage, LLMProvider } from './llm/types.js';
import { IdentityService } from './runtime/identity.js';
import { AnalyticsService } from './runtime/analytics.js';
import { buildQuickActionPrompt, getQuickActions } from './quick-actions.js';
import { evaluateSetupStatus } from './runtime/setup.js';
import { ThreatIntelService } from './runtime/threat-intel.js';
import { createThreatIntelSourceScanners } from './runtime/threat-intel-osint.js';
import { ConnectorPlaybookService } from './runtime/connectors.js';
import { installTemplate, listTemplates, autoInstallAllTemplates } from './runtime/builtin-packs.js';
import { DeviceInventoryService } from './runtime/device-inventory.js';
import { NetworkBaselineService, type NetworkAnomalyReport } from './runtime/network-baseline.js';
import { NetworkTrafficService } from './runtime/network-traffic.js';
import { HostMonitoringService, type HostMonitorReport } from './runtime/host-monitor.js';
import { GatewayFirewallMonitoringService, type GatewayMonitorReport } from './runtime/gateway-monitor.js';
import { ScheduledTaskService } from './runtime/scheduled-tasks.js';
import { MoltbookConnector } from './runtime/moltbook-connector.js';
import { AssistantOrchestrator } from './runtime/orchestrator.js';
import { AgentMemoryStore } from './runtime/agent-memory-store.js';
import { AssistantJobTracker } from './runtime/assistant-jobs.js';
import { NotificationService } from './runtime/notifications.js';
import { promoteAutomationFindings } from './runtime/automation-output.js';
import { buildGmailRawMessage, parseDirectGmailWriteIntent } from './runtime/gmail-compose.js';
import { parseScheduledEmailAutomationIntent } from './runtime/email-automation-intent.js';
import { parseDirectFileSearchIntent } from './runtime/search-intent.js';
import { ToolExecutor } from './tools/executor.js';
import type { ToolExecutorOptions } from './tools/executor.js';
import type { ToolPolicySnapshot, ToolExecutionRequest } from './tools/types.js';
import { MCPClientManager } from './tools/mcp-client.js';
import { normalizeCpanelConnectionConfig } from './tools/cloud/cpanel-profile.js';
import { CpanelClient } from './tools/cloud/cpanel-client.js';
import { VercelClient } from './tools/cloud/vercel-client.js';
import { CloudflareClient } from './tools/cloud/cloudflare-client.js';
import { AwsClient } from './tools/cloud/aws-client.js';
import { GcpClient } from './tools/cloud/gcp-client.js';
import { AzureClient } from './tools/cloud/azure-client.js';
import type { MCPServerConfig } from './tools/mcp-client.js';
import { composeGuardianSystemPrompt } from './prompts/guardian-core.js';
import { MessageRouter, type RouteDecision } from './runtime/message-router.js';
import { resolveAgentStateId, SHARED_TIER_AGENT_STATE_ID } from './runtime/agent-state-context.js';
import { ModelFallbackChain } from './llm/model-fallback.js';
import { TRUST_PRESETS, type TrustPresetName } from './guardian/trust-presets.js';
import type { Capability } from './guardian/capabilities.js';
import type { OutputGuardian } from './guardian/output-guardian.js';
import { createProviders, getProviderRegistry } from './llm/provider.js';
import { hashObjectSha256Hex } from './util/crypto-guardrails.js';
import { detectCapabilities as detectSandboxCapabilities, detectSandboxHealth, DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from './sandbox/index.js';
import { SkillRegistry } from './skills/registry.js';
import { SkillResolver } from './skills/resolver.js';
import type { ResolvedSkill } from './skills/types.js';
import { formatAvailableSkillsPrompt } from './skills/prompt.js';
import { resolveRuntimeCredentialView } from './runtime/credentials.js';
import { LocalSecretStore } from './runtime/secret-store.js';
import { WorkerManager } from './supervisor/worker-manager.js';
import { formatPendingApprovalMessage, shouldUseStructuredPendingApprovalMessage } from './runtime/pending-approval-copy.js';
import { shouldAllowImplicitMemorySave as _shouldAllowImplicitMemorySave } from './util/memory-intent.js';
import { isResponseDegraded as _isResponseDegraded } from './util/response-quality.js';
import { compactMessagesIfOverBudget as _compactMessagesIfOverBudget } from './util/context-budget.js';
import { isToolReportQuery as _isToolReportQuery, formatToolReport as _formatToolReport } from './util/tool-report.js';

const log = createLogger('main');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default chat agent that uses the configured LLM provider. */
const APPROVAL_CONFIRM_PATTERN = /^(?:\/)?(?:approve|approved|yes|yep|yeah|y|go ahead|do it|confirm|ok|okay|sure|proceed|accept)\b/i;
const APPROVAL_DENY_PATTERN = /^(?:\/)?(?:deny|denied|reject|decline|cancel|no|nope|nah|n)\b/i;
const APPROVAL_COMMAND_PATTERN = /^\/?(approve|deny)\b/i;
const APPROVAL_ID_TOKEN_PATTERN = /^(?=.*(?:-|\d))[a-z0-9-]{4,}$/i;
const PENDING_APPROVAL_TTL_MS = 30 * 60_000;
const MAX_TOOL_RESULT_MESSAGE_CHARS = 8_000;
const MAX_TOOL_RESULT_STRING_CHARS = 600;
const MAX_TOOL_RESULT_ARRAY_ITEMS = 10;
const MAX_TOOL_RESULT_OBJECT_KEYS = 20;

interface PendingApprovalState {
  ids: string[];
  createdAt: number;
  expiresAt: number;
}

function generateSecureToken(byteLength = 16): string {
  return randomBytes(byteLength).toString('hex');
}

function previewTokenForLog(token: string): string {
  if (token.length <= 8) return token;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function isLoopbackOrPrivateHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '0.0.0.0'
    || normalized === 'host.docker.internal'
  ) {
    return true;
  }
  if (/^10\.\d+\.\d+\.\d+$/.test(normalized)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(normalized)) return true;
  const private172 = normalized.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (private172) {
    const secondOctet = Number(private172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  return false;
}

function isLocalProviderEndpoint(baseUrl: string | undefined, providerType: string | undefined): boolean {
  if ((providerType ?? '').trim().toLowerCase() === 'ollama') return true;
  if (!baseUrl) return false;
  try {
    const parsed = new URL(baseUrl);
    return isLoopbackOrPrivateHost(parsed.hostname);
  } catch {
    return /localhost|127\.0\.0\.1|::1|0\.0\.0\.0|host\.docker\.internal/.test(baseUrl);
  }
}

function getProviderLocality(
  llmCfg: Pick<LLMConfig, 'provider' | 'baseUrl'> | undefined,
): 'local' | 'external' | undefined {
  if (!llmCfg?.provider) return undefined;
  return isLocalProviderEndpoint(llmCfg.baseUrl, llmCfg.provider) ? 'local' : 'external';
}

type SoulInjectionMode = 'full' | 'summary' | 'disabled';

interface LoadedSoulProfile {
  path: string;
  full: string;
  summary: string;
}

function truncatePromptText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[TRUNCATED: original=${value.length} chars, max=${maxChars}]`;
}

function buildSoulSummary(text: string, maxChars: number): string {
  const compact = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (compact.length === 0) {
    return truncatePromptText(text, maxChars);
  }

  let out = '';
  for (const line of compact) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > maxChars) break;
    out = next;
  }

  return out || truncatePromptText(text, maxChars);
}

function loadSoulProfile(config: GuardianAgentConfig): LoadedSoulProfile | null {
  const soulConfig = config.assistant.soul;
  if (!soulConfig.enabled) {
    return null;
  }

  const configuredPath = soulConfig.path?.trim() || 'SOUL.md';
  const resolvedPath = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(process.cwd(), configuredPath);

  if (!existsSync(resolvedPath)) {
    log.info({ path: resolvedPath }, 'SOUL injection enabled but file not found; continuing without SOUL context');
    return null;
  }

  const raw = readFileSync(resolvedPath, 'utf-8').trim();
  if (!raw) {
    log.info({ path: resolvedPath }, 'SOUL file is empty; continuing without SOUL context');
    return null;
  }

  const full = truncatePromptText(raw, soulConfig.maxChars);
  const summary = buildSoulSummary(full, soulConfig.summaryMaxChars);
  log.info(
    { path: resolvedPath, fullChars: full.length, summaryChars: summary.length },
    'Loaded SOUL profile',
  );
  return { path: resolvedPath, full, summary };
}

function selectSoulPrompt(profile: LoadedSoulProfile | null, mode: SoulInjectionMode): string | undefined {
  if (!profile || mode === 'disabled') return undefined;
  return mode === 'summary' ? profile.summary : profile.full;
}

function buildManagedMCPServers(_config: GuardianAgentConfig): Array<MCPServerEntry & { managedProviderId: string }> {
  // Google Workspace is handled by native built-in tools, not via MCP.
  // This function builds MCP server entries for any other managed providers.
  return [];
}

const execFileAsync = promisify(execFileCb);

async function pickNativeSearchPath(kind: 'directory' | 'file'): Promise<{
  success: boolean;
  path?: string;
  canceled?: boolean;
  message: string;
}> {
  if (process.platform !== 'win32') {
    return {
      success: false,
      canceled: false,
      message: 'Native path picker is currently available on Windows only.',
    };
  }

  const script = kind === 'file'
    ? `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select a file to index'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.FileName) {
  @{ success = $true; canceled = $false; path = $dialog.FileName; message = 'File selected.' } | ConvertTo-Json -Compress
} else {
  @{ success = $false; canceled = $true; message = 'Selection cancelled.' } | ConvertTo-Json -Compress
}
`
    : `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select a directory to index'
$dialog.ShowNewFolderButton = $false
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
  @{ success = $true; canceled = $false; path = $dialog.SelectedPath; message = 'Directory selected.' } | ConvertTo-Json -Compress
} else {
  @{ success = $false; canceled = $true; message = 'Selection cancelled.' } | ConvertTo-Json -Compress
}
`;

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', script],
      { timeout: 300_000, windowsHide: false, maxBuffer: 1024 * 1024 },
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
      return {
        success: false,
        canceled: true,
        message: 'Selection cancelled.',
      };
    }
    const parsed = JSON.parse(trimmed) as {
      success?: boolean;
      path?: string;
      canceled?: boolean;
      message?: string;
    };
    return {
      success: parsed.success === true,
      path: typeof parsed.path === 'string' ? parsed.path : undefined,
      canceled: parsed.canceled === true,
      message: typeof parsed.message === 'string'
        ? parsed.message
        : (parsed.success ? 'Path selected.' : 'Selection cancelled.'),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      canceled: false,
      message: `Failed to open native ${kind} picker: ${message}`,
    };
  }
}

/**
 * Probe the GWS CLI by running `gws --version` and `gws auth status`.
 * Uses the configured command or falls back to 'gws' on PATH.
 */
async function probeGwsCli(config: GuardianAgentConfig): Promise<{
  installed: boolean;
  version?: string;
  authenticated: boolean;
  authMethod?: string;
}> {
  const command = config.assistant.tools.mcp?.managedProviders?.gws?.command?.trim() || 'gws';
  const execOpts = { timeout: 5000, shell: process.platform === 'win32' };
  try {
    const { stdout } = await execFileAsync(command, ['--version'], execOpts);
    const version = stdout.trim();
    try {
      const { stdout: statusJson } = await execFileAsync(command, ['auth', 'status'], execOpts);
      const status = JSON.parse(statusJson) as { auth_method?: string; storage?: string };
      const authenticated = !!status.auth_method && status.auth_method !== 'none';
      return { installed: true, version, authenticated, authMethod: authenticated ? status.auth_method : undefined };
    } catch (err) {
      log.debug({ err, command }, 'GWS auth status check failed, reporting as not authenticated');
      return { installed: true, version, authenticated: false };
    }
  } catch (err) {
    log.debug({ err, command }, 'GWS CLI not found or version check failed');
    return { installed: false, authenticated: false };
  }
}

interface SuspendedToolCall {
  approvalId: string;
  toolCallId: string;
  jobId: string;
  name: string;
}

interface SuspendedSession {
  userKey: string;
  llmMessages: import('./llm/types.js').ChatMessage[];
  pendingTools: SuspendedToolCall[];
  originalMessage: UserMessage;
  ctx: AgentContext;
}

interface ApprovalFollowUpCopy {
  approved?: string;
  denied?: string;
}

class ChatAgent extends BaseAgent {
  private systemPrompt: string;
  private conversationService?: ConversationService;
  private tools?: ToolExecutor;
  private outputGuardian?: OutputGuardian;
  private skillResolver?: SkillResolver;
  private enabledManagedProviders?: ReadonlySet<string>;
  private maxToolRounds: number;
  /** Pending approval IDs from the last tool round, keyed by user+channel. */
  private pendingApprovals: Map<string, PendingApprovalState> = new Map();
  /** Suspended tool loops waiting for approval, keyed by user+channel. */
  private suspendedSessions = new Map<string, SuspendedSession>();
  /** Direct-tool approval follow-ups that should not go back through the LLM. */
  private approvalFollowUps = new Map<string, ApprovalFollowUpCopy>();
  /** Optional model fallback chain for retrying failed LLM calls. */
  private fallbackChain?: ModelFallbackChain;
  /** Per-agent persistent knowledge base. */
  private memoryStore?: AgentMemoryStore;
  /** Logical state identity used for shared conversation/memory context. */
  private readonly stateAgentId: string;
  /** Resolver for the GWS LLM provider — looked up at request time so hot-reloaded config is used. */
  private resolveGwsProvider?: () => LLMProvider | undefined;
  /** Approximate token budget for tool results in context. */
  private contextBudget: number;
  /** Whether to retry degraded local LLM responses with an external fallback. */
  private qualityFallbackEnabled: boolean;
  /** Resolve a routed LLM provider based on tools just executed. Returns undefined if no routing override. */
  private resolveRoutedProviderForTools?: (tools: Array<{ name: string; category?: string }>) => { provider: LLMProvider; locality: 'local' | 'external' } | undefined;

  private executeToolsConflictAware(
    toolCalls: Array<{ id: string; name: string; arguments?: string }>,
    toolExecOrigin: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
    options?: { allowImplicitMemorySave?: boolean },
  ): Promise<{ toolCall: { id: string; name: string; arguments?: string }; result: Record<string, unknown> }>[] {
    const promises: Promise<{ toolCall: { id: string; name: string; arguments?: string }; result: Record<string, unknown> }>[] = [];
    const locks = new Map<string, Promise<void>>();

    for (const tc of toolCalls) {
      let parsedArgs: Record<string, unknown> = {};
      if (tc.arguments?.trim()) {
        try { parsedArgs = JSON.parse(tc.arguments) as Record<string, unknown>; } catch { /* empty */ }
      }

      if (tc.name === 'memory_save' && options?.allowImplicitMemorySave !== true) {
        promises.push(Promise.resolve({
          toolCall: tc,
          result: {
            success: false,
            status: 'denied',
            message: 'memory_save is reserved for explicit remember/save requests from the user.',
          },
        }));
        continue;
      }

      const def = this.tools?.getToolDefinition(tc.name);
      const isMutating = def ? def.risk !== 'read_only' : true;
      let conflictKey: string | null = null;

      if (isMutating) {
        if (tc.name === 'fs_write' || tc.name === 'fs_delete' || tc.name === 'fs_move' || tc.name === 'fs_copy' || tc.name === 'doc_create') {
          conflictKey = `fs:${parsedArgs.path || parsedArgs.filename || parsedArgs.source}`;
        } else if (tc.name.startsWith('browser_')) {
          conflictKey = `browser:${parsedArgs.ref || parsedArgs.url}`;
        } else {
          conflictKey = `global:${tc.name}`;
        }
      }

      const executeFn = () => this.tools!.executeModelTool(tc.name, parsedArgs, toolExecOrigin)
        .then((result) => ({ toolCall: tc, result }));

      if (conflictKey) {
        const prev = locks.get(conflictKey) ?? Promise.resolve();
        const current = prev.then(executeFn);
        locks.set(conflictKey, current.then(() => {}).catch(() => {}));
        promises.push(current);
      } else {
        promises.push(executeFn());
      }
    }

    return promises;
  }

  constructor(
    id: string,
    name: string,
    systemPrompt?: string,
    conversationService?: ConversationService,
    tools?: ToolExecutor,
    outputGuardian?: OutputGuardian,
    skillResolver?: SkillResolver,
    enabledManagedProviders?: ReadonlySet<string>,
    fallbackChain?: ModelFallbackChain,
    soulPrompt?: string,
    memoryStore?: AgentMemoryStore,
    stateAgentId?: string,
    resolveGwsProvider?: () => LLMProvider | undefined,
    contextBudget?: number,
    qualityFallback?: boolean,
    resolveRoutedProviderForTools?: (tools: Array<{ name: string; category?: string }>) => { provider: LLMProvider; locality: 'local' | 'external' } | undefined,
  ) {
    super(id, name, { handleMessages: true });
    this.systemPrompt = composeGuardianSystemPrompt(systemPrompt, soulPrompt);
    log.debug(
      {
        agentId: id,
        systemPromptChars: this.systemPrompt.length,
        soulChars: soulPrompt?.length ?? 0,
      },
      'Initialized chat agent prompt context',
    );
    this.conversationService = conversationService;
    this.tools = tools;
    this.outputGuardian = outputGuardian;
    this.skillResolver = skillResolver;
    this.enabledManagedProviders = enabledManagedProviders;
    this.maxToolRounds = 6;
    this.fallbackChain = fallbackChain;
    this.memoryStore = memoryStore;
    this.stateAgentId = stateAgentId ?? id;
    this.resolveGwsProvider = resolveGwsProvider;
    this.contextBudget = contextBudget ?? 80_000;
    this.qualityFallbackEnabled = qualityFallback ?? true;
    this.resolveRoutedProviderForTools = resolveRoutedProviderForTools;
  }

  /**
   * Chat with fallback: try ctx.llm first, fall back to chain on failure.
   * Returns ChatResponse from whichever provider succeeds.
   */
  private async chatWithFallback(
    ctx: AgentContext,
    messages: ChatMessage[],
    options?: import('./llm/types.js').ChatOptions,
  ): Promise<import('./llm/types.js').ChatResponse> {
    if (!this.fallbackChain) {
      return ctx.llm!.chat(messages, options);
    }
    try {
      return await ctx.llm!.chat(messages, options);
    } catch (primaryError) {
      log.warn(
        { agent: this.id, error: primaryError instanceof Error ? primaryError.message : String(primaryError) },
        'Primary LLM failed, trying fallback chain',
      );
      const result = await this.fallbackChain.chatWithFallback(messages, options);
      return result.response;
    }
  }

  async onMessage(message: UserMessage, ctx: AgentContext, workerManager?: WorkerManager): Promise<AgentResponse> {
    const stateAgentId = this.stateAgentId;
    if (workerManager) {
      try {
        const activeSkills = this.skillResolver?.resolve({
          agentId: this.id,
          channel: message.channel,
          requestType: 'chat',
          content: message.content,
          enabledManagedProviders: this.enabledManagedProviders,
        }) ?? [];
        const knowledgeBase = this.memoryStore?.loadForContext(stateAgentId) ?? '';
        const history = this.conversationService?.getHistoryForContext({
          agentId: stateAgentId,
          userId: message.userId,
          channel: message.channel,
        }) ?? [];
        const result = await workerManager.handleMessage({
          sessionId: `${message.userId}:${message.channel}`,
          agentId: this.id,
          userId: message.userId,
          grantedCapabilities: [...ctx.capabilities],
          message,
          systemPrompt: this.systemPrompt,
          history,
          knowledgeBase,
          activeSkills,
          toolContext: this.tools?.getToolContext() ?? '',
          runtimeNotices: this.tools?.getRuntimeNotices() ?? [],
        });
        if (this.conversationService) {
          this.conversationService.recordTurn(
            { agentId: stateAgentId, userId: message.userId, channel: message.channel },
            message.content,
            result.content,
          );
        }
        return {
          content: result.content,
          metadata: result.metadata,
        };
      } catch (error) {
        log.error({ agent: this.id, error: error instanceof Error ? error.stack ?? error.message : String(error) }, 'Brokered message execution failed');
        throw error;
      }
    }

    if (!ctx.llm) {
      return { content: 'No LLM provider configured.' };
    }
    const userKey = `${message.userId}:${message.channel}`;
    this.syncPendingApprovalsFromExecutor(userKey, message.userId, message.channel);

    // Check if user is approving a pending tool action (text-based: CLI / Telegram)
    const approvalResult = await this.tryHandleApproval(message, userKey);
    if (approvalResult) {
      if (this.conversationService) {
        this.conversationService.recordTurn(
          { agentId: stateAgentId, userId: message.userId, channel: message.channel },
          message.content,
          approvalResult,
        );
      }
      return { content: approvalResult };
    }

    const directToolReport = this.tryDirectRecentToolReport(message);
    if (directToolReport) {
      if (this.conversationService) {
        this.conversationService.recordTurn(
          { agentId: stateAgentId, userId: message.userId, channel: message.channel },
          message.content,
          directToolReport,
        );
      }
      return { content: directToolReport };
    }

    const isContinuation = message.content.includes('[User approved the pending tool action(s)') || 
                           message.content.includes('Tool actions have been decided');
    const suspended = this.suspendedSessions.get(userKey);
    const requestIntentContent = (isContinuation && suspended)
      ? suspended.originalMessage.content
      : message.content;
    const allowImplicitMemorySave = this.shouldAllowImplicitMemorySave(requestIntentContent);

    let llmMessages: import('./llm/types.js').ChatMessage[];
    let skipDirectTools = false;
    let enrichedSystemPrompt = this.systemPrompt;
    let activeSkills: ResolvedSkill[] = [];

    if (isContinuation && suspended) {
      llmMessages = [...suspended.llmMessages];
      const allJobs = this.tools?.listJobs(100) ?? [];
      for (const pending of suspended.pendingTools) {
        const job = allJobs.find(j => j.id === pending.jobId);
        let resultObj: Record<string, unknown> = { success: false, message: 'Job not found' };
        if (job) {
          if (job.status === 'succeeded') resultObj = { success: true, message: job.resultPreview || 'Executed successfully.' };
          else resultObj = { success: false, error: job.error || 'Failed or denied.' };
        }
        llmMessages.push({
          role: 'tool',
          toolCallId: pending.toolCallId,
          content: JSON.stringify(resultObj),
        });
      }
      this.suspendedSessions.delete(userKey);
      skipDirectTools = true;
    } else {
      // Non-blocking pending approval context (approvals no longer block new messages)
      const existingPending = this.getPendingApprovals(userKey);
      const pendingApprovalContext = existingPending
        ? `\nNote: ${existingPending.ids.length} tool action(s) are awaiting user approval. The approval UI is presented to the user automatically — do NOT mention approval IDs or ask the user to approve manually. Process the current request normally and call tools as needed.`
        : '';

      // Inject knowledge base into system prompt if available
      activeSkills = this.skillResolver?.resolve({
        agentId: this.id,
        channel: message.channel,
        requestType: 'chat',
        content: message.content,
        enabledManagedProviders: this.enabledManagedProviders,
      }) ?? [];
      if (this.memoryStore) {
        const kb = this.memoryStore.loadForContext(stateAgentId);
        if (kb) {
          enrichedSystemPrompt += `\n\n<knowledge-base>\nThe following is your persistent knowledge base — facts, preferences, and summaries you have remembered across conversations:\n\n${kb}\n</knowledge-base>`;
        }
      }
      if (activeSkills.length > 0) {
        enrichedSystemPrompt += `\n\n${formatAvailableSkillsPrompt(activeSkills, 'fs_read')}`;
      }
      if (this.tools) {
        enrichedSystemPrompt += `\n\n<tool-context>\n${this.tools.getToolContext()}\n</tool-context>`;
      }
      const toolRuntimeNotices = this.tools?.getRuntimeNotices() ?? [];
      if (toolRuntimeNotices.length > 0) {
        enrichedSystemPrompt += `\n\n<tool-runtime-notices>\n${toolRuntimeNotices.map((notice) => `- ${notice.message}`).join('\n')}\n</tool-runtime-notices>`;
      }
      if (pendingApprovalContext) {
        enrichedSystemPrompt += pendingApprovalContext;
      }

      llmMessages = this.conversationService
        ? this.conversationService.buildMessages(
          { agentId: stateAgentId, userId: message.userId, channel: message.channel },
          enrichedSystemPrompt,
          message.content,
        )
        : [
          { role: 'system', content: enrichedSystemPrompt },
          { role: 'user', content: message.content },
        ];
    }

    let finalContent = '';
    let pendingApprovalMeta: Array<{ id: string; toolName: string; argsPreview: string }> | undefined;
    let lastToolRoundResults: Array<{ toolName: string; result: Record<string, unknown> }> = [];
    const defaultToolResultProviderKind = this.resolveToolResultProviderKind(ctx);
    
    if (!skipDirectTools) {
      const directSearch = await this.tryDirectFilesystemSearch(message, ctx);
      if (directSearch) {
        finalContent = directSearch;
        if (this.conversationService) {
          this.conversationService.recordTurn(
            { agentId: stateAgentId, userId: message.userId, channel: message.channel },
            message.content,
            finalContent,
          );
        }
        return {
          content: finalContent,
          metadata: this.buildImmediateResponseMetadata(activeSkills, userKey),
        };
      }

      const directScheduledEmailAutomation = await this.tryDirectScheduledEmailAutomation(message, ctx, userKey, stateAgentId);
      if (directScheduledEmailAutomation) {
        finalContent = directScheduledEmailAutomation;
        if (this.conversationService) {
          this.conversationService.recordTurn(
            { agentId: stateAgentId, userId: message.userId, channel: message.channel },
            message.content,
            finalContent,
          );
        }
        return {
          content: finalContent,
          metadata: this.buildImmediateResponseMetadata(activeSkills, userKey),
        };
      }

      const directWorkspaceWrite = await this.tryDirectGoogleWorkspaceWrite(message, ctx, userKey);
      if (directWorkspaceWrite) {
        finalContent = directWorkspaceWrite;
        if (this.conversationService) {
          this.conversationService.recordTurn(
            { agentId: stateAgentId, userId: message.userId, channel: message.channel },
            message.content,
            finalContent,
          );
        }
        return {
          content: finalContent,
          metadata: this.buildImmediateResponseMetadata(activeSkills, userKey),
        };
      }

      const directWorkspaceRead = await this.tryDirectGoogleWorkspaceRead(message, ctx);
      if (directWorkspaceRead) {
        finalContent = directWorkspaceRead;
        if (this.conversationService) {
          this.conversationService.recordTurn(
            { agentId: stateAgentId, userId: message.userId, channel: message.channel },
            message.content,
            finalContent,
          );
        }
        return {
          content: finalContent,
          metadata: this.buildImmediateResponseMetadata(activeSkills, userKey),
        };
      }

      // Direct web search: if the user clearly wants web results, call web_search
      // directly so the tool executes even when the LLM doesn't invoke it.
      let webSearchResult: string | null = null;
      try {
        webSearchResult = await this.tryDirectWebSearch(message, ctx);
      } catch {
        // Search failed — fall through to LLM with tool calling
      }
      if (webSearchResult) {
        // Scan web search results through OutputGuardian before LLM reinjection
        const sanitizedWebSearch = this.sanitizeToolResultForLlm(
          'web_search',
          webSearchResult,
          defaultToolResultProviderKind,
        );
        const safeWebSearchResult = typeof sanitizedWebSearch.sanitized === 'string'
          ? sanitizedWebSearch.sanitized
          : String(sanitizedWebSearch.sanitized ?? '');
        const warningPrefix = formatToolThreatWarnings(sanitizedWebSearch.threats);
        const llmSearchPayload = warningPrefix
          ? `${warningPrefix}\n${safeWebSearchResult}`
          : safeWebSearchResult;

        // Feed the sanitized search results through the LLM for a natural response
        if (ctx.llm) {
          try {
            const llmFormat: ChatMessage[] = [
              ...llmMessages,
              { role: 'user', content: `Here are web search results for the user's query. Summarize and present them clearly:\n\n${llmSearchPayload}` },
            ];
            const formatted = await this.chatWithFallback(ctx, llmFormat);
            finalContent = formatted.content || llmSearchPayload;
          } catch {
            // LLM formatting failed — return raw search results
            finalContent = llmSearchPayload;
          }
        } else {
          finalContent = llmSearchPayload;
        }
        if (this.conversationService) {
          this.conversationService.recordTurn(
            { agentId: stateAgentId, userId: message.userId, channel: message.channel },
            message.content,
            finalContent,
          );
        }
        return { content: finalContent };
      }
    }

    // If GWS provider is configured and the message looks like a workspace request,
    // swap to the external model for the tool-calling loop so it handles
    // structured tool calls correctly (local models often struggle with complex schemas).
    const gwsProvider = this.enabledManagedProviders?.has('gws')
      && /\b(gmail|email|inbox|calendar|schedule|event|drive|docs|sheets|spreadsheet|google)\b/i.test(message.content)
      ? this.resolveGwsProvider?.()
      : undefined;
    let chatFn = async (msgs: ChatMessage[], opts?: import('./llm/types.js').ChatOptions) => {
      if (gwsProvider) {
        try {
          return await gwsProvider.chat(msgs, opts);
        } catch (err) {
          log.warn({ agent: this.id, error: err instanceof Error ? err.message : String(err) },
            'GWS provider failed, falling back to default');
          return this.chatWithFallback(ctx, msgs, opts);
        }
      }
      return this.chatWithFallback(ctx, msgs, opts);
    };
    let toolResultProviderKind = gwsProvider
      ? 'external'
      : defaultToolResultProviderKind;

    const providerLocality = this.resolveToolResultProviderKind(ctx);

    if (!this.tools?.isEnabled()) {
      const response = await chatFn(llmMessages);
      finalContent = response.content;
      // Quality-based fallback for non-tool path
      if (this.qualityFallbackEnabled && this.isResponseDegraded(finalContent) && this.fallbackChain && providerLocality === 'local') {
        log.warn({ agent: this.id }, 'Local LLM produced degraded response (no-tools path), retrying with fallback');
        try {
          const fb = await this.fallbackChain.chatWithFallbackAfterPrimary(llmMessages);
          if (fb.response.content?.trim()) finalContent = fb.response.content;
        } catch { /* fallback also failed, keep original */ }
      }
    } else {
      let rounds = 0;
      // Deferred loading: start with always-loaded tools, expand via find_tools
      const allToolDefs = this.tools.listAlwaysLoadedDefinitions();
      // Local models get full descriptions for better tool selection; external models get short
      let llmToolDefs = allToolDefs.map((d) => toLLMToolDef(d, providerLocality));
      const pendingIds: string[] = [];
      const contextBudget = this.contextBudget;
      let forcedPolicyRetryUsed = false;
      while (rounds < this.maxToolRounds) {
        // Context window awareness: if approaching budget, summarize oldest tool results
        compactMessagesIfOverBudget(llmMessages, contextBudget);

        let response = await chatFn(llmMessages, { tools: llmToolDefs });
        finalContent = response.content;
        if (
          !forcedPolicyRetryUsed
          && this.shouldRetryPolicyUpdateCorrection(llmMessages, finalContent, llmToolDefs)
        ) {
          forcedPolicyRetryUsed = true;
          response = await chatFn(
            [
              ...llmMessages,
              { role: 'assistant', content: response.content ?? '' },
              { role: 'user', content: this.buildPolicyUpdateCorrectionPrompt() },
            ],
            { tools: llmToolDefs },
          );
          finalContent = response.content;
        }
        if (!response.toolCalls || response.toolCalls.length === 0) {
          // Safety net for local models: if finishReason is 'stop' (no tool calls)
          // but the message clearly needed web search, pre-fetch results and re-prompt.
          // This catches cases where Ollama/local models fail to emit tool calls.
          if (rounds === 0 && response.finishReason === 'stop' && this.tools) {
            const searchQuery = parseWebSearchIntent(message.content);
            if (searchQuery) {
              const prefetched = await this.tools.executeModelTool(
                'web_search',
                { query: searchQuery, maxResults: 5 },
                {
                  origin: 'assistant',
                  agentId: this.id,
                  userId: message.userId,
                  channel: message.channel,
                  requestId: message.id,
                  agentContext: { checkAction: ctx.checkAction },
                },
              );
              if (toBoolean(prefetched.success) && prefetched.output) {
                const prefetchedScan = this.sanitizeToolResultForLlm('web_search', prefetched, toolResultProviderKind);
                const safePrefetched = prefetchedScan.sanitized && typeof prefetchedScan.sanitized === 'object'
                  ? prefetchedScan.sanitized as Record<string, unknown>
                  : prefetched;
                const output = (safePrefetched && typeof safePrefetched === 'object' && safePrefetched.output && typeof safePrefetched.output === 'object'
                  ? safePrefetched.output
                  : prefetched.output) as { answer?: unknown; results?: unknown; provider?: unknown };
                const answer = toString(output.answer);
                const results = Array.isArray(output.results) ? output.results : [];
                const warningPrefix = formatToolThreatWarnings(prefetchedScan.threats);
                // If Perplexity returned a synthesized answer, inject it directly
                if (answer) {
                  llmMessages.push({
                    role: 'user',
                    content: `${warningPrefix ? `${warningPrefix}\n` : ''}[web_search results for "${searchQuery}"]:\n${answer}\n\nSources:\n${results.map((r: { url?: string }, i: number) => `${i + 1}. ${r.url ?? ''}`).join('\n')}\n\nPlease use these results to answer the user's question.`,
                  });
                } else if (results.length > 0) {
                  const snippets = results.map((r: { title?: string; url?: string; snippet?: string }, i: number) =>
                    `${i + 1}. ${r.title ?? '(untitled)'} — ${r.url ?? ''}\n   ${r.snippet ?? ''}`
                  ).join('\n');
                  llmMessages.push({
                    role: 'user',
                    content: `${warningPrefix ? `${warningPrefix}\n` : ''}[web_search results for "${searchQuery}"]:\n${snippets}\n\nPlease synthesize these results to answer the user's question.`,
                  });
                }
                // Re-prompt the LLM with the search results
                if (answer || results.length > 0) {
                  const retryResponse = await chatFn(llmMessages);
                  finalContent = retryResponse.content;
                }
              }
            }
          }
          break;
        }

        llmMessages.push({
          role: 'assistant',
          content: response.content ?? '',
          toolCalls: response.toolCalls,
        });

        // Parallel tool execution: run all tool calls concurrently
        const toolExecOrigin = {
          origin: 'assistant' as const,
          agentId: this.id,
          userId: message.userId,
          channel: message.channel,
          requestId: message.id,
          agentContext: { checkAction: ctx.checkAction },
        };

        const toolResults = await Promise.allSettled(
          this.executeToolsConflictAware(response.toolCalls, toolExecOrigin, { allowImplicitMemorySave })
        );
        lastToolRoundResults = toolResults.reduce<Array<{ toolName: string; result: Record<string, unknown> }>>((acc, settled) => {
          if (settled.status !== 'fulfilled') return acc;
          acc.push({
            toolName: settled.value.toolCall.name,
            result: settled.value.result,
          });
          return acc;
        }, []);

        let hasPending = false;
        for (const settled of toolResults) {
          if (settled.status === 'fulfilled') {
            const { toolCall, result: toolResult } = settled.value;

            // Track pending approvals so we can auto-approve on user confirmation
            if (toolResult.status === 'pending_approval' && toolResult.approvalId) {
              pendingIds.push(String(toolResult.approvalId));
              hasPending = true;
            }

            // Strip approval IDs from pending_approval results so the LLM
            // doesn't echo them.  The structured metadata handles approval rendering.
            let resultForLlm = toolResult;
            if (toolResult.status === 'pending_approval') {
              const { approvalId: _stripped, jobId: _stripJob, ...rest } = toolResult as Record<string, unknown>;
              resultForLlm = { ...rest, message: 'This action needs your approval. The approval UI is shown to the user automatically.' };
            }

            const scannedToolResult = this.sanitizeToolResultForLlm(
              toolCall.name,
              resultForLlm,
              toolResultProviderKind,
            );

            llmMessages.push({
              role: 'tool',
              toolCallId: toolCall.id,
              content: formatToolResultForLLM(
                toolCall.name,
                scannedToolResult.sanitized,
                scannedToolResult.threats,
              ),
            });

            // Deferred tool loading: if find_tools was called, merge returned definitions
            if (toolCall.name === 'find_tools' && toolResult.success) {
              const searchOutput = toolResult.output as { tools?: Array<{ name: string; description: string; parameters: Record<string, unknown>; risk: string; category?: string; examples?: unknown[] }> } | undefined;
              if (searchOutput?.tools) {
                for (const discovered of searchOutput.tools) {
                  if (!llmToolDefs.some((d) => d.name === discovered.name)) {
                    const disc = {
                      name: discovered.name,
                      description: discovered.description,
                      risk: discovered.risk as import('./tools/types.js').ToolRisk,
                      parameters: discovered.parameters,
                      category: discovered.category as import('./tools/types.js').ToolCategory | undefined,
                    };
                    allToolDefs.push(disc);
                    llmToolDefs.push(toLLMToolDef(disc, toolResultProviderKind));
                  }
                }
              }
            }
          } else {
            // Push error result for rejected tool calls
            const failedTc = response.toolCalls[toolResults.indexOf(settled)];
            llmMessages.push({
              role: 'tool',
              toolCallId: failedTc?.id ?? '',
              content: JSON.stringify({ success: false, error: settled.reason?.message ?? 'Tool execution failed' }),
            });
          }
        }

        // Non-blocking approvals: only break if EVERY tool in this round is
        // pending approval.  When some tools succeeded, the LLM already sees their
        // results alongside the pending status, so it can compose a natural response
        // that acknowledges what's waiting and what it plans to do next.
        if (hasPending) {
          const allPending = toolResults.every(
            (s) => s.status === 'fulfilled' && (s.value.result as Record<string, unknown>).status === 'pending_approval',
          );
          if (allPending) {
            // Remove the 'pending' tool result messages we just pushed, so we don't send duplicate toolCallIds when resuming
            llmMessages.splice(-toolResults.length, toolResults.length);

            // Suspended Execution: cache the loop state so we can resume directly
            // when the user approves via out-of-band UI.
            const pendingTools: SuspendedToolCall[] = toolResults
              .filter((s) => s.status === 'fulfilled' && (s.value.result as Record<string, unknown>).status === 'pending_approval')
              .map((s) => {
                 const result = (s as any).value.result as Record<string, unknown>;
                 const toolCall = (s as any).value.toolCall;
                 return {
                   approvalId: String(result.approvalId),
                   toolCallId: toolCall.id,
                   jobId: String(result.jobId),
                   name: toolCall.name,
                 };
              });
              
            this.suspendedSessions.set(userKey, {
              userKey,
              llmMessages: [...llmMessages],
              pendingTools,
              originalMessage: suspended?.originalMessage ?? message,
              ctx,
            });
            break;
          }
        }

        // Per-tool provider routing: if any executed tool has a routing preference,
        // swap the provider for the next round so a better model synthesizes the result.
        if (this.resolveRoutedProviderForTools) {
          const executedTools = response.toolCalls.map((tc) => {
            const def = this.tools?.getToolDefinition?.(tc.name);
            return { name: tc.name, category: def?.category };
          });
          const routed = this.resolveRoutedProviderForTools(executedTools);
          if (routed) {
            const { provider: routedProvider, locality: routedLocality } = routed;
            chatFn = async (msgs, opts) => {
              try {
                return await routedProvider.chat(msgs, opts);
              } catch (err) {
                log.warn({ agent: this.id, routing: routedLocality, error: err instanceof Error ? err.message : String(err) },
                  'Routed provider failed, falling back to default');
                return this.chatWithFallback(ctx, msgs, opts);
              }
            };
            toolResultProviderKind = routedLocality;
            // Re-map tool definitions for the new provider's locality
            llmToolDefs = allToolDefs.map((d) => toLLMToolDef(d, toolResultProviderKind));
          }
        }

        rounds += 1;
      }

      // Quality-based fallback: if the local LLM produced an empty or degraded
      // response and we have a fallback chain with an external provider, retry.
      // Pass tool definitions (re-mapped for external provider) so the fallback
      // LLM can call tools, not just produce text.
      if (this.qualityFallbackEnabled && this.isResponseDegraded(finalContent) && this.fallbackChain && providerLocality === 'local') {
        log.warn({ agent: this.id, contentPreview: finalContent?.slice(0, 100) },
          'Local LLM produced degraded response, retrying with fallback chain');
        try {
          let externalToolDefs = llmToolDefs.map((d) => toLLMToolDef(d, 'external'));
          const fbMessages = [...llmMessages];
          const fallbackResult = await this.fallbackChain.chatWithFallbackAfterPrimary(fbMessages, { tools: externalToolDefs });
          const fbProvider = fallbackResult.providerName;

          // If the fallback LLM returned tool calls, execute them (single round)
          if (fallbackResult.response.toolCalls?.length && this.tools) {
            log.info({ agent: this.id, provider: fbProvider, toolCount: fallbackResult.response.toolCalls.length },
              'Fallback provider requested tool calls, executing');
            fbMessages.push({ role: 'assistant' as const, content: fallbackResult.response.content ?? '', toolCalls: fallbackResult.response.toolCalls });
            const fbToolOrigin = {
              origin: 'assistant' as const,
              agentId: this.id,
              userId: message.userId,
              channel: message.channel,
              requestId: message.id,
              agentContext: { checkAction: ctx.checkAction },
            };
            const fbToolResults = await Promise.allSettled(
              this.executeToolsConflictAware(fallbackResult.response.toolCalls, fbToolOrigin, { allowImplicitMemorySave })
            );
            let fallbackHasPending = false;
            for (const settled of fbToolResults) {
              if (settled.status === 'fulfilled') {
                const { toolCall, result: toolResult } = settled.value;

                if (toolResult.status === 'pending_approval' && toolResult.approvalId) {
                  pendingIds.push(String(toolResult.approvalId));
                  fallbackHasPending = true;
                }

                let resultForLlm = toolResult;
                if (toolResult.status === 'pending_approval') {
                  const { approvalId: _stripped, jobId: _stripJob, ...rest } = toolResult as Record<string, unknown>;
                  resultForLlm = {
                    ...rest,
                    message: 'This action needs your approval. The approval UI is shown to the user automatically.',
                  };
                }

                const scannedToolResult = this.sanitizeToolResultForLlm(
                  toolCall.name,
                  resultForLlm,
                  'external',
                );
                fbMessages.push({
                  role: 'tool' as const,
                  toolCallId: toolCall.id,
                  content: formatToolResultForLLM(
                    toolCall.name,
                    scannedToolResult.sanitized,
                    scannedToolResult.threats,
                  ),
                });

                if (toolCall.name === 'find_tools' && toolResult.success) {
                  const searchOutput = toolResult.output as {
                    tools?: Array<{
                      name: string;
                      description: string;
                      parameters: Record<string, unknown>;
                      risk: string;
                      category?: string;
                    }>;
                  } | undefined;
                  if (searchOutput?.tools) {
                    for (const discovered of searchOutput.tools) {
                      if (!llmToolDefs.some((d) => d.name === discovered.name)) {
                        const disc = {
                          name: discovered.name,
                          description: discovered.description,
                          risk: discovered.risk as import('./tools/types.js').ToolRisk,
                          parameters: discovered.parameters,
                          category: discovered.category as import('./tools/types.js').ToolCategory | undefined,
                        };
                        allToolDefs.push(disc);
                        llmToolDefs.push(toLLMToolDef(disc, toolResultProviderKind));
                      }
                    }
                    externalToolDefs = allToolDefs.map((d) => toLLMToolDef(d, 'external'));
                  }
                }
              } else {
                const failedTc = fallbackResult.response.toolCalls[fbToolResults.indexOf(settled)];
                fbMessages.push({
                  role: 'tool' as const,
                  toolCallId: failedTc?.id ?? '',
                  content: JSON.stringify({ success: false, error: settled.reason?.message ?? 'Tool execution failed' }),
                });
              }
            }

            if (fallbackHasPending) {
              const allPending = fbToolResults.every(
                (s) => s.status === 'fulfilled' && (s.value.result as Record<string, unknown>).status === 'pending_approval',
              );
              if (allPending) {
                fbMessages.splice(-fbToolResults.length, fbToolResults.length);
                const pendingTools: SuspendedToolCall[] = fbToolResults
                  .filter((s): s is PromiseFulfilledResult<{ toolCall: { id: string; name: string; arguments?: string }; result: Record<string, unknown> }> =>
                    s.status === 'fulfilled' && (s.value.result as Record<string, unknown>).status === 'pending_approval')
                  .map((s) => ({
                    approvalId: String(s.value.result.approvalId),
                    toolCallId: s.value.toolCall.id,
                    jobId: String(s.value.result.jobId),
                    name: s.value.toolCall.name,
                  }));
                this.suspendedSessions.set(userKey, {
                  userKey,
                  llmMessages: [...fbMessages],
                  pendingTools,
                  originalMessage: suspended?.originalMessage ?? message,
                  ctx,
                });
              } else {
                const finalFb = await this.fallbackChain.chatWithFallbackAfterPrimary(fbMessages, { tools: externalToolDefs });
                if (finalFb.response.content?.trim()) {
                  finalContent = finalFb.response.content;
                  log.info({ agent: this.id, provider: finalFb.providerName }, 'Fallback provider produced response after tool execution');
                }
              }
            } else {
              // One more chat call to get the final text response from fallback
              const finalFb = await this.fallbackChain.chatWithFallbackAfterPrimary(fbMessages, { tools: externalToolDefs });
              if (finalFb.response.content?.trim()) {
                finalContent = finalFb.response.content;
                log.info({ agent: this.id, provider: finalFb.providerName }, 'Fallback provider produced response after tool execution');
              }
            }
          } else if (fallbackResult.response.content?.trim()) {
            finalContent = fallbackResult.response.content;
            log.info({ agent: this.id, provider: fbProvider },
              'Fallback provider produced successful response');
          }
        } catch (fallbackErr) {
          log.warn({ agent: this.id, error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) },
            'Fallback chain also failed');
        }
      }

      // Store pending approvals for this user so they can be approved/denied explicitly
      if (pendingIds.length > 0) {
        const existing = this.getPendingApprovals(userKey)?.ids ?? [];
        const merged = [...new Set([...existing, ...pendingIds])];
        this.setPendingApprovals(userKey, merged);
        const summaries = this.tools?.getApprovalSummaries(merged);
        // Build structured approval metadata — all channels render native approval UI
        // (web: buttons, CLI: readline prompt, Telegram: inline keyboard).
        // No text prompt is appended to finalContent; the metadata is the canonical source.
        pendingApprovalMeta = merged.map((id) => {
          const s = summaries?.get(id);
          return { id, toolName: s?.toolName ?? 'unknown', argsPreview: s?.argsPreview ?? '' };
        });
        if (shouldUseStructuredPendingApprovalMessage(finalContent) || this.isResponseDegraded(finalContent)) {
          finalContent = formatPendingApprovalMessage(pendingApprovalMeta);
        }
      }

      if (!finalContent && lastToolRoundResults.length > 0) {
        finalContent = summarizeToolRoundFallback(lastToolRoundResults);
      }

      if (!finalContent) {
        finalContent = 'I could not generate a final response for that request.';
      }
    }

    if (this.conversationService) {
      this.conversationService.recordTurn(
        { agentId: stateAgentId, userId: message.userId, channel: message.channel },
        message.content,
        finalContent,
      );
    }

    const metadata: Record<string, unknown> = {};
    if (activeSkills.length > 0) metadata.activeSkills = activeSkills.map((skill) => skill.id);
    if (pendingApprovalMeta?.length) metadata.pendingApprovals = pendingApprovalMeta;

    return {
      content: finalContent,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  private buildImmediateResponseMetadata(
    activeSkills: ResolvedSkill[],
    userKey: string,
  ): Record<string, unknown> | undefined {
    const metadata: Record<string, unknown> = {};
    if (activeSkills.length > 0) {
      metadata.activeSkills = activeSkills.map((skill) => skill.id);
    }

    const pending = this.getPendingApprovals(userKey);
    if (pending?.ids.length) {
      const summaries = this.tools?.getApprovalSummaries(pending.ids);
      const pendingApprovalMeta = pending.ids.map((id) => {
        const summary = summaries?.get(id);
        return {
          id,
          toolName: summary?.toolName ?? 'unknown',
          argsPreview: summary?.argsPreview ?? '',
        };
      });
      if (pendingApprovalMeta.length > 0) {
        metadata.pendingApprovals = pendingApprovalMeta;
      }
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private shouldAllowImplicitMemorySave(content: string): boolean {
    return _shouldAllowImplicitMemorySave(content);
  }

  private tryDirectRecentToolReport(message: UserMessage): string | null {
    if (!this.tools?.isEnabled()) return null;
    if (!_isToolReportQuery(message.content)) return null;

    const jobs = this.tools.listJobs(50)
      .filter((job) => job.userId === message.userId && job.channel === message.channel);

    const report = _formatToolReport(jobs);
    return report || null;
  }

  private isResponseDegraded(content: string | undefined): boolean {
    return _isResponseDegraded(content);
  }

  private shouldRetryPolicyUpdateCorrection(
    messages: ChatMessage[],
    content: string | undefined,
    toolDefs: Array<{ name: string }>,
  ): boolean {
    const lower = content?.trim().toLowerCase();
    if (!lower) return false;
    if (!toolDefs.some((tool) => tool.name === 'update_tool_policy')) return false;

    const latestUser = [...messages].reverse().find((message) => message.role === 'user')?.content.toLowerCase() ?? '';
    const claimsToolMissing = lower.includes('update_tool_policy') && (
      lower.includes('not available')
      || lower.includes('unavailable')
      || lower.includes('no such tool')
      || lower.includes('no equivalent tool')
      || lower.includes('search returned no results')
      || lower.includes('search returned no matches')
    );
    const pushesManualConfig = lower.includes('manually add')
      || lower.includes('manually update')
      || lower.includes('edit the configuration file')
      || lower.includes('update your guardian agent config')
      || lower.includes('you will need to manually');
    const isPolicyScoped = /(allowlist|allow list|allowed domains|alloweddomains|allowed paths|allowed commands|outside the sandbox|blocked by policy|not in the allowed|not in alloweddomains)/.test(`${latestUser}\n${lower}`);

    return isPolicyScoped && (claimsToolMissing || pushesManualConfig);
  }

  private buildPolicyUpdateCorrectionPrompt(): string {
    return [
      'System correction: update_tool_policy is available in your current tool list.',
      'Do not tell the user to edit config manually for allowlist changes.',
      'If the block is a filesystem path, call update_tool_policy with action "add_path".',
      'If the block is a hostname/domain, call update_tool_policy with action "add_domain" using the normalized hostname only.',
      'If the block is a command prefix, call update_tool_policy with action "add_command".',
      'Use the tool now if policy is the blocker.',
    ].join(' ');
  }

  private resolveToolResultProviderKind(
    ctx: AgentContext,
    overrideProvider?: LLMProvider,
  ): 'local' | 'external' {
    const providerName = (overrideProvider?.name ?? ctx.llm?.name ?? '').trim().toLowerCase();
    return providerName === 'ollama' ? 'local' : 'external';
  }

  private sanitizeToolResultForLlm(
    toolName: string,
    result: unknown,
    providerKind: 'local' | 'external',
  ): { sanitized: unknown; threats: string[] } {
    if (!this.outputGuardian) {
      return { sanitized: result, threats: [] };
    }

    const scan = this.outputGuardian.scanToolResult(toolName, result, { providerKind });
    return {
      sanitized: scan.sanitized,
      threats: scan.threats,
    };
  }

  /**
   * Check if the user's message is an approval decision for pending tool actions.
   * If so, execute approval/denial and return a summary.
   */
  private async tryHandleApproval(message: UserMessage, userKey: string): Promise<string | null> {
    if (!this.tools?.isEnabled()) return null;

    const pending = this.getPendingApprovals(userKey);
    if (!pending?.ids.length) return null;

    const input = message.content.trim();
    const isApprove = APPROVAL_CONFIRM_PATTERN.test(input);
    const isDeny = APPROVAL_DENY_PATTERN.test(input);
    if (!isApprove && !isDeny) return null;

    const decision: 'approved' | 'denied' = isDeny ? 'denied' : 'approved';
    let targetIds = pending.ids;
    if (APPROVAL_COMMAND_PATTERN.test(input)) {
      const selected = this.resolveApprovalTargets(input, pending.ids);
      if (selected.errors.length > 0) {
        const summaries = this.tools?.getApprovalSummaries(pending.ids);
        return [
          selected.errors.join('\n'),
          '',
          this.formatPendingApprovalPrompt(pending.ids, summaries),
        ].join('\n');
      }
      targetIds = selected.ids;
    }

    if (targetIds.length === 0) {
      const summaries = this.tools?.getApprovalSummaries(pending.ids);
      return this.formatPendingApprovalPrompt(pending.ids, summaries);
    }

    const remaining = pending.ids.filter((id) => !targetIds.includes(id));
    this.setPendingApprovals(userKey, remaining);
    const results: string[] = [];
    for (const approvalId of targetIds) {
      try {
        const result = await this.tools.decideApproval(approvalId, decision, message.userId);
        if (result.success) {
          const followUp = this.takeApprovalFollowUp(approvalId, decision);
          results.push(followUp ?? result.message ?? `${decision === 'approved' ? 'Approved and executed' : 'Denied'} (${approvalId}).`);
        } else {
          this.clearApprovalFollowUp(approvalId);
          const failure = result.message ?? `${decision === 'approved' ? 'Approval' : 'Denial'} failed (${approvalId}).`;
          results.push(
            decision === 'approved'
              ? `Approval received for ${approvalId}, but execution failed: ${failure}`
              : `Denial for ${approvalId} failed: ${failure}`,
          );
        }
      } catch (err) {
        this.clearApprovalFollowUp(approvalId);
        results.push(`Error processing ${approvalId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (remaining.length > 0) {
      const summaries = this.tools?.getApprovalSummaries(remaining);
      results.push('');
      results.push(this.formatPendingApprovalPrompt(remaining, summaries));
    }
    return results.join('\n');
  }

  private getPendingApprovals(userKey: string, nowMs: number = Date.now()): PendingApprovalState | null {
    const state = this.pendingApprovals.get(userKey);
    if (!state) return null;
    if (state.expiresAt <= nowMs) {
      this.pendingApprovals.delete(userKey);
      return null;
    }
    return state;
  }

  private setPendingApprovals(userKey: string, ids: string[], nowMs: number = Date.now()): void {
    const uniqueIds = [...new Set(ids.filter((id) => id.trim().length > 0))];
    if (uniqueIds.length === 0) {
      this.pendingApprovals.delete(userKey);
      return;
    }
    const existing = this.pendingApprovals.get(userKey);
    this.pendingApprovals.set(userKey, {
      ids: uniqueIds,
      createdAt: existing?.createdAt ?? nowMs,
      expiresAt: nowMs + PENDING_APPROVAL_TTL_MS,
    });
  }

  private setApprovalFollowUp(approvalId: string, copy: ApprovalFollowUpCopy): void {
    const normalizedId = approvalId.trim();
    if (!normalizedId) return;
    this.approvalFollowUps.set(normalizedId, copy);
  }

  private clearApprovalFollowUp(approvalId: string): void {
    this.approvalFollowUps.delete(approvalId.trim());
  }

  takeApprovalFollowUp(approvalId: string, decision: 'approved' | 'denied'): string | null {
    const normalizedId = approvalId.trim();
    if (!normalizedId) return null;
    const copy = this.approvalFollowUps.get(normalizedId);
    if (!copy) return null;
    this.approvalFollowUps.delete(normalizedId);
    return decision === 'approved'
      ? (copy.approved ?? null)
      : (copy.denied ?? null);
  }

  hasSuspendedApproval(approvalId: string): boolean {
    const normalizedId = approvalId.trim();
    if (!normalizedId) return false;
    for (const session of this.suspendedSessions.values()) {
      if (session.pendingTools.some((tool) => tool.approvalId === normalizedId)) {
        return true;
      }
    }
    return false;
  }

  private syncPendingApprovalsFromExecutor(userKey: string, userId: string, channel: string): void {
    if (!this.tools?.isEnabled()) return;
    const ids = this.tools.listPendingApprovalIdsForUser(userId, channel, {
      includeUnscoped: channel === 'web',
    });
    this.setPendingApprovals(userKey, ids);
  }

  private resolveApprovalTargets(
    input: string,
    pendingIds: string[],
  ): { ids: string[]; errors: string[] } {
    const argsText = input.replace(APPROVAL_COMMAND_PATTERN, '').trim();
    if (!argsText) return { ids: pendingIds, errors: [] };
    const rawTokens = argsText
      .split(/[,\s]+/)
      .map((token) => token.trim().replace(/^\[+|\]+$/g, ''))
      .filter(Boolean)
      .filter((token) => APPROVAL_ID_TOKEN_PATTERN.test(token));
    if (rawTokens.length === 0) return { ids: pendingIds, errors: [] };

    const selected = new Set<string>();
    const errors: string[] = [];
    for (const token of rawTokens) {
      if (pendingIds.includes(token)) {
        selected.add(token);
        continue;
      }
      const matches = pendingIds.filter((id) => id.startsWith(token));
      if (matches.length === 1) {
        selected.add(matches[0]);
      } else if (matches.length > 1) {
        errors.push(`Approval ID prefix '${token}' is ambiguous.`);
      } else {
        errors.push(`Approval ID '${token}' was not found for this chat.`);
      }
    }
    return { ids: [...selected], errors };
  }

  private formatPendingApprovalPrompt(
    ids: string[],
    summaries?: Map<string, { toolName: string; argsPreview: string }>,
  ): string {
    if (ids.length === 0) return 'There are no pending approvals.';
    const ttlMinutes = Math.round(PENDING_APPROVAL_TTL_MS / 60_000);
    if (ids.length === 1) {
      const summary = summaries?.get(ids[0]);
      const what = summary
        ? `Action: ${summary.toolName}${summary.argsPreview ? ` — ${summary.argsPreview}` : ''}`
        : undefined;
      return [
        what ?? 'I prepared an action that needs your approval.',
        `Approval ID: ${ids[0]}`,
        `Reply "yes" to approve or "no" to deny (expires in ${ttlMinutes} minutes).`,
        'Optional: /approve or /deny',
      ].join('\n');
    }
    const lines = [`I prepared ${ids.length} actions that need your approval.`];
    for (const id of ids) {
      const summary = summaries?.get(id);
      if (summary) {
        lines.push(`  • ${summary.toolName}${summary.argsPreview ? ` — ${summary.argsPreview}` : ''} (${id.slice(0, 8)}…)`);
      } else {
        lines.push(`  • ${id}`);
      }
    }
    lines.push(`Reply "yes" to approve all or "no" to deny all (expires in ${ttlMinutes} minutes).`);
    lines.push('Optional: /approve <id> or /deny <id> for specific actions');
    return lines.join('\n');
  }

  private async tryDirectWebSearch(
    message: UserMessage,
    ctx: AgentContext,
  ): Promise<string | null> {
    if (!this.tools?.isEnabled()) return null;

    const query = parseWebSearchIntent(message.content);
    if (!query) return null;

    const toolResult = await this.tools.executeModelTool(
      'web_search',
      { query, maxResults: 10 },
      {
        origin: 'assistant',
        agentId: this.id,
        userId: message.userId,
        channel: message.channel,
        requestId: message.id,
        agentContext: { checkAction: ctx.checkAction },
      },
    );

    if (!toBoolean(toolResult.success)) {
      const msg = toString(toolResult.message) || toString(toolResult.error) || 'Web search failed.';
      return `I tried to search the web for "${query}" but it failed: ${msg}`;
    }

    const output = (toolResult.output && typeof toolResult.output === 'object'
      ? toolResult.output
      : null) as {
        provider?: unknown;
        results?: unknown;
        answer?: unknown;
      } | null;

    const provider = output ? toString(output.provider) : 'unknown';
    const results = output && Array.isArray(output.results)
      ? output.results as Array<{ title?: unknown; url?: unknown; snippet?: unknown }>
      : [];
    const answer = output ? toString(output.answer) : '';

    if (results.length === 0 && !answer) {
      return `I searched the web for "${query}" (via ${provider}) but found no results.`;
    }

    const lines = [`Web search results for "${query}" (via ${provider}):\n`];
    if (answer) {
      lines.push(`Summary: ${answer}\n`);
    }
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const title = toString(r.title) || '(untitled)';
      const url = toString(r.url);
      const snippet = toString(r.snippet);
      lines.push(`${i + 1}. **${title}**`);
      if (url) lines.push(`   ${url}`);
      if (snippet) lines.push(`   ${snippet}`);
    }
    return lines.join('\n');
  }

  private async tryDirectGoogleWorkspaceWrite(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
  ): Promise<string | null> {
    if (!this.tools?.isEnabled()) return null;

    const intent = parseDirectGmailWriteIntent(message.content);
    if (!intent) return null;

    const missing: string[] = [];
    if (!intent.to) missing.push('recipient email');
    if (!intent.subject) missing.push('subject');
    if (!intent.body) missing.push('body');
    if (missing.length > 0) {
      return `To ${intent.mode} a Gmail email, I need the ${missing.join(', ')}.`;
    }
    const to = intent.to!;
    const subject = intent.subject!;
    const body = intent.body!;

    const toolRequest = {
      origin: 'assistant' as const,
      agentId: this.id,
      userId: message.userId,
      channel: message.channel,
      requestId: message.id,
      agentContext: { checkAction: ctx.checkAction },
    };

    const raw = buildGmailRawMessage({
      to,
      subject,
      body,
    });
    const method = intent.mode === 'send' ? 'send' : 'create';
    const resource = intent.mode === 'send' ? 'users messages' : 'users drafts';
    const json = intent.mode === 'send'
      ? { raw }
      : { message: { raw } };

    const toolResult = await this.tools.executeModelTool(
      'gws',
      {
        service: 'gmail',
        resource,
        method,
        params: { userId: 'me' },
        json,
      },
      toolRequest,
    );

    if (!toBoolean(toolResult.success)) {
      const status = toString(toolResult.status);
      if (status === 'pending_approval') {
        const approvalId = toString(toolResult.approvalId);
        const existingIds = this.getPendingApprovals(userKey)?.ids ?? [];
        if (approvalId) {
          this.setPendingApprovals(userKey, [
            ...existingIds,
            approvalId,
          ]);
          this.setApprovalFollowUp(approvalId, {
            approved: intent.mode === 'send'
              ? 'I sent the Gmail message.'
              : 'I drafted the Gmail message.',
            denied: intent.mode === 'send'
              ? 'I did not send the Gmail message.'
              : 'I did not draft the Gmail message.',
          });
        }
        const prompt = this.formatPendingApprovalPrompt(approvalId ? [approvalId] : []);
        return [
          `I prepared a Gmail ${intent.mode} to ${to} with subject "${subject}", but it needs approval first.`,
          prompt,
        ].filter(Boolean).join('\n\n');
      }
      const msg = toString(toolResult.message) || toString(toolResult.error) || 'Google Workspace request failed.';
      return `I tried to ${intent.mode} the Gmail message, but it failed: ${msg}`;
    }

    return intent.mode === 'send'
      ? `I sent the Gmail message to ${to} with subject "${subject}".`
      : `I drafted a Gmail message to ${to} with subject "${subject}".`;
  }

  private async tryDirectScheduledEmailAutomation(
    message: UserMessage,
    ctx: AgentContext,
    userKey: string,
    stateAgentId: string,
  ): Promise<string | null> {
    if (!this.tools?.isEnabled() || !this.conversationService) return null;

    const history = this.conversationService.getHistoryForContext({
      agentId: stateAgentId,
      userId: message.userId,
      channel: message.channel,
    });
    if (history.length === 0) return null;

    const detailIntent = parseDirectGmailWriteIntent(message.content);
    if (!detailIntent || (!detailIntent.subject && !detailIntent.body)) return null;

    const priorUserRequest = [...history]
      .reverse()
      .find((entry) => entry.role === 'user' && parseScheduledEmailAutomationIntent(entry.content));
    if (!priorUserRequest) return null;

    const scheduledIntent = parseScheduledEmailAutomationIntent(priorUserRequest.content);
    if (!scheduledIntent) return null;

    const subject = detailIntent.subject?.trim();
    const body = detailIntent.body?.trim();
    if (!subject || !body) {
      return 'To schedule that email automation, I still need both the subject and the body text.';
    }

    const to = detailIntent.to?.trim() || scheduledIntent.to;
    if (!to) {
      return 'To schedule that email automation, I still need the recipient email address.';
    }

    const raw = buildGmailRawMessage({ to, subject, body });
    const taskName = scheduledIntent.runOnce
      ? `Scheduled Email to ${to}`
      : `Daily Email to ${to}`;
    const toolRequest = {
      origin: 'assistant' as const,
      agentId: this.id,
      userId: message.userId,
      channel: message.channel,
      requestId: message.id,
      agentContext: { checkAction: ctx.checkAction },
    };

    const toolResult = await this.tools.executeModelTool(
      'task_create',
      {
        name: taskName,
        type: 'tool',
        target: 'gws',
        cron: scheduledIntent.cron,
        runOnce: scheduledIntent.runOnce,
        enabled: true,
        args: {
          service: 'gmail',
          resource: 'users messages',
          method: 'send',
          params: { userId: 'me' },
          json: { raw },
        },
      },
      toolRequest,
    );

    if (!toBoolean(toolResult.success)) {
      const status = toString(toolResult.status);
      if (status === 'pending_approval') {
        const approvalId = toString(toolResult.approvalId);
        const existingIds = this.getPendingApprovals(userKey)?.ids ?? [];
        if (approvalId) {
          this.setPendingApprovals(userKey, [...existingIds, approvalId]);
          this.setApprovalFollowUp(approvalId, {
            approved: scheduledIntent.runOnce
              ? `I created the one-shot email task to ${to}.`
              : `I created the recurring email task to ${to}.`,
            denied: 'I did not create the scheduled email task.',
          });
        }
        const prompt = this.formatPendingApprovalPrompt(approvalId ? [approvalId] : []);
        return [
          `I prepared a ${scheduledIntent.runOnce ? 'one-shot' : 'recurring'} email task to ${to}${scheduledIntent.runOnce ? '' : ' with a daily schedule'}.`,
          prompt,
        ].filter(Boolean).join('\n\n');
      }
      const msg = toString(toolResult.message) || toString(toolResult.error) || 'Scheduled email task creation failed.';
      return `I tried to create the scheduled email task, but it failed: ${msg}`;
    }

    return scheduledIntent.runOnce
      ? `I created a one-shot email task to ${to}. It will run on the next scheduled time.`
      : `I created a recurring daily email task to ${to}.`;
  }

  private async tryDirectGoogleWorkspaceRead(
    message: UserMessage,
    ctx: AgentContext,
  ): Promise<string | null> {
    if (!this.tools?.isEnabled()) return null;

    const intent = parseDirectGoogleWorkspaceIntent(message.content);
    if (!intent) return null;

    const toolRequest = {
      origin: 'assistant' as const,
      agentId: this.id,
      userId: message.userId,
      channel: message.channel,
      requestId: message.id,
      agentContext: { checkAction: ctx.checkAction },
    };

    const listParams: Record<string, unknown> = {
      userId: 'me',
      maxResults: intent.kind === 'gmail_unread' ? Math.max(intent.count, 10) : intent.count,
    };
    if (intent.kind === 'gmail_unread') {
      listParams.q = 'is:unread';
    }

    const listResult = await this.tools.executeModelTool(
      'gws',
      {
        service: 'gmail',
        resource: 'users messages',
        method: 'list',
        params: listParams,
      },
      toolRequest,
    );

    if (!toBoolean(listResult.success)) {
      const status = toString(listResult.status);
      if (status === 'pending_approval') {
        const approvalId = toString(listResult.approvalId) || 'unknown';
        return `I prepared a Gmail inbox check, but it needs approval first (approval ID: ${approvalId}).`;
      }
      const msg = toString(listResult.message) || toString(listResult.error) || 'Google Workspace request failed.';
      return `I tried to check Gmail for unread messages, but it failed: ${msg}`;
    }

    const output = (listResult.output && typeof listResult.output === 'object'
      ? listResult.output
      : null) as { messages?: unknown; resultSizeEstimate?: unknown } | null;
    const messages = output && Array.isArray(output.messages)
      ? output.messages as Array<{ id?: unknown }>
      : [];
    const resultSizeEstimate = output ? toNumber(output.resultSizeEstimate) : null;
    const unreadCount = Math.max(resultSizeEstimate ?? 0, messages.length);

    if (messages.length === 0) {
      if (intent.kind === 'gmail_recent_senders') {
        return 'I checked Gmail and could not find any recent messages.';
      }
      if (intent.kind === 'gmail_recent_summary') {
        return 'I checked Gmail and could not find any recent messages to summarize.';
      }
      return 'I checked Gmail and found no unread messages.';
    }

    const summaries: GmailMessageSummary[] = [];
    for (const entry of messages.slice(0, 5)) {
      const id = toString(entry.id);
      if (!id) continue;

      const detailResult = await this.tools.executeModelTool(
        'gws',
        {
          service: 'gmail',
          resource: 'users messages',
          method: 'get',
          params: {
            userId: 'me',
            id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          },
        },
        toolRequest,
      );

      if (!toBoolean(detailResult.success)) continue;

      const summary = summarizeGmailMessage(detailResult.output);
      if (summary) summaries.push(summary);
    }

    if (intent.kind === 'gmail_recent_senders') {
      if (summaries.length === 0) {
        return `I found ${messages.length} recent message${messages.length === 1 ? '' : 's'}, but I could not read their sender metadata.`;
      }
      const lines = [`The senders of the last ${summaries.length} email${summaries.length === 1 ? '' : 's'} are:`];
      for (const [index, summary] of summaries.entries()) {
        const from = summary.from || 'Unknown sender';
        const subject = summary.subject || '(no subject)';
        lines.push(`${index + 1}. ${from} — ${subject}`);
      }
      return lines.join('\n');
    }

    if (intent.kind === 'gmail_recent_summary') {
      if (summaries.length === 0) {
        return `I found ${messages.length} recent message${messages.length === 1 ? '' : 's'}, but I could not read enough metadata to summarize them.`;
      }
      const lines = [`Here are the last ${summaries.length} email${summaries.length === 1 ? '' : 's'}:`];
      for (const [index, summary] of summaries.entries()) {
        const subject = summary.subject || '(no subject)';
        const from = summary.from || 'Unknown sender';
        lines.push(`${index + 1}. ${subject} — ${from}`);
        if (summary.date) lines.push(`   ${summary.date}`);
        if (summary.snippet) lines.push(`   ${summary.snippet}`);
      }
      return lines.join('\n');
    }

    const lines = [
      `I checked Gmail and found ${unreadCount} unread message${unreadCount === 1 ? '' : 's'}.`,
    ];

    if (summaries.length === 0) {
      for (const [index, entry] of messages.slice(0, 5).entries()) {
        const id = toString(entry.id);
        if (!id) continue;
        lines.push(`${index + 1}. Message ID: ${id}`);
      }
    } else {
      for (const [index, summary] of summaries.entries()) {
        const subject = summary.subject || '(no subject)';
        const from = summary.from || 'Unknown sender';
        lines.push(`${index + 1}. ${subject} — ${from}`);
        if (summary.date) lines.push(`   ${summary.date}`);
        if (summary.snippet) lines.push(`   ${summary.snippet}`);
      }
    }

    if (unreadCount > 5) {
      lines.push(`...and ${unreadCount - 5} more unread message${unreadCount - 5 === 1 ? '' : 's'}.`);
    }

    if (intent.kind === 'gmail_unread') {
      lines.push('Ask me to read or summarize any of these if you want the full details.');
    }

    return lines.join('\n');
  }

  private async tryDirectFilesystemSearch(
    message: UserMessage,
    ctx: AgentContext,
  ): Promise<string | null> {
    if (!this.tools?.isEnabled()) return null;

    const intent = parseDirectFileSearchIntent(message.content, this.tools.getPolicy());
    if (!intent) return null;

    const toolResult = await this.tools.executeModelTool(
      'fs_search',
      {
        path: intent.path,
        query: intent.query,
        mode: 'auto',
        maxResults: 50,
        maxDepth: 20,
      },
      {
        origin: 'assistant',
        agentId: this.id,
        userId: message.userId,
        channel: message.channel,
        requestId: message.id,
        agentContext: { checkAction: ctx.checkAction },
      },
    );

    if (!toBoolean(toolResult.success)) {
      const status = toString(toolResult.status);
      if (status === 'pending_approval') {
        const approvalId = toString(toolResult.approvalId) || 'unknown';
        return `I prepared a filesystem search for "${intent.query}" but it needs approval first (approval ID: ${approvalId}).`;
      }
      const msg = toString(toolResult.message) || 'Search failed.';
      return `I attempted a filesystem search in "${intent.path}" for "${intent.query}" but it failed: ${msg}`;
    }

    const output = (toolResult.output && typeof toolResult.output === 'object'
      ? toolResult.output
      : null) as {
        root?: unknown;
        scannedFiles?: unknown;
        truncated?: unknown;
        matches?: unknown;
      } | null;
    const root = output ? toString(output.root) : intent.path;
    const scannedFiles = output ? toNumber(output.scannedFiles) : null;
    const truncated = output ? toBoolean(output.truncated) : false;
    const matches = output && Array.isArray(output.matches)
      ? output.matches as Array<{ relativePath?: unknown; path?: unknown; matchType?: unknown; snippet?: unknown }>
      : [];

    if (matches.length === 0) {
      return `I searched "${root || intent.path}" for "${intent.query}" and found no matches${scannedFiles !== null ? ` (scanned ${scannedFiles} files)` : ''}.`;
    }

    const lines = [
      `I searched "${root || intent.path}" for "${intent.query}"${scannedFiles !== null ? ` (scanned ${scannedFiles} files)` : ''}.`,
      `Found ${matches.length} match${matches.length === 1 ? '' : 'es'}:`,
    ];
    for (const match of matches.slice(0, 20)) {
      const relativePath = toString(match.relativePath) || toString(match.path) || '(unknown path)';
      const matchType = toString(match.matchType) || 'name';
      if (matchType === 'content' && toString(match.snippet)) {
        lines.push(`- ${relativePath} [content]: ${toString(match.snippet)}`);
      } else {
        lines.push(`- ${relativePath} [${matchType}]`);
      }
    }
    if (matches.length > 20) {
      lines.push(`- ...and ${matches.length - 20} more`);
    }
    if (truncated) {
      lines.push('Search stopped at configured limits; narrow query or increase maxResults/maxFiles if needed.');
    }
    return lines.join('\n');
  }
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function summarizeToolRoundFallback(results: Array<{ toolName: string; result: Record<string, unknown> }>): string {
  const summaries = results
    .map(({ toolName, result }) => summarizeSingleToolFallback(toolName, result))
    .filter((summary): summary is string => !!summary);
  if (summaries.length === 0) return '';
  if (summaries.length === 1) return summaries[0];
  return `Completed the requested actions:\n${summaries.map((summary) => `- ${summary}`).join('\n')}`;
}

function summarizeSingleToolFallback(toolName: string, result: Record<string, unknown>): string {
  const message = toString(result.message).trim() || extractToolFallbackOutputMessage(result);
  if (message) return message;

  const status = toString(result.status).trim().toLowerCase();
  if (status === 'pending_approval') return `${toolName} is awaiting approval.`;
  if (result.success === true || status === 'succeeded' || status === 'completed') return `Completed ${toolName}.`;
  return `Attempted ${toolName}, but it did not complete successfully.`;
}

function extractToolFallbackOutputMessage(result: Record<string, unknown>): string {
  if (!isRecord(result.output)) return '';
  return toString(result.output.message).trim();
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface DirectGoogleWorkspaceIntent {
  kind: 'gmail_unread' | 'gmail_recent_senders' | 'gmail_recent_summary';
  count: number;
}

interface GmailMessageSummary {
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

function summarizeGmailMessage(output: unknown): GmailMessageSummary | null {
  if (!output || typeof output !== 'object') return null;

  const data = output as {
    snippet?: unknown;
    payload?: { headers?: unknown };
  };
  const headers = Array.isArray(data.payload?.headers)
    ? data.payload.headers as Array<{ name?: unknown; value?: unknown }>
    : [];

  return {
    from: findHeaderValue(headers, 'from'),
    subject: findHeaderValue(headers, 'subject'),
    date: findHeaderValue(headers, 'date'),
    snippet: toString(data.snippet),
  };
}

function findHeaderValue(
  headers: Array<{ name?: unknown; value?: unknown }>,
  name: string,
): string {
  const target = name.toLowerCase();
  for (const header of headers) {
    if (toString(header.name).toLowerCase() === target) {
      return toString(header.value);
    }
  }
  return '';
}

function parseDirectGoogleWorkspaceIntent(content: string): DirectGoogleWorkspaceIntent | null {
  const text = content.trim();
  if (!text) return null;

  if (/\b(send|draft|compose|reply|forward)\b/i.test(text)) return null;
  if (!/\b(gmail|inbox|email|emails|mail)\b/i.test(text)) return null;
  const count = parseRequestedEmailCount(text);

  const unreadInboxPatterns = [
    /\bcheck\s+(?:my\s+)?(?:gmail|inbox|email|emails|mail)\b/i,
    /\b(?:show|list)\s+(?:my\s+)?(?:gmail|inbox|emails?|mail)\b/i,
    /\b(?:new|latest|recent|unread)\s+(?:gmail|emails?|mail)\b/i,
    /\bany\s+new\s+emails?\b/i,
    /\bwhat(?:'s|\s+is)?\s+(?:new\s+)?in\s+(?:my\s+)?(?:gmail|inbox)\b/i,
    /\bwhat\s+(?:new|recent|unread)\s+emails?\s+do\s+i\s+have\b/i,
  ];

  if (unreadInboxPatterns.some((pattern) => pattern.test(text))) {
    return { kind: 'gmail_unread', count: Math.max(count, 10) };
  }

  if (/\b(?:sender|senders|from|who sent)\b/i.test(text)
    && /\b(?:last|latest|recent)\b/i.test(text)
    && /\bemails?|mail\b/i.test(text)) {
    return { kind: 'gmail_recent_senders', count };
  }

  if (/\b(?:last|latest|recent)\b/i.test(text)
    && /\bemails?|mail\b/i.test(text)
    && /\b(?:detail|details|summary|summarize|subject|snippet|snippets)\b/i.test(text)) {
    return { kind: 'gmail_recent_summary', count };
  }

  return null;
}

function parseRequestedEmailCount(text: string): number {
  const digitMatch = text.match(/\b(?:last|latest|recent)\s+(\d+)\s+emails?\b/i)
    || text.match(/\b(\d+)\s+emails?\b/i);
  if (digitMatch) {
    const parsed = Number(digitMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 10);
  }

  const wordMap: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  const wordMatch = text.match(/\b(?:last|latest|recent)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+emails?\b/i)
    || text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+emails?\b/i);
  if (wordMatch) {
    return wordMap[wordMatch[1].toLowerCase()] ?? 3;
  }

  return 3;
}

/** Convert a ToolDefinition to LLM-ready format.
 * Local models get full descriptions for better tool selection;
 * external models get shortDescription to save tokens. */
function toLLMToolDef(def: import('./tools/types.js').ToolDefinition, locality: 'local' | 'external' = 'external'): import('./tools/types.js').ToolDefinition {
  return {
    name: def.name,
    description: locality === 'local' ? def.description : (def.shortDescription ?? def.description),
    risk: def.risk,
    parameters: def.parameters,
    examples: def.examples,
  };
}

type ProviderRoutePreference = 'local' | 'external' | 'default';

/**
 * Natural locality for each tool category.
 * "External" categories involve external APIs/services and benefit from smarter models.
 * "Local" categories operate on the local machine and are fine with local models.
 */
const CATEGORY_NATURAL_LOCALITY: Record<string, 'local' | 'external'> = {
  filesystem: 'local',
  shell: 'local',
  network: 'local',
  system: 'local',
  memory: 'local',
  automation: 'external',
  web: 'external',
  browser: 'external',
  workspace: 'external',
  email: 'external',
  contacts: 'external',
  forum: 'external',
  intel: 'external',
  search: 'external',
};

/**
 * Compute effective per-category routing defaults based on available providers.
 * - Both local + external available: use natural locality per category
 * - Only local available: everything routes to local
 * - Only external available: everything routes to external
 */
function computeCategoryDefaults(
  llmConfig: Record<string, { provider?: string; baseUrl?: string }>,
): Record<string, 'local' | 'external'> {
  const hasLocal = Object.values(llmConfig).some((cfg) =>
    !!cfg.provider && isLocalProviderEndpoint(cfg.baseUrl, cfg.provider),
  );
  const hasExternal = Object.values(llmConfig).some((cfg) =>
    !!cfg.provider && !isLocalProviderEndpoint(cfg.baseUrl, cfg.provider),
  );

  const defaults: Record<string, 'local' | 'external'> = {};
  for (const [category, natural] of Object.entries(CATEGORY_NATURAL_LOCALITY)) {
    if (hasLocal && hasExternal) {
      defaults[category] = natural;
    } else if (hasLocal) {
      defaults[category] = 'local';
    } else {
      defaults[category] = 'external';
    }
  }
  return defaults;
}

/**
 * Given tools just executed, resolve the provider routing preference for the
 * next LLM call. Resolution order:
 *   1. User per-tool override (providerRouting config)
 *   2. User per-category override (providerRouting config)
 *   3. Computed category default (based on available providers)
 * 'external' wins when multiple tools conflict.
 */
function resolveToolProviderRouting(
  executedTools: Array<{ name: string; category?: string }>,
  routingMap: Record<string, ProviderRoutePreference> | undefined,
  categoryDefaults?: Record<string, 'local' | 'external'>,
): ProviderRoutePreference {
  const hasRouting = routingMap && Object.keys(routingMap).length > 0;
  const hasDefaults = categoryDefaults && Object.keys(categoryDefaults).length > 0;
  if (!hasRouting && !hasDefaults) return 'default';

  let result: ProviderRoutePreference = 'default';

  for (const tool of executedTools) {
    // 1. User per-tool override (most specific)
    const toolRoute = routingMap?.[tool.name];
    if (toolRoute && toolRoute !== 'default') {
      if (toolRoute === 'external') return 'external';
      result = toolRoute;
      continue;
    }
    // 2. User per-category override
    if (tool.category) {
      const catRoute = routingMap?.[tool.category];
      if (catRoute && catRoute !== 'default') {
        if (catRoute === 'external') return 'external';
        if (result === 'default') result = catRoute;
        continue;
      }
      // 3. Computed category default
      const computedRoute = categoryDefaults?.[tool.category];
      if (computedRoute) {
        if (computedRoute === 'external') return 'external';
        if (result === 'default') result = computedRoute;
      }
    }
  }

  return result;
}

/** If total context exceeds 80% of budget, summarize oldest tool results. */
function compactMessagesIfOverBudget(messages: ChatMessage[], budget: number): void {
  _compactMessagesIfOverBudget(messages, budget);
}

function formatToolResultForLLM(toolName: string, toolResult: unknown, threats: string[] = []): string {
  const warningBlock = formatToolThreatWarnings(threats);
  const payloadBudget = Math.max(1_500, MAX_TOOL_RESULT_MESSAGE_CHARS - warningBlock.length - toolName.length - 120);
  const serialized = serializeToolResultForLLM(toolName, toolResult, payloadBudget);
  const envelope = classifyToolResultEnvelope(toolName);

  return [
    `<tool_result name="${escapeToolResultAttribute(toolName)}" source="${envelope.source}" trust="${envelope.trust}">`,
    warningBlock || undefined,
    serialized,
    '</tool_result>',
  ].filter(Boolean).join('\n');
}

function serializeToolResultForLLM(toolName: string, toolResult: unknown, maxChars: number): string {
  const compact = compactToolResultForLLM(toolName, toolResult);
  const serialized = safeJsonStringify(compact);
  if (serialized.length <= maxChars) {
    return serialized;
  }

  const result = toolResult && typeof toolResult === 'object'
    ? toolResult as Record<string, unknown>
    : {};
  return safeJsonStringify({
    success: result.success === true,
    status: toString(result.status),
    message: truncateText(toString(result.message), 400),
    error: truncateText(toString(result.error), 400),
    outputPreview: truncateText(safeJsonStringify(compactToolOutputForLLM(toolName, result.output)), Math.max(600, maxChars - 300)),
    truncated: true,
  });
}

function formatToolThreatWarnings(threats: string[]): string {
  const unique = [...new Set(threats.map((threat) => threat.trim()).filter(Boolean))];
  return unique.slice(0, 4).map((threat) => `[WARNING: ${threat}]`).join('\n');
}

function classifyToolResultEnvelope(toolName: string): { source: 'local' | 'remote'; trust: 'internal' | 'external' } {
  const normalized = toolName.toLowerCase();
  if (/^(web_|chrome_|browser_|mcp-|gws$|gmail_|forum_|campaign_|contacts_)/.test(normalized)) {
    return { source: 'remote', trust: 'external' };
  }
  return { source: 'local', trust: 'internal' };
}

function escapeToolResultAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function compactToolResultForLLM(toolName: string, toolResult: unknown): unknown {
  if (!toolResult || typeof toolResult !== 'object') {
    return compactValueForLLM(toolResult);
  }

  const result = toolResult as Record<string, unknown>;
  return {
    success: result.success,
    status: result.status,
    message: compactValueForLLM(result.message),
    error: compactValueForLLM(result.error),
    approvalId: compactValueForLLM(result.approvalId),
    jobId: compactValueForLLM(result.jobId),
    preview: compactValueForLLM(result.preview),
    output: compactToolOutputForLLM(toolName, result.output),
  };
}

function compactToolOutputForLLM(toolName: string, output: unknown): unknown {
  if (toolName === 'gws') {
    return compactGwsOutputForLLM(output);
  }

  // Per-tool result compaction
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;

    if (toolName === 'fs_read' && typeof obj.content === 'string') {
      const content = obj.content as string;
      const lines = content.split('\n');
      if (lines.length > 70) {
        const head = lines.slice(0, 50).join('\n');
        const tail = lines.slice(-20).join('\n');
        return { ...obj, content: `${head}\n[... ${lines.length - 70} lines omitted ...]\n${tail}` };
      }
    }

    if (toolName === 'fs_search' && Array.isArray(obj.matches)) {
      const matches = obj.matches as unknown[];
      if (matches.length > 20) {
        return { ...obj, matches: matches.slice(0, 20), moreMatches: matches.length - 20 };
      }
    }

    if (toolName === 'shell_safe' && typeof obj.stdout === 'string') {
      const stdout = obj.stdout as string;
      if (stdout.length > 2048) {
        const lineCount = stdout.split('\n').length;
        return { ...obj, stdout: `[... ${lineCount} lines, showing last 2KB ...]\n${stdout.slice(-2048)}` };
      }
    }

    if (toolName === 'web_fetch' && typeof obj.content === 'string') {
      const content = obj.content as string;
      if (content.length > 3072) {
        return { ...obj, content: content.slice(0, 3072) + '\n[... content truncated ...]' };
      }
    }

    if ((toolName === 'net_arp_scan' || toolName === 'net_connections') && Array.isArray(obj.devices ?? obj.connections)) {
      const items = (obj.devices ?? obj.connections) as unknown[];
      const key = obj.devices ? 'devices' : 'connections';
      if (items.length > 15) {
        return { ...obj, [key]: items.slice(0, 15), totalCount: items.length, moreOmitted: items.length - 15 };
      }
    }
  }

  return compactValueForLLM(output);
}

function compactGwsOutputForLLM(output: unknown): unknown {
  if (!output || typeof output !== 'object') {
    return compactValueForLLM(output);
  }

  const value = output as Record<string, unknown>;
  if (Array.isArray(value.messages)) {
    return {
      messages: value.messages.slice(0, MAX_TOOL_RESULT_ARRAY_ITEMS).map((entry) => compactGmailMessageForLLM(entry)),
      resultSizeEstimate: toNumber(value.resultSizeEstimate) ?? undefined,
      nextPageToken: truncateText(toString(value.nextPageToken), 120) || undefined,
    };
  }

  if ('payload' in value || 'snippet' in value || 'labelIds' in value) {
    return compactGmailMessageForLLM(value);
  }

  return compactValueForLLM(output);
}

function compactGmailMessageForLLM(message: unknown): unknown {
  if (!message || typeof message !== 'object') {
    return compactValueForLLM(message);
  }

  const value = message as Record<string, unknown>;
  const payload = value.payload && typeof value.payload === 'object'
    ? value.payload as { headers?: unknown }
    : undefined;
  const headers = Array.isArray(payload?.headers)
    ? payload.headers as Array<{ name?: unknown; value?: unknown }>
    : [];

  return {
    id: truncateText(toString(value.id), 120) || undefined,
    threadId: truncateText(toString(value.threadId), 120) || undefined,
    labelIds: Array.isArray(value.labelIds)
      ? value.labelIds.slice(0, MAX_TOOL_RESULT_ARRAY_ITEMS).map((item) => truncateText(toString(item), 80))
      : undefined,
    internalDate: truncateText(toString(value.internalDate), 120) || undefined,
    sizeEstimate: toNumber(value.sizeEstimate) ?? undefined,
    snippet: truncateText(toString(value.snippet), 400),
    from: findHeaderValue(headers, 'from') || undefined,
    to: findHeaderValue(headers, 'to') || undefined,
    subject: findHeaderValue(headers, 'subject') || undefined,
    date: findHeaderValue(headers, 'date') || undefined,
  };
}

function compactValueForLLM(value: unknown, depth: number = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateText(value, MAX_TOOL_RESULT_STRING_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 3) return `[${Array.isArray(value) ? 'Array' : 'Object'} omitted]`;

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_TOOL_RESULT_ARRAY_ITEMS).map((item) => compactValueForLLM(item, depth + 1));
    if (value.length > MAX_TOOL_RESULT_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_TOOL_RESULT_ARRAY_ITEMS} more items omitted]`);
    }
    return items;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    let kept = 0;
    for (const [key, entryValue] of entries) {
      if (kept >= MAX_TOOL_RESULT_OBJECT_KEYS) break;
      if ((key === 'raw' || key === 'data') && typeof entryValue === 'string') {
        out[key] = `[${key} omitted: ${entryValue.length} chars]`;
      } else if (key === 'parts' && Array.isArray(entryValue)) {
        out[key] = `[${entryValue.length} MIME parts omitted]`;
      } else {
        out[key] = compactValueForLLM(entryValue, depth + 1);
      }
      kept += 1;
    }
    if (entries.length > MAX_TOOL_RESULT_OBJECT_KEYS) {
      out._truncatedKeys = entries.length - MAX_TOOL_RESULT_OBJECT_KEYS;
    }
    return out;
  }

  return String(value);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return truncateText(String(value), MAX_TOOL_RESULT_MESSAGE_CHARS);
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 16))}[...truncated]`;
}

/**
 * Detect web search intent from free-form user messages.
 * Returns a search query string, or null if the message isn't a web search request.
 * Conservative by design: only trigger for explicit web-search language
 * or strong internet-oriented keywords to avoid hijacking normal chat.
 */
function parseWebSearchIntent(content: string): string | null {
  const text = content.trim();
  if (!text || text.length < 5) return null;

  // Must NOT be a filesystem search (those are handled by tryDirectFilesystemSearch)
  if (/\b(file|folder|directory|path|onedrive|drive|\.txt|\.json|\.ts|\.js|\.py)\b/i.test(text)) {
    return null;
  }

  if (/^(?:hi|hello|hey)\b/i.test(text)) return null;
  if (/^(?:who|what)\s+are\s+you\b/i.test(text)) return null;

  const explicitSearchPatterns = [
    /^(?:please\s+)?(?:search|find|look\s*up|google|browse)\b/i,
    /\b(?:search|look\s*up|google|browse)\b.*\b(?:web|internet|online)\b/i,
    /\bon\s+the\s+(?:web|internet|online)\b/i,
    /\bweb\s+search\b/i,
  ];
  const hasExplicitSignal = explicitSearchPatterns.some((pattern) => pattern.test(text));

  const hasInternetTopicSignal = /\b(?:latest|news|weather|price|stock|market|review|release\s+date|breaking)\b/i.test(text);
  const hasQuestionSignal = /[?]|\b(?:what|who|where|when|how)\b/i.test(text);
  if (!hasExplicitSignal && !(hasInternetTopicSignal && hasQuestionSignal)) return null;

  // Extract the query — use the full message, cleaned up
  const query = text
    .replace(/^(?:please|can you|could you|help me|i need to|i want to)\s+/i, '')
    .replace(/^(?:search|find|look\s*up|google|browse)\s+(?:for\s+|the\s+web\s+for\s+)?/i, '')
    .replace(/\s+on\s+the\s+(?:web|internet|online)\s*$/i, '')
    .trim();

  return query.length >= 3 ? query : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwnProp(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function trimOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sanitizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim()) {
      result[key] = entry.trim();
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeNormalizedUrlRecord(value: unknown): Record<string, string> | undefined {
  const sanitized = sanitizeStringRecord(value);
  return sanitized ? normalizeHttpUrlRecord(sanitized) : undefined;
}

function redactCloudConfig(cloud: GuardianAgentConfig['assistant']['tools']['cloud']): RedactedCloudConfig | undefined {
  if (!cloud) return undefined;

  let inlineSecretProfileCount = 0;
  let credentialRefCount = 0;
  let selfSignedProfileCount = 0;
  let customEndpointProfileCount = 0;

  const cpanelProfiles = (cloud.cpanelProfiles ?? []).map((profile) => {
    const normalized = normalizeCpanelConnectionConfig(profile);
    const apiTokenConfigured = !!profile.apiToken?.trim();
    if (apiTokenConfigured) inlineSecretProfileCount += 1;
    if (profile.credentialRef?.trim()) credentialRefCount += 1;
    if (profile.allowSelfSigned) selfSignedProfileCount += 1;
    return {
      id: profile.id,
      name: profile.name,
      type: profile.type,
      host: normalized.host,
      port: normalized.port,
      username: profile.username,
      credentialRef: profile.credentialRef,
      apiTokenConfigured,
      ssl: normalized.ssl !== false,
      allowSelfSigned: profile.allowSelfSigned === true,
      defaultCpanelUser: profile.defaultCpanelUser,
    };
  });

  const vercelProfiles = (cloud.vercelProfiles ?? []).map((profile) => {
    const apiTokenConfigured = !!profile.apiToken?.trim();
    if (apiTokenConfigured) inlineSecretProfileCount += 1;
    if (profile.credentialRef?.trim()) credentialRefCount += 1;
    if (profile.apiBaseUrl?.trim()) customEndpointProfileCount += 1;
    return {
      id: profile.id,
      name: profile.name,
      apiBaseUrl: normalizeOptionalHttpUrlInput(profile.apiBaseUrl),
      credentialRef: profile.credentialRef,
      apiTokenConfigured,
      teamId: profile.teamId,
      slug: profile.slug,
    };
  });

  const cloudflareProfiles = (cloud.cloudflareProfiles ?? []).map((profile) => {
    const apiTokenConfigured = !!profile.apiToken?.trim();
    if (apiTokenConfigured) inlineSecretProfileCount += 1;
    if (profile.credentialRef?.trim()) credentialRefCount += 1;
    if (profile.apiBaseUrl?.trim()) customEndpointProfileCount += 1;
    return {
      id: profile.id,
      name: profile.name,
      apiBaseUrl: normalizeOptionalHttpUrlInput(profile.apiBaseUrl),
      credentialRef: profile.credentialRef,
      apiTokenConfigured,
      accountId: profile.accountId,
      defaultZoneId: profile.defaultZoneId,
    };
  });

  const awsProfiles = (cloud.awsProfiles ?? []).map((profile) => {
    const accessKeyIdConfigured = !!profile.accessKeyId?.trim();
    const secretAccessKeyConfigured = !!profile.secretAccessKey?.trim();
    const sessionTokenConfigured = !!profile.sessionToken?.trim();
    if (accessKeyIdConfigured || secretAccessKeyConfigured || sessionTokenConfigured) inlineSecretProfileCount += 1;
    if (profile.accessKeyIdCredentialRef?.trim()) credentialRefCount += 1;
    if (profile.secretAccessKeyCredentialRef?.trim()) credentialRefCount += 1;
    if (profile.sessionTokenCredentialRef?.trim()) credentialRefCount += 1;
    const endpoints = sanitizeNormalizedUrlRecord(profile.endpoints);
    if (endpoints) customEndpointProfileCount += 1;
    return {
      id: profile.id,
      name: profile.name,
      region: profile.region,
      accessKeyIdCredentialRef: profile.accessKeyIdCredentialRef,
      secretAccessKeyCredentialRef: profile.secretAccessKeyCredentialRef,
      sessionTokenCredentialRef: profile.sessionTokenCredentialRef,
      accessKeyIdConfigured,
      secretAccessKeyConfigured,
      sessionTokenConfigured,
      endpoints,
    };
  });

  const gcpProfiles = (cloud.gcpProfiles ?? []).map((profile) => {
    const accessTokenConfigured = !!profile.accessToken?.trim();
    const serviceAccountConfigured = !!profile.serviceAccountJson?.trim();
    if (accessTokenConfigured || serviceAccountConfigured) inlineSecretProfileCount += 1;
    if (profile.accessTokenCredentialRef?.trim()) credentialRefCount += 1;
    if (profile.serviceAccountCredentialRef?.trim()) credentialRefCount += 1;
    const endpoints = sanitizeNormalizedUrlRecord(profile.endpoints);
    if (endpoints) customEndpointProfileCount += 1;
    return {
      id: profile.id,
      name: profile.name,
      projectId: profile.projectId,
      location: profile.location,
      accessTokenCredentialRef: profile.accessTokenCredentialRef,
      serviceAccountCredentialRef: profile.serviceAccountCredentialRef,
      accessTokenConfigured,
      serviceAccountConfigured,
      endpoints,
    };
  });

  const azureProfiles = (cloud.azureProfiles ?? []).map((profile) => {
    const accessTokenConfigured = !!profile.accessToken?.trim();
    const clientIdConfigured = !!profile.clientId?.trim();
    const clientSecretConfigured = !!profile.clientSecret?.trim();
    if (accessTokenConfigured || clientIdConfigured || clientSecretConfigured) inlineSecretProfileCount += 1;
    if (profile.accessTokenCredentialRef?.trim()) credentialRefCount += 1;
    if (profile.clientIdCredentialRef?.trim()) credentialRefCount += 1;
    if (profile.clientSecretCredentialRef?.trim()) credentialRefCount += 1;
    const endpoints = sanitizeNormalizedUrlRecord(profile.endpoints);
    if (endpoints || profile.blobBaseUrl?.trim()) customEndpointProfileCount += 1;
    return {
      id: profile.id,
      name: profile.name,
      subscriptionId: profile.subscriptionId,
      tenantId: profile.tenantId,
      accessTokenCredentialRef: profile.accessTokenCredentialRef,
      accessTokenConfigured,
      clientIdCredentialRef: profile.clientIdCredentialRef,
      clientIdConfigured,
      clientSecretCredentialRef: profile.clientSecretCredentialRef,
      clientSecretConfigured,
      defaultResourceGroup: profile.defaultResourceGroup,
      blobBaseUrl: normalizeOptionalHttpUrlInput(profile.blobBaseUrl),
      endpoints,
    };
  });

  return {
    enabled: cloud.enabled,
    cpanelProfiles,
    vercelProfiles,
    cloudflareProfiles,
    awsProfiles,
    gcpProfiles,
    azureProfiles,
    profileCounts: {
      cpanel: cpanelProfiles.length,
      vercel: vercelProfiles.length,
      cloudflare: cloudflareProfiles.length,
      aws: awsProfiles.length,
      gcp: gcpProfiles.length,
      azure: azureProfiles.length,
      total: cpanelProfiles.length + vercelProfiles.length + cloudflareProfiles.length + awsProfiles.length + gcpProfiles.length + azureProfiles.length,
    },
    security: {
      inlineSecretProfileCount,
      credentialRefCount,
      selfSignedProfileCount,
      customEndpointProfileCount,
    },
  };
}

function mergeCloudConfigForValidation(
  currentCloud: GuardianAgentConfig['assistant']['tools']['cloud'] | undefined,
  cloudUpdate: NonNullable<NonNullable<NonNullable<ConfigUpdate['assistant']>['tools']>['cloud']>,
): GuardianAgentConfig['assistant']['tools']['cloud'] {
  const current = currentCloud ?? {
    enabled: false,
    cpanelProfiles: [],
    vercelProfiles: [],
    cloudflareProfiles: [],
    awsProfiles: [],
    gcpProfiles: [],
    azureProfiles: [],
  };

  return {
    ...current,
    ...cloudUpdate,
    cpanelProfiles: Array.isArray(cloudUpdate.cpanelProfiles)
      ? cloudUpdate.cpanelProfiles.map((profile) => {
        const existing = current.cpanelProfiles?.find((entry) => entry.id === profile.id);
        return {
          ...existing,
          ...profile,
          apiToken: hasOwnProp(profile, 'apiToken') ? trimOptionalString(profile.apiToken) : existing?.apiToken,
          credentialRef: hasOwnProp(profile, 'credentialRef') ? trimOptionalString(profile.credentialRef) : existing?.credentialRef,
          defaultCpanelUser: hasOwnProp(profile, 'defaultCpanelUser') ? trimOptionalString(profile.defaultCpanelUser) : existing?.defaultCpanelUser,
        };
      })
      : current.cpanelProfiles,
    vercelProfiles: Array.isArray(cloudUpdate.vercelProfiles)
      ? cloudUpdate.vercelProfiles.map((profile) => {
        const existing = current.vercelProfiles?.find((entry) => entry.id === profile.id);
        return {
          ...existing,
          ...profile,
          apiBaseUrl: hasOwnProp(profile, 'apiBaseUrl') ? normalizeOptionalHttpUrlInput(profile.apiBaseUrl) : existing?.apiBaseUrl,
          apiToken: hasOwnProp(profile, 'apiToken') ? trimOptionalString(profile.apiToken) : existing?.apiToken,
          credentialRef: hasOwnProp(profile, 'credentialRef') ? trimOptionalString(profile.credentialRef) : existing?.credentialRef,
          teamId: hasOwnProp(profile, 'teamId') ? trimOptionalString(profile.teamId) : existing?.teamId,
          slug: hasOwnProp(profile, 'slug') ? trimOptionalString(profile.slug) : existing?.slug,
        };
      })
      : current.vercelProfiles,
    cloudflareProfiles: Array.isArray(cloudUpdate.cloudflareProfiles)
      ? cloudUpdate.cloudflareProfiles.map((profile) => {
        const existing = current.cloudflareProfiles?.find((entry) => entry.id === profile.id);
        return {
          ...existing,
          ...profile,
          apiBaseUrl: hasOwnProp(profile, 'apiBaseUrl') ? normalizeOptionalHttpUrlInput(profile.apiBaseUrl) : existing?.apiBaseUrl,
          apiToken: hasOwnProp(profile, 'apiToken') ? trimOptionalString(profile.apiToken) : existing?.apiToken,
          credentialRef: hasOwnProp(profile, 'credentialRef') ? trimOptionalString(profile.credentialRef) : existing?.credentialRef,
          accountId: hasOwnProp(profile, 'accountId') ? trimOptionalString(profile.accountId) : existing?.accountId,
          defaultZoneId: hasOwnProp(profile, 'defaultZoneId') ? trimOptionalString(profile.defaultZoneId) : existing?.defaultZoneId,
        };
      })
      : current.cloudflareProfiles,
    awsProfiles: Array.isArray(cloudUpdate.awsProfiles)
      ? cloudUpdate.awsProfiles.map((profile) => {
        const existing = current.awsProfiles?.find((entry) => entry.id === profile.id);
        return {
          ...existing,
          ...profile,
          accessKeyId: hasOwnProp(profile, 'accessKeyId') ? trimOptionalString(profile.accessKeyId) : existing?.accessKeyId,
          accessKeyIdCredentialRef: hasOwnProp(profile, 'accessKeyIdCredentialRef') ? trimOptionalString(profile.accessKeyIdCredentialRef) : existing?.accessKeyIdCredentialRef,
          secretAccessKey: hasOwnProp(profile, 'secretAccessKey') ? trimOptionalString(profile.secretAccessKey) : existing?.secretAccessKey,
          secretAccessKeyCredentialRef: hasOwnProp(profile, 'secretAccessKeyCredentialRef') ? trimOptionalString(profile.secretAccessKeyCredentialRef) : existing?.secretAccessKeyCredentialRef,
          sessionToken: hasOwnProp(profile, 'sessionToken') ? trimOptionalString(profile.sessionToken) : existing?.sessionToken,
          sessionTokenCredentialRef: hasOwnProp(profile, 'sessionTokenCredentialRef') ? trimOptionalString(profile.sessionTokenCredentialRef) : existing?.sessionTokenCredentialRef,
          endpoints: hasOwnProp(profile, 'endpoints') ? sanitizeNormalizedUrlRecord(profile.endpoints) : existing?.endpoints,
        };
      })
      : current.awsProfiles,
    gcpProfiles: Array.isArray(cloudUpdate.gcpProfiles)
      ? cloudUpdate.gcpProfiles.map((profile) => {
        const existing = current.gcpProfiles?.find((entry) => entry.id === profile.id);
        return {
          ...existing,
          ...profile,
          location: hasOwnProp(profile, 'location') ? trimOptionalString(profile.location) : existing?.location,
          accessToken: hasOwnProp(profile, 'accessToken') ? trimOptionalString(profile.accessToken) : existing?.accessToken,
          accessTokenCredentialRef: hasOwnProp(profile, 'accessTokenCredentialRef') ? trimOptionalString(profile.accessTokenCredentialRef) : existing?.accessTokenCredentialRef,
          serviceAccountJson: hasOwnProp(profile, 'serviceAccountJson') ? trimOptionalString(profile.serviceAccountJson) : existing?.serviceAccountJson,
          serviceAccountCredentialRef: hasOwnProp(profile, 'serviceAccountCredentialRef') ? trimOptionalString(profile.serviceAccountCredentialRef) : existing?.serviceAccountCredentialRef,
          endpoints: hasOwnProp(profile, 'endpoints') ? sanitizeNormalizedUrlRecord(profile.endpoints) : existing?.endpoints,
        };
      })
      : current.gcpProfiles,
    azureProfiles: Array.isArray(cloudUpdate.azureProfiles)
      ? cloudUpdate.azureProfiles.map((profile) => {
        const existing = current.azureProfiles?.find((entry) => entry.id === profile.id);
        return {
          ...existing,
          ...profile,
          tenantId: hasOwnProp(profile, 'tenantId') ? trimOptionalString(profile.tenantId) : existing?.tenantId,
          accessToken: hasOwnProp(profile, 'accessToken') ? trimOptionalString(profile.accessToken) : existing?.accessToken,
          accessTokenCredentialRef: hasOwnProp(profile, 'accessTokenCredentialRef') ? trimOptionalString(profile.accessTokenCredentialRef) : existing?.accessTokenCredentialRef,
          clientId: hasOwnProp(profile, 'clientId') ? trimOptionalString(profile.clientId) : existing?.clientId,
          clientIdCredentialRef: hasOwnProp(profile, 'clientIdCredentialRef') ? trimOptionalString(profile.clientIdCredentialRef) : existing?.clientIdCredentialRef,
          clientSecret: hasOwnProp(profile, 'clientSecret') ? trimOptionalString(profile.clientSecret) : existing?.clientSecret,
          clientSecretCredentialRef: hasOwnProp(profile, 'clientSecretCredentialRef') ? trimOptionalString(profile.clientSecretCredentialRef) : existing?.clientSecretCredentialRef,
          defaultResourceGroup: hasOwnProp(profile, 'defaultResourceGroup') ? trimOptionalString(profile.defaultResourceGroup) : existing?.defaultResourceGroup,
          blobBaseUrl: hasOwnProp(profile, 'blobBaseUrl') ? normalizeOptionalHttpUrlInput(profile.blobBaseUrl) : existing?.blobBaseUrl,
          endpoints: hasOwnProp(profile, 'endpoints') ? sanitizeNormalizedUrlRecord(profile.endpoints) : existing?.endpoints,
        };
      })
      : current.azureProfiles,
  };
}

/** Strip sensitive fields from config for the dashboard. */
function redactConfig(config: GuardianAgentConfig): RedactedConfig {
  const llm: Record<string, { provider: string; model: string; baseUrl?: string; credentialRef?: string }> = {};
  for (const [name, cfg] of Object.entries(config.llm)) {
    llm[name] = {
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      credentialRef: cfg.credentialRef,
    };
  }
  const searchConfig = config.assistant.tools.search;
  const searchSources = Array.isArray(searchConfig?.sources) ? searchConfig.sources : [];

  return {
    llm,
    defaultProvider: config.defaultProvider,
    channels: {
      cli: config.channels.cli ? { enabled: config.channels.cli.enabled } : undefined,
      telegram: config.channels.telegram ? {
        enabled: config.channels.telegram.enabled,
        botTokenConfigured: !!(config.channels.telegram.botToken?.trim() || config.channels.telegram.botTokenCredentialRef?.trim()),
        botTokenCredentialRef: config.channels.telegram.botTokenCredentialRef,
        allowedChatIds: config.channels.telegram.allowedChatIds,
        defaultAgent: config.channels.telegram.defaultAgent,
      } : undefined,
      web: config.channels.web ? {
        enabled: config.channels.web.enabled,
        port: config.channels.web.port,
        host: config.channels.web.host,
        auth: {
          mode: 'bearer_required',
          tokenConfigured: !!(config.channels.web.auth?.token?.trim() || config.channels.web.authToken?.trim()),
          tokenSource: config.channels.web.auth?.tokenSource,
          rotateOnStartup: config.channels.web.auth?.rotateOnStartup ?? false,
          sessionTtlMinutes: config.channels.web.auth?.sessionTtlMinutes,
        },
      } : undefined,
    },
    guardian: {
      enabled: config.guardian.enabled,
      rateLimit: config.guardian.rateLimit,
      inputSanitization: config.guardian.inputSanitization,
      outputScanning: config.guardian.outputScanning,
      guardianAgent: config.guardian.guardianAgent ? {
        enabled: config.guardian.guardianAgent.enabled,
        llmProvider: config.guardian.guardianAgent.llmProvider,
        failOpen: config.guardian.guardianAgent.failOpen,
        timeoutMs: config.guardian.guardianAgent.timeoutMs,
      } : undefined,
      sentinel: config.guardian.sentinel ? {
        enabled: config.guardian.sentinel.enabled,
        schedule: config.guardian.sentinel.schedule,
      } : undefined,
      policy: config.guardian.policy ? {
        enabled: config.guardian.policy.enabled,
        mode: config.guardian.policy.mode,
        rulesPath: config.guardian.policy.rulesPath,
      } : undefined,
    },
    runtime: config.runtime,
    assistant: {
      setupCompleted: config.assistant.setup.completed,
      identity: {
        mode: config.assistant.identity.mode,
        primaryUserId: config.assistant.identity.primaryUserId,
      },
      soul: {
        enabled: config.assistant.soul.enabled,
        path: config.assistant.soul.path,
        primaryMode: config.assistant.soul.primaryMode,
        delegatedMode: config.assistant.soul.delegatedMode,
        maxChars: config.assistant.soul.maxChars,
        summaryMaxChars: config.assistant.soul.summaryMaxChars,
      },
      memory: {
        enabled: config.assistant.memory.enabled,
        retentionDays: config.assistant.memory.retentionDays,
      },
      analytics: {
        enabled: config.assistant.analytics.enabled,
        retentionDays: config.assistant.analytics.retentionDays,
      },
      notifications: {
        enabled: config.assistant.notifications.enabled,
        minSeverity: config.assistant.notifications.minSeverity,
        auditEventTypes: [...config.assistant.notifications.auditEventTypes],
        suppressedDetailTypes: [...config.assistant.notifications.suppressedDetailTypes],
        cooldownMs: config.assistant.notifications.cooldownMs,
        deliveryMode: config.assistant.notifications.deliveryMode,
        destinations: { ...config.assistant.notifications.destinations },
      },
      quickActions: {
        enabled: config.assistant.quickActions.enabled,
      },
      credentials: {
        refs: Object.fromEntries(
          Object.entries(config.assistant.credentials.refs ?? {}).map(([name, ref]) => [name, {
            source: ref.source,
            env: ref.source === 'env' ? ref.env : undefined,
            description: ref.description,
          }]),
        ),
      },
      threatIntel: {
        enabled: config.assistant.threatIntel.enabled,
        allowDarkWeb: config.assistant.threatIntel.allowDarkWeb,
        responseMode: config.assistant.threatIntel.responseMode,
        watchlistCount: config.assistant.threatIntel.watchlist.length,
        autoScanIntervalMinutes: config.assistant.threatIntel.autoScanIntervalMinutes,
        moltbook: {
          enabled: config.assistant.threatIntel.moltbook.enabled,
          mode: config.assistant.threatIntel.moltbook.mode,
          baseUrl: config.assistant.threatIntel.moltbook.baseUrl,
          allowActiveResponse: config.assistant.threatIntel.moltbook.allowActiveResponse,
        },
      },
      network: {
        deviceIntelligence: {
          enabled: config.assistant.network.deviceIntelligence.enabled,
          ouiDatabase: config.assistant.network.deviceIntelligence.ouiDatabase,
          autoClassify: config.assistant.network.deviceIntelligence.autoClassify,
        },
        baseline: {
          enabled: config.assistant.network.baseline.enabled,
          minSnapshotsForBaseline: config.assistant.network.baseline.minSnapshotsForBaseline,
          dedupeWindowMs: config.assistant.network.baseline.dedupeWindowMs,
        },
        fingerprinting: {
          enabled: config.assistant.network.fingerprinting.enabled,
          bannerTimeout: config.assistant.network.fingerprinting.bannerTimeout,
          maxConcurrentPerDevice: config.assistant.network.fingerprinting.maxConcurrentPerDevice,
          autoFingerprint: config.assistant.network.fingerprinting.autoFingerprint,
        },
        wifi: {
          enabled: config.assistant.network.wifi.enabled,
          platform: config.assistant.network.wifi.platform,
          scanInterval: config.assistant.network.wifi.scanInterval,
        },
        trafficAnalysis: {
          enabled: config.assistant.network.trafficAnalysis.enabled,
          dataSource: config.assistant.network.trafficAnalysis.dataSource,
          flowRetention: config.assistant.network.trafficAnalysis.flowRetention,
        },
        connectionCount: config.assistant.network.connections.length,
      },
      hostMonitoring: {
        enabled: config.assistant.hostMonitoring.enabled,
        scanIntervalSec: config.assistant.hostMonitoring.scanIntervalSec,
        dedupeWindowMs: config.assistant.hostMonitoring.dedupeWindowMs,
        monitorProcesses: config.assistant.hostMonitoring.monitorProcesses,
        monitorPersistence: config.assistant.hostMonitoring.monitorPersistence,
        monitorSensitivePaths: config.assistant.hostMonitoring.monitorSensitivePaths,
        monitorNetwork: config.assistant.hostMonitoring.monitorNetwork,
        monitorFirewall: config.assistant.hostMonitoring.monitorFirewall,
        sensitivePathCount: config.assistant.hostMonitoring.sensitivePaths.length,
        suspiciousProcessCount: config.assistant.hostMonitoring.suspiciousProcessNames.length,
      },
      gatewayMonitoring: {
        enabled: config.assistant.gatewayMonitoring.enabled,
        scanIntervalSec: config.assistant.gatewayMonitoring.scanIntervalSec,
        dedupeWindowMs: config.assistant.gatewayMonitoring.dedupeWindowMs,
        monitorCount: config.assistant.gatewayMonitoring.monitors.filter((monitor) => monitor.enabled).length,
      },
      connectors: {
        enabled: config.assistant.connectors.enabled,
        executionMode: config.assistant.connectors.executionMode,
        maxConnectorCallsPerRun: config.assistant.connectors.maxConnectorCallsPerRun,
        packCount: config.assistant.connectors.packs.length,
        enabledPackCount: config.assistant.connectors.packs.filter((pack) => pack.enabled).length,
        playbookCount: config.assistant.connectors.playbooks.definitions.length,
        playbooks: {
          enabled: config.assistant.connectors.playbooks.enabled,
          maxSteps: config.assistant.connectors.playbooks.maxSteps,
          maxParallelSteps: config.assistant.connectors.playbooks.maxParallelSteps,
          defaultStepTimeoutMs: config.assistant.connectors.playbooks.defaultStepTimeoutMs,
          requireSignedDefinitions: config.assistant.connectors.playbooks.requireSignedDefinitions,
          requireDryRunOnFirstExecution: config.assistant.connectors.playbooks.requireDryRunOnFirstExecution,
        },
        studio: {
          enabled: config.assistant.connectors.studio.enabled,
          mode: config.assistant.connectors.studio.mode,
          requirePrivilegedTicket: config.assistant.connectors.studio.requirePrivilegedTicket,
        },
      },
      tools: {
        enabled: config.assistant.tools.enabled,
        policyMode: config.assistant.tools.policyMode,
        allowExternalPosting: config.assistant.tools.allowExternalPosting,
        allowedPathsCount: config.assistant.tools.allowedPaths.length,
        allowedCommandsCount: config.assistant.tools.allowedCommands.length,
        allowedDomainsCount: config.assistant.tools.allowedDomains.length,
        preferredProviders: config.assistant.tools.preferredProviders,
        webSearch: {
          provider: config.assistant.tools.webSearch?.provider ?? 'auto',
          perplexityConfigured: !!(config.assistant.tools.webSearch?.perplexityApiKey || config.assistant.tools.webSearch?.perplexityCredentialRef),
          perplexityCredentialRef: config.assistant.tools.webSearch?.perplexityCredentialRef,
          openRouterConfigured: !!(config.assistant.tools.webSearch?.openRouterApiKey || config.assistant.tools.webSearch?.openRouterCredentialRef),
          openRouterCredentialRef: config.assistant.tools.webSearch?.openRouterCredentialRef,
          braveConfigured: !!(config.assistant.tools.webSearch?.braveApiKey || config.assistant.tools.webSearch?.braveCredentialRef),
          braveCredentialRef: config.assistant.tools.webSearch?.braveCredentialRef,
        },
        search: searchConfig ? {
          enabled: searchConfig.enabled,
          sourceCount: searchSources.length,
          defaultMode: searchConfig.defaultMode ?? 'keyword',
        } : undefined,
        cloud: redactCloudConfig(config.assistant.tools.cloud),
        agentPolicyUpdates: config.assistant.tools.agentPolicyUpdates,
      },
    },
    fallbacks: config.fallbacks,
  };
}

/** Policy engine runtime state container. */
interface PolicyState {
  getStatus: () => {
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
  update: (input: {
    enabled?: boolean;
    mode?: 'off' | 'shadow' | 'enforce';
    families?: { tool?: string; admin?: string; guardian?: string; event?: string };
    mismatchLogLimit?: number;
  }) => { success: boolean; message: string };
  reload: () => { success: boolean; message: string; loaded: number; skipped: number; errors: string[] };
}

function resolveTelegramBotToken(config: GuardianAgentConfig, secretStore: LocalSecretStore): string | undefined {
  const runtimeCredentials = resolveRuntimeCredentialView(config, secretStore);
  const refName = config.channels.telegram?.botTokenCredentialRef?.trim();
  if (refName) {
    return runtimeCredentials.credentialProvider.resolve(refName);
  }
  const direct = config.channels.telegram?.botToken?.trim();
  return direct || undefined;
}

/** Build dashboard callbacks wired to runtime internals. */
function buildDashboardCallbacks(
  runtime: Runtime,
  configRef: { current: GuardianAgentConfig },
  threatIntelWebSearchConfigRef: { current: WebSearchConfig | undefined },
  secretStore: LocalSecretStore,
  conversations: ConversationService,
  identity: IdentityService,
  analytics: AnalyticsService,
  orchestrator: AssistantOrchestrator,
  jobTracker: AssistantJobTracker,
  threatIntel: ThreatIntelService,
  connectors: ConnectorPlaybookService,
  toolExecutor: ToolExecutor,
  chatAgents: Map<string, ChatAgent>,
  skillRegistry: SkillRegistry | undefined,
  enabledManagedProviders: Set<string>,
  webAuthStateRef: { current: WebAuthRuntimeConfig },
  applyWebAuthRuntime: (auth: WebAuthRuntimeConfig) => void,
  configPath: string,
  router: MessageRouter,
  deviceInventory: DeviceInventoryService,
  networkBaseline: NetworkBaselineService,
  hostMonitor: HostMonitoringService,
  runHostMonitoring: (source: string) => Promise<HostMonitorReport>,
  gatewayMonitor: GatewayFirewallMonitoringService,
  runGatewayMonitoring: (source: string) => Promise<GatewayMonitorReport>,
  runNetworkAnalysis: (source: string) => NetworkAnomalyReport,
  guardianAgentService: GuardianAgentService,
  sentinelAuditService: SentinelAuditService,
  policyState: PolicyState,
  googleAuthRef: { current: import('./google/google-auth.js').GoogleAuth | null },
  googleServiceRef: { current: import('./google/google-service.js').GoogleService | null },
): DashboardCallbacks & {
  telegramReloadRef: { current: (() => Promise<{ success: boolean; message: string }>) | null };
  reloadSearchRef: { current: (() => Promise<{ success: boolean; message: string }>) | null };
} {
  const loadRawConfig = (): Record<string, unknown> => {
    if (!existsSync(configPath)) return {};
    const content = readFileSync(configPath, 'utf-8');
    return (yaml.load(content) as Record<string, unknown>) ?? {};
  };
  const resolveSharedStateAgentId = (agentId?: string): string | undefined => resolveAgentStateId(agentId, {
    localAgentId: router.findAgentByRole('local')?.id,
    externalAgentId: router.findAgentByRole('external')?.id,
  });

  const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
  const trimOrUndefined = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const existingProfilesById = (rawCloud: Record<string, unknown>, key: string): Map<string, Record<string, unknown>> => {
    const profiles = Array.isArray(rawCloud[key]) ? rawCloud[key] : [];
    return new Map(
      profiles
        .filter(isRecord)
        .map((profile) => [typeof profile.id === 'string' ? profile.id : '', profile] as const)
        .filter(([id]) => !!id),
    );
  };

  /** Mutable ref set from main() to enable hot-reload of the Telegram channel. */
  const telegramReloadRef: { current: (() => Promise<{ success: boolean; message: string }>) | null } = { current: null };

  /** Mutable ref set from main() to enable hot-reload of the Document Search engine. */
  const reloadSearchRef: { current: (() => Promise<{ success: boolean; message: string }>) | null } = { current: null };

  const persistAndApplyConfig = (
    rawConfig: Record<string, unknown>,
    meta?: { changedBy?: string; reason?: string },
  ): { success: boolean; message: string } => {
    try {
      const previousRawConfig = loadRawConfig();
      const oldPolicyHash = hashObjectSha256Hex(previousRawConfig);
      const newPolicyHash = hashObjectSha256Hex(rawConfig);

      mkdirSync(dirname(configPath), { recursive: true });
      const yamlStr = yaml.dump(rawConfig, { lineWidth: -1, noRefs: true });
      writeFileSync(configPath, yamlStr, 'utf-8');

      // Reload with defaults/env interpolation to maintain canonical runtime config.
      const nextConfig = loadConfig(configPath);
      const resolvedNextCredentials = resolveRuntimeCredentialView(nextConfig, secretStore);
      runtime.applyLLMConfiguration({
        llm: resolvedNextCredentials.resolvedLLM,
        defaultProvider: nextConfig.defaultProvider,
      });
      identity.update(nextConfig.assistant.identity);
      connectors.updateConfig(nextConfig.assistant.connectors);
      toolExecutor.updatePolicy({
        mode: nextConfig.assistant.tools.policyMode,
        toolPolicies: nextConfig.assistant.tools.toolPolicies,
        sandbox: {
          allowedPaths: nextConfig.assistant.tools.allowedPaths,
          allowedCommands: nextConfig.assistant.tools.allowedCommands,
          allowedDomains: nextConfig.assistant.tools.allowedDomains,
        },
      });
      runtime.applyShellAllowedCommands(nextConfig.assistant.tools.allowedCommands);
      toolExecutor.updateWebSearchConfig(resolvedNextCredentials.resolvedWebSearch ?? {});
      threatIntelWebSearchConfigRef.current = resolvedNextCredentials.resolvedWebSearch ?? {};
      toolExecutor.setCloudConfig(resolvedNextCredentials.resolvedCloud);
      const persistedToken = nextConfig.channels.web?.auth?.token?.trim()
        || nextConfig.channels.web?.authToken?.trim();
      webAuthStateRef.current = {
        ...webAuthStateRef.current,
        mode: 'bearer_required',
        token: persistedToken || webAuthStateRef.current.token || generateSecureToken(),
        tokenSource: persistedToken
          ? 'config'
          : (webAuthStateRef.current.tokenSource ?? 'ephemeral'),
        rotateOnStartup: nextConfig.channels.web?.auth?.rotateOnStartup ?? false,
        sessionTtlMinutes: nextConfig.channels.web?.auth?.sessionTtlMinutes,
      };
      applyWebAuthRuntime(webAuthStateRef.current);
      const prevTelegram = configRef.current.channels.telegram;
      const prevSearch = configRef.current.assistant?.tools?.search;
      configRef.current = nextConfig;

      // Hot-reload Telegram channel when config changes
      const nextTelegram = nextConfig.channels.telegram;
      const telegramChanged =
        (prevTelegram?.enabled !== nextTelegram?.enabled)
        || (prevTelegram?.botToken !== nextTelegram?.botToken)
        || (prevTelegram?.botTokenCredentialRef !== nextTelegram?.botTokenCredentialRef)
        || (prevTelegram?.defaultAgent !== nextTelegram?.defaultAgent)
        || (JSON.stringify(prevTelegram?.allowedChatIds) !== JSON.stringify(nextTelegram?.allowedChatIds));
      if (telegramChanged && telegramReloadRef.current) {
        telegramReloadRef.current().catch(err => {
          log.error({ err }, 'Telegram hot-reload failed');
        });
      }

      // Hot-reload Search engine when config changes
      const nextSearch = nextConfig.assistant?.tools?.search;
      const searchChanged =
        (prevSearch?.enabled !== nextSearch?.enabled)
        || (JSON.stringify(prevSearch?.sources) !== JSON.stringify(nextSearch?.sources))
        || (prevSearch?.sqlitePath !== nextSearch?.sqlitePath)
        || (JSON.stringify(prevSearch?.embedding) !== JSON.stringify(nextSearch?.embedding));
      if (searchChanged && reloadSearchRef.current) {
        reloadSearchRef.current().catch(err => {
          log.error({ err }, 'Search engine hot-reload failed');
        });
      }

      if (oldPolicyHash !== newPolicyHash) {
        runtime.auditLog.record({
          type: 'policy_changed',
          severity: 'info',
          agentId: 'config-center',
          controller: 'ConfigCenter',
          details: {
            oldPolicyHash,
            newPolicyHash,
            changedBy: meta?.changedBy ?? 'dashboard',
            reason: meta?.reason ?? 'config update',
          },
        });
      }
      return { success: true, message: 'Config saved and applied.' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to save config: ${message}` };
    }
  };

  const persistThreatIntelState = (): { success: boolean; message: string } => {
    const rawConfig = loadRawConfig();
    rawConfig.assistant = rawConfig.assistant ?? {};
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    const existingThreatIntel = (rawAssistant.threatIntel as Record<string, unknown> | undefined) ?? {};

    rawAssistant.threatIntel = {
      ...existingThreatIntel,
      enabled: configRef.current.assistant.threatIntel.enabled,
      allowDarkWeb: configRef.current.assistant.threatIntel.allowDarkWeb,
      responseMode: threatIntel.getSummary().responseMode,
      watchlist: threatIntel.listWatchlist(),
      autoScanIntervalMinutes: configRef.current.assistant.threatIntel.autoScanIntervalMinutes,
    };

    return persistAndApplyConfig(rawConfig, {
      changedBy: 'threat-intel',
      reason: 'threat intel settings update',
    });
  };

  const getAuthStatus = () => ({
    mode: webAuthStateRef.current.mode,
    tokenConfigured: !!webAuthStateRef.current.token,
    tokenSource: webAuthStateRef.current.tokenSource ?? 'ephemeral',
    tokenPreview: webAuthStateRef.current.token
      ? `${webAuthStateRef.current.token.slice(0, 4)}...${webAuthStateRef.current.token.slice(-4)}`
      : undefined,
    rotateOnStartup: !!webAuthStateRef.current.rotateOnStartup,
    sessionTtlMinutes: webAuthStateRef.current.sessionTtlMinutes,
    host: configRef.current.channels.web?.host ?? 'localhost',
    port: configRef.current.channels.web?.port ?? 3000,
  });

  const normalizeCredentialRefUpdates = (refs: Record<string, {
    source?: 'env' | 'local';
    env?: string;
    secretId?: string;
    secretValue?: string;
    description?: string;
  }>): Record<string, {
    source: 'env' | 'local';
    env?: string;
    secretId?: string;
    description?: string;
  }> => {
    const entries: Array<[string, {
      source: 'env' | 'local';
      env?: string;
      secretId?: string;
      description?: string;
    }]> = [];
    for (const [name, ref] of Object.entries(refs)) {
      const normalizedName = name.trim();
      const normalizedDescription = ref.description?.trim() || undefined;
      if (!normalizedName) continue;

      if ((ref.source ?? 'env') === 'local') {
        const secretId = ref.secretId?.trim() || randomUUID();
        const secretValue = ref.secretValue?.trim();
        if (secretValue) {
          secretStore.set(secretId, secretValue);
        }
        entries.push([normalizedName, {
          source: 'local',
          secretId,
          description: normalizedDescription,
        }]);
        continue;
      }

      const normalizedEnv = ref.env?.trim();
      if (!normalizedEnv) continue;
      entries.push([normalizedName, {
        source: 'env',
        env: normalizedEnv,
        description: normalizedDescription,
      }]);
    }
    return Object.fromEntries(entries);
  };

  const upsertLocalCredentialRef = (
    rawConfig: Record<string, unknown>,
    refName: string,
    secretValue: string,
    description: string,
  ): string => {
    const normalizedRefName = refName.trim();
    if (!normalizedRefName) {
      throw new Error('credentialRef is required to store a local secret');
    }

    rawConfig.assistant = rawConfig.assistant ?? {};
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    rawAssistant.credentials = (rawAssistant.credentials as Record<string, unknown> | undefined) ?? {};
    const rawCredentials = rawAssistant.credentials as Record<string, unknown>;
    rawCredentials.refs = (rawCredentials.refs as Record<string, unknown> | undefined) ?? {};
    const rawRefs = rawCredentials.refs as Record<string, Record<string, unknown>>;
    const existing = rawRefs[normalizedRefName];
    const existingSecretId = typeof existing?.secretId === 'string' ? existing.secretId.trim() : '';
    const secretId = existingSecretId || randomUUID();

    secretStore.set(secretId, secretValue);
    rawRefs[normalizedRefName] = {
      source: 'local',
      secretId,
      description,
    };
    return normalizedRefName;
  };

  const deleteUnusedLocalSecrets = (
    previousRefs: Record<string, { source: 'env' | 'local'; env?: string; secretId?: string; description?: string }>,
    nextRefs: Record<string, { source: 'env' | 'local'; env?: string; secretId?: string; description?: string }>,
  ): void => {
    const nextSecretIds = new Set(
      Object.values(nextRefs)
        .filter((ref) => ref.source === 'local')
        .map((ref) => ref.secretId?.trim())
        .filter((secretId): secretId is string => !!secretId),
    );

    for (const ref of Object.values(previousRefs)) {
      if (ref.source !== 'local') continue;
      const secretId = ref.secretId?.trim();
      if (secretId && !nextSecretIds.has(secretId)) {
        secretStore.delete(secretId);
      }
    }
  };

  const persistAuthState = (): { success: boolean; message: string } => {
    const rawConfig = loadRawConfig();
    rawConfig.channels = rawConfig.channels ?? {};
    const rawChannels = rawConfig.channels as Record<string, unknown>;
    const rawWeb = (rawChannels.web as Record<string, unknown> | undefined) ?? {};
    rawWeb.enabled = rawWeb.enabled ?? true;
    rawWeb.auth = {
      mode: 'bearer_required',
      rotateOnStartup: webAuthStateRef.current.rotateOnStartup ?? false,
      sessionTtlMinutes: webAuthStateRef.current.sessionTtlMinutes,
      tokenSource: webAuthStateRef.current.tokenSource ?? 'ephemeral',
    };
    delete (rawWeb.auth as Record<string, unknown>).token;
    delete rawWeb.authToken;
    rawChannels.web = rawWeb;
    return persistAndApplyConfig(rawConfig, {
      changedBy: 'auth-control',
      reason: 'web auth settings update',
    });
  };

  const persistToolsState = (policy: ToolPolicySnapshot): { success: boolean; message: string } => {
    const rawConfig = loadRawConfig();
    rawConfig.assistant = rawConfig.assistant ?? {};
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    const existingTools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
    rawAssistant.tools = {
      ...existingTools,
      enabled: configRef.current.assistant.tools.enabled,
      policyMode: policy.mode,
      toolPolicies: policy.toolPolicies,
      allowExternalPosting: configRef.current.assistant.tools.allowExternalPosting,
      allowedPaths: policy.sandbox.allowedPaths,
      allowedCommands: policy.sandbox.allowedCommands,
      allowedDomains: policy.sandbox.allowedDomains,
      browser: configRef.current.assistant.tools.browser,
      disabledCategories: configRef.current.assistant.tools.disabledCategories ?? [],
      providerRouting: configRef.current.assistant.tools.providerRouting ?? {},
      providerRoutingEnabled: configRef.current.assistant.tools.providerRoutingEnabled !== false,
    };
    return persistAndApplyConfig(rawConfig, {
      changedBy: 'tools-control-plane',
      reason: 'tool policy update',
    });
  };

  const persistSkillsState = (): { success: boolean; message: string } => {
    const rawConfig = loadRawConfig();
    rawConfig.assistant = rawConfig.assistant ?? {};
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    const existingSkills = (rawAssistant.skills as Record<string, unknown> | undefined) ?? {};
    rawAssistant.skills = {
      ...existingSkills,
      enabled: configRef.current.assistant.skills.enabled,
      roots: [...configRef.current.assistant.skills.roots],
      autoSelect: configRef.current.assistant.skills.autoSelect,
      maxActivePerRequest: configRef.current.assistant.skills.maxActivePerRequest,
      disabledSkills: [...configRef.current.assistant.skills.disabledSkills],
    };
    return persistAndApplyConfig(rawConfig, {
      changedBy: 'skills-control-plane',
      reason: 'skills runtime update',
    });
  };

  const persistConnectorsState = (): { success: boolean; message: string } => {
    const rawConfig = loadRawConfig();
    rawConfig.assistant = rawConfig.assistant ?? {};
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    rawAssistant.connectors = connectors.getConfig();
    return persistAndApplyConfig(rawConfig, {
      changedBy: 'connectors-control-plane',
      reason: 'connector/playbook update',
    });
  };

  const buildProviderInfo = async (withConnectivity: boolean): Promise<DashboardProviderInfo[]> => {
    const results: DashboardProviderInfo[] = [];
    for (const [name, provider] of runtime.providers) {
      const llmConfig = configRef.current.llm[name] as LLMConfig | undefined;
      const isLocal = isLocalProviderEndpoint(llmConfig?.baseUrl, provider.name);

      let connected = false;
      let availableModels: string[] | undefined;
      if (withConnectivity) {
        try {
          const models = await provider.listModels();
          connected = true;
          if (models.length > 0) {
            availableModels = models.map((m) => m.id);
          }
        } catch {
          connected = false;
        }
      }

      results.push({
        name,
        type: provider.name,
        model: llmConfig?.model ?? 'unknown',
        baseUrl: llmConfig?.baseUrl,
        locality: isLocal ? 'local' : 'external',
        connected,
        availableModels,
      });
    }
    return results;
  };

  const getDefaultModelForProviderType = (providerType: string): string => {
    switch (providerType.trim().toLowerCase()) {
      case 'ollama': return 'llama3.2';
      case 'anthropic': return 'claude-sonnet-4-6';
      case 'openai': return 'gpt-4o';
      case 'groq': return 'llama-3.3-70b-versatile';
      case 'mistral': return 'mistral-large-latest';
      case 'deepseek': return 'deepseek-chat';
      case 'together': return 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
      case 'xai': return 'grok-2-latest';
      case 'google': return 'gemini-2.0-flash';
      default: return 'provider-model';
    }
  };

  const resolveCredentialForProviderInput = (credentialRef: string | undefined, apiKey: string | undefined): string | undefined => {
    const direct = apiKey?.trim();
    if (direct) return direct;
    const ref = credentialRef?.trim();
    if (!ref) return undefined;
    const runtimeCredentials = resolveRuntimeCredentialView(configRef.current, secretStore);
    return runtimeCredentials.credentialProvider.resolve(ref);
  };

  const toDashboardAgentInfo = (inst: ReturnType<typeof runtime.registry.getAll>[number]): DashboardAgentInfo => {
    const providerName = inst.definition.providerName ?? configRef.current.defaultProvider;
    const providerConfig = configRef.current.llm[providerName];
    const providerLocality = getProviderLocality(providerConfig);
    const isInternal = router.findAgentByRole('local')?.id === inst.agent.id
      || router.findAgentByRole('external')?.id === inst.agent.id;
    return {
      id: inst.agent.id,
      name: inst.agent.name,
      state: inst.state,
      canChat: inst.agent.capabilities.handleMessages,
      internal: isInternal,
      capabilities: inst.definition.grantedCapabilities,
      provider: providerName,
      providerType: providerConfig?.provider,
      providerModel: providerConfig?.model,
      providerLocality,
      schedule: inst.definition.schedule,
      lastActivityMs: inst.lastActivityMs,
      consecutiveErrors: inst.consecutiveErrors,
    };
  };

  return {
    onAgents: (): DashboardAgentInfo[] => {
      return runtime.registry.getAll().map((inst) => toDashboardAgentInfo(inst));
    },

    onAgentDetail: (id: string): DashboardAgentDetail | null => {
      const inst = runtime.registry.get(id);
      if (!inst) return null;
      const isInternal =
        router.findAgentByRole('local')?.id === id
        || router.findAgentByRole('external')?.id === id;
      const providerName = inst.definition.providerName ?? configRef.current.defaultProvider;
      const providerConfig = configRef.current.llm[providerName];
      return {
        id: inst.agent.id,
        name: inst.agent.name,
        state: inst.state,
        canChat: inst.agent.capabilities.handleMessages,
        internal: isInternal,
        capabilities: inst.definition.grantedCapabilities,
        provider: providerName,
        providerType: providerConfig?.provider,
        providerModel: providerConfig?.model,
        providerLocality: getProviderLocality(providerConfig),
        schedule: inst.definition.schedule,
        lastActivityMs: inst.lastActivityMs,
        consecutiveErrors: inst.consecutiveErrors,
        resourceLimits: { ...inst.definition.resourceLimits },
      };
    },

    onAuditQuery: (filter) => runtime.auditLog.query(filter),

    onAuditSummary: (windowMs) => runtime.auditLog.getSummary(windowMs),

    onAuditVerifyChain: () => runtime.auditLog.verifyChain(),

    onConfig: () => redactConfig(configRef.current),

    onAuthStatus: () => getAuthStatus(),

    onAuthUpdate: async (input) => {
      if (input.token?.trim()) {
        return {
          success: false,
          message: 'Dashboard auth no longer accepts raw token values. Use Rotate Token for an ephemeral runtime token instead.',
          status: getAuthStatus(),
        };
      }
      const nextToken = webAuthStateRef.current.token || generateSecureToken();
      webAuthStateRef.current = {
        ...webAuthStateRef.current,
        mode: 'bearer_required',
        token: nextToken,
        rotateOnStartup: input.rotateOnStartup ?? webAuthStateRef.current.rotateOnStartup,
        sessionTtlMinutes: input.sessionTtlMinutes ?? webAuthStateRef.current.sessionTtlMinutes,
        tokenSource: webAuthStateRef.current.tokenSource ?? 'ephemeral',
      };
      applyWebAuthRuntime(webAuthStateRef.current);
      const persisted = persistAuthState();
      if (!persisted.success) {
        return { success: false, message: persisted.message, status: getAuthStatus() };
      }
      analytics.track({
        type: 'auth_updated',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: { mode: 'bearer_required' },
      });
      return { success: true, message: 'Web auth settings saved.', status: getAuthStatus() };
    },

    onAuthRotate: async () => {
      const token = generateSecureToken();
      webAuthStateRef.current = {
        ...webAuthStateRef.current,
        mode: 'bearer_required',
        token,
        tokenSource: 'ephemeral',
      };
      applyWebAuthRuntime(webAuthStateRef.current);
      const persisted = persistAuthState();
      if (!persisted.success) {
        return { success: false, message: persisted.message, status: getAuthStatus() };
      }
      analytics.track({
        type: 'auth_token_rotated',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
      });
      return { success: true, message: 'Bearer token rotated.', token, status: getAuthStatus() };
    },

    onAuthReveal: () => ({
      success: !!webAuthStateRef.current.token,
      token: webAuthStateRef.current.token,
    }),

    onBudget: () => {
      const agents = runtime.registry.getAll().map(inst => ({
        agentId: inst.agent.id,
        tokensPerMinute: runtime.budget.getTokensPerMinute(inst.agent.id),
        concurrentInvocations: runtime.budget.getConcurrentCount(inst.agent.id),
        overrunCount: runtime.budget.getOverrunCount(inst.agent.id),
      }));
      return {
        agents,
        recentOverruns: runtime.budget.getOverruns(),
      };
    },

    onWatchdog: () => runtime.watchdog.check(),

    onProviders: () => {
      const providers: DashboardProviderInfo[] = [];
      for (const [name, provider] of runtime.providers) {
        const llmConfig = configRef.current.llm[name] as LLMConfig | undefined;
        const isLocal = isLocalProviderEndpoint(llmConfig?.baseUrl, provider.name);
        providers.push({
          name,
          type: provider.name,
          model: llmConfig?.model ?? 'unknown',
          baseUrl: llmConfig?.baseUrl,
          locality: isLocal ? 'local' : 'external',
          connected: false,
        });
      }
      return providers;
    },

    onProviderTypes: () => getProviderRegistry().listProviderTypes().map((type) => ({
      ...type,
      locality: isLocalProviderEndpoint(undefined, type.name) ? 'local' : 'external',
    })),

    onProvidersStatus: async () => buildProviderInfo(true),

    onProviderModels: async (input) => {
      const providerType = input.providerType.trim().toLowerCase();
      if (!getProviderRegistry().hasProvider(providerType)) {
        throw new Error(`Unknown provider type '${providerType}'`);
      }

      const apiKey = resolveCredentialForProviderInput(input.credentialRef, input.apiKey);
      const providerConfig: LLMConfig = {
        provider: providerType,
        model: input.model?.trim() || getDefaultModelForProviderType(providerType),
        baseUrl: input.baseUrl?.trim() || undefined,
        apiKey,
      };

      if (providerType !== 'ollama' && !providerConfig.apiKey) {
        throw new Error('Provide an API key or credential ref to load models for this provider.');
      }

      const models = await getProviderRegistry().createProvider(providerConfig).listModels();
      return {
        models: models.map((model) => model.id),
      };
    },

    onAssistantState: () => {
      const policyTypes = new Set([
        'action_denied',
        'action_allowed',
        'rate_limited',
        'output_blocked',
        'output_redacted',
      ]);
      const decisions = runtime.auditLog
        .query({ limit: 50 })
        .filter((event) => policyTypes.has(event.type))
        .slice(-20)
        .reverse()
        .map((event) => ({
          id: event.id,
          timestamp: event.timestamp,
          type: event.type,
          severity: event.severity,
          agentId: event.agentId,
          controller: event.controller,
          reason: typeof event.details.reason === 'string' ? event.details.reason : undefined,
        }));

      return {
        orchestrator: orchestrator.getState(),
        jobs: jobTracker.getState(30),
        lastPolicyDecisions: decisions,
        defaultProvider: configRef.current.defaultProvider,
        guardianEnabled: configRef.current.guardian.enabled,
        providerCount: runtime.providers.size,
        providers: [...runtime.providers.keys()],
        scheduledJobs: runtime.scheduler.getJobs().map((j) => ({
          agentId: j.agentId,
          cron: j.cron,
          nextRun: j.job.nextRun()?.getTime(),
        })),
      };
    },

    onToolsState: ({ limit } = {}) => ({
      enabled: toolExecutor.isEnabled(),
      tools: toolExecutor.listToolDefinitions(),
      policy: toolExecutor.getPolicy(),
      approvals: toolExecutor.listApprovals(limit ?? 50),
      jobs: toolExecutor.listJobs(limit ?? 50),
      notices: toolExecutor.getRuntimeNotices(),
      sandbox: toolExecutor.getSandboxHealth(),
      categories: toolExecutor.getCategoryInfo(),
      disabledCategories: toolExecutor.getDisabledCategories(),
      providerRouting: configRef.current.assistant.tools.providerRouting ?? {},
      providerRoutingEnabled: configRef.current.assistant.tools.providerRoutingEnabled !== false,
      defaultProviderLocality: (configRef.current.llm[configRef.current.defaultProvider]?.provider === 'ollama' ? 'local' : 'external') as 'local' | 'external',
      categoryDefaults: computeCategoryDefaults(configRef.current.llm as Record<string, { provider?: string }>),
    }),

    onToolsPendingApprovals: ({ userId, channel, limit }) => {
      const ids = toolExecutor.listPendingApprovalIdsForUser(userId, channel, {
        limit: limit ?? 20,
        includeUnscoped: channel === 'web',
      });
      const summaries = toolExecutor.getApprovalSummaries(ids);
      return ids.map((id) => {
        const summary = summaries.get(id);
        return {
          id,
          toolName: summary?.toolName ?? 'unknown',
          argsPreview: summary?.argsPreview ?? '',
        };
      });
    },

    onSkillsState: () => {
      const config = configRef.current.assistant.skills;
      const statuses = skillRegistry?.listStatus() ?? [];
      return {
        enabled: config.enabled,
        autoSelect: config.autoSelect,
        maxActivePerRequest: config.maxActivePerRequest,
        managedProviders: [
          {
            id: 'gws',
            enabled: enabledManagedProviders.has('gws'),
          },
        ],
        skills: statuses.map((skill) => {
          const requiresProvider = skill.requiredManagedProvider;
          const providerReady = requiresProvider ? enabledManagedProviders.has(requiresProvider) : undefined;
          let disabledReason: string | undefined;
          if (!skill.enabled) {
            disabledReason = 'Disabled at runtime.';
          } else if (requiresProvider && !providerReady) {
            disabledReason = `Requires managed provider '${requiresProvider}' to be enabled and connected.`;
          }
          return {
            ...skill,
            providerReady,
            disabledReason,
          };
        }),
      };
    },

    onSkillsUpdate: ({ skillId, enabled }) => {
      if (!skillRegistry) {
        return { success: false, message: 'Skills runtime is not available.' };
      }
      const updated = enabled ? skillRegistry.enable(skillId) : skillRegistry.disable(skillId);
      if (!updated) {
        return { success: false, message: `Skill '${skillId}' was not found.` };
      }
      const disabledIds = skillRegistry.listStatus()
        .filter((skill) => !skill.enabled)
        .map((skill) => skill.id);
      configRef.current.assistant.skills.disabledSkills = disabledIds;
      const persisted = persistSkillsState();
      if (!persisted.success) {
        if (enabled) {
          skillRegistry.disable(skillId);
        } else {
          skillRegistry.enable(skillId);
        }
        configRef.current.assistant.skills.disabledSkills = skillRegistry.listStatus()
          .filter((skill) => !skill.enabled)
          .map((skill) => skill.id);
        return { success: false, message: persisted.message };
      }
      return {
        success: true,
        message: enabled
          ? `Skill '${skillId}' enabled and persisted to config.`
          : `Skill '${skillId}' disabled and persisted to config.`,
      };
    },

    onToolsRun: async (input) => {
      const result = await toolExecutor.runTool({
        toolName: input.toolName,
        args: input.args ?? {},
        origin: input.origin ?? 'web',
        agentId: input.agentId ?? (configRef.current.channels.web?.defaultAgent ?? configRef.current.channels.cli?.defaultAgent),
        userId: input.userId,
        channel: input.channel,
      });
      analytics.track({
        type: result.success ? 'tool_run_succeeded' : 'tool_run_failed',
        channel: input.channel ?? 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        channelUserId: input.userId ?? 'system',
        agentId: input.agentId,
        metadata: {
          tool: input.toolName,
          status: result.status,
          approvalId: result.approvalId,
        },
      });
      return result;
    },

    onToolsPolicyUpdate: (input) => {
      const policy = toolExecutor.updatePolicy(input);
      runtime.applyShellAllowedCommands(policy.sandbox.allowedCommands);
      configRef.current.assistant.tools = {
        ...configRef.current.assistant.tools,
        policyMode: policy.mode,
        toolPolicies: { ...policy.toolPolicies },
        allowedPaths: [...policy.sandbox.allowedPaths],
        allowedCommands: [...policy.sandbox.allowedCommands],
        allowedDomains: [...policy.sandbox.allowedDomains],
      };
      const persisted = persistToolsState(policy);
      if (!persisted.success) {
        return { success: false, message: persisted.message };
      }
      analytics.track({
        type: 'tool_policy_updated',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: {
          mode: policy.mode,
          paths: policy.sandbox.allowedPaths.length,
          commands: policy.sandbox.allowedCommands.length,
          domains: policy.sandbox.allowedDomains.length,
        },
      });
      return {
        success: true,
        message: 'Tool policy updated and applied live (no restart required).',
        policy,
      };
    },

    onBrowserConfigState: () => {
      const browser = configRef.current.assistant.tools.browser;
      return {
        enabled: browser?.enabled ?? true,
        allowedDomains: browser?.allowedDomains ?? configRef.current.assistant.tools.allowedDomains ?? [],
        playwrightEnabled: browser?.playwrightEnabled ?? true,
        lightpandaEnabled: browser?.lightpandaEnabled ?? false,
        playwrightBrowser: browser?.playwrightBrowser ?? 'chromium',
        playwrightCaps: browser?.playwrightCaps ?? 'network,storage',
      };
    },

    onBrowserConfigUpdate: (input) => {
      const current = configRef.current.assistant.tools.browser ?? { enabled: true };
      const updated = {
        ...current,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.allowedDomains ? { allowedDomains: input.allowedDomains } : {}),
        ...(input.playwrightEnabled !== undefined ? { playwrightEnabled: input.playwrightEnabled } : {}),
        ...(input.lightpandaEnabled !== undefined ? { lightpandaEnabled: input.lightpandaEnabled } : {}),
        ...(input.playwrightBrowser ? { playwrightBrowser: input.playwrightBrowser as BrowserConfig['playwrightBrowser'] } : {}),
        ...(input.playwrightCaps ? { playwrightCaps: input.playwrightCaps } : {}),
      };
      configRef.current.assistant.tools.browser = updated;
      const persisted = persistToolsState(toolExecutor.getPolicy());
      if (!persisted.success) {
        return { success: false, message: persisted.message };
      }
      analytics.track({
        type: 'browser_config_updated',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: { enabled: updated.enabled },
      });
      log.info({ browser: updated }, 'Browser config updated (restart required for changes to take effect)');
      return {
        success: true,
        message: updated.enabled
          ? 'Browser tools enabled. Restart to apply changes.'
          : 'Browser tools disabled. Restart to apply changes.',
      };
    },

    onToolsApprovalDecision: async (input) => {
      const result = await toolExecutor.decideApproval(
        input.approvalId,
        input.decision,
        input.actor,
        input.reason,
      );
      const continueConversation = [...chatAgents.values()].some((agent) => agent.hasSuspendedApproval(input.approvalId));
      let displayMessage: string | undefined;
      if (!continueConversation) {
        for (const agent of chatAgents.values()) {
          const followUp = agent.takeApprovalFollowUp(input.approvalId, input.decision);
          if (followUp) {
            displayMessage = followUp;
            break;
          }
        }
      }
      if (!displayMessage && !continueConversation) {
        displayMessage = result.message;
      }
      analytics.track({
        type: result.success ? 'tool_approval_decided' : 'tool_approval_failed',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: {
          approvalId: input.approvalId,
          decision: input.decision,
          success: result.success,
          message: result.message,
        },
      });
      return {
        success: result.success,
        message: result.message,
        continueConversation,
        displayMessage,
      };
    },

    onToolsCategories: () => toolExecutor.getCategoryInfo(),

    onToolsCategoryToggle: (input) => {
      const { category, enabled } = input;
      toolExecutor.setCategoryEnabled(category, enabled);
      const disabled = toolExecutor.getDisabledCategories();
      configRef.current.assistant.tools.disabledCategories = disabled;
      const persisted = persistToolsState(toolExecutor.getPolicy());
      if (!persisted.success) {
        return { success: false, message: persisted.message };
      }
      analytics.track({
        type: 'tool_category_toggled',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: { category, enabled },
      });
      return {
        success: true,
        message: `Category '${category}' ${enabled ? 'enabled' : 'disabled'}.`,
      };
    },

    onToolsProviderRoutingUpdate: (input) => {
      // Handle enabled/disabled toggle
      if (typeof input.enabled === 'boolean') {
        configRef.current.assistant.tools.providerRoutingEnabled = input.enabled;
      }

      // Handle routing map update (if provided)
      if (input.routing) {
        const validValues = new Set(['local', 'external', 'default']);
        const routing: Record<string, 'local' | 'external' | 'default'> = {};
        for (const [key, value] of Object.entries(input.routing)) {
          if (!validValues.has(value as string)) {
            return { success: false, message: `Invalid routing value '${value}' for '${key}'. Must be local, external, or default.` };
          }
          // Strip 'default' entries — they're no-ops and clutter the config
          if (value !== 'default') {
            routing[key] = value as 'local' | 'external' | 'default';
          }
        }
        configRef.current.assistant.tools.providerRouting = routing;
      }

      const persisted = persistToolsState(toolExecutor.getPolicy());
      if (!persisted.success) {
        return { success: false, message: persisted.message };
      }
      return { success: true, message: 'Provider routing updated.' };
    },

    onConnectorsState: ({ limitRuns } = {}) => connectors.getState(limitRuns ?? 50),

    onConnectorsSettingsUpdate: (input) => {
      const before = connectors.getConfig();
      const result = connectors.updateSettings(input);
      if (!result.success) return result;
      const persisted = persistConnectorsState();
      if (!persisted.success) {
        connectors.updateConfig(before);
        return persisted;
      }

      analytics.track({
        type: 'connector_settings_updated',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: {
          enabled: String(input.enabled ?? ''),
          executionMode: input.executionMode ?? '',
        },
      });
      return result;
    },

    onConnectorsPackUpsert: (pack) => {
      const before = connectors.getConfig();
      const result = connectors.upsertPack(pack);
      if (!result.success) return result;
      const persisted = persistConnectorsState();
      if (!persisted.success) {
        connectors.updateConfig(before);
        return persisted;
      }

      analytics.track({
        type: 'connector_pack_upserted',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: { packId: pack.id, enabled: String(pack.enabled) },
      });
      return result;
    },

    onConnectorsPackDelete: (packId) => {
      const before = connectors.getConfig();
      const result = connectors.deletePack(packId);
      if (!result.success) return result;
      const persisted = persistConnectorsState();
      if (!persisted.success) {
        connectors.updateConfig(before);
        return persisted;
      }

      analytics.track({
        type: 'connector_pack_deleted',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: { packId },
      });
      return result;
    },

    onPlaybookUpsert: (playbook) => {
      const before = connectors.getConfig();
      const result = connectors.upsertPlaybook(playbook);
      if (!result.success) return result;
      const persisted = persistConnectorsState();
      if (!persisted.success) {
        connectors.updateConfig(before);
        return persisted;
      }
      analytics.track({
        type: 'playbook_upserted',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: { playbookId: playbook.id, enabled: String(playbook.enabled), mode: playbook.mode },
      });
      return result;
    },

    onPlaybookDelete: (playbookId) => {
      const before = connectors.getConfig();
      const result = connectors.deletePlaybook(playbookId);
      if (!result.success) return result;
      const persisted = persistConnectorsState();
      if (!persisted.success) {
        connectors.updateConfig(before);
        return persisted;
      }

      analytics.track({
        type: 'playbook_deleted',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: { playbookId },
      });
      return result;
    },

    onPlaybookRun: async (input) => {
      const result = await connectors.runPlaybook({
        playbookId: input.playbookId,
        dryRun: input.dryRun,
        origin: input.origin ?? 'web',
        agentId: input.agentId,
        userId: input.userId,
        channel: input.channel,
        requestedBy: input.requestedBy,
      });
      analytics.track({
        type: result.success ? 'playbook_run_succeeded' : 'playbook_run_failed',
        channel: input.channel ?? 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        channelUserId: input.userId ?? 'system',
        agentId: input.agentId,
        metadata: {
          playbookId: input.playbookId,
          status: result.status,
          dryRun: String(!!input.dryRun),
        },
      });
      // Feed step outputs to device inventory
      if (result.run?.steps) {
        deviceInventory.ingestPlaybookResults(result.run.steps);
        const hasNetworkScanSteps = result.run.steps.some((step) =>
          step.toolName === 'net_arp_scan'
          || step.toolName === 'net_port_check'
          || step.toolName === 'net_dns_lookup',
        );
        if (hasNetworkScanSteps) {
          runNetworkAnalysis('playbook-run:web');
        }
      }
      return result;
    },

    onConnectorsTemplates: () => listTemplates(connectors),

    onConnectorsTemplateInstall: (templateId) => {
      const result = installTemplate(templateId, connectors);
      if (result.success) {
        persistConnectorsState();
        analytics.track({
          type: 'template_installed',
          channel: 'system',
          canonicalUserId: configRef.current.assistant.identity.primaryUserId,
          metadata: { templateId },
        });
      }
      return result;
    },

    onNetworkDevices: () => ({
      devices: deviceInventory.listDevices(),
    }),

    onNetworkScan: async () => {
      // Try to run the network-discovery playbook if installed
      const state = connectors.getState();
      const pb = state.playbooks.find((p) => p.id === 'network-discovery');
      if (!pb) {
        // Auto-install home-network template and retry
        const installed = installTemplate('home-network', connectors);
        if (!installed.success) {
          return { success: false, message: 'Could not install home-network template for scanning.', devicesFound: 0 };
        }
        persistConnectorsState();
      }
      const result = await connectors.runPlaybook({
        playbookId: 'network-discovery',
        origin: 'web',
        userId: 'web-user',
        channel: 'web',
        requestedBy: 'web-user',
      });
      if (result.run?.steps) {
        deviceInventory.ingestPlaybookResults(result.run.steps);
      }
      const report = runNetworkAnalysis('network-scan:web');
      return {
        success: result.success,
        message: report.anomalies.length > 0
          ? `${result.message} (${report.anomalies.length} network anomalies detected)`
          : result.message,
        devicesFound: deviceInventory.size,
        run: result.run,
      };
    },

    onNetworkBaseline: () => networkBaseline.getSnapshot(),

    onNetworkThreats: (args) => {
      const includeAcknowledged = !!args?.includeAcknowledged;
      const parsedLimit = Number(args?.limit ?? 100);
      const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(500, parsedLimit)) : 100;
      const alerts = networkBaseline.listAlerts({ includeAcknowledged, limit });
      const bySeverity = {
        low: alerts.filter((a) => a.severity === 'low').length,
        medium: alerts.filter((a) => a.severity === 'medium').length,
        high: alerts.filter((a) => a.severity === 'high').length,
        critical: alerts.filter((a) => a.severity === 'critical').length,
      };
      const baseline = networkBaseline.getSnapshot();
      return {
        alerts,
        activeAlertCount: alerts.length,
        bySeverity,
        baselineReady: baseline.baselineReady,
        snapshotCount: baseline.snapshotCount,
      };
    },

    onNetworkThreatAcknowledge: (alertId) => {
      if (!alertId.trim()) {
        return { success: false, message: 'alertId is required' };
      }
      return networkBaseline.acknowledgeAlert(alertId.trim());
    },

    onHostMonitorStatus: () => hostMonitor.getStatus(),

    onHostMonitorAlerts: (args) => {
      const includeAcknowledged = !!args?.includeAcknowledged;
      const parsedLimit = Number(args?.limit ?? 100);
      const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(500, parsedLimit)) : 100;
      const alerts = hostMonitor.listAlerts({ includeAcknowledged, limit });
      const status = hostMonitor.getStatus();
      return {
        alerts,
        activeAlertCount: alerts.length,
        bySeverity: status.bySeverity,
        baselineReady: status.baselineReady,
        lastUpdatedAt: status.lastUpdatedAt,
      };
    },

    onHostMonitorAcknowledge: (alertId) => {
      if (!alertId.trim()) {
        return { success: false, message: 'alertId is required' };
      }
      return hostMonitor.acknowledgeAlert(alertId.trim());
    },

    onHostMonitorCheck: () => runHostMonitoring('web:manual'),

    onGatewayMonitorStatus: () => gatewayMonitor.getStatus(),

    onGatewayMonitorAlerts: (args) => {
      const includeAcknowledged = !!args?.includeAcknowledged;
      const parsedLimit = Number(args?.limit ?? 100);
      const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(500, parsedLimit)) : 100;
      const alerts = gatewayMonitor.listAlerts({ includeAcknowledged, limit });
      const status = gatewayMonitor.getStatus();
      return {
        alerts,
        activeAlertCount: alerts.length,
        bySeverity: status.bySeverity,
        baselineReady: status.baselineReady,
        lastUpdatedAt: status.lastUpdatedAt,
      };
    },

    onGatewayMonitorAcknowledge: (alertId) => {
      if (!alertId.trim()) {
        return { success: false, message: 'alertId is required' };
      }
      return gatewayMonitor.acknowledgeAlert(alertId.trim());
    },

    onGatewayMonitorCheck: () => runGatewayMonitoring('web:manual'),

    onSSESubscribe: (listener: SSEListener): (() => void) => {
      const cleanups: Array<() => void> = [];

      // Real-time audit events
      const unsubAudit = runtime.auditLog.addListener((event) => {
        listener({ type: 'audit', data: event });
      });
      cleanups.push(unsubAudit);

      const onSecurityAlert = (event: import('./queue/event-bus.js').AgentEvent): void => {
        listener({ type: 'security.alert', data: event.payload });
      };
      runtime.eventBus.subscribeByType('security:alert', onSecurityAlert);
      cleanups.push(() => runtime.eventBus.unsubscribeByType('security:alert', onSecurityAlert));

      // Metrics every 5s
      const metricsInterval = setInterval(() => {
        const agents = runtime.registry.getAll().map((inst) => toDashboardAgentInfo(inst));
        listener({
          type: 'metrics',
          data: {
            agents,
            eventBusPending: runtime.eventBus.pending,
            timestamp: Date.now(),
          },
        });
      }, 5_000);
      cleanups.push(() => clearInterval(metricsInterval));

      // Watchdog every 10s
      const watchdogInterval = setInterval(() => {
        listener({
          type: 'watchdog',
          data: {
            results: runtime.watchdog.check(),
            timestamp: Date.now(),
          },
        });
      }, 10_000);
      cleanups.push(() => clearInterval(watchdogInterval));

      return () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
      };
    },

    onDispatch: async (agentId, msg, routeDecision, options) => {
      const channel = msg.channel ?? 'web';
      const channelUserId = msg.userId ?? `${channel}-user`;
      const canonicalUserId = identity.resolveCanonicalUserId(channel, channelUserId);
      const priority = options?.priority ?? 'high';
      const requestType = options?.requestType?.trim() || 'chat';
      analytics.track({
        type: 'message_sent',
        channel,
        canonicalUserId,
        channelUserId,
        agentId,
        metadata: routeDecision?.tier ? { tier: routeDecision.tier, complexity: String(routeDecision.complexityScore ?? '') } : undefined,
      });

      return orchestrator.dispatch(
        {
          agentId,
          userId: canonicalUserId,
          channel,
          content: msg.content,
          priority,
          requestType,
        },
        async (dispatchCtx) => {
          const message: UserMessage = {
            id: randomUUID(),
            userId: canonicalUserId,
            channel,
            content: msg.content,
            timestamp: Date.now(),
          };

          try {
            dispatchCtx.markStep('message_built', `messageId=${message.id}`);
            const response = await dispatchCtx.runStep(
              'runtime_dispatch_message',
              async () => runtime.dispatchMessage(agentId, message),
              `agent=${agentId}`,
            );
            analytics.track({
              type: 'message_success',
              channel,
              canonicalUserId,
              channelUserId,
              agentId,
            });
            return response;
          } catch (err) {
            // ── Tier fallback: retry with the opposite-tier agent ──
            const routingCfg = configRef.current.routing;
            const fallbackEnabled = routingCfg?.fallbackOnFailure !== false;
            const fallbackId = routeDecision?.fallbackAgentId;
            if (fallbackEnabled && fallbackId) {
              const messageText = err instanceof Error ? err.message : String(err);
              log.warn(
                { primaryAgent: agentId, fallbackAgent: fallbackId, error: messageText },
                'Primary agent failed — falling back to alternate tier',
              );
              analytics.track({
                type: 'message_error',
                channel,
                canonicalUserId,
                channelUserId,
                agentId,
                metadata: { error: messageText, fallbackAttempt: 'true' },
              });
              try {
                const fallbackResponse = await dispatchCtx.runStep(
                  'runtime_dispatch_fallback',
                  async () => runtime.dispatchMessage(fallbackId, message),
                  `fallback_agent=${fallbackId}`,
                );
                analytics.track({
                  type: 'message_success',
                  channel,
                  canonicalUserId,
                  channelUserId,
                  agentId: fallbackId,
                  metadata: { fallback: 'true' },
                });
                return { ...fallbackResponse, metadata: { ...fallbackResponse.metadata, fallback: true } };
              } catch (fallbackErr) {
                log.error(
                  { fallbackAgent: fallbackId, error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) },
                  'Fallback agent also failed — propagating original error',
                );
                // Fall through to throw original error
              }
            }

            const messageText = err instanceof Error ? err.message : String(err);
            analytics.track({
              type: 'message_error',
              channel,
              canonicalUserId,
              channelUserId,
              agentId,
              metadata: { error: messageText },
            });
            throw err;
          }
        },
      );
    },

    onConversationReset: async ({ agentId, userId, channel }) => {
      const canonicalUserId = identity.resolveCanonicalUserId(channel, userId);
      const stateAgentId = resolveSharedStateAgentId(agentId) ?? agentId;
      const removed = conversations.resetConversation({ agentId: stateAgentId, userId: canonicalUserId, channel });
      analytics.track({
        type: 'conversation_reset',
        channel,
        canonicalUserId,
        channelUserId: userId,
        agentId,
      });
      return {
        success: true,
        message: removed
          ? `Conversation reset for '${agentId}'.`
          : `No stored conversation found for '${agentId}'.`,
      };
    },

    onConversationSessions: ({ userId, channel, agentId }) => {
      const canonicalUserId = identity.resolveCanonicalUserId(channel, userId);
      return conversations.listSessions(canonicalUserId, channel, resolveSharedStateAgentId(agentId) ?? agentId);
    },

    onConversationUseSession: ({ agentId, userId, channel, sessionId }) => {
      const canonicalUserId = identity.resolveCanonicalUserId(channel, userId);
      const ok = conversations.setActiveSession({
        agentId: resolveSharedStateAgentId(agentId) ?? agentId,
        userId: canonicalUserId,
        channel,
      }, sessionId);
      return {
        success: ok,
        message: ok
          ? `Switched to session '${sessionId}'.`
          : `Session '${sessionId}' was not found.`,
      };
    },

    onReferenceGuide: () => getReferenceGuide(),

    onQuickActions: () => getQuickActions(configRef.current.assistant.quickActions),

    onQuickActionRun: async ({ actionId, details, agentId, userId, channel }) => {
      const canonicalUserId = identity.resolveCanonicalUserId(channel, userId);
      const built = buildQuickActionPrompt(configRef.current.assistant.quickActions, actionId, details);
      if (!built) {
        throw new Error(`Unknown quick action '${actionId}'`);
      }
      analytics.track({
        type: 'quick_action_triggered',
        channel,
        canonicalUserId,
        channelUserId: userId,
        agentId,
        metadata: { actionId },
      });
      return orchestrator.dispatch(
        {
          agentId,
          userId: canonicalUserId,
          channel,
          content: built.prompt,
          priority: 'high',
          requestType: 'quick_action',
        },
        async (dispatchCtx) => {
          const message: UserMessage = {
            id: randomUUID(),
            userId: canonicalUserId,
            channel,
            content: built.prompt,
            timestamp: Date.now(),
          };
          dispatchCtx.markStep('quick_action_prompt_built', `action=${actionId}`);
          return dispatchCtx.runStep(
            'runtime_dispatch_message',
            async () => runtime.dispatchMessage(agentId, message),
            `agent=${agentId}`,
          );
        },
      );
    },

    onSetupStatus: async () => {
      const providers = await buildProviderInfo(true);
      return evaluateSetupStatus(configRef.current, providers, toolExecutor.getSandboxHealth());
    },

    onSetupApply: async (input) => {
      return jobTracker.run(
        {
          type: 'config.apply',
          source: 'manual',
          detail: 'Config Center apply',
          metadata: { llmMode: input.llmMode, telegramEnabled: input.telegramEnabled },
        },
        async () => {
          const providerName = input.providerName?.trim() || (input.llmMode === 'ollama' ? 'ollama' : 'primary');
          const existingProvider = configRef.current.llm[providerName];
          const providerType = input.providerType
            ?? (input.llmMode === 'ollama' ? 'ollama' : undefined)
            ?? existingProvider?.provider;
          if (!providerType) {
            return { success: false, message: 'providerType is required for new providers' };
          }
          const model = input.model?.trim();
          if (!model) {
            return { success: false, message: 'model is required' };
          }
          // Start from disk refs merged with in-memory to prevent drift
          const diskRefsForSetup = (() => {
            try {
              const raw = loadRawConfig();
              const creds = (raw?.assistant as Record<string, unknown>)?.credentials as Record<string, unknown> | undefined;
              return (creds?.refs ?? {}) as Record<string, CredentialRefConfig>;
            } catch { return {} as Record<string, CredentialRefConfig>; }
          })();
          const nextCredentialRefs = { ...diskRefsForSetup, ...(configRef.current.assistant.credentials.refs ?? {}) };
          const pendingLocalSecrets: Array<{ refName: string; secretId: string; value: string; description: string }> = [];
          let providerCredentialRef = input.credentialRef?.trim() || existingProvider?.credentialRef?.trim() || undefined;
          if (input.apiKey?.trim()) {
            const refName = input.credentialRef?.trim() || providerCredentialRef || `llm.${providerName}.local`;
            const existingRef = nextCredentialRefs[refName];
            const secretId = existingRef?.source === 'local' && existingRef.secretId?.trim()
              ? existingRef.secretId.trim()
              : randomUUID();
            nextCredentialRefs[refName] = {
              source: 'local',
              secretId,
              description: `${providerName} ${providerType} credential`,
            };
            pendingLocalSecrets.push({
              refName,
              secretId,
              value: input.apiKey.trim(),
              description: `${providerName} ${providerType} credential`,
            });
            providerCredentialRef = refName;
          } else if (input.credentialRef !== undefined) {
            providerCredentialRef = input.credentialRef.trim() || undefined;
          }

          const localProviderEndpoint = isLocalProviderEndpoint(input.baseUrl?.trim() || existingProvider?.baseUrl, providerType);
          const providerLocality: 'local' | 'external' = localProviderEndpoint ? 'local' : 'external';
          if (providerType !== 'ollama'
            && !localProviderEndpoint
            && !providerCredentialRef) {
            return { success: false, message: 'apiKey or credentialRef is required for external providers' };
          }

          const explicitPreferredProvider = configRef.current.assistant.tools.preferredProviders?.[providerLocality]?.trim();
          const shouldSetPreferredProvider = !explicitPreferredProvider
            || getProviderLocality(configRef.current.llm[explicitPreferredProvider]) !== providerLocality;

          let telegramCredentialRef = configRef.current.channels.telegram?.botTokenCredentialRef?.trim() || undefined;
          if (input.telegramBotToken?.trim()) {
            telegramCredentialRef = telegramCredentialRef || 'telegram.bot.primary';
            const existingRef = nextCredentialRefs[telegramCredentialRef];
            const secretId = existingRef?.source === 'local' && existingRef.secretId?.trim()
              ? existingRef.secretId.trim()
              : randomUUID();
            nextCredentialRefs[telegramCredentialRef] = {
              source: 'local',
              secretId,
              description: 'Telegram bot token',
            };
            pendingLocalSecrets.push({
              refName: telegramCredentialRef,
              secretId,
              value: input.telegramBotToken.trim(),
              description: 'Telegram bot token',
            });
          } else if (telegramCredentialRef && !nextCredentialRefs[telegramCredentialRef]) {
            // Ref name set but entry missing — recover from disk config
            try {
              const rawOnDisk = loadRawConfig();
              const diskRefs = (rawOnDisk?.assistant as Record<string, unknown>)?.credentials as Record<string, unknown> | undefined;
              const diskRef = (diskRefs?.refs as Record<string, Record<string, unknown>> | undefined)?.[telegramCredentialRef];
              if (diskRef && typeof diskRef.secretId === 'string') {
                nextCredentialRefs[telegramCredentialRef] = {
                  source: (diskRef.source as string) || 'local',
                  secretId: diskRef.secretId,
                  description: (diskRef.description as string) || 'Telegram bot token',
                } as typeof nextCredentialRefs[string];
              }
            } catch {
              // Best-effort — validation will flag if still missing
            }
          }

          const patch: Partial<GuardianAgentConfig> = {
            llm: {
              [providerName]: {
                provider: providerType,
                model,
                credentialRef: providerCredentialRef,
                baseUrl: input.baseUrl?.trim() || (providerType === 'ollama' ? 'http://127.0.0.1:11434' : undefined),
              },
            } as GuardianAgentConfig['llm'],
            assistant: {
              ...configRef.current.assistant,
              credentials: {
                refs: nextCredentialRefs,
              },
              setup: {
                completed: input.setupCompleted ?? true,
              },
            },
          };

          if (shouldSetPreferredProvider) {
            patch.assistant = {
              ...(patch.assistant ?? configRef.current.assistant),
              tools: {
                ...configRef.current.assistant.tools,
                preferredProviders: {
                  ...configRef.current.assistant.tools.preferredProviders,
                  [providerLocality]: providerName,
                },
              },
            };
          }

          if (input.setDefaultProvider !== false) {
            patch.defaultProvider = providerName;
          }

          if (input.telegramEnabled !== undefined) {
            patch.channels = {
              ...configRef.current.channels,
              telegram: {
                enabled: input.telegramEnabled,
                polling: configRef.current.channels.telegram?.polling ?? true,
                botTokenCredentialRef: telegramCredentialRef,
                allowedChatIds: input.telegramAllowedChatIds ?? configRef.current.channels.telegram?.allowedChatIds,
                defaultAgent: configRef.current.channels.telegram?.defaultAgent,
              },
            };
          }

          const nextConfig = deepMerge(configRef.current, patch);
          const errors = validateConfig(nextConfig);
          if (errors.length > 0) {
            analytics.track({
              type: 'setup_apply_failed',
              channel: 'system',
              canonicalUserId: configRef.current.assistant.identity.primaryUserId,
              metadata: { errors },
            });
            return { success: false, message: `Validation failed: ${errors.join('; ')}` };
          }

          const rawConfig = loadRawConfig();
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.setup = {
            ...(rawAssistant.setup as Record<string, unknown> ?? {}),
            completed: input.setupCompleted ?? true,
          };
          rawAssistant.credentials = (rawAssistant.credentials as Record<string, unknown> | undefined) ?? {};
          (rawAssistant.credentials as Record<string, unknown>).refs = {
            ...((rawAssistant.credentials as Record<string, unknown>).refs as Record<string, unknown> ?? {}),
          };
          for (const pending of pendingLocalSecrets) {
            upsertLocalCredentialRef(rawConfig, pending.refName, pending.value, pending.description);
          }

          rawConfig.llm = rawConfig.llm ?? {};
          const rawLLM = rawConfig.llm as Record<string, Record<string, unknown>>;
          rawLLM[providerName] = {
            ...(rawLLM[providerName] ?? {}),
            provider: providerType,
            model,
          };
          if (input.baseUrl?.trim()) rawLLM[providerName].baseUrl = input.baseUrl.trim();
          if (providerType === 'ollama' && !rawLLM[providerName].baseUrl) {
            rawLLM[providerName].baseUrl = 'http://127.0.0.1:11434';
          }
          delete rawLLM[providerName].apiKey;
          if (providerCredentialRef !== undefined) {
            const trimmed = providerCredentialRef.trim();
            if (trimmed) rawLLM[providerName].credentialRef = trimmed;
            else delete rawLLM[providerName].credentialRef;
          }

          if (input.setDefaultProvider !== false) {
            rawConfig.defaultProvider = providerName;
          }

          if (shouldSetPreferredProvider) {
            rawConfig.assistant = rawConfig.assistant ?? {};
            const rawAssistantObj = rawConfig.assistant as Record<string, unknown>;
            rawAssistantObj.tools = (rawAssistantObj.tools as Record<string, unknown> | undefined) ?? {};
            const rawTools = rawAssistantObj.tools as Record<string, unknown>;
            rawTools.preferredProviders = {
              ...((rawTools.preferredProviders as Record<string, unknown> | undefined) ?? {}),
              [providerLocality]: providerName,
            };
          }

          if (input.telegramEnabled !== undefined) {
            rawConfig.channels = rawConfig.channels ?? {};
            const rawChannels = rawConfig.channels as Record<string, unknown>;
            const rawTelegram = (rawChannels.telegram as Record<string, unknown> | undefined) ?? {};
            rawTelegram.enabled = input.telegramEnabled;
            rawTelegram.polling = rawTelegram.polling ?? true;
            delete rawTelegram.botToken;
            if (telegramCredentialRef) rawTelegram.botTokenCredentialRef = telegramCredentialRef;
            if (input.telegramAllowedChatIds) rawTelegram.allowedChatIds = input.telegramAllowedChatIds;
            rawChannels.telegram = rawTelegram;
          }

          // Fallbacks
          if (input.fallbacks !== undefined) {
            rawConfig.fallbacks = input.fallbacks.length > 0 ? input.fallbacks : undefined;
          }

          // Web search config
          const hasWebSearch = input.webSearchProvider
            || input.perplexityApiKey !== undefined
            || input.openRouterApiKey !== undefined
            || input.braveApiKey !== undefined
            || input.perplexityCredentialRef !== undefined
            || input.openRouterCredentialRef !== undefined
            || input.braveCredentialRef !== undefined;
          if (hasWebSearch) {
            rawConfig.assistant = rawConfig.assistant ?? {};
            const rawAssistantObj = rawConfig.assistant as Record<string, unknown>;
            rawAssistantObj.tools = rawAssistantObj.tools ?? {};
            const rawTools = rawAssistantObj.tools as Record<string, unknown>;
            rawTools.webSearch = rawTools.webSearch ?? {};
            const rawWS = rawTools.webSearch as Record<string, unknown>;
            if (input.webSearchProvider) rawWS.provider = input.webSearchProvider;
            if (input.perplexityApiKey?.trim()) {
              const refName = input.perplexityCredentialRef?.trim() || rawWS.perplexityCredentialRef as string || 'search.perplexity.local';
              rawWS.perplexityCredentialRef = upsertLocalCredentialRef(rawConfig, refName, input.perplexityApiKey.trim(), 'Perplexity search API key');
            }
            delete rawWS.perplexityApiKey;
            if (input.perplexityCredentialRef !== undefined) {
              if (input.perplexityCredentialRef.trim()) rawWS.perplexityCredentialRef = input.perplexityCredentialRef.trim();
              else delete rawWS.perplexityCredentialRef;
            }
            if (input.openRouterApiKey?.trim()) {
              const refName = input.openRouterCredentialRef?.trim() || rawWS.openRouterCredentialRef as string || 'search.openrouter.local';
              rawWS.openRouterCredentialRef = upsertLocalCredentialRef(rawConfig, refName, input.openRouterApiKey.trim(), 'OpenRouter search API key');
            }
            delete rawWS.openRouterApiKey;
            if (input.openRouterCredentialRef !== undefined) {
              if (input.openRouterCredentialRef.trim()) rawWS.openRouterCredentialRef = input.openRouterCredentialRef.trim();
              else delete rawWS.openRouterCredentialRef;
            }
            if (input.braveApiKey?.trim()) {
              const refName = input.braveCredentialRef?.trim() || rawWS.braveCredentialRef as string || 'search.brave.local';
              rawWS.braveCredentialRef = upsertLocalCredentialRef(rawConfig, refName, input.braveApiKey.trim(), 'Brave search API key');
            }
            delete rawWS.braveApiKey;
            if (input.braveCredentialRef !== undefined) {
              if (input.braveCredentialRef.trim()) rawWS.braveCredentialRef = input.braveCredentialRef.trim();
              else delete rawWS.braveCredentialRef;
            }
          }

          const result = persistAndApplyConfig(rawConfig, {
            changedBy: 'setup-wizard',
            reason: 'setup apply',
          });
          analytics.track({
            type: result.success ? 'setup_applied' : 'setup_apply_failed',
            channel: 'system',
            canonicalUserId: configRef.current.assistant.identity.primaryUserId,
            metadata: { providerName, providerType, telegramEnabled: input.telegramEnabled, result: result.message },
          });
          if (!result.success) return result;

          return {
            success: true,
            message: input.telegramEnabled
              ? 'Setup saved and applied. Telegram channel is being reloaded.'
              : 'Setup saved and applied.',
          };
        },
      );
    },

    onSearchConfigUpdate: async (input) => {
      const rawConfig = loadRawConfig();
      rawConfig.assistant = rawConfig.assistant ?? {};
      const rawAssistant = rawConfig.assistant as Record<string, unknown>;
      rawAssistant.tools = rawAssistant.tools ?? {};
      const rawTools = rawAssistant.tools as Record<string, unknown>;
      rawTools.webSearch = rawTools.webSearch ?? {};
      const rawWS = rawTools.webSearch as Record<string, unknown>;

      if (input.webSearchProvider) rawWS.provider = input.webSearchProvider;
      if (input.perplexityApiKey?.trim()) {
        const refName = input.perplexityCredentialRef?.trim() || (typeof rawWS.perplexityCredentialRef === 'string' ? rawWS.perplexityCredentialRef : '') || 'search.perplexity.local';
        rawWS.perplexityCredentialRef = upsertLocalCredentialRef(rawConfig, refName, input.perplexityApiKey.trim(), 'Perplexity search API key');
      }
      delete rawWS.perplexityApiKey;
      if (input.perplexityCredentialRef !== undefined) {
        if (input.perplexityCredentialRef.trim()) rawWS.perplexityCredentialRef = input.perplexityCredentialRef.trim();
        else delete rawWS.perplexityCredentialRef;
      }
      if (input.openRouterApiKey?.trim()) {
        const refName = input.openRouterCredentialRef?.trim() || (typeof rawWS.openRouterCredentialRef === 'string' ? rawWS.openRouterCredentialRef : '') || 'search.openrouter.local';
        rawWS.openRouterCredentialRef = upsertLocalCredentialRef(rawConfig, refName, input.openRouterApiKey.trim(), 'OpenRouter search API key');
      }
      delete rawWS.openRouterApiKey;
      if (input.openRouterCredentialRef !== undefined) {
        if (input.openRouterCredentialRef.trim()) rawWS.openRouterCredentialRef = input.openRouterCredentialRef.trim();
        else delete rawWS.openRouterCredentialRef;
      }
      if (input.braveApiKey?.trim()) {
        const refName = input.braveCredentialRef?.trim() || (typeof rawWS.braveCredentialRef === 'string' ? rawWS.braveCredentialRef : '') || 'search.brave.local';
        rawWS.braveCredentialRef = upsertLocalCredentialRef(rawConfig, refName, input.braveApiKey.trim(), 'Brave search API key');
      }
      delete rawWS.braveApiKey;
      if (input.braveCredentialRef !== undefined) {
        if (input.braveCredentialRef.trim()) rawWS.braveCredentialRef = input.braveCredentialRef.trim();
        else delete rawWS.braveCredentialRef;
      }

      if (input.fallbacks !== undefined) {
        rawConfig.fallbacks = input.fallbacks.length > 0 ? input.fallbacks : undefined;
      }

      const result = persistAndApplyConfig(rawConfig, {
        changedBy: 'config-center',
        reason: 'search config update',
      });
      if (!result.success) return result;
      return { success: true, message: 'Search and fallback settings saved.' };
    },

    onConfigUpdate: async (updates) => {
      return jobTracker.run(
        {
          type: 'config.update',
          source: 'manual',
          detail: 'Direct config update',
          metadata: { defaultProvider: updates.defaultProvider },
        },
        async () => {
          const currentConfig = configRef.current;
          let credentialRefsChanged = !!updates.assistant?.credentials?.refs;
          // Start from disk refs so we never silently drop refs that exist on disk
          // but drifted out of in-memory state.
          const diskRefsForBase = (() => {
            try {
              const raw = loadRawConfig();
              const creds = (raw?.assistant as Record<string, unknown>)?.credentials as Record<string, unknown> | undefined;
              return (creds?.refs ?? {}) as Record<string, CredentialRefConfig>;
            } catch { return {} as Record<string, CredentialRefConfig>; }
          })();
          const nextCredentialRefs = updates.assistant?.credentials?.refs
            ? normalizeCredentialRefUpdates(updates.assistant.credentials.refs)
            : { ...diskRefsForBase, ...(currentConfig.assistant.credentials.refs ?? {}) };
          const llmPatch = updates.llm
            ? Object.fromEntries(Object.entries(updates.llm).map(([name, providerUpdates]) => {
              let credentialRef = providerUpdates.credentialRef;
              if (providerUpdates.apiKey?.trim()) {
                const refName = providerUpdates.credentialRef?.trim()
                  || currentConfig.llm[name]?.credentialRef?.trim()
                  || `llm.${name}.local`;
                const existingRef = nextCredentialRefs[refName];
                const secretId = existingRef?.source === 'local' && existingRef.secretId?.trim()
                  ? existingRef.secretId.trim()
                  : randomUUID();
                nextCredentialRefs[refName] = {
                  source: 'local',
                  secretId,
                  description: `${name} provider credential`,
                };
                credentialRefsChanged = true;
                secretStore.set(secretId, providerUpdates.apiKey.trim());
                credentialRef = refName;
              }
              return [name, {
                ...providerUpdates,
                apiKey: undefined,
                credentialRef,
              }];
            }))
            : undefined;
          const telegramUpdates = updates.channels?.telegram
            ? { ...updates.channels.telegram }
            : undefined;
          if (telegramUpdates?.botToken?.trim()) {
            const refName = telegramUpdates.botTokenCredentialRef?.trim()
              || currentConfig.channels.telegram?.botTokenCredentialRef?.trim()
              || 'telegram.bot.primary';
            const existingRef = nextCredentialRefs[refName];
            const secretId = existingRef?.source === 'local' && existingRef.secretId?.trim()
              ? existingRef.secretId.trim()
              : randomUUID();
            nextCredentialRefs[refName] = {
              source: 'local',
              secretId,
              description: 'Telegram bot token',
            };
            credentialRefsChanged = true;
            secretStore.set(secretId, telegramUpdates.botToken.trim());
            telegramUpdates.botTokenCredentialRef = refName;
            telegramUpdates.botToken = undefined;
          } else if (telegramUpdates) {
            // No new token — carry forward the existing credential ref entry so validation doesn't fail.
            const existingRefName = telegramUpdates.botTokenCredentialRef?.trim()
              || currentConfig.channels.telegram?.botTokenCredentialRef?.trim();
            if (existingRefName && !nextCredentialRefs[existingRefName]) {
              // Ref name is set but entry is missing (e.g. config YAML was edited manually,
              // or previous save didn't persist the refs section). Try to recover the entry
              // from the raw config file on disk.
              try {
                const rawOnDisk = loadRawConfig();
                const diskRefs = (rawOnDisk?.assistant as Record<string, unknown>)?.credentials as Record<string, unknown> | undefined;
                const diskRef = (diskRefs?.refs as Record<string, Record<string, unknown>> | undefined)?.[existingRefName];
                if (diskRef && typeof diskRef.secretId === 'string') {
                  nextCredentialRefs[existingRefName] = {
                    source: (diskRef.source as string) || 'local',
                    secretId: diskRef.secretId,
                    description: (diskRef.description as string) || 'Telegram bot token',
                  } as typeof nextCredentialRefs[string];
                  credentialRefsChanged = true;
                }
              } catch {
                // Best-effort recovery — validation will flag the missing ref
              }
            }
          }
          const cloudPatch = updates.assistant?.tools?.cloud
            ? mergeCloudConfigForValidation(currentConfig.assistant.tools.cloud, updates.assistant.tools.cloud)
            : undefined;
          const assistantPatch = updates.assistant || credentialRefsChanged
            ? {
              ...(updates.assistant ?? {}),
              credentials: credentialRefsChanged || updates.assistant?.credentials
                ? {
                  refs: nextCredentialRefs,
                }
                : undefined,
              tools: updates.assistant?.tools
                ? {
                  ...updates.assistant.tools,
                  ...(cloudPatch ? { cloud: cloudPatch } : {}),
                }
                : undefined,
            }
            : undefined;

          // Validate the next in-memory config first.
          const patch = {
            defaultProvider: updates.defaultProvider,
            llm: llmPatch as unknown as GuardianAgentConfig['llm'] | undefined,
            channels: updates.channels
              ? {
                ...updates.channels,
                telegram: telegramUpdates,
              } as unknown as GuardianAgentConfig['channels']
              : undefined,
            assistant: assistantPatch as unknown as GuardianAgentConfig['assistant'] | undefined,
          } as Partial<GuardianAgentConfig>;
          const nextConfig = deepMerge(currentConfig, patch);
          const errors = validateConfig(nextConfig);
          if (errors.length > 0) {
            analytics.track({
              type: 'config_update_failed',
              channel: 'system',
              canonicalUserId: currentConfig.assistant.identity.primaryUserId,
              metadata: { errors },
            });
            return {
              success: false,
              message: `Validation failed: ${errors.join('; ')}`,
            };
          }

          // Read existing file or start fresh
          const rawConfig = loadRawConfig();

          // Apply updates
          if (updates.defaultProvider) {
            rawConfig.defaultProvider = updates.defaultProvider;
          }

          if (llmPatch) {
            const llmSection = (rawConfig.llm ?? {}) as Record<string, Record<string, unknown>>;
            for (const [name, providerUpdates] of Object.entries(llmPatch)) {
              if (!llmSection[name]) {
                llmSection[name] = {};
              }
              if (providerUpdates.provider) llmSection[name].provider = providerUpdates.provider;
              if (providerUpdates.model) llmSection[name].model = providerUpdates.model;
              delete llmSection[name].apiKey;
              if (providerUpdates.credentialRef !== undefined) {
                const trimmed = providerUpdates.credentialRef.trim();
                if (trimmed) llmSection[name].credentialRef = trimmed;
                else delete llmSection[name].credentialRef;
              }
	              if (providerUpdates.baseUrl !== undefined) {
	                const trimmed = normalizeOptionalHttpUrlInput(providerUpdates.baseUrl);
	                if (trimmed) llmSection[name].baseUrl = trimmed;
	                else delete llmSection[name].baseUrl;
	              }
            }
            rawConfig.llm = llmSection;
          }

          if (telegramUpdates) {
            rawConfig.channels = rawConfig.channels ?? {};
            const rawChannels = rawConfig.channels as Record<string, unknown>;
            const rawTelegram = (rawChannels.telegram as Record<string, unknown> | undefined) ?? {};

            if (typeof telegramUpdates.enabled === 'boolean') {
              rawTelegram.enabled = telegramUpdates.enabled;
            }
            if (typeof telegramUpdates.polling === 'boolean') {
              rawTelegram.polling = telegramUpdates.polling;
            }
            if (telegramUpdates.defaultAgent !== undefined) {
              const trimmed = telegramUpdates.defaultAgent.trim();
              if (trimmed) rawTelegram.defaultAgent = trimmed;
              else delete rawTelegram.defaultAgent;
            }
            delete rawTelegram.botToken;
            if (telegramUpdates.botTokenCredentialRef !== undefined) {
              const trimmed = telegramUpdates.botTokenCredentialRef.trim();
              if (trimmed) rawTelegram.botTokenCredentialRef = trimmed;
              else delete rawTelegram.botTokenCredentialRef;
            }
            if (telegramUpdates.allowedChatIds !== undefined) {
              if (telegramUpdates.allowedChatIds.length > 0) rawTelegram.allowedChatIds = telegramUpdates.allowedChatIds;
              else delete rawTelegram.allowedChatIds;
            }

            rawChannels.telegram = rawTelegram;
          }

          if (credentialRefsChanged) {
            rawConfig.assistant = rawConfig.assistant ?? {};
            const rawAssistant = rawConfig.assistant as Record<string, unknown>;
            rawAssistant.credentials = (rawAssistant.credentials as Record<string, unknown> | undefined) ?? {};
            const rawCredentials = rawAssistant.credentials as Record<string, unknown>;
            const existingDiskRefs = (rawCredentials.refs as Record<string, unknown>) ?? {};
            rawCredentials.refs = { ...existingDiskRefs, ...nextCredentialRefs };
          }

          const notificationUpdates = updates.assistant?.notifications;
          if (notificationUpdates && typeof notificationUpdates === 'object') {
            rawConfig.assistant = rawConfig.assistant ?? {};
            const rawAssistant = rawConfig.assistant as Record<string, unknown>;
            rawAssistant.notifications = (rawAssistant.notifications as Record<string, unknown> | undefined) ?? {};
            const rawNotifications = rawAssistant.notifications as Record<string, unknown>;

            if (typeof notificationUpdates.enabled === 'boolean') {
              rawNotifications.enabled = notificationUpdates.enabled;
            }
            if (notificationUpdates.minSeverity === 'info' || notificationUpdates.minSeverity === 'warn' || notificationUpdates.minSeverity === 'critical') {
              rawNotifications.minSeverity = notificationUpdates.minSeverity;
            }
            if (Array.isArray(notificationUpdates.auditEventTypes)) {
              rawNotifications.auditEventTypes = notificationUpdates.auditEventTypes;
            }
            if (Array.isArray(notificationUpdates.suppressedDetailTypes)) {
              rawNotifications.suppressedDetailTypes = notificationUpdates.suppressedDetailTypes;
            }
            if (typeof notificationUpdates.cooldownMs === 'number' && Number.isFinite(notificationUpdates.cooldownMs)) {
              rawNotifications.cooldownMs = notificationUpdates.cooldownMs;
            }
            if (notificationUpdates.deliveryMode === 'all' || notificationUpdates.deliveryMode === 'selected') {
              rawNotifications.deliveryMode = notificationUpdates.deliveryMode;
            }
            if (notificationUpdates.destinations && typeof notificationUpdates.destinations === 'object') {
              rawNotifications.destinations = (rawNotifications.destinations as Record<string, unknown> | undefined) ?? {};
              const rawDestinations = rawNotifications.destinations as Record<string, unknown>;
              if (typeof notificationUpdates.destinations.web === 'boolean') rawDestinations.web = notificationUpdates.destinations.web;
              if (typeof notificationUpdates.destinations.cli === 'boolean') rawDestinations.cli = notificationUpdates.destinations.cli;
              if (typeof notificationUpdates.destinations.telegram === 'boolean') rawDestinations.telegram = notificationUpdates.destinations.telegram;
            }
          }

          const preferredProviderUpdates = updates.assistant?.tools?.preferredProviders;
          if (preferredProviderUpdates && typeof preferredProviderUpdates === 'object') {
            rawConfig.assistant = rawConfig.assistant ?? {};
            const rawAssistant = rawConfig.assistant as Record<string, unknown>;
            rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
            const rawTools = rawAssistant.tools as Record<string, unknown>;
            rawTools.preferredProviders = {
              ...((rawTools.preferredProviders as Record<string, unknown> | undefined) ?? {}),
            };
            const rawPreferredProviders = rawTools.preferredProviders as Record<string, unknown>;

            if (preferredProviderUpdates.local !== undefined) {
              const trimmed = preferredProviderUpdates.local.trim();
              if (trimmed) rawPreferredProviders.local = trimmed;
              else delete rawPreferredProviders.local;
            }
            if (preferredProviderUpdates.external !== undefined) {
              const trimmed = preferredProviderUpdates.external.trim();
              if (trimmed) rawPreferredProviders.external = trimmed;
              else delete rawPreferredProviders.external;
            }
          }

          const cloudUpdate = updates.assistant?.tools?.cloud;
          if (cloudUpdate && typeof cloudUpdate === 'object') {
            rawConfig.assistant = rawConfig.assistant ?? {};
            const rawAssistant = rawConfig.assistant as Record<string, unknown>;
            rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
            const rawTools = rawAssistant.tools as Record<string, unknown>;
            rawTools.cloud = (rawTools.cloud as Record<string, unknown> | undefined) ?? {};
            const rawCloud = rawTools.cloud as Record<string, unknown>;

            if (typeof cloudUpdate.enabled === 'boolean') {
              rawCloud.enabled = cloudUpdate.enabled;
            }

            if (Array.isArray(cloudUpdate.cpanelProfiles)) {
              const previous = existingProfilesById(rawCloud, 'cpanelProfiles');
              rawCloud.cpanelProfiles = cloudUpdate.cpanelProfiles.map((profile) => {
                const current = previous.get(profile.id);
                const normalized = normalizeCpanelConnectionConfig({
                  host: profile.host.trim(),
                  port: typeof profile.port === 'number' && Number.isFinite(profile.port)
                    ? profile.port
                    : typeof current?.port === 'number' && Number.isFinite(current.port)
                      ? current.port
                      : undefined,
                  ssl: typeof profile.ssl === 'boolean'
                    ? profile.ssl
                    : typeof current?.ssl === 'boolean'
                      ? current.ssl
                      : undefined,
                });
                const next: Record<string, unknown> = {
                  id: profile.id.trim(),
                  name: profile.name.trim(),
                  type: profile.type,
                  host: normalized.host,
                  username: profile.username.trim(),
                };
                if (normalized.port !== undefined) next.port = normalized.port;
                if (normalized.ssl !== undefined) next.ssl = normalized.ssl;
                if (typeof profile.allowSelfSigned === 'boolean') next.allowSelfSigned = profile.allowSelfSigned;
                if (hasOwn(profile, 'defaultCpanelUser')) {
                  const trimmed = trimOrUndefined(profile.defaultCpanelUser);
                  if (trimmed) next.defaultCpanelUser = trimmed;
                } else if (typeof current?.defaultCpanelUser === 'string') {
                  next.defaultCpanelUser = current.defaultCpanelUser;
                }
                if (hasOwn(profile, 'credentialRef')) {
                  const trimmed = trimOrUndefined(profile.credentialRef);
                  if (trimmed) next.credentialRef = trimmed;
                } else if (typeof current?.credentialRef === 'string') {
                  next.credentialRef = current.credentialRef;
                }
                if (hasOwn(profile, 'apiToken')) {
                  const trimmed = trimOrUndefined(profile.apiToken);
                  if (trimmed) next.apiToken = trimmed;
                } else if (typeof current?.apiToken === 'string') {
                  next.apiToken = current.apiToken;
                }
                return next;
              });
            }

            if (Array.isArray(cloudUpdate.vercelProfiles)) {
              const previous = existingProfilesById(rawCloud, 'vercelProfiles');
              rawCloud.vercelProfiles = cloudUpdate.vercelProfiles.map((profile) => {
                const current = previous.get(profile.id);
                const next: Record<string, unknown> = {
                  id: profile.id.trim(),
                  name: profile.name.trim(),
                };
	                if (hasOwn(profile, 'apiBaseUrl')) {
	                  const trimmed = normalizeOptionalHttpUrlInput(typeof profile.apiBaseUrl === 'string' ? profile.apiBaseUrl : undefined);
	                  if (trimmed) next.apiBaseUrl = trimmed;
	                } else if (typeof current?.apiBaseUrl === 'string') {
	                  next.apiBaseUrl = current.apiBaseUrl;
                }
                if (hasOwn(profile, 'credentialRef')) {
                  const trimmed = trimOrUndefined(profile.credentialRef);
                  if (trimmed) next.credentialRef = trimmed;
                } else if (typeof current?.credentialRef === 'string') {
                  next.credentialRef = current.credentialRef;
                }
                if (hasOwn(profile, 'apiToken')) {
                  const trimmed = trimOrUndefined(profile.apiToken);
                  if (trimmed) next.apiToken = trimmed;
                } else if (typeof current?.apiToken === 'string') {
                  next.apiToken = current.apiToken;
                }
                if (hasOwn(profile, 'teamId')) {
                  const trimmed = trimOrUndefined(profile.teamId);
                  if (trimmed) next.teamId = trimmed;
                } else if (typeof current?.teamId === 'string') {
                  next.teamId = current.teamId;
                }
                if (hasOwn(profile, 'slug')) {
                  const trimmed = trimOrUndefined(profile.slug);
                  if (trimmed) next.slug = trimmed;
                } else if (typeof current?.slug === 'string') {
                  next.slug = current.slug;
                }
                return next;
              });
            }

            if (Array.isArray(cloudUpdate.cloudflareProfiles)) {
              const previous = existingProfilesById(rawCloud, 'cloudflareProfiles');
              rawCloud.cloudflareProfiles = cloudUpdate.cloudflareProfiles.map((profile) => {
                const current = previous.get(profile.id);
                const next: Record<string, unknown> = {
                  id: profile.id.trim(),
                  name: profile.name.trim(),
                };
	                if (hasOwn(profile, 'apiBaseUrl')) {
	                  const trimmed = normalizeOptionalHttpUrlInput(typeof profile.apiBaseUrl === 'string' ? profile.apiBaseUrl : undefined);
	                  if (trimmed) next.apiBaseUrl = trimmed;
	                } else if (typeof current?.apiBaseUrl === 'string') {
	                  next.apiBaseUrl = current.apiBaseUrl;
                }
                if (hasOwn(profile, 'credentialRef')) {
                  const trimmed = trimOrUndefined(profile.credentialRef);
                  if (trimmed) next.credentialRef = trimmed;
                } else if (typeof current?.credentialRef === 'string') {
                  next.credentialRef = current.credentialRef;
                }
                if (hasOwn(profile, 'apiToken')) {
                  const trimmed = trimOrUndefined(profile.apiToken);
                  if (trimmed) next.apiToken = trimmed;
                } else if (typeof current?.apiToken === 'string') {
                  next.apiToken = current.apiToken;
                }
                if (hasOwn(profile, 'accountId')) {
                  const trimmed = trimOrUndefined(profile.accountId);
                  if (trimmed) next.accountId = trimmed;
                } else if (typeof current?.accountId === 'string') {
                  next.accountId = current.accountId;
                }
                if (hasOwn(profile, 'defaultZoneId')) {
                  const trimmed = trimOrUndefined(profile.defaultZoneId);
                  if (trimmed) next.defaultZoneId = trimmed;
                } else if (typeof current?.defaultZoneId === 'string') {
                  next.defaultZoneId = current.defaultZoneId;
                }
                return next;
              });
            }

            if (Array.isArray(cloudUpdate.awsProfiles)) {
              const previous = existingProfilesById(rawCloud, 'awsProfiles');
              rawCloud.awsProfiles = cloudUpdate.awsProfiles.map((profile) => {
                const current = previous.get(profile.id);
                const next: Record<string, unknown> = {
                  id: profile.id.trim(),
                  name: profile.name.trim(),
                  region: profile.region.trim(),
                };
                for (const field of [
                  'accessKeyId',
                  'accessKeyIdCredentialRef',
                  'secretAccessKey',
                  'secretAccessKeyCredentialRef',
                  'sessionToken',
                  'sessionTokenCredentialRef',
                ] as const) {
                  if (hasOwn(profile, field)) {
                    const trimmed = trimOrUndefined(profile[field]);
                    if (trimmed) next[field] = trimmed;
                  } else if (typeof current?.[field] === 'string') {
                    next[field] = current[field];
                  }
                }
	                if (hasOwn(profile, 'endpoints')) {
	                  const endpoints = sanitizeNormalizedUrlRecord(profile.endpoints);
	                  if (endpoints) next.endpoints = endpoints;
	                } else if (isRecord(current?.endpoints)) {
	                  next.endpoints = current.endpoints;
                }
                return next;
              });
            }

            if (Array.isArray(cloudUpdate.gcpProfiles)) {
              const previous = existingProfilesById(rawCloud, 'gcpProfiles');
              rawCloud.gcpProfiles = cloudUpdate.gcpProfiles.map((profile) => {
                const current = previous.get(profile.id);
                const next: Record<string, unknown> = {
                  id: profile.id.trim(),
                  name: profile.name.trim(),
                  projectId: profile.projectId.trim(),
                };
                if (hasOwn(profile, 'location')) {
                  const trimmed = trimOrUndefined(profile.location);
                  if (trimmed) next.location = trimmed;
                } else if (typeof current?.location === 'string') {
                  next.location = current.location;
                }
                for (const field of [
                  'accessToken',
                  'accessTokenCredentialRef',
                  'serviceAccountJson',
                  'serviceAccountCredentialRef',
                ] as const) {
                  if (hasOwn(profile, field)) {
                    const trimmed = trimOrUndefined(profile[field]);
                    if (trimmed) next[field] = trimmed;
                  } else if (typeof current?.[field] === 'string') {
                    next[field] = current[field];
                  }
                }
	                if (hasOwn(profile, 'endpoints')) {
	                  const endpoints = sanitizeNormalizedUrlRecord(profile.endpoints);
	                  if (endpoints) next.endpoints = endpoints;
	                } else if (isRecord(current?.endpoints)) {
	                  next.endpoints = current.endpoints;
                }
                return next;
              });
            }

            if (Array.isArray(cloudUpdate.azureProfiles)) {
              const previous = existingProfilesById(rawCloud, 'azureProfiles');
              rawCloud.azureProfiles = cloudUpdate.azureProfiles.map((profile) => {
                const current = previous.get(profile.id);
                const next: Record<string, unknown> = {
                  id: profile.id.trim(),
                  name: profile.name.trim(),
                  subscriptionId: profile.subscriptionId.trim(),
                };
	                for (const field of [
	                  'tenantId',
	                  'accessToken',
	                  'accessTokenCredentialRef',
	                  'clientId',
                  'clientIdCredentialRef',
                  'clientSecret',
                  'clientSecretCredentialRef',
                  'defaultResourceGroup',
                  'blobBaseUrl',
                ] as const) {
	                  if (hasOwn(profile, field)) {
	                    const trimmed = field === 'blobBaseUrl'
	                      ? normalizeOptionalHttpUrlInput(typeof profile[field] === 'string' ? profile[field] : undefined)
	                      : trimOrUndefined(profile[field]);
	                    if (trimmed) next[field] = trimmed;
	                  } else if (typeof current?.[field] === 'string') {
	                    next[field] = current[field];
	                  }
	                }
	                if (hasOwn(profile, 'endpoints')) {
	                  const endpoints = sanitizeNormalizedUrlRecord(profile.endpoints);
	                  if (endpoints) next.endpoints = endpoints;
	                } else if (isRecord(current?.endpoints)) {
	                  next.endpoints = current.endpoints;
                }
                return next;
              });
            }
          }

          const searchUpdate = updates.assistant?.tools?.search;
          if (searchUpdate && typeof searchUpdate === 'object') {
            rawConfig.assistant = rawConfig.assistant ?? {};
            const rawAssistant = rawConfig.assistant as Record<string, unknown>;
            rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
            const rawTools = rawAssistant.tools as Record<string, unknown>;
            rawTools.search = (rawTools.search as Record<string, unknown> | undefined) ?? {};
            const rawSearch = rawTools.search as Record<string, unknown>;
            if (!Array.isArray(rawSearch.sources)) {
              rawSearch.sources = [];
            }
            if (typeof searchUpdate.enabled === 'boolean') {
              rawSearch.enabled = searchUpdate.enabled;
            }
            if (Array.isArray(searchUpdate.sources)) {
              rawSearch.sources = searchUpdate.sources;
            }
          }

          // Sandbox enforcement mode
          const sandboxUpdate = updates.assistant?.tools?.sandbox;
          if (sandboxUpdate && typeof sandboxUpdate === 'object') {
            rawConfig.assistant = rawConfig.assistant ?? {};
            const rawAssistant = rawConfig.assistant as Record<string, unknown>;
            rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
            const rawTools = rawAssistant.tools as Record<string, unknown>;
            rawTools.sandbox = (rawTools.sandbox as Record<string, unknown> | undefined) ?? {};
            const rawSandbox = rawTools.sandbox as Record<string, unknown>;
            if (sandboxUpdate.enforcementMode === 'strict' || sandboxUpdate.enforcementMode === 'permissive') {
              rawSandbox.enforcementMode = sandboxUpdate.enforcementMode;
            }
          }

          // Agent policy updates (which policy areas the assistant can modify via chat)
          const agentPolicyUpdatesUpdate = updates.assistant?.tools?.agentPolicyUpdates;
          if (agentPolicyUpdatesUpdate && typeof agentPolicyUpdatesUpdate === 'object') {
            rawConfig.assistant = rawConfig.assistant ?? {};
            const rawAssistant = rawConfig.assistant as Record<string, unknown>;
            rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
            const rawTools = rawAssistant.tools as Record<string, unknown>;
            rawTools.agentPolicyUpdates = (rawTools.agentPolicyUpdates as Record<string, unknown> | undefined) ?? {};
            const rawAPU = rawTools.agentPolicyUpdates as Record<string, unknown>;
            if (typeof agentPolicyUpdatesUpdate.allowedPaths === 'boolean') rawAPU.allowedPaths = agentPolicyUpdatesUpdate.allowedPaths;
            if (typeof agentPolicyUpdatesUpdate.allowedCommands === 'boolean') rawAPU.allowedCommands = agentPolicyUpdatesUpdate.allowedCommands;
            if (typeof agentPolicyUpdatesUpdate.allowedDomains === 'boolean') rawAPU.allowedDomains = agentPolicyUpdatesUpdate.allowedDomains;
          }

          // MCP + GWS managed provider updates
          const mcpUpdate = updates.assistant?.tools?.mcp;
          if (mcpUpdate && typeof mcpUpdate === 'object') {
            rawConfig.assistant = rawConfig.assistant ?? {};
            const rawAssistant = rawConfig.assistant as Record<string, unknown>;
            rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
            const rawTools = rawAssistant.tools as Record<string, unknown>;
            rawTools.mcp = (rawTools.mcp as Record<string, unknown> | undefined) ?? {};
            const rawMcp = rawTools.mcp as Record<string, unknown>;
            if (typeof mcpUpdate.enabled === 'boolean') rawMcp.enabled = mcpUpdate.enabled;

            const gwsUpdate = mcpUpdate.managedProviders?.gws;
            if (gwsUpdate && typeof gwsUpdate === 'object') {
              rawMcp.managedProviders = (rawMcp.managedProviders as Record<string, unknown> | undefined) ?? {};
              const rawManaged = rawMcp.managedProviders as Record<string, unknown>;
              rawManaged.gws = (rawManaged.gws as Record<string, unknown> | undefined) ?? {};
              const rawGws = rawManaged.gws as Record<string, unknown>;
              if (typeof gwsUpdate.enabled === 'boolean') rawGws.enabled = gwsUpdate.enabled;
              if (Array.isArray(gwsUpdate.services)) rawGws.services = gwsUpdate.services;
              if (typeof gwsUpdate.command === 'string') rawGws.command = gwsUpdate.command;
            }
          }

          const result = persistAndApplyConfig(rawConfig, {
            changedBy: 'config-center',
            reason: 'direct config update',
          });
          analytics.track({
            type: result.success ? 'config_update_success' : 'config_update_failed',
            channel: 'system',
            canonicalUserId: currentConfig.assistant.identity.primaryUserId,
            metadata: { result: result.message },
          });
          if (result.success && credentialRefsChanged) {
            deleteUnusedLocalSecrets(currentConfig.assistant.credentials.refs, nextCredentialRefs);
          }
          return result;
        },
      );
    },

    onAnalyticsTrack: (event) => {
      const channel = event.channel ?? 'system';
      const channelUserId = event.channelUserId
        ?? event.canonicalUserId
        ?? `${channel}-user`;
      const canonicalUserId = channel === 'system'
        ? (event.canonicalUserId ?? configRef.current.assistant.identity.primaryUserId)
        : identity.resolveCanonicalUserId(channel, channelUserId);

      analytics.track({
        ...event,
        channel,
        channelUserId,
        canonicalUserId,
      });
    },

    onAnalyticsSummary: (windowMs) => analytics.summary(windowMs),

    onThreatIntelSummary: () => threatIntel.getSummary(),

    onThreatIntelPlan: () => threatIntel.getPlan(),

    onThreatIntelWatchlist: () => threatIntel.listWatchlist(),

    onThreatIntelWatchAdd: (target) => {
      const result = threatIntel.addWatchTarget(target);
      if (!result.success) return result;

      const persisted = persistThreatIntelState();
      if (!persisted.success) {
        threatIntel.removeWatchTarget(target);
        return {
          success: false,
          message: `${result.message} Rollback applied. ${persisted.message}`,
        };
      }

      analytics.track({
        type: 'threat_intel_watch_add',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: { target },
      });
      return result;
    },

    onThreatIntelWatchRemove: (target) => {
      const result = threatIntel.removeWatchTarget(target);
      if (!result.success) return result;

      const persisted = persistThreatIntelState();
      if (!persisted.success) {
        threatIntel.addWatchTarget(target);
        return {
          success: false,
          message: `${result.message} Rollback applied. ${persisted.message}`,
        };
      }

      analytics.track({
        type: 'threat_intel_watch_remove',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: { target },
      });
      return result;
    },

    onThreatIntelScan: async (input) => {
      return jobTracker.run(
        {
          type: 'threat_intel.scan',
          source: 'manual',
          detail: input.query
            ? `Manual scan for '${input.query}'`
            : 'Manual scan for configured watchlist',
          metadata: {
            includeDarkWeb: !!input.includeDarkWeb,
            sources: input.sources,
          },
        },
        async () => {
          const result = await threatIntel.scan(input);
          analytics.track({
            type: result.success ? 'threat_intel_scan' : 'threat_intel_scan_failed',
            channel: 'system',
            canonicalUserId: configRef.current.assistant.identity.primaryUserId,
            metadata: {
              query: input.query,
              includeDarkWeb: input.includeDarkWeb,
              findings: result.findings.length,
              success: result.success,
            },
          });

          const highRisk = result.findings.filter((f) => f.severity === 'high' || f.severity === 'critical');
          if (highRisk.length > 0) {
            runtime.auditLog.record({
              type: 'anomaly_detected',
              severity: 'warn',
              agentId: 'threat-intel',
              details: {
                source: 'threat_intel_scan',
                anomalyType: 'high_risk_signal',
                description: `${highRisk.length} high-risk finding(s) detected in threat-intel scan.`,
                evidence: {
                  findingIds: highRisk.map((finding) => finding.id),
                  targets: highRisk.map((finding) => finding.target),
                },
              },
            });
          }
          return result;
        },
      );
    },

    onThreatIntelFindings: ({ limit, status }) => {
      const safeLimit = limit && limit > 0 ? limit : 50;
      return threatIntel.listFindings(safeLimit, status);
    },

    onThreatIntelUpdateFindingStatus: ({ findingId, status }) => {
      const result = threatIntel.updateFindingStatus(findingId, status);
      analytics.track({
        type: result.success ? 'threat_intel_finding_status_updated' : 'threat_intel_finding_status_failed',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: { findingId, status, success: result.success },
      });
      return result;
    },

    onThreatIntelActions: (limit) => threatIntel.listActions(limit ?? 50),

    onThreatIntelDraftAction: ({ findingId, type }) => {
      const result = threatIntel.draftAction(findingId, type);
      analytics.track({
        type: result.success ? 'threat_intel_action_drafted' : 'threat_intel_action_draft_failed',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: { findingId, type, success: result.success },
      });
      return result;
    },

    onThreatIntelSetResponseMode: (mode) => {
      const previousMode = threatIntel.getSummary().responseMode;
      const result = threatIntel.setResponseMode(mode);
      if (!result.success) return result;

      const persisted = persistThreatIntelState();
      if (!persisted.success) {
        threatIntel.setResponseMode(previousMode);
        return {
          success: false,
          message: `Failed to persist mode change. ${persisted.message}`,
        };
      }

      analytics.track({
        type: 'threat_intel_response_mode_updated',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata: { mode },
      });
      return result;
    },

    // ── Google Workspace ────────────────────────────────────────
    onGwsStatus: async () => {
      const status = await probeGwsCli(configRef.current);
      const gwsConfig = configRef.current.assistant.tools.mcp?.managedProviders?.gws;
      const services = gwsConfig?.services ?? ['gmail', 'calendar', 'drive'];
      return {
        installed: status.installed,
        version: status.version,
        authenticated: status.authenticated,
        authMethod: status.authMethod,
        services: gwsConfig?.enabled ? services : [],
        enabled: gwsConfig?.enabled ?? false,
      };
    },
    onGoogleStatus: async () => {
      const auth = googleAuthRef.current;
      const svc = googleServiceRef.current;
      if (!auth) return { authenticated: false, services: [], mode: 'native' as const };
      return {
        authenticated: auth.isAuthenticated(),
        tokenExpiry: auth.getTokenExpiry(),
        services: svc?.getEnabledServices() ?? [],
        mode: 'native' as const,
      };
    },
    onGoogleAuthStart: async (services: string[]) => {
      const auth = googleAuthRef.current;
      if (!auth) return { success: false, message: 'Google auth not initialized. Restart the application.' };
      try {
        // Auto-enable native Google in config when user clicks Connect.
        const rawConfig = loadRawConfig();
        const rawAssistant = (rawConfig.assistant as Record<string, unknown>) ?? {};
        const rawTools = (rawAssistant.tools as Record<string, unknown>) ?? {};
        rawTools.google = {
          ...(rawTools.google as Record<string, unknown> ?? {}),
          enabled: true,
          mode: 'native',
          services: services.length ? services : ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'contacts'],
        };
        rawAssistant.tools = rawTools;
        rawConfig.assistant = rawAssistant;
        persistAndApplyConfig(rawConfig, { reason: 'Enable native Google integration' });

        enabledManagedProviders.add('gws');
        const { authUrl, state } = await auth.startAuth();
        return { success: true, authUrl, state };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
    onGoogleCredentials: async (credentials: string) => {
      const googleCfg = configRef.current.assistant.tools.google;
      const credPath = googleCfg?.credentialsPath?.replace(/^~/, homedir()) || `${homedir()}/.guardianagent/google-credentials.json`;
      try {
        const { mkdir: mkdirAsync, writeFile: writeFileAsync } = await import('node:fs/promises');
        const { dirname } = await import('node:path');
        await mkdirAsync(dirname(credPath), { recursive: true });
        await writeFileAsync(credPath, credentials, { mode: 0o600 });
        return { success: true, message: 'Credentials saved.' };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
    onGoogleDisconnect: async () => {
      const auth = googleAuthRef.current;
      if (!auth) return { success: false, message: 'Native Google integration is not enabled.' };
      try {
        await auth.disconnect();
        return { success: true, message: 'Disconnected.' };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
    onGuardianAgentStatus: () => {
      const cfg = guardianAgentService.getConfig();
      return {
        enabled: cfg.enabled,
        llmProvider: cfg.llmProvider,
        failOpen: cfg.failOpen,
        timeoutMs: cfg.timeoutMs,
        actionTypes: cfg.actionTypes,
      };
    },
    onGuardianAgentUpdate: (input) => {
      guardianAgentService.updateConfig(input);
      return { success: true, message: 'Guardian Agent configuration updated.' };
    },
    onPolicyStatus: policyState.getStatus,
    onPolicyUpdate: policyState.update,
    onPolicyReload: policyState.reload,
    onSentinelAuditRun: async (windowMs) => {
      const result = await sentinelAuditService.runAudit(runtime.auditLog, windowMs);
      return {
        success: true,
        anomalies: result.anomalies.map((a: { type: string; severity: string; description: string; agentId?: string }) => ({
          type: a.type,
          severity: a.severity,
          description: a.description,
          agentId: a.agentId,
        })),
        llmFindings: result.llmFindings,
        timestamp: result.timestamp,
        windowMs: result.windowMs,
      };
    },

    set onTelegramReload(fn: (() => Promise<{ success: boolean; message: string }>) | undefined) {
      telegramReloadRef.current = fn ?? null;
    },

    telegramReloadRef,
    reloadSearchRef,
  };
}


function resolveAssistantDbPath(configuredPath: string | undefined, fallbackFileName: string): string {
  const fallback = join(homedir(), '.guardianagent', fallbackFileName);
  if (!configuredPath || !configuredPath.trim()) return fallback;

  const trimmed = configuredPath.trim();
  if (trimmed.startsWith('~/')) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? DEFAULT_CONFIG_PATH;

  // First-run: auto-create default config if none exists.
  if (!existsSync(configPath)) {
    const configDir = dirname(configPath);
    mkdirSync(configDir, { recursive: true });
    const defaultYaml = [
      '# GuardianAgent Configuration',
      '# Docs: https://github.com/alexkenley/guardian-agent',
      '',
      'llm:',
      '  ollama:',
      '    provider: ollama',
      '    baseUrl: http://127.0.0.1:11434',
      '    model: llama3.2',
      '',
      '  # Uncomment to use Anthropic:',
      '  # claude:',
      '  #   provider: anthropic',
      '  #   apiKey: ${ANTHROPIC_API_KEY}',
      '  #   model: claude-sonnet-4-20250514',
      '',
      '  # Uncomment to use OpenAI:',
      '  # gpt:',
      '  #   provider: openai',
      '  #   apiKey: ${OPENAI_API_KEY}',
      '  #   model: gpt-4o',
      '',
      'defaultProvider: ollama',
      '',
      '# Fallback providers tried when the default fails (rate limit, timeout, etc.)',
      '# fallbacks:',
      '#   - claude',
      '',
      'channels:',
      '  cli:',
      '    enabled: true',
      '  telegram:',
      '    enabled: false',
      '  web:',
      '    enabled: true',
      '    port: 3000',
      '',
      'guardian:',
      '  enabled: true',
      '  logDenials: true',
      '',
      'runtime:',
      '  maxStallDurationMs: 60000',
      '  watchdogIntervalMs: 10000',
      '  logLevel: warn',
      '',
      'assistant:',
      '  soul:',
      '    enabled: true',
      '    path: SOUL.md',
      '    primaryMode: full',
      '    delegatedMode: summary',
      '    maxChars: 8000',
      '    summaryMaxChars: 1000',
      '  connectors:',
      '    enabled: false',
      '    executionMode: plan_then_execute',
      '    maxConnectorCallsPerRun: 12',
    ].join('\n') + '\n';
    writeFileSync(configPath, defaultYaml, 'utf-8');
    const isTTY = process.stdout.isTTY;
    const dim = (t: string) => isTTY ? `\x1b[2m${t}\x1b[0m` : t;
    const green = (t: string) => isTTY ? `\x1b[32m${t}\x1b[0m` : t;
    console.log(green(`  Created default config at ${configPath}`));
    console.log(dim('  Edit this file to configure LLM providers, channels, and security settings.'));
    console.log(dim('  Quick start: ensure Ollama is running, or set ANTHROPIC_API_KEY / OPENAI_API_KEY.'));
    console.log('');
  }

  const configRef = { current: loadConfig(configPath) };
  const threatIntelWebSearchConfigRef: { current: WebSearchConfig | undefined } = { current: undefined };
  const secretStore = new LocalSecretStore({ baseDir: dirname(configPath) });

  // Auto-detect Ollama model if configured model is not available.
  // Prevents startup failures when the default model (e.g. llama3.2) isn't pulled.
  for (const [name, llmCfg] of Object.entries(configRef.current.llm)) {
    if (llmCfg.provider === 'ollama') {
      const baseUrl = llmCfg.baseUrl || 'http://127.0.0.1:11434';
      try {
        const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const data = (await res.json()) as { models?: Array<{ name: string }> };
          const available = data.models?.map((m) => m.name) ?? [];
          if (available.length > 0) {
            const configuredModel = llmCfg.model;
            const modelFound = available.some((m) =>
              m === configuredModel || m.startsWith(`${configuredModel}:`)
            );
            if (!modelFound) {
              const selected = available[0];
              console.log(`  Ollama provider '${name}': model '${configuredModel}' not found. Auto-selecting '${selected}'.`);
              (configRef.current.llm[name] as unknown as Record<string, unknown>).model = selected;
            }
          }
        }
      } catch {
        // Ollama not reachable — skip auto-detection
      }
    }
  }

  const config = configRef.current;

  // Respect config runtime log level unless caller explicitly overrides via LOG_LEVEL.
  // When running in an interactive TTY (CLI), keep logs silent so JSON output
  // doesn't pollute the readline prompt.  Use LOG_FILE for persistent logging.
  if (!process.env['LOG_LEVEL']) {
    if (process.stdout.isTTY && !process.env['LOG_FILE']) {
      setLogLevel('silent');
    } else {
      setLogLevel(config.runtime.logLevel);
    }
  }

  const resolvedRuntimeCredentials = resolveRuntimeCredentialView(config, secretStore);

  // Startup repair: log which LLM providers started disconnected due to unresolvable credentials.
  for (const [name, llmCfg] of Object.entries(resolvedRuntimeCredentials.resolvedLLM)) {
    if (llmCfg.provider !== 'ollama' && !llmCfg.apiKey) {
      console.log(`  ⚠ LLM provider '${name}' started disconnected — credential could not be resolved`);
    }
  }

  threatIntelWebSearchConfigRef.current = resolvedRuntimeCredentials.resolvedWebSearch ?? {};
  const runtime = new Runtime({
    ...config,
    llm: resolvedRuntimeCredentials.resolvedLLM,
    assistant: {
      ...config.assistant,
      tools: {
        ...config.assistant.tools,
        cloud: resolvedRuntimeCredentials.resolvedCloud,
        webSearch: resolvedRuntimeCredentials.resolvedWebSearch,
      },
    },
  });
  const identity = new IdentityService(config.assistant.identity);
  let analytics: AnalyticsService | null = null;
  const onSQLiteSecurityEvent = (event: {
    service: 'conversation' | 'analytics';
    severity: 'info' | 'warn';
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }) => {
    if (event.code === 'integrity_ok' || event.code === 'integrity_checkpoint_written') {
      return;
    }

    if (event.severity === 'warn') {
      log.warn({ ...event }, 'SQLite security event');
    } else {
      log.info({ ...event }, 'SQLite security event');
    }

    if (event.severity === 'warn') {
      runtime.auditLog.record({
        type: 'anomaly_detected',
        severity: event.severity,
        agentId: 'storage',
        details: {
          source: 'sqlite_monitor',
          anomalyType: event.code,
          description: event.message,
          evidence: event.details ?? {},
        },
      });
    }

    analytics?.track({
      type: `sqlite_${event.code}`,
      channel: 'system',
      canonicalUserId: configRef.current.assistant.identity.primaryUserId,
      metadata: {
        service: event.service,
        severity: event.severity,
        message: event.message,
        details: event.details,
      },
    });
  };
  // Agent knowledge base — per-agent persistent memory files
  const kbConfig = config.assistant.memory.knowledgeBase;
  const agentMemoryStore = new AgentMemoryStore({
    enabled: kbConfig?.enabled ?? true,
    basePath: kbConfig?.basePath,
    maxContextChars: kbConfig?.maxContextChars ?? 4000,
    maxFileChars: kbConfig?.maxFileChars ?? 20000,
  });

  const conversationDbPath = resolveAssistantDbPath(config.assistant.memory.sqlitePath, 'assistant-memory.sqlite');
  const analyticsDbPath = resolveAssistantDbPath(config.assistant.analytics.sqlitePath, 'assistant-analytics.sqlite');
  const conversations = new ConversationService({
    enabled: config.assistant.memory.enabled,
    sqlitePath: conversationDbPath,
    maxTurns: config.assistant.memory.maxTurns,
    maxMessageChars: config.assistant.memory.maxMessageChars,
    maxContextChars: config.assistant.memory.maxContextChars,
    retentionDays: config.assistant.memory.retentionDays,
    onSecurityEvent: onSQLiteSecurityEvent,
    onMemoryFlush: (kbConfig?.autoFlush ?? true) ? (key, droppedMessages) => {
      // Extract key facts from dropped messages and persist to knowledge base.
      // This is a lightweight extraction — no LLM call, just preserves the raw
      // content of dropped messages as a dated summary block.
      if (!agentMemoryStore || droppedMessages.length === 0) return;

      const timestamp = new Date().toISOString().slice(0, 10);
      const summaryLines = droppedMessages
        .filter((m) => m.content.length > 20) // skip trivial messages
        .map((m) => {
          const preview = m.content.length > 200
            ? m.content.slice(0, 200) + '...'
            : m.content;
          return `- [${m.role}] ${preview}`;
        })
        .slice(0, 10); // cap at 10 entries per flush

      if (summaryLines.length === 0) return;

      const block = `## Context from ${timestamp}\n${summaryLines.join('\n')}`;
      agentMemoryStore.appendRaw(key.agentId, block);
      log.debug(
        { agentId: key.agentId, droppedCount: droppedMessages.length, flushedLines: summaryLines.length },
        'Memory flush: persisted dropped context to knowledge base',
      );
    } : undefined,
  });
  analytics = new AnalyticsService({
    enabled: config.assistant.analytics.enabled,
    sqlitePath: analyticsDbPath,
    retentionDays: config.assistant.analytics.retentionDays,
    onSecurityEvent: onSQLiteSecurityEvent,
  });
  if (!analytics) {
    throw new Error('Failed to initialize analytics service');
  }

  const onMoltbookSecurityEvent = (event: {
    severity: 'info' | 'warn';
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }) => {
    if (event.severity === 'warn') {
      log.warn({ ...event }, 'Moltbook hostile-site guard event');
    } else {
      log.info({ ...event }, 'Moltbook hostile-site guard event');
    }

    runtime.auditLog.record({
      type: 'anomaly_detected',
      severity: event.severity,
      agentId: 'threat-intel',
      details: {
        source: 'moltbook_connector',
        anomalyType: event.code,
        description: event.message,
        evidence: event.details ?? {},
      },
    });

    analytics?.track({
      type: `moltbook_${event.code}`,
      channel: 'system',
      canonicalUserId: configRef.current.assistant.identity.primaryUserId,
      metadata: {
        severity: event.severity,
        message: event.message,
        details: event.details,
      },
    });
  };

  const moltbookConnector = new MoltbookConnector({
    ...config.assistant.threatIntel.moltbook,
    admitRequest: (url) => {
      const decision = runtime.guardian.check({
        type: 'http_request',
        agentId: 'threat-intel:moltbook',
        capabilities: ['network_access'],
        params: { url },
      });
      return { allowed: decision.allowed, reason: decision.reason };
    },
    onSecurityEvent: onMoltbookSecurityEvent,
  });

  const threatIntelSourceScanners = createThreatIntelSourceScanners({
    getWebSearchConfig: () => threatIntelWebSearchConfigRef.current,
    admitRequest: (url) => {
      const decision = runtime.guardian.check({
        type: 'http_request',
        agentId: 'threat-intel:osint',
        capabilities: ['network_access'],
        params: { url },
      });
      return { allowed: decision.allowed, reason: decision.reason };
    },
  });

  const threatIntel = new ThreatIntelService({
    enabled: config.assistant.threatIntel.enabled,
    allowDarkWeb: config.assistant.threatIntel.allowDarkWeb,
    responseMode: config.assistant.threatIntel.responseMode,
    watchlist: config.assistant.threatIntel.watchlist,
    forumConnectors: [moltbookConnector],
    sourceScanners: threatIntelSourceScanners,
  });
  // ─── OS-Level Process Sandbox ───────────────────────────────
  const sandboxConfig: SandboxConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    ...(config.assistant.tools.sandbox ?? {}),
    resourceLimits: {
      ...DEFAULT_SANDBOX_CONFIG.resourceLimits,
      ...(config.assistant.tools.sandbox?.resourceLimits ?? {}),
    },
  };
  const sandboxCaps = await detectSandboxCapabilities(sandboxConfig);
  const sandboxHealth = await detectSandboxHealth(sandboxConfig, sandboxCaps);
  const sandboxUpgradeGuidance = [
    'Safer options: run on Linux/Unix with bubblewrap available, or use the Windows portable app with guardian-sandbox-win.exe AppContainer helper.',
    'Set assistant.tools.sandbox.enforcementMode: permissive only if you explicitly accept higher host risk.',
  ].join(' ');
  if (sandboxConfig.enabled) {
    log.info(
      {
        bwrap: sandboxCaps.bwrapAvailable,
        bwrapVersion: sandboxCaps.bwrapVersion,
        profile: sandboxConfig.mode,
        availability: sandboxHealth.availability,
        enforcementMode: sandboxHealth.enforcementMode,
      },
      'OS-level process sandbox active',
    );
    if (sandboxHealth.enforcementMode !== 'strict') {
      log.warn(
        {
          platform: sandboxHealth.platform,
          availability: sandboxHealth.availability,
          backend: sandboxHealth.backend,
        },
        `Permissive sandbox mode is explicitly enabled. ${sandboxUpgradeGuidance}`,
      );
    } else if (sandboxHealth.availability !== 'strong') {
      log.warn(
        {
          platform: sandboxHealth.platform,
          availability: sandboxHealth.availability,
          backend: sandboxHealth.backend,
        },
        `Strict sandbox mode is blocking risky subprocess-backed tools until a strong sandbox backend is available. ${sandboxUpgradeGuidance}`,
      );
    }
  } else {
    log.warn('OS-level process sandbox is disabled — child processes run unsandboxed');
  }

  // ─── MCP Client Manager ─────────────────────────────────────
  let mcpManager: MCPClientManager | undefined;
  const enabledManagedProviders = new Set<string>();
  const mcpConfig = config.assistant.tools.mcp;
  const managedMCPServers = buildManagedMCPServers(config);
  const configuredMCPServers = mcpConfig?.servers ?? [];
  const allMCPServers: Array<MCPServerEntry & { managedProviderId?: string }> = [
    ...configuredMCPServers.map((server) => ({ ...server })),
    ...managedMCPServers,
  ];
  const mcpBlockedBySandbox = sandboxHealth.enforcementMode === 'strict' && sandboxHealth.availability !== 'strong';
  if (mcpConfig?.enabled && allMCPServers.length > 0) {
    if (mcpBlockedBySandbox) {
      console.warn('  MCP servers blocked: strict sandbox mode requires strong sandbox availability');
      log.warn(
        { platform: sandboxHealth.platform, availability: sandboxHealth.availability },
        'Strict sandbox mode is blocking MCP server startup',
      );
    } else {
      mcpManager = new MCPClientManager(sandboxConfig);
      for (const server of allMCPServers) {
        const serverConfig: MCPServerConfig = {
          id: server.id,
          name: server.name,
          transport: 'stdio',
          command: server.command,
          args: server.args,
          env: server.env,
          cwd: server.cwd,
          timeoutMs: server.timeoutMs,
          trustLevel: server.trustLevel,
          maxCallsPerMinute: server.maxCallsPerMinute,
        };
        try {
          await mcpManager.addServer(serverConfig);
          const managedProvider = server.managedProviderId;
          if (managedProvider) {
            const exposeSkills = managedProvider === 'gws'
              ? config.assistant.tools.mcp?.managedProviders?.gws?.exposeSkills !== false
              : true;
            if (exposeSkills) enabledManagedProviders.add(managedProvider);
          }
          const client = mcpManager.getClient(server.id);
          const mcpToolCount = client?.getTools().length ?? 0;
          console.log(`  MCP server '${server.name}' connected (${mcpToolCount} tools)`);
          log.info(
            { serverId: server.id, serverName: server.name, toolCount: mcpToolCount },
            'MCP server connected',
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.error(`  MCP server '${server.name}' failed to connect: ${detail}`);
          log.error(
            { serverId: server.id, err: detail },
            'Failed to connect MCP server (continuing without it)',
          );
        }
      }
      const toolCount = mcpManager.getAllToolDefinitions().length;
      if (toolCount > 0) {
        console.log(`  MCP: ${toolCount} tools available across all servers`);
        log.info({ toolCount }, 'MCP tools discovered and available');
      }
    }
  }

  // ── Browser MCP Providers ──────────────────────────────────
  // Browser tools are MCP-based but should work out of the box without requiring
  // explicit mcp.enabled in config. Create mcpManager if it doesn't exist yet.
  const browserConfig = config.assistant?.tools?.browser;
  if (browserConfig?.enabled !== false && !mcpBlockedBySandbox) {
    if (!mcpManager) {
      mcpManager = new MCPClientManager(sandboxConfig);
    }
    // Playwright MCP
    if (browserConfig?.playwrightEnabled !== false) {
      const playwrightArgs: string[] = [
        '@playwright/mcp@latest',
        '--headless',
        '--browser', browserConfig?.playwrightBrowser ?? 'chromium',
        '--caps', browserConfig?.playwrightCaps ?? 'network,storage',
        '--snapshot-mode', 'incremental',
        ...(browserConfig?.playwrightArgs ?? []),
      ];
      try {
        await mcpManager.addServer({
          id: 'playwright',
          name: 'Playwright Browser',
          transport: 'stdio' as const,
          command: 'npx',
          args: playwrightArgs,
          timeoutMs: 60_000,
          maxCallsPerMinute: 60,
        });
        const pwTools = mcpManager.getClient('playwright')?.getTools().length ?? 0;
        log.info({ tools: pwTools }, 'Playwright MCP browser connected');
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Playwright MCP failed to start — browser automation unavailable');
      }
    }

    // Lightpanda MCP (Phase 2 — opt-in)
    if (browserConfig?.lightpandaEnabled) {
      try {
        await mcpManager.addServer({
          id: 'lightpanda',
          name: 'Lightpanda Browser',
          transport: 'stdio' as const,
          command: browserConfig?.lightpandaBinaryPath ?? 'lightpanda',
          args: ['mcp'],
          timeoutMs: 30_000,
          maxCallsPerMinute: 120,
        });
        const lpTools = mcpManager.getClient('lightpanda')?.getTools().length ?? 0;
        log.info({ tools: lpTools }, 'Lightpanda MCP browser connected');
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Lightpanda MCP failed to start — lightweight browser reads unavailable');
      }
    }
  }

  // ─── Native Skills ───────────────────────────────────────────
  let skillRegistry: SkillRegistry | undefined;
  let skillResolver: SkillResolver | undefined;
  if (config.assistant.skills.enabled) {
    skillRegistry = new SkillRegistry();
    await skillRegistry.loadFromRoots(
      config.assistant.skills.roots,
      config.assistant.skills.disabledSkills,
    );
    skillResolver = new SkillResolver(skillRegistry, {
      autoSelect: config.assistant.skills.autoSelect,
      maxActivePerRequest: config.assistant.skills.maxActivePerRequest,
    });
    log.info({ count: skillRegistry.list().length }, 'Native skills loaded');
  }

  // ─── Document Search Service ─────────────────────────
  let docSearch: import('./search/search-service.js').SearchService | undefined;
  const initialSearchReloadRef = {
    current: async () => {
      try {
        const searchConfig = configRef.current.assistant?.tools?.search;
        if (docSearch) {
          docSearch.close();
          docSearch = undefined;
          toolExecutor.setDocSearch(undefined);
        }
        if (searchConfig?.enabled) {
          const { SearchService } = await import('./search/search-service.js');
          docSearch = new SearchService(searchConfig);
          if (docSearch.isAvailable()) {
            log.info('Native document search engine (re)initialized');
            toolExecutor.setDocSearch(docSearch);
            // Auto-index all enabled sources on startup/reload
            const indexResult = await docSearch.indexAll();
            if (indexResult.synced.length > 0) {
              log.info({ synced: indexResult.synced }, 'Document search sources indexed');
            }
            if (indexResult.errors.length > 0) {
              log.warn({ errors: indexResult.errors }, 'Some search sources failed to index');
            }
          } else {
            log.warn('Document search enabled but SQLite driver not available');
          }
        }
        return { success: true, message: 'Search engine reloaded.' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        docSearch = undefined;
        toolExecutor.setDocSearch(undefined);
        log.error({ err }, 'Search engine reload failed');
        return { success: false, message: `Search engine reload failed: ${message}` };
      }
    },
  };

  // ─── Native Google Workspace Service ──────────────────
  // Always initialize GoogleAuth/GoogleService so the web UI can trigger
  // the OAuth flow even when native mode isn't explicitly enabled yet.
  const googleAuthRef: { current: import('./google/google-auth.js').GoogleAuth | null } = { current: null };
  const googleServiceRef: { current: import('./google/google-service.js').GoogleService | null } = { current: null };
  let googleService: import('./google/google-service.js').GoogleService | undefined;
  let googleAuth: import('./google/google-auth.js').GoogleAuth | undefined;
  const googleConfig = config.assistant.tools.google;
  {
    try {
      const { GoogleAuth, GoogleService, GOOGLE_SERVICE_SCOPES } = await import('./google/index.js');
      const services = googleConfig?.services?.length ? googleConfig.services : ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'contacts'];
      const scopes = services
        .map((s: string) => GOOGLE_SERVICE_SCOPES[s.toLowerCase()])
        .filter(Boolean);
      const credPath = (googleConfig?.credentialsPath ?? '').replace(/^~/, homedir()) || `${homedir()}/.guardianagent/google-credentials.json`;

      googleAuth = new GoogleAuth({
        credentialsPath: credPath,
        callbackPort: googleConfig?.oauthCallbackPort ?? 18432,
        scopes,
      });

      await googleAuth.loadStoredTokens();
      googleService = new GoogleService(googleAuth, {
        services,
        timeoutMs: googleConfig?.timeoutMs,
      });

      // Populate refs for dashboard callback closures.
      googleAuthRef.current = googleAuth;
      googleServiceRef.current = googleService;

      // Enable tool routing to native backend if configured.
      if (googleConfig?.enabled || googleAuth.isAuthenticated()) {
        enabledManagedProviders.add('gws');
        if (googleAuth.isAuthenticated()) {
          console.log(`  Google Workspace: connected (services: ${services.join(', ')})`);
        } else {
          console.log('  Google Workspace: ready — connect via web UI.');
        }
      }
    } catch (err) {
      console.log(`  Google Workspace (native): failed to initialize — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Device inventory — tracks discovered network devices from playbook runs
  const deviceInventory = new DeviceInventoryService();
  await deviceInventory.load().catch(() => {});
  deviceInventory.onEvent((event) => {
    runtime.auditLog.record({
      type: 'action_allowed',
      severity: event.type === 'network_new_device' ? 'info' : 'warn',
      agentId: 'system',
      details: {
        event: event.type,
        ip: event.device.ip,
        mac: event.device.mac,
        reason: event.type === 'network_new_device'
          ? `New device discovered: ${event.device.ip} (${event.device.mac})`
          : `Device went offline: ${event.device.ip} (${event.device.mac})`,
      },
    });
  });

  // Network baseline + anomaly detection
  const networkBaseline = new NetworkBaselineService({
    minSnapshotsForBaseline: config.assistant.network.baseline.minSnapshotsForBaseline,
    dedupeWindowMs: config.assistant.network.baseline.dedupeWindowMs,
    rules: {
      new_device: {
        enabled: config.assistant.network.baseline.anomalyRules.newDevice.enabled,
        severity: config.assistant.network.baseline.anomalyRules.newDevice.severity,
      },
      port_change: {
        enabled: config.assistant.network.baseline.anomalyRules.portChange.enabled,
        severity: config.assistant.network.baseline.anomalyRules.portChange.severity,
      },
      arp_conflict: {
        enabled: config.assistant.network.baseline.anomalyRules.arpSpoofing.enabled,
        severity: config.assistant.network.baseline.anomalyRules.arpSpoofing.severity,
      },
      unusual_service: {
        enabled: config.assistant.network.baseline.anomalyRules.unusualService.enabled,
        severity: config.assistant.network.baseline.anomalyRules.unusualService.severity,
      },
      device_gone: {
        enabled: config.assistant.network.baseline.anomalyRules.deviceGone.enabled,
        severity: config.assistant.network.baseline.anomalyRules.deviceGone.severity,
      },
      mass_port_open: {
        enabled: config.assistant.network.baseline.anomalyRules.massPortOpen.enabled,
        severity: config.assistant.network.baseline.anomalyRules.massPortOpen.severity,
      },
    },
  });
  await networkBaseline.load().catch(() => {});

  const networkTraffic = new NetworkTrafficService({
    flowRetentionMs: config.assistant.network.trafficAnalysis.flowRetention,
    rules: {
      dataExfiltration: config.assistant.network.trafficAnalysis.threatRules.dataExfiltration,
      portScanning: config.assistant.network.trafficAnalysis.threatRules.portScanning,
      beaconing: config.assistant.network.trafficAnalysis.threatRules.beaconing,
    },
  });
  await networkTraffic.load().catch(() => {});

  const hostMonitor = new HostMonitoringService({
    config: config.assistant.hostMonitoring,
  });
  await hostMonitor.load().catch(() => {});

  const gatewayMonitor = new GatewayFirewallMonitoringService({
    config: config.assistant.gatewayMonitoring,
  });
  await gatewayMonitor.load().catch(() => {});

  let lastNetworkAlertEmitAt = 0;
  let hostMonitorInterval: ReturnType<typeof setInterval> | null = null;
  let gatewayMonitorInterval: ReturnType<typeof setInterval> | null = null;
  let lastHostMonitorTriggeredAt = 0;
  let lastGatewayMonitorTriggeredAt = 0;

  const runNetworkAnalysis = (source: string): NetworkAnomalyReport => {
    const devices = deviceInventory.listDevices();
    const report = networkBaseline.runSnapshot(devices);
    const now = Date.now();

    runtime.eventBus.emit({
      type: 'network:scan:complete',
      sourceAgentId: 'network-sentinel',
      targetAgentId: '*',
      payload: {
        source,
        deviceCount: devices.length,
        snapshotCount: report.snapshotCount,
        baselineReady: report.baselineReady,
        anomalyCount: report.anomalies.length,
        riskScore: report.riskScore,
      },
      timestamp: now,
    }).catch(() => {});

    const emittedDedupeKeys = new Set<string>();
    for (const anomaly of report.anomalies) {
      emittedDedupeKeys.add(anomaly.dedupeKey);
      const auditSeverity = anomaly.severity === 'critical'
        ? 'critical'
        : anomaly.severity === 'high' || anomaly.severity === 'medium'
          ? 'warn'
          : 'info';

      runtime.auditLog.record({
        type: 'anomaly_detected',
        severity: auditSeverity,
        agentId: 'network-sentinel',
        details: {
          source: 'network_sentinel',
          anomalyType: anomaly.type,
          description: anomaly.description,
          networkSeverity: anomaly.severity,
          dedupeKey: anomaly.dedupeKey,
          riskScore: report.riskScore,
          evidence: anomaly.evidence,
        },
      });

      runtime.eventBus.emit({
        type: 'security:network:anomaly',
        sourceAgentId: 'network-sentinel',
        targetAgentId: '*',
        payload: { ...anomaly, source, riskScore: report.riskScore },
        timestamp: now,
      }).catch(() => {});

      if (anomaly.severity !== 'low') {
        runtime.eventBus.emit({
          type: 'security:network:threat',
          sourceAgentId: 'network-sentinel',
          targetAgentId: '*',
          payload: { ...anomaly, source, riskScore: report.riskScore },
          timestamp: now,
        }).catch(() => {});
      }
    }

    const freshAlerts = networkBaseline
      .listAlerts({ includeAcknowledged: false, limit: 200 })
      .filter((alert) => alert.lastSeenAt > lastNetworkAlertEmitAt && !emittedDedupeKeys.has(alert.dedupeKey));
    for (const alert of freshAlerts) {
      runtime.eventBus.emit({
        type: 'security:network:anomaly',
        sourceAgentId: 'network-sentinel',
        targetAgentId: '*',
        payload: { ...alert, source, riskScore: report.riskScore },
        timestamp: now,
      }).catch(() => {});
      if (alert.severity !== 'low') {
        runtime.eventBus.emit({
          type: 'security:network:threat',
          sourceAgentId: 'network-sentinel',
          targetAgentId: '*',
          payload: { ...alert, source, riskScore: report.riskScore },
          timestamp: now,
        }).catch(() => {});
      }
    }
    if (freshAlerts.length > 0) {
      lastNetworkAlertEmitAt = Math.max(lastNetworkAlertEmitAt, ...freshAlerts.map((alert) => alert.lastSeenAt));
    } else {
      lastNetworkAlertEmitAt = Math.max(lastNetworkAlertEmitAt, now);
    }

    return report;
  };

  const runHostMonitoring = async (source: string) => {
    const report = await hostMonitor.runCheck();
    if (!configRef.current.assistant.hostMonitoring.enabled) {
      return report;
    }
    const now = Date.now();

    runtime.eventBus.emit({
      type: 'host:monitor:check',
      sourceAgentId: 'host-monitor',
      targetAgentId: '*',
      payload: {
        source,
        baselineReady: report.baselineReady,
        snapshot: report.snapshot,
      },
      timestamp: now,
    }).catch(() => {});

    for (const alert of report.alerts) {
      const severity = alert.severity === 'critical'
        ? 'critical'
        : alert.severity === 'high' || alert.severity === 'medium'
          ? 'warn'
          : 'info';
      runtime.auditLog.record({
        type: 'host_alert',
        severity,
        agentId: 'host-monitor',
        details: {
          source: 'host_monitor',
          alertType: alert.type,
          description: alert.description,
          hostSeverity: alert.severity,
          dedupeKey: alert.dedupeKey,
          evidence: alert.evidence,
        },
      });
    }
    return report;
  };

  const runGatewayMonitoring = async (source: string) => {
    const report = await gatewayMonitor.runCheck();
    if (!configRef.current.assistant.gatewayMonitoring.enabled) {
      return report;
    }
    const now = Date.now();

    runtime.eventBus.emit({
      type: 'gateway:monitor:check',
      sourceAgentId: 'gateway-monitor',
      targetAgentId: '*',
      payload: {
        source,
        baselineReady: report.baselineReady,
        gatewayCount: report.gateways.length,
      },
      timestamp: now,
    }).catch(() => {});

    for (const alert of report.alerts) {
      const severity = alert.severity === 'critical'
        ? 'critical'
        : alert.severity === 'high' || alert.severity === 'medium'
          ? 'warn'
          : 'info';
      runtime.auditLog.record({
        type: 'gateway_alert',
        severity,
        agentId: 'gateway-monitor',
        details: {
          source: 'gateway_monitor',
          alertType: alert.type,
          gatewayId: alert.targetId,
          gatewayName: alert.targetName,
          provider: alert.provider,
          description: alert.description,
          gatewaySeverity: alert.severity,
          dedupeKey: alert.dedupeKey,
          evidence: alert.evidence,
        },
      });
    }
    return report;
  };

  // ─── Guardian Agent (inline LLM blocking) + Sentinel (audit) ──────
  const guardianAgentConfig = config.guardian?.guardianAgent;
  const guardianAgentService = new GuardianAgentService({
    enabled: guardianAgentConfig?.enabled !== false,
    llmProvider: guardianAgentConfig?.llmProvider ?? 'auto',
    actionTypes: guardianAgentConfig?.actionTypes,
    failOpen: guardianAgentConfig?.failOpen === true,
    timeoutMs: guardianAgentConfig?.timeoutMs,
  });

  const sentinelAuditConfig = config.guardian?.sentinel;
  const sentinelAuditService = new SentinelAuditService({
    enabled: sentinelAuditConfig?.enabled !== false,
    anomalyThresholds: sentinelAuditConfig?.anomalyThresholds,
  });

  // ─── Message router ────────────────────────────────────────
  const router = new MessageRouter(config.routing);
  const resolveSharedStateAgentId = (agentId?: string): string | undefined => resolveAgentStateId(agentId, {
    localAgentId: router.findAgentByRole('local')?.id,
    externalAgentId: router.findAgentByRole('external')?.id,
  });

  const toolExecutorOptions: ToolExecutorOptions = {
    enabled: config.assistant.tools.enabled,
    workspaceRoot: process.cwd(),
    policyMode: config.assistant.tools.policyMode,
    toolPolicies: config.assistant.tools.toolPolicies,
    allowedPaths: config.assistant.tools.allowedPaths,
    allowedCommands: config.assistant.tools.allowedCommands,
    allowedDomains: config.assistant.tools.allowedDomains,
    allowExternalPosting: config.assistant.tools.allowExternalPosting,
    agentPolicyUpdates: config.assistant.tools.agentPolicyUpdates,
    onToolExecuted: (toolName, args, result, request) => {
      runtime.eventBus.emit({
        type: 'tool.executed',
        sourceAgentId: request.agentId ?? 'system',
        targetAgentId: '*',
        timestamp: Date.now(),
        payload: { toolName, args, result, requestId: request.requestId },
      });

      if (request.requestId) {
        orchestrator.addTraceNode(request.requestId, {
          kind: 'tool_call',
          name: toolName,
          startedAt: Date.now() - result.durationMs,
          completedAt: Date.now(),
          status: result.success ? 'succeeded' : (result.status === 'denied' ? 'blocked' : 'failed'),
          metadata: { args, result },
        });
      }

      const hostRelevant = new Set([
        'shell_safe', 'net_connections', 'sys_processes',
        'mcp-playwright-browser_navigate', 'mcp-playwright-browser_click',
        'mcp-playwright-browser_type', 'mcp-playwright-browser_evaluate',
        'mcp-playwright-browser_run_code', 'mcp-playwright-browser_file_upload',
        'mcp-lightpanda-goto', 'mcp-lightpanda-evaluate',
      ]);
      const now = Date.now();
      if (
        configRef.current.assistant.hostMonitoring.enabled
        && result.success
        && (hostRelevant.has(toolName) || toolName.startsWith('mcp-') || toolName.startsWith('cf_') || toolName.startsWith('aws_') || toolName.startsWith('gcp_') || toolName.startsWith('azure_'))
        && (now - lastHostMonitorTriggeredAt) >= 60_000
      ) {
        lastHostMonitorTriggeredAt = now;
        runHostMonitoring(`tool:${toolName}`).catch((err) => {
          log.warn({ err: err instanceof Error ? err.message : String(err), toolName }, 'Post-tool host monitoring check failed');
        });
      }
      const gatewayRelevant = new Set(['net_connections', 'net_ping', 'net_port_check', 'host_monitor_check', 'gateway_firewall_check']);
      if (
        configRef.current.assistant.gatewayMonitoring.enabled
        && result.success
        && (gatewayRelevant.has(toolName) || toolName.startsWith('net_'))
        && (now - lastGatewayMonitorTriggeredAt) >= 60_000
      ) {
        lastGatewayMonitorTriggeredAt = now;
        runGatewayMonitoring(`tool:${toolName}`).catch((err) => {
          log.warn({ err: err instanceof Error ? err.message : String(err), toolName }, 'Post-tool gateway monitoring check failed');
        });
      }
    },
    onPolicyUpdate: (policy) => {
      // Persist policy changes to config.yaml so they survive reloads and restarts
      try {
        const raw: Record<string, unknown> = existsSync(configPath)
          ? (yaml.load(readFileSync(configPath, 'utf-8')) as Record<string, unknown>) ?? {}
          : {};
        raw.assistant = raw.assistant ?? {};
        const a = raw.assistant as Record<string, unknown>;
        a.tools = (a.tools as Record<string, unknown>) ?? {};
        const t = a.tools as Record<string, unknown>;
        t.allowedPaths = policy.sandbox.allowedPaths;
        t.allowedCommands = policy.sandbox.allowedCommands;
        t.allowedDomains = policy.sandbox.allowedDomains;
        writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }), 'utf-8');
        configRef.current = loadConfig(configPath);
      } catch (err) {
        log.warn({ err }, 'Failed to persist policy update to config file');
      }
    },
    webSearch: resolvedRuntimeCredentials.resolvedWebSearch,
    cloudConfig: resolvedRuntimeCredentials.resolvedCloud,
    browserConfig: config.assistant.tools.browser,
    disabledCategories: config.assistant.tools.disabledCategories,
    conversationService: conversations,
    agentMemoryStore,
    resolveStateAgentId: resolveSharedStateAgentId,
    docSearch,
    googleService,
    deviceInventory,
    networkBaseline,
    networkTraffic,
    hostMonitor,
    runHostMonitorCheck: runHostMonitoring,
    gatewayMonitor,
    runGatewayMonitorCheck: runGatewayMonitoring,
    networkConfig: config.assistant.network,
    mcpManager,
    sandboxConfig,
    sandboxHealth,
    threatIntel,
    onCheckAction: ({ type, params, agentId, origin }) => {
      const capMap: Record<string, string[]> = {
        read_file: ['read_files'],
        write_file: ['write_files'],
        execute_command: ['execute_commands'],
        http_request: ['network_access'],
        network_probe: ['network_access'],
        system_info: ['execute_commands'],
        read_email: ['read_email'],
        draft_email: ['draft_email'],
        send_email: ['send_email'],
        read_calendar: ['read_calendar'],
        write_calendar: ['write_calendar'],
        read_drive: ['read_drive'],
        write_drive: ['write_drive'],
        read_docs: ['read_docs'],
        write_docs: ['write_docs'],
        read_sheets: ['read_sheets'],
        write_sheets: ['write_sheets'],
        mcp_tool: ['network_access'],
      };
      const capabilities = capMap[type] ?? [];
      const result = runtime.guardian.check({
        type,
        agentId: agentId || 'assistant-tools',
        capabilities,
        params,
      });
      if (!result.allowed) {
        runtime.auditLog.record({
          type: 'action_denied',
          severity: 'warn',
          agentId: agentId || 'assistant-tools',
          controller: result.controller,
          details: {
            actionType: type,
            reason: result.reason,
            source: `tool_runtime:${origin}`,
          },
        });
        throw new Error(result.reason ?? 'Action denied by guardian policy.');
      }
      runtime.auditLog.record({
        type: 'action_allowed',
        severity: 'info',
        agentId: agentId || 'assistant-tools',
        controller: result.controller,
        details: {
          actionType: type,
          source: `tool_runtime:${origin}`,
        },
      });
    },
    onPreExecute: async (action) => {
      const hostDecision = hostMonitor.shouldBlockAction(action);
      if (!hostDecision.allowed) {
        runtime.auditLog.record({
          type: 'action_denied',
          severity: 'critical',
          agentId: action.agentId,
          controller: 'HostMonitor',
          details: {
            actionType: action.type,
            toolName: action.toolName,
            reason: hostDecision.reason,
            source: 'host_monitor_enforcement',
          },
        });
        return hostDecision;
      }
      const gatewayDecision = gatewayMonitor.shouldBlockAction(action);
      if (!gatewayDecision.allowed) {
        runtime.auditLog.record({
          type: 'action_denied',
          severity: 'critical',
          agentId: action.agentId,
          controller: 'GatewayMonitor',
          details: {
            actionType: action.type,
            toolName: action.toolName,
            reason: gatewayDecision.reason,
            source: 'gateway_monitor_enforcement',
          },
        });
        return gatewayDecision;
      }

      if (guardianAgentConfig?.enabled === false) {
        return { allowed: true };
      }

      const evaluation = await guardianAgentService.evaluateAction(action);
      if (!evaluation.allowed) {
        runtime.auditLog.record({
          type: 'action_denied',
          severity: evaluation.riskLevel === 'critical' ? 'critical' : 'warn',
          agentId: action.agentId,
          controller: 'GuardianAgent',
          details: {
            actionType: action.type,
            toolName: action.toolName,
            reason: evaluation.reason,
            riskLevel: evaluation.riskLevel,
            source: 'guardian_agent_inline',
          },
        });
      } else if (evaluation.riskLevel !== 'safe') {
        runtime.auditLog.record({
          type: 'action_allowed',
          severity: 'info',
          agentId: action.agentId,
          controller: 'GuardianAgent',
          details: {
            actionType: action.type,
            toolName: action.toolName,
            reason: evaluation.reason,
            riskLevel: evaluation.riskLevel,
            source: 'guardian_agent_inline',
          },
        });
      }
      return { allowed: evaluation.allowed, reason: evaluation.reason };
    },
  };

  const toolExecutor = new ToolExecutor(toolExecutorOptions);

  if (config.runtime.agentIsolation.enabled && config.runtime.agentIsolation.mode === 'brokered') {
    runtime.workerManager = new WorkerManager(
      toolExecutor,
      runtime,
      config.runtime.agentIsolation,
      DEFAULT_SANDBOX_CONFIG,
    );
  } else {
    runtime.workerManager = undefined;
  }

  const initialSearchReload = await initialSearchReloadRef.current();
  if (!initialSearchReload.success) {
    console.error(initialSearchReload.message);
  }

  const connectors = new ConnectorPlaybookService({
    config: config.assistant.connectors,
    runTool: async (request) => toolExecutor.runTool(request),
    runInstruction: async (prompt, providerName, maxTokens) => {
      const provider = providerName
        ? runtime.getProvider(providerName)
        : runtime.getDefaultProvider();
      if (!provider) throw new Error('No LLM provider available for instruction step.');
      const response = await provider.chat(
        [{ role: 'user', content: prompt }],
        { maxTokens: maxTokens ?? 2048, temperature: 0.3, tools: [] },
      );
      return response.content;
    },
  });

  const getPlaybookOutputHandling = (playbookId: string) => (
    connectors.getState().playbooks.find((playbook) => playbook.id === playbookId)?.outputHandling
  );

  // Scheduled tasks — unified scheduling for tools and playbooks
  const scheduledTasks = new ScheduledTaskService({
    scheduler: runtime.scheduler,
    toolExecutor,
    playbookExecutor: connectors,
    deviceInventory,
    eventBus: runtime.eventBus,
    auditLog: runtime.auditLog,
    resolvePlaybookOutputHandling: getPlaybookOutputHandling,
    onNetworkScanComplete: () => {
      runNetworkAnalysis('scheduled-task');
    },
  });
  await scheduledTasks.load().catch(() => {});

  // Auto-install all preset scheduled tasks on first run (no existing tasks)
  if (scheduledTasks.list().length === 0) {
    scheduledTasks.autoInstallAllPresets();
  }

  // Auto-install all connector templates if no packs exist yet
  if (connectors.getState().packs.length === 0) {
    autoInstallAllTemplates(connectors);
  }

  function syncPlaybookOutputHandlingToSchedules(playbookId: string): void {
    const outputHandling = getPlaybookOutputHandling(playbookId);
    for (const task of scheduledTasks.list()) {
      if (task.type !== 'playbook' || task.target !== playbookId) continue;
      scheduledTasks.update(task.id, { outputHandling });
    }
  }

  function syncPlaybookScheduleToTasks(playbook: { id: string; name: string; enabled: boolean; schedule?: string }): void {
    const linkedTasks = scheduledTasks.list().filter((task) => task.type === 'playbook' && task.target === playbook.id);
    for (const linkedTask of linkedTasks) {
      scheduledTasks.update(linkedTask.id, {
        name: playbook.name,
        enabled: playbook.enabled !== false,
      });
    }

    if (!Object.prototype.hasOwnProperty.call(playbook, 'schedule')) {
      return;
    }

    const normalizedSchedule = playbook.schedule?.trim() || '';

    if (!normalizedSchedule) {
      if (linkedTasks.length === 1) {
        scheduledTasks.delete(linkedTasks[0].id);
      }
      return;
    }

    const outputHandling = getPlaybookOutputHandling(playbook.id);
    const linkedTask = linkedTasks[0];
    if (linkedTask) {
      scheduledTasks.update(linkedTask.id, {
        name: playbook.name,
        cron: normalizedSchedule,
        enabled: playbook.enabled !== false,
        outputHandling,
      });
      return;
    }

    scheduledTasks.create({
      name: playbook.name,
      type: 'playbook',
      target: playbook.id,
      cron: normalizedSchedule,
      enabled: playbook.enabled !== false,
      outputHandling,
    });
  }

  function attachPlaybookPromotions(result: {
    run?: {
      id: string;
      playbookId: string;
      playbookName: string;
      status: string;
      message: string;
      steps: Array<{ stepId?: string; toolName: string; status?: string; message?: string; output?: unknown }>;
      outputHandling?: unknown;
      promotedFindings?: unknown;
    };
  }, input: {
    playbookId: string;
    origin?: 'assistant' | 'cli' | 'web';
    agentId?: string;
    userId?: string;
    channel?: string;
  }): void {
    if (!result.run) return;
    result.run.outputHandling = getPlaybookOutputHandling(input.playbookId);
    result.run.promotedFindings = promoteAutomationFindings(runtime.auditLog, {
      automationId: result.run.playbookId,
      automationName: result.run.playbookName,
      runId: result.run.id,
      status: result.run.status,
      message: result.run.message,
      steps: result.run.steps,
      outputHandling: getPlaybookOutputHandling(input.playbookId),
      origin: input.origin,
      agentId: input.agentId,
      userId: input.userId,
      channel: input.channel,
      runLink: `#/automations?runId=${encodeURIComponent(result.run.id)}`,
    });
  }

  const configuredToken = config.channels.web?.auth?.token?.trim() || config.channels.web?.authToken?.trim();
  const rotateOnStartup = config.channels.web?.auth?.rotateOnStartup ?? false;
  const shouldGenerateToken = !configuredToken || rotateOnStartup;
  const effectiveToken = shouldGenerateToken ? generateSecureToken() : configuredToken;
  const webAuthStateRef: { current: WebAuthRuntimeConfig } = {
    current: {
      mode: 'bearer_required',
      token: effectiveToken,
      tokenSource: configuredToken && !rotateOnStartup ? 'config' : 'ephemeral',
      rotateOnStartup,
      sessionTtlMinutes: config.channels.web?.auth?.sessionTtlMinutes,
    },
  };

  let activeWebChannel: WebChannel | null = null;
  const applyWebAuthRuntime = (auth: WebAuthRuntimeConfig): void => {
    webAuthStateRef.current = { ...auth };
    if (activeWebChannel) {
      activeWebChannel.setAuthConfig(webAuthStateRef.current);
    }
  };

  let threatIntelInterval: NodeJS.Timeout | null = null;
  const orchestrator = new AssistantOrchestrator();
  const jobTracker = new AssistantJobTracker();

  const findProviderByLocality = (
    cfg: GuardianAgentConfig,
    locality: 'local' | 'external',
  ): string | null => {
    const preferred = cfg.assistant.tools.preferredProviders?.[locality]?.trim();
    if (preferred && getProviderLocality(cfg.llm[preferred]) === locality) {
      return preferred;
    }

    if (getProviderLocality(cfg.llm[cfg.defaultProvider]) === locality) {
      return cfg.defaultProvider;
    }

    for (const [name, llmCfg] of Object.entries(cfg.llm)) {
      if (getProviderLocality(llmCfg) === locality) {
        return name;
      }
    }
    return null;
  };

  // ─── Model fallback chain ─────────────────────────────────
  // Build a fallback chain from config.fallbacks: [defaultProvider, ...fallbacks]
  // When the primary provider fails (rate limit, timeout, etc.), the chain
  // tries each fallback in order with per-provider cooldowns.
  let fallbackChain: ModelFallbackChain | undefined;
  if (config.fallbacks?.length) {
    const allProviders = createProviders(resolvedRuntimeCredentials.resolvedLLM);
    const order = [config.defaultProvider, ...config.fallbacks.filter(f => f !== config.defaultProvider)];
    fallbackChain = new ModelFallbackChain(allProviders, order);
    log.info({ order: fallbackChain.getProviderOrder() }, 'Model fallback chain configured');
  } else {
    // Auto-build fallback chain when multiple providers exist but no explicit fallbacks configured.
    // This enables quality-based fallback: if the local LLM produces a degraded response,
    // the system can retry with an external provider automatically.
    const providerNames = Object.keys(resolvedRuntimeCredentials.resolvedLLM);
    if (providerNames.length > 1) {
      const allProviders = createProviders(resolvedRuntimeCredentials.resolvedLLM);
      const order = [config.defaultProvider, ...providerNames.filter(n => n !== config.defaultProvider)];
      fallbackChain = new ModelFallbackChain(allProviders, order);
      log.info({ order: fallbackChain.getProviderOrder(), auto: true }, 'Auto-configured model fallback chain');
    }
  }

  // Register agents from config, auto-create dual agents, or single default
  const localProviderName = findProviderByLocality(config, 'local');
  const externalProviderName = findProviderByLocality(config, 'external');
  const soulProfile = loadSoulProfile(config);
  if (soulProfile) {
    log.info(
      {
        path: soulProfile.path,
        primaryMode: config.assistant.soul.primaryMode,
        delegatedMode: config.assistant.soul.delegatedMode,
      },
      'SOUL prompt injection enabled',
    );
  }

  // Dynamic GWS model provider resolver — re-evaluates at request time so
  // providers added via web UI config (hot reload) are picked up without restart.
  const resolveGwsProvider = () => {
    if (!enabledManagedProviders.has('gws')) {
      return undefined;
    }
    const currentConfig = configRef.current;
    // 1. Explicitly configured GWS model
    const gwsModelName = currentConfig.assistant.tools.mcp?.managedProviders?.gws?.model;
    if (gwsModelName) {
      const provider = runtime.getProvider(gwsModelName);
      if (provider) return provider;
    }
    // 2. Use the preferred external provider for external/tool-calling work.
    const externalName = findProviderByLocality(currentConfig, 'external');
    if (!externalName) {
      return undefined;
    }
    return runtime.getProvider(externalName);
  };
  // Log initial resolution at startup
  if (googleService && enabledManagedProviders.has('gws')) {
    const initialGws = resolveGwsProvider();
    if (initialGws) {
      const gwsModelName = config.assistant.tools.mcp?.managedProviders?.gws?.model;
      if (gwsModelName && runtime.getProvider(gwsModelName)) {
        console.log(`  Google Workspace: using '${gwsModelName}' model for tool-calling`);
      } else {
        const preferredExternal = findProviderByLocality(config, 'external');
        if (preferredExternal) {
          console.log(`  Google Workspace: using preferred external provider '${preferredExternal}' for tool-calling`);
        }
      }
    } else {
      console.warn('  Google Workspace: no LLM provider available for tool-calling. Add an Anthropic or OpenAI provider for best results.');
    }
  }

  // Per-tool provider routing: resolves tool names → routed LLM provider.
  // Reads configRef.current at call time so hot-reloaded routing config takes effect immediately.
  // Uses computed category defaults (based on available providers) as fallback.
  // Disabled when providerRoutingEnabled is false — all tools use the default provider.
  const resolveRoutedProviderForTools = (
    tools: Array<{ name: string; category?: string }>,
  ): { provider: LLMProvider; locality: 'local' | 'external' } | undefined => {
    if (configRef.current.assistant.tools.providerRoutingEnabled === false) return undefined;

    const routingMap = configRef.current.assistant.tools.providerRouting;
    const catDefaults = computeCategoryDefaults(configRef.current.llm as Record<string, { provider?: string }>);

    const pref = resolveToolProviderRouting(tools, routingMap, catDefaults);
    if (pref === 'default') return undefined;

    const currentConfig = configRef.current;
    const providerName = findProviderByLocality(currentConfig, pref);
    if (!providerName) return undefined;
    const provider = runtime.getProvider(providerName);
    if (!provider) return undefined;
    return { provider, locality: pref };
  };

  // Resolve agent capabilities from trust preset / config.
  // The orchestrator decides which MODEL handles a request (local vs external),
  // NOT what the agent is allowed to do. Security policy is user-configured.
  const DEFAULT_AGENT_CAPABILITIES: Capability[] = [
    'read_files', 'write_files', 'execute_commands',
    'network_access', 'read_email', 'draft_email', 'send_email',
  ];
  const presetName = config.guardian?.trustPreset as TrustPresetName | undefined;
  const agentCapabilities: Capability[] = presetName && TRUST_PRESETS[presetName]
    ? [...TRUST_PRESETS[presetName].capabilities]
    : DEFAULT_AGENT_CAPABILITIES;
  const chatAgents = new Map<string, ChatAgent>();

  if (config.agents.length > 0) {
    // Config-driven agents: register all and build router from config rules
    const primaryConfiguredAgentId = config.agents.find((agent) => agent.role === 'general')?.id
      ?? config.agents[0]?.id;
    for (const agentConfig of config.agents) {
      const soulMode: SoulInjectionMode = agentConfig.id === primaryConfiguredAgentId
        ? config.assistant.soul.primaryMode
        : config.assistant.soul.delegatedMode;
      const sharedStateAgentId = agentConfig.role === 'local' || agentConfig.role === 'external'
        ? SHARED_TIER_AGENT_STATE_ID
        : agentConfig.id;
      const agent = new ChatAgent(
        agentConfig.id,
        agentConfig.name,
        agentConfig.systemPrompt,
        conversations,
        toolExecutor,
        runtime.outputGuardian,
        skillResolver,
        enabledManagedProviders,
        fallbackChain,
        selectSoulPrompt(soulProfile, soulMode),
        agentMemoryStore,
        sharedStateAgentId,
        resolveGwsProvider,
        config.assistant.tools.contextBudget,
        config.qualityFallback,
        resolveRoutedProviderForTools,
      );
      chatAgents.set(agentConfig.id, agent);
      runtime.registerAgent(createAgentDefinition({
        agent,
        providerName: agentConfig.provider,
        schedule: agentConfig.schedule,
        grantedCapabilities: agentConfig.capabilities,
        resourceLimits: agentConfig.resourceLimits,
      }));
      router.registerAgent(
        agentConfig.id,
        agentConfig.capabilities ?? [],
        config.routing?.rules?.[agentConfig.id],
        agentConfig.role,
      );
    }
  } else if (localProviderName && externalProviderName) {
    // Auto dual-agent: local (Ollama) + external (Anthropic/OpenAI)
    const localPrompt = 'You specialize in local workstation tasks: file operations, code editing, git, build tools, and local command execution. Focus on filesystem, development, and local system tasks. If the user asks to search the web or look something up online, use the web_search and web_fetch tools — they are available to you.';
    const externalPrompt = 'You specialize in external and network tasks: web research, API calls, email, threat intelligence, and online services. Use web_search to find information online and web_fetch to read web pages. Always use these tools when the user asks to search, look up, or find something on the web.';

    const localAgent = new ChatAgent(
      'local',
      'Local Agent',
      localPrompt,
      conversations,
      toolExecutor,
      runtime.outputGuardian,
      skillResolver,
      enabledManagedProviders,
      fallbackChain,
      selectSoulPrompt(soulProfile, config.assistant.soul.primaryMode),
      agentMemoryStore,
      SHARED_TIER_AGENT_STATE_ID,
      resolveGwsProvider,
      config.assistant.tools.contextBudget,
      config.qualityFallback,
      resolveRoutedProviderForTools,
    );
    chatAgents.set('local', localAgent);
    runtime.registerAgent(createAgentDefinition({
      agent: localAgent,
      providerName: localProviderName,
      grantedCapabilities: agentCapabilities,
    }));

    const externalAgent = new ChatAgent(
      'external',
      'External Agent',
      externalPrompt,
      conversations,
      toolExecutor,
      runtime.outputGuardian,
      skillResolver,
      enabledManagedProviders,
      fallbackChain,
      selectSoulPrompt(soulProfile, config.assistant.soul.delegatedMode),
      agentMemoryStore,
      SHARED_TIER_AGENT_STATE_ID,
      resolveGwsProvider,
      config.assistant.tools.contextBudget,
      config.qualityFallback,
      resolveRoutedProviderForTools,
    );
    chatAgents.set('external', externalAgent);
    runtime.registerAgent(createAgentDefinition({
      agent: externalAgent,
      providerName: externalProviderName,
      grantedCapabilities: agentCapabilities,
    }));

    // Register with router using default domain rules
    router.registerAgent('local', agentCapabilities, {
      domains: ['filesystem', 'code'],
      patterns: [
        '\\b(file|folder|directory|path|create|delete|move|copy|rename|save|open)\\b',
        '\\b(git|commit|branch|merge|pull request|build|compile|lint|test|npm|node)\\b',
      ],
      priority: 5,
    }, 'local');
    router.registerAgent('external', agentCapabilities, {
      domains: ['network', 'email'],
      patterns: [
        '\\b(search|web|browse|http|api|download|upload|url|website|online|internet)\\b',
        '\\b(email|mail|send|draft|inbox|compose|reply|forward|gmail)\\b',
        '\\b(cve|vulnerability|threat|exploit|security advisory|intelligence)\\b',
      ],
      priority: 5,
    }, 'external');

    log.info(
      { local: localProviderName, external: externalProviderName },
      'Auto-created dual agents: local + external',
    );
  } else {
    // Single default agent — backward compatible
    const defaultAgent = new ChatAgent(
      'default',
      'Guardian Agent',
      undefined,
      conversations,
      toolExecutor,
      runtime.outputGuardian,
      skillResolver,
      enabledManagedProviders,
      fallbackChain,
      selectSoulPrompt(soulProfile, config.assistant.soul.primaryMode),
      agentMemoryStore,
      'default',
      resolveGwsProvider,
      config.assistant.tools.contextBudget,
      config.qualityFallback,
      resolveRoutedProviderForTools,
    );
    chatAgents.set('default', defaultAgent);
    runtime.registerAgent(createAgentDefinition({
      agent: defaultAgent,
      grantedCapabilities: agentCapabilities,
    }));
    router.registerAgent('default', agentCapabilities);
  }

  // ─── Guardian Agent + Sentinel provider setup ─────────────────────
  // Resolve local (Ollama) and external (OpenAI/Anthropic) providers for
  // inline evaluation and audit analysis.
  {
    let localProvider: LLMProvider | undefined;
    let externalLlmProvider: LLMProvider | undefined;
    for (const [name, llmCfg] of Object.entries(config.llm)) {
      const provider = runtime.getProvider(name);
      if (!provider) continue;
      if (llmCfg.provider === 'ollama' && !localProvider) {
        localProvider = provider;
      } else if (llmCfg.provider !== 'ollama' && !externalLlmProvider) {
        externalLlmProvider = provider;
      }
    }
    guardianAgentService.setProviders(localProvider, externalLlmProvider);
    // Sentinel audit shares the same provider resolution (prefers external for deeper analysis)
    sentinelAuditService.setProvider(externalLlmProvider ?? localProvider);

    if (guardianAgentConfig?.enabled !== false) {
      const mode = guardianAgentConfig?.llmProvider ?? 'auto';
      const activeProvider = mode === 'local' ? localProvider
        : mode === 'external' ? externalLlmProvider
        : (localProvider ?? externalLlmProvider);
      const failMode = guardianAgentConfig?.failOpen === true ? 'fail-open' : 'fail-closed';
      console.log(`  Guardian Agent: inline evaluation ${activeProvider ? `enabled (${mode}, provider: ${activeProvider.name})` : `enabled (no LLM available, ${failMode})`}`);
    }
  }

  // Register Sentinel audit on cron schedule if enabled
  if (sentinelAuditConfig?.enabled !== false) {
    const auditSchedule = sentinelAuditConfig?.schedule ?? '*/5 * * * *';
    // Create a lightweight agent that delegates to SentinelAuditService
    const sentinelAuditAgent = new (class extends BaseAgent {
      constructor() {
        super('sentinel', 'Sentinel Audit Agent', {
          handleMessages: false,
          handleEvents: true,
          handleSchedule: true,
        });
      }
      async onSchedule(ctx: import('./agent/types.js').ScheduleContext): Promise<void> {
        const auditLog = ctx.auditLog;
        if (!auditLog) return;
        await sentinelAuditService.runAudit(auditLog);
      }
      async onEvent(event: import('./queue/event-bus.js').AgentEvent): Promise<void> {
        if (event.type === 'guardian.critical') {
          // Future: automated response to critical events
        }
      }
    })();
    runtime.registerAgent(createAgentDefinition({
      agent: sentinelAuditAgent,
      schedule: auditSchedule,
    }));
    console.log(`  Sentinel Audit: scheduled (${auditSchedule})`);
  }

  // Start channels
  const channels: { name: string; stop: () => Promise<void> }[] = [];

  const defaultAgentId = config.agents[0]?.id ?? (localProviderName && externalProviderName ? 'local' : 'default');

  /** Resolve target agent with tier routing: channel override → tier router → plain router. */
  const resolveAgentWithTier = (channelDefault: string | undefined, content: string): RouteDecision => {
    if (channelDefault) {
      return { agentId: channelDefault, confidence: 'high', reason: 'channel default override' };
    }
    const routingCfg = configRef.current.routing;
    const tierMode = routingCfg?.tierMode ?? 'auto';
    const threshold = routingCfg?.complexityThreshold ?? 0.5;

    // Only use tier routing when role-tagged agents exist
    const hasRoles = router.findAgentByRole('local') || router.findAgentByRole('external');
    if (hasRoles) {
      return router.routeWithTier(content, tierMode, threshold);
    }
    return router.route(content);
  };
  // ─── Policy-as-Code Engine Bootstrap ─────────────────────────────
  const policyConfig = config.guardian?.policy ?? { enabled: true, mode: 'shadow' as const, rulesPath: 'policies/', mismatchLogLimit: 1000 };
  const policyEngine = createPolicyEngine();
  let policyMode: PolicyModeConfig = policyConfig.enabled ? (policyConfig.mode ?? 'shadow') : 'off';
  let policyFamilies: Record<string, PolicyModeConfig> = {
    tool: (policyConfig as { families?: Record<string, PolicyModeConfig> }).families?.tool ?? policyMode,
    admin: (policyConfig as { families?: Record<string, PolicyModeConfig> }).families?.admin ?? policyMode,
    guardian: (policyConfig as { families?: Record<string, PolicyModeConfig> }).families?.guardian ?? policyMode,
    event: (policyConfig as { families?: Record<string, PolicyModeConfig> }).families?.event ?? policyMode,
  };
  let policyMismatchLogLimit = policyConfig.mismatchLogLimit ?? 1000;
  const policyRulesPath = join(process.cwd(), policyConfig.rulesPath ?? 'policies/');

  const shadowEvaluator = new ShadowEvaluator({
    engine: policyEngine,
    logger: {
      info: (msg, data) => log.info(data ?? {}, msg),
      warn: (msg, data) => {
        log.warn(data ?? {}, msg);
        runtime.auditLog?.record?.({
          type: 'policy_shadow_mismatch',
          severity: 'info',
          agentId: 'policy-engine',
          controller: 'PolicyEngine',
          details: data ?? {},
        });
      },
    },
    mismatchLogLimit: policyMismatchLogLimit,
  });

  // Load rules from disk
  const policyLoadResult = loadPolicyFiles(policyRulesPath);
  if (policyLoadResult.rules.length > 0) {
    const reloadResult = policyEngine.reload(policyLoadResult.rules);
    log.info({
      loaded: reloadResult.loaded,
      skipped: reloadResult.skipped,
      errors: reloadResult.errors.length,
      path: policyRulesPath,
    }, `Policy engine: loaded ${reloadResult.loaded} rules from ${policyLoadResult.fileCount} file(s)`);
    if (reloadResult.errors.length > 0) {
      for (const err of reloadResult.errors.slice(0, 5)) {
        log.warn({ error: err }, 'Policy rule error');
      }
    }
  } else if (policyLoadResult.errors.length > 0) {
    for (const err of policyLoadResult.errors) {
      log.warn({ error: err }, 'Policy file load error');
    }
  } else {
    log.info({ path: policyRulesPath }, 'Policy engine: no rule files found (using family defaults)');
  }

  runtime.auditLog?.record?.({
    type: 'policy_engine_started',
    severity: 'info',
    agentId: 'policy-engine',
    controller: 'PolicyEngine',
    details: {
      mode: policyMode,
      families: policyFamilies,
      ruleCount: policyEngine.ruleCount(),
      rulesPath: policyRulesPath,
    },
  });

  const policyState: PolicyState = {
    getStatus: () => ({
      enabled: policyMode !== 'off',
      mode: policyMode,
      families: { ...policyFamilies } as { tool: string; admin: string; guardian: string; event: string },
      rulesPath: policyConfig.rulesPath ?? 'policies/',
      ruleCount: policyEngine.ruleCount(),
      mismatchLogLimit: policyMismatchLogLimit,
      shadowStats: policyMode === 'shadow' ? shadowEvaluator.stats() : undefined,
    }),
    update: (input) => {
      if (input.mode !== undefined) {
        const validModes = ['off', 'shadow', 'enforce'];
        if (!validModes.includes(input.mode)) {
          return { success: false, message: `Invalid mode '${input.mode}'. Valid: ${validModes.join(', ')}` };
        }
        policyMode = input.mode;
        runtime.auditLog?.record?.({
          type: 'policy_mode_changed',
          severity: input.mode === 'enforce' ? 'warn' : 'info',
          agentId: 'policy-engine',
          controller: 'PolicyEngine',
          details: { newMode: input.mode },
        });
      }
      if (input.enabled !== undefined) {
        policyMode = input.enabled ? (input.mode ?? 'shadow') : 'off';
      }
      if (input.families) {
        for (const [fam, mode] of Object.entries(input.families)) {
          if (mode && ['off', 'shadow', 'enforce'].includes(mode)) {
            policyFamilies[fam] = mode as PolicyModeConfig;
          }
        }
      }
      if (input.mismatchLogLimit !== undefined) {
        policyMismatchLogLimit = input.mismatchLogLimit;
      }
      return { success: true, message: `Policy engine updated: mode=${policyMode}` };
    },
    reload: () => {
      const loadResult = loadPolicyFiles(policyRulesPath);
      if (loadResult.errors.length > 0 && loadResult.rules.length === 0) {
        return { success: false, message: 'Failed to load policy files.', loaded: 0, skipped: 0, errors: loadResult.errors };
      }
      const reloadResult = policyEngine.reload(loadResult.rules);
      shadowEvaluator.reset();
      runtime.auditLog?.record?.({
        type: 'policy_rules_reloaded',
        severity: 'info',
        agentId: 'policy-engine',
        controller: 'PolicyEngine',
        details: { loaded: reloadResult.loaded, skipped: reloadResult.skipped, errors: reloadResult.errors.length, fileCount: loadResult.fileCount },
      });
      return {
        success: true,
        message: `Reloaded ${reloadResult.loaded} rules from ${loadResult.fileCount} file(s).`,
        loaded: reloadResult.loaded,
        skipped: reloadResult.skipped,
        errors: [...loadResult.errors, ...reloadResult.errors],
      };
    },
  };

  const {
    telegramReloadRef,
    reloadSearchRef,
    ...dashboardCallbacks
  } = buildDashboardCallbacks(
    runtime,
    configRef,
    threatIntelWebSearchConfigRef,
    secretStore,
    conversations,
    identity,
    analytics,
    orchestrator,
    jobTracker,
    threatIntel,
    connectors,
    toolExecutor,
    chatAgents,
    skillRegistry,
    enabledManagedProviders,
    webAuthStateRef,
    applyWebAuthRuntime,
    configPath,
    router,
    deviceInventory,
    networkBaseline,
    hostMonitor,
    runHostMonitoring,
    gatewayMonitor,
    runGatewayMonitoring,
    runNetworkAnalysis,
    guardianAgentService,
    sentinelAuditService,
    policyState,
    googleAuthRef,
    googleServiceRef,
  );

  const basePlaybookUpsert = dashboardCallbacks.onPlaybookUpsert;
  if (basePlaybookUpsert) {
    dashboardCallbacks.onPlaybookUpsert = (playbook) => {
      const result = basePlaybookUpsert(playbook);
      if (result.success) {
        syncPlaybookScheduleToTasks(playbook);
        syncPlaybookOutputHandlingToSchedules(playbook.id);
      }
      return result;
    };
  }

  const basePlaybookRun = dashboardCallbacks.onPlaybookRun;
  if (basePlaybookRun) {
    dashboardCallbacks.onPlaybookRun = async (input) => {
      const result = await basePlaybookRun(input);
      attachPlaybookPromotions(result, input);
      return result;
    };
  }

  reloadSearchRef.current = initialSearchReloadRef.current;

  // Factory reset: bulk-clear data, config, or both
  dashboardCallbacks.onFactoryReset = async ({ scope }) => {
    const baseDir = join(homedir(), '.guardianagent');
    const deletedFiles: string[] = [];
    const errors: string[] = [];

    const tryDelete = (label: string, target: string, opts?: { recursive?: boolean }) => {
      try {
        if (!existsSync(target)) return;
        rmSync(target, { force: true, recursive: opts?.recursive ?? false });
        deletedFiles.push(label);
      } catch (err) {
        errors.push(`${label}: ${(err as Error).message}`);
      }
    };

    // Close DB connections before deleting SQLite files
    if (scope === 'data' || scope === 'all') {
      try { conversations.close(); } catch { /* already closed */ }
      try { analytics.close(); } catch { /* already closed */ }

      tryDelete('assistant-memory.sqlite', resolveAssistantDbPath(config.assistant.memory.sqlitePath, 'assistant-memory.sqlite'));
      tryDelete('assistant-analytics.sqlite', resolveAssistantDbPath(config.assistant.analytics.sqlitePath, 'assistant-analytics.sqlite'));
      // Also remove SQLite WAL/SHM files if present
      for (const suffix of ['-wal', '-shm']) {
        tryDelete(`assistant-memory.sqlite${suffix}`, resolveAssistantDbPath(config.assistant.memory.sqlitePath, 'assistant-memory.sqlite') + suffix);
        tryDelete(`assistant-analytics.sqlite${suffix}`, resolveAssistantDbPath(config.assistant.analytics.sqlitePath, 'assistant-analytics.sqlite') + suffix);
      }
      tryDelete('memory/ (agent knowledge base)', join(baseDir, 'memory'), { recursive: true });
      tryDelete('audit/ (audit log)', join(baseDir, 'audit'), { recursive: true });
      tryDelete('device-inventory.json', join(baseDir, 'device-inventory.json'));
      tryDelete('scheduled-tasks.json', join(baseDir, 'scheduled-tasks.json'));
      tryDelete('network-baseline.json', join(baseDir, 'network-baseline.json'));
      tryDelete('network-traffic.json', join(baseDir, 'network-traffic.json'));
    }

    if (scope === 'config' || scope === 'all') {
      try {
        const defaultYaml = [
          '# GuardianAgent Configuration',
          '# Reset to defaults by factory-reset',
          '',
          'llm:',
          '  ollama:',
          '    provider: ollama',
          '    baseUrl: http://127.0.0.1:11434',
          '    model: llama3.2',
          '',
          'defaultProvider: ollama',
          '',
          'channels:',
          '  cli:',
          '    enabled: true',
          '',
        ].join('\n');
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, defaultYaml, 'utf-8');
        deletedFiles.push('config.yaml (reset to defaults)');
      } catch (err) {
        errors.push(`config.yaml: ${(err as Error).message}`);
      }
    }

    const scopeLabel = scope === 'data' ? 'data' : scope === 'config' ? 'configuration' : 'data and configuration';
    log.warn({ scope, deletedFiles, errors }, `Factory reset completed (${scopeLabel})`);

    return {
      success: errors.length === 0,
      message: errors.length === 0
        ? `Factory reset complete — cleared ${scopeLabel}.`
        : `Factory reset finished with ${errors.length} error(s).`,
      deletedFiles,
      errors,
    };
  };

  // Routing mode: read/write tier mode at runtime
  dashboardCallbacks.onRoutingMode = () => {
    const r = configRef.current.routing;
    return {
      tierMode: r?.tierMode ?? 'auto',
      complexityThreshold: r?.complexityThreshold ?? 0.5,
      fallbackOnFailure: r?.fallbackOnFailure !== false,
    };
  };
  dashboardCallbacks.onRoutingModeUpdate = (mode) => {
    if (!configRef.current.routing) {
      configRef.current.routing = { strategy: 'keyword' };
    }
    configRef.current.routing.tierMode = mode;
    log.info({ tierMode: mode }, 'Tier routing mode updated');
    return { success: true, message: `Routing mode set to: ${mode}`, tierMode: mode };
  };

  // ─── Scheduled Tasks callbacks ─────────────────────────
  dashboardCallbacks.onScheduledTasks = () => scheduledTasks.list();
  dashboardCallbacks.onScheduledTaskGet = (id) => scheduledTasks.get(id);
  dashboardCallbacks.onScheduledTaskCreate = (input) => scheduledTasks.create(input);
  dashboardCallbacks.onScheduledTaskUpdate = (id, input) => scheduledTasks.update(id, input);
  dashboardCallbacks.onScheduledTaskDelete = (id) => scheduledTasks.delete(id);
  dashboardCallbacks.onScheduledTaskRunNow = (id) => scheduledTasks.runNow(id);
  dashboardCallbacks.onScheduledTaskPresets = () => scheduledTasks.getPresets();
  dashboardCallbacks.onScheduledTaskInstallPreset = (presetId) => scheduledTasks.installPreset(presetId);
  dashboardCallbacks.onScheduledTaskHistory = () => scheduledTasks.getHistory();

  toolExecutor.setAutomationControlPlane({
    listWorkflows: () => connectors.getState().playbooks.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      enabled: workflow.enabled,
      mode: workflow.mode,
      description: workflow.description,
      schedule: workflow.schedule,
      outputHandling: workflow.outputHandling,
      steps: workflow.steps.map((step) => ({ ...step })),
    })),
    upsertWorkflow: (workflow) => {
      if (!dashboardCallbacks.onPlaybookUpsert) {
        return { success: false, message: 'Workflow control plane is not available.' };
      }
      return dashboardCallbacks.onPlaybookUpsert(workflow as unknown as Parameters<NonNullable<DashboardCallbacks['onPlaybookUpsert']>>[0]);
    },
    deleteWorkflow: (workflowId) => {
      if (!dashboardCallbacks.onPlaybookDelete) {
        return { success: false, message: 'Workflow control plane is not available.' };
      }
      return dashboardCallbacks.onPlaybookDelete(workflowId);
    },
    runWorkflow: async (input) => {
      if (!dashboardCallbacks.onPlaybookRun) {
        return { success: false, message: 'Workflow control plane is not available.', status: 'error' };
      }
      return dashboardCallbacks.onPlaybookRun({
        playbookId: input.workflowId,
        dryRun: input.dryRun,
        origin: input.origin,
        agentId: input.agentId,
        userId: input.userId,
        channel: input.channel,
        requestedBy: input.requestedBy,
      });
    },
    listTasks: () => scheduledTasks.list(),
    createTask: (input) => {
      if (!dashboardCallbacks.onScheduledTaskCreate) {
        return { success: false, message: 'Task control plane is not available.' };
      }
      return dashboardCallbacks.onScheduledTaskCreate(
        input as unknown as Parameters<NonNullable<DashboardCallbacks['onScheduledTaskCreate']>>[0],
      );
    },
    updateTask: (id, input) => {
      if (!dashboardCallbacks.onScheduledTaskUpdate) {
        return { success: false, message: 'Task control plane is not available.' };
      }
      return dashboardCallbacks.onScheduledTaskUpdate(
        id,
        input as unknown as Parameters<NonNullable<DashboardCallbacks['onScheduledTaskUpdate']>>[1],
      );
    },
    deleteTask: (id) => {
      if (!dashboardCallbacks.onScheduledTaskDelete) {
        return { success: false, message: 'Task control plane is not available.' };
      }
      return dashboardCallbacks.onScheduledTaskDelete(id);
    },
  });

  // ─── Document Search callbacks ──────────────────────────
  dashboardCallbacks.onSearchStatus = () => {
    const runtimeStatus = docSearch?.status();
    return {
      installed: docSearch?.isAvailable() === true,
      available: runtimeStatus?.available ?? false,
      version: 'native',
      collections: runtimeStatus?.collections ?? [],
      configuredSources: runtimeStatus?.configuredSources ?? (
        configRef.current.assistant.tools.search?.sources ?? []
      ).map((source) => ({
        id: source.id,
        name: source.name,
        type: source.type,
        path: source.path,
        enabled: source.enabled,
      })),
      vectorSearchAvailable: runtimeStatus?.vectorSearchAvailable ?? false,
    };
  };
  dashboardCallbacks.onSearchSources = () => docSearch
    ? docSearch.getSources()
    : (configRef.current.assistant.tools.search?.sources ?? []);
  dashboardCallbacks.onSearchPickPath = ({ kind }) => pickNativeSearchPath(kind);

  if (docSearch) {
    dashboardCallbacks.onSearchSourceAdd = (source: any) => {
      try {
        docSearch!.addSource(source);
        return { success: true, message: `Source '${source.id}' added.` };
      } catch (err: any) {
        return { success: false, message: err.message ?? String(err) };
      }
    };
    dashboardCallbacks.onSearchSourceRemove = (id: string) => {
      const removed = docSearch!.removeSource(id);
      return removed
        ? { success: true, message: `Source '${id}' removed.` }
        : { success: false, message: `Source '${id}' not found.` };
    };
    dashboardCallbacks.onSearchSourceToggle = (id: string, enabled: boolean) => {
      const toggled = docSearch!.toggleSource(id, enabled);
      return toggled
        ? { success: true, message: `Source '${id}' ${enabled ? 'enabled' : 'disabled'}.` }
        : { success: false, message: `Source '${id}' not found.` };
    };
    dashboardCallbacks.onSearchReindex = (collection?: string) => docSearch!.reindex(collection);
  }

  const autoScanMinutes = config.assistant.threatIntel.autoScanIntervalMinutes;
  let autoScanInFlight = false;
  if (config.assistant.threatIntel.enabled && autoScanMinutes > 0) {
    const intervalMs = autoScanMinutes * 60_000;
    threatIntelInterval = setInterval(() => {
      void (async () => {
        if (autoScanInFlight) {
          return;
        }
        const summary = threatIntel.getSummary();
        if (summary.watchlistCount === 0) return;
        autoScanInFlight = true;
        try {
          const result = await jobTracker.run(
            {
              type: 'threat_intel.autoscan',
              source: 'scheduled',
              detail: 'Scheduled watchlist scan',
              metadata: {
                watchlistCount: summary.watchlistCount,
                intervalMinutes: autoScanMinutes,
                includeDarkWeb: configRef.current.assistant.threatIntel.allowDarkWeb,
              },
            },
            async () => threatIntel.scan({
              includeDarkWeb: configRef.current.assistant.threatIntel.allowDarkWeb,
            }),
          );

          analytics.track({
            type: result.success ? 'threat_intel_autoscan' : 'threat_intel_autoscan_failed',
            channel: 'system',
            canonicalUserId: configRef.current.assistant.identity.primaryUserId,
            metadata: {
              watchlistCount: summary.watchlistCount,
              findings: result.findings.length,
              success: result.success,
            },
          });

          const highRisk = result.findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical');
          if (highRisk.length > 0) {
            runtime.auditLog.record({
              type: 'anomaly_detected',
              severity: 'warn',
              agentId: 'threat-intel',
              details: {
                source: 'threat_intel_autoscan',
                anomalyType: 'high_risk_signal',
                description: `${highRisk.length} high-risk finding(s) detected in scheduled threat-intel scan.`,
                evidence: {
                  findingIds: highRisk.map((finding) => finding.id),
                },
              },
            });
          }
        } finally {
          autoScanInFlight = false;
        }
      })().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        analytics.track({
          type: 'threat_intel_autoscan_failed',
          channel: 'system',
          canonicalUserId: configRef.current.assistant.identity.primaryUserId,
          metadata: { error: message },
        });
      });
    }, intervalMs);

    log.info({ intervalMinutes: autoScanMinutes }, 'Threat-intel auto-scan enabled');
  }

  let cliChannel: CLIChannel | null = null;
  const canStartInteractiveCli = !!process.stdin.isTTY && !!process.stdout.isTTY;

  if (config.channels.cli?.enabled && canStartInteractiveCli) {
    const enabledChannels: string[] = ['cli'];
    if (config.channels.web?.enabled) enabledChannels.push('web');
    if (config.channels.telegram?.enabled) enabledChannels.push('telegram');

    cliChannel = new CLIChannel({
      defaultAgent: config.channels.cli.defaultAgent ?? defaultAgentId,
      defaultUserId: 'cli',
      dashboard: dashboardCallbacks,
      version: '1.0.0',
      configPath,
      startupStatus: {
        guardianEnabled: config.guardian.enabled,
        providerName: config.defaultProvider,
        channels: enabledChannels,
        dashboardUrl: config.channels.web?.enabled
          ? `http://${config.channels.web.host ?? 'localhost'}:${config.channels.web.port ?? 3000}`
          : undefined,
        authToken: effectiveToken,
        warnings: toolExecutor.getRuntimeNotices().map((notice) => notice.message),
      },
      onAgents: () => runtime.registry.getAll().map(inst => ({
        id: inst.agent.id,
        name: inst.agent.name,
        state: inst.state,
        capabilities: inst.definition.grantedCapabilities,
        internal: router.findAgentByRole('local')?.id === inst.agent.id
          || router.findAgentByRole('external')?.id === inst.agent.id,
      })),
      onStatus: () => ({
        running: runtime.isRunning(),
        agentCount: runtime.registry.size,
        guardianEnabled: configRef.current.guardian.enabled,
        providers: [...runtime.providers.keys()],
      }),
    });
    await cliChannel.start(async (msg) => {
      const decision = resolveAgentWithTier(configRef.current.channels.cli?.defaultAgent, msg.content);
      if (dashboardCallbacks.onDispatch) {
        return dashboardCallbacks.onDispatch(
          decision.agentId,
          { content: msg.content, userId: msg.userId, channel: msg.channel },
          decision,
        );
      }
      return runtime.dispatchMessage(decision.agentId, msg);
    });
    channels.push({ name: 'cli', stop: () => cliChannel!.stop() });
  } else if (config.channels.cli?.enabled) {
    log.info({
      stdinIsTTY: !!process.stdin.isTTY,
      stdoutIsTTY: !!process.stdout.isTTY,
    }, 'CLI channel skipped because stdio is not interactive');
  }

  let activeTelegram: TelegramChannel | null = null;

  const startTelegram = async (): Promise<void> => {
    const tgConfig = configRef.current.channels.telegram;
    const botToken = resolveTelegramBotToken(configRef.current, secretStore);
    if (!tgConfig?.enabled || !botToken) return;
    const telegramDefaultAgent = tgConfig.defaultAgent ?? defaultAgentId;
    const telegram = new TelegramChannel({
      botToken,
      allowedChatIds: tgConfig.allowedChatIds,
      defaultAgent: telegramDefaultAgent,
      guideText: formatGuideForTelegram(),
      resolveCanonicalUserId: (channelUserId) => identity.resolveCanonicalUserId('telegram', channelUserId),
      onQuickAction: async ({ actionId, details, userId, channel, agentId }) => {
        if (!dashboardCallbacks.onQuickActionRun) {
          return { content: 'Quick actions are not available.' };
        }
        return dashboardCallbacks.onQuickActionRun({ actionId, details, userId, channel, agentId });
      },
      onThreatIntelSummary: dashboardCallbacks.onThreatIntelSummary
        ? () => dashboardCallbacks.onThreatIntelSummary!()
        : undefined,
      onThreatIntelScan: dashboardCallbacks.onThreatIntelScan
        ? (input) => dashboardCallbacks.onThreatIntelScan!(input)
        : undefined,
      onThreatIntelFindings: dashboardCallbacks.onThreatIntelFindings
        ? (args) => dashboardCallbacks.onThreatIntelFindings!(args)
        : undefined,
      onAnalyticsTrack: (event) => dashboardCallbacks.onAnalyticsTrack?.(event),
      onToolsApprovalDecision: dashboardCallbacks.onToolsApprovalDecision
        ? (input) => dashboardCallbacks.onToolsApprovalDecision!(input)
        : undefined,
      onDispatch: dashboardCallbacks.onDispatch
        ? (agentId, msg) => dashboardCallbacks.onDispatch!(agentId, msg)
        : undefined,
      onResetConversation: async ({ userId, agentId }) => {
        if (!dashboardCallbacks.onConversationReset) {
          return { success: false, message: 'Conversation reset is not available.' };
        }
        return dashboardCallbacks.onConversationReset({
          agentId: agentId ?? telegramDefaultAgent,
          userId,
          channel: 'telegram',
        });
      },
    });
    await telegram.start(async (msg) => {
      const decision = resolveAgentWithTier(configRef.current.channels.telegram?.defaultAgent, msg.content);
      if (dashboardCallbacks.onDispatch) {
        return dashboardCallbacks.onDispatch(
          decision.agentId,
          { content: msg.content, userId: msg.userId, channel: msg.channel },
          decision,
        );
      }
      return runtime.dispatchMessage(decision.agentId, msg);
    });
    activeTelegram = telegram;
    // Update channels array for graceful shutdown
    const idx = channels.findIndex(c => c.name === 'telegram');
    if (idx >= 0) channels[idx] = { name: 'telegram', stop: () => telegram.stop() };
    else channels.push({ name: 'telegram', stop: () => telegram.stop() });
  };

  dashboardCallbacks.onTelegramReload = async () => {
    try {
      if (activeTelegram) {
        await activeTelegram.stop();
        activeTelegram = null;
        log.info('Telegram channel stopped for reload');
      }
      await startTelegram();
      const tgConfig = configRef.current.channels.telegram;
      if (tgConfig?.enabled && resolveTelegramBotToken(configRef.current, secretStore)) {
        log.info('Telegram channel reloaded');
        return { success: true, message: 'Telegram channel reloaded.' };
      }
      log.info('Telegram channel disabled');
      return { success: true, message: 'Telegram channel disabled.' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Telegram reload failed');
      return { success: false, message: `Telegram reload failed: ${message}` };
    }
  };

  dashboardCallbacks.onCloudTest = async (providerKey: string, profileId: string) => {
    const runtimeCreds = resolveRuntimeCredentialView(configRef.current, secretStore);
    const cloud = runtimeCreds.resolvedCloud;
    if (!cloud) return { success: false, message: 'Cloud tools are not configured.' };

    try {
      switch (providerKey) {
        case 'cpanelProfiles': {
          const profile = cloud.cpanelProfiles?.find(p => p.id === profileId);
          if (!profile) return { success: false, message: `cPanel profile '${profileId}' not found.` };
          if (!profile.apiToken) return { success: false, message: `No credential resolved for cPanel profile '${profileId}'.` };
          const client = new CpanelClient(profile as unknown as ConstructorParameters<typeof CpanelClient>[0]);
          await client.whm('version');
          return { success: true, message: `cPanel profile '${profile.name}': connected.` };
        }
        case 'vercelProfiles': {
          const profile = cloud.vercelProfiles?.find(p => p.id === profileId);
          if (!profile) return { success: false, message: `Vercel profile '${profileId}' not found.` };
          if (!profile.apiToken) return { success: false, message: `No credential resolved for Vercel profile '${profileId}'.` };
          const client = new VercelClient(profile as unknown as ConstructorParameters<typeof VercelClient>[0]);
          await client.listProjects({ limit: 1 });
          return { success: true, message: `Vercel profile '${profile.name}': connected.` };
        }
        case 'cloudflareProfiles': {
          const profile = cloud.cloudflareProfiles?.find(p => p.id === profileId);
          if (!profile) return { success: false, message: `Cloudflare profile '${profileId}' not found.` };
          if (!profile.apiToken) return { success: false, message: `No credential resolved for Cloudflare profile '${profileId}'.` };
          const client = new CloudflareClient(profile as unknown as ConstructorParameters<typeof CloudflareClient>[0]);
          await client.verifyToken();
          return { success: true, message: `Cloudflare profile '${profile.name}': connected.` };
        }
        case 'awsProfiles': {
          const profile = cloud.awsProfiles?.find(p => p.id === profileId);
          if (!profile) return { success: false, message: `AWS profile '${profileId}' not found.` };
          if (!profile.accessKeyId && !profile.sessionToken) return { success: false, message: `No credential resolved for AWS profile '${profileId}'.` };
          const client = new AwsClient(profile as unknown as ConstructorParameters<typeof AwsClient>[0]);
          await client.getCallerIdentity();
          return { success: true, message: `AWS profile '${profile.name}': connected.` };
        }
        case 'gcpProfiles': {
          const profile = cloud.gcpProfiles?.find(p => p.id === profileId);
          if (!profile) return { success: false, message: `GCP profile '${profileId}' not found.` };
          if (!profile.accessToken && !profile.serviceAccountJson) return { success: false, message: `No credential resolved for GCP profile '${profileId}'.` };
          const client = new GcpClient(profile as unknown as ConstructorParameters<typeof GcpClient>[0]);
          await client.getProject();
          return { success: true, message: `GCP profile '${profile.name}': connected.` };
        }
        case 'azureProfiles': {
          const profile = cloud.azureProfiles?.find(p => p.id === profileId);
          if (!profile) return { success: false, message: `Azure profile '${profileId}' not found.` };
          if (!profile.accessToken && !profile.clientId) return { success: false, message: `No credential resolved for Azure profile '${profileId}'.` };
          const client = new AzureClient(profile as unknown as ConstructorParameters<typeof AzureClient>[0]);
          await client.getSubscription();
          return { success: true, message: `Azure profile '${profile.name}': connected.` };
        }
        default:
          return { success: false, message: `Unknown cloud provider: '${providerKey}'.` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Connection failed: ${message}` };
    }
  };

  try {
    await startTelegram();
  } catch (err) {
    log.error({ err }, 'Telegram channel failed to start — continuing without it');
    console.log('  Telegram: FAILED (check bot token) — other channels unaffected');
  }

  if (config.channels.web?.enabled) {
    if (!webAuthStateRef.current.token) {
      webAuthStateRef.current = {
        ...webAuthStateRef.current,
        token: generateSecureToken(),
        tokenSource: 'ephemeral',
      };
    }
    if (webAuthStateRef.current.tokenSource === 'ephemeral') {
      log.warn(
        {
          tokenPreview: webAuthStateRef.current.token ? previewTokenForLog(webAuthStateRef.current.token) : undefined,
          mode: webAuthStateRef.current.mode,
          host: config.channels.web.host ?? 'localhost',
          port: config.channels.web.port ?? 3000,
        },
        'No web auth token configured. Generated an ephemeral token for this run.',
      );
    }

    const web = new WebChannel({
      port: config.channels.web.port,
      host: config.channels.web.host,
      defaultAgent: config.channels.web.defaultAgent ?? defaultAgentId,
      auth: webAuthStateRef.current,
      authToken: webAuthStateRef.current.token,
      allowedOrigins: config.channels.web.allowedOrigins,
      maxBodyBytes: config.channels.web.maxBodyBytes,
      staticDir: join(__dirname, '..', 'web', 'public'),
      dashboard: dashboardCallbacks,
    });
    activeWebChannel = web;
    await web.start(async (msg) => {
      const decision = resolveAgentWithTier(configRef.current.channels.web?.defaultAgent, msg.content);
      if (dashboardCallbacks.onDispatch) {
        return dashboardCallbacks.onDispatch(
          decision.agentId,
          { content: msg.content, userId: msg.userId, channel: msg.channel },
          decision,
        );
      }
      return runtime.dispatchMessage(decision.agentId, msg);
    });
    channels.push({ name: 'web', stop: () => web.stop() });

    // Log the dashboard URL prominently
    const webUrl = `http://${config.channels.web.host ?? 'localhost'}:${config.channels.web.port ?? 3000}`;
    log.info({ url: webUrl }, 'Dashboard available at');
  }

  scheduledTasks.setAgentExecutor({
    runAgentTask: async (input) => {
      const requestedAgentId = input.agentId.trim();
      const resolvedAgentId = requestedAgentId === 'default' ? defaultAgentId : requestedAgentId;
      const channel = input.channel?.trim() || 'scheduled';
      const userId = input.userId?.trim() || configRef.current.assistant.identity.primaryUserId;
      const shouldDeliver = input.deliver ?? channel !== 'scheduled';

      const response = await jobTracker.run(
        {
          type: 'scheduled-agent-task',
          source: 'scheduled',
          detail: input.taskName,
          metadata: {
            taskId: input.taskId,
            agentId: resolvedAgentId,
            channel,
          },
        },
        async () => {
          if (!dashboardCallbacks.onDispatch) {
            throw new Error('Assistant dispatch is not available.');
          }
          return dashboardCallbacks.onDispatch(
            resolvedAgentId,
            { content: input.prompt, userId, channel },
            undefined,
            { priority: 'normal', requestType: 'scheduled_task' },
          );
        },
      );

      const deliveryText = `Scheduled assistant report: ${input.taskName}\n\n${response.content}`.trim();
      let deliveryMessage = 'Agent task completed.';
      const deliveryMeta: Record<string, unknown> = {
        attempted: false,
        delivered: false,
        channel,
      };

      if (shouldDeliver) {
        deliveryMeta.attempted = true;
        try {
          if (channel === 'cli') {
            if (!cliChannel) throw new Error('CLI channel is not available.');
            await cliChannel.send(configRef.current.assistant.identity.primaryUserId, deliveryText);
          } else if (channel === 'telegram') {
            const chatIds = configRef.current.channels.telegram?.allowedChatIds ?? [];
            if (!activeTelegram || chatIds.length === 0) {
              throw new Error('Telegram delivery is not configured.');
            }
            for (const chatId of chatIds) {
              await activeTelegram.send(String(chatId), deliveryText);
            }
          } else if (channel === 'web') {
            if (!activeWebChannel) throw new Error('Web channel is not available.');
            await activeWebChannel.send(configRef.current.assistant.identity.primaryUserId, deliveryText);
          } else {
            throw new Error(`Channel '${channel}' does not support scheduled delivery.`);
          }
          deliveryMeta.delivered = true;
          deliveryMessage = `Agent task completed and delivered to ${channel}.`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deliveryMeta.error = message;
          deliveryMessage = `Agent task completed, but delivery failed: ${message}`;
        }
      }

      return {
        success: true,
        status: 'succeeded',
        message: deliveryMessage,
        output: {
          content: response.content,
          metadata: response.metadata,
          delivery: deliveryMeta,
        },
      };
    },
  });

  const notificationService = new NotificationService({
    getConfig: () => configRef.current.assistant.notifications,
    auditLog: runtime.auditLog,
    eventBus: runtime.eventBus,
    senders: {
      sendCli: cliChannel
        ? async (text: string) => {
            await cliChannel!.send(configRef.current.assistant.identity.primaryUserId, text);
          }
        : undefined,
      sendTelegram: async (text: string) => {
        const chatIds = configRef.current.channels.telegram?.allowedChatIds ?? [];
        if (!activeTelegram || chatIds.length === 0) return;
        for (const chatId of chatIds) {
          await activeTelegram.send(String(chatId), text);
        }
      },
    },
  });
  notificationService.start();

  // Start runtime
  await runtime.start();

  if (config.assistant.hostMonitoring.enabled) {
    await runHostMonitoring('startup').catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Initial host monitoring check failed');
    });
    hostMonitorInterval = setInterval(() => {
      runHostMonitoring('interval').catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Host monitoring interval check failed');
      });
    }, Math.max(10, configRef.current.assistant.hostMonitoring.scanIntervalSec) * 1000);
  }

  if (config.assistant.gatewayMonitoring.enabled) {
    await runGatewayMonitoring('startup').catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Initial gateway monitoring check failed');
    });
    gatewayMonitorInterval = setInterval(() => {
      runGatewayMonitoring('interval').catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Gateway monitoring interval check failed');
      });
    }, Math.max(10, configRef.current.assistant.gatewayMonitoring.scanIntervalSec) * 1000);
  }

  // Migrate hardcoded playbook schedules into ScheduledTaskService
  {
    const playbookDefs = connectors.getState().playbooks;
    const migrated = scheduledTasks.migratePlaybookSchedules(playbookDefs);
    if (migrated > 0) {
      log.info({ migrated }, 'Migrated playbook schedules to ScheduledTaskService');
    }
  }

  // Post-start: AI greeting or setup wizard
  if (cliChannel) {
    const providers = dashboardCallbacks.onProvidersStatus
      ? await dashboardCallbacks.onProvidersStatus()
      : [];
    const providerReady = providers.some(
      (p: DashboardProviderInfo) => p.name === config.defaultProvider && p.connected,
    );

    cliChannel.postStart({
      providerReady,
      onGreeting: async () => {
        try {
          const response = await runtime.dispatchMessage(
            defaultAgentId,
            {
              id: randomUUID(),
              userId: 'system',
              channel: 'cli',
              content: 'You have just started up. Greet the user briefly — one short sentence to let them know you are online and ready.',
              timestamp: Date.now(),
            },
          );
          return response.content;
        } catch {
          return 'Guardian Agent is online and ready.';
        }
      },
      onSetupApply: dashboardCallbacks.onSetupApply!,
    });
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // prevent double-shutdown on repeated Ctrl+C
    shuttingDown = true;
    log.info({ signal }, 'Shutting down...');

    // Force exit after 5s if graceful cleanup stalls
    const forceExitTimer = setTimeout(() => {
      log.warn('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 5_000);
    forceExitTimer.unref();

    for (const channel of channels) {
      try {
        await channel.stop();
      } catch (err) {
        log.error({ channel: channel.name, err }, 'Error stopping channel');
      }
    }

    if (threatIntelInterval) {
      clearInterval(threatIntelInterval);
      threatIntelInterval = null;
    }
    if (hostMonitorInterval) {
      clearInterval(hostMonitorInterval);
      hostMonitorInterval = null;
    }
    if (gatewayMonitorInterval) {
      clearInterval(gatewayMonitorInterval);
      gatewayMonitorInterval = null;
    }

    if (mcpManager) {
      try {
        await mcpManager.disconnectAll();
      } catch (err) {
        log.error({ err }, 'Error disconnecting MCP servers');
      }
    }

    try {
      await toolExecutor.dispose();
    } catch (err) {
      log.error({ err }, 'Error disposing tool executor');
    }

    notificationService.stop();
    await runtime.stop();
    conversations.close();
    analytics.close();

    clearTimeout(forceExitTimer);
    process.exit(0);
  };

  // Killswitch: triggers graceful shutdown from CLI or web
  dashboardCallbacks.onKillswitch = () => {
    log.warn('Killswitch activated — shutting down all services');
    void shutdown('KILLSWITCH');
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  const fatalMessage = err instanceof Error
    ? (err.stack ?? err.message)
    : String(err);
  console.error(`Fatal startup error: ${fatalMessage}`);
  log.error({ err }, 'Fatal error');
  process.exit(1);
});
