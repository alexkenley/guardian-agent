import type { IntentGatewayDecision } from '../intent/types.js';

export type ExecutionGraphStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_clarification'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ExecutionNodeKind =
  | 'classify'
  | 'plan'
  | 'explore_readonly'
  | 'synthesize'
  | 'mutate'
  | 'approval_interrupt'
  | 'delegated_worker'
  | 'verify'
  | 'recover'
  | 'finalize';

export type ExecutionNodeStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_clarification'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ExecutionArtifactType =
  | 'SearchResultSet'
  | 'FileReadSet'
  | 'EvidenceLedger'
  | 'SynthesisDraft'
  | 'WriteSpec'
  | 'MutationReceipt'
  | 'VerificationResult'
  | 'RecoveryProposal';

export interface ExecutionSecurityContext {
  agentId?: string;
  userId?: string;
  channel?: string;
  surfaceId?: string;
  codeSessionId?: string;
  agentIdentity?: {
    agentId: string;
    registryEntryId?: string;
    version?: string;
    policySetId?: string;
    allowedMemoryScopes?: string[];
  };
  contentTrustLevel?: 'trusted' | 'low_trust' | 'quarantined';
  taintReasons?: string[];
}

export interface ExecutionGraphTrigger {
  type: 'user_request' | 'manual' | 'scheduled' | 'event';
  source?: string;
  sourceId?: string;
}

export interface ExecutionNode {
  nodeId: string;
  graphId: string;
  kind: ExecutionNodeKind;
  status: ExecutionNodeStatus;
  title: string;
  requiredInputIds: string[];
  outputArtifactTypes: ExecutionArtifactType[];
  allowedToolCategories: string[];
  approvalPolicy?: 'none' | 'if_required' | 'always';
  checkpointPolicy?: 'phase_boundary' | 'interval' | 'terminal_only';
  executionProfileName?: string;
  ownerAgentId?: string;
  policySetId?: string;
  timeoutMs?: number;
  retryLimit?: number;
  startedAt?: number;
  completedAt?: number;
  terminalReason?: string;
}

export interface ExecutionEdge {
  edgeId: string;
  graphId: string;
  fromNodeId: string;
  toNodeId: string;
  artifactIds?: string[];
}

export interface ExecutionArtifactRef {
  artifactId: string;
  graphId: string;
  nodeId: string;
  artifactType: ExecutionArtifactType;
  label: string;
  preview?: string;
  trustLevel?: 'trusted' | 'low_trust' | 'quarantined';
  taintReasons?: string[];
  redactionPolicy?: string;
  createdAt: number;
}

export interface ExecutionCheckpointRef {
  checkpointId: string;
  graphId: string;
  eventId: string;
  sequence: number;
  reason: 'phase_boundary' | 'approval_interrupt' | 'clarification_interrupt' | 'terminal' | 'interval';
  status: ExecutionGraphStatus;
  createdAt: number;
}

export interface ExecutionGraph {
  graphId: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  requestId: string;
  runId?: string;
  createdAt: number;
  updatedAt: number;
  status: ExecutionGraphStatus;
  intent: IntentGatewayDecision;
  securityContext: ExecutionSecurityContext;
  trigger: ExecutionGraphTrigger;
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
  artifacts: ExecutionArtifactRef[];
  checkpoints: ExecutionCheckpointRef[];
}
