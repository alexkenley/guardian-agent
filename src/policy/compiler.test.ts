import { describe, it, expect } from 'vitest';
import { compileRule, compileRules } from './compiler.js';
import type { PolicyRule, PolicyInput } from './types.js';

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: 'test-rule',
    family: 'tool',
    enabled: true,
    priority: 100,
    match: { action: 'tool:fs_read' },
    decision: { kind: 'allow', reason: 'Test rule' },
    ...overrides,
  };
}

function makeInput(action = 'tool:fs_read'): PolicyInput {
  return {
    family: 'tool',
    principal: { kind: 'user', id: 'user-1' },
    action,
    resource: { kind: 'filesystem', id: 'fs_read' },
    context: {},
  };
}

describe('compileRule', () => {
  it('creates a compiled rule with correct id and family', () => {
    const compiled = compileRule(makeRule());
    expect(compiled.id).toBe('test-rule');
    expect(compiled.family).toBe('tool');
    expect(compiled.priority).toBe(100);
  });

  it('attaches decision with ruleId', () => {
    const compiled = compileRule(makeRule());
    expect(compiled.decision.kind).toBe('allow');
    expect(compiled.decision.ruleId).toBe('test-rule');
    expect(compiled.decision.reason).toBe('Test rule');
  });

  it('matcher returns true for matching input', () => {
    const compiled = compileRule(makeRule());
    expect(compiled.matcher(makeInput('tool:fs_read'))).toBe(true);
  });

  it('matcher returns false for non-matching input', () => {
    const compiled = compileRule(makeRule());
    expect(compiled.matcher(makeInput('tool:fs_write'))).toBe(false);
  });

  it('preserves obligations', () => {
    const compiled = compileRule(makeRule({
      decision: { kind: 'allow', reason: 'test', obligations: ['log_command'] },
    }));
    expect(compiled.decision.obligations).toEqual(['log_command']);
  });
});

describe('compileRules', () => {
  it('filters disabled rules', () => {
    const rules = [
      makeRule({ id: 'enabled', enabled: true }),
      makeRule({ id: 'disabled', enabled: false }),
    ];
    const compiled = compileRules(rules);
    expect(compiled).toHaveLength(1);
    expect(compiled[0].id).toBe('enabled');
  });

  it('filters by family', () => {
    const rules = [
      makeRule({ id: 'tool-rule', family: 'tool' }),
      makeRule({ id: 'admin-rule', family: 'admin' }),
    ];
    const compiled = compileRules(rules, 'tool');
    expect(compiled).toHaveLength(1);
    expect(compiled[0].id).toBe('tool-rule');
  });

  it('sorts by priority (lower first)', () => {
    const rules = [
      makeRule({ id: 'low-pri', priority: 200 }),
      makeRule({ id: 'high-pri', priority: 50 }),
      makeRule({ id: 'mid-pri', priority: 100 }),
    ];
    const compiled = compileRules(rules);
    expect(compiled.map(r => r.id)).toEqual(['high-pri', 'mid-pri', 'low-pri']);
  });

  it('sorts by decision severity at same priority (deny > require_approval > allow)', () => {
    const rules = [
      makeRule({ id: 'allow', priority: 100, decision: { kind: 'allow', reason: 'a' } }),
      makeRule({ id: 'deny', priority: 100, decision: { kind: 'deny', reason: 'd' } }),
      makeRule({ id: 'approve', priority: 100, decision: { kind: 'require_approval', reason: 'r' } }),
    ];
    const compiled = compileRules(rules);
    expect(compiled.map(r => r.id)).toEqual(['deny', 'approve', 'allow']);
  });

  it('returns empty array for no enabled rules', () => {
    const rules = [makeRule({ enabled: false })];
    expect(compileRules(rules)).toHaveLength(0);
  });
});
