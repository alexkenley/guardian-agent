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

const log = createLogger('channel:telegram');
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

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
  }) => Promise<{ success: boolean; message: string }> | { success: boolean; message: string };
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

      if (lower.startsWith('/approve') || lower.startsWith('/deny')) {
        if (!this.onMessage) {
          await this.replyInChunks(ctx, 'Assistant messaging is not available.');
          return;
        }
        await this.dispatchAssistantMessage(ctx, text, canonicalUserId, channelUserId);
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
          await this.replyInChunks(ctx, 'Usage: /quick <email|task|calendar> <details>');
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
      const data = ctx.callbackQuery.data;
      if (!data.startsWith('approve:') && !data.startsWith('deny:')) {
        await ctx.answerCallbackQuery();
        return;
      }

      const [action, ...idParts] = data.split(':');
      const approvalId = idParts.join(':');
      const decision = action === 'approve' ? 'approved' as const : 'denied' as const;

      if (!this.onToolsApprovalDecision) {
        await ctx.answerCallbackQuery({ text: 'Approval handler not available.' });
        return;
      }

      try {
        const result = await this.onToolsApprovalDecision({
          approvalId,
          decision,
          actor: `telegram:${ctx.from.id}`,
        });

        // Update the button message to show the decision result
        const statusText = decision === 'approved'
          ? (result.success ? '✅ Approved and executed' : `⚠️ Approved but failed: ${result.message || 'unknown error'}`)
          : '❌ Denied';
        await ctx.answerCallbackQuery({ text: (result.message || statusText).slice(0, 200) });

        // Replace the inline keyboard with the decision status
        try {
          const originalText = (ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message)
            ? ctx.callbackQuery.message.text ?? ''
            : '';
          await ctx.editMessageText(`${originalText}\n${statusText}`);
        } catch {
          // Message may have been deleted or keyboard already removed
        }

        // On approval, auto-continue so the LLM completes the original task.
        // Include the result so the LLM knows if the action succeeded or failed.
        if (decision === 'approved' && this.onDispatchMsg) {
          await ctx.replyWithChatAction('typing');
          const resultContext = result.success
            ? 'Action executed successfully.'
            : `Action failed: ${result.message || 'unknown error'}. Adjust your approach.`;
          try {
            const continuation = await this.onDispatchMsg(this.defaultAgent, {
              content: `[User approved the pending tool action. ${resultContext}] Please continue with the original task.`,
              userId: String(ctx.from.id),
              channel: 'telegram',
            });
            await this.replyWithApprovalSupport(ctx, continuation);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err: msg }, 'Telegram approval continuation failed');
            await ctx.reply('Sorry, an error occurred continuing after approval.');
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.answerCallbackQuery({ text: `Error: ${msg}` });
      }
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
      '/quick <action> <details> - Run quick action (email/task/calendar)',
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
  ): Promise<void> {
    const approvals = response.metadata?.pendingApprovals as
      | Array<{ id: string; toolName: string; argsPreview: string }>
      | undefined;

    if (!approvals?.length || !this.onToolsApprovalDecision) {
      await this.replyInChunks(ctx, response.content);
      return;
    }

    // Send the main content first
    await this.replyInChunks(ctx, response.content);

    // Build an inline keyboard with approve/deny per approval
    // For simplicity, use a single approve-all / deny-all row when there's one approval,
    // or per-item buttons for multiple.
    if (approvals.length === 1) {
      const a = approvals[0];
      const preview = a.argsPreview ? ` — ${a.argsPreview}` : '';
      const keyboard = new InlineKeyboard()
        .text('✅ Approve', `approve:${a.id}`)
        .text('❌ Deny', `deny:${a.id}`);
      await ctx.reply(`⚠️ ${a.toolName}${preview}`, { reply_markup: keyboard });
    } else {
      // Multiple approvals: show each with its own buttons
      for (const a of approvals) {
        const preview = a.argsPreview ? ` — ${a.argsPreview}` : '';
        const keyboard = new InlineKeyboard()
          .text('✅ Approve', `approve:${a.id}`)
          .text('❌ Deny', `deny:${a.id}`);
        await ctx.reply(`⚠️ ${a.toolName}${preview}`, { reply_markup: keyboard });
      }
    }
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
