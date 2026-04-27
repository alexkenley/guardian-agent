import { describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '../../llm/types.js';
import { confirmIntentGatewayDecisionIfNeeded } from './confirmation-pass.js';
import type { IntentGatewayRecord } from './types.js';

function buildAutomationCatalogRecord(): IntentGatewayRecord {
  return {
    mode: 'primary',
    available: true,
    model: 'test-gateway',
    latencyMs: 5,
    promptProfile: 'full',
    rawStructuredDecision: {
      route: 'automation_control',
      confidence: 'high',
      operation: 'read',
      summary: 'Search automations and suggest one useful automation.',
      planned_steps: [
        {
          kind: 'read',
          summary: 'Search existing automations.',
          expectedToolCategories: ['automation_list'],
          required: true,
        },
        {
          kind: 'answer',
          summary: 'Suggest one useful automation.',
          required: true,
          dependsOn: ['step_1'],
        },
      ],
    },
    decision: {
      route: 'automation_control',
      confidence: 'high',
      operation: 'read',
      summary: 'Search automations and suggest one useful automation.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      requireExactFileReferences: false,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      provenance: {
        route: 'classifier.primary',
        operation: 'classifier.primary',
      },
      plannedSteps: [
        {
          kind: 'read',
          summary: 'Search existing automations.',
          expectedToolCategories: ['automation_list'],
          required: true,
        },
        {
          kind: 'answer',
          summary: 'Suggest one useful automation.',
          required: true,
          dependsOn: ['step_1'],
        },
      ],
      entities: {},
    },
  };
}

describe('confirmIntentGatewayDecisionIfNeeded', () => {
  it('runs a semantic plan coverage confirmation for tool-backed catalog answers', async () => {
    const chat = vi.fn(async (messages, options) => {
      const prompt = messages.map((message) => message.content).join('\n');
      expect(prompt).toContain('Confirmation reason: tool_plan_coverage_check');
      expect(prompt).toContain('"planned_steps"');
      expect(options?.maxTokens).toBe(520);
      return {
        content: JSON.stringify({
          route: 'general_assistant',
          confidence: 'high',
          operation: 'search',
          summary: 'Search existing automations and Second Brain routines, then suggest one useful automation.',
          turnRelation: 'new_request',
          resolution: 'ready',
          executionClass: 'tool_orchestration',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          simpleVsComplex: 'complex',
          planned_steps: [
            {
              kind: 'read',
              summary: 'Search existing automations.',
              expectedToolCategories: ['automation_list'],
              required: true,
            },
            {
              kind: 'read',
              summary: 'Search existing Second Brain routines.',
              expectedToolCategories: ['second_brain_routine_list', 'second_brain_routine_catalog'],
              required: true,
            },
            {
              kind: 'answer',
              summary: 'Suggest one useful automation to create.',
              required: true,
              dependsOn: ['step_1', 'step_2'],
            },
          ],
        }),
        model: 'test-confirmation',
        finishReason: 'stop',
      } satisfies ChatResponse;
    });

    const result = await confirmIntentGatewayDecisionIfNeeded({
      content: 'Find any automations or routines related to approval, routing, or code review, then suggest one useful automation I could create. Do not create it yet.',
      userId: 'owner',
      channel: 'web',
    }, buildAutomationCatalogRecord(), chat);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe('confirmation');
    expect(result.decision.route).toBe('general_assistant');
    expect(result.decision.plannedSteps).toEqual([
      expect.objectContaining({
        kind: 'read',
        expectedToolCategories: ['automation_list'],
      }),
      expect.objectContaining({
        kind: 'read',
        expectedToolCategories: ['second_brain_routine_list', 'second_brain_routine_catalog'],
      }),
      expect.objectContaining({
        kind: 'answer',
        dependsOn: ['step_1', 'step_2'],
      }),
    ]);
  });

  it('adopts confirmation changes when only planned steps differ', async () => {
    const record = buildAutomationCatalogRecord();
    record.decision.plannedSteps = [
      {
        kind: 'read',
        summary: 'Search existing automations.',
        required: true,
      },
      {
        kind: 'answer',
        summary: 'Suggest one useful automation.',
        required: true,
        dependsOn: ['step_1'],
      },
    ];

    const chat = vi.fn(async () => ({
      content: JSON.stringify({
        route: 'automation_control',
        confidence: 'high',
        operation: 'read',
        summary: 'Search automations and suggest one useful automation.',
        turnRelation: 'new_request',
        resolution: 'ready',
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
        simpleVsComplex: 'complex',
        planned_steps: [
          {
            kind: 'read',
            summary: 'Search existing automations.',
            expectedToolCategories: ['automation_list'],
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Suggest one useful automation.',
            required: true,
            dependsOn: ['step_1'],
          },
        ],
      }),
      model: 'test-confirmation',
      finishReason: 'stop',
    }) satisfies ChatResponse);

    const result = await confirmIntentGatewayDecisionIfNeeded({
      content: 'Find automations related to approval, then suggest one useful automation I could create. Do not create it yet.',
      userId: 'owner',
      channel: 'web',
    }, record, chat);

    expect(result.mode).toBe('confirmation');
    expect(result.decision.route).toBe('automation_control');
    expect(result.decision.plannedSteps?.[0]?.expectedToolCategories).toEqual(['automation_list']);
  });

  it('rejects confirmation routes outside the candidate route set', async () => {
    const record = buildAutomationCatalogRecord();
    record.decision.summary = 'List saved automations.';
    record.decision.plannedSteps = [
      {
        kind: 'read',
        summary: 'List saved automations.',
        expectedToolCategories: ['automation_list'],
        required: true,
      },
      {
        kind: 'answer',
        summary: 'Answer with automation names and enabled state.',
        required: true,
        dependsOn: ['step_1'],
      },
    ];

    const chat = vi.fn(async (messages) => {
      const prompt = messages.map((message) => message.content).join('\n');
      expect(prompt).toContain('Candidate routes: automation_control');
      return {
        content: JSON.stringify({
          route: 'automation_output_task',
          confidence: 'high',
          operation: 'read',
          summary: 'Analyze saved automation output.',
          turnRelation: 'new_request',
          resolution: 'ready',
          executionClass: 'tool_orchestration',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          simpleVsComplex: 'simple',
          planned_steps: [
            {
              kind: 'read',
              summary: 'Read stored automation output.',
              expectedToolCategories: ['automation_output_read'],
              required: true,
            },
            {
              kind: 'answer',
              summary: 'Answer from stored automation output.',
              required: true,
              dependsOn: ['step_1'],
            },
          ],
        }),
        model: 'test-confirmation',
        finishReason: 'stop',
      } satisfies ChatResponse;
    });

    const result = await confirmIntentGatewayDecisionIfNeeded({
      content: 'List my saved automations. Keep the answer short and include only names and whether each is enabled.',
      userId: 'owner',
      channel: 'web',
    }, record, chat);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result).toBe(record);
    expect(result.decision.route).toBe('automation_control');
  });

  it('confirms generic general-assistant tool plans so concrete evidence steps can be supplied', async () => {
    const record = buildAutomationCatalogRecord();
    record.rawStructuredDecision = {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'search',
      summary: 'Find matching automations and routines.',
      planned_steps: [
        { kind: 'search', summary: 'Find matching automations and routines.', required: true },
        { kind: 'write', summary: 'Suggest one useful automation.', required: true, dependsOn: ['step_1'] },
      ],
    };
    record.decision = {
      ...record.decision,
      route: 'general_assistant',
      operation: 'search',
      summary: 'Find matching automations and routines.',
      plannedSteps: [
        { kind: 'search', summary: 'Find matching automations and routines.', required: true },
        { kind: 'write', summary: 'Suggest one useful automation.', required: true, dependsOn: ['step_1'] },
      ],
    };

    const chat = vi.fn(async (messages) => {
      const prompt = messages.map((message) => message.content).join('\n');
      expect(prompt).toContain('Confirmation reason: tool_plan_coverage_check');
      return {
        content: JSON.stringify({
          route: 'general_assistant',
          confidence: 'high',
          operation: 'search',
          summary: 'Search existing automations and Second Brain routines, then suggest one useful automation.',
          turnRelation: 'new_request',
          resolution: 'ready',
          executionClass: 'tool_orchestration',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          simpleVsComplex: 'complex',
          planned_steps: [
            {
              kind: 'read',
              summary: 'Search existing automations.',
              expectedToolCategories: ['automation_list'],
              required: true,
            },
            {
              kind: 'read',
              summary: 'Search existing Second Brain routines.',
              expectedToolCategories: ['second_brain_routine_list', 'second_brain_routine_catalog'],
              required: true,
            },
            {
              kind: 'answer',
              summary: 'Suggest one useful automation to create.',
              required: true,
              dependsOn: ['step_1', 'step_2'],
            },
          ],
        }),
        model: 'test-confirmation',
        finishReason: 'stop',
      } satisfies ChatResponse;
    });

    const result = await confirmIntentGatewayDecisionIfNeeded({
      content: 'Find any automations or routines related to approval, routing, or code review, then suggest one useful automation I could create. Do not create it yet.',
      userId: 'owner',
      channel: 'web',
    }, record, chat);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe('confirmation');
    expect(result.decision.route).toBe('general_assistant');
    expect(result.decision.plannedSteps?.map((step) => step.expectedToolCategories)).toEqual([
      ['automation_list'],
      ['second_brain_routine_list', 'second_brain_routine_catalog'],
      undefined,
    ]);
  });

  it('retries plan coverage confirmation when the first confirmation still uses generic evidence categories', async () => {
    const record = buildAutomationCatalogRecord();
    record.rawStructuredDecision = {
      route: 'general_assistant',
      confidence: 'low',
      operation: 'search',
      summary: 'Find matching automations and routines.',
      planned_steps: [
        { kind: 'search', summary: 'Find matching automations and routines.', required: true },
        { kind: 'write', summary: 'Suggest one useful automation.', required: true, dependsOn: ['step_1'] },
      ],
    };
    record.decision = {
      ...record.decision,
      route: 'general_assistant',
      confidence: 'low',
      operation: 'search',
      summary: 'Find matching automations and routines.',
      plannedSteps: [
        { kind: 'search', summary: 'Find matching automations and routines.', required: true },
        { kind: 'answer', summary: 'Suggest one useful automation.', required: true, dependsOn: ['step_1'] },
      ],
    };

    const responses: ChatResponse[] = [
      {
        content: JSON.stringify({
          route: 'general_assistant',
          confidence: 'low',
          operation: 'search',
          summary: 'Find matching automations and routines.',
          turnRelation: 'new_request',
          resolution: 'ready',
          executionClass: 'tool_orchestration',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          planned_steps: [
            {
              kind: 'search',
              summary: 'Find matching automations and routines.',
              expectedToolCategories: ['search', 'read'],
              required: true,
            },
            {
              kind: 'answer',
              summary: 'Suggest one useful automation.',
              required: true,
              dependsOn: ['step_1'],
            },
          ],
        }),
        model: 'test-confirmation',
        finishReason: 'stop',
      },
      {
        content: JSON.stringify({
          route: 'general_assistant',
          confidence: 'high',
          operation: 'search',
          summary: 'Search existing automations and Second Brain routines, then suggest one useful automation.',
          turnRelation: 'new_request',
          resolution: 'ready',
          executionClass: 'tool_orchestration',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          planned_steps: [
            {
              kind: 'read',
              summary: 'Search existing automations.',
              expectedToolCategories: ['automation_list'],
              required: true,
            },
            {
              kind: 'read',
              summary: 'Search existing Second Brain routines.',
              expectedToolCategories: ['second_brain_routine_list', 'second_brain_routine_catalog'],
              required: true,
            },
            {
              kind: 'answer',
              summary: 'Suggest one useful automation.',
              required: true,
              dependsOn: ['step_1', 'step_2'],
            },
          ],
        }),
        model: 'test-confirmation',
        finishReason: 'stop',
      },
    ];
    let callNumber = 0;
    const chat = vi.fn(async (messages, options) => {
      callNumber += 1;
      if (callNumber === 2) {
        expect(messages.at(-1)?.content).toContain('structurally insufficient');
        expect(options?.maxTokens).toBe(640);
      }
      const response = responses.shift();
      if (!response) {
        throw new Error('unexpected confirmation retry');
      }
      return response;
    });

    const result = await confirmIntentGatewayDecisionIfNeeded({
      content: 'Find any automations or routines related to approval, routing, or code review, then suggest one useful automation I could create. Do not create it yet.',
      userId: 'owner',
      channel: 'web',
    }, record, chat);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.mode).toBe('confirmation');
    expect(result.decision.plannedSteps?.map((step) => step.expectedToolCategories)).toEqual([
      ['automation_list'],
      ['second_brain_routine_list', 'second_brain_routine_catalog'],
      undefined,
    ]);
  });

  it('repairs external web research plus repo comparison into concrete tool evidence steps', async () => {
    const record = buildAutomationCatalogRecord();
    record.rawStructuredDecision = {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'read',
      summary: 'Search the web for approval workflow practices and compare to repo implementation.',
      planned_steps: [
        {
          kind: 'search',
          summary: 'Search for recent best practices.',
          expectedToolCategories: ['search', 'read'],
          required: true,
        },
        {
          kind: 'read',
          summary: 'Read repo implementation.',
          expectedToolCategories: ['read'],
          required: true,
        },
        {
          kind: 'answer',
          summary: 'Compare the findings.',
          required: true,
          dependsOn: ['step_1', 'step_2'],
        },
      ],
    };
    record.decision = {
      ...record.decision,
      route: 'general_assistant',
      operation: 'read',
      summary: 'Search the web for approval workflow practices and compare to repo implementation.',
      executionClass: 'repo_grounded',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      plannedSteps: [
        {
          kind: 'search',
          summary: 'Search for recent best practices.',
          expectedToolCategories: ['search', 'read'],
          required: true,
        },
        {
          kind: 'read',
          summary: 'Read repo implementation.',
          expectedToolCategories: ['read'],
          required: true,
        },
        {
          kind: 'answer',
          summary: 'Compare the findings.',
          required: true,
          dependsOn: ['step_1', 'step_2'],
        },
      ],
    };

    const responses: ChatResponse[] = [
      {
        content: JSON.stringify({
          route: 'general_assistant',
          confidence: 'high',
          operation: 'search',
          summary: 'Search the web and inspect the repo before comparing approval workflow approaches.',
          turnRelation: 'new_request',
          resolution: 'ready',
          executionClass: 'tool_orchestration',
          preferredTier: 'external',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          planned_steps: [
            {
              kind: 'search',
              summary: 'Search external sources for current approval workflow practices.',
              expectedToolCategories: ['search', 'read'],
              required: true,
            },
            {
              kind: 'read',
              summary: 'Inspect repo approval workflow implementation.',
              expectedToolCategories: ['read'],
              required: true,
            },
            {
              kind: 'answer',
              summary: 'Compare external practices to the repo implementation.',
              required: true,
              dependsOn: ['step_1', 'step_2'],
            },
          ],
        }),
        model: 'test-confirmation',
        finishReason: 'stop',
      },
      {
        content: JSON.stringify({
          route: 'general_assistant',
          confidence: 'high',
          operation: 'search',
          summary: 'Search the web and inspect the repo before comparing approval workflow approaches.',
          turnRelation: 'new_request',
          resolution: 'ready',
          executionClass: 'tool_orchestration',
          preferredTier: 'external',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          planned_steps: [
            {
              kind: 'search',
              summary: 'Search external sources for current approval workflow practices.',
              expectedToolCategories: ['web_search'],
              required: true,
            },
            {
              kind: 'read',
              summary: 'Inspect repo approval workflow implementation.',
              expectedToolCategories: ['repo_inspect'],
              required: true,
            },
            {
              kind: 'answer',
              summary: 'Compare external practices to the repo implementation.',
              required: true,
              dependsOn: ['step_1', 'step_2'],
            },
          ],
        }),
        model: 'test-confirmation',
        finishReason: 'stop',
      },
    ];
    let callNumber = 0;
    const chat = vi.fn(async (messages, options) => {
      callNumber += 1;
      const prompt = messages.map((message) => message.content).join('\n');
      expect(prompt).toContain('external web research plus repo comparison');
      if (callNumber === 2) {
        expect(messages.at(-1)?.content).toContain('structurally insufficient');
        expect(options?.maxTokens).toBe(640);
      }
      const response = responses.shift();
      if (!response) {
        throw new Error('unexpected confirmation retry');
      }
      return response;
    });

    const result = await confirmIntentGatewayDecisionIfNeeded({
      content: "Search the web for recent best practices on agent approval workflows, then compare them to this repo's approach. Do not edit files.",
      userId: 'owner',
      channel: 'web',
    }, record, chat);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.mode).toBe('confirmation');
    expect(result.decision.executionClass).toBe('tool_orchestration');
    expect(result.decision.plannedSteps?.map((step) => step.expectedToolCategories)).toEqual([
      ['web_search'],
      ['repo_inspect'],
      undefined,
    ]);
  });

  it('does not confirm repaired filesystem mutations that already name a concrete path', async () => {
    const record: IntentGatewayRecord = {
      mode: 'json_fallback',
      available: true,
      model: 'test-gateway',
      latencyMs: 5,
      rawStructuredDecision: {
        route: 'filesystem_task',
        confidence: 'low',
        operation: 'create',
        summary: 'Write files and search runtime planned steps.',
        path: 'tmp/manual-web/current-time.txt',
        planned_steps: [
          {
            kind: 'write',
            summary: 'Write the current date and time to tmp/manual-web/current-time.txt.',
            expectedToolCategories: ['write'],
            required: true,
          },
          {
            kind: 'search',
            summary: 'Search src/runtime for planned_steps.',
            expectedToolCategories: ['search', 'read'],
            required: true,
            dependsOn: ['step_1'],
          },
          {
            kind: 'write',
            summary: 'Write a short summary to tmp/manual-web/planned-steps-summary.txt.',
            expectedToolCategories: ['write'],
            required: true,
            dependsOn: ['step_2'],
          },
        ],
      },
      decision: {
        route: 'filesystem_task',
        confidence: 'low',
        operation: 'create',
        summary: 'Write files and search runtime planned steps.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'repo_grounded',
        preferredTier: 'local',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        requireExactFileReferences: false,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
        simpleVsComplex: 'complex',
        provenance: {
          route: 'repair.structured',
          operation: 'repair.structured',
        },
        plannedSteps: [
          {
            kind: 'write',
            summary: 'Write the current date and time to tmp/manual-web/current-time.txt.',
            expectedToolCategories: ['write'],
            required: true,
          },
          {
            kind: 'search',
            summary: 'Search src/runtime for planned_steps.',
            expectedToolCategories: ['search', 'read'],
            required: true,
            dependsOn: ['step_1'],
          },
          {
            kind: 'write',
            summary: 'Write a short summary to tmp/manual-web/planned-steps-summary.txt.',
            expectedToolCategories: ['write'],
            required: true,
            dependsOn: ['step_2'],
          },
        ],
        entities: {
          path: 'tmp/manual-web/current-time.txt',
        },
      },
    };
    const chat = vi.fn();

    const result = await confirmIntentGatewayDecisionIfNeeded({
      content: 'Write the current date and time to tmp/manual-web/current-time.txt. Search src/runtime for planned_steps. Write a short summary to tmp/manual-web/planned-steps-summary.txt.',
      userId: 'owner',
      channel: 'web',
    }, record, chat);

    expect(chat).not.toHaveBeenCalled();
    expect(result).toBe(record);
  });

  it('confirms ambiguous filesystem mutation plans before treating a chat report as a write', async () => {
    const record: IntentGatewayRecord = {
      mode: 'primary',
      available: true,
      model: 'test-gateway',
      latencyMs: 5,
      promptProfile: 'full',
      rawStructuredDecision: {
        route: 'filesystem_task',
        confidence: 'low',
        operation: 'update',
        summary: 'Search web and compare findings to repo approach.',
        planned_steps: [
          {
            kind: 'search',
            summary: 'Search web for approval workflow best practices.',
            expectedToolCategories: ['search', 'read'],
            required: true,
          },
          {
            kind: 'write',
            summary: 'Compare findings to the repo approach.',
            expectedToolCategories: ['write'],
            required: true,
            dependsOn: ['step_1'],
          },
        ],
      },
      decision: {
        route: 'filesystem_task',
        confidence: 'low',
        operation: 'update',
        summary: 'Search web and compare findings to repo approach.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        requireExactFileReferences: false,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
        simpleVsComplex: 'complex',
        provenance: {
          route: 'repair.structured',
          operation: 'repair.structured',
        },
        plannedSteps: [
          {
            kind: 'search',
            summary: 'Search web for approval workflow best practices.',
            expectedToolCategories: ['search', 'read'],
            required: true,
          },
          {
            kind: 'write',
            summary: 'Compare findings to the repo approach.',
            expectedToolCategories: ['write'],
            required: true,
            dependsOn: ['step_1'],
          },
        ],
        entities: {},
      },
    };
    const chat = vi.fn(async (messages) => {
      const prompt = messages.map((message) => message.content).join('\n');
      expect(prompt).toContain('Confirmation reason: mutation_contract_check');
      expect(prompt).toContain('chat is an answer step');
      return {
        content: JSON.stringify({
          route: 'general_assistant',
          confidence: 'high',
          operation: 'search',
          summary: 'Search web and repo evidence, then compare findings in chat without editing files.',
          turnRelation: 'new_request',
          resolution: 'ready',
          executionClass: 'tool_orchestration',
          preferredTier: 'external',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'high',
          preferredAnswerPath: 'tool_loop',
          simpleVsComplex: 'complex',
          planned_steps: [
            {
              kind: 'search',
              summary: 'Search web for approval workflow best practices.',
              expectedToolCategories: ['web_search'],
              required: true,
            },
            {
              kind: 'read',
              summary: 'Inspect repo approval workflow implementation.',
              expectedToolCategories: ['repo_inspection'],
              required: true,
            },
            {
              kind: 'answer',
              summary: 'Compare the findings in chat without editing files.',
              required: true,
              dependsOn: ['step_1', 'step_2'],
            },
          ],
        }),
        model: 'test-confirmation',
        finishReason: 'stop',
      } satisfies ChatResponse;
    });

    const result = await confirmIntentGatewayDecisionIfNeeded({
      content: "Search the web for recent best practices on agent approval workflows, then compare them to this repo's approach. Do not edit files.",
      userId: 'owner',
      channel: 'web',
    }, record, chat);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe('confirmation');
    expect(result.decision.route).toBe('general_assistant');
    expect(result.decision.operation).toBe('search');
    expect(result.decision.plannedSteps?.map((step) => step.kind)).toEqual(['search', 'read', 'answer']);
  });
});
