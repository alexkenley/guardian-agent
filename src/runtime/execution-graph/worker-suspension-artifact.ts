import type { ExecutionArtifact } from './graph-artifacts.js';
import type { WorkerSuspensionEnvelope } from '../worker-suspension.js';
import {
  readWorkerSuspensionEnvelope,
  serializeWorkerSuspensionEnvelope,
} from '../worker-suspension.js';

export interface WorkerSuspensionArtifactContent extends Record<string, unknown> {
  version: 1;
  resume: Record<string, unknown>;
  session: Record<string, unknown>;
}

export function buildWorkerSuspensionArtifact(input: {
  graphId: string;
  nodeId: string;
  artifactId?: string;
  envelope: WorkerSuspensionEnvelope;
  createdAt: number;
}): ExecutionArtifact<WorkerSuspensionArtifactContent> {
  const approvalIds = input.envelope.resume.approvalIds;
  const content = serializeWorkerSuspensionEnvelope(input.envelope) as WorkerSuspensionArtifactContent;
  return {
    artifactId: input.artifactId ?? `${input.graphId}:${input.nodeId}:worker-suspension:${approvalIds.join(',') || 'approval'}`,
    graphId: input.graphId,
    nodeId: input.nodeId,
    artifactType: 'WorkerSuspension',
    label: 'Worker suspension',
    preview: `Suspended worker ${input.envelope.session.kind} session awaiting ${approvalIds.length} approval(s).`,
    refs: approvalIds,
    trustLevel: 'trusted',
    taintReasons: [],
    redactionPolicy: 'worker_suspension_internal_state',
    content,
    createdAt: input.createdAt,
  };
}

export function readWorkerSuspensionArtifact(
  artifact: ExecutionArtifact | null | undefined,
): WorkerSuspensionEnvelope | null {
  if (!artifact || artifact.artifactType !== 'WorkerSuspension') return null;
  return readWorkerSuspensionEnvelope(artifact.content);
}
