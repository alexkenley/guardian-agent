import { randomUUID } from 'node:crypto';
import type { SecondBrainNoteFilter, SecondBrainNoteRecord, SecondBrainNoteUpsertInput } from './types.js';
import { clone, normalizeTags } from './utils.js';
import type { SecondBrainStoreContext } from './second-brain-store.js';

export class NoteStore {
  constructor(private readonly ctx: SecondBrainStoreContext) {}

  listNotes(filter: SecondBrainNoteFilter = {}): SecondBrainNoteRecord[] {
    const limit = Math.max(1, filter.limit ?? 50);
    if (this.ctx.mode === 'memory') {
      return [...this.ctx.memory.notes.values()]
        .filter((note) => filter.includeArchived ? true : !note.archivedAt)
        .sort((left, right) => (
          Number(right.pinned) - Number(left.pinned)
          || right.updatedAt - left.updatedAt
        ))
        .slice(0, limit)
        .map(clone);
    }

    const rows = this.ctx.db!.prepare(`
      SELECT id, title, content, tags_json, pinned, archived_at, created_at, updated_at
      FROM sb_notes
      ${filter.includeArchived ? '' : 'WHERE archived_at IS NULL'}
      ORDER BY pinned DESC, updated_at DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      content: String(row.content),
      tags: row.tags_json ? JSON.parse(String(row.tags_json)) as string[] : [],
      pinned: Number(row.pinned) === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      archivedAt: row.archived_at == null ? null : Number(row.archived_at),
    }));
  }

  upsertNote(input: SecondBrainNoteUpsertInput): SecondBrainNoteRecord {
    const timestamp = this.ctx.now();
    const id = input.id?.trim() || randomUUID();
    const existing = this.getNote(id);
    const note: SecondBrainNoteRecord = {
      id,
      title: input.title?.trim() || existing?.title || 'Untitled note',
      content: input.content.trim(),
      tags: normalizeTags(input.tags ?? existing?.tags),
      pinned: input.pinned ?? existing?.pinned ?? false,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      archivedAt: input.archived === true
        ? timestamp
        : input.archived === false
          ? null
          : existing?.archivedAt ?? null,
    };

    if (this.ctx.mode === 'memory') {
      this.ctx.memory.notes.set(note.id, clone(note));
      return note;
    }

    this.ctx.db!.prepare(`
      INSERT INTO sb_notes (id, title, content, tags_json, pinned, archived_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        tags_json = excluded.tags_json,
        pinned = excluded.pinned,
        archived_at = excluded.archived_at,
        updated_at = excluded.updated_at
    `).run(
      note.id,
      note.title,
      note.content,
      JSON.stringify(note.tags),
      note.pinned ? 1 : 0,
      note.archivedAt ?? null,
      note.createdAt,
      note.updatedAt,
    );
    return note;
  }

  deleteNote(id: string): SecondBrainNoteRecord | null {
    const existing = this.getNote(id);
    if (!existing) return null;

    if (this.ctx.mode === 'memory') {
      this.ctx.memory.notes.delete(id);
      return existing;
    }

    this.ctx.db!.prepare(`
      DELETE FROM sb_notes
      WHERE id = ?
    `).run(id);
    return existing;
  }

  private getNote(id: string): SecondBrainNoteRecord | null {
    if (this.ctx.mode === 'memory') {
      const note = this.ctx.memory.notes.get(id);
      return note ? clone(note) : null;
    }

    const row = this.ctx.db!.prepare(`
      SELECT id, title, content, tags_json, pinned, archived_at, created_at, updated_at
      FROM sb_notes
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      title: String(row.title),
      content: String(row.content),
      tags: row.tags_json ? JSON.parse(String(row.tags_json)) as string[] : [],
      pinned: Number(row.pinned) === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      archivedAt: row.archived_at == null ? null : Number(row.archived_at),
    };
  }
}
