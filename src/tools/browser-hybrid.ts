import { randomUUID } from 'node:crypto';
import type { BrowserConfig } from '../config/types.js';
import type { MCPClientManager } from './mcp-client.js';
import { DirectPlaywrightBrowserBackend, type PlaywrightDirectBackendLike } from './browser-playwright-direct.js';
import type { ToolDefinition, ToolResult } from './types.js';

const PLAYWRIGHT_NAVIGATE_TOOL = 'mcp-playwright-browser_navigate';
const PLAYWRIGHT_SNAPSHOT_TOOL = 'mcp-playwright-browser_snapshot';
const PLAYWRIGHT_CLICK_TOOL = 'mcp-playwright-browser_click';
const PLAYWRIGHT_TYPE_TOOL = 'mcp-playwright-browser_type';
const PLAYWRIGHT_SELECT_TOOL = 'mcp-playwright-browser_select_option';
const PLAYWRIGHT_EVALUATE_TOOL = 'mcp-playwright-browser_evaluate';

const PLAYWRIGHT_LINKS_EVALUATION = `() => {
  const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  return Array.from(document.querySelectorAll('a[href]')).map((anchor) => ({
    text: normalize(anchor.textContent || anchor.getAttribute('aria-label') || anchor.getAttribute('title') || ''),
    href: anchor.href,
  })).filter((entry) => !!entry.href);
}`;

const PLAYWRIGHT_STRUCTURED_EVALUATION = `() => {
  const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const readAttr = (selector, attribute = 'content') => {
    const element = document.querySelector(selector);
    const value = element?.getAttribute(attribute);
    return value ? normalize(value) || null : null;
  };
  const parseJsonLd = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .map((element) => ({
      level: Number(element.tagName.slice(1)),
      text: normalize(element.textContent || ''),
    }))
    .filter((entry) => entry.text);
  const landmarks = Array.from(document.querySelectorAll('main,nav,header,footer,aside,section,article,[role="main"],[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="region"]'))
    .map((element) => {
      const role = normalize(element.getAttribute('role') || element.tagName.toLowerCase());
      const label = normalize(element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || '') || null;
      return { role, label };
    })
    .filter((entry) => entry.role)
    .slice(0, 80);
  const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map((script) => parseJsonLd(script.textContent || ''))
    .filter((entry) => entry !== null);
  return {
    metadata: {
      url: location.href,
      title: normalize(document.title || '') || null,
      lang: normalize(document.documentElement.lang || '') || null,
      description: readAttr('meta[name="description"]'),
      canonicalUrl: readAttr('link[rel="canonical"]', 'href'),
      openGraph: {
        title: readAttr('meta[property="og:title"]'),
        description: readAttr('meta[property="og:description"]'),
        type: readAttr('meta[property="og:type"]'),
        image: readAttr('meta[property="og:image"]'),
      },
      twitter: {
        card: readAttr('meta[name="twitter:card"]'),
        title: readAttr('meta[name="twitter:title"]'),
        description: readAttr('meta[name="twitter:description"]'),
        image: readAttr('meta[name="twitter:image"]'),
      },
    },
    headings,
    landmarks,
    jsonLd,
  };
}`;

export type HybridBrowserMode = 'auto' | 'read' | 'interactive';
export type HybridBrowserBackend = 'playwright';

interface HybridBrowserSessionState {
  currentUrl?: string;
  pageTitle?: string;
  lastAction?: string;
  lastBackend?: HybridBrowserBackend;
  lastReadBackend?: HybridBrowserBackend;
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
      evaluate: boolean;
      moduleName?: string;
      moduleSource?: string;
      moduleEntryPath?: string;
      unavailableReason?: string;
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

export interface HybridBrowserServiceOptions {
  now?: () => number;
  browserConfig?: BrowserConfig;
  enableDirectPlaywright?: boolean;
  directPlaywright?: PlaywrightDirectBackendLike;
}

export class HybridBrowserService {
  private readonly sessions = new Map<string, HybridBrowserSessionState>();
  private readonly actionStates = new Map<string, HybridBrowserActionState>();
  private readonly now: () => number;
  private readonly directPlaywright?: PlaywrightDirectBackendLike;

  constructor(
    private readonly manager: MCPClientManager,
    nowOrOptions: (() => number) | HybridBrowserServiceOptions = Date.now,
  ) {
    if (typeof nowOrOptions === 'function') {
      this.now = nowOrOptions;
      return;
    }

    this.now = nowOrOptions.now ?? Date.now;
    this.directPlaywright = nowOrOptions.directPlaywright
      ?? (nowOrOptions.enableDirectPlaywright
        ? new DirectPlaywrightBrowserBackend(nowOrOptions.browserConfig)
        : undefined);
  }

  setBrowserConfig(browserConfig: BrowserConfig | undefined): void {
    this.directPlaywright?.setBrowserConfig(browserConfig);
  }

  hasAnyBackend(): boolean {
    const capabilities = this.getCapabilities();
    return capabilities.available;
  }

  getCapabilities(): HybridBrowserCapabilities {
    const toolNames = this.getToolNames();
    const managedPlaywrightNavigate = toolNames.has(PLAYWRIGHT_NAVIGATE_TOOL);
    const managedPlaywrightSnapshot = toolNames.has(PLAYWRIGHT_SNAPSHOT_TOOL);
    const managedPlaywrightInteract = toolNames.has(PLAYWRIGHT_CLICK_TOOL)
      || toolNames.has(PLAYWRIGHT_TYPE_TOOL)
      || toolNames.has(PLAYWRIGHT_SELECT_TOOL);
    const managedPlaywrightEvaluate = toolNames.has(PLAYWRIGHT_EVALUATE_TOOL);
    const directPlaywright = this.directPlaywright?.getCapabilities();

    const playwrightNavigate = managedPlaywrightNavigate || directPlaywright?.navigate === true;
    const playwrightSnapshot = managedPlaywrightSnapshot || directPlaywright?.snapshot === true;
    const playwrightInteract = managedPlaywrightInteract || directPlaywright?.interact === true;
    const playwrightEvaluate = managedPlaywrightEvaluate || directPlaywright?.evaluate === true;

    const preferredReadBackend = playwrightNavigate && playwrightSnapshot
      ? 'playwright'
      : null;
    const preferredInteractionBackend = playwrightNavigate && playwrightInteract
      ? 'playwright'
      : null;

    return {
      available: !!(preferredReadBackend || preferredInteractionBackend),
      preferredReadBackend,
      preferredInteractionBackend,
      backends: {
        playwright: {
          available: playwrightNavigate || playwrightSnapshot || playwrightInteract || playwrightEvaluate,
          navigate: playwrightNavigate,
          snapshot: playwrightSnapshot,
          interact: playwrightInteract,
          evaluate: playwrightEvaluate,
          moduleName: typeof directPlaywright?.moduleName === 'string' ? directPlaywright.moduleName : undefined,
          moduleSource: typeof directPlaywright?.moduleSource === 'string' ? directPlaywright.moduleSource : undefined,
          moduleEntryPath: typeof directPlaywright?.moduleEntryPath === 'string' ? directPlaywright.moduleEntryPath : undefined,
          unavailableReason: typeof directPlaywright?.unavailableReason === 'string' ? directPlaywright.unavailableReason : undefined,
        },
      },
      wrappers: {
        browserCapabilities: true,
        browserNavigate: playwrightNavigate,
        browserRead: playwrightNavigate && playwrightSnapshot,
        browserLinks: playwrightNavigate && playwrightEvaluate,
        browserExtract: playwrightNavigate && playwrightSnapshot,
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

    const sync = await this.ensurePlaywrightAtUrl(scopeKey, currentUrl);
    if (!sync.success) {
      return sync.result;
    }
    const snapshotResult = await this.capturePlaywrightSnapshot(scopeKey);
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
    if ((session?.playwrightStateVersion ?? 0) !== state.version) {
      return { success: false, error: 'The captured browser state is stale. Capture a fresh browser_state before mutating the page.' };
    }

    const ref = (input.ref ?? '').trim();
    if (!ref) {
      return { success: false, error: 'ref is required for browser_act.' };
    }
    const target = state.elements.find((element) => element.ref === ref);
    if (!target) {
      return { success: false, error: `ref '${ref}' was not present in browser_state '${stateId}'. Capture a fresh browser_state before mutating the page.` };
    }

    if ((action === 'type' || action === 'fill' || action === 'select') && !String(input.value ?? '').length) {
      return { success: false, error: `value is required for browser_act action '${action}'.` };
    }

    const sync = await this.ensurePlaywrightAtUrl(scopeKey, state.url);
    if (!sync.success) {
      return sync.result;
    }

    const result = await this.mutatePlaywright(
      scopeKey,
      action as 'click' | 'type' | 'fill' | 'select',
      ref,
      asString(input.value, ''),
      target.text,
    );
    if (!result.success) {
      return result;
    }

    const nextVersion = this.bumpPlaywrightStateVersion(scopeKey);
    this.updateSession(scopeKey, {
      currentUrl: state.url,
      pageTitle: state.title,
      lastAction: action,
      lastBackend: 'playwright',
      lastReadBackend: 'playwright',
      lastPlaywrightUrl: state.url,
      latestPlaywrightStateId: undefined,
      lastStrategy: 'playwright-act',
    });
    this.pruneActionStates(scopeKey, nextVersion);

    return {
      success: true,
      message: `${formatInteractionPastTense(action)} '${target.text || target.ref}' on ${state.url} via Playwright.`,
      output: {
        url: state.url,
        backend: 'playwright',
        action,
        ref,
        target,
        result: outputToStructured(result.output),
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
    if (!capabilities.backends.playwright.navigate) {
      return { success: false, error: 'No navigation-capable browser backend is available.' };
    }

    const normalizedUrl = normalizeBrowserUrl(url);
    if (!normalizedUrl) {
      return { success: false, error: 'url is required' };
    }

    const playwrightResult = await this.navigatePlaywright(scopeKey, normalizedUrl);
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
      lastStrategy: mode === 'interactive' ? 'playwright-interactive' : 'playwright-read',
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

    if (!capabilities.backends.playwright.navigate || !capabilities.backends.playwright.snapshot) {
      return { success: false, error: 'No readable browser backend is available.' };
    }

    const sync = await this.ensurePlaywrightAtUrl(scopeKey, currentUrl);
    if (!sync.success) {
      return sync.result;
    }
    const snapshotResult = await this.capturePlaywrightSnapshot(scopeKey);
    if (!snapshotResult.success) {
      return snapshotResult;
    }
    const content = clipText(extractSnapshotText(snapshotResult.output), maxChars);
    this.updateSession(scopeKey, {
      lastAction: 'read',
      lastBackend: 'playwright',
      lastReadBackend: 'playwright',
      lastStrategy: 'playwright-snapshot',
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
    if (!(capabilities.backends.playwright.navigate && capabilities.backends.playwright.evaluate)) {
      return { success: false, error: 'Structured link extraction requires the Playwright browser_evaluate capability.' };
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

    const sync = await this.ensurePlaywrightAtUrl(scopeKey, currentUrl);
    if (!sync.success) {
      return sync.result;
    }

    const evaluateResult = await this.evaluatePlaywright(scopeKey, PLAYWRIGHT_LINKS_EVALUATION);
    if (!evaluateResult.success) {
      return evaluateResult;
    }

    const filter = (input.filter ?? '').trim().toLowerCase();
    const maxItems = Math.max(1, Math.min(100, asNumber(input.maxItems, 50)));
    const links = normalizeLinkEntries(evaluateResult.output, currentUrl)
      .filter((entry) => !filter || entry.text.toLowerCase().includes(filter) || entry.href.toLowerCase().includes(filter))
      .slice(0, maxItems);

    this.updateSession(scopeKey, {
      lastAction: 'links',
      lastBackend: 'playwright',
      lastReadBackend: 'playwright',
      lastStrategy: 'playwright-dom-evaluate',
    });
    return {
      success: true,
      message: `Extracted ${links.length} link${links.length === 1 ? '' : 's'} from ${currentUrl}.`,
      output: {
        url: currentUrl,
        backend: 'playwright',
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
    if (!(capabilities.backends.playwright.navigate && capabilities.backends.playwright.snapshot)) {
      return { success: false, error: 'Structured browser extraction requires the Playwright backend.' };
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

    const sync = await this.ensurePlaywrightAtUrl(scopeKey, currentUrl);
    if (!sync.success) {
      return sync.result;
    }

    const type = input.type ?? 'both';
    const maxChars = Math.max(500, Math.min(40_000, asNumber(input.maxChars, 12_000)));

    let snapshotText = '';
    if (type === 'semantic' || type === 'both') {
      const snapshotResult = await this.capturePlaywrightSnapshot(scopeKey);
      if (!snapshotResult.success) {
        return snapshotResult;
      }
      snapshotText = extractSnapshotText(snapshotResult.output);
    }

    let structuredData: unknown;
    if (type === 'structured' || type === 'both') {
      if (!capabilities.backends.playwright.evaluate) {
        return { success: false, error: 'Structured metadata extraction requires the Playwright browser_evaluate capability.' };
      }
      const evaluateResult = await this.evaluatePlaywright(scopeKey, PLAYWRIGHT_STRUCTURED_EVALUATION);
      if (!evaluateResult.success) {
        return evaluateResult;
      }
      structuredData = normalizeStructuredOutput(evaluateResult.output);
    }

    const semanticTree = (type === 'semantic' || type === 'both')
      ? clipText(formatSemanticOutline(structuredData, snapshotText), maxChars)
      : undefined;

    this.updateSession(scopeKey, {
      lastAction: 'extract',
      lastBackend: 'playwright',
      lastReadBackend: 'playwright',
      lastStrategy: 'playwright-structured-extract',
    });
    return {
      success: true,
      message: `Extracted ${type} page data from ${currentUrl}.`,
      output: {
        url: currentUrl,
        backend: 'playwright',
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

  private managedPlaywrightCapabilities(): {
    navigate: boolean;
    snapshot: boolean;
    interact: boolean;
    evaluate: boolean;
  } {
    const toolNames = this.getToolNames();
    return {
      navigate: toolNames.has(PLAYWRIGHT_NAVIGATE_TOOL),
      snapshot: toolNames.has(PLAYWRIGHT_SNAPSHOT_TOOL),
      interact: toolNames.has(PLAYWRIGHT_CLICK_TOOL)
        || toolNames.has(PLAYWRIGHT_TYPE_TOOL)
        || toolNames.has(PLAYWRIGHT_SELECT_TOOL),
      evaluate: toolNames.has(PLAYWRIGHT_EVALUATE_TOOL),
    };
  }

  private async navigatePlaywright(scopeKey: string, url: string): Promise<ToolResult> {
    if (this.managedPlaywrightCapabilities().navigate) {
      return this.callTool(PLAYWRIGHT_NAVIGATE_TOOL, { url });
    }
    if (this.directPlaywright?.getCapabilities().navigate) {
      return this.directPlaywright.navigate(scopeKey, url);
    }
    return { success: false, error: 'No navigation-capable browser backend is available.' };
  }

  private async capturePlaywrightSnapshot(scopeKey: string): Promise<ToolResult> {
    if (this.managedPlaywrightCapabilities().snapshot) {
      return this.callTool(PLAYWRIGHT_SNAPSHOT_TOOL, {});
    }
    if (this.directPlaywright?.getCapabilities().snapshot) {
      return this.directPlaywright.snapshot(scopeKey);
    }
    return { success: false, error: 'No snapshot-capable browser backend is available.' };
  }

  private async evaluatePlaywright(scopeKey: string, fnSource: string): Promise<ToolResult> {
    if (this.managedPlaywrightCapabilities().evaluate) {
      return this.callTool(
        PLAYWRIGHT_EVALUATE_TOOL,
        buildPlaywrightEvaluatePayload(this.getToolDefinition(PLAYWRIGHT_EVALUATE_TOOL), fnSource),
      );
    }
    if (this.directPlaywright?.getCapabilities().evaluate) {
      return this.directPlaywright.evaluate(scopeKey, fnSource);
    }
    return { success: false, error: 'Structured browser evaluation requires the Playwright backend.' };
  }

  private async mutatePlaywright(
    scopeKey: string,
    action: 'click' | 'type' | 'fill' | 'select',
    ref: string,
    value: string,
    label?: string,
  ): Promise<ToolResult> {
    if (this.managedPlaywrightCapabilities().interact) {
      const toolName = action === 'click'
        ? PLAYWRIGHT_CLICK_TOOL
        : action === 'select'
          ? PLAYWRIGHT_SELECT_TOOL
          : PLAYWRIGHT_TYPE_TOOL;
      const definition = this.getToolDefinition(toolName);
      const payload = buildPlaywrightMutationPayload(definition, action, ref, value);
      return this.callTool(toolName, payload);
    }
    if (this.directPlaywright?.getCapabilities().interact) {
      return this.directPlaywright.act(scopeKey, { action, ref, value, label });
    }
    return { success: false, error: 'Interactive browser actions require the Playwright backend.' };
  }

  private async ensurePlaywrightAtUrl(
    scopeKey: string,
    url: string,
  ): Promise<{ success: true; navigated: boolean } | { success: false; result: ToolResult }> {
    const session = this.sessions.get(scopeKey);
    const currentUrl = session?.lastPlaywrightUrl;
    if (currentUrl === url) {
      return { success: true, navigated: false };
    }
    const result = await this.navigatePlaywright(scopeKey, url);
    if (!result.success) {
      return { success: false, result };
    }
    const summary = summarizeNavigationResult(result.output, url);
    const nextVersion = this.bumpPlaywrightStateVersion(scopeKey);
    this.updateSession(scopeKey, {
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
  const structured = unwrapToolOutput(outputToStructured(output));
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
  return unwrapToolOutput(outputToStructured(output));
}

function parseSnapshotRefs(snapshot: string): Array<{ ref: string; type: string; text: string }> {
  const elements: Array<{ ref: string; type: string; text: string }> = [];
  for (const line of snapshot.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const refMatch = trimmed.match(/\bref=([^\s\]]+)/i);
    if (!refMatch) continue;
    const ref = refMatch[1];
    const typeMatch = trimmed.match(/\b(button|link|textbox|input|checkbox|radio|combobox|option|tab|searchbox|textarea|menuitem|switch|slider|spinbutton)\b/i);
    if (!typeMatch?.[1]) continue;
    const type = typeMatch[1].toLowerCase();
    const text = trimmed
      .replace(/\bref=[^\s\]]+/i, '')
      .replace(/\b(button|link|textbox|input|checkbox|radio|combobox|option|tab|searchbox|textarea|menuitem|switch|slider|spinbutton)\b/i, '')
      .replace(/^[-:>\s]+/, '')
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

function buildPlaywrightEvaluatePayload(
  definition: ToolDefinition | undefined,
  fnSource: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const functionKey = pickDefinitionParameterKey(definition, ['function', 'expression', 'script', 'code'], 'function');
  payload[functionKey] = fnSource;
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
    // Playwright MCP wraps evaluate results in Markdown: "### Result\n...\n### Ran Playwright code"
    const resultBlock = extractPlaywrightResultBlock(output);
    if (resultBlock) {
      try {
        return JSON.parse(resultBlock);
      } catch {
        // not JSON inside the result block either
      }
    }
    return output;
  }
}

function extractPlaywrightResultBlock(text: string): string | null {
  const resultHeader = text.indexOf('### Result\n');
  if (resultHeader < 0) return null;
  const contentStart = resultHeader + '### Result\n'.length;
  const nextSection = text.indexOf('\n### ', contentStart);
  const block = (nextSection >= 0 ? text.slice(contentStart, nextSection) : text.slice(contentStart)).trim();
  return block || null;
}

function unwrapToolOutput(output: unknown): unknown {
  if (isRecord(output) && Object.prototype.hasOwnProperty.call(output, 'result')) {
    return outputToStructured(output.result);
  }
  return output;
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

function formatSemanticOutline(structuredData: unknown, snapshotText: string): string {
  const lines: string[] = [];
  const structured = isRecord(structuredData) ? structuredData : {};
  const metadata = isRecord(structured.metadata) ? structured.metadata : {};
  const title = asOptionalString(metadata.title);
  if (title) {
    lines.push(`Document: ${title}`);
  }

  const landmarks = Array.isArray(structured.landmarks) ? structured.landmarks : [];
  for (const landmark of landmarks) {
    if (!isRecord(landmark)) continue;
    const role = asOptionalString(landmark.role);
    const label = asOptionalString(landmark.label);
    if (!role) continue;
    lines.push(`- ${capitalize(role)}${label ? ` - ${label}` : ''}`);
  }

  const headings = Array.isArray(structured.headings) ? structured.headings : [];
  for (const heading of headings) {
    if (!isRecord(heading)) continue;
    const level = Math.max(1, Math.min(6, asNumber(heading.level, 1)));
    const text = asOptionalString(heading.text);
    if (!text) continue;
    lines.push(`${'  '.repeat(level - 1)}- h${level}: ${text}`);
  }

  const outline = lines.join('\n').trim();
  return outline || snapshotText.trim();
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
