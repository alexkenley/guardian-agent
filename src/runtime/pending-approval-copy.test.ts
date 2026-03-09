import { describe, expect, it } from 'vitest';
import {
  describePendingApproval,
  formatPendingApprovalMessage,
  shouldUseStructuredPendingApprovalMessage,
} from './pending-approval-copy.js';

describe('pending approval copy', () => {
  it('recognizes weak approval placeholder text', () => {
    expect(shouldUseStructuredPendingApprovalMessage('I need your approval before proceeding.')).toBe(true);
    expect(shouldUseStructuredPendingApprovalMessage('The tool is available. Need to call it with correct arguments: action and value.')).toBe(true);
    expect(shouldUseStructuredPendingApprovalMessage('I need to add S:\\Development to allowed paths first, then I can create the file there.')).toBe(false);
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
});
