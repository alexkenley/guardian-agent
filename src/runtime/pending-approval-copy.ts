export interface PendingApprovalSummary {
  toolName: string;
  argsPreview: string;
  actionLabel?: string;
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

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function titleCaseWords(value: string): string {
  return value
    .split(/\s+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function humanizeToolName(toolName: string): string {
  return toolName
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function quote(value: string): string {
  return `"${value}"`;
}

interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

interface CalendarTimeParts {
  hour: number;
  minute: number;
  second: number;
}

interface CalendarDateTimeParts extends CalendarDateParts, CalendarTimeParts {}

function parseDateParts(value: string): CalendarDateParts | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return {
    year: Number.parseInt(match[1], 10),
    month: Number.parseInt(match[2], 10),
    day: Number.parseInt(match[3], 10),
  };
}

function parseDateTimeParts(value: string): CalendarDateTimeParts | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return {
    year: Number.parseInt(match[1], 10),
    month: Number.parseInt(match[2], 10),
    day: Number.parseInt(match[3], 10),
    hour: Number.parseInt(match[4], 10),
    minute: Number.parseInt(match[5], 10),
    second: Number.parseInt(match[6] ?? '0', 10),
  };
}

function sameDateParts(a: CalendarDateParts, b: CalendarDateParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function formatCalendarDateParts(parts: CalendarDateParts): string {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatCalendarTimeParts(parts: CalendarTimeParts): string {
  return new Date(Date.UTC(2000, 0, 1, parts.hour, parts.minute, parts.second, 0)).toLocaleTimeString(undefined, {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDateTime(timestamp: number): string {
  return `${formatDate(timestamp)} at ${formatTime(timestamp)}`;
}

function formatTimeRange(startAt: number | null, endAt: number | null): string | null {
  if (startAt == null) return null;
  if (endAt == null || endAt <= startAt) {
    return `on ${formatDate(startAt)} at ${formatTime(startAt)}`;
  }
  const startDate = formatDate(startAt);
  const endDate = formatDate(endAt);
  if (startDate === endDate) {
    return `on ${startDate} from ${formatTime(startAt)} to ${formatTime(endAt)}`;
  }
  return `from ${formatDateTime(startAt)} to ${formatDateTime(endAt)}`;
}

function formatProviderCalendarRange(
  startRecord: Record<string, unknown> | null,
  endRecord: Record<string, unknown> | null,
): string | null {
  const startDateTime = parseDateTimeParts(startRecord ? asString(startRecord.dateTime) : '');
  const endDateTime = parseDateTimeParts(endRecord ? asString(endRecord.dateTime) : '');
  const timeZone = (startRecord ? asString(startRecord.timeZone) : '')
    || (endRecord ? asString(endRecord.timeZone) : '');
  const zoneSuffix = timeZone ? ` (${timeZone})` : '';

  if (startDateTime) {
    const startDateLabel = formatCalendarDateParts(startDateTime);
    const startTimeLabel = formatCalendarTimeParts(startDateTime);
    if (!endDateTime) {
      return `on ${startDateLabel} at ${startTimeLabel}${zoneSuffix}`;
    }
    const endTimeLabel = formatCalendarTimeParts(endDateTime);
    if (sameDateParts(startDateTime, endDateTime)) {
      return `on ${startDateLabel} from ${startTimeLabel} to ${endTimeLabel}${zoneSuffix}`;
    }
    return `from ${startDateLabel} at ${startTimeLabel} to ${formatCalendarDateParts(endDateTime)} at ${endTimeLabel}${zoneSuffix}`;
  }

  const startDate = parseDateParts(startRecord ? asString(startRecord.date) : '');
  const endDate = parseDateParts(endRecord ? asString(endRecord.date) : '');
  if (!startDate) return null;
  const startDateLabel = formatCalendarDateParts(startDate);
  if (!endDate || sameDateParts(startDate, endDate)) {
    return `on ${startDateLabel}${zoneSuffix}`;
  }
  return `from ${startDateLabel} to ${formatCalendarDateParts(endDate)}${zoneSuffix}`;
}

function formatMaybeTimestamp(key: string, value: unknown): string | null {
  const numeric = finiteNumber(value);
  if (numeric == null || numeric < 1_000_000_000_000) return null;
  const lowerKey = key.toLowerCase();
  if (!/(?:^|_)(?:startsat|endsat|dueat|lastcontactat|createdat|updatedat|fromtime|totime)$/.test(lowerKey.replace(/[^a-z]/g, ''))) {
    return null;
  }
  return formatDateTime(numeric);
}

function summarizeGenericPreview(preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;
  const preferredKeys = [
    'action',
    'method',
    'title',
    'name',
    'subject',
    'task',
    'provider',
    'backend',
    'path',
    'source',
    'destination',
    'url',
    'location',
    'startsAt',
    'endsAt',
    'dueAt',
    'lastContactAt',
    'id',
  ];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const key of preferredKeys) {
    if (!(key in parsed) || seen.has(key)) continue;
    const value = parsed[key];
    const timestamp = formatMaybeTimestamp(key, value);
    if (timestamp) {
      parts.push(`${humanizeToolName(key)} ${timestamp}`);
      seen.add(key);
      continue;
    }
    if (typeof value === 'string' && value.trim()) {
      parts.push(`${humanizeToolName(key)} ${value.trim()}`);
      seen.add(key);
      continue;
    }
    if (typeof value === 'boolean') {
      parts.push(`${humanizeToolName(key)} ${value ? 'yes' : 'no'}`);
      seen.add(key);
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      parts.push(`${humanizeToolName(key)} ${String(value)}`);
      seen.add(key);
      continue;
    }
  }
  return parts.length > 0 ? parts.slice(0, 4).join(', ') : null;
}

function describeCodingBackendRun(preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;
  const backend = asString(parsed.backend);
  const task = asString(parsed.task);
  const backendLabel = backend
    ? titleCaseWords(backend.replace(/-/g, ' '))
    : 'coding backend';
  if (task) {
    return `run ${backendLabel} task ${quote(task)}`;
  }
  return `run ${backendLabel}`;
}

function describeSecondBrainCalendarAction(toolName: string, preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;
  const title = asString(parsed.title);
  const location = asString(parsed.location);
  const when = formatTimeRange(finiteNumber(parsed.startsAt), finiteNumber(parsed.endsAt));
  if (toolName === 'second_brain_calendar_delete') {
    return title
      ? `delete local calendar event ${quote(title)}`
      : 'delete local calendar event';
  }
  const parts = [
    asString(parsed.id) ? 'update local calendar event' : 'create local calendar event',
    title ? quote(title) : '',
    when ?? '',
    location ? `at ${location}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function describeSecondBrainTaskAction(toolName: string, preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;
  const title = asString(parsed.title);
  const dueAt = finiteNumber(parsed.dueAt);
  if (toolName === 'second_brain_task_delete') {
    return title ? `delete local task ${quote(title)}` : 'delete local task';
  }
  const parts = [
    asString(parsed.id) ? 'update local task' : 'create local task',
    title ? quote(title) : '',
    dueAt != null ? `due ${formatDateTime(dueAt)}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function describeSecondBrainNoteAction(toolName: string, preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;
  const title = asString(parsed.title);
  if (toolName === 'second_brain_note_delete') {
    return title ? `delete local note ${quote(title)}` : 'delete local note';
  }
  return title
    ? `${asString(parsed.id) ? 'update' : 'save'} local note ${quote(title)}`
    : `${asString(parsed.id) ? 'update' : 'save'} local note`;
}

function describeSecondBrainPersonAction(toolName: string, preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;
  const name = asString(parsed.name);
  const lastContactAt = finiteNumber(parsed.lastContactAt);
  if (toolName === 'second_brain_person_delete') {
    return name ? `delete local person ${quote(name)}` : 'delete local person';
  }
  const parts = [
    asString(parsed.id) ? 'update local person' : 'save local person',
    name ? quote(name) : '',
    lastContactAt != null ? `last contacted ${formatDateTime(lastContactAt)}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function describeSecondBrainLibraryAction(toolName: string, preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;
  const title = asString(parsed.title) || asString(parsed.url);
  if (toolName === 'second_brain_library_delete') {
    return title ? `delete local library item ${quote(title)}` : 'delete local library item';
  }
  return title
    ? `${asString(parsed.id) ? 'update' : 'save'} local library item ${quote(title)}`
    : `${asString(parsed.id) ? 'update' : 'save'} local library item`;
}

function describeSecondBrainBriefAction(toolName: string, preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;
  const title = asString(parsed.title);
  switch (toolName) {
    case 'second_brain_brief_upsert':
      return title
        ? `${asString(parsed.id) ? 'update' : 'save'} brief ${quote(title)}`
        : `${asString(parsed.id) ? 'update' : 'save'} brief`;
    case 'second_brain_generate_brief':
      return title ? `generate brief ${quote(title)}` : 'generate brief';
    case 'second_brain_brief_update':
      return title ? `update brief ${quote(title)}` : 'update brief';
    case 'second_brain_brief_delete':
      return title ? `delete brief ${quote(title)}` : 'delete brief';
    default:
      return null;
  }
}

function describeSecondBrainRoutineAction(toolName: string, preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;
  const name = asString(parsed.name) || asString(parsed.templateId) || asString(parsed.id);
  switch (toolName) {
    case 'second_brain_routine_create':
      return name ? `create Second Brain routine ${quote(name)}` : 'create Second Brain routine';
    case 'second_brain_routine_update':
      return name ? `update Second Brain routine ${quote(name)}` : 'update Second Brain routine';
    case 'second_brain_routine_delete':
      return name ? `delete Second Brain routine ${quote(name)}` : 'delete Second Brain routine';
    default:
      return null;
  }
}

function describeProviderEventAction(providerLabel: string, preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;
  const method = asString(parsed.method).toLowerCase();
  const service = asString(parsed.service).toLowerCase();
  const resource = asString(parsed.resource).toLowerCase();
  const body = isRecord(parsed.json) ? parsed.json : parsed;
  const title = asString(body.title)
    || asString(body.summary)
    || asString(body.subject)
    || asString(parsed.title)
    || asString(parsed.summary)
    || asString(parsed.subject);
  const location = isRecord(body.location)
    ? asString(body.location.displayName) || asString(body.location.name)
    : asString(body.location) || asString(parsed.location);
  const when = (
    (isRecord(body.start) || isRecord(body.end))
      ? formatProviderCalendarRange(
        isRecord(body.start) ? body.start : null,
        isRecord(body.end) ? body.end : null,
      )
      : null
  ) ?? formatTimeRange(finiteNumber(parsed.startsAt), finiteNumber(parsed.endsAt));
  const isCalendarAction = service === 'calendar'
    || resource === 'events'
    || resource.endsWith('/events')
    || resource.includes('calendar');
  if (isCalendarAction && ['create', 'update', 'patch', 'delete'].includes(method)) {
    const verb = method === 'delete'
      ? 'delete'
      : method === 'create'
        ? 'create'
        : 'update';
    const parts = [
      `${verb} ${providerLabel} calendar event`,
      title ? quote(title) : '',
      when ?? '',
      location ? `at ${location}` : '',
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : null;
  }
  const parts = [
    method ? `run ${providerLabel} action ${quote(method)}` : `run ${providerLabel} action`,
    title ? `for ${quote(title)}` : '',
    when ?? '',
    location ? `at ${location}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function describeMailAction(toolName: string, preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) return null;
  const subject = asString(parsed.subject);
  const to = Array.isArray(parsed.to)
    ? parsed.to.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(', ')
    : asString(parsed.to);
  const provider = toolName.startsWith('gmail_')
    ? 'Gmail'
    : toolName.startsWith('outlook_')
      ? 'Outlook'
      : 'email';
  const verb = toolName.endsWith('_draft') ? 'create' : toolName.endsWith('_send') ? 'send' : 'run';
  const parts = [
    `${verb} ${provider} message`,
    subject ? quote(subject) : '',
    to ? `to ${to}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function describePerformanceSelectionMode(value: string): string {
  return value === 'all_selectable' ? 'all selectable targets' : 'default recommended selection';
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

function describePerformanceAction(toolName: string, preview: string): string | null {
  const parsed = tryParsePreview(preview);
  if (!parsed) {
    const normalized = normalizePreview(preview);
    if (!normalized) return null;
    return normalized;
  }

  if (toolName === 'performance_profile_apply') {
    const profileId = asString(parsed.profileId);
    return profileId ? `apply performance profile ${profileId}` : null;
  }

  const actionId = asString(parsed.actionId) || 'cleanup';
  const previewId = asString(parsed.previewId);
  const processCount = Array.isArray(parsed.selectedProcessTargetIds) ? parsed.selectedProcessTargetIds.length : 0;
  const cleanupCount = Array.isArray(parsed.selectedCleanupTargetIds) ? parsed.selectedCleanupTargetIds.length : 0;
  const totalTargets = processCount + cleanupCount;
  const selectionMode = asString(parsed.selectionMode);

  if (previewId) {
    return `run performance action ${actionId} from preview ${previewId}${totalTargets > 0 ? ` on ${totalTargets} selected target(s)` : ''}`;
  }
  return selectionMode
    ? `run performance action ${actionId} using ${describePerformanceSelectionMode(selectionMode)}`
    : `run performance action ${actionId}`;
}

export function describePendingApproval(summary: PendingApprovalSummary): string {
  if (summary.actionLabel?.trim()) return summary.actionLabel.trim();
  const preview = normalizePreview(summary.argsPreview);

  if (summary.toolName === 'coding_backend_run') {
    const codingBackendDescription = describeCodingBackendRun(preview);
    if (codingBackendDescription) return codingBackendDescription;
  }

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

  if (summary.toolName === 'performance_profile_apply' || summary.toolName === 'performance_action_run') {
    const performanceDescription = describePerformanceAction(summary.toolName, preview);
    if (performanceDescription) return performanceDescription;
  }

  if (summary.toolName === 'second_brain_calendar_upsert' || summary.toolName === 'second_brain_calendar_delete') {
    const secondBrainCalendarDescription = describeSecondBrainCalendarAction(summary.toolName, preview);
    if (secondBrainCalendarDescription) return secondBrainCalendarDescription;
  }

  if (summary.toolName === 'second_brain_task_upsert' || summary.toolName === 'second_brain_task_delete') {
    const secondBrainTaskDescription = describeSecondBrainTaskAction(summary.toolName, preview);
    if (secondBrainTaskDescription) return secondBrainTaskDescription;
  }

  if (summary.toolName === 'second_brain_note_upsert' || summary.toolName === 'second_brain_note_delete') {
    const secondBrainNoteDescription = describeSecondBrainNoteAction(summary.toolName, preview);
    if (secondBrainNoteDescription) return secondBrainNoteDescription;
  }

  if (summary.toolName === 'second_brain_person_upsert' || summary.toolName === 'second_brain_person_delete') {
    const secondBrainPersonDescription = describeSecondBrainPersonAction(summary.toolName, preview);
    if (secondBrainPersonDescription) return secondBrainPersonDescription;
  }

  if (summary.toolName === 'second_brain_library_upsert' || summary.toolName === 'second_brain_library_delete') {
    const secondBrainLibraryDescription = describeSecondBrainLibraryAction(summary.toolName, preview);
    if (secondBrainLibraryDescription) return secondBrainLibraryDescription;
  }

  if (
    summary.toolName === 'second_brain_brief_upsert'
    || summary.toolName === 'second_brain_generate_brief'
    || summary.toolName === 'second_brain_brief_update'
    || summary.toolName === 'second_brain_brief_delete'
  ) {
    const secondBrainBriefDescription = describeSecondBrainBriefAction(summary.toolName, preview);
    if (secondBrainBriefDescription) return secondBrainBriefDescription;
  }

  if (
    summary.toolName === 'second_brain_routine_create'
    || summary.toolName === 'second_brain_routine_update'
    || summary.toolName === 'second_brain_routine_delete'
  ) {
    const secondBrainRoutineDescription = describeSecondBrainRoutineAction(summary.toolName, preview);
    if (secondBrainRoutineDescription) return secondBrainRoutineDescription;
  }

  if (summary.toolName === 'gws') {
    const providerEventDescription = describeProviderEventAction('Google Workspace', preview);
    if (providerEventDescription) return providerEventDescription;
  }

  if (summary.toolName === 'm365') {
    const providerEventDescription = describeProviderEventAction('Microsoft 365', preview);
    if (providerEventDescription) return providerEventDescription;
  }

  if (
    summary.toolName === 'gmail_draft'
    || summary.toolName === 'gmail_send'
    || summary.toolName === 'outlook_draft'
    || summary.toolName === 'outlook_send'
  ) {
    const mailDescription = describeMailAction(summary.toolName, preview);
    if (mailDescription) return mailDescription;
  }

  if (preview) {
    const genericPreview = summarizeGenericPreview(preview);
    if (genericPreview) {
      return `run ${humanizeToolName(summary.toolName)} with ${genericPreview}`;
    }
    return `run ${humanizeToolName(summary.toolName)} - ${preview}`;
  }

  return `run ${humanizeToolName(summary.toolName)}`;
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
      actionLabel: describePendingApproval({
        toolName: summary?.toolName ?? 'unknown',
        argsPreview: summary?.argsPreview ?? '',
        ...(summary?.actionLabel ? { actionLabel: summary.actionLabel } : {}),
      }),
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
