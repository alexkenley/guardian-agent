/**
 * Tool execution types for assistant-side workstation automation.
 */

import type { AgentContext } from '../agent/types.js';

export type ToolRisk = 'read_only' | 'mutating' | 'network' | 'external_post';
export type ToolPolicyMode = 'approve_each' | 'approve_by_policy' | 'autonomous';
export type ToolPolicySetting = 'auto' | 'policy' | 'manual' | 'deny';
export type ToolDecision = 'allow' | 'deny' | 'require_approval';

/** Tool category for enable/disable gating. */
export type ToolCategory =
  | 'filesystem'
  | 'shell'
  | 'web'
  | 'browser'
  | 'contacts'
  | 'email'
  | 'intel'
  | 'forum'
  | 'network'
  | 'system'
  | 'memory'
  | 'search';

/** Metadata for each tool category. */
export const TOOL_CATEGORIES: Record<ToolCategory, { label: string; description: string }> = {
  filesystem: { label: 'Filesystem', description: 'Read, write, search, and create files within allowed workspace paths.' },
  shell: { label: 'Shell', description: 'Execute allowlisted shell commands from the workspace root.' },
  web: { label: 'Web', description: 'Fetch web pages and search the internet via HTTP.' },
  browser: { label: 'Browser', description: 'Headless browser automation with JS rendering and element interaction.' },
  contacts: { label: 'Contacts', description: 'Discover, import, list contacts and manage marketing campaigns.' },
  email: { label: 'Email', description: 'Send emails via Gmail API and run email campaigns.' },
  intel: { label: 'Threat Intel', description: 'Threat intelligence monitoring, scanning, and response actions.' },
  forum: { label: 'Forum', description: 'Post responses to external forums (approval-gated).' },
  network: { label: 'Network', description: 'Local network diagnostics: ping, ARP, port check, DNS, traceroute.' },
  system: { label: 'System', description: 'OS info, resource usage, process listing, and service status.' },
  memory: { label: 'Memory', description: 'Search conversation history and manage persistent knowledge base.' },
  search: { label: 'Search', description: 'Hybrid search across indexed document collections (BM25 + vector + LLM re-ranking via QMD).' },
};

/** Mapping of each category to its tool names. */
export const BUILTIN_TOOL_CATEGORIES: Record<ToolCategory, string[]> = {
  filesystem: ['fs_list', 'fs_search', 'fs_read', 'fs_write', 'fs_mkdir', 'doc_create'],
  shell: ['shell_safe'],
  web: ['chrome_job', 'web_search', 'web_fetch'],
  browser: ['browser_open', 'browser_action', 'browser_snapshot', 'browser_close', 'browser_task'],
  contacts: ['contacts_discover_browser', 'contacts_import_csv', 'contacts_list', 'campaign_create', 'campaign_list', 'campaign_add_contacts', 'campaign_dry_run'],
  email: ['gmail_send', 'campaign_run'],
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
  system: ['sys_info', 'sys_resources', 'sys_processes', 'sys_services'],
  memory: ['memory_search', 'memory_get', 'memory_save'],
  search: ['qmd_search', 'qmd_status', 'qmd_reindex'],
};

export interface ToolDefinition {
  name: string;
  description: string;
  risk: ToolRisk;
  parameters: Record<string, unknown>;
  /** Tool category for enable/disable gating. Absent for MCP tools. */
  category?: ToolCategory;
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
