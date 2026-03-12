import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxedSpawn, detectSandboxHealth, type SandboxConfig, DEFAULT_SANDBOX_CONFIG } from '../sandbox/index.js';
import { createLogger } from '../util/logging.js';
import { BrokerServer } from '../broker/broker-server.js';
import { CapabilityTokenManager } from '../broker/capability-token.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { Runtime } from '../runtime/runtime.js';
import type { AgentIsolationConfig, LLMConfig } from '../config/types.js';
import type { UserMessage } from '../agent/types.js';
import type { ResolvedSkill } from '../skills/types.js';

const log = createLogger('worker-manager');

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
  process: ChildProcess;
  brokerServer: BrokerServer;
  workspacePath: string;
  lastActivityMs: number;
  status: 'starting' | 'ready' | 'error' | 'shutting_down';
  pendingMessageResolve?: (result: { content: string; metadata?: Record<string, unknown> }) => void;
  pendingMessageReject?: (error: Error) => void;
}

export class WorkerManager {
  private readonly workers = new Map<string, WorkerProcess>();
  private readonly sessionToWorker = new Map<string, string>();
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
    const worker = await this.getOrSpawnWorker(input.sessionId, input.agentId, input.userId, input.grantedCapabilities);
    const providerConfig = this.runtime.getAgentProviderConfig(input.agentId);
    if (!providerConfig) {
      throw new Error(`No provider configuration found for agent '${input.agentId}'`);
    }

    return this.dispatchToWorker(worker, {
      message: input.message,
      systemPrompt: input.systemPrompt,
      history: input.history,
      knowledgeBase: input.knowledgeBase ?? '',
      activeSkills: input.activeSkills ?? [],
      toolContext: input.toolContext ?? '',
      runtimeNotices: input.runtimeNotices ?? [],
      providerConfig,
    });
  }

  shutdown(): void {
    clearInterval(this.reapInterval);
    for (const worker of this.workers.values()) {
      this.safeKillWorker(worker);
      this.cleanupWorker(worker);
    }
    this.workers.clear();
    this.sessionToWorker.clear();
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
        existing.lastActivityMs = Date.now();
        return existing;
      }
    }

    const workerId = randomUUID();
    const workspacePath = join('/tmp', `ga-worker-${workerId}`);
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
    const child = await sandboxedSpawn(
      launch.command,
      launch.args,
      this.sandboxConfig,
      {
        profile: sandboxHealth.availability === 'strong' ? 'agent-worker' : 'full-access',
        networkAccess: true,
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
      providerConfig: LLMConfig;
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
    this.tokenManager.revokeForWorker(worker.id);
    this.workers.delete(worker.id);
    if (this.sessionToWorker.get(worker.sessionId) === worker.id) {
      this.sessionToWorker.delete(worker.sessionId);
    }
    rmSync(worker.workspacePath, { recursive: true, force: true });
  }

  private safeKillWorker(worker: WorkerProcess): void {
    if (worker.process.killed) return;
    try {
      worker.process.kill('SIGKILL');
    } catch (error) {
      log.warn({ workerId: worker.id, error: error instanceof Error ? error.message : String(error) }, 'Failed to kill worker');
    }
  }
}

function resolveWorkerLaunch(configuredEntryPoint?: string): { command: string; args: string[] } {
  const resolvedEntry = configuredEntryPoint?.trim()
    ? resolve(configuredEntryPoint)
    : resolveDefaultWorkerEntry();
  const extension = extname(resolvedEntry);
  if (extension === '.ts') {
    return {
      command: process.execPath,
      args: ['--import', 'tsx', resolvedEntry],
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
