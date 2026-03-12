import type {
  AutomationArtifactPersistenceMode,
  AutomationOutputHandlingConfig,
  AutomationOutputRoutingMode,
} from '../config/types.js';
import type { AuditEvent, AuditLog, AuditSeverity } from '../guardian/audit-log.js';

export interface AutomationStepOutput {
  stepId?: string;
  toolName: string;
  status?: string;
  message?: string;
  output?: unknown;
}

export interface AutomationPromotionInput {
  automationId: string;
  automationName: string;
  runId: string;
  status: string;
  message?: string;
  steps?: AutomationStepOutput[];
  outputHandling?: AutomationOutputHandlingConfig | null;
  origin?: string;
  channel?: string;
  userId?: string;
  agentId?: string;
  emittedEvent?: string;
  target?: string;
  taskId?: string;
  runLink?: string;
}

export interface AutomationPromotedFindingRef {
  auditEventId: string;
  severity: AuditSeverity;
  title: string;
  description: string;
  stepId?: string;
  notify: boolean;
  sendToSecurity: boolean;
  runLink: string;
}

interface AutomationFinding {
  severity: AuditSeverity;
  title: string;
  description: string;
  stepId?: string;
  toolName?: string;
}

export function normalizeAutomationOutputHandling(
  input?: AutomationOutputHandlingConfig | null,
): AutomationOutputHandlingConfig {
  return {
    notify: normalizeRoutingMode(input?.notify),
    sendToSecurity: normalizeRoutingMode(input?.sendToSecurity),
    persistArtifacts: normalizeArtifactPersistence(input?.persistArtifacts),
  };
}

export function promoteAutomationFindings(
  auditLog: AuditLog,
  input: AutomationPromotionInput,
): AutomationPromotedFindingRef[] {
  const outputHandling = normalizeAutomationOutputHandling(input.outputHandling);
  if (outputHandling.notify === 'off' && outputHandling.sendToSecurity === 'off') {
    return [];
  }

  const findings = deriveAutomationFindings({
    status: input.status,
    message: input.message,
    emittedEvent: input.emittedEvent,
    steps: input.steps ?? [],
  });
  const runLink = input.runLink || `#/automations?runId=${encodeURIComponent(input.runId)}`;
  const promoted: AutomationPromotedFindingRef[] = [];

  for (const finding of findings) {
    const notify = routingMatches(outputHandling.notify, finding.severity);
    const sendToSecurity = routingMatches(outputHandling.sendToSecurity, finding.severity);
    if (!notify && !sendToSecurity) continue;

    const event = auditLog.record({
      type: 'automation_finding',
      severity: finding.severity,
      agentId: input.agentId || `automation:${input.automationId}`,
      userId: input.userId,
      channel: input.channel,
      controller: 'AutomationOutputRouter',
      details: {
        source: 'automation',
        automationId: input.automationId,
        automationName: input.automationName,
        runId: input.runId,
        status: input.status,
        target: input.target,
        taskId: input.taskId,
        origin: input.origin,
        emittedEvent: input.emittedEvent,
        stepId: finding.stepId,
        toolName: finding.toolName,
        title: finding.title,
        description: finding.description,
        runLink,
        automationDisposition: {
          notify,
          sendToSecurity,
        },
      },
    });

    promoted.push({
      auditEventId: event.id,
      severity: finding.severity,
      title: finding.title,
      description: finding.description,
      stepId: finding.stepId,
      notify,
      sendToSecurity,
      runLink,
    });
  }

  return promoted;
}

export function deriveAutomationFindings(input: {
  status: string;
  message?: string;
  emittedEvent?: string;
  steps: AutomationStepOutput[];
}): AutomationFinding[] {
  const findings: AutomationFinding[] = [];
  const normalizedStatus = String(input.status || '').toLowerCase();
  const failedSteps = input.steps.filter((step) => String(step.status || '').toLowerCase() === 'failed');
  const pendingSteps = input.steps.filter((step) => String(step.status || '').toLowerCase() === 'pending_approval');

  for (const step of failedSteps) {
    findings.push({
      severity: maxSeverity(
        'warn',
        inferSeverity(step.message),
        inferOutputSeverity(step.output),
      ),
      title: `Automation step failed: ${step.toolName}`,
      description: step.message?.trim() || 'The step failed without additional detail.',
      stepId: step.stepId,
      toolName: step.toolName,
    });
  }

  if (findings.length === 0 && normalizedStatus === 'failed') {
    findings.push({
      severity: maxSeverity('warn', inferSeverity(input.message)),
      title: 'Automation run failed',
      description: input.message?.trim() || 'The automation failed without additional detail.',
    });
  }

  if (findings.length === 0 && pendingSteps.length > 0) {
    findings.push({
      severity: 'info',
      title: 'Automation awaiting approval',
      description: input.message?.trim() || 'The automation paused for approval.',
      stepId: pendingSteps[0]?.stepId,
      toolName: pendingSteps[0]?.toolName,
    });
  }

  if (findings.length === 0) {
    const completionDetail = input.emittedEvent
      ? `Completed successfully and emitted '${input.emittedEvent}'.`
      : (input.message?.trim() || 'Completed successfully.');
    findings.push({
      severity: 'info',
      title: 'Automation completed',
      description: completionDetail,
    });
  }

  return findings;
}

function routingMatches(mode: AutomationOutputRoutingMode, severity: AuditSeverity): boolean {
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return severity === 'warn' || severity === 'critical';
}

function normalizeRoutingMode(mode?: AutomationOutputRoutingMode | null): AutomationOutputRoutingMode {
  return mode === 'warn_critical' || mode === 'all' ? mode : 'off';
}

function normalizeArtifactPersistence(
  mode?: AutomationArtifactPersistenceMode | null,
): AutomationArtifactPersistenceMode {
  return mode === 'run_history_plus_memory' ? mode : 'run_history_only';
}

function inferSeverity(value: unknown): AuditSeverity {
  const text = String(value || '').toLowerCase();
  if (!text) return 'info';
  if (/\b(critical|ransomware|malware|exploit|exfiltration|breach)\b/.test(text)) return 'critical';
  if (/\b(failed|error|warn|warning|denied|blocked|anomaly|drift|suspicious|threat)\b/.test(text)) return 'warn';
  return 'info';
}

function inferOutputSeverity(output: unknown): AuditSeverity {
  if (!output || typeof output !== 'object') return 'info';
  if (Array.isArray(output)) {
    return output.reduce<AuditSeverity>((max, item) => maxSeverity(max, inferOutputSeverity(item)), 'info');
  }
  const record = output as Record<string, unknown>;
  const candidate = record.severity ?? record.level ?? record.status;
  if (typeof candidate === 'string') {
    const normalized = candidate.toLowerCase();
    if (normalized === 'critical' || normalized === 'high') return 'critical';
    if (normalized === 'warn' || normalized === 'warning' || normalized === 'medium' || normalized === 'failed') return 'warn';
  }
  return 'info';
}

function maxSeverity(...severities: AuditSeverity[]): AuditSeverity {
  let max: AuditSeverity = 'info';
  for (const severity of severities) {
    if (severity === 'critical') return 'critical';
    if (severity === 'warn') max = 'warn';
  }
  return max;
}

export type { AuditSeverity };
export type { AuditEvent };
