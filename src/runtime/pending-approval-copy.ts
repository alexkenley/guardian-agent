export interface PendingApprovalSummary {
  toolName: string;
  argsPreview: string;
}

const WEAK_PENDING_PATTERNS = [
  /^\s*$/i,
  /^i need your approval before proceeding\.?$/i,
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

export function describePendingApproval(summary: PendingApprovalSummary): string {
  const preview = normalizePreview(summary.argsPreview);

  if (summary.toolName === 'update_tool_policy') {
    const policyDescription = describePolicyUpdate(preview);
    if (policyDescription) return policyDescription;
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

export function shouldUseStructuredPendingApprovalMessage(content: string | undefined): boolean {
  const normalized = (content ?? '').trim();
  return WEAK_PENDING_PATTERNS.some((pattern) => pattern.test(normalized));
}
