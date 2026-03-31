import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { tryAutomationPreRoute } from './automation-prerouter.js';

const baseMessage = {
  id: 'msg-1',
  userId: 'owner',
  principalId: 'owner',
  principalRole: 'owner' as const,
  agentId: 'default',
  channel: 'web',
  content: '',
};

describe('tryAutomationPreRoute', () => {
  it('returns null for non-automation requests', async () => {
    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Read ./companies.csv and tell me what is inside.',
      },
      executeTool: vi.fn(),
    });

    expect(result).toBeNull();
  });

  it('keeps forced authoring requests inside automation clarification instead of returning null', async () => {
    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Create it as an automation.',
      },
      executeTool: vi.fn(),
    }, {
      assumeAuthoring: true,
    });

    expect(result?.content).toContain('I drafted the native Guardian step-based automation draft');
    expect(result?.content).toContain('Missing details:');
  });

  it('returns a draft clarification for incomplete named automations instead of falling through', async () => {
    const executeTool = vi.fn();

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Build a workflow called Company Homepage Collector ... Do not schedule it yet.',
      },
      executeTool,
    }, {
      assumeAuthoring: true,
    });

    expect(result?.content).toContain("I drafted the native Guardian manual assistant automation draft 'Company Homepage Collector'");
    expect(result?.content).toContain('Missing details:');
    expect(result?.content).toContain('Tell me what the automation should actually do when it runs');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('routes native scheduled automation requests through automation_save before generic tools', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: { automations: [] },
        };
      }
      if (toolName === 'automation_save') {
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-1',
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });
    const onPendingApproval = vi.fn();

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Create a native Guardian scheduled assistant task called Weekday Lead Research that runs weekdays at 9 AM. It should read ./companies.csv, research each company\'s website and public presence, score fit from 1-5 using a simple B2B SaaS ICP, and write ./lead-research-output.csv plus ./lead-research-summary.md. Use built-in Guardian tools only.',
      },
      executeTool,
      onPendingApproval,
      formatPendingApprovalPrompt: () => 'Approval UI should be shown.',
    }, {
      assumeAuthoring: true,
    });

    expect(result).not.toBeNull();
    expect(result?.content).toContain("scheduled assistant task 'Weekday Lead Research'");
    expect(result?.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          kind: 'approval',
          approvalSummaries: [
            {
              id: 'approval-1',
              toolName: 'automation_save',
              argsPreview: expect.any(String),
            },
          ],
        },
      },
    });
    expect(executeTool).toHaveBeenNthCalledWith(
      1,
      'automation_list',
      {},
      expect.objectContaining({ channel: 'web', userId: 'owner' }),
    );
    expect(executeTool.mock.calls.some((call) => (
      call[0] === 'automation_save'
      && call[1]?.name === 'Weekday Lead Research'
      && call[1]?.kind === 'assistant_task'
      && call[1]?.schedule?.cron === '0 9 * * 1-5'
    ))).toBe(true);
    expect(onPendingApproval).toHaveBeenCalledWith({
      approvalId: 'approval-1',
      toolName: 'automation_save',
      automationName: 'Weekday Lead Research',
      artifactLabel: 'native Guardian scheduled assistant task',
      verb: 'created',
    });
  });

  it('updates matching scheduled automation tasks instead of creating duplicates', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: {
            automations: [
              {
                id: 'weekday-lead-research',
                name: 'Weekday Lead Research',
                kind: 'assistant_task',
                builtin: false,
                task: {
                  id: 'task-1',
                  kind: 'task',
                  type: 'agent',
                  target: 'default',
                  cron: '0 9 * * 1-5',
                  channel: 'web',
                  deliver: true,
                },
              },
            ],
          },
        };
      }
      if (toolName === 'automation_save') {
        return {
          success: true,
          output: {
            success: true,
            message: 'Saved.',
            automationId: 'weekday-lead-research',
            taskId: 'task-1',
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Build a weekday lead research workflow that reads ./companies.csv, researches each company\'s website and public presence, scores fit from 1-5 using a simple B2B SaaS ICP, writes results to ./lead-research-output.csv, and creates ./lead-research-summary.md. Use built-in Guardian tools only. Do not create any shell script, Python script, or code file.',
      },
      executeTool,
    }, {
      assumeAuthoring: true,
    });

    expect(result?.content).toContain("Updated scheduled assistant task 'Weekday Lead Research'");
    expect(result?.content).toContain('Schedule: 0 9 * * 1-5');
    expect(executeTool).toHaveBeenNthCalledWith(
      2,
      'automation_save',
      expect.objectContaining({ existingTaskId: 'task-1', name: 'Weekday Lead Research' }),
      expect.objectContaining({ channel: 'web', userId: 'owner' }),
    );
  });

  it('routes deterministic browser smoke workflows through wrapper tool steps', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'automation_list') {
        return { success: true, output: { automations: [] } };
      }
      if (toolName === 'automation_save') {
        expect(args).toMatchObject({
          id: 'browser-read-smoke',
          name: 'Browser Read Smoke',
          enabled: true,
          kind: 'workflow',
          mode: 'sequential',
          steps: [
            {
              toolName: 'browser_navigate',
              args: { url: 'https://example.com', mode: 'read' },
            },
            {
              toolName: 'browser_read',
            },
            {
              toolName: 'browser_links',
            },
          ],
        });
        return {
          success: true,
          output: {
            success: true,
            message: 'Saved.',
            automationId: 'browser-read-smoke',
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Create an automation called Browser Read Smoke. When I run it, it should open https://example.com, read the page, list the links, and keep the results in the automation run output only. Do not schedule it yet.',
      },
      executeTool,
    }, {
      assumeAuthoring: true,
    });

    expect(result?.content).toContain('Browser Read Smoke');
    expect(executeTool).toHaveBeenCalledWith(
      'automation_save',
      expect.objectContaining({
        id: 'browser-read-smoke',
        name: 'Browser Read Smoke',
      }),
      expect.objectContaining({ channel: 'web', userId: 'owner' }),
    );
  });

  it('routes unscheduled open-ended requests to manual assistant automations instead of falling through', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: { automations: [] },
        };
      }
      if (toolName === 'automation_save') {
        expect(args).toMatchObject({
          id: 'company-homepage-collector',
          name: 'Company Homepage Collector',
          kind: 'assistant_task',
          task: {
            target: 'default',
          },
          schedule: { enabled: false },
        });
        return {
          success: true,
          output: {
            success: true,
            message: 'Saved.',
            automationId: 'company-homepage-collector',
            taskId: 'task-manual-1',
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Build a workflow called Company Homepage Collector that reads ./companies.csv, opens each company homepage, extracts the page title and meta description, and writes ./tmp/company-homepages.json. Do not schedule it yet.',
      },
      executeTool,
    }, {
      assumeAuthoring: true,
    });

    expect(result?.content).toContain("Created manual assistant automation 'Company Homepage Collector'");
    expect(result?.content).toContain('Runs on demand only');
    expect(executeTool.mock.calls.some((call) => call[0] === 'automation_save')).toBe(true);
  });

  it('blocks automation creation when required input files are missing', async () => {
    const executeTool = vi.fn();

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Build a weekday lead research workflow that reads ./missing-automation-input.csv, researches each company\'s website, and writes results to ./lead-research-output.csv. Use built-in Guardian tools only.',
      },
      preflightTools: () => [
        { name: 'fs_read', found: true, decision: 'allow', reason: 'ok', fixes: [] },
        { name: 'fs_write', found: true, decision: 'allow', reason: 'ok', fixes: [] },
        { name: 'web_search', found: true, decision: 'allow', reason: 'ok', fixes: [] },
      ],
      executeTool,
    });

    expect(result?.content).toContain('not execution-ready');
    expect(result?.content).toContain("./missing-automation-input.csv");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('blocks scheduled assistant tasks that would still require runtime approvals', async () => {
    const executeTool = vi.fn();

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Create a daily 7:30 AM automation that checks my high-priority inbox, summarizes anything actionable, drafts replies, and asks for approval before sending anything.',
      },
      preflightTools: (requests) => requests.map((request) => {
        if (request.name === 'gmail_draft') {
          return {
            name: request.name,
            found: true,
            decision: 'require_approval' as const,
            reason: 'Mutating tool requires approval in "approve_by_policy" mode',
            fixes: [{ type: 'tool_policy' as const, value: 'gmail_draft', description: 'Set per-tool policy for "gmail_draft" to auto-approve' }],
          };
        }
        return {
          name: request.name,
          found: true,
          decision: 'allow' as const,
          reason: 'ok',
          fixes: [],
        };
      }),
      executeTool,
    }, { allowRemediation: false, assumeAuthoring: true });

    expect(result?.content).toContain('not execution-ready');
    expect(result?.content).toContain('gmail_draft');
    expect(result?.content).toContain('auto-approve');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('stages remediation approvals for fixable policy blockers', async () => {
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'update_tool_policy') {
        expect(args).toEqual({ action: 'add_path', value: 'C:\\Temp\\lead-summary.md' });
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-policy-1',
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Create a daily 8:00 AM automation that reads ./companies.csv, writes a summary report to C:\\Temp\\lead-summary.md, and uses built-in Guardian tools only.',
      },
      preflightTools: (requests) => requests.map((request) => {
        if (request.name === 'fs_write') {
          return {
            name: request.name,
            found: true,
            decision: 'deny' as const,
            reason: 'Path is not in allowedPaths',
            fixes: [{ type: 'path' as const, value: 'C:\\Temp\\lead-summary.md', description: 'Add C:\\Temp\\lead-summary.md to allowed paths' }],
          };
        }
        return {
          name: request.name,
          found: true,
          decision: 'allow' as const,
          reason: 'ok',
          fixes: [],
        };
      }),
      executeTool,
      formatPendingApprovalPrompt: () => 'Approval UI should be shown.',
    }, {
      assumeAuthoring: true,
    });

    expect(result?.content).toContain('fixable policy blockers');
    expect(result?.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          kind: 'approval',
          approvalSummaries: [
            {
              id: 'approval-policy-1',
              toolName: 'update_tool_policy',
              argsPreview: expect.any(String),
            },
          ],
        },
      },
      resumeAutomationAfterApprovals: true,
    });
  });

  it('retries automation creation after immediate remediation succeeds', async () => {
    let pathAllowed = false;
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'update_tool_policy') {
        expect(args).toEqual({ action: 'add_path', value: 'C:\\Temp\\lead-summary.md' });
        pathAllowed = true;
        return {
          success: true,
          message: 'Policy updated.',
        };
      }
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: { automations: [] },
        };
      }
      if (toolName === 'automation_save') {
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-task-1',
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Create a daily 8:00 AM automation that reads ./companies.csv, writes a summary report to C:\\Temp\\lead-summary.md, and uses built-in Guardian tools only.',
      },
      preflightTools: (requests) => requests.map((request) => {
        if (request.name === 'fs_write' && !pathAllowed) {
          return {
            name: request.name,
            found: true,
            decision: 'deny' as const,
            reason: 'Path is not in allowedPaths',
            fixes: [{ type: 'path' as const, value: 'C:\\Temp\\lead-summary.md', description: 'Add C:\\Temp\\lead-summary.md to allowed paths' }],
          };
        }
        return {
          name: request.name,
          found: true,
          decision: 'allow' as const,
          reason: 'ok',
          fixes: [],
        };
      }),
      executeTool,
      formatPendingApprovalPrompt: () => 'Approval UI should be shown.',
    }, {
      assumeAuthoring: true,
    });

    expect(pathAllowed).toBe(true);
    expect(result?.content).toContain('scheduled assistant task');
    expect(executeTool.mock.calls.some((call) => call[0] === 'automation_save')).toBe(true);
  });

  it('continues scheduled assistant creation after path remediation even when the output parent directory is missing', async () => {
    let pathAllowed = false;
    const externalPath = 'D:\\Reports\\lead-summary.md';
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'update_tool_policy') {
        expect(args).toEqual({ action: 'add_path', value: externalPath });
        pathAllowed = true;
        return {
          success: true,
          message: `Policy updated: add_path '${externalPath}'.`,
        };
      }
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: { automations: [] },
        };
      }
      if (toolName === 'automation_save') {
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-task-missing-parent-1',
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Create a daily 8:00 AM automation that reads ./companies.csv, writes a summary report to D:\\\\Repor    ts\\\\lead-summary.md, and uses built-in Guardian tools only.',
      },
      preflightTools: (requests) => requests.map((request) => {
        if (request.name === 'fs_write' && !pathAllowed) {
          return {
            name: request.name,
            found: true,
            decision: 'deny' as const,
            reason: 'Path is not in allowedPaths',
            fixes: [{ type: 'path' as const, value: externalPath, description: `Add ${externalPath} to allowed paths` }],
          };
        }
        return {
          name: request.name,
          found: true,
          decision: 'allow' as const,
          reason: 'ok',
          fixes: [],
        };
      }),
      executeTool,
      formatPendingApprovalPrompt: () => 'Approval UI should be shown.',
    }, {
      assumeAuthoring: true,
    });

    expect(pathAllowed).toBe(true);
    expect(result?.content).toContain('scheduled assistant task');
    expect(result?.content).not.toContain('not execution-ready');
    expect(result?.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          kind: 'approval',
          approvalSummaries: [
            {
              id: 'approval-task-missing-parent-1',
              toolName: 'automation_save',
              argsPreview: expect.any(String),
            },
          ],
        },
      },
    });
    expect(executeTool.mock.calls.some((call) => (
      call[0] === 'automation_save'
      && call[1]?.name === 'Daily Lead Summary'
    ))).toBe(true);
  });

  it('allows scheduled assistant tasks when predicted approvals are only for bounded workspace writes', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'automation_list') {
        return {
          success: true,
          output: { automations: [] },
        };
      }
      if (toolName === 'automation_save') {
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-write-bounded-1',
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Build a weekday lead research workflow that reads ./companies.csv, researches each company\'s website and public presence, scores fit from 1-5 using a simple B2B SaaS ICP, writes results to ./lead-research-output.csv, and creates ./lead-research-summary.md. Use built-in Guardian tools only. Do not create any shell script, Python script, or code file.',
      },
      preflightTools: (requests) => requests.map((request) => {
        if (request.name === 'fs_write') {
          return {
            name: request.name,
            found: true,
            decision: 'require_approval' as const,
            reason: 'Mutating tool requires approval in "approve_by_policy" mode',
            fixes: [{ type: 'tool_policy' as const, value: 'fs_write', description: 'Set per-tool policy for "fs_write" to auto-approve' }],
          };
        }
        return {
          name: request.name,
          found: true,
          decision: 'allow' as const,
          reason: 'ok',
          fixes: [],
        };
      }),
      executeTool,
      formatPendingApprovalPrompt: () => 'Approval UI should be shown.',
    }, {
      assumeAuthoring: true,
    });

    expect(result).not.toBeNull();
    expect(result?.content).toContain('scheduled assistant task');
    expect(executeTool).toHaveBeenCalledWith(
      'automation_save',
      expect.objectContaining({
        name: 'Weekday Lead Research',
        kind: 'assistant_task',
      }),
      expect.objectContaining({ channel: 'web', userId: 'owner' }),
    );
  });

  it('treats relative workflow output paths as workspace-rooted during preflight', async () => {
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'automation_list') {
        return { success: true, output: { automations: [] } };
      }
      if (toolName === 'automation_save') {
        return {
          success: false,
          status: 'pending_approval',
          approvalId: 'approval-workflow-relative-1',
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ga-automation-preroute-'));
    writeFileSync(join(workspaceRoot, 'companies.csv'), 'Company Name\nAcme SaaS\n');

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Create a sequential Guardian workflow that first reads ./companies.csv, then runs a fixed summarization step, then writes ./lead-research-summary.md.',
      },
      workspaceRoot,
      allowedPaths: [workspaceRoot],
      preflightTools: (requests) => requests.map((request) => {
        if (request.name === 'fs_read') {
          expect(request.args?.path).toBe(join(workspaceRoot, 'companies.csv'));
        }
        if (request.name === 'fs_write') {
          expect(request.args?.path).toBe(join(workspaceRoot, 'lead-research-summary.md'));
        }
        return {
          name: request.name,
          found: true,
          decision: 'allow' as const,
          reason: 'ok',
          fixes: [],
        };
      }),
      executeTool,
      formatPendingApprovalPrompt: () => 'Approval UI should be shown.',
    }, {
      assumeAuthoring: true,
    });

    expect(result?.content).toContain('native Guardian step-based automation');
    expect(result?.metadata).toMatchObject({
      pendingAction: {
        blocker: {
          kind: 'approval',
          approvalSummaries: [
            {
              id: 'approval-workflow-relative-1',
              toolName: 'automation_save',
              argsPreview: expect.any(String),
            },
          ],
        },
      },
    });
    expect(executeTool).toHaveBeenCalledWith(
      'automation_save',
      expect.objectContaining({
        name: 'Lead Research Summary Workflow',
      }),
      expect.objectContaining({ channel: 'web', userId: 'owner' }),
    );
  });

  it('treats explicit URLs as domains, not local filesystem paths, during scheduled-agent validation', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ga-automation-preroute-'));
    writeFileSync(join(workspaceRoot, 'companies.csv'), 'Company Name\nAcme SaaS\n');
    const executeTool = vi.fn();
    const seenRequests: Array<{ name: string; args?: Record<string, unknown> }> = [];

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Create a daily 8:00 AM automation that reads ./companies.csv, fetches https://example.com, writes a summary report to C:\\Temp\\lead-summary.md, and drafts an email with the summary using built-in Guardian tools only.',
      },
      workspaceRoot,
      allowedPaths: [workspaceRoot],
      preflightTools: (requests) => {
        seenRequests.push(...requests);
        return requests.map((request) => {
        if (request.name === 'fs_read') {
          expect(request.args?.path).toBe(join(workspaceRoot, 'companies.csv'));
          return {
            name: request.name,
            found: true,
            decision: 'allow' as const,
            reason: 'ok',
            fixes: [],
          };
        }
        if (request.name === 'web_fetch') {
          expect(request.args?.url).toBe('https://example.com');
          return {
            name: request.name,
            found: true,
            decision: 'deny' as const,
            reason: "Host 'example.com' is not in allowedDomains.",
            fixes: [{ type: 'domain' as const, value: 'example.com', description: "Add 'example.com' to allowed domains" }],
          };
        }
        if (request.name === 'fs_write') {
          return {
            name: request.name,
            found: true,
            decision: 'require_approval' as const,
            reason: 'Mutating tool requires approval in "approve_by_policy" mode',
            fixes: [
              { type: 'tool_policy' as const, value: 'fs_write', description: 'Set per-tool policy for "fs_write" to auto-approve' },
              { type: 'path' as const, value: 'C:\\Temp\\lead-summary.md', description: "Add 'C:\\Temp\\lead-summary.md' to allowed paths" },
            ],
          };
        }
        if (request.name === 'gmail_draft') {
          return {
            name: request.name,
            found: true,
            decision: 'require_approval' as const,
            reason: 'Mutating tool requires approval in "approve_by_policy" mode',
            fixes: [{ type: 'tool_policy' as const, value: 'gmail_draft', description: 'Set per-tool policy for "gmail_draft" to auto-approve' }],
          };
        }
        throw new Error(`Unexpected validation request ${request.name}`);
        });
      },
      executeTool,
    }, { allowRemediation: false, assumeAuthoring: true });

    expect(seenRequests.some((request) => (
      request.name === 'web_fetch'
      && request.args?.url === 'https://example.com'
    ))).toBe(true);
    expect(seenRequests.some((request) => (
      request.name === 'fs_write'
      && request.args?.path === 'C:\\Temp\\lead-summary.md'
    ))).toBe(true);
    expect(seenRequests.some((request) => (
      request.name === 'fs_read'
      && request.args?.path === 'https://example.com'
    ))).toBe(false);
    expect(seenRequests.some((request) => (
      request.name === 'fs_write'
      && request.args?.path === 'https://example.com'
    ))).toBe(false);
    expect(result?.content).toContain("Daily Lead Summary");
    expect(result?.content).toContain("Host 'example.com' is not in allowedDomains.");
    expect(result?.content).not.toContain('s://example.com');
    expect(result?.content).not.toContain("s:\\example.com");
    expect(result?.content).toContain("C:\\Temp\\lead-summary.md");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('normalizes wrapped Windows output paths before scheduled-agent validation', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ga-automation-preroute-'));
    writeFileSync(join(workspaceRoot, 'companies.csv'), 'Company Name\nAcme SaaS\n');
    const executeTool = vi.fn();
    const seenRequests: Array<{ name: string; args?: Record<string, unknown> }> = [];

    const result = await tryAutomationPreRoute({
      agentId: 'default',
      message: {
        ...baseMessage,
        content: 'Create a daily 8:00 AM automation that reads ./companies.csv, fetches https://example.com, writes a summary report to C:\\Tem    p\\lead-summary.md, and drafts an email with the summary using built-in Guardian tools only.',
      },
      workspaceRoot,
      allowedPaths: [workspaceRoot],
      preflightTools: (requests) => {
        seenRequests.push(...requests);
        return requests.map((request) => {
          if (request.name === 'fs_read') {
            return {
              name: request.name,
              found: true,
              decision: 'allow' as const,
              reason: 'ok',
              fixes: [],
            };
          }
          if (request.name === 'web_fetch') {
            return {
              name: request.name,
              found: true,
              decision: 'deny' as const,
              reason: "Host 'example.com' is not in allowedDomains.",
              fixes: [{ type: 'domain' as const, value: 'example.com', description: "Add 'example.com' to allowed domains" }],
            };
          }
          if (request.name === 'fs_write') {
            return {
              name: request.name,
              found: true,
              decision: 'require_approval' as const,
              reason: 'Mutating tool requires approval in "approve_by_policy" mode',
              fixes: [
                { type: 'tool_policy' as const, value: 'fs_write', description: 'Set per-tool policy for "fs_write" to auto-approve' },
                { type: 'path' as const, value: 'C:\\Temp\\lead-summary.md', description: "Add 'C:\\Temp\\lead-summary.md' to allowed paths" },
              ],
            };
          }
          if (request.name === 'gmail_draft') {
            return {
              name: request.name,
              found: true,
              decision: 'require_approval' as const,
              reason: 'Mutating tool requires approval in "approve_by_policy" mode',
              fixes: [{ type: 'tool_policy' as const, value: 'gmail_draft', description: 'Set per-tool policy for "gmail_draft" to auto-approve' }],
            };
          }
          throw new Error(`Unexpected validation request ${request.name}`);
        });
      },
      executeTool,
    }, { allowRemediation: false, assumeAuthoring: true });

    expect(seenRequests.some((request) => (
      request.name === 'fs_write'
      && request.args?.path === 'C:\\Temp\\lead-summary.md'
    ))).toBe(true);
    expect(result?.content).toContain("Daily Lead Summary");
    expect(result?.content).toContain("C:\\Temp\\lead-summary.md");
    expect(result?.content).not.toContain("C:\\Tem p\\lead-summary.md");
    expect(executeTool).not.toHaveBeenCalled();
  });
});
