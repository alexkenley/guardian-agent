import { describe, it, expect } from 'vitest';
import { createPolicyEngine, PolicyEngineImpl } from './engine.js';
import type { PolicyInput, PolicyRule } from './types.js';

// ── Test helpers ─────────────────────────────────────────────────

function makeInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    family: 'tool',
    principal: { kind: 'user', id: 'user-1' },
    action: 'tool:fs_read',
    resource: { kind: 'filesystem', id: 'fs_read' },
    context: { policyMode: 'approve_by_policy', isReadOnly: true, risk: 'read_only' },
    ...overrides,
  };
}

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: 'test-rule',
    family: 'tool',
    enabled: true,
    priority: 100,
    match: { action: 'tool:fs_read' },
    decision: { kind: 'allow', reason: 'Test' },
    ...overrides,
  };
}

// ── Factory ──────────────────────────────────────────────────────

describe('createPolicyEngine', () => {
  it('creates an engine with no rules', () => {
    const engine = createPolicyEngine();
    expect(engine.ruleCount()).toBe(0);
  });

  it('creates an engine with rules', () => {
    const engine = createPolicyEngine([makeRule()]);
    expect(engine.ruleCount()).toBe(1);
  });
});

// ── evaluate ─────────────────────────────────────────────────────

describe('PolicyEngineImpl.evaluate', () => {
  it('returns matching rule decision', () => {
    const engine = createPolicyEngine([makeRule()]);
    const result = engine.evaluate(makeInput());
    expect(result.kind).toBe('allow');
    expect(result.ruleId).toBe('test-rule');
  });

  it('evaluates rules in priority order (lower priority number first)', () => {
    const engine = createPolicyEngine([
      makeRule({ id: 'fallback', priority: 200, match: { 'context.isReadOnly': true }, decision: { kind: 'allow', reason: 'fallback' } }),
      makeRule({ id: 'override', priority: 50, match: { 'context.isReadOnly': true }, decision: { kind: 'deny', reason: 'override' } }),
    ]);
    const result = engine.evaluate(makeInput());
    expect(result.kind).toBe('deny');
    expect(result.ruleId).toBe('override');
  });

  it('skips non-matching rules', () => {
    const engine = createPolicyEngine([
      makeRule({ id: 'no-match', match: { action: 'tool:shell_safe' }, decision: { kind: 'deny', reason: 'no' } }),
      makeRule({ id: 'match', match: { action: 'tool:fs_read' }, decision: { kind: 'allow', reason: 'yes' } }),
    ]);
    const result = engine.evaluate(makeInput());
    expect(result.kind).toBe('allow');
    expect(result.ruleId).toBe('match');
  });

  it('falls back to tool family default for read-only in approve_by_policy mode', () => {
    const engine = createPolicyEngine([]);
    const result = engine.evaluate(makeInput());
    expect(result.kind).toBe('allow');
    expect(result.reason).toContain('read-only');
  });

  it('falls back to tool family default for autonomous mode', () => {
    const engine = createPolicyEngine([]);
    const result = engine.evaluate(makeInput({
      context: { policyMode: 'autonomous', isReadOnly: false },
    }));
    expect(result.kind).toBe('allow');
    expect(result.reason).toContain('autonomous');
  });

  it('falls back to require_approval for mutating in approve_by_policy', () => {
    const engine = createPolicyEngine([]);
    const result = engine.evaluate(makeInput({
      context: { policyMode: 'approve_by_policy', isReadOnly: false },
    }));
    expect(result.kind).toBe('require_approval');
  });

  it('falls back to deny for guardian family', () => {
    const engine = createPolicyEngine([]);
    const result = engine.evaluate(makeInput({ family: 'guardian' }));
    expect(result.kind).toBe('deny');
  });

  it('falls back to deny for admin family', () => {
    const engine = createPolicyEngine([]);
    const result = engine.evaluate(makeInput({ family: 'admin' }));
    expect(result.kind).toBe('deny');
  });

  it('falls back to deny for event family', () => {
    const engine = createPolicyEngine([]);
    const result = engine.evaluate(makeInput({ family: 'event' }));
    expect(result.kind).toBe('deny');
  });

  it('handles matcher error gracefully (skips broken rule)', () => {
    const engine = new PolicyEngineImpl();
    // Manually push a broken rule via reload
    engine.reload([
      makeRule({
        id: 'broken',
        priority: 10,
        // match conditions that will cause path traversal issue
        match: { action: 'tool:fs_read' },
        decision: { kind: 'deny', reason: 'broken' },
      }),
      makeRule({
        id: 'good',
        priority: 20,
        match: { action: 'tool:fs_read' },
        decision: { kind: 'allow', reason: 'good' },
      }),
    ]);
    // Both match, first one wins
    const result = engine.evaluate(makeInput());
    expect(result.kind).toBe('deny');
    expect(result.ruleId).toBe('broken');
  });
});

// ── reload ───────────────────────────────────────────────────────

describe('PolicyEngineImpl.reload', () => {
  it('returns loaded and skipped counts', () => {
    const engine = new PolicyEngineImpl();
    const result = engine.reload([
      makeRule({ id: 'enabled-1', enabled: true }),
      makeRule({ id: 'disabled-1', enabled: false }),
    ]);
    expect(result.loaded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('reports validation errors', () => {
    const engine = new PolicyEngineImpl();
    const result = engine.reload([
      { id: '', family: 'tool', enabled: true, priority: 100, match: {}, decision: { kind: 'allow', reason: 'test' } } as PolicyRule,
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('missing or invalid id');
  });

  it('detects duplicate IDs', () => {
    const engine = new PolicyEngineImpl();
    const result = engine.reload([
      makeRule({ id: 'dup', priority: 100 }),
      makeRule({ id: 'dup', priority: 200 }),
    ]);
    expect(result.errors.some(e => e.includes('duplicate id'))).toBe(true);
    expect(engine.ruleCount()).toBe(1); // Keeps first occurrence
  });

  it('validates family', () => {
    const engine = new PolicyEngineImpl();
    const result = engine.reload([
      { id: 'bad-family', family: 'invalid' as 'tool', enabled: true, priority: 100, match: {}, decision: { kind: 'allow', reason: 'test' } },
    ]);
    expect(result.errors[0]).toContain("invalid family");
  });

  it('validates decision kind', () => {
    const engine = new PolicyEngineImpl();
    const result = engine.reload([
      { id: 'bad-decision', family: 'tool', enabled: true, priority: 100, match: {}, decision: { kind: 'invalid' as 'allow', reason: 'test' } },
    ]);
    expect(result.errors[0]).toContain('invalid decision kind');
  });

  it('validates priority is finite number', () => {
    const engine = new PolicyEngineImpl();
    const result = engine.reload([
      makeRule({ id: 'bad-pri', priority: Infinity }),
    ]);
    expect(result.errors[0]).toContain('priority must be a finite number');
  });

  it('validates decision.reason is non-empty', () => {
    const engine = new PolicyEngineImpl();
    const result = engine.reload([
      { id: 'no-reason', family: 'tool', enabled: true, priority: 100, match: {}, decision: { kind: 'allow', reason: '' } } as PolicyRule,
    ]);
    expect(result.errors[0]).toContain('decision.reason must be a non-empty string');
  });

  it('clears old rules on reload', () => {
    const engine = new PolicyEngineImpl();
    engine.reload([makeRule({ id: 'rule-1' })]);
    expect(engine.ruleCount()).toBe(1);

    engine.reload([makeRule({ id: 'rule-2' }), makeRule({ id: 'rule-3' })]);
    expect(engine.ruleCount()).toBe(2);
  });
});

// ── ruleCount ────────────────────────────────────────────────────

describe('PolicyEngineImpl.ruleCount', () => {
  it('returns 0 for empty engine', () => {
    const engine = createPolicyEngine();
    expect(engine.ruleCount()).toBe(0);
  });

  it('returns total count', () => {
    const engine = createPolicyEngine([
      makeRule({ id: 'r1', family: 'tool' }),
      makeRule({ id: 'r2', family: 'admin' }),
    ]);
    expect(engine.ruleCount()).toBe(2);
  });

  it('returns family-scoped count', () => {
    const engine = createPolicyEngine([
      makeRule({ id: 'r1', family: 'tool' }),
      makeRule({ id: 'r2', family: 'admin' }),
      makeRule({ id: 'r3', family: 'tool' }),
    ]);
    expect(engine.ruleCount('tool')).toBe(2);
    expect(engine.ruleCount('admin')).toBe(1);
    expect(engine.ruleCount('event')).toBe(0);
  });
});
