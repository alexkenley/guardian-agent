/**
 * Tool execution types for assistant-side workstation automation.
 */

import type { AgentContext } from '../agent/types.js';

export type ToolRisk = 'read_only' | 'mutating' | 'network' | 'external_post';
export type ToolPolicyMode = 'approve_each' | 'approve_by_policy' | 'autonomous';
export type ToolPolicySetting = 'auto' | 'policy' | 'manual' | 'deny';
export type ToolDecision = 'allow' | 'deny' | 'require_approval';

export interface ToolDefinition {
  name: string;
  description: string;
  risk: ToolRisk;
  parameters: Record<string, unknown>;
}

export interface ToolExecutionRequest {
  toolName: string;
  args: Record<string, unknown>;
  origin: 'assistant' | 'cli' | 'web';
  agentId?: string;
  userId?: string;
  channel?: string;
  requestId?: string;
  /**
   * Optional agent context from runtime dispatch.
   * When present, tool actions are checked using ctx.checkAction().
   */
  agentContext?: Pick<AgentContext, 'checkAction'>;
  /** When true, validate but do not execute mutating operations. */
  dryRun?: boolean;
}

export interface ToolResult {
  success: boolean;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  /** Whether this result is from a dry-run (no side effects). */
  dryRun?: boolean;
  /** Preview description of what would happen (dry-run mode). */
  preview?: string;
}

export type ToolJobStatus =
  | 'pending_approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied';

export interface ToolJobRecord {
  id: string;
  toolName: string;
  risk: ToolRisk;
  origin: 'assistant' | 'cli' | 'web';
  agentId?: string;
  userId?: string;
  channel?: string;
  requestId?: string;
  /** SHA-256 hash of redacted tool arguments for correlation without raw secrets. */
  argsHash?: string;
  argsPreview: string;
  status: ToolJobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  requiresApproval: boolean;
  approvalId?: string;
  resultPreview?: string;
  error?: string;
}

export interface ToolApprovalRequest {
  id: string;
  jobId: string;
  toolName: string;
  risk: ToolRisk;
  origin: 'assistant' | 'cli' | 'web';
  /** SHA-256 hash of redacted arguments. */
  argsHash?: string;
  /** Redacted approval arguments (never stores raw sensitive values). */
  args: Record<string, unknown>;
  createdAt: number;
  status: 'pending' | 'approved' | 'denied';
  decidedAt?: number;
  decidedBy?: string;
  reason?: string;
}

export interface ToolPolicySnapshot {
  mode: ToolPolicyMode;
  toolPolicies: Record<string, ToolPolicySetting>;
  sandbox: {
    allowedPaths: string[];
    allowedCommands: string[];
    allowedDomains: string[];
  };
}

export interface ToolRunResponse {
  success: boolean;
  status: ToolJobStatus;
  jobId: string;
  approvalId?: string;
  message: string;
  output?: unknown;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  request: ToolExecutionRequest,
) => Promise<ToolResult>;
