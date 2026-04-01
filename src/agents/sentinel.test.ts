import { describe, it, expect, beforeEach } from 'vitest';
import { SentinelAgent } from './sentinel.js';
import { AuditLog } from '../guardian/audit-log.js';

describe('SentinelAgent', () => {
  let sentinel: SentinelAgent;
  let auditLog: AuditLog;

  beforeEach(() => {
    sentinel = new SentinelAgent();
    auditLog = new AuditLog(1000);
  });

  describe('detectAnomalies', () => {
    it('should detect volume spike when denial rate is high', () => {
      // Record many denials
      for (let i = 0; i < 40; i++) {
        auditLog.record({
          type: 'action_denied',
          severity: 'warn',
          agentId: 'agent-1',
          details: {},
        });
      }

      const summary = auditLog.getSummary(60_000);
      const anomalies = sentinel.detectAnomalies(summary, auditLog);

      const volumeSpike = anomalies.find(a => a.type === 'volume_spike');
      expect(volumeSpike).toBeDefined();
      // 40 denials > 3 * 10 = 30 threshold but <= 3 * 30 = 90 for critical
      expect(volumeSpike!.severity).toBe('warn');
    });

    it('should detect capability probing', () => {
      // Agent tries many different action types
      const actionTypes = ['write_file', 'read_file', 'execute_command', 'http_request', 'send_email', 'git_operation'];
      for (const actionType of actionTypes) {
        auditLog.record({
          type: 'action_denied',
          severity: 'warn',
          agentId: 'suspicious-agent',
          details: { actionType },
        });
      }

      const summary = auditLog.getSummary(60_000);
      const anomalies = sentinel.detectAnomalies(summary, auditLog);

      const probe = anomalies.find(a => a.type === 'capability_probe');
      expect(probe).toBeDefined();
      expect(probe!.agentId).toBe('suspicious-agent');
      expect(probe!.severity).toBe('critical');
    });

    it('should detect repeated secret detections', () => {
      for (let i = 0; i < 5; i++) {
        auditLog.record({
          type: 'secret_detected',
          severity: 'critical',
          agentId: 'leaky-agent',
          details: { pattern: 'AWS Access Key' },
        });
      }

      const summary = auditLog.getSummary(60_000);
      const anomalies = sentinel.detectAnomalies(summary, auditLog);

      const secretRepeat = anomalies.find(a => a.type === 'repeated_secret_detection');
      expect(secretRepeat).toBeDefined();
      expect(secretRepeat!.agentId).toBe('leaky-agent');
    });

    it('should detect error storms', () => {
      for (let i = 0; i < 15; i++) {
        auditLog.record({
          type: 'agent_error',
          severity: 'warn',
          agentId: 'crashy-agent',
          details: { error: 'something failed' },
        });
      }

      const summary = auditLog.getSummary(60_000);
      const anomalies = sentinel.detectAnomalies(summary, auditLog);

      const errorStorm = anomalies.find(a => a.type === 'error_storm');
      expect(errorStorm).toBeDefined();
    });

    it('should detect critical severity events', () => {
      auditLog.record({
        type: 'secret_detected',
        severity: 'critical',
        agentId: 'agent-1',
        details: {},
      });

      const summary = auditLog.getSummary(60_000);
      const anomalies = sentinel.detectAnomalies(summary, auditLog);

      const critical = anomalies.find(a => a.type === 'critical_events');
      expect(critical).toBeDefined();
      expect(critical!.severity).toBe('critical');
    });

    it('should return no anomalies for normal activity', () => {
      // Just a few normal events
      auditLog.record({ type: 'action_allowed', severity: 'info', agentId: 'a1', details: {} });
      auditLog.record({ type: 'action_allowed', severity: 'info', agentId: 'a2', details: {} });

      const summary = auditLog.getSummary(60_000);
      const anomalies = sentinel.detectAnomalies(summary, auditLog);

      expect(anomalies.length).toBe(0);
    });

    it('should respect custom thresholds', () => {
      const customSentinel = new SentinelAgent({ capabilityProbeThreshold: 2 });

      // Just 2 different action types denied
      auditLog.record({ type: 'action_denied', severity: 'warn', agentId: 'a1', details: { actionType: 'write_file' } });
      auditLog.record({ type: 'action_denied', severity: 'warn', agentId: 'a1', details: { actionType: 'execute_command' } });

      const summary = auditLog.getSummary(60_000);
      const anomalies = customSentinel.detectAnomalies(summary, auditLog);

      const probe = anomalies.find(a => a.type === 'capability_probe');
      expect(probe).toBeDefined();
    });
  });

  describe('onSchedule', () => {
    it('should record anomalies to audit log when run on schedule', async () => {
      // Populate audit log with anomalous activity
      for (let i = 0; i < 40; i++) {
        auditLog.record({
          type: 'action_denied',
          severity: 'warn',
          agentId: 'bad-agent',
          details: {},
        });
      }

      const ctx = {
        agentId: 'sentinel',
        capabilities: [] as string[],
        emit: async () => {},
        checkAction: () => {},
        schedule: '*/5 * * * *',
        auditLog,
      };

      await sentinel.onSchedule(ctx);

      // Check that anomaly_detected events were recorded
      const anomalyEvents = auditLog.query({ type: 'anomaly_detected' });
      expect(anomalyEvents.length).toBeGreaterThan(0);
    });

    it('should not record anything if no events in window', async () => {
      const ctx = {
        agentId: 'sentinel',
        capabilities: [] as string[],
        emit: async () => {},
        checkAction: () => {},
        schedule: '*/5 * * * *',
        auditLog,
      };

      const sizeBefore = auditLog.size;
      await sentinel.onSchedule(ctx);
      expect(auditLog.size).toBe(sizeBefore);
    });

    it('should apply Guardian core mission to sentinel LLM analysis prompt', async () => {
      for (let i = 0; i < 40; i++) {
        auditLog.record({
          type: 'action_denied',
          severity: 'warn',
          agentId: 'bad-agent',
          details: {},
        });
      }

      const llmCalls: Array<Array<{ role: string; content: string }>> = [];
      const ctx = {
        agentId: 'sentinel',
        capabilities: [] as string[],
        emit: async () => {},
        checkAction: () => {},
        schedule: '*/5 * * * *',
        auditLog,
        llm: {
          chat: async (messages: Array<{ role: string; content: string }>) => {
            llmCalls.push(messages);
            return { content: '{"findings":[]}' };
          },
        },
      };

      await sentinel.onSchedule(ctx);

      expect(llmCalls.length).toBe(1);
      expect(llmCalls[0][0].role).toBe('system');
      expect(llmCalls[0][0].content).toContain('You are Guardian Agent');
      expect(llmCalls[0][0].content).toContain('Primary mission');
      expect(llmCalls[0][0].content).toContain('Sentinel');
    });

    it('should accept markdown-wrapped JSON findings from the LLM', async () => {
      for (let i = 0; i < 40; i += 1) {
        auditLog.record({
          type: 'action_denied',
          severity: 'warn',
          agentId: 'bad-agent',
          details: {},
        });
      }

      const ctx = {
        agentId: 'sentinel',
        capabilities: [] as string[],
        emit: async () => {},
        checkAction: () => {},
        schedule: '*/5 * * * *',
        auditLog,
        llm: {
          chat: async () => ({
            content: [
              '```json',
              '{',
              '  "findings": [',
              '    {',
              '      "severity": "critical",',
              '      "description": "Repeated denial probing detected.",',
              '      "recommendation": "Inspect the blocked actions."',
              '    }',
              '  ]',
              '}',
              '```',
            ].join('\n'),
          }),
        },
      };

      await sentinel.onSchedule(ctx);

      const llmFindings = auditLog.query({ type: 'anomaly_detected' })
        .filter((event) => event.details['source'] === 'llm_analysis');
      expect(llmFindings).toHaveLength(1);
      expect(String(llmFindings[0]?.details['description'] ?? '')).toContain('Repeated denial probing');
    });
  });

  describe('agent properties', () => {
    it('should have correct capabilities', () => {
      expect(sentinel.id).toBe('sentinel');
      expect(sentinel.name).toBe('Sentinel Security Agent');
      expect(sentinel.capabilities.handleMessages).toBe(false);
      expect(sentinel.capabilities.handleEvents).toBe(true);
      expect(sentinel.capabilities.handleSchedule).toBe(true);
    });
  });
});
