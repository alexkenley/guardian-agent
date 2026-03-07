/**
 * Sentinel Agent — retrospective security analysis agent (legacy).
 *
 * Layer 4 defense: runs on a cron schedule, analyzes the AuditLog for
 * anomalous patterns, and optionally uses LLM for deeper analysis.
 * Also listens for real-time critical security events.
 *
 * Note: The active implementation is now SentinelAuditService in
 * src/runtime/sentinel.ts. This class is kept for test compatibility.
 */

import { BaseAgent } from '../agent/agent.js';
import type { AgentContext, ScheduleContext } from '../agent/types.js';
import type { AgentEvent } from '../queue/event-bus.js';
import type { AuditLog, AuditSummary } from '../guardian/audit-log.js';
import { composeGuardianSystemPrompt } from '../prompts/guardian-core.js';

/** Anomaly detected by the Sentinel. */
export interface Anomaly {
  /** Anomaly type identifier. */
  type: string;
  /** Severity: warn or critical. */
  severity: 'warn' | 'critical';
  /** Human-readable description. */
  description: string;
  /** Related agent ID (if applicable). */
  agentId?: string;
  /** Supporting evidence. */
  evidence: Record<string, unknown>;
}

/** Thresholds for anomaly detection. */
export interface AnomalyThresholds {
  /** Denial rate multiplier to trigger volume spike (default: 3). */
  volumeSpikeMultiplier: number;
  /** Max denied action types before capability probe alert (default: 5). */
  capabilityProbeThreshold: number;
  /** Max secret detections per agent before alert (default: 3). */
  secretDetectionThreshold: number;
}

const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  volumeSpikeMultiplier: 3,
  capabilityProbeThreshold: 5,
  secretDetectionThreshold: 3,
};

/** System prompt for LLM-based anomaly analysis. */
const SENTINEL_SYSTEM_PROMPT = composeGuardianSystemPrompt([
  'You are Sentinel, the Guardian Agent defensive intelligence analyst.',
  'Review the provided audit log summary for security threats and policy abuse.',
  '',
  'Analyze the data for:',
  '1. Unusual patterns suggesting attack or compromise',
  '2. Agents behaving outside normal patterns',
  '3. Potential data exfiltration attempts',
  '4. Privilege escalation patterns',
  '',
  'Output requirements:',
  '- Respond with strict JSON only.',
  '- Schema: { "findings": [{ "severity": "warn"|"critical", "description": "...", "recommendation": "..." }] }',
  '- If no issues found, return: { "findings": [] }',
].join('\n'));

/**
 * Sentinel security agent — analyzes audit logs for anomalies.
 *
 * Capabilities:
 * - Scheduled: periodic analysis of audit log summary
 * - Event-driven: immediate response to critical security events
 * - LLM-enhanced: optional deeper analysis using available LLM
 */
export class SentinelAgent extends BaseAgent {
  private thresholds: AnomalyThresholds;
  private lastAnalysisMs = 0;
  private analysisWindowMs = 300_000; // 5 minutes

  constructor(thresholds?: Partial<AnomalyThresholds>) {
    super('sentinel', 'Sentinel Security Agent', {
      handleMessages: false,
      handleEvents: true,
      handleSchedule: true,
    });
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  async onSchedule(ctx: ScheduleContext): Promise<void> {
    const auditLog = ctx.auditLog;
    if (!auditLog) return;

    const now = Date.now();
    const windowMs = now - this.lastAnalysisMs > 0
      ? Math.min(now - this.lastAnalysisMs, this.analysisWindowMs)
      : this.analysisWindowMs;

    // 1. Get summary of events since last analysis
    const summary = auditLog.getSummary(windowMs);
    this.lastAnalysisMs = now;

    if (summary.totalEvents === 0) return;

    // 2. Detect anomalies using heuristic rules
    const anomalies = this.detectAnomalies(summary, auditLog);

    // 3. If LLM available and anomalies found, do deeper analysis
    if (ctx.llm && anomalies.length > 0) {
      try {
        const analysis = await ctx.llm.chat([
          { role: 'system', content: SENTINEL_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ summary, anomalies }) },
        ]);
        // Parse LLM response — findings are informational
        try {
          const parsed = JSON.parse(analysis.content);
          if (parsed.findings && Array.isArray(parsed.findings)) {
            for (const finding of parsed.findings) {
              auditLog.record({
                type: 'anomaly_detected',
                severity: finding.severity === 'critical' ? 'critical' : 'warn',
                agentId: 'sentinel',
                details: {
                  source: 'llm_analysis',
                  description: finding.description,
                  recommendation: finding.recommendation,
                },
              });
            }
          }
        } catch {
          // LLM response wasn't valid JSON — log but don't fail
        }
      } catch {
        // LLM call failed — heuristic analysis still recorded
      }
    }

    // 4. Record heuristic findings in audit log
    for (const anomaly of anomalies) {
      auditLog.record({
        type: 'anomaly_detected',
        severity: anomaly.severity,
        agentId: anomaly.agentId ?? 'sentinel',
        details: {
          source: 'heuristic',
          anomalyType: anomaly.type,
          description: anomaly.description,
          evidence: anomaly.evidence,
        },
      });
    }
  }

  async onEvent(event: AgentEvent, _ctx: AgentContext): Promise<void> {
    // Real-time: respond to critical security events
    if (event.type === 'guardian.critical') {
      // For now, just acknowledge receipt. Future: could disable agents,
      // alert user channels, or trigger automated responses.
    }
  }

  /** Detect anomalies in an audit summary using heuristic rules. */
  detectAnomalies(summary: AuditSummary, auditLog?: AuditLog): Anomaly[] {
    const anomalies: Anomaly[] = [];

    // Rule 1: Volume spike — high denial rate
    const denialCount = (summary.byType['action_denied'] ?? 0)
      + (summary.byType['rate_limited'] ?? 0)
      + (summary.byType['event_blocked'] ?? 0);

    if (denialCount > this.thresholds.volumeSpikeMultiplier * 10) {
      anomalies.push({
        type: 'volume_spike',
        severity: denialCount > this.thresholds.volumeSpikeMultiplier * 30 ? 'critical' : 'warn',
        description: `High denial rate: ${denialCount} denials in analysis window`,
        evidence: { denialCount, byType: summary.byType },
      });
    }

    // Rule 2: Capability probing — agent trying many different denied actions
    if (auditLog) {
      const windowStart = summary.windowStart;
      const deniedEvents = auditLog.query({ type: 'action_denied', after: windowStart });

      // Group by agent, count distinct action types
      const agentActionTypes = new Map<string, Set<string>>();
      for (const event of deniedEvents) {
        const actionType = event.details['actionType'] as string | undefined;
        if (!actionType) continue;
        const existing = agentActionTypes.get(event.agentId) ?? new Set();
        existing.add(actionType);
        agentActionTypes.set(event.agentId, existing);
      }

      for (const [agentId, types] of agentActionTypes) {
        if (types.size >= this.thresholds.capabilityProbeThreshold) {
          anomalies.push({
            type: 'capability_probe',
            severity: 'critical',
            description: `Agent '${agentId}' probing ${types.size} different action types`,
            agentId,
            evidence: { actionTypes: [...types], count: types.size },
          });
        }
      }
    }

    // Rule 3: Repeated secret detections from same agent
    // Query all secret-related event types
    if (auditLog) {
      const secretTypes: Array<'secret_detected' | 'output_redacted' | 'output_blocked' | 'event_blocked'> =
        ['secret_detected', 'output_redacted', 'output_blocked', 'event_blocked'];
      const agentSecretCounts = new Map<string, number>();
      for (const eventType of secretTypes) {
        const events = auditLog.query({ type: eventType, after: summary.windowStart });
        for (const event of events) {
          agentSecretCounts.set(event.agentId, (agentSecretCounts.get(event.agentId) ?? 0) + 1);
        }
      }

      for (const [agentId, count] of agentSecretCounts) {
        if (count >= this.thresholds.secretDetectionThreshold) {
          anomalies.push({
            type: 'repeated_secret_detection',
            severity: 'critical',
            description: `Agent '${agentId}' triggered secret scanner ${count} times`,
            agentId,
            evidence: { secretCount: count },
          });
        }
      }
    }

    // Rule 4: High error correlation
    const errorCount = summary.byType['agent_error'] ?? 0;
    if (errorCount > 10) {
      anomalies.push({
        type: 'error_storm',
        severity: 'warn',
        description: `${errorCount} agent errors in analysis window`,
        evidence: { errorCount },
      });
    }

    // Rule 5: Critical severity events
    if (summary.bySeverity.critical > 0) {
      anomalies.push({
        type: 'critical_events',
        severity: 'critical',
        description: `${summary.bySeverity.critical} critical severity events detected`,
        evidence: { criticalCount: summary.bySeverity.critical },
      });
    }

    return anomalies;
  }
}
