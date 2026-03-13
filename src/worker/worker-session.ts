import type { UserMessage } from '../agent/types.js';
import type { ChatMessage, ChatOptions, ChatResponse } from '../llm/types.js';
import type { ToolDefinition, ToolExecutionRequest, ToolRunResponse } from '../tools/types.js';
import { formatPendingApprovalMessage, shouldUseStructuredPendingApprovalMessage } from '../runtime/pending-approval-copy.js';
import { runLlmLoop } from './worker-llm-loop.js';
import { BrokerClient } from '../broker/broker-client.js';
import { shouldAllowImplicitMemorySave } from '../util/memory-intent.js';
import { isToolReportQuery, formatToolReport } from '../util/tool-report.js';

const APPROVAL_CONFIRM_PATTERN = /^(?:\/)?(?:approve|approved|yes|yep|yeah|y|go ahead|do it|confirm|ok|okay|sure|proceed|accept)\b/i;
const APPROVAL_DENY_PATTERN = /^(?:\/)?(?:deny|denied|reject|decline|cancel|no|nope|nah|n)\b/i;
const APPROVAL_ID_TOKEN_PATTERN = /^(?=.*(?:-|\d))[a-z0-9-]{4,}$/i;
const PENDING_APPROVAL_TTL_MS = 30 * 60_000;

interface PendingApprovalState {
  ids: string[];
  expiresAt: number;
}

interface SuspendedToolCall {
  approvalId: string;
  toolCallId: string;
  jobId: string;
  name: string;
}

interface SuspendedSession {
  llmMessages: ChatMessage[];
  pendingTools: SuspendedToolCall[];
}

interface PendingApprovalMetadata {
  id: string;
  toolName: string;
  argsPreview: string;
}

export interface WorkerMessageHandleParams {
  message: UserMessage;
  systemPrompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  knowledgeBase: string;
  activeSkills: Array<{ id: string; name: string; summary: string }>;
  toolContext: string;
  runtimeNotices: Array<{ level: 'info' | 'warn'; message: string }>;
  /** Whether a fallback provider is available on the supervisor side for quality-based retry. */
  hasFallbackProvider?: boolean;
}

class BrokeredToolExecutor {
  private readonly client: BrokerClient;
  private readonly toolDefinitions = new Map<string, ToolDefinition>();
  private readonly approvalMetadata = new Map<string, PendingApprovalMetadata>();
  private readonly jobs: Array<{
    id: string;
    status: string;
    toolName: string;
    approvalId?: string;
    message?: string;
  }> = [];

  constructor(client: BrokerClient) {
    this.client = client;
    for (const definition of client.getAlwaysLoadedTools()) {
      this.toolDefinitions.set(definition.name, definition);
    }
  }

  isEnabled(): boolean {
    return true;
  }

  listAlwaysLoadedDefinitions(): ToolDefinition[] {
    return [...this.toolDefinitions.values()];
  }

  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.toolDefinitions.get(name);
  }

  getApprovalMetadata(ids: string[]): PendingApprovalMetadata[] {
    return ids
      .map((id) => this.approvalMetadata.get(id))
      .filter((value): value is PendingApprovalMetadata => !!value);
  }

  async executeModelTool(
    toolName: string,
    args: Record<string, unknown>,
    request: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  ): Promise<Record<string, unknown>> {
    const result = await this.client.callTool({
      ...request,
      toolName,
      args,
    });

    this.jobs.unshift({
      id: result.jobId,
      status: result.status,
      toolName,
      approvalId: result.approvalId,
      message: result.message,
    });

    if (toolName === 'find_tools' && isRecord(result.output) && Array.isArray(result.output.tools)) {
      for (const tool of result.output.tools) {
        if (isRecord(tool) && typeof tool.name === 'string') {
          this.toolDefinitions.set(tool.name, tool as unknown as ToolDefinition);
        }
      }
    }

    if (result.approvalId) {
      this.approvalMetadata.set(result.approvalId, {
        id: result.approvalId,
        toolName: result.approvalSummary?.toolName ?? toolName,
        argsPreview: result.approvalSummary?.argsPreview ?? JSON.stringify(args).slice(0, 160),
      });
    }

    return result as unknown as Record<string, unknown>;
  }
}

export class BrokeredWorkerSession {
  private readonly client: BrokerClient;
  private pendingApprovals: PendingApprovalState | null = null;
  private suspendedSession: SuspendedSession | null = null;

  constructor(client: BrokerClient) {
    this.client = client;
  }

  async handleMessage(params: WorkerMessageHandleParams): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const toolExecutor = new BrokeredToolExecutor(this.client);

    // LLM calls are proxied through the broker — the worker has no network access.
    const chatFn = (msgs: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> =>
      this.client.llmChat(msgs, opts);

    // Direct tool report: answer "what tools did you use?" from broker job list.
    // Don't filter by channel — brokered tool calls use channel 'broker' regardless of origin.
    if (isToolReportQuery(params.message.content)) {
      try {
        const jobs = await this.client.listJobs(params.message.userId, undefined, 50);
        if (jobs.length > 0) {
          const report = formatToolReport(jobs);
          if (report) {
            return { content: report };
          }
        }
      } catch {
        // Fall through to normal LLM path if job listing fails
      }
    }

    if (this.isContinuationMessage(params.message.content) && this.suspendedSession) {
      return this.resumeSuspendedSession(params.message, chatFn, toolExecutor, params);
    }

    const approvalResponse = await this.tryHandleApprovalMessage(params.message, chatFn, toolExecutor, params);
    if (approvalResponse) {
      return approvalResponse;
    }

    const enrichedSystemPrompt = buildWorkerSystemPrompt(params);
    const llmMessages: ChatMessage[] = [
      { role: 'system', content: enrichedSystemPrompt },
      ...params.history.map((entry) => ({ role: entry.role, content: entry.content })),
      { role: 'user', content: params.message.content },
    ];

    return this.executeLoop(params.message, llmMessages, chatFn, toolExecutor, params);
  }

  private async tryHandleApprovalMessage(
    message: UserMessage,
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>,
    toolExecutor: BrokeredToolExecutor,
    params: WorkerMessageHandleParams,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const pendingIds = this.getPendingApprovalIds();
    if (pendingIds.length === 0) return null;

    const trimmed = message.content.trim();
    const decision = APPROVAL_CONFIRM_PATTERN.test(trimmed)
      ? 'approved'
      : APPROVAL_DENY_PATTERN.test(trimmed)
        ? 'denied'
        : null;
    if (!decision) return null;

    const explicitIds = trimmed
      .split(/\s+/g)
      .map((token) => token.trim())
      .filter((token) => APPROVAL_ID_TOKEN_PATTERN.test(token));
    const targetIds = explicitIds.length > 0 ? explicitIds : pendingIds;

    const results: string[] = [];
    let approvedAny = false;
    for (const approvalId of targetIds) {
      const decided = await this.client.decideApproval(approvalId, decision, message.userId);
      results.push(decided.message);
      approvedAny ||= decided.success && decision === 'approved';
    }

    if (decision === 'approved' && approvedAny && this.suspendedSession) {
      return this.resumeSuspendedSession(message, chatFn, toolExecutor, params);
    }

    this.consumePendingApprovals(targetIds);
    return { content: results.join('\n') };
  }

  private async resumeSuspendedSession(
    message: UserMessage,
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>,
    toolExecutor: BrokeredToolExecutor,
    params: WorkerMessageHandleParams,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const suspended = this.suspendedSession;
    if (!suspended) {
      return { content: 'There is no suspended action to continue.' };
    }

    const resumedMessages = [...suspended.llmMessages];
    for (const pending of suspended.pendingTools) {
      const result = await this.client.getApprovalResult(pending.approvalId);
      const toolPayload = result.status === 'approved'
        ? { success: true, message: result.message ?? 'Executed successfully.' }
        : { success: false, error: result.message ?? 'Approval was denied.' };
      resumedMessages.push({
        role: 'tool',
        toolCallId: pending.toolCallId,
        content: JSON.stringify(toolPayload),
      });
    }
    resumedMessages.push({ role: 'user', content: message.content });

    this.suspendedSession = null;
    this.pendingApprovals = null;

    return this.executeLoop(message, resumedMessages, chatFn, toolExecutor, params);
  }

  private async executeLoop(
    message: UserMessage,
    llmMessages: ChatMessage[],
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>,
    toolExecutor: BrokeredToolExecutor,
    params: WorkerMessageHandleParams,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const pendingTools: SuspendedToolCall[] = [];

    // Fallback chat function: proxied through the broker with useFallback flag
    let fallbackChatFn: ((msgs: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>) | undefined;
    if (params.hasFallbackProvider) {
      fallbackChatFn = (msgs, opts) => this.client.llmChat(msgs, opts, { useFallback: true });
    }

    const allowImplicit = shouldAllowImplicitMemorySave(message.content);

    const result = await runLlmLoop(
      llmMessages,
      async (messages, options) => chatFn(messages, options),
      {
        listAlwaysLoaded: () => toolExecutor.listAlwaysLoadedDefinitions(),
        searchTools: () => [],
        callTool: async (request) => {
          const runResult = await toolExecutor.executeModelTool(request.toolName, request.args, request);
          return runResult as unknown as ToolRunResponse;
        },
      },
      6,
      80_000,
      (toolCall, toolResult) => {
        if (toolResult.status === 'pending_approval' && typeof toolResult.approvalId === 'string' && typeof toolResult.jobId === 'string') {
          pendingTools.push({
            approvalId: toolResult.approvalId,
            toolCallId: toolCall.id,
            jobId: toolResult.jobId,
            name: toolCall.name,
          });
        }
      },
      {
        allowImplicitMemorySave: allowImplicit,
        fallbackChatFn,
      },
    );

    if (pendingTools.length > 0) {
      const ids = pendingTools.map((pending) => pending.approvalId);
      this.pendingApprovals = {
        ids,
        expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
      };
      this.suspendedSession = {
        llmMessages: result.messages,
        pendingTools,
      };

      const pendingApprovalMeta = toolExecutor.getApprovalMetadata(ids);
      return {
        content: shouldUseStructuredPendingApprovalMessage(message.channel)
          ? formatPendingApprovalMessage(pendingApprovalMeta)
          : 'This action needs approval before I can continue.',
        metadata: pendingApprovalMeta.length > 0
          ? { pendingApprovals: pendingApprovalMeta }
          : undefined,
      };
    }

    this.pendingApprovals = null;
    this.suspendedSession = null;
    return { content: result.finalContent };
  }

  private getPendingApprovalIds(nowMs: number = Date.now()): string[] {
    if (!this.pendingApprovals) return [];
    if (this.pendingApprovals.expiresAt <= nowMs) {
      this.pendingApprovals = null;
      return [];
    }
    return [...this.pendingApprovals.ids];
  }

  private consumePendingApprovals(consumedIds: string[]): void {
    if (!this.pendingApprovals) return;
    const remaining = this.pendingApprovals.ids.filter((id) => !consumedIds.includes(id));
    if (remaining.length === 0) {
      this.pendingApprovals = null;
      return;
    }
    this.pendingApprovals = {
      ids: remaining,
      expiresAt: this.pendingApprovals.expiresAt,
    };
  }

  private isContinuationMessage(content: string): boolean {
    return content.includes('[User approved the pending tool action(s)') || content.includes('Tool actions have been decided');
  }
}

function buildWorkerSystemPrompt(params: WorkerMessageHandleParams): string {
  let prompt = params.systemPrompt;
  if (params.knowledgeBase) {
    prompt += `\n\n<knowledge-base>\n${params.knowledgeBase}\n</knowledge-base>`;
  }
  if (params.activeSkills.length > 0) {
    prompt += `\n\n<active-skills>\n${params.activeSkills.map((skill) => `Skill: ${skill.name} (${skill.id})\nSummary:\n${skill.summary}`).join('\n\n')}\n</active-skills>`;
  }
  if (params.toolContext) {
    prompt += `\n\n<tool-context>\n${params.toolContext}\n</tool-context>`;
  }
  if (params.runtimeNotices.length > 0) {
    prompt += `\n\n<tool-runtime-notices>\n${params.runtimeNotices.map((notice) => `- ${notice.message}`).join('\n')}\n</tool-runtime-notices>`;
  }
  return prompt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
