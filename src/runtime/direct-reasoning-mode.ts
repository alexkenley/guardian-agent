/**
 * Direct Reasoning Mode for repo-inspection and coding-analysis tasks.
 *
 * This is a broker-friendly, read-only iterative tool loop. The runtime can
 * run it either inside the brokered worker or, when isolation is unavailable,
 * through injected supervisor callbacks. The module does not own tools,
 * providers, or channel rendering.
 */

import type { ChatMessage, ChatOptions, ChatResponse, ToolCall, ToolDefinition } from '../llm/types.js';
import type { AgentResponse } from '../agent/types.js';
import type { ToolExecutionRequest } from '../tools/types.js';
import type { IntentGatewayDecision, IntentGatewayRecord } from './intent/types.js';
import type { SelectedExecutionProfile } from './execution-profiles.js';
import type {
  PromptAssemblyAdditionalSection,
  PromptAssemblyKnowledgeBase,
} from './context-assembly.js';
import type { IntentRoutingTraceEntry, IntentRoutingTraceLog } from './intent-routing-trace.js';
import type { Logger } from 'pino';
import type { ExecutionGraphEvent, ExecutionGraphEventKind } from './execution-graph/graph-events.js';
import {
  buildDirectReasoningGraphContext,
  buildDirectReasoningGraphEvent,
  type DirectReasoningGraphContext,
} from './execution-graph/direct-reasoning-node.js';
import {
  artifactRefFromArtifact,
  buildFileReadSetArtifact,
  buildSearchResultSetArtifact,
  type EvidenceLedgerContent,
  type ExecutionArtifact,
  type SynthesisDraftValidationResult,
} from './execution-graph/graph-artifacts.js';
import {
  buildGroundedSynthesisLedgerArtifact,
  buildGroundedSynthesisMessages,
  createGroundedSynthesisDraftArtifact,
} from './execution-graph/synthesis-node.js';

import { deriveAnswerConstraints } from './intent/request-patterns.js';
import { isReadLikeOperation } from './orchestration-role-contracts.js';

export interface DirectReasoningTraceContext {
  requestId?: string;
  messageId?: string;
  userId?: string;
  channel?: string;
  agentId?: string;
  contentPreview?: string;
  executionId?: string;
  rootExecutionId?: string;
  taskExecutionId?: string;
  codeSessionId?: string;
}

export interface DirectReasoningInput {
  message: string;
  gateway: IntentGatewayRecord | null | undefined;
  selectedExecutionProfile: SelectedExecutionProfile | null | undefined;
  promptKnowledge?: {
    knowledgeBases?: PromptAssemblyKnowledgeBase[];
    globalContent?: string;
    codingMemoryContent?: string;
    additionalSections?: PromptAssemblyAdditionalSection[];
    toolContext?: string;
    runtimeNotices?: Array<{ level: 'info' | 'warn'; message: string }>;
  };
  workspaceRoot?: string;
  traceContext?: DirectReasoningTraceContext;
  toolRequest?: Partial<Omit<ToolExecutionRequest, 'toolName' | 'args' | 'origin'>> & {
    origin?: ToolExecutionRequest['origin'];
  };
  maxTurns?: number;
  maxTotalTimeMs?: number;
  perCallTimeoutMs?: number;
  graphContext?: DirectReasoningGraphContext;
}

export interface DirectReasoningGraphEventSink {
  emit: (event: ExecutionGraphEvent) => void;
}

export interface DirectReasoningDependencies {
  chat: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>;
  executeTool: (
    toolName: string,
    args: Record<string, unknown>,
    request: Partial<Omit<ToolExecutionRequest, 'toolName' | 'args'>>,
  ) => Promise<Record<string, unknown>>;
  trace?: Pick<IntentRoutingTraceLog, 'record'> | null;
  graphEvents?: DirectReasoningGraphEventSink | null;
  logger?: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'> | null;
  now?: () => number;
}

export interface DirectReasoningLoopResult {
  content: string;
  turns: number;
  toolCallCount: number;
  timedOut: boolean;
  evidenceCount: number;
  artifactCount: number;
  artifactIds: string[];
  synthesized: boolean;
}

interface DirectReasoningEvidenceEntry {
  toolName: string;
  args: Record<string, unknown>;
  status?: unknown;
  success?: unknown;
  summary: string;
  references: string[];
  snippets: string[];
}

interface DirectReasoningGraphEmitter {
  context: DirectReasoningGraphContext;
  emit: (kind: ExecutionGraphEventKind, payload?: Record<string, unknown>, eventKey?: string) => void;
}

interface DirectReasoningArtifactState {
  context: DirectReasoningGraphContext;
  artifacts: ExecutionArtifact[];
}

interface DirectReasoningSynthesisDraftArtifact {
  artifact: ExecutionArtifact;
  validation: SynthesisDraftValidationResult;
}

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_TOTAL_TIME_MS = 150_000;
const DEFAULT_PER_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_FINAL_RESPONSE_TIMEOUT_MS = 30_000;
const FINAL_RESPONSE_RESERVE_MS = 15_000;
const MAX_SYNTHESIS_EVIDENCE_CHARS = 24_000;
const DIRECT_SEARCH_DEFAULT_MAX_RESULTS = 40;
const DIRECT_SEARCH_DEFAULT_MAX_DEPTH = 12;
const DIRECT_SEARCH_DEFAULT_MAX_FILES = 2_500;
const DIRECT_SEARCH_DEFAULT_MAX_FILE_BYTES = 40_000;
const DIRECT_READ_DEFAULT_MAX_BYTES = 80_000;
const REPO_FILE_PREFIX_PATTERN = '(?:src|lib|pkg|internal|web|native|docs|scripts)';

export function shouldHandleDirectReasoningMode(input: {
  gateway: IntentGatewayRecord | null | undefined;
  selectedExecutionProfile: SelectedExecutionProfile | null | undefined;
}): boolean {
  const decision = input.gateway?.decision;
  if (!decision) return false;

  const isRepoGrounded = decision.requiresRepoGrounding === true
    || decision.executionClass === 'repo_grounded';
  const isInspectLike = isReadLikeOperation(decision.operation);
  const isRepoInspectionRoute = decision.route === 'coding_task' && isInspectLike;

  if (!isInspectLike) return false;
  if (!isRepoGrounded && !isRepoInspectionRoute) return false;
  if (decision.operation === 'create' || decision.operation === 'update' || decision.operation === 'delete') return false;
  if (decision.executionClass === 'security_analysis') return false;
  if (decision.executionClass === 'tool_orchestration') return false;

  const tier = input.selectedExecutionProfile?.providerTier;
  return !!input.selectedExecutionProfile && tier !== 'local';
}

export function buildDirectReasoningToolSet(): ToolDefinition[] {
  return [
    {
      name: 'fs_search',
      description: 'Search files by name or content inside the current workspace. Use content mode for implementation symbols and name mode for likely filenames.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          path: { type: 'string', description: 'Root directory to search. Defaults to the current workspace root.' },
          mode: { type: 'string', enum: ['name', 'content', 'auto'], description: 'Search mode.' },
          maxResults: { type: 'number', description: 'Maximum matches to return.' },
          maxDepth: { type: 'number', description: 'Maximum directory recursion depth.' },
          maxFiles: { type: 'number', description: 'Maximum files to scan.' },
          maxFileBytes: { type: 'number', description: 'Maximum bytes per file for content search.' },
          caseSensitive: { type: 'boolean', description: 'Enable case-sensitive matching.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'fs_read',
      description: 'Read a specific file inside the current workspace. Use this before citing files or symbols.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read.' },
          maxBytes: { type: 'number', description: 'Maximum bytes to read.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_list',
      description: 'List files in a directory inside the current workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list.' },
        },
        required: ['path'],
      },
    },
  ];
}

export function buildDirectReasoningSystemPrompt(input: {
  decision: IntentGatewayDecision;
  promptKnowledge?: DirectReasoningInput['promptKnowledge'];
  workspaceRoot?: string;
}): string {
  const { decision, promptKnowledge, workspaceRoot } = input;
  const constraints = deriveAnswerConstraints(decision.resolvedContent);
  const parts: string[] = [
    'You are a direct reasoning agent running inside GuardianAgent brokered execution.',
    'Inspect the repository with read-only tools, then answer the user from actual file evidence.',
    'Do not write, create, delete, rename, patch, run shell commands, or use tools outside the provided read-only tool set.',
    'Search broadly, read the likely implementation files, then narrow with more searches if the first evidence is only a surface hit.',
    'Always read files before citing them. Do not answer from search snippets alone.',
  ];

  if (constraints.requiresImplementationFiles) {
    parts.push('The answer must identify actual implementation files, not tests, generated files, or files that merely mention the term.');
  }
  if (constraints.requiresSymbolNames) {
    parts.push('The answer must include exact function, type, class, constant, or exported symbol names using backticks.');
  }
  if (constraints.readonly) {
    parts.push('The user explicitly requested read-only inspection. Do not modify files.');
  }
  if (workspaceRoot?.trim()) {
    parts.push(`Workspace root: ${workspaceRoot.trim()}`);
  }

  const toolContext = promptKnowledge?.toolContext?.trim();
  if (toolContext) {
    parts.push('', 'Available read context:', toolContext);
  }

  const runtimeNotices = promptKnowledge?.runtimeNotices ?? [];
  if (runtimeNotices.length > 0) {
    parts.push('', 'Runtime notices:');
    for (const notice of runtimeNotices) {
      parts.push(`- ${notice.level}: ${notice.message}`);
    }
  }

  const knowledgeParts = [
    promptKnowledge?.globalContent,
    promptKnowledge?.codingMemoryContent,
    ...(promptKnowledge?.knowledgeBases ?? []).map((kb) => kb.content),
    ...(promptKnowledge?.additionalSections ?? []).map((section) => section.content),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (knowledgeParts.length > 0) {
    parts.push('', 'Relevant context:');
    for (const part of knowledgeParts) {
      parts.push(part);
    }
  }

  parts.push(
    '',
    'Process:',
    '1. Use fs_search/fs_list to locate candidate implementation files.',
    '2. Use fs_read on the most relevant files before making claims.',
    '3. If the evidence is weak or only mentions the phrase, search again with symbol/function terms.',
    '4. Finish with a concise grounded answer listing file paths and symbols where requested.',
  );

  return parts.join('\n');
}

export async function handleDirectReasoningMode(
  input: DirectReasoningInput,
  deps: DirectReasoningDependencies,
): Promise<AgentResponse> {
  const decision = input.gateway?.decision;
  if (!decision) {
    return buildDirectReasoningFailureResponse(input, 'Direct reasoning could not run because no routed intent decision was available.');
  }

  recordDirectReasoningTrace(deps, input, 'direct_reasoning_started', {
    route: decision.route,
    operation: decision.operation,
    executionClass: decision.executionClass,
    providerName: input.selectedExecutionProfile?.providerName,
    providerTier: input.selectedExecutionProfile?.providerTier,
  });
  const graphEmitter = createDirectReasoningGraphEmitter(input, deps);
  graphEmitter?.emit('graph_started', {
    route: decision.route,
    operation: decision.operation,
    executionClass: decision.executionClass,
    providerName: input.selectedExecutionProfile?.providerName,
    providerTier: input.selectedExecutionProfile?.providerTier,
  }, 'graph_started');
  graphEmitter?.emit('node_started', {
    route: decision.route,
    operation: decision.operation,
    executionClass: decision.executionClass,
  }, 'node_started');

  const loopResult = await executeDirectReasoningLoop({
    messages: [
      {
        role: 'system',
        content: buildDirectReasoningSystemPrompt({
          decision,
          promptKnowledge: input.promptKnowledge,
          workspaceRoot: input.workspaceRoot,
        }),
      },
      { role: 'user', content: input.message },
    ],
    tools: buildDirectReasoningToolSet(),
    input,
    deps,
    graphEmitter,
  });

  if (!loopResult?.content.trim()) {
    recordDirectReasoningTrace(deps, input, 'direct_reasoning_failed', {
      route: decision.route,
      operation: decision.operation,
      executionClass: decision.executionClass,
      reason: 'no_final_answer',
    });
    graphEmitter?.emit('node_failed', { reason: 'no_final_answer' }, 'node_failed');
    graphEmitter?.emit('graph_failed', { reason: 'no_final_answer' }, 'graph_failed');
    return buildDirectReasoningFailureResponse(
      input,
      'Direct reasoning did not produce a final grounded answer within its read-only execution budget.',
    );
  }

  const qualityNotes = runDirectReasoningQualityCheck({
    result: loopResult,
    decision,
  });
  const content = qualityNotes.length > 0
    ? `${loopResult.content}\n\n${qualityNotes.join(' ')}`
    : loopResult.content;

  recordDirectReasoningTrace(deps, input, 'direct_reasoning_completed', {
    route: decision.route,
    operation: decision.operation,
    executionClass: decision.executionClass,
    turns: loopResult.turns,
    toolCallCount: loopResult.toolCallCount,
    timedOut: loopResult.timedOut,
    qualityNotes,
    providerName: input.selectedExecutionProfile?.providerName,
    providerTier: input.selectedExecutionProfile?.providerTier,
  });
  graphEmitter?.emit('node_completed', {
    turns: loopResult.turns,
    toolCallCount: loopResult.toolCallCount,
    evidenceCount: loopResult.evidenceCount,
    synthesized: loopResult.synthesized,
  }, 'node_completed');
  graphEmitter?.emit('graph_completed', {
    turns: loopResult.turns,
    toolCallCount: loopResult.toolCallCount,
    evidenceCount: loopResult.evidenceCount,
    synthesized: loopResult.synthesized,
  }, 'graph_completed');

  return {
    content,
    metadata: {
      executionProfile: input.selectedExecutionProfile ?? undefined,
      directReasoning: true,
      directReasoningMode: 'brokered_readonly',
      directReasoningStats: {
        turns: loopResult.turns,
        toolCallCount: loopResult.toolCallCount,
        timedOut: loopResult.timedOut,
        evidenceCount: loopResult.evidenceCount,
        artifactCount: loopResult.artifactCount,
        artifactIds: loopResult.artifactIds,
        synthesized: loopResult.synthesized,
      },
      ...(qualityNotes.length > 0 ? { qualityNotes } : {}),
    },
  };
}

export async function executeDirectReasoningLoop(input: {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  input: DirectReasoningInput;
  deps: DirectReasoningDependencies;
  graphEmitter?: DirectReasoningGraphEmitter | null;
}): Promise<DirectReasoningLoopResult | null> {
  const now = input.deps.now ?? Date.now;
  const startedAt = now();
  const maxTurns = Math.max(1, input.input.maxTurns ?? DEFAULT_MAX_TURNS);
  const maxTotalTimeMs = Math.max(5_000, input.input.maxTotalTimeMs ?? DEFAULT_MAX_TOTAL_TIME_MS);
  const perCallTimeoutMs = Math.max(1_000, input.input.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS);
  const messages = [...input.messages];
  let toolCallCount = 0;
  let finalContent = '';
  let timedOut = false;
  let turns = 0;
  const evidence: DirectReasoningEvidenceEntry[] = [];
  const artifactState: DirectReasoningArtifactState = {
    context: input.graphEmitter?.context ?? input.input.graphContext ?? buildDirectReasoningGraphContext({
      requestId: input.input.traceContext?.requestId,
      executionId: input.input.traceContext?.executionId,
      rootExecutionId: input.input.traceContext?.rootExecutionId,
      taskExecutionId: input.input.traceContext?.taskExecutionId,
      channel: input.input.traceContext?.channel,
      agentId: input.input.traceContext?.agentId,
      userId: input.input.traceContext?.userId,
      codeSessionId: input.input.traceContext?.codeSessionId,
      decision: input.input.gateway?.decision ?? null,
    }),
    artifacts: [],
  };

  while (turns < maxTurns) {
    const remainingMs = maxTotalTimeMs - (now() - startedAt);
    if (remainingMs <= 1_000) {
      timedOut = true;
      break;
    }
    if (toolCallCount > 0 && remainingMs <= FINAL_RESPONSE_RESERVE_MS + 1_000) {
      break;
    }

    turns += 1;
    const callBudgetMs = toolCallCount > 0
      ? Math.min(perCallTimeoutMs, Math.max(1_000, remainingMs - FINAL_RESPONSE_RESERVE_MS))
      : Math.min(perCallTimeoutMs, remainingMs);
    const chatResponse = await chatWithBudget(input.deps, messages, {
      tools: input.tools,
    }, callBudgetMs);
    if (!chatResponse) {
      timedOut = true;
      break;
    }

    if (!chatResponse.toolCalls || chatResponse.toolCalls.length === 0) {
      finalContent = chatResponse.content ?? '';
      break;
    }

    messages.push({
      role: 'assistant',
      content: chatResponse.content ?? '',
      toolCalls: chatResponse.toolCalls,
    });

    for (const toolCall of chatResponse.toolCalls) {
      toolCallCount += 1;
      const result = await executeDirectReasoningToolCall({
        toolCall,
        input: input.input,
        deps: input.deps,
        graphEmitter: input.graphEmitter,
        artifactState,
        turn: turns,
        evidence,
      });
      messages.push({
        role: 'tool',
        content: result,
        toolCallId: toolCall.id,
      });
    }
  }

  let synthesized = false;
  if (evidence.length > 0) {
    const remainingMs = maxTotalTimeMs - (now() - startedAt);
    const finalTimeoutMs = remainingMs > 1_000
      ? Math.min(DEFAULT_FINAL_RESPONSE_TIMEOUT_MS, remainingMs)
      : DEFAULT_FINAL_RESPONSE_TIMEOUT_MS;
    if (finalTimeoutMs > 1_000) {
      recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_synthesis_started', {
        route: input.input.gateway?.decision.route,
        operation: input.input.gateway?.decision.operation,
        reason: finalContent.trim()
          ? 'direct_reasoning_grounded_synthesis'
          : 'direct_reasoning_no_final_answer',
        toolCallCount,
        evidenceCount: evidence.length,
        artifactCount: artifactState.artifacts.length,
      });
      const ledgerArtifact = createDirectReasoningEvidenceLedgerArtifact(artifactState, now());
      if (ledgerArtifact) {
        input.graphEmitter?.emit('artifact_created', artifactEventPayload(ledgerArtifact), `artifact:${ledgerArtifact.artifactId}`);
      }
      input.graphEmitter?.emit('llm_call_started', {
        phase: 'grounded_synthesis',
        toolCallCount,
        evidenceCount: evidence.length,
        artifactCount: artifactState.artifacts.length,
      }, 'synthesis:started');
      const synthesisMessages = buildDirectReasoningSynthesisMessages({
        input: input.input,
        artifacts: artifactState.artifacts,
        ledgerArtifact,
        toolCallCount,
      });
      const finalResponse = await chatWithBudget(input.deps, synthesisMessages, { tools: [] }, finalTimeoutMs);
      if (finalResponse?.content?.trim()) {
        finalContent = finalResponse.content;
        synthesized = true;
        const draftArtifact = createDirectReasoningSynthesisDraftArtifact(artifactState, finalContent, now());
        input.graphEmitter?.emit(
          'artifact_created',
          artifactEventPayload(draftArtifact.artifact, draftArtifact.validation),
          `artifact:${draftArtifact.artifact.artifactId}`,
        );
        recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_synthesis_completed', {
          route: input.input.gateway?.decision.route,
          operation: input.input.gateway?.decision.operation,
          reason: 'direct_reasoning_grounded_synthesis_completed',
          toolCallCount,
          evidenceCount: evidence.length,
          artifactCount: artifactState.artifacts.length,
        });
        input.graphEmitter?.emit('llm_call_completed', {
          phase: 'grounded_synthesis',
          resultStatus: 'succeeded',
          toolCallCount,
          evidenceCount: evidence.length,
          artifactCount: artifactState.artifacts.length,
        }, 'synthesis:completed');
      } else {
        if (finalContent.trim()) {
          recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_synthesis_rejected', {
            route: input.input.gateway?.decision.route,
            operation: input.input.gateway?.decision.operation,
            reason: 'direct_reasoning_synthesis_empty_kept_exploration_answer',
            toolCallCount,
            evidenceCount: evidence.length,
            artifactCount: artifactState.artifacts.length,
          });
          input.graphEmitter?.emit('llm_call_completed', {
            phase: 'grounded_synthesis',
            resultStatus: 'empty_kept_exploration_answer',
            toolCallCount,
            evidenceCount: evidence.length,
            artifactCount: artifactState.artifacts.length,
          }, 'synthesis:completed');
        } else {
          const fallbackContent = buildDirectReasoningEvidenceFallbackAnswer(evidence);
          if (fallbackContent) {
            finalContent = fallbackContent;
            const draftArtifact = createDirectReasoningSynthesisDraftArtifact(artifactState, finalContent, now());
            input.graphEmitter?.emit(
              'artifact_created',
              artifactEventPayload(draftArtifact.artifact, draftArtifact.validation),
              `artifact:${draftArtifact.artifact.artifactId}`,
            );
            recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_synthesis_completed', {
              route: input.input.gateway?.decision.route,
              operation: input.input.gateway?.decision.operation,
              reason: 'direct_reasoning_deterministic_evidence_summary',
              toolCallCount,
              evidenceCount: evidence.length,
              artifactCount: artifactState.artifacts.length,
            });
            input.graphEmitter?.emit('llm_call_completed', {
              phase: 'grounded_synthesis',
              resultStatus: 'deterministic_evidence_summary',
              toolCallCount,
              evidenceCount: evidence.length,
              artifactCount: artifactState.artifacts.length,
            }, 'synthesis:completed');
          } else {
            recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_synthesis_rejected', {
              route: input.input.gateway?.decision.route,
              operation: input.input.gateway?.decision.operation,
              reason: 'direct_reasoning_final_answer_unavailable',
              toolCallCount,
              evidenceCount: evidence.length,
              artifactCount: artifactState.artifacts.length,
            });
            input.graphEmitter?.emit('llm_call_completed', {
              phase: 'grounded_synthesis',
              resultStatus: 'failed',
              errorMessage: 'Direct reasoning final answer unavailable.',
              toolCallCount,
              evidenceCount: evidence.length,
              artifactCount: artifactState.artifacts.length,
            }, 'synthesis:completed');
            timedOut = true;
          }
        }
      }
    } else if (!finalContent.trim()) {
      const fallbackContent = buildDirectReasoningEvidenceFallbackAnswer(evidence);
      if (fallbackContent) {
        finalContent = fallbackContent;
      } else {
        timedOut = true;
      }
    }
  } else if (!finalContent.trim() && messages.length > 2) {
    timedOut = true;
  }

  return finalContent.trim()
    ? {
        content: finalContent.trim(),
        turns,
        toolCallCount,
        timedOut,
        evidenceCount: evidence.length,
        artifactCount: artifactState.artifacts.length,
        artifactIds: artifactState.artifacts.map((artifact) => artifact.artifactId),
        synthesized,
      }
    : null;
}

export async function executeDirectReasoningToolCall(input: {
  toolCall: ToolCall;
  input: DirectReasoningInput;
  deps: DirectReasoningDependencies;
  graphEmitter?: DirectReasoningGraphEmitter | null;
  artifactState?: DirectReasoningArtifactState;
  turn: number;
  evidence?: DirectReasoningEvidenceEntry[];
}): Promise<string> {
  const { toolCall } = input;
  const toolName = toolCall.name;
  const args = parseToolArgs(toolCall.arguments);
  if (!args) {
    return `Error: Invalid JSON arguments for tool ${toolName}`;
  }

  if (toolName !== 'fs_search' && toolName !== 'fs_read' && toolName !== 'fs_list') {
    return `Tool "${toolName}" is not available in direct reasoning mode. Available tools: fs_search, fs_read, fs_list.`;
  }
  const boundedArgs = normalizeDirectReasoningToolArgs(toolName, args, input.input);

  recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_tool_call', {
    tool: toolName,
    turn: input.turn,
    phase: 'started',
    args: redactDirectReasoningToolArgs(boundedArgs),
  });
  input.graphEmitter?.emit('tool_call_started', {
    toolName,
    toolCallId: toolCall.id,
    turn: input.turn,
    argsPreview: stringifyCompact(redactDirectReasoningToolArgs(boundedArgs)),
  }, `tool:${toolCall.id}:started`);

  try {
    const result = await input.deps.executeTool(toolName, boundedArgs, {
      origin: input.input.toolRequest?.origin ?? 'assistant',
      requestId: input.input.toolRequest?.requestId ?? input.input.traceContext?.requestId,
      agentId: input.input.toolRequest?.agentId ?? input.input.traceContext?.agentId,
      userId: input.input.toolRequest?.userId ?? input.input.traceContext?.userId,
      principalId: input.input.toolRequest?.principalId,
      principalRole: input.input.toolRequest?.principalRole,
      channel: input.input.toolRequest?.channel ?? input.input.traceContext?.channel,
      surfaceId: input.input.toolRequest?.surfaceId,
      contentTrustLevel: input.input.toolRequest?.contentTrustLevel,
      taintReasons: input.input.toolRequest?.taintReasons,
      derivedFromTaintedContent: input.input.toolRequest?.derivedFromTaintedContent,
      codeContext: input.input.toolRequest?.codeContext,
      toolContextMode: input.input.toolRequest?.toolContextMode,
      agentContext: input.input.toolRequest?.agentContext,
      activeSkills: input.input.toolRequest?.activeSkills,
      allowModelMemoryMutation: input.input.toolRequest?.allowModelMemoryMutation,
      scheduleId: input.input.toolRequest?.scheduleId,
      dryRun: input.input.toolRequest?.dryRun,
    });

    recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_tool_call', {
      tool: toolName,
      turn: input.turn,
      phase: 'completed',
      status: result.status,
      success: result.success,
      preview: formatToolResultPreview(result),
    });
    input.graphEmitter?.emit('tool_call_completed', {
      toolName,
      toolCallId: toolCall.id,
      turn: input.turn,
      resultStatus: typeof result.status === 'string' ? result.status : (result.success === false ? 'failed' : 'succeeded'),
      ...(typeof result.message === 'string' ? { resultMessage: result.message } : {}),
      ...(formatToolResultPreview(result) ? { resultPreview: formatToolResultPreview(result) } : {}),
    }, `tool:${toolCall.id}:completed`);

    const evidenceEntry = buildDirectReasoningEvidenceEntry(toolName, boundedArgs, result);
    input.evidence?.push(evidenceEntry);
    const artifact = createDirectReasoningToolArtifact({
      state: input.artifactState,
      toolName,
      toolCallId: toolCall.id,
      args: boundedArgs,
      result,
      createdAt: input.deps.now?.() ?? Date.now(),
    });
    if (artifact) {
      input.artifactState?.artifacts.push(artifact);
      input.graphEmitter?.emit('artifact_created', artifactEventPayload(artifact), `artifact:${artifact.artifactId}`);
    }
    return formatDirectReasoningToolResult(toolName, boundedArgs, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_tool_call', {
      tool: toolName,
      turn: input.turn,
      phase: 'failed',
      error: message,
    });
    input.graphEmitter?.emit('tool_call_completed', {
      toolName,
      toolCallId: toolCall.id,
      turn: input.turn,
      resultStatus: 'failed',
      errorMessage: message,
    }, `tool:${toolCall.id}:completed`);
    return `Error executing ${toolName}: ${message}`;
  }
}

export function runDirectReasoningQualityCheck(input: {
  result: { content: string };
  decision: IntentGatewayDecision;
}): string[] {
  const constraints = deriveAnswerConstraints(input.decision.resolvedContent);
  const notes: string[] = [];
  const answer = input.result.content;

  if (constraints.requiresSymbolNames && !/`[^`]+`/.test(answer)) {
    notes.push('Quality note: the answer does not include backtick-quoted code symbols.');
  }
  if (constraints.requiresImplementationFiles) {
    const fileMatches = answer.match(/(?:[A-Za-z]:[\\/])?(?:src|lib|pkg|internal|web|native|docs)[\\/][\w./\\-]+\.(?:ts|tsx|js|mjs|rs|go|py|md)/g);
    if (!fileMatches || fileMatches.length === 0) {
      notes.push('Quality note: the answer does not cite implementation file paths.');
    }
  }

  return notes;
}

function buildDirectReasoningFailureResponse(
  input: DirectReasoningInput,
  content: string,
): AgentResponse {
  return {
    content,
    metadata: {
      executionProfile: input.selectedExecutionProfile ?? undefined,
      directReasoning: true,
      directReasoningMode: 'brokered_readonly',
      directReasoningFailed: true,
    },
  };
}

async function chatWithBudget(
  deps: DirectReasoningDependencies,
  messages: ChatMessage[],
  options: ChatOptions | undefined,
  timeoutMs: number,
): Promise<ChatResponse | null> {
  let timer: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, Math.max(1, timeoutMs));
  });
  try {
    const response = await Promise.race([
      deps.chat(messages, options ? { ...options, signal: controller.signal } : { signal: controller.signal }),
      timeout,
    ]);
    return response;
  } catch (error) {
    deps.logger?.warn?.(
      { error: error instanceof Error ? error.message : String(error) },
      'Direct reasoning chat call failed',
    );
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseToolArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function buildDirectReasoningSynthesisMessages(input: {
  input: DirectReasoningInput;
  artifacts?: ExecutionArtifact[];
  ledgerArtifact?: ExecutionArtifact<EvidenceLedgerContent> | null;
  toolCallCount: number;
}): ChatMessage[] {
  return buildGroundedSynthesisMessages({
    request: input.input.message,
    decision: input.input.gateway?.decision ?? null,
    workspaceRoot: input.input.workspaceRoot,
    completedToolCalls: input.toolCallCount,
    sourceArtifacts: input.artifacts ?? [],
    ledgerArtifact: input.ledgerArtifact ?? null,
    maxEvidenceChars: MAX_SYNTHESIS_EVIDENCE_CHARS,
    purpose: 'final_answer',
  });
}

function buildDirectReasoningEvidenceEntry(
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): DirectReasoningEvidenceEntry {
  const output = result.output && typeof result.output === 'object'
    ? result.output as Record<string, unknown>
    : result;
  const base = {
    toolName,
    args,
    status: result.status,
    success: result.success,
  };

  if (result.success === false) {
    return {
      ...base,
      summary: `Tool failed: ${truncateText(stringifyCompact(result.error ?? result.message ?? result), 300)}`,
      references: [],
      snippets: [],
    };
  }

  if (toolName === 'fs_search' && Array.isArray(output.matches)) {
    const matches = output.matches as Array<Record<string, unknown>>;
    const references = matches
      .map((match) => stringValue(match.relativePath) || stringValue(match.path))
      .filter((value): value is string => value.length > 0);
    const snippets = matches
      .slice(0, 20)
      .map((match) => {
        const reference = stringValue(match.relativePath) || stringValue(match.path) || 'unknown';
        const snippet = compactLine(stringValue(match.snippet));
        return snippet ? `${reference}: ${snippet}` : reference;
      });
    return {
      ...base,
      summary: `Search "${stringValue(output.query) || stringValue(args.query)}" returned ${matches.length} matches${output.truncated ? ' (truncated)' : ''}.`,
      references,
      snippets,
    };
  }

  if (toolName === 'fs_read' && typeof output.content === 'string') {
    const path = stringValue(output.path) || stringValue(args.path) || 'unknown';
    return {
      ...base,
      summary: `Read ${path} (${stringifyCompact(output.bytes ?? output.content.length)} bytes${output.truncated ? ', truncated' : ''}).`,
      references: [path],
      snippets: extractFileEvidenceSnippets(path, output.content),
    };
  }

  if (toolName === 'fs_list' && Array.isArray(output.entries)) {
    const directory = stringValue(output.path) || stringValue(args.path) || 'unknown';
    const snippets = output.entries.slice(0, 40).map((entry) => {
      if (typeof entry === 'string') return `${directory}/${entry}`;
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const name = stringValue(record.name) || 'unknown';
        const type = stringValue(record.type);
        return `${directory}/${name}${type ? ` (${type})` : ''}`;
      }
      return `${directory}/${String(entry)}`;
    });
    return {
      ...base,
      summary: `Listed ${directory} (${output.entries.length} entries).`,
      references: [directory],
      snippets,
    };
  }

  return {
    ...base,
    summary: truncateText(stringifyCompact(output), 500),
    references: [],
    snippets: [truncateText(stringifyCompact(output), 800)],
  };
}

function createDirectReasoningToolArtifact(input: {
  state?: DirectReasoningArtifactState;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: number;
}): ExecutionArtifact | null {
  if (!input.state || input.result.success === false) {
    return null;
  }
  const output = input.result.output && typeof input.result.output === 'object'
    ? input.result.output as Record<string, unknown>
    : input.result;
  const artifactId = `${input.state.context.graphId}:${input.toolCallId}:artifact`;
  const trustLevel = input.result.trustLevel === 'quarantined'
    ? 'quarantined'
    : input.result.trustLevel === 'low_trust'
      ? 'low_trust'
      : 'trusted';
  const taintReasons = Array.isArray(input.result.taintReasons)
    ? input.result.taintReasons.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];

  if (input.toolName === 'fs_search' && Array.isArray(output.matches)) {
    return buildSearchResultSetArtifact({
      graphId: input.state.context.graphId,
      nodeId: input.state.context.nodeId,
      artifactId,
      label: 'Direct reasoning search results',
      query: stringValue(output.query) || stringValue(input.args.query),
      matches: output.matches as Array<Record<string, unknown>>,
      truncated: output.truncated === true,
      trustLevel,
      taintReasons,
      createdAt: input.createdAt,
    });
  }

  if (input.toolName === 'fs_read' && typeof output.content === 'string') {
    return buildFileReadSetArtifact({
      graphId: input.state.context.graphId,
      nodeId: input.state.context.nodeId,
      artifactId,
      label: 'Direct reasoning file read',
      path: stringValue(output.path) || stringValue(input.args.path) || 'unknown',
      content: output.content,
      bytes: typeof output.bytes === 'number' && Number.isFinite(output.bytes) ? output.bytes : output.content.length,
      truncated: output.truncated === true,
      trustLevel,
      taintReasons,
      createdAt: input.createdAt,
    });
  }

  if (input.toolName === 'fs_list' && Array.isArray(output.entries)) {
    const directory = stringValue(output.path) || stringValue(input.args.path) || 'unknown';
    const matches = output.entries.map((entry) => {
      if (typeof entry === 'string') {
        return { relativePath: `${directory}/${entry}`, matchType: 'directory_entry' };
      }
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const name = stringValue(record.name) || 'unknown';
        return { relativePath: `${directory}/${name}`, matchType: stringValue(record.type) || 'directory_entry' };
      }
      return { relativePath: `${directory}/${String(entry)}`, matchType: 'directory_entry' };
    });
    return buildSearchResultSetArtifact({
      graphId: input.state.context.graphId,
      nodeId: input.state.context.nodeId,
      artifactId,
      label: 'Direct reasoning directory listing',
      query: directory,
      matches,
      truncated: false,
      trustLevel,
      taintReasons,
      createdAt: input.createdAt,
    });
  }

  return null;
}

function createDirectReasoningEvidenceLedgerArtifact(
  state: DirectReasoningArtifactState,
  createdAt: number,
): ExecutionArtifact<EvidenceLedgerContent> | null {
  const sourceArtifacts = state.artifacts.filter((artifact) => artifact.artifactType !== 'EvidenceLedger' && artifact.artifactType !== 'SynthesisDraft');
  if (sourceArtifacts.length === 0) {
    return null;
  }
  const existing = state.artifacts.find((artifact): artifact is ExecutionArtifact<EvidenceLedgerContent> => artifact.artifactType === 'EvidenceLedger');
  if (existing) {
    return existing;
  }
  const artifact = buildGroundedSynthesisLedgerArtifact({
    graphId: state.context.graphId,
    nodeId: state.context.nodeId,
    artifactId: `${state.context.graphId}:evidence-ledger`,
    sourceArtifacts,
    createdAt,
  });
  if (!artifact) {
    return null;
  }
  state.artifacts.push(artifact);
  return artifact;
}

function createDirectReasoningSynthesisDraftArtifact(
  state: DirectReasoningArtifactState,
  content: string,
  createdAt: number,
): DirectReasoningSynthesisDraftArtifact {
  const sourceArtifacts = state.artifacts.filter((artifact) => artifact.artifactType !== 'SynthesisDraft');
  const existing = state.artifacts.find((artifact) => artifact.artifactType === 'SynthesisDraft');
  if (existing) {
    return {
      artifact: existing,
      validation: {
        valid: true,
        missingArtifactIds: [],
        invalidRefs: [],
      },
    };
  }
  const result = createGroundedSynthesisDraftArtifact({
    graphId: state.context.graphId,
    nodeId: state.context.nodeId,
    artifactId: `${state.context.graphId}:synthesis-draft`,
    content,
    sourceArtifacts,
    createdAt,
  });
  state.artifacts.push(result.artifact);
  return result;
}

function artifactEventPayload(
  artifact: ExecutionArtifact,
  validation?: SynthesisDraftValidationResult,
): Record<string, unknown> {
  const ref = artifactRefFromArtifact(artifact);
  return {
    artifactId: ref.artifactId,
    artifactType: ref.artifactType,
    label: ref.label,
    ...(ref.preview ? { preview: ref.preview } : {}),
    ...(ref.trustLevel ? { trustLevel: ref.trustLevel } : {}),
    ...(ref.taintReasons ? { taintReasons: ref.taintReasons } : {}),
    ...(ref.redactionPolicy ? { redactionPolicy: ref.redactionPolicy } : {}),
    ...(validation ? {
      citationValidation: {
        valid: validation.valid,
        missingArtifactIds: validation.missingArtifactIds,
        invalidRefs: validation.invalidRefs,
      },
    } : {}),
    summary: ref.preview ?? ref.label,
  };
}

function extractFileEvidenceSnippets(path: string, content: string): string[] {
  const lines = content.split(/\r?\n/);
  const selected: string[] = [];
  const declarationPattern = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+[A-Za-z_$][\w$]*/;
  const callPattern = /\b[A-Za-z_$][\w$.]*\s*\(/;
  for (const [index, line] of lines.entries()) {
    const trimmed = compactLine(line);
    if (!trimmed || trimmed.length < 2) continue;
    if (!declarationPattern.test(trimmed) && !isLikelyImplementationCallLine(trimmed, callPattern)) continue;
    selected.push(`${path}:${index + 1}: ${trimmed}`);
    if (selected.length >= 24) break;
  }

  if (selected.length > 0) {
    return selected;
  }

  for (const [index, line] of lines.entries()) {
    const trimmed = compactLine(line);
    if (!trimmed) continue;
    selected.push(`${path}:${index + 1}: ${trimmed}`);
    if (selected.length >= 8) break;
  }
  return selected;
}

function isLikelyImplementationCallLine(line: string, callPattern: RegExp): boolean {
  if (!callPattern.test(line)) {
    return false;
  }
  const firstToken = line.match(/^[\s}]*([A-Za-z_$][\w$]*)\b/)?.[1];
  return !firstToken || !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(firstToken);
}

function buildDirectReasoningEvidenceFallbackAnswer(evidence: DirectReasoningEvidenceEntry[]): string | null {
  const fileSymbols = new Map<string, Set<string>>();
  for (const entry of evidence) {
    for (const reference of entry.references) {
      const file = normalizeRepoFileReference(reference);
      if (file) {
        if (!fileSymbols.has(file)) fileSymbols.set(file, new Set());
      }
    }
    for (const snippet of entry.snippets) {
      const file = extractFilePathFromSnippet(snippet);
      if (!file) continue;
      const symbols = fileSymbols.get(file) ?? new Set<string>();
      for (const symbol of extractSymbolNames(snippet)) {
        symbols.add(symbol);
      }
      fileSymbols.set(file, symbols);
    }
  }

  if (fileSymbols.size === 0) {
    return null;
  }

  const lines = [
    'Relevant repository evidence found:',
    '',
  ];
  for (const [file, symbols] of [...fileSymbols.entries()].slice(0, 12)) {
    const symbolList = [...symbols].slice(0, 12);
    lines.push(symbolList.length > 0
      ? `- \`${file}\`: ${symbolList.map((symbol) => `\`${symbol}\``).join(', ')}`
      : `- \`${file}\``);
  }
  return lines.join('\n');
}

function formatDirectReasoningToolResult(
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string {
  if (result.success === false) {
    return `Error: ${stringifyCompact(result.error ?? result.message ?? result)}`;
  }

  const output = result.output && typeof result.output === 'object'
    ? result.output as Record<string, unknown>
    : result;

  if (output.quarantined === true) {
    return [
      'Tool result was quarantined by Guardian output policy.',
      `Trust level: ${stringifyCompact(output.trustLevel ?? 'unknown')}`,
      `Preview: ${stringifyCompact(output.preview ?? '')}`,
    ].join('\n');
  }

  if (toolName === 'fs_search' && Array.isArray(output.matches)) {
    const matches = output.matches as Array<Record<string, unknown>>;
    const lines = matches.map((match) => {
      const rel = stringValue(match.relativePath) || stringValue(match.path) || 'unknown';
      const type = stringValue(match.matchType);
      const snippet = stringValue(match.snippet);
      return snippet
        ? `- ${rel}${type ? ` (${type})` : ''}\n  ${snippet}`
        : `- ${rel}${type ? ` (${type})` : ''}`;
    });
    return [
      `Search results for "${stringValue(output.query) || stringValue(args.query)}" (${matches.length} matches${output.truncated ? ', truncated' : ''}):`,
      ...lines,
    ].join('\n');
  }

  if (toolName === 'fs_read' && typeof output.content === 'string') {
    return [
      `File: ${stringValue(output.path) || stringValue(args.path)}`,
      `Bytes: ${stringifyCompact(output.bytes ?? 'unknown')}`,
      output.truncated ? 'Truncated: true' : 'Truncated: false',
      '',
      output.content,
    ].join('\n');
  }

  if (toolName === 'fs_list' && Array.isArray(output.entries)) {
    const lines = output.entries.map((entry) => {
      if (typeof entry === 'string') return `- ${entry}`;
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const name = stringValue(record.name) || 'unknown';
        const type = stringValue(record.type);
        return `- ${type ? `[${type}] ` : ''}${name}`;
      }
      return `- ${String(entry)}`;
    });
    return [
      `Directory: ${stringValue(output.path) || stringValue(args.path)}`,
      ...lines,
    ].join('\n');
  }

  return JSON.stringify(output, null, 2);
}

function formatToolResultPreview(result: Record<string, unknown>): string | undefined {
  const formatted = formatDirectReasoningToolResult('preview', {}, result);
  return formatted.length > 400 ? `${formatted.slice(0, 399)}...` : formatted;
}

function normalizeDirectReasoningToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  input: DirectReasoningInput,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...args };

  if (toolName === 'fs_search') {
    const path = stringValue(normalized.path);
    normalized.path = normalizeRepoDirectoryReference(path)
      ?? (isWorkspaceRootPath(path, input) ? selectDefaultDirectReasoningSearchPath(input) : undefined)
      ?? selectDefaultDirectReasoningSearchPath(input);
    normalized.maxResults = clampPositiveInteger(normalized.maxResults, DIRECT_SEARCH_DEFAULT_MAX_RESULTS, DIRECT_SEARCH_DEFAULT_MAX_RESULTS);
    normalized.maxDepth = clampPositiveInteger(normalized.maxDepth, DIRECT_SEARCH_DEFAULT_MAX_DEPTH, DIRECT_SEARCH_DEFAULT_MAX_DEPTH);
    normalized.maxFiles = clampPositiveInteger(normalized.maxFiles, DIRECT_SEARCH_DEFAULT_MAX_FILES, DIRECT_SEARCH_DEFAULT_MAX_FILES);
    normalized.maxFileBytes = clampPositiveInteger(normalized.maxFileBytes, DIRECT_SEARCH_DEFAULT_MAX_FILE_BYTES, DIRECT_SEARCH_DEFAULT_MAX_FILE_BYTES);
    return normalized;
  }

  if (toolName === 'fs_read') {
    const path = normalizeRepoFileReference(stringValue(normalized.path));
    if (path) normalized.path = path;
    normalized.maxBytes = clampPositiveInteger(normalized.maxBytes, DIRECT_READ_DEFAULT_MAX_BYTES, DIRECT_READ_DEFAULT_MAX_BYTES);
    return normalized;
  }

  if (toolName === 'fs_list') {
    const path = stringValue(normalized.path);
    normalized.path = normalizeRepoDirectoryReference(path)
      ?? (isWorkspaceRootPath(path, input) ? selectDefaultDirectReasoningSearchPath(input) : undefined)
      ?? selectDefaultDirectReasoningSearchPath(input);
  }

  return normalized;
}

function redactDirectReasoningToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    redacted[key] = typeof value === 'string' && value.length > 300
      ? `${value.slice(0, 299)}...`
      : value;
  }
  return redacted;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractFilePathFromSnippet(snippet: string): string | null {
  return normalizeRepoFileReference(snippet);
}

function normalizeRepoFileReference(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!normalized) return null;
  const pattern = new RegExp(`(?:^|/)(${REPO_FILE_PREFIX_PATTERN}/[\\w./-]+\\.[A-Za-z0-9]+)(?=$|[:\\s)\\]},"'])`);
  const match = normalized.match(pattern);
  return match?.[1] ?? null;
}

function normalizeRepoDirectoryReference(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  const file = normalizeRepoFileReference(normalized);
  if (file?.includes('/')) {
    return file.split('/').slice(0, -1).join('/');
  }
  const pattern = new RegExp(`(?:^|/)(${REPO_FILE_PREFIX_PATTERN}(?:/[\\w.-]+)*)(?=$|[:\\s)\\]},"'])`);
  const match = normalized.match(pattern);
  return match?.[1] ?? null;
}

function selectDefaultDirectReasoningSearchPath(input: DirectReasoningInput): string {
  const entityPath = normalizeRepoDirectoryReference(stringValue(input.gateway?.decision.entities.path));
  if (entityPath) return entityPath;
  return 'src';
}

function isWorkspaceRootPath(path: string, input: DirectReasoningInput): boolean {
  if (!path.trim()) return true;
  const normalizedPath = normalizePathForComparison(path);
  const workspaceRoots = [
    input.workspaceRoot,
    stringValue(input.toolRequest?.codeContext?.workspaceRoot),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return workspaceRoots.some((root) => normalizePathForComparison(root) === normalizedPath);
}

function normalizePathForComparison(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function clampPositiveInteger(value: unknown, fallback: number, max: number): number {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number(value) : NaN);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
}

function extractSymbolNames(snippet: string): string[] {
  const symbols = new Set<string>();
  const symbolPattern = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of snippet.matchAll(symbolPattern)) {
    if (match[1]) symbols.add(match[1]);
  }
  const methodPattern = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of snippet.matchAll(methodPattern)) {
    const name = match[1];
    if (!name || ['if', 'for', 'while', 'switch', 'catch', 'function'].includes(name)) continue;
    symbols.add(name);
  }
  return [...symbols];
}

function recordDirectReasoningTrace(
  deps: DirectReasoningDependencies,
  input: DirectReasoningInput,
  stage: IntentRoutingTraceEntry['stage'],
  details: Record<string, unknown>,
): void {
  deps.trace?.record({
    stage,
    requestId: input.traceContext?.requestId,
    messageId: input.traceContext?.messageId,
    userId: input.traceContext?.userId,
    channel: input.traceContext?.channel,
    agentId: input.traceContext?.agentId,
    contentPreview: input.traceContext?.contentPreview ?? input.message,
    details: {
      ...(input.traceContext?.executionId ? { executionId: input.traceContext.executionId } : {}),
      ...(input.traceContext?.rootExecutionId ? { rootExecutionId: input.traceContext.rootExecutionId } : {}),
      ...(input.traceContext?.taskExecutionId ? { taskExecutionId: input.traceContext.taskExecutionId } : {}),
      ...(input.traceContext?.codeSessionId ? { codeSessionId: input.traceContext.codeSessionId } : {}),
      ...details,
    },
  });
}

function createDirectReasoningGraphEmitter(
  input: DirectReasoningInput,
  deps: DirectReasoningDependencies,
): DirectReasoningGraphEmitter | null {
  if (!deps.graphEvents) {
    return null;
  }
  const context = input.graphContext ?? buildDirectReasoningGraphContext({
    requestId: input.traceContext?.requestId,
    executionId: input.traceContext?.executionId,
    rootExecutionId: input.traceContext?.rootExecutionId,
    taskExecutionId: input.traceContext?.taskExecutionId,
    channel: input.traceContext?.channel,
    agentId: input.traceContext?.agentId,
    userId: input.traceContext?.userId,
    codeSessionId: input.traceContext?.codeSessionId,
    decision: input.gateway?.decision ?? null,
  });
  let sequence = 0;
  return {
    context,
    emit: (kind, payload = {}, eventKey) => {
      sequence += 1;
      const event = buildDirectReasoningGraphEvent(context, {
        kind,
        sequence,
        timestamp: deps.now?.() ?? Date.now(),
        eventId: `${context.graphId}:${context.nodeId}:${eventKey ?? kind}:${sequence}`,
        payload,
      });
      try {
        deps.graphEvents?.emit(event);
      } catch (error) {
        deps.logger?.warn?.(
          { error: error instanceof Error ? error.message : String(error), eventKind: kind },
          'Direct reasoning graph event emission failed',
        );
      }
    },
  };
}

function stringifyCompact(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
