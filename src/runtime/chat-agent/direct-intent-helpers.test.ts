import { describe, expect, it } from 'vitest';

import type { ContinuityThreadRecord } from '../continuity-threads.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import {
  buildSecondBrainFocusMetadata,
  buildToolSafeRoutineTrigger,
  extractCustomSecondBrainRoutineCreate,
  extractRoutineScheduleTiming,
  extractSecondBrainFallbackPersonName,
  readSecondBrainFocusContinuationState,
  resolveDirectSecondBrainReadQuery,
} from './direct-intent-helpers.js';

function continuityRecord(continuationState: Record<string, unknown>): ContinuityThreadRecord {
  return {
    continuityKey: 'assistant:user-1',
    scope: {
      assistantId: 'assistant',
      userId: 'user-1',
    },
    linkedSurfaces: [],
    continuationState: continuationState as ContinuityThreadRecord['continuationState'],
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
  };
}

function gatewayDecision(overrides: Partial<IntentGatewayDecision> = {}): IntentGatewayDecision {
  return {
    route: 'personal_assistant',
    confidence: 'high',
    operation: 'read',
    summary: 'Read from Second Brain.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'tool_orchestration',
    preferredTier: 'local',
    requiresRepoGrounding: false,
    requiresToolSynthesis: false,
    expectedContextPressure: 'low',
    preferredAnswerPath: 'direct',
    entities: {},
    ...overrides,
  };
}

describe('direct intent chat helpers', () => {
  it('round-trips second-brain focus continuation metadata', () => {
    const metadata = buildSecondBrainFocusMetadata(null, 'routine', [
      { id: 'routine-1', label: 'Daily review' },
      { id: 'routine-2', label: 'Weekly review' },
    ], { preferredFocusId: 'routine-2' });

    expect(metadata?.continuationState).toMatchObject({
      kind: 'second_brain_focus',
      payload: {
        activeItemType: 'routine',
        focusId: 'routine-2',
      },
    });

    const state = readSecondBrainFocusContinuationState(continuityRecord(metadata?.continuationState as Record<string, unknown>));
    expect(state?.activeItemType).toBe('routine');
    expect(state?.byType.routine?.focusId).toBe('routine-2');
    expect(state?.byType.routine?.items).toHaveLength(2);
  });

  it('extracts routine creation details without chat-agent state', () => {
    expect(extractCustomSecondBrainRoutineCreate('Watch for "budget review" mentions')).toEqual({
      templateId: 'topic-watch',
      config: { topicQuery: 'budget review' },
    });

    expect(extractRoutineScheduleTiming('weekly on Tuesday at 9:30 am')).toEqual({
      kind: 'scheduled',
      schedule: {
        cadence: 'weekly',
        dayOfWeek: 'tuesday',
        time: '09:30',
      },
    });
  });

  it('keeps direct read and routine trigger parsing module-local', () => {
    expect(extractSecondBrainFallbackPersonName('Add a person in my second brain Ada Lovelace with email ada@example.com')).toBe('Ada Lovelace');
    expect(resolveDirectSecondBrainReadQuery(
      'show me the person Ada Lovelace',
      'person',
      gatewayDecision(),
    )).toEqual({ query: 'Ada Lovelace', exactMatch: true });

    expect(buildToolSafeRoutineTrigger(
      { mode: 'event', eventType: 'upcoming', lookaheadMinutes: 30 },
      null,
    )).toEqual({
      mode: 'event',
      eventType: 'upcoming_event',
      lookaheadMinutes: 30,
    });
  });
});
