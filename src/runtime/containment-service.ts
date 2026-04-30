import type { ToolCategory } from '../tools/types.js';
import type { AssistantSecurityAutoContainmentConfig } from '../config/types.js';
import type { UnifiedSecurityAlert } from './security-alerts.js';
import type { DeploymentProfile, SecurityOperatingMode } from './security-controls.js';
import type { SecurityPostureAssessment } from './security-posture.js';
import { BrowserSessionBroker } from './browser-session-broker.js';

export type ContainmentActionType =
  | 'advise_mode_change'
  | 'auto_escalated_guarded'
  | 'restrict_browser_mutation'
  | 'pause_scheduled_mutations'
  | 'restrict_outbound_mutation'
  | 'restrict_command_execution'
  | 'restrict_network_egress'
  | 'restrict_mcp_tooling'
  | 'freeze_mutating_tools'
  | 'ir_assist_read_only';

export interface ContainmentAction {
  type: ContainmentActionType;
  title: string;
  reason: string;
  restrictedActions: string[];
  recovery: string;
}

export interface SecurityContainmentState {
  profile: DeploymentProfile;
  currentMode: SecurityOperatingMode;
  effectiveMode: SecurityOperatingMode;
  recommendedMode: SecurityOperatingMode;
  autoElevated: boolean;
  shouldEscalate: boolean;
  activeAlertCount: number;
  activeActions: ContainmentAction[];
}

export interface SecurityContainmentDecisionInput {
  profile: DeploymentProfile;
  currentMode: SecurityOperatingMode;
  posture: SecurityPostureAssessment;
  alerts: UnifiedSecurityAlert[];
  assistantAutoContainment?: AssistantSecurityAutoContainmentConfig;
}

export interface SecurityContainmentActionInput extends SecurityContainmentDecisionInput {
  action: {
    type: string;
    toolName: string;
    category?: ToolCategory;
    scheduled?: boolean;
    origin?: 'assistant' | 'cli' | 'web';
  };
}

export interface SecurityContainmentActionDecision {
  allowed: boolean;
  reason?: string;
  matchedAction?: ContainmentActionType;
  state: SecurityContainmentState;
}

const IR_ASSIST_ALLOWED_TOOLS = new Set([
  'host_monitor_check',
  'gateway_firewall_check',
  'security_alert_ack',
  'security_alert_resolve',
  'security_alert_suppress',
  'net_ping',
  'net_arp_scan',
  'net_port_check',
  'net_connections',
  'net_dns_lookup',
  'net_traceroute',
  'net_oui_lookup',
  'net_classify',
  'net_banner_grab',
  'net_fingerprint',
  'net_wifi_scan',
  'net_wifi_clients',
  'net_connection_profiles',
  'net_baseline',
  'net_anomaly_check',
  'net_threat_summary',
  'net_traffic_baseline',
  'net_threat_check',
]);

const LOCKDOWN_ALLOWED_TOOLS = new Set([
  'host_monitor_check',
  'gateway_firewall_check',
  'security_alert_ack',
  'security_alert_resolve',
  'security_alert_suppress',
]);

const OUTBOUND_MUTATION_ACTIONS = new Set([
  'send_email',
  'draft_email',
  'write_calendar',
  'write_drive',
  'write_docs',
  'write_sheets',
  'http_request',
]);

const FULL_LOCKDOWN_ACTIONS = new Set([
  'write_file',
  'execute_command',
  'http_request',
  'network_probe',
  'mcp_tool',
  'send_email',
  'draft_email',
  'write_calendar',
  'write_drive',
  'write_docs',
  'write_sheets',
]);

export class ContainmentService {
  private readonly browserBroker: BrowserSessionBroker;

  constructor(deps?: { browserBroker?: BrowserSessionBroker }) {
    this.browserBroker = deps?.browserBroker ?? new BrowserSessionBroker();
  }

  getState(input: SecurityContainmentDecisionInput): SecurityContainmentState {
    const activeAlerts = input.alerts.filter((alert) => alert.status === 'active');
    const assistantMatches = findAssistantAutoContainmentMatches(activeAlerts, input.assistantAutoContainment);
    const autoElevated = shouldAutoElevateGuarded(input.currentMode, input.posture, activeAlerts)
      || shouldAutoElevateFromAssistantFindings(input.currentMode, input.posture, assistantMatches);
    const effectiveMode = autoElevated ? 'guarded' : input.currentMode;
    const actions: ContainmentAction[] = [];
    const matchedCategories = new Set(assistantMatches.map((match) => match.category));

    if (input.posture.shouldEscalate) {
      actions.push(containmentAction(
        'advise_mode_change',
        'Escalation advised',
        `Posture recommends moving from '${input.currentMode}' to '${input.posture.recommendedMode}'.`,
        ['No direct tool restriction; this is operator guidance.'],
        'Review the active alerts and either raise the configured security mode or resolve/suppress alerts that no longer apply.',
      ));
    }
    if (autoElevated) {
      actions.push(containmentAction(
        'auto_escalated_guarded',
        'Temporary guarded controls active',
        assistantMatches.length > 0
          ? 'High-confidence Assistant Security findings matched the configured containment thresholds, so Guardian temporarily elevated to guarded controls.'
          : 'Multiple elevated alerts triggered a conservative temporary guarded posture while monitor mode is still configured.',
        ['Guarded-mode browser, scheduled mutation, and high-risk outbound actions.'],
        'Acknowledge, resolve, or suppress the matching elevated alerts after review, or deliberately raise the configured mode to guarded.',
      ));
    }

    if (effectiveMode === 'guarded') {
      actions.push(containmentAction(
        'restrict_browser_mutation',
        'Browser session mutation restricted',
        'High-risk browser actions are blocked in guarded mode to reduce session theft and prompt-injection fallout.',
        ['Browser actions that mutate authenticated session state or execute page code.'],
        'Use read-only browser inspection, clear the triggering alerts, or lower the effective mode only after the session risk is understood.',
      ));
      actions.push(containmentAction(
        'pause_scheduled_mutations',
        'Scheduled risky mutations paused',
        'Scheduled mutating browser, shell, and outbound actions are blocked in guarded mode.',
        ['Scheduled browser mutations, shell commands, outbound sends, and arbitrary HTTP mutations.'],
        'Run a reviewed manual action instead, or clear the alert pressure that caused guarded controls before re-enabling scheduled mutation.',
      ));
      if (matchedCategories.has('mcp')) {
        actions.push(containmentAction(
          'restrict_mcp_tooling',
          'MCP tooling temporarily restricted',
          'High-confidence Assistant Security MCP findings matched the configured containment thresholds, so MCP tool calls are temporarily blocked.',
          ['Third-party MCP tool calls.'],
          'Review the MCP server trust, environment, and network exposure, then resolve or suppress the Assistant Security findings if the setup is intentional.',
        ));
      }
      if (matchedCategories.has('sandbox') || matchedCategories.has('trust_boundary')) {
        actions.push(containmentAction(
          'restrict_command_execution',
          'Command execution temporarily restricted',
          'High-confidence Assistant Security boundary findings matched the configured containment thresholds, so direct command execution is temporarily blocked.',
          ['Shell and direct command execution.'],
          'Move work to a stronger sandbox or resolve the boundary finding before allowing command execution again.',
        ));
      }
    }

    if (effectiveMode === 'lockdown') {
      actions.push(
        containmentAction(
          'freeze_mutating_tools',
          'Mutating tools frozen',
          'Lockdown mode blocks non-essential mutation paths until the operator lowers the control level.',
          ['Filesystem writes, external sends, cloud writes, policy changes, and other non-essential mutations.'],
          'Complete incident review, preserve evidence, and lower the configured mode only when mutation is safe again.',
        ),
        containmentAction(
          'restrict_network_egress',
          'Network egress restricted',
          'Lockdown mode blocks outbound HTTP, network probes, and browser automation except for approved local security checks.',
          ['Outbound HTTP, browser automation, network probes, and external connector sends.'],
          'Use local security checks first, then lower the configured mode after confirming egress is safe.',
        ),
        containmentAction(
          'restrict_command_execution',
          'Command execution restricted',
          'Shell and similar command execution paths are disabled in lockdown mode.',
          ['Shell commands and subprocess-backed tools.'],
          'Use built-in read-only security tools or a separate incident-response shell outside Guardian until lockdown is cleared.',
        ),
      );
    }

    if (effectiveMode === 'ir_assist') {
      actions.push(
        containmentAction(
          'ir_assist_read_only',
          'Investigation mode active',
          'IR Assist favors read-heavy investigation and denies non-essential mutation and outbound send actions.',
          ['Non-essential mutation, outbound sends, and broad automation changes.'],
          'Gather evidence with approved investigation tools, then resolve the active incident signals before returning to normal operation.',
        ),
        containmentAction(
          'restrict_browser_mutation',
          'Browser session mutation restricted',
          'Browser session mutation and persistence tools stay disabled during investigation mode.',
          ['Browser session mutation, persistence, and script execution tools.'],
          'Use read-only browser inspection or collect evidence outside authenticated browser sessions until investigation mode ends.',
        ),
        containmentAction(
          'restrict_outbound_mutation',
          'Outbound mutation restricted',
          'Email, cloud writes, and arbitrary HTTP mutation stay blocked in IR Assist mode.',
          ['Email sends, cloud writes, connector mutations, and arbitrary HTTP mutation.'],
          'Keep outbound changes manual and reviewed until the investigation mode recommendation clears.',
        ),
      );
    }

    return {
      profile: input.profile,
      currentMode: input.currentMode,
      effectiveMode,
      recommendedMode: input.posture.recommendedMode,
      autoElevated,
      shouldEscalate: input.posture.shouldEscalate,
      activeAlertCount: activeAlerts.length,
      activeActions: actions,
    };
  }

  shouldAllowAction(input: SecurityContainmentActionInput): SecurityContainmentActionDecision {
    const state = this.getState(input);
    const { action } = input;
    const assistantMatches = findAssistantAutoContainmentMatches(
      input.alerts.filter((alert) => alert.status === 'active'),
      input.assistantAutoContainment,
    );
    const matchedCategories = new Set(assistantMatches.map((match) => match.category));

    if (isAlwaysAllowedSecurityControlTool(action.toolName)) {
      return { allowed: true, state };
    }

    const browserDecision = this.browserBroker.decide({
      toolName: action.toolName,
      currentMode: state.effectiveMode,
      scheduled: action.scheduled,
    });
    if (!browserDecision.allowed) {
      return {
        allowed: false,
        reason: browserDecision.reason,
        matchedAction: browserDecision.policy === 'browser_scheduled_mutation'
          ? 'pause_scheduled_mutations'
          : 'restrict_browser_mutation',
        state,
      };
    }

    if (state.effectiveMode === 'guarded') {
      if (action.type === 'mcp_tool' && matchedCategories.has('mcp')) {
        return {
          allowed: false,
          reason: `Blocked by containment: '${action.toolName}' is temporarily disabled because Assistant Security flagged MCP exposure that met the auto-containment threshold.`,
          matchedAction: 'restrict_mcp_tooling',
          state,
        };
      }
      if (action.type === 'execute_command' && (matchedCategories.has('sandbox') || matchedCategories.has('trust_boundary'))) {
        return {
          allowed: false,
          reason: `Blocked by containment: '${action.toolName}' is temporarily disabled because Assistant Security flagged a high-confidence sandbox or trust-boundary issue.`,
          matchedAction: 'restrict_command_execution',
          state,
        };
      }
      if (action.scheduled && isGuardedScheduledRisk(action)) {
        return {
          allowed: false,
          reason: `Blocked by containment: scheduled '${action.toolName}' is paused while guarded controls are active.`,
          matchedAction: 'pause_scheduled_mutations',
          state,
        };
      }
      return { allowed: true, state };
    }

    if (state.effectiveMode === 'lockdown') {
      if (LOCKDOWN_ALLOWED_TOOLS.has(action.toolName)) {
        return { allowed: true, state };
      }
      if (FULL_LOCKDOWN_ACTIONS.has(action.type)) {
        return {
          allowed: false,
          reason: `Blocked by containment: '${action.toolName}' is disabled in lockdown mode.`,
          matchedAction: action.type === 'execute_command'
            ? 'restrict_command_execution'
            : action.type === 'http_request' || action.type === 'network_probe' || action.type === 'mcp_tool'
              ? 'restrict_network_egress'
              : 'freeze_mutating_tools',
          state,
        };
      }
      return { allowed: true, state };
    }

    if (state.effectiveMode === 'ir_assist') {
      if (IR_ASSIST_ALLOWED_TOOLS.has(action.toolName)) {
        return { allowed: true, state };
      }
      if (action.type === 'execute_command') {
        return {
          allowed: false,
          reason: `Blocked by containment: '${action.toolName}' is disabled in IR Assist mode to preserve investigation safety.`,
          matchedAction: 'ir_assist_read_only',
          state,
        };
      }
      if (OUTBOUND_MUTATION_ACTIONS.has(action.type) || action.type === 'write_file' || action.type === 'mcp_tool') {
        return {
          allowed: false,
          reason: `Blocked by containment: '${action.toolName}' is disabled in IR Assist mode unless it is an approved investigation tool.`,
          matchedAction: action.type === 'mcp_tool' ? 'restrict_browser_mutation' : 'restrict_outbound_mutation',
          state,
        };
      }
    }

    return { allowed: true, state };
  }
}

function isAlwaysAllowedSecurityControlTool(toolName: string): boolean {
  return toolName === 'security_alert_ack'
    || toolName === 'security_alert_resolve'
    || toolName === 'security_alert_suppress';
}

function containmentAction(
  type: ContainmentActionType,
  title: string,
  reason: string,
  restrictedActions: string[],
  recovery: string,
): ContainmentAction {
  return { type, title, reason, restrictedActions, recovery };
}

function shouldAutoElevateGuarded(
  currentMode: SecurityOperatingMode,
  posture: SecurityPostureAssessment,
  activeAlerts: UnifiedSecurityAlert[],
): boolean {
  if (currentMode !== 'monitor' || posture.recommendedMode !== 'guarded') return false;
  const highAlerts = activeAlerts.filter((alert) => alert.severity === 'high');
  const multiSource = new Set(activeAlerts.map((alert) => alert.source)).size >= 2;
  return highAlerts.length >= 2 || (highAlerts.length >= 1 && multiSource);
}

function shouldAutoElevateFromAssistantFindings(
  currentMode: SecurityOperatingMode,
  posture: SecurityPostureAssessment,
  matches: AssistantAutoContainmentMatch[],
): boolean {
  if (currentMode !== 'monitor' || posture.recommendedMode === 'monitor' || matches.length === 0) return false;
  if (matches.some((match) => match.severity === 'critical')) return true;
  return matches.length >= 2;
}

interface AssistantAutoContainmentMatch {
  alertId: string;
  category: NonNullable<AssistantSecurityAutoContainmentConfig['categories']>[number];
  severity: UnifiedSecurityAlert['severity'];
  confidence: number;
}

function findAssistantAutoContainmentMatches(
  activeAlerts: UnifiedSecurityAlert[],
  config?: AssistantSecurityAutoContainmentConfig,
): AssistantAutoContainmentMatch[] {
  if (!config || config.enabled === false) return [];
  const allowedCategories = new Set(config.categories ?? []);
  return activeAlerts
    .filter((alert) => alert.source === 'assistant')
    .map((alert) => {
      const evidence = (alert.evidence ?? {}) as Record<string, unknown>;
      const category = typeof evidence.category === 'string'
        ? evidence.category as AssistantAutoContainmentMatch['category']
        : null;
      const confidence = typeof evidence.confidence === 'number' ? evidence.confidence : Number.NaN;
      return {
        alertId: alert.id,
        category,
        severity: alert.severity,
        confidence,
      };
    })
    .filter((match): match is AssistantAutoContainmentMatch => {
      if (!match.category || !allowedCategories.has(match.category)) return false;
      if (!Number.isFinite(match.confidence) || match.confidence < config.minConfidence) return false;
      return severityAtLeast(match.severity, config.minSeverity);
    });
}

function severityAtLeast(
  actual: UnifiedSecurityAlert['severity'],
  minimum: NonNullable<AssistantSecurityAutoContainmentConfig['minSeverity']>,
): boolean {
  return severityRank(actual) >= severityRank(minimum);
}

function severityRank(severity: UnifiedSecurityAlert['severity']): number {
  switch (severity) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    default: return 1;
  }
}

function isGuardedScheduledRisk(action: SecurityContainmentActionInput['action']): boolean {
  if (!action.scheduled) return false;
  if (action.type === 'execute_command' || action.type === 'http_request') return true;
  if (action.type === 'send_email' || action.type === 'draft_email') return true;
  return action.type === 'mcp_tool';
}
