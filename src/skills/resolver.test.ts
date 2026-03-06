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
});
