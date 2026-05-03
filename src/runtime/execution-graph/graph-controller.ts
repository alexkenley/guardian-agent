import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatOptions } from '../../llm/types.js';
import type { UserMessage } from '../../agent/types.js';
import type { ResolvedSkill } from '../../skills/types.js';
import type { ToolExecutionRequest } from '../../tools/types.js';
import type { Runtime } from '../runtime.js';
import type { OrchestrationRoleDescriptor } from '../orchestration-role-descriptors.js';
import type { RunTimelineStore } from '../run-timeline.js';
import type {
  PromptAssemblyAdditionalSection,
  PromptAssemblyContinuity,
  PromptAssemblyKnowledgeBase,
  PromptAssemblyPendingAction,
} from '../context-assembly.js';
import {
  selectEscalatedDelegatedExecutionProfile,
  type SelectedExecutionProfile,
} from '../execution-profiles.js';
import type {
  IntentGatewayDecision,
  IntentGatewayRecord,
} from '../intent-gateway.js';
import { attachPreRoutedIntentGatewayMetadata } from '../intent-gateway.js';
import type { DelegatedResultEnvelope } from '../execution/types.js';
import {
  shouldHandleDirectReasoningMode,
  type DirectReasoningTraceContext,
} from '../direct-reasoning-mode.js';
import {
  formatPendingApprovalMessage,
} from '../pending-approval-copy.js';
import {
  toPendingActionClientMetadata,
  type PendingActionScope,
  type PendingActionStore,
} from '../pending-actions.js';
import {
  artifactRefFromArtifact,
  readExecutionGraphArtifactsFromMetadata,
  type ExecutionArtifact,
} from './graph-artifacts.js';
import {
  createExecutionGraphEvent,
  type ExecutionGraphEvent,
} from './graph-events.js';
import type { ExecutionGraphStore } from './graph-store.js';
import type { ExecutionNodeKind } from './types.js';
import {
  buildDirectReasoningGraphContext,
  type DirectReasoningGraphContext,
} from './direct-reasoning-node.js';
import {
  buildGraphWriteSpecSynthesisMessages,
  buildGroundedSynthesisLedgerArtifact,
  completeGraphWriteSpecSynthesisNode,
} from './synthesis-node.js';
import {
  buildMutationToolRequest,
  executeWriteSpecMutationNode,
  type MutationNodeExecutionContext,
} from './mutation-node.js';
import { recordGraphPendingActionInterrupt } from './pending-action-adapter.js';

type DelegatedTaskPlanStep = DelegatedResultEnvelope['taskContract']['plan']['steps'][number];

export interface GraphControllerTargetContext {
  orchestration?: OrchestrationRoleDescriptor;
}

export interface GraphControlledRunNodeIds {
  readNodeId: string;
  synthesisNodeId: string;
  mutationNodeId: string;
  verificationNodeId: string;
}

export interface GraphControlledRun {
  graphId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  codeSessionId?: string;
  nodeIds: GraphControlledRunNodeIds;
  currentSequence: () => number;
  updateSequenceFromEvents: (events: readonly ExecutionGraphEvent[]) => void;
  ingestGraphEvent: (event: ExecutionGraphEvent) => void;
  emitGraphEvent: (
    kind: ExecutionGraphEvent['kind'],
    payload: Record<string, unknown>,
    eventKey: string,
    options?: {
      nodeId?: string;
      nodeKind?: ExecutionNodeKind;
      producer?: ExecutionGraphEvent['producer'];
    },
  ) => ExecutionGraphEvent;
  emitArtifact: (
    artifact: ExecutionArtifact,
    nodeId: string,
    nodeKind: ExecutionNodeKind,
  ) => ExecutionGraphEvent;
}

export interface GraphControlledExecutionDelegation {
  rootExecutionId?: string;
  executionId?: string;
  codeSessionId?: string;
}

export interface GraphControlledExecutionRequest {
  sessionId: string;
  agentId: string;
  userId: string;
  grantedCapabilities: string[];
  message: UserMessage;
  systemPrompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  knowledgeBases?: PromptAssemblyKnowledgeBase[];
  activeSkills?: ResolvedSkill[];
  additionalSections?: PromptAssemblyAdditionalSection[];
  toolContext?: string;
  runtimeNotices?: Array<{ level: 'info' | 'warn'; message: string }>;
  executionProfile?: SelectedExecutionProfile;
  continuity?: PromptAssemblyContinuity | null;
  pendingAction?: PromptAssemblyPendingAction | null;
  pendingApprovalNotice?: string;
  delegation?: GraphControlledExecutionDelegation;
}

export interface GraphControlledExecutionTarget extends GraphControllerTargetContext {
  agentId: string;
  agentName?: string;
}

export interface GraphControlledWorkerDispatchParams {
  message: UserMessage;
  systemPrompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  knowledgeBases: PromptAssemblyKnowledgeBase[];
  activeSkills: ResolvedSkill[];
  additionalSections: PromptAssemblyAdditionalSection[];
  toolContext: string;
  runtimeNotices: Array<{ level: 'info' | 'warn'; message: string }>;
  executionProfile?: SelectedExecutionProfile;
  continuity?: PromptAssemblyContinuity | null;
  pendingAction?: PromptAssemblyPendingAction | null;
  pendingApprovalNotice?: string;
  hasFallbackProvider?: boolean;
  directReasoning?: boolean;
  directReasoningTrace?: DirectReasoningTraceContext;
  directReasoningGraphContext?: DirectReasoningGraphContext;
  directReasoningGraphLifecycle?: 'standalone' | 'node_only';
  returnExecutionGraphArtifacts?: boolean;
  groundedSynthesis?: {
    messages: ChatMessage[];
    responseFormat?: ChatOptions['responseFormat'];
    maxTokens?: number;
    temperature?: number;
  };
}

export interface GraphControlledExecutionSupervisor<WorkerHandle> {
  getWorker(input: {
    sessionId: string;
    agentId: string;
    userId: string;
    channel: string;
    grantedCapabilities: string[];
  }): Promise<WorkerHandle>;
  hasFallbackProvider(agentId: string): boolean;
  buildCodeSessionRegistrySection(request: GraphControlledExecutionRequest): PromptAssemblyAdditionalSection | null;
  dispatchToWorker(
    worker: WorkerHandle,
    params: GraphControlledWorkerDispatchParams,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }>;
  executeTool(
    toolName: string,
    args: Record<string, unknown>,
    request: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  ): Promise<Record<string, unknown>>;
}

export function createGraphControlledRun(input: {
  graphStore?: Pick<ExecutionGraphStore, 'createGraph' | 'appendEvent' | 'writeArtifact'>;
  runTimeline?: Pick<RunTimelineStore, 'ingestExecutionGraphEvent'>;
  now: () => number;
  taskRunId: string;
  requestId: string;
  gatewayDecision: IntentGatewayDecision;
  agentId: string;
  userId: string;
  channel: string;
  surfaceId?: string;
  triggerSourceId: string;
  rootExecutionId?: string;
  parentExecutionId?: string;
  codeSessionId?: string;
}): GraphControlledRun {
  const graphId = `graph:${input.taskRunId}`;
  const rootExecutionId = input.rootExecutionId ?? input.taskRunId;
  const parentExecutionId = input.parentExecutionId;
  const readNodeId = `node:${input.taskRunId}:explore`;
  const synthesisNodeId = `node:${input.taskRunId}:synthesize`;
  const mutationNodeId = `node:${input.taskRunId}:mutate`;
  const verificationNodeId = `node:${input.taskRunId}:verify`;
  input.graphStore?.createGraph({
    graphId,
    executionId: input.taskRunId,
    rootExecutionId,
    ...(parentExecutionId ? { parentExecutionId } : {}),
    requestId: input.requestId,
    runId: input.requestId,
    intent: input.gatewayDecision,
    securityContext: {
      agentId: input.agentId,
      userId: input.userId,
      channel: input.channel,
      ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
      ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
    },
    trigger: {
      type: 'user_request',
      source: input.channel,
      sourceId: input.triggerSourceId,
    },
    nodes: [
      {
        nodeId: readNodeId,
        graphId,
        kind: 'explore_readonly',
        status: 'pending',
        title: 'Read-only evidence gathering',
        requiredInputIds: [],
        outputArtifactTypes: ['SearchResultSet', 'FileReadSet', 'EvidenceLedger'],
        allowedToolCategories: ['filesystem.read', 'search.read'],
        approvalPolicy: 'none',
        checkpointPolicy: 'phase_boundary',
      },
      {
        nodeId: synthesisNodeId,
        graphId,
        kind: 'synthesize',
        status: 'pending',
        title: 'Grounded write specification synthesis',
        requiredInputIds: [],
        outputArtifactTypes: ['EvidenceLedger', 'SynthesisDraft', 'WriteSpec'],
        allowedToolCategories: [],
        approvalPolicy: 'none',
        checkpointPolicy: 'phase_boundary',
      },
      {
        nodeId: mutationNodeId,
        graphId,
        kind: 'mutate',
        status: 'pending',
        title: 'Supervisor-owned file mutation',
        requiredInputIds: [],
        outputArtifactTypes: ['MutationReceipt', 'VerificationResult'],
        allowedToolCategories: ['filesystem.write', 'filesystem.read'],
        approvalPolicy: 'if_required',
        checkpointPolicy: 'phase_boundary',
      },
      {
        nodeId: verificationNodeId,
        graphId,
        kind: 'verify',
        status: 'pending',
        title: 'Mutation verification',
        requiredInputIds: [],
        outputArtifactTypes: ['VerificationResult'],
        allowedToolCategories: ['filesystem.read'],
        approvalPolicy: 'none',
        checkpointPolicy: 'terminal_only',
      },
    ],
    edges: [
      {
        edgeId: `${readNodeId}->${synthesisNodeId}`,
        graphId,
        fromNodeId: readNodeId,
        toNodeId: synthesisNodeId,
      },
      {
        edgeId: `${synthesisNodeId}->${mutationNodeId}`,
        graphId,
        fromNodeId: synthesisNodeId,
        toNodeId: mutationNodeId,
      },
      {
        edgeId: `${mutationNodeId}->${verificationNodeId}`,
        graphId,
        fromNodeId: mutationNodeId,
        toNodeId: verificationNodeId,
      },
    ],
  });

  let sequence = 0;
  const ingestGraphEvent = (event: ExecutionGraphEvent): void => {
    sequence = Math.max(sequence, event.sequence);
    input.runTimeline?.ingestExecutionGraphEvent(event);
    input.graphStore?.appendEvent(event);
  };
  const emitGraphEvent: GraphControlledRun['emitGraphEvent'] = (
    kind,
    payload,
    eventKey,
    options = {},
  ) => {
    sequence += 1;
    const event = createExecutionGraphEvent({
      eventId: `${graphId}:${eventKey}:${sequence}`,
      graphId,
      executionId: input.taskRunId,
      rootExecutionId,
      ...(parentExecutionId ? { parentExecutionId } : {}),
      requestId: input.requestId,
      runId: input.requestId,
      ...(options.nodeId ? { nodeId: options.nodeId } : {}),
      ...(options.nodeKind ? { nodeKind: options.nodeKind } : {}),
      kind,
      timestamp: input.now(),
      sequence,
      producer: options.producer ?? 'supervisor',
      channel: input.channel,
      agentId: input.agentId,
      userId: input.userId,
      ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
      payload,
    });
    ingestGraphEvent(event);
    return event;
  };
  const emitArtifact: GraphControlledRun['emitArtifact'] = (artifact, nodeId, nodeKind) => {
    const ref = artifactRefFromArtifact(artifact);
    input.graphStore?.writeArtifact(artifact);
    return emitGraphEvent('artifact_created', {
      artifactId: ref.artifactId,
      artifactType: ref.artifactType,
      label: ref.label,
      ...(ref.preview ? { preview: ref.preview } : {}),
      ...(ref.trustLevel ? { trustLevel: ref.trustLevel } : {}),
      ...(ref.taintReasons ? { taintReasons: ref.taintReasons } : {}),
      ...(ref.redactionPolicy ? { redactionPolicy: ref.redactionPolicy } : {}),
    }, `artifact:${artifact.artifactId}`, { nodeId, nodeKind });
  };

  return {
    graphId,
    rootExecutionId,
    ...(parentExecutionId ? { parentExecutionId } : {}),
    ...(input.codeSessionId ? { codeSessionId: input.codeSessionId } : {}),
    nodeIds: {
      readNodeId,
      synthesisNodeId,
      mutationNodeId,
      verificationNodeId,
    },
    currentSequence: () => sequence,
    updateSequenceFromEvents: (events) => {
      sequence = events.reduce((highest, event) => Math.max(highest, event.sequence), sequence);
    },
    ingestGraphEvent,
    emitGraphEvent,
    emitArtifact,
  };
}

export async function runGraphControlledExecution<WorkerHandle>(input: {
  runtime: Runtime;
  request: GraphControlledExecutionRequest;
  target: GraphControlledExecutionTarget;
  taskContract: DelegatedResultEnvelope['taskContract'];
  preRoutedGateway: IntentGatewayRecord | null | undefined;
  effectiveIntentDecision: IntentGatewayDecision | undefined;
  requestId: string;
  taskRunId: string;
  graphStore?: Pick<ExecutionGraphStore, 'createGraph' | 'appendEvent' | 'writeArtifact'>;
  runTimeline?: Pick<RunTimelineStore, 'ingestExecutionGraphEvent'>;
  pendingActionStore?: Pick<PendingActionStore, 'replaceActive'>;
  now?: () => number;
  supervisor: GraphControlledExecutionSupervisor<WorkerHandle>;
}): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
  if (!shouldUseGraphControlledExecution({
    taskContract: input.taskContract,
    decision: input.effectiveIntentDecision,
    executionProfile: input.request.executionProfile,
  })) {
    return null;
  }

  const gatewayRecord = buildGraphReadOnlyIntentGatewayRecord({
    baseRecord: input.preRoutedGateway,
    baseDecision: input.effectiveIntentDecision,
    taskContract: input.taskContract,
    originalRequest: input.request.message.content,
  });
  if (!gatewayRecord) {
    return buildGraphControlledFailureResponse({
      executionProfile: input.request.executionProfile,
      reason: 'Graph-controlled execution could not derive a read-only routing decision.',
    });
  }
  const graphExecutionProfile = selectGraphControllerExecutionProfile({
    runtime: input.runtime,
    target: input.target,
    decision: input.effectiveIntentDecision,
    currentProfile: input.request.executionProfile,
  });
  if (!shouldHandleDirectReasoningMode({
    gateway: gatewayRecord,
    selectedExecutionProfile: graphExecutionProfile,
  })) {
    return null;
  }

  const now = input.now ?? Date.now;
  const codeContext = input.request.message.metadata?.codeContext as ToolExecutionRequest['codeContext'] | undefined;
  const run = createGraphControlledRun({
    graphStore: input.graphStore,
    runTimeline: input.runTimeline,
    now,
    taskRunId: input.taskRunId,
    requestId: input.requestId,
    gatewayDecision: gatewayRecord.decision,
    agentId: input.target.agentId,
    userId: input.request.userId,
    channel: input.request.message.channel,
    ...(input.request.message.surfaceId ? { surfaceId: input.request.message.surfaceId } : {}),
    triggerSourceId: input.request.message.id,
    ...(input.request.delegation?.rootExecutionId ? { rootExecutionId: input.request.delegation.rootExecutionId } : {}),
    ...(input.request.delegation?.executionId ? { parentExecutionId: input.request.delegation.executionId } : {}),
    ...(input.request.delegation?.codeSessionId ?? codeContext?.sessionId
      ? { codeSessionId: input.request.delegation?.codeSessionId ?? codeContext?.sessionId }
      : {}),
  });
  const { graphId, rootExecutionId, parentExecutionId, codeSessionId } = run;
  const { readNodeId, synthesisNodeId, mutationNodeId, verificationNodeId } = run.nodeIds;
  const failGraph = (reason: string, nodeId?: string, nodeKind?: ExecutionGraphEvent['nodeKind']) => {
    if (nodeId && nodeKind) {
      run.emitGraphEvent('node_failed', { reason }, `${nodeId}:failed`, { nodeId, nodeKind });
    }
    run.emitGraphEvent('graph_failed', { reason }, 'graph:failed');
    return buildGraphControlledFailureResponse({
      executionProfile: input.request.executionProfile,
      reason,
      graphId,
    });
  };

  run.emitGraphEvent('graph_started', {
    route: input.effectiveIntentDecision?.route,
    operation: input.effectiveIntentDecision?.operation,
    executionClass: input.effectiveIntentDecision?.executionClass,
    controller: 'execution_graph',
  }, 'graph:started');

  try {
    const worker = await input.supervisor.getWorker({
      sessionId: input.request.sessionId,
      agentId: input.request.agentId,
      userId: input.request.userId,
      channel: input.request.message.channel,
      grantedCapabilities: input.request.grantedCapabilities,
    });
    const hasFallbackProvider = input.supervisor.hasFallbackProvider(input.request.agentId);
    const additionalSections = appendPromptAdditionalSection(
      input.request.additionalSections ?? [],
      input.supervisor.buildCodeSessionRegistrySection(input.request),
    );
    const readGraphContext = buildDirectReasoningGraphContext({
      graphId,
      nodeId: readNodeId,
      requestId: input.requestId,
      executionId: input.taskRunId,
      rootExecutionId,
      parentExecutionId,
      taskExecutionId: input.taskRunId,
      channel: input.request.message.channel,
      agentId: input.target.agentId,
      userId: input.request.userId,
      codeSessionId,
      decision: gatewayRecord.decision,
    });
    const readMessage: UserMessage = {
      ...input.request.message,
      content: gatewayRecord.decision.resolvedContent ?? input.request.message.content,
      metadata: attachPreRoutedIntentGatewayMetadata(input.request.message.metadata, gatewayRecord),
    };
    const directResult = await input.supervisor.dispatchToWorker(worker, {
      message: readMessage,
      systemPrompt: input.request.systemPrompt,
      history: input.request.history,
      knowledgeBases: input.request.knowledgeBases ?? [],
      activeSkills: input.request.activeSkills ?? [],
      additionalSections,
      toolContext: input.request.toolContext ?? '',
      runtimeNotices: input.request.runtimeNotices ?? [],
      executionProfile: graphExecutionProfile,
      continuity: input.request.continuity,
      pendingAction: input.request.pendingAction,
      pendingApprovalNotice: input.request.pendingApprovalNotice,
      hasFallbackProvider,
      directReasoning: true,
      directReasoningTrace: {
        requestId: input.requestId,
        messageId: input.request.message.id,
        userId: input.request.userId,
        channel: input.request.message.channel,
        agentId: input.target.agentId,
        contentPreview: input.request.message.content,
        ...(parentExecutionId ? { executionId: parentExecutionId } : {}),
        rootExecutionId,
        taskExecutionId: input.taskRunId,
        ...(codeSessionId ? { codeSessionId } : {}),
      },
      directReasoningGraphContext: readGraphContext,
      directReasoningGraphLifecycle: 'node_only',
      returnExecutionGraphArtifacts: true,
    });
    const sourceArtifacts = readExecutionGraphArtifactsFromMetadata(directResult.metadata);
    for (const artifact of sourceArtifacts) {
      input.graphStore?.writeArtifact(artifact);
    }
    if (directResult.metadata?.directReasoningFailed === true || sourceArtifacts.length === 0) {
      return failGraph('Read-only graph node did not produce typed evidence artifacts.', readNodeId, 'explore_readonly');
    }

    run.emitGraphEvent('node_started', {
      evidenceArtifactCount: sourceArtifacts.length,
      purpose: 'write_spec_candidate',
    }, `${synthesisNodeId}:started`, { nodeId: synthesisNodeId, nodeKind: 'synthesize' });
    const ledgerArtifact = buildGroundedSynthesisLedgerArtifact({
      graphId,
      nodeId: synthesisNodeId,
      artifactId: `${graphId}:${synthesisNodeId}:evidence-ledger`,
      sourceArtifacts,
      createdAt: now(),
    });
    if (ledgerArtifact) {
      run.emitArtifact(ledgerArtifact, synthesisNodeId, 'synthesize');
    }
    const synthesisMessages = buildGraphWriteSpecSynthesisMessages({
      request: input.request.message.content,
      decision: input.effectiveIntentDecision ?? gatewayRecord.decision,
      workspaceRoot: codeContext?.workspaceRoot,
      sourceArtifacts,
      ledgerArtifact,
    });
    run.emitGraphEvent('llm_call_started', {
      phase: 'write_spec_synthesis',
      evidenceArtifactCount: sourceArtifacts.length,
    }, `${synthesisNodeId}:llm:started`, { nodeId: synthesisNodeId, nodeKind: 'synthesize' });
    const synthesisResult = await input.supervisor.dispatchToWorker(worker, {
      message: input.request.message,
      systemPrompt: input.request.systemPrompt,
      history: input.request.history,
      knowledgeBases: input.request.knowledgeBases ?? [],
      activeSkills: input.request.activeSkills ?? [],
      additionalSections,
      toolContext: input.request.toolContext ?? '',
      runtimeNotices: input.request.runtimeNotices ?? [],
      executionProfile: graphExecutionProfile,
      continuity: input.request.continuity,
      pendingAction: input.request.pendingAction,
      pendingApprovalNotice: input.request.pendingApprovalNotice,
      hasFallbackProvider,
      groundedSynthesis: {
        messages: synthesisMessages,
        responseFormat: {
          type: 'json_schema',
          name: 'graph_write_spec_candidate',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
              append: { type: 'boolean' },
              summary: { type: 'string' },
            },
            required: ['path', 'content', 'append'],
          },
        },
        maxTokens: 4_000,
        temperature: 0,
      },
    });
    run.emitGraphEvent('llm_call_completed', {
      phase: 'write_spec_synthesis',
      resultStatus: synthesisResult.content.trim() ? 'succeeded' : 'failed',
    }, `${synthesisNodeId}:llm:completed`, { nodeId: synthesisNodeId, nodeKind: 'synthesize' });
    const synthesis = completeGraphWriteSpecSynthesisNode({
      graphId,
      nodeId: synthesisNodeId,
      candidateContent: synthesisResult.content,
      sourceArtifacts,
      ledgerArtifact,
      createdAt: now(),
    });
    if (!synthesis) {
      return failGraph('Synthesis node did not produce a valid write specification.', synthesisNodeId, 'synthesize');
    }
    const { draft, writeSpec } = synthesis;
    run.emitArtifact(draft.artifact, synthesisNodeId, 'synthesize');
    run.emitArtifact(writeSpec, synthesisNodeId, 'synthesize');
    run.emitGraphEvent('node_completed', {
      draftArtifactId: draft.artifact.artifactId,
      writeSpecArtifactId: writeSpec.artifactId,
    }, `${synthesisNodeId}:completed`, { nodeId: synthesisNodeId, nodeKind: 'synthesize' });

    const toolRequest = buildMutationToolRequest({
      requestId: input.requestId,
      agentId: input.request.agentId,
      userId: input.request.userId,
      surfaceId: input.request.message.surfaceId,
      principalId: input.request.message.principalId ?? input.request.userId,
      principalRole: input.request.message.principalRole ?? 'owner',
      channel: input.request.message.channel,
      codeContext,
      toolContextMode: graphExecutionProfile?.toolContextMode,
      activeSkillIds: input.request.activeSkills?.map((skill) => skill.id) ?? [],
    });
    const mutationContext: MutationNodeExecutionContext = {
      graphId,
      executionId: input.taskRunId,
      rootExecutionId,
      ...(parentExecutionId ? { parentExecutionId } : {}),
      requestId: input.requestId,
      runId: input.requestId,
      nodeId: mutationNodeId,
      channel: input.request.message.channel,
      agentId: input.target.agentId,
      userId: input.request.userId,
      ...(codeSessionId ? { codeSessionId } : {}),
      verificationNodeId,
      sequenceStart: run.currentSequence(),
      now,
      emit: (event) => {
        run.ingestGraphEvent(event);
      },
    };
    const mutationResult = await executeWriteSpecMutationNode({
      writeSpec,
      executeTool: input.supervisor.executeTool,
      toolRequest,
      context: mutationContext,
    });
    run.updateSequenceFromEvents(mutationResult.events);
    const artifactIds = [
      ...sourceArtifacts.map((artifact) => artifact.artifactId),
      ...(ledgerArtifact ? [ledgerArtifact.artifactId] : []),
      draft.artifact.artifactId,
      writeSpec.artifactId,
      ...(mutationResult.receiptArtifact ? [mutationResult.receiptArtifact.artifactId] : []),
      ...(mutationResult.verificationArtifact ? [mutationResult.verificationArtifact.artifactId] : []),
    ];
    if (mutationResult.receiptArtifact) {
      input.graphStore?.writeArtifact(mutationResult.receiptArtifact);
    }
    if (mutationResult.verificationArtifact) {
      input.graphStore?.writeArtifact(mutationResult.verificationArtifact);
    }

    if (mutationResult.status === 'awaiting_approval' && mutationResult.receiptArtifact) {
      const approvalEvent = mutationResult.events.find((event) => event.kind === 'approval_requested');
      const approvalId = mutationResult.receiptArtifact.content.approvalId;
      if (!approvalEvent || !approvalId) {
        return failGraph('Mutation node requested approval without a resumable approval id.', mutationNodeId, 'mutate');
      }
      const approvalSummary = {
        id: approvalId,
        toolName: 'fs_write',
        argsPreview: JSON.stringify({
          path: writeSpec.content.path,
          append: writeSpec.content.append,
        }),
        actionLabel: 'approve file write',
        requestId: input.requestId,
        ...(codeSessionId ? { codeSessionId } : {}),
      };
      const pendingScope: PendingActionScope = {
        agentId: input.request.agentId,
        userId: input.request.userId,
        channel: input.request.message.channel,
        surfaceId: input.request.message.surfaceId?.trim() || input.request.message.channel,
      };
      const pendingRecord = input.pendingActionStore
        ? recordGraphPendingActionInterrupt({
            store: input.pendingActionStore,
            scope: pendingScope,
            event: approvalEvent,
            originalUserContent: input.request.message.content,
            intent: {
              route: input.effectiveIntentDecision?.route,
              operation: input.effectiveIntentDecision?.operation,
              summary: input.effectiveIntentDecision?.summary,
              resolvedContent: input.effectiveIntentDecision?.resolvedContent,
            },
            artifactRefs: [writeSpec, mutationResult.receiptArtifact].map(artifactRefFromArtifact),
            approvalSummaries: [approvalSummary],
            nowMs: now(),
          })
        : null;
      return {
        content: formatPendingApprovalMessage([approvalSummary]),
        metadata: {
          executionProfile: graphExecutionProfile ?? undefined,
          executionGraph: {
            graphId,
            status: 'awaiting_approval',
            artifactIds,
            writeSpecArtifactId: writeSpec.artifactId,
            receiptArtifactId: mutationResult.receiptArtifact.artifactId,
          },
          ...(pendingRecord ? { pendingAction: toPendingActionClientMetadata(pendingRecord) } : {}),
          continueConversationAfterApproval: true,
        },
      };
    }

    if (mutationResult.status !== 'succeeded' || !mutationResult.verificationArtifact) {
      return failGraph('Mutation node failed before verification completed.', mutationNodeId, 'mutate');
    }
    run.emitGraphEvent('graph_completed', {
      status: 'succeeded',
      artifactIds,
      writeSpecArtifactId: writeSpec.artifactId,
      receiptArtifactId: mutationResult.receiptArtifact?.artifactId,
      verificationArtifactId: mutationResult.verificationArtifact.artifactId,
    }, 'graph:completed');
    return {
      content: `Wrote ${writeSpec.content.path} and verified the contents.`,
      metadata: {
        executionProfile: graphExecutionProfile ?? undefined,
        executionGraph: {
          graphId,
          status: 'succeeded',
          artifactIds,
          writeSpecArtifactId: writeSpec.artifactId,
          receiptArtifactId: mutationResult.receiptArtifact?.artifactId,
          verificationArtifactId: mutationResult.verificationArtifact.artifactId,
        },
      },
    };
  } catch (error) {
    return failGraph(error instanceof Error ? error.message : String(error));
  }
}

export function buildGraphControlledFailureResponse(input: {
  executionProfile?: SelectedExecutionProfile;
  reason: string;
  graphId?: string;
}): { content: string; metadata: Record<string, unknown> } {
  return {
    content: `Execution graph could not complete the request: ${input.reason}`,
    metadata: {
      executionProfile: input.executionProfile ?? undefined,
      executionGraph: {
        ...(input.graphId ? { graphId: input.graphId } : {}),
        status: 'failed',
        reason: input.reason,
      },
    },
  };
}

function cloneReadOnlyPlannedStepsFromTaskContract(
  taskContract: DelegatedResultEnvelope['taskContract'],
): NonNullable<IntentGatewayDecision['plannedSteps']> | undefined {
  const readOnlySteps = taskContract.plan.steps
    .filter((step) => isGraphReadStep(step))
    .map((step) => ({
      kind: step.kind,
      summary: step.summary,
      ...(step.expectedToolCategories?.length
        ? { expectedToolCategories: [...step.expectedToolCategories] }
        : {}),
      ...(step.required === false ? { required: false } : {}),
      ...(step.dependsOn?.length ? { dependsOn: [...step.dependsOn] } : {}),
    }));
  return readOnlySteps.length > 0 ? readOnlySteps : undefined;
}

export function buildGraphReadOnlyIntentGatewayRecord(input: {
  baseRecord: IntentGatewayRecord | null | undefined;
  baseDecision: IntentGatewayDecision | undefined;
  taskContract: DelegatedResultEnvelope['taskContract'];
  originalRequest: string;
}): IntentGatewayRecord | null {
  const plannedSteps = cloneReadOnlyPlannedStepsFromTaskContract(input.taskContract);
  if (!plannedSteps || plannedSteps.length <= 0) {
    return null;
  }
  const baseDecision = input.baseDecision ?? input.baseRecord?.decision;
  if (!baseDecision) {
    return null;
  }
  const readOnlySummary = `Read-only exploration for graph-controlled task: ${input.taskContract.summary?.trim() || baseDecision.summary}`;
  return {
    mode: input.baseRecord?.mode ?? 'confirmation',
    available: input.baseRecord?.available ?? true,
    model: input.baseRecord?.model ?? 'execution-graph.readonly',
    latencyMs: input.baseRecord?.latencyMs ?? 0,
    ...(input.baseRecord?.promptProfile ? { promptProfile: input.baseRecord.promptProfile } : {}),
    decision: {
      ...baseDecision,
      operation: plannedSteps.some((step) => step.kind === 'search') ? 'search' : 'inspect',
      summary: readOnlySummary,
      resolvedContent: buildGraphReadOnlyExplorationPrompt({
        originalRequest: input.originalRequest,
        taskContract: input.taskContract,
      }),
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: input.taskContract.requireExactFileReferences,
      preferredAnswerPath: 'tool_loop',
      plannedSteps,
      provenance: {
        ...(baseDecision.provenance ?? {}),
        operation: 'derived.workload',
        resolvedContent: 'derived.workload',
        executionClass: 'derived.workload',
        requiresRepoGrounding: 'derived.workload',
        requiresToolSynthesis: 'derived.workload',
        preferredAnswerPath: 'derived.workload',
      },
    },
  };
}

function isGraphReadStep(step: DelegatedTaskPlanStep): boolean {
  return step.required !== false && (step.kind === 'search' || step.kind === 'read');
}

function isGraphWriteStep(step: DelegatedTaskPlanStep): boolean {
  return step.required !== false && step.kind === 'write';
}

function countRequiredDecisionWriteSteps(decision: IntentGatewayDecision | undefined): number {
  return decision?.plannedSteps?.filter((step) => step.required !== false && step.kind === 'write').length ?? 0;
}

export function shouldUseGraphControlledExecution(input: {
  taskContract: DelegatedResultEnvelope['taskContract'];
  decision: IntentGatewayDecision | undefined;
  executionProfile?: SelectedExecutionProfile;
}): boolean {
  if (!input.executionProfile) {
    return false;
  }
  if (input.decision?.executionClass === 'security_analysis') {
    return false;
  }
  if (input.taskContract.kind !== 'filesystem_mutation') {
    return false;
  }
  const route = input.decision?.route ?? input.taskContract.route;
  if (route !== 'coding_task' && route !== 'filesystem_task') {
    return false;
  }
  const operation = input.decision?.operation ?? input.taskContract.operation;
  if (operation === 'inspect' || operation === 'read' || operation === 'search') {
    return false;
  }
  if (!hasConcreteGraphMutationContract(input.decision, route)) {
    return false;
  }
  const requiredSteps = input.taskContract.plan.steps.filter((step) => step.required !== false);
  const hasReadPhase = requiredSteps.some((step) => isGraphReadStep(step));
  const writeStepCount = requiredSteps.filter((step) => isGraphWriteStep(step)).length;
  if (writeStepCount !== 1 || countRequiredDecisionWriteSteps(input.decision) > 1) {
    return false;
  }
  return hasReadPhase;
}

function hasConcreteGraphMutationContract(
  decision: IntentGatewayDecision | undefined,
  route: IntentGatewayDecision['route'] | DelegatedResultEnvelope['taskContract']['route'],
): boolean {
  if (!decision) {
    return false;
  }
  if (decision.confidence === 'low') {
    return false;
  }
  if (route === 'filesystem_task' && !decision.entities.path?.trim()) {
    return false;
  }
  return true;
}

export function selectGraphControllerExecutionProfile(input: {
  runtime: Runtime;
  target: GraphControllerTargetContext;
  decision: IntentGatewayDecision | undefined;
  currentProfile?: SelectedExecutionProfile;
}): SelectedExecutionProfile | undefined {
  const currentProfile = input.currentProfile;
  if (currentProfile && currentProfile.providerTier !== 'local') {
    return currentProfile;
  }
  const escalated = selectEscalatedDelegatedExecutionProfile({
    config: input.runtime.getConfigSnapshot(),
    currentProfile,
    parentProfile: currentProfile,
    gatewayDecision: input.decision,
    orchestration: input.target.orchestration,
    mode: currentProfile?.routingMode ?? 'auto',
  });
  return escalated ?? currentProfile;
}

export function buildGraphControlledTaskRunId(requestId: string): string {
  return `graph-run:${requestId || randomUUID()}`;
}

function buildGraphReadOnlyExplorationPrompt(input: {
  originalRequest: string;
  taskContract: DelegatedResultEnvelope['taskContract'];
}): string {
  const readSteps = input.taskContract.plan.steps
    .filter((step) => isGraphReadStep(step))
    .map((step) => `- ${step.stepId}: ${step.summary}`);
  const writeSteps = input.taskContract.plan.steps
    .filter((step) => isGraphWriteStep(step))
    .map((step) => `- ${step.stepId}: ${step.summary}`);
  return [
    'Read-only execution graph exploration node.',
    'Do not create, edit, delete, rename, patch, or run shell commands.',
    '',
    `Original request: ${input.originalRequest}`,
    '',
    'Explore these required read/search steps:',
    ...(readSteps.length > 0 ? readSteps : ['- None']),
    '',
    'The graph controller will decide and perform these write steps after grounded synthesis:',
    ...(writeSteps.length > 0 ? writeSteps : ['- None']),
    '',
    'Return a concise evidence summary for the graph synthesis node. Include the files, symbols, matches, and constraints it should use.',
  ].join('\n');
}

function appendPromptAdditionalSection(
  sections: PromptAssemblyAdditionalSection[],
  extraSection: PromptAssemblyAdditionalSection | null,
): PromptAssemblyAdditionalSection[] {
  if (!extraSection) {
    return [...sections];
  }
  if (sections.some((section) => section.section === extraSection.section)) {
    return [...sections];
  }
  return [...sections, extraSection];
}
