import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SecondBrainStore } from './second-brain-store.js';
import { SecondBrainService } from './second-brain-service.js';

function createService() {
  const sqlitePath = join(tmpdir(), `guardianagent-second-brain-${randomUUID()}.sqlite`);
  const nowState = { value: 1_710_000_000_000 };
  const now = () => nowState.value;
  const store = new SecondBrainStore({ sqlitePath, now });
  const service = new SecondBrainService(store, { now });
  return {
    service,
    store,
    sqlitePath,
    tick(step = 1_000) {
      nowState.value += step;
    },
    close() {
      store.close();
    },
  };
}

describe('SecondBrainService', () => {
  it('seeds built-in routines and exposes a stable overview shape', () => {
    const { service } = createService();

    const overview = service.getOverview();

    expect(overview.enabledRoutineCount).toBeGreaterThan(0);
    expect(overview.counts.routines).toBeGreaterThan(0);
    expect(overview.topTasks).toEqual([]);
    expect(overview.recentNotes).toEqual([]);
    expect(overview.usage.monthlyBudget).toBeGreaterThan(0);
  });

  it('creates notes and infers a note title when missing', () => {
    const { service } = createService();

    const note = service.upsertNote({
      content: 'Quarterly planning notes\nNeed to rebalance meeting load.',
      tags: ['planning', 'meetings'],
    });

    expect(note.title).toBe('Quarterly planning notes');
    expect(service.listNotes()[0]?.id).toBe(note.id);
  });

  it('creates tasks, keeps open tasks in overview, and tracks completion timestamps', () => {
    const { service, tick } = createService();

    const openTask = service.upsertTask({
      title: 'Prepare staffing review',
      details: 'Pull notes from the last 1:1s.',
      priority: 'high',
      dueAt: 1_710_000_100_000,
    });
    tick();
    const doneTask = service.upsertTask({
      title: 'Send venue confirmation',
      status: 'done',
    });

    const overview = service.getOverview();
    const openTasks = service.listTasks({ status: 'open' });

    expect(openTask.status).toBe('todo');
    expect(doneTask.completedAt).toBeTruthy();
    expect(openTasks).toHaveLength(1);
    expect(openTasks[0]?.id).toBe(openTask.id);
    expect(overview.topTasks.map((task) => task.id)).toContain(openTask.id);
    expect(overview.topTasks.map((task) => task.id)).not.toContain(doneTask.id);
  });

  it('updates routines and aggregates usage', () => {
    const { service } = createService();

    const routine = service.listRoutines()[0];
    expect(routine).toBeTruthy();

    const updated = service.updateRoutine({
      id: routine!.id,
      enabled: false,
      trigger: { mode: 'cron', cron: '0 9 * * *' },
      defaultRoutingBias: 'balanced',
    });
    service.recordUsage({
      featureArea: 'routine',
      featureId: updated.id,
      locality: 'external',
      promptTokens: 120,
      completionTokens: 30,
      connectorCalls: 2,
    });

    const usage = service.getUsageSummary();

    expect(updated.enabled).toBe(false);
    expect(updated.trigger).toEqual({ mode: 'cron', cron: '0 9 * * *' });
    expect(updated.defaultRoutingBias).toBe('balanced');
    expect(usage.externalTokens).toBe(150);
    expect(usage.totalConnectorCalls).toBe(2);
  });

  it('exposes the built-in routine catalog and creates non-seeded routines on demand', () => {
    const { service } = createService();

    const catalog = service.listRoutineCatalog();
    const preMeetingEntry = catalog.find((entry) => entry.templateId === 'pre-meeting-brief');

    expect(preMeetingEntry?.configured).toBe(false);

    const created = service.createRoutine({
      templateId: 'pre-meeting-brief',
      defaultRoutingBias: 'quality_first',
      deliveryDefaults: ['web', 'cli'],
    });

    expect(created.id).toBe('pre-meeting-brief');
    expect(created.defaultRoutingBias).toBe('quality_first');
    expect(created.deliveryDefaults).toEqual(['web', 'cli']);
    expect(service.listRoutineCatalog().find((entry) => entry.templateId === 'pre-meeting-brief')?.configured).toBe(true);
  });

  it('stores upcoming events and people through the shared service', () => {
    const { service, tick } = createService();

    service.upsertEvent({
      title: 'Past catch-up',
      startsAt: 1_709_999_900_000,
      endsAt: 1_709_999_960_000,
    });
    tick();
    const nextEvent = service.upsertEvent({
      title: 'Board prep',
      startsAt: 1_710_000_600_000,
      location: 'Zoom',
    });
    const person = service.upsertPerson({
      email: 'alex.pm@example.com',
      title: 'Product Lead',
      company: 'Example Co',
      relationship: 'work',
    });

    const overview = service.getOverview();
    const events = service.listEvents({ limit: 5 });
    const people = service.listPeople({ limit: 5 });

    expect(nextEvent.source).toBe('local');
    expect(overview.nextEvent?.id).toBe(nextEvent.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe('Board prep');
    expect(person.name).toBe('Alex Pm');
    expect(people[0]?.id).toBe(person.id);
  });

  it('supports range-based calendar reads for month views', () => {
    const { service } = createService();

    service.upsertEvent({
      title: 'Quarter wrap',
      startsAt: 1_709_913_600_000,
      endsAt: 1_709_917_200_000,
    });
    const inRange = service.upsertEvent({
      title: 'Planning day',
      startsAt: 1_710_172_800_000,
      endsAt: 1_710_176_400_000,
    });
    service.upsertEvent({
      title: 'April review',
      startsAt: 1_712_764_800_000,
      endsAt: 1_712_768_400_000,
    });

    const events = service.listEvents({
      fromTime: 1_710_086_400_000,
      toTime: 1_710_259_199_999,
      limit: 20,
    });

    expect(events.map((event) => event.id)).toEqual([inRange.id]);
  });

  it('stores event descriptions and lets users clear event details later', () => {
    const { service } = createService();

    const created = service.upsertEvent({
      title: 'Board prep',
      description: 'Review the hiring plan and settle the final slide order.',
      startsAt: 1_710_172_800_000,
      location: 'Zoom',
    });

    expect(service.getEventById(created.id)?.description).toBe('Review the hiring plan and settle the final slide order.');
    expect(service.getEventById(created.id)?.location).toBe('Zoom');

    const updated = service.upsertEvent({
      id: created.id,
      title: created.title,
      description: '',
      startsAt: created.startsAt,
      location: '',
    });

    expect(updated.description).toBeUndefined();
    expect(updated.location).toBeUndefined();
    expect(service.getEventById(created.id)?.description).toBeUndefined();
  });

  it('allows local calendar CRUD but keeps provider-synced events read-only in Second Brain', () => {
    const { service } = createService();

    const synced = service.upsertSyncedEvent({
      id: 'google:event:test',
      title: 'Provider sync',
      startsAt: 1_710_172_800_000,
      source: 'google',
    });
    const local = service.upsertEvent({
      title: 'Local planning block',
      startsAt: 1_710_176_400_000,
      location: 'Desk',
    });

    const updatedLocal = service.upsertEvent({
      id: local.id,
      title: 'Local planning block',
      startsAt: local.startsAt,
      location: 'Meeting room',
    });

    expect(updatedLocal.location).toBe('Meeting room');
    expect(service.deleteEvent(local.id).id).toBe(local.id);
    expect(service.getEventById(local.id)).toBeNull();
    expect(() => service.upsertEvent({
      id: synced.id,
      title: synced.title,
      startsAt: synced.startsAt,
    })).toThrow(/read-only/i);
    expect(() => service.deleteEvent(synced.id)).toThrow(/read-only/i);
  });

  it('stores and filters library links through the shared service', () => {
    const { service, tick } = createService();

    const architecture = service.upsertLink({
      title: 'Forward Architecture',
      url: 'https://example.test/docs/forward-architecture',
      summary: 'Module boundaries and target state.',
      kind: 'reference',
      tags: ['architecture', 'docs'],
    });
    tick();
    const runbook = service.upsertLink({
      title: 'Incident Runbook',
      url: 'file:///tmp/runbook.md',
      summary: 'Local operational checklist.',
      kind: 'document',
      tags: ['ops'],
    });

    expect(service.listLinks({ limit: 10 }).map((link) => link.id)).toEqual([runbook.id, architecture.id]);
    expect(service.listLinks({ query: 'architecture', limit: 10 })[0]?.id).toBe(architecture.id);
    expect(service.listLinks({ kind: 'document', limit: 10 })[0]?.id).toBe(runbook.id);
  });

  it('accepts absolute file paths for library items', () => {
    const { service } = createService();

    const posixPath = service.upsertLink({
      title: 'Runbook',
      url: '/tmp/ops runbook.md',
      kind: 'file',
    });
    const windowsPath = service.upsertLink({
      title: 'Windows Runbook',
      url: 'C:\\Ops\\Daily Runbook.md',
      kind: 'file',
    });

    expect(posixPath.url).toBe('file:///tmp/ops%20runbook.md');
    expect(windowsPath.url).toBe('file:///C:/Ops/Daily%20Runbook.md');
  });

  it('updates saved briefs through the shared service', () => {
    const { service, tick } = createService();
    const timestamp = 1_710_000_000_000;

    service.saveBrief({
      id: 'brief-edit-test',
      kind: 'morning',
      title: 'Original brief',
      content: 'Original content.',
      generatedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    tick();

    const updated = service.updateBrief({
      id: 'brief-edit-test',
      title: 'Edited brief',
      content: 'Edited content.',
    });

    expect(updated.title).toBe('Edited brief');
    expect(updated.content).toBe('Edited content.');
    expect(updated.updatedAt).toBeGreaterThan(timestamp);
    expect(service.getBriefById('brief-edit-test')?.title).toBe('Edited brief');
  });

  it('deletes notes, tasks, people, links, and briefs through the shared service', () => {
    const { service } = createService();
    const timestamp = 1_710_000_000_000;

    const note = service.upsertNote({ content: 'Delete me.' });
    const task = service.upsertTask({ title: 'Delete task' });
    const person = service.upsertPerson({ name: 'Delete Person' });
    const link = service.upsertLink({ url: 'https://example.test/delete-me', title: 'Delete link' });
    service.saveBrief({
      id: 'brief-delete-test',
      kind: 'morning',
      title: 'Delete brief',
      content: 'Delete this brief record.',
      generatedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(service.deleteNote(note.id).id).toBe(note.id);
    expect(service.deleteTask(task.id).id).toBe(task.id);
    expect(service.deletePerson(person.id).id).toBe(person.id);
    expect(service.deleteLink(link.id).id).toBe(link.id);
    expect(service.deleteBrief('brief-delete-test').id).toBe('brief-delete-test');
    expect(service.listNotes()).toEqual([]);
    expect(service.listTasks()).toEqual([]);
    expect(service.listPeople()).toEqual([]);
    expect(service.listLinks()).toEqual([]);
    expect(service.listBriefs()).toEqual([]);
  });

  it('keeps deleted seeded routines removed across service restart until re-created', () => {
    const sqlitePath = join(tmpdir(), `guardianagent-second-brain-${randomUUID()}.sqlite`);
    const now = () => 1_710_000_000_000;

    const firstStore = new SecondBrainStore({ sqlitePath, now });
    const firstService = new SecondBrainService(firstStore, { now });
    expect(firstService.getRoutineById('morning-brief')).toBeTruthy();

    firstService.deleteRoutine('morning-brief');
    expect(firstService.getRoutineById('morning-brief')).toBeNull();
    firstStore.close();

    const secondStore = new SecondBrainStore({ sqlitePath, now });
    const secondService = new SecondBrainService(secondStore, { now });

    expect(secondService.getRoutineById('morning-brief')).toBeNull();
    expect(secondService.listRoutineCatalog().find((entry) => entry.templateId === 'morning-brief')?.configured).toBe(false);
    expect(secondService.createRoutine({ templateId: 'morning-brief' }).id).toBe('morning-brief');
    secondStore.close();
  });
});
