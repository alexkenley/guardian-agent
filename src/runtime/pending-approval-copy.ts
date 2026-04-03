export interface PendingApprovalSummary {
  toolName: string;
  argsPreview: string;
}

export interface PendingApprovalMetadata extends PendingApprovalSummary {
  id: string;
}

const WEAK_PENDING_PATTERNS = [
  /^\s*$/i,
  /^i need your approval before proceeding\.?$/i,
  /^this action needs approval before i can continue\.?$/i,
  /^this action needs your approval\. the approval ui is shown to the user automatically\.?$/i,
  /\btool is (?:un)?available\b/i,
  /\bcorrect arguments\b/i,
  /\baction and value\b/i,
  /\bapproval id\b/i,
];

function normalizePreview(preview: string | undefined): string {
  return (preview ?? '').replace(/\s+/g, ' ').trim();
}

function tryParsePreview(preview: string): Record<string, unknown> | null {
  const normalized = normalizePreview(preview);
  if (!normalized.startsWith('{') || !normalized.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function describePolicyUpdate(preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;

  const action = asString(parsed.action);
  const value = asString(parsed.value);
  if (!action || !value) return null;

  switch (action) {
    case 'add_path':
      return `add ${value} to allowed paths`;
    case 'remove_path':
      return `remove ${value} from allowed paths`;
    case 'add_command':
      return `allow command ${value}`;
    case 'remove_command':
      return `remove command ${value}`;
    case 'add_domain':
      return `allow domain ${value}`;
    case 'remove_domain':
      return `remove domain ${value}`;
    case 'set_tool_policy_auto':
      return `set tool policy ${value} to auto-approve`;
    case 'set_tool_policy_manual':
      return `set tool policy ${value} to manual approval`;
    case 'set_tool_policy_deny':
      return `set tool policy ${value} to deny`;
    default:
      return null;
  }
}

function describeProviderUpdate(preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;

  const action = asString(parsed.action);
  const provider = asString(parsed.provider);
  const model = asString(parsed.model);
  const locality = asString(parsed.locality);

  switch (action) {
    case 'set_model':
      return provider && model ? `switch ${provider} to model ${model}` : null;
    case 'set_default':
      return provider ? `set default provider to ${provider}` : null;
    case 'set_preferred':
      return provider && locality ? `set preferred ${locality} provider to ${provider}` : null;
    default:
      return null;
  }
}

function describeFilesystemWrite(toolName: string, preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;

  const path = asString(parsed.path);
  if (!path) return null;

  if (toolName === 'doc_create') {
    return `create ${path}`;
  }

  return parsed.append === true
    ? `append to ${path}`
    : `write ${path}`;
}

function describeFilesystemMove(preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;

  const source = asString(parsed.source);
  const destination = asString(parsed.destination);
  if (!source || !destination) return null;
  return `move ${source} to ${destination}`;
}

function describeAutomationAction(toolName: string, preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) {
    const normalized = normalizePreview(preview);
    if (!normalized) return null;
    switch (toolName) {
      case 'automation_save':
        return /^save\b/i.test(normalized) ? normalized : `save automation ${normalized}`;
      case 'automation_set_enabled':
      case 'automation_run':
      case 'automation_delete':
        return normalized;
      default:
        return null;
    }
  }

  const automationId = asString(parsed.automationId) || asString(parsed.id);
  const name = asString(parsed.name) || automationId;

  switch (toolName) {
    case 'automation_save':
      return name ? `save automation ${name}` : 'save automation';
    case 'automation_set_enabled':
      if (automationId) {
        return `${parsed.enabled === false ? 'disable' : 'enable'} automation ${automationId}`;
      }
      return parsed.enabled === false ? 'disable automation' : 'enable automation';
    case 'automation_run':
      if (automationId) {
        return `${parsed.dryRun === true ? 'dry-run' : 'run'} automation ${automationId}`;
      }
      return parsed.dryRun === true ? 'dry-run automation' : 'run automation';
    case 'automation_delete':
      return automationId ? `delete automation ${automationId}` : 'delete automation';
    default:
      return null;
  }
}

export function describePendingApproval(summary: PendingApprovalSummary): string {
  const preview = normalizePreview(summary.argsPreview);

  if (summary.toolName === 'update_tool_policy') {
    const policyDescription = describePolicyUpdate(preview);
    if (policyDescription) return policyDescription;
  }

  if (summary.toolName === 'llm_provider_update') {
    const providerDescription = describeProviderUpdate(preview);
    if (providerDescription) return providerDescription;
  }

  if (summary.toolName === 'fs_write' || summary.toolName === 'doc_create') {
    const writeDescription = describeFilesystemWrite(summary.toolName, preview);
    if (writeDescription) return writeDescription;
  }

  if (summary.toolName === 'fs_delete') {
    const parsed = tryParsePreview(preview);
    const path = asString(parsed?.path);
    if (path) return `delete ${path}`;
  }

  if (summary.toolName === 'fs_move') {
    const moveDescription = describeFilesystemMove(preview);
    if (moveDescription) return moveDescription;
  }

  if (
    summary.toolName === 'automation_save'
    || summary.toolName === 'automation_set_enabled'
    || summary.toolName === 'automation_run'
    || summary.toolName === 'automation_delete'
  ) {
    const automationDescription = describeAutomationAction(summary.toolName, preview);
    if (automationDescription) return automationDescription;
  }

  if (preview) {
    return `run ${summary.toolName} - ${preview}`;
  }

  return `run ${summary.toolName}`;
}

export function formatPendingApprovalMessage(approvals: readonly PendingApprovalSummary[]): string {
  if (approvals.length === 0) return 'Waiting for approval.';

  if (approvals.length === 1) {
    return `Waiting for approval to ${describePendingApproval(approvals[0])}.`;
  }

  return [
    `Waiting for approval on ${approvals.length} actions:`,
    ...approvals.map((approval) => `- ${describePendingApproval(approval)}`),
  ].join('\n');
}

export function buildPendingApprovalMetadata(
  ids: readonly string[],
  summaries?: Map<string, PendingApprovalSummary>,
): PendingApprovalMetadata[] {
  const seen = new Set<string>();
  const metadata: PendingApprovalMetadata[] = [];
  for (const rawId of ids) {
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const summary = summaries?.get(id);
    metadata.push({
      id,
      toolName: summary?.toolName ?? 'unknown',
      argsPreview: summary?.argsPreview ?? '',
    });
  }
  return metadata;
}

export function shouldUseStructuredPendingApprovalMessage(content: string | undefined): boolean {
  const normalized = (content ?? '').trim();
  return WEAK_PENDING_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isPhantomPendingApprovalMessage(content: string | undefined): boolean {
  const normalized = (content ?? '').trim();
  return /^this action needs approval before i can continue\.?$/i.test(normalized)
    || /^this action needs your approval\. the approval ui is shown to the user automatically\.?$/i.test(normalized)
    || /(?:^|\n)\s*waiting for approval to\b/i.test(normalized)
    || /(?:^|\n)\s*approval required for this action:?/i.test(normalized)
    || /\breply ["']yes["'] to approve or ["']no["'] to deny\b/i.test(normalized)
    || /(?:^|\n)\s*optional:\s*\/approve\b/i.test(normalized);
}
