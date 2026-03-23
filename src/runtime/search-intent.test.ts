import { describe, expect, it } from 'vitest';
import {
  extractPathHint,
  extractSearchQuery,
  isDirectBrowserAutomationIntent,
  parseDirectFileSearchIntent,
  parseWebSearchIntent,
} from './search-intent.js';
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

  it('detects explicit browser URL automation requests', () => {
    expect(isDirectBrowserAutomationIntent('Open https://httpbin.org/forms/post and list the interactive elements on the page.')).toBe(true);
    expect(isDirectBrowserAutomationIntent('Go to https://example.com and click the More information link.')).toBe(true);
    expect(isDirectBrowserAutomationIntent('Use browser_state and browser_act to click the login button.')).toBe(true);
  });

  it('does not classify generic web search requests as browser automation', () => {
    expect(isDirectBrowserAutomationIntent('Search the web for the latest Playwright MCP news.')).toBe(false);
  });

  it('does not hijack explicit browser prompts into web search intent', () => {
    expect(parseWebSearchIntent('Open https://httpbin.org/forms/post and list the interactive elements on the page.')).toBeNull();
    expect(parseWebSearchIntent('Go to https://example.com and click the More information link.')).toBeNull();
  });
});
