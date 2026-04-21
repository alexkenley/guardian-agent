import { describe, expect, it } from 'vitest';

import { normalizeIntentGatewayDecision } from './structured-recovery.js';
import { repairUnavailableIntentGatewayDecision } from './unstructured-recovery.js';

describe('repairUnavailableIntentGatewayDecision', () => {
  it('recovers workspace-scoped search plus append requests as filesystem updates', () => {
    const decision = repairUnavailableIntentGatewayDecision(
      {
        sourceContent: 'Search the workspace for SPECIAL_INDEXED_MATCH. Tell me the highest-numbered matching file, then append WEBUI_SEARCH_TEST_OK to that file.',
      },
      {
        route: 'unknown',
        operation: 'unknown',
        confidence: 'low',
      },
      normalizeIntentGatewayDecision,
    );

    expect(decision).toMatchObject({
      route: 'filesystem_task',
      operation: 'update',
    });
    expect(decision?.provenance?.route).toBe('repair.unstructured');
  });

  it('recovers directory-scoped list plus rename requests as filesystem updates with the target path', () => {
    const decision = repairUnavailableIntentGatewayDecision(
      {
        sourceContent: 'List tmp/webui-remediation/search-many, tell me the last five filenames in sorted order, then rename the last file to note-50-renamed.txt.',
      },
      {
        route: 'unknown',
        operation: 'unknown',
        confidence: 'low',
      },
      normalizeIntentGatewayDecision,
    );

    expect(decision).toMatchObject({
      route: 'filesystem_task',
      operation: 'update',
    });
    expect(decision?.entities.path).toBe('tmp/webui-remediation/search-many');
  });
});
