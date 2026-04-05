import { randomUUID } from 'node:crypto';
import type { SecondBrainService } from './second-brain-service.js';
import type {
  SecondBrainBriefKind,
  SecondBrainBriefRecord,
  SecondBrainEventRecord,
  SecondBrainGenerateBriefInput,
  SecondBrainNoteRecord,
  SecondBrainPersonRecord,
  SecondBrainTaskRecord,
} from './types.js';

interface BriefingServiceOptions {
  now?: () => number;
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

function summarizeText(value: string | undefined, maxChars: number): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxChars
    ? `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
    : normalized;
}

function formatDateTime(value: number): string {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDate(value: number): string {
  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function buildBriefId(kind: SecondBrainBriefKind, now: number, eventId?: string): string {
  if (kind === 'morning') {
    return `brief:morning:${new Date(now).toISOString().slice(0, 10)}`;
  }
  if (eventId?.trim()) {
    return `brief:${kind}:${eventId.trim()}`;
  }
  return `brief:${kind}:${randomUUID()}`;
}

function titleForBrief(kind: SecondBrainBriefKind, event?: SecondBrainEventRecord, now?: number): string {
  switch (kind) {
    case 'morning':
      return `Morning Brief for ${formatDate(now ?? Date.now())}`;
    case 'pre_meeting':
      return `Pre-Meeting Brief: ${event?.title ?? 'Unknown event'}`;
    case 'follow_up':
      return `Follow-Up Draft: ${event?.title ?? 'Unknown event'}`;
  }
}

function extractKeywords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && !STOP_WORDS.has(part));
}

function includesKeyword(haystack: string, keywords: string[]): boolean {
  const normalized = haystack.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}

function renderTaskLine(task: SecondBrainTaskRecord): string {
  const due = task.dueAt ? ` due ${formatDateTime(task.dueAt)}` : '';
  const details = task.details ? ` ${summarizeText(task.details, 90)}` : '';
  return `- [${task.priority}] ${task.title}${due}${details ? ` :: ${details}` : ''}`;
}

function renderNoteLine(note: SecondBrainNoteRecord): string {
  return `- ${note.title}: ${summarizeText(note.content, 120)}`;
}

function renderPersonLine(person: SecondBrainPersonRecord): string {
  const details = [person.title, person.company, person.email].filter(Boolean).join(' · ');
  return details
    ? `- ${person.name} (${details})`
    : `- ${person.name}`;
}

function renderEventLine(event: SecondBrainEventRecord): string {
  const timeRange = event.endsAt
    ? `${formatDateTime(event.startsAt)} to ${formatDateTime(event.endsAt)}`
    : formatDateTime(event.startsAt);
  const details = event.location
    ? `${event.title} at ${timeRange} · ${event.location}`
    : `${event.title} at ${timeRange}`;
  return event.description
    ? `- ${details} :: ${summarizeText(event.description, 120)}`
    : `- ${details}`;
}

export class BriefingService {
  private readonly now: () => number;

  constructor(
    private readonly secondBrainService: SecondBrainService,
    options: BriefingServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  start(): void {}

  async generateBrief(input: SecondBrainGenerateBriefInput): Promise<SecondBrainBriefRecord> {
    switch (input.kind) {
      case 'morning':
        return this.generateMorningBrief();
      case 'pre_meeting':
        if (!input.eventId?.trim()) {
          throw new Error('eventId is required for a pre_meeting brief.');
        }
        return this.generatePreMeetingBrief(input.eventId);
      case 'follow_up':
        if (!input.eventId?.trim()) {
          throw new Error('eventId is required for a follow_up draft.');
        }
        return this.draftFollowUp(input.eventId);
      default:
        throw new Error(`Unsupported brief kind '${String((input as { kind?: unknown }).kind)}'.`);
    }
  }

  async generateMorningBrief(): Promise<SecondBrainBriefRecord> {
    const now = this.now();
    const upcomingEvents = this.secondBrainService.listEvents({
      fromTime: now,
      includePast: false,
      limit: 5,
    });
    const openTasks = this.secondBrainService.listTasks({ status: 'open', limit: 5 });
    const recentNotes = this.secondBrainService.listNotes({ limit: 3 });
    const routines = this.secondBrainService.listRoutines().filter((routine) => routine.enabled);

    const sections = [
      'Overview',
      `- Generated ${formatDateTime(now)}`,
      upcomingEvents.length > 0
        ? `- Next event: ${upcomingEvents[0]!.title} at ${formatDateTime(upcomingEvents[0]!.startsAt)}`
        : '- No upcoming events on the shared calendar.',
      openTasks.length > 0
        ? `- Priority task: ${openTasks[0]!.title}`
        : '- No open tasks captured right now.',
      '',
      'Upcoming Events',
      ...(upcomingEvents.length > 0
        ? upcomingEvents.map(renderEventLine)
        : ['- No synced events in the current horizon.']),
      '',
      'Open Tasks',
      ...(openTasks.length > 0
        ? openTasks.map(renderTaskLine)
        : ['- No open tasks.']),
      '',
      'Recent Notes',
      ...(recentNotes.length > 0
        ? recentNotes.map(renderNoteLine)
        : ['- No recent notes.']),
      '',
      'Enabled Routines',
      ...(routines.length > 0
        ? routines.slice(0, 5).map((routine) => `- ${routine.name} (${routine.defaultRoutingBias})`)
        : ['- No enabled routines.']),
    ];

    const brief = this.persistBrief({
      id: buildBriefId('morning', now),
      kind: 'morning',
      title: titleForBrief('morning', undefined, now),
      content: sections.join('\n'),
      generatedAt: now,
      routineId: 'morning-brief',
    });

    this.secondBrainService.recordUsage({
      featureArea: 'brief',
      featureId: brief.id,
      provider: 'second_brain',
      locality: 'local',
      promptTokens: 0,
      completionTokens: 0,
    });

    return brief;
  }

  async generatePreMeetingBrief(eventId: string): Promise<SecondBrainBriefRecord> {
    const event = this.secondBrainService.getEventById(eventId);
    if (!event) {
      throw new Error(`Event '${eventId}' not found.`);
    }

    const now = this.now();
    const keywords = extractKeywords([event.title, event.description].filter(Boolean).join(' '));
    const relatedTasks = this.secondBrainService.listTasks({ status: 'open', limit: 25 })
      .filter((task) => {
        if (task.dueAt != null && task.dueAt < now - (24 * 60 * 60 * 1000)) return false;
        const haystack = [task.title, task.details].filter(Boolean).join(' ');
        return keywords.length === 0 || includesKeyword(haystack, keywords);
      })
      .slice(0, 5);
    const relatedNotes = this.secondBrainService.listNotes({ limit: 25 })
      .filter((note) => {
        const haystack = `${note.title} ${note.content}`;
        return keywords.length === 0 || includesKeyword(haystack, keywords);
      })
      .slice(0, 4);
    const relatedPeople = this.secondBrainService.listPeople({ limit: 25 })
      .filter((person) => {
        const haystack = [person.name, person.company, person.title, person.notes].filter(Boolean).join(' ');
        return keywords.length === 0 || includesKeyword(haystack, keywords);
      })
      .slice(0, 4);

    const sections = [
      'Meeting Snapshot',
      renderEventLine(event),
      '',
      'Relevant People',
      ...(relatedPeople.length > 0
        ? relatedPeople.map(renderPersonLine)
        : ['- No linked people were inferred from the current data set.']),
      '',
      'Relevant Tasks',
      ...(relatedTasks.length > 0
        ? relatedTasks.map(renderTaskLine)
        : ['- No matching open tasks.']),
      '',
      'Relevant Notes',
      ...(relatedNotes.length > 0
        ? relatedNotes.map(renderNoteLine)
        : ['- No matching notes.']),
      '',
      'Focus',
      '- Confirm the decision points reflected in the open tasks.',
      '- Resolve any ambiguous follow-up captured in the recent notes before the meeting ends.',
    ];

    const brief = this.persistBrief({
      id: buildBriefId('pre_meeting', now, event.id),
      kind: 'pre_meeting',
      title: titleForBrief('pre_meeting', event),
      content: sections.join('\n'),
      generatedAt: now,
      eventId: event.id,
      routineId: 'pre-meeting-brief',
    });

    this.secondBrainService.recordUsage({
      featureArea: 'brief',
      featureId: brief.id,
      provider: event.source,
      locality: event.source === 'local' ? 'local' : 'external',
      promptTokens: 0,
      completionTokens: 0,
    });

    return brief;
  }

  async draftFollowUp(eventId: string): Promise<SecondBrainBriefRecord> {
    const event = this.secondBrainService.getEventById(eventId);
    if (!event) {
      throw new Error(`Event '${eventId}' not found.`);
    }

    const relatedTasks = this.secondBrainService.listTasks({ status: 'open', limit: 25 })
      .filter((task) => !task.dueAt || task.dueAt >= event.startsAt - (24 * 60 * 60 * 1000))
      .slice(0, 5);
    const recentNotes = this.secondBrainService.listNotes({ limit: 5 });

    const sections = [
      `Subject: Follow-up from ${event.title}`,
      '',
      'Draft',
      `Hi team,`,
      '',
      `Thanks again for the time on ${formatDateTime(event.startsAt)}. Here is the current follow-up packet from the shared assistant context:`,
      '',
      'Outstanding Tasks',
      ...(relatedTasks.length > 0
        ? relatedTasks.map(renderTaskLine)
        : ['- No open follow-up tasks were captured.']),
      '',
      'Recent Notes',
      ...(recentNotes.length > 0
        ? recentNotes.map(renderNoteLine)
        : ['- No recent notes were attached to the follow-up queue.']),
      '',
      'Suggested Close',
      '- Confirm owners and dates for anything still open.',
      '- Reply with corrections before sending externally.',
    ];

    const now = this.now();
    const brief = this.persistBrief({
      id: buildBriefId('follow_up', now, event.id),
      kind: 'follow_up',
      title: titleForBrief('follow_up', event),
      content: sections.join('\n'),
      generatedAt: now,
      eventId: event.id,
      routineId: 'follow-up-watch',
    });

    this.secondBrainService.recordUsage({
      featureArea: 'draft',
      featureId: brief.id,
      provider: event.source,
      locality: event.source === 'local' ? 'local' : 'external',
      promptTokens: 0,
      completionTokens: 0,
      outboundAction: 'email_draft',
    });

    return brief;
  }

  private persistBrief(input: Omit<SecondBrainBriefRecord, 'createdAt' | 'updatedAt'>): SecondBrainBriefRecord {
    const existing = this.secondBrainService.getBriefById(input.id);
    const timestamp = this.now();
    return this.secondBrainService.saveBrief({
      ...input,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }
}
