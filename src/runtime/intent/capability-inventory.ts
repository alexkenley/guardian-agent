import {
  BUILTIN_TOOL_CATEGORIES,
  type ToolCategory,
} from '../../tools/types.js';
import type { IntentGatewayRoute } from './types.js';

const EXPLICIT_PROFILE_ID_PATTERN = /\bprofileid\s+([a-z0-9._:-]+)/i;

const ALL_BUILTIN_TOOL_NAMES = Object.values(BUILTIN_TOOL_CATEGORIES)
  .flatMap((names) => names)
  .sort((left, right) => right.length - left.length);

const TOOL_CATEGORY_BY_NAME = new Map<string, ToolCategory>(
  Object.entries(BUILTIN_TOOL_CATEGORIES)
    .flatMap(([category, names]) => names.map((name) => [name, category as ToolCategory])),
);

export const INTENT_GATEWAY_CAPABILITY_INVENTORY_PROMPT_LINES = [
  'Capability ownership backstop:',
  '- Skill names are downstream execution aids. Route the underlying user task, not the skill label itself.',
  '- Explicit built-in tool names should map to the route that owns that tool family.',
  '- code_session_* tools own coding_session_control; repo inspection, coding backend delegation, code_remote_exec, code_test, code_build, and code_lint own coding_task.',
  '- automation_save owns automation_authoring; automation_list, automation_run, automation_set_enabled, automation_delete, and automation_clone-style control requests own automation_control; automation_output_* owns automation_output_task.',
  '- second_brain_* tools own personal_assistant_task; memory_* owns memory_task.',
  '- web_search and doc_search own search_task; web_fetch, chrome_job, and browser_* own browser_task.',
  '- gws and gws_schema own workspace_task; gmail_* owns email_task.',
  '- assistant_security_* and intel_* own security_task.',
  '- guardian_issue_draft owns diagnostics_task. User-facing requests to create, open, file, or prepare a GuardianAgent GitHub issue about app behavior should route to diagnostics_task first so Guardian drafts a redacted report before any external post. github_issue_create is only for submitting a reviewed GuardianAgent diagnostics draft and should also route to diagnostics_task.',
  '- Explicit cloud, GitHub, system, network, contacts, campaign, forum, shell, or MCP tool invocations default to general_assistant unless a more specific route clearly owns the request.',
  '- External contact discovery, CSV import, and outreach campaign management are not Second Brain contact reads. Prefer general_assistant with tool orchestration for those requests.',
];

export function getBuiltinToolCategory(toolName: string | undefined): ToolCategory | undefined {
  if (!toolName) return undefined;
  return TOOL_CATEGORY_BY_NAME.get(toolName.trim());
}

export function findExplicitBuiltinToolName(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const normalized = content.toLowerCase();
  for (const toolName of ALL_BUILTIN_TOOL_NAMES) {
    const pattern = new RegExp(`(^|[^a-z0-9_])${escapeForRegex(toolName.toLowerCase())}([^a-z0-9_]|$)`);
    if (pattern.test(normalized)) {
      return toolName;
    }
  }
  return undefined;
}

export function extractExplicitProfileId(
  content: string | undefined,
): string | undefined {
  if (!content) return undefined;
  const match = content.match(EXPLICIT_PROFILE_ID_PATTERN);
  const profileId = match?.[1]?.trim();
  return profileId ? profileId.replace(/[)"'\].,!?;]+$/g, '') : undefined;
}

export function resolveRouteForExplicitToolName(
  toolName: string | undefined,
): IntentGatewayRoute | undefined {
  const trimmed = toolName?.trim();
  if (!trimmed) return undefined;
  const category = getBuiltinToolCategory(trimmed);
  if (!category) return undefined;

  if (trimmed === 'guardian_issue_draft' || trimmed === 'github_issue_create') {
    return 'diagnostics_task';
  }

  switch (category) {
    case 'filesystem':
      return 'filesystem_task';
    case 'coding':
      if (trimmed.startsWith('code_session_')) {
        return 'coding_session_control';
      }
      return 'coding_task';
    case 'web':
      if (trimmed === 'web_search') return 'search_task';
      return 'browser_task';
    case 'browser':
      return 'browser_task';
    case 'automation':
      if (trimmed.startsWith('automation_output_')) {
        return 'automation_output_task';
      }
      if (trimmed === 'automation_save') {
        return 'automation_authoring';
      }
      return 'automation_control';
    case 'email':
      return 'email_task';
    case 'workspace':
      return 'workspace_task';
    case 'security':
    case 'intel':
      return 'security_task';
    case 'memory':
      return trimmed.startsWith('second_brain_')
        ? 'personal_assistant_task'
        : 'memory_task';
    case 'search':
      return 'search_task';
    case 'shell':
    case 'mcp':
    case 'contacts':
    case 'forum':
    case 'network':
    case 'cloud':
    case 'github':
    case 'system':
      return 'general_assistant';
    default:
      return undefined;
  }
}

export function listBuiltinToolsMissingRouteCoverage(): string[] {
  return ALL_BUILTIN_TOOL_NAMES.filter((toolName) => !resolveRouteForExplicitToolName(toolName));
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
