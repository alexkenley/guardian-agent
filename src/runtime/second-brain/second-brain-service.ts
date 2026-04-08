import { randomUUID } from 'node:crypto';
import {
  type SecondBrainBriefUpdateInput,
  type SecondBrainBriefUpsertInput,
  type SecondBrainBriefFilter,
  type SecondBrainBriefRecord,
  type SecondBrainEntityKind,
  type SecondBrainEventFilter,
  type SecondBrainEventRecord,
  type SecondBrainEventUpsertInput,
  type SecondBrainLinkFilter,
  type SecondBrainLinkRecord,
  type SecondBrainLinkUpsertInput,
  type SecondBrainNoteFilter,
  type SecondBrainNoteRecord,
  type SecondBrainNoteUpsertInput,
  type SecondBrainOverview,
  type SecondBrainPersonFilter,
  type SecondBrainPersonRecord,
  type SecondBrainPersonUpsertInput,
  type SecondBrainRoutineCatalogEntry,
  type SecondBrainRoutineConfig,
  type SecondBrainRoutineCreateInput,
  type SecondBrainRoutineTimingInput,
  type SecondBrainRoutineTimingKind,
  type SecondBrainRoutineTimingView,
  type SecondBrainRoutineSchedule,
  type SecondBrainRoutineWeekday,
  type SecondBrainRoutineManifest,
  type SecondBrainRoutineRecord,
  type SecondBrainRoutineTemplateId,
  type SecondBrainRoutineTrigger,
  type SecondBrainRoutineTypeView,
  type SecondBrainRoutineUpdateInput,
  type SecondBrainRoutineView,
  type SecondBrainTaskFilter,
  type SecondBrainTaskRecord,
  type SecondBrainTaskUpsertInput,
  type SecondBrainUsageRecord,
  type SecondBrainUsageSummary,
  type SecondBrainSyncCursorRecord,
} from './types.js';
import { SecondBrainStore } from './second-brain-store.js';

interface SecondBrainServiceOptions {
  now?: () => number;
  monthlyExternalTokenBudget?: number;
  dailyExternalTokenBudget?: number;
  quietBudgetMode?: boolean;
  pauseOnOverage?: boolean;
}

interface BuiltInRoutineDefinition {
  capability: SecondBrainRoutineCatalogEntry['capability'];
  description: string;
  catalogCategory: SecondBrainRoutineCatalogEntry['category'];
  seedByDefault: boolean;
  visibleInAssistant?: boolean;
  allowMultiple?: boolean;
  manifest: SecondBrainRoutineManifest;
}

const BUILT_IN_ROUTINES: BuiltInRoutineDefinition[] = [
  {
    capability: 'morning_brief',
    description: 'Prepare a morning brief with today’s events, open tasks, and recent context.',
    catalogCategory: 'daily',
    seedByDefault: true,
    manifest: {
      id: 'morning-brief',
      name: 'Morning Brief',
      category: 'scheduled',
      enabledByDefault: true,
      trigger: { mode: 'cron', cron: '0 7 * * *' },
      workloadClass: 'B',
      externalCommMode: 'none',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['telegram', 'web'],
      defaultRoutingBias: 'local_first',
    },
  },
  {
    capability: 'weekly_review',
    description: 'Prepare a weekly review with upcoming commitments, open work, and recent context.',
    catalogCategory: 'weekly',
    seedByDefault: true,
    manifest: {
      id: 'weekly-review',
      name: 'Weekly Review',
      category: 'scheduled',
      enabledByDefault: true,
      trigger: { mode: 'cron', cron: '0 9 * * 1' },
      workloadClass: 'C',
      externalCommMode: 'none',
      budgetProfileId: 'weekly-medium',
      deliveryDefaults: ['telegram', 'web'],
      defaultRoutingBias: 'balanced',
    },
  },
  {
    capability: 'manual_sync',
    description: 'Refresh synced calendar events and contacts on demand.',
    catalogCategory: 'maintenance',
    seedByDefault: false,
    visibleInAssistant: false,
    manifest: {
      id: 'one-off-sync',
      name: 'Sync Calendar and Contacts',
      category: 'one_off',
      enabledByDefault: true,
      trigger: { mode: 'manual' },
      workloadClass: 'A',
      externalCommMode: 'none',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['web'],
      defaultRoutingBias: 'local_first',
    },
  },
  {
    capability: 'daily_agenda_check',
    description: 'Watch the next day for upcoming pressure and flag when a review is worth your attention.',
    catalogCategory: 'daily',
    seedByDefault: true,
    manifest: {
      id: 'next-24-hours-radar',
      name: 'Daily Agenda Check',
      category: 'scheduled',
      enabledByDefault: true,
      trigger: { mode: 'horizon', lookaheadMinutes: 1440 },
      workloadClass: 'A',
      externalCommMode: 'none',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['telegram', 'web'],
      defaultRoutingBias: 'local_first',
    },
  },
  {
    capability: 'pre_meeting_brief',
    description: 'Prepare a briefing packet before upcoming meetings.',
    catalogCategory: 'meeting',
    seedByDefault: true,
    manifest: {
      id: 'pre-meeting-brief',
      name: 'Pre-Meeting Brief',
      category: 'scheduled',
      enabledByDefault: true,
      trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
      workloadClass: 'B',
      externalCommMode: 'none',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['telegram', 'web'],
      defaultRoutingBias: 'balanced',
    },
  },
  {
    capability: 'follow_up_draft',
    description: 'Draft meeting follow-ups after recently ended meetings that still need one.',
    catalogCategory: 'follow_up',
    seedByDefault: true,
    manifest: {
      id: 'follow-up-watch',
      name: 'Follow-Up Draft',
      category: 'scheduled',
      enabledByDefault: true,
      trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
      workloadClass: 'B',
      externalCommMode: 'draft_only',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['telegram', 'web'],
      defaultRoutingBias: 'balanced',
    },
  },
  {
    capability: 'topic_watch',
    description: 'Watch a topic across tasks, notes, briefs, people, library items, and events, then message you when new matches appear.',
    catalogCategory: 'watch',
    seedByDefault: false,
    allowMultiple: true,
    manifest: {
      id: 'topic-watch',
      name: 'Topic Watch',
      category: 'scheduled',
      enabledByDefault: true,
      trigger: { mode: 'cron', cron: '0 8 * * *' },
      workloadClass: 'B',
      externalCommMode: 'none',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['telegram', 'web'],
      defaultRoutingBias: 'local_first',
    },
  },
  {
    capability: 'deadline_watch',
    description: 'Watch for upcoming or overdue task pressure and message you when tasks enter the configured window.',
    catalogCategory: 'watch',
    seedByDefault: false,
    allowMultiple: true,
    manifest: {
      id: 'deadline-watch',
      name: 'Deadline Watch',
      category: 'scheduled',
      enabledByDefault: true,
      trigger: { mode: 'cron', cron: '0 8 * * *' },
      workloadClass: 'B',
      externalCommMode: 'none',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['telegram', 'web'],
      defaultRoutingBias: 'local_first',
    },
  },
];

const BUILT_IN_ROUTINES_BY_ID = new Map(BUILT_IN_ROUTINES.map((routine) => [routine.manifest.id, routine]));

function isAssistantVisibleRoutineDefinition(definition: BuiltInRoutineDefinition | undefined): boolean {
  return definition?.visibleInAssistant !== false;
}

const ROUTINE_WEEKDAYS: SecondBrainRoutineWeekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

function padTimePart(value: number): string {
  return String(value).padStart(2, '0');
}

function parseScheduleTime(value: string | undefined): { hour: number; minute: number } | null {
  const trimmed = value?.trim() ?? '';
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function formatScheduleTime(hour: number, minute: number): string {
  return `${padTimePart(hour)}:${padTimePart(minute)}`;
}

function formatFriendlyTime(time: string): string {
  const parsed = parseScheduleTime(time);
  if (!parsed) return time;
  const { hour, minute } = parsed;
  if (hour === 0 && minute === 0) return '12 a.m.';
  if (hour === 12 && minute === 0) return '12 p.m.';
  const meridiem = hour >= 12 ? 'p.m.' : 'a.m.';
  const normalizedHour = hour % 12 || 12;
  return minute === 0
    ? `${normalizedHour} ${meridiem}`
    : `${normalizedHour}:${padTimePart(minute)} ${meridiem}`;
}

function capitalizeWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part[0] ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(' ');
}

function cronDayToWeekday(value: string): SecondBrainRoutineWeekday | null {
  if (!/^\d+$/.test(value)) return null;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 7) return null;
  return ROUTINE_WEEKDAYS[numeric === 7 ? 0 : numeric] ?? null;
}

function weekdayToCronDay(value: SecondBrainRoutineWeekday | undefined): number | null {
  if (!value) return null;
  const index = ROUTINE_WEEKDAYS.indexOf(value);
  return index >= 0 ? index : null;
}

function summarizeRoutineSchedule(schedule: SecondBrainRoutineSchedule): string {
  const time = formatFriendlyTime(schedule.time);
  if (schedule.cadence === 'weekly') {
    return `Weekly on ${capitalizeWords(schedule.dayOfWeek ?? 'monday')} at ${time}`;
  }
  return `Daily at ${time}`;
}

function parseScheduleFromCron(cron: string | undefined): SecondBrainRoutineSchedule | null {
  const parts = String(cron ?? '').trim().split(/\s+/g);
  if (parts.length !== 5) return null;
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parts;
  if (dayOfMonthField !== '*' || monthField !== '*') {
    return null;
  }
  if (!/^\d+$/.test(minuteField) || !/^\d+$/.test(hourField)) {
    return null;
  }
  const minute = Number(minuteField);
  const hour = Number(hourField);
  if (!Number.isInteger(minute) || !Number.isInteger(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) {
    return null;
  }
  const time = formatScheduleTime(hour, minute);
  if (dayOfWeekField === '*') {
    return { cadence: 'daily', time };
  }
  const dayOfWeek = cronDayToWeekday(dayOfWeekField);
  if (!dayOfWeek) {
    return null;
  }
  return {
    cadence: 'weekly',
    time,
    dayOfWeek,
  };
}

function buildCronFromSchedule(schedule: SecondBrainRoutineSchedule): string {
  const parsedTime = parseScheduleTime(schedule.time);
  if (!parsedTime) {
    throw new Error('Scheduled routines require a valid time in HH:MM format.');
  }
  const { hour, minute } = parsedTime;
  if (schedule.cadence === 'weekly') {
    const day = weekdayToCronDay(schedule.dayOfWeek);
    if (day == null) {
      throw new Error('Weekly routines require a day of week.');
    }
    return `${minute} ${hour} * * ${day}`;
  }
  return `${minute} ${hour} * * *`;
}

function supportedTimingKindsForDefinition(definition: BuiltInRoutineDefinition): SecondBrainRoutineTimingKind[] {
  if (definition.manifest.id === 'next-24-hours-radar') {
    return ['background'];
  }
  if (definition.manifest.trigger.mode === 'event' && definition.manifest.trigger.eventType === 'upcoming_event') {
    return ['before_meetings'];
  }
  if (definition.manifest.trigger.mode === 'event' && definition.manifest.trigger.eventType === 'event_ended') {
    return ['after_meetings'];
  }
  if (definition.manifest.trigger.mode === 'cron') {
    return ['scheduled', 'manual'];
  }
  if (definition.manifest.trigger.mode === 'manual') {
    return ['manual'];
  }
  if (definition.manifest.trigger.mode === 'horizon') {
    return ['background'];
  }
  return ['manual'];
}

function cloneRoutineTrigger(trigger: SecondBrainRoutineTrigger): SecondBrainRoutineTrigger {
  return {
    mode: trigger.mode,
    ...(trigger.cron ? { cron: trigger.cron } : {}),
    ...(trigger.eventType ? { eventType: trigger.eventType } : {}),
    ...(Number.isFinite(trigger.lookaheadMinutes) ? { lookaheadMinutes: trigger.lookaheadMinutes } : {}),
  };
}

function cloneRoutineConfig(config: SecondBrainRoutineConfig | undefined): SecondBrainRoutineConfig | undefined {
  return config
    ? {
        ...(config.topicQuery?.trim() ? { topicQuery: config.topicQuery.trim() } : {}),
        ...(Number.isFinite(config.dueWithinHours) ? { dueWithinHours: Number(config.dueWithinHours) } : {}),
        ...(typeof config.includeOverdue === 'boolean' ? { includeOverdue: config.includeOverdue } : {}),
      }
    : undefined;
}

function cloneRoutineManifest(manifest: SecondBrainRoutineManifest): SecondBrainRoutineManifest {
  return {
    ...manifest,
    trigger: cloneRoutineTrigger(manifest.trigger),
    deliveryDefaults: [...manifest.deliveryDefaults],
  };
}

function normalizeRoutineTrigger(
  trigger: SecondBrainRoutineTrigger,
  fallback?: SecondBrainRoutineTrigger,
): SecondBrainRoutineTrigger {
  const mode = trigger.mode;
  if (mode === 'manual') {
    return { mode: 'manual' };
  }

  if (mode === 'cron') {
    const cron = trigger.cron?.trim();
    if (!cron) {
      throw new Error('Scheduled routines require a cron expression.');
    }
    return { mode, cron };
  }

  if (mode === 'event') {
    const eventType = trigger.eventType ?? fallback?.eventType;
    if (!eventType) {
      throw new Error('Event-driven routines require an event type.');
    }
    const lookaheadMinutes = Number.isFinite(trigger.lookaheadMinutes)
      ? Number(trigger.lookaheadMinutes)
      : Number.isFinite(fallback?.lookaheadMinutes)
        ? Number(fallback?.lookaheadMinutes)
        : undefined;
    return {
      mode,
      eventType,
      ...(lookaheadMinutes != null ? { lookaheadMinutes } : {}),
    };
  }

  if (mode === 'horizon') {
    const lookaheadMinutes = Number.isFinite(trigger.lookaheadMinutes)
      ? Number(trigger.lookaheadMinutes)
      : Number.isFinite(fallback?.lookaheadMinutes)
        ? Number(fallback?.lookaheadMinutes)
        : undefined;
    if (!Number.isFinite(lookaheadMinutes) || Number(lookaheadMinutes) <= 0) {
      throw new Error('Horizon routines require a positive lookahead window.');
    }
    return {
      mode,
      lookaheadMinutes: Number(lookaheadMinutes),
    };
  }

  throw new Error(`Unsupported routine trigger mode '${String(mode)}'.`);
}

function resolveRoutineTriggerOverride(
  nextTrigger: SecondBrainRoutineTrigger,
  existingTrigger: SecondBrainRoutineTrigger,
  routineName: string,
): SecondBrainRoutineTrigger {
  const normalized = normalizeRoutineTrigger(nextTrigger, existingTrigger);
  if (existingTrigger.mode === 'event' || existingTrigger.mode === 'horizon') {
    if (normalized.mode !== existingTrigger.mode) {
      throw new Error(`${routineName} uses a fixed ${existingTrigger.mode} trigger and cannot be switched to ${normalized.mode}.`);
    }
    if (existingTrigger.eventType && normalized.eventType && normalized.eventType !== existingTrigger.eventType) {
      throw new Error(`${routineName} uses the fixed event trigger '${existingTrigger.eventType}'.`);
    }
  }
  return normalized;
}

function normalizeRoutineConfig(
  definition: BuiltInRoutineDefinition,
  config: SecondBrainRoutineConfig | undefined,
  fallback?: SecondBrainRoutineConfig,
): SecondBrainRoutineConfig | undefined {
  if (definition.manifest.id === 'topic-watch') {
    const topicQuery = config?.topicQuery?.trim() || fallback?.topicQuery?.trim() || '';
    if (!topicQuery) {
      throw new Error('Topic Watch routines require a topic to watch.');
    }
    return { topicQuery };
  }
  if (definition.manifest.id === 'deadline-watch') {
    const dueWithinHours = Number.isFinite(config?.dueWithinHours)
      ? Number(config?.dueWithinHours)
      : Number.isFinite(fallback?.dueWithinHours)
        ? Number(fallback?.dueWithinHours)
        : 24;
    if (!Number.isFinite(dueWithinHours) || dueWithinHours <= 0) {
      throw new Error('Deadline Watch routines require a positive due-within window in hours.');
    }
    const includeOverdue = typeof config?.includeOverdue === 'boolean'
      ? config.includeOverdue
      : typeof fallback?.includeOverdue === 'boolean'
        ? fallback.includeOverdue
        : true;
    return {
      dueWithinHours,
      includeOverdue,
    };
  }
  return undefined;
}

function slugifyRoutineIdSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function resolveRoutineRecordId(
  definition: BuiltInRoutineDefinition,
  name: string | undefined,
  config: SecondBrainRoutineConfig | undefined,
): string {
  if (!definition.allowMultiple) {
    return definition.manifest.id;
  }
  const preferredSegment = definition.manifest.id === 'topic-watch'
    ? config?.topicQuery?.trim()
    : definition.manifest.id === 'deadline-watch'
      ? `next-${Number(config?.dueWithinHours ?? 24)}-hours${config?.includeOverdue === false ? '-due' : '-with-overdue'}`
      : undefined;
  const explicitSegment = name?.trim();
  const chosenSegment = preferredSegment || explicitSegment || definition.manifest.name;
  const slug = slugifyRoutineIdSegment(chosenSegment);
  return slug ? `${definition.manifest.id}:${slug}` : `${definition.manifest.id}:${randomUUID()}`;
}

function resolveRoutineName(
  definition: BuiltInRoutineDefinition,
  name: string | undefined,
  config: SecondBrainRoutineConfig | undefined,
): string {
  const explicit = name?.trim();
  if (explicit) {
    return explicit;
  }
  if (definition.manifest.id === 'topic-watch' && config?.topicQuery?.trim()) {
    return `Topic Watch: ${config.topicQuery.trim()}`;
  }
  if (definition.manifest.id === 'deadline-watch' && Number.isFinite(config?.dueWithinHours)) {
    const hours = Number(config?.dueWithinHours);
    const overdueSuffix = config?.includeOverdue === false ? '' : ' + overdue';
    return `Deadline Watch: next ${hours} hour${hours === 1 ? '' : 's'}${overdueSuffix}`;
  }
  return definition.manifest.name;
}

function formatRoutineMinutesLabel(minutes: number, suffix: string): string {
  return `${minutes} minute${minutes === 1 ? '' : 's'} ${suffix}`;
}

function buildRoutineTimingView(
  definition: BuiltInRoutineDefinition,
  trigger: SecondBrainRoutineTrigger,
): SecondBrainRoutineTimingView {
  const editable = supportedTimingKindsForDefinition(definition)[0] !== 'background';
  if (trigger.mode === 'manual') {
    return {
      kind: 'manual',
      label: 'Manual only',
      editable,
    };
  }
  if (trigger.mode === 'cron') {
    const schedule = parseScheduleFromCron(trigger.cron);
    return {
      kind: 'scheduled',
      label: schedule ? summarizeRoutineSchedule(schedule) : 'Scheduled',
      editable,
      ...(schedule ? { schedule } : {}),
    };
  }
  if (trigger.mode === 'event' && trigger.eventType === 'upcoming_event') {
    const minutes = Number.isFinite(trigger.lookaheadMinutes) ? Number(trigger.lookaheadMinutes) : 60;
    return {
      kind: 'before_meetings',
      label: formatRoutineMinutesLabel(minutes, 'before meetings'),
      editable: true,
      minutes,
    };
  }
  if (trigger.mode === 'event' && trigger.eventType === 'event_ended') {
    const minutes = Number.isFinite(trigger.lookaheadMinutes) ? Number(trigger.lookaheadMinutes) : 1440;
    return {
      kind: 'after_meetings',
      label: formatRoutineMinutesLabel(minutes, 'after meetings end'),
      editable: true,
      minutes,
    };
  }
  const minutes = Number.isFinite(trigger.lookaheadMinutes) ? Number(trigger.lookaheadMinutes) : 1440;
  return {
    kind: 'background',
    label: `Background check across the next ${minutes} minute${minutes === 1 ? '' : 's'}`,
    editable: false,
    minutes,
  };
}

function buildRoutineTypeView(
  definition: BuiltInRoutineDefinition,
  configured: boolean,
  configuredRoutineId?: string,
): SecondBrainRoutineTypeView {
  return {
    templateId: definition.manifest.id,
    capability: definition.capability,
    name: definition.manifest.name,
    description: definition.description,
    category: definition.catalogCategory,
    seedByDefault: definition.seedByDefault,
    allowMultiple: definition.allowMultiple ?? false,
    configured,
    ...(configuredRoutineId ? { configuredRoutineId } : {}),
    defaultTiming: buildRoutineTimingView(definition, definition.manifest.trigger),
    supportedTiming: supportedTimingKindsForDefinition(definition),
    defaultDelivery: [...definition.manifest.deliveryDefaults],
    supportsTopicQuery: definition.manifest.id === 'topic-watch',
    supportsDeadlineWindow: definition.manifest.id === 'deadline-watch',
  };
}

function buildRoutineView(
  definition: BuiltInRoutineDefinition,
  routine: SecondBrainRoutineRecord,
): SecondBrainRoutineView {
  return {
    id: routine.id,
    templateId: routine.templateId,
    capability: definition.capability,
    name: routine.name,
    description: definition.description,
    category: definition.catalogCategory,
    enabled: routine.enabled,
    timing: buildRoutineTimingView(definition, routine.trigger),
    delivery: [...routine.deliveryDefaults],
    ...(routine.config?.topicQuery?.trim() ? { topicQuery: routine.config.topicQuery.trim() } : {}),
    ...(Number.isFinite(routine.config?.dueWithinHours) ? { dueWithinHours: Number(routine.config?.dueWithinHours) } : {}),
    ...(typeof routine.config?.includeOverdue === 'boolean' ? { includeOverdue: routine.config.includeOverdue } : {}),
    lastRunAt: routine.lastRunAt ?? null,
    createdAt: routine.createdAt,
    updatedAt: routine.updatedAt,
  };
}

function normalizeRoutineTimingInput(
  value: SecondBrainRoutineTimingInput | undefined,
): SecondBrainRoutineTimingInput | undefined {
  if (!value) return undefined;
  const kind = value.kind;
  if (!kind) return undefined;
  const schedule = value.schedule
    ? {
        cadence: value.schedule.cadence,
        time: value.schedule.time.trim(),
        ...(value.schedule.dayOfWeek ? { dayOfWeek: value.schedule.dayOfWeek } : {}),
      }
    : undefined;
  const minutes = Number.isFinite(value.minutes) ? Number(value.minutes) : undefined;
  return {
    kind,
    ...(schedule ? { schedule } : {}),
    ...(minutes != null ? { minutes } : {}),
  };
}

function resolveTriggerFromRoutineTimingInput(
  definition: BuiltInRoutineDefinition,
  timing: SecondBrainRoutineTimingInput,
  fallback: SecondBrainRoutineTrigger,
  routineName: string,
): SecondBrainRoutineTrigger {
  const normalized = normalizeRoutineTimingInput(timing);
  if (!normalized) {
    return cloneRoutineTrigger(fallback);
  }
  if (!supportedTimingKindsForDefinition(definition).includes(normalized.kind)) {
    throw new Error(`${routineName} does not support ${normalized.kind.replace(/_/g, ' ')} timing.`);
  }
  if (normalized.kind === 'manual') {
    return { mode: 'manual' };
  }
  if (normalized.kind === 'scheduled') {
    const fallbackSchedule = parseScheduleFromCron(fallback.cron);
    const defaultSchedule = parseScheduleFromCron(definition.manifest.trigger.cron);
    const schedule = normalized.schedule ?? fallbackSchedule ?? defaultSchedule;
    if (!schedule) {
      throw new Error(`${routineName} requires a supported daily or weekly schedule.`);
    }
    return {
      mode: 'cron',
      cron: buildCronFromSchedule(schedule),
    };
  }
  if (normalized.kind === 'before_meetings') {
    const minutes = Number.isFinite(normalized.minutes)
      ? Number(normalized.minutes)
      : Number.isFinite(fallback.lookaheadMinutes)
        ? Number(fallback.lookaheadMinutes)
        : 60;
    return {
      mode: 'event',
      eventType: 'upcoming_event',
      lookaheadMinutes: minutes,
    };
  }
  if (normalized.kind === 'after_meetings') {
    const minutes = Number.isFinite(normalized.minutes)
      ? Number(normalized.minutes)
      : Number.isFinite(fallback.lookaheadMinutes)
        ? Number(fallback.lookaheadMinutes)
        : 1440;
    return {
      mode: 'event',
      eventType: 'event_ended',
      lookaheadMinutes: minutes,
    };
  }
  return cloneRoutineTrigger(fallback);
}

function materializeRoutineRecord(
  definition: BuiltInRoutineDefinition,
  timestamp: number,
  overrides: Partial<Pick<SecondBrainRoutineRecord, 'id' | 'templateId' | 'name' | 'enabled' | 'deliveryDefaults' | 'defaultRoutingBias' | 'budgetProfileId' | 'trigger' | 'config'>> = {},
): SecondBrainRoutineRecord {
  return {
    ...cloneRoutineManifest(definition.manifest),
    id: overrides.id?.trim() || definition.manifest.id,
    templateId: overrides.templateId ?? definition.manifest.id as SecondBrainRoutineTemplateId,
    name: resolveRoutineName(definition, overrides.name, overrides.config),
    enabled: overrides.enabled ?? definition.manifest.enabledByDefault,
    trigger: overrides.trigger ? cloneRoutineTrigger(overrides.trigger) : cloneRoutineTrigger(definition.manifest.trigger),
    deliveryDefaults: overrides.deliveryDefaults ? [...overrides.deliveryDefaults] : [...definition.manifest.deliveryDefaults],
    defaultRoutingBias: overrides.defaultRoutingBias ?? definition.manifest.defaultRoutingBias,
    budgetProfileId: overrides.budgetProfileId ?? definition.manifest.budgetProfileId,
    ...(overrides.config ? { config: cloneRoutineConfig(overrides.config) } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    lastRunAt: null,
  };
}

function summarizeText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxChars
    ? `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
    : normalized;
}

function inferNoteTitle(content: string): string {
  const firstLine = content.split(/\r?\n/g)[0]?.trim() ?? '';
  return summarizeText(firstLine || content, 72) || 'Untitled note';
}

function inferPersonName(input: SecondBrainPersonUpsertInput): string {
  const explicit = input.name?.trim() ?? '';
  if (explicit) return explicit;
  const email = input.email?.trim() ?? '';
  if (!email.includes('@')) return '';
  const localPart = email.split('@')[0]?.replace(/[._-]+/g, ' ').trim() ?? '';
  const titleCased = localPart
    .split(/\s+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return summarizeText(titleCased, 72) || '';
}

function isAllowedLinkProtocol(url: URL): boolean {
  return ['http:', 'https:', 'file:'].includes(url.protocol);
}

function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function isWindowsUncPath(value: string): boolean {
  return /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function toPosixFileUrl(absolutePath: string): string {
  const fileUrl = new URL('file://');
  fileUrl.pathname = absolutePath;
  return fileUrl.toString();
}

function normalizeLinkUrl(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error('Library item URL is required.');
  }

  if (trimmed.startsWith('/')) {
    return toPosixFileUrl(trimmed);
  }

  if (isWindowsDrivePath(trimmed)) {
    return new URL(`file:///${trimmed.replace(/\\/g, '/')}`).toString();
  }

  if (isWindowsUncPath(trimmed)) {
    return new URL(`file:${trimmed.replace(/\\/g, '/')}`).toString();
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Library item URL must be a valid absolute URL or absolute file path.');
  }
  if (!isAllowedLinkProtocol(parsed)) {
    throw new Error('Library item URL must use http, https, or file.');
  }
  return parsed.toString();
}

export class SecondBrainService {
  private readonly store: SecondBrainStore;
  private readonly now: () => number;
  private readonly monthlyExternalTokenBudget: number;
  private readonly dailyExternalTokenBudget: number;
  private readonly quietBudgetMode: boolean;
  private readonly pauseOnOverage: boolean;

  constructor(store: SecondBrainStore, options: SecondBrainServiceOptions = {}) {
    this.store = store;
    this.now = options.now ?? Date.now;
    this.monthlyExternalTokenBudget = options.monthlyExternalTokenBudget ?? 25_000;
    this.dailyExternalTokenBudget = options.dailyExternalTokenBudget ?? 2_500;
    this.quietBudgetMode = options.quietBudgetMode ?? false;
    this.pauseOnOverage = options.pauseOnOverage ?? true;
    this.seedBuiltInRoutines();
  }

  private seedBuiltInRoutines(): void {
    const existingIds = new Set(this.store.routines.listRoutines().map((routine) => routine.id));
    const deletedIds = new Set(this.store.routines.listDeletedRoutineIds());
    const timestamp = this.now();
    for (const routine of BUILT_IN_ROUTINES) {
      if (!routine.seedByDefault) continue;
      if (existingIds.has(routine.manifest.id)) continue;
      if (deletedIds.has(routine.manifest.id)) continue;
      this.store.routines.upsertRoutine(materializeRoutineRecord(routine, timestamp, {
        templateId: routine.manifest.id as SecondBrainRoutineTemplateId,
      }));
    }
  }

  getOverview(): SecondBrainOverview {
    const counts = this.store.getCounts();
    const topTasks = this.store.tasks.listTasks({ status: 'open', limit: 6 });
    const recentNotes = this.store.notes.listNotes({ limit: 4 });
    const usage = this.getUsageSummary();
    const nextEvent = this.listEvents({ limit: 1, includePast: false })[0] ?? null;
    const routines = this.listRoutines();
    const briefs = this.store.briefs.listBriefs({ limit: 20 });

    return {
      generatedAt: this.now(),
      nextEvent,
      topTasks,
      recentNotes,
      enabledRoutineCount: routines.filter((routine) => routine.enabled).length,
      reminderCount: 0,
      followUpCount: briefs.filter((brief) => brief.kind === 'follow_up').length,
      briefCount: briefs.length,
      counts: {
        ...counts,
        routines: routines.length,
      },
      usage,
    };
  }

  listNotes(filter: SecondBrainNoteFilter = {}): SecondBrainNoteRecord[] {
    return this.store.notes.listNotes(filter);
  }

  upsertNote(input: SecondBrainNoteUpsertInput): SecondBrainNoteRecord {
    const content = input.content.trim();
    if (!content) {
      throw new Error('Note content is required.');
    }
    return this.store.notes.upsertNote({
      ...input,
      title: input.title?.trim() || inferNoteTitle(content),
      content,
    });
  }

  deleteNote(id: string): SecondBrainNoteRecord {
    const note = this.store.notes.deleteNote(id.trim());
    if (!note) {
      throw new Error(`Note '${id}' not found.`);
    }
    return note;
  }

  listTasks(filter: SecondBrainTaskFilter = {}): SecondBrainTaskRecord[] {
    return this.store.tasks.listTasks(filter);
  }

  upsertTask(input: SecondBrainTaskUpsertInput): SecondBrainTaskRecord {
    if (!input.title.trim()) {
      throw new Error('Task title is required.');
    }
    return this.store.tasks.upsertTask({
      ...input,
      title: input.title.trim(),
      details: input.details?.trim() || undefined,
    });
  }

  deleteTask(id: string): SecondBrainTaskRecord {
    const task = this.store.tasks.deleteTask(id.trim());
    if (!task) {
      throw new Error(`Task '${id}' not found.`);
    }
    return task;
  }

  listEvents(filter: SecondBrainEventFilter = {}): SecondBrainEventRecord[] {
    const includePast = filter.includePast ?? false;
    const fromTime = Number.isFinite(filter.fromTime)
      ? filter.fromTime
      : includePast
        ? 0
        : this.now();
    return this.store.calendar.listEvents({
      includePast,
      fromTime,
      toTime: Number.isFinite(filter.toTime) ? filter.toTime : undefined,
      limit: filter.limit,
    });
  }

  upsertEvent(input: SecondBrainEventUpsertInput): SecondBrainEventRecord {
    return this.upsertEventRecord(input, { allowProviderSource: false });
  }

  upsertSyncedEvent(input: SecondBrainEventUpsertInput): SecondBrainEventRecord {
    return this.upsertEventRecord(input, { allowProviderSource: true });
  }

  private upsertEventRecord(
    input: SecondBrainEventUpsertInput,
    options: { allowProviderSource: boolean },
  ): SecondBrainEventRecord {
    if (!input.title.trim()) {
      throw new Error('Event title is required.');
    }
    if (!Number.isFinite(input.startsAt)) {
      throw new Error('Event start time is required.');
    }
    if (input.endsAt != null && input.endsAt < input.startsAt) {
      throw new Error('Event end time must be after the start time.');
    }
    const id = input.id?.trim();
    const existing = id ? this.store.calendar.getEvent(id) : null;
    const resolvedSource = input.source ?? existing?.source ?? 'local';
    if (!options.allowProviderSource) {
      if (existing?.source && existing.source !== 'local') {
        throw new Error('Provider-synced calendar events are read-only in Second Brain. Update them in Google Calendar or Microsoft 365 instead.');
      }
      if (resolvedSource !== 'local') {
        throw new Error('Second Brain calendar mutations create and edit local Guardian calendar events only. Use explicit Google Workspace or Microsoft 365 calendar operations for provider changes.');
      }
    }
    return this.store.calendar.upsertEvent({
      ...input,
      ...(id ? { id } : {}),
      title: input.title.trim(),
      source: options.allowProviderSource ? resolvedSource : 'local',
      ...(input.location !== undefined ? { location: input.location.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
    });
  }

  deleteEvent(id: string): SecondBrainEventRecord {
    const existing = this.store.calendar.getEvent(id.trim());
    if (!existing) {
      throw new Error(`Event '${id}' not found.`);
    }
    if (existing.source !== 'local') {
      throw new Error('Provider-synced calendar events are read-only in Second Brain. Delete them in Google Calendar or Microsoft 365 instead.');
    }
    return this.store.calendar.deleteEvent(existing.id) ?? existing;
  }

  listPeople(filter: SecondBrainPersonFilter = {}): SecondBrainPersonRecord[] {
    return this.store.people.listPeople(filter);
  }

  upsertPerson(input: SecondBrainPersonUpsertInput): SecondBrainPersonRecord {
    const resolvedName = inferPersonName(input);
    if (!resolvedName) {
      throw new Error('Person name or email is required.');
    }
    return this.store.people.upsertPerson({
      ...input,
      name: resolvedName,
      email: input.email?.trim() || undefined,
      title: input.title?.trim() || undefined,
      company: input.company?.trim() || undefined,
      notes: input.notes?.trim() || undefined,
    });
  }

  deletePerson(id: string): SecondBrainPersonRecord {
    const person = this.store.people.deletePerson(id.trim());
    if (!person) {
      throw new Error(`Person '${id}' not found.`);
    }
    return person;
  }

  listLinks(filter: SecondBrainLinkFilter = {}): SecondBrainLinkRecord[] {
    return this.store.links.listLinks(filter);
  }

  upsertLink(input: SecondBrainLinkUpsertInput): SecondBrainLinkRecord {
    const normalizedUrl = normalizeLinkUrl(input.url);
    return this.store.links.upsertLink({
      ...input,
      url: normalizedUrl,
      title: input.title?.trim() || undefined,
      summary: input.summary?.trim() || undefined,
    });
  }

  deleteLink(id: string): SecondBrainLinkRecord {
    const link = this.store.links.deleteLink(id.trim());
    if (!link) {
      throw new Error(`Library item '${id}' not found.`);
    }
    return link;
  }

  listRoutineRecords(): SecondBrainRoutineRecord[] {
    return this.store.routines.listRoutines().filter((routine) => {
      const definition = BUILT_IN_ROUTINES_BY_ID.get(routine.templateId ?? routine.id);
      return isAssistantVisibleRoutineDefinition(definition);
    });
  }

  listRoutines(): SecondBrainRoutineView[] {
    return this.listRoutineRecords().flatMap((routine) => {
      const definition = BUILT_IN_ROUTINES_BY_ID.get(routine.templateId ?? routine.id);
      return definition ? [buildRoutineView(definition, routine)] : [];
    });
  }

  listRoutineCatalog(): SecondBrainRoutineTypeView[] {
    const routines = this.listRoutineRecords();
    const configuredByTemplate = new Map<string, SecondBrainRoutineRecord[]>();
    for (const routine of routines) {
      const templateId = routine.templateId ?? routine.id;
      const existing = configuredByTemplate.get(templateId) ?? [];
      existing.push(routine);
      configuredByTemplate.set(templateId, existing);
    }
    return BUILT_IN_ROUTINES
      .filter((definition) => isAssistantVisibleRoutineDefinition(definition))
      .map((definition) => {
      const configuredRoutines = configuredByTemplate.get(definition.manifest.id) ?? [];
      return buildRoutineTypeView(
        definition,
        configuredRoutines.length > 0,
        configuredRoutines.length === 1 ? configuredRoutines[0]!.id : undefined,
      );
      });
  }

  isSeededBuiltInRoutine(id: string): boolean {
    const existing = this.getRoutineRecordById(id);
    const definition = BUILT_IN_ROUTINES_BY_ID.get(existing?.templateId ?? id);
    return definition?.seedByDefault ?? false;
  }

  createRoutine(input: SecondBrainRoutineCreateInput): SecondBrainRoutineView {
    const templateId = input.templateId.trim();
    const definition = BUILT_IN_ROUTINES_BY_ID.get(templateId);
    if (!definition) {
      throw new Error(`Routine template '${templateId}' not found.`);
    }
    if (!isAssistantVisibleRoutineDefinition(definition)) {
      throw new Error(`Routine '${definition.manifest.name}' is now a direct action, not a configurable assistant routine.`);
    }
    const configuredRoutines = this.listRoutineRecords().filter((routine) => (routine.templateId ?? routine.id) === templateId);
    if (!definition.allowMultiple && configuredRoutines.length > 0) {
      throw new Error(`Routine '${definition.manifest.name}' already exists.`);
    }

    const timestamp = this.now();
    const config = normalizeRoutineConfig(definition, input.config);
    let routineId = resolveRoutineRecordId(definition, input.name, config);
    while (this.getRoutineRecordById(routineId)) {
      routineId = `${definition.manifest.id}:${randomUUID().slice(0, 8)}`;
    }
    const trigger = input.timing
      ? resolveTriggerFromRoutineTimingInput(definition, input.timing, definition.manifest.trigger, definition.manifest.name)
      : input.trigger
        ? resolveRoutineTriggerOverride(input.trigger, definition.manifest.trigger, definition.manifest.name)
        : cloneRoutineTrigger(definition.manifest.trigger);
    const routine = materializeRoutineRecord(definition, timestamp, {
      id: routineId,
      templateId: templateId as SecondBrainRoutineTemplateId,
      name: input.name,
      enabled: input.enabled,
      trigger,
      config,
      deliveryDefaults: input.delivery ?? input.deliveryDefaults,
      defaultRoutingBias: input.defaultRoutingBias,
      budgetProfileId: input.budgetProfileId,
    });
    if (!definition.allowMultiple) {
      this.store.routines.clearRoutineDeletion(templateId);
    }
    this.store.routines.upsertRoutine(routine);
    return buildRoutineView(definition, routine);
  }

  getRoutineRecordById(id: string): SecondBrainRoutineRecord | null {
    return this.store.routines.getRoutine(id);
  }

  getRoutineById(id: string): SecondBrainRoutineView | null {
    const record = this.getRoutineRecordById(id);
    if (!record) return null;
    const definition = BUILT_IN_ROUTINES_BY_ID.get(record.templateId ?? record.id);
    return definition ? buildRoutineView(definition, record) : null;
  }

  updateRoutine(input: SecondBrainRoutineUpdateInput): SecondBrainRoutineView {
    const existing = this.store.routines.getRoutine(input.id);
    if (!existing) {
      throw new Error(`Routine '${input.id}' not found.`);
    }
    const definition = BUILT_IN_ROUTINES_BY_ID.get(existing.templateId ?? existing.id);
    const config = definition
      ? normalizeRoutineConfig(definition, input.config, existing.config)
      : cloneRoutineConfig(existing.config);
    const shouldRefreshDerivedName = Boolean(
      !input.name?.trim()
      && definition
      && (
        (definition.manifest.id === 'topic-watch' && input.config?.topicQuery?.trim() && existing.name.startsWith('Topic Watch: '))
        || (definition.manifest.id === 'deadline-watch'
          && (Number.isFinite(input.config?.dueWithinHours) || typeof input.config?.includeOverdue === 'boolean')
          && existing.name.startsWith('Deadline Watch: '))
      ),
    );
    const updated: SecondBrainRoutineRecord = {
      ...existing,
      name: input.name?.trim()
        || (shouldRefreshDerivedName && definition ? resolveRoutineName(definition, undefined, config) : existing.name),
      enabled: input.enabled ?? existing.enabled,
      trigger: input.timing && definition
        ? resolveTriggerFromRoutineTimingInput(definition, input.timing, existing.trigger, existing.name)
        : input.trigger
          ? resolveRoutineTriggerOverride(input.trigger, existing.trigger, existing.name)
          : cloneRoutineTrigger(existing.trigger),
      config,
      deliveryDefaults: input.delivery ?? input.deliveryDefaults ?? existing.deliveryDefaults,
      defaultRoutingBias: input.defaultRoutingBias ?? existing.defaultRoutingBias,
      budgetProfileId: input.budgetProfileId ?? existing.budgetProfileId,
      updatedAt: this.now(),
    };
    this.store.routines.upsertRoutine(updated);
    return definition ? buildRoutineView(definition, updated) : this.getRoutineById(updated.id)!;
  }

  deleteRoutine(id: string): SecondBrainRoutineRecord {
    const routineId = id.trim();
    const routine = this.store.routines.deleteRoutine(routineId);
    if (!routine) {
      throw new Error(`Routine '${id}' not found.`);
    }
    const templateId = routine.templateId ?? routine.id;
    const definition = BUILT_IN_ROUTINES_BY_ID.get(templateId);
    if (definition?.seedByDefault && !definition.allowMultiple) {
      this.store.routines.markRoutineDeleted(templateId);
    }
    return routine;
  }

  markRoutineRun(id: string, ranAt = this.now()): SecondBrainRoutineRecord {
    const routine = this.getRoutineRecordById(id);
    if (!routine) {
      throw new Error(`Routine '${id}' not found.`);
    }
    const updated: SecondBrainRoutineRecord = {
      ...routine,
      lastRunAt: ranAt,
      updatedAt: ranAt,
    };
    this.store.routines.upsertRoutine(updated);
    return updated;
  }

  getEventById(id: string): SecondBrainEventRecord | null {
    return this.store.calendar.getEvent(id);
  }

  getTaskById(id: string): SecondBrainTaskRecord | null {
    return this.store.tasks.getTask(id);
  }

  getPersonById(id: string): SecondBrainPersonRecord | null {
    return this.store.people.getPerson(id);
  }

  listBriefs(filter: SecondBrainBriefFilter = {}): SecondBrainBriefRecord[] {
    return this.store.briefs.listBriefs(filter);
  }

  getBriefById(id: string): SecondBrainBriefRecord | null {
    return this.store.briefs.getBrief(id);
  }

  saveBrief(brief: SecondBrainBriefRecord): SecondBrainBriefRecord {
    return this.store.briefs.upsertBrief(brief);
  }

  upsertBrief(input: SecondBrainBriefUpsertInput): SecondBrainBriefRecord {
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title) {
      throw new Error('Brief title is required.');
    }
    if (!content) {
      throw new Error('Brief content is required.');
    }

    const now = this.now();
    const id = input.id?.trim() || `brief:manual:${randomUUID()}`;
    const existing = this.store.briefs.getBrief(id);
    const kind = input.kind ?? existing?.kind ?? 'manual';
    return this.store.briefs.upsertBrief({
      id,
      kind,
      title,
      content,
      generatedAt: input.generatedAt ?? existing?.generatedAt ?? now,
      routineId: input.routineId ?? existing?.routineId,
      eventId: input.eventId ?? existing?.eventId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  updateBrief(input: SecondBrainBriefUpdateInput): SecondBrainBriefRecord {
    const id = input.id.trim();
    const existing = this.store.briefs.getBrief(id);
    if (!existing) {
      throw new Error(`Brief '${input.id}' not found.`);
    }
    if (input.title == null && input.content == null) {
      throw new Error('Brief update requires a title or content change.');
    }

    const nextTitle = input.title == null ? existing.title : input.title.trim();
    const nextContent = input.content == null ? existing.content : input.content.trim();
    if (!nextTitle) {
      throw new Error('Brief title is required.');
    }
    if (!nextContent) {
      throw new Error('Brief content is required.');
    }

    return this.store.briefs.upsertBrief({
      ...existing,
      title: nextTitle,
      content: nextContent,
      updatedAt: this.now(),
    });
  }

  deleteBrief(id: string): SecondBrainBriefRecord {
    const brief = this.store.briefs.deleteBrief(id.trim());
    if (!brief) {
      throw new Error(`Brief '${id}' not found.`);
    }
    return brief;
  }

  getSyncCursorById(id: string): SecondBrainSyncCursorRecord | null {
    return this.store.syncCursors.getSyncCursor(id);
  }

  saveSyncCursor(cursor: SecondBrainSyncCursorRecord): SecondBrainSyncCursorRecord {
    return this.store.syncCursors.upsertSyncCursor(cursor);
  }

  recordUsage(record: Omit<SecondBrainUsageRecord, 'timestamp' | 'route' | 'totalTokens'> & {
    timestamp?: number;
    totalTokens?: number;
  }): void {
    this.store.usage.appendUsageRecord({
      timestamp: record.timestamp ?? this.now(),
      route: 'personal_assistant_task',
      featureArea: record.featureArea,
      featureId: record.featureId,
      provider: record.provider,
      locality: record.locality,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      totalTokens: record.totalTokens ?? (record.promptTokens + record.completionTokens),
      connectorCalls: record.connectorCalls,
      outboundAction: record.outboundAction,
    });
  }

  listUsage(limit = 50): SecondBrainUsageRecord[] {
    return this.store.usage.listUsageRecords(limit);
  }

  getUsageSummary(): SecondBrainUsageSummary {
    const records = this.store.usage.listUsageRecords(500);
    return records.reduce<SecondBrainUsageSummary>((summary, record) => ({
      ...summary,
      totalRecords: summary.totalRecords + 1,
      localTokens: summary.localTokens + (record.locality === 'local' ? record.totalTokens : 0),
      externalTokens: summary.externalTokens + (record.locality === 'external' ? record.totalTokens : 0),
      totalConnectorCalls: summary.totalConnectorCalls + (record.connectorCalls ?? 0),
    }), {
      totalRecords: 0,
      localTokens: 0,
      externalTokens: 0,
      totalConnectorCalls: 0,
      monthlyBudget: this.monthlyExternalTokenBudget,
      dailyBudget: this.dailyExternalTokenBudget,
      quietBudgetMode: this.quietBudgetMode,
      pauseOnOverage: this.pauseOnOverage,
    });
  }

  summarizeEntityKind(kind: SecondBrainEntityKind): string {
    switch (kind) {
      case 'task':
        return 'tasks';
      case 'note':
        return 'notes';
      case 'routine':
        return 'routines';
      case 'calendar':
        return 'calendar';
      case 'person':
        return 'people';
      default:
        return 'overview';
    }
  }
}
