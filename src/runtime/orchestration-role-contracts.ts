import {
  ALL_CAPABILITIES,
  isValidCapability,
  type Capability,
} from '../guardian/capabilities.js';
import type {
  IntentGatewayDecision,
  IntentGatewayOperation,
} from './intent/types.js';
import {
  hasRequiredToolOrMutationPlannedStep,
  hasRequiredWritePlannedStep,
} from './intent/planned-steps.js';
import {
  normalizeOrchestrationRoleDescriptor,
  type OrchestrationCoreRole,
  type OrchestrationRoleDescriptor,
} from './orchestration-role-descriptors.js';

export interface OrchestrationRoleCapabilityContract {
  descriptor: OrchestrationRoleDescriptor;
  allowedCapabilities: readonly Capability[];
  recommendedTrustPreset: 'safe' | 'balanced';
}

const CORE_ROLE_CAPABILITIES: Record<OrchestrationCoreRole, readonly Capability[]> = {
  coordinator: [...ALL_CAPABILITIES],
  explorer: [
    'read_files',
    'read_email',
    'read_calendar',
    'read_drive',
    'read_docs',
    'read_sheets',
  ],
  implementer: [
    'read_files',
    'write_files',
    'read_email',
    'draft_email',
    'send_email',
    'read_calendar',
    'write_calendar',
    'read_drive',
    'write_drive',
    'read_docs',
    'write_docs',
    'read_sheets',
    'write_sheets',
  ],
  verifier: [
    'read_files',
    'read_email',
    'read_calendar',
    'read_drive',
    'read_docs',
    'read_sheets',
  ],
};

const CORE_ROLE_TRUST_PRESETS: Record<OrchestrationCoreRole, 'safe' | 'balanced'> = {
  coordinator: 'balanced',
  explorer: 'safe',
  implementer: 'balanced',
  verifier: 'safe',
};

const LENS_CAPABILITIES: Record<string, readonly Capability[]> = {
  frontend: ['read_files', 'write_files'],
  security: ['read_files', 'execute_commands', 'network_access'],
  research: ['read_files', 'network_access'],
  'provider-admin': [
    'network_access',
    'read_email',
    'draft_email',
    'send_email',
    'read_calendar',
    'write_calendar',
    'read_drive',
    'write_drive',
    'read_docs',
    'write_docs',
    'read_sheets',
    'write_sheets',
  ],
  'coding-workspace': [
    'read_files',
    'write_files',
    'execute_commands',
    'git_operations',
    'install_packages',
  ],
  'personal-assistant': ['read_email', 'draft_email', 'read_calendar'],
  'second-brain': [],
};

const READ_LIKE_OPERATIONS = new Set<IntentGatewayOperation>([
  'inspect',
  'read',
  'search',
]);

function dedupeCapabilities(values: readonly Capability[]): Capability[] {
  return [...new Set(values)];
}

function dedupeLenses(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0))];
}

export function isReadLikeOperation(operation: IntentGatewayOperation | undefined): boolean {
  return operation != null && READ_LIKE_OPERATIONS.has(operation);
}

function normalizeCapabilities(values: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function buildRoleDescriptor(
  role: OrchestrationCoreRole,
  label: string,
  lenses: readonly string[] = [],
): OrchestrationRoleDescriptor {
  return {
    role,
    label,
    ...(lenses.length > 0 ? { lenses: dedupeLenses(lenses) } : {}),
  };
}

export function resolveOrchestrationCapabilityContract(
  descriptorValue: OrchestrationRoleDescriptor | undefined,
): OrchestrationRoleCapabilityContract | null {
  const descriptor = normalizeOrchestrationRoleDescriptor(descriptorValue);
  if (!descriptor) return null;

  const allowed = new Set<Capability>(CORE_ROLE_CAPABILITIES[descriptor.role]);
  for (const lens of descriptor.lenses ?? []) {
    for (const capability of LENS_CAPABILITIES[lens] ?? []) {
      allowed.add(capability);
    }
  }

  return {
    descriptor,
    allowedCapabilities: dedupeCapabilities([...allowed]),
    recommendedTrustPreset: CORE_ROLE_TRUST_PRESETS[descriptor.role],
  };
}

export function constrainCapabilitiesToOrchestrationRole(
  capabilities: readonly string[],
  descriptorValue: OrchestrationRoleDescriptor | undefined,
): readonly string[] {
  const normalizedCapabilities = normalizeCapabilities(capabilities);
  const contract = resolveOrchestrationCapabilityContract(descriptorValue);
  if (!contract) {
    return Object.freeze([...normalizedCapabilities]);
  }

  const allowed = new Set<Capability>(contract.allowedCapabilities);
  const constrained = normalizedCapabilities.filter((capability) => (
    !isValidCapability(capability) || allowed.has(capability)
  ));

  return Object.freeze(constrained);
}

export function inferDelegatedOrchestrationDescriptor(
  decision: IntentGatewayDecision | null | undefined,
): OrchestrationRoleDescriptor | undefined {
  if (!decision) return undefined;

  const readLike = isReadLikeOperation(decision.operation);
  const isRepoGrounded = decision.requiresRepoGrounding
    || decision.executionClass === 'repo_grounded';
  const isProviderCrud = decision.executionClass === 'provider_crud';
  const isSecurityAnalysis = decision.executionClass === 'security_analysis';
  const isStructuredToolOrchestration = decision.executionClass === 'tool_orchestration'
    || decision.requiresToolSynthesis
    || decision.preferredAnswerPath === 'tool_loop'
    || hasRequiredToolOrMutationPlannedStep(decision);

  if (decision.route === 'personal_assistant_task') {
    return buildRoleDescriptor(
      'coordinator',
      'Executive Assistant',
      ['personal-assistant', 'second-brain'],
    );
  }

  if (decision.route === 'security_task' || isSecurityAnalysis) {
    return buildRoleDescriptor('verifier', 'Security Verifier', ['security']);
  }

  if (decision.route === 'search_task' || decision.route === 'browser_task') {
    return buildRoleDescriptor('explorer', 'Research Explorer', ['research']);
  }

  if (decision.route === 'workspace_task' || decision.route === 'email_task' || isProviderCrud) {
    return readLike
      ? buildRoleDescriptor('explorer', 'Provider Explorer', ['provider-admin'])
      : buildRoleDescriptor('implementer', 'Provider Implementer', ['provider-admin']);
  }

  if (decision.route === 'coding_task' || decision.route === 'filesystem_task' || isRepoGrounded) {
    const structuredPlanRequiresWrite = hasRequiredWritePlannedStep(decision);
    return readLike && !structuredPlanRequiresWrite
      ? buildRoleDescriptor('explorer', 'Workspace Explorer', ['coding-workspace'])
      : buildRoleDescriptor('implementer', 'Workspace Implementer', ['coding-workspace']);
  }

  if (decision.route === 'complex_planning_task') {
    return buildRoleDescriptor('coordinator', 'Guardian Coordinator');
  }

  if (
    isStructuredToolOrchestration
    && (
      decision.route === 'automation_authoring'
      || decision.route === 'automation_control'
      || decision.route === 'automation_output_task'
      || decision.route === 'general_assistant'
      || decision.route === 'channel_delivery'
    )
  ) {
    return buildRoleDescriptor('coordinator', 'Guardian Coordinator');
  }

  return undefined;
}
