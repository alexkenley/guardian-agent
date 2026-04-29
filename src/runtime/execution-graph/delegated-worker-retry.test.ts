import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../../config/types.js';
import type { SelectedExecutionProfile } from '../execution-profiles.js';
import type {
  DelegatedResultEnvelope,
  DelegatedTaskContract,
  PlannedStep,
} from '../execution/types.js';
import type { IntentGatewayDecision, IntentGatewayRecord } from '../intent-gateway.js';
import {
  appendDelegatedRetrySection,
  buildDelegatedGroundedAnswerEnvelope,
  buildDelegatedGroundedAnswerSynthesisMessages,
  buildDelegatedRetryAttemptPlan,
  buildDelegatedRetryableFailure,
  buildDelegatedRetryDetail,
  buildDelegatedRetryIntentGatewayRecord,
  extractDelegatedEvidenceRefs,
  formatDelegatedStepIds,
  isDelegatedAnswerSynthesisRetry,
  isSameDelegatedExecutionProfile,
  isDelegatedToolEvidenceRetry,
  runDelegatedGroundedAnswerSynthesisRetry,
  selectDelegatedRetryExecutionProfile,
  shouldAdoptDelegatedTaskContract,
  shouldRetryDelegatedCorrectivePassOnSameProfile,
  shouldRetryDelegatedAnswerSynthesisOnSameProfile,
  shouldUseSameProfileDelegatedRetry,
} from './delegated-worker-retry.js';

describe('delegated worker retry graph policy', () => {
  it('builds answer-synthesis retry failures from typed verification state', () => {
    const envelope = delegatedEnvelope({
      taskContract: taskContract({
        steps: [
          { stepId: 'read', kind: 'read', summary: 'Read implementation files.' },
          { stepId: 'answer', kind: 'answer', summary: 'Answer from the gathered evidence.' },
        ],
      }),
      stepReceipts: [{
        stepId: 'read',
        status: 'satisfied',
        evidenceReceiptIds: ['receipt-read'],
        summary: 'Read implementation files.',
        startedAt: 1,
        endedAt: 2,
      }],
      evidenceReceipts: [{
        receiptId: 'receipt-read',
        sourceType: 'tool_call',
        toolName: 'fs_read',
        status: 'succeeded',
        refs: ['src\\runtime\\execution-graph\\graph-controller.ts'],
        summary: 'Read graph controller.',
        startedAt: 1,
        endedAt: 2,
      }],
    });
    const failure = buildDelegatedRetryableFailure({
      decision: 'insufficient',
      reasons: ['The worker gathered evidence but did not answer.'],
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['answer'],
    }, envelope);

    expect(failure).toMatchObject({
      retryReason: 'required steps remain unsatisfied (answer)',
      unsatisfiedSteps: [{
        stepId: 'answer',
        kind: 'answer',
        summary: 'Answer from the gathered evidence.',
        status: 'missing',
      }],
      satisfiedSteps: [{
        stepId: 'read',
        refs: ['src/runtime/execution-graph/graph-controller.ts'],
      }],
    });
    expect(isDelegatedAnswerSynthesisRetry(failure!)).toBe(true);
    expect(shouldRetryDelegatedAnswerSynthesisOnSameProfile(failure!, executionProfile())).toBe(true);

    const retrySections = appendDelegatedRetrySection([], failure!, { sameProfile: true });
    expect(retrySections).toHaveLength(1);
    expect(retrySections[0]?.section).toBe('Delegated Retry Directive');
    expect(retrySections[0]?.content).toContain('answer-synthesis retry');
    expect(retrySections[0]?.content).toContain('src/runtime/execution-graph/graph-controller.ts');
    expect(buildDelegatedRetryDetail(
      'Workspace Explorer',
      executionProfile(),
      failure!,
      'code-session-1',
    )).toContain('Retrying Workspace Explorer with openrouter / moonshotai/kimi-k2.6 in code session code-session-1 because required steps remain unsatisfied (answer)');
  });

  it('builds retry attempt plans from verification policy without supervisor state', () => {
    const profile = executionProfile();
    const equivalentProfile = {
      ...profile,
      id: 'managed_cloud_tool_alias',
    };
    const envelope = delegatedEnvelope({
      taskContract: taskContract({
        summary: 'Inspect graph retry behavior.',
        steps: [
          { stepId: 'read', kind: 'read', summary: 'Read retry policy.' },
          { stepId: 'answer', kind: 'answer', summary: 'Answer from retry evidence.' },
        ],
      }),
      stepReceipts: [{
        stepId: 'read',
        status: 'satisfied',
        evidenceReceiptIds: ['receipt-read'],
        summary: 'Read retry policy.',
        startedAt: 1,
        endedAt: 2,
      }],
      evidenceReceipts: [{
        receiptId: 'receipt-read',
        sourceType: 'tool_call',
        toolName: 'fs_read',
        status: 'succeeded',
        refs: ['src/runtime/execution-graph/delegated-worker-retry.ts'],
        summary: 'Read retry policy.',
        startedAt: 1,
        endedAt: 2,
      }],
    });
    const failure = buildDelegatedRetryableFailure({
      decision: 'insufficient',
      reasons: ['Evidence exists but the final answer is missing.'],
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['answer'],
    }, envelope);
    const baseRecord: IntentGatewayRecord = {
      mode: 'confirmation',
      available: true,
      model: 'gateway-model',
      latencyMs: 12,
      decision: gatewayDecision(),
    };

    expect(shouldUseSameProfileDelegatedRetry(failure!, profile)).toBe(true);
    expect(isSameDelegatedExecutionProfile(equivalentProfile, profile)).toBe(true);

    const plan = buildDelegatedRetryAttemptPlan({
      targetLabel: 'Workspace Explorer',
      currentProfile: profile,
      retryProfile: equivalentProfile,
      insufficiency: failure!,
      codeSessionId: 'code-session-1',
      baseSections: [{ section: 'Base', mode: 'plain', content: 'Existing section.' }],
      baseRecord,
      baseDecision: undefined,
      taskContract: envelope.taskContract,
    });

    expect(plan.usesSameProfile).toBe(true);
    expect(plan.detail).toContain('Retrying Workspace Explorer with openrouter / moonshotai/kimi-k2.6 in code session code-session-1');
    expect(plan.additionalSections).toHaveLength(2);
    expect(plan.additionalSections[1]?.content).toContain('Retry this once now on the same execution profile');
    expect(plan.intentGatewayRecord?.decision).toMatchObject({
      route: 'coding_task',
      operation: 'inspect',
      summary: 'Inspect graph retry behavior.',
      plannedSteps: [
        { kind: 'read', summary: 'Read retry policy.' },
        { kind: 'answer', summary: 'Answer from retry evidence.' },
      ],
    });
  });

  it('selects retry profiles through graph policy without Runtime access', () => {
    const envelope = delegatedEnvelope({
      taskContract: taskContract({
        steps: [
          {
            stepId: 'evidence',
            kind: 'tool_call',
            summary: 'Collect delegated tool evidence.',
            expectedToolCategories: ['runtime_evidence'],
          },
          { stepId: 'answer', kind: 'answer', summary: 'Answer from delegated evidence.' },
        ],
      }),
    });
    const failure = buildDelegatedRetryableFailure({
      decision: 'insufficient',
      reasons: ['Delegated worker stopped before satisfying the evidence step.'],
      retryable: true,
      missingEvidenceKinds: ['tool_call'],
      unsatisfiedStepIds: ['evidence', 'answer'],
      requiredNextAction: 'Complete the evidence step and answer.',
    }, envelope);
    const currentProfile = managedCloudCodingProfile();

    const selected = selectDelegatedRetryExecutionProfile({
      config: retryProfileConfig(),
      orchestration: {
        role: 'explorer',
        label: 'Workspace Explorer',
        lenses: ['coding-workspace'],
      },
      intentDecision: gatewayDecision(),
      currentProfile,
      insufficiency: failure,
    });

    expect(selected).toMatchObject({
      providerName: 'ollama-cloud-tools',
      providerTier: 'managed_cloud',
      selectionSource: 'delegated_role',
    });
    expect(selectDelegatedRetryExecutionProfile({
      config: null,
      currentProfile,
      insufficiency: failure,
    })).toBe(currentProfile);
  });

  it('keeps answer-only delegated retries on the managed-cloud profile when the plan omitted an answer step', () => {
    const envelope = delegatedEnvelope({
      taskContract: taskContract({
        steps: [
          { stepId: 'search_web', kind: 'search', summary: 'Search the web.' },
          { stepId: 'search_repo', kind: 'search', summary: 'Search the repo.' },
        ],
      }),
      stepReceipts: [
        {
          stepId: 'search_web',
          status: 'satisfied',
          evidenceReceiptIds: ['web'],
          summary: 'Searched the web.',
          startedAt: 1,
          endedAt: 2,
        },
        {
          stepId: 'search_repo',
          status: 'satisfied',
          evidenceReceiptIds: ['repo'],
          summary: 'Searched the repo.',
          startedAt: 3,
          endedAt: 4,
        },
      ],
      evidenceReceipts: [
        {
          receiptId: 'web',
          sourceType: 'tool_call',
          toolName: 'browser_read',
          status: 'succeeded',
          refs: ['https://example.com'],
          summary: 'Read example.com.',
          startedAt: 1,
          endedAt: 2,
        },
        {
          receiptId: 'repo',
          sourceType: 'tool_call',
          toolName: 'fs_search',
          status: 'succeeded',
          refs: ['src/tools/builtin/browser-tools.ts'],
          summary: 'Found browser tool implementation.',
          startedAt: 3,
          endedAt: 4,
        },
      ],
    });
    const failure = buildDelegatedRetryableFailure({
      decision: 'insufficient',
      reasons: ['Delegated worker returned an in-progress status message instead of a terminal user-facing answer.'],
      retryable: true,
      missingEvidenceKinds: ['answer'],
      requiredNextAction: 'Complete the delegated task and return the final answer, not a progress promise.',
    }, envelope);

    expect(failure?.unsatisfiedSteps).toEqual([]);
    expect(isDelegatedAnswerSynthesisRetry(failure!)).toBe(true);
    expect(shouldRetryDelegatedAnswerSynthesisOnSameProfile(failure!, executionProfile())).toBe(true);
    expect(shouldUseSameProfileDelegatedRetry(failure!, executionProfile())).toBe(true);
  });

  it('owns grounded answer synthesis prompts and envelope repair outside WorkerManager', () => {
    const envelope = delegatedEnvelope({
      taskContract: taskContract({
        steps: [
          { stepId: 'read', kind: 'read', summary: 'Read implementation files.' },
          { stepId: 'answer', kind: 'answer', summary: 'Answer from evidence.' },
        ],
      }),
      stepReceipts: [{
        stepId: 'read',
        status: 'satisfied',
        evidenceReceiptIds: ['receipt-read'],
        summary: 'Read implementation files.',
        startedAt: 1,
        endedAt: 2,
      }],
      evidenceReceipts: [{
        receiptId: 'receipt-read',
        sourceType: 'tool_call',
        toolName: 'fs_read',
        status: 'succeeded',
        refs: ['S:\\Development\\GuardianAgent\\src\\runtime\\execution-graph\\node-recovery.ts'],
        summary: 'Read node recovery.',
        startedAt: 1,
        endedAt: 2,
      }],
    });
    const failure = buildDelegatedRetryableFailure({
      decision: 'insufficient',
      reasons: ['Evidence was collected but the final answer was missing.'],
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['answer'],
    }, envelope);

    const messages = buildDelegatedGroundedAnswerSynthesisMessages({
      originalRequest: 'Where is recovery defined?',
      history: [{ role: 'user', content: 'Please inspect the repo.' }],
      intentDecision: gatewayDecision(),
      envelope,
      verification: failure!.decision,
      insufficiency: failure!,
      jobSnapshots: [{
        id: 'job-1',
        toolName: 'fs_read',
        status: 'succeeded',
        argsPreview: '{"path":"src/runtime/execution-graph/node-recovery.ts"}',
        resultPreview: 'export function runRecoveryAdvisorGraph',
      }],
    });

    expect(messages[0]?.content).toContain('No tools are available');
    expect(messages[0]?.content).toContain('do not mention tests, docs, fixtures, examples, or verifier expectations');
    expect(messages[1]?.content).toContain('Where is recovery defined?');
    expect(messages[1]?.content).toContain('src/runtime/execution-graph/node-recovery.ts');
    expect(messages[1]?.content).toContain('Delegated job snapshots');

    const repaired = buildDelegatedGroundedAnswerEnvelope({
      sourceEnvelope: envelope,
      finalAnswer: 'Defined in src/runtime/execution-graph/node-recovery.ts.',
      taskRunId: 'task-1',
      timestamp: 10,
    });

    expect(repaired.runStatus).toBe('completed');
    expect(repaired.finalUserAnswer).toBe('Defined in src/runtime/execution-graph/node-recovery.ts.');
    expect(repaired.evidenceReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        receiptId: 'answer:task-1:grounded-synthesis',
        sourceType: 'model_answer',
        refs: ['src/runtime/execution-graph/node-recovery.ts'],
      }),
    ]));
    expect(repaired.claims).toEqual([expect.objectContaining({
      kind: 'answer',
      evidenceReceiptIds: ['answer:task-1:grounded-synthesis'],
    })]);
    expect(repaired.events).toEqual([expect.objectContaining({
      eventId: 'answer-synthesis:task-1',
      type: 'claim_emitted',
    })]);
  });

  it('runs grounded answer synthesis retry through broker-safe callbacks', async () => {
    const envelope = delegatedEnvelope({
      taskContract: taskContract({
        steps: [
          { stepId: 'read', kind: 'read', summary: 'Read implementation files.' },
          { stepId: 'answer', kind: 'answer', summary: 'Answer from evidence.' },
        ],
      }),
      stepReceipts: [{
        stepId: 'read',
        status: 'satisfied',
        evidenceReceiptIds: ['receipt-read'],
        summary: 'Read implementation files.',
        startedAt: 1,
        endedAt: 2,
      }],
      evidenceReceipts: [{
        receiptId: 'receipt-read',
        sourceType: 'tool_call',
        toolName: 'fs_read',
        status: 'succeeded',
        refs: ['src/runtime/execution-graph/delegated-worker-retry.ts'],
        summary: 'Read delegated retry policy.',
        startedAt: 1,
        endedAt: 2,
      }],
    });
    const failure = buildDelegatedRetryableFailure({
      decision: 'insufficient',
      reasons: ['Evidence was collected but the final answer was missing.'],
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['answer'],
    }, envelope);
    const dispatches: Array<{ messages: unknown[]; maxTokens: number; temperature: number }> = [];
    const traces: Array<{ stage: string; details: Record<string, unknown> }> = [];
    const progress: Array<Record<string, unknown>> = [];

    const result = await runDelegatedGroundedAnswerSynthesisRetry({
      originalRequest: 'Where is retry policy implemented?',
      history: [{ role: 'user', content: 'Please inspect the repo.' }],
      intentDecision: gatewayDecision(),
      taskContract: envelope.taskContract,
      verifiedResult: {
        envelope,
        decision: failure!.decision,
      },
      insufficiency: failure!,
      jobSnapshots: [{
        id: 'job-1',
        toolName: 'fs_read',
        status: 'succeeded',
        resultPreview: 'Read delegated-worker-retry.ts',
      }],
      requestId: 'request-1',
      taskRunId: 'task-1',
      workerId: 'worker-1',
      executionProfile: executionProfile(),
      now: () => 123,
      dispatchSynthesis: async (request) => {
        dispatches.push(request);
        return {
          content: 'Retry policy is implemented in src/runtime/execution-graph/delegated-worker-retry.ts.',
          metadata: {
            providerMetadata: true,
          },
        };
      },
      verifyResult: (request) => {
        expect(request.metadata.delegatedGroundedAnswerSynthesis).toMatchObject({
          available: true,
          reason: 'answer_only_retry',
          satisfiedStepCount: 1,
          unsatisfiedStepIds: ['answer'],
        });
        const repaired = request.metadata.delegatedResult as DelegatedResultEnvelope;
        expect(repaired.finalUserAnswer).toBe('Retry policy is implemented in src/runtime/execution-graph/delegated-worker-retry.ts.');
        return {
          envelope: repaired,
          decision: {
            decision: 'satisfied',
            reasons: [],
            retryable: false,
          },
        };
      },
      trace: (event) => traces.push(event),
      progress: (event) => progress.push(event),
    });

    expect(result?.result).toMatchObject({
      content: 'Retry policy is implemented in src/runtime/execution-graph/delegated-worker-retry.ts.',
      metadata: {
        providerMetadata: true,
      },
    });
    expect(result?.verifiedResult.decision.decision).toBe('satisfied');
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.maxTokens).toBe(2_500);
    expect(dispatches[0]?.temperature).toBe(0);
    expect(JSON.stringify(dispatches[0]?.messages)).toContain('No tools are available');
    expect(traces).toEqual([expect.objectContaining({
      stage: 'delegated_worker_retrying',
      details: expect.objectContaining({
        requestId: 'request-1',
        taskRunId: 'task-1',
        workerId: 'worker-1',
      }),
    })]);
    expect(progress).toEqual([expect.objectContaining({
      id: 'delegated-worker:task-1:grounded-answer-synthesis',
      kind: 'running',
      workerId: 'worker-1',
    })]);
  });

  it('extracts bounded delegated evidence refs for retry and synthesis ownership', () => {
    expect(extractDelegatedEvidenceRefs(
      'Read S:\\Development\\GuardianAgent\\src\\supervisor\\worker-manager.ts and docs\\plans\\DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md',
      '{"path":"web/public/js/chat-panel.js"}',
    )).toEqual([
      'src/supervisor/worker-manager.ts',
      'docs/plans/DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md',
      'web/public/js/chat-panel.js',
    ]);
  });

  it('extracts refs from structured delegated job search previews', () => {
    expect(extractDelegatedEvidenceRefs(JSON.stringify({
      matches: [
        {
          relativePath: 'src/runtime/execution-graph/mutation-node.ts',
          line: 214,
          preview: 'export function emitMutationResumeGraphEvent',
        },
        {
          filePath: 'S:\\Development\\GuardianAgent\\docs\\plans\\DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md',
          line: 52,
        },
      ],
      metadata: {
        files: ['web/public/js/chat-panel.js'],
      },
      content: 'plain content without a path should not become a ref',
    }))).toEqual([
      'src/runtime/execution-graph/mutation-node.ts',
      'docs/plans/DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md',
      'web/public/js/chat-panel.js',
    ]);
  });

  it('does not convert URL schemes into drive-letter refs', () => {
    expect(extractDelegatedEvidenceRefs(JSON.stringify({
      results: [
        { title: 'Example Domain', url: 'https://example.com/' },
        { title: 'Docs', url: 'http://example.test/docs' },
      ],
      path: 'src/runtime/execution-graph/mutation-node.ts',
    }))).toEqual(['src/runtime/execution-graph/mutation-node.ts']);
  });

  it('uses a same-profile corrective pass for managed-cloud answer-only failures before stronger escalation', () => {
    const envelope = delegatedEnvelope({
      taskContract: taskContract({
        steps: [
          { stepId: 'answer', kind: 'answer', summary: 'Return the final answer.' },
        ],
      }),
    });
    const failure = buildDelegatedRetryableFailure({
      decision: 'insufficient',
      reasons: ['Delegated worker returned an in-progress status message instead of a terminal user-facing answer.'],
      retryable: true,
      missingEvidenceKinds: ['answer'],
      unsatisfiedStepIds: ['answer'],
      requiredNextAction: 'Complete the delegated task and return the final answer, not a progress promise.',
    }, envelope);

    expect(isDelegatedAnswerSynthesisRetry(failure!)).toBe(false);
    expect(shouldRetryDelegatedCorrectivePassOnSameProfile(failure!, executionProfile())).toBe(true);
    expect(shouldRetryDelegatedCorrectivePassOnSameProfile(failure!, {
      ...executionProfile(),
      providerTier: 'frontier',
    })).toBe(false);
  });

  it('uses a same-profile corrective pass for managed-cloud missing tool-evidence failures', () => {
    const envelope = delegatedEnvelope({
      taskContract: taskContract({
        steps: [
          {
            stepId: 'evidence',
            kind: 'tool_call',
            summary: 'Collect read-only runtime evidence.',
            expectedToolCategories: ['runtime_evidence'],
          },
          {
            stepId: 'answer',
            kind: 'answer',
            summary: 'Answer from evidence.',
          },
        ],
      }),
    });
    const failure = buildDelegatedRetryableFailure({
      decision: 'insufficient',
      reasons: ['Delegated worker stopped before satisfying every required planned step.'],
      retryable: true,
      missingEvidenceKinds: ['tool_call'],
      unsatisfiedStepIds: ['evidence', 'answer'],
      requiredNextAction: 'Complete the evidence step and answer.',
    }, envelope);

    expect(shouldRetryDelegatedCorrectivePassOnSameProfile(failure!, executionProfile())).toBe(true);
    expect(isDelegatedToolEvidenceRetry(failure!)).toBe(true);
    expect(shouldUseSameProfileDelegatedRetry(failure!, executionProfile())).toBe(false);
    expect(shouldRetryDelegatedCorrectivePassOnSameProfile(failure!, {
      ...executionProfile(),
      providerTier: 'frontier',
    })).toBe(false);
  });

  it('owns retry gateway repair and task-contract adoption outside WorkerManager', () => {
    const current = taskContract({
      planId: 'plan-current',
      steps: [
        { stepId: 'read', kind: 'read', summary: 'Read files.' },
      ],
    });
    const candidate = taskContract({
      planId: 'plan-candidate',
      summary: 'Inspect and answer.',
      steps: [
        { stepId: 'read', kind: 'read', summary: 'Read files.' },
        { stepId: 'answer', kind: 'answer', summary: 'Answer with exact paths.' },
      ],
    });
    const baseRecord: IntentGatewayRecord = {
      mode: 'confirmation',
      available: true,
      model: 'gateway-model',
      latencyMs: 12,
      decision: gatewayDecision(),
    };

    expect(shouldAdoptDelegatedTaskContract(current, candidate)).toBe(true);
    const retryRecord = buildDelegatedRetryIntentGatewayRecord({
      baseRecord,
      baseDecision: undefined,
      taskContract: candidate,
    });

    expect(retryRecord?.decision).toMatchObject({
      route: 'coding_task',
      operation: 'inspect',
      summary: 'Inspect and answer.',
      requireExactFileReferences: true,
      plannedSteps: [
        { kind: 'read', summary: 'Read files.' },
        { kind: 'answer', summary: 'Answer with exact paths.' },
      ],
    });
  });

  it('preserves exact-file and generic grounding retry guidance', () => {
    const exactFailure = buildDelegatedRetryableFailure({
      decision: 'insufficient',
      reasons: ['Missing exact files.'],
      retryable: true,
      missingEvidenceKinds: ['file_reference_claim'],
      unsatisfiedStepIds: ['read'],
    }, delegatedEnvelope({
      taskContract: taskContract({
        requireExactFileReferences: true,
        steps: [
          { stepId: 'read', kind: 'read', summary: 'Read implementation files.' },
        ],
      }),
    }));
    expect(exactFailure?.failureSummary).toBe('Delegated worker did not return the exact file references requested after repo inspection.');

    const genericFailure = buildDelegatedRetryableFailure({
      decision: 'insufficient',
      reasons: ['Grounding incomplete.'],
      retryable: true,
      missingEvidenceKinds: ['repo_evidence'],
      unsatisfiedStepIds: [],
    }, delegatedEnvelope({
      taskContract: taskContract({
        steps: [
          { stepId: 'read', kind: 'read', summary: 'Read implementation files.' },
        ],
      }),
    }));
    const retrySection = appendDelegatedRetrySection([], genericFailure!)[0]?.content ?? '';
    expect(retrySection).toContain('Do not invent filenames or sibling paths after an ENOENT or a failed read/list call.');
    expect(retrySection).toContain('If a search result is truncated or only reports that matches exist');
    expect(formatDelegatedStepIds(['read', 'answer'])).toBe('read, answer');
  });
});

function gatewayDecision(): IntentGatewayDecision {
  return {
    route: 'coding_task',
    confidence: 'high',
    operation: 'inspect',
    summary: 'Inspect files.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'repo_grounded',
    entities: {},
  };
}

function taskContract(input: {
  planId?: string;
  summary?: string;
  requireExactFileReferences?: boolean;
  steps: Array<Omit<PlannedStep, 'required'> & { required?: boolean }>;
}): DelegatedTaskContract {
  return {
    kind: 'repo_inspection',
    route: 'coding_task',
    operation: 'inspect',
    requiresEvidence: true,
    allowsAnswerFirst: false,
    requireExactFileReferences: input.requireExactFileReferences ?? true,
    summary: input.summary ?? 'Inspect files.',
    plan: {
      planId: input.planId ?? 'plan-1',
      steps: input.steps.map((step) => ({
        ...step,
        required: step.required ?? true,
      })),
      allowAdditionalSteps: false,
    },
  };
}

function delegatedEnvelope(input: {
  taskContract?: DelegatedTaskContract;
  stepReceipts?: DelegatedResultEnvelope['stepReceipts'];
  evidenceReceipts?: DelegatedResultEnvelope['evidenceReceipts'];
}): DelegatedResultEnvelope {
  return {
    taskContract: input.taskContract ?? taskContract({
      steps: [
        { stepId: 'answer', kind: 'answer', summary: 'Answer.' },
      ],
    }),
    runStatus: 'incomplete',
    stopReason: 'end_turn',
    stepReceipts: input.stepReceipts ?? [],
    operatorSummary: 'Incomplete.',
    claims: [],
    evidenceReceipts: input.evidenceReceipts ?? [],
    interruptions: [],
    artifacts: [],
    events: [],
  };
}

function executionProfile(): SelectedExecutionProfile {
  return {
    id: 'managed_cloud_tool',
    providerName: 'openrouter',
    providerType: 'openrouter',
    providerModel: 'moonshotai/kimi-k2.6',
    providerLocality: 'external',
    providerTier: 'managed_cloud',
    requestedTier: 'external',
    preferredAnswerPath: 'tool_loop',
    expectedContextPressure: 'medium',
    contextBudget: 64_000,
    toolContextMode: 'standard',
    maxAdditionalSections: 3,
    maxRuntimeNotices: 6,
    fallbackProviderOrder: [],
    reason: 'test',
  };
}

function retryProfileConfig(): GuardianAgentConfig {
  const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
  config.llm = {
    'ollama-cloud-coding': {
      provider: 'ollama_cloud',
      model: 'glm-5.1',
      credentialRef: 'llm.ollama_cloud.coding',
    },
    'ollama-cloud-tools': {
      provider: 'ollama_cloud',
      model: 'qwen3:32b',
      credentialRef: 'llm.ollama_cloud.tools',
    },
    anthropic: {
      provider: 'anthropic',
      model: 'claude-opus-4.6',
      apiKey: 'test-key',
    },
  };
  config.assistant.tools.preferredProviders = {
    local: 'ollama',
    managedCloud: 'ollama-cloud-coding',
    frontier: 'anthropic',
  };
  config.assistant.tools.modelSelection = {
    ...(config.assistant.tools.modelSelection || {}),
    autoPolicy: 'balanced',
    preferManagedCloudForLowPressureExternal: true,
    preferFrontierForRepoGrounded: true,
    preferFrontierForSecurity: true,
    managedCloudRouting: {
      enabled: true,
      roleBindings: {
        general: 'ollama-cloud-coding',
        toolLoop: 'ollama-cloud-tools',
        coding: 'ollama-cloud-coding',
      },
    },
  };
  return config;
}

function managedCloudCodingProfile(): SelectedExecutionProfile {
  return {
    id: 'managed_cloud_tool',
    providerName: 'ollama-cloud-coding',
    providerType: 'ollama_cloud',
    providerModel: 'glm-5.1',
    providerLocality: 'external',
    providerTier: 'managed_cloud',
    requestedTier: 'external',
    preferredAnswerPath: 'tool_loop',
    expectedContextPressure: 'medium',
    contextBudget: 64_000,
    toolContextMode: 'standard',
    maxAdditionalSections: 3,
    maxRuntimeNotices: 6,
    fallbackProviderOrder: ['ollama-cloud-coding', 'ollama-cloud-tools', 'anthropic'],
    reason: 'delegated coding role selected managed-cloud coding profile',
    routingMode: 'auto',
    selectionSource: 'delegated_role',
  };
}
