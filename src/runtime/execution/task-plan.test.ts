import { describe, expect, it } from 'vitest';
import {
  buildStepReceipts,
  computeWorkerRunStatus,
  findAnswerStepId,
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
});
