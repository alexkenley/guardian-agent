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

  it('builds structured approval metadata with fallback values', () => {
    expect(buildPendingApprovalMetadata(
      ['approval-1', 'approval-2', 'approval-1', ''],
      new Map([
        ['approval-1', { toolName: 'coding_backend_run', argsPreview: '{"backend":"codex"}' }],
      ]),
    )).toEqual([
      { id: 'approval-1', toolName: 'coding_backend_run', argsPreview: '{"backend":"codex"}' },
      { id: 'approval-2', toolName: 'unknown', argsPreview: '' },
    ]);
  });
});
