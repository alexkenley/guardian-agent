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

export interface IntentGatewayEntities {
  automationName?: string;
  manualOnly?: boolean;
  scheduled?: boolean;
  enabled?: boolean;
  uiSurface?: 'automations' | 'dashboard' | 'config' | 'chat' | 'unknown';
  urls?: string[];
  query?: string;
  path?: string;
}

export interface IntentGatewayDecision {
  route: IntentGatewayRoute;
  confidence: IntentGatewayConfidence;
  operation: IntentGatewayOperation;
  summary: string;
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

export interface IntentGatewayInput {
  content: string;
  channel?: string;
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
  'Your job is only to classify the top-level route for a user request.',
  'Never plan, explain, or execute the request.',
  'You must call the route_intent tool exactly once.',
  'Route definitions:',
  '- automation_authoring: creating or changing an automation or workflow definition.',
  '- automation_control: operating on an existing automation definition or run, such as delete, toggle, clone, inspect, or run.',
  '- automation_output_task: searching, reading, or analyzing previously stored output from a saved automation run.',
  '- ui_control: requests about Guardian UI pages or catalog surfaces such as the automations page, dashboard, config, or chat page.',
  '- browser_task: external website navigation, reading, extraction, or interaction.',
  '- workspace_task: reading or mutating managed workspace tools such as Gmail, Calendar, Drive, Docs, Sheets, or Microsoft 365.',
  '- email_task: composing, drafting, sending, or replying to a direct email or Gmail message.',
  '- search_task: generic web or document search and result retrieval.',
  '- filesystem_task: filesystem lookup or read/write operations such as file search.',
  '- coding_task: coding-session or code-execution requests.',
  '- security_task: security triage, containment, or security-control operations.',
  '- general_assistant: everything else.',
  'Prefer ui_control over browser_task when the request refers to Guardian pages or internal catalog views.',
  'Prefer email_task over workspace_task for direct email compose/send requests.',
  'Prefer search_task over browser_task for generic web search.',
  'Prefer automation_authoring for create/build/setup requests and automation_control for delete/toggle/run/clone/inspect requests.',
  'Requests to analyze, summarize, explain, compare, review, or investigate the output or findings of a previous automation run should route to automation_output_task, not automation_control.',
  'When the request refers to a specific existing automation, workflow, scheduled task, or assistant automation, always set automationName to the exact human-readable name from the request.',
  'Examples: "Run Browser Read Smoke now" -> automationName = "Browser Read Smoke"; "Show me the automation Browser Read Smoke" -> automationName = "Browser Read Smoke".',
  'Example: "Analyze the output from the last HN Snapshot Smoke automation run" -> route = "automation_output_task", automationName = "HN Snapshot Smoke".',
  'For enable/disable requests, set enabled=true or enabled=false when explicit.',
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
    entities: record.decision.entities,
  };
}

function buildIntentGatewayMessages(input: IntentGatewayInput): ChatMessage[] {
  const channelLabel = input.channel?.trim() || 'unknown';
  return [
    {
      role: 'system',
      content: INTENT_GATEWAY_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: [
        `Channel: ${channelLabel}`,
        'Classify this request.',
        '',
        input.content.trim(),
      ].join('\n'),
    },
  ];
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

  return {
    route,
    confidence,
    operation,
    summary,
    entities: {
      ...(automationName ? { automationName } : {}),
      ...(typeof manualOnly === 'boolean' ? { manualOnly } : {}),
      ...(typeof scheduled === 'boolean' ? { scheduled } : {}),
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(uiSurface ? { uiSurface } : {}),
      ...(urls && urls.length > 0 ? { urls } : {}),
      ...(query ? { query } : {}),
      ...(path ? { path } : {}),
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
