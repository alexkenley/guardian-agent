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
    expect(resolved[0].description).toBe('Triage incidents');
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

  it('requires agent capabilities when a skill declares them', async () => {
    const root = createSkillRoot();
    const skillDir = join(root, 'weather');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'skill.json'), JSON.stringify({
      id: 'weather',
      name: 'Weather',
      version: '0.1.0',
      description: 'Fetch weather data',
      triggers: { keywords: ['weather'] },
      requiredCapabilities: ['network_access'],
    }), 'utf-8');
    writeFileSync(join(skillDir, 'SKILL.md'), '# Weather\n\nUse weather APIs.', 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry);

    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Check the weather in Brisbane.',
    })).toHaveLength(0);

    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Check the weather in Brisbane.',
      availableCapabilities: new Set(['network_access']),
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

  it('loads manifest-disabled skills as inactive so they can be reviewed and enabled later', async () => {
    const root = createSkillRoot();
    const skillDir = join(root, 'github');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'skill.json'), JSON.stringify({
      id: 'github',
      name: 'GitHub',
      version: '0.1.0',
      description: 'Operational guidance for GitHub workflows.',
      enabled: false,
      triggers: { keywords: ['github'] },
    }), 'utf-8');
    writeFileSync(join(skillDir, 'SKILL.md'), '# GitHub\n\nUse reviewed GitHub workflows only after enablement.', 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry);

    expect(registry.listStatus()).toMatchObject([
      { id: 'github', enabled: false },
    ]);
    expect(registry.get('github')).toBeTruthy();
    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Review this GitHub pull request.',
    })).toHaveLength(0);

    expect(registry.enable('github')).toBe(true);
    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Review this GitHub pull request.',
    })).toHaveLength(1);
  });

  it('prefers native skill.json metadata when SKILL.md uses compatibility frontmatter', async () => {
    const root = createSkillRoot();
    const skillDir = join(root, 'coding-workspace');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'skill.json'), JSON.stringify({
      id: 'coding-workspace',
      name: 'Coding Workspace',
      version: '0.2.0',
      description: 'Workflow guidance for backend-owned coding sessions.',
      triggers: { keywords: ['coding', 'patch', 'repo', 'analyze'] },
      tools: ['code_patch'],
      risk: 'operational',
    }), 'utf-8');
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: coding-workspace
description: Compatibility frontmatter for editor tooling.
---

# Coding Workspace

Attach first, inspect the relevant files, then make the smallest safe change.
`, 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry);
    const status = registry.listStatus();

    expect(status).toMatchObject([
      {
        id: 'coding-workspace',
        name: 'Coding Workspace',
        description: 'Workflow guidance for backend-owned coding sessions.',
        tools: ['code_patch'],
        risk: 'operational',
      },
    ]);

    const resolved = resolver.resolve({
      agentId: 'default',
      channel: 'web',
      requestType: 'chat',
      content: 'Please patch this coding issue.',
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('coding-workspace');
    expect(resolved[0].summary).toContain('Attach first, inspect the relevant files');
    expect(resolved[0].summary).not.toContain('Compatibility frontmatter');

    const repoResolved = resolver.resolve({
      agentId: 'default',
      channel: 'web',
      requestType: 'chat',
      content: 'Analyze this repo and explain what the app does.',
    });

    expect(repoResolved).toHaveLength(1);
    expect(repoResolved[0].id).toBe('coding-workspace');
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

  it('routes bundled defensive-security requests to the most specific first-party skills', async () => {
    const registry = new SkillRegistry();
    await registry.loadFromRoots([join(process.cwd(), 'skills')]);
    const resolver = new SkillResolver(registry);

    const resolveTop = (content: string): string | undefined => resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content,
    })[0]?.id;

    expect(registry.get('host-firewall-defense')).toBeTruthy();
    expect(registry.get('native-av-management')).toBeTruthy();
    expect(registry.get('security-mode-escalation')).toBeTruthy();
    expect(registry.get('security-alert-hygiene')).toBeTruthy();
    expect(registry.get('security-response-automation')).toBeTruthy();
    expect(registry.get('browser-session-defense')).toBeTruthy();

    expect(resolveTop('Check Windows Defender status, Controlled Folder Access, and Malwarebytes coexistence.'))
      .toBe('native-av-management');
    expect(resolveTop('Explain these sensitive path change and new external destination host alerts.'))
      .toBe('host-firewall-defense');
    expect(resolveTop('Should we stay in monitor mode or escalate to guarded or lockdown based on containment state?'))
      .toBe('security-mode-escalation');
    expect(resolveTop('Suppress this noisy alert as a false positive and add a reason.'))
      .toBe('security-alert-hygiene');
    expect(resolveTop('Create an event-triggered security response automation that runs on alert and performs containment review.'))
      .toBe('security-response-automation');
    expect(resolveTop('Explain the browser storage state, upload approval, and brokered session boundary for Guardian-managed browsing.'))
      .toBe('browser-session-defense');
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

  it('uses explicit skill mentions even when keyword triggers are present', async () => {
    const root = createSkillRoot();

    const broadDir = join(root, 'automation-builder');
    mkdirSync(broadDir, { recursive: true });
    writeFileSync(join(broadDir, 'skill.json'), JSON.stringify({
      id: 'automation-builder',
      name: 'Automation Builder',
      version: '0.1.0',
      description: 'Use when creating or updating recurring workflows.',
      triggers: { keywords: ['workflow'] },
    }), 'utf-8');
    writeFileSync(join(broadDir, 'SKILL.md'), '# Automation Builder\n\nCreate automations.', 'utf-8');

    const namedDir = join(root, 'skill-creator');
    mkdirSync(namedDir, { recursive: true });
    writeFileSync(join(namedDir, 'skill.json'), JSON.stringify({
      id: 'skill-creator',
      name: 'Skill Creator',
      version: '0.1.0',
      description: 'Use when turning a workflow into a skill.',
      triggers: { keywords: ['workflow'] },
    }), 'utf-8');
    writeFileSync(join(namedDir, 'SKILL.md'), '# Skill Creator\n\nWrite skills.', 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry, { maxActivePerRequest: 2 });
    const resolved = resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Use skill-creator to turn this workflow into a reusable skill.',
    });

    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.id).toBe('skill-creator');
  });

  it('uses descriptions as a trigger signal even when keywords overlap', async () => {
    const root = createSkillRoot();

    const dashboardDir = join(root, 'dashboard-helper');
    mkdirSync(dashboardDir, { recursive: true });
    writeFileSync(join(dashboardDir, 'skill.json'), JSON.stringify({
      id: 'dashboard-helper',
      name: 'Dashboard Helper',
      version: '0.1.0',
      description: 'Use when reviewing dashboards, charts, and visual analytics.',
      triggers: { keywords: ['review'] },
    }), 'utf-8');
    writeFileSync(join(dashboardDir, 'SKILL.md'), '# Dashboard Helper\n\nInspect dashboards.', 'utf-8');

    const reviewDir = join(root, 'code-review');
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(join(reviewDir, 'skill.json'), JSON.stringify({
      id: 'code-review',
      name: 'Code Review',
      version: '0.1.0',
      description: 'Use when reviewing a diff, PR, or patch for regressions, missing tests, and operational risk.',
      triggers: { keywords: ['review'] },
    }), 'utf-8');
    writeFileSync(join(reviewDir, 'SKILL.md'), '# Code Review\n\nReview code changes.', 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry, { maxActivePerRequest: 2 });
    const resolved = resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Review this patch for regressions and missing tests before merge.',
    });

    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.id).toBe('code-review');
  });

  it('matches trigger keywords on normalized phrase boundaries instead of raw substrings', async () => {
    const root = createSkillRoot();
    const skillDir = join(root, 'systematic-debugging');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'skill.json'), JSON.stringify({
      id: 'systematic-debugging',
      name: 'Systematic Debugging',
      version: '0.1.0',
      description: 'Use when debugging a bug.',
      triggers: { keywords: ['bug'] },
    }), 'utf-8');
    writeFileSync(join(skillDir, 'SKILL.md'), '# Systematic Debugging\n\nInvestigate first.', 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry);

    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Please debug this integration.',
    })).toHaveLength(0);

    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Please fix this bug.',
    })[0]?.id).toBe('systematic-debugging');
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

  it('ignores empty directories in a skills root', async () => {
    const root = createSkillRoot();
    mkdirSync(join(root, 'empty-dir'), { recursive: true });

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);

    expect(registry.list()).toHaveLength(0);
  });

  it('prefers process skills first when scores are otherwise equal', async () => {
    const root = createSkillRoot();

    const processDir = join(root, 'systematic-debugging');
    mkdirSync(processDir, { recursive: true });
    writeFileSync(join(processDir, 'skill.json'), JSON.stringify({
      id: 'systematic-debugging',
      name: 'Systematic Debugging',
      version: '0.1.0',
      description: 'Debug bugs methodically',
      role: 'process',
      triggers: { keywords: ['bug'] },
    }), 'utf-8');
    writeFileSync(join(processDir, 'SKILL.md'), '# Systematic Debugging\n\nFind root cause before fixing.', 'utf-8');

    const domainDir = join(root, 'webapp-testing');
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(join(domainDir, 'skill.json'), JSON.stringify({
      id: 'webapp-testing',
      name: 'Webapp Testing',
      version: '0.1.0',
      description: 'Test browser flows',
      role: 'domain',
      triggers: { keywords: ['bug'] },
    }), 'utf-8');
    writeFileSync(join(domainDir, 'SKILL.md'), '# Webapp Testing\n\nTest the broken flow.', 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry, { maxActivePerRequest: 2 });
    const resolved = resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Please fix this bug.',
    });

    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.id).toBe('systematic-debugging');
    expect(resolved[0]?.role).toBe('process');
    expect(resolved[1]?.id).toBe('webapp-testing');
    expect(resolved[1]?.role).toBe('domain');
  });

  it('prefers first-party skills over reviewed imports when scores are otherwise equal', async () => {
    const root = createSkillRoot();

    const firstPartyDir = join(root, 'first-party-observability');
    mkdirSync(firstPartyDir, { recursive: true });
    writeFileSync(join(firstPartyDir, 'skill.json'), JSON.stringify({
      id: 'first-party-observability',
      name: 'First Party Observability',
      version: '0.1.0',
      description: 'Use when investigating observability dashboards and Prometheus metrics.',
      triggers: { keywords: ['prometheus', 'grafana'] },
    }), 'utf-8');
    writeFileSync(join(firstPartyDir, 'SKILL.md'), '# First Party Observability\n\nUse the native monitoring workflow.', 'utf-8');

    const reviewedDir = join(root, 'monitoring-expert');
    mkdirSync(reviewedDir, { recursive: true });
    writeFileSync(join(reviewedDir, 'skill.json'), JSON.stringify({
      id: 'monitoring-expert',
      name: 'Monitoring Expert',
      version: '0.1.0',
      description: 'Use only for explicit observability work such as Prometheus and Grafana analysis.',
      triggers: { keywords: ['prometheus', 'grafana'] },
      _upstream: { source: 'clawhub' },
    }), 'utf-8');
    writeFileSync(join(reviewedDir, 'SKILL.md'), '# Monitoring Expert\n\nUse the reviewed import.', 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry, { maxActivePerRequest: 2 });
    const resolved = resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Compare the Prometheus metrics and Grafana dashboard for this incident.',
    });

    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.id).toBe('first-party-observability');
    expect(resolved[1]?.id).toBe('monitoring-expert');
  });

  it('suppresses low-confidence reviewed-import matches without an explicit mention', async () => {
    const root = createSkillRoot();
    const reviewedDir = join(root, 'monitoring-expert');
    mkdirSync(reviewedDir, { recursive: true });
    writeFileSync(join(reviewedDir, 'skill.json'), JSON.stringify({
      id: 'monitoring-expert',
      name: 'Monitoring Expert',
      version: '0.1.0',
      description: 'Use only for explicit observability work such as Prometheus and Grafana analysis.',
      triggers: { keywords: ['grafana'] },
      _upstream: { source: 'clawhub' },
    }), 'utf-8');
    writeFileSync(join(reviewedDir, 'SKILL.md'), '# Monitoring Expert\n\nInvestigate dashboards.', 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry);

    expect(resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'This setup has a Grafana panel I do not trust.',
    })).toHaveLength(0);
  });

  it('still resolves reviewed imports from explicit mentions', async () => {
    const root = createSkillRoot();

    const firstPartyDir = join(root, 'web-research');
    mkdirSync(firstPartyDir, { recursive: true });
    writeFileSync(join(firstPartyDir, 'skill.json'), JSON.stringify({
      id: 'web-research',
      name: 'Web Research',
      version: '0.1.0',
      description: 'Use for general web research.',
      triggers: { keywords: ['weather'] },
    }), 'utf-8');
    writeFileSync(join(firstPartyDir, 'SKILL.md'), '# Web Research\n\nResearch on the web.', 'utf-8');

    const reviewedDir = join(root, 'weather');
    mkdirSync(reviewedDir, { recursive: true });
    writeFileSync(join(reviewedDir, 'skill.json'), JSON.stringify({
      id: 'weather',
      name: 'Weather',
      version: '0.1.0',
      description: 'Use only for explicit weather or forecast requests.',
      triggers: { keywords: ['weather', 'forecast'] },
      _upstream: { source: 'clawhub' },
    }), 'utf-8');
    writeFileSync(join(reviewedDir, 'SKILL.md'), '# Weather\n\nFetch weather.', 'utf-8');

    const registry = new SkillRegistry();
    await registry.loadFromRoots([root]);
    const resolver = new SkillResolver(registry, { maxActivePerRequest: 2 });
    const resolved = resolver.resolve({
      agentId: 'default',
      channel: 'cli',
      requestType: 'chat',
      content: 'Use the Weather skill to fetch today\'s forecast for Brisbane.',
    });

    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.id).toBe('weather');
  });
});
