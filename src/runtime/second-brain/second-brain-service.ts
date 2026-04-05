import {
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
  type SecondBrainRoutineRecord,
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

const BUILT_IN_ROUTINES: Array<Omit<SecondBrainRoutineRecord, 'createdAt' | 'updatedAt' | 'lastRunAt'>> = [
  {
    id: 'morning-brief',
    name: 'Morning Brief',
    category: 'daily',
    enabledByDefault: true,
    enabled: true,
    trigger: { mode: 'cron', cron: '0 7 * * *' },
    workloadClass: 'B',
    externalCommMode: 'none',
    budgetProfileId: 'daily-low',
    deliveryDefaults: ['web', 'telegram'],
    defaultRoutingBias: 'local_first',
  },
  {
    id: 'next-24-hours-radar',
    name: 'Next 24 Hours Radar',
    category: 'daily',
    enabledByDefault: true,
    enabled: true,
    trigger: { mode: 'horizon', lookaheadMinutes: 1440 },
    workloadClass: 'B',
    externalCommMode: 'none',
    budgetProfileId: 'daily-low',
    deliveryDefaults: ['web'],
    defaultRoutingBias: 'local_first',
  },
  {
    id: 'weekly-review',
    name: 'Weekly Review',
    category: 'daily',
    enabledByDefault: true,
    enabled: true,
    trigger: { mode: 'cron', cron: '0 9 * * 1' },
    workloadClass: 'C',
    externalCommMode: 'none',
    budgetProfileId: 'weekly-medium',
    deliveryDefaults: ['web'],
    defaultRoutingBias: 'balanced',
  },
  {
    id: 'pre-meeting-brief',
    name: 'Pre-Meeting Brief',
    category: 'meeting',
    enabledByDefault: true,
    enabled: true,
    trigger: { mode: 'event', eventType: 'calendar:event.upcoming', lookaheadMinutes: 60 },
    workloadClass: 'B',
    externalCommMode: 'none',
    budgetProfileId: 'meeting-low',
    deliveryDefaults: ['web', 'telegram'],
    defaultRoutingBias: 'local_first',
  },
  {
    id: 'follow-up-watch',
    name: 'Follow-Up Watch',
    category: 'follow_up',
    enabledByDefault: true,
    enabled: true,
    trigger: { mode: 'cron', cron: '0 */4 * * *' },
    workloadClass: 'C',
    externalCommMode: 'draft_only',
    budgetProfileId: 'follow-up-medium',
    deliveryDefaults: ['web'],
    defaultRoutingBias: 'balanced',
  },
];

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
    const timestamp = this.now();
    for (const routine of BUILT_IN_ROUTINES) {
      if (existingIds.has(routine.id)) continue;
      this.store.routines.upsertRoutine({
        ...routine,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastRunAt: null,
      });
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
    if (!input.title.trim()) {
      throw new Error('Event title is required.');
    }
    if (!Number.isFinite(input.startsAt)) {
      throw new Error('Event start time is required.');
    }
    if (input.endsAt != null && input.endsAt < input.startsAt) {
      throw new Error('Event end time must be after the start time.');
    }
    return this.store.calendar.upsertEvent({
      ...input,
      title: input.title.trim(),
      source: input.source ?? 'local',
      ...(input.location !== undefined ? { location: input.location.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
    });
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

  listLinks(filter: SecondBrainLinkFilter = {}): SecondBrainLinkRecord[] {
    return this.store.links.listLinks(filter);
  }

  upsertLink(input: SecondBrainLinkUpsertInput): SecondBrainLinkRecord {
    const rawUrl = input.url.trim();
    if (!rawUrl) {
      throw new Error('Library item URL is required.');
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('Library item URL must be a valid absolute URL.');
    }
    if (!isAllowedLinkProtocol(parsed)) {
      throw new Error('Library item URL must use http, https, or file.');
    }
    return this.store.links.upsertLink({
      ...input,
      url: parsed.toString(),
      title: input.title?.trim() || undefined,
      summary: input.summary?.trim() || undefined,
    });
  }

  listRoutines(): SecondBrainRoutineRecord[] {
    return this.store.routines.listRoutines();
  }

  getRoutineById(id: string): SecondBrainRoutineRecord | null {
    return this.store.routines.listRoutines().find((routine) => routine.id === id) ?? null;
  }

  updateRoutine(input: SecondBrainRoutineUpdateInput): SecondBrainRoutineRecord {
    const existing = this.store.routines.listRoutines().find((routine) => routine.id === input.id);
    if (!existing) {
      throw new Error(`Routine '${input.id}' not found.`);
    }
    const updated: SecondBrainRoutineRecord = {
      ...existing,
      enabled: input.enabled ?? existing.enabled,
      deliveryDefaults: input.deliveryDefaults ?? existing.deliveryDefaults,
      defaultRoutingBias: input.defaultRoutingBias ?? existing.defaultRoutingBias,
      budgetProfileId: input.budgetProfileId ?? existing.budgetProfileId,
      updatedAt: this.now(),
    };
    this.store.routines.upsertRoutine(updated);
    return updated;
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

  listBriefs(filter: SecondBrainBriefFilter = {}): SecondBrainBriefRecord[] {
    return this.store.briefs.listBriefs(filter);
  }

  getBriefById(id: string): SecondBrainBriefRecord | null {
    return this.store.briefs.getBrief(id);
  }

  saveBrief(brief: SecondBrainBriefRecord): SecondBrainBriefRecord {
    return this.store.briefs.upsertBrief(brief);
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
