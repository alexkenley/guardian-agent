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
import { normalizeIntentGatewayRepairText } from './intent/text.js';
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
  graphLifecycle?: 'standalone' | 'node_only';
  returnExecutionGraphArtifacts?: boolean;
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
  executionGraphArtifacts?: ExecutionArtifact[];
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
  expansionQueries: string[];
}

interface DirectReasoningFileSummary {
  file: string;
  firstSeen: number;
  referenceCount: number;
  snippetCount: number;
  readCount: number;
  searchCount: number;
  listCount: number;
  symbols: Set<string>;
  declaredSymbols: Set<string>;
}

type DirectReasoningCoverageScope = 'default' | 'web_pages';

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
const DEFAULT_MAX_TOTAL_TIME_MS = 210_000;
const DEFAULT_PER_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_FINAL_RESPONSE_TIMEOUT_MS = 90_000;
const FINAL_RESPONSE_RESERVE_MS = 15_000;
const MAX_SYNTHESIS_EVIDENCE_CHARS = 16_000;
const MAX_DIRECT_REASONING_SYNTHESIS_ARTIFACTS = 14;
const MAX_DIRECT_REASONING_SYNTHESIS_COVERAGE_FILES = 16;
const MAX_DIRECT_REASONING_SYNTHESIS_COMPLETION_FILES = 8;
const DIRECT_REASONING_SYNTHESIS_REVISION_MIN_FILES = 4;
const DIRECT_REASONING_SYNTHESIS_REVISION_MIN_MISSING_FILES = 2;
const DIRECT_REASONING_SYNTHESIS_REVISION_MAX_MS = 45_000;
const DIRECT_REASONING_MIN_SYNTHESIS_RESERVE_TURNS = 5;
const DIRECT_REASONING_MIN_SYNTHESIS_READ_FILES = 2;
const DIRECT_REASONING_MIN_SYNTHESIS_CANDIDATE_FILES = 6;
const DIRECT_SEARCH_DEFAULT_MAX_RESULTS = 40;
const DIRECT_SEARCH_DEFAULT_MAX_DEPTH = 12;
const DIRECT_SEARCH_DEFAULT_MAX_FILES = 2_500;
const DIRECT_SEARCH_DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DIRECT_READ_DEFAULT_MAX_BYTES = 256_000;
const DIRECT_REASONING_MAX_AUTO_EVIDENCE_READS = 8;
const DIRECT_REASONING_MAX_EVIDENCE_EXPANSION_ROUNDS = 3;
const DIRECT_REASONING_MAX_EVIDENCE_EXPANSION_SEARCHES_PER_ROUND = 6;
const DIRECT_REASONING_MAX_EVIDENCE_EXPANSION_READS_PER_ROUND = 8;
const REPO_FILE_ROOTS = ['src', 'lib', 'pkg', 'internal', 'web', 'native', 'docs', 'scripts'];
const DIRECT_REASONING_IMPLEMENTATION_SEARCH_ROOTS = ['src', 'web', 'native', 'scripts'];
const REPO_FILE_PREFIX_PATTERN = `(?:${REPO_FILE_ROOTS.join('|')})`;
const CANONICAL_NON_SRC_REPO_ROOTS = ['web', 'native', 'docs', 'scripts'];

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
    'For repo-wide questions, search from path "." or multiple top-level source roots before treating a subdirectory as complete.',
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
    '1. Use fs_search/fs_list to locate candidate implementation files across the relevant repo roots.',
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
  const graphLifecycle = input.graphLifecycle ?? 'standalone';
  const graphEmitter = createDirectReasoningGraphEmitter(input, deps);
  if (graphLifecycle === 'standalone') {
    graphEmitter?.emit('graph_started', {
      route: decision.route,
      operation: decision.operation,
      executionClass: decision.executionClass,
      providerName: input.selectedExecutionProfile?.providerName,
      providerTier: input.selectedExecutionProfile?.providerTier,
    }, 'graph_started');
  }
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
    if (graphLifecycle === 'standalone') {
      graphEmitter?.emit('graph_failed', { reason: 'no_final_answer' }, 'graph_failed');
    }
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
  if (graphLifecycle === 'standalone') {
    graphEmitter?.emit('graph_completed', {
      turns: loopResult.turns,
      toolCallCount: loopResult.toolCallCount,
      evidenceCount: loopResult.evidenceCount,
      synthesized: loopResult.synthesized,
    }, 'graph_completed');
  }

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
      ...(input.returnExecutionGraphArtifacts && loopResult.executionGraphArtifacts
        ? { executionGraphArtifacts: loopResult.executionGraphArtifacts }
        : {}),
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
      requestId: directReasoningTraceRequestId(input.input),
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
    recordDirectReasoningLlmCall(input, 'started', {
      phase: 'exploration',
      turn: turns,
      attempt: 1,
      callBudgetMs,
      messageCount: messages.length,
      toolCount: input.tools.length,
    });
    let chatResponseAttempt = 1;
    let chatResponse = await chatWithBudget(input.deps, messages, {
      tools: input.tools,
    }, callBudgetMs);
    if (!chatResponse) {
      recordDirectReasoningLlmCall(input, 'completed', {
        phase: 'exploration',
        turn: turns,
        attempt: 1,
        resultStatus: 'timed_out_or_failed',
        errorMessage: 'Model call did not complete within the direct reasoning call budget.',
      });
      if (turns === 1 && toolCallCount === 0) {
        const retryMessages = buildDirectReasoningCompactRetryMessages(input.input);
        const retryRemainingMs = maxTotalTimeMs - (now() - startedAt);
        const retryBudgetMs = Math.min(perCallTimeoutMs, Math.max(1_000, retryRemainingMs - FINAL_RESPONSE_RESERVE_MS));
        if (retryBudgetMs > 1_000) {
          recordDirectReasoningLlmCall(input, 'started', {
            phase: 'exploration',
            turn: turns,
            attempt: 2,
            retryReason: 'first_call_no_response',
            callBudgetMs: retryBudgetMs,
            messageCount: retryMessages.length,
            toolCount: input.tools.length,
          });
          chatResponse = await chatWithBudget(input.deps, retryMessages, {
            tools: input.tools,
          }, retryBudgetMs);
          if (chatResponse) {
            chatResponseAttempt = 2;
            messages.splice(0, messages.length, ...retryMessages);
          }
          recordDirectReasoningLlmCall(input, 'completed', {
            phase: 'exploration',
            turn: turns,
            attempt: 2,
            retryReason: 'first_call_no_response',
            resultStatus: chatResponse ? 'succeeded' : 'timed_out_or_failed',
            ...(chatResponse
              ? summarizeDirectReasoningChatResponse(chatResponse)
              : { errorMessage: 'Retry model call did not complete within the direct reasoning call budget.' }),
          });
        }
      }
      if (!chatResponse) {
        timedOut = true;
        break;
      }
    }
    if (chatResponse && chatResponseAttempt === 1) {
      recordDirectReasoningLlmCall(input, 'completed', {
        phase: 'exploration',
        turn: turns,
        attempt: 1,
        resultStatus: 'succeeded',
        ...summarizeDirectReasoningChatResponse(chatResponse),
      });
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

    if (shouldReserveDirectReasoningForSynthesis(evidence, turns)) {
      recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_synthesis_reserved', {
        route: input.input.gateway?.decision.route,
        operation: input.input.gateway?.decision.operation,
        turn: turns,
        toolCallCount,
        evidenceCount: evidence.length,
        ...summarizeDirectReasoningEvidenceCoverage(evidence),
      });
      break;
    }
  }

  let synthesized = false;
  if (evidence.length > 0 && !finalContent.trim()) {
    const remainingForHydrationMs = maxTotalTimeMs - (now() - startedAt);
    if (remainingForHydrationMs > FINAL_RESPONSE_RESERVE_MS + 1_000) {
      toolCallCount += await hydrateDirectReasoningEvidenceFromSearch({
        input: input.input,
        deps: input.deps,
        graphEmitter: input.graphEmitter,
        artifactState,
        evidence,
        turn: Math.max(1, turns),
      });
    }
  }

  if (evidence.length > 0) {
    const remainingMs = maxTotalTimeMs - (now() - startedAt);
    const finalTimeoutMs = remainingMs > 1_000
      ? Math.min(DEFAULT_FINAL_RESPONSE_TIMEOUT_MS, remainingMs)
      : DEFAULT_FINAL_RESPONSE_TIMEOUT_MS;
    if (finalTimeoutMs > 1_000) {
      const synthesisArtifacts = selectDirectReasoningSynthesisArtifacts(artifactState.artifacts, evidence);
      recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_synthesis_started', {
        route: input.input.gateway?.decision.route,
        operation: input.input.gateway?.decision.operation,
        reason: finalContent.trim()
          ? 'direct_reasoning_grounded_synthesis'
          : 'direct_reasoning_no_final_answer',
        toolCallCount,
        evidenceCount: evidence.length,
        artifactCount: artifactState.artifacts.length,
        selectedArtifactCount: synthesisArtifacts.length,
        selectedArtifacts: synthesisArtifacts.map((artifact) => ({
          artifactId: artifact.artifactId,
          artifactType: artifact.artifactType,
          refs: artifact.refs.slice(0, 12),
        })),
      });
      const ledgerArtifact = createDirectReasoningEvidenceLedgerArtifact(artifactState, now(), synthesisArtifacts);
      if (ledgerArtifact) {
        input.graphEmitter?.emit('artifact_created', artifactEventPayload(ledgerArtifact), `artifact:${ledgerArtifact.artifactId}`);
      }
      input.graphEmitter?.emit('llm_call_started', {
        phase: 'grounded_synthesis',
        toolCallCount,
        evidenceCount: evidence.length,
        artifactCount: synthesisArtifacts.length,
      }, 'synthesis:started');
      const synthesisMessages = buildDirectReasoningSynthesisMessages({
        input: input.input,
        artifacts: synthesisArtifacts,
        ledgerArtifact,
        toolCallCount,
        evidence,
      });
      recordDirectReasoningLlmCall(input, 'started', {
        phase: 'grounded_synthesis',
        attempt: 1,
        callBudgetMs: finalTimeoutMs,
        messageCount: synthesisMessages.length,
        toolCount: 0,
        evidenceCount: evidence.length,
        artifactCount: synthesisArtifacts.length,
      });
      const finalResponse = await chatWithBudget(input.deps, synthesisMessages, { tools: [] }, finalTimeoutMs);
      let synthesisContent = finalResponse?.content?.trim() ? finalResponse.content : '';
      recordDirectReasoningLlmCall(input, 'completed', {
        phase: 'grounded_synthesis',
        attempt: 1,
        resultStatus: finalResponse ? 'succeeded' : 'timed_out_or_failed',
        ...(finalResponse
          ? summarizeDirectReasoningChatResponse(finalResponse)
          : { errorMessage: 'Grounded synthesis model call did not complete within the direct reasoning final-answer budget.' }),
        evidenceCount: evidence.length,
        artifactCount: synthesisArtifacts.length,
      });
      if (synthesisContent.trim()) {
        const missingCoverageFiles = findMissingDirectReasoningSynthesisCoverageFiles({
          content: synthesisContent,
          evidence,
          input: input.input,
        });
        const revisionRemainingMs = maxTotalTimeMs - (now() - startedAt);
        const revisionTimeoutMs = Math.min(
          DIRECT_REASONING_SYNTHESIS_REVISION_MAX_MS,
          Math.max(0, revisionRemainingMs),
        );
        if (missingCoverageFiles.length > 0 && revisionTimeoutMs > 1_000) {
          const revisionMessages = buildDirectReasoningSynthesisRevisionMessages({
            input: input.input,
            draft: synthesisContent,
            evidence,
            missingCoverageFiles,
          });
          recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_synthesis_coverage_revision', {
            route: input.input.gateway?.decision.route,
            operation: input.input.gateway?.decision.operation,
            phase: 'started',
            missingCoverageFiles: missingCoverageFiles.map((summary) => summary.file),
            coverageFileCount: selectDirectReasoningCoverageSummaries(evidence).length,
            callBudgetMs: revisionTimeoutMs,
          });
          recordDirectReasoningLlmCall(input, 'started', {
            phase: 'grounded_synthesis_revision',
            attempt: 1,
            callBudgetMs: revisionTimeoutMs,
            messageCount: revisionMessages.length,
            toolCount: 0,
            evidenceCount: evidence.length,
            artifactCount: synthesisArtifacts.length,
            missingCoverageFileCount: missingCoverageFiles.length,
          });
          const revisionResponse = await chatWithBudget(input.deps, revisionMessages, { tools: [] }, revisionTimeoutMs);
          recordDirectReasoningLlmCall(input, 'completed', {
            phase: 'grounded_synthesis_revision',
            attempt: 1,
            resultStatus: revisionResponse ? 'succeeded' : 'timed_out_or_failed',
            ...(revisionResponse
              ? summarizeDirectReasoningChatResponse(revisionResponse)
              : { errorMessage: 'Grounded synthesis coverage revision did not complete within budget.' }),
            evidenceCount: evidence.length,
            artifactCount: synthesisArtifacts.length,
            missingCoverageFileCount: missingCoverageFiles.length,
          });
          if (revisionResponse?.content?.trim()) {
            synthesisContent = revisionResponse.content;
          }
          recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_synthesis_coverage_revision', {
            route: input.input.gateway?.decision.route,
            operation: input.input.gateway?.decision.operation,
            phase: 'completed',
            resultStatus: revisionResponse?.content?.trim() ? 'revised' : 'kept_original',
            missingCoverageFiles: missingCoverageFiles.map((summary) => summary.file),
          });
        }

        const deterministicCompletion = buildDirectReasoningSynthesisCoverageCompletion({
          content: synthesisContent,
          evidence,
          input: input.input,
        });
        if (deterministicCompletion) {
          synthesisContent = `${synthesisContent.trim()}\n\n${deterministicCompletion.content}`;
          recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_synthesis_coverage_revision', {
            route: input.input.gateway?.decision.route,
            operation: input.input.gateway?.decision.operation,
            phase: 'deterministic_completion',
            resultStatus: 'appended',
            missingCoverageFiles: deterministicCompletion.files,
            coverageFileCount: deterministicCompletion.coverageFileCount,
          });
        }

        finalContent = synthesisContent;
        timedOut = false;
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
        if (!finalResponse) {
          timedOut = true;
        }
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
        ...(input.input.returnExecutionGraphArtifacts
          ? { executionGraphArtifacts: artifactState.artifacts.map(cloneExecutionArtifact) }
          : {}),
        synthesized,
      }
    : null;
}

function recordDirectReasoningLlmCall(
  input: {
    input: DirectReasoningInput;
    deps: DirectReasoningDependencies;
    graphEmitter?: DirectReasoningGraphEmitter | null;
  },
  phase: 'started' | 'completed',
  details: Record<string, unknown>,
): void {
  const stage: IntentRoutingTraceEntry['stage'] = phase === 'started'
    ? 'direct_reasoning_llm_call_started'
    : 'direct_reasoning_llm_call_completed';
  const decision = input.input.gateway?.decision;
  recordDirectReasoningTrace(input.deps, input.input, stage, {
    route: decision?.route,
    operation: decision?.operation,
    ...details,
  });
  const eventKind: ExecutionGraphEventKind = phase === 'started'
    ? 'llm_call_started'
    : 'llm_call_completed';
  const turn = stringValue(details.turn) || String(details.turn ?? 'unknown');
  const attempt = stringValue(details.attempt) || String(details.attempt ?? '1');
  const callPhase = stringValue(details.phase) || 'exploration';
  input.graphEmitter?.emit(eventKind, details, `llm:${callPhase}:${turn}:attempt:${attempt}:${phase}`);
}

function summarizeDirectReasoningChatResponse(response: ChatResponse): Record<string, unknown> {
  const toolCalls = response.toolCalls ?? [];
  return {
    finishReason: response.finishReason,
    model: response.model,
    contentChars: response.content?.length ?? 0,
    toolCallCount: toolCalls.length,
    toolNames: toolCalls.map((call) => call.name).filter((name) => !!name),
  };
}

function buildDirectReasoningCompactRetryMessages(input: DirectReasoningInput): ChatMessage[] {
  const decision = input.gateway?.decision;
  const constraints = deriveAnswerConstraints(decision?.resolvedContent ?? input.message);
  const parts = [
    'You are a direct reasoning agent running inside GuardianAgent brokered execution.',
    'The previous model turn did not complete within budget. Continue with a compact read-only repository inspection.',
    'Use only fs_search, fs_list, and fs_read. Do not mutate files or run shell commands.',
    'Before answering, call at least one read-only tool and cite actual file evidence.',
    ...(constraints.requiresImplementationFiles
      ? ['Identify implementation files, not tests or generated files.']
      : []),
    ...(constraints.requiresSymbolNames
      ? ['Include exact symbol names when the evidence supports them.']
      : []),
    ...(constraints.readonly
      ? ['The user explicitly requested read-only inspection.']
      : []),
    ...(input.workspaceRoot?.trim()
      ? [`Workspace root: ${input.workspaceRoot.trim()}`]
      : []),
    ...(decision?.route || decision?.operation
      ? [`Routed intent: ${decision?.route ?? 'unknown'} / ${decision?.operation ?? 'unknown'}.`]
      : []),
  ];
  return [
    { role: 'system', content: parts.join('\n') },
    { role: 'user', content: input.message },
  ];
}

function cloneExecutionArtifact(artifact: ExecutionArtifact): ExecutionArtifact {
  return JSON.parse(JSON.stringify(artifact)) as ExecutionArtifact;
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
  const toolCallInstanceId = `turn-${input.turn}:${toolCall.id}`;

  recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_tool_call', {
    tool: toolName,
    turn: input.turn,
    phase: 'started',
    args: redactDirectReasoningToolArgs(boundedArgs),
  });
  input.graphEmitter?.emit('tool_call_started', {
    toolName,
    toolCallId: toolCall.id,
    toolCallInstanceId,
    turn: input.turn,
    argsPreview: stringifyCompact(redactDirectReasoningToolArgs(boundedArgs)),
  }, `tool:${toolCallInstanceId}:started`);

  try {
    const result = await input.deps.executeTool(toolName, boundedArgs, {
      origin: input.input.toolRequest?.origin ?? 'assistant',
      requestId: input.input.toolRequest?.requestId ?? directReasoningTraceRequestId(input.input),
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

    input.graphEmitter?.emit('tool_call_completed', {
      toolName,
      toolCallId: toolCall.id,
      toolCallInstanceId,
      turn: input.turn,
      resultStatus: typeof result.status === 'string' ? result.status : (result.success === false ? 'failed' : 'succeeded'),
      ...(typeof result.message === 'string' ? { resultMessage: result.message } : {}),
      ...(formatToolResultPreview(result) ? { resultPreview: formatToolResultPreview(result) } : {}),
    }, `tool:${toolCallInstanceId}:completed`);

    const evidenceEntry = buildDirectReasoningEvidenceEntry(toolName, boundedArgs, result);
    input.evidence?.push(evidenceEntry);
    const artifact = createDirectReasoningToolArtifact({
      state: input.artifactState,
      toolName,
      toolCallId: toolCallInstanceId,
      args: boundedArgs,
      result,
      createdAt: input.deps.now?.() ?? Date.now(),
    });
    if (artifact) {
      input.artifactState?.artifacts.push(artifact);
      input.graphEmitter?.emit('artifact_created', artifactEventPayload(artifact), `artifact:${artifact.artifactId}`);
    }
    recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_tool_call', {
      tool: toolName,
      turn: input.turn,
      phase: 'completed',
      status: result.status,
      success: result.success,
      preview: formatToolResultPreview(result),
      resultShape: summarizeDirectReasoningToolResultShape(result),
      evidenceCountAfter: input.evidence?.length ?? 0,
      artifactCreated: !!artifact,
      ...(artifact ? {
        artifactId: artifact.artifactId,
        artifactType: artifact.artifactType,
      } : {}),
      artifactCountAfter: input.artifactState?.artifacts.length ?? 0,
    });
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
      toolCallInstanceId,
      turn: input.turn,
      resultStatus: 'failed',
      errorMessage: message,
    }, `tool:${toolCallInstanceId}:completed`);
    return `Error executing ${toolName}: ${message}`;
  }
}

async function hydrateDirectReasoningEvidenceFromSearch(input: {
  input: DirectReasoningInput;
  deps: DirectReasoningDependencies;
  graphEmitter?: DirectReasoningGraphEmitter | null;
  artifactState: DirectReasoningArtifactState;
  evidence: DirectReasoningEvidenceEntry[];
  turn: number;
}): Promise<number> {
  const candidates = selectDirectReasoningAutoReadCandidates(
    input.evidence,
    DIRECT_REASONING_MAX_AUTO_EVIDENCE_READS,
  );

  if (candidates.length === 0) {
    return 0;
  }

  recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_evidence_hydration', {
    phase: 'auto_read_started',
    turn: input.turn,
    candidateCount: candidates.length,
    candidates: candidates.map((candidate) => ({
      file: candidate.file,
      score: directReasoningAutoEvidenceFileScore(candidate),
      searchCount: candidate.searchCount,
      listCount: candidate.listCount,
      referenceCount: candidate.referenceCount,
      symbolCount: candidate.symbols.size,
    })),
  });

  let hydrated = 0;
  hydrated += await hydrateDirectReasoningCandidateReads({
    ...input,
    candidates,
    idPrefix: 'auto-read',
  });

  if (hasSufficientDirectReasoningHydratedCoverage(input.evidence)) {
    recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_evidence_hydration', {
      phase: 'expansion_skipped_sufficient_coverage',
      turn: input.turn,
      hydratedCount: hydrated,
      ...summarizeDirectReasoningEvidenceCoverage(input.evidence),
    });
    recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_evidence_hydration', {
      phase: 'auto_read_completed',
      turn: input.turn,
      hydratedCount: hydrated,
    });
    return hydrated;
  }

  const issuedExpansionSearches = new Set<string>();
  for (let round = 1; round <= DIRECT_REASONING_MAX_EVIDENCE_EXPANSION_ROUNDS; round += 1) {
    const searches = selectDirectReasoningEvidenceExpansionSearches(
      input.evidence,
      issuedExpansionSearches,
      DIRECT_REASONING_MAX_EVIDENCE_EXPANSION_SEARCHES_PER_ROUND,
    );
    if (searches.length === 0) {
      break;
    }
    for (const search of searches) {
      issuedExpansionSearches.add(`${search.path}:${search.query}`);
    }
    recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_evidence_hydration', {
      phase: 'expansion_search_started',
      turn: input.turn,
      round,
      searchCount: searches.length,
      searches,
    });
    let searchCount = 0;
    for (const search of searches) {
      searchCount += 1;
      await executeDirectReasoningToolCall({
        toolCall: {
          id: `expansion-search-${round}-${searchCount}`,
          name: 'fs_search',
          arguments: JSON.stringify({
            path: search.path,
            query: search.query,
            mode: 'content',
            maxResults: DIRECT_SEARCH_DEFAULT_MAX_RESULTS,
            maxDepth: DIRECT_SEARCH_DEFAULT_MAX_DEPTH,
            maxFiles: DIRECT_SEARCH_DEFAULT_MAX_FILES,
            maxFileBytes: DIRECT_SEARCH_DEFAULT_MAX_FILE_BYTES,
          }),
        },
        input: input.input,
        deps: input.deps,
        graphEmitter: input.graphEmitter,
        artifactState: input.artifactState,
        turn: input.turn,
        evidence: input.evidence,
      });
    }
    recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_evidence_hydration', {
      phase: 'expansion_search_completed',
      turn: input.turn,
      round,
      searchCount,
    });

    const expansionCandidates = selectDirectReasoningAutoReadCandidates(
      input.evidence,
      DIRECT_REASONING_MAX_EVIDENCE_EXPANSION_READS_PER_ROUND,
    );
    if (expansionCandidates.length === 0) {
      continue;
    }
    recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_evidence_hydration', {
      phase: 'expansion_read_started',
      turn: input.turn,
      round,
      candidateCount: expansionCandidates.length,
      candidates: expansionCandidates.map((candidate) => ({
        file: candidate.file,
        score: directReasoningAutoEvidenceFileScore(candidate),
        searchCount: candidate.searchCount,
        listCount: candidate.listCount,
        referenceCount: candidate.referenceCount,
        symbolCount: candidate.symbols.size,
      })),
    });
    const roundHydrated = await hydrateDirectReasoningCandidateReads({
      ...input,
      candidates: expansionCandidates,
      idPrefix: `expansion-read-${round}`,
    });
    hydrated += roundHydrated;
    recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_evidence_hydration', {
      phase: 'expansion_read_completed',
      turn: input.turn,
      round,
      hydratedCount: roundHydrated,
    });
    if (hasSufficientDirectReasoningHydratedCoverage(input.evidence)) {
      recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_evidence_hydration', {
        phase: 'expansion_stopped_sufficient_coverage',
        turn: input.turn,
        round,
        hydratedCount: hydrated,
        ...summarizeDirectReasoningEvidenceCoverage(input.evidence),
      });
      break;
    }
  }

  recordDirectReasoningTrace(input.deps, input.input, 'direct_reasoning_evidence_hydration', {
    phase: 'auto_read_completed',
    turn: input.turn,
    hydratedCount: hydrated,
  });
  return hydrated;
}

async function hydrateDirectReasoningCandidateReads(input: {
  input: DirectReasoningInput;
  deps: DirectReasoningDependencies;
  graphEmitter?: DirectReasoningGraphEmitter | null;
  artifactState: DirectReasoningArtifactState;
  evidence: DirectReasoningEvidenceEntry[];
  turn: number;
  candidates: DirectReasoningFileSummary[];
  idPrefix: string;
}): Promise<number> {
  let hydrated = 0;
  for (const candidate of input.candidates) {
    await executeDirectReasoningToolCall({
      toolCall: {
        id: `${input.idPrefix}-${hydrated + 1}`,
        name: 'fs_read',
        arguments: JSON.stringify({
          path: candidate.file,
          maxBytes: DIRECT_READ_DEFAULT_MAX_BYTES,
        }),
      },
      input: input.input,
      deps: input.deps,
      graphEmitter: input.graphEmitter,
      artifactState: input.artifactState,
      turn: input.turn,
      evidence: input.evidence,
    });
    hydrated += 1;
  }
  return hydrated;
}

function selectDirectReasoningAutoReadCandidates(
  evidence: DirectReasoningEvidenceEntry[],
  limit: number,
): DirectReasoningFileSummary[] {
  const candidates = collectDirectReasoningFileSummaries(evidence)
    .filter((summary) => (summary.searchCount > 0 || summary.listCount > 0) && summary.readCount === 0)
    .filter((summary) => isLikelyImplementationFile(summary.file));
  const primaryCandidates = candidates.filter((summary) => (
    summary.file.startsWith('src/')
    || summary.file.startsWith('web/')
    || summary.file.startsWith('native/')
  ));
  const selected = primaryCandidates.length > 0 ? primaryCandidates : candidates;
  const nonRoutingSelected = selected.filter((summary) => !summary.file.startsWith('src/runtime/intent/'));
  const sortable = nonRoutingSelected.length > 0 ? nonRoutingSelected : selected;
  return sortable
    .sort((left, right) => (
      directReasoningAutoEvidenceFileScore(right) - directReasoningAutoEvidenceFileScore(left)
      || left.firstSeen - right.firstSeen
      || left.file.localeCompare(right.file)
    ))
    .slice(0, Math.max(1, limit));
}

function selectDirectReasoningEvidenceExpansionSearches(
  evidence: DirectReasoningEvidenceEntry[],
  issuedSearches: Set<string>,
  limit: number,
): Array<{ path: string; query: string }> {
  const queryScores = new Map<string, { path: string; query: string; score: number; firstSeen: number }>();
  let firstSeen = 0;
  for (const entry of evidence) {
    if (entry.toolName !== 'fs_read') {
      continue;
    }
    const file = normalizeRepoFileReference(entry.references[0] ?? '');
    if (!file || !isLikelyImplementationFile(file)) {
      continue;
    }
    if (!shouldExpandDirectReasoningEvidenceFromFile(file)) {
      continue;
    }
    const path = directReasoningExpansionSearchRoot(file);
    for (const query of entry.expansionQueries) {
      const normalizedQuery = normalizeDirectReasoningExpansionQuery(query);
      if (!normalizedQuery) {
        continue;
      }
      const key = `${path}:${normalizedQuery}`;
      if (issuedSearches.has(key)) {
        continue;
      }
      const score = directReasoningExpansionQueryScore(normalizedQuery, file);
      if (score <= 0) {
        continue;
      }
      const existing = queryScores.get(key);
      if (existing) {
        existing.score += score;
      } else {
        queryScores.set(key, {
          path,
          query: normalizedQuery,
          score,
          firstSeen,
        });
        firstSeen += 1;
      }
    }
  }
  return [...queryScores.values()]
    .sort((left, right) => (
      right.score - left.score
      || left.firstSeen - right.firstSeen
      || left.query.localeCompare(right.query)
    ))
    .slice(0, Math.max(1, limit))
    .map(({ path, query }) => ({ path, query }));
}

function hasSufficientDirectReasoningHydratedCoverage(evidence: DirectReasoningEvidenceEntry[]): boolean {
  const summaries = selectDirectReasoningAnswerCoverageSummaries(
    evidence,
    MAX_DIRECT_REASONING_SYNTHESIS_COVERAGE_FILES,
  );
  const readPrimary = summaries.filter((summary) => summary.readCount > 0);
  const readWebComponents = readPrimary.filter((summary) => summary.file.startsWith('web/public/js/components/'));
  const readWebPages = readPrimary.filter((summary) => summary.file.startsWith('web/public/js/pages/'));
  if (readWebComponents.length > 0 && readWebPages.length < 3) {
    return false;
  }
  return readPrimary.length >= 6;
}

function shouldExpandDirectReasoningEvidenceFromFile(file: string): boolean {
  return file.startsWith('web/public/js/pages/')
    || file.startsWith('web/public/js/components/')
    || file === 'web/public/js/chat-panel.js'
    || file === 'web/public/js/chat-run-tracking.js'
    || file === 'src/runtime/run-timeline.ts'
    || file.startsWith('src/runtime/execution-graph/');
}

function directReasoningExpansionSearchRoot(file: string): string {
  const root = file.split('/')[0];
  if (root === 'web' || root === 'src' || root === 'native' || root === 'scripts') {
    return root;
  }
  return '.';
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
  evidence?: DirectReasoningEvidenceEntry[];
}): ChatMessage[] {
  const messages = buildGroundedSynthesisMessages({
    request: input.input.message,
    decision: input.input.gateway?.decision ?? null,
    workspaceRoot: input.input.workspaceRoot,
    completedToolCalls: input.toolCallCount,
    sourceArtifacts: input.artifacts ?? [],
    ledgerArtifact: input.ledgerArtifact ?? null,
    maxEvidenceChars: MAX_SYNTHESIS_EVIDENCE_CHARS,
    purpose: 'final_answer',
  });
  const coverage = buildDirectReasoningEvidenceCoveragePrompt(input.evidence ?? []);
  if (!coverage || messages.length === 0) {
    return messages;
  }
  const last = messages[messages.length - 1];
  const exactFileInstructions = directReasoningRequiresImplementationFileCoverage(input.input)
    ? [
        'Exact-file answer requirements:',
        '- Include only files that directly implement the requested behavior or a required projection/rendering/data-contract layer for it.',
        '- When the request asks for pages, consumers, importers, or users of a file/module, include directly evidenced consumer files and omit the target file unless it also directly matches the requested role.',
        '- Omit files that merely mention the terms, tests, examples, generic shared utilities, intent routing, provider configuration, or unrelated page imports.',
        '- Do not include a "not relevant", "tangential", or "excluded" section; irrelevant files should be absent from the final answer.',
        '',
      ].join('\n')
    : '';
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      content: `${last.content}\n\n${exactFileInstructions}${coverage}`,
    },
  ];
}

function buildDirectReasoningSynthesisRevisionMessages(input: {
  input: DirectReasoningInput;
  draft: string;
  evidence: DirectReasoningEvidenceEntry[];
  missingCoverageFiles: DirectReasoningFileSummary[];
}): ChatMessage[] {
  const coverage = buildDirectReasoningEvidenceCoveragePrompt(input.evidence) ?? 'No compact evidence coverage was available.';
  const missing = input.missingCoverageFiles
    .slice(0, MAX_DIRECT_REASONING_SYNTHESIS_COVERAGE_FILES)
    .map((summary) => `- ${summary.file}`)
    .join('\n');
  return [
    {
      role: 'system',
      content: [
        'You are GuardianAgent grounded-synthesis coverage review.',
        'No tools are available. Use only the supplied draft and deterministic evidence coverage.',
        'Revise the answer to account for high-confidence implementation evidence without inventing facts.',
        'Do not mechanically list unrelated files; if evidence shows a file is only supporting/plumbing, omit it.',
        'Do not include a "not relevant", "tangential", or "excluded" section.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Original request:',
        input.input.message,
        '',
        'Draft answer:',
        input.draft,
        '',
        'Coverage files omitted by the draft:',
        missing || '- none',
        '',
        coverage,
        '',
        'Return the revised final answer. Keep it concise, grounded in the evidence, and include exact file paths for relevant implementation files.',
      ].join('\n'),
    },
  ];
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
      expansionQueries: [],
    };
  }

  if (toolName === 'fs_search' && Array.isArray(output.matches)) {
    const matches = output.matches as Array<Record<string, unknown>>;
    const references = matches
      .map((match) => normalizeSearchMatchReference(match, args))
      .filter((value): value is string => value.length > 0);
    const snippets = matches
      .slice(0, 20)
      .map((match) => {
        const reference = normalizeSearchMatchReference(match, args) || 'unknown';
        const snippet = compactLine(stringValue(match.snippet));
        return snippet ? `${reference}: ${snippet}` : reference;
      });
    return {
      ...base,
      summary: `Search "${stringValue(output.query) || stringValue(args.query)}" returned ${matches.length} matches${output.truncated ? ' (truncated)' : ''}.`,
      references,
      snippets,
      expansionQueries: [],
    };
  }

  if (toolName === 'fs_read' && typeof output.content === 'string') {
    const path = stringValue(output.path) || stringValue(args.path) || 'unknown';
    return {
      ...base,
      summary: `Read ${path} (${stringifyCompact(output.bytes ?? output.content.length)} bytes${output.truncated ? ', truncated' : ''}).`,
      references: [path],
      snippets: extractFileEvidenceSnippets(path, output.content),
      expansionQueries: extractDirectReasoningReadExpansionQueries(path, output.content),
    };
  }

  if (toolName === 'fs_list' && Array.isArray(output.entries)) {
    const directory = stringValue(output.path) || stringValue(args.path) || 'unknown';
    const snippets = output.entries.slice(0, 40).map((entry) => {
      if (typeof entry === 'string') {
        return normalizeDirectReasoningListEntry(directory, entry);
      }
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
      expansionQueries: [],
    };
  }

  return {
    ...base,
    summary: truncateText(stringifyCompact(output), 500),
    references: [],
    snippets: [truncateText(stringifyCompact(output), 800)],
    expansionQueries: [],
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
    const matches = normalizeSearchMatches(output.matches as Array<Record<string, unknown>>, input.args);
    return buildSearchResultSetArtifact({
      graphId: input.state.context.graphId,
      nodeId: input.state.context.nodeId,
      artifactId,
      label: 'Direct reasoning search results',
      query: stringValue(output.query) || stringValue(input.args.query),
      matches,
      truncated: output.truncated === true,
      trustLevel,
      taintReasons,
      createdAt: input.createdAt,
    });
  }

  if (input.toolName === 'fs_read' && typeof output.content === 'string') {
    const readPath = normalizeRepoFileReference(stringValue(output.path))
      ?? normalizeRepoFileReference(stringValue(input.args.path))
      ?? stringValue(output.path)
      ?? stringValue(input.args.path)
      ?? 'unknown';
    return buildFileReadSetArtifact({
      graphId: input.state.context.graphId,
      nodeId: input.state.context.nodeId,
      artifactId,
      label: 'Direct reasoning file read',
      path: readPath,
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
  sourceArtifactsInput?: ExecutionArtifact[],
): ExecutionArtifact<EvidenceLedgerContent> | null {
  const sourceArtifacts = (sourceArtifactsInput ?? state.artifacts)
    .filter((artifact) => artifact.artifactType !== 'EvidenceLedger' && artifact.artifactType !== 'SynthesisDraft');
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
  const candidates: string[] = [];
  const declarationPattern = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+[A-Za-z_$][\w$]*/;
  const callPattern = /\b[A-Za-z_$][\w$.]*\s*\(/;
  for (const [index, line] of lines.entries()) {
    const trimmed = compactLine(line);
    if (!trimmed || trimmed.length < 2) continue;
    if (!declarationPattern.test(trimmed) && !isLikelyImplementationCallLine(trimmed, callPattern)) continue;
    candidates.push(`${path}:${index + 1}: ${trimmed}`);
  }

  if (candidates.length > 0) {
    for (const candidate of selectBalancedEvidenceSnippets(candidates, 32)) {
      selected.push(candidate);
    }
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

function selectBalancedEvidenceSnippets(snippets: string[], limit: number): string[] {
  if (snippets.length <= limit) {
    return snippets;
  }
  const selected: string[] = [];
  const selectedIndexes = new Set<number>();
  const add = (index: number): void => {
    const bounded = Math.max(0, Math.min(snippets.length - 1, index));
    if (!selectedIndexes.has(bounded)) {
      selectedIndexes.add(bounded);
      selected.push(snippets[bounded]);
    }
  };
  for (let index = 0; index < Math.min(8, snippets.length); index += 1) {
    add(index);
  }
  const remaining = limit - selected.length;
  if (remaining <= 0) {
    return selected;
  }
  const step = Math.max(1, Math.floor(snippets.length / remaining));
  for (let index = step; selected.length < limit && index < snippets.length; index += step) {
    add(index);
  }
  for (let index = snippets.length - 1; selected.length < limit && index >= 0; index -= 1) {
    add(index);
  }
  return selected.sort((left, right) => extractSnippetLineNumber(left) - extractSnippetLineNumber(right));
}

function extractSnippetLineNumber(snippet: string): number {
  const match = snippet.match(/:(\d+):\s/);
  return match?.[1] ? Number(match[1]) : 0;
}

function isLikelyImplementationCallLine(line: string, callPattern: RegExp): boolean {
  if (!callPattern.test(line)) {
    return false;
  }
  const firstToken = line.match(/^[\s}]*([A-Za-z_$][\w$]*)\b/)?.[1];
  return !firstToken || !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(firstToken);
}

function extractDirectReasoningReadExpansionQueries(path: string, content: string): string[] {
  const queries: string[] = [];
  const repoPath = normalizeRepoFileReference(path) ?? canonicalizeRepoReference(path);
  const basename = repoPath.split('/').pop() ?? '';
  if (basename) {
    queries.push(basename);
    const withoutExtension = basename.replace(/\.[^.]+$/, '');
    if (withoutExtension !== basename) {
      queries.push(withoutExtension);
    }
  }

  const includeImportQueries = !repoPath.startsWith('web/public/js/pages/');
  if (includeImportQueries) {
    const importPattern = /\bfrom\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const match of content.matchAll(importPattern)) {
      const source = match[1] ?? match[2] ?? match[3] ?? '';
      for (const query of directReasoningQueriesFromModuleSource(source)) {
        queries.push(query);
      }
    }
  }

  const exportSymbolPattern = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(exportSymbolPattern)) {
    if (match[1]) {
      queries.push(match[1]);
    }
  }

  const stringLiteralPattern = /['"`]([^'"`\r\n]{4,120})['"`]/g;
  for (const match of content.matchAll(stringLiteralPattern)) {
    const literal = match[1]?.trim() ?? '';
    for (const query of directReasoningQueriesFromStringLiteral(literal)) {
      queries.push(query);
    }
  }

  return uniqueStrings(queries)
    .map(normalizeDirectReasoningExpansionQuery)
    .filter((query): query is string => !!query)
    .slice(0, 80);
}

function directReasoningQueriesFromModuleSource(source: string): string[] {
  const normalized = source.trim().replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('node:')) {
    return [];
  }
  const basename = normalized.split('/').pop() ?? normalized;
  const queries = [basename];
  const withoutExtension = basename.replace(/\.[^.]+$/, '');
  if (withoutExtension !== basename) {
    queries.push(withoutExtension);
  }
  return queries;
}

function directReasoningQueriesFromStringLiteral(literal: string): string[] {
  const normalized = literal.trim().replace(/\\/g, '/');
  if (!normalized || normalized.length > 120) {
    return [];
  }
  if (/^https?:\/\//i.test(normalized)) {
    return [];
  }
  const hasCodeShape = /[./-]/.test(normalized)
    || /^[A-Za-z_$][\w$]{6,}$/.test(normalized);
  if (!hasCodeShape) {
    return [];
  }
  const basename = normalized.split('/').pop() ?? normalized;
  const queries = [basename];
  if (basename !== normalized && basename.length >= 4) {
    queries.push(normalized);
  }
  const withoutExtension = basename.replace(/\.[^.]+$/, '');
  if (withoutExtension !== basename) {
    queries.push(withoutExtension);
  }
  return queries;
}

function normalizeDirectReasoningExpansionQuery(query: string): string | null {
  const normalized = query.trim().replace(/\\/g, '/').replace(/^['"`]+|['"`]+$/g, '');
  if (normalized.length < 4 || normalized.length > 120) {
    return null;
  }
  if (normalized.includes('\n') || normalized.includes('\r')) {
    return null;
  }
  if (/^\d+$/.test(normalized)) {
    return null;
  }
  if (/^(true|false|null|undefined|return|import|export|function|const|let|var)$/i.test(normalized)) {
    return null;
  }
  return normalized;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function directReasoningExpansionQueryScore(query: string, sourceFile: string): number {
  let score = 10;
  const basename = sourceFile.split('/').pop() ?? '';
  const withoutExtension = basename.replace(/\.[^.]+$/, '');
  if (query === basename) score += 90;
  if (query === withoutExtension) score += 70;
  if (query.endsWith('.js') || query.endsWith('.ts') || query.endsWith('.tsx')) score += 60;
  if (query.includes('.')) score += 55;
  if (query.includes('-')) score += 45;
  if (/^[A-Z_$]/.test(query)) score += 40;
  if (/^(render|normalize|build|bind|update|summarize|select|get|map|project)[A-Z_]/.test(query)) score += 35;
  if (query.includes('/')) score -= 20;
  if (query.length > 80) score -= 50;
  return score;
}

function buildDirectReasoningEvidenceFallbackAnswer(evidence: DirectReasoningEvidenceEntry[]): string | null {
  const summaries = collectDirectReasoningFileSummaries(evidence)
    .sort((left, right) => (
      directReasoningFallbackFileScore(right) - directReasoningFallbackFileScore(left)
      || left.firstSeen - right.firstSeen
      || left.file.localeCompare(right.file)
    ));

  if (summaries.length === 0) {
    return null;
  }

  const implementationSummaries = summaries.filter((summary) => (
    isLikelyImplementationFile(summary.file) && hasDirectReasoningStrongFileEvidence(summary)
  ));
  const selected = implementationSummaries.length > 0 ? implementationSummaries : summaries;
  const lines = [
    implementationSummaries.length > 0
      ? 'Relevant implementation evidence found from brokered read-only tools:'
      : 'Relevant repository evidence found from brokered read-only tools:',
    '',
  ];
  for (const summary of selected.slice(0, 8)) {
    const symbolList = selectDirectReasoningDisplaySymbols(summary, 8);
    const evidenceKinds = [
      summary.readCount > 0 ? 'read' : '',
      summary.searchCount > 0 ? 'search' : '',
      summary.listCount > 0 ? 'list' : '',
    ].filter(Boolean).join('+') || 'reference';
    lines.push(symbolList.length > 0
      ? `- \`${summary.file}\` (${evidenceKinds}): ${symbolList.map((symbol) => `\`${symbol}\``).join(', ')}`
      : `- \`${summary.file}\` (${evidenceKinds})`);
  }
  return lines.join('\n');
}

function collectDirectReasoningFileSummaries(evidence: DirectReasoningEvidenceEntry[]): DirectReasoningFileSummary[] {
  const fileSummaries = new Map<string, DirectReasoningFileSummary>();
  let seenIndex = 0;
  const ensureSummary = (file: string): DirectReasoningFileSummary => {
    let summary = fileSummaries.get(file);
    if (!summary) {
      summary = {
        file,
        firstSeen: seenIndex,
        referenceCount: 0,
        snippetCount: 0,
        readCount: 0,
        searchCount: 0,
        listCount: 0,
        symbols: new Set<string>(),
        declaredSymbols: new Set<string>(),
      };
      fileSummaries.set(file, summary);
      seenIndex += 1;
    }
    return summary;
  };

  for (const entry of evidence) {
    const isReadEvidence = entry.toolName === 'fs_read';
    const isSearchEvidence = entry.toolName === 'fs_search';
    const isListEvidence = entry.toolName === 'fs_list';
    for (const reference of entry.references) {
      const file = normalizeRepoFileReference(reference);
      if (!file) continue;
      const summary = ensureSummary(file);
      summary.referenceCount += 1;
      if (isReadEvidence) summary.readCount += 1;
      if (isSearchEvidence) summary.searchCount += 1;
      if (isListEvidence) summary.listCount += 1;
    }
    for (const snippet of entry.snippets) {
      const file = extractFilePathFromSnippet(snippet);
      if (!file) continue;
      const summary = ensureSummary(file);
      if (isListEvidence) {
        summary.listCount += 1;
        continue;
      }
      summary.snippetCount += 1;
      for (const symbol of extractDeclaredSymbolNames(snippet)) {
        summary.declaredSymbols.add(symbol);
      }
      for (const symbol of extractSymbolNames(snippet)) {
        summary.symbols.add(symbol);
      }
    }
  }

  return [...fileSummaries.values()];
}

function selectDirectReasoningCoverageSummaries(
  evidence: DirectReasoningEvidenceEntry[],
  limit = MAX_DIRECT_REASONING_SYNTHESIS_COVERAGE_FILES,
): DirectReasoningFileSummary[] {
  const summaries = collectDirectReasoningFileSummaries(evidence)
    .filter((summary) => isLikelyImplementationFile(summary.file) && hasDirectReasoningStrongFileEvidence(summary));
  const primarySourceSummaries = summaries.filter((summary) => (
    summary.file.startsWith('src/')
    || summary.file.startsWith('web/')
    || summary.file.startsWith('native/')
  ));
  const selected = primarySourceSummaries.length > 0 ? primarySourceSummaries : summaries;
  return selected
    .sort((left, right) => (
      directReasoningFallbackFileScore(right) - directReasoningFallbackFileScore(left)
      || left.firstSeen - right.firstSeen
      || left.file.localeCompare(right.file)
    ))
    .slice(0, Math.max(1, limit));
}

function buildDirectReasoningEvidenceCoveragePrompt(evidence: DirectReasoningEvidenceEntry[]): string | null {
  const summaries = selectDirectReasoningCoverageSummaries(evidence);
  if (summaries.length === 0) {
    return null;
  }
  const lines = [
    'Deterministic evidence coverage:',
    'The following implementation files were extracted from typed read/search/list evidence. Account for these files during synthesis so directly evidenced implementation paths are not silently dropped; include only files that are relevant to the original request.',
    '',
  ];
  for (const summary of summaries) {
    const symbols = selectDirectReasoningDisplaySymbols(summary, 8);
    const evidenceParts = [
      `read=${summary.readCount}`,
      `search=${summary.searchCount}`,
      `list=${summary.listCount}`,
      `refs=${summary.referenceCount}`,
      `snippets=${summary.snippetCount}`,
    ];
    lines.push(symbols.length > 0
      ? `- ${summary.file}: ${evidenceParts.join(', ')}; symbols=${symbols.join(', ')}`
      : `- ${summary.file}: ${evidenceParts.join(', ')}`);
  }
  return lines.join('\n');
}

function findMissingDirectReasoningSynthesisCoverageFiles(input: {
  content: string;
  evidence: DirectReasoningEvidenceEntry[];
  input: DirectReasoningInput;
}): DirectReasoningFileSummary[] {
  if (!directReasoningRequiresImplementationFileCoverage(input.input)) {
    return [];
  }
  const summaries = selectDirectReasoningAnswerCoverageSummaries(
    input.evidence,
    MAX_DIRECT_REASONING_SYNTHESIS_COVERAGE_FILES,
    input.input,
  );
  if (summaries.length < directReasoningSynthesisCoverageMinFiles(input.input)) {
    return [];
  }
  const missing = summaries.filter((summary) => !directReasoningAnswerMentionsFile(input.content, summary.file));
  if (missing.length < DIRECT_REASONING_SYNTHESIS_REVISION_MIN_MISSING_FILES) {
    return [];
  }
  const includedCount = summaries.length - missing.length;
  if (includedCount >= Math.ceil(summaries.length * 0.7)) {
    return [];
  }
  return missing.slice(0, MAX_DIRECT_REASONING_SYNTHESIS_COVERAGE_FILES);
}

function buildDirectReasoningSynthesisCoverageCompletion(input: {
  content: string;
  evidence: DirectReasoningEvidenceEntry[];
  input: DirectReasoningInput;
}): { content: string; files: string[]; coverageFileCount: number } | null {
  if (!directReasoningRequiresImplementationFileCoverage(input.input)) {
    return null;
  }
  const summaries = selectDirectReasoningAnswerCoverageSummaries(
    input.evidence,
    MAX_DIRECT_REASONING_SYNTHESIS_COMPLETION_FILES,
    input.input,
  );
  if (summaries.length < directReasoningSynthesisCoverageMinFiles(input.input)) {
    return null;
  }
  const missing = summaries
    .filter((summary) => !directReasoningAnswerMentionsFile(input.content, summary.file))
    .slice(0, MAX_DIRECT_REASONING_SYNTHESIS_COMPLETION_FILES);
  if (missing.length === 0) {
    return null;
  }
  const lines = [
    'Additional directly evidenced implementation files:',
    '',
  ];
  for (const summary of missing) {
    const symbols = selectDirectReasoningDisplaySymbols(summary, 8);
    lines.push(symbols.length > 0
      ? `- \`${summary.file}\`: ${symbols.map((symbol) => `\`${symbol}\``).join(', ')}`
      : `- \`${summary.file}\``);
  }
  return {
    content: lines.join('\n'),
    files: missing.map((summary) => summary.file),
    coverageFileCount: summaries.length,
  };
}

function directReasoningRequiresImplementationFileCoverage(input: DirectReasoningInput): boolean {
  const decision = input.gateway?.decision;
  const decisionConstraints = deriveAnswerConstraints(decision?.resolvedContent);
  const messageConstraints = deriveAnswerConstraints(input.message);
  return decision?.requireExactFileReferences === true
    || decisionConstraints.requiresImplementationFiles === true
    || messageConstraints.requiresImplementationFiles === true;
}

function selectDirectReasoningAnswerCoverageSummaries(
  evidence: DirectReasoningEvidenceEntry[],
  limit = MAX_DIRECT_REASONING_SYNTHESIS_COMPLETION_FILES,
  input?: DirectReasoningInput,
): DirectReasoningFileSummary[] {
  const summaries = collectDirectReasoningFileSummaries(evidence)
    .filter((summary) => isLikelyImplementationFile(summary.file) && hasDirectReasoningStrongFileEvidence(summary));
  const readSummaries = summaries.filter((summary) => summary.readCount > 0);
  const minCoverageFiles = input ? directReasoningSynthesisCoverageMinFiles(input) : DIRECT_REASONING_SYNTHESIS_REVISION_MIN_FILES;
  const candidates = readSummaries.length >= minCoverageFiles
    ? readSummaries
    : summaries;
  const scopedCandidates = filterDirectReasoningAnswerCoverageScope(candidates, input);
  const scopedPrimaryCandidates = scopedCandidates.filter(isDirectReasoningPrimaryAnswerCoverageFile);
  const primaryCandidates = candidates.filter(isDirectReasoningPrimaryAnswerCoverageFile);
  let selected = candidates;
  if (primaryCandidates.length >= minCoverageFiles) {
    selected = primaryCandidates;
  }
  if (scopedCandidates.length >= minCoverageFiles) {
    selected = scopedCandidates;
  }
  if (scopedPrimaryCandidates.length >= minCoverageFiles) {
    selected = scopedPrimaryCandidates;
  }
  return selected
    .sort((left, right) => (
      directReasoningAnswerCoverageFileScore(right) - directReasoningAnswerCoverageFileScore(left)
      || left.firstSeen - right.firstSeen
      || left.file.localeCompare(right.file)
    ))
    .slice(0, Math.max(1, limit));
}

function filterDirectReasoningAnswerCoverageScope(
  candidates: DirectReasoningFileSummary[],
  input: DirectReasoningInput | undefined,
): DirectReasoningFileSummary[] {
  if (!input || directReasoningCoverageScope(input) !== 'web_pages') {
    return candidates;
  }
  const pageCandidates = candidates.filter((summary) => summary.file.startsWith('web/public/js/pages/'));
  return pageCandidates.length > 0 ? pageCandidates : candidates;
}

function directReasoningSynthesisCoverageMinFiles(input: DirectReasoningInput): number {
  return directReasoningCoverageScope(input) === 'web_pages'
    ? 2
    : DIRECT_REASONING_SYNTHESIS_REVISION_MIN_FILES;
}

function directReasoningCoverageScope(input: DirectReasoningInput): DirectReasoningCoverageScope {
  const normalized = normalizeIntentGatewayRepairText([
    input.message,
    input.gateway?.decision.resolvedContent,
  ].filter(Boolean).join('\n'));
  if (/\bweb\s+pages?\b/.test(normalized) || /\bweb\/public\/js\/pages\//.test(normalized)) {
    return 'web_pages';
  }
  return 'default';
}

function isDirectReasoningPrimaryAnswerCoverageFile(summary: DirectReasoningFileSummary): boolean {
  const file = summary.file;
  return file.startsWith('web/public/js/pages/')
    || file.startsWith('web/public/js/components/')
    || file === 'web/public/js/chat-panel.js'
    || file === 'web/public/js/chat-run-tracking.js'
    || /^src\/runtime\/[^/]+\.[cm]?tsx?$/i.test(file)
    || file.startsWith('src/runtime/execution-graph/')
    || file.startsWith('src/runtime/control-plane/')
    || file.startsWith('src/channels/web-');
}

function directReasoningAnswerCoverageFileScore(summary: DirectReasoningFileSummary): number {
  let score = directReasoningFallbackFileScore(summary);
  if (summary.readCount > 0) score += 220;
  if (summary.searchCount > 0) score += 120;
  if (summary.readCount > 0 && summary.searchCount > 0) score += 200;
  if (summary.file.startsWith('web/public/js/pages/')) score += 360;
  if (summary.file.startsWith('web/public/js/components/')) score += 320;
  if (summary.file === 'web/public/js/chat-panel.js') score += 280;
  if (summary.file === 'web/public/js/chat-run-tracking.js') score += 260;
  if (summary.file.startsWith('src/runtime/execution-graph/')) score += 220;
  if (/^src\/runtime\/[^/]+\.[cm]?tsx?$/i.test(summary.file)) score += 180;
  if (summary.file.startsWith('src/runtime/control-plane/')) score += 120;
  if (summary.file.startsWith('src/channels/web-')) score += 100;
  return score;
}

function directReasoningAnswerMentionsFile(content: string, file: string): boolean {
  const normalizedContent = content.replace(/\\/g, '/').toLowerCase();
  const normalizedFile = file.replace(/\\/g, '/').toLowerCase();
  return normalizedContent.includes(normalizedFile);
}

function selectDirectReasoningDisplaySymbols(
  summary: DirectReasoningFileSummary,
  limit: number,
): string[] {
  const declaredSymbols = [...summary.declaredSymbols];
  const candidates = declaredSymbols.length > 0
    ? declaredSymbols
    : [...summary.symbols].filter(isLikelyUsefulDirectReasoningDisplaySymbol);
  return uniqueStrings(candidates).slice(0, Math.max(0, limit));
}

function isLikelyUsefulDirectReasoningDisplaySymbol(symbol: string): boolean {
  if (!symbol || symbol.length < 3) return false;
  if (/^(push|pop|shift|unshift|map|filter|reduce|forEach|some|every|find|includes|join|split|slice|trim|replace|match|test|sort)$/i.test(symbol)) {
    return false;
  }
  if (/^(getElementById|querySelector|querySelectorAll|addEventListener|removeEventListener|appendChild|setAttribute|classList)$/i.test(symbol)) {
    return false;
  }
  if (/^(content|layout|input|button|status|error|result|value|detail|title|event|data)$/i.test(symbol)) {
    return false;
  }
  return /^[A-Z_$]/.test(symbol)
    || /^(render|normalize|build|bind|update|summarize|select|get|map|project|emit|consume|handle|create|record|resolve|attach|dispatch|ingest)[A-Z_]/.test(symbol);
}

function hasDirectReasoningStrongFileEvidence(summary: DirectReasoningFileSummary): boolean {
  return summary.readCount > 0
    || summary.searchCount > 0
    || summary.snippetCount > 0
    || summary.symbols.size > 0;
}

function shouldReserveDirectReasoningForSynthesis(
  evidence: DirectReasoningEvidenceEntry[],
  turns: number,
): boolean {
  if (turns < DIRECT_REASONING_MIN_SYNTHESIS_RESERVE_TURNS) {
    return false;
  }
  const coverage = summarizeDirectReasoningEvidenceCoverage(evidence);
  return coverage.readImplementationFileCount >= DIRECT_REASONING_MIN_SYNTHESIS_READ_FILES
    && coverage.implementationCandidateFileCount >= DIRECT_REASONING_MIN_SYNTHESIS_CANDIDATE_FILES;
}

function summarizeDirectReasoningEvidenceCoverage(evidence: DirectReasoningEvidenceEntry[]): {
  implementationCandidateFileCount: number;
  readImplementationFileCount: number;
  searchedImplementationFileCount: number;
} {
  const implementationSummaries = collectDirectReasoningFileSummaries(evidence)
    .filter((summary) => isLikelyImplementationFile(summary.file) && hasDirectReasoningStrongFileEvidence(summary));
  return {
    implementationCandidateFileCount: implementationSummaries.length,
    readImplementationFileCount: implementationSummaries.filter((summary) => summary.readCount > 0).length,
    searchedImplementationFileCount: implementationSummaries.filter((summary) => summary.searchCount > 0).length,
  };
}

function selectDirectReasoningSynthesisArtifacts(
  artifacts: ExecutionArtifact[],
  evidence: DirectReasoningEvidenceEntry[],
): ExecutionArtifact[] {
  const coverageSummaries = selectDirectReasoningCoverageSummaries(
    evidence,
    MAX_DIRECT_REASONING_SYNTHESIS_COVERAGE_FILES,
  );
  const summaryScores = new Map(coverageSummaries
    .map((summary) => [summary.file, directReasoningFallbackFileScore(summary)]));
  const candidates = artifacts
    .filter((artifact) => artifact.artifactType !== 'EvidenceLedger' && artifact.artifactType !== 'SynthesisDraft')
    .map((artifact, index) => ({
      artifact,
      index,
      coverageFiles: directReasoningArtifactCoverageFiles(artifact, summaryScores),
      score: directReasoningSynthesisArtifactScore(artifact, summaryScores),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || left.index - right.index
      || left.artifact.artifactId.localeCompare(right.artifact.artifactId)
    ));

  const selected: typeof candidates = [];
  const coveredFiles = new Set<string>();
  for (const candidate of candidates) {
    if (selected.length >= MAX_DIRECT_REASONING_SYNTHESIS_ARTIFACTS) break;
    if (candidate.coverageFiles.some((file) => !coveredFiles.has(file))) {
      selected.push(candidate);
      for (const file of candidate.coverageFiles) {
        coveredFiles.add(file);
      }
    }
  }
  for (const candidate of candidates) {
    if (selected.length >= MAX_DIRECT_REASONING_SYNTHESIS_ARTIFACTS) break;
    if (!selected.some((entry) => entry.artifact.artifactId === candidate.artifact.artifactId)) {
      selected.push(candidate);
    }
  }
  return selected.map((entry) => entry.artifact);
}

function directReasoningSynthesisArtifactScore(
  artifact: ExecutionArtifact,
  summaryScores: Map<string, number>,
): number {
  const coverageFiles = directReasoningArtifactCoverageFiles(artifact, summaryScores);
  const refScore = coverageFiles.reduce((score, ref) => Math.max(score, summaryScores.get(ref) ?? 0), 0);
  if (refScore <= 0) {
    return 0;
  }
  const typeScore = artifact.artifactType === 'FileReadSet'
    ? 1_000
    : artifact.artifactType === 'SearchResultSet'
      ? 60
      : 0;
  return refScore + typeScore + Math.min(160, coverageFiles.length * 16);
}

function directReasoningArtifactCoverageFiles(
  artifact: ExecutionArtifact,
  summaryScores: Map<string, number>,
): string[] {
  return [...new Set(artifact.refs
    .map((ref) => normalizeRepoFileReference(ref) ?? canonicalizeRepoReference(ref))
    .filter((ref) => summaryScores.has(ref)))];
}

function directReasoningFallbackFileScore(summary: DirectReasoningFileSummary): number {
  let score = 0;
  const hasStrongEvidence = hasDirectReasoningStrongFileEvidence(summary);
  if (isLikelyImplementationFile(summary.file) && hasStrongEvidence) {
    score += 260;
  } else if (!isLikelyTestFile(summary.file)) {
    score += 80;
  }
  if (summary.file.startsWith('src/') || summary.file.startsWith('web/') || summary.file.startsWith('native/')) score += 50;
  if (summary.file.startsWith('web/public/js/')) score += 30;
  score += Math.min(600, summary.readCount * 120);
  score += Math.min(200, summary.searchCount * 20);
  score += Math.min(200, summary.snippetCount * 12);
  score += Math.min(160, summary.symbols.size * 10);
  score += Math.min(120, summary.referenceCount * 6);
  score += Math.min(40, summary.listCount * 4);
  return score;
}

function directReasoningAutoEvidenceFileScore(summary: DirectReasoningFileSummary): number {
  let score = directReasoningFallbackFileScore(summary);
  if (summary.searchCount > 0) score += 80;
  if (summary.listCount > 0 && summary.searchCount === 0) score += 15;
  if (summary.readCount === 0) score += 10;
  if (summary.file.startsWith('web/public/js/')) score += 120;
  if (summary.file.startsWith('web/public/js/pages/')) score += 180;
  if (summary.file.startsWith('web/public/js/components/')) score += 160;
  if (/^web\/public\/js\/[^/]+\.[cm]?js$/i.test(summary.file)) score += 140;
  if (summary.file.startsWith('src/runtime/execution-graph/')) score += 80;
  if (summary.file.startsWith('src/runtime/intent/')) score -= 180;
  if (summary.file.startsWith('scripts/')) score -= 220;
  return score;
}

function isLikelyTestFile(file: string): boolean {
  return file.includes('/__tests__/')
    || file.includes('/test/')
    || file.includes('/tests/')
    || file.includes('.test.')
    || file.includes('.spec.');
}

function isLikelyImplementationFile(file: string): boolean {
  if (isLikelyTestFile(file)) {
    return false;
  }
  if (file.startsWith('docs/')) {
    return false;
  }
  return /\.(?:[cm]?[jt]sx?|css|html|svelte|vue|rs|go|py|java|cs|cpp|c|h|hpp|swift|kt|rb|php)$/i.test(file);
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
      const rel = normalizeSearchMatchReference(match, args) || 'unknown';
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

function summarizeDirectReasoningToolResultShape(result: Record<string, unknown>): Record<string, unknown> {
  const output = recordValue(result.output);
  const nestedOutput = output ? recordValue(output.output) : null;
  return {
    resultKeys: Object.keys(result).slice(0, 12),
    outputKeys: output ? Object.keys(output).slice(0, 12) : [],
    hasNestedOutput: !!nestedOutput,
    ...(nestedOutput ? { nestedOutputKeys: Object.keys(nestedOutput).slice(0, 12) } : {}),
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeSearchMatches(
  matches: Array<Record<string, unknown>>,
  args: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return matches.map((match) => {
    const relativePath = normalizeSearchMatchReference(match, args);
    return relativePath
      ? { ...match, relativePath }
      : match;
  });
}

function normalizeSearchMatchReference(
  match: Record<string, unknown>,
  args: Record<string, unknown>,
): string {
  const raw = stringValue(match.relativePath) || stringValue(match.path);
  const normalized = raw.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '');
  if (!normalized) return '';
  const repoFile = normalizeRepoFileReference(normalized);
  if (repoFile) return repoFile;
  if (isAbsoluteFilesystemPath(raw)) return normalized;
  const searchRoot = normalizeRepoDirectoryReference(stringValue(args.path));
  if (!searchRoot || normalized.startsWith(`${searchRoot}/`)) {
    return normalized;
  }
  return normalizeRepoFileReference(`${searchRoot}/${normalized}`) ?? `${searchRoot}/${normalized}`;
}

function isAbsoluteFilesystemPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value.trim()) || value.trim().startsWith('/') || value.trim().startsWith('\\\\');
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
    normalized.maxResults = clampEvidenceBudgetInteger(
      normalized.maxResults,
      DIRECT_SEARCH_DEFAULT_MAX_RESULTS,
      DIRECT_SEARCH_DEFAULT_MAX_RESULTS,
      DIRECT_SEARCH_DEFAULT_MAX_RESULTS,
    );
    normalized.maxDepth = clampEvidenceBudgetInteger(
      normalized.maxDepth,
      DIRECT_SEARCH_DEFAULT_MAX_DEPTH,
      DIRECT_SEARCH_DEFAULT_MAX_DEPTH,
      DIRECT_SEARCH_DEFAULT_MAX_DEPTH,
    );
    normalized.maxFiles = clampEvidenceBudgetInteger(
      normalized.maxFiles,
      DIRECT_SEARCH_DEFAULT_MAX_FILES,
      DIRECT_SEARCH_DEFAULT_MAX_FILES,
      DIRECT_SEARCH_DEFAULT_MAX_FILES,
    );
    normalized.maxFileBytes = clampEvidenceBudgetInteger(
      normalized.maxFileBytes,
      DIRECT_SEARCH_DEFAULT_MAX_FILE_BYTES,
      DIRECT_SEARCH_DEFAULT_MAX_FILE_BYTES,
      DIRECT_SEARCH_DEFAULT_MAX_FILE_BYTES,
    );
    return normalized;
  }

  if (toolName === 'fs_read') {
    const rawPath = stringValue(normalized.path);
    const path = normalizeDirectReasoningReadReference(rawPath, input);
    if (path) normalized.path = path;
    normalized.maxBytes = clampEvidenceBudgetInteger(
      normalized.maxBytes,
      DIRECT_READ_DEFAULT_MAX_BYTES,
      DIRECT_READ_DEFAULT_MAX_BYTES,
      DIRECT_READ_DEFAULT_MAX_BYTES,
    );
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

function normalizeDirectReasoningListEntry(directory: string, entry: string): string {
  const name = entry
    .replace(/^\s*\[(?:file|dir|directory)\]\s*/i, '')
    .trim();
  return `${directory}/${name || entry.trim()}`;
}

function extractFilePathFromSnippet(snippet: string): string | null {
  return normalizeRepoFileReference(snippet);
}

function normalizeRepoFileReference(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!normalized) return null;
  const pattern = new RegExp(`(?:^|/)(${REPO_FILE_PREFIX_PATTERN}/[\\w./-]+\\.[A-Za-z0-9]+)(?=$|[:\\s)\\]},"'])`);
  const match = normalized.match(pattern);
  return match?.[1] ? canonicalizeRepoReference(match[1]) : null;
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
  return match?.[1] ? canonicalizeRepoReference(match[1]) : null;
}

function canonicalizeRepoReference(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  for (const root of CANONICAL_NON_SRC_REPO_ROOTS) {
    if (normalized === `src/${root}`) return root;
    if (normalized.startsWith(`src/${root}/`)) return normalized.slice('src/'.length);
  }
  return normalized;
}

function selectDefaultDirectReasoningSearchPath(input: DirectReasoningInput): string {
  const entityPath = normalizeRepoDirectoryReference(stringValue(input.gateway?.decision.entities.path));
  if (entityPath) return entityPath;
  return '.';
}

function normalizeDirectReasoningReadReference(rawPath: string, input: DirectReasoningInput): string | null {
  const direct = normalizeRepoFileReference(rawPath);
  if (direct) return direct;

  const defaultRoot = selectDefaultDirectReasoningSearchPath(input);
  if (defaultRoot !== '.') {
    const fromDefault = normalizeRepoFileReference(`${defaultRoot}/${rawPath}`);
    if (fromDefault) return fromDefault;
  }

  for (const root of DIRECT_REASONING_IMPLEMENTATION_SEARCH_ROOTS) {
    const candidate = normalizeRepoFileReference(`${root}/${rawPath}`);
    if (candidate) return candidate;
  }
  return null;
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

function clampEvidenceBudgetInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number(value) : NaN);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function extractSymbolNames(snippet: string): string[] {
  const symbols = new Set<string>();
  for (const symbol of extractDeclaredSymbolNames(snippet)) {
    symbols.add(symbol);
  }
  const methodPattern = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of snippet.matchAll(methodPattern)) {
    const name = match[1];
    if (!name || ['if', 'for', 'while', 'switch', 'catch', 'function'].includes(name)) continue;
    symbols.add(name);
  }
  return [...symbols];
}

function extractDeclaredSymbolNames(snippet: string): string[] {
  const symbols = new Set<string>();
  const symbolPattern = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of snippet.matchAll(symbolPattern)) {
    if (match[1]) symbols.add(match[1]);
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
    requestId: directReasoningTraceRequestId(input),
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

function directReasoningTraceRequestId(input: DirectReasoningInput): string | undefined {
  return input.traceContext?.executionId ?? input.traceContext?.requestId;
}

function createDirectReasoningGraphEmitter(
  input: DirectReasoningInput,
  deps: DirectReasoningDependencies,
): DirectReasoningGraphEmitter | null {
  if (!deps.graphEvents) {
    return null;
  }
  const context = input.graphContext ?? buildDirectReasoningGraphContext({
    requestId: directReasoningTraceRequestId(input),
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
