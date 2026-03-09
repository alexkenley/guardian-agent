/**
 * Approval queue for tools that require explicit user confirmation.
 */

import { randomUUID } from 'node:crypto';
import type { ToolApprovalRequest, ToolJobRecord } from './types.js';

export class ToolApprovalStore {
  private readonly requests: ToolApprovalRequest[] = [];
  private readonly indexById = new Map<string, ToolApprovalRequest>();

  create(
    job: ToolJobRecord,
    args: Record<string, unknown>,
    argsHash: string | undefined,
    now: () => number = Date.now,
  ): ToolApprovalRequest {
    // Dedup: if an identical pending approval already exists (same tool + argsHash), return it
    if (argsHash) {
      const existing = this.requests.find(
        (r) => r.status === 'pending' && r.toolName === job.toolName && r.argsHash === argsHash,
      );
      if (existing) return existing;
    }

    const request: ToolApprovalRequest = {
      id: randomUUID(),
      jobId: job.id,
      toolName: job.toolName,
      risk: job.risk,
      origin: job.origin,
      argsHash,
      args,
      createdAt: now(),
      status: 'pending',
    };
    this.requests.unshift(request);
    this.indexById.set(request.id, request);
    return request;
  }

  list(limit = 50, status?: ToolApprovalRequest['status']): ToolApprovalRequest[] {
    const filtered = status
      ? this.requests.filter((request) => request.status === status)
      : this.requests;
    return filtered.slice(0, Math.max(1, limit));
  }

  get(id: string): ToolApprovalRequest | undefined {
    return this.indexById.get(id);
  }

  decide(
    id: string,
    decision: 'approved' | 'denied',
    decidedBy: string,
    reason: string | undefined,
    now: () => number = Date.now,
  ): ToolApprovalRequest | null {
    const request = this.indexById.get(id);
    if (!request) return null;
    if (request.status !== 'pending') return request;
    request.status = decision;
    request.decidedBy = decidedBy;
    request.decidedAt = now();
    if (reason?.trim()) request.reason = reason.trim();
    return request;
  }
}
