/**
 * Event classification pipeline — opt-in classify→policy→execute stages.
 *
 * Adds structured event processing to EventBus without changing
 * existing subscribe/emit behavior.
 */

import type { AgentEvent } from './event-bus.js';

/** Category for classified events. */
export type EventCategory = 'presence' | 'chat' | 'security' | 'system' | 'agent' | 'unknown';

/** An event that has been classified. */
export interface ClassifiedEvent extends AgentEvent {
  category: EventCategory;
  classifiedAt: number;
}

/** Policy decision for a classified event. */
export interface EventPolicyDecision {
  shouldLog: boolean;
  shouldForward: boolean;
  shouldAlert: boolean;
  shouldThrottle: boolean;
  metadata?: Record<string, unknown>;
}

/** Classifies a raw event into a category. */
export type EventClassifier = (event: AgentEvent) => EventCategory;

/** Derives a policy decision from a classified event. */
export type EventPolicy = (event: ClassifiedEvent) => EventPolicyDecision;

/** Handles a classified event after policy evaluation. */
export type EventPipelineHandler = (event: ClassifiedEvent, decision: EventPolicyDecision) => void | Promise<void>;

/**
 * Default classifier — categorizes by event.type prefix.
 */
export function defaultEventClassifier(event: AgentEvent): EventCategory {
  const type = event.type;
  if (type.startsWith('user.')) return 'chat';
  if (type.startsWith('chat.')) return 'chat';
  if (type.startsWith('agent.')) return 'agent';
  if (type.startsWith('guardian.') || type.startsWith('audit.')) return 'security';
  if (type.startsWith('system.')) return 'system';
  if (type.startsWith('presence.')) return 'presence';
  return 'unknown';
}

/**
 * Default policy — log all, forward all, no alerts, no throttle.
 */
export function defaultEventPolicy(_event: ClassifiedEvent): EventPolicyDecision {
  return {
    shouldLog: true,
    shouldForward: true,
    shouldAlert: false,
    shouldThrottle: false,
  };
}

/** A registered pipeline in the EventBus. */
export interface EventPipelineRegistration {
  classifier: EventClassifier;
  policy: EventPolicy;
  handler: EventPipelineHandler;
}
