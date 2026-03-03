/**
 * Shared state — inter-agent data passing for orchestration patterns.
 *
 * Enables Sequential/Parallel/Loop agents to share intermediate results
 * through a key-value store. Supports two scoping conventions:
 *
 * - Regular keys: persist for the lifetime of the orchestration run
 * - "temp:" prefixed keys: cleared after each orchestration invocation
 *
 * All reads/writes are synchronous for simplicity within a single runtime.
 */

/** Read-only view of shared state for sub-agents. */
export interface SharedStateView {
  get<T = unknown>(key: string): T | undefined;
  has(key: string): boolean;
  keys(): string[];
  snapshot(): Record<string, unknown>;
}

/**
 * Mutable shared state for orchestration agents.
 *
 * Orchestration agents (Sequential, Parallel, Loop) own the state
 * and pass read-only views to sub-agents when needed.
 */
export class SharedState implements SharedStateView {
  private state: Map<string, unknown> = new Map();
  private tempKeys: Set<string> = new Set();

  /** Get a value by key. Returns undefined if not set. */
  get<T = unknown>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  /** Set a value. Keys starting with "temp:" are tracked for bulk cleanup. */
  set(key: string, value: unknown): void {
    this.state.set(key, value);
    if (key.startsWith('temp:')) {
      this.tempKeys.add(key);
    }
  }

  /** Check if a key exists. */
  has(key: string): boolean {
    return this.state.has(key);
  }

  /** Delete a single key. */
  delete(key: string): boolean {
    this.tempKeys.delete(key);
    return this.state.delete(key);
  }

  /** Get all keys. */
  keys(): string[] {
    return [...this.state.keys()];
  }

  /** Return a plain-object snapshot of all state. */
  snapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this.state) {
      result[key] = value;
    }
    return result;
  }

  /** Clear all keys with the "temp:" prefix. Called between orchestration runs. */
  clearTemp(): void {
    for (const key of this.tempKeys) {
      this.state.delete(key);
    }
    this.tempKeys.clear();
  }

  /** Clear all state. */
  clear(): void {
    this.state.clear();
    this.tempKeys.clear();
  }

  /** Number of entries. */
  get size(): number {
    return this.state.size;
  }

  /** Create a read-only view of this state. */
  asReadOnly(): SharedStateView {
    return {
      get: <T = unknown>(key: string) => this.get<T>(key),
      has: (key: string) => this.has(key),
      keys: () => this.keys(),
      snapshot: () => this.snapshot(),
    };
  }
}
