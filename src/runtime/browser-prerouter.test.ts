import { describe, expect, it, vi } from 'vitest';
import { tryBrowserPreRoute } from './browser-prerouter.js';

describe('tryBrowserPreRoute', () => {
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
    });

    expect(result).not.toBeNull();
    expect(result?.content).toContain("prepared the click action");
    expect(result?.content).toContain('Approval UI rendered.');
    expect(result?.metadata?.pendingApprovals).toEqual([
      {
        id: 'approval-1',
        toolName: 'browser_act',
        argsPreview: '{"stateId":"state-1","action":"click","ref":"link-more-info"}',
      },
    ]);
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
    });

    expect(result?.content).toContain("prepared the click action");
    expect(result?.metadata?.pendingApprovals?.[0]?.id).toBe('approval-nested');
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
