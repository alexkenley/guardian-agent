import { describe, expect, it } from 'vitest';
import {
  attachWorkerSuspensionMetadata,
  buildWorkerSuspensionEnvelope,
  readWorkerSuspensionEnvelope,
  readWorkerSuspensionMetadata,
  withWorkerSuspensionSourceEnvelope,
  WORKER_SUSPENSION_SCHEMA_VERSION,
} from './worker-suspension.js';
import { buildDelegatedSyntheticEnvelope } from './execution/metadata.js';
import { buildDelegatedTaskContract } from './execution/verifier.js';

describe('worker suspension serialization', () => {
  it('round-trips suspended tool-loop state through metadata and graph envelope payloads', () => {
    const sourceEnvelope = buildDelegatedSyntheticEnvelope({
      taskContract: buildDelegatedTaskContract(null),
      runStatus: 'suspended',
      stopReason: 'approval_required',
      operatorSummary: 'Waiting for approval.',
      evidenceReceipts: [],
      events: [],
    });
    const session = {
      version: WORKER_SUSPENSION_SCHEMA_VERSION,
      kind: 'tool_loop' as const,
      llmMessages: [
        { role: 'assistant' as const, content: '', toolCalls: [{ id: 'call-1', name: 'fs_write', args: '{}' }] },
      ],
      pendingTools: [{ approvalId: 'approval-1', toolCallId: 'call-1', jobId: 'job-1', name: 'fs_write' }],
      originalMessage: {
        id: 'message-1',
        userId: 'user-1',
        principalId: 'user-1',
        principalRole: 'owner' as const,
        channel: 'web',
        content: 'Write the report.',
        timestamp: 1,
      },
      sourceEnvelope,
      createdAt: 2,
      expiresAt: 3_000,
    };
    const metadata = attachWorkerSuspensionMetadata({}, session);

    expect(readWorkerSuspensionMetadata(metadata)).toEqual(session);

    const envelope = buildWorkerSuspensionEnvelope({
      resume: {
        workerSessionKey: 'session:agent',
        sessionId: 'session',
        agentId: 'agent',
        userId: 'user-1',
        principalId: 'user-1',
        principalRole: 'owner',
        channel: 'web',
        approvalIds: ['approval-1'],
        expiresAt: 3_000,
      },
      session,
    });

    expect(readWorkerSuspensionEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
  });

  it('rebases tool-loop suspension source evidence onto the verified envelope before graph persistence', () => {
    const taskContract = buildDelegatedTaskContract(null);
    const staleEnvelope = buildDelegatedSyntheticEnvelope({
      taskContract,
      runStatus: 'suspended',
      stopReason: 'approval_required',
      operatorSummary: 'Waiting for approval.',
      evidenceReceipts: [{
        receiptId: 'receipt-web',
        sourceType: 'tool_call',
        toolName: 'web_fetch',
        status: 'pending_approval',
        refs: [],
        summary: 'Waiting for approval.',
        startedAt: 1,
        endedAt: 1,
      }],
      events: [],
    });
    const verifiedEnvelope = buildDelegatedSyntheticEnvelope({
      taskContract,
      runStatus: 'suspended',
      stopReason: 'approval_required',
      operatorSummary: 'Waiting for approval.',
      evidenceReceipts: [
        ...staleEnvelope.evidenceReceipts,
        {
          receiptId: 'receipt-memory',
          sourceType: 'tool_call',
          toolName: 'memory_search',
          status: 'succeeded',
          refs: ['memory:smoke'],
          summary: 'Found SMOKE-MEM-42801.',
          startedAt: 2,
          endedAt: 2,
        },
      ],
      events: [],
    });
    const session = {
      version: WORKER_SUSPENSION_SCHEMA_VERSION,
      kind: 'tool_loop' as const,
      llmMessages: [
        { role: 'assistant' as const, content: '', toolCalls: [{ id: 'call-1', name: 'web_fetch', args: '{}' }] },
      ],
      pendingTools: [{ approvalId: 'approval-1', toolCallId: 'call-1', jobId: 'job-1', name: 'web_fetch' }],
      originalMessage: {
        id: 'message-1',
        userId: 'user-1',
        principalId: 'user-1',
        principalRole: 'owner' as const,
        channel: 'web',
        content: 'Fetch the page, search memory, then answer.',
        timestamp: 1,
      },
      sourceEnvelope: staleEnvelope,
      createdAt: 2,
      expiresAt: 3_000,
    };

    const rebased = withWorkerSuspensionSourceEnvelope(session, verifiedEnvelope);

    expect(rebased?.kind).toBe('tool_loop');
    if (rebased?.kind !== 'tool_loop') return;
    expect(rebased.sourceEnvelope?.evidenceReceipts.map((receipt) => receipt.receiptId)).toEqual([
      'receipt-web',
      'receipt-memory',
    ]);
    expect(session.sourceEnvelope.evidenceReceipts.map((receipt) => receipt.receiptId)).toEqual([
      'receipt-web',
    ]);
  });
});
