import { randomUUID } from 'node:crypto';
import type { SecondBrainLinkFilter, SecondBrainLinkRecord, SecondBrainLinkUpsertInput } from './types.js';
import { clone, normalizeTags } from './utils.js';
import type { SecondBrainStoreContext } from './second-brain-store.js';

export class LinkStore {
  constructor(private readonly ctx: SecondBrainStoreContext) {}

  listLinks(filter: SecondBrainLinkFilter = {}): SecondBrainLinkRecord[] {
    const limit = Math.max(1, filter.limit ?? 100);
    const query = filter.query?.trim().toLowerCase() ?? '';
    if (this.ctx.mode === 'memory') {
      return [...this.ctx.memory.links.values()]
        .filter((link) => {
          if (filter.kind && link.kind !== filter.kind) return false;
          if (!query) return true;
          const haystack = [
            link.title,
            link.url,
            link.summary,
            link.kind,
            ...link.tags,
          ]
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
            .join(' ')
            .toLowerCase();
          return haystack.includes(query);
        })
        .sort((left, right) => right.updatedAt - left.updatedAt || left.title.localeCompare(right.title))
        .slice(0, limit)
        .map(clone);
    }

    const rows = (query || filter.kind)
      ? this.ctx.db!.prepare(`
        SELECT id, payload_json, created_at, updated_at
        FROM sb_links
        WHERE (? = '' OR LOWER(payload_json) LIKE ?)
        ORDER BY updated_at DESC, id ASC
        LIMIT ?
      `).all(query, query ? `%${query}%` : '', limit)
      : this.ctx.db!.prepare(`
        SELECT id, payload_json, created_at, updated_at
        FROM sb_links
        ORDER BY updated_at DESC, id ASC
        LIMIT ?
      `).all(limit);

    return (rows as Array<Record<string, unknown>>)
      .map((row) => this.mapRow(row))
      .filter((link) => !filter.kind || link.kind === filter.kind);
  }

  upsertLink(input: SecondBrainLinkUpsertInput): SecondBrainLinkRecord {
    const timestamp = this.ctx.now();
    const id = input.id?.trim() || randomUUID();
    const existing = this.getLink(id);
    const link: SecondBrainLinkRecord = {
      id,
      title: input.title?.trim() || existing?.title || input.url.trim(),
      url: input.url.trim(),
      summary: input.summary?.trim() || undefined,
      tags: normalizeTags(input.tags ?? existing?.tags),
      kind: input.kind ?? existing?.kind ?? 'reference',
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    if (this.ctx.mode === 'memory') {
      this.ctx.memory.links.set(link.id, clone(link));
      return link;
    }

    this.ctx.db!.prepare(`
      INSERT INTO sb_links (id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      link.id,
      JSON.stringify({
        title: link.title,
        url: link.url,
        summary: link.summary ?? null,
        tags: link.tags,
        kind: link.kind,
      }),
      link.createdAt,
      link.updatedAt,
    );
    return link;
  }

  deleteLink(id: string): SecondBrainLinkRecord | null {
    const existing = this.getLink(id);
    if (!existing) return null;

    if (this.ctx.mode === 'memory') {
      this.ctx.memory.links.delete(id);
      return existing;
    }

    this.ctx.db!.prepare(`
      DELETE FROM sb_links
      WHERE id = ?
    `).run(id);
    return existing;
  }

  private getLink(id: string): SecondBrainLinkRecord | null {
    if (this.ctx.mode === 'memory') {
      const link = this.ctx.memory.links.get(id);
      return link ? clone(link) : null;
    }

    const row = this.ctx.db!.prepare(`
      SELECT id, payload_json, created_at, updated_at
      FROM sb_links
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, unknown>): SecondBrainLinkRecord {
    const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
    return {
      id: String(row.id),
      title: String(payload.title ?? ''),
      url: String(payload.url ?? ''),
      summary: payload.summary == null ? undefined : String(payload.summary),
      tags: Array.isArray(payload.tags) ? payload.tags.map((value) => String(value)) : [],
      kind: (payload.kind as SecondBrainLinkRecord['kind']) ?? 'reference',
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
