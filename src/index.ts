#!/usr/bin/env node
/**
 * GuardianAgent — Entry point.
 *
 * Load config → create Runtime → register agents → start channels →
 * handle SIGINT/SIGTERM for graceful shutdown.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { platform, homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { loadConfig, DEFAULT_CONFIG_PATH, deepMerge, validateConfig } from './config/loader.js';
import type { GuardianAgentConfig } from './config/types.js';
import yaml from 'js-yaml';
import { Runtime } from './runtime/runtime.js';
import { CLIChannel } from './channels/cli.js';
import { TelegramChannel } from './channels/telegram.js';
import { WebChannel } from './channels/web.js';
import type { DashboardCallbacks, DashboardAgentInfo, DashboardAgentDetail, DashboardProviderInfo, RedactedConfig, SSEListener } from './channels/web-types.js';
import type { LLMConfig } from './config/types.js';
import { BaseAgent } from './agent/agent.js';
import { createAgentDefinition } from './agent/agent.js';
import type { AgentContext, AgentResponse, UserMessage } from './agent/types.js';
import { SentinelAgent } from './agents/sentinel.js';
import { createLogger } from './util/logging.js';
import { ConversationService } from './runtime/conversation.js';
import { getReferenceGuide, formatGuideForTelegram } from './reference-guide.js';
import type { ChatMessage } from './llm/types.js';
import { IdentityService } from './runtime/identity.js';
import { AnalyticsService } from './runtime/analytics.js';
import { buildQuickActionPrompt, getQuickActions } from './quick-actions.js';
import { evaluateSetupStatus } from './runtime/setup.js';
import { ThreatIntelService } from './runtime/threat-intel.js';
import { MoltbookConnector } from './runtime/moltbook-connector.js';

const log = createLogger('main');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default chat agent that uses the configured LLM provider. */
class ChatAgent extends BaseAgent {
  private systemPrompt: string;
  private conversationService?: ConversationService;

  constructor(id: string, name: string, systemPrompt?: string, conversationService?: ConversationService) {
    super(id, name, { handleMessages: true });
    this.systemPrompt = systemPrompt ?? 'You are a helpful assistant.';
    this.conversationService = conversationService;
  }

  async onMessage(message: UserMessage, ctx: AgentContext): Promise<AgentResponse> {
    if (!ctx.llm) {
      return { content: 'No LLM provider configured.' };
    }

    const llmMessages: ChatMessage[] = this.conversationService
      ? this.conversationService.buildMessages(
          { agentId: this.id, userId: message.userId, channel: message.channel },
          this.systemPrompt,
          message.content,
        )
      : [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: message.content },
        ];

    const response = await ctx.llm.chat(llmMessages);

    if (this.conversationService) {
      this.conversationService.recordTurn(
        { agentId: this.id, userId: message.userId, channel: message.channel },
        message.content,
        response.content,
      );
    }

    return { content: response.content };
  }
}

/** Strip sensitive fields from config for the dashboard. */
function redactConfig(config: GuardianAgentConfig): RedactedConfig {
  const llm: Record<string, { provider: string; model: string; baseUrl?: string }> = {};
  for (const [name, cfg] of Object.entries(config.llm)) {
    llm[name] = {
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
    };
  }

  return {
    llm,
    defaultProvider: config.defaultProvider,
    channels: {
      cli: config.channels.cli ? { enabled: config.channels.cli.enabled } : undefined,
      telegram: config.channels.telegram ? { enabled: config.channels.telegram.enabled } : undefined,
      web: config.channels.web ? {
        enabled: config.channels.web.enabled,
        port: config.channels.web.port,
        host: config.channels.web.host,
      } : undefined,
    },
    guardian: {
      enabled: config.guardian.enabled,
      rateLimit: config.guardian.rateLimit,
      inputSanitization: config.guardian.inputSanitization,
      outputScanning: config.guardian.outputScanning,
      sentinel: config.guardian.sentinel ? {
        enabled: config.guardian.sentinel.enabled,
        schedule: config.guardian.sentinel.schedule,
      } : undefined,
    },
    runtime: config.runtime,
    assistant: {
      setupCompleted: config.assistant.setup.completed,
      identity: {
        mode: config.assistant.identity.mode,
        primaryUserId: config.assistant.identity.primaryUserId,
      },
      memory: {
        enabled: config.assistant.memory.enabled,
        retentionDays: config.assistant.memory.retentionDays,
      },
      analytics: {
        enabled: config.assistant.analytics.enabled,
        retentionDays: config.assistant.analytics.retentionDays,
      },
      quickActions: {
        enabled: config.assistant.quickActions.enabled,
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
    },
  };
}

/** Build dashboard callbacks wired to runtime internals. */
function buildDashboardCallbacks(
  runtime: Runtime,
  configRef: { current: GuardianAgentConfig },
  conversations: ConversationService,
  identity: IdentityService,
  analytics: AnalyticsService,
  threatIntel: ThreatIntelService,
  configPath: string,
): DashboardCallbacks {
  const loadRawConfig = (): Record<string, unknown> => {
    if (!existsSync(configPath)) return {};
    const content = readFileSync(configPath, 'utf-8');
    return (yaml.load(content) as Record<string, unknown>) ?? {};
  };

  const persistAndApplyConfig = (rawConfig: Record<string, unknown>): { success: boolean; message: string } => {
    try {
      mkdirSync(dirname(configPath), { recursive: true });
      const yamlStr = yaml.dump(rawConfig, { lineWidth: -1, noRefs: true });
      writeFileSync(configPath, yamlStr, 'utf-8');

      // Reload with defaults/env interpolation to maintain canonical runtime config.
      const nextConfig = loadConfig(configPath);
      runtime.applyLLMConfiguration({
        llm: nextConfig.llm,
        defaultProvider: nextConfig.defaultProvider,
      });
      identity.update(nextConfig.assistant.identity);
      configRef.current = nextConfig;
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

    return persistAndApplyConfig(rawConfig);
  };

  const buildProviderInfo = async (withConnectivity: boolean): Promise<DashboardProviderInfo[]> => {
    const results: DashboardProviderInfo[] = [];
    for (const [name, provider] of runtime.providers) {
      const llmConfig = configRef.current.llm[name] as LLMConfig | undefined;
      const isLocal = provider.name === 'ollama' ||
        (llmConfig?.baseUrl && (llmConfig.baseUrl.includes('localhost') || llmConfig.baseUrl.includes('127.0.0.1')));

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

  return {
    onAgents: (): DashboardAgentInfo[] => {
      return runtime.registry.getAll().map(inst => ({
        id: inst.agent.id,
        name: inst.agent.name,
        state: inst.state,
        canChat: inst.agent.capabilities.handleMessages,
        capabilities: inst.definition.grantedCapabilities,
        provider: inst.definition.providerName,
        schedule: inst.definition.schedule,
        lastActivityMs: inst.lastActivityMs,
        consecutiveErrors: inst.consecutiveErrors,
      }));
    },

    onAgentDetail: (id: string): DashboardAgentDetail | null => {
      const inst = runtime.registry.get(id);
      if (!inst) return null;
      return {
        id: inst.agent.id,
        name: inst.agent.name,
        state: inst.state,
        canChat: inst.agent.capabilities.handleMessages,
        capabilities: inst.definition.grantedCapabilities,
        provider: inst.definition.providerName,
        schedule: inst.definition.schedule,
        lastActivityMs: inst.lastActivityMs,
        consecutiveErrors: inst.consecutiveErrors,
        resourceLimits: { ...inst.definition.resourceLimits },
      };
    },

    onAuditQuery: (filter) => runtime.auditLog.query(filter),

    onAuditSummary: (windowMs) => runtime.auditLog.getSummary(windowMs),

    onConfig: () => redactConfig(configRef.current),

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
        const isLocal = provider.name === 'ollama' ||
          (llmConfig?.baseUrl && (llmConfig.baseUrl.includes('localhost') || llmConfig.baseUrl.includes('127.0.0.1')));
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

    onProvidersStatus: async () => buildProviderInfo(true),

    onSSESubscribe: (listener: SSEListener): (() => void) => {
      const cleanups: Array<() => void> = [];

      // Real-time audit events
      const unsubAudit = runtime.auditLog.addListener((event) => {
        listener({ type: 'audit', data: event });
      });
      cleanups.push(unsubAudit);

      // Metrics every 5s
      const metricsInterval = setInterval(() => {
        const agents = runtime.registry.getAll().map(inst => ({
          id: inst.agent.id,
          name: inst.agent.name,
          state: inst.state,
          lastActivityMs: inst.lastActivityMs,
        }));
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

    onDispatch: async (agentId, msg) => {
      const channel = msg.channel ?? 'web';
      const channelUserId = msg.userId ?? `${channel}-user`;
      const canonicalUserId = identity.resolveCanonicalUserId(channel, channelUserId);
      analytics.track({
        type: 'message_sent',
        channel,
        canonicalUserId,
        channelUserId,
        agentId,
      });

      const message: UserMessage = {
        id: randomUUID(),
        userId: canonicalUserId,
        channel,
        content: msg.content,
        timestamp: Date.now(),
      };
      try {
        const response = await runtime.dispatchMessage(agentId, message);
        analytics.track({
          type: 'message_success',
          channel,
          canonicalUserId,
          channelUserId,
          agentId,
        });
        return response;
      } catch (err) {
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

    onConversationReset: async ({ agentId, userId, channel }) => {
      const canonicalUserId = identity.resolveCanonicalUserId(channel, userId);
      const removed = conversations.resetConversation({ agentId, userId: canonicalUserId, channel });
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
      return conversations.listSessions(canonicalUserId, channel, agentId);
    },

    onConversationUseSession: ({ agentId, userId, channel, sessionId }) => {
      const canonicalUserId = identity.resolveCanonicalUserId(channel, userId);
      const ok = conversations.setActiveSession({
        agentId,
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
      return runtime.dispatchMessage(agentId, {
        id: randomUUID(),
        userId: canonicalUserId,
        channel,
        content: built.prompt,
        timestamp: Date.now(),
      });
    },

    onSetupStatus: async () => {
      const providers = await buildProviderInfo(true);
      return evaluateSetupStatus(configRef.current, providers);
    },

    onSetupApply: async (input) => {
      const providerName = input.providerName?.trim() || (input.llmMode === 'ollama' ? 'ollama' : 'primary');
      const providerType = input.llmMode === 'ollama'
        ? 'ollama'
        : (input.providerType ?? 'openai');
      const model = input.model?.trim();
      const existingProvider = configRef.current.llm[providerName];
      if (!model) {
        return { success: false, message: 'model is required' };
      }
      if (providerType !== 'ollama' && !(input.apiKey?.trim()) && !existingProvider?.apiKey) {
        return { success: false, message: 'apiKey is required for external providers' };
      }

      const patch: Partial<GuardianAgentConfig> = {
        llm: {
          [providerName]: {
            provider: providerType,
            model,
            apiKey: input.apiKey?.trim() || undefined,
            baseUrl: input.baseUrl?.trim() || (providerType === 'ollama' ? 'http://127.0.0.1:11434' : undefined),
          },
        } as GuardianAgentConfig['llm'],
        assistant: {
          ...configRef.current.assistant,
          setup: {
            completed: input.setupCompleted ?? true,
          },
        },
      };

      if (input.setDefaultProvider !== false) {
        patch.defaultProvider = providerName;
      }

      if (input.telegramEnabled !== undefined) {
        patch.channels = {
          ...configRef.current.channels,
          telegram: {
            enabled: input.telegramEnabled,
            polling: configRef.current.channels.telegram?.polling ?? true,
            botToken: input.telegramBotToken ?? configRef.current.channels.telegram?.botToken,
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
      if (input.apiKey?.trim()) rawLLM[providerName].apiKey = input.apiKey.trim();

      if (input.setDefaultProvider !== false) {
        rawConfig.defaultProvider = providerName;
      }

      if (input.telegramEnabled !== undefined) {
        rawConfig.channels = rawConfig.channels ?? {};
        const rawChannels = rawConfig.channels as Record<string, unknown>;
        const rawTelegram = (rawChannels.telegram as Record<string, unknown> | undefined) ?? {};
        rawTelegram.enabled = input.telegramEnabled;
        rawTelegram.polling = rawTelegram.polling ?? true;
        if (input.telegramBotToken?.trim()) rawTelegram.botToken = input.telegramBotToken.trim();
        if (input.telegramAllowedChatIds) rawTelegram.allowedChatIds = input.telegramAllowedChatIds;
        rawChannels.telegram = rawTelegram;
      }

      const result = persistAndApplyConfig(rawConfig);
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
          ? 'Setup saved and applied. Restart to activate Telegram channel changes.'
          : 'Setup saved and applied.',
      };
    },

    onConfigUpdate: async (updates) => {
      const currentConfig = configRef.current;

      // Validate the next in-memory config first.
      const patch = {
        defaultProvider: updates.defaultProvider,
        llm: updates.llm as unknown as GuardianAgentConfig['llm'] | undefined,
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

      if (updates.llm) {
        const llmSection = (rawConfig.llm ?? {}) as Record<string, Record<string, unknown>>;
        for (const [name, providerUpdates] of Object.entries(updates.llm)) {
          if (!llmSection[name]) {
            llmSection[name] = {};
          }
          if (providerUpdates.provider) llmSection[name].provider = providerUpdates.provider;
          if (providerUpdates.model) llmSection[name].model = providerUpdates.model;
          if (providerUpdates.apiKey) llmSection[name].apiKey = providerUpdates.apiKey;
          if (providerUpdates.baseUrl) llmSection[name].baseUrl = providerUpdates.baseUrl;
        }
        rawConfig.llm = llmSection;
      }

      const result = persistAndApplyConfig(rawConfig);
      analytics.track({
        type: result.success ? 'config_update_success' : 'config_update_failed',
        channel: 'system',
        canonicalUserId: currentConfig.assistant.identity.primaryUserId,
        metadata: { result: result.message },
      });
      return result;
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
  };
}

/** Open a URL in the user's default browser. */
function openBrowser(url: string): void {
  const os = platform();
  const cmd = os === 'win32' ? `start "" "${url}"`
    : os === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;

  exec(cmd, (err) => {
    if (err) {
      log.info({ url }, 'Dashboard available at');
    }
  });
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
  const configRef = { current: loadConfig(configPath) };
  const config = configRef.current;

  const runtime = new Runtime(config);
  const identity = new IdentityService(config.assistant.identity);
  let analytics: AnalyticsService | null = null;
  const onSQLiteSecurityEvent = (event: {
    service: 'conversation' | 'analytics';
    severity: 'info' | 'warn';
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }) => {
    if (event.code === 'integrity_ok') {
      return;
    }

    if (event.severity === 'warn') {
      log.warn({ ...event }, 'SQLite security event');
    } else {
      log.info({ ...event }, 'SQLite security event');
    }

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

  const threatIntel = new ThreatIntelService({
    enabled: config.assistant.threatIntel.enabled,
    allowDarkWeb: config.assistant.threatIntel.allowDarkWeb,
    responseMode: config.assistant.threatIntel.responseMode,
    watchlist: config.assistant.threatIntel.watchlist,
    forumConnectors: [moltbookConnector],
  });
  let threatIntelInterval: NodeJS.Timeout | null = null;

  // Register agents from config (or a default chat agent)
  if (config.agents.length > 0) {
    for (const agentConfig of config.agents) {
      const agent = new ChatAgent(
        agentConfig.id,
        agentConfig.name,
        agentConfig.systemPrompt,
        conversations,
      );
      runtime.registerAgent(createAgentDefinition({
        agent,
        providerName: agentConfig.provider,
        schedule: agentConfig.schedule,
        grantedCapabilities: agentConfig.capabilities,
        resourceLimits: agentConfig.resourceLimits,
      }));
    }
  } else {
    // Default agent
    const defaultAgent = new ChatAgent('default', 'GuardianAgent', undefined, conversations);
    runtime.registerAgent(createAgentDefinition({
      agent: defaultAgent,
    }));
  }

  // Register Sentinel agent if enabled
  const sentinelConfig = config.guardian?.sentinel;
  if (sentinelConfig?.enabled !== false) {
    const sentinel = new SentinelAgent(sentinelConfig?.anomalyThresholds);
    runtime.registerAgent(createAgentDefinition({
      agent: sentinel,
      schedule: sentinelConfig?.schedule ?? '*/5 * * * *',
    }));
  }

  // Start channels
  const channels: { name: string; stop: () => Promise<void> }[] = [];

  const defaultAgentId = config.agents[0]?.id ?? 'default';
  const dashboardCallbacks = buildDashboardCallbacks(
    runtime,
    configRef,
    conversations,
    identity,
    analytics,
    threatIntel,
    configPath,
  );

  const autoScanMinutes = config.assistant.threatIntel.autoScanIntervalMinutes;
  if (config.assistant.threatIntel.enabled && autoScanMinutes > 0) {
    const intervalMs = autoScanMinutes * 60_000;
    threatIntelInterval = setInterval(() => {
      void (async () => {
        const summary = threatIntel.getSummary();
        if (summary.watchlistCount === 0) return;

        const result = await threatIntel.scan({
          includeDarkWeb: configRef.current.assistant.threatIntel.allowDarkWeb,
        });

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

  if (config.channels.cli?.enabled) {
    const cli = new CLIChannel({
      defaultAgent: config.channels.cli.defaultAgent ?? defaultAgentId,
      defaultUserId: 'cli',
      dashboard: dashboardCallbacks,
      onAgents: () => runtime.registry.getAll().map(inst => ({
        id: inst.agent.id,
        name: inst.agent.name,
        state: inst.state,
        capabilities: inst.definition.grantedCapabilities,
      })),
      onStatus: () => ({
        running: runtime.isRunning(),
        agentCount: runtime.registry.size,
        guardianEnabled: configRef.current.guardian.enabled,
        providers: [...runtime.providers.keys()],
      }),
    });
    await cli.start(async (msg) => {
      if (dashboardCallbacks.onDispatch) {
        return dashboardCallbacks.onDispatch(
          configRef.current.channels.cli?.defaultAgent ?? defaultAgentId,
          { content: msg.content, userId: msg.userId, channel: msg.channel },
        );
      }
      return runtime.dispatchMessage(configRef.current.channels.cli?.defaultAgent ?? defaultAgentId, msg);
    });
    channels.push({ name: 'cli', stop: () => cli.stop() });
  }

  if (config.channels.telegram?.enabled && config.channels.telegram.botToken) {
    const telegramDefaultAgent = config.channels.telegram.defaultAgent ?? defaultAgentId;
    const telegram = new TelegramChannel({
      botToken: config.channels.telegram.botToken,
      allowedChatIds: config.channels.telegram.allowedChatIds,
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
      if (dashboardCallbacks.onDispatch) {
        return dashboardCallbacks.onDispatch(
          configRef.current.channels.telegram?.defaultAgent ?? defaultAgentId,
          { content: msg.content, userId: msg.userId, channel: msg.channel },
        );
      }
      return runtime.dispatchMessage(configRef.current.channels.telegram?.defaultAgent ?? defaultAgentId, msg);
    });
    channels.push({ name: 'telegram', stop: () => telegram.stop() });
  }

  if (config.channels.web?.enabled) {
    const web = new WebChannel({
      port: config.channels.web.port,
      host: config.channels.web.host,
      defaultAgent: config.channels.web.defaultAgent ?? defaultAgentId,
      authToken: config.channels.web.authToken,
      allowedOrigins: config.channels.web.allowedOrigins,
      maxBodyBytes: config.channels.web.maxBodyBytes,
      staticDir: join(__dirname, '..', 'web', 'public'),
      dashboard: dashboardCallbacks,
    });
    await web.start(async (msg) => {
      if (dashboardCallbacks.onDispatch) {
        return dashboardCallbacks.onDispatch(
          configRef.current.channels.web?.defaultAgent ?? defaultAgentId,
          { content: msg.content, userId: msg.userId, channel: msg.channel },
        );
      }
      return runtime.dispatchMessage(configRef.current.channels.web?.defaultAgent ?? defaultAgentId, msg);
    });
    channels.push({ name: 'web', stop: () => web.stop() });

    // Open browser to dashboard
    const webUrl = `http://${config.channels.web.host ?? 'localhost'}:${config.channels.web.port ?? 3000}`;
    openBrowser(webUrl);
  }

  // Start runtime
  await runtime.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down...');

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

    await runtime.stop();
    conversations.close();
    analytics.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error({ err }, 'Fatal error');
  process.exit(1);
});
