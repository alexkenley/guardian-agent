import { describe, expect, it, vi } from 'vitest';
import { tryAutomationOutputPreRoute } from './automation-output-prerouter.js';

const baseMessage = {
  id: 'msg-1',
  userId: 'owner',
  principalId: 'owner',
  principalRole: 'owner' as const,
  agentId: 'default',
  channel: 'web',
  content: '',
};

describe('tryAutomationOutputPreRoute', () => {
  it('analyzes the latest stored output for a saved automation', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            automations: [{
              id: 'hn-snapshot-smoke',
              name: 'HN Snapshot Smoke',
              kind: 'workflow',
              enabled: true,
              workflow: {
                id: 'hn-snapshot-smoke',
                name: 'HN Snapshot Smoke',
                enabled: true,
                mode: 'sequential',
                steps: [
                  { id: 'navigate', toolName: 'browser_navigate' },
                  { id: 'read_page', toolName: 'browser_read' },
                  { id: 'list_links', toolName: 'browser_links' },
                ],
              },
            }],
          },
        };
      }
      if (toolName === 'automation_output_search') {
        expect(args).toMatchObject({ automationId: 'hn-snapshot-smoke', limit: 8 });
        return {
          success: true,
          output: {
            resultCount: 1,
            results: [{
              runId: 'run-123',
              automationId: 'hn-snapshot-smoke',
              automationName: 'HN Snapshot Smoke',
              status: 'succeeded',
              storedAt: 1_774_501_051_522,
              preview: 'Extracted 50 links from https://news.ycombinator.com.',
              runLink: '#/automations?runId=run-123',
            }],
          },
        };
      }
      if (toolName === 'automation_output_read' && args.runId === 'run-123' && !args.stepId) {
        return {
          success: true,
          output: {
            runId: 'run-123',
            automationId: 'hn-snapshot-smoke',
            automationName: 'HN Snapshot Smoke',
            status: 'succeeded',
            scope: 'run',
            text: 'full run text',
            runLink: '#/automations?runId=run-123',
            manifest: {
              storeId: 'store-123',
              storedAt: 1_774_501_051_522,
              stepCount: 3,
              summary: "Automation 'HN Snapshot Smoke' succeeded with 3 recorded steps.",
              steps: [
                { stepId: 'navigate', toolName: 'browser_navigate', status: 'succeeded', preview: 'Navigated to https://news.ycombinator.com.', contentChars: 120 },
                { stepId: 'read_page', toolName: 'browser_read', status: 'succeeded', preview: 'Read https://news.ycombinator.com.', contentChars: 500 },
                { stepId: 'list_links', toolName: 'browser_links', status: 'succeeded', preview: 'Extracted 50 links from https://news.ycombinator.com.', contentChars: 900 },
              ],
            },
          },
        };
      }
      if (toolName === 'automation_output_read' && args.stepId === 'list_links') {
        return {
          success: true,
          output: {
            runId: 'run-123',
            automationId: 'hn-snapshot-smoke',
            automationName: 'HN Snapshot Smoke',
            status: 'succeeded',
            scope: 'step',
            stepId: 'list_links',
            toolName: 'browser_links',
            text: JSON.stringify({
              links: [
                { text: 'Hacker News', href: 'https://news.ycombinator.com/news' },
                { text: 'new', href: 'https://news.ycombinator.com/newest' },
              ],
            }),
            runLink: '#/automations?runId=run-123',
            manifest: {
              storeId: 'store-123',
              storedAt: 1_774_501_051_522,
              stepCount: 3,
              summary: "Automation 'HN Snapshot Smoke' succeeded with 3 recorded steps.",
              steps: [],
            },
          },
        };
      }
      if (toolName === 'automation_output_read' && args.stepId === 'read_page') {
        return {
          success: true,
          output: {
            runId: 'run-123',
            automationId: 'hn-snapshot-smoke',
            automationName: 'HN Snapshot Smoke',
            status: 'succeeded',
            scope: 'step',
            stepId: 'read_page',
            toolName: 'browser_read',
            text: JSON.stringify({
              content: '### Page\n- Page Title: Hacker News\n### Snapshot\n```yaml\n- paragraph: latest startup and engineering stories\n```',
            }),
            runLink: '#/automations?runId=run-123',
            manifest: {
              storeId: 'store-123',
              storedAt: 1_774_501_051_522,
              stepCount: 3,
              summary: "Automation 'HN Snapshot Smoke' succeeded with 3 recorded steps.",
              steps: [],
            },
          },
        };
      }
      if (toolName === 'automation_output_read' && args.stepId === 'navigate') {
        return {
          success: true,
          output: {
            runId: 'run-123',
            automationId: 'hn-snapshot-smoke',
            automationName: 'HN Snapshot Smoke',
            status: 'succeeded',
            scope: 'step',
            stepId: 'navigate',
            toolName: 'browser_navigate',
            text: '{"url":"https://news.ycombinator.com"}',
            runLink: '#/automations?runId=run-123',
            manifest: {
              storeId: 'store-123',
              storedAt: 1_774_501_051_522,
              stepCount: 3,
              summary: "Automation 'HN Snapshot Smoke' succeeded with 3 recorded steps.",
              steps: [],
            },
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName} ${JSON.stringify(args)}`);
    });

    const result = await tryAutomationOutputPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Analyze the output from the last HN Snapshot Smoke automation run.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_output_task',
        confidence: 'high',
        operation: 'inspect',
        summary: 'Analyze the last stored automation run.',
        entities: {
          automationName: 'HN Snapshot Smoke',
        },
      },
    });

    expect(result?.content).toContain("I found the latest stored run for 'HN Snapshot Smoke'.");
    expect(result?.content).toContain('browser_links: found 2 highlighted links');
    expect(result?.content).toContain('Hacker News -> https://news.ycombinator.com/news');
    expect(result?.metadata).toMatchObject({
      storedAutomationOutput: {
        automationId: 'hn-snapshot-smoke',
        runId: 'run-123',
      },
    });
  });

  it('falls back to automation-name search when no exact automationId match is stored', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            automations: [{
              id: 'hn-snapshot-smoke',
              name: 'HN Snapshot Smoke',
              kind: 'workflow',
              enabled: true,
              workflow: {
                id: 'hn-snapshot-smoke',
                name: 'HN Snapshot Smoke',
                enabled: true,
                mode: 'sequential',
                steps: [{ id: 'read_page', toolName: 'browser_read' }],
              },
            }],
          },
        };
      }
      if (toolName === 'automation_output_search' && args.automationId === 'hn-snapshot-smoke') {
        return {
          success: true,
          output: {
            resultCount: 0,
            results: [],
          },
        };
      }
      if (toolName === 'automation_output_search' && args.query === 'HN Snapshot Smoke') {
        return {
          success: true,
          output: {
            resultCount: 1,
            results: [{
              runId: 'run-fallback',
              automationId: 'legacy-hn-snapshot-id',
              automationName: 'HN Snapshot Smoke',
              status: 'succeeded',
              storedAt: 1_774_501_051_522,
              preview: 'Read https://news.ycombinator.com.',
              runLink: '#/automations?runId=run-fallback',
            }],
          },
        };
      }
      if (toolName === 'automation_output_read') {
        return {
          success: true,
          output: {
            runId: 'run-fallback',
            automationId: 'legacy-hn-snapshot-id',
            automationName: 'HN Snapshot Smoke',
            status: 'succeeded',
            scope: 'run',
            text: 'run text',
            runLink: '#/automations?runId=run-fallback',
            manifest: {
              storeId: 'store-fallback',
              storedAt: 1_774_501_051_522,
              stepCount: 1,
              summary: "Automation 'HN Snapshot Smoke' succeeded with 1 recorded step.",
              steps: [
                { stepId: 'read_page', toolName: 'browser_read', status: 'succeeded', preview: 'Read https://news.ycombinator.com.', contentChars: 320 },
              ],
            },
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName} ${JSON.stringify(args)}`);
    });

    const result = await tryAutomationOutputPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Analyze the output from the last HN Snapshot Smoke automation run.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_output_task',
        confidence: 'high',
        operation: 'inspect',
        summary: 'Analyze stored automation output.',
        entities: {
          automationName: 'HN Snapshot Smoke',
        },
      },
    });

    expect(result?.content).toContain("I found the latest stored run for 'HN Snapshot Smoke'.");
    expect(executeTool).toHaveBeenCalledWith(
      'automation_output_search',
      { query: 'HN Snapshot Smoke', limit: 20 },
      expect.any(Object),
    );
  });

  it('surfaces automation-output tool failures instead of misreporting not found', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            automations: [{
              id: 'hn-snapshot-smoke',
              name: 'HN Snapshot Smoke',
              kind: 'workflow',
              enabled: true,
            }],
          },
        };
      }
      if (toolName === 'automation_output_search') {
        return {
          success: false,
          message: 'Historical automation output is not available.',
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationOutputPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Analyze the latest output results from HN Snapshot Smoke.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_output_task',
        confidence: 'high',
        operation: 'inspect',
        summary: 'Analyze stored automation output.',
        entities: {
          automationName: 'HN Snapshot Smoke',
        },
      },
    });

    expect(result?.content).toContain('I could not inspect stored historical output');
    expect(result?.content).toContain('Historical automation output is not available.');
  });
});
