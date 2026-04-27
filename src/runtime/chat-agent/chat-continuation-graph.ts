import { randomUUID } from 'node:crypto';

import type { RunTimelineStore } from '../run-timeline.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type {
  PendingActionApprovalSummary,
  PendingActionIntent,
  PendingActionRecord,
  PendingActionTransferPolicy,
} from '../pending-actions.js';
import type { PendingActionSetResult } from './orchestration-state.js';
import {
  artifactRefFromArtifact,
  type ExecutionArtifact,
} from '../execution-graph/graph-artifacts.js';
import {
  createExecutionGraphEvent,
  type ExecutionGraphEvent,
} from '../execution-graph/graph-events.js';
import type { ExecutionGraphStore } from '../execution-graph/graph-store.js';
import {
  readExecutionGraphResumePayload,
} from '../execution-graph/pending-action-adapter.js';
import type { ExecutionArtifactRef, ExecutionGraph } from '../execution-graph/types.js';
import {
  readAutomationAuthoringContinuationPayload,
  readFilesystemSaveOutputContinuationPayload,
  type AutomationAuthoringContinuationPayload,
  type FilesystemSaveOutputContinuationPayload,
} from './chat-continuation-payloads.js';
import {
  readToolLoopContinuationPayload,
  type ToolLoopContinuationPayload,
} from './tool-loop-continuation.js';

export type ChatContinuationPayload =
  | FilesystemSaveOutputContinuationPayload
  | AutomationAuthoringContinuationPayload
  | ToolLoopContinuationPayload;

export interface ChatContinuationGraphResume {
  graph: ExecutionGraph;
  nodeId: string;
  resumeToken: string;
  artifact: ExecutionArtifact<ChatContinuationArtifactContent>;
  payload: ChatContinuationPayload;
}

export interface ChatContinuationApprovalDecision {
  approved?: boolean;
  success?: boolean;
  message?: string;
}

export interface ChatContinuationGraphApprovalResumeStart {
  resume: ChatContinuationGraphResume;
  approved: boolean;
  deniedResponse?: {
    content: string;
    metadata: Record<string, unknown>;
  };
}

export interface ChatContinuationArtifactContent extends Record<string, unknown> {
  type: 'chat_continuation';
  payload: Record<string, unknown>;
}

type ChatContinuationGraphStore = Pick<
  ExecutionGraphStore,
  'appendEvent' | 'createGraph' | 'getArtifact' | 'getSnapshot' | 'writeArtifact'
>;

const CHAT_CONTINUATION_ARTIFACT_CONTENT_TYPE = 'chat_continuation';

export function recordChatContinuationGraphApproval(input: {
  graphStore: ChatContinuationGraphStore;
  runTimeline?: Pick<RunTimelineStore, 'ingestExecutionGraphEvent'>;
  userKey: string;
  userId: string;
  channel: string;
  surfaceId?: string;
  agentId: string;
  requestId: string;
  codeSessionId?: string;
  action: {
    prompt: string;
    approvalIds: string[];
    approvalSummaries?: PendingActionApprovalSummary[];
    originalUserContent: string;
    route?: string;
    operation?: string;
    summary?: string;
    turnRelation?: string;
    resolution?: string;
    missingFields?: string[];
    provenance?: PendingActionRecord['intent']['provenance'];
    entities?: Record<string, unknown>;
    continuation: ChatContinuationPayload;
    codeSessionId?: string;
  };
  setGraphPendingActionForRequest: (
    userKey: string,
    surfaceId: string | undefined,
    action: {
      event: ExecutionGraphEvent;
      originalUserContent: string;
      intent?: Partial<PendingActionIntent>;
      artifactRefs?: ExecutionArtifactRef[];
      approvalSummaries?: PendingActionApprovalSummary[];
      transferPolicy?: PendingActionTransferPolicy;
      expiresAt?: number;
    },
    nowMs?: number,
  ) => PendingActionSetResult;
  nowMs?: number;
}): PendingActionSetResult {
  const nowMs = input.nowMs ?? Date.now();
  const executionId = `chat-continuation:${randomUUID()}`;
  const graphId = `graph:${executionId}`;
  const nodeId = `node:${executionId}:approval`;
  const approvalIds = uniqueStrings(input.action.approvalIds);
  const graph = input.graphStore.createGraph({
    graphId,
    executionId,
    requestId: input.requestId,
    runId: input.requestId,
    intent: buildChatContinuationGraphIntent(input.action),
    securityContext: {
      agentId: input.agentId,
      userId: input.userId,
      channel: input.channel,
      ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
      ...(input.action.codeSessionId ?? input.codeSessionId ? { codeSessionId: input.action.codeSessionId ?? input.codeSessionId } : {}),
    },
    trigger: {
      type: 'user_request',
      source: input.channel,
      sourceId: input.requestId,
    },
    nodes: [
      {
        nodeId,
        graphId,
        kind: 'approval_interrupt',
        status: 'pending',
        title: 'Chat continuation approval',
        requiredInputIds: [],
        outputArtifactTypes: ['ChatContinuation'],
        allowedToolCategories: [],
        approvalPolicy: 'if_required',
        checkpointPolicy: 'phase_boundary',
      },
    ],
    edges: [],
  });
  let sequence = 0;
  const emit = (
    kind: ExecutionGraphEvent['kind'],
    payload: Record<string, unknown>,
    eventKey: string,
  ): ExecutionGraphEvent => {
    sequence += 1;
    const event = createChatContinuationGraphEvent({
      graph,
      nodeId,
      kind,
      payload,
      eventKey,
      timestamp: nowMs,
      sequence,
    });
    input.graphStore.appendEvent(event);
    input.runTimeline?.ingestExecutionGraphEvent(event);
    return event;
  };

  emit('graph_started', {
    route: input.action.route,
    operation: input.action.operation,
  }, 'started');
  const artifact = buildChatContinuationArtifact({
    graphId,
    nodeId,
    payload: input.action.continuation,
    createdAt: nowMs,
  });
  input.graphStore.writeArtifact(artifact);
  const artifactRef = artifactRefFromArtifact(artifact);
  emit('artifact_created', {
    artifactId: artifactRef.artifactId,
    artifactType: artifactRef.artifactType,
    label: artifactRef.label,
    ...(artifactRef.preview ? { preview: artifactRef.preview } : {}),
  }, `artifact:${artifact.artifactId}`);
  const interrupt = emit('interruption_requested', {
    kind: 'approval',
    prompt: input.action.prompt,
    approvalIds,
    approvalSummaries: (input.action.approvalSummaries ?? []).map((summary) => ({ ...summary })),
    resumeToken: `${graphId}:${nodeId}:approval:${approvalIds.join(',') || 'approval'}`,
  }, 'approval');

  return input.setGraphPendingActionForRequest(
    input.userKey,
    input.surfaceId,
    {
      event: interrupt,
      originalUserContent: input.action.originalUserContent,
      intent: {
        route: input.action.route,
        operation: input.action.operation,
        summary: input.action.summary,
        turnRelation: input.action.turnRelation,
        resolution: input.action.resolution,
        missingFields: input.action.missingFields,
        provenance: input.action.provenance,
        entities: input.action.entities,
      },
      artifactRefs: [artifactRef],
      approvalSummaries: input.action.approvalSummaries,
    },
    nowMs,
  );
}

export function readChatContinuationGraphResume(input: {
  graphStore?: Pick<ExecutionGraphStore, 'getArtifact' | 'getSnapshot'>;
  pendingAction: PendingActionRecord;
}): ChatContinuationGraphResume | null {
  const payload = readExecutionGraphResumePayload(input.pendingAction.resume?.payload);
  if (!payload || !input.graphStore) return null;
  const snapshot = input.graphStore.getSnapshot(payload.graphId);
  if (!snapshot) return null;
  const artifactIds = uniqueStrings([
    ...payload.artifactIds,
    ...(input.pendingAction.graphInterrupt?.artifactRefs.map((artifact) => artifact.artifactId) ?? []),
  ]);
  for (const artifactId of artifactIds) {
    const artifact = input.graphStore.getArtifact(payload.graphId, artifactId);
    const continuation = readChatContinuationArtifact(artifact);
    if (continuation) {
      return {
        graph: snapshot.graph,
        nodeId: payload.nodeId,
        resumeToken: payload.resumeToken,
        artifact: artifact as ExecutionArtifact<ChatContinuationArtifactContent>,
        payload: continuation,
      };
    }
  }
  return null;
}

export function emitChatContinuationGraphResumeEvent(input: {
  graphStore: Pick<ExecutionGraphStore, 'appendEvent' | 'getSnapshot'>;
  runTimeline?: Pick<RunTimelineStore, 'ingestExecutionGraphEvent'>;
  resume: ChatContinuationGraphResume;
  kind: ExecutionGraphEvent['kind'];
  payload: Record<string, unknown>;
  eventKey: string;
  nowMs?: number;
}): ExecutionGraphEvent | null {
  const snapshot = input.graphStore.getSnapshot(input.resume.graph.graphId);
  if (!snapshot) return null;
  const sequence = snapshot.events.reduce((highest, event) => Math.max(highest, event.sequence), 0) + 1;
  const event = createChatContinuationGraphEvent({
    graph: snapshot.graph,
    nodeId: input.resume.nodeId,
    kind: input.kind,
    payload: input.payload,
    eventKey: `resume:${input.eventKey}`,
    timestamp: input.nowMs ?? Date.now(),
    sequence,
  });
  input.graphStore.appendEvent(event);
  input.runTimeline?.ingestExecutionGraphEvent(event);
  return event;
}

export function startChatContinuationGraphApprovalResume(input: {
  graphStore: Pick<ExecutionGraphStore, 'appendEvent' | 'getArtifact' | 'getSnapshot'>;
  runTimeline?: Pick<RunTimelineStore, 'ingestExecutionGraphEvent'>;
  pendingAction: PendingActionRecord;
  approvalId: string;
  approvalResult: ChatContinuationApprovalDecision;
  completePendingAction: (actionId: string, nowMs: number) => void;
  nowMs?: number;
}): ChatContinuationGraphApprovalResumeStart | null {
  const resume = readChatContinuationGraphResume({
    graphStore: input.graphStore,
    pendingAction: input.pendingAction,
  });
  if (!resume) return null;
  const nowMs = input.nowMs ?? Date.now();
  input.completePendingAction(input.pendingAction.id, nowMs);
  const approved = input.approvalResult.approved ?? input.approvalResult.success ?? false;
  emitChatContinuationGraphResumeEvent({
    graphStore: input.graphStore,
    runTimeline: input.runTimeline,
    resume,
    kind: 'interruption_resolved',
    payload: {
      kind: 'approval',
      approvalId: input.approvalId,
      resumeToken: resume.resumeToken,
      resultStatus: approved ? 'approved' : 'denied',
    },
    eventKey: 'approval-resolved',
    nowMs,
  });
  if (approved) {
    return { resume, approved: true };
  }
  emitChatContinuationGraphResumeEvent({
    graphStore: input.graphStore,
    runTimeline: input.runTimeline,
    resume,
    kind: 'graph_failed',
    payload: {
      reason: input.approvalResult.message || 'Approval denied.',
      continuationArtifactId: resume.artifact.artifactId,
    },
    eventKey: 'denied',
    nowMs,
  });
  return {
    resume,
    approved: false,
    deniedResponse: {
      content: input.approvalResult.message || 'Approval denied. I did not continue the pending action.',
      metadata: {
        executionGraph: {
          graphId: resume.graph.graphId,
          status: 'failed',
          reason: 'approval_denied',
        },
      },
    },
  };
}

export function completeChatContinuationGraphResume(input: {
  graphStore: Pick<ExecutionGraphStore, 'appendEvent' | 'getSnapshot'>;
  runTimeline?: Pick<RunTimelineStore, 'ingestExecutionGraphEvent'>;
  resume: ChatContinuationGraphResume;
  response: { content: string; metadata?: Record<string, unknown> };
  nowMs?: number;
}): { content: string; metadata: Record<string, unknown> } {
  const nextPendingAction = isRecord(input.response.metadata?.pendingAction)
    ? input.response.metadata.pendingAction
    : null;
  emitChatContinuationGraphResumeEvent({
    graphStore: input.graphStore,
    runTimeline: input.runTimeline,
    resume: input.resume,
    kind: 'graph_completed',
    payload: {
      continuationArtifactId: input.resume.artifact.artifactId,
      resultStatus: nextPendingAction ? 'pending_approval' : 'completed',
    },
    eventKey: 'completed',
    nowMs: input.nowMs,
  });
  return {
    content: input.response.content,
    metadata: {
      ...(input.response.metadata ?? {}),
      executionGraph: {
        graphId: input.resume.graph.graphId,
        status: nextPendingAction ? 'pending_approval' : 'completed',
        continuationArtifactId: input.resume.artifact.artifactId,
      },
    },
  };
}

function buildChatContinuationArtifact(input: {
  graphId: string;
  nodeId: string;
  payload: ChatContinuationPayload;
  createdAt: number;
}): ExecutionArtifact<ChatContinuationArtifactContent> {
  const descriptor = describeChatContinuationPayload(input.payload);
  return {
    artifactId: `artifact:${randomUUID()}`,
    graphId: input.graphId,
    nodeId: input.nodeId,
    artifactType: 'ChatContinuation',
    label: descriptor.label,
    preview: descriptor.preview,
    refs: descriptor.refs,
    trustLevel: 'trusted',
    taintReasons: [],
    redactionPolicy: 'internal_resume_payload',
    content: {
      type: CHAT_CONTINUATION_ARTIFACT_CONTENT_TYPE,
      payload: cloneChatContinuationPayload(input.payload),
    },
    createdAt: input.createdAt,
  };
}

function readChatContinuationArtifact(
  artifact: ExecutionArtifact | null,
): ChatContinuationPayload | null {
  if (!artifact || artifact.artifactType !== 'ChatContinuation') return null;
  const content = artifact.content;
  if (!isRecord(content) || content.type !== CHAT_CONTINUATION_ARTIFACT_CONTENT_TYPE || !isRecord(content.payload)) {
    return null;
  }
  return readFilesystemSaveOutputContinuationPayload(content.payload)
    ?? readAutomationAuthoringContinuationPayload(content.payload)
    ?? readToolLoopContinuationPayload(content.payload);
}

function createChatContinuationGraphEvent(input: {
  graph: ExecutionGraph;
  nodeId: string;
  kind: ExecutionGraphEvent['kind'];
  payload: Record<string, unknown>;
  eventKey: string;
  timestamp: number;
  sequence: number;
}): ExecutionGraphEvent {
  return createExecutionGraphEvent({
    eventId: `${input.graph.graphId}:chat-continuation:${input.eventKey}:${input.sequence}`,
    graphId: input.graph.graphId,
    executionId: input.graph.executionId,
    rootExecutionId: input.graph.rootExecutionId,
    ...(input.graph.parentExecutionId ? { parentExecutionId: input.graph.parentExecutionId } : {}),
    requestId: input.graph.requestId,
    ...(input.graph.runId ? { runId: input.graph.runId } : {}),
    nodeId: input.nodeId,
    nodeKind: 'approval_interrupt',
    kind: input.kind,
    timestamp: input.timestamp,
    sequence: input.sequence,
    producer: 'runtime',
    ...(input.graph.securityContext.channel ? { channel: input.graph.securityContext.channel } : {}),
    ...(input.graph.securityContext.agentId ? { agentId: input.graph.securityContext.agentId } : {}),
    ...(input.graph.securityContext.userId ? { userId: input.graph.securityContext.userId } : {}),
    ...(input.graph.securityContext.codeSessionId ? { codeSessionId: input.graph.securityContext.codeSessionId } : {}),
    payload: input.payload,
  });
}

function buildChatContinuationGraphIntent(
  action: Parameters<typeof recordChatContinuationGraphApproval>[0]['action'],
): IntentGatewayDecision {
  return {
    route: (action.route ?? 'general_assistant') as IntentGatewayDecision['route'],
    confidence: 'high',
    operation: (action.operation ?? 'update') as IntentGatewayDecision['operation'],
    summary: action.summary ?? 'Resume chat work after approval.',
    turnRelation: (action.turnRelation ?? 'new_request') as IntentGatewayDecision['turnRelation'],
    resolution: (action.resolution ?? 'ready') as IntentGatewayDecision['resolution'],
    missingFields: action.missingFields ?? [],
    executionClass: 'tool_orchestration',
    preferredTier: 'external',
    requiresRepoGrounding: false,
    requiresToolSynthesis: true,
    expectedContextPressure: 'medium',
    preferredAnswerPath: 'tool_loop',
    simpleVsComplex: 'complex',
    ...(action.provenance ? { provenance: action.provenance } : {}),
    entities: action.entities ?? {},
  };
}

function cloneChatContinuationPayload(
  payload: ChatContinuationPayload,
): Record<string, unknown> {
  if (payload.type === 'suspended_tool_loop') {
    return {
      ...payload,
      llmMessages: payload.llmMessages.map((message) => ({
        ...message,
        ...(message.toolCalls ? { toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })) } : {}),
      })),
      pendingTools: payload.pendingTools.map((tool) => ({ ...tool })),
      originalMessage: {
        ...payload.originalMessage,
        ...(payload.originalMessage.metadata ? { metadata: { ...payload.originalMessage.metadata } } : {}),
      },
      activeSkillIds: [...payload.activeSkillIds],
      taintReasons: [...payload.taintReasons],
      ...(payload.codeContext ? { codeContext: { ...payload.codeContext } } : {}),
      ...(payload.selectedExecutionProfile
        ? {
            selectedExecutionProfile: {
              ...payload.selectedExecutionProfile,
              fallbackProviderOrder: [...payload.selectedExecutionProfile.fallbackProviderOrder],
            },
          }
        : {}),
    };
  }
  return {
    ...payload,
    ...(payload.codeContext ? { codeContext: { ...payload.codeContext } } : {}),
  };
}

function describeChatContinuationPayload(
  payload: ChatContinuationPayload,
): { label: string; preview: string; refs: string[] } {
  switch (payload.type) {
    case 'filesystem_save_output':
      return {
        label: 'Filesystem save continuation',
        preview: `Resume save to ${payload.targetPath}.`,
        refs: [payload.targetPath],
      };
    case 'automation_authoring':
      return {
        label: 'Automation authoring continuation',
        preview: 'Resume automation authoring after policy remediation.',
        refs: [],
      };
    case 'suspended_tool_loop':
      return {
        label: 'Tool-loop continuation',
        preview: `Resume ${payload.pendingTools.length} approved tool call${payload.pendingTools.length === 1 ? '' : 's'}.`,
        refs: payload.pendingTools.map((tool) => tool.name),
      };
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
