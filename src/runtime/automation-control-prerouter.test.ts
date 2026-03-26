import { describe, expect, it, vi } from 'vitest';
import { tryAutomationControlPreRoute } from './automation-control-prerouter.js';

const baseMessage = {
  id: 'msg-1',
  userId: 'owner',
  principalId: 'owner',
  principalRole: 'owner' as const,
  agentId: 'default',
  channel: 'web',
  content: '',
};

describe('tryAutomationControlPreRoute', () => {
  it('lists the unified automation catalog when asked to inspect automations', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            automations: [
              {
                id: 'browser-read-smoke',
                name: 'Browser Read Smoke',
                kind: 'workflow',
                enabled: true,
                workflow: {
                  id: 'browser-read-smoke',
                  name: 'Browser Read Smoke',
                  enabled: true,
                  mode: 'sequential',
                  description: 'Reads example.com.',
                  steps: [{ id: 'step-1', toolName: 'browser_navigate' }],
                },
              },
              {
                id: 'task-1',
                name: 'Inbox Triage',
                kind: 'assistant_task',
                enabled: false,
                task: {
                  id: 'task-1',
                  name: 'Inbox Triage',
                  type: 'agent',
                  target: 'default',
                  eventTrigger: { eventType: 'automation:manual:inbox-triage' },
                  enabled: false,
                },
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationControlPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Show me the saved automations.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_control',
        confidence: 'high',
        operation: 'inspect',
        summary: 'Inspect the automation catalog.',
        entities: {},
      },
    });

    expect(result?.content).toContain('Automation catalog (2)');
    expect(result?.content).toContain('Browser Read Smoke');
    expect(result?.content).toContain('Inbox Triage');
  });

  it('runs task-only automations through automation_run', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            automations: [{
              id: 'task-inbox',
              name: 'Inbox Triage',
              kind: 'assistant_task',
              enabled: true,
              task: {
                id: 'task-inbox',
                name: 'Inbox Triage',
                type: 'agent',
                target: 'default',
                cron: '0 8 * * *',
                enabled: true,
              },
            }],
          },
        };
      }
      if (toolName === 'automation_run') {
        expect(args).toEqual({ automationId: 'task-inbox' });
        return {
          success: true,
          message: "Ran 'Inbox Triage'.",
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationControlPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Run Inbox Triage.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_control',
        confidence: 'high',
        operation: 'run',
        summary: 'Run an existing automation.',
        entities: {
          automationName: 'Inbox Triage',
        },
      },
    });

    expect(result?.content).toContain("Ran 'Inbox Triage'.");
    expect(executeTool).toHaveBeenCalledWith(
      'automation_run',
      { automationId: 'task-inbox' },
      expect.objectContaining({ channel: 'web', userId: 'owner' }),
    );
  });

  it('uses heuristic name recovery only as an explicit gateway-unavailable fallback', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            automations: [{
              id: 'browser-read-smoke',
              name: 'Browser Read Smoke',
              kind: 'workflow',
              enabled: true,
              workflow: {
                id: 'browser-read-smoke',
                name: 'Browser Read Smoke',
                enabled: true,
                mode: 'sequential',
                steps: [{ id: 'step-1', toolName: 'browser_navigate' }],
              },
            }],
          },
        };
      }
      if (toolName === 'automation_run') {
        expect(args).toEqual({ automationId: 'browser-read-smoke' });
        return {
          success: true,
          message: "Ran 'Browser Read Smoke'.",
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationControlPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Show me the automation Browser Read Smoke.',
      },
      executeTool,
    }, {
      allowHeuristicFallback: true,
    });

    expect(result?.content).toContain('Browser Read Smoke (workflow)');
  });

  it('does not hijack automation-output analysis requests as automation control', async () => {
    const executeTool = vi.fn(async () => {
      throw new Error('automation control tools should not run for output-analysis requests');
    });

    const result = await tryAutomationControlPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Analyze the output from the last HN Snapshot Smoke automation run. Summarize what it found.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_control',
        confidence: 'high',
        operation: 'inspect',
        summary: 'Inspect an automation run.',
        entities: {
          automationName: 'HN Snapshot Smoke',
        },
      },
    });

    expect(result).toBeNull();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('toggles workflows from automations-page intents via automation_set_enabled', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            automations: [{
              id: 'browser-read-smoke',
              name: 'Browser Read Smoke',
              kind: 'workflow',
              enabled: true,
              workflow: {
                id: 'browser-read-smoke',
                name: 'Browser Read Smoke',
                enabled: true,
                mode: 'sequential',
                description: 'Reads example.com.',
                steps: [{ id: 'step-1', toolName: 'browser_navigate', args: { url: 'https://example.com' } }],
              },
            }],
          },
        };
      }
      if (toolName === 'automation_set_enabled') {
        expect(args).toEqual({ automationId: 'browser-read-smoke', enabled: false });
        return {
          success: true,
          message: "Disabled 'Browser Read Smoke'.",
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationControlPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'In the Automations page, disable Browser Read Smoke.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'ui_control',
        confidence: 'high',
        operation: 'toggle',
        summary: 'Disable a saved automation from the automations page.',
        entities: {
          automationName: 'Browser Read Smoke',
          uiSurface: 'automations',
          enabled: false,
        },
      },
    });

    expect(result?.content).toContain("Disabled 'Browser Read Smoke'.");
  });

  it('prepares deletion through automation_delete when approval is required', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            automations: [{
              id: 'browser-read-smoke',
              name: 'Browser Read Smoke',
              kind: 'workflow',
              enabled: true,
              workflow: {
                id: 'browser-read-smoke',
                name: 'Browser Read Smoke',
                enabled: true,
                mode: 'sequential',
                steps: [{ id: 'step-1', toolName: 'browser_navigate' }],
              },
              task: {
                id: 'task-browser-read',
                name: 'Browser Read Smoke',
                type: 'workflow',
                target: 'browser-read-smoke',
                cron: '0 8 * * 1',
                enabled: true,
              },
            }],
          },
        };
      }
      if (toolName === 'automation_delete') {
        expect(args).toEqual({ automationId: 'browser-read-smoke' });
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-automation',
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const trackPendingApproval = vi.fn();
    const onPendingApproval = vi.fn();

    const result = await tryAutomationControlPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Delete Browser Read Smoke.',
      },
      executeTool,
      trackPendingApproval,
      onPendingApproval,
      formatPendingApprovalPrompt: () => 'Approval UI rendered.',
      resolvePendingApprovalMetadata: (_ids, fallback) => fallback,
    }, {
      intentDecision: {
        route: 'automation_control',
        confidence: 'high',
        operation: 'delete',
        summary: 'Delete an existing automation.',
        entities: {
          automationName: 'Browser Read Smoke',
        },
      },
    });

    expect(result?.content).toContain("I prepared deletion of 'Browser Read Smoke'.");
    expect(result?.content).toContain('Approval UI rendered.');
    expect(result?.metadata?.pendingApprovals).toEqual([
      {
        id: 'approval-automation',
        toolName: 'automation_delete',
        argsPreview: '{"automationId":"browser-read-smoke"}',
      },
    ]);
    expect(trackPendingApproval).toHaveBeenCalledWith('approval-automation');
    expect(onPendingApproval).toHaveBeenCalledTimes(1);
  });

  it('surfaces catalog lookup errors instead of pretending the catalog is empty', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'automation_list') {
        return {
          success: false,
          message: 'Automation control plane is not available.',
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationControlPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Show me the saved automations.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_control',
        confidence: 'high',
        operation: 'inspect',
        summary: 'Inspect the automation catalog.',
        entities: {},
      },
    });

    expect(result?.content).toContain('I could not inspect the automation catalog right now');
    expect(result?.content).toContain('Automation control plane is not available.');
  });

  it('accepts nested automation_list payloads from the live tool wrapper', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            output: {
              automations: [{
                id: 'browser-read-smoke',
                name: 'Browser Read Smoke',
                kind: 'workflow',
                enabled: true,
                workflow: {
                  id: 'browser-read-smoke',
                  name: 'Browser Read Smoke',
                  enabled: true,
                  mode: 'sequential',
                  steps: [{ id: 'step-1', toolName: 'browser_navigate' }],
                },
              }],
            },
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationControlPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Show me the automation Browser Read Smoke.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_control',
        confidence: 'high',
        operation: 'inspect',
        summary: 'Inspect an existing automation.',
        entities: {
          automationName: 'Browser Read Smoke',
        },
      },
    });

    expect(result?.content).toContain('Browser Read Smoke (workflow)');
  });

  it('refuses to run built-in starter catalog entries', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            automations: [{
              id: 'builtin-browser-read',
              name: 'Builtin Browser Read',
              kind: 'workflow',
              enabled: false,
              builtin: true,
              source: 'builtin_example',
              workflow: {
                id: 'builtin-browser-read',
                name: 'Builtin Browser Read',
                enabled: false,
                mode: 'sequential',
                steps: [{ id: 'step-1', toolName: 'browser_navigate' }],
              },
            }],
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationControlPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Run Builtin Browser Read.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_control',
        confidence: 'high',
        operation: 'run',
        summary: 'Run an existing automation.',
        entities: {
          automationName: 'Builtin Browser Read',
        },
      },
    });

    expect(result?.content).toContain('built-in starter example');
    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});
