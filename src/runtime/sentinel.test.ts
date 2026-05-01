import { describe, it, expect, vi } from 'vitest';
import { AuditLog } from '../guardian/audit-log.js';
import { GuardianAgentService, SentinelAuditService } from './sentinel.js';

describe('GuardianAgentService', () => {
  it('parses fenced JSON verdicts from local models', async () => {
    const service = new GuardianAgentService({
      enabled: true,
      llmProvider: 'local',
      actionTypes: ['write_file'],
      failOpen: false,
    });
    service.setProviders({
      name: 'test-local',
      chat: async () => ({
        content: [
          '```json',
          '{',
          '  "allowed": false,',
          '  "riskLevel": "critical",',
          '  "reason": "Potential destructive write."',
          '}',
          '```',
        ].join('\n'),
        model: 'test-local-model',
        finishReason: 'stop',
      }),
      stream: async function* () {},
      listModels: async () => [],
    });

    const result = await service.evaluateAction({
      type: 'write_file',
      toolName: 'fs_write',
      params: { path: '/tmp/test.txt' },
      agentId: 'agent-1',
    });

    expect(result.allowed).toBe(false);
    expect(result.riskLevel).toBe('critical');
    expect(result.reason).toContain('Potential destructive write');
  });

  it('re-prompts for strict JSON when the first verdict is malformed', async () => {
    const service = new GuardianAgentService({
      enabled: true,
      llmProvider: 'local',
      actionTypes: ['write_file'],
      failOpen: false,
    });
    const replies = [
      {
        content: 'allowed: false, riskLevel: critical, reason: Potential destructive write.',
        model: 'test-local-model',
        finishReason: 'stop' as const,
      },
      {
        content: JSON.stringify({
          allowed: false,
          riskLevel: 'critical',
          reason: 'Potential destructive write.',
        }),
        model: 'test-local-model',
        finishReason: 'stop' as const,
      },
    ];
    let callCount = 0;

    service.setProviders({
      name: 'test-local',
      chat: async () => {
        callCount += 1;
        const next = replies.shift();
        if (!next) {
          throw new Error('Unexpected extra GuardianAgentService repair call');
        }
        return next;
      },
      stream: async function* () {},
      listModels: async () => [],
    });

    const result = await service.evaluateAction({
      type: 'write_file',
      toolName: 'fs_write',
      params: { path: '/tmp/test.txt' },
      agentId: 'agent-1',
    });

    expect(callCount).toBe(2);
    expect(result.allowed).toBe(false);
    expect(result.riskLevel).toBe('critical');
  });
});

describe('SentinelAuditService', () => {
  it('parses markdown-wrapped JSON findings from local models', async () => {
    const auditLog = new AuditLog(1000);
    for (let i = 0; i < 40; i += 1) {
      auditLog.record({
        type: 'action_denied',
        severity: 'warn',
        agentId: 'bad-agent',
        details: {},
      });
    }

    const service = new SentinelAuditService();
    service.setProvider({
      name: 'test-local',
      chat: async () => ({
        content: [
          'Review complete.',
          '```json',
          '{',
          '  "findings": [',
          '    {',
          '      "severity": "critical",',
          '      "description": "Coordinated probing pattern detected.",',
          '      "recommendation": "Pause the agent and review denied actions."',
          '    }',
          '  ]',
          '}',
          '```',
        ].join('\n'),
        model: 'test-local-model',
        finishReason: 'stop',
      }),
      stream: async function* () {},
      listModels: async () => [],
    });

    const result = await service.runAudit(auditLog, 60_000);

    expect(result.llmFindings).toHaveLength(1);
    expect(result.llmFindings[0]?.description).toContain('Coordinated probing pattern');
    const findings = auditLog.query({ type: 'anomaly_detected' })
      .filter((event) => event.details['source'] === 'llm_analysis');
    expect(findings).toHaveLength(1);
  });

  it('returns heuristic anomalies when LLM audit analysis times out', async () => {
    vi.useFakeTimers();
    try {
      const auditLog = new AuditLog(1000);
      for (let i = 0; i < 40; i += 1) {
        auditLog.record({
          type: 'action_denied',
          severity: 'warn',
          agentId: 'bad-agent',
          details: {},
        });
      }

      let observedSignal: AbortSignal | undefined;
      const service = new SentinelAuditService({ timeoutMs: 50 });
      service.setProvider({
        name: 'stuck-provider',
        chat: async (_messages, options) => {
          observedSignal = options?.signal;
          return new Promise<never>(() => undefined);
        },
        stream: async function* () {},
        listModels: async () => [],
      });

      const auditPromise = service.runAudit(auditLog, 60_000);
      await vi.advanceTimersByTimeAsync(50);
      const result = await auditPromise;

      expect(result.anomalies).toHaveLength(1);
      expect(result.llmFindings).toEqual([]);
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
