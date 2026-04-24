import type { ChatMessage } from '../../llm/types.js';
import { parseStructuredJsonObject } from '../../util/structured-json.js';
import type { PromptAssemblyAdditionalSection } from '../context-assembly.js';
import type {
  DelegatedResultEnvelope,
  PlannedStep,
  VerificationDecision,
} from './types.js';

export type RecoveryAdvisorStrategy =
  | 'complete_missing_search'
  | 'complete_missing_read'
  | 'complete_missing_write'
  | 'answer_from_existing_evidence'
  | 'retry_tool_call';

export interface RecoveryAdvisorAction {
  stepId: string;
  strategy: RecoveryAdvisorStrategy;
  toolName?: string;
  reason?: string;
}

export interface RecoveryAdvisorProposal {
  decision: 'retry' | 'give_up';
  reason?: string;
  actions?: RecoveryAdvisorAction[];
}

export interface RecoveryAdvisorJobSnapshot {
  toolName?: string;
  status?: string;
  argsPreview?: string;
  resultPreview?: string;
}

export interface RecoveryAdvisorRequest {
  originalRequest: string;
  taskContract: DelegatedResultEnvelope['taskContract'];
  verification: VerificationDecision;
  jobSnapshots?: RecoveryAdvisorJobSnapshot[];
}

export interface ValidatedRecoveryAdvice {
  reason: string;
  actions: RecoveryAdvisorAction[];
}

const RECOVERY_ADVISOR_SCHEMA = {
  decision: 'retry | give_up',
  reason: 'short explanation',
  actions: [
    {
      stepId: 'one unsatisfied planned step id',
      strategy: 'complete_missing_search | complete_missing_read | complete_missing_write | answer_from_existing_evidence | retry_tool_call',
      toolName: 'optional exact tool name, if a tool is required',
      reason: 'short explanation',
    },
  ],
};

const ALLOWED_TOOLS_BY_STRATEGY: Record<RecoveryAdvisorStrategy, readonly string[]> = {
  complete_missing_search: ['fs_search', 'code_symbol_search', 'web_search'],
  complete_missing_read: ['fs_read', 'fs_list', 'web_fetch'],
  complete_missing_write: ['fs_write', 'fs_mkdir', 'fs_delete', 'fs_move', 'fs_copy'],
  answer_from_existing_evidence: [],
  retry_tool_call: ['execute_code', 'code_remote_exec', 'shell', 'command', 'find_tools'],
};

const STRATEGIES_BY_STEP_KIND: Record<PlannedStep['kind'], readonly RecoveryAdvisorStrategy[]> = {
  search: ['complete_missing_search'],
  read: ['complete_missing_read'],
  write: ['complete_missing_write'],
  answer: ['answer_from_existing_evidence'],
  tool_call: ['retry_tool_call'],
  memory_save: ['retry_tool_call'],
};

export function buildRecoveryAdvisorMessages(input: RecoveryAdvisorRequest): ChatMessage[] {
  const unsatisfiedSteps = readRecoveryUnsatisfiedSteps(input);
  const packet = {
    originalRequest: truncateRecoveryText(input.originalRequest, 1_000),
    taskContract: {
      kind: input.taskContract.kind,
      route: input.taskContract.route,
      operation: input.taskContract.operation,
      summary: truncateRecoveryText(input.taskContract.summary ?? '', 500),
      plan: input.taskContract.plan.steps.map((step) => ({
        stepId: step.stepId,
        kind: step.kind,
        summary: truncateRecoveryText(step.summary, 500),
        required: step.required,
        dependsOn: step.dependsOn,
        expectedToolCategories: step.expectedToolCategories,
      })),
    },
    verification: {
      decision: input.verification.decision,
      reasons: input.verification.reasons.map((reason) => truncateRecoveryText(reason, 500)),
      missingEvidenceKinds: input.verification.missingEvidenceKinds,
      unsatisfiedStepIds: input.verification.unsatisfiedStepIds,
      requiredNextAction: truncateRecoveryText(input.verification.requiredNextAction ?? '', 500),
    },
    unsatisfiedSteps,
    observedJobs: (input.jobSnapshots ?? []).slice(0, 20).map((snapshot) => ({
      toolName: snapshot.toolName,
      status: snapshot.status,
      argsPreview: truncateRecoveryText(snapshot.argsPreview ?? '', 500),
      resultPreview: truncateRecoveryText(snapshot.resultPreview ?? '', 500),
    })),
  };

  return [
    {
      role: 'system',
      content: [
        'You are GuardianAgent Recovery Advisor.',
        'You do not execute tools, verify completion, approve actions, or override policy.',
        'You only choose a recovery strategy for unsatisfied planned steps.',
        'Return JSON only.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        'A deterministic verifier rejected a delegated worker result.',
        'Propose a bounded retry strategy using only the schema below.',
        'Do not claim the task is satisfied. Do not ask for credentials. Do not weaken approval, sandbox, path, or receipt requirements.',
        '',
        `Schema:\n${JSON.stringify(RECOVERY_ADVISOR_SCHEMA, null, 2)}`,
        '',
        `Failure packet:\n${JSON.stringify(packet, null, 2)}`,
      ].join('\n'),
    },
  ];
}

export function parseRecoveryAdvisorProposal(content: string | undefined): RecoveryAdvisorProposal | null {
  const parsed = parseStructuredJsonObject(content ?? '');
  if (!parsed || typeof parsed !== 'object') return null;
  const decision = parsed.decision === 'retry' || parsed.decision === 'give_up'
    ? parsed.decision
    : null;
  if (!decision) return null;
  const actions = Array.isArray(parsed.actions)
    ? parsed.actions
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
        .map((entry) => normalizeRecoveryAdvisorAction(entry))
        .filter((entry): entry is RecoveryAdvisorAction => !!entry)
    : undefined;
  return {
    decision,
    ...(typeof parsed.reason === 'string' && parsed.reason.trim()
      ? { reason: parsed.reason.trim() }
      : {}),
    ...(actions && actions.length > 0 ? { actions } : {}),
  };
}

export function validateRecoveryAdvisorProposal(
  proposal: RecoveryAdvisorProposal | null,
  input: RecoveryAdvisorRequest,
): ValidatedRecoveryAdvice | null {
  if (!proposal || proposal.decision !== 'retry') {
    return null;
  }
  const unsatisfiedSteps = new Map(readRecoveryUnsatisfiedSteps(input).map((step) => [step.stepId, step]));
  if (unsatisfiedSteps.size === 0) {
    return null;
  }
  const actions = (proposal.actions ?? [])
    .map((action) => validateRecoveryAdvisorAction(action, unsatisfiedSteps.get(action.stepId)))
    .filter((action): action is RecoveryAdvisorAction => !!action);
  if (actions.length === 0) {
    return null;
  }
  return {
    reason: truncateRecoveryText(proposal.reason ?? 'Recovery advisor proposed a bounded retry.', 500),
    actions,
  };
}

export function buildDeterministicRecoveryAdvice(input: RecoveryAdvisorRequest): ValidatedRecoveryAdvice | null {
  const missingEvidenceKinds = new Set(input.verification.missingEvidenceKinds ?? []);
  const actions: RecoveryAdvisorAction[] = [];
  for (const step of readRecoveryUnsatisfiedSteps(input)) {
    if (step.kind === 'write' && (missingEvidenceKinds.has('write') || missingEvidenceKinds.has('filesystem_mutation_receipt'))) {
      const action = validateRecoveryAdvisorAction({
        stepId: step.stepId,
        strategy: 'complete_missing_write',
        toolName: step.expectedToolCategories?.find((category) => ALLOWED_TOOLS_BY_STRATEGY.complete_missing_write.includes(category)) ?? 'fs_write',
        reason: 'The verifier requires a successful filesystem mutation receipt for this unsatisfied write step.',
      }, step);
      if (action) actions.push(action);
    }
  }

  if (actions.length <= 0) {
    return null;
  }
  return {
    reason: 'Deterministic recovery selected the missing write-step retry required by verification.',
    actions,
  };
}

export function buildRecoveryAdvisorAdditionalSection(
  advice: ValidatedRecoveryAdvice,
  taskContract: DelegatedResultEnvelope['taskContract'],
): PromptAssemblyAdditionalSection {
  const stepById = new Map(taskContract.plan.steps.map((step) => [step.stepId, step]));
  const hasWriteRecovery = advice.actions.some((action) => action.strategy === 'complete_missing_write');
  const lines = [
    'Recovery Manager Guidance',
    '',
    'A previous delegated attempt failed deterministic verification. This section is advisory retry guidance only; the verifier still requires real tool receipts.',
    `Reason: ${advice.reason}`,
    '',
    'Required retry focus:',
  ];
  for (const action of advice.actions) {
    const step = stepById.get(action.stepId);
    const toolText = action.toolName ? ` using ${action.toolName}` : '';
    lines.push(`- ${action.stepId} (${step?.kind ?? 'unknown'}): ${describeRecoveryStrategy(action.strategy)}${toolText}.`);
    if (step?.summary) {
      lines.push(`  Step summary: ${truncateRecoveryText(step.summary, 300)}`);
    }
  }
  lines.push(
    '',
    'Do not report completion until the missing step has a matching successful receipt. For write steps, that means a successful filesystem mutation receipt such as fs_write.',
  );
  if (hasWriteRecovery) {
    lines.push(
      '',
      'Write retry requirements:',
      '- Call the filesystem mutation tool named above before ending the turn.',
      '- If the write step names an output path, create or update that exact path.',
      '- If prior evidence found no reportable rows, still write a file whose content obeys the user format constraint, such as an empty path-only report or a short no-matches line when the format allows it.',
      '- Never include secret values in a recovery write; write only the sanitized fields requested by the user.',
    );
  }

  return {
    section: 'Recovery Manager Guidance',
    mode: 'recovery_advisor',
    content: lines.join('\n'),
    itemCount: advice.actions.length,
  };
}

function normalizeRecoveryAdvisorAction(value: Record<string, unknown>): RecoveryAdvisorAction | null {
  const stepId = typeof value.stepId === 'string' ? value.stepId.trim() : '';
  const strategy = normalizeRecoveryAdvisorStrategy(value.strategy);
  if (!stepId || !strategy) return null;
  const toolName = typeof value.toolName === 'string' && value.toolName.trim()
    ? value.toolName.trim()
    : undefined;
  return {
    stepId,
    strategy,
    ...(toolName ? { toolName } : {}),
    ...(typeof value.reason === 'string' && value.reason.trim()
      ? { reason: truncateRecoveryText(value.reason.trim(), 300) }
      : {}),
  };
}

function normalizeRecoveryAdvisorStrategy(value: unknown): RecoveryAdvisorStrategy | null {
  switch (value) {
    case 'complete_missing_search':
    case 'complete_missing_read':
    case 'complete_missing_write':
    case 'answer_from_existing_evidence':
    case 'retry_tool_call':
      return value;
    default:
      return null;
  }
}

function validateRecoveryAdvisorAction(
  action: RecoveryAdvisorAction,
  step: PlannedStep | undefined,
): RecoveryAdvisorAction | null {
  if (!step) return null;
  if (!STRATEGIES_BY_STEP_KIND[step.kind].includes(action.strategy)) {
    return null;
  }
  const allowedTools = ALLOWED_TOOLS_BY_STRATEGY[action.strategy];
  if (allowedTools.length === 0) {
    return {
      stepId: action.stepId,
      strategy: action.strategy,
      ...(action.reason ? { reason: action.reason } : {}),
    };
  }
  if (action.toolName && allowedTools.includes(action.toolName)) {
    return action;
  }
  const fallbackTool = step.expectedToolCategories?.find((category) => allowedTools.includes(category))
    ?? allowedTools[0];
  return {
    stepId: action.stepId,
    strategy: action.strategy,
    toolName: fallbackTool,
    ...(action.reason ? { reason: action.reason } : {}),
  };
}

function readRecoveryUnsatisfiedSteps(input: RecoveryAdvisorRequest): PlannedStep[] {
  const unsatisfied = new Set(input.verification.unsatisfiedStepIds ?? []);
  if (unsatisfied.size <= 0) return [];
  return input.taskContract.plan.steps.filter((step) => step.required && unsatisfied.has(step.stepId));
}

function describeRecoveryStrategy(strategy: RecoveryAdvisorStrategy): string {
  switch (strategy) {
    case 'complete_missing_search':
      return 'run the missing search step';
    case 'complete_missing_read':
      return 'run the missing read step';
    case 'complete_missing_write':
      return 'run the missing write/mutation step';
    case 'answer_from_existing_evidence':
      return 'answer from existing verified evidence';
    case 'retry_tool_call':
      return 'retry the missing tool execution step';
  }
}

function truncateRecoveryText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}...`;
}
