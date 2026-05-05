import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../guardian/audit-log.js';
import type { IntentRoutingTraceEntry } from '../intent-routing-trace.js';
import { collectDiagnosticsEvidence } from './evidence.js';

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

describe('collectDiagnosticsEvidence', () => {
  it('selects the latest completed request for issue drafting evidence', async () => {
    const entries = [
      traceEntry('incoming_dispatch', 'current', 5000, { contentPreview: 'Draft an issue' }),
      traceEntry('incoming_dispatch', 'newer-incomplete', 4000, { contentPreview: 'Still running' }),
      traceEntry('delegated_worker_started', 'newer-incomplete', 4100),
      traceEntry('incoming_dispatch', 'completed', 1000, { contentPreview: 'Bad request' }),
      traceEntry('clarification_requested', 'completed', 1100, { summary: 'Missing concrete detail.' }),
      traceEntry('dispatch_response', 'completed', 1200, { responsePreview: 'Missing concrete detail.' }),
    ];

    const evidence = await collectDiagnosticsEvidence(
      { target: 'latest_completed_request', includeAudit: true },
      {
        intentRoutingTrace: {
          getStatus: () => ({ enabled: true, filePath: '/tmp/intent-routing.jsonl' }),
          listRecent: async () => entries,
        },
        auditLog: {
          query: () => [
            auditEvent('action_denied', 1150, { reason: 'Denied token secret-value' }),
          ],
        },
      },
      'current',
    );

    expect(evidence.requestIds).toEqual(['completed']);
    expect(evidence.blockers).toEqual(['Missing concrete detail.']);
    expect(evidence.guardianEvents[0]?.reason).not.toContain('secret-value');
  });

  it('selects the latest non-current request for quick trace inspection evidence', async () => {
    const entries = [
      traceEntry('incoming_dispatch', 'current', 5000, { contentPreview: 'Can you inspect the trace?' }),
      traceEntry('incoming_dispatch', 'older-completed', 1000, { contentPreview: 'Old request' }),
      traceEntry('dispatch_response', 'older-completed', 1100, { responsePreview: 'Done' }),
      traceEntry('incoming_dispatch', 'newer-incomplete', 4000, { contentPreview: 'Still running' }),
      traceEntry('delegated_worker_started', 'newer-incomplete', 4100),
    ];

    const evidence = await collectDiagnosticsEvidence(
      { target: 'latest_request', includeAudit: false },
      {
        intentRoutingTrace: {
          getStatus: () => ({ enabled: true, filePath: '/tmp/intent-routing.jsonl' }),
          listRecent: async () => entries,
        },
      },
      'current',
    );

    expect(evidence.requestIds).toEqual(['newer-incomplete']);
    expect(evidence.entriesAnalyzed).toBe(2);
    expect(evidence.auditEventsAnalyzed).toBe(0);
  });
});
