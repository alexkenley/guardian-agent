import type {
  DiagnosticsEvidence,
  DiagnosticsEvidenceDependencies,
  DiagnosticsGuardianEventEvidence,
  DiagnosticsToolCallEvidence,
} from './evidence.js';
import {
  collectDiagnosticsEvidence,
  formatDiagnosticsTraceLine,
  previewDiagnosticsText,
} from './evidence.js';

export type DiagnosticsIssueTarget =
  | 'latest_completed_request'
  | 'current_request'
  | 'recent_window'
  | 'request_id';

export interface DiagnosticsIssueDraftInput {
  target?: DiagnosticsIssueTarget;
  requestId?: string;
  problem?: string;
  channel?: string;
  userId?: string;
  traceLimit?: number;
  auditLimit?: number;
}

export interface DiagnosticsIssueDraftDependencies extends DiagnosticsEvidenceDependencies {}

export interface DiagnosticsIssueDraft {
  title: string;
  body: string;
  labels: string[];
  severity: 'low' | 'medium' | 'high';
  suspectedSubsystems: string[];
  expectedBehavior: string;
  actualBehavior: string;
  privacyNote: string;
}

export interface DiagnosticsIssueDraftResult {
  draft: DiagnosticsIssueDraft;
  evidence: {
    target: DiagnosticsIssueTarget;
    traceEnabled: boolean;
    traceFilePath?: string;
    requestIds: string[];
    entriesAnalyzed: number;
    auditEventsAnalyzed: number;
    stages: Record<string, number>;
    latestUserRequest?: string;
    latestAssistantResponse?: string;
    blockers: string[];
    toolCalls: DiagnosticsToolCallEvidence[];
    guardianEvents: DiagnosticsGuardianEventEvidence[];
  };
  nextStep: string;
}

function inferSuspectedSubsystems(evidence: DiagnosticsEvidence): string[] {
  const stages = new Set(evidence.entries.map((entry) => entry.stage));
  const subsystems = new Set<string>();
  if (stages.has('gateway_classification_failed') || stages.has('clarification_requested')) {
    subsystems.add('intent-gateway');
  }
  if ([...stages].some((stage) => stage.startsWith('delegated_'))) {
    subsystems.add('delegated-orchestration');
  }
  if ([...stages].some((stage) => stage.includes('tool_call'))) {
    subsystems.add('tool-execution');
  }
  if (stages.has('approval_decision_resolved') || stages.has('approval_continuation_resolved')) {
    subsystems.add('approvals-continuity');
  }
  if (evidence.guardianEvents.some((event) => event.type === 'action_denied' || event.type === 'output_blocked')) {
    subsystems.add('guardian-security');
  }
  if (stages.has('dispatch_response')) {
    subsystems.add('channel-response');
  }
  return [...subsystems].slice(0, 6);
}

function inferSeverity(evidence: DiagnosticsEvidence): 'low' | 'medium' | 'high' {
  const stages = new Set(evidence.entries.map((entry) => entry.stage));
  if (
    stages.has('delegated_worker_failed')
    || stages.has('direct_reasoning_failed')
    || evidence.guardianEvents.some((event) => event.severity === 'critical')
  ) {
    return 'high';
  }
  if (evidence.blockers.length > 0 || stages.has('clarification_requested') || stages.has('delegated_job_wait_expired')) {
    return 'medium';
  }
  return 'low';
}

function buildIssueTitle(input: DiagnosticsIssueDraftInput, latestUserRequest?: string, blockers: string[] = []): string {
  const problem = previewDiagnosticsText(input.problem, 90);
  if (problem) return `[Diagnostics] ${problem}`;
  if (blockers.length > 0) return `[Diagnostics] ${previewDiagnosticsText(blockers[0], 90) || 'Assistant request failed or stalled'}`;
  if (latestUserRequest) return `[Diagnostics] Unexpected response for: ${previewDiagnosticsText(latestUserRequest, 70)}`;
  return '[Diagnostics] Assistant request needs investigation';
}

function buildBody(input: {
  draftInput: DiagnosticsIssueDraftInput;
  evidence: DiagnosticsEvidence;
  suspectedSubsystems: string[];
}): string {
  const problem = previewDiagnosticsText(input.draftInput.problem, 500) || '(not supplied)';
  const expected = 'Guardian should preserve user intent across turns, use the correct shared orchestration path, and ask a concrete clarification only when required information is genuinely missing.';
  const actual = input.evidence.blockers.length > 0
    ? input.evidence.blockers.join('; ')
    : (input.evidence.latestAssistantResponse || 'No clear failure summary was available from the selected trace window.');
  const traceLines = input.evidence.entries
    .slice(-20)
    .map((entry) => `- ${formatDiagnosticsTraceLine(entry)}`)
    .join('\n') || '- No routing trace entries were available for the selected target.';
  const toolLines = input.evidence.toolCalls.length > 0
    ? input.evidence.toolCalls.map((call) => `- ${call.toolName} (${call.stage}${call.status ? `, ${call.status}` : ''})`).join('\n')
    : '- No tool calls were observed in the selected trace entries.';
  const guardianLines = input.evidence.guardianEvents.length > 0
    ? input.evidence.guardianEvents.map((event) => `- ${event.type} (${event.severity}${event.controller ? `, ${event.controller}` : ''})${event.reason ? `: ${event.reason}` : ''}`).join('\n')
    : '- No relevant Guardian/audit events were available in the selected audit window.';

  return [
    '## Problem Report',
    '',
    `User-provided problem: ${problem}`,
    '',
    '## Expected Behavior',
    '',
    expected,
    '',
    '## Actual Behavior',
    '',
    actual,
    '',
    '## Reproduction Context',
    '',
    `- Latest user request: ${input.evidence.latestUserRequest ?? '(unknown)'}`,
    `- Latest assistant response: ${input.evidence.latestAssistantResponse ?? '(unknown)'}`,
    `- Request ids: ${input.evidence.requestIds.length > 0 ? input.evidence.requestIds.join(', ') : '(none)'}`,
    `- Suspected subsystem(s): ${input.suspectedSubsystems.length > 0 ? input.suspectedSubsystems.join(', ') : 'unknown'}`,
    '',
    '## Tool Evidence',
    '',
    toolLines,
    '',
    '## Guardian / Audit Evidence',
    '',
    guardianLines,
    '',
    '## Routing Trace Evidence',
    '',
    traceLines,
    '',
    '## Privacy Note',
    '',
    `This draft uses redacted routing trace and audit summaries. Review before opening a public issue.${input.evidence.traceFilePath ? ` Trace source: ${input.evidence.traceFilePath}` : ''}`,
  ].join('\n');
}

export async function buildDiagnosticsIssueDraft(
  input: DiagnosticsIssueDraftInput,
  deps: DiagnosticsIssueDraftDependencies,
  currentRequestId?: string,
): Promise<DiagnosticsIssueDraftResult> {
  const evidence = await collectDiagnosticsEvidence(
    {
      target: input.target,
      requestId: input.requestId,
      channel: input.channel,
      userId: input.userId,
      traceLimit: input.traceLimit,
      auditLimit: input.auditLimit,
      includeAudit: true,
    },
    deps,
    currentRequestId,
  );
  const suspectedSubsystems = inferSuspectedSubsystems(evidence);
  const severity = inferSeverity(evidence);
  const expectedBehavior = 'Guardian should preserve intent and shared orchestration state, gather evidence with approved read-only tools where appropriate, and ask only concrete clarifying questions when required.';
  const actualBehavior = evidence.blockers.length > 0
    ? evidence.blockers.join('; ')
    : (evidence.latestAssistantResponse ?? 'No selected trace entries showed a clear final assistant response.');
  const draft: DiagnosticsIssueDraft = {
    title: buildIssueTitle(input, evidence.latestUserRequest, evidence.blockers),
    body: buildBody({ draftInput: input, evidence, suspectedSubsystems }),
    labels: ['diagnostics', 'user-reported', ...suspectedSubsystems.map((subsystem) => `area:${subsystem}`)],
    severity,
    suspectedSubsystems,
    expectedBehavior,
    actualBehavior,
    privacyNote: 'Review this redacted draft before approving any GitHub issue creation. No external post has been made.',
  };

  return {
    draft,
    evidence: {
      target: evidence.target as DiagnosticsIssueTarget,
      traceEnabled: evidence.traceEnabled,
      ...(evidence.traceFilePath ? { traceFilePath: evidence.traceFilePath } : {}),
      requestIds: evidence.requestIds,
      entriesAnalyzed: evidence.entriesAnalyzed,
      auditEventsAnalyzed: evidence.auditEventsAnalyzed,
      stages: evidence.stages,
      ...(evidence.latestUserRequest ? { latestUserRequest: evidence.latestUserRequest } : {}),
      ...(evidence.latestAssistantResponse ? { latestAssistantResponse: evidence.latestAssistantResponse } : {}),
      blockers: evidence.blockers,
      toolCalls: evidence.toolCalls,
      guardianEvents: evidence.guardianEvents,
    },
    nextStep: 'Show this draft to the user. Only create a GitHub issue after the user explicitly approves the external post.',
  };
}
