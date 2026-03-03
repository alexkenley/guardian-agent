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
import { MCPClientManager } from './tools/mcp-client.js';
import type { MCPServerConfig } from './tools/mcp-client.js';
import { composeGuardianSystemPrompt } from './prompts/guardian-core.js';
import { MessageRouter, type RouteDecision } from './runtime/message-router.js';
import { ModelFallbackChain } from './llm/model-fallback.js';
import { createProviders } from './llm/provider.js';
import { hashObjectSha256Hex } from './util/crypto-guardrails.js';

const log = createLogger('main');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default chat agent that uses the configured LLM provider. */
/** Pattern matching approval-like messages from the user. */
const APPROVAL_PATTERN = /^(yes|yep|yeah|y|approved?|go ahead|do it|confirm|ok|okay|sure|proceed|accept)\b/i;

function generateSecureToken(byteLength = 24): string {
  return randomBytes(byteLength).toString('hex');
}

function previewTokenForLog(token: string): string {
  if (token.length <= 8) return token;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
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

class ChatAgent extends BaseAgent {
  private systemPrompt: string;
  private conversationService?: ConversationService;
  private tools?: ToolExecutor;
  private maxToolRounds: number;
  /** Pending approval IDs from the last tool round, keyed by user+channel. */
  private pendingApprovals: Map<string, string[]> = new Map();
  /** Optional model fallback chain for retrying failed LLM calls. */
  private fallbackChain?: ModelFallbackChain;

  constructor(
    id: string,
    name: string,
    systemPrompt?: string,
    conversationService?: ConversationService,
    tools?: ToolExecutor,
    fallbackChain?: ModelFallbackChain,
    soulPrompt?: string,
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
    this.maxToolRounds = 6;
    this.fallbackChain = fallbackChain;
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

  async onMessage(message: UserMessage, ctx: AgentContext): Promise<AgentResponse> {
    if (!ctx.llm) {
      return { content: 'No LLM provider configured.' };
    }

    // Check if user is approving a pending tool action
    const approvalResult = await this.tryHandleApproval(message);
    if (approvalResult) {
      if (this.conversationService) {
        this.conversationService.recordTurn(
          { agentId: this.id, userId: message.userId, channel: message.channel },
          message.content,
          approvalResult,
        );
      }
      return { content: approvalResult };
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

    // Direct web search: if the user clearly wants web results, call web_search
    // directly so the tool executes even when the LLM doesn't invoke it.
    const webSearchResult = await this.tryDirectWebSearch(message, ctx);
    if (webSearchResult) {
      // Feed the raw search results through the LLM for a natural response
      if (ctx.llm) {
        const llmFormat: ChatMessage[] = [
          ...llmMessages,
          { role: 'user', content: `Here are web search results for the user's query. Summarize and present them clearly:\n\n${webSearchResult}` },
        ];
        const formatted = await this.chatWithFallback(ctx, llmFormat);
        finalContent = formatted.content || webSearchResult;
      } else {
        finalContent = webSearchResult;
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

    // Clear any stale pending approvals for this user
    const userKey = `${message.userId}:${message.channel}`;
    this.pendingApprovals.delete(userKey);

    if (!this.tools?.isEnabled()) {
      const response = await this.chatWithFallback(ctx, llmMessages);
      finalContent = response.content;
    } else {
      let rounds = 0;
      const toolDefs = this.tools.listToolDefinitions();
      const pendingIds: string[] = [];
      while (rounds < this.maxToolRounds) {
        const response = await this.chatWithFallback(ctx, llmMessages, { tools: toolDefs });
        finalContent = response.content;
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
                const output = prefetched.output as { answer?: unknown; results?: unknown; provider?: unknown };
                const answer = toString(output.answer);
                const results = Array.isArray(output.results) ? output.results : [];
                // If Perplexity returned a synthesized answer, inject it directly
                if (answer) {
                  llmMessages.push({
                    role: 'user',
                    content: `[web_search results for "${searchQuery}"]:\n${answer}\n\nSources:\n${results.map((r: { url?: string }, i: number) => `${i + 1}. ${r.url ?? ''}`).join('\n')}\n\nPlease use these results to answer the user's question.`,
                  });
                } else if (results.length > 0) {
                  const snippets = results.map((r: { title?: string; url?: string; snippet?: string }, i: number) =>
                    `${i + 1}. ${r.title ?? '(untitled)'} — ${r.url ?? ''}\n   ${r.snippet ?? ''}`
                  ).join('\n');
                  llmMessages.push({
                    role: 'user',
                    content: `[web_search results for "${searchQuery}"]:\n${snippets}\n\nPlease synthesize these results to answer the user's question.`,
                  });
                }
                // Re-prompt the LLM with the search results
                if (answer || results.length > 0) {
                  const retryResponse = await this.chatWithFallback(ctx, llmMessages);
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

        let hasPending = false;
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

          // Track pending approvals so we can auto-approve on user confirmation
          if (toolResult.status === 'pending_approval' && toolResult.approvalId) {
            pendingIds.push(String(toolResult.approvalId));
            hasPending = true;
          }

          llmMessages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            content: JSON.stringify(toolResult),
          });
        }

        // If all tools in this round are pending, stop looping — user needs to approve
        if (hasPending) break;
        rounds += 1;
      }

      // Store pending approvals for this user so we can auto-approve on their next message
      if (pendingIds.length > 0) {
        this.pendingApprovals.set(userKey, pendingIds);
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

  /**
   * Check if the user's message is an approval for pending tool actions.
   * If so, approve them and return a summary.
   */
  private async tryHandleApproval(message: UserMessage): Promise<string | null> {
    if (!this.tools?.isEnabled()) return null;

    const userKey = `${message.userId}:${message.channel}`;
    const pendingIds = this.pendingApprovals.get(userKey);
    if (!pendingIds?.length) return null;
    if (!APPROVAL_PATTERN.test(message.content.trim())) return null;

    // User is approving — process all pending approvals
    this.pendingApprovals.delete(userKey);
    const results: string[] = [];
    for (const approvalId of pendingIds) {
      try {
        const result = await this.tools.decideApproval(approvalId, 'approved', message.userId);
        if (result.success) {
          results.push(result.message ?? `Approved and executed (${approvalId}).`);
        } else {
          results.push(result.message ?? `Approval failed (${approvalId}).`);
        }
      } catch (err) {
        results.push(`Error approving ${approvalId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return results.join('\n');
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

/**
 * Detect web search intent from free-form user messages.
 * Returns a search query string, or null if the message isn't a web search request.
 * Deliberately broad: if the user asks to "find", "search", "look up", "what are the best",
 * etc. AND the message is about an external topic (not files/code), we treat it as web search.
 */
function parseWebSearchIntent(content: string): string | null {
  const text = content.trim();
  if (!text || text.length < 5) return null;

  // Must NOT be a filesystem search (those are handled by tryDirectFilesystemSearch)
  if (/\b(file|folder|directory|path|onedrive|drive|\.txt|\.json|\.ts|\.js|\.py)\b/i.test(text)) {
    return null;
  }

  // Detect web search patterns
  const webPatterns = [
    /\b(?:search|find|look\s*up|google|browse|what\s+(?:are|is)|show\s+me|tell\s+me\s+about|list)\b/i,
    /\b(?:top\s+\d+|best|popular|recommend|nearby|restaurants?|hotels?|reviews?|news|weather|price|recipe)\b/i,
    /\b(?:how\s+(?:to|do|does|can|much)|where\s+(?:is|are|can|to)|who\s+(?:is|are|was))\b/i,
  ];

  const matchCount = webPatterns.filter((p) => p.test(text)).length;
  // Need at least one strong signal
  if (matchCount === 0) return null;

  // Extract the query — use the full message, cleaned up
  const query = text
    .replace(/^(?:please|can you|could you|help me|i need to|i want to)\s+/i, '')
    .replace(/^(?:search|find|look\s*up|google|browse)\s+(?:for\s+|the\s+web\s+for\s+)?/i, '')
    .replace(/\s+on\s+the\s+(?:web|internet|online)\s*$/i, '')
    .trim();

  return query.length >= 3 ? query : null;
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
        webSearch: {
          provider: config.assistant.tools.webSearch?.provider ?? 'auto',
          perplexityConfigured: !!config.assistant.tools.webSearch?.perplexityApiKey,
          openRouterConfigured: !!config.assistant.tools.webSearch?.openRouterApiKey,
          braveConfigured: !!config.assistant.tools.webSearch?.braveApiKey,
        },
      },
    },
    fallbacks: config.fallbacks,
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
  router: MessageRouter,
): DashboardCallbacks {
  const loadRawConfig = (): Record<string, unknown> => {
    if (!existsSync(configPath)) return {};
    const content = readFileSync(configPath, 'utf-8');
    return (yaml.load(content) as Record<string, unknown>) ?? {};
  };

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
    };
    return persistAndApplyConfig(rawConfig, {
      changedBy: 'tools-control-plane',
      reason: 'tool policy update',
    });
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
      const isInternal = (agentId: string) =>
        router.findAgentByRole('local')?.id === agentId
        || router.findAgentByRole('external')?.id === agentId;
      return runtime.registry.getAll().map(inst => ({
        id: inst.agent.id,
        name: inst.agent.name,
        state: inst.state,
        canChat: inst.agent.capabilities.handleMessages,
        internal: isInternal(inst.agent.id),
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
      const isInternal =
        router.findAgentByRole('local')?.id === id
        || router.findAgentByRole('external')?.id === id;
      return {
        id: inst.agent.id,
        name: inst.agent.name,
        state: inst.state,
        canChat: inst.agent.capabilities.handleMessages,
        internal: isInternal,
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

    onAuditVerifyChain: () => runtime.auditLog.verifyChain(),

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
      const token = generateSecureToken();
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

    onDispatch: async (agentId, msg, routeDecision) => {
      const channel = msg.channel ?? 'web';
      const channelUserId = msg.userId ?? `${channel}-user`;
      const canonicalUserId = identity.resolveCanonicalUserId(channel, channelUserId);
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

          // Fallbacks
          if (input.fallbacks !== undefined) {
            rawConfig.fallbacks = input.fallbacks.length > 0 ? input.fallbacks : undefined;
          }

          // Web search config
          const hasWebSearch = input.webSearchProvider || input.perplexityApiKey?.trim() || input.openRouterApiKey?.trim() || input.braveApiKey?.trim();
          if (hasWebSearch) {
            rawConfig.assistant = rawConfig.assistant ?? {};
            const rawAssistantObj = rawConfig.assistant as Record<string, unknown>;
            rawAssistantObj.tools = rawAssistantObj.tools ?? {};
            const rawTools = rawAssistantObj.tools as Record<string, unknown>;
            rawTools.webSearch = rawTools.webSearch ?? {};
            const rawWS = rawTools.webSearch as Record<string, unknown>;
            if (input.webSearchProvider) rawWS.provider = input.webSearchProvider;
            if (input.perplexityApiKey?.trim()) rawWS.perplexityApiKey = input.perplexityApiKey.trim();
            if (input.openRouterApiKey?.trim()) rawWS.openRouterApiKey = input.openRouterApiKey.trim();
            if (input.braveApiKey?.trim()) rawWS.braveApiKey = input.braveApiKey.trim();
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
  // When running in an interactive TTY (CLI), keep logs silent so JSON output
  // doesn't pollute the readline prompt.  Use LOG_FILE for persistent logging.
  if (!process.env['LOG_LEVEL']) {
    if (process.stdout.isTTY && !process.env['LOG_FILE']) {
      setLogLevel('silent');
    } else {
      setLogLevel(config.runtime.logLevel);
    }
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
  // ─── MCP Client Manager ─────────────────────────────────────
  let mcpManager: MCPClientManager | undefined;
  const mcpConfig = config.assistant.tools.mcp;
  if (mcpConfig?.enabled && mcpConfig.servers.length > 0) {
    mcpManager = new MCPClientManager();
    for (const server of mcpConfig.servers) {
      const serverConfig: MCPServerConfig = {
        id: server.id,
        name: server.name,
        transport: 'stdio',
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: server.cwd,
        timeoutMs: server.timeoutMs,
      };
      try {
        await mcpManager.addServer(serverConfig);
        log.info(
          { serverId: server.id, serverName: server.name },
          'MCP server connected',
        );
      } catch (err) {
        log.error(
          { serverId: server.id, err: err instanceof Error ? err.message : String(err) },
          'Failed to connect MCP server (continuing without it)',
        );
      }
    }
    const toolCount = mcpManager.getAllToolDefinitions().length;
    if (toolCount > 0) {
      log.info({ toolCount }, 'MCP tools discovered and available');
    }
  }

  const toolExecutorOptions: ToolExecutorOptions = {
    enabled: config.assistant.tools.enabled,
    workspaceRoot: process.cwd(),
    policyMode: config.assistant.tools.policyMode,
    toolPolicies: config.assistant.tools.toolPolicies,
    allowedPaths: config.assistant.tools.allowedPaths,
    allowedCommands: config.assistant.tools.allowedCommands,
    allowedDomains: config.assistant.tools.allowedDomains,
    allowExternalPosting: config.assistant.tools.allowExternalPosting,
    mcpManager,
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
    ?? (config.channels.web?.authToken ? 'bearer_required' : 'localhost_no_auth');
  const configuredToken = config.channels.web?.auth?.token?.trim() || config.channels.web?.authToken?.trim();
  const rotateOnStartup = config.channels.web?.auth?.rotateOnStartup ?? false;
  const needsToken = webMode === 'bearer_required';
  const shouldGenerateToken = needsToken && (!configuredToken || rotateOnStartup);
  const effectiveToken = !needsToken
    ? configuredToken || undefined
    : (shouldGenerateToken ? generateSecureToken() : configuredToken);
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

  // ─── Helper: detect external (non-Ollama) LLM provider ───
  const findExternalProvider = (cfg: GuardianAgentConfig): string | null => {
    for (const [name, llmCfg] of Object.entries(cfg.llm)) {
      if (llmCfg.provider === 'anthropic' || llmCfg.provider === 'openai') {
        return name;
      }
    }
    return null;
  };

  // ─── Message router ────────────────────────────────────────
  const router = new MessageRouter(config.routing);

  // ─── Model fallback chain ─────────────────────────────────
  // Build a fallback chain from config.fallbacks: [defaultProvider, ...fallbacks]
  // When the primary provider fails (rate limit, timeout, etc.), the chain
  // tries each fallback in order with per-provider cooldowns.
  let fallbackChain: ModelFallbackChain | undefined;
  if (config.fallbacks?.length) {
    const allProviders = createProviders(config.llm);
    const order = [config.defaultProvider, ...config.fallbacks.filter(f => f !== config.defaultProvider)];
    fallbackChain = new ModelFallbackChain(allProviders, order);
    log.info({ order: fallbackChain.getProviderOrder() }, 'Model fallback chain configured');
  }

  // Register agents from config, auto-create dual agents, or single default
  const externalProviderName = findExternalProvider(config);
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

  if (config.agents.length > 0) {
    // Config-driven agents: register all and build router from config rules
    const primaryConfiguredAgentId = config.agents.find((agent) => agent.role === 'general')?.id
      ?? config.agents[0]?.id;
    for (const agentConfig of config.agents) {
      const soulMode: SoulInjectionMode = agentConfig.id === primaryConfiguredAgentId
        ? config.assistant.soul.primaryMode
        : config.assistant.soul.delegatedMode;
      const agent = new ChatAgent(
        agentConfig.id,
        agentConfig.name,
        agentConfig.systemPrompt,
        conversations,
        toolExecutor,
        fallbackChain,
        selectSoulPrompt(soulProfile, soulMode),
      );
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
  } else if (externalProviderName) {
    // Auto dual-agent: local (Ollama) + external (Anthropic/OpenAI)
    const localPrompt = 'You specialize in local workstation tasks: file operations, code editing, git, build tools, and local command execution. Focus on filesystem, development, and local system tasks. If the user asks to search the web or look something up online, use the web_search and web_fetch tools — they are available to you.';
    const externalPrompt = 'You specialize in external and network tasks: web research, API calls, email, threat intelligence, and online services. Use web_search to find information online and web_fetch to read web pages. Always use these tools when the user asks to search, look up, or find something on the web.';

    const localAgent = new ChatAgent(
      'local',
      'Local Agent',
      localPrompt,
      conversations,
      toolExecutor,
      fallbackChain,
      selectSoulPrompt(soulProfile, config.assistant.soul.primaryMode),
    );
    runtime.registerAgent(createAgentDefinition({
      agent: localAgent,
      providerName: config.defaultProvider,
      grantedCapabilities: ['read_files', 'write_files', 'execute_commands'],
    }));

    const externalAgent = new ChatAgent(
      'external',
      'External Agent',
      externalPrompt,
      conversations,
      toolExecutor,
      fallbackChain,
      selectSoulPrompt(soulProfile, config.assistant.soul.delegatedMode),
    );
    runtime.registerAgent(createAgentDefinition({
      agent: externalAgent,
      providerName: externalProviderName,
      grantedCapabilities: ['network_access', 'read_email', 'draft_email', 'send_email'],
    }));

    // Register with router using default domain rules
    router.registerAgent('local', ['read_files', 'write_files', 'execute_commands'], {
      domains: ['filesystem', 'code'],
      patterns: [
        '\\b(file|folder|directory|path|create|delete|move|copy|rename|save|open)\\b',
        '\\b(git|commit|branch|merge|pull request|build|compile|lint|test|npm|node)\\b',
      ],
      priority: 5,
    }, 'local');
    router.registerAgent('external', ['network_access', 'read_email', 'draft_email', 'send_email'], {
      domains: ['network', 'email'],
      patterns: [
        '\\b(search|web|browse|http|api|download|upload|url|website|online|internet)\\b',
        '\\b(email|mail|send|draft|inbox|compose|reply|forward|gmail)\\b',
        '\\b(cve|vulnerability|threat|exploit|security advisory|intelligence)\\b',
      ],
      priority: 5,
    }, 'external');

    log.info(
      { local: config.defaultProvider, external: externalProviderName },
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
      fallbackChain,
      selectSoulPrompt(soulProfile, config.assistant.soul.primaryMode),
    );
    runtime.registerAgent(createAgentDefinition({
      agent: defaultAgent,
      grantedCapabilities: [
        'read_files',
        'write_files',
        'execute_commands',
        'network_access',
        'read_email',
        'draft_email',
        'send_email',
      ],
    }));
    router.registerAgent('default', [
      'read_files', 'write_files', 'execute_commands',
      'network_access', 'read_email', 'draft_email', 'send_email',
    ]);
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

  const defaultAgentId = config.agents[0]?.id ?? (externalProviderName ? 'local' : 'default');

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
    router,
  );

  // Killswitch: triggers graceful shutdown from CLI or web
  dashboardCallbacks.onKillswitch = () => {
    log.warn('Killswitch activated — shutting down all services');
    process.kill(process.pid, 'SIGTERM');
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

  if (config.channels.cli?.enabled) {
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
    channels.push({ name: 'telegram', stop: () => telegram.stop() });
  }

  if (config.channels.web?.enabled) {
    if (webAuthStateRef.current.mode !== 'disabled' && !webAuthStateRef.current.token) {
      webAuthStateRef.current = {
        ...webAuthStateRef.current,
        token: generateSecureToken(),
        tokenSource: 'ephemeral',
      };
    }
    if (webAuthStateRef.current.mode === 'bearer_required' && webAuthStateRef.current.tokenSource === 'ephemeral') {
      log.warn(
        {
          tokenPreview: webAuthStateRef.current.token ? previewTokenForLog(webAuthStateRef.current.token) : undefined,
          mode: webAuthStateRef.current.mode,
          host: config.channels.web.host ?? 'localhost',
          port: config.channels.web.port ?? 3000,
        },
        'No web auth token configured. Generated an ephemeral token for this run.',
      );
    } else if (webAuthStateRef.current.mode === 'localhost_no_auth') {
      log.info(
        {
          mode: webAuthStateRef.current.mode,
          host: config.channels.web.host ?? 'localhost',
          port: config.channels.web.port ?? 3000,
        },
        'Web dashboard: localhost access without auth token.',
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

  // Start runtime
  await runtime.start();

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

    if (mcpManager) {
      try {
        await mcpManager.disconnectAll();
      } catch (err) {
        log.error({ err }, 'Error disconnecting MCP servers');
      }
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
