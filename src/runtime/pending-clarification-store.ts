export interface PendingClarificationState {
  kind: 'email_provider' | 'coding_backend' | 'coding_workspace_switch' | 'generic';
  originalUserContent: string;
  prompt: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingClarificationContextKey {
  agentId: string;
  userId: string;
  channel: string;
}

function buildStoreKey(input: PendingClarificationContextKey): string {
  return `${input.agentId}:${input.userId}:${input.channel}`;
}

export class PendingClarificationStore {
  private readonly states = new Map<string, PendingClarificationState>();

  get(input: PendingClarificationContextKey, nowMs: number = Date.now()): PendingClarificationState | null {
    const key = buildStoreKey(input);
    const state = this.states.get(key);
    if (!state) return null;
    if (state.expiresAt <= nowMs) {
      this.states.delete(key);
      return null;
    }
    return state;
  }

  set(input: PendingClarificationContextKey, state: PendingClarificationState): void {
    this.states.set(buildStoreKey(input), state);
  }

  clear(input: PendingClarificationContextKey): void {
    this.states.delete(buildStoreKey(input));
  }
}
