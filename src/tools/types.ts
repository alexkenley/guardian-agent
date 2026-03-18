/**
 * Tool execution types for assistant-side workstation automation.
 */

import type { AgentContext } from '../agent/types.js';

export type ToolRisk = 'read_only' | 'mutating' | 'network' | 'external_post';
export type ToolPolicyMode = 'approve_each' | 'approve_by_policy' | 'autonomous';
export type ToolPolicySetting = 'auto' | 'policy' | 'manual' | 'deny';
export type ToolDecision = 'allow' | 'deny' | 'require_approval';
export type PrincipalRole = 'owner' | 'operator' | 'approver' | 'viewer';
export type ContentTrustLevel = 'trusted' | 'low_trust' | 'quarantined';
export type VerificationStatus = 'verified' | 'unverified' | 'failed';

/** Tool category for enable/disable gating. */
export type ToolCategory =
  | 'filesystem'
  | 'coding'
  | 'shell'
  | 'web'
  | 'browser'
  | 'automation'
  | 'contacts'
  | 'email'
  | 'workspace'
  | 'intel'
  | 'forum'
  | 'network'
  | 'cloud'
  | 'system'
  | 'memory'
  | 'search';

/** Metadata for each tool category. */
export const TOOL_CATEGORIES: Record<ToolCategory, { label: string; description: string }> = {
  filesystem: { label: 'Filesystem', description: 'Read, write, search, and create files within allowed workspace paths.' },
  coding: { label: 'Coding', description: 'Code-aware editing, diffing, search, and verification tools inspired by terminal coding agents.' },
  shell: { label: 'Shell', description: 'Execute allowlisted shell commands from the workspace root.' },
  web: { label: 'Web', description: 'Fetch web pages and search the internet via HTTP.' },
  browser: { label: 'Browser', description: 'Browser automation and page inspection via MCP-backed Playwright and Lightpanda tools.' },
  automation: { label: 'Automation', description: 'Create, update, run, and schedule workflows and recurring tasks.' },
  contacts: { label: 'Contacts', description: 'Discover, import, list contacts and manage marketing campaigns.' },
  email: { label: 'Email', description: 'Draft and send emails via the configured Google Workspace integration and run email campaigns.' },
  workspace: { label: 'Google Workspace', description: 'Gmail, Calendar, Drive, Docs, and Sheets via Guardian Agent\'s native Google Workspace tools.' },
  intel: { label: 'Threat Intel', description: 'Threat intelligence monitoring, scanning, and response actions.' },
  forum: { label: 'Forum', description: 'Post responses to external forums (approval-gated).' },
  network: { label: 'Network', description: 'Local network diagnostics: ping, ARP, port check, DNS, traceroute.' },
  cloud: { label: 'Cloud & Hosting', description: 'Manage cloud and hosting providers such as cPanel/WHM.' },
  system: { label: 'System', description: 'OS info, resource usage, process listing, and service status.' },
  memory: { label: 'Memory', description: 'Search conversation history and manage persistent knowledge base.' },
  search: { label: 'Search', description: 'Hybrid search across indexed document collections (BM25 keyword + vector similarity).' },
};

/** Mapping of each category to its tool names. */
export const BUILTIN_TOOL_CATEGORIES: Record<ToolCategory, string[]> = {
  filesystem: ['fs_list', 'fs_search', 'fs_read', 'fs_write', 'fs_mkdir', 'doc_create'],
  coding: [
    'code_session_list',
    'code_session_current',
    'code_session_create',
    'code_session_attach',
    'code_session_detach',
    'code_symbol_search',
    'code_edit',
    'code_patch',
    'code_create',
    'code_plan',
    'code_git_diff',
    'code_git_commit',
    'code_test',
    'code_build',
    'code_lint',
  ],
  shell: ['shell_safe'],
  web: ['chrome_job', 'web_search', 'web_fetch'],
  browser: [],
  automation: ['workflow_list', 'workflow_upsert', 'workflow_delete', 'workflow_run', 'task_list', 'task_create', 'task_update', 'task_delete'],
  contacts: ['contacts_discover_browser', 'contacts_import_csv', 'contacts_list', 'campaign_create', 'campaign_list', 'campaign_add_contacts', 'campaign_dry_run'],
  email: ['gmail_draft', 'gmail_send', 'campaign_run'],
  workspace: ['gws', 'gws_schema'],
  intel: ['intel_summary', 'intel_watch_add', 'intel_watch_remove', 'intel_scan', 'intel_findings', 'intel_draft_action'],
  forum: ['forum_post'],
  network: [
    'net_ping',
    'net_arp_scan',
    'net_port_check',
    'net_interfaces',
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
  ],
  cloud: [
    'cpanel_account',
    'cpanel_domains',
    'cpanel_dns',
    'cpanel_backups',
    'cpanel_ssl',
    'vercel_status',
    'vercel_projects',
    'vercel_deployments',
    'vercel_domains',
    'vercel_env',
    'vercel_logs',
    'cf_status',
    'cf_dns',
    'cf_ssl',
    'cf_cache',
    'aws_status',
    'aws_ec2_instances',
    'aws_ec2_security_groups',
    'aws_s3_buckets',
    'aws_route53',
    'aws_lambda',
    'aws_cloudwatch',
    'aws_rds',
    'aws_iam',
    'aws_costs',
    'gcp_status',
    'gcp_compute',
    'gcp_cloud_run',
    'gcp_storage',
    'gcp_dns',
    'gcp_logs',
    'azure_status',
    'azure_vms',
    'azure_app_service',
    'azure_storage',
    'azure_dns',
    'azure_monitor',
    'whm_status',
    'whm_accounts',
    'whm_dns',
    'whm_ssl',
    'whm_backup',
    'whm_services',
  ],
  system: ['sys_info', 'sys_resources', 'sys_processes', 'sys_services', 'host_monitor_status', 'host_monitor_check', 'gateway_firewall_status', 'gateway_firewall_check'],
  memory: ['memory_search', 'memory_recall', 'memory_save', 'memory_bridge_search'],
  search: ['doc_search', 'doc_search_status', 'doc_search_reindex'],
};

export interface ToolDefinition {
  name: string;
  description: string;
  /** Short description for LLM context (used instead of full description when available). */
  shortDescription?: string;
  risk: ToolRisk;
  parameters: Record<string, unknown>;
  /** Tool category for enable/disable gating. Absent for MCP tools. */
  category?: ToolCategory;
  /** When true, this tool is deferred and only loaded via tool_search. */
  deferLoading?: boolean;
  /** Usage examples to help LLMs understand parameter patterns. */
  examples?: Array<{ input: Record<string, unknown>; description: string }>;
}

export interface ToolExecutionRequest {
  toolName: string;
  args: Record<string, unknown>;
  origin: 'assistant' | 'cli' | 'web';
  agentId?: string;
  userId?: string;
  principalId?: string;
  principalRole?: PrincipalRole;
  channel?: string;
  requestId?: string;
  contentTrustLevel?: ContentTrustLevel;
  taintReasons?: string[];
  derivedFromTaintedContent?: boolean;
  scheduleId?: string;
  /**
   * Optional agent context from runtime dispatch.
   * When present, tool actions are checked using ctx.checkAction().
   */
  agentContext?: Pick<AgentContext, 'checkAction'>;
  /** When true, validate but do not execute mutating operations. */
  dryRun?: boolean;
  /**
   * Trusted runtime bypass for approval prompts.
   * Only internal control-plane paths such as approved scheduled tasks should set this.
   */
  bypassApprovals?: boolean;
  /**
   * Optional Code-session sandbox context.
   * When present, file and shell actions are constrained to this workspace root
   * and use the Coding Assistant command allowlist instead of the global shell policy.
   */
  codeContext?: {
    workspaceRoot: string;
    sessionId?: string;
  };
}

export interface ToolResult {
  success: boolean;
  message?: string;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  verificationStatus?: VerificationStatus;
  verificationEvidence?: string;
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
  codeSessionId?: string;
  agentId?: string;
  userId?: string;
  principalId?: string;
  principalRole?: PrincipalRole;
  channel?: string;
  requestId?: string;
  /** SHA-256 hash of redacted tool arguments for correlation without raw secrets. */
  argsHash?: string;
  /** Redacted arguments for factual reporting/debugging. Never stores raw sensitive values. */
  argsRedacted?: Record<string, unknown>;
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
  verificationStatus?: VerificationStatus;
  verificationEvidence?: string;
}

export interface ToolApprovalRequest {
  id: string;
  jobId: string;
  toolName: string;
  risk: ToolRisk;
  origin: 'assistant' | 'cli' | 'web';
  codeSessionId?: string;
  requestedByPrincipal?: string;
  requestedByRole?: PrincipalRole;
  approvableByPrincipals?: string[];
  approvableByRoles?: PrincipalRole[];
  /** SHA-256 hash of redacted arguments. */
  argsHash?: string;
  /** Redacted approval arguments (never stores raw sensitive values). */
  args: Record<string, unknown>;
  createdAt: number;
  status: 'pending' | 'approved' | 'denied';
  decidedAt?: number;
  decidedBy?: string;
  decisionRole?: PrincipalRole;
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

export interface ToolRuntimeNotice {
  level: 'info' | 'warn';
  message: string;
}

export interface ToolRunResponse {
  success: boolean;
  status: ToolJobStatus;
  jobId: string;
  approvalId?: string;
  message: string;
  output?: unknown;
  verificationStatus?: VerificationStatus;
  trustLevel?: ContentTrustLevel;
  taintReasons?: string[];
}

export type ToolHandler = (
  args: Record<string, unknown>,
  request: ToolExecutionRequest,
) => Promise<ToolResult>;
