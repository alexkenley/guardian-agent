import { describe, expect, it } from 'vitest';
import type { IntentGatewayRecord } from './intent-gateway.js';
import { resolveDirectIntentRoutingCandidates } from './direct-intent-routing.js';

function mockGateway(partial: {
  route: string;
  operation?: string;
  confidence?: string;
  turnRelation?: string;
  entities?: Record<string, unknown>;
}): IntentGatewayRecord {
  return {
    mode: 'primary',
    available: true,
    model: 'test-model',
    latencyMs: 10,
    decision: {
      route: partial.route as IntentGatewayRecord['decision']['route'],
      confidence: (partial.confidence ?? 'high') as IntentGatewayRecord['decision']['confidence'],
      operation: (partial.operation ?? 'unknown') as IntentGatewayRecord['decision']['operation'],
      summary: 'Test classification.',
      turnRelation: (partial.turnRelation ?? 'new_request') as IntentGatewayRecord['decision']['turnRelation'],
      resolution: 'ready',
      missingFields: [],
      entities: (partial.entities ?? {}) as IntentGatewayRecord['decision']['entities'],
    },
  };
}

const ALL_CANDIDATES = [
  'coding_session_control',
  'coding_backend',
  'filesystem',
  'scheduled_email_automation',
  'automation',
  'automation_control',
  'automation_output',
  'workspace_write',
  'workspace_read',
  'browser',
  'web_search',
] as const;

describe('resolveDirectIntentRoutingCandidates', () => {
  it('maps coding_session_control route to coding_session_control candidate', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'coding_session_control', operation: 'navigate' }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['coding_session_control']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('maps coding_task route with explicit coding backend to coding_backend candidate', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'coding_task', operation: 'run', entities: { codingBackend: 'codex' } }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['coding_backend']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('maps coding_task route without explicit coding backend to no direct candidates', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'coding_task', operation: 'create' }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
  });

  it('maps coding_task follow-up inspect requests to coding_backend candidate even without explicit backend', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'coding_task', operation: 'inspect', turnRelation: 'follow_up' }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['coding_backend']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('maps general_assistant route to no candidates', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'general_assistant', operation: 'unknown' }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
  });

  it('uses fallback order when gateway is unavailable', () => {
    const result = resolveDirectIntentRoutingCandidates(
      null,
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.gatewayUnavailable).toBe(true);
    expect(result.candidates).toEqual([...ALL_CANDIDATES]);
  });

  it('filters candidates by available set', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'coding_session_control', operation: 'inspect' }),
      [...ALL_CANDIDATES],
      ['filesystem', 'browser'], // coding_session_control is not available
    );
    expect(result.candidates).toEqual([]);
  });
});
