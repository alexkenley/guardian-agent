import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AnalyticsService } from './analytics.js';

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    rmSync(file, { force: true });
  }
});

function makeService() {
  const path = join(tmpdir(), `guardianagent-analytics-${randomUUID()}.sqlite`);
  createdFiles.push(path);
  return new AnalyticsService({
    enabled: true,
    sqlitePath: path,
    retentionDays: 30,
  });
}

describe('AnalyticsService', () => {
  it('should aggregate by type/channel and command usage', () => {
    const analytics = makeService();
    analytics.track({
      type: 'message_sent',
      channel: 'cli',
      channelUserId: 'cli',
      canonicalUserId: 'owner',
      agentId: 'assistant',
    });
    analytics.track({
      type: 'command_used',
      channel: 'cli',
      channelUserId: 'cli',
      canonicalUserId: 'owner',
      metadata: { command: 'help' },
    });
    analytics.track({
      type: 'command_used',
      channel: 'cli',
      channelUserId: 'cli',
      canonicalUserId: 'owner',
      metadata: { command: 'help' },
    });

    const summary = analytics.summary(60_000);
    expect(summary.totalEvents).toBe(3);
    expect(summary.byType.command_used).toBe(2);
    expect(summary.byChannel.cli).toBe(3);
    expect(summary.commandUsage[0]?.command).toBe('help');
    expect(summary.commandUsage[0]?.count).toBe(2);
    analytics.close();
  });
});
