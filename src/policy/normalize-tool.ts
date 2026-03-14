/**
 * Tool family normalizer — converts ToolExecutionRequest + ToolDefinition
 * into a canonical PolicyInput for policy engine evaluation.
 */

import type { PolicyInput, PolicyPrincipal, PolicyResource } from './types.js';
import type { ToolDefinition, ToolExecutionRequest } from '../tools/types.js';

/**
 * Build a PolicyInput from a tool execution request.
 *
 * Resource is always the tool itself; specific targets (file paths,
 * URLs, commands) go into `resource.attrs` for rule matching.
 */
export function normalizeToolRequest(
  request: ToolExecutionRequest,
  definition: ToolDefinition,
  policyMode: string,
): PolicyInput {
  const principal: PolicyPrincipal = {
    kind: request.agentId ? 'agent' : 'user',
    id: request.agentId ?? request.userId ?? 'unknown',
    channel: request.channel,
  };

  const resource: PolicyResource = {
    kind: definition.category ?? 'unknown',
    id: definition.name,
    attrs: extractResourceAttrs(definition.name, request.args),
  };

  return {
    family: 'tool',
    principal,
    action: `tool:${definition.name}`,
    resource,
    context: {
      policyMode,
      isReadOnly: definition.risk === 'read_only',
      risk: definition.risk,
      category: definition.category,
      origin: request.origin,
      dryRun: request.dryRun ?? false,
    },
  };
}

// ── Resource attribute extraction ──────────────────────────────

/**
 * Extract relevant attributes from tool args for fine-grained matching.
 * Only extracts known, security-relevant fields — not raw arg pass-through.
 */
function extractResourceAttrs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};

  switch (toolName) {
    // Filesystem tools: extract path for denied-path matching
    case 'fs_read':
    case 'fs_write':
    case 'fs_list':
    case 'fs_search':
    case 'fs_mkdir':
      if (typeof args.path === 'string') attrs.path = args.path;
      if (typeof args.directory === 'string') attrs.path = args.directory;
      break;

    // Shell: extract command for subshell/pipe detection
    case 'shell_safe':
      if (typeof args.command === 'string') {
        const cmd = args.command.trim();
        attrs.command = cmd;
        attrs.firstWord = cmd.split(/\s+/)[0];
        // Flag shell operators for rule matching
        attrs.hasShellOperators = /[|;&`$()]/.test(cmd);
      }
      break;

    // Web tools: extract target URL/domain
    case 'web_fetch':
      if (typeof args.url === 'string') attrs.url = args.url;
      break;
    case 'web_search':
      if (typeof args.query === 'string') attrs.query = args.query;
      break;

    // Email: extract recipient
    case 'gmail_send':
      if (typeof args.to === 'string') attrs.to = args.to;
      break;

    // Forum: extract target
    case 'forum_post':
      if (typeof args.url === 'string') attrs.url = args.url;
      break;

    // GWS: extract service and method
    case 'gws':
      if (typeof args.service === 'string') attrs.service = args.service;
      if (typeof args.method === 'string') attrs.method = args.method;
      break;

    // Automation: extract workflow/task IDs
    case 'workflow_upsert':
    case 'workflow_delete':
    case 'workflow_run':
      if (typeof args.workflowId === 'string') attrs.workflowId = args.workflowId;
      if (typeof args.id === 'string') attrs.workflowId = args.id;
      break;
    case 'task_create':
    case 'task_update':
    case 'task_delete':
      if (typeof args.taskId === 'string') attrs.taskId = args.taskId;
      break;

    // Intel: extract target/finding
    case 'intel_watch_add':
    case 'intel_watch_remove':
      if (typeof args.target === 'string') attrs.target = args.target;
      break;
    case 'intel_draft_action':
      if (typeof args.findingId === 'string') attrs.findingId = args.findingId;
      if (typeof args.type === 'string') attrs.actionType = args.type;
      break;
  }

  return attrs;
}
