import { scanWriteContent } from '../../guardian/argument-sanitizer.js';
import type { ToolExecutionRequest } from '../../tools/types.js';
import {
  artifactRefFromArtifact,
  buildMutationReceiptArtifact,
  type ExecutionArtifact,
  type MutationReceiptContent,
  type VerificationResultContent,
  type WriteSpecContent,
} from './graph-artifacts.js';
import { createExecutionGraphEvent, type ExecutionGraphEvent } from './graph-events.js';
import type { ExecutionNodeKind } from './types.js';
import { buildWriteMutationVerificationArtifact } from './node-verifier.js';

export type SupervisorToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
  request: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
) => Promise<Record<string, unknown>>;

export interface MutationNodeExecutionContext {
  graphId: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  requestId: string;
  runId?: string;
  nodeId: string;
  channel?: string;
  agentId?: string;
  userId?: string;
  codeSessionId?: string;
  verificationNodeId?: string;
  sequenceStart?: number;
  now?: () => number;
  emit?: (event: ExecutionGraphEvent) => void;
}

export interface ExecuteWriteSpecMutationNodeInput {
  writeSpec: ExecutionArtifact<WriteSpecContent>;
  executeTool: SupervisorToolExecutor;
  toolRequest: Omit<ToolExecutionRequest, 'toolName' | 'args'>;
  context: MutationNodeExecutionContext;
  verifyReadBack?: boolean;
}

export interface ExecuteWriteSpecMutationNodeResult {
  status: 'succeeded' | 'failed' | 'awaiting_approval';
  receiptArtifact?: ExecutionArtifact<MutationReceiptContent>;
  verificationArtifact?: ExecutionArtifact<VerificationResultContent>;
  events: ExecutionGraphEvent[];
}

export interface ResumeWriteSpecMutationNodeAfterApprovalInput {
  writeSpec: ExecutionArtifact<WriteSpecContent>;
  approvedToolResult: Record<string, unknown>;
  executeTool: SupervisorToolExecutor;
  toolRequest: Omit<ToolExecutionRequest, 'toolName' | 'args'>;
  context: MutationNodeExecutionContext;
  verifyReadBack?: boolean;
  approvalId?: string;
}

export async function executeWriteSpecMutationNode(
  input: ExecuteWriteSpecMutationNodeInput,
): Promise<ExecuteWriteSpecMutationNodeResult> {
  const events: ExecutionGraphEvent[] = [];
  let sequence = input.context.sequenceStart ?? 0;
  const now = input.context.now ?? Date.now;
  const emitForNode = (
    kind: ExecutionGraphEvent['kind'],
    payload: Record<string, unknown>,
    eventKey: string,
    nodeId = input.context.nodeId,
    nodeKind: ExecutionNodeKind = 'mutate',
  ): ExecutionGraphEvent => {
    sequence += 1;
    const event = createExecutionGraphEvent({
      ...baseEventContext(input.context),
      eventId: `${input.context.graphId}:${nodeId}:${eventKey}:${sequence}`,
      nodeId,
      nodeKind,
      kind,
      timestamp: now(),
      sequence,
      producer: 'supervisor',
      payload,
    });
    events.push(event);
    input.context.emit?.(event);
    return event;
  };
  const emit = (kind: ExecutionGraphEvent['kind'], payload: Record<string, unknown>, eventKey: string): ExecutionGraphEvent => (
    emitForNode(kind, payload, eventKey)
  );
  const emitArtifactForNode = (
    artifact: ExecutionArtifact,
    nodeId = input.context.nodeId,
    nodeKind: ExecutionNodeKind = 'mutate',
  ): ExecutionGraphEvent => {
    sequence += 1;
    const artifactRef = artifactRefFromArtifact(artifact);
    const event = createExecutionGraphEvent({
      ...baseEventContext(input.context),
      eventId: `${input.context.graphId}:${nodeId}:artifact:${artifact.artifactId}:${sequence}`,
      nodeId,
      nodeKind,
      kind: 'artifact_created',
      timestamp: now(),
      sequence,
      producer: 'supervisor',
      payload: {
        artifactId: artifactRef.artifactId,
        artifactType: artifactRef.artifactType,
        label: artifactRef.label,
        ...(artifactRef.preview ? { preview: artifactRef.preview } : {}),
        ...(artifactRef.trustLevel ? { trustLevel: artifactRef.trustLevel } : {}),
        ...(artifactRef.taintReasons ? { taintReasons: artifactRef.taintReasons } : {}),
        ...(artifactRef.redactionPolicy ? { redactionPolicy: artifactRef.redactionPolicy } : {}),
      },
    });
    events.push(event);
    input.context.emit?.(event);
    return event;
  };
  const emitArtifact = (artifact: ExecutionArtifact): ExecutionGraphEvent => emitArtifactForNode(artifact);

  emit('node_started', {
    writeSpecArtifactId: input.writeSpec.artifactId,
    path: input.writeSpec.content.path,
    append: input.writeSpec.content.append,
  }, 'node-started');

  const validationFailure = validateWriteSpecForMutation(input.writeSpec);
  if (validationFailure) {
    emit('node_failed', {
      reason: validationFailure,
      writeSpecArtifactId: input.writeSpec.artifactId,
    }, 'node-failed');
    return { status: 'failed', events };
  }

  emit('tool_call_started', {
    toolName: 'fs_write',
    writeSpecArtifactId: input.writeSpec.artifactId,
    argsPreview: {
      path: input.writeSpec.content.path,
      append: input.writeSpec.content.append,
      contentHash: input.writeSpec.content.contentHash,
      contentBytes: input.writeSpec.content.contentBytes,
    },
  }, 'fs-write-started');

  const toolResult = await input.executeTool('fs_write', {
    path: input.writeSpec.content.path,
    content: input.writeSpec.content.content,
    append: input.writeSpec.content.append,
  }, input.toolRequest);

  emit('tool_call_completed', {
    toolName: 'fs_write',
    writeSpecArtifactId: input.writeSpec.artifactId,
    resultStatus: stringValue(toolResult.status) || (toolResult.success === true ? 'succeeded' : 'failed'),
    ...(stringValue(toolResult.message) ? { resultMessage: stringValue(toolResult.message) } : {}),
    ...(stringValue(toolResult.error) ? { errorMessage: stringValue(toolResult.error) } : {}),
    ...(stringValue(toolResult.jobId) ? { jobId: stringValue(toolResult.jobId) } : {}),
    ...(stringValue(toolResult.approvalId) ? { approvalId: stringValue(toolResult.approvalId) } : {}),
  }, 'fs-write-completed');

  const receiptArtifact = buildMutationReceiptArtifact({
    graphId: input.context.graphId,
    nodeId: input.context.nodeId,
    artifactId: `${input.context.graphId}:${input.context.nodeId}:mutation-receipt`,
    writeSpec: input.writeSpec,
    toolResult,
    createdAt: now(),
  });
  emitArtifact(receiptArtifact);

  if (receiptArtifact.content.status === 'pending_approval' || receiptArtifact.content.approvalId) {
    emit('approval_requested', {
      approvalId: receiptArtifact.content.approvalId,
      jobId: receiptArtifact.content.jobId,
      toolName: 'fs_write',
      writeSpecArtifactId: input.writeSpec.artifactId,
      path: input.writeSpec.content.path,
    }, 'approval-requested');
    return { status: 'awaiting_approval', receiptArtifact, events };
  }

  if (!receiptArtifact.content.success || receiptArtifact.content.status !== 'succeeded') {
    emit('node_failed', {
      reason: receiptArtifact.content.error || receiptArtifact.content.message || 'fs_write failed.',
      receiptArtifactId: receiptArtifact.artifactId,
    }, 'node-failed');
    return { status: 'failed', receiptArtifact, events };
  }

  const verificationNodeId = input.context.verificationNodeId;
  const verificationEmitter = verificationNodeId
    ? (kind: ExecutionGraphEvent['kind'], payload: Record<string, unknown>, eventKey: string) => (
        emitForNode(kind, payload, eventKey, verificationNodeId, 'verify')
      )
    : emit;
  if (verificationNodeId) {
    emit('node_completed', {
      receiptArtifactId: receiptArtifact.artifactId,
      path: input.writeSpec.content.path,
      verificationNodeId,
    }, 'node-completed');
    verificationEmitter('node_started', {
      writeSpecArtifactId: input.writeSpec.artifactId,
      receiptArtifactId: receiptArtifact.artifactId,
      path: input.writeSpec.content.path,
    }, 'node-started');
  }

  const readBackResult = input.verifyReadBack === false
    ? null
    : await executeReadBack({
      input,
      emit: verificationEmitter,
    });
  const verificationArtifactNodeId = verificationNodeId ?? input.context.nodeId;
  const verificationArtifact = buildWriteMutationVerificationArtifact({
    graphId: input.context.graphId,
    nodeId: verificationArtifactNodeId,
    artifactId: `${input.context.graphId}:${verificationArtifactNodeId}:verification`,
    writeSpec: input.writeSpec,
    receipt: receiptArtifact,
    readBackResult,
    createdAt: now(),
  });
  emitArtifactForNode(
    verificationArtifact,
    verificationArtifactNodeId,
    verificationNodeId ? 'verify' : 'mutate',
  );
  verificationEmitter('verification_completed', {
    verificationArtifactId: verificationArtifact.artifactId,
    valid: verificationArtifact.content.valid,
    checkCount: verificationArtifact.content.checks.length,
    failedChecks: verificationArtifact.content.checks
      .filter((check) => check.status === 'failed')
      .map((check) => check.name),
  }, 'verification-completed');

  if (!verificationArtifact.content.valid) {
    verificationEmitter('node_failed', {
      reason: 'Mutation verification failed.',
      verificationArtifactId: verificationArtifact.artifactId,
    }, 'node-failed');
    return { status: 'failed', receiptArtifact, verificationArtifact, events };
  }

  verificationEmitter('node_completed', {
    receiptArtifactId: receiptArtifact.artifactId,
    verificationArtifactId: verificationArtifact.artifactId,
    path: input.writeSpec.content.path,
  }, 'node-completed');
  return { status: 'succeeded', receiptArtifact, verificationArtifact, events };
}

export async function resumeWriteSpecMutationNodeAfterApproval(
  input: ResumeWriteSpecMutationNodeAfterApprovalInput,
): Promise<ExecuteWriteSpecMutationNodeResult> {
  const events: ExecutionGraphEvent[] = [];
  let sequence = input.context.sequenceStart ?? 0;
  const now = input.context.now ?? Date.now;
  const emitForNode = (
    kind: ExecutionGraphEvent['kind'],
    payload: Record<string, unknown>,
    eventKey: string,
    nodeId = input.context.nodeId,
    nodeKind: ExecutionNodeKind = 'mutate',
  ): ExecutionGraphEvent => {
    sequence += 1;
    const event = createExecutionGraphEvent({
      ...baseEventContext(input.context),
      eventId: `${input.context.graphId}:${nodeId}:${eventKey}:${sequence}`,
      nodeId,
      nodeKind,
      kind,
      timestamp: now(),
      sequence,
      producer: 'supervisor',
      payload,
    });
    events.push(event);
    input.context.emit?.(event);
    return event;
  };
  const emit = (kind: ExecutionGraphEvent['kind'], payload: Record<string, unknown>, eventKey: string): ExecutionGraphEvent => (
    emitForNode(kind, payload, eventKey)
  );
  const emitArtifactForNode = (
    artifact: ExecutionArtifact,
    nodeId = input.context.nodeId,
    nodeKind: ExecutionNodeKind = 'mutate',
  ): ExecutionGraphEvent => {
    sequence += 1;
    const artifactRef = artifactRefFromArtifact(artifact);
    const event = createExecutionGraphEvent({
      ...baseEventContext(input.context),
      eventId: `${input.context.graphId}:${nodeId}:artifact:${artifact.artifactId}:${sequence}`,
      nodeId,
      nodeKind,
      kind: 'artifact_created',
      timestamp: now(),
      sequence,
      producer: 'supervisor',
      payload: {
        artifactId: artifactRef.artifactId,
        artifactType: artifactRef.artifactType,
        label: artifactRef.label,
        ...(artifactRef.preview ? { preview: artifactRef.preview } : {}),
        ...(artifactRef.trustLevel ? { trustLevel: artifactRef.trustLevel } : {}),
        ...(artifactRef.taintReasons ? { taintReasons: artifactRef.taintReasons } : {}),
        ...(artifactRef.redactionPolicy ? { redactionPolicy: artifactRef.redactionPolicy } : {}),
      },
    });
    events.push(event);
    input.context.emit?.(event);
    return event;
  };
  const emitArtifact = (artifact: ExecutionArtifact): ExecutionGraphEvent => emitArtifactForNode(artifact);

  emit('approval_resolved', {
    approvalId: input.approvalId,
    toolName: 'fs_write',
    writeSpecArtifactId: input.writeSpec.artifactId,
    path: input.writeSpec.content.path,
    resultStatus: stringValue(input.approvedToolResult.status)
      || (input.approvedToolResult.success === true ? 'succeeded' : 'failed'),
  }, 'approval-resolved');

  const receiptArtifact = buildMutationReceiptArtifact({
    graphId: input.context.graphId,
    nodeId: input.context.nodeId,
    artifactId: `${input.context.graphId}:${input.context.nodeId}:mutation-receipt:approved:${input.approvalId ?? 'approval'}`,
    writeSpec: input.writeSpec,
    toolResult: input.approvedToolResult,
    createdAt: now(),
  });
  emitArtifact(receiptArtifact);

  if (!receiptArtifact.content.success || receiptArtifact.content.status !== 'succeeded') {
    emit('node_failed', {
      reason: receiptArtifact.content.error || receiptArtifact.content.message || 'Approved mutation did not complete successfully.',
      receiptArtifactId: receiptArtifact.artifactId,
    }, 'node-failed');
    return { status: 'failed', receiptArtifact, events };
  }

  const executionInput: ExecuteWriteSpecMutationNodeInput = {
    writeSpec: input.writeSpec,
    executeTool: input.executeTool,
    toolRequest: input.toolRequest,
    context: input.context,
    verifyReadBack: input.verifyReadBack,
  };
  const verificationNodeId = input.context.verificationNodeId;
  const verificationEmitter = verificationNodeId
    ? (kind: ExecutionGraphEvent['kind'], payload: Record<string, unknown>, eventKey: string) => (
        emitForNode(kind, payload, eventKey, verificationNodeId, 'verify')
      )
    : emit;
  if (verificationNodeId) {
    emit('node_completed', {
      receiptArtifactId: receiptArtifact.artifactId,
      path: input.writeSpec.content.path,
      verificationNodeId,
    }, 'node-completed');
    verificationEmitter('node_started', {
      writeSpecArtifactId: input.writeSpec.artifactId,
      receiptArtifactId: receiptArtifact.artifactId,
      path: input.writeSpec.content.path,
    }, 'node-started');
  }
  const readBackResult = input.verifyReadBack === false
    ? null
    : await executeReadBack({
      input: executionInput,
      emit: verificationEmitter,
    });
  const verificationArtifactNodeId = verificationNodeId ?? input.context.nodeId;
  const verificationArtifact = buildWriteMutationVerificationArtifact({
    graphId: input.context.graphId,
    nodeId: verificationArtifactNodeId,
    artifactId: `${input.context.graphId}:${verificationArtifactNodeId}:verification`,
    writeSpec: input.writeSpec,
    receipt: receiptArtifact,
    readBackResult,
    createdAt: now(),
  });
  emitArtifactForNode(
    verificationArtifact,
    verificationArtifactNodeId,
    verificationNodeId ? 'verify' : 'mutate',
  );
  verificationEmitter('verification_completed', {
    verificationArtifactId: verificationArtifact.artifactId,
    valid: verificationArtifact.content.valid,
    checkCount: verificationArtifact.content.checks.length,
    failedChecks: verificationArtifact.content.checks
      .filter((check) => check.status === 'failed')
      .map((check) => check.name),
  }, 'verification-completed');

  if (!verificationArtifact.content.valid) {
    verificationEmitter('node_failed', {
      reason: 'Mutation verification failed after approval.',
      verificationArtifactId: verificationArtifact.artifactId,
    }, 'node-failed');
    return { status: 'failed', receiptArtifact, verificationArtifact, events };
  }

  verificationEmitter('node_completed', {
    receiptArtifactId: receiptArtifact.artifactId,
    verificationArtifactId: verificationArtifact.artifactId,
    path: input.writeSpec.content.path,
  }, 'node-completed');
  return { status: 'succeeded', receiptArtifact, verificationArtifact, events };
}

function validateWriteSpecForMutation(writeSpec: ExecutionArtifact<WriteSpecContent>): string | null {
  if (writeSpec.artifactType !== 'WriteSpec') {
    return `Mutation node requires a WriteSpec artifact, received ${writeSpec.artifactType}.`;
  }
  if (writeSpec.content.operation !== 'write_file') {
    return `Unsupported WriteSpec operation: ${writeSpec.content.operation}.`;
  }
  if (!writeSpec.content.path.trim()) {
    return 'WriteSpec path is empty.';
  }
  if (writeSpec.trustLevel === 'quarantined') {
    return 'WriteSpec content is quarantined and cannot be used for mutation.';
  }
  if (writeSpec.redactionPolicy === 'no_secret_values') {
    const scan = scanWriteContent(writeSpec.content.content);
    if (scan.secrets.length > 0 || scan.pii.length > 0) {
      const findings = [
        ...new Set(scan.secrets.map((match) => match.pattern)),
        ...new Set(scan.pii.map((match) => match.label)),
      ];
      return `WriteSpec rejected by redaction policy: ${findings.join(', ')}.`;
    }
  }
  return null;
}

async function executeReadBack(input: {
  input: ExecuteWriteSpecMutationNodeInput;
  emit: (kind: ExecutionGraphEvent['kind'], payload: Record<string, unknown>, eventKey: string) => ExecutionGraphEvent;
}): Promise<Record<string, unknown>> {
  const maxBytes = Math.max(256, input.input.writeSpec.content.contentBytes + 1_024);
  input.emit('tool_call_started', {
    toolName: 'fs_read',
    phase: 'verification_readback',
    writeSpecArtifactId: input.input.writeSpec.artifactId,
    argsPreview: {
      path: input.input.writeSpec.content.path,
      maxBytes,
    },
  }, 'fs-read-started');
  const result = await input.input.executeTool('fs_read', {
    path: input.input.writeSpec.content.path,
    maxBytes,
  }, input.input.toolRequest);
  input.emit('tool_call_completed', {
    toolName: 'fs_read',
    phase: 'verification_readback',
    resultStatus: stringValue(result.status) || (result.success === true ? 'succeeded' : 'failed'),
    ...(stringValue(result.message) ? { resultMessage: stringValue(result.message) } : {}),
    ...(stringValue(result.error) ? { errorMessage: stringValue(result.error) } : {}),
    ...(stringValue(result.jobId) ? { jobId: stringValue(result.jobId) } : {}),
  }, 'fs-read-completed');
  return result;
}

function baseEventContext(context: MutationNodeExecutionContext): Omit<
  Parameters<typeof createExecutionGraphEvent>[0],
  'eventId' | 'kind' | 'timestamp' | 'sequence' | 'producer' | 'payload' | 'nodeId' | 'nodeKind'
> {
  return {
    graphId: context.graphId,
    executionId: context.executionId,
    rootExecutionId: context.rootExecutionId,
    ...(context.parentExecutionId ? { parentExecutionId: context.parentExecutionId } : {}),
    requestId: context.requestId,
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.channel ? { channel: context.channel } : {}),
    ...(context.agentId ? { agentId: context.agentId } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.codeSessionId ? { codeSessionId: context.codeSessionId } : {}),
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
