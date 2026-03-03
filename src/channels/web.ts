/**
 * Web channel adapter.
 *
 * Lightweight HTTP server using Node built-in http module.
 * REST API for agent communication + dashboard API + SSE + static file serving.
 *
 * Security:
 *   - Optional bearer token authentication
 *   - Configurable CORS origins (default: same-origin only)
 *   - Request body size limit (default: 1 MB)
 *   - Path traversal protection for static files
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { join, normalize, extname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { ChannelAdapter, MessageCallback } from './types.js';
import type { DashboardCallbacks, SSEListener } from './web-types.js';
import type { AuditEventType, AuditSeverity } from '../guardian/audit-log.js';
import { createLogger } from '../util/logging.js';
import { timingSafeEqualString } from '../util/crypto-guardrails.js';

const log = createLogger('channel:web');

/** Default maximum request body size: 1 MB. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const PRIVILEGED_TICKET_TTL_SECONDS = 300;
const PRIVILEGED_TICKET_MAX_REPLAY_TRACK = 2048;

/** MIME types for static file serving. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export type WebAuthMode = 'bearer_required' | 'localhost_no_auth' | 'disabled';
type PrivilegedTicketAction = 'auth.config' | 'auth.rotate' | 'auth.reveal' | 'auth.revoke';

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
  /** Bearer token for authentication. If set, all non-health requests require it. */
  authToken?: string;
  /** Structured auth configuration. */
  auth?: WebAuthRuntimeConfig;
  /** Allowed CORS origins (default: none / same-origin). Use ['*'] to allow all (not recommended). */
  allowedOrigins?: string[];
  /** Maximum request body size in bytes (default: 1 MB). */
  maxBodyBytes?: number;
  /** Directory to serve static frontend files from. */
  staticDir?: string;
  /** Dashboard API callbacks from runtime. */
  dashboard?: DashboardCallbacks;
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
  private readonly privilegedTicketSecret = randomBytes(32);
  private readonly usedPrivilegedTicketNonces = new Map<string, number>();

  constructor(options: WebChannelOptions = {}) {
    this.port = options.port ?? 3000;
    this.host = options.host ?? 'localhost';
    const auth = options.auth;
    this.authMode = auth?.mode ?? (options.authToken ? 'bearer_required' : 'disabled');
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => {
        log.info({ port: this.port, host: this.host }, 'Web channel started');
        if (this.authMode === 'disabled' || (this.authMode === 'bearer_required' && !this.authToken)) {
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
    // Close all SSE connections
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

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

  async send(_userId: string, _text: string): Promise<void> {
    // Web channel is request/response — no push capability without WebSocket
    log.warn('WebChannel.send() called but push is not supported without WebSocket');
  }

  /** Check if a request origin is in the allowed list. */
  private isOriginAllowed(origin: string): boolean {
    if (this.allowedOrigins.length === 0) return false;
    if (this.allowedOrigins.includes('*')) return true;
    return this.allowedOrigins.includes(origin);
  }

  setAuthConfig(auth: WebAuthRuntimeConfig): void {
    this.authMode = auth.mode;
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
    if (this.authMode === 'disabled') return false;
    if (this.authMode === 'localhost_no_auth' && this.isLocalRequest(req)) return false;
    return true;
  }

  private isLocalRequest(req: IncomingMessage): boolean {
    const remote = req.socket.remoteAddress ?? '';
    return remote === '127.0.0.1'
      || remote === '::1'
      || remote.endsWith(':127.0.0.1')
      || remote.endsWith(':0:0:0:0:0:0:0:1');
  }

  /** Verify bearer token authentication. Returns true if auth passes. */
  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.shouldRequireAuth(req)) return true;
    if (!this.authToken) {
      sendJSON(res, 401, { error: 'Authentication required' });
      return false;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      sendJSON(res, 401, { error: 'Authentication required' });
      return false;
    }

    const token = authHeader.slice(7);
    if (!timingSafeEqualString(this.authToken, token)) {
      sendJSON(res, 403, { error: 'Invalid token' });
      return false;
    }

    return true;
  }

  /** Check auth via query param (for SSE/EventSource which can't set headers). */
  private checkAuthForSSE(req: IncomingMessage, url: URL, res: ServerResponse): boolean {
    if (!this.shouldRequireAuth(req)) return true;
    if (!this.authToken) {
      sendJSON(res, 401, { error: 'Authentication required' });
      return false;
    }

    const token = url.searchParams.get('token');
    if (!token) {
      sendJSON(res, 401, { error: 'Authentication required' });
      return false;
    }
    if (!timingSafeEqualString(this.authToken, token)) {
      sendJSON(res, 403, { error: 'Invalid token' });
      return false;
    }
    return true;
  }

  private isPrivilegedTicketAction(value: string): value is PrivilegedTicketAction {
    return value === 'auth.config'
      || value === 'auth.rotate'
      || value === 'auth.reveal'
      || value === 'auth.revoke';
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
      // SSE uses query param auth; everything else uses header auth
      if (url.pathname === '/sse') {
        if (!this.checkAuthForSSE(req, url, res)) return;
      } else {
        if (!this.checkAuth(req, res)) return;
      }

      // GET /api/status — Runtime status
      if (req.method === 'GET' && url.pathname === '/api/status') {
        sendJSON(res, 200, { status: 'running', timestamp: Date.now() });
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
        if (this.authMode === 'disabled' && !this.isLocalRequest(req)) {
          sendJSON(res, 403, { error: 'Ticket issuance is restricted to localhost when auth is disabled' });
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
          mode?: 'bearer_required' | 'localhost_no_auth' | 'disabled';
          token?: string;
          rotateOnStartup?: boolean;
          sessionTtlMinutes?: number;
          ticket?: string;
        };
        try {
          parsed = body.trim()
            ? (JSON.parse(body) as {
              mode?: 'bearer_required' | 'localhost_no_auth' | 'disabled';
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

      // POST /api/auth/token/revoke — disable auth token and auth mode
      if (req.method === 'POST' && url.pathname === '/api/auth/token/revoke') {
        if (!this.dashboard.onAuthRevoke) {
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
        if (!this.requirePrivilegedTicket(req, res, url, 'auth.revoke', parsed.ticket)) {
          return;
        }
        sendJSON(res, 200, await this.dashboard.onAuthRevoke());
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
          channel?: string;
        };
        try {
          parsed = JSON.parse(body) as {
            toolName?: string;
            args?: Record<string, unknown>;
            origin?: 'assistant' | 'cli' | 'web';
            agentId?: string;
            userId?: string;
            channel?: string;
          };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!parsed.toolName) {
          sendJSON(res, 400, { error: 'toolName is required' });
          return;
        }
        const result = await this.dashboard.onToolsRun({
          toolName: parsed.toolName,
          args: parsed.args ?? {},
          origin: parsed.origin ?? 'web',
          agentId: parsed.agentId,
          userId: parsed.userId,
          channel: parsed.channel,
        });
        sendJSON(res, 200, result);
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
            })
            : {};
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }
        sendJSON(res, 200, this.dashboard.onToolsPolicyUpdate(parsed));
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
        const result = await this.dashboard.onToolsApprovalDecision({
          approvalId: parsed.approvalId,
          decision: parsed.decision,
          actor: parsed.actor ?? 'web-user',
          reason: parsed.reason,
        });
        sendJSON(res, 200, result);
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
          sendJSON(res, 500, { error: err instanceof Error ? err.message : String(err) });
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
        try {
          const result = await this.dashboard.onConfigUpdate(parsed as Record<string, unknown>);
          sendJSON(res, 200, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Update failed';
          sendJSON(res, 500, { error: message });
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

      // GET /api/providers/status — LLM provider list with live connectivity check
      if (req.method === 'GET' && url.pathname === '/api/providers/status') {
        if (!this.dashboard.onProvidersStatus) {
          sendJSON(res, 404, { error: 'Not available' });
          return;
        }
        sendJSON(res, 200, await this.dashboard.onProvidersStatus());
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
        sendJSON(res, 200, this.dashboard.onRoutingModeUpdate(parsed.mode as 'auto' | 'local-only' | 'external-only'));
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

        let parsed: { content?: string; userId?: string; agentId?: string; channel?: string };
        try {
          parsed = JSON.parse(body) as { content?: string; userId?: string; agentId?: string; channel?: string };
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' });
          return;
        }

        if (!parsed.content) {
          sendJSON(res, 400, { error: 'content is required' });
          return;
        }

        // Agent-targeted dispatch via dashboard callback
        if (parsed.agentId && this.dashboard.onDispatch) {
          try {
            const response = await this.dashboard.onDispatch(parsed.agentId, {
              content: parsed.content,
              userId: parsed.userId,
              channel: parsed.channel ?? 'web',
            });
            sendJSON(res, 200, response);
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Dispatch error';
            sendJSON(res, 500, { error: message });
          }
          return;
        }

        // Fallback to default message handler
        if (!this.onMessage) {
          sendJSON(res, 503, { error: 'No message handler registered' });
          return;
        }

        const response = await this.onMessage({
          id: randomUUID(),
          userId: parsed.userId ?? 'web-user',
          channel: 'web',
          content: parsed.content,
          timestamp: Date.now(),
        });

        sendJSON(res, 200, response);
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
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Reset failed';
          sendJSON(res, 500, { error: message });
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
          const message = err instanceof Error ? err.message : 'Quick action failed';
          sendJSON(res, 500, { error: message });
        }
        return;
      }

      // GET /sse — Server-Sent Events stream
      if (req.method === 'GET' && url.pathname === '/sse') {
        this.handleSSE(req, res);
        return;
      }

      // POST /api/killswitch — Shut down the entire process
      if (req.method === 'POST' && url.pathname === '/api/killswitch') {
        sendJSON(res, 200, { success: true, message: 'Shutting down...' });
        if (this.dashboard.onKillswitch) {
          // Small delay so the HTTP response is flushed before the process exits
          setTimeout(() => this.dashboard.onKillswitch!(), 100);
        } else {
          sendJSON(res, 404, { error: 'Not available' });
        }
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

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
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
