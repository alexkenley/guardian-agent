import { describe, expect, it, vi } from 'vitest';
import { tryBrowserPreRoute } from './browser-prerouter.js';

const browserIntentDecision = {
  route: 'browser_task' as const,
  confidence: 'high' as const,
  operation: 'read' as const,
  summary: 'Browser task.',
  entities: {},
};

describe('tryBrowserPreRoute', () => {
  it('does not hijack automation authoring prompts that mention browser actions', async () => {
    const result = await tryBrowserPreRoute({
      agentId: 'test-agent',
      message: {
        id: 'msg-auto',
        userId: 'user-1',
        channel: 'web',
        content: 'Create a scheduled assistant task called Weekly Browser Report that runs every Monday at 8:00 AM, opens https://example.com, reads the page, lists the links, and writes ./tmp/weekly-browser-report.md.',
        timestamp: Date.now(),
      },
      executeTool: vi.fn(),
    });

    expect(result).toBeNull();
  });

  it('routes explicit click prompts through browser_state and browser_act', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'browser_state') {
        expect(args).toEqual({ url: 'https://example.com' });
        return {
          success: true,
          status: 'succeeded',
          message: 'Captured state.',
          output: {
            stateId: 'state-1',
            url: 'https://example.com',
            elements: [
              { ref: 'link-more-info', type: 'link', text: 'More information...' },
            ],
          },
        };
      }
      if (toolName === 'browser_act') {
        expect(args).toEqual({
          stateId: 'state-1',
          action: 'click',
          ref: 'link-more-info',
        });
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-1',
          message: "Tool 'browser_act' is awaiting approval.",
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const trackPendingApproval = vi.fn();
    const onPendingApproval = vi.fn();

    const result = await tryBrowserPreRoute({
      agentId: 'test-agent',
      message: {
        id: 'msg-1',
        userId: 'user-1',
        channel: 'web',
        content: 'Go to https://example.com and click the "More information..." link.',
        timestamp: Date.now(),
      },
      executeTool,
      trackPendingApproval,
      onPendingApproval,
      formatPendingApprovalPrompt: () => 'Approval UI rendered.',
      resolvePendingApprovalMetadata: (_ids, fallback) => fallback,
    }, {
      intentDecision: browserIntentDecision,
    });

    expect(result).not.toBeNull();
    expect(result?.content).toContain("prepared the click action");
    expect(result?.content).toContain('Approval UI rendered.');
    expect(result?.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          kind: 'approval',
          approvalSummaries: [
            {
              id: 'approval-1',
              toolName: 'browser_act',
              argsPreview: '{"stateId":"state-1","action":"click","ref":"link-more-info"}',
            },
          ],
        },
      },
    });
    expect(trackPendingApproval).toHaveBeenCalledWith('approval-1');
    expect(onPendingApproval).toHaveBeenCalledWith({
      approvalId: 'approval-1',
      approved: "I clicked 'More information...'.",
      denied: "I did not click 'More information...'.",
    });
  });

  it('routes form typing prompts through the first text field', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'browser_state') {
        expect(args).toEqual({ url: 'https://httpbin.org/forms/post' });
        return {
          success: true,
          status: 'succeeded',
          message: 'Captured state.',
          output: {
            stateId: 'state-2',
            url: 'https://httpbin.org/forms/post',
            elements: [
              { ref: 'e5', type: 'textbox', text: 'Customer name' },
              { ref: 'e6', type: 'textbox', text: 'Telephone' },
            ],
          },
        };
      }
      if (toolName === 'browser_act') {
        expect(args).toEqual({
          stateId: 'state-2',
          action: 'type',
          ref: 'e5',
          value: 'automation smoke test',
        });
        return {
          success: true,
          status: 'succeeded',
          message: "Filled 'Customer name' on https://httpbin.org/forms/post via Playwright.",
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryBrowserPreRoute({
      agentId: 'test-agent',
      message: {
        id: 'msg-2',
        userId: 'user-1',
        channel: 'web',
        content: 'Open https://httpbin.org/forms/post and type "automation smoke test" into the first text field.',
        timestamp: Date.now(),
      },
      executeTool,
    }, {
      intentDecision: browserIntentDecision,
    });

    expect(result).toEqual({
      content: "Filled 'Customer name' on https://httpbin.org/forms/post via Playwright.",
    });
  });

  it('unwraps nested or stringified browser_state payloads', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'browser_state') {
        expect(args).toEqual({ url: 'https://example.com' });
        return {
          success: true,
          status: 'succeeded',
          message: 'Captured state.',
          output: {
            result: JSON.stringify({
              stateId: 'state-nested',
              url: 'https://example.com',
              elements: [
                { ref: 'link-more-info', type: 'link', text: 'More information...' },
              ],
            }),
          },
        };
      }
      if (toolName === 'browser_act') {
        expect(args).toEqual({
          stateId: 'state-nested',
          action: 'click',
          ref: 'link-more-info',
        });
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-nested',
          message: "Tool 'browser_act' is awaiting approval.",
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryBrowserPreRoute({
      agentId: 'test-agent',
      message: {
        id: 'msg-nested',
        userId: 'user-1',
        channel: 'web',
        content: 'Open https://example.com and click the "More information..." link.',
        timestamp: Date.now(),
      },
      executeTool,
      formatPendingApprovalPrompt: () => 'Approval UI rendered.',
      resolvePendingApprovalMetadata: (_ids, fallback) => fallback,
    }, {
      intentDecision: browserIntentDecision,
    });

    expect(result?.content).toContain("prepared the click action");
    expect((result?.metadata?.pendingAction as { blocker?: { approvalSummaries?: Array<{ id?: string }> } } | undefined)?.blocker?.approvalSummaries?.[0]?.id).toBe('approval-nested');
  });

  it('renders link details from stringified browser_links output', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName !== 'browser_links') {
        throw new Error(`Unexpected tool ${toolName}`);
      }
      expect(args).toEqual({ url: 'https://example.com' });
      return {
        success: true,
        status: 'succeeded',
        message: 'Extracted 1 link from https://example.com.',
        output: JSON.stringify({
          url: 'https://example.com',
          links: [
            { text: 'Learn more', href: 'https://iana.org/domains/example' },
          ],
        }),
      };
    });

    const result = await tryBrowserPreRoute({
      agentId: 'test-agent',
      message: {
        id: 'msg-links',
        userId: 'user-1',
        channel: 'web',
        content: 'Show me the links on https://example.com',
        timestamp: Date.now(),
      },
      executeTool,
    }, {
      intentDecision: browserIntentDecision,
    });

    expect(result).toEqual({
      content: [
        'Extracted 1 link from https://example.com.',
        '- Learn more → https://iana.org/domains/example',
      ].join('\n\n'),
    });
  });

  it('renders read and extract details from nested browser output payloads', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'browser_read') {
        expect(args).toEqual({ url: 'https://example.com' });
        return {
          success: true,
          status: 'succeeded',
          message: 'Read https://example.com via Playwright accessibility snapshot.',
          output: {
            result: JSON.stringify({
              content: 'Example Domain\nThis domain is for use in illustrative examples in documents.',
            }),
          },
        };
      }
      if (toolName === 'browser_extract') {
        expect(args).toEqual({ url: 'https://example.com', type: 'structured' });
        return {
          success: true,
          status: 'succeeded',
          message: 'Extracted structured page data from https://example.com.',
          output: {
            data: {
              structuredData: {
                metadata: { title: 'Example Domain' },
              },
            },
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const readResult = await tryBrowserPreRoute({
      agentId: 'test-agent',
      message: {
        id: 'msg-read',
        userId: 'user-1',
        channel: 'web',
        content: 'Read https://example.com',
        timestamp: Date.now(),
      },
      executeTool,
    }, {
      intentDecision: browserIntentDecision,
    });

    expect(readResult?.content).toContain('Example Domain');
    expect(readResult?.content).toContain('illustrative examples');

    const extractResult = await tryBrowserPreRoute({
      agentId: 'test-agent',
      message: {
        id: 'msg-extract',
        userId: 'user-1',
        channel: 'web',
        content: 'Extract structured metadata from https://example.com',
        timestamp: Date.now(),
      },
      executeTool,
    }, {
      intentDecision: browserIntentDecision,
    });

    expect(extractResult?.content).toContain('Structured data:');
    expect(extractResult?.content).toContain('"title": "Example Domain"');
  });

  it('does not preroute Google Workspace browser URLs', async () => {
    const executeTool = vi.fn();

    const result = await tryBrowserPreRoute({
      agentId: 'test-agent',
      message: {
        id: 'msg-3',
        userId: 'user-1',
        channel: 'web',
        content: 'Open https://mail.google.com and click Compose.',
        timestamp: Date.now(),
      },
      executeTool,
    });

    expect(result).toBeNull();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('does not hijack non-browser summarize prompts', async () => {
    const executeTool = vi.fn();

    const result = await tryBrowserPreRoute({
      agentId: 'test-agent',
      message: {
        id: 'msg-4',
        userId: 'user-1',
        channel: 'web',
        content: 'Run git status for this coding workspace and summarize it briefly.',
        timestamp: Date.now(),
      },
      executeTool,
    });

    expect(result).toBeNull();
    expect(executeTool).not.toHaveBeenCalled();
  });
});
