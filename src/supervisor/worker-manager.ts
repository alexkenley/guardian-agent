import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxedSpawn, detectSandboxHealth, type SandboxConfig, DEFAULT_SANDBOX_CONFIG } from '../sandbox/index.js';
import { createLogger } from '../util/logging.js';
import { BrokerServer } from '../broker/broker-server.js';
import { CapabilityTokenManager } from '../broker/capability-token.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { Runtime } from '../runtime/runtime.js';
import type { AgentIsolationConfig } from '../config/types.js';
import type { UserMessage } from '../agent/types.js';
import type { ResolvedSkill } from '../skills/types.js';
import { tryAutomationPreRoute, type AutomationPendingApprovalMetadata } from '../runtime/automation-prerouter.js';
import { formatPendingApprovalMessage } from '../runtime/pending-approval-copy.js';

const log = createLogger('worker-manager');
const APPROVAL_CONFIRM_PATTERN = /^(?:\/)?(?:approve|approved|yes|yep|yeah|y|go ahead|do it|confirm|ok|okay|sure|proceed|accept)\b/i;
const APPROVAL_DENY_PATTERN = /^(?:\/)?(?:deny|denied|reject|decline|cancel|no|nope|nah|n)\b/i;
const APPROVAL_ID_TOKEN_PATTERN = /^(?=.*(?:-|\d))[a-z0-9-]{4,}$/i;
const PENDING_APPROVAL_TTL_MS = 30 * 60_000;
const WORKER_WORKSPACE_CLEANUP_MAX_RETRIES = 10;
const WORKER_WORKSPACE_CLEANUP_RETRY_DELAY_MS = 100;

const workerManagerPath = fileURLToPath(import.meta.url);
const workerManagerDir = dirname(workerManagerPath);

export interface WorkerMessageRequest {
  sessionId: string;
  agentId: string;
  userId: string;
  grantedCapabilities: string[];
  message: UserMessage;
  systemPrompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  knowledgeBase?: string;
  activeSkills?: ResolvedSkill[];
  toolContext?: string;
  runtimeNotices?: Array<{ level: 'info' | 'warn'; message: string }>;
}

export interface WorkerProcess {
  id: string;
  sessionId: string;
  agentId: string;
  authorizedBy: string;
  grantedCapabilities: string[];
  process: ChildProcess;
  brokerServer: BrokerServer;
  workspacePath: string;
  lastActivityMs: number;
  status: 'starting' | 'ready' | 'error' | 'shutting_down';
  pendingMessageResolve?: (result: { content: string; metadata?: Record<string, unknown> }) => void;
  pendingMessageReject?: (error: Error) => void;
}

interface DirectAutomationContinuation {
  request: WorkerMessageRequest;
  pendingApprovalIds: string[];
  expiresAt: number;
}

interface WorkerSuspendedApprovalState {
  workerId: string;
  sessionId: string;
  agentId: string;
  userId: string;
  principalId: string;
  principalRole: NonNullable<UserMessage['principalRole']>;
  channel: string;
  approvalIds: string[];
  expiresAt: number;
}

export class WorkerManager {
  private readonly workers = new Map<string, WorkerProcess>();
  private readonly sessionToWorker = new Map<string, string>();
  private readonly directPendingApprovals = new Map<string, { ids: string[]; expiresAt: number }>();
  private readonly directAutomationContinuations = new Map<string, DirectAutomationContinuation>();
  private readonly workerSuspendedApprovalsBySession = new Map<string, WorkerSuspendedApprovalState>();
  private readonly workerSuspendedApprovalToSession = new Map<string, string>();
  private readonly tokenManager: CapabilityTokenManager;
  private readonly tools: ToolExecutor;
  private readonly runtime: Runtime;
  private readonly config: AgentIsolationConfig;
  private readonly sandboxConfig: SandboxConfig;
  private readonly reapInterval: NodeJS.Timeout;

  constructor(
    tools: ToolExecutor,
    runtime: Runtime,
    config: AgentIsolationConfig,
    sandboxConfig?: SandboxConfig,
  ) {
    this.tools = tools;
    this.runtime = runtime;
    this.config = config;
    this.sandboxConfig = sandboxConfig ?? DEFAULT_SANDBOX_CONFIG;
    this.tokenManager = new CapabilityTokenManager(config.capabilityTokenTtlMs);
    this.reapInterval = setInterval(() => this.reapIdleWorkers(), 60_000);
  }

  async handleMessage(input: WorkerMessageRequest): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const approvalResponse = await this.tryHandleDirectApprovalMessage(input);
    if (approvalResponse) return approvalResponse;

    const directAutomation = await this.tryDirectAutomationAuthoring(input);
    if (directAutomation) return directAutomation;

    const worker = await this.getOrSpawnWorker(input.sessionId, input.agentId, input.userId, input.grantedCapabilities);

    // LLM calls are proxied through the broker — the worker no longer needs the provider config.
    // We only tell the worker whether a fallback provider exists for quality-based retry.
    const hasFallbackProvider = !!this.runtime.getFallbackProviderConfig?.(input.agentId);

    return this.dispatchToWorker(worker, {
      message: input.message,
      systemPrompt: input.systemPrompt,
      history: input.history,
      knowledgeBase: input.knowledgeBase ?? '',
      activeSkills: input.activeSkills ?? [],
      toolContext: input.toolContext ?? '',
      runtimeNotices: input.runtimeNotices ?? [],
      hasFallbackProvider,
    });
  }

  shutdown(): void {
    clearInterval(this.reapInterval);
    for (const worker of this.workers.values()) {
      worker.status = 'shutting_down';
      this.safeKillWorker(worker);
      this.cleanupWorker(worker);
    }
    this.workers.clear();
    this.sessionToWorker.clear();
    this.directPendingApprovals.clear();
    this.directAutomationContinuations.clear();
    this.workerSuspendedApprovalsBySession.clear();
    this.workerSuspendedApprovalToSession.clear();
  }

  private async tryHandleDirectApprovalMessage(
    input: WorkerMessageRequest,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const pendingIds = this.getDirectPendingApprovalIds(input.sessionId);
    if (pendingIds.length === 0) return null;

    const trimmed = input.message.content.trim();
    const decision = APPROVAL_CONFIRM_PATTERN.test(trimmed)
      ? 'approved'
      : APPROVAL_DENY_PATTERN.test(trimmed)
        ? 'denied'
        : null;
    if (!decision) return null;

    const explicitIds = trimmed
      .split(/\s+/g)
      .map((token) => token.trim())
      .filter((token) => APPROVAL_ID_TOKEN_PATTERN.test(token));
    const targetIds = explicitIds.length > 0 ? explicitIds : pendingIds;

    const results: string[] = [];
    const approvedIds = new Set<string>();
    const failedIds = new Set<string>();
    for (const approvalId of targetIds) {
      const decided = await this.tools.decideApproval(
        approvalId,
        decision,
        input.message.principalId ?? input.message.userId,
        input.message.principalRole ?? 'owner',
      );
      if (decision === 'approved' && decided.success) approvedIds.add(approvalId);
      if (!decided.success) failedIds.add(approvalId);
      results.push(decided.message);
    }

    this.consumeDirectPendingApprovals(input.sessionId, targetIds);
    const continuation = this.getDirectAutomationContinuation(input.sessionId);
    if (continuation) {
      const affected = targetIds.filter((id) => continuation.pendingApprovalIds.includes(id));
      if (decision === 'approved' && affected.length > 0) {
        const stillPending = continuation.pendingApprovalIds.filter((id) => !approvedIds.has(id));
        if (stillPending.length === 0) {
          this.directAutomationContinuations.delete(input.sessionId);
          const retry = await this.tryDirectAutomationAuthoring({
            ...continuation.request,
          });
          if (retry) {
            results.push('');
            results.push(retry.content);
            return {
              content: results.join('\n'),
              metadata: retry.metadata,
            };
          }
        } else {
          this.directAutomationContinuations.set(input.sessionId, {
            ...continuation,
            pendingApprovalIds: stillPending,
          });
        }
      } else if (affected.length > 0 && (decision === 'denied' || affected.some((id) => failedIds.has(id)))) {
        this.directAutomationContinuations.delete(input.sessionId);
      }
    }
    return { content: results.join('\n') };
  }

  private async tryDirectAutomationAuthoring(
    input: WorkerMessageRequest,
    options?: { allowRemediation?: boolean },
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const allowedPaths = this.tools.getPolicy?.().sandbox.allowedPaths ?? [process.cwd()];
    const workspaceRoot = allowedPaths[0] || process.cwd();
    const preflightTools = this.tools.preflightTools
      ? (requests: Array<{ name: string; args?: Record<string, unknown> }>) => this.tools.preflightTools(requests)
      : (requests: Array<{ name: string; args?: Record<string, unknown> }>) => requests.map((request) => ({
          name: request.name,
          found: true,
          decision: 'allow' as const,
          reason: 'No worker-manager preflight available; allowing direct automation compile fallback.',
          fixes: [],
        }));
    const trackedPendingApprovalIds: string[] = [];
    const result = await tryAutomationPreRoute({
      agentId: input.agentId,
      message: input.message,
      preflightTools,
      workspaceRoot,
      allowedPaths,
      executeTool: (toolName, args, request) => {
        // Forward codeContext from the inbound message metadata so tool decisions
        // (e.g. isCodeSessionWorkspaceTool auto-approve) see the code session context.
        const msgCodeContext = input.message.metadata?.codeContext as { workspaceRoot: string; sessionId?: string } | undefined;
        return this.tools.executeModelTool(toolName, args, {
          ...request,
          ...(msgCodeContext ? { codeContext: msgCodeContext } : {}),
        });
      },
      trackPendingApproval: (approvalId) => {
        trackedPendingApprovalIds.push(approvalId);
        const existingIds = this.getDirectPendingApprovalIds(input.sessionId);
        this.directPendingApprovals.set(input.sessionId, {
          ids: [...new Set([...existingIds, approvalId])],
          expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
        });
      },
      formatPendingApprovalPrompt: (ids) => {
        const meta = this.resolveDirectPendingApprovalMetadata(ids);
        return meta.length > 0
          ? formatPendingApprovalMessage(meta)
          : 'This action needs approval before I can continue.';
      },
      resolvePendingApprovalMetadata: (ids, fallback) => {
        const resolved = this.resolveDirectPendingApprovalMetadata(ids);
        return resolved.length > 0 ? resolved : fallback;
      },
    }, options);
    if (!result) {
      this.directAutomationContinuations.delete(input.sessionId);
      return null;
    }
    if (result.metadata?.resumeAutomationAfterApprovals && trackedPendingApprovalIds.length > 0) {
      this.directAutomationContinuations.set(input.sessionId, {
        request: input,
        pendingApprovalIds: trackedPendingApprovalIds,
        expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
      });
    } else {
      this.directAutomationContinuations.delete(input.sessionId);
    }
    return result;
  }

  private resolveDirectPendingApprovalMetadata(ids: string[]): AutomationPendingApprovalMetadata[] {
    const summaries = this.tools.getApprovalSummaries(ids);
    return ids.map((id) => {
      const summary = summaries.get(id);
      return {
        id,
        toolName: summary?.toolName ?? 'unknown',
        argsPreview: summary?.argsPreview ?? '',
      };
    });
  }

  private getDirectPendingApprovalIds(sessionId: string, nowMs: number = Date.now()): string[] {
    const pending = this.directPendingApprovals.get(sessionId);
    if (!pending) return [];
    if (pending.expiresAt <= nowMs) {
      this.directPendingApprovals.delete(sessionId);
      return [];
    }
    return [...pending.ids];
  }

  private consumeDirectPendingApprovals(sessionId: string, consumedIds: string[]): void {
    const pending = this.directPendingApprovals.get(sessionId);
    if (!pending) return;
    const remaining = pending.ids.filter((id) => !consumedIds.includes(id));
    if (remaining.length === 0) {
      this.directPendingApprovals.delete(sessionId);
      return;
    }
    this.directPendingApprovals.set(sessionId, {
      ids: remaining,
      expiresAt: pending.expiresAt,
    });
  }

  private getDirectAutomationContinuation(
    sessionId: string,
    nowMs: number = Date.now(),
  ): DirectAutomationContinuation | null {
    const continuation = this.directAutomationContinuations.get(sessionId);
    if (!continuation) return null;
    if (continuation.expiresAt <= nowMs) {
      this.directAutomationContinuations.delete(sessionId);
      return null;
    }
    return continuation;
  }

  hasAutomationApprovalContinuation(approvalId: string): boolean {
    const normalizedId = approvalId.trim();
    if (!normalizedId) return false;
    for (const continuation of this.directAutomationContinuations.values()) {
      if (continuation.pendingApprovalIds.includes(normalizedId)) {
        return true;
      }
    }
    return false;
  }

  hasSuspendedApproval(approvalId: string): boolean {
    return !!this.getWorkerSuspendedApprovalState(approvalId);
  }

  async continueAfterApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    resultMessage?: string,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const normalizedId = approvalId.trim();
    if (!normalizedId) return null;
    const workerContinuation = await this.continueWorkerAfterApproval(normalizedId, decision, resultMessage);
    if (workerContinuation) return workerContinuation;
    for (const [sessionId, continuation] of this.directAutomationContinuations.entries()) {
      if (!continuation.pendingApprovalIds.includes(normalizedId)) continue;
      if (decision !== 'approved') {
        this.directAutomationContinuations.delete(sessionId);
        return null;
      }
      const stillPending = continuation.pendingApprovalIds.filter((id) => id !== normalizedId);
      if (stillPending.length > 0) {
        this.directAutomationContinuations.set(sessionId, {
          ...continuation,
          pendingApprovalIds: stillPending,
        });
        return null;
      }
      this.directAutomationContinuations.delete(sessionId);
      return this.tryDirectAutomationAuthoring(continuation.request);
    }

    if (decision === 'approved') {
      for (const [sessionId, continuation] of this.directAutomationContinuations.entries()) {
        const livePendingIds = new Set(this.tools.listPendingApprovalIdsForUser?.(
          continuation.request.userId,
          continuation.request.message.channel,
          {
            includeUnscoped: continuation.request.message.channel === 'web',
            principalId: continuation.request.message.principalId ?? continuation.request.userId,
          },
        ) ?? []);
        const stillPending = continuation.pendingApprovalIds.filter((id) => livePendingIds.has(id));
        if (stillPending.length === 0) {
          this.directAutomationContinuations.delete(sessionId);
          return this.tryDirectAutomationAuthoring(continuation.request);
        }
        if (stillPending.length !== continuation.pendingApprovalIds.length) {
          this.directAutomationContinuations.set(sessionId, {
            ...continuation,
            pendingApprovalIds: stillPending,
          });
        }
      }
    }
    return null;
  }

  private async getOrSpawnWorker(
    sessionId: string,
    agentId: string,
    userId: string,
    grantedCapabilities: string[],
  ): Promise<WorkerProcess> {
    const existingId = this.sessionToWorker.get(sessionId);
    if (existingId) {
      const existing = this.workers.get(existingId);
      if (existing && existing.status === 'ready') {
        this.refreshWorkerCapabilityToken(existing, agentId, userId, grantedCapabilities);
        existing.agentId = agentId;
        existing.authorizedBy = userId;
        existing.grantedCapabilities = [...grantedCapabilities];
        existing.lastActivityMs = Date.now();
        return existing;
      }
    }

    const workerId = randomUUID();
    const workspacePath = join(tmpdir(), `ga-worker-${workerId}`);
    mkdirSync(join(workspacePath, 'tmp'), { recursive: true });

    const token = this.tokenManager.mint({
      workerId,
      sessionId,
      agentId,
      authorizedBy: userId,
      grantedCapabilities,
      maxToolCalls: this.config.capabilityTokenMaxToolCalls,
    });

    const launch = resolveWorkerLaunch(this.config.workerEntryPoint);
    const sandboxHealth = await detectSandboxHealth(this.sandboxConfig);
    // LLM calls are proxied through the broker RPC, so the worker does not need network access.
    // On strong hosts, use the strict agent-worker profile. On degraded hosts, fall back to
    // workspace-write (NOT full-access) — the worker should never have unmediated system access.
    const workerProfile = sandboxHealth.availability === 'strong'
      ? 'agent-worker' as const
      : 'workspace-write' as const;
    // Workers are full Node.js processes that need more memory than short-lived tool subprocesses.
    // On strong sandbox backends we keep a generous floor for V8. On degraded ulimit-only hosts,
    // a virtual-memory cap is not reliable for long-lived Node workers and can prevent startup.
    const workerMemoryMb = sandboxHealth.availability === 'strong'
      ? Math.max(this.config.workerMaxMemoryMb, 2048)
      : 0;
    const workerSandboxConfig = {
      ...this.sandboxConfig,
      resourceLimits: {
        ...this.sandboxConfig.resourceLimits,
        maxMemoryMb: workerMemoryMb,
        maxCpuSeconds: 0, // Workers are long-lived — no CPU time limit
      },
    };
    const child = await sandboxedSpawn(
      launch.command,
      launch.args,
      workerSandboxConfig,
      {
        profile: workerProfile,
        networkAccess: false,
        cwd: workspacePath,
        env: {
          CAPABILITY_TOKEN: token.id,
          NODE_ENV: process.env.NODE_ENV ?? 'production',
        },
      },
    );

    if (!child.stdin || !child.stdout) {
      throw new Error('Worker process streams are not available');
    }

    let readyResolve: (() => void) | undefined;
    let readyReject: ((error: Error) => void) | undefined;
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const brokerServer = new BrokerServer({
      tools: this.tools,
      runtime: this.runtime,
      tokenManager: this.tokenManager,
      inputStream: child.stdout,
      outputStream: child.stdin,
      workerId,
      onNotification: (notification) => {
        const worker = this.workers.get(workerId);
        if (!worker) return;

        if (notification.method === 'worker.ready') {
          worker.status = 'ready';
          readyResolve?.();
          return;
        }

        if (notification.method === 'message.response') {
          worker.pendingMessageResolve?.({
            content: String(notification.params.content ?? ''),
            metadata: isRecord(notification.params.metadata) ? notification.params.metadata : undefined,
          });
          worker.pendingMessageResolve = undefined;
          worker.pendingMessageReject = undefined;
          return;
        }
      },
    });

    const worker: WorkerProcess = {
      id: workerId,
      sessionId,
      agentId,
      authorizedBy: userId,
      grantedCapabilities: [...grantedCapabilities],
      process: child,
      brokerServer,
      workspacePath,
      lastActivityMs: Date.now(),
      status: 'starting',
    };

    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const trimmed = text.trim();
      if (trimmed) {
        log.warn({ workerId, stderr: trimmed }, 'Worker stderr');
      }
    });

    child.on('error', (error) => {
      readyReject?.(error instanceof Error ? error : new Error(String(error)));
      this.handleWorkerCrash(workerId, error instanceof Error ? error : new Error(String(error)));
    });

    child.on('exit', (code, signal) => {
      if (worker.status !== 'shutting_down') {
        const detail = new Error(`Worker exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
        readyReject?.(detail);
        this.handleWorkerCrash(workerId, detail);
      } else {
        this.cleanupWorker(worker);
      }
    });

    this.workers.set(workerId, worker);
    this.sessionToWorker.set(sessionId, workerId);

    brokerServer.sendNotification('worker.initialize', {
      agentId,
      sessionId,
      alwaysLoadedTools: this.tools.listAlwaysLoadedDefinitions(),
    });

    await Promise.race([
      readyPromise,
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('Worker initialization timed out')), 15_000);
      }),
    ]);

    return worker;
  }

  private refreshWorkerCapabilityToken(
    worker: WorkerProcess,
    agentId: string,
    userId: string,
    grantedCapabilities: string[],
  ): void {
    this.tokenManager.revokeForWorker(worker.id);
    const token = this.tokenManager.mint({
      workerId: worker.id,
      sessionId: worker.sessionId,
      agentId,
      authorizedBy: userId,
      grantedCapabilities,
      maxToolCalls: this.config.capabilityTokenMaxToolCalls,
    });
    worker.brokerServer.sendNotification('capability.refreshed', {
      capabilityToken: token.id,
      agentId,
      sessionId: worker.sessionId,
    });
  }

  private dispatchToWorker(
    worker: WorkerProcess,
    params: {
      message: UserMessage;
      systemPrompt: string;
      history: Array<{ role: 'user' | 'assistant'; content: string }>;
      knowledgeBase: string;
      activeSkills: ResolvedSkill[];
      toolContext: string;
      runtimeNotices: Array<{ level: 'info' | 'warn'; message: string }>;
      hasFallbackProvider?: boolean;
    },
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    worker.lastActivityMs = Date.now();

    return new Promise((resolve, reject) => {
      worker.pendingMessageResolve = resolve;
      worker.pendingMessageReject = reject;

      const timeout = setTimeout(() => {
        if (worker.pendingMessageReject) {
          worker.pendingMessageReject(new Error('Worker message dispatch timed out'));
          worker.pendingMessageResolve = undefined;
          worker.pendingMessageReject = undefined;
        }
      }, 120_000);

      const wrappedResolve = (value: { content: string; metadata?: Record<string, unknown> }) => {
        clearTimeout(timeout);
        this.syncWorkerSuspendedApprovals(worker, params.message, value.metadata);
        resolve(value);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };

      worker.pendingMessageResolve = wrappedResolve;
      worker.pendingMessageReject = wrappedReject;

      worker.brokerServer.sendNotification('message.handle', {
        ...params,
      });
    });
  }

  private reapIdleWorkers(): void {
    const now = Date.now();
    for (const worker of this.workers.values()) {
      if (now - worker.lastActivityMs <= this.config.workerIdleTimeoutMs) continue;
      worker.status = 'shutting_down';
      worker.brokerServer.sendNotification('worker.shutdown', {
        reason: 'idle_timeout',
        gracePeriodMs: this.config.workerShutdownGracePeriodMs,
      });
      setTimeout(() => {
        const current = this.workers.get(worker.id);
        if (!current) return;
        this.safeKillWorker(current);
        this.cleanupWorker(current);
      }, this.config.workerShutdownGracePeriodMs);
    }
  }

  private handleWorkerCrash(workerId: string, error: Error): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    this.runtime.auditLog.record({
      type: 'worker_crash',
      severity: 'warn',
      agentId: worker.agentId,
      details: {
        workerId,
        reason: error.message,
      },
    });

    worker.pendingMessageReject?.(error);
    worker.pendingMessageResolve = undefined;
    worker.pendingMessageReject = undefined;
    this.cleanupWorker(worker);
  }

  private cleanupWorker(worker: WorkerProcess): void {
    this.clearWorkerSuspendedApprovals(worker.sessionId);
    this.tokenManager.revokeForWorker(worker.id);
    this.workers.delete(worker.id);
    if (this.sessionToWorker.get(worker.sessionId) === worker.id) {
      this.sessionToWorker.delete(worker.sessionId);
    }
    if (!existsSync(worker.workspacePath)) {
      return;
    }
    try {
      this.removeWorkspacePath(worker.workspacePath);
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : undefined;
      log.warn(
        {
          workerId: worker.id,
          sessionId: worker.sessionId,
          workspacePath: worker.workspacePath,
          code,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to remove worker workspace during cleanup',
      );
    }
  }

  private removeWorkspacePath(workspacePath: string): void {
    rmSync(workspacePath, {
      recursive: true,
      force: true,
      maxRetries: WORKER_WORKSPACE_CLEANUP_MAX_RETRIES,
      retryDelay: WORKER_WORKSPACE_CLEANUP_RETRY_DELAY_MS,
    });
  }

  private safeKillWorker(worker: WorkerProcess): void {
    if (worker.process.killed) return;
    try {
      worker.process.kill('SIGKILL');
    } catch (error) {
      log.warn({ workerId: worker.id, error: error instanceof Error ? error.message : String(error) }, 'Failed to kill worker');
    }
  }

  private syncWorkerSuspendedApprovals(
    worker: WorkerProcess,
    message: UserMessage,
    metadata: Record<string, unknown> | undefined,
  ): void {
    const approvalIds = Array.isArray(metadata?.pendingApprovals)
      ? metadata.pendingApprovals
        .map((value) => isRecord(value) ? value.id : undefined)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    this.clearWorkerSuspendedApprovals(worker.sessionId);
    if (approvalIds.length === 0) return;
    this.setWorkerSuspendedApprovals({
      workerId: worker.id,
      sessionId: worker.sessionId,
      agentId: worker.agentId,
      userId: message.userId,
      principalId: message.principalId ?? message.userId,
      principalRole: message.principalRole ?? 'owner',
      channel: message.channel,
      approvalIds: [...new Set(approvalIds)],
      expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
    });
  }

  private setWorkerSuspendedApprovals(state: WorkerSuspendedApprovalState): void {
    this.workerSuspendedApprovalsBySession.set(state.sessionId, state);
    for (const approvalId of state.approvalIds) {
      this.workerSuspendedApprovalToSession.set(approvalId, state.sessionId);
    }
  }

  private clearWorkerSuspendedApprovals(sessionId: string): void {
    const existing = this.workerSuspendedApprovalsBySession.get(sessionId);
    if (!existing) return;
    for (const approvalId of existing.approvalIds) {
      this.workerSuspendedApprovalToSession.delete(approvalId);
    }
    this.workerSuspendedApprovalsBySession.delete(sessionId);
  }

  private getWorkerSuspendedApprovalState(
    approvalId: string,
    nowMs: number = Date.now(),
  ): WorkerSuspendedApprovalState | null {
    const sessionId = this.workerSuspendedApprovalToSession.get(approvalId.trim());
    if (!sessionId) return null;
    const state = this.workerSuspendedApprovalsBySession.get(sessionId);
    if (!state) {
      this.workerSuspendedApprovalToSession.delete(approvalId.trim());
      return null;
    }
    if (state.expiresAt <= nowMs) {
      this.clearWorkerSuspendedApprovals(sessionId);
      return null;
    }
    return state;
  }

  private async continueWorkerAfterApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    resultMessage?: string,
  ): Promise<{ content: string; metadata?: Record<string, unknown> } | null> {
    const state = this.getWorkerSuspendedApprovalState(approvalId);
    if (!state) return null;

    if (decision !== 'approved') {
      this.clearWorkerSuspendedApprovals(state.sessionId);
      return null;
    }

    const pendingIds = new Set(this.tools.listApprovals(500, 'pending').map((entry) => entry.id));
    const remaining = state.approvalIds.filter((id) => id !== approvalId && pendingIds.has(id));
    if (remaining.length > 0) {
      this.clearWorkerSuspendedApprovals(state.sessionId);
      this.setWorkerSuspendedApprovals({
        ...state,
        approvalIds: remaining,
        expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
      });
      return null;
    }

    const worker = this.workers.get(state.workerId);
    this.clearWorkerSuspendedApprovals(state.sessionId);
    if (!worker || worker.status !== 'ready') return null;

    return this.dispatchToWorker(worker, {
      message: {
        id: randomUUID(),
        userId: state.userId,
        principalId: state.principalId,
        principalRole: state.principalRole,
        channel: state.channel,
        content: `[User approved the pending tool action(s). Result: ${resultMessage?.trim() || 'Approved and executed.'}] Please continue with the current request only. Do not resume older unrelated pending tasks.`,
        timestamp: Date.now(),
      },
      systemPrompt: '',
      history: [],
      knowledgeBase: '',
      activeSkills: [],
      toolContext: '',
      runtimeNotices: [],
      hasFallbackProvider: !!this.runtime.getFallbackProviderConfig?.(worker.agentId),
    });
  }
}

function resolveWorkerLaunch(configuredEntryPoint?: string): { command: string; args: string[] } {
  const resolvedEntry = configuredEntryPoint?.trim()
    ? resolve(configuredEntryPoint)
    : resolveDefaultWorkerEntry();
  const extension = extname(resolvedEntry);
  if (extension === '.ts') {
    const tsxLoaderPath = resolve(workerManagerDir, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');
    return {
      command: process.execPath,
      args: ['--import', existsSync(tsxLoaderPath) ? tsxLoaderPath : 'tsx', resolvedEntry],
    };
  }
  return {
    command: process.execPath,
    args: [resolvedEntry],
  };
}

function resolveDefaultWorkerEntry(): string {
  if (workerManagerPath.endsWith('.ts')) {
    return resolve(workerManagerDir, '..', 'worker', 'worker-entry.ts');
  }
  return resolve(workerManagerDir, '..', 'worker', 'worker-entry.js');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
