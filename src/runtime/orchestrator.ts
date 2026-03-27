/**
 * AssistantOrchestrator
 *
 * Serializes requests per assistant session (channel + user + agent),
 * while allowing different sessions to run in parallel.
 *
 * Includes:
 * - per-session priority queues (high > normal > low)
 * - request-level traces with sub-step timing
 */

export type AssistantDispatchPriority = 'high' | 'normal' | 'low';

export interface AssistantDispatchInput {
  requestId?: string;
  agentId: string;
  userId: string;
  channel: string;
  content: string;
  priority?: AssistantDispatchPriority;
  requestType?: string;
}

export type AssistantSessionStatus = 'idle' | 'queued' | 'running';

export interface AssistantSessionState {
  sessionId: string;
  agentId: string;
  userId: string;
  channel: string;
  status: AssistantSessionStatus;
  queueDepth: number;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  avgExecutionMs: number;
  avgEndToEndMs: number;
  lastQueuedAt?: number;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  lastQueueWaitMs?: number;
  lastExecutionMs?: number;
  lastEndToEndMs?: number;
  lastError?: string;
  lastMessagePreview?: string;
  lastResponsePreview?: string;
  lastPriority?: AssistantDispatchPriority;
}

export type AssistantTraceStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type AssistantTraceStepStatus = 'running' | 'succeeded' | 'failed';

export interface AssistantTraceStep {
  name: string;
  status: AssistantTraceStepStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  detail?: string;
  error?: string;
}

export interface WorkflowTraceNode {
  id: string;
  parentId?: string;
  kind: 'agent_dispatch' | 'tool_call' | 'approval' | 'provider_call' | 'compile' | 'validate' | 'resume' | 'handoff' | 'verification';
  name: string;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'succeeded' | 'failed' | 'blocked';
  metadata?: Record<string, unknown>;
}

export interface AssistantDispatchTrace {
  requestId: string;
  runId: string;
  groupId: string;
  parentRunId?: string;
  sessionId: string;
  agentId: string;
  userId: string;
  channel: string;
  requestType: string;
  priority: AssistantDispatchPriority;
  status: AssistantTraceStatus;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
  queueWaitMs?: number;
  executionMs?: number;
  endToEndMs?: number;
  messagePreview?: string;
  responsePreview?: string;
  error?: string;
  steps: AssistantTraceStep[];
  nodes: WorkflowTraceNode[];
}

export interface AssistantOrchestratorSummary {
  startedAt: number;
  uptimeMs: number;
  sessionCount: number;
  runningCount: number;
  queuedCount: number;
  totalRequests: number;
  completedRequests: number;
  failedRequests: number;
  avgExecutionMs: number;
  avgEndToEndMs: number;
  queuedByPriority: {
    high: number;
    normal: number;
    low: number;
  };
}

export interface AssistantOrchestratorState {
  summary: AssistantOrchestratorSummary;
  sessions: AssistantSessionState[];
  traces: AssistantDispatchTrace[];
}

export interface AssistantDispatchContext {
  requestId: string;
  sessionId: string;
  priority: AssistantDispatchPriority;
  requestType: string;
  runStep<T>(name: string, run: () => Promise<T> | T, detail?: string): Promise<T>;
  markStep(name: string, detail?: string): void;
  addNode(node: Omit<WorkflowTraceNode, 'id'> & { id?: string }): void;
}

export interface AssistantOrchestratorOptions {
  previewChars?: number;
  maxTrackedSessions?: number;
  idleSessionTtlMs?: number;
  maxTrackedTraces?: number;
}

export type AssistantOrchestratorListener = (trace: AssistantDispatchTrace) => void;

interface SessionRecord {
  sessionId: string;
  agentId: string;
  userId: string;
  channel: string;
  status: AssistantSessionStatus;
  queueDepth: number;
  running: boolean;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  totalExecutionMs: number;
  totalEndToEndMs: number;
  lastQueuedAt?: number;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  lastQueueWaitMs?: number;
  lastExecutionMs?: number;
  lastEndToEndMs?: number;
  lastError?: string;
  lastMessagePreview?: string;
  lastResponsePreview?: string;
  lastPriority?: AssistantDispatchPriority;
  processing: boolean;
  queue: PendingRequest[];
}

interface PendingRequest {
  requestId: string;
  order: number;
  enqueuedAt: number;
  input: AssistantDispatchInput;
  trace: AssistantDispatchTrace;
  handler: (ctx: AssistantDispatchContext) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const DEFAULT_PREVIEW_CHARS = 180;
const DEFAULT_MAX_TRACKED_SESSIONS = 1_000;
const DEFAULT_IDLE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TRACKED_TRACES = 500;

const PRIORITY_SCORE: Record<AssistantDispatchPriority, number> = {
  high: 3,
  normal: 2,
  low: 1,
};

let nextRequestId = 1;
function createRequestId(now: number): string {
  return `req-${now}-${nextRequestId++}`;
}

export class AssistantOrchestrator {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly traces: AssistantDispatchTrace[] = [];
  private readonly listeners = new Set<AssistantOrchestratorListener>();
  private readonly startedAt = Date.now();
  private readonly previewChars: number;
  private readonly maxTrackedSessions: number;
  private readonly idleSessionTtlMs: number;
  private readonly maxTrackedTraces: number;

  private totalRequests = 0;
  private completedRequests = 0;
  private failedRequests = 0;
  private enqueueOrder = 0;

  constructor(options: AssistantOrchestratorOptions = {}) {
    this.previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
    this.maxTrackedSessions = options.maxTrackedSessions ?? DEFAULT_MAX_TRACKED_SESSIONS;
    this.idleSessionTtlMs = options.idleSessionTtlMs ?? DEFAULT_IDLE_SESSION_TTL_MS;
    this.maxTrackedTraces = options.maxTrackedTraces ?? DEFAULT_MAX_TRACKED_TRACES;
  }

  async dispatch<T>(input: AssistantDispatchInput, handler: (ctx: AssistantDispatchContext) => Promise<T>): Promise<T> {
    const session = this.getOrCreateSession(input);
    const now = Date.now();
    const priority = input.priority ?? 'normal';
    const requestType = input.requestType?.trim() || 'message';
    const requestId = input.requestId?.trim() || createRequestId(now);
    const messagePreview = this.preview(input.content);

    session.queueDepth += 1;
    session.lastQueuedAt = now;
    session.lastMessagePreview = messagePreview;
    session.lastPriority = priority;
    if (!session.running) {
      session.status = 'queued';
    }
    session.totalRequests += 1;
    this.totalRequests += 1;

    const trace: AssistantDispatchTrace = {
      requestId,
      runId: requestId,
      groupId: session.sessionId,
      sessionId: session.sessionId,
      agentId: input.agentId,
      userId: input.userId,
      channel: input.channel,
      requestType,
      priority,
      status: 'queued',
      queuedAt: now,
      messagePreview,
      steps: [],
      nodes: [],
    };
    this.traces.unshift(trace);
    this.enforceTraceLimit();
    this.emitTrace(trace);

    const promise = new Promise<T>((resolve, reject) => {
      session.queue.push({
        requestId,
        order: ++this.enqueueOrder,
        enqueuedAt: now,
        input: {
          ...input,
          priority,
          requestType,
        },
        trace,
        handler: handler as unknown as (ctx: AssistantDispatchContext) => Promise<unknown>,
        resolve: resolve as unknown as (value: unknown) => void,
        reject,
      });
    });

    this.drainSession(session);
    this.pruneSessions();
    return promise;
  }

  subscribe(listener: AssistantOrchestratorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): AssistantOrchestratorState {
    this.pruneSessions();

    let runningCount = 0;
    let queuedCount = 0;
    let totalExecutionMs = 0;
    let totalEndToEndMs = 0;
    let totalFinishedCount = 0;
    const queuedByPriority = { high: 0, normal: 0, low: 0 };

    const sessions = [...this.sessions.values()]
      .map((session) => {
        if (session.running) runningCount += 1;
        if (session.queueDepth > 0) queuedCount += session.queueDepth;
        for (const pending of session.queue) {
          const priority = pending.input.priority ?? 'normal';
          queuedByPriority[priority] += 1;
        }

        const finishedCount = session.successCount + session.errorCount;
        totalExecutionMs += session.totalExecutionMs;
        totalEndToEndMs += session.totalEndToEndMs;
        totalFinishedCount += finishedCount;

        return this.toSnapshot(session);
      })
      .sort((a, b) => {
        const aTs = a.lastStartedAt ?? a.lastQueuedAt ?? 0;
        const bTs = b.lastStartedAt ?? b.lastQueuedAt ?? 0;
        return bTs - aTs;
      });

    const summary: AssistantOrchestratorSummary = {
      startedAt: this.startedAt,
      uptimeMs: Math.max(0, Date.now() - this.startedAt),
      sessionCount: sessions.length,
      runningCount,
      queuedCount,
      totalRequests: this.totalRequests,
      completedRequests: this.completedRequests,
      failedRequests: this.failedRequests,
      avgExecutionMs: totalFinishedCount > 0 ? Math.round(totalExecutionMs / totalFinishedCount) : 0,
      avgEndToEndMs: totalFinishedCount > 0 ? Math.round(totalEndToEndMs / totalFinishedCount) : 0,
      queuedByPriority,
    };

    return {
      summary,
      sessions,
      traces: this.traces.slice(0, 100),
    };
  }

  addTraceNode(requestId: string, node: Omit<WorkflowTraceNode, 'id'> & { id?: string }): void {
    const trace = this.traces.find(t => t.requestId === requestId);
    if (trace) {
      trace.nodes.push({
        ...node,
        id: node.id ?? `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      });
      this.emitTrace(trace);
    }
  }

  private getOrCreateSession(input: AssistantDispatchInput): SessionRecord {
    const key = this.buildSessionId(input);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const created: SessionRecord = {
      sessionId: key,
      agentId: input.agentId,
      userId: input.userId,
      channel: input.channel,
      status: 'idle',
      queueDepth: 0,
      running: false,
      totalRequests: 0,
      successCount: 0,
      errorCount: 0,
      totalExecutionMs: 0,
      totalEndToEndMs: 0,
      processing: false,
      queue: [],
    };

    this.sessions.set(key, created);
    return created;
  }

  private buildSessionId(input: AssistantDispatchInput): string {
    return `${input.channel}:${input.userId}:${input.agentId}`;
  }

  private toSnapshot(session: SessionRecord): AssistantSessionState {
    const finishedCount = session.successCount + session.errorCount;
    return {
      sessionId: session.sessionId,
      agentId: session.agentId,
      userId: session.userId,
      channel: session.channel,
      status: session.status,
      queueDepth: session.queueDepth,
      totalRequests: session.totalRequests,
      successCount: session.successCount,
      errorCount: session.errorCount,
      avgExecutionMs: finishedCount > 0 ? Math.round(session.totalExecutionMs / finishedCount) : 0,
      avgEndToEndMs: finishedCount > 0 ? Math.round(session.totalEndToEndMs / finishedCount) : 0,
      lastQueuedAt: session.lastQueuedAt,
      lastStartedAt: session.lastStartedAt,
      lastCompletedAt: session.lastCompletedAt,
      lastQueueWaitMs: session.lastQueueWaitMs,
      lastExecutionMs: session.lastExecutionMs,
      lastEndToEndMs: session.lastEndToEndMs,
      lastError: session.lastError,
      lastMessagePreview: session.lastMessagePreview,
      lastResponsePreview: session.lastResponsePreview,
      lastPriority: session.lastPriority,
    };
  }

  private pruneSessions(): void {
    if (this.sessions.size === 0) return;

    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      const active = session.running || session.queueDepth > 0 || session.processing;
      if (active) continue;
      const lastTouched = session.lastCompletedAt ?? session.lastQueuedAt ?? 0;
      if (lastTouched > 0 && now - lastTouched > this.idleSessionTtlMs) {
        this.sessions.delete(sessionId);
      }
    }

    if (this.sessions.size <= this.maxTrackedSessions) return;

    const idle = [...this.sessions.values()]
      .filter((session) => !session.running && session.queueDepth === 0)
      .sort((a, b) => {
        const aTs = a.lastCompletedAt ?? a.lastQueuedAt ?? 0;
        const bTs = b.lastCompletedAt ?? b.lastQueuedAt ?? 0;
        return aTs - bTs;
      });

    for (const session of idle) {
      if (this.sessions.size <= this.maxTrackedSessions) break;
      this.sessions.delete(session.sessionId);
    }
  }

  private preview(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed.length <= this.previewChars) return trimmed;
    return `${trimmed.slice(0, this.previewChars - 1)}…`;
  }

  private extractResponseContent(result: unknown): string | undefined {
    if (typeof result === 'string') return result;
    if (!result || typeof result !== 'object') return undefined;
    const content = (result as { content?: unknown }).content;
    return typeof content === 'string' ? content : undefined;
  }

  private enforceTraceLimit(): void {
    if (this.traces.length <= this.maxTrackedTraces) return;
    this.traces.splice(this.maxTrackedTraces);
  }

  private drainSession(session: SessionRecord): void {
    if (session.processing) return;
    session.processing = true;

    void (async () => {
      while (session.queue.length > 0) {
        const nextIndex = this.selectNextPendingIndex(session.queue);
        const pending = session.queue.splice(nextIndex, 1)[0];
        session.queueDepth = session.queue.length;
        await this.runPendingRequest(session, pending);
      }
    })()
      .catch(() => {
        // Individual request failures are handled in runPendingRequest.
      })
      .finally(() => {
        session.processing = false;
        session.running = false;
        session.status = session.queueDepth > 0 ? 'queued' : 'idle';
        if (session.queue.length > 0) {
          this.drainSession(session);
        }
      });
  }

  private selectNextPendingIndex(queue: PendingRequest[]): number {
    let bestIndex = 0;
    let bestPriority = PRIORITY_SCORE[(queue[0].input.priority ?? 'normal')];
    let bestOrder = queue[0].order;

    for (let i = 1; i < queue.length; i++) {
      const item = queue[i];
      const priority = PRIORITY_SCORE[(item.input.priority ?? 'normal')];
      if (priority > bestPriority || (priority === bestPriority && item.order < bestOrder)) {
        bestIndex = i;
        bestPriority = priority;
        bestOrder = item.order;
      }
    }

    return bestIndex;
  }

  private async runPendingRequest(session: SessionRecord, pending: PendingRequest): Promise<void> {
    const startedAt = Date.now();
    const queueWaitMs = Math.max(0, startedAt - pending.enqueuedAt);
    const trace = pending.trace;

    session.running = true;
    session.status = 'running';
    session.lastStartedAt = startedAt;
    session.lastQueueWaitMs = queueWaitMs;
    session.lastPriority = pending.input.priority ?? 'normal';

    trace.status = 'running';
    trace.startedAt = startedAt;
    trace.queueWaitMs = queueWaitMs;
    trace.steps.push({
      name: 'queue_wait',
      status: 'succeeded',
      startedAt: pending.enqueuedAt,
      completedAt: startedAt,
      durationMs: queueWaitMs,
      detail: `${queueWaitMs}ms`,
    });
    this.emitTrace(trace);

    const dispatchContext: AssistantDispatchContext = {
      requestId: pending.requestId,
      sessionId: session.sessionId,
      priority: pending.input.priority ?? 'normal',
      requestType: pending.input.requestType ?? 'message',
      runStep: async <T>(name: string, run: () => Promise<T> | T, detail?: string): Promise<T> => {
        const stepStartedAt = Date.now();
        const step: AssistantTraceStep = {
          name,
          status: 'running',
          startedAt: stepStartedAt,
          detail,
        };
        trace.steps.push(step);
        this.emitTrace(trace);

        try {
          const value = await run();
          const completedAt = Date.now();
          step.status = 'succeeded';
          step.completedAt = completedAt;
          step.durationMs = Math.max(0, completedAt - stepStartedAt);
          this.emitTrace(trace);
          return value;
        } catch (err) {
          const completedAt = Date.now();
          step.status = 'failed';
          step.completedAt = completedAt;
          step.durationMs = Math.max(0, completedAt - stepStartedAt);
          step.error = err instanceof Error ? err.message : String(err);
          this.emitTrace(trace);
          throw err;
        }
      },
      markStep: (name: string, detail?: string): void => {
        const ts = Date.now();
        trace.steps.push({
          name,
          status: 'succeeded',
          startedAt: ts,
          completedAt: ts,
          durationMs: 0,
          detail,
        });
        this.emitTrace(trace);
      },
      addNode: (node) => {
        trace.nodes.push({
          ...node,
          id: node.id ?? `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        });
        this.emitTrace(trace);
      },
    };

    try {
      const result = await dispatchContext.runStep(
        'handler',
        () => pending.handler(dispatchContext),
        pending.input.requestType ?? 'message',
      );
      const completedAt = Date.now();
      const executionMs = Math.max(0, completedAt - startedAt);
      const endToEndMs = Math.max(0, completedAt - pending.enqueuedAt);
      const responsePreview = this.preview(this.extractResponseContent(result));

      session.successCount += 1;
      session.totalExecutionMs += executionMs;
      session.totalEndToEndMs += endToEndMs;
      session.lastExecutionMs = executionMs;
      session.lastEndToEndMs = endToEndMs;
      session.lastCompletedAt = completedAt;
      session.lastError = undefined;
      session.lastResponsePreview = responsePreview;

      trace.status = 'succeeded';
      trace.completedAt = completedAt;
      trace.executionMs = executionMs;
      trace.endToEndMs = endToEndMs;
      trace.responsePreview = responsePreview;
      this.emitTrace(trace);

      this.completedRequests += 1;
      pending.resolve(result);
    } catch (err) {
      const completedAt = Date.now();
      const executionMs = Math.max(0, completedAt - startedAt);
      const endToEndMs = Math.max(0, completedAt - pending.enqueuedAt);
      const errorText = err instanceof Error ? err.message : String(err);

      session.errorCount += 1;
      session.totalExecutionMs += executionMs;
      session.totalEndToEndMs += endToEndMs;
      session.lastExecutionMs = executionMs;
      session.lastEndToEndMs = endToEndMs;
      session.lastCompletedAt = completedAt;
      session.lastError = errorText;

      trace.status = 'failed';
      trace.completedAt = completedAt;
      trace.executionMs = executionMs;
      trace.endToEndMs = endToEndMs;
      trace.error = errorText;
      this.emitTrace(trace);

      this.failedRequests += 1;
      pending.reject(err);
    } finally {
      session.running = false;
      session.status = session.queueDepth > 0 ? 'queued' : 'idle';
      this.pruneSessions();
    }
  }

  private emitTrace(trace: AssistantDispatchTrace): void {
    const snapshot: AssistantDispatchTrace = {
      ...trace,
      steps: trace.steps.map((step) => ({ ...step })),
      nodes: trace.nodes.map((node) => ({
        ...node,
        metadata: node.metadata ? { ...node.metadata } : undefined,
      })),
    };
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
