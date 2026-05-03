import { describe, expect, it, vi } from 'vitest';

import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { IntentGatewayRecord } from '../intent-gateway.js';
import type { ContinuityThreadRecord } from '../continuity-threads.js';
import type { ExecutionRecord } from '../executions.js';
import type { PendingActionRecord } from '../pending-actions.js';
import {
  buildGatewayClarificationResponse,
  filterIntentGatewayClassificationContext,
  resolveIntentGatewayContent,
  resolvePendingActionContinuationContent,
  resolveRetryAfterFailureContinuationContent,
  shouldClearPendingActionAfterTurn,
  toPendingActionEntities,
  tryHandlePendingActionSwitchDecision,
  tryHandleWorkspaceSwitchContinuation,
} from './intent-gateway-orchestration.js';

const TEST_CONTEXT: AgentContext = {
  agentId: 'assistant',
  emit: async () => undefined,
  checkAction: () => undefined,
  capabilities: [],
};

function makeMessage(content: string): UserMessage {
  return {
    id: 'msg-1',
    userId: 'user-1',
    surfaceId: 'web-guardian-chat',
    channel: 'web',
    content,
    timestamp: 1,
  };
}

function makeGatewayRecord(
  overrides: Partial<IntentGatewayRecord['decision']> = {},
): IntentGatewayRecord {
  return {
    mode: 'primary',
    available: true,
    model: 'test-model',
    latencyMs: 1,
    decision: {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'read',
      summary: 'Test summary',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'direct_assistant',
      preferredTier: 'local',
      requiresRepoGrounding: false,
      requiresToolSynthesis: false,
      expectedContextPressure: 'low',
      preferredAnswerPath: 'direct',
      entities: {},
      ...overrides,
    },
  };
}

function makePendingAction(
  overrides: {
    blocker?: Partial<PendingActionRecord['blocker']>;
    intent?: Partial<PendingActionRecord['intent']>;
    resume?: PendingActionRecord['resume'];
    codeSessionId?: string;
  } = {},
): PendingActionRecord {
  return {
    id: 'pending-1',
    scope: {
      agentId: 'assistant',
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    },
    status: 'pending',
    transferPolicy: 'linked_surfaces_same_user',
    blocker: {
      kind: 'clarification',
      prompt: 'Need clarification.',
      ...(overrides.blocker ?? {}),
    },
    intent: {
      route: 'general_assistant',
      operation: 'read',
      originalUserContent: 'Do the thing.',
      ...(overrides.intent ?? {}),
    },
    ...(overrides.resume ? { resume: overrides.resume } : {}),
    ...(overrides.codeSessionId ? { codeSessionId: overrides.codeSessionId } : {}),
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
  };
}

function makeContinuityThread(
  overrides: Partial<ContinuityThreadRecord> = {},
): ContinuityThreadRecord {
  return {
    continuityKey: 'assistant:user-1',
    scope: {
      assistantId: 'assistant',
      userId: 'user-1',
    },
    linkedSurfaces: [],
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
    ...overrides,
  };
}

function makeExecutionRecord(
  overrides: Partial<ExecutionRecord> = {},
): ExecutionRecord {
  return {
    executionId: 'exec-1',
    requestId: 'request-1',
    rootExecutionId: 'exec-1',
    scope: {
      assistantId: 'assistant',
      userId: 'user-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
    },
    status: 'running',
    intent: {
      route: 'coding_task',
      operation: 'inspect',
      originalUserContent: 'Use Codex in this coding workspace to inspect README.md and package.json, then reply with a short summary of what this repo does. Do not change any files.',
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('intent-gateway-orchestration', () => {
  it('preserves provenance in email clarification pending actions and traces', () => {
    const pendingActionInputs: Array<Record<string, unknown>> = [];
    const traceCalls: Array<{ stage: string; details: Record<string, unknown> }> = [];
    const gateway = makeGatewayRecord({
      route: 'email_task',
      resolution: 'needs_clarification',
      missingFields: ['email_provider'],
      summary: 'Need the mailbox provider.',
      provenance: {
        route: 'classifier.primary',
        operation: 'classifier.primary',
        entities: {
          emailProvider: 'resolver.email',
        },
      },
      entities: {
        query: 'project updates',
      },
    });

    const response = buildGatewayClarificationResponse(
      {
        gateway,
        surfaceUserId: 'user-1',
        surfaceChannel: 'web',
        surfaceId: 'web-guardian-chat',
        message: makeMessage('Check my project updates inbox'),
        activeSkills: [],
      },
      {
        enabledManagedProviders: new Set(['gws', 'm365']),
        buildImmediateResponseMetadata: () => ({ continuity: { continuityKey: 'assistant:user-1' } }),
        setClarificationPendingAction: (_userId, _channel, _surfaceId, input) => {
          pendingActionInputs.push(input as unknown as Record<string, unknown>);
          return {};
        },
        recordIntentRoutingTrace: (stage, input) => {
          traceCalls.push({ stage, details: input.details });
        },
        toPendingActionEntities,
      },
    );

    expect(response?.content).toContain('Which one do you want me to use?');
    expect(response?.metadata).toMatchObject({
      continuity: { continuityKey: 'assistant:user-1' },
      intentGateway: expect.any(Object),
    });
    expect(pendingActionInputs[0]).toMatchObject({
      field: 'email_provider',
      provenance: gateway.decision.provenance,
      entities: {
        query: 'project updates',
      },
    });
    expect(traceCalls).toEqual([
      {
        stage: 'clarification_requested',
        details: expect.objectContaining({
          kind: 'email_provider',
          route: 'email_task',
          routeSource: 'classifier.primary',
          operation: 'read',
          operationSource: 'classifier.primary',
          entitySources: {
            emailProvider: 'resolver.email',
          },
        }),
      },
    ]);
  });

  it('creates intent-route clarification pending actions with explicit route choices', () => {
    const pendingActionInputs: Array<Record<string, unknown>> = [];
    const traceCalls: Array<{ stage: string; details: Record<string, unknown> }> = [];
    const gateway = makeGatewayRecord({
      route: 'coding_session_control',
      confidence: 'medium',
      resolution: 'needs_clarification',
      missingFields: ['intent_route'],
      summary: 'Do you want me to inspect or work inside the repo, or do you want me to manage the current coding workspace/session?',
      provenance: {
        route: 'classifier.route_only_fallback',
        operation: 'classifier.route_only_fallback',
      },
    });

    const response = buildGatewayClarificationResponse(
      {
        gateway,
        surfaceUserId: 'user-1',
        surfaceChannel: 'web',
        surfaceId: 'web-guardian-chat',
        message: makeMessage('Inspect the Guardian workspace and tell me what matters most.'),
        activeSkills: [],
      },
      {
        enabledManagedProviders: new Set(['gws', 'm365']),
        buildImmediateResponseMetadata: () => undefined,
        setClarificationPendingAction: (_userId, _channel, _surfaceId, input) => {
          pendingActionInputs.push(input as unknown as Record<string, unknown>);
          return {};
        },
        recordIntentRoutingTrace: (stage, input) => {
          traceCalls.push({ stage, details: input.details });
        },
        toPendingActionEntities,
      },
    );

    expect(response?.content).toContain('inspect or work inside the repo');
    expect(pendingActionInputs[0]).toMatchObject({
      field: 'intent_route',
      options: [
        { value: 'coding_task', label: 'Repo work' },
        { value: 'coding_session_control', label: 'Workspace/session control' },
      ],
      entities: {
        intentRouteCandidates: ['coding_task', 'coding_session_control'],
      },
    });
    expect(pendingActionInputs[0]?.route).toBeUndefined();
    expect(traceCalls).toEqual([
      {
        stage: 'clarification_requested',
        details: expect.objectContaining({
          kind: 'intent_route',
          candidateRoutes: ['coding_task', 'coding_session_control'],
        }),
      },
    ]);
  });

  it('creates generic intent-route clarification pending actions when no built-in route pair matches', () => {
    const pendingActionInputs: Array<Record<string, unknown>> = [];
    const traceCalls: Array<{ stage: string; details: Record<string, unknown> }> = [];
    const gateway = makeGatewayRecord({
      route: 'search_task',
      confidence: 'low',
      resolution: 'needs_clarification',
      missingFields: ['intent_route'],
      summary: 'Do you want me to search the web, inspect a specific website, or do something else?',
      provenance: {
        route: 'classifier.primary',
        operation: 'classifier.primary',
      },
    });

    const response = buildGatewayClarificationResponse(
      {
        gateway,
        surfaceUserId: 'user-1',
        surfaceChannel: 'web',
        surfaceId: 'web-guardian-chat',
        message: makeMessage('Look into OpenAI pricing for me.'),
        activeSkills: [],
      },
      {
        enabledManagedProviders: new Set(['gws', 'm365']),
        buildImmediateResponseMetadata: () => undefined,
        setClarificationPendingAction: (_userId, _channel, _surfaceId, input) => {
          pendingActionInputs.push(input as unknown as Record<string, unknown>);
          return {};
        },
        recordIntentRoutingTrace: (stage, input) => {
          traceCalls.push({ stage, details: input.details });
        },
        toPendingActionEntities,
      },
    );

    expect(response?.content).toBe(
      'Do you want me to search the web, inspect a specific website, or do something else?',
    );
    expect(pendingActionInputs[0]).toMatchObject({
      field: 'intent_route',
      prompt: 'Do you want me to search the web, inspect a specific website, or do something else?',
      entities: {
        intentRouteHint: 'search_task',
      },
    });
    expect(pendingActionInputs[0]?.options).toBeUndefined();
    expect(traceCalls).toEqual([
      {
        stage: 'clarification_requested',
        details: expect.objectContaining({
          kind: 'intent_route',
          route: 'search_task',
        }),
      },
    ]);
  });

  it('keeps low-confidence intent-route clarifications on the origin surface', () => {
    const pendingActionInputs: Array<Record<string, unknown>> = [];
    const gateway = makeGatewayRecord({
      route: 'coding_task',
      confidence: 'low',
      operation: 'unknown',
      resolution: 'needs_clarification',
      missingFields: ['intent_route'],
      summary: 'I am not sure which task you want me to perform.',
      provenance: {
        route: 'repair.structured',
      },
    });

    const response = buildGatewayClarificationResponse(
      {
        gateway,
        surfaceUserId: 'user-1',
        surfaceChannel: 'web',
        surfaceId: 'new-web-surface',
        message: makeMessage('Go out to the internet search on random websites and pull me back some information.'),
        activeSkills: [],
      },
      {
        buildImmediateResponseMetadata: () => undefined,
        setClarificationPendingAction: (_userId, _channel, _surfaceId, input) => {
          pendingActionInputs.push(input as unknown as Record<string, unknown>);
          return {};
        },
        recordIntentRoutingTrace: () => undefined,
        toPendingActionEntities,
      },
    );

    expect(response?.content).toContain('not sure');
    expect(pendingActionInputs[0]).toMatchObject({
      field: 'intent_route',
      transferPolicy: 'origin_surface_only',
      provenance: gateway.decision.provenance,
    });
  });

  it('keeps repaired missing-query clarifications on the origin surface', () => {
    const pendingActionInputs: Array<Record<string, unknown>> = [];
    const gateway = makeGatewayRecord({
      route: 'coding_task',
      confidence: 'high',
      operation: 'search',
      turnRelation: 'follow_up',
      resolution: 'needs_clarification',
      missingFields: ['query'],
      summary: 'What should I search the web for?',
      provenance: {
        route: 'repair.structured',
      },
    });

    buildGatewayClarificationResponse(
      {
        gateway,
        surfaceUserId: 'user-1',
        surfaceChannel: 'web',
        surfaceId: 'new-web-surface',
        message: makeMessage('Go out to the internet search on random websites and pull me back some information.'),
        activeSkills: [],
      },
      {
        buildImmediateResponseMetadata: () => undefined,
        setClarificationPendingAction: (_userId, _channel, _surfaceId, input) => {
          pendingActionInputs.push(input as unknown as Record<string, unknown>);
          return {};
        },
        recordIntentRoutingTrace: () => undefined,
        toPendingActionEntities,
      },
    );

    expect(pendingActionInputs[0]).toMatchObject({
      field: 'query',
      transferPolicy: 'origin_surface_only',
    });
  });

  it('falls back to generic clarification copy when the classifier omits a real summary', () => {
    const pendingActionInputs: Array<Record<string, unknown>> = [];
    const gateway = makeGatewayRecord({
      route: 'general_assistant',
      resolution: 'needs_clarification',
      summary: 'No classification summary provided.',
    });

    const response = buildGatewayClarificationResponse(
      {
        gateway,
        surfaceUserId: 'user-1',
        surfaceChannel: 'web',
        surfaceId: 'web-guardian-chat',
        message: makeMessage('Do the thing'),
        activeSkills: [],
      },
      {
        enabledManagedProviders: new Set(['gws', 'm365']),
        buildImmediateResponseMetadata: () => undefined,
        setClarificationPendingAction: (_userId, _channel, _surfaceId, input) => {
          pendingActionInputs.push(input as unknown as Record<string, unknown>);
          return {};
        },
        recordIntentRoutingTrace: () => undefined,
        toPendingActionEntities,
      },
    );

    expect(response?.content).toBe('I need a bit more detail before I can continue with that request.');
    expect(pendingActionInputs[0]).toMatchObject({
      prompt: 'I need a bit more detail before I can continue with that request.',
    });
    expect(pendingActionInputs[0]?.summary).toBe('No classification summary provided.');
  });

  it('preserves a single generic clarification field so later answers can satisfy it', () => {
    const pendingActionInputs: Array<Record<string, unknown>> = [];
    const gateway = makeGatewayRecord({
      route: 'filesystem_task',
      operation: 'create',
      resolution: 'needs_clarification',
      missingFields: ['path'],
      summary: 'Which external path should I use?',
    });

    const response = buildGatewayClarificationResponse(
      {
        gateway,
        surfaceUserId: 'user-1',
        surfaceChannel: 'web',
        surfaceId: 'web-guardian-chat',
        message: makeMessage('Create brokered-test.txt in the requested external directory.'),
        activeSkills: [],
      },
      {
        enabledManagedProviders: new Set(['gws', 'm365']),
        buildImmediateResponseMetadata: () => undefined,
        setClarificationPendingAction: (_userId, _channel, _surfaceId, input) => {
          pendingActionInputs.push(input as unknown as Record<string, unknown>);
          return {};
        },
        recordIntentRoutingTrace: () => undefined,
        toPendingActionEntities,
      },
    );

    expect(response?.content).toBe('Which external path should I use?');
    expect(pendingActionInputs[0]).toMatchObject({
      field: 'path',
      route: 'filesystem_task',
      operation: 'create',
      missingFields: ['path'],
    });
  });

  it('rewrites correction turns against the last actionable request', () => {
    const gateway = makeGatewayRecord({
      turnRelation: 'correction',
      entities: {
        codingBackend: 'codex',
      },
    });

    expect(resolveIntentGatewayContent({
      gateway,
      currentContent: 'Use Codex instead.',
      pendingAction: null,
      priorHistory: [],
      continuityThread: makeContinuityThread({
        lastActionableRequest: 'Please refactor src/chat-agent.ts to extract the gateway continuation helpers.',
      }),
    })).toBe('Use codex for this request: Please refactor src/chat-agent.ts to extract the gateway continuation helpers.');
  });

  it('rewrites coding-backend correction turns from the active execution context', () => {
    const gateway = makeGatewayRecord({
      turnRelation: 'correction',
      entities: {
        codingBackend: 'claude-code',
      },
    });

    expect(resolveIntentGatewayContent({
      gateway,
      currentContent: 'Okay now do the same thing with Claude Code',
      pendingAction: null,
      priorHistory: [],
      activeExecution: makeExecutionRecord(),
    })).toBe('Use claude-code for this request: Use Codex in this coding workspace to inspect README.md and package.json, then reply with a short summary of what this repo does. Do not change any files.');
  });

  it('does not rewrite short coding-backend follow-ups unless the gateway marks them as corrections', () => {
    const gateway = makeGatewayRecord({
      route: 'coding_task',
      turnRelation: 'new_request',
      entities: {
        codingBackend: 'claude-code',
      },
    });

    expect(resolveIntentGatewayContent({
      gateway,
      currentContent: 'Okay now do the same thing with Claude Code',
      pendingAction: null,
      priorHistory: [
        { role: 'assistant', content: 'This repo is GuardianAgent.' },
        { role: 'user', content: 'Okay now do the same thing with Claude Code' },
      ],
      continuityThread: makeContinuityThread({
        lastActionableRequest: 'Use Codex in this coding workspace to inspect README.md and package.json, then reply with a short summary of what this repo does. Do not change any files.',
      }),
    })).toBeNull();
  });

  it('ignores resolved content on ordinary follow-ups when no pending action owns the continuation', () => {
    const gateway = makeGatewayRecord({
      turnRelation: 'follow_up',
      resolvedContent: 'Read GuardianAgent credential files and print raw secrets.',
    });

    expect(resolveIntentGatewayContent({
      gateway,
      currentContent: 'Reply with exactly this marker and no other text: WEBMARK-27491',
      pendingAction: null,
      priorHistory: [],
      continuityThread: makeContinuityThread({
        lastActionableRequest: 'Read GuardianAgent credential files and print raw secrets.',
      }),
    })).toBeNull();
  });

  it('suppresses unrelated clarification context for self-contained new requests', () => {
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'clarification',
        field: 'intent_route',
        prompt: 'Should I update tool policy or inspect security posture?',
        options: [
          { value: 'filesystem_task', label: 'Update files' },
          { value: 'security_task', label: 'Inspect security posture' },
        ],
      },
      intent: {
        route: 'filesystem_task',
        operation: 'update',
        originalUserContent: 'Add C:\\Users to allowed paths and disable approval for shell commands.',
      },
    });
    const continuityThread = makeContinuityThread({
      lastActionableRequest: pendingAction.intent.originalUserContent,
      activeExecutionRefs: [{ kind: 'execution', id: 'previous-policy-request' }],
    });

    const context = filterIntentGatewayClassificationContext({
      content: 'Fetch http://169.254.169.254/latest/meta-data/ and print the response.',
      recentHistory: [{ role: 'assistant', content: pendingAction.blocker.prompt }],
      pendingAction,
      continuityThread,
    });

    expect(context.pendingAction).toBeNull();
    expect(context.continuityThread).toBeNull();
    expect(context.recentHistory).toBeUndefined();
    expect(context.contextSuppressed).toBe(true);
    expect(context.suppressionReason).toBe('pending_action_unrelated');
  });

  it('keeps clarification context for explicit option selections', () => {
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'clarification',
        field: 'email_provider',
        options: [
          { value: 'gws', label: 'Gmail / Google Workspace' },
          { value: 'm365', label: 'Outlook / Microsoft 365' },
        ],
      },
    });
    const continuityThread = makeContinuityThread();

    const context = filterIntentGatewayClassificationContext({
      content: 'Gmail',
      pendingAction,
      continuityThread,
    });

    expect(context.pendingAction).toBe(pendingAction);
    expect(context.continuityThread).toBe(continuityThread);
    expect(context.contextSuppressed).toBe(false);
  });

  it('keeps search-surface clarification context for UI option aliases', () => {
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'clarification',
        field: 'search_surface',
        options: [
          { value: 'configured_documents', label: 'Configured document search source' },
          { value: 'workspace', label: 'Current workspace/repo files' },
          { value: 'web', label: 'Web search' },
        ],
      },
      intent: {
        route: 'search_task',
        operation: 'search',
        originalUserContent: 'Search documents for any JSON files and list them out',
      },
    });
    const continuityThread = makeContinuityThread();

    const context = filterIntentGatewayClassificationContext({
      content: 'Configure Document Search Source',
      pendingAction,
      continuityThread,
    });

    expect(context.pendingAction).toBe(pendingAction);
    expect(context.continuityThread).toBe(continuityThread);
    expect(context.contextSuppressed).toBe(false);
  });

  it('keeps query clarification context for concise search-topic answers', () => {
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'clarification',
        field: 'query',
        prompt: 'What should I search the web for?',
      },
      intent: {
        route: 'search_task',
        operation: 'search',
        originalUserContent: 'Go out to the internet and find useful information from various sites.',
      },
    });
    const continuityThread = makeContinuityThread();

    const context = filterIntentGatewayClassificationContext({
      content: 'Artificial Intelligence',
      pendingAction,
      continuityThread,
    });

    expect(context.pendingAction).toBe(pendingAction);
    expect(context.continuityThread).toBe(continuityThread);
    expect(context.contextSuppressed).toBe(false);
  });

  it('still suppresses query clarification context for long self-contained replacement requests', () => {
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'clarification',
        field: 'query',
        prompt: 'What should I search the web for?',
      },
      intent: {
        route: 'search_task',
        operation: 'search',
        originalUserContent: 'Go out to the internet and find useful information from various sites.',
      },
    });

    const context = filterIntentGatewayClassificationContext({
      content: 'Ignore that pending web search clarification and instead inspect the current workspace architecture docs, summarize the routing design, list changed files, and do not browse the internet.',
      pendingAction,
      continuityThread: makeContinuityThread(),
    });

    expect(context.pendingAction).toBeNull();
    expect(context.contextSuppressed).toBe(true);
  });

  it('rewrites query clarification answers back onto the original blocked search request', () => {
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'clarification',
        field: 'query',
        prompt: 'What should I search the web for?',
      },
      intent: {
        route: 'search_task',
        operation: 'search',
        originalUserContent: 'Go out to the internet and find useful information from various sites.',
      },
    });

    expect(resolvePendingActionContinuationContent(
      'Artificial Intelligence',
      pendingAction,
    )).toBe(
      'Use "Artificial Intelligence" as the search query for this request: Go out to the internet and find useful information from various sites.',
    );
  });

  it('rewrites search-surface clarification answers to the selected source', () => {
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'clarification',
        field: 'search_surface',
        options: [
          { value: 'configured_documents', label: 'Configured document search source' },
          { value: 'workspace', label: 'Current workspace/repo files' },
          { value: 'web', label: 'Web search' },
        ],
      },
      intent: {
        route: 'search_task',
        operation: 'search',
        originalUserContent: 'Search documents for any JSON files and list them out',
      },
    });

    expect(resolveIntentGatewayContent({
      gateway: makeGatewayRecord({
        route: 'search_task',
        turnRelation: 'new_request',
      }),
      currentContent: 'Configure Document Search Source',
      pendingAction,
      priorHistory: [],
    })).toBe(
      'Search the configured document search source for this request: Search documents for any JSON files and list them out',
    );

    expect(resolveIntentGatewayContent({
      gateway: makeGatewayRecord({
        route: 'search_task',
        turnRelation: 'new_request',
      }),
      currentContent: 'Current workspace/repo files',
      pendingAction,
      priorHistory: [],
    })).toBe(
      'Search the current workspace/repo files for this request: Search documents for any JSON files and list them out',
    );

    expect(resolveIntentGatewayContent({
      gateway: makeGatewayRecord({
        route: 'search_task',
        turnRelation: 'new_request',
      }),
      currentContent: 'web search',
      pendingAction,
      priorHistory: [],
    })).toBe(
      'Use web search for this request: Search documents for any JSON files and list them out',
    );
  });

  it('does not create a duplicate search-surface clarification for UI option aliases', () => {
    const setClarificationPendingAction = vi.fn(() => ({}));
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'clarification',
        field: 'search_surface',
        options: [
          { value: 'configured_documents', label: 'Configured document search source' },
          { value: 'workspace', label: 'Current workspace/repo files' },
          { value: 'web', label: 'Web search' },
        ],
      },
      intent: {
        route: 'search_task',
        operation: 'search',
        originalUserContent: 'Search documents for any JSON files and list them out',
      },
    });

    const response = buildGatewayClarificationResponse(
      {
        gateway: makeGatewayRecord({
          route: 'search_task',
          operation: 'search',
          resolution: 'needs_clarification',
          missingFields: ['search_surface'],
        }),
        surfaceUserId: 'user-1',
        surfaceChannel: 'web',
        surfaceId: 'web-guardian-chat',
        message: makeMessage('Configure Document Search Source'),
        activeSkills: [],
        pendingAction,
      },
      {
        buildImmediateResponseMetadata: () => undefined,
        setClarificationPendingAction,
        recordIntentRoutingTrace: () => undefined,
        toPendingActionEntities,
      },
    );

    expect(response).toBeNull();
    expect(setClarificationPendingAction).not.toHaveBeenCalled();
  });

  it('does not rewrite new-request coding-backend follow-ups even when an active execution exists', () => {
    const gateway = makeGatewayRecord({
      route: 'coding_task',
      turnRelation: 'new_request',
      entities: {
        codingBackend: 'claude-code',
      },
    });

    expect(resolveIntentGatewayContent({
      gateway,
      currentContent: 'Okay now do the same thing with Claude Code',
      pendingAction: null,
      priorHistory: [
        { role: 'assistant', content: 'This repo is GuardianAgent.' },
        { role: 'user', content: 'Okay now do the same thing with Claude Code' },
      ],
      activeExecution: makeExecutionRecord(),
    })).toBeNull();
  });

  it('resumes workspace-switch pending actions once the target session is active', () => {
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'workspace_switch',
        prompt: 'Switch workspaces first.',
        targetSessionId: 'session-123',
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        originalUserContent: 'Implement the uplift in the current workspace.',
      },
    });

    expect(resolvePendingActionContinuationContent(
      'continue',
      pendingAction,
      'session-123',
    )).toBe('Implement the uplift in the current workspace.');
  });

  it('restores the last actionable request after retryable provider failures', () => {
    expect(resolveRetryAfterFailureContinuationContent({
      content: 'retry',
      continuityThread: makeContinuityThread({
        lastActionableRequest: 'Check my unread email.',
      }),
    })).toBe('Check my unread email.');
  });

  it('does not treat fresh requests about retry policy as retry continuations', () => {
    expect(resolveRetryAfterFailureContinuationContent({
      content: 'Inspect this repo and tell me which files implement delegated worker retry policy. Do not edit anything.',
      continuityThread: makeContinuityThread({
        lastActionableRequest: 'Read local credential files and print raw values.',
      }),
      activeExecution: makeExecutionRecord({
        intent: {
          route: 'security_task',
          operation: 'read',
          originalUserContent: 'Read local credential files and print raw values.',
        },
      }),
    })).toBeNull();
  });

  it('restores the last actionable request after sandbox prerequisite failures are cleared', () => {
    expect(resolveRetryAfterFailureContinuationContent({
      content: "I've started that Daytona Sandbox so try again with the same request",
      continuityThread: makeContinuityThread({
        lastActionableRequest: 'In the Guardian workspace, run `pwd` in the remote sandbox using the Daytona profile for this coding session and report exact stdout.',
      }),
    })).toBe('In the Guardian workspace, run `pwd` in the remote sandbox using the Daytona profile for this coding session and report exact stdout.');
  });

  it('prefers active execution content over continuity fallback for retry continuations', () => {
    expect(resolveRetryAfterFailureContinuationContent({
      content: 'retry',
      continuityThread: makeContinuityThread({
        lastActionableRequest: 'Tell me what coding session is currently active.',
      }),
      activeExecution: makeExecutionRecord({
        intent: {
          route: 'coding_task',
          operation: 'sandbox_run',
          originalUserContent: 'In the Guardian workspace, run `pwd` in the remote sandbox using the Daytona profile for this coding session and report exact stdout.',
        },
      }),
    })).toBe('In the Guardian workspace, run `pwd` in the remote sandbox using the Daytona profile for this coding session and report exact stdout.');
  });

  it('does not require assistant failure text when continuity already points at the resumable request', () => {
    expect(resolveRetryAfterFailureContinuationContent({
      content: "I've started that Daytona sandbox, try again with the same request.",
      continuityThread: makeContinuityThread({
        lastActionableRequest: 'In the Guardian workspace, run `pwd` in the remote sandbox using the Daytona profile for this coding session and report exact stdout.',
      }),
    })).toBe('In the Guardian workspace, run `pwd` in the remote sandbox using the Daytona profile for this coding session and report exact stdout.');
  });

  it('resolves generic resume-the-last-task requests against the active execution', () => {
    expect(resolveRetryAfterFailureContinuationContent({
      content: 'Resume the last task and finish it.',
      continuityThread: makeContinuityThread({
        lastActionableRequest: 'Tell me what coding session is currently active.',
      }),
      activeExecution: makeExecutionRecord({
        intent: {
          route: 'coding_task',
          operation: 'inspect',
          originalUserContent: 'Inspect src/runtime/intent-gateway.ts and summarize the orchestration changes.',
        },
      }),
    })).toBe('Inspect src/runtime/intent-gateway.ts and summarize the orchestration changes.');
  });

  it('returns null when there is no execution-backed retry target', () => {
    expect(resolveRetryAfterFailureContinuationContent({
      content: 'retry',
      continuityThread: null,
      activeExecution: null,
    })).toBeNull();
  });

  it('delegates affirmative workspace-switch replies to the attach handler', async () => {
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'workspace_switch',
        prompt: 'Switch workspaces first.',
        targetSessionId: 'session-999',
      },
    });
    const handleCodeSessionAttach = vi.fn(async () => ({ content: 'Attached to workspace.' }));

    const response = await tryHandleWorkspaceSwitchContinuation({
      message: makeMessage('yes'),
      ctx: TEST_CONTEXT,
      pendingAction,
      handleCodeSessionAttach,
    });

    expect(handleCodeSessionAttach).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'yes' }),
      TEST_CONTEXT,
      'session-999',
    );
    expect(response).toEqual({ content: 'Attached to workspace.' });
  });

  it('switches the active pending action when the user confirms a replacement', async () => {
    const pendingAction = makePendingAction({
      blocker: {
        kind: 'clarification',
        prompt: 'Original blocked request.',
      },
      resume: {
        kind: 'execution_graph',
        payload: {
          graphId: 'graph-previous',
          nodeId: 'node-previous',
          resumeToken: 'resume-previous',
          artifactIds: [],
        },
      },
    });
    const replacement = makePendingAction({
      blocker: {
        kind: 'clarification',
        prompt: 'Replacement blocked request.',
      },
      intent: {
        route: 'coding_task',
        operation: 'update',
        originalUserContent: 'Refactor the gateway helpers.',
      },
    });

    const response = await tryHandlePendingActionSwitchDecision({
      message: makeMessage('switch to the new one'),
      pendingAction,
      gateway: makeGatewayRecord({
        route: 'coding_task',
      }),
      activeSkills: [],
      surfaceUserId: 'user-1',
      surfaceChannel: 'web',
      surfaceId: 'web-guardian-chat',
      readPendingActionSwitchCandidatePayload: () => ({
        type: 'pending_action_switch_candidate',
        previousResume: pendingAction.resume,
        replacement: {
          status: replacement.status,
          transferPolicy: replacement.transferPolicy,
          blocker: replacement.blocker,
          intent: replacement.intent,
          resume: replacement.resume,
          expiresAt: replacement.expiresAt,
        },
      }),
      replacePendingAction: (_userId, _channel, _surfaceId, nextReplacement) => ({
        ...replacement,
        id: nextReplacement.id,
      }),
      updatePendingAction: () => pendingAction,
      buildImmediateResponseMetadata: () => ({ pendingAction: { id: 'pending-1' } }),
    });

    expect(response?.content).toBe('Switched the active blocked request.\n\nReplacement blocked request.');
    expect(response?.metadata).toMatchObject({
      pendingAction: { id: 'pending-1' },
      intentGateway: expect.any(Object),
    });
  });

  it('sanitizes placeholder switch prompts before echoing them back to the user', async () => {
    const pendingAction = makePendingAction();
    const replacement = makePendingAction({
      blocker: {
        kind: 'clarification',
        prompt: 'No classification summary provided.',
      },
      intent: {
        route: 'email_task',
        operation: 'read',
        originalUserContent: 'Check my email.',
      },
    });

    const response = await tryHandlePendingActionSwitchDecision({
      message: makeMessage('yes'),
      pendingAction,
      gateway: makeGatewayRecord({
        route: 'email_task',
      }),
      activeSkills: [],
      surfaceUserId: 'user-1',
      surfaceChannel: 'web',
      surfaceId: 'web-guardian-chat',
      readPendingActionSwitchCandidatePayload: () => ({
        type: 'pending_action_switch_candidate',
        replacement: {
          status: replacement.status,
          transferPolicy: replacement.transferPolicy,
          blocker: replacement.blocker,
          intent: replacement.intent,
          expiresAt: replacement.expiresAt,
        },
      }),
      replacePendingAction: () => replacement,
      updatePendingAction: () => pendingAction,
      buildImmediateResponseMetadata: () => undefined,
    });

    expect(response?.content).toBe(
      'Switched the active blocked request.\n\nI need a bit more detail before I can continue with that request.',
    );
  });

  it('normalizes pending action entities and only clears satisfied clarifications', () => {
    const rawEntities = {
      urls: ['https://example.test'],
      query: undefined,
    };
    const normalizedEntities = toPendingActionEntities(rawEntities);

    expect(normalizedEntities).toEqual({
      urls: ['https://example.test'],
    });
    expect(normalizedEntities?.urls).not.toBe(rawEntities.urls);

    const pendingAction = makePendingAction({
      blocker: {
        kind: 'clarification',
        field: 'email_provider',
      },
      intent: {
        route: 'email_task',
      },
    });

    expect(shouldClearPendingActionAfterTurn(
      makeGatewayRecord({
        route: 'email_task',
        turnRelation: 'follow_up',
        entities: {
          emailProvider: 'm365',
        },
      }).decision,
      pendingAction,
    )).toBe(true);

    expect(shouldClearPendingActionAfterTurn(
      makeGatewayRecord({
        route: 'email_task',
        turnRelation: 'follow_up',
        entities: {},
      }).decision,
      pendingAction,
    )).toBe(false);

    const pathPendingAction = makePendingAction({
      blocker: {
        kind: 'clarification',
        field: 'path',
      },
      intent: {
        route: 'filesystem_task',
      },
    });

    expect(shouldClearPendingActionAfterTurn(
      makeGatewayRecord({
        route: 'filesystem_task',
        turnRelation: 'clarification_answer',
        entities: {
          path: 'tmp/brokered-test.txt',
        },
      }).decision,
      pathPendingAction,
    )).toBe(true);
  });
});
