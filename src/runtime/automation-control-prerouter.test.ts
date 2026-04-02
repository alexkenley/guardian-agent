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

  it('renames existing assistant automations in place through automation_save', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            automations: [{
              id: 'it-should-check-account',
              name: 'It Should Check Account',
              kind: 'assistant_task',
              enabled: true,
              task: {
                id: 'it-should-check-account',
                name: 'It Should Check Account',
                description: 'Checks WHM disk quota headroom.',
                type: 'agent',
                target: 'default',
                eventTrigger: { eventType: 'automation:manual:it-should-check-account' },
                prompt: 'Check the WHM social profile for disk quota pressure.',
                channel: 'code-session',
                deliver: true,
                enabled: true,
              },
            }],
          },
        };
      }
      if (toolName === 'automation_save') {
        expect(args).toMatchObject({
          id: 'it-should-check-account',
          name: 'WHM Social Check Disk Quota',
          kind: 'assistant_task',
          existingTaskId: 'it-should-check-account',
          task: {
            target: 'default',
            prompt: 'Check the WHM social profile for disk quota pressure.',
            channel: 'code-session',
            deliver: true,
          },
          schedule: {
            enabled: false,
          },
        });
        return {
          success: true,
          output: {
            success: true,
            message: 'Saved.',
            automationId: 'it-should-check-account',
            taskId: 'it-should-check-account',
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationControlPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Rename that automation to WHM Social Check Disk Quota.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_control',
        confidence: 'high',
        operation: 'update',
        summary: 'Rename an existing automation.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: {
          automationName: 'It Should Check Account',
          newAutomationName: 'WHM Social Check Disk Quota',
        },
      },
    });

    expect(result?.content).toContain("Renamed 'It Should Check Account' to 'WHM Social Check Disk Quota'.");
    expect(executeTool).toHaveBeenNthCalledWith(
      2,
      'automation_save',
      expect.objectContaining({
        id: 'it-should-check-account',
        name: 'WHM Social Check Disk Quota',
        existingTaskId: 'it-should-check-account',
      }),
      expect.objectContaining({ channel: 'web', userId: 'owner' }),
    );
  });

  it('updates existing assistant automations in place when scheduling them', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            automations: [{
              id: 'whm-social-check-disk-quota',
              name: 'WHM Social Check Disk Quota',
              kind: 'assistant_task',
              enabled: true,
              task: {
                id: 'whm-social-check-disk-quota',
                name: 'WHM Social Check Disk Quota',
                description: 'Checks WHM disk quota headroom.',
                type: 'agent',
                target: 'default',
                eventTrigger: { eventType: 'automation:manual:whm-social-check-disk-quota' },
                prompt: 'Check the WHM social profile for disk quota pressure.',
                channel: 'code-session',
                deliver: true,
                enabled: true,
              },
            }],
          },
        };
      }
      if (toolName === 'automation_save') {
        expect(args).toMatchObject({
          id: 'whm-social-check-disk-quota',
          name: 'WHM Social Check Disk Quota',
          kind: 'assistant_task',
          existingTaskId: 'whm-social-check-disk-quota',
          task: {
            target: 'default',
            prompt: 'Check the WHM social profile for disk quota pressure.',
            channel: 'code-session',
            deliver: true,
          },
          schedule: {
            enabled: true,
            cron: '0 9 * * *',
            runOnce: false,
          },
        });
        return {
          success: true,
          output: {
            success: true,
            message: 'Saved.',
            automationId: 'whm-social-check-disk-quota',
            taskId: 'whm-social-check-disk-quota',
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationControlPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Edit the WHM Social Check Disk Quota automation and make it scheduled to run daily at 9:00 AM.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_control',
        confidence: 'high',
        operation: 'update',
        summary: 'Update an existing automation.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: {
          automationName: 'WHM Social Check Disk Quota',
        },
      },
    });

    expect(result?.content).toContain("Updated 'WHM Social Check Disk Quota' to Daily schedule (0 9 * * *).");
    expect(executeTool).toHaveBeenNthCalledWith(
      2,
      'automation_save',
      expect.objectContaining({
        id: 'whm-social-check-disk-quota',
        existingTaskId: 'whm-social-check-disk-quota',
        schedule: {
          enabled: true,
          cron: '0 9 * * *',
          runOnce: false,
        },
      }),
      expect.objectContaining({ channel: 'web', userId: 'owner' }),
    );
  });

  it('returns clarification metadata when an automation update is missing the target automation name', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            automations: [],
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationControlPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Now edit that automation, make it scheduled and run daily at 9:00 AM.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_control',
        confidence: 'high',
        operation: 'update',
        summary: 'Update an existing automation.',
        turnRelation: 'follow_up',
        resolution: 'ready',
        missingFields: [],
        entities: {},
      },
    });

    expect(result?.content).toContain('Tell me which automation');
    expect(result?.metadata).toMatchObject({
      clarification: {
        blockerKind: 'clarification',
        field: 'automation_name',
        route: 'automation_control',
        operation: 'update',
        resolution: 'needs_clarification',
        missingFields: ['automation_name'],
      },
    });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit gateway decision before running automation control', async () => {
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
    });

    expect(result).toBeNull();
    expect(executeTool).not.toHaveBeenCalled();
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
    expect(result?.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          kind: 'approval',
          approvalSummaries: [
            {
              id: 'approval-automation',
              toolName: 'automation_delete',
              argsPreview: '{"automationId":"browser-read-smoke"}',
            },
          ],
        },
      },
    });
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

  it('shows the closest saved automation on inspect when the request only differs by a trailing version token', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
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
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationControlPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Show me the automation Browser Read Smoke 2.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_control',
        confidence: 'high',
        operation: 'inspect',
        summary: 'Inspect an existing automation.',
        entities: {
          automationName: 'Browser Read Smoke 2',
        },
      },
    });

    expect(result?.content).toContain("I couldn't find an exact automation named 'Browser Read Smoke 2'.");
    expect(result?.content).toContain('Browser Read Smoke (workflow)');
  });

  it('runs the closest saved automation when the request only differs by a trailing version token', async () => {
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
        content: 'Run Browser Read Smoke 2 now.',
      },
      executeTool,
    }, {
      intentDecision: {
        route: 'automation_control',
        confidence: 'high',
        operation: 'run',
        summary: 'Run an existing automation.',
        entities: {
          automationName: 'Browser Read Smoke 2',
        },
      },
    });

    expect(result?.content).toContain("I couldn't find an exact automation named 'Browser Read Smoke 2'. I used the closest saved automation: 'Browser Read Smoke'.");
    expect(result?.content).toContain("Ran 'Browser Read Smoke'.");
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
