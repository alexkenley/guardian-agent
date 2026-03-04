/**
 * Pure orchestration decisions — no side effects.
 *
 * Extracts session key derivation and priority selection
 * from AssistantOrchestrator for independent testing.
 */

import type { AssistantDispatchPriority } from './orchestrator.js';

/** Plan for dispatching a request (pure data, no promises or mutations). */
export interface DispatchPlan {
  sessionKey: string;
  requestId: string;
  priority: AssistantDispatchPriority;
  requestType: string;
  messagePreview: string | undefined;
}

const PRIORITY_SCORE: Record<AssistantDispatchPriority, number> = {
  high: 3,
  normal: 2,
  low: 1,
};

/**
 * Derive the session key from dispatch input fields.
 * Pure function.
 */
export function buildSessionKey(channel: string, userId: string, agentId: string): string {
  return `${channel}:${userId}:${agentId}`;
}

/**
 * Plan a dispatch: derive session key, request ID, priority, and preview.
 * Pure function — no mutations.
 */
export function planDispatch(
  input: { agentId: string; userId: string; channel: string; content: string; priority?: AssistantDispatchPriority; requestType?: string },
  now: number,
  requestCounter: number,
  previewChars: number,
): DispatchPlan {
  const priority = input.priority ?? 'normal';
  const requestType = input.requestType?.trim() || 'message';
  const requestId = `req-${now}-${requestCounter}`;
  const messagePreview = truncatePreview(input.content, previewChars);

  return {
    sessionKey: buildSessionKey(input.channel, input.userId, input.agentId),
    requestId,
    priority,
    requestType,
    messagePreview,
  };
}

/**
 * Select the index of the highest-priority, earliest-enqueued item.
 * Pure function.
 */
export function selectNextPending<T extends { order: number; priority: AssistantDispatchPriority }>(
  queue: readonly T[],
): number {
  if (queue.length === 0) return -1;

  let bestIndex = 0;
  let bestPriority = PRIORITY_SCORE[queue[0].priority];
  let bestOrder = queue[0].order;

  for (let i = 1; i < queue.length; i++) {
    const item = queue[i];
    const priority = PRIORITY_SCORE[item.priority];
    if (priority > bestPriority || (priority === bestPriority && item.order < bestOrder)) {
      bestIndex = i;
      bestPriority = priority;
      bestOrder = item.order;
    }
  }

  return bestIndex;
}

function truncatePreview(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}
