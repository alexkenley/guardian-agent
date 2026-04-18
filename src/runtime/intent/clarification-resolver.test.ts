import { describe, expect, it } from 'vitest';
import { repairIntentGatewayOperation, repairIntentGatewayRoute } from './clarification-resolver.js';
import type { IntentGatewayRepairContext } from './types.js';

describe('clarification-resolver', () => {
  it('pins clarification answers back to the pending personal-assistant route and operation', () => {
    const repairContext: IntentGatewayRepairContext = {
      sourceContent: 'JORDAN LEE',
      pendingAction: {
        id: 'pa-1',
        status: 'pending',
        blockerKind: 'clarification',
        field: 'query',
        route: 'personal_assistant_task',
        operation: 'read',
        prompt: 'Who is this contact?',
        originalRequest: ' jordan lee',
        transferPolicy: 'always',
      },
    };

    const route = repairIntentGatewayRoute(
      'personal_assistant_task',
      'search',
      'clarification_answer',
      repairContext,
    );
    const operation = repairIntentGatewayOperation(
      'search',
      route,
      'clarification_answer',
      repairContext,
    );

    expect(route).toBe('personal_assistant_task');
    expect(operation).toBe('read');
  });

  it('repairs remote sandbox requests away from coding_session_control', () => {
    const repairContext: IntentGatewayRepairContext = {
      sourceContent: 'In the Guardian workspace, run `pwd` in the remote sandbox using the Daytona profile for this coding session.',
    };

    const route = repairIntentGatewayRoute(
      'coding_session_control',
      'navigate',
      'new_request',
      repairContext,
    );
    const operation = repairIntentGatewayOperation(
      'navigate',
      route,
      'new_request',
      repairContext,
    );

    expect(route).toBe('coding_task');
    expect(operation).toBe('run');
  });

  it('repairs npm install requests misclassified as coding_session_control', () => {
    const repairContext: IntentGatewayRepairContext = {
      sourceContent: 'Run npm install in the GuardianAgent root directory.',
    };

    const route = repairIntentGatewayRoute(
      'coding_session_control',
      'run',
      'new_request',
      repairContext,
    );
    const operation = repairIntentGatewayOperation(
      'run',
      route,
      'new_request',
      repairContext,
    );

    expect(route).toBe('coding_task');
    expect(operation).toBe('run');
  });

  it('repairs repo inspection requests misclassified as coding_session_control', () => {
    const repairContext: IntentGatewayRepairContext = {
      sourceContent: 'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.',
    };

    const route = repairIntentGatewayRoute(
      'coding_session_control',
      'inspect',
      'new_request',
      repairContext,
    );
    const operation = repairIntentGatewayOperation(
      'inspect',
      route,
      'new_request',
      repairContext,
    );

    expect(route).toBe('coding_task');
    expect(operation).toBe('inspect');
  });

  it('repairs explicit workspace-scoped repo work away from coding_session_control', () => {
    const repairContext: IntentGatewayRepairContext = {
      sourceContent: 'Use Codex in the Test Tactical Game App coding workspace to create test-switch-a in the top-level directory.',
    };

    const route = repairIntentGatewayRoute(
      'coding_session_control',
      'create',
      'new_request',
      repairContext,
    );
    const operation = repairIntentGatewayOperation(
      'create',
      route,
      'new_request',
      repairContext,
    );

    expect(route).toBe('coding_task');
    expect(operation).toBe('create');
  });

  it('keeps provider inventory follow-ups in the provider-config lane', () => {
    const repairContext: IntentGatewayRepairContext = {
      sourceContent: 'Show me the configured AI providers and model catalog.',
    };

    const route = repairIntentGatewayRoute(
      'unknown',
      'unknown',
      'new_request',
      repairContext,
    );
    const operation = repairIntentGatewayOperation(
      'unknown',
      route,
      'new_request',
      repairContext,
    );

    expect(route).toBe('general_assistant');
    expect(operation).toBe('inspect');
  });

  it('does not rewrite transcript-reference note requests into personal-assistant work', () => {
    const repairContext: IntentGatewayRepairContext = {
      sourceContent: 'Using the very first answer in this chat, give me a 5-bullet handoff note for another engineer. Do not re-search the repo.',
    };

    const route = repairIntentGatewayRoute(
      'general_assistant',
      'create',
      'new_request',
      repairContext,
    );
    const operation = repairIntentGatewayOperation(
      'create',
      route,
      'new_request',
      repairContext,
    );

    expect(route).toBe('general_assistant');
    expect(operation).toBe('create');
  });

  it('prefers explicit automation authoring over stale routine continuity', () => {
    const repairContext: IntentGatewayRepairContext = {
      sourceContent: 'Create a deterministic scheduled automation named "Example Nav Check". Run it weekdays at 8:30 AM. Use built-in browser tools only to open https://example.com, extract the top navigation links, and notify me in web only when the labels change. Do not create an assistant automation.',
      continuity: {
        continuityKey: 'chat:owner',
        linkedSurfaceCount: 1,
        focusSummary: 'Updates a Second Brain routine.',
        lastActionableRequest: 'Rename that new routine to Friday Harbor Review and run it weekdays at 6 pm.',
      },
    };

    const route = repairIntentGatewayRoute(
      'personal_assistant_task',
      'update',
      'follow_up',
      repairContext,
    );
    const operation = repairIntentGatewayOperation(
      'update',
      route,
      'follow_up',
      repairContext,
    );

    expect(route).toBe('automation_authoring');
    expect(operation).toBe('create');
  });

  it('repairs explicit filesystem writes that were misclassified as reads', () => {
    const repairContext: IntentGatewayRepairContext = {
      sourceContent: 'In this workspace, write a short report to C:\\Sensitive\\round2-approval.txt and continue once approval is granted.',
    };

    const operation = repairIntentGatewayOperation(
      'read',
      'filesystem_task',
      'new_request',
      repairContext,
    );

    expect(operation).toBe('create');
  });
});
