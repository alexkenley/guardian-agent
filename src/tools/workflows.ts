/**
 * Pure tool decision logic — no side effects.
 *
 * Consolidates early-exit checks from runTool() and decide()
 * into testable pure functions.
 */

import type { ToolDefinition, ToolPolicyMode, ToolPolicySetting, ToolRisk } from './types.js';

/** All possible intent outcomes from tool run decision. */
export type ToolRunIntentKind =
  | 'allow'
  | 'deny'
  | 'require_approval'
  | 'disabled'
  | 'unknown_tool'
  | 'category_disabled';

export interface ToolRunIntent {
  kind: ToolRunIntentKind;
  reason: string;
}

export interface ToolDecisionInput {
  /** Whether tools are globally enabled. */
  enabled: boolean;
  /** Whether the tool's category is enabled. */
  categoryEnabled: boolean;
  /** The tool definition, or null if unknown. */
  definition: ToolDefinition | null;
  /** Current policy mode. */
  policyMode: ToolPolicyMode;
  /** Per-tool policy overrides. */
  toolPolicies: Record<string, ToolPolicySetting>;
}

/**
 * Determine what should happen when a tool run is requested.
 * Pure function — no side effects.
 */
export function decideToolRun(toolName: string, input: ToolDecisionInput): ToolRunIntent {
  if (!input.enabled) {
    return { kind: 'disabled', reason: 'Tools are disabled.' };
  }

  if (!input.definition) {
    return { kind: 'unknown_tool', reason: `Unknown tool '${toolName}'.` };
  }

  if (!input.categoryEnabled) {
    return {
      kind: 'category_disabled',
      reason: `Tool '${toolName}' is in disabled category '${input.definition.category}'.`,
    };
  }

  // Per-tool policy override
  const explicit = input.toolPolicies[input.definition.name];
  if (explicit) {
    if (explicit === 'deny') return { kind: 'deny', reason: 'Blocked by tool policy.' };
    if (explicit === 'auto') return { kind: 'allow', reason: 'Allowed by explicit auto policy.' };
    if (explicit === 'manual') return { kind: 'require_approval', reason: 'Requires manual approval.' };
  }

  // External post always requires approval
  if (input.definition.risk === 'external_post') {
    return { kind: 'require_approval', reason: 'External post requires approval.' };
  }

  // Policy mode decisions
  switch (input.policyMode) {
    case 'approve_each':
      return input.definition.risk === 'read_only'
        ? { kind: 'allow', reason: 'Read-only in approve_each mode.' }
        : { kind: 'require_approval', reason: 'Requires approval in approve_each mode.' };
    case 'autonomous':
      return { kind: 'allow', reason: 'Autonomous mode.' };
    case 'approve_by_policy':
    default:
      if (input.definition.risk === 'read_only') return { kind: 'allow', reason: 'Read-only allowed.' };
      if (input.definition.risk === 'network') return { kind: 'allow', reason: 'Network allowed by policy.' };
      return { kind: 'require_approval', reason: 'Requires approval by policy.' };
  }
}

/**
 * Build a pure job record data object (without ID generation or storage).
 */
export interface ToolJobData {
  toolName: string;
  risk: ToolRisk;
  origin: 'assistant' | 'cli' | 'web';
  agentId?: string;
  userId?: string;
  channel?: string;
  requestId?: string;
}

export function buildJobData(
  definition: ToolDefinition,
  request: {
    origin: 'assistant' | 'cli' | 'web';
    agentId?: string;
    userId?: string;
    channel?: string;
    requestId?: string;
  },
): ToolJobData {
  return {
    toolName: definition.name,
    risk: definition.risk,
    origin: request.origin,
    agentId: request.agentId,
    userId: request.userId,
    channel: request.channel,
    requestId: request.requestId,
  };
}
