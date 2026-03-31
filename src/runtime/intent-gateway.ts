import type { ChatMessage, ChatOptions, ChatResponse, ToolDefinition } from '../llm/types.js';

export type IntentGatewayRoute =
  | 'automation_authoring'
  | 'automation_control'
  | 'automation_output_task'
  | 'ui_control'
  | 'browser_task'
  | 'workspace_task'
  | 'email_task'
  | 'search_task'
  | 'filesystem_task'
  | 'coding_task'
  | 'coding_session_control'
  | 'security_task'
  | 'general_assistant'
  | 'unknown';

export type IntentGatewayConfidence = 'high' | 'medium' | 'low';

export type IntentGatewayOperation =
  | 'create'
  | 'update'
  | 'delete'
  | 'run'
  | 'toggle'
  | 'clone'
  | 'inspect'
  | 'navigate'
  | 'read'
  | 'search'
  | 'send'
  | 'draft'
  | 'schedule'
  | 'unknown';

export type IntentGatewayTurnRelation =
  | 'new_request'
  | 'follow_up'
  | 'clarification_answer'
  | 'correction';

export type IntentGatewayResolution =
  | 'ready'
  | 'needs_clarification';

export interface IntentGatewayEntities {
  automationName?: string;
  manualOnly?: boolean;
  scheduled?: boolean;
  enabled?: boolean;
  uiSurface?: 'automations' | 'dashboard' | 'config' | 'chat' | 'unknown';
  urls?: string[];
  query?: string;
  path?: string;
  sessionTarget?: string;
  emailProvider?: 'gws' | 'm365';
  codingBackend?: string;
  codingBackendRequested?: boolean;
  codingRunStatusCheck?: boolean;
}

export interface IntentGatewayDecision {
  route: IntentGatewayRoute;
  confidence: IntentGatewayConfidence;
  operation: IntentGatewayOperation;
  summary: string;
  turnRelation: IntentGatewayTurnRelation;
  resolution: IntentGatewayResolution;
  missingFields: string[];
  resolvedContent?: string;
  entities: IntentGatewayEntities;
}

export interface IntentGatewayRecord {
  mode: 'primary';
  available: boolean;
  model: string;
  latencyMs: number;
  decision: IntentGatewayDecision;
  rawResponsePreview?: string;
}

export const PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY = '__guardian_pre_routed_intent_gateway';

export interface IntentGatewayInput {
  content: string;
  channel?: string;
  recentHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  pendingAction?: {
    id: string;
    status: string;
    blockerKind: string;
    field?: string;
    route?: string;
    operation?: string;
    prompt: string;
    originalRequest: string;
    transferPolicy: string;
  } | null;
  continuity?: {
    continuityKey: string;
    linkedSurfaceCount: number;
    linkedSurfaces?: string[];
    focusSummary?: string;
    lastActionableRequest?: string;
    activeExecutionRefs?: string[];
  } | null;
  enabledManagedProviders?: string[];
  availableCodingBackends?: string[];
}

export type IntentGatewayChatFn = (
  messages: ChatMessage[],
  options?: ChatOptions,
) => Promise<ChatResponse>;

const INTENT_GATEWAY_TOOL: ToolDefinition = {
  name: 'route_intent',
  description: 'Classify the top-level handling route for a user request. Call exactly once.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      route: {
        type: 'string',
        enum: [
          'automation_authoring',
          'automation_control',
          'automation_output_task',
          'ui_control',
          'browser_task',
          'workspace_task',
          'email_task',
          'search_task',
          'filesystem_task',
          'coding_task',
          'coding_session_control',
          'security_task',
          'general_assistant',
        ],
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
      },
      operation: {
        type: 'string',
        enum: ['create', 'update', 'delete', 'run', 'toggle', 'clone', 'inspect', 'navigate', 'read', 'search', 'send', 'draft', 'schedule', 'unknown'],
      },
      summary: {
        type: 'string',
      },
      turnRelation: {
        type: 'string',
        enum: ['new_request', 'follow_up', 'clarification_answer', 'correction'],
      },
      resolution: {
        type: 'string',
        enum: ['ready', 'needs_clarification'],
      },
      missingFields: {
        type: 'array',
        items: {
          type: 'string',
        },
      },
      resolvedContent: {
        type: 'string',
      },
      automationName: {
        type: 'string',
      },
      manualOnly: {
        type: 'boolean',
      },
      scheduled: {
        type: 'boolean',
      },
      enabled: {
        type: 'boolean',
      },
      uiSurface: {
        type: 'string',
        enum: ['automations', 'dashboard', 'config', 'chat', 'unknown'],
      },
      urls: {
        type: 'array',
        items: {
          type: 'string',
        },
      },
      query: {
        type: 'string',
      },
      path: {
        type: 'string',
      },
      sessionTarget: {
        type: 'string',
      },
      emailProvider: {
        type: 'string',
        enum: ['gws', 'm365'],
      },
      codingBackend: {
        type: 'string',
      },
      codingBackendRequested: {
        type: 'boolean',
      },
      codingRunStatusCheck: {
        type: 'boolean',
      },
    },
    required: ['route', 'confidence', 'operation', 'summary'],
  },
};

const AUTOMATION_NAME_REPAIR_TOOL: ToolDefinition = {
  name: 'resolve_automation_name',
  description: 'Extract the exact saved automation name referenced by a request that is already known to be about controlling an existing automation. Call exactly once.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      automationName: {
        type: 'string',
      },
    },
    required: ['automationName'],
  },
};

const INTENT_GATEWAY_SYSTEM_PROMPT = [
  'You are Guardian\'s intent gateway.',
  'Your job is to classify the top-level route for a user request and determine whether the current turn is a new request, a follow-up, a clarification answer, or a correction.',
  'Never plan, explain, or execute the request.',
  'You must call the route_intent tool exactly once.',
  'Route definitions:',
  '- automation_authoring: creating or changing an automation or workflow definition.',
  '- automation_control: operating on an existing automation definition or run, such as delete, toggle, clone, inspect, or run.',
  '- automation_output_task: searching, reading, or analyzing previously stored output from a saved automation run.',
  '- ui_control: requests about Guardian UI pages or catalog surfaces such as automations, dashboard, config, or Guardian chat.',
  '- browser_task: external website navigation, reading, extraction, or interaction.',
  '- workspace_task: reading or mutating managed workspace tools such as Gmail, Calendar, Drive, Docs, Sheets, or Microsoft 365.',
  '- email_task: direct mailbox work such as checking inbox contents, reading mail, composing, drafting, sending, replying, or forwarding email.',
  '- search_task: generic web or document search and result retrieval.',
  '- filesystem_task: filesystem lookup or read/write operations such as file search.',
  '- coding_task: code execution, code generation, debugging, or programming work within a coding workspace. NOT session management.',
  '- coding_session_control: managing coding workspace sessions — listing, inspecting current session, switching/attaching, detaching, or creating sessions.',
  '- security_task: security triage, containment, or security-control operations.',
  '- general_assistant: everything else.',
  'Set turnRelation to new_request, follow_up, clarification_answer, or correction.',
  'An active pending action does not automatically make the next turn a follow_up, clarification_answer, or correction.',
  'If the user is clearly asking for a different task, classify it as turnRelation=new_request and route it on its own merits, even when a pending action exists.',
  'Only use pending action context when the current turn is clearly resolving, continuing, correcting, approving, denying, switching, or clarifying that same blocked request.',
  'Set resolution to needs_clarification when the user\'s goal is clear but a targeted missing detail is required before execution.',
  'When resolution=needs_clarification, populate missingFields with the concrete missing detail names such as email_provider, coding_backend, session_target, path, recipient, or automation_name.',
  'When the current turn is a clarification answer or correction and the prior context makes the intended action clear, set resolvedContent to a single actionable restatement of the full corrected request.',
  'Prefer ui_control over browser_task when the request refers to Guardian pages or internal catalog views.',
  'Prefer email_task over workspace_task for direct mailbox or email requests.',
  'Prefer search_task over browser_task for generic web search.',
  'Prefer automation_authoring for create/build/setup requests and automation_control for delete/toggle/run/clone/inspect requests.',
  'Requests to analyze, summarize, explain, compare, review, or investigate the output or findings of a previous automation run should route to automation_output_task, not automation_control.',
  'When the request refers to a specific existing automation, workflow, scheduled task, or assistant automation, always set automationName to the exact human-readable name from the request.',
  'Examples: "Run Browser Read Smoke now" -> automationName = "Browser Read Smoke"; "Show me the automation Browser Read Smoke" -> automationName = "Browser Read Smoke".',
  'Example: "Analyze the output from the last HN Snapshot Smoke automation run" -> route = "automation_output_task", automationName = "HN Snapshot Smoke".',
  'Prefer coding_session_control over coding_task when the user asks about which session is active, lists sessions, switches workspaces, attaches, detaches, or creates a new coding session.',
  'coding_session_control operation mapping: navigate = list/show all sessions or workspaces; inspect = check which single session is currently active or attached; update = switch/attach to a different session; delete = detach/disconnect from current session; create = create a new session.',
  'Examples: "list my coding workspaces" -> route=coding_session_control, operation=navigate; "what session am I on?" -> route=coding_session_control, operation=inspect; "switch to the Guardian project" -> route=coding_session_control, operation=update, sessionTarget="Guardian project"; "detach from workspace" -> route=coding_session_control, operation=delete; "what other sessions are there?" -> route=coding_session_control, operation=navigate.',
  'When the request mentions a specific coding session or workspace to switch to, set sessionTarget to the session name, id, or workspace path mentioned.',
  'When a coding_task explicitly names a different coding workspace to operate in, keep route=coding_task and also set sessionTarget to that workspace name, id, or path.',
  'For enable/disable requests, set enabled=true or enabled=false when explicit.',
  'Set emailProvider=gws for Gmail or Google Workspace requests. Set emailProvider=m365 for Outlook or Microsoft 365 requests.',
  'Set codingBackend when the user explicitly names Codex, Claude Code, Gemini CLI, or Aider.',
  'Set codingBackendRequested=true only when the user is explicitly asking Guardian to use or launch that coding backend for work. If Codex, Claude Code, Gemini CLI, or Aider is only the subject of a question, codingBackendRequested must be false or unset.',
  'Set codingRunStatusCheck=true only when the user is explicitly asking whether the most recent coding backend run completed, failed, timed out, exited with a code, or otherwise asking for recent-run status.',
  'Do not set codingRunStatusCheck for questions asking why a coding backend produced a particular file, diff, permission, executable bit, mode bit, output, or artifact. Those are explanation or investigation requests, not recent-run status checks.',
  'If both Google Workspace and Microsoft 365 are available and the user asks for direct mailbox work without specifying one, keep route=email_task and set resolution=needs_clarification, missingFields=["email_provider"].',
  'Example: prior user request "Use Codex to say hello and confirm you are working." then user says "Codex, the CLI coding assistant." -> route=coding_task, turnRelation=correction, resolution=ready, codingBackend=codex, codingBackendRequested=true, resolvedContent="Use Codex to say hello and confirm you are working. Just respond with a brief confirmation message. Do not change any files."',
  'Example: "Use Codex in the Test Tactical Game App workspace to create a smoke test file." -> route=coding_task, operation=create, codingBackend=codex, codingBackendRequested=true, sessionTarget="Test Tactical Game App workspace".',
  'Example: prior assistant said a Codex request named a different coding workspace and asked the user to switch first; then the user says "Okay, switch to Test Tactical Game App." -> route=coding_session_control, turnRelation=clarification_answer, operation=update, sessionTarget="Test Tactical Game App".',
  'Example: prior assistant said to switch workspaces first before running the deferred Codex request; after switching, the user says "Okay, now we\'re on the previous request that I asked." -> route=coding_task, turnRelation=follow_up, resolution=ready, resolvedContent should restate the original deferred coding request.',
  'Example: prior assistant asked which mail provider to use and the user replies "Use Outlook." -> route=email_task, turnRelation=clarification_answer, resolution=ready, emailProvider=m365, resolvedContent should restate the original mail request with Outlook / Microsoft 365 selected.',
  'Example: prior assistant asked which mail provider to use and the user replies "Google Workspace." or "Gmail." -> route=email_task, turnRelation=clarification_answer, resolution=ready, emailProvider=gws, resolvedContent should restate the original mail request with Gmail / Google Workspace selected.',
  'Example: prior user request "Use Codex to update the proposal in the workspace." then user says "Did Codex complete that work? Can you check?" -> route=coding_task, turnRelation=follow_up, operation=inspect, resolution=ready, codingBackend=codex, codingRunStatusCheck=true, resolvedContent should restate that this is a status check for the most recent Codex run related to that request.',
  'Example: "Why did Codex make that text file executable?" -> this is about Codex as the subject of the question, not a request to launch Codex. codingBackend may be set to codex, but codingBackendRequested=false and codingRunStatusCheck=false.',
  'Example: active pending action is approval for a Codex run, then the user says "Check my email." -> route=email_task, turnRelation=new_request, resolution should be based on the email request, and codingBackend should be unset.',
  'Example: active pending action is an email-provider clarification, then the user says "Use Codex to say hello and confirm you are working." -> route=coding_task, turnRelation=new_request, codingBackend=codex, codingBackendRequested=true.',
].join(' ');

const AUTOMATION_NAME_REPAIR_SYSTEM_PROMPT = [
  'You repair missing automation names for Guardian intent routing.',
  'The route and operation are already known to be about controlling an existing saved automation.',
  'Return only the exact automationName the user referenced.',
  'Call the resolve_automation_name tool exactly once.',
].join(' ');

export class IntentGateway {
  async classify(
    input: IntentGatewayInput,
    chat: IntentGatewayChatFn,
  ): Promise<IntentGatewayRecord> {
    const startedAt = Date.now();
    try {
      const response = await chat(buildIntentGatewayMessages(input), {
        maxTokens: 220,
        temperature: 0,
        tools: [INTENT_GATEWAY_TOOL],
      });
      const parsed = parseIntentGatewayDecision(response);
      let decision = parsed.decision;
      if (needsAutomationNameRepair(decision)) {
        const repairedName = await repairAutomationName(input, decision, chat);
        if (repairedName) {
          decision = {
            ...decision,
            entities: {
              ...decision.entities,
              automationName: repairedName,
            },
          };
        }
      }
      return {
        mode: 'primary',
        available: parsed.available,
        model: response.model,
        latencyMs: Date.now() - startedAt,
        decision,
        rawResponsePreview: buildRawResponsePreview(response),
      };
    } catch (error) {
      return {
        mode: 'primary',
        available: false,
        model: 'unknown',
        latencyMs: Date.now() - startedAt,
        decision: {
          route: 'unknown',
          confidence: 'low',
          operation: 'unknown',
          summary: error instanceof Error ? error.message : String(error),
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {},
        },
      };
    }
  }
}

export function toIntentGatewayClientMetadata(
  record: IntentGatewayRecord | null | undefined,
): Record<string, unknown> | undefined {
  if (!record) return undefined;
  return {
    mode: record.mode,
    available: record.available,
    model: record.model,
    latencyMs: record.latencyMs,
    route: record.decision.route,
    confidence: record.decision.confidence,
    operation: record.decision.operation,
    summary: record.decision.summary,
    turnRelation: record.decision.turnRelation,
    resolution: record.decision.resolution,
    missingFields: record.decision.missingFields,
    ...(record.decision.resolvedContent ? { resolvedContent: record.decision.resolvedContent } : {}),
    entities: record.decision.entities,
  };
}

export function serializeIntentGatewayRecord(
  record: IntentGatewayRecord,
): Record<string, unknown> {
  return {
    mode: record.mode,
    available: record.available,
    model: record.model,
    latencyMs: record.latencyMs,
    ...(record.rawResponsePreview ? { rawResponsePreview: record.rawResponsePreview } : {}),
    decision: {
      route: record.decision.route,
      confidence: record.decision.confidence,
      operation: record.decision.operation,
      summary: record.decision.summary,
      turnRelation: record.decision.turnRelation,
      resolution: record.decision.resolution,
      missingFields: [...record.decision.missingFields],
      ...(record.decision.resolvedContent ? { resolvedContent: record.decision.resolvedContent } : {}),
      ...record.decision.entities,
    },
  };
}

export function deserializeIntentGatewayRecord(
  value: unknown,
): IntentGatewayRecord | null {
  if (!isRecord(value)) return null;
  if (!isRecord(value.decision)) return null;
  return {
    mode: 'primary',
    available: value.available !== false,
    model: typeof value.model === 'string' && value.model.trim()
      ? value.model
      : 'unknown',
    latencyMs: typeof value.latencyMs === 'number' && Number.isFinite(value.latencyMs)
      ? value.latencyMs
      : 0,
    ...(typeof value.rawResponsePreview === 'string' && value.rawResponsePreview.trim()
      ? { rawResponsePreview: value.rawResponsePreview }
      : {}),
    decision: normalizeIntentGatewayDecision(value.decision),
  };
}

export function attachPreRoutedIntentGatewayMetadata(
  metadata: Record<string, unknown> | undefined,
  record: IntentGatewayRecord | null | undefined,
): Record<string, unknown> | undefined {
  if (!record) return metadata;
  return {
    ...(metadata ?? {}),
    [PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY]: serializeIntentGatewayRecord(record),
  };
}

export function readPreRoutedIntentGatewayMetadata(
  metadata: Record<string, unknown> | undefined,
): IntentGatewayRecord | null {
  if (!metadata) return null;
  return deserializeIntentGatewayRecord(metadata[PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY]);
}

function buildIntentGatewayMessages(input: IntentGatewayInput): ChatMessage[] {
  const channelLabel = input.channel?.trim() || 'unknown';
  const historySection = input.recentHistory && input.recentHistory.length > 0
    ? [
        'Recent conversation:',
        ...input.recentHistory.slice(-6).map((entry) => `${entry.role}: ${entry.content}`),
        '',
      ].join('\n')
    : '';
  const pendingActionSection = input.pendingAction
    ? [
        'Pending action context (only relevant if the current turn is actually continuing or resolving it):',
        `id: ${input.pendingAction.id}`,
        `status: ${input.pendingAction.status}`,
        `blocker kind: ${input.pendingAction.blockerKind}`,
        `transfer policy: ${input.pendingAction.transferPolicy}`,
        ...(input.pendingAction.field ? [`field: ${input.pendingAction.field}`] : []),
        ...(input.pendingAction.route ? [`route: ${input.pendingAction.route}`] : []),
        ...(input.pendingAction.operation ? [`operation: ${input.pendingAction.operation}`] : []),
        `prompt: ${input.pendingAction.prompt}`,
        `original request: ${input.pendingAction.originalRequest}`,
        '',
      ].join('\n')
    : '';
  const continuitySection = input.continuity
    ? [
        'Continuity thread context:',
        `continuity key: ${input.continuity.continuityKey}`,
        `linked surfaces: ${input.continuity.linkedSurfaceCount}`,
        ...(input.continuity.linkedSurfaces?.length ? [`surface list: ${input.continuity.linkedSurfaces.join(', ')}`] : []),
        ...(input.continuity.focusSummary ? [`focus summary: ${input.continuity.focusSummary}`] : []),
        ...(input.continuity.lastActionableRequest ? [`last actionable request: ${input.continuity.lastActionableRequest}`] : []),
        ...(input.continuity.activeExecutionRefs?.length ? [`active execution refs: ${input.continuity.activeExecutionRefs.join(', ')}`] : []),
        '',
      ].join('\n')
    : '';
  const providerSection = input.enabledManagedProviders && input.enabledManagedProviders.length > 0
    ? `Enabled managed providers: ${input.enabledManagedProviders.join(', ')}\n`
    : '';
  const codingBackendSection = input.availableCodingBackends && input.availableCodingBackends.length > 0
    ? `Available coding backends: ${input.availableCodingBackends.join(', ')}\n`
    : '';
  return [
    {
      role: 'system',
      content: INTENT_GATEWAY_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: [
        `Channel: ${channelLabel}`,
        providerSection.trimEnd(),
        codingBackendSection.trimEnd(),
        'Classify this request.',
        '',
        historySection,
        pendingActionSection,
        continuitySection,
        input.content.trim(),
      ].filter(Boolean).join('\n'),
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildAutomationNameRepairMessages(
  input: IntentGatewayInput,
  decision: IntentGatewayDecision,
): ChatMessage[] {
  const channelLabel = input.channel?.trim() || 'unknown';
  return [
    {
      role: 'system',
      content: AUTOMATION_NAME_REPAIR_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: [
        `Channel: ${channelLabel}`,
        `Route: ${decision.route}`,
        `Operation: ${decision.operation}`,
        'Extract the saved automation name from this request.',
        '',
        input.content.trim(),
      ].join('\n'),
    },
  ];
}

function parseIntentGatewayDecision(response: ChatResponse): { decision: IntentGatewayDecision; available: boolean } {
  const parsed = parseStructuredToolArguments(response)
    ?? parseStructuredContent(response.content);
  if (!parsed) {
    return {
      decision: {
        route: 'unknown',
        confidence: 'low',
        operation: 'unknown',
        summary: 'Intent gateway response was not structured.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        entities: {},
      },
      available: false,
    };
  }
  const decision = normalizeIntentGatewayDecision(parsed);
  return {
    decision,
    available: decision.route !== 'unknown',
  };
}

function parseStructuredToolArguments(response: ChatResponse): Record<string, unknown> | null {
  const firstToolCall = response.toolCalls?.[0];
  if (!firstToolCall?.arguments) return null;
  try {
    return JSON.parse(firstToolCall.arguments) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseAutomationNameRepair(response: ChatResponse): string | undefined {
  const parsed = parseStructuredToolArguments(response)
    ?? parseStructuredContent(response.content);
  if (!parsed) return undefined;
  const automationName = typeof parsed.automationName === 'string' ? parsed.automationName.trim() : '';
  return automationName || undefined;
}

function parseStructuredContent(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const jsonObject = extractJsonObject(trimmed);
    if (!jsonObject) return null;
    try {
      return JSON.parse(jsonObject) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function normalizeIntentGatewayDecision(parsed: Record<string, unknown>): IntentGatewayDecision {
  const route = normalizeRoute(parsed.route);
  const confidence = normalizeConfidence(parsed.confidence);
  const operation = normalizeOperation(parsed.operation);
  const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim()
    : 'No classification summary provided.';
  const turnRelation = normalizeTurnRelation(parsed.turnRelation);
  const resolution = normalizeResolution(parsed.resolution);
  const missingFields = Array.isArray(parsed.missingFields)
    ? parsed.missingFields
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    : [];
  const resolvedContent = typeof parsed.resolvedContent === 'string' && parsed.resolvedContent.trim()
    ? parsed.resolvedContent.trim()
    : undefined;

  const automationName = typeof parsed.automationName === 'string' && parsed.automationName.trim()
    ? parsed.automationName.trim()
    : undefined;
  const manualOnly = typeof parsed.manualOnly === 'boolean' ? parsed.manualOnly : undefined;
  const scheduled = typeof parsed.scheduled === 'boolean' ? parsed.scheduled : undefined;
  const enabled = typeof parsed.enabled === 'boolean' ? parsed.enabled : undefined;
  const uiSurface = normalizeUiSurface(parsed.uiSurface);
  const urls = Array.isArray(parsed.urls)
    ? parsed.urls
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    : undefined;
  const query = typeof parsed.query === 'string' && parsed.query.trim()
    ? parsed.query.trim()
    : undefined;
  const path = typeof parsed.path === 'string' && parsed.path.trim()
    ? parsed.path.trim()
    : undefined;
  const sessionTarget = typeof parsed.sessionTarget === 'string' && parsed.sessionTarget.trim()
    ? parsed.sessionTarget.trim()
    : undefined;
  const emailProvider = normalizeEmailProvider(parsed.emailProvider);
  const codingBackend = normalizeCodingBackend(parsed.codingBackend);
  const codingBackendRequested = typeof parsed.codingBackendRequested === 'boolean'
    ? parsed.codingBackendRequested
    : undefined;
  const codingRunStatusCheck = typeof parsed.codingRunStatusCheck === 'boolean'
    ? parsed.codingRunStatusCheck
    : undefined;

  return {
    route,
    confidence,
    operation,
    summary,
    turnRelation,
    resolution,
    missingFields,
    ...(resolvedContent ? { resolvedContent } : {}),
    entities: {
      ...(automationName ? { automationName } : {}),
      ...(typeof manualOnly === 'boolean' ? { manualOnly } : {}),
      ...(typeof scheduled === 'boolean' ? { scheduled } : {}),
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(uiSurface ? { uiSurface } : {}),
      ...(urls && urls.length > 0 ? { urls } : {}),
      ...(query ? { query } : {}),
      ...(path ? { path } : {}),
      ...(sessionTarget ? { sessionTarget } : {}),
      ...(emailProvider ? { emailProvider } : {}),
      ...(codingBackend ? { codingBackend } : {}),
      ...(typeof codingBackendRequested === 'boolean' ? { codingBackendRequested } : {}),
      ...(typeof codingRunStatusCheck === 'boolean' ? { codingRunStatusCheck } : {}),
    },
  };
}

async function repairAutomationName(
  input: IntentGatewayInput,
  decision: IntentGatewayDecision,
  chat: IntentGatewayChatFn,
): Promise<string | undefined> {
  try {
    const response = await chat(buildAutomationNameRepairMessages(input, decision), {
      maxTokens: 80,
      temperature: 0,
      tools: [AUTOMATION_NAME_REPAIR_TOOL],
    });
    return parseAutomationNameRepair(response);
  } catch {
    return undefined;
  }
}

function needsAutomationNameRepair(decision: IntentGatewayDecision): boolean {
  if (decision.entities.automationName?.trim()) return false;
  if (decision.route === 'automation_control' || decision.route === 'automation_output_task') {
    return ['delete', 'toggle', 'run', 'inspect', 'clone'].includes(decision.operation);
  }
  return decision.route === 'ui_control'
    && decision.entities.uiSurface === 'automations'
    && ['delete', 'toggle', 'run', 'inspect', 'clone'].includes(decision.operation);
}

function normalizeRoute(value: unknown): IntentGatewayRoute {
  switch (value) {
    case 'automation_authoring':
    case 'automation_control':
    case 'automation_output_task':
    case 'ui_control':
    case 'browser_task':
    case 'workspace_task':
    case 'email_task':
    case 'search_task':
    case 'filesystem_task':
    case 'coding_task':
    case 'coding_session_control':
    case 'security_task':
    case 'general_assistant':
      return value;
    default:
      return 'unknown';
  }
}

function normalizeConfidence(value: unknown): IntentGatewayConfidence {
  switch (value) {
    case 'high':
    case 'medium':
    case 'low':
      return value;
    default:
      return 'low';
  }
}

function normalizeOperation(value: unknown): IntentGatewayOperation {
  switch (value) {
    case 'create':
    case 'update':
    case 'delete':
    case 'run':
    case 'toggle':
    case 'clone':
    case 'inspect':
    case 'navigate':
    case 'read':
    case 'search':
    case 'send':
    case 'draft':
    case 'schedule':
      return value;
    default:
      return 'unknown';
  }
}

function normalizeTurnRelation(value: unknown): IntentGatewayTurnRelation {
  switch (value) {
    case 'new_request':
    case 'follow_up':
    case 'clarification_answer':
    case 'correction':
      return value;
    default:
      return 'new_request';
  }
}

function normalizeResolution(value: unknown): IntentGatewayResolution {
  switch (value) {
    case 'ready':
    case 'needs_clarification':
      return value;
    default:
      return 'ready';
  }
}

function normalizeUiSurface(
  value: unknown,
): IntentGatewayEntities['uiSurface'] | undefined {
  switch (value) {
    case 'automations':
    case 'dashboard':
    case 'config':
    case 'chat':
    case 'unknown':
      return value;
    default:
      return undefined;
  }
}

function normalizeEmailProvider(
  value: unknown,
): IntentGatewayEntities['emailProvider'] | undefined {
  switch (value) {
    case 'gws':
    case 'm365':
      return value;
    default:
      return undefined;
  }
}

function normalizeCodingBackend(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  switch (lower) {
    case 'unknown':
    case 'none':
    case 'n/a':
    case 'not specified':
    case 'unspecified':
      return undefined;
    case 'codex':
    case 'openai codex':
    case 'openai codex cli':
    case 'codex cli':
      return 'codex';
    case 'claude code':
    case 'claude-code':
      return 'claude-code';
    case 'gemini':
    case 'gemini cli':
    case 'gemini-cli':
      return 'gemini-cli';
    case 'aider':
      return 'aider';
    default:
      return trimmed;
  }
}

function buildRawResponsePreview(response: ChatResponse): string | undefined {
  const toolArguments = response.toolCalls?.[0]?.arguments?.trim();
  if (toolArguments) return toolArguments.slice(0, 200);
  const content = response.content.trim();
  return content ? content.slice(0, 200) : undefined;
}

function extractJsonObject(content: string): string | null {
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  return content.slice(firstBrace, lastBrace + 1);
}
