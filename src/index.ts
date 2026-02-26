#!/usr/bin/env node
/**
 * Guardian Agent — Entry point.
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
import { WebChannel, type WebAuthRuntimeConfig } from './channels/web.js';
import type { DashboardCallbacks, DashboardAgentInfo, DashboardAgentDetail, DashboardProviderInfo, RedactedConfig, SSEListener } from './channels/web-types.js';
import type { LLMConfig } from './config/types.js';
import { BaseAgent } from './agent/agent.js';
import { createAgentDefinition } from './agent/agent.js';
import type { AgentContext, AgentResponse, UserMessage } from './agent/types.js';
import { SentinelAgent } from './agents/sentinel.js';
import { createLogger, setLogLevel } from './util/logging.js';
import { ConversationService } from './runtime/conversation.js';
import { getReferenceGuide, formatGuideForTelegram } from './reference-guide.js';
import type { ChatMessage } from './llm/types.js';
import { IdentityService } from './runtime/identity.js';
import { AnalyticsService } from './runtime/analytics.js';
import { buildQuickActionPrompt, getQuickActions } from './quick-actions.js';
import { evaluateSetupStatus } from './runtime/setup.js';
import { ThreatIntelService } from './runtime/threat-intel.js';
import { MoltbookConnector } from './runtime/moltbook-connector.js';
import { AssistantOrchestrator } from './runtime/orchestrator.js';
import { AssistantJobTracker } from './runtime/assistant-jobs.js';
import { parseDirectFileSearchIntent } from './runtime/search-intent.js';
import { ToolExecutor } from './tools/executor.js';
import type { ToolExecutorOptions } from './tools/executor.js';
import type { ToolPolicySnapshot } from './tools/types.js';
import { composeGuardianSystemPrompt } from './prompts/guardian-core.js';

const log = createLogger('main');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default chat agent that uses the configured LLM provider. */
class ChatAgent extends BaseAgent {
  private systemPrompt: string;
  private conversationService?: ConversationService;
  private tools?: ToolExecutor;
  private maxToolRounds: number;

  constructor(
    id: string,
    name: string,
    systemPrompt?: string,
    conversationService?: ConversationService,
    tools?: ToolExecutor,
  ) {
    super(id, name, { handleMessages: true });
    this.systemPrompt = composeGuardianSystemPrompt(systemPrompt);
    this.conversationService = conversationService;
    this.tools = tools;
    this.maxToolRounds = 6;
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

    let finalContent = '';
    const directSearch = await this.tryDirectFilesystemSearch(message, ctx);
    if (directSearch) {
      finalContent = directSearch;
      if (this.conversationService) {
        this.conversationService.recordTurn(
          { agentId: this.id, userId: message.userId, channel: message.channel },
          message.content,
          finalContent,
        );
      }
      return { content: finalContent };
    }

    if (!this.tools?.isEnabled()) {
      const response = await ctx.llm.chat(llmMessages);
      finalContent = response.content;
    } else {
      let rounds = 0;
      const toolDefs = this.tools.listToolDefinitions();
      while (rounds < this.maxToolRounds) {
        const response = await ctx.llm.chat(llmMessages, { tools: toolDefs });
        finalContent = response.content;
        if (!response.toolCalls || response.toolCalls.length === 0) {
          break;
        }

        llmMessages.push({
          role: 'assistant',
          content: response.content ?? '',
          toolCalls: response.toolCalls,
        });

        for (const toolCall of response.toolCalls) {
          let parsedArgs: Record<string, unknown> = {};
          if (toolCall.arguments?.trim()) {
            try {
              parsedArgs = JSON.parse(toolCall.arguments) as Record<string, unknown>;
            } catch {
              parsedArgs = {};
            }
          }
          const toolResult = await this.tools.executeModelTool(
            toolCall.name,
            parsedArgs,
            {
              origin: 'assistant',
              agentId: this.id,
              userId: message.userId,
              channel: message.channel,
              requestId: message.id,
              agentContext: { checkAction: ctx.checkAction },
            },
          );
          llmMessages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            content: JSON.stringify(toolResult),
          });
        }
        rounds += 1;
      }

      if (!finalContent) {
        finalContent = 'Tool processing completed, but no final assistant response was generated.';
      }
    }

    if (this.conversationService) {
      this.conversationService.recordTurn(
        { agentId: this.id, userId: message.userId, channel: message.channel },
        message.content,
        finalContent,
      );
    }

    return { content: finalContent };
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

function toBoolean(value: unknown): boolean {
  return value === true;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
        auth: {
          mode: config.channels.web.auth?.mode ?? (config.channels.web.authToken ? 'bearer_required' : 'disabled'),
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
      tools: {
        enabled: config.assistant.tools.enabled,
        policyMode: config.assistant.tools.policyMode,
        allowExternalPosting: config.assistant.tools.allowExternalPosting,
        allowedPathsCount: config.assistant.tools.allowedPaths.length,
        allowedCommandsCount: config.assistant.tools.allowedCommands.length,
        allowedDomainsCount: config.assistant.tools.allowedDomains.length,
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
  orchestrator: AssistantOrchestrator,
  jobTracker: AssistantJobTracker,
  threatIntel: ThreatIntelService,
  toolExecutor: ToolExecutor,
  webAuthStateRef: { current: WebAuthRuntimeConfig },
  applyWebAuthRuntime: (auth: WebAuthRuntimeConfig) => void,
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
      toolExecutor.updatePolicy({
        mode: nextConfig.assistant.tools.policyMode,
        toolPolicies: nextConfig.assistant.tools.toolPolicies,
        sandbox: {
          allowedPaths: nextConfig.assistant.tools.allowedPaths,
          allowedCommands: nextConfig.assistant.tools.allowedCommands,
          allowedDomains: nextConfig.assistant.tools.allowedDomains,
        },
      });
      const persistedToken = nextConfig.channels.web?.auth?.token?.trim()
        || nextConfig.channels.web?.authToken?.trim();
      const mode = nextConfig.channels.web?.auth?.mode
        ?? (persistedToken ? 'bearer_required' : webAuthStateRef.current.mode);
      webAuthStateRef.current = {
        ...webAuthStateRef.current,
        mode,
        token: mode === 'disabled'
          ? undefined
          : (persistedToken || webAuthStateRef.current.token),
        tokenSource: persistedToken
          ? 'config'
          : (webAuthStateRef.current.tokenSource ?? 'ephemeral'),
        rotateOnStartup: nextConfig.channels.web?.auth?.rotateOnStartup ?? false,
        sessionTtlMinutes: nextConfig.channels.web?.auth?.sessionTtlMinutes,
      };
      applyWebAuthRuntime(webAuthStateRef.current);
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

  const persistAuthState = (): { success: boolean; message: string } => {
    const rawConfig = loadRawConfig();
    rawConfig.channels = rawConfig.channels ?? {};
    const rawChannels = rawConfig.channels as Record<string, unknown>;
    const rawWeb = (rawChannels.web as Record<string, unknown> | undefined) ?? {};
    rawWeb.enabled = rawWeb.enabled ?? true;
    rawWeb.auth = {
      mode: webAuthStateRef.current.mode,
      token: webAuthStateRef.current.token,
      rotateOnStartup: webAuthStateRef.current.rotateOnStartup ?? false,
      sessionTtlMinutes: webAuthStateRef.current.sessionTtlMinutes,
      tokenSource: webAuthStateRef.current.tokenSource ?? 'config',
    };
    delete rawWeb.authToken;
    rawChannels.web = rawWeb;
    return persistAndApplyConfig(rawConfig);
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

    onAuthStatus: () => getAuthStatus(),

    onAuthUpdate: async (input) => {
      const nextMode = input.mode ?? webAuthStateRef.current.mode;
      const nextToken = input.token?.trim()
        ? input.token.trim()
        : webAuthStateRef.current.token;
      webAuthStateRef.current = {
        ...webAuthStateRef.current,
        mode: nextMode,
        token: nextMode === 'disabled' ? undefined : nextToken,
        rotateOnStartup: input.rotateOnStartup ?? webAuthStateRef.current.rotateOnStartup,
        sessionTtlMinutes: input.sessionTtlMinutes ?? webAuthStateRef.current.sessionTtlMinutes,
        tokenSource: input.token?.trim()
          ? 'config'
          : webAuthStateRef.current.tokenSource ?? 'config',
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
        metadata: { mode: webAuthStateRef.current.mode },
      });
      return { success: true, message: 'Web auth settings saved.', status: getAuthStatus() };
    },

    onAuthRotate: async () => {
      const token = randomUUID().replace(/-/g, '');
      webAuthStateRef.current = {
        ...webAuthStateRef.current,
        mode: webAuthStateRef.current.mode === 'disabled' ? 'bearer_required' : webAuthStateRef.current.mode,
        token,
        tokenSource: 'config',
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

    onAuthRevoke: async () => {
      webAuthStateRef.current = {
        ...webAuthStateRef.current,
        mode: 'disabled',
        token: undefined,
        tokenSource: 'config',
      };
      applyWebAuthRuntime(webAuthStateRef.current);
      const persisted = persistAuthState();
      if (!persisted.success) {
        return { success: false, message: persisted.message, status: getAuthStatus() };
      }
      analytics.track({
        type: 'auth_revoked',
        channel: 'system',
        canonicalUserId: configRef.current.assistant.identity.primaryUserId,
      });
      return { success: true, message: 'Web auth disabled. Dashboard/API are now open.', status: getAuthStatus() };
    },

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
    }),

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
        message: 'Tool policy updated.',
        policy,
      };
    },

    onToolsApprovalDecision: async (input) => {
      const result = await toolExecutor.decideApproval(
        input.approvalId,
        input.decision,
        input.actor,
        input.reason,
      );
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
      };
    },

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

      return orchestrator.dispatch(
        {
          agentId,
          userId: canonicalUserId,
          channel,
          content: msg.content,
          priority: 'high',
          requestType: 'chat',
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
      return evaluateSetupStatus(configRef.current, providers);
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
      );
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
  const config = configRef.current;

  // Respect config runtime log level unless caller explicitly overrides via LOG_LEVEL.
  if (!process.env['LOG_LEVEL']) {
    setLogLevel(config.runtime.logLevel);
  }

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
  const toolExecutorOptions: ToolExecutorOptions = {
    enabled: config.assistant.tools.enabled,
    workspaceRoot: process.cwd(),
    policyMode: config.assistant.tools.policyMode,
    toolPolicies: config.assistant.tools.toolPolicies,
    allowedPaths: config.assistant.tools.allowedPaths,
    allowedCommands: config.assistant.tools.allowedCommands,
    allowedDomains: config.assistant.tools.allowedDomains,
    allowExternalPosting: config.assistant.tools.allowExternalPosting,
    threatIntel,
    onCheckAction: ({ type, params, agentId, origin }) => {
      const capabilities = type === 'read_file'
        ? ['read_files']
        : type === 'write_file'
        ? ['write_files']
        : type === 'execute_command'
        ? ['execute_commands']
        : type === 'http_request'
        ? ['network_access']
        : type === 'read_email'
        ? ['read_email']
        : type === 'draft_email'
        ? ['draft_email']
        : type === 'send_email'
        ? ['send_email']
        : [];
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
  };
  const toolExecutor = new ToolExecutor(toolExecutorOptions);

  const webMode = config.channels.web?.auth?.mode
    ?? (config.channels.web?.authToken ? 'bearer_required' : 'bearer_required');
  const configuredToken = config.channels.web?.auth?.token?.trim() || config.channels.web?.authToken?.trim();
  const rotateOnStartup = config.channels.web?.auth?.rotateOnStartup ?? false;
  const shouldGenerateToken = webMode !== 'disabled' && (!configuredToken || rotateOnStartup);
  const effectiveToken = webMode === 'disabled'
    ? undefined
    : (shouldGenerateToken ? randomUUID().replace(/-/g, '') : configuredToken);
  const webAuthStateRef: { current: WebAuthRuntimeConfig } = {
    current: {
      mode: webMode,
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

  // Register agents from config (or a default chat agent)
  if (config.agents.length > 0) {
    for (const agentConfig of config.agents) {
      const agent = new ChatAgent(
        agentConfig.id,
        agentConfig.name,
        agentConfig.systemPrompt,
        conversations,
        toolExecutor,
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
    const defaultAgent = new ChatAgent('default', 'Guardian Agent', undefined, conversations, toolExecutor);
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
    orchestrator,
    jobTracker,
    threatIntel,
    toolExecutor,
    webAuthStateRef,
    applyWebAuthRuntime,
    configPath,
  );

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

  if (config.channels.cli?.enabled) {
    const enabledChannels: string[] = ['cli'];
    if (config.channels.web?.enabled) enabledChannels.push('web');
    if (config.channels.telegram?.enabled) enabledChannels.push('telegram');

    const cli = new CLIChannel({
      defaultAgent: config.channels.cli.defaultAgent ?? defaultAgentId,
      defaultUserId: 'cli',
      dashboard: dashboardCallbacks,
      version: '1.0.0',
      configPath,
      startupStatus: {
        guardianEnabled: config.guardian.enabled,
        providerName: config.defaultProvider,
        channels: enabledChannels,
      },
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
    if (webAuthStateRef.current.mode !== 'disabled' && !webAuthStateRef.current.token) {
      webAuthStateRef.current = {
        ...webAuthStateRef.current,
        token: randomUUID().replace(/-/g, ''),
        tokenSource: 'ephemeral',
      };
    }
    if (webAuthStateRef.current.mode !== 'disabled' && webAuthStateRef.current.tokenSource === 'ephemeral') {
      log.warn(
        {
          token: webAuthStateRef.current.token,
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
