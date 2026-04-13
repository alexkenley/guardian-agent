import type { UserMessage } from '../agent/types.js';
import type { ChatMessage, ChatOptions, ChatResponse } from '../llm/types.js';
import type { ContentTrustLevel, ToolDefinition, ToolExecutionRequest, ToolRunResponse } from '../tools/types.js';
import {
  formatPendingApprovalMessage,
  isPhantomPendingApprovalMessage,
} from '../runtime/pending-approval-copy.js';
import {
  buildLocalModelTooComplicatedMessage,
  isLocalToolCallParseError,
  shouldBypassLocalModelComplexityGuard,
  type ResponseSourceMetadata,
} from '../runtime/model-routing-ux.js';
import { tryAutomationPreRoute } from '../runtime/automation-prerouter.js';
import { tryAutomationControlPreRoute } from '../runtime/automation-control-prerouter.js';
import { tryAutomationOutputPreRoute } from '../runtime/automation-output-prerouter.js';
import { tryBrowserPreRoute } from '../runtime/browser-prerouter.js';
import {
  resolveDirectIntentRoutingCandidates,
} from '../runtime/direct-intent-routing.js';
import {
  IntentGateway,
  readPreRoutedIntentGatewayMetadata,
  shouldReusePreRoutedIntentGateway,
  toIntentGatewayClientMetadata,
  type IntentGatewayDecision,
  type IntentGatewayRecord,
} from '../runtime/intent-gateway.js';
import {
  buildChatMessagesFromHistory,
  buildSystemPromptWithContext,
  type PromptAssemblyAdditionalSection,
  type PromptAssemblyContinuity,
  type PromptAssemblyKnowledgeBase,
  type PromptAssemblyPendingAction,
} from '../runtime/context-assembly.js';
import {
  readSelectedExecutionProfileMetadata,
  type SelectedExecutionProfile,
} from '../runtime/execution-profiles.js';
import {
  buildRoutedIntentAdditionalSection,
  prepareToolExecutionForIntent,
} from '../runtime/routed-tool-execution.js';
import { readApprovalOutcomeContinuationMetadata } from '../runtime/approval-continuations.js';
import { runLlmLoop } from './worker-llm-loop.js';
import { BrokerClient } from '../broker/broker-client.js';
import { buildToolResultPayloadFromJob } from '../tools/job-results.js';
import { shouldAllowModelMemoryMutation } from '../util/memory-intent.js';
import { isToolReportQuery, formatToolReport } from '../util/tool-report.js';
import {
  formatToolResultForLLM,
  stripLeadingContextPrefix,
  toLLMToolDef,
} from '../chat-agent-helpers.js';
import type { ExecutionPlan, PlanNode } from '../runtime/planner/types.js';
import type { PlanExecutionOutcome, PlanExecutionPauseControl } from '../runtime/planner/orchestrator.js';

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

interface SuspendedToolLoopSession {
  kind: 'tool_loop';
  llmMessages: ChatMessage[];
  pendingTools: SuspendedToolCall[];
  executionProfile?: SelectedExecutionProfile;
}

interface SuspendedPlannerNode {
  nodeId: string;
  approvalId: string;
  jobId: string;
  toolName: string;
}

interface PlannerTrustSnapshot {
  contentTrustLevel: ContentTrustLevel;
  taintReasons: string[];
}

interface SuspendedPlannerSession {
  kind: 'planner';
  plan: ExecutionPlan;
  pendingNodes: SuspendedPlannerNode[];
  originalMessage: UserMessage;
  trustState: PlannerTrustSnapshot;
  executionProfile?: SelectedExecutionProfile;
}

type SuspendedSession = SuspendedToolLoopSession | SuspendedPlannerSession;

interface PendingApprovalMetadata {
  id: string;
  toolName: string;
  argsPreview: string;
  actionLabel?: string;
}

interface AutomationApprovalContinuation {
  originalMessage: UserMessage;
  pendingApprovalIds: string[];
  expiresAt: number;
}

type BrokeredChatResponse = ChatResponse & {
  providerName?: string;
  providerLocality?: 'local' | 'external';
};

function buildWorkerPromptAdditionalSections(
  baseSections: PromptAssemblyAdditionalSection[] | undefined,
  intentDecision?: IntentGatewayDecision | null,
): PromptAssemblyAdditionalSection[] | undefined {
  const sections = [...(baseSections ?? [])];
  const routedIntentSection = buildRoutedIntentAdditionalSection(intentDecision);
  if (routedIntentSection && !sections.some((section) => section.section === routedIntentSection.section)) {
    sections.push(routedIntentSection);
  }
  return sections.length > 0 ? sections : undefined;
}

export interface WorkerMessageHandleParams {
  message: UserMessage;
  systemPrompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  knowledgeBases: PromptAssemblyKnowledgeBase[];
  activeSkills: Array<{ id: string; name: string; summary: string; description?: string; role?: string; sourcePath?: string }>;
  additionalSections?: PromptAssemblyAdditionalSection[];
  toolContext: string;
  runtimeNotices: Array<{ level: 'info' | 'warn'; message: string }>;
  executionProfile?: SelectedExecutionProfile;
  continuity?: PromptAssemblyContinuity | null;
  pendingAction?: PromptAssemblyPendingAction | null;
  pendingApprovalNotice?: string;
  /** Whether a fallback provider is available on the supervisor side for quality-based retry. */
  hasFallbackProvider?: boolean;
}

function buildApprovalPendingActionMetadata(
  approvals: PendingApprovalMetadata[],
  responseSource?: ResponseSourceMetadata,
): Record<string, unknown> {
  return {
    pendingAction: {
      status: 'pending',
      blocker: {
        kind: 'approval',
        prompt: formatPendingApprovalMessage(approvals),
        approvalSummaries: approvals.map((approval) => ({ ...approval })),
      },
    },
    continueConversationAfterApproval: true,
    ...(responseSource ? { responseSource } : {}),
  };
}

function createPlannerPauseControl(result: unknown): PlanExecutionPauseControl {
  return {
    kind: 'pause_execution',
    reason: 'pending_approval',
    result,
  };
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

  listAlwaysLoadedForLlm(locality: 'local' | 'external' = 'external'): import('../llm/types.js').ToolDefinition[] {
    return this.listAlwaysLoadedDefinitions().map((definition) => toLLMToolDef(definition, locality));
  }

  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.toolDefinitions.get(name);
  }

  getApprovalMetadata(ids: string[]): PendingApprovalMetadata[] {
    return ids
      .map((id) => this.approvalMetadata.get(id))
      .filter((value): value is PendingApprovalMetadata => !!value);
  }

  async searchTools(query: string): Promise<ToolDefinition[]> {
    const results = await this.client.searchTools(query);
    for (const definition of results) {
      this.toolDefinitions.set(definition.name, definition);
    }
    return results;
  }

  formatToolResultForLlm(toolName: string, result: unknown): string {
    return formatToolResultForLLM(toolName, result, []);
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
        ...(typeof result.approvalSummary?.actionLabel === 'string'
          ? { actionLabel: result.approvalSummary.actionLabel }
          : {}),
      });
    }

    return result as unknown as Record<string, unknown>;
  }
}

export class BrokeredWorkerSession {
  private readonly client: BrokerClient;
  private readonly intentGateway = new IntentGateway();
  private pendingApprovals: PendingApprovalState | null = null;
  private suspendedSession: SuspendedSession | null = null;
  private automationContinuation: AutomationApprovalContinuation | null = null;

  constructor(client: BrokerClient) {
    this.client = client;
  }

  async handleMessage(params: WorkerMessageHandleParams): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const codeContext = params.message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
    if (codeContext?.workspaceRoot) {
      await this.client.listLoadedTools({ codeContext });
    }
    const toolExecutor = new BrokeredToolExecutor(this.client);
    const selectedExecutionProfile = params.executionProfile
      ?? readSelectedExecutionProfileMetadata(params.message.metadata);

    // LLM calls are proxied through the broker — the worker has no network access.
    const buildChatFn = (
      executionProfile: SelectedExecutionProfile | null | undefined,
    ) => (msgs: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> => this.client.llmChat(
      msgs,
      opts,
      executionProfile
        ? {
            providerName: executionProfile.providerName,
            fallbackProviderOrder: executionProfile.fallbackProviderOrder,
          }
        : undefined,
    );
    const chatFn = buildChatFn(selectedExecutionProfile);

    if (this.isContinuationMessage(params.message.content) && this.suspendedSession) {
      return this.resumeSuspendedSessionAfterApproval(
        buildChatFn(this.suspendedSession.executionProfile ?? selectedExecutionProfile),
        toolExecutor,
        params,
      );
    }

    const approvalContinuation = readApprovalOutcomeContinuationMetadata(params.message.metadata);
    if (approvalContinuation && this.suspendedSession) {
      return this.resumeSuspendedSessionAfterApproval(
        buildChatFn(this.suspendedSession.executionProfile ?? selectedExecutionProfile),
        toolExecutor,
        params,
      );
    }

    const approvalResponse = await this.tryHandleApprovalMessage(params.message, chatFn, toolExecutor, params);
    if (approvalResponse) {
      return approvalResponse;
    }

    const directIntent = await this.classifyIntentGateway(params.message, chatFn);
    const directRouting = resolveDirectIntentRoutingCandidates(
      directIntent,
      ['automation', 'automation_control', 'automation_output', 'browser'],
    );
    if (directIntent?.decision.route === 'complex_planning_task') {
      const plannerResult = await this.tryTaskPlannerDirectly(
        params.message,
        chatFn,
        toolExecutor,
        directIntent.decision,
        selectedExecutionProfile,
      );
      if (plannerResult) {
        return this.attachIntentGatewayMetadata(plannerResult, directIntent);
      }
    }

    if ((directIntent?.decision.route === 'general_assistant' || directIntent?.decision.route === 'unknown')
      && isToolReportQuery(params.message.content)) {
      try {
        const jobs = await this.client.listJobs(params.message.userId, undefined, 50);
        if (jobs.length > 0) {
          const report = formatToolReport(jobs);
          if (report) {
            return this.attachIntentGatewayMetadata({ content: report }, directIntent);
          }
        }
      } catch {
        // Fall through to the normal LLM path if broker job listing fails.
      }
    }
    for (const candidate of directRouting.candidates) {
      switch (candidate) {
        case 'automation': {
          const directAutomationAuthoring = await this.tryDirectAutomationAuthoring(params.message, toolExecutor, {
            intentDecision: directIntent?.decision,
            assumeAuthoring: directRouting.gatewayDirected,
          });
          if (!directAutomationAuthoring) break;
          return this.attachIntentGatewayMetadata(directAutomationAuthoring, directIntent);
        }
        case 'automation_control': {
          const directAutomationControl = await this.tryDirectAutomationControl(
            params.message,
            toolExecutor,
            directIntent?.decision,
          );
          if (!directAutomationControl) break;
          return this.attachIntentGatewayMetadata(directAutomationControl, directIntent);
        }
        case 'automation_output': {
          const directAutomationOutput = await this.tryDirectAutomationOutput(
            params.message,
            toolExecutor,
            directIntent?.decision,
          );
          if (!directAutomationOutput) break;
          return this.attachIntentGatewayMetadata(directAutomationOutput, directIntent);
        }
        case 'browser': {
          const directBrowserAutomation = await this.tryDirectBrowserAutomation(
            params.message,
            toolExecutor,
            directIntent?.decision,
          );
          if (!directBrowserAutomation) break;
          return this.attachIntentGatewayMetadata(directBrowserAutomation, directIntent);
        }
        default:
          break;
      }
    }

    const promptAdditionalSections = buildWorkerPromptAdditionalSections(
      params.additionalSections,
      directIntent?.decision,
    );
    const enrichedSystemPrompt = buildWorkerSystemPrompt({
      ...params,
      additionalSections: promptAdditionalSections,
    });
    const llmMessages: ChatMessage[] = buildChatMessagesFromHistory({
      systemPrompt: enrichedSystemPrompt,
      history: params.history,
      userContent: params.message.content,
    });

    return this.executeLoop(params.message, llmMessages, chatFn, toolExecutor, {
      ...params,
      executionProfile: selectedExecutionProfile ?? undefined,
    }, directIntent?.decision);
  }

  private async tryTaskPlannerDirectly(
    message: UserMessage,
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>,
    toolExecutor: BrokeredToolExecutor,
    decision?: IntentGatewayDecision | null,
    executionProfile?: SelectedExecutionProfile | null,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const planner = new (await import('../runtime/planner/task-planner.js')).TaskPlanner(
      async (msgs, opts) => chatFn(msgs, opts)
    );
    const plan = await planner.plan(message.content, decision || undefined);
    if (!plan) return { content: 'I tried to plan a solution for that complex request but ran into an error generating the execution DAG.' };

    const unsupportedActions = [...new Set(
      Object.values(plan.nodes)
        .map((node) => node.actionType)
        .filter((actionType) => actionType !== 'tool_call' && actionType !== 'execute_code'),
    )];
    if (unsupportedActions.length > 0) {
      plan.status = 'failed';
      return {
        content: [
          'I generated a DAG plan, but I cannot safely execute it because it includes unsupported planner actions.',
          `Unsupported actions: ${unsupportedActions.join(', ')}`,
          '',
          'Plan:',
          '```json',
          JSON.stringify(plan, null, 2),
          '```',
        ].join('\n'),
      };
    }

    const execution = await this.executePlannerPlan({
      plan,
      message,
      chatFn,
      toolExecutor,
      ...(executionProfile ? { executionProfile } : {}),
    });

    if (execution.outcome.status === 'paused') {
      const ids = execution.pendingNodes.map((pending) => pending.approvalId);
      this.pendingApprovals = {
        ids,
        expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
      };
      this.suspendedSession = {
        kind: 'planner',
        plan,
        pendingNodes: execution.pendingNodes,
        originalMessage: {
          ...message,
          ...(message.metadata ? { metadata: { ...message.metadata } } : {}),
        },
        trustState: execution.trustState,
        ...(executionProfile ? { executionProfile } : {}),
      };

      const pendingApprovalMeta = toolExecutor.getApprovalMetadata(ids);
      return {
        content: pendingApprovalMeta.length > 0
          ? formatPendingApprovalMessage(pendingApprovalMeta)
          : 'This action needs approval before I can continue.',
        metadata: pendingApprovalMeta.length > 0
          ? buildApprovalPendingActionMetadata(pendingApprovalMeta)
          : undefined,
      };
    }

    this.pendingApprovals = null;
    this.suspendedSession = null;
    return {
      content: [
        execution.outcome.status === 'failed'
          ? 'I generated a DAG plan for your request, but execution failed.'
          : 'I have generated and executed a DAG plan for your request.',
        '',
        'Plan:',
        '```json',
        JSON.stringify(plan, null, 2),
        '```',
      ].join('\n'),
    };
  }

  private async executePlannerPlan(input: {
    plan: ExecutionPlan;
    message: UserMessage;
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>;
    toolExecutor: BrokeredToolExecutor;
    executionProfile?: SelectedExecutionProfile;
    trustState?: PlannerTrustSnapshot;
  }): Promise<{
    outcome: PlanExecutionOutcome;
    pendingNodes: SuspendedPlannerNode[];
    trustState: PlannerTrustSnapshot;
  }> {
    const reflector = new (await import('../runtime/planner/reflection.js')).SemanticReflector(
      async (msgs, opts) => input.chatFn(msgs, opts)
    );

    const compactor = new (await import('../runtime/planner/compactor.js')).ContextCompactor(
      async (msgs, opts) => input.chatFn(msgs, opts)
    );

    const recoveryPlanner = new (await import('../runtime/planner/recovery.js')).RecoveryPlanner(
      async (msgs, opts) => input.chatFn(msgs, opts)
    );

    const learningQueue = new (await import('../runtime/planner/learning-queue.js')).ReflectiveLearningQueue(
      async (type, details) => {
        console.log(`Worker Learning Queue: ${type}`, details);
      }
    );

    const mutableTrustState: { contentTrustLevel: ContentTrustLevel; taintReasons: Set<string> } = {
      contentTrustLevel: input.trustState?.contentTrustLevel ?? 'trusted',
      taintReasons: new Set(input.trustState?.taintReasons ?? []),
    };
    const pendingNodes: SuspendedPlannerNode[] = [];
    const orchestrator = new (await import('../runtime/planner/orchestrator.js')).AssistantOrchestrator(
      async (node) => this.executePlannerNode(node, input.message, input.toolExecutor, mutableTrustState, pendingNodes),
      reflector,
      learningQueue,
      recoveryPlanner,
      compactor
    );

    const outcome = await orchestrator.executePlan(input.plan);
    return {
      outcome,
      pendingNodes,
      trustState: {
        contentTrustLevel: mutableTrustState.contentTrustLevel,
        taintReasons: [...mutableTrustState.taintReasons],
      },
    };
  }

  private async executePlannerNode(
    node: PlanNode,
    message: UserMessage,
    toolExecutor: BrokeredToolExecutor,
    trustState: { contentTrustLevel: ContentTrustLevel; taintReasons: Set<string> },
    pendingNodes: SuspendedPlannerNode[],
  ): Promise<Record<string, unknown> | PlanExecutionPauseControl> {
    if (node.actionType === 'tool_call') {
      const args = this.parsePlannerToolArgs(node);
      const result = await toolExecutor.executeModelTool(
        node.target,
        args,
        this.buildPlannerToolRequest(message, trustState),
      );
      if (result.status === 'pending_approval' && typeof result.approvalId === 'string' && typeof result.jobId === 'string') {
        pendingNodes.push({
          nodeId: node.id,
          approvalId: result.approvalId,
          jobId: result.jobId,
          toolName: node.target,
        });
        return createPlannerPauseControl(result);
      }
      this.updatePlannerTrustState(trustState, result);
      return result;
    }

    if (node.actionType === 'execute_code') {
      const result = await toolExecutor.executeModelTool(
        'code_remote_exec',
        { command: String(node.inputPrompt ?? '') },
        this.buildPlannerToolRequest(message, trustState),
      );
      if (result.status === 'pending_approval' && typeof result.approvalId === 'string' && typeof result.jobId === 'string') {
        pendingNodes.push({
          nodeId: node.id,
          approvalId: result.approvalId,
          jobId: result.jobId,
          toolName: 'code_remote_exec',
        });
        return createPlannerPauseControl(result);
      }
      this.updatePlannerTrustState(trustState, result);
      return result;
    }

    throw Object.assign(
      new Error(`Planner action '${node.actionType}' is not implemented in brokered execution.`),
      { nonRecoverable: true },
    );
  }

  private parsePlannerToolArgs(node: PlanNode): Record<string, unknown> {
    if (isRecord(node.inputPrompt)) {
      return node.inputPrompt;
    }
    if (typeof node.inputPrompt !== 'string') {
      throw new Error(`Planner node '${node.id}' does not contain a valid JSON tool payload.`);
    }
    const parsed = JSON.parse(node.inputPrompt);
    if (!isRecord(parsed)) {
      throw new Error(`Planner node '${node.id}' did not produce an object-shaped tool payload.`);
    }
    return parsed;
  }

  private buildPlannerToolRequest(
    message: UserMessage,
    trustState: { contentTrustLevel: ContentTrustLevel; taintReasons: Set<string> },
  ): Omit<ToolExecutionRequest, 'toolName' | 'args'> {
    const codeContext = message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
    return {
      origin: 'assistant',
      userId: message.userId,
      surfaceId: message.surfaceId,
      principalId: message.principalId ?? message.userId,
      principalRole: message.principalRole ?? 'owner',
      channel: message.channel,
      requestId: message.id,
      contentTrustLevel: trustState.contentTrustLevel,
      taintReasons: [...trustState.taintReasons],
      derivedFromTaintedContent: trustState.contentTrustLevel !== 'trusted',
      ...(codeContext ? { codeContext } : {}),
    };
  }

  private updatePlannerTrustState(
    trustState: { contentTrustLevel: ContentTrustLevel; taintReasons: Set<string> },
    result: unknown,
  ): void {
    if (!isRecord(result)) return;
    const trustLevel = result.trustLevel === 'quarantined'
      ? 'quarantined'
      : result.trustLevel === 'low_trust'
        ? 'low_trust'
        : 'trusted';
    if (trustLevel === 'quarantined') {
      trustState.contentTrustLevel = 'quarantined';
    } else if (trustLevel === 'low_trust' && trustState.contentTrustLevel === 'trusted') {
      trustState.contentTrustLevel = 'low_trust';
    }
    const taintReasons = Array.isArray(result.taintReasons)
      ? result.taintReasons.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    for (const reason of taintReasons) {
      trustState.taintReasons.add(reason);
    }
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
    const approvedIds = new Set<string>();
    const failedIds = new Set<string>();
    for (const approvalId of targetIds) {
      const decided = await this.client.decideApproval(
        approvalId,
        decision,
        message.principalId ?? message.userId,
        message.principalRole ?? 'owner',
      );
      results.push(decided.message);
      approvedAny ||= decided.success && decision === 'approved';
      if (decision === 'approved' && decided.success) approvedIds.add(approvalId);
      if (!decided.success) failedIds.add(approvalId);
    }

    if (decision === 'approved' && approvedAny && this.suspendedSession) {
      return this.resumeSuspendedSessionAfterApproval(chatFn, toolExecutor, params);
    }

    this.consumePendingApprovals(targetIds);
    if (this.automationContinuation) {
      const affected = targetIds.filter((id) => this.automationContinuation?.pendingApprovalIds.includes(id));
      if (decision === 'approved' && affected.length > 0) {
        const stillPending = this.automationContinuation.pendingApprovalIds.filter((id) => !approvedIds.has(id));
        if (stillPending.length === 0) {
          const originalMessage = this.automationContinuation.originalMessage;
          this.automationContinuation = null;
          const retry = await this.tryDirectAutomationAuthoring(originalMessage, toolExecutor, {
            assumeAuthoring: true,
          });
          if (retry) {
            results.push('');
            results.push(retry.content);
            return {
              content: results.join('\n'),
              metadata: retry.metadata,
            };
          }
        } else {
          this.automationContinuation = {
            ...this.automationContinuation,
            pendingApprovalIds: stillPending,
          };
        }
      } else if (affected.length > 0 && (decision === 'denied' || affected.some((id) => failedIds.has(id)))) {
        this.automationContinuation = null;
      }
    }
    return { content: results.join('\n') };
  }

  private async resumeSuspendedSessionAfterApproval(
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>,
    toolExecutor: BrokeredToolExecutor,
    params: WorkerMessageHandleParams,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const suspended = this.suspendedSession;
    if (!suspended) {
      return { content: 'There is no suspended action to continue.' };
    }

    if (suspended.kind === 'planner') {
      return this.resumeSuspendedPlannerAfterApproval(suspended, chatFn, toolExecutor);
    }

    const resumedMessages = [...suspended.llmMessages];
    for (const pending of suspended.pendingTools) {
      const result = await this.client.getApprovalResult(pending.approvalId);
      const toolPayload = result.success === true
        ? buildToolResultPayloadFromJob({
          status: 'succeeded',
          resultPreview: typeof result.message === 'string' && result.output === undefined
            ? result.message
            : JSON.stringify(result.output),
        })
        : { success: false, error: result.message ?? 'Approval was denied.' };
      resumedMessages.push({
        role: 'tool',
        toolCallId: pending.toolCallId,
        content: JSON.stringify(toolPayload),
      });
    }
    this.suspendedSession = null;
    this.pendingApprovals = null;

    return this.executeLoop(params.message, resumedMessages, chatFn, toolExecutor, params);
  }

  private async resumeSuspendedPlannerAfterApproval(
    suspended: SuspendedPlannerSession,
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>,
    toolExecutor: BrokeredToolExecutor,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const resumedTrustState = {
      contentTrustLevel: suspended.trustState.contentTrustLevel,
      taintReasons: new Set(suspended.trustState.taintReasons),
    };

    for (const pending of suspended.pendingNodes) {
      const node = suspended.plan.nodes[pending.nodeId];
      if (!node) continue;

      const result = await this.client.getApprovalResult(pending.approvalId);
      if (result.success === true) {
        const approvedResult: Record<string, unknown> = {
          success: true,
          status: 'succeeded',
          ...(typeof result.jobId === 'string' ? { jobId: result.jobId } : {}),
          ...(typeof result.message === 'string' ? { message: result.message } : {}),
          ...(result.output !== undefined ? { output: result.output } : {}),
        };
        node.status = 'running';
        node.result = approvedResult;
        this.updatePlannerTrustState(resumedTrustState, approvedResult);
      } else {
        node.status = 'failed';
        node.result = {
          success: false,
          status: result.status === 'denied' ? 'denied' : 'failed',
          ...(typeof result.jobId === 'string' ? { jobId: result.jobId } : {}),
          error: typeof result.message === 'string' && result.message.trim()
            ? result.message
            : 'Approval was denied.',
        };
      }
    }

    this.pendingApprovals = null;
    this.suspendedSession = null;

    const execution = await this.executePlannerPlan({
      plan: suspended.plan,
      message: suspended.originalMessage,
      chatFn,
      toolExecutor,
      trustState: {
        contentTrustLevel: resumedTrustState.contentTrustLevel,
        taintReasons: [...resumedTrustState.taintReasons],
      },
      ...(suspended.executionProfile ? { executionProfile: suspended.executionProfile } : {}),
    });

    if (execution.outcome.status === 'paused') {
      const ids = execution.pendingNodes.map((pending) => pending.approvalId);
      this.pendingApprovals = {
        ids,
        expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
      };
      this.suspendedSession = {
        kind: 'planner',
        plan: suspended.plan,
        pendingNodes: execution.pendingNodes,
        originalMessage: suspended.originalMessage,
        trustState: execution.trustState,
        ...(suspended.executionProfile ? { executionProfile: suspended.executionProfile } : {}),
      };
      const pendingApprovalMeta = toolExecutor.getApprovalMetadata(ids);
      return {
        content: pendingApprovalMeta.length > 0
          ? formatPendingApprovalMessage(pendingApprovalMeta)
          : 'This action needs approval before I can continue.',
        metadata: pendingApprovalMeta.length > 0
          ? buildApprovalPendingActionMetadata(pendingApprovalMeta)
          : undefined,
      };
    }

    return {
      content: [
        execution.outcome.status === 'failed'
          ? 'I generated a DAG plan for your request, but execution failed.'
          : 'I have generated and executed a DAG plan for your request.',
        '',
        'Plan:',
        '```json',
        JSON.stringify(suspended.plan, null, 2),
        '```',
      ].join('\n'),
    };
  }

  private async tryDirectAutomationAuthoring(
    message: UserMessage,
    toolExecutor: BrokeredToolExecutor,
    options?: {
      allowRemediation?: boolean;
      assumeAuthoring?: boolean;
      intentDecision?: IntentGatewayDecision | null;
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const trackedPendingApprovalIds: string[] = [];
    const result = await tryAutomationPreRoute({
      agentId: 'brokered-worker',
      message,
      executeTool: (toolName, args, request) => {
        const codeContext = message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
        return toolExecutor.executeModelTool(toolName, args, {
          ...request,
          surfaceId: message.surfaceId,
          ...(codeContext ? { codeContext } : {}),
        });
      },
      trackPendingApproval: (approvalId) => {
        trackedPendingApprovalIds.push(approvalId);
        const existingIds = this.getPendingApprovalIds();
        this.pendingApprovals = {
          ids: [...new Set([...existingIds, approvalId])],
          expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
        };
        this.suspendedSession = null;
      },
      formatPendingApprovalPrompt: (ids) => {
        const meta = toolExecutor.getApprovalMetadata(ids);
        return meta.length > 0
          ? formatPendingApprovalMessage(meta)
          : 'This action needs approval before I can continue.';
      },
      resolvePendingApprovalMetadata: (ids, fallback) => {
        const resolved = toolExecutor.getApprovalMetadata(ids);
        return resolved.length > 0 ? resolved : fallback;
      },
    }, options);
    if (!result) {
      this.automationContinuation = null;
      return null;
    }
    if (result.metadata?.resumeAutomationAfterApprovals && trackedPendingApprovalIds.length > 0) {
      this.automationContinuation = {
        originalMessage: message,
        pendingApprovalIds: trackedPendingApprovalIds,
        expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
      };
    } else {
      this.automationContinuation = null;
    }
    return result;
  }

  private async tryDirectAutomationControl(
    message: UserMessage,
    toolExecutor: BrokeredToolExecutor,
    intentDecision?: IntentGatewayDecision | null,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return tryAutomationControlPreRoute({
      agentId: 'brokered-worker',
      message,
      executeTool: (toolName, args, request) => {
        const codeContext = message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
        return toolExecutor.executeModelTool(toolName, args, {
          ...request,
          ...(codeContext ? { codeContext } : {}),
        });
      },
      trackPendingApproval: (approvalId) => {
        const existingIds = this.getPendingApprovalIds();
        this.pendingApprovals = {
          ids: [...new Set([...existingIds, approvalId])],
          expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
        };
        this.suspendedSession = null;
      },
      formatPendingApprovalPrompt: (ids) => {
        const meta = toolExecutor.getApprovalMetadata(ids);
        return meta.length > 0
          ? formatPendingApprovalMessage(meta)
          : 'This action needs approval before I can continue.';
      },
      resolvePendingApprovalMetadata: (ids, fallback) => {
        const resolved = toolExecutor.getApprovalMetadata(ids);
        return resolved.length > 0 ? resolved : fallback;
      },
    }, { intentDecision });
  }

  private async tryDirectAutomationOutput(
    message: UserMessage,
    toolExecutor: BrokeredToolExecutor,
    intentDecision?: IntentGatewayDecision | null,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return tryAutomationOutputPreRoute({
      agentId: 'brokered-worker',
      message,
      executeTool: (toolName, args, request) => {
        const codeContext = message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
        return toolExecutor.executeModelTool(toolName, args, {
          ...request,
          ...(codeContext ? { codeContext } : {}),
        });
      },
    }, {
      intentDecision,
    });
  }

  private async tryDirectBrowserAutomation(
    message: UserMessage,
    toolExecutor: BrokeredToolExecutor,
    intentDecision?: IntentGatewayDecision | null,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    return tryBrowserPreRoute({
      agentId: 'brokered-worker',
      message,
      executeTool: (toolName, args, request) => {
        const codeContext = message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
        return toolExecutor.executeModelTool(toolName, args, {
          ...request,
          ...(codeContext ? { codeContext } : {}),
        });
      },
      trackPendingApproval: (approvalId) => {
        const existingIds = this.getPendingApprovalIds();
        this.pendingApprovals = {
          ids: [...new Set([...existingIds, approvalId])],
          expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
        };
        this.suspendedSession = null;
      },
      formatPendingApprovalPrompt: (ids) => {
        const meta = toolExecutor.getApprovalMetadata(ids);
        return meta.length > 0
          ? formatPendingApprovalMessage(meta)
          : 'This action needs approval before I can continue.';
      },
      resolvePendingApprovalMetadata: (ids, fallback) => {
        const resolved = toolExecutor.getApprovalMetadata(ids);
        return resolved.length > 0 ? resolved : fallback;
      },
    }, { intentDecision });
  }

  private async classifyIntentGateway(
    message: UserMessage,
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>,
  ): Promise<IntentGatewayRecord | null> {
    const preRouted = readPreRoutedIntentGatewayMetadata(message.metadata);
    if (shouldReusePreRoutedIntentGateway(preRouted)) {
      return preRouted;
    }
    return this.intentGateway.classify(
      {
        content: stripLeadingContextPrefix(message.content),
        channel: message.channel,
      },
      chatFn,
    );
  }

  private attachIntentGatewayMetadata(
    response: { content: string; metadata?: Record<string, unknown> },
    intentGateway: IntentGatewayRecord | null,
  ): { content: string; metadata?: Record<string, unknown> } {
    const gatewayMeta = toIntentGatewayClientMetadata(intentGateway);
    if (!gatewayMeta) return response;
    return {
      content: response.content,
      metadata: {
        ...(response.metadata ?? {}),
        intentGateway: gatewayMeta,
      },
    };
  }

  private async executeLoop(
    message: UserMessage,
    llmMessages: ChatMessage[],
    chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<BrokeredChatResponse>,
    toolExecutor: BrokeredToolExecutor,
    params: WorkerMessageHandleParams,
    intentDecision?: IntentGatewayDecision,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const pendingTools: SuspendedToolCall[] = [];
    let responseSource: ResponseSourceMetadata | undefined;
    const codeContext = params.message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
    const selectedExecutionProfile = params.executionProfile
      ?? readSelectedExecutionProfileMetadata(params.message.metadata);

    // Fallback chat function: proxied through the broker with useFallback flag
    let fallbackChatFn: ((msgs: ChatMessage[], opts?: ChatOptions) => Promise<BrokeredChatResponse>) | undefined;
    if (params.hasFallbackProvider || selectedExecutionProfile?.fallbackProviderOrder?.length) {
      fallbackChatFn = async (msgs, opts) => {
        responseSource = {
          locality: selectedExecutionProfile?.providerLocality ?? 'external',
          ...(selectedExecutionProfile?.providerType ? { providerName: selectedExecutionProfile.providerType } : {}),
          ...(selectedExecutionProfile?.providerName && selectedExecutionProfile.providerName !== selectedExecutionProfile.providerType
            ? { providerProfileName: selectedExecutionProfile.providerName }
            : {}),
          ...(selectedExecutionProfile?.providerTier ? { providerTier: selectedExecutionProfile.providerTier } : {}),
          usedFallback: true,
          notice: 'Retried with an alternate model after the local model failed to format a tool call.',
        };
        return this.client.llmChat(
          msgs,
          opts,
          selectedExecutionProfile
            ? {
                providerName: selectedExecutionProfile.providerName,
                fallbackProviderOrder: selectedExecutionProfile.fallbackProviderOrder,
                useFallback: true,
              }
            : { useFallback: true },
        );
      };
    }

    const allowModelMemoryMutation = shouldAllowModelMemoryMutation(message.content);

    const result = await runLlmLoop(
      llmMessages,
      async (messages, options) => {
        try {
          const chatResponse = await chatFn(messages, options);
          responseSource = responseSource ?? (
            chatResponse.providerLocality === 'local' || chatResponse.providerLocality === 'external'
              ? (() => {
                  const actualProviderName = typeof chatResponse.providerName === 'string'
                    ? chatResponse.providerName.trim()
                    : '';
                  const useSelectedExecutionProfile = !!selectedExecutionProfile
                    && (
                      !actualProviderName
                      || actualProviderName === selectedExecutionProfile.providerName
                      || actualProviderName === selectedExecutionProfile.providerType
                    );
                  const providerName = useSelectedExecutionProfile
                    ? selectedExecutionProfile.providerType
                    : actualProviderName;
                  const selectedProviderTier = useSelectedExecutionProfile
                    ? selectedExecutionProfile.providerTier
                    : undefined;
                  return {
                    locality: chatResponse.providerLocality,
                    ...(providerName ? { providerName } : {}),
                    ...(useSelectedExecutionProfile
                      && selectedExecutionProfile.providerName !== selectedExecutionProfile.providerType
                      ? { providerProfileName: selectedExecutionProfile.providerName }
                      : {}),
                    ...(selectedProviderTier
                      ? { providerTier: selectedProviderTier }
                      : {}),
                  } satisfies ResponseSourceMetadata;
                })()
              : undefined
          );
          return chatResponse;
        } catch (error) {
          if (isLocalToolCallParseError(error)) {
            if (shouldBypassLocalModelComplexityGuard()) {
              throw error;
            }
            if (fallbackChatFn) {
              return fallbackChatFn(messages, options);
            }
            throw new Error(buildLocalModelTooComplicatedMessage());
          }
          throw error;
        }
      },
      {
        listAlwaysLoaded: () => toolExecutor.listAlwaysLoadedDefinitions(),
        searchTools: (query) => toolExecutor.searchTools(query),
        callTool: async (request) => {
          const toolDefinition = toolExecutor.getToolDefinition(request.toolName);
          const prepared = prepareToolExecutionForIntent({
            toolName: request.toolName,
            args: request.args,
            requestText: message.content,
            referenceTime: message.timestamp,
            intentDecision,
            toolDefinition,
          });
          if (prepared.immediateResult) {
            return prepared.immediateResult as unknown as ToolRunResponse;
          }
          const runResult = await toolExecutor.executeModelTool(request.toolName, prepared.args, {
            ...request,
            surfaceId: message.surfaceId,
            ...(codeContext ? { codeContext } : {}),
          });
          return runResult as unknown as ToolRunResponse;
        },
      },
      6,
      selectedExecutionProfile?.contextBudget ?? 80_000,
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
        allowModelMemoryMutation,
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
        kind: 'tool_loop',
        llmMessages: result.messages,
        pendingTools,
        ...(selectedExecutionProfile ? { executionProfile: selectedExecutionProfile } : {}),
      };

      const pendingApprovalMeta = toolExecutor.getApprovalMetadata(ids);
      return {
        content: pendingApprovalMeta.length > 0
          ? formatPendingApprovalMessage(pendingApprovalMeta)
          : 'This action needs approval before I can continue.',
        metadata: pendingApprovalMeta.length > 0
          ? buildApprovalPendingActionMetadata(pendingApprovalMeta, responseSource)
          : undefined,
      };
    }

    this.pendingApprovals = null;
    this.suspendedSession = null;
    return {
      content: isPhantomPendingApprovalMessage(result.finalContent)
        ? 'I did not create a real approval request for that action. Please try again.'
        : result.finalContent,
      metadata: responseSource ? { responseSource } : undefined,
    };
  }

  private getPendingApprovalIds(nowMs: number = Date.now()): string[] {
    if (!this.pendingApprovals) return [];
    if (this.pendingApprovals.expiresAt <= nowMs) {
      this.pendingApprovals = null;
      this.automationContinuation = null;
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
  return buildSystemPromptWithContext({
    baseSystemPrompt: params.systemPrompt,
    knowledgeBases: params.knowledgeBases,
    activeSkills: params.activeSkills,
    additionalSections: params.additionalSections,
    toolContext: params.toolContext,
    runtimeNotices: params.runtimeNotices,
    pendingAction: params.pendingAction,
    pendingApprovalNotice: params.pendingApprovalNotice,
    continuity: params.continuity,
    ...(params.executionProfile ? { executionProfile: params.executionProfile } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
