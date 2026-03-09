import { describe, it, expect } from 'vitest';
import { normalizeToolRequest } from './normalize-tool.js';
import type { ToolDefinition, ToolExecutionRequest } from '../tools/types.js';

function makeRequest(overrides: Partial<ToolExecutionRequest> = {}): ToolExecutionRequest {
  return {
    toolName: 'fs_read',
    args: { path: '/tmp/test.txt' },
    origin: 'assistant',
    ...overrides,
  };
}

function makeDefinition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'fs_read',
    description: 'Read a file',
    risk: 'read_only',
    parameters: {},
    category: 'filesystem',
    ...overrides,
  };
}

describe('normalizeToolRequest', () => {
  it('creates a tool family PolicyInput', () => {
    const input = normalizeToolRequest(makeRequest(), makeDefinition(), 'approve_by_policy');
    expect(input.family).toBe('tool');
    expect(input.action).toBe('tool:fs_read');
  });

  it('sets principal from agentId', () => {
    const input = normalizeToolRequest(
      makeRequest({ agentId: 'agent-1' }),
      makeDefinition(),
      'approve_by_policy',
    );
    expect(input.principal.kind).toBe('agent');
    expect(input.principal.id).toBe('agent-1');
  });

  it('sets principal from userId when no agentId', () => {
    const input = normalizeToolRequest(
      makeRequest({ userId: 'user-42' }),
      makeDefinition(),
      'approve_by_policy',
    );
    expect(input.principal.kind).toBe('user');
    expect(input.principal.id).toBe('user-42');
  });

  it('falls back to unknown principal', () => {
    const input = normalizeToolRequest(makeRequest(), makeDefinition(), 'approve_by_policy');
    expect(input.principal.id).toBe('unknown');
  });

  it('sets resource kind from category', () => {
    const input = normalizeToolRequest(makeRequest(), makeDefinition(), 'approve_by_policy');
    expect(input.resource.kind).toBe('filesystem');
    expect(input.resource.id).toBe('fs_read');
  });

  it('sets resource kind to unknown when no category', () => {
    const input = normalizeToolRequest(
      makeRequest(),
      makeDefinition({ category: undefined }),
      'approve_by_policy',
    );
    expect(input.resource.kind).toBe('unknown');
  });

  it('includes context fields', () => {
    const input = normalizeToolRequest(makeRequest(), makeDefinition(), 'autonomous');
    expect(input.context.policyMode).toBe('autonomous');
    expect(input.context.isReadOnly).toBe(true);
    expect(input.context.risk).toBe('read_only');
    expect(input.context.origin).toBe('assistant');
    expect(input.context.dryRun).toBe(false);
  });

  it('extracts filesystem path attrs', () => {
    const input = normalizeToolRequest(
      makeRequest({ toolName: 'fs_read', args: { path: '/etc/passwd' } }),
      makeDefinition({ name: 'fs_read' }),
      'approve_by_policy',
    );
    expect(input.resource.attrs?.path).toBe('/etc/passwd');
  });

  it('extracts shell command attrs', () => {
    const input = normalizeToolRequest(
      makeRequest({ toolName: 'shell_safe', args: { command: 'ls -la | grep test' } }),
      makeDefinition({ name: 'shell_safe', risk: 'mutating', category: 'shell' }),
      'approve_by_policy',
    );
    expect(input.resource.attrs?.command).toBe('ls -la | grep test');
    expect(input.resource.attrs?.firstWord).toBe('ls');
    expect(input.resource.attrs?.hasShellOperators).toBe(true);
  });

  it('extracts shell command without operators', () => {
    const input = normalizeToolRequest(
      makeRequest({ toolName: 'shell_safe', args: { command: 'pwd' } }),
      makeDefinition({ name: 'shell_safe', risk: 'mutating', category: 'shell' }),
      'approve_by_policy',
    );
    expect(input.resource.attrs?.hasShellOperators).toBe(false);
  });

  it('extracts web_fetch url', () => {
    const input = normalizeToolRequest(
      makeRequest({ toolName: 'web_fetch', args: { url: 'https://example.com' } }),
      makeDefinition({ name: 'web_fetch', risk: 'network', category: 'web' }),
      'approve_by_policy',
    );
    expect(input.resource.attrs?.url).toBe('https://example.com');
  });

  it('extracts gws service and method', () => {
    const input = normalizeToolRequest(
      makeRequest({ toolName: 'gws', args: { service: 'gmail', method: 'send' } }),
      makeDefinition({ name: 'gws', risk: 'external_post', category: 'workspace' }),
      'approve_by_policy',
    );
    expect(input.resource.attrs?.service).toBe('gmail');
    expect(input.resource.attrs?.method).toBe('send');
  });

  it('extracts workflow IDs', () => {
    const input = normalizeToolRequest(
      makeRequest({ toolName: 'workflow_delete', args: { workflowId: 'wf-123' } }),
      makeDefinition({ name: 'workflow_delete', risk: 'mutating', category: 'automation' }),
      'approve_by_policy',
    );
    expect(input.resource.attrs?.workflowId).toBe('wf-123');
  });

  it('extracts intel target', () => {
    const input = normalizeToolRequest(
      makeRequest({ toolName: 'intel_watch_add', args: { target: '192.168.1.1' } }),
      makeDefinition({ name: 'intel_watch_add', risk: 'mutating', category: 'intel' }),
      'approve_by_policy',
    );
    expect(input.resource.attrs?.target).toBe('192.168.1.1');
  });

  it('sets channel from request', () => {
    const input = normalizeToolRequest(
      makeRequest({ channel: 'telegram' }),
      makeDefinition(),
      'approve_by_policy',
    );
    expect(input.principal.channel).toBe('telegram');
  });

  it('sets dryRun from request', () => {
    const input = normalizeToolRequest(
      makeRequest({ dryRun: true }),
      makeDefinition(),
      'approve_by_policy',
    );
    expect(input.context.dryRun).toBe(true);
  });
});
