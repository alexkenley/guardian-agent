import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn as spawnPty, type IPty } from 'node-pty';
import type { PrincipalRole } from '../tools/types.js';
import { buildHardenedEnv } from '../sandbox/index.js';
import type { DashboardCallbacks, SSEEvent } from './web-types.js';
import { readBody, sendJSON } from './web-json.js';
import {
  getDefaultShellForPlatform,
  getPtyShellLaunch,
} from './web-shell-launch.js';

interface RequestPrincipal {
  principalId: string;
  principalRole: PrincipalRole;
}

export interface WebTerminalSessionRecord {
  id: string;
  ownerSessionId: string | null;
  pty: IPty;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  codeSessionId?: string | null;
}

interface WebTerminalRoutesContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  maxBodyBytes: number;
  dashboard: DashboardCallbacks;
  terminalSessions: Map<string, WebTerminalSessionRecord>;
  terminalOutputListeners: Map<string, Set<(data: string) => void>>;
  terminalExitListeners: Map<string, Set<(exitCode: number, signal: number) => void>>;
  resolveRequestPrincipal: (req: IncomingMessage) => RequestPrincipal;
  resolveCodeSessionPath: (root: string, requestedPath: string | undefined, fallbackRelative?: string) => string;
  emitSSE: (event: SSEEvent) => void;
  getOwnerSessionId: (req: IncomingMessage) => string | null;
}

function trimOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function canAccessTerminal(
  req: IncomingMessage,
  session: WebTerminalSessionRecord,
  getOwnerSessionId: (req: IncomingMessage) => string | null,
): boolean {
  return session.ownerSessionId === getOwnerSessionId(req);
}

export async function handleWebTerminalRoutes(
  context: WebTerminalRoutesContext,
): Promise<boolean> {
  const { req, res, url, dashboard } = context;

  if (req.method === 'POST' && url.pathname === '/api/code/terminals') {
    const terminalAccess = dashboard.onCodeTerminalAccessCheck?.();
    if (terminalAccess && terminalAccess.allowed === false) {
      sendJSON(res, 403, {
        success: false,
        error: terminalAccess.reason || 'Manual code terminals are disabled by policy.',
      });
      return true;
    }
    const body = await readBody(req, context.maxBodyBytes);
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
    if (trimOptionalString(parsed.sessionId) && dashboard.onCodeSessionGet) {
      const principal = context.resolveRequestPrincipal(req);
      const snapshot = dashboard.onCodeSessionGet({
        sessionId: parsed.sessionId!,
        userId: parsed.userId || 'web-user',
        principalId: principal.principalId,
        channel: parsed.channel || 'web',
        surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
        historyLimit: 1,
      });
      if (!snapshot) {
        sendJSON(res, 404, { success: false, error: 'Code session not found' });
        return true;
      }
      try {
        requestedCwd = context.resolveCodeSessionPath(snapshot.session.resolvedRoot, parsed.cwd, '.');
        codeSessionId = snapshot.session.id;
      } catch (err) {
        sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
        return true;
      }
    }
    const launch = getPtyShellLaunch(shellType, platform, requestedCwd);
    const cols = Math.max(40, Math.min(240, Number(parsed.cols) || 120));
    const rows = Math.max(12, Math.min(120, Number(parsed.rows) || 30));
    const ownerSessionId = context.getOwnerSessionId(req);
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
      const session: WebTerminalSessionRecord = {
        id: terminalId,
        ownerSessionId,
        pty,
        shell: shellType,
        cwd: requestedCwd,
        cols,
        rows,
        ...(codeSessionId ? { codeSessionId } : {}),
      };
      context.terminalSessions.set(terminalId, session);
      dashboard.onCodeTerminalEvent?.({
        action: 'opened',
        terminalId,
        shell: shellType,
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        codeSessionId: session.codeSessionId ?? null,
      });
      pty.onData((data) => {
        context.emitSSE({
          type: 'terminal.output',
          data: { terminalId, data },
        });
        const outputListeners = context.terminalOutputListeners.get(terminalId);
        if (outputListeners) {
          for (const cb of outputListeners) {
            try {
              cb(data);
            } catch {
              // listener error
            }
          }
        }
      });
      pty.onExit((event) => {
        const exitListeners = context.terminalExitListeners.get(terminalId);
        if (exitListeners) {
          for (const cb of exitListeners) {
            try {
              cb(event.exitCode ?? 1, event.signal ?? 0);
            } catch {
              // listener error
            }
          }
          context.terminalExitListeners.delete(terminalId);
        }
        context.terminalOutputListeners.delete(terminalId);
        context.terminalSessions.delete(terminalId);
        dashboard.onCodeTerminalEvent?.({
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
        context.emitSSE({
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
    return true;
  }

  const terminalInputMatch = req.method === 'POST'
    ? url.pathname.match(/^\/api\/code\/terminals\/([^/]+)\/input$/)
    : null;
  if (terminalInputMatch) {
    const terminalId = decodeURIComponent(terminalInputMatch[1]);
    const session = context.terminalSessions.get(terminalId);
    if (!session || !canAccessTerminal(req, session, context.getOwnerSessionId)) {
      sendJSON(res, 404, { success: false, error: 'Terminal not found' });
      return true;
    }
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as { input?: string };
    if (typeof parsed.input !== 'string') {
      sendJSON(res, 400, { success: false, error: 'input is required' });
      return true;
    }
    session.pty.write(parsed.input);
    sendJSON(res, 200, { success: true });
    return true;
  }

  const terminalResizeMatch = req.method === 'POST'
    ? url.pathname.match(/^\/api\/code\/terminals\/([^/]+)\/resize$/)
    : null;
  if (terminalResizeMatch) {
    const terminalId = decodeURIComponent(terminalResizeMatch[1]);
    const session = context.terminalSessions.get(terminalId);
    if (!session || !canAccessTerminal(req, session, context.getOwnerSessionId)) {
      sendJSON(res, 404, { success: false, error: 'Terminal not found' });
      return true;
    }
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as { cols?: number; rows?: number };
    const cols = Math.max(40, Math.min(240, Number(parsed.cols) || session.cols));
    const rows = Math.max(12, Math.min(120, Number(parsed.rows) || session.rows));
    session.cols = cols;
    session.rows = rows;
    session.pty.resize(cols, rows);
    sendJSON(res, 200, { success: true });
    return true;
  }

  const terminalDeleteMatch = req.method === 'DELETE'
    ? url.pathname.match(/^\/api\/code\/terminals\/([^/]+)$/)
    : null;
  if (terminalDeleteMatch) {
    const terminalId = decodeURIComponent(terminalDeleteMatch[1]);
    const session = context.terminalSessions.get(terminalId);
    if (!session || !canAccessTerminal(req, session, context.getOwnerSessionId)) {
      sendJSON(res, 404, { success: false, error: 'Terminal not found' });
      return true;
    }
    context.terminalSessions.delete(terminalId);
    try {
      session.pty.kill();
    } catch {
      // Best effort close.
    }
    sendJSON(res, 200, { success: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/shell/exec') {
    sendJSON(res, 410, {
      success: false,
      error: 'Direct shell execution has been removed from the web API. Use /api/code/terminals for interactive shell access.',
    });
    return true;
  }

  return false;
}
