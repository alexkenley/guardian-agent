import { describe, expect, it } from 'vitest';
import { formatAvailableSkillsPrompt } from './prompt.js';

describe('formatAvailableSkillsPrompt', () => {
  it('renders an OpenCLAW-style skill catalog with locations', () => {
    const prompt = formatAvailableSkillsPrompt([
      {
        id: 'google-workspace',
        name: 'Google Workspace',
        description: 'Use Google Workspace tools for Gmail, Calendar, Drive, Docs, and Sheets.',
        role: 'domain',
        summary: 'unused in prompt',
        sourcePath: '/app/skills/google-workspace/SKILL.md',
        score: 9,
      },
    ]);

    expect(prompt).toContain('## Skills (mandatory)');
    expect(prompt).toContain('<available_skills>');
    expect(prompt).toContain('<name>Google Workspace</name>');
    expect(prompt).toContain('<description>Use Google Workspace tools for Gmail, Calendar, Drive, Docs, and Sheets.</description>');
    expect(prompt).toContain('<role>domain</role>');
    expect(prompt).toContain('<location>/app/skills/google-workspace/SKILL.md</location>');
    expect(prompt).toContain('Before any reply, clarifying question, or tool call');
    expect(prompt).toContain('read its SKILL.md');
    expect(prompt).toContain('Read at most two SKILL.md files up front');
  });

  it('returns an empty string when there are no resolved skills', () => {
    expect(formatAvailableSkillsPrompt([])).toBe('');
  });
});
