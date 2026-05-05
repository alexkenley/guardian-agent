import type { IncomingMessage, ServerResponse } from 'node:http';
import { access, readFile, readdir } from 'node:fs/promises';
import { resolve, win32 } from 'node:path';
import type { PrincipalRole } from '../tools/types.js';
import type { DashboardCallbacks } from './web-types.js';
import { readBody, sendJSON } from './web-json.js';
import { resolveWebSurfaceId } from '../runtime/channel-surface-ids.js';

interface RequestPrincipal {
  principalId: string;
  principalRole: PrincipalRole;
}

interface WebCodeWorkspaceRoutesContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  maxBodyBytes: number;
  dashboard: DashboardCallbacks;
  resolveRequestPrincipal: (req: IncomingMessage) => RequestPrincipal;
  resolveCodeSessionPath: (root: string, requestedPath: string | undefined, fallbackRelative?: string) => string;
  toRelativeSessionPath: (root: string, target: string) => string;
  readSurfaceIdFromSearchParams: (url: URL) => string | undefined;
}

function trimOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const WEB_CODE_USER_ID = 'web-user';
const WEB_CODE_CHANNEL = 'web';

type DashboardCodeSessionSnapshot = NonNullable<ReturnType<NonNullable<DashboardCallbacks['onCodeSessionGet']>>>;

async function listWindowsDriveRoots(): Promise<Array<{ name: string; type: 'dir'; path: string }>> {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const candidates = await Promise.all(letters.map(async (letter) => {
    const root = `${letter}:\\`;
    try {
      await access(root);
      return { name: `${letter}:`, type: 'dir' as const, path: root };
    } catch {
      return null;
    }
  }));
  return candidates.filter((entry): entry is { name: string; type: 'dir'; path: string } => entry !== null);
}

function resolveLocalBrowsePath(requestedPath: string | undefined): { virtualRoot: boolean; path: string } {
  const trimmed = trimOptionalString(requestedPath);
  if (process.platform === 'win32') {
    if (!trimmed || trimmed === '.') {
      return { virtualRoot: false, path: resolve(process.cwd()) };
    }
    if (trimmed === '/' || trimmed === '\\') {
      return { virtualRoot: true, path: '/' };
    }
    if (/^[a-zA-Z]:[\\/]*$/.test(trimmed)) {
      return { virtualRoot: false, path: win32.parse(trimmed).root };
    }
  }
  return { virtualRoot: false, path: resolve(trimmed || '.') };
}

function getWebCodeSessionSnapshot(
  context: WebCodeWorkspaceRoutesContext,
  input: { sessionId?: string; surfaceId?: string },
): { success: true; snapshot: DashboardCodeSessionSnapshot } | { success: false; status: number; error: string } {
  const sessionId = trimOptionalString(input.sessionId);
  if (!sessionId) {
    return { success: false, status: 400, error: 'Code session is required' };
  }
  if (!context.dashboard.onCodeSessionGet) {
    return { success: false, status: 404, error: 'Code sessions are not available' };
  }
  const principal = context.resolveRequestPrincipal(context.req);
  const snapshot = context.dashboard.onCodeSessionGet({
    sessionId,
    userId: WEB_CODE_USER_ID,
    principalId: principal.principalId,
    channel: WEB_CODE_CHANNEL,
    surfaceId: resolveWebSurfaceId(trimOptionalString(input.surfaceId)),
    historyLimit: 1,
  });
  if (!snapshot) {
    return { success: false, status: 404, error: 'Code session not found' };
  }
  return { success: true, snapshot };
}

export async function handleWebCodeWorkspaceRoutes(
  context: WebCodeWorkspaceRoutesContext,
): Promise<boolean> {
  const { req, res, url, dashboard } = context;

  if (req.method === 'POST' && url.pathname === '/api/code/fs/browse') {
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as { path?: string };
    const target = resolveLocalBrowsePath(parsed.path);
    try {
      if (target.virtualRoot) {
        sendJSON(res, 200, {
          success: true,
          path: target.path,
          entries: await listWindowsDriveRoots(),
        });
        return true;
      }
      const entries = await readdir(target.path, { withFileTypes: true });
      sendJSON(res, 200, {
        success: true,
        path: target.path,
        entries: entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({
            name: entry.name,
            type: 'dir',
          }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      });
    } catch (err) {
      sendJSON(res, 200, { success: false, error: err instanceof Error ? err.message : 'Failed to list directory' });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/code/fs/list') {
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as {
      path?: string;
      sessionId?: string;
      userId?: string;
      channel?: string;
      surfaceId?: string;
    };
    const sessionLookup = getWebCodeSessionSnapshot(context, parsed);
    if (!sessionLookup.success) {
      sendJSON(res, sessionLookup.status, { success: false, error: sessionLookup.error });
      return true;
    }
    let targetPath: string;
    try {
      targetPath = context.resolveCodeSessionPath(sessionLookup.snapshot.session.resolvedRoot, parsed.path, '.');
    } catch (err) {
      sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
      return true;
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
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/code/fs/read') {
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as {
      path?: string;
      maxBytes?: number;
      sessionId?: string;
      userId?: string;
      channel?: string;
      surfaceId?: string;
    };
    const sessionLookup = getWebCodeSessionSnapshot(context, parsed);
    if (!sessionLookup.success) {
      sendJSON(res, sessionLookup.status, { success: false, error: sessionLookup.error });
      return true;
    }
    let targetPath: string;
    try {
      targetPath = context.resolveCodeSessionPath(sessionLookup.snapshot.session.resolvedRoot, parsed.path);
    } catch (err) {
      sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
      return true;
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
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/code/fs/write') {
    const body = await readBody(req, context.maxBodyBytes);
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
      return true;
    }
    const sessionLookup = getWebCodeSessionSnapshot(context, parsed);
    if (!sessionLookup.success) {
      sendJSON(res, sessionLookup.status, { success: false, error: sessionLookup.error });
      return true;
    }
    let targetPath: string;
    try {
      targetPath = context.resolveCodeSessionPath(sessionLookup.snapshot.session.resolvedRoot, parsed.path);
    } catch (err) {
      sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
      return true;
    }
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(targetPath, parsed.content, 'utf-8');
      sendJSON(res, 200, { success: true, path: targetPath });
    } catch (err) {
      sendJSON(res, 200, { success: false, error: err instanceof Error ? err.message : 'Failed to write file' });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/code/git/diff') {
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as {
      cwd?: string;
      path?: string;
      staged?: boolean;
      sessionId?: string;
      userId?: string;
      channel?: string;
      surfaceId?: string;
    };
    let sessionPath = trimOptionalString(parsed.path);
    const sessionLookup = getWebCodeSessionSnapshot(context, parsed);
    if (!sessionLookup.success) {
      sendJSON(res, sessionLookup.status, { success: false, error: sessionLookup.error });
      return true;
    }
    let cwd: string;
    try {
      cwd = context.resolveCodeSessionPath(sessionLookup.snapshot.session.resolvedRoot, parsed.cwd, '.');
      if (sessionPath) {
        const resolvedPath = context.resolveCodeSessionPath(sessionLookup.snapshot.session.resolvedRoot, sessionPath);
        sessionPath = context.toRelativeSessionPath(sessionLookup.snapshot.session.resolvedRoot, resolvedPath);
      }
    } catch (err) {
      sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
      return true;
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
      sendJSON(res, 200, {
        success: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    } catch (err) {
      sendJSON(res, 200, { success: false, error: err instanceof Error ? err.message : 'Git diff failed' });
    }
    return true;
  }

  const gitStatusMatch = url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/git\/status$/);
  if (req.method === 'GET' && gitStatusMatch) {
    const sessionId = decodeURIComponent(gitStatusMatch[1]);
    const principal = context.resolveRequestPrincipal(req);
    const snapshot = dashboard.onCodeSessionGet?.({
      sessionId,
      userId: WEB_CODE_USER_ID,
      principalId: principal.principalId,
      channel: WEB_CODE_CHANNEL,
      surfaceId: resolveWebSurfaceId(context.readSurfaceIdFromSearchParams(url)),
      historyLimit: 1,
    });
    if (!snapshot) {
      sendJSON(res, 404, { success: false, error: 'Code session not found' });
      return true;
    }
    const cwd = snapshot.session.resolvedRoot;
    try {
      const { execFile } = await import('node:child_process');
      const [statusResult, branchResult] = await Promise.all([
        new Promise<{ stdout: string; exitCode: number }>((resolveResult) => {
          execFile('git', ['status', '--porcelain=v1', '-uall'], { cwd, windowsHide: true, maxBuffer: 1024 * 1024 }, (error: any, stdout: string) => {
            resolveResult({ stdout: stdout || '', exitCode: error ? (error.code ?? 1) : 0 });
          });
        }),
        new Promise<{ stdout: string }>((resolveResult) => {
          execFile('git', ['branch', '--show-current'], { cwd, windowsHide: true }, (_error: any, stdout: string) => {
            resolveResult({ stdout: (stdout || '').trim() });
          });
        }),
      ]);
      if (statusResult.exitCode !== 0) {
        sendJSON(res, 200, { success: false, error: 'Not a git repository or git not available' });
        return true;
      }
      const staged: Array<{ path: string; status: string }> = [];
      const unstaged: Array<{ path: string; status: string }> = [];
      const untracked: Array<{ path: string; status: string }> = [];
      for (const line of statusResult.stdout.split('\n')) {
        if (!line || line.length < 4) continue;
        const x = line[0];
        const y = line[1];
        const filePath = line.slice(3).replace(/ -> .+$/, '');
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
    return true;
  }

  const gitActionMatch = url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/git\/action$/);
  if (req.method === 'POST' && gitActionMatch) {
    const sessionId = decodeURIComponent(gitActionMatch[1]);
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as {
      action: string;
      path?: string;
      message?: string;
      userId?: string;
      channel?: string;
      surfaceId?: string;
    };
    const principal = context.resolveRequestPrincipal(req);
    const snapshot = dashboard.onCodeSessionGet?.({
      sessionId,
      userId: WEB_CODE_USER_ID,
      principalId: principal.principalId,
      channel: WEB_CODE_CHANNEL,
      surfaceId: resolveWebSurfaceId(trimOptionalString(parsed.surfaceId)),
      historyLimit: 1,
    });
    if (!snapshot) {
      sendJSON(res, 404, { success: false, error: 'Code session not found' });
      return true;
    }
    const cwd = snapshot.session.resolvedRoot;
    const action = parsed.action;
    const validActions = ['stage', 'unstage', 'commit', 'push', 'pull', 'fetch', 'discard', 'init'];
    if (!validActions.includes(action)) {
      sendJSON(res, 400, { success: false, error: `Invalid git action: ${action}` });
      return true;
    }
    let gitPath = parsed.path || '.';
    try {
      const resolvedGitPath = context.resolveCodeSessionPath(snapshot.session.resolvedRoot, gitPath, '.');
      gitPath = context.toRelativeSessionPath(snapshot.session.resolvedRoot, resolvedGitPath) || '.';
    } catch (err) {
      sendJSON(res, 403, { success: false, error: err instanceof Error ? err.message : 'Denied path' });
      return true;
    }
    try {
      const { execFile } = await import('node:child_process');
      const run = (args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
        new Promise((resolveResult) => {
          execFile('git', args, { cwd, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error: any, stdout: string, stderr: string) => {
            resolveResult({ stdout: stdout || '', stderr: stderr || '', exitCode: error ? (error.code ?? 1) : 0 });
          });
        });
      let result: { stdout: string; stderr: string; exitCode: number };
      switch (action) {
        case 'stage':
          result = await run(['add', '--', gitPath]);
          break;
        case 'unstage':
          result = await run(['reset', 'HEAD', '--', gitPath]);
          break;
        case 'commit':
          if (!parsed.message?.trim()) {
            sendJSON(res, 400, { success: false, error: 'Commit message required' });
            return true;
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
          result = await run(['checkout', '--', gitPath]);
          break;
        case 'init':
          result = await run(['init']);
          break;
        default:
          sendJSON(res, 400, { success: false, error: 'Unknown action' });
          return true;
      }
      sendJSON(res, 200, { success: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr });
    } catch (err) {
      sendJSON(res, 200, { success: false, error: err instanceof Error ? err.message : `Git ${action} failed` });
    }
    return true;
  }

  const gitGraphMatch = url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/git\/graph$/);
  if (req.method === 'GET' && gitGraphMatch) {
    const sessionId = decodeURIComponent(gitGraphMatch[1]);
    const principal = context.resolveRequestPrincipal(req);
    const snapshot = dashboard.onCodeSessionGet?.({
      sessionId,
      userId: WEB_CODE_USER_ID,
      principalId: principal.principalId,
      channel: WEB_CODE_CHANNEL,
      surfaceId: resolveWebSurfaceId(context.readSurfaceIdFromSearchParams(url)),
      historyLimit: 1,
    });
    if (!snapshot) {
      sendJSON(res, 404, { success: false, error: 'Code session not found' });
      return true;
    }
    const cwd = snapshot.session.resolvedRoot;
    try {
      const { execFile } = await import('node:child_process');
      const result = await new Promise<{ stdout: string; exitCode: number }>((resolveResult) => {
        execFile('git', [
          'log', '--all', '--oneline', '--graph', '--decorate=short',
          '--date=short', '--pretty=format:%h\t%d\t%s\t%ad',
          '-40',
        ], { cwd, windowsHide: true, maxBuffer: 256 * 1024 }, (error: any, stdout: string) => {
          resolveResult({ stdout: stdout || '', exitCode: error ? (error.code ?? 1) : 0 });
        });
      });
      if (result.exitCode !== 0) {
        sendJSON(res, 200, { success: false, entries: [] });
        return true;
      }
      const entries = result.stdout.split('\n').filter(Boolean).map((line) => {
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
        return { graph: line, hash: '', refs: '', message: '', date: '' };
      });
      sendJSON(res, 200, { success: true, entries });
    } catch (err) {
      sendJSON(res, 200, { success: false, entries: [], error: err instanceof Error ? err.message : 'Git graph failed' });
    }
    return true;
  }

  return false;
}
