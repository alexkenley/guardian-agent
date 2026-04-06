import { describe, expect, it } from 'vitest';

import type { IntentGatewayDecision } from './intent-gateway.js';
import {
  buildRoutedIntentAdditionalSection,
  prepareToolExecutionForIntent,
} from './routed-tool-execution.js';

function repoDecision(
  overrides: Partial<IntentGatewayDecision> = {},
): IntentGatewayDecision {
  return {
    route: 'coding_task',
    confidence: 'high',
    operation: 'inspect',
    summary: 'Inspect the named repo files.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'repo_grounded',
    preferredTier: 'external',
    requiresRepoGrounding: true,
    requiresToolSynthesis: true,
    expectedContextPressure: 'medium',
    preferredAnswerPath: 'chat_synthesis',
    entities: {},
    ...overrides,
  };
}

describe('routed tool execution', () => {
  it('adds repo-grounded tool guidance for coding inspection turns', () => {
    const section = buildRoutedIntentAdditionalSection(repoDecision());

    expect(section?.content).toContain('Prefer native repo tools first: fs_search, code_symbol_search, and fs_read');
    expect(section?.content).toContain('Do not use shell_safe for grep, git grep, cat, sed');
  });

  it('denies grep-style shell inspection during repo-grounded coding review turns', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'shell_safe',
      args: {
        command: 'git grep -n "approval" -- src/tools/executor.ts',
      },
      requestText: 'Review security implications across src/tools/executor.ts and src/runtime/pending-actions.ts. Highest-risk issue first.',
      referenceTime: Date.now(),
      intentDecision: repoDecision(),
      toolDefinition: { category: 'shell', risk: 'mutating' },
    });

    expect(prepared.immediateResult).toMatchObject({
      success: false,
      status: 'denied',
    });
    expect(prepared.immediateResult?.message).toContain('Use fs_search, code_symbol_search, and fs_read instead of shell_safe');
  });

  it('denies git diff inspection when explicit files are named but the user did not ask for diff output', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'shell_safe',
      args: {
        command: 'git diff -- src/runtime/intent-gateway.ts src/runtime/execution-profiles.ts',
      },
      requestText: 'Inspect src/runtime/intent-gateway.ts and src/runtime/execution-profiles.ts. Review the routing uplift for regressions and missing tests.',
      referenceTime: Date.now(),
      intentDecision: repoDecision(),
      toolDefinition: { category: 'shell', risk: 'mutating' },
    });

    expect(prepared.immediateResult).toMatchObject({
      success: false,
      status: 'denied',
    });
  });
});
