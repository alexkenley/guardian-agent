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
    expect(result.gatewayHeuristicFallback).toBe(false);
  });

  it('maps coding_task route with an explicitly requested coding backend to coding_backend candidate', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({
        route: 'coding_task',
        operation: 'run',
        entities: { codingBackend: 'codex', codingBackendRequested: true },
      }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['coding_backend']);
    expect(result.gatewayDirected).toBe(true);
    expect(result.gatewayHeuristicFallback).toBe(false);
  });

  it('does not map coding_task route to coding_backend when the backend is only mentioned as the subject', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({
        route: 'coding_task',
        operation: 'inspect',
        entities: { codingBackend: 'codex', codingBackendRequested: false },
      }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
    expect(result.gatewayHeuristicFallback).toBe(false);
  });

  it('maps coding_task route without explicit coding backend to no direct candidates', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'coding_task', operation: 'create' }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
    expect(result.gatewayHeuristicFallback).toBe(false);
  });

  it('maps coding_task follow-up status checks to coding_backend candidate even without explicit backend', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({
        route: 'coding_task',
        operation: 'inspect',
        turnRelation: 'follow_up',
        entities: { codingRunStatusCheck: true },
      }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['coding_backend']);
    expect(result.gatewayDirected).toBe(true);
    expect(result.gatewayHeuristicFallback).toBe(false);
  });

  it('does not map generic coding inspect follow-ups to coding_backend without status-check metadata', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'coding_task', operation: 'inspect', turnRelation: 'follow_up' }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
    expect(result.gatewayHeuristicFallback).toBe(false);
  });

  it('keeps email_task on workspace candidates so provider-aware direct handlers can dispatch mailbox reads', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'email_task', operation: 'read', entities: { emailProvider: 'm365' } }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['workspace_read', 'workspace_write']);
    expect(result.gatewayDirected).toBe(true);
    expect(result.gatewayHeuristicFallback).toBe(false);
  });

  it('maps high-confidence general_assistant route to no candidates', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'general_assistant', operation: 'unknown' }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
    expect(result.gatewayUnavailable).toBe(false);
    expect(result.gatewayHeuristicFallback).toBe(false);
  });

  it('uses fallback order when gateway is unavailable', () => {
    const result = resolveDirectIntentRoutingCandidates(
      null,
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.gatewayUnavailable).toBe(true);
    expect(result.gatewayHeuristicFallback).toBe(true);
    expect(result.candidates).toEqual([...ALL_CANDIDATES]);
  });

  it('uses heuristic fallback order when the gateway returns low-confidence unknown', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'unknown', operation: 'unknown', confidence: 'low' }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([...ALL_CANDIDATES]);
    expect(result.gatewayDirected).toBe(false);
    expect(result.gatewayUnavailable).toBe(false);
    expect(result.gatewayHeuristicFallback).toBe(true);
  });

  it('uses heuristic fallback order when the gateway returns low-confidence general_assistant', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'general_assistant', operation: 'unknown', confidence: 'low' }),
      [...ALL_CANDIDATES],
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([...ALL_CANDIDATES]);
    expect(result.gatewayDirected).toBe(false);
    expect(result.gatewayUnavailable).toBe(false);
    expect(result.gatewayHeuristicFallback).toBe(true);
  });

  it('filters candidates by available set', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'coding_session_control', operation: 'inspect' }),
      [...ALL_CANDIDATES],
      ['filesystem', 'browser'], // coding_session_control is not available
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayHeuristicFallback).toBe(false);
  });
});
