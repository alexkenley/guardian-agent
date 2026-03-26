import type { AgentContext, UserMessage } from '../agent/types.js';
import type { ToolExecutionRequest } from '../tools/types.js';
import type { IntentGatewayDecision } from './intent-gateway.js';
import {
  selectSavedAutomationCatalogEntry,
  type SavedAutomationCatalogEntry,
} from './automation-catalog.js';
import { extractAutomationListEntries } from './automation-tool-results.js';

type AutomationOutputToolName =
  | 'automation_list'
  | 'automation_output_search'
  | 'automation_output_read';

interface AutomationOutputPreRouteParams {
  agentId: string;
  message: UserMessage;
  checkAction?: AgentContext['checkAction'];
  executeTool: (
    toolName: AutomationOutputToolName,
    args: Record<string, unknown>,
    request: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  ) => Promise<Record<string, unknown>>;
}

export interface AutomationOutputPreRouteResult {
  content: string;
  metadata?: Record<string, unknown>;
}

interface AutomationOutputSearchMatch {
  runId: string;
  automationId: string;
  automationName: string;
  status: string;
  storedAt: number;
  preview: string;
  runLink: string;
  stepId?: string;
  toolName?: string;
}

interface AutomationOutputReadResult {
  runId: string;
  automationId: string;
  automationName: string;
  status: string;
  scope: 'run' | 'step';
  text: string;
  runLink: string;
  stepId?: string;
  toolName?: string;
  manifest?: {
    storeId: string;
    storedAt: number;
    stepCount: number;
    summary: string;
    steps: Array<{
      stepId: string;
      toolName: string;
      status: string;
      preview: string;
      contentChars: number;
    }>;
  };
}

export async function tryAutomationOutputPreRoute(
  params: AutomationOutputPreRouteParams,
  options?: { intentDecision?: IntentGatewayDecision | null },
): Promise<AutomationOutputPreRouteResult | null> {
  const decision = options?.intentDecision;
  if (!decision || decision.route !== 'automation_output_task') {
    return null;
  }

  const automationName = decision.entities.automationName?.trim();
  if (!automationName) {
    return {
      content: 'Tell me which saved automation run you want me to analyze.',
    };
  }

  const toolRequest = toolRequestFor(params);
  const catalogResult = await params.executeTool('automation_list', {}, toolRequest);
  const catalog = (extractAutomationListEntries(catalogResult.output ?? catalogResult) ?? []) as unknown as SavedAutomationCatalogEntry[];
  const selected = selectSavedAutomationCatalogEntry(catalog, automationName);
  if (!selected) {
    return {
      content: `I could not find a saved automation named '${automationName}'.`,
    };
  }

  const searchResult = await params.executeTool('automation_output_search', {
    automationId: selected.id,
    limit: 8,
  }, toolRequest);
  const primarySearchError = extractToolFailure(searchResult);
  let matches = extractAutomationOutputSearchMatches(searchResult.output ?? searchResult);
  let fallbackSearchError: string | null = null;
  if (matches.length === 0) {
    const fallbackSearch = await params.executeTool('automation_output_search', {
      query: selected.name,
      limit: 20,
    }, toolRequest);
    fallbackSearchError = extractToolFailure(fallbackSearch);
    matches = extractAutomationOutputSearchMatches(fallbackSearch.output ?? fallbackSearch)
      .filter((match) => normalizeLookupKey(match.automationName) === normalizeLookupKey(selected.name));
  }
  const runMatch = selectLatestRunMatch(matches);
  if (!runMatch) {
    const lookupError = fallbackSearchError || primarySearchError;
    if (lookupError) {
      return {
        content: `I could not inspect stored historical output for '${selected.name}': ${lookupError}`,
      };
    }
    return {
      content: `I could not find any stored historical output for '${selected.name}'. Run the automation first, or make sure "Store output for historical analysis" is enabled for it.`,
    };
  }

  const runReadResult = await params.executeTool('automation_output_read', {
    runId: runMatch.runId,
  }, toolRequest);
  const runReadError = extractToolFailure(runReadResult);
  const runRead = extractAutomationOutputReadResult(runReadResult.output ?? runReadResult);
  if (!runRead) {
    return {
      content: `I found stored output for '${selected.name}', but I could not read that run right now${runReadError ? `: ${runReadError}` : '.'}`,
    };
  }

  const detailedSteps = await readInterestingSteps(params, toolRequest, runRead);
  return {
    content: renderAutomationOutputAnalysis(selected, runMatch, runRead, detailedSteps),
    metadata: {
      storedAutomationOutput: {
        automationId: selected.id,
        automationName: selected.name,
        runId: runMatch.runId,
        runLink: runMatch.runLink,
      },
    },
  };
}

function toolRequestFor(
  params: AutomationOutputPreRouteParams,
): Omit<ToolExecutionRequest, 'toolName' | 'args'> {
  return {
    origin: 'assistant',
    agentId: params.agentId,
    userId: params.message.userId,
    principalId: params.message.principalId,
    principalRole: params.message.principalRole,
    channel: params.message.channel,
    requestId: params.message.id,
    agentContext: params.checkAction ? { checkAction: params.checkAction } : undefined,
  };
}

async function readInterestingSteps(
  params: AutomationOutputPreRouteParams,
  request: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  runRead: AutomationOutputReadResult,
): Promise<Array<{ stepId: string; toolName: string; text: string }>> {
  const manifestSteps = Array.isArray(runRead.manifest?.steps) ? runRead.manifest.steps : [];
  const prioritized = [...manifestSteps]
    .sort((left, right) => priorityForTool(right.toolName) - priorityForTool(left.toolName))
    .slice(0, 3);
  const detailed: Array<{ stepId: string; toolName: string; text: string }> = [];
  for (const step of prioritized) {
    const result = await params.executeTool('automation_output_read', {
      runId: runRead.runId,
      stepId: step.stepId,
      maxChars: 12000,
    }, request);
    const read = extractAutomationOutputReadResult(result.output ?? result);
    if (!read?.text) continue;
    detailed.push({
      stepId: step.stepId,
      toolName: step.toolName,
      text: read.text,
    });
  }
  return detailed;
}

function priorityForTool(toolName: string): number {
  switch (toolName) {
    case 'browser_extract':
      return 5;
    case 'browser_links':
      return 4;
    case 'browser_read':
      return 3;
    default:
      return 1;
  }
}

function renderAutomationOutputAnalysis(
  selected: SavedAutomationCatalogEntry,
  runMatch: AutomationOutputSearchMatch,
  runRead: AutomationOutputReadResult,
  detailedSteps: Array<{ stepId: string; toolName: string; text: string }>,
): string {
  const lines: string[] = [
    `I found the latest stored run for '${selected.name}'.`,
    `Status: ${runMatch.status || 'unknown'}`,
    `Stored: ${formatTimestamp(runMatch.storedAt)}`,
  ];

  if (runRead.manifest?.summary) {
    lines.push(`Summary: ${runRead.manifest.summary}`);
  }

  const findings = buildStepFindings(detailedSteps);
  if (findings.length > 0) {
    lines.push('');
    lines.push('What it found:');
    for (const finding of findings) {
      lines.push(finding);
    }
  } else if (Array.isArray(runRead.manifest?.steps) && runRead.manifest.steps.length > 0) {
    lines.push('');
    lines.push('Step highlights:');
    for (const step of runRead.manifest.steps.slice(0, 6)) {
      lines.push(`- ${step.toolName}: ${step.preview}`);
    }
  } else if (runMatch.preview) {
    lines.push('');
    lines.push(`Preview: ${runMatch.preview}`);
  }

  if (runMatch.runLink) {
    lines.push('');
    lines.push(`Run link: ${runMatch.runLink}`);
  }
  return lines.join('\n');
}

function buildStepFindings(
  steps: Array<{ stepId: string; toolName: string; text: string }>,
): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    const parsed = tryParseJson(step.text);
    if (step.toolName === 'browser_links') {
      const links = extractLinks(parsed).slice(0, 10);
      if (links.length > 0) {
        lines.push(`- ${step.toolName}: found ${links.length} highlighted link${links.length === 1 ? '' : 's'}:`);
        for (const link of links) {
          lines.push(`  ${link.text ? `${link.text} -> ` : ''}${link.href}`);
        }
        continue;
      }
    }
    if (step.toolName === 'browser_read') {
      const excerpt = extractContentExcerpt(parsed);
      if (excerpt) {
        lines.push(`- ${step.toolName}: ${excerpt}`);
        continue;
      }
    }
    if (step.toolName === 'browser_extract') {
      const preview = normalizeInline(step.text);
      if (preview) {
        lines.push(`- ${step.toolName}: ${truncate(preview, 400)}`);
        continue;
      }
    }
  }
  return lines;
}

function extractLinks(value: unknown): Array<{ text: string; href: string }> {
  const record = isRecord(value) ? value : null;
  const rawLinks = Array.isArray(record?.links) ? record.links : [];
  return rawLinks
    .filter(isRecord)
    .map((entry) => ({
      text: toString(entry.text).trim(),
      href: toString(entry.href).trim(),
    }))
    .filter((entry) => entry.href);
}

function extractContentExcerpt(value: unknown): string | null {
  const record = isRecord(value) ? value : null;
  const content = toString(record?.content).trim();
  if (!content) return null;
  const titleMatch = content.match(/Page Title:\s*(.+)/i);
  const headingMatch = content.match(/heading\s+"([^"]+)"/i);
  const paragraphMatch = content.match(/paragraph [^\n]*:\s*([^\n`]+)/i);
  const parts = [
    titleMatch?.[1]?.trim(),
    headingMatch?.[1]?.trim(),
    paragraphMatch?.[1]?.trim(),
  ].filter(Boolean);
  if (parts.length > 0) {
    return truncate(parts.join(' | '), 320);
  }
  return truncate(normalizeInline(content), 320);
}

function extractAutomationOutputSearchMatches(value: unknown): AutomationOutputSearchMatch[] {
  const payload = unwrapToolPayload(value);
  if (!isRecord(payload) || !Array.isArray(payload.results)) return [];
  return payload.results
    .filter(isRecord)
    .map((item) => ({
      runId: toString(item.runId),
      automationId: toString(item.automationId),
      automationName: toString(item.automationName),
      status: toString(item.status),
      storedAt: Number(item.storedAt) || 0,
      preview: toString(item.preview),
      runLink: toString(item.runLink),
      ...(toString(item.stepId) ? { stepId: toString(item.stepId) } : {}),
      ...(toString(item.toolName) ? { toolName: toString(item.toolName) } : {}),
    }))
    .filter((item) => item.runId);
}

function extractAutomationOutputReadResult(value: unknown): AutomationOutputReadResult | null {
  const payload = unwrapToolPayload(value);
  if (!isRecord(payload) || !toString(payload.runId)) return null;
  return {
    runId: toString(payload.runId),
    automationId: toString(payload.automationId),
    automationName: toString(payload.automationName),
    status: toString(payload.status),
    scope: toString(payload.scope) === 'step' ? 'step' : 'run',
    text: toString(payload.text),
    runLink: toString(payload.runLink),
    ...(toString(payload.stepId) ? { stepId: toString(payload.stepId) } : {}),
    ...(toString(payload.toolName) ? { toolName: toString(payload.toolName) } : {}),
    ...(isRecord(payload.manifest)
      ? {
          manifest: {
            storeId: toString(payload.manifest.storeId),
            storedAt: Number(payload.manifest.storedAt) || 0,
            stepCount: Number(payload.manifest.stepCount) || 0,
            summary: toString(payload.manifest.summary),
            steps: Array.isArray(payload.manifest.steps)
              ? payload.manifest.steps.filter(isRecord).map((step) => ({
                  stepId: toString(step.stepId),
                  toolName: toString(step.toolName),
                  status: toString(step.status),
                  preview: toString(step.preview),
                  contentChars: Number(step.contentChars) || 0,
                }))
              : [],
          },
        }
      : {}),
  };
}

function selectLatestRunMatch(matches: AutomationOutputSearchMatch[]): AutomationOutputSearchMatch | null {
  const runLevel = matches.filter((match) => !match.stepId);
  const source = runLevel.length > 0 ? runLevel : matches;
  return source.sort((left, right) => right.storedAt - left.storedAt)[0] ?? null;
}

function unwrapToolPayload(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  const structured = typeof value === 'string' ? tryParseJson(value) ?? value : value;
  if (!isRecord(structured)) return structured;
  if (Object.prototype.hasOwnProperty.call(structured, 'output')) {
    return unwrapToolPayload(structured.output, depth + 1);
  }
  if (Object.prototype.hasOwnProperty.call(structured, 'result')) {
    return unwrapToolPayload(structured.result, depth + 1);
  }
  return structured;
}

function extractToolFailure(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (value.success !== false) return null;
  const message = toString(value.message).trim();
  return message || 'The automation output tool returned an error.';
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return 'unknown';
  return new Date(value).toLocaleString('en-AU', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
