/**
 * Guardian Agent — inline LLM-powered action evaluation (the namesake feature).
 * Sentinel — retrospective audit analysis of action patterns.
 *
 * Two services in one module:
 *
 * 1. **GuardianAgentService** (inline blocking) — evaluates tool actions before
 *    execution via LLM, can deny risky or malicious actions in real-time.
 *    This is the "Guardian Agent" the project is named after.
 *
 * 2. **Sentinel audit** — retrospective analysis of audit log patterns,
 *    runnable on-demand or via cron schedule. Detects anomalies across
 *    multiple events over time.
 *
 * LLM provider modes:
 * - `local`    — use local Ollama for low-latency inline checks
 * - `external` — use external provider (OpenAI/Anthropic) for better judgment
 * - `auto`     — try local first, fall back to external (default)
 */

import type { LLMProvider, ChatMessage } from '../llm/types.js';
import type { AuditLog, AuditSummary } from '../guardian/audit-log.js';
import { createLogger } from '../util/logging.js';
import { recoverStructuredObjectWithRepair } from './structured-output-recovery.js';

const log = createLogger('guardian-agent');

// ─── Types ───────────────────────────────────────────────────────────

export interface GuardianAgentServiceConfig {
  /** Enable inline blocking (default: true). */
  enabled: boolean;
  /** LLM provider mode for inline evaluation. */
  llmProvider: 'local' | 'external' | 'auto';
  /** Action types that trigger inline LLM evaluation. Read-only actions skip by default. */
  actionTypes: string[];
  /** Fail-open (allow action) when LLM is unavailable (default: true). */
  failOpen: boolean;
  /** Timeout for inline LLM evaluation in ms (default: 8000). */
  timeoutMs: number;
}

export interface SentinelAuditConfig {
  /** Enable sentinel audit (default: true). */
  enabled: boolean;
  /** Timeout for optional LLM audit analysis in ms (default: 30000). */
  timeoutMs: number;
  /** Anomaly detection thresholds. */
  anomalyThresholds: AnomalyThresholds;
}

export interface AnomalyThresholds {
  volumeSpikeMultiplier: number;
  capabilityProbeThreshold: number;
  secretDetectionThreshold: number;
}

export interface GuardianAgentEvaluation {
  allowed: boolean;
  reason?: string;
  riskLevel: 'safe' | 'low' | 'medium' | 'high' | 'critical';
}

export interface Anomaly {
  type: string;
  severity: 'warn' | 'critical';
  description: string;
  agentId?: string;
  evidence: Record<string, unknown>;
}

export interface AuditFinding {
  severity: 'warn' | 'critical';
  description: string;
  recommendation: string;
}

export interface AuditResult {
  anomalies: Anomaly[];
  llmFindings: AuditFinding[];
  timestamp: number;
  windowMs: number;
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_GUARDIAN_CONFIG: GuardianAgentServiceConfig = {
  enabled: true,
  llmProvider: 'auto',
  actionTypes: [
    'execute_command',
    'write_file',
    'http_request',
    'network_probe',
    'send_email',
    'draft_email',
    'write_calendar',
    'write_drive',
    'write_docs',
    'write_sheets',
    'mcp_tool',
  ],
  failOpen: false,
  timeoutMs: 8_000,
};

const DEFAULT_SENTINEL_CONFIG: SentinelAuditConfig = {
  enabled: true,
  timeoutMs: 30_000,
  anomalyThresholds: {
    volumeSpikeMultiplier: 3,
    capabilityProbeThreshold: 5,
    secretDetectionThreshold: 3,
  },
};

const GUARDIAN_AGENT_SYSTEM_PROMPT = [
  'You are Guardian Agent, an inline security evaluator.',
  'You receive a tool action that is about to execute. Evaluate whether it is safe.',
  '',
  'Consider:',
  '- Could this action cause data loss or system damage?',
  '- Does it attempt privilege escalation or credential theft?',
  '- Does it access sensitive paths or exfiltrate data?',
  '- Is the action proportional to what a legitimate user would request?',
  '',
  'Respond with strict JSON only:',
  '{ "allowed": true/false, "riskLevel": "safe"|"low"|"medium"|"high"|"critical", "reason": "brief explanation" }',
  '',
  'Guidelines:',
  '- Default to allowing legitimate actions. Only block clearly dangerous ones.',
  '- "safe"/"low" = allow, "medium" = allow with note, "high"/"critical" = block.',
  '- Be concise. Do not explain your reasoning process, just the verdict.',
].join('\n');

const SENTINEL_AUDIT_SYSTEM_PROMPT = [
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
].join('\n');

// ─── Guardian Agent Service (Inline Blocking) ────────────────────

export class GuardianAgentService {
  private config: GuardianAgentServiceConfig;
  private actionTypeSet: Set<string>;

  /** Resolved LLM providers — set via setProviders(). */
  private localProvider?: LLMProvider;
  private externalProvider?: LLMProvider;

  constructor(config?: Partial<GuardianAgentServiceConfig>) {
    this.config = { ...DEFAULT_GUARDIAN_CONFIG, ...config };
    this.actionTypeSet = new Set(this.config.actionTypes);
  }

  // ─── Provider Management ────────────────────────────────────────

  /** Set available LLM providers. Call after runtime providers are initialized. */
  setProviders(local?: LLMProvider, external?: LLMProvider): void {
    this.localProvider = local;
    this.externalProvider = external;
    log.info({
      local: local?.name ?? 'none',
      external: external?.name ?? 'none',
      mode: this.config.llmProvider,
    }, 'Guardian Agent providers configured');
  }

  /** Resolve the LLM provider based on config mode. */
  private resolveProvider(): LLMProvider | undefined {
    switch (this.config.llmProvider) {
      case 'local':
        return this.localProvider;
      case 'external':
        return this.externalProvider;
      case 'auto':
        return this.localProvider ?? this.externalProvider;
    }
  }

  /** Update config at runtime (e.g. from web UI). */
  updateConfig(update: Partial<GuardianAgentServiceConfig>): void {
    if (update.enabled !== undefined) this.config.enabled = update.enabled;
    if (update.llmProvider) this.config.llmProvider = update.llmProvider;
    if (update.failOpen !== undefined) this.config.failOpen = update.failOpen;
    if (update.timeoutMs !== undefined) this.config.timeoutMs = update.timeoutMs;
    if (update.actionTypes) {
      this.config.actionTypes = update.actionTypes;
      this.actionTypeSet = new Set(update.actionTypes);
    }
  }

  getConfig(): Readonly<GuardianAgentServiceConfig> {
    return this.config;
  }

  // ─── Inline Evaluation ──────────────────────────────────────────

  /**
   * Evaluate a tool action before execution. Returns whether the action
   * should proceed. Called from the ToolExecutor pre-execution hook.
   */
  async evaluateAction(action: {
    type: string;
    toolName: string;
    params: Record<string, unknown>;
    agentId: string;
  }): Promise<GuardianAgentEvaluation> {
    // Skip if disabled or action type not in evaluation set
    if (!this.config.enabled || !this.actionTypeSet.has(action.type)) {
      return { allowed: true, riskLevel: 'safe' };
    }

    const provider = this.resolveProvider();
    if (!provider) {
      if (this.config.failOpen) {
        return { allowed: true, riskLevel: 'low', reason: 'No Guardian Agent LLM available (fail-open)' };
      }
      return { allowed: false, riskLevel: 'high', reason: 'No Guardian Agent LLM available (fail-closed)' };
    }

    const userContent = JSON.stringify({
      action: action.type,
      tool: action.toolName,
      agent: action.agentId,
      params: action.params,
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: GUARDIAN_AGENT_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ];

    try {
      const response = await Promise.race([
        provider.chat(messages, {
          maxTokens: 120,
          temperature: 0,
          responseFormat: { type: 'json_object' },
          tools: [],
        }),
        timeoutPromise(this.config.timeoutMs),
      ]);

      if (!response) {
        log.warn({ action: action.type, tool: action.toolName }, 'Guardian Agent evaluation timed out');
        return this.config.failOpen
          ? { allowed: true, riskLevel: 'low', reason: 'Guardian Agent evaluation timed out (fail-open)' }
          : { allowed: false, riskLevel: 'high', reason: 'Guardian Agent evaluation timed out (fail-closed)' };
      }

      return await this.parseEvaluation(provider, messages, response);
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : String(err) },
        'Guardian Agent inline evaluation failed');
      return this.config.failOpen
        ? { allowed: true, riskLevel: 'low', reason: 'Guardian Agent evaluation error (fail-open)' }
        : { allowed: false, riskLevel: 'high', reason: 'Guardian Agent evaluation error (fail-closed)' };
    }
  }

  private async parseEvaluation(
    provider: LLMProvider,
    messages: ChatMessage[],
    response: { content: string; model: string; finishReason: 'stop' | 'tool_calls' | 'length' | 'error' },
  ): Promise<GuardianAgentEvaluation> {
    const parsed = await recoverStructuredObjectWithRepair<{
      allowed?: boolean;
      riskLevel?: string;
      reason?: string;
    }>({
      response,
      repairChat: (repairMessages, options) => provider.chat(repairMessages, options),
      repairMessages: messages,
      repairSchemaDescription: '{ "allowed": true|false, "riskLevel": "safe"|"low"|"medium"|"high"|"critical", "reason": "brief explanation" }',
      repairMaxTokens: 120,
    });
    if (!parsed) {
      return { allowed: true, riskLevel: 'low', reason: 'Could not parse Guardian Agent response' };
    }

    const riskLevel = (['safe', 'low', 'medium', 'high', 'critical'] as const)
      .find(r => r === parsed.value.riskLevel) ?? 'low';

    // High/critical risk -> block regardless of what the LLM said for `allowed`
    const allowed = riskLevel === 'high' || riskLevel === 'critical'
      ? false
      : parsed.value.allowed !== false;

    return { allowed, riskLevel, reason: parsed.value.reason };
  }
}

// ─── Sentinel Audit Service (Retrospective) ─────────────────────

export class SentinelAuditService {
  private config: SentinelAuditConfig;
  private lastAuditMs = 0;

  /** LLM provider for audit analysis — shared with GuardianAgentService. */
  private provider?: LLMProvider;

  constructor(config?: Partial<SentinelAuditConfig>) {
    this.config = { ...DEFAULT_SENTINEL_CONFIG, ...config };
    if (typeof config?.timeoutMs !== 'number' || !Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
      this.config.timeoutMs = DEFAULT_SENTINEL_CONFIG.timeoutMs;
    }
    if (config?.anomalyThresholds) {
      this.config.anomalyThresholds = {
        ...DEFAULT_SENTINEL_CONFIG.anomalyThresholds,
        ...config.anomalyThresholds,
      };
    }
  }

  setProvider(provider?: LLMProvider): void {
    this.provider = provider;
  }

  getConfig(): Readonly<SentinelAuditConfig> {
    return this.config;
  }

  /**
   * Run retrospective audit analysis on the audit log.
   * Combines heuristic anomaly detection with optional LLM analysis.
   */
  async runAudit(auditLog: AuditLog, windowMs?: number): Promise<AuditResult> {
    const now = Date.now();
    const analysisWindowMs = windowMs
      ?? (this.lastAuditMs > 0 ? Math.min(now - this.lastAuditMs, 300_000) : 300_000);
    this.lastAuditMs = now;

    const summary = auditLog.getSummary(analysisWindowMs);
    if (summary.totalEvents === 0) {
      return { anomalies: [], llmFindings: [], timestamp: now, windowMs: analysisWindowMs };
    }

    // 1. Heuristic anomaly detection
    const anomalies = this.detectAnomalies(summary, auditLog);

    // 2. LLM-enhanced analysis (if provider available and anomalies found)
    let llmFindings: AuditFinding[] = [];
    if (this.provider && anomalies.length > 0) {
      llmFindings = await this.llmAuditAnalysis(this.provider, summary, anomalies);
    }

    // 3. Record findings to audit log
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
    for (const finding of llmFindings) {
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

    return { anomalies, llmFindings, timestamp: now, windowMs: analysisWindowMs };
  }

  private async llmAuditAnalysis(
    provider: LLMProvider,
    summary: AuditSummary,
    anomalies: Anomaly[],
  ): Promise<AuditFinding[]> {
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: SENTINEL_AUDIT_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ summary, anomalies }) },
      ];
      const controller = new AbortController();
      const response = await Promise.race([
        provider.chat(messages, {
          maxTokens: 220,
          temperature: 0,
          responseFormat: { type: 'json_object' },
          tools: [],
          signal: controller.signal,
        }),
        timeoutPromise(this.config.timeoutMs).then(() => {
          controller.abort(new Error(`Sentinel audit analysis timed out after ${this.config.timeoutMs}ms`));
          return undefined;
        }),
      ]);
      if (!response) {
        log.warn({ timeoutMs: this.config.timeoutMs }, 'Sentinel audit LLM analysis timed out');
        return [];
      }
      const parsed = await recoverStructuredObjectWithRepair<{ findings?: AuditFinding[] }>({
        response,
        repairChat: (repairMessages, options) => {
          const repairController = new AbortController();
          return Promise.race([
            provider.chat(repairMessages, {
              ...options,
              signal: options?.signal ?? repairController.signal,
            }),
            timeoutPromise(this.config.timeoutMs).then(() => {
              repairController.abort(new Error(`Sentinel audit repair timed out after ${this.config.timeoutMs}ms`));
              throw new Error(`Sentinel audit repair timed out after ${this.config.timeoutMs}ms`);
            }),
          ]);
        },
        repairMessages: messages,
        repairSchemaDescription: '{ "findings": [{ "severity": "warn"|"critical", "description": "...", "recommendation": "..." }] }',
        repairMaxTokens: 220,
      });
      if (parsed?.value.findings && Array.isArray(parsed.value.findings)) {
        return parsed.value.findings;
      }
    } catch {
      // LLM analysis failed — heuristic results still returned
    }
    return [];
  }

  detectAnomalies(summary: AuditSummary, auditLog?: AuditLog): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const thresholds = this.config.anomalyThresholds;

    // Rule 1: Volume spike — high denial rate
    const denialCount = (summary.byType['action_denied'] ?? 0)
      + (summary.byType['rate_limited'] ?? 0)
      + (summary.byType['event_blocked'] ?? 0);

    if (denialCount > thresholds.volumeSpikeMultiplier * 10) {
      anomalies.push({
        type: 'volume_spike',
        severity: denialCount > thresholds.volumeSpikeMultiplier * 30 ? 'critical' : 'warn',
        description: `High denial rate: ${denialCount} denials in analysis window`,
        evidence: { denialCount, byType: summary.byType },
      });
    }

    // Rule 2: Capability probing — agent trying many different denied actions
    if (auditLog) {
      const windowStart = summary.windowStart;
      const deniedEvents = auditLog.query({ type: 'action_denied', after: windowStart });

      const agentActionTypes = new Map<string, Set<string>>();
      for (const event of deniedEvents) {
        const actionType = event.details['actionType'] as string | undefined;
        if (!actionType) continue;
        const existing = agentActionTypes.get(event.agentId) ?? new Set();
        existing.add(actionType);
        agentActionTypes.set(event.agentId, existing);
      }

      for (const [agentId, types] of agentActionTypes) {
        if (types.size >= thresholds.capabilityProbeThreshold) {
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
        if (count >= thresholds.secretDetectionThreshold) {
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

    // Rule 6: Policy engine shadow mismatches — high mismatch rate may indicate
    // rules need adjustment before switching to enforce mode
    const mismatchCount = summary.byType['policy_shadow_mismatch'] ?? 0;
    if (mismatchCount > 10) {
      anomalies.push({
        type: 'policy_shadow_drift',
        severity: mismatchCount > 50 ? 'critical' : 'warn',
        description: `Policy engine shadow mode: ${mismatchCount} mismatches between legacy and policy decisions in analysis window`,
        evidence: { mismatchCount },
      });
    }

    // Rule 7: Policy mode changes — audit trail for mode transitions
    const modeChanges = summary.byType['policy_mode_changed'] ?? 0;
    if (modeChanges > 3) {
      anomalies.push({
        type: 'policy_mode_churn',
        severity: 'warn',
        description: `Policy engine mode changed ${modeChanges} times in analysis window — indicates instability`,
        evidence: { modeChanges },
      });
    }

    return anomalies;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function timeoutPromise(ms: number): Promise<undefined> {
  return new Promise(resolve => setTimeout(() => resolve(undefined), ms));
}
