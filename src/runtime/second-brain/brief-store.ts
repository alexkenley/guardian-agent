import type { SecondBrainBriefFilter, SecondBrainBriefRecord } from './types.js';
import { clone } from './utils.js';
import type { SecondBrainStoreContext } from './second-brain-store.js';

export class BriefStore {
  constructor(private readonly ctx: SecondBrainStoreContext) {}

  listBriefs(filter: SecondBrainBriefFilter = {}): SecondBrainBriefRecord[] {
    const limit = Math.max(1, filter.limit ?? 50);
    if (this.ctx.mode === 'memory') {
      return [...this.ctx.memory.briefs.values()]
        .filter((brief) => {
          if (filter.kind && brief.kind !== filter.kind) return false;
          if (filter.eventId && brief.eventId !== filter.eventId) return false;
          return true;
        })
        .sort((left, right) => right.generatedAt - left.generatedAt)
        .slice(0, limit)
        .map(clone);
    }

    const rows = this.ctx.db!.prepare(`
      SELECT id, payload_json, created_at, updated_at
      FROM sb_briefs
      ORDER BY updated_at DESC, id ASC
    `).all() as Array<Record<string, unknown>>;

    return rows
      .map((row) => this.mapRow(row))
      .filter((brief) => {
        if (filter.kind && brief.kind !== filter.kind) return false;
        if (filter.eventId && brief.eventId !== filter.eventId) return false;
        return true;
      })
      .slice(0, limit);
  }

  getBrief(id: string): SecondBrainBriefRecord | null {
    if (this.ctx.mode === 'memory') {
      const brief = this.ctx.memory.briefs.get(id);
      return brief ? clone(brief) : null;
    }

    const row = this.ctx.db!.prepare(`
      SELECT id, payload_json, created_at, updated_at
      FROM sb_briefs
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  upsertBrief(brief: SecondBrainBriefRecord): SecondBrainBriefRecord {
    if (this.ctx.mode === 'memory') {
      this.ctx.memory.briefs.set(brief.id, clone(brief));
      return brief;
    }

    this.ctx.db!.prepare(`
      INSERT INTO sb_briefs (id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      brief.id,
      JSON.stringify({
        kind: brief.kind,
        title: brief.title,
        content: brief.content,
        generatedAt: brief.generatedAt,
        routineId: brief.routineId ?? null,
        eventId: brief.eventId ?? null,
      }),
      brief.createdAt,
      brief.updatedAt,
    );
    return brief;
  }

  private mapRow(row: Record<string, unknown>): SecondBrainBriefRecord {
    const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
    return {
      id: String(row.id),
      kind: payload.kind as SecondBrainBriefRecord['kind'],
      title: String(payload.title ?? ''),
      content: String(payload.content ?? ''),
      generatedAt: Number(payload.generatedAt ?? row.updated_at),
      routineId: payload.routineId == null ? undefined : String(payload.routineId),
      eventId: payload.eventId == null ? undefined : String(payload.eventId),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
