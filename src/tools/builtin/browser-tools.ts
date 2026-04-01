import type { BrowserConfig } from '../../config/types.js';
import type { HybridBrowserMode, HybridBrowserService } from '../browser-hybrid.js';
import { ToolRegistry } from '../registry.js';
import type { ToolExecutionRequest } from '../types.js';

const BROWSER_WRAPPER_NAMES = [
  'browser_capabilities',
  'browser_navigate',
  'browser_read',
  'browser_links',
  'browser_extract',
  'browser_state',
  'browser_act',
  'browser_interact',
] as const;

interface BrowserToolRegistrarContext {
  registry: ToolRegistry;
  hybridBrowser: HybridBrowserService | undefined;
  browserConfig: BrowserConfig | undefined;
  getHybridBrowserScopeKey: (request: Partial<ToolExecutionRequest>) => string;
  normalizeBrowserUrlArg: (toolName: string, value: unknown) => { url?: string; error?: string };
  normalizeHybridBrowserMode: (value: unknown) => HybridBrowserMode;
  asString: (value: unknown, fallback?: string) => string;
  guardAction: (request: ToolExecutionRequest, action: string, details: Record<string, unknown>) => void;
}

export function syncBuiltinBrowserTools(context: BrowserToolRegistrarContext): void {
  if (!context.hybridBrowser) return;

  if (context.browserConfig?.enabled === false) {
    for (const name of BROWSER_WRAPPER_NAMES) {
      context.registry.unregister(name);
    }
    return;
  }

  const capabilities = context.hybridBrowser.getCapabilities();
  const shouldExpose = new Set<string>(['browser_capabilities']);
  if (capabilities.wrappers.browserNavigate) shouldExpose.add('browser_navigate');
  if (capabilities.wrappers.browserRead) shouldExpose.add('browser_read');
  if (capabilities.wrappers.browserLinks) shouldExpose.add('browser_links');
  if (capabilities.wrappers.browserExtract) shouldExpose.add('browser_extract');
  if (capabilities.wrappers.browserState) shouldExpose.add('browser_state');
  if (capabilities.wrappers.browserAct) shouldExpose.add('browser_act');
  if (capabilities.wrappers.browserInteract) shouldExpose.add('browser_interact');

  for (const name of BROWSER_WRAPPER_NAMES) {
    if (!shouldExpose.has(name)) {
      context.registry.unregister(name);
    }
  }

  if (!context.registry.get('browser_capabilities')) {
    context.registry.register(
      {
        name: 'browser_capabilities',
        description: 'Report the currently connected Playwright browser backend capabilities and the current wrapper session state. Use this before browser work when you need to know whether navigation, snapshot reads, DOM extraction, and interactive actions are available.',
        shortDescription: 'Show browser backend availability and the current wrapper session state.',
        risk: 'read_only',
        category: 'browser',
        deferLoading: true,
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      async (_args, request) => {
        const scopeKey = context.getHybridBrowserScopeKey(request);
        return {
          success: true,
          output: {
            ...context.hybridBrowser!.getCapabilities(),
            session: context.hybridBrowser!.getSession(scopeKey),
          },
        };
      },
    );
  }

  if (capabilities.wrappers.browserNavigate && !context.registry.get('browser_navigate')) {
    context.registry.register(
      {
        name: 'browser_navigate',
        description: 'Navigate the Guardian browser wrapper to a URL through Playwright. Security: only http/https targets are allowed, private/internal hosts are blocked, and hostname checks use browser allowedDomains when configured.',
        shortDescription: 'Navigate the browser wrapper to a URL with read-first or interactive mode.',
        risk: 'network',
        category: 'browser',
        deferLoading: true,
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Target http or https URL.' },
            mode: { type: 'string', description: "Navigation lane: 'auto', 'read', or 'interactive'." },
          },
          required: ['url'],
        },
      },
      async (args, request) => {
        const validated = context.normalizeBrowserUrlArg('browser_navigate', args.url);
        if (validated.error) {
          return { success: false, error: validated.error };
        }
        context.guardAction(request, 'http_request', { url: validated.url });
        return context.hybridBrowser!.navigate(
          context.getHybridBrowserScopeKey(request),
          validated.url!,
          context.normalizeHybridBrowserMode(args.mode),
        );
      },
    );
  }

  if (capabilities.wrappers.browserRead && !context.registry.get('browser_read')) {
    context.registry.register(
      {
        name: 'browser_read',
        description: 'Read the current browser page through the Guardian wrapper using a Playwright accessibility snapshot. Optional url performs a navigate-first read.',
        shortDescription: 'Read the current browser page through a Playwright accessibility snapshot.',
        risk: 'read_only',
        category: 'browser',
        deferLoading: true,
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Optional target URL to navigate before reading.' },
            maxChars: { type: 'number', description: 'Maximum characters to return (default 12000).' },
          },
        },
      },
      async (args, request) => {
        const validated = context.normalizeBrowserUrlArg('browser_read', args.url);
        if (validated.error) {
          return { success: false, error: validated.error };
        }
        if (validated.url) {
          context.guardAction(request, 'http_request', { url: validated.url });
        }
        return context.hybridBrowser!.read(context.getHybridBrowserScopeKey(request), {
          ...(validated.url ? { url: validated.url } : {}),
          ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}),
        });
      },
    );
  }

  if (capabilities.wrappers.browserLinks && !context.registry.get('browser_links')) {
    context.registry.register(
      {
        name: 'browser_links',
        description: 'List structured page links through the Playwright-backed browser wrapper using a fixed DOM extraction. Optional url performs a navigate-first extraction. Supports simple text or href filtering.',
        shortDescription: 'List structured links from the current browser page.',
        risk: 'read_only',
        category: 'browser',
        deferLoading: true,
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Optional target URL to navigate before extracting links.' },
            filter: { type: 'string', description: 'Optional text or href filter.' },
            maxItems: { type: 'number', description: 'Maximum links to return (default 50).' },
          },
        },
      },
      async (args, request) => {
        const validated = context.normalizeBrowserUrlArg('browser_links', args.url);
        if (validated.error) {
          return { success: false, error: validated.error };
        }
        if (validated.url) {
          context.guardAction(request, 'http_request', { url: validated.url });
        }
        return context.hybridBrowser!.links(context.getHybridBrowserScopeKey(request), {
          ...(validated.url ? { url: validated.url } : {}),
          filter: context.asString(args.filter, '').trim() || undefined,
          ...(typeof args.maxItems === 'number' ? { maxItems: args.maxItems } : {}),
        });
      },
    );
  }

  if (capabilities.wrappers.browserExtract && !context.registry.get('browser_extract')) {
    context.registry.register(
      {
        name: 'browser_extract',
        description: 'Extract structured page data through the Playwright-backed browser wrapper. Structured metadata uses a fixed DOM extraction and semantic output uses the page snapshot outline. Optional url performs a navigate-first extraction.',
        shortDescription: 'Extract structured metadata or semantic tree output from the current page.',
        risk: 'read_only',
        category: 'browser',
        deferLoading: true,
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Optional target URL to navigate before extraction.' },
            type: { type: 'string', description: "Extraction type: 'structured', 'semantic', or 'both'." },
            maxChars: { type: 'number', description: 'Maximum semantic-tree characters to return (default 12000).' },
          },
        },
      },
      async (args, request) => {
        const validated = context.normalizeBrowserUrlArg('browser_extract', args.url);
        if (validated.error) {
          return { success: false, error: validated.error };
        }
        if (validated.url) {
          context.guardAction(request, 'http_request', { url: validated.url });
        }
        const type = context.asString(args.type, 'both').trim().toLowerCase();
        if (!['structured', 'semantic', 'both'].includes(type)) {
          return { success: false, error: `Unsupported browser_extract type '${type}'.` };
        }
        return context.hybridBrowser!.extract(context.getHybridBrowserScopeKey(request), {
          ...(validated.url ? { url: validated.url } : {}),
          type: type as 'structured' | 'semantic' | 'both',
          ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}),
        });
      },
    );
  }

  if (capabilities.wrappers.browserState && !context.registry.get('browser_state')) {
    context.registry.register(
      {
        name: 'browser_state',
        description: 'Capture the current interactive browser state through the Playwright lane. Returns a fresh stateId, indexed/stable element refs, and the current snapshot so later browser_act calls can mutate the page deterministically. Optional url performs a navigate-first state capture.',
        shortDescription: 'Capture Playwright-backed browser state with stable refs for later actions.',
        risk: 'read_only',
        category: 'browser',
        deferLoading: true,
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Optional target URL to navigate before capturing browser state.' },
            maxChars: { type: 'number', description: 'Maximum snapshot characters to return (default 12000).' },
          },
        },
      },
      async (args, request) => {
        const validated = context.normalizeBrowserUrlArg('browser_state', args.url);
        if (validated.error) {
          return { success: false, error: validated.error };
        }
        if (validated.url) {
          context.guardAction(request, 'http_request', { url: validated.url });
        }
        return context.hybridBrowser!.state(context.getHybridBrowserScopeKey(request), {
          ...(validated.url ? { url: validated.url } : {}),
          ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}),
        });
      },
    );
  }

  if (capabilities.wrappers.browserAct && !context.registry.get('browser_act')) {
    context.registry.register(
      {
        name: 'browser_act',
        description: 'Perform a Playwright-backed browser mutation using a fresh browser_state snapshot. Requires stateId plus a stable ref from the matching browser_state output. Supports click, type, fill, and select. This is the approval-aware mutation lane for browser automation.',
        shortDescription: 'Perform a Playwright browser action using stateId plus a stable ref.',
        risk: 'mutating',
        category: 'browser',
        deferLoading: true,
        parameters: {
          type: 'object',
          properties: {
            stateId: { type: 'string', description: 'Required state id returned by browser_state.' },
            action: { type: 'string', description: "Mutation action: 'click', 'type', 'fill', or 'select'." },
            ref: { type: 'string', description: 'Stable element ref from the matching browser_state output.' },
            value: { type: 'string', description: 'Input text or selected option value for type, fill, or select.' },
          },
          required: ['stateId', 'action', 'ref'],
        },
      },
      async (args, request) => {
        const action = context.asString(args.action, 'click').trim().toLowerCase();
        context.guardAction(request, 'mcp_tool', {
          toolName: 'browser_act',
          action,
          ref: context.asString(args.ref, '').trim(),
          stateId: context.asString(args.stateId, '').trim(),
        });
        return context.hybridBrowser!.act(context.getHybridBrowserScopeKey(request), {
          stateId: context.asString(args.stateId, '').trim() || undefined,
          action,
          ref: context.asString(args.ref, '').trim() || undefined,
          value: context.asString(args.value, ''),
        });
      },
    );
  }

  if (capabilities.wrappers.browserInteract && !context.registry.get('browser_interact')) {
    context.registry.register(
      {
        name: 'browser_interact',
        description: 'Compatibility wrapper for browser interaction. action=list captures Playwright-backed interactive targets and returns a stateId plus stable refs. Mutating actions are maintained for compatibility only and now require stateId plus ref (or element set to the exact ref) from browser_state output; free-form labels are no longer accepted.',
        shortDescription: 'Compatibility wrapper for browser_state listing and ref-based browser actions.',
        risk: 'mutating',
        category: 'browser',
        deferLoading: true,
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Optional target URL to navigate before listing or interacting.' },
            action: { type: 'string', description: "Interaction action: 'list', 'click', 'type', 'fill', or 'select'." },
            stateId: { type: 'string', description: 'Fresh browser state id returned by browser_state or browser_interact action=list.' },
            ref: { type: 'string', description: 'Stable element ref from browser_state output.' },
            element: { type: 'string', description: 'Compatibility alias for ref. Free-form labels are not accepted for mutating actions.' },
            value: { type: 'string', description: 'Input text or selected option value for type, fill, or select.' },
          },
        },
      },
      async (args, request) => {
        const validated = context.normalizeBrowserUrlArg('browser_interact', args.url);
        if (validated.error) {
          return { success: false, error: validated.error };
        }
        if (validated.url) {
          context.guardAction(request, 'http_request', { url: validated.url });
        }
        const action = context.asString(args.action, 'list').trim().toLowerCase();
        context.guardAction(request, 'mcp_tool', {
          toolName: 'browser_interact',
          action,
          stateId: context.asString(args.stateId, '').trim(),
          ref: context.asString(args.ref, '').trim(),
          element: context.asString(args.element, '').trim(),
          ...(validated.url ? { url: validated.url } : {}),
        });
        return context.hybridBrowser!.interact(context.getHybridBrowserScopeKey(request), {
          ...(validated.url ? { url: validated.url } : {}),
          action,
          stateId: context.asString(args.stateId, '').trim() || undefined,
          ref: context.asString(args.ref, '').trim() || undefined,
          element: context.asString(args.element, '').trim() || undefined,
          value: context.asString(args.value, ''),
        });
      },
    );
  }
}
