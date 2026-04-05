import type { SecondBrainSyncCursorRecord } from './types.js';
import { clone } from './utils.js';
import type { SecondBrainStoreContext } from './second-brain-store.js';

export class SyncCursorStore {
  constructor(private readonly ctx: SecondBrainStoreContext) {}

  listSyncCursors(): SecondBrainSyncCursorRecord[] {
    if (this.ctx.mode === 'memory') {
      return [...this.ctx.memory.syncCursors.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(clone);
    }

    const rows = this.ctx.db!.prepare(`
      SELECT id, payload_json, created_at, updated_at
      FROM sb_sync_cursors
      ORDER BY id ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  getSyncCursor(id: string): SecondBrainSyncCursorRecord | null {
    if (this.ctx.mode === 'memory') {
      const cursor = this.ctx.memory.syncCursors.get(id);
      return cursor ? clone(cursor) : null;
    }

    const row = this.ctx.db!.prepare(`
      SELECT id, payload_json, created_at, updated_at
      FROM sb_sync_cursors
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  upsertSyncCursor(cursor: SecondBrainSyncCursorRecord): SecondBrainSyncCursorRecord {
    if (this.ctx.mode === 'memory') {
      this.ctx.memory.syncCursors.set(cursor.id, clone(cursor));
      return cursor;
    }

    this.ctx.db!.prepare(`
      INSERT INTO sb_sync_cursors (id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      cursor.id,
      JSON.stringify({
        provider: cursor.provider,
        entity: cursor.entity,
        cursor: cursor.cursor ?? null,
        lastSyncAt: cursor.lastSyncAt,
      }),
      cursor.createdAt,
      cursor.updatedAt,
    );
    return cursor;
  }

  private mapRow(row: Record<string, unknown>): SecondBrainSyncCursorRecord {
    const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
    return {
      id: String(row.id),
      provider: payload.provider as SecondBrainSyncCursorRecord['provider'],
      entity: payload.entity as SecondBrainSyncCursorRecord['entity'],
      cursor: payload.cursor == null ? null : String(payload.cursor),
      lastSyncAt: Number(payload.lastSyncAt ?? row.updated_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
