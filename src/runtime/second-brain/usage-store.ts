import { randomUUID } from 'node:crypto';
import type { SecondBrainUsageRecord } from './types.js';
import { clone } from './utils.js';
import type { SecondBrainStoreContext } from './second-brain-store.js';

export class UsageStore {
  constructor(private readonly ctx: SecondBrainStoreContext) {}

  appendUsageRecord(record: SecondBrainUsageRecord): void {
    if (this.ctx.mode === 'memory') {
      this.ctx.memory.usage.unshift(clone(record));
      this.ctx.memory.usage = this.ctx.memory.usage.slice(0, 1000);
      return;
    }

    this.ctx.db!.prepare(`
      INSERT INTO sb_usage_records (
        id, timestamp, route, feature_area, feature_id, provider, locality,
        prompt_tokens, completion_tokens, total_tokens, connector_calls, outbound_action
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      record.timestamp,
      record.route,
      record.featureArea,
      record.featureId ?? null,
      record.provider ?? null,
      record.locality,
      record.promptTokens,
      record.completionTokens,
      record.totalTokens,
      record.connectorCalls ?? null,
      record.outboundAction ?? null,
    );
  }

  listUsageRecords(limit = 50): SecondBrainUsageRecord[] {
    const safeLimit = Math.max(1, limit);
    if (this.ctx.mode === 'memory') {
      return this.ctx.memory.usage.slice(0, safeLimit).map(clone);
    }

    const rows = this.ctx.db!.prepare(`
      SELECT timestamp, route, feature_area, feature_id, provider, locality,
             prompt_tokens, completion_tokens, total_tokens, connector_calls, outbound_action
      FROM sb_usage_records
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      timestamp: Number(row.timestamp),
      route: row.route as SecondBrainUsageRecord['route'],
      featureArea: row.feature_area as SecondBrainUsageRecord['featureArea'],
      featureId: row.feature_id == null ? undefined : String(row.feature_id),
      provider: row.provider == null ? undefined : String(row.provider),
      locality: row.locality as SecondBrainUsageRecord['locality'],
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      totalTokens: Number(row.total_tokens),
      connectorCalls: row.connector_calls == null ? undefined : Number(row.connector_calls),
      outboundAction: row.outbound_action == null ? undefined : row.outbound_action as SecondBrainUsageRecord['outboundAction'],
    }));
  }
}
