import { describe, it, expect } from 'vitest';
import { decideToolRun, buildJobData } from './workflows.js';
import type { ToolDefinition } from './types.js';

function makeDef(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test_tool',
    description: 'test',
    risk: 'read_only',
    parameters: {},
    category: 'filesystem',
    ...overrides,
  };
}

describe('decideToolRun', () => {
  it('returns disabled when tools are disabled', () => {
    const result = decideToolRun('test_tool', {
      enabled: false,
      categoryEnabled: true,
      definition: makeDef(),
      policyMode: 'autonomous',
      toolPolicies: {},
    });
    expect(result.kind).toBe('disabled');
  });

  it('returns unknown_tool when definition is null', () => {
    const result = decideToolRun('missing', {
      enabled: true,
      categoryEnabled: true,
      definition: null,
      policyMode: 'autonomous',
      toolPolicies: {},
    });
    expect(result.kind).toBe('unknown_tool');
  });

  it('returns category_disabled when category is off', () => {
    const result = decideToolRun('test_tool', {
      enabled: true,
      categoryEnabled: false,
      definition: makeDef(),
      policyMode: 'autonomous',
      toolPolicies: {},
    });
    expect(result.kind).toBe('category_disabled');
  });

  it('respects explicit deny policy', () => {
    const result = decideToolRun('test_tool', {
      enabled: true,
      categoryEnabled: true,
      definition: makeDef(),
      policyMode: 'autonomous',
      toolPolicies: { test_tool: 'deny' },
    });
    expect(result.kind).toBe('deny');
  });

  it('respects explicit auto policy', () => {
    const result = decideToolRun('test_tool', {
      enabled: true,
      categoryEnabled: true,
      definition: makeDef({ risk: 'mutating' }),
      policyMode: 'approve_each',
      toolPolicies: { test_tool: 'auto' },
    });
    expect(result.kind).toBe('allow');
  });

  it('respects explicit manual policy', () => {
    const result = decideToolRun('test_tool', {
      enabled: true,
      categoryEnabled: true,
      definition: makeDef(),
      policyMode: 'autonomous',
      toolPolicies: { test_tool: 'manual' },
    });
    expect(result.kind).toBe('require_approval');
  });

  it('external_post always requires approval', () => {
    const result = decideToolRun('test_tool', {
      enabled: true,
      categoryEnabled: true,
      definition: makeDef({ risk: 'external_post' }),
      policyMode: 'autonomous',
      toolPolicies: {},
    });
    expect(result.kind).toBe('require_approval');
  });

  it('autonomous mode allows everything', () => {
    const result = decideToolRun('test_tool', {
      enabled: true,
      categoryEnabled: true,
      definition: makeDef({ risk: 'mutating' }),
      policyMode: 'autonomous',
      toolPolicies: {},
    });
    expect(result.kind).toBe('allow');
  });

  it('approve_each allows read_only', () => {
    const result = decideToolRun('test_tool', {
      enabled: true,
      categoryEnabled: true,
      definition: makeDef({ risk: 'read_only' }),
      policyMode: 'approve_each',
      toolPolicies: {},
    });
    expect(result.kind).toBe('allow');
  });

  it('approve_each requires approval for mutating', () => {
    const result = decideToolRun('test_tool', {
      enabled: true,
      categoryEnabled: true,
      definition: makeDef({ risk: 'mutating' }),
      policyMode: 'approve_each',
      toolPolicies: {},
    });
    expect(result.kind).toBe('require_approval');
  });

  it('approve_by_policy allows network', () => {
    const result = decideToolRun('test_tool', {
      enabled: true,
      categoryEnabled: true,
      definition: makeDef({ risk: 'network' }),
      policyMode: 'approve_by_policy',
      toolPolicies: {},
    });
    expect(result.kind).toBe('allow');
  });

  it('approve_by_policy requires approval for mutating', () => {
    const result = decideToolRun('test_tool', {
      enabled: true,
      categoryEnabled: true,
      definition: makeDef({ risk: 'mutating' }),
      policyMode: 'approve_by_policy',
      toolPolicies: {},
    });
    expect(result.kind).toBe('require_approval');
  });
});

describe('buildJobData', () => {
  it('extracts correct fields', () => {
    const def = makeDef({ name: 'fs_read', risk: 'read_only' });
    const data = buildJobData(def, { origin: 'web', agentId: 'a1', userId: 'u1' });
    expect(data.toolName).toBe('fs_read');
    expect(data.risk).toBe('read_only');
    expect(data.origin).toBe('web');
    expect(data.agentId).toBe('a1');
  });
});
