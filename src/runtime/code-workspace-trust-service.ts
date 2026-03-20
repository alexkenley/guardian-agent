import type { CodeSessionRecord, CodeSessionStore } from './code-sessions.js';
import { CodeWorkspaceNativeProtectionScanner } from './code-workspace-native-protection.js';
import {
  applyCodeWorkspaceNativeProtection,
  shouldRefreshCodeWorkspaceNativeProtection,
  type CodeWorkspaceNativeProtection,
} from './code-workspace-trust.js';

export interface CodeWorkspaceTrustServiceOptions {
  codeSessionStore: CodeSessionStore;
  scanner: CodeWorkspaceNativeProtectionScanner;
  now?: () => number;
}

export class CodeWorkspaceTrustService {
  private readonly codeSessionStore: CodeSessionStore;
  private readonly scanner: CodeWorkspaceNativeProtectionScanner;
  private readonly now: () => number;
  private readonly pendingScans = new Map<string, Promise<void>>();

  constructor(options: CodeWorkspaceTrustServiceOptions) {
    this.codeSessionStore = options.codeSessionStore;
    this.scanner = options.scanner;
    this.now = options.now ?? Date.now;
  }

  maybeSchedule(session: CodeSessionRecord): CodeSessionRecord {
    const assessment = session.workState.workspaceTrust;
    if (!assessment) return session;
    if (!shouldRefreshCodeWorkspaceNativeProtection(assessment, session.resolvedRoot, this.now())) {
      return session;
    }

    let nextSession = session;
    const pending = this.scanner.createPendingProtection(session.resolvedRoot);
    if (pending) {
      const nextAssessment = applyCodeWorkspaceNativeProtection(assessment, pending);
      const updated = this.codeSessionStore.updateSession({
        sessionId: session.id,
        ownerUserId: session.ownerUserId,
        workState: {
          workspaceTrust: nextAssessment,
        },
      });
      if (updated) {
        nextSession = updated;
      }
    }

    const scanKey = `${session.id}:${session.resolvedRoot}`;
    if (!this.pendingScans.has(scanKey)) {
      const task = this.runScan(session.id, session.ownerUserId, session.resolvedRoot)
        .finally(() => {
          this.pendingScans.delete(scanKey);
        });
      this.pendingScans.set(scanKey, task);
    }

    return nextSession;
  }

  private async runScan(sessionId: string, ownerUserId: string, workspaceRoot: string): Promise<void> {
    const nativeProtection = await this.scanWorkspace(workspaceRoot).catch((error) => ({
      provider: 'native_av',
      status: 'error',
      summary: `Native AV scan failed: ${error instanceof Error ? error.message : String(error)}`,
      observedAt: this.now(),
    } satisfies CodeWorkspaceNativeProtection));

    const current = this.codeSessionStore.getSession(sessionId, ownerUserId);
    if (!current || current.resolvedRoot !== workspaceRoot || !current.workState.workspaceTrust) {
      return;
    }

    const nextAssessment = applyCodeWorkspaceNativeProtection(current.workState.workspaceTrust, nativeProtection);
    this.codeSessionStore.updateSession({
      sessionId: current.id,
      ownerUserId: current.ownerUserId,
      workState: {
        workspaceTrust: nextAssessment,
      },
    });
  }

  private async scanWorkspace(workspaceRoot: string): Promise<CodeWorkspaceNativeProtection> {
    return this.scanner.scanWorkspace(workspaceRoot);
  }
}

