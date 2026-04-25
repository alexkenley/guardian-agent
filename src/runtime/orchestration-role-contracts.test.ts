import { describe, expect, it } from 'vitest';
import { BaseAgent, createAgentDefinition } from '../agent/agent.js';
import type { IntentGatewayDecision } from './intent/types.js';
import {
  constrainCapabilitiesToOrchestrationRole,
  inferDelegatedOrchestrationDescriptor,
  resolveOrchestrationCapabilityContract,
} from './orchestration-role-contracts.js';

class TestAgent extends BaseAgent {
  constructor() {
    super('test-agent', 'Test Agent', { handleMessages: true });
  }
}

function buildDecision(overrides: Partial<IntentGatewayDecision>): IntentGatewayDecision {
  return {
    route: 'general_assistant',
    confidence: 'high',
    operation: 'read',
    summary: 'Handles a request.',
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
  };
}

describe('orchestration role contracts', () => {
  it('resolves role contracts with role and lens capability packs', () => {
    const contract = resolveOrchestrationCapabilityContract({
      role: 'implementer',
      label: 'Workspace Implementer',
      lenses: ['coding-workspace'],
    });

    expect(contract).toMatchObject({
      recommendedTrustPreset: 'balanced',
      descriptor: {
        role: 'implementer',
        label: 'Workspace Implementer',
        lenses: ['coding-workspace'],
      },
    });
    expect(contract?.allowedCapabilities).toEqual(expect.arrayContaining([
      'write_files',
      'execute_commands',
      'git_operations',
      'install_packages',
    ]));
  });

  it('narrows known capabilities but preserves internal runtime capabilities', () => {
    const narrowed = constrainCapabilitiesToOrchestrationRole(
      [
        'read_files',
        'write_files',
        'network_access',
        'install_packages',
        'agent.dispatch',
      ],
      {
        role: 'explorer',
        label: 'Research Explorer',
        lenses: ['research'],
      },
    );

    expect(narrowed).toEqual([
      'read_files',
      'network_access',
      'agent.dispatch',
    ]);
  });

  it('does not widen an empty capability set', () => {
    const narrowed = constrainCapabilitiesToOrchestrationRole(
      [],
      {
        role: 'implementer',
        label: 'Workspace Implementer',
        lenses: ['coding-workspace'],
      },
    );

    expect(narrowed).toEqual([]);
  });

  it('applies orchestration contracts when creating an agent definition', () => {
    const definition = createAgentDefinition({
      agent: new TestAgent(),
      grantedCapabilities: ['read_files', 'write_files', 'execute_commands', 'agent.dispatch'],
      orchestration: {
        role: 'explorer',
        label: 'Workspace Explorer',
        lenses: ['coding-workspace'],
      },
    });

    expect(definition.grantedCapabilities).toEqual([
      'read_files',
      'write_files',
      'execute_commands',
      'agent.dispatch',
    ]);
    expect(definition.orchestration).toEqual({
      role: 'explorer',
      label: 'Workspace Explorer',
      lenses: ['coding-workspace'],
    });
  });

  it('infers workspace specialist roles from structured coding decisions', () => {
    const descriptor = inferDelegatedOrchestrationDescriptor(buildDecision({
      route: 'coding_task',
      operation: 'update',
      executionClass: 'repo_grounded',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
    }));

    expect(descriptor).toEqual({
      role: 'implementer',
      label: 'Workspace Implementer',
      lenses: ['coding-workspace'],
    });
  });

  it('infers workspace implementer for read-like coding decisions with structured write steps', () => {
    const descriptor = inferDelegatedOrchestrationDescriptor(buildDecision({
      route: 'coding_task',
      operation: 'inspect',
      executionClass: 'repo_grounded',
      requiresRepoGrounding: true,
      requiresToolSynthesis: false,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'chat_synthesis',
      plannedSteps: [
        { kind: 'search', summary: 'Search src/runtime for planned_steps.', required: true },
        {
          kind: 'write',
          summary: 'Write a grounded summary to tmp/manual-web/planned-steps-summary.txt.',
          expectedToolCategories: ['fs_write'],
          required: true,
          dependsOn: ['step_1'],
        },
      ],
    }));

    expect(descriptor).toEqual({
      role: 'implementer',
      label: 'Workspace Implementer',
      lenses: ['coding-workspace'],
    });
  });

  it('infers executive assistant metadata for personal assistant delegation', () => {
    const descriptor = inferDelegatedOrchestrationDescriptor(buildDecision({
      route: 'personal_assistant_task',
      operation: 'read',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      preferredAnswerPath: 'chat_synthesis',
    }));

    expect(descriptor).toEqual({
      role: 'coordinator',
      label: 'Executive Assistant',
      lenses: ['personal-assistant', 'second-brain'],
    });
  });

  it('keeps direct general-assistant turns out of delegated orchestration even when a code session is attached', () => {
    const descriptor = inferDelegatedOrchestrationDescriptor(buildDecision({
      route: 'general_assistant',
      operation: 'read',
      executionClass: 'direct_assistant',
      requiresRepoGrounding: false,
      requiresToolSynthesis: false,
      expectedContextPressure: 'low',
      preferredAnswerPath: 'direct',
    }));

    expect(descriptor).toBeUndefined();
  });

  it('infers coordinator metadata for structured general-assistant tool orchestration', () => {
    const descriptor = inferDelegatedOrchestrationDescriptor(buildDecision({
      route: 'general_assistant',
      operation: 'create',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      plannedSteps: [
        {
          kind: 'tool_call',
          summary: 'Re-check the previously summarized security posture.',
          expectedToolCategories: ['assistant_security_findings', 'security_posture_status'],
          required: true,
        },
        {
          kind: 'write',
          summary: 'Create the follow-up task and automation from the prior result.',
          expectedToolCategories: ['second_brain_task_upsert', 'automation_save'],
          required: true,
        },
      ],
    }));

    expect(descriptor).toEqual({
      role: 'coordinator',
      label: 'Guardian Coordinator',
    });
  });

  it('infers coordinator metadata when mixed automation plans cannot stay on the native automation lane', () => {
    const descriptor = inferDelegatedOrchestrationDescriptor(buildDecision({
      route: 'automation_authoring',
      operation: 'create',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'chat_synthesis',
      plannedSteps: [
        {
          kind: 'write',
          summary: 'Create an automation.',
          expectedToolCategories: ['automation_save'],
          required: true,
        },
        {
          kind: 'search',
          summary: 'Search the workspace for supporting details.',
          expectedToolCategories: ['fs_search'],
          required: true,
        },
      ],
    }));

    expect(descriptor).toEqual({
      role: 'coordinator',
      label: 'Guardian Coordinator',
    });
  });

  it('still infers provider-specialist roles for provider CRUD workloads routed through general assistant', () => {
    const descriptor = inferDelegatedOrchestrationDescriptor(buildDecision({
      route: 'general_assistant',
      operation: 'read',
      executionClass: 'provider_crud',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
    }));

    expect(descriptor).toEqual({
      role: 'explorer',
      label: 'Provider Explorer',
      lenses: ['provider-admin'],
    });
  });
});
