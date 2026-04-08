import type { BriefingService } from '../../runtime/second-brain/briefing-service.js';
import type { HorizonScanner } from '../../runtime/second-brain/horizon-scanner.js';
import type { SecondBrainService } from '../../runtime/second-brain/second-brain-service.js';
import type {
  SecondBrainBriefKind,
  SecondBrainGeneratedBriefKind,
  SecondBrainDeliveryChannel,
  SecondBrainLinkKind,
  SecondBrainRoutineEventType,
  SecondBrainRoutineTimingInput,
  SecondBrainRoutineTimingKind,
  SecondBrainRoutineWeekday,
  SecondBrainRoutineTrigger,
  SecondBrainTaskStatus,
} from '../../runtime/second-brain/types.js';
import { ToolRegistry } from '../registry.js';
import type { ToolExecutionRequest } from '../types.js';

interface SecondBrainToolRegistrarContext {
  registry: ToolRegistry;
  getService: () => SecondBrainService | undefined;
  getBriefingService: () => BriefingService | undefined;
  getHorizonScanner: () => HorizonScanner | undefined;
  asString: (value: unknown, fallback?: string) => string;
  asNumber: (value: unknown, fallback: number) => number;
  guardAction: (request: ToolExecutionRequest, action: string, details: Record<string, unknown>) => void;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function normalizeTaskStatus(value: unknown): SecondBrainTaskStatus | 'open' | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (normalized) {
    case 'todo':
    case 'in_progress':
    case 'done':
    case 'open':
      return normalized;
    default:
      return undefined;
  }
}

function normalizePersonRelationship(value: unknown): 'work' | 'personal' | 'family' | 'vendor' | 'other' | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (normalized) {
    case 'work':
    case 'personal':
    case 'family':
    case 'vendor':
    case 'other':
      return normalized;
    default:
      return undefined;
  }
}

function normalizeBriefKind(value: unknown): SecondBrainBriefKind | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (normalized) {
    case 'manual':
    case 'morning':
    case 'weekly_review':
    case 'pre_meeting':
    case 'follow_up':
      return normalized;
    default:
      return undefined;
  }
}

function normalizeGeneratedBriefKind(value: unknown): SecondBrainGeneratedBriefKind | undefined {
  const normalized = normalizeBriefKind(value);
  return normalized === 'morning' || normalized === 'weekly_review' || normalized === 'pre_meeting' || normalized === 'follow_up'
    ? normalized
    : undefined;
}

function normalizeLinkKind(value: unknown): SecondBrainLinkKind | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (normalized) {
    case 'document':
    case 'article':
    case 'reference':
    case 'repo':
    case 'file':
    case 'other':
      return normalized;
    default:
      return undefined;
  }
}

function normalizeDeliveryChannel(value: unknown): SecondBrainDeliveryChannel | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (normalized) {
    case 'web':
    case 'cli':
    case 'telegram':
      return normalized;
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeRoutineTrigger(value: unknown): SecondBrainRoutineTrigger | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const mode = typeof record.mode === 'string' ? record.mode.trim().toLowerCase() : '';
  if (mode !== 'cron' && mode !== 'event' && mode !== 'horizon' && mode !== 'manual') {
    return undefined;
  }
  const lookaheadMinutes = typeof record.lookaheadMinutes === 'number'
    ? record.lookaheadMinutes
    : undefined;
  return {
    mode,
    ...(typeof record.cron === 'string' && record.cron.trim() ? { cron: record.cron.trim() } : {}),
    ...(typeof record.eventType === 'string' && record.eventType.trim()
      ? { eventType: record.eventType.trim().toLowerCase() as SecondBrainRoutineEventType }
      : {}),
    ...(Number.isFinite(lookaheadMinutes) ? { lookaheadMinutes } : {}),
  };
}

function normalizeRoutineConfig(value: unknown): import('../../runtime/second-brain/types.js').SecondBrainRoutineConfig | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const topicQuery = typeof record.topicQuery === 'string' ? record.topicQuery.trim() : '';
  const dueWithinHours = typeof record.dueWithinHours === 'number'
    ? record.dueWithinHours
    : undefined;
  const includeOverdue = typeof record.includeOverdue === 'boolean'
    ? record.includeOverdue
    : undefined;
  if (!topicQuery && !Number.isFinite(dueWithinHours) && includeOverdue == null) {
    return undefined;
  }
  return {
    ...(topicQuery ? { topicQuery } : {}),
    ...(Number.isFinite(dueWithinHours) ? { dueWithinHours } : {}),
    ...(includeOverdue != null ? { includeOverdue } : {}),
  };
}

function normalizeRoutineTiming(value: unknown): SecondBrainRoutineTimingInput | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const kind = typeof record.kind === 'string'
    ? record.kind.trim().toLowerCase() as SecondBrainRoutineTimingKind
    : undefined;
  if (!kind || !['manual', 'scheduled', 'before_meetings', 'after_meetings', 'background'].includes(kind)) {
    return undefined;
  }
  const scheduleRecord = asRecord(record.schedule);
  const cadence = typeof scheduleRecord?.cadence === 'string'
    ? scheduleRecord.cadence.trim().toLowerCase()
    : '';
  const time = typeof scheduleRecord?.time === 'string'
    ? scheduleRecord.time.trim()
    : '';
  const dayOfWeek = typeof scheduleRecord?.dayOfWeek === 'string'
    ? scheduleRecord.dayOfWeek.trim().toLowerCase() as SecondBrainRoutineWeekday
    : undefined;
  const minutes = typeof record.minutes === 'number' ? record.minutes : undefined;
  return {
    kind,
    ...(time && (cadence === 'daily' || cadence === 'weekly')
      ? {
          schedule: {
            cadence,
            time,
            ...(dayOfWeek ? { dayOfWeek } : {}),
          },
        }
      : {}),
    ...(Number.isFinite(minutes) ? { minutes } : {}),
  };
}

export function registerBuiltinSecondBrainTools(context: SecondBrainToolRegistrarContext): void {
  const { asString, asNumber } = context;

  context.registry.register(
    {
      name: 'second_brain_overview',
      description: 'Read the current Second Brain overview including today priorities, routines, usage, top tasks, and recent notes.',
      shortDescription: 'Read the current Second Brain overview.',
      risk: 'read_only',
      category: 'memory',
      deferLoading: true,
      parameters: { type: 'object', properties: {} },
    },
    async (_args, request) => {
      context.guardAction(request, 'read_file', { path: 'second-brain:overview' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      return { success: true, output: service.getOverview() };
    },
  );

  context.registry.register(
    {
      name: 'second_brain_brief_list',
      description: 'List stored Second Brain briefs and follow-up drafts.',
      shortDescription: 'List Second Brain briefs.',
      risk: 'read_only',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['morning', 'weekly_review', 'pre_meeting', 'follow_up'],
          },
          eventId: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'read_file', { path: 'second-brain:briefs' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      const kind = args.kind == null ? undefined : normalizeBriefKind(args.kind);
      if (args.kind != null && !kind) {
        return { success: false, error: 'kind must be morning, weekly_review, pre_meeting, or follow_up.' };
      }
      return {
        success: true,
        output: service.listBriefs({
          kind,
          eventId: asString(args.eventId).trim() || undefined,
          limit: Math.min(Math.max(asNumber(args.limit, 25), 1), 100),
        }),
      };
    },
  );

  context.registry.register(
    {
      name: 'second_brain_brief_upsert',
      description: 'Create or update a stored Second Brain brief.',
      shortDescription: 'Create or update a Second Brain brief.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['title', 'content'],
        properties: {
          id: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['manual', 'morning', 'weekly_review', 'pre_meeting', 'follow_up'],
          },
          title: { type: 'string' },
          content: { type: 'string' },
          generatedAt: { type: 'number' },
          routineId: { type: 'string' },
          eventId: { type: 'string' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:briefs' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      const kind = args.kind == null ? undefined : normalizeBriefKind(args.kind);
      if (args.kind != null && !kind) {
        return { success: false, error: 'kind must be manual, morning, weekly_review, pre_meeting, or follow_up.' };
      }
      try {
        const brief = service.upsertBrief({
          id: asString(args.id).trim() || undefined,
          kind,
          title: asString(args.title).trim(),
          content: asString(args.content).trim(),
          generatedAt: typeof args.generatedAt === 'number' ? args.generatedAt : undefined,
          routineId: asString(args.routineId).trim() || undefined,
          eventId: asString(args.eventId).trim() || undefined,
        });
        return { success: true, output: brief };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_generate_brief',
      description: 'Generate and store a deterministic Second Brain brief or follow-up draft.',
      shortDescription: 'Generate a Second Brain brief.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['kind'],
        properties: {
          kind: {
            type: 'string',
            enum: ['morning', 'weekly_review', 'pre_meeting', 'follow_up'],
          },
          eventId: { type: 'string' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:briefs' });
      const briefingService = context.getBriefingService();
      if (!briefingService) return { success: false, error: 'Second Brain briefing service is unavailable.' };
      const kind = normalizeGeneratedBriefKind(args.kind);
      if (!kind) {
        return { success: false, error: 'kind must be morning, weekly_review, pre_meeting, or follow_up.' };
      }
      if ((kind === 'pre_meeting' || kind === 'follow_up') && !asString(args.eventId).trim()) {
        return { success: false, error: 'eventId is required for pre_meeting and follow_up briefs.' };
      }
      try {
        const brief = await briefingService.generateBrief({
          kind,
          eventId: asString(args.eventId).trim() || undefined,
        });
        return { success: true, output: brief };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_brief_update',
      description: 'Update one stored Second Brain brief or follow-up draft.',
      shortDescription: 'Update a Second Brain brief.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:briefs' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      if (args.title == null && args.content == null) {
        return { success: false, error: 'title or content is required.' };
      }
      try {
        const brief = service.updateBrief({
          id: asString(args.id).trim(),
          ...(args.title == null ? {} : { title: asString(args.title) }),
          ...(args.content == null ? {} : { content: asString(args.content) }),
        });
        return { success: true, output: brief };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_brief_delete',
      description: 'Delete one stored Second Brain brief or follow-up draft.',
      shortDescription: 'Delete a Second Brain brief.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:briefs' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      try {
        const brief = service.deleteBrief(asString(args.id).trim());
        return { success: true, output: brief };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_horizon_scan',
      description: 'Run the deterministic Second Brain sync and routine horizon scan.',
      shortDescription: 'Run the Second Brain horizon scan.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:routines' });
      const horizonScanner = context.getHorizonScanner();
      if (!horizonScanner) return { success: false, error: 'Second Brain horizon scanner is unavailable.' };
      try {
        const summary = await horizonScanner.runScan(asString(args.source).trim() || 'tool');
        return { success: true, output: summary };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_note_list',
      description: 'List Second Brain notes ordered by pinned state then most-recent update time.',
      shortDescription: 'List Second Brain notes.',
      risk: 'read_only',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          includeArchived: { type: 'boolean' },
          limit: { type: 'number' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'read_file', { path: 'second-brain:notes' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      return {
        success: true,
        output: service.listNotes({
          includeArchived: parseBoolean(args.includeArchived),
          limit: Math.min(Math.max(asNumber(args.limit, 25), 1), 100),
        }),
      };
    },
  );

  context.registry.register(
    {
      name: 'second_brain_note_upsert',
      description: 'Create or update a Second Brain note.',
      shortDescription: 'Create or update a Second Brain note.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['content'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          pinned: { type: 'boolean' },
          archived: { type: 'boolean' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:notes' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      const tags = Array.isArray(args.tags)
        ? args.tags.filter((value): value is string => typeof value === 'string')
        : undefined;
      try {
        const note = service.upsertNote({
          id: asString(args.id).trim() || undefined,
          title: asString(args.title).trim() || undefined,
          content: asString(args.content).trim(),
          tags,
          pinned: parseBoolean(args.pinned),
          archived: parseBoolean(args.archived),
        });
        return { success: true, output: note };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_note_delete',
      description: 'Delete one Second Brain note.',
      shortDescription: 'Delete a Second Brain note.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:notes' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      try {
        const note = service.deleteNote(asString(args.id).trim());
        return { success: true, output: note };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_task_list',
      description: 'List Second Brain tasks ordered by due date, priority, and update time.',
      shortDescription: 'List Second Brain tasks.',
      risk: 'read_only',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['todo', 'in_progress', 'done', 'open'],
          },
          limit: { type: 'number' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'read_file', { path: 'second-brain:tasks' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      const status = normalizeTaskStatus(args.status);
      if (args.status != null && !status) {
        return { success: false, error: 'status must be todo, in_progress, done, or open.' };
      }
      return {
        success: true,
        output: service.listTasks({
          status,
          limit: Math.min(Math.max(asNumber(args.limit, 25), 1), 100),
        }),
      };
    },
  );

  context.registry.register(
    {
      name: 'second_brain_task_upsert',
      description: 'Create or update a Second Brain task.',
      shortDescription: 'Create or update a Second Brain task.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['title'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          details: { type: 'string' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          dueAt: { type: 'number' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:tasks' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      const status = args.status == null ? undefined : normalizeTaskStatus(args.status);
      if (args.status != null && (!status || status === 'open')) {
        return { success: false, error: 'status must be todo, in_progress, or done.' };
      }
      const priority = typeof args.priority === 'string'
        && ['low', 'medium', 'high'].includes(args.priority)
        ? args.priority as 'low' | 'medium' | 'high'
        : undefined;
      try {
        const task = service.upsertTask({
          id: asString(args.id).trim() || undefined,
          title: asString(args.title).trim(),
          details: asString(args.details).trim() || undefined,
          status: status as SecondBrainTaskStatus | undefined,
          priority,
          dueAt: typeof args.dueAt === 'number' ? args.dueAt : undefined,
        });
        return { success: true, output: task };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_task_delete',
      description: 'Delete one Second Brain task.',
      shortDescription: 'Delete a Second Brain task.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:tasks' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      try {
        const task = service.deleteTask(asString(args.id).trim());
        return { success: true, output: task };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_calendar_list',
      description: 'List Second Brain calendar events ordered by start time.',
      shortDescription: 'List Second Brain calendar events.',
      risk: 'read_only',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          includePast: { type: 'boolean' },
          fromTime: { type: 'number' },
          toTime: { type: 'number' },
          limit: { type: 'number' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'read_file', { path: 'second-brain:calendar' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      return {
        success: true,
        output: service.listEvents({
          includePast: parseBoolean(args.includePast),
          fromTime: typeof args.fromTime === 'number' ? args.fromTime : undefined,
          toTime: typeof args.toTime === 'number' ? args.toTime : undefined,
          limit: Math.min(Math.max(asNumber(args.limit, 25), 1), 100),
        }),
      };
    },
  );

  context.registry.register(
    {
      name: 'second_brain_calendar_upsert',
      description: 'Create or update a local Second Brain calendar event. Provider-synced events remain read-only here.',
      shortDescription: 'Create or update a local calendar event.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['title', 'startsAt'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          startsAt: { type: 'number' },
          endsAt: { type: 'number' },
          location: { type: 'string' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:calendar' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      try {
        const event = service.upsertEvent({
          id: asString(args.id).trim() || undefined,
          title: asString(args.title).trim(),
          ...(Object.prototype.hasOwnProperty.call(args, 'description') ? { description: asString(args.description) } : {}),
          startsAt: typeof args.startsAt === 'number' ? args.startsAt : Number.NaN,
          endsAt: typeof args.endsAt === 'number' ? args.endsAt : undefined,
          ...(Object.prototype.hasOwnProperty.call(args, 'location') ? { location: asString(args.location) } : {}),
        });
        return { success: true, output: event };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_calendar_delete',
      description: 'Delete one local Second Brain calendar event. Provider-synced events must be deleted in their source provider.',
      shortDescription: 'Delete a local calendar event.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:calendar' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      try {
        const event = service.deleteEvent(asString(args.id).trim());
        return { success: true, output: event };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_routine_list',
      description: 'List configured Second Brain routines and their current timing, delivery, and enabled state.',
      shortDescription: 'List Second Brain routines.',
      risk: 'read_only',
      category: 'memory',
      deferLoading: true,
      parameters: { type: 'object', properties: {} },
    },
    async (_args, request) => {
      context.guardAction(request, 'read_file', { path: 'second-brain:routines' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      return { success: true, output: service.listRoutines() };
    },
  );

  context.registry.register(
    {
      name: 'second_brain_routine_catalog',
      description: 'List available Second Brain routine types, including which ones are already configured.',
      shortDescription: 'List Second Brain routine types.',
      risk: 'read_only',
      category: 'memory',
      deferLoading: true,
      parameters: { type: 'object', properties: {} },
    },
    async (_args, request) => {
      context.guardAction(request, 'read_file', { path: 'second-brain:routines' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      return { success: true, output: service.listRoutineCatalog() };
    },
  );

  context.registry.register(
    {
      name: 'second_brain_routine_create',
      description: 'Create a bounded Second Brain routine from the available routine types.',
      shortDescription: 'Create a Second Brain routine.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['templateId'],
        properties: {
          templateId: { type: 'string' },
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          timing: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['manual', 'scheduled', 'before_meetings', 'after_meetings', 'background'] },
              minutes: { type: 'number' },
              schedule: {
                type: 'object',
                properties: {
                  cadence: { type: 'string', enum: ['daily', 'weekly'] },
                  time: { type: 'string' },
                  dayOfWeek: { type: 'string', enum: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] },
                },
              },
            },
          },
          trigger: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['cron', 'event', 'horizon', 'manual'] },
              cron: { type: 'string' },
              eventType: { type: 'string', enum: ['upcoming_event', 'event_ended', 'task_due', 'task_overdue'] },
              lookaheadMinutes: { type: 'number' },
            },
          },
          config: {
            type: 'object',
            properties: {
              topicQuery: { type: 'string' },
              dueWithinHours: { type: 'number' },
              includeOverdue: { type: 'boolean' },
            },
          },
          defaultRoutingBias: {
            type: 'string',
            enum: ['local_first', 'balanced', 'quality_first'],
          },
          budgetProfileId: { type: 'string' },
          delivery: {
            type: 'array',
            items: { type: 'string', enum: ['web', 'cli', 'telegram'] },
          },
          deliveryDefaults: {
            type: 'array',
            items: { type: 'string', enum: ['web', 'cli', 'telegram'] },
          },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:routines' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      const deliveryDefaults = Array.isArray(args.deliveryDefaults)
        ? args.deliveryDefaults
          .map(normalizeDeliveryChannel)
          .filter((value): value is SecondBrainDeliveryChannel => Boolean(value))
        : Array.isArray(args.delivery)
          ? args.delivery
            .map(normalizeDeliveryChannel)
            .filter((value): value is SecondBrainDeliveryChannel => Boolean(value))
        : undefined;
      if (
        (Array.isArray(args.deliveryDefaults) && (deliveryDefaults?.length ?? 0) !== args.deliveryDefaults.length)
        || (Array.isArray(args.delivery) && (deliveryDefaults?.length ?? 0) !== args.delivery.length)
      ) {
        return { success: false, error: 'delivery must contain only web, cli, or telegram.' };
      }
      const timing = normalizeRoutineTiming(args.timing);
      if (args.timing != null && !timing) {
        return { success: false, error: 'timing must contain a supported Second Brain routine timing.' };
      }
      const trigger = normalizeRoutineTrigger(args.trigger);
      if (args.trigger != null && !trigger) {
        return { success: false, error: 'trigger must contain a supported Second Brain routine trigger.' };
      }
      const config = normalizeRoutineConfig(args.config);
      if (args.config != null && !config) {
        return { success: false, error: 'config must contain a supported Second Brain routine configuration.' };
      }
      try {
        const routine = service.createRoutine({
          templateId: asString(args.templateId).trim(),
          name: asString(args.name).trim() || undefined,
          enabled: parseBoolean(args.enabled),
          timing,
          trigger,
          config,
          delivery: deliveryDefaults,
          deliveryDefaults,
          defaultRoutingBias: typeof args.defaultRoutingBias === 'string'
            ? args.defaultRoutingBias as 'local_first' | 'balanced' | 'quality_first'
            : undefined,
          budgetProfileId: asString(args.budgetProfileId).trim() || undefined,
        });
        return { success: true, output: routine };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_people_list',
      description: 'List people stored in Second Brain, ordered by recency.',
      shortDescription: 'List Second Brain people.',
      risk: 'read_only',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'read_file', { path: 'second-brain:people' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      return {
        success: true,
        output: service.listPeople({
          query: asString(args.query).trim() || undefined,
          limit: Math.min(Math.max(asNumber(args.limit, 25), 1), 100),
        }),
      };
    },
  );

  context.registry.register(
    {
      name: 'second_brain_person_upsert',
      description: 'Create or update a person record in Second Brain.',
      shortDescription: 'Create or update a person.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
          title: { type: 'string' },
          company: { type: 'string' },
          notes: { type: 'string' },
          relationship: { type: 'string', enum: ['work', 'personal', 'family', 'vendor', 'other'] },
          lastContactAt: { type: 'number' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:people' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      const relationship = args.relationship == null ? undefined : normalizePersonRelationship(args.relationship);
      if (args.relationship != null && !relationship) {
        return { success: false, error: 'relationship must be work, personal, family, vendor, or other.' };
      }
      try {
        const person = service.upsertPerson({
          id: asString(args.id).trim() || undefined,
          name: asString(args.name).trim() || undefined,
          email: asString(args.email).trim() || undefined,
          title: asString(args.title).trim() || undefined,
          company: asString(args.company).trim() || undefined,
          notes: asString(args.notes).trim() || undefined,
          relationship,
          lastContactAt: typeof args.lastContactAt === 'number' ? args.lastContactAt : undefined,
        });
        return { success: true, output: person };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_person_delete',
      description: 'Delete one person record from Second Brain.',
      shortDescription: 'Delete a person.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:people' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      try {
        const person = service.deletePerson(asString(args.id).trim());
        return { success: true, output: person };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_library_list',
      description: 'List Second Brain library items and saved references.',
      shortDescription: 'List Second Brain library items.',
      risk: 'read_only',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          kind: { type: 'string', enum: ['document', 'article', 'reference', 'repo', 'file', 'other'] },
          limit: { type: 'number' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'read_file', { path: 'second-brain:library' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      const kind = args.kind == null ? undefined : normalizeLinkKind(args.kind);
      if (args.kind != null && !kind) {
        return { success: false, error: 'kind must be document, article, reference, repo, file, or other.' };
      }
      return {
        success: true,
        output: service.listLinks({
          query: asString(args.query).trim() || undefined,
          kind,
          limit: Math.min(Math.max(asNumber(args.limit, 25), 1), 100),
        }),
      };
    },
  );

  context.registry.register(
    {
      name: 'second_brain_library_upsert',
      description: 'Create or update a Second Brain library item.',
      shortDescription: 'Create or update a library item.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          url: { type: 'string' },
          summary: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          kind: { type: 'string', enum: ['document', 'article', 'reference', 'repo', 'file', 'other'] },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:library' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      const kind = args.kind == null ? undefined : normalizeLinkKind(args.kind);
      if (args.kind != null && !kind) {
        return { success: false, error: 'kind must be document, article, reference, repo, file, or other.' };
      }
      const tags = Array.isArray(args.tags)
        ? args.tags.filter((value): value is string => typeof value === 'string')
        : undefined;
      try {
        const link = service.upsertLink({
          id: asString(args.id).trim() || undefined,
          title: asString(args.title).trim() || undefined,
          url: asString(args.url).trim(),
          summary: asString(args.summary).trim() || undefined,
          tags,
          kind,
        });
        return { success: true, output: link };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_library_delete',
      description: 'Delete one Second Brain library item or saved reference.',
      shortDescription: 'Delete a library item.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:library' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      try {
        const link = service.deleteLink(asString(args.id).trim());
        return { success: true, output: link };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_routine_update',
      description: 'Update the enabled state, timing, delivery, or bounded configuration for one Second Brain routine.',
      shortDescription: 'Update a Second Brain routine.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          timing: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['manual', 'scheduled', 'before_meetings', 'after_meetings', 'background'] },
              minutes: { type: 'number' },
              schedule: {
                type: 'object',
                properties: {
                  cadence: { type: 'string', enum: ['daily', 'weekly'] },
                  time: { type: 'string' },
                  dayOfWeek: { type: 'string', enum: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] },
                },
              },
            },
          },
          trigger: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['cron', 'event', 'horizon', 'manual'] },
              cron: { type: 'string' },
              eventType: { type: 'string', enum: ['upcoming_event', 'event_ended', 'task_due', 'task_overdue'] },
              lookaheadMinutes: { type: 'number' },
            },
          },
          config: {
            type: 'object',
            properties: {
              topicQuery: { type: 'string' },
              dueWithinHours: { type: 'number' },
              includeOverdue: { type: 'boolean' },
            },
          },
          defaultRoutingBias: {
            type: 'string',
            enum: ['local_first', 'balanced', 'quality_first'],
          },
          budgetProfileId: { type: 'string' },
          delivery: {
            type: 'array',
            items: { type: 'string', enum: ['web', 'cli', 'telegram'] },
          },
          deliveryDefaults: {
            type: 'array',
            items: { type: 'string', enum: ['web', 'cli', 'telegram'] },
          },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:routines' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      const deliveryDefaults = Array.isArray(args.deliveryDefaults)
        ? args.deliveryDefaults
          .map(normalizeDeliveryChannel)
          .filter((value): value is SecondBrainDeliveryChannel => Boolean(value))
        : Array.isArray(args.delivery)
          ? args.delivery
            .map(normalizeDeliveryChannel)
            .filter((value): value is SecondBrainDeliveryChannel => Boolean(value))
        : undefined;
      if (
        (Array.isArray(args.deliveryDefaults) && (deliveryDefaults?.length ?? 0) !== args.deliveryDefaults.length)
        || (Array.isArray(args.delivery) && (deliveryDefaults?.length ?? 0) !== args.delivery.length)
      ) {
        return { success: false, error: 'delivery must contain only web, cli, or telegram.' };
      }
      const timing = normalizeRoutineTiming(args.timing);
      if (args.timing != null && !timing) {
        return { success: false, error: 'timing must contain a supported Second Brain routine timing.' };
      }
      const trigger = normalizeRoutineTrigger(args.trigger);
      if (args.trigger != null && !trigger) {
        return { success: false, error: 'trigger must contain a supported Second Brain routine trigger.' };
      }
      const config = normalizeRoutineConfig(args.config);
      if (args.config != null && !config) {
        return { success: false, error: 'config must contain a supported Second Brain routine configuration.' };
      }
      try {
        const routine = service.updateRoutine({
          id: asString(args.id).trim(),
          name: asString(args.name).trim() || undefined,
          enabled: parseBoolean(args.enabled),
          timing,
          trigger,
          config,
          delivery: deliveryDefaults,
          deliveryDefaults,
          defaultRoutingBias: typeof args.defaultRoutingBias === 'string'
            ? args.defaultRoutingBias as 'local_first' | 'balanced' | 'quality_first'
            : undefined,
          budgetProfileId: asString(args.budgetProfileId).trim() || undefined,
        });
        return { success: true, output: routine };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_routine_delete',
      description: 'Delete one configured Second Brain routine. Seeded built-ins stay deleted until you explicitly re-create them.',
      shortDescription: 'Delete a Second Brain routine.',
      risk: 'mutating',
      category: 'memory',
      deferLoading: true,
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'write_file', { path: 'second-brain:routines' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      try {
        const routine = service.deleteRoutine(asString(args.id).trim());
        return { success: true, output: routine };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  context.registry.register(
    {
      name: 'second_brain_usage',
      description: 'Read Second Brain usage and budget summary.',
      shortDescription: 'Read Second Brain usage summary.',
      risk: 'read_only',
      category: 'memory',
      deferLoading: true,
      parameters: { type: 'object', properties: {} },
    },
    async (_args, request) => {
      context.guardAction(request, 'read_file', { path: 'second-brain:usage' });
      const service = context.getService();
      if (!service) return { success: false, error: 'Second Brain service is unavailable.' };
      return { success: true, output: service.getUsageSummary() };
    },
  );
}
