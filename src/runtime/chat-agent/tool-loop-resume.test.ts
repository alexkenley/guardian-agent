import { describe, expect, it } from 'vitest';
import type { UserMessage } from '../../agent/types.js';
import {
  buildToolLoopPendingApprovalResume,
  collectToolLoopPendingApprovalTools,
  readToolLoopResumePayload,
} from './tool-loop-resume.js';

const message: UserMessage = {
  id: 'message-1',
  userId: 'user-1',
  principalId: 'user-1',
  principalRole: 'owner',
  channel: 'web',
  surfaceId: 'surface-1',
  content: 'Write the report.',
  timestamp: 123,
};

describe('tool loop resume helpers', () => {
  it('collects pending approval tools from settled tool results', () => {
    const pendingTools = collectToolLoopPendingApprovalTools([
      {
        status: 'fulfilled',
        value: {
          toolCall: { id: 'call-1', name: 'fs_write' },
          result: {
            status: 'pending_approval',
            approvalId: 'approval-1',
            jobId: 'job-1',
          },
        },
      },
      {
        status: 'fulfilled',
        value: {
          toolCall: { id: 'call-2', name: 'memory_save' },
          result: {
            status: 'succeeded',
          },
        },
      },
      {
        status: 'rejected',
        reason: new Error('tool failed'),
      },
    ]);

    expect(pendingTools).toEqual([
      {
        approvalId: 'approval-1',
        toolCallId: 'call-1',
        jobId: 'job-1',
        name: 'fs_write',
      },
    ]);
  });

  it('builds a tool-loop pending-action resume payload beside the serializer', () => {
    const resume = buildToolLoopPendingApprovalResume({
      toolResults: [
        {
          status: 'fulfilled',
          value: {
            toolCall: { id: 'call-1', name: 'fs_write' },
            result: {
              status: 'pending_approval',
              approvalId: 'approval-1',
              jobId: 'job-1',
            },
          },
        },
      ],
      llmMessages: [
        { role: 'user', content: 'Write the report.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'fs_write', arguments: '{"path":"report.md"}' }],
        },
      ],
      originalMessage: message,
      requestText: 'Write the report.',
      referenceTime: 123,
      allowModelMemoryMutation: false,
      activeSkillIds: ['coding'],
      contentTrustLevel: 'trusted',
      taintReasons: [],
    });

    expect(resume?.kind).toBe('tool_loop');
    const payload = readToolLoopResumePayload(resume?.payload);
    expect(payload).toMatchObject({
      type: 'suspended_tool_loop',
      requestText: 'Write the report.',
      pendingTools: [
        {
          approvalId: 'approval-1',
          toolCallId: 'call-1',
          jobId: 'job-1',
          name: 'fs_write',
        },
      ],
      originalMessage: {
        id: 'message-1',
        userId: 'user-1',
        channel: 'web',
        surfaceId: 'surface-1',
      },
    });
  });
});
