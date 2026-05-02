import type {
  IntentGatewayConfidence,
  IntentGatewayEntities,
  IntentGatewayExecutionClass,
  IntentGatewayExpectedContextPressure,
  IntentGatewayOperation,
  IntentGatewayPreferredAnswerPath,
  IntentGatewayPreferredTier,
  IntentGatewayPromptProfile,
  IntentGatewayResolution,
  IntentGatewayRoute,
  IntentGatewaySimpleVsComplex,
  IntentGatewayTurnRelation,
} from './types.js';

export function normalizeRoute(value: unknown): IntentGatewayRoute {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'complex_planning_task':
    case 'automation_authoring':
    case 'automation_control':
    case 'automation_output_task':
    case 'ui_control':
    case 'browser_task':
    case 'personal_assistant_task':
    case 'workspace_task':
    case 'email_task':
    case 'search_task':
    case 'memory_task':
    case 'filesystem_task':
    case 'coding_task':
    case 'coding_session_control':
    case 'security_task':
    case 'general_assistant':
      return normalized;
    case 'automation_output':
      return 'automation_output_task';
    case 'ui':
    case 'ui_task':
      return 'ui_control';
    case 'browser':
      return 'browser_task';
    case 'personal_assistant':
    case 'personal_productivity':
    case 'second_brain':
    case 'assistant_productivity':
      return 'personal_assistant_task';
    case 'workspace':
      return 'workspace_task';
    case 'email':
    case 'mail':
      return 'email_task';
    case 'search':
    case 'web_search':
      return 'search_task';
    case 'memory':
      return 'memory_task';
    case 'filesystem':
    case 'file_system':
    case 'file':
      return 'filesystem_task';
    case 'coding':
      return 'coding_task';
    case 'coding_session':
    case 'code_session':
    case 'coding_workspace':
    case 'coding_workspace_session':
    case 'session_control':
    case 'session_management':
    case 'coding_session_management':
    case 'workspace_management':
    case 'coding_workspace_management':
    case 'coding_workspace_session_control':
    case 'coding_workspace_control':
    case 'workspace_session_control':
    case 'workspace_switch_control':
      return 'coding_session_control';
    case 'security':
      return 'security_task';
    case 'general':
    case 'assistant':
      return 'general_assistant';
    case 'complex_planning':
    case 'planning':
    case 'planning_task':
    case 'complex_planner':
      return 'complex_planning_task';
    default:
      return 'unknown';
  }
}

export function normalizeConfidence(value: unknown): IntentGatewayConfidence {
  switch (value) {
    case 'high':
    case 'medium':
    case 'low':
      return value;
    default:
      return 'low';
  }
}

export function normalizeOperation(value: unknown): IntentGatewayOperation {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'create':
    case 'update':
    case 'delete':
    case 'run':
    case 'toggle':
    case 'clone':
    case 'inspect':
    case 'navigate':
    case 'read':
    case 'search':
    case 'save':
    case 'send':
    case 'draft':
    case 'schedule':
      return normalized;
    case 'list':
    case 'browse':
      return 'navigate';
    case 'show':
      return 'inspect';
    case 'current':
    case 'check':
    case 'status':
    case 'current_session':
    case 'current_workspace':
      return 'inspect';
    case 'switch':
    case 'attach':
    case 'change':
    case 'select':
    case 'switch_session':
    case 'switch_workspace':
    case 'attach_session':
    case 'attach_workspace':
    case 'change_workspace':
      return 'update';
    case 'detach':
    case 'disconnect':
    case 'remove':
    case 'detach_session':
    case 'detach_workspace':
      return 'delete';
    case 'execute':
    case 'start':
      return 'run';
    case 'copy':
    case 'duplicate':
      return 'clone';
    case 'recall':
      return 'read';
    case 'find':
      return 'search';
    case 'remember':
    case 'store':
      return 'save';
    case 'compose':
      return 'draft';
    case 'enable':
    case 'disable':
      return 'toggle';
    default:
      return 'unknown';
  }
}

export function normalizeTurnRelation(value: unknown): IntentGatewayTurnRelation {
  switch (value) {
    case 'new_request':
    case 'follow_up':
    case 'clarification_answer':
    case 'correction':
      return value;
    default:
      return 'new_request';
  }
}

export function normalizeResolution(value: unknown): IntentGatewayResolution {
  switch (value) {
    case 'ready':
    case 'needs_clarification':
      return value;
    default:
      return 'ready';
  }
}

export function normalizeUiSurface(
  value: unknown,
): IntentGatewayEntities['uiSurface'] | undefined {
  switch (value) {
    case 'automations':
    case 'system':
    case 'dashboard':
    case 'config':
    case 'chat':
    case 'unknown':
      return value;
    default:
      return undefined;
  }
}

export function normalizeAutomationReadView(
  value: unknown,
): IntentGatewayEntities['automationReadView'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'catalog':
    case 'list':
    case 'full':
    case 'summary':
      return 'catalog';
    case 'count':
    case 'number':
    case 'total':
      return 'count';
    default:
      return undefined;
  }
}

export function normalizeCodeSessionResource(
  value: unknown,
): IntentGatewayEntities['codeSessionResource'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'session':
    case 'current_session':
    case 'active_session':
      return 'session';
    case 'session_list':
    case 'sessions':
    case 'list':
    case 'workspace_list':
    case 'workspaces':
      return 'session_list';
    case 'managed_sandboxes':
    case 'managed_sandboxes_list':
    case 'sandboxes':
    case 'sandbox_list':
      return 'managed_sandboxes';
    default:
      return undefined;
  }
}

export function normalizeCodeSessionSandboxProvider(
  value: unknown,
): IntentGatewayEntities['codeSessionSandboxProvider'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'daytona':
    case 'daytona_sandbox':
      return 'daytona';
    case 'vercel':
    case 'vercel_sandbox':
      return 'vercel';
    case 'all':
    case 'any':
    case 'remote':
    case 'managed':
    case 'managed_sandboxes':
    case 'remote_sandboxes':
      return 'all';
    default:
      return undefined;
  }
}

export function normalizeEmailProvider(
  value: unknown,
): IntentGatewayEntities['emailProvider'] | undefined {
  switch (value) {
    case 'gws':
    case 'm365':
      return value;
    default:
      return undefined;
  }
}

export function normalizeMailboxReadMode(
  value: unknown,
): IntentGatewayEntities['mailboxReadMode'] | undefined {
  switch (value) {
    case 'unread':
    case 'latest':
      return value;
    default:
      return undefined;
  }
}

export function normalizeIntentGatewayPromptProfile(
  value: unknown,
): IntentGatewayPromptProfile | undefined {
  switch (value) {
    case 'compact':
    case 'full':
      return value;
    default:
      return undefined;
  }
}

export function normalizeCalendarTarget(
  value: unknown,
): IntentGatewayEntities['calendarTarget'] | undefined {
  switch (value) {
    case 'local':
    case 'gws':
    case 'm365':
      return value;
    default:
      return undefined;
  }
}

export function normalizeCalendarWindowDays(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.trunc(value);
  if (normalized < 1 || normalized > 366) return undefined;
  return normalized;
}

export function normalizeCodingBackend(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  switch (lower) {
    case 'unknown':
    case 'none':
    case 'n/a':
    case 'not specified':
    case 'unspecified':
      return undefined;
    case 'codex':
    case 'openai codex':
    case 'openai codex cli':
    case 'codex cli':
      return 'codex';
    case 'claude code':
    case 'claude-code':
      return 'claude-code';
    case 'gemini':
    case 'gemini cli':
    case 'gemini-cli':
      return 'gemini-cli';
    case 'aider':
      return 'aider';
    default:
      return trimmed;
  }
}

export function normalizeSearchSourceType(
  value: unknown,
): IntentGatewayEntities['searchSourceType'] | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value.trim().toLowerCase()) {
    case 'directory':
    case 'folder':
      return 'directory';
    case 'file':
      return 'file';
    case 'git':
    case 'repo':
    case 'repository':
    case 'github':
      return 'git';
    case 'url':
    case 'web':
    case 'website':
      return 'url';
    default:
      return undefined;
  }
}

export function normalizeFileExtension(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  normalized = normalized.replace(/^\*\./, '.').replace(/^\*+/, '');
  if (!normalized.startsWith('.')) {
    normalized = `.${normalized}`;
  }
  if (!/^\.[a-z0-9][a-z0-9._+-]{0,31}$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export function normalizeExecutionClass(
  value: unknown,
): IntentGatewayExecutionClass | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'direct_assistant':
    case 'tool_orchestration':
    case 'repo_grounded':
    case 'provider_crud':
    case 'security_analysis':
      return normalized;
    default:
      return undefined;
  }
}

export function normalizePreferredTier(
  value: unknown,
): IntentGatewayPreferredTier | undefined {
  switch (value) {
    case 'local':
    case 'external':
      return value;
    default:
      return undefined;
  }
}

export function normalizeExpectedContextPressure(
  value: unknown,
): IntentGatewayExpectedContextPressure | undefined {
  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
      return value;
    default:
      return undefined;
  }
}

export function normalizeSimpleVsComplex(
  value: unknown,
): IntentGatewaySimpleVsComplex | undefined {
  switch (value) {
    case 'simple':
    case 'complex':
      return value;
    default:
      return undefined;
  }
}

export function normalizePreferredAnswerPath(
  value: unknown,
): IntentGatewayPreferredAnswerPath | undefined {
  switch (value) {
    case 'direct':
    case 'tool_loop':
    case 'chat_synthesis':
      return value;
    default:
      return undefined;
  }
}
