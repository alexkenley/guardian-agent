import { describe, expect, it } from 'vitest';
import { resolveIntentCapabilityCandidates } from './capability-resolver.js';
import type { IntentGatewayDecision } from './types.js';

function mockDecision(partial: Partial<IntentGatewayDecision> & Pick<IntentGatewayDecision, 'route'>): IntentGatewayDecision {
  return {
    route: partial.route,
    confidence: partial.confidence ?? 'high',
    operation: partial.operation ?? 'unknown',
    summary: partial.summary ?? 'test',
    turnRelation: partial.turnRelation ?? 'new_request',
    resolution: partial.resolution ?? 'ready',
    missingFields: partial.missingFields ?? [],
    executionClass: partial.executionClass ?? 'direct_assistant',
    preferredTier: partial.preferredTier ?? 'local',
    requiresRepoGrounding: partial.requiresRepoGrounding ?? false,
    requiresToolSynthesis: partial.requiresToolSynthesis ?? false,
    expectedContextPressure: partial.expectedContextPressure ?? 'low',
    preferredAnswerPath: partial.preferredAnswerPath ?? 'direct',
    entities: partial.entities ?? {},
    ...(partial.plannedSteps ? { plannedSteps: partial.plannedSteps } : {}),
    ...(partial.resolvedContent ? { resolvedContent: partial.resolvedContent } : {}),
  };
}

describe('resolveIntentCapabilityCandidates', () => {
  it('maps automation authoring create requests to automation candidates', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({ route: 'automation_authoring', operation: 'create' }),
    )).toEqual(['scheduled_email_automation', 'automation']);
  });

  it('keeps automation-save plus answer authoring plans on the direct compiler path', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'automation_authoring',
        operation: 'create',
        executionClass: 'tool_orchestration',
        requiresToolSynthesis: true,
        plannedSteps: [
          {
            kind: 'write',
            summary: 'Create the requested automation.',
            expectedToolCategories: ['automation_save'],
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Tell the operator the automation is pending approval.',
            required: true,
          },
        ],
      }),
    )).toEqual(['scheduled_email_automation', 'automation']);
  });

  it('keeps generic content-derived automation steps on the automation compiler path', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'automation_authoring',
        operation: 'create',
        executionClass: 'tool_orchestration',
        requiresToolSynthesis: true,
        plannedSteps: [
          {
            kind: 'read',
            summary: 'Read the file when the saved automation runs.',
            expectedToolCategories: ['read'],
            required: true,
          },
          {
            kind: 'search',
            summary: 'Research public presence when the saved automation runs.',
            expectedToolCategories: ['search'],
            required: true,
          },
          {
            kind: 'write',
            summary: 'Write the output when the saved automation runs.',
            expectedToolCategories: ['write'],
            required: true,
          },
        ],
      }),
    )).toEqual(['scheduled_email_automation', 'automation']);
  });

  it('keeps deterministic browser automation authoring on the direct compiler path', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'automation_authoring',
        operation: 'create',
        executionClass: 'tool_orchestration',
        requiresToolSynthesis: true,
        plannedSteps: [
          {
            kind: 'write',
            summary: 'Create the requested browser automation.',
            expectedToolCategories: ['automation_save'],
            required: true,
          },
          {
            kind: 'read',
            summary: 'Open and read the requested page when the automation runs.',
            expectedToolCategories: ['web_fetch', 'browser'],
            required: true,
          },
          {
            kind: 'read',
            summary: 'List saved automation details.',
            expectedToolCategories: ['automation_list'],
            required: true,
          },
        ],
      }),
    )).toEqual(['scheduled_email_automation', 'automation']);
  });

  it('defers cross-domain automation plans to full orchestration', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'automation_authoring',
        operation: 'create',
        executionClass: 'tool_orchestration',
        requiresToolSynthesis: true,
        plannedSteps: [
          {
            kind: 'write',
            summary: 'Create the requested automation.',
            expectedToolCategories: ['automation_save'],
            required: true,
          },
          {
            kind: 'search',
            summary: 'Inspect the active repo for related implementation files.',
            expectedToolCategories: ['fs_search'],
            required: true,
          },
          {
            kind: 'tool_call',
            summary: 'Check cloud hosting status.',
            expectedToolCategories: ['whm_status'],
            required: true,
          },
        ],
      }),
    )).toEqual([]);
  });

  it('keeps answer-only repaired automation-control reads on the direct control path', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'automation_control',
        operation: 'read',
        executionClass: 'tool_orchestration',
        requiresToolSynthesis: true,
        preferredAnswerPath: 'tool_loop',
        plannedSteps: [
          {
            kind: 'answer',
            summary: 'List how many automations are currently configured.',
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Reply in one short sentence and do not mutate anything.',
            required: true,
          },
        ],
      }),
    )).toEqual(['automation_control']);
  });

  it('defers multi-action Second Brain plans to full orchestration', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'personal_assistant_task',
        operation: 'create',
        entities: { personalItemType: 'note' },
        plannedSteps: [
          {
            kind: 'write',
            summary: 'Create a Second Brain note.',
            expectedToolCategories: ['second_brain_note_upsert'],
            required: true,
          },
          {
            kind: 'write',
            summary: 'Create an automation reminder.',
            expectedToolCategories: ['automation_save'],
            required: true,
          },
        ],
      }),
    )).toEqual([]);
  });

  it('maps provider-crud general assistant requests to provider_read', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'general_assistant',
        operation: 'read',
        executionClass: 'provider_crud',
        preferredTier: 'external',
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
      }),
    )).toEqual(['provider_read']);
  });

  it('maps security tasks to the direct security guardrail candidate', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'security_task',
        operation: 'read',
        executionClass: 'security_analysis',
        preferredAnswerPath: 'direct',
      }),
    )).toEqual(['security_guardrail']);
  });

  it('defers planned security tool orchestration to graph synthesis', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'security_task',
        operation: 'inspect',
        executionClass: 'tool_orchestration',
        requiresToolSynthesis: true,
        preferredAnswerPath: 'tool_loop',
        simpleVsComplex: 'complex',
        plannedSteps: [
          {
            kind: 'tool_call',
            summary: 'Read Assistant Security summary.',
            expectedToolCategories: ['assistant_security_summary'],
            required: true,
          },
          {
            kind: 'tool_call',
            summary: 'Read WHM status.',
            expectedToolCategories: ['whm_status'],
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Return concise security and cloud status.',
            required: true,
          },
        ],
      }),
    )).toEqual([]);
  });

  it('maps structured managed sandbox status reads to coding session control', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'general_assistant',
        operation: 'inspect',
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresToolSynthesis: true,
        preferredAnswerPath: 'tool_loop',
        plannedSteps: [
          {
            kind: 'read',
            summary: 'Check Daytona sandbox status and connectivity.',
            expectedToolCategories: ['daytona_status'],
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Report whether the sandbox is reachable.',
            required: true,
          },
        ],
      }),
    )).toEqual(['coding_session_control']);
  });

  it('maps coding backend requests to coding_backend', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'coding_task',
        operation: 'run',
        executionClass: 'repo_grounded',
        preferredTier: 'local',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'tool_loop',
        entities: { codingBackend: 'codex', codingBackendRequested: true },
      }),
    )).toEqual(['coding_backend']);
  });

  it('maps coding search requests to filesystem', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'coding_task',
        operation: 'search',
        executionClass: 'repo_grounded',
        preferredTier: 'external',
        requiresRepoGrounding: true,
        expectedContextPressure: 'medium',
      }),
    )).toEqual(['filesystem']);
  });

  it('defers tool-loop coding search plans to orchestration', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'coding_task',
        operation: 'search',
        executionClass: 'tool_orchestration',
        requiresToolSynthesis: true,
        preferredAnswerPath: 'tool_loop',
        plannedSteps: [
          {
            kind: 'search',
            summary: 'Search the scratch folder.',
            expectedToolCategories: ['fs_search'],
            required: true,
          },
          {
            kind: 'tool_call',
            summary: 'Create or attach a coding session.',
            expectedToolCategories: ['code_session_create'],
            required: true,
          },
        ],
      }),
    )).toEqual([]);
  });

  it('defers document-search answer plans for tool-loop orchestration', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'search_task',
        operation: 'search',
        executionClass: 'tool_orchestration',
        requiresToolSynthesis: true,
        preferredAnswerPath: 'tool_loop',
        plannedSteps: [
          {
            kind: 'search',
            summary: 'List indexed JSON document files.',
            expectedToolCategories: ['doc_search_list'],
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Return the matching file paths.',
            required: true,
            dependsOn: ['step_1'],
          },
        ],
      }),
    )).toEqual([]);
  });

  it('does not map low-confidence search tasks to direct web search', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'search_task',
        operation: 'search',
        confidence: 'low',
      }),
    )).toEqual([]);
  });

  it('maps email drafts to write-first workspace candidates', () => {
    expect(resolveIntentCapabilityCandidates(
      mockDecision({
        route: 'email_task',
        operation: 'draft',
        executionClass: 'provider_crud',
        preferredTier: 'external',
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'tool_loop',
      }),
    )).toEqual(['workspace_write', 'workspace_read']);
  });
});
