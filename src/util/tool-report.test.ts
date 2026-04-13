import { describe, expect, it } from 'vitest';

import { formatToolReport, isToolReportQuery } from './tool-report.js';

describe('tool-report', () => {
  it('detects recent tool report queries', () => {
    expect(isToolReportQuery('What exact tools did you use?')).toBe(true);
    expect(isToolReportQuery('Summarize the result.')).toBe(false);
  });

  it('deduplicates identical recent jobs so approval replays do not crowd out earlier tools', () => {
    const now = Date.now();
    const report = formatToolReport([
      {
        toolName: 'fs_write',
        status: 'succeeded',
        argsRedacted: { path: '/tmp/brokered-test.txt', content: '', append: false },
        completedAt: now - 1_000,
      },
      {
        toolName: 'fs_write',
        status: 'succeeded',
        argsRedacted: { path: '/tmp/brokered-test.txt', content: '', append: false },
        completedAt: now - 2_000,
      },
      {
        toolName: 'update_tool_policy',
        status: 'succeeded',
        argsRedacted: { action: 'add_path', value: '/tmp' },
        completedAt: now - 3_000,
      },
    ]);

    expect(report).toContain('1. update_tool_policy');
    expect(report).toContain('2. fs_write');
    expect(report).toContain('Repeated: 2 times');
    expect(report).toMatch(/update_tool_policy[\s\S]*fs_write/);
  });
});
