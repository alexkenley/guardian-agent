import { randomUUID } from 'node:crypto';
import type { SecondBrainTaskFilter, SecondBrainTaskRecord, SecondBrainTaskUpsertInput } from './types.js';
import { clone, taskPriorityOrder } from './utils.js';
import type { SecondBrainStoreContext } from './second-brain-store.js';

export class TaskStore {
  constructor(private readonly ctx: SecondBrainStoreContext) {}

  listTasks(filter: SecondBrainTaskFilter = {}): SecondBrainTaskRecord[] {
    const limit = Math.max(1, filter.limit ?? 50);
    const statusFilter = filter.status;
    if (this.ctx.mode === 'memory') {
      return [...this.ctx.memory.tasks.values()]
        .filter((task) => {
          if (!statusFilter) return true;
          if (statusFilter === 'open') return task.status !== 'done';
          return task.status === statusFilter;
        })
        .sort((left, right) => (
          (left.dueAt ?? Number.MAX_SAFE_INTEGER) - (right.dueAt ?? Number.MAX_SAFE_INTEGER)
          || taskPriorityOrder(left.priority) - taskPriorityOrder(right.priority)
          || right.updatedAt - left.updatedAt
        ))
        .slice(0, limit)
        .map(clone);
    }

    const rows = statusFilter === 'open'
      ? this.ctx.db!.prepare(`
        SELECT id, title, details, status, priority, due_at, source, completed_at, created_at, updated_at
        FROM sb_tasks
        WHERE status != 'done'
        ORDER BY COALESCE(due_at, 9007199254740991) ASC, updated_at DESC
        LIMIT ?
      `).all(limit)
      : statusFilter
        ? this.ctx.db!.prepare(`
          SELECT id, title, details, status, priority, due_at, source, completed_at, created_at, updated_at
          FROM sb_tasks
          WHERE status = ?
          ORDER BY COALESCE(due_at, 9007199254740991) ASC, updated_at DESC
          LIMIT ?
        `).all(statusFilter, limit)
        : this.ctx.db!.prepare(`
          SELECT id, title, details, status, priority, due_at, source, completed_at, created_at, updated_at
          FROM sb_tasks
          ORDER BY COALESCE(due_at, 9007199254740991) ASC, updated_at DESC
          LIMIT ?
        `).all(limit);

    return (rows as Array<Record<string, unknown>>)
      .map((row) => ({
        id: String(row.id),
        title: String(row.title),
        details: row.details == null ? undefined : String(row.details),
        status: row.status as SecondBrainTaskRecord['status'],
        priority: row.priority as SecondBrainTaskRecord['priority'],
        dueAt: row.due_at == null ? null : Number(row.due_at),
        source: row.source as SecondBrainTaskRecord['source'],
        completedAt: row.completed_at == null ? null : Number(row.completed_at),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      }))
      .sort((left, right) => (
        (left.dueAt ?? Number.MAX_SAFE_INTEGER) - (right.dueAt ?? Number.MAX_SAFE_INTEGER)
        || taskPriorityOrder(left.priority) - taskPriorityOrder(right.priority)
        || right.updatedAt - left.updatedAt
      ));
  }

  upsertTask(input: SecondBrainTaskUpsertInput): SecondBrainTaskRecord {
    const timestamp = this.ctx.now();
    const id = input.id?.trim() || randomUUID();
    const existing = this.getTask(id);
    const status = input.status ?? existing?.status ?? 'todo';
    const completedAt = status === 'done'
      ? existing?.completedAt ?? timestamp
      : null;
    const task: SecondBrainTaskRecord = {
      id,
      title: input.title.trim(),
      details: input.details?.trim() || undefined,
      status,
      priority: input.priority ?? existing?.priority ?? 'medium',
      dueAt: input.dueAt === undefined ? (existing?.dueAt ?? null) : input.dueAt,
      source: existing?.source ?? 'manual',
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      completedAt,
    };

    if (this.ctx.mode === 'memory') {
      this.ctx.memory.tasks.set(task.id, clone(task));
      return task;
    }

    this.ctx.db!.prepare(`
      INSERT INTO sb_tasks (id, title, details, status, priority, due_at, source, completed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        details = excluded.details,
        status = excluded.status,
        priority = excluded.priority,
        due_at = excluded.due_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `).run(
      task.id,
      task.title,
      task.details ?? null,
      task.status,
      task.priority,
      task.dueAt ?? null,
      task.source,
      task.completedAt ?? null,
      task.createdAt,
      task.updatedAt,
    );
    return task;
  }

  deleteTask(id: string): SecondBrainTaskRecord | null {
    const existing = this.getTask(id);
    if (!existing) return null;

    if (this.ctx.mode === 'memory') {
      this.ctx.memory.tasks.delete(id);
      return existing;
    }

    this.ctx.db!.prepare(`
      DELETE FROM sb_tasks
      WHERE id = ?
    `).run(id);
    return existing;
  }

  getTask(id: string): SecondBrainTaskRecord | null {
    if (this.ctx.mode === 'memory') {
      const task = this.ctx.memory.tasks.get(id);
      return task ? clone(task) : null;
    }

    const row = this.ctx.db!.prepare(`
      SELECT id, title, details, status, priority, due_at, source, completed_at, created_at, updated_at
      FROM sb_tasks
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      title: String(row.title),
      details: row.details == null ? undefined : String(row.details),
      status: row.status as SecondBrainTaskRecord['status'],
      priority: row.priority as SecondBrainTaskRecord['priority'],
      dueAt: row.due_at == null ? null : Number(row.due_at),
      source: row.source as SecondBrainTaskRecord['source'],
      completedAt: row.completed_at == null ? null : Number(row.completed_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
