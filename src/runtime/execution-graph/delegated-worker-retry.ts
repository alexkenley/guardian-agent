import type { PromptAssemblyAdditionalSection } from '../context-assembly.js';
import type { SelectedExecutionProfile } from '../execution-profiles.js';
import type {
  DelegatedResultEnvelope,
  VerificationDecision,
} from '../execution/types.js';
import {
  filterDependencySatisfiedStepReceipts,
  readUnsatisfiedRequiredSteps,
} from '../execution/task-plan.js';
import type {
  IntentGatewayDecision,
  IntentGatewayRecord,
} from '../intent-gateway.js';

export interface DelegatedResultSufficiencyFailure {
  decision: VerificationDecision;
  failureSummary: string;
  retryReason: string;
  unsatisfiedSteps: Array<{
    stepId: string;
    kind?: string;
    summary: string;
    status: 'missing' | 'failed' | 'blocked';
    reason?: string;
  }>;
  satisfiedSteps: Array<{
    stepId: string;
    summary: string;
    refs?: string[];
  }>;
}

export function shouldAdoptDelegatedTaskContract(
  current: DelegatedResultEnvelope['taskContract'],
  candidate: DelegatedResultEnvelope['taskContract'],
): boolean {
  if (candidate.plan.steps.length <= 0) {
    return false;
  }
  if (current.kind !== candidate.kind) {
    return false;
  }
  if (current.route && candidate.route && current.route !== candidate.route) {
    return false;
  }
  if (current.operation && candidate.operation && current.operation !== candidate.operation) {
    return false;
  }
  return candidate.plan.planId !== current.plan.planId
    || candidate.plan.steps.length !== current.plan.steps.length
    || candidate.plan.steps.some((step, index) => {
      const currentStep = current.plan.steps[index];
      return !currentStep
        || currentStep.kind !== step.kind
        || currentStep.summary !== step.summary;
    })
    || ((candidate.summary?.trim() ?? '') !== (current.summary?.trim() ?? ''));
}

export function buildDelegatedRetryIntentGatewayRecord(input: {
  baseRecord: IntentGatewayRecord | null | undefined;
  baseDecision: IntentGatewayDecision | undefined;
  taskContract: DelegatedResultEnvelope['taskContract'];
}): IntentGatewayRecord | null {
  const plannedSteps = clonePlannedStepsFromTaskContract(input.taskContract);
  if (!plannedSteps || plannedSteps.length <= 0) {
    return input.baseRecord ?? null;
  }
  const baseDecision = input.baseDecision ?? input.baseRecord?.decision;
  if (!baseDecision) {
    return input.baseRecord ?? null;
  }
  return {
    mode: input.baseRecord?.mode ?? 'confirmation',
    available: input.baseRecord?.available ?? true,
    model: input.baseRecord?.model ?? 'delegated.retry',
    latencyMs: input.baseRecord?.latencyMs ?? 0,
    ...(input.baseRecord?.promptProfile ? { promptProfile: input.baseRecord.promptProfile } : {}),
    decision: {
      ...baseDecision,
      ...(input.taskContract.route ? { route: input.taskContract.route as IntentGatewayDecision['route'] } : {}),
      ...(input.taskContract.operation ? { operation: input.taskContract.operation as IntentGatewayDecision['operation'] } : {}),
      ...(input.taskContract.summary?.trim() ? { summary: input.taskContract.summary.trim() } : {}),
      requireExactFileReferences: input.taskContract.requireExactFileReferences,
      plannedSteps,
    },
  };
}

export function buildDelegatedRetryableFailure(
  decision: VerificationDecision,
  envelope: DelegatedResultEnvelope,
): DelegatedResultSufficiencyFailure | null {
  if (!decision.retryable) return null;
  if (decision.decision !== 'insufficient' && decision.decision !== 'contradicted') return null;
  const unsatisfiedSteps = collectDelegatedUnsatisfiedSteps(envelope, decision);
  const satisfiedSteps = collectDelegatedSatisfiedSteps(envelope);
  return {
    decision,
    failureSummary: buildDelegatedFailureSummaryFromDecision(decision, envelope, unsatisfiedSteps),
    retryReason: buildDelegatedRetryReason(decision, unsatisfiedSteps),
    unsatisfiedSteps,
    satisfiedSteps,
  };
}

export function isDelegatedAnswerSynthesisRetry(
  insufficiency: DelegatedResultSufficiencyFailure,
): boolean {
  const missingEvidenceKinds = insufficiency.decision.missingEvidenceKinds ?? [];
  const hasOnlyAnswerEvidenceMissing = missingEvidenceKinds.length === 0
    || missingEvidenceKinds.every((kind) => kind === 'answer');
  const hasExplicitAnswerStepRemaining = insufficiency.unsatisfiedSteps.length > 0
    && insufficiency.unsatisfiedSteps.every((step) => !step.kind || step.kind === 'answer');
  const hasImplicitAnswerOnlyGap = insufficiency.unsatisfiedSteps.length === 0
    && missingEvidenceKinds.includes('answer');
  return hasOnlyAnswerEvidenceMissing
    && insufficiency.satisfiedSteps.length > 0
    && (hasExplicitAnswerStepRemaining || hasImplicitAnswerOnlyGap);
}

export function shouldRetryDelegatedAnswerSynthesisOnSameProfile(
  insufficiency: DelegatedResultSufficiencyFailure,
  currentProfile: SelectedExecutionProfile | undefined,
): boolean {
  return !!currentProfile && isDelegatedAnswerSynthesisRetry(insufficiency);
}

export function shouldRetryDelegatedCorrectivePassOnSameProfile(
  insufficiency: DelegatedResultSufficiencyFailure,
  currentProfile: SelectedExecutionProfile | undefined,
): boolean {
  if (!currentProfile) return false;
  if (isDelegatedAnswerSynthesisRetry(insufficiency)) return true;
  if (currentProfile.providerTier !== 'managed_cloud') return false;
  const missingEvidenceKinds = insufficiency.decision.missingEvidenceKinds ?? [];
  if (insufficiency.decision.decision === 'insufficient' && isDelegatedToolEvidenceRetry(insufficiency)) {
    return true;
  }
  const onlyAnswerEvidenceMissing = missingEvidenceKinds.length === 0
    || missingEvidenceKinds.every((kind) => kind === 'answer');
  const onlyAnswerStepsUnsatisfied = insufficiency.unsatisfiedSteps.length === 0
    ? missingEvidenceKinds.includes('answer')
    : insufficiency.unsatisfiedSteps.length > 0
    && insufficiency.unsatisfiedSteps.every((step) => !step.kind || step.kind === 'answer');
  return onlyAnswerEvidenceMissing
    && onlyAnswerStepsUnsatisfied
    && insufficiency.decision.decision === 'insufficient';
}

export function isDelegatedToolEvidenceRetry(
  insufficiency: DelegatedResultSufficiencyFailure,
): boolean {
  const missingEvidenceKinds = insufficiency.decision.missingEvidenceKinds ?? [];
  const hasUnsatisfiedNonAnswerStep = insufficiency.unsatisfiedSteps.some((step) => step.kind && step.kind !== 'answer');
  const hasMissingToolEvidence = missingEvidenceKinds.some((kind) => (
    kind === 'tool_call'
      || kind === 'read'
      || kind === 'search'
      || kind === 'runtime_evidence'
      || kind === 'repo_evidence'
      || kind === 'security_evidence'
      || kind === 'execution_evidence'
  ));
  return hasUnsatisfiedNonAnswerStep || hasMissingToolEvidence;
}

export function buildDelegatedRetryDetail(
  targetLabel: string,
  executionProfile: SelectedExecutionProfile | undefined,
  insufficiency: DelegatedResultSufficiencyFailure,
  codeSessionId?: string,
): string {
  const profileLabel = describeDelegatedExecutionProfile(executionProfile);
  const profileSuffix = profileLabel ? ` with ${profileLabel}` : '';
  const sessionSuffix = codeSessionId?.trim() ? ` in code session ${codeSessionId.trim()}` : '';
  return `Retrying ${targetLabel}${profileSuffix}${sessionSuffix} because ${insufficiency.retryReason}`;
}

export function appendDelegatedRetrySection(
  sections: PromptAssemblyAdditionalSection[],
  insufficiency: DelegatedResultSufficiencyFailure,
  options?: { sameProfile?: boolean },
): PromptAssemblyAdditionalSection[] {
  const retryInstruction = options?.sameProfile
    ? 'Retry this once now on the same execution profile, but follow the corrective directive strictly instead of repeating the broad search.'
    : 'Retry this once now using the stronger execution profile.';
  const missingEvidenceKinds = insufficiency.decision.missingEvidenceKinds ?? [];
  const unsatisfiedLines = insufficiency.unsatisfiedSteps.length > 0
    ? insufficiency.unsatisfiedSteps.map((step) => buildDelegatedRetryStepLine(step))
    : ['- none recorded'];
  const satisfiedSummary = insufficiency.satisfiedSteps.length > 0
    ? insufficiency.satisfiedSteps.map((step) => `${step.stepId} (${step.summary})`).join('; ')
    : 'none';
  const satisfiedRefLines = insufficiency.satisfiedSteps
    .filter((step) => Array.isArray(step.refs) && step.refs.length > 0)
    .map((step) => `- ${step.stepId}: ${step.refs?.join(', ')}`);
  if (isDelegatedAnswerSynthesisRetry(insufficiency)) {
    return [
      ...sections,
      {
        section: 'Delegated Retry Directive',
        mode: 'plain',
        content: [
          'The previous delegated attempt gathered the required evidence but did not produce the required final user-facing answer.',
          `Failure mode: ${insufficiency.failureSummary}`,
          'Unsatisfied required steps:',
          ...unsatisfiedLines,
          `Already satisfied evidence steps: ${satisfiedSummary}`,
          ...(satisfiedRefLines.length > 0
            ? [
                'Evidence references from already satisfied steps:',
                ...satisfiedRefLines,
              ]
            : []),
          retryInstruction,
          'This retry is an answer-synthesis retry. Use the evidence already gathered in the previous attempt to satisfy the remaining answer step.',
          'Do not re-run satisfied tool calls unless the remaining answer genuinely cannot be produced from the already satisfied evidence.',
          'Do not ask the user for clarification when the requested answer can be produced from the gathered evidence.',
          'End with a concise answer that directly satisfies every unsatisfied answer step.',
        ].join('\n'),
      },
    ];
  }
  const hasUnsatisfiedWriteStep = missingEvidenceKinds.includes('write')
    || insufficiency.unsatisfiedSteps.some((step) => step.kind === 'write');
  if (hasUnsatisfiedWriteStep) {
    return [
      ...sections,
      {
        section: 'Delegated Retry Directive',
        mode: 'plain',
        content: [
          'The previous delegated attempt did not complete the requested filesystem write.',
          `Failure mode: ${insufficiency.failureSummary}`,
          'Unsatisfied required steps:',
          ...unsatisfiedLines,
          `Already satisfied steps: ${satisfiedSummary}`,
          ...(satisfiedRefLines.length > 0
            ? [
                'Grounded file/path candidates from already satisfied steps:',
                ...satisfiedRefLines,
                'Reuse those grounded candidates before starting any new speculative search.',
              ]
            : []),
          retryInstruction,
          'This retry is not a repo-inspection answer. It is a filesystem mutation retry.',
          'For each unsatisfied write step, call the matching filesystem mutation tool now. For a file create/update/write, use fs_write.',
          'Do not re-run satisfied search or read steps unless the remaining write step cannot be completed from the already satisfied evidence.',
          'After the filesystem write tool succeeds, end with a concise completion message.',
          'Only pause if a real tool result returns pending_approval or another real blocker.',
        ].join('\n'),
      },
    ];
  }
  if (missingEvidenceKinds.includes('execution_evidence')) {
    return [
      ...sections,
      {
        section: 'Delegated Retry Directive',
        mode: 'plain',
        content: [
          'The previous delegated attempt was not sufficient for the user request.',
          `Failure mode: ${insufficiency.failureSummary}`,
          'Unsatisfied required steps:',
          ...unsatisfiedLines,
          `Already satisfied steps: ${satisfiedSummary}`,
          ...(satisfiedRefLines.length > 0
            ? [
                'Grounded file/path candidates from already satisfied steps:',
                ...satisfiedRefLines,
                'Reuse those grounded candidates before starting any new speculative search.',
              ]
            : []),
          retryInstruction,
          'Discovering or listing tools does not satisfy an execution request.',
          'If you used find_tools to load code_remote_exec or another execution tool, call that tool in this retry.',
          'Complete the remaining required steps now. Do not re-run satisfied steps.',
          'Do not ask the user whether to proceed when the original request already told you to run the command or verification step.',
          'Only pause if a real tool result returns pending_approval or another real blocker.',
        ].join('\n'),
      },
    ];
  }
  return [
    ...sections,
    {
      section: 'Delegated Retry Directive',
      mode: 'plain',
      content: [
        'The previous delegated attempt was not sufficient for the user request.',
        `Failure mode: ${insufficiency.failureSummary}`,
        'Unsatisfied required steps:',
        ...unsatisfiedLines,
        `Already satisfied steps: ${satisfiedSummary}`,
        ...(satisfiedRefLines.length > 0
          ? [
              'Grounded file/path candidates from already satisfied steps:',
              ...satisfiedRefLines,
              'Reuse those grounded candidates before starting any new speculative search.',
            ]
          : []),
        retryInstruction,
        'Complete the remaining required steps now. Do not re-run satisfied steps.',
        'Do not ask the user whether to narrow the search. Narrow it yourself.',
        'Use targeted repo inspection and return exact file paths or exact file citations in the final answer.',
        'Do not invent filenames or sibling paths after an ENOENT or a failed read/list call.',
        'Only read or cite paths that came from successful fs_search/fs_list/code_symbol_search results or successful fs_read results.',
        'If you are about to conclude that an implementation path does not exist, enumerate likely directories with fs_list first instead of relying on content search alone.',
        'If a search result is truncated or only reports that matches exist, immediately narrow the scope with fs_list/fs_search/fs_read until you can cite the exact files.',
        'If a later answer step depended on the missing grounding step, redo that answer after you finish the remaining grounding work.',
      ].join('\n'),
    },
  ];
}

export function formatDelegatedStepIds(stepIds: string[]): string {
  return stepIds.join(', ');
}

function clonePlannedStepsFromTaskContract(
  taskContract: DelegatedResultEnvelope['taskContract'],
): NonNullable<IntentGatewayDecision['plannedSteps']> | undefined {
  if (taskContract.plan.steps.length <= 0) {
    return undefined;
  }
  return taskContract.plan.steps.map((step) => ({
    kind: step.kind,
    summary: step.summary,
    ...(step.expectedToolCategories?.length
      ? { expectedToolCategories: [...step.expectedToolCategories] }
      : {}),
    ...(step.required === false ? { required: false } : {}),
    ...(step.dependsOn?.length ? { dependsOn: [...step.dependsOn] } : {}),
  }));
}

function buildDelegatedFailureSummaryFromDecision(
  decision: VerificationDecision,
  envelope: DelegatedResultEnvelope,
  unsatisfiedSteps: DelegatedResultSufficiencyFailure['unsatisfiedSteps'],
): string {
  if (
    envelope.taskContract.requireExactFileReferences
    && unsatisfiedSteps.some((step) => /\bread\b/i.test(step.summary))
  ) {
    return 'Delegated worker did not return the exact file references requested after repo inspection.';
  }
  return decision.reasons[0]?.trim() || 'Delegated worker did not satisfy the task contract.';
}

function buildDelegatedRetryReason(
  decision: VerificationDecision,
  unsatisfiedSteps: DelegatedResultSufficiencyFailure['unsatisfiedSteps'],
): string {
  if (unsatisfiedSteps.length > 0) {
    return `required steps remain unsatisfied (${formatDelegatedStepIds(unsatisfiedSteps.map((step) => step.stepId))})`;
  }
  const missingEvidenceKinds = decision.missingEvidenceKinds ?? [];
  if (missingEvidenceKinds.includes('file_reference_claim')) {
    return 'the previous answer did not name the exact files or code paths that were requested';
  }
  if (missingEvidenceKinds.includes('implementation_file_claim')) {
    return 'the previous answer did not identify the actual implementation files for the requested functionality';
  }
  if (missingEvidenceKinds.includes('symbol_reference_claim')) {
    return 'the previous answer did not reference the requested function or type names';
  }
  if (missingEvidenceKinds.includes('readonly_violation')) {
    return 'the previous attempt modified files when the request specified read-only inspection';
  }
  if (missingEvidenceKinds.includes('filesystem_mutation_receipt')) {
    return 'the previous attempt claimed a filesystem change without producing a successful tool result or a real blocker';
  }
  if (missingEvidenceKinds.includes('execution_evidence')) {
    return 'the previous attempt did not actually execute the requested command or verification step';
  }
  if (missingEvidenceKinds.includes('repo_evidence')) {
    return 'the previous attempt answered without collecting successful repo evidence';
  }
  if (missingEvidenceKinds.includes('security_evidence')) {
    return 'the previous attempt answered without collecting successful security evidence';
  }
  if (missingEvidenceKinds.includes('delegated_result_envelope')) {
    return 'the previous attempt did not return the typed delegated result envelope required by the protocol';
  }
  return decision.reasons[0]?.trim().toLowerCase()
    || 'the previous attempt did not satisfy the delegated task contract';
}

function collectDelegatedUnsatisfiedSteps(
  envelope: DelegatedResultEnvelope,
  decision: VerificationDecision,
): DelegatedResultSufficiencyFailure['unsatisfiedSteps'] {
  const stepById = new Map(envelope.taskContract.plan.steps.map((step) => [step.stepId, step]));
  const receiptByStepId = new Map(envelope.stepReceipts.map((receipt) => [receipt.stepId, receipt]));
  const evidenceById = new Map(envelope.evidenceReceipts.map((receipt) => [receipt.receiptId, receipt]));
  const unsatisfiedStepIds = decision.unsatisfiedStepIds?.length
    ? [...new Set(decision.unsatisfiedStepIds)]
    : readUnsatisfiedRequiredSteps(
        envelope.taskContract.plan,
        envelope.stepReceipts,
      ).map((step) => step.stepId);

  return unsatisfiedStepIds.map((stepId) => {
    const step = stepById.get(stepId);
    const receipt = receiptByStepId.get(stepId);
    const evidenceReason = receipt?.evidenceReceiptIds
      .map((receiptId) => evidenceById.get(receiptId)?.summary?.trim())
      .find((summary): summary is string => !!summary);
    const fallbackReason = receipt?.summary?.trim();
    return {
      stepId,
      ...(step?.kind ? { kind: step.kind } : {}),
      summary: step?.summary ?? fallbackReason ?? stepId,
      status: receipt?.status === 'blocked'
        ? 'blocked'
        : receipt?.status === 'failed'
          ? 'failed'
          : 'missing',
      ...(evidenceReason || fallbackReason
        ? { reason: evidenceReason ?? fallbackReason }
        : {}),
    };
  });
}

function collectDelegatedSatisfiedSteps(
  envelope: DelegatedResultEnvelope,
): DelegatedResultSufficiencyFailure['satisfiedSteps'] {
  const stepById = new Map(envelope.taskContract.plan.steps.map((step) => [step.stepId, step]));
  const evidenceById = new Map(envelope.evidenceReceipts.map((receipt) => [receipt.receiptId, receipt]));
  return filterDependencySatisfiedStepReceipts(
    envelope.taskContract.plan,
    envelope.stepReceipts,
  )
    .map((receipt) => ({
      stepId: receipt.stepId,
      summary: receipt.summary ?? stepById.get(receipt.stepId)?.summary ?? receipt.stepId,
      refs: dedupeDelegatedRetryRefs(
        receipt.evidenceReceiptIds.flatMap((receiptId) => evidenceById.get(receiptId)?.refs ?? []),
      ),
    }));
}

function dedupeDelegatedRetryRefs(refs: string[]): string[] {
  const deduped = new Set<string>();
  for (const ref of refs) {
    const normalized = typeof ref === 'string'
      ? ref.trim().replace(/\\/g, '/')
      : '';
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
    if (deduped.size >= 8) {
      break;
    }
  }
  return [...deduped];
}

function buildDelegatedRetryStepLine(
  step: DelegatedResultSufficiencyFailure['unsatisfiedSteps'][number],
): string {
  const reasonSuffix = step.reason?.trim() ? ` (${step.reason.trim()})` : '';
  return `- ${step.stepId}: ${step.summary} [${step.status}]${reasonSuffix}`;
}

function describeDelegatedExecutionProfile(profile: SelectedExecutionProfile | undefined): string | undefined {
  if (!profile) return undefined;
  const provider = profile.providerName || profile.providerType || profile.id;
  const model = profile.providerModel;
  if (provider && model && provider !== model) return `${provider} / ${model}`;
  return provider || model || profile.id;
}
