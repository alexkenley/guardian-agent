import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { BriefingService } from './briefing-service.js';
import { SecondBrainService } from './second-brain-service.js';
import { SecondBrainStore } from './second-brain-store.js';

function createFixture() {
  const sqlitePath = join(tmpdir(), `guardianagent-second-brain-briefing-${randomUUID()}.sqlite`);
  const nowState = { value: Date.parse('2026-04-04T09:00:00Z') };
  const now = () => nowState.value;
  const store = new SecondBrainStore({ sqlitePath, now });
  const service = new SecondBrainService(store, { now });
  const briefing = new BriefingService(service, { now });
  return {
    store,
    service,
    briefing,
    tick(step = 1_000) {
      nowState.value += step;
    },
  };
}

describe('BriefingService', () => {
  it('generates and persists a deterministic morning brief', async () => {
    const { service, briefing } = createFixture();

    service.upsertTask({
      title: 'Prepare board pack',
      priority: 'high',
      dueAt: Date.parse('2026-04-04T13:00:00Z'),
    });
    service.upsertSyncedEvent({
      id: 'meeting-1',
      title: 'Board prep',
      startsAt: Date.parse('2026-04-04T10:00:00Z'),
      source: 'google',
      location: 'Zoom',
    });
    service.upsertNote({
      title: 'Board prep notes',
      content: 'Confirm headcount assumptions before the meeting.',
    });

    const brief = await briefing.generateMorningBrief();

    expect(brief.kind).toBe('morning');
    expect(brief.title).toContain('Morning Brief');
    expect(brief.content).toContain('Board prep');
    expect(brief.content).toContain('Prepare board pack');
    expect(service.listBriefs({ kind: 'morning' })).toHaveLength(1);
  });

  it('builds a pre-meeting brief from matching tasks, notes, and people', async () => {
    const { service, briefing } = createFixture();

    const event = service.upsertSyncedEvent({
      id: 'event-42',
      title: 'Launch Review',
      startsAt: Date.parse('2026-04-04T10:30:00Z'),
      source: 'microsoft',
      location: 'Teams',
    });
    service.upsertTask({
      title: 'Finalize launch review deck',
      details: 'Collect the final numbers.',
      priority: 'high',
    });
    service.upsertNote({
      title: 'Launch review prep',
      content: 'Need to settle pricing before the launch review.',
    });
    service.upsertPerson({
      name: 'Taylor Launch',
      company: 'Example Co',
      title: 'Product Marketing Lead',
      notes: 'Primary stakeholder for launch review',
    });

    const brief = await briefing.generatePreMeetingBrief(event.id);

    expect(brief.kind).toBe('pre_meeting');
    expect(brief.eventId).toBe(event.id);
    expect(brief.content).toContain('Launch Review');
    expect(brief.content).toContain('Finalize launch review deck');
    expect(brief.content).toContain('Launch review prep');
    expect(brief.content).toContain('Taylor Launch');
  });

  it('builds a weekly review that covers events, tasks, notes, people, and library items', async () => {
    const { service, briefing } = createFixture();

    service.upsertTask({
      title: 'Review launch blockers',
      priority: 'high',
    });
    service.upsertSyncedEvent({
      id: 'event-weekly',
      title: 'Launch Steering',
      startsAt: Date.parse('2026-04-06T10:00:00Z'),
      source: 'google',
      location: 'Zoom',
    });
    service.upsertNote({
      title: 'Weekly planning note',
      content: 'Need to tighten the launch handoff this week.',
    });
    service.upsertPerson({
      name: 'Jordan Lee',
      company: 'Harbor Labs',
      title: 'Design Lead',
      notes: 'Owner for launch review follow-up.',
    });
    service.upsertLink({
      title: 'Launch checklist',
      url: 'https://example.test/launch-checklist',
      kind: 'reference',
      summary: 'Reference checklist for the launch review.',
    });

    const brief = await briefing.generateWeeklyReview();

    expect(brief.kind).toBe('weekly_review');
    expect(brief.title).toContain('Weekly Review');
    expect(brief.content).toContain('Launch Steering');
    expect(brief.content).toContain('Review launch blockers');
    expect(brief.content).toContain('Weekly planning note');
    expect(brief.content).toContain('Jordan Lee');
    expect(brief.content).toContain('Launch checklist');
  });
});
