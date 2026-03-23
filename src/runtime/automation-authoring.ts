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
  cron: string;
  runOnce: boolean;
  enabled: true;
  maxRunsPerWindow: number;
  dailySpendCap: number;
  providerSpendCap: number;
}

export interface CompiledAutomationTaskUpdate extends Omit<CompiledAutomationTaskCreate, 'type' | 'target'> {
  taskId: string;
  type: 'agent';
  target: 'default';
}

export interface CompiledAutomationWorkflowUpsert extends AssistantConnectorPlaybookDefinition {
  enabled: true;
}

export interface AutomationAuthoringCompilation {
  intent: 'create';
  shape: 'scheduled_agent' | 'workflow';
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

export interface ExistingAutomationTask {
  id: string;
  name: string;
  type: string;
  target: string;
  cron: string;
  prompt?: string;
  channel?: string;
  userId?: string;
  deliver?: boolean;
}

const AUTOMATION_INTENT_PATTERN = /\b(create|build|set up|setup|make|configure|schedule|automate|turn into|create this as)\b[\s\S]{0,120}\b(automation|workflow|playbook|pipeline|scheduled task|task)\b/i;
const SCHEDULE_SIGNAL_PATTERN = /\b(daily|every day|weekday|weekdays|every weekday|weekly|every monday|every tuesday|every wednesday|every thursday|every friday|every saturday|every sunday|every \d+ minutes?|hourly|every hour|tomorrow)\b/i;
const NATIVE_ONLY_PATTERN = /\b(guardian workflow|guardian scheduled task|workflow or scheduled task|scheduled task|built[- ]in (?:guardian )?tools only|native automation)\b/i;
const FORBID_CODE_PATTERN = /\b(not a shell script|not .*code file|do not create .*script|do not create .*code file|no shell script|no python script|using built[- ]in (?:guardian )?tools only)\b/i;
const OPEN_ENDED_PATTERNS = [
  /\b(research|enrich|score|classify|triage|monitor|summari[sz]e|draft|compare|diff|analy[sz]e|prioriti[sz]e|review)\b/i,
  /\b(inbox|gmail|email|calendar|alerts?|tickets?|publication|newsletter|linkedin|competitor)\b/i,
  /\b(csv|spreadsheet|report|summary|markdown|dashboard|workspace)\b/i,
  /\b(website|public presence|web search|web|online|recent stories|news|threat intel|public web)\b/i,
  /\b(approval before sending|asks? for approval|pauses? for approval|approve publication|before opening tickets)\b/i,
];
const EXPLICIT_WORKFLOW_PATTERNS = [
  /\bstep\s*\d+\b/i,
  /\b(workflow_upsert|task_create|instruction step|delay step)\b/i,
  /\b(gws|gmail_draft|web_fetch|web_search|fs_read|fs_write|sys_resources|net_ping|net_port_check|memory_save|browser_navigate|browser_read|browser_links|browser_extract|browser_interact)\b/i,
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
  options?: { channel?: string; userId?: string; now?: Date },
): AutomationAuthoringCompilation | null {
  const ir = compileAutomationAuthoringIR(content, options);
  if (!ir) return null;

  const shape = ir.primitive === 'workflow' ? 'workflow' : 'scheduled_agent';
  if (shape === 'workflow' && !ir.workflow) return null;
  if (shape === 'scheduled_agent' && !ir.agent) return null;

  if (shape === 'workflow') {
    const workflow = compileWorkflowFromIR(ir, ir.workflow!);
    if (!workflow) return null;
    return {
      intent: 'create',
      shape,
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

  const taskCreate: CompiledAutomationTaskCreate = {
    name: ir.name,
    description: ir.description,
    type: 'agent',
    target: ir.agent!.target,
    prompt: buildScheduledAgentPrompt(ir.agent!.operatorRequest, {
      nativeOnly: ir.constraints.nativeOnly,
      forbidCodeArtifacts: ir.constraints.forbidCodeArtifacts,
    }),
    channel: options?.channel?.trim() || ir.metadata.channel?.trim() || 'scheduled',
    userId: options?.userId?.trim() || ir.metadata.userId?.trim() || undefined,
    deliver: (options?.channel?.trim() || ir.metadata.channel?.trim() || 'scheduled') !== 'scheduled',
    cron: ir.schedule!.cron,
    runOnce: ir.schedule!.runOnce,
    enabled: true,
    maxRunsPerWindow: deriveMaxRunsPerWindow(ir.schedule!),
    dailySpendCap: deriveDailySpendCap(ir.schedule!),
    providerSpendCap: deriveProviderSpendCap(ir.schedule!),
  };

  return {
    intent: 'create',
    shape,
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

export function compileAutomationAuthoringIR(
  content: string,
  options?: { channel?: string; userId?: string; now?: Date },
): AutomationIR | null {
  const text = normalizeAutomationAuthoringText(content);
  if (!text) return null;
  if (!isAutomationAuthoringIntent(text)) return null;

  const schedule = parseAutomationSchedule(text, options?.now ?? new Date());
  const nativeOnly = NATIVE_ONLY_PATTERN.test(text);
  const forbidCodeArtifacts = FORBID_CODE_PATTERN.test(text);
  const builtInToolsOnly = /built[- ]in (?:guardian )?tools only/i.test(text);
  const shape = classifyAutomationShape(text, schedule);

  if (shape === 'scheduled_agent' && !schedule) {
    return null;
  }

  const name = inferAutomationName(text, schedule);
  const id = slugify(name);
  const description = summarizeDescription(text);
  const baseIr: AutomationIR = {
    version: 1,
    intent: 'create',
    id,
    name,
    description,
    primitive: shape === 'workflow' ? 'workflow' : 'agent',
    schedule: schedule ?? undefined,
    constraints: {
      nativeOnly,
      forbidCodeArtifacts,
      builtInToolsOnly,
    },
    metadata: {
      sourceText: text,
      channel: options?.channel?.trim() || undefined,
      userId: options?.userId?.trim() || undefined,
    },
  };

  if (shape === 'workflow') {
    const workflow = buildWorkflowBody(text);
    if (!workflow) return null;
    const repaired = repairAutomationIR({
      ...baseIr,
      primitive: 'workflow',
      workflow,
    });
    return validateAutomationIR(repaired).ok ? repaired : null;
  }

  const repaired = repairAutomationIR({
    ...baseIr,
    primitive: 'agent',
    schedule: schedule!,
    agent: {
      target: 'default',
      operatorRequest: text,
    } satisfies AutomationIRAgentBody,
  });
  return validateAutomationIR(repaired).ok ? repaired : null;
}

export function buildTaskUpdateForCompiledAutomation(
  taskId: string,
  compilation: AutomationAuthoringCompilation,
  options?: { channel?: string; userId?: string },
): CompiledAutomationTaskUpdate | null {
  if (compilation.shape !== 'scheduled_agent' || !compilation.taskCreate) return null;
  return {
    taskId,
    ...compilation.taskCreate,
    channel: options?.channel?.trim() || compilation.taskCreate.channel,
    userId: options?.userId?.trim() || compilation.taskCreate.userId,
  };
}

export function findMatchingScheduledAutomationTask(
  tasks: ExistingAutomationTask[],
  compilation: AutomationAuthoringCompilation,
): ExistingAutomationTask | null {
  if (compilation.shape !== 'scheduled_agent' || !compilation.taskCreate) return null;
  const desired = compilation.taskCreate;
  const normalizedName = compilation.name.trim().toLowerCase();
  const candidates = tasks.filter((task) => (
    task.type === 'agent'
    && task.target === desired.target
    && task.name.trim().toLowerCase() === normalizedName
  ));
  if (candidates.length === 0) return null;
  const exact = candidates.find((task) => (
    task.cron === desired.cron
    && (task.channel ?? 'scheduled') === desired.channel
    && Boolean(task.deliver) === desired.deliver
  ));
  return exact ?? candidates[0] ?? null;
}

function isAutomationAuthoringIntent(text: string): boolean {
  if (AUTOMATION_INTENT_PATTERN.test(text)) return true;
  return Boolean(SCHEDULE_SIGNAL_PATTERN.test(text) && /\b(automation|workflow|scheduled task|playbook|pipeline)\b/i.test(text));
}

function classifyAutomationShape(
  text: string,
  schedule: AutomationScheduleSpec | null,
): 'scheduled_agent' | 'workflow' {
  const openEndedSignals = OPEN_ENDED_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const explicitWorkflowSignals = EXPLICIT_WORKFLOW_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const deterministicInstructionWorkflow = looksLikeDeterministicInstructionWorkflow(text);
  if (looksLikeBrowserWorkflow(text)) return 'workflow';
  if (deterministicInstructionWorkflow) return 'workflow';
  if (explicitWorkflowSignals >= 2) return 'workflow';
  if (openEndedSignals > 0) return 'scheduled_agent';
  if (schedule) return 'scheduled_agent';
  return 'workflow';
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
  const needsMutation = /\b(type|types|typed|typing|fill|fills|filled|filling|click|clicks|clicked|clicking|select|selects|selected|selecting)\b/i.test(text);
  const wantsRead = /\b(read|page title|page content|current page|summari[sz]e)\b/i.test(text);
  const wantsLinks = /\b(list|show|extract|get)\b[\s\S]{0,48}\blinks?\b/i.test(text);
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
      args: {},
    });
  }

  if (wantsLinks) {
    steps.push({
      id: 'list_links',
      name: 'List page links',
      type: 'tool',
      packId: '',
      toolName: 'browser_links',
      args: {},
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
        type: extractType,
      },
    });
  }

  const needsTargetSelection = needsMutation || wantsInteractiveList;
  if (needsTargetSelection) {
    steps.push({
      id: 'list_targets',
      name: 'List interactive targets',
      type: 'tool',
      packId: '',
      toolName: 'browser_interact',
      args: {
        action: 'list',
      },
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
      toolName: 'browser_interact',
      args: {
        action,
        element: '${select_target.output}',
        ...(typeValue ? { value: typeValue } : {}),
      },
    });
  }

  if (steps.length <= 1) return null;
  return {
    mode: 'sequential',
    steps,
  };
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
      'Use the prior browser_interact list output.',
      'Return only the ref for the first text input or textbox element.',
      'Do not include any explanation, markdown, or extra text.',
    ].join(' ');
  }

  const fieldMatch = text.match(/\binto\s+the\s+([^.,\n\r]+?)\s+field\b/i);
  if (fieldMatch?.[1]?.trim()) {
    const label = fieldMatch[1].trim();
    return [
      'Use the prior browser_interact list output.',
      `Return only the ref for the element whose label, text, or description best matches "${label}".`,
      'Do not include any explanation, markdown, or extra text.',
    ].join(' ');
  }

  const clickLabel = extractBrowserClickLabel(text);
  if (clickLabel) {
    return [
      'Use the prior browser_interact list output.',
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

function parseAutomationSchedule(text: string, now: Date): AutomationScheduleSpec | null {
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

  if (/\b(weekday|weekdays|every weekday)\b/i.test(text)) {
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

function buildScheduledAgentPrompt(
  request: string,
  options: { nativeOnly: boolean; forbidCodeArtifacts: boolean },
): string {
  const lines = [
    'You are executing a scheduled Guardian automation.',
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
    /\b(?:write|writes|save|saves|create|creates|output|outputs)\s+(?:a\s+summary\s+report\s+to\s+)?(`[^`]+`|"[^"]+"|'[^']+'|\.[/\\][^"',;\n\r]+|[A-Za-z]:\\[^"',;\n\r]+)/gi,
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
    (match) => normalizeExtractedPath(match) ?? match,
  );
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
