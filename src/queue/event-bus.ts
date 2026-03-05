/**
 * Event bus — immediate async dispatch for inter-agent communication.
 *
 * Replaces the old batch-drain EventQueue with immediate delivery on emit().
 * Supports typed event subscriptions and broadcast.
 */

/** Typed event for inter-agent communication. */
export interface AgentEvent {
  /** Event type identifier (e.g., 'user.message', 'agent.response'). */
  type: string;
  /** Agent that emitted the event (or 'system'). */
  sourceAgentId: string;
  /** Target agent ID, or '*' for broadcast. */
  targetAgentId: string;
  /** Event payload (must be serializable). */
  payload: unknown;
  /** Timestamp when event was emitted (ms). */
  timestamp: number;
}

import type {
  EventClassifier,
  EventPolicy,
  EventPipelineHandler,
  EventPipelineRegistration,
  ClassifiedEvent,
} from './event-pipeline.js';

/** Callback for event delivery. */
export type EventHandler = (event: AgentEvent) => void | Promise<void>;
export type EventSourceValidator = (event: AgentEvent) => boolean;

export interface EventBusOptions {
  maxDepth?: number;
  sourceValidator?: EventSourceValidator;
}

export class EventBus {
  private handlers: Map<string, EventHandler[]> = new Map();
  private broadcastHandlers: EventHandler[] = [];
  private typeHandlers: Map<string, EventHandler[]> = new Map();
  private pipelineHandlers: EventPipelineRegistration[] = [];
  private maxDepth: number;
  private sourceValidator?: EventSourceValidator;
  private pendingCount = 0;

  constructor(maxDepthOrOptions: number | EventBusOptions = 10_000) {
    if (typeof maxDepthOrOptions === 'number') {
      this.maxDepth = maxDepthOrOptions;
      this.sourceValidator = undefined;
      return;
    }
    this.maxDepth = maxDepthOrOptions.maxDepth ?? 10_000;
    this.sourceValidator = maxDepthOrOptions.sourceValidator;
  }

  /** Emit an event with immediate dispatch to matching handlers. */
  async emit(event: AgentEvent): Promise<boolean> {
    if (this.sourceValidator && !this.sourceValidator(event)) {
      return false;
    }
    if (this.pendingCount >= this.maxDepth) {
      return false;
    }

    this.pendingCount++;

    try {
      const promises: Promise<void>[] = [];

      // Type-based handlers
      const typeH = this.typeHandlers.get(event.type);
      if (typeH) {
        for (const handler of typeH) {
          const result = handler(event);
          if (result instanceof Promise) promises.push(result);
        }
      }

      if (event.targetAgentId === '*') {
        // Broadcast to all specific handlers
        for (const handlers of this.handlers.values()) {
          for (const handler of handlers) {
            const result = handler(event);
            if (result instanceof Promise) promises.push(result);
          }
        }
        // And broadcast handlers
        for (const handler of this.broadcastHandlers) {
          const result = handler(event);
          if (result instanceof Promise) promises.push(result);
        }
      } else {
        // Targeted delivery
        const handlers = this.handlers.get(event.targetAgentId);
        if (handlers) {
          for (const handler of handlers) {
            const result = handler(event);
            if (result instanceof Promise) promises.push(result);
          }
        }
      }

      // Run pipeline handlers: classify → policy → execute
      for (const pipeline of this.pipelineHandlers) {
        const category = pipeline.classifier(event);
        const classified: ClassifiedEvent = {
          ...event,
          category,
          classifiedAt: Date.now(),
        };
        const decision = pipeline.policy(classified);
        if (!decision.shouldThrottle) {
          const result = pipeline.handler(classified, decision);
          if (result instanceof Promise) promises.push(result);
        }
      }

      if (promises.length > 0) {
        await Promise.all(promises);
      }

      return true;
    } finally {
      this.pendingCount--;
    }
  }

  /** Register a handler for events targeted at a specific agent. */
  subscribe(agentId: string, handler: EventHandler): void {
    const existing = this.handlers.get(agentId) ?? [];
    existing.push(handler);
    this.handlers.set(agentId, existing);
  }

  /** Register a handler for events of a specific type. */
  subscribeByType(eventType: string, handler: EventHandler): void {
    const existing = this.typeHandlers.get(eventType) ?? [];
    existing.push(handler);
    this.typeHandlers.set(eventType, existing);
  }

  /** Register a handler for broadcast events ('*' target). */
  onBroadcast(handler: EventHandler): void {
    this.broadcastHandlers.push(handler);
  }

  /** Remove a handler for a specific agent. */
  unsubscribe(agentId: string, handler: EventHandler): void {
    const existing = this.handlers.get(agentId);
    if (!existing) return;
    this.handlers.set(agentId, existing.filter(h => h !== handler));
  }

  /** Remove ALL handlers for a specific agent (used by unregister). */
  removeHandlersForAgent(agentId: string): void {
    this.handlers.delete(agentId);
  }

  /** Remove a type handler. */
  unsubscribeByType(eventType: string, handler: EventHandler): void {
    const existing = this.typeHandlers.get(eventType);
    if (!existing) return;
    this.typeHandlers.set(eventType, existing.filter(h => h !== handler));
  }

  /**
   * Register a pipeline: classify → policy → execute for every emitted event.
   * Returns an unsubscribe function.
   */
  usePipeline(classifier: EventClassifier, policy: EventPolicy, handler: EventPipelineHandler): () => void {
    const registration: EventPipelineRegistration = { classifier, policy, handler };
    this.pipelineHandlers.push(registration);
    return () => {
      this.pipelineHandlers = this.pipelineHandlers.filter(r => r !== registration);
    };
  }

  /** Remove all handlers. */
  removeAllHandlers(): void {
    this.handlers.clear();
    this.broadcastHandlers = [];
    this.typeHandlers.clear();
    this.pipelineHandlers = [];
  }

  /** Current number of in-flight event dispatches. */
  get pending(): number {
    return this.pendingCount;
  }
}
