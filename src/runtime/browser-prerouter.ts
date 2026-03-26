import type { AgentContext, UserMessage } from '../agent/types.js';
import type { ToolExecutionRequest } from '../tools/types.js';
import type { IntentGatewayDecision } from './intent-gateway.js';

export interface BrowserPendingApprovalMetadata {
  id: string;
  toolName: string;
  argsPreview: string;
}

export interface BrowserPreRouteResult {
  content: string;
  metadata?: {
    pendingApprovals?: BrowserPendingApprovalMetadata[];
  };
}

type BrowserToolName =
  | 'browser_capabilities'
  | 'browser_navigate'
  | 'browser_read'
  | 'browser_links'
  | 'browser_extract'
  | 'browser_state'
  | 'browser_act';

interface BrowserPreRouteParams {
  agentId: string;
  message: UserMessage;
  checkAction?: AgentContext['checkAction'];
  executeTool: (
    toolName: BrowserToolName,
    args: Record<string, unknown>,
    request: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  ) => Promise<Record<string, unknown>>;
  trackPendingApproval?: (approvalId: string) => void;
  onPendingApproval?: (input: { approvalId: string; approved: string; denied: string }) => void;
  formatPendingApprovalPrompt?: (ids: string[]) => string;
  resolvePendingApprovalMetadata?: (ids: string[], fallback: BrowserPendingApprovalMetadata[]) => BrowserPendingApprovalMetadata[];
}

interface DirectBrowserTarget {
  ref: string;
  type: string;
  text: string;
}

type DirectBrowserIntent =
  | { kind: 'capabilities' }
  | { kind: 'navigate'; url: string }
  | { kind: 'read'; url?: string }
  | { kind: 'links'; url?: string }
  | { kind: 'extract'; url?: string; type: 'structured' | 'semantic' | 'both' }
  | { kind: 'state'; url?: string }
  | { kind: 'click'; url?: string; target: DirectBrowserTargetSelector }
  | { kind: 'type'; url?: string; value: string; target: DirectBrowserTargetSelector };

type DirectBrowserTargetSelector =
  | { kind: 'click_label'; value: string }
  | { kind: 'field_label'; value: string }
  | { kind: 'first_text_field' };

export async function tryBrowserPreRoute(
  params: BrowserPreRouteParams,
  options?: { intentDecision?: IntentGatewayDecision | null; allowHeuristicFallback?: boolean },
): Promise<BrowserPreRouteResult | null> {
  const gatewayBrowser = options?.intentDecision?.route === 'browser_task';
  if (!gatewayBrowser && options?.allowHeuristicFallback !== true) return null;
  const intent = parseDirectBrowserIntent(params.message.content);
  if (!intent) return null;
  if (isGoogleWorkspaceBrowserIntent(intent)) return null;

  const toolRequest: Omit<ToolExecutionRequest, 'toolName' | 'args'> = {
    origin: 'assistant',
    agentId: params.agentId,
    userId: params.message.userId,
    principalId: params.message.principalId,
    principalRole: params.message.principalRole,
    channel: params.message.channel,
    requestId: params.message.id,
    agentContext: params.checkAction ? { checkAction: params.checkAction } : undefined,
  };

  switch (intent.kind) {
    case 'capabilities':
      return formatDirectBrowserToolResult(
        await params.executeTool('browser_capabilities', {}, toolRequest),
        formatCapabilitiesContent,
      );
    case 'navigate':
      return formatDirectBrowserToolResult(
        await params.executeTool('browser_navigate', { url: intent.url }, toolRequest),
      );
    case 'read':
      return formatDirectBrowserToolResult(
        await params.executeTool('browser_read', intent.url ? { url: intent.url } : {}, toolRequest),
        formatReadContent,
      );
    case 'links':
      return formatDirectBrowserToolResult(
        await params.executeTool('browser_links', intent.url ? { url: intent.url } : {}, toolRequest),
        formatLinksContent,
      );
    case 'extract':
      return formatDirectBrowserToolResult(
        await params.executeTool(
          'browser_extract',
          {
            ...(intent.url ? { url: intent.url } : {}),
            type: intent.type,
          },
          toolRequest,
        ),
        formatExtractContent,
      );
    case 'state':
      return formatDirectBrowserToolResult(
        await params.executeTool('browser_state', intent.url ? { url: intent.url } : {}, toolRequest),
        formatStateContent,
      );
    case 'click':
      return executeDirectBrowserAction(params, toolRequest, intent, 'click');
    case 'type':
      return executeDirectBrowserAction(params, toolRequest, intent, 'type');
    default:
      return null;
  }
}

async function executeDirectBrowserAction(
  params: BrowserPreRouteParams,
  toolRequest: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  intent: Extract<DirectBrowserIntent, { kind: 'click' | 'type' }>,
  action: 'click' | 'type',
): Promise<BrowserPreRouteResult> {
  const typedValue = intent.kind === 'type' ? intent.value : '';
  const stateResult = await params.executeTool(
    'browser_state',
    intent.url ? { url: intent.url } : {},
    toolRequest,
  );
  const failedState = formatDirectBrowserToolResult(stateResult, formatStateContent);
  if (failedState && !toBoolean(stateResult.success)) {
    return failedState;
  }

  const state = extractBrowserState(stateResult.output);
  if (!state.stateId) {
    return {
      content: 'I could not capture a valid interactive browser state for that page.',
    };
  }

  const match = selectBrowserTarget(state.elements, intent.target);
  if (!match) {
    const label = describeTargetSelector(intent.target);
    const listed = state.elements
      .slice(0, 12)
      .map((element) => `- ${element.ref}: ${element.type}${element.text ? ` - ${element.text}` : ''}`)
      .join('\n');
    return {
      content: [
        `I captured the page state${state.url ? ` for ${state.url}` : ''}, but I could not find a target matching ${label}.`,
        listed ? `Available refs:\n${listed}` : 'The page state did not contain any interactive refs.',
      ].filter(Boolean).join('\n\n'),
    };
  }

  const actArgs: Record<string, unknown> = {
    stateId: state.stateId,
    action,
    ref: match.ref,
  };
  if (action === 'type') {
    actArgs.value = typedValue;
  }

  const actResult = await params.executeTool('browser_act', actArgs, toolRequest);
  if (toString(actResult.status) === 'pending_approval') {
    const approvalId = toString(actResult.approvalId);
    if (approvalId) {
      params.trackPendingApproval?.(approvalId);
      params.onPendingApproval?.({
        approvalId,
        approved: action === 'click'
          ? `I clicked '${match.text || match.ref}'.`
          : `I typed '${typedValue}' into '${match.text || match.ref}'.`,
        denied: action === 'click'
          ? `I did not click '${match.text || match.ref}'.`
          : `I did not type into '${match.text || match.ref}'.`,
      });
    }
    const fallback = approvalId
      ? [{
          id: approvalId,
          toolName: 'browser_act',
          argsPreview: JSON.stringify(actArgs).slice(0, 160),
        }]
      : [];
    const pendingApprovals = params.resolvePendingApprovalMetadata
      ? params.resolvePendingApprovalMetadata(approvalId ? [approvalId] : [], fallback)
      : fallback;
    const prompt = params.formatPendingApprovalPrompt
      ? params.formatPendingApprovalPrompt(approvalId ? [approvalId] : [])
      : 'This action needs approval before I can continue.';
    return {
      content: [
        `I located ref '${match.ref}' for ${describeTargetSelector(intent.target)}${state.url ? ` on ${state.url}` : ''} and prepared the ${action} action.`,
        prompt,
      ].filter(Boolean).join('\n\n'),
      metadata: pendingApprovals.length > 0 ? { pendingApprovals } : undefined,
    };
  }

  return formatDirectBrowserToolResult(actResult) ?? {
    content: action === 'click'
      ? `Clicked '${match.text || match.ref}'.`
      : `Typed into '${match.text || match.ref}'.`,
  };
}

function parseDirectBrowserIntent(content: string): DirectBrowserIntent | null {
  const normalized = content.trim();
  if (!normalized) return null;

  const urls = extractBrowserUrls(normalized);
  const url = urls[0];
  if (!url && isInternalDashboardPageReference(normalized)) {
    return null;
  }
  const hasPageContext = /\b(browser|page|current page|this page|website|web page|form)\b/i.test(normalized);
  const hasInteractiveContext = hasPageContext || /\b(link|links|button|input|field|interactive elements)\b/i.test(normalized);

  if (/\bcapabilities\b/i.test(normalized) && /\b(playwright|browser)\b/i.test(normalized)) {
    return { kind: 'capabilities' };
  }

  if (/\b(list|show)\b/i.test(normalized) && /\b(interactive elements|interactive refs|inputs?|buttons?|fields?|form controls?)\b/i.test(normalized)) {
    return { kind: 'state', ...(url ? { url } : {}) };
  }

  if (/\bclick\b/i.test(normalized)) {
    const clickLabel = extractBrowserClickLabel(normalized);
    if (clickLabel && (url || hasInteractiveContext)) {
      return {
        kind: 'click',
        ...(url ? { url } : {}),
        target: { kind: 'click_label', value: clickLabel },
      };
    }
  }

  if (/\b(?:type|fill)\b/i.test(normalized)) {
    const typedValue = extractBrowserQuotedValue(normalized, ['type', 'fill', 'enter']);
    const fieldLabel = extractBrowserFieldLabel(normalized);
    if (typedValue && fieldLabel && (url || hasInteractiveContext)) {
      return {
        kind: 'type',
        ...(url ? { url } : {}),
        value: typedValue,
        target: fieldLabel === '__first_text_field__'
          ? { kind: 'first_text_field' }
          : { kind: 'field_label', value: fieldLabel },
      };
    }
  }

  if (/\blinks?\b/i.test(normalized) && (url || hasPageContext)) {
    return { kind: 'links', ...(url ? { url } : {}) };
  }

  if ((url || hasPageContext) && /\bextract\b/i.test(normalized) && /\b(metadata|semantic|outline|structured|json-ld|open graph)\b/i.test(normalized)) {
    return { kind: 'extract', ...(url ? { url } : {}), type: inferBrowserExtractType(normalized) };
  }

  if ((url || /\b(current page|this page|page title|browser|website|web page)\b/i.test(normalized))
    && (/\bread\b|\bsummar(?:i|y|ize)\b/i.test(normalized) || /\bpage title\b/i.test(normalized))) {
    return { kind: 'read', ...(url ? { url } : {}) };
  }

  if (url && /\b(open|go\s+to|goto|navigate|visit|load)\b/i.test(normalized)) {
    return { kind: 'navigate', url };
  }

  return null;
}

function isInternalDashboardPageReference(text: string): boolean {
  return /\b(?:automations?|automation catalog|workflow(?:s)?|dashboard|config|security|network|operations|chat)\s+page\b/i.test(text)
    || /\bin\s+the\s+(?:automations?|automation catalog|workflow(?:s)?|dashboard|config|security|network|operations|chat)\s+page\b/i.test(text);
}

function isGoogleWorkspaceBrowserIntent(intent: DirectBrowserIntent): boolean {
  const url = 'url' in intent ? intent.url : undefined;
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return [
      'mail.google.com',
      'calendar.google.com',
      'drive.google.com',
      'docs.google.com',
      'meet.google.com',
    ].includes(host);
  } catch {
    return false;
  }
}

function extractBrowserUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s"',;]+/gi)) {
    const value = match[0]?.trim();
    if (value) {
      urls.add(value.replace(/[.,;!?]+$/g, ''));
    }
  }
  return [...urls];
}

function extractBrowserQuotedValue(text: string, verbs: string[]): string | null {
  const pattern = new RegExp(`\\b(?:${verbs.join('|')})(?:s|d|ing)?\\s+["'\`]([^"'\\\`]+)["'\`]`, 'i');
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
}

function extractBrowserClickLabel(text: string): string | null {
  const quoted = text.match(/\bclick\s+(?:the\s+)?["'`]([^"'`]+)["'`]/i);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  const plain = text.match(/\bclick\s+(?:the\s+)?([^.,\n\r]+?)(?:\s+link|\s+button|$)/i);
  return plain?.[1]?.trim() || null;
}

function extractBrowserFieldLabel(text: string): string | null {
  if (/\bfirst\s+text\s+(?:field|input|textbox)\b/i.test(text)) {
    return '__first_text_field__';
  }

  const quoted = text.match(/\b(?:into|in)\s+the\s+["'`]([^"'`]+)["'`]\s+(?:field|textbox|input)\b/i);
  if (quoted?.[1]?.trim()) return quoted[1].trim();

  const plain = text.match(/\b(?:into|in)\s+the\s+([^.,\n\r]+?)\s+(?:field|textbox|input)\b/i);
  return plain?.[1]?.trim() || null;
}

function inferBrowserExtractType(text: string): 'structured' | 'semantic' | 'both' {
  const wantsStructured = /\b(metadata|structured|json-ld|open graph)\b/i.test(text);
  const wantsSemantic = /\bsemantic|outline\b/i.test(text);
  if (wantsStructured && wantsSemantic) return 'both';
  if (wantsSemantic) return 'semantic';
  return 'structured';
}

function extractBrowserState(output: unknown): {
  stateId: string;
  url?: string;
  elements: DirectBrowserTarget[];
} {
  const structured = coerceBrowserStateRecord(output);
  const elements = Array.isArray(structured.elements)
    ? structured.elements
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => ({
        ref: toString(entry.ref),
        type: toString(entry.type),
        text: toString(entry.text),
      }))
      .filter((entry) => !!entry.ref)
    : [];
  return {
    stateId: toString(structured.stateId),
    url: toString(structured.url) || undefined,
    elements,
  };
}

function coerceBrowserStateRecord(output: unknown): Record<string, unknown> {
  if (typeof output === 'string') {
    try {
      return coerceBrowserStateRecord(JSON.parse(output));
    } catch {
      return {};
    }
  }
  if (!isRecord(output)) return {};

  if (typeof output.stateId === 'string' || Array.isArray(output.elements)) {
    return output;
  }

  const nestedKeys = ['output', 'result', 'data', 'state', 'payload'];
  for (const key of nestedKeys) {
    const nested = coerceBrowserStateRecord(output[key]);
    if (typeof nested.stateId === 'string' || Array.isArray(nested.elements)) {
      return nested;
    }
  }

  return output;
}

function selectBrowserTarget(
  elements: DirectBrowserTarget[],
  selector: DirectBrowserTargetSelector,
): DirectBrowserTarget | null {
  if (selector.kind === 'first_text_field') {
    return elements.find((element) => isTextEntryElement(element.type)) ?? null;
  }

  let best: { element: DirectBrowserTarget; score: number } | null = null;
  for (const element of elements) {
    const score = scoreBrowserTarget(element, selector);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { element, score };
    }
  }
  return best?.element ?? null;
}

function scoreBrowserTarget(
  element: DirectBrowserTarget,
  selector: Extract<DirectBrowserTargetSelector, { kind: 'click_label' | 'field_label' }>,
): number {
  const typeBonus = selector.kind === 'click_label'
    ? (isClickableElement(element.type) ? 15 : 0)
    : (isTextEntryElement(element.type) ? 15 : 0);
  const textScore = scoreTextMatch(element.text, selector.value);
  if (textScore > 0) return textScore + typeBonus;

  const fallbackScore = scoreTextMatch(`${element.type} ${element.text}`.trim(), selector.value);
  return fallbackScore > 0 ? fallbackScore + typeBonus : 0;
}

function scoreTextMatch(source: string, target: string): number {
  const normalizedSource = normalizeBrowserMatchText(source);
  const normalizedTarget = normalizeBrowserMatchText(target);
  if (!normalizedSource || !normalizedTarget) return 0;
  if (normalizedSource === normalizedTarget) return 100;
  if (normalizedSource.includes(normalizedTarget)) return 85;
  if (normalizedTarget.includes(normalizedSource)) return 70;

  const sourceTokens = new Set(normalizedSource.split(' '));
  const targetTokens = normalizedTarget.split(' ').filter(Boolean);
  const overlap = targetTokens.filter((token) => sourceTokens.has(token)).length;
  if (overlap === 0) return 0;
  if (overlap === targetTokens.length) return 75;
  return overlap * 18;
}

function normalizeBrowserMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(link|button|textbox|input|field|combobox)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isClickableElement(type: string): boolean {
  return /\b(link|button|tab|menuitem)\b/i.test(type);
}

function isTextEntryElement(type: string): boolean {
  return /\b(textbox|input|searchbox|textarea|combobox)\b/i.test(type);
}

function describeTargetSelector(selector: DirectBrowserTargetSelector): string {
  switch (selector.kind) {
    case 'click_label':
      return `"${selector.value}"`;
    case 'field_label':
      return `the "${selector.value}" field`;
    case 'first_text_field':
      return 'the first text field';
    default:
      return 'the requested element';
  }
}

function formatDirectBrowserToolResult(
  result: Record<string, unknown>,
  formatSuccess?: (result: Record<string, unknown>) => string | null,
): BrowserPreRouteResult | null {
  if (toBoolean(result.success)) {
    const formatted = formatSuccess?.(result);
    const content = formatted || toString(result.message) || 'Browser action completed.';
    return { content };
  }
  const missingWrapper = formatMissingBrowserWrapperMessage(toString(result.message));
  return {
    content: missingWrapper || toString(result.message) || 'Browser action failed.',
  };
}

function formatCapabilitiesContent(result: Record<string, unknown>): string | null {
  const output = coerceBrowserOutputRecord(result.output);
  if (!output) return toString(result.message) || null;
  const preferredRead = toString(output.preferredReadBackend) || 'none';
  const preferredInteraction = toString(output.preferredInteractionBackend) || 'none';
  const backendInfo = isRecord(output.backends) && isRecord(output.backends.playwright)
    ? output.backends.playwright
    : null;
  const unavailableReason = backendInfo ? toString(backendInfo.unavailableReason) : '';
  const details = unavailableReason && preferredRead === 'none' && preferredInteraction === 'none'
    ? ` Reason: ${unavailableReason}`
    : '';
  return `Browser capabilities: read=${preferredRead}, interact=${preferredInteraction}.${details}`;
}

function formatReadContent(result: Record<string, unknown>): string | null {
  const content = extractBrowserReadContent(result.output);
  const excerpt = content
    ? clipText(content, 800)
    : '';
  return [toString(result.message), excerpt].filter(Boolean).join('\n\n');
}

function formatLinksContent(result: Record<string, unknown>): string | null {
  const rawLinks = extractBrowserLinks(result.output);
  const links = rawLinks
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .slice(0, 20)
    .map((entry) => {
      const text = toString(entry.text).trim();
      const href = toString(entry.href).trim();
      if (!href) return '';
      return text && text !== href ? `- ${text} → ${href}` : `- ${href}`;
    })
    .filter(Boolean);
  const remaining = rawLinks.length - links.length;
  const suffix = remaining > 0 ? `\n...and ${remaining} more` : '';
  return [toString(result.message), links.join('\n') + suffix].filter(Boolean).join('\n\n');
}

function formatExtractContent(result: Record<string, unknown>): string | null {
  const output = coerceBrowserOutputRecord(result.output);
  if (!output) return toString(result.message) || null;
  const sections: string[] = [];
  if (output.structuredData !== undefined) {
    sections.push(`Structured data:\n${clipText(formatUnknown(output.structuredData), 800)}`);
  }
  if (output.semanticTree !== undefined) {
    sections.push(`Semantic tree:\n${clipText(formatUnknown(output.semanticTree), 800)}`);
  }
  return [toString(result.message), ...sections].filter(Boolean).join('\n\n');
}

function formatStateContent(result: Record<string, unknown>): string | null {
  const output = coerceBrowserStateRecord(result.output);
  if (!output) return toString(result.message) || null;
  const state = extractBrowserState(output);
  const lines = state.elements
    .slice(0, 12)
    .map((element) => `- ${element.ref}: ${element.type}${element.text ? ` - ${element.text}` : ''}`);
  return [
    toString(result.message),
    state.stateId ? `stateId: ${state.stateId}` : '',
    lines.join('\n'),
  ].filter(Boolean).join('\n\n');
}

function clipText(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars).trimEnd()}\n...[truncated]`;
}

function formatMissingBrowserWrapperMessage(message: string): string | null {
  const missingTool = message.match(/^Unknown tool '([^']+)'/);
  const toolName = missingTool?.[1]?.trim();
  if (toolName === 'browser_links' || toolName === 'browser_extract') {
    return `The ${toolName} wrapper is unavailable right now. That usually means the Playwright browser backend is not connected or the required snapshot/evaluate capability is missing. Run browser_capabilities to confirm backend availability.`;
  }
  return null;
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractBrowserReadContent(output: unknown): string {
  const normalized = coerceBrowserOutput(output);
  if (typeof normalized === 'string') return normalized;
  if (isRecord(normalized)) return toString(normalized.content);
  return '';
}

function extractBrowserLinks(output: unknown): unknown[] {
  const normalized = coerceBrowserOutput(output);
  if (Array.isArray(normalized)) return normalized;
  if (isRecord(normalized) && Array.isArray(normalized.links)) return normalized.links;
  return [];
}

function coerceBrowserOutputRecord(output: unknown): Record<string, unknown> | null {
  const normalized = coerceBrowserOutput(output);
  return isRecord(normalized) ? normalized : null;
}

function coerceBrowserOutput(output: unknown): unknown {
  if (typeof output === 'string') {
    try {
      return coerceBrowserOutput(JSON.parse(output));
    } catch {
      return output;
    }
  }

  if (Array.isArray(output)) {
    return output.map((entry) => coerceBrowserOutput(entry));
  }

  if (!isRecord(output)) return output;
  if (isStructuredBrowserOutput(output)) return output;

  const nestedKeys = ['output', 'result', 'data', 'payload', 'state'];
  for (const key of nestedKeys) {
    const nested = coerceBrowserOutput(output[key]);
    if (isStructuredBrowserOutput(nested)) {
      return nested;
    }
  }

  return output;
}

function isStructuredBrowserOutput(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (!isRecord(value)) return false;
  return [
    'backends',
    'content',
    'elements',
    'links',
    'preferredInteractionBackend',
    'preferredReadBackend',
    'semanticTree',
    'stateId',
    'structuredData',
  ].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}
