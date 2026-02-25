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
import { randomUUID } from 'node:crypto';
import { join, normalize, extname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { ChannelAdapter, MessageCallback } from './types.js';
import type { DashboardCallbacks, SSEListener } from './web-types.js';
import type { AuditEventType, AuditSeverity } from '../guardian/audit-log.js';
import { createLogger } from '../util/logging.js';

const log = createLogger('channel:web');

/** Default maximum request body size: 1 MB. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

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

export interface WebChannelOptions {
  /** Port to listen on. */
  port?: number;
  /** Host to bind to. */
  host?: string;
  /** Default agent to route messages to. */
  defaultAgent?: string;
  /** Bearer token for authentication. If set, all non-health requests require it. */
  authToken?: string;
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
  private authToken: string | undefined;
  private allowedOrigins: string[];
  private maxBodyBytes: number;
  private staticDir: string | undefined;
  private dashboard: DashboardCallbacks;
  private sseClients: Set<ServerResponse> = new Set();

  constructor(options: WebChannelOptions = {}) {
    this.port = options.port ?? 3000;
    this.host = options.host ?? 'localhost';
    this.authToken = options.authToken;
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
        if (!this.authToken) {
          log.warn(
            { port: this.port, host: this.host },
            'Web channel started WITHOUT authentication — all non-health endpoints are open. Set authToken in config to enable bearer token auth.',
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
        // Node's keep-alive sockets can keep server.close() pending for ~5s.
        // Close idle sockets first so stop() returns promptly in tests and shutdown.
        const closable = this.server as Server & { closeIdleConnections?: () => void };
        closable.closeIdleConnections?.();

        this.server.close(() => {
          this.server = null;
          this.onMessage = null;
          log.info('Web channel stopped');
          resolve();
        });
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

  /** Verify bearer token authentication. Returns true if auth passes. */
  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.authToken) return true; // no auth configured

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      sendJSON(res, 401, { error: 'Authentication required' });
      return false;
    }

    const token = authHeader.slice(7);
    if (token !== this.authToken) {
      sendJSON(res, 403, { error: 'Invalid token' });
      return false;
    }

    return true;
  }

  /** Check auth via query param (for SSE/EventSource which can't set headers). */
  private checkAuthForSSE(url: URL, res: ServerResponse): boolean {
    if (!this.authToken) return true;

    const token = url.searchParams.get('token');
    if (!token) {
      sendJSON(res, 401, { error: 'Authentication required' });
      return false;
    }
    if (token !== this.authToken) {
      sendJSON(res, 403, { error: 'Invalid token' });
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
        if (!this.checkAuthForSSE(url, res)) return;
      } else {
        if (!this.checkAuth(req, res)) return;
      }

      // GET /api/status — Runtime status
      if (req.method === 'GET' && url.pathname === '/api/status') {
        sendJSON(res, 200, { status: 'running', timestamp: Date.now() });
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
