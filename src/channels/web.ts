/**
 * Web channel adapter.
 *
 * Lightweight HTTP server using Node built-in http module.
 * REST API for agent communication + dashboard API + SSE + static file serving.
 *
 * Security:
 *   - Optional bearer token authentication with cookie-session custody when enabled
 *   - Configurable CORS origins (default: same-origin only; wildcard disallowed by config validation)
 *   - Request body size limit (default: 1 MB)
 *   - Path traversal protection for static files
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { join, normalize, extname, resolve, relative, isAbsolute, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { spawn as spawnPty, type IPty } from 'node-pty';
import type { ChannelAdapter, MessageCallback } from './types.js';
import type { DashboardCallbacks, SSEEvent, SSEListener, UIInvalidationEvent } from './web-types.js';
import type { AuditEventType, AuditSeverity } from '../guardian/audit-log.js';
import { createLogger } from '../util/logging.js';
import { timingSafeEqualString } from '../util/crypto-guardrails.js';
import type { AssistantConnectorPlaybookDefinition } from '../config/types.js';
import type { AutomationSaveInput } from '../runtime/automation-save.js';
import {
  isSecurityAlertSeverity,
  isSecurityAlertSource,
  normalizeSecurityAlertSources,
  type SecurityAlertSource,
} from '../runtime/security-alerts.js';
import { isSecurityAlertStatus } from '../runtime/security-alert-lifecycle.js';
import { isSecurityActivityStatus } from '../runtime/security-activity-log.js';
import { isDeploymentProfile, isSecurityOperatingMode } from '../runtime/security-posture.js';
import { buildHardenedEnv } from '../sandbox/index.js';
import {
  inspectCodeWorkspaceFileStructureSync,
  inspectCodeWorkspaceFileStructureTextSync,
} from '../runtime/code-workspace-structure.js';

const log = createLogger('channel:web');

/** Default maximum request body size: 1 MB. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const PRIVILEGED_TICKET_TTL_SECONDS = 300;
const PRIVILEGED_TICKET_MAX_REPLAY_TRACK = 2048;
const PRIVILEGED_TICKET_ISSUE_WINDOW_MS = 5 * 60_000;
const PRIVILEGED_TICKET_ISSUE_LIMIT = 3;
const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_LIMIT = 8;
const AUTH_BLOCK_DURATION_MS = 5 * 60_000;

/** MIME types for static file serving. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export type WebAuthMode = 'bearer_required' | 'disabled';
type PrivilegedTicketAction =
  | 'auth.config'
  | 'auth.rotate'
  | 'auth.reveal'
  | 'connectors.config'
  | 'connectors.pack'
  | 'connectors.playbook'
  | 'guardian.config'
  | 'policy.config'
  | 'tools.policy'
  | 'config.security'
  | 'memory.config'
  | 'search.pick-path'
  | 'killswitch'
  | 'factory-reset';

export interface WebAuthRuntimeConfig {
  mode: WebAuthMode;
  token?: string;
  tokenSource?: 'config' | 'env' | 'ephemeral';
  rotateOnStartup?: boolean;
  sessionTtlMinutes?: number;
}

export interface WebChannelOptions {
  /** Port to listen on. */
  port?: number;
  /** Host to bind to. */
  host?: string;
  /** Default agent to route messages to. */
  defaultAgent?: string;
  /** Bearer token for authentication when auth mode is bearer_required. */
  authToken?: string;
  /** Structured auth configuration. */
  auth?: WebAuthRuntimeConfig;
  /** Allowed CORS origins (default: none / same-origin). Wildcard origins are rejected by config validation. */
  allowedOrigins?: string[];
  /** Maximum request body size in bytes (default: 1 MB). */
  maxBodyBytes?: number;
  /** Directory to serve static frontend files from. */
  staticDir?: string;
  /** Dashboard API callbacks from runtime. */
  dashboard?: DashboardCallbacks;
}

/** Cookie-based session record for server-side token custody. */
interface CookieSession {
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

interface AuthFailureState {
  count: number;
  windowStartedAt: number;
  blockedUntil?: number;
}

interface TicketMintState {
  count: number;
  windowStartedAt: number;
}

const SESSION_COOKIE_NAME = 'guardianagent_sid';
const DEFAULT_SESSION_TTL_MINUTES = 480; // 8 hours
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface ShellOptionDescriptor {
  id: string;
  label: string;
  detail: string;
}

interface TerminalSessionRecord {
  id: string;
  ownerSessionId: string | null;
  pty: IPty;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  codeSessionId?: string | null;
}

type RequestErrorLike = Error & {
  statusCode?: number;
  errorCode?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function trimOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readSurfaceIdFromSearchParams(url: URL): string | undefined {
  return trimOptionalString(url.searchParams.get('surfaceId'));
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeWebAuthMode(value: unknown): WebAuthMode {
  return value === 'disabled' ? 'disabled' : 'bearer_required';
}

function getRequestErrorDetails(err: unknown): { statusCode: number; error: string; errorCode?: string } | null {
  if (!(err instanceof Error)) return null;
  const requestError = err as RequestErrorLike;
  const statusCode = Number(requestError.statusCode);
  if (!Number.isFinite(statusCode) || statusCode < 400 || statusCode > 599) {
    return null;
  }
  return {
    statusCode,
    error: requestError.message || 'Request failed',
    ...(requestError.errorCode ? { errorCode: requestError.errorCode } : {}),
  };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPathWithinRoot(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const rel = relative(normalizedRoot, normalizedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveCodeSessionPath(root: string, requestedPath: string | undefined, fallbackRelative = '.'): string {
  const candidate = trimOptionalString(requestedPath) || fallbackRelative;
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  if (!isPathWithinRoot(root, target)) {
    throw new Error('Path must stay inside the coding session workspace.');
  }
  return target;
}

function toRelativeSessionPath(root: string, target: string): string {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (!isPathWithinRoot(normalizedRoot, normalizedTarget)) {
    throw new Error('Path must stay inside the coding session workspace.');
  }
  const rel = relative(normalizedRoot, normalizedTarget).replace(/\\/g, '/');
  return rel === '' ? '.' : rel;
}

export class WebChannel implements ChannelAdapter {
  readonly name = 'web';
  private server: Server | null = null;
  private onMessage: MessageCallback | null = null;
  private port: number;
  private host: string;
  private authMode: WebAuthMode;
  private authToken: string | undefined;
  private authTokenSource: 'config' | 'env' | 'ephemeral';
  private authRotateOnStartup: boolean;
  private authSessionTtlMinutes?: number;
  private allowedOrigins: string[];
  private maxBodyBytes: number;
  private staticDir: string | undefined;
  private dashboard: DashboardCallbacks;
  private sseClients: Set<ServerResponse> = new Set();
  private readonly terminalSessions = new Map<string, TerminalSessionRecord>();
  private readonly terminalOutputListeners = new Map<string, Set<(data: string) => void>>();
  private readonly terminalExitListeners = new Map<string, Set<(exitCode: number, signal: number) => void>>();
  private readonly privilegedTicketSecret = randomBytes(32);
  private readonly usedPrivilegedTicketNonces = new Map<string, number>();
  private readonly sessions = new Map<string, CookieSession>();
  private readonly authFailures = new Map<string, AuthFailureState>();
  private readonly ticketMintAttempts = new Map<string, TicketMintState>();
  private sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WebChannelOptions = {}) {
    this.port = options.port ?? 3000;
    this.host = options.host ?? 'localhost';
    const auth = options.auth;
    this.authMode = normalizeWebAuthMode(auth?.mode);
    if (auth?.mode && auth.mode !== this.authMode) {
      log.warn({ requestedMode: auth.mode, appliedMode: this.authMode }, 'Ignoring unsupported web auth mode');
    }
    this.authToken = auth?.token ?? options.authToken;
    this.authTokenSource = auth?.tokenSource ?? (options.authToken ? 'config' : 'ephemeral');
    this.authRotateOnStartup = auth?.rotateOnStartup ?? false;
    this.authSessionTtlMinutes = auth?.sessionTtlMinutes;
    this.allowedOrigins = options.allowedOrigins ?? [];
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.staticDir = options.staticDir;
    this.dashboard = options.dashboard ?? {};
  }

  async start(onMessage: MessageCallback): Promise<void> {
    this.onMessage = onMessage;

    this.server = createServer(async (req, res) => {
      // CORS headers — restrict to configured origins
      const origin = req.headers.origin;
      if (origin && this.isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Stream, X-Guardian-Ticket');
      res.setHeader('Access-Control-Allow-Credentials', 'true');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        await this.handleRequest(req, res);
      } catch (err) {
        log.error({ err }, 'Unhandled request error');
        if (!res.headersSent) {
          sendJSON(res, 500, { error: 'Internal server error' });
        }
      }
    });

    // Start periodic session cleanup
    this.sessionCleanupTimer = setInterval(() => this.pruneExpiredSessions(), SESSION_CLEANUP_INTERVAL_MS);

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => {
        log.info({ port: this.port, host: this.host }, 'Web channel started');
        if (this.authMode === 'disabled') {
          log.warn(
            { port: this.port, host: this.host, authMode: this.authMode },
            'Web channel started WITHOUT bearer authentication. Only use this on trusted networks.',
          );
        } else if (!this.authToken) {
          log.warn(
            { port: this.port, host: this.host, authMode: this.authMode },
            'Web channel started WITHOUT strict bearer authentication.',
          );
        }
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    // Stop session cleanup
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
      this.sessionCleanupTimer = null;
    }
    this.sessions.clear();
    this.authFailures.clear();
    this.ticketMintAttempts.clear();

    // Close all SSE connections
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();
    for (const session of this.terminalSessions.values()) {
      try {
        session.pty.kill();
      } catch {
        // Best effort cleanup.
      }
    }
    this.terminalSessions.clear();

    return new Promise((resolve) => {
      if (this.server) {
        // Stop accepting new connections
        this.server.close(() => {
          this.server = null;
          this.onMessage = null;
          log.info('Web channel stopped');
          resolve();
        });

        // Force-close all connections so server.close() resolves immediately.
        // closeAllConnections (Node 18.2+) destroys active sockets;
        // closeIdleConnections is a fallback for idle keep-alive sockets.
        const s = this.server as Server & {
          closeAllConnections?: () => void;
          closeIdleConnections?: () => void;
        };
        s.closeAllConnections?.() ?? s.closeIdleConnections?.();
      } else {
        resolve();
      }
    });
  }

  async send(_userId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    this.emitSSE({
      type: 'assistant.notice',
      data: {
        id: randomUUID(),
        timestamp: Date.now(),
        text,
      },
    });
  }

  /** Returns a CodingBackendTerminalControl implementation for programmatic terminal access. */
  getCodingBackendTerminalControl(): import('./web-types.js').CodingBackendTerminalControl {
    return {
      openTerminal: async (params) => {
        const terminalId = randomUUID();
        const { codeSessionId, shell, cwd, cols = 120, rows = 30 } = params;
        const shellType = shell || (process.platform === 'win32' ? 'wsl' : 'bash');
        const launch = getPtyShellLaunch(shellType, process.platform, cwd);
        const ptyCwd = launch.cwd === null ? undefined : (launch.cwd || cwd || process.cwd());
        const pty = spawnPty(launch.file, launch.args, {
          name: 'xterm-color',
          cols,
          rows,
          cwd: ptyCwd,
          env: buildHardenedEnv({ ...process.env, ...launch.env }),
        });
        const session: TerminalSessionRecord = {
          id: terminalId,
          ownerSessionId: null,
          pty,
          shell: shellType,
          cwd: cwd || process.cwd(),
          cols,
          rows,
          codeSessionId: codeSessionId || null,
        };
        this.terminalSessions.set(terminalId, session);
        this.dashboard.onCodeTerminalEvent?.({
          action: 'opened',
          terminalId,
          shell: session.shell,
          cwd: session.cwd,
          cols: session.cols,
          rows: session.rows,
          codeSessionId: session.codeSessionId ?? null,
        });
        pty.onData((data) => {
          this.emitSSE({ type: 'terminal.output', data: { terminalId, data } });
          const listeners = this.terminalOutputListeners.get(terminalId);
          if (listeners) {
            for (const cb of listeners) { try { cb(data); } catch { /* listener error */ } }
          }
        });
        pty.onExit((event) => {
          const exitListeners = this.terminalExitListeners.get(terminalId);
          if (exitListeners) {
            for (const cb of exitListeners) { try { cb(event.exitCode ?? 1, event.signal ?? 0); } catch { /* listener error */ } }
            this.terminalExitListeners.delete(terminalId);
          }
          this.terminalOutputListeners.delete(terminalId);
          this.terminalSessions.delete(terminalId);
          this.dashboard.onCodeTerminalEvent?.({
            action: 'exited',
            terminalId,
            shell: session.shell,
            cwd: session.cwd,
            cols: session.cols,
            rows: session.rows,
            codeSessionId: session.codeSessionId ?? null,
            exitCode: event.exitCode,
            signal: event.signal,
          });
          this.emitSSE({ type: 'terminal.exit', data: { terminalId, exitCode: event.exitCode, signal: event.signal } });
        });
        return { terminalId };
      },
      writeTerminalInput: (terminalId, input) => {
        const session = this.terminalSessions.get(terminalId);
        if (session) session.pty.write(input);
      },
      closeTerminal: (terminalId) => {
        const session = this.terminalSessions.get(terminalId);
        if (session) session.pty.kill();
      },
      onTerminalOutput: (terminalId, cb) => {
        let set = this.terminalOutputListeners.get(terminalId);
        if (!set) { set = new Set(); this.terminalOutputListeners.set(terminalId, set); }
        set.add(cb);
        return () => { set!.delete(cb); };
      },
      onTerminalExit: (terminalId, cb) => {
        let set = this.terminalExitListeners.get(terminalId);
        if (!set) { set = new Set(); this.terminalExitListeners.set(terminalId, set); }
        set.add(cb);
        return () => { set!.delete(cb); };
      },
    };
  }

  private emitSSE(event: SSEEvent): void {
    if (this.sseClients.size === 0) {
      return;
    }
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    for (const client of this.sseClients) {
      if (!client.destroyed) {
        client.write(payload);
      }
    }
  }

  private emitUIInvalidation(topics: string[], reason: string, path: string): void {
    const deduped = uniqueTopics(topics);
    if (deduped.length === 0) {
      return;
    }
    const event: UIInvalidationEvent = {
      topics: deduped,
      reason,
      path,
      timestamp: Date.now(),
    };
    this.emitSSE({ type: 'ui.invalidate', data: event });
  }

  private maybeEmitUIInvalidation(result: unknown, topics: string[], reason: string, path: string): void {
    if (!isSuccessfulMutationResult(result)) {
      return;
    }
    this.emitUIInvalidation(topics, reason, path);
  }

  /** Check if a request origin is in the allowed list. */
  private isOriginAllowed(origin: string): boolean {
    if (this.allowedOrigins.length === 0) return false;
    if (this.allowedOrigins.includes('*')) return true;
    return this.allowedOrigins.includes(origin);
  }

  private getClientAddress(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private clearAuthFailures(req: IncomingMessage): void {
    this.authFailures.delete(this.getClientAddress(req));
  }

  private getAuthBlockRemainingMs(req: IncomingMessage): number {
    const state = this.authFailures.get(this.getClientAddress(req));
    const blockedUntil = state?.blockedUntil ?? 0;
    return Math.max(0, blockedUntil - Date.now());
  }

  private recordAuthFailure(req: IncomingMessage): number {
    const key = this.getClientAddress(req);
    const now = Date.now();
    const existing = this.authFailures.get(key);
    let next: AuthFailureState;

    if (!existing || now - existing.windowStartedAt >= AUTH_FAILURE_WINDOW_MS) {
      next = { count: 1, windowStartedAt: now };
    } else {
      next = { ...existing, count: existing.count + 1 };
    }

    if (next.count >= AUTH_FAILURE_LIMIT) {
      next.blockedUntil = now + AUTH_BLOCK_DURATION_MS;
    }

    this.authFailures.set(key, next);
    return Math.max(0, (next.blockedUntil ?? 0) - now);
  }

  private sendAuthBlocked(res: ServerResponse, retryAfterMs: number): false {
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    sendJSON(res, 429, { error: 'Too many authentication failures. Try again later.' });
    return false;
  }

  private rejectAuth(req: IncomingMessage, res: ServerResponse, invalidToken: boolean): false {
    const remainingMs = this.getAuthBlockRemainingMs(req);
    if (remainingMs > 0) {
      return this.sendAuthBlocked(res, remainingMs);
    }

    const blockMs = this.recordAuthFailure(req);
    if (blockMs > 0) {
      log.warn({ client: this.getClientAddress(req) }, 'Web auth temporarily blocked after repeated failures');
      return this.sendAuthBlocked(res, blockMs);
    }

    sendJSON(res, invalidToken ? 403 : 401, { error: invalidToken ? 'Invalid token' : 'Authentication required' });
    return false;
  }

  private recordPrivilegedTicketMint(req: IncomingMessage): number {
    const key = this.getClientAddress(req);
    const now = Date.now();
    const existing = this.ticketMintAttempts.get(key);
    let next: TicketMintState;

    if (!existing || now - existing.windowStartedAt >= PRIVILEGED_TICKET_ISSUE_WINDOW_MS) {
      next = { count: 1, windowStartedAt: now };
    } else {
      next = { ...existing, count: existing.count + 1 };
    }

    this.ticketMintAttempts.set(key, next);
    if (next.count <= PRIVILEGED_TICKET_ISSUE_LIMIT) {
      return 0;
    }
    return Math.max(0, (next.windowStartedAt + PRIVILEGED_TICKET_ISSUE_WINDOW_MS) - now);
  }

  private sendPrivilegedTicketRateLimited(res: ServerResponse, retryAfterMs: number): void {
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    sendJSON(res, 429, { error: 'Too many privileged ticket requests. Try again later.' });
  }

  private hasNestedPath(value: unknown, path: readonly string[]): boolean {
    if (path.length === 0) return true;
    const record = asRecord(value);
    if (!record) return false;
    const [head, ...rest] = path;
    if (!hasOwn(record, head)) return false;
    return rest.length === 0
      ? true
      : this.hasNestedPath(record[head], rest);
  }

  private getConfigPrivilegedAction(value: unknown): PrivilegedTicketAction | null {
    const touchesSecurity = this.hasNestedPath(value, ['guardian'])
      || this.hasNestedPath(value, ['assistant', 'security'])
      || this.hasNestedPath(value, ['assistant', 'tools', 'policyMode'])
      || this.hasNestedPath(value, ['assistant', 'tools', 'toolPolicies']);
    if (touchesSecurity) {
      return 'config.security';
    }

    const touchesMemory = this.hasNestedPath(value, ['assistant', 'memory', 'knowledgeBase'])
      || this.hasNestedPath(value, ['assistant', 'memory', 'semanticSearch'])
      || this.hasNestedPath(value, ['assistant', 'memory', 'knowledgeBase', 'semanticSearch']);
    return touchesMemory ? 'memory.config' : null;
  }

  setAuthConfig(auth: WebAuthRuntimeConfig): void {
    this.authMode = normalizeWebAuthMode(auth.mode);
    if (auth.mode !== this.authMode) {
      log.warn({ requestedMode: auth.mode, appliedMode: this.authMode }, 'Ignoring unsupported web auth mode update');
    }
    this.authToken = auth.token?.trim() || undefined;
    this.authTokenSource = auth.tokenSource ?? this.authTokenSource;
    this.authRotateOnStartup = auth.rotateOnStartup ?? this.authRotateOnStartup;
    this.authSessionTtlMinutes = auth.sessionTtlMinutes;
  }

  getAuthStatus(): {
    mode: WebAuthMode;
    tokenConfigured: boolean;
    tokenSource: 'config' | 'env' | 'ephemeral';
    tokenPreview?: string;
    rotateOnStartup: boolean;
    sessionTtlMinutes?: number;
    host: string;
    port: number;
  } {
    return {
      mode: this.authMode,
      tokenConfigured: !!this.authToken,
      tokenSource: this.authTokenSource,
      tokenPreview: this.authToken ? previewToken(this.authToken) : undefined,
      rotateOnStartup: this.authRotateOnStartup,
      sessionTtlMinutes: this.authSessionTtlMinutes,
      host: this.host,
      port: this.port,
    };
  }

  getAuthToken(): string | undefined {
    return this.authToken;
  }

  private shouldRequireAuth(req: IncomingMessage): boolean {
    void req;
    return this.authMode === 'bearer_required';
  }

  /** Parse a cookie value from the request. */
  private parseCookie(req: IncomingMessage, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === name) return rest.join('=');
    }
    return undefined;
  }

  /** Validate a session cookie. Returns true if valid and not expired. */
  private validateSessionCookie(req: IncomingMessage): boolean {
    const sid = this.parseCookie(req, SESSION_COOKIE_NAME);
    if (!sid) return false;
    const session = this.sessions.get(sid);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sid);
      return false;
    }
    return true;
  }

  /** Prune expired sessions. */
  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [sid, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(sid);
      }
    }
  }

  /** Verify bearer token authentication. Returns true if auth passes. */
  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.shouldRequireAuth(req)) return true;
    if (!this.authToken) {
      sendJSON(res, 401, { error: 'Authentication required' });
      return false;
    }

    // Try bearer token first
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (timingSafeEqualString(this.authToken, token)) {
        this.clearAuthFailures(req);
        return true;
      }
    }

    // Then try session cookie
    if (this.validateSessionCookie(req)) {
      this.clearAuthFailures(req);
      return true;
    }

    return this.rejectAuth(req, res, !!authHeader);
  }

  private resolveRequestPrincipal(req: IncomingMessage): { principalId: string; principalRole: import('../tools/types.js').PrincipalRole } {
    const sid = this.parseCookie(req, SESSION_COOKIE_NAME);
    if (sid && this.sessions.has(sid)) {
      return { principalId: `web-session:${sid}`, principalRole: 'owner' };
    }
    if (this.authMode === 'disabled') {
      return { principalId: 'web-open', principalRole: 'owner' };
    }
    return { principalId: 'web-bearer', principalRole: 'owner' };
  }

  /** Check auth for SSE via bearer header (non-browser clients) or session cookie (browser EventSource). */
  private checkAuthForSSE(req: IncomingMessage, _url: URL, res: ServerResponse): boolean {
    if (!this.shouldRequireAuth(req)) return true;
    if (!this.authToken) {
      sendJSON(res, 401, { error: 'Authentication required' });
      return false;
    }

    // Allow bearer header for non-browser SSE clients
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (timingSafeEqualString(this.authToken, token)) {
        this.clearAuthFailures(req);
        return true;
      }
    }

    // Browser EventSource path: authenticated cookie session.
    if (this.validateSessionCookie(req)) {
      this.clearAuthFailures(req);
      return true;
    }

    const remainingMs = this.getAuthBlockRemainingMs(req);
    if (remainingMs > 0) {
      return this.sendAuthBlocked(res, remainingMs);
    }

    const blockMs = this.recordAuthFailure(req);
    if (blockMs > 0) {
      log.warn({ client: this.getClientAddress(req) }, 'Web auth temporarily blocked after repeated SSE failures');
      return this.sendAuthBlocked(res, blockMs);
    }

    if (authHeader) {
      sendJSON(res, 403, { error: 'Invalid token' });
    } else {
      sendJSON(res, 401, {
        error: 'Authentication required. SSE requires an authenticated session cookie or Authorization header.',
      });
    }
    return false;
  }

  private isPrivilegedTicketAction(value: string): value is PrivilegedTicketAction {
    return value === 'auth.config'
      || value === 'auth.rotate'
      || value === 'auth.reveal'
      || value === 'connectors.config'
      || value === 'connectors.pack'
      || value === 'connectors.playbook'
      || value === 'guardian.config'
      || value === 'policy.config'
      || value === 'tools.policy'
      || value === 'config.security'
      || value === 'memory.config'
      || value === 'search.pick-path'
      || value === 'killswitch'
      || value === 'factory-reset';
  }

  private mintPrivilegedTicket(action: PrivilegedTicketAction): string {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString('hex');
    const payload = `${action}|${ts}|${nonce}`;
    const signature = createHmac('sha256', this.privilegedTicketSecret).update(payload).digest('hex');
    return Buffer.from(`${payload}|${signature}`, 'utf8').toString('base64url');
  }

  private pruneTicketReplayCache(nowSec: number): void {
    const nowMs = nowSec * 1000;
    for (const [nonce, expiresAt] of this.usedPrivilegedTicketNonces) {
      if (expiresAt <= nowMs) {
        this.usedPrivilegedTicketNonces.delete(nonce);
      }
    }
    while (this.usedPrivilegedTicketNonces.size > PRIVILEGED_TICKET_MAX_REPLAY_TRACK) {
      const first = this.usedPrivilegedTicketNonces.keys().next();
      if (first.done) break;
      this.usedPrivilegedTicketNonces.delete(first.value);
    }
  }

  private verifyPrivilegedTicket(
    ticket: string,
    expectedAction: PrivilegedTicketAction,
  ): { valid: boolean; error?: string } {
    let decoded = '';
    try {
      decoded = Buffer.from(ticket, 'base64url').toString('utf8');
    } catch {
      return { valid: false, error: 'Invalid privileged ticket encoding' };
    }

    const parts = decoded.split('|');
    if (parts.length !== 4) {
      return { valid: false, error: 'Invalid privileged ticket format' };
    }

    const [action, tsRaw, nonce, signature] = parts;
    if (action !== expectedAction) {
      return { valid: false, error: 'Privileged ticket action mismatch' };
    }
    if (!/^\d+$/.test(tsRaw)) {
      return { valid: false, error: 'Invalid privileged ticket timestamp' };
    }
    if (!/^[a-f0-9]{32}$/i.test(nonce)) {
      return { valid: false, error: 'Invalid privileged ticket nonce' };
    }
    if (!/^[a-f0-9]{64}$/i.test(signature)) {
      return { valid: false, error: 'Invalid privileged ticket signature' };
    }

    const issuedAtSec = Number.parseInt(tsRaw, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(issuedAtSec) || Math.abs(nowSec - issuedAtSec) > PRIVILEGED_TICKET_TTL_SECONDS) {
      return { valid: false, error: 'Privileged ticket expired' };
    }

    this.pruneTicketReplayCache(nowSec);
    if (this.usedPrivilegedTicketNonces.has(nonce)) {
      return { valid: false, error: 'Privileged ticket replay detected' };
    }

    const payload = `${action}|${tsRaw}|${nonce}`;
    const expectedSignature = createHmac('sha256', this.privilegedTicketSecret).update(payload).digest('hex');
    if (!timingSafeEqualString(expectedSignature, signature)) {
      return { valid: false, error: 'Invalid privileged ticket signature' };
    }

    this.usedPrivilegedTicketNonces.set(
      nonce,
      (nowSec + PRIVILEGED_TICKET_TTL_SECONDS) * 1000,
    );
    return { valid: true };
  }

  private getPrivilegedTicket(req: IncomingMessage, url: URL, bodyTicket?: string): string | undefined {
    if (bodyTicket?.trim()) return bodyTicket.trim();
    const header = req.headers['x-guardian-ticket'];
    if (typeof header === 'string' && header.trim()) return header.trim();
    const queryTicket = url.searchParams.get('ticket');
    if (queryTicket?.trim()) return queryTicket.trim();
    return undefined;
  }

  private requirePrivilegedTicket(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    action: PrivilegedTicketAction,
    bodyTicket?: string,
  ): boolean {
    const ticket = this.getPrivilegedTicket(req, url, bodyTicket);
    if (!ticket) {
      sendJSON(res, 401, { error: 'Privileged ticket required' });
      return false;
    }
    const verify = this.verifyPrivilegedTicket(ticket, action);
    if (!verify.valid) {
      sendJSON(res, 403, { error: verify.error ?? 'Invalid privileged ticket' });
      return false;
    }
    return true;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.host}:${this.port}`);

    // GET /health — Health check (no auth required)
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJSON(res, 200, { status: 'ok', timestamp: Date.now() });
      return;
    }

    // ─── API + SSE routes (require auth) ───────────────────────

    if (url.pathname.startsWith('/api/') || url.pathname === '/sse') {
      // SSE uses cookie session auth (or bearer header for non-browser clients).
      if (url.pathname === '/sse') {
        if (!this.checkAuthForSSE(req, url, res)) return;
      } else {
        if (!this.checkAuth(req, res)) return;
      }

      // GET /api/status — Runtime status
      if (req.method === 'GET' && url.pathname === '/api/status') {
        sendJSON(res, 200, {
          status: 'running',
          timestamp: Date.now(),
          platform: process.platform,
          shellOptions: getShellOptionsForPlatform(process.platform),
        });
        return;
      }

      // GET /api/auth/status — web auth runtime status
      if (req.method === 'GET' && url.pathname === '/api/auth/status') {
        if (!this.dashboard.onAuthStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onAuthStatus());
        return;
      }

      // POST /api/auth/session — create HttpOnly session cookie (usually exchanges bearer token for cookie)
      if (req.method === 'POST' && url.pathname === '/api/auth/session') {
        // At this point checkAuth already validated the request under the active auth mode.
        const ttlMinutes = this.authSessionTtlMinutes ?? DEFAULT_SESSION_TTL_MINUTES;
        const now = Date.now();
        const sessionId = randomUUID();
        const session: CookieSession = {
          sessionId,
          createdAt: now,
          expiresAt: now + ttlMinutes * 60 * 1000,
        };
        this.sessions.set(sessionId, session);

        const isSecure = req.headers['x-forwarded-proto'] === 'https'
          || (req.socket as { encrypted?: boolean }).encrypted === true;
        const cookieFlags = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttlMinutes * 60}${isSecure ? '; Secure' : ''}`;
        res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${sessionId}; ${cookieFlags}`);
        sendJSON(res, 200, { success: true, expiresAt: session.expiresAt });
        return;
      }

      // DELETE /api/auth/session — destroy session cookie
      if (req.method === 'DELETE' && url.pathname === '/api/auth/session') {
        const sid = this.parseCookie(req, SESSION_COOKIE_NAME);
        if (sid) {
          this.sessions.delete(sid);
        }
        res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        sendJSON(res, 200, { success: true });
        return;
      }

      // POST /api/auth/ticket — issue short-lived HMAC ticket for privileged auth operations
      if (req.method === 'POST' && url.pathname === '/api/auth/ticket') {
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { action?: string };
        try {
          parsed = body.trim() ? (JSON.parse(body) as { action?: string }) : {};
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        const action = (parsed.action ?? '').trim();
        if (!this.isPrivilegedTicketAction(action)) {
          sendJSON(res, 400, { error: 'Invalid privileged action' });
          return;
        }
        const retryAfterMs = this.recordPrivilegedTicketMint(req);
        if (retryAfterMs > 0) {
          this.sendPrivilegedTicketRateLimited(res, retryAfterMs);
          return;
        }
        const ticket = this.mintPrivilegedTicket(action);
        sendJSON(res, 200, {
          action,
          ticket,
          expiresIn: PRIVILEGED_TICKET_TTL_SECONDS,
        });
        return;
      }

      // POST /api/auth/config — update auth mode and token settings
      if (req.method === 'POST' && url.pathname === '/api/auth/config') {
        if (!this.dashboard.onAuthUpdate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: {
          mode?: 'bearer_required' | 'disabled';
          token?: string;
          rotateOnStartup?: boolean;
          sessionTtlMinutes?: number;
          ticket?: string;
        };
        try {
          parsed = body.trim()
            ? (JSON.parse(body) as {
              mode?: 'bearer_required' | 'disabled';
              token?: string;
              rotateOnStartup?: boolean;
              sessionTtlMinutes?: number;
              ticket?: string;
            })
            : {};
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!this.requirePrivilegedTicket(req, res, url, 'auth.config', parsed.ticket)) {
          return;
        }
        const result = await this.dashboard.onAuthUpdate(parsed);
        sendJSON(res, 200, result);
        return;
      }

      // POST /api/auth/token/rotate — rotate bearer token
      if (req.method === 'POST' && url.pathname === '/api/auth/token/rotate') {
        if (!this.dashboard.onAuthRotate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { ticket?: string } = {};
        if (body.trim()) {
          try {
            parsed = JSON.parse(body) as { ticket?: string };
          } catch {
            sendJSON(res, 400, { error: 'Invalid JSON' });
            return;
          }
        }
        if (!this.requirePrivilegedTicket(req, res, url, 'auth.rotate', parsed.ticket)) {
          return;
        }
        sendJSON(res, 200, await this.dashboard.onAuthRotate());
        return;
      }

      // POST /api/auth/token/reveal — reveal current bearer token
      if (req.method === 'POST' && url.pathname === '/api/auth/token/reveal') {
        if (!this.dashboard.onAuthReveal) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { ticket?: string } = {};
        if (body.trim()) {
          try {
            parsed = JSON.parse(body) as { ticket?: string };
          } catch {
            sendJSON(res, 400, { error: 'Invalid JSON' });
            return;
          }
        }
        if (!this.requirePrivilegedTicket(req, res, url, 'auth.reveal', parsed.ticket)) {
          return;
        }
        sendJSON(res, 200, await this.dashboard.onAuthReveal());
        return;
      }

      // GET /api/tools — tools catalog + policy + jobs + approvals
      if (req.method === 'GET' && url.pathname === '/api/tools') {
        if (!this.dashboard.onToolsState) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
        sendJSON(res, 200, this.dashboard.onToolsState({ limit: Number.isFinite(limit) ? limit : 50 }));
        return;
      }

      // GET /api/skills — loaded skills and runtime status
      if (req.method === 'GET' && url.pathname === '/api/skills') {
        if (!this.dashboard.onSkillsState) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onSkillsState());
        return;
      }

      // POST /api/skills — enable/disable one runtime skill
      if (req.method === 'POST' && url.pathname === '/api/skills') {
        if (!this.dashboard.onSkillsUpdate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { skillId?: string; enabled?: boolean };
        try {
          parsed = JSON.parse(body) as { skillId?: string; enabled?: boolean };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.skillId || typeof parsed.enabled !== 'boolean') {
          sendJSON(res, 400, { error: 'skillId and enabled are required' });
          return;
        }
        const result = this.dashboard.onSkillsUpdate({
          skillId: parsed.skillId,
          enabled: parsed.enabled,
        });
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['config', 'skills'], 'skills.updated', url.pathname);
        return;
      }

      // POST /api/tools/run — execute a tool
      if (req.method === 'POST' && url.pathname === '/api/tools/run') {
        if (!this.dashboard.onToolsRun) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: {
          toolName?: string;
          args?: Record<string, unknown>;
          origin?: 'assistant' | 'cli' | 'web';
          agentId?: string;
          userId?: string;
          surfaceId?: string;
          contentTrustLevel?: 'trusted' | 'low_trust' | 'quarantined';
          taintReasons?: string[];
          derivedFromTaintedContent?: boolean;
          scheduleId?: string;
          channel?: string;
          metadata?: Record<string, unknown>;
        };
        try {
          parsed = JSON.parse(body) as {
            toolName?: string;
            args?: Record<string, unknown>;
          origin?: 'assistant' | 'cli' | 'web';
          agentId?: string;
          userId?: string;
          surfaceId?: string;
          contentTrustLevel?: 'trusted' | 'low_trust' | 'quarantined';
          taintReasons?: string[];
          derivedFromTaintedContent?: boolean;
            scheduleId?: string;
            channel?: string;
            metadata?: Record<string, unknown>;
          };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.toolName) {
          sendJSON(res, 400, { error: 'toolName is required' });
          return;
        }
        const principal = this.resolveRequestPrincipal(req);
        const result = await this.dashboard.onToolsRun({
          toolName: parsed.toolName,
          args: parsed.args ?? {},
          origin: parsed.origin ?? 'web',
          agentId: parsed.agentId,
          userId: parsed.userId ?? 'web-user',
          surfaceId: trimOptionalString(parsed.surfaceId),
          principalId: principal.principalId,
          principalRole: principal.principalRole,
          contentTrustLevel: parsed.contentTrustLevel === 'quarantined'
            ? 'quarantined'
            : parsed.contentTrustLevel === 'low_trust'
              ? 'low_trust'
              : parsed.contentTrustLevel === 'trusted'
                ? 'trusted'
                : undefined,
          taintReasons: Array.isArray(parsed.taintReasons)
            ? parsed.taintReasons.filter((value): value is string => typeof value === 'string')
            : undefined,
          derivedFromTaintedContent: parsed.derivedFromTaintedContent === true,
          scheduleId: typeof parsed.scheduleId === 'string' ? parsed.scheduleId : undefined,
          channel: parsed.channel ?? 'web',
          metadata: asRecord(parsed.metadata),
        });
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, toolInvalidationTopics(parsed.toolName), 'tools.run', url.pathname);
        return;
      }

      // POST /api/tools/preflight — pre-flight approval check for automation tools
      if (req.method === 'POST' && url.pathname === '/api/tools/preflight') {
        if (!this.dashboard.onToolsPreflight) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { tools?: string[]; requests?: Array<{ name?: string; args?: Record<string, unknown> }> };
        try {
          parsed = body.trim() ? (JSON.parse(body) as { tools?: string[]; requests?: Array<{ name?: string; args?: Record<string, unknown> }> }) : {};
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        const tools = Array.isArray(parsed.tools) ? parsed.tools.filter((t): t is string => typeof t === 'string') : [];
        const requests = Array.isArray(parsed.requests)
          ? parsed.requests
            .filter((item): item is { name: string; args?: Record<string, unknown> } =>
              !!item && typeof item.name === 'string' && item.name.trim().length > 0)
            .map((item) => ({ name: item.name, ...(item.args && typeof item.args === 'object' ? { args: item.args } : {}) }))
          : [];
        if (tools.length === 0 && requests.length === 0) {
          sendJSON(res, 400, { error: 'tools array or requests array is required' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onToolsPreflight({ tools, requests }));
        return;
      }

      // POST /api/tools/policy — update tool policy/sandbox
      if (req.method === 'POST' && url.pathname === '/api/tools/policy') {
        if (!this.dashboard.onToolsPolicyUpdate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: {
          mode?: 'approve_each' | 'approve_by_policy' | 'autonomous';
          toolPolicies?: Record<string, 'auto' | 'policy' | 'manual' | 'deny'>;
          sandbox?: {
            allowedPaths?: string[];
            allowedCommands?: string[];
            allowedDomains?: string[];
          };
          ticket?: string;
        };
        try {
          parsed = body.trim()
            ? (JSON.parse(body) as {
              mode?: 'approve_each' | 'approve_by_policy' | 'autonomous';
              toolPolicies?: Record<string, 'auto' | 'policy' | 'manual' | 'deny'>;
              sandbox?: {
                allowedPaths?: string[];
                allowedCommands?: string[];
                allowedDomains?: string[];
              };
              ticket?: string;
            })
            : {};
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!this.requirePrivilegedTicket(req, res, url, 'tools.policy', parsed.ticket)) {
          return;
        }
        const result = this.dashboard.onToolsPolicyUpdate(parsed);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['config', 'tools', 'security'], 'tools.policy.updated', url.pathname);
        return;
      }

      // GET /api/tools/approvals/pending — list pending approvals scoped to user/channel
      if (req.method === 'GET' && url.pathname === '/api/tools/approvals/pending') {
        if (!this.dashboard.onToolsPendingApprovals) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const principal = this.resolveRequestPrincipal(req);
        const userId = url.searchParams.get('userId') ?? 'web-user';
        const channel = url.searchParams.get('channel') ?? 'web';
        const limitValue = Number(url.searchParams.get('limit') ?? '20');
        const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(100, limitValue)) : 20;
        sendJSON(res, 200, this.dashboard.onToolsPendingApprovals({ userId, channel, principalId: principal.principalId, limit }));
        return;
      }

      // GET /api/chat/pending-action — current blocked-work state for a surface
      if (req.method === 'GET' && url.pathname === '/api/chat/pending-action') {
        if (!this.dashboard.onPendingActionCurrent) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const principal = this.resolveRequestPrincipal(req);
        const userId = url.searchParams.get('userId') ?? 'web-user';
        const channel = url.searchParams.get('channel') ?? 'web';
        const surfaceId = trimOptionalString(url.searchParams.get('surfaceId')) ?? 'web-guardian-chat';
        sendJSON(res, 200, this.dashboard.onPendingActionCurrent({
          userId,
          principalId: principal.principalId,
          channel,
          surfaceId,
        }));
        return;
      }

      // POST /api/tools/approvals/decision — approve or deny pending request
      if (req.method === 'POST' && url.pathname === '/api/tools/approvals/decision') {
        if (!this.dashboard.onToolsApprovalDecision) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: {
          approvalId?: string;
          decision?: 'approved' | 'denied';
          actor?: string;
          reason?: string;
        };
        try {
          parsed = JSON.parse(body) as {
            approvalId?: string;
            decision?: 'approved' | 'denied';
            actor?: string;
            reason?: string;
          };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.approvalId || !parsed.decision) {
          sendJSON(res, 400, { error: 'approvalId and decision are required' });
          return;
        }
        const principal = this.resolveRequestPrincipal(req);
        const result = await this.dashboard.onToolsApprovalDecision({
          approvalId: parsed.approvalId,
          decision: parsed.decision,
          actor: principal.principalId,
          actorRole: principal.principalRole,
          reason: parsed.reason,
        });
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['config', 'tools', 'automations'], 'tools.approval.decided', url.pathname);
        return;
      }

      // GET /api/tools/categories — list tool categories with status
      if (req.method === 'GET' && url.pathname === '/api/tools/categories') {
        if (!this.dashboard.onToolsCategories) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onToolsCategories());
        return;
      }

      // POST /api/tools/categories — toggle tool category enable/disable
      if (req.method === 'POST' && url.pathname === '/api/tools/categories') {
        if (!this.dashboard.onToolsCategoryToggle) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { category: string; enabled: boolean };
        try {
          parsed = JSON.parse(body) as { category: string; enabled: boolean };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.category || typeof parsed.enabled !== 'boolean') {
          sendJSON(res, 400, { error: 'Missing category or enabled field' });
          return;
        }
        const result = this.dashboard.onToolsCategoryToggle(parsed as Parameters<NonNullable<typeof this.dashboard.onToolsCategoryToggle>>[0]);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['config', 'tools'], 'tools.category.updated', url.pathname);
        return;
      }

      // POST /api/tools/provider-routing — update per-tool/per-category LLM provider routing
      if (req.method === 'POST' && url.pathname === '/api/tools/provider-routing') {
        if (!this.dashboard.onToolsProviderRoutingUpdate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { routing?: Record<string, string>; enabled?: boolean };
        try {
          parsed = JSON.parse(body) as { routing?: Record<string, string>; enabled?: boolean };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.routing && typeof parsed.enabled !== 'boolean') {
          sendJSON(res, 400, { error: 'routing object or enabled flag is required' });
          return;
        }
        const result = this.dashboard.onToolsProviderRoutingUpdate({
          routing: parsed.routing as Record<string, 'local' | 'external' | 'default'> | undefined,
          enabled: parsed.enabled,
        });
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['config', 'tools'], 'tools.routing.updated', url.pathname);
        return;
      }

      // GET /api/tools/browser — browser automation config
      if (req.method === 'GET' && url.pathname === '/api/tools/browser') {
        if (!this.dashboard.onBrowserConfigState) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onBrowserConfigState());
        return;
      }

      // POST /api/tools/browser — update browser automation config
      if (req.method === 'POST' && url.pathname === '/api/tools/browser') {
        if (!this.dashboard.onBrowserConfigUpdate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { enabled?: boolean; allowedDomains?: string[]; playwrightEnabled?: boolean; playwrightBrowser?: string; playwrightCaps?: string };
        try {
          parsed = JSON.parse(body) as { enabled?: boolean; allowedDomains?: string[]; playwrightEnabled?: boolean; playwrightBrowser?: string; playwrightCaps?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        const result = await this.dashboard.onBrowserConfigUpdate(parsed);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['config', 'tools'], 'tools.browser.updated', url.pathname);
        return;
      }

      // GET /api/connectors/state — connector packs/playbooks/runs
      if (req.method === 'GET' && url.pathname === '/api/connectors/state') {
        if (!this.dashboard.onConnectorsState) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const limitRuns = parseInt(url.searchParams.get('limitRuns') ?? '50', 10);
        sendJSON(res, 200, this.dashboard.onConnectorsState({
          limitRuns: Number.isFinite(limitRuns) ? limitRuns : 50,
        }));
        return;
      }

      // POST /api/connectors/settings — update connector runtime settings
      if (req.method === 'POST' && url.pathname === '/api/connectors/settings') {
        if (!this.dashboard.onConnectorsSettingsUpdate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: Parameters<NonNullable<DashboardCallbacks['onConnectorsSettingsUpdate']>>[0] & { ticket?: string };
        try {
          parsed = body.trim()
            ? (JSON.parse(body) as Parameters<NonNullable<DashboardCallbacks['onConnectorsSettingsUpdate']>>[0] & { ticket?: string })
            : {};
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        const requireTicket = this.dashboard.onConnectorsState?.({ limitRuns: 1 }).studio.requirePrivilegedTicket ?? false;
        if (requireTicket && !this.requirePrivilegedTicket(req, res, url, 'connectors.config', parsed.ticket)) {
          return;
        }
        const result = this.dashboard.onConnectorsSettingsUpdate(parsed);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['automations', 'config'], 'connectors.settings.updated', url.pathname);
        return;
      }

      // POST /api/connectors/packs/upsert — add or update connector pack
      if (req.method === 'POST' && url.pathname === '/api/connectors/packs/upsert') {
        if (!this.dashboard.onConnectorsPackUpsert) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: Parameters<NonNullable<DashboardCallbacks['onConnectorsPackUpsert']>>[0] & { ticket?: string };
        try {
          parsed = JSON.parse(body) as Parameters<NonNullable<DashboardCallbacks['onConnectorsPackUpsert']>>[0] & { ticket?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed?.id) {
          sendJSON(res, 400, { error: 'pack.id is required' });
          return;
        }
        const requireTicket = this.dashboard.onConnectorsState?.({ limitRuns: 1 }).studio.requirePrivilegedTicket ?? false;
        if (requireTicket && !this.requirePrivilegedTicket(req, res, url, 'connectors.pack', parsed.ticket)) {
          return;
        }
        const result = this.dashboard.onConnectorsPackUpsert(parsed);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['automations', 'config'], 'connectors.pack.upserted', url.pathname);
        return;
      }

      // POST /api/connectors/packs/delete — delete connector pack
      if (req.method === 'POST' && url.pathname === '/api/connectors/packs/delete') {
        if (!this.dashboard.onConnectorsPackDelete) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { packId?: string; ticket?: string };
        try {
          parsed = JSON.parse(body) as { packId?: string; ticket?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.packId?.trim()) {
          sendJSON(res, 400, { error: 'packId is required' });
          return;
        }
        const requireTicket = this.dashboard.onConnectorsState?.({ limitRuns: 1 }).studio.requirePrivilegedTicket ?? false;
        if (requireTicket && !this.requirePrivilegedTicket(req, res, url, 'connectors.pack', parsed.ticket)) {
          return;
        }
        const result = this.dashboard.onConnectorsPackDelete(parsed.packId.trim());
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['automations', 'config'], 'connectors.pack.deleted', url.pathname);
        return;
      }

      // GET /api/network/devices — device inventory
      if (req.method === 'GET' && url.pathname === '/api/network/devices') {
        if (!this.dashboard.onNetworkDevices) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onNetworkDevices());
        return;
      }

      // GET /api/network/baseline — network baseline status
      if (req.method === 'GET' && url.pathname === '/api/network/baseline') {
        if (!this.dashboard.onNetworkBaseline) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onNetworkBaseline());
        return;
      }

      // GET /api/network/threats — active/deduped network alerts
      if (req.method === 'GET' && url.pathname === '/api/network/threats') {
        if (!this.dashboard.onNetworkThreats) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const includeAcknowledged = (url.searchParams.get('includeAcknowledged') ?? 'false').toLowerCase() === 'true';
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
        sendJSON(res, 200, this.dashboard.onNetworkThreats({
          includeAcknowledged,
          limit: Number.isFinite(limit) ? limit : 100,
        }));
        return;
      }

      // POST /api/network/threats/ack — acknowledge alert
      if (req.method === 'POST' && url.pathname === '/api/network/threats/ack') {
        if (!this.dashboard.onNetworkThreatAcknowledge) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { alertId?: string };
        try {
          parsed = JSON.parse(body) as { alertId?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.alertId?.trim()) {
          sendJSON(res, 400, { error: 'alertId is required' });
          return;
        }
        const result = this.dashboard.onNetworkThreatAcknowledge(parsed.alertId.trim());
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['network', 'security'], 'network.threat.acknowledged', url.pathname);
        return;
      }

      // GET /api/security/alerts — unified host/network/gateway/native alerts
      if (req.method === 'GET' && url.pathname === '/api/security/alerts') {
        if (!this.dashboard.onSecurityAlerts) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const includeAcknowledged = (url.searchParams.get('includeAcknowledged') ?? 'false').toLowerCase() === 'true';
        const includeInactive = (url.searchParams.get('includeInactive') ?? 'false').toLowerCase() === 'true';
        const parsedLimit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
        const limit = Number.isFinite(parsedLimit) ? parsedLimit : 100;
        const query = trimOptionalString(url.searchParams.get('query'));
        const type = trimOptionalString(url.searchParams.get('type'));
        const rawStatus = trimOptionalString(url.searchParams.get('status'))?.toLowerCase();
        const rawSource = trimOptionalString(url.searchParams.get('source'));
        const rawSources = (trimOptionalString(url.searchParams.get('sources')) ?? '')
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        const rawSeverity = trimOptionalString(url.searchParams.get('severity'))?.toLowerCase();

        if (rawSource && !isSecurityAlertSource(rawSource.toLowerCase())) {
          sendJSON(res, 400, { error: "source must be one of 'host', 'network', 'gateway', 'native', 'assistant', or 'install'" });
          return;
        }
        if (rawSources.some((value) => !isSecurityAlertSource(value))) {
          sendJSON(res, 400, { error: "sources must contain only 'host', 'network', 'gateway', 'native', 'assistant', or 'install'" });
          return;
        }
        if (rawSeverity && !isSecurityAlertSeverity(rawSeverity)) {
          sendJSON(res, 400, { error: "severity must be one of 'low', 'medium', 'high', or 'critical'" });
          return;
        }
        if (rawStatus && !isSecurityAlertStatus(rawStatus)) {
          sendJSON(res, 400, { error: "status must be one of 'active', 'acknowledged', 'resolved', or 'suppressed'" });
          return;
        }

        const sources = normalizeSecurityAlertSources(rawSource, rawSources);
        sendJSON(res, 200, this.dashboard.onSecurityAlerts({
          query,
          source: rawSource?.toLowerCase() as SecurityAlertSource | undefined,
          sources,
          severity: rawSeverity as 'low' | 'medium' | 'high' | 'critical' | undefined,
          status: rawStatus as 'active' | 'acknowledged' | 'resolved' | 'suppressed' | undefined,
          type,
          includeAcknowledged,
          includeInactive,
          limit,
        }));
        return;
      }

      // POST /api/security/alerts/ack — acknowledge a unified security alert
      if (req.method === 'POST' && url.pathname === '/api/security/alerts/ack') {
        if (!this.dashboard.onSecurityAlertAcknowledge) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { alertId?: string; source?: string };
        try {
          parsed = JSON.parse(body) as { alertId?: string; source?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.alertId?.trim()) {
          sendJSON(res, 400, { error: 'alertId is required' });
          return;
        }
        const source = trimOptionalString(parsed.source)?.toLowerCase();
        if (source && !isSecurityAlertSource(source)) {
          sendJSON(res, 400, { error: "source must be one of 'host', 'network', 'gateway', 'native', 'assistant', or 'install'" });
          return;
        }
        const result = this.dashboard.onSecurityAlertAcknowledge({
          alertId: parsed.alertId.trim(),
          source: source as SecurityAlertSource | undefined,
        });
        sendJSON(res, 200, result);
        const topics = result.source === 'network' ? ['network', 'security'] : ['security'];
        this.maybeEmitUIInvalidation(result, topics, 'security.alert.acknowledged', url.pathname);
        return;
      }

      // POST /api/security/alerts/resolve — resolve a unified security alert
      if (req.method === 'POST' && url.pathname === '/api/security/alerts/resolve') {
        if (!this.dashboard.onSecurityAlertResolve) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { alertId?: string; source?: string; reason?: string };
        try {
          parsed = JSON.parse(body) as { alertId?: string; source?: string; reason?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.alertId?.trim()) {
          sendJSON(res, 400, { error: 'alertId is required' });
          return;
        }
        const source = trimOptionalString(parsed.source)?.toLowerCase();
        if (source && !isSecurityAlertSource(source)) {
          sendJSON(res, 400, { error: "source must be one of 'host', 'network', 'gateway', 'native', 'assistant', or 'install'" });
          return;
        }
        const result = this.dashboard.onSecurityAlertResolve({
          alertId: parsed.alertId.trim(),
          source: source as SecurityAlertSource | undefined,
          reason: trimOptionalString(parsed.reason),
        });
        sendJSON(res, 200, result);
        const topics = result.source === 'network' ? ['network', 'security'] : ['security'];
        this.maybeEmitUIInvalidation(result, topics, 'security.alert.resolved', url.pathname);
        return;
      }

      // POST /api/security/alerts/suppress — suppress a unified security alert
      if (req.method === 'POST' && url.pathname === '/api/security/alerts/suppress') {
        if (!this.dashboard.onSecurityAlertSuppress) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { alertId?: string; source?: string; reason?: string; suppressedUntil?: number };
        try {
          parsed = JSON.parse(body) as { alertId?: string; source?: string; reason?: string; suppressedUntil?: number };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.alertId?.trim()) {
          sendJSON(res, 400, { error: 'alertId is required' });
          return;
        }
        if (!Number.isFinite(parsed.suppressedUntil)) {
          sendJSON(res, 400, { error: 'suppressedUntil is required and must be a number' });
          return;
        }
        const source = trimOptionalString(parsed.source)?.toLowerCase();
        if (source && !isSecurityAlertSource(source)) {
          sendJSON(res, 400, { error: "source must be one of 'host', 'network', 'gateway', 'native', 'assistant', or 'install'" });
          return;
        }
        const result = this.dashboard.onSecurityAlertSuppress({
          alertId: parsed.alertId.trim(),
          source: source as SecurityAlertSource | undefined,
          reason: trimOptionalString(parsed.reason),
          suppressedUntil: Number(parsed.suppressedUntil),
        });
        sendJSON(res, 200, result);
        const topics = result.source === 'network' ? ['network', 'security'] : ['security'];
        this.maybeEmitUIInvalidation(result, topics, 'security.alert.suppressed', url.pathname);
        return;
      }

      // GET /api/security/activity — persisted real-time activity log for agentic security workflows
      if (req.method === 'GET' && url.pathname === '/api/security/activity') {
        if (!this.dashboard.onSecurityActivityLog) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const rawLimit = Number(url.searchParams.get('limit') ?? 200);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 200;
        const rawStatus = trimOptionalString(url.searchParams.get('status'))?.toLowerCase();
        const agentId = trimOptionalString(url.searchParams.get('agentId'));
        if (rawStatus && !isSecurityActivityStatus(rawStatus)) {
          sendJSON(res, 400, { error: "status must be one of 'started', 'skipped', 'completed', or 'failed'" });
          return;
        }
        sendJSON(res, 200, this.dashboard.onSecurityActivityLog({
          limit,
          status: rawStatus && isSecurityActivityStatus(rawStatus) ? rawStatus : undefined,
          agentId,
        }));
        return;
      }

      // GET /api/security/ai/summary — Assistant Security high-level summary
      if (req.method === 'GET' && url.pathname === '/api/security/ai/summary') {
        if (!this.dashboard.onAiSecuritySummary) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onAiSecuritySummary());
        return;
      }

      // GET /api/security/ai/profiles — Assistant Security scan profiles
      if (req.method === 'GET' && url.pathname === '/api/security/ai/profiles') {
        if (!this.dashboard.onAiSecurityProfiles) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onAiSecurityProfiles());
        return;
      }

      // GET /api/security/ai/targets — scan targets
      if (req.method === 'GET' && url.pathname === '/api/security/ai/targets') {
        if (!this.dashboard.onAiSecurityTargets) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onAiSecurityTargets());
        return;
      }

      // GET /api/security/ai/runs — recent scan runs
      if (req.method === 'GET' && url.pathname === '/api/security/ai/runs') {
        if (!this.dashboard.onAiSecurityRuns) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 20;
        sendJSON(res, 200, this.dashboard.onAiSecurityRuns(limit));
        return;
      }

      // POST /api/security/ai/scan — run Assistant Security scan
      if (req.method === 'POST' && url.pathname === '/api/security/ai/scan') {
        if (!this.dashboard.onAiSecurityScan) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }

        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          const status = message.includes('too large') ? 413 : 400;
          sendJSON(res, status, { error: message });
          return;
        }

        let parsed: { profileId?: string; targetIds?: string[]; source?: string };
        try {
          parsed = body.trim()
            ? (JSON.parse(body) as { profileId?: string; targetIds?: string[]; source?: string })
            : {};
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        const result = await this.dashboard.onAiSecurityScan({
          profileId: trimOptionalString(parsed.profileId),
          targetIds: Array.isArray(parsed.targetIds)
            ? parsed.targetIds.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
            : undefined,
          source: parsed.source as Parameters<NonNullable<DashboardCallbacks['onAiSecurityScan']>>[0]['source'],
        });
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['security', 'ai-security'], 'security.ai.scan.completed', url.pathname);
        return;
      }

      // GET /api/security/ai/findings — list findings
      if (req.method === 'GET' && url.pathname === '/api/security/ai/findings') {
        if (!this.dashboard.onAiSecurityFindings) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 50;
        const status = trimOptionalString(url.searchParams.get('status'))?.toLowerCase();
        sendJSON(res, 200, this.dashboard.onAiSecurityFindings({
          limit,
          status: status as Parameters<NonNullable<DashboardCallbacks['onAiSecurityFindings']>>[0]['status'],
        }));
        return;
      }

      // POST /api/security/ai/findings/status — update finding status
      if (req.method === 'POST' && url.pathname === '/api/security/ai/findings/status') {
        if (!this.dashboard.onAiSecurityUpdateFindingStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }

        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          const statusCode = message.includes('too large') ? 413 : 400;
          sendJSON(res, statusCode, { error: message });
          return;
        }

        let parsed: { findingId?: string; status?: string };
        try {
          parsed = JSON.parse(body) as { findingId?: string; status?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        if (!parsed.findingId?.trim() || !parsed.status?.trim()) {
          sendJSON(res, 400, { error: 'findingId and status are required' });
          return;
        }

        const result = this.dashboard.onAiSecurityUpdateFindingStatus({
          findingId: parsed.findingId.trim(),
          status: parsed.status.trim().toLowerCase() as Parameters<NonNullable<DashboardCallbacks['onAiSecurityUpdateFindingStatus']>>[0]['status'],
        });
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['security', 'ai-security'], 'security.ai.finding.updated', url.pathname);
        return;
      }

      // GET /api/security/posture — advisory operating mode recommendation
      if (req.method === 'GET' && url.pathname === '/api/security/posture') {
        if (!this.dashboard.onSecurityPosture) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const rawProfile = trimOptionalString(url.searchParams.get('profile'))?.toLowerCase();
        const rawCurrentMode = trimOptionalString(url.searchParams.get('currentMode'))?.toLowerCase();
        const includeAcknowledged = (url.searchParams.get('includeAcknowledged') ?? 'false').toLowerCase() === 'true';
        if (rawProfile && !isDeploymentProfile(rawProfile)) {
          sendJSON(res, 400, { error: "profile must be one of 'personal', 'home', or 'organization'" });
          return;
        }
        if (rawCurrentMode && !isSecurityOperatingMode(rawCurrentMode)) {
          sendJSON(res, 400, { error: "currentMode must be one of 'monitor', 'guarded', 'lockdown', or 'ir_assist'" });
          return;
        }
        const profile = rawProfile && isDeploymentProfile(rawProfile) ? rawProfile : undefined;
        const currentMode = rawCurrentMode && isSecurityOperatingMode(rawCurrentMode) ? rawCurrentMode : undefined;
        sendJSON(res, 200, this.dashboard.onSecurityPosture({
          profile,
          currentMode,
          includeAcknowledged,
        }));
        return;
      }

      // GET /api/security/containment — effective containment state for the current profile/mode
      if (req.method === 'GET' && url.pathname === '/api/security/containment') {
        if (!this.dashboard.onSecurityContainmentStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const rawProfile = trimOptionalString(url.searchParams.get('profile'))?.toLowerCase();
        const rawCurrentMode = trimOptionalString(url.searchParams.get('currentMode'))?.toLowerCase();
        if (rawProfile && !isDeploymentProfile(rawProfile)) {
          sendJSON(res, 400, { error: "profile must be one of 'personal', 'home', or 'organization'" });
          return;
        }
        if (rawCurrentMode && !isSecurityOperatingMode(rawCurrentMode)) {
          sendJSON(res, 400, { error: "currentMode must be one of 'monitor', 'guarded', 'lockdown', or 'ir_assist'" });
          return;
        }
        const profile = rawProfile && isDeploymentProfile(rawProfile) ? rawProfile : undefined;
        const currentMode = rawCurrentMode && isSecurityOperatingMode(rawCurrentMode) ? rawCurrentMode : undefined;
        sendJSON(res, 200, this.dashboard.onSecurityContainmentStatus({
          profile,
          currentMode,
        }));
        return;
      }

      // GET /api/windows-defender/status
      if (req.method === 'GET' && url.pathname === '/api/windows-defender/status') {
        if (!this.dashboard.onWindowsDefenderStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onWindowsDefenderStatus());
        return;
      }

      // POST /api/windows-defender/refresh
      if (req.method === 'POST' && url.pathname === '/api/windows-defender/refresh') {
        if (!this.dashboard.onWindowsDefenderRefresh) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const result = await this.dashboard.onWindowsDefenderRefresh();
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['security'], 'windows-defender.refreshed', url.pathname);
        return;
      }

      // POST /api/windows-defender/scan
      if (req.method === 'POST' && url.pathname === '/api/windows-defender/scan') {
        if (!this.dashboard.onWindowsDefenderScan) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { type?: string; path?: string };
        try {
          parsed = JSON.parse(body) as { type?: string; path?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        const type = trimOptionalString(parsed.type)?.toLowerCase();
        if (type !== 'quick' && type !== 'full' && type !== 'custom') {
          sendJSON(res, 400, { error: "type must be one of 'quick', 'full', or 'custom'" });
          return;
        }
        const path = trimOptionalString(parsed.path);
        if (type === 'custom' && !path) {
          sendJSON(res, 400, { error: 'path is required when type is custom' });
          return;
        }
        const result = await this.dashboard.onWindowsDefenderScan({ type, path });
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['security'], 'windows-defender.scan.requested', url.pathname);
        return;
      }

      // POST /api/windows-defender/signatures/update
      if (req.method === 'POST' && url.pathname === '/api/windows-defender/signatures/update') {
        if (!this.dashboard.onWindowsDefenderUpdateSignatures) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const result = await this.dashboard.onWindowsDefenderUpdateSignatures();
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['security'], 'windows-defender.signatures.updated', url.pathname);
        return;
      }

      // POST /api/network/scan — trigger network scan
      if (req.method === 'POST' && url.pathname === '/api/network/scan') {
        if (!this.dashboard.onNetworkScan) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const result = await this.dashboard.onNetworkScan();
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['network', 'automations', 'security'], 'network.scan.completed', url.pathname);
        return;
      }

      // GET /api/host-monitor/status
      if (req.method === 'GET' && url.pathname === '/api/host-monitor/status') {
        if (!this.dashboard.onHostMonitorStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onHostMonitorStatus());
        return;
      }

      // GET /api/host-monitor/alerts
      if (req.method === 'GET' && url.pathname === '/api/host-monitor/alerts') {
        if (!this.dashboard.onHostMonitorAlerts) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const includeAcknowledged = (url.searchParams.get('includeAcknowledged') ?? 'false').toLowerCase() === 'true';
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
        sendJSON(res, 200, this.dashboard.onHostMonitorAlerts({
          includeAcknowledged,
          limit: Number.isFinite(limit) ? limit : 100,
        }));
        return;
      }

      // POST /api/host-monitor/alerts/ack
      if (req.method === 'POST' && url.pathname === '/api/host-monitor/alerts/ack') {
        if (!this.dashboard.onHostMonitorAcknowledge) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { alertId?: string };
        try {
          parsed = JSON.parse(body) as { alertId?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.alertId?.trim()) {
          sendJSON(res, 400, { error: 'alertId is required' });
          return;
        }
        const result = this.dashboard.onHostMonitorAcknowledge(parsed.alertId.trim());
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['security'], 'host-monitor.alert.acknowledged', url.pathname);
        return;
      }

      // POST /api/host-monitor/check
      if (req.method === 'POST' && url.pathname === '/api/host-monitor/check') {
        if (!this.dashboard.onHostMonitorCheck) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const result = await this.dashboard.onHostMonitorCheck();
        sendJSON(res, 200, result);
        this.emitUIInvalidation(['security'], 'host-monitor.check.completed', url.pathname);
        return;
      }

      // GET /api/gateway-monitor/status
      if (req.method === 'GET' && url.pathname === '/api/gateway-monitor/status') {
        if (!this.dashboard.onGatewayMonitorStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onGatewayMonitorStatus());
        return;
      }

      // GET /api/gateway-monitor/alerts
      if (req.method === 'GET' && url.pathname === '/api/gateway-monitor/alerts') {
        if (!this.dashboard.onGatewayMonitorAlerts) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const includeAcknowledged = (url.searchParams.get('includeAcknowledged') ?? 'false').toLowerCase() === 'true';
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
        sendJSON(res, 200, this.dashboard.onGatewayMonitorAlerts({
          includeAcknowledged,
          limit: Number.isFinite(limit) ? limit : 100,
        }));
        return;
      }

      // POST /api/gateway-monitor/alerts/ack
      if (req.method === 'POST' && url.pathname === '/api/gateway-monitor/alerts/ack') {
        if (!this.dashboard.onGatewayMonitorAcknowledge) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { alertId?: string };
        try {
          parsed = JSON.parse(body) as { alertId?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.alertId?.trim()) {
          sendJSON(res, 400, { error: 'alertId is required' });
          return;
        }
        const result = this.dashboard.onGatewayMonitorAcknowledge(parsed.alertId.trim());
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['security'], 'gateway-monitor.alert.acknowledged', url.pathname);
        return;
      }

      // POST /api/gateway-monitor/check
      if (req.method === 'POST' && url.pathname === '/api/gateway-monitor/check') {
        if (!this.dashboard.onGatewayMonitorCheck) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const result = await this.dashboard.onGatewayMonitorCheck();
        sendJSON(res, 200, result);
        this.emitUIInvalidation(['security'], 'gateway-monitor.check.completed', url.pathname);
        return;
      }

      // GET /api/agents — Agent list
      if (req.method === 'GET' && url.pathname === '/api/agents') {
        if (!this.dashboard.onAgents) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onAgents());
        return;
      }

      // GET /api/agents/:id — Agent detail
      if (req.method === 'GET' && url.pathname.startsWith('/api/agents/')) {
        if (!this.dashboard.onAgentDetail) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const id = url.pathname.slice('/api/agents/'.length);
        if (!id) {
          sendJSON(res, 400, { error: 'Agent ID required' });
          return;
        }
        const detail = this.dashboard.onAgentDetail(id);
        if (!detail) {
          sendJSON(res, 404, { error: `Agent '${id}' not found` });
          return;
        }
        sendJSON(res, 200, detail);
        return;
      }

      // GET /api/audit/verify — Verify audit hash chain integrity
      if (req.method === 'GET' && url.pathname === '/api/audit/verify') {
        if (!this.dashboard.onAuditVerifyChain) {
          sendJSON(res, 404, { error: 'Audit persistence not available' });
          return;
        }
        try {
          const result = await this.dashboard.onAuditVerifyChain();
          sendJSON(res, 200, result);
        } catch (err) {
          logInternalError('Audit verification failed', err);
          sendJSON(res, 500, { error: 'Audit verification failed' });
        }
        return;
      }

      // GET /api/audit/summary — Aggregated audit stats
      if (req.method === 'GET' && url.pathname === '/api/audit/summary') {
        if (!this.dashboard.onAuditSummary) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const windowMs = parseInt(url.searchParams.get('windowMs') ?? '300000', 10);
        sendJSON(res, 200, this.dashboard.onAuditSummary(windowMs));
        return;
      }

      // GET /api/audit — Filtered audit events
      if (req.method === 'GET' && url.pathname === '/api/audit') {
        if (!this.dashboard.onAuditQuery) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const filter: Record<string, unknown> = {};
        const type = url.searchParams.get('type');
        if (type) filter.type = type as AuditEventType;
        const agentId = url.searchParams.get('agentId');
        if (agentId) filter.agentId = agentId;
        const severity = url.searchParams.get('severity');
        if (severity) filter.severity = severity as AuditSeverity;
        const limit = url.searchParams.get('limit');
        if (limit) filter.limit = parseInt(limit, 10);
        const after = url.searchParams.get('after');
        if (after) filter.after = parseInt(after, 10);
        const before = url.searchParams.get('before');
        if (before) filter.before = parseInt(before, 10);

        sendJSON(res, 200, this.dashboard.onAuditQuery(filter));
        return;
      }

      // GET /api/config — Redacted config
      if (req.method === 'GET' && url.pathname === '/api/config') {
        if (!this.dashboard.onConfig) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onConfig());
        return;
      }

      // GET /api/reference — Usage/reference guide
      if (req.method === 'GET' && url.pathname === '/api/reference') {
        if (!this.dashboard.onReferenceGuide) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onReferenceGuide());
        return;
      }

      // GET /api/setup/status — setup/config completion + diagnostics
      if (req.method === 'GET' && url.pathname === '/api/setup/status') {
        if (!this.dashboard.onSetupStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, await this.dashboard.onSetupStatus());
        return;
      }

      // GET /api/quick-actions — quick action definitions
      if (req.method === 'GET' && url.pathname === '/api/quick-actions') {
        if (!this.dashboard.onQuickActions) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onQuickActions());
        return;
      }

      // POST /api/config — Update config
      if (req.method === 'POST' && url.pathname === '/api/config') {
        if (!this.dashboard.onConfigUpdate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        const parsedRecord = asRecord(parsed);
        const bodyTicket = trimOptionalString(parsedRecord?.ticket);
        if (parsedRecord && hasOwn(parsedRecord, 'ticket')) {
          delete parsedRecord.ticket;
        }
        const privilegedAction = this.getConfigPrivilegedAction(parsedRecord);
        if (privilegedAction && !this.requirePrivilegedTicket(req, res, url, privilegedAction, bodyTicket)) {
          return;
        }
        try {
          const result = await this.dashboard.onConfigUpdate(parsed as Record<string, unknown>);
          sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
          this.maybeEmitUIInvalidation(result, ['config', 'providers', 'tools', 'automations', 'network'], 'config.updated', url.pathname);
        } catch (err) {
          logInternalError('Config update failed', err);
          sendJSON(res, 500, { error: 'Update failed' });
        }
        return;
      }

      // POST /api/telegram/test — reload Telegram channel and report connection status
      if (req.method === 'POST' && url.pathname === '/api/telegram/test') {
        if (!this.dashboard.onTelegramReload) {
          sendJSON(res, 404, { error: 'Telegram reload not available' });
          return;
        }
        try {
          const result = await this.dashboard.onTelegramReload();
          sendJSON(res, 200, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Telegram test failed';
          sendJSON(res, 500, { success: false, message });
        }
        return;
      }

      // POST /api/cloud/test — test a cloud provider profile connection
      if (req.method === 'POST' && url.pathname === '/api/cloud/test') {
        if (!this.dashboard.onCloudTest) {
          sendJSON(res, 404, { error: 'Cloud test not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { provider?: string; profileId?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.provider || !parsed.profileId) {
          sendJSON(res, 400, { error: 'provider and profileId are required' });
          return;
        }
        try {
          const result = await this.dashboard.onCloudTest(parsed.provider, parsed.profileId);
          sendJSON(res, 200, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Cloud test failed';
          sendJSON(res, 500, { success: false, message });
        }
        return;
      }

      // POST /api/setup/apply — apply setup/config selections
      if (req.method === 'POST' && url.pathname === '/api/setup/apply') {
        if (!this.dashboard.onSetupApply) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        const result = await this.dashboard.onSetupApply(parsed as Parameters<NonNullable<DashboardCallbacks['onSetupApply']>>[0]);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['config', 'providers'], 'setup.applied', url.pathname);
        return;
      }

      // POST /api/config/search — update web search settings without touching LLM config
      if (req.method === 'POST' && url.pathname === '/api/config/search') {
        if (!this.dashboard.onSearchConfigUpdate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        try {
          const result = await this.dashboard.onSearchConfigUpdate(parsed as Parameters<NonNullable<DashboardCallbacks['onSearchConfigUpdate']>>[0]);
          sendJSON(res, 200, result);
          this.maybeEmitUIInvalidation(result, ['config'], 'search.config.updated', url.pathname);
        } catch (err) {
          logInternalError('Search config update failed', err);
          sendJSON(res, 500, { error: 'Update failed' });
        }
        return;
      }

      // GET /api/budget — Budget/resource metrics
      if (req.method === 'GET' && url.pathname === '/api/budget') {
        if (!this.dashboard.onBudget) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onBudget());
        return;
      }

      // GET /api/analytics/summary — assistant interaction analytics
      if (req.method === 'GET' && url.pathname === '/api/analytics/summary') {
        if (!this.dashboard.onAnalyticsSummary) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const windowMs = parseInt(url.searchParams.get('windowMs') ?? '3600000', 10);
        sendJSON(res, 200, this.dashboard.onAnalyticsSummary(windowMs));
        return;
      }

      // GET /api/threat-intel/summary — threat-intel high-level summary
      if (req.method === 'GET' && url.pathname === '/api/threat-intel/summary') {
        if (!this.dashboard.onThreatIntelSummary) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onThreatIntelSummary());
        return;
      }

      // GET /api/threat-intel/plan — phased operating plan
      if (req.method === 'GET' && url.pathname === '/api/threat-intel/plan') {
        if (!this.dashboard.onThreatIntelPlan) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onThreatIntelPlan());
        return;
      }

      // GET /api/threat-intel/watchlist — configured watch targets
      if (req.method === 'GET' && url.pathname === '/api/threat-intel/watchlist') {
        if (!this.dashboard.onThreatIntelWatchlist) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, { targets: this.dashboard.onThreatIntelWatchlist() });
        return;
      }

      // POST /api/threat-intel/watchlist — add/remove target
      if (req.method === 'POST' && url.pathname === '/api/threat-intel/watchlist') {
        if (!this.dashboard.onThreatIntelWatchAdd || !this.dashboard.onThreatIntelWatchRemove) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          const status = message.includes('too large') ? 413 : 400;
          sendJSON(res, status, { error: message });
          return;
        }

        let parsed: { action?: 'add' | 'remove'; target?: string };
        try {
          parsed = JSON.parse(body) as { action?: 'add' | 'remove'; target?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        if (!parsed.target?.trim()) {
          sendJSON(res, 400, { error: 'target is required' });
          return;
        }
        const action = parsed.action ?? 'add';
        if (action !== 'add' && action !== 'remove') {
          sendJSON(res, 400, { error: "action must be 'add' or 'remove'" });
          return;
        }

        const result = action === 'add'
          ? this.dashboard.onThreatIntelWatchAdd(parsed.target)
          : this.dashboard.onThreatIntelWatchRemove(parsed.target);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.watchlist.updated', url.pathname);
        return;
      }

      // POST /api/threat-intel/scan — run intel scan
      if (req.method === 'POST' && url.pathname === '/api/threat-intel/scan') {
        if (!this.dashboard.onThreatIntelScan) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }

        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          const status = message.includes('too large') ? 413 : 400;
          sendJSON(res, status, { error: message });
          return;
        }

        let parsed: { query?: string; includeDarkWeb?: boolean; sources?: string[] };
        try {
          parsed = body.trim()
            ? (JSON.parse(body) as { query?: string; includeDarkWeb?: boolean; sources?: string[] })
            : {};
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        const result = await this.dashboard.onThreatIntelScan({
          query: parsed.query,
          includeDarkWeb: parsed.includeDarkWeb,
          sources: parsed.sources as Parameters<NonNullable<DashboardCallbacks['onThreatIntelScan']>>[0]['sources'],
        });
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.scan.completed', url.pathname);
        return;
      }

      // GET /api/threat-intel/findings — list findings
      if (req.method === 'GET' && url.pathname === '/api/threat-intel/findings') {
        if (!this.dashboard.onThreatIntelFindings) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }

        const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
        const status = url.searchParams.get('status') ?? undefined;
        const findings = this.dashboard.onThreatIntelFindings({
          limit: Number.isFinite(limit) ? limit : 50,
          status: status as Parameters<NonNullable<DashboardCallbacks['onThreatIntelFindings']>>[0]['status'],
        });
        sendJSON(res, 200, findings);
        return;
      }

      // POST /api/threat-intel/findings/status — set finding status
      if (req.method === 'POST' && url.pathname === '/api/threat-intel/findings/status') {
        if (!this.dashboard.onThreatIntelUpdateFindingStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }

        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          const statusCode = message.includes('too large') ? 413 : 400;
          sendJSON(res, statusCode, { error: message });
          return;
        }

        let parsed: { findingId?: string; status?: string };
        try {
          parsed = JSON.parse(body) as { findingId?: string; status?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        if (!parsed.findingId || !parsed.status) {
          sendJSON(res, 400, { error: 'findingId and status are required' });
          return;
        }

        const result = this.dashboard.onThreatIntelUpdateFindingStatus({
          findingId: parsed.findingId,
          status: parsed.status as Parameters<NonNullable<DashboardCallbacks['onThreatIntelUpdateFindingStatus']>>[0]['status'],
        });
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.finding.updated', url.pathname);
        return;
      }

      // GET /api/threat-intel/actions — list drafted actions
      if (req.method === 'GET' && url.pathname === '/api/threat-intel/actions') {
        if (!this.dashboard.onThreatIntelActions) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
        sendJSON(res, 200, this.dashboard.onThreatIntelActions(Number.isFinite(limit) ? limit : 50));
        return;
      }

      // POST /api/threat-intel/actions/draft — draft an action for finding
      if (req.method === 'POST' && url.pathname === '/api/threat-intel/actions/draft') {
        if (!this.dashboard.onThreatIntelDraftAction) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }

        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          const status = message.includes('too large') ? 413 : 400;
          sendJSON(res, status, { error: message });
          return;
        }

        let parsed: { findingId?: string; type?: string };
        try {
          parsed = JSON.parse(body) as { findingId?: string; type?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        if (!parsed.findingId || !parsed.type) {
          sendJSON(res, 400, { error: 'findingId and type are required' });
          return;
        }

        const result = this.dashboard.onThreatIntelDraftAction({
          findingId: parsed.findingId,
          type: parsed.type as Parameters<NonNullable<DashboardCallbacks['onThreatIntelDraftAction']>>[0]['type'],
        });
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.action.drafted', url.pathname);
        return;
      }

      // POST /api/threat-intel/response-mode — set response mode
      if (req.method === 'POST' && url.pathname === '/api/threat-intel/response-mode') {
        if (!this.dashboard.onThreatIntelSetResponseMode) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }

        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          const status = message.includes('too large') ? 413 : 400;
          sendJSON(res, status, { error: message });
          return;
        }

        let parsed: { mode?: string };
        try {
          parsed = JSON.parse(body) as { mode?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        if (!parsed.mode) {
          sendJSON(res, 400, { error: 'mode is required' });
          return;
        }
        const result = this.dashboard.onThreatIntelSetResponseMode(
          parsed.mode as Parameters<NonNullable<DashboardCallbacks['onThreatIntelSetResponseMode']>>[0],
        );
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.response-mode.updated', url.pathname);
        return;
      }

      // GET /api/watchdog — Watchdog check results
      if (req.method === 'GET' && url.pathname === '/api/watchdog') {
        if (!this.dashboard.onWatchdog) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onWatchdog());
        return;
      }

      // GET /api/providers — LLM provider list
      if (req.method === 'GET' && url.pathname === '/api/providers') {
        if (!this.dashboard.onProviders) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onProviders());
        return;
      }

      // GET /api/providers/types — available LLM provider families from runtime registry
      if (req.method === 'GET' && url.pathname === '/api/providers/types') {
        if (!this.dashboard.onProviderTypes) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onProviderTypes());
        return;
      }

      // GET /api/providers/status — LLM provider list with live connectivity check
      if (req.method === 'GET' && url.pathname === '/api/providers/status') {
        if (!this.dashboard.onProvidersStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, await this.dashboard.onProvidersStatus());
        return;
      }

      // POST /api/providers/models — list models for a provider family/config
      if (req.method === 'POST' && url.pathname === '/api/providers/models') {
        if (!this.dashboard.onProviderModels) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        const providerType = typeof parsed.providerType === 'string' ? parsed.providerType.trim() : '';
        if (!providerType) {
          sendJSON(res, 400, { error: 'providerType is required' });
          return;
        }
        try {
          const result = await this.dashboard.onProviderModels({
            providerType,
            model: typeof parsed.model === 'string' ? parsed.model : undefined,
            apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
            credentialRef: typeof parsed.credentialRef === 'string' ? parsed.credentialRef : undefined,
            baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
          });
          sendJSON(res, 200, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to load provider models';
          sendJSON(res, 400, { error: message });
        }
        return;
      }

      // POST /api/providers/default — set default LLM provider
      if (req.method === 'POST' && url.pathname === '/api/providers/default') {
        if (!this.dashboard.onConfigUpdate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { name?: string };
        try {
          parsed = JSON.parse(body) as { name?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.name || typeof parsed.name !== 'string') {
          sendJSON(res, 400, { error: 'Missing provider name' });
          return;
        }
        const result = await this.dashboard.onConfigUpdate({ defaultProvider: parsed.name });
        sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
        this.maybeEmitUIInvalidation(result, ['config', 'providers'], 'providers.default.updated', url.pathname);
        return;
      }

      // GET /api/assistant/state — orchestrator/session state
      if (req.method === 'GET' && url.pathname === '/api/assistant/state') {
        if (!this.dashboard.onAssistantState) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onAssistantState());
        return;
      }

      // POST /api/assistant/jobs/follow-up — operator follow-up action for delegated jobs
      if (req.method === 'POST' && url.pathname === '/api/assistant/jobs/follow-up') {
        if (!this.dashboard.onAssistantJobFollowUpAction) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { success: false, message });
          return;
        }
        let parsed: { jobId?: string; action?: 'replay' | 'keep_held' | 'dismiss' };
        try {
          parsed = JSON.parse(body) as { jobId?: string; action?: 'replay' | 'keep_held' | 'dismiss' };
        } catch {
          sendJSON(res, 400, { success: false, message: 'Invalid JSON' });
          return;
        }
        if (!parsed.jobId || typeof parsed.jobId !== 'string') {
          sendJSON(res, 400, { success: false, message: 'Missing jobId' });
          return;
        }
        if (parsed.action !== 'replay' && parsed.action !== 'keep_held' && parsed.action !== 'dismiss') {
          sendJSON(res, 400, { success: false, message: 'Invalid follow-up action' });
          return;
        }
        const result = await this.dashboard.onAssistantJobFollowUpAction({
          jobId: parsed.jobId,
          action: parsed.action,
        });
        sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
        this.maybeEmitUIInvalidation(result, ['assistant', 'dashboard'], 'assistant.jobs.followup', url.pathname);
        return;
      }

      // GET /api/assistant/runs — recent assistant/orchestration runs
      if (req.method === 'GET' && url.pathname === '/api/assistant/runs') {
        if (!this.dashboard.onAssistantRuns) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const limit = Number.parseInt(url.searchParams.get('limit') || '20', 10);
        const status = trimOptionalString(url.searchParams.get('status')) as import('../runtime/run-timeline.js').DashboardRunStatus | undefined;
        const kind = trimOptionalString(url.searchParams.get('kind')) as import('../runtime/run-timeline.js').DashboardRunKind | undefined;
        const channel = trimOptionalString(url.searchParams.get('channel'));
        const agentId = trimOptionalString(url.searchParams.get('agentId'));
        const codeSessionId = trimOptionalString(url.searchParams.get('codeSessionId'));
        const continuityKey = trimOptionalString(url.searchParams.get('continuityKey'));
        const activeExecutionRef = trimOptionalString(url.searchParams.get('activeExecutionRef'));
        sendJSON(res, 200, this.dashboard.onAssistantRuns({
          limit: Number.isFinite(limit) ? limit : 20,
          ...(status ? { status } : {}),
          ...(kind ? { kind } : {}),
          ...(channel ? { channel } : {}),
          ...(agentId ? { agentId } : {}),
          ...(codeSessionId ? { codeSessionId } : {}),
          ...(continuityKey ? { continuityKey } : {}),
          ...(activeExecutionRef ? { activeExecutionRef } : {}),
        }));
        return;
      }

      // GET /api/routing/trace — recent durable intent-routing trace entries
      if (req.method === 'GET' && url.pathname === '/api/routing/trace') {
        if (!this.dashboard.onIntentRoutingTrace) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const limit = Number.parseInt(url.searchParams.get('limit') || '20', 10);
        const continuityKey = trimOptionalString(url.searchParams.get('continuityKey'));
        const activeExecutionRef = trimOptionalString(url.searchParams.get('activeExecutionRef'));
        const stage = trimOptionalString(url.searchParams.get('stage'));
        const channel = trimOptionalString(url.searchParams.get('channel'));
        const agentId = trimOptionalString(url.searchParams.get('agentId'));
        const userId = trimOptionalString(url.searchParams.get('userId'));
        const requestId = trimOptionalString(url.searchParams.get('requestId'));
        sendJSON(res, 200, await this.dashboard.onIntentRoutingTrace({
          limit: Number.isFinite(limit) ? limit : 20,
          ...(continuityKey ? { continuityKey } : {}),
          ...(activeExecutionRef ? { activeExecutionRef } : {}),
          ...(stage ? { stage } : {}),
          ...(channel ? { channel } : {}),
          ...(agentId ? { agentId } : {}),
          ...(userId ? { userId } : {}),
          ...(requestId ? { requestId } : {}),
        }));
        return;
      }

      const assistantRunMatch = req.method === 'GET'
        ? url.pathname.match(/^\/api\/assistant\/runs\/([^/]+)$/)
        : null;
      if (assistantRunMatch) {
        if (!this.dashboard.onAssistantRunDetail) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const runId = decodeURIComponent(assistantRunMatch[1]);
        const result = this.dashboard.onAssistantRunDetail(runId);
        if (!result) {
          sendJSON(res, 404, { error: 'Run not found' });
          return;
        }
        sendJSON(res, 200, result);
        return;
      }

      // GET /api/routing/mode — Current tier routing mode
      if (req.method === 'GET' && url.pathname === '/api/routing/mode') {
        if (!this.dashboard.onRoutingMode) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onRoutingMode());
        return;
      }

      // POST /api/routing/mode — Switch tier routing mode
      if (req.method === 'POST' && url.pathname === '/api/routing/mode') {
        if (!this.dashboard.onRoutingModeUpdate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { mode?: string };
        try {
          parsed = JSON.parse(body) as { mode?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        const valid = ['auto', 'local-only', 'external-only'];
        if (!parsed.mode || !valid.includes(parsed.mode)) {
          sendJSON(res, 400, { error: `mode must be one of: ${valid.join(', ')}` });
          return;
        }
        const result = this.dashboard.onRoutingModeUpdate(parsed.mode as 'auto' | 'local-only' | 'external-only');
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['config', 'dashboard'], 'routing.mode.updated', url.pathname);
        return;
      }

      // POST /api/message/stream — Stream a response via SSE events
      if (req.method === 'POST' && url.pathname === '/api/message/stream') {
        if (!this.dashboard.onStreamDispatch) {
          sendJSON(res, 404, { error: 'Streaming not available' });
          return;
        }

        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          const status = message.includes('too large') ? 413 : 400;
          sendJSON(res, status, { error: message });
          return;
        }

        let parsed: {
          content?: unknown;
          userId?: string;
          agentId?: unknown;
          requestId?: unknown;
          surfaceId?: unknown;
          channel?: string;
          metadata?: Record<string, unknown>;
        };
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        const content = asNonEmptyString(parsed.content);
        const agentId = trimOptionalString(parsed.agentId);
        const requestId = trimOptionalString(parsed.requestId);
        if (!content) {
          sendJSON(res, 400, { error: 'content is required' });
          return;
        }

        const emitSSE = (event: import('./web-types.js').SSEEvent) => {
          for (const client of this.sseClients) {
            if (!client.destroyed) {
              client.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
            }
          }
        };

        try {
          const principal = this.resolveRequestPrincipal(req);
          const result = await this.dashboard.onStreamDispatch(
            agentId,
            {
              requestId,
              content,
              userId: parsed.userId,
              surfaceId: trimOptionalString(parsed.surfaceId),
              principalId: principal.principalId,
              principalRole: principal.principalRole,
              channel: parsed.channel ?? 'web',
              metadata: asRecord(parsed.metadata),
            },
            emitSSE,
          );
          sendJSON(res, 200, result);
        } catch (err) {
          const requestError = getRequestErrorDetails(err);
          if (requestError) {
            sendJSON(res, requestError.statusCode, {
              error: requestError.error,
              ...(requestError.errorCode ? { errorCode: requestError.errorCode } : {}),
            });
            return;
          }
          logInternalError('Stream dispatch failed', err);
          sendJSON(res, 500, { error: 'Stream dispatch error' });
        }
        return;
      }

      // POST /api/message — Send a message to an agent
      if (req.method === 'POST' && url.pathname === '/api/message') {
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          const status = message.includes('too large') ? 413 : 400;
          sendJSON(res, status, { error: message });
          return;
        }

        let parsed: {
          content?: unknown;
          userId?: string;
          agentId?: unknown;
          surfaceId?: unknown;
          channel?: string;
          metadata?: Record<string, unknown>;
        };
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        const content = asNonEmptyString(parsed.content);
        const agentId = trimOptionalString(parsed.agentId);
        if (!content) {
          sendJSON(res, 400, { error: 'content is required' });
          return;
        }

        // Agent-targeted dispatch via dashboard callback
        if (agentId && this.dashboard.onDispatch) {
          try {
            const principal = this.resolveRequestPrincipal(req);
            const response = await this.dashboard.onDispatch(agentId, {
              content,
              userId: parsed.userId,
              surfaceId: trimOptionalString(parsed.surfaceId),
              principalId: principal.principalId,
              principalRole: principal.principalRole,
              channel: parsed.channel ?? 'web',
              metadata: asRecord(parsed.metadata),
            });
            sendJSON(res, 200, response);
          } catch (err) {
            const requestError = getRequestErrorDetails(err);
            if (requestError) {
              sendJSON(res, requestError.statusCode, {
                error: requestError.error,
                ...(requestError.errorCode ? { errorCode: requestError.errorCode } : {}),
              });
              return;
            }
            logInternalError('Message dispatch failed', err);
            const detail = err instanceof Error ? err.message : String(err);
            sendJSON(res, 500, { error: `Dispatch error: ${detail}` });
          }
          return;
        }

        // Fallback to default message handler
        if (!this.onMessage) {
          sendJSON(res, 503, { error: 'No message handler registered' });
          return;
        }

        try {
          const principal = this.resolveRequestPrincipal(req);
          const response = await this.onMessage({
            id: randomUUID(),
            userId: parsed.userId ?? 'web-user',
            surfaceId: trimOptionalString(parsed.surfaceId),
            principalId: principal.principalId,
            principalRole: principal.principalRole,
            channel: parsed.channel ?? 'web',
            content,
            metadata: asRecord(parsed.metadata),
            timestamp: Date.now(),
          });
          sendJSON(res, 200, response);
        } catch (err) {
          const requestError = getRequestErrorDetails(err);
          if (requestError) {
            sendJSON(res, requestError.statusCode, {
              error: requestError.error,
              ...(requestError.errorCode ? { errorCode: requestError.errorCode } : {}),
            });
            return;
          }
          logInternalError('Message dispatch failed', err);
          const detail = err instanceof Error ? err.message : String(err);
          sendJSON(res, 500, { error: `Dispatch error: ${detail}` });
        }
        return;
      }

      // POST /api/conversations/reset — Reset conversation memory
      if (req.method === 'POST' && url.pathname === '/api/conversations/reset') {
        if (!this.dashboard.onConversationReset) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }

        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          const status = message.includes('too large') ? 413 : 400;
          sendJSON(res, status, { error: message });
          return;
        }

        let parsed: { agentId?: string; userId?: string; channel?: string };
        try {
          parsed = JSON.parse(body) as { agentId?: string; userId?: string; channel?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        if (!parsed.agentId) {
          sendJSON(res, 400, { error: 'agentId is required' });
          return;
        }

        try {
          const result = await this.dashboard.onConversationReset({
            agentId: parsed.agentId,
            userId: parsed.userId ?? 'web-user',
            channel: parsed.channel ?? 'web',
          });
          sendJSON(res, 200, result);
          this.maybeEmitUIInvalidation(result, ['dashboard'], 'conversation.reset', url.pathname);
        } catch (err) {
          logInternalError('Conversation reset failed', err);
          sendJSON(res, 500, { error: 'Reset failed' });
        }
        return;
      }

      // GET /api/conversations/sessions — list user sessions
      if (req.method === 'GET' && url.pathname === '/api/conversations/sessions') {
        if (!this.dashboard.onConversationSessions) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }

        const userId = url.searchParams.get('userId') ?? 'web-user';
        const channel = url.searchParams.get('channel') ?? 'web';
        const agentId = url.searchParams.get('agentId') ?? undefined;

        sendJSON(res, 200, this.dashboard.onConversationSessions({ userId, channel, agentId }));
        return;
      }

      // POST /api/conversations/session — switch active session
      if (req.method === 'POST' && url.pathname === '/api/conversations/session') {
        if (!this.dashboard.onConversationUseSession) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }

        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          const status = message.includes('too large') ? 413 : 400;
          sendJSON(res, status, { error: message });
          return;
        }

        let parsed: { agentId?: string; userId?: string; channel?: string; sessionId?: string };
        try {
          parsed = JSON.parse(body) as { agentId?: string; userId?: string; channel?: string; sessionId?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        if (!parsed.agentId || !parsed.sessionId) {
          sendJSON(res, 400, { error: 'agentId and sessionId are required' });
          return;
        }

        const result = this.dashboard.onConversationUseSession({
          agentId: parsed.agentId,
          userId: parsed.userId ?? 'web-user',
          channel: parsed.channel ?? 'web',
          sessionId: parsed.sessionId,
        });
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['dashboard'], 'conversation.session.selected', url.pathname);
        return;
      }

      // POST /api/quick-actions/run — execute structured assistant action
      if (req.method === 'POST' && url.pathname === '/api/quick-actions/run') {
        if (!this.dashboard.onQuickActionRun) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }

        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          const status = message.includes('too large') ? 413 : 400;
          sendJSON(res, status, { error: message });
          return;
        }

        let parsed: { actionId?: string; details?: string; agentId?: string; userId?: string; channel?: string };
        try {
          parsed = JSON.parse(body) as { actionId?: string; details?: string; agentId?: string; userId?: string; channel?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        if (!parsed.actionId || !parsed.agentId) {
          sendJSON(res, 400, { error: 'actionId and agentId are required' });
          return;
        }

        try {
          const result = await this.dashboard.onQuickActionRun({
            actionId: parsed.actionId,
            details: parsed.details ?? '',
            agentId: parsed.agentId,
            userId: parsed.userId ?? 'web-user',
            channel: parsed.channel ?? 'web',
          });
          sendJSON(res, 200, result);
        } catch (err) {
          logInternalError('Quick action failed', err);
          sendJSON(res, 500, { error: 'Quick action failed' });
        }
        return;
      }

      // GET /sse — Server-Sent Events stream
      if (req.method === 'GET' && url.pathname === '/sse') {
        this.handleSSE(req, res);
        return;
      }

      // ─── Scheduled Tasks API ─────────────────────────────────

      // GET /api/automations/catalog — Unified saved automation catalog
      if (req.method === 'GET' && url.pathname === '/api/automations/catalog') {
        if (!this.dashboard.onAutomationCatalog) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onAutomationCatalog());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/automations/history') {
        if (!this.dashboard.onAutomationRunHistory) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onAutomationRunHistory());
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/automations/save') {
        if (!this.dashboard.onAutomationSave) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body = '{}';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: AutomationSaveInput;
        try {
          parsed = body ? JSON.parse(body) as AutomationSaveInput : {} as AutomationSaveInput;
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        const result = this.dashboard.onAutomationSave(parsed);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['automations'], 'automation.saved', url.pathname);
        return;
      }

      if (req.method === 'POST' && url.pathname.match(/^\/api\/automations\/[^/]+\/definition$/)) {
        if (!this.dashboard.onAutomationDefinitionSave) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const automationId = decodeURIComponent(url.pathname.split('/')[3] || '').trim();
        if (!automationId) {
          sendJSON(res, 400, { error: 'automationId is required' });
          return;
        }
        let body = '{}';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: AssistantConnectorPlaybookDefinition;
        try {
          parsed = body ? JSON.parse(body) as AssistantConnectorPlaybookDefinition : {} as AssistantConnectorPlaybookDefinition;
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        const result = this.dashboard.onAutomationDefinitionSave(automationId, parsed);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['automations'], 'automation.definition_saved', url.pathname);
        return;
      }

      if (req.method === 'POST' && url.pathname.match(/^\/api\/automations\/[^/]+\/create$/)) {
        if (!this.dashboard.onAutomationCreate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const automationId = decodeURIComponent(url.pathname.split('/')[3] || '').trim();
        if (!automationId) {
          sendJSON(res, 400, { error: 'automationId is required' });
          return;
        }
        const result = this.dashboard.onAutomationCreate(automationId);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['automations'], 'automation.created', url.pathname);
        return;
      }

      if (req.method === 'POST' && url.pathname.match(/^\/api\/automations\/[^/]+\/run$/)) {
        if (!this.dashboard.onAutomationRun) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const automationId = decodeURIComponent(url.pathname.split('/')[3] || '').trim();
        if (!automationId) {
          sendJSON(res, 400, { error: 'automationId is required' });
          return;
        }
        let body = '{}';
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: {
          dryRun?: boolean;
          origin?: 'assistant' | 'cli' | 'web';
          agentId?: string;
          userId?: string;
          channel?: string;
          requestedBy?: string;
        };
        try {
          parsed = body ? JSON.parse(body) as typeof parsed : {};
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        const result = await this.dashboard.onAutomationRun({
          automationId,
          dryRun: parsed?.dryRun === true,
          origin: parsed?.origin,
          agentId: trimOptionalString(parsed?.agentId),
          userId: trimOptionalString(parsed?.userId),
          channel: trimOptionalString(parsed?.channel),
          requestedBy: trimOptionalString(parsed?.requestedBy),
        });
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['automations'], 'automation.run', url.pathname);
        return;
      }

      if (req.method === 'POST' && url.pathname.match(/^\/api\/automations\/[^/]+\/enabled$/)) {
        if (!this.dashboard.onAutomationSetEnabled) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const automationId = decodeURIComponent(url.pathname.split('/')[3] || '').trim();
        if (!automationId) {
          sendJSON(res, 400, { error: 'automationId is required' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { enabled?: boolean };
        try {
          parsed = JSON.parse(body) as { enabled?: boolean };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (typeof parsed.enabled !== 'boolean') {
          sendJSON(res, 400, { error: 'enabled must be a boolean' });
          return;
        }
        const result = this.dashboard.onAutomationSetEnabled(automationId, parsed.enabled);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['automations'], 'automation.enabled', url.pathname);
        return;
      }

      if (req.method === 'DELETE' && url.pathname.match(/^\/api\/automations\/[^/]+$/)) {
        if (!this.dashboard.onAutomationDelete) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const automationId = decodeURIComponent(url.pathname.split('/')[3] || '').trim();
        if (!automationId) {
          sendJSON(res, 400, { error: 'automationId is required' });
          return;
        }
        const result = this.dashboard.onAutomationDelete(automationId);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['automations'], 'automation.deleted', url.pathname);
        return;
      }

      // GET /api/scheduled-tasks — List all scheduled tasks
      if (req.method === 'GET' && url.pathname === '/api/scheduled-tasks') {
        if (!this.dashboard.onScheduledTasks) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onScheduledTasks());
        return;
      }

      // GET /api/scheduled-tasks/history — Get run history
      if (req.method === 'GET' && url.pathname === '/api/scheduled-tasks/history') {
        if (!this.dashboard.onScheduledTaskHistory) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onScheduledTaskHistory());
        return;
      }

      // POST /api/scheduled-tasks/:id/run — Manually trigger a task now
      if (req.method === 'POST' && url.pathname.match(/^\/api\/scheduled-tasks\/[^/]+\/run$/)) {
        if (!this.dashboard.onScheduledTaskRunNow) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const parts = url.pathname.split('/');
        const id = decodeURIComponent(parts[3]);
        if (!id) {
          sendJSON(res, 400, { error: 'Task ID required' });
          return;
        }
        const result = await this.dashboard.onScheduledTaskRunNow(id);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['automations', 'network', 'security'], 'scheduled-task.ran', url.pathname);
        return;
      }

      // POST /api/scheduled-tasks — Create new scheduled task
      if (req.method === 'POST' && url.pathname === '/api/scheduled-tasks') {
        if (!this.dashboard.onScheduledTaskCreate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        const principal = this.resolveRequestPrincipal(req);
        const result = this.dashboard.onScheduledTaskCreate(
          {
            ...parsed,
            principalId: principal.principalId,
            principalRole: principal.principalRole,
          } as unknown as Parameters<NonNullable<typeof this.dashboard.onScheduledTaskCreate>>[0],
        );
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['automations', 'network'], 'scheduled-task.created', url.pathname);
        return;
      }

      // PUT /api/scheduled-tasks/:id — Update existing task
      if (req.method === 'PUT' && url.pathname.startsWith('/api/scheduled-tasks/')) {
        if (!this.dashboard.onScheduledTaskUpdate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice('/api/scheduled-tasks/'.length));
        if (!id) {
          sendJSON(res, 400, { error: 'Task ID required' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        const principal = this.resolveRequestPrincipal(req);
        const result = this.dashboard.onScheduledTaskUpdate(
          id,
          {
            ...parsed,
            principalId: principal.principalId,
            principalRole: principal.principalRole,
          } as Parameters<NonNullable<typeof this.dashboard.onScheduledTaskUpdate>>[1],
        );
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['automations', 'network'], 'scheduled-task.updated', url.pathname);
        return;
      }

      // DELETE /api/scheduled-tasks/:id — Delete task
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/scheduled-tasks/')) {
        if (!this.dashboard.onScheduledTaskDelete) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice('/api/scheduled-tasks/'.length));
        if (!id) {
          sendJSON(res, 400, { error: 'Task ID required' });
          return;
        }
        const result = this.dashboard.onScheduledTaskDelete(id);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['automations', 'network'], 'scheduled-task.deleted', url.pathname);
        return;
      }

      // GET /api/scheduled-tasks/:id — Get single task
      if (req.method === 'GET' && url.pathname.startsWith('/api/scheduled-tasks/')) {
        if (!this.dashboard.onScheduledTaskGet) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice('/api/scheduled-tasks/'.length));
        if (!id) {
          sendJSON(res, 400, { error: 'Task ID required' });
          return;
        }
        const task = this.dashboard.onScheduledTaskGet(id);
        if (!task) {
          sendJSON(res, 404, { error: 'Task not found' });
          return;
        }
        sendJSON(res, 200, task);
        return;
      }

      // ─── Document Search Routes ──────────────────────────────

      // GET /api/search/status — Search engine status and indexed sources
      if (req.method === 'GET' && url.pathname === '/api/search/status') {
        if (!this.dashboard.onSearchStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, await this.dashboard.onSearchStatus());
        return;
      }

      // GET /api/search/sources — List configured document sources
      if (req.method === 'GET' && url.pathname === '/api/search/sources') {
        if (!this.dashboard.onSearchSources) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onSearchSources());
        return;
      }

      // POST /api/search/sources — Add a new document source
      if (req.method === 'POST' && url.pathname === '/api/search/sources') {
        if (!this.dashboard.onSearchSourceAdd) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.id || !parsed.name || !parsed.path || !parsed.type) {
          sendJSON(res, 400, { error: 'id, name, path, and type are required' });
          return;
        }
        const result = this.dashboard.onSearchSourceAdd(
          parsed as unknown as Parameters<NonNullable<typeof this.dashboard.onSearchSourceAdd>>[0],
        );
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['config'], 'search.source.added', url.pathname);
        return;
      }

      // POST /api/search/pick-path — open local native picker for search source paths
      if (req.method === 'POST' && url.pathname === '/api/search/pick-path') {
        if (!this.dashboard.onSearchPickPath) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { kind?: 'directory' | 'file'; ticket?: string };
        try {
          parsed = JSON.parse(body) as { kind?: 'directory' | 'file'; ticket?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!this.requirePrivilegedTicket(req, res, url, 'search.pick-path', parsed.ticket)) {
          return;
        }
        if (parsed.kind !== 'directory' && parsed.kind !== 'file') {
          sendJSON(res, 400, { error: "kind must be 'directory' or 'file'" });
          return;
        }
        try {
          const result = await this.dashboard.onSearchPickPath({ kind: parsed.kind });
          sendJSON(res, 200, result);
        } catch (err) {
          logInternalError('Search path picker failed', err);
          sendJSON(res, 500, { error: 'Path picker failed' });
        }
        return;
      }

      // DELETE /api/search/sources/:id — Remove a document source
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/search/sources/')) {
        if (!this.dashboard.onSearchSourceRemove) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice('/api/search/sources/'.length));
        if (!id) {
          sendJSON(res, 400, { error: 'Source ID required' });
          return;
        }
        const result = this.dashboard.onSearchSourceRemove(id);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['config'], 'search.source.removed', url.pathname);
        return;
      }

      // PATCH /api/search/sources/:id — Toggle source enabled/disabled
      if (req.method === 'PATCH' && url.pathname.startsWith('/api/search/sources/')) {
        if (!this.dashboard.onSearchSourceToggle) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice('/api/search/sources/'.length));
        if (!id) {
          sendJSON(res, 400, { error: 'Source ID required' });
          return;
        }
        let body: string;
        try {
          body = await readBody(req, this.maxBodyBytes);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Bad request';
          sendJSON(res, 400, { error: message });
          return;
        }
        let parsed: { enabled?: boolean };
        try {
          parsed = JSON.parse(body) as { enabled?: boolean };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (typeof parsed.enabled !== 'boolean') {
          sendJSON(res, 400, { error: 'enabled (boolean) is required' });
          return;
        }
        const result = this.dashboard.onSearchSourceToggle(id, parsed.enabled);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['config'], 'search.source.toggled', url.pathname);
        return;
      }

      // POST /api/search/reindex — Trigger reindex of document sources
      if (req.method === 'POST' && url.pathname === '/api/search/reindex') {
        if (!this.dashboard.onSearchReindex) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let collection: string | undefined;
        try {
          const body = await readBody(req, this.maxBodyBytes);
          if (body.trim()) {
            const parsed = JSON.parse(body) as { collection?: string };
            collection = parsed.collection;
          }
        } catch {
          // No body or invalid JSON — reindex all
        }
        const result = await this.dashboard.onSearchReindex(collection);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['config'], 'search.reindex.started', url.pathname);
        return;
      }

      // GET /api/gws/status — Google Workspace connection status
      if (req.method === 'GET' && url.pathname === '/api/gws/status') {
        if (!this.dashboard.onGwsStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, await this.dashboard.onGwsStatus());
        return;
      }

      // POST /api/gws/reauth — Trigger Google Workspace re-authentication
      if (req.method === 'POST' && url.pathname === '/api/gws/reauth') {
        try {
          const { execFile } = await import('node:child_process');
          const gwsCmd = 'gws';
          const child = execFile(gwsCmd, ['auth', 'login'], {
            shell: process.platform === 'win32',
            timeout: 120_000,
          } as any);
          let stdout = '';
          let stderr = '';
          child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
          child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
          const exitCode = await new Promise<number>((resolve) => {
            child.on('close', (code) => resolve(code ?? 1));
            child.on('error', () => resolve(1));
          });
          if (exitCode === 0) {
            sendJSON(res, 200, { success: true, message: 'Authentication successful. Refresh status to verify.' });
          } else {
            sendJSON(res, 200, { success: false, message: `Authentication flow exited with code ${exitCode}. Check the browser window that opened.`, detail: stderr || stdout });
          }
        } catch (err) {
          sendJSON(res, 500, { success: false, message: err instanceof Error ? err.message : 'Failed to start auth flow' });
        }
        return;
      }

      // ── Native Google integration routes ───────────────────
      // GET /api/google/status — Native Google auth status
      if (req.method === 'GET' && url.pathname === '/api/google/status') {
        if (!this.dashboard.onGoogleStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, await this.dashboard.onGoogleStatus());
        return;
      }

      // POST /api/google/auth/start — Start native OAuth flow
      if (req.method === 'POST' && url.pathname === '/api/google/auth/start') {
        if (!this.dashboard.onGoogleAuthStart) {
          sendJSON(res, 404, { error: 'Native Google integration not enabled' });
          return;
        }
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as { services?: string[] };
        sendJSON(res, 200, await this.dashboard.onGoogleAuthStart(parsed.services ?? []));
        return;
      }

      // POST /api/google/credentials — Upload client_secret.json
      if (req.method === 'POST' && url.pathname === '/api/google/credentials') {
        if (!this.dashboard.onGoogleCredentials) {
          sendJSON(res, 404, { error: 'Native Google integration not enabled' });
          return;
        }
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as { credentials?: string };
        if (!parsed.credentials) {
          sendJSON(res, 400, { success: false, message: 'Missing credentials field.' });
          return;
        }
        sendJSON(res, 200, await this.dashboard.onGoogleCredentials(parsed.credentials));
        return;
      }

      // POST /api/google/disconnect — Revoke and clear tokens
      if (req.method === 'POST' && url.pathname === '/api/google/disconnect') {
        if (!this.dashboard.onGoogleDisconnect) {
          sendJSON(res, 404, { error: 'Native Google integration not enabled' });
          return;
        }
        sendJSON(res, 200, await this.dashboard.onGoogleDisconnect());
        return;
      }

      // ── Native Microsoft 365 integration routes ─────────────
      // GET /api/microsoft/status — Native Microsoft auth status
      if (req.method === 'GET' && url.pathname === '/api/microsoft/status') {
        if (!this.dashboard.onMicrosoftStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, await this.dashboard.onMicrosoftStatus());
        return;
      }

      // POST /api/microsoft/auth/start — Start native Microsoft OAuth flow
      if (req.method === 'POST' && url.pathname === '/api/microsoft/auth/start') {
        if (!this.dashboard.onMicrosoftAuthStart) {
          sendJSON(res, 404, { error: 'Native Microsoft integration not enabled' });
          return;
        }
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as { services?: string[] };
        sendJSON(res, 200, await this.dashboard.onMicrosoftAuthStart(parsed.services ?? []));
        return;
      }

      // POST /api/microsoft/config — Save client ID / tenant ID
      if (req.method === 'POST' && url.pathname === '/api/microsoft/config') {
        if (!this.dashboard.onMicrosoftConfig) {
          sendJSON(res, 404, { error: 'Native Microsoft integration not enabled' });
          return;
        }
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as { clientId?: string; tenantId?: string };
        if (!parsed.clientId) {
          sendJSON(res, 400, { success: false, message: 'Missing clientId field.' });
          return;
        }
        sendJSON(res, 200, await this.dashboard.onMicrosoftConfig({ clientId: parsed.clientId, tenantId: parsed.tenantId }));
        return;
      }

      // POST /api/microsoft/disconnect — Clear tokens
      if (req.method === 'POST' && url.pathname === '/api/microsoft/disconnect') {
        if (!this.dashboard.onMicrosoftDisconnect) {
          sendJSON(res, 404, { error: 'Native Microsoft integration not enabled' });
          return;
        }
        sendJSON(res, 200, await this.dashboard.onMicrosoftDisconnect());
        return;
      }

      // GET /api/guardian-agent/status — Guardian Agent inline evaluation status
      if (req.method === 'GET' && url.pathname === '/api/guardian-agent/status') {
        if (!this.dashboard.onGuardianAgentStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onGuardianAgentStatus());
        return;
      }

      // POST /api/guardian-agent/config — Update Guardian Agent settings
      if (req.method === 'POST' && url.pathname === '/api/guardian-agent/config') {
        if (!this.dashboard.onGuardianAgentUpdate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const body = await readBody(req, this.maxBodyBytes);
        const input = JSON.parse(body) as {
          enabled?: boolean;
          llmProvider?: 'local' | 'external' | 'auto';
          failOpen?: boolean;
          timeoutMs?: number;
          ticket?: string;
        };
        if (!this.requirePrivilegedTicket(req, res, url, 'guardian.config', input.ticket)) {
          return;
        }
        const result = this.dashboard.onGuardianAgentUpdate(input);
        sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
        this.maybeEmitUIInvalidation(result, ['config', 'security'], 'guardian-agent.updated', url.pathname);
        return;
      }

      // GET /api/policy/status — Policy-as-Code engine status
      if (req.method === 'GET' && url.pathname === '/api/policy/status') {
        if (!this.dashboard.onPolicyStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onPolicyStatus());
        return;
      }

      // POST /api/policy/config — Update Policy-as-Code engine config
      if (req.method === 'POST' && url.pathname === '/api/policy/config') {
        if (!this.dashboard.onPolicyUpdate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const body = await readBody(req, this.maxBodyBytes);
        const input = JSON.parse(body) as {
          enabled?: boolean;
          mode?: 'off' | 'shadow' | 'enforce';
          families?: {
            tool?: 'off' | 'shadow' | 'enforce';
            admin?: 'off' | 'shadow' | 'enforce';
            guardian?: 'off' | 'shadow' | 'enforce';
            event?: 'off' | 'shadow' | 'enforce';
          };
          mismatchLogLimit?: number;
          ticket?: string;
        };
        if (!this.requirePrivilegedTicket(req, res, url, 'policy.config', input.ticket)) {
          return;
        }
        const result = this.dashboard.onPolicyUpdate(input);
        sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
        this.maybeEmitUIInvalidation(result, ['config', 'security'], 'policy.config.updated', url.pathname);
        return;
      }

      // POST /api/policy/reload — Reload policy rules from disk
      if (req.method === 'POST' && url.pathname === '/api/policy/reload') {
        if (!this.dashboard.onPolicyReload) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let parsed: { ticket?: string } = {};
        try {
          const body = await readBody(req, this.maxBodyBytes);
          if (body.trim()) {
            parsed = JSON.parse(body) as { ticket?: string };
          }
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!this.requirePrivilegedTicket(req, res, url, 'policy.config', parsed.ticket)) {
          return;
        }
        const result = this.dashboard.onPolicyReload();
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['config', 'security'], 'policy.reloaded', url.pathname);
        return;
      }

      // POST /api/sentinel/audit — Run Sentinel audit on-demand
      if (req.method === 'POST' && url.pathname === '/api/sentinel/audit') {
        if (!this.dashboard.onSentinelAuditRun) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let windowMs: number | undefined;
        try {
          const body = await readBody(req, this.maxBodyBytes);
          if (body) {
            const parsed = JSON.parse(body) as { windowMs?: number };
            windowMs = parsed.windowMs;
          }
        } catch { /* empty body is fine */ }
        const result = await this.dashboard.onSentinelAuditRun(windowMs);
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['security'], 'sentinel.audit.completed', url.pathname);
        return;
      }

      // POST /api/factory-reset — Bulk reset data, config, or both
      if (req.method === 'POST' && url.pathname === '/api/factory-reset') {
        if (!this.dashboard.onFactoryReset) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body) as { scope?: string; ticket?: string };
        if (!parsed.scope || !['data', 'config', 'all'].includes(parsed.scope)) {
          sendJSON(res, 400, { error: 'scope must be "data", "config", or "all"' });
          return;
        }
        if (!this.requirePrivilegedTicket(req, res, url, 'factory-reset', parsed.ticket)) {
          return;
        }
        const result = await this.dashboard.onFactoryReset({ scope: parsed.scope as 'data' | 'config' | 'all' });
        sendJSON(res, 200, result);
        this.maybeEmitUIInvalidation(result, ['dashboard', 'config', 'providers', 'tools', 'automations', 'network', 'security'], 'factory-reset.completed', url.pathname);
        if (parsed.scope === 'all' && result.success && this.dashboard.onKillswitch) {
          setTimeout(() => this.dashboard.onKillswitch!(), 100);
        }
        return;
      }

      // POST /api/killswitch — Shut down the entire process
      if (req.method === 'POST' && url.pathname === '/api/killswitch') {
        if (!this.dashboard.onKillswitch) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        let parsed: { ticket?: string } = {};
        try {
          const body = await readBody(req, this.maxBodyBytes);
          if (body.trim()) {
            parsed = JSON.parse(body) as { ticket?: string };
          }
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!this.requirePrivilegedTicket(req, res, url, 'killswitch', parsed.ticket)) {
          return;
        }
        sendJSON(res, 200, { success: true, message: 'Shutting down...' });
        // Small delay so the HTTP response is flushed before the process exits
        setTimeout(() => this.dashboard.onKillswitch!(), 100);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/code/sessions') {
        if (!this.dashboard.onCodeSessionsList) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const principal = this.resolveRequestPrincipal(req);
        const userId = url.searchParams.get('userId') || 'web-user';
        const channel = url.searchParams.get('channel') || 'web';
        sendJSON(res, 200, this.dashboard.onCodeSessionsList({
          userId,
          principalId: principal.principalId,
          channel,
          surfaceId: readSurfaceIdFromSearchParams(url) ?? userId,
        }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/code/sessions') {
        if (!this.dashboard.onCodeSessionCreate) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as {
          userId?: string;
          channel?: string;
          surfaceId?: string;
          title?: string;
          workspaceRoot?: string;
          agentId?: string | null;
          attach?: boolean;
        };
        if (!trimOptionalString(parsed.title) || !trimOptionalString(parsed.workspaceRoot)) {
          sendJSON(res, 400, { error: 'title and workspaceRoot are required' });
          return;
        }
        const principal = this.resolveRequestPrincipal(req);
        const result = this.dashboard.onCodeSessionCreate({
          userId: parsed.userId || 'web-user',
          principalId: principal.principalId,
          channel: parsed.channel || 'web',
          surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
          title: parsed.title!,
          workspaceRoot: parsed.workspaceRoot!,
          agentId: trimOptionalString(parsed.agentId) ?? null,
          attach: parsed.attach !== false,
        });
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/code/sessions/detach') {
        if (!this.dashboard.onCodeSessionDetach) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as { userId?: string; channel?: string; surfaceId?: string };
        const principal = this.resolveRequestPrincipal(req);
        const result = this.dashboard.onCodeSessionDetach({
          userId: parsed.userId || 'web-user',
          principalId: principal.principalId,
          channel: parsed.channel || 'web',
          surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
        });
        sendJSON(res, 200, result);
        return;
      }

      const codeSessionAttachMatch = req.method === 'POST'
        ? url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/attach$/)
        : null;
      if (codeSessionAttachMatch) {
        if (!this.dashboard.onCodeSessionAttach) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const sessionId = decodeURIComponent(codeSessionAttachMatch[1]);
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as { userId?: string; channel?: string; surfaceId?: string; mode?: string };
        const principal = this.resolveRequestPrincipal(req);
        const result = this.dashboard.onCodeSessionAttach({
          sessionId,
          userId: parsed.userId || 'web-user',
          principalId: principal.principalId,
          channel: parsed.channel || 'web',
          surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
          mode: trimOptionalString(parsed.mode) as import('../runtime/code-sessions.js').CodeSessionAttachmentMode | undefined,
        });
        sendJSON(res, 200, result);
        return;
      }

      const codeSessionApprovalMatch = req.method === 'POST'
        ? url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/approvals\/([^/]+)$/)
        : null;
      if (codeSessionApprovalMatch) {
        if (!this.dashboard.onCodeSessionApprovalDecision) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const sessionId = decodeURIComponent(codeSessionApprovalMatch[1]);
        const approvalId = decodeURIComponent(codeSessionApprovalMatch[2]);
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as {
          userId?: string;
          channel?: string;
          surfaceId?: string;
          decision?: 'approved' | 'denied';
          reason?: string;
        };
        if (!parsed.decision || (parsed.decision !== 'approved' && parsed.decision !== 'denied')) {
          sendJSON(res, 400, { error: 'decision is required' });
          return;
        }
        const principal = this.resolveRequestPrincipal(req);
        try {
          const result = await this.dashboard.onCodeSessionApprovalDecision({
            sessionId,
            approvalId,
            decision: parsed.decision,
            userId: parsed.userId || 'web-user',
            principalId: principal.principalId,
            principalRole: principal.principalRole,
            channel: parsed.channel || 'web',
            surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
            reason: trimOptionalString(parsed.reason),
          });
          sendJSON(res, 200, result);
        } catch (err) {
          const requestError = getRequestErrorDetails(err);
          if (requestError) {
            sendJSON(res, requestError.statusCode, {
              error: requestError.error,
              ...(requestError.errorCode ? { errorCode: requestError.errorCode } : {}),
            });
            return;
          }
          logInternalError('Code session approval decision failed', err);
          const detail = err instanceof Error ? err.message : String(err);
          sendJSON(res, 500, { error: `Dispatch error: ${detail}` });
        }
        return;
      }

      const codeSessionResetMatch = req.method === 'POST'
        ? url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/reset$/)
        : null;
      if (codeSessionResetMatch) {
        if (!this.dashboard.onCodeSessionResetConversation) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const sessionId = decodeURIComponent(codeSessionResetMatch[1]);
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as { userId?: string; channel?: string };
        const result = this.dashboard.onCodeSessionResetConversation({
          sessionId,
          userId: parsed.userId || 'web-user',
          channel: parsed.channel || 'web',
        });
        sendJSON(res, 200, result);
        return;
      }

      const codeSessionTimelineMatch = req.method === 'GET'
        ? url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/timeline$/)
        : null;
      if (codeSessionTimelineMatch) {
        if (!this.dashboard.onCodeSessionTimeline) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        const sessionId = decodeURIComponent(codeSessionTimelineMatch[1]);
        const principal = this.resolveRequestPrincipal(req);
        const userId = url.searchParams.get('userId') || 'web-user';
        const channel = url.searchParams.get('channel') || 'web';
        const limit = Number.parseInt(url.searchParams.get('limit') || '12', 10);
        const result = this.dashboard.onCodeSessionTimeline({
          sessionId,
          userId,
          principalId: principal.principalId,
          channel,
          surfaceId: readSurfaceIdFromSearchParams(url) ?? userId,
          limit: Number.isFinite(limit) ? limit : 12,
        });
        if (!result) {
          sendJSON(res, 404, { error: 'Code session not found' });
          return;
        }
        sendJSON(res, 200, result);
        return;
      }

      const codeSessionMatch = url.pathname.match(/^\/api\/code\/sessions\/([^/]+)$/);
      if (codeSessionMatch) {
        const sessionId = decodeURIComponent(codeSessionMatch[1]);
        const principal = this.resolveRequestPrincipal(req);

        if (req.method === 'GET') {
          if (!this.dashboard.onCodeSessionGet) {
            sendJSON(res, 404, { error: 'Not available' });
            return;
          }
          const userId = url.searchParams.get('userId') || 'web-user';
          const channel = url.searchParams.get('channel') || 'web';
          const historyLimit = Number.parseInt(url.searchParams.get('historyLimit') || '120', 10);
          const result = this.dashboard.onCodeSessionGet({
            sessionId,
            userId,
            principalId: principal.principalId,
            channel,
            surfaceId: readSurfaceIdFromSearchParams(url) ?? userId,
            historyLimit: Number.isFinite(historyLimit) ? historyLimit : 120,
          });
          if (!result) {
            sendJSON(res, 404, { error: 'Code session not found' });
            return;
          }
          sendJSON(res, 200, result);
          return;
        }

        if (req.method === 'PATCH') {
          if (!this.dashboard.onCodeSessionUpdate) {
            sendJSON(res, 404, { error: 'Not available' });
            return;
          }
          const body = await readBody(req, this.maxBodyBytes);
          const parsed = JSON.parse(body || '{}') as {
            userId?: string;
            channel?: string;
            surfaceId?: string;
            title?: string;
            workspaceRoot?: string;
            agentId?: string | null;
            status?: string;
            uiState?: Record<string, unknown>;
            workState?: Record<string, unknown>;
          };
          const result = this.dashboard.onCodeSessionUpdate({
            sessionId,
            userId: parsed.userId || 'web-user',
            principalId: principal.principalId,
            channel: parsed.channel || 'web',
            surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
            title: trimOptionalString(parsed.title),
            workspaceRoot: trimOptionalString(parsed.workspaceRoot),
            agentId: hasOwn(parsed as object, 'agentId') ? (trimOptionalString(parsed.agentId) ?? null) : undefined,
            status: trimOptionalString(parsed.status) as import('../runtime/code-sessions.js').CodeSessionStatus | undefined,
            uiState: asRecord(parsed.uiState) as import('../runtime/code-sessions.js').CodeSessionUiState | undefined,
            workState: asRecord(parsed.workState) as import('../runtime/code-sessions.js').CodeSessionWorkState | undefined,
          });
          if (!result) {
            sendJSON(res, 404, { error: 'Code session not found' });
            return;
          }
          sendJSON(res, 200, result);
          return;
        }

        if (req.method === 'DELETE') {
          if (!this.dashboard.onCodeSessionDelete) {
            sendJSON(res, 404, { error: 'Not available' });
            return;
          }
          const body = await readBody(req, this.maxBodyBytes).catch(() => '');
          const parsed = JSON.parse(body || '{}') as { userId?: string; channel?: string; surfaceId?: string };
          const result = this.dashboard.onCodeSessionDelete({
            sessionId,
            userId: parsed.userId || 'web-user',
            principalId: principal.principalId,
            channel: parsed.channel || 'web',
            surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
          });
          sendJSON(res, result.success ? 200 : 404, result);
          return;
        }
      }

      const codeSessionStructureMatch = req.method === 'GET'
        ? url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/structure$/)
        : null;
      if (codeSessionStructureMatch) {
        if (!this.dashboard.onCodeSessionGet) {
          sendJSON(res, 404, { success: false, error: 'Not available' });
          return;
        }
        const sessionId = decodeURIComponent(codeSessionStructureMatch[1]);
        const principal = this.resolveRequestPrincipal(req);
        const userId = url.searchParams.get('userId') || 'web-user';
        const channel = url.searchParams.get('channel') || 'web';
        const snapshot = this.dashboard.onCodeSessionGet({
          sessionId,
          userId,
          principalId: principal.principalId,
          channel,
          surfaceId: readSurfaceIdFromSearchParams(url) ?? userId,
          historyLimit: 1,
        });
        if (!snapshot) {
          sendJSON(res, 404, { success: false, error: 'Code session not found' });
          return;
        }

        const requestedPath = trimOptionalString(url.searchParams.get('path'));
        const requestedSectionId = trimOptionalString(url.searchParams.get('sectionId'));
        const requestedLine = Number(url.searchParams.get('line')) || 0;
        const fallbackPath = trimOptionalString(snapshot.session.uiState.selectedFilePath);
        if (!requestedPath && !fallbackPath) {
          sendJSON(res, 400, { success: false, error: 'A file path is required for structure inspection.' });
          return;
        }

        let targetPath: string;
        try {
          targetPath = resolveCodeSessionPath(
            snapshot.session.resolvedRoot,
            requestedPath ?? fallbackPath ?? undefined,
          );
        } catch (err) {
          sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
          return;
        }

        try {
          const structure = inspectCodeWorkspaceFileStructureSync(
            snapshot.session.resolvedRoot,
            targetPath,
            Date.now(),
            {
              ...(requestedLine > 0 ? { lineNumber: requestedLine } : {}),
              ...(requestedSectionId ? { sectionId: requestedSectionId } : {}),
            },
          );
          sendJSON(res, 200, { success: true, ...structure });
        } catch (err) {
          sendJSON(res, 200, {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to inspect file structure',
          });
        }
        return;
      }

      const codeSessionStructurePreviewMatch = req.method === 'POST'
        ? url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/structure-preview$/)
        : null;
      if (codeSessionStructurePreviewMatch) {
        if (!this.dashboard.onCodeSessionGet) {
          sendJSON(res, 404, { success: false, error: 'Not available' });
          return;
        }
        const sessionId = decodeURIComponent(codeSessionStructurePreviewMatch[1]);
        const principal = this.resolveRequestPrincipal(req);
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as {
          userId?: string;
          channel?: string;
          surfaceId?: string;
          path?: string;
          content?: string;
          line?: number;
          sectionId?: string;
        };
        const snapshot = this.dashboard.onCodeSessionGet({
          sessionId,
          userId: parsed.userId || 'web-user',
          principalId: principal.principalId,
          channel: parsed.channel || 'web',
          surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
          historyLimit: 1,
        });
        if (!snapshot) {
          sendJSON(res, 404, { success: false, error: 'Code session not found' });
          return;
        }

        const requestedPath = trimOptionalString(parsed.path);
        if (!requestedPath) {
          sendJSON(res, 400, { success: false, error: 'A file path is required for structure preview.' });
          return;
        }
        if (typeof parsed.content !== 'string') {
          sendJSON(res, 400, { success: false, error: 'Structure preview content must be a string.' });
          return;
        }

        let targetPath: string;
        try {
          targetPath = resolveCodeSessionPath(snapshot.session.resolvedRoot, requestedPath);
        } catch (err) {
          sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
          return;
        }

        try {
          const structure = inspectCodeWorkspaceFileStructureTextSync(
            snapshot.session.resolvedRoot,
            targetPath,
            parsed.content,
            Date.now(),
            {
              ...(Number(parsed.line) > 0 ? { lineNumber: Number(parsed.line) } : {}),
              ...(trimOptionalString(parsed.sectionId) ? { sectionId: trimOptionalString(parsed.sectionId)! } : {}),
            },
          );
          sendJSON(res, 200, { success: true, ...structure });
        } catch (err) {
          sendJSON(res, 200, {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to inspect file structure preview',
          });
        }
        return;
      }

      // POST /api/code/fs/list — direct user directory listing for Code UI
      if (req.method === 'POST' && url.pathname === '/api/code/fs/list') {
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as {
          path?: string;
          sessionId?: string;
          userId?: string;
          channel?: string;
          surfaceId?: string;
        };
        let targetPath = resolve(parsed.path || '.');
        if (trimOptionalString(parsed.sessionId) && this.dashboard.onCodeSessionGet) {
          const principal = this.resolveRequestPrincipal(req);
          const snapshot = this.dashboard.onCodeSessionGet({
            sessionId: parsed.sessionId!,
            userId: parsed.userId || 'web-user',
            principalId: principal.principalId,
            channel: parsed.channel || 'web',
            surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
            historyLimit: 1,
          });
          if (!snapshot) {
            sendJSON(res, 404, { success: false, error: 'Code session not found' });
            return;
          }
          try {
            targetPath = resolveCodeSessionPath(snapshot.session.resolvedRoot, parsed.path, '.');
          } catch (err) {
            sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
            return;
          }
        }
        try {
          const entries = await readdir(targetPath, { withFileTypes: true });
          sendJSON(res, 200, {
            success: true,
            path: targetPath,
            entries: entries
              .filter((entry) => entry.isDirectory() || entry.isFile())
              .map((entry) => ({
                name: entry.name,
                type: entry.isDirectory() ? 'dir' : 'file',
              })),
          });
        } catch (err) {
          sendJSON(res, 200, { success: false, error: err instanceof Error ? err.message : 'Failed to list directory' });
        }
        return;
      }

      // POST /api/code/fs/read — direct user file read for Code UI
      if (req.method === 'POST' && url.pathname === '/api/code/fs/read') {
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as {
          path?: string;
          maxBytes?: number;
          sessionId?: string;
          userId?: string;
          channel?: string;
          surfaceId?: string;
        };
        let targetPath = resolve(parsed.path || '.');
        if (trimOptionalString(parsed.sessionId) && this.dashboard.onCodeSessionGet) {
          const principal = this.resolveRequestPrincipal(req);
          const snapshot = this.dashboard.onCodeSessionGet({
            sessionId: parsed.sessionId!,
            userId: parsed.userId || 'web-user',
            principalId: principal.principalId,
            channel: parsed.channel || 'web',
            surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
            historyLimit: 1,
          });
          if (!snapshot) {
            sendJSON(res, 404, { success: false, error: 'Code session not found' });
            return;
          }
          try {
            targetPath = resolveCodeSessionPath(snapshot.session.resolvedRoot, parsed.path);
          } catch (err) {
            sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
            return;
          }
        }
        const maxBytes = Math.max(1024, Math.min(500_000, Number(parsed.maxBytes) || 250_000));
        try {
          const content = await readFile(targetPath, 'utf-8');
          sendJSON(res, 200, {
            success: true,
            path: targetPath,
            content: content.length > maxBytes ? content.slice(0, maxBytes) : content,
          });
        } catch (err) {
          sendJSON(res, 200, { success: false, error: err instanceof Error ? err.message : 'Failed to read file' });
        }
        return;
      }

      // POST /api/code/fs/write — direct user file write for Code UI editor
      if (req.method === 'POST' && url.pathname === '/api/code/fs/write') {
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as {
          path?: string;
          content?: string;
          sessionId?: string;
          userId?: string;
          channel?: string;
          surfaceId?: string;
        };
        if (typeof parsed.content !== 'string') {
          sendJSON(res, 400, { success: false, error: 'Missing content' });
          return;
        }
        let targetPath = resolve(parsed.path || '.');
        if (trimOptionalString(parsed.sessionId) && this.dashboard.onCodeSessionGet) {
          const principal = this.resolveRequestPrincipal(req);
          const snapshot = this.dashboard.onCodeSessionGet({
            sessionId: parsed.sessionId!,
            userId: parsed.userId || 'web-user',
            principalId: principal.principalId,
            channel: parsed.channel || 'web',
            surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
            historyLimit: 1,
          });
          if (!snapshot) {
            sendJSON(res, 404, { success: false, error: 'Code session not found' });
            return;
          }
          try {
            targetPath = resolveCodeSessionPath(snapshot.session.resolvedRoot, parsed.path);
          } catch (err) {
            sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
            return;
          }
        }
        try {
          const { writeFile } = await import('node:fs/promises');
          await writeFile(targetPath, parsed.content, 'utf-8');
          sendJSON(res, 200, { success: true, path: targetPath });
        } catch (err) {
          sendJSON(res, 200, { success: false, error: err instanceof Error ? err.message : 'Failed to write file' });
        }
        return;
      }

      // POST /api/code/git/diff — direct user git diff for Code UI
      if (req.method === 'POST' && url.pathname === '/api/code/git/diff') {
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as {
          cwd?: string;
          path?: string;
          staged?: boolean;
          sessionId?: string;
          userId?: string;
          channel?: string;
          surfaceId?: string;
        };
        let cwd = resolve(parsed.cwd || '.');
        let sessionPath = trimOptionalString(parsed.path);
        if (trimOptionalString(parsed.sessionId) && this.dashboard.onCodeSessionGet) {
          const principal = this.resolveRequestPrincipal(req);
          const snapshot = this.dashboard.onCodeSessionGet({
            sessionId: parsed.sessionId!,
            userId: parsed.userId || 'web-user',
            principalId: principal.principalId,
            channel: parsed.channel || 'web',
            surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
            historyLimit: 1,
          });
          if (!snapshot) {
            sendJSON(res, 404, { success: false, error: 'Code session not found' });
            return;
          }
          try {
            cwd = resolveCodeSessionPath(snapshot.session.resolvedRoot, parsed.cwd, '.');
            if (sessionPath) {
              const resolvedPath = resolveCodeSessionPath(snapshot.session.resolvedRoot, sessionPath);
              sessionPath = toRelativeSessionPath(snapshot.session.resolvedRoot, resolvedPath);
            }
          } catch (err) {
            sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
            return;
          }
        }
        const args = ['diff'];
        if (parsed.staged) args.push('--staged');
        if (sessionPath) args.push('--', sessionPath);
        try {
          const { execFile } = await import('node:child_process');
          const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolveResult) => {
            execFile('git', args, { cwd, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error: any, stdout: string, stderr: string) => {
              resolveResult({
                stdout: stdout || '',
                stderr: stderr || '',
                exitCode: error ? (error.code ?? 1) : 0,
              });
            });
          });
          sendJSON(res, 200, { success: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
        } catch (err) {
          sendJSON(res, 200, { success: false, error: err instanceof Error ? err.message : 'Git diff failed' });
        }
        return;
      }

      // GET /api/code/sessions/:id/git/status — git status for Code UI panel
      const gitStatusMatch = url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/git\/status$/);
      if (req.method === 'GET' && gitStatusMatch) {
        const sessionId = decodeURIComponent(gitStatusMatch[1]);
        const principal = this.resolveRequestPrincipal(req);
        const userId = url.searchParams.get('userId') || 'web-user';
        const channel = url.searchParams.get('channel') || 'web';
        const snapshot = this.dashboard.onCodeSessionGet?.({
          sessionId,
          userId,
          principalId: principal.principalId,
          channel,
          surfaceId: readSurfaceIdFromSearchParams(url) ?? userId,
          historyLimit: 1,
        });
        if (!snapshot) {
          sendJSON(res, 404, { success: false, error: 'Code session not found' });
          return;
        }
        const cwd = snapshot.session.resolvedRoot;
        try {
          const { execFile } = await import('node:child_process');
          const [statusResult, branchResult] = await Promise.all([
            new Promise<{ stdout: string; exitCode: number }>((resolve) => {
              execFile('git', ['status', '--porcelain=v1', '-uall'], { cwd, windowsHide: true, maxBuffer: 1024 * 1024 }, (error: any, stdout: string) => {
                resolve({ stdout: stdout || '', exitCode: error ? (error.code ?? 1) : 0 });
              });
            }),
            new Promise<{ stdout: string }>((resolve) => {
              execFile('git', ['branch', '--show-current'], { cwd, windowsHide: true }, (_error: any, stdout: string) => {
                resolve({ stdout: (stdout || '').trim() });
              });
            }),
          ]);
          if (statusResult.exitCode !== 0) {
            sendJSON(res, 200, { success: false, error: 'Not a git repository or git not available' });
            return;
          }
          const staged: Array<{ path: string; status: string }> = [];
          const unstaged: Array<{ path: string; status: string }> = [];
          const untracked: Array<{ path: string; status: string }> = [];
          for (const line of statusResult.stdout.split('\n')) {
            if (!line || line.length < 4) continue;
            const x = line[0]; // index status
            const y = line[1]; // worktree status
            const filePath = line.slice(3).replace(/ -> .+$/, ''); // handle renames
            if (x === '?' && y === '?') {
              untracked.push({ path: filePath, status: '?' });
            } else {
              if (x !== ' ' && x !== '?') staged.push({ path: filePath, status: x });
              if (y !== ' ' && y !== '?') unstaged.push({ path: filePath, status: y });
            }
          }
          sendJSON(res, 200, { success: true, branch: branchResult.stdout, staged, unstaged, untracked });
        } catch (err) {
          sendJSON(res, 200, { success: false, error: err instanceof Error ? err.message : 'Git status failed' });
        }
        return;
      }

      // POST /api/code/sessions/:id/git/action — git actions (stage, unstage, commit, push, pull, fetch, discard)
      const gitActionMatch = url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/git\/action$/);
      if (req.method === 'POST' && gitActionMatch) {
        const sessionId = decodeURIComponent(gitActionMatch[1]);
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as {
          action: string;
          path?: string;
          message?: string;
          userId?: string;
          channel?: string;
          surfaceId?: string;
        };
        const principal = this.resolveRequestPrincipal(req);
        const snapshot = this.dashboard.onCodeSessionGet?.({
          sessionId,
          userId: parsed.userId || 'web-user',
          principalId: principal.principalId,
          channel: parsed.channel || 'web',
          surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
          historyLimit: 1,
        });
        if (!snapshot) {
          sendJSON(res, 404, { success: false, error: 'Code session not found' });
          return;
        }
        const cwd = snapshot.session.resolvedRoot;
        const action = parsed.action;
        const validActions = ['stage', 'unstage', 'commit', 'push', 'pull', 'fetch', 'discard', 'init'];
        if (!validActions.includes(action)) {
          sendJSON(res, 400, { success: false, error: `Invalid git action: ${action}` });
          return;
        }
        try {
          const { execFile } = await import('node:child_process');
          const run = (args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
            new Promise((resolve) => {
              execFile('git', args, { cwd, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error: any, stdout: string, stderr: string) => {
                resolve({ stdout: stdout || '', stderr: stderr || '', exitCode: error ? (error.code ?? 1) : 0 });
              });
            });
          let result: { stdout: string; stderr: string; exitCode: number };
          switch (action) {
            case 'stage':
              result = await run(['add', '--', parsed.path || '.']);
              break;
            case 'unstage':
              result = await run(['reset', 'HEAD', '--', parsed.path || '.']);
              break;
            case 'commit':
              if (!parsed.message?.trim()) {
                sendJSON(res, 400, { success: false, error: 'Commit message required' });
                return;
              }
              result = await run(['commit', '-m', parsed.message.trim()]);
              break;
            case 'push':
              result = await run(['push']);
              break;
            case 'pull':
              result = await run(['pull']);
              break;
            case 'fetch':
              result = await run(['fetch']);
              break;
            case 'discard':
              result = await run(['checkout', '--', parsed.path || '.']);
              break;
            case 'init':
              result = await run(['init']);
              break;
            default:
              sendJSON(res, 400, { success: false, error: 'Unknown action' });
              return;
          }
          sendJSON(res, 200, { success: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr });
        } catch (err) {
          sendJSON(res, 200, { success: false, error: err instanceof Error ? err.message : `Git ${action} failed` });
        }
        return;
      }

      // GET /api/code/sessions/:id/git/graph — commit graph for git panel
      const gitGraphMatch = url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/git\/graph$/);
      if (req.method === 'GET' && gitGraphMatch) {
        const sessionId = decodeURIComponent(gitGraphMatch[1]);
        const principal = this.resolveRequestPrincipal(req);
        const userId = url.searchParams.get('userId') || 'web-user';
        const channel = url.searchParams.get('channel') || 'web';
        const snapshot = this.dashboard.onCodeSessionGet?.({
          sessionId,
          userId,
          principalId: principal.principalId,
          channel,
          surfaceId: readSurfaceIdFromSearchParams(url) ?? userId,
          historyLimit: 1,
        });
        if (!snapshot) {
          sendJSON(res, 404, { success: false, error: 'Code session not found' });
          return;
        }
        const cwd = snapshot.session.resolvedRoot;
        try {
          const { execFile } = await import('node:child_process');
          const result = await new Promise<{ stdout: string; exitCode: number }>((resolve) => {
            execFile('git', [
              'log', '--all', '--oneline', '--graph', '--decorate=short',
              '--date=short', '--pretty=format:%h\t%d\t%s\t%ad',
              '-40',
            ], { cwd, windowsHide: true, maxBuffer: 256 * 1024 }, (error: any, stdout: string) => {
              resolve({ stdout: stdout || '', exitCode: error ? (error.code ?? 1) : 0 });
            });
          });
          if (result.exitCode !== 0) {
            sendJSON(res, 200, { success: false, entries: [] });
            return;
          }
          const entries = result.stdout.split('\n').filter(Boolean).map((line) => {
            // Each line is: graph_chars hash \t refs \t message \t date
            // But --graph prepends graph characters before the formatted output
            const graphMatch = line.match(/^([*|/\\ ]+)\s*([a-f0-9]+)\t\s*(\([^)]*\))?\s*\t?\s*(.*?)\t\s*(.*)$/);
            if (graphMatch) {
              return {
                graph: graphMatch[1].trimEnd(),
                hash: graphMatch[2],
                refs: (graphMatch[3] || '').replace(/^\(|\)$/g, '').trim(),
                message: graphMatch[4],
                date: graphMatch[5],
              };
            }
            // Graph-only lines (merge lines, etc.)
            return { graph: line, hash: '', refs: '', message: '', date: '' };
          });
          sendJSON(res, 200, { success: true, entries });
        } catch (err) {
          sendJSON(res, 200, { success: false, entries: [], error: err instanceof Error ? err.message : 'Git graph failed' });
        }
        return;
      }

      // POST /api/code/terminals — Open a PTY-backed terminal session
      if (req.method === 'POST' && url.pathname === '/api/code/terminals') {
        const terminalAccess = this.dashboard.onCodeTerminalAccessCheck?.();
        if (terminalAccess && terminalAccess.allowed === false) {
          sendJSON(res, 403, { success: false, error: terminalAccess.reason || 'Manual code terminals are disabled by policy.' });
          return;
        }
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as {
          cwd?: string;
          shell?: string;
          cols?: number;
          rows?: number;
          sessionId?: string;
          userId?: string;
          channel?: string;
          surfaceId?: string;
        };
        const platform = process.platform;
        const shellType = parsed.shell || getDefaultShellForPlatform(platform);
        let requestedCwd = parsed.cwd || process.cwd();
        let codeSessionId: string | null = null;
        if (trimOptionalString(parsed.sessionId) && this.dashboard.onCodeSessionGet) {
          const principal = this.resolveRequestPrincipal(req);
          const snapshot = this.dashboard.onCodeSessionGet({
            sessionId: parsed.sessionId!,
            userId: parsed.userId || 'web-user',
            principalId: principal.principalId,
            channel: parsed.channel || 'web',
            surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
            historyLimit: 1,
          });
          if (!snapshot) {
            sendJSON(res, 404, { success: false, error: 'Code session not found' });
            return;
          }
          try {
            requestedCwd = resolveCodeSessionPath(snapshot.session.resolvedRoot, parsed.cwd, '.');
            codeSessionId = snapshot.session.id;
          } catch (err) {
            sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
            return;
          }
        }
        const launch = getPtyShellLaunch(shellType, platform, requestedCwd);
        const cols = Math.max(40, Math.min(240, Number(parsed.cols) || 120));
        const rows = Math.max(12, Math.min(120, Number(parsed.rows) || 30));
        const ownerSessionId = this.parseCookie(req, SESSION_COOKIE_NAME) || null;
        try {
          const terminalId = randomUUID();
          const ptyCwd = launch.cwd === null ? undefined : (launch.cwd || requestedCwd || process.cwd());
          const pty = spawnPty(launch.file, launch.args, {
            name: 'xterm-color',
            cols,
            rows,
            cwd: ptyCwd,
            env: buildHardenedEnv({
              ...process.env,
              ...launch.env,
            }),
          });
          const session: TerminalSessionRecord = {
            id: terminalId,
            ownerSessionId,
            pty,
            shell: shellType,
            cwd: requestedCwd,
            cols,
            rows,
            ...(codeSessionId ? { codeSessionId } : {}),
          };
          this.terminalSessions.set(terminalId, session);
          this.dashboard.onCodeTerminalEvent?.({
            action: 'opened',
            terminalId,
            shell: shellType,
            cwd: session.cwd,
            cols: session.cols,
            rows: session.rows,
            codeSessionId: session.codeSessionId ?? null,
          });
          pty.onData((data) => {
            this.emitSSE({
              type: 'terminal.output',
              data: { terminalId, data },
            });
            const outputListeners = this.terminalOutputListeners.get(terminalId);
            if (outputListeners) {
              for (const cb of outputListeners) { try { cb(data); } catch { /* listener error */ } }
            }
          });
          pty.onExit((event) => {
            const exitListeners = this.terminalExitListeners.get(terminalId);
            if (exitListeners) {
              for (const cb of exitListeners) { try { cb(event.exitCode ?? 1, event.signal ?? 0); } catch { /* listener error */ } }
              this.terminalExitListeners.delete(terminalId);
            }
            this.terminalOutputListeners.delete(terminalId);
            this.terminalSessions.delete(terminalId);
            this.dashboard.onCodeTerminalEvent?.({
              action: 'exited',
              terminalId,
              shell: session.shell,
              cwd: session.cwd,
              cols: session.cols,
              rows: session.rows,
              codeSessionId: session.codeSessionId ?? null,
              exitCode: event.exitCode,
              signal: event.signal,
            });
            this.emitSSE({
              type: 'terminal.exit',
              data: { terminalId, exitCode: event.exitCode, signal: event.signal },
            });
          });
          sendJSON(res, 200, {
            success: true,
            terminalId,
            shell: shellType,
            cwd: session.cwd,
          });
        } catch (err) {
          sendJSON(res, 500, { success: false, error: err instanceof Error ? err.message : 'Failed to open terminal' });
        }
        return;
      }

      const terminalInputMatch = req.method === 'POST' ? url.pathname.match(/^\/api\/code\/terminals\/([^/]+)\/input$/) : null;
      if (terminalInputMatch) {
        const terminalId = decodeURIComponent(terminalInputMatch[1]);
        const session = this.terminalSessions.get(terminalId);
        if (!session || !this.canAccessTerminal(req, session)) {
          sendJSON(res, 404, { success: false, error: 'Terminal not found' });
          return;
        }
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as { input?: string };
        if (typeof parsed.input !== 'string') {
          sendJSON(res, 400, { success: false, error: 'input is required' });
          return;
        }
        session.pty.write(parsed.input);
        sendJSON(res, 200, { success: true });
        return;
      }

      const terminalResizeMatch = req.method === 'POST' ? url.pathname.match(/^\/api\/code\/terminals\/([^/]+)\/resize$/) : null;
      if (terminalResizeMatch) {
        const terminalId = decodeURIComponent(terminalResizeMatch[1]);
        const session = this.terminalSessions.get(terminalId);
        if (!session || !this.canAccessTerminal(req, session)) {
          sendJSON(res, 404, { success: false, error: 'Terminal not found' });
          return;
        }
        const body = await readBody(req, this.maxBodyBytes);
        const parsed = JSON.parse(body || '{}') as { cols?: number; rows?: number };
        const cols = Math.max(40, Math.min(240, Number(parsed.cols) || session.cols));
        const rows = Math.max(12, Math.min(120, Number(parsed.rows) || session.rows));
        session.cols = cols;
        session.rows = rows;
        session.pty.resize(cols, rows);
        sendJSON(res, 200, { success: true });
        return;
      }

      const terminalDeleteMatch = req.method === 'DELETE' ? url.pathname.match(/^\/api\/code\/terminals\/([^/]+)$/) : null;
      if (terminalDeleteMatch) {
        const terminalId = decodeURIComponent(terminalDeleteMatch[1]);
        const session = this.terminalSessions.get(terminalId);
        if (!session || !this.canAccessTerminal(req, session)) {
          sendJSON(res, 404, { success: false, error: 'Terminal not found' });
          return;
        }
        this.terminalSessions.delete(terminalId);
        try {
          session.pty.kill();
        } catch {
          // Best effort close.
        }
        sendJSON(res, 200, { success: true });
        return;
      }

      // POST /api/shell/exec — removed; use PTY-backed code terminals instead
      if (req.method === 'POST' && url.pathname === '/api/shell/exec') {
        sendJSON(res, 410, {
          success: false,
          error: 'Direct shell execution has been removed from the web API. Use /api/code/terminals for interactive shell access.',
        });
        return;
      }

      // API 404
      sendJSON(res, 404, { error: 'Not found' });
      return;
    }

    // ─── Static file serving (no auth required) ────────────────

    if (this.staticDir && req.method === 'GET') {
      const served = await this.serveStatic(url.pathname, res);
      if (served) return;
    }

    // 404
    sendJSON(res, 404, { error: 'Not found' });
  }

  /** Handle SSE connection. */
  private handleSSE(req: IncomingMessage, res: ServerResponse): void {
    if (!this.dashboard.onSSESubscribe) {
      sendJSON(res, 404, { error: 'SSE not available' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial comment to confirm connection
    res.write(':connected\n\n');

    this.sseClients.add(res);

    const listener: SSEListener = (event) => {
      if (res.destroyed) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    };

    const unsubscribe = this.dashboard.onSSESubscribe(listener);

    // Heartbeat every 30s
    const heartbeat = setInterval(() => {
      if (res.destroyed) return;
      res.write(':heartbeat\n\n');
    }, 30_000);

    // Cleanup on disconnect
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      this.sseClients.delete(res);
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  private canAccessTerminal(req: IncomingMessage, session: TerminalSessionRecord): boolean {
    const requester = this.parseCookie(req, SESSION_COOKIE_NAME) || null;
    return session.ownerSessionId === requester;
  }

  /** Serve a static file from staticDir. Returns true if served. */
  private async serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
    if (!this.staticDir) return false;

    if (pathname.startsWith('/vendor/xterm/')) {
      const vendorFile = pathname.slice('/vendor/xterm/'.length);
      const vendorRoot = normalize(join(this.staticDir, '..', '..', 'node_modules'));
      let vendorPath: string | null = null;
      if (vendorFile === 'xterm.mjs') vendorPath = normalize(join(vendorRoot, '@xterm', 'xterm', 'lib', 'xterm.mjs'));
      else if (vendorFile === 'addon-fit.mjs') vendorPath = normalize(join(vendorRoot, '@xterm', 'addon-fit', 'lib', 'addon-fit.mjs'));
      else if (vendorFile === 'xterm.css') vendorPath = normalize(join(vendorRoot, '@xterm', 'xterm', 'css', 'xterm.css'));
      if (!vendorPath || !vendorPath.startsWith(vendorRoot)) return false;
      try {
        const ext = extname(vendorPath);
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        const content = await readFile(vendorPath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
        return true;
      } catch {
        return false;
      }
    }

    // Serve vendored Monaco editor files from web/public/vendor/monaco/
    if (pathname.startsWith('/vendor/monaco/')) {
      const monacoDir = normalize(join(this.staticDir, 'vendor', 'monaco'));
      const monacoPath = normalize(join(monacoDir, pathname.slice('/vendor/monaco/'.length)));
      if (!monacoPath.startsWith(monacoDir)) return false;
      try {
        const ext = extname(monacoPath);
        const contentType = MIME_TYPES[ext] ?? (ext === '.ttf' ? 'font/ttf' : 'application/octet-stream');
        const content = await readFile(monacoPath);
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
        res.end(content);
        return true;
      } catch {
        return false;
      }
    }

    // Normalize and prevent path traversal
    let filePath = normalize(join(this.staticDir, pathname));

    // Containment check
    if (!filePath.startsWith(normalize(this.staticDir))) {
      return false;
    }

    try {
      const stats = await stat(filePath);

      // If it's a directory, try index.html
      if (stats.isDirectory()) {
        filePath = join(filePath, 'index.html');
        await stat(filePath); // throws if doesn't exist
      }
    } catch {
      // SPA fallback: serve index.html for paths without file extensions
      const ext = extname(pathname);
      if (!ext) {
        try {
          filePath = join(this.staticDir, 'index.html');
          await stat(filePath);
        } catch {
          return false;
        }
      } else {
        return false;
      }
    }

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

    try {
      const content = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }
}

function logInternalError(message: string, err: unknown): void {
  log.error({ err }, message);
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getShellOptionsForPlatform(platform: NodeJS.Platform): ShellOptionDescriptor[] {
  switch (platform) {
    case 'win32':
      return [
        { id: 'powershell', label: 'PowerShell (Windows)', detail: 'powershell.exe' },
        { id: 'cmd', label: 'Command Prompt (cmd.exe)', detail: 'cmd.exe' },
        { id: 'git-bash', label: 'Git Bash', detail: 'C:\\Program Files\\Git\\bin\\bash.exe' },
        { id: 'wsl-login', label: 'WSL Ubuntu', detail: 'wsl.exe (default shell/profile)' },
        { id: 'wsl', label: 'WSL Bash (Clean)', detail: 'wsl.exe -- bash --noprofile --norc' },
      ];
    case 'darwin':
      return [
        { id: 'zsh', label: 'Zsh', detail: 'zsh' },
        { id: 'bash', label: 'Bash', detail: 'bash' },
        { id: 'sh', label: 'POSIX sh', detail: 'sh' },
      ];
    default:
      return [
        { id: 'bash', label: 'Bash', detail: 'bash' },
        { id: 'zsh', label: 'Zsh', detail: 'zsh' },
        { id: 'sh', label: 'POSIX sh', detail: 'sh' },
      ];
  }
}

function getDefaultShellForPlatform(platform: NodeJS.Platform): string {
  return getShellOptionsForPlatform(platform)[0]?.id || 'bash';
}

function tryResolveWindowsExecutable(command: string, fallbackPaths: string[] = []): string | null {
  for (const candidate of fallbackPaths) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  try {
    const output = execFileSync('where', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const first = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) return first;
  } catch {
    // Fall back to known paths or the raw command name.
  }

  return null;
}

function resolveWindowsExecutable(command: string, fallbackPaths: string[] = []): string {
  return tryResolveWindowsExecutable(command, fallbackPaths) || fallbackPaths[0] || command;
}

function listWindowsExecutableCandidates(command: string): string[] {
  try {
    const output = execFileSync('where', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function inferWindowsGitRoot(executablePath: string): string {
  const normalized = executablePath.replace(/\//g, '\\');
  const lower = normalized.toLowerCase();
  if (lower.endsWith('\\usr\\bin\\bash.exe')) {
    return dirname(dirname(dirname(normalized)));
  }
  if (lower.endsWith('\\bin\\bash.exe')) {
    return dirname(dirname(normalized));
  }
  if (lower.endsWith('\\git-bash.exe')) {
    return dirname(normalized);
  }
  return dirname(dirname(normalized));
}

function buildWindowsGitBashEnv(executablePath: string): Record<string, string> {
  const gitRoot = inferWindowsGitRoot(executablePath);
  const existingPath = process.env.Path || process.env.PATH || '';
  const pathEntries = [
    join(gitRoot, 'cmd'),
    join(gitRoot, 'usr', 'bin'),
    join(gitRoot, 'bin'),
    join(gitRoot, 'mingw64', 'bin'),
  ].filter((entry) => entry && existsSync(entry));
  const mergedPath = Array.from(new Set([
    ...pathEntries,
    ...existingPath.split(';').map((entry) => entry.trim()).filter(Boolean),
  ])).join(';');
  return {
    TERM: 'xterm-256color',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    PS1: '\\w$ ',
    MSYSTEM: 'MINGW64',
    CHERE_INVOKING: '1',
    PATH: mergedPath,
    Path: mergedPath,
  };
}

function toWslPath(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '/';
  if (normalized.startsWith('/')) {
    return normalized.replace(/\\/g, '/');
  }
  const driveMatch = normalized.replace(/\//g, '\\').match(/^([A-Za-z]):\\(.*)$/);
  if (driveMatch) {
    const [, drive, rest] = driveMatch;
    return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`;
  }
  return normalized.replace(/\\/g, '/');
}

function shellQuotePosix(value: string): string {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function resolveWindowsGitBashExecutable(): string {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const preferred = [
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'),
  ];
  const gitBash = preferred.find((candidate) => candidate && existsSync(candidate))
    || listWindowsExecutableCandidates('bash.exe')
      .find((candidate) => candidate.toLowerCase().includes('\\git\\') && candidate.toLowerCase().endsWith('bash.exe'));
  if (gitBash) return gitBash;
  throw new Error('Git Bash was not found. Install Git for Windows or use PowerShell/WSL.');
}

function getPtyShellLaunch(shellType: string, platform: NodeJS.Platform, requestedCwd?: string): {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string | null;
} {
  switch (shellType) {
    case 'powershell':
      return {
        file: platform === 'win32' ? resolveWindowsExecutable('powershell.exe', ['powershell.exe']) : 'pwsh',
        args: ['-NoLogo', '-NoProfile'],
        env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0' },
        cwd: requestedCwd,
      };
    case 'cmd':
      return {
        file: platform === 'win32' ? resolveWindowsExecutable('cmd.exe', ['cmd.exe']) : 'cmd.exe',
        args: [],
        env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0' },
        cwd: requestedCwd,
      };
    case 'wsl-login':
    case 'wsl': {
      const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const wslExe = platform === 'win32'
        ? tryResolveWindowsExecutable('wsl.exe', [join(systemRoot, 'System32', 'wsl.exe')])
        : 'wsl';
      if (platform === 'win32' && !wslExe) {
        throw new Error('WSL was not found. Install Windows Subsystem for Linux or use PowerShell.');
      }
      if (shellType === 'wsl-login') {
        return {
          file: wslExe || 'wsl',
          args: platform === 'win32'
            ? (requestedCwd ? ['--cd', toWslPath(requestedCwd)] : [])
            : [],
          env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0' },
          cwd: platform === 'win32' ? null : requestedCwd,
        };
      }
      const wslBootstrap = requestedCwd
        ? `cd ${shellQuotePosix(toWslPath(requestedCwd))} && exec bash --noprofile --norc -i`
        : 'exec bash --noprofile --norc -i';
      return {
        file: wslExe || 'wsl',
        args: platform === 'win32' ? ['--', 'bash', '-lc', wslBootstrap] : [],
        env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0' },
        cwd: platform === 'win32' ? null : requestedCwd,
      };
    }
    case 'git-bash': {
      const gitBash = platform === 'win32' ? resolveWindowsGitBashExecutable() : 'bash';
      return {
        file: gitBash,
        args: ['--noprofile', '--norc', '-i'],
        env: platform === 'win32'
          ? buildWindowsGitBashEnv(gitBash)
          : { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0', PS1: '\\w$ ' },
        cwd: requestedCwd,
      };
    }
    case 'zsh':
      return {
        file: 'zsh',
        args: ['-f', '-i'],
        env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0', PS1: '%~ %# ' },
        cwd: requestedCwd,
      };
    case 'sh':
      return {
        file: 'sh',
        args: ['-i'],
        env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0', PS1: '$ ' },
        cwd: requestedCwd,
      };
    case 'bash':
    default:
      if (platform === 'win32') {
        const gitBash = resolveWindowsGitBashExecutable();
        return {
          file: gitBash,
          args: ['--noprofile', '--norc', '-i'],
          env: buildWindowsGitBashEnv(gitBash),
          cwd: requestedCwd,
        };
      }
      return {
        file: 'bash',
        args: ['--noprofile', '--norc', '-i'],
        env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0', PS1: '\\w$ ' },
        cwd: requestedCwd,
      };
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        reject(new Error(`Request body too large (limit: ${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function previewToken(token: string): string {
  if (token.length <= 8) return token;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function isSuccessfulMutationResult(result: unknown): boolean {
  if (!result || typeof result !== 'object' || !('success' in result)) {
    return true;
  }
  return (result as { success?: boolean }).success !== false;
}

function uniqueTopics(topics: string[]): string[] {
  return [...new Set(topics.filter((topic) => topic && topic.trim()))];
}

function toolInvalidationTopics(toolName: string): string[] {
  const topics = ['tools'];
  if (toolName.startsWith('intel_')) {
    topics.push('threat-intel');
  }
  if (toolName.startsWith('memory_')) {
    topics.push('dashboard');
  }
  return topics;
}
