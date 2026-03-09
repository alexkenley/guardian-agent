import { describe, it, expect, vi } from 'vitest';
import { ShadowEvaluator, shouldEvaluate, isEnforcing } from './shadow.js';
import { createPolicyEngine } from './engine.js';
import type { PolicyInput, PolicyRule } from './types.js';

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
    match: { 'context.isReadOnly': true },
    decision: { kind: 'allow', reason: 'Read-only is safe' },
    ...overrides,
  };
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

// ── ShadowEvaluator ─────────────────────────────────────────────

describe('ShadowEvaluator', () => {
  it('reports no mismatch when decisions agree', () => {
    const engine = createPolicyEngine([makeRule()]);
    const logger = mockLogger();
    const shadow = new ShadowEvaluator({ engine, logger });

    const result = shadow.compare(makeInput(), 'allow');
    expect(result.mismatch).toBe(false);
    expect(result.legacyDecision).toBe('allow');
    expect(result.policyDecision).toBe('allow');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports mismatch when decisions disagree', () => {
    const engine = createPolicyEngine([makeRule({
      decision: { kind: 'deny', reason: 'Denied' },
    })]);
    const logger = mockLogger();
    const shadow = new ShadowEvaluator({ engine, logger });

    const result = shadow.compare(makeInput(), 'allow');
    expect(result.mismatch).toBe(true);
    expect(result.mismatchClass).toBe('policy_too_strict');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('classifies policy_too_permissive', () => {
    const engine = createPolicyEngine([makeRule({
      decision: { kind: 'allow', reason: 'Allowed' },
    })]);
    const logger = mockLogger();
    const shadow = new ShadowEvaluator({ engine, logger });

    const result = shadow.compare(makeInput(), 'deny');
    expect(result.mismatchClass).toBe('policy_too_permissive');
  });

  it('tracks stats correctly', () => {
    const engine = createPolicyEngine([makeRule()]);
    const logger = mockLogger();
    const shadow = new ShadowEvaluator({ engine, logger });

    shadow.compare(makeInput(), 'allow'); // match
    shadow.compare(makeInput(), 'deny');  // mismatch

    const stats = shadow.stats();
    expect(stats.totalComparisons).toBe(2);
    expect(stats.totalMismatches).toBe(1);
    expect(stats.matchRate).toBe(0.5);
  });

  it('throttles log after limit', () => {
    const engine = createPolicyEngine([makeRule({
      decision: { kind: 'deny', reason: 'Denied' },
    })]);
    const logger = mockLogger();
    const shadow = new ShadowEvaluator({ engine, logger, mismatchLogLimit: 3 });

    for (let i = 0; i < 10; i++) {
      shadow.compare(makeInput(), 'allow');
    }

    // 3 mismatch logs + 1 throttle warning = 4
    expect(logger.warn).toHaveBeenCalledTimes(4);
  });

  it('resets counters', () => {
    const engine = createPolicyEngine([makeRule()]);
    const logger = mockLogger();
    const shadow = new ShadowEvaluator({ engine, logger });

    shadow.compare(makeInput(), 'allow');
    shadow.reset();

    const stats = shadow.stats();
    expect(stats.totalComparisons).toBe(0);
    expect(stats.totalMismatches).toBe(0);
    expect(stats.matchRate).toBe(1);
  });

  it('includes resource summary', () => {
    const engine = createPolicyEngine([makeRule()]);
    const logger = mockLogger();
    const shadow = new ShadowEvaluator({ engine, logger });

    const result = shadow.compare(makeInput(), 'allow');
    expect(result.resourceSummary).toBe('filesystem:fs_read');
  });

  it('includes ruleId when a rule matches', () => {
    const engine = createPolicyEngine([makeRule({ id: 'my-rule' })]);
    const logger = mockLogger();
    const shadow = new ShadowEvaluator({ engine, logger });

    const result = shadow.compare(makeInput(), 'allow');
    expect(result.ruleId).toBe('my-rule');
  });

  it('handles engine error gracefully', () => {
    // Create engine with no rules (falls back to family default)
    const engine = createPolicyEngine([]);
    const logger = mockLogger();
    const shadow = new ShadowEvaluator({ engine, logger });

    // This should not throw even if engine has issues
    const result = shadow.compare(makeInput(), 'allow');
    expect(result.mismatch).toBe(false); // Family default for read-only is 'allow'
  });
});

// ── Mode helpers ─────────────────────────────────────────────────

describe('shouldEvaluate', () => {
  it('returns true for shadow mode', () => {
    expect(shouldEvaluate('shadow')).toBe(true);
  });

  it('returns true for enforce mode', () => {
    expect(shouldEvaluate('enforce')).toBe(true);
  });

  it('returns false for off mode', () => {
    expect(shouldEvaluate('off')).toBe(false);
  });
});

describe('isEnforcing', () => {
  it('returns true for enforce mode', () => {
    expect(isEnforcing('enforce')).toBe(true);
  });

  it('returns false for shadow mode', () => {
    expect(isEnforcing('shadow')).toBe(false);
  });

  it('returns false for off mode', () => {
    expect(isEnforcing('off')).toBe(false);
  });
});
