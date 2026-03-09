/**
 * Policy rule matcher — resolves dot-path values from PolicyInput
 * and evaluates match primitives.
 */

import type { PolicyInput, MatchPrimitive, MatchConditions } from './types.js';

// ── Path resolution ─────────────────────────────────────────────

/**
 * Resolve a dot-separated path from a PolicyInput.
 * Supports: action, principal.*, resource.*, context.*
 */
export function resolvePath(input: PolicyInput, path: string): unknown {
  if (path === 'action') return input.action;
  if (path === 'family') return input.family;

  const segments = path.split('.');
  const root = segments[0];
  let value: unknown;

  switch (root) {
    case 'principal':
      value = input.principal;
      break;
    case 'resource':
      value = input.resource;
      break;
    case 'context':
      value = input.context;
      break;
    default:
      return undefined;
  }

  for (let i = 1; i < segments.length; i++) {
    if (value == null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[segments[i]];
  }

  return value;
}

// ── Primitive matching ──────────────────────────────────────────

export function matchPrimitive(actual: unknown, expected: MatchPrimitive): boolean {
  if (expected === null || expected === undefined) return false;

  // Exact equality (string, number, boolean)
  if (typeof expected === 'string') return actual === expected;
  if (typeof expected === 'number') return actual === expected;
  if (typeof expected === 'boolean') return actual === expected;

  // Object-based primitives
  if (typeof expected === 'object') {
    if ('in' in expected) {
      return (expected.in as unknown[]).includes(actual);
    }
    if ('notIn' in expected) {
      return !(expected.notIn as unknown[]).includes(actual);
    }
    if ('gt' in expected) {
      return typeof actual === 'number' && actual > expected.gt;
    }
    if ('gte' in expected) {
      return typeof actual === 'number' && actual >= expected.gte;
    }
    if ('lt' in expected) {
      return typeof actual === 'number' && actual < expected.lt;
    }
    if ('lte' in expected) {
      return typeof actual === 'number' && actual <= expected.lte;
    }
    if ('startsWith' in expected) {
      return typeof actual === 'string' && actual.startsWith(expected.startsWith);
    }
    if ('endsWith' in expected) {
      return typeof actual === 'string' && actual.endsWith(expected.endsWith);
    }
    if ('regex' in expected) {
      if (typeof actual !== 'string') return false;
      try {
        return new RegExp(expected.regex).test(actual);
      } catch {
        return false;
      }
    }
    if ('exists' in expected) {
      return expected.exists
        ? actual !== undefined && actual !== null
        : actual === undefined || actual === null;
    }
  }

  return false;
}

// ── Condition block matching ────────────────────────────────────

/**
 * Evaluate a MatchConditions block against a PolicyInput.
 * Top-level conditions are implicitly allOf (all must match).
 * anyOf/allOf can be nested one level deep.
 */
export function matchConditions(input: PolicyInput, conditions: MatchConditions): boolean {
  for (const [key, value] of Object.entries(conditions)) {
    if (value === undefined) continue;

    // anyOf: at least one sub-block must match
    if (key === 'anyOf') {
      const blocks = value as MatchConditions[];
      if (blocks.length === 0) return false;
      const anyMatch = blocks.some(block => matchConditions(input, block));
      if (!anyMatch) return false;
      continue;
    }

    // allOf: all sub-blocks must match (explicit form of default)
    if (key === 'allOf') {
      const blocks = value as MatchConditions[];
      const allMatch = blocks.every(block => matchConditions(input, block));
      if (!allMatch) return false;
      continue;
    }

    // Regular path condition
    const actual = resolvePath(input, key);
    if (!matchPrimitive(actual, value as MatchPrimitive)) {
      return false;
    }
  }

  return true;
}
