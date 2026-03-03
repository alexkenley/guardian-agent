/**
 * Tool execution runtime with policy, sandboxing, and approvals.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { IntelActionType, IntelSourceType, IntelStatus, ThreatIntelService } from '../runtime/threat-intel.js';
import { MarketingStore } from './marketing-store.js';
import { ToolApprovalStore } from './approvals.js';
import { ToolRegistry } from './registry.js';
import type {
  ToolDecision,
  ToolDefinition,
  ToolExecutionRequest,
  ToolJobRecord,
  ToolPolicyMode,
  ToolPolicySetting,
  ToolPolicySnapshot,
  ToolResult,
  ToolRunResponse,
} from './types.js';
import type { MCPClientManager } from './mcp-client.js';
import type { WebSearchConfig } from '../config/types.js';

const execAsync = promisify(execCb);
const MAX_JOBS = 200;
const MAX_APPROVALS = 200;
const MAX_READ_BYTES = 1_000_000;
const MAX_FETCH_BYTES = 500_000;
const MAX_WEB_FETCH_CHARS = 20_000;
const MAX_CAMPAIGN_RECIPIENTS = 500;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILES = 100_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const SEARCH_CACHE_TTL_MS = 300_000; // 5 minutes

export interface ToolExecutorOptions {
  enabled: boolean;
  workspaceRoot: string;
  policyMode: ToolPolicyMode;
  toolPolicies?: Record<string, ToolPolicySetting>;
  allowedPaths?: string[];
  allowedCommands?: string[];
  allowedDomains?: string[];
  threatIntel?: ThreatIntelService;
  allowExternalPosting?: boolean;
  /** MCP client manager for external tool server integration. */
  mcpManager?: MCPClientManager;
  /** Web search configuration. Auto-selects best available provider (Brave > Perplexity > DuckDuckGo). */
  webSearch?: WebSearchConfig;
  now?: () => number;
  onCheckAction?: (action: {
    type: string;
    params: Record<string, unknown>;
    agentId: string;
    origin: ToolExecutionRequest['origin'];
  }) => void;
}

export interface ToolPolicyUpdate {
  mode?: ToolPolicyMode;
  toolPolicies?: Record<string, ToolPolicySetting>;
  sandbox?: {
    allowedPaths?: string[];
    allowedCommands?: string[];
    allowedDomains?: string[];
  };
}

export interface ToolApprovalDecisionResult {
  success: boolean;
  message: string;
  job?: ToolJobRecord;
  result?: ToolRunResponse;
}

interface PendingApprovalContext {
  request: ToolExecutionRequest;
  args: Record<string, unknown>;
}

export class ToolExecutor {
  private readonly registry = new ToolRegistry();
  private readonly approvals = new ToolApprovalStore();
  private readonly jobs: ToolJobRecord[] = [];
  private readonly jobsById = new Map<string, ToolJobRecord>();
  private readonly pendingApprovalContexts = new Map<string, PendingApprovalContext>();
  private readonly options: ToolExecutorOptions;
  private readonly marketingStore: MarketingStore;
  private readonly mcpManager?: MCPClientManager;
  private readonly webSearchConfig: WebSearchConfig;
  private readonly searchCache = new Map<string, { results: unknown; timestamp: number }>();
  private readonly now: () => number;
  private policy: ToolPolicySnapshot;

  constructor(options: ToolExecutorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.mcpManager = options.mcpManager;
    this.webSearchConfig = options.webSearch ?? {};
    this.marketingStore = new MarketingStore(options.workspaceRoot, this.now);
    this.policy = {
      mode: options.policyMode,
      toolPolicies: { ...(options.toolPolicies ?? {}) },
      sandbox: {
        allowedPaths: options.allowedPaths?.length
          ? [...options.allowedPaths]
          : [options.workspaceRoot],
        allowedCommands: options.allowedCommands?.length
          ? [...options.allowedCommands]
          : ['node', 'npm', 'npx', 'git', 'ollama', 'ls', 'dir', 'pwd'],
        allowedDomains: options.allowedDomains?.length
          ? [...options.allowedDomains]
          : ['localhost', '127.0.0.1', 'moltbook.com'],
      },
    };
    this.registerBuiltinTools();
    if (this.mcpManager) {
      this.registerMCPTools();
    }
  }

  /**
   * Register all tools discovered from connected MCP servers.
   *
   * Each MCP tool is registered with a handler that delegates to
   * MCPClientManager.callTool(). The tool name is namespaced as
   * mcp-<serverId>-<toolName> to prevent collisions.
   *
   * Call this again after connecting new MCP servers to refresh.
   */
  registerMCPTools(): void {
    if (!this.mcpManager) return;

    const definitions = this.mcpManager.getAllToolDefinitions();
    for (const def of definitions) {
      // Skip if already registered (idempotent)
      if (this.registry.get(def.name)) continue;

      const manager = this.mcpManager;
      this.registry.register(def, async (args) => {
        return manager.callTool(def.name, args);
      });
    }
  }

  isEnabled(): boolean {
    return this.options.enabled;
  }

  listToolDefinitions(): ToolDefinition[] {
    return this.registry.listDefinitions();
  }

  getPolicy(): ToolPolicySnapshot {
    return {
      mode: this.policy.mode,
      toolPolicies: { ...this.policy.toolPolicies },
      sandbox: {
        allowedPaths: [...this.policy.sandbox.allowedPaths],
        allowedCommands: [...this.policy.sandbox.allowedCommands],
        allowedDomains: [...this.policy.sandbox.allowedDomains],
      },
    };
  }

  updatePolicy(update: ToolPolicyUpdate): ToolPolicySnapshot {
    if (update.mode) {
      this.policy.mode = update.mode;
    }
    if (update.toolPolicies) {
      this.policy.toolPolicies = {
        ...this.policy.toolPolicies,
        ...update.toolPolicies,
      };
    }
    if (update.sandbox?.allowedPaths) {
      this.policy.sandbox.allowedPaths = uniqueNonEmpty(update.sandbox.allowedPaths);
    }
    if (update.sandbox?.allowedCommands) {
      this.policy.sandbox.allowedCommands = uniqueNonEmpty(update.sandbox.allowedCommands);
    }
    if (update.sandbox?.allowedDomains) {
      this.policy.sandbox.allowedDomains = uniqueNonEmpty(update.sandbox.allowedDomains.map((host) => host.toLowerCase()));
    }
    return this.getPolicy();
  }

  listJobs(limit = 50): ToolJobRecord[] {
    return this.jobs.slice(0, Math.max(1, limit));
  }

  listApprovals(limit = 50, status?: 'pending' | 'approved' | 'denied') {
    return this.approvals.list(Math.min(MAX_APPROVALS, Math.max(1, limit)), status);
  }

  async runTool(request: ToolExecutionRequest): Promise<ToolRunResponse> {
    if (!this.options.enabled) {
      return {
        success: false,
        status: 'denied',
        jobId: randomUUID(),
        message: 'Tools are disabled.',
      };
    }

    const args = request.args ?? {};
    const entry = this.registry.get(request.toolName);
    if (!entry) {
      return {
        success: false,
        status: 'failed',
        jobId: randomUUID(),
        message: `Unknown tool '${request.toolName}'.`,
      };
    }

    const job = this.createJob(entry.definition, request, args);
    const decision = this.decide(entry.definition);
    if (decision === 'deny') {
      job.status = 'denied';
      job.completedAt = this.now();
      job.durationMs = 0;
      job.error = 'Blocked by tool policy.';
      return {
        success: false,
        status: job.status,
        jobId: job.id,
        message: job.error,
      };
    }

    if (decision === 'require_approval') {
      const approval = this.approvals.create(job, args, this.now);
      job.status = 'pending_approval';
      job.approvalId = approval.id;
      this.pendingApprovalContexts.set(approval.id, { request, args });
      return {
        success: false,
        status: job.status,
        jobId: job.id,
        approvalId: approval.id,
        message: `Tool '${request.toolName}' is awaiting approval.`,
      };
    }

    const result = await this.execute(job, request, args, entry.handler);
    return result;
  }

  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    actor: string,
    reason?: string,
  ): Promise<ToolApprovalDecisionResult> {
    const approval = this.approvals.decide(approvalId, decision, actor, reason, this.now);
    if (!approval) {
      return { success: false, message: `Approval '${approvalId}' not found.` };
    }

    const job = this.jobsById.get(approval.jobId);
    if (!job) {
      return { success: false, message: `Job '${approval.jobId}' for approval '${approvalId}' was not found.` };
    }

    if (decision === 'denied') {
      job.status = 'denied';
      job.completedAt = this.now();
      job.durationMs = 0;
      job.error = reason?.trim() || 'Denied by user.';
      this.pendingApprovalContexts.delete(approvalId);
      return {
        success: true,
        message: `Denied approval '${approvalId}'.`,
        job,
      };
    }

    const pending = this.pendingApprovalContexts.get(approvalId);
    if (!pending) {
      return { success: false, message: `No pending context found for approval '${approvalId}'.` };
    }
    this.pendingApprovalContexts.delete(approvalId);

    const entry = this.registry.get(job.toolName);
    if (!entry) {
      job.status = 'failed';
      job.error = `Tool '${job.toolName}' no longer exists.`;
      job.completedAt = this.now();
      return { success: false, message: job.error, job };
    }

    const result = await this.execute(job, pending.request, pending.args, entry.handler);
    return {
      success: result.success,
      message: result.message,
      job,
      result,
    };
  }

  async executeModelTool(
    toolName: string,
    args: Record<string, unknown>,
    request: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  ): Promise<Record<string, unknown>> {
    const result = await this.runTool({
      ...request,
      toolName,
      args,
    });
    return {
      success: result.success,
      status: result.status,
      message: result.message,
      jobId: result.jobId,
      approvalId: result.approvalId,
      output: result.output,
    };
  }

  private createJob(
    definition: ToolDefinition,
    request: ToolExecutionRequest,
    args: Record<string, unknown>,
  ): ToolJobRecord {
    const job: ToolJobRecord = {
      id: randomUUID(),
      toolName: definition.name,
      risk: definition.risk,
      origin: request.origin,
      agentId: request.agentId,
      userId: request.userId,
      channel: request.channel,
      requestId: request.requestId,
      argsPreview: sanitizePreview(JSON.stringify(args)),
      status: 'running',
      createdAt: this.now(),
      requiresApproval: false,
    };
    this.jobs.unshift(job);
    this.jobsById.set(job.id, job);
    while (this.jobs.length > MAX_JOBS) {
      const removed = this.jobs.pop();
      if (removed) this.jobsById.delete(removed.id);
    }
    return job;
  }

  private decide(definition: ToolDefinition): ToolDecision {
    if (!this.options.enabled) return 'deny';

    const explicit = this.policy.toolPolicies[definition.name];
    if (explicit) {
      if (explicit === 'deny') return 'deny';
      if (explicit === 'auto') return 'allow';
      if (explicit === 'manual') return 'require_approval';
    }

    if (definition.risk === 'external_post') {
      return 'require_approval';
    }

    switch (this.policy.mode) {
      case 'approve_each':
        return definition.risk === 'read_only' ? 'allow' : 'require_approval';
      case 'autonomous':
        return 'allow';
      case 'approve_by_policy':
      default:
        if (definition.risk === 'read_only') return 'allow';
        if (definition.risk === 'network') return 'allow';
        return 'require_approval';
    }
  }

  private async execute(
    job: ToolJobRecord,
    request: ToolExecutionRequest,
    args: Record<string, unknown>,
    handler: (args: Record<string, unknown>, request: ToolExecutionRequest) => Promise<ToolResult>,
  ): Promise<ToolRunResponse> {
    job.status = 'running';
    job.startedAt = this.now();

    // Dry-run mode: validate but don't execute mutating operations
    if (request.dryRun && job.risk !== 'read_only') {
      job.status = 'succeeded';
      job.completedAt = this.now();
      job.durationMs = 0;
      job.resultPreview = '[dry-run preview]';
      const preview = this.buildDryRunPreview(job.toolName, args);
      return {
        success: true,
        status: job.status,
        jobId: job.id,
        message: `[DRY RUN] Tool '${job.toolName}' validated. ${preview}`,
        output: { dryRun: true, preview, args },
      };
    }

    try {
      const result = await handler(args, request);
      if (!result.success) {
        job.status = 'failed';
        job.error = sanitizePreview(result.error ?? 'Tool failed.');
        job.completedAt = this.now();
        job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
        return {
          success: false,
          status: job.status,
          jobId: job.id,
          message: job.error,
        };
      }

      job.status = 'succeeded';
      job.completedAt = this.now();
      job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
      job.resultPreview = sanitizePreview(JSON.stringify(result.output ?? {}));
      return {
        success: true,
        status: job.status,
        jobId: job.id,
        message: `Tool '${job.toolName}' completed.`,
        output: result.output,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      job.status = 'failed';
      job.error = sanitizePreview(message);
      job.completedAt = this.now();
      job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
      return {
        success: false,
        status: job.status,
        jobId: job.id,
        message: job.error,
      };
    }
  }

  private buildDryRunPreview(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case 'fs_write':
        return `Would ${args.append ? 'append to' : 'write'} file '${args.path}' (${String(args.content ?? '').length} chars)`;
      case 'doc_create':
        return `Would create document '${args.filename}'`;
      case 'run_command':
        return `Would execute: ${args.command}`;
      case 'http_fetch':
        return `Would fetch URL: ${args.url}`;
      case 'web_search':
        return `Would search the web for: "${args.query}" (provider: ${args.provider || 'auto'})`;
      case 'web_fetch':
        return `Would fetch and extract content from: ${args.url}`;
      case 'forum_post':
        return `Would post to forum thread '${args.threadId}'`;
      case 'intel_action':
        return `Would perform intel action '${args.action}' on finding '${args.findingId}'`;
      default:
        return `Would execute tool '${toolName}' with args: ${sanitizePreview(JSON.stringify(args))}`;
    }
  }

  private registerBuiltinTools(): void {
    this.registry.register(
      {
        name: 'fs_list',
        description: 'List files and directories inside allowed workspace paths.',
        risk: 'read_only',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to list.' },
          },
        },
      },
      async (args, request) => {
        const rawPath = asString(args.path, '.');
        const safePath = this.resolveAllowedPath(rawPath);
        this.guardAction(request, 'read_file', { path: rawPath });
        const entries = await readdir(safePath, { withFileTypes: true });
        return {
          success: true,
          output: {
            path: safePath,
            entries: entries.slice(0, 500).map((entry) => ({
              name: entry.name,
              type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
            })),
          },
        };
      },
    );

    this.registry.register(
      {
        name: 'fs_search',
        description: 'Recursively search files by name or content within allowed paths.',
        risk: 'read_only',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Root directory to search (default: current workspace root).' },
            query: { type: 'string', description: 'Search term for file names and/or content.' },
            mode: { type: 'string', description: "Search mode: 'name', 'content', or 'auto' (default: name)." },
            maxResults: { type: 'number', description: `Maximum matches to return (max ${MAX_SEARCH_RESULTS}).` },
            maxDepth: { type: 'number', description: 'Maximum directory recursion depth (max 40).' },
            maxFiles: { type: 'number', description: `Maximum files to scan before stopping (max ${MAX_SEARCH_FILES}).` },
            maxFileBytes: { type: 'number', description: `Maximum bytes per file for content search (max ${MAX_SEARCH_FILE_BYTES}).` },
            caseSensitive: { type: 'boolean', description: 'Enable case-sensitive matching.' },
          },
          required: ['query'],
        },
      },
      async (args, request) => {
        const rawPath = asString(args.path, '.');
        const query = requireString(args.query, 'query').trim();
        const mode = asString(args.mode, 'name').trim().toLowerCase();
        if (!['name', 'content', 'auto'].includes(mode)) {
          return {
            success: false,
            error: "Invalid mode. Use 'name', 'content', or 'auto'.",
          };
        }

        const safeRoot = this.resolveAllowedPath(rawPath);
        this.guardAction(request, 'read_file', { path: rawPath, query });

        const maxResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, asNumber(args.maxResults, 25)));
        const maxDepth = Math.max(0, Math.min(40, asNumber(args.maxDepth, 12)));
        const maxFiles = Math.max(50, Math.min(MAX_SEARCH_FILES, asNumber(args.maxFiles, 20_000)));
        const maxFileBytes = Math.max(256, Math.min(MAX_SEARCH_FILE_BYTES, asNumber(args.maxFileBytes, 120_000)));
        const caseSensitive = !!args.caseSensitive;
        const normalizedQuery = caseSensitive ? query : query.toLowerCase();
        const searchNames = mode === 'name' || mode === 'auto';
        const searchContent = mode === 'content' || mode === 'auto';

        const matches: Array<{
          path: string;
          relativePath: string;
          matchType: 'name' | 'content';
          snippet?: string;
        }> = [];

        const stack: Array<{ dir: string; depth: number }> = [{ dir: safeRoot, depth: 0 }];
        let scannedDirs = 0;
        let scannedFiles = 0;

        while (stack.length > 0 && matches.length < maxResults && scannedFiles < maxFiles) {
          const current = stack.pop();
          if (!current) break;

          let entries;
          try {
            entries = await readdir(current.dir, { withFileTypes: true });
          } catch {
            continue;
          }
          scannedDirs += 1;

          for (const entry of entries) {
            if (matches.length >= maxResults || scannedFiles >= maxFiles) break;

            const fullPath = resolve(current.dir, entry.name);
            if (entry.isDirectory()) {
              if (current.depth < maxDepth) {
                stack.push({ dir: fullPath, depth: current.depth + 1 });
              }
              continue;
            }

            if (!entry.isFile()) continue;
            scannedFiles += 1;

            const rel = relative(safeRoot, fullPath);
            const relativePath = rel ? rel.split(sep).join('/') : entry.name;
            const normalizedName = caseSensitive ? entry.name : entry.name.toLowerCase();
            const nameMatched = searchNames && normalizedName.includes(normalizedQuery);

            if (nameMatched) {
              matches.push({
                path: fullPath,
                relativePath,
                matchType: 'name',
              });
              continue;
            }

            if (!searchContent) continue;

            let content: Buffer;
            try {
              content = await readFile(fullPath);
            } catch {
              continue;
            }
            if (content.byteLength > maxFileBytes || looksBinary(content)) {
              continue;
            }

            const text = content.toString('utf-8');
            const haystack = caseSensitive ? text : text.toLowerCase();
            const idx = haystack.indexOf(normalizedQuery);
            if (idx >= 0) {
              matches.push({
                path: fullPath,
                relativePath,
                matchType: 'content',
                snippet: makeContentSnippet(text, idx, query.length),
              });
            }
          }
        }

        const truncated = stack.length > 0 || scannedFiles >= maxFiles || matches.length >= maxResults;
        return {
          success: true,
          output: {
            root: safeRoot,
            query,
            mode,
            caseSensitive,
            maxResults,
            scannedDirs,
            scannedFiles,
            truncated,
            matches,
          },
        };
      },
    );

    this.registry.register(
      {
        name: 'fs_read',
        description: 'Read a UTF-8 text file within allowed paths.',
        risk: 'read_only',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read.' },
            maxBytes: { type: 'number', description: `Maximum bytes to read (max ${MAX_READ_BYTES}).` },
          },
          required: ['path'],
        },
      },
      async (args, request) => {
        const rawPath = requireString(args.path, 'path');
        const safePath = this.resolveAllowedPath(rawPath);
        this.guardAction(request, 'read_file', { path: rawPath });
        const maxBytes = Math.min(MAX_READ_BYTES, Math.max(256, asNumber(args.maxBytes, 64_000)));
        const content = await readFile(safePath);
        const truncated = content.byteLength > maxBytes;
        const slice = truncated ? content.subarray(0, maxBytes) : content;
        return {
          success: true,
          output: {
            path: safePath,
            bytes: content.byteLength,
            truncated,
            content: slice.toString('utf-8'),
          },
        };
      },
    );

    this.registry.register(
      {
        name: 'fs_write',
        description: 'Write or append UTF-8 text to a file within allowed paths.',
        risk: 'mutating',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to write.' },
            content: { type: 'string', description: 'Content to write.' },
            append: { type: 'boolean', description: 'Append content instead of overwriting.' },
          },
          required: ['path', 'content'],
        },
      },
      async (args, request) => {
        const rawPath = requireString(args.path, 'path');
        const content = requireString(args.content, 'content');
        const append = !!args.append;
        const safePath = this.resolveAllowedPath(rawPath);
        this.guardAction(request, 'write_file', { path: rawPath, content });
        await mkdir(dirname(safePath), { recursive: true });
        if (append) {
          await appendFile(safePath, content, 'utf-8');
        } else {
          await writeFile(safePath, content, 'utf-8');
        }
        const details = await stat(safePath);
        return {
          success: true,
          output: {
            path: safePath,
            append,
            size: details.size,
          },
        };
      },
    );

    this.registry.register(
      {
        name: 'doc_create',
        description: 'Create a document file from plain text or markdown template.',
        risk: 'mutating',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Target file path.' },
            title: { type: 'string', description: 'Document title.' },
            content: { type: 'string', description: 'Body content.' },
            template: { type: 'string', description: 'Template name: markdown or plain.' },
          },
          required: ['path'],
        },
      },
      async (args, request) => {
        const rawPath = requireString(args.path, 'path');
        const title = asString(args.title, 'Document');
        const content = asString(args.content, '');
        const template = asString(args.template, 'markdown').toLowerCase();
        const safePath = this.resolveAllowedPath(rawPath);
        const finalBody = template === 'plain'
          ? `${title}\n\n${content}\n`
          : `# ${title}\n\n${content}\n`;
        this.guardAction(request, 'write_file', { path: rawPath, content: finalBody });
        await mkdir(dirname(safePath), { recursive: true });
        await writeFile(safePath, finalBody, 'utf-8');
        return {
          success: true,
          output: {
            path: safePath,
            template,
            bytes: Buffer.byteLength(finalBody, 'utf-8'),
          },
        };
      },
    );

    this.registry.register(
      {
        name: 'shell_safe',
        description: 'Run an allowlisted shell command from the workspace root.',
        risk: 'mutating',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command line to execute.' },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds (max 60000).' },
          },
          required: ['command'],
        },
      },
      async (args, request) => {
        const command = requireString(args.command, 'command').trim();
        if (!this.isCommandAllowed(command)) {
          return {
            success: false,
            error: `Command is not allowlisted: '${command}'.`,
          };
        }
        this.guardAction(request, 'execute_command', { command });
        const timeoutMs = Math.max(500, Math.min(60_000, asNumber(args.timeoutMs, 15_000)));
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: this.options.workspaceRoot,
            timeout: timeoutMs,
            maxBuffer: 1_000_000,
          });
          return {
            success: true,
            output: {
              command,
              stdout: truncateOutput(stdout),
              stderr: truncateOutput(stderr),
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            error: `Command failed: ${message}`,
          };
        }
      },
    );

    this.registry.register(
      {
        name: 'chrome_job',
        description: 'Fetch and summarize web content from allowlisted domains.',
        risk: 'network',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Target URL to fetch.' },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds (max 30000).' },
          },
          required: ['url'],
        },
      },
      async (args, request) => {
        const urlText = requireString(args.url, 'url').trim();
        const parsed = new URL(urlText);
        const host = parsed.hostname.toLowerCase();
        if (!this.isHostAllowed(host)) {
          return {
            success: false,
            error: `Host '${host}' is not in allowedDomains.`,
          };
        }
        this.guardAction(request, 'http_request', { url: urlText, method: 'GET' });
        const timeoutMs = Math.max(500, Math.min(30_000, asNumber(args.timeoutMs, 10_000)));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(parsed.toString(), {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              'User-Agent': 'GuardianAgent-Tools/1.0',
              'Accept': 'text/html,application/xhtml+xml,application/json,text/plain',
            },
          });
          const bytes = await response.arrayBuffer();
          const capped = bytes.byteLength > MAX_FETCH_BYTES
            ? bytes.slice(0, MAX_FETCH_BYTES)
            : bytes;
          const raw = Buffer.from(capped).toString('utf-8');
          const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          const title = titleMatch ? stripHtml(titleMatch[1]).trim() : '';
          const snippet = stripHtml(raw).replace(/\s+/g, ' ').trim().slice(0, 1200);
          return {
            success: true,
            output: {
              url: parsed.toString(),
              host,
              status: response.status,
              title: title || null,
              snippet,
              truncated: bytes.byteLength > MAX_FETCH_BYTES,
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            error: `Fetch failed: ${message}`,
          };
        } finally {
          clearTimeout(timer);
        }
      },
    );

    // ── web_search ──────────────────────────────────────────────
    this.registry.register(
      {
        name: 'web_search',
        description: 'Search the web for information. Returns a synthesized AI answer plus structured results. Brave (recommended) uses the free Summarizer API for answers. Perplexity returns AI answers with citations. DuckDuckGo returns raw snippets only.',
        risk: 'network',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
            maxResults: { type: 'number', description: 'Max results 1-10 (default 5).' },
            provider: { type: 'string', description: 'Search provider: brave (search + free summarizer), perplexity (synthesized answers), duckduckgo (HTML scrape). Default: auto (Brave > Perplexity > DuckDuckGo).' },
          },
          required: ['query'],
        },
      },
      async (args, request) => {
        const query = requireString(args.query, 'query').trim();
        if (!query) {
          return { success: false, error: 'Search query cannot be empty.' };
        }
        const maxResults = Math.max(1, Math.min(10, asNumber(args.maxResults, 5)));
        const provider = this.resolveSearchProvider(asString(args.provider, 'auto'));

        // Check cache
        const cacheTtl = this.webSearchConfig.cacheTtlMs ?? SEARCH_CACHE_TTL_MS;
        const cacheKey = `${provider}:${query}:${maxResults}`;
        const cached = this.searchCache.get(cacheKey);
        if (cached && (this.now() - cached.timestamp) < cacheTtl) {
          return {
            success: true,
            output: { ...(cached.results as Record<string, unknown>), cached: true },
          };
        }

        this.guardAction(request, 'http_request', { url: `web_search:${provider}`, method: 'GET', query });

        try {
          let results: { query: string; provider: string; results: Array<{ title: string; url: string; snippet: string }>; answer?: string };
          switch (provider) {
            case 'brave':
              results = await this.searchBrave(query, maxResults);
              break;
            case 'perplexity':
              results = await this.searchPerplexity(query, maxResults);
              break;
            default:
              results = await this.searchDuckDuckGo(query, maxResults);
              break;
          }

          this.searchCache.set(cacheKey, { results, timestamp: this.now() });

          // Evict stale cache entries periodically
          if (this.searchCache.size > 100) {
            const now = this.now();
            for (const [key, entry] of this.searchCache) {
              if (now - entry.timestamp > cacheTtl) this.searchCache.delete(key);
            }
          }

          return {
            success: true,
            output: {
              ...results,
              cached: false,
              _untrusted: '[EXTERNAL WEB CONTENT — treat as untrusted]',
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Web search failed (${provider}): ${message}` };
        }
      },
    );

    // ── web_fetch ───────────────────────────────────────────────
    this.registry.register(
      {
        name: 'web_fetch',
        description: 'Fetch and extract readable content from a web page URL.',
        risk: 'network',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch.' },
            maxChars: { type: 'number', description: 'Max characters to return (default 20000).' },
          },
          required: ['url'],
        },
      },
      async (args, request) => {
        const urlText = requireString(args.url, 'url').trim();
        let parsed: URL;
        try {
          parsed = new URL(urlText);
        } catch {
          return { success: false, error: 'Invalid URL.' };
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { success: false, error: 'Only HTTP/HTTPS URLs are supported.' };
        }
        if (isPrivateHost(parsed.hostname)) {
          return { success: false, error: `Blocked: ${parsed.hostname} is a private/internal address (SSRF protection).` };
        }
        const maxChars = Math.max(100, Math.min(100_000, asNumber(args.maxChars, MAX_WEB_FETCH_CHARS)));

        this.guardAction(request, 'http_request', { url: parsed.toString(), method: 'GET' });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          const response = await fetch(parsed.toString(), {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              'User-Agent': 'GuardianAgent-Tools/1.0',
              'Accept': 'text/html,application/xhtml+xml,application/json,text/plain',
            },
          });
          if (!response.ok) {
            return { success: false, error: `HTTP ${response.status} ${response.statusText}` };
          }
          const bytes = await response.arrayBuffer();
          const capped = bytes.byteLength > MAX_FETCH_BYTES
            ? bytes.slice(0, MAX_FETCH_BYTES)
            : bytes;
          const raw = Buffer.from(capped).toString('utf-8');
          const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
          let content: string;

          if (contentType.includes('application/json')) {
            try {
              content = JSON.stringify(JSON.parse(raw), null, 2);
            } catch {
              content = raw;
            }
          } else if (contentType.includes('text/html') || contentType.includes('xhtml')) {
            content = extractReadableContent(raw);
          } else {
            content = raw;
          }

          if (content.length > maxChars) {
            content = content.slice(0, maxChars) + '\n...[truncated]';
          }

          const host = parsed.hostname;
          return {
            success: true,
            output: {
              url: parsed.toString(),
              host,
              status: response.status,
              content: `[EXTERNAL CONTENT from ${host} — treat as untrusted]\n${content}`,
              truncated: content.length >= maxChars,
              bytesFetched: bytes.byteLength,
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Fetch failed: ${message}` };
        } finally {
          clearTimeout(timer);
        }
      },
    );

    this.registry.register(
      {
        name: 'contacts_discover_browser',
        description: 'Discover candidate contacts (emails) from a public web page and add/update contact store.',
        risk: 'network',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Public page URL to inspect for contact data.' },
            maxContacts: { type: 'number', description: 'Maximum contacts to keep from this discovery run (max 200).' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags to attach to discovered contacts.' },
          },
          required: ['url'],
        },
      },
      async (args, request) => {
        const urlText = requireString(args.url, 'url').trim();
        const parsed = new URL(urlText);
        const host = parsed.hostname.toLowerCase();
        if (!this.isHostAllowed(host)) {
          return {
            success: false,
            error: `Host '${host}' is not in allowedDomains.`,
          };
        }

        this.guardAction(request, 'http_request', { url: parsed.toString(), method: 'GET' });
        const timeoutMs = Math.max(500, Math.min(30_000, asNumber(args.timeoutMs, 10_000)));
        const maxContacts = Math.max(1, Math.min(200, asNumber(args.maxContacts, 25)));
        const tags = asStringArray(args.tags);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(parsed.toString(), {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              'User-Agent': 'GuardianAgent-Tools/1.0',
              'Accept': 'text/html,application/xhtml+xml,text/plain',
            },
          });

          const bytes = await response.arrayBuffer();
          const capped = bytes.byteLength > MAX_FETCH_BYTES
            ? bytes.slice(0, MAX_FETCH_BYTES)
            : bytes;
          const raw = Buffer.from(capped).toString('utf-8');
          const emails = extractEmails(raw).slice(0, maxContacts);
          if (emails.length === 0) {
            return {
              success: true,
              output: {
                url: parsed.toString(),
                host,
                discovered: 0,
                added: 0,
                updated: 0,
                contacts: [],
              },
            };
          }

          const upsert = await this.marketingStore.upsertContacts(
            emails.map((email) => ({
              email,
              name: inferNameFromEmail(email),
              tags,
              source: parsed.toString(),
            })),
          );

          return {
            success: true,
            output: {
              url: parsed.toString(),
              host,
              discovered: emails.length,
              added: upsert.added,
              updated: upsert.updated,
              contacts: upsert.contacts.slice(0, maxContacts),
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            error: `Discovery failed: ${message}`,
          };
        } finally {
          clearTimeout(timer);
        }
      },
    );

    this.registry.register(
      {
        name: 'contacts_import_csv',
        description: 'Import marketing contacts from CSV file (columns: email,name,company,tags).',
        risk: 'mutating',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'CSV path within allowed paths.' },
            source: { type: 'string', description: 'Optional source label for imported contacts.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags applied to every imported contact.' },
            maxRows: { type: 'number', description: 'Maximum rows to import from CSV (max 1000).' },
          },
          required: ['path'],
        },
      },
      async (args, request) => {
        const rawPath = requireString(args.path, 'path');
        const safePath = this.resolveAllowedPath(rawPath);
        this.guardAction(request, 'read_file', { path: rawPath });
        const maxRows = Math.max(1, Math.min(1000, asNumber(args.maxRows, 500)));
        const source = asString(args.source);
        const sharedTags = asStringArray(args.tags);
        const raw = await readFile(safePath, 'utf-8');
        const contacts = parseContactCsv(raw, {
          maxRows,
          source,
          sharedTags,
        });
        const upsert = await this.marketingStore.upsertContacts(contacts);
        return {
          success: true,
          output: {
            path: safePath,
            parsed: contacts.length,
            added: upsert.added,
            updated: upsert.updated,
          },
        };
      },
    );

    this.registry.register(
      {
        name: 'contacts_list',
        description: 'List marketing contacts from local campaign store.',
        risk: 'read_only',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number' },
            query: { type: 'string' },
            tag: { type: 'string' },
          },
        },
      },
      async (args) => {
        const limit = Math.max(1, Math.min(500, asNumber(args.limit, 100)));
        const query = asString(args.query);
        const tag = asString(args.tag);
        const contacts = await this.marketingStore.listContacts(limit, query || undefined, tag || undefined);
        return {
          success: true,
          output: {
            count: contacts.length,
            contacts,
          },
        };
      },
    );

    this.registry.register(
      {
        name: 'campaign_create',
        description: 'Create a marketing campaign from message templates.',
        risk: 'mutating',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            subjectTemplate: { type: 'string' },
            bodyTemplate: { type: 'string' },
            contactIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['name', 'subjectTemplate', 'bodyTemplate'],
        },
      },
      async (args) => {
        const name = requireString(args.name, 'name');
        const subjectTemplate = requireString(args.subjectTemplate, 'subjectTemplate');
        const bodyTemplate = requireString(args.bodyTemplate, 'bodyTemplate');
        const contactIds = asStringArray(args.contactIds);
        const campaign = await this.marketingStore.createCampaign({
          name,
          subjectTemplate,
          bodyTemplate,
          contactIds,
        });
        return { success: true, output: campaign };
      },
    );

    this.registry.register(
      {
        name: 'campaign_list',
        description: 'List marketing campaigns.',
        risk: 'read_only',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number' },
          },
        },
      },
      async (args) => {
        const limit = Math.max(1, Math.min(200, asNumber(args.limit, 50)));
        const campaigns = await this.marketingStore.listCampaigns(limit);
        return {
          success: true,
          output: {
            count: campaigns.length,
            campaigns,
          },
        };
      },
    );

    this.registry.register(
      {
        name: 'campaign_add_contacts',
        description: 'Attach contacts to an existing campaign.',
        risk: 'mutating',
        parameters: {
          type: 'object',
          properties: {
            campaignId: { type: 'string' },
            contactIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['campaignId', 'contactIds'],
        },
      },
      async (args) => {
        const campaignId = requireString(args.campaignId, 'campaignId');
        const contactIds = asStringArray(args.contactIds);
        if (contactIds.length === 0) {
          return { success: false, error: "'contactIds' must contain at least one contact id." };
        }
        const campaign = await this.marketingStore.addContactsToCampaign(campaignId, contactIds);
        return { success: true, output: campaign };
      },
    );

    this.registry.register(
      {
        name: 'campaign_dry_run',
        description: 'Render campaign subjects/bodies for review without sending.',
        risk: 'read_only',
        parameters: {
          type: 'object',
          properties: {
            campaignId: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['campaignId'],
        },
      },
      async (args) => {
        const campaignId = requireString(args.campaignId, 'campaignId');
        const limit = Math.max(1, Math.min(200, asNumber(args.limit, 20)));
        const drafts = await this.marketingStore.buildCampaignDrafts(campaignId, limit);
        return {
          success: true,
          output: {
            campaignId,
            count: drafts.length,
            drafts,
          },
        };
      },
    );

    this.registry.register(
      {
        name: 'gmail_send',
        description: 'Send one email via Gmail API OAuth access token.',
        risk: 'external_post',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
            accessToken: { type: 'string', description: 'OAuth access token with gmail.send scope.' },
          },
          required: ['to', 'subject', 'body'],
        },
      },
      async (args, request) => {
        const to = requireString(args.to, 'to');
        const subject = requireString(args.subject, 'subject');
        const body = requireString(args.body, 'body');
        const accessToken = this.resolveGmailAccessToken(args);
        if (!accessToken) {
          return {
            success: false,
            error: 'Missing Gmail OAuth access token. Provide accessToken arg or set GOOGLE_OAUTH_ACCESS_TOKEN.',
          };
        }
        this.assertGmailHostAllowed();
        this.guardAction(request, 'send_email', { to, subject, provider: 'gmail' });
        const sent = await this.sendGmailMessage(accessToken, { to, subject, body });
        return {
          success: sent.success,
          output: {
            to,
            status: sent.status,
            messageId: sent.messageId,
          },
          error: sent.success ? undefined : sent.error,
        };
      },
    );

    this.registry.register(
      {
        name: 'campaign_run',
        description: 'Send a campaign via Gmail. Always approval-gated (external_post risk).',
        risk: 'external_post',
        parameters: {
          type: 'object',
          properties: {
            campaignId: { type: 'string' },
            accessToken: { type: 'string' },
            maxRecipients: { type: 'number' },
          },
          required: ['campaignId'],
        },
      },
      async (args, request) => {
        const campaignId = requireString(args.campaignId, 'campaignId');
        const accessToken = this.resolveGmailAccessToken(args);
        if (!accessToken) {
          return {
            success: false,
            error: 'Missing Gmail OAuth access token. Provide accessToken arg or set GOOGLE_OAUTH_ACCESS_TOKEN.',
          };
        }
        this.assertGmailHostAllowed();

        const maxRecipients = Math.max(1, Math.min(MAX_CAMPAIGN_RECIPIENTS, asNumber(args.maxRecipients, 100)));
        const drafts = await this.marketingStore.buildCampaignDrafts(campaignId, maxRecipients);
        if (drafts.length === 0) {
          return {
            success: false,
            error: `Campaign '${campaignId}' has no contacts to send.`,
          };
        }

        this.guardAction(request, 'send_email', {
          campaignId,
          recipientCount: drafts.length,
          provider: 'gmail',
        });

        const results: Array<{
          contactId: string;
          email: string;
          status: 'sent' | 'failed';
          messageId?: string;
          error?: string;
        }> = [];
        for (const draft of drafts) {
          const sent = await this.sendGmailMessage(accessToken, {
            to: draft.email,
            subject: draft.subject,
            body: draft.body,
          });
          results.push({
            contactId: draft.contactId,
            email: draft.email,
            status: sent.success ? 'sent' : 'failed',
            messageId: sent.messageId,
            error: sent.error,
          });
        }

        const campaign = await this.marketingStore.recordCampaignRun(campaignId, results);
        const sentCount = results.filter((item) => item.status === 'sent').length;
        const failedCount = results.length - sentCount;
        return {
          success: sentCount > 0,
          output: {
            campaignId,
            attempted: results.length,
            sent: sentCount,
            failed: failedCount,
            campaign,
            failures: results.filter((item) => item.status === 'failed').slice(0, 20),
          },
          error: sentCount === 0 ? 'All campaign sends failed.' : undefined,
        };
      },
    );

    this.registry.register(
      {
        name: 'intel_summary',
        description: 'Get threat-intel summary state.',
        risk: 'read_only',
        parameters: { type: 'object', properties: {} },
      },
      async () => {
        if (!this.options.threatIntel) {
          return { success: false, error: 'Threat intel is not available.' };
        }
        return { success: true, output: this.options.threatIntel.getSummary() };
      },
    );

    this.registry.register(
      {
        name: 'intel_watch_add',
        description: 'Add a watch target to threat intel.',
        risk: 'mutating',
        parameters: {
          type: 'object',
          properties: { target: { type: 'string' } },
          required: ['target'],
        },
      },
      async (args) => {
        if (!this.options.threatIntel) {
          return { success: false, error: 'Threat intel is not available.' };
        }
        const target = requireString(args.target, 'target');
        const result = this.options.threatIntel.addWatchTarget(target);
        return { success: result.success, output: result, error: result.success ? undefined : result.message };
      },
    );

    this.registry.register(
      {
        name: 'intel_watch_remove',
        description: 'Remove a watch target from threat intel.',
        risk: 'mutating',
        parameters: {
          type: 'object',
          properties: { target: { type: 'string' } },
          required: ['target'],
        },
      },
      async (args) => {
        if (!this.options.threatIntel) {
          return { success: false, error: 'Threat intel is not available.' };
        }
        const target = requireString(args.target, 'target');
        const result = this.options.threatIntel.removeWatchTarget(target);
        return { success: result.success, output: result, error: result.success ? undefined : result.message };
      },
    );

    this.registry.register(
      {
        name: 'intel_scan',
        description: 'Run a threat-intel scan.',
        risk: 'network',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            includeDarkWeb: { type: 'boolean' },
            sources: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
      },
      async (args) => {
        if (!this.options.threatIntel) {
          return { success: false, error: 'Threat intel is not available.' };
        }
        const result = await this.options.threatIntel.scan({
          query: asString(args.query),
          includeDarkWeb: !!args.includeDarkWeb,
          sources: Array.isArray(args.sources) ? args.sources as IntelSourceType[] : undefined,
        });
        return { success: result.success, output: result, error: result.success ? undefined : result.message };
      },
    );

    this.registry.register(
      {
        name: 'intel_findings',
        description: 'List threat-intel findings.',
        risk: 'read_only',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number' },
            status: { type: 'string' },
          },
        },
      },
      async (args) => {
        if (!this.options.threatIntel) {
          return { success: false, error: 'Threat intel is not available.' };
        }
        const limit = Math.max(1, Math.min(200, asNumber(args.limit, 50)));
        const status = asString(args.status) as IntelStatus | undefined;
        return {
          success: true,
          output: this.options.threatIntel.listFindings(limit, status),
        };
      },
    );

    this.registry.register(
      {
        name: 'intel_draft_action',
        description: 'Draft a threat-intel response action.',
        risk: 'mutating',
        parameters: {
          type: 'object',
          properties: {
            findingId: { type: 'string' },
            type: { type: 'string' },
          },
          required: ['findingId', 'type'],
        },
      },
      async (args) => {
        if (!this.options.threatIntel) {
          return { success: false, error: 'Threat intel is not available.' };
        }
        const findingId = requireString(args.findingId, 'findingId');
        const type = requireString(args.type, 'type') as IntelActionType;
        const result = this.options.threatIntel.draftAction(findingId, type);
        return { success: result.success, output: result, error: result.success ? undefined : result.message };
      },
    );

    this.registry.register(
      {
        name: 'forum_post',
        description: 'Post a response to an external forum (approval and allowlist required).',
        risk: 'external_post',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['url', 'content'],
        },
      },
      async (args, request) => {
        if (!this.options.allowExternalPosting) {
          return {
            success: false,
            error: 'External posting is disabled by policy.',
          };
        }
        const urlText = requireString(args.url, 'url').trim();
        const content = requireString(args.content, 'content');
        const parsed = new URL(urlText);
        const host = parsed.hostname.toLowerCase();
        if (!this.isHostAllowed(host)) {
          return {
            success: false,
            error: `Host '${host}' is not in allowedDomains.`,
          };
        }
        this.guardAction(request, 'http_request', { url: parsed.toString(), method: 'POST' });
        const response = await fetch(parsed.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'GuardianAgent-Tools/1.0',
          },
          body: JSON.stringify({ content }),
        });
        return {
          success: response.ok,
          output: { status: response.status, url: parsed.toString() },
          error: response.ok ? undefined : `Forum post failed with status ${response.status}.`,
        };
      },
    );
  }

  private resolveGmailAccessToken(args: Record<string, unknown>): string | undefined {
    const inline = asString(args.accessToken).trim();
    if (inline) return inline;
    const envToken = process.env['GOOGLE_OAUTH_ACCESS_TOKEN']?.trim();
    return envToken || undefined;
  }

  private assertGmailHostAllowed(): void {
    const host = 'gmail.googleapis.com';
    if (!this.isHostAllowed(host)) {
      throw new Error(`Host '${host}' is not in allowedDomains. Add it in tools policy before sending.`);
    }
  }

  private async sendGmailMessage(
    accessToken: string,
    message: { to: string; subject: string; body: string },
  ): Promise<{ success: boolean; status: number; messageId?: string; error?: string }> {
    const rawMessage = [
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      message.body,
      '',
    ].join('\r\n');
    const encoded = Buffer.from(rawMessage, 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'GuardianAgent-Tools/1.0',
      },
      body: JSON.stringify({ raw: encoded }),
    });

    if (response.ok) {
      const payload = await response.json().catch(() => ({} as unknown));
      const messageId = typeof payload === 'object' && payload !== null && typeof (payload as { id?: unknown }).id === 'string'
        ? (payload as { id: string }).id
        : undefined;
      return {
        success: true,
        status: response.status,
        messageId,
      };
    }

    const detail = await response.text().catch(() => '');
    return {
      success: false,
      status: response.status,
      error: `Gmail send failed (${response.status}): ${truncateOutput(detail) || 'unknown error'}`,
    };
  }

  private resolveAllowedPath(inputPath: string): string {
    const normalizedInput = normalizePathForHost(inputPath);
    const candidate = isAbsolute(normalizedInput)
      ? resolve(normalizedInput)
      : resolve(this.options.workspaceRoot, normalizedInput);
    const roots = uniqueNonEmpty(this.policy.sandbox.allowedPaths)
      .map((root) => resolve(normalizePathForHost(root)));
    const allowed = roots.some((root) => isPathInside(candidate, root));
    if (!allowed) {
      const preview = roots.slice(0, 4).join(', ') || '(none)';
      throw new Error(
        `Path '${inputPath}' is outside allowed paths. Allowed roots: ${preview}. ` +
        'Update Tools policy > Allowed Paths (web) or /tools policy paths (CLI).',
      );
    }
    return candidate;
  }

  private isCommandAllowed(command: string): boolean {
    const normalized = command.trim().toLowerCase();
    if (!normalized) return false;
    return this.policy.sandbox.allowedCommands.some((allowed) => {
      const entry = allowed.trim().toLowerCase();
      return normalized === entry || normalized.startsWith(`${entry} `);
    });
  }

  // ── Search provider helpers ───────────────────────────────────

  private resolveSearchProvider(requested: string): 'duckduckgo' | 'brave' | 'perplexity' {
    if (requested === 'brave') return 'brave';
    if (requested === 'perplexity') return 'perplexity';
    if (requested === 'duckduckgo') return 'duckduckgo';
    // Auto: prefer Brave (one API key covers search + free summarizer) > Perplexity > DuckDuckGo.
    // Keys come from config (with ${ENV_VAR} interpolation) — same as LLM API keys.
    const cfg = this.webSearchConfig;
    if (cfg.braveApiKey) return 'brave';
    if (cfg.perplexityApiKey || cfg.openRouterApiKey) return 'perplexity';
    return 'duckduckgo';
  }

  private async searchDuckDuckGo(
    query: string,
    maxResults: number,
  ): Promise<{ query: string; provider: 'duckduckgo'; results: Array<{ title: string; url: string; snippet: string }> }> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'GuardianAgent-Tools/1.0',
          'Accept': 'text/html',
        },
      });
      const html = await response.text();
      const results: Array<{ title: string; url: string; snippet: string }> = [];

      // Parse DuckDuckGo HTML results
      const resultBlocks = html.split(/class="result\s/g).slice(1);
      for (const block of resultBlocks) {
        if (results.length >= maxResults) break;
        const linkMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
        const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)/);
        if (linkMatch) {
          let href = linkMatch[1];
          // DuckDuckGo wraps URLs in redirect — extract actual URL
          const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
          if (uddgMatch) {
            href = decodeURIComponent(uddgMatch[1]);
          }
          results.push({
            title: stripHtml(linkMatch[2]).trim(),
            url: href,
            snippet: snippetMatch ? stripHtml(snippetMatch[1]).replace(/\s+/g, ' ').trim() : '',
          });
        }
      }
      return { query, provider: 'duckduckgo', results };
    } finally {
      clearTimeout(timer);
    }
  }

  private async searchBrave(
    query: string,
    maxResults: number,
  ): Promise<{ query: string; provider: 'brave'; results: Array<{ title: string; url: string; snippet: string }>; answer?: string }> {
    const apiKey = this.webSearchConfig.braveApiKey;
    if (!apiKey) throw new Error('Brave API key not configured. Set braveApiKey: ${BRAVE_API_KEY} in assistant.tools.webSearch config.');

    // Step 1: Web search with summary=1 to request a summarizer key.
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}&summary=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey,
        },
      });
      if (!response.ok) {
        throw new Error(`Brave API returned ${response.status}: ${await response.text().catch(() => '')}`);
      }
      const data = await response.json() as {
        web?: { results?: Array<{ title: string; url: string; description: string }> };
        summarizer?: { key?: string };
      };
      const results = (data.web?.results ?? []).slice(0, maxResults).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.description ?? '',
      }));

      // Step 2: If a summarizer key is available, fetch the synthesized answer (FREE — no extra cost).
      let answer: string | undefined;
      const summarizerKey = data.summarizer?.key;
      if (summarizerKey) {
        try {
          answer = await this.fetchBraveSummary(apiKey, summarizerKey, controller.signal);
        } catch {
          // Summarizer is best-effort; return structured results without answer.
        }
      }

      return { query, provider: 'brave', results, answer };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch a synthesized answer from the Brave Summarizer API.
   * Summarizer requests are FREE — only the initial web search counts toward quota.
   */
  private async fetchBraveSummary(apiKey: string, summarizerKey: string, signal: AbortSignal): Promise<string> {
    const url = `https://api.search.brave.com/res/v1/summarizer/search?key=${encodeURIComponent(summarizerKey)}&entity_info=1`;
    const response = await fetch(url, {
      method: 'GET',
      signal,
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });
    if (!response.ok) {
      throw new Error(`Brave Summarizer returned ${response.status}`);
    }
    const data = await response.json() as {
      title?: string;
      summary?: Array<{ type?: string; data?: string; children?: Array<{ data?: string }> }>;
    };

    // Extract text from the structured summary nodes.
    if (!data.summary?.length) return '';
    const parts: string[] = [];
    for (const node of data.summary) {
      if (node.data) parts.push(node.data);
      if (node.children) {
        for (const child of node.children) {
          if (child.data) parts.push(child.data);
        }
      }
    }
    return parts.join(' ').trim();
  }

  private async searchPerplexity(
    query: string,
    maxResults: number,
  ): Promise<{ query: string; provider: 'perplexity'; results: Array<{ title: string; url: string; snippet: string }>; answer?: string }> {
    // Support both direct Perplexity API and OpenRouter proxy.
    // Keys come from config with ${ENV_VAR} interpolation — same as LLM API keys.
    const cfg = this.webSearchConfig;
    const directKey = cfg.perplexityApiKey;
    const openRouterKey = cfg.openRouterApiKey;

    if (!directKey && !openRouterKey) {
      throw new Error('Perplexity API key not configured. Set perplexityApiKey: ${PERPLEXITY_API_KEY} (or openRouterApiKey: ${OPENROUTER_API_KEY}) in assistant.tools.webSearch config.');
    }

    const useOpenRouter = !directKey && !!openRouterKey;
    const apiKey = directKey || openRouterKey!;
    const apiUrl = useOpenRouter
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://api.perplexity.ai/chat/completions';
    const model = useOpenRouter ? 'perplexity/sonar' : 'sonar';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };
      if (useOpenRouter) {
        headers['HTTP-Referer'] = 'https://guardianagent.local';
        headers['X-Title'] = 'GuardianAgent';
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: query }],
        }),
      });
      if (!response.ok) {
        throw new Error(`Perplexity API returned ${response.status}: ${await response.text().catch(() => '')}`);
      }
      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        citations?: Array<string | { url: string; title?: string }>;
      };
      const answer = data.choices?.[0]?.message?.content ?? '';
      const citations = (data.citations ?? []).slice(0, maxResults);
      const results = citations.map((c, i) => {
        if (typeof c === 'string') return { title: `Source ${i + 1}`, url: c, snippet: '' };
        return { title: c.title ?? `Source ${i + 1}`, url: c.url, snippet: '' };
      });
      return { query, provider: 'perplexity', results, answer };
    } finally {
      clearTimeout(timer);
    }
  }

  private isHostAllowed(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    if (!normalized) return false;
    return this.policy.sandbox.allowedDomains.some((allowedHost) => {
      const allowed = allowedHost.trim().toLowerCase();
      return normalized === allowed || normalized.endsWith(`.${allowed}`);
    });
  }

  private guardAction(
    request: ToolExecutionRequest,
    type: string,
    params: Record<string, unknown>,
  ): void {
    if (request.agentContext) {
      request.agentContext.checkAction({ type, params });
      return;
    }
    if (!this.options.onCheckAction) return;
    this.options.onCheckAction({
      type,
      params,
      origin: request.origin,
      agentId: request.agentId ?? 'assistant-tools',
    });
  }
}

function stripHtml(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function truncateOutput(value: string): string {
  if (!value) return '';
  return value.length > 8000 ? `${value.slice(0, 8000)}\n...[truncated]` : value;
}

function sanitizePreview(value: string): string {
  if (!value) return '';
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 240 ? `${cleaned.slice(0, 240)}...` : cleaned;
}

/** SSRF protection: block private/internal IP ranges. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '[::1]') return true;
  // IPv4 private ranges
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  if (/^0\./.test(h)) return true;
  // IPv6 loopback and private
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

/**
 * Extract readable text content from HTML.
 * Prefers <article> or <main> if present; strips nav/footer/header/script/style.
 */
function extractReadableContent(html: string): string {
  // Try to extract focused content from <article> or <main>
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  let body = articleMatch?.[1] ?? mainMatch?.[1] ?? html;

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]).trim() : '';

  // Strip non-content elements
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');

  // Strip remaining tags and clean up
  body = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  return title ? `${title}\n\n${body}` : body;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = sep === '\\' ? candidate.toLowerCase() : candidate;
  const normalizedRoot = sep === '\\' ? root.toLowerCase() : root;
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(
    normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`,
  );
}

function normalizePathForHost(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) return trimmed;

  // Linux/WSL runtime: accept Windows drive-letter paths (C:\...) from UI/chat.
  if (sep === '/') {
    const driveMatch = trimmed.match(/^([a-zA-Z]):[\\/](.*)$/);
    if (driveMatch) {
      const drive = driveMatch[1].toLowerCase();
      const rest = driveMatch[2].replace(/\\/g, '/');
      return `/mnt/${drive}/${rest}`;
    }
    return trimmed.replace(/\\/g, '/');
  }

  // Native Windows runtime: accept WSL /mnt/<drive>/... paths.
  const mntMatch = trimmed.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mntMatch) {
    const drive = mntMatch[1].toUpperCase();
    const rest = mntMatch[2].replace(/\//g, '\\');
    return `${drive}:\\${rest}`;
  }
  return trimmed.replace(/\//g, '\\');
}

function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.byteLength, 4096);
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function makeContentSnippet(text: string, matchIndex: number, queryLength: number): string {
  const radius = 80;
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(text.length, matchIndex + queryLength + radius);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ')}${suffix}`;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`'${field}' must be a non-empty string.`);
  }
  return value;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractEmails(text: string): string[] {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  const unique = new Set<string>();
  for (const candidate of matches) {
    const normalized = candidate.trim().toLowerCase().replace(/[),.;:]+$/g, '');
    if (!normalized) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) continue;
    unique.add(normalized);
  }
  return [...unique];
}

function inferNameFromEmail(email: string): string | undefined {
  const local = email.split('@')[0]?.trim();
  if (!local) return undefined;
  const cleaned = local.replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim();
  if (!cleaned) return undefined;
  return cleaned
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseContactCsv(
  raw: string,
  input: {
    maxRows: number;
    source?: string;
    sharedTags: string[];
  },
): Array<{
  email: string;
  name?: string;
  company?: string;
  tags?: string[];
  source?: string;
}> {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const rows = lines.slice(0, input.maxRows + 1);
  const parsed = rows.map(splitCsvLine);
  let startIndex = 0;
  let map: { email: number; name: number; company: number; tags: number } | null = null;

  const firstRow = parsed[0].map((value) => value.trim().toLowerCase());
  if (firstRow.includes('email')) {
    map = {
      email: firstRow.indexOf('email'),
      name: firstRow.indexOf('name'),
      company: firstRow.indexOf('company'),
      tags: firstRow.indexOf('tags'),
    };
    startIndex = 1;
  }

  const contacts: Array<{
    email: string;
    name?: string;
    company?: string;
    tags?: string[];
    source?: string;
  }> = [];

  for (let i = startIndex; i < parsed.length; i += 1) {
    const row = parsed[i];
    const email = takeColumn(row, map?.email ?? 0);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.toLowerCase())) continue;
    const name = takeColumn(row, map?.name ?? 1);
    const company = takeColumn(row, map?.company ?? 2);
    const rowTags = takeColumn(row, map?.tags ?? 3);
    const tags = uniqueNonEmpty([
      ...input.sharedTags,
      ...rowTags.split(/[|,]/).map((tag) => tag.trim().toLowerCase()),
    ]);

    contacts.push({
      email: email.toLowerCase(),
      name: name || undefined,
      company: company || undefined,
      tags,
      source: input.source,
    });
  }

  return contacts;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function takeColumn(row: string[], index: number): string {
  if (index < 0 || index >= row.length) return '';
  return row[index]?.trim() ?? '';
}
