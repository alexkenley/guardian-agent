import { describe, expect, it } from 'vitest';
import {
  extractExplicitProfileId,
  findExplicitBuiltinToolName,
  listBuiltinToolsMissingRouteCoverage,
  resolveRouteForExplicitToolName,
} from './capability-inventory.js';

describe('capability inventory', () => {
  it('maps every built-in tool name to an owning intent route', () => {
    expect(listBuiltinToolsMissingRouteCoverage()).toEqual([]);
  });

  it('detects explicit built-in tool mentions and resolves their owning route', () => {
    expect(findExplicitBuiltinToolName('Run the cloud tool whm_status using profileId social.')).toBe('whm_status');
    expect(resolveRouteForExplicitToolName('whm_status')).toBe('general_assistant');
    expect(resolveRouteForExplicitToolName('assistant_security_scan')).toBe('security_task');
    expect(resolveRouteForExplicitToolName('automation_output_read')).toBe('automation_output_task');
    expect(resolveRouteForExplicitToolName('code_session_current')).toBe('coding_session_control');
    expect(resolveRouteForExplicitToolName('guardian_issue_draft')).toBe('diagnostics_task');
    expect(resolveRouteForExplicitToolName('github_issue_create')).toBe('diagnostics_task');
    expect(resolveRouteForExplicitToolName('github_status')).toBe('general_assistant');
  });

  it('extracts explicit profile ids without guessing from prose labels', () => {
    expect(extractExplicitProfileId('Run whm_status using profileId social.')).toBe('social');
    expect(extractExplicitProfileId('Use the social profile for whm_status.')).toBeUndefined();
  });
});
