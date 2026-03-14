import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillRegistry } from './registry.js';
import { SkillResolver } from './resolver.js';

const testDirs: string[] = [];

function createSkillRoot(): string {
  const root = join(tmpdir(), `guardianagent-skills-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  testDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SkillResolver', () => {
  it('loads local skills and resolves keyword matches', async () => {
    const root = createSkillRoot();
    const skillDir = join(root, 'security-triage');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'skill.json'), JSON.stringify({
      id: 'security-triage',
      name: 'Security Triage',
      version: '0.1.0',
      description: 'Triage incidents',
      triggers: { keywords: ['incident', 'triage'] },
    }), 'utf-8');
    writeFileSync(join(skillDir, 'SKILL.md'), '# Security Triage\n\nSummarize the incident first.', 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry);
    const resolved = resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Please triage this incident for me.',
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('security-triage');
    expect(resolved[0].summary).toContain('Summarize the incident first.');
  });

  it('requires managed providers when a skill declares one', async () => {
    const root = createSkillRoot();
    const skillDir = join(root, 'google-gmail');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'skill.json'), JSON.stringify({
      id: 'google-gmail',
      name: 'Google Gmail',
      version: '0.1.0',
      description: 'Gmail help',
      triggers: { keywords: ['gmail'] },
      requiredManagedProvider: 'gws',
    }), 'utf-8');
    writeFileSync(join(skillDir, 'SKILL.md'), '# Google Gmail\n\nUse gws tools.', 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry);

    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Check my gmail drafts.',
    })).toHaveLength(0);

    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Check my gmail drafts.',
      enabledManagedProviders: new Set(['gws']),
    })).toHaveLength(1);
  });

  it('can disable and re-enable loaded skills at runtime', async () => {
    const root = createSkillRoot();
    const skillDir = join(root, 'security-triage');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'skill.json'), JSON.stringify({
      id: 'security-triage',
      name: 'Security Triage',
      version: '0.1.0',
      description: 'Triage incidents',
      triggers: { keywords: ['incident'] },
    }), 'utf-8');
    writeFileSync(join(skillDir, 'SKILL.md'), '# Security Triage\n\nSummarize the incident first.', 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry);

    expect(registry.listStatus()).toMatchObject([
      { id: 'security-triage', enabled: true },
    ]);
    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Investigate this incident.',
    })).toHaveLength(1);

    expect(registry.disable('security-triage')).toBe(true);
    expect(registry.listStatus()).toMatchObject([
      { id: 'security-triage', enabled: false },
    ]);
    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Investigate this incident.',
    })).toHaveLength(0);

    expect(registry.enable('security-triage')).toBe(true);
    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Investigate this incident.',
    })).toHaveLength(1);
  });

  it('loads Anthropic-style frontmatter skills and strips metadata from summaries', async () => {
    const root = createSkillRoot();
    const skillDir = join(root, 'mcp-builder');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: mcp-builder
description: Guide for building MCP servers and designing Model Context Protocol tools for external APIs.
---

# MCP Builder

Start with the API surface, design clear tool names, and prefer structured outputs.
`, 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const status = registry.listStatus();

    expect(status).toMatchObject([
      {
        id: 'mcp-builder',
        name: 'MCP Builder',
        version: '0.0.0-compat',
        description: 'Guide for building MCP servers and designing Model Context Protocol tools for external APIs.',
      },
    ]);
    expect(registry.get('mcp-builder')?.summary).not.toContain('description:');
  });

  it('resolves frontmatter-only skills from explicit name mentions and description fallback', async () => {
    const root = createSkillRoot();
    const skillDir = join(root, 'skill-creator');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: skill-creator
description: Create new skills, improve existing skills, and benchmark skill performance with evals.
---

# Skill Creator

Capture intent first, then draft the skill, write eval prompts, and iterate.
`, 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry);

    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Use the skill-creator to help me benchmark this workflow.',
    })[0]?.id).toBe('skill-creator');

    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'I want to improve an existing skill and add evals to benchmark it.',
    })[0]?.id).toBe('skill-creator');
  });

  it('rejects frontmatter skills that omit required metadata', async () => {
    const root = createSkillRoot();
    const skillDir = join(root, 'broken-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: broken-skill
---

# Broken Skill

This should not load.
`, 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);

    expect(registry.list()).toHaveLength(0);
  });
});
