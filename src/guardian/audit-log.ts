/**
 * Audit log — structured security event logging with in-memory ring buffer.
 *
 * Foundation for Layer 2 (Guardian Agent) and Layer 4 (Sentinel Audit).
 * Records all Guardian decisions, security events, and anomalies for
 * inline evaluation and retrospective analysis.
 */

import type { AuditPersistence, ChainVerifyResult } from './audit-persistence.js';
import { createLogger } from '../util/logging.js';

const log = createLogger('audit-log');

/** Types of security events that can be recorded. */
export type AuditEventType =
  | 'action_denied'
  | 'action_allowed'
  | 'secret_detected'
  | 'output_blocked'
  | 'output_redacted'
  | 'event_blocked'
  | 'input_sanitized'
  | 'rate_limited'
  | 'capability_probe'
  | 'policy_changed'
  | 'anomaly_detected'
  | 'host_alert'
  | 'agent_error'
  | 'agent_stalled'
  | 'policy_engine_started'
  | 'policy_mode_changed'
  | 'policy_rules_reloaded'
  | 'policy_shadow_mismatch';

/** Severity levels for audit events. */
export type AuditSeverity = 'info' | 'warn' | 'critical';

/** A single audit event. */
export interface AuditEvent {
  /** Unique event ID. */
  id: string;
  /** Timestamp (ms since epoch). */
  timestamp: number;
  /** Event type. */
  type: AuditEventType;
  /** Severity level. */
  severity: AuditSeverity;
  /** Agent that triggered the event. */
  agentId: string;
  /** User ID (if applicable). */
  userId?: string;
  /** Channel (if applicable). */
  channel?: string;
  /** Controller that generated the event. */
  controller?: string;
  /** Additional details. */
  details: Record<string, unknown>;
}

/** Filter for querying audit events. */
export interface AuditFilter {
  /** Filter by event type. */
  type?: AuditEventType;
  /** Filter by agent ID. */
  agentId?: string;
  /** Filter by severity. */
  severity?: AuditSeverity;
  /** Filter events after this timestamp. */
  after?: number;
  /** Filter events before this timestamp. */
  before?: number;
  /** Maximum number of results. */
  limit?: number;
}

/** Summary of audit events over a time window. */
export interface AuditSummary {
  /** Total events in window. */
  totalEvents: number;
  /** Events by type. */
  byType: Record<string, number>;
  /** Events by severity. */
  bySeverity: Record<AuditSeverity, number>;
  /** Top agents by denial count. */
  topDeniedAgents: Array<{ agentId: string; count: number }>;
  /** Top triggered patterns/controllers. */
  topControllers: Array<{ controller: string; count: number }>;
  /** Time window start (ms). */
  windowStart: number;
  /** Time window end (ms). */
  windowEnd: number;
}

let nextId = 1;

/** Generate a unique audit event ID. */
function generateId(): string {
  return `audit-${Date.now()}-${nextId++}`;
}

/**
 * In-memory ring buffer audit log with structured querying.
 *
 * Events are stored in a fixed-size buffer. When full, oldest events
 * are evicted. Events are also logged to pino at appropriate levels.
 */
/** Listener callback for real-time audit event notifications. */
export type AuditListener = (event: AuditEvent) => void;

export class AuditLog {
  private events: AuditEvent[] = [];
  private maxEvents: number;
  private listeners: Set<AuditListener> = new Set();
  private persistence?: AuditPersistence;

  constructor(maxEvents: number = 10_000) {
    this.maxEvents = maxEvents;
  }

  /** Wire a persistence backend for durable, hash-chained storage. */
  setPersistence(persistence: AuditPersistence): void {
    this.persistence = persistence;
  }

  /** Verify the hash chain in the persistence layer. */
  async verifyChain(): Promise<ChainVerifyResult> {
    if (!this.persistence) {
      return { valid: true, totalEntries: 0 };
    }
    return this.persistence.verifyChain();
  }

  /** Rehydrate the in-memory buffer from persisted entries. */
  async rehydrate(count: number = 100): Promise<number> {
    if (!this.persistence) return 0;
    const entries = await this.persistence.readTail(count);
    for (const entry of entries) {
      // Only add if not already present
      if (!this.events.some((e) => e.id === entry.event.id)) {
        this.events.push(entry.event);
      }
    }
    return entries.length;
  }

  /**
   * Add a listener that is notified on every new audit event.
   * Returns an unsubscribe function.
   */
  addListener(listener: AuditListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Record a new audit event. */
  record(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent {
    const full: AuditEvent = {
      ...event,
      id: generateId(),
      timestamp: Date.now(),
    };

    this.events.push(full);

    // Persist to durable storage (fire-and-forget so hot path isn't blocked)
    this.persistence?.persist(full).catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to persist audit event');
    });

    // Evict oldest if over capacity
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    // Log to pino at appropriate level
    const logData = {
      auditId: full.id,
      type: full.type,
      agentId: full.agentId,
      controller: full.controller,
      ...full.details,
    };

    switch (full.severity) {
      case 'critical':
        log.error(logData, `[AUDIT] ${full.type}`);
        break;
      case 'warn':
        log.warn(logData, `[AUDIT] ${full.type}`);
        break;
      default:
        log.info(logData, `[AUDIT] ${full.type}`);
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        // Listener errors must not break recording
      }
    }

    return full;
  }

  /** Query events matching a filter. */
  query(filter: AuditFilter): AuditEvent[] {
    let results = this.events;

    if (filter.type) {
      results = results.filter(e => e.type === filter.type);
    }
    if (filter.agentId) {
      results = results.filter(e => e.agentId === filter.agentId);
    }
    if (filter.severity) {
      results = results.filter(e => e.severity === filter.severity);
    }
    if (filter.after !== undefined) {
      results = results.filter(e => e.timestamp >= filter.after!);
    }
    if (filter.before !== undefined) {
      results = results.filter(e => e.timestamp <= filter.before!);
    }
    if (filter.limit !== undefined) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /** Get the N most recent events. */
  getRecentEvents(count: number): AuditEvent[] {
    return this.events.slice(-count);
  }

  /** Get a summary of events within a time window. */
  getSummary(windowMs: number): AuditSummary {
    const now = Date.now();
    const windowStart = now - windowMs;
    const windowEvents = this.events.filter(e => e.timestamp >= windowStart);

    const byType: Record<string, number> = {};
    const bySeverity: Record<AuditSeverity, number> = { info: 0, warn: 0, critical: 0 };
    const agentDenials: Record<string, number> = {};
    const controllerCounts: Record<string, number> = {};

    for (const event of windowEvents) {
      byType[event.type] = (byType[event.type] ?? 0) + 1;
      bySeverity[event.severity]++;

      if (event.type === 'action_denied' || event.type === 'rate_limited' || event.type === 'capability_probe') {
        agentDenials[event.agentId] = (agentDenials[event.agentId] ?? 0) + 1;
      }

      if (event.controller) {
        controllerCounts[event.controller] = (controllerCounts[event.controller] ?? 0) + 1;
      }
    }

    const topDeniedAgents = Object.entries(agentDenials)
      .map(([agentId, count]) => ({ agentId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topControllers = Object.entries(controllerCounts)
      .map(([controller, count]) => ({ controller, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalEvents: windowEvents.length,
      byType,
      bySeverity,
      topDeniedAgents,
      topControllers,
      windowStart,
      windowEnd: now,
    };
  }

  /** Get all events (for testing/export). */
  getAll(): readonly AuditEvent[] {
    return this.events;
  }

  /** Get current event count. */
  get size(): number {
    return this.events.length;
  }

  /** Clear all events. */
  clear(): void {
    this.events = [];
  }
}
