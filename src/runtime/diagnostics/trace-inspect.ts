import type {
  DiagnosticsEvidenceDependencies,
} from './evidence.js';
import {
  collectDiagnosticsEvidence,
  formatDiagnosticsTraceLine,
} from './evidence.js';

export interface DiagnosticsTraceInspectInput {
  requestId?: string;
  traceLimit?: number;
}

export interface DiagnosticsTraceInspectDependencies extends DiagnosticsEvidenceDependencies {}

export interface DiagnosticsTraceInspectResult {
  traceEnabled: boolean;
  traceFilePath?: string;
  entriesAnalyzed: number;
  requestIds: string[];
  latestRequestId?: string;
  latestUserRequest?: string;
  latestAssistantResponse?: string;
  stages: Record<string, number>;
  blockers: string[];
  timeline: string[];
  summary: string;
}

function summarize(stages: Record<string, number>, entriesAnalyzed: number, blockers: string[]): string {
  if (blockers.length > 0) {
    return `The trace shows a blocking path: ${blockers[0]}`;
  }
  if (stages.delegated_worker_started && !stages.dispatch_response) {
    return 'The trace shows delegated work started, but no final dispatch response in the selected window.';
  }
  if (stages.dispatch_response) {
    return 'The trace includes a completed dispatch response for the selected request.';
  }
  if (entriesAnalyzed > 0) {
    return 'The trace is readable and contains routing evidence for the selected request window.';
  }
  return 'No routing trace entries matched the selected request window.';
}

export async function inspectDiagnosticsTrace(
  input: DiagnosticsTraceInspectInput,
  dependencies: DiagnosticsTraceInspectDependencies,
  currentRequestId?: string,
): Promise<DiagnosticsTraceInspectResult> {
  const status = dependencies.intentRoutingTrace?.getStatus();
  if (!dependencies.intentRoutingTrace || status?.enabled === false) {
    return {
      traceEnabled: false,
      entriesAnalyzed: 0,
      requestIds: [],
      stages: {},
      blockers: [],
      timeline: [],
      summary: 'Routing trace inspection is not available in this runtime.',
    };
  }

  const evidence = await collectDiagnosticsEvidence(
    {
      target: input.requestId ? 'request_id' : 'latest_request',
      requestId: input.requestId,
      traceLimit: input.traceLimit,
      includeAudit: false,
    },
    dependencies,
    currentRequestId,
  );
  return {
    traceEnabled: evidence.traceEnabled,
    ...(evidence.traceFilePath ? { traceFilePath: evidence.traceFilePath } : {}),
    entriesAnalyzed: evidence.entriesAnalyzed,
    requestIds: evidence.requestIds,
    ...(evidence.requestIds[0] ? { latestRequestId: evidence.requestIds[0] } : {}),
    ...(evidence.latestUserRequest ? { latestUserRequest: evidence.latestUserRequest } : {}),
    ...(evidence.latestAssistantResponse ? { latestAssistantResponse: evidence.latestAssistantResponse } : {}),
    stages: evidence.stages,
    blockers: evidence.blockers,
    timeline: evidence.entries.slice(-20).map(formatDiagnosticsTraceLine),
    summary: summarize(evidence.stages, evidence.entriesAnalyzed, evidence.blockers),
  };
}
