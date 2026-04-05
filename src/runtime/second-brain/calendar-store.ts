import { randomUUID } from 'node:crypto';
import type { SecondBrainEventFilter, SecondBrainEventRecord, SecondBrainEventUpsertInput } from './types.js';
import { clone } from './utils.js';
import type { SecondBrainStoreContext } from './second-brain-store.js';

function parseEventPayload(value: unknown): { description?: string } {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      description: typeof parsed.description === 'string' && parsed.description.trim()
        ? parsed.description.trim()
        : undefined,
    };
  } catch {
    return {};
  }
}

function rowToEvent(row: Record<string, unknown>): SecondBrainEventRecord {
  const payload = parseEventPayload(row.payload_json);
  return {
    id: String(row.id),
    title: String(row.title),
    description: payload.description,
    startsAt: Number(row.starts_at),
    endsAt: row.ends_at == null ? null : Number(row.ends_at),
    source: row.source as SecondBrainEventRecord['source'],
    location: row.location == null ? undefined : String(row.location),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class CalendarStore {
  constructor(private readonly ctx: SecondBrainStoreContext) {}

  listEvents(filter: SecondBrainEventFilter = {}): SecondBrainEventRecord[] {
    const limit = Math.max(1, filter.limit ?? 20);
    const includePast = filter.includePast === true;
    const fromTime = typeof filter.fromTime === 'number' && Number.isFinite(filter.fromTime)
      ? filter.fromTime
      : 0;
    const toTime = typeof filter.toTime === 'number' && Number.isFinite(filter.toTime)
      ? filter.toTime
      : null;
    if (this.ctx.mode === 'memory') {
      return [...this.ctx.memory.events.values()]
        .filter((event) => {
          const overlapsLowerBound = includePast || (event.endsAt ?? event.startsAt) >= fromTime;
          if (!overlapsLowerBound) return false;
          if (toTime == null) return true;
          return event.startsAt <= toTime;
        })
        .sort((left, right) => left.startsAt - right.startsAt)
        .slice(0, limit)
        .map(clone);
    }

    const rows = includePast && toTime == null
      ? this.ctx.db!.prepare(`
        SELECT id, title, starts_at, ends_at, source, location, payload_json, created_at, updated_at
        FROM sb_events
        ORDER BY starts_at ASC
        LIMIT ?
      `).all(limit)
      : toTime == null
        ? this.ctx.db!.prepare(`
        SELECT id, title, starts_at, ends_at, source, location, payload_json, created_at, updated_at
        FROM sb_events
        WHERE COALESCE(ends_at, starts_at) >= ?
        ORDER BY starts_at ASC
        LIMIT ?
      `).all(fromTime, limit)
      : this.ctx.db!.prepare(`
        SELECT id, title, starts_at, ends_at, source, location, payload_json, created_at, updated_at
        FROM sb_events
        WHERE COALESCE(ends_at, starts_at) >= ?
          AND starts_at <= ?
        ORDER BY starts_at ASC
        LIMIT ?
      `).all(fromTime, toTime, limit);
    return (rows as Array<Record<string, unknown>>).map(rowToEvent);
  }

  upsertEvent(input: SecondBrainEventUpsertInput): SecondBrainEventRecord {
    const timestamp = this.ctx.now();
    const id = input.id?.trim() || randomUUID();
    const existing = this.getEvent(id);
    const event: SecondBrainEventRecord = {
      id,
      title: input.title.trim(),
      description: input.description === undefined ? existing?.description : (input.description.trim() || undefined),
      startsAt: input.startsAt,
      endsAt: input.endsAt === undefined ? (existing?.endsAt ?? null) : input.endsAt,
      source: input.source ?? existing?.source ?? 'local',
      location: input.location === undefined ? existing?.location : (input.location.trim() || undefined),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const payloadJson = JSON.stringify({
      description: event.description ?? null,
    });

    if (this.ctx.mode === 'memory') {
      this.ctx.memory.events.set(event.id, clone(event));
      return event;
    }

    this.ctx.db!.prepare(`
      INSERT INTO sb_events (id, title, starts_at, ends_at, source, location, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        source = excluded.source,
        location = excluded.location,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      event.id,
      event.title,
      event.startsAt,
      event.endsAt ?? null,
      event.source,
      event.location ?? null,
      payloadJson,
      event.createdAt,
      event.updatedAt,
    );
    return event;
  }

  getEvent(id: string): SecondBrainEventRecord | null {
    if (this.ctx.mode === 'memory') {
      const event = this.ctx.memory.events.get(id);
      return event ? clone(event) : null;
    }

    const row = this.ctx.db!.prepare(`
      SELECT id, title, starts_at, ends_at, source, location, payload_json, created_at, updated_at
      FROM sb_events
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToEvent(row);
  }
}
