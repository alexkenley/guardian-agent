import { randomUUID } from 'node:crypto';
import type { MCPClientManager } from './mcp-client.js';
import type { ToolDefinition, ToolResult } from './types.js';

const PLAYWRIGHT_NAVIGATE_TOOL = 'mcp-playwright-browser_navigate';
const PLAYWRIGHT_SNAPSHOT_TOOL = 'mcp-playwright-browser_snapshot';
const PLAYWRIGHT_CLICK_TOOL = 'mcp-playwright-browser_click';
const PLAYWRIGHT_TYPE_TOOL = 'mcp-playwright-browser_type';
const PLAYWRIGHT_SELECT_TOOL = 'mcp-playwright-browser_select_option';

const LIGHTPANDA_GOTO_TOOL = 'mcp-lightpanda-goto';
const LIGHTPANDA_MARKDOWN_TOOL = 'mcp-lightpanda-markdown';
const LIGHTPANDA_LINKS_TOOL = 'mcp-lightpanda-links';
const LIGHTPANDA_STRUCTURED_DATA_TOOL = 'mcp-lightpanda-structuredData';
const LIGHTPANDA_SEMANTIC_TREE_TOOL = 'mcp-lightpanda-semantic_tree';
const LIGHTPANDA_INTERACTIVE_ELEMENTS_TOOL = 'mcp-lightpanda-interactiveElements';

export type HybridBrowserMode = 'auto' | 'read' | 'interactive';
export type HybridBrowserBackend = 'lightpanda' | 'playwright';

interface HybridBrowserSessionState {
  currentUrl?: string;
  pageTitle?: string;
  lastAction?: string;
  lastBackend?: HybridBrowserBackend;
  lastReadBackend?: HybridBrowserBackend;
  lastLightpandaUrl?: string;
  lastPlaywrightUrl?: string;
  latestPlaywrightStateId?: string;
  playwrightStateVersion: number;
  lastStrategy?: string;
  updatedAt: number;
}

export interface HybridBrowserTarget {
  ref: string;
  type: string;
  text: string;
}

interface HybridBrowserActionState {
  id: string;
  scopeKey: string;
  url: string;
  title?: string;
  snapshot: string;
  elements: HybridBrowserTarget[];
  version: number;
  createdAt: number;
}

export interface HybridBrowserCapabilities {
  available: boolean;
  preferredReadBackend: HybridBrowserBackend | null;
  preferredInteractionBackend: HybridBrowserBackend | null;
  backends: {
    playwright: {
      available: boolean;
      navigate: boolean;
      snapshot: boolean;
      interact: boolean;
    };
    lightpanda: {
      available: boolean;
      navigate: boolean;
      markdown: boolean;
      links: boolean;
      structuredData: boolean;
      semanticTree: boolean;
      interactiveElements: boolean;
    };
  };
  wrappers: {
    browserCapabilities: boolean;
    browserNavigate: boolean;
    browserRead: boolean;
    browserLinks: boolean;
    browserExtract: boolean;
    browserState: boolean;
    browserAct: boolean;
    browserInteract: boolean;
  };
}

export interface HybridBrowserSessionSnapshot {
  currentUrl?: string;
  pageTitle?: string;
  lastAction?: string;
  lastBackend?: HybridBrowserBackend;
  lastReadBackend?: HybridBrowserBackend;
  lastStrategy?: string;
  updatedAt: number;
}

export class HybridBrowserService {
  private readonly sessions = new Map<string, HybridBrowserSessionState>();
  private readonly actionStates = new Map<string, HybridBrowserActionState>();

  constructor(
    private readonly manager: MCPClientManager,
    private readonly now: () => number = Date.now,
  ) {}

  hasAnyBackend(): boolean {
    const capabilities = this.getCapabilities();
    return capabilities.available;
  }

  getCapabilities(): HybridBrowserCapabilities {
    const toolNames = this.getToolNames();
    const playwrightNavigate = toolNames.has(PLAYWRIGHT_NAVIGATE_TOOL);
    const playwrightSnapshot = toolNames.has(PLAYWRIGHT_SNAPSHOT_TOOL);
    const playwrightInteract = toolNames.has(PLAYWRIGHT_CLICK_TOOL)
      || toolNames.has(PLAYWRIGHT_TYPE_TOOL)
      || toolNames.has(PLAYWRIGHT_SELECT_TOOL);
    const lightpandaNavigate = toolNames.has(LIGHTPANDA_GOTO_TOOL);
    const lightpandaMarkdown = toolNames.has(LIGHTPANDA_MARKDOWN_TOOL);
    const lightpandaLinks = toolNames.has(LIGHTPANDA_LINKS_TOOL);
    const lightpandaStructuredData = toolNames.has(LIGHTPANDA_STRUCTURED_DATA_TOOL);
    const lightpandaSemanticTree = toolNames.has(LIGHTPANDA_SEMANTIC_TREE_TOOL);
    const lightpandaInteractiveElements = toolNames.has(LIGHTPANDA_INTERACTIVE_ELEMENTS_TOOL);

    const preferredReadBackend = lightpandaNavigate && lightpandaMarkdown
      ? 'lightpanda'
      : (playwrightNavigate && playwrightSnapshot ? 'playwright' : null);
    const preferredInteractionBackend = playwrightNavigate && playwrightInteract
      ? 'playwright'
      : null;

    return {
      available: !!(preferredReadBackend || preferredInteractionBackend),
      preferredReadBackend,
      preferredInteractionBackend,
      backends: {
        playwright: {
          available: playwrightNavigate || playwrightSnapshot || playwrightInteract,
          navigate: playwrightNavigate,
          snapshot: playwrightSnapshot,
          interact: playwrightInteract,
        },
        lightpanda: {
          available: lightpandaNavigate || lightpandaMarkdown || lightpandaLinks || lightpandaStructuredData || lightpandaSemanticTree || lightpandaInteractiveElements,
          navigate: lightpandaNavigate,
          markdown: lightpandaMarkdown,
          links: lightpandaLinks,
          structuredData: lightpandaStructuredData,
          semanticTree: lightpandaSemanticTree,
          interactiveElements: lightpandaInteractiveElements,
        },
      },
      wrappers: {
        browserCapabilities: true,
        browserNavigate: lightpandaNavigate || playwrightNavigate,
        browserRead: (lightpandaNavigate && lightpandaMarkdown) || (playwrightNavigate && playwrightSnapshot),
        browserLinks: lightpandaNavigate && lightpandaLinks,
        browserExtract: lightpandaNavigate && (lightpandaStructuredData || lightpandaSemanticTree),
        browserState: playwrightNavigate && playwrightSnapshot,
        browserAct: playwrightNavigate && playwrightInteract,
        browserInteract: (playwrightNavigate && playwrightSnapshot) || (playwrightNavigate && playwrightInteract),
      },
    };
  }

  getSession(scopeKey: string): HybridBrowserSessionSnapshot | null {
    const session = this.sessions.get(scopeKey);
    if (!session) return null;
    return {
      currentUrl: session.currentUrl,
      pageTitle: session.pageTitle,
      lastAction: session.lastAction,
      lastBackend: session.lastBackend,
      lastReadBackend: session.lastReadBackend,
      lastStrategy: session.lastStrategy,
      updatedAt: session.updatedAt,
    };
  }

  async state(
    scopeKey: string,
    input: { url?: string; maxChars?: number },
  ): Promise<ToolResult> {
    const capabilities = this.getCapabilities();
    if (!(capabilities.backends.playwright.navigate && capabilities.backends.playwright.snapshot)) {
      return { success: false, error: 'Interactive browser state requires the Playwright backend.' };
    }

    const targetUrl = normalizeBrowserUrl(input.url);
    if (targetUrl) {
      const navigation = await this.navigate(scopeKey, targetUrl, 'interactive');
      if (!navigation.success) return navigation;
    }

    const session = this.sessions.get(scopeKey);
    const currentUrl = session?.currentUrl;
    if (!currentUrl) {
      return { success: false, error: 'No active browser page. Call browser_navigate first or pass a url.' };
    }

    const sync = await this.ensureBackendAtUrl(scopeKey, 'playwright', currentUrl);
    if (!sync.success) {
      return sync.result;
    }
    const snapshotResult = await this.callTool(PLAYWRIGHT_SNAPSHOT_TOOL, {});
    if (!snapshotResult.success) {
      return snapshotResult;
    }

    const parsedSnapshot = parsePlaywrightSnapshot(snapshotResult.output);
    const snapshotText = clipText(parsedSnapshot.snapshotText, Math.max(500, Math.min(40_000, asNumber(input.maxChars, 12_000))));
    const state = this.storePlaywrightActionState(scopeKey, {
      url: currentUrl,
      title: this.sessions.get(scopeKey)?.pageTitle,
      snapshot: snapshotText,
      elements: parsedSnapshot.elements,
    });
    this.updateSession(scopeKey, {
      lastAction: 'state',
      lastBackend: 'playwright',
      lastReadBackend: 'playwright',
      latestPlaywrightStateId: state.id,
      lastStrategy: 'playwright-state',
    });
    return {
      success: true,
      message: `Captured interactive browser state for ${currentUrl} via Playwright.`,
      output: {
        stateId: state.id,
        url: state.url,
        title: state.title,
        backend: 'playwright',
        elements: state.elements,
        snapshot: state.snapshot,
        createdAt: state.createdAt,
        session: this.getSession(scopeKey),
      },
    };
  }

  async act(
    scopeKey: string,
    input: { stateId?: string; action?: string; ref?: string; value?: string },
  ): Promise<ToolResult> {
    const capabilities = this.getCapabilities();
    if (!(capabilities.backends.playwright.navigate && capabilities.backends.playwright.interact)) {
      return { success: false, error: 'Interactive browser actions require the Playwright backend.' };
    }

    const action = (input.action ?? 'click').trim().toLowerCase();
    if (!['click', 'type', 'fill', 'select'].includes(action)) {
      return { success: false, error: `Unsupported browser_act action '${action}'.` };
    }

    const stateId = (input.stateId ?? '').trim();
    if (!stateId) {
      return { success: false, error: 'stateId is required. Capture a fresh browser_state before mutating the page.' };
    }

    const state = this.actionStates.get(stateId);
    if (!state || state.scopeKey !== scopeKey) {
      return { success: false, error: 'Unknown browser state. Capture a fresh browser_state before mutating the page.' };
    }

    const session = this.sessions.get(scopeKey);
    if (!session || session.playwrightStateVersion !== state.version || session.currentUrl !== state.url) {
      return { success: false, error: 'The captured browser state is stale. Capture a fresh browser_state before mutating the page.' };
    }

    const ref = (input.ref ?? '').trim();
    if (!ref) {
      return { success: false, error: 'ref is required for browser_act.' };
    }
    const mutationValue = typeof input.value === 'string' ? input.value : '';
    if (action !== 'click' && mutationValue.length === 0) {
      return { success: false, error: `value is required for browser_act action '${action}'.` };
    }

    const matchedTarget = state.elements.find((element) => element.ref === ref);
    if (!matchedTarget) {
      return { success: false, error: `Unknown ref '${ref}' for the captured browser state.` };
    }

    const sync = await this.ensureBackendAtUrl(scopeKey, 'playwright', state.url);
    if (!sync.success) {
      return sync.result;
    }

    const toolName = action === 'click'
      ? PLAYWRIGHT_CLICK_TOOL
      : (action === 'select' ? PLAYWRIGHT_SELECT_TOOL : PLAYWRIGHT_TYPE_TOOL);
    const payload = buildPlaywrightMutationPayload(
      this.getToolDefinition(toolName),
      action as 'click' | 'type' | 'fill' | 'select',
      ref,
      mutationValue,
    );
    const interactionResult = await this.callTool(toolName, payload);
    if (!interactionResult.success) {
      return interactionResult;
    }

    const nextVersion = this.bumpPlaywrightStateVersion(scopeKey);
    this.updateSession(scopeKey, {
      lastAction: `act:${action}`,
      lastBackend: 'playwright',
      lastStrategy: 'playwright-action',
      latestPlaywrightStateId: undefined,
    });
    this.pruneActionStates(scopeKey, nextVersion);
    return {
      success: true,
      message: `${formatInteractionPastTense(action)} '${matchedTarget.text || matchedTarget.ref}' on ${state.url} via Playwright.`,
      output: {
        stateId,
        url: state.url,
        backend: 'playwright',
        action,
        ref,
        target: matchedTarget,
        ...(action === 'click' ? {} : { value: mutationValue }),
        resyncedPage: sync.navigated,
        session: this.getSession(scopeKey),
      },
    };
  }

  async navigate(
    scopeKey: string,
    url: string,
    mode: HybridBrowserMode = 'auto',
  ): Promise<ToolResult> {
    const capabilities = this.getCapabilities();
    if (!capabilities.available) {
      return { success: false, error: 'Browser tooling is unavailable because no managed browser backend is connected.' };
    }

    const normalizedUrl = normalizeBrowserUrl(url);
    if (!normalizedUrl) {
      return { success: false, error: 'url is required' };
    }

    if (mode !== 'interactive' && capabilities.backends.lightpanda.navigate) {
      const lightpandaResult = await this.callTool(LIGHTPANDA_GOTO_TOOL, { url: normalizedUrl });
      if (lightpandaResult.success) {
        const summary = summarizeNavigationResult(lightpandaResult.output, normalizedUrl);
        const nextVersion = this.bumpPlaywrightStateVersion(scopeKey);
        this.updateSession(scopeKey, {
          currentUrl: summary.url,
          pageTitle: summary.title,
          lastAction: 'navigate',
          lastBackend: 'lightpanda',
          lastReadBackend: 'lightpanda',
          lastLightpandaUrl: summary.url,
          latestPlaywrightStateId: undefined,
          lastStrategy: mode === 'read' ? 'lightpanda' : 'lightpanda-first',
        });
        this.pruneActionStates(scopeKey, nextVersion);
        return {
          success: true,
          message: `Navigated to ${summary.url} via Lightpanda.`,
          output: {
            url: summary.url,
            title: summary.title,
            backend: 'lightpanda',
            requestedMode: mode,
            fallbackUsed: false,
            session: this.getSession(scopeKey),
          },
        };
      }

      if (!capabilities.backends.playwright.navigate) {
        return lightpandaResult;
      }

      const playwrightResult = await this.callTool(PLAYWRIGHT_NAVIGATE_TOOL, { url: normalizedUrl });
      if (!playwrightResult.success) {
        return {
          success: false,
          error: playwrightResult.error ?? lightpandaResult.error ?? 'Browser navigation failed.',
        };
      }
      const summary = summarizeNavigationResult(playwrightResult.output, normalizedUrl);
      const nextVersion = this.bumpPlaywrightStateVersion(scopeKey);
      this.updateSession(scopeKey, {
        currentUrl: summary.url,
        pageTitle: summary.title,
        lastAction: 'navigate',
        lastBackend: 'playwright',
        lastReadBackend: 'playwright',
        lastPlaywrightUrl: summary.url,
        latestPlaywrightStateId: undefined,
        lastStrategy: 'lightpanda-fallback-playwright',
      });
      this.pruneActionStates(scopeKey, nextVersion);
      return {
        success: true,
        message: `Navigated to ${summary.url} via Playwright after Lightpanda fallback.`,
        output: {
          url: summary.url,
          title: summary.title,
          backend: 'playwright',
          requestedMode: mode,
          fallbackUsed: true,
          session: this.getSession(scopeKey),
        },
      };
    }

    if (!capabilities.backends.playwright.navigate && capabilities.backends.lightpanda.navigate) {
      return this.navigate(scopeKey, normalizedUrl, 'read');
    }

    if (!capabilities.backends.playwright.navigate) {
      return { success: false, error: 'No navigation-capable browser backend is available.' };
    }

    const playwrightResult = await this.callTool(PLAYWRIGHT_NAVIGATE_TOOL, { url: normalizedUrl });
    if (!playwrightResult.success) {
      return playwrightResult;
    }
    const summary = summarizeNavigationResult(playwrightResult.output, normalizedUrl);
    const nextVersion = this.bumpPlaywrightStateVersion(scopeKey);
    this.updateSession(scopeKey, {
      currentUrl: summary.url,
      pageTitle: summary.title,
      lastAction: 'navigate',
      lastBackend: 'playwright',
      lastReadBackend: 'playwright',
      lastPlaywrightUrl: summary.url,
      latestPlaywrightStateId: undefined,
      lastStrategy: 'playwright',
    });
    this.pruneActionStates(scopeKey, nextVersion);
    return {
      success: true,
      message: `Navigated to ${summary.url} via Playwright.`,
      output: {
        url: summary.url,
        title: summary.title,
        backend: 'playwright',
        requestedMode: mode,
        fallbackUsed: false,
        session: this.getSession(scopeKey),
      },
    };
  }

  async read(
    scopeKey: string,
    input: { url?: string; maxChars?: number },
  ): Promise<ToolResult> {
    const targetUrl = normalizeBrowserUrl(input.url);
    if (targetUrl) {
      const navigation = await this.navigate(scopeKey, targetUrl, 'read');
      if (!navigation.success) return navigation;
    }

    const session = this.sessions.get(scopeKey);
    const currentUrl = session?.currentUrl;
    if (!currentUrl) {
      return { success: false, error: 'No active browser page. Call browser_navigate first or pass a url.' };
    }

    const maxChars = Math.max(500, Math.min(40_000, asNumber(input.maxChars, 12_000)));
    const capabilities = this.getCapabilities();

    if (capabilities.backends.lightpanda.navigate && capabilities.backends.lightpanda.markdown) {
      const sync = await this.ensureBackendAtUrl(scopeKey, 'lightpanda', currentUrl);
      if (!sync.success) {
        return sync.result;
      }
      const markdownResult = await this.callTool(LIGHTPANDA_MARKDOWN_TOOL, {});
      if (markdownResult.success) {
        const content = clipText(outputToText(markdownResult.output), maxChars);
        this.updateSession(scopeKey, {
          lastAction: 'read',
          lastBackend: 'lightpanda',
          lastReadBackend: 'lightpanda',
          lastStrategy: 'lightpanda',
        });
        return {
          success: true,
          message: `Read ${currentUrl} via Lightpanda.`,
          output: {
            url: currentUrl,
            title: this.sessions.get(scopeKey)?.pageTitle,
            backend: 'lightpanda',
            contentType: 'markdown',
            content,
            truncated: content.length >= maxChars,
            session: this.getSession(scopeKey),
          },
        };
      }
      if (!capabilities.backends.playwright.navigate || !capabilities.backends.playwright.snapshot) {
        return markdownResult;
      }
    }

    if (!capabilities.backends.playwright.navigate || !capabilities.backends.playwright.snapshot) {
      return { success: false, error: 'No readable browser backend is available.' };
    }

    const sync = await this.ensureBackendAtUrl(scopeKey, 'playwright', currentUrl);
    if (!sync.success) {
      return sync.result;
    }
    const snapshotResult = await this.callTool(PLAYWRIGHT_SNAPSHOT_TOOL, {});
    if (!snapshotResult.success) {
      return snapshotResult;
    }
    const content = clipText(extractSnapshotText(snapshotResult.output), maxChars);
    this.updateSession(scopeKey, {
      lastAction: 'read',
      lastBackend: 'playwright',
      lastReadBackend: 'playwright',
      lastStrategy: 'playwright-fallback',
    });
    return {
      success: true,
      message: `Read ${currentUrl} via Playwright accessibility snapshot.`,
      output: {
        url: currentUrl,
        title: this.sessions.get(scopeKey)?.pageTitle,
        backend: 'playwright',
        contentType: 'snapshot',
        content,
        truncated: content.length >= maxChars,
        session: this.getSession(scopeKey),
      },
    };
  }

  async links(
    scopeKey: string,
    input: { url?: string; filter?: string; maxItems?: number },
  ): Promise<ToolResult> {
    const capabilities = this.getCapabilities();
    if (!(capabilities.backends.lightpanda.navigate && capabilities.backends.lightpanda.links)) {
      return { success: false, error: 'Structured link extraction requires the Lightpanda read backend.' };
    }

    const targetUrl = normalizeBrowserUrl(input.url);
    if (targetUrl) {
      const navigation = await this.navigate(scopeKey, targetUrl, 'read');
      if (!navigation.success) return navigation;
    }

    const session = this.sessions.get(scopeKey);
    const currentUrl = session?.currentUrl;
    if (!currentUrl) {
      return { success: false, error: 'No active browser page. Call browser_navigate first or pass a url.' };
    }

    const sync = await this.ensureBackendAtUrl(scopeKey, 'lightpanda', currentUrl);
    if (!sync.success) {
      return sync.result;
    }

    const linkResult = await this.callTool(LIGHTPANDA_LINKS_TOOL, {});
    if (!linkResult.success) {
      return linkResult;
    }

    const filter = (input.filter ?? '').trim().toLowerCase();
    const maxItems = Math.max(1, Math.min(100, asNumber(input.maxItems, 50)));
    const links = normalizeLinkEntries(linkResult.output, currentUrl)
      .filter((entry) => !filter || entry.text.toLowerCase().includes(filter) || entry.href.toLowerCase().includes(filter))
      .slice(0, maxItems);

    this.updateSession(scopeKey, {
      lastAction: 'links',
      lastBackend: 'lightpanda',
      lastReadBackend: 'lightpanda',
      lastStrategy: 'lightpanda',
    });
    return {
      success: true,
      message: `Extracted ${links.length} link${links.length === 1 ? '' : 's'} from ${currentUrl}.`,
      output: {
        url: currentUrl,
        backend: 'lightpanda',
        filter: filter || undefined,
        links,
        session: this.getSession(scopeKey),
      },
    };
  }

  async extract(
    scopeKey: string,
    input: { url?: string; type?: 'structured' | 'semantic' | 'both'; maxChars?: number },
  ): Promise<ToolResult> {
    const capabilities = this.getCapabilities();
    if (!capabilities.backends.lightpanda.navigate) {
      return { success: false, error: 'Structured browser extraction requires the Lightpanda read backend.' };
    }

    const targetUrl = normalizeBrowserUrl(input.url);
    if (targetUrl) {
      const navigation = await this.navigate(scopeKey, targetUrl, 'read');
      if (!navigation.success) return navigation;
    }

    const session = this.sessions.get(scopeKey);
    const currentUrl = session?.currentUrl;
    if (!currentUrl) {
      return { success: false, error: 'No active browser page. Call browser_navigate first or pass a url.' };
    }

    const sync = await this.ensureBackendAtUrl(scopeKey, 'lightpanda', currentUrl);
    if (!sync.success) {
      return sync.result;
    }

    const type = input.type ?? 'both';
    const maxChars = Math.max(500, Math.min(40_000, asNumber(input.maxChars, 12_000)));
    let structuredData: unknown;
    let semanticTree: string | undefined;

    if ((type === 'structured' || type === 'both') && capabilities.backends.lightpanda.structuredData) {
      const structuredResult = await this.callTool(LIGHTPANDA_STRUCTURED_DATA_TOOL, {});
      if (!structuredResult.success) {
        return structuredResult;
      }
      structuredData = normalizeStructuredOutput(structuredResult.output);
    }

    if ((type === 'semantic' || type === 'both') && capabilities.backends.lightpanda.semanticTree) {
      const semanticResult = await this.callTool(LIGHTPANDA_SEMANTIC_TREE_TOOL, {});
      if (!semanticResult.success) {
        return semanticResult;
      }
      semanticTree = clipText(outputToText(semanticResult.output), maxChars);
    }

    this.updateSession(scopeKey, {
      lastAction: 'extract',
      lastBackend: 'lightpanda',
      lastReadBackend: 'lightpanda',
      lastStrategy: 'lightpanda',
    });
    return {
      success: true,
      message: `Extracted ${type} page data from ${currentUrl}.`,
      output: {
        url: currentUrl,
        backend: 'lightpanda',
        type,
        structuredData,
        semanticTree,
        session: this.getSession(scopeKey),
      },
    };
  }

  async interact(
    scopeKey: string,
    input: { url?: string; action?: string; stateId?: string; ref?: string; element?: string; value?: string },
  ): Promise<ToolResult> {
    const action = (input.action ?? 'list').trim().toLowerCase();
    if (!['list', 'click', 'type', 'fill', 'select'].includes(action)) {
      return { success: false, error: `Unsupported browser_interact action '${action}'.` };
    }

    const targetUrl = normalizeBrowserUrl(input.url);

    if (action === 'list') {
      const stateResult = await this.state(scopeKey, {
        ...(targetUrl ? { url: targetUrl } : {}),
      });
      if (!stateResult.success) {
        return stateResult;
      }
      const output = isRecord(stateResult.output) ? stateResult.output : {};
      const elements = Array.isArray(output.elements)
        ? output.elements.filter((entry): entry is HybridBrowserTarget => (
          isRecord(entry)
          && typeof entry.ref === 'string'
          && typeof entry.type === 'string'
          && typeof entry.text === 'string'
        ))
        : [];
      this.updateSession(scopeKey, {
        lastAction: 'interact:list',
        lastBackend: 'playwright',
        lastReadBackend: 'playwright',
        lastStrategy: 'playwright-state',
      });
      const url = asOptionalString(output.url) ?? this.sessions.get(scopeKey)?.currentUrl;
      const snapshot = asOptionalString(output.snapshot);
      const stateId = asOptionalString(output.stateId);
      if (!url) {
        return stateResult;
      }
      return {
        success: true,
        message: `Listed interactive targets for ${url} via Playwright browser state.`,
        output: {
          url,
          backend: 'playwright',
          action,
          ...(stateId ? { stateId } : {}),
          elements,
          ...(snapshot ? { snapshot } : {}),
          session: this.getSession(scopeKey),
        },
      };
    }

    if (targetUrl) {
      const stateResult = await this.state(scopeKey, { url: targetUrl });
      if (!stateResult.success) {
        return stateResult;
      }
    }

    const session = this.sessions.get(scopeKey);
    const stateId = (input.stateId ?? '').trim() || session?.latestPlaywrightStateId || '';
    if (!stateId) {
      return { success: false, error: 'browser_interact mutating actions now require a fresh browser_state (or action=list) so you can supply stateId and ref.' };
    }

    const ref = (input.ref ?? '').trim()
      || resolveCompatibilityRef(input.element, this.actionStates.get(stateId));
    if (!ref) {
      return { success: false, error: 'browser_interact mutating actions now require a stable ref from browser_state output. Free-form labels are no longer accepted.' };
    }

    return this.act(scopeKey, {
      stateId,
      action,
      ref,
      value: input.value,
    });
  }

  private getToolNames(): Set<string> {
    return new Set(this.manager.getAllToolDefinitions().map((definition) => definition.name));
  }

  private getToolDefinition(toolName: string): ToolDefinition | undefined {
    return this.manager.getAllToolDefinitions().find((definition) => definition.name === toolName);
  }

  private async ensureBackendAtUrl(
    scopeKey: string,
    backend: HybridBrowserBackend,
    url: string,
  ): Promise<{ success: true; navigated: boolean } | { success: false; result: ToolResult }> {
    const session = this.sessions.get(scopeKey);
    const currentUrl = backend === 'lightpanda' ? session?.lastLightpandaUrl : session?.lastPlaywrightUrl;
    if (currentUrl === url) {
      return { success: true, navigated: false };
    }
    const toolName = backend === 'lightpanda' ? LIGHTPANDA_GOTO_TOOL : PLAYWRIGHT_NAVIGATE_TOOL;
    const result = await this.callTool(toolName, { url });
    if (!result.success) {
      return { success: false, result };
    }
    const summary = summarizeNavigationResult(result.output, url);
    const nextVersion = this.bumpPlaywrightStateVersion(scopeKey);
    this.updateSession(scopeKey, backend === 'lightpanda'
      ? {
          currentUrl: summary.url,
          pageTitle: summary.title,
          lastLightpandaUrl: summary.url,
          latestPlaywrightStateId: undefined,
        }
      : {
          currentUrl: summary.url,
          pageTitle: summary.title,
          lastPlaywrightUrl: summary.url,
          latestPlaywrightStateId: undefined,
        });
    this.pruneActionStates(scopeKey, nextVersion);
    return { success: true, navigated: true };
  }

  private async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    return this.manager.callTool(toolName, args);
  }

  private updateSession(scopeKey: string, patch: Partial<HybridBrowserSessionState>): void {
    const current = this.sessions.get(scopeKey) ?? { updatedAt: this.now(), playwrightStateVersion: 0 };
    this.sessions.set(scopeKey, {
      ...current,
      ...patch,
      updatedAt: this.now(),
    });
  }

  private storePlaywrightActionState(
    scopeKey: string,
    input: { url: string; title?: string; snapshot: string; elements: HybridBrowserTarget[] },
  ): HybridBrowserActionState {
    const session = this.sessions.get(scopeKey) ?? { updatedAt: this.now(), playwrightStateVersion: 0 };
    const state: HybridBrowserActionState = {
      id: `browser-state:${randomUUID()}`,
      scopeKey,
      url: input.url,
      title: input.title,
      snapshot: input.snapshot,
      elements: input.elements,
      version: session.playwrightStateVersion,
      createdAt: this.now(),
    };
    this.actionStates.set(state.id, state);
    this.pruneActionStates(scopeKey, session.playwrightStateVersion);
    return state;
  }

  private bumpPlaywrightStateVersion(scopeKey: string): number {
    const current = this.sessions.get(scopeKey) ?? { updatedAt: this.now(), playwrightStateVersion: 0 };
    const nextVersion = (current.playwrightStateVersion ?? 0) + 1;
    this.sessions.set(scopeKey, {
      ...current,
      playwrightStateVersion: nextVersion,
      updatedAt: this.now(),
    });
    return nextVersion;
  }

  private pruneActionStates(scopeKey: string, currentVersion: number): void {
    for (const [id, state] of this.actionStates.entries()) {
      if (state.scopeKey !== scopeKey) continue;
      if (state.version !== currentVersion) {
        this.actionStates.delete(id);
      }
    }
  }
}

function summarizeNavigationResult(
  output: unknown,
  fallbackUrl: string,
): { url: string; title?: string } {
  const structured = outputToStructured(output);
  if (isRecord(structured)) {
    return {
      url: asString(structured.url, fallbackUrl) || fallbackUrl,
      title: asOptionalString(structured.title)
        ?? asOptionalString(structured.pageTitle)
        ?? asOptionalString(structured.name),
    };
  }
  return {
    url: fallbackUrl,
    title: undefined,
  };
}

function normalizeLinkEntries(output: unknown, currentUrl: string): Array<{ text: string; href: string }> {
  const structured = outputToStructured(output);
  const candidates = Array.isArray(structured)
    ? structured
    : isRecord(structured) && Array.isArray(structured.links)
      ? structured.links
      : [];
  const links: Array<{ text: string; href: string }> = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const hrefValue = asOptionalString(candidate.href)
      ?? asOptionalString(candidate.url)
      ?? asOptionalString(candidate.link);
    if (!hrefValue) continue;
    let href = hrefValue;
    try {
      href = new URL(hrefValue, currentUrl).toString();
    } catch {
      href = hrefValue;
    }
    const text = asOptionalString(candidate.text)
      ?? asOptionalString(candidate.label)
      ?? asOptionalString(candidate.title)
      ?? href;
    links.push({ text, href });
  }
  return links;
}

function normalizeStructuredOutput(output: unknown): unknown {
  const structured = outputToStructured(output);
  return structured;
}

function parseSnapshotRefs(snapshot: string): Array<{ ref: string; type: string; text: string }> {
  const elements: Array<{ ref: string; type: string; text: string }> = [];
  for (const line of snapshot.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const refMatch = trimmed.match(/\bref=([^\s\]]+)/i);
    if (!refMatch) continue;
    const ref = refMatch[1];
    const typeMatch = trimmed.match(/^(button|link|textbox|input|checkbox|radio|combobox|option|tab)\b/i);
    const type = typeMatch?.[1]?.toLowerCase() ?? 'interactive';
    const text = trimmed
      .replace(/\bref=[^\s\]]+/i, '')
      .replace(/^(button|link|textbox|input|checkbox|radio|combobox|option|tab)\b/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    elements.push({ ref, type, text });
  }
  return elements;
}

function parsePlaywrightSnapshot(output: unknown): { snapshotText: string; elements: HybridBrowserTarget[] } {
  const structured = outputToStructured(output);
  const snapshotValue = isRecord(structured) && Object.prototype.hasOwnProperty.call(structured, 'snapshot')
    ? structured.snapshot
    : structured;
  const text = extractSnapshotText(snapshotValue).trim() || extractSnapshotText(structured).trim();
  const elements = collectSnapshotRefs(snapshotValue);
  if (elements.length > 0) {
    return {
      snapshotText: text || elements.map((element) => `${element.type} ref=${element.ref} ${element.text}`.trim()).join('\n'),
      elements,
    };
  }
  return {
    snapshotText: text,
    elements: parseSnapshotRefs(text),
  };
}

function extractSnapshotText(output: unknown): string {
  if (typeof output === 'string') {
    const structured = outputToStructured(output);
    if (structured !== output) {
      return extractSnapshotText(structured);
    }
    return output;
  }
  if (Array.isArray(output)) {
    return output.map((entry) => extractSnapshotText(entry)).filter(Boolean).join('\n');
  }
  if (isRecord(output)) {
    if (typeof output.snapshot === 'string') return output.snapshot;
    if (Array.isArray(output.outline)) {
      return output.outline
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean)
        .join('\n');
    }
    const formatted = formatSnapshotNode(output);
    if (formatted.trim()) return formatted;
  }
  return outputToText(output);
}

function collectSnapshotRefs(value: unknown): HybridBrowserTarget[] {
  const elements: HybridBrowserTarget[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;

    const ref = asOptionalString(node.ref)
      ?? asOptionalString(node.id)
      ?? asOptionalString(node.element);
    const type = asOptionalString(node.role)
      ?? asOptionalString(node.type)
      ?? asOptionalString(node.tag)
      ?? asOptionalString(node.kind);
    const text = asOptionalString(node.name)
      ?? asOptionalString(node.text)
      ?? asOptionalString(node.label)
      ?? asOptionalString(node.value)
      ?? asOptionalString(node.title)
      ?? '';

    if (ref && type && !seen.has(ref)) {
      seen.add(ref);
      elements.push({ ref, type, text });
    }

    for (const [key, child] of Object.entries(node)) {
      if (key === 'ref' || key === 'id' || key === 'element' || key === 'role' || key === 'type' || key === 'tag' || key === 'kind' || key === 'name' || key === 'text' || key === 'label' || key === 'value' || key === 'title') {
        continue;
      }
      visit(child);
    }
  };

  visit(value);
  return elements;
}

function formatSnapshotNode(value: unknown, depth = 0): string {
  if (typeof value === 'string') return `${'  '.repeat(depth)}${value}`;
  if (Array.isArray(value)) {
    return value
      .map((entry) => formatSnapshotNode(entry, depth))
      .filter(Boolean)
      .join('\n');
  }
  if (!isRecord(value)) return '';

  const ref = asOptionalString(value.ref)
    ?? asOptionalString(value.id)
    ?? asOptionalString(value.element);
  const type = asOptionalString(value.role)
    ?? asOptionalString(value.type)
    ?? asOptionalString(value.tag)
    ?? asOptionalString(value.kind);
  const text = asOptionalString(value.name)
    ?? asOptionalString(value.text)
    ?? asOptionalString(value.label)
    ?? asOptionalString(value.value)
    ?? asOptionalString(value.title);
  const line = [type, ref ? `ref=${ref}` : '', text].filter(Boolean).join(' ').trim();

  const childLines: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === 'ref' || key === 'id' || key === 'element' || key === 'role' || key === 'type' || key === 'tag' || key === 'kind' || key === 'name' || key === 'text' || key === 'label' || key === 'value' || key === 'title') {
      continue;
    }
    const rendered = formatSnapshotNode(child, line ? depth + 1 : depth);
    if (rendered) childLines.push(rendered);
  }

  return [line ? `${'  '.repeat(depth)}${line}` : '', ...childLines].filter(Boolean).join('\n');
}

function buildPlaywrightMutationPayload(
  definition: ToolDefinition | undefined,
  action: 'click' | 'type' | 'fill' | 'select',
  ref: string,
  value: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const refKey = pickDefinitionParameterKey(definition, ['ref', 'element', 'selector'], 'ref');
  payload[refKey] = ref;

  if (action === 'click') {
    return payload;
  }

  if (action === 'select') {
    const valueKey = pickDefinitionParameterKey(definition, ['values', 'value', 'options'], 'values');
    payload[valueKey] = valueKey === 'values' || valueKey === 'options' ? [value] : value;
    return payload;
  }

  const valueKey = pickDefinitionParameterKey(definition, ['text', 'value', 'input'], 'text');
  payload[valueKey] = value;
  return payload;
}

function pickDefinitionParameterKey(
  definition: ToolDefinition | undefined,
  preferredKeys: string[],
  fallback: string,
): string {
  const properties = isRecord(definition?.parameters)
    && isRecord((definition.parameters as Record<string, unknown>).properties)
    ? Object.keys((definition.parameters as { properties: Record<string, unknown> }).properties)
    : [];
  for (const preferred of preferredKeys) {
    if (properties.includes(preferred)) return preferred;
  }
  return properties[0] ?? fallback;
}

function resolveCompatibilityRef(
  value: string | undefined,
  state: HybridBrowserActionState | undefined,
): string {
  const normalized = (value ?? '').trim();
  if (!normalized) return '';
  if (state?.elements.some((element) => element.ref === normalized)) {
    return normalized;
  }
  return looksLikeBrowserRef(normalized) ? normalized : '';
}

function looksLikeBrowserRef(value: string): boolean {
  return /^[A-Za-z0-9:_-]{1,120}$/.test(value.trim());
}

function outputToStructured(output: unknown): unknown {
  if (typeof output !== 'string') return output;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function normalizeBrowserUrl(url: string | undefined): string {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n...[truncated]`;
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function formatInteractionPastTense(action: string): string {
  switch (action) {
    case 'click':
      return 'Clicked';
    case 'type':
    case 'fill':
      return 'Filled';
    case 'select':
      return 'Selected';
    default:
      return `${capitalize(action)}ed`;
  }
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
