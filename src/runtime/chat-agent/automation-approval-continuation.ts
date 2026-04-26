import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { ToolExecutor } from '../../tools/executor.js';
import { PENDING_APPROVAL_TTL_MS } from './orchestration-state.js';

export interface AutomationApprovalContinuation {
  originalMessage: UserMessage;
  ctx: AgentContext;
  pendingApprovalIds: string[];
  expiresAt: number;
}

export interface AutomationApprovalContinuationStore {
  get(userKey: string, nowMs?: number): AutomationApprovalContinuation | null;
  set(
    userKey: string,
    originalMessage: UserMessage,
    ctx: AgentContext,
    pendingApprovalIds: string[],
    expiresAt?: number,
  ): void;
  clear(userKey: string): void;
  hasApprovalId(approvalId: string): boolean;
  findByApprovalId(approvalId: string): { userKey: string; continuation: AutomationApprovalContinuation } | null;
}

export interface AutomationApprovalContinuationResponse {
  content: string;
  metadata?: Record<string, unknown>;
}

export type RunAutomationAfterApproval = (
  message: UserMessage,
  ctx: AgentContext,
  userKey: string,
  options?: {
    allowRemediation?: boolean;
    assumeAuthoring?: boolean;
  },
) => Promise<AutomationApprovalContinuationResponse | null>;

export class InMemoryAutomationApprovalContinuationStore implements AutomationApprovalContinuationStore {
  private readonly continuations = new Map<string, AutomationApprovalContinuation>();

  get(userKey: string, nowMs: number = Date.now()): AutomationApprovalContinuation | null {
    const state = this.continuations.get(userKey);
    if (!state) return null;
    if (state.expiresAt <= nowMs) {
      this.continuations.delete(userKey);
      return null;
    }
    return state;
  }

  set(
    userKey: string,
    originalMessage: UserMessage,
    ctx: AgentContext,
    pendingApprovalIds: string[],
    expiresAt: number = Date.now() + PENDING_APPROVAL_TTL_MS,
  ): void {
    const uniqueIds = [...new Set(pendingApprovalIds.filter((id) => id.trim().length > 0))];
    if (uniqueIds.length === 0) {
      this.continuations.delete(userKey);
      return;
    }
    this.continuations.set(userKey, {
      originalMessage,
      ctx,
      pendingApprovalIds: uniqueIds,
      expiresAt,
    });
  }

  clear(userKey: string): void {
    this.continuations.delete(userKey);
  }

  hasApprovalId(approvalId: string): boolean {
    const normalizedId = approvalId.trim();
    if (!normalizedId) return false;
    for (const continuation of this.continuations.values()) {
      if (continuation.pendingApprovalIds.includes(normalizedId)) {
        return true;
      }
    }
    return false;
  }

  findByApprovalId(approvalId: string): { userKey: string; continuation: AutomationApprovalContinuation } | null {
    const normalizedId = approvalId.trim();
    if (!normalizedId) return null;
    for (const [userKey, continuation] of this.continuations.entries()) {
      if (continuation.pendingApprovalIds.includes(normalizedId)) {
        return { userKey, continuation };
      }
    }
    return null;
  }
}

export async function continueAutomationAfterApproval(input: {
  approvalId: string;
  decision: 'approved' | 'denied';
  continuations: AutomationApprovalContinuationStore;
  runAutomationAuthoring: RunAutomationAfterApproval;
}): Promise<AutomationApprovalContinuationResponse | null> {
  const approvalId = input.approvalId.trim();
  if (!approvalId) return null;
  const match = input.continuations.findByApprovalId(approvalId);
  if (!match) return null;
  const { userKey, continuation } = match;
  if (input.decision !== 'approved') {
    input.continuations.clear(userKey);
    return null;
  }
  const stillPending = continuation.pendingApprovalIds.filter((id) => id !== approvalId);
  if (stillPending.length > 0) {
    input.continuations.set(userKey, continuation.originalMessage, continuation.ctx, stillPending, continuation.expiresAt);
    return null;
  }
  input.continuations.clear(userKey);
  return input.runAutomationAuthoring(continuation.originalMessage, continuation.ctx, userKey, {
    assumeAuthoring: true,
  });
}

export async function resolveAutomationApprovalDecisionContinuation(input: {
  userKey: string;
  message: UserMessage;
  ctx: AgentContext;
  decision: 'approved' | 'denied';
  targetIds: string[];
  approvedIds: ReadonlySet<string>;
  failedIds: ReadonlySet<string>;
  continuations: AutomationApprovalContinuationStore;
  tools: Pick<ToolExecutor, 'listPendingApprovalIdsForUser'>;
  runAutomationAuthoring: RunAutomationAfterApproval;
}): Promise<AutomationApprovalContinuationResponse | null> {
  const retry = async (continuation: AutomationApprovalContinuation) => input.runAutomationAuthoring(
    continuation.originalMessage,
    input.ctx,
    input.userKey,
    { assumeAuthoring: true },
  );

  const continuation = input.continuations.get(input.userKey);
  if (continuation) {
    const affected = input.targetIds.filter((id) => continuation.pendingApprovalIds.includes(id));
    if (input.decision === 'approved' && affected.length > 0) {
      const stillPending = continuation.pendingApprovalIds.filter((id) => !input.approvedIds.has(id));
      if (stillPending.length === 0) {
        input.continuations.clear(input.userKey);
        const retryResult = await retry(continuation);
        if (retryResult) return retryResult;
      } else {
        input.continuations.set(
          input.userKey,
          continuation.originalMessage,
          continuation.ctx,
          stillPending,
          continuation.expiresAt,
        );
      }
    } else if (affected.length > 0 && (input.decision === 'denied' || affected.some((id) => input.failedIds.has(id)))) {
      input.continuations.clear(input.userKey);
    }
  }

  const fallbackContinuation = input.continuations.get(input.userKey);
  if (input.decision === 'approved' && fallbackContinuation && input.approvedIds.size > 0) {
    const livePendingIds = new Set(input.tools.listPendingApprovalIdsForUser(
      input.message.userId,
      input.message.channel,
      {
        includeUnscoped: input.message.channel === 'web',
        principalId: input.message.principalId ?? input.message.userId,
      },
    ));
    const stillPending = fallbackContinuation.pendingApprovalIds.filter((id) => livePendingIds.has(id));
    if (stillPending.length === 0) {
      input.continuations.clear(input.userKey);
      return retry(fallbackContinuation);
    }
    if (stillPending.length !== fallbackContinuation.pendingApprovalIds.length) {
      input.continuations.set(
        input.userKey,
        fallbackContinuation.originalMessage,
        fallbackContinuation.ctx,
        stillPending,
        fallbackContinuation.expiresAt,
      );
    }
  }

  return null;
}
