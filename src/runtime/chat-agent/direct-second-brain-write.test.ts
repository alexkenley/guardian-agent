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
import { executeDirectSecondBrainMutation } from './direct-second-brain-mutation.js';
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

describe('executeDirectSecondBrainMutation approvals', () => {
  it('returns structured approval copy without inline approval ids', async () => {
    const setPendingApprovalActionForRequest = vi.fn(() => ({ action: null }));
    const buildPendingApprovalBlockedResponse = vi.fn((_result, fallbackContent: string) => ({ content: fallbackContent }));
    const result = await executeDirectSecondBrainMutation({
      message: {
        ...messageBase,
        content: 'Create an appointment for tomorrow at noon to take Benny to the vet.',
        surfaceId: 'web-chat',
      },
      ctx: { checkAction: vi.fn() } as unknown as AgentContext,
      userKey: 'owner:web',
      decision: createDecision('calendar'),
      toolName: 'second_brain_calendar_upsert',
      args: {
        title: 'Take Benny to the vet',
        startsAt: 1_700_086_400_000,
        endsAt: 1_700_090_000_000,
      },
      summary: 'Creates a local Second Brain calendar event.',
      pendingIntro: 'I prepared a local calendar event create, but it needs approval first.',
      successDescriptor: {
        itemType: 'calendar',
        action: 'create',
        fallbackLabel: 'Take Benny to the vet',
      },
      focusState: null,
      agentId: 'chat',
      tools: {
        isEnabled: vi.fn(() => true),
        executeModelTool: vi.fn(async () => ({
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-calendar-1',
        })),
        getApprovalSummaries: vi.fn(() => new Map([
          ['approval-calendar-1', {
            toolName: 'second_brain_calendar_upsert',
            argsPreview: '{"title":"Take Benny to the vet","startsAt":1700086400000,"endsAt":1700090000000}',
            actionLabel: 'create local calendar event "Take Benny to the vet" tomorrow at noon',
          }],
        ])),
      } as never,
      getPendingApprovals: vi.fn(() => null),
      setApprovalFollowUp: vi.fn(),
      formatPendingApprovalPrompt: vi.fn(() => 'Approval ID: approval-calendar-1'),
      setPendingApprovalActionForRequest,
      buildPendingApprovalBlockedResponse,
      toPendingActionEntities: (entities) => entities as Record<string, unknown>,
      buildDirectSecondBrainMutationSuccessResponse: vi.fn(() => ({ content: 'created' })),
    });

    expect(result).toMatchObject({
      content: expect.stringContaining('Waiting for approval to create local calendar event "Take Benny to the vet" tomorrow at noon.'),
    });
    expect(typeof result === 'string' ? result : result.content).not.toContain('Approval ID:');
    expect(setPendingApprovalActionForRequest).toHaveBeenCalledWith(
      'owner:web',
      'web-chat',
      expect.objectContaining({
        prompt: 'Waiting for approval to create local calendar event "Take Benny to the vet" tomorrow at noon.',
        approvalIds: ['approval-calendar-1'],
      }),
    );
  });
});
