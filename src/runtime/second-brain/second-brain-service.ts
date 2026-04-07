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
  type SecondBrainRoutineCreateInput,
  type SecondBrainRoutineManifest,
  type SecondBrainRoutineRecord,
  type SecondBrainRoutineTrigger,
  type SecondBrainRoutineUpdateInput,
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
  description: string;
  catalogCategory: SecondBrainRoutineCatalogEntry['category'];
  seedByDefault: boolean;
  manifest: SecondBrainRoutineManifest;
}

const BUILT_IN_ROUTINES: BuiltInRoutineDefinition[] = [
  {
    description: 'Creates the daily morning brief after the local workday starts.',
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
      deliveryDefaults: ['web', 'telegram'],
      defaultRoutingBias: 'local_first',
    },
  },
  {
    description: 'Produces the weekly review summary on the default Monday schedule.',
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
      deliveryDefaults: ['web'],
      defaultRoutingBias: 'balanced',
    },
  },
  {
    description: 'Runs provider sync manually to refresh calendar and people context on demand.',
    catalogCategory: 'maintenance',
    seedByDefault: true,
    manifest: {
      id: 'one-off-sync',
      name: 'Manual Sync',
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
    description: 'Marks the horizon scan when upcoming events or open tasks make the next day worth reviewing.',
    catalogCategory: 'daily',
    seedByDefault: false,
    manifest: {
      id: 'next-24-hours-radar',
      name: 'Next 24 Hours Radar',
      category: 'scheduled',
      enabledByDefault: true,
      trigger: { mode: 'horizon', lookaheadMinutes: 1440 },
      workloadClass: 'A',
      externalCommMode: 'none',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['web'],
      defaultRoutingBias: 'local_first',
    },
  },
  {
    description: 'Generates a pre-meeting brief for upcoming events inside the default lookahead window.',
    catalogCategory: 'meeting',
    seedByDefault: false,
    manifest: {
      id: 'pre-meeting-brief',
      name: 'Pre-Meeting Brief',
      category: 'scheduled',
      enabledByDefault: true,
      trigger: { mode: 'event', eventType: 'upcoming_event', lookaheadMinutes: 60 },
      workloadClass: 'B',
      externalCommMode: 'none',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['web'],
      defaultRoutingBias: 'balanced',
    },
  },
  {
    description: 'Drafts follow-up packets for recently ended meetings that do not already have one.',
    catalogCategory: 'follow_up',
    seedByDefault: false,
    manifest: {
      id: 'follow-up-watch',
      name: 'Follow-Up Watch',
      category: 'scheduled',
      enabledByDefault: true,
      trigger: { mode: 'event', eventType: 'event_ended', lookaheadMinutes: 1440 },
      workloadClass: 'B',
      externalCommMode: 'draft_only',
      budgetProfileId: 'daily-low',
      deliveryDefaults: ['web'],
      defaultRoutingBias: 'balanced',
    },
  },
];

const BUILT_IN_ROUTINES_BY_ID = new Map(BUILT_IN_ROUTINES.map((routine) => [routine.manifest.id, routine]));

function cloneRoutineTrigger(trigger: SecondBrainRoutineTrigger): SecondBrainRoutineTrigger {
  return {
    mode: trigger.mode,
    ...(trigger.cron ? { cron: trigger.cron } : {}),
    ...(trigger.eventType ? { eventType: trigger.eventType } : {}),
    ...(Number.isFinite(trigger.lookaheadMinutes) ? { lookaheadMinutes: trigger.lookaheadMinutes } : {}),
  };
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

function materializeRoutineRecord(
  definition: BuiltInRoutineDefinition,
  timestamp: number,
  overrides: Partial<Pick<SecondBrainRoutineRecord, 'name' | 'enabled' | 'deliveryDefaults' | 'defaultRoutingBias' | 'budgetProfileId' | 'trigger'>> = {},
): SecondBrainRoutineRecord {
  return {
    ...cloneRoutineManifest(definition.manifest),
    name: overrides.name?.trim() || definition.manifest.name,
    enabled: overrides.enabled ?? definition.manifest.enabledByDefault,
    trigger: overrides.trigger ? cloneRoutineTrigger(overrides.trigger) : cloneRoutineTrigger(definition.manifest.trigger),
    deliveryDefaults: overrides.deliveryDefaults ? [...overrides.deliveryDefaults] : [...definition.manifest.deliveryDefaults],
    defaultRoutingBias: overrides.defaultRoutingBias ?? definition.manifest.defaultRoutingBias,
    budgetProfileId: overrides.budgetProfileId ?? definition.manifest.budgetProfileId,
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
      this.store.routines.upsertRoutine(materializeRoutineRecord(routine, timestamp));
    }
  }

  getOverview(): SecondBrainOverview {
    const counts = this.store.getCounts();
    const topTasks = this.store.tasks.listTasks({ status: 'open', limit: 6 });
    const recentNotes = this.store.notes.listNotes({ limit: 4 });
    const usage = this.getUsageSummary();
    const nextEvent = this.listEvents({ limit: 1, includePast: false })[0] ?? null;
    const routines = this.store.routines.listRoutines();
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
      counts,
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

  listRoutines(): SecondBrainRoutineRecord[] {
    return this.store.routines.listRoutines();
  }

  listRoutineCatalog(): SecondBrainRoutineCatalogEntry[] {
    const existing = new Map(this.listRoutines().map((routine) => [routine.id, routine]));
    return BUILT_IN_ROUTINES.map((definition) => {
      const configured = existing.get(definition.manifest.id);
      return {
        templateId: definition.manifest.id,
        name: definition.manifest.name,
        description: definition.description,
        category: definition.catalogCategory,
        seedByDefault: definition.seedByDefault,
        manifest: cloneRoutineManifest(definition.manifest),
        configured: Boolean(configured),
        ...(configured ? { configuredRoutineId: configured.id } : {}),
      };
    });
  }

  isSeededBuiltInRoutine(id: string): boolean {
    return BUILT_IN_ROUTINES_BY_ID.get(id)?.seedByDefault ?? false;
  }

  createRoutine(input: SecondBrainRoutineCreateInput): SecondBrainRoutineRecord {
    const templateId = input.templateId.trim();
    const definition = BUILT_IN_ROUTINES_BY_ID.get(templateId);
    if (!definition) {
      throw new Error(`Routine template '${templateId}' not found.`);
    }
    if (this.getRoutineById(templateId)) {
      throw new Error(`Routine '${definition.manifest.name}' already exists.`);
    }

    const timestamp = this.now();
    const trigger = input.trigger
      ? resolveRoutineTriggerOverride(input.trigger, definition.manifest.trigger, definition.manifest.name)
      : cloneRoutineTrigger(definition.manifest.trigger);
    const routine = materializeRoutineRecord(definition, timestamp, {
      name: input.name,
      enabled: input.enabled,
      trigger,
      deliveryDefaults: input.deliveryDefaults,
      defaultRoutingBias: input.defaultRoutingBias,
      budgetProfileId: input.budgetProfileId,
    });
    this.store.routines.clearRoutineDeletion(templateId);
    this.store.routines.upsertRoutine(routine);
    return routine;
  }

  getRoutineById(id: string): SecondBrainRoutineRecord | null {
    return this.store.routines.getRoutine(id);
  }

  updateRoutine(input: SecondBrainRoutineUpdateInput): SecondBrainRoutineRecord {
    const existing = this.store.routines.getRoutine(input.id);
    if (!existing) {
      throw new Error(`Routine '${input.id}' not found.`);
    }
    const updated: SecondBrainRoutineRecord = {
      ...existing,
      name: input.name?.trim() || existing.name,
      enabled: input.enabled ?? existing.enabled,
      trigger: input.trigger
        ? resolveRoutineTriggerOverride(input.trigger, existing.trigger, existing.name)
        : cloneRoutineTrigger(existing.trigger),
      deliveryDefaults: input.deliveryDefaults ?? existing.deliveryDefaults,
      defaultRoutingBias: input.defaultRoutingBias ?? existing.defaultRoutingBias,
      budgetProfileId: input.budgetProfileId ?? existing.budgetProfileId,
      updatedAt: this.now(),
    };
    this.store.routines.upsertRoutine(updated);
    return updated;
  }

  deleteRoutine(id: string): SecondBrainRoutineRecord {
    const routineId = id.trim();
    const routine = this.store.routines.deleteRoutine(routineId);
    if (!routine) {
      throw new Error(`Routine '${id}' not found.`);
    }
    if (BUILT_IN_ROUTINES_BY_ID.has(routineId)) {
      this.store.routines.markRoutineDeleted(routineId);
    }
    return routine;
  }

  markRoutineRun(id: string, ranAt = this.now()): SecondBrainRoutineRecord {
    const routine = this.getRoutineById(id);
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
