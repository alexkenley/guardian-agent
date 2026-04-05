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
});
