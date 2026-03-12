import type { ToolDefinition, ToolExecutionRequest, ToolRunResponse } from '../tools/types.js';

// ─── JSON-RPC 2.0 Types ───────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

// ─── Capability Tokens ────────────────────────────────────────

export interface CapabilityToken {
  id: string;                           // Unique token ID (UUID v4)
  workerId: string;                     // Bound to specific worker
  sessionId: string;                    // Bound to user session
  agentId: string;                      // Bound to specific agent
  authorizedBy: string;                 // Human authority (userId) who started session
  grantedCapabilities: readonly string[]; // Subset of agent's registered capabilities
  allowedToolCategories?: string[];     // Optional narrower tool category filter
  issuedAt: number;                     // Unix ms
  expiresAt: number;                    // Unix ms — short-lived (default 10 min)
  maxToolCalls?: number;                // Optional call budget
  usedToolCalls: number;                // Running counter
}

// ─── Provenance & Taint ───────────────────────────────────────

export interface ProvenanceMetadata {
  source: 'local' | 'remote';
  trust: 'internal' | 'external';
  tainted: boolean;
  originTool: string;         // e.g. 'web_fetch', 'browser_task', 'mcp-server1-search'
  originDomain?: string;      // For network-sourced content
  timestamp: number;
}

// ─── Tool Caller Interface ────────────────────────────────────

export interface ToolCaller {
  listAlwaysLoaded(): ToolDefinition[];
  searchTools(query: string): ToolDefinition[];
  callTool(request: ToolExecutionRequest): Promise<ToolRunResponse>;
  getApprovalStatus?(approvalId: string): Promise<'pending' | 'approved' | 'denied'>;
}
