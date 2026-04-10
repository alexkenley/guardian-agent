import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PrincipalRole } from '../tools/types.js';
import type {
  CodeSessionAttachmentMode,
  CodeSessionStatus,
  CodeSessionUiState,
  CodeSessionWorkState,
} from '../runtime/code-sessions.js';
import {
  inspectCodeWorkspaceFileStructureSync,
  inspectCodeWorkspaceFileStructureTextSync,
} from '../runtime/code-workspace-structure.js';
import type { DashboardCallbacks } from './web-types.js';
import { readBody, sendJSON } from './web-json.js';

interface RequestPrincipal {
  principalId: string;
  principalRole: PrincipalRole;
}

interface RequestErrorDetails {
  statusCode: number;
  error: string;
  errorCode?: string;
}

interface WebCodeSessionRoutesContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  maxBodyBytes: number;
  dashboard: DashboardCallbacks;
  resolveRequestPrincipal: (req: IncomingMessage) => RequestPrincipal;
  resolveCodeSessionPath: (root: string, requestedPath: string | undefined, fallbackRelative?: string) => string;
  getRequestErrorDetails: (err: unknown) => RequestErrorDetails | null;
  logInternalError: (message: string, err: unknown) => void;
}

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

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export async function handleWebCodeSessionRoutes(
  context: WebCodeSessionRoutesContext,
): Promise<boolean> {
  const { req, res, url, dashboard } = context;

  if (req.method === 'GET' && url.pathname === '/api/code/sessions') {
    if (!dashboard.onCodeSessionsList) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const principal = context.resolveRequestPrincipal(req);
    const userId = url.searchParams.get('userId') || 'web-user';
    const channel = url.searchParams.get('channel') || 'web';
    sendJSON(res, 200, dashboard.onCodeSessionsList({
      userId,
      principalId: principal.principalId,
      channel,
      surfaceId: readSurfaceIdFromSearchParams(url) ?? userId,
    }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/code/sessions') {
    if (!dashboard.onCodeSessionCreate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const body = await readBody(req, context.maxBodyBytes);
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
      return true;
    }
    const principal = context.resolveRequestPrincipal(req);
    const result = dashboard.onCodeSessionCreate({
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
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/code/sessions/detach') {
    if (!dashboard.onCodeSessionDetach) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as { userId?: string; channel?: string; surfaceId?: string };
    const principal = context.resolveRequestPrincipal(req);
    const result = dashboard.onCodeSessionDetach({
      userId: parsed.userId || 'web-user',
      principalId: principal.principalId,
      channel: parsed.channel || 'web',
      surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
    });
    sendJSON(res, 200, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/code/sessions/references') {
    if (!dashboard.onCodeSessionSetReferences) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as {
      userId?: string;
      channel?: string;
      surfaceId?: string;
      referencedSessionIds?: unknown;
    };
    const principal = context.resolveRequestPrincipal(req);
    const result = dashboard.onCodeSessionSetReferences({
      userId: parsed.userId || 'web-user',
      principalId: principal.principalId,
      channel: parsed.channel || 'web',
      surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
      referencedSessionIds: Array.isArray(parsed.referencedSessionIds)
        ? parsed.referencedSessionIds.filter((value): value is string => typeof value === 'string')
        : [],
    });
    sendJSON(res, 200, result);
    return true;
  }

  const codeSessionAttachMatch = req.method === 'POST'
    ? url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/attach$/)
    : null;
  if (codeSessionAttachMatch) {
    if (!dashboard.onCodeSessionAttach) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const sessionId = decodeURIComponent(codeSessionAttachMatch[1]);
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as { userId?: string; channel?: string; surfaceId?: string; mode?: string };
    const principal = context.resolveRequestPrincipal(req);
    const result = dashboard.onCodeSessionAttach({
      sessionId,
      userId: parsed.userId || 'web-user',
      principalId: principal.principalId,
      channel: parsed.channel || 'web',
      surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
      mode: trimOptionalString(parsed.mode) as CodeSessionAttachmentMode | undefined,
    });
    sendJSON(res, 200, result);
    return true;
  }

  const codeSessionApprovalMatch = req.method === 'POST'
    ? url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/approvals\/([^/]+)$/)
    : null;
  if (codeSessionApprovalMatch) {
    if (!dashboard.onCodeSessionApprovalDecision) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const sessionId = decodeURIComponent(codeSessionApprovalMatch[1]);
    const approvalId = decodeURIComponent(codeSessionApprovalMatch[2]);
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as {
      userId?: string;
      channel?: string;
      surfaceId?: string;
      decision?: 'approved' | 'denied';
      reason?: string;
    };
    if (!parsed.decision || (parsed.decision !== 'approved' && parsed.decision !== 'denied')) {
      sendJSON(res, 400, { error: 'decision is required' });
      return true;
    }
    const principal = context.resolveRequestPrincipal(req);
    try {
      const result = await dashboard.onCodeSessionApprovalDecision({
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
      const requestError = context.getRequestErrorDetails(err);
      if (requestError) {
        sendJSON(res, requestError.statusCode, {
          error: requestError.error,
          ...(requestError.errorCode ? { errorCode: requestError.errorCode } : {}),
        });
        return true;
      }
      context.logInternalError('Code session approval decision failed', err);
      const detail = err instanceof Error ? err.message : String(err);
      sendJSON(res, 500, { error: `Dispatch error: ${detail}` });
    }
    return true;
  }

  const codeSessionResetMatch = req.method === 'POST'
    ? url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/reset$/)
    : null;
  if (codeSessionResetMatch) {
    if (!dashboard.onCodeSessionResetConversation) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const sessionId = decodeURIComponent(codeSessionResetMatch[1]);
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as { userId?: string; channel?: string };
    const result = dashboard.onCodeSessionResetConversation({
      sessionId,
      userId: parsed.userId || 'web-user',
      channel: parsed.channel || 'web',
    });
    sendJSON(res, 200, result);
    return true;
  }

  const codeSessionTimelineMatch = req.method === 'GET'
    ? url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/timeline$/)
    : null;
  if (codeSessionTimelineMatch) {
    if (!dashboard.onCodeSessionTimeline) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const sessionId = decodeURIComponent(codeSessionTimelineMatch[1]);
    const principal = context.resolveRequestPrincipal(req);
    const userId = url.searchParams.get('userId') || 'web-user';
    const channel = url.searchParams.get('channel') || 'web';
    const limit = Number.parseInt(url.searchParams.get('limit') || '12', 10);
    const result = dashboard.onCodeSessionTimeline({
      sessionId,
      userId,
      principalId: principal.principalId,
      channel,
      surfaceId: readSurfaceIdFromSearchParams(url) ?? userId,
      limit: Number.isFinite(limit) ? limit : 12,
    });
    if (!result) {
      sendJSON(res, 404, { error: 'Code session not found' });
      return true;
    }
    sendJSON(res, 200, result);
    return true;
  }

  const codeSessionMatch = url.pathname.match(/^\/api\/code\/sessions\/([^/]+)$/);
  if (codeSessionMatch) {
    const sessionId = decodeURIComponent(codeSessionMatch[1]);
    const principal = context.resolveRequestPrincipal(req);

    if (req.method === 'GET') {
      if (!dashboard.onCodeSessionGet) {
        sendJSON(res, 404, { error: 'Not available' });
        return true;
      }
      const userId = url.searchParams.get('userId') || 'web-user';
      const channel = url.searchParams.get('channel') || 'web';
      const historyLimit = Number.parseInt(url.searchParams.get('historyLimit') || '120', 10);
      const result = dashboard.onCodeSessionGet({
        sessionId,
        userId,
        principalId: principal.principalId,
        channel,
        surfaceId: readSurfaceIdFromSearchParams(url) ?? userId,
        historyLimit: Number.isFinite(historyLimit) ? historyLimit : 120,
      });
      if (!result) {
        sendJSON(res, 404, { error: 'Code session not found' });
        return true;
      }
      sendJSON(res, 200, result);
      return true;
    }

    if (req.method === 'PATCH') {
      if (!dashboard.onCodeSessionUpdate) {
        sendJSON(res, 404, { error: 'Not available' });
        return true;
      }
      const body = await readBody(req, context.maxBodyBytes);
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
      const result = dashboard.onCodeSessionUpdate({
        sessionId,
        userId: parsed.userId || 'web-user',
        principalId: principal.principalId,
        channel: parsed.channel || 'web',
        surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
        title: trimOptionalString(parsed.title),
        workspaceRoot: trimOptionalString(parsed.workspaceRoot),
        agentId: hasOwn(parsed as object, 'agentId') ? (trimOptionalString(parsed.agentId) ?? null) : undefined,
        status: trimOptionalString(parsed.status) as CodeSessionStatus | undefined,
        uiState: asRecord(parsed.uiState) as CodeSessionUiState | undefined,
        workState: asRecord(parsed.workState) as CodeSessionWorkState | undefined,
      });
      if (!result) {
        sendJSON(res, 404, { error: 'Code session not found' });
        return true;
      }
      sendJSON(res, 200, result);
      return true;
    }

    if (req.method === 'DELETE') {
      if (!dashboard.onCodeSessionDelete) {
        sendJSON(res, 404, { error: 'Not available' });
        return true;
      }
      const body = await readBody(req, context.maxBodyBytes).catch(() => '');
      const parsed = JSON.parse(body || '{}') as { userId?: string; channel?: string; surfaceId?: string };
      const result = dashboard.onCodeSessionDelete({
        sessionId,
        userId: parsed.userId || 'web-user',
        principalId: principal.principalId,
        channel: parsed.channel || 'web',
        surfaceId: trimOptionalString(parsed.surfaceId) ?? parsed.userId ?? 'web-user',
      });
      sendJSON(res, result.success ? 200 : 404, result);
      return true;
    }
  }

  const codeSessionStructureMatch = req.method === 'GET'
    ? url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/structure$/)
    : null;
  if (codeSessionStructureMatch) {
    if (!dashboard.onCodeSessionGet) {
      sendJSON(res, 404, { success: false, error: 'Not available' });
      return true;
    }
    const sessionId = decodeURIComponent(codeSessionStructureMatch[1]);
    const principal = context.resolveRequestPrincipal(req);
    const userId = url.searchParams.get('userId') || 'web-user';
    const channel = url.searchParams.get('channel') || 'web';
    const snapshot = dashboard.onCodeSessionGet({
      sessionId,
      userId,
      principalId: principal.principalId,
      channel,
      surfaceId: readSurfaceIdFromSearchParams(url) ?? userId,
      historyLimit: 1,
    });
    if (!snapshot) {
      sendJSON(res, 404, { success: false, error: 'Code session not found' });
      return true;
    }

    const requestedPath = trimOptionalString(url.searchParams.get('path'));
    const requestedSectionId = trimOptionalString(url.searchParams.get('sectionId'));
    const requestedLine = Number(url.searchParams.get('line')) || 0;
    const fallbackPath = trimOptionalString(snapshot.session.uiState.selectedFilePath);
    if (!requestedPath && !fallbackPath) {
      sendJSON(res, 400, { success: false, error: 'A file path is required for structure inspection.' });
      return true;
    }

    let targetPath: string;
    try {
      targetPath = context.resolveCodeSessionPath(
        snapshot.session.resolvedRoot,
        requestedPath ?? fallbackPath ?? undefined,
      );
    } catch (err) {
      sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
      return true;
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
    return true;
  }

  const codeSessionStructurePreviewMatch = req.method === 'POST'
    ? url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/structure-preview$/)
    : null;
  if (codeSessionStructurePreviewMatch) {
    if (!dashboard.onCodeSessionGet) {
      sendJSON(res, 404, { success: false, error: 'Not available' });
      return true;
    }
    const sessionId = decodeURIComponent(codeSessionStructurePreviewMatch[1]);
    const principal = context.resolveRequestPrincipal(req);
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as {
      userId?: string;
      channel?: string;
      surfaceId?: string;
      path?: string;
      content?: string;
      line?: number;
      sectionId?: string;
    };
    const snapshot = dashboard.onCodeSessionGet({
      sessionId,
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

    const requestedPath = trimOptionalString(parsed.path);
    if (!requestedPath) {
      sendJSON(res, 400, { success: false, error: 'A file path is required for structure preview.' });
      return true;
    }
    if (typeof parsed.content !== 'string') {
      sendJSON(res, 400, { success: false, error: 'Structure preview content must be a string.' });
      return true;
    }

    let targetPath: string;
    try {
      targetPath = context.resolveCodeSessionPath(snapshot.session.resolvedRoot, requestedPath);
    } catch (err) {
      sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
      return true;
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
    return true;
  }

  return false;
}
