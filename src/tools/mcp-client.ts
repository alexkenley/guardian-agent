/**
 * MCP Client — Model Context Protocol client adapter for GuardianAgent.
 *
 * Connects to external MCP tool servers and exposes their tools through
 * the GuardianAgent tool system. All MCP tool calls pass through the
 * Guardian admission pipeline before execution.
 *
 * Protocol: JSON-RPC 2.0 over stdio or SSE transport.
 * Spec: https://modelcontextprotocol.io/
 */

import type { ChildProcess } from 'node:child_process';
import { createLogger } from '../util/logging.js';
import type { ToolDefinition, ToolResult, ToolRisk } from './types.js';
import { sandboxedSpawn, type SandboxConfig, DEFAULT_SANDBOX_CONFIG } from '../sandbox/index.js';

const log = createLogger('mcp-client');

// ─── MCP Protocol Types ───────────────────────────────────────

/** JSON-RPC 2.0 request. */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response. */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP tool definition from server. */
export interface MCPToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** MCP server capabilities returned by initialize. */
export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
}

/** MCP initialize result. */
interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: MCPServerCapabilities;
  serverInfo: { name: string; version: string };
}

/** MCP tool call result content block. */
interface MCPToolCallContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

/** MCP tools/call result. */
interface MCPToolCallResult {
  content: MCPToolCallContent[];
  isError?: boolean;
}

// ─── Connection State ─────────────────────────────────────────

export type MCPConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Configuration for an MCP server connection. */
export interface MCPServerConfig {
  /** Unique identifier for this server connection. */
  id: string;
  /** Display name. */
  name: string;
  /** Transport type. */
  transport: 'stdio';
  /** Command to start the MCP server. */
  command: string;
  /** Arguments for the command. */
  args?: string[];
  /** Environment variables to pass to the server process. */
  env?: Record<string, string>;
  /** Working directory for the server process. */
  cwd?: string;
  /** Request timeout in milliseconds. Default: 30000. */
  timeoutMs?: number;
  /** Optional trust-level override for all tools exposed by this server. */
  trustLevel?: ToolRisk;
  /** Optional per-server rate limit. */
  maxCallsPerMinute?: number;
}

// ─── MCP Client ───────────────────────────────────────────────

/**
 * Client for a single MCP server connection.
 *
 * Manages the lifecycle of the server process, handles JSON-RPC
 * communication, and exposes discovered tools.
 */
export class MCPClient {
  readonly config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private state: MCPConnectionState = 'disconnected';
  private _serverCapabilities: MCPServerCapabilities = {};
  private serverInfo: { name: string; version: string } = { name: '', version: '' };
  private tools: Map<string, MCPToolSchema> = new Map();
  private pendingRequests: Map<string, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();
  private buffer = '';
  private nextId = 1;
  private readonly sandboxConfig: SandboxConfig;
  private readonly recentCallTimestamps: number[] = [];

  constructor(config: MCPServerConfig, sandboxConfig?: SandboxConfig) {
    this.config = config;
    this.sandboxConfig = sandboxConfig ?? DEFAULT_SANDBOX_CONFIG;
  }

  /** Current connection state. */
  getState(): MCPConnectionState {
    return this.state;
  }

  /** Server info from initialize handshake. */
  getServerInfo(): { name: string; version: string } {
    return { ...this.serverInfo };
  }

  /** Server capabilities from initialize handshake. */
  getServerCapabilities(): MCPServerCapabilities {
    return { ...this._serverCapabilities };
  }

  /**
   * Connect to the MCP server.
   *
   * Spawns the server process, performs the initialize handshake,
   * and discovers available tools.
   */
  async connect(): Promise<void> {
    if (this.state === 'connected') return;

    this.state = 'connecting';

    try {
      this.process = await sandboxedSpawn(this.config.command, this.config.args ?? [], this.sandboxConfig, {
        profile: 'workspace-write',
        networkAccess: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.config.env,
        cwd: this.config.cwd,
      });

      // Collect stderr for diagnostic messages on early exit
      let stderrBuf = '';

      this.process.stdout!.on('data', (data: Buffer) => {
        this.handleStdout(data.toString());
      });

      this.process.stderr!.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) stderrBuf += (stderrBuf ? '\n' : '') + text;
        log.warn({ server: this.config.id, stderr: text }, 'MCP server stderr');
      });

      this.process.on('exit', (code) => {
        log.info({ server: this.config.id, code }, 'MCP server exited');
        this.state = 'disconnected';
        const detail = stderrBuf ? `: ${stderrBuf.slice(0, 500)}` : '';
        this.rejectAllPending(new Error(`MCP server exited with code ${code}${detail}`));
      });

      this.process.on('error', (err) => {
        log.error({ server: this.config.id, err: err.message }, 'MCP server error');
        this.state = 'error';
        this.rejectAllPending(err);
      });

      // Initialize handshake
      const initResult = await this.sendRequest<MCPInitializeResult>('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'guardianagent', version: '1.0.0' },
      });

      this._serverCapabilities = initResult.capabilities;
      this.serverInfo = initResult.serverInfo;

      // Send initialized notification
      this.sendNotification('notifications/initialized', {});

      // Discover tools
      await this.refreshTools();

      this.state = 'connected';
      log.info({
        server: this.config.id,
        serverName: this.serverInfo.name,
        toolCount: this.tools.size,
      }, 'MCP server connected');

    } catch (err) {
      this.state = 'error';
      this.disconnect();
      throw err;
    }
  }

  /** Disconnect from the MCP server. */
  disconnect(): void {
    this.rejectAllPending(new Error('Client disconnected'));

    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }

    this.state = 'disconnected';
    this.tools.clear();
    this.buffer = '';
    log.info({ server: this.config.id }, 'MCP server disconnected');
  }

  /** Refresh the list of available tools from the server. */
  async refreshTools(): Promise<void> {
    const result = await this.sendRequest<{ tools: MCPToolSchema[] }>('tools/list', {});
    this.tools.clear();
    for (const tool of result.tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /** Get all discovered tool schemas. */
  getTools(): MCPToolSchema[] {
    return [...this.tools.values()];
  }

  /**
   * Convert MCP tool schemas to GuardianAgent ToolDefinitions.
   *
   * Prefixes tool names with the server ID to avoid collisions
   * when multiple MCP servers are connected.
   */
  getToolDefinitions(): ToolDefinition[] {
    return this.getTools().map(tool => ({
      name: `mcp-${this.config.id}-${tool.name}`,
      description: tool.description ?? `MCP tool from ${this.config.name}`,
      risk: inferMcpToolRisk(tool, this.config.trustLevel),
      parameters: {
        type: 'object' as const,
        properties: tool.inputSchema?.properties ?? {},
        ...(tool.inputSchema?.required?.length ? { required: tool.inputSchema.required } : {}),
      },
    }));
  }

  /**
   * Call an MCP tool.
   *
   * This method is called AFTER the Guardian admission pipeline has
   * approved the tool execution request.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.state !== 'connected') {
      return { success: false, error: `MCP server '${this.config.id}' is not connected` };
    }

    if (!this.tools.has(toolName)) {
      return { success: false, error: `MCP tool '${toolName}' not found on server '${this.config.id}'` };
    }

    const rateLimitError = this.enforceRateLimit();
    if (rateLimitError) {
      return {
        success: false,
        error: rateLimitError,
        metadata: { server: this.config.id, tool: toolName },
      };
    }

    try {
      const result = await this.sendRequest<MCPToolCallResult>('tools/call', {
        name: toolName,
        arguments: args,
      });

      // Extract text content from result
      const textContent = result.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text!)
        .join('\n');

      if (result.isError) {
        return {
          success: false,
          error: textContent || 'MCP tool returned error',
          metadata: { server: this.config.id, tool: toolName },
        };
      }

      return {
        success: true,
        output: textContent,
        metadata: { server: this.config.id, tool: toolName },
      };

    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        metadata: { server: this.config.id, tool: toolName },
      };
    }
  }

  private enforceRateLimit(): string | null {
    const limit = this.config.maxCallsPerMinute;
    if (!limit || limit < 1) {
      return null;
    }

    const now = Date.now();
    const cutoff = now - 60_000;
    while (this.recentCallTimestamps.length > 0 && this.recentCallTimestamps[0] < cutoff) {
      this.recentCallTimestamps.shift();
    }

    if (this.recentCallTimestamps.length >= limit) {
      return `MCP server '${this.config.id}' exceeded maxCallsPerMinute (${limit}).`;
    }

    this.recentCallTimestamps.push(now);
    return null;
  }

  // ─── JSON-RPC Transport ───────────────────────────────────────

  private sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = String(this.nextId++);
      const timeoutMs = this.config.timeoutMs ?? 30_000;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (response: JsonRpcResponse) => {
          if (response.error) {
            reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
          } else {
            resolve(response.result as T);
          }
        },
        reject,
        timer,
      });

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.writeMessage(request);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const message = {
      jsonrpc: '2.0' as const,
      method,
      params,
    };
    this.writeMessage(message);
  }

  private writeMessage(message: object): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('MCP server stdin is not writable');
    }

    // Send as newline-delimited JSON (compatible with all MCP servers)
    const json = JSON.stringify(message);
    this.process.stdin.write(json + '\n');
  }

  private handleStdout(data: string): void {
    this.buffer += data;

    // Try Content-Length framing first (LSP-style), fall back to newline-delimited JSON.
    // Most MCP servers use newline-delimited JSON, but some use Content-Length framing.
    while (this.buffer.length > 0) {
      // Check for Content-Length header
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const header = this.buffer.slice(0, headerEnd);
        const match = header.match(/^Content-Length:\s*(\d+)/i);
        if (match) {
          const contentLength = parseInt(match[1], 10);
          const bodyStart = headerEnd + 4;
          if (this.buffer.length < bodyStart + contentLength) {
            break; // Wait for more data
          }
          const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
          this.buffer = this.buffer.slice(bodyStart + contentLength);
          this.parseAndHandle(body);
          continue;
        }
      }

      // Newline-delimited JSON: extract complete lines
      const newlineIdx = this.buffer.indexOf('\n');
      if (newlineIdx === -1) break; // Wait for complete line

      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue; // Skip empty lines
      this.parseAndHandle(line);
    }
  }

  private parseAndHandle(body: string): void {
    try {
      const message = JSON.parse(body) as JsonRpcResponse;
      this.handleMessage(message);
    } catch {
      log.warn({ server: this.config.id, body: body.slice(0, 200) }, 'Failed to parse MCP message');
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pendingRequests.get(String(message.id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(String(message.id));
        pending.resolve(message);
      }
    }
    // Notifications (no id) are logged but not dispatched
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

// ─── MCP Client Manager ──────────────────────────────────────

/**
 * Manages multiple MCP server connections.
 *
 * Provides a unified interface for tool discovery and execution
 * across all connected MCP servers.
 */
export class MCPClientManager {
  private clients: Map<string, MCPClient> = new Map();
  private readonly sandboxConfig: SandboxConfig;

  constructor(sandboxConfig?: SandboxConfig) {
    this.sandboxConfig = sandboxConfig ?? DEFAULT_SANDBOX_CONFIG;
  }

  /** Add and connect to an MCP server. */
  async addServer(config: MCPServerConfig): Promise<void> {
    if (this.clients.has(config.id)) {
      throw new Error(`MCP server '${config.id}' is already registered`);
    }

    const client = new MCPClient(config, this.sandboxConfig);
    this.clients.set(config.id, client);
    await client.connect();
  }

  /** Remove and disconnect from an MCP server. */
  removeServer(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      client.disconnect();
      this.clients.delete(id);
    }
  }

  /** Get a specific client. */
  getClient(id: string): MCPClient | undefined {
    return this.clients.get(id);
  }

  /** Get all connected clients. */
  getClients(): MCPClient[] {
    return [...this.clients.values()];
  }

  /**
   * Get all tool definitions from all connected servers.
   *
   * Tool names are prefixed with "mcp-<serverId>-" to avoid collisions.
   */
  getAllToolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const client of this.clients.values()) {
      if (client.getState() === 'connected') {
        definitions.push(...client.getToolDefinitions());
      }
    }
    return definitions;
  }

  /**
   * Call a tool by its fully qualified name (mcp-<serverId>-<toolName>).
   *
   * Parses the server ID and tool name from the qualified name,
   * then delegates to the appropriate client.
   */
  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = MCPClientManager.parseToolName(qualifiedName);
    if (!parsed) {
      return { success: false, error: `Invalid MCP tool name: ${qualifiedName}` };
    }

    const client = this.clients.get(parsed.serverId);
    if (!client) {
      return { success: false, error: `MCP server '${parsed.serverId}' not found` };
    }

    return client.callTool(parsed.toolName, args);
  }

  /**
   * Parse a qualified MCP tool name into server ID and tool name.
   *
   * Format: mcp-<serverId>-<toolName>
   * Server IDs must be alphanumeric/underscore only (no hyphens).
   * Tool names may contain hyphens and underscores.
   */
  static parseToolName(qualifiedName: string): { serverId: string; toolName: string } | null {
    const match = qualifiedName.match(/^mcp-([a-zA-Z0-9_]+)-(.+)$/);
    if (!match) return null;
    return { serverId: match[1], toolName: match[2] };
  }

  /** Disconnect from all servers. */
  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
    this.clients.clear();
  }

  /** Get status of all connections. */
  getStatus(): Array<{
    id: string;
    name: string;
    state: MCPConnectionState;
    toolCount: number;
    serverInfo: { name: string; version: string };
  }> {
    return [...this.clients.values()].map(client => ({
      id: client.config.id,
      name: client.config.name,
      state: client.getState(),
      toolCount: client.getTools().length,
      serverInfo: client.getServerInfo(),
    }));
  }
}

function inferMcpToolRisk(tool: MCPToolSchema, override?: ToolRisk): ToolRisk {
  if (override) {
    return override;
  }

  const fields = tool.inputSchema?.properties
    ? Object.keys(tool.inputSchema.properties).join(' ')
    : '';
  const combined = `${tool.name} ${tool.description ?? ''} ${fields}`.toLowerCase();

  const isExternalPost = /\b(send|post|publish|notify|message|email|comment|reply|webhook|tweet|sms|invite)\b/.test(combined)
    && /\b(create|write|update|post|publish|send|reply|comment|notify|share)\b/.test(combined);
  if (isExternalPost) {
    return 'external_post';
  }

  if (/\b(create|write|update|delete|remove|insert|append|edit|modify|set|save|upload|rename|move|trash|archive)\b/.test(combined)) {
    return 'mutating';
  }

  if (/\b(read|get|list|search|find|fetch|query|lookup|show|describe|preview|inspect|download)\b/.test(combined)) {
    return 'read_only';
  }

  return 'network';
}
