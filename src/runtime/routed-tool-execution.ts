import { stripLeadingContextPrefix } from '../chat-agent-helpers.js';
import type { ToolDefinition } from '../tools/types.js';
import type { PromptAssemblyAdditionalSection } from './context-assembly.js';
import type { IntentGatewayDecision } from './intent-gateway.js';
import { normalizeSecondBrainMutationArgs } from './second-brain/chat-mutation-normalization.js';
import type {
  SecondBrainEventRecord,
  SecondBrainPersonRecord,
  SecondBrainTaskRecord,
} from './second-brain/types.js';

const PROVIDER_MUTATION_METHOD_PATTERN = /\b(create|insert|update|patch|delete|send|remove|modify|forward|reply)\b/i;
const REPO_INSPECTION_SHELL_PATTERN = /\b(?:git\s+grep|grep|rg|findstr|sed|head|tail|cat|type|get-content)\b/i;
const GIT_HISTORY_SHELL_PATTERN = /\b(?:git\s+diff|git\s+show|git\s+log|git\s+blame)\b/i;
const REMOTE_SANDBOX_REQUEST_PATTERN = /\b(?:remote|cloud|isolated|managed)\s+sandbox\b/i;
const EXPLICIT_REMOTE_PROFILE_PATTERN = /\bprofileid\s+([a-z0-9._:-]+)/i;
const NAMED_REMOTE_PROFILE_PATTERN = /\b(?:using|with|via)\s+(?:the\s+)?([a-z0-9][a-z0-9._ -]*?)\s+profile\b/i;
const NAMED_REMOTE_SANDBOX_REQUEST_PATTERN = /\b(?:using|with|via)\s+(?:the\s+)?(?:existing\s+|current\s+|managed\s+)?[a-z0-9][a-z0-9._ -]*?\s+sandbox\b/i;
const SIMPLE_MKDIR_REMOTE_EXEC_PATTERN = /^\s*mkdir(?:\s+-p)?\s+.+$/i;
const SIMPLE_TOUCH_REMOTE_EXEC_PATTERN = /^\s*touch\s+.+$/i;
const SIMPLE_FILE_WRITE_REMOTE_EXEC_PATTERN = /^\s*(?:printf|echo|cat)\b[\s\S]*(?:^|[;&|]\s*|\s)(?:>{1,2}|tee\b)/i;
const REMOTE_VERIFICATION_TOOL_NAMES = new Set(['code_test', 'code_build', 'code_lint']);
const SECOND_BRAIN_MUTATION_TOOLS = new Set([
  'second_brain_generate_brief',
  'second_brain_brief_upsert',
  'second_brain_brief_update',
  'second_brain_brief_delete',
  'second_brain_horizon_scan',
  'second_brain_note_upsert',
  'second_brain_note_delete',
  'second_brain_task_upsert',
  'second_brain_task_delete',
  'second_brain_calendar_upsert',
  'second_brain_calendar_delete',
  'second_brain_routine_create',
  'second_brain_routine_update',
  'second_brain_routine_delete',
  'second_brain_person_upsert',
  'second_brain_person_delete',
  'second_brain_library_upsert',
  'second_brain_library_delete',
]);

interface RoutedToolPreparationInput {
  toolName: string;
  args: Record<string, unknown>;
  requestText?: string;
  referenceTime: number;
  intentDecision?: IntentGatewayDecision | null;
  toolDefinition?: Pick<ToolDefinition, 'category' | 'risk'>;
  getEventById?: (id: string) => SecondBrainEventRecord | null;
  getTaskById?: (id: string) => SecondBrainTaskRecord | null;
  getPersonById?: (id: string) => SecondBrainPersonRecord | null;
}

interface RoutedToolPreparationResult {
  args: Record<string, unknown>;
  immediateResult?: Record<string, unknown>;
}

export function prepareToolExecutionForIntent(
  input: RoutedToolPreparationInput,
): RoutedToolPreparationResult {
  const requestText = typeof input.requestText === 'string'
    ? stripLeadingContextPrefix(input.requestText).trim()
    : '';
  const normalizedArgs = requestText
    ? normalizeSecondBrainMutationArgs({
        toolName: input.toolName,
        args: input.args,
        userContent: requestText,
        referenceTime: input.referenceTime,
        getEventById: input.getEventById,
        getTaskById: input.getTaskById,
        getPersonById: input.getPersonById,
      })
    : input.args;
  const args = normalizeRoutedToolArgs({
    toolName: input.toolName,
    args: normalizedArgs,
    requestText,
    intentDecision: input.intentDecision,
  });
  const immediateResult = buildIntentRoutedToolDenial({
    toolName: input.toolName,
    args,
    requestText,
    intentDecision: input.intentDecision,
    toolDefinition: input.toolDefinition,
  });
  return {
    args,
    ...(immediateResult ? { immediateResult } : {}),
  };
}

function normalizeRoutedToolArgs(input: {
  toolName: string;
  args: Record<string, unknown>;
  requestText?: string;
  intentDecision?: IntentGatewayDecision | null;
}): Record<string, unknown> {
  const explicitProfileId = resolveExplicitRemoteProfileId(input.intentDecision, input.requestText);
  const explicitRemoteSandboxIntent = isExplicitRemoteSandboxIntent(input.intentDecision, input.requestText);
  if (input.toolName === 'code_remote_exec') {
    if (explicitProfileId) {
      return {
        ...input.args,
        profile: explicitProfileId,
      };
    }
    if (!Object.prototype.hasOwnProperty.call(input.args, 'profile')) {
      return input.args;
    }
    const nextArgs = { ...input.args };
    delete nextArgs.profile;
    return nextArgs;
  }

  if (!REMOTE_VERIFICATION_TOOL_NAMES.has(input.toolName)) {
    return input.args;
  }

  const nextArgs = { ...input.args };
  if (explicitProfileId) {
    nextArgs.remoteProfile = explicitProfileId;
  } else if (Object.prototype.hasOwnProperty.call(nextArgs, 'remoteProfile')) {
    delete nextArgs.remoteProfile;
  }
  if (explicitRemoteSandboxIntent) {
    nextArgs.isolation = 'remote_required';
  }
  return nextArgs;
}

export function buildRoutedIntentAdditionalSection(
  decision: IntentGatewayDecision | null | undefined,
): PromptAssemblyAdditionalSection | undefined {
  if (!decision) return undefined;
  const entityLines = Object.entries(decision.entities)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${String(value)}`);
  const ruleLines = buildRoutedIntentRuleLines(decision);
  const lines = [
    `route: ${decision.route}`,
    `operation: ${decision.operation}`,
    `resolution: ${decision.resolution}`,
    ...(entityLines.length > 0 ? ['entities:', ...entityLines.map((line) => `- ${line}`)] : []),
    ...(ruleLines.length > 0 ? ['execution rules:', ...ruleLines.map((line) => `- ${line}`)] : []),
  ];
  return {
    section: 'routed_intent',
    mode: 'explicit',
    content: wrapTaggedSection('routed-intent', lines.join('\n')),
  };
}

export function buildToolExecutionCorrectionPrompt(
  decision: IntentGatewayDecision | null | undefined,
): string | undefined {
  if (!decision) return undefined;

  if (decision.route === 'complex_planning_task') {
    const lines = [
      'System correction: this turn is already routed to Guardian\'s brokered complex-planning path.',
      'Do not stop at narration, limitations, or "I will inspect" commentary before using tools.',
      'Use the brokered filesystem and repo tools now to inspect the requested files and create the requested scratch outputs.',
      'Only ask the user for approval after a real tool result returns pending_approval.',
    ];
    if (decision.entities.codingRemoteExecRequested === true) {
      lines.splice(
        2,
        0,
        'Because the user explicitly requested remote sandbox execution, keep the execution in code_remote_exec or remote-required verification tools instead of drifting back to host tooling.',
      );
    }
    return lines.join(' ');
  }

  if (decision.route === 'coding_task' && (decision.requiresRepoGrounding || decision.operation === 'run')) {
    const lines = [
      'System correction: this turn is a repo-grounded coding request.',
      'Do not answer from memory or stop at narration before using repo/filesystem tools.',
      'Inspect the requested files with fs_search, code_symbol_search, and fs_read, and write any requested scratch outputs with fs_write/fs_mkdir unless a real tool result blocks you.',
      'Only ask the user for approval after a real tool result returns pending_approval.',
    ];
    if (decision.entities.codingRemoteExecRequested === true) {
      lines.splice(
        3,
        0,
        'Because the user explicitly requested remote sandbox execution, keep the execution in code_remote_exec or remote-required verification tools instead of falling back to host execution.',
      );
    }
    return lines.join(' ');
  }

  return undefined;
}

function buildIntentRoutedToolDenial(input: {
  toolName: string;
  args: Record<string, unknown>;
  requestText?: string;
  intentDecision?: IntentGatewayDecision | null;
  toolDefinition?: Pick<ToolDefinition, 'category' | 'risk'>;
}): Record<string, unknown> | undefined {
  const decision = input.intentDecision;
  if (!decision) return undefined;

  if (isExplicitRemoteSandboxIntent(decision, input.requestText)) {
    if (input.toolName === 'shell_safe') {
      return {
        success: false,
        status: 'denied',
        message: 'The user explicitly requested remote sandbox execution. Use code_remote_exec or code_test/code_build/code_lint with remote isolation instead of shell_safe.',
      };
    }
    if (input.toolName === 'package_install') {
      return {
        success: false,
        status: 'denied',
        message: 'The user explicitly requested remote sandbox execution. Do not use package_install here because it can degrade back to host execution. Use code_remote_exec for the install command instead.',
      };
    }
  }

  if (decision.route === 'personal_assistant_task' && isProviderMutationTool(input)) {
    const message = decision.entities.personalItemType === 'calendar' && decision.entities.calendarTarget === 'local'
      ? 'This turn is routed to Guardian\'s local Second Brain calendar. Do not mutate Google Calendar or Outlook Calendar here. Use the local Second Brain calendar tool instead.'
      : 'This turn is routed to Guardian Second Brain work. Do not mutate Google Workspace, Microsoft 365, Gmail, or Outlook objects unless the user explicitly targeted that provider.';
    return {
      success: false,
      status: 'denied',
      message,
    };
  }

  if ((decision.route === 'workspace_task' || decision.route === 'email_task') && isSecondBrainMutationTool(input.toolName)) {
    return {
      success: false,
      status: 'denied',
      message: decision.route === 'email_task'
        ? 'This turn explicitly targets provider-owned email work. Do not mutate local Second Brain records here unless the user explicitly asks for Guardian / Second Brain storage.'
        : 'This turn explicitly targets provider CRUD. Do not mutate local Second Brain records here unless the user explicitly asks for Guardian / Second Brain storage.',
    };
  }

  if (shouldDenyRepoInspectionShell(input, decision)) {
    return {
      success: false,
      status: 'denied',
      message: 'This is a repo-grounded inspect/search turn. Use fs_search, code_symbol_search, and fs_read instead of shell_safe for grep/git/cat-style inspection unless the user explicitly asked for shell or git output.',
    };
  }

  if (shouldDenyTrivialFilesystemRemoteExec(input, decision)) {
    return {
      success: false,
      status: 'denied',
      message: 'Use brokered filesystem tools for simple file or directory changes in this turn. Prefer fs_mkdir for directory creation and fs_write for writing text files. Reserve code_remote_exec for bounded remote commands that truly need sandbox execution.',
    };
  }

  return undefined;
}

function isProviderMutationTool(input: {
  toolName: string;
  args: Record<string, unknown>;
  toolDefinition?: Pick<ToolDefinition, 'category' | 'risk'>;
}): boolean {
  if (input.toolName === 'gmail_draft' || input.toolName === 'gmail_send'
    || input.toolName === 'outlook_draft' || input.toolName === 'outlook_send') {
    return true;
  }
  if (input.toolName === 'gws' || input.toolName === 'm365') {
    const method = typeof input.args.method === 'string' ? input.args.method : '';
    return PROVIDER_MUTATION_METHOD_PATTERN.test(method);
  }
  if (input.toolDefinition?.category === 'email' && input.toolDefinition.risk !== 'read_only') {
    return true;
  }
  return false;
}

function isSecondBrainMutationTool(toolName: string): boolean {
  return SECOND_BRAIN_MUTATION_TOOLS.has(toolName);
}

function buildRoutedIntentRuleLines(decision: IntentGatewayDecision): string[] {
  if (decision.route === 'coding_task' && decision.requiresRepoGrounding) {
    if (decision.entities.codingBackend && decision.entities.codingBackendRequested === true) {
      return [
        'This turn is a repo-grounded coding request.',
        `The user explicitly requested the external coding backend "${decision.entities.codingBackend}".`,
        'Use coding_backend_run for the main execution step instead of doing the requested coding work with built-in edit tools.',
        'Keep the active coding session workspace as the anchor for the delegated run.',
        'After the backend finishes, verify the result with code_git_diff, code_test, code_build, or code_lint before reporting success.',
      ];
    }
    const lines = [
      'This turn is a repo-grounded coding request.',
      'Prefer native repo tools first: fs_search, code_symbol_search, and fs_read for locating and reading code.',
      'Do not use shell_safe for grep, git grep, cat, sed, or similar repo inspection when the built-in repo tools can answer the question.',
    ];
    if (decision.operation === 'run') {
      lines.push('This is an explicit request to run repo commands (such as tests, builds, or scripts).');
      lines.push('Do NOT guess commands in an ad hoc loop. You MUST formulate a single bounded execution plan using code_test, code_build, code_lint, or code_remote_exec.');
      lines.push('If a test or build fails because of missing dependencies (e.g. "vitest: command not found"), do NOT immediately guess the next installation command. Stop, output a concrete diagnosis of the failure, and ask for permission before adjusting the plan or installing packages.');
    }
    if (decision.entities.codingRemoteExecRequested === true) {
      lines.push('For explicit remote sandbox requests, use code_remote_exec for arbitrary commands or code_test/code_build/code_lint with remote-required isolation for structured verification.');
      if (typeof decision.entities.profileId === 'string' && decision.entities.profileId.trim()) {
        lines.push(`CRITICAL: The user explicitly named the remote execution profile "${decision.entities.profileId}". You MUST include \`profile: "${decision.entities.profileId}"\` in the arguments of EVERY remote sandbox tool call you make in this turn, including any retries or follow-up steps.`);
      } else {
        lines.push('Omit profile arguments unless the user explicitly named a remote execution profile. Generic remote-sandbox runs should use the configured default remote sandbox.');
      }
      lines.push('If the user asked for multiple remote sandbox steps, issue exactly one remote sandbox tool call at a time and wait for its result before the next remote sandbox step.');
      lines.push('Do not fall back to shell_safe or package_install on the host during this turn if the remote lane fails or is unavailable.');
    }
    if (decision.preferredAnswerPath === 'chat_synthesis') {
      lines.push('Read the named files or search hits first, then synthesize the answer or review findings in the response.');
    }
    return lines;
  }
  if (decision.route === 'personal_assistant_task') {
    const lines = [
      'This turn is already routed to Guardian Second Brain work.',
      'Keep local notes, tasks, contacts, library items, briefs, routines, and local calendar mutations in the shared Second Brain store.',
      'Do not mutate Google Workspace, Microsoft 365, Gmail, or Outlook objects unless the user explicitly targeted that provider.',
    ];
    if (decision.entities.personalItemType === 'calendar' && decision.entities.calendarTarget === 'local') {
      lines.splice(1, 0, 'Do not ask the user to choose Google or Microsoft for this turn.');
    }
    return lines;
  }
  if (decision.route === 'workspace_task') {
    return [
      'This turn explicitly targets provider CRUD or provider administration.',
      'Use the named provider path instead of mutating local Second Brain records.',
    ];
  }
  if (decision.route === 'email_task') {
    return [
      'This turn explicitly targets provider-owned email work.',
      'Use provider email tools instead of mutating local Second Brain records.',
    ];
  }
  if (decision.route === 'complex_planning_task') {
    const lines = [
      'This turn explicitly targets Guardian\'s brokered complex-planning path.',
      'Prefer brokered filesystem and repo tools first: fs_read, fs_search, fs_mkdir, and fs_write for file and directory work inside the workspace.',
      'Do not use code_remote_exec for simple directory creation or text-file writes unless the user explicitly asked for remote sandbox execution.',
    ];
    if (decision.entities.codingRemoteExecRequested === true) {
      lines.push('Because the user explicitly asked for remote sandbox execution, code_remote_exec or remote-required verification tools are allowed for the execution steps that truly need sandboxed commands.');
    }
    return lines;
  }
  return [];
}

function wrapTaggedSection(tag: string, content: string): string {
  return `[${tag}]\n${content}\n[/${tag}]`;
}

function isExplicitRemoteSandboxIntent(
  decision: IntentGatewayDecision | null | undefined,
  requestText?: string,
): boolean {
  if (decision?.route === 'coding_task' && decision.entities.codingRemoteExecRequested === true) {
    return true;
  }
  const normalizedRequest = typeof requestText === 'string'
    ? stripLeadingContextPrefix(requestText).trim()
    : '';
  if (!normalizedRequest) return false;
  if (resolveExplicitRemoteProfileId(decision, normalizedRequest)) {
    return true;
  }
  return REMOTE_SANDBOX_REQUEST_PATTERN.test(normalizedRequest)
    || NAMED_REMOTE_SANDBOX_REQUEST_PATTERN.test(normalizedRequest);
}

function resolveExplicitRemoteProfileId(
  decision: IntentGatewayDecision | null | undefined,
  requestText?: string,
): string {
  const gatewayProfileId = typeof decision?.entities.profileId === 'string' && decision.entities.profileId.trim()
    ? decision.entities.profileId.trim()
    : '';
  if (gatewayProfileId) return gatewayProfileId;
  const normalizedRequest = typeof requestText === 'string'
    ? stripLeadingContextPrefix(requestText).trim()
    : '';
  if (!normalizedRequest) return '';
  const match = normalizedRequest.match(EXPLICIT_REMOTE_PROFILE_PATTERN);
  if (match?.[1]?.trim()) {
    return match[1].trim().replace(/[)"'\].,!?;]+$/g, '');
  }
  const namedMatch = normalizedRequest.match(NAMED_REMOTE_PROFILE_PATTERN);
  return (namedMatch?.[1]?.trim() || '').replace(/[)"'\].,!?;]+$/g, '');
}

function shouldDenyRepoInspectionShell(
  input: {
    toolName: string;
    args: Record<string, unknown>;
    requestText?: string;
  },
  decision: IntentGatewayDecision,
): boolean {
  if (input.toolName !== 'shell_safe') return false;
  if (decision.route !== 'coding_task' || !decision.requiresRepoGrounding) return false;
  if (!['inspect', 'search', 'read'].includes(decision.operation)) return false;

  const command = typeof input.args.command === 'string' ? input.args.command : '';
  if (!command.trim()) return false;

  if (REPO_INSPECTION_SHELL_PATTERN.test(command)) return true;

  const requestText = typeof input.requestText === 'string'
    ? stripLeadingContextPrefix(input.requestText).trim()
    : '';
  if (!requestText) return false;

  return GIT_HISTORY_SHELL_PATTERN.test(command)
    && namesExplicitFilesInRequest(requestText)
    && !/\b(?:diff|patch|commit|commits|pull request|pr|git)\b/i.test(requestText);
}

function shouldDenyTrivialFilesystemRemoteExec(
  input: {
    toolName: string;
    args: Record<string, unknown>;
    requestText?: string;
  },
  decision: IntentGatewayDecision,
): boolean {
  if (input.toolName !== 'code_remote_exec') return false;
  if (isExplicitRemoteSandboxIntent(decision, input.requestText)) return false;

  const command = typeof input.args.command === 'string' ? input.args.command.trim() : '';
  if (!command) return false;

  return SIMPLE_MKDIR_REMOTE_EXEC_PATTERN.test(command)
    || SIMPLE_TOUCH_REMOTE_EXEC_PATTERN.test(command)
    || SIMPLE_FILE_WRITE_REMOTE_EXEC_PATTERN.test(command);
}

function namesExplicitFilesInRequest(requestText: string): boolean {
  return /(?:^|\s)(?:[A-Za-z]:[\\/]|\/|\.\/|\.\.\/)?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+(?:\s|$)/.test(requestText);
}
