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

  it('adds response-style guidance when enabled', () => {
    const prompt = composeCodeSessionSystemPrompt({ enabled: true, level: 'light' });
    expect(prompt).toContain('Configured response-style preference:');
    expect(prompt).toContain('Keep replies a bit tighter and clearer than default.');
  });

  it('omits response-style guidance when disabled', () => {
    const prompt = composeCodeSessionSystemPrompt({ enabled: false, level: 'strong' });
    expect(prompt).not.toContain('Configured response-style preference:');
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

  it('tells coding-session agents how to answer Guardian product-usage questions', () => {
    const prompt = composeCodeSessionSystemPrompt();
    expect(prompt).toContain('<reference-guide>');
    expect(prompt).toContain('navigate the app, or understand product capabilities');
    expect(prompt).toContain('Do not treat it as implementation or architecture documentation');
  });
});
