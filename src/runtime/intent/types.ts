import type { ChatMessage, ChatOptions, ChatResponse } from '../../llm/types.js';

export type IntentGatewayRoute =
  | 'automation_authoring'
  | 'automation_control'
  | 'automation_output_task'
  | 'ui_control'
  | 'browser_task'
  | 'personal_assistant_task'
  | 'workspace_task'
  | 'email_task'
  | 'search_task'
  | 'memory_task'
  | 'filesystem_task'
  | 'coding_task'
  | 'coding_session_control'
  | 'security_task'
  | 'general_assistant'
  | 'channel_delivery'
  | 'complex_planning_task'
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
  | 'save'
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

export type IntentGatewayExecutionClass =
  | 'direct_assistant'
  | 'tool_orchestration'
  | 'repo_grounded'
  | 'provider_crud'
  | 'security_analysis';

export type IntentGatewayPreferredAnswerPath =
  | 'direct'
  | 'tool_loop'
  | 'chat_synthesis';

export type IntentGatewayExpectedContextPressure =
  | 'low'
  | 'medium'
  | 'high';

export type IntentGatewaySimpleVsComplex =
  | 'simple'
  | 'complex';

export type IntentGatewayProvenanceSource =
  | 'classifier.primary'
  | 'classifier.json_fallback'
  | 'classifier.route_only_fallback'
  | 'resolver.email'
  | 'resolver.coding'
  | 'resolver.personal_assistant'
  | 'resolver.provider_config'
  | 'resolver.clarification'
  | 'repair.unstructured'
  | 'repair.automation_name'
  | 'derived.workload';

export type IntentGatewayPreferredTier =
  | 'local'
  | 'external';

export interface IntentGatewayEntities {
  automationName?: string;
  newAutomationName?: string;
  manualOnly?: boolean;
  scheduled?: boolean;
  enabled?: boolean;
  uiSurface?: 'automations' | 'system' | 'dashboard' | 'config' | 'chat' | 'unknown';
  urls?: string[];
  query?: string;
  path?: string;
  sessionTarget?: string;
  emailProvider?: 'gws' | 'm365';
  mailboxReadMode?: 'unread' | 'latest';
  calendarTarget?: 'local' | 'gws' | 'm365';
  calendarWindowDays?: number;
  personalItemType?: 'overview' | 'note' | 'task' | 'calendar' | 'person' | 'library' | 'routine' | 'brief' | 'unknown';
  codingBackend?: string;
  codingBackendRequested?: boolean;
  codingRemoteExecRequested?: boolean;
  codingRunStatusCheck?: boolean;
  toolName?: string;
  profileId?: string;
  command?: string;
}

export interface IntentGatewayDecisionProvenance {
  route?: IntentGatewayProvenanceSource;
  operation?: IntentGatewayProvenanceSource;
  resolvedContent?: IntentGatewayProvenanceSource;
  executionClass?: IntentGatewayProvenanceSource;
  preferredTier?: IntentGatewayProvenanceSource;
  requiresRepoGrounding?: IntentGatewayProvenanceSource;
  requiresToolSynthesis?: IntentGatewayProvenanceSource;
  expectedContextPressure?: IntentGatewayProvenanceSource;
  preferredAnswerPath?: IntentGatewayProvenanceSource;
  simpleVsComplex?: IntentGatewayProvenanceSource;
  entities?: Partial<Record<keyof IntentGatewayEntities, IntentGatewayProvenanceSource>>;
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
  executionClass: IntentGatewayExecutionClass;
  preferredTier: IntentGatewayPreferredTier;
  requiresRepoGrounding: boolean;
  requiresToolSynthesis: boolean;
  expectedContextPressure: IntentGatewayExpectedContextPressure;
  preferredAnswerPath: IntentGatewayPreferredAnswerPath;
  simpleVsComplex?: IntentGatewaySimpleVsComplex;
  provenance?: IntentGatewayDecisionProvenance;
  entities: IntentGatewayEntities;
}

export interface IntentGatewayRecord {
  mode: 'primary' | 'json_fallback' | 'route_only_fallback';
  available: boolean;
  model: string;
  latencyMs: number;
  promptProfile?: IntentGatewayPromptProfile;
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
    summary?: string;
    resolution?: string;
    missingFields?: string[];
    provenance?: IntentGatewayDecisionProvenance;
    entities?: Record<string, unknown>;
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

export interface IntentGatewayRepairContext {
  sourceContent?: string;
  pendingAction?: IntentGatewayInput['pendingAction'] | null;
  continuity?: IntentGatewayInput['continuity'] | null;
}

export type IntentGatewayPromptProfile = 'compact' | 'full';

export type IntentGatewayChatFn = (
  messages: ChatMessage[],
  options?: ChatOptions,
) => Promise<ChatResponse>;
