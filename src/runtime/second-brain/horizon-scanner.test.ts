import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { BriefingService } from './briefing-service.js';
import { HorizonScanner } from './horizon-scanner.js';
import { SecondBrainService } from './second-brain-service.js';
import { SecondBrainStore } from './second-brain-store.js';

function createFixture() {
  const sqlitePath = join(tmpdir(), `guardianagent-second-brain-horizon-${randomUUID()}.sqlite`);
  const nowState = { value: Date.parse('2026-04-04T09:00:00Z') };
  const now = () => nowState.value;
  const store = new SecondBrainStore({ sqlitePath, now });
  const service = new SecondBrainService(store, { now });
  const briefing = new BriefingService(service, { now });
  const scheduledTaskService = {
    created: [] as Array<Record<string, unknown>>,
    updated: [] as Array<Record<string, unknown>>,
    list() {
      return [];
    },
    create(input: Record<string, unknown>) {
      this.created.push(input);
      return { success: true, message: 'created' };
    },
    update(id: string, input: Record<string, unknown>) {
      this.updated.push({ id, ...input });
      return { success: true, message: 'updated' };
    },
  };
  return {
    store,
    service,
    briefing,
    scheduledTaskService,
    now,
  };
}

describe('HorizonScanner', () => {
  it('registers the executable scheduled task target', () => {
    const { service, briefing, scheduledTaskService, now } = createFixture();
    const syncService = {
      async syncAll() {
        return {
          startedAt: now(),
          finishedAt: now(),
          reason: 'test',
          providers: [],
        };
      },
    };

    const scanner = new HorizonScanner(
      scheduledTaskService as any,
      service,
      syncService as any,
      briefing,
      { now },
    );

    scanner.start();

    expect(scheduledTaskService.created).toHaveLength(1);
    expect(scheduledTaskService.created[0]?.target).toBe('second_brain_horizon_scan');
  });

  it('runs sync and triggers morning, pre-meeting, and follow-up routines deterministically', async () => {
    const { service, briefing, scheduledTaskService, now } = createFixture();

    service.upsertTask({
      title: 'Finalize board deck',
      priority: 'high',
    });
    service.upsertSyncedEvent({
      id: 'upcoming-1',
      title: 'Board Sync',
      startsAt: Date.parse('2026-04-04T09:30:00Z'),
      endsAt: Date.parse('2026-04-04T10:00:00Z'),
      source: 'google',
    });
    service.upsertSyncedEvent({
      id: 'past-1',
      title: 'Client Check-In',
      startsAt: Date.parse('2026-04-04T07:00:00Z'),
      endsAt: Date.parse('2026-04-04T07:30:00Z'),
      source: 'microsoft',
    });
    const syncService = {
      async syncAll(reason: string) {
        return {
          startedAt: now(),
          finishedAt: now(),
          reason,
          providers: [{
            provider: 'google' as const,
            skipped: false,
            eventsSynced: 1,
            peopleSynced: 0,
            connectorCalls: 1,
          }],
        };
      },
    };

    const scanner = new HorizonScanner(
      scheduledTaskService as any,
      service,
      syncService as any,
      briefing,
      { now },
    );

    const summary = await scanner.runScan('test');

    expect(summary.sync.reason).toBe('horizon:test');
    expect(summary.triggeredRoutines).toContain('morning-brief');
    expect(summary.triggeredRoutines).toContain('pre-meeting-brief');
    expect(summary.triggeredRoutines).toContain('follow-up-watch');
    expect(summary.generatedBriefIds).toEqual(expect.arrayContaining([
      'brief:morning:2026-04-04',
      'brief:pre_meeting:upcoming-1',
      'brief:follow_up:past-1',
    ]));
  });

  it('generates a weekly review brief when the weekly starter routine is due', async () => {
    const sqlitePath = join(tmpdir(), `guardianagent-second-brain-horizon-${randomUUID()}.sqlite`);
    const nowState = { value: Date.parse('2026-04-06T09:30:00Z') };
    const now = () => nowState.value;
    const store = new SecondBrainStore({ sqlitePath, now });
    const service = new SecondBrainService(store, { now });
    const briefing = new BriefingService(service, { now });
    const scheduledTaskService = {
      list() {
        return [];
      },
      create() {
        return { success: true, message: 'created' };
      },
      update() {
        return { success: true, message: 'updated' };
      },
    };

    service.upsertTask({
      title: 'Close weekly review actions',
      priority: 'medium',
    });

    const syncService = {
      async syncAll(reason: string) {
        return {
          startedAt: now(),
          finishedAt: now(),
          reason,
          providers: [],
        };
      },
    };

    const scanner = new HorizonScanner(
      scheduledTaskService as any,
      service,
      syncService as any,
      briefing,
      { now },
    );

    const summary = await scanner.runScan('test');

    expect(summary.triggeredRoutines).toContain('weekly-review');
    expect(summary.generatedBriefIds).toContain('brief:weekly_review:2026-04-06');
    expect(service.getBriefById('brief:weekly_review:2026-04-06')?.kind).toBe('weekly_review');
    store.close();
  });
});
