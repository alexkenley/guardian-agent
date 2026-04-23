export type ExecutionNodeKind =
  | 'delegation'
  | 'tool_execution'
  | 'verification'
  | 'interruption'
  | 'synthesis'
  | 'completion';

export type ExecutionNodeStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed';

export interface ProviderSelectionSnapshot {
  requestedProviderName?: string;
  requestedTier?: 'local' | 'external';
  resolvedProviderName?: string;
  resolvedProviderType?: string;
  resolvedProviderModel?: string;
  resolvedProviderProfileName?: string;
  resolvedProviderTier?: string;
  resolvedProviderLocality?: 'local' | 'external';
  selectionSource?: string;
  defaultProviderName?: string;
}

export type DelegatedTaskContractKind =
  | 'general_answer'
  | 'tool_execution'
  | 'repo_inspection'
  | 'filesystem_mutation'
  | 'security_analysis';

export type PlannedStepKind =
  | 'tool_call'
  | 'write'
  | 'read'
  | 'search'
  | 'memory_save'
  | 'answer';

export interface PlannedStep {
  stepId: string;
  kind: PlannedStepKind;
  summary: string;
  expectedToolCategories?: string[];
  required: boolean;
  dependsOn?: string[];
}

export interface PlannedTask {
  planId: string;
  steps: PlannedStep[];
  allowAdditionalSteps: boolean;
}

export interface StepReceipt {
  stepId: string;
  status: 'satisfied' | 'failed' | 'blocked' | 'skipped';
  evidenceReceiptIds: string[];
  interruptionId?: string;
  summary: string;
  startedAt: number;
  endedAt: number;
}

export type WorkerStopReason =
  | 'end_turn'
  | 'tool_use_pending'
  | 'max_tokens'
  | 'max_rounds'
  | 'approval_required'
  | 'error';

export type WorkerRunStatus =
  | 'completed'
  | 'suspended'
  | 'incomplete'
  | 'failed'
  | 'max_turns';

export interface DelegatedTaskContract {
  kind: DelegatedTaskContractKind;
  route?: string;
  operation?: string;
  requiresEvidence: boolean;
  allowsAnswerFirst: boolean;
  requireExactFileReferences: boolean;
  answerConstraints?: AnswerConstraints;
  summary?: string;
  plan: PlannedTask;
}

export interface ExecutionRecordV2 {
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  scope: {
    assistantId?: string;
    userId?: string;
    channel?: string;
    surfaceId?: string;
    codeSessionId?: string;
  };
  routedIntent?: {
    route?: string;
    operation?: string;
    summary?: string;
  };
  providerSelection?: ProviderSelectionSnapshot;
  taskContract: DelegatedTaskContract;
  state: ExecutionNodeStatus;
  activeNodeId?: string;
  interruptionIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ExecutionNode {
  nodeId: string;
  executionId: string;
  parentNodeId?: string;
  kind: ExecutionNodeKind;
  status: ExecutionNodeStatus;
  startedAt: number;
  endedAt?: number;
  summary: string;
}

export type ExecutionEventType =
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'interruption_requested'
  | 'interruption_resolved'
  | 'claim_emitted'
  | 'verification_decided';

export interface ExecutionEvent {
  eventId: string;
  executionId?: string;
  nodeId?: string;
  type: ExecutionEventType;
  timestamp: number;
  payload: Record<string, unknown>;
}

export type EvidenceReceiptStatus =
  | 'succeeded'
  | 'failed'
  | 'pending_approval'
  | 'blocked';

export type EvidenceSourceType =
  | 'tool_call'
  | 'interruption'
  | 'artifact'
  | 'model_answer';

export interface EvidenceReceipt {
  receiptId: string;
  sourceType: EvidenceSourceType;
  toolName?: string;
  artifactType?: string;
  status: EvidenceReceiptStatus;
  refs: string[];
  summary: string;
  startedAt: number;
  endedAt: number;
}

export type ClaimKind =
  | 'file_reference'
  | 'implementation_file'
  | 'symbol_reference'
  | 'filesystem_mutation'
  | 'security_finding'
  | 'provider_selection'
  | 'answer';

export interface AnswerConstraints {
  requiresImplementationFiles?: boolean;
  requiresSymbolNames?: boolean;
  readonly?: boolean;
  requestedSymbols?: string[];
}

export interface Claim {
  claimId: string;
  kind: ClaimKind;
  subject: string;
  value: string;
  evidenceReceiptIds: string[];
  confidence?: number;
}

export type InterruptionKind =
  | 'approval'
  | 'clarification'
  | 'workspace_switch'
  | 'policy_blocked';

export interface Interruption {
  interruptionId: string;
  kind: InterruptionKind;
  prompt: string;
  options?: Array<{ value: string; label: string }>;
  approvalSummaries?: Array<{ id: string; toolName: string; argsPreview?: string }>;
  resumeToken?: string;
}

export type VerificationDecisionValue =
  | 'satisfied'
  | 'blocked'
  | 'insufficient'
  | 'contradicted'
  | 'policy_blocked';

export interface VerificationDecision {
  decision: VerificationDecisionValue;
  reasons: string[];
  retryable: boolean;
  requiredNextAction?: string;
  missingEvidenceKinds?: string[];
  unsatisfiedStepIds?: string[];
  qualityNotes?: string[];
}

export interface DelegatedResultEnvelope {
  taskContract: DelegatedTaskContract;
  runStatus: WorkerRunStatus;
  stopReason: WorkerStopReason;
  stepReceipts: StepReceipt[];
  finalUserAnswer?: string;
  operatorSummary: string;
  claims: Claim[];
  evidenceReceipts: EvidenceReceipt[];
  interruptions: Interruption[];
  artifacts: Array<{
    artifactId: string;
    artifactType: string;
    label: string;
    refs?: string[];
  }>;
  modelProvenance?: ProviderSelectionSnapshot;
  events: ExecutionEvent[];
  verification?: VerificationDecision;
}
