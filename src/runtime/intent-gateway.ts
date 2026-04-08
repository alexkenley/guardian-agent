import type { ChatMessage, ChatOptions, ChatResponse, ToolDefinition } from '../llm/types.js';
import { parseStructuredJsonObject } from '../util/structured-json.js';

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
  codingRunStatusCheck?: boolean;
  toolName?: string;
  profileId?: string;
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
  entities: IntentGatewayEntities;
}

export interface IntentGatewayRecord {
  mode: 'primary' | 'json_fallback';
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
          'personal_assistant_task',
          'workspace_task',
          'email_task',
          'search_task',
          'memory_task',
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
        enum: ['create', 'update', 'delete', 'run', 'toggle', 'clone', 'inspect', 'navigate', 'read', 'search', 'save', 'send', 'draft', 'schedule', 'unknown'],
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
      executionClass: {
        type: 'string',
        enum: ['direct_assistant', 'tool_orchestration', 'repo_grounded', 'provider_crud', 'security_analysis'],
      },
      preferredTier: {
        type: 'string',
        enum: ['local', 'external'],
      },
      requiresRepoGrounding: {
        type: 'boolean',
      },
      requiresToolSynthesis: {
        type: 'boolean',
      },
      expectedContextPressure: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
      },
      preferredAnswerPath: {
        type: 'string',
        enum: ['direct', 'tool_loop', 'chat_synthesis'],
      },
      automationName: {
        type: 'string',
      },
      newAutomationName: {
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
        enum: ['automations', 'system', 'dashboard', 'config', 'chat', 'unknown'],
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
      mailboxReadMode: {
        type: 'string',
        enum: ['unread', 'latest'],
      },
      calendarTarget: {
        type: 'string',
        enum: ['local', 'gws', 'm365'],
      },
      calendarWindowDays: {
        type: 'number',
      },
      personalItemType: {
        type: 'string',
        enum: ['overview', 'note', 'task', 'calendar', 'person', 'library', 'routine', 'brief', 'unknown'],
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
      toolName: {
        type: 'string',
      },
      profileId: {
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

const INTENT_GATEWAY_INSTRUCTION_LINES = [
  'Route definitions:',
  '- automation_authoring: creating a new automation or changing automation definition content from freeform requirements.',
  '- automation_control: operating on an existing automation definition or run, such as rename, delete, toggle, clone, inspect, or run.',
  '- automation_output_task: searching, reading, or analyzing previously stored output from a saved automation run.',
  '- ui_control: requests about Guardian UI pages or catalog surfaces such as automations, system, dashboard, config, or Guardian chat.',
  '- browser_task: external website navigation, reading, extraction, or interaction.',
  '- personal_assistant_task: personal productivity work in Second Brain such as notes, tasks, reminders, calendar planning, meeting prep, people context, routines, briefs, and personal retrieval across messages, docs, events, and notes.',
  '- workspace_task: explicit provider CRUD or administration in managed Google Workspace or Microsoft 365 surfaces such as Drive, Docs, Sheets, Calendar object edits, OneDrive, SharePoint, or Teams. Use this when the provider object or provider surface itself is the target, not Second Brain synthesis.',
  '- email_task: direct mailbox work in Gmail or Outlook such as checking inbox contents, reading mail, composing, drafting, sending, replying, or forwarding email.',
  '- search_task: generic web or document search and result retrieval.',
  '- memory_task: durable memory operations such as remember/save, recall, or search memory.',
  '- filesystem_task: filesystem lookup or read/write operations such as file search.',
  '- coding_task: code execution, code generation, debugging, repo inspection, code review, implementation planning, or programming work within a coding workspace. NOT session management.',
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
  'Also classify the workload metadata: executionClass, preferredTier, requiresRepoGrounding, requiresToolSynthesis, expectedContextPressure, and preferredAnswerPath.',
  'preferredTier is a coarse local vs external hint only. Do not choose provider names or model names.',
  'executionClass must be one of direct_assistant, tool_orchestration, repo_grounded, provider_crud, or security_analysis.',
  'preferredAnswerPath must be direct, tool_loop, or chat_synthesis.',
  'expectedContextPressure must be low, medium, or high based on how much bounded context the runtime will likely need to assemble.',
  'Use only the exact enum values defined by the schema for route, confidence, operation, turnRelation, resolution, uiSurface, emailProvider, and calendarTarget. Do not paraphrase enum names.',
  'Prefer ui_control over browser_task when the request refers to Guardian pages or internal catalog views.',
  'Guardian AI provider profile inventory, model catalog inspection, model routing policy, and AI provider configuration work are not Second Brain tasks. For those requests, prefer general_assistant with uiSurface=config and workload metadata that keeps the request in provider/tool orchestration rather than personal_assistant_task.',
  'Prefer email_task over workspace_task for direct mailbox or email requests.',
  'Prefer personal_assistant_task over workspace_task or email_task when the user intent is personal productivity or Second Brain work rather than explicit provider CRUD.',
  'Prefer personal_assistant_task for meeting prep, follow-up drafting, calendar planning, personal search across email/docs/calendar/notes, outreach review, or "what do I owe this person?" even when the evidence comes from Google Workspace or Microsoft 365.',
  'Prefer automation_authoring when the user explicitly asks to create an automation, workflow, or scheduled automation for the Automations system.',
  'Prefer personal_assistant_task with personalItemType=routine when the user explicitly asks for a Second Brain routine or names an assistant routine concept such as Morning Brief, Pre-Meeting Brief, Follow-Up Watch, Weekly Review, Daily Agenda Check, Deadline Watch, or the Routines tab.',
  'Unqualified calendar entry, calendar event, or calendar item create/update/delete requests default to the local Second Brain calendar with route=personal_assistant_task, personalItemType=calendar, and calendarTarget=local.',
  'Prefer workspace_task for explicit provider CRUD or administration such as listing Drive files, creating a Google Sheet, editing a SharePoint document, browsing OneDrive, or mutating an event directly in Google Calendar or Outlook Calendar.',
  'Prefer email_task for direct inbox work in Gmail or Outlook, but not for meeting prep, follow-up drafting, or broader Second Brain synthesis.',
  'Prefer search_task over browser_task for generic web search.',
  'Prefer memory_task for explicit persistent-memory requests such as "remember this", "what do you remember about ...", or "search memory for ...".',
  'Prefer automation_authoring for create/build/setup requests and automation_control for rename/delete/toggle/run/clone/inspect requests on an existing automation.',
  'Do not use automation_control for explicit built-in tool execution requests, cloud-hosting status checks, or direct tool names such as whm_status, vercel_status, aws_status, gcp_status, azure_status, or cf_status.',
  'If the user explicitly names a built-in tool, set entities.toolName to that exact tool name.',
  'If the user explicitly names a configured provider profile id such as profileId social, set entities.profileId to that exact profile id.',
  'Direct cloud/hosting status or inspection requests for configured profiles are not automation control unless the user explicitly refers to an existing saved automation/workflow/task.',
  'Questions about automation capabilities, examples, supported shapes, or how automations work are general_assistant unless the user is actually asking you to create or change a specific automation or workflow definition.',
  'Do not use automation_authoring just because the words "automation" and "create" both appear in a capability question such as "What automations can you create?"',
  'Requests to analyze, summarize, explain, compare, review, or investigate the output or findings of a previous automation run should route to automation_output_task, not automation_control.',
  'When the user asks to edit or change an existing automation, such as renaming it, changing its schedule, or switching it between scheduled and manual mode, use automation_control with operation=update rather than automation_authoring.',
  'When the request refers to a specific existing automation, workflow, scheduled task, or assistant automation, always set automationName to the exact human-readable name from the request.',
  'Examples: "Run Browser Read Smoke now" -> automationName = "Browser Read Smoke"; "Show me the automation Browser Read Smoke" -> automationName = "Browser Read Smoke".',
  'When renaming an existing automation, set route=automation_control, operation=update, automationName to the current automation name when known, and newAutomationName to the requested new human-readable name.',
  'Example: "Rename Browser Read Smoke to Browser Read Smoke Daily." -> route=automation_control, operation=update, automationName="Browser Read Smoke", newAutomationName="Browser Read Smoke Daily".',
  'Example: prior assistant just created "It Should Check Account" and the user says "Rename that automation to WHM Social Check Disk Quota." -> route=automation_control, turnRelation=follow_up, operation=update, automationName="It Should Check Account", newAutomationName="WHM Social Check Disk Quota".',
  'Example: "Edit the WHM Social Check Disk Quota automation and make it run daily at 9:00 AM." -> route=automation_control, operation=update, automationName="WHM Social Check Disk Quota".',
  'Example: "List my automations." -> route=automation_control, operation=read.',
  'Example: prior assistant just created "Weekday Outlook Inbox Summary" and the user says "Disable that automation." -> route=automation_control, turnRelation=follow_up, operation=toggle, automationName="Weekday Outlook Inbox Summary", enabled=false.',
  'Example: "Analyze the output from the last HN Snapshot Smoke automation run" -> route = "automation_output_task", automationName = "HN Snapshot Smoke".',
  'Example: "What sort of automations can you create?" -> route = "general_assistant", operation = "inspect".',
  'Example: "Run the cloud tool whm_status using profileId social." -> route = "general_assistant", operation = "run", toolName = "whm_status", profileId = "social".',
  'Example: "Check the social WHM account status." -> route = "general_assistant", operation = "inspect", toolName = "whm_status", profileId = "social".',
  'Example: "List my configured AI providers." -> route=general_assistant, operation=read, uiSurface=config, executionClass=provider_crud, preferredTier=external, requiresRepoGrounding=false, requiresToolSynthesis=true, expectedContextPressure=medium, preferredAnswerPath=tool_loop.',
  'Example: "Show the available models for my ollama-cloud-tools profile." -> route=general_assistant, operation=inspect, uiSurface=config, executionClass=provider_crud, preferredTier=external, requiresRepoGrounding=false, requiresToolSynthesis=true, expectedContextPressure=medium, preferredAnswerPath=tool_loop.',
  'Generic planning or advice prompts such as "Give me a concise plan for organizing my week" are general_assistant, not personal_assistant_task, unless the user explicitly asks to inspect, summarize, or update their actual Second Brain tasks, notes, calendar, routines, or Today view.',
  'memory_task operation mapping: save = remember/store durable memory; read = recall or list remembered information; search = search conversation or persistent memory.',
  'Examples: "Remember globally that my test marker is cedar-47." -> route=memory_task, operation=save; "What do you remember about cedar-47?" -> route=memory_task, operation=read; "Search memory for cedar-47." -> route=memory_task, operation=search.',
  'Prefer coding_session_control over coding_task when the user asks about which session is active, lists sessions, switches workspaces, attaches, detaches, or creates a new coding session.',
  'Requests to inspect, explain, review, or plan changes against specific repo files, diffs, PRs, patches, or source paths are coding_task when they are grounded in a coding workspace or named repo files. Do not collapse those into general_assistant just because the immediate output is prose.',
  'coding_session_control operation mapping: navigate = list/show all sessions or workspaces; inspect = check which single session is currently active or attached; update = switch/attach to a different session; delete = detach/disconnect from current session; create = create a new session.',
  'Examples: "list my coding workspaces" -> route=coding_session_control, operation=navigate; "what session am I on?" -> route=coding_session_control, operation=inspect; "switch to the Guardian project" -> route=coding_session_control, operation=update, sessionTarget="Guardian project"; "detach from workspace" -> route=coding_session_control, operation=delete; "what other sessions are there?" -> route=coding_session_control, operation=navigate.',
  'When the request mentions a specific coding session or workspace to switch to, set sessionTarget to the session name, id, or workspace path mentioned.',
  'When a coding_task explicitly names a different coding workspace to operate in, keep route=coding_task and also set sessionTarget to that workspace name, id, or path.',
  'Example: "Inspect src/skills/prompt.ts and src/chat-agent.ts. Review the uplift for regressions and missing tests." -> route=coding_task, operation=inspect.',
  'Example: "Inspect docs/plans/... and src/skills/prompt.ts. Write an implementation plan for this change." -> route=coding_task, operation=inspect.',
  'Example: "What do I have due today?" -> route=personal_assistant_task, operation=inspect, personalItemType=overview.',
  'Example: "Give me a concise plan for organizing my week." -> route=general_assistant, operation=inspect, executionClass=direct_assistant, preferredTier=external, requiresRepoGrounding=false, requiresToolSynthesis=false, expectedContextPressure=low, preferredAnswerPath=direct.',
  'Example: "Show my tasks." -> route=personal_assistant_task, operation=read, personalItemType=task.',
  'Example: "Show my notes." -> route=personal_assistant_task, operation=read, personalItemType=note.',
  'Example: "Show my library items." -> route=personal_assistant_task, operation=read, personalItemType=library.',
  'Example: "Show my briefs." -> route=personal_assistant_task, operation=read, personalItemType=brief.',
  'Example: "Show the people in my Second Brain." -> route=personal_assistant_task, operation=read, personalItemType=person.',
  'Example: "Show my routines." -> route=personal_assistant_task, operation=read, personalItemType=routine.',
  'Example: "Show only my enabled routines." -> route=personal_assistant_task, operation=read, personalItemType=routine, enabled=true.',
  'Example: "Show only my disabled routines." -> route=personal_assistant_task, operation=read, personalItemType=routine, enabled=false.',
  'Example: "What routines are related to email or inbox processing?" -> route=personal_assistant_task, operation=read, personalItemType=routine, query="email or inbox processing".',
  'Example: "Show my calendar events for the next 7 days." -> route=personal_assistant_task, operation=read, personalItemType=calendar, calendarTarget=local, calendarWindowDays=7.',
  'Example: follow-up "Show my tasks again." -> route=personal_assistant_task, operation=read, personalItemType=task.',
  'Example: follow-up "Update that note to say: \\"Second Brain write smoke test note updated.\\"" -> route=personal_assistant_task, operation=update, personalItemType=note.',
  'Example: follow-up "Delete that note." -> route=personal_assistant_task, operation=delete, personalItemType=note.',
  'Example: "Create a brief called Second Brain brief smoke test that says This is a brief for smoke testing." -> route=personal_assistant_task, operation=create, personalItemType=brief.',
  'Example: follow-up "Update that brief to say this is the updated brief." -> route=personal_assistant_task, operation=update, personalItemType=brief.',
  'Example: follow-up "Delete that brief." -> route=personal_assistant_task, operation=delete, personalItemType=brief.',
  'Example: "Create a person in my Second Brain named Smoke Test Person with email smoke@example.com." -> route=personal_assistant_task, operation=create, personalItemType=person.',
  'Example: follow-up "Update that person to include email smoke@example.com." -> route=personal_assistant_task, operation=update, personalItemType=person.',
  'Example: follow-up "Delete that person." -> route=personal_assistant_task, operation=delete, personalItemType=person.',
  'Example: follow-up "Mark that task as done." -> route=personal_assistant_task, operation=update, personalItemType=task.',
  'Example: follow-up "Move that event to tomorrow at 5 PM." -> route=personal_assistant_task, operation=update, personalItemType=calendar, calendarTarget=local.',
  'Example: follow-up "Delete that calendar event." -> route=personal_assistant_task, operation=delete, personalItemType=calendar, calendarTarget=local.',
  'Example: "Save a note that the Q3 offsite venue is River House." -> route=personal_assistant_task, operation=save, personalItemType=note.',
  'Example: "Create the Pre-Meeting Brief routine in Second Brain." -> route=personal_assistant_task, operation=create, personalItemType=routine.',
  'Example: "Create a task to send the follow-up deck tomorrow." -> route=personal_assistant_task, operation=create, personalItemType=task.',
  'Example: "Create a calendar entry for tomorrow at 3 PM called Dentist." -> route=personal_assistant_task, operation=create, personalItemType=calendar, calendarTarget=local.',
  'Example: "Move my Guardian calendar event with Alex to Friday." -> route=personal_assistant_task, operation=update, personalItemType=calendar, calendarTarget=local.',
  'Example: "Prepare me for my next Outlook meeting using the calendar event, recent email, and docs." -> route=personal_assistant_task, operation=inspect, personalItemType=brief, emailProvider=m365.',
  'Example: "Draft a follow-up email from my meeting notes and Gmail thread." -> route=personal_assistant_task, operation=draft, personalItemType=brief, emailProvider=gws.',
  'Example: "Create an automation that checks WHM disk quota every day." -> route=automation_authoring, operation=create.',
  'Example: "List the files in my Drive." -> route=workspace_task, operation=read.',
  'Example: "Create a new Google Sheet for the Q3 budget." -> route=workspace_task, operation=create.',
  'Example: "Add this meeting to my Google Calendar." -> route=workspace_task, operation=create, calendarTarget=gws.',
  'Example: "Delete the event from my Outlook calendar." -> route=workspace_task, operation=delete, calendarTarget=m365.',
  'Example: "Update the SharePoint document for the launch checklist." -> route=workspace_task, operation=update.',
  'Example: "Check my unread Outlook mail." -> route=email_task, operation=read, emailProvider=m365, mailboxReadMode=unread.',
  'Example: "Show me the newest five emails in Gmail." -> route=email_task, operation=read, emailProvider=gws, mailboxReadMode=latest.',
  'For enable/disable requests, set enabled=true or enabled=false when explicit.',
  'Set emailProvider=gws for Gmail or Google Workspace requests. Set emailProvider=m365 for Outlook or Microsoft 365 requests.',
  'Set mailboxReadMode=unread when the user explicitly asks for unread or new mail. Set mailboxReadMode=latest when they ask for newest, latest, recent, or last inbox messages regardless of read status.',
  'Set calendarTarget=local for unqualified Second Brain calendar requests. Set calendarTarget=gws for Google Calendar requests. Set calendarTarget=m365 for Outlook Calendar or Microsoft 365 calendar requests.',
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
  'Example: prior assistant listed unread Gmail mail, then the user says "No, not unread — just show me the latest five emails in Gmail." -> route=email_task, turnRelation=correction, resolution=ready, emailProvider=gws, mailboxReadMode=latest, resolvedContent should restate the corrected Gmail inbox-read request.',
  'Example: prior assistant asked which automation to edit and the user replies "WHM Social Check Disk Quota." -> route=automation_control, turnRelation=clarification_answer, operation=update, automationName="WHM Social Check Disk Quota", resolvedContent should restate the original automation-edit request when possible.',
  'Example: prior user request "Use Codex to update the proposal in the workspace." then user says "Did Codex complete that work? Can you check?" -> route=coding_task, turnRelation=follow_up, operation=inspect, resolution=ready, codingBackend=codex, codingRunStatusCheck=true, resolvedContent should restate that this is a status check for the most recent Codex run related to that request.',
  'Example: "Why did Codex make that text file executable?" -> this is about Codex as the subject of the question, not a request to launch Codex. codingBackend may be set to codex, but codingBackendRequested=false and codingRunStatusCheck=false.',
  'Example: active pending action is approval for a Codex run, then the user says "Check my email." -> route=email_task, turnRelation=new_request, resolution should be based on the email request, and codingBackend should be unset.',
  'Example: active pending action is an email-provider clarification, then the user says "Use Codex to say hello and confirm you are working." -> route=coding_task, turnRelation=new_request, codingBackend=codex, codingBackendRequested=true.',
];

const INTENT_GATEWAY_SYSTEM_PROMPT = [
  'You are Guardian\'s intent gateway.',
  'Your job is to classify the top-level route for a user request and determine whether the current turn is a new request, a follow-up, a clarification answer, or a correction.',
  'Never plan, explain, or execute the request.',
  'You must call the route_intent tool exactly once.',
  ...INTENT_GATEWAY_INSTRUCTION_LINES,
].join(' ');

const INTENT_GATEWAY_JSON_FALLBACK_SYSTEM_PROMPT = [
  'You are Guardian\'s intent gateway.',
  'Classify the user request and return exactly one JSON object. Do not explain anything and do not call tools.',
  'Use only these exact route values: automation_authoring, automation_control, automation_output_task, ui_control, browser_task, personal_assistant_task, workspace_task, email_task, search_task, memory_task, filesystem_task, coding_task, coding_session_control, security_task, general_assistant, unknown.',
  'Use only these exact operation values: create, update, delete, run, toggle, clone, inspect, navigate, read, search, save, send, draft, schedule, unknown.',
  'Use only these exact turnRelation values: new_request, follow_up, clarification_answer, correction.',
  'Use only these exact resolution values: ready, needs_clarification.',
  'coding_session_control means current session, list sessions, switch or attach to another session, detach, or create a coding session.',
  'coding_task means code work inside a workspace, including explicit backend delegation such as Codex, Claude Code, Gemini CLI, or Aider, plus file-grounded repo inspection, code review, and implementation planning.',
  'memory_task means explicit remember, save, recall, or search memory requests.',
  'email_task means direct email inbox, read, send, reply, forward, or draft work in Gmail or Outlook. workspace_task means explicit provider CRUD or administration in Google Workspace or Microsoft 365 surfaces such as Drive, Docs, Sheets, direct Google Calendar or Outlook Calendar event edits, OneDrive, SharePoint, or Teams. personal_assistant_task means Second Brain work such as notes, tasks, calendar planning, meeting prep, people context, briefs, and personal retrieval across messages, docs, events, and notes.',
  'ui_control means Guardian pages or internal catalog surfaces. browser_task means external website navigation or interaction. search_task means generic web search.',
  'Guardian AI provider profile inventory, model catalogs, model routing policy, and AI provider configuration work are not personal_assistant_task. Prefer general_assistant with uiSurface="config" and provider/tool orchestration workload metadata for those requests.',
  'Generic planning or advice prompts such as "Give me a concise plan for organizing my week" are general_assistant, not personal_assistant_task, unless the user explicitly asks to inspect, summarize, or update their actual Second Brain tasks, notes, calendar, routines, or Today view.',
  'Prefer personal_assistant_task for meeting prep, follow-up drafting, calendar planning, outreach review, or personal search across email/docs/calendar/notes even when the data comes from Google Workspace or Microsoft 365.',
  'Prefer automation_authoring when the user explicitly asks to create an automation or workflow in the Automations system. Prefer personal_assistant_task when they explicitly ask for a Second Brain routine or mention starter routine concepts such as Morning Brief or Pre-Meeting Brief.',
  'Unqualified calendar entry, calendar event, or calendar item create/update/delete requests default to the local Second Brain calendar with personalItemType="calendar" and calendarTarget="local".',
  'Prefer workspace_task only when the user is explicitly targeting provider CRUD or provider administration such as Drive, Docs, Sheets, OneDrive, SharePoint, Teams, Google Calendar, Outlook Calendar, or other direct provider calendar event edits.',
  'Prefer email_task only for direct mailbox work, not for broader Second Brain synthesis.',
  'For rename requests on an existing automation, use route=automation_control, operation=update, and set newAutomationName to the requested new name.',
  'If the user explicitly asks to run a built-in tool by name, keep the request out of automation_control even if it uses verbs like run, check, inspect, or status.',
  'For edits to an existing automation such as changing its schedule or switching between scheduled and manual mode, use route=automation_control and operation=update.',
  'If the user names a coding session or workspace to switch to, set sessionTarget.',
  'If the user names Gmail or Google Workspace, set emailProvider to gws. If the user names Outlook or Microsoft 365, set emailProvider to m365.',
  'If the user names Google Calendar, set calendarTarget to gws. If the user names Outlook Calendar or Microsoft 365 calendar, set calendarTarget to m365. If the user is just talking about their calendar inside Guardian without naming a provider, set calendarTarget to local.',
  'For calendar reads like "today", "this week", or "next 7 days", set calendarWindowDays when the user gives a bounded day window explicitly or implicitly.',
  'If the user clearly refers to notes, tasks, calendar planning, routines, briefs, people, or the overall Today view, set personalItemType when possible.',
  'If the user names a cloud-hosting profile id such as profileId social or refers to a known hosting profile by id, set profileId when possible.',
  'If the user explicitly asks Guardian to use Codex, Claude Code, Gemini CLI, or Aider, set codingBackend and codingBackendRequested=true.',
  'If the request needs a missing detail before execution, set resolution=needs_clarification and include missingFields.',
  'Examples: "What coding workspace is this chat currently attached to?" -> route="coding_session_control", operation="inspect".',
  'Examples: "Inspect src/skills/prompt.ts and review the uplift for regressions." -> route="coding_task", operation="inspect".',
  'Examples: "List the coding sessions." -> route="coding_session_control", operation="navigate".',
  'Examples: "Run the cloud tool whm_status using profileId social." -> route="general_assistant", operation="run", toolName="whm_status", profileId="social".',
  'Examples: "List my configured AI providers." -> route="general_assistant", operation="read", uiSurface="config", executionClass="provider_crud", preferredTier="external", requiresRepoGrounding=false, requiresToolSynthesis=true, expectedContextPressure="medium", preferredAnswerPath="tool_loop".',
  'Examples: "Show the available models for my ollama-cloud-tools profile." -> route="general_assistant", operation="inspect", uiSurface="config", executionClass="provider_crud", preferredTier="external", requiresRepoGrounding=false, requiresToolSynthesis=true, expectedContextPressure="medium", preferredAnswerPath="tool_loop".',
  'Examples: "Give me a concise plan for organizing my week." -> route="general_assistant", operation="inspect", executionClass="direct_assistant", preferredTier="external", requiresRepoGrounding=false, requiresToolSynthesis=false, expectedContextPressure="low", preferredAnswerPath="direct".',
  'Examples: "Show my tasks." -> route="personal_assistant_task", operation="read", personalItemType="task".',
  'Examples: "Show my notes." -> route="personal_assistant_task", operation="read", personalItemType="note".',
  'Examples: "Show my library items." -> route="personal_assistant_task", operation="read", personalItemType="library".',
  'Examples: "Show my briefs." -> route="personal_assistant_task", operation="read", personalItemType="brief".',
  'Examples: "Show the people in my Second Brain." -> route="personal_assistant_task", operation="read", personalItemType="person".',
  'Examples: "Show my routines." -> route="personal_assistant_task", operation="read", personalItemType="routine".',
  'Examples: "Show only my enabled routines." -> route="personal_assistant_task", operation="read", personalItemType="routine", enabled=true.',
  'Examples: "Show only my disabled routines." -> route="personal_assistant_task", operation="read", personalItemType="routine", enabled=false.',
  'Examples: "What routines are related to email or inbox processing?" -> route="personal_assistant_task", operation="read", personalItemType="routine", query="email or inbox processing".',
  'Examples: "Show my calendar events for the next 7 days." -> route="personal_assistant_task", operation="read", personalItemType="calendar", calendarTarget="local", calendarWindowDays=7.',
  'Examples: follow-up "Show my tasks again." -> route="personal_assistant_task", operation="read", personalItemType="task".',
  'Examples: follow-up "Update that note to say: \\"Second Brain write smoke test note updated.\\"" -> route="personal_assistant_task", operation="update", personalItemType="note".',
  'Examples: follow-up "Delete that note." -> route="personal_assistant_task", operation="delete", personalItemType="note".',
  'Examples: "Create a brief called Second Brain brief smoke test that says This is a brief for smoke testing." -> route="personal_assistant_task", operation="create", personalItemType="brief".',
  'Examples: follow-up "Update that brief to say this is the updated brief." -> route="personal_assistant_task", operation="update", personalItemType="brief".',
  'Examples: follow-up "Delete that brief." -> route="personal_assistant_task", operation="delete", personalItemType="brief".',
  'Examples: "Create a person in my Second Brain named Smoke Test Person with email smoke@example.com." -> route="personal_assistant_task", operation="create", personalItemType="person".',
  'Examples: follow-up "Update that person to include email smoke@example.com." -> route="personal_assistant_task", operation="update", personalItemType="person".',
  'Examples: follow-up "Delete that person." -> route="personal_assistant_task", operation="delete", personalItemType="person".',
  'Examples: follow-up "Mark that task as done." -> route="personal_assistant_task", operation="update", personalItemType="task".',
  'Examples: follow-up "Move that event to tomorrow at 5 PM." -> route="personal_assistant_task", operation="update", personalItemType="calendar", calendarTarget="local".',
  'Examples: follow-up "Delete that calendar event." -> route="personal_assistant_task", operation="delete", personalItemType="calendar", calendarTarget="local".',
  'Examples: "What do I have due today?" -> route="personal_assistant_task", operation="inspect", personalItemType="overview".',
  'Examples: "Create the Pre-Meeting Brief routine in Second Brain." -> route="personal_assistant_task", operation="create", personalItemType="routine".',
  'Examples: "Create a calendar entry for tomorrow at 3 PM called Dentist." -> route="personal_assistant_task", operation="create", personalItemType="calendar", calendarTarget="local".',
  'Examples: "Prepare me for my next Outlook meeting using the calendar event, recent email, and docs." -> route="personal_assistant_task", operation="inspect", personalItemType="brief", emailProvider="m365".',
  'Examples: "Draft a follow-up email from my meeting notes and Gmail thread." -> route="personal_assistant_task", operation="draft", personalItemType="brief", emailProvider="gws".',
  'Examples: "Create an automation that checks WHM disk quota every day." -> route="automation_authoring", operation="create".',
  'Examples: "List the files in my Drive." -> route="workspace_task", operation="read".',
  'Examples: "Add this meeting to my Google Calendar." -> route="workspace_task", operation="create", calendarTarget="gws".',
  'Examples: "Delete the event from my Outlook calendar." -> route="workspace_task", operation="delete", calendarTarget="m365".',
  'Examples: "Update the SharePoint document for the launch checklist." -> route="workspace_task", operation="update".',
  'Examples: "Check my unread Outlook mail." -> route="email_task", operation="read", emailProvider="m365", mailboxReadMode="unread".',
  'Examples: "Show me the newest five emails in Gmail." -> route="email_task", operation="read", emailProvider="gws", mailboxReadMode="latest".',
  'Examples: "Switch this chat to the coding workspace for Temp install test." -> route="coding_session_control", operation="update", sessionTarget="Temp install test".',
  'Examples: "Search the repo for ollama_cloud and tell me which files define its routing." -> route="coding_task", operation="search", executionClass="repo_grounded", preferredTier="local", requiresRepoGrounding=true, requiresToolSynthesis=false, expectedContextPressure="medium", preferredAnswerPath="direct".',
  'Examples: "Inspect src/runtime/intent-gateway.ts and review the uplift for regressions." -> route="coding_task", operation="inspect", executionClass="repo_grounded", preferredTier="external", requiresRepoGrounding=true, requiresToolSynthesis=true, expectedContextPressure="high", preferredAnswerPath="chat_synthesis".',
  'Examples: "Check my unread Outlook mail." -> route="email_task", operation="read", executionClass="provider_crud", preferredTier="external", requiresRepoGrounding=false, requiresToolSynthesis=true, expectedContextPressure="medium", preferredAnswerPath="tool_loop", mailboxReadMode="unread".',
  'Examples: "What do I have due today?" -> route="personal_assistant_task", operation="inspect", executionClass="direct_assistant", preferredTier="local", requiresRepoGrounding=false, requiresToolSynthesis=false, expectedContextPressure="low", preferredAnswerPath="direct".',
  'Return valid JSON with double-quoted keys and string values only.',
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
    const primary = await this.classifyOnce(input, chat, {
      mode: 'primary',
      systemPrompt: INTENT_GATEWAY_SYSTEM_PROMPT,
      useTools: true,
      startedAt,
    });
    if (primary.available) {
      return this.repairAutomationNameIfNeeded(input, primary, chat);
    }

    const fallback = await this.classifyOnce(input, chat, {
      mode: 'json_fallback',
      systemPrompt: INTENT_GATEWAY_JSON_FALLBACK_SYSTEM_PROMPT,
      useTools: false,
      startedAt,
    });
    if (fallback.available || fallback.rawResponsePreview || fallback.model !== 'unknown') {
      return this.repairAutomationNameIfNeeded(input, fallback, chat);
    }
    return this.repairAutomationNameIfNeeded(input, primary, chat);
  }

  private async classifyOnce(
    input: IntentGatewayInput,
    chat: IntentGatewayChatFn,
    options: {
      mode: IntentGatewayRecord['mode'];
      systemPrompt: string;
      useTools: boolean;
      startedAt: number;
    },
  ): Promise<IntentGatewayRecord> {
    try {
      const response = await chat(buildIntentGatewayMessages(input, options.systemPrompt), {
        maxTokens: 220,
        temperature: 0,
        ...(options.useTools ? { tools: [INTENT_GATEWAY_TOOL] } : {}),
      });
      const parsed = parseIntentGatewayDecision(response, input.content);
      return {
        mode: options.mode,
        available: parsed.available,
        model: response.model,
        latencyMs: Date.now() - options.startedAt,
        decision: parsed.decision,
        rawResponsePreview: buildRawResponsePreview(response),
      };
    } catch (error) {
      return {
        mode: options.mode,
        available: false,
        model: 'unknown',
        latencyMs: Date.now() - options.startedAt,
        decision: {
          route: 'unknown',
          confidence: 'low',
          operation: 'unknown',
          summary: error instanceof Error ? error.message : String(error),
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          executionClass: 'direct_assistant',
          preferredTier: 'local',
          requiresRepoGrounding: false,
          requiresToolSynthesis: false,
          expectedContextPressure: 'low',
          preferredAnswerPath: 'direct',
          entities: {},
        },
      };
    }
  }

  private async repairAutomationNameIfNeeded(
    input: IntentGatewayInput,
    record: IntentGatewayRecord,
    chat: IntentGatewayChatFn,
  ): Promise<IntentGatewayRecord> {
    let decision = record.decision;
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
      ...record,
      decision,
    };
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
    executionClass: record.decision.executionClass,
    preferredTier: record.decision.preferredTier,
    requiresRepoGrounding: record.decision.requiresRepoGrounding,
    requiresToolSynthesis: record.decision.requiresToolSynthesis,
    expectedContextPressure: record.decision.expectedContextPressure,
    preferredAnswerPath: record.decision.preferredAnswerPath,
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
      executionClass: record.decision.executionClass,
      preferredTier: record.decision.preferredTier,
      requiresRepoGrounding: record.decision.requiresRepoGrounding,
      requiresToolSynthesis: record.decision.requiresToolSynthesis,
      expectedContextPressure: record.decision.expectedContextPressure,
      preferredAnswerPath: record.decision.preferredAnswerPath,
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

export function shouldReusePreRoutedIntentGateway(
  record: IntentGatewayRecord | null | undefined,
): record is IntentGatewayRecord {
  return !!record && record.available !== false;
}

function buildIntentGatewayMessages(input: IntentGatewayInput, systemPrompt: string): ChatMessage[] {
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
      content: systemPrompt,
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
  const historySection = Array.isArray(input.recentHistory) && input.recentHistory.length > 0
    ? input.recentHistory
      .slice(-6)
      .map((entry) => `${entry.role}: ${entry.content}`)
      .join('\n')
    : '';
  const continuitySection = input.continuity
    ? [
        input.continuity.focusSummary ? `Focus summary: ${input.continuity.focusSummary}` : '',
        input.continuity.lastActionableRequest ? `Last actionable request: ${input.continuity.lastActionableRequest}` : '',
      ].filter(Boolean).join('\n')
    : '';
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
        historySection ? `Recent history:\n${historySection}` : '',
        continuitySection,
        input.content.trim(),
      ].join('\n'),
    },
  ];
}

function parseIntentGatewayDecision(
  response: ChatResponse,
  sourceContent?: string,
): { decision: IntentGatewayDecision; available: boolean } {
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
        executionClass: 'direct_assistant',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'direct',
        entities: {},
      },
      available: false,
    };
  }
  const decision = normalizeIntentGatewayDecision(parsed, sourceContent);
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
  return parseStructuredJsonObject<Record<string, unknown>>(content);
}

function normalizeIntentGatewayDecision(
  parsed: Record<string, unknown>,
  sourceContent?: string,
): IntentGatewayDecision {
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
  const derivedWorkload = deriveWorkloadMetadata(route, operation, parsed);
  const executionClass = normalizeExecutionClass(parsed.executionClass) ?? derivedWorkload.executionClass;
  const preferredTier = normalizePreferredTier(parsed.preferredTier) ?? derivedWorkload.preferredTier;
  const requiresRepoGrounding = typeof parsed.requiresRepoGrounding === 'boolean'
    ? parsed.requiresRepoGrounding
    : derivedWorkload.requiresRepoGrounding;
  const requiresToolSynthesis = typeof parsed.requiresToolSynthesis === 'boolean'
    ? parsed.requiresToolSynthesis
    : derivedWorkload.requiresToolSynthesis;
  const expectedContextPressure = normalizeExpectedContextPressure(parsed.expectedContextPressure)
    ?? derivedWorkload.expectedContextPressure;
  const preferredAnswerPath = normalizePreferredAnswerPath(parsed.preferredAnswerPath)
    ?? derivedWorkload.preferredAnswerPath;

  const automationName = typeof parsed.automationName === 'string' && parsed.automationName.trim()
    ? parsed.automationName.trim()
    : undefined;
  const newAutomationName = typeof parsed.newAutomationName === 'string' && parsed.newAutomationName.trim()
    ? parsed.newAutomationName.trim()
    : undefined;
  const manualOnly = typeof parsed.manualOnly === 'boolean' ? parsed.manualOnly : undefined;
  const scheduled = typeof parsed.scheduled === 'boolean' ? parsed.scheduled : undefined;
  const personalItemType = normalizePersonalItemType(parsed.personalItemType)
    ?? inferRoutinePersonalItemType(sourceContent, route);
  const enabled = typeof parsed.enabled === 'boolean'
    ? parsed.enabled
    : inferRoutineEnabledFilter(sourceContent, route, operation, personalItemType);
  const uiSurface = normalizeUiSurface(parsed.uiSurface);
  const urls = Array.isArray(parsed.urls)
    ? parsed.urls
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    : undefined;
  const query = typeof parsed.query === 'string' && parsed.query.trim()
    ? parsed.query.trim()
    : inferRoutineQuery(sourceContent, route, operation, personalItemType);
  const path = typeof parsed.path === 'string' && parsed.path.trim()
    ? parsed.path.trim()
    : undefined;
  const sessionTarget = typeof parsed.sessionTarget === 'string' && parsed.sessionTarget.trim()
    ? parsed.sessionTarget.trim()
    : undefined;
  const emailProvider = normalizeEmailProvider(parsed.emailProvider);
  const mailboxReadMode = normalizeMailboxReadMode(parsed.mailboxReadMode);
  const calendarTarget = normalizeCalendarTarget(parsed.calendarTarget)
    ?? (route === 'personal_assistant_task' && personalItemType === 'calendar' ? 'local' : undefined);
  const calendarWindowDays = normalizeCalendarWindowDays((parsed as Record<string, unknown>).calendarWindowDays);
  const codingBackend = normalizeCodingBackend(parsed.codingBackend);
  const codingBackendRequested = typeof parsed.codingBackendRequested === 'boolean'
    ? parsed.codingBackendRequested
    : undefined;
  const codingRunStatusCheck = typeof parsed.codingRunStatusCheck === 'boolean'
    ? parsed.codingRunStatusCheck
    : undefined;
  const toolName = typeof parsed.toolName === 'string' && parsed.toolName.trim()
    ? parsed.toolName.trim()
    : undefined;
  const profileId = typeof parsed.profileId === 'string' && parsed.profileId.trim()
    ? parsed.profileId.trim()
    : undefined;

  return {
    route,
    confidence,
    operation,
    summary,
    turnRelation,
    resolution,
    missingFields,
    executionClass,
    preferredTier,
    requiresRepoGrounding,
    requiresToolSynthesis,
    expectedContextPressure,
    preferredAnswerPath,
    ...(resolvedContent ? { resolvedContent } : {}),
    entities: {
      ...(automationName ? { automationName } : {}),
      ...(newAutomationName ? { newAutomationName } : {}),
      ...(typeof manualOnly === 'boolean' ? { manualOnly } : {}),
      ...(typeof scheduled === 'boolean' ? { scheduled } : {}),
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(uiSurface ? { uiSurface } : {}),
      ...(urls && urls.length > 0 ? { urls } : {}),
      ...(query ? { query } : {}),
      ...(path ? { path } : {}),
      ...(sessionTarget ? { sessionTarget } : {}),
      ...(emailProvider ? { emailProvider } : {}),
      ...(mailboxReadMode ? { mailboxReadMode } : {}),
      ...(calendarTarget ? { calendarTarget } : {}),
      ...(typeof calendarWindowDays === 'number' ? { calendarWindowDays } : {}),
      ...(personalItemType ? { personalItemType } : {}),
      ...(codingBackend ? { codingBackend } : {}),
      ...(typeof codingBackendRequested === 'boolean' ? { codingBackendRequested } : {}),
      ...(typeof codingRunStatusCheck === 'boolean' ? { codingRunStatusCheck } : {}),
      ...(toolName ? { toolName } : {}),
      ...(profileId ? { profileId } : {}),
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
    return ['delete', 'toggle', 'run', 'inspect', 'clone', 'update'].includes(decision.operation);
  }
  return decision.route === 'ui_control'
    && decision.entities.uiSurface === 'automations'
    && ['delete', 'toggle', 'run', 'inspect', 'clone', 'update'].includes(decision.operation);
}

function normalizeExecutionClass(
  value: unknown,
): IntentGatewayExecutionClass | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'direct_assistant':
    case 'tool_orchestration':
    case 'repo_grounded':
    case 'provider_crud':
    case 'security_analysis':
      return normalized;
    default:
      return undefined;
  }
}

function normalizePreferredTier(
  value: unknown,
): IntentGatewayPreferredTier | undefined {
  switch (value) {
    case 'local':
    case 'external':
      return value;
    default:
      return undefined;
  }
}

function normalizeExpectedContextPressure(
  value: unknown,
): IntentGatewayExpectedContextPressure | undefined {
  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
      return value;
    default:
      return undefined;
  }
}

function normalizePreferredAnswerPath(
  value: unknown,
): IntentGatewayPreferredAnswerPath | undefined {
  switch (value) {
    case 'direct':
    case 'tool_loop':
    case 'chat_synthesis':
      return value;
    default:
      return undefined;
  }
}

function deriveWorkloadMetadata(
  route: IntentGatewayRoute,
  operation: IntentGatewayOperation,
  parsed: Record<string, unknown>,
): {
  executionClass: IntentGatewayExecutionClass;
  preferredTier: IntentGatewayPreferredTier;
  requiresRepoGrounding: boolean;
  requiresToolSynthesis: boolean;
  expectedContextPressure: IntentGatewayExpectedContextPressure;
  preferredAnswerPath: IntentGatewayPreferredAnswerPath;
} {
  const personalItemType = normalizePersonalItemType(parsed.personalItemType);
  const codingBackendRequested = parsed.codingBackendRequested === true;

  switch (route) {
    case 'coding_task':
      if (parsed.codingBackend || codingBackendRequested) {
        return {
          executionClass: 'repo_grounded',
          preferredTier: 'local',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'high',
          preferredAnswerPath: 'tool_loop',
        };
      }
      if (operation === 'search' || operation === 'read') {
        return {
          executionClass: 'repo_grounded',
          preferredTier: 'local',
          requiresRepoGrounding: true,
          requiresToolSynthesis: false,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'direct',
        };
      }
      if (operation === 'inspect') {
        return {
          executionClass: 'repo_grounded',
          preferredTier: 'external',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'high',
          preferredAnswerPath: 'chat_synthesis',
        };
      }
      return {
        executionClass: 'repo_grounded',
        preferredTier: 'local',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'tool_loop',
      };
    case 'filesystem_task':
      return {
        executionClass: 'repo_grounded',
        preferredTier: 'local',
        requiresRepoGrounding: true,
        requiresToolSynthesis: operation !== 'search' && operation !== 'read',
        expectedContextPressure: operation === 'search' ? 'low' : 'medium',
        preferredAnswerPath: operation === 'search' || operation === 'read' ? 'direct' : 'tool_loop',
      };
    case 'workspace_task':
    case 'email_task':
      return {
        executionClass: 'provider_crud',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: operation === 'draft' ? 'high' : 'medium',
        preferredAnswerPath: 'tool_loop',
      };
    case 'browser_task':
    case 'search_task':
      return {
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: route === 'search_task' && operation === 'search' ? 'medium' : 'medium',
        preferredAnswerPath: 'tool_loop',
      };
    case 'security_task':
      return {
        executionClass: 'security_analysis',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'chat_synthesis',
      };
    case 'automation_authoring':
    case 'automation_output_task':
      return {
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'chat_synthesis',
      };
    case 'automation_control':
      return {
        executionClass: 'tool_orchestration',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
      };
    case 'personal_assistant_task':
      return {
        executionClass: 'direct_assistant',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: ['create', 'update', 'delete', 'draft', 'send', 'schedule'].includes(operation),
        expectedContextPressure: personalItemType === 'brief' || operation === 'draft'
          ? 'high'
          : operation === 'inspect'
            ? 'low'
            : 'medium',
        preferredAnswerPath: ['read', 'inspect', 'search'].includes(operation) ? 'direct' : 'tool_loop',
      };
    case 'memory_task':
    case 'ui_control':
    case 'coding_session_control':
      return {
        executionClass: 'direct_assistant',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: ['create', 'update', 'delete'].includes(operation),
        expectedContextPressure: operation === 'inspect' || operation === 'read' || operation === 'navigate'
          ? 'low'
          : 'medium',
        preferredAnswerPath: ['inspect', 'read', 'navigate', 'search'].includes(operation) ? 'direct' : 'tool_loop',
      };
    case 'general_assistant':
    case 'unknown':
    default:
      return {
        executionClass: 'direct_assistant',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'direct',
      };
  }
}

function normalizeRoute(value: unknown): IntentGatewayRoute {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'automation_authoring':
    case 'automation_control':
    case 'automation_output_task':
    case 'ui_control':
    case 'browser_task':
    case 'personal_assistant_task':
    case 'workspace_task':
    case 'email_task':
    case 'search_task':
    case 'memory_task':
    case 'filesystem_task':
    case 'coding_task':
    case 'coding_session_control':
    case 'security_task':
    case 'general_assistant':
      return normalized;
    case 'automation_output':
      return 'automation_output_task';
    case 'ui':
    case 'ui_task':
      return 'ui_control';
    case 'browser':
      return 'browser_task';
    case 'personal_assistant':
    case 'personal_productivity':
    case 'second_brain':
    case 'assistant_productivity':
      return 'personal_assistant_task';
    case 'workspace':
      return 'workspace_task';
    case 'email':
    case 'mail':
      return 'email_task';
    case 'search':
    case 'web_search':
      return 'search_task';
    case 'memory':
      return 'memory_task';
    case 'filesystem':
    case 'file_system':
    case 'file':
      return 'filesystem_task';
    case 'coding':
      return 'coding_task';
    case 'coding_session':
    case 'code_session':
    case 'coding_workspace':
    case 'coding_workspace_session':
    case 'session_control':
    case 'session_management':
    case 'coding_session_management':
    case 'workspace_management':
    case 'coding_workspace_management':
    case 'coding_workspace_session_control':
    case 'coding_workspace_control':
    case 'workspace_session_control':
    case 'workspace_switch_control':
      return 'coding_session_control';
    case 'security':
      return 'security_task';
    case 'general':
    case 'assistant':
      return 'general_assistant';
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
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
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
    case 'save':
    case 'send':
    case 'draft':
    case 'schedule':
      return normalized;
    case 'list':
    case 'browse':
      return 'navigate';
    case 'show':
      return 'inspect';
    case 'current':
    case 'check':
    case 'status':
    case 'current_session':
    case 'current_workspace':
      return 'inspect';
    case 'switch':
    case 'attach':
    case 'change':
    case 'select':
    case 'switch_session':
    case 'switch_workspace':
    case 'attach_session':
    case 'attach_workspace':
    case 'change_workspace':
      return 'update';
    case 'detach':
    case 'disconnect':
    case 'remove':
    case 'detach_session':
    case 'detach_workspace':
      return 'delete';
    case 'execute':
    case 'start':
      return 'run';
    case 'copy':
    case 'duplicate':
      return 'clone';
    case 'recall':
      return 'read';
    case 'find':
      return 'search';
    case 'remember':
    case 'store':
      return 'save';
    case 'compose':
      return 'draft';
    case 'enable':
    case 'disable':
      return 'toggle';
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
    case 'system':
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

function normalizeMailboxReadMode(
  value: unknown,
): IntentGatewayEntities['mailboxReadMode'] | undefined {
  switch (value) {
    case 'unread':
    case 'latest':
      return value;
    default:
      return undefined;
  }
}

function normalizeCalendarTarget(
  value: unknown,
): IntentGatewayEntities['calendarTarget'] | undefined {
  switch (value) {
    case 'local':
    case 'gws':
    case 'm365':
      return value;
    default:
      return undefined;
  }
}

function normalizeCalendarWindowDays(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.trunc(value);
  if (normalized < 1 || normalized > 366) return undefined;
  return normalized;
}

function inferRoutineEnabledFilter(
  content: string | undefined,
  route: IntentGatewayRoute,
  operation: IntentGatewayOperation,
  personalItemType: IntentGatewayEntities['personalItemType'] | undefined,
): boolean | undefined {
  if (route !== 'personal_assistant_task' || operation !== 'read' || personalItemType !== 'routine') {
    return undefined;
  }
  const normalized = content?.trim().toLowerCase() ?? '';
  if (!normalized) return undefined;
  if (/\bdisabled routines?\b/.test(normalized) || /\bpaused routines?\b/.test(normalized)) {
    return false;
  }
  if (/\benabled routines?\b/.test(normalized) || /\bactive routines?\b/.test(normalized)) {
    return true;
  }
  return undefined;
}

function inferRoutinePersonalItemType(
  content: string | undefined,
  route: IntentGatewayRoute,
): IntentGatewayEntities['personalItemType'] | undefined {
  if (route !== 'personal_assistant_task') {
    return undefined;
  }
  const normalized = content?.trim().toLowerCase() ?? '';
  if (!normalized) return undefined;
  if (
    /\broutines?\b/.test(normalized)
    || /\bmorning brief\b/.test(normalized)
    || /\bpre[- ]meeting brief\b/.test(normalized)
    || /\bfollow[- ]up watch\b/.test(normalized)
    || /\bweekly review\b/.test(normalized)
    || /\bmanual sync\b/.test(normalized)
    || /\bnext 24 hours radar\b/.test(normalized)
  ) {
    return 'routine';
  }
  return undefined;
}

function inferRoutineQuery(
  content: string | undefined,
  route: IntentGatewayRoute,
  operation: IntentGatewayOperation,
  personalItemType: IntentGatewayEntities['personalItemType'] | undefined,
): string | undefined {
  if (route !== 'personal_assistant_task' || operation !== 'read' || personalItemType !== 'routine') {
    return undefined;
  }
  const normalized = content?.trim() ?? '';
  if (!normalized) return undefined;
  const relatedMatch = normalized.match(/\brelated\s+to\s+(.+?)(?:[.?!]|$)/i);
  return relatedMatch?.[1]?.trim() || undefined;
}

function normalizePersonalItemType(
  value: unknown,
): IntentGatewayEntities['personalItemType'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'overview':
    case 'note':
    case 'task':
    case 'calendar':
    case 'person':
    case 'library':
    case 'routine':
    case 'brief':
      return normalized;
    case 'today':
    case 'dashboard':
      return 'overview';
    default:
      return normalized === 'unknown' ? 'unknown' : undefined;
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
