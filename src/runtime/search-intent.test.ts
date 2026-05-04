import { describe, expect, it } from 'vitest';
import {
  extractPathHint,
  extractSearchQuery,
  isDirectBrowserAutomationIntent,
  parseDirectFileSearchIntent,
  parseDirectFilesystemSaveReference,
  parseDirectFilesystemSaveIntent,
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

  it('does not misread URLs as windows drive paths', () => {
    const text = 'Save this link in my library with url "https://example.com".';
    expect(extractPathHint(text)).toBeNull();
  });

  it('builds direct intent from path + query prompt', () => {
    const text = 'Search my OneDrive folder C:\\Users\\kenle\\OneDrive\\Technical and GRC for "five" and "Code GRC".';
    const intent = parseDirectFileSearchIntent(text, policy);
    expect(intent).toEqual({
      path: 'C:\\Users\\kenle\\OneDrive\\Technical and GRC',
      query: 'five',
    });
  });

  it('uses the active workspace as a fallback path for repo-scoped searches', () => {
    const text = 'Search the workspace for answerValue and tell me where it is defined.';
    const intent = parseDirectFileSearchIntent(text, policy, {
      fallbackPath: 'S:\\Development\\GuardianAgent',
    });
    expect(intent).toEqual({
      path: 'S:\\Development\\GuardianAgent',
      query: 'answerValue',
    });
  });

  it('parses quoted repo searches that ask for routing-defining files', () => {
    const text = 'Search the repo for "ollama_cloud" and tell me which files define its routing.';
    const intent = parseDirectFileSearchIntent(text, policy, {
      fallbackPath: 'S:\\Development\\GuardianAgent',
    });
    expect(intent).toEqual({
      path: 'S:\\Development\\GuardianAgent',
      query: 'ollama_cloud',
    });
  });

  it('parses direct save requests for the last assistant output into a named file under a directory', () => {
    const text = 'Can you save that last output to a file called test5 in S:\\Development';
    const intent = parseDirectFilesystemSaveIntent(text);
    expect(intent).toEqual({
      path: 'S:\\Development\\test5',
      source: 'last_assistant_output',
    });
  });

  it('uses the fallback directory when the user names the output file but not the full path', () => {
    const text = 'Save the previous output as routing-review.txt';
    const intent = parseDirectFilesystemSaveIntent(text, {
      fallbackDirectory: 'S:\\Development\\GuardianAgent',
    });
    expect(intent).toEqual({
      path: 'S:\\Development\\GuardianAgent\\routing-review.txt',
      source: 'last_assistant_output',
    });
  });

  it('does not treat a generic "text file" descriptor as the filename for an assistant-output save', () => {
    const text = 'Can you save that information as a text file?';
    const reference = parseDirectFilesystemSaveReference(text);
    const intent = parseDirectFilesystemSaveIntent(text, {
      fallbackDirectory: 'S:\\Development\\GuardianAgent',
    });

    expect(reference).toEqual({
      source: 'last_assistant_output',
    });
    expect(intent).toBeNull();
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

  it('extracts search text from go-out-to-the-internet phrasing', () => {
    expect(parseWebSearchIntent(
      'Go out to the internet and find me random useful information from reputable websites. Give me the source links.',
    )).toBe('random useful information from reputable websites. Give me the source links.');
  });

  it('extracts multi-topic web search text after a conversational greeting', () => {
    expect(parseWebSearchIntent(
      'Hi, can you use web search information on Apollo 13 moon mission, the history of KFC, and the latest scientific breakthroughs and pull me back facts about each with links.',
    )).toBe('Apollo 13 moon mission, the history of KFC, and the latest scientific breakthroughs and pull me back facts about each with links.');
  });

  it('does not extract a query from vague random-website phrasing', () => {
    expect(parseWebSearchIntent(
      'Go out to the internet search on random websites and pull me back some information.',
    )).toBeNull();
  });

  it('does not treat unresolved conversation references as web-search queries', () => {
    expect(parseWebSearchIntent(
      'Search for the thing we talked about before and summarize it.',
    )).toBeNull();
    expect(parseWebSearchIntent(
      'Search for the thing we talked about before and give me the source links.',
    )).toBeNull();
  });
});
