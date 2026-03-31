import { describe, expect, it } from 'vitest';
import { CODE_SESSION_CORE_SYSTEM_PROMPT, composeCodeSessionSystemPrompt } from './code-session-core.js';

describe('code-session-core prompt', () => {
  it('returns the standalone coding-session prompt', () => {
    expect(composeCodeSessionSystemPrompt()).toBe(CODE_SESSION_CORE_SYSTEM_PROMPT);
  });

  it('does not inherit Guardian host identity text', () => {
    const prompt = composeCodeSessionSystemPrompt();
    expect(prompt).not.toContain('You are Guardian Agent');
    expect(prompt).not.toContain('Guardian global memory');
    expect(prompt).not.toContain('broader Guardian tools');
    expect(prompt).not.toContain("assistant's global memory");
    expect(prompt).not.toContain('host-application context');
  });

  it('treats ambiguous references as the attached workspace by default', () => {
    const prompt = composeCodeSessionSystemPrompt();
    expect(prompt).toContain('"this app"');
    expect(prompt).toContain('refer to the attached workspace');
  });

  it('tells coding-session agents to ground repo summaries in inspected workspace evidence', () => {
    const prompt = composeCodeSessionSystemPrompt();
    expect(prompt).toContain('what is this repo');
    expect(prompt).toContain('Do not infer from the folder name');
    expect(prompt).toContain('instead of making extra tool calls');
    expect(prompt).toContain('README.md, package.json');
    expect(prompt).toContain('outside the allowed paths');
    expect(prompt).toContain('ignore the stale workspace reference');
  });

  it('tells coding-session agents how to answer Guardian CLI command questions', () => {
    const prompt = composeCodeSessionSystemPrompt();
    expect(prompt).toContain('<cli-command-guide>');
    expect(prompt).toContain('answer from that guide instead of guessing');
    expect(prompt).toContain('Do not invent slash commands or hidden subcommands');
  });
});
