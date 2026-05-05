import { describe, expect, it } from 'vitest';
import { inspectDiagnosticsTrace } from './trace-inspect.js';
import type { IntentRoutingTraceEntry } from '../intent-routing-trace.js';

describe('inspectDiagnosticsTrace', () => {
  it('selects the latest non-current request and reports blockers', async () => {
    const entries: IntentRoutingTraceEntry[] = [
      {
        id: '1',
        timestamp: 1000,
        stage: 'incoming_dispatch',
        requestId: 'current',
        contentPreview: 'Can you see the routing trace?',
      },
      {
        id: '2',
        timestamp: 2000,
        stage: 'incoming_dispatch',
        requestId: 'previous',
        contentPreview: 'Can you see the routing trace for Windows?',
      },
      {
        id: '3',
        timestamp: 2100,
        stage: 'gateway_classified',
        requestId: 'previous',
        details: {
          route: 'diagnostics_task',
          resolution: 'needs_clarification',
        },
      },
      {
        id: '4',
        timestamp: 2200,
        stage: 'clarification_requested',
        requestId: 'previous',
        details: {
          prompt: 'I need a bit more detail before I can continue with that request.',
        },
      },
      {
        id: '5',
        timestamp: 2300,
        stage: 'dispatch_response',
        requestId: 'previous',
        contentPreview: 'I need a bit more detail before I can continue with that request.',
      },
    ];

    const result = await inspectDiagnosticsTrace(
      {},
      {
        intentRoutingTrace: {
          getStatus: () => ({ enabled: true, filePath: 'C:\\Users\\example\\.guardianagent\\routing\\intent-routing.jsonl' }),
          listRecent: () => entries,
        },
      },
      'current',
    );

    expect(result.traceEnabled).toBe(true);
    expect(result.latestRequestId).toBe('previous');
    expect(result.entriesAnalyzed).toBe(4);
    expect(result.blockers[0]).toContain('I need a bit more detail');
    expect(result.summary).toContain('blocking path');
  });
});
