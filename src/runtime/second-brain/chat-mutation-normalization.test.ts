import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecondBrainService } from './second-brain-service.js';
import { SecondBrainStore } from './second-brain-store.js';
import { normalizeSecondBrainMutationArgs } from './chat-mutation-normalization.js';

function createService(referenceTime = new Date(2026, 3, 5, 0, 20, 0, 0).getTime()) {
  const sqlitePath = join(tmpdir(), `guardianagent-second-brain-normalizer-${randomUUID()}.sqlite`);
  const store = new SecondBrainStore({ sqlitePath, now: () => referenceTime });
  const service = new SecondBrainService(store, { now: () => referenceTime });
  return {
    service,
    close() {
      store.close();
    },
  };
}

describe('normalizeSecondBrainMutationArgs', () => {
  it('resolves explicit local calendar times from the user request instead of model-guessed timestamps', () => {
    const referenceTime = new Date(2026, 3, 5, 0, 20, 0, 0).getTime();
    const { service, close } = createService(referenceTime);

    try {
      const normalized = normalizeSecondBrainMutationArgs({
        toolName: 'second_brain_calendar_upsert',
        args: {
          title: "Doctor's Appointment",
          startsAt: referenceTime + (24 * 60 * 60 * 1000),
          endsAt: referenceTime + (25 * 60 * 60 * 1000),
        },
        userContent: "Can you add a new calendar entry for tomorrow at 12 pm for a doctor's appointment?",
        referenceTime,
        getEventById: (id) => service.getEventById(id),
      });

      expect(normalized.startsAt).toBe(new Date(2026, 3, 6, 12, 0, 0, 0).getTime());
      expect(normalized.endsAt).toBe(new Date(2026, 3, 6, 13, 0, 0, 0).getTime());
    } finally {
      close();
    }
  });

  it('preserves an existing event time and duration when the user only changes the date', () => {
    const referenceTime = new Date(2026, 3, 5, 9, 0, 0, 0).getTime();
    const { service, close } = createService(referenceTime);

    try {
      const event = service.upsertEvent({
        title: 'Team sync',
        startsAt: new Date(2026, 3, 5, 15, 30, 0, 0).getTime(),
        endsAt: new Date(2026, 3, 5, 17, 0, 0, 0).getTime(),
      });

      const normalized = normalizeSecondBrainMutationArgs({
        toolName: 'second_brain_calendar_upsert',
        args: {
          id: event.id,
          title: event.title,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
        },
        userContent: 'Move that event to tomorrow.',
        referenceTime,
        getEventById: (id) => service.getEventById(id),
      });

      expect(normalized.startsAt).toBe(new Date(2026, 3, 6, 15, 30, 0, 0).getTime());
      expect(normalized.endsAt).toBe(new Date(2026, 3, 6, 17, 0, 0, 0).getTime());
    } finally {
      close();
    }
  });

  it('assigns a deterministic due time for new tasks when the user gives only a date', () => {
    const referenceTime = new Date(2026, 3, 5, 10, 15, 0, 0).getTime();
    const { service, close } = createService(referenceTime);

    try {
      const normalized = normalizeSecondBrainMutationArgs({
        toolName: 'second_brain_task_upsert',
        args: {
          title: 'File the referral paperwork',
          dueAt: referenceTime,
        },
        userContent: 'Create a task to file the referral paperwork tomorrow.',
        referenceTime,
        getTaskById: (id) => service.getTaskById(id),
      });

      expect(normalized.dueAt).toBe(new Date(2026, 3, 6, 17, 0, 0, 0).getTime());
    } finally {
      close();
    }
  });

  it('preserves an existing task due time when the user only moves the date', () => {
    const referenceTime = new Date(2026, 3, 5, 10, 15, 0, 0).getTime();
    const { service, close } = createService(referenceTime);

    try {
      const task = service.upsertTask({
        title: 'Prepare agenda',
        dueAt: new Date(2026, 3, 5, 14, 45, 0, 0).getTime(),
      });

      const normalized = normalizeSecondBrainMutationArgs({
        toolName: 'second_brain_task_upsert',
        args: {
          id: task.id,
          title: task.title,
          dueAt: task.dueAt,
        },
        userContent: 'Move that task to tomorrow.',
        referenceTime,
        getTaskById: (id) => service.getTaskById(id),
      });

      expect(normalized.dueAt).toBe(new Date(2026, 3, 6, 14, 45, 0, 0).getTime());
    } finally {
      close();
    }
  });

  it('preserves existing contact time when the user updates only the contact date', () => {
    const referenceTime = new Date(2026, 3, 5, 9, 0, 0, 0).getTime();
    const { service, close } = createService(referenceTime);

    try {
      const person = service.upsertPerson({
        name: 'Alex Example',
        lastContactAt: new Date(2026, 3, 2, 16, 45, 0, 0).getTime(),
      });

      const normalized = normalizeSecondBrainMutationArgs({
        toolName: 'second_brain_person_upsert',
        args: {
          id: person.id,
          name: person.name,
          lastContactAt: person.lastContactAt,
        },
        userContent: 'I talked to Alex yesterday.',
        referenceTime,
        getPersonById: (id) => service.getPersonById(id),
      });

      expect(normalized.lastContactAt).toBe(new Date(2026, 3, 4, 16, 45, 0, 0).getTime());
    } finally {
      close();
    }
  });
});
