import { describe, expect, it } from 'vitest';
import {
  PendingActionStore,
  clearApprovalIdFromPendingAction,
  defaultPendingActionTransferPolicy,
  isPendingActionActive,
  reconcilePendingApprovalAction,
  summarizePendingActionForGateway,
  toPendingActionClientMetadata,
  type PendingActionRecord,
  type PendingActionScope,
} from './pending-actions.js';

function createScope(): PendingActionScope {
  return {
    agentId: 'local',
    userId: 'user-1',
    channel: 'web',
    surfaceId: 'surface-1',
  };
}

function createStore(nowMs = 1_710_000_000_000): PendingActionStore {
  return new PendingActionStore({
    enabled: false,
    sqlitePath: '/tmp/guardianagent-pending-actions.test.sqlite',
    now: () => nowMs,
  });
}

function createRecord(overrides?: Partial<PendingActionRecord>): Omit<PendingActionRecord, 'id' | 'createdAt' | 'updatedAt' | 'scope'> {
  return {
    status: 'pending',
    transferPolicy: defaultPendingActionTransferPolicy('clarification'),
    blocker: {
      kind: 'clarification',
      prompt: 'Which provider should I use?',
      field: 'email_provider',
      options: [
        { value: 'gws', label: 'Gmail' },
        { value: 'm365', label: 'Outlook' },
      ],
    },
    intent: {
      route: 'email_task',
      operation: 'read',
      originalUserContent: 'Check my email.',
      entities: { emailProvider: undefined },
    },
    expiresAt: 1_710_000_000_000 + 30 * 60 * 1000,
    ...(overrides ? {
      ...(overrides.status ? { status: overrides.status } : {}),
      ...(overrides.transferPolicy ? { transferPolicy: overrides.transferPolicy } : {}),
      ...(overrides.blocker ? { blocker: overrides.blocker } : {}),
      ...(overrides.intent ? { intent: overrides.intent } : {}),
      ...(overrides.resume ? { resume: overrides.resume } : {}),
      ...(overrides.graphInterrupt ? { graphInterrupt: overrides.graphInterrupt } : {}),
      ...(overrides.executionId ? { executionId: overrides.executionId } : {}),
      ...(overrides.rootExecutionId ? { rootExecutionId: overrides.rootExecutionId } : {}),
      ...(overrides.codeSessionId ? { codeSessionId: overrides.codeSessionId } : {}),
      ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {}),
    } : {}),
  };
}

describe('PendingActionStore', () => {
  it('stores and returns the active pending action for a scope', () => {
    const store = createStore();
    const scope = createScope();
    const created = store.replaceActive(scope, createRecord());

    const active = store.getActive(scope);

    expect(active).not.toBeNull();
    expect(active?.id).toBe(created.id);
    expect(active?.blocker.kind).toBe('clarification');
    expect(active?.intent.originalUserContent).toBe('Check my email.');
  });

  it('preserves execution identity metadata on stored pending actions', () => {
    const store = createStore();
    const scope = createScope();

    const created = store.replaceActive(scope, createRecord({
      executionId: 'exec-1',
      rootExecutionId: 'exec-root-1',
    }));

    expect(store.get(created.id)).toMatchObject({
      executionId: 'exec-1',
      rootExecutionId: 'exec-root-1',
    });
    expect(toPendingActionClientMetadata(created)).toMatchObject({
      executionId: 'exec-1',
      rootExecutionId: 'exec-root-1',
    });
  });

  it('preserves execution graph interrupt metadata on stored pending actions', () => {
    const store = createStore();
    const scope = createScope();

    const created = store.replaceActive(scope, createRecord({
      resume: {
        kind: 'execution_graph',
        payload: {
          graphId: 'graph-1',
          nodeId: 'node-mutate',
          resumeToken: 'resume-1',
          artifactIds: ['write-spec-1'],
        },
      },
      graphInterrupt: {
        graphId: 'graph-1',
        nodeId: 'node-mutate',
        nodeKind: 'mutate',
        resumeToken: 'resume-1',
        artifactRefs: [{
          artifactId: 'write-spec-1',
          graphId: 'graph-1',
          nodeId: 'node-synthesize',
          artifactType: 'WriteSpec',
          label: 'Write spec',
          preview: 'Write tmp/report.txt.',
          trustLevel: 'trusted',
          redactionPolicy: 'exact_content_not_for_timeline',
          createdAt: 123,
        }],
      },
    }));

    expect(store.get(created.id)).toMatchObject({
      resume: {
        kind: 'execution_graph',
        payload: {
          graphId: 'graph-1',
          nodeId: 'node-mutate',
          resumeToken: 'resume-1',
          artifactIds: ['write-spec-1'],
        },
      },
      graphInterrupt: {
        graphId: 'graph-1',
        nodeId: 'node-mutate',
        nodeKind: 'mutate',
        resumeToken: 'resume-1',
        artifactRefs: [{ artifactId: 'write-spec-1', artifactType: 'WriteSpec' }],
      },
    });
    expect(toPendingActionClientMetadata(created)).toMatchObject({
      graphInterrupt: {
        graphId: 'graph-1',
        nodeId: 'node-mutate',
        resumeToken: 'resume-1',
        artifactRefs: [{ artifactId: 'write-spec-1', artifactType: 'WriteSpec' }],
      },
    });
    expect(summarizePendingActionForGateway(created)).toMatchObject({
      graphInterrupt: {
        graphId: 'graph-1',
        nodeId: 'node-mutate',
        resumeToken: 'resume-1',
      },
    });
  });

  it('replaces the active pending action and cancels the older one', () => {
    const store = createStore();
    const scope = createScope();
    const first = store.replaceActive(scope, createRecord());
    const second = store.replaceActive(scope, createRecord({
      blocker: {
        kind: 'workspace_switch',
        prompt: 'Switch to Test Tactical Game App first.',
        targetSessionId: 'session-2',
        targetSessionLabel: 'Test Tactical Game App',
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        originalUserContent: 'Use Codex in Test Tactical Game App to create a file.',
      },
    }));

    const firstRecord = store.get(first.id);
    const active = store.getActive(scope);

    expect(firstRecord?.status).toBe('cancelled');
    expect(active?.id).toBe(second.id);
    expect(active?.blocker.kind).toBe('workspace_switch');
  });

  it('finds active approval blockers by approval id', () => {
    const store = createStore();
    const scope = createScope();
    const created = store.replaceActive(scope, createRecord({
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the coding backend run.',
        approvalIds: ['approval-1'],
        approvalSummaries: [
          { id: 'approval-1', toolName: 'coding_backend_run', argsPreview: '{"backend":"codex"}', actionLabel: 'run Codex' },
        ],
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        originalUserContent: 'Use Codex to create a file.',
      },
    }));

    const match = store.findActiveByApprovalId('approval-1');

    expect(match?.id).toBe(created.id);
    expect(match?.blocker.kind).toBe('approval');
  });

  it('clears a single approval id from an active approval blocker', () => {
    const store = createStore();
    const scope = createScope();
    const created = store.replaceActive(scope, createRecord({
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the coding backend run.',
        approvalIds: ['approval-1', 'approval-2'],
        approvalSummaries: [
          { id: 'approval-1', toolName: 'coding_backend_run', argsPreview: '{"backend":"codex"}', actionLabel: 'run Codex' },
          { id: 'approval-2', toolName: 'fs_write', argsPreview: '{"path":"./tmp/test.txt"}', actionLabel: 'write ./tmp/test.txt' },
        ],
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        originalUserContent: 'Use Codex to create a file.',
      },
    }));

    const updated = clearApprovalIdFromPendingAction(store, 'approval-1', created.updatedAt + 1);

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('pending');
    expect(updated?.blocker.approvalIds).toEqual(['approval-2']);
    expect(updated?.blocker.approvalSummaries).toEqual([
      { id: 'approval-2', toolName: 'fs_write', argsPreview: '{"path":"./tmp/test.txt"}', actionLabel: 'write ./tmp/test.txt' },
    ]);
    expect(store.get(created.id)?.blocker.approvalIds).toEqual(['approval-2']);
  });

  it('completes the pending action when the last approval id is cleared', () => {
    const store = createStore();
    const scope = createScope();
    const created = store.replaceActive(scope, createRecord({
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the coding backend run.',
        approvalIds: ['approval-1'],
        approvalSummaries: [
          { id: 'approval-1', toolName: 'coding_backend_run', argsPreview: '{"backend":"codex"}', actionLabel: 'run Codex' },
        ],
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        originalUserContent: 'Use Codex to create a file.',
      },
    }));

    const completed = clearApprovalIdFromPendingAction(store, 'approval-1', created.updatedAt + 1);

    expect(completed).not.toBeNull();
    expect(completed?.status).toBe('completed');
    expect(isPendingActionActive(completed?.status ?? 'expired')).toBe(false);
    expect(store.get(created.id)?.status).toBe('completed');
  });

  it('clears duplicated active pending actions for the same approval id', () => {
    const store = createStore();
    const scope = createScope();
    const first = store.replaceActive(scope, createRecord({
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the write.',
        approvalIds: ['approval-1'],
        approvalSummaries: [
          { id: 'approval-1', toolName: 'fs_write', argsPreview: '{"path":"./tmp/test.txt"}', actionLabel: 'write ./tmp/test.txt' },
        ],
      },
      intent: {
        route: 'filesystem_task',
        operation: 'create',
        originalUserContent: 'Create a file.',
      },
    }));
    const second = store.replaceActive({
      ...scope,
      surfaceId: 'surface-2',
    }, createRecord({
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the same write.',
        approvalIds: ['approval-1'],
        approvalSummaries: [
          { id: 'approval-1', toolName: 'fs_write', argsPreview: '{"path":"./tmp/test.txt"}', actionLabel: 'write ./tmp/test.txt' },
        ],
      },
      intent: {
        route: 'filesystem_task',
        operation: 'create',
        originalUserContent: 'Create a file.',
      },
    }));

    const completed = clearApprovalIdFromPendingAction(store, 'approval-1', second.updatedAt + 1);

    expect(completed).not.toBeNull();
    expect(store.get(first.id)?.status).toBe('completed');
    expect(store.get(second.id)?.status).toBe('completed');
    expect(store.findActiveByApprovalId('approval-1')).toBeNull();
  });

  it('reconciles stale approval blockers against the live approval queue', () => {
    const store = createStore();
    const scope = createScope();
    const created = store.replaceActive(scope, createRecord({
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the coding backend run.',
        approvalIds: ['approval-1', 'approval-2'],
        approvalSummaries: [
          { id: 'approval-1', toolName: 'coding_backend_run', argsPreview: '{"backend":"codex"}', actionLabel: 'run Codex' },
          { id: 'approval-2', toolName: 'fs_write', argsPreview: '{"path":"./tmp/test.txt"}', actionLabel: 'write ./tmp/test.txt' },
        ],
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        originalUserContent: 'Use Codex to create a file.',
      },
    }));

    const reconciled = reconcilePendingApprovalAction(store, created, {
      liveApprovalIds: ['approval-2'],
      liveApprovalSummaries: new Map([
        ['approval-2', {
          toolName: 'fs_write',
          argsPreview: '{"path":"./tmp/test.txt","append":false}',
          actionLabel: 'write ./tmp/test.txt',
        }],
      ]),
      nowMs: created.updatedAt + 1,
    });

    expect(reconciled?.status).toBe('pending');
    expect(reconciled?.blocker.approvalIds).toEqual(['approval-2']);
    expect(reconciled?.blocker.approvalSummaries).toEqual([
      {
        id: 'approval-2',
        toolName: 'fs_write',
        argsPreview: '{"path":"./tmp/test.txt","append":false}',
        actionLabel: 'write ./tmp/test.txt',
      },
    ]);
  });

  it('promotes a stale clarification blocker to a live approval blocker on the same surface', () => {
    const store = createStore();
    const scope = createScope();
    const created = store.replaceActive(scope, createRecord({
      blocker: {
        kind: 'clarification',
        prompt: 'I can use either Google Workspace (Gmail) or Microsoft 365 (Outlook) for that email task. Which one do you want me to use?',
        field: 'email_provider',
        options: [
          { value: 'gws', label: 'Gmail' },
          { value: 'm365', label: 'Outlook' },
        ],
      },
      intent: {
        route: 'email_task',
        operation: 'read',
        originalUserContent: 'Check my email.',
      },
    }));

    const reconciled = reconcilePendingApprovalAction(store, created, {
      liveApprovalIds: ['approval-gmail-1'],
      liveApprovalSummaries: new Map([
        ['approval-gmail-1', {
          toolName: 'gws - gmail users messages list',
          argsPreview: '{"userId":"me","maxResults":10}',
          actionLabel: 'run Gmail inbox read',
        }],
      ]),
      scope,
      nowMs: created.updatedAt + 1,
    });

    expect(reconciled?.blocker.kind).toBe('approval');
    expect(reconciled?.blocker.prompt).toBe('Waiting for approval to run Gmail inbox read.');
    expect(reconciled?.blocker.approvalIds).toEqual(['approval-gmail-1']);
    expect(reconciled?.intent).toMatchObject({
      route: 'email_task',
      operation: 'read',
      originalUserContent: 'Check my email.',
    });
    expect(store.getActive(scope)?.blocker.kind).toBe('approval');
  });

  it('completes stale approval blockers when none of their approval ids are still live', () => {
    const store = createStore();
    const scope = createScope();
    const created = store.replaceActive(scope, createRecord({
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the coding backend run.',
        approvalIds: ['approval-1'],
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        originalUserContent: 'Use Codex to create a file.',
      },
    }));

    const reconciled = reconcilePendingApprovalAction(store, created, {
      liveApprovalIds: [],
      nowMs: created.updatedAt + 1,
    });

    expect(reconciled?.status).toBe('completed');
    expect(store.get(created.id)?.status).toBe('completed');
  });

  it('keeps cross-scope pending approvals alive when scoped liveApprovalIds misses them but they are still pending globally', () => {
    const store = createStore();
    const scope = createScope();
    const created = store.replaceActive(scope, createRecord({
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the Codex run.',
        approvalIds: ['approval-codesession-1'],
      },
      intent: {
        route: 'coding_task',
        operation: 'update',
        originalUserContent: 'Use Codex to inspect README.',
      },
    }));

    const reconciled = reconcilePendingApprovalAction(store, created, {
      liveApprovalIds: [],
      allPendingApprovalIds: ['approval-codesession-1'],
      nowMs: created.updatedAt + 1,
    });

    expect(reconciled?.status).toBe('pending');
    expect(reconciled?.id).toBe(created.id);
    expect(store.get(created.id)?.status).toBe('pending');
  });

  it('expires active records when their ttl has passed', () => {
    const nowMs = 1_710_000_000_000;
    const store = new PendingActionStore({
      enabled: false,
      sqlitePath: '/tmp/guardianagent-pending-actions-expired.test.sqlite',
      now: () => nowMs + 60_000,
    });
    const scope = createScope();
    const created = store.replaceActive(scope, createRecord({
      expiresAt: nowMs + 1_000,
    }), nowMs);

    const expired = store.get(created.id, nowMs + 60_000);

    expect(expired?.status).toBe('expired');
    expect(isPendingActionActive(expired?.status ?? 'expired')).toBe(false);
  });

  it('builds gateway and client metadata from active records', () => {
    const store = createStore();
    const scope = createScope();
    const created = store.replaceActive(scope, createRecord({
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the coding backend run.',
        approvalIds: ['approval-1'],
        approvalSummaries: [
          { id: 'approval-1', toolName: 'coding_backend_run', argsPreview: '{"backend":"codex"}', actionLabel: 'run Codex' },
        ],
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        summary: 'Runs Codex in the current coding workspace.',
        provenance: {
          route: 'classifier.primary',
          operation: 'classifier.primary',
          entities: {
            codingBackend: 'resolver.coding',
          },
        },
        originalUserContent: 'Use Codex to create a file.',
        entities: { codingBackend: 'codex' },
      },
      codeSessionId: 'session-1',
    }));

    const gatewaySummary = summarizePendingActionForGateway(created);
    const clientMetadata = toPendingActionClientMetadata(created);

    expect(gatewaySummary).toMatchObject({
      id: created.id,
      blockerKind: 'approval',
      route: 'coding_task',
      operation: 'create',
      summary: 'Runs Codex in the current coding workspace.',
      transferPolicy: 'origin_surface_only',
      provenance: {
        route: 'classifier.primary',
        entities: {
          codingBackend: 'resolver.coding',
        },
      },
    });
    expect(clientMetadata).toMatchObject({
      status: 'pending',
      transferPolicy: 'origin_surface_only',
      codeSessionId: 'session-1',
      blocker: {
        kind: 'approval',
      },
      intent: {
        provenance: {
          route: 'classifier.primary',
          entities: {
            codingBackend: 'resolver.coding',
          },
        },
      },
    });
  });

  it('sanitizes placeholder clarification prompts before exposing pending-action metadata', () => {
    const store = createStore();
    const scope = createScope();
    const created = store.replaceActive(scope, createRecord({
      blocker: {
        kind: 'clarification',
        prompt: 'No classification summary provided.',
      },
      intent: {
        route: 'general_assistant',
        operation: 'read',
        summary: 'No classification summary provided.',
        originalUserContent: 'Do the thing.',
      },
    }));

    const gatewaySummary = summarizePendingActionForGateway(created);
    const clientMetadata = toPendingActionClientMetadata(created);

    expect(gatewaySummary).toMatchObject({
      prompt: 'I need a bit more detail before I can continue with that request.',
    });
    expect(created.intent).not.toHaveProperty('summary');
    expect(store.get(created.id)?.intent).not.toHaveProperty('summary');
    expect(gatewaySummary).not.toHaveProperty('summary');
    expect(clientMetadata).toMatchObject({
      blocker: {
        prompt: 'I need a bit more detail before I can continue with that request.',
      },
    });
    expect(clientMetadata?.intent).not.toHaveProperty('summary');
  });

  it('preserves structured intent context in gateway summaries', () => {
    const store = createStore();
    const scope = createScope();
    const created = store.replaceActive(scope, createRecord({
      blocker: {
        kind: 'auth',
        prompt: 'Connect Google Workspace and then continue.',
      },
      intent: {
        route: 'workspace_task',
        operation: 'read',
        summary: 'Lists Google Calendar events for the next 7 days.',
        resolution: 'needs_clarification',
        missingFields: ['provider_auth'],
        provenance: {
          route: 'classifier.primary',
          operation: 'classifier.primary',
          entities: {
            calendarTarget: 'resolver.personal_assistant',
          },
        },
        originalUserContent: 'List my Google Calendar entries for the next 7 days.',
        entities: {
          calendarTarget: 'gws',
        },
      },
    }));

    const gatewaySummary = summarizePendingActionForGateway(created);

    expect(gatewaySummary).toMatchObject({
      route: 'workspace_task',
      operation: 'read',
      summary: 'Lists Google Calendar events for the next 7 days.',
      resolution: 'needs_clarification',
      missingFields: ['provider_auth'],
      provenance: {
        route: 'classifier.primary',
        entities: {
          calendarTarget: 'resolver.personal_assistant',
        },
      },
      entities: {
        calendarTarget: 'gws',
      },
    });
  });

  it('can resolve portable blocked work for the same assistant and user across surfaces', () => {
    const store = createStore();
    const webScope = createScope();
    const telegramScope: PendingActionScope = {
      agentId: webScope.agentId,
      userId: webScope.userId,
      channel: 'telegram',
      surfaceId: 'thread-1',
    };
    store.replaceActive(webScope, createRecord({
      transferPolicy: 'origin_surface_only',
      blocker: {
        kind: 'approval',
        prompt: 'Approve the coding backend run.',
        approvalIds: ['approval-1'],
      },
      intent: {
        route: 'coding_task',
        operation: 'create',
        originalUserContent: 'Use Codex to create a file.',
      },
    }));
    const portable = store.replaceActive(telegramScope, createRecord({
      transferPolicy: 'linked_surfaces_same_user',
      blocker: {
        kind: 'clarification',
        prompt: 'Which mail provider should I use?',
        field: 'email_provider',
      },
      intent: {
        route: 'email_task',
        operation: 'read',
        originalUserContent: 'Check my email.',
      },
    }));

    const resolved = store.resolveActiveForSurface({
      agentId: webScope.agentId,
      userId: webScope.userId,
      channel: 'cli',
      surfaceId: 'owner',
    });

    expect(resolved?.id).toBe(portable.id);
    expect(resolved?.transferPolicy).toBe('linked_surfaces_same_user');
    expect(resolved?.blocker.kind).toBe('clarification');
  });
});
