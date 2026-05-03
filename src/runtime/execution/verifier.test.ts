import { describe, expect, it } from 'vitest';
import {
  INTENT_GATEWAY_MISSING_SUMMARY,
  normalizeUserFacingIntentGatewaySummary,
} from '../intent/summary.js';
import { normalizeIntentGatewayDecision } from '../intent/structured-recovery.js';
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

function buildSimpleSecurityTaskContract(overrides: Partial<DelegatedTaskContract> = {}): DelegatedTaskContract {
  return {
    ...buildDelegatedTaskContract({
      route: 'security_task',
      confidence: 'high',
      operation: 'read',
      summary: 'Refuse to expose raw credential values.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'security_analysis',
      preferredTier: 'local',
      requiresRepoGrounding: false,
      requiresToolSynthesis: false,
      requireExactFileReferences: false,
      expectedContextPressure: 'low',
      preferredAnswerPath: 'chat_synthesis',
      simpleVsComplex: 'simple',
      plannedSteps: [
        { kind: 'answer', summary: 'Answer safely without exposing credentials.', required: true },
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
  it('does not promote provider fallback failures into delegated task summaries', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'unknown',
      confidence: 'low',
      operation: 'unknown',
      summary: 'xAI (Grok) rate limit exceeded or quota depleted. Check the account limits for this provider.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: false,
      expectedContextPressure: 'medium',
      simpleVsComplex: 'simple',
      preferredAnswerPath: 'direct',
      plannedSteps: [
        { kind: 'read', summary: 'Check requested connector statuses.', required: true },
        { kind: 'answer', summary: 'Return a concise status summary.', required: true, dependsOn: ['step_1'] },
      ],
      entities: {},
    });

    expect(normalizeUserFacingIntentGatewaySummary('xAI (Grok) rate limit exceeded or quota depleted. Check the account limits for this provider.'))
      .toBeUndefined();
    expect(taskContract.summary).toBeUndefined();
    expect(taskContract.plan.steps.map((step) => step.summary)).toEqual([
      'Check requested connector statuses.',
      'Return a concise status summary.',
    ]);
  });

  it('requires evidence and disables answer-first when a general task has required tool-backed steps', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'automation_control',
      confidence: 'high',
      operation: 'read',
      summary: 'Find matching automations and suggest one useful automation.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        {
          kind: 'read',
          summary: 'Read the existing automation catalog.',
          expectedToolCategories: ['automation_list'],
          required: true,
        },
        { kind: 'answer', summary: 'Suggest one useful automation.', required: true, dependsOn: ['step_1'] },
      ],
      entities: {},
    });

    expect(taskContract.kind).toBe('general_answer');
    expect(taskContract.requiresEvidence).toBe(true);
    expect(taskContract.allowsAnswerFirst).toBe(false);
    expect(taskContract.plan.steps.map((step) => step.kind)).toEqual(['read', 'answer']);
  });

  it('rejects completed envelopes whose final answer is only an in-progress promise', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'run',
      summary: 'Search web and repo evidence, then return a comparison.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web evidence.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search the repo evidence.', expectedToolCategories: ['fs_search'], required: true },
        { kind: 'answer', summary: 'Return the requested comparison.', required: true, dependsOn: ['step_1', 'step_2'] },
      ],
      entities: {},
    });
    const finalAnswer = "I'll run both searches in parallel and then compare the results.";
    const stepReceipts: StepReceipt[] = taskContract.plan.steps.map((step, index) => ({
      stepId: step.stepId,
      status: 'satisfied',
      evidenceReceiptIds: [`receipt-${index + 1}`],
      summary: step.kind === 'answer' ? finalAnswer : step.summary,
      startedAt: index + 1,
      endedAt: index + 1,
    }));

    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        stepReceipts,
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['step_3'],
    });
  });

  it('rejects completed evidence-backed envelopes whose final answer is a generic fallback', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'run',
      summary: 'Check connector status and repo evidence, then return six bullets.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        {
          kind: 'read',
          summary: 'Check requested connector statuses.',
          expectedToolCategories: ['vercel_status', 'whm_status', 'automation_list'],
          required: true,
        },
        {
          kind: 'search',
          summary: 'Search the repo evidence.',
          expectedToolCategories: ['repo_inspect'],
          required: true,
        },
        {
          kind: 'answer',
          summary: 'Return six short evidence-backed bullets.',
          required: true,
          dependsOn: ['step_1', 'step_2'],
        },
      ],
      entities: {},
    });
    const finalAnswer = 'I could not generate a final response for that request.';
    const stepReceipts: StepReceipt[] = taskContract.plan.steps.map((step, index) => ({
      stepId: step.stepId,
      status: 'satisfied',
      evidenceReceiptIds: [`receipt-${index + 1}`],
      summary: step.kind === 'answer' ? finalAnswer : step.summary,
      startedAt: index + 1,
      endedAt: index + 1,
    }));

    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        stepReceipts,
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['step_3'],
    });
  });

  it('rejects completed envelopes whose final answer promises another search before synthesis', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'run',
      summary: 'Search web and repo evidence, then return a comparison.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web evidence.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search the repo evidence.', expectedToolCategories: ['fs_search'], required: true },
        { kind: 'answer', summary: 'Return the requested comparison.', required: true, dependsOn: ['step_1', 'step_2'] },
      ],
      entities: {},
    });
    const finalAnswer = 'I have step_1 evidence already (title = "Example Domain"). Let me search for the browser read tool implementation more specifically in the source code, then deliver the comparison.';
    const stepReceipts: StepReceipt[] = taskContract.plan.steps.map((step, index) => ({
      stepId: step.stepId,
      status: 'satisfied',
      evidenceReceiptIds: [`receipt-${index + 1}`],
      summary: step.kind === 'answer' ? finalAnswer : step.summary,
      startedAt: index + 1,
      endedAt: index + 1,
    }));

    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        stepReceipts,
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['step_3'],
    });
  });

  it('rejects completed envelopes whose final answer promises further verification', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'high',
      operation: 'search',
      summary: 'Search web and repo evidence, then return a comparison.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web evidence.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search the repo evidence.', expectedToolCategories: ['fs_search'], required: true },
        { kind: 'answer', summary: 'Return the requested comparison.', required: true, dependsOn: ['step_1', 'step_2'] },
      ],
      entities: {},
    });
    const finalAnswer = 'Let me verify the implementation chain more thoroughly by inspecting the actual browser read handler and its delegate, rather than stopping at the registration wrapper.';
    const stepReceipts: StepReceipt[] = taskContract.plan.steps.map((step, index) => ({
      stepId: step.stepId,
      status: 'satisfied',
      evidenceReceiptIds: [`receipt-${index + 1}`],
      summary: step.kind === 'answer' ? finalAnswer : step.summary,
      startedAt: index + 1,
      endedAt: index + 1,
    }));

    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        stepReceipts,
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['step_3'],
    });
  });

  it('rejects completed envelopes whose final answer exposes raw pseudo tool-call markup', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'personal_assistant_task',
      confidence: 'high',
      operation: 'create',
      summary: 'Save a memory marker and create a local calendar appointment.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'memory_save', summary: 'Save the marker to memory.', expectedToolCategories: ['memory_save'], required: true },
        { kind: 'write', summary: 'Create the local calendar appointment.', expectedToolCategories: ['second_brain_calendar_upsert'], required: true, dependsOn: ['step_1'] },
        { kind: 'answer', summary: 'Confirm both actions.', required: true, dependsOn: ['step_1', 'step_2'] },
      ],
      entities: {},
    });
    const finalAnswer = '[TOOL_CALL]\n{"name":"second_brain_calendar_upsert","arguments":{"title":"Take Benny to the vet"}}\n[/TOOL_CALL]';
    const stepReceipts: StepReceipt[] = taskContract.plan.steps.map((step, index) => ({
      stepId: step.stepId,
      status: 'satisfied',
      evidenceReceiptIds: [`receipt-${index + 1}`],
      summary: step.kind === 'answer' ? finalAnswer : step.summary,
      startedAt: index + 1,
      endedAt: index + 1,
    }));

    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        stepReceipts,
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['step_3'],
    });
  });

  it('rejects mixed-domain answers that conclude no repo matches for implementation-location requests without repo file evidence', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'run',
      summary: 'Search web, repo, and memory evidence before answering.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web for the title of https://example.com.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search this workspace for where execution graph mutation approval resume events are emitted.', expectedToolCategories: ['fs_search'], required: true },
        { kind: 'search', summary: 'Search memory for SMOKE-MEM-42801.', expectedToolCategories: ['memory_search'], required: true },
        { kind: 'answer', summary: 'Return three short bullets with what each source found.', required: true, dependsOn: ['step_1', 'step_2', 'step_3'] },
      ],
      entities: {},
    });
    const finalAnswer = [
      '- Web: https://example.com title is "Example Domain".',
      '- Repo: No content matches found for "mutation approval resume" across 20k+ scanned files; emission site may use different phrasing.',
      '- Memory: SMOKE-MEM-42801 found.',
    ].join('\n');
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
        stepReceipts: [
          {
            stepId: 'step_1',
            status: 'satisfied',
            evidenceReceiptIds: ['receipt-web'],
            summary: 'Found title Example Domain.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            stepId: 'step_2',
            status: 'satisfied',
            evidenceReceiptIds: ['receipt-repo'],
            summary: 'No content matches found for mutation approval resume.',
            startedAt: 3,
            endedAt: 4,
          },
          {
            stepId: 'step_3',
            status: 'satisfied',
            evidenceReceiptIds: ['receipt-memory'],
            summary: 'Found SMOKE-MEM-42801.',
            startedAt: 5,
            endedAt: 6,
          },
          {
            stepId: 'step_4',
            status: 'satisfied',
            evidenceReceiptIds: ['answer:1'],
            summary: finalAnswer,
            startedAt: 7,
            endedAt: 8,
          },
        ],
        evidenceReceipts: [
          {
            receiptId: 'receipt-web',
            sourceType: 'tool_call',
            toolName: 'web_search',
            status: 'succeeded',
            refs: ['https://example.com/'],
            summary: 'Found title Example Domain.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            receiptId: 'receipt-repo',
            sourceType: 'tool_call',
            toolName: 'fs_search',
            status: 'succeeded',
            refs: [],
            summary: 'No content matches found for "mutation approval resume".',
            startedAt: 3,
            endedAt: 4,
          },
          {
            receiptId: 'receipt-memory',
            sourceType: 'tool_call',
            toolName: 'memory_search',
            status: 'succeeded',
            refs: ['memory:smoke'],
            summary: 'Found SMOKE-MEM-42801.',
            startedAt: 5,
            endedAt: 6,
          },
        ],
        claims: [{
          claimId: 'answer:1:answer',
          kind: 'answer',
          subject: 'final_answer',
          value: finalAnswer,
          evidenceReceiptIds: ['answer:1'],
          confidence: 1,
        }],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['repo_evidence'],
      unsatisfiedStepIds: ['step_2', 'step_4'],
    });
    expect(decision.requiredNextAction).toContain('targeted repo inspection');
  });

  it('allows no-match repo searches when the request is not asking for an implementation location', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'search',
      summary: 'Search the repo for an arbitrary smoke marker and answer.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search this workspace for SMOKE-ABSENT-00000.', expectedToolCategories: ['fs_search'], required: true },
        { kind: 'answer', summary: 'Say whether the marker exists.', required: true, dependsOn: ['step_1'] },
      ],
      entities: {},
    });
    const finalAnswer = 'No content matches found for SMOKE-ABSENT-00000.';
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
        stepReceipts: [
          {
            stepId: 'step_1',
            status: 'satisfied',
            evidenceReceiptIds: ['receipt-repo'],
            summary: finalAnswer,
            startedAt: 1,
            endedAt: 2,
          },
          {
            stepId: 'step_2',
            status: 'satisfied',
            evidenceReceiptIds: ['answer:1'],
            summary: finalAnswer,
            startedAt: 3,
            endedAt: 4,
          },
        ],
        evidenceReceipts: [{
          receiptId: 'receipt-repo',
          sourceType: 'tool_call',
          toolName: 'fs_search',
          status: 'succeeded',
          refs: [],
          summary: finalAnswer,
          startedAt: 1,
          endedAt: 2,
        }],
        claims: [{
          claimId: 'answer:1:answer',
          kind: 'answer',
          subject: 'final_answer',
          value: finalAnswer,
          evidenceReceiptIds: ['answer:1'],
          confidence: 1,
        }],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'satisfied',
      retryable: false,
    });
  });

  it('rejects implementation-location no-match answers backed only by broad repo search refs', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'search',
      summary: 'Search web, repo, and memory evidence before answering.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web for the title of https://example.com.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search this workspace for where execution graph mutation approval resume events are emitted.', expectedToolCategories: ['fs_search'], required: true },
        { kind: 'search', summary: 'Search memory for SMOKE-MEM-42801.', expectedToolCategories: ['memory_search'], required: true },
        { kind: 'answer', summary: 'Return three short bullets with what each source found.', required: true, dependsOn: ['step_1', 'step_2', 'step_3'] },
      ],
      entities: {},
    });
    const finalAnswer = [
      '- Web: https://example.com title is "Example Domain".',
      '- Repo: No content matches were found for "execution graph mutation approval resume"; closest broad hits were chat and verifier files, but no emission site was identified.',
      '- Memory: SMOKE-MEM-42801 found.',
    ].join('\n');
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
        stepReceipts: [
          { stepId: 'step_1', status: 'satisfied', evidenceReceiptIds: ['receipt-web'], summary: 'Found title.', startedAt: 1, endedAt: 2 },
          { stepId: 'step_2', status: 'satisfied', evidenceReceiptIds: ['receipt-repo'], summary: 'Found broad repo hits but no emission site.', startedAt: 3, endedAt: 4 },
          { stepId: 'step_3', status: 'satisfied', evidenceReceiptIds: ['receipt-memory'], summary: 'Found memory marker.', startedAt: 5, endedAt: 6 },
          { stepId: 'step_4', status: 'satisfied', evidenceReceiptIds: ['answer:1'], summary: finalAnswer, startedAt: 7, endedAt: 8 },
        ],
        evidenceReceipts: [
          { receiptId: 'receipt-web', sourceType: 'tool_call', toolName: 'web_search', status: 'succeeded', refs: ['https://example.com/'], summary: 'Found title Example Domain.', startedAt: 1, endedAt: 2 },
          {
            receiptId: 'receipt-repo',
            sourceType: 'tool_call',
            toolName: 'fs_search',
            status: 'succeeded',
            refs: ['src/chat-agent.ts', 'src/runtime/execution/verifier.test.ts'],
            summary: 'Search returned broad chat and verifier hits without a confirmed emission site.',
            startedAt: 3,
            endedAt: 4,
          },
          { receiptId: 'receipt-memory', sourceType: 'tool_call', toolName: 'memory_search', status: 'succeeded', refs: ['memory:smoke'], summary: 'Found SMOKE-MEM-42801.', startedAt: 5, endedAt: 6 },
        ],
        claims: [
          {
            claimId: 'claim-search-1',
            kind: 'file_reference',
            subject: 'src/chat-agent.ts',
            value: 'src/chat-agent.ts',
            evidenceReceiptIds: ['receipt-repo'],
            confidence: 0.7,
          },
          {
            claimId: 'claim-search-2',
            kind: 'file_reference',
            subject: 'src/runtime/execution/verifier.test.ts',
            value: 'src/runtime/execution/verifier.test.ts',
            evidenceReceiptIds: ['receipt-repo'],
            confidence: 0.7,
          },
          { claimId: 'answer:1:answer', kind: 'answer', subject: 'final_answer', value: finalAnswer, evidenceReceiptIds: ['answer:1'], confidence: 1 },
        ],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['repo_evidence'],
      unsatisfiedStepIds: ['step_2', 'step_4'],
    });
    expect(decision.reasons.join(' ')).toContain('confirmed production repo evidence');
  });

  it('rejects implementation-location answers whose confirmed file read misses key request terms', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'search',
      summary: 'Search web, repo, and memory evidence before answering.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web for the title of https://example.com.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search this workspace for where execution graph mutation approval resume events are emitted.', expectedToolCategories: ['fs_search', 'fs_read'], required: true },
        { kind: 'search', summary: 'Search memory for SMOKE-MEM-42801.', expectedToolCategories: ['memory_search'], required: true },
        { kind: 'answer', summary: 'Return three short bullets with what each source found.', required: true, dependsOn: ['step_1', 'step_2', 'step_3'] },
      ],
      entities: {},
    });
    const finalAnswer = [
      '- Web: https://example.com title is "Example Domain".',
      '- Workspace: Execution graph mutation approval resume events are emitted in src/runtime/chat-agent/chat-continuation-graph.ts.',
      '- Memory: Found SMOKE-MEM-42801.',
    ].join('\n');
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
        stepReceipts: [
          { stepId: 'step_1', status: 'satisfied', evidenceReceiptIds: ['receipt-web'], summary: 'Found title.', startedAt: 1, endedAt: 2 },
          { stepId: 'step_2', status: 'satisfied', evidenceReceiptIds: ['receipt-read'], summary: 'Read chat continuation graph resume file.', startedAt: 3, endedAt: 4 },
          { stepId: 'step_3', status: 'satisfied', evidenceReceiptIds: ['receipt-memory'], summary: 'Found memory marker.', startedAt: 5, endedAt: 6 },
          { stepId: 'step_4', status: 'satisfied', evidenceReceiptIds: ['answer:1'], summary: finalAnswer, startedAt: 7, endedAt: 8 },
        ],
        evidenceReceipts: [
          { receiptId: 'receipt-web', sourceType: 'tool_call', toolName: 'web_search', status: 'succeeded', refs: ['https://example.com/'], summary: 'Found title Example Domain.', startedAt: 1, endedAt: 2 },
          {
            receiptId: 'receipt-read',
            sourceType: 'tool_call',
            toolName: 'fs_read',
            status: 'succeeded',
            refs: ['src/runtime/chat-agent/chat-continuation-graph.ts'],
            summary: 'Read src/runtime/chat-agent/chat-continuation-graph.ts containing chat continuation approval resume graph handling.',
            startedAt: 3,
            endedAt: 4,
          },
          { receiptId: 'receipt-memory', sourceType: 'tool_call', toolName: 'memory_search', status: 'succeeded', refs: ['memory:smoke'], summary: 'Found SMOKE-MEM-42801.', startedAt: 5, endedAt: 6 },
        ],
        claims: [
          {
            claimId: 'claim-read-1',
            kind: 'file_reference',
            subject: 'src/runtime/chat-agent/chat-continuation-graph.ts',
            value: 'src/runtime/chat-agent/chat-continuation-graph.ts',
            evidenceReceiptIds: ['receipt-read'],
            confidence: 0.8,
          },
          { claimId: 'answer:1:answer', kind: 'answer', subject: 'final_answer', value: finalAnswer, evidenceReceiptIds: ['answer:1'], confidence: 1 },
        ],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['implementation_file_claim'],
      unsatisfiedStepIds: ['step_2', 'step_4'],
    });
    expect(decision.reasons.join(' ')).toContain('key implementation-location terms');
  });

  it('rejects mixed-domain source-bullet answers that omit a requested source', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'run',
      summary: 'Search web, repo, and memory evidence before answering.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web for the title of https://example.com.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search this workspace for execution graph approval resume events.', expectedToolCategories: ['fs_search'], required: true },
        { kind: 'search', summary: 'Search memory for SMOKE-MEM-42801.', expectedToolCategories: ['memory_search'], required: true },
        { kind: 'answer', summary: 'Return exactly three bullets with one source per bullet.', required: true, dependsOn: ['step_1', 'step_2', 'step_3'] },
      ],
      entities: {},
    });
    const finalAnswer = [
      '- Web: https://example.com title is "Example Domain".',
      '- Memory: SMOKE-MEM-42801 found.',
    ].join('\n');

    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
        stepReceipts: taskContract.plan.steps.map((step, index) => ({
          stepId: step.stepId,
          status: 'satisfied',
          evidenceReceiptIds: [`receipt-${index + 1}`],
          summary: index === 3 ? finalAnswer : `Satisfied ${step.stepId}.`,
          startedAt: index + 1,
          endedAt: index + 2,
        })),
        evidenceReceipts: [
          {
            receiptId: 'receipt-1',
            sourceType: 'tool_call',
            toolName: 'web_search',
            status: 'succeeded',
            refs: ['https://example.com/'],
            summary: 'Found title Example Domain.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            receiptId: 'receipt-2',
            sourceType: 'tool_call',
            toolName: 'fs_search',
            status: 'succeeded',
            refs: ['src/runtime/execution/graph.ts'],
            summary: 'Found approval resume events in the execution graph.',
            startedAt: 3,
            endedAt: 4,
          },
          {
            receiptId: 'receipt-3',
            sourceType: 'tool_call',
            toolName: 'memory_search',
            status: 'succeeded',
            refs: ['memory:smoke'],
            summary: 'Found SMOKE-MEM-42801.',
            startedAt: 5,
            endedAt: 6,
          },
        ],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['step_4'],
    });
    expect(decision.reasons[0]).toContain('one source-labeled bullet');
  });

  it('rejects mixed-domain source-bullet answers that combine requested sources', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'run',
      summary: 'Search web, repo, and memory evidence before answering.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web for the title of https://example.com.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search this workspace for execution graph approval resume events.', expectedToolCategories: ['fs_search'], required: true },
        { kind: 'search', summary: 'Search memory for SMOKE-MEM-42801.', expectedToolCategories: ['memory_search'], required: true },
        { kind: 'answer', summary: 'Return exactly three bullets with one source per bullet.', required: true, dependsOn: ['step_1', 'step_2', 'step_3'] },
      ],
      entities: {},
    });
    const finalAnswer = [
      '- Web / Workspace: Example Domain is the page title, and src/runtime/execution/graph.ts emits approval resume events.',
      '- Memory: SMOKE-MEM-42801 found.',
      '- Summary: All requested sources were checked.',
    ].join('\n');

    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
        stepReceipts: taskContract.plan.steps.map((step, index) => ({
          stepId: step.stepId,
          status: 'satisfied',
          evidenceReceiptIds: [`receipt-${index + 1}`],
          summary: index === 3 ? finalAnswer : `Satisfied ${step.stepId}.`,
          startedAt: index + 1,
          endedAt: index + 2,
        })),
        evidenceReceipts: [
          {
            receiptId: 'receipt-1',
            sourceType: 'tool_call',
            toolName: 'web_search',
            status: 'succeeded',
            refs: ['https://example.com/'],
            summary: 'Found title Example Domain.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            receiptId: 'receipt-2',
            sourceType: 'tool_call',
            toolName: 'fs_search',
            status: 'succeeded',
            refs: ['src/runtime/execution/graph.ts'],
            summary: 'Found approval resume events in the execution graph.',
            startedAt: 3,
            endedAt: 4,
          },
          {
            receiptId: 'receipt-3',
            sourceType: 'tool_call',
            toolName: 'memory_search',
            status: 'succeeded',
            refs: ['memory:smoke'],
            summary: 'Found SMOKE-MEM-42801.',
            startedAt: 5,
            endedAt: 6,
          },
        ],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['step_4'],
    });
    expect(decision.reasons[0]).toContain('combined multiple requested evidence domains');
  });

  it('rejects mixed-domain implementation-location answers that cite only repo search-hit files', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'search',
      summary: 'Search web, repo, and memory evidence before answering.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web for the title of https://example.com.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search this workspace for where execution graph mutation approval resume events are emitted.', expectedToolCategories: ['fs_search'], required: true },
        { kind: 'search', summary: 'Search memory for SMOKE-MEM-42801.', expectedToolCategories: ['memory_search'], required: true },
        { kind: 'answer', summary: 'Return three short bullets with what each source found.', required: true, dependsOn: ['step_1', 'step_2', 'step_3'] },
      ],
      entities: {},
    });
    const finalAnswer = [
      '- Web: https://example.com title is "Example Domain".',
      '- Workspace: Execution graph mutation approval resume events appear in src/runtime/chat-agent/chat-continuation-graph.ts and src/runtime/execution-graph/mutation-node.ts.',
      '- Memory: Found SMOKE-MEM-42801.',
    ].join('\n');
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
        stepReceipts: [
          {
            stepId: 'step_1',
            status: 'satisfied',
            evidenceReceiptIds: ['receipt-web'],
            summary: 'Found title Example Domain.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            stepId: 'step_2',
            status: 'satisfied',
            evidenceReceiptIds: ['receipt-repo'],
            summary: 'Found candidate repo files.',
            startedAt: 3,
            endedAt: 4,
          },
          {
            stepId: 'step_3',
            status: 'satisfied',
            evidenceReceiptIds: ['receipt-memory'],
            summary: 'Found SMOKE-MEM-42801.',
            startedAt: 5,
            endedAt: 6,
          },
          {
            stepId: 'step_4',
            status: 'satisfied',
            evidenceReceiptIds: ['answer:1'],
            summary: finalAnswer,
            startedAt: 7,
            endedAt: 8,
          },
        ],
        evidenceReceipts: [
          {
            receiptId: 'receipt-web',
            sourceType: 'tool_call',
            toolName: 'web_search',
            status: 'succeeded',
            refs: ['https://example.com/'],
            summary: 'Found title Example Domain.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            receiptId: 'receipt-repo',
            sourceType: 'tool_call',
            toolName: 'fs_search',
            status: 'succeeded',
            refs: [
              'src/runtime/chat-agent/chat-continuation-graph.ts',
              'src/runtime/execution-graph/mutation-node.ts',
            ],
            summary: 'Search found candidate files.',
            startedAt: 3,
            endedAt: 4,
          },
          {
            receiptId: 'receipt-memory',
            sourceType: 'tool_call',
            toolName: 'memory_search',
            status: 'succeeded',
            refs: ['memory:smoke'],
            summary: 'Found SMOKE-MEM-42801.',
            startedAt: 5,
            endedAt: 6,
          },
        ],
        claims: [
          {
            claimId: 'claim-search-1',
            kind: 'file_reference',
            subject: 'src/runtime/chat-agent/chat-continuation-graph.ts',
            value: 'src/runtime/chat-agent/chat-continuation-graph.ts',
            evidenceReceiptIds: ['receipt-repo'],
            confidence: 0.8,
          },
          {
            claimId: 'claim-search-2',
            kind: 'file_reference',
            subject: 'src/runtime/execution-graph/mutation-node.ts',
            value: 'src/runtime/execution-graph/mutation-node.ts',
            evidenceReceiptIds: ['receipt-repo'],
            confidence: 0.8,
          },
          {
            claimId: 'answer:1:answer',
            kind: 'answer',
            subject: 'final_answer',
            value: finalAnswer,
            evidenceReceiptIds: ['answer:1'],
            confidence: 1,
          },
        ],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['implementation_file_claim'],
      unsatisfiedStepIds: ['step_2', 'step_4'],
    });
    expect(decision.requiredNextAction).toContain('targeted repo inspection');
  });

  it('accepts mixed-domain status answers with a plain zero-match repo symbol search', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'run',
      summary: 'Multi-provider status check plus repo search for controller function, delivered as six redacted bullets.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'read', summary: 'Check connector status and list automations.', expectedToolCategories: ['cloud_tool_status', 'automation_list'], required: true },
        { kind: 'search', summary: 'Search this workspace for runLiveToolLoopController.', expectedToolCategories: ['fs_search'], required: true },
        { kind: 'answer', summary: 'Return six short bullets with one result per requested source.', required: true, dependsOn: ['step_1', 'step_2'] },
      ],
      entities: {},
    });
    const finalAnswer = [
      '- Vercel: connected and healthy.',
      '- WHM: connected and healthy.',
      '- Gmail: configured and authenticated.',
      '- Microsoft 365: configured and authenticated.',
      '- Saved automations: 38 found.',
      '- runLiveToolLoopController: no matches found in this workspace.',
    ].join('\n');
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
        stepReceipts: [
          { stepId: 'step_1', status: 'satisfied', evidenceReceiptIds: ['receipt-status'], summary: 'Status tools completed.', startedAt: 1, endedAt: 2 },
          { stepId: 'step_2', status: 'satisfied', evidenceReceiptIds: ['receipt-repo'], summary: 'No matches found.', startedAt: 3, endedAt: 4 },
          { stepId: 'step_3', status: 'satisfied', evidenceReceiptIds: ['answer:1'], summary: finalAnswer, startedAt: 5, endedAt: 6 },
        ],
        evidenceReceipts: [
          {
            receiptId: 'receipt-status',
            sourceType: 'tool_call',
            toolName: 'gws_status',
            status: 'succeeded',
            summary: 'Google Workspace configured and authenticated.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            receiptId: 'receipt-repo',
            sourceType: 'tool_call',
            toolName: 'fs_search',
            status: 'succeeded',
            refs: [],
            summary: 'No matches found for runLiveToolLoopController.',
            startedAt: 3,
            endedAt: 4,
          },
        ],
        claims: [{
          claimId: 'answer:1:answer',
          kind: 'answer',
          subject: 'final_answer',
          value: finalAnswer,
          evidenceReceiptIds: ['answer:1'],
          confidence: 1,
        }],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'satisfied',
      retryable: false,
    });
  });

  it('rejects mixed-domain implementation-location answers that cite only repo job-snapshot refs', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'search',
      summary: 'Search web, repo, and memory evidence before answering.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web for the title of https://example.com.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search this workspace for where execution graph mutation approval resume events are emitted.', expectedToolCategories: ['fs_search'], required: true },
        { kind: 'search', summary: 'Search memory for SMOKE-MEM-42801.', expectedToolCategories: ['memory_search'], required: true },
        { kind: 'answer', summary: 'Return three short bullets with what each source found.', required: true, dependsOn: ['step_1', 'step_2', 'step_3'] },
      ],
      entities: {},
    });
    const finalAnswer = [
      '- Web: https://example.com title is "Example Domain".',
      '- Workspace: Execution graph mutation approval resume events are emitted in src/runtime/execution-graph/mutation-node.ts.',
      '- Memory: Found SMOKE-MEM-42801.',
    ].join('\n');
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
        stepReceipts: [
          { stepId: 'step_1', status: 'satisfied', evidenceReceiptIds: ['receipt-web'], summary: 'Found title.', startedAt: 1, endedAt: 2 },
          { stepId: 'step_2', status: 'satisfied', evidenceReceiptIds: ['job-repo'], summary: 'Found candidate repo files.', startedAt: 3, endedAt: 4 },
          { stepId: 'step_3', status: 'satisfied', evidenceReceiptIds: ['receipt-memory'], summary: 'Found memory marker.', startedAt: 5, endedAt: 6 },
          { stepId: 'step_4', status: 'satisfied', evidenceReceiptIds: ['answer:1'], summary: finalAnswer, startedAt: 7, endedAt: 8 },
        ],
        evidenceReceipts: [
          {
            receiptId: 'receipt-web',
            sourceType: 'tool_call',
            toolName: 'web_search',
            status: 'succeeded',
            refs: ['https://example.com/'],
            summary: 'Found title Example Domain.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            receiptId: 'job-repo',
            sourceType: 'tool_call',
            toolName: 'fs_search',
            status: 'succeeded',
            refs: ['src/runtime/execution-graph/mutation-node.ts'],
            summary: 'Search found mutation-node.ts.',
            startedAt: 3,
            endedAt: 4,
          },
          {
            receiptId: 'receipt-memory',
            sourceType: 'tool_call',
            toolName: 'memory_search',
            status: 'succeeded',
            refs: ['memory:smoke'],
            summary: 'Found SMOKE-MEM-42801.',
            startedAt: 5,
            endedAt: 6,
          },
        ],
        claims: [{
          claimId: 'answer:1:answer',
          kind: 'answer',
          subject: 'final_answer',
          value: finalAnswer,
          evidenceReceiptIds: ['answer:1'],
          confidence: 1,
        }],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['implementation_file_claim'],
      unsatisfiedStepIds: ['step_2', 'step_4'],
    });
  });

  it('rejects mixed-domain implementation-location answers that cite unconfirmed paths inferred from support search hits', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'search',
      summary: 'Search web, repo, and memory evidence before answering.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web for the title of https://example.com.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search this workspace for where execution graph mutation approval resume events are emitted.', expectedToolCategories: ['fs_search'], required: true },
        { kind: 'search', summary: 'Search memory for SMOKE-MEM-42801.', expectedToolCategories: ['memory_search'], required: true },
        { kind: 'answer', summary: 'Return three short bullets with what each source found.', required: true, dependsOn: ['step_1', 'step_2', 'step_3'] },
      ],
      entities: {},
    });
    const finalAnswer = [
      '- Web: https://example.com title is "Example Domain".',
      '- Workspace: Execution graph mutation approval resume events are emitted in src/runtime/execution-graph/mutation-node.ts.',
      '- Memory: Found SMOKE-MEM-42801.',
    ].join('\n');
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
        stepReceipts: [
          { stepId: 'step_1', status: 'satisfied', evidenceReceiptIds: ['receipt-web'], summary: 'Found title.', startedAt: 1, endedAt: 2 },
          { stepId: 'step_2', status: 'satisfied', evidenceReceiptIds: ['receipt-repo'], summary: 'Found support-file snippets.', startedAt: 3, endedAt: 4 },
          { stepId: 'step_3', status: 'satisfied', evidenceReceiptIds: ['receipt-memory'], summary: 'Found memory marker.', startedAt: 5, endedAt: 6 },
          { stepId: 'step_4', status: 'satisfied', evidenceReceiptIds: ['answer:1'], summary: finalAnswer, startedAt: 7, endedAt: 8 },
        ],
        evidenceReceipts: [
          {
            receiptId: 'receipt-web',
            sourceType: 'tool_call',
            toolName: 'web_search',
            status: 'succeeded',
            refs: ['https://example.com/'],
            summary: 'Found title Example Domain.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            receiptId: 'receipt-repo',
            sourceType: 'tool_call',
            toolName: 'fs_search',
            status: 'succeeded',
            refs: ['src/runtime/execution/verifier.test.ts'],
            summary: 'Search found test snippets mentioning mutation-node.ts.',
            startedAt: 3,
            endedAt: 4,
          },
          {
            receiptId: 'receipt-memory',
            sourceType: 'tool_call',
            toolName: 'memory_search',
            status: 'succeeded',
            refs: ['memory:smoke'],
            summary: 'Found SMOKE-MEM-42801.',
            startedAt: 5,
            endedAt: 6,
          },
        ],
        claims: [
          {
            claimId: 'claim-support-1',
            kind: 'file_reference',
            subject: 'src/runtime/execution/verifier.test.ts',
            value: 'src/runtime/execution/verifier.test.ts',
            evidenceReceiptIds: ['receipt-repo'],
            confidence: 0.8,
          },
          {
            claimId: 'answer:1:answer',
            kind: 'answer',
            subject: 'final_answer',
            value: finalAnswer,
            evidenceReceiptIds: ['answer:1'],
            confidence: 1,
          },
        ],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['implementation_file_claim'],
      unsatisfiedStepIds: ['step_2', 'step_4'],
    });
    expect(decision.reasons.join(' ')).toContain('not backed by read or code-symbol confirmation');
  });

  it('rejects mixed-domain implementation-location answers that cite support files even when those files were read', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'search',
      summary: 'Search web, repo, and memory evidence before answering.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web for the title of https://example.com.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search this workspace for where execution graph mutation approval resume events are emitted.', expectedToolCategories: ['fs_search', 'fs_read'], required: true },
        { kind: 'search', summary: 'Search memory for SMOKE-MEM-42801.', expectedToolCategories: ['memory_search'], required: true },
        { kind: 'answer', summary: 'Return three short bullets with what each source found.', required: true, dependsOn: ['step_1', 'step_2', 'step_3'] },
      ],
      entities: {},
    });
    const finalAnswer = [
      '- Web: https://example.com title is "Example Domain".',
      '- Workspace: `emitMutationResumeGraphEvent` is defined in `src/runtime/execution-graph/mutation-node.ts` and called in `src/tools/executor.test.ts`.',
      '- Memory: Found SMOKE-MEM-42801.',
    ].join('\n');
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
        stepReceipts: [
          { stepId: 'step_1', status: 'satisfied', evidenceReceiptIds: ['receipt-web'], summary: 'Found title.', startedAt: 1, endedAt: 2 },
          { stepId: 'step_2', status: 'satisfied', evidenceReceiptIds: ['receipt-repo'], summary: 'Read a support-file match.', startedAt: 3, endedAt: 4 },
          { stepId: 'step_3', status: 'satisfied', evidenceReceiptIds: ['receipt-memory'], summary: 'Found memory marker.', startedAt: 5, endedAt: 6 },
          { stepId: 'step_4', status: 'satisfied', evidenceReceiptIds: ['answer:1'], summary: finalAnswer, startedAt: 7, endedAt: 8 },
        ],
        evidenceReceipts: [
          {
            receiptId: 'receipt-web',
            sourceType: 'tool_call',
            toolName: 'web_search',
            status: 'succeeded',
            refs: ['https://example.com/'],
            summary: 'Found title Example Domain.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            receiptId: 'receipt-repo',
            sourceType: 'tool_call',
            toolName: 'fs_read',
            status: 'succeeded',
            refs: ['src/tools/executor.test.ts'],
            summary: 'Read support file mentioning emitMutationResumeGraphEvent.',
            startedAt: 3,
            endedAt: 4,
          },
          {
            receiptId: 'receipt-memory',
            sourceType: 'tool_call',
            toolName: 'memory_search',
            status: 'succeeded',
            refs: ['memory:smoke'],
            summary: 'Found SMOKE-MEM-42801.',
            startedAt: 5,
            endedAt: 6,
          },
        ],
        claims: [{
          claimId: 'answer:1:answer',
          kind: 'answer',
          subject: 'final_answer',
          value: finalAnswer,
          evidenceReceiptIds: ['answer:1'],
          confidence: 1,
        }],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['implementation_file_claim'],
      unsatisfiedStepIds: ['step_2', 'step_4'],
    });
  });

  it('accepts mixed-domain implementation-location answers backed by implementation file reads', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'general_assistant',
      confidence: 'high',
      operation: 'search',
      summary: 'Search web, repo, and memory evidence before answering.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web for the title of https://example.com.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search and read this workspace for where execution graph mutation approval resume events are emitted.', expectedToolCategories: ['fs_search', 'fs_read'], required: true },
        { kind: 'search', summary: 'Search memory for SMOKE-MEM-42801.', expectedToolCategories: ['memory_search'], required: true },
        { kind: 'answer', summary: 'Return three short bullets with what each source found.', required: true, dependsOn: ['step_1', 'step_2', 'step_3'] },
      ],
      entities: {},
    });
    const finalAnswer = [
      '- Web: https://example.com title is "Example Domain".',
      '- Workspace: Execution graph mutation approval resume events are emitted in src/runtime/execution-graph/mutation-node.ts.',
      '- Memory: Found SMOKE-MEM-42801.',
    ].join('\n');
    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        runStatus: 'completed',
        finalUserAnswer: finalAnswer,
        operatorSummary: finalAnswer,
        stepReceipts: [
          {
            stepId: 'step_1',
            status: 'satisfied',
            evidenceReceiptIds: ['receipt-web'],
            summary: 'Found title Example Domain.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            stepId: 'step_2',
            status: 'satisfied',
            evidenceReceiptIds: ['receipt-read'],
            summary: 'Read implementation file.',
            startedAt: 3,
            endedAt: 4,
          },
          {
            stepId: 'step_3',
            status: 'satisfied',
            evidenceReceiptIds: ['receipt-memory'],
            summary: 'Found SMOKE-MEM-42801.',
            startedAt: 5,
            endedAt: 6,
          },
          {
            stepId: 'step_4',
            status: 'satisfied',
            evidenceReceiptIds: ['answer:1'],
            summary: finalAnswer,
            startedAt: 7,
            endedAt: 8,
          },
        ],
        evidenceReceipts: [
          {
            receiptId: 'receipt-web',
            sourceType: 'tool_call',
            toolName: 'web_search',
            status: 'succeeded',
            refs: ['https://example.com/'],
            summary: 'Found title Example Domain.',
            startedAt: 1,
            endedAt: 2,
          },
          {
            receiptId: 'receipt-read',
            sourceType: 'tool_call',
            toolName: 'fs_read',
            status: 'succeeded',
            refs: ['src/runtime/execution-graph/mutation-node.ts'],
            summary: 'Read src/runtime/execution-graph/mutation-node.ts.',
            startedAt: 3,
            endedAt: 4,
          },
          {
            receiptId: 'receipt-memory',
            sourceType: 'tool_call',
            toolName: 'memory_search',
            status: 'succeeded',
            refs: ['memory:smoke'],
            summary: 'Found SMOKE-MEM-42801.',
            startedAt: 5,
            endedAt: 6,
          },
        ],
        claims: [
          {
            claimId: 'claim-impl-1',
            kind: 'implementation_file',
            subject: 'src/runtime/execution-graph/mutation-node.ts',
            value: 'src/runtime/execution-graph/mutation-node.ts',
            evidenceReceiptIds: ['receipt-read'],
            confidence: 0.9,
          },
          {
            claimId: 'answer:1:answer',
            kind: 'answer',
            subject: 'final_answer',
            value: finalAnswer,
            evidenceReceiptIds: ['answer:1'],
            confidence: 1,
          },
        ],
      }),
    });

    expect(decision).toMatchObject({
      decision: 'satisfied',
      retryable: false,
    });
  });

  it('adds a required answer step when repo-grounded gateway plans omit synthesis', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'high',
      operation: 'search',
      summary: 'Search web and repo evidence, then return a comparison.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search the web evidence.', expectedToolCategories: ['web_search'], required: true },
        { kind: 'search', summary: 'Search the repo evidence.', expectedToolCategories: ['fs_search'], required: true },
      ],
      entities: {},
    });

    expect(taskContract.kind).toBe('repo_inspection');
    expect(taskContract.plan.steps.map((step) => step.kind)).toEqual(['search', 'search', 'answer']);
    expect(taskContract.plan.steps[2]).toMatchObject({
      kind: 'answer',
      dependsOn: ['step_1', 'step_2'],
    });

    const evidenceReceipts: EvidenceReceipt[] = [
      {
        receiptId: 'receipt-web',
        sourceType: 'tool_call',
        toolName: 'web_search',
        status: 'succeeded',
        refs: ['https://example.com/'],
        summary: 'Example Domain.',
        startedAt: 1,
        endedAt: 2,
      },
      {
        receiptId: 'receipt-repo',
        sourceType: 'tool_call',
        toolName: 'fs_search',
        status: 'succeeded',
        refs: ['src/tools/builtin/browser-tools.ts'],
        summary: 'Found browser tool implementation candidates.',
        startedAt: 3,
        endedAt: 4,
      },
    ];

    const decision = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        evidenceReceipts,
        operatorSummary: 'I have the web search evidence already. Now let me narrow the repo search.',
      }),
    });

    expect(decision).toMatchObject({
      decision: 'insufficient',
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['step_3'],
    });
  });

  it('keeps simple no-tool security refusals on an answer-first contract', () => {
    const taskContract = buildSimpleSecurityTaskContract();

    expect(taskContract.kind).toBe('general_answer');
    expect(taskContract.requiresEvidence).toBe(false);
    expect(taskContract.allowsAnswerFirst).toBe(true);
    expect(taskContract.requireExactFileReferences).toBe(false);
    expect(taskContract.plan.steps.map((step) => step.kind)).toEqual(['answer']);
  });

  it('verifies normalized automation catalog evidence plus answer synthesis', () => {
    const decision = normalizeIntentGatewayDecision({
      route: 'automation_control',
      confidence: 'high',
      operation: 'read',
      summary: 'Find matching automations and suggest one useful automation.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search existing automations and routines.', required: true },
        {
          kind: 'write',
          summary: 'Suggest one useful automation to create.',
          expectedToolCategories: ['write'],
          required: true,
          dependsOn: ['step_1'],
        },
      ],
      entities: {},
    });
    const taskContract = buildDelegatedTaskContract(decision);

    expect(taskContract.plan.steps).toMatchObject([
      { kind: 'read', expectedToolCategories: ['automation_list'] },
      { kind: 'answer' },
    ]);
    expect(taskContract.plan.steps[1]?.expectedToolCategories).toBeUndefined();

    const evidenceReceipts: EvidenceReceipt[] = [
      {
        receiptId: 'receipt-search-1',
        sourceType: 'tool_call',
        toolName: 'automation_list',
        status: 'succeeded',
        refs: [],
        summary: 'Listed existing automations and routines.',
        startedAt: 1,
        endedAt: 2,
      },
      {
        receiptId: 'answer-1',
        sourceType: 'model_answer',
        status: 'succeeded',
        refs: [],
        summary: 'Suggested one useful automation.',
        startedAt: 3,
        endedAt: 3,
      },
    ];
    const stepReceipts = buildStepReceipts({
      plannedTask: taskContract.plan,
      evidenceReceipts,
      toolReceiptStepIds: new Map([['receipt-search-1', 'step_1']]),
      finalAnswerReceiptId: 'answer-1',
    });
    const verification = verifyDelegatedResult({
      envelope: buildEnvelope({
        taskContract,
        evidenceReceipts,
        stepReceipts,
        finalUserAnswer: 'A useful automation would monitor pending approval continuations and report stale ones.',
        runStatus: 'completed',
      }),
    });

    expect(stepReceipts.map((receipt) => receipt.status)).toEqual(['satisfied', 'satisfied']);
    expect(verification).toMatchObject({
      decision: 'satisfied',
      retryable: false,
    });
  });

  it('normalizes automation list operations before delegated contract construction', () => {
    const decision = normalizeIntentGatewayDecision({
      route: 'automation_control',
      confidence: 'low',
      operation: 'list',
      summary: 'List matching automations and suggest one useful automation.',
      turnRelation: 'follow_up',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: false,
      expectedContextPressure: 'low',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        { kind: 'search', summary: 'Search existing automations and routines.', required: true },
        {
          kind: 'write',
          summary: 'Suggest one useful automation to create.',
          expectedToolCategories: ['write'],
          required: true,
          dependsOn: ['step_1'],
        },
      ],
      entities: {},
    });
    const taskContract = buildDelegatedTaskContract(decision);

    expect(decision.operation).toBe('read');
    expect(taskContract.kind).toBe('general_answer');
    expect(taskContract.plan.steps.map((step) => step.kind)).toEqual(['read', 'answer']);
    expect(taskContract.plan.steps[0]?.expectedToolCategories).toEqual(['automation_list']);
    expect(taskContract.plan.steps[1]?.expectedToolCategories).toBeUndefined();
  });

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

  it('matches gateway filesystem category aliases to concrete filesystem tool receipts', () => {
    const plannedTask = {
      planId: 'plan:coding_task:run:3',
      steps: [
        {
          stepId: 'step_1',
          kind: 'read' as const,
          summary: 'Inspect package.json.',
          expectedToolCategories: ['filesystem_read'],
          required: true,
        },
        {
          stepId: 'step_2',
          kind: 'write' as const,
          summary: 'Write package-summary.txt.',
          expectedToolCategories: ['filesystem_write'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          stepId: 'step_3',
          kind: 'answer' as const,
          summary: 'Confirm the work.',
          required: true,
          dependsOn: ['step_1', 'step_2'],
        },
      ],
      allowAdditionalSteps: false,
    };
    const stepReceipts = buildStepReceipts({
      plannedTask,
      evidenceReceipts: [
        {
          receiptId: 'receipt-read',
          sourceType: 'tool_call',
          toolName: 'fs_read',
          status: 'succeeded',
          refs: ['package.json'],
          summary: 'Read package.json.',
          startedAt: 1,
          endedAt: 2,
        },
        {
          receiptId: 'receipt-write',
          sourceType: 'tool_call',
          toolName: 'fs_write',
          status: 'succeeded',
          refs: ['tmp/package-summary.txt'],
          summary: 'Wrote tmp/package-summary.txt.',
          startedAt: 3,
          endedAt: 4,
        },
        {
          receiptId: 'answer:1',
          sourceType: 'model_answer',
          status: 'succeeded',
          refs: [],
          summary: 'Done.',
          startedAt: 5,
          endedAt: 5,
        },
      ],
      toolReceiptStepIds: new Map([
        ['receipt-read', 'step_1'],
        ['receipt-write', 'step_2'],
      ]),
      finalAnswerReceiptId: 'answer:1',
    });

    expect(stepReceipts.map((receipt) => receipt.status)).toEqual([
      'satisfied',
      'satisfied',
      'satisfied',
    ]);
    expect(computeWorkerRunStatus(plannedTask, stepReceipts, [], 'end_turn')).toBe('completed');
  });

  it('stabilizes mixed read-write gateway plans and distributes matching filesystem receipts', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'low',
      operation: 'inspect',
      summary: 'Inspect package.json and the stress plan, then write package-summary.txt and lane6-evidence.json.',
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
          kind: 'write',
          summary: 'Write tmp/lane6/package-summary.txt.',
          expectedToolCategories: ['filesystem_write'],
          required: true,
        },
        {
          kind: 'read',
          summary: 'Read package.json.',
          expectedToolCategories: ['filesystem_read'],
          required: true,
        },
        {
          kind: 'write',
          summary: 'Write tmp/lane6/lane6-evidence.json.',
          expectedToolCategories: ['filesystem_write'],
          required: true,
        },
        {
          kind: 'read',
          summary: 'Read docs/plans/VERIFICATION-VALIDATION-STRESS-PLAN.md.',
          expectedToolCategories: ['filesystem_read'],
          required: true,
        },
      ],
      entities: {},
    });

    expect(taskContract.plan.steps.map((step) => step.kind)).toEqual([
      'read',
      'read',
      'write',
      'write',
      'answer',
    ]);

    const evidenceReceipts: EvidenceReceipt[] = [
      {
        receiptId: 'receipt-read-package',
        sourceType: 'tool_call',
        toolName: 'fs_read',
        status: 'succeeded',
        refs: ['package.json'],
        summary: 'Read package.json.',
        startedAt: 1,
        endedAt: 2,
      },
      {
        receiptId: 'receipt-read-plan',
        sourceType: 'tool_call',
        toolName: 'fs_read',
        status: 'succeeded',
        refs: ['docs/plans/VERIFICATION-VALIDATION-STRESS-PLAN.md'],
        summary: 'Read docs/plans/VERIFICATION-VALIDATION-STRESS-PLAN.md.',
        startedAt: 3,
        endedAt: 4,
      },
      {
        receiptId: 'receipt-write-summary',
        sourceType: 'tool_call',
        toolName: 'fs_write',
        status: 'succeeded',
        refs: ['tmp/lane6/package-summary.txt'],
        summary: 'Wrote tmp/lane6/package-summary.txt.',
        startedAt: 5,
        endedAt: 6,
      },
      {
        receiptId: 'receipt-write-evidence',
        sourceType: 'tool_call',
        toolName: 'fs_write',
        status: 'succeeded',
        refs: ['tmp/lane6/lane6-evidence.json'],
        summary: 'Wrote tmp/lane6/lane6-evidence.json.',
        startedAt: 7,
        endedAt: 8,
      },
      {
        receiptId: 'answer:1',
        sourceType: 'model_answer',
        status: 'succeeded',
        refs: [],
        summary: 'Both files verified on disk. All planned steps are complete.',
        startedAt: 9,
        endedAt: 9,
      },
    ];
    const toolReceiptStepIds = new Map<string, string>();
    const previouslyMatchedStepIds = new Set<string>();
    for (const receipt of evidenceReceipts.filter((entry) => entry.sourceType === 'tool_call')) {
      const stepId = matchPlannedStepForTool({
        plannedTask: taskContract.plan,
        toolName: receipt.toolName ?? 'tool_call',
        args: { refs: receipt.refs },
        previouslyMatchedStepIds,
      });
      expect(stepId).toBeDefined();
      toolReceiptStepIds.set(receipt.receiptId, stepId as string);
      previouslyMatchedStepIds.add(stepId as string);
    }

    expect([...toolReceiptStepIds.entries()]).toEqual([
      ['receipt-read-package', 'step_1'],
      ['receipt-read-plan', 'step_2'],
      ['receipt-write-summary', 'step_3'],
      ['receipt-write-evidence', 'step_4'],
    ]);

    const stepReceipts = buildStepReceipts({
      plannedTask: taskContract.plan,
      evidenceReceipts,
      toolReceiptStepIds,
      finalAnswerReceiptId: 'answer:1',
    });

    expect(stepReceipts.map((receipt) => receipt.status)).toEqual([
      'satisfied',
      'satisfied',
      'satisfied',
      'satisfied',
      'satisfied',
    ]);
    expect(computeWorkerRunStatus(taskContract.plan, stepReceipts, [], 'end_turn')).toBe('completed');
  });

  it('does not let post-mutation verification reads block approved filesystem writes', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'low',
      operation: 'inspect',
      summary: 'Inspect package.json and the stress plan, then write two evidence files.',
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
        { kind: 'read', summary: 'Real Lane 6 final verification.', expectedToolCategories: ['read'], required: true },
        {
          kind: 'read',
          summary: 'Use the existing directory tmp/lane6.',
          expectedToolCategories: ['read'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'read',
          summary: 'Inspect package.json and docs/plans/VERIFICATION-VALIDATION-STRESS-PLAN.md.',
          expectedToolCategories: ['read'],
          required: true,
          dependsOn: ['step_2'],
        },
        {
          kind: 'write',
          summary: 'Write package-summary.txt and lane6-evidence.json.',
          expectedToolCategories: ['write'],
          required: true,
          dependsOn: ['step_3'],
        },
        {
          kind: 'read',
          summary: 'Use real tools and confirm both files exist when done.',
          expectedToolCategories: ['read'],
          required: true,
          dependsOn: ['step_4'],
        },
      ],
      entities: {},
    });

    expect(taskContract.plan.steps[4]).toMatchObject({
      kind: 'read',
      required: false,
    });
    expect(taskContract.plan.steps[5]?.dependsOn).not.toContain('step_5');

    const evidenceReceipts: EvidenceReceipt[] = [
      {
        receiptId: 'receipt-list',
        sourceType: 'tool_call',
        toolName: 'fs_list',
        status: 'succeeded',
        refs: ['tmp/lane6'],
        summary: 'Listed tmp/lane6.',
        startedAt: 1,
        endedAt: 1,
      },
      {
        receiptId: 'receipt-read-package',
        sourceType: 'tool_call',
        toolName: 'fs_read',
        status: 'succeeded',
        refs: ['package.json'],
        summary: 'Read package.json.',
        startedAt: 2,
        endedAt: 2,
      },
      {
        receiptId: 'receipt-read-plan',
        sourceType: 'tool_call',
        toolName: 'fs_read',
        status: 'succeeded',
        refs: ['docs/plans/VERIFICATION-VALIDATION-STRESS-PLAN.md'],
        summary: 'Read docs/plans/VERIFICATION-VALIDATION-STRESS-PLAN.md.',
        startedAt: 3,
        endedAt: 3,
      },
      {
        receiptId: 'receipt-write-summary',
        sourceType: 'tool_call',
        toolName: 'fs_write',
        status: 'succeeded',
        refs: ['tmp/lane6/package-summary.txt'],
        summary: 'Wrote tmp/lane6/package-summary.txt.',
        startedAt: 4,
        endedAt: 4,
      },
      {
        receiptId: 'receipt-write-evidence',
        sourceType: 'tool_call',
        toolName: 'fs_write',
        status: 'succeeded',
        refs: ['tmp/lane6/lane6-evidence.json'],
        summary: 'Wrote tmp/lane6/lane6-evidence.json.',
        startedAt: 5,
        endedAt: 5,
      },
      {
        receiptId: 'answer:1',
        sourceType: 'model_answer',
        status: 'succeeded',
        refs: [],
        summary: 'Both files confirmed present.',
        startedAt: 6,
        endedAt: 6,
      },
    ];
    const stepReceipts = buildStepReceipts({
      plannedTask: taskContract.plan,
      evidenceReceipts,
      toolReceiptStepIds: new Map([
        ['receipt-list', 'step_2'],
        ['receipt-read-package', 'step_1'],
        ['receipt-read-plan', 'step_3'],
        ['receipt-write-summary', 'step_4'],
        ['receipt-write-evidence', 'step_4'],
      ]),
      finalAnswerReceiptId: 'answer:1',
    });

    expect(stepReceipts.map((receipt) => receipt.status)).toEqual([
      'satisfied',
      'satisfied',
      'satisfied',
      'satisfied',
      'skipped',
      'satisfied',
    ]);
    expect(computeWorkerRunStatus(taskContract.plan, stepReceipts, [], 'end_turn')).toBe('completed');
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

  it('accepts OpenRouter dated snapshot ids when they match the selected alias model', () => {
    const taskContract = buildRepoInspectionTaskContract();
    const decision = verifyDelegatedResult({
      executionProfile: {
        id: 'managed_cloud_tool',
        providerName: 'openrouter-coding',
        providerType: 'openrouter',
        providerModel: 'qwen/qwen3.6-plus',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'tool_loop',
        expectedContextPressure: 'medium',
        contextBudget: 32_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 1,
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
          resolvedProviderName: 'openrouter',
          resolvedProviderType: 'openrouter',
          resolvedProviderProfileName: 'openrouter-coding',
          resolvedProviderModel: 'qwen/qwen3.6-plus-04-02',
        },
      }),
    });

    expect(decision.decision).toBe('satisfied');
  });

  it('accepts OpenRouter compact dated snapshot ids when they match the selected alias model', () => {
    const taskContract = buildRepoInspectionTaskContract();
    const decision = verifyDelegatedResult({
      executionProfile: {
        id: 'managed_cloud_tool',
        providerName: 'openrouter-direct',
        providerType: 'openrouter',
        providerModel: 'moonshotai/kimi-k2.6',
        providerLocality: 'external',
        providerTier: 'managed_cloud',
        requestedTier: 'external',
        preferredAnswerPath: 'tool_loop',
        expectedContextPressure: 'medium',
        contextBudget: 32_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 1,
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
          resolvedProviderName: 'openrouter',
          resolvedProviderType: 'openrouter',
          resolvedProviderProfileName: 'openrouter-direct',
          resolvedProviderModel: 'moonshotai/kimi-k2.6-20260420',
        },
      }),
    });

    expect(decision.decision).toBe('satisfied');
  });

  it('accepts delegated model provenance from an explicitly configured fallback provider', () => {
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
        preferredAnswerPath: 'tool_loop',
        expectedContextPressure: 'medium',
        contextBudget: 36_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['openai', 'nvidia'],
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
          resolvedProviderName: 'nvidia',
          resolvedProviderType: 'nvidia',
          resolvedProviderModel: 'moonshotai/kimi-k2-instruct-0905',
          resolvedProviderTier: 'managed_cloud',
          resolvedProviderLocality: 'external',
          resolvedViaFallback: true,
        },
      }),
    });

    expect(decision.decision).toBe('satisfied');
  });

  it('still rejects delegated provider drift when the reported fallback was not selected', () => {
    const decision = verifyDelegatedResult({
      executionProfile: {
        id: 'frontier_deep',
        providerName: 'openai',
        providerType: 'openai',
        providerModel: 'gpt-4o',
        providerLocality: 'external',
        providerTier: 'frontier',
        requestedTier: 'external',
        preferredAnswerPath: 'tool_loop',
        expectedContextPressure: 'medium',
        contextBudget: 36_000,
        toolContextMode: 'tight',
        maxAdditionalSections: 2,
        maxRuntimeNotices: 2,
        fallbackProviderOrder: ['openai', 'anthropic'],
        reason: 'test profile',
      },
      envelope: buildEnvelope({
        modelProvenance: {
          resolvedProviderName: 'nvidia',
          resolvedProviderType: 'nvidia',
          resolvedProviderModel: 'moonshotai/kimi-k2-instruct-0905',
          resolvedViaFallback: true,
        },
      }),
    });

    expect(decision).toMatchObject({
      decision: 'contradicted',
      retryable: false,
      missingEvidenceKinds: ['provider_selection'],
    });
    expect(decision.reasons[0]).toContain("provider profile 'nvidia'");
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

    it('treats structured remote sandbox execution as tool execution even when the operation drifts to read', () => {
      const taskContract = buildDelegatedTaskContract({
        route: 'coding_task',
        confidence: 'low',
        operation: 'read',
        summary: 'Run pwd in the remote sandbox and return exact stdout.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'repo_grounded',
        preferredTier: 'external',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'tool_loop',
        plannedSteps: [
          {
            kind: 'read',
            summary: 'Inspect the relevant repo files and collect grounded repo evidence.',
            expectedToolCategories: ['search', 'read'],
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Answer with grounded findings from the inspected repo files.',
            required: true,
            dependsOn: ['step_1'],
          },
        ],
        entities: {
          codingRemoteExecRequested: true,
          command: 'pwd',
          profileId: 'Vercel Production',
        },
      });

      expect(taskContract.kind).toBe('tool_execution');
      expect(taskContract.plan.steps[0]).toMatchObject({
        kind: 'tool_call',
        expectedToolCategories: ['code_remote_exec'],
      });
    });
  });
});
