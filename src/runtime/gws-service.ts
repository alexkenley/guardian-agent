/**
 * Google Workspace CLI Service — subprocess wrapper for the `gws` CLI.
 *
 * Calls `gws <service> <resource> <method> --params <JSON>` via child_process
 * and returns parsed JSON results. Auth is handled by the CLI itself
 * (via `gws auth login` or environment variables).
 */

import { exec as execCb, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../util/logging.js';

const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);
const log = createLogger('gws-service');

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT = 512 * 1024; // 512 KB

export interface GWSServiceConfig {
  /** Command to invoke the gws CLI. Default: 'gws' */
  command?: string;
  /** Default timeout for CLI calls in ms. Default: 30000 */
  timeoutMs?: number;
  /** Enabled Google Workspace services. */
  services?: string[];
}

export interface GWSExecuteParams {
  /** Google Workspace service (e.g. 'gmail', 'drive', 'calendar'). */
  service: string;
  /** API resource (e.g. 'users messages', 'files', 'events'). */
  resource: string;
  /** Optional sub-resource. */
  subResource?: string;
  /** API method (e.g. 'list', 'get', 'send', 'create'). */
  method: string;
  /** URL/query parameters as a JSON-serializable object. */
  params?: Record<string, unknown>;
  /** Request body as a JSON-serializable object (for POST/PATCH/PUT). */
  json?: Record<string, unknown>;
  /** Output format: json (default), table, yaml, csv. */
  format?: 'json' | 'table' | 'yaml' | 'csv';
  /** Auto-paginate results. */
  pageAll?: boolean;
  /** Max pages when paginating. */
  pageLimit?: number;
}

export interface GWSResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export class GWSService {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly services: Set<string>;

  constructor(config?: GWSServiceConfig) {
    this.command = config?.command?.trim() || 'gws';
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT;
    this.services = new Set(
      config?.services?.length
        ? config.services.map((s) => s.trim().toLowerCase())
        : ['gmail', 'calendar', 'drive', 'docs', 'sheets'],
    );
  }

  /** Check if a service is enabled. */
  isServiceEnabled(service: string): boolean {
    return this.services.has(service.toLowerCase());
  }

  /** Get list of enabled services. */
  getEnabledServices(): string[] {
    return [...this.services];
  }

  /**
   * Execute a Google Workspace API call via the gws CLI.
   */
  async execute(params: GWSExecuteParams): Promise<GWSResult> {
    const { service, resource, method } = params;

    if (!this.isServiceEnabled(service)) {
      return {
        success: false,
        error: `Service '${service}' is not enabled. Enabled services: ${[...this.services].join(', ')}`,
      };
    }

    // Build command args: gws <service> <resource> [sub-resource] <method> [flags]
    const args: string[] = [service];

    // Normalize resource: accept both "users messages" and "users.messages"
    const normalized = resource.trim().replace(/\./g, ' ');
    const resourceParts = normalized.split(/\s+/);
    args.push(...resourceParts);

    if (params.subResource) {
      args.push(...params.subResource.trim().replace(/\./g, ' ').split(/\s+/));
    }

    args.push(method);

    if (params.params && Object.keys(params.params).length > 0) {
      args.push('--params', JSON.stringify(params.params));
    }
    if (params.json && Object.keys(params.json).length > 0) {
      args.push('--json', JSON.stringify(params.json));
    }
    if (params.format && params.format !== 'json') {
      args.push('--format', params.format);
    }
    if (params.pageAll) {
      args.push('--page-all');
      if (params.pageLimit) {
        args.push('--page-limit', String(params.pageLimit));
      }
    }

    return this.run(args);
  }

  /**
   * Look up the API schema for a Google Workspace service method.
   */
  async schema(schemaPath: string): Promise<GWSResult> {
    return this.run(['schema', schemaPath]);
  }

  /**
   * Check auth status of the gws CLI.
   */
  async authStatus(): Promise<GWSResult> {
    return this.run(['auth', 'status']);
  }

  // ─── Internal ────────────────────────────────────────────

  private async run(args: string[]): Promise<GWSResult> {
    try {
      log.debug({ command: this.command, args }, 'GWS CLI call');

      const stdout = process.platform === 'win32'
        ? (await execAsync(buildShellCommand(this.command, args), {
            timeout: this.timeoutMs,
            maxBuffer: MAX_OUTPUT,
          })).stdout
        : (await execFileAsync(this.command, args, {
            timeout: this.timeoutMs,
            maxBuffer: MAX_OUTPUT,
          })).stdout;

      const output = stdout.trim();
      if (!output) {
        return { success: true, data: null };
      }

      // Try to parse as JSON
      try {
        const parsed = JSON.parse(output);

        // gws returns errors as { error: { code, message, reason } }
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
          const errObj = parsed.error as { code?: number; message?: string; reason?: string };
          return {
            success: false,
            error: errObj.message || JSON.stringify(errObj),
            data: parsed,
          };
        }

        return { success: true, data: parsed };
      } catch {
        // Not JSON — return raw text (e.g. for --format table/csv)
        return { success: true, data: output };
      }
    } catch (err) {
      const stdout = (err as { stdout?: string })?.stdout?.trim();
      const stderr = (err as { stderr?: string })?.stderr?.trim();
      const structured = parseGwsCliOutput(stdout || stderr);
      if (structured) {
        log.warn({ args, err: structured.error }, 'GWS CLI call failed');
        return structured;
      }

      const message = err instanceof Error ? err.message : String(err);
      const detail = stderr ? `${message} — ${stderr}` : stdout ? `${message} — ${stdout}` : message;
      log.warn({ args, err: detail }, 'GWS CLI call failed');
      return { success: false, error: detail };
    }
  }
}

function parseGwsCliOutput(output: string | undefined): GWSResult | null {
  if (!output) return null;

  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const errObj = parsed.error as { code?: number; message?: string; reason?: string };
      return {
        success: false,
        error: errObj.message || JSON.stringify(errObj),
        data: parsed,
      };
    }
    return {
      success: false,
      error: output,
      data: parsed,
    };
  } catch {
    return null;
  }
}

export function buildShellCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return [command, ...args].map((value) => shellQuote(value, platform)).join(' ');
}

function shellQuote(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    if (value === '') return '""';
    if (/^[a-zA-Z0-9_\\\-/.:=@]+$/.test(value)) return value;
    return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`;
  }

  if (value === '') return "''";
  if (/^[a-zA-Z0-9_\-/.:=@]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
