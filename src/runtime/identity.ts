/**
 * Cross-channel identity resolver.
 *
 * Maps channel-specific user IDs to a canonical identity so memory and
 * personalization can follow one person across web/CLI/Telegram.
 */

import type { AssistantIdentityConfig } from '../config/types.js';

export class IdentityService {
  private config: AssistantIdentityConfig;

  constructor(config: AssistantIdentityConfig) {
    this.config = config;
  }

  update(config: AssistantIdentityConfig): void {
    this.config = config;
  }

  /**
   * Resolve channel user ID to canonical user ID.
   *
   * Precedence:
   * 1) explicit alias map
   * 2) single_user primary identity
   * 3) channel_user fallback key
   */
  resolveCanonicalUserId(channel: string, channelUserId: string): string {
    const aliasKey = `${channel}:${channelUserId}`;
    const aliased = this.config.aliases?.[aliasKey];
    if (aliased && aliased.trim()) {
      return aliased.trim();
    }

    if (this.config.mode === 'single_user') {
      return this.config.primaryUserId;
    }

    return aliasKey;
  }
}
