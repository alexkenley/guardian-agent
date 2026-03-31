import { describe, expect, it } from 'vitest';
import {
  CLI_HELP_TOPICS,
  findCliHelpTopic,
  formatCliCommandGuideForPrompt,
} from './cli-command-guide.js';

describe('cli-command-guide', () => {
  it('finds help topics by alias with or without a leading slash', () => {
    expect(findCliHelpTopic('code')?.title).toBe('/code');
    expect(findCliHelpTopic('/mode')?.title).toBe('/mode');
    expect(findCliHelpTopic('codingbackends')?.title).toBe('/coding-backends');
  });

  it('formats a prompt-safe command guide from the shared help topics', () => {
    const guide = formatCliCommandGuideForPrompt();
    expect(guide).toContain('Do not invent commands or subcommands');
    expect(guide).toContain('/help');
    expect(guide).toContain('/guide');
    expect(guide).toContain('/code');
    expect(guide).toContain('/tools');
    expect(guide).toContain('/coding-backends');
    expect(guide.split('\n').length).toBeGreaterThan(CLI_HELP_TOPICS.length);
  });
});
