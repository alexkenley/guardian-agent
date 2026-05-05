import { describe, expect, it } from 'vitest';
import { repairIntentGatewayOperation, repairIntentGatewayRoute } from './clarification-resolver.js';
import type { IntentGatewayRepairContext } from './types.js';

describe('clarification-resolver', () => {
  it('pins clarification answers back to the pending personal-assistant route and operation', () => {
    const repairContext: IntentGatewayRepairContext = {
      sourceContent: 'EXAMPLE CONTACT',
      pendingAction: {
        id: 'pa-1',
        status: 'pending',
        blockerKind: 'clarification',
        field: 'query',
        route: 'personal_assistant_task',
        operation: 'read',
        prompt: 'Who is this contact?',
        originalRequest: ' example contact',
        transferPolicy: 'always',
      },
    };

    const route = repairIntentGatewayRoute(
      'personal_assistant_task',
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

  it('does not reclassify new requests from content after the gateway decision', () => {
    const repairContext: IntentGatewayRepairContext = {
      sourceContent: 'In the sample workspace, run `pwd` in the remote sandbox using the Daytona profile for this coding session.',
    };

    const route = repairIntentGatewayRoute(
      'coding_session_control',
      'new_request',
      repairContext,
    );
    const operation = repairIntentGatewayOperation(
      'navigate',
      route,
      'new_request',
      repairContext,
    );

    expect(route).toBe('coding_session_control');
    expect(operation).toBe('navigate');
  });

  it('keeps the gateway route and operation when there is no pending clarification state', () => {
    const repairContext: IntentGatewayRepairContext = {
      sourceContent: 'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.',
    };

    const route = repairIntentGatewayRoute(
      'general_assistant',
      'new_request',
      repairContext,
    );
    const operation = repairIntentGatewayOperation(
      'inspect',
      route,
      'new_request',
      repairContext,
    );

    expect(route).toBe('general_assistant');
    expect(operation).toBe('inspect');
  });
});
