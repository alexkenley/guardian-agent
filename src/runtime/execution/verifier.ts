import type { SelectedExecutionProfile } from '../execution-profiles.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type {
  Claim,
  DelegatedResultEnvelope,
  DelegatedTaskContract,
  ProviderSelectionSnapshot,
  VerificationDecision,
} from './types.js';

export function buildDelegatedTaskContract(
  decision: IntentGatewayDecision | null | undefined,
): DelegatedTaskContract {
  if (decision?.route === 'coding_task' && decision.operation === 'run') {
    return {
      kind: 'tool_execution',
      route: decision.route,
      operation: decision.operation,
      requiresEvidence: true,
      allowsAnswerFirst: false,
      requireExactFileReferences: false,
      summary: decision.summary,
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
      summary: decision.summary,
    };
  }
  if (decision?.route === 'security_task' || decision?.executionClass === 'security_analysis') {
    return {
      kind: 'security_analysis',
      route: decision?.route,
      operation: decision?.operation,
      requiresEvidence: true,
      allowsAnswerFirst: false,
      requireExactFileReferences: decision?.requireExactFileReferences === true,
      summary: decision?.summary,
    };
  }
  if (decision?.requiresRepoGrounding === true || decision?.executionClass === 'repo_grounded') {
    return {
      kind: 'repo_inspection',
      route: decision.route,
      operation: decision.operation,
      requiresEvidence: true,
      allowsAnswerFirst: false,
      requireExactFileReferences: decision.requireExactFileReferences === true,
      summary: decision.summary,
    };
  }
  return {
    kind: 'general_answer',
    route: decision?.route,
    operation: decision?.operation,
    requiresEvidence: false,
    allowsAnswerFirst: true,
    requireExactFileReferences: false,
    summary: decision?.summary,
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
  const terminalityFailure = verifyEnvelopeTerminality(input.envelope);
  if (terminalityFailure) {
    return terminalityFailure;
  }

  const answer = input.envelope.finalUserAnswer?.trim() || '';
  const successfulReceipts = input.envelope.evidenceReceipts.filter((receipt) => receipt.status === 'succeeded');
  const blockerReceipts = input.envelope.evidenceReceipts.filter((receipt) => (
    receipt.status === 'failed' || receipt.status === 'blocked'
  ));
  const successfulExecutionReceipts = successfulReceipts.filter((receipt) => !isDiscoveryOnlyReceipt(receipt));
  const successfulReceiptIds = new Set(successfulReceipts.map((receipt) => receipt.receiptId));
  const fileClaims = input.envelope.claims.filter((claim) => (
    claim.kind === 'file_reference'
    && claim.evidenceReceiptIds.some((receiptId) => successfulReceiptIds.has(receiptId))
  ));

  switch (input.envelope.taskContract.kind) {
    case 'general_answer':
      if (answer) {
        return {
          decision: 'satisfied',
          reasons: ['Delegated worker returned a complete direct answer.'],
          retryable: false,
        };
      }
      return {
        decision: 'insufficient',
        reasons: ['Delegated worker did not return a terminal answer.'],
        retryable: true,
        requiredNextAction: 'Retry the delegated run and require a terminal answer.',
      };
    case 'tool_execution':
      if (successfulExecutionReceipts.length <= 0) {
        if (blockerReceipts.length > 0) {
          return {
            decision: 'blocked',
            reasons: ['Delegated worker encountered a real blocker while executing the requested command or verification step.'],
            retryable: false,
            requiredNextAction: blockerReceipts[0]?.summary || 'Resolve the blocker and retry if needed.',
          };
        }
        return {
          decision: 'insufficient',
          reasons: ['Delegated worker did not produce successful execution evidence for the requested command or verification step.'],
          retryable: true,
          requiredNextAction: 'Retry the delegated run and require real execution evidence before answering.',
          missingEvidenceKinds: ['execution_evidence'],
        };
      }
      if (!answer) {
        return {
          decision: 'insufficient',
          reasons: ['Delegated worker completed the requested execution without a final synthesized answer.'],
          retryable: true,
          requiredNextAction: 'Retry the delegated run and require a final answer.',
          missingEvidenceKinds: ['execution_evidence'],
        };
      }
      return {
        decision: 'satisfied',
        reasons: ['Delegated worker produced execution evidence and a final answer.'],
        retryable: false,
      };
    case 'filesystem_mutation':
      if (hasFilesystemMutationEvidence(input.envelope.claims, successfulExecutionReceipts.length)) {
        return {
          decision: 'satisfied',
          reasons: ['Delegated worker produced a successful filesystem mutation receipt.'],
          retryable: false,
        };
      }
      return {
        decision: 'contradicted',
        reasons: ['Delegated worker claimed a filesystem change without producing a successful receipt or a real blocker.'],
        retryable: true,
        requiredNextAction: 'Inspect the delegated worker failure details before retrying.',
        missingEvidenceKinds: ['filesystem_mutation_receipt'],
      };
    case 'security_analysis':
      if (successfulExecutionReceipts.length <= 0) {
        if (blockerReceipts.length > 0) {
          return {
            decision: 'blocked',
            reasons: ['Delegated worker encountered a real blocker while collecting security evidence.'],
            retryable: false,
            requiredNextAction: blockerReceipts[0]?.summary || 'Resolve the blocker and retry if needed.',
          };
        }
        return {
          decision: 'contradicted',
          reasons: ['Delegated worker returned source-backed security findings without collecting successful tool results or evidence.'],
          retryable: true,
          requiredNextAction: 'Inspect the delegated worker failure details before retrying.',
          missingEvidenceKinds: ['security_evidence'],
        };
      }
      if (input.envelope.taskContract.requireExactFileReferences && fileClaims.length <= 0) {
        return {
          decision: 'insufficient',
          reasons: ['Delegated worker did not return the exact file references requested after repo inspection.'],
          retryable: true,
          requiredNextAction: 'Retry the delegated run and require exact file references backed by receipts.',
          missingEvidenceKinds: ['file_reference_claim'],
        };
      }
      if (input.envelope.taskContract.requireExactFileReferences && !finalAnswerCitesFileReference(answer, fileClaims)) {
        return {
          decision: 'insufficient',
          reasons: ['Delegated worker collected exact file evidence but did not cite those file references in the final answer.'],
          retryable: true,
          requiredNextAction: 'Retry the delegated run and require the final answer to cite the exact files it inspected.',
          missingEvidenceKinds: ['file_reference_claim'],
        };
      }
      return {
        decision: 'satisfied',
        reasons: ['Delegated worker produced source-backed security evidence.'],
        retryable: false,
      };
    case 'repo_inspection':
    default:
      if (successfulExecutionReceipts.length <= 0) {
        if (blockerReceipts.length > 0) {
          return {
            decision: 'blocked',
            reasons: ['Delegated worker encountered a real blocker while collecting repo evidence.'],
            retryable: false,
            requiredNextAction: blockerReceipts[0]?.summary || 'Resolve the blocker and retry if needed.',
          };
        }
        return {
          decision: 'insufficient',
          reasons: ['Delegated worker returned a repo-grounded answer without collecting successful tool results or evidence.'],
          retryable: true,
          requiredNextAction: 'Inspect the delegated worker failure details before retrying.',
          missingEvidenceKinds: ['repo_evidence'],
        };
      }
      if (input.envelope.taskContract.requireExactFileReferences && fileClaims.length <= 0) {
        return {
          decision: 'insufficient',
          reasons: ['Delegated worker did not return the exact file references requested after repo inspection.'],
          retryable: true,
          requiredNextAction: 'Retry the delegated run and require exact file references backed by receipts.',
          missingEvidenceKinds: ['file_reference_claim'],
        };
      }
      if (input.envelope.taskContract.requireExactFileReferences && !finalAnswerCitesFileReference(answer, fileClaims)) {
        return {
          decision: 'insufficient',
          reasons: ['Delegated worker collected exact file evidence but did not cite those file references in the final answer.'],
          retryable: true,
          requiredNextAction: 'Retry the delegated run and require the final answer to cite the exact files it inspected.',
          missingEvidenceKinds: ['file_reference_claim'],
        };
      }
      if (!answer) {
        return {
          decision: 'insufficient',
          reasons: ['Delegated worker completed repo inspection without a final synthesized answer.'],
          retryable: true,
          requiredNextAction: 'Retry the delegated run and require a final answer.',
        };
      }
      return {
        decision: 'satisfied',
        reasons: ['Delegated worker produced repo-grounded evidence and a final answer.'],
        retryable: false,
      };
  }
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
  if (expectedProfileName && actualProfileName && expectedProfileName !== actualProfileName) {
    return {
      decision: 'contradicted',
      reasons: [`Delegated worker reported provider profile '${actualProfileName}' but the supervisor selected '${expectedProfileName}'.`],
      retryable: false,
      requiredNextAction: 'Inspect provider selection drift before retrying.',
      missingEvidenceKinds: ['provider_selection'],
    };
  }
  if (expectedModel && actualModel && expectedModel !== actualModel) {
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

function isDiscoveryOnlyReceipt(receipt: DelegatedResultEnvelope['evidenceReceipts'][number]): boolean {
  return receipt.sourceType === 'tool_call' && receipt.toolName === 'find_tools';
}

function isReadOnlyOperation(operation: IntentGatewayDecision['operation'] | undefined): boolean {
  return operation === 'inspect' || operation === 'read' || operation === 'search';
}

function hasFilesystemMutationEvidence(claims: Claim[], receiptCount: number): boolean {
  return receiptCount > 0 || claims.some((claim) => claim.kind === 'filesystem_mutation');
}

function finalAnswerCitesFileReference(answer: string, fileClaims: Claim[]): boolean {
  if (!answer.trim()) return false;
  const normalizedAnswer = normalizeFileReferenceText(answer);
  return fileClaims.some((claim) => {
    const subject = normalizeFileReferenceText(claim.subject);
    const value = normalizeFileReferenceText(claim.value);

    // Ignore overly generic matches that are just search directories
    const isGeneric = (str: string) => {
      if (!str || str.length <= 2) return true;
      if (['src', 'docs', 'lib', 'test', 'tests', 'bin', 'public', 'root'].includes(str)) return true;
      return false;
    };

    return (!isGeneric(subject) && normalizedAnswer.includes(subject))
      || (!isGeneric(value) && normalizedAnswer.includes(value));
  });
}

function normalizeFileReferenceText(value: string | undefined): string {
  return value?.trim().replaceAll('\\', '/').toLowerCase() ?? '';
}

function verifyEnvelopeTerminality(
  envelope: DelegatedResultEnvelope,
): VerificationDecision | null {
  const responseQuality = envelope.verificationHints?.responseQuality?.trim();
  const completionReason = envelope.verificationHints?.completionReason?.trim();
  if (completionReason === 'phantom_approval_response') {
    return {
      decision: 'contradicted',
      reasons: ['Delegated worker claimed approval was required without creating a real approval request.'],
      retryable: true,
      requiredNextAction: 'Inspect the delegated worker failure details before retrying.',
    };
  }
  if (completionReason === 'intermediate_response' || responseQuality === 'intermediate') {
    return {
      decision: 'insufficient',
      reasons: ['Delegated worker returned a progress update instead of a terminal result.'],
      retryable: true,
      requiredNextAction: 'Retry the delegated run and require a terminal answer.',
    };
  }
  if (
    completionReason === 'degraded_response'
    || completionReason === 'empty_response_fallback'
    || responseQuality === 'degraded'
  ) {
    return {
      decision: 'insufficient',
      reasons: ['Delegated worker did not produce a usable terminal result.'],
      retryable: true,
      requiredNextAction: 'Retry the delegated run and require a terminal answer.',
    };
  }
  return null;
}
