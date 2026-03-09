import { describe, it, expect } from 'vitest';
import { resolvePath, matchPrimitive, matchConditions } from './matcher.js';
import type { PolicyInput, MatchPrimitive } from './types.js';

// ── Test helpers ─────────────────────────────────────────────────

function makeInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    family: 'tool',
    principal: { kind: 'user', id: 'user-1', channel: 'web' },
    action: 'tool:fs_read',
    resource: { kind: 'filesystem', id: 'fs_read', attrs: { path: '/tmp/test.txt' } },
    context: { policyMode: 'approve_by_policy', isReadOnly: true, risk: 'read_only' },
    ...overrides,
  };
}

// ── resolvePath ──────────────────────────────────────────────────

describe('resolvePath', () => {
  const input = makeInput();

  it('resolves action', () => {
    expect(resolvePath(input, 'action')).toBe('tool:fs_read');
  });

  it('resolves family', () => {
    expect(resolvePath(input, 'family')).toBe('tool');
  });

  it('resolves principal.kind', () => {
    expect(resolvePath(input, 'principal.kind')).toBe('user');
  });

  it('resolves principal.id', () => {
    expect(resolvePath(input, 'principal.id')).toBe('user-1');
  });

  it('resolves principal.channel', () => {
    expect(resolvePath(input, 'principal.channel')).toBe('web');
  });

  it('resolves resource.kind', () => {
    expect(resolvePath(input, 'resource.kind')).toBe('filesystem');
  });

  it('resolves resource.id', () => {
    expect(resolvePath(input, 'resource.id')).toBe('fs_read');
  });

  it('resolves resource.attrs.path', () => {
    expect(resolvePath(input, 'resource.attrs.path')).toBe('/tmp/test.txt');
  });

  it('resolves context.policyMode', () => {
    expect(resolvePath(input, 'context.policyMode')).toBe('approve_by_policy');
  });

  it('resolves context.isReadOnly', () => {
    expect(resolvePath(input, 'context.isReadOnly')).toBe(true);
  });

  it('returns undefined for unknown root', () => {
    expect(resolvePath(input, 'unknown.field')).toBeUndefined();
  });

  it('returns undefined for missing nested field', () => {
    expect(resolvePath(input, 'context.nonexistent')).toBeUndefined();
  });

  it('returns undefined for deep missing path', () => {
    expect(resolvePath(input, 'resource.attrs.deep.missing')).toBeUndefined();
  });
});

// ── matchPrimitive ───────────────────────────────────────────────

describe('matchPrimitive', () => {
  it('matches exact string', () => {
    expect(matchPrimitive('hello', 'hello')).toBe(true);
    expect(matchPrimitive('hello', 'world')).toBe(false);
  });

  it('matches exact number', () => {
    expect(matchPrimitive(42, 42)).toBe(true);
    expect(matchPrimitive(42, 43)).toBe(false);
  });

  it('matches exact boolean', () => {
    expect(matchPrimitive(true, true)).toBe(true);
    expect(matchPrimitive(true, false)).toBe(false);
  });

  it('returns false for null/undefined expected', () => {
    expect(matchPrimitive('a', null as unknown as MatchPrimitive)).toBe(false);
    expect(matchPrimitive('a', undefined as unknown as MatchPrimitive)).toBe(false);
  });

  it('matches { in: [...] }', () => {
    expect(matchPrimitive('cat', { in: ['cat', 'dog'] })).toBe(true);
    expect(matchPrimitive('fish', { in: ['cat', 'dog'] })).toBe(false);
  });

  it('matches { notIn: [...] }', () => {
    expect(matchPrimitive('fish', { notIn: ['cat', 'dog'] })).toBe(true);
    expect(matchPrimitive('cat', { notIn: ['cat', 'dog'] })).toBe(false);
  });

  it('matches { gt: N }', () => {
    expect(matchPrimitive(10, { gt: 5 })).toBe(true);
    expect(matchPrimitive(5, { gt: 5 })).toBe(false);
    expect(matchPrimitive('not_a_number', { gt: 5 })).toBe(false);
  });

  it('matches { gte: N }', () => {
    expect(matchPrimitive(5, { gte: 5 })).toBe(true);
    expect(matchPrimitive(4, { gte: 5 })).toBe(false);
  });

  it('matches { lt: N }', () => {
    expect(matchPrimitive(3, { lt: 5 })).toBe(true);
    expect(matchPrimitive(5, { lt: 5 })).toBe(false);
  });

  it('matches { lte: N }', () => {
    expect(matchPrimitive(5, { lte: 5 })).toBe(true);
    expect(matchPrimitive(6, { lte: 5 })).toBe(false);
  });

  it('matches { startsWith: str }', () => {
    expect(matchPrimitive('/home/user', { startsWith: '/home' })).toBe(true);
    expect(matchPrimitive('/tmp', { startsWith: '/home' })).toBe(false);
    expect(matchPrimitive(42, { startsWith: '4' })).toBe(false);
  });

  it('matches { endsWith: str }', () => {
    expect(matchPrimitive('file.json', { endsWith: '.json' })).toBe(true);
    expect(matchPrimitive('file.txt', { endsWith: '.json' })).toBe(false);
  });

  it('matches { regex: pattern }', () => {
    expect(matchPrimitive('hello-world', { regex: '^hello-\\w+$' })).toBe(true);
    expect(matchPrimitive('goodbye', { regex: '^hello' })).toBe(false);
    expect(matchPrimitive(42, { regex: '\\d+' })).toBe(false);
  });

  it('returns false for invalid regex', () => {
    expect(matchPrimitive('test', { regex: '(invalid[' })).toBe(false);
  });

  it('matches { exists: true }', () => {
    expect(matchPrimitive('any', { exists: true })).toBe(true);
    expect(matchPrimitive(0, { exists: true })).toBe(true);
    expect(matchPrimitive(null, { exists: true })).toBe(false);
    expect(matchPrimitive(undefined, { exists: true })).toBe(false);
  });

  it('matches { exists: false }', () => {
    expect(matchPrimitive(undefined, { exists: false })).toBe(true);
    expect(matchPrimitive(null, { exists: false })).toBe(true);
    expect(matchPrimitive('present', { exists: false })).toBe(false);
  });
});

// ── matchConditions ──────────────────────────────────────────────

describe('matchConditions', () => {
  const input = makeInput();

  it('matches empty conditions (vacuously true)', () => {
    expect(matchConditions(input, {})).toBe(true);
  });

  it('matches single path condition', () => {
    expect(matchConditions(input, { action: 'tool:fs_read' })).toBe(true);
  });

  it('fails when single condition does not match', () => {
    expect(matchConditions(input, { action: 'tool:fs_write' })).toBe(false);
  });

  it('matches multiple conditions (implicit allOf)', () => {
    expect(matchConditions(input, {
      action: 'tool:fs_read',
      'context.isReadOnly': true,
    })).toBe(true);
  });

  it('fails when one of multiple conditions mismatches', () => {
    expect(matchConditions(input, {
      action: 'tool:fs_read',
      'context.isReadOnly': false,
    })).toBe(false);
  });

  it('matches anyOf (at least one must match)', () => {
    expect(matchConditions(input, {
      anyOf: [
        { action: 'tool:fs_write' },
        { action: 'tool:fs_read' },
      ],
    })).toBe(true);
  });

  it('fails anyOf when none match', () => {
    expect(matchConditions(input, {
      anyOf: [
        { action: 'tool:fs_write' },
        { action: 'tool:shell_safe' },
      ],
    })).toBe(false);
  });

  it('fails anyOf with empty array', () => {
    expect(matchConditions(input, { anyOf: [] })).toBe(false);
  });

  it('matches allOf (all must match)', () => {
    expect(matchConditions(input, {
      allOf: [
        { 'context.isReadOnly': true },
        { 'principal.kind': 'user' },
      ],
    })).toBe(true);
  });

  it('fails allOf when one does not match', () => {
    expect(matchConditions(input, {
      allOf: [
        { 'context.isReadOnly': true },
        { 'principal.kind': 'agent' },
      ],
    })).toBe(false);
  });

  it('skips undefined values in conditions', () => {
    expect(matchConditions(input, {
      action: 'tool:fs_read',
      'context.nonexistent': undefined,
    })).toBe(true);
  });

  it('combines path conditions with anyOf', () => {
    expect(matchConditions(input, {
      'context.isReadOnly': true,
      anyOf: [
        { action: 'tool:fs_read' },
        { action: 'tool:fs_list' },
      ],
    })).toBe(true);
  });
});
