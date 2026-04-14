import { toString } from '../../chat-agent-helpers.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { SecondBrainService } from '../second-brain/second-brain-service.js';
import type { DirectSecondBrainMutationItemType } from './direct-second-brain-mutation.js';

export interface SecondBrainReadFocusItem {
  id: string;
  label?: string;
}

export interface SecondBrainReadFocusEntry {
  focusId?: string;
  items: SecondBrainReadFocusItem[];
}

interface SecondBrainReadQuerySpec {
  query: string;
  exactMatch?: boolean;
}

type SecondBrainReadFocusMetadataFn<TFocusState> = (
  existingState: TFocusState | null | undefined,
  itemType: DirectSecondBrainMutationItemType,
  items: readonly SecondBrainReadFocusItem[],
  options?: { preferredFocusId?: string; fallbackFocusIndex?: number; remove?: boolean; activate?: boolean },
) => Record<string, unknown> | undefined;

type SecondBrainReadFocusRemovalMetadataFn<TFocusState> = (
  existingState: TFocusState | null | undefined,
  itemType: DirectSecondBrainMutationItemType,
) => Record<string, unknown>;

export function tryDirectSecondBrainRead<TContinuityThread, TFocusState>(input: {
  secondBrainService: Pick<
    SecondBrainService,
    | 'getOverview'
    | 'listBriefs'
    | 'listEvents'
    | 'listLinks'
    | 'listNotes'
    | 'listPeople'
    | 'listRoutineCatalog'
    | 'listRoutines'
    | 'listTasks'
  >;
  requestText: string;
  decision: IntentGatewayDecision;
  continuityThread?: TContinuityThread | null;
  resolvedItemType: string;
  readFocusState: (continuityThread: TContinuityThread | null | undefined) => TFocusState | null;
  getFocusEntry: (
    focusState: TFocusState | null | undefined,
    itemType: DirectSecondBrainMutationItemType,
  ) => SecondBrainReadFocusEntry | null;
  buildFocusMetadata: SecondBrainReadFocusMetadataFn<TFocusState>;
  buildFocusRemovalMetadata: SecondBrainReadFocusRemovalMetadataFn<TFocusState>;
  resolveReadQuery: (
    text: string,
    itemType: string,
    decision: IntentGatewayDecision,
  ) => SecondBrainReadQuerySpec | null;
  normalizeInlineFieldValue: (value: string) => string;
  formatBriefKindLabel: (kind: string) => string;
  normalizeRoutineQueryTokens: (query: string | undefined) => string[];
  normalizeRoutineSearchTokens: (value: string | undefined) => string[];
  deriveRoutineTimingKind: (routine: unknown) => string | undefined;
  summarizeRoutineTimingForUser: (routine: unknown) => string;
  routineTopicQuery: (routine: unknown) => string;
  routineDueWithinHours: (routine: unknown) => number | undefined;
  routineIncludeOverdue: (routine: unknown) => boolean | undefined;
  routineDeliveryChannels: (routine: unknown) => string[];
  buildRoutineSemanticHints: (routine: unknown) => string[];
}): string | { content: string; metadata?: Record<string, unknown> } | null {
  switch (input.resolvedItemType) {
    case 'task': {
      const tasks = input.secondBrainService.listTasks({ status: 'open', limit: 8 });
      if (tasks.length === 0) {
        return {
          content: 'Second Brain has no open tasks right now.',
          metadata: input.buildFocusRemovalMetadata(input.readFocusState(input.continuityThread), 'task'),
        };
      }
      const priorFocus = input.readFocusState(input.continuityThread);
      const priorTaskFocus = input.getFocusEntry(priorFocus, 'task');
      const items = tasks.map((task) => ({ id: task.id, label: task.title }));
      return {
        content: [
          'Open tasks:',
          ...tasks.map((task) => {
            const dueText = task.dueAt ? ` due ${new Date(task.dueAt).toLocaleString()}` : '';
            const detail = task.details?.trim() ? ` - ${task.details.trim()}` : '';
            return `- [${task.priority}] ${task.title}${dueText}${detail}`;
          }),
        ].join('\n'),
        metadata: input.buildFocusMetadata(priorFocus, 'task', items, {
          preferredFocusId: priorTaskFocus?.focusId,
        }),
      };
    }
    case 'note': {
      const notes = input.secondBrainService.listNotes({ limit: 6 });
      if (notes.length === 0) {
        return {
          content: 'Second Brain has no saved notes yet.',
          metadata: input.buildFocusRemovalMetadata(input.readFocusState(input.continuityThread), 'note'),
        };
      }
      const priorFocus = input.readFocusState(input.continuityThread);
      const priorNoteFocus = input.getFocusEntry(priorFocus, 'note');
      const items = notes.map((note) => ({ id: note.id, label: note.title }));
      return {
        content: [
          'Recent notes:',
          ...notes.map((note) => {
            const preview = note.content.replace(/\s+/g, ' ').trim();
            return `- ${note.title}: ${preview.slice(0, 120)}${preview.length > 120 ? '...' : ''}`;
          }),
        ].join('\n'),
        metadata: input.buildFocusMetadata(priorFocus, 'note', items, {
          preferredFocusId: priorNoteFocus?.focusId,
        }),
      };
    }
    case 'library': {
      const querySpec = input.resolveReadQuery(input.requestText, input.resolvedItemType, input.decision);
      const links = input.secondBrainService.listLinks({
        limit: 8,
        ...(querySpec?.query ? { query: querySpec.query } : {}),
      });
      if (links.length === 0) {
        return {
          content: querySpec?.query
            ? `Second Brain has no library items related to "${querySpec.query}".`
            : 'Second Brain has no saved library items yet.',
          metadata: input.buildFocusRemovalMetadata(input.readFocusState(input.continuityThread), 'library'),
        };
      }
      const priorFocus = input.readFocusState(input.continuityThread);
      const priorLibraryFocus = input.getFocusEntry(priorFocus, 'library');
      const items = links.map((link) => ({ id: link.id, label: link.title }));
      return {
        content: [
          querySpec?.query
            ? `Library items related to "${querySpec.query}":`
            : 'Library items:',
          ...links.map((link) => {
            const summary = link.summary?.trim()
              ? `: ${link.summary.trim().slice(0, 120)}${link.summary.trim().length > 120 ? '...' : ''}`
              : '';
            return `- ${link.title} [${link.kind}] - ${link.url}${summary}`;
          }),
        ].join('\n'),
        metadata: input.buildFocusMetadata(priorFocus, 'library', items, {
          preferredFocusId: priorLibraryFocus?.focusId,
        }),
      };
    }
    case 'routine': {
      const routines = input.secondBrainService.listRoutines();
      if (routines.length === 0) {
        return {
          content: 'Second Brain has no configured routines yet.',
          metadata: input.buildFocusRemovalMetadata(input.readFocusState(input.continuityThread), 'routine'),
        };
      }
      const priorFocus = input.readFocusState(input.continuityThread);
      const priorRoutineFocus = input.getFocusEntry(priorFocus, 'routine');
      const routineCatalogById = new Map(
        input.secondBrainService.listRoutineCatalog().flatMap((entry) => {
          const entries: Array<[string, string]> = [];
          if (entry.configuredRoutineId?.trim()) {
            entries.push([entry.configuredRoutineId.trim(), entry.description]);
          }
          if (entry.templateId?.trim()) {
            entries.push([entry.templateId.trim(), entry.description]);
          }
          return entries;
        }),
      );
      const enabledFilter = typeof input.decision.entities.enabled === 'boolean'
        ? input.decision.entities.enabled
        : undefined;
      const query = toString(input.decision.entities.query).trim();
      const queryTokens = input.normalizeRoutineQueryTokens(query);
      const filteredRoutines = routines.filter((routine) => {
        if (typeof enabledFilter === 'boolean' && routine.enabled !== enabledFilter) {
          return false;
        }
        if (queryTokens.length === 0) {
          return true;
        }
        const description = routineCatalogById.get(routine.id)?.trim()
          ?? routineCatalogById.get(routine.templateId ?? '')?.trim()
          ?? '';
        const dueWithinHours = input.routineDueWithinHours(routine);
        const includeOverdue = input.routineIncludeOverdue(routine);
        const searchTokens = new Set(input.normalizeRoutineSearchTokens([
          routine.name,
          routine.id,
          routine.templateId,
          routine.category,
          input.deriveRoutineTimingKind(routine),
          input.summarizeRoutineTimingForUser(routine),
          input.routineTopicQuery(routine),
          Number.isFinite(dueWithinHours) ? `due within ${dueWithinHours} hours` : undefined,
          includeOverdue === false ? 'upcoming only' : 'overdue due soon',
          description,
          ...input.buildRoutineSemanticHints(routine),
        ]
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .join(' ')));
        return queryTokens.every((token) => searchTokens.has(token));
      });
      if (filteredRoutines.length === 0) {
        if (queryTokens.length > 0 && typeof enabledFilter === 'boolean') {
          return `Second Brain has no ${enabledFilter ? 'enabled' : 'disabled'} routines related to "${queryTokens.join(' ')}".`;
        }
        if (queryTokens.length > 0) {
          return `Second Brain has no routines related to "${queryTokens.join(' ')}".`;
        }
        if (enabledFilter === true) {
          return 'Second Brain has no enabled routines.';
        }
        if (enabledFilter === false) {
          return 'Second Brain has no disabled routines.';
        }
        return {
          content: 'Second Brain has no configured routines yet.',
          metadata: input.buildFocusRemovalMetadata(priorFocus, 'routine'),
        };
      }
      const items = filteredRoutines.map((routine) => ({ id: routine.id, label: routine.name }));
      return {
        content: [
          queryTokens.length > 0
            ? typeof enabledFilter === 'boolean'
              ? `${enabledFilter ? 'Enabled' : 'Disabled'} Second Brain routines related to "${queryTokens.join(' ')}":`
              : `Second Brain routines related to "${queryTokens.join(' ')}":`
            : enabledFilter === true
              ? 'Enabled Second Brain routines:'
              : enabledFilter === false
                ? 'Disabled Second Brain routines:'
                : 'Second Brain routines:',
          ...filteredRoutines.map((routine) => {
            const description = routineCatalogById.get(routine.id)?.trim()
              ?? routineCatalogById.get(routine.templateId ?? '')?.trim()
              ?? '';
            const descriptionSuffix = description
              ? `: ${description.length > 120 ? `${description.slice(0, 117).trimEnd()}...` : description}`
              : '';
            const delivery = input.routineDeliveryChannels(routine);
            const deliverySummary = delivery.length > 0
              ? ` · ${delivery.join(', ')}`
              : '';
            const topicQuery = input.routineTopicQuery(routine);
            const dueWithinHours = input.routineDueWithinHours(routine);
            const includeOverdue = input.routineIncludeOverdue(routine);
            const topicSuffix = topicQuery
              ? ` · watching "${topicQuery}"`
              : Number.isFinite(dueWithinHours)
                ? ` · tasks due within ${Number(dueWithinHours)} hours${includeOverdue === false ? '' : ' plus overdue'}`
                : '';
            return `- ${routine.name} [${routine.enabled ? 'enabled' : 'paused'}] (${input.summarizeRoutineTimingForUser(routine)}${deliverySummary})${topicSuffix}${descriptionSuffix}`;
          }),
        ].join('\n'),
        metadata: input.buildFocusMetadata(priorFocus, 'routine', items, {
          preferredFocusId: priorRoutineFocus?.focusId,
        }),
      };
    }
    case 'calendar': {
      const calendarWindowDays = typeof input.decision.entities.calendarWindowDays === 'number'
        ? input.decision.entities.calendarWindowDays
        : undefined;
      const now = Date.now();
      const events = input.secondBrainService.listEvents({
        limit: 6,
        includePast: false,
        ...(typeof calendarWindowDays === 'number'
          ? {
              fromTime: now,
              toTime: now + (calendarWindowDays * 24 * 60 * 60 * 1000),
            }
          : {}),
      });
      if (events.length === 0) {
        return {
          content: typeof calendarWindowDays === 'number'
            ? `Second Brain has no calendar events in the next ${calendarWindowDays} days.`
            : 'Second Brain has no upcoming calendar events right now.',
          metadata: input.buildFocusRemovalMetadata(input.readFocusState(input.continuityThread), 'calendar'),
        };
      }
      const priorFocus = input.readFocusState(input.continuityThread);
      const priorCalendarFocus = input.getFocusEntry(priorFocus, 'calendar');
      const items = events.map((event) => ({ id: event.id, label: event.title }));
      return {
        content: [
          typeof calendarWindowDays === 'number'
            ? `Calendar events for the next ${calendarWindowDays} days:`
            : 'Upcoming events:',
          ...events.map((event) => {
            const location = event.location?.trim() ? ` - ${event.location.trim()}` : '';
            const description = typeof event.description === 'string' && event.description.trim()
              ? event.description.trim()
              : '';
            const descriptionSuffix = description
              ? ` :: ${description.length > 140 ? `${description.slice(0, 137).trimEnd()}...` : description}`
              : '';
            return `- ${event.title} at ${new Date(event.startsAt).toLocaleString()}${location}${descriptionSuffix}`;
          }),
        ].join('\n'),
        metadata: input.buildFocusMetadata(priorFocus, 'calendar', items, {
          preferredFocusId: priorCalendarFocus?.focusId,
        }),
      };
    }
    case 'person': {
      const querySpec = input.resolveReadQuery(input.requestText, input.resolvedItemType, input.decision);
      let people = input.secondBrainService.listPeople({
        limit: 6,
        ...(querySpec?.query ? { query: querySpec.query } : {}),
      });
      if (querySpec?.exactMatch && querySpec.query) {
        const normalizedExactName = input.normalizeInlineFieldValue(querySpec.query).toLowerCase();
        const exactMatches = people.filter((person) => input.normalizeInlineFieldValue(person.name).toLowerCase() === normalizedExactName);
        if (exactMatches.length > 0) {
          people = exactMatches;
        }
      }
      if (people.length === 0) {
        return {
          content: querySpec?.query
            ? `Second Brain has no contacts matching "${querySpec.query}".`
            : 'Second Brain has no saved contacts yet.',
          metadata: input.buildFocusRemovalMetadata(input.readFocusState(input.continuityThread), 'person'),
        };
      }
      const priorFocus = input.readFocusState(input.continuityThread);
      const priorPersonFocus = input.getFocusEntry(priorFocus, 'person');
      const items = people.map((person) => ({ id: person.id, label: person.name }));
      return {
        content: [
          querySpec?.query
            ? `${querySpec.exactMatch ? 'Contacts in Second Brain matching' : 'Contacts in Second Brain related to'} "${querySpec.query}":`
            : 'Contacts in Second Brain:',
          ...people.map((person) => {
            const parts = [
              person.email?.trim(),
              person.title?.trim(),
              person.company?.trim(),
            ].filter((value): value is string => Boolean(value));
            return `- ${person.name}${parts.length > 0 ? ` - ${parts.join(' · ')}` : ''}`;
          }),
        ].join('\n'),
        metadata: input.buildFocusMetadata(priorFocus, 'person', items, {
          preferredFocusId: priorPersonFocus?.focusId,
        }),
      };
    }
    case 'brief': {
      const briefs = input.secondBrainService.listBriefs({ limit: 6 });
      if (briefs.length === 0) {
        return {
          content: 'Second Brain has no saved briefs yet.',
          metadata: input.buildFocusRemovalMetadata(input.readFocusState(input.continuityThread), 'brief'),
        };
      }
      const priorFocus = input.readFocusState(input.continuityThread);
      const priorBriefFocus = input.getFocusEntry(priorFocus, 'brief');
      const items = briefs.map((brief) => ({ id: brief.id, label: brief.title }));
      return {
        content: [
          'Saved briefs:',
          ...briefs.map((brief) => {
            const preview = brief.content.replace(/\s+/g, ' ').trim();
            const suffix = preview
              ? `: ${preview.slice(0, 120)}${preview.length > 120 ? '...' : ''}`
              : '';
            return `- ${brief.title} [${input.formatBriefKindLabel(brief.kind)}]${suffix}`;
          }),
        ].join('\n'),
        metadata: input.buildFocusMetadata(priorFocus, 'brief', items, {
          preferredFocusId: priorBriefFocus?.focusId,
        }),
      };
    }
    case 'overview':
    case 'unknown':
    default: {
      const overview = input.secondBrainService.getOverview();
      const nextEvent = overview.nextEvent
        ? (() => {
            const description = typeof overview.nextEvent?.description === 'string' && overview.nextEvent.description.trim()
              ? overview.nextEvent.description.trim()
              : '';
            const descriptionSuffix = description
              ? ` :: ${description.length > 120 ? `${description.slice(0, 117).trimEnd()}...` : description}`
              : '';
            return `${overview.nextEvent.title} at ${new Date(overview.nextEvent.startsAt).toLocaleString()}${descriptionSuffix}`;
          })()
        : 'No synced event yet';
      const topTaskSummary = overview.topTasks.length > 0
        ? overview.topTasks.map((task) => task.title).slice(0, 3).join(', ')
        : 'No open tasks';
      const recentNoteSummary = overview.recentNotes.length > 0
        ? overview.recentNotes.map((note) => note.title).slice(0, 2).join(', ')
        : 'No notes yet';
      return [
        'Second Brain overview:',
        `- Next event: ${nextEvent}`,
        `- Top tasks: ${topTaskSummary}`,
        `- Recent notes: ${recentNoteSummary}`,
        `- Enabled routines: ${overview.enabledRoutineCount}`,
        `- Usage: ${overview.usage.externalTokens} external tokens this period (${overview.usage.monthlyBudget} monthly budget)`,
      ].join('\n');
    }
  }
}
