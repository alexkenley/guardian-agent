import { describe, expect, it } from 'vitest';
import { INTENT_GATEWAY_MISSING_SUMMARY } from '../intent/summary.js';
import type {
  AnswerConstraints,
  Claim,
  DelegatedResultEnvelope,
  DelegatedTaskContract,
  EvidenceReceipt,
  Interruption,
  ProviderSelectionSnapshot,
  StepReceipt,
  WorkerStopReason,
} from './types.js';
import { buildStepReceipts, computeWorkerRunStatus, matchPlannedStepForTool } from './task-plan.js';
import { buildDelegatedTaskContract, verifyDelegatedResult } from './verifier.js';

function buildRepoInspectionTaskContract(overrides: Partial<DelegatedTaskContract> = {}): DelegatedTaskContract {
  const requireExactFileReferences = overrides.requireExactFileReferences === true;
  return {
    ...buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Inspect the repository and report grounded findings.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'chat_synthesis',
      entities: {},
    }),
    ...overrides,
  };
}

function buildToolExecutionTaskContract(overrides: Partial<DelegatedTaskContract> = {}): DelegatedTaskContract {
  return {
    ...buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'high',
      operation: 'run',
      summary: 'Run the requested command in the remote sandbox.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: false,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      entities: {},
    }),
    ...overrides,
  };
}

function buildFilesystemMutationTaskContract(overrides: Partial<DelegatedTaskContract> = {}): DelegatedTaskContract {
  return {
    ...buildDelegatedTaskContract({
      route: 'filesystem_task',
      confidence: 'high',
      operation: 'run',
      summary: 'Create tmp/manual-web/flag.txt containing test.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: false,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'read', summary: 'Inspect the relevant repo files and collect grounded repo evidence.', required: true },
        { kind: 'answer', summary: 'Answer with grounded findings from the inspected repo files.', required: true, dependsOn: ['step_1'] },
      ],
      entities: {},
    }),
    ...overrides,
  };
}

function buildEnvelope(input?: {
  taskContract?: DelegatedTaskContract;
  finalUserAnswer?: string;
  operatorSummary?: string;
  claims?: DelegatedResultEnvelope['claims'];
  evidenceReceipts?: EvidenceReceipt[];
  interruptions?: Interruption[];
  events?: DelegatedResultEnvelope['events'];
  stopReason?: WorkerStopReason;
  modelProvenance?: ProviderSelectionSnapshot;
  stepReceipts?: StepReceipt[];
  runStatus?: DelegatedResultEnvelope['runStatus'];
}): DelegatedResultEnvelope {
  const taskContract = input?.taskContract ?? buildRepoInspectionTaskContract();
  const evidenceReceipts = [...(input?.evidenceReceipts ?? [])];
  const interruptions = [...(input?.interruptions ?? [])];
  const primaryStepId = taskContract.plan.steps[0]?.stepId;
  const receiptStepIds = new Map<string, string>();
  for (const receipt of evidenceReceipts) {
    const matchedStepId = matchPlannedStepForTool({
      plannedTask: taskContract.plan,
      toolName: receipt.toolName ?? 'tool_call',
      args: { refs: receipt.refs },
    });
    if (matchedStepId) {
      receiptStepIds.set(receipt.receiptId, matchedStepId);
    }
  }
  const stepReceipts: StepReceipt[] = input?.stepReceipts ?? buildStepReceipts({
    plannedTask: taskContract.plan,
    evidenceReceipts,
    toolReceiptStepIds: receiptStepIds,
    interruptions,
  });
  const stopReason = input?.stopReason ?? 'end_turn';
  const runStatus = input?.runStatus ?? computeWorkerRunStatus(
    taskContract.plan,
    stepReceipts,
    interruptions,
    stopReason,
  );
  const finalUserAnswer = runStatus === 'completed'
    ? input?.finalUserAnswer ?? 'Completed the delegated inspection.'
    : undefined;
  return {
    taskContract,
    runStatus,
    stopReason,
    stepReceipts,
    ...(finalUserAnswer ? { finalUserAnswer } : {}),
    operatorSummary: input?.operatorSummary ?? finalUserAnswer ?? 'Delegated worker did not finish cleanly.',
    claims: input?.claims ?? [],
    evidenceReceipts,
    interruptions,
    artifacts: [],
    ...(input?.modelProvenance ? { modelProvenance: input.modelProvenance } : {}),
    events: input?.events ?? [],
  };
}

describe('verifyDelegatedResult', () => {
  it('falls back to resolvedContent when the gateway summary is only a placeholder', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'medium',
      operation: 'inspect',
      summary: INTENT_GATEWAY_MISSING_SUMMARY,
      resolvedContent: 'Inspect this repo and tell me which files define the delegated worker completion contract.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'chat_synthesis',
      plannedSteps: [
        { kind: 'search', summary: 'Search the repo for relevant files.', required: true },
        { kind: 'answer', summary: 'Answer the request directly.', required: true, dependsOn: ['step_1'] },
      ],
      entities: {},
    });

    expect(taskContract.summary).toBe(
      'Inspect this repo and tell me which files define the delegated worker completion contract.',
    );
    expect(taskContract.plan.steps).toMatchObject([
      { kind: 'search', summary: 'Search the repo for relevant files.' },
      { kind: 'read', summary: 'Read the specific implementation files needed to ground the exact file references.' },
      {
        kind: 'answer',
        summary: 'Inspect this repo and tell me which files define the delegated worker completion contract. Cite the specific implementation files, not just files that were read during search.',
      },
    ]);
  });

  it('injects a read step for exact-file repo inspections before the final answer step', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Inspect the repository and return the exact files.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'chat_synthesis',
      plannedSteps: [
        { kind: 'search', summary: 'Search the repo for the relevant implementation files.', required: true },
        { kind: 'answer', summary: 'Answer with the exact files backed by the repo evidence.', required: true, dependsOn: ['step_1'] },
      ],
      entities: {},
    });

    expect(taskContract.plan.steps.map((step) => step.kind)).toEqual(['search', 'read', 'answer']);
    expect(taskContract.plan.steps[1]).toMatchObject({
      kind: 'read',
      expectedToolCategories: ['fs_read', 'fs_list'],
    });
    expect(taskContract.plan.steps[2]).toMatchObject({
      kind: 'answer',
      dependsOn: ['step_1', 'step_2'],
    });
  });

  it('does not treat dependent answer steps as satisfied when the required read step is still missing', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Inspect the repository and return the exact files.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'chat_synthesis',
      plannedSteps: [
        { kind: 'search', summary: 'Search the repo for candidate files.', required: true },
        { kind: 'read', summary: 'Read the exact implementation files.', required: true, dependsOn: ['step_1'] },
        { kind: 'answer', summary: 'Answer with the exact grounded files.', required: true, dependsOn: ['step_2'] },
      ],
      entities: {},
    });
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        stepReceipts: [
          {
            stepId: 'step_1',
            status: 'satisfied',
            evidenceReceiptIds: ['receipt-search'],
            summary: 'Search found candidate files.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            stepId: 'step_2',
            status: 'failed',
            evidenceReceiptIds: [],
            summary: 'Read the exact implementation files.',
            startedAt: 0,
            endedAt: 0,
          },
          {
            stepId: 'step_3',
            status: 'satisfied',
            evidenceReceiptIds: ['receipt-answer'],
            summary: 'The files are src/support/workerProgress.ts and src/timeline/renderTimeline.ts.',
            startedAt: 3,
            endedAt: 4,
          },
        ],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      unsatisfiedStepIds: ['step_2', 'step_3'],
    });
    expect(decision.requiredNextAction).toContain('step_2');
    expect(decision.requiredNextAction).toContain('step_3');
  });

  it('does not let fs_search satisfy the exact-file read step after the search step is already matched', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Inspect the repository and return the exact files.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'chat_synthesis',
      plannedSteps: [
        { kind: 'search', summary: 'Search the repo for candidate files.', required: true },
        { kind: 'answer', summary: 'Answer with the exact grounded files.', required: true, dependsOn: ['step_1'] },
      ],
      entities: {},
    });

    const matchedStepId = matchPlannedStepForTool({
      plannedTask: taskContract.plan,
      toolName: 'fs_search',
      args: {
        path: 'S:\\Development\\GuardianAgent',
        query: 'delegated worker progress',
      },
      previouslyMatchedStepIds: new Set(['step_1']),
    });

    expect(matchedStepId).toBe('step_1');
  });

  it('ignores an incompatible hinted step id and falls back to the matching planned step', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Inspect the repository and return the exact files.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'chat_synthesis',
      plannedSteps: [
        { kind: 'search', summary: 'Search the repo for candidate files.', required: true },
        { kind: 'answer', summary: 'Answer with the exact grounded files.', required: true, dependsOn: ['step_1'] },
      ],
      entities: {},
    });

    const matchedSearchStep = matchPlannedStepForTool({
      hintStepId: 'step_2',
      plannedTask: taskContract.plan,
      toolName: 'fs_search',
      args: {
        path: 'S:\\Development\\GuardianAgent',
        query: 'delegated worker progress',
      },
    });

    expect(matchedSearchStep).toBe('step_1');
  });

  it('keeps the exact-file read step unsatisfied when the worker only collected search receipts', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Inspect the repository and return the exact files.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'chat_synthesis',
      plannedSteps: [
        { kind: 'search', summary: 'Search the repo for candidate files.', required: true },
        { kind: 'answer', summary: 'Answer with the exact grounded files.', required: true, dependsOn: ['step_1'] },
      ],
      entities: {},
    });

    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        evidenceReceipts: [{
          receiptId: 'receipt-search-1',
          sourceType: 'tool_call',
          toolName: 'fs_search',
          status: 'succeeded',
          refs: [
            'src/runtime/intent/route-classifier.ts',
            'src/runtime/intent/structured-recovery.ts',
          ],
          summary: 'Search found candidate files.',
          startedAt: 1,
          endedAt: 2,
        }],
        claims: [
          {
            claimId: 'claim-file-1',
            kind: 'file_reference',
            subject: 'src/runtime/intent/route-classifier.ts',
            value: 'src/runtime/intent/route-classifier.ts',
            evidenceReceiptIds: ['receipt-search-1'],
            confidence: 0.8,
          },
          {
            claimId: 'claim-file-2',
            kind: 'file_reference',
            subject: 'src/runtime/intent/structured-recovery.ts',
            value: 'src/runtime/intent/structured-recovery.ts',
            evidenceReceiptIds: ['receipt-search-1'],
            confidence: 0.8,
          },
        ],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      unsatisfiedStepIds: ['step_2', 'step_3'],
    });
    expect(decision.requiredNextAction).toContain('step_2');
    expect(decision.requiredNextAction).toContain('step_3');
  });

  it('treats failed repo-grounded tool receipts as a contradiction with retryable failed steps', () => {
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        finalUserAnswer: 'The remote sandbox command failed with a 502 from Daytona Main, so I could not complete the inspection.',
        operatorSummary: 'The remote sandbox command failed with a 502 from Daytona Main.',
        evidenceReceipts: [{
          receiptId: 'receipt-1',
          sourceType: 'tool_call',
          toolName: 'fs_search',
          status: 'failed',
          refs: [],
          summary: 'Remote sandbox command failed on Daytona Main. stderr: Request failed with status code 502',
          startedAt: 1,
          endedAt: 2,
        }],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'contradicted',
      retryable: true,
      requiredNextAction: expect.stringContaining('step_1'),
      unsatisfiedStepIds: ['step_1', 'step_2'],
    });
    expect(decision.reasons[0]).toContain('Remote sandbox command failed on Daytona Main');
  });

  it('requires exact-file answers to cite the successful file claims they collected', () => {
    const taskContract = buildRepoInspectionTaskContract({
      requireExactFileReferences: true,
      summary: 'Inspect the repository and return the exact files.',
    });
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: 'I found the delegated worker progress and run timeline implementation after inspecting the repo.',
        operatorSummary: 'I found the delegated worker progress and run timeline implementation after inspecting the repo.',
        stepReceipts: taskContract.plan.steps.map((step, index) => ({
          stepId: step.stepId,
          status: 'satisfied',
          evidenceReceiptIds: index === 1 ? ['receipt-1'] : index === 2 ? ['answer:1'] : [],
          summary: step.summary,
          startedAt: index + 1,
          endedAt: index + 2,
        })),
        evidenceReceipts: [{
          receiptId: 'receipt-1',
          sourceType: 'tool_call',
          toolName: 'fs_read',
          status: 'succeeded',
          refs: ['src/supervisor/worker-manager.ts'],
          summary: 'Read src/supervisor/worker-manager.ts',
          startedAt: 1,
          endedAt: 2,
        }],
        claims: [{
          claimId: 'claim-file-1',
          kind: 'file_reference',
          subject: 'src/supervisor/worker-manager.ts',
          value: 'src/supervisor/worker-manager.ts',
          evidenceReceiptIds: ['receipt-1'],
          confidence: 0.8,
        }],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['file_reference_claim'],
    });
    expect(decision.reasons[0]).toContain('did not cite');
  });

  it('accepts repo-relative citations when successful file claims use absolute workspace paths', () => {
    const taskContract = buildRepoInspectionTaskContract({
      requireExactFileReferences: true,
      summary: 'Inspect the repository and return the exact files.',
    });
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: 'The delegated worker progress lives in `src/supervisor/worker-manager.ts`.',
        operatorSummary: 'The delegated worker progress lives in `src/supervisor/worker-manager.ts`.',
        stepReceipts: taskContract.plan.steps.map((step, index) => ({
          stepId: step.stepId,
          status: 'satisfied',
          evidenceReceiptIds: index === 1 ? ['receipt-1'] : index === 2 ? ['answer:1'] : [],
          summary: step.summary,
          startedAt: index + 1,
          endedAt: index + 2,
        })),
        evidenceReceipts: [{
          receiptId: 'receipt-1',
          sourceType: 'tool_call',
          toolName: 'fs_read',
          status: 'succeeded',
          refs: ['S:\\Development\\GuardianAgent\\src\\supervisor\\worker-manager.ts'],
          summary: 'Read S:\\Development\\GuardianAgent\\src\\supervisor\\worker-manager.ts',
          startedAt: 1,
          endedAt: 2,
        }],
        claims: [{
          claimId: 'claim-file-absolute-1',
          kind: 'file_reference',
          subject: 'S:\\Development\\GuardianAgent\\src\\supervisor\\worker-manager.ts',
          value: 'S:\\Development\\GuardianAgent\\src\\supervisor\\worker-manager.ts',
          evidenceReceiptIds: ['receipt-1'],
          confidence: 0.8,
        }],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'satisfied',
      retryable: false,
    });
  });

  it('does not accept discovery-only success as execution evidence for command runs', () => {
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract: buildToolExecutionTaskContract(),
        finalUserAnswer: 'I found the code_remote_exec tool but have not run the command yet.',
        operatorSummary: 'I found the code_remote_exec tool but have not run the command yet.',
        evidenceReceipts: [{
          receiptId: 'receipt-1',
          sourceType: 'tool_call',
          toolName: 'find_tools',
          status: 'succeeded',
          refs: [],
          summary: 'Discovered code_remote_exec.',
          startedAt: 1,
          endedAt: 2,
        }],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      unsatisfiedStepIds: ['step_1'],
    });
  });

  it('preserves concrete answer and write steps for coding run contracts', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'high',
      operation: 'run',
      summary: 'Tell me the current coding workspace path, then create tmp/manual-web/workspace-check.txt containing that path.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: false,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        {
          kind: 'answer',
          summary: 'Tell me the current coding workspace path.',
          required: true,
        },
        {
          kind: 'write',
          summary: 'Create tmp/manual-web/workspace-check.txt containing that path.',
          required: true,
          dependsOn: ['step_1'],
        },
      ],
      entities: {},
    });

    expect(taskContract.kind).toBe('tool_execution');
    expect(taskContract.plan.steps).toMatchObject([
      { kind: 'answer' },
      { kind: 'write', expectedToolCategories: ['fs_write'], dependsOn: ['step_1'] },
    ]);

    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        finalUserAnswer: 'The current coding workspace path is S:/Development/GuardianAgent.',
        operatorSummary: 'Wrote tmp/manual-web/workspace-check.txt.',
        stepReceipts: [
          {
            stepId: 'step_1',
            status: 'satisfied',
            evidenceReceiptIds: ['answer:1'],
            summary: 'The current coding workspace path is S:/Development/GuardianAgent.',
            startedAt: 1,
            endedAt: 1,
          },
          {
            stepId: 'step_2',
            status: 'satisfied',
            evidenceReceiptIds: ['receipt-write-1'],
            summary: 'Wrote tmp/manual-web/workspace-check.txt.',
            startedAt: 2,
            endedAt: 3,
          },
        ],
        evidenceReceipts: [{
          receiptId: 'receipt-write-1',
          sourceType: 'tool_call',
          toolName: 'fs_write',
          status: 'succeeded',
          refs: ['tmp/manual-web/workspace-check.txt'],
          summary: 'Wrote tmp/manual-web/workspace-check.txt.',
          startedAt: 2,
          endedAt: 3,
        }],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'satisfied',
      retryable: false,
    });
  });

  it('uses a filesystem mutation plan when gateway planned steps are stale read-only evidence steps', () => {
    const taskContract = buildFilesystemMutationTaskContract();

    expect(taskContract.kind).toBe('filesystem_mutation');
    expect(taskContract.plan.steps.map((step) => step.kind)).toEqual(['write']);
    expect(taskContract.plan.steps[0]?.summary).toBe('Create tmp/manual-web/flag.txt containing test.');
    expect(taskContract.plan.steps[0]?.expectedToolCategories).toEqual(['fs_write']);
  });

  it('verifies filesystem mutation receipts against the mutation contract instead of stale repo evidence steps', () => {
    const taskContract = buildFilesystemMutationTaskContract();
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        finalUserAnswer: 'Created tmp/manual-web/flag.txt.',
        operatorSummary: 'Created tmp/manual-web/flag.txt.',
        evidenceReceipts: [{
          receiptId: 'receipt-write-1',
          sourceType: 'tool_call',
          toolName: 'fs_write',
          status: 'succeeded',
          refs: ['tmp/manual-web/flag.txt'],
          summary: 'Wrote tmp/manual-web/flag.txt.',
          startedAt: 1,
          endedAt: 2,
        }],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'satisfied',
      retryable: false,
    });
  });

  it('requires a real fs_write receipt for file-targeted filesystem mutation write steps', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'filesystem_task',
      confidence: 'high',
      operation: 'run',
      summary: 'Search src/runtime for planned_steps. Write a short summary of what you find to tmp/manual-web/planned-steps-summary.txt.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: false,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search src/runtime for planned_steps.', required: true },
        { kind: 'write', summary: 'Write a short summary of what you find to tmp/manual-web/planned-steps-summary.txt.', required: true },
      ],
      entities: {},
    });

    expect(taskContract.plan.steps).toMatchObject([
      { kind: 'search', expectedToolCategories: ['fs_search', 'code_symbol_search'] },
      { kind: 'write', expectedToolCategories: ['fs_write'] },
    ]);

    expect(matchPlannedStepForTool({
      hintStepId: 'step_2',
      plannedTask: taskContract.plan,
      toolName: 'fs_search',
      args: {
        path: 'src/runtime',
        query: 'planned_steps',
      },
    })).toBe('step_1');

    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        operatorSummary: 'Now I have the summary. Let me write it.',
        evidenceReceipts: [
          {
            receiptId: 'receipt-search-1',
            sourceType: 'tool_call',
            toolName: 'fs_search',
            status: 'succeeded',
            refs: [
              'src/runtime/intent/route-classifier.ts',
              'src/runtime/intent/structured-recovery.ts',
            ],
            summary: 'Searched src/runtime for planned_steps.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            receiptId: 'receipt-mkdir-1',
            sourceType: 'tool_call',
            toolName: 'fs_mkdir',
            status: 'succeeded',
            refs: ['tmp/manual-web'],
            summary: 'Created tmp/manual-web.',
            startedAt: 3,
            endedAt: 4,
          },
        ],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      unsatisfiedStepIds: ['step_2'],
      missingEvidenceKinds: ['write'],
    });
  });

  it('accepts OpenAI dated snapshot ids when they match the selected alias model', () => {
    const taskContract = buildRepoInspectionTaskContract();
    const decision = verifyDelegatedResult({
      executionProfile: {
        id: 'frontier_deep',
        providerName: 'openai',
        providerType: 'openai',
        providerModel: 'gpt-4o',
        providerLocality: 'external',
        providerTier: 'frontier',
        requestedTier: 'external',
        preferredAnswerPath: 'direct',
        expectedContextPressure: 'low',
        contextBudget: 36_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        reason: 'test profile',
      },
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        stepReceipts: taskContract.plan.steps.map((step, index) => ({
          stepId: step.stepId,
          status: 'satisfied',
          evidenceReceiptIds: index === 0 ? ['receipt-1'] : index === 1 ? ['answer:1'] : [],
          summary: step.summary,
          startedAt: index + 1,
          endedAt: index + 2,
        })),
        evidenceReceipts: [{
          receiptId: 'receipt-1',
          sourceType: 'tool_call',
          toolName: 'fs_read',
          status: 'succeeded',
          refs: ['src/runtime/run-timeline.ts'],
          summary: 'Read src/runtime/run-timeline.ts',
          startedAt: 1,
          endedAt: 2,
        }],
        modelProvenance: {
          resolvedProviderName: 'openai',
          resolvedProviderType: 'openai',
          resolvedProviderProfileName: 'openai',
          resolvedProviderModel: 'gpt-4o-2024-08-06',
        },
      }),
    });

    expect(decision.decision).toBe('satisfied');
  });

  it('still rejects real model drift when the reported model is not the selected alias', () => {
    const decision = verifyDelegatedResult({
      executionProfile: {
        id: 'frontier_deep',
        providerName: 'openai',
        providerType: 'openai',
        providerModel: 'gpt-4o',
        providerLocality: 'external',
        providerTier: 'frontier',
        requestedTier: 'external',
        preferredAnswerPath: 'direct',
        expectedContextPressure: 'low',
        contextBudget: 36_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        reason: 'test profile',
      },
      envelope: buildEnvelope({
        modelProvenance: {
          resolvedProviderName: 'openai',
          resolvedProviderType: 'openai',
          resolvedProviderProfileName: 'openai',
          resolvedProviderModel: 'gpt-4o-mini-2024-07-18',
        },
      }),
    });

    expect(decision).toMatchObject({
      decision: 'contradicted',
      retryable: false,
      missingEvidenceKinds: ['provider_selection'],
    });
    expect(decision.reasons[0]).toContain("gpt-4o-mini-2024-07-18");
  });

  it('treats failed execution receipts as a contradiction for command runs', () => {
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract: buildToolExecutionTaskContract(),
        finalUserAnswer: 'The remote sandbox command failed with a 502 from Daytona Main.',
        operatorSummary: 'The remote sandbox command failed with a 502 from Daytona Main.',
        evidenceReceipts: [{
          receiptId: 'receipt-1',
          sourceType: 'tool_call',
          toolName: 'code_remote_exec',
          status: 'failed',
          refs: [],
          summary: 'Remote sandbox command failed on Daytona Main. stderr: Request failed with status code 502',
          startedAt: 1,
          endedAt: 2,
        }],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'contradicted',
      retryable: true,
      requiredNextAction: expect.stringContaining('step_1'),
      unsatisfiedStepIds: ['step_1'],
    });
    expect(decision.reasons[0]).toContain('Remote sandbox command failed on Daytona Main');
  });

  describe('repo inspection answer constraints', () => {
    it('rejects repo-inspection answers that cite search-hit files but no implementation files', () => {
      const taskContract = buildRepoInspectionTaskContract({
        requireExactFileReferences: true,
        answerConstraints: {
          requiresImplementationFiles: true,
          requiresSymbolNames: true,
        },
        summary: 'Inspect this repo and tell me which files and functions define the delegated worker completion contract.',
      });
      // Only file_reference claims, no implementation_file claims
      const decision = verifyDelegatedResult({
        envelope: buildEnvelope({
          taskContract,
          runStatus: 'completed',
          finalUserAnswer: 'The relevant files are in src/runtime/execution/ and src/worker/.',
          operatorSummary: 'The relevant files are in src/runtime/execution/ and src/worker/.',
          stepReceipts: taskContract.plan.steps.map((step, index) => ({
            stepId: step.stepId,
            status: 'satisfied' as const,
            evidenceReceiptIds: index === 2 ? ['receipt-1'] : [],
            summary: step.summary,
            startedAt: index + 1,
            endedAt: index + 2,
          })),
          evidenceReceipts: [{
            receiptId: 'receipt-1',
            sourceType: 'tool_call',
            toolName: 'fs_search',
            status: 'succeeded',
            refs: ['src/runtime/execution/'],
            summary: 'Searched for relevant files',
            startedAt: 1,
            endedAt: 2,
          }],
          claims: [{
            claimId: 'claim-search-1',
            kind: 'file_reference',
            subject: 'src/runtime/execution/',
            value: 'src/runtime/execution/',
            evidenceReceiptIds: ['receipt-1'],
            confidence: 0.8,
          }],
        }),
      });

      expect(decision).toMatchObject({
        decision: 'insufficient',
        missingEvidenceKinds: expect.arrayContaining(['implementation_file_claim']),
      });
    });

    it('accepts repo-inspection answers with implementation_file claims', () => {
      const taskContract = buildRepoInspectionTaskContract({
        requireExactFileReferences: true,
        answerConstraints: {
          requiresImplementationFiles: true,
        },
        summary: 'Inspect this repo and tell me which files define the delegated worker completion contract.',
      });
      const decision = verifyDelegatedResult({
        envelope: buildEnvelope({
          taskContract,
          runStatus: 'completed',
          finalUserAnswer: 'The delegated worker completion contract is defined in `src/runtime/execution/types.ts` with `DelegatedTaskContract` and `DelegatedResultEnvelope`.',
          operatorSummary: 'The delegated worker completion contract is defined in src/runtime/execution/types.ts',
          stepReceipts: taskContract.plan.steps.map((step, index) => ({
            stepId: step.stepId,
            status: 'satisfied' as const,
            evidenceReceiptIds: index === 2 ? ['receipt-1'] : [],
            summary: step.summary,
            startedAt: index + 1,
            endedAt: index + 2,
          })),
          evidenceReceipts: [{
            receiptId: 'receipt-1',
            sourceType: 'tool_call',
            toolName: 'fs_read',
            status: 'succeeded',
            refs: ['src/runtime/execution/types.ts'],
            summary: 'Read src/runtime/execution/types.ts',
            startedAt: 1,
            endedAt: 2,
          }],
          claims: [{
            claimId: 'claim-impl-1',
            kind: 'implementation_file',
            subject: 'src/runtime/execution/types.ts',
            value: 'src/runtime/execution/types.ts',
            evidenceReceiptIds: ['receipt-1'],
            confidence: 0.9,
          }],
        }),
      });

      expect(decision).toMatchObject({
        decision: 'satisfied',
        retryable: false,
      });
    });

    it('rejects answers that lack symbol names when requiresSymbolNames is set', () => {
      const taskContract = buildRepoInspectionTaskContract({
        requireExactFileReferences: true,
        answerConstraints: {
          requiresImplementationFiles: true,
          requiresSymbolNames: true,
        },
        summary: 'Which files and functions implement the verifier?',
      });
      const decision = verifyDelegatedResult({
        envelope: buildEnvelope({
          taskContract,
          runStatus: 'completed',
          finalUserAnswer: 'The relevant files are src/runtime/execution/verifier.ts.',
          operatorSummary: 'The relevant files are src/runtime/execution/verifier.ts.',
          stepReceipts: taskContract.plan.steps.map((step, index) => ({
            stepId: step.stepId,
            status: 'satisfied' as const,
            evidenceReceiptIds: index === 2 ? ['receipt-1'] : [],
            summary: step.summary,
            startedAt: index + 1,
            endedAt: index + 2,
          })),
          evidenceReceipts: [{
            receiptId: 'receipt-1',
            sourceType: 'tool_call',
            toolName: 'fs_read',
            status: 'succeeded',
            refs: ['src/runtime/execution/verifier.ts'],
            summary: 'Read src/runtime/execution/verifier.ts',
            startedAt: 1,
            endedAt: 2,
          }],
          claims: [{
            claimId: 'claim-impl-1',
            kind: 'implementation_file',
            subject: 'src/runtime/execution/verifier.ts',
            value: 'src/runtime/execution/verifier.ts',
            evidenceReceiptIds: ['receipt-1'],
            confidence: 0.9,
          }],
        }),
      });

      // The answer doesn't include any symbol names (no PascalCase or backtick-quoted)
      // and there are no symbol_reference claims
      expect(decision).toMatchObject({
        decision: 'insufficient',
        missingEvidenceKinds: expect.arrayContaining(['symbol_reference_claim']),
      });
    });

    it('accepts answers with symbol_reference claims when requiresSymbolNames is set', () => {
      const taskContract = buildRepoInspectionTaskContract({
        requireExactFileReferences: true,
        answerConstraints: {
          requiresImplementationFiles: true,
          requiresSymbolNames: true,
        },
        summary: 'Which files and functions implement the verifier?',
      });
      const decision = verifyDelegatedResult({
        envelope: buildEnvelope({
          taskContract,
          runStatus: 'completed',
          finalUserAnswer: 'The verifier is implemented in `src/runtime/execution/verifier.ts` with `verifyDelegatedResult` and `verifyExactFileReferenceRequirements`.',
          operatorSummary: 'The verifier is implemented in src/runtime/execution/verifier.ts',
          stepReceipts: taskContract.plan.steps.map((step, index) => ({
            stepId: step.stepId,
            status: 'satisfied' as const,
            evidenceReceiptIds: index === 2 ? ['receipt-1', 'answer:1'] : [],
            summary: step.summary,
            startedAt: index + 1,
            endedAt: index + 2,
          })),
          evidenceReceipts: [{
            receiptId: 'receipt-1',
            sourceType: 'tool_call',
            toolName: 'fs_read',
            status: 'succeeded',
            refs: ['src/runtime/execution/verifier.ts'],
            summary: 'Read src/runtime/execution/verifier.ts',
            startedAt: 1,
            endedAt: 2,
          }],
          claims: [
            {
              claimId: 'claim-impl-1',
              kind: 'implementation_file',
              subject: 'src/runtime/execution/verifier.ts',
              value: 'src/runtime/execution/verifier.ts',
              evidenceReceiptIds: ['receipt-1'],
              confidence: 0.9,
            },
            {
              claimId: 'answer:1:symbol:verifyDelegatedResult',
              kind: 'symbol_reference',
              subject: 'verifyDelegatedResult',
              value: 'verifyDelegatedResult',
              evidenceReceiptIds: ['answer:1'],
              confidence: 0.85,
            },
            {
              claimId: 'answer:1:symbol:verifyExactFileReferenceRequirements',
              kind: 'symbol_reference',
              subject: 'verifyExactFileReferenceRequirements',
              value: 'verifyExactFileReferenceRequirements',
              evidenceReceiptIds: ['answer:1'],
              confidence: 0.85,
            },
          ],
        }),
      });

      expect(decision).toMatchObject({
        decision: 'satisfied',
        retryable: false,
      });
    });

    it('rejects readonly-constrained repo inspections that have filesystem mutations', () => {
      const taskContract = buildRepoInspectionTaskContract({
        requireExactFileReferences: true,
        answerConstraints: {
          readonly: true,
          requiresImplementationFiles: true,
        },
        summary: 'Inspect this repo. Do not edit anything.',
      });
      const decision = verifyDelegatedResult({
        envelope: buildEnvelope({
          taskContract,
          runStatus: 'completed',
          finalUserAnswer: 'The implementation is in src/runtime/execution/types.ts.',
          operatorSummary: 'The implementation is in src/runtime/execution/types.ts.',
          stepReceipts: taskContract.plan.steps.map((step, index) => ({
            stepId: step.stepId,
            status: 'satisfied' as const,
            evidenceReceiptIds: index === 2 ? ['receipt-1'] : [],
            summary: step.summary,
            startedAt: index + 1,
            endedAt: index + 2,
          })),
          evidenceReceipts: [{
            receiptId: 'receipt-1',
            sourceType: 'tool_call',
            toolName: 'fs_read',
            status: 'succeeded',
            refs: ['src/runtime/execution/types.ts'],
            summary: 'Read src/runtime/execution/types.ts',
            startedAt: 1,
            endedAt: 2,
          }],
          claims: [
            {
              claimId: 'claim-impl-1',
              kind: 'implementation_file',
              subject: 'src/runtime/execution/types.ts',
              value: 'src/runtime/execution/types.ts',
              evidenceReceiptIds: ['receipt-1'],
              confidence: 0.9,
            },
            {
              claimId: 'claim-mutation-1',
              kind: 'filesystem_mutation',
              subject: 'fs_write',
              value: 'wrote tmp/some-file.txt',
              evidenceReceiptIds: [],
              confidence: 0.9,
            },
          ],
        }),
      });

      expect(decision).toMatchObject({
        decision: 'insufficient',
        missingEvidenceKinds: expect.arrayContaining(['readonly_violation']),
      });
    });
  });
});
