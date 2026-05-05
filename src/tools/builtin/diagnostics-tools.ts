import {
  buildDiagnosticsIssueDraft,
  type DiagnosticsIssueDraftDependencies,
  type DiagnosticsIssueDraftInput,
  type DiagnosticsIssueTarget,
} from '../../runtime/diagnostics/issue-draft.js';
import {
  inspectDiagnosticsTrace,
  type DiagnosticsTraceInspectInput,
} from '../../runtime/diagnostics/trace-inspect.js';
import { ToolRegistry } from '../registry.js';
import type { ToolExecutionRequest } from '../types.js';

interface DiagnosticsToolRegistrarContext extends DiagnosticsIssueDraftDependencies {
  registry: ToolRegistry;
  asString: (value: unknown, fallback?: string) => string;
  asNumber: (value: unknown, fallback: number) => number;
}

const ISSUE_TARGETS = new Set<DiagnosticsIssueTarget>([
  'latest_completed_request',
  'current_request',
  'recent_window',
  'request_id',
]);

function normalizeIssueTarget(value: unknown): DiagnosticsIssueTarget | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return ISSUE_TARGETS.has(normalized as DiagnosticsIssueTarget)
    ? normalized as DiagnosticsIssueTarget
    : undefined;
}

function normalizeIssueDraftInput(
  args: Record<string, unknown>,
  request: ToolExecutionRequest,
  context: DiagnosticsToolRegistrarContext,
): DiagnosticsIssueDraftInput {
  const requestId = context.asString(args.requestId).trim();
  const problem = context.asString(args.problem).trim();
  const channel = context.asString(args.channel).trim() || request.channel || request.origin;
  const userId = context.asString(args.userId).trim() || request.userId;
  return {
    ...(normalizeIssueTarget(args.target) ? { target: normalizeIssueTarget(args.target) } : {}),
    ...(requestId ? { requestId } : {}),
    ...(problem ? { problem } : {}),
    ...(channel ? { channel } : {}),
    ...(userId ? { userId } : {}),
    ...(args.traceLimit !== undefined ? { traceLimit: context.asNumber(args.traceLimit, 80) } : {}),
    ...(args.auditLimit !== undefined ? { auditLimit: context.asNumber(args.auditLimit, 30) } : {}),
  };
}

function normalizeTraceInspectInput(
  args: Record<string, unknown>,
  context: DiagnosticsToolRegistrarContext,
): DiagnosticsTraceInspectInput {
  const requestId = context.asString(args.requestId).trim();
  return {
    ...(requestId ? { requestId } : {}),
    ...(args.traceLimit !== undefined ? { traceLimit: context.asNumber(args.traceLimit, 80) } : {}),
  };
}

export function registerBuiltinDiagnosticsTools(context: DiagnosticsToolRegistrarContext): void {
  context.registry.register(
    {
      name: 'guardian_trace_inspect',
      description: 'Inspect GuardianAgent routing trace evidence for recent assistant behavior. Use when the user asks what happened, whether Guardian can see its routing trace, why a request was blocked, why routing chose a path, or why a delegated/coding run stalled. This is read-only and returns redacted trace summaries; it does not create an issue.',
      shortDescription: 'Inspect recent Guardian routing trace evidence.',
      risk: 'read_only',
      category: 'system',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          requestId: {
            type: 'string',
            description: 'Optional specific requestId to inspect. Defaults to the latest non-current request window.',
          },
          traceLimit: {
            type: 'number',
            description: 'Maximum recent routing trace entries to inspect, 1-200. Default 80.',
          },
        },
      },
      examples: [
        {
          input: { traceLimit: 80 },
          description: 'Inspect the latest routing trace window and explain what happened.',
        },
        {
          input: { requestId: 'req-123' },
          description: 'Inspect a specific request id from the routing trace.',
        },
      ],
    },
    async (args, request) => {
      if (!context.intentRoutingTrace) {
        return {
          success: false,
          error: 'Guardian diagnostics are not available in this runtime.',
        };
      }
      const input = normalizeTraceInspectInput(args, context);
      const result = await inspectDiagnosticsTrace(input, context, request.requestId);
      return {
        success: true,
        message: 'Inspected the redacted routing trace.',
        output: result,
        verificationStatus: 'verified',
        verificationEvidence: 'Read-only diagnostics summary built from redacted routing trace entries.',
      };
    },
  );

  context.registry.register(
    {
      name: 'guardian_issue_draft',
      description: 'Draft a high-quality GuardianAgent GitHub issue from redacted diagnostics. Use after the user reports that the assistant behaved incorrectly, got stuck, routed poorly, asked the wrong clarification, lost context, produced an ungrounded answer, or had approval/tool issues. This tool is read-only: it inspects recent routing trace and Guardian/audit summaries, drafts the issue title/body/labels, and does not create or post anything externally.',
      shortDescription: 'Draft a redacted bug-report issue from Guardian diagnostics. Read-only; does not post to GitHub.',
      risk: 'read_only',
      category: 'system',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: ['latest_completed_request', 'current_request', 'recent_window', 'request_id'],
            description: 'Which diagnostic window to draft from. Default: latest_completed_request, excluding the current report request.',
          },
          requestId: {
            type: 'string',
            description: 'Specific requestId to diagnose when target=request_id or target=current_request.',
          },
          problem: {
            type: 'string',
            description: 'Short user-facing description of what went wrong.',
          },
          channel: {
            type: 'string',
            description: 'Optional channel filter such as web, cli, telegram, or api.',
          },
          userId: {
            type: 'string',
            description: 'Optional user filter for routing trace lookup.',
          },
          traceLimit: {
            type: 'number',
            description: 'Maximum recent routing trace entries to inspect, 1-200. Default 80.',
          },
          auditLimit: {
            type: 'number',
            description: 'Maximum recent Guardian/audit events to inspect, 1-100. Default 30.',
          },
        },
      },
      examples: [
        {
          input: { problem: 'The assistant ignored the follow-up topic and answered the old request.' },
          description: 'Draft an issue for the latest completed request using recent diagnostics',
        },
        {
          input: { target: 'request_id', requestId: 'req-123', problem: 'Web search asked for repeated approvals.' },
          description: 'Draft an issue for a specific request id',
        },
      ],
    },
    async (args, request) => {
      if (!context.intentRoutingTrace) {
        return {
          success: false,
          error: 'Guardian diagnostics are not available in this runtime.',
        };
      }
      const input = normalizeIssueDraftInput(args, request, context);
      const result = await buildDiagnosticsIssueDraft(input, context, request.requestId);
      return {
        success: true,
        message: 'Drafted a redacted issue report. No external issue was created.',
        output: result,
        verificationStatus: 'verified',
        verificationEvidence: 'Read-only diagnostics issue draft built from redacted routing trace and Guardian/audit summaries.',
      };
    },
  );
}
