import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeSessionStore } from './code-sessions.js';
import { CodeWorkspaceTrustService } from './code-workspace-trust-service.js';

const testDirs: string[] = [];

function createWorkspace(name: string, files: Record<string, string>): string {
  const root = join(tmpdir(), `guardianagent-workspace-trust-service-${name}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  testDirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = join(root, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, 'utf-8');
  }
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for async workspace-trust update');
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('CodeWorkspaceTrustService', () => {
  it('persists native protection results back into the session trust state', async () => {
    const workspaceRoot = createWorkspace('clean', {
      'README.md': '# Clean Repo\n',
    });
    const store = new CodeSessionStore({
      enabled: false,
      sqlitePath: join(workspaceRoot, '.guardianagent', 'code-sessions.sqlite'),
    });
    const session = store.createSession({
      ownerUserId: 'owner',
      title: 'Clean Session',
      workspaceRoot,
    });

    const service = new CodeWorkspaceTrustService({
      codeSessionStore: store,
      now: () => 1_000,
      scanner: {
        createPendingProtection: () => ({
          provider: 'windows_defender',
          status: 'pending',
          summary: 'Windows Defender custom scan requested.',
          observedAt: 1_000,
          requestedAt: 1_000,
        }),
        scanWorkspace: vi.fn().mockResolvedValue({
          provider: 'windows_defender',
          status: 'clean',
          summary: 'Windows Defender custom scan completed with no active workspace detections observed.',
          observedAt: 2_000,
        }),
      } as any,
    });

    const primed = service.maybeSchedule(session);
    expect(primed.workState.workspaceTrust?.nativeProtection?.status).toBe('pending');

    await waitFor(() => store.getSession(session.id, 'owner')?.workState.workspaceTrust?.nativeProtection?.status === 'clean');
    const refreshed = store.getSession(session.id, 'owner');
    expect(refreshed?.workState.workspaceTrust?.state).toBe('trusted');
    expect(refreshed?.workState.workspaceTrust?.nativeProtection?.status).toBe('clean');
  });

  it('blocks the session trust state when native protection reports a detection', async () => {
    const workspaceRoot = createWorkspace('detected', {
      'README.md': '# Detected Repo\n',
    });
    const store = new CodeSessionStore({
      enabled: false,
      sqlitePath: join(workspaceRoot, '.guardianagent', 'code-sessions.sqlite'),
    });
    const session = store.createSession({
      ownerUserId: 'owner',
      title: 'Detected Session',
      workspaceRoot,
    });

    const service = new CodeWorkspaceTrustService({
      codeSessionStore: store,
      now: () => 5_000,
      scanner: {
        createPendingProtection: () => null,
        scanWorkspace: vi.fn().mockResolvedValue({
          provider: 'clamav',
          status: 'detected',
          summary: 'ClamAV reported 1 detection in the workspace.',
          observedAt: 6_000,
          details: ['Win.Test.EICAR_HDB-1 (/tmp/repo/bad.exe)'],
        }),
      } as any,
    });

    service.maybeSchedule(session);

    await waitFor(() => store.getSession(session.id, 'owner')?.workState.workspaceTrust?.nativeProtection?.status === 'detected');
    const refreshed = store.getSession(session.id, 'owner');
    expect(refreshed?.workState.workspaceTrust?.state).toBe('blocked');
    expect(refreshed?.workState.workspaceTrust?.findings.some((finding) => finding.kind === 'native_av_detection')).toBe(true);
  });
});

