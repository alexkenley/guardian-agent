import type { UserMessage } from '../../agent/types.js';
import type { ResolvedSkill } from '../../skills/types.js';
import type { IntentRoutingTraceStage } from '../intent-routing-trace.js';
import type { IntentGatewayRecord } from '../intent-gateway.js';
import {
  resolveDirectIntentRoutingCandidates,
  shouldAllowBoundedDegradedMemorySaveFallback,
  type DirectIntentRoutingCandidate,
} from '../direct-intent-routing.js';
import {
  dispatchDirectIntentCandidates,
  type DirectIntentDispatchResult,
} from './direct-intent-dispatch.js';

export type { DirectIntentRoutingCandidate } from '../direct-intent-routing.js';

export interface DirectRouteHandlerContext {
  gatewayDirected: boolean;
  gatewayUnavailable: boolean;
  skipDirectWebSearch: boolean;
}

export type DirectIntentHandlerMap = Partial<Record<
  DirectIntentRoutingCandidate,
  (context: DirectRouteHandlerContext) => Promise<DirectIntentDispatchResult | null>
>>;

export const CHAT_DIRECT_INTENT_CANDIDATES: readonly DirectIntentRoutingCandidate[] = [
  'personal_assistant',
  'provider_read',
  'coding_session_control',
  'coding_backend',
  'filesystem',
  'memory_write',
  'memory_read',
  'scheduled_email_automation',
  'automation',
  'automation_control',
  'automation_output',
  'workspace_write',
  'workspace_read',
  'browser',
  'web_search',
  'diagnostics_trace_inspect',
  'diagnostics_issue_submit',
  'diagnostics_issue_draft',
  'security_guardrail',
];

type RecordIntentRoutingTrace = (
  stage: IntentRoutingTraceStage,
  input: {
    message?: UserMessage;
    requestId?: string;
    details?: Record<string, unknown>;
    contentPreview?: string;
  },
) => void;

export function shouldSkipDirectWebSearch(input: {
  gateway?: IntentGatewayRecord | null;
  activeSkills: readonly Pick<ResolvedSkill, 'id'>[];
  resolvedCodeSession?: unknown | null;
  codeContext?: { sessionId?: string } | null;
}): boolean {
  const directBrowserIntent = input.gateway?.decision.route === 'browser_task';
  return !!input.resolvedCodeSession
    || !!input.codeContext
    || directBrowserIntent
    || input.activeSkills.some((skill) => (
      skill.id === 'multi-search-engine'
      || skill.id === 'weather'
      || skill.id === 'blogwatcher'
    ));
}

export async function runDirectRouteOrchestration<TResponse>(input: {
  skipDirectTools: boolean;
  gateway?: IntentGatewayRecord | null;
  message: UserMessage;
  activeSkills: readonly ResolvedSkill[];
  resolvedCodeSession?: unknown | null;
  codeContext?: { sessionId?: string } | null;
  handlers: DirectIntentHandlerMap;
  onHandled: (
    candidate: DirectIntentRoutingCandidate,
    result: DirectIntentDispatchResult,
  ) => Promise<TResponse>;
  onDegradedMemoryFallback?: () => Promise<TResponse | null>;
  recordIntentRoutingTrace?: RecordIntentRoutingTrace;
}): Promise<TResponse | null> {
  if (input.skipDirectTools) {
    return null;
  }

  const directIntentRouting = resolveDirectIntentRoutingCandidates(
    input.gateway,
    CHAT_DIRECT_INTENT_CANDIDATES,
  );
  const skipDirectWebSearch = shouldSkipDirectWebSearch({
    gateway: input.gateway,
    activeSkills: input.activeSkills,
    resolvedCodeSession: input.resolvedCodeSession,
    codeContext: input.codeContext,
  });

  input.recordIntentRoutingTrace?.('direct_candidates_evaluated', {
    message: input.message,
    details: {
      gatewayDirected: directIntentRouting.gatewayDirected,
      gatewayUnavailable: directIntentRouting.gatewayUnavailable,
      route: input.gateway?.decision.route,
      routeSource: input.gateway?.decision.provenance?.route,
      operation: input.gateway?.decision.operation,
      operationSource: input.gateway?.decision.provenance?.operation,
      codingBackend: input.gateway?.decision.entities.codingBackend,
      simpleVsComplex: input.gateway?.decision.simpleVsComplex,
      entitySources: input.gateway?.decision.provenance?.entities,
      candidates: directIntentRouting.candidates,
      skipDirectWebSearch,
      codeSessionResolved: !!input.resolvedCodeSession,
      codeSessionId: input.codeContext?.sessionId,
    },
  });

  const handlerContext: DirectRouteHandlerContext = {
    gatewayDirected: directIntentRouting.gatewayDirected,
    gatewayUnavailable: directIntentRouting.gatewayUnavailable,
    skipDirectWebSearch,
  };
  const handlers = Object.fromEntries(
    Object.entries(input.handlers).map(([candidate, handler]) => [
      candidate,
      async () => {
        if (candidate === 'web_search' && skipDirectWebSearch) {
          return null;
        }
        return handler?.(handlerContext) ?? null;
      },
    ]),
  ) as Partial<Record<DirectIntentRoutingCandidate, () => Promise<DirectIntentDispatchResult | null>>>;

  return dispatchDirectIntentCandidates({
    candidates: directIntentRouting.candidates,
    handlers,
    onHandled: input.onHandled,
    gatewayDirected: directIntentRouting.gatewayDirected,
    allowDegradedMemoryFallback: shouldAllowBoundedDegradedMemorySaveFallback(input.gateway),
    onDegradedMemoryFallback: input.onDegradedMemoryFallback,
  });
}
