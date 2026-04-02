import type { AssistantConnectorPlaybookDefinition, AssistantConnectorPlaybookStepDefinition } from '../config/types.js';
import type { AutomationIR, AutomationIRAgentBody, AutomationIRWorkflowBody } from './automation-ir.js';
import { repairAutomationIR } from './automation-ir-repair.js';
import { validateAutomationIR } from './automation-ir-validator.js';

export interface AutomationScheduleSpec {
  cron: string;
  runOnce: boolean;
  label: string;
  expectedRunsPerDay: number;
}

export interface CompiledAutomationTaskCreate {
  name: string;
  description: string;
  type: 'agent';
  target: 'default';
  prompt: string;
  channel: string;
  userId?: string;
  deliver: boolean;
  cron?: string;
  eventTrigger?: {
    eventType: string;
  };
  runOnce: boolean;
  enabled: true;
  maxRunsPerWindow: number;
  dailySpendCap: number;
  providerSpendCap: number;
}

export interface CompiledAutomationWorkflowUpsert extends AssistantConnectorPlaybookDefinition {
  enabled: true;
}

export interface AutomationAuthoringCompilation {
  intent: 'create';
  shape: AutomationAuthoringShape;
  name: string;
  id: string;
  description: string;
  ir: AutomationIR;
  schedule?: AutomationScheduleSpec;
  nativeOnly: boolean;
  forbidCodeArtifacts: boolean;
  taskCreate?: CompiledAutomationTaskCreate;
  workflowUpsert?: CompiledAutomationWorkflowUpsert;
}

export interface AutomationAuthoringDraftField {
  key: 'goal' | 'schedule' | 'workflow_steps';
  label: string;
  prompt: string;
}

export interface AutomationAuthoringDraft {
  intent: 'create';
  shape: AutomationAuthoringShape;
  name: string;
  id: string;
  description: string;
  schedule?: AutomationScheduleSpec;
  nativeOnly: boolean;
  forbidCodeArtifacts: boolean;
  builtInToolsOnly: boolean;
  missingFields: AutomationAuthoringDraftField[];
}

export type AutomationAuthoringOutcome =
  | {
      status: 'ready';
      compilation: AutomationAuthoringCompilation;
    }
  | {
      status: 'draft';
      draft: AutomationAuthoringDraft;
    };

export type AutomationAuthoringShape = 'scheduled_agent' | 'manual_agent' | 'workflow';

export interface AutomationAuthoringCompileOptions {
  channel?: string;
  userId?: string;
  now?: Date;
  assumeAuthoring?: boolean;
}

interface ParsedAutomationAuthoringContext {
  text: string;
  desiredShape: AutomationAuthoringShape;
  name: string;
  id: string;
  description: string;
  schedule: AutomationScheduleSpec | null;
  nativeOnly: boolean;
  forbidCodeArtifacts: boolean;
  builtInToolsOnly: boolean;
}

const AUTOMATION_INTENT_PATTERN = /\b(create|build|set up|setup|make|configure|schedule|automate|turn into|create this as)\b[\s\S]{0,120}\b(automation|workflow|playbook|pipeline|scheduled task|task)\b/i;
const SCHEDULE_SIGNAL_PATTERN = /\b(daily|every day|weekday|weekdays|every weekday|weekly|every monday|every tuesday|every wednesday|every thursday|every friday|every saturday|every sunday|every \d+ minutes?|hourly|every hour|tomorrow)\b/i;
const NATIVE_ONLY_PATTERN = /\b(guardian workflow|guardian scheduled task|workflow or scheduled task|scheduled task|built[- ]in (?:guardian )?tools only|native automation)\b/i;
const FORBID_CODE_PATTERN = /\b(not a shell script|not .*code file|do not create .*script|do not create .*code file|no shell script|no python script|using built[- ]in (?:guardian )?tools only)\b/i;
const MANUAL_ONLY_PATTERN = /\b(do not schedule(?: it| this)?(?: yet)?|don't schedule(?: it| this)?(?: yet)?|manual(?:ly)?(?: run)? only|run (?:it|this) manually|on demand only)\b/i;
const EXPLICIT_ASSISTANT_TASK_PATTERN = /\b(scheduled assistant task|assistant task|assistant automation|agent task|assistant turn)\b/i;
const EXPLICIT_WORKFLOW_PATTERN = /\b(workflow called|workflow named|workflow titled|playbook called|playbook named|playbook titled|create a sequential workflow|build a sequential workflow|create a parallel workflow|build a parallel workflow)\b/i;
const EXPLICIT_NON_ASSISTANT_WORKFLOW_PATTERN = /\b(do not create an assistant automation|don't create an assistant automation|not an assistant automation|do not create a scheduled assistant task|don't create a scheduled assistant task|step[- ]based workflow|deterministic scheduled automation|deterministic workflow|fixed tool steps)\b/i;
const NAMED_AUTOMATION_PATTERN = /\b(automation|workflow|playbook|scheduled assistant task|assistant automation|assistant task)\b[\s\S]{0,40}\b(called|named|titled)\b/i;
const OPEN_ENDED_PATTERNS = [
  /\b(research|enrich|score|classify|triage|monitor|summari[sz]e|draft|compare|diff|analy[sz]e|prioriti[sz]e|review)\b/i,
  /\b(inbox|gmail|email|calendar|alerts?|tickets?|publication|newsletter|linkedin|competitor)\b/i,
  /\b(csv|spreadsheet|report|summary|markdown|dashboard|workspace)\b/i,
  /\b(website|public presence|web search|web|online|recent stories|news|threat intel|public web)\b/i,
  /\b(approval before sending|asks? for approval|pauses? for approval|approve publication|before opening tickets)\b/i,
];
const EXPLICIT_WORKFLOW_PATTERNS = [
  /\bstep\s*\d+\b/i,
  /\b(automation_save|instruction step|delay step)\b/i,
  /\b(gws|gmail_draft|web_fetch|web_search|fs_read|fs_write|sys_resources|net_ping|net_port_check|memory_save|browser_navigate|browser_read|browser_links|browser_extract|browser_state|browser_act|browser_interact)\b/i,
  /\b(sequential|parallel)\b/i,
  /\bworkflow that first\b/i,
  /\bfirst\b[\s\S]{0,160}\bthen\b/i,
  /\bfixed (?:summari[sz]ation|analysis|classification|comparison|draft|transform|extraction) step\b/i,
];
const EXPLICIT_WORKFLOW_TOOL_NAMES = [
  'net_ping',
  'web_fetch',
  'net_port_check',
  'sys_resources',
  'gws',
  'gmail_draft',
  'browser_navigate',
  'browser_read',
  'browser_links',
  'browser_extract',
  'browser_state',
  'browser_act',
  'browser_interact',
];
const INSTRUCTION_VERB_PATTERNS: Array<{ pattern: RegExp; label: string; verb: string; present: string }> = [
  { pattern: /\bsummari[sz](?:e|es|ed|ing|ation)\b/i, label: 'Summarize', verb: 'summarize', present: 'summarizes' },
  { pattern: /\b(?:analy[sz](?:e|es|ed|ing)|analysis)\b/i, label: 'Analyze', verb: 'analyze', present: 'analyzes' },
  { pattern: /\bclassif(?:y|ies|ied|ication)\b/i, label: 'Classify', verb: 'classify', present: 'classifies' },
  { pattern: /\bcompar(?:e|es|ed|ing|ison)\b/i, label: 'Compare', verb: 'compare', present: 'compares' },
  { pattern: /\bextract(?:s|ed|ing|ion)?\b/i, label: 'Extract', verb: 'extract', present: 'extracts' },
  { pattern: /\bdraft(?:s|ed|ing)?\b/i, label: 'Draft', verb: 'draft', present: 'drafts' },
  { pattern: /\btransform(?:s|ed|ing|ation)?\b/i, label: 'Transform', verb: 'transform', present: 'transforms' },
];

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'at', 'before', 'build', 'by', 'create', 'daily',
  'for', 'from', 'if', 'in', 'into', 'make', 'of', 'on', 'set', 'setup',
  'that', 'the', 'then', 'this', 'to', 'up', 'using', 'weekday', 'weekly',
  'with', 'workflow', 'automation', 'scheduled', 'task', 'guardian',
]);

const WEEKDAY_TO_CRON: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 0,
};

export function compileAutomationAuthoringRequest(
  content: string,
  options?: AutomationAuthoringCompileOptions,
): AutomationAuthoringCompilation | null {
  const outcome = compileAutomationAuthoringOutcome(content, options);
  return outcome?.status === 'ready'
    ? outcome.compilation
    : null;
}

export function compileAutomationAuthoringOutcome(
  content: string,
  options?: AutomationAuthoringCompileOptions,
): AutomationAuthoringOutcome | null {
  const parsed = parseAutomationAuthoringContext(content, options);
  if (!parsed) return null;

  const compilation = buildAutomationAuthoringCompilation(parsed, options);
  if (compilation) {
    return {
      status: 'ready',
      compilation,
    };
  }

  return {
    status: 'draft',
    draft: buildAutomationAuthoringDraft(parsed),
  };
}

export function compileAutomationAuthoringIR(
  content: string,
  options?: AutomationAuthoringCompileOptions,
): AutomationIR | null {
  const parsed = parseAutomationAuthoringContext(content, options);
  if (!parsed) return null;
  return buildValidatedAutomationIR(parsed, options);
}

function isAutomationAuthoringIntent(text: string): boolean {
  if (AUTOMATION_INTENT_PATTERN.test(text)) return true;
  if (NAMED_AUTOMATION_PATTERN.test(text)) return true;
  return Boolean(SCHEDULE_SIGNAL_PATTERN.test(text) && /\b(automation|workflow|scheduled task|playbook|pipeline)\b/i.test(text));
}

export function isAutomationAuthoringRequest(content: string): boolean {
  const normalized = normalizeAutomationAuthoringText(content);
  if (!normalized) return false;
  return isAutomationAuthoringIntent(normalized);
}

function classifyAutomationShape(
  text: string,
  schedule: AutomationScheduleSpec | null,
): AutomationAuthoringShape {
  const explicitScheduledAssistantTask = /\bscheduled assistant task\b/i.test(text);
  const explicitNonAssistantWorkflow = EXPLICIT_NON_ASSISTANT_WORKFLOW_PATTERN.test(text);
  const explicitAssistantTask = EXPLICIT_ASSISTANT_TASK_PATTERN.test(text) && !explicitNonAssistantWorkflow;
  const openEndedSignals = OPEN_ENDED_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const explicitWorkflow = EXPLICIT_WORKFLOW_PATTERN.test(text) && !explicitAssistantTask && openEndedSignals === 0;
  const explicitWorkflowSignals = EXPLICIT_WORKFLOW_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const deterministicInstructionWorkflow = looksLikeDeterministicInstructionWorkflow(text);
  if (explicitScheduledAssistantTask) return 'scheduled_agent';
  if (explicitAssistantTask) return schedule ? 'scheduled_agent' : 'manual_agent';
  if (explicitNonAssistantWorkflow) return 'workflow';
  if (looksLikeBrowserWorkflow(text)) return 'workflow';
  if (deterministicInstructionWorkflow) return 'workflow';
  if (explicitWorkflowSignals >= 2) return 'workflow';
  if (openEndedSignals > 0) return schedule ? 'scheduled_agent' : 'manual_agent';
  if (MANUAL_ONLY_PATTERN.test(text)) return 'manual_agent';
  if (explicitWorkflow) return 'workflow';
  if (schedule) return 'scheduled_agent';
  return 'workflow';
}

function parseAutomationAuthoringContext(
  content: string,
  options?: AutomationAuthoringCompileOptions,
): ParsedAutomationAuthoringContext | null {
  const text = normalizeAutomationAuthoringText(content);
  if (!text) return null;
  if (!options?.assumeAuthoring && !isAutomationAuthoringIntent(text)) return null;

  const scheduleText = stripExplicitAutomationNameSegment(text);
  const schedule = parseAutomationSchedule(scheduleText, options?.now ?? new Date());
  const nativeOnly = NATIVE_ONLY_PATTERN.test(text);
  const forbidCodeArtifacts = FORBID_CODE_PATTERN.test(text);
  const builtInToolsOnly = /built[- ]in (?:guardian )?tools only/i.test(text);
  const desiredShape = classifyAutomationShape(text, schedule);
  const name = inferAutomationName(text, schedule);

  return {
    text,
    desiredShape,
    name,
    id: slugify(name),
    description: summarizeDescription(text),
    schedule,
    nativeOnly,
    forbidCodeArtifacts,
    builtInToolsOnly,
  };
}

function buildAutomationAuthoringCompilation(
  parsed: ParsedAutomationAuthoringContext,
  options?: AutomationAuthoringCompileOptions,
): AutomationAuthoringCompilation | null {
  const ir = buildValidatedAutomationIR(parsed, options);
  if (!ir) return null;

  if (parsed.desiredShape === 'workflow') {
    if (!ir.workflow) return null;
    const workflow = compileWorkflowFromIR(ir, ir.workflow);
    if (!workflow) return null;
    return {
      intent: 'create',
      shape: 'workflow',
      name: ir.name,
      id: ir.id,
      description: ir.description,
      ir,
      schedule: ir.schedule,
      nativeOnly: ir.constraints.nativeOnly,
      forbidCodeArtifacts: ir.constraints.forbidCodeArtifacts,
      workflowUpsert: workflow,
    };
  }

  if (!ir.agent) return null;
  const scheduledAgent = parsed.desiredShape === 'scheduled_agent';
  const requestedChannel = inferRequestedDeliveryChannel(parsed.text)
    || options?.channel?.trim()
    || ir.metadata.channel?.trim()
    || 'scheduled';
  const taskChannel = scheduledAgent
    ? normalizeScheduledAutomationChannel(requestedChannel)
    : requestedChannel;
  const taskCreate: CompiledAutomationTaskCreate = {
    name: ir.name,
    description: ir.description,
    type: 'agent',
    target: ir.agent.target,
    prompt: buildAssistantAutomationPrompt(
      ir.agent.operatorRequest,
      {
        nativeOnly: ir.constraints.nativeOnly,
        forbidCodeArtifacts: ir.constraints.forbidCodeArtifacts,
      },
      scheduledAgent ? 'scheduled' : 'manual',
    ),
    channel: taskChannel,
    userId: options?.userId?.trim() || ir.metadata.userId?.trim() || undefined,
    deliver: taskChannel !== 'scheduled',
    ...(scheduledAgent && ir.schedule
      ? {
          cron: ir.schedule.cron,
          runOnce: ir.schedule.runOnce,
        }
      : {
          eventTrigger: buildManualAutomationEventTrigger(ir.id),
          runOnce: false,
        }),
    enabled: true,
    maxRunsPerWindow: ir.schedule ? deriveMaxRunsPerWindow(ir.schedule) : 5,
    dailySpendCap: ir.schedule ? deriveDailySpendCap(ir.schedule) : 60_000,
    providerSpendCap: ir.schedule ? deriveProviderSpendCap(ir.schedule) : 36_000,
  };

  return {
    intent: 'create',
    shape: parsed.desiredShape,
    name: ir.name,
    id: ir.id,
    description: ir.description,
    ir,
    schedule: ir.schedule,
    nativeOnly: ir.constraints.nativeOnly,
    forbidCodeArtifacts: ir.constraints.forbidCodeArtifacts,
    taskCreate,
  };
}

function buildValidatedAutomationIR(
  parsed: ParsedAutomationAuthoringContext,
  options?: AutomationAuthoringCompileOptions,
): AutomationIR | null {
  const baseIr: AutomationIR = {
    version: 1,
    intent: 'create',
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    primitive: parsed.desiredShape === 'workflow' ? 'workflow' : 'agent',
    schedule: parsed.schedule ?? undefined,
    constraints: {
      nativeOnly: parsed.nativeOnly,
      forbidCodeArtifacts: parsed.forbidCodeArtifacts,
      builtInToolsOnly: parsed.builtInToolsOnly,
    },
    metadata: {
      sourceText: parsed.text,
      channel: options?.channel?.trim() || undefined,
      userId: options?.userId?.trim() || undefined,
    },
  };

  if (parsed.desiredShape === 'workflow') {
    const workflow = buildWorkflowBody(parsed.text);
    if (!workflow) return null;
    const repaired = repairAutomationIR({
      ...baseIr,
      primitive: 'workflow',
      workflow,
    });
    return validateAutomationIR(repaired).ok ? repaired : null;
  }

  if (parsed.desiredShape === 'scheduled_agent' && !parsed.schedule) {
    return null;
  }
  if (!hasMeaningfulAutomationGoal(parsed.text)) {
    return null;
  }

  const repaired = repairAutomationIR({
    ...baseIr,
    primitive: 'agent',
    schedule: parsed.desiredShape === 'scheduled_agent' ? parsed.schedule ?? undefined : undefined,
    agent: {
      target: 'default',
      operatorRequest: parsed.text,
    } satisfies AutomationIRAgentBody,
  });
  return validateAutomationIR(repaired).ok ? repaired : null;
}

function buildAutomationAuthoringDraft(
  parsed: ParsedAutomationAuthoringContext,
): AutomationAuthoringDraft {
  const missingFields: AutomationAuthoringDraftField[] = [];

  if (parsed.desiredShape === 'scheduled_agent' && !parsed.schedule) {
    missingFields.push({
      key: 'schedule',
      label: 'Schedule',
      prompt: 'Tell me when it should run, for example "every weekday at 7:30 AM" or "daily at 8:00 AM".',
    });
  }

  if (parsed.desiredShape === 'workflow') {
    if (!buildWorkflowBody(parsed.text)) {
      missingFields.push({
        key: 'workflow_steps',
        label: 'Deterministic steps',
        prompt: 'List the fixed tool steps or browser actions it should run in order. If the work is open-ended, say you want a manual assistant automation instead of a deterministic workflow.',
      });
    }
  } else if (!hasMeaningfulAutomationGoal(parsed.text)) {
    missingFields.push({
      key: 'goal',
      label: 'Automation goal',
      prompt: 'Tell me what the automation should actually do when it runs, including the inputs it should inspect and the output or artifact it should produce.',
    });
  }

  if (missingFields.length === 0) {
    missingFields.push({
      key: parsed.desiredShape === 'workflow' ? 'workflow_steps' : 'goal',
      label: parsed.desiredShape === 'workflow' ? 'Deterministic steps' : 'Automation goal',
      prompt: parsed.desiredShape === 'workflow'
        ? 'Describe the exact fixed steps the workflow should run.'
        : 'Describe what this automation should do when it runs.',
    });
  }

  return {
    intent: 'create',
    shape: parsed.desiredShape,
    name: parsed.name,
    id: parsed.id,
    description: parsed.description,
    schedule: parsed.schedule ?? undefined,
    nativeOnly: parsed.nativeOnly,
    forbidCodeArtifacts: parsed.forbidCodeArtifacts,
    builtInToolsOnly: parsed.builtInToolsOnly,
    missingFields,
  };
}

function buildWorkflowBody(text: string): AutomationIRWorkflowBody | null {
  const steps: AssistantConnectorPlaybookStepDefinition[] = [];
  const lower = text.toLowerCase();
  const browserWorkflow = buildBrowserWorkflow(text);
  if (browserWorkflow) return browserWorkflow;

  if (/\b(gws|gmail)\b/.test(lower) && /\binbox\b/.test(lower)) {
    steps.push({
      id: 'collect_inbox',
      name: 'Collect inbox items',
      type: 'tool',
      packId: '',
      toolName: 'gws',
      args: {
        service: 'gmail',
        resource: 'users messages',
        method: 'list',
        params: {
          userId: 'me',
          labelIds: ['INBOX'],
          q: 'is:important is:unread',
          maxResults: 10,
        },
      },
    });
    steps.push({
      id: 'summarize',
      name: 'Summarize actionable items',
      type: 'instruction',
      packId: '',
      toolName: '',
      instruction: [
        'Review the collected inbox messages.',
        'Summarize only actionable items.',
        'If replies are needed, draft concise reply text with recipient and subject suggestions.',
        'Do not send anything directly.',
      ].join(' '),
    });
  } else if (/\b(net_port_check|web_fetch|sys_resources|net_ping)\b/.test(lower)) {
    const toolNames = ['net_port_check', 'web_fetch', 'sys_resources', 'net_ping']
      .map((toolName) => ({ toolName, index: lower.indexOf(toolName) }))
      .filter((entry) => entry.index >= 0)
      .sort((left, right) => left.index - right.index)
      .map((entry) => entry.toolName);
    for (const [index, toolName] of toolNames.entries()) {
      steps.push({
        id: `step_${index + 1}`,
        name: `Run ${toolName}`,
        type: 'tool',
        packId: '',
        toolName,
        args: {},
      });
    }
  } else {
    const linkedWorkflow = buildDeterministicInstructionWorkflow(text);
    if (linkedWorkflow) return linkedWorkflow;
  }

  if (steps.length === 0) return null;

  return {
    mode: 'sequential',
    steps,
  };
}

function compileWorkflowFromIR(
  ir: AutomationIR,
  workflow: AutomationIRWorkflowBody,
): CompiledAutomationWorkflowUpsert | null {
  if (!workflow.steps.length) return null;
  return {
    id: ir.id,
    name: ir.name,
    enabled: true,
    mode: workflow.mode,
    description: ir.description,
    schedule: ir.schedule?.cron,
    steps: workflow.steps,
  };
}

function looksLikeBrowserWorkflow(text: string): boolean {
  const urls = extractExplicitUrls(text);
  if (urls.length === 0) return false;
  return [
    /\b(open|navigate|visit|load|go to)\b/i,
    /\b(read|page title|page content|current page|summari[sz]e)\b/i,
    /\blinks?\b/i,
    /\bextract\b/i,
    /\bstructured metadata\b/i,
    /\bsemantic (?:outline|tree)\b/i,
    /\binteractive elements?\b/i,
    /\binputs?\b/i,
    /\b(type|fill|click|select)\b/i,
  ].some((pattern) => pattern.test(text));
}

function buildBrowserWorkflow(text: string): AutomationIRWorkflowBody | null {
  if (!looksLikeBrowserWorkflow(text)) return null;

  const url = extractExplicitUrls(text)[0];
  if (!url) return null;

  const steps: AssistantConnectorPlaybookStepDefinition[] = [];
  const outputPaths = extractWritePaths(text);
  const needsMutation = /\b(type|types|typed|typing|fill|fills|filled|filling|click|clicks|clicked|clicking|select|selects|selected|selecting)\b/i.test(text);
  const wantsRead = /\b(read|page title|page content|current page|summari[sz]e)\b/i.test(text);
  const wantsLinks = /\b(list|show|extract|get)(?:s|ed|ing)?\b[\s\S]{0,48}\blinks?\b/i.test(text);
  const linkLimit = wantsLinks ? extractRequestedLinkLimit(text) : null;
  const wantsInteractiveList = /\b(list(?:s|ed|ing)?|show(?:s|ed|ing)?|inspect(?:s|ed|ing)?)\b[\s\S]{0,48}\b(interactive elements?|inputs?|form fields?|controls?)\b/i.test(text)
    || /\blist the inputs\b/i.test(text);
  const extractType = inferBrowserExtractType(text);

  steps.push({
    id: 'navigate',
    name: 'Open page',
    type: 'tool',
    packId: '',
    toolName: 'browser_navigate',
    args: {
      url,
      mode: needsMutation ? 'interactive' : 'read',
    },
  });

  if (wantsRead) {
    steps.push({
      id: 'read_page',
      name: 'Read page',
      type: 'tool',
      packId: '',
      toolName: 'browser_read',
      args: { url },
    });
  }

  if (wantsLinks) {
    steps.push({
      id: 'list_links',
      name: 'List page links',
      type: 'tool',
      packId: '',
      toolName: 'browser_links',
      args: {
        url,
        ...(linkLimit ? { maxItems: linkLimit } : {}),
      },
    });
  }

  if (extractType) {
    steps.push({
      id: 'extract_page',
      name: 'Extract page structure',
      type: 'tool',
      packId: '',
      toolName: 'browser_extract',
      args: {
        url,
        type: extractType,
      },
    });
  }

  const needsTargetSelection = needsMutation || wantsInteractiveList;
  if (needsTargetSelection) {
    steps.push({
      id: 'capture_state',
      name: 'Capture interactive state',
      type: 'tool',
      packId: '',
      toolName: 'browser_state',
      args: { url },
    });
  }

  const typeValue = extractBrowserQuotedValue(text, ['type', 'fill']);
  const clickLabel = extractBrowserClickLabel(text);
  const targetInstruction = buildBrowserTargetSelectionInstruction(text);

  if (targetInstruction && (typeValue || clickLabel)) {
    const action = typeValue ? 'type' : 'click';
    steps.push({
      id: 'select_target',
      name: 'Select target element',
      type: 'instruction',
      packId: '',
      toolName: '',
      instruction: targetInstruction,
    });
    steps.push({
      id: action === 'type' ? 'type_value' : 'click_target',
      name: action === 'type' ? 'Type value' : 'Click target',
      type: 'tool',
      packId: '',
      toolName: 'browser_act',
      args: {
        stateId: '${capture_state.output.stateId}',
        action,
        ref: '${select_target.output}',
        ...(typeValue ? { value: typeValue } : {}),
      },
    });
  }

  if (outputPaths.length === 1) {
    steps.push({
      id: 'compose_output',
      name: 'Compose requested artifact',
      type: 'instruction',
      packId: '',
      toolName: '',
      instruction: buildBrowserArtifactInstruction(text, outputPaths[0]),
    });
    steps.push({
      id: 'write_output',
      name: 'Write requested artifact',
      type: 'tool',
      packId: '',
      toolName: 'fs_write',
      args: {
        path: outputPaths[0],
        content: '${compose_output.output}',
      },
    });
  }

  if (steps.length <= 1) return null;
  return {
    mode: 'sequential',
    steps,
  };
}

function extractRequestedLinkLimit(text: string): number | null {
  const topMatch = text.match(/\b(?:top|first)\s+(\d+)\s+links?\b/i);
  if (!topMatch) return null;
  const parsed = Number.parseInt(topMatch[1], 10);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.min(parsed, 100);
}

function buildBrowserArtifactInstruction(text: string, outputPath: string): string {
  const formatHint = inferOutputFormatForPath(outputPath);
  return [
    'You are composing the final saved artifact for a browser automation.',
    'Use the prior browser step outputs as the source material.',
    'Fulfill the operator request exactly, including any requested limits such as "top 20 links".',
    `Return only the final ${formatHint} content to write to ${outputPath}.`,
    'Do not include any preamble, markdown fences, or explanation unless the requested file format itself requires it.',
    `Original operator request: ${text}`,
  ].join(' ');
}

function inferOutputFormatForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'JSON';
  if (lower.endsWith('.md')) return 'Markdown';
  if (lower.endsWith('.csv')) return 'CSV';
  if (lower.endsWith('.html')) return 'HTML';
  return 'text';
}

function inferBrowserExtractType(text: string): 'structured' | 'semantic' | 'both' | null {
  const wantsStructured = /\b(structured metadata|structured data|metadata|open graph|json-ld)\b/i.test(text);
  const wantsSemantic = /\b(semantic outline|semantic tree|outline|heading hierarchy|headings)\b/i.test(text);
  if (/\bextract\b/i.test(text) && wantsStructured && wantsSemantic) return 'both';
  if (/\bextract\b/i.test(text) && wantsStructured) return 'structured';
  if (/\bextract\b/i.test(text) && wantsSemantic) return 'semantic';
  return null;
}

function extractBrowserQuotedValue(text: string, verbs: string[]): string | null {
  const pattern = new RegExp(`\\b(?:${verbs.join('|')})(?:s|d|ing)?\\s+["'\`]([^"'\\\`]+)["'\`]`, 'i');
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
}

function extractBrowserClickLabel(text: string): string | null {
  const match = text.match(/\bclick\s+(?:the\s+)?["'`]([^"'`]+)["'`]/i);
  return match?.[1]?.trim() || null;
}

function buildBrowserTargetSelectionInstruction(text: string): string | null {
  if (/\bfirst\s+text\s+(?:field|input|textbox)\b/i.test(text)) {
    return [
      'Use the prior browser_state output.',
      'Return only the ref for the first text input or textbox element.',
      'Do not include any explanation, markdown, or extra text.',
    ].join(' ');
  }

  const fieldMatch = text.match(/\binto\s+the\s+([^.,\n\r]+?)\s+field\b/i);
  if (fieldMatch?.[1]?.trim()) {
    const label = fieldMatch[1].trim();
    return [
      'Use the prior browser_state output.',
      `Return only the ref for the element whose label, text, or description best matches "${label}".`,
      'Do not include any explanation, markdown, or extra text.',
    ].join(' ');
  }

  const clickLabel = extractBrowserClickLabel(text);
  if (clickLabel) {
    return [
      'Use the prior browser_state output.',
      `Return only the ref for the clickable element whose visible text best matches "${clickLabel}".`,
      'Do not include any explanation, markdown, or extra text.',
    ].join(' ');
  }

  return null;
}

function looksLikeDeterministicInstructionWorkflow(text: string): boolean {
  const lower = text.toLowerCase();
  if (!/\bworkflow\b/.test(lower)) return false;
  if (!/\b(first|then|step\s*\d+|instruction step|fixed)\b/.test(lower)) return false;
  if (!extractReadPath(text) || !extractWritePaths(text).length) return false;
  return getInstructionVerb(text) !== null;
}

function buildDeterministicInstructionWorkflow(text: string): AutomationIRWorkflowBody | null {
  const readPath = extractReadPath(text);
  const writePaths = extractWritePaths(text);
  const instructionVerb = getInstructionVerb(text);
  if (!readPath || writePaths.length !== 1 || !instructionVerb) return null;

  const outputPath = writePaths[0];
  const outputFile = basenamePath(outputPath);
  const steps: AssistantConnectorPlaybookStepDefinition[] = [
    {
      id: 'read_input',
      name: `Read ${basenamePath(readPath)}`,
      type: 'tool',
      packId: '',
      toolName: 'fs_read',
      args: {
        path: readPath,
      },
    },
    {
      id: `${instructionVerb.verb}_content`,
      name: `${instructionVerb.label} content`,
      type: 'instruction',
      packId: '',
      toolName: '',
      instruction: [
        `Using the prior step output, ${instructionVerb.verb} the content according to the operator request.`,
        `Produce output that can be written directly to ${outputFile}.`,
        `Operator request: ${normalizeAutomationAuthoringText(text)}`,
      ].join(' '),
    },
    {
      id: 'write_output',
      name: `Write ${outputFile}`,
      type: 'tool',
      packId: '',
      toolName: 'fs_write',
      args: {
        path: outputPath,
        content: `\${${instructionVerb.verb}_content.output}`,
      },
    },
  ];

  return {
    mode: 'sequential',
    steps,
  };
}

export function parseAutomationSchedule(text: string, now: Date): AutomationScheduleSpec | null {
  const everyMinutes = extractEveryMinutes(text);
  if (everyMinutes) {
    return {
      cron: everyMinutes === 1 ? '* * * * *' : `*/${everyMinutes} * * * *`,
      runOnce: false,
      label: everyMinutes === 1 ? 'Minutely' : `Every ${everyMinutes} Minutes`,
      expectedRunsPerDay: Math.max(1, Math.floor(1440 / everyMinutes)),
    };
  }

  if (/\b(hourly|every hour|each hour)\b/i.test(text)) {
    return {
      cron: '0 * * * *',
      runOnce: false,
      label: 'Hourly',
      expectedRunsPerDay: 24,
    };
  }

  const time = extractTime(text) ?? { hour: 9, minute: 0 };

  if (/\b(monday\s+to\s+friday|monday\s*-\s*friday|weekday|weekdays|every weekday)\b/i.test(text)) {
    return {
      cron: `${time.minute} ${time.hour} * * 1-5`,
      runOnce: false,
      label: 'Weekday',
      expectedRunsPerDay: 5,
    };
  }

  const dayMatch = text.match(/\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (dayMatch) {
    const day = dayMatch[1].toLowerCase();
    return {
      cron: `${time.minute} ${time.hour} * * ${WEEKDAY_TO_CRON[day]}`,
      runOnce: false,
      label: 'Weekly',
      expectedRunsPerDay: 1,
    };
  }

  if (/\b(weekly|every week)\b/i.test(text)) {
    return {
      cron: `${time.minute} ${time.hour} * * 1`,
      runOnce: false,
      label: 'Weekly',
      expectedRunsPerDay: 1,
    };
  }

  if (/\btomorrow\b/i.test(text)) {
    const target = new Date(now.getTime());
    target.setDate(target.getDate() + 1);
    return {
      cron: `${time.minute} ${time.hour} ${target.getDate()} ${target.getMonth() + 1} *`,
      runOnce: true,
      label: 'One Shot',
      expectedRunsPerDay: 1,
    };
  }

  if (/\b(daily|every day|each day|recurring)\b/i.test(text)) {
    return {
      cron: `${time.minute} ${time.hour} * * *`,
      runOnce: false,
      label: 'Daily',
      expectedRunsPerDay: 1,
    };
  }

  return null;
}

function buildAssistantAutomationPrompt(
  request: string,
  options: { nativeOnly: boolean; forbidCodeArtifacts: boolean },
  mode: 'scheduled' | 'manual',
): string {
  const lines = [
    mode === 'scheduled'
      ? 'You are executing a scheduled Guardian automation.'
      : 'You are executing a manual on-demand Guardian automation.',
    'Fulfill the operator request using Guardian built-in tools and managed providers.',
    'Prefer native tools over shell commands or generated scripts.',
  ];
  if (options.nativeOnly || options.forbidCodeArtifacts) {
    lines.push('Do not create shell scripts, Python scripts, or code files unless the request explicitly asks for source code as the output.');
  }
  lines.push('If a required input is missing at runtime, stop and report a clear error.');
  lines.push('If the request involves sending, posting, publishing, or other high-impact mutations, stage drafts or wait for approval rather than bypassing safeguards.');
  lines.push('Report what you inspected, what you created, and any blockers.');
  lines.push('');
  lines.push('Operator request:');
  lines.push(request.trim());
  return lines.join('\n');
}

function inferRequestedDeliveryChannel(text: string): string | null {
  if (/\b(do not send a notification|do not send any notification|do not send a message|no direct (?:message )?delivery|keep the results? in the automation run output only)\b/i.test(text)) {
    return 'scheduled';
  }
  if (/\b(?:web channel|guardian web channel|dashboard|web ui)\b/i.test(text)) {
    return 'web';
  }
  if (/\b(?:telegram|telegram channel)\b/i.test(text)) {
    return 'telegram';
  }
  if (/\b(?:cli|terminal channel|command line)\b/i.test(text)) {
    return 'cli';
  }
  return null;
}

function normalizeScheduledAutomationChannel(channel: string): string {
  const normalized = channel.trim().toLowerCase();
  if (!normalized) return 'scheduled';
  if (normalized === 'code-session') return 'web';
  if (normalized === 'web' || normalized === 'cli' || normalized === 'telegram' || normalized === 'scheduled') {
    return normalized;
  }
  return 'scheduled';
}

function inferAutomationName(text: string, schedule: AutomationScheduleSpec | null): string {
  const lower = text.toLowerCase();
  const schedulePrefix = schedule?.label === 'Daily'
    ? 'Daily '
    : schedule?.label === 'Weekday'
      ? 'Weekday '
      : schedule?.label === 'Weekly'
        ? 'Weekly '
        : '';
  const explicitName = extractExplicitAutomationName(text);
  if (explicitName) {
    return explicitName;
  }
  const deterministicWorkflow = inferDeterministicInstructionWorkflowMetadata(text);
  if (deterministicWorkflow?.name) {
    return `${schedulePrefix}${deterministicWorkflow.name}`.trim();
  }

  if (/\b(gmail|inbox)\b/.test(lower) || /\bhigh[- ]priority\s+email\b/.test(lower)) {
    return `${schedulePrefix}Gmail Inbox Review`.trim();
  }
  if (/\blead research\b/.test(lower) || (/\bcompany\b/.test(lower) && /\bicp\b/.test(lower))) {
    return `${schedulePrefix}Lead Research`.trim();
  }
  if (/\bincident triage\b/.test(lower) || /\bsecurity alerts?\b/.test(lower)) {
    return `${schedulePrefix}Incident Triage`.trim();
  }
  if (/\bcontent pipeline\b/.test(lower) || /\bnewsletter\b/.test(lower) || /\blinkedin post\b/.test(lower)) {
    return `${schedulePrefix}Content Pipeline`.trim();
  }
  if (/\bengineering hygiene\b/.test(lower)) {
    return `${schedulePrefix}Engineering Hygiene`.trim();
  }
  if (/\bcompetitor\b/.test(lower)) {
    return `${schedulePrefix}Competitor Tracking`.trim();
  }
  if (/\bsupport triage\b/.test(lower)) {
    return `${schedulePrefix}Support Triage`.trim();
  }
  const outputArtifactName = inferOutputArtifactName(text);
  if (outputArtifactName) {
    return `${schedulePrefix}${outputArtifactName}`.trim();
  }
  const mentionedTools = EXPLICIT_WORKFLOW_TOOL_NAMES.filter((toolName) => lower.includes(toolName));
  if (mentionedTools.length > 0) {
    const label = mentionedTools
      .slice(0, 3)
      .map((toolName) => toolName.split('_').map(toTitleCaseWord).join(' '))
      .join(' ');
    return `${schedulePrefix}${label} Workflow`.trim();
  }

  const words = text
    .replace(/[`"'.,:;!?()[\]{}]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0)
    .filter((word) => !STOP_WORDS.has(word.toLowerCase()))
    .slice(0, 4)
    .map(toTitleCaseWord);
  const fallback = words.join(' ').trim() || 'Automation';
  return `${schedulePrefix}${fallback}`.trim();
}

function summarizeDescription(text: string): string {
  const deterministicWorkflow = inferDeterministicInstructionWorkflowMetadata(text);
  if (deterministicWorkflow?.description) {
    return deterministicWorkflow.description;
  }
  const trimmed = normalizeAutomationAuthoringText(text).replace(/\s+/g, ' ');
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

function hasMeaningfulAutomationGoal(text: string): boolean {
  const signalText = stripExplicitAutomationNameSegment(text);
  if (extractExplicitUrls(signalText).length > 0) return true;
  if (extractReadPath(signalText)) return true;
  if (extractWritePaths(signalText).length > 0) return true;
  if (OPEN_ENDED_PATTERNS.some((pattern) => pattern.test(signalText))) return true;
  return /\b(check|collect|compare|draft|extract|inspect|list|monitor|open|prioriti[sz]e|read|reply|research|review|score|search|summari[sz]e|triage|visit|write)\b/i.test(signalText);
}

function extractExplicitAutomationName(text: string): string | null {
  const quotedMatch = text.match(/\b(?:called|named)\s+["'`]([^"'`]+)["'`]/i);
  if (quotedMatch?.[1]?.trim()) {
    return quotedMatch[1].trim();
  }

  const titleCaseMatch = text.match(/\b(?:called|named)\s+([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,7})\b/);
  if (titleCaseMatch?.[1]?.trim()) {
    return titleCaseMatch[1].trim();
  }

  return null;
}

function normalizeAutomationAuthoringText(text: string): string {
  return normalizePathLikeSegments(
    text
    .trim()
    .replace(/^(?:\s*\[Context:[^\]]+\]\s*)+/i, '')
    .replace(/(\.{1,2}[\\/])\s+/g, '$1')
    .replace(/([A-Za-z]:[\\/])\s+/g, '$1')
    .trim(),
  );
}

function stripExplicitAutomationNameSegment(text: string): string {
  return text
    .replace(/\b(?:called|named|titled)\s+["'`][^"'`]+["'`]/i, '')
    .replace(/\b(?:called|named|titled)\s+[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,7}\b/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractReadPath(text: string): string | null {
  const patterns = [
    /\b(?:read|reads|load|loads|open|opens)\s+(`[^`]+`|"[^"]+"|'[^']+'|\.[/\\][^"',;\n\r]+|[A-Za-z]:\\[^"',;\n\r]+)/i,
    /\b(?:from)\s+(`[^`]+`|"[^"]+"|'[^']+'|\.[/\\][^"',;\n\r]+|[A-Za-z]:\\[^"',;\n\r]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const path = normalizeExtractedPath(match?.[1] ?? null);
    if (path) return path;
  }
  return null;
}

function extractWritePaths(text: string): string[] {
  const matches = text.matchAll(
    /\b(?:write|writes|save|saves|create|creates|output|outputs)\b(?:\s+[^"'`\n\r]{0,80}?\s+to)?\s+(`[^`]+`|"[^"]+"|'[^']+'|\.[/\\][^"',;\n\r]+|[A-Za-z]:\\[^"',;\n\r]+)/gi,
  );
  const paths: string[] = [];
  for (const match of matches) {
    const path = normalizeExtractedPath(match[1] ?? null);
    if (path && !paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths;
}

function extractExplicitUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s"',;]+/gi)) {
    const value = match[0]?.trim();
    if (value) {
      urls.add(value.replace(/[.,;!?]+$/g, ''));
    }
  }
  return [...urls];
}

function normalizeExtractedPath(path: string | null): string | null {
  if (!path) return null;
  const trimmed = path.trim();
  const unquoted = trimmed.replace(/^["'`]|["'`]$/g, '');
  const normalized = unquoted
    .replace(/^(\.{1,2}[\\/])\s+/, '$1')
    .replace(/^([A-Za-z]:\\)\s+/, '$1')
    .replace(/\s+([\\/])/g, '$1')
    .replace(/([\\/])\s+/g, '$1')
    .replace(/([A-Za-z0-9._-])\s{2,}([A-Za-z0-9._-])/g, '$1$2')
    .replace(/(\.[A-Za-z0-9]+)\.\s+\b(?:use|using|with|before|after|and|then|plus)\b[\s\S]*$/i, '$1')
    .replace(/\s+\b(?:and|then|using|with|before|after|plus)\b[\s\S]*$/i, '')
    .replace(/[.,;!?]+$/g, '');
  if (!normalized) return null;
  const collapsed = /^[A-Za-z]:[\\/]/.test(normalized)
    ? normalized.replace(/[\\/]{2,}/g, '\\')
    : normalized;
  if (!collapsed.startsWith('./') && !/^[A-Za-z]:\\/.test(collapsed)) return null;
  return collapsed;
}

function getInstructionVerb(text: string): { label: string; verb: string; present: string } | null {
  for (const entry of INSTRUCTION_VERB_PATTERNS) {
    if (entry.pattern.test(text)) {
      return { label: entry.label, verb: entry.verb, present: entry.present };
    }
  }
  return null;
}

function basenamePath(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? path;
}

function inferDeterministicInstructionWorkflowMetadata(
  text: string,
): { name: string; description: string } | null {
  if (!looksLikeDeterministicInstructionWorkflow(text)) return null;
  const readPath = extractReadPath(text);
  const writePaths = extractWritePaths(text);
  const instructionVerb = getInstructionVerb(text);
  if (!readPath || writePaths.length !== 1 || !instructionVerb) return null;

  const writePath = writePaths[0];
  const sourceLabel = humanizePathLabel(readPath);
  const outputLabel = humanizePathLabel(writePath);
  const normalizedOutputLabel = outputLabel.toLowerCase();
  const genericOutputLabels = new Set(['summary', 'analysis', 'report', 'result', 'results', 'output', 'draft']);
  const preferredLabel = genericOutputLabels.has(normalizedOutputLabel)
    ? `${sourceLabel} ${instructionVerb.label}`
    : outputLabel;

  return {
    name: `${preferredLabel} Workflow`,
    description: `Reads ${readPath}, ${instructionVerb.present} the contents, and writes the result to ${writePath}.`,
  };
}

function humanizePathLabel(path: string): string {
  const base = basenamePath(path).replace(/\.[^.]+$/, '');
  const words = base
    .split(/[^a-zA-Z0-9]+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .map(toTitleCaseWord);
  return words.join(' ') || 'Workflow';
}

function inferOutputArtifactName(text: string): string | null {
  const writePaths = extractWritePaths(text);
  if (writePaths.length === 0) return null;
  const label = humanizePathLabel(writePaths[0]);
  if (!label || label === 'Workflow') return null;
  return label;
}

function normalizePathLikeSegments(text: string): string {
  return text.replace(
    /(?<![A-Za-z0-9])((?:\.{1,2}[\\/]|[A-Za-z]:[\\/])[^"',;\n\r]+)/g,
    (match) => {
      const { candidate, suffix } = splitPathLikeMatch(match);
      const normalized = normalizeExtractedPath(candidate);
      return normalized ? `${normalized}${suffix}` : match;
    },
  );
}

function splitPathLikeMatch(match: string): { candidate: string; suffix: string } {
  const boundaries = [
    /^(.*?\.[A-Za-z0-9]+)(\.\s+[A-Z][\s\S]*)$/,
    /^(.*?\.[A-Za-z0-9]+)(,\s+\b(?:and|then|using|with|before|after|plus|use|do|don't)\b[\s\S]*)$/i,
    /^(.*?\.[A-Za-z0-9]+)(\s+\b(?:and|then|using|with|before|after|plus)\b[\s\S]*)$/i,
  ];
  for (const pattern of boundaries) {
    const found = match.match(pattern);
    if (found) {
      return {
        candidate: found[1] ?? match,
        suffix: found[2] ?? '',
      };
    }
  }
  return { candidate: match, suffix: '' };
}

function deriveMaxRunsPerWindow(schedule: AutomationScheduleSpec): number {
  const expected = Math.max(1, schedule.expectedRunsPerDay);
  return Math.max(1, Math.ceil(expected * 1.1));
}

function deriveDailySpendCap(schedule: AutomationScheduleSpec): number {
  const expected = Math.max(1, schedule.expectedRunsPerDay);
  if (expected <= 1) return 40_000;
  if (expected <= 6) return 60_000;
  if (expected <= 24) return 90_000;
  return 120_000;
}

function deriveProviderSpendCap(schedule: AutomationScheduleSpec): number {
  return Math.max(20_000, Math.floor(deriveDailySpendCap(schedule) * 0.6));
}

function buildManualAutomationEventTrigger(id: string): { eventType: string } {
  return {
    eventType: `automation:manual:${id}`,
  };
}

function extractEveryMinutes(text: string): number | null {
  const digitMatch = text.match(/\bevery\s+(\d+)\s+minutes?\b/i);
  if (digitMatch) {
    const parsed = Number.parseInt(digitMatch[1], 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 59) return parsed;
  }
  if (/\bevery minute\b/i.test(text)) return 1;
  return null;
}

function extractTime(text: string): { hour: number; minute: number } | null {
  const twelveHour = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?\b/i);
  if (twelveHour) {
    const rawHour = Number.parseInt(twelveHour[1], 10);
    const minute = Number.parseInt(twelveHour[2] ?? '0', 10);
    if (!Number.isFinite(rawHour) || !Number.isFinite(minute) || rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) {
      return null;
    }
    let hour = rawHour % 12;
    if (twelveHour[3].toLowerCase() === 'p') hour += 12;
    return { hour, minute };
  }

  const twentyFourHour = text.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/i);
  if (twentyFourHour) {
    const hour = Number.parseInt(twentyFourHour[1], 10);
    const minute = Number.parseInt(twentyFourHour[2], 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }
    return { hour, minute };
  }

  return null;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'automation';
}

function toTitleCaseWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
