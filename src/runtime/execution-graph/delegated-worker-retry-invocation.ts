import type { GuardianAgentConfig } from '../../config/types.js';
import type { PromptAssemblyAdditionalSection } from '../context-assembly.js';
import type { SelectedExecutionProfile } from '../execution-profiles.js';
import type { DelegatedResultEnvelope } from '../execution/types.js';
import type { IntentGatewayDecision, IntentGatewayRecord } from '../intent-gateway.js';
import type { OrchestrationRoleDescriptor } from '../orchestration-role-descriptors.js';
import {
  buildDelegatedRetryAttemptPlan,
  selectDelegatedRetryExecutionProfile,
  shouldUseSameProfileDelegatedRetry,
  type DelegatedResultSufficiencyFailure,
  type DelegatedRetryAttemptPlan,
} from './delegated-worker-retry.js';
import type {
  DelegatedJobDrainResult,
  DelegatedWorkerVerificationCycleResult,
} from './delegated-worker-verification.js';

export interface DelegatedWorkerRetryInvocationInput<TRequest, TResult> {
  requestId: string;
  taskRunId: string;
  targetLabel: string;
  currentRequest: TRequest;
  currentExecutionProfile: SelectedExecutionProfile | undefined;
  config: GuardianAgentConfig | null | undefined;
  orchestration?: OrchestrationRoleDescriptor | null;
  intentDecision: IntentGatewayDecision | undefined;
  baseRecord: IntentGatewayRecord | null | undefined;
  taskContract: DelegatedResultEnvelope['taskContract'];
  insufficiency: DelegatedResultSufficiencyFailure | null;
  codeSessionId?: string;
  baseSections: PromptAssemblyAdditionalSection[];
  buildRetryRequest: (input: DelegatedWorkerRetryRequestBuildInput<TRequest>) => TRequest;
  dispatchRetry: (input: DelegatedWorkerRetryDispatchInput<TRequest>) => Promise<TResult>;
  drainPendingJobs: () => Promise<DelegatedJobDrainResult>;
  verifyRetryResult: (
    input: DelegatedWorkerRetryVerificationInput<TRequest, TResult>,
  ) => Promise<DelegatedWorkerVerificationCycleResult>;
  onRetrying?: (event: DelegatedWorkerRetryingEvent<TRequest>) => void;
  onDrainWaitExpired?: (event: DelegatedWorkerRetryDrainExpiredEvent<TRequest>) => void;
}

export interface DelegatedWorkerRetryRequestBuildInput<TRequest> {
  currentRequest: TRequest;
  retryProfile: SelectedExecutionProfile;
  retryPlan: DelegatedRetryAttemptPlan;
  insufficiency: DelegatedResultSufficiencyFailure;
}

export interface DelegatedWorkerRetryDispatchInput<TRequest> {
  request: TRequest;
  retryProfile: SelectedExecutionProfile;
  retryPlan: DelegatedRetryAttemptPlan;
  insufficiency: DelegatedResultSufficiencyFailure;
}

export interface DelegatedWorkerRetryVerificationInput<TRequest, TResult> {
  request: TRequest;
  result: TResult;
  retryProfile: SelectedExecutionProfile;
  retryPlan: DelegatedRetryAttemptPlan;
  insufficiency: DelegatedResultSufficiencyFailure;
  taskContract: DelegatedResultEnvelope['taskContract'];
  jobDrain: DelegatedJobDrainResult;
}

export interface DelegatedWorkerRetryingEvent<TRequest> {
  request: TRequest;
  retryProfile: SelectedExecutionProfile;
  retryPlan: DelegatedRetryAttemptPlan;
  insufficiency: DelegatedResultSufficiencyFailure;
}

export interface DelegatedWorkerRetryDrainExpiredEvent<TRequest> {
  request: TRequest;
  retryProfile: SelectedExecutionProfile;
  retryPlan: DelegatedRetryAttemptPlan;
  insufficiency: DelegatedResultSufficiencyFailure;
  taskContract: DelegatedResultEnvelope['taskContract'];
  jobDrain: DelegatedJobDrainResult;
}

export interface DelegatedWorkerRetryInvocationResult<TRequest, TResult> {
  request: TRequest;
  result: TResult;
  retryProfile: SelectedExecutionProfile;
  retryPlan: DelegatedRetryAttemptPlan;
  jobDrain: DelegatedJobDrainResult;
  verificationCycle: DelegatedWorkerVerificationCycleResult;
}

export async function runDelegatedWorkerRetryInvocation<TRequest, TResult>(
  input: DelegatedWorkerRetryInvocationInput<TRequest, TResult>,
): Promise<DelegatedWorkerRetryInvocationResult<TRequest, TResult> | null> {
  const insufficiency = input.insufficiency;
  if (!insufficiency) {
    return null;
  }
  const retryProfile = shouldUseSameProfileDelegatedRetry(
    insufficiency,
    input.currentExecutionProfile,
  )
    ? input.currentExecutionProfile ?? null
    : selectDelegatedRetryExecutionProfile({
        config: input.config,
        orchestration: input.orchestration,
        intentDecision: input.intentDecision,
        currentProfile: input.currentExecutionProfile,
        insufficiency,
      });
  if (!retryProfile) {
    return null;
  }
  const retryPlan = buildDelegatedRetryAttemptPlan({
    targetLabel: input.targetLabel,
    currentProfile: input.currentExecutionProfile,
    retryProfile,
    insufficiency,
    codeSessionId: input.codeSessionId,
    baseSections: input.baseSections,
    baseRecord: input.baseRecord,
    baseDecision: input.intentDecision,
    taskContract: input.taskContract,
  });
  const request = input.buildRetryRequest({
    currentRequest: input.currentRequest,
    retryProfile,
    retryPlan,
    insufficiency,
  });
  input.onRetrying?.({
    request,
    retryProfile,
    retryPlan,
    insufficiency,
  });
  const result = await input.dispatchRetry({
    request,
    retryProfile,
    retryPlan,
    insufficiency,
  });
  const jobDrain = await input.drainPendingJobs();
  if (jobDrain.inFlightRemaining > 0) {
    input.onDrainWaitExpired?.({
      request,
      retryProfile,
      retryPlan,
      insufficiency,
      taskContract: input.taskContract,
      jobDrain,
    });
  }
  const verificationCycle = await input.verifyRetryResult({
    request,
    result,
    retryProfile,
    retryPlan,
    insufficiency,
    taskContract: input.taskContract,
    jobDrain,
  });
  return {
    request,
    result,
    retryProfile,
    retryPlan,
    jobDrain,
    verificationCycle,
  };
}
