import { describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../guardian/audit-log.js';
import type { AgentContext } from '../agent/types.js';
import type { AgentEvent } from '../queue/event-bus.js';
import { SecurityActivityLogService } from './security-activity-log.js';
import {
  SecurityEventTriageAgent,
  SECURITY_TRIAGE_AGENT_ID,
  SECURITY_TRIAGE_DISPATCHER_AGENT_ID,
} from './security-triage-agent.js';

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    agentId: SECURITY_TRIAGE_DISPATCHER_AGENT_ID,
    capabilities: [],
    emit: vi.fn().mockResolvedValue(true),
    checkAction: vi.fn(),
    dispatch: vi.fn().mockResolvedValue({ content: 'Likely benign provider posture issue. Stay in monitor.' }),
    ...overrides,
  };
}

describe('SecurityEventTriageAgent', () => {
  it('dispatches triage for relevant security events and records the outcome', async () => {
    const auditLog = new AuditLog();
    const activityLog = new SecurityActivityLogService({ persistPath: '/tmp/security-triage-agent-test-activity.json' });
    const agent = new SecurityEventTriageAgent({
      targetAgentId: SECURITY_TRIAGE_AGENT_ID,
      primaryUserId: 'owner',
      auditLog,
      activityLog,
      now: () => 1_000,
    });
    const ctx = makeContext();

    await agent.onEvent({
      type: 'security:native:provider',
      sourceAgentId: 'windows-defender',
      targetAgentId: '*',
      payload: {
        alert: {
          type: 'defender_threat_detected',
          severity: 'critical',
          description: 'Windows Defender detected a threat.',
        },
      },
      timestamp: 900,
    }, ctx);

    expect(vi.mocked(ctx.dispatch)).toHaveBeenCalledTimes(1);
    const [targetAgentId, message, options] = vi.mocked(ctx.dispatch).mock.calls[0]!;
    expect(targetAgentId).toBe(SECURITY_TRIAGE_AGENT_ID);
    expect(message.content).toContain('Investigate this security event as the dedicated Security Triage Agent.');
    expect(message.content).toContain('defender_threat_detected');
    expect(message.content).toContain('host-firewall-defense');
    expect(options?.handoff?.allowedCapabilities).toEqual(['execute_commands', 'network_access']);

    const findings = auditLog.query({ type: 'automation_finding' });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.agentId).toBe(SECURITY_TRIAGE_DISPATCHER_AGENT_ID);
    expect(findings[0]?.details['automationName']).toBe('Security Triage Agent');
    expect(findings[0]?.details['triggerDetailType']).toBe('defender_threat_detected');
    const activity = activityLog.list();
    expect(activity.totalMatches).toBe(2);
    expect(activity.entries[0]?.status).toBe('completed');
    expect(activity.entries[1]?.status).toBe('started');

    expect(vi.mocked(ctx.emit)).toHaveBeenCalledWith(expect.objectContaining({
      type: 'security:triage:completed',
      targetAgentId: '*',
    }));
  });

  it('deduplicates repeated events inside the cooldown window', async () => {
    let now = 1_000;
    const auditLog = new AuditLog();
    const agent = new SecurityEventTriageAgent({
      targetAgentId: SECURITY_TRIAGE_AGENT_ID,
      primaryUserId: 'owner',
      auditLog,
      now: () => now,
      cooldownMs: 60_000,
    });
    const ctx = makeContext();
    const event: AgentEvent = {
      type: 'security:network:threat',
      sourceAgentId: 'network-sentinel',
      targetAgentId: '*',
      payload: {
        type: 'beaconing',
        severity: 'high',
        description: 'Beaconing detected to external host.',
      },
      timestamp: 900,
    };

    await agent.onEvent(event, ctx);
    now += 5_000;
    await agent.onEvent(event, ctx);

    expect(vi.mocked(ctx.dispatch)).toHaveBeenCalledTimes(1);
    expect(auditLog.query({ type: 'automation_finding' })).toHaveLength(1);
  });

  it('records low-severity host alerts as skipped without dispatching triage', async () => {
    const auditLog = new AuditLog();
    const activityLog = new SecurityActivityLogService({ persistPath: '/tmp/security-triage-agent-skip-test-activity.json' });
    const agent = new SecurityEventTriageAgent({
      targetAgentId: SECURITY_TRIAGE_AGENT_ID,
      primaryUserId: 'owner',
      auditLog,
      activityLog,
      now: () => 1_000,
    });
    const ctx = makeContext();

    await agent.onEvent({
      type: 'security:host:alert',
      sourceAgentId: 'host-monitor',
      targetAgentId: '*',
      payload: {
        alert: {
          type: 'new_external_destination',
          severity: 'low',
          description: 'New external destination observed: 203.0.113.10',
          dedupeKey: 'host:new_external_destination:203.0.113.10',
        },
      },
      timestamp: 899,
    }, ctx);

    await agent.onEvent({
      type: 'security:alert',
      sourceAgentId: 'notification-service',
      targetAgentId: '*',
      payload: {
        severity: 'warn',
        sourceEventType: 'automation_finding',
        description: 'Security triage completed.',
      },
      timestamp: 901,
    }, ctx);

    expect(vi.mocked(ctx.dispatch)).not.toHaveBeenCalled();
    expect(auditLog.query({ type: 'automation_finding' })).toHaveLength(0);
    const activity = activityLog.list();
    expect(activity.totalMatches).toBe(1);
    expect(activity.entries[0]?.status).toBe('skipped');
    expect(activity.entries[0]?.details?.reason).toBe('low_severity');
  });

  it('records interactive host monitor checks as informational skipped entries', async () => {
    const auditLog = new AuditLog();
    const activityLog = new SecurityActivityLogService({ persistPath: '/tmp/security-triage-agent-check-test-activity.json' });
    const agent = new SecurityEventTriageAgent({
      targetAgentId: SECURITY_TRIAGE_AGENT_ID,
      primaryUserId: 'owner',
      auditLog,
      activityLog,
      now: () => 2_000,
    });
    const ctx = makeContext();

    await agent.onEvent({
      type: 'host:monitor:check',
      sourceAgentId: 'host-monitor',
      targetAgentId: '*',
      payload: {
        source: 'tool:host_monitor_check:assistant',
        baselineReady: true,
        snapshot: {
          processCount: 412,
          suspiciousProcesses: [],
          knownExternalDestinationCount: 53,
          listeningPortCount: 33,
        },
      },
      timestamp: 1_999,
    }, ctx);

    expect(vi.mocked(ctx.dispatch)).not.toHaveBeenCalled();
    const activity = activityLog.list();
    expect(activity.totalMatches).toBe(1);
    expect(activity.entries[0]?.status).toBe('skipped');
    expect(activity.entries[0]?.details?.reason).toBe('informational');
    expect(activity.entries[0]?.summary).toContain('Observed host monitor check');
  });
});
