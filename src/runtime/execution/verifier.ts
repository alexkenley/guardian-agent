import type { SelectedExecutionProfile } from '../execution-profiles.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import { deriveAnswerConstraints } from '../intent/request-patterns.js';
import { requiresSecurityEvidence } from '../intent/planned-steps.js';
import { normalizeUserFacingIntentGatewaySummary } from '../intent/summary.js';
import {
  buildPlannedTask,
  collectMissingEvidenceKinds,
  findAnswerStepIds,
  readUnsatisfiedRequiredSteps,
} from './task-plan.js';
import type {
  Claim,
  DelegatedResultEnvelope,
  DelegatedTaskContract,
  ProviderSelectionSnapshot,
  StepReceipt,
  VerificationDecision,
} from './types.js';
import { looksLikeOngoingWorkResponse } from '../../util/assistant-response-shape.js';

export function buildDelegatedTaskContract(
  decision: IntentGatewayDecision | null | undefined,
): DelegatedTaskContract {
  const base = buildBaseDelegatedTaskContract(decision);
  const plan = buildPlannedTask(decision, base);
  const hasRequiredEvidenceStep = plan.steps.some((step) => step.required !== false && step.kind !== 'answer');
  return {
    ...base,
    requiresEvidence: hasRequiredEvidenceStep ? true : base.requiresEvidence,
    allowsAnswerFirst: hasRequiredEvidenceStep ? false : base.allowsAnswerFirst,
    plan,
  };
}

export function verifyDelegatedResult(input: {
  envelope: DelegatedResultEnvelope;
  gatewayDecision?: IntentGatewayDecision | null;
  executionProfile?: SelectedExecutionProfile | null;
}): VerificationDecision {
  const interruptions = input.envelope.interruptions;
  if (interruptions.length > 0) {
    const approval = interruptions.find((interruption) => interruption.kind === 'approval');
    if (approval) {
      return {
        decision: 'blocked',
        reasons: [approval.prompt || 'Delegated worker is waiting for approval.'],
        retryable: false,
        requiredNextAction: 'Resolve the pending approval(s) to continue the delegated run.',
      };
    }
    const clarification = interruptions.find((interruption) => interruption.kind === 'clarification');
    if (clarification) {
      return {
        decision: 'blocked',
        reasons: [clarification.prompt || 'Delegated worker is waiting for clarification.'],
        retryable: false,
        requiredNextAction: 'Resolve the clarification to continue the delegated run.',
      };
    }
    const workspaceSwitch = interruptions.find((interruption) => interruption.kind === 'workspace_switch');
    if (workspaceSwitch) {
      return {
        decision: 'blocked',
        reasons: [workspaceSwitch.prompt || 'Delegated worker requires a workspace switch.'],
        retryable: false,
        requiredNextAction: 'Switch to the requested coding workspace to continue the delegated run.',
      };
    }
    const policyBlocked = interruptions.find((interruption) => interruption.kind === 'policy_blocked');
    if (policyBlocked) {
      return {
        decision: 'policy_blocked',
        reasons: [policyBlocked.prompt || 'Delegated worker was blocked by tool policy.'],
        retryable: false,
        requiredNextAction: 'Resolve the policy blocker or choose an allowed target before retrying.',
      };
    }
  }

  const provenanceFailure = verifyProviderSelection(input.envelope.modelProvenance, input.executionProfile);
  if (provenanceFailure) {
    return provenanceFailure;
  }

  const unsatisfiedSteps = readUnsatisfiedRequiredSteps(
    input.envelope.taskContract.plan,
    input.envelope.stepReceipts,
  );
  const unsatisfiedStepIds = unsatisfiedSteps.map((step) => step.stepId);

  if (input.envelope.runStatus === 'completed' && unsatisfiedStepIds.length === 0) {
    const ongoingAnswerFailure = verifyFinalAnswerIsTerminal(input.envelope);
    if (ongoingAnswerFailure) {
      return ongoingAnswerFailure;
    }
    const exactFileReferenceFailure = verifyExactFileReferenceRequirements(input.envelope);
    if (exactFileReferenceFailure) {
      return exactFileReferenceFailure;
    }
    const repoInspectionResult = verifyRepoInspectionRequirements(input.envelope);
    if (repoInspectionResult.decision) {
      return repoInspectionResult.decision;
    }
    return {
      decision: 'satisfied',
      reasons: ['Delegated worker satisfied every required planned step.'],
      retryable: false,
      ...(repoInspectionResult.qualityNotes.length > 0
        ? { qualityNotes: repoInspectionResult.qualityNotes }
        : {}),
    };
  }

  if (input.envelope.runStatus === 'max_turns') {
    return {
      decision: 'insufficient',
      reasons: ['Delegated worker ran out of turns before satisfying every required step.'],
      retryable: true,
      requiredNextAction: buildUnsatisfiedStepsAction(input.envelope.taskContract.plan.steps, unsatisfiedStepIds),
      missingEvidenceKinds: collectMissingEvidenceKinds(
        input.envelope.taskContract.plan,
        input.envelope.stepReceipts,
      ),
      unsatisfiedStepIds,
    };
  }

  if (input.envelope.runStatus === 'incomplete') {
    return {
      decision: 'insufficient',
      reasons: ['Delegated worker stopped before satisfying every required planned step.'],
      retryable: true,
      requiredNextAction: buildUnsatisfiedStepsAction(input.envelope.taskContract.plan.steps, unsatisfiedStepIds),
      missingEvidenceKinds: collectMissingEvidenceKinds(
        input.envelope.taskContract.plan,
        input.envelope.stepReceipts,
      ),
      unsatisfiedStepIds,
    };
  }

  if (input.envelope.runStatus === 'failed') {
    return {
      decision: 'contradicted',
      reasons: buildFailureReasons(input.envelope),
      retryable: true,
      requiredNextAction: buildUnsatisfiedStepsAction(input.envelope.taskContract.plan.steps, unsatisfiedStepIds),
      missingEvidenceKinds: collectMissingEvidenceKinds(
        input.envelope.taskContract.plan,
        input.envelope.stepReceipts,
      ),
      unsatisfiedStepIds,
    };
  }

  return {
    decision: 'blocked',
    reasons: ['Delegated worker is not in a terminal completed state yet.'],
    retryable: false,
    requiredNextAction: buildUnsatisfiedStepsAction(input.envelope.taskContract.plan.steps, unsatisfiedStepIds),
    unsatisfiedStepIds,
  };
}

function verifyFinalAnswerIsTerminal(
  envelope: DelegatedResultEnvelope,
): VerificationDecision | null {
  const finalAnswer = envelope.finalUserAnswer?.trim();
  if (!finalAnswer || !looksLikeOngoingWorkResponse(finalAnswer)) {
    return null;
  }
  const hasRequiredEvidenceStep = envelope.taskContract.plan.steps.some(
    (step) => step.required !== false && step.kind !== 'answer',
  );
  if (!envelope.taskContract.requiresEvidence && !hasRequiredEvidenceStep) {
    return null;
  }
  const answerStepIds = findAnswerStepIds(envelope.taskContract.plan);
  return {
    decision: 'insufficient',
    reasons: ['Delegated worker returned an in-progress status message instead of a terminal user-facing answer.'],
    retryable: true,
    requiredNextAction: 'Complete the delegated task and return the final answer, not a progress promise.',
    missingEvidenceKinds: ['answer'],
    ...(answerStepIds.length > 0 ? { unsatisfiedStepIds: answerStepIds } : {}),
  };
}

function buildBaseDelegatedTaskContract(
  decision: IntentGatewayDecision | null | undefined,
): Omit<DelegatedTaskContract, 'plan'> {
  const summary = resolveDelegatedTaskSummary(decision);
  if (decision?.route === 'coding_task' && decision.operation === 'run') {
    return {
      kind: 'tool_execution',
      route: decision.route,
      operation: decision.operation,
      requiresEvidence: true,
      allowsAnswerFirst: false,
      requireExactFileReferences: false,
      summary,
    };
  }
  if (decision?.route === 'filesystem_task' && !isReadOnlyOperation(decision.operation)) {
    return {
      kind: 'filesystem_mutation',
      route: decision.route,
      operation: decision.operation,
      requiresEvidence: true,
      allowsAnswerFirst: false,
      requireExactFileReferences: false,
      summary,
    };
  }
  if (decision?.route === 'security_task' || decision?.executionClass === 'security_analysis') {
    if (!requiresSecurityEvidence(decision)) {
      return {
        kind: 'general_answer',
        route: decision?.route,
        operation: decision?.operation,
        requiresEvidence: false,
        allowsAnswerFirst: true,
        requireExactFileReferences: false,
        summary,
      };
    }
    const answerConstraints = deriveAnswerConstraints(decision?.resolvedContent);
    return {
      kind: 'security_analysis' as const,
      route: decision?.route,
      operation: decision?.operation,
      requiresEvidence: true,
      allowsAnswerFirst: false,
      requireExactFileReferences: decision?.requireExactFileReferences === true,
      ...(Object.keys(answerConstraints).length > 0 ? { answerConstraints } : {}),
      summary,
    };
  }
  if (decision?.requiresRepoGrounding === true || decision?.executionClass === 'repo_grounded') {
    const answerConstraints = deriveAnswerConstraints(decision?.resolvedContent);
    return {
      kind: 'repo_inspection' as const,
      route: decision.route,
      operation: decision.operation,
      requiresEvidence: true,
      allowsAnswerFirst: false,
      requireExactFileReferences: decision.requireExactFileReferences === true,
      ...(Object.keys(answerConstraints).length > 0 ? { answerConstraints } : {}),
      summary,
    };
  }
  return {
    kind: 'general_answer',
    route: decision?.route,
    operation: decision?.operation,
    requiresEvidence: false,
    allowsAnswerFirst: true,
    requireExactFileReferences: false,
    summary,
  };
}

function resolveDelegatedTaskSummary(
  decision: IntentGatewayDecision | null | undefined,
): string | undefined {
  const normalizedSummary = normalizeUserFacingIntentGatewaySummary(decision?.summary);
  if (normalizedSummary) {
    return normalizedSummary;
  }
  const resolvedContent = decision?.resolvedContent?.trim();
  if (resolvedContent) {
    return resolvedContent;
  }
  const rawSummary = decision?.summary?.trim();
  return rawSummary || undefined;
}

function verifyProviderSelection(
  provenance: ProviderSelectionSnapshot | undefined,
  executionProfile: SelectedExecutionProfile | null | undefined,
): VerificationDecision | null {
  if (!provenance || !executionProfile) return null;
  const expectedProfileName = executionProfile.providerName?.trim();
  const actualProfileName = provenance.resolvedProviderProfileName?.trim() || provenance.resolvedProviderName?.trim();
  const expectedModel = executionProfile.providerModel?.trim();
  const actualModel = provenance.resolvedProviderModel?.trim();
  const providerMatch = evaluateProviderSelectionMatch(provenance, executionProfile);
  if (expectedProfileName && actualProfileName && !providerMatch.allowed) {
    return {
      decision: 'contradicted',
      reasons: [`Delegated worker reported provider profile '${actualProfileName}' but the supervisor selected '${expectedProfileName}'.`],
      retryable: false,
      requiredNextAction: 'Inspect provider selection drift before retrying.',
      missingEvidenceKinds: ['provider_selection'],
    };
  }
  if (
    expectedModel
    && actualModel
    && !providerMatch.usedFallback
    && !areProviderModelsEquivalent(expectedModel, actualModel, provenance, executionProfile)
  ) {
    return {
      decision: 'contradicted',
      reasons: [`Delegated worker reported model '${actualModel}' but the supervisor selected '${expectedModel}'.`],
      retryable: false,
      requiredNextAction: 'Inspect provider selection drift before retrying.',
      missingEvidenceKinds: ['provider_selection'],
    };
  }
  return null;
}

function normalizeProviderIdentity(value: string | undefined): string {
  return (typeof value === 'string' ? value : '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function evaluateProviderSelectionMatch(
  provenance: ProviderSelectionSnapshot,
  executionProfile: SelectedExecutionProfile,
): { allowed: boolean; usedFallback: boolean } {
  const actualIdentities = [
    provenance.resolvedProviderProfileName,
    provenance.resolvedProviderName,
    provenance.resolvedProviderType,
  ]
    .map((value) => normalizeProviderIdentity(value))
    .filter((value) => value.length > 0);
  if (actualIdentities.length <= 0) {
    return { allowed: true, usedFallback: false };
  }

  const selectedIdentities = new Set([
    normalizeProviderIdentity(executionProfile.providerName),
    normalizeProviderIdentity(executionProfile.providerType),
  ].filter((value) => value.length > 0));
  if (actualIdentities.some((identity) => selectedIdentities.has(identity))) {
    return { allowed: true, usedFallback: provenance.resolvedViaFallback === true };
  }

  const fallbackIdentities = new Set(
    (executionProfile.fallbackProviderOrder ?? [])
      .map((value) => normalizeProviderIdentity(value))
      .filter((value) => value.length > 0),
  );
  if (actualIdentities.some((identity) => fallbackIdentities.has(identity))) {
    return { allowed: true, usedFallback: true };
  }

  return { allowed: false, usedFallback: provenance.resolvedViaFallback === true };
}

function isOpenAIProviderSelection(
  provenance: ProviderSelectionSnapshot,
  executionProfile: SelectedExecutionProfile,
): boolean {
  return isProviderSelection(provenance, executionProfile, 'openai');
}

function isOpenRouterProviderSelection(
  provenance: ProviderSelectionSnapshot,
  executionProfile: SelectedExecutionProfile,
): boolean {
  return isProviderSelection(provenance, executionProfile, 'openrouter');
}

function isProviderSelection(
  provenance: ProviderSelectionSnapshot,
  executionProfile: SelectedExecutionProfile,
  provider: string,
): boolean {
  return [
    executionProfile.providerType,
    executionProfile.providerName,
    provenance.resolvedProviderName,
    provenance.resolvedProviderType,
    provenance.resolvedProviderProfileName,
  ].some((value) => normalizeProviderIdentity(value) === provider);
}

function areProviderModelsEquivalent(
  expectedModel: string,
  actualModel: string,
  provenance: ProviderSelectionSnapshot,
  executionProfile: SelectedExecutionProfile,
): boolean {
  const expected = expectedModel.trim().toLowerCase();
  const actual = actualModel.trim().toLowerCase();
  if (!expected || !actual) return true;
  if (expected === actual) return true;
  const allowSnapshotAlias = isOpenAIProviderSelection(provenance, executionProfile)
    || isOpenRouterProviderSelection(provenance, executionProfile);
  if (!allowSnapshotAlias) return false;
  return isDatedSnapshotOfAlias(expected, actual) || isDatedSnapshotOfAlias(actual, expected);
}

function isDatedSnapshotOfAlias(alias: string, snapshot: string): boolean {
  if (!alias || !snapshot.startsWith(`${alias}-`)) return false;
  const suffix = snapshot.slice(alias.length + 1);
  return /^\d{8}$/u.test(suffix) || /^\d{4}-\d{2}-\d{2}$/u.test(suffix) || /^\d{2}-\d{2}$/u.test(suffix);
}

function verifyExactFileReferenceRequirements(
  envelope: DelegatedResultEnvelope,
): VerificationDecision | null {
  if (!envelope.taskContract.requireExactFileReferences) {
    return null;
  }
  const answer = envelope.finalUserAnswer?.trim() || '';
  const successfulReceiptIds = new Set(
    envelope.evidenceReceipts
      .filter((receipt) => receipt.status === 'succeeded')
      .map((receipt) => receipt.receiptId),
  );
  const fileClaims = envelope.claims.filter((claim) => (
    (claim.kind === 'file_reference' || claim.kind === 'implementation_file')
    && claim.evidenceReceiptIds.some((receiptId) => successfulReceiptIds.has(receiptId))
  ));

  if (fileClaims.length <= 0) {
    return {
      decision: 'insufficient',
      reasons: ['Delegated worker did not return the exact file references requested after repo inspection.'],
      retryable: true,
      requiredNextAction: 'Retry the delegated run and require exact file references backed by receipts.',
      missingEvidenceKinds: ['file_reference_claim'],
    };
  }
  if (!finalAnswerCitesFileReference(answer, fileClaims)) {
    return {
      decision: 'insufficient',
      reasons: ['Delegated worker collected exact file evidence but did not cite those file references in the final answer.'],
      retryable: true,
      requiredNextAction: 'Retry the delegated run and require the final answer to cite the exact files it inspected.',
      missingEvidenceKinds: ['file_reference_claim'],
    };
  }
  return null;
}

interface RepoInspectionVerificationResult {
  decision: VerificationDecision | null;
  qualityNotes: string[];
}

function verifyRepoInspectionRequirements(
  envelope: DelegatedResultEnvelope,
): RepoInspectionVerificationResult {
  const contract = envelope.taskContract;
  const qualityNotes: string[] = [];
  if (contract.kind !== 'repo_inspection' && contract.kind !== 'security_analysis') {
    return { decision: null, qualityNotes };
  }
  const constraints = contract.answerConstraints;
  if (!constraints) return { decision: null, qualityNotes };

  const answer = envelope.finalUserAnswer?.trim() || '';
  if (!answer) return { decision: null, qualityNotes };

  const successfulReceiptIds = new Set(
    envelope.evidenceReceipts
      .filter((receipt) => receipt.status === 'succeeded')
      .map((receipt) => receipt.receiptId),
  );

  const missingKinds: string[] = [];
  const reasons: string[] = [];

  // Check implementation-file claims
  if (constraints.requiresImplementationFiles) {
    const implementationClaims = envelope.claims.filter((claim) => (
      claim.kind === 'implementation_file'
      && claim.evidenceReceiptIds.some((receiptId) => successfulReceiptIds.has(receiptId))
    ));
    const fileClaims = envelope.claims.filter((claim) => (
      claim.kind === 'file_reference'
      && claim.evidenceReceiptIds.some((receiptId) => successfulReceiptIds.has(receiptId))
    ));
    if (implementationClaims.length === 0) {
      reasons.push('Delegated worker did not identify any implementation files for the requested functionality.');
      missingKinds.push('implementation_file_claim');
      // Quality note: the answer only cites search-hit files, not files the worker actually read in depth
      if (fileClaims.length > 0) {
        qualityNotes.push(`Answer cites ${fileClaims.length} file reference(s) from search but no confirmed implementation files. The answer may identify files that were found by search but not deeply inspected.`);
      }
    } else if (!finalAnswerCitesFileReference(answer, implementationClaims)) {
      reasons.push('Delegated worker identified implementation files but did not cite them in the final answer.');
      missingKinds.push('implementation_file_claim');
    } else {
      // Implementation files are cited. Check if the count seems low for a repo inspection.
      const implFileCount = implementationClaims.length;
      if (implFileCount <= 2) {
        qualityNotes.push(`Answer cites ${implFileCount} implementation file(s). For a thorough repo inspection, more implementation files may be relevant.`);
      }
    }
  }

  // Check symbol-reference claims when requested
  if (constraints.requiresSymbolNames) {
    const symbolClaims = envelope.claims.filter((claim) => (
      claim.kind === 'symbol_reference'
      && claim.evidenceReceiptIds.some((receiptId) => successfulReceiptIds.has(receiptId))
    ));
    if (symbolClaims.length === 0) {
      // Fallback: check if the answer mentions the requested symbols directly
      if (constraints.requestedSymbols && constraints.requestedSymbols.length > 0) {
        const answerLower = answer.toLowerCase();
        const foundSymbols = constraints.requestedSymbols.filter((sym) =>
          answerLower.includes(sym.toLowerCase()));
        if (foundSymbols.length === 0) {
          reasons.push('Delegated worker did not reference the requested symbol names in the final answer.');
          missingKinds.push('symbol_reference_claim');
        }
      } else {
        // No specific symbols listed but the request asked for symbol names —
        // check that the answer includes backtick-quoted code identifiers or
        // PascalCase/camelCase names that look like functions or types.
        const commonWords = new Set(['The', 'This', 'That', 'These', 'Those', 'There', 'Then', 'They', 'Their', 'For', 'And', 'But', 'Not', 'You', 'Are', 'Has', 'Can', 'Will', 'With', 'From', 'Into', 'When', 'What', 'Which', 'Where', 'How', 'Why']);
        const backtickSymbols = /\`([^`]+)\`/g;
        const typeLikeSymbols = /\b([A-Z][a-zA-Z0-9_]*[a-z][a-zA-Z0-9_]*)\b/g;
        const functionCallPattern = /\b([a-z][a-zA-Z0-9_]*)\(\)/g;
        const hasBackticks = backtickSymbols.test(answer);
        const typeMatches = answer.match(typeLikeSymbols) ?? [];
        const functionMatches = answer.match(functionCallPattern) ?? [];
        const realTypeSymbols = typeMatches.filter((m) => !commonWords.has(m) && m.length >= 3);
        if (!hasBackticks && realTypeSymbols.length === 0 && functionMatches.length === 0) {
          reasons.push('Delegated worker did not reference any function, type, or symbol names in the final answer.');
          missingKinds.push('symbol_reference_claim');
        } else {
          qualityNotes.push('Answer includes symbol-like references but no explicit symbol claims. The cited symbols may not be the exact ones requested.');
        }
      }
    }
  }

  // Check readonly constraint
  if (constraints.readonly) {
    const mutationClaims = envelope.claims.filter((claim) => claim.kind === 'filesystem_mutation');
    if (mutationClaims.length > 0) {
      reasons.push('Delegated worker made filesystem modifications despite a read-only constraint.');
      missingKinds.push('readonly_violation');
    } else {
      qualityNotes.push('No filesystem modifications were detected — the readonly constraint was respected.');
    }
  }

  if (missingKinds.length === 0) return { decision: null, qualityNotes };

  return {
    decision: {
      decision: 'insufficient',
      reasons,
      retryable: true,
      requiredNextAction: 'Retry the delegated run and require implementation file references, symbol citations, and/or readonly compliance.',
      missingEvidenceKinds: missingKinds,
    },
    qualityNotes,
  };
}

function buildFailureReasons(envelope: DelegatedResultEnvelope): string[] {
  const receiptById = new Map(envelope.evidenceReceipts.map((receipt) => [receipt.receiptId, receipt]));
  const stepById = new Map(envelope.taskContract.plan.steps.map((step) => [step.stepId, step]));
  const reasons = envelope.stepReceipts
    .filter((receipt) => receipt.status === 'failed' || receipt.status === 'blocked')
    .map((receipt) => buildFailureReasonForStep(receipt, stepById.get(receipt.stepId), receiptById))
    .filter((reason): reason is string => !!reason);
  if (reasons.length > 0) {
    return reasons;
  }
  return ['Delegated worker failed before satisfying the required planned steps.'];
}

function buildFailureReasonForStep(
  stepReceipt: StepReceipt,
  step: { summary: string } | undefined,
  receiptById: Map<string, DelegatedResultEnvelope['evidenceReceipts'][number]>,
): string | null {
  const evidenceReasons = stepReceipt.evidenceReceiptIds
    .map((receiptId) => receiptById.get(receiptId))
    .filter((receipt): receipt is NonNullable<typeof receipt> => !!receipt)
    .map((receipt) => receipt.summary?.trim())
    .filter((summary): summary is string => !!summary);
  if (evidenceReasons.length > 0) {
    return evidenceReasons[0];
  }
  const summary = stepReceipt.summary?.trim() || step?.summary?.trim();
  return summary ? `Failed to satisfy step: ${summary}` : null;
}

function isReadOnlyOperation(operation: IntentGatewayDecision['operation'] | undefined): boolean {
  return operation === 'inspect' || operation === 'read' || operation === 'search';
}

function buildUnsatisfiedStepsAction(
  plannedSteps: DelegatedResultEnvelope['taskContract']['plan']['steps'],
  unsatisfiedStepIds: string[],
): string | undefined {
  if (unsatisfiedStepIds.length === 0) return undefined;
  const stepById = new Map(plannedSteps.map((step) => [step.stepId, step]));
  return unsatisfiedStepIds
    .map((stepId) => {
      const step = stepById.get(stepId);
      return step ? `${stepId} (${step.summary})` : stepId;
    })
    .join('; ');
}

function finalAnswerCitesFileReference(answer: string, fileClaims: Claim[]): boolean {
  if (!answer.trim()) return false;
  const normalizedAnswer = normalizeFileReferenceText(answer);
  return fileClaims.some((claim) => {
    return buildComparableFileReferenceVariants(claim.subject).some((variant) => normalizedAnswer.includes(variant))
      || buildComparableFileReferenceVariants(claim.value).some((variant) => normalizedAnswer.includes(variant));
  });
}

function normalizeFileReferenceText(value: string | undefined): string {
  return value?.trim().replaceAll('\\', '/').toLowerCase() ?? '';
}

function buildComparableFileReferenceVariants(value: string | undefined): string[] {
  const normalized = normalizeFileReferenceText(value);
  if (!normalized) return [];
  const variants = new Set<string>();
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = segments.slice(index).join('/');
    if (isGenericFileReferenceCandidate(candidate)) continue;
    if (candidate.split('/').length < 2) continue;
    variants.add(candidate);
  }
  if (!isGenericFileReferenceCandidate(normalized)) {
    variants.add(normalized);
  }
  return [...variants];
}

function isGenericFileReferenceCandidate(value: string): boolean {
  if (!value || value.length <= 2) return true;
  return ['src', 'docs', 'lib', 'test', 'tests', 'bin', 'public', 'root'].includes(value);
}
