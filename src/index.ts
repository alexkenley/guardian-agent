#!/usr/bin/env node
/**
 * Guardian Agent — Entry point.
 *
 * Load config → create Runtime → register agents → start channels →
 * handle SIGINT/SIGTERM for graceful shutdown.
 */

import { join, dirname, resolve, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { DEFAULT_CONFIG_PATH, loadConfig } from './config/loader.js';
import { resolvePreferredManagedCloudProviderType } from './config/managed-cloud-routing.js';
import { createBootstrapRuntimeContext } from './bootstrap/runtime-factory.js';
import { startBootstrapChannels, type BootstrapWebChannel } from './bootstrap/channel-startup.js';
import {
  createRuntimeNotificationService,
  runCliPostStart,
  startRuntimeSupportServices,
  wireScheduledAgentExecutor,
} from './bootstrap/service-wiring.js';
import { createShutdownHandler, type BootstrapChannelStopEntry } from './bootstrap/shutdown.js';
import type {
  AssistantConnectorPlaybookDefinition,
  BrowserConfig,
  GuardianAgentConfig,
  MCPServerEntry,
  RoutingTierMode,
  WebSearchConfig,
} from './config/types.js';
import yaml from 'js-yaml';
import { Runtime } from './runtime/runtime.js';
import { type WebAuthRuntimeConfig } from './channels/web.js';
import type {
  DashboardCallbacks,
  DashboardCodingBackendSession,
  DashboardMutationResult,
} from './channels/web-types.js';
import type { LLMConfig } from './config/types.js';
import { BaseAgent } from './agent/agent.js';
import { createAgentDefinition } from './agent/agent.js';
import { GuardianAgentService, SentinelAuditService } from './runtime/sentinel.js';
import type { OrchestrationRoleDescriptor } from './runtime/orchestration-role-descriptors.js';
import { createPolicyEngine, loadPolicyFiles, ShadowEvaluator } from './policy/index.js';
import type { PolicyModeConfig } from './policy/index.js';
import {
  isSecurityBaselineDisabled,
  previewSecurityBaselineViolations,
  type SecurityBaselineViolation,
} from './guardian/security-baseline.js';
import { ControlPlaneIntegrity } from './guardian/control-plane-integrity.js';
import { createLogger } from './util/logging.js';
import { writeSecureFileSync } from './util/secure-fs.js';
import { ConversationService, type ConversationKey } from './runtime/conversation.js';
import { CodeSessionStore, type CodeSessionRecord } from './runtime/code-sessions.js';
import { deriveCodeSessionWorkflowState } from './runtime/coding-workflows.js';
import { SecondBrainStore } from './runtime/second-brain/second-brain-store.js';
import { SecondBrainService } from './runtime/second-brain/second-brain-service.js';
import { BriefingService } from './runtime/second-brain/briefing-service.js';
import { SyncService } from './runtime/second-brain/sync-service.js';
import { HorizonScanner } from './runtime/second-brain/horizon-scanner.js';
import { createSecondBrainRoutineNotifier } from './runtime/second-brain/routine-notifier.js';
import { CodeWorkspaceNativeProtectionScanner } from './runtime/code-workspace-native-protection.js';
import { inspectCodeWorkspaceSync } from './runtime/code-workspace-profile.js';
import {
  buildCodeWorkspaceMapSync,
  shouldRefreshCodeWorkspaceMap,
} from './runtime/code-workspace-map.js';
import { resolveManagedPlaywrightLaunch } from './runtime/playwright-launch.js';
import { CodingBackendService } from './runtime/coding-backend-service.js';
import { listRemoteExecutionTargets } from './runtime/remote-execution/policy.js';
import {
  assessCodeWorkspaceTrustSync,
  getEffectiveCodeWorkspaceTrustState,
  shouldRefreshCodeWorkspaceTrust,
} from './runtime/code-workspace-trust.js';
import { CodeWorkspaceTrustService } from './runtime/code-workspace-trust-service.js';
import { PackageInstallNativeProtectionScanner } from './runtime/package-install-native-protection.js';
import { PackageInstallTrustService } from './runtime/package-install-trust-service.js';
import { getReferenceGuide, formatGuideForTelegram } from './reference-guide.js';
import type { LLMProvider } from './llm/types.js';
import { IdentityService } from './runtime/identity.js';
import { AnalyticsService } from './runtime/analytics.js';
import { getQuickActions } from './quick-actions.js';
import { AiSecurityService, createAiSecuritySessionSnapshot } from './runtime/ai-security.js';
import { ThreatIntelService } from './runtime/threat-intel.js';
import { createThreatIntelSourceScanners } from './runtime/threat-intel-osint.js';
import { pickNativeSearchPath } from './runtime/native-path-picker.js';
import {
  ConnectorPlaybookService,
  type ConnectorPlaybookRunInput,
  type ConnectorPlaybookRunResult,
  type PlaybookRunRecord,
  type PlaybookStepRunResult,
} from './runtime/connectors.js';
import { JsonFileRunStateStore } from './runtime/run-state-store.js';
import {
  listBuiltinAutomationExamples,
  materializeAllBuiltinAutomationExamples,
  materializeBuiltinAutomationExample,
} from './runtime/builtin-packs.js';
import { DeviceInventoryService } from './runtime/device-inventory.js';
import { NetworkBaselineService, type NetworkAnomalyReport } from './runtime/network-baseline.js';
import { NetworkTrafficService } from './runtime/network-traffic.js';
import { HostMonitoringService, type HostMonitorReport } from './runtime/host-monitor.js';
import { GatewayFirewallMonitoringService, type GatewayMonitorReport } from './runtime/gateway-monitor.js';
import {
  availableSecurityAlertSources,
  collectUnifiedSecurityAlerts,
} from './runtime/security-alerts.js';
import {
  DEFAULT_ASSISTANT_SECURITY_MONITORING_CRON,
  DEFAULT_ASSISTANT_SECURITY_MONITORING_PROFILE,
  DEFAULT_DEPLOYMENT_PROFILE,
  DEFAULT_SECURITY_OPERATING_MODE,
  DEFAULT_SECURITY_TRIAGE_LLM_PROVIDER,
} from './runtime/security-controls.js';
import { buildChatProviderSelectorOptions } from './runtime/chat-provider-selection.js';
import { ContainmentService } from './runtime/containment-service.js';
import { assessSecurityPosture } from './runtime/security-posture.js';
import { SecurityActivityLogService } from './runtime/security-activity-log.js';
import {
  DEFAULT_SECURITY_TRIAGE_SYSTEM_PROMPT,
  SECURITY_TRIAGE_AGENT_ID,
  SECURITY_TRIAGE_DISPATCHER_AGENT_ID,
  SecurityEventTriageAgent,
} from './runtime/security-triage-agent.js';
import { WindowsDefenderProvider } from './runtime/windows-defender-provider.js';
import {
  ScheduledTaskService,
  type ScheduledTaskDefinition,
  type ScheduledTaskRunResult,
} from './runtime/scheduled-tasks.js';
import { createAutomationRuntimeService } from './runtime/automation-runtime-service.js';
import { MoltbookConnector } from './runtime/moltbook-connector.js';
import { AssistantOrchestrator } from './runtime/orchestrator.js';
import {
  AgentMemoryStore,
  classifyMemoryEntrySource,
  type MemorySourceType,
  type MemoryStatus,
  type MemoryTrustLevel,
  type StoredMemoryEntry,
} from './runtime/agent-memory-store.js';
import { AssistantJobTracker } from './runtime/assistant-jobs.js';
import { RunTimelineStore } from './runtime/run-timeline.js';
import { ExecutionGraphStore } from './runtime/execution-graph/graph-store.js';
import { normalizeAutomationOutputHandling, promoteAutomationFindings } from './runtime/automation-output.js';
import { AutomationOutputStore } from './runtime/automation-output-store.js';
import { AutomationOutputPersistenceService } from './runtime/automation-output-persistence.js';
import {
  buildMemoryFlushEntry,
  buildMemoryFlushMaintenanceMetadata,
  describeMemoryFlushFailureDetail,
  describeMemoryFlushDeduplicatedDetail,
  describeMemoryFlushMaintenanceDetail,
  describeMemoryFlushSkipDetail,
  inferMemoryFlushScope,
} from './runtime/memory-flush.js';
import { MemoryMutationService } from './runtime/memory-mutation-service.js';
import { AutomatedMaintenanceService } from './runtime/automated-maintenance-service.js';
import {
  IntentGateway,
  type IntentGatewayRecord,
} from './runtime/intent-gateway.js';
import {
  createIncomingDispatchPreparer,
  type IncomingDispatchMessage,
} from './runtime/incoming-dispatch.js';
import { createDashboardMessageDispatcher } from './runtime/dashboard-dispatch.js';
import { createConfigPersistenceService } from './runtime/control-plane/config-persistence-service.js';
import { persistRoutingTierModeInRawConfig } from './config/routing-mode-persistence.js';
import { createAgentDashboardCallbacks } from './runtime/control-plane/agent-dashboard-callbacks.js';
import { createAssistantDashboardCallbacks } from './runtime/control-plane/assistant-dashboard-callbacks.js';
import { createConfigStateHelpers } from './runtime/control-plane/config-state-helpers.js';
import { createAuthControlCallbacks } from './runtime/control-plane/auth-control-callbacks.js';
import { createDirectConfigUpdateHandler } from './runtime/control-plane/direct-config-update.js';
import { createGovernanceDashboardCallbacks } from './runtime/control-plane/governance-dashboard-callbacks.js';
import { createOperationsDashboardCallbacks } from './runtime/control-plane/operations-dashboard-callbacks.js';
import { createPerformanceAdapter } from './runtime/performance-adapters/index.js';
import { PerformanceService } from './runtime/performance-service.js';
import { createPerformanceDashboardCallbacks } from './runtime/control-plane/performance-dashboard-callbacks.js';
import { createProviderDashboardCallbacks } from './runtime/control-plane/provider-dashboard-callbacks.js';
import { createProviderConfigHelpers } from './runtime/control-plane/provider-config-helpers.js';
import { createProviderIntegrationCallbacks } from './runtime/control-plane/provider-integration-callbacks.js';
import { syncLiveToolPolicyFromConfig } from './runtime/control-plane/tool-policy-runtime-sync.js';
import {
  createCloudConnectionTesters,
  createGwsCliProbe,
} from './runtime/control-plane/provider-runtime-adapters.js';
import { createDashboardRuntimeCallbacks } from './runtime/control-plane/dashboard-runtime-callbacks.js';
import { createSecurityDashboardCallbacks } from './runtime/control-plane/security-dashboard-callbacks.js';
import { createSetupConfigDashboardCallbacks } from './runtime/control-plane/setup-config-dashboard-callbacks.js';
import { createToolsDashboardCallbacks } from './runtime/control-plane/tools-dashboard-callbacks.js';
import { createWorkspaceDashboardCallbacks } from './runtime/control-plane/workspace-dashboard-callbacks.js';
import {
  DEFAULT_CODING_BACKENDS_CONFIG,
  computeCategoryDefaults,
  isRecord,
  mergeCloudConfigForValidation,
  readCodeRequestMetadata,
  readMessageSurfaceId,
  redactConfig,
  resolveToolProviderRouting,
  sanitizeNormalizedUrlRecord,
} from './chat-agent-helpers.js';
import { createChatAgentClass } from './chat-agent.js';

let syncAssistantSecurityMonitoringTask: () => void = () => {};
import { ToolExecutor } from './tools/executor.js';
import type { ToolExecutorOptions } from './tools/executor.js';
import type { ToolExecutionRequest } from './tools/types.js';
import { MCPClientManager, assessMcpStartupAdmission } from './tools/mcp-client.js';
import type { MCPServerConfig } from './tools/mcp-client.js';
import { MessageRouter, type RouteDecision } from './runtime/message-router.js';
import { resolveAgentStateId, SHARED_TIER_AGENT_STATE_ID } from './runtime/agent-state-context.js';
import { normalizeCodeSessionAgentId, resolveConfiguredAgentId } from './runtime/agent-target-resolution.js';
import {
  clearApprovalIdFromPendingAction,
  PendingActionStore,
  reconcilePendingApprovalAction,
  summarizePendingActionForGateway,
} from './runtime/pending-actions.js';
import { shouldContinueConversationAfterApprovalDecision } from './runtime/approval-continuations.js';
import {
  ContinuityThreadStore,
  summarizeContinuityThreadForGateway,
} from './runtime/continuity-threads.js';
import { ExecutionStore } from './runtime/executions.js';
import { resolveTelegramDeliveryChatIds } from './runtime/telegram-delivery.js';
import { IntentRoutingTraceLog } from './runtime/intent-routing-trace.js';
import type { SQLiteSecurityEvent } from './runtime/sqlite-security.js';
import { ModelFallbackChain } from './llm/model-fallback.js';
import { TRUST_PRESETS, type TrustPresetName } from './guardian/trust-presets.js';
import type { Capability } from './guardian/capabilities.js';
import { createProviders, getProviderRegistry } from './llm/provider.js';
import {
  getProviderLocality as getProviderConfiguredLocality,
  getProviderTier,
  providerRequiresCredential,
} from './llm/provider-metadata.js';
import { detectCapabilities as detectSandboxCapabilities, detectSandboxHealth, DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from './sandbox/index.js';
import {
  isDegradedSandboxFallbackActive,
  isStrictSandboxLockdown,
  listEnabledDegradedFallbackAllowances,
  resolveDegradedFallbackConfig,
} from './sandbox/security-controls.js';
import { SkillRegistry } from './skills/registry.js';
import { SkillResolver } from './skills/resolver.js';
import { resolveRuntimeCredentialView } from './runtime/credentials.js';
import { LocalSecretStore } from './runtime/secret-store.js';
import { WorkerManager } from './supervisor/worker-manager.js';
import { resolveConversationSurfaceId } from './runtime/channel-surface-ids.js';
import { isToolReportQuery as _isToolReportQuery, formatToolReport as _formatToolReport } from './util/tool-report.js';

import { getGuardianBaseDir } from './util/env.js';

const log = createLogger('main');
let sharedCodeWorkspaceTrustService: CodeWorkspaceTrustService | undefined;

function getCodeSessionSurfaceId(args: { channel?: string; surfaceId?: string; userId?: string; principalId?: string }): string {
  return resolveConversationSurfaceId({
    channel: args.channel,
    surfaceId: args.surfaceId,
    userId: args.userId,
  });
}

function normalizeTierModeForRouter(
  router: MessageRouter,
  config: GuardianAgentConfig,
  mode: RoutingTierMode | undefined,
): RoutingTierMode {
  const availableModes = new Set(buildAvailableRoutingModes(router, config));
  const normalizedMode = mode ?? 'auto';
  return availableModes.has(normalizedMode) ? normalizedMode : 'auto';
}
let sharedPackageInstallTrustService: PackageInstallTrustService | undefined;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function generateSecureToken(byteLength = 16): string {
  return randomBytes(byteLength).toString('hex');
}

function previewTokenForLog(token: string): string {
  if (token.length <= 8) return token;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

const ChatAgent = createChatAgentClass({
  log,
});
type ChatAgentInstance = InstanceType<typeof ChatAgent>;

function isLocalProviderEndpoint(_baseUrl: string | undefined, providerType: string | undefined): boolean {
  return getProviderConfiguredLocality(providerType) === 'local';
}

function getProviderLocality(
  llmCfg: Pick<LLMConfig, 'provider' | 'baseUrl'> | undefined,
): 'local' | 'external' | undefined {
  if (!llmCfg?.provider) return undefined;
  return getProviderConfiguredLocality(llmCfg.provider);
}

function providerMatchesTier(
  llmCfg: Pick<LLMConfig, 'enabled' | 'provider' | 'baseUrl'> | undefined,
  tier: 'local' | 'managed_cloud' | 'frontier',
): boolean {
  if (!llmCfg?.provider || llmCfg.enabled === false) return false;
  if (tier === 'local') {
    return getProviderLocality(llmCfg) === 'local';
  }
  return getProviderTier(llmCfg.provider) === tier;
}

function getPreferredProviderKeyForTier(
  tier: 'local' | 'managed_cloud' | 'frontier',
): 'local' | 'managedCloud' | 'frontier' {
  if (tier === 'local') return 'local';
  if (tier === 'managed_cloud') return 'managedCloud';
  return 'frontier';
}

function findProviderByTier(
  cfg: GuardianAgentConfig,
  tier: 'local' | 'managed_cloud' | 'frontier',
): string | null {
  const preferredProviders = cfg.assistant.tools.preferredProviders ?? {};
  const preferredKey = getPreferredProviderKeyForTier(tier);
  const preferred = preferredProviders[preferredKey]?.trim();
  if (preferred && providerMatchesTier(cfg.llm[preferred], tier)) {
    return preferred;
  }

  if (tier !== 'local' && !preferred) {
    const legacyExternal = preferredProviders.external?.trim();
    if (legacyExternal && providerMatchesTier(cfg.llm[legacyExternal], tier)) {
      return legacyExternal;
    }
  }

  if (providerMatchesTier(cfg.llm[cfg.defaultProvider], tier)) {
    return cfg.defaultProvider;
  }

  const matches = Object.entries(cfg.llm)
    .filter(([, llmCfg]) => providerMatchesTier(llmCfg, tier))
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));

  return matches[0]?.[0] ?? null;
}

function buildAutoFallbackOrder(config: GuardianAgentConfig): string[] {
  const defaultName = config.defaultProvider;
  const defaultTier = getProviderTier(config.llm[defaultName]?.provider) ?? 'frontier';
  const remaining = Object.keys(config.llm).filter((name) => name !== defaultName);
  const preferredTierOrder: Array<'local' | 'managed_cloud' | 'frontier'> = defaultTier === 'local'
    ? ['managed_cloud', 'frontier', 'local']
    : defaultTier === 'managed_cloud'
      ? ['frontier', 'local', 'managed_cloud']
      : ['managed_cloud', 'local', 'frontier'];

  remaining.sort((left, right) => {
    const leftTier = getProviderTier(config.llm[left]?.provider) ?? 'frontier';
    const rightTier = getProviderTier(config.llm[right]?.provider) ?? 'frontier';
    const leftRank = preferredTierOrder.indexOf(leftTier);
    const rightRank = preferredTierOrder.indexOf(rightTier);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right);
  });

  return [defaultName, ...remaining];
}

function findProviderByLocality(
  cfg: GuardianAgentConfig,
  locality: 'local' | 'external',
): string | null {
  if (locality === 'local') {
    return findProviderByTier(cfg, 'local');
  }
  return findProviderByTier(cfg, 'managed_cloud')
    ?? findProviderByTier(cfg, 'frontier');
}

function findProviderForRoutingMode(
  cfg: GuardianAgentConfig,
  mode: RoutingTierMode,
): string | null {
  if (mode === 'managed-cloud-only') {
    return findProviderByTier(cfg, 'managed_cloud')
      ?? findProviderByTier(cfg, 'frontier');
  }
  if (mode === 'frontier-only') {
    return findProviderByTier(cfg, 'frontier')
      ?? findProviderByTier(cfg, 'managed_cloud');
  }
  return findProviderByLocality(cfg, 'external');
}

function buildAvailableRoutingModes(
  router: MessageRouter,
  cfg: GuardianAgentConfig,
): RoutingTierMode[] {
  const modes: RoutingTierMode[] = ['auto'];
  if (router.findAgentByRole('local') && findProviderByTier(cfg, 'local')) {
    modes.push('local-only');
  }
  if (router.findAgentByRole('external') && findProviderByTier(cfg, 'managed_cloud')) {
    modes.push('managed-cloud-only');
  }
  if (router.findAgentByRole('external') && findProviderByTier(cfg, 'frontier')) {
    modes.push('frontier-only');
  }
  return modes;
}

function formatRoutingModeLabel(mode: RoutingTierMode): string {
  if (mode === 'local-only') return 'local';
  if (mode === 'managed-cloud-only') return 'managed cloud';
  if (mode === 'frontier-only') return 'frontier';
  return 'auto';
}

function resolveSecurityTriageProviderName(cfg: GuardianAgentConfig): string {
  const mode = cfg.assistant.security?.triageLlmProvider ?? DEFAULT_SECURITY_TRIAGE_LLM_PROVIDER;
  if (mode === 'local') {
    return findProviderByLocality(cfg, 'local') ?? cfg.defaultProvider;
  }
  if (mode === 'external') {
    return findProviderByLocality(cfg, 'external') ?? cfg.defaultProvider;
  }
  return findProviderByLocality(cfg, 'local')
    ?? findProviderByLocality(cfg, 'external')
    ?? cfg.defaultProvider;
}

function bindSecurityTriageProvider(runtime: Runtime, cfg: GuardianAgentConfig): void {
  const triageInstance = runtime.registry.get(SECURITY_TRIAGE_AGENT_ID);
  if (!triageInstance) return;
  const providerName = resolveSecurityTriageProviderName(cfg);
  triageInstance.definition.providerName = providerName;
  triageInstance.provider = runtime.getProvider(providerName);
}

function bindTierRoutingProviders(runtime: Runtime, router: MessageRouter, cfg: GuardianAgentConfig): void {
  const localAgentId = router.findAgentByRole('local')?.id;
  const externalAgentId = router.findAgentByRole('external')?.id;
  if (localAgentId) {
    runtime.rebindAgentProvider(localAgentId, findProviderByLocality(cfg, 'local') ?? undefined);
  }
  if (externalAgentId) {
    const normalizedMode = normalizeTierModeForRouter(router, cfg, cfg.routing?.tierMode);
    runtime.rebindAgentProvider(externalAgentId, findProviderForRoutingMode(cfg, normalizedMode) ?? undefined);
  }
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

async function settleTerminalForExit(): Promise<void> {
  const stdin = process.stdin as NodeJS.ReadStream & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    try {
      stdin.setRawMode(false);
    } catch {
      // Ignore terminal restoration failures during shutdown.
    }
  }
  stdin.pause?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
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

const probeGwsCli = createGwsCliProbe(log);
const cloudConnectionTesters = createCloudConnectionTesters();

function resolveTelegramBotToken(config: GuardianAgentConfig, secretStore: LocalSecretStore): string | undefined {
  const runtimeCredentials = resolveRuntimeCredentialView(config, secretStore);
  const refName = config.channels.telegram?.botTokenCredentialRef?.trim();
  if (refName) {
    return runtimeCredentials.credentialProvider.resolve(refName);
  }
  const direct = config.channels.telegram?.botToken?.trim();
  return direct || undefined;
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

/** Build dashboard callbacks wired to runtime internals. */
function buildDashboardCallbacks(
  runtime: Runtime,
  configRef: { current: GuardianAgentConfig },
  threatIntelWebSearchConfigRef: { current: WebSearchConfig | undefined },
  secretStore: LocalSecretStore,
  conversations: ConversationService,
  identity: IdentityService,
  analytics: AnalyticsService,
  runTimeline: RunTimelineStore,
  refreshRunTimelineSnapshots: () => void,
  orchestrator: AssistantOrchestrator,
  intentRoutingTrace: IntentRoutingTraceLog,
  jobTracker: AssistantJobTracker,
  aiSecurity: AiSecurityService,
  runAssistantSecurityScan: (input: {
    profileId?: string;
    targetIds?: string[];
    source?: 'manual' | 'scheduled' | 'system';
    requestedBy?: string;
  }) => Promise<Awaited<ReturnType<AiSecurityService['scan']>>>,
  threatIntel: ThreatIntelService,
  connectors: ConnectorPlaybookService,
  toolExecutor: ToolExecutor,
  applyBrowserRuntimeConfig: (browserConfig: BrowserConfig | undefined) => Promise<{ success: boolean; message: string }>,
  agentMemoryStore: AgentMemoryStore,
  codeSessionMemoryStore: AgentMemoryStore,
  codeSessionStore: CodeSessionStore,
  secondBrainService: SecondBrainService,
  secondBrainSyncService: SyncService,
  performanceService: PerformanceService,
  secondBrainBriefingService: BriefingService,
  persistMemoryEntry: (input: {
    target: {
      scope: 'global' | 'code_session';
      scopeId: string;
      store: AgentMemoryStore;
      auditAgentId: string;
    };
    intent: 'assistant_save' | 'operator_curate' | 'context_flush';
    entry: import('./runtime/agent-memory-store.js').MemoryEntry;
    actor?: string;
    existingEntryId?: string;
    runMaintenance?: boolean;
  }) => import('./runtime/memory-mutation-service.js').PersistMemoryEntryResult,
  runMemoryMaintenanceForScope: (input: import('./runtime/memory-mutation-service.js').RunMemoryScopeMaintenanceInput) => import('./runtime/memory-mutation-service.js').MemoryScopeHygieneResult,
  chatAgents: Map<string, ChatAgentInstance>,
  skillRegistry: SkillRegistry | undefined,
  enabledManagedProviders: Set<string>,
  webAuthStateRef: { current: WebAuthRuntimeConfig },
  applyWebAuthRuntime: (auth: WebAuthRuntimeConfig) => void,
  configPath: string,
  controlPlaneIntegrity: ControlPlaneIntegrity,
  router: MessageRouter,
  deviceInventory: DeviceInventoryService,
  networkBaseline: NetworkBaselineService,
  hostMonitor: HostMonitoringService,
  runHostMonitoring: (source: string) => Promise<HostMonitorReport>,
  gatewayMonitor: GatewayFirewallMonitoringService,
  runGatewayMonitoring: (source: string) => Promise<GatewayMonitorReport>,
  windowsDefender: WindowsDefenderProvider,
  runWindowsDefenderRefresh: (source: string) => Promise<import('./runtime/windows-defender-provider.js').WindowsDefenderProviderStatus>,
  containmentService: ContainmentService,
  securityActivityLog: SecurityActivityLogService,
  getSecurityContainmentInputs: () => {
    profile: 'personal' | 'home' | 'organization';
    currentMode: 'monitor' | 'guarded' | 'lockdown' | 'ir_assist';
    alerts: ReturnType<typeof collectUnifiedSecurityAlerts>;
    posture: ReturnType<typeof assessSecurityPosture>;
  },
  runNetworkAnalysis: (source: string) => NetworkAnomalyReport,
  guardianAgentService: GuardianAgentService,
  sentinelAuditService: SentinelAuditService,
  policyState: PolicyState,
  googleAuthRef: { current: import('./google/google-auth.js').GoogleAuth | null },
  googleServiceRef: { current: import('./google/google-service.js').GoogleService | null },
  microsoftAuthRef: { current: import('./microsoft/microsoft-auth.js').MicrosoftAuth | null },
  microsoftServiceRef: { current: import('./microsoft/microsoft-service.js').MicrosoftService | null },
  toolExecutorRef: { current: import('./tools/executor.js').ToolExecutor | null },
  pendingActionStore: PendingActionStore,
  codingBackendServiceRef: { current: CodingBackendService | null },
  prepareIncomingDispatch: (
    channelDefault: string | undefined,
    msg: IncomingDispatchMessage,
  ) => Promise<{
    decision: RouteDecision;
    gateway: IntentGatewayRecord | null;
    routedMessage: IncomingDispatchMessage;
  }>,
): DashboardCallbacks & {
  connectorWorkflowOps: {
    upsert: (playbook: AssistantConnectorPlaybookDefinition) => { success: boolean; message: string };
    delete: (playbookId: string) => { success: boolean; message: string };
    run: (input: {
      playbookId: string;
      dryRun?: boolean;
      origin?: 'assistant' | 'cli' | 'web';
      agentId?: string;
      userId?: string;
      channel?: string;
      requestedBy?: string;
    }) => Promise<ConnectorPlaybookRunResult>;
  };
  telegramReloadRef: { current: (() => Promise<{ success: boolean; message: string }>) | null };
  reloadSearchRef: { current: (() => Promise<{ success: boolean; message: string }>) | null };
  listConfiguredLlmProviders: () => Promise<Array<{
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
  listModelsForConfiguredLlmProvider: (providerName: string) => Promise<string[]>;
  applyDirectLlmProviderConfigUpdate: (updates: import('./channels/web-types.js').ConfigUpdate) => Promise<DashboardMutationResult>;
} {
  const summarizeMemoryText = (value: string | undefined, maxChars = 160): string => {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > maxChars
      ? `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
      : normalized;
  };
  const slugifyMemoryTitle = (value: string): string => {
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return normalized || 'memory-page';
  };
  const getPrincipalMemoryAgentId = (): string => (
    configRef.current.channels.web?.defaultAgent
      ?? configRef.current.channels.cli?.defaultAgent
      ?? configRef.current.agents[0]?.id
      ?? 'default'
  );
  const inferMemoryEntryTitle = (entry: StoredMemoryEntry): string => (
    entry.artifact?.title?.trim()
      || summarizeMemoryText(entry.summary, 72)
      || summarizeMemoryText(entry.content, 72)
      || entry.category?.trim()
      || 'Memory entry'
  );
  const parseIsoDateMs = (value: string | undefined): number | null => {
    const parsed = Date.parse(value ?? '');
    return Number.isFinite(parsed) ? parsed : null;
  };
  const isOlderThanDays = (value: string | undefined, days: number): boolean => {
    const parsed = parseIsoDateMs(value);
    return parsed != null && parsed <= (Date.now() - days * 24 * 60 * 60 * 1000);
  };
  const isDecisionLikeEntry = (entry: StoredMemoryEntry): boolean => /decision|constraint|instruction|runbook/i.test([
    entry.category,
    entry.artifact?.title,
    Array.isArray(entry.tags) ? entry.tags.join(' ') : '',
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' '));
  const toDashboardMemoryEntryView = (entry: StoredMemoryEntry) => {
    const sourceClass = classifyMemoryEntrySource(entry);
    return {
      ...entry,
      displayTitle: inferMemoryEntryTitle(entry),
      sourceClass,
      editable: sourceClass === 'operator_curated',
      reviewOnly: entry.status !== 'active',
    };
  };
  const buildMemorySummary = (entries: StoredMemoryEntry[]) => ({
    activeEntries: entries.filter((entry) => entry.status === 'active').length,
    inactiveEntries: entries.filter((entry) => entry.status !== 'active').length,
    quarantinedEntries: entries.filter((entry) => entry.status === 'quarantined').length,
    operatorEntries: entries.filter((entry) => classifyMemoryEntrySource(entry) === 'operator_curated').length,
    derivedEntries: entries.filter((entry) => classifyMemoryEntrySource(entry) === 'derived').length,
    contextFlushEntries: entries.filter((entry) => entry.tags?.includes('context_flush')).length,
    categories: [...new Set(entries.map((entry) => entry.category?.trim() || 'General'))].sort((left, right) => left.localeCompare(right)),
    lastCreatedAt: entries.reduce<string | undefined>((latest, entry) => {
      if (!entry.createdAt) return latest;
      return !latest || entry.createdAt > latest ? entry.createdAt : latest;
    }, undefined),
  });
  const buildMemoryLintRelatedEntries = (entries: StoredMemoryEntry[], entryIds: string[] | undefined) => {
    if (!Array.isArray(entryIds) || entryIds.length === 0) {
      return [];
    }
    const entryById = new Map(entries.map((entry) => [entry.id, entry] as const));
    return entryIds
      .map((entryId) => entryById.get(entryId))
      .filter((entry): entry is StoredMemoryEntry => Boolean(entry))
      .slice(0, 6)
      .map((entry) => {
        const sourceClass = classifyMemoryEntrySource(entry);
        return {
          id: entry.id,
          title: inferMemoryEntryTitle(entry),
          sourceClass,
          status: entry.status ?? 'active',
          reviewOnly: entry.status !== 'active',
          editable: sourceClass === 'operator_curated' && entry.status === 'active',
        };
      });
  };
  const matchesMemoryFilters = (
    entry: StoredMemoryEntry,
    filter: {
      query?: string;
      sourceType?: MemorySourceType;
      trustLevel?: MemoryTrustLevel;
      status?: MemoryStatus;
    },
  ): boolean => {
    if (filter.sourceType && entry.sourceType !== filter.sourceType) return false;
    if (filter.trustLevel && entry.trustLevel !== filter.trustLevel) return false;
    if (filter.status && entry.status !== filter.status) return false;
    const normalizedQuery = filter.query?.trim().toLowerCase();
    if (!normalizedQuery) return true;
    const haystack = [
      entry.content,
      entry.summary,
      entry.category,
      entry.artifact?.title,
      Array.isArray(entry.artifact?.retrievalHints) ? entry.artifact.retrievalHints.join(' ') : '',
      Array.isArray(entry.tags) ? entry.tags.join(' ') : '',
      entry.createdByPrincipal,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  };
  const buildMemoryWikiPages = (
    scope: 'global' | 'code_session',
    scopeId: string,
    entries: StoredMemoryEntry[],
    query?: string,
  ) => {
    const normalizedQuery = query?.trim().toLowerCase();
    const activeEntries = entries.filter((entry) => entry.status === 'active');
    const operatorEntries = activeEntries.filter((entry) => classifyMemoryEntrySource(entry) === 'operator_curated');
    const linkedOutputEntries = activeEntries.filter((entry) => classifyMemoryEntrySource(entry) === 'linked_output');
    const decisionEntries = activeEntries.filter((entry) => isDecisionLikeEntry(entry));
    const contextFlushEntries = activeEntries.filter((entry) => entry.tags?.includes('context_flush'));
    const reviewOnlyEntries = entries.filter((entry) => entry.status !== 'active');
    const categoryLines = [...new Map(
      activeEntries.map((entry) => [
        entry.category?.trim() || 'General',
        {
          category: entry.category?.trim() || 'General',
          count: activeEntries.filter((candidate) => (candidate.category?.trim() || 'General') === (entry.category?.trim() || 'General')).length,
        },
      ]),
    ).values()]
      .sort((left, right) => left.category.localeCompare(right.category))
      .map((item) => `- ${item.category}: ${item.count} active entr${item.count === 1 ? 'y' : 'ies'}`);
    const pages = [
      ...(categoryLines.length > 0 ? [{
        id: `${scopeId}:topic-index`,
        scope,
        scopeId,
        title: 'Topic Index',
        slug: 'topic-index',
        kind: 'topic_index' as const,
        sourceClass: 'derived' as const,
        editable: false,
        reviewOnly: false,
        status: 'active' as const,
        summary: `Summarizes ${categoryLines.length} category buckets across active durable memory.`,
        body: categoryLines.join('\n'),
        renderedMarkdown: ['# Topic Index', '', ...categoryLines].join('\n'),
        tags: ['derived', 'topics'],
        createdAt: buildMemorySummary(entries).lastCreatedAt,
      }] : []),
      ...operatorEntries.map((entry) => {
        const title = inferMemoryEntryTitle(entry);
        const body = entry.content.trim();
        return {
          id: `${scopeId}:curated:${entry.id}`,
          entryId: entry.id,
          scope,
          scopeId,
          title,
          slug: entry.artifact?.slug || slugifyMemoryTitle(title),
          kind: 'curated_page' as const,
          sourceClass: 'operator_curated' as const,
          editable: true,
          reviewOnly: false,
          status: entry.status ?? 'active',
          summary: summarizeMemoryText(entry.summary, 140) || summarizeMemoryText(body, 140),
          body,
          renderedMarkdown: [`# ${title}`, '', body].filter(Boolean).join('\n'),
          tags: entry.tags ?? [],
          createdAt: entry.createdAt,
          updatedAt: entry.artifact?.updatedAt,
          createdByPrincipal: entry.createdByPrincipal,
          reason: entry.artifact?.changeReason,
        };
      }),
      ...(decisionEntries.length > 0 ? [{
        id: `${scopeId}:decisions`,
        scope,
        scopeId,
        title: 'Decisions And Constraints',
        slug: 'decisions-and-constraints',
        kind: 'decision_index' as const,
        sourceClass: 'derived' as const,
        editable: false,
        reviewOnly: false,
        status: 'active' as const,
        summary: `${decisionEntries.length} active decision-oriented memor${decisionEntries.length === 1 ? 'y' : 'ies'}.`,
        body: decisionEntries.map((entry) => `- ${inferMemoryEntryTitle(entry)} (${entry.createdAt})`).join('\n'),
        renderedMarkdown: ['# Decisions And Constraints', '', ...decisionEntries.map((entry) => `- ${inferMemoryEntryTitle(entry)} (${entry.createdAt})`)].join('\n'),
        tags: ['derived', 'decisions'],
        createdAt: buildMemorySummary(decisionEntries).lastCreatedAt,
        sourceEntryIds: decisionEntries.map((entry) => entry.id),
      }] : []),
      ...(linkedOutputEntries.length > 0 ? [{
        id: `${scopeId}:automation-index`,
        scope,
        scopeId,
        title: 'Automation Output Index',
        slug: 'automation-output-index',
        kind: 'automation_index' as const,
        sourceClass: 'derived' as const,
        editable: false,
        reviewOnly: false,
        status: 'active' as const,
        summary: `${linkedOutputEntries.length} linked automation output referenc${linkedOutputEntries.length === 1 ? 'e' : 'es'}.`,
        body: linkedOutputEntries.map((entry) => `- ${inferMemoryEntryTitle(entry)} (${entry.createdAt})`).join('\n'),
        renderedMarkdown: ['# Automation Output Index', '', ...linkedOutputEntries.map((entry) => `- ${inferMemoryEntryTitle(entry)} (${entry.createdAt})`)].join('\n'),
        tags: ['derived', 'automation_output_reference'],
        createdAt: buildMemorySummary(linkedOutputEntries).lastCreatedAt,
        sourceEntryIds: linkedOutputEntries.map((entry) => entry.id),
      }] : []),
      ...(contextFlushEntries.length > 0 ? [{
        id: `${scopeId}:context-flushes`,
        scope,
        scopeId,
        title: 'Context Flush Index',
        slug: 'context-flush-index',
        kind: 'context_flush_index' as const,
        sourceClass: 'derived' as const,
        editable: false,
        reviewOnly: false,
        status: 'active' as const,
        summary: `${contextFlushEntries.length} active context-flush artifact${contextFlushEntries.length === 1 ? '' : 's'}.`,
        body: contextFlushEntries.map((entry) => `- ${summarizeMemoryText(entry.summary || entry.content, 120)} (${entry.createdAt})`).join('\n'),
        renderedMarkdown: ['# Context Flush Index', '', ...contextFlushEntries.map((entry) => `- ${summarizeMemoryText(entry.summary || entry.content, 120)} (${entry.createdAt})`)].join('\n'),
        tags: ['derived', 'context_flush'],
        createdAt: buildMemorySummary(contextFlushEntries).lastCreatedAt,
        sourceEntryIds: contextFlushEntries.map((entry) => entry.id),
      }] : []),
      ...(reviewOnlyEntries.length > 0 ? [{
        id: `${scopeId}:review-queue`,
        scope,
        scopeId,
        title: 'Review Queue',
        slug: 'review-queue',
        kind: 'review_queue' as const,
        sourceClass: 'derived' as const,
        editable: false,
        reviewOnly: true,
        status: 'active' as const,
        summary: `${reviewOnlyEntries.length} inactive/review-only entr${reviewOnlyEntries.length === 1 ? 'y' : 'ies'} remain inspectable.`,
        body: reviewOnlyEntries.map((entry) => `- [${entry.status}] ${inferMemoryEntryTitle(entry)} (${entry.createdAt})`).join('\n'),
        renderedMarkdown: ['# Review Queue', '', ...reviewOnlyEntries.map((entry) => `- [${entry.status}] ${inferMemoryEntryTitle(entry)} (${entry.createdAt})`)].join('\n'),
        tags: ['derived', 'review_only'],
        createdAt: buildMemorySummary(reviewOnlyEntries).lastCreatedAt,
        sourceEntryIds: reviewOnlyEntries.map((entry) => entry.id),
      }] : []),
    ];

    if (!normalizedQuery) {
      return pages;
    }
    return pages.filter((page) => [page.title, page.summary, page.body, page.tags.join(' ')].join('\n').toLowerCase().includes(normalizedQuery));
  };
  const buildMemoryLintFindings = (scope: 'global' | 'code_session', scopeId: string, entries: StoredMemoryEntry[]) => {
    const findings: Array<{
      id: string;
      scope: 'global' | 'code_session';
      scopeId: string;
      severity: 'info' | 'warn' | 'critical';
      kind: 'duplicate' | 'stale' | 'oversized' | 'orphan_reference' | 'review_queue';
      title: string;
      detail: string;
      entryIds?: string[];
      relatedEntries?: Array<{
        id: string;
        title: string;
        sourceClass: import('./runtime/agent-memory-store.js').MemoryArtifactClass;
        status: import('./runtime/agent-memory-store.js').MemoryStatus;
        reviewOnly: boolean;
        editable: boolean;
      }>;
    }> = [];
    const activeEntries = entries.filter((entry) => entry.status === 'active');
    const duplicateGroups = new Map<string, StoredMemoryEntry[]>();
    for (const entry of activeEntries) {
      const list = duplicateGroups.get(entry.contentHash) ?? [];
      list.push(entry);
      duplicateGroups.set(entry.contentHash, list);
    }
    for (const group of duplicateGroups.values()) {
      if (group.length < 2) continue;
      const entryIds = group.map((entry) => entry.id);
      findings.push({
        id: `${scopeId}:duplicate:${group[0]!.contentHash}`,
        scope,
        scopeId,
        severity: 'warn',
        kind: 'duplicate',
        title: 'Duplicate durable memory',
        detail: `${group.length} active entries share the same content hash. Review whether they should be consolidated.`,
        entryIds,
        relatedEntries: buildMemoryLintRelatedEntries(entries, entryIds),
      });
    }
    for (const entry of activeEntries) {
      const sourceClass = classifyMemoryEntrySource(entry);
      const staleDays = typeof entry.artifact?.staleAfterDays === 'number'
        ? entry.artifact.staleAfterDays
        : (sourceClass === 'derived' ? 30 : 180);
      const staleReference = entry.artifact?.nextReviewAt || entry.artifact?.updatedAt || entry.createdAt;
      const stale = entry.artifact?.nextReviewAt
        ? (parseIsoDateMs(entry.artifact.nextReviewAt) ?? Number.MAX_SAFE_INTEGER) <= Date.now()
        : isOlderThanDays(staleReference, staleDays);
      if (stale) {
        findings.push({
          id: `${scopeId}:stale:${entry.id}`,
          scope,
          scopeId,
          severity: sourceClass === 'derived' ? 'warn' : 'info',
          kind: 'stale',
          title: 'Stale memory artifact',
          detail: `${inferMemoryEntryTitle(entry)} has not been refreshed in at least ${staleDays} days.`,
          entryIds: [entry.id],
          relatedEntries: buildMemoryLintRelatedEntries(entries, [entry.id]),
        });
      }
      if (entry.content.length > 1200 || (!entry.summary && entry.content.length > 480)) {
        findings.push({
          id: `${scopeId}:oversized:${entry.id}`,
          scope,
          scopeId,
          severity: 'warn',
          kind: 'oversized',
          title: 'Oversized or low-signal entry',
          detail: `${inferMemoryEntryTitle(entry)} is large relative to its summary signal and should be compacted or summarized.`,
          entryIds: [entry.id],
          relatedEntries: buildMemoryLintRelatedEntries(entries, [entry.id]),
        });
      }
      if (classifyMemoryEntrySource(entry) === 'linked_output'
        && !entry.provenance?.requestId
        && !entry.provenance?.toolName) {
        findings.push({
          id: `${scopeId}:orphan:${entry.id}`,
          scope,
          scopeId,
          severity: 'warn',
          kind: 'orphan_reference',
          title: 'Linked output missing dereference metadata',
          detail: `${inferMemoryEntryTitle(entry)} is tagged as a linked output but lacks request/tool provenance.`,
          entryIds: [entry.id],
          relatedEntries: buildMemoryLintRelatedEntries(entries, [entry.id]),
        });
      }
    }
    const reviewOnlyEntries = entries.filter((entry) => entry.status !== 'active');
    if (reviewOnlyEntries.length > 0) {
      const entryIds = reviewOnlyEntries.map((entry) => entry.id);
      findings.push({
        id: `${scopeId}:review-queue`,
        scope,
        scopeId,
        severity: 'info',
        kind: 'review_queue',
        title: 'Review-only entries remain surfaced',
        detail: `${reviewOnlyEntries.length} entr${reviewOnlyEntries.length === 1 ? 'y is' : 'ies are'} inactive and visible for review/audit.`,
        entryIds,
        relatedEntries: buildMemoryLintRelatedEntries(entries, entryIds),
      });
    }
    return findings;
  };
  const buildRecentMemoryAudit = () => runtime.auditLog
    .getRecentEvents(250)
    .filter((event) => event.type.startsWith('memory_') || event.controller === 'MemoryWiki')
    .slice()
    .reverse()
    .slice(0, 30)
    .map((event) => {
      const scope = event.details.scope === 'global' || event.details.scope === 'code_session'
        ? event.details.scope as 'global' | 'code_session'
        : undefined;
      return {
        id: event.id,
        timestamp: event.timestamp,
        severity: event.severity,
        type: event.type,
        summary: typeof event.details.summary === 'string'
          ? event.details.summary
          : event.type.replace(/[._:]+/g, ' '),
        detail: typeof event.details.detail === 'string'
          ? event.details.detail
          : typeof event.details.reason === 'string'
            ? event.details.reason
            : undefined,
        actor: typeof event.details.actor === 'string' ? event.details.actor : undefined,
        entryId: typeof event.details.entryId === 'string' ? event.details.entryId : undefined,
        scope,
        scopeId: typeof event.details.scopeId === 'string' ? event.details.scopeId : undefined,
      };
    });
  const buildRecentMemoryJobs = () => jobTracker
    .getState(120)
    .jobs
    .filter((job) => job.type.startsWith('memory_hygiene'))
    .slice(0, 30)
    .map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      detail: job.detail,
      scope: typeof job.metadata?.maintenance === 'object' && job.metadata?.maintenance && 'scope' in job.metadata.maintenance
        ? String((job.metadata.maintenance as Record<string, unknown>).scope ?? '')
        : undefined,
      artifact: typeof job.metadata?.maintenance === 'object' && job.metadata?.maintenance && 'artifact' in job.metadata.maintenance
        ? String((job.metadata.maintenance as Record<string, unknown>).artifact ?? '')
        : undefined,
    }));
  const buildMemoryScopeView = (
    scope: 'global' | 'code_session',
    scopeId: string,
    title: string,
    description: string,
    store: AgentMemoryStore,
    filter: {
      includeInactive: boolean;
      query?: string;
      sourceType?: MemorySourceType;
      trustLevel?: MemoryTrustLevel;
      status?: MemoryStatus;
      limit: number;
    },
  ) => {
    const rawEntries = store.getEntries(scopeId, filter.includeInactive);
    const wikiPages = buildMemoryWikiPages(scope, scopeId, rawEntries, filter.query);
    const lintFindings = buildMemoryLintFindings(scope, scopeId, rawEntries);
    const filteredEntries = rawEntries
      .filter((entry) => matchesMemoryFilters(entry, filter))
      .slice(0, filter.limit)
      .map((entry) => toDashboardMemoryEntryView(entry));
    const summary = buildMemorySummary(rawEntries);
    return {
      scope,
      scopeId,
      title,
      description,
      editable: store.isEnabled() && !store.isReadOnly(),
      reviewOnly: false,
      summary,
      entries: filteredEntries,
      wikiPages,
      lintFindings,
      renderedMarkdown: store.load(scopeId),
    };
  };
  const loadRawConfig = (): Record<string, unknown> => {
    if (!existsSync(configPath)) return {};
    const verification = controlPlaneIntegrity.verifyFileSync(configPath, {
      adoptUntracked: true,
      updatedBy: 'config_raw_load',
    });
    if (!verification.ok) {
      throw createStructuredRequestError(verification.message, 409, 'control_plane_integrity_violation');
    }
    const content = readFileSync(configPath, 'utf-8');
    return (yaml.load(content, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>) ?? {};
  };
  const applyKnowledgeBaseConfigToMemoryStores = (config: GuardianAgentConfig): void => {
    const kbConfig = config.assistant.memory.knowledgeBase;
    agentMemoryStore.updateConfig({
      enabled: kbConfig?.enabled ?? true,
      basePath: kbConfig?.basePath,
      readOnly: kbConfig?.readOnly ?? false,
      maxContextChars: kbConfig?.maxContextChars ?? 4000,
      maxFileChars: kbConfig?.maxFileChars ?? 20000,
      maxEntryChars: kbConfig?.maxEntryChars ?? 2000,
      maxEntriesPerScope: kbConfig?.maxEntriesPerScope ?? 500,
      maxEmbeddingCacheBytes: kbConfig?.maxEmbeddingCacheBytes ?? 50_000_000,
    });
    codeSessionMemoryStore.updateConfig({
      enabled: kbConfig?.enabled ?? true,
      basePath: kbConfig?.basePath
        ? join(kbConfig.basePath, 'code-sessions')
        : join(getGuardianBaseDir(), 'code-session-memory'),
      readOnly: kbConfig?.readOnly ?? false,
      maxContextChars: kbConfig?.maxContextChars ?? 4000,
      maxFileChars: kbConfig?.maxFileChars ?? 20000,
      maxEntryChars: kbConfig?.maxEntryChars ?? 2000,
      maxEntriesPerScope: kbConfig?.maxEntriesPerScope ?? 500,
      maxEmbeddingCacheBytes: kbConfig?.maxEmbeddingCacheBytes ?? 50_000_000,
    });
  };
  const resolveSharedStateAgentId = (agentId?: string): string | undefined => resolveAgentStateId(agentId, {
    localAgentId: router.findAgentByRole('local')?.id,
    externalAgentId: router.findAgentByRole('external')?.id,
  });
  const resolveCurrentDefaultAgentId = (): string => (
    configRef.current.agents[0]?.id
    ?? router.findAgentByRole('local')?.id
    ?? router.findAgentByRole('external')?.id
    ?? 'default'
  );
  const resolveConfiguredDispatchAgentId = (agentId?: string): string | undefined => resolveConfiguredAgentId(agentId, {
    defaultAgentId: resolveCurrentDefaultAgentId(),
    router,
    hasAgent: (targetAgentId: string) => runtime.registry.has(targetAgentId),
  });
  const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
  const trimOrUndefined = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const createStructuredRequestError = (message: string, statusCode: number, errorCode: string): Error & { statusCode: number; errorCode: string } => {
    const error = new Error(message) as Error & { statusCode: number; errorCode: string };
    error.statusCode = statusCode;
    error.errorCode = errorCode;
    return error;
  };
  const summarizeBaselineViolations = (violations: SecurityBaselineViolation[]): string => violations
    .map((violation) => `${violation.field} -> ${String(violation.enforced)}`)
    .join(', ');
  const buildSecurityBaselineRejection = (
    violations: SecurityBaselineViolation[],
    source: 'config_update' | 'guardian_agent_update' | 'policy_update',
    attemptedChange: Record<string, unknown>,
  ): DashboardMutationResult => {
    runtime.auditLog?.record?.({
      type: 'security_baseline_enforced',
      severity: 'critical',
      agentId: 'security-baseline',
      controller: 'SecurityBaseline',
      details: {
        source,
        summary: summarizeBaselineViolations(violations),
        violations: violations.map((violation) => ({
          field: violation.field,
          attempted: violation.attempted,
          enforced: violation.enforced,
        })),
        attemptedChange,
      },
    });
    return {
      success: false,
      message: `Security baseline prevents this change: ${summarizeBaselineViolations(violations)}`,
      statusCode: 403,
      errorCode: 'security_baseline_enforced',
      details: {
        violations: violations.map((violation) => ({
          field: violation.field,
          attempted: violation.attempted,
          enforced: violation.enforced,
        })),
      },
    };
  };
  const getCodeSessionConversationKey = (session: CodeSessionRecord): ConversationKey => {
    const preferredAgentId = resolveConfiguredDispatchAgentId(configRef.current.channels.web?.defaultAgent)
      ?? resolveConfiguredDispatchAgentId(configRef.current.channels.cli?.defaultAgent)
      ?? router.findAgentByRole('local')?.id
      ?? router.findAgentByRole('external')?.id
      ?? 'default';
    return {
      agentId: resolveSharedStateAgentId(preferredAgentId) ?? preferredAgentId,
      userId: session.conversationUserId,
      channel: session.conversationChannel,
    };
  };
  const resolveDashboardCodeSessionRequest = (args: {
    sessionId: string;
    userId?: string;
    principalId?: string;
    channel?: string;
    surfaceId?: string;
    touchAttachment?: boolean;
  }) => {
    const resolvedChannel = args.channel?.trim() || 'web';
    const channelUserId = args.userId?.trim() || `${resolvedChannel}-user`;
    const canonicalUserId = identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
    const resolvedSurfaceId = args.surfaceId?.trim() || getCodeSessionSurfaceId({
      channel: resolvedChannel,
      userId: canonicalUserId,
      principalId: args.principalId,
    });
    const resolvedSession = codeSessionStore.resolveForRequest({
      requestedSessionId: args.sessionId,
      userId: canonicalUserId,
      principalId: args.principalId,
      channel: resolvedChannel,
      surfaceId: resolvedSurfaceId,
      touchAttachment: args.touchAttachment ?? false,
    });
    return {
      resolvedChannel,
      resolvedSurfaceId,
      canonicalUserId,
      resolvedSession,
    };
  };
  const hydrateCodeSessionRuntimeState = (session: CodeSessionRecord): CodeSessionRecord => {
    const pendingApprovals = toolExecutor.listPendingApprovalsForCodeSession(session.id, 20);
    const recentJobs = toolExecutor.listJobsForCodeSession(session.id, 100)
      .slice(0, 20)
      .map((job) => ({
        id: job.id,
        toolName: job.toolName,
        status: job.status,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        durationMs: job.durationMs,
        resultPreview: job.resultPreview,
        argsPreview: job.argsPreview,
        error: job.error,
        verificationStatus: job.verificationStatus,
        verificationEvidence: job.verificationEvidence,
        approvalId: job.approvalId,
        requestId: job.requestId,
        remoteExecution: job.remoteExecution ? { ...job.remoteExecution } : undefined,
      }));
    const nextStatus = pendingApprovals.length > 0
      ? 'awaiting_approval'
      : recentJobs.some((job) => job.status === 'failed' || job.status === 'denied')
        ? 'blocked'
        : recentJobs.some((job) => job.status === 'running')
          ? 'active'
          : session.status;
    const workflow = deriveCodeSessionWorkflowState({
      focusSummary: session.workState.focusSummary,
      planSummary: session.workState.planSummary,
      pendingApprovals,
      recentJobs,
      verification: session.workState.verification,
      previous: session.workState.workflow,
      hasRepoEvidence: Boolean(
        session.workState.workspaceProfile?.summary
          || session.workState.workspaceMap?.indexedFileCount
          || session.workState.workingSet?.files?.length,
      ),
      workspaceTrustState: getEffectiveCodeWorkspaceTrustState(
        session.workState.workspaceTrust,
        session.workState.workspaceTrustReview,
      ) ?? session.workState.workspaceTrust?.state ?? null,
      remoteExecutionTargets: listRemoteExecutionTargets(configRef.current.assistant.tools.cloud),
    });
    const updated = codeSessionStore.updateSession({
      sessionId: session.id,
      ownerUserId: session.ownerUserId,
      status: nextStatus,
      workState: {
        ...session.workState,
        pendingApprovals,
        recentJobs,
        workflow,
      },
    });
    return updated ?? session;
  };
  for (const session of codeSessionStore.listAllSessions()) {
    runTimeline.ingestCodeSession(hydrateCodeSessionRuntimeState(session));
  }
  const ensureCodeSessionWorkspaceAwareness = (session: CodeSessionRecord): CodeSessionRecord => {
    const now = Date.now();
    const updates: Partial<CodeSessionRecord['workState']> = {};
    if (!session.workState.workspaceProfile) {
      updates.workspaceProfile = inspectCodeWorkspaceSync(session.resolvedRoot, now);
    }
    if (shouldRefreshCodeWorkspaceTrust(session.workState.workspaceTrust, session.resolvedRoot, now)) {
      updates.workspaceTrust = assessCodeWorkspaceTrustSync(session.resolvedRoot, now);
    }
    if (shouldRefreshCodeWorkspaceMap(session.workState.workspaceMap, session.resolvedRoot, now)) {
      updates.workspaceMap = buildCodeWorkspaceMapSync(session.resolvedRoot, now);
    }
    const updatedSession = Object.keys(updates).length > 0
      ? codeSessionStore.updateSession({
        sessionId: session.id,
        ownerUserId: session.ownerUserId,
        workState: updates,
      }) ?? session
      : session;
    return sharedCodeWorkspaceTrustService?.maybeSchedule(updatedSession) ?? updatedSession;
  };
  /** Mutable ref set from main() to enable hot-reload of the Telegram channel. */
  const telegramReloadRef: { current: (() => Promise<{ success: boolean; message: string }>) | null } = { current: null };

  /** Mutable ref set from main() to enable hot-reload of the Document Search engine. */
  const reloadSearchRef: { current: (() => Promise<{ success: boolean; message: string }>) | null } = { current: null };

  const buildCodeSessionSnapshot = (
    session: CodeSessionRecord,
    options?: {
      ownerUserId?: string;
      principalId?: string;
      channel?: string;
      surfaceId?: string;
      historyLimit?: number;
    },
  ) => {
    const primedSession = ensureCodeSessionWorkspaceAwareness(session);
    const hydratedSession = hydrateCodeSessionRuntimeState(primedSession);
    const history = conversations.getSessionHistory(
      getCodeSessionConversationKey(hydratedSession),
      { limit: options?.historyLimit ?? 120 },
    );
    const channel = options?.channel?.trim() || 'web';
    const ownerUserId = options?.ownerUserId ?? hydratedSession.ownerUserId;
    const surfaceId = options?.surfaceId ?? getCodeSessionSurfaceId({
      channel,
      userId: ownerUserId,
      principalId: options?.principalId,
    });
    const currentAttachment = codeSessionStore.resolveForRequest({
      userId: ownerUserId,
      principalId: options?.principalId,
      channel,
      surfaceId,
      touchAttachment: false,
    });
    return {
      session: hydratedSession,
      history,
      attached: currentAttachment?.session.id === hydratedSession.id,
      attachment: currentAttachment?.session.id === hydratedSession.id ? currentAttachment.attachment ?? null : null,
    };
  };

  const reconcileConfiguredAllowedPaths = (): void => {
    const configuredAllowedPaths = [...configRef.current.assistant.tools.allowedPaths];
    const currentAllowedPaths = toolExecutor.getPolicy().sandbox.allowedPaths;
    if (configuredAllowedPaths.length === currentAllowedPaths.length
      && configuredAllowedPaths.every((value, index) => value === currentAllowedPaths[index])) {
      return;
    }
    toolExecutor.updatePolicy({ sandbox: { allowedPaths: configuredAllowedPaths } });
  };

  const { persistAndApplyConfig } = createConfigPersistenceService({
    configPath,
    controlPlaneIntegrity,
    loadRawConfig,
    configRef,
    threatIntelWebSearchConfigRef,
    secretStore,
    runtime,
    router,
    bindTierRoutingProviders,
    applyKnowledgeBaseConfigToMemoryStores,
    bindSecurityTriageProvider,
    identity,
    connectors,
    toolExecutor,
    codingBackendServiceRef,
    codingBackendsDefaultConfig: DEFAULT_CODING_BACKENDS_CONFIG,
    webAuthStateRef,
    applyWebAuthRuntime,
    generateSecureToken,
    syncAssistantSecurityMonitoringTask: () => syncAssistantSecurityMonitoringTask(),
    telegramReloadRef,
    reloadSearchRef,
    logError: (message, err) => {
      log.error({ err }, message);
    },
  });

  const {
    normalizeCredentialRefUpdates,
    upsertLocalCredentialRef,
    deleteUnusedLocalSecrets,
    persistToolsState,
    persistSkillsState,
    persistConnectorsState,
  } = createConfigStateHelpers({
    configRef,
    loadRawConfig,
    persistAndApplyConfig,
    secretStore,
    connectors,
  });
  const {
    existingProfilesById,
    getProviderInfoSnapshot,
    buildProviderInfo,
    getDefaultModelForProviderType,
    getDefaultBaseUrlForProviderType,
    resolveCredentialForProviderInput,
  } = createProviderConfigHelpers({
    configRef,
    runtimeProviders: runtime.providers,
    secretStore,
    isLocalProviderEndpoint,
  });
  const operationsDashboard = createOperationsDashboardCallbacks({
    configRef,
    connectors,
    deviceInventory,
    networkBaseline,
    hostMonitor,
    gatewayMonitor,
    windowsDefender,
    aiSecurity,
    packageInstallTrust: sharedPackageInstallTrustService,
    containmentService,
    securityActivityLog,
    persistConnectorsState,
    runNetworkAnalysis,
    runHostMonitoring,
    runGatewayMonitoring,
    runWindowsDefenderRefresh,
    getSecurityContainmentInputs,
    trackSystemAnalytics: (type, metadata) => {
      analytics.track({
        type,
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata,
      });
    },
    trackConnectorRunAnalytics: (input, result) => {
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
    },
  });
  const agentDashboard = createAgentDashboardCallbacks({
    configRef,
    runtimeRegistry: runtime.registry,
    router,
    getProviderLocality,
    internalAgentIds: new Set([
      SECURITY_TRIAGE_AGENT_ID,
      SECURITY_TRIAGE_DISPATCHER_AGENT_ID,
    ]),
  });
  const providerDashboard = createProviderDashboardCallbacks({
    getProviderInfoSnapshot,
    buildProviderInfo,
    resolveCredentialForProviderInput,
    getDefaultModelForProviderType,
    getDefaultBaseUrlForProviderType,
  });
  const listConfiguredLlmProviders = async () => {
    const currentConfig = configRef.current;
    const runtimeProviderInfo = await buildProviderInfo(true);
    const runtimeProvidersByName = new Map(
      runtimeProviderInfo.map((provider) => [provider.name, provider] as const),
    );
    const configuredProviderNames = new Set<string>([
      ...Object.keys(currentConfig.llm),
      ...runtimeProvidersByName.keys(),
    ]);
    const preferredLocal = currentConfig.assistant.tools.preferredProviders?.local?.trim();
    const preferredManagedCloudType = resolvePreferredManagedCloudProviderType(currentConfig);
    const preferredFrontier = currentConfig.assistant.tools.preferredProviders?.frontier?.trim();
    const legacyPreferredExternal = currentConfig.assistant.tools.preferredProviders?.external?.trim();
    const defaultProvider = currentConfig.defaultProvider.trim();

    return [...configuredProviderNames]
      .sort((left, right) => left.localeCompare(right))
      .map((name) => {
        const configured = currentConfig.llm[name];
        const runtimeInfo = runtimeProvidersByName.get(name);
        const providerType = configured?.provider ?? runtimeInfo?.type ?? 'unknown';
        const tier = getProviderTier(providerType) ?? runtimeInfo?.tier ?? 'frontier';
        const isManagedCloudDefault = tier === 'managed_cloud' && providerType.trim().toLowerCase() === preferredManagedCloudType;
        const isFrontierDefault = name === preferredFrontier
          || (!preferredFrontier && name === legacyPreferredExternal && tier === 'frontier');
        return {
          name,
          type: providerType,
          model: configured?.model ?? runtimeInfo?.model ?? 'unknown',
          baseUrl: configured?.baseUrl ?? runtimeInfo?.baseUrl,
          locality: getProviderLocality(configured) ?? runtimeInfo?.locality ?? 'external',
          tier,
          connected: runtimeInfo?.connected ?? false,
          availableModels: runtimeInfo?.availableModels,
          isDefault: name === defaultProvider,
          isPreferredLocal: name === preferredLocal,
          isPreferredManagedCloud: isManagedCloudDefault,
          isPreferredFrontier: isFrontierDefault,
        };
      });
  };
  const listModelsForConfiguredLlmProvider = async (providerName: string): Promise<string[]> => {
    const normalizedProviderName = providerName.trim();
    if (!normalizedProviderName) {
      throw new Error('Provider name is required to load available models.');
    }
    const configured = configRef.current.llm[normalizedProviderName];
    if (!configured) {
      throw new Error(`Provider '${normalizedProviderName}' is not configured.`);
    }
    const apiKey = resolveCredentialForProviderInput(configured.credentialRef, configured.apiKey);
    const resolvedConfig: LLMConfig = {
      ...configured,
      apiKey,
    };
    if (providerRequiresCredential(resolvedConfig.provider) && !resolvedConfig.apiKey) {
      throw new Error(`Provider '${normalizedProviderName}' is missing a resolved credential, so available models cannot be loaded.`);
    }
    const models = await getProviderRegistry().createProvider(resolvedConfig).listModels();
    return Array.from(new Set(models.map((model) => model.id)));
  };
  const assistantDashboard = createAssistantDashboardCallbacks({
    configRef,
    runtime,
    orchestrator,
    intentRoutingTrace,
    jobTracker,
    runTimeline,
    refreshRunTimelineSnapshots,
  });

  const dispatchDashboardMessage = createDashboardMessageDispatcher({
    configRef,
    orchestrator,
    runtime,
    analytics,
    router,
    identity,
    codeSessionStore,
    intentRoutingTrace,
    getCodeSessionSurfaceId,
    readCodeRequestMetadata,
    createStructuredRequestError,
    log,
  });
  const decideDashboardToolApproval = async (input: {
    approvalId: string;
    decision: 'approved' | 'denied';
    actor: string;
    actorRole?: import('./tools/types.js').PrincipalRole;
    userId?: string;
    channel?: string;
    surfaceId?: string;
    reason?: string;
  }) => {
    const initialPendingActionForApproval = pendingActionStore.findActiveByApprovalId(input.approvalId);
    intentRoutingTrace.record({
      stage: 'approval_decision_resolved',
      userId: input.userId,
      channel: input.channel,
      details: {
        approvalId: input.approvalId,
        decision: input.decision,
        pendingActionFound: !!initialPendingActionForApproval,
        pendingActionBlockerKind: initialPendingActionForApproval?.blocker.kind,
        pendingActionResumeKind: initialPendingActionForApproval?.resume?.kind,
        pendingActionResumePayloadType: (initialPendingActionForApproval?.resume?.payload as { type?: string } | undefined)?.type,
        pendingActionApprovalIds: initialPendingActionForApproval?.blocker.approvalIds,
        scopeAgentId: initialPendingActionForApproval?.scope.agentId,
        scopeUserId: initialPendingActionForApproval?.scope.userId,
        scopeChannel: initialPendingActionForApproval?.scope.channel,
      },
    });
    const result = await toolExecutor.decideApproval(
      input.approvalId,
      input.decision,
      input.actor,
      input.actorRole ?? 'owner',
      input.reason,
    );
    const pendingActionForApproval = initialPendingActionForApproval
      ?? pendingActionStore.findActiveByApprovalId(input.approvalId);
    if (pendingActionForApproval?.blocker.kind === 'approval') {
      const pendingActionAfterDecision = result.success
        ? (
            clearApprovalIdFromPendingAction(pendingActionStore, input.approvalId)
            ?? pendingActionStore.resolveActiveForSurface(pendingActionForApproval.scope)
            ?? pendingActionForApproval
          )
        : pendingActionForApproval;
      const liveApprovalIds = toolExecutor.listPendingApprovalIdsForUser(
        pendingActionForApproval.scope.userId,
        pendingActionForApproval.scope.channel,
        {
          includeUnscoped: pendingActionForApproval.scope.channel === 'web',
          principalId: pendingActionForApproval.scope.userId,
        },
      );
      const allPendingApprovalIdsForReconcile = toolExecutor
        .listApprovals(200, 'pending')
        .map((approval) => approval.id);
      reconcilePendingApprovalAction(pendingActionStore, pendingActionAfterDecision, {
        liveApprovalIds,
        liveApprovalSummaries: toolExecutor.getApprovalSummaries(liveApprovalIds),
        allPendingApprovalIds: allPendingApprovalIdsForReconcile,
      });
      const scopedUserIds = [...new Set([
        pendingActionForApproval.scope.userId,
        input.userId?.trim() || '',
      ].filter(Boolean))];
      for (const nextUserId of scopedUserIds) {
        for (const agent of chatAgents.values()) {
          agent.syncPendingApprovalsFromExecutorForScope({
            userId: nextUserId,
            channel: pendingActionForApproval.scope.channel,
            surfaceId: input.surfaceId ?? pendingActionForApproval.scope.surfaceId,
          });
        }
      }
    }
    if (!result.success) {
      log.warn({
        approvalId: input.approvalId,
        decision: input.decision,
        actor: input.actor,
        message: result.message,
      }, 'Dashboard approval decision failed');
    }
    const continueConversation = !!pendingActionForApproval?.resume
      || !!runtime.workerManager?.hasSuspendedApproval(input.approvalId);
    const shouldContinue = continueConversation;
    const allowContinuation = shouldContinueConversationAfterApprovalDecision({
      decision: input.decision,
      hasContinuation: shouldContinue,
    });
    let continuedResponse: { content: string; metadata?: Record<string, unknown> } | undefined;
    if (allowContinuation) {
      continuedResponse = await runtime.workerManager?.continueAfterApproval(
        input.approvalId,
        input.decision,
        result.message,
        pendingActionForApproval,
      ) ?? undefined;
      if (!continuedResponse && pendingActionForApproval?.resume?.kind === 'execution_graph') {
        continuedResponse = await runtime.workerManager?.resumeExecutionGraphPendingAction(
          pendingActionForApproval,
          {
            approvalId: input.approvalId,
            approvalResult: result,
          },
        ) ?? undefined;
      }
      if (!continuedResponse && pendingActionForApproval) {
        for (const agent of chatAgents.values()) {
          const followUp = await agent.continueDirectRouteAfterApproval(
            pendingActionForApproval,
            input.approvalId,
            input.decision,
            result,
          );
          if (followUp) {
            continuedResponse = followUp;
            break;
          }
        }
      }
    }
    let displayMessage: string | undefined;
    if (!allowContinuation && !continuedResponse) {
      for (const agent of chatAgents.values()) {
        const followUp = agent.takeApprovalFollowUp(input.approvalId, input.decision);
        if (followUp) {
          displayMessage = followUp;
          break;
        }
      }
    }
    if (!displayMessage && !allowContinuation) {
      displayMessage = result.message;
    }
    intentRoutingTrace.record({
      stage: 'approval_continuation_resolved',
      userId: input.userId,
      channel: input.channel,
      details: {
        approvalId: input.approvalId,
        decision: input.decision,
        allowContinuation,
        pendingActionFoundAfterDecision: !!pendingActionForApproval,
        pendingActionHydratedAfterDecision: !initialPendingActionForApproval && !!pendingActionForApproval,
        continuationSource: continuedResponse
          ? (continuedResponse === undefined ? 'none' : 'resolved')
          : 'none',
        hasPendingActionResume: !!pendingActionForApproval?.resume,
        workerManagerSuspended: !!runtime.workerManager?.hasSuspendedApproval(input.approvalId),
        continuedContentPreview: continuedResponse?.content?.slice(0, 200),
        displayMessagePreview: displayMessage?.slice(0, 200),
      },
    });
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
      continueConversation: allowContinuation,
      displayMessage,
      ...(continuedResponse ? { continuedResponse } : {}),
    };
  };
  const applyDirectConfigUpdate = createDirectConfigUpdateHandler({
    configRef,
    jobTracker,
    loadRawConfig,
    persistAndApplyConfig,
    normalizeCredentialRefUpdates,
    storeSecret: (secretId, value) => {
      secretStore.set(secretId, value);
    },
    deleteUnusedLocalSecrets,
    mergeCloudConfigForValidation: (current, update) => (
      update ? mergeCloudConfigForValidation(current, update) : current
    ),
    previewSecurityBaselineViolations,
    buildSecurityBaselineRejection: (violations, source, attemptedChange) =>
      buildSecurityBaselineRejection(
        violations as SecurityBaselineViolation[],
        source,
        attemptedChange,
      ),
    trackSystemAnalytics: (type, metadata) => {
      analytics.track({
        type,
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata,
      });
    },
    upsertLocalCredentialRef,
    existingProfilesById,
    trimOrUndefined,
    hasOwn,
    isRecord,
    sanitizeNormalizedUrlRecord,
  });
  const resolveMemoryScopeTarget = (input: { scope: 'global' | 'code_session'; codeSessionId?: string }) => {
    if (input.scope === 'code_session') {
      const codeSessionId = input.codeSessionId?.trim();
      if (!codeSessionId) {
        return { error: 'codeSessionId is required for code-session memory curation.' } as const;
      }
      const session = codeSessionStore.getSession(codeSessionId);
      if (!session) {
        return { error: `Code session '${codeSessionId}' was not found.` } as const;
      }
      return {
        scope: 'code_session' as const,
        scopeId: session.id,
        scopeTitle: session.title,
        store: codeSessionMemoryStore,
      };
    }

    return {
      scope: 'global' as const,
      scopeId: getPrincipalMemoryAgentId(),
      scopeTitle: 'Global Memory',
      store: agentMemoryStore,
    };
  };
  const setupConfigCallbacks = createSetupConfigDashboardCallbacks({
    configRef,
    toolExecutor,
    buildProviderInfo,
    jobTracker,
    loadRawConfig,
    persistAndApplyConfig,
    upsertLocalCredentialRef,
    isLocalProviderEndpoint,
    getProviderLocality: (llmCfg) => getProviderLocality(
      llmCfg as Pick<LLMConfig, 'provider' | 'baseUrl'> | undefined,
    ) ?? 'external',
    trackSystemAnalytics: (type, metadata) => {
      analytics.track({
        type,
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
        metadata,
      });
    },
  });
  const dashboardRuntime = createDashboardRuntimeCallbacks({
    configRef,
    runtime,
    securityActivityLog,
    runTimeline,
    agentDashboard,
    dispatchDashboardMessage,
    prepareIncomingDispatch,
    resolveConfiguredAgentId: resolveConfiguredDispatchAgentId,
    identity,
    analytics,
    orchestrator,
  });
  const governanceDashboard = createGovernanceDashboardCallbacks({
    configRef,
    guardianAgentService,
    previewSecurityBaselineViolations,
    buildSecurityBaselineRejection: (violations, source, attemptedChange) => (
      buildSecurityBaselineRejection(violations, source, attemptedChange)
    ),
    policyState,
    sentinelAuditService,
    auditLog: runtime.auditLog,
  });

  return {
    ...agentDashboard,

    onAuditQuery: (filter) => runtime.auditLog.query(filter),

    onAuditSummary: (windowMs) => runtime.auditLog.getSummary(windowMs),

    onAuditVerifyChain: () => runtime.auditLog.verifyChain(),

    onConfig: () => redactConfig(configRef.current),

    onRoutingMode: () => {
      const r = configRef.current.routing;
      const tierMode = normalizeTierModeForRouter(router, configRef.current, r?.tierMode);
      const availableModes = buildAvailableRoutingModes(router, configRef.current);
      if (tierMode !== (r?.tierMode ?? 'auto')) {
        configRef.current.routing = {
          strategy: r?.strategy ?? 'keyword',
          ...r,
          tierMode,
        };
        bindTierRoutingProviders(runtime, router, configRef.current);
      }
      return {
        tierMode,
        availableModes,
        complexityThreshold: r?.complexityThreshold ?? 0.5,
        fallbackOnFailure: r?.fallbackOnFailure !== false,
        providerOptions: buildChatProviderSelectorOptions(configRef.current),
      };
    },

    onRoutingModeUpdate: (mode) => {
      if (!configRef.current.routing) {
        configRef.current.routing = { strategy: 'keyword' };
      }
      const normalizedMode = normalizeTierModeForRouter(router, configRef.current, mode);
      const rawConfig = persistRoutingTierModeInRawConfig(loadRawConfig(), normalizedMode);
      const persistResult = persistAndApplyConfig(rawConfig, {
        changedBy: 'routing_mode_update',
        reason: 'routing mode update',
      });
      if (!persistResult.success) {
        return {
          success: false,
          message: persistResult.message,
          tierMode: normalizeTierModeForRouter(router, configRef.current, configRef.current.routing?.tierMode),
          availableModes: buildAvailableRoutingModes(router, configRef.current),
        };
      }
      const availableModes = buildAvailableRoutingModes(router, configRef.current);
      log.info({ requestedTierMode: mode, tierMode: normalizedMode }, 'Tier routing mode updated');
      return {
        success: normalizedMode === mode,
        message: normalizedMode === mode
          ? `Routing mode set to: ${formatRoutingModeLabel(mode)}`
          : `Routing mode ${formatRoutingModeLabel(mode)} is unavailable right now. Falling back to: ${formatRoutingModeLabel(normalizedMode)}`,
        tierMode: normalizedMode,
        availableModes,
      };
    },

    ...createAuthControlCallbacks({
      configRef,
      webAuthStateRef,
      applyWebAuthRuntime,
      generateSecureToken,
      loadRawConfig,
      persistAndApplyConfig,
      trackAnalytics: (type, metadata) => {
        analytics.track({
          type,
          channel: 'system',
          canonicalUserId: configRef.current.assistant.identity.primaryUserId,
          metadata,
        });
      },
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
    ...providerDashboard,

    onCodingBackendStatus: (sessionId) => (
      codingBackendServiceRef.current?.getStatus(sessionId).map((session): DashboardCodingBackendSession => ({
        id: session.id,
        backendId: session.backendId,
        backendName: session.backendName,
        codeSessionId: session.codeSessionId,
        terminalId: session.terminalId,
        task: session.task,
        status: session.status,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        exitCode: session.exitCode,
        durationMs: session.durationMs,
      })) ?? []
    ),

    ...assistantDashboard,

    ...createToolsDashboardCallbacks({
      configRef,
      toolExecutor,
      skillRegistry: skillRegistry ?? null,
      enabledManagedProviders,
      identity,
      pendingActionStore,
      codeSessionStore,
      chatAgents: chatAgents.values(),
      workerManager: runtime.workerManager,
      resolveSharedStateAgentId,
      getCodeSessionSurfaceId,
      readMessageSurfaceId,
      readCodeRequestMetadata,
      persistToolsState: (policy) => {
        runtime.applyShellAllowedCommands(policy.sandbox.allowedCommands);
        return persistToolsState(policy);
      },
      persistSkillsState,
      applyBrowserRuntimeConfig,
      decideDashboardToolApproval,
      getCategoryDefaults: () => computeCategoryDefaults(configRef.current.llm as Record<string, { provider?: string }>),
      trackSystemAnalytics: (type, metadata) => {
        analytics.track({
          type,
          channel: 'system',
          canonicalUserId: configRef.current.assistant.identity.primaryUserId,
          metadata,
        });
      },
      trackToolRunAnalytics: (input, result) => {
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
      },
    }),

    ...operationsDashboard.callbacks,
    ...createPerformanceDashboardCallbacks(performanceService),

    connectorWorkflowOps: operationsDashboard.connectorWorkflowOps,

    ...dashboardRuntime,

    ...createWorkspaceDashboardCallbacks({
      codeSessionStore,
      identity,
      conversations,
      runTimeline,
      toolExecutor,
      refreshRunTimelineSnapshots,
      maybeScheduleCodeSession: (session) => sharedCodeWorkspaceTrustService?.maybeSchedule(session) ?? session,
      hydrateCodeSessionRuntimeState,
      buildCodeSessionSnapshot,
      getCodeSessionSandboxes: ({ session, canonicalUserId }) => toolExecutor.getCodeSessionManagedSandboxStatus({
        sessionId: session.id,
        ownerUserId: canonicalUserId,
      }),
      createCodeSessionSandbox: ({ session, canonicalUserId, targetId, profileId, runtime, vcpus }) => (
        toolExecutor.createManagedSandboxForCodeSession({
          sessionId: session.id,
          ownerUserId: canonicalUserId,
          targetId,
          profileId,
          runtime,
          vcpus,
        })
      ),
      deleteCodeSessionSandbox: ({ session, canonicalUserId, leaseId }) => (
        toolExecutor.deleteManagedSandboxForCodeSession({
          sessionId: session.id,
          ownerUserId: canonicalUserId,
          leaseId,
        })
      ),
      releaseCodeSessionSandboxes: ({ session, canonicalUserId }) => (
        toolExecutor.releaseManagedSandboxesForCodeSession({
          sessionId: session.id,
          ownerUserId: canonicalUserId,
        })
      ),
      getCodeSessionSurfaceId,
      resetCodeSessionWorkspacePolicy: () => {
        toolExecutor.updatePolicy({ sandbox: { allowedPaths: [...configRef.current.assistant.tools.allowedPaths] } });
      },
      reconcileConfiguredAllowedPaths,
      approvalBelongsToCodeSession: (approvalId, sessionId) => toolExecutor.approvalBelongsToCodeSession(approvalId, sessionId),
      resolveDashboardCodeSessionRequest,
      decideDashboardToolApproval,
      createStructuredRequestError,
      getCodeSessionConversationKey,
      resolveSharedStateAgentId,
      trackConversationReset: ({ agentId, channel, channelUserId, canonicalUserId }) => {
        analytics.track({
          type: 'conversation_reset',
          channel,
          canonicalUserId,
          channelUserId,
          agentId,
        });
      },
    }),

    onMemoryView: (args) => {
      const includeInactive = args?.includeInactive === true;
      const includeCodeSessions = args?.includeCodeSessions !== false;
      const limit = Math.max(1, Math.min(args?.limit ?? 200, 500));
      const principalAgentId = getPrincipalMemoryAgentId();
      const global = buildMemoryScopeView(
        'global',
        principalAgentId,
        'Global Memory',
        'Guardian primary durable memory scope shared across normal chat and loaded first for Code turns.',
        agentMemoryStore,
        {
          includeInactive,
          query: args?.query,
          sourceType: args?.sourceType,
          trustLevel: args?.trustLevel,
          status: args?.status,
          limit,
        },
      );
      const codeSessions = includeCodeSessions
        ? codeSessionStore
          .listAllSessions()
          .filter((session) => !args?.codeSessionId || session.id === args.codeSessionId)
          .map((session) => buildMemoryScopeView(
            'code_session',
            session.id,
            session.title,
            `Code-session durable memory for workspace ${session.workspaceRoot}. Surfaced with scope isolation preserved.`,
            codeSessionMemoryStore,
            {
              includeInactive,
              query: args?.query,
              sourceType: args?.sourceType,
              trustLevel: args?.trustLevel,
              status: args?.status,
              limit,
            },
          ))
        : [];
      const recentAudit = buildRecentMemoryAudit();
      const recentJobs = buildRecentMemoryJobs();
      const scopeViews = [global, ...codeSessions];
      const wikiPageCount = scopeViews.reduce((sum, scope) => sum + scope.wikiPages.length, 0);
      const lintFindingCount = scopeViews.reduce((sum, scope) => sum + scope.lintFindings.length, 0);
      const reviewOnlyCount = scopeViews.reduce((sum, scope) => sum + scope.summary.inactiveEntries, 0);
      const operatorPageCount = scopeViews.reduce(
        (sum, scope) => sum + scope.wikiPages.filter((page) => page.sourceClass === 'operator_curated').length,
        0,
      );
      return {
        generatedAt: new Date().toISOString(),
        principalAgentId,
        canEdit: (agentMemoryStore.isEnabled() && !agentMemoryStore.isReadOnly())
          || (codeSessionMemoryStore.isEnabled() && !codeSessionMemoryStore.isReadOnly()),
        global,
        codeSessions,
        maintenance: {
          readOnly: (!agentMemoryStore.isEnabled() || agentMemoryStore.isReadOnly())
            && (!codeSessionMemoryStore.isEnabled() || codeSessionMemoryStore.isReadOnly()),
          scopeCount: scopeViews.length,
          wikiPageCount,
          lintFindingCount,
          reviewOnlyCount,
          operatorPageCount,
          recentAuditCount: recentAudit.length,
          recentMaintenanceCount: recentJobs.length,
        },
        recentAudit,
        recentJobs,
      };
    },

    onMemoryCurate: async (input) => {
      const actor = input.actor?.trim() || 'web-user';
      const target = resolveMemoryScopeTarget({
        scope: input.scope,
        codeSessionId: input.codeSessionId,
      });
      if ('error' in target) {
        return {
          success: false,
          message: target.error ?? 'Invalid memory scope.',
          statusCode: 400,
          errorCode: 'memory_scope_invalid',
        };
      }
      if (!target.store.isEnabled()) {
        return {
          success: false,
          message: 'Persistent memory is disabled for this scope.',
          statusCode: 409,
          errorCode: 'memory_disabled',
        };
      }
      if (target.store.isReadOnly()) {
        return {
          success: false,
          message: 'Persistent memory is read-only for this scope.',
          statusCode: 409,
          errorCode: 'memory_read_only',
        };
      }

      const timestamp = new Date().toISOString();
      const createdAt = timestamp.slice(0, 10);
      const tags = [...new Set((input.tags ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
      const title = input.title?.trim() || '';
      const content = input.content?.trim() || '';
      const reason = input.reason?.trim() || undefined;
      const auditAgentId = target.scope === 'global' ? target.scopeId : getPrincipalMemoryAgentId();
      const persistCuratedEntry = (entryId?: string) => (
        persistMemoryEntry({
          target: {
            scope: target.scope,
            scopeId: target.scopeId,
            store: target.store,
            auditAgentId,
          },
          intent: 'operator_curate',
          actor,
          ...(entryId ? { existingEntryId: entryId } : {}),
          entry: {
            content,
            summary: input.summary?.trim() || undefined,
            createdAt,
            category: 'Operator Wiki',
            sourceType: 'operator',
            trustLevel: 'trusted',
            status: 'active',
            createdByPrincipal: actor,
            tags,
            artifact: {
              sourceClass: 'operator_curated',
              kind: 'wiki_page',
              title,
              slug: slugifyMemoryTitle(title),
              retrievalHints: [title, ...tags],
              updatedAt: timestamp,
              updatedByPrincipal: actor,
              changeReason: reason,
            },
          },
        })
      );

      try {
        if (input.action === 'create') {
          if (!title || !content) {
            return {
              success: false,
              message: 'Title and content are required to create a curated memory page.',
              statusCode: 400,
              errorCode: 'memory_curate_invalid',
            };
          }
          const stored = persistCuratedEntry();
          const resolvedTitle = inferMemoryEntryTitle(stored.entry);
          if (stored.action === 'created') {
            runtime.auditLog?.record?.({
              type: 'memory_wiki.created',
              severity: 'info',
              agentId: auditAgentId,
              controller: 'MemoryWiki',
              details: {
                actor,
                scope: target.scope,
                scopeId: target.scopeId,
                entryId: stored.entry.id,
                title: resolvedTitle,
                reason,
                summary: `Created curated memory page '${resolvedTitle}'.`,
              },
            });
          } else if (stored.action === 'updated') {
            runtime.auditLog?.record?.({
              type: 'memory_wiki.updated',
              severity: 'info',
              agentId: auditAgentId,
              controller: 'MemoryWiki',
              details: {
                actor,
                scope: target.scope,
                scopeId: target.scopeId,
                entryId: stored.entry.id,
                title: resolvedTitle,
                reason,
                summary: `Updated curated memory page '${resolvedTitle}' via duplicate-safe create.`,
              },
            });
          }
          return {
            success: true,
            message: stored.action === 'created'
              ? `Created curated memory page '${resolvedTitle}'.`
              : stored.action === 'updated'
                ? `Updated existing curated memory page '${resolvedTitle}'.`
                : `Curated memory page '${resolvedTitle}' is already up to date.`,
            details: {
              action: stored.action === 'created' ? 'create' : 'update',
              scope: target.scope,
              scopeId: target.scopeId,
              entryId: stored.entry.id,
              title: resolvedTitle,
              dedupeReason: stored.reason,
              matchedEntryId: stored.matchedEntryId,
            },
          };
        }

        const entryId = input.entryId?.trim();
        if (!entryId) {
          return {
            success: false,
            message: 'entryId is required for updating or archiving a curated memory page.',
            statusCode: 400,
            errorCode: 'memory_entry_required',
          };
        }
        const existing = target.store.findEntry(target.scopeId, entryId);
        if (!existing) {
          return {
            success: false,
            message: `Memory entry '${entryId}' was not found.`,
            statusCode: 404,
            errorCode: 'memory_entry_not_found',
          };
        }
        if (classifyMemoryEntrySource(existing) !== 'operator_curated') {
          return {
            success: false,
            message: 'Only operator-curated wiki pages can be edited or archived from the Memory page.',
            statusCode: 400,
            errorCode: 'memory_entry_not_curated',
          };
        }

        if (input.action === 'archive') {
          const stored = target.store.archiveEntry(target.scopeId, entryId, {
            archivedAt: timestamp,
            archivedByPrincipal: actor,
            reason,
          });
          const archivedTitle = inferMemoryEntryTitle(stored);
          runtime.auditLog?.record?.({
            type: 'memory_wiki.archived',
            severity: 'info',
            agentId: auditAgentId,
            controller: 'MemoryWiki',
            details: {
              actor,
              scope: target.scope,
              scopeId: target.scopeId,
              entryId: stored.id,
              title: archivedTitle,
              reason,
              summary: `Archived curated memory page '${archivedTitle}'.`,
            },
          });
          return {
            success: true,
            message: `Archived curated memory page '${archivedTitle}'.`,
            details: {
              action: 'archive',
              scope: target.scope,
              scopeId: target.scopeId,
              entryId: stored.id,
              title: archivedTitle,
            },
          };
        }

        if (!title || !content) {
          return {
            success: false,
            message: 'Title and content are required to update a curated memory page.',
            statusCode: 400,
            errorCode: 'memory_curate_invalid',
          };
        }
        const stored = persistCuratedEntry(entryId);
        const resolvedTitle = inferMemoryEntryTitle(stored.entry);
        runtime.auditLog?.record?.({
          type: 'memory_wiki.updated',
          severity: 'info',
          agentId: auditAgentId,
          controller: 'MemoryWiki',
          details: {
            actor,
            scope: target.scope,
            scopeId: target.scopeId,
            entryId: stored.entry.id,
            title: resolvedTitle,
            reason,
            summary: stored.action === 'noop'
              ? `Reviewed curated memory page '${resolvedTitle}' without changes.`
              : `Updated curated memory page '${resolvedTitle}'.`,
          },
        });
        return {
          success: true,
          message: stored.action === 'noop'
            ? `Curated memory page '${resolvedTitle}' is already up to date.`
            : `Updated curated memory page '${resolvedTitle}'.`,
          details: {
            action: 'update',
            scope: target.scope,
            scopeId: target.scopeId,
            entryId: stored.entry.id,
            title: resolvedTitle,
            dedupeReason: stored.reason,
            matchedEntryId: stored.matchedEntryId,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          message,
          statusCode: 400,
          errorCode: 'memory_curate_failed',
        };
      }
    },

    onMemoryMaintenance: async (input) => {
      const actor = input.actor?.trim() || 'web-user';
      const target = resolveMemoryScopeTarget({
        scope: input.scope,
        codeSessionId: input.codeSessionId,
      });
      if ('error' in target) {
        return {
          success: false,
          message: target.error ?? 'Invalid memory scope.',
          statusCode: 400,
          errorCode: 'memory_scope_invalid',
        };
      }
      if (!target.store.isEnabled()) {
        return {
          success: false,
          message: 'Persistent memory is disabled for this scope.',
          statusCode: 409,
          errorCode: 'memory_disabled',
        };
      }
      if (target.store.isReadOnly()) {
        return {
          success: false,
          message: 'Persistent memory is read-only for this scope.',
          statusCode: 409,
          errorCode: 'memory_read_only',
        };
      }
      try {
        const auditAgentId = target.scope === 'global' ? target.scopeId : getPrincipalMemoryAgentId();
        const result = runMemoryMaintenanceForScope({
          target: {
            scope: target.scope,
            scopeId: target.scopeId,
            store: target.store,
            auditAgentId,
          },
          maintenanceType: input.maintenanceType,
          actor,
          detail: `User-requested memory cleanup for ${target.scope === 'global' ? 'global memory' : `code session ${target.scopeId}`}.`,
        });
        return {
          success: true,
          message: result.changed
            ? `Memory cleanup archived ${result.archivedExactDuplicates + result.archivedNearDuplicates + result.archivedStaleSystemEntries} entr${result.archivedExactDuplicates + result.archivedNearDuplicates + result.archivedStaleSystemEntries === 1 ? 'y' : 'ies'} in ${target.scope === 'global' ? 'global memory' : `code session ${target.scopeId}`}.`
            : `Memory cleanup reviewed ${result.reviewedEntries} entr${result.reviewedEntries === 1 ? 'y' : 'ies'} in ${target.scope === 'global' ? 'global memory' : `code session ${target.scopeId}`}; no archival changes were needed.`,
          details: {
            scope: target.scope,
            scopeId: target.scopeId,
            maintenanceType: input.maintenanceType ?? 'idle_sweep',
            reviewedEntries: result.reviewedEntries,
            archivedExactDuplicates: result.archivedExactDuplicates,
            archivedNearDuplicates: result.archivedNearDuplicates,
            archivedStaleSystemEntries: result.archivedStaleSystemEntries,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          message,
          statusCode: 400,
          errorCode: 'memory_maintenance_failed',
        };
      }
    },

    onSecondBrainOverview: () => secondBrainService.getOverview(),

    onSecondBrainGenerateBrief: (input) => secondBrainBriefingService.generateBrief(input),

    onSecondBrainBriefs: (args) => secondBrainService.listBriefs(args ?? {}),

    onSecondBrainBriefUpdate: async (input) => {
      try {
        const brief = secondBrainService.updateBrief(input);
        return {
          success: true,
          message: `Updated brief '${brief.title}'.`,
          details: { id: brief.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainBriefDelete: async (id) => {
      try {
        const brief = secondBrainService.deleteBrief(id);
        return {
          success: true,
          message: `Deleted brief '${brief.title}'.`,
          details: { id: brief.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainCalendar: (args) => secondBrainService.listEvents(args ?? {}),

    onSecondBrainCalendarUpsert: async (input) => {
      try {
        const event = secondBrainService.upsertEvent(input);
        return {
          success: true,
          message: `Saved event '${event.title}'.`,
          details: { id: event.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainCalendarDelete: async (id) => {
      try {
        const event = secondBrainService.deleteEvent(id);
        return {
          success: true,
          message: `Deleted event '${event.title}'.`,
          details: { id: event.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainTasks: (args) => secondBrainService.listTasks(args ?? {}),

    onSecondBrainTaskUpsert: async (input) => {
      try {
        const task = secondBrainService.upsertTask(input);
        return {
          success: true,
          message: `Saved task '${task.title}'.`,
          details: { id: task.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainTaskDelete: async (id) => {
      try {
        const task = secondBrainService.deleteTask(id);
        return {
          success: true,
          message: `Deleted task '${task.title}'.`,
          details: { id: task.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainNotes: (args) => secondBrainService.listNotes(args ?? {}),

    onSecondBrainNoteUpsert: async (input) => {
      try {
        const note = secondBrainService.upsertNote(input);
        return {
          success: true,
          message: `Saved note '${note.title}'.`,
          details: { id: note.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainNoteDelete: async (id) => {
      try {
        const note = secondBrainService.deleteNote(id);
        return {
          success: true,
          message: `Deleted note '${note.title}'.`,
          details: { id: note.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainPeople: (args) => secondBrainService.listPeople(args ?? {}),

    onSecondBrainPersonUpsert: async (input) => {
      try {
        const person = secondBrainService.upsertPerson(input);
        return {
          success: true,
          message: `Saved person '${person.name}'.`,
          details: { id: person.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainPersonDelete: async (id) => {
      try {
        const person = secondBrainService.deletePerson(id);
        return {
          success: true,
          message: `Deleted person '${person.name}'.`,
          details: { id: person.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainLinks: (args) => secondBrainService.listLinks(args ?? {}),

    onSecondBrainLinkUpsert: async (input) => {
      try {
        const link = secondBrainService.upsertLink(input);
        return {
          success: true,
          message: `Saved library item '${link.title}'.`,
          details: { id: link.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainLinkDelete: async (id) => {
      try {
        const link = secondBrainService.deleteLink(id);
        return {
          success: true,
          message: `Deleted library item '${link.title}'.`,
          details: { id: link.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainRoutineCatalog: () => secondBrainService.listRoutineCatalog(),

    onSecondBrainRoutines: () => secondBrainService.listRoutines(),

    onSecondBrainRoutineCreate: async (input) => {
      try {
        const routine = secondBrainService.createRoutine(input);
        return {
          success: true,
          message: `Created routine '${routine.name}'.`,
          details: { id: routine.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainRoutineUpdate: async (input) => {
      try {
        const routine = secondBrainService.updateRoutine(input);
        return {
          success: true,
          message: `Updated routine '${routine.name}'.`,
          details: { id: routine.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainRoutineDelete: async (id) => {
      try {
        const routine = secondBrainService.deleteRoutine(id);
        return {
          success: true,
          message: `Deleted routine '${routine.name}'.`,
          details: { id: routine.id },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainSyncNow: async () => {
      try {
        if (!secondBrainSyncService) {
          return {
            success: false,
            message: 'Second Brain sync is unavailable.',
            statusCode: 503,
          };
        }
        const summary = await secondBrainSyncService.syncAll('web_manual');
        const providerMessage = summary.providers.length > 0
          ? summary.providers.map((provider: typeof summary.providers[number]) => {
              if (provider.skipped) {
                return `${provider.provider}: ${provider.reason ?? 'skipped'}`;
              }
              const eventLabel = `${provider.eventsSynced} event${provider.eventsSynced === 1 ? '' : 's'}`;
              const peopleLabel = `${provider.peopleSynced} contact${provider.peopleSynced === 1 ? '' : 's'}`;
              return `${provider.provider}: ${eventLabel}, ${peopleLabel}`;
            }).join('; ')
          : 'No connected providers were available.';
        return {
          success: true,
          message: `Synced calendar and contacts. ${providerMessage}`,
          details: { summary },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        };
      }
    },

    onSecondBrainUsage: () => secondBrainService.getUsageSummary(),

    onReferenceGuide: () => getReferenceGuide(),

    onQuickActions: () => getQuickActions(configRef.current.assistant.quickActions),

    ...setupConfigCallbacks,

    listConfiguredLlmProviders,

    listModelsForConfiguredLlmProvider,

    applyDirectLlmProviderConfigUpdate: applyDirectConfigUpdate,

    onConfigUpdate: async (updates) => applyDirectConfigUpdate(updates),

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

    ...createSecurityDashboardCallbacks({
      configRef,
      loadRawConfig,
      persistAndApplyConfig,
      aiSecurity,
      runAssistantSecurityScan,
      threatIntel,
      jobTracker,
      auditLog: runtime.auditLog,
      trackAnalytics: (type, metadata) => {
        analytics.track({
          type,
          channel: 'system',
          canonicalUserId: configRef.current.assistant.identity.primaryUserId,
          metadata,
        });
      },
    }),

    ...createProviderIntegrationCallbacks({
      configRef,
      googleAuthRef,
      googleServiceRef,
      microsoftAuthRef,
      microsoftServiceRef,
      toolExecutorRef,
      enabledManagedProviders,
      secretStore,
      loadRawConfig,
      persistAndApplyConfig,
      probeGwsCli,
      testCloudConnections: cloudConnectionTesters,
    }),
    ...governanceDashboard,

    set onTelegramReload(fn: (() => Promise<{ success: boolean; message: string }>) | undefined) {
      telegramReloadRef.current = fn ?? null;
    },

    telegramReloadRef,
    reloadSearchRef,
  };
}


function resolveAssistantDbPath(configuredPath: string | undefined, fallbackFileName: string): string {
  const fallback = join(getGuardianBaseDir(), fallbackFileName);
  if (!configuredPath || !configuredPath.trim()) return fallback;

  const trimmed = configuredPath.trim();
  if (trimmed.startsWith('~/')) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function emitStartupTrace(marker: string): void {
  if (process.env.GUARDIAN_STARTUP_TRACE !== '1') return;
  console.error(`[startup-trace] ${marker}`);
}

async function main(): Promise<void> {
  emitStartupTrace('main:start');
  const configPath = process.argv[2] ?? DEFAULT_CONFIG_PATH;
  const {
    configRef,
    config,
    controlPlaneIntegrity,
    resolvedRuntimeCredentials,
    runtime,
    secretStore,
    threatIntelWebSearchConfigRef,
  } = await createBootstrapRuntimeContext(configPath);
  emitStartupTrace('main:bootstrap-context-ready');
  if (isSecurityBaselineDisabled()) {
    log.warn({ envVar: 'GUARDIAN_DISABLE_BASELINE' }, 'Security baseline override enabled via environment');
    runtime.auditLog?.record?.({
      type: 'security_baseline_overridden',
      severity: 'critical',
      agentId: 'security-baseline',
      controller: 'SecurityBaseline',
      details: {
        mechanism: 'environment',
        envVar: 'GUARDIAN_DISABLE_BASELINE',
      },
    });
  }
  const scheduledTasksPersistPath = join(getGuardianBaseDir(), 'scheduled-tasks.json');
  const collectPolicyFilePaths = (rootPath: string): string[] => {
    if (!existsSync(rootPath)) return [];
    const paths: string[] = [];
    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      const fullPath = join(rootPath, entry.name);
      if (entry.isDirectory()) {
        for (const subEntry of readdirSync(fullPath, { withFileTypes: true })) {
          if (subEntry.isFile() && subEntry.name.endsWith('.json')) {
            paths.push(join(fullPath, subEntry.name));
          }
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.json')) {
        paths.push(fullPath);
      }
    }
    return paths;
  };
  const resolveMemoryIndexPaths = (basePath: string, store: AgentMemoryStore): string[] => (
    store.listAgents().map((agentId) => join(basePath, `${agentId}.index.json`))
  );
  const resolveActiveControlPlanePaths = (): string[] => {
    const kbConfig = configRef.current.assistant.memory.knowledgeBase;
    const globalMemoryBasePath = kbConfig?.basePath ?? join(getGuardianBaseDir(), 'memory');
    const codeMemoryBasePath = kbConfig?.basePath
      ? join(kbConfig.basePath, 'code-sessions')
      : join(getGuardianBaseDir(), 'code-session-memory');
    return [
      configPath,
      scheduledTasksPersistPath,
      ...collectPolicyFilePaths(policyRulesPath),
      ...resolveMemoryIndexPaths(globalMemoryBasePath, agentMemoryStore),
      ...resolveMemoryIndexPaths(codeMemoryBasePath, codeSessionMemoryStore),
    ];
  };
  const recordControlPlaneIntegritySweep = (
    source: 'startup' | 'interval',
  ) => {
    const result = controlPlaneIntegrity.verifyFilesSync(resolveActiveControlPlanePaths(), {
      adoptUntracked: true,
      updatedBy: `${source}_integrity_sweep`,
    });
    if (result.ok) {
      log.info({
        source,
        trackedCount: result.trackedCount,
        verifiedCount: result.verifiedCount,
      }, 'Control-plane integrity verification passed');
      runtime.auditLog?.record?.({
        type: 'control_plane_integrity_verified',
        severity: 'info',
        agentId: 'control-plane-integrity',
        controller: 'ControlPlaneIntegrity',
        details: {
          source,
          trackedCount: result.trackedCount,
          verifiedCount: result.verifiedCount,
        },
      });
      return result;
    }

    log.error({
      source,
      trackedCount: result.trackedCount,
      verifiedCount: result.verifiedCount,
      violations: result.violations,
    }, 'Control-plane integrity verification failed');
    runtime.auditLog?.record?.({
      type: 'control_plane_integrity_violation',
      severity: 'critical',
      agentId: 'control-plane-integrity',
      controller: 'ControlPlaneIntegrity',
      details: {
        source,
        trackedCount: result.trackedCount,
        verifiedCount: result.verifiedCount,
        violations: result.violations,
      },
    });
    return result;
  };
  const onMemorySecurityEvent = (event: {
    severity: 'info' | 'warn' | 'critical';
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }) => {
    if (event.severity === 'critical') {
      log.error({ ...event }, 'Memory security event');
    } else if (event.severity === 'warn') {
      log.warn({ ...event }, 'Memory security event');
    } else {
      log.info({ ...event }, 'Memory security event');
    }
    runtime.auditLog?.record?.({
      type: event.code === 'memory_index_integrity_violation'
        ? 'control_plane_integrity_violation'
        : 'anomaly_detected',
      severity: event.severity,
      agentId: 'memory-store',
      controller: 'AgentMemoryStore',
      details: {
        source: 'memory_store',
        code: event.code,
        message: event.message,
        ...(event.details ?? {}),
      },
    });
  };
  const identity = new IdentityService(config.assistant.identity);
  let analytics: AnalyticsService | null = null;
  const onSQLiteSecurityEvent = (event: SQLiteSecurityEvent) => {
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
    readOnly: kbConfig?.readOnly ?? false,
    maxContextChars: kbConfig?.maxContextChars ?? 4000,
    maxFileChars: kbConfig?.maxFileChars ?? 20000,
    maxEntryChars: kbConfig?.maxEntryChars ?? 2000,
    maxEntriesPerScope: kbConfig?.maxEntriesPerScope ?? 500,
    maxEmbeddingCacheBytes: kbConfig?.maxEmbeddingCacheBytes ?? 50_000_000,
    integrity: controlPlaneIntegrity,
    onSecurityEvent: onMemorySecurityEvent,
  });
  const codeSessionMemoryStore = new AgentMemoryStore({
    enabled: kbConfig?.enabled ?? true,
    basePath: kbConfig?.basePath
      ? join(kbConfig.basePath, 'code-sessions')
      : join(getGuardianBaseDir(), 'code-session-memory'),
    readOnly: kbConfig?.readOnly ?? false,
    maxContextChars: kbConfig?.maxContextChars ?? 4000,
    maxFileChars: kbConfig?.maxFileChars ?? 20000,
    maxEntryChars: kbConfig?.maxEntryChars ?? 2000,
    maxEntriesPerScope: kbConfig?.maxEntriesPerScope ?? 500,
    maxEmbeddingCacheBytes: kbConfig?.maxEmbeddingCacheBytes ?? 50_000_000,
    integrity: controlPlaneIntegrity,
    onSecurityEvent: onMemorySecurityEvent,
  });
  const memoryMutationServiceRef: { current: MemoryMutationService | null } = { current: null };
  const automationOutputStore = new AutomationOutputStore();
  const automationOutputPersistence = new AutomationOutputPersistenceService({
    outputStore: automationOutputStore,
    agentMemoryStore,
    defaultAgentId: 'default',
  });

  const conversationDbPath = resolveAssistantDbPath(config.assistant.memory.sqlitePath, 'assistant-memory.sqlite');
  const analyticsDbPath = resolveAssistantDbPath(config.assistant.analytics.sqlitePath, 'assistant-analytics.sqlite');
  const codeSessionDbPath = resolveAssistantDbPath(undefined, 'assistant-code-sessions.sqlite');
  const pendingActionDbPath = resolveAssistantDbPath(undefined, 'assistant-pending-actions.sqlite');
  const continuityThreadDbPath = resolveAssistantDbPath(undefined, 'assistant-continuity-threads.sqlite');
  const executionDbPath = resolveAssistantDbPath(undefined, 'assistant-executions.sqlite');
  const secondBrainDbPath = resolveAssistantDbPath(undefined, 'assistant-second-brain.sqlite');
  const conversations = new ConversationService({
    enabled: config.assistant.memory.enabled,
    sqlitePath: conversationDbPath,
    maxTurns: config.assistant.memory.maxTurns,
    maxMessageChars: config.assistant.memory.maxMessageChars,
    maxContextChars: config.assistant.memory.maxContextChars,
    retentionDays: config.assistant.memory.retentionDays,
    onSecurityEvent: onSQLiteSecurityEvent,
    onMemoryFlush: (kbConfig?.autoFlush ?? true) ? (key, flush) => {
      if (flush.droppedMessages.length === 0) return;

      const timestamp = new Date().toISOString().slice(0, 10);
      const maxEntryChars = Math.max(200, kbConfig?.maxEntryChars ?? 2000);
      const isCodeSessionConversation = key.channel === 'code-session' && key.userId.startsWith('code-session:');
      const codeSessionId = isCodeSessionConversation ? key.userId.slice('code-session:'.length) : undefined;
      const codeSession = codeSessionId ? codeSessionStore.getSession(codeSessionId) : null;
      const continuityUserId = codeSession?.ownerUserId ?? key.userId;
      const continuity = continuityThreadStore.get({
        assistantId: key.agentId,
        userId: continuityUserId,
      });
      const pendingAction = !isCodeSessionConversation
        ? pendingActionStore.resolveActiveForSurface({
            agentId: key.agentId,
            userId: key.userId,
            channel: key.channel,
            surfaceId: key.userId,
          })
        : null;
      const continuitySummary = summarizeContinuityThreadForGateway(continuity);
      const pendingActionSummary = pendingAction
        ? {
            blockerKind: pendingAction.blocker.kind,
            prompt: pendingAction.blocker.prompt,
            route: pendingAction.intent.route,
            operation: pendingAction.intent.operation,
          }
        : null;
      const codeSessionSummary = codeSession
        ? {
            codeSessionId: codeSession.id,
            title: codeSession.title,
            focusSummary: codeSession.workState.focusSummary,
            planSummary: codeSession.workState.planSummary,
            compactedSummary: codeSession.workState.compactedSummary,
            pendingApprovalCount: codeSession.workState.pendingApprovals.length,
          }
        : null;
      const flushScope = inferMemoryFlushScope(codeSessionSummary);
      const maintenanceMetadata: Record<string, unknown> = buildMemoryFlushMaintenanceMetadata({
        key,
        flush,
        continuity: continuitySummary,
        pendingAction: pendingActionSummary,
        codeSession: codeSessionSummary,
      }) as unknown as Record<string, unknown>;
      const flushJob = jobTracker.start({
        type: 'memory_hygiene.context_flush',
        source: 'system',
        detail: `Context flush captured ${flush.newlyDroppedCount} line${flush.newlyDroppedCount === 1 ? '' : 's'}`,
        metadata: maintenanceMetadata,
      });
      const memoryEntry = buildMemoryFlushEntry({
        key,
        flush,
        createdAt: timestamp,
        maxEntryChars,
        continuity: continuitySummary,
        pendingAction: pendingActionSummary,
        codeSession: codeSessionSummary,
      });
      if (!memoryEntry) {
        jobTracker.succeed(flushJob.id, {
          detail: describeMemoryFlushSkipDetail({
            scope: flushScope,
            reason: 'empty_entry',
            codeSessionId,
            newlyDroppedCount: flush.newlyDroppedCount,
          }),
        });
        return;
      }

      if (isCodeSessionConversation) {
        if (codeSessionMemoryStore.isReadOnly()) {
          jobTracker.succeed(flushJob.id, {
            detail: describeMemoryFlushSkipDetail({
              scope: flushScope,
              reason: 'read_only',
              codeSessionId,
              newlyDroppedCount: flush.newlyDroppedCount,
            }),
          });
          log.debug(
            { codeSessionId, droppedCount: flush.newlyDroppedCount },
            'Memory flush skipped because code-session memory is read-only',
          );
          return;
        }
        try {
          const persisted = memoryMutationServiceRef.current
            ? memoryMutationServiceRef.current.persist({
              target: {
                scope: 'code_session',
                scopeId: codeSessionId!,
                store: codeSessionMemoryStore,
                auditAgentId: key.agentId,
              },
              intent: 'context_flush',
              actor: 'memory-flush',
              entry: memoryEntry,
            })
            : {
              action: 'created' as const,
              reason: 'new_entry' as const,
              entry: codeSessionMemoryStore.append(codeSessionId!, memoryEntry),
            };
          jobTracker.succeed(flushJob.id, {
            detail: persisted.action === 'noop'
              ? describeMemoryFlushDeduplicatedDetail({
                scope: flushScope,
                codeSessionId,
                newlyDroppedCount: flush.newlyDroppedCount,
              })
              : describeMemoryFlushMaintenanceDetail({
                scope: flushScope,
                newlyDroppedCount: flush.newlyDroppedCount,
                summary: persisted.entry.summary,
                codeSessionId,
              }),
          });
          log.debug(
            { codeSessionId, droppedCount: flush.newlyDroppedCount, summary: persisted.entry.summary, action: persisted.action },
            'Memory flush: persisted structured context to code-session memory',
          );
        } catch (err) {
          jobTracker.fail(flushJob.id, err, {
            detail: describeMemoryFlushFailureDetail({
              scope: flushScope,
              codeSessionId,
              newlyDroppedCount: flush.newlyDroppedCount,
            }),
          });
          log.warn(
            { codeSessionId, droppedCount: flush.newlyDroppedCount, err },
            'Memory flush failed for code-session memory',
          );
        }
        return;
      }

      if (agentMemoryStore.isReadOnly()) {
        jobTracker.succeed(flushJob.id, {
          detail: describeMemoryFlushSkipDetail({
            scope: flushScope,
            reason: 'read_only',
            newlyDroppedCount: flush.newlyDroppedCount,
          }),
        });
        log.debug(
          { agentId: key.agentId, droppedCount: flush.newlyDroppedCount },
          'Memory flush skipped because knowledge base is read-only',
        );
        return;
      }
      try {
        const persisted = memoryMutationServiceRef.current
          ? memoryMutationServiceRef.current.persist({
            target: {
              scope: 'global',
              scopeId: key.agentId,
              store: agentMemoryStore,
              auditAgentId: key.agentId,
            },
            intent: 'context_flush',
            actor: 'memory-flush',
            entry: memoryEntry,
          })
          : {
            action: 'created' as const,
            reason: 'new_entry' as const,
            entry: agentMemoryStore.append(key.agentId, memoryEntry),
          };
        jobTracker.succeed(flushJob.id, {
          detail: persisted.action === 'noop'
            ? describeMemoryFlushDeduplicatedDetail({
              scope: flushScope,
              newlyDroppedCount: flush.newlyDroppedCount,
            })
            : describeMemoryFlushMaintenanceDetail({
              scope: flushScope,
              newlyDroppedCount: flush.newlyDroppedCount,
              summary: persisted.entry.summary,
            }),
        });
        log.debug(
          { agentId: key.agentId, droppedCount: flush.newlyDroppedCount, summary: persisted.entry.summary, action: persisted.action },
          'Memory flush: persisted structured context to knowledge base',
        );
      } catch (err) {
        jobTracker.fail(flushJob.id, err, {
          detail: describeMemoryFlushFailureDetail({
            scope: flushScope,
            newlyDroppedCount: flush.newlyDroppedCount,
          }),
        });
        log.warn(
          { agentId: key.agentId, droppedCount: flush.newlyDroppedCount, err },
          'Memory flush failed for knowledge base',
        );
      }
    } : undefined,
  });
  const codeSessionStore = new CodeSessionStore({
    enabled: true,
    sqlitePath: codeSessionDbPath,
    onSecurityEvent: onSQLiteSecurityEvent,
    normalizeAgentId: (agentId?: string | null) => normalizeCodeSessionAgentId(agentId, {
      router,
    }),
  });
  const pendingActionStore = new PendingActionStore({
    enabled: true,
    sqlitePath: pendingActionDbPath,
    onSecurityEvent: onSQLiteSecurityEvent,
  });
  const continuityThreadStore = new ContinuityThreadStore({
    enabled: true,
    sqlitePath: continuityThreadDbPath,
    retentionDays: config.assistant.memory.retentionDays,
    onSecurityEvent: onSQLiteSecurityEvent,
  });
  const executionStore = new ExecutionStore({
    enabled: true,
    sqlitePath: executionDbPath,
    onSecurityEvent: onSQLiteSecurityEvent,
  });
  const secondBrainStore = new SecondBrainStore({
    sqlitePath: secondBrainDbPath,
    onSecurityEvent: onSQLiteSecurityEvent,
  });
  const secondBrainService = new SecondBrainService(secondBrainStore);
  const secondBrainBriefingService = new BriefingService(secondBrainService);
  let secondBrainSyncService: SyncService | undefined;
  secondBrainBriefingService.start();
  const runTimeline = new RunTimelineStore();
  const executionGraphStore = new ExecutionGraphStore({
    persistPath: join(getGuardianBaseDir(), 'execution-graphs.json'),
  });
  const intentRoutingTrace = new IntentRoutingTraceLog(config.routing?.intentTrace);
  let refreshRunTimelineSnapshots: () => void = () => {};
  codeSessionStore.subscribe((event) => {
    if (event.type === 'created' || event.type === 'updated') {
      runTimeline.ingestCodeSession(event.session);
    }
    if ((event.type === 'focus_changed' || event.type === 'portfolio_changed') && event.channel !== 'web') {
      activeWebChannel?.emitDashboardInvalidation(
        ['code-sessions'],
        'code-sessions.focus-changed',
        '/api/code/sessions',
      );
    }
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
  const configuredSandbox = config.assistant.tools.sandbox;
  const configuredWindowsHelper = configuredSandbox?.windowsHelper;
  const sandboxConfig: SandboxConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    ...(configuredSandbox ?? {}),
    degradedFallback: resolveDegradedFallbackConfig(configuredSandbox ?? DEFAULT_SANDBOX_CONFIG),
    resourceLimits: {
      ...DEFAULT_SANDBOX_CONFIG.resourceLimits,
      ...(configuredSandbox?.resourceLimits ?? {}),
    },
    windowsHelper: {
      enabled: configuredWindowsHelper?.enabled ?? DEFAULT_SANDBOX_CONFIG.windowsHelper?.enabled ?? false,
      command: configuredWindowsHelper?.command ?? DEFAULT_SANDBOX_CONFIG.windowsHelper?.command,
      args: configuredWindowsHelper?.args ?? DEFAULT_SANDBOX_CONFIG.windowsHelper?.args,
      timeoutMs: configuredWindowsHelper?.timeoutMs ?? DEFAULT_SANDBOX_CONFIG.windowsHelper?.timeoutMs,
    },
  };
  const buildRuntimeSandboxConfig = (): SandboxConfig => {
    const liveSandbox = configRef.current.assistant.tools.sandbox;
    const liveWindowsHelper = liveSandbox?.windowsHelper;
    return {
      ...DEFAULT_SANDBOX_CONFIG,
      ...(liveSandbox ?? {}),
      degradedFallback: resolveDegradedFallbackConfig(liveSandbox ?? DEFAULT_SANDBOX_CONFIG),
      resourceLimits: {
        ...DEFAULT_SANDBOX_CONFIG.resourceLimits,
        ...(liveSandbox?.resourceLimits ?? {}),
      },
      windowsHelper: {
        enabled: liveWindowsHelper?.enabled ?? DEFAULT_SANDBOX_CONFIG.windowsHelper?.enabled ?? false,
        command: liveWindowsHelper?.command ?? DEFAULT_SANDBOX_CONFIG.windowsHelper?.command,
        args: liveWindowsHelper?.args ?? DEFAULT_SANDBOX_CONFIG.windowsHelper?.args,
        timeoutMs: liveWindowsHelper?.timeoutMs ?? DEFAULT_SANDBOX_CONFIG.windowsHelper?.timeoutMs,
      },
    };
  };
  const sandboxCaps = await detectSandboxCapabilities(sandboxConfig);
  const sandboxHealth = await detectSandboxHealth(sandboxConfig, sandboxCaps);
  const degradedFallbackAllowances = listEnabledDegradedFallbackAllowances(sandboxConfig);
  const degradedFallbackActive = isDegradedSandboxFallbackActive(sandboxConfig, sandboxHealth);
  const strictSandboxLockdown = isStrictSandboxLockdown(sandboxConfig, sandboxHealth);
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
    if (strictSandboxLockdown) {
      log.warn(
        {
          platform: sandboxHealth.platform,
          availability: sandboxHealth.availability,
          backend: sandboxHealth.backend,
        },
        `Strict sandbox mode is blocking risky subprocess-backed tools until a strong sandbox backend is available. ${sandboxUpgradeGuidance}`,
      );
    } else if (sandboxHealth.enforcementMode !== 'strict') {
      const baseMetadata = {
        platform: sandboxHealth.platform,
        availability: sandboxHealth.availability,
        backend: sandboxHealth.backend,
      };
      if (degradedFallbackActive) {
        const allowanceMessage = degradedFallbackAllowances.length > 0
          ? `Explicit degraded-backend overrides are enabled for: ${degradedFallbackAllowances.join(', ')}.`
          : 'Network/search tools, browser automation, third-party MCP servers, install-like package manager commands, and manual code terminals stay blocked until explicitly enabled.';
        log.warn(
          baseMetadata,
          `Permissive sandbox mode is explicitly enabled on a degraded backend. ${allowanceMessage} ${sandboxUpgradeGuidance}`,
        );
      } else {
        log.warn(
          baseMetadata,
          `Permissive sandbox mode is explicitly enabled. ${sandboxUpgradeGuidance}`,
        );
      }
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
  const degradedFallback = resolveDegradedFallbackConfig(sandboxConfig);
  const mcpBlockedBySandbox = strictSandboxLockdown || (degradedFallbackActive && !degradedFallback.allowMcpServers);
  const recordMcpStartupAudit = (
    type: 'action_allowed' | 'action_denied',
    severity: 'info' | 'warn',
    details: Record<string, unknown>,
  ): void => {
    runtime.auditLog.record({
      type,
      severity,
      agentId: 'system',
      controller: 'MCPStartupAdmission',
      details,
    });
  };
  if (mcpConfig?.enabled && allMCPServers.length > 0) {
    if (mcpBlockedBySandbox) {
      const reason = strictSandboxLockdown
        ? 'strict sandbox mode requires strong sandbox availability'
        : 'degraded backend overrides leave third-party MCP servers disabled by default';
      for (const server of allMCPServers) {
        recordMcpStartupAudit('action_denied', 'warn', {
          serverId: server.id,
          serverName: server.name,
          source: server.managedProviderId ? 'managed_provider' : 'third_party',
          reason,
        });
      }
      console.warn(`  MCP servers blocked: ${reason}`);
      log.warn(
        { platform: sandboxHealth.platform, availability: sandboxHealth.availability, strictSandboxLockdown, degradedFallbackActive },
        strictSandboxLockdown
          ? 'Strict sandbox mode is blocking MCP server startup'
          : 'Degraded backend safeguards are blocking third-party MCP server startup',
      );
    } else {
      emitStartupTrace('main:mcp-startup:start');
      mcpManager = new MCPClientManager(sandboxConfig);
      for (const server of allMCPServers) {
        const serverSource = server.managedProviderId ? 'managed_provider' as const : 'third_party' as const;
        const admission = assessMcpStartupAdmission({
          source: serverSource,
          startupApproved: server.startupApproved,
          name: server.name,
        });
        if (!admission.allowed) {
          recordMcpStartupAudit('action_denied', 'warn', {
            serverId: server.id,
            serverName: server.name,
            source: serverSource,
            reason: admission.reason,
          });
          log.warn({ serverId: server.id, serverName: server.name }, admission.reason ?? 'Blocked third-party MCP server startup');
          continue;
        }

        const serverConfig: MCPServerConfig = {
          id: server.id,
          name: server.name,
          transport: 'stdio',
          command: server.command,
          args: server.args,
          env: server.env,
          cwd: server.cwd,
          timeoutMs: server.timeoutMs,
          startupApproved: server.startupApproved,
          source: serverSource,
          category: 'mcp',
          networkAccess: server.networkAccess ?? false,
          inheritEnv: server.inheritEnv ?? false,
          allowedEnvKeys: server.allowedEnvKeys,
          trustLevel: server.trustLevel,
          maxCallsPerMinute: server.maxCallsPerMinute,
        };
        try {
          await mcpManager.addServer(serverConfig);
          recordMcpStartupAudit('action_allowed', 'info', {
            serverId: server.id,
            serverName: server.name,
            source: serverSource,
            networkAccess: serverConfig.networkAccess,
            startupApproved: serverConfig.startupApproved ?? false,
          });
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
      emitStartupTrace('main:mcp-startup:done');
    }
  }

  // ── Browser MCP Providers ──────────────────────────────────
  // Browser tools are MCP-based but should work out of the box without requiring
  // explicit mcp.enabled in config. Create mcpManager if it doesn't exist yet.
  const browserConfig = config.assistant?.tools?.browser;
  const browserBlockedBySandbox = strictSandboxLockdown || (degradedFallbackActive && !degradedFallback.allowBrowserTools);
  if (browserConfig?.enabled !== false && !browserBlockedBySandbox) {
    emitStartupTrace('main:browser-startup:start');
    if (!mcpManager) {
      mcpManager = new MCPClientManager(sandboxConfig);
    }
    // Playwright MCP
    if (browserConfig?.playwrightEnabled !== false) {
      const playwrightLaunch = resolveManagedPlaywrightLaunch(browserConfig);
      try {
        await mcpManager.addServer({
          id: 'playwright',
          name: 'Playwright Browser',
          transport: 'stdio' as const,
          command: playwrightLaunch.command,
          args: playwrightLaunch.args,
          source: 'managed_browser',
          category: 'browser',
          networkAccess: true,
          inheritEnv: false,
          allowedEnvKeys: ['PLAYWRIGHT_BROWSERS_PATH'],
          timeoutMs: 60_000,
          maxCallsPerMinute: 60,
        });
        const pwTools = mcpManager.getClient('playwright')?.getTools().length ?? 0;
        log.info({
          tools: pwTools,
          launchSource: playwrightLaunch.source,
          launchDetail: playwrightLaunch.detail,
        }, 'Playwright MCP browser connected');
        console.log(`  Playwright MCP: connected (${pwTools} tools via ${playwrightLaunch.source})`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn({ err: errMsg }, 'Playwright MCP failed to start — direct Playwright fallback will be used');
        console.log(`  Playwright MCP: failed to start — ${errMsg}`);
        console.log('  Direct Playwright fallback is enabled and will handle browser actions.');
      }
    }
    emitStartupTrace('main:browser-startup:done');

  } else if (browserConfig?.enabled !== false && browserBlockedBySandbox) {
    log.warn(
      {
        platform: sandboxHealth.platform,
        availability: sandboxHealth.availability,
        strictSandboxLockdown,
        degradedFallbackActive,
      },
      strictSandboxLockdown
        ? 'Strict sandbox mode is blocking browser automation startup'
        : 'Degraded backend safeguards are blocking browser automation until explicitly enabled',
    );
  }

  if (!mcpManager) {
    mcpManager = new MCPClientManager(sandboxConfig);
  }

  // ─── Native Skills ───────────────────────────────────────────
  let skillRegistry: SkillRegistry | undefined;
  let skillResolver: SkillResolver | undefined;
  if (config.assistant.skills.enabled) {
    emitStartupTrace('main:skills-load:start');
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
    emitStartupTrace('main:skills-load:done');
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
      const credPath = (googleConfig?.credentialsPath ?? '').replace(/^~/, homedir()) || `${getGuardianBaseDir()}/google-credentials.json`;

      googleAuth = new GoogleAuth({
        credentialsPath: credPath,
        callbackPort: googleConfig?.oauthCallbackPort ?? 18432,
        scopes,
      });

      googleAuth.onAuthFailure = (_service, error) => {
        runtime.auditLog.record({
          type: 'auth_failure',
          severity: 'warn',
          agentId: 'system',
          details: {
            controller: 'GoogleAuth',
            description: `Google token refresh failed: ${error}`,
            service: _service,
            action: 'token_refresh',
          },
        });
      };
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

  // ─── Native Microsoft 365 Service ───────────────────────
  // Always initialize MicrosoftAuth/MicrosoftService so the web UI can trigger
  // the OAuth flow even when native mode isn't explicitly enabled yet.
  const microsoftAuthRef: { current: import('./microsoft/microsoft-auth.js').MicrosoftAuth | null } = { current: null };
  const microsoftServiceRef: { current: import('./microsoft/microsoft-service.js').MicrosoftService | null } = { current: null };
  let microsoftService: import('./microsoft/microsoft-service.js').MicrosoftService | undefined;
  let microsoftAuth: import('./microsoft/microsoft-auth.js').MicrosoftAuth | undefined;
  const microsoftConfig = config.assistant.tools.microsoft;
  if (microsoftConfig?.clientId) {
    try {
      const { MicrosoftAuth, MicrosoftService, MICROSOFT_SERVICE_SCOPES } = await import('./microsoft/index.js');
      const services = microsoftConfig?.services?.length ? microsoftConfig.services : ['mail', 'calendar', 'onedrive', 'contacts'];
      const scopes = services
        .flatMap((s: string) => MICROSOFT_SERVICE_SCOPES[s.toLowerCase()] ?? []);

      microsoftAuth = new MicrosoftAuth({
        clientId: microsoftConfig.clientId,
        tenantId: microsoftConfig.tenantId || 'common',
        callbackPort: microsoftConfig?.oauthCallbackPort ?? 18433,
        scopes,
      });

      microsoftAuth.onAuthFailure = (_service, error) => {
        runtime.auditLog.record({
          type: 'auth_failure',
          severity: 'warn',
          agentId: 'system',
          details: {
            controller: 'MicrosoftAuth',
            description: `Microsoft token refresh failed: ${error}`,
            service: _service,
            action: 'token_refresh',
          },
        });
      };
      await microsoftAuth.loadStoredTokens();
      microsoftService = new MicrosoftService(microsoftAuth, {
        services,
        timeoutMs: microsoftConfig?.timeoutMs,
      });

      // Populate refs for dashboard callback closures.
      microsoftAuthRef.current = microsoftAuth;
      microsoftServiceRef.current = microsoftService;

      // Enable tool routing to native backend if configured.
      if (microsoftConfig?.enabled || microsoftAuth.isAuthenticated()) {
        enabledManagedProviders.add('m365');
        if (microsoftAuth.isAuthenticated()) {
          console.log(`  Microsoft 365: connected (services: ${services.join(', ')})`);
        } else {
          console.log('  Microsoft 365: ready — connect via web UI.');
        }
      }
    } catch (err) {
      console.log(`  Microsoft 365 (native): failed to initialize — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  secondBrainSyncService = new SyncService(secondBrainService, {
    getGoogleService: () => googleServiceRef.current ?? undefined,
    getMicrosoftService: () => microsoftServiceRef.current ?? undefined,
  });
  emitStartupTrace('main:second-brain-sync:start');
  await secondBrainSyncService.start();
  emitStartupTrace('main:second-brain-sync:done');
  let secondBrainHorizonScanner: HorizonScanner | undefined;

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
  const windowsDefender = new WindowsDefenderProvider();
  await windowsDefender.load().catch(() => {});
  sharedPackageInstallTrustService = new PackageInstallTrustService({
    nativeProtectionScanner: new PackageInstallNativeProtectionScanner({
      windowsDefender,
    }),
  });
  await sharedPackageInstallTrustService.load().catch(() => {});
  sharedCodeWorkspaceTrustService = new CodeWorkspaceTrustService({
    codeSessionStore,
    scanner: new CodeWorkspaceNativeProtectionScanner({
      windowsDefender,
    }),
  });
  const containmentService = new ContainmentService();
  const securityActivityLog = new SecurityActivityLogService();
  await securityActivityLog.load().catch(() => {});
  const aiSecurity = new AiSecurityService({
    enabled: true,
    getRuntimeSnapshot: () => {
      const liveSandbox = buildRuntimeSandboxConfig();
      const degradedFallback = resolveDegradedFallbackConfig(liveSandbox);
      const mcpStatusById = new Map((mcpManager?.getStatus() ?? []).map((status) => [status.id, status]));
      const thirdPartyServers = (configRef.current.assistant.tools.mcp?.servers ?? []).map((server) => {
        const status = mcpStatusById.get(server.id);
        return {
          id: server.id,
          name: server.name,
          command: server.command,
          trustLevel: server.trustLevel,
          startupApproved: server.startupApproved === true,
          networkAccess: server.networkAccess === true,
          inheritEnv: server.inheritEnv === true,
          allowedEnvKeyCount: Array.isArray(server.allowedEnvKeys)
            ? server.allowedEnvKeys.filter((value) => typeof value === 'string' && value.trim()).length
            : 0,
          envKeyCount: Object.keys(server.env ?? {}).length,
          connected: status?.state === 'connected',
        };
      });
      return {
        sandbox: {
          enabled: liveSandbox.enabled !== false,
          availability: sandboxHealth.availability,
          enforcementMode: liveSandbox.enforcementMode ?? sandboxHealth.enforcementMode ?? 'permissive',
          backend: sandboxHealth.backend,
          degradedFallbackActive: isDegradedSandboxFallbackActive(liveSandbox, sandboxHealth),
          degradedFallback,
        },
        browser: {
          enabled: configRef.current.assistant.tools.browser?.enabled ?? true,
          allowedDomains: configRef.current.assistant.tools.browser?.allowedDomains ?? configRef.current.assistant.tools.allowedDomains,
          playwrightEnabled: configRef.current.assistant.tools.browser?.playwrightEnabled ?? true,
        },
        mcp: {
          enabled: configRef.current.assistant.tools.mcp?.enabled ?? false,
          configuredThirdPartyServerCount: thirdPartyServers.length,
          connectedThirdPartyServerCount: thirdPartyServers.filter((server) => server.connected).length,
          managedProviderIds: Object.entries(configRef.current.assistant.tools.mcp?.managedProviders ?? {})
            .filter(([, value]) => value && typeof value === 'object' && (value as { enabled?: boolean }).enabled !== false)
            .map(([id]) => id),
          usesDynamicPlaywrightPackage: false,
          thirdPartyServers,
        },
        agentPolicyUpdates: {
          allowedPaths: configRef.current.assistant.tools.agentPolicyUpdates?.allowedPaths ?? false,
          allowedCommands: configRef.current.assistant.tools.agentPolicyUpdates?.allowedCommands ?? false,
          allowedDomains: configRef.current.assistant.tools.agentPolicyUpdates?.allowedDomains ?? false,
          toolPolicies: configRef.current.assistant.tools.agentPolicyUpdates?.toolPolicies ?? false,
        },
      };
    },
    listCodeSessions: () => codeSessionStore
      .listAllSessions()
      .map((session) => createAiSecuritySessionSnapshot(sharedCodeWorkspaceTrustService?.maybeSchedule(session) ?? session)),
  });
  await aiSecurity.load().catch(() => {});
  const getAssistantSecurityWorkspaceTargetIds = (profileId: string, selectedTargetIds?: string[]) => {
    const profile = aiSecurity.getProfiles().find((entry) => entry.id === profileId);
    if (!profile?.targetTypes.includes('workspace')) return [];

    const explicitWorkspaceTargetIds = Array.isArray(selectedTargetIds)
      ? selectedTargetIds.filter((value): value is string => typeof value === 'string' && value.startsWith('workspace:'))
      : [];
    if (explicitWorkspaceTargetIds.length > 0) {
      return [...new Set(explicitWorkspaceTargetIds)];
    }

    return aiSecurity.listTargets()
      .filter((target) => target.type === 'workspace')
      .map((target) => target.id);
  };
  const updateAssistantSecurityCodeSessionChecks = (
    result: Awaited<ReturnType<AiSecurityService['scan']>>,
    profileId: string,
    selectedTargetIds?: string[],
  ) => {
    const workspaceTargetIds = getAssistantSecurityWorkspaceTargetIds(profileId, selectedTargetIds);
    if (workspaceTargetIds.length === 0) return;

    const findingsByTarget = new Map<string, typeof result.findings>();
    for (const finding of result.findings) {
      if (finding.targetType !== 'workspace') continue;
      const existing = findingsByTarget.get(finding.targetId) ?? [];
      existing.push(finding);
      findingsByTarget.set(finding.targetId, existing);
    }

    const severityRank = { critical: 4, high: 3, medium: 2, low: 1 } as const;
    for (const targetId of workspaceTargetIds) {
      const sessionId = targetId.slice('workspace:'.length);
      if (!sessionId) continue;

      const session = codeSessionStore.getSession(sessionId);
      if (!session) continue;
      const relatedSessions = codeSessionStore.listAllSessions()
        .filter((candidate) => candidate.resolvedRoot === session.resolvedRoot);

      const findings = findingsByTarget.get(targetId) ?? [];
      const highest = findings.reduce<typeof result.findings[number] | null>((current, finding) => {
        if (!current) return finding;
        return severityRank[finding.severity] > severityRank[current.severity] ? finding : current;
      }, null);
      const status: 'pass' | 'warn' | 'fail' | 'not_run' = highest
        ? (highest.severity === 'critical' || highest.severity === 'high' ? 'fail' : 'warn')
        : 'pass';
      const summary = highest
        ? `${findings.length} finding${findings.length === 1 ? '' : 's'} (${highest.severity} highest): ${highest.title}`
        : `No Assistant Security findings in the latest '${profileId}' scan.`;
      for (const relatedSession of relatedSessions) {
        const verification = [
          ...relatedSession.workState.verification.filter((entry) => entry.id !== 'assistant-security'),
          {
            id: 'assistant-security',
            kind: 'manual' as const,
            status,
            summary,
            timestamp: result.run.completedAt,
          },
        ].sort((left, right) => right.timestamp - left.timestamp);

        codeSessionStore.updateSession({
          sessionId: relatedSession.id,
          ownerUserId: relatedSession.ownerUserId,
          workState: {
            verification,
          },
        });
      }
    }
  };
  const runAssistantSecurityScan = async (input: {
    profileId?: string;
    targetIds?: string[];
    source?: 'manual' | 'scheduled' | 'system';
    requestedBy?: string;
  }) => {
    const profileId = input.profileId?.trim() || 'quick';
    const targetIds = Array.isArray(input.targetIds)
      ? input.targetIds.filter((value): value is string => !!value?.trim()).map((value) => value.trim())
      : undefined;
    const source = input.source ?? 'manual';

    securityActivityLog.record({
      agentId: 'assistant-security',
      status: 'started',
      severity: 'info',
      title: 'Assistant security scan started',
      summary: `Running '${profileId}' against ${targetIds?.length ? `${targetIds.length} selected target(s)` : 'default target set'}.`,
      triggerEventType: 'assistant_security_scan_started',
      details: {
        profileId,
        targetIds,
        source,
        requestedBy: input.requestedBy,
      },
    });

    return jobTracker.run(
      {
        type: 'assistant_security.scan',
        source,
        detail: `Assistant security scan (${profileId})`,
        metadata: {
          profileId,
          targetIds,
          requestedBy: input.requestedBy,
        },
      },
      async () => {
        try {
          const result = await aiSecurity.scan({
            profileId,
            targetIds,
            source,
          });
          updateAssistantSecurityCodeSessionChecks(result, profileId, targetIds);

          analytics.track({
            type: result.success ? 'assistant_security_scan' : 'assistant_security_scan_failed',
            channel: 'system',
            canonicalUserId: configRef.current.assistant.identity.primaryUserId,
            metadata: {
              profileId,
              targetIds,
              findingCount: result.findings.length,
              highOrCriticalCount: result.promotedFindings.length,
              success: result.success,
              requestedBy: input.requestedBy,
            },
          });

          securityActivityLog.record({
            agentId: 'assistant-security',
            status: result.success ? 'completed' : 'failed',
            severity: result.promotedFindings.length > 0 ? 'warn' : 'info',
            title: result.success ? 'Assistant security scan completed' : 'Assistant security scan failed',
            summary: result.message,
            triggerEventType: result.success ? 'assistant_security_scan_completed' : 'assistant_security_scan_failed',
            details: {
              profileId,
              runId: result.run.id,
              findingCount: result.findings.length,
              highOrCriticalCount: result.promotedFindings.length,
              requestedBy: input.requestedBy,
            },
          });

          for (const finding of result.promotedFindings.slice(0, 10)) {
            runtime.auditLog.record({
              type: 'anomaly_detected',
              severity: finding.severity === 'critical' ? 'critical' : 'warn',
              agentId: 'assistant-security',
              details: {
                source: 'assistant_security_scan',
                anomalyType: `assistant_security_${finding.category}`,
                description: `${finding.title}: ${finding.summary}`,
                evidence: {
                  findingId: finding.id,
                  targetId: finding.targetId,
                  targetLabel: finding.targetLabel,
                  severity: finding.severity,
                  confidence: finding.confidence,
                  profileId,
                  runId: result.run.id,
                },
              },
            });
          }

          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          securityActivityLog.record({
            agentId: 'assistant-security',
            status: 'failed',
            severity: 'warn',
            title: 'Assistant security scan failed',
            summary: message,
            triggerEventType: 'assistant_security_scan_failed',
            details: {
              profileId,
              targetIds,
              source,
              requestedBy: input.requestedBy,
            },
          });
          throw err;
        }
      },
    );
  };

  let lastNetworkAlertEmitAt = 0;
  let lastWindowsDefenderAlertEmitAt = 0;
  let hostMonitorInterval: ReturnType<typeof setInterval> | null = null;
  let gatewayMonitorInterval: ReturnType<typeof setInterval> | null = null;
  let lastHostMonitorTriggeredAt = 0;
  let lastGatewayMonitorTriggeredAt = 0;

  const getSecurityContainmentInputs = () => {
    const configuredSecurity = configRef.current.assistant.security;
    const profile = configuredSecurity?.deploymentProfile ?? DEFAULT_DEPLOYMENT_PROFILE;
    const currentMode = configuredSecurity?.operatingMode ?? DEFAULT_SECURITY_OPERATING_MODE;
    const assistantAutoContainment = configuredSecurity?.autoContainment;
    const alerts = collectUnifiedSecurityAlerts({
      hostMonitor,
      networkBaseline,
      gatewayMonitor,
      windowsDefender,
      assistantSecurity: aiSecurity,
      packageInstallTrust: sharedPackageInstallTrustService,
      includeAcknowledged: false,
      includeInactive: false,
      assistantVisibility: 'all',
    });
    const posture = assessSecurityPosture({
      profile,
      currentMode,
      alerts,
      availableSources: availableSecurityAlertSources({
        hostMonitor,
        networkBaseline,
        gatewayMonitor,
        windowsDefender,
        assistantSecurity: aiSecurity,
        packageInstallTrust: sharedPackageInstallTrustService,
      }),
    });
    return { profile, currentMode, alerts, posture, assistantAutoContainment };
  };

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

      runtime.eventBus.emit({
        type: 'security:host:alert',
        sourceAgentId: 'host-monitor',
        targetAgentId: '*',
        payload: {
          source,
          alert,
          report: {
            baselineReady: report.baselineReady,
            snapshot: report.snapshot,
          },
        },
        timestamp: now,
      }).catch(() => {});
    }
    await runWindowsDefenderRefresh(`host-monitor:${source}`).catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), source }, 'Windows Defender refresh failed during host monitoring');
    });
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

      runtime.eventBus.emit({
        type: 'security:gateway:alert',
        sourceAgentId: 'gateway-monitor',
        targetAgentId: '*',
        payload: {
          source,
          alert,
          report: {
            baselineReady: report.baselineReady,
            gatewayCount: report.gateways.length,
          },
        },
        timestamp: now,
      }).catch(() => {});
    }
    return report;
  };

  const runWindowsDefenderRefresh = async (source: string) => {
    const status = await windowsDefender.refreshStatus();
    const now = Date.now();
    const freshAlerts = windowsDefender
      .listAlerts({ includeAcknowledged: false, includeInactive: false, limit: 200 })
      .filter((alert) => alert.lastSeenAt > lastWindowsDefenderAlertEmitAt);

    for (const alert of freshAlerts) {
      const severity = alert.severity === 'critical'
        ? 'critical'
        : alert.severity === 'high' || alert.severity === 'medium'
          ? 'warn'
          : 'info';
      runtime.auditLog.record({
        type: 'host_alert',
        severity,
        agentId: 'windows-defender',
        details: {
          source: 'windows_defender',
          alertType: alert.type,
          description: alert.description,
          hostSeverity: alert.severity,
          dedupeKey: alert.dedupeKey,
          evidence: alert.evidence,
        },
      });

      runtime.eventBus.emit({
        type: 'security:native:provider',
        sourceAgentId: 'windows-defender',
        targetAgentId: '*',
        payload: {
          source,
          provider: status.provider,
          alert,
          status,
        },
        timestamp: now,
      }).catch(() => {});
    }

    if (freshAlerts.length > 0) {
      lastWindowsDefenderAlertEmitAt = Math.max(lastWindowsDefenderAlertEmitAt, ...freshAlerts.map((alert) => alert.lastSeenAt));
    } else {
      lastWindowsDefenderAlertEmitAt = Math.max(lastWindowsDefenderAlertEmitAt, status.lastUpdatedAt || now);
    }
    return status;
  };

  await runWindowsDefenderRefresh('startup').catch((err) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Initial Windows Defender refresh failed');
  });

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

  const isPathInsideRoot = (candidate: string, root: string): boolean => {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  };

  const classifySkillBundlePath = (
    skill: NonNullable<ReturnType<SkillRegistry['get']>>,
    rawPath: unknown,
  ): 'instruction' | 'reference' | 'template' | 'script' | 'asset' | 'bundle' | null => {
    if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
    const resolvedPath = resolve(rawPath);
    if (!isPathInsideRoot(resolvedPath, skill.rootDir)) return null;
    if (resolvedPath === skill.instructionPath) return 'instruction';

    const classifiedDirs: Array<{ dir: string; type: 'reference' | 'template' | 'script' | 'asset' }> = [
      { dir: join(skill.rootDir, 'references'), type: 'reference' },
      { dir: join(skill.rootDir, 'templates'), type: 'template' },
      { dir: join(skill.rootDir, 'scripts'), type: 'script' },
      { dir: join(skill.rootDir, 'assets'), type: 'asset' },
    ];
    for (const entry of classifiedDirs) {
      if (isPathInsideRoot(resolvedPath, entry.dir)) return entry.type;
    }
    return 'bundle';
  };

  const trackSkillToolTelemetry = (
    toolName: string,
    args: Record<string, unknown>,
    result: { success: boolean; status: string; message?: string; durationMs: number; error?: string; approvalId?: string },
    request: ToolExecutionRequest,
  ) => {
    if (!analytics || !skillRegistry || !Array.isArray(request.activeSkills) || request.activeSkills.length === 0) return;
    const skillIds = [...new Set(request.activeSkills.filter((value) => typeof value === 'string' && value.trim()))];
    if (skillIds.length === 0) return;

    if (toolName === 'fs_read') {
      for (const skillId of skillIds) {
        const skill = skillRegistry.get(skillId);
        if (!skill) continue;
        const pathType = classifySkillBundlePath(skill, args.path);
        if (!pathType) continue;
        analytics.track({
          type: 'skill_read',
          channel: request.channel,
          canonicalUserId: request.userId,
          channelUserId: request.userId,
          agentId: request.agentId,
          metadata: {
            skillId,
            pathType,
            path: typeof args.path === 'string' ? resolve(args.path) : null,
          },
        });
      }
      return;
    }

    for (const skillId of skillIds) {
      analytics.track({
        type: 'skill_tool_executed',
        channel: request.channel,
        canonicalUserId: request.userId,
        channelUserId: request.userId,
        agentId: request.agentId,
        metadata: {
          skillId,
          toolName,
          toolStatus: result.status,
        },
      });
    }
  };

  // ─── Message router ────────────────────────────────────────
  const router = new MessageRouter(config.routing);
  const resolveSharedStateAgentId = (agentId?: string): string | undefined => resolveAgentStateId(agentId, {
    localAgentId: router.findAgentByRole('local')?.id,
    externalAgentId: router.findAgentByRole('external')?.id,
  });
  const resolveCurrentDefaultAgentId = (): string => (
    configRef.current.agents[0]?.id
    ?? router.findAgentByRole('local')?.id
    ?? router.findAgentByRole('external')?.id
    ?? 'default'
  );
  const resolveConfiguredDispatchAgentId = (agentId?: string): string | undefined => resolveConfiguredAgentId(agentId, {
    defaultAgentId: resolveCurrentDefaultAgentId(),
    router,
    hasAgent: (targetAgentId: string) => runtime.registry.has(targetAgentId),
  });
  let connectors: ConnectorPlaybookService;
  let listConfiguredLlmProvidersForTools: ToolExecutorOptions['listLlmProviders'];
  let listModelsForConfiguredLlmProviderForTools: ToolExecutorOptions['listModelsForLlmProvider'];
  let applyDirectLlmProviderConfigUpdateForTools: ToolExecutorOptions['onLlmProviderConfigUpdate'];
  const codingBackendServiceRef: { current: CodingBackendService | null } = { current: null };
  const resolveSecondBrainToolInvalidation = (
    toolName: string,
    result: { success: boolean },
  ): { topics: string[]; reason: string; path: string } | null => {
    if (!result.success) return null;
    switch (toolName) {
      case 'second_brain_generate_brief':
        return { topics: ['second-brain'], reason: 'second-brain.brief.generated', path: '/api/second-brain/briefs/generate' };
      case 'second_brain_brief_upsert':
        return { topics: ['second-brain'], reason: 'second-brain.brief.upserted', path: '/api/second-brain/briefs/upsert' };
      case 'second_brain_brief_update':
        return { topics: ['second-brain'], reason: 'second-brain.brief.updated', path: '/api/second-brain/briefs/update' };
      case 'second_brain_brief_delete':
        return { topics: ['second-brain'], reason: 'second-brain.brief.deleted', path: '/api/second-brain/briefs/delete' };
      case 'second_brain_calendar_upsert':
        return { topics: ['second-brain'], reason: 'second-brain.calendar.upserted', path: '/api/second-brain/calendar/upsert' };
      case 'second_brain_calendar_delete':
        return { topics: ['second-brain'], reason: 'second-brain.calendar.deleted', path: '/api/second-brain/calendar/delete' };
      case 'second_brain_task_upsert':
        return { topics: ['second-brain'], reason: 'second-brain.task.upserted', path: '/api/second-brain/tasks/upsert' };
      case 'second_brain_task_delete':
        return { topics: ['second-brain'], reason: 'second-brain.task.deleted', path: '/api/second-brain/tasks/delete' };
      case 'second_brain_note_upsert':
        return { topics: ['second-brain'], reason: 'second-brain.note.upserted', path: '/api/second-brain/notes/upsert' };
      case 'second_brain_note_delete':
        return { topics: ['second-brain'], reason: 'second-brain.note.deleted', path: '/api/second-brain/notes/delete' };
      case 'second_brain_person_upsert':
        return { topics: ['second-brain'], reason: 'second-brain.person.upserted', path: '/api/second-brain/people/upsert' };
      case 'second_brain_person_delete':
        return { topics: ['second-brain'], reason: 'second-brain.person.deleted', path: '/api/second-brain/people/delete' };
      case 'second_brain_library_upsert':
        return { topics: ['second-brain'], reason: 'second-brain.link.upserted', path: '/api/second-brain/links/upsert' };
      case 'second_brain_library_delete':
        return { topics: ['second-brain'], reason: 'second-brain.link.deleted', path: '/api/second-brain/links/delete' };
      case 'second_brain_routine_create':
        return { topics: ['second-brain'], reason: 'second-brain.routine.created', path: '/api/second-brain/routines/create' };
      case 'second_brain_routine_update':
        return { topics: ['second-brain'], reason: 'second-brain.routine.updated', path: '/api/second-brain/routines/update' };
      case 'second_brain_routine_delete':
        return { topics: ['second-brain'], reason: 'second-brain.routine.deleted', path: '/api/second-brain/routines/delete' };
      default:
        return null;
    }
  };
  const performanceService = new PerformanceService({
    adapter: createPerformanceAdapter(),
    getConfig: () => configRef.current,
    auditLog: runtime.auditLog,
  });

  let deliverMessageClosure: ToolExecutorOptions['deliverMessage'] = undefined;
  const recordApprovedToolExecutionForRouting = (
    toolName: string,
    args: Record<string, unknown>,
    result: {
      success: boolean;
      status: string;
      message?: string;
      durationMs: number;
      error?: string;
      approvalId?: string;
    },
    request: ToolExecutionRequest,
  ): void => {
    const approvalId = result.approvalId?.trim();
    if (!approvalId || request.origin !== 'assistant') return;

    const pendingAction = pendingActionStore.findActiveByApprovalId(approvalId);
    const approvalSummary = pendingAction?.blocker.approvalSummaries?.find((summary) => summary.id === approvalId);
    const requestId = approvalSummary?.requestId?.trim()
      || request.requestId?.trim()
      || pendingAction?.executionId
      || result.approvalId
      || `${toolName}:${Date.now()}`;
    const timestamp = Date.now();
    const resultStatus = result.success
      ? 'succeeded'
      : result.status === 'denied'
        ? 'denied'
        : 'failed';
    const resultMessage = result.message?.trim()
      || result.error?.trim()
      || (result.success ? `Tool '${toolName}' completed.` : `Tool '${toolName}' failed.`);
    const eventId = `approval:${approvalId}:${toolName}:completed`;
    const nodeId = `${toolName}:approval:${approvalId}`;
    const toolCallId = `approval:${approvalId}`;
    const channel = pendingAction?.scope.channel || request.channel || 'web';
    const userId = pendingAction?.scope.userId || request.userId;
    const agentId = request.agentId || pendingAction?.scope.agentId || 'default';
    const originSurfaceId = pendingAction?.scope.surfaceId || request.surfaceId;
    const payload = {
      toolName,
      approvalId,
      args,
      resultStatus,
      resultMessage,
      ...(result.error ? { errorMessage: result.error } : {}),
    };

    intentRoutingTrace.record({
      stage: 'delegated_tool_call_completed',
      requestId,
      messageId: requestId,
      userId,
      channel,
      agentId,
      contentPreview: toolName,
      details: {
        ...(originSurfaceId ? { originSurfaceId } : {}),
        ...(pendingAction?.executionId ? { executionId: pendingAction.executionId } : {}),
        ...(pendingAction?.rootExecutionId ? { rootExecutionId: pendingAction.rootExecutionId } : {}),
        ...(pendingAction?.codeSessionId ? { codeSessionId: pendingAction.codeSessionId } : {}),
        ...(pendingAction?.id ? { pendingActionId: pendingAction.id } : {}),
        eventId,
        eventType: 'tool_call_completed',
        nodeId,
        toolCallId,
        ...payload,
      },
    });

    runTimeline.ingestDelegatedExecutionEvents({
      parentRunId: pendingAction?.executionId ?? requestId,
      taskRunId: request.requestId?.trim() || requestId,
      parentExecutionId: pendingAction?.executionId ?? requestId,
      taskExecutionId: request.requestId?.trim(),
      rootExecutionId: pendingAction?.rootExecutionId ?? pendingAction?.executionId ?? requestId,
      codeSessionId: pendingAction?.codeSessionId ?? request.codeContext?.sessionId,
      agentId,
      channel,
      events: [{
        eventId,
        nodeId,
        type: 'tool_call_completed' as const,
        timestamp,
        payload,
      }],
    });
  };

  const toolExecutorOptions: ToolExecutorOptions = {
    enabled: config.assistant.tools.enabled,
    workspaceRoot: process.cwd(),
    policyMode: config.assistant.tools.policyMode,
    toolPolicies: config.assistant.tools.toolPolicies,
    allowedPaths: config.assistant.tools.allowedPaths,
    allowedCommands: config.assistant.tools.allowedCommands,
    allowedDomains: config.assistant.tools.allowedDomains,
    allowExternalPosting: config.assistant.tools.allowExternalPosting,
    deliverMessage: async (channel, targetId, content) => {
      if (deliverMessageClosure) {
        return deliverMessageClosure(channel, targetId, content);
      }
      return { success: false, error: 'Channel delivery is not initialized.' };
    },
    agentPolicyUpdates: config.assistant.tools.agentPolicyUpdates,
    listLlmProviders: async () => listConfiguredLlmProvidersForTools?.() ?? [],
    listModelsForLlmProvider: async (providerName) => {
      if (!listModelsForConfiguredLlmProviderForTools) {
        throw new Error('LLM model discovery is not available in this runtime.');
      }
      return listModelsForConfiguredLlmProviderForTools(providerName);
    },
    onLlmProviderConfigUpdate: async (updates) => {
      if (!applyDirectLlmProviderConfigUpdateForTools) {
        return {
          success: false,
          message: 'LLM provider updates are not available in this runtime.',
        };
      }
      return applyDirectLlmProviderConfigUpdateForTools(updates);
    },
    onApprovalDecided: async (approvalId, decision, result) => {
      await connectors?.continueAfterApprovalDecision(approvalId, decision, result);
    },
    onToolExecuted: (toolName, args, result, request) => {
      recordApprovedToolExecutionForRouting(toolName, args, result, request);
      runtime.eventBus.emit({
        type: 'tool.executed',
        sourceAgentId: request.agentId ?? 'system',
        targetAgentId: '*',
        timestamp: Date.now(),
        payload: { toolName, args, result, requestId: request.requestId },
      });
      trackSkillToolTelemetry(toolName, args, result, request);
      const secondBrainInvalidation = resolveSecondBrainToolInvalidation(toolName, result);
      if (secondBrainInvalidation) {
        activeWebChannel?.emitDashboardInvalidation(
          secondBrainInvalidation.topics,
          secondBrainInvalidation.reason,
          secondBrainInvalidation.path,
        );
      }

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
        'shell_safe', 'package_install', 'net_connections', 'sys_processes',
        'performance_status_get', 'performance_action_preview', 'performance_action_run', 'performance_profile_apply',
        'browser_navigate', 'browser_read', 'browser_links', 'browser_extract', 'browser_state', 'browser_act', 'browser_interact',
        'mcp-playwright-browser_navigate', 'mcp-playwright-browser_click',
        'mcp-playwright-browser_type', 'mcp-playwright-browser_evaluate',
        'mcp-playwright-browser_run_code', 'mcp-playwright-browser_file_upload',
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
    onPolicyUpdate: (policy, meta) => {
      // Persist policy changes to config.yaml so they survive reloads and restarts
      try {
        const verification = controlPlaneIntegrity.verifyFileSync(configPath, {
          adoptUntracked: true,
          updatedBy: 'tool_policy_update',
        });
        if (!verification.ok) {
          throw new Error(verification.message);
        }
        const raw: Record<string, unknown> = existsSync(configPath)
          ? (yaml.load(readFileSync(configPath, 'utf-8'), { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>) ?? {}
          : {};
        raw.assistant = raw.assistant ?? {};
        const a = raw.assistant as Record<string, unknown>;
        a.tools = (a.tools as Record<string, unknown>) ?? {};
        const t = a.tools as Record<string, unknown>;
        t.allowedPaths = policy.sandbox.allowedPaths;
        t.allowedCommands = policy.sandbox.allowedCommands;
        t.allowedDomains = policy.sandbox.allowedDomains;
        if (meta?.browserAllowedDomains) {
          t.browser = (t.browser as Record<string, unknown> | undefined) ?? {};
          (t.browser as Record<string, unknown>).allowedDomains = meta.browserAllowedDomains;
        }
        writeSecureFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }));
        controlPlaneIntegrity.signFileSync(configPath, 'tool_policy_update');
        configRef.current = loadConfig(configPath, {
          integrity: controlPlaneIntegrity,
          adoptUntrackedIntegrity: true,
        });
        syncLiveToolPolicyFromConfig(toolExecutor, runtime, configRef.current.assistant.tools);
        if (meta?.browserAllowedDomains) {
          void applyBrowserRuntimeConfig(configRef.current.assistant.tools.browser).catch((err) => {
            log.warn({ err }, 'Failed to apply browser allowlist update live after policy approval');
          });
        }
      } catch (err) {
        log.warn({ err }, 'Failed to persist policy update to config file');
      }
    },
    webSearch: resolvedRuntimeCredentials.resolvedWebSearch,
    cloudConfig: resolvedRuntimeCredentials.resolvedCloud,
    browserConfig: config.assistant.tools.browser,
    enableDirectPlaywrightFallback: true,
    disabledCategories: config.assistant.tools.disabledCategories,
    conversationService: conversations,
    agentMemoryStore,
    automationOutputStore,
    codeSessionMemoryStore,
    codeSessionStore,
    persistMemoryEntry: (input) => (
      memoryMutationServiceRef.current?.persist(input)
        ?? {
          action: 'created' as const,
          reason: 'new_entry' as const,
          entry: input.target.store.append(input.target.scopeId, input.entry),
        }
    ),
    resolveStateAgentId: resolveSharedStateAgentId,
    docSearch,
    secondBrainService,
    performanceService,
    secondBrainBriefingService,
    secondBrainHorizonScanner,
    googleService,
    microsoftService,
    deviceInventory,
    networkBaseline,
    networkTraffic,
    hostMonitor,
    runHostMonitorCheck: runHostMonitoring,
    gatewayMonitor,
    runGatewayMonitorCheck: runGatewayMonitoring,
    windowsDefender,
    containmentService,
    codingBackendService: undefined,
    networkConfig: config.assistant.network,
    mcpManager,
    sandboxConfig,
    sandboxHealth,
    threatIntel,
    assistantSecurity: aiSecurity,
    packageInstallTrust: sharedPackageInstallTrustService,
    runAssistantSecurityScan,
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
        external_post: ['network_access'],
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
      const containmentDecision = containmentService.shouldAllowAction({
        ...getSecurityContainmentInputs(),
        action: {
          type: action.type,
          toolName: action.toolName,
          category: action.category,
          scheduled: !!action.scheduleId,
          origin: action.origin,
        },
      });
      if (!containmentDecision.allowed) {
        runtime.auditLog.record({
          type: 'action_denied',
          severity: containmentDecision.state.effectiveMode === 'lockdown' ? 'critical' : 'warn',
          agentId: action.agentId,
          controller: 'ContainmentService',
          details: {
            actionType: action.type,
            toolName: action.toolName,
            reason: containmentDecision.reason,
            matchedAction: containmentDecision.matchedAction,
            currentMode: containmentDecision.state.currentMode,
            effectiveMode: containmentDecision.state.effectiveMode,
            recommendedMode: containmentDecision.state.recommendedMode,
            autoElevated: containmentDecision.state.autoElevated,
            source: 'containment_service',
          },
        });
        return { allowed: false, reason: containmentDecision.reason };
      }

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

  // Log browser backend status at startup
  {
    const browserCaps = toolExecutor.getBrowserCapabilities();
    const status = browserCaps.available
      ? `read=${browserCaps.read}, interact=${browserCaps.interact}`
      : 'unavailable';
    const details = [
      `directBackend=${browserCaps.directBackend}`,
      `mcpTools=${browserCaps.mcpTools}`,
    ].join(', ');
    console.log(`  Browser backends: ${status} (${details})`);
    log.info({ browserCaps }, 'Browser backend capabilities at startup');
  }

  const applyBrowserRuntimeConfig = async (
    nextBrowserConfig: BrowserConfig | undefined,
  ): Promise<{ success: boolean; message: string }> => {
    const normalized = nextBrowserConfig ?? { enabled: true };
    const blockedBySandbox = strictSandboxLockdown || (degradedFallbackActive && !degradedFallback.allowBrowserTools);

    mcpManager ??= new MCPClientManager(sandboxConfig);
    for (const serverId of ['playwright']) {
      mcpManager.removeServer(serverId);
    }

    toolExecutor.setBrowserConfig(normalized);

    if (normalized.enabled === false) {
      toolExecutor.refreshDynamicMcpTooling();
      log.info({ browser: normalized }, 'Browser config updated and applied live');
      return { success: true, message: 'Browser tools disabled and applied live.' };
    }

    if (blockedBySandbox) {
      toolExecutor.refreshDynamicMcpTooling();
      const reason = strictSandboxLockdown
        ? 'strict sandbox mode is blocking browser automation startup'
        : 'degraded backend safeguards are blocking browser automation until allowBrowserTools is enabled';
      log.warn(
        { browser: normalized, strictSandboxLockdown, degradedFallbackActive },
        'Browser config saved, but live browser startup is blocked by sandbox policy',
      );
      return { success: false, message: `Browser config saved, but live reload is blocked because ${reason}.` };
    }

    const issues: string[] = [];
    if (normalized.playwrightEnabled !== false) {
      const playwrightLaunch = resolveManagedPlaywrightLaunch(normalized);
      try {
        await mcpManager.addServer({
          id: 'playwright',
          name: 'Playwright Browser',
          transport: 'stdio',
          command: playwrightLaunch.command,
          args: playwrightLaunch.args,
          source: 'managed_browser',
          category: 'browser',
          networkAccess: true,
          inheritEnv: false,
          timeoutMs: 60_000,
          maxCallsPerMinute: 60,
        });
      } catch (err) {
        issues.push(`Playwright failed to start: ${err instanceof Error ? err.message : String(err)}.`);
      }
    }

    toolExecutor.refreshDynamicMcpTooling();

    const activeBackends = [
      mcpManager.getClient('playwright')?.getState() === 'connected' ? 'Playwright' : null,
    ].filter((value): value is string => !!value);

    log.info({ browser: normalized, activeBackends, issues }, 'Browser config updated and applied live');

    if (issues.length > 0) {
      return {
        success: false,
        message: `Browser config saved, but live reload is degraded. ${issues.join(' ')}${activeBackends.length > 0 ? ` Active now: ${activeBackends.join(', ')}.` : ''}`,
      };
    }
    if (activeBackends.length === 0) {
      return {
        success: false,
        message: 'Browser config saved, but no browser backend could be started live.',
      };
    }
    return {
      success: true,
      message: `Browser config applied live. Active now: ${activeBackends.join(', ')}.`,
    };
  };

  if (config.runtime.agentIsolation.enabled && config.runtime.agentIsolation.mode === 'brokered') {
    runtime.workerManager = new WorkerManager(
      toolExecutor,
      runtime,
      config.runtime.agentIsolation,
      DEFAULT_SANDBOX_CONFIG,
      {
        intentRoutingTrace,
        runTimeline,
        pendingActionStore,
        executionGraphStore,
        resolveStateAgentId: resolveSharedStateAgentId,
      },
    );
  } else {
    runtime.workerManager = undefined;
  }

  emitStartupTrace('main:search-reload:start');
  const initialSearchReload = await initialSearchReloadRef.current();
  emitStartupTrace('main:search-reload:done');
  if (!initialSearchReload.success) {
    console.error(initialSearchReload.message);
  }

  const playbookRunStateStore = new JsonFileRunStateStore<PlaybookStepRunResult>({
    persistPath: join(getGuardianBaseDir(), 'playbook-run-state.json'),
    maxEntries: 200,
  });

  const cloneStoredOutputStatus = <T extends { taintReasons?: string[] }>(value: T | undefined): T | undefined => (
    value
      ? {
          ...value,
          ...(value.taintReasons ? { taintReasons: [...value.taintReasons] } : {}),
        }
      : undefined
  );

  const cloneMemoryPromotionStatus = (
    value: import('./runtime/automation-output-persistence.js').AutomationMemoryPromotionStatus | undefined,
  ): import('./runtime/automation-output-persistence.js').AutomationMemoryPromotionStatus | undefined => (
    value ? { ...value } : undefined
  );

  const attachPlaybookRunPersistence = (
    run: PlaybookRunRecord,
    input: ConnectorPlaybookRunInput,
  ): void => {
    run.outputHandling = normalizeAutomationOutputHandling(run.outputHandling);
    run.promotedFindings = promoteAutomationFindings(runtime.auditLog, {
      automationId: run.playbookId,
      automationName: run.playbookName,
      runId: run.id,
      status: run.status,
      message: run.message,
      steps: run.steps,
      outputHandling: run.outputHandling,
      origin: input.origin,
      agentId: input.agentId,
      userId: input.userId,
      channel: input.channel,
      target: run.playbookId,
      runLink: `#/automations?runId=${encodeURIComponent(run.id)}`,
    });
    const persistence = automationOutputPersistence.persistRun({
      automationId: run.playbookId,
      automationName: run.playbookName,
      runId: run.id,
      status: run.status,
      message: run.message,
      steps: run.steps,
      outputHandling: run.outputHandling,
      origin: input.origin,
      agentId: input.agentId,
      userId: input.userId,
      channel: input.channel,
      target: run.playbookId,
      runLink: `#/automations?runId=${encodeURIComponent(run.id)}`,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    });
    run.storedOutput = cloneStoredOutputStatus(persistence.storedOutput);
    run.memoryPromotion = cloneMemoryPromotionStatus(persistence.memoryPromotion);
  };

  const attachScheduledTaskRunPersistence = (
    task: ScheduledTaskDefinition,
    result: ScheduledTaskRunResult,
    triggerContext: { kind: 'manual' | 'cron' | 'event'; event?: import('./queue/event-bus.js').AgentEvent },
  ): void => {
    if (task.type === 'playbook' && (result.storedOutput || result.memoryPromotion)) {
      return;
    }
    result.outputHandling = normalizeAutomationOutputHandling(result.outputHandling ?? task.outputHandling);
    const completedAt = Date.now();
    const startedAt = Number.isFinite(result.durationMs) ? Math.max(0, completedAt - result.durationMs) : undefined;
    const runId = result.runId?.trim() || `${task.id}:${completedAt}`;
    const persistence = automationOutputPersistence.persistRun({
      automationId: task.id,
      automationName: task.name,
      runId,
      status: result.status,
      message: result.message,
      steps: result.steps,
      outputHandling: result.outputHandling,
      origin: `scheduled-task:${triggerContext.kind}`,
      agentId: `sched-task:${task.id}`,
      ...(task.channel ? { channel: task.channel } : {}),
      target: task.target,
      taskId: task.id,
      runLink: `#/automations?runId=${encodeURIComponent(runId)}`,
      startedAt,
      completedAt,
      memoryAgentId: task.type === 'agent' ? task.target : undefined,
    });
    result.storedOutput = cloneStoredOutputStatus(persistence.storedOutput);
    result.memoryPromotion = cloneMemoryPromotionStatus(persistence.memoryPromotion);
  };

  connectors = new ConnectorPlaybookService({
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
    runStateStore: playbookRunStateStore,
    onRunRecorded: (run, input) => {
      attachPlaybookRunPersistence(run, input);
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
    integrity: controlPlaneIntegrity,
    resolvePlaybookOutputHandling: getPlaybookOutputHandling,
    persistPath: scheduledTasksPersistPath,
    onNetworkScanComplete: () => {
      runNetworkAnalysis('scheduled-task');
    },
    onRunRecorded: (task, result, triggerContext) => {
      attachScheduledTaskRunPersistence(task, result, triggerContext);
    },
  });
  await scheduledTasks.load().catch(() => {});
  secondBrainHorizonScanner = new HorizonScanner(
    scheduledTasks,
    secondBrainService,
    secondBrainSyncService,
    secondBrainBriefingService,
  );
  toolExecutorOptions.secondBrainHorizonScanner = secondBrainHorizonScanner;
  secondBrainHorizonScanner.start();

  refreshRunTimelineSnapshots = (): void => {
    runTimeline.syncPlaybookRuns(connectors.getState(50).runs);
    runTimeline.syncScheduledTaskHistory(scheduledTasks.getHistory());
  };
  refreshRunTimelineSnapshots();
  const runTimelineRefreshInterval = setInterval(() => {
    refreshRunTimelineSnapshots();
  }, 5_000);
  runTimelineRefreshInterval.unref?.();

  // Auto-install all preset scheduled tasks on first run (no existing tasks)
  if (scheduledTasks.list().length === 0) {
    scheduledTasks.autoInstallAllPresets();
  }

  function getAssistantSecurityMonitoringConfig() {
    const configured = configRef.current.assistant.security?.continuousMonitoring;
    return {
      enabled: configured?.enabled !== false,
      profileId: configured?.profileId ?? DEFAULT_ASSISTANT_SECURITY_MONITORING_PROFILE,
      cron: configured?.cron?.trim() || DEFAULT_ASSISTANT_SECURITY_MONITORING_CRON,
    };
  }

  function findManagedAssistantSecurityTask() {
    return scheduledTasks.list().find((task) => (
      task.presetId === 'assistant-security-scan'
      || (task.target === 'assistant_security_scan' && task.name === 'Assistant Security Scan')
    )) ?? null;
  }

  syncAssistantSecurityMonitoringTask = (): void => {
    const monitoring = getAssistantSecurityMonitoringConfig();
    let task = findManagedAssistantSecurityTask();

    if (!task && !monitoring.enabled) {
      return;
    }

    if (!task) {
      const installed = scheduledTasks.installPreset('assistant-security-scan');
      if (!installed.success || !installed.task) {
        log.warn({ result: installed.message }, 'Failed to install managed Assistant Security monitoring task');
        return;
      }
      task = installed.task;
    }

    const update = scheduledTasks.update(task.id, {
      name: 'Assistant Security Scan',
      description: 'Managed continuous Assistant Security posture scan driven by Configuration > Security.',
      args: {
        profileId: monitoring.profileId,
        source: 'scheduled',
      },
      cron: monitoring.cron,
      enabled: monitoring.enabled,
      emitEvent: 'assistant_security_scanned',
    });
    if (!update.success) {
      log.warn({ taskId: task.id, result: update.message }, 'Failed to sync managed Assistant Security monitoring task');
    }
  };

  syncAssistantSecurityMonitoringTask();

  // Bootstrap the built-in automation examples if no connector packs exist yet.
  if (connectors.getState().packs.length === 0) {
    materializeAllBuiltinAutomationExamples(connectors);
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

  const configuredToken = config.channels.web?.auth?.token?.trim() || config.channels.web?.authToken?.trim();
  const configuredWebAuthMode = config.channels.web?.auth?.mode ?? 'bearer_required';
  const rotateOnStartup = config.channels.web?.auth?.rotateOnStartup ?? false;
  const shouldGenerateToken = configuredWebAuthMode === 'bearer_required' && (!configuredToken || rotateOnStartup);
  const effectiveToken = shouldGenerateToken ? generateSecureToken() : configuredToken;
  const effectiveTokenSource = configuredToken && !shouldGenerateToken
    ? 'config'
    : 'ephemeral';
  const webAuthStateRef: { current: WebAuthRuntimeConfig } = {
    current: {
      mode: configuredWebAuthMode,
      token: effectiveToken,
      tokenSource: effectiveTokenSource,
      rotateOnStartup,
      sessionTtlMinutes: config.channels.web?.auth?.sessionTtlMinutes,
    },
  };

  let activeWebChannel: BootstrapWebChannel | null = null;
  const applyWebAuthRuntime = (auth: WebAuthRuntimeConfig): void => {
    webAuthStateRef.current = { ...auth };
    if (activeWebChannel) {
      activeWebChannel.setAuthConfig(webAuthStateRef.current);
    }
  };

  let threatIntelInterval: NodeJS.Timeout | null = null;
  const orchestrator = new AssistantOrchestrator();
  orchestrator.subscribe((trace) => {
    runTimeline.ingestAssistantTrace(trace);
  });
  const jobTracker = new AssistantJobTracker();
  memoryMutationServiceRef.current = new MemoryMutationService({
    auditLog: runtime.auditLog,
    jobTracker,
  });
  const getRuntimePrincipalMemoryScopeId = (): string => (
    configRef.current.channels.web?.defaultAgent
      ?? configRef.current.channels.cli?.defaultAgent
      ?? configRef.current.agents[0]?.id
      ?? 'default'
  );
  const automatedMaintenanceService = new AutomatedMaintenanceService({
    getConfig: () => configRef.current.assistant.maintenance,
    getRuntimeActivity: () => {
      const state = orchestrator.getState();
      const lastActivityAt = state.sessions.reduce((latest, session) => Math.max(
        latest,
        session.lastQueuedAt ?? 0,
        session.lastStartedAt ?? 0,
        session.lastCompletedAt ?? 0,
      ), 0) || undefined;
      return {
        queuedCount: state.summary.queuedCount,
        runningCount: state.summary.runningCount,
        lastActivityAt,
      };
    },
    getPrincipalMemoryScopeId: getRuntimePrincipalMemoryScopeId,
    globalMemoryStore: agentMemoryStore,
    codeSessionMemoryStore,
    codeSessionStore,
    memoryMutationService: memoryMutationServiceRef.current,
  });

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
      const order = buildAutoFallbackOrder(config)
        .filter((name) => providerNames.includes(name));
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
  // Disabled when providerRoutingEnabled is false — all tools use the derived primary provider.
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
  const chatAgents = new Map<string, ChatAgentInstance>();
  const routingIntentGateway = new IntentGateway();

  const defaultOrchestrationForRoutingRole = (
    role: 'local' | 'external' | 'general' | undefined,
  ): OrchestrationRoleDescriptor | undefined => {
    if (role === 'local') {
      return {
        role: 'coordinator',
        label: 'Guardian Coordinator',
        lenses: ['coding-workspace'],
      };
    }
    if (role === 'external') {
      return {
        role: 'coordinator',
        label: 'Guardian Coordinator',
        lenses: ['research', 'provider-admin'],
      };
    }
    if (role === 'general') {
      return {
        role: 'coordinator',
        label: 'Guardian Coordinator',
      };
    }
    return undefined;
  };
  await intentRoutingTrace.init();

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
        skillRegistry,
        skillResolver,
        enabledManagedProviders,
        fallbackChain,
        selectSoulPrompt(soulProfile, soulMode),
        agentMemoryStore,
        codeSessionMemoryStore,
        codeSessionStore,
        secondBrainService,
        sharedCodeWorkspaceTrustService,
        sharedStateAgentId,
        resolveGwsProvider,
        config.assistant.tools.contextBudget,
        config.qualityFallback,
        analytics ?? undefined,
        resolveRoutedProviderForTools,
        intentRoutingTrace,
        pendingActionStore,
        continuityThreadStore,
        executionStore,
        routingIntentGateway,
        () => configRef.current.assistant.responseStyle,
        () => configRef.current,
      );
      chatAgents.set(agentConfig.id, agent);
      runtime.registerAgent(createAgentDefinition({
        agent,
        providerName: agentConfig.provider,
        schedule: agentConfig.schedule,
        grantedCapabilities: agentConfig.capabilities,
        resourceLimits: agentConfig.resourceLimits,
        orchestration: agentConfig.orchestration ?? defaultOrchestrationForRoutingRole(agentConfig.role),
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
      skillRegistry,
      skillResolver,
      enabledManagedProviders,
      fallbackChain,
      selectSoulPrompt(soulProfile, config.assistant.soul.primaryMode),
      agentMemoryStore,
      codeSessionMemoryStore,
      codeSessionStore,
      secondBrainService,
      sharedCodeWorkspaceTrustService,
      SHARED_TIER_AGENT_STATE_ID,
      resolveGwsProvider,
      config.assistant.tools.contextBudget,
      config.qualityFallback,
      analytics ?? undefined,
      resolveRoutedProviderForTools,
      intentRoutingTrace,
      pendingActionStore,
      continuityThreadStore,
      executionStore,
      routingIntentGateway,
      () => configRef.current.assistant.responseStyle,
      () => configRef.current,
    );
    chatAgents.set('local', localAgent);
    runtime.registerAgent(createAgentDefinition({
      agent: localAgent,
      providerName: localProviderName,
      grantedCapabilities: agentCapabilities,
      orchestration: {
        role: 'coordinator',
        label: 'Guardian Coordinator',
        lenses: ['coding-workspace'],
      },
    }));

    const externalAgent = new ChatAgent(
      'external',
      'External Agent',
      externalPrompt,
      conversations,
      toolExecutor,
      runtime.outputGuardian,
      skillRegistry,
      skillResolver,
      enabledManagedProviders,
      fallbackChain,
      selectSoulPrompt(soulProfile, config.assistant.soul.delegatedMode),
      agentMemoryStore,
      codeSessionMemoryStore,
      codeSessionStore,
      secondBrainService,
      sharedCodeWorkspaceTrustService,
      SHARED_TIER_AGENT_STATE_ID,
      resolveGwsProvider,
      config.assistant.tools.contextBudget,
      config.qualityFallback,
      analytics ?? undefined,
      resolveRoutedProviderForTools,
      intentRoutingTrace,
      pendingActionStore,
      continuityThreadStore,
      executionStore,
      routingIntentGateway,
      () => configRef.current.assistant.responseStyle,
      () => configRef.current,
    );
    chatAgents.set('external', externalAgent);
    runtime.registerAgent(createAgentDefinition({
      agent: externalAgent,
      providerName: externalProviderName,
      grantedCapabilities: agentCapabilities,
      orchestration: {
        role: 'coordinator',
        label: 'Guardian Coordinator',
        lenses: ['research', 'provider-admin'],
      },
    }));

    // Register with router using default domain rules
    router.registerAgent('local', agentCapabilities, {
      domains: ['filesystem', 'code'],
      patterns: [
        '\\b(file|folder|directory|path|create|delete|move|copy|rename|save|open)\\b',
        '\\b(git|commit|branch|merge|pull request|build|compile|lint|test|npm|node)\\b',
        '\\b(codex|claude\\s+code|gemini\\s+cli|aider|coding backend|coding assistant)\\b',
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
      skillRegistry,
      skillResolver,
      enabledManagedProviders,
      fallbackChain,
      selectSoulPrompt(soulProfile, config.assistant.soul.primaryMode),
      agentMemoryStore,
      codeSessionMemoryStore,
      codeSessionStore,
      secondBrainService,
      sharedCodeWorkspaceTrustService,
      'default',
      resolveGwsProvider,
      config.assistant.tools.contextBudget,
      config.qualityFallback,
      analytics ?? undefined,
      resolveRoutedProviderForTools,
      intentRoutingTrace,
      pendingActionStore,
      continuityThreadStore,
      executionStore,
      routingIntentGateway,
      () => configRef.current.assistant.responseStyle,
      () => configRef.current,
    );
    chatAgents.set('default', defaultAgent);
    runtime.registerAgent(createAgentDefinition({
      agent: defaultAgent,
      grantedCapabilities: agentCapabilities,
      orchestration: {
        role: 'coordinator',
        label: 'Guardian Coordinator',
      },
    }));
    router.registerAgent('default', agentCapabilities);
  }

  if (!chatAgents.has(SECURITY_TRIAGE_AGENT_ID)) {
    const securityTriageCapabilities: Capability[] = ['execute_commands', 'network_access'];
    const securityTriageAgent = new ChatAgent(
      SECURITY_TRIAGE_AGENT_ID,
      'Security Triage Agent',
      DEFAULT_SECURITY_TRIAGE_SYSTEM_PROMPT,
      conversations,
      toolExecutor,
      runtime.outputGuardian,
      skillRegistry,
      skillResolver,
      enabledManagedProviders,
      fallbackChain,
      selectSoulPrompt(soulProfile, config.assistant.soul.delegatedMode),
      agentMemoryStore,
      codeSessionMemoryStore,
      codeSessionStore,
      secondBrainService,
      sharedCodeWorkspaceTrustService,
      SECURITY_TRIAGE_AGENT_ID,
      resolveGwsProvider,
      config.assistant.tools.contextBudget,
      config.qualityFallback,
      analytics ?? undefined,
      resolveRoutedProviderForTools,
      intentRoutingTrace,
      pendingActionStore,
      continuityThreadStore,
      executionStore,
      routingIntentGateway,
      () => configRef.current.assistant.responseStyle,
    );
    chatAgents.set(SECURITY_TRIAGE_AGENT_ID, securityTriageAgent);
    runtime.registerAgent(createAgentDefinition({
      agent: securityTriageAgent,
      providerName: resolveSecurityTriageProviderName(config),
      grantedCapabilities: securityTriageCapabilities,
      resourceLimits: {
        maxInvocationBudgetMs: 120_000,
        maxConcurrentTools: 4,
      },
      orchestration: {
        role: 'verifier',
        label: 'Security Verifier',
        lenses: ['security'],
      },
    }));
  }

  runtime.registerAgent(createAgentDefinition({
    agent: new SecurityEventTriageAgent({
      targetAgentId: SECURITY_TRIAGE_AGENT_ID,
      primaryUserId: config.assistant.identity.primaryUserId,
      auditLog: runtime.auditLog,
      activityLog: securityActivityLog,
      channel: 'scheduled',
      allowedCapabilities: ['execute_commands', 'network_access'],
    }),
    grantedCapabilities: ['agent.dispatch'],
    resourceLimits: {
      maxInvocationBudgetMs: 120_000,
      maxQueueDepth: 256,
    },
    orchestration: {
      role: 'verifier',
      label: 'Security Event Verifier',
      lenses: ['security'],
    },
  }));

  // ─── Guardian Agent + Sentinel provider setup ─────────────────────
  // Resolve local (Ollama) and external (OpenAI/Anthropic) providers for
  // inline evaluation and audit analysis.
  {
    let localProvider: LLMProvider | undefined;
    let externalLlmProvider: LLMProvider | undefined;
    for (const [name, llmCfg] of Object.entries(config.llm)) {
      const provider = runtime.getProvider(name);
      if (!provider) continue;
      if (getProviderLocality(llmCfg) === 'local' && !localProvider) {
        localProvider = provider;
      } else if (getProviderLocality(llmCfg) === 'external' && !externalLlmProvider) {
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
      orchestration: {
        role: 'verifier',
        label: 'Sentinel Verifier',
        lenses: ['security'],
      },
    }));
    console.log(`  Sentinel Audit: scheduled (${auditSchedule})`);
  }

  // Start channels
  const channels: BootstrapChannelStopEntry[] = [];

  const defaultAgentId = config.agents[0]?.id ?? (localProviderName && externalProviderName ? 'local' : 'default');
  const prepareIncomingDispatch = createIncomingDispatchPreparer({
    defaultAgentId,
    configRef,
    router,
    routingIntentGateway,
    runtime,
    identity,
    conversations,
    pendingActionStore,
    continuityThreadStore,
    codeSessionStore,
    intentRoutingTrace,
    enabledManagedProviders,
    resolveSharedStateAgentId,
    resolveConfiguredAgentId: resolveConfiguredDispatchAgentId,
    findProviderByLocality,
    getCodeSessionSurfaceId,
    readMessageSurfaceId,
    readCodeRequestMetadata,
    normalizeTierModeForRouter,
    summarizePendingActionForGateway,
    summarizeContinuityThreadForGateway,
  });
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
  const policyLoadResult = loadPolicyFiles(policyRulesPath, controlPlaneIntegrity);
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
      const loadResult = loadPolicyFiles(policyRulesPath, controlPlaneIntegrity);
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

  recordControlPlaneIntegritySweep('startup');
  setInterval(() => {
    recordControlPlaneIntegritySweep('interval');
  }, 5 * 60 * 1000).unref();

  const {
    connectorWorkflowOps,
    telegramReloadRef,
    reloadSearchRef,
    listConfiguredLlmProviders,
    listModelsForConfiguredLlmProvider,
    applyDirectLlmProviderConfigUpdate,
    ...dashboardCallbacks
  } = buildDashboardCallbacks(
    runtime,
    configRef,
    threatIntelWebSearchConfigRef,
    secretStore,
    conversations,
    identity,
    analytics,
    runTimeline,
    refreshRunTimelineSnapshots,
    orchestrator,
    intentRoutingTrace,
    jobTracker,
    aiSecurity,
    runAssistantSecurityScan,
    threatIntel,
    connectors,
    toolExecutor,
    applyBrowserRuntimeConfig,
    agentMemoryStore,
    codeSessionMemoryStore,
    codeSessionStore,
    secondBrainService,
    secondBrainSyncService,
    performanceService,
    secondBrainBriefingService,
    (input) => (
      memoryMutationServiceRef.current?.persist(input)
        ?? {
          action: 'created' as const,
          reason: 'new_entry' as const,
          entry: input.target.store.append(input.target.scopeId, input.entry),
        }
    ),
    (input) => (
      memoryMutationServiceRef.current?.runMaintenanceForScope(input)
        ?? {
          reviewedEntries: input.target.store.getEntries(input.target.scopeId, true).length,
          archivedExactDuplicates: 0,
          archivedNearDuplicates: 0,
          archivedStaleSystemEntries: 0,
          changed: false,
        }
    ),
    chatAgents,
    skillRegistry,
    enabledManagedProviders,
    webAuthStateRef,
    applyWebAuthRuntime,
    configPath,
    controlPlaneIntegrity,
    router,
    deviceInventory,
    networkBaseline,
    hostMonitor,
    runHostMonitoring,
    gatewayMonitor,
    runGatewayMonitoring,
    windowsDefender,
    runWindowsDefenderRefresh,
    containmentService,
    securityActivityLog,
    getSecurityContainmentInputs,
    runNetworkAnalysis,
    guardianAgentService,
    sentinelAuditService,
    policyState,
    googleAuthRef,
    googleServiceRef,
    microsoftAuthRef,
    microsoftServiceRef,
    { current: toolExecutor },
    pendingActionStore,
    codingBackendServiceRef,
    prepareIncomingDispatch,
  );
  listConfiguredLlmProvidersForTools = listConfiguredLlmProviders;
  listModelsForConfiguredLlmProviderForTools = listModelsForConfiguredLlmProvider;
  applyDirectLlmProviderConfigUpdateForTools = applyDirectLlmProviderConfigUpdate;

  dashboardCallbacks.onCodeTerminalAccessCheck = () => {
    const liveSandboxConfig = buildRuntimeSandboxConfig();
    if (isStrictSandboxLockdown(liveSandboxConfig, sandboxHealth)) {
      runtime.auditLog?.record?.({
        type: 'action_denied',
        severity: 'warn',
        agentId: 'system',
        controller: 'CodeTerminal',
        details: {
          reason: 'strict_sandbox_lockdown',
          availability: sandboxHealth.availability,
          backend: sandboxHealth.backend,
        },
      });
      return {
        allowed: false,
        reason: 'Manual code terminals are blocked because strict sandbox mode requires a strong sandbox backend on this host.',
      };
    }
    if (isDegradedSandboxFallbackActive(liveSandboxConfig, sandboxHealth) && !resolveDegradedFallbackConfig(liveSandboxConfig).allowManualCodeTerminals) {
      runtime.auditLog?.record?.({
        type: 'action_denied',
        severity: 'warn',
        agentId: 'system',
        controller: 'CodeTerminal',
        details: {
          reason: 'degraded_backend_manual_terminals_disabled',
          availability: sandboxHealth.availability,
          backend: sandboxHealth.backend,
        },
      });
      return {
        allowed: false,
        reason: 'Manual code terminals stay disabled by default on degraded sandbox backends. Enable them in Configuration > Security if you explicitly accept the host risk.',
      };
    }
    return { allowed: true };
  };
  dashboardCallbacks.onCodeTerminalEvent = (event) => {
    runtime.auditLog?.record?.({
      type: 'action_allowed',
      severity: 'info',
      agentId: 'system',
      controller: 'CodeTerminal',
      details: {
        action: event.action,
        terminalId: event.terminalId,
        shell: event.shell,
        cwd: event.cwd,
        codeSessionId: event.codeSessionId ?? null,
        cols: event.cols,
        rows: event.rows,
        exitCode: event.exitCode,
        signal: event.signal,
      },
    });
  };

  const automationRuntime = createAutomationRuntimeService({
        workflows: {
          list: () => connectors.getState().playbooks.map((workflow) => ({
            ...workflow,
            steps: workflow.steps.map((step) => ({ ...step })),
            ...(workflow.outputHandling ? { outputHandling: { ...workflow.outputHandling } } : {}),
          })),
          history: () => connectors.getState(60).runs.map((run) => ({
            ...run,
            steps: run.steps.map((step) => ({ ...step })),
            ...(run.outputHandling ? { outputHandling: { ...run.outputHandling } } : {}),
          })),
          upsert: (playbook) => connectorWorkflowOps.upsert(playbook),
          delete: (playbookId) => connectorWorkflowOps.delete(playbookId),
          run: async (input) => connectorWorkflowOps.run(input),
        },
        tasks: {
          list: () => scheduledTasks.list(),
          get: (id) => scheduledTasks.get(id),
          create: (input) => scheduledTasks.create(input),
          update: (id, input) => scheduledTasks.update(id, input),
          delete: (id) => scheduledTasks.delete(id),
          runNow: async (id) => scheduledTasks.runNow(id),
          presets: () => scheduledTasks.getPresets(),
          createFromPresetExample: (presetId) => scheduledTasks.installPreset(presetId),
          history: () => scheduledTasks.getHistory(),
        },
        templates: {
          list: () => listBuiltinAutomationExamples(connectors).map((example) => ({
            ...example,
            playbooks: example.playbooks.map((playbook) => ({
              ...playbook,
              steps: playbook.steps.map((step) => ({ ...step })),
              ...(playbook.outputHandling ? { outputHandling: { ...playbook.outputHandling } } : {}),
            })),
          })),
          createFromExample: (templateId) => materializeBuiltinAutomationExample(templateId, connectors),
        },
        toolMetadata: toolExecutor.listToolDefinitions().map((definition) => ({
          name: definition.name,
          category: definition.category,
          description: definition.description,
          shortDescription: definition.shortDescription,
        })),
        outputStore: automationOutputStore,
        onWorkflowSaved: (playbook) => {
          syncPlaybookScheduleToTasks(playbook);
          syncPlaybookOutputHandlingToSchedules(playbook.id);
        },
      })
  ;

  reloadSearchRef.current = initialSearchReloadRef.current;

  // Factory reset: bulk-clear data, config, or both
  dashboardCallbacks.onFactoryReset = async ({ scope }) => {
    const baseDir = getGuardianBaseDir();
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
      try { codeSessionStore.close(); } catch { /* already closed */ }
      try { secondBrainStore.close(); } catch { /* already closed */ }
      try { analytics.close(); } catch { /* already closed */ }
      toolExecutor.updatePolicy({ sandbox: { allowedPaths: [...configRef.current.assistant.tools.allowedPaths] } });

      tryDelete('assistant-memory.sqlite', resolveAssistantDbPath(config.assistant.memory.sqlitePath, 'assistant-memory.sqlite'));
      tryDelete('assistant-code-sessions.sqlite', resolveAssistantDbPath(undefined, 'assistant-code-sessions.sqlite'));
      tryDelete('assistant-second-brain.sqlite', resolveAssistantDbPath(undefined, 'assistant-second-brain.sqlite'));
      tryDelete('assistant-analytics.sqlite', resolveAssistantDbPath(config.assistant.analytics.sqlitePath, 'assistant-analytics.sqlite'));
      // Also remove SQLite WAL/SHM files if present
      for (const suffix of ['-wal', '-shm']) {
        tryDelete(`assistant-memory.sqlite${suffix}`, resolveAssistantDbPath(config.assistant.memory.sqlitePath, 'assistant-memory.sqlite') + suffix);
        tryDelete(`assistant-code-sessions.sqlite${suffix}`, resolveAssistantDbPath(undefined, 'assistant-code-sessions.sqlite') + suffix);
        tryDelete(`assistant-second-brain.sqlite${suffix}`, resolveAssistantDbPath(undefined, 'assistant-second-brain.sqlite') + suffix);
        tryDelete(`assistant-analytics.sqlite${suffix}`, resolveAssistantDbPath(config.assistant.analytics.sqlitePath, 'assistant-analytics.sqlite') + suffix);
      }
      tryDelete('memory/ (agent knowledge base)', join(baseDir, 'memory'), { recursive: true });
      tryDelete('automation-output/ (historical automation output)', join(baseDir, 'automation-output'), { recursive: true });
      tryDelete('audit/ (audit log)', join(baseDir, 'audit'), { recursive: true });
      tryDelete('device-inventory.json', join(baseDir, 'device-inventory.json'));
      tryDelete('scheduled-tasks.json', join(baseDir, 'scheduled-tasks.json'));
      tryDelete('execution-graphs.json', join(baseDir, 'execution-graphs.json'));
      tryDelete('execution-graphs.json.tmp', join(baseDir, 'execution-graphs.json.tmp'));
      tryDelete('network-baseline.json', join(baseDir, 'network-baseline.json'));
      tryDelete('network-traffic.json', join(baseDir, 'network-traffic.json'));
      tryDelete('security-activity-log.json', join(baseDir, 'security-activity-log.json'));
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
        writeSecureFileSync(configPath, defaultYaml);
        controlPlaneIntegrity.signFileSync(configPath, 'factory_reset');
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

  // ─── Scheduled Tasks callbacks ─────────────────────────
  if (automationRuntime) {
    dashboardCallbacks.onScheduledTasks = () => automationRuntime.listTasks();
    dashboardCallbacks.onScheduledTaskGet = (id) => automationRuntime.getTask(id);
    dashboardCallbacks.onScheduledTaskCreate = (input) => automationRuntime.createTask(input);
    dashboardCallbacks.onScheduledTaskUpdate = (id, input) => automationRuntime.updateTask(id, input);
    dashboardCallbacks.onScheduledTaskDelete = (id) => automationRuntime.deleteTask(id);
    dashboardCallbacks.onScheduledTaskRunNow = async (id) => automationRuntime.runTaskNow(id);
    dashboardCallbacks.onScheduledTaskHistory = () => automationRuntime.listTaskHistory();
    dashboardCallbacks.onAutomationCatalog = () => automationRuntime.listAutomationCatalogView();
    dashboardCallbacks.onAutomationRunHistory = () => automationRuntime.listAutomationRunHistory();
    dashboardCallbacks.onAutomationCreate = (automationId) => automationRuntime.createAutomationFromCatalog(automationId);
    dashboardCallbacks.onAutomationSave = (input) => automationRuntime.saveAutomation(input);
    dashboardCallbacks.onAutomationDefinitionSave = (automationId, workflow) => (
      automationRuntime.saveAutomationDefinition(automationId, workflow)
    );
    dashboardCallbacks.onAutomationSetEnabled = (automationId, enabled) => (
      automationRuntime.setSavedAutomationEnabled(automationId, enabled)
    );
    dashboardCallbacks.onAutomationDelete = (automationId) => (
      automationRuntime.deleteSavedAutomation(automationId)
    );
    dashboardCallbacks.onAutomationRun = async (input) => automationRuntime.runSavedAutomation(input);
    toolExecutor.setAutomationControlPlane(automationRuntime.createExecutorControlPlane());
  }

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

  emitStartupTrace('main:channels:start');
  const startedChannels = await startBootstrapChannels({
    config,
    configRef,
    configPath,
    defaultAgentId,
    effectiveToken,
    configuredToken,
    rotateOnStartup,
    webAuthStateRef,
    dashboardCallbacks,
    runtime,
    channels,
    prepareIncomingDispatch,
    resolveConfiguredAgentId: resolveConfiguredDispatchAgentId,
    secretStore,
    resolveCanonicalTelegramUserId: (channelUserId) => identity.resolveCanonicalUserId('telegram', channelUserId),
    resolveTelegramBotToken,
    formatGuideForTelegram,
    generateSecureToken,
    previewTokenForLog,
    staticDir: join(__dirname, '..', 'web', 'public'),
    codingBackendServiceRef,
    codingBackendsDefaultConfig: DEFAULT_CODING_BACKENDS_CONFIG,
    toolExecutor,
    listAgents: () => runtime.registry.getAll().map(inst => ({
      id: inst.agent.id,
      name: inst.agent.name,
      state: inst.state,
      capabilities: inst.definition.grantedCapabilities,
      internal: router.findAgentByRole('local')?.id === inst.agent.id
        || router.findAgentByRole('external')?.id === inst.agent.id
        || inst.agent.id === SECURITY_TRIAGE_AGENT_ID
        || inst.agent.id === SECURITY_TRIAGE_DISPATCHER_AGENT_ID,
    })),
    getRuntimeStatus: () => ({
      running: runtime.isRunning(),
      agentCount: runtime.registry.size,
      guardianEnabled: configRef.current.guardian.enabled,
      providers: [...runtime.providers.keys()],
    }),
    log,
    stdinIsTTY: !!process.stdin.isTTY,
    stdoutIsTTY: !!process.stdout.isTTY,
  });
  emitStartupTrace('main:channels:done');
  const cliChannel = startedChannels.cliChannel;
  activeWebChannel = startedChannels.webChannel;
  codingBackendServiceRef.current?.subscribeProgress((event) => {
    runTimeline.ingestCodingBackendProgress(event);
  });

  deliverMessageClosure = async (channel, targetId, content) => {
    try {
      if (channel === 'telegram') {
        const tChannel = startedChannels.getTelegramChannel();
        if (!tChannel) return { success: false, error: 'Telegram channel not available.' };
        const chatIds = resolveTelegramDeliveryChatIds({
          configuredChatIds: configRef.current.channels.telegram?.allowedChatIds ?? [],
          preferredUserIds: targetId ? [targetId] : undefined,
          primaryUserId: configRef.current.assistant.identity.primaryUserId,
          telegramChannel: tChannel,
        });
        if (chatIds.length === 0) {
          return { success: false, error: 'No Telegram chat ID configured or discovered for delivery.' };
        }
        for (const id of chatIds) {
          await tChannel.send(String(id), content);
        }
        return { success: true };
      } else if (channel === 'web') {
        if (!activeWebChannel) return { success: false, error: 'Web channel not available.' };
        await activeWebChannel.send(targetId, content);
        return { success: true };
      } else if (channel === 'cli') {
        if (!cliChannel) return { success: false, error: 'CLI channel not available.' };
        await cliChannel.send(targetId, content);
        return { success: true };
      }
      return { success: false, error: `Channel '${channel}' not supported.` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (channel === 'telegram' && msg.includes('chat not found')) {
        return { success: false, error: 'Telegram API returned "chat not found". The user must start a conversation with the bot on Telegram first before it can send messages to them.' };
      }
      return { success: false, error: msg };
    }
  };

  wireScheduledAgentExecutor({
    scheduledTasks,
    jobTracker,
    dashboardCallbacks,
    configRef,
    defaultAgentId,
    getCliChannel: () => cliChannel,
    getTelegramChannel: () => startedChannels.getTelegramChannel(),
    getWebChannel: () => activeWebChannel,
  });

  secondBrainHorizonScanner.setOutcomeDelivery(createSecondBrainRoutineNotifier({
    configRef,
    getCliChannel: () => cliChannel,
    getTelegramChannel: () => startedChannels.getTelegramChannel(),
    getWebChannel: () => activeWebChannel,
  }));

  const notificationService = createRuntimeNotificationService({
    configRef,
    runtime,
    getCliChannel: () => cliChannel,
    getTelegramChannel: () => startedChannels.getTelegramChannel(),
  });

  ({
    hostMonitorInterval,
    gatewayMonitorInterval,
  } = await startRuntimeSupportServices({
    notificationService,
    runtime,
    config,
    configRef,
    runHostMonitoring,
    runGatewayMonitoring,
    connectors,
    scheduledTasks,
    log,
  }));
  automatedMaintenanceService.start();

  await runCliPostStart({
    cliChannel,
    dashboardCallbacks,
    config,
    runtime,
    defaultAgentId,
  });

  const clearManagedIntervals = () => {
    if (threatIntelInterval) {
      clearInterval(threatIntelInterval);
      threatIntelInterval = null;
    }
    automatedMaintenanceService.stop();
    if (hostMonitorInterval) {
      clearInterval(hostMonitorInterval);
      hostMonitorInterval = null;
    }
    if (gatewayMonitorInterval) {
      clearInterval(gatewayMonitorInterval);
      gatewayMonitorInterval = null;
    }
  };

  const shutdown = createShutdownHandler({
    channels,
    clearManagedIntervals,
    mcpManager,
    toolExecutor,
    notificationService,
    runtime,
    conversations,
    codeSessionStore,
    analytics,
    settleTerminalForExit,
    log,
  });

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
