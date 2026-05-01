import { describe, expect, it } from 'vitest';
import {
  buildPlannedTask,
  buildStepReceipts,
  computeWorkerRunStatus,
  findAnswerStepId,
  matchPlannedStepForTool,
} from './task-plan.js';
import type { EvidenceReceipt, PlannedTask } from './types.js';

describe('task plan receipt accounting', () => {
  it('uses the final answer receipt to satisfy every answer step in a multi-answer plan', () => {
    const plannedTask: PlannedTask = {
      planId: 'plan:complex_planning_task:run:3',
      allowAdditionalSteps: false,
      steps: [
        {
          stepId: 'step_1',
          kind: 'answer',
          summary: 'Confirm the complex-planning path.',
          required: true,
        },
        {
          stepId: 'step_2',
          kind: 'write',
          summary: 'Write the requested implementation note.',
          expectedToolCategories: ['fs_write'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          stepId: 'step_3',
          kind: 'answer',
          summary: 'Include the DAG plan summary in the final answer.',
          required: true,
          dependsOn: ['step_2'],
        },
      ],
    };
    const answerReceipt: EvidenceReceipt = {
      receiptId: 'answer:1',
      sourceType: 'model_answer',
      status: 'succeeded',
      refs: [],
      summary: 'I generated and executed a DAG plan.',
      startedAt: 3,
      endedAt: 3,
    };
    const writeReceipt: EvidenceReceipt = {
      receiptId: 'receipt-write-1',
      sourceType: 'tool_call',
      toolName: 'fs_write',
      status: 'succeeded',
      refs: ['tmp/manual-dag-smoke/summary.md'],
      summary: 'Wrote tmp/manual-dag-smoke/summary.md.',
      startedAt: 1,
      endedAt: 2,
    };

    const stepReceipts = buildStepReceipts({
      plannedTask,
      evidenceReceipts: [writeReceipt, answerReceipt],
      toolReceiptStepIds: new Map([[writeReceipt.receiptId, 'step_2']]),
      finalAnswerReceiptId: answerReceipt.receiptId,
    });

    expect(findAnswerStepId(plannedTask)).toBe('step_3');
    expect(stepReceipts).toMatchObject([
      { stepId: 'step_1', status: 'satisfied', evidenceReceiptIds: ['answer:1'] },
      { stepId: 'step_2', status: 'satisfied', evidenceReceiptIds: ['receipt-write-1'] },
      { stepId: 'step_3', status: 'satisfied', evidenceReceiptIds: ['answer:1'] },
    ]);
    expect(computeWorkerRunStatus(plannedTask, stepReceipts, [], 'end_turn')).toBe('completed');
  });

  it('maps repo inspection category steps to read-only repo tools', () => {
    const plannedTask: PlannedTask = {
      planId: 'plan:coding_task:inspect:2',
      allowAdditionalSteps: false,
      steps: [
        {
          stepId: 'step_1',
          kind: 'read',
          summary: 'Inspect the repository for implementation files.',
          expectedToolCategories: ['repo_inspect'],
          required: true,
        },
        {
          stepId: 'step_2',
          kind: 'answer',
          summary: 'Answer with exact implementation files.',
          required: true,
          dependsOn: ['step_1'],
        },
      ],
    };

    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'fs_search',
      args: { query: 'direct reasoning graph artifacts' },
    })).toBe('step_1');
    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'fs_read',
      args: { path: 'src/runtime/execution-graph/graph-artifacts.ts' },
    })).toBe('step_1');
    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'code_symbol_search',
      args: { query: 'SynthesisDraft' },
    })).toBe('step_1');
  });

  it('uses repo inspection category tool receipts to satisfy the planned step', () => {
    const plannedTask: PlannedTask = {
      planId: 'plan:coding_task:inspect:2',
      allowAdditionalSteps: false,
      steps: [
        {
          stepId: 'step_1',
          kind: 'read',
          summary: 'Inspect the repository for implementation files.',
          expectedToolCategories: ['repo_inspect'],
          required: true,
        },
        {
          stepId: 'step_2',
          kind: 'answer',
          summary: 'Answer with exact implementation files.',
          required: true,
          dependsOn: ['step_1'],
        },
      ],
    };
    const searchReceipt: EvidenceReceipt = {
      receiptId: 'receipt-search-1',
      sourceType: 'tool_call',
      toolName: 'fs_search',
      status: 'succeeded',
      refs: ['src/runtime/execution-graph/graph-artifacts.ts'],
      summary: 'Found direct reasoning graph artifact definitions.',
      startedAt: 1,
      endedAt: 2,
    };
    const answerReceipt: EvidenceReceipt = {
      receiptId: 'answer:1',
      sourceType: 'model_answer',
      status: 'succeeded',
      refs: ['src/runtime/execution-graph/graph-artifacts.ts'],
      summary: 'The artifact contracts live in graph-artifacts.ts.',
      startedAt: 3,
      endedAt: 3,
    };

    const stepReceipts = buildStepReceipts({
      plannedTask,
      evidenceReceipts: [searchReceipt, answerReceipt],
      toolReceiptStepIds: new Map([[searchReceipt.receiptId, 'step_1']]),
      finalAnswerReceiptId: answerReceipt.receiptId,
    });

    expect(stepReceipts).toMatchObject([
      { stepId: 'step_1', status: 'satisfied', evidenceReceiptIds: ['receipt-search-1'] },
      { stepId: 'step_2', status: 'satisfied', evidenceReceiptIds: ['answer:1'] },
    ]);
    expect(computeWorkerRunStatus(plannedTask, stepReceipts, [], 'end_turn')).toBe('completed');
  });

  it('maps memory evidence categories to memory search receipts', () => {
    const plannedTask: PlannedTask = {
      planId: 'plan:memory_task:search:2',
      allowAdditionalSteps: false,
      steps: [
        {
          stepId: 'step_1',
          kind: 'read',
          summary: 'Search memory for the requested marker.',
          expectedToolCategories: ['memory'],
          required: true,
        },
        {
          stepId: 'step_2',
          kind: 'answer',
          summary: 'Answer with the matching marker.',
          required: true,
          dependsOn: ['step_1'],
        },
      ],
    };
    const memoryReceipt: EvidenceReceipt = {
      receiptId: 'receipt-memory-1',
      sourceType: 'tool_call',
      toolName: 'memory_search',
      status: 'succeeded',
      refs: ['memory:marker'],
      summary: 'Found the marker in memory.',
      startedAt: 1,
      endedAt: 2,
    };
    const answerReceipt: EvidenceReceipt = {
      receiptId: 'answer:1',
      sourceType: 'model_answer',
      status: 'succeeded',
      refs: ['memory:marker'],
      summary: 'SMOKE-MEM-42801',
      startedAt: 3,
      endedAt: 3,
    };

    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'memory_search',
      args: { query: 'SMOKE-MEM-42801' },
    })).toBe('step_1');

    expect(matchPlannedStepForTool({
      plannedTask: {
        ...plannedTask,
        steps: plannedTask.steps.map((step) => step.stepId === 'step_1'
          ? { ...step, expectedToolCategories: ['memory_task'] }
          : step),
      },
      toolName: 'memory_search',
      args: { query: 'SMOKE-MEM-42801' },
    })).toBe('step_1');

    const stepReceipts = buildStepReceipts({
      plannedTask,
      evidenceReceipts: [memoryReceipt, answerReceipt],
      toolReceiptStepIds: new Map([[memoryReceipt.receiptId, 'step_1']]),
      finalAnswerReceiptId: answerReceipt.receiptId,
    });

    expect(stepReceipts).toMatchObject([
      { stepId: 'step_1', status: 'satisfied', evidenceReceiptIds: ['receipt-memory-1'] },
      { stepId: 'step_2', status: 'satisfied', evidenceReceiptIds: ['answer:1'] },
    ]);
    expect(computeWorkerRunStatus(plannedTask, stepReceipts, [], 'end_turn')).toBe('completed');
  });

  it('infers semantic evidence categories for generic general-assistant search steps', () => {
    const plannedTask = buildPlannedTask({
      route: 'general_assistant',
      operation: 'search',
      plannedSteps: [
        {
          kind: 'search',
          summary: 'Search the web for the title of https://example.com.',
          required: true,
        },
        {
          kind: 'search',
          summary: 'Search this repo for runLiveToolLoopController.',
          required: true,
        },
        {
          kind: 'search',
          summary: 'Search memory for SMOKE-MEM-42801.',
          required: true,
        },
        {
          kind: 'answer',
          summary: 'Return three short bullets with what each source found.',
          required: true,
          dependsOn: ['step_1', 'step_2', 'step_3'],
        },
      ],
    }, {
      kind: 'general_answer',
      route: 'general_assistant',
      operation: 'search',
      summary: 'User wants three parallel searches and a bullet summary of results.',
    });

    expect(plannedTask.steps.map((step) => step.expectedToolCategories ?? [])).toEqual([
      ['web'],
      ['repo_inspect'],
      ['memory'],
      [],
    ]);
    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'web_fetch',
      args: { url: 'https://example.com' },
    })).toBe('step_1');
    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'fs_search',
      args: { query: 'runLiveToolLoopController' },
    })).toBe('step_2');
    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'memory_search',
      args: { query: 'SMOKE-MEM-42801' },
    })).toBe('step_3');
  });

  it('infers multiple connector status categories from a mixed status read step', () => {
    const plannedTask = buildPlannedTask({
      route: 'complex_planning_task',
      operation: 'inspect',
      plannedSteps: [
        {
          kind: 'read',
          summary: 'Check Vercel status, WHM status, Gmail auth/status, Microsoft calendar status, and saved automations.',
          required: true,
        },
        {
          kind: 'search',
          summary: 'Search this workspace for runLiveToolLoopController.',
          required: true,
        },
      ],
    }, {
      kind: 'general_answer',
      route: 'complex_planning_task',
      operation: 'inspect',
      summary: 'User wants a mixed connector status and repo sweep.',
    });

    expect(plannedTask.steps[0]?.expectedToolCategories).toEqual([
      'automation_list',
      'vercel_status',
      'whm_status',
      'gws_status',
      'm365_status',
    ]);
    expect(plannedTask.steps[1]?.expectedToolCategories).toEqual(['repo_inspect']);
  });

  it('requires real evidence when a read-only tool-synthesis plan only contains answer steps', () => {
    const plannedTask = buildPlannedTask({
      route: 'general_assistant',
      operation: 'inspect',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      confidence: 'high',
      summary: 'Inspect connected service status.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      entities: {},
      plannedSteps: [
        {
          kind: 'answer',
          summary: 'Do not create, update, delete, deploy, send email, start sandboxes, or modify anything.',
          required: true,
        },
        {
          kind: 'answer',
          summary: 'Return a compact table with each domain, tool/source used, connected/available status, and safe identifiers.',
          required: true,
          dependsOn: ['step_1'],
        },
      ],
    }, {
      kind: 'general_answer',
      route: 'general_assistant',
      operation: 'inspect',
      summary: 'Inspect connected service status.',
    });

    expect(plannedTask).toMatchObject({
      allowAdditionalSteps: true,
      steps: [
        {
          stepId: 'step_1',
          kind: 'tool_call',
          expectedToolCategories: ['runtime_evidence'],
          required: true,
        },
        {
          stepId: 'step_2',
          kind: 'answer',
          required: true,
          dependsOn: ['step_1'],
        },
      ],
    });
    expect(plannedTask.steps[1]?.summary).toContain('Return a compact table');
    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'find_tools',
      args: { query: 'vercel_status' },
    })).toBeUndefined();
    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'whm_status',
      args: { profile: 'safe-profile-id' },
    })).toBe('step_1');
    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'automation_list',
      args: {},
    })).toBe('step_1');
    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'web_search',
      args: { query: 'example' },
    })).toBe('step_1');
  });

  it('does not add evidence requirements to ordinary direct general answers', () => {
    const plannedTask = buildPlannedTask({
      route: 'general_assistant',
      operation: 'inspect',
      executionClass: 'direct_assistant',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: false,
      expectedContextPressure: 'low',
      preferredAnswerPath: 'direct',
      simpleVsComplex: 'simple',
      confidence: 'high',
      summary: 'Give concise planning advice.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      entities: {},
    }, {
      kind: 'general_answer',
      route: 'general_assistant',
      operation: 'inspect',
      summary: 'Give concise planning advice.',
    });

    expect(plannedTask.steps).toEqual([
      {
        stepId: 'step_1',
        kind: 'answer',
        summary: 'Give concise planning advice.',
        required: true,
      },
    ]);
  });

  it('preserves additional tool latitude when retrying a runtime-evidence fallback plan', () => {
    const plannedTask = buildPlannedTask({
      route: 'general_assistant',
      operation: 'inspect',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      confidence: 'high',
      summary: 'Inspect connected service status.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      entities: {},
      plannedSteps: [
        {
          kind: 'tool_call',
          summary: 'Collect real runtime/tool evidence needed to answer the request across the requested domains.',
          expectedToolCategories: ['runtime_evidence'],
          required: true,
        },
        {
          kind: 'answer',
          summary: 'Return a compact table.',
          required: true,
          dependsOn: ['step_1'],
        },
      ],
    }, {
      kind: 'general_answer',
      route: 'general_assistant',
      operation: 'inspect',
      summary: 'Inspect connected service status.',
    });

    expect(plannedTask.allowAdditionalSteps).toBe(true);
  });

  it('maps Microsoft and Google status tools to connector status categories', () => {
    const plannedTask: PlannedTask = {
      planId: 'plan:connector-status:1',
      allowAdditionalSteps: false,
      steps: [
        {
          stepId: 'step_1',
          kind: 'read',
          summary: 'Check Microsoft calendar and Google Workspace auth status.',
          expectedToolCategories: ['m365', 'm365_calendar_status', 'gmail_auth_status'],
          required: true,
        },
        {
          stepId: 'step_2',
          kind: 'answer',
          summary: 'Return status summary.',
          required: true,
          dependsOn: ['step_1'],
        },
      ],
    };

    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'm365_status',
      args: {},
    })).toBe('step_1');
    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'gws',
      args: { service: 'gmail', resource: 'users labels', method: 'list' },
    })).toBe('step_1');

    const stepReceipts = buildStepReceipts({
      plannedTask,
      evidenceReceipts: [
        {
          receiptId: 'receipt-m365-status',
          sourceType: 'tool_call',
          toolName: 'm365_status',
          status: 'succeeded',
          refs: [],
          summary: 'Microsoft 365 calendar is authenticated.',
          startedAt: 1,
          endedAt: 2,
        },
        {
          receiptId: 'receipt-answer',
          sourceType: 'model_answer',
          status: 'succeeded',
          refs: [],
          summary: 'Status summary.',
          startedAt: 3,
          endedAt: 4,
        },
      ],
      toolReceiptStepIds: new Map([['receipt-m365-status', 'step_1']]),
      finalAnswerReceiptId: 'receipt-answer',
    });

    expect(stepReceipts).toMatchObject([
      { stepId: 'step_1', status: 'satisfied', evidenceReceiptIds: ['receipt-m365-status'] },
      { stepId: 'step_2', status: 'satisfied', evidenceReceiptIds: ['receipt-answer'] },
    ]);
    expect(computeWorkerRunStatus(plannedTask, stepReceipts, [], 'end_turn')).toBe('completed');
  });

  it('allows semantic write steps to be satisfied by Second Brain mutation tools', () => {
    const plannedTask: PlannedTask = {
      planId: 'plan:complex_planning_task:run:2',
      allowAdditionalSteps: false,
      steps: [
        {
          stepId: 'step_1',
          kind: 'write',
          summary: 'Create a local Second Brain calendar appointment.',
          expectedToolCategories: ['write'],
          required: true,
        },
        {
          stepId: 'step_2',
          kind: 'answer',
          summary: 'Confirm the appointment was created.',
          required: true,
          dependsOn: ['step_1'],
        },
      ],
    };

    expect(matchPlannedStepForTool({
      plannedTask,
      toolName: 'second_brain_calendar_upsert',
      args: { title: 'Take Benny to the vet' },
    })).toBe('step_1');
  });

  it('uses model answer receipts to satisfy answer-category planned steps', () => {
    const plannedTask: PlannedTask = {
      planId: 'plan:general_assistant:read:1',
      allowAdditionalSteps: false,
      steps: [
        {
          stepId: 'step_1',
          kind: 'answer',
          summary: 'Answer from the gathered evidence.',
          expectedToolCategories: ['answer'],
          required: true,
        },
      ],
    };
    const answerReceipt: EvidenceReceipt = {
      receiptId: 'answer:grounded-synthesis',
      sourceType: 'model_answer',
      status: 'succeeded',
      refs: [],
      summary: 'Grounded answer.',
      startedAt: 1,
      endedAt: 1,
    };

    const stepReceipts = buildStepReceipts({
      plannedTask,
      evidenceReceipts: [answerReceipt],
      finalAnswerReceiptId: answerReceipt.receiptId,
    });

    expect(stepReceipts).toMatchObject([
      {
        stepId: 'step_1',
        status: 'satisfied',
        evidenceReceiptIds: ['answer:grounded-synthesis'],
      },
    ]);
    expect(computeWorkerRunStatus(plannedTask, stepReceipts, [], 'end_turn')).toBe('completed');
  });
});
