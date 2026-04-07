/**
 * Telegram channel adapter.
 *
 * Uses grammy bot framework. Supports polling mode.
 * Filters by allowed_chat_ids. Typing indicators.
 */

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import type { ChannelAdapter, MessageCallback } from './types.js';
import { createLogger } from '../util/logging.js';
import type { AnalyticsEventInput } from '../runtime/analytics.js';
import type { ThreatIntelSummary, ThreatIntelScanInput, ThreatIntelFinding, IntelStatus } from '../runtime/threat-intel.js';
import { describePendingApproval } from '../runtime/pending-approval-copy.js';
import { formatCompactResponseSourceLabel } from '../runtime/model-routing-ux.js';

const log = createLogger('channel:telegram');
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
const APPROVAL_CONFIRM_PATTERN = /^(?:\/)?(?:approve|approved|yes|yep|yeah|y|go ahead|do it|confirm|ok|okay|sure|proceed|accept)\b/i;
const APPROVAL_DENY_PATTERN = /^(?:\/)?(?:deny|denied|reject|decline|cancel|no|nope|nah|n)\b/i;
const APPROVAL_COMMAND_PATTERN = /^\/?(approve|deny)\b/i;
const APPROVAL_ID_TOKEN_PATTERN = /^(?=.*(?:-|\d))[a-z0-9-]{4,}$/i;
const APPROVAL_IN_PROGRESS_LINE = '⏳ Approval received. Continuing...';
const DENIAL_IN_PROGRESS_LINE = '⏳ Denial received. Processing...';

interface PendingTelegramApproval {
  id: string;
  toolName: string;
  argsPreview: string;
  actionLabel?: string;
}

interface PendingTelegramApprovalState {
  approvals: PendingTelegramApproval[];
  agentId: string;
}

function extractPendingActionApprovals(
  response: { content: string; metadata?: Record<string, unknown> },
): PendingTelegramApproval[] {
  const pendingAction = response.metadata?.pendingAction;
  if (!pendingAction || typeof pendingAction !== 'object') return [];
  const blocker = (pendingAction as { blocker?: unknown }).blocker;
  if (!blocker || typeof blocker !== 'object') return [];
  if ((blocker as { kind?: unknown }).kind !== 'approval') return [];
  const approvalSummaries = (blocker as { approvalSummaries?: unknown }).approvalSummaries;
  if (!Array.isArray(approvalSummaries)) return [];
  return approvalSummaries
    .filter((approval): approval is PendingTelegramApproval => {
      return !!approval
        && typeof approval === 'object'
        && typeof (approval as { id?: unknown }).id === 'string'
        && typeof (approval as { toolName?: unknown }).toolName === 'string';
    })
    .map((approval) => {
      const argsPreview = typeof approval.argsPreview === 'string' ? approval.argsPreview : '';
      const actionLabel = typeof approval.actionLabel === 'string' && approval.actionLabel.trim()
        ? approval.actionLabel
        : describePendingApproval({
            toolName: approval.toolName,
            argsPreview,
          });
      return {
        id: approval.id,
        toolName: approval.toolName,
        argsPreview,
        ...(actionLabel ? { actionLabel } : {}),
      };
    });
}

function normalizeApprovalStatusMessage(message: string, decision: 'approved' | 'denied'): string {
  const normalized = message.trim();
  if (!normalized) {
    return decision === 'approved' ? 'Approved and executed' : 'Denied';
  }

  if (/^tool '.*' completed\.$/i.test(normalized)) {
    return decision === 'approved' ? 'Approved and executed' : 'Denied';
  }

  if (/^denied approval /i.test(normalized)) {
    return 'Denied';
  }

  if (/^approval received .* execution failed:/i.test(normalized)) {
    return normalized.replace(/^approval received .* execution failed:\s*/i, '').trim() || 'Execution failed';
  }

  return normalized;
}

function appendApprovalStatusLine(messageText: string, statusLine: string): string {
  const normalized = messageText.trim();
  if (!normalized) return statusLine;
  const lines = normalized.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  if (lines.length > 1 && /^[⏳✅❌⚠️]\s/.test(lastLine)) {
    lines[lines.length - 1] = statusLine;
    return lines.join('\n');
  }
  return `${normalized}\n${statusLine}`;
}

export interface TelegramChannelOptions {
  /** Telegram bot token. */
  botToken: string;
  /** Allowed chat IDs (empty = allow all). */
  allowedChatIds?: number[];
  /** Default agent to route messages to. */
  defaultAgent?: string;
  /** Reference guide/help text shown for /guide and /help. */
  guideText?: string;
  /** Reset conversation callback for /reset command. */
  onResetConversation?: (args: {
    userId: string;
    agentId?: string;
  }) => Promise<{ success: boolean; message: string }> | { success: boolean; message: string };
  /** Resolve Telegram user/chat identity to canonical cross-channel user ID. */
  resolveCanonicalUserId?: (channelUserId: string) => string;
  /** Execute quick actions. */
  onQuickAction?: (args: {
    actionId: string;
    details: string;
    agentId: string;
    userId: string;
    channel: string;
  }) => Promise<{ content: string }>;
  /** Threat-intel summary callback for /intel status. */
  onThreatIntelSummary?: () => ThreatIntelSummary;
  /** Run threat-intel scan for /intel scan. */
  onThreatIntelScan?: (input: ThreatIntelScanInput) => {
    success: boolean;
    message: string;
    findings: ThreatIntelFinding[];
  } | Promise<{
    success: boolean;
    message: string;
    findings: ThreatIntelFinding[];
  }>;
  /** List threat-intel findings for /intel findings. */
  onThreatIntelFindings?: (args: { limit?: number; status?: IntelStatus }) => ThreatIntelFinding[];
  /** Analytics tracking callback. */
  onAnalyticsTrack?: (event: AnalyticsEventInput) => void;
  /** Tool approval decision callback — used for inline keyboard approve/deny buttons. */
  onToolsApprovalDecision?: (input: {
    approvalId: string;
    decision: 'approved' | 'denied';
    actor: string;
    reason?: string;
  }) => Promise<{
    success: boolean;
    message: string;
    continueConversation?: boolean;
    displayMessage?: string;
    continuedResponse?: { content: string; metadata?: Record<string, unknown> };
  }> | {
    success: boolean;
    message: string;
    continueConversation?: boolean;
    displayMessage?: string;
    continuedResponse?: { content: string; metadata?: Record<string, unknown> };
  };
  /** Dispatch a follow-up message to an agent (for auto-continuation after approval). */
  onDispatch?: (agentId: string, message: { content: string; userId?: string; channel?: string }) => Promise<{ content: string; metadata?: Record<string, unknown> }>;
}

export class TelegramChannel implements ChannelAdapter {
  readonly name = 'telegram';
  private bot: Bot;
  private onMessage: MessageCallback | null = null;
  private allowedChatIds: Set<number>;
  private defaultAgent: string;
  private guideText: string;
  private onResetConversation?: TelegramChannelOptions['onResetConversation'];
  private resolveCanonicalUserId?: TelegramChannelOptions['resolveCanonicalUserId'];
  private onQuickAction?: TelegramChannelOptions['onQuickAction'];
  private onThreatIntelSummary?: TelegramChannelOptions['onThreatIntelSummary'];
  private onThreatIntelScan?: TelegramChannelOptions['onThreatIntelScan'];
  private onThreatIntelFindings?: TelegramChannelOptions['onThreatIntelFindings'];
  private onAnalyticsTrack?: TelegramChannelOptions['onAnalyticsTrack'];
  private onToolsApprovalDecision?: TelegramChannelOptions['onToolsApprovalDecision'];
  private onDispatchMsg?: TelegramChannelOptions['onDispatch'];
  private readonly pendingApprovalsByChat = new Map<string, PendingTelegramApprovalState>();

  constructor(options: TelegramChannelOptions) {
    this.bot = new Bot(options.botToken);
    this.allowedChatIds = new Set(options.allowedChatIds ?? []);
    this.defaultAgent = options.defaultAgent ?? 'default';
    this.guideText = options.guideText ?? 'Reference guide is not configured.';
    this.onResetConversation = options.onResetConversation;
    this.resolveCanonicalUserId = options.resolveCanonicalUserId;
    this.onQuickAction = options.onQuickAction;
    this.onThreatIntelSummary = options.onThreatIntelSummary;
    this.onThreatIntelScan = options.onThreatIntelScan;
    this.onThreatIntelFindings = options.onThreatIntelFindings;
    this.onAnalyticsTrack = options.onAnalyticsTrack;
    this.onToolsApprovalDecision = options.onToolsApprovalDecision;
    this.onDispatchMsg = options.onDispatch;
  }

  async start(onMessage: MessageCallback): Promise<void> {
    this.onMessage = onMessage;

    this.bot.catch((err) => {
      const updateId = err.ctx?.update?.update_id;
      log.error({ err, updateId }, 'Telegram middleware error');
    });

    this.bot.on('message:text', async (ctx: Context) => {
      if (!ctx.message?.text || !ctx.chat) return;
      const text = ctx.message.text.trim();
      const lower = text.toLowerCase();
      const channelUserId = String(ctx.from?.id ?? ctx.chat.id);
      const canonicalUserId = this.resolveCanonicalUserId
        ? this.resolveCanonicalUserId(channelUserId)
        : channelUserId;
      const approvalKey = this.buildApprovalKey(ctx);

      // Filter by allowed chat IDs
      if (this.allowedChatIds.size > 0 && !this.allowedChatIds.has(ctx.chat.id)) {
        log.warn({ chatId: ctx.chat.id }, 'Message from unauthorized chat');
        this.trackAnalytics({
          type: 'message_denied',
          channel: 'telegram',
          canonicalUserId,
          channelUserId,
          metadata: { reason: 'unauthorized_chat' },
        });
        await this.replyInChunks(ctx, 'Unauthorized chat.');
        return;
      }

      if (text.startsWith('/')) {
        const command = text.split(/\s+/)[0]?.slice(1).toLowerCase() ?? 'unknown';
        this.trackAnalytics({
          type: 'command_used',
          channel: 'telegram',
          canonicalUserId,
          channelUserId,
          agentId: this.defaultAgent,
          metadata: { command },
        });
      }

      if (lower === '/start' || lower === '/help') {
        await this.replyInChunks(ctx, this.buildHelpText());
        return;
      }

      if (lower === '/guide') {
        await this.replyInChunks(ctx, this.guideText);
        return;
      }

      if (
        this.onToolsApprovalDecision
        && this.pendingApprovalsByChat.has(approvalKey)
        && this.isApprovalInput(text)
      ) {
        await this.handlePendingApprovalInput(ctx, text, approvalKey, channelUserId);
        return;
      }

      if (lower.startsWith('/intel')) {
        await this.handleIntelCommand(ctx, text);
        return;
      }

      if (lower.startsWith('/reset')) {
        if (!this.onResetConversation) {
          await this.replyInChunks(ctx, 'Conversation reset is not available.');
          return;
        }

        const parts = text.split(/\s+/);
        const agentId = parts[1] || this.defaultAgent;
        const result = await this.onResetConversation({
          userId: channelUserId,
          agentId,
        });
        await this.replyInChunks(ctx, result.message);
        return;
      }

      if (lower.startsWith('/quick')) {
        if (!this.onQuickAction) {
          await this.replyInChunks(ctx, 'Quick actions are not available.');
          return;
        }

        const parts = text.split(/\s+/);
        const actionId = parts[1]?.toLowerCase();
        const details = parts.slice(2).join(' ').trim();
        if (!actionId || !details) {
          await this.replyInChunks(ctx, 'Usage: /quick <action> <details>\nBuilt-in actions: email, task, calendar, security');
          return;
        }

        try {
          const response = await this.onQuickAction({
            actionId,
            details,
            agentId: this.defaultAgent,
            userId: channelUserId,
            channel: 'telegram',
          });
          await this.replyInChunks(ctx, response.content);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await this.replyInChunks(ctx, `Quick action failed: ${message}`);
        }
        return;
      }

      if (!this.onMessage) return;
      await this.dispatchAssistantMessage(ctx, text, canonicalUserId, channelUserId);
    });

    // Handle inline keyboard callback queries for tool approvals
    this.bot.on('callback_query:data', async (ctx) => {
      await this.handleInlineApprovalCallback(ctx);
    });

    // Validate token before starting polling
    try {
      await this.bot.api.getMe();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Telegram bot token is invalid or revoked — skipping startup');
      throw new Error(`Telegram bot token validation failed: ${message}`);
    }

    // Start polling (fire-and-forget with error handling)
    this.bot.start({
      onStart: () => {
        log.info('Telegram bot started (polling)');
      },
    }).catch(err => {
      log.error({ err }, 'Telegram polling error');
    });
  }

  async stop(): Promise<void> {
    this.bot.stop();
    this.onMessage = null;
    log.info('Telegram bot stopped');
  }

  async send(userId: string, text: string): Promise<void> {
    const chatId = Number(userId);
    if (isNaN(chatId)) {
      log.error({ userId }, 'Invalid Telegram chat ID');
      return;
    }
    for (const chunk of splitTelegramMessage(text, TELEGRAM_MAX_MESSAGE_CHARS)) {
      await this.bot.api.sendMessage(chatId, chunk);
    }
  }

  private async handleIntelCommand(ctx: Context, text: string): Promise<void> {
    if (!this.onThreatIntelSummary) {
      await this.replyInChunks(ctx, 'Threat intel is not available.');
      return;
    }

    const parts = text.trim().split(/\s+/);
    const sub = (parts[1] ?? 'status').toLowerCase();

    if (sub === 'status') {
      const summary = this.onThreatIntelSummary();
      const lines = [
        'Threat Intel',
        `Monitoring: ${summary.enabled ? 'enabled' : 'disabled'}`,
        `Mode: ${summary.responseMode}`,
        `Watchlist: ${summary.watchlistCount}`,
        `Darkweb: ${summary.darkwebEnabled ? 'enabled' : 'disabled'}`,
        `Findings: ${summary.findings.total} total, ${summary.findings.new} new, ${summary.findings.highOrCritical} high/critical`,
      ];
      if (summary.lastScanAt) {
        lines.push(`Last scan: ${new Date(summary.lastScanAt).toLocaleString()}`);
      }
      await this.replyInChunks(ctx, lines.join('\n'));
      return;
    }

    if (sub === 'scan') {
      if (!this.onThreatIntelScan) {
        await this.replyInChunks(ctx, 'Threat intel scan is not available.');
        return;
      }
      const includeDarkWeb = parts.includes('--darkweb');
      const query = parts
        .slice(2)
        .filter((part) => part !== '--darkweb')
        .join(' ')
        .trim();
      const result = await this.onThreatIntelScan({
        query: query || undefined,
        includeDarkWeb,
      });
      const preview = result.findings.slice(0, 4)
        .map((finding) => `- ${finding.severity} ${finding.sourceType}: ${finding.target}`)
        .join('\n');
      await this.replyInChunks(
        ctx,
        `${result.message}${preview ? `\n\n${preview}` : ''}`,
      );
      return;
    }

    if (sub === 'findings') {
      if (!this.onThreatIntelFindings) {
        await this.replyInChunks(ctx, 'Threat intel findings are not available.');
        return;
      }
      const findings = this.onThreatIntelFindings({ limit: 5, status: 'new' });
      if (findings.length === 0) {
        await this.replyInChunks(ctx, 'No new findings.');
        return;
      }
      const lines = ['Top findings:'];
      for (const finding of findings) {
        lines.push(`- ${finding.id.slice(0, 8)} ${finding.severity} ${finding.sourceType} ${finding.target}`);
      }
      await this.replyInChunks(ctx, lines.join('\n'));
      return;
    }

    await this.replyInChunks(
      ctx,
      'Usage: /intel [status|scan|findings]\nExamples:\n/intel status\n/intel scan your-name --darkweb\n/intel findings',
    );
  }

  private buildHelpText(): string {
    return [
      'Guardian Agent Telegram',
      '',
      `Default agent: ${this.defaultAgent}`,
      '',
      'Commands:',
      '/help - Show this help',
      '/guide - Open reference guide',
      '/reset [agentId] - Reset conversation memory',
      '/quick <action> <details> - Run quick action (email, task, calendar, security)',
      '/approve [approvalId ...] - Approve pending tool action(s)',
      '/deny [approvalId ...] - Deny pending tool action(s)',
      '/intel [status|scan|findings] - Threat intel status + quick scan',
      '',
      'Or just send a normal message to chat with the assistant.',
    ].join('\n');
  }

  private async dispatchAssistantMessage(
    ctx: Context,
    text: string,
    canonicalUserId: string,
    channelUserId: string,
  ): Promise<void> {
    if (!this.onMessage) return;
    await ctx.replyWithChatAction('typing');

    try {
      this.trackAnalytics({
        type: 'message_sent',
        channel: 'telegram',
        canonicalUserId,
        channelUserId,
        agentId: this.defaultAgent,
      });
      const response = await this.onMessage({
        id: randomUUID(),
        userId: channelUserId,
        channel: 'telegram',
        content: text,
        timestamp: Date.now(),
      });

      this.trackAnalytics({
        type: 'message_success',
        channel: 'telegram',
        canonicalUserId,
        channelUserId,
        agentId: this.defaultAgent,
      });
      await this.replyWithApprovalSupport(ctx, response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.trackAnalytics({
        type: 'message_error',
        channel: 'telegram',
        canonicalUserId,
        channelUserId,
        agentId: this.defaultAgent,
        metadata: { error: msg },
      });
      log.error({ chatId: ctx.chat?.id, err: msg }, 'Error handling Telegram message');
      await this.replyInChunks(ctx, 'Sorry, an error occurred processing your message.');
    }
  }

  /**
   * Reply with the response text, and if pending approvals are present,
   * append an inline keyboard with Approve / Deny buttons.
   */
  private async replyWithApprovalSupport(
    ctx: Context,
    response: { content: string; metadata?: Record<string, unknown> },
    agentId: string = this.defaultAgent,
  ): Promise<void> {
    const approvals = extractPendingActionApprovals(response);
    const approvalKey = this.buildApprovalKey(ctx);

    const sourceLabel = formatCompactResponseSourceLabel(response.metadata);
    const contentWithSource = sourceLabel ? `${sourceLabel} ${response.content}` : response.content;

    if (!approvals.length || !this.onToolsApprovalDecision) {
      this.pendingApprovalsByChat.delete(approvalKey);
      await this.replyInChunks(ctx, contentWithSource);
      return;
    }

    this.pendingApprovalsByChat.set(approvalKey, {
      approvals: approvals.map((approval) => ({
        id: approval.id,
        toolName: approval.toolName,
        argsPreview: approval.argsPreview,
        ...(approval.actionLabel ? { actionLabel: approval.actionLabel } : {}),
      })),
      agentId,
    });

    await this.replyInChunks(ctx, contentWithSource);

    // Build an inline keyboard with approve/deny per approval
    // For simplicity, use a single approve-all / deny-all row when there's one approval,
    // or per-item buttons for multiple.
    if (approvals.length === 1) {
      const a = approvals[0];
      const preview = a.actionLabel || a.argsPreview;
      const keyboard = new InlineKeyboard()
        .text('✅ Approve', `approve:${a.id}`)
        .text('❌ Deny', `deny:${a.id}`);
      await ctx.reply(`⚠️ ${preview || a.toolName}`, { reply_markup: keyboard });
    } else {
      // Multiple approvals: show each with its own buttons
      for (const a of approvals) {
        const preview = a.actionLabel || a.argsPreview;
        const keyboard = new InlineKeyboard()
          .text('✅ Approve', `approve:${a.id}`)
          .text('❌ Deny', `deny:${a.id}`);
        await ctx.reply(`⚠️ ${preview || a.toolName}`, { reply_markup: keyboard });
      }
    }
  }

  private buildApprovalKey(ctx: Context): string {
    const chatId = String(ctx.chat?.id ?? 'unknown-chat');
    const userId = String(ctx.from?.id ?? ctx.chat?.id ?? 'unknown-user');
    return `${chatId}:${userId}`;
  }

  private isApprovalInput(text: string): boolean {
    return APPROVAL_CONFIRM_PATTERN.test(text.trim()) || APPROVAL_DENY_PATTERN.test(text.trim());
  }

  private async handlePendingApprovalInput(
    ctx: Context,
    text: string,
    approvalKey: string,
    userId: string,
  ): Promise<void> {
    const state = this.pendingApprovalsByChat.get(approvalKey);
    if (!state || !this.onToolsApprovalDecision) {
      await this.replyInChunks(ctx, 'There are no pending approvals.');
      return;
    }

    const input = text.trim();
    const decision: 'approved' | 'denied' = APPROVAL_DENY_PATTERN.test(input) ? 'denied' : 'approved';
    const selected = this.resolveApprovalTargets(input, state.approvals);

    if (selected.errors.length > 0) {
      await this.replyInChunks(ctx, selected.errors.join('\n'));
      return;
    }

    const approvalIds = selected.approvals.length > 0
      ? selected.approvals.map((approval) => approval.id)
      : state.approvals.map((approval) => approval.id);

    await ctx.replyWithChatAction('typing');
    const result = await this.handleApprovalDecisions(ctx, {
      approvalKey,
      actor: `telegram:${ctx.from?.id ?? userId}`,
      decision,
      approvalIds,
      userId,
    });

    if (decision === 'denied' || !result.continued) {
      await this.replyInChunks(ctx, result.statusLines.join('\n'));
    }
  }

  private resolveApprovalTargets(
    input: string,
    approvals: PendingTelegramApproval[],
  ): { approvals: PendingTelegramApproval[]; errors: string[] } {
    if (!APPROVAL_COMMAND_PATTERN.test(input)) {
      return { approvals, errors: [] };
    }

    const argsText = input.replace(APPROVAL_COMMAND_PATTERN, '').trim();
    if (!argsText) return { approvals, errors: [] };

    const rawTokens = argsText
      .split(/[,\s]+/)
      .map((token) => token.trim().replace(/^\[+|\]+$/g, ''))
      .filter(Boolean)
      .filter((token) => APPROVAL_ID_TOKEN_PATTERN.test(token));
    if (rawTokens.length === 0) return { approvals, errors: [] };

    const selected = new Map<string, PendingTelegramApproval>();
    const errors: string[] = [];
    for (const token of rawTokens) {
      const exact = approvals.find((approval) => approval.id === token);
      if (exact) {
        selected.set(exact.id, exact);
        continue;
      }
      const matches = approvals.filter((approval) => approval.id.startsWith(token));
      if (matches.length === 1) {
        selected.set(matches[0].id, matches[0]);
      } else if (matches.length > 1) {
        errors.push(`Approval ID prefix '${token}' is ambiguous.`);
      } else {
        errors.push(`Approval ID '${token}' was not found for this chat.`);
      }
    }

    return { approvals: [...selected.values()], errors };
  }

  private async handleApprovalDecisions(
    ctx: Context,
    input: {
      approvalKey: string;
      actor: string;
      decision: 'approved' | 'denied';
      approvalIds: string[];
      userId: string;
    },
  ): Promise<{ statusLines: string[]; callbackText?: string; continued: boolean }> {
    if (!this.onToolsApprovalDecision) {
      return { statusLines: ['Approval handler not available.'], callbackText: 'Approval handler not available.', continued: false };
    }

    const state = this.pendingApprovalsByChat.get(input.approvalKey);
    const approvalLookup = new Map((state?.approvals ?? []).map((approval) => [approval.id, approval] as const));
    const results: Array<{
      approvalId: string;
      toolName: string;
      success: boolean;
      message: string;
      continueConversation?: boolean;
      continuedResponse?: { content: string; metadata?: Record<string, unknown> };
    }> = [];
    let allSucceeded = true;

    for (const approvalId of input.approvalIds) {
      const approval = approvalLookup.get(approvalId);
      const toolName = approval?.toolName ?? 'tool';
      try {
        const result = await this.onToolsApprovalDecision({
          approvalId,
          decision: input.decision,
          actor: input.actor,
        });
        const message = normalizeApprovalStatusMessage(result.displayMessage || result.message || '', input.decision);
        if (!result.success) allSucceeded = false;
        results.push({
          approvalId,
          toolName,
          success: result.success,
          message,
          continueConversation: result.continueConversation,
          continuedResponse: result.continuedResponse,
        });
      } catch (err) {
        allSucceeded = false;
        results.push({
          approvalId,
          toolName,
          success: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (state) {
      const remaining = state.approvals.filter((approval) => !input.approvalIds.includes(approval.id));
      if (remaining.length > 0) {
        this.pendingApprovalsByChat.set(input.approvalKey, { approvals: remaining, agentId: state.agentId });
      } else {
        this.pendingApprovalsByChat.delete(input.approvalKey);
      }
    }

    const statusLines = results.map((result) => {
      if (input.decision === 'approved') {
        return result.success
          ? `✅ ${result.toolName}: ${result.message}`
          : `⚠️ ${result.toolName}: ${result.message}`;
      }
      return result.success
        ? `❌ ${result.toolName}: ${result.message}`
        : `⚠️ ${result.toolName}: ${result.message}`;
    });

    const directContinuation = input.decision === 'approved'
      ? results.find((result) => result.continuedResponse)?.continuedResponse
      : undefined;
    if (directContinuation) {
      await this.replyWithApprovalSupport(ctx, directContinuation, state?.agentId ?? this.defaultAgent);
      return {
        statusLines,
        callbackText: results[0]?.message,
        continued: true,
      };
    }

    const hasExplicitContinuationDirective = results.some((result) => result.continuedResponse || result.continueConversation !== undefined);
    const needsSyntheticContinuation = input.decision === 'approved'
      && this.onDispatchMsg
      && (
        results.some((result) => result.continueConversation)
        || (!hasExplicitContinuationDirective && allSucceeded)
      );
    if (needsSyntheticContinuation && this.onDispatchMsg) {
      const agentId = state?.agentId ?? this.defaultAgent;
      const summary = results.map((result) => `${result.toolName}: ${result.message}`).join('; ');
      try {
        const continuation = await this.onDispatchMsg(agentId, {
          content: `[User approved the pending tool action(s). Result: ${summary}] ${allSucceeded ? 'Please continue with the current request only. Do not resume older unrelated pending tasks.' : 'Some actions failed — adjust your approach accordingly. Focus only on the current request.'}`,
          userId: input.userId,
          channel: 'telegram',
        });
        await this.replyWithApprovalSupport(ctx, continuation, agentId);
        return {
          statusLines,
          callbackText: results[0]?.message,
          continued: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'Telegram approval continuation failed');
        return {
          statusLines: [...statusLines, 'Sorry, an error occurred continuing after approval.'],
          callbackText: 'Continuation failed.',
          continued: false,
        };
      }
    }

    return {
      statusLines,
      callbackText: results[0]?.message,
      continued: false,
    };
  }

  private trackAnalytics(event: AnalyticsEventInput): void {
    try {
      this.onAnalyticsTrack?.(event);
    } catch {
      // ignore
    }
  }

  private async replyInChunks(ctx: Context, text: string): Promise<void> {
    for (const chunk of splitTelegramMessage(text, TELEGRAM_MAX_MESSAGE_CHARS)) {
      await ctx.reply(chunk);
    }
  }

  private getCallbackMessageText(ctx: Context): string {
    return (ctx.callbackQuery?.message && 'text' in ctx.callbackQuery.message)
      ? (ctx.callbackQuery.message.text ?? '')
      : '';
  }

  private async tryEditApprovalMessage(ctx: Context, messageText: string): Promise<void> {
    if (!messageText.trim()) return;
    try {
      await ctx.editMessageText(messageText);
    } catch {
      // Message may have been deleted, already updated, or be otherwise unavailable.
    }
  }

  private async handleInlineApprovalCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? '';
    if (!data.startsWith('approve:') && !data.startsWith('deny:')) {
      await ctx.answerCallbackQuery();
      return;
    }

    const [action, ...idParts] = data.split(':');
    const approvalId = idParts.join(':');
    const decision = action === 'approve' ? 'approved' as const : 'denied' as const;
    const approvalKey = this.buildApprovalKey(ctx);

    if (!this.onToolsApprovalDecision) {
      await ctx.answerCallbackQuery({ text: 'Approval handler not available.' });
      return;
    }

    const inProgressLine = decision === 'approved' ? APPROVAL_IN_PROGRESS_LINE : DENIAL_IN_PROGRESS_LINE;
    let messageText = this.getCallbackMessageText(ctx);

    try {
      await ctx.answerCallbackQuery({ text: inProgressLine.slice(0, 200) });
      messageText = appendApprovalStatusLine(messageText, inProgressLine);
      await this.tryEditApprovalMessage(ctx, messageText);

      const result = await this.handleApprovalDecisions(ctx, {
        approvalKey,
        actor: `telegram:${ctx.from?.id ?? 'unknown-user'}`,
        decision,
        approvalIds: [approvalId],
        userId: String(ctx.from?.id ?? ctx.chat?.id ?? ''),
      });

      const finalLine = result.statusLines[0] ?? (decision === 'approved' ? '✅ Approved and executed' : '❌ Denied');
      messageText = appendApprovalStatusLine(messageText, finalLine);
      await this.tryEditApprovalMessage(ctx, messageText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      messageText = appendApprovalStatusLine(messageText, `⚠️ Approval handling failed: ${msg}`);
      await this.tryEditApprovalMessage(ctx, messageText);
    }
  }
}

export function splitTelegramMessage(
  text: string,
  maxChars = TELEGRAM_MAX_MESSAGE_CHARS,
): string[] {
  if (maxChars <= 0) return [text];
  const input = text ?? '';
  if (input.length <= maxChars) return [input];

  const chunks: string[] = [];
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  let current = '';

  const flushCurrent = (): void => {
    if (!current) return;
    chunks.push(current);
    current = '';
  };

  const appendLine = (line: string): void => {
    if (!current) {
      current = line;
      return;
    }
    const next = `${current}\n${line}`;
    if (next.length <= maxChars) {
      current = next;
      return;
    }
    flushCurrent();
    current = line;
  };

  const splitLongSegment = (segment: string): string[] => {
    const out: string[] = [];
    let rest = segment;
    while (rest.length > maxChars) {
      let breakAt = rest.lastIndexOf(' ', maxChars);
      if (breakAt < Math.floor(maxChars * 0.5)) {
        breakAt = maxChars;
      }
      const head = rest.slice(0, breakAt).trimEnd();
      out.push(head || rest.slice(0, maxChars));
      rest = rest.slice(breakAt).trimStart();
    }
    if (rest.length > 0) out.push(rest);
    return out;
  };

  for (const rawLine of lines) {
    if (rawLine.length <= maxChars) {
      appendLine(rawLine);
      continue;
    }
    flushCurrent();
    for (const part of splitLongSegment(rawLine)) {
      if (part.length <= maxChars) {
        appendLine(part);
      } else {
        // Safety fallback: force hard split if required.
        for (let i = 0; i < part.length; i += maxChars) {
          appendLine(part.slice(i, i + maxChars));
          flushCurrent();
        }
      }
      if (current.length === maxChars) {
        flushCurrent();
      }
    }
  }

  flushCurrent();
  return chunks.length > 0 ? chunks : [''];
}
