import { describe, expect, it } from 'vitest';
import {
  attachWorkerSuspensionMetadata,
  buildWorkerSuspensionEnvelope,
  readWorkerSuspensionEnvelope,
  readWorkerSuspensionMetadata,
  WORKER_SUSPENSION_SCHEMA_VERSION,
} from './worker-suspension.js';

describe('worker suspension serialization', () => {
  it('round-trips suspended tool-loop state through metadata and graph envelope payloads', () => {
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
});
