/**
 * Side-effectful orchestration operations.
 *
 * Handles session state mutation and drain triggering
 * after the pure planning phase.
 */

import type { DispatchPlan } from './workflows.js';
import type { AssistantDispatchPriority } from './orchestrator.js';

/** Minimal session record interface for applyDispatchPlan. */
export interface SessionMutationTarget {
  queueDepth: number;
  lastQueuedAt?: number;
  lastMessagePreview?: string;
  lastPriority?: AssistantDispatchPriority;
  running: boolean;
  status: 'idle' | 'queued' | 'running';
  totalRequests: number;
}

/**
 * Apply a dispatch plan to session state (mutates in place).
 */
export function applyDispatchPlan(plan: DispatchPlan, session: SessionMutationTarget): void {
  session.queueDepth += 1;
  session.lastQueuedAt = Date.now();
  session.lastMessagePreview = plan.messagePreview;
  session.lastPriority = plan.priority;
  if (!session.running) {
    session.status = 'queued';
  }
  session.totalRequests += 1;
}
