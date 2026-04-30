import { describe, expect, it } from 'vitest';
import { ContainmentService } from './containment-service.js';
import type { UnifiedSecurityAlert } from './security-alerts.js';
import type { SecurityPostureAssessment } from './security-posture.js';

function createPosture(recommendedMode: SecurityPostureAssessment['recommendedMode']): SecurityPostureAssessment {
  return {
    profile: 'personal',
    currentMode: 'monitor',
    recommendedMode,
    shouldEscalate: recommendedMode !== 'monitor',
    summary: 'test',
    reasons: [],
    counts: { total: 0, low: 0, medium: 0, high: 0, critical: 0 },
    bySource: { host: 0, network: 0, gateway: 0, native: 0, assistant: 0, install: 0 },
    availableSources: ['assistant'],
    topAlerts: [],
  };
}

function createAssistantAlert(overrides: Partial<UnifiedSecurityAlert> = {}): UnifiedSecurityAlert {
  return {
    id: 'assistant-alert',
    source: 'assistant',
    type: 'assistant_security_mcp',
    severity: 'high',
    timestamp: 1_000,
    firstSeenAt: 1_000,
    lastSeenAt: 1_000,
    occurrenceCount: 1,
    description: 'Assistant Security alert',
    dedupeKey: 'assistant-alert',
    evidence: {
      category: 'mcp',
      confidence: 0.97,
    },
    subject: 'Runtime',
    confidence: 0.97,
    recommendedAction: 'Review the Assistant Security finding target, evidence, confidence, and containment state before triage.',
    acknowledged: false,
    status: 'active',
    lastStateChangedAt: 1_000,
    ...overrides,
  };
}

describe('ContainmentService Assistant Security auto-containment', () => {
  it('auto-elevates guarded mode after two high-confidence matching Assistant Security findings', () => {
    const service = new ContainmentService();
    const alerts = [
      createAssistantAlert({ id: 'mcp-1', dedupeKey: 'mcp-1' }),
      createAssistantAlert({ id: 'mcp-2', dedupeKey: 'mcp-2', timestamp: 1_100, firstSeenAt: 1_100, lastSeenAt: 1_100 }),
    ];

    const state = service.getState({
      profile: 'personal',
      currentMode: 'monitor',
      posture: createPosture('guarded'),
      alerts,
      assistantAutoContainment: {
        enabled: true,
        minSeverity: 'high',
        minConfidence: 0.95,
        categories: ['mcp'],
      },
    });

    expect(state.autoElevated).toBe(true);
    expect(state.effectiveMode).toBe('guarded');
    expect(state.activeActions.some((action) => action.type === 'restrict_mcp_tooling')).toBe(true);
    const mcpRestriction = state.activeActions.find((action) => action.type === 'restrict_mcp_tooling');
    expect(mcpRestriction?.restrictedActions).toContain('Third-party MCP tool calls.');
    expect(mcpRestriction?.recovery).toMatch(/Review the MCP server trust/);

    const decision = service.shouldAllowAction({
      profile: 'personal',
      currentMode: 'monitor',
      posture: createPosture('guarded'),
      alerts,
      assistantAutoContainment: {
        enabled: true,
        minSeverity: 'high',
        minConfidence: 0.95,
        categories: ['mcp'],
      },
      action: {
        type: 'mcp_tool',
        toolName: 'mcp_tool',
      },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.matchedAction).toBe('restrict_mcp_tooling');
  });

  it('does not auto-elevate from a single non-critical Assistant Security finding', () => {
    const service = new ContainmentService();
    const state = service.getState({
      profile: 'personal',
      currentMode: 'monitor',
      posture: createPosture('guarded'),
      alerts: [createAssistantAlert()],
      assistantAutoContainment: {
        enabled: true,
        minSeverity: 'high',
        minConfidence: 0.95,
        categories: ['mcp'],
      },
    });

    expect(state.autoElevated).toBe(false);
    expect(state.effectiveMode).toBe('monitor');
  });

  it('allows a single critical sandbox finding to tighten command execution conservatively', () => {
    const service = new ContainmentService();
    const alerts = [
      createAssistantAlert({
        id: 'sandbox-critical',
        dedupeKey: 'sandbox-critical',
        type: 'assistant_security_sandbox',
        severity: 'critical',
        evidence: {
          category: 'sandbox',
          confidence: 0.98,
        },
      }),
    ];

    const decision = service.shouldAllowAction({
      profile: 'personal',
      currentMode: 'monitor',
      posture: createPosture('ir_assist'),
      alerts,
      assistantAutoContainment: {
        enabled: true,
        minSeverity: 'high',
        minConfidence: 0.95,
        categories: ['sandbox'],
      },
      action: {
        type: 'execute_command',
        toolName: 'execute_command',
      },
    });

    expect(decision.state.autoElevated).toBe(true);
    expect(decision.allowed).toBe(false);
    expect(decision.matchedAction).toBe('restrict_command_execution');
    const commandRestriction = decision.state.activeActions.find((action) => action.type === 'restrict_command_execution');
    expect(commandRestriction?.restrictedActions).toContain('Shell and direct command execution.');
    expect(commandRestriction?.recovery).toMatch(/stronger sandbox/);
  });
});
