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
import { join, normalize, extname, resolve, relative, isAbsolute } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { spawn as spawnPty, type IPty } from 'node-pty';
import type { ChannelAdapter, MessageCallback } from './types.js';
import type { DashboardCallbacks, SSEEvent, SSEListener, UIInvalidationEvent } from './web-types.js';
import { sendJSON } from './web-json.js';
import { handleWebAutomationRoutes } from './web-automation-routes.js';
import { handleWebChatRoutes } from './web-chat-routes.js';
import { handleWebCodeSessionRoutes } from './web-code-session-routes.js';
import { handleWebCodeWorkspaceRoutes } from './web-code-workspace-routes.js';
import { handleWebControlRoutes } from './web-control-routes.js';
import { handleWebMonitoringRoutes } from './web-monitoring-routes.js';
import { handleWebProviderAdminRoutes } from './web-provider-admin-routes.js';
import { handleWebRuntimeRoutes } from './web-runtime-routes.js';
import { handleWebTerminalRoutes } from './web-terminal-routes.js';
import {
  getPtyShellLaunch,
  getShellOptionsForPlatform,
} from './web-shell-launch.js';
import { createLogger } from '../util/logging.js';
import { timingSafeEqualString } from '../util/crypto-guardrails.js';
import { buildHardenedEnv } from '../sandbox/index.js';

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

      if (await handleWebControlRoutes({
        req,
        res,
        url,
        maxBodyBytes: this.maxBodyBytes,
        dashboard: this.dashboard,
        resolveRequestPrincipal: (request) => this.resolveRequestPrincipal(request),
        maybeEmitUIInvalidation: (result, topics, reason, path) => this.maybeEmitUIInvalidation(result, topics, reason, path),
        requirePrivilegedTicket: (request, response, requestUrl, action, presented) =>
          this.requirePrivilegedTicket(request, response, requestUrl, action as PrivilegedTicketAction, presented),
        isPrivilegedTicketAction: (value) => this.isPrivilegedTicketAction(value),
        recordPrivilegedTicketMint: (request) => this.recordPrivilegedTicketMint(request),
        sendPrivilegedTicketRateLimited: (response, retryAfterMs) => this.sendPrivilegedTicketRateLimited(response, retryAfterMs),
        mintPrivilegedTicket: (action) => this.mintPrivilegedTicket(action as PrivilegedTicketAction),
        privilegedTicketTtlSeconds: PRIVILEGED_TICKET_TTL_SECONDS,
      })) {
        return;
      }

      if (await handleWebMonitoringRoutes({
        req,
        res,
        url,
        maxBodyBytes: this.maxBodyBytes,
        dashboard: this.dashboard,
        maybeEmitUIInvalidation: (result, topics, reason, path) => this.maybeEmitUIInvalidation(result, topics, reason, path),
        emitUIInvalidation: (topics, reason, path) => this.emitUIInvalidation(topics, reason, path),
      })) {
        return;
      }

      if (await handleWebRuntimeRoutes({
        req,
        res,
        url,
        maxBodyBytes: this.maxBodyBytes,
        dashboard: this.dashboard,
        maybeEmitUIInvalidation: (result, topics, reason, path) => this.maybeEmitUIInvalidation(result, topics, reason, path),
        requirePrivilegedTicket: (request, response, requestUrl, action, presented) =>
          this.requirePrivilegedTicket(request, response, requestUrl, action, presented),
        getConfigPrivilegedAction: (parsed) => this.getConfigPrivilegedAction(parsed) ?? undefined,
        logInternalError,
      })) {
        return;
      }

      if (await handleWebChatRoutes({
        req,
        res,
        url,
        maxBodyBytes: this.maxBodyBytes,
        dashboard: this.dashboard,
        onMessage: this.onMessage,
        resolveRequestPrincipal: (request) => this.resolveRequestPrincipal(request),
        getRequestErrorDetails,
        logInternalError,
        maybeEmitUIInvalidation: (result, topics, reason, path) => this.maybeEmitUIInvalidation(result, topics, reason, path),
        emitSSE: (event) => {
          for (const client of this.sseClients) {
            if (!client.destroyed) {
              client.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
            }
          }
        },
        generateMessageId: () => randomUUID(),
      })) {
        return;
      }

      // GET /sse — Server-Sent Events stream
      if (req.method === 'GET' && url.pathname === '/sse') {
        this.handleSSE(req, res);
        return;
      }

      if (await handleWebAutomationRoutes({
        req,
        res,
        url,
        maxBodyBytes: this.maxBodyBytes,
        dashboard: this.dashboard,
        resolveRequestPrincipal: (request) => this.resolveRequestPrincipal(request),
        maybeEmitUIInvalidation: (result, topics, reason, path) => this.maybeEmitUIInvalidation(result, topics, reason, path),
        requirePrivilegedTicket: (request, response, requestUrl, action, presented) =>
          this.requirePrivilegedTicket(request, response, requestUrl, action, presented),
        logInternalError,
      })) {
        return;
      }

      if (await handleWebProviderAdminRoutes({
        req,
        res,
        url,
        maxBodyBytes: this.maxBodyBytes,
        dashboard: this.dashboard,
        requirePrivilegedTicket: (request, response, requestUrl, action, presented) =>
          this.requirePrivilegedTicket(request, response, requestUrl, action, presented),
        maybeEmitUIInvalidation: (result, topics, reason, path) => this.maybeEmitUIInvalidation(result, topics, reason, path),
      })) {
        return;
      }

      if (await handleWebCodeSessionRoutes({
        req,
        res,
        url,
        maxBodyBytes: this.maxBodyBytes,
        dashboard: this.dashboard,
        resolveRequestPrincipal: (request) => this.resolveRequestPrincipal(request),
        resolveCodeSessionPath,
        getRequestErrorDetails,
        logInternalError,
      })) {
        return;
      }

      if (await handleWebCodeWorkspaceRoutes({
        req,
        res,
        url,
        maxBodyBytes: this.maxBodyBytes,
        dashboard: this.dashboard,
        resolveRequestPrincipal: (request) => this.resolveRequestPrincipal(request),
        resolveCodeSessionPath,
        toRelativeSessionPath,
        readSurfaceIdFromSearchParams,
      })) {
        return;
      }

      if (await handleWebTerminalRoutes({
        req,
        res,
        url,
        maxBodyBytes: this.maxBodyBytes,
        dashboard: this.dashboard,
        terminalSessions: this.terminalSessions,
        terminalOutputListeners: this.terminalOutputListeners,
        terminalExitListeners: this.terminalExitListeners,
        resolveRequestPrincipal: (request) => this.resolveRequestPrincipal(request),
        resolveCodeSessionPath,
        emitSSE: (event) => this.emitSSE(event),
        getOwnerSessionId: (request) => this.parseCookie(request, SESSION_COOKIE_NAME) || null,
      })) {
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
