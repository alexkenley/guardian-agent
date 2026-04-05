import { randomUUID } from 'node:crypto';
import type { SecondBrainPersonFilter, SecondBrainPersonRecord, SecondBrainPersonUpsertInput } from './types.js';
import { clone } from './utils.js';
import type { SecondBrainStoreContext } from './second-brain-store.js';

export class PeopleStore {
  constructor(private readonly ctx: SecondBrainStoreContext) {}

  listPeople(filter: SecondBrainPersonFilter = {}): SecondBrainPersonRecord[] {
    const limit = Math.max(1, filter.limit ?? 50);
    const query = filter.query?.trim().toLowerCase() ?? '';
    if (this.ctx.mode === 'memory') {
      return [...this.ctx.memory.people.values()]
        .filter((person) => {
          if (!query) return true;
          const haystack = [
            person.name,
            person.email,
            person.title,
            person.company,
            person.notes,
            person.relationship,
          ]
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
            .join(' ')
            .toLowerCase();
          return haystack.includes(query);
        })
        .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name))
        .slice(0, limit)
        .map(clone);
    }

    const rows = query
      ? this.ctx.db!.prepare(`
        SELECT id, payload_json, created_at, updated_at
        FROM sb_people
        WHERE LOWER(payload_json) LIKE ?
        ORDER BY updated_at DESC, id ASC
        LIMIT ?
      `).all(`%${query}%`, limit)
      : this.ctx.db!.prepare(`
        SELECT id, payload_json, created_at, updated_at
        FROM sb_people
        ORDER BY updated_at DESC, id ASC
        LIMIT ?
      `).all(limit);

    return (rows as Array<Record<string, unknown>>).map((row) => {
      const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      return {
        id: String(row.id),
        name: String(payload.name ?? ''),
        email: payload.email == null ? undefined : String(payload.email),
        title: payload.title == null ? undefined : String(payload.title),
        company: payload.company == null ? undefined : String(payload.company),
        notes: payload.notes == null ? undefined : String(payload.notes),
        relationship: (payload.relationship as SecondBrainPersonRecord['relationship']) ?? 'work',
        lastContactAt: payload.lastContactAt == null ? null : Number(payload.lastContactAt),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      };
    });
  }

  upsertPerson(input: SecondBrainPersonUpsertInput): SecondBrainPersonRecord {
    const timestamp = this.ctx.now();
    const id = input.id?.trim() || randomUUID();
    const existing = this.getPerson(id);
    const person: SecondBrainPersonRecord = {
      id,
      name: input.name?.trim() || existing?.name || '',
      email: input.email?.trim() || existing?.email,
      title: input.title?.trim() || existing?.title,
      company: input.company?.trim() || existing?.company,
      notes: input.notes?.trim() || existing?.notes,
      relationship: input.relationship ?? existing?.relationship ?? 'work',
      lastContactAt: input.lastContactAt === undefined ? (existing?.lastContactAt ?? null) : input.lastContactAt,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    if (this.ctx.mode === 'memory') {
      this.ctx.memory.people.set(person.id, clone(person));
      return person;
    }

    this.ctx.db!.prepare(`
      INSERT INTO sb_people (id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      person.id,
      JSON.stringify({
        name: person.name,
        email: person.email ?? null,
        title: person.title ?? null,
        company: person.company ?? null,
        notes: person.notes ?? null,
        relationship: person.relationship,
        lastContactAt: person.lastContactAt ?? null,
      }),
      person.createdAt,
      person.updatedAt,
    );
    return person;
  }

  private getPerson(id: string): SecondBrainPersonRecord | null {
    if (this.ctx.mode === 'memory') {
      const person = this.ctx.memory.people.get(id);
      return person ? clone(person) : null;
    }

    const row = this.ctx.db!.prepare(`
      SELECT id, payload_json, created_at, updated_at
      FROM sb_people
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
    return {
      id: String(row.id),
      name: String(payload.name ?? ''),
      email: payload.email == null ? undefined : String(payload.email),
      title: payload.title == null ? undefined : String(payload.title),
      company: payload.company == null ? undefined : String(payload.company),
      notes: payload.notes == null ? undefined : String(payload.notes),
      relationship: (payload.relationship as SecondBrainPersonRecord['relationship']) ?? 'work',
      lastContactAt: payload.lastContactAt == null ? null : Number(payload.lastContactAt),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
