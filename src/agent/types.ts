/**
 * Agent system type definitions.
 *
 * Event-driven agents: async classes that respond to events and messages.
 * The lifecycle is managed as an explicit state machine.
 */

import type { LLMProvider } from '../llm/types.js';
import type { AgentEvent } from '../queue/event-bus.js';
import type { AuditLog } from '../guardian/audit-log.js';
import type { SharedStateView } from '../runtime/shared-state.js';
import type { AgentHandoffContract } from '../runtime/handoffs.js';

// ─── Event-Driven Agent Types ─────────────────────────────────

export interface DispatchLineage {
  rootRequestId: string;
  parentInvocationId?: string;
  invocationId: string;
  depth: number;
  path: string[];
}

export interface AgentDispatchOptions {
  handoff?: AgentHandoffContract;
}

/** Context provided to agents on message/event handling. */
export interface AgentContext {
  /** The agent's ID. */
  agentId: string;
  /** Dispatch lineage tracking to prevent infinite recursion. */
  lineage?: DispatchLineage;
  /** Emit an event to the event bus. */
  emit(event: Omit<AgentEvent, 'sourceAgentId' | 'timestamp'>): Promise<void>;
  /** The agent's LLM provider (if configured). */
  llm?: LLMProvider;
  /** Request permission to perform a guarded action. Throws if denied. */
  checkAction(action: { type: string; params: Record<string, unknown> }): void;
  /** Agent's granted capabilities (read-only). */
  capabilities: readonly string[];
  /**
   * Dispatch a message to another agent and get a response.
   * Available in orchestration contexts. All sub-agent calls pass
   * through the full Guardian admission pipeline.
   */
  dispatch?: (agentId: string, message: UserMessage, options?: AgentDispatchOptions) => Promise<AgentResponse>;
  /**
   * Read-only view of shared orchestration state.
   * Orchestration agents (Sequential/Parallel/Loop) use this to pass
   * intermediate results between sub-agent invocations.
   */
  sharedState?: SharedStateView;
}

/** Context provided to agents on scheduled invocations. */
export interface ScheduleContext extends AgentContext {
  /** Cron expression that triggered this invocation. */
  schedule: string;
  /** Audit log access (for Sentinel-type agents). */
  auditLog?: AuditLog;
}

/** User message routed to an agent. */
export interface UserMessage {
  /** Unique message ID. */
  id: string;
  /** User identifier. */
  userId: string;
  /** Logical chat/client surface identifier for per-surface attachments. */
  surfaceId?: string;
  /** Authenticated principal for authorization-sensitive flows. */
  principalId?: string;
  /** Principal role in the current channel/session. */
  principalRole?: import('../tools/types.js').PrincipalRole;
  /** Channel the message came from. */
  channel: string;
  /** Message content. */
  content: string;
  /** Optional structured metadata used by orchestration and handoff flows. */
  metadata?: Record<string, unknown>;
  /** Timestamp. */
  timestamp: number;
}

/** Agent response to a user message. */
export interface AgentResponse {
  /** Response content. */
  content: string;
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
}

/** Capabilities an agent declares. */
export interface AgentCapabilities {
  /** Can handle user messages. */
  handleMessages: boolean;
  /** Can respond to events. */
  handleEvents: boolean;
  /** Can run on a schedule. */
  handleSchedule: boolean;
}

/** The Agent interface — event-driven async class. */
export interface Agent {
  /** Unique agent identifier. */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Capabilities this agent supports. */
  readonly capabilities: AgentCapabilities;

  /** Called when the agent is started. */
  onStart?(ctx: AgentContext): Promise<void>;
  /** Called when the agent is stopped. */
  onStop?(): Promise<void>;
  /** Called when the agent receives a user message. */
  onMessage?(message: UserMessage, ctx: AgentContext, workerManager?: import('../supervisor/worker-manager.js').WorkerManager): Promise<AgentResponse>;
  /** Called when the agent receives an event. */
  onEvent?(event: AgentEvent, ctx: AgentContext): Promise<void>;
  /** Called on a cron schedule. */
  onSchedule?(ctx: ScheduleContext): Promise<void>;
}

// ─── Lifecycle State Machine ──────────────────────────────────

/** Agent lifecycle states. */
export enum AgentState {
  Created = 'created',
  Ready = 'ready',
  Running = 'running',
  Idle = 'idle',
  Paused = 'paused',
  Stalled = 'stalled',
  Errored = 'errored',
  Dead = 'dead',
}

// ─── Agent Definition & Instance ──────────────────────────────

/** Per-agent resource limits. */
export interface AgentResourceLimits {
  /** Maximum wall-clock ms per invocation. */
  maxInvocationBudgetMs: number;
  /** Maximum LLM tokens per minute (0 = unlimited). */
  maxTokensPerMinute: number;
  /** Maximum concurrent tool executions (0 = unlimited). */
  maxConcurrentTools: number;
  /** Maximum pending events in agent's queue (0 = unlimited). */
  maxQueueDepth: number;
}

/** Default resource limits. */
export const DEFAULT_RESOURCE_LIMITS: AgentResourceLimits = {
  maxInvocationBudgetMs: 300_000,
  maxTokensPerMinute: 0,
  maxConcurrentTools: 0,
  maxQueueDepth: 1000,
};

/** Definition used to register an agent with the system. */
export interface AgentDefinition {
  /** The agent instance. */
  agent: Agent;
  /** Which LLM provider name to use (key in config). */
  providerName?: string;
  /** Cron schedule for periodic execution. */
  schedule?: string;
  /** Capabilities granted to this agent (frozen at registration). */
  grantedCapabilities: readonly string[];
  /** Resource limits for this agent. */
  resourceLimits: AgentResourceLimits;
}

/** Runtime state of a registered agent. */
export interface AgentInstance {
  /** The agent's definition. */
  definition: AgentDefinition;
  /** Current lifecycle state. */
  state: AgentState;
  /** The agent instance. */
  agent: Agent;
  /** Last activity timestamp (ms) for stall detection. */
  lastActivityMs: number;
  /** Number of consecutive errors (for backoff). */
  consecutiveErrors: number;
  /** Timestamp when agent can next be retried after error (ms). */
  retryAfterMs: number;
  /** LLM provider assigned to this agent. */
  provider?: LLMProvider;
}

/**
 * Valid state transitions for the agent lifecycle.
 * Maps from current state to the set of allowed next states.
 */
export const VALID_TRANSITIONS: ReadonlyMap<AgentState, ReadonlySet<AgentState>> = new Map([
  [AgentState.Created, new Set([AgentState.Ready, AgentState.Dead])],
  [AgentState.Ready, new Set([AgentState.Running, AgentState.Dead])],
  [AgentState.Running, new Set([AgentState.Idle, AgentState.Paused, AgentState.Stalled, AgentState.Errored, AgentState.Dead])],
  [AgentState.Idle, new Set([AgentState.Running, AgentState.Paused, AgentState.Dead])],
  [AgentState.Paused, new Set([AgentState.Running, AgentState.Dead])],
  [AgentState.Stalled, new Set([AgentState.Running, AgentState.Errored, AgentState.Dead])],
  [AgentState.Errored, new Set([AgentState.Ready, AgentState.Dead])],
  [AgentState.Dead, new Set()],
]);
