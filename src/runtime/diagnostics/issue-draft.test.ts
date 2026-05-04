import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../guardian/audit-log.js';
import type { IntentRoutingTraceEntry } from '../intent-routing-trace.js';
import { buildDiagnosticsIssueDraft } from './issue-draft.js';

function traceEntry(
  stage: IntentRoutingTraceEntry['stage'],
  requestId: string,
  timestamp: number,
  details: Record<string, unknown> = {},
): IntentRoutingTraceEntry {
  return {
    id: `${requestId}-${stage}-${timestamp}`,
    timestamp,
    stage,
    requestId,
    channel: 'web',
    userId: 'owner',
    agentId: 'assistant',
    contentPreview: details.contentPreview as string | undefined,
    details,
  };
}

function auditEvent(type: AuditEvent['type'], timestamp: number, details: Record<string, unknown>): AuditEvent {
  return {
    id: `audit-${timestamp}`,
    timestamp,
    type,
    severity: type === 'action_denied' ? 'warn' : 'info',
    agentId: 'assistant-tools',
    controller: type === 'action_denied' ? 'GuardianAgent' : undefined,
    details,
  };
}

describe('buildDiagnosticsIssueDraft', () => {
  it('drafts a redacted issue from the latest completed request instead of the current report request', async () => {
    const entries = [
      traceEntry('incoming_dispatch', 'req-current', 5000, { contentPreview: 'Report this as a bug' }),
      traceEntry('incoming_dispatch', 'req-bad', 1000, { contentPreview: 'Fetch one of those pages and summarize it.' }),
      traceEntry('gateway_classified', 'req-bad', 1100, { route: 'browser_task', operation: 'read' }),
      traceEntry('clarification_requested', 'req-bad', 1200, { summary: 'I need a bit more detail before I can continue.' }),
      traceEntry('dispatch_response', 'req-bad', 1300, { responsePreview: 'I need a bit more detail before I can continue.' }),
    ];
    const result = await buildDiagnosticsIssueDraft(
      { problem: 'The follow-up page fetch asked a generic clarification.' },
      {
        intentRoutingTrace: {
          getStatus: () => ({ enabled: true, filePath: '/tmp/intent-routing.jsonl' }),
          listRecent: async () => entries,
        },
        auditLog: {
          query: () => [
            auditEvent('action_allowed', 1150, { actionType: 'browser_read', token: 'secret-value' }),
          ],
        },
      },
      'req-current',
    );

    expect(result.evidence.requestIds).toEqual(['req-bad']);
    expect(result.evidence.entriesAnalyzed).toBe(4);
    expect(result.draft.title).toContain('The follow-up page fetch');
    expect(result.draft.suspectedSubsystems).toContain('intent-gateway');
    expect(result.draft.body).toContain('Fetch one of those pages and summarize it.');
    expect(result.draft.body).not.toContain('secret-value');
    expect(result.nextStep).toContain('Only create a GitHub issue after the user explicitly approves');
  });

  it('supports a specific request id diagnostic target', async () => {
    const entries = [
      traceEntry('incoming_dispatch', 'req-one', 1000, { contentPreview: 'old request' }),
      traceEntry('incoming_dispatch', 'req-two', 2000, { contentPreview: 'bad routing request' }),
      traceEntry('delegated_worker_failed', 'req-two', 2100, { reason: 'Worker returned no usable answer.' }),
      traceEntry('dispatch_response', 'req-two', 2200, { responsePreview: 'Sorry, something went wrong.' }),
    ];
    const result = await buildDiagnosticsIssueDraft(
      { target: 'request_id', requestId: 'req-two' },
      {
        intentRoutingTrace: {
          getStatus: () => ({ enabled: true, filePath: '/tmp/intent-routing.jsonl' }),
          listRecent: async () => entries,
        },
      },
    );

    expect(result.evidence.target).toBe('request_id');
    expect(result.evidence.requestIds).toEqual(['req-two']);
    expect(result.draft.severity).toBe('high');
    expect(result.draft.suspectedSubsystems).toContain('delegated-orchestration');
  });
});
