import { describe, expect, it } from 'vitest';
import { resolveIntentCapabilityCandidates } from './capability-resolver.js';
import type { IntentGatewayDecision } from './types.js';

function mockDecision(partial: Partial<IntentGatewayDecision> & Pick<IntentGatewayDecision, 'route'>): IntentGatewayDecision {
  return {
    route: partial.route,
    confidence: partial.confidence ?? 'high',
    operation: partial.operation ?? 'unknown',
    summary: partial.summary ?? 'test',
    turnRelation: partial.turnRelation ?? 'new_request',
    resolution: partial.resolution ?? 'ready',
    missingFields: partial.missingFields ?? [],
    executionClass: partial.executionClass ?? 'direct_assistant',
    preferredTier: partial.preferredTier ?? 'local',
    requiresRepoGrounding: partial.requiresRepoGrounding ?? false,
    requiresToolSynthesis: partial.requiresToolSynthesis ?? false,
    expectedContextPressure: partial.expectedContextPressure ?? 'low',
    preferredAnswerPath: partial.preferredAnswerPath ?? 'direct',
    entities: partial.entities ?? {},
    ...(partial.resolvedContent ? { resolvedContent: partial.resolvedContent } : {}),
  };
}

describe('resolveIntentCapabilityCandidates', () => {
  it('maps automation authoring create requests to automation candidates', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({ route: 'automation_authoring', operation: 'create' }),
    )).toEqual(['scheduled_email_automation', 'automation']);
  });

  it('maps provider-crud general assistant requests to provider_read', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'general_assistant',
        operation: 'read',
        executionClass: 'provider_crud',
        preferredTier: 'external',
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
      }),
    )).toEqual(['provider_read']);
  });

  it('maps coding backend requests to coding_backend', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'coding_task',
        operation: 'run',
        executionClass: 'repo_grounded',
        preferredTier: 'local',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'tool_loop',
        entities: { codingBackend: 'codex', codingBackendRequested: true },
      }),
    )).toEqual(['coding_backend']);
  });

  it('maps coding search requests to filesystem', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'coding_task',
        operation: 'search',
        executionClass: 'repo_grounded',
        preferredTier: 'external',
        requiresRepoGrounding: true,
        expectedContextPressure: 'medium',
      }),
    )).toEqual(['filesystem']);
  });

  it('maps email drafts to write-first workspace candidates', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'email_task',
        operation: 'draft',
        executionClass: 'provider_crud',
        preferredTier: 'external',
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'tool_loop',
      }),
    )).toEqual(['workspace_write', 'workspace_read']);
  });
});
