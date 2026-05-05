import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { ContinuityThreadRecord } from '../continuity-threads.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import { INTENT_GATEWAY_MISSING_SUMMARY } from '../intent/summary.js';
import type { DirectIntentDispatchResult } from './direct-intent-dispatch.js';

type DiagnosticsIssueDraftTools = Pick<ToolExecutor, 'executeModelTool' | 'isEnabled'> | null | undefined;
type DiagnosticsIssueSubmitTools = Pick<ToolExecutor, 'executeModelTool' | 'isEnabled'> | null | undefined;
type DiagnosticsTraceInspectTools = Pick<ToolExecutor, 'executeModelTool' | 'isEnabled'> | null | undefined;

export const DIAGNOSTICS_ISSUE_DRAFT_CONTINUATION_KIND = 'diagnostics_issue_draft';

interface DiagnosticsIssueDraftOutput {
  draft?: {
    title?: string;
    body?: string;
    labels?: string[];
    severity?: string;
    privacyNote?: string;
  };
  evidence?: {
    entriesAnalyzed?: number;
    auditEventsAnalyzed?: number;
    requestIds?: string[];
    blockers?: string[];
  };
  nextStep?: string;
}

interface StoredDiagnosticsIssueDraft {
  title: string;
  body: string;
  labels: string[];
  severity?: string;
  requestIds?: string[];
  jobId?: string;
}

interface DiagnosticsTraceInspectOutput {
  traceEnabled?: boolean;
  traceFilePath?: string;
  entriesAnalyzed?: number;
  requestIds?: string[];
  latestRequestId?: string;
  latestUserRequest?: string;
  latestAssistantResponse?: string;
  stages?: Record<string, number>;
  blockers?: string[];
  timeline?: string[];
  summary?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => asString(item).trim()).filter(Boolean)
    : [];
}

function readDraftOutput(value: unknown): DiagnosticsIssueDraftOutput {
  return isRecord(value) ? value as DiagnosticsIssueDraftOutput : {};
}

function readTraceInspectOutput(value: unknown): DiagnosticsTraceInspectOutput {
  return isRecord(value) ? value as DiagnosticsTraceInspectOutput : {};
}

function buildStoredDiagnosticsIssueDraft(
  output: DiagnosticsIssueDraftOutput,
  jobId: unknown,
): StoredDiagnosticsIssueDraft | null {
  const draft = output.draft ?? {};
  const title = draft.title?.trim() || '[Diagnostics] Assistant request needs investigation';
  const body = draft.body?.trim();
  if (!body) return null;
  const labels = Array.isArray(draft.labels) && draft.labels.length > 0
    ? draft.labels.map((label) => label.trim()).filter(Boolean)
    : ['diagnostics', 'user-reported'];
  return {
    title,
    body,
    labels,
    ...(draft.severity?.trim() ? { severity: draft.severity.trim() } : {}),
    ...(Array.isArray(output.evidence?.requestIds)
      ? { requestIds: output.evidence.requestIds.map((id) => id.trim()).filter(Boolean) }
      : {}),
    ...(typeof jobId === 'string' && jobId.trim() ? { jobId: jobId.trim() } : {}),
  };
}

function readStoredDiagnosticsIssueDraft(
  continuityThread: ContinuityThreadRecord | null | undefined,
): StoredDiagnosticsIssueDraft | null {
  const state = continuityThread?.continuationState;
  if (state?.kind !== DIAGNOSTICS_ISSUE_DRAFT_CONTINUATION_KIND) return null;
  const draft = isRecord(state.payload.draft) ? state.payload.draft : null;
  if (!draft) return null;
  const title = asString(draft.title).trim();
  const body = asString(draft.body).trim();
  if (!title || !body) return null;
  const labels = asStringArray(draft.labels);
  return {
    title,
    body,
    labels: labels.length > 0 ? labels : ['diagnostics', 'user-reported'],
    ...(asString(draft.severity).trim() ? { severity: asString(draft.severity).trim() } : {}),
    ...(asStringArray(draft.requestIds).length > 0 ? { requestIds: asStringArray(draft.requestIds) } : {}),
    ...(asString(draft.jobId).trim() ? { jobId: asString(draft.jobId).trim() } : {}),
  };
}

function diagnosticProblemText(decision: IntentGatewayDecision | null | undefined, message: UserMessage): string {
  const summary = decision?.summary?.trim();
  if (summary && summary !== INTENT_GATEWAY_MISSING_SUMMARY) {
    return summary;
  }
  return message.content;
}

function formatDiagnosticsIssueDraft(output: DiagnosticsIssueDraftOutput): string {
  const draft = output.draft ?? {};
  const labels = Array.isArray(draft.labels) && draft.labels.length > 0
    ? draft.labels.join(', ')
    : 'diagnostics, user-reported';
  const requestIds = Array.isArray(output.evidence?.requestIds) && output.evidence.requestIds.length > 0
    ? output.evidence.requestIds.join(', ')
    : '(none captured)';
  const entriesAnalyzed = output.evidence?.entriesAnalyzed ?? 0;
  const auditEventsAnalyzed = output.evidence?.auditEventsAnalyzed ?? 0;
  const body = draft.body?.trim() || 'No issue body was produced.';

  return [
    'Drafted a redacted GuardianAgent issue report. No GitHub issue was created.',
    '',
    `**Title:** ${draft.title?.trim() || '[Diagnostics] Assistant request needs investigation'}`,
    `**Severity:** ${draft.severity?.trim() || 'low'}`,
    `**Labels:** ${labels}`,
    `**Evidence:** ${entriesAnalyzed} routing trace entries, ${auditEventsAnalyzed} audit events`,
    `**Request IDs:** ${requestIds}`,
    '',
    body,
    '',
    draft.privacyNote?.trim()
      || 'Review this draft before approving any external issue creation.',
    'To submit it, ask Guardian to submit this GitHub issue. Guardian will request approval before posting anything externally.',
  ].join('\n');
}

function formatDiagnosticsTraceInspect(output: DiagnosticsTraceInspectOutput): string {
  const requestIds = Array.isArray(output.requestIds) && output.requestIds.length > 0
    ? output.requestIds.join(', ')
    : '(none captured)';
  const blockers = Array.isArray(output.blockers) && output.blockers.length > 0
    ? output.blockers.map((blocker) => `- ${blocker}`).join('\n')
    : '- No blocking trace stages were found in the selected window.';
  const timeline = Array.isArray(output.timeline) && output.timeline.length > 0
    ? output.timeline.slice(-8).map((line) => `- ${line}`).join('\n')
    : '- No timeline entries were available.';

  return [
    output.traceEnabled === false
      ? 'I could not access Guardian routing trace in this runtime.'
      : 'I can read Guardian routing trace.',
    '',
    `**Trace source:** ${output.traceFilePath?.trim() || '(runtime trace store)'}`,
    `**Entries analyzed:** ${output.entriesAnalyzed ?? 0}`,
    `**Request IDs:** ${requestIds}`,
    '',
    `**What the trace shows:** ${output.summary?.trim() || 'No summary was available.'}`,
    '',
    '**Blockers:**',
    blockers,
    '',
    '**Recent timeline:**',
    timeline,
  ].join('\n');
}

export async function tryDirectDiagnosticsTraceInspect(input: {
  agentId: string;
  tools?: DiagnosticsTraceInspectTools;
  message: UserMessage;
  ctx: AgentContext;
  decision?: IntentGatewayDecision | null;
}): Promise<DirectIntentDispatchResult | null> {
  if (!input.tools?.isEnabled()) return null;
  if (input.decision?.route !== 'diagnostics_task') return null;
  if (input.decision.operation !== 'inspect' && input.decision.operation !== 'read' && input.decision.operation !== 'search') {
    return null;
  }

  const requestId = asString((input.decision.entities as Record<string, unknown>).requestId).trim();
  const result = await input.tools.executeModelTool(
    'guardian_trace_inspect',
    {
      ...(requestId ? { requestId } : {}),
      traceLimit: 80,
    },
    {
      origin: 'assistant',
      agentId: input.agentId,
      userId: input.message.userId,
      surfaceId: input.message.surfaceId,
      principalId: input.message.principalId ?? input.message.userId,
      principalRole: input.message.principalRole,
      channel: input.message.channel,
      requestId: input.message.id,
      agentContext: { checkAction: input.ctx.checkAction },
    },
  );

  if (result.success !== true) {
    return {
      content: asString(result.error) || asString(result.message) || 'I could not inspect the routing trace.',
      metadata: {
        diagnosticsTraceInspect: {
          success: false,
          status: result.status,
          jobId: result.jobId,
        },
      },
    };
  }

  const output = readTraceInspectOutput(result.output);
  return {
    content: formatDiagnosticsTraceInspect(output),
    metadata: {
      diagnosticsTraceInspect: {
        success: true,
        jobId: result.jobId,
        entriesAnalyzed: output.entriesAnalyzed,
        requestIds: output.requestIds,
        blockers: output.blockers,
      },
    },
  };
}

export async function tryDirectDiagnosticsIssueDraft(input: {
  agentId: string;
  tools?: DiagnosticsIssueDraftTools;
  message: UserMessage;
  ctx: AgentContext;
  decision?: IntentGatewayDecision | null;
}): Promise<DirectIntentDispatchResult | null> {
  if (!input.tools?.isEnabled()) return null;
  if (input.decision?.route !== 'diagnostics_task') return null;
  const result = await input.tools.executeModelTool(
    'guardian_issue_draft',
    {
      target: 'latest_completed_request',
      problem: diagnosticProblemText(input.decision, input.message),
    },
    {
      origin: 'assistant',
      agentId: input.agentId,
      userId: input.message.userId,
      surfaceId: input.message.surfaceId,
      principalId: input.message.principalId ?? input.message.userId,
      principalRole: input.message.principalRole,
      channel: input.message.channel,
      requestId: input.message.id,
      agentContext: { checkAction: input.ctx.checkAction },
    },
  );

  if (result.success !== true) {
    const failureMessage = asString(result.error)
      || asString(result.message)
      || 'I could not draft the diagnostics report.';
    return {
      content: failureMessage,
      metadata: {
        diagnosticsIssueDraft: {
          success: false,
          status: result.status,
          jobId: result.jobId,
          approvalId: result.approvalId,
        },
      },
    };
  }

  const output = readDraftOutput(result.output);
  const storedDraft = buildStoredDiagnosticsIssueDraft(output, result.jobId);
  return {
    content: formatDiagnosticsIssueDraft(output),
    metadata: {
      diagnosticsIssueDraft: {
        success: true,
        jobId: result.jobId,
        title: output.draft?.title,
        severity: output.draft?.severity,
        labels: output.draft?.labels,
        requestIds: output.evidence?.requestIds,
      },
      ...(storedDraft
        ? {
          continuationState: {
            kind: DIAGNOSTICS_ISSUE_DRAFT_CONTINUATION_KIND,
            payload: {
              draft: storedDraft,
            },
          },
        }
        : {}),
    },
  };
}

export async function tryDirectDiagnosticsIssueSubmit(input: {
  agentId: string;
  tools?: DiagnosticsIssueSubmitTools;
  message: UserMessage;
  ctx: AgentContext;
  decision?: IntentGatewayDecision | null;
  continuityThread?: ContinuityThreadRecord | null;
}): Promise<DirectIntentDispatchResult | null> {
  if (!input.tools?.isEnabled()) return null;
  if (input.decision?.route !== 'diagnostics_task') return null;

  const draft = readStoredDiagnosticsIssueDraft(input.continuityThread);
  if (!draft) {
    return {
      content: [
        'I do not have a reviewed GuardianAgent issue draft ready to submit.',
        'Ask me to draft a GuardianAgent GitHub issue first, then review it and tell me to submit it.',
      ].join('\n'),
      metadata: {
        diagnosticsIssueSubmit: {
          success: false,
          status: 'missing_draft',
        },
      },
    };
  }

  const result = await input.tools.executeModelTool(
    'github_issue_create',
    {
      title: draft.title,
      body: draft.body,
      labels: draft.labels,
    },
    {
      origin: 'assistant',
      agentId: input.agentId,
      userId: input.message.userId,
      surfaceId: input.message.surfaceId,
      principalId: input.message.principalId ?? input.message.userId,
      principalRole: input.message.principalRole,
      channel: input.message.channel,
      requestId: input.message.id,
      agentContext: { checkAction: input.ctx.checkAction },
    },
  );

  if (result.success === true) {
    return {
      content: asString(result.message) || 'Created the GitHub issue from the reviewed diagnostics draft.',
      metadata: {
        diagnosticsIssueSubmit: {
          success: true,
          status: result.status,
          jobId: result.jobId,
          title: draft.title,
          output: result.output,
        },
      },
    };
  }

  const pendingApproval = result.status === 'pending_approval';
  const message = asString(result.message)
    || asString(result.error)
    || (pendingApproval
      ? 'GitHub issue creation is waiting for approval.'
      : 'I could not submit the GitHub issue.');
  return {
    content: message,
    metadata: {
      diagnosticsIssueSubmit: {
        success: false,
        status: result.status,
        jobId: result.jobId,
        approvalId: result.approvalId,
        title: draft.title,
      },
    },
  };
}
