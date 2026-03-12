import { randomUUID } from 'node:crypto';
import type { CapabilityToken } from './types.js';

export interface TokenMintOptions {
  workerId: string;
  sessionId: string;
  agentId: string;
  authorizedBy: string;
  grantedCapabilities: readonly string[];
  allowedToolCategories?: string[];
  ttlMs?: number;
  maxToolCalls?: number;
}

export class CapabilityTokenManager {
  private tokens = new Map<string, CapabilityToken>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs: number = 600_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Mint a new capability token bound to a specific worker.
   */
  mint(options: TokenMintOptions, now: number = Date.now()): CapabilityToken {
    const ttl = options.ttlMs ?? this.defaultTtlMs;
    const token: CapabilityToken = {
      id: randomUUID(),
      workerId: options.workerId,
      sessionId: options.sessionId,
      agentId: options.agentId,
      authorizedBy: options.authorizedBy,
      grantedCapabilities: [...options.grantedCapabilities],
      allowedToolCategories: options.allowedToolCategories ? [...options.allowedToolCategories] : undefined,
      issuedAt: now,
      expiresAt: now + ttl,
      maxToolCalls: options.maxToolCalls && options.maxToolCalls > 0 ? options.maxToolCalls : undefined,
      usedToolCalls: 0,
    };
    
    this.tokens.set(token.id, token);
    return token;
  }

  /**
   * Get a token if it exists and is valid.
   */
  get(tokenId: string): CapabilityToken | undefined {
    return this.tokens.get(tokenId);
  }

  /**
   * Validate a token for a given worker and increment its usage.
   * Returns an error message if invalid, or null if valid.
   */
  validateAndUse(tokenId: string, workerId: string, now: number = Date.now()): string | null {
    const token = this.tokens.get(tokenId);
    if (!token) {
      return 'Invalid capability token';
    }

    if (token.workerId !== workerId) {
      return 'Token not bound to this worker';
    }

    if (now > token.expiresAt) {
      this.tokens.delete(tokenId);
      return 'Capability token expired';
    }

    if (token.maxToolCalls !== undefined && token.usedToolCalls >= token.maxToolCalls) {
      return 'Token call budget exceeded';
    }

    // Increment usage
    token.usedToolCalls++;
    return null;
  }

  /**
   * Revoke a specific token.
   */
  revoke(tokenId: string): boolean {
    return this.tokens.delete(tokenId);
  }

  /**
   * Revoke all tokens for a given worker.
   */
  revokeForWorker(workerId: string): void {
    for (const [id, token] of this.tokens.entries()) {
      if (token.workerId === workerId) {
        this.tokens.delete(id);
      }
    }
  }

  /**
   * Clean up expired tokens.
   */
  cleanup(now: number = Date.now()): void {
    for (const [id, token] of this.tokens.entries()) {
      if (now > token.expiresAt) {
        this.tokens.delete(id);
      }
    }
  }
}
