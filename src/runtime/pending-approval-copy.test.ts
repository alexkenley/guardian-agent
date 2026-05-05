import { describe, expect, it } from 'vitest';
import {
  buildPendingApprovalMetadata,
  describePendingApproval,
  formatPendingApprovalMessage,
  isPhantomPendingApprovalMessage,
  shouldUseStructuredPendingApprovalMessage,
} from './pending-approval-copy.js';

describe('pending approval copy', () => {
  it('recognizes weak approval placeholder text', () => {
    expect(shouldUseStructuredPendingApprovalMessage('I need your approval before proceeding.')).toBe(true);
    expect(shouldUseStructuredPendingApprovalMessage('This action needs approval before I can continue.')).toBe(true);
    expect(shouldUseStructuredPendingApprovalMessage('The tool is available. Need to call it with correct arguments: action and value.')).toBe(true);
    expect(shouldUseStructuredPendingApprovalMessage('I need to add S:\\Development to allowed paths first, then I can create the file there.')).toBe(false);
  });

  it('detects phantom approval text that should never be shown without metadata', () => {
    expect(isPhantomPendingApprovalMessage('This action needs approval before I can continue.')).toBe(true);
    expect(isPhantomPendingApprovalMessage('This action needs your approval. The approval UI is shown to the user automatically.')).toBe(true);
    expect(isPhantomPendingApprovalMessage('Waiting for approval to write S:\\Development\\test23.txt.')).toBe(true);
    expect(isPhantomPendingApprovalMessage([
      'Great news — Claude Code is now enabled!',
      '',
      'Waiting for approval to run coding_backend_run - {"task":"Say hello","backend":"claude-code"}.',
    ].join('\n'))).toBe(true);
    expect(isPhantomPendingApprovalMessage('Approval required for this action:\ncoding_backend_run: {"task":"Say hello"}')).toBe(true);
    expect(isPhantomPendingApprovalMessage('The message "Waiting for approval to write S:\\Development\\test23.txt." is what Guardian shows before approval.')).toBe(false);
  });

  it('describes policy updates without leaking schema jargon', () => {
    expect(describePendingApproval({
      toolName: 'update_tool_policy',
      argsPreview: '{"action":"add_path","value":"S:\\\\Development"}',
    })).toBe('add S:\\Development to allowed paths');
  });

  it('formats a single approval as concrete action copy', () => {
    expect(formatPendingApprovalMessage([
      {
        toolName: 'fs_write',
        argsPreview: '{"path":"S:\\\\Development\\\\test23.txt","content":"Test content","append":false}',
      },
    ])).toBe('Waiting for approval to write S:\\Development\\test23.txt.');
  });

  it('formats automation approvals without leaking raw tool names', () => {
    expect(formatPendingApprovalMessage([
      {
        toolName: 'automation_save',
        argsPreview: '{"id":"minute-net-scans","name":"Minute Net Scans","kind":"workflow"}',
      },
    ])).toBe('Waiting for approval to save automation Minute Net Scans.');
  });

  it('formats LLM provider updates as concrete approval copy', () => {
    expect(formatPendingApprovalMessage([
      {
        toolName: 'llm_provider_update',
        argsPreview: '{"action":"set_model","provider":"ollama","model":"gemma3:latest"}',
      },
    ])).toBe('Waiting for approval to switch ollama to model gemma3:latest.');
  });

  it('formats performance actions as concrete approval copy', () => {
    expect(formatPendingApprovalMessage([
      {
        toolName: 'performance_action_run',
        argsPreview: '{"actionId":"cleanup","selectionMode":"checked_by_default"}',
      },
    ])).toBe('Waiting for approval to run performance action cleanup using default recommended selection.');
  });

  it('formats local Second Brain calendar approvals without raw timestamps', () => {
    const startsAt = new Date(2026, 3, 7, 12, 0, 0, 0).getTime();
    const endsAt = new Date(2026, 3, 7, 13, 0, 0, 0).getTime();
    const expectedDate = new Date(startsAt).toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const expectedStartTime = new Date(startsAt).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    const expectedEndTime = new Date(endsAt).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });

    const message = formatPendingApprovalMessage([
      {
        toolName: 'second_brain_calendar_upsert',
        argsPreview: JSON.stringify({
          title: "Doctor's Appointment",
          startsAt,
          endsAt,
          location: "Narangba Doctor's Surgery, Narangba",
        }),
      },
    ]);

    expect(message).toBe(
      `Waiting for approval to create local calendar event "Doctor's Appointment" on ${expectedDate} from ${expectedStartTime} to ${expectedEndTime} at Narangba Doctor's Surgery, Narangba.`,
    );
    expect(message).not.toMatch(/\b\d{12,}\b/);
  });

  it('formats Microsoft 365 calendar approvals without raw tool JSON', () => {
    const expectedDate = new Date(Date.UTC(2026, 3, 7, 12, 0, 0, 0)).toLocaleDateString(undefined, {
      timeZone: 'UTC',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const expectedStartTime = new Date(Date.UTC(2000, 0, 1, 13, 0, 0, 0)).toLocaleTimeString(undefined, {
      timeZone: 'UTC',
      hour: 'numeric',
      minute: '2-digit',
    });
    const expectedEndTime = new Date(Date.UTC(2000, 0, 1, 13, 30, 0, 0)).toLocaleTimeString(undefined, {
      timeZone: 'UTC',
      hour: 'numeric',
      minute: '2-digit',
    });

    const message = formatPendingApprovalMessage([
      {
        toolName: 'm365',
        argsPreview: JSON.stringify({
          service: 'calendar',
          resource: 'me/events',
          method: 'create',
          json: {
            subject: 'Extended Toilet Break',
            showAs: 'oof',
            start: { dateTime: '2026-04-07T13:00:00', timeZone: 'Pacific/Auckland' },
            end: { dateTime: '2026-04-07T13:30:00', timeZone: 'Pacific/Auckland' },
          },
        }),
      },
    ]);

    expect(message).toBe(
      `Waiting for approval to create Microsoft 365 calendar event "Extended Toilet Break" on ${expectedDate} from ${expectedStartTime} to ${expectedEndTime} (Pacific/Auckland).`,
    );
    expect(message).not.toContain('"service":"calendar"');
  });

  it('formats coding backend approvals without raw JSON', () => {
    expect(formatPendingApprovalMessage([
      {
        toolName: 'coding_backend_run',
        argsPreview: '{"backend":"codex","task":"Fix the failing test"}',
      },
    ])).toBe('Waiting for approval to run Codex task "Fix the failing test".');
  });

  it('formats multiple approvals as a short action list', () => {
    expect(formatPendingApprovalMessage([
      {
        toolName: 'update_tool_policy',
        argsPreview: '{"action":"add_path","value":"S:\\\\Development"}',
      },
      {
        toolName: 'fs_write',
        argsPreview: '{"path":"S:\\\\Development\\\\test23.txt","content":"Test content","append":false}',
      },
    ])).toBe([
      'Waiting for approval on 2 actions:',
      '- add S:\\Development to allowed paths',
      '- write S:\\Development\\test23.txt',
    ].join('\n'));
  });

  it('formats code create approvals without exposing file content JSON', () => {
    expect(formatPendingApprovalMessage([
      {
        toolName: 'code_create',
        argsPreview: '{"path":"package.json","content":"{\\"name\\":\\"musicapp\\",\\"scripts\\":{\\"dev\\":\\"vite\\"}}"}',
      },
    ])).toBe('Waiting for approval to create package.json.');

    expect(formatPendingApprovalMessage([
      {
        toolName: 'code_create',
        argsPreview: '{"path":"package.json","content":"..."}',
      },
      {
        toolName: 'code_create',
        argsPreview: '{"path":"src/client/main.tsx","content":"..."}',
      },
      {
        toolName: 'code_create',
        argsPreview: '{"path":".prettierrc","content":"..."}',
      },
    ])).toBe([
      'Waiting for approval to create 3 files:',
      '- create package.json',
      '- create main.tsx',
      '- create .prettierrc',
    ].join('\n'));
  });

  it('formats directory and package install approvals with concise labels', () => {
    expect(formatPendingApprovalMessage([
      {
        toolName: 'fs_mkdir',
        argsPreview: '{"path":"S:\\\\Development\\\\MusicApp\\\\src\\\\server\\\\api"}',
      },
      {
        toolName: 'package_install',
        argsPreview: '{"command":"npm install better-sqlite3 drizzle-orm express cors zod react react-dom react-router-dom","cwd":"S:\\\\Development\\\\MusicApp"}',
      },
    ])).toBe([
      'Waiting for approval on 2 actions:',
      '- create directory S:\\Development\\MusicApp\\src\\server\\api',
      '- install packages in S:\\Development\\MusicApp: better-sqlite3, drizzle-orm, express, cors, zod, +3 more',
    ].join('\n'));
  });

  it('ignores raw model-style approval labels when structured args can produce clearer copy', () => {
    expect(formatPendingApprovalMessage([
      {
        toolName: 'code_create',
        actionLabel: 'run code create - {"path":"package.json","content":"very long content"}',
        argsPreview: '{"path":"package.json","content":"very long content"}',
      },
      {
        toolName: 'code_create',
        actionLabel: 'run code create - {"path":"package.json","content":"very long content"}',
        argsPreview: '{"path":"package.json","content":"very long content"}',
      },
    ])).toBe([
      'Waiting for approval to create 2 files:',
      '- create package.json (2 duplicate requests)',
    ].join('\n'));
  });

  it('builds structured approval metadata with fallback values', () => {
    expect(buildPendingApprovalMetadata(
      ['approval-1', 'approval-2', 'approval-1', ''],
      new Map([
        ['approval-1', {
          toolName: 'coding_backend_run',
          argsPreview: '{"backend":"codex"}',
          requestId: 'req-1',
          codeSessionId: 'session-1',
        }],
      ]),
    )).toEqual([
      {
        id: 'approval-1',
        toolName: 'coding_backend_run',
        argsPreview: '{"backend":"codex"}',
        actionLabel: 'run Codex',
        requestId: 'req-1',
        codeSessionId: 'session-1',
      },
      {
        id: 'approval-2',
        toolName: 'unknown',
        argsPreview: '',
        actionLabel: 'run unknown',
      },
    ]);
  });
});
