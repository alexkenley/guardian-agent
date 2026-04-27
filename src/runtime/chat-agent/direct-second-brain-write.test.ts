import { describe, expect, it, vi } from 'vitest';

import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import {
  collapseWhitespaceForSecondBrainParsing,
  extractEmailAddressFromText,
  extractExplicitNamedSecondBrainTitle,
  extractNamedSecondBrainTitle,
  extractPhoneNumberFromText,
  extractQuotedLabeledValue,
  extractRetitledSecondBrainTitle,
  extractSecondBrainFallbackPersonName,
  extractSecondBrainPersonRelationship,
  extractSecondBrainTags,
  extractSecondBrainTaskPriority,
  extractSecondBrainTaskStatus,
  extractSecondBrainTextBody,
  extractUrlFromText,
  normalizeSecondBrainInlineFieldValue,
} from './direct-intent-helpers.js';
import { tryDirectSecondBrainWrite } from './direct-second-brain-write.js';

const messageBase: UserMessage = {
  id: 'message-1',
  userId: 'owner',
  channel: 'web',
  content: '',
  timestamp: 1_700_000_000_000,
};

function createDecision(itemType: 'calendar' | 'task'): IntentGatewayDecision {
  return {
    route: 'personal_assistant_task',
    confidence: 'high',
    operation: 'create',
    summary: itemType === 'calendar' ? 'Create a local calendar event.' : 'Create a local task.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'personal_assistant',
    preferredTier: 'local',
    requiresRepoGrounding: false,
    requiresToolSynthesis: false,
    expectedContextPressure: 'low',
    preferredAnswerPath: 'direct',
    entities: { personalItemType: itemType },
  } as IntentGatewayDecision;
}

function buildCreateInput(content: string, itemType: 'calendar' | 'task' = 'calendar') {
  return {
    secondBrainService: {
      getEventById: vi.fn(() => null),
      getTaskById: vi.fn(() => null),
    },
    message: { ...messageBase, content },
    ctx: { checkAction: vi.fn() } as unknown as AgentContext,
    userKey: 'owner:web',
    decision: createDecision(itemType),
    resolvedItemType: itemType,
    focusState: null,
    getFocusEntry: vi.fn(() => null),
    normalizeInlineFieldValue: normalizeSecondBrainInlineFieldValue,
    extractQuotedLabeledValue,
    extractExplicitNamedTitle: extractExplicitNamedSecondBrainTitle,
    extractNamedTitle: extractNamedSecondBrainTitle,
    extractRetitledTitle: extractRetitledSecondBrainTitle,
    extractTextBody: extractSecondBrainTextBody,
    extractTags: extractSecondBrainTags,
    collapseWhitespace: collapseWhitespaceForSecondBrainParsing,
    extractTaskPriority: extractSecondBrainTaskPriority,
    extractTaskStatus: extractSecondBrainTaskStatus,
    extractUrlFromText,
    extractFallbackPersonName: extractSecondBrainFallbackPersonName,
    extractEmailAddress: extractEmailAddressFromText,
    extractPhoneNumber: extractPhoneNumberFromText,
    extractPersonRelationship: extractSecondBrainPersonRelationship,
    buildClarificationResponse: vi.fn(() => ({ content: 'clarify' })),
    executeMutation: vi.fn(async () => ({ content: 'created' })),
  };
}

describe('tryDirectSecondBrainWrite calendar creation', () => {
  it('infers an appointment title from natural purpose wording', async () => {
    const input = buildCreateInput(
      'Create an appointment for me for tomorrow at 12:00 p.m. to take my dog Benny to the vet',
    );

    await tryDirectSecondBrainWrite(input);

    expect(input.executeMutation).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'second_brain_calendar_upsert',
      args: expect.objectContaining({
        title: 'Take my dog Benny to the vet',
      }),
      successDescriptor: expect.objectContaining({
        fallbackLabel: 'Take my dog Benny to the vet',
      }),
    }));
  });

  it('infers a title from a for-purpose phrase without treating the date as the title', async () => {
    const input = buildCreateInput(
      "Add a calendar entry for tomorrow at 12 pm for a doctor's appointment at Narangba doctor's surgery.",
    );

    await tryDirectSecondBrainWrite(input);

    expect(input.executeMutation).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.objectContaining({
        title: "Doctor's appointment",
      }),
    }));
  });
});

describe('tryDirectSecondBrainWrite task creation', () => {
  it('infers a task title from natural task-purpose wording', async () => {
    const input = buildCreateInput(
      'Create a local task to call the vet about Benny tomorrow at 5 p.m.',
      'task',
    );

    await tryDirectSecondBrainWrite(input);

    expect(input.executeMutation).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'second_brain_task_upsert',
      args: expect.objectContaining({
        title: 'Call the vet about Benny',
      }),
      successDescriptor: expect.objectContaining({
        fallbackLabel: 'Call the vet about Benny',
      }),
    }));
  });
});
