import { describe, expect, it } from 'vitest';
import { extractPathHint, extractSearchQuery, parseDirectFileSearchIntent } from './search-intent.js';
import type { ToolPolicySnapshot } from '../tools/types.js';

const policy: ToolPolicySnapshot = {
  mode: 'approve_by_policy',
  toolPolicies: {},
  sandbox: {
    allowedPaths: [
      'C:\\Users\\kenle\\OneDrive\\Development\\OpenAgent',
      'C:\\Users\\kenle\\OneDrive\\Technical and GRC',
    ],
    allowedCommands: [],
    allowedDomains: [],
  },
};

describe('search-intent parser', () => {
  it('extracts quoted search query', () => {
    const query = extractSearchQuery('Search folder for "Code GRC" please.');
    expect(query).toBe('Code GRC');
  });

  it('extracts windows path without swallowing trailing "for"', () => {
    const text = 'Search my OneDrive folder C:\\Users\\kenle\\OneDrive\\Technical and GRC for "five" and "Code GRC".';
    const path = extractPathHint(text);
    expect(path).toBe('C:\\Users\\kenle\\OneDrive\\Technical and GRC');
  });

  it('builds direct intent from path + query prompt', () => {
    const text = 'Search my OneDrive folder C:\\Users\\kenle\\OneDrive\\Technical and GRC for "five" and "Code GRC".';
    const intent = parseDirectFileSearchIntent(text, policy);
    expect(intent).toEqual({
      path: 'C:\\Users\\kenle\\OneDrive\\Technical and GRC',
      query: 'five',
    });
  });
});
