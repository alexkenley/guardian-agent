import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditEventType, AuditSeverity } from '../guardian/audit-log.js';
import type { DashboardCallbacks } from './web-types.js';
import { readJsonBody, sendJSON } from './web-json.js';
import { resolveWebSurfaceId } from '../runtime/channel-surface-ids.js';
import { redactWebResponse } from './web-redaction.js';

type PrivilegedTicketAction =
  | 'auth.config'
  | 'auth.rotate'
  | 'auth.reveal'
  | 'connectors.config'
  | 'connectors.pack'
  | 'connectors.playbook'
  | 'guardian.config'
  | 'policy.config'
  | 'tools.policy'
  | 'config.security'
  | 'memory.config'
  | 'performance.manage'
  | 'search.pick-path'
  | 'killswitch'
  | 'factory-reset';

interface WebRuntimeRoutesContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  maxBodyBytes: number;
  dashboard: DashboardCallbacks;
  maybeEmitUIInvalidation: (result: unknown, topics: string[], reason: string, path: string) => void;
  requirePrivilegedTicket: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    action: PrivilegedTicketAction,
    presented?: string,
  ) => boolean;
  getConfigPrivilegedAction: (parsed: Record<string, unknown> | undefined) => PrivilegedTicketAction | undefined;
  logInternalError: (message: string, err: unknown) => void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function trimOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function trimStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => trimOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sendBadRequestError(res: ServerResponse, err: unknown): void {
  sendJSON(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
}

function parseSecondBrainRoutineTrigger(value: unknown): import('../runtime/second-brain/types.js').SecondBrainRoutineTrigger | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const mode = trimOptionalString(record.mode) as import('../runtime/second-brain/types.js').SecondBrainRoutineTrigger['mode'] | undefined;
  if (!mode) return undefined;
  const lookaheadMinutes = typeof record.lookaheadMinutes === 'number'
    ? record.lookaheadMinutes
    : typeof record.lookaheadMinutes === 'string' && record.lookaheadMinutes.trim()
      ? Number(record.lookaheadMinutes)
      : undefined;
  return {
    mode,
    ...(trimOptionalString(record.cron) ? { cron: trimOptionalString(record.cron) } : {}),
    ...(trimOptionalString(record.eventType)
      ? { eventType: trimOptionalString(record.eventType) as import('../runtime/second-brain/types.js').SecondBrainRoutineEventType }
      : {}),
    ...(Number.isFinite(lookaheadMinutes) ? { lookaheadMinutes } : {}),
  };
}

function parseSecondBrainRoutineTiming(value: unknown): import('../runtime/second-brain/types.js').SecondBrainRoutineTimingInput | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const kind = trimOptionalString(record.kind) as import('../runtime/second-brain/types.js').SecondBrainRoutineTimingKind | undefined;
  if (!kind) return undefined;
  const scheduleRecord = asRecord(record.schedule);
  const cadence = trimOptionalString(scheduleRecord?.cadence) as import('../runtime/second-brain/types.js').SecondBrainRoutineSchedule['cadence'] | undefined;
  const time = trimOptionalString(scheduleRecord?.time);
  const dayOfWeek = trimOptionalString(scheduleRecord?.dayOfWeek) as import('../runtime/second-brain/types.js').SecondBrainRoutineWeekday | undefined;
  const dayOfMonth = typeof scheduleRecord?.dayOfMonth === 'number'
    ? scheduleRecord.dayOfMonth
    : typeof scheduleRecord?.dayOfMonth === 'string' && scheduleRecord.dayOfMonth.trim()
      ? Number(scheduleRecord.dayOfMonth)
      : undefined;
  const minute = typeof scheduleRecord?.minute === 'number'
    ? scheduleRecord.minute
    : typeof scheduleRecord?.minute === 'string' && scheduleRecord.minute.trim()
      ? Number(scheduleRecord.minute)
      : undefined;
  const minutes = typeof record.minutes === 'number'
    ? record.minutes
    : typeof record.minutes === 'string' && record.minutes.trim()
      ? Number(record.minutes)
      : undefined;
  return {
    kind,
    ...(cadence && ((cadence === 'hourly' && Number.isFinite(minute)) || time)
      ? {
          schedule: {
            cadence,
            ...(time ? { time } : {}),
            ...(dayOfWeek ? { dayOfWeek } : {}),
            ...(Number.isFinite(dayOfMonth) ? { dayOfMonth } : {}),
            ...(Number.isFinite(minute) ? { minute } : {}),
          },
        }
      : {}),
    ...(Number.isFinite(minutes) ? { minutes } : {}),
  };
}

function parseSecondBrainRoutineConfig(value: unknown): import('../runtime/second-brain/types.js').SecondBrainRoutineConfig | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const focusQuery = trimOptionalString(record.focusQuery);
  const topicQuery = trimOptionalString(record.topicQuery);
  const dueWithinHours = typeof record.dueWithinHours === 'number'
    ? record.dueWithinHours
    : typeof record.dueWithinHours === 'string' && record.dueWithinHours.trim()
      ? Number(record.dueWithinHours)
      : undefined;
  const includeOverdue = typeof record.includeOverdue === 'boolean'
    ? record.includeOverdue
    : undefined;
  if (!focusQuery && !topicQuery && !Number.isFinite(dueWithinHours) && includeOverdue == null) return undefined;
  return {
    ...(focusQuery ? { focusQuery } : {}),
    ...(topicQuery ? { topicQuery } : {}),
    ...(Number.isFinite(dueWithinHours) ? { dueWithinHours } : {}),
    ...(includeOverdue != null ? { includeOverdue } : {}),
  };
}

export async function handleWebRuntimeRoutes(context: WebRuntimeRoutesContext): Promise<boolean> {
  const { req, res, url, dashboard } = context;

  if (req.method === 'GET' && url.pathname === '/api/agents') {
    if (!dashboard.onAgents) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onAgents());
    return true;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/agents/')) {
    if (!dashboard.onAgentDetail) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const id = url.pathname.slice('/api/agents/'.length);
    if (!id) {
      sendJSON(res, 400, { error: 'Agent ID required' });
      return true;
    }
    const detail = dashboard.onAgentDetail(id);
    if (!detail) {
      sendJSON(res, 404, { error: `Agent '${id}' not found` });
      return true;
    }
    sendJSON(res, 200, detail);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/audit/verify') {
    if (!dashboard.onAuditVerifyChain) {
      sendJSON(res, 404, { error: 'Audit persistence not available' });
      return true;
    }
    try {
      const result = await dashboard.onAuditVerifyChain();
      sendJSON(res, 200, result);
    } catch (err) {
      context.logInternalError('Audit verification failed', err);
      sendJSON(res, 500, { error: 'Audit verification failed' });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/audit/summary') {
    if (!dashboard.onAuditSummary) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const windowMs = parseInt(url.searchParams.get('windowMs') ?? '300000', 10);
    sendJSON(res, 200, dashboard.onAuditSummary(windowMs));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/audit') {
    if (!dashboard.onAuditQuery) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const filter: Record<string, unknown> = {};
    const type = url.searchParams.get('type');
    if (type) filter.type = type as AuditEventType;
    const agentId = url.searchParams.get('agentId');
    if (agentId) filter.agentId = agentId;
    const severity = url.searchParams.get('severity');
    if (severity) filter.severity = severity as AuditSeverity;
    const limit = url.searchParams.get('limit');
    if (limit) filter.limit = parseInt(limit, 10);
    const after = url.searchParams.get('after');
    if (after) filter.after = parseInt(after, 10);
    const before = url.searchParams.get('before');
    if (before) filter.before = parseInt(before, 10);

    sendJSON(res, 200, redactWebResponse(dashboard.onAuditQuery(filter)));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    if (!dashboard.onConfig) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onConfig());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/reference') {
    if (!dashboard.onReferenceGuide) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onReferenceGuide());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/memory') {
    if (!dashboard.onMemoryView) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const includeInactive = url.searchParams.get('includeInactive');
    const includeCodeSessions = url.searchParams.get('includeCodeSessions');
    const limit = url.searchParams.get('limit');
    sendJSON(res, 200, dashboard.onMemoryView({
      includeInactive: includeInactive == null ? undefined : includeInactive === 'true',
      includeCodeSessions: includeCodeSessions == null ? undefined : includeCodeSessions === 'true',
      codeSessionId: trimOptionalString(url.searchParams.get('codeSessionId')),
      query: trimOptionalString(url.searchParams.get('query')),
      sourceType: trimOptionalString(url.searchParams.get('sourceType')) as import('../runtime/agent-memory-store.js').MemorySourceType | undefined,
      trustLevel: trimOptionalString(url.searchParams.get('trustLevel')) as import('../runtime/agent-memory-store.js').MemoryTrustLevel | undefined,
      status: trimOptionalString(url.searchParams.get('status')) as import('../runtime/agent-memory-store.js').MemoryStatus | undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    }));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/second-brain/overview') {
    if (!dashboard.onSecondBrainOverview) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onSecondBrainOverview());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/sync') {
    if (!dashboard.onSecondBrainSyncNow) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const result = await dashboard.onSecondBrainSyncNow();
      sendJSON(res, result?.statusCode ?? (result?.success ? 200 : 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.sync.ran', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/briefs/generate') {
    if (!dashboard.onSecondBrainGenerateBrief) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const brief = await dashboard.onSecondBrainGenerateBrief({
        kind: trimOptionalString(parsed.kind) as import('../runtime/second-brain/types.js').SecondBrainGenerateBriefInput['kind'],
        eventId: trimOptionalString(parsed.eventId),
        routineId: trimOptionalString(parsed.routineId),
      });
      sendJSON(res, 200, brief);
      context.maybeEmitUIInvalidation(brief, ['second-brain'], 'second-brain.brief.generated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/briefs/delete') {
    if (!dashboard.onSecondBrainBriefDelete) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const id = trimOptionalString(parsed.id);
      if (!id) {
        sendJSON(res, 400, { error: 'id is required' });
        return true;
      }
      const result = await dashboard.onSecondBrainBriefDelete(id);
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.brief.deleted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/briefs/update') {
    if (!dashboard.onSecondBrainBriefUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const id = trimOptionalString(parsed.id);
      if (!id) {
        sendJSON(res, 400, { error: 'id is required' });
        return true;
      }
      const result = await dashboard.onSecondBrainBriefUpdate({
        id,
        ...(hasOwn(parsed, 'title') && typeof parsed.title === 'string'
          ? { title: parsed.title }
          : {}),
        ...(hasOwn(parsed, 'content') && typeof parsed.content === 'string'
          ? { content: parsed.content }
          : {}),
      });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.brief.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/second-brain/briefs') {
    if (!dashboard.onSecondBrainBriefs) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = url.searchParams.get('limit');
    const kind = trimOptionalString(url.searchParams.get('kind'));
    const eventId = trimOptionalString(url.searchParams.get('eventId'));
    sendJSON(res, 200, dashboard.onSecondBrainBriefs({
      ...(kind ? { kind: kind as import('../runtime/second-brain/types.js').SecondBrainBriefFilter['kind'] } : {}),
      ...(eventId ? { eventId } : {}),
      ...(limit ? { limit: parseInt(limit, 10) } : {}),
    }));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/second-brain/calendar') {
    if (!dashboard.onSecondBrainCalendar) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = url.searchParams.get('limit');
    const fromTime = url.searchParams.get('fromTime');
    const toTime = url.searchParams.get('toTime');
    const includePast = url.searchParams.get('includePast');
    sendJSON(res, 200, dashboard.onSecondBrainCalendar({
      ...(limit ? { limit: parseInt(limit, 10) } : {}),
      ...(fromTime ? { fromTime: parseInt(fromTime, 10) } : {}),
      ...(toTime ? { toTime: parseInt(toTime, 10) } : {}),
      ...(includePast == null ? {} : { includePast: includePast === 'true' }),
    }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/calendar/upsert') {
    if (!dashboard.onSecondBrainCalendarUpsert) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const result = await dashboard.onSecondBrainCalendarUpsert({
        id: trimOptionalString(parsed.id),
        title: trimOptionalString(parsed.title) ?? '',
        ...(hasOwn(parsed, 'description') && typeof parsed.description === 'string'
          ? { description: parsed.description }
          : {}),
        startsAt: typeof parsed.startsAt === 'number' ? parsed.startsAt : Number.NaN,
        endsAt: typeof parsed.endsAt === 'number' ? parsed.endsAt : undefined,
        ...(hasOwn(parsed, 'location') && typeof parsed.location === 'string'
          ? { location: parsed.location }
          : {}),
      });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.calendar.upserted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/calendar/delete') {
    if (!dashboard.onSecondBrainCalendarDelete) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const id = trimOptionalString(parsed.id);
      if (!id) {
        sendJSON(res, 400, { error: 'id is required' });
        return true;
      }
      const result = await dashboard.onSecondBrainCalendarDelete(id);
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.calendar.deleted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/second-brain/tasks') {
    if (!dashboard.onSecondBrainTasks) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = url.searchParams.get('limit');
    const status = trimOptionalString(url.searchParams.get('status'));
    sendJSON(res, 200, dashboard.onSecondBrainTasks({
      ...(status ? { status: status as import('../runtime/second-brain/types.js').SecondBrainTaskFilter['status'] } : {}),
      ...(limit ? { limit: parseInt(limit, 10) } : {}),
    }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/tasks/upsert') {
    if (!dashboard.onSecondBrainTaskUpsert) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const result = await dashboard.onSecondBrainTaskUpsert({
        id: trimOptionalString(parsed.id),
        title: trimOptionalString(parsed.title) ?? '',
        details: trimOptionalString(parsed.details),
        status: trimOptionalString(parsed.status) as import('../runtime/second-brain/types.js').SecondBrainTaskStatus | undefined,
        priority: trimOptionalString(parsed.priority) as import('../runtime/second-brain/types.js').SecondBrainTaskPriority | undefined,
        dueAt: typeof parsed.dueAt === 'number' ? parsed.dueAt : undefined,
      });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.task.upserted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/tasks/delete') {
    if (!dashboard.onSecondBrainTaskDelete) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const id = trimOptionalString(parsed.id);
      if (!id) {
        sendJSON(res, 400, { error: 'id is required' });
        return true;
      }
      const result = await dashboard.onSecondBrainTaskDelete(id);
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.task.deleted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/second-brain/notes') {
    if (!dashboard.onSecondBrainNotes) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = url.searchParams.get('limit');
    const includeArchived = url.searchParams.get('includeArchived');
    sendJSON(res, 200, dashboard.onSecondBrainNotes({
      includeArchived: includeArchived == null ? undefined : includeArchived === 'true',
      ...(limit ? { limit: parseInt(limit, 10) } : {}),
    }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/notes/upsert') {
    if (!dashboard.onSecondBrainNoteUpsert) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const result = await dashboard.onSecondBrainNoteUpsert({
        id: trimOptionalString(parsed.id),
        title: trimOptionalString(parsed.title),
        content: trimOptionalString(parsed.content) ?? '',
        tags: Array.isArray(parsed.tags)
          ? parsed.tags.map((value) => trimOptionalString(value)).filter((value): value is string => Boolean(value))
          : undefined,
        pinned: typeof parsed.pinned === 'boolean' ? parsed.pinned : undefined,
        archived: typeof parsed.archived === 'boolean' ? parsed.archived : undefined,
      });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.note.upserted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/notes/delete') {
    if (!dashboard.onSecondBrainNoteDelete) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const id = trimOptionalString(parsed.id);
      if (!id) {
        sendJSON(res, 400, { error: 'id is required' });
        return true;
      }
      const result = await dashboard.onSecondBrainNoteDelete(id);
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.note.deleted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/second-brain/people') {
    if (!dashboard.onSecondBrainPeople) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = url.searchParams.get('limit');
    sendJSON(res, 200, dashboard.onSecondBrainPeople({
      query: trimOptionalString(url.searchParams.get('query')),
      ...(limit ? { limit: parseInt(limit, 10) } : {}),
    }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/people/upsert') {
    if (!dashboard.onSecondBrainPersonUpsert) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const result = await dashboard.onSecondBrainPersonUpsert({
        id: trimOptionalString(parsed.id),
        name: trimOptionalString(parsed.name),
        email: trimOptionalString(parsed.email),
        phone: trimOptionalString(parsed.phone),
        title: trimOptionalString(parsed.title),
        company: trimOptionalString(parsed.company),
        location: trimOptionalString(parsed.location),
        notes: trimOptionalString(parsed.notes),
        relationship: trimOptionalString(parsed.relationship) as import('../runtime/second-brain/types.js').SecondBrainPersonRelationship | undefined,
        lastContactAt: typeof parsed.lastContactAt === 'number' ? parsed.lastContactAt : undefined,
      });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.person.upserted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/people/delete') {
    if (!dashboard.onSecondBrainPersonDelete) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const id = trimOptionalString(parsed.id);
      if (!id) {
        sendJSON(res, 400, { error: 'id is required' });
        return true;
      }
      const result = await dashboard.onSecondBrainPersonDelete(id);
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.person.deleted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/second-brain/links') {
    if (!dashboard.onSecondBrainLinks) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = url.searchParams.get('limit');
    sendJSON(res, 200, dashboard.onSecondBrainLinks({
      query: trimOptionalString(url.searchParams.get('query')),
      kind: trimOptionalString(url.searchParams.get('kind')) as import('../runtime/second-brain/types.js').SecondBrainLinkFilter['kind'] | undefined,
      ...(limit ? { limit: parseInt(limit, 10) } : {}),
    }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/links/upsert') {
    if (!dashboard.onSecondBrainLinkUpsert) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const result = await dashboard.onSecondBrainLinkUpsert({
        id: trimOptionalString(parsed.id),
        title: trimOptionalString(parsed.title),
        url: trimOptionalString(parsed.url) ?? '',
        summary: trimOptionalString(parsed.summary),
        tags: Array.isArray(parsed.tags)
          ? parsed.tags.map((value) => trimOptionalString(value)).filter((value): value is string => Boolean(value))
          : undefined,
        kind: trimOptionalString(parsed.kind) as import('../runtime/second-brain/types.js').SecondBrainLinkKind | undefined,
      });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.link.upserted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/links/delete') {
    if (!dashboard.onSecondBrainLinkDelete) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const id = trimOptionalString(parsed.id);
      if (!id) {
        sendJSON(res, 400, { error: 'id is required' });
        return true;
      }
      const result = await dashboard.onSecondBrainLinkDelete(id);
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.link.deleted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/second-brain/routines') {
    if (!dashboard.onSecondBrainRoutines) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onSecondBrainRoutines());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/second-brain/routines/catalog') {
    if (!dashboard.onSecondBrainRoutineCatalog) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onSecondBrainRoutineCatalog());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/routines/create') {
    if (!dashboard.onSecondBrainRoutineCreate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const result = await dashboard.onSecondBrainRoutineCreate({
        templateId: trimOptionalString(parsed.templateId) ?? '',
        name: trimOptionalString(parsed.name),
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : undefined,
        timing: parseSecondBrainRoutineTiming(parsed.timing),
        trigger: parseSecondBrainRoutineTrigger(parsed.trigger),
        config: parseSecondBrainRoutineConfig(parsed.config),
        delivery: Array.isArray(parsed.delivery)
          ? parsed.delivery
            .map((value) => trimOptionalString(value))
            .filter((value): value is import('../runtime/second-brain/types.js').SecondBrainDeliveryChannel => Boolean(value))
          : undefined,
        deliveryDefaults: Array.isArray(parsed.deliveryDefaults)
          ? parsed.deliveryDefaults
            .map((value) => trimOptionalString(value))
            .filter((value): value is import('../runtime/second-brain/types.js').SecondBrainDeliveryChannel => Boolean(value))
          : undefined,
        defaultRoutingBias: trimOptionalString(parsed.defaultRoutingBias) as import('../runtime/second-brain/types.js').SecondBrainRoutingBias | undefined,
        budgetProfileId: trimOptionalString(parsed.budgetProfileId),
      });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.routine.created', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/routines/update') {
    if (!dashboard.onSecondBrainRoutineUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const result = await dashboard.onSecondBrainRoutineUpdate({
        id: trimOptionalString(parsed.id) ?? '',
        name: trimOptionalString(parsed.name),
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : undefined,
        timing: parseSecondBrainRoutineTiming(parsed.timing),
        trigger: parseSecondBrainRoutineTrigger(parsed.trigger),
        config: parseSecondBrainRoutineConfig(parsed.config),
        delivery: Array.isArray(parsed.delivery)
          ? parsed.delivery
            .map((value) => trimOptionalString(value))
            .filter((value): value is import('../runtime/second-brain/types.js').SecondBrainDeliveryChannel => Boolean(value))
          : undefined,
        deliveryDefaults: Array.isArray(parsed.deliveryDefaults)
          ? parsed.deliveryDefaults
            .map((value) => trimOptionalString(value))
            .filter((value): value is import('../runtime/second-brain/types.js').SecondBrainDeliveryChannel => Boolean(value))
          : undefined,
        defaultRoutingBias: trimOptionalString(parsed.defaultRoutingBias) as import('../runtime/second-brain/types.js').SecondBrainRoutingBias | undefined,
        budgetProfileId: trimOptionalString(parsed.budgetProfileId),
      });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.routine.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/second-brain/routines/delete') {
    if (!dashboard.onSecondBrainRoutineDelete) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const id = trimOptionalString(parsed.id);
      if (!id) {
        sendJSON(res, 400, { error: 'id is required' });
        return true;
      }
      const result = await dashboard.onSecondBrainRoutineDelete(id);
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['second-brain'], 'second-brain.routine.deleted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/second-brain/usage') {
    if (!dashboard.onSecondBrainUsage) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onSecondBrainUsage());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/performance/status') {
    if (!dashboard.onPerformanceStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const status = await dashboard.onPerformanceStatus();
      sendJSON(res, 200, status);
    } catch (err) {
      context.logInternalError('Performance status failed', err);
      sendJSON(res, 500, { error: 'Performance status failed' });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/performance/processes') {
    if (!dashboard.onPerformanceProcesses) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const processes = await dashboard.onPerformanceProcesses();
      sendJSON(res, 200, { processes });
    } catch (err) {
      context.logInternalError('Performance process listing failed', err);
      sendJSON(res, 500, { error: 'Performance process listing failed' });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/performance/profile/apply') {
    if (!dashboard.onPerformanceApplyProfile) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const bodyTicket = trimOptionalString(parsed.ticket);
      if (!context.requirePrivilegedTicket(req, res, url, 'performance.manage', bodyTicket)) {
        return true;
      }
      const profileId = trimOptionalString(parsed.profileId);
      if (!profileId) {
        sendJSON(res, 400, { error: 'profileId is required' });
        return true;
      }
      const result = await dashboard.onPerformanceApplyProfile(profileId);
      sendJSON(res, result.success ? 200 : 400, result);
      context.maybeEmitUIInvalidation(result, ['performance'], 'performance.profile.applied', url.pathname);
    } catch (err) {
      sendBadRequestError(res, err);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/performance/action/preview') {
    if (!dashboard.onPerformancePreviewAction) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const actionId = trimOptionalString(parsed.actionId);
      if (!actionId) {
        sendJSON(res, 400, { error: 'actionId is required' });
        return true;
      }
      const result = await dashboard.onPerformancePreviewAction(actionId);
      sendJSON(res, 200, result);
    } catch (err) {
      sendBadRequestError(res, err);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/performance/action/run') {
    if (!dashboard.onPerformanceRunAction) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const bodyTicket = trimOptionalString(parsed.ticket);
      if (!context.requirePrivilegedTicket(req, res, url, 'performance.manage', bodyTicket)) {
        return true;
      }
      const previewId = trimOptionalString(parsed.previewId);
      if (!previewId) {
        sendJSON(res, 400, { error: 'previewId is required' });
        return true;
      }
      const result = await dashboard.onPerformanceRunAction({
        previewId,
        selectedProcessTargetIds: trimStringArray(parsed.selectedProcessTargetIds),
        selectedCleanupTargetIds: trimStringArray(parsed.selectedCleanupTargetIds),
      });
      sendJSON(res, result.success ? 200 : 400, result);
      context.maybeEmitUIInvalidation(result, ['performance'], 'performance.action.run', url.pathname);
    } catch (err) {
      sendBadRequestError(res, err);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/memory/curate') {
    if (!dashboard.onMemoryCurate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const result = await dashboard.onMemoryCurate({
        action: trimOptionalString(parsed.action) as 'create' | 'update' | 'archive',
        scope: trimOptionalString(parsed.scope) as 'global' | 'code_session',
        codeSessionId: trimOptionalString(parsed.codeSessionId),
        entryId: trimOptionalString(parsed.entryId),
        title: trimOptionalString(parsed.title),
        content: trimOptionalString(parsed.content),
        summary: trimOptionalString(parsed.summary),
        tags: Array.isArray(parsed.tags)
          ? parsed.tags.map((value) => trimOptionalString(value)).filter((value): value is string => Boolean(value))
          : undefined,
        reason: trimOptionalString(parsed.reason),
        actor: trimOptionalString(parsed.actor),
      });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['memory'], 'memory.curated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/memory/maintenance') {
    if (!dashboard.onMemoryMaintenance) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const result = await dashboard.onMemoryMaintenance({
        scope: trimOptionalString(parsed.scope) as 'global' | 'code_session',
        codeSessionId: trimOptionalString(parsed.codeSessionId),
        maintenanceType: trimOptionalString(parsed.maintenanceType) as 'consolidation' | 'idle_sweep' | undefined,
        actor: trimOptionalString(parsed.actor),
      });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['memory'], 'memory.maintenance', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/setup/status') {
    if (!dashboard.onSetupStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onSetupStatus());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/quick-actions') {
    if (!dashboard.onQuickActions) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onQuickActions());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/pending-action') {
    if (!dashboard.onPendingActionCurrent) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const userId = url.searchParams.get('userId') ?? 'web-user';
    const channel = url.searchParams.get('channel') ?? 'web';
    const surfaceId = resolveWebSurfaceId(url.searchParams.get('surfaceId') ?? undefined);
    sendJSON(res, 200, dashboard.onPendingActionCurrent({ userId, channel, surfaceId }));
    return true;
  }


  if (req.method === 'POST' && url.pathname === '/api/config') {
    if (!dashboard.onConfigUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const parsedRecord = asRecord(parsed);
      const bodyTicket = trimOptionalString(parsedRecord?.ticket);
      if (parsedRecord && hasOwn(parsedRecord, 'ticket')) {
        delete parsedRecord.ticket;
      }
      const privilegedAction = context.getConfigPrivilegedAction(parsedRecord);
      if (privilegedAction && !context.requirePrivilegedTicket(req, res, url, privilegedAction, bodyTicket)) {
        return true;
      }
      try {
        const result = await dashboard.onConfigUpdate(parsed as Record<string, unknown>);
        sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
        context.maybeEmitUIInvalidation(result, ['config', 'providers', 'tools', 'automations', 'network'], 'config.updated', url.pathname);
      } catch (err) {
        context.logInternalError('Config update failed', err);
        sendJSON(res, 500, { error: 'Update failed' });
      }
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/telegram/test') {
    if (!dashboard.onTelegramReload) {
      sendJSON(res, 404, { error: 'Telegram reload not available' });
      return true;
    }
    try {
      const result = await dashboard.onTelegramReload();
      sendJSON(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Telegram test failed';
      sendJSON(res, 500, { success: false, message });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/test') {
    if (!dashboard.onCloudTest) {
      sendJSON(res, 404, { error: 'Cloud test not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ provider?: string; profileId?: string }>(req, context.maxBodyBytes);
      if (!parsed.provider || !parsed.profileId) {
        sendJSON(res, 400, { error: 'provider and profileId are required' });
        return true;
      }
      try {
        const result = await dashboard.onCloudTest(parsed.provider, parsed.profileId);
        sendJSON(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Cloud test failed';
        sendJSON(res, 500, { success: false, message });
      }
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/setup/apply') {
    if (!dashboard.onSetupApply) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Parameters<NonNullable<DashboardCallbacks['onSetupApply']>>[0]>(req, context.maxBodyBytes);
      const result = await dashboard.onSetupApply(parsed);
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['config', 'providers'], 'setup.applied', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/config/search') {
    if (!dashboard.onSearchConfigUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Parameters<NonNullable<DashboardCallbacks['onSearchConfigUpdate']>>[0]>(req, context.maxBodyBytes);
      try {
        const result = await dashboard.onSearchConfigUpdate(parsed);
        sendJSON(res, 200, result);
        context.maybeEmitUIInvalidation(result, ['config'], 'search.config.updated', url.pathname);
      } catch (err) {
        context.logInternalError('Search config update failed', err);
        sendJSON(res, 500, { error: 'Update failed' });
      }
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/budget') {
    if (!dashboard.onBudget) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onBudget());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/analytics/summary') {
    if (!dashboard.onAnalyticsSummary) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const windowMs = parseInt(url.searchParams.get('windowMs') ?? '3600000', 10);
    sendJSON(res, 200, dashboard.onAnalyticsSummary(windowMs));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/threat-intel/summary') {
    if (!dashboard.onThreatIntelSummary) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onThreatIntelSummary());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/threat-intel/plan') {
    if (!dashboard.onThreatIntelPlan) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onThreatIntelPlan());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/threat-intel/watchlist') {
    if (!dashboard.onThreatIntelWatchlist) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, { targets: dashboard.onThreatIntelWatchlist() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/threat-intel/watchlist') {
    if (!dashboard.onThreatIntelWatchAdd || !dashboard.onThreatIntelWatchRemove) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ action?: 'add' | 'remove'; target?: string }>(req, context.maxBodyBytes);
      if (!parsed.target?.trim()) {
        sendJSON(res, 400, { error: 'target is required' });
        return true;
      }
      const action = parsed.action ?? 'add';
      if (action !== 'add' && action !== 'remove') {
        sendJSON(res, 400, { error: "action must be 'add' or 'remove'" });
        return true;
      }
      const result = action === 'add'
        ? dashboard.onThreatIntelWatchAdd(parsed.target)
        : dashboard.onThreatIntelWatchRemove(parsed.target);
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.watchlist.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/threat-intel/scan') {
    if (!dashboard.onThreatIntelScan) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ query?: string; includeDarkWeb?: boolean; sources?: string[] }>(req, context.maxBodyBytes);
      const result = await dashboard.onThreatIntelScan({
        query: parsed.query,
        includeDarkWeb: parsed.includeDarkWeb,
        sources: parsed.sources as Parameters<NonNullable<DashboardCallbacks['onThreatIntelScan']>>[0]['sources'],
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.scan.completed', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/threat-intel/findings') {
    if (!dashboard.onThreatIntelFindings) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const status = url.searchParams.get('status') ?? undefined;
    const findings = dashboard.onThreatIntelFindings({
      limit: Number.isFinite(limit) ? limit : 50,
      status: status as Parameters<NonNullable<DashboardCallbacks['onThreatIntelFindings']>>[0]['status'],
    });
    sendJSON(res, 200, findings);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/threat-intel/findings/status') {
    if (!dashboard.onThreatIntelUpdateFindingStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ findingId?: string; status?: string }>(req, context.maxBodyBytes);
      if (!parsed.findingId || !parsed.status) {
        sendJSON(res, 400, { error: 'findingId and status are required' });
        return true;
      }
      const result = dashboard.onThreatIntelUpdateFindingStatus({
        findingId: parsed.findingId,
        status: parsed.status as Parameters<NonNullable<DashboardCallbacks['onThreatIntelUpdateFindingStatus']>>[0]['status'],
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.finding.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/threat-intel/actions') {
    if (!dashboard.onThreatIntelActions) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    sendJSON(res, 200, dashboard.onThreatIntelActions(Number.isFinite(limit) ? limit : 50));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/threat-intel/actions/draft') {
    if (!dashboard.onThreatIntelDraftAction) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ findingId?: string; type?: string }>(req, context.maxBodyBytes);
      if (!parsed.findingId || !parsed.type) {
        sendJSON(res, 400, { error: 'findingId and type are required' });
        return true;
      }
      const result = dashboard.onThreatIntelDraftAction({
        findingId: parsed.findingId,
        type: parsed.type as Parameters<NonNullable<DashboardCallbacks['onThreatIntelDraftAction']>>[0]['type'],
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.action.drafted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/threat-intel/response-mode') {
    if (!dashboard.onThreatIntelSetResponseMode) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ mode?: string }>(req, context.maxBodyBytes);
      if (!parsed.mode) {
        sendJSON(res, 400, { error: 'mode is required' });
        return true;
      }
      const result = dashboard.onThreatIntelSetResponseMode(
        parsed.mode as Parameters<NonNullable<DashboardCallbacks['onThreatIntelSetResponseMode']>>[0],
      );
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.response-mode.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/watchdog') {
    if (!dashboard.onWatchdog) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onWatchdog());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/providers') {
    if (!dashboard.onProviders) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onProviders());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/providers/types') {
    if (!dashboard.onProviderTypes) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onProviderTypes());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/providers/status') {
    if (!dashboard.onProvidersStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onProvidersStatus());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/providers/models') {
    if (!dashboard.onProviderModels) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const providerType = typeof parsed.providerType === 'string' ? parsed.providerType.trim() : '';
      if (!providerType) {
        sendJSON(res, 400, { error: 'providerType is required' });
        return true;
      }
      try {
        const result = await dashboard.onProviderModels({
          providerType,
          model: typeof parsed.model === 'string' ? parsed.model : undefined,
          apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
          credentialRef: typeof parsed.credentialRef === 'string' ? parsed.credentialRef : undefined,
          baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
        });
        sendJSON(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load provider models';
        sendJSON(res, 400, { error: message });
      }
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/assistant/state') {
    if (!dashboard.onAssistantState) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onAssistantState());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/assistant/jobs/follow-up') {
    if (!dashboard.onAssistantJobFollowUpAction) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ jobId?: string; action?: 'replay' | 'keep_held' | 'dismiss' }>(req, context.maxBodyBytes);
      if (!parsed.jobId || typeof parsed.jobId !== 'string') {
        sendJSON(res, 400, { success: false, message: 'Missing jobId' });
        return true;
      }
      if (parsed.action !== 'replay' && parsed.action !== 'keep_held' && parsed.action !== 'dismiss') {
        sendJSON(res, 400, { success: false, message: 'Invalid follow-up action' });
        return true;
      }
      const result = await dashboard.onAssistantJobFollowUpAction({
        jobId: parsed.jobId,
        action: parsed.action,
      });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['assistant', 'dashboard'], 'assistant.jobs.followup', url.pathname);
      return true;
    } catch (err) {
      sendJSON(res, 400, { success: false, message: err instanceof Error ? err.message : 'Bad request' });
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/assistant/runs') {
    if (!dashboard.onAssistantRuns) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = Number.parseInt(url.searchParams.get('limit') || '20', 10);
    const status = trimOptionalString(url.searchParams.get('status')) as import('../runtime/run-timeline.js').DashboardRunStatus | undefined;
    const kind = trimOptionalString(url.searchParams.get('kind')) as import('../runtime/run-timeline.js').DashboardRunKind | undefined;
    const parentRunId = trimOptionalString(url.searchParams.get('parentRunId'));
    const channel = trimOptionalString(url.searchParams.get('channel'));
    const agentId = trimOptionalString(url.searchParams.get('agentId'));
    const codeSessionId = trimOptionalString(url.searchParams.get('codeSessionId'));
    const continuityKey = trimOptionalString(url.searchParams.get('continuityKey'));
    const activeExecutionRef = trimOptionalString(url.searchParams.get('activeExecutionRef'));
    sendJSON(res, 200, redactWebResponse(dashboard.onAssistantRuns({
      limit: Number.isFinite(limit) ? limit : 20,
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
      ...(parentRunId ? { parentRunId } : {}),
      ...(channel ? { channel } : {}),
      ...(agentId ? { agentId } : {}),
      ...(codeSessionId ? { codeSessionId } : {}),
      ...(continuityKey ? { continuityKey } : {}),
      ...(activeExecutionRef ? { activeExecutionRef } : {}),
    })));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/routing/trace') {
    if (!dashboard.onIntentRoutingTrace) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = Number.parseInt(url.searchParams.get('limit') || '20', 10);
    const continuityKey = trimOptionalString(url.searchParams.get('continuityKey'));
    const activeExecutionRef = trimOptionalString(url.searchParams.get('activeExecutionRef'));
    const executionId = trimOptionalString(url.searchParams.get('executionId'));
    const rootExecutionId = trimOptionalString(url.searchParams.get('rootExecutionId'));
    const taskExecutionId = trimOptionalString(url.searchParams.get('taskExecutionId'));
    const pendingActionId = trimOptionalString(url.searchParams.get('pendingActionId'));
    const codeSessionId = trimOptionalString(url.searchParams.get('codeSessionId'));
    const stage = trimOptionalString(url.searchParams.get('stage'));
    const channel = trimOptionalString(url.searchParams.get('channel'));
    const agentId = trimOptionalString(url.searchParams.get('agentId'));
    const userId = trimOptionalString(url.searchParams.get('userId'));
    const requestId = trimOptionalString(url.searchParams.get('requestId'));
    sendJSON(res, 200, redactWebResponse(await dashboard.onIntentRoutingTrace({
      limit: Number.isFinite(limit) ? limit : 20,
      ...(continuityKey ? { continuityKey } : {}),
      ...(activeExecutionRef ? { activeExecutionRef } : {}),
      ...(executionId ? { executionId } : {}),
      ...(rootExecutionId ? { rootExecutionId } : {}),
      ...(taskExecutionId ? { taskExecutionId } : {}),
      ...(pendingActionId ? { pendingActionId } : {}),
      ...(codeSessionId ? { codeSessionId } : {}),
      ...(stage ? { stage } : {}),
      ...(channel ? { channel } : {}),
      ...(agentId ? { agentId } : {}),
      ...(userId ? { userId } : {}),
      ...(requestId ? { requestId } : {}),
    })));
    return true;
  }

  const assistantRunMatch = req.method === 'GET'
    ? url.pathname.match(/^\/api\/assistant\/runs\/([^/]+)$/)
    : null;
  if (assistantRunMatch) {
    if (!dashboard.onAssistantRunDetail) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const runId = decodeURIComponent(assistantRunMatch[1]);
    const result = dashboard.onAssistantRunDetail(runId);
    if (!result) {
      sendJSON(res, 404, { error: 'Run not found' });
      return true;
    }
    sendJSON(res, 200, redactWebResponse(result));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/routing/mode') {
    if (!dashboard.onRoutingMode) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onRoutingMode());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/routing/mode') {
    if (!dashboard.onRoutingModeUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ mode?: string }>(req, context.maxBodyBytes);
      const valid = ['auto', 'local-only', 'managed-cloud-only', 'frontier-only'];
      if (!parsed.mode || !valid.includes(parsed.mode)) {
        sendJSON(res, 400, { error: `mode must be one of: ${valid.join(', ')}` });
        return true;
      }
      const result = dashboard.onRoutingModeUpdate(parsed.mode as 'auto' | 'local-only' | 'managed-cloud-only' | 'frontier-only');
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['config', 'dashboard'], 'routing.mode.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  return false;
}
