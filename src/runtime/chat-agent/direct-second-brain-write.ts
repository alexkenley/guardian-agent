import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { SecondBrainService } from '../second-brain/second-brain-service.js';
import { normalizeSecondBrainMutationArgs } from '../second-brain/chat-mutation-normalization.js';
import type {
  DirectSecondBrainMutationItemType,
  DirectSecondBrainMutationToolName,
} from './direct-second-brain-mutation.js';

export interface SecondBrainWriteFocusItem {
  id: string;
  label?: string;
}

export interface SecondBrainWriteFocusEntry {
  focusId?: string;
  items: SecondBrainWriteFocusItem[];
}

type SecondBrainWriteResponse = string | { content: string; metadata?: Record<string, unknown> } | null;

interface DirectSecondBrainClarificationBuilder {
  (
    input: {
      message: UserMessage;
      decision: IntentGatewayDecision;
      prompt: string;
      field?: string;
      missingFields?: string[];
      entities?: Record<string, unknown>;
    }
  ): { content: string; metadata?: Record<string, unknown> };
}

interface DirectSecondBrainMutationExecutor<TFocusState> {
  (
    input: {
      message: UserMessage;
      ctx: AgentContext;
      userKey: string;
      decision: IntentGatewayDecision;
      toolName: DirectSecondBrainMutationToolName;
      args: Record<string, unknown>;
      summary: string;
      pendingIntro: string;
      successDescriptor: {
        itemType: DirectSecondBrainMutationItemType;
        action: 'create' | 'update' | 'delete' | 'complete';
        fallbackId?: string;
        fallbackLabel?: string;
      };
      focusState: TFocusState | null | undefined;
    }
  ): Promise<string | { content: string; metadata?: Record<string, unknown> }>;
}

export async function tryDirectSecondBrainWrite<TFocusState>(input: {
  secondBrainService?: Pick<
    SecondBrainService,
    'getEventById' | 'getLinkById' | 'getPersonById' | 'getTaskById'
  > | null;
  message: UserMessage;
  ctx: AgentContext;
  userKey: string;
  decision: IntentGatewayDecision;
  resolvedItemType: string;
  focusState: TFocusState | null | undefined;
  getFocusEntry: (
    focusState: TFocusState | null | undefined,
    itemType: DirectSecondBrainMutationItemType,
  ) => SecondBrainWriteFocusEntry | null;
  normalizeInlineFieldValue: (value: string) => string;
  extractQuotedLabeledValue: (text: string, labels: string[]) => string;
  extractExplicitNamedTitle: (text: string) => string;
  extractNamedTitle: (text: string) => string;
  extractRetitledTitle: (text: string) => string;
  extractTextBody: (text: string) => string;
  collapseWhitespace: (text: string) => string;
  extractTaskPriority: (text: string) => 'low' | 'medium' | 'high' | undefined;
  extractTaskStatus: (text: string) => 'todo' | 'in_progress' | 'done' | undefined;
  extractUrlFromText: (text: string) => string;
  extractFallbackPersonName: (text: string) => string;
  extractEmailAddress: (text: string) => string;
  extractPhoneNumber: (text: string) => string;
  extractPersonRelationship: (
    text: string,
  ) => 'work' | 'personal' | 'family' | 'vendor' | 'other' | undefined;
  buildClarificationResponse: DirectSecondBrainClarificationBuilder;
  executeMutation: DirectSecondBrainMutationExecutor<TFocusState>;
}): Promise<SecondBrainWriteResponse> {
  const requestText = input.message.content;

  switch (input.resolvedItemType) {
    case 'note': {
      const explicitTitle = input.normalizeInlineFieldValue(
        input.extractQuotedLabeledValue(requestText, ['title']) || input.extractExplicitNamedTitle(requestText),
      );
      const explicitContent = input.extractQuotedLabeledValue(requestText, ['content']);
      const content = explicitContent || input.extractTextBody(requestText);
      const noteFocus = input.getFocusEntry(input.focusState, 'note');
      const focusItem = noteFocus
        ? noteFocus.items.find((item) => item.id === noteFocus.focusId) ?? null
        : null;

      switch (input.decision.operation) {
        case 'create':
        case 'save':
          if (!content) {
            return 'To save a local note, I need the note content.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_note_upsert',
            args: {
              ...(explicitTitle ? { title: explicitTitle } : {}),
              content,
            },
            summary: 'Creates a local Second Brain note.',
            pendingIntro: 'I prepared a local note save, but it needs approval first.',
            successDescriptor: {
              itemType: 'note',
              action: 'create',
            },
            focusState: input.focusState,
          });
        case 'update':
          if (!focusItem) {
            return 'I need to know which local note to update. Try "Show my notes." first.';
          }
          if (!content) {
            return 'To update that local note, I need the new note content.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_note_upsert',
            args: {
              id: focusItem.id,
              ...(explicitTitle || focusItem.label ? { title: explicitTitle || focusItem.label } : {}),
              content,
            },
            summary: 'Updates a local Second Brain note.',
            pendingIntro: 'I prepared a local note update, but it needs approval first.',
            successDescriptor: {
              itemType: 'note',
              action: 'update',
              fallbackId: focusItem.id,
              fallbackLabel: focusItem.label,
            },
            focusState: input.focusState,
          });
        case 'delete':
          if (!focusItem) {
            return 'I need to know which local note to delete. Try "Show my notes." first.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_note_delete',
            args: { id: focusItem.id },
            summary: 'Deletes a local Second Brain note.',
            pendingIntro: 'I prepared a local note delete, but it needs approval first.',
            successDescriptor: {
              itemType: 'note',
              action: 'delete',
              fallbackId: focusItem.id,
              fallbackLabel: focusItem.label,
            },
            focusState: input.focusState,
          });
        default:
          return null;
      }
    }
    case 'task': {
      if (!input.secondBrainService) return null;
      const taskFocus = input.getFocusEntry(input.focusState, 'task');
      const focusItem = taskFocus
        ? taskFocus.items.find((item) => item.id === taskFocus.focusId) ?? null
        : null;

      switch (input.decision.operation) {
        case 'create': {
          const title = input.extractNamedTitle(requestText);
          if (!title) {
            return 'To create a local task, I need the task title.';
          }
          const args = normalizeSecondBrainMutationArgs({
            toolName: 'second_brain_task_upsert',
            args: { title },
            userContent: requestText,
            referenceTime: Date.now(),
            getTaskById: (id) => input.secondBrainService?.getTaskById(id) ?? null,
          });
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_task_upsert',
            args,
            summary: 'Creates a local Second Brain task.',
            pendingIntro: 'I prepared a local task create, but it needs approval first.',
            successDescriptor: {
              itemType: 'task',
              action: 'create',
              fallbackLabel: title,
            },
            focusState: input.focusState,
          });
        }
        case 'update': {
          if (!focusItem) {
            return 'I need to know which local task to update. Try "Show my tasks." first.';
          }
          const existingTask = input.secondBrainService.getTaskById(focusItem.id);
          if (!existingTask) {
            return `Local task "${focusItem.label ?? focusItem.id}" was not found.`;
          }
          const explicitTitle = input.extractRetitledTitle(requestText)
            || input.normalizeInlineFieldValue(input.extractQuotedLabeledValue(requestText, ['title', 'task title']));
          const explicitDetails = input.collapseWhitespace(
            input.extractQuotedLabeledValue(requestText, ['details', 'detail', 'notes', 'note', 'description']),
          );
          const explicitPriority = input.extractTaskPriority(requestText);
          const nextStatus = input.extractTaskStatus(requestText) ?? existingTask.status;
          const args = normalizeSecondBrainMutationArgs({
            toolName: 'second_brain_task_upsert',
            args: {
              id: existingTask.id,
              title: explicitTitle || existingTask.title,
              ...(explicitDetails || existingTask.details ? { details: explicitDetails || existingTask.details } : {}),
              status: nextStatus,
              priority: explicitPriority || existingTask.priority,
              ...(existingTask.dueAt != null ? { dueAt: existingTask.dueAt } : {}),
            },
            userContent: requestText,
            referenceTime: Date.now(),
            getTaskById: (id) => input.secondBrainService?.getTaskById(id) ?? null,
          });
          const existingDueAt = typeof existingTask.dueAt === 'number' ? existingTask.dueAt : undefined;
          const nextDueAt = typeof args.dueAt === 'number' ? args.dueAt : undefined;
          const isCompletion = nextStatus === 'done' && existingTask.status !== 'done';
          const hasExplicitChange = Boolean(
            explicitTitle
            || explicitDetails
            || explicitPriority
            || nextStatus !== existingTask.status
            || nextDueAt !== existingDueAt,
          );
          if (!hasExplicitChange) {
            return 'To update that local task, tell me the new title, details, priority, status, or due date.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_task_upsert',
            args,
            summary: isCompletion
              ? 'Marks a local Second Brain task as done.'
              : 'Updates a local Second Brain task.',
            pendingIntro: isCompletion
              ? 'I prepared a local task completion, but it needs approval first.'
              : 'I prepared a local task update, but it needs approval first.',
            successDescriptor: {
              itemType: 'task',
              action: isCompletion ? 'complete' : 'update',
              fallbackId: existingTask.id,
              fallbackLabel: existingTask.title,
            },
            focusState: input.focusState,
          });
        }
        case 'delete':
          if (!focusItem) {
            return 'I need to know which local task to delete. Try "Show my tasks." first.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_task_delete',
            args: { id: focusItem.id },
            summary: 'Deletes a local Second Brain task.',
            pendingIntro: 'I prepared a local task delete, but it needs approval first.',
            successDescriptor: {
              itemType: 'task',
              action: 'delete',
              fallbackId: focusItem.id,
              fallbackLabel: focusItem.label,
            },
            focusState: input.focusState,
          });
        default:
          return null;
      }
    }
    case 'calendar': {
      if (!input.secondBrainService) return null;
      const calendarFocus = input.getFocusEntry(input.focusState, 'calendar');
      const focusItem = calendarFocus
        ? calendarFocus.items.find((item) => item.id === calendarFocus.focusId) ?? null
        : null;

      switch (input.decision.operation) {
        case 'create': {
          const title = input.extractNamedTitle(requestText);
          if (!title) {
            return 'To create a local calendar event, I need the event title.';
          }
          const args = normalizeSecondBrainMutationArgs({
            toolName: 'second_brain_calendar_upsert',
            args: {
              title,
              startsAt: Date.now(),
            },
            userContent: requestText,
            referenceTime: Date.now(),
            getEventById: (id) => input.secondBrainService?.getEventById(id) ?? null,
          });
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_calendar_upsert',
            args,
            summary: 'Creates a local Second Brain calendar event.',
            pendingIntro: 'I prepared a local calendar event create, but it needs approval first.',
            successDescriptor: {
              itemType: 'calendar',
              action: 'create',
              fallbackLabel: title,
            },
            focusState: input.focusState,
          });
        }
        case 'update': {
          if (!focusItem) {
            return 'I need to know which local calendar event to update. Try "Show my calendar events." first.';
          }
          const existingEvent = input.secondBrainService.getEventById(focusItem.id);
          if (!existingEvent) {
            return `Local calendar event "${focusItem.label ?? focusItem.id}" was not found.`;
          }
          const args = normalizeSecondBrainMutationArgs({
            toolName: 'second_brain_calendar_upsert',
            args: {
              id: existingEvent.id,
              title: existingEvent.title,
              startsAt: existingEvent.startsAt,
              ...(existingEvent.endsAt != null ? { endsAt: existingEvent.endsAt } : {}),
              ...(existingEvent.location ? { location: existingEvent.location } : {}),
              ...(existingEvent.description ? { description: existingEvent.description } : {}),
            },
            userContent: requestText,
            referenceTime: Date.now(),
            getEventById: (id) => input.secondBrainService?.getEventById(id) ?? null,
          });
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_calendar_upsert',
            args,
            summary: 'Updates a local Second Brain calendar event.',
            pendingIntro: 'I prepared a local calendar event update, but it needs approval first.',
            successDescriptor: {
              itemType: 'calendar',
              action: 'update',
              fallbackId: existingEvent.id,
              fallbackLabel: existingEvent.title,
            },
            focusState: input.focusState,
          });
        }
        case 'delete':
          if (!focusItem) {
            return 'I need to know which local calendar event to delete. Try "Show my calendar events." first.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_calendar_delete',
            args: { id: focusItem.id },
            summary: 'Deletes a local Second Brain calendar event.',
            pendingIntro: 'I prepared a local calendar event delete, but it needs approval first.',
            successDescriptor: {
              itemType: 'calendar',
              action: 'delete',
              fallbackId: focusItem.id,
              fallbackLabel: focusItem.label,
            },
            focusState: input.focusState,
          });
        default:
          return null;
      }
    }
    case 'library': {
      if (!input.secondBrainService) return null;
      const libraryFocus = input.getFocusEntry(input.focusState, 'library');
      const focusItem = libraryFocus
        ? libraryFocus.items.find((item) => item.id === libraryFocus.focusId) ?? null
        : null;
      const explicitTitle = input.normalizeInlineFieldValue(input.extractQuotedLabeledValue(requestText, ['title']));
      const explicitUrl = input.extractUrlFromText(requestText);
      const explicitSummary = input.collapseWhitespace(
        input.extractQuotedLabeledValue(requestText, ['notes', 'note', 'summary', 'description']),
      );

      switch (input.decision.operation) {
        case 'create':
        case 'save':
          if (!explicitUrl) {
            return 'To save a local library item, I need the URL.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_library_upsert',
            args: {
              url: explicitUrl,
              ...(explicitTitle ? { title: explicitTitle } : {}),
              ...(explicitSummary ? { summary: explicitSummary } : {}),
            },
            summary: 'Creates a local Second Brain library item.',
            pendingIntro: 'I prepared a local library item save, but it needs approval first.',
            successDescriptor: {
              itemType: 'library',
              action: 'create',
              fallbackLabel: explicitTitle || explicitUrl,
            },
            focusState: input.focusState,
          });
        case 'update': {
          if (!focusItem) {
            return 'I need to know which local library item to update. Try "Show my library items." first.';
          }
          const existingLink = input.secondBrainService.getLinkById(focusItem.id);
          if (!existingLink) {
            return `Local library item "${focusItem.label ?? focusItem.id}" was not found.`;
          }
          if (!explicitTitle && !explicitUrl && !explicitSummary) {
            return 'To update that local library item, tell me the new title, URL, or notes.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_library_upsert',
            args: {
              id: existingLink.id,
              title: explicitTitle || existingLink.title,
              url: explicitUrl || existingLink.url,
              ...(explicitSummary || existingLink.summary ? { summary: explicitSummary || existingLink.summary } : {}),
              ...(existingLink.kind ? { kind: existingLink.kind } : {}),
            },
            summary: 'Updates a local Second Brain library item.',
            pendingIntro: 'I prepared a local library item update, but it needs approval first.',
            successDescriptor: {
              itemType: 'library',
              action: 'update',
              fallbackId: existingLink.id,
              fallbackLabel: existingLink.title || existingLink.url,
            },
            focusState: input.focusState,
          });
        }
        case 'delete':
          if (!focusItem) {
            return 'I need to know which local library item to delete. Try "Show my library items." first.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_library_delete',
            args: { id: focusItem.id },
            summary: 'Deletes a local Second Brain library item.',
            pendingIntro: 'I prepared a local library item delete, but it needs approval first.',
            successDescriptor: {
              itemType: 'library',
              action: 'delete',
              fallbackId: focusItem.id,
              fallbackLabel: focusItem.label,
            },
            focusState: input.focusState,
          });
        default:
          return null;
      }
    }
    case 'brief': {
      const content = input.extractTextBody(requestText);
      const briefFocus = input.getFocusEntry(input.focusState, 'brief');
      const focusItem = briefFocus
        ? briefFocus.items.find((item) => item.id === briefFocus.focusId) ?? null
        : null;

      switch (input.decision.operation) {
        case 'create':
        case 'save': {
          const title = input.extractNamedTitle(requestText);
          if (!title) {
            return 'To create a local brief, I need the brief title.';
          }
          if (!content) {
            return 'To create a local brief, I need the brief content.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_brief_upsert',
            args: {
              kind: 'manual',
              title,
              content,
            },
            summary: 'Creates a local Second Brain brief.',
            pendingIntro: 'I prepared a local brief save, but it needs approval first.',
            successDescriptor: {
              itemType: 'brief',
              action: 'create',
              fallbackLabel: title,
            },
            focusState: input.focusState,
          });
        }
        case 'update':
          if (!focusItem) {
            return 'I need to know which local brief to update. Try "Show my briefs." first.';
          }
          if (!content) {
            return 'To update that local brief, I need the new brief content.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_brief_upsert',
            args: {
              id: focusItem.id,
              ...(focusItem.label ? { title: focusItem.label } : {}),
              content,
            },
            summary: 'Updates a local Second Brain brief.',
            pendingIntro: 'I prepared a local brief update, but it needs approval first.',
            successDescriptor: {
              itemType: 'brief',
              action: 'update',
              fallbackId: focusItem.id,
              fallbackLabel: focusItem.label,
            },
            focusState: input.focusState,
          });
        case 'delete':
          if (!focusItem) {
            return 'I need to know which local brief to delete. Try "Show my briefs." first.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_brief_delete',
            args: { id: focusItem.id },
            summary: 'Deletes a local Second Brain brief.',
            pendingIntro: 'I prepared a local brief delete, but it needs approval first.',
            successDescriptor: {
              itemType: 'brief',
              action: 'delete',
              fallbackId: focusItem.id,
              fallbackLabel: focusItem.label,
            },
            focusState: input.focusState,
          });
        default:
          return null;
      }
    }
    case 'person': {
      if (!input.secondBrainService) return null;
      const personFocus = input.getFocusEntry(input.focusState, 'person');
      const focusItem = personFocus
        ? personFocus.items.find((item) => item.id === personFocus.focusId) ?? null
        : null;
      const explicitName = input.normalizeInlineFieldValue(
        input.extractQuotedLabeledValue(requestText, ['name']) || input.extractExplicitNamedTitle(requestText),
      );
      const explicitEmail = input.extractEmailAddress(requestText);
      const explicitPhone = input.extractPhoneNumber(requestText);
      const explicitTitle = input.normalizeInlineFieldValue(input.extractQuotedLabeledValue(requestText, ['title']));
      const explicitCompany = input.normalizeInlineFieldValue(input.extractQuotedLabeledValue(requestText, ['company']));
      const explicitLocation = input.normalizeInlineFieldValue(input.extractQuotedLabeledValue(requestText, ['location']));
      const explicitNotes = input.collapseWhitespace(
        input.extractQuotedLabeledValue(requestText, ['notes', 'note', 'summary', 'description'])
        || (/\b(?:saying|say|says|write|content)\b/i.test(requestText)
          ? input.extractTextBody(requestText)
          : ''),
      );
      const explicitRelationship = input.extractPersonRelationship(requestText);

      switch (input.decision.operation) {
        case 'create':
        case 'save': {
          const createName = explicitName || input.extractFallbackPersonName(requestText);
          if (!createName && !explicitEmail) {
            return input.buildClarificationResponse({
              message: input.message,
              decision: input.decision,
              prompt: 'To create a local contact, I need at least a name or email address.',
              field: 'person_identity',
              missingFields: ['person_name_or_email'],
              entities: { personalItemType: 'person' },
            });
          }
          const args = normalizeSecondBrainMutationArgs({
            toolName: 'second_brain_person_upsert',
            args: {
              ...(createName ? { name: createName } : {}),
              ...(explicitEmail ? { email: explicitEmail } : {}),
              ...(explicitPhone ? { phone: explicitPhone } : {}),
              ...(explicitTitle ? { title: explicitTitle } : {}),
              ...(explicitCompany ? { company: explicitCompany } : {}),
              ...(explicitLocation ? { location: explicitLocation } : {}),
              ...(explicitNotes ? { notes: explicitNotes } : {}),
              ...(explicitRelationship ? { relationship: explicitRelationship } : {}),
            },
            userContent: requestText,
            referenceTime: Date.now(),
            getPersonById: (id) => input.secondBrainService?.getPersonById(id) ?? null,
          });
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_person_upsert',
            args,
            summary: 'Creates a local Second Brain contact.',
            pendingIntro: 'I prepared a local contact save, but it needs approval first.',
            successDescriptor: {
              itemType: 'person',
              action: 'create',
              fallbackLabel: createName || explicitEmail,
            },
            focusState: input.focusState,
          });
        }
        case 'update': {
          if (!focusItem) {
            return 'I need to know which local contact to update. Try "Show the contacts in my Second Brain." first.';
          }
          const existingPerson = input.secondBrainService.getPersonById(focusItem.id);
          if (!existingPerson) {
            return `Local contact "${focusItem.label ?? focusItem.id}" was not found.`;
          }
          const baseArgs: Record<string, unknown> = {
            id: existingPerson.id,
            name: existingPerson.name,
            ...(existingPerson.email ? { email: existingPerson.email } : {}),
            ...(existingPerson.phone ? { phone: existingPerson.phone } : {}),
            ...(existingPerson.title ? { title: existingPerson.title } : {}),
            ...(existingPerson.company ? { company: existingPerson.company } : {}),
            ...(existingPerson.location ? { location: existingPerson.location } : {}),
            ...(existingPerson.notes ? { notes: existingPerson.notes } : {}),
            relationship: existingPerson.relationship,
            ...(existingPerson.lastContactAt != null ? { lastContactAt: existingPerson.lastContactAt } : {}),
          };
          if (explicitName) baseArgs.name = explicitName;
          if (explicitEmail) baseArgs.email = explicitEmail;
          if (explicitPhone) baseArgs.phone = explicitPhone;
          if (explicitTitle) baseArgs.title = explicitTitle;
          if (explicitCompany) baseArgs.company = explicitCompany;
          if (explicitLocation) baseArgs.location = explicitLocation;
          if (explicitNotes) baseArgs.notes = explicitNotes;
          if (explicitRelationship) baseArgs.relationship = explicitRelationship;
          const args = normalizeSecondBrainMutationArgs({
            toolName: 'second_brain_person_upsert',
            args: baseArgs,
            userContent: requestText,
            referenceTime: Date.now(),
            getPersonById: (id) => input.secondBrainService?.getPersonById(id) ?? null,
          });
          const existingLastContactAt = typeof existingPerson.lastContactAt === 'number'
            ? existingPerson.lastContactAt
            : undefined;
          const nextLastContactAt = typeof args.lastContactAt === 'number'
            ? args.lastContactAt
            : undefined;
          const hasExplicitChange = Boolean(
            explicitName
            || explicitEmail
            || explicitPhone
            || explicitTitle
            || explicitCompany
            || explicitLocation
            || explicitNotes
            || explicitRelationship
            || nextLastContactAt !== existingLastContactAt,
          );
          if (!hasExplicitChange) {
            return 'To update that local contact, tell me what to change, such as the name, email, phone, title, company, location, notes, relationship, or last-contact date.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_person_upsert',
            args,
            summary: 'Updates a local Second Brain contact.',
            pendingIntro: 'I prepared a local contact update, but it needs approval first.',
            successDescriptor: {
              itemType: 'person',
              action: 'update',
              fallbackId: existingPerson.id,
              fallbackLabel: existingPerson.name,
            },
            focusState: input.focusState,
          });
        }
        case 'delete':
          if (!focusItem) {
            return 'I need to know which local contact to delete. Try "Show the contacts in my Second Brain." first.';
          }
          return input.executeMutation({
            message: input.message,
            ctx: input.ctx,
            userKey: input.userKey,
            decision: input.decision,
            toolName: 'second_brain_person_delete',
            args: { id: focusItem.id },
            summary: 'Deletes a local Second Brain contact.',
            pendingIntro: 'I prepared a local contact delete, but it needs approval first.',
            successDescriptor: {
              itemType: 'person',
              action: 'delete',
              fallbackId: focusItem.id,
              fallbackLabel: focusItem.label,
            },
            focusState: input.focusState,
          });
        default:
          return null;
      }
    }
    default:
      return null;
  }
}
