import { describe, expect, it, vi } from 'vitest';

import {
  isReservedAgentAlias,
  normalizeCodeSessionAgentId,
  resolveConfiguredAgentId,
} from './agent-target-resolution.js';

describe('isReservedAgentAlias', () => {
  it('recognizes reserved routing aliases', () => {
    expect(isReservedAgentAlias('default')).toBe(true);
    expect(isReservedAgentAlias('local')).toBe(true);
    expect(isReservedAgentAlias('external')).toBe(true);
    expect(isReservedAgentAlias('general')).toBe(true);
    expect(isReservedAgentAlias('worker')).toBe(false);
  });
});

describe('resolveConfiguredAgentId', () => {
  it('maps the default alias to the runtime default agent id', () => {
    expect(resolveConfiguredAgentId('default', {
      defaultAgentId: 'default-agent',
      router: { findAgentByRole: vi.fn(() => undefined) },
    })).toBe('default-agent');
  });

  it('maps routing aliases to the current lane agent ids', () => {
    const findAgentByRole = vi.fn((role: string) => {
      if (role === 'external') return { id: 'external-agent' };
      if (role === 'local') return { id: 'local-agent' };
      return undefined;
    });

    expect(resolveConfiguredAgentId('external', {
      defaultAgentId: 'default-agent',
      router: { findAgentByRole },
    })).toBe('external-agent');
    expect(resolveConfiguredAgentId('local', {
      defaultAgentId: 'default-agent',
      router: { findAgentByRole },
    })).toBe('local-agent');
  });

  it('leaves concrete non-reserved agent ids unchanged', () => {
    expect(resolveConfiguredAgentId('guardian-agent', {
      defaultAgentId: 'default-agent',
      router: { findAgentByRole: vi.fn(() => undefined) },
    })).toBe('guardian-agent');
  });

  it('drops unresolved reserved aliases when the lane is unavailable', () => {
    expect(resolveConfiguredAgentId('external', {
      defaultAgentId: 'default-agent',
      router: { findAgentByRole: vi.fn(() => undefined) },
      hasAgent: vi.fn(() => false),
    })).toBeUndefined();
  });

  it('preserves reserved-looking ids when a concrete agent with that id exists', () => {
    expect(resolveConfiguredAgentId('external', {
      defaultAgentId: 'default-agent',
      router: { findAgentByRole: vi.fn(() => undefined) },
      hasAgent: vi.fn((agentId: string) => agentId === 'external'),
    })).toBe('external');
  });
});

describe('normalizeCodeSessionAgentId', () => {
  it('drops reserved routing aliases for stored code sessions', () => {
    expect(normalizeCodeSessionAgentId('external', {
      router: { findAgentByRole: vi.fn(() => undefined) },
    })).toBeNull();
  });

  it('drops current routing lane agent ids for stored code sessions', () => {
    const findAgentByRole = vi.fn((role: string) => {
      if (role === 'local') return { id: 'local-agent' };
      if (role === 'external') return { id: 'external-agent' };
      return undefined;
    });

    expect(normalizeCodeSessionAgentId('local-agent', {
      router: { findAgentByRole },
    })).toBeNull();
    expect(normalizeCodeSessionAgentId('external-agent', {
      router: { findAgentByRole },
    })).toBeNull();
  });

  it('preserves concrete non-routing worker ids', () => {
    expect(normalizeCodeSessionAgentId('repo-worker', {
      router: { findAgentByRole: vi.fn(() => undefined) },
    })).toBe('repo-worker');
  });
});
