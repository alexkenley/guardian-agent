import { describe, expect, it, vi } from 'vitest';

import type { UserMessage } from '../../agent/types.js';
import type { IntentGatewayRecord } from '../intent-gateway.js';
import {
  runDirectRouteOrchestration,
  shouldSkipDirectWebSearch,
} from './direct-route-orchestration.js';

const message: UserMessage = {
  id: 'msg-direct-route',
  userId: 'owner',
  channel: 'web',
  content: 'Search the web for Guardian Agent architecture.',
  timestamp: 1_700_000_000_000,
};

function gateway(route = 'search_task'): IntentGatewayRecord {
  return {
    available: true,
    latencyMs: 5,
    model: 'test-classifier',
    decision: {
      route: route as never,
      confidence: 'high',
      operation: 'search',
      summary: 'Searches the web.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'direct_tool',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'direct',
      entities: {},
    },
  };
}

describe('direct route orchestration', () => {
  it('suppresses direct web search when code-session context owns the turn', async () => {
    const webSearch = vi.fn(async () => 'web result');
    const trace = vi.fn();

    const result = await runDirectRouteOrchestration({
      skipDirectTools: false,
      gateway: gateway(),
      message,
      activeSkills: [],
      resolvedCodeSession: { session: { id: 'code-1' } },
      codeContext: { sessionId: 'code-1' },
      handlers: {
        web_search: webSearch,
      },
      onHandled: async (_candidate, handledResult) => String(handledResult),
      recordIntentRoutingTrace: trace,
    });

    expect(result).toBeNull();
    expect(webSearch).not.toHaveBeenCalled();
    expect(trace).toHaveBeenCalledWith(
      'direct_candidates_evaluated',
      expect.objectContaining({
        details: expect.objectContaining({
          candidates: [],
          skipDirectWebSearch: true,
          codeSessionResolved: true,
          codeSessionId: 'code-1',
        }),
      }),
    );
  });

  it('runs degraded memory fallback only when gateway routing is unavailable', async () => {
    const fallback = vi.fn(async () => 'saved degraded memory');

    const result = await runDirectRouteOrchestration({
      skipDirectTools: false,
      gateway: {
        ...gateway('unknown'),
        available: false,
        decision: {
          ...gateway('unknown').decision,
          route: 'unknown',
          confidence: 'low',
          operation: 'unknown',
        },
      },
      message,
      activeSkills: [],
      handlers: {},
      onHandled: async (_candidate, handledResult) => String(handledResult),
      onDegradedMemoryFallback: fallback,
    });

    expect(result).toBe('saved degraded memory');
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('uses active search skills to suppress the generic direct web-search route', () => {
    expect(shouldSkipDirectWebSearch({
      gateway: gateway(),
      activeSkills: [{ id: 'weather' } as never],
    })).toBe(true);
  });
});
