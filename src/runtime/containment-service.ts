import type { ToolCategory } from '../tools/types.js';
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
  | 'freeze_mutating_tools'
  | 'ir_assist_read_only';

export interface ContainmentAction {
  type: ContainmentActionType;
  title: string;
  reason: string;
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
    const autoElevated = shouldAutoElevateGuarded(input.currentMode, input.posture, activeAlerts);
    const effectiveMode = autoElevated ? 'guarded' : input.currentMode;
    const actions: ContainmentAction[] = [];

    if (input.posture.shouldEscalate) {
      actions.push({
        type: 'advise_mode_change',
        title: 'Escalation advised',
        reason: `Posture recommends moving from '${input.currentMode}' to '${input.posture.recommendedMode}'.`,
      });
    }
    if (autoElevated) {
      actions.push({
        type: 'auto_escalated_guarded',
        title: 'Temporary guarded controls active',
        reason: 'Multiple elevated alerts triggered a conservative temporary guarded posture while monitor mode is still configured.',
      });
    }

    if (effectiveMode === 'guarded') {
      actions.push({
        type: 'restrict_browser_mutation',
        title: 'Browser session mutation restricted',
        reason: 'High-risk browser actions are blocked in guarded mode to reduce session theft and prompt-injection fallout.',
      });
      actions.push({
        type: 'pause_scheduled_mutations',
        title: 'Scheduled risky mutations paused',
        reason: 'Scheduled mutating browser, shell, and outbound actions are blocked in guarded mode.',
      });
    }

    if (effectiveMode === 'lockdown') {
      actions.push(
        {
          type: 'freeze_mutating_tools',
          title: 'Mutating tools frozen',
          reason: 'Lockdown mode blocks non-essential mutation paths until the operator lowers the control level.',
        },
        {
          type: 'restrict_network_egress',
          title: 'Network egress restricted',
          reason: 'Lockdown mode blocks outbound HTTP, network probes, and browser automation except for approved local security checks.',
        },
        {
          type: 'restrict_command_execution',
          title: 'Command execution restricted',
          reason: 'Shell and similar command execution paths are disabled in lockdown mode.',
        },
      );
    }

    if (effectiveMode === 'ir_assist') {
      actions.push(
        {
          type: 'ir_assist_read_only',
          title: 'Investigation mode active',
          reason: 'IR Assist favors read-heavy investigation and denies non-essential mutation and outbound send actions.',
        },
        {
          type: 'restrict_browser_mutation',
          title: 'Browser session mutation restricted',
          reason: 'Browser session mutation and persistence tools stay disabled during investigation mode.',
        },
        {
          type: 'restrict_outbound_mutation',
          title: 'Outbound mutation restricted',
          reason: 'Email, cloud writes, and arbitrary HTTP mutation stay blocked in IR Assist mode.',
        },
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

function isGuardedScheduledRisk(action: SecurityContainmentActionInput['action']): boolean {
  if (!action.scheduled) return false;
  if (action.type === 'execute_command' || action.type === 'http_request') return true;
  if (action.type === 'send_email' || action.type === 'draft_email') return true;
  return action.type === 'mcp_tool';
}
