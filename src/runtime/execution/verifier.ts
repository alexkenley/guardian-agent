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
import {
  lacksUsableAssistantContent,
  looksLikeOngoingWorkResponse,
  looksLikeRawToolMarkup,
} from '../../util/assistant-response-shape.js';

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
    const mixedDomainAnswerFailure = verifyMixedDomainAnswerCoverage(input.envelope);
    if (mixedDomainAnswerFailure) {
      return mixedDomainAnswerFailure;
    }
    const repoEvidenceFailure = verifyRepoEvidenceQuality(input.envelope);
    if (repoEvidenceFailure) {
      return repoEvidenceFailure;
    }
    const repoDepthFailure = verifyRepoEvidenceDepth(input.envelope);
    if (repoDepthFailure) {
      return repoDepthFailure;
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
  if (!finalAnswer) {
    return null;
  }
  const hasRequiredEvidenceStep = envelope.taskContract.plan.steps.some(
    (step) => step.required !== false && step.kind !== 'answer',
  );
  if (!envelope.taskContract.requiresEvidence && !hasRequiredEvidenceStep) {
    return null;
  }
  const answerStepIds = findAnswerStepIds(envelope.taskContract.plan);
  if (looksLikeRawToolMarkup(finalAnswer)) {
    return {
      decision: 'insufficient',
      reasons: ['Delegated worker returned raw pseudo tool-call markup instead of a terminal user-facing answer.'],
      retryable: true,
      requiredNextAction: 'Complete the delegated task through real tool calls and return the final answer, not raw tool markup.',
      missingEvidenceKinds: ['answer'],
      ...(answerStepIds.length > 0 ? { unsatisfiedStepIds: answerStepIds } : {}),
    };
  }
  if (lacksUsableAssistantContent(finalAnswer)) {
    return {
      decision: 'insufficient',
      reasons: ['Delegated worker returned a generic fallback instead of a usable user-facing answer.'],
      retryable: true,
      requiredNextAction: 'Retry the delegated run and synthesize a concrete final answer from the collected evidence.',
      missingEvidenceKinds: ['answer'],
      ...(answerStepIds.length > 0 ? { unsatisfiedStepIds: answerStepIds } : {}),
    };
  }
  if (!looksLikeOngoingWorkResponse(finalAnswer)) {
    return null;
  }
  return {
    decision: 'insufficient',
    reasons: ['Delegated worker returned an in-progress status message instead of a terminal user-facing answer.'],
    retryable: true,
    requiredNextAction: 'Complete the delegated task and return the final answer, not a progress promise.',
    missingEvidenceKinds: ['answer'],
    ...(answerStepIds.length > 0 ? { unsatisfiedStepIds: answerStepIds } : {}),
  };
}

type MixedDomainAnswerSource = 'web' | 'repo' | 'memory';

const MIXED_DOMAIN_SOURCE_ORDER: MixedDomainAnswerSource[] = ['web', 'repo', 'memory'];

const MIXED_DOMAIN_SOURCE_LABELS: Record<MixedDomainAnswerSource, string[]> = {
  web: ['web', 'website', 'browser', 'internet'],
  repo: ['repo', 'repository', 'workspace', 'codebase', 'code'],
  memory: ['memory', 'memories'],
};

function verifyMixedDomainAnswerCoverage(
  envelope: DelegatedResultEnvelope,
): VerificationDecision | null {
  const finalAnswer = envelope.finalUserAnswer?.trim();
  if (!finalAnswer) {
    return null;
  }

  const expectedSources = collectExpectedMixedAnswerSources(envelope);
  if (expectedSources.length < 2 || !answerPlanRequestsSourceSeparatedBullets(envelope)) {
    return null;
  }

  const answerStepIds = findAnswerStepIds(envelope.taskContract.plan);
  const bulletLines = extractAnswerBulletLines(finalAnswer);
  if (bulletLines.length < expectedSources.length) {
    return buildMixedDomainAnswerFailure(
      'Delegated worker did not return one source-labeled bullet for each requested evidence domain.',
      answerStepIds,
    );
  }

  const seenSources = new Set<MixedDomainAnswerSource>();
  for (const line of bulletLines) {
    const lineSources = classifySourceLabeledBullet(line, expectedSources);
    if (lineSources.length > 1) {
      return buildMixedDomainAnswerFailure(
        'Delegated worker combined multiple requested evidence domains into one bullet instead of keeping one result per source.',
        answerStepIds,
      );
    }
    if (lineSources.length === 1) {
      seenSources.add(lineSources[0]);
    }
  }

  const missingSources = expectedSources.filter((source) => !seenSources.has(source));
  if (missingSources.length <= 0) {
    return null;
  }
  return buildMixedDomainAnswerFailure(
    `Delegated worker omitted source-labeled final answer bullets for: ${missingSources.join(', ')}.`,
    answerStepIds,
  );
}

function collectExpectedMixedAnswerSources(envelope: DelegatedResultEnvelope): MixedDomainAnswerSource[] {
  const sources = new Set<MixedDomainAnswerSource>();
  for (const step of envelope.taskContract.plan.steps) {
    if (step.kind === 'answer' || step.required === false) {
      continue;
    }
    for (const category of step.expectedToolCategories ?? []) {
      const source = sourceForExpectedToolCategory(category);
      if (source) {
        sources.add(source);
      }
    }
  }
  return MIXED_DOMAIN_SOURCE_ORDER.filter((source) => sources.has(source));
}

function sourceForExpectedToolCategory(category: string | undefined): MixedDomainAnswerSource | null {
  const normalized = category?.trim().toLowerCase();
  switch (normalized) {
    case 'web':
    case 'web_search':
    case 'browser':
    case 'browser_read':
      return 'web';
    case 'repo':
    case 'repository':
    case 'repo_inspect':
    case 'repo_inspection':
    case 'fs_search':
    case 'fs_read':
    case 'fs_list':
    case 'code_symbol_search':
      return 'repo';
    case 'memory':
    case 'memory_search':
    case 'memory_recall':
      return 'memory';
    default:
      return null;
  }
}

function answerPlanRequestsSourceSeparatedBullets(envelope: DelegatedResultEnvelope): boolean {
  return envelope.taskContract.plan.steps
    .filter((step) => step.kind === 'answer' && step.required !== false)
    .some((step) => {
      const summary = step.summary.trim().toLowerCase();
      return /\bbullets?\b/u.test(summary)
        && /\b(?:source|sources|each|per)\b/u.test(summary);
    });
}

function extractAnswerBulletLines(answer: string): string[] {
  return answer
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*]\s+|\d+[.)]\s+)/u.test(line));
}

function classifySourceLabeledBullet(
  line: string,
  expectedSources: MixedDomainAnswerSource[],
): MixedDomainAnswerSource[] {
  const label = extractBulletLabel(line);
  if (!label) {
    return [];
  }
  return expectedSources.filter((source) => (
    MIXED_DOMAIN_SOURCE_LABELS[source].some((alias) => labelHasSourceAlias(label, alias))
  ));
}

function extractBulletLabel(line: string): string {
  const content = line
    .replace(/^(?:[-*]\s+|\d+[.)]\s+)/u, '')
    .replace(/^\*{1,2}/u, '')
    .trim();
  const colonIndex = content.indexOf(':');
  const dashIndex = content.indexOf(' - ');
  const separatorIndexes = [colonIndex, dashIndex].filter((index) => index >= 0);
  const separatorIndex = separatorIndexes.length > 0 ? Math.min(...separatorIndexes) : -1;
  const label = separatorIndex >= 0 ? content.slice(0, separatorIndex) : content.slice(0, 40);
  return label
    .replace(/\*{1,2}$/u, '')
    .trim()
    .toLowerCase();
}

function labelHasSourceAlias(label: string, alias: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(alias)}(?:$|[^a-z0-9])`, 'u').test(label);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMixedDomainAnswerFailure(
  reason: string,
  answerStepIds: string[],
): VerificationDecision {
  return {
    decision: 'insufficient',
    reasons: [reason],
    retryable: true,
    requiredNextAction: 'Return one concise source-labeled bullet for each requested source domain.',
    missingEvidenceKinds: ['answer'],
    ...(answerStepIds.length > 0 ? { unsatisfiedStepIds: answerStepIds } : {}),
  };
}

function buildBaseDelegatedTaskContract(
  decision: IntentGatewayDecision | null | undefined,
): Omit<DelegatedTaskContract, 'plan'> {
  const summary = resolveDelegatedTaskSummary(decision);
  if (
    decision?.route === 'coding_task'
    && (decision.operation === 'run' || decision.entities.codingRemoteExecRequested === true)
  ) {
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

const REPO_EVIDENCE_TOOL_NAMES = new Set([
  'fs_search',
  'fs_read',
  'fs_list',
  'code_symbol_search',
]);
const REPO_EVIDENCE_CATEGORY_NAMES = new Set([
  'repo',
  'repository',
  'repo_inspect',
  'repo_inspection',
  'fs_search',
  'fs_read',
  'fs_list',
  'code_symbol_search',
]);
const REPO_NO_MATCH_ANSWER_PATTERN = /\b(?:no\s+(?:content\s+)?matches?\s+(?:were\s+)?found|no\s+results?\s+(?:were\s+)?found|could(?:\s+not|n't)\s+find|did(?:\s+not|n't)\s+find|not\s+found)\b/i;
const IMPLEMENTATION_LOCATION_REQUEST_PATTERN = /\b(?:where|which|what|exact|identify|locate|show|list|find)\b[\s\S]{0,180}\b(?:implement|implements|implemented|define|defines|defined|called|calls|callers?|emitted|emits?|triggered|fires?|published|registered|wired|handled|handles|render|renders|rendered|own|owns|responsible|file|files|function|functions|symbol|symbols|path|paths)\b/i;
const FINAL_ANSWER_FILE_REFERENCE_PATTERN = /\b(?:src|docs|web|scripts|config|policies|skills|native|test|tests|lib|public|tmp)(?:[\\/][^\s`'",)\]}]+)+/gi;

function verifyRepoEvidenceQuality(
  envelope: DelegatedResultEnvelope,
): VerificationDecision | null {
  const answer = envelope.finalUserAnswer?.trim() || '';
  if (!answer || !REPO_NO_MATCH_ANSWER_PATTERN.test(answer)) {
    return null;
  }
  const successfulRepoReceipts = envelope.evidenceReceipts.filter((receipt) => (
    receipt.status === 'succeeded'
    && receipt.sourceType === 'tool_call'
    && typeof receipt.toolName === 'string'
    && REPO_EVIDENCE_TOOL_NAMES.has(receipt.toolName)
  ));
  if (successfulRepoReceipts.length <= 0) {
    return null;
  }
  const requiresLocationEvidence = envelope.taskContract.requireExactFileReferences === true
    || envelope.taskContract.answerConstraints?.requiresImplementationFiles === true
    || envelope.taskContract.answerConstraints?.requiresSymbolNames === true
    || contractLooksLikeImplementationLocationRequest(envelope);
  if (!requiresLocationEvidence) {
    return null;
  }
  const supportArtifactsAreTargets = contractTargetsSupportArtifacts(envelope);
  const successfulRepoConfirmationReceiptIds = new Set(
    successfulRepoReceipts
      .filter((receipt) => receipt.toolName === 'fs_read' || receipt.toolName === 'code_symbol_search')
      .map((receipt) => receipt.receiptId),
  );
  const implementationClaims = envelope.claims.filter((claim) => (
    claim.kind === 'implementation_file'
    && claim.evidenceReceiptIds.some((receiptId) => successfulRepoConfirmationReceiptIds.has(receiptId))
    && (supportArtifactsAreTargets || !isSupportFileReference(claim.subject, claim.value))
  ));
  if (implementationClaims.length > 0) {
    return null;
  }
  const repoReadReceiptClaims = buildFileClaimsFromReceipts(
    envelope,
    (receipt) => successfulRepoConfirmationReceiptIds.has(receipt.receiptId),
    supportArtifactsAreTargets ? undefined : isProductionFileReference,
  );
  const repoReadFileClaims = envelope.claims.filter((claim) => (
    claim.kind === 'file_reference'
    && claim.evidenceReceiptIds.some((receiptId) => successfulRepoConfirmationReceiptIds.has(receiptId))
    && (supportArtifactsAreTargets || isProductionFileReference(claim.subject, claim.value))
  ));
  const confirmedRepoFileClaims = [...repoReadReceiptClaims, ...repoReadFileClaims];
  if (confirmedRepoFileClaims.length > 0 && finalAnswerCitesFileReference(answer, confirmedRepoFileClaims)) {
    return null;
  }
  const repoStepIds = findRepoEvidenceStepIds(envelope.taskContract.plan.steps);
  const answerStepIds = findAnswerStepIds(envelope.taskContract.plan);
  return {
    decision: 'insufficient',
    reasons: ['Delegated worker reported no repo matches for an implementation-location request without confirmed production repo evidence.'],
    retryable: true,
    requiredNextAction: 'Retry the delegated run with targeted repo inspection; broaden or adjust the source query and inspect likely directories before concluding no implementation path exists.',
    missingEvidenceKinds: ['repo_evidence'],
    unsatisfiedStepIds: [...new Set([...repoStepIds, ...answerStepIds])],
  };
}

function contractLooksLikeImplementationLocationRequest(envelope: DelegatedResultEnvelope): boolean {
  const summaries = [
    envelope.taskContract.summary,
    ...envelope.taskContract.plan.steps.map((step) => step.summary),
  ]
    .filter((summary): summary is string => typeof summary === 'string' && summary.trim().length > 0)
    .join(' ');
  return IMPLEMENTATION_LOCATION_REQUEST_PATTERN.test(summaries);
}

function findRepoEvidenceStepIds(
  steps: DelegatedResultEnvelope['taskContract']['plan']['steps'],
): string[] {
  return steps
    .filter((step) => step.kind === 'search' || step.kind === 'read' || step.kind === 'tool_call')
    .filter((step) => step.expectedToolCategories?.some((category) => (
      REPO_EVIDENCE_CATEGORY_NAMES.has(category.trim())
      || category.trim() === 'runtime_evidence'
    )) === true)
    .map((step) => step.stepId);
}

function verifyRepoEvidenceDepth(
  envelope: DelegatedResultEnvelope,
): VerificationDecision | null {
  const answer = envelope.finalUserAnswer?.trim() || '';
  if (!answer || !contractLooksLikeImplementationLocationRequest(envelope)) {
    return null;
  }
  const successfulReceiptIds = new Set(
    envelope.evidenceReceipts
      .filter((receipt) => receipt.status === 'succeeded')
      .map((receipt) => receipt.receiptId),
  );
  const successfulRepoReceiptIds = new Set(
    envelope.evidenceReceipts
      .filter((receipt) => (
        receipt.status === 'succeeded'
        && receipt.sourceType === 'tool_call'
        && typeof receipt.toolName === 'string'
        && REPO_EVIDENCE_TOOL_NAMES.has(receipt.toolName)
      ))
      .map((receipt) => receipt.receiptId),
  );
  const successfulRepoConfirmationReceiptIds = new Set(
    envelope.evidenceReceipts
      .filter((receipt) => (
        receipt.status === 'succeeded'
        && receipt.sourceType === 'tool_call'
        && (receipt.toolName === 'fs_read' || receipt.toolName === 'code_symbol_search')
      ))
      .map((receipt) => receipt.receiptId),
  );
  if (successfulRepoReceiptIds.size <= 0) {
    return null;
  }
  const supportArtifactsAreTargets = contractTargetsSupportArtifacts(envelope);
  const implementationClaims = envelope.claims.filter((claim) => (
    claim.kind === 'implementation_file'
    && claim.evidenceReceiptIds.some((receiptId) => successfulReceiptIds.has(receiptId))
    && (supportArtifactsAreTargets || !isSupportFileReference(claim.subject, claim.value))
  ));
  if (implementationClaims.length > 0) {
    return null;
  }
  const repoReadReceiptClaims = buildFileClaimsFromReceipts(
    envelope,
    (receipt) => successfulRepoConfirmationReceiptIds.has(receipt.receiptId),
    supportArtifactsAreTargets ? undefined : isProductionFileReference,
  );
  const repoReadFileClaims = envelope.claims.filter((claim) => (
    claim.kind === 'file_reference'
    && claim.evidenceReceiptIds.some((receiptId) => successfulRepoConfirmationReceiptIds.has(receiptId))
    && (supportArtifactsAreTargets || isProductionFileReference(claim.subject, claim.value))
  ));
  const finalAnswerFileReferences = extractFinalAnswerFileReferences(answer);
  const confirmedRepoFileClaims = [...repoReadReceiptClaims, ...repoReadFileClaims];
  if (
    finalAnswerFileReferences.length > 0
    && !finalAnswerFileReferences.every((fileReference) => fileReferenceBackedByClaims(
      fileReference,
      confirmedRepoFileClaims,
    ))
  ) {
    const repoStepIds = findRepoEvidenceStepIds(envelope.taskContract.plan.steps);
    const answerStepIds = findAnswerStepIds(envelope.taskContract.plan);
    return {
      decision: 'insufficient',
      reasons: ['Delegated worker cited implementation file paths that were not backed by read or code-symbol confirmation evidence.'],
      retryable: true,
      requiredNextAction: 'Retry the delegated run with targeted repo inspection; read or code-symbol-search the cited implementation files before using them in the final answer.',
      missingEvidenceKinds: ['implementation_file_claim'],
      unsatisfiedStepIds: [...new Set([...repoStepIds, ...answerStepIds])],
    };
  }
  const semanticSupportDecision = verifyImplementationLocationSemanticSupport(
    envelope,
    answer,
    confirmedRepoFileClaims,
  );
  if (semanticSupportDecision) {
    return semanticSupportDecision;
  }
  if (confirmedRepoFileClaims.length > 0 && finalAnswerCitesFileReference(answer, confirmedRepoFileClaims)) {
    return null;
  }
  const repoFileClaims = envelope.claims.filter((claim) => (
    claim.kind === 'file_reference'
    && claim.evidenceReceiptIds.some((receiptId) => successfulRepoReceiptIds.has(receiptId))
  ));
  const repoReceiptFileClaims = buildFileClaimsFromReceipts(
    envelope,
    (receipt) => successfulRepoReceiptIds.has(receipt.receiptId),
  );
  const repoCitedFileClaims = [...repoFileClaims, ...repoReceiptFileClaims];
  if (repoCitedFileClaims.length <= 0 || !finalAnswerCitesFileReference(answer, repoCitedFileClaims)) {
    return null;
  }
  const repoStepIds = findRepoEvidenceStepIds(envelope.taskContract.plan.steps);
  const answerStepIds = findAnswerStepIds(envelope.taskContract.plan);
  return {
    decision: 'insufficient',
    reasons: ['Delegated worker cited repo search-hit files for an implementation-location request without reading and confirming implementation files.'],
    retryable: true,
    requiredNextAction: 'Retry the delegated run with targeted repo inspection; read the likely implementation files before citing them as the answer.',
    missingEvidenceKinds: ['implementation_file_claim'],
    unsatisfiedStepIds: [...new Set([...repoStepIds, ...answerStepIds])],
  };
}

function verifyImplementationLocationSemanticSupport(
  envelope: DelegatedResultEnvelope,
  answer: string,
  confirmedRepoFileClaims: Claim[],
): VerificationDecision | null {
  if (envelope.taskContract.requireExactFileReferences === true) {
    return null;
  }
  const requestTerms = extractImplementationLocationRequestTerms(envelope);
  if (requestTerms.length <= 0) {
    return null;
  }
  const citedConfirmedClaims = confirmedRepoFileClaims.filter((claim) => finalAnswerCitesFileReference(answer, [claim]));
  if (citedConfirmedClaims.length <= 0) {
    return null;
  }
  if (citedConfirmedClaims.some((claim) => claimEvidenceSupportsRequestTerms(envelope, claim, requestTerms))) {
    return null;
  }
  const repoStepIds = findRepoEvidenceStepIds(envelope.taskContract.plan.steps);
  const answerStepIds = findAnswerStepIds(envelope.taskContract.plan);
  return {
    decision: 'insufficient',
    reasons: ['Delegated worker cited confirmed repo files that did not semantically support the key implementation-location terms.'],
    retryable: true,
    requiredNextAction: 'Retry the delegated run with targeted repo inspection; read files whose content matches the key implementation-location terms before citing them as the answer.',
    missingEvidenceKinds: ['implementation_file_claim'],
    unsatisfiedStepIds: [...new Set([...repoStepIds, ...answerStepIds])],
  };
}

const IMPLEMENTATION_LOCATION_STOP_TERMS = new Set([
  'answer',
  'before',
  'called',
  'calls',
  'collect',
  'defined',
  'emitted',
  'events',
  'exact',
  'files',
  'findings',
  'function',
  'functions',
  'grounded',
  'handled',
  'implemented',
  'inspect',
  'inspected',
  'locate',
  'read',
  'relevant',
  'repo',
  'repository',
  'return',
  'search',
  'source',
  'symbol',
  'symbols',
  'where',
  'which',
  'workspace',
]);

function extractImplementationLocationRequestTerms(envelope: DelegatedResultEnvelope): string[] {
  const repoStepIds = new Set(findRepoEvidenceStepIds(envelope.taskContract.plan.steps));
  const text = envelope.taskContract.plan.steps
    .filter((step) => repoStepIds.has(step.stepId))
    .map((step) => step.summary)
    .join(' ');
  const terms = new Set<string>();
  for (const rawToken of text.match(/[A-Za-z][A-Za-z0-9_:-]{4,}/g) ?? []) {
    for (const token of splitImplementationLocationToken(rawToken)) {
      const normalized = normalizeImplementationLocationTerm(token);
      if (
        normalized.length >= 6
        && !IMPLEMENTATION_LOCATION_STOP_TERMS.has(normalized)
        && !/^\d+$/u.test(normalized)
      ) {
        terms.add(normalized);
      }
    }
  }
  return [...terms].slice(0, 8);
}

function splitImplementationLocationToken(token: string): string[] {
  const separated = token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_:-]+/g, ' ');
  return [token, ...separated.split(/\s+/u)].filter(Boolean);
}

function normalizeImplementationLocationTerm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function claimEvidenceSupportsRequestTerms(
  envelope: DelegatedResultEnvelope,
  claim: Claim,
  requestTerms: string[],
): boolean {
  const evidenceReceiptIds = new Set(claim.evidenceReceiptIds);
  const evidenceText = [
    claim.subject,
    claim.value,
    ...envelope.evidenceReceipts
      .filter((receipt) => evidenceReceiptIds.has(receipt.receiptId))
      .map((receipt) => receipt.summary),
  ]
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  const compactEvidenceText = evidenceText.replace(/\s+/g, '');
  return requestTerms.every((term) => (
    evidenceText.includes(term)
    || compactEvidenceText.includes(term)
  ));
}

function buildFileClaimsFromReceipts(
  envelope: DelegatedResultEnvelope,
  includeReceipt: (receipt: DelegatedResultEnvelope['evidenceReceipts'][number]) => boolean,
  includeRef: ((ref: string) => boolean) | undefined = undefined,
): Claim[] {
  const claims: Claim[] = [];
  for (const receipt of envelope.evidenceReceipts) {
    if (!includeReceipt(receipt)) continue;
    for (const ref of receipt.refs) {
      const normalized = ref.trim();
      if (!normalized || isGenericFileReferenceCandidate(normalized.replace(/\\/g, '/').toLowerCase())) continue;
      if (includeRef && !includeRef(normalized)) continue;
      claims.push({
        claimId: `${receipt.receiptId}:receipt-ref:${normalized}`,
        kind: 'file_reference',
        subject: normalized,
        value: normalized,
        evidenceReceiptIds: [receipt.receiptId],
        confidence: 0.75,
      });
    }
  }
  return claims;
}

function extractFinalAnswerFileReferences(answer: string): string[] {
  const refs = new Set<string>();
  for (const match of answer.matchAll(FINAL_ANSWER_FILE_REFERENCE_PATTERN)) {
    const normalized = match[0].trim().replace(/[.:;,!?]+$/g, '');
    if (!normalized || isGenericFileReferenceCandidate(normalized.replace(/\\/g, '/').toLowerCase())) continue;
    refs.add(normalized);
  }
  return [...refs];
}

function fileReferenceBackedByClaims(fileReference: string, fileClaims: Claim[]): boolean {
  const referenceVariants = buildComparableFileReferenceVariants(fileReference);
  if (referenceVariants.length <= 0) return false;
  return fileClaims.some((claim) => {
    const claimVariants = [
      ...buildComparableFileReferenceVariants(claim.subject),
      ...buildComparableFileReferenceVariants(claim.value),
    ];
    return referenceVariants.some((referenceVariant) => claimVariants.includes(referenceVariant));
  });
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

function contractTargetsSupportArtifacts(envelope: DelegatedResultEnvelope): boolean {
  const summaries = [
    envelope.taskContract.summary,
    ...envelope.taskContract.plan.steps.map((step) => step.summary),
  ]
    .filter((summary): summary is string => typeof summary === 'string' && summary.trim().length > 0)
    .join(' ')
    .toLowerCase();
  return /\b(?:tests?|test\s+files?|docs?|documentation|fixtures?|examples|example\s+files?|samples?)\b/u.test(summaries);
}

function isProductionFileReference(...values: Array<string | undefined>): boolean {
  return !isSupportFileReference(...values);
}

function isSupportFileReference(...values: Array<string | undefined>): boolean {
  return values.some((value) => {
    const normalized = normalizeFileReferenceText(value);
    if (!normalized) return false;
    return /(?:^|\/)(?:__tests__|tests?|fixtures?|examples?|samples?)(?:\/|$)/u.test(normalized)
      || /\.(?:test|spec)\.[cm]?[tj]sx?$/u.test(normalized)
      || /(?:^|\/)docs(?:\/|$)/u.test(normalized)
      || /(?:^|\/)README(?:\.|$)/iu.test(normalized);
  });
}
