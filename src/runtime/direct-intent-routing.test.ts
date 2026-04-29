import { describe, expect, it } from 'vitest';
import type { IntentGatewayRecord } from './intent-gateway.js';
import {
  resolveDirectIntentRoutingCandidates,
  shouldAllowBoundedDegradedMemorySaveFallback,
} from './direct-intent-routing.js';

function mockGateway(partial: {
  route: string;
  operation?: string;
  confidence?: string;
  turnRelation?: string;
  entities?: Record<string, unknown>;
  available?: boolean;
  plannedSteps?: IntentGatewayRecord['decision']['plannedSteps'];
}): IntentGatewayRecord {
  return {
    mode: 'primary',
    available: partial.available ?? true,
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
      ...(partial.plannedSteps ? { plannedSteps: partial.plannedSteps } : {}),
      entities: (partial.entities ?? {}) as IntentGatewayRecord['decision']['entities'],
    },
  };
}

const ALL_CANDIDATES = [
  'personal_assistant',
  'provider_read',
  'coding_session_control',
  'coding_backend',
  'filesystem',
  'memory_write',
  'memory_read',
  'scheduled_email_automation',
  'automation',
  'automation_control',
  'automation_output',
  'workspace_write',
  'workspace_read',
  'browser',
  'web_search',
] as const;

function assertNoAutomationControlForToolLikeCloudRequest() {
  const result = resolveDirectIntentRoutingCandidates(
    mockGateway({
      route: 'general_assistant',
      operation: 'run',
      entities: { toolName: 'whm_status', profileId: 'social' },
    }),
    [...ALL_CANDIDATES],
  );
  expect(result.candidates).not.toContain('automation_control');
}

describe('resolveDirectIntentRoutingCandidates', () => {
  it('maps create-style automation authoring routes to automation candidates', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'automation_authoring', operation: 'create' }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['scheduled_email_automation', 'automation']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('does not map exploratory automation authoring routes with unknown operation to direct automation candidates', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'automation_authoring', operation: 'unknown' }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
  });

  it('maps coding_session_control route to coding_session_control candidate', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'coding_session_control', operation: 'navigate' }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['coding_session_control']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('maps coding_task route with an explicitly requested coding backend to coding_backend candidate', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({
        route: 'coding_task',
        operation: 'run',
        entities: { codingBackend: 'codex', codingBackendRequested: true },
      }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['coding_backend']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('does not map coding_task route to coding_backend when the backend is only mentioned as the subject', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({
        route: 'coding_task',
        operation: 'inspect',
        entities: { codingBackend: 'codex', codingBackendRequested: false },
      }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
  });

  it('maps coding_task route without explicit coding backend to no direct candidates', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'coding_task', operation: 'create' }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
  });

  it('maps coding_task search requests to the filesystem candidate when no coding backend was explicitly requested', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'coding_task', operation: 'search' }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['filesystem']);
    expect(result.gatewayDirected).toBe(true);
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
    );
    expect(result.candidates).toEqual(['coding_backend']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('does not map generic coding inspect follow-ups to coding_backend without status-check metadata', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'coding_task', operation: 'inspect', turnRelation: 'follow_up' }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
  });

  it('keeps email_task on workspace candidates so provider-aware direct handlers can dispatch mailbox reads', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'email_task', operation: 'read', entities: { emailProvider: 'm365' } }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['workspace_read', 'workspace_write']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('maps personal_assistant_task routes to the personal_assistant candidate', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'personal_assistant_task', operation: 'read', entities: { personalItemType: 'task' } }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['personal_assistant']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('keeps unknown-operation memory routes on memory handlers so direct parsing can disambiguate read vs write', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'memory_task', operation: 'unknown' }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['memory_read', 'memory_write']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('defers automation catalog plus answer plans to the worker synthesis path', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({
        route: 'automation_control',
        operation: 'read',
        plannedSteps: [
          {
            kind: 'read',
            summary: 'List matching automations.',
            expectedToolCategories: ['automation_list'],
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Suggest one useful automation.',
            required: true,
            dependsOn: ['step_1'],
          },
        ],
      }),
      [...ALL_CANDIDATES],
    );

    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
  });

  it('keeps concrete automation catalog reads on the direct control candidate when an answer step only formats the catalog', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({
        route: 'automation_control',
        operation: 'read',
        entities: { automationReadView: 'catalog' },
        plannedSteps: [
          {
            kind: 'read',
            summary: 'List saved automations.',
            expectedToolCategories: ['automation_list'],
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Return the automation names and enabled status.',
            required: true,
            dependsOn: ['step_1'],
          },
        ],
      }),
      [...ALL_CANDIDATES],
    );

    expect(result.candidates).toEqual(['automation_control']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('keeps answer-only repaired automation-control reads on the direct control candidate', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({
        route: 'automation_control',
        operation: 'read',
        confidence: 'low',
        plannedSteps: [
          {
            kind: 'answer',
            summary: 'List how many automations are currently configured.',
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Reply in one short sentence and do not mutate anything.',
            required: true,
          },
        ],
      }),
      [...ALL_CANDIDATES],
    );

    expect(result.candidates).toEqual(['automation_control']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('does not direct-dispatch multi-step personal plans that include other domains', () => {
    const gateway = mockGateway({
      route: 'personal_assistant_task',
      operation: 'create',
      entities: { personalItemType: 'note' },
    });
    gateway.decision.plannedSteps = [
      {
        kind: 'write',
        summary: 'Create a Second Brain note.',
        expectedToolCategories: ['second_brain_note_upsert'],
        required: true,
      },
      {
        kind: 'write',
        summary: 'Create an automation reminder.',
        expectedToolCategories: ['automation_save'],
        required: true,
      },
    ];
    const result = resolveDirectIntentRoutingCandidates(
      gateway,
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
  });

  it('does not direct-dispatch automation plans that include repo or cloud/security tooling', () => {
    const gateway = mockGateway({ route: 'automation_authoring', operation: 'create' });
    gateway.decision.plannedSteps = [
      {
        kind: 'write',
        summary: 'Create the automation.',
        expectedToolCategories: ['automation_save'],
        required: true,
      },
      {
        kind: 'search',
        summary: 'Inspect the repo.',
        expectedToolCategories: ['fs_search'],
        required: true,
      },
      {
        kind: 'tool_call',
        summary: 'Check hosting status.',
        expectedToolCategories: ['whm_status'],
        required: true,
      },
      {
        kind: 'tool_call',
        summary: 'Inspect assistant security posture.',
        expectedToolCategories: ['assistant_security_summary'],
        required: true,
      },
    ];
    const result = resolveDirectIntentRoutingCandidates(
      gateway,
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
  });

  it('defers browser read plus answer plans to the worker synthesis path', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({
        route: 'browser_task',
        operation: 'read',
        plannedSteps: [
          {
            kind: 'read',
            summary: 'Read the page with the browser.',
            expectedToolCategories: ['browser_read'],
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Answer with the page title only.',
            required: true,
            dependsOn: ['step_1'],
          },
        ],
      }),
      [...ALL_CANDIDATES],
    );

    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
  });

  it('defers multi-domain search plans instead of dispatching only direct web search', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({
        route: 'search_task',
        operation: 'search',
        plannedSteps: [
          {
            kind: 'search',
            summary: 'Search the web for the page title.',
            expectedToolCategories: ['web_search', 'browser'],
            required: true,
          },
          {
            kind: 'search',
            summary: 'Search the repo for the implementation.',
            expectedToolCategories: ['repo_inspect'],
            required: true,
            dependsOn: ['step_1'],
          },
          {
            kind: 'read',
            summary: 'Search memory for the marker.',
            expectedToolCategories: ['memory'],
            required: true,
            dependsOn: ['step_2'],
          },
          {
            kind: 'answer',
            summary: 'Return a three-source comparison.',
            required: true,
            dependsOn: ['step_1', 'step_2', 'step_3'],
          },
        ],
      }),
      [...ALL_CANDIDATES],
    );

    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
  });

  it('keeps browser-only action plans on the direct browser candidate', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({
        route: 'browser_task',
        operation: 'read',
        plannedSteps: [
          {
            kind: 'read',
            summary: 'Read the page with the browser.',
            expectedToolCategories: ['browser_read'],
            required: true,
          },
        ],
      }),
      [...ALL_CANDIDATES],
    );

    expect(result.candidates).toEqual(['browser']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('maps memory_task save requests to the memory_write candidate', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'memory_task', operation: 'save' }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['memory_write']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('keeps degraded structured memory_task save routes on the memory_write candidate', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'memory_task', operation: 'save', available: false }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['memory_write']);
    expect(result.gatewayDirected).toBe(true);
    expect(result.gatewayUnavailable).toBe(false);
  });

  it('maps memory_task read requests to the memory_read candidate', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'memory_task', operation: 'read' }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['memory_read']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('maps memory_task search requests to the memory_read candidate', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'memory_task', operation: 'search' }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['memory_read']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('maps high-confidence general_assistant route to no candidates', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'general_assistant', operation: 'unknown' }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(true);
    expect(result.gatewayUnavailable).toBe(false);
  });

  it('maps provider CRUD general-assistant reads to the provider_read candidate', () => {
    const gateway = mockGateway({ route: 'general_assistant', operation: 'read' });
    gateway.decision.executionClass = 'provider_crud';
    const result = resolveDirectIntentRoutingCandidates(
      gateway,
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual(['provider_read']);
    expect(result.gatewayDirected).toBe(true);
  });

  it('returns no direct candidates when the gateway is unavailable', () => {
    const result = resolveDirectIntentRoutingCandidates(
      null,
      [...ALL_CANDIDATES],
    );
    expect(result.gatewayUnavailable).toBe(true);
    expect(result.gatewayDirected).toBe(false);
    expect(result.candidates).toEqual([]);
  });

  it('returns no direct candidates when the gateway returns low-confidence unknown', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'unknown', operation: 'unknown', confidence: 'low' }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(false);
    expect(result.gatewayUnavailable).toBe(false);
  });

  it('returns no direct candidates when the gateway returns low-confidence general_assistant', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'general_assistant', operation: 'unknown', confidence: 'low' }),
      [...ALL_CANDIDATES],
    );
    expect(result.candidates).toEqual([]);
    expect(result.gatewayDirected).toBe(false);
    expect(result.gatewayUnavailable).toBe(false);
  });

  it('does not reinterpret explicit tool-like cloud requests as automation control', () => {
    assertNoAutomationControlForToolLikeCloudRequest();
  });

  it('filters candidates by available set', () => {
    const result = resolveDirectIntentRoutingCandidates(
      mockGateway({ route: 'coding_session_control', operation: 'inspect' }),
      ['filesystem', 'browser'], // coding_session_control is not available
    );
    expect(result.candidates).toEqual([]);
  });
});

describe('shouldAllowBoundedDegradedMemorySaveFallback', () => {
  it('allows the bounded fallback when the gateway is unavailable', () => {
    expect(shouldAllowBoundedDegradedMemorySaveFallback(null)).toBe(true);
  });

  it('allows the bounded fallback for unavailable unknown results', () => {
    expect(shouldAllowBoundedDegradedMemorySaveFallback({
      mode: 'primary',
      available: false,
      model: 'test-model',
      latencyMs: 10,
      decision: {
        route: 'unknown',
        confidence: 'low',
        operation: 'unknown',
        summary: 'Intent gateway response was not structured.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: {},
      },
    })).toBe(true);
  });

  it('does not allow the bounded fallback for low-confidence general_assistant results', () => {
    expect(shouldAllowBoundedDegradedMemorySaveFallback(
      mockGateway({ route: 'general_assistant', operation: 'unknown', confidence: 'low' }),
    )).toBe(false);
  });

  it('does not allow the bounded fallback for ordinary structured memory routing', () => {
    expect(shouldAllowBoundedDegradedMemorySaveFallback(
      mockGateway({ route: 'memory_task', operation: 'save' }),
    )).toBe(false);
  });
});
