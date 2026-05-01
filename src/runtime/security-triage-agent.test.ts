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
    expect(findings[0]?.details['automationDisposition']).toEqual({
      notify: false,
      sendToSecurity: true,
    });
    const activity = activityLog.list();
    expect(activity.totalMatches).toBe(2);
    expect(activity.entries[0]?.status).toBe('completed');
    expect(activity.entries[1]?.status).toBe('started');

    expect(vi.mocked(ctx.emit)).toHaveBeenCalledWith(expect.objectContaining({
      type: 'security:triage:completed',
      targetAgentId: '*',
    }));
  });

  it('does not write raw provider tool markup into triage findings', async () => {
    const auditLog = new AuditLog();
    const activityLog = new SecurityActivityLogService({ persistPath: '/tmp/security-triage-agent-raw-tool-test-activity.json' });
    const agent = new SecurityEventTriageAgent({
      targetAgentId: SECURITY_TRIAGE_AGENT_ID,
      primaryUserId: 'owner',
      auditLog,
      activityLog,
      now: () => 1_250,
    });
    const ctx = makeContext({
      dispatch: vi.fn().mockResolvedValue({
        content: [
          '<minimax:tool_call>',
          '<invoke name="assistant_security_summary">',
          '<parameter name="scope">recent</parameter>',
          '</invoke>',
          '</minimax:tool_call>',
        ].join(''),
      }),
    });

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
      timestamp: 1_200,
    }, ctx);

    const finding = auditLog.query({ type: 'automation_finding' })[0];
    expect(finding?.details['description']).toBe(
      'Security triage completed for defender_threat_detected, but the model did not return a usable narrative summary. Review the security activity trail and corroborating tool evidence before taking action.',
    );
    expect(activityLog.list().entries[0]?.summary).toBe(finding?.details['description']);
    expect(vi.mocked(ctx.emit)).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        summary: finding?.details['description'],
      }),
    }));
  });

  it('does not write tool-round-only status text into triage findings', async () => {
    const auditLog = new AuditLog();
    const agent = new SecurityEventTriageAgent({
      targetAgentId: SECURITY_TRIAGE_AGENT_ID,
      primaryUserId: 'owner',
      auditLog,
      now: () => 1_500,
    });
    const ctx = makeContext({
      dispatch: vi.fn().mockResolvedValue({
        content: [
          'Tool round status:',
          '- Tool \'find_tools\' completed.',
          '- Tool \'find_tools\' completed.',
        ].join('\n'),
      }),
    });

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
      timestamp: 1_450,
    }, ctx);

    const finding = auditLog.query({ type: 'automation_finding' })[0];
    expect(finding?.details['description']).toContain('did not return a usable narrative summary');
    expect(finding?.details['description']).not.toContain('Tool round status');
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

  it('dispatches triage for promoted anomaly notifications', async () => {
    const auditLog = new AuditLog();
    const activityLog = new SecurityActivityLogService({ persistPath: '/tmp/security-triage-agent-anomaly-test-activity.json' });
    const agent = new SecurityEventTriageAgent({
      targetAgentId: SECURITY_TRIAGE_AGENT_ID,
      primaryUserId: 'owner',
      auditLog,
      activityLog,
      now: () => 3_000,
    });
    const ctx = makeContext();

    await agent.onEvent({
      type: 'security:alert',
      sourceAgentId: 'notification-service',
      targetAgentId: '*',
      payload: {
        severity: 'warn',
        sourceEventType: 'anomaly_detected',
        description: 'Assistant Security detected a connected third-party MCP server with network access.',
        details: {
          anomalyType: 'assistant_security_mcp',
        },
      },
      timestamp: 2_999,
    }, ctx);

    expect(vi.mocked(ctx.dispatch)).toHaveBeenCalledTimes(1);
    const [targetAgentId, message] = vi.mocked(ctx.dispatch).mock.calls[0]!;
    expect(targetAgentId).toBe(SECURITY_TRIAGE_AGENT_ID);
    expect(message.content).toContain('assistant_security_mcp');
    expect(message.content).toContain('assistant_security_findings');
  });

  it('does not recursively triage its own failure notifications', async () => {
    const auditLog = new AuditLog();
    const activityLog = new SecurityActivityLogService({ persistPath: '/tmp/security-triage-agent-self-error-test-activity.json' });
    const agent = new SecurityEventTriageAgent({
      targetAgentId: SECURITY_TRIAGE_AGENT_ID,
      primaryUserId: 'owner',
      auditLog,
      activityLog,
      now: () => 3_500,
    });
    const ctx = makeContext();

    await agent.onEvent({
      type: 'security:alert',
      sourceAgentId: 'notification-service',
      targetAgentId: '*',
      payload: {
        severity: 'warn',
        sourceEventType: 'agent_error',
        agentId: SECURITY_TRIAGE_DISPATCHER_AGENT_ID,
        description: "Agent 'security-triage' exceeded budget timeout (120000ms)",
        details: {
          reason: "Agent 'security-triage' exceeded budget timeout (120000ms)",
          sourceEventType: 'security:native:provider',
          triggerDetailType: 'defender_threat_detected',
          dedupeKey: 'security:native:provider:defender_threat_detected',
        },
      },
      timestamp: 3_499,
    }, ctx);

    expect(vi.mocked(ctx.dispatch)).not.toHaveBeenCalled();
    expect(auditLog.query({ type: 'automation_finding' })).toHaveLength(0);
    expect(activityLog.list().totalMatches).toBe(0);
  });

  it('still triages external agent error notifications', async () => {
    const auditLog = new AuditLog();
    const activityLog = new SecurityActivityLogService({ persistPath: '/tmp/security-triage-agent-external-error-test-activity.json' });
    const agent = new SecurityEventTriageAgent({
      targetAgentId: SECURITY_TRIAGE_AGENT_ID,
      primaryUserId: 'owner',
      auditLog,
      activityLog,
      now: () => 3_600,
    });
    const ctx = makeContext();

    await agent.onEvent({
      type: 'security:alert',
      sourceAgentId: 'notification-service',
      targetAgentId: '*',
      payload: {
        severity: 'warn',
        sourceEventType: 'agent_error',
        agentId: 'gmail-assistant',
        description: 'Token refresh failed during delegated mailbox scan.',
        details: {
          reason: 'Token refresh failed during delegated mailbox scan.',
        },
      },
      timestamp: 3_599,
    }, ctx);

    expect(vi.mocked(ctx.dispatch)).toHaveBeenCalledTimes(1);
    const [, message] = vi.mocked(ctx.dispatch).mock.calls[0]!;
    expect(message.content).toContain('agent_error');
    expect(message.content).toContain('Token refresh failed');
  });

  it('skips expected guardrail action-denied notifications', async () => {
    const auditLog = new AuditLog();
    const activityLog = new SecurityActivityLogService({ persistPath: '/tmp/security-triage-agent-guardrail-test-activity.json' });
    const agent = new SecurityEventTriageAgent({
      targetAgentId: SECURITY_TRIAGE_AGENT_ID,
      primaryUserId: 'owner',
      auditLog,
      activityLog,
      now: () => 4_000,
    });
    const ctx = makeContext();

    await agent.onEvent({
      type: 'security:alert',
      sourceAgentId: 'notification-service',
      targetAgentId: '*',
      payload: {
        severity: 'warn',
        sourceEventType: 'action_denied',
        description: 'Manual code terminals stay disabled by default on degraded sandbox backends.',
        details: {
          reason: 'degraded_backend_manual_terminals_disabled',
          source: 'code_terminal',
        },
      },
      timestamp: 3_999,
    }, ctx);

    expect(vi.mocked(ctx.dispatch)).not.toHaveBeenCalled();
    expect(auditLog.query({ type: 'automation_finding' })).toHaveLength(0);
    const activity = activityLog.list();
    expect(activity.totalMatches).toBe(1);
    expect(activity.entries[0]?.status).toBe('skipped');
    expect(activity.entries[0]?.triggerDetailType).toBe('degraded_backend_manual_terminals_disabled');
    expect(activity.entries[0]?.details?.reason).toBe('low_confidence');
  });
});
