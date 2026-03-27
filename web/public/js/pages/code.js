import { api } from '../api.js';
import { onSSE } from '../app.js';
import { registerAllThemes, THEME_REGISTRY } from '../monaco-themes.js';
import { themes, getSavedTheme } from '../theme.js';

const STORAGE_KEY = 'guardianagent_code_sessions_v2';
const DEFAULT_USER_CHANNEL = 'web';
const MAX_TERMINAL_PANES = 3;
const APPROVAL_BACKLOG_SOFT_CAP = 3;
const MAX_SESSION_JOBS = 20;
const MAX_TIMELINE_RUNS = 12;
const MAX_CHAT_FILE_REFERENCES = 6;
const MAX_CHAT_FILE_REFERENCE_SUGGESTIONS = 8;
const ASSISTANT_TABS = ['chat', 'activity'];
const INSPECTOR_TABS = ['investigate', 'flow', 'impact'];
const SESSION_REFRESH_INTERVAL_MS = 5000;
const STRUCTURE_PREVIEW_DEBOUNCE_MS = 350;
const MONACO_THEME_STORAGE_KEY = 'guardianagent_monaco_theme';
const MONACO_STRUCTURE_INSPECT_COMMAND = 'guardian.code.inspectSymbol';
const STRUCTURE_PREVIEWABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const MAX_VISUAL_SYMBOLS_PER_SECTION = 6;
const MAX_REPO_VISUAL_FILES_PER_SECTION = 6;
const REPO_IMPORT_RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const MAX_INVESTIGATION_HOTSPOTS = 5;

const SCROLL_SELECTORS = [
  '.code-file-list',
  '.code-chat__history',
  '.code-rail__list',
  '.code-assistant-panel__scroll',
  '.code-session-form',
  '.code-inspector__body',
  '.code-investigation-scope__sections',
];

let currentContainer = null;
let codeState = loadState();
let cachedAgents = [];
let cachedFileView = { source: '', diff: '', error: null };
let treeCache = new Map(); // keyed by absolute path → { entries, error }
let renderInFlight = false;
let hasRenderedOnce = false;
let codeViewLifecycleId = 0;
let detectedPlatform = 'linux'; // populated on first render from server
let shellOptionsCache = [];
let terminalListenersBound = false;
let runTimelineListenersBound = false;
let terminalRenderTimer = null;
let terminalUnloadBound = false;
let terminalLibPromise = null;
let terminalCssLoaded = false;
let terminalInstances = new Map();
let pendingSessionUiStateById = new Map();
let editorSearchStateBySessionId = new Map();
let sessionRefreshInterval = null;
let sessionPersistTimers = new Map();
let pendingTerminalFocusTabId = null;
let deferredSelectionRerenderTimer = null;
let activeChatReferencePicker = null;

// ─── Monaco Editor state ───────────────────────────────────
let monacoLoadPromise = null;
let monacoEditorInstance = null;
let monacoDiffInstance = null;
/** @type {Map<string, {model: any, viewState: any}>} — keyed by filePath */
let monacoModels = new Map();
let monacoThemesRegistered = false;
let currentMonacoTheme = localStorage.getItem(MONACO_THEME_STORAGE_KEY) || 'guardian-agent';
let monacoStructureCommandRegistered = false;
let monacoStructureProvidersRegistered = false;
let monacoStructureRefreshEmitter = null;
let monacoStructureSelectionDecorations = null;
let monacoStructureSelectionEditor = null;
let monacoSearchDecorations = null;
let monacoSearchDecorationEditor = null;
let structurePreviewStateBySessionId = new Map();
let inspectorPopupWindow = null;
let inspectorPopupSessionId = null;

/**
 * Dynamically load Monaco's AMD loader, then load editor.main.
 * Returns a Promise that resolves when window.monaco is ready.
 */
function loadMonaco() {
  if (monacoLoadPromise) return monacoLoadPromise;
  monacoLoadPromise = new Promise((resolve, reject) => {
    if (window.monaco) { resolve(); return; }
    const script = document.createElement('script');
    script.src = '/vendor/monaco/vs/loader.js';
    script.onload = () => {
      // Configure AMD require for Monaco
      window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
      window.require(['vs/editor/editor.main'], () => {
        if (!monacoThemesRegistered) {
          registerAllThemes(window.monaco);
          monacoThemesRegistered = true;
        }
        ensureMonacoStructureSupport();
        resolve();
      }, reject);
    };
    script.onerror = () => reject(new Error('Failed to load Monaco loader'));
    document.head.appendChild(script);
  });
  return monacoLoadPromise;
}

/**
 * Map file path to Monaco language ID.
 * Monaco has built-in tokenizers for 100+ languages.
 */
function mapMonacoLanguageId(filePath) {
  const name = basename(filePath || '').toLowerCase();
  if (!name) return 'plaintext';
  // Special filenames
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  if (name === '.gitignore' || name === '.dockerignore') return 'ignore';
  if (name.endsWith('.env') || name === '.env') return 'dotenv';
  const ext = name.includes('.') ? name.split('.').pop() : '';
  const map = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json',
    css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html',
    xml: 'xml', svg: 'xml', xsl: 'xml',
    md: 'markdown', markdown: 'markdown',
    yml: 'yaml', yaml: 'yaml',
    py: 'python', pyw: 'python',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    go: 'go',
    rs: 'rust',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
    cs: 'csharp',
    java: 'java',
    rb: 'ruby', rake: 'ruby',
    php: 'php',
    sql: 'sql',
    graphql: 'graphql', gql: 'graphql',
    swift: 'swift',
    kt: 'kotlin', kts: 'kotlin',
    lua: 'lua',
    r: 'r', rmd: 'r',
    toml: 'ini', ini: 'ini', cfg: 'ini',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
    bat: 'bat', cmd: 'bat',
    pl: 'perl', pm: 'perl',
    dart: 'dart',
    scala: 'scala',
    clj: 'clojure', cljs: 'clojure', cljc: 'clojure',
    ex: 'elixir', exs: 'elixir',
    erl: 'erlang',
    hs: 'haskell',
    tf: 'hcl', tfvars: 'hcl',
    proto: 'protobuf',
    dockerfile: 'dockerfile',
  };
  return map[ext] || 'plaintext';
}

/**
 * Get or create a Monaco text model for a file path.
 */
function getOrCreateModel(filePath, content) {
  const monaco = window.monaco;
  if (!monaco) return null;
  const existing = monacoModels.get(filePath);
  if (existing?.model && !existing.model.isDisposed()) {
    return existing.model;
  }
  const uri = monaco.Uri.file(filePath);
  // Check if model already exists in Monaco (e.g. from another path)
  let model = monaco.editor.getModel(uri);
  if (!model) {
    const lang = mapMonacoLanguageId(filePath);
    model = monaco.editor.createModel(content || '', lang, uri);
  }
  monacoModels.set(filePath, { model, viewState: null });
  return model;
}

/**
 * Dispose all Monaco models and editor instances.
 */
function disposeMonacoEditors() {
  monacoSearchDecorations?.clear();
  monacoSearchDecorations = null;
  monacoSearchDecorationEditor = null;
  if (monacoEditorInstance) {
    monacoEditorInstance.dispose();
    monacoEditorInstance = null;
    monacoStructureSelectionDecorations = null;
    monacoStructureSelectionEditor = null;
  }
  if (monacoDiffInstance) {
    // Dispose the original model (modified model is managed by monacoModels)
    const diffModel = monacoDiffInstance.getModel();
    if (diffModel?.original && !diffModel.original.isDisposed()) {
      diffModel.original.dispose();
    }
    monacoDiffInstance.dispose();
    monacoDiffInstance = null;
    monacoStructureSelectionDecorations = null;
    monacoStructureSelectionEditor = null;
  }
}

/**
 * Dispose a specific model by file path.
 */
function disposeModel(filePath) {
  const entry = monacoModels.get(filePath);
  if (entry?.model && !entry.model.isDisposed()) {
    entry.model.dispose();
  }
  monacoModels.delete(filePath);
}

/**
 * Dispose all models (used on session switch).
 */
function disposeAllModels() {
  for (const [, entry] of monacoModels) {
    if (entry?.model && !entry.model.isDisposed()) {
      entry.model.dispose();
    }
  }
  monacoModels.clear();
}

function normalizeStructureRange(range) {
  if (!range || typeof range !== 'object') return null;
  const startLine = Number(range.startLine) || 0;
  const startColumn = Number(range.startColumn) || 0;
  const endLine = Number(range.endLine) || 0;
  const endColumn = Number(range.endColumn) || 0;
  if (startLine <= 0 || startColumn <= 0 || endLine <= 0 || endColumn <= 0) return null;
  return { startLine, startColumn, endLine, endColumn };
}

function normalizeStructureSymbol(symbol) {
  if (!symbol || typeof symbol !== 'object') return null;
  const range = normalizeStructureRange(symbol.range);
  if (!range) return null;
  const id = String(symbol.id || '').trim();
  const name = String(symbol.name || '').trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    qualifiedName: String(symbol.qualifiedName || name),
    kind: String(symbol.kind || 'function'),
    parentId: symbol.parentId ? String(symbol.parentId) : null,
    exported: !!symbol.exported,
    async: !!symbol.async,
    range,
    lineCount: Number(symbol.lineCount) || Math.max(1, range.endLine - range.startLine + 1),
    signature: String(symbol.signature || ''),
    summary: String(symbol.summary || ''),
    excerpt: String(symbol.excerpt || ''),
    params: Array.isArray(symbol.params) ? symbol.params.map((value) => String(value)) : [],
    returnHint: String(symbol.returnHint || ''),
    sideEffects: Array.isArray(symbol.sideEffects) ? symbol.sideEffects.map((value) => String(value)) : [],
    trustBoundaryTags: Array.isArray(symbol.trustBoundaryTags) ? symbol.trustBoundaryTags.map((value) => String(value)) : [],
    qualityNotes: Array.isArray(symbol.qualityNotes) ? symbol.qualityNotes.map((value) => String(value)) : [],
    securityNotes: Array.isArray(symbol.securityNotes) ? symbol.securityNotes.map((value) => String(value)) : [],
    callees: Array.isArray(symbol.callees) ? symbol.callees.map((value) => String(value)) : [],
    callers: Array.isArray(symbol.callers) ? symbol.callers.map((value) => String(value)) : [],
  };
}

function normalizeStructureSection(section) {
  if (!section || typeof section !== 'object') return null;
  const id = String(section.id || '').trim();
  const title = String(section.title || '').trim();
  const range = normalizeStructureRange(section.range);
  if (!id || !title || !range) return null;
  return {
    id,
    title,
    summary: String(section.summary || ''),
    kind: String(section.kind || 'window'),
    range,
    lineCount: Number(section.lineCount) || Math.max(1, range.endLine - range.startLine + 1),
  };
}

function normalizeStructureView(value, existing = {}) {
  if (!value || typeof value !== 'object') {
    return {
      path: '',
      language: '',
      supported: false,
      summary: '',
      provenance: 'deterministic_ast',
      analyzedAt: 0,
      importSources: [],
      exports: [],
      symbols: [],
      analysisMode: 'full',
      fileBytes: 0,
      totalLines: 0,
      sections: [],
      selectedSectionId: null,
      selectedLine: null,
      unsupportedReason: '',
      error: '',
      selectedSymbolId: existing.selectedSymbolId || null,
      revealSymbolId: null,
    };
  }
  const normalizedSymbols = Array.isArray(value.symbols)
    ? value.symbols.map((symbol) => normalizeStructureSymbol(symbol)).filter(Boolean)
    : [];
  const normalizedSections = Array.isArray(value.sections)
    ? value.sections.map((section) => normalizeStructureSection(section)).filter(Boolean)
    : [];
  const samePathAsExisting = String(existing.path || '') === String(value.path || '');
  const selectedSymbolId = samePathAsExisting && normalizedSymbols.some((symbol) => symbol.id === existing.selectedSymbolId)
    ? existing.selectedSymbolId
    : normalizedSymbols[0]?.id || null;
  const selectedSectionId = normalizedSections.some((section) => section.id === value.selectedSectionId)
    ? String(value.selectedSectionId)
    : samePathAsExisting && normalizedSections.some((section) => section.id === existing.selectedSectionId)
      ? existing.selectedSectionId
      : normalizedSections[0]?.id || null;
  return {
    path: String(value.path || ''),
    language: String(value.language || ''),
    supported: value.supported !== false,
    summary: String(value.summary || ''),
    provenance: String(value.provenance || 'deterministic_ast'),
    analyzedAt: Number(value.analyzedAt) || 0,
    importSources: Array.isArray(value.importSources) ? value.importSources.map((entry) => String(entry)) : [],
    exports: Array.isArray(value.exports) ? value.exports.map((entry) => String(entry)) : [],
    symbols: normalizedSymbols,
    analysisMode: String(value.analysisMode || 'full'),
    fileBytes: Number(value.fileBytes) || 0,
    totalLines: Number(value.totalLines) || 0,
    sections: normalizedSections,
    selectedSectionId,
    selectedLine: Number(value.selectedLine) || null,
    unsupportedReason: String(value.unsupportedReason || ''),
    error: String(value.error || ''),
    selectedSymbolId,
    revealSymbolId: null,
  };
}

function isStructurePreviewablePath(filePath) {
  const lowerPath = String(filePath || '').toLowerCase();
  if (!lowerPath.includes('.')) return false;
  const extension = `.${lowerPath.split('.').pop()}`;
  return STRUCTURE_PREVIEWABLE_EXTENSIONS.has(extension);
}

function createStructurePreviewState(filePath = '') {
  return {
    filePath,
    editVersion: 0,
    requestSerial: 0,
    appliedEditVersion: 0,
    lastError: '',
    mode: 'saved',
    timer: null,
  };
}

function getStructurePreviewState(sessionId, filePath = '') {
  const key = String(sessionId || '');
  const existing = structurePreviewStateBySessionId.get(key);
  if (existing && existing.filePath === filePath) {
    return existing;
  }
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  const next = createStructurePreviewState(filePath);
  structurePreviewStateBySessionId.set(key, next);
  return next;
}

function invalidateStructurePreviewState(sessionId, filePath = '') {
  const key = String(sessionId || '');
  if (!key) return;
  const state = structurePreviewStateBySessionId.get(key) || createStructurePreviewState(filePath);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.filePath = filePath;
  state.requestSerial += 1;
  state.editVersion = 0;
  state.appliedEditVersion = 0;
  state.lastError = '';
  state.mode = 'saved';
  structurePreviewStateBySessionId.set(key, state);
}

function getStructurePreviewBanner(session) {
  const activeTab = getActiveTab(session);
  if (!activeTab?.dirty || !isStructurePreviewablePath(activeTab.filePath)) return '';
  const previewState = structurePreviewStateBySessionId.get(session.id);
  if (previewState?.lastError) {
    return `<div class="code-tab-banner is-warning">${esc(previewState.lastError)}</div>`;
  }
  if (previewState?.mode === 'preview' && previewState.appliedEditVersion === previewState.editVersion) {
    return '<div class="code-tab-banner is-info">Live structure preview reflects your unsaved editor changes.</div>';
  }
  return '<div class="code-tab-banner is-info">Live structure preview updates after a short pause while you type.</div>';
}

function getSelectedStructureSymbol(session) {
  if (!isStructureViewCurrentFile(session)) return null;
  const structureView = session?.structureView;
  if (!structureView || !Array.isArray(structureView.symbols) || structureView.symbols.length === 0) return null;
  return structureView.symbols.find((symbol) => symbol.id === structureView.selectedSymbolId) || structureView.symbols[0] || null;
}

function getSelectedStructurePath(session) {
  return toRelativePath(session?.selectedFilePath || '', session?.resolvedRoot || session?.workspaceRoot || '');
}

function getCurrentStructureSection(structureView) {
  if (!structureView || !Array.isArray(structureView.sections) || structureView.sections.length === 0) return null;
  return structureView.sections.find((section) => section.id === structureView.selectedSectionId) || structureView.sections[0] || null;
}

function isSectionedStructureView(structureView) {
  return structureView?.analysisMode === 'sectioned' && Array.isArray(structureView.sections) && structureView.sections.length > 0;
}

function isStructureViewCurrentFile(session) {
  const structurePath = String(session?.structureView?.path || '');
  if (!structurePath) return false;
  const selectedPath = String(getSelectedStructurePath(session) || '');
  return !!selectedPath && structurePath === selectedPath;
}

function getCurrentCursorLineNumber() {
  return getActiveMonacoEditor()?.getPosition()?.lineNumber || 0;
}

function getCurrentViewportAnchorLineNumber() {
  const editor = getActiveMonacoEditor();
  const visibleLine = editor?.getVisibleRanges?.()?.[0]?.startLineNumber || 0;
  return visibleLine || getCurrentCursorLineNumber();
}

function resolveStructureRequestSectionId(session, preferredLineNumber = 0, explicitSectionId = '') {
  const requestedSectionId = String(explicitSectionId || '').trim();
  if (requestedSectionId) return requestedSectionId;
  const structureView = session?.structureView;
  if (!isSectionedStructureView(structureView)) return '';
  const selectedPath = getSelectedStructurePath(session);
  if (selectedPath && selectedPath !== structureView.path) return '';
  const currentSection = getCurrentStructureSection(structureView);
  if (!currentSection) return '';
  if (preferredLineNumber > 0) {
    const inCurrentSection = (
      preferredLineNumber >= currentSection.range.startLine
      && preferredLineNumber <= currentSection.range.endLine
    );
    return inCurrentSection ? currentSection.id : '';
  }
  return currentSection.id;
}

function formatStructureLineRange(range) {
  if (!range) return '';
  return `lines ${range.startLine}-${range.endLine}`;
}

function formatByteSize(bytes) {
  const size = Number(bytes) || 0;
  if (size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function joinListWithAnd(values) {
  const unique = Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
  if (unique.length === 0) return '';
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
}

function describeSideEffectSurface(effect) {
  switch (String(effect || '')) {
    case 'network':
      return 'outbound network services';
    case 'filesystem':
      return 'the filesystem';
    case 'process execution':
      return 'local processes and shell execution';
    case 'environment access':
      return 'environment-backed configuration';
    case 'browser state':
      return 'browser session and local state';
    case 'database':
      return 'database queries or persistence';
    case 'timers/events':
      return 'timers and event hooks';
    case 'logging':
      return 'logging and observability';
    case 'html injection surface':
      return 'HTML rendering surfaces';
    default:
      return String(effect || '').trim();
  }
}

function scoreInvestigationSymbol(symbol) {
  if (!symbol) return 0;
  const processRisk = symbol.sideEffects.includes('process execution') ? 4 : 0;
  const htmlRisk = symbol.sideEffects.includes('html injection surface') ? 3 : 0;
  return (
    (symbol.securityNotes.length * 5)
    + (symbol.trustBoundaryTags.length * 3)
    + (symbol.sideEffects.length * 2)
    + (symbol.qualityNotes.length * 2)
    + processRisk
    + htmlRisk
    + Math.min(3, symbol.callers.length)
    + Math.min(3, symbol.callees.length)
    + (symbol.exported ? 1 : 0)
    + (symbol.lineCount >= 80 ? 2 : symbol.lineCount >= 45 ? 1 : 0)
  );
}

function classifyHotspotSeverity(symbol) {
  if (!symbol) return 'info';
  if (
    symbol.sideEffects.includes('process execution')
    || symbol.sideEffects.includes('html injection surface')
    || symbol.securityNotes.length >= 2
    || symbol.trustBoundaryTags.includes('process-execution')
  ) {
    return 'high';
  }
  if (symbol.securityNotes.length > 0 || symbol.trustBoundaryTags.length > 0 || symbol.qualityNotes.length >= 2) {
    return 'warn';
  }
  return 'info';
}

function buildHotspotTitle(symbol) {
  if (symbol.securityNotes.length > 0) return symbol.securityNotes[0];
  if (symbol.sideEffects.includes('process execution')) return 'Executes local processes or shell commands';
  if (symbol.sideEffects.includes('network')) return 'Calls outbound network services';
  if (symbol.sideEffects.includes('filesystem')) return 'Reads from or writes to the filesystem';
  if (symbol.sideEffects.includes('html injection surface')) return 'Writes directly to HTML rendering surfaces';
  if (symbol.qualityNotes.length > 0) return symbol.qualityNotes[0];
  return `${symbol.name} is a notable investigation point`;
}

function buildHotspotNarrative(symbol) {
  const surfaces = joinListWithAnd(symbol.sideEffects.map((effect) => describeSideEffectSurface(effect)));
  const impact = [];
  if (symbol.callers.length > 0) impact.push(`${symbol.callers.length} local caller${symbol.callers.length === 1 ? '' : 's'}`);
  if (symbol.callees.length > 0) impact.push(`${symbol.callees.length} local callee${symbol.callees.length === 1 ? '' : 's'}`);
  const surfaceCopy = surfaces ? `It touches ${surfaces}.` : '';
  const impactCopy = impact.length > 0 ? ` It connects to ${joinListWithAnd(impact)}.` : '';
  return `${symbol.summary || `${symbol.name} is a deterministic inspection target.`} ${surfaceCopy}${impactCopy}`.trim();
}

function buildInvestigationHotspots(structureView) {
  const symbols = Array.isArray(structureView?.symbols) ? structureView.symbols : [];
  return [...symbols]
    .sort((left, right) => (
      scoreInvestigationSymbol(right) - scoreInvestigationSymbol(left)
      || right.securityNotes.length - left.securityNotes.length
      || right.qualityNotes.length - left.qualityNotes.length
      || left.range.startLine - right.range.startLine
    ))
    .slice(0, MAX_INVESTIGATION_HOTSPOTS)
    .map((symbol) => ({
      symbol,
      severity: classifyHotspotSeverity(symbol),
      title: buildHotspotTitle(symbol),
      narrative: buildHotspotNarrative(symbol),
    }));
}

function pickInvestigationFocusSymbol(structureView) {
  const selected = getSelectedStructureSymbol({ structureView });
  if (selected) return selected;
  const hotspots = buildInvestigationHotspots(structureView);
  return hotspots[0]?.symbol || null;
}

function buildInvestigationBehaviorCopy(structureView, focusSymbol) {
  const currentSection = getCurrentStructureSection(structureView);
  if (focusSymbol) {
    const relationBits = [];
    if (focusSymbol.callers.length > 0) relationBits.push(`it is reached by ${focusSymbol.callers.length} local caller${focusSymbol.callers.length === 1 ? '' : 's'}`);
    if (focusSymbol.callees.length > 0) relationBits.push(`it fans out to ${focusSymbol.callees.length} local callee${focusSymbol.callees.length === 1 ? '' : 's'}`);
    const relationCopy = relationBits.length > 0 ? ` Within this scope, ${joinListWithAnd(relationBits)}.` : '';
    const sectionCopy = currentSection ? ` The current investigation slice is ${currentSection.title.toLowerCase()} (${formatStructureLineRange(currentSection.range)}).` : '';
    return `${focusSymbol.summary || `${focusSymbol.name} is the current focus.`}${relationCopy}${sectionCopy}`;
  }
  const symbolCount = Array.isArray(structureView?.symbols) ? structureView.symbols.length : 0;
  return `This scope currently exposes ${symbolCount} symbol${symbolCount === 1 ? '' : 's'} for investigation. Use hotspots below to pick the best starting point.`;
}

function buildInvestigationSurfaceSummary(structureView) {
  const symbols = Array.isArray(structureView?.symbols) ? structureView.symbols : [];
  const surfaces = Array.from(new Set(symbols.flatMap((symbol) => symbol.sideEffects).map((effect) => describeSideEffectSurface(effect)).filter(Boolean)));
  if (surfaces.length === 0) {
    return {
      headline: 'This scope does not currently expose deterministic network, filesystem, process, or browser-state side effects.',
      items: [],
    };
  }
  return {
    headline: `This scope talks to ${joinListWithAnd(surfaces.slice(0, 5))}.`,
    items: surfaces.slice(0, 6),
  };
}

function buildInvestigationRiskSummary(structureView) {
  const hotspots = buildInvestigationHotspots(structureView);
  const risky = hotspots.filter((hotspot) => hotspot.severity !== 'info');
  if (risky.length === 0) {
    return 'No high-confidence deterministic risks were surfaced in this scope, but you should still review input validation and caller context before treating it as safe.';
  }
  return `${risky.length} hotspot${risky.length === 1 ? '' : 's'} should be reviewed first because they cross trust boundaries, execute risky side effects, or concentrate complex logic.`;
}

function buildInvestigationQualitySummary(structureView) {
  const symbols = Array.isArray(structureView?.symbols) ? structureView.symbols : [];
  const qualityNotes = Array.from(new Set(symbols.flatMap((symbol) => symbol.qualityNotes).filter(Boolean)));
  if (qualityNotes.length === 0) {
    return 'No deterministic quality warnings were raised in this scope.';
  }
  return qualityNotes.slice(0, 3).join(' ');
}

function buildInvestigationNextSteps(structureView, focusSymbol, hotspots) {
  const steps = [];
  if (focusSymbol) {
    steps.push(`Reveal \`${focusSymbol.name}\` in the editor and verify how data enters the symbol before it reaches side effects.`);
    if (focusSymbol.callers.length > 0) {
      steps.push(`Open Flow to trace who calls \`${focusSymbol.name}\` and whether those callers validate inputs first.`);
    }
    if (focusSymbol.callees.length > 0) {
      steps.push(`Use Flow to inspect which downstream helpers or services \`${focusSymbol.name}\` invokes next.`);
    }
  }
  if (hotspots[0]?.symbol && hotspots[0].symbol.id !== focusSymbol?.id) {
    steps.push(`Compare the current focus with hotspot \`${hotspots[0].symbol.name}\` to see which symbol concentrates the higher-risk operations.`);
  }
  steps.push('Switch to Impact to see which files are likely to move if this code changes or misbehaves.');
  return steps.slice(0, 4);
}

function buildFlowNarrative(symbol) {
  if (!symbol) return 'Select a symbol to explain how control flows through the current file.';
  const surfaces = joinListWithAnd(symbol.sideEffects.map((effect) => describeSideEffectSurface(effect)));
  const relations = [];
  if (symbol.callers.length > 0) relations.push(`${symbol.callers.length} upstream caller${symbol.callers.length === 1 ? '' : 's'}`);
  if (symbol.callees.length > 0) relations.push(`${symbol.callees.length} downstream callee${symbol.callees.length === 1 ? '' : 's'}`);
  const relationCopy = relations.length > 0 ? ` In this file, it connects to ${joinListWithAnd(relations)}.` : '';
  const surfaceCopy = surfaces ? ` It touches ${surfaces}.` : '';
  return `${symbol.summary || `${symbol.name} is the current flow focus.`}${surfaceCopy}${relationCopy}`;
}

function buildFlowRiskCopy(symbol) {
  if (!symbol) return 'No symbol is selected yet.';
  const notes = [...symbol.securityNotes, ...symbol.qualityNotes].filter(Boolean);
  if (notes.length === 0) {
    return 'This symbol does not currently surface high-confidence deterministic risks, but you should still inspect caller inputs before treating it as safe.';
  }
  return notes.slice(0, 3).join(' ');
}

function buildFlowNextSteps(symbol) {
  if (!symbol) return ['Select a symbol, then use Reveal to jump to it in the editor.'];
  const steps = [];
  if (symbol.callers.length > 0) {
    steps.push(`Trace upstream callers into \`${symbol.name}\` to see where data or control enters this symbol.`);
  }
  if (symbol.callees.length > 0) {
    steps.push(`Inspect the downstream calls from \`${symbol.name}\` to see where side effects or state changes happen next.`);
  }
  if (symbol.sideEffects.length > 0) {
    steps.push(`Verify how inputs are validated before \`${symbol.name}\` reaches ${joinListWithAnd(symbol.sideEffects)}.`);
  }
  if (steps.length === 0) {
    steps.push(`Use Impact next if \`${symbol.name}\` looks safe locally but may still have repo-wide consequences.`);
  }
  return steps.slice(0, 3);
}

function buildImpactNarrative(currentEntry, importedByFiles, importedFiles, peerFiles) {
  if (!currentEntry?.path) {
    return 'Select a file to explain how changes in it could spread through the repo.';
  }
  const pathLabel = basename(currentEntry.path);
  return `${pathLabel} currently has ${importedByFiles.length} inbound dependent${importedByFiles.length === 1 ? '' : 's'}, ${importedFiles.length} local dependenc${importedFiles.length === 1 ? 'y' : 'ies'}, and ${peerFiles.length} nearby file${peerFiles.length === 1 ? '' : 's'} in the same directory.`;
}

function buildImpactRiskCopy(importedByFiles, importedFiles, workingSetFiles, notableFiles) {
  if (importedByFiles.length >= 5) {
    return 'This file has a broad inbound blast radius. Review dependents before changing exported behavior or signatures.';
  }
  if (importedFiles.length >= 5) {
    return 'This file fans out to many local dependencies. Changes here may hide a wider regression surface downstream.';
  }
  if (workingSetFiles.length > 0 || notableFiles.length > 0) {
    return 'This file overlaps with the current working set or notable repo files, so changes here are more likely to affect an active investigation path.';
  }
  return 'Impact does not currently suggest a wide deterministic blast radius, but nearby repo context is still worth checking before you refactor shared code.';
}

function buildImpactNextSteps(currentEntry, importedByFiles, importedFiles, workingSetFiles) {
  if (!currentEntry?.path) {
    return ['Open a file in the editor to anchor repo impact analysis.'];
  }
  const steps = [];
  if (importedByFiles.length > 0) {
    steps.push(`Review inbound dependents first to see which files rely on \`${basename(currentEntry.path)}\`.`);
  }
  if (importedFiles.length > 0) {
    steps.push(`Inspect downstream dependencies to understand what this file talks to before you change it.`);
  }
  if (workingSetFiles.length > 0) {
    steps.push('Cross-check the working set because those files are already active in the current coding session.');
  }
  if (steps.length === 0) {
    steps.push('Use Flow if the repo blast radius looks small and you need a deeper symbol-level explanation instead.');
  }
  return steps.slice(0, 3);
}

function isAssistantTab(value) {
  return ASSISTANT_TABS.includes(value);
}

function normalizeAssistantTabValue(value) {
  if (value === 'tasks' || value === 'approvals' || value === 'checks') return 'activity';
  return isAssistantTab(value) ? value : 'chat';
}

function isInspectorTab(value) {
  return INSPECTOR_TABS.includes(value);
}

function normalizeInspectorTabValue(value) {
  if (value === 'structure') return 'investigate';
  if (value === 'visual') return 'flow';
  if (value === 'repo') return 'impact';
  return isInspectorTab(value) ? value : 'investigate';
}

function getActiveMonacoEditor() {
  return monacoDiffInstance?.getModifiedEditor?.() || monacoEditorInstance;
}

function getEditorSearchState(sessionOrId, { create = true } = {}) {
  const sessionId = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId?.id;
  if (!sessionId) return null;
  let state = editorSearchStateBySessionId.get(sessionId);
  if (!state && create) {
    state = {
      query: '',
      filePath: '',
      matches: [],
      currentIndex: -1,
    };
    editorSearchStateBySessionId.set(sessionId, state);
  }
  return state || null;
}

function resetMonacoEditorSearchDecorations() {
  monacoSearchDecorations?.clear();
  monacoSearchDecorations = null;
  monacoSearchDecorationEditor = null;
}

function ensureMonacoEditorSearchDecorations(editor) {
  if (!editor) return null;
  if (!monacoSearchDecorations || monacoSearchDecorationEditor !== editor) {
    resetMonacoEditorSearchDecorations();
    monacoSearchDecorations = editor.createDecorationsCollection();
    monacoSearchDecorationEditor = editor;
  }
  return monacoSearchDecorations;
}

function findEditorSearchMatches(editor, query) {
  const model = editor?.getModel?.();
  if (!model || !query) return [];
  return model.findMatches(query, false, false, false, null, false);
}

function applyEditorSearchDecorations(editor, state) {
  const monaco = window.monaco;
  if (!monaco || !editor || !state?.query || !Array.isArray(state.matches) || state.matches.length === 0) {
    resetMonacoEditorSearchDecorations();
    return;
  }
  const collection = ensureMonacoEditorSearchDecorations(editor);
  if (!collection) return;
  collection.set(state.matches.map((match, index) => ({
    range: match.range,
    options: {
      inlineClassName: index === state.currentIndex ? 'code-editor-search-match is-current' : 'code-editor-search-match',
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  })));
}

function revealEditorSearchMatch(editor, match) {
  if (!editor || !match?.range) return;
  if (typeof editor.setSelection === 'function') {
    editor.setSelection(match.range);
  } else if (typeof editor.setPosition === 'function') {
    editor.setPosition({
      lineNumber: match.range.startLineNumber,
      column: match.range.startColumn,
    });
  }
  if (typeof editor.revealRangeNearTop === 'function') {
    editor.revealRangeNearTop(match.range);
  } else if (typeof editor.revealRangeInCenter === 'function') {
    editor.revealRangeInCenter(match.range);
  }
}

function updateEditorSearchControls(session = getActiveSession()) {
  if (!currentContainer) return;
  const input = currentContainer.querySelector('[data-code-editor-search-input]');
  const status = currentContainer.querySelector('[data-code-editor-search-status]');
  const previousButton = currentContainer.querySelector('[data-code-editor-search-prev]');
  const nextButton = currentContainer.querySelector('[data-code-editor-search-next]');
  const clearButton = currentContainer.querySelector('[data-code-editor-search-clear]');
  const activeFilePath = getActiveTab(session)?.filePath || session?.selectedFilePath || '';
  const state = getEditorSearchState(session, { create: false });
  const query = state?.query || '';
  const matches = state?.filePath === activeFilePath && Array.isArray(state?.matches) ? state.matches : [];
  const currentIndex = matches.length > 0 && Number.isFinite(state?.currentIndex) ? state.currentIndex + 1 : 0;
  if (input instanceof HTMLInputElement && input.value !== query) {
    input.value = query;
  }
  if (status) {
    status.textContent = query ? `${currentIndex}/${matches.length}` : 'Find in file';
  }
  if (previousButton) previousButton.disabled = matches.length === 0;
  if (nextButton) nextButton.disabled = matches.length === 0;
  if (clearButton) clearButton.hidden = !query;
}

function syncEditorSearchState(session = getActiveSession(), { reveal = false, preserveIndex = true } = {}) {
  const state = getEditorSearchState(session, { create: !!session });
  if (!session || !state) {
    resetMonacoEditorSearchDecorations();
    updateEditorSearchControls(null);
    return null;
  }
  const editor = getActiveMonacoEditor();
  const activeFilePath = getActiveTab(session)?.filePath || session.selectedFilePath || '';
  if (!editor || !activeFilePath) {
    state.matches = [];
    state.currentIndex = -1;
    state.filePath = activeFilePath;
    resetMonacoEditorSearchDecorations();
    updateEditorSearchControls(session);
    return state;
  }
  if (!state.query) {
    state.matches = [];
    state.currentIndex = -1;
    state.filePath = activeFilePath;
    resetMonacoEditorSearchDecorations();
    updateEditorSearchControls(session);
    return state;
  }
  const fileChanged = state.filePath !== activeFilePath;
  state.matches = findEditorSearchMatches(editor, state.query);
  state.filePath = activeFilePath;
  if (state.matches.length === 0) {
    state.currentIndex = -1;
  } else if (fileChanged || !preserveIndex || state.currentIndex < 0 || state.currentIndex >= state.matches.length) {
    state.currentIndex = 0;
  }
  applyEditorSearchDecorations(editor, state);
  if (reveal && state.currentIndex >= 0) {
    revealEditorSearchMatch(editor, state.matches[state.currentIndex]);
  }
  updateEditorSearchControls(session);
  return state;
}

function setEditorSearchQuery(session, query, { reveal = true } = {}) {
  const state = getEditorSearchState(session, { create: !!session });
  if (!state) return null;
  state.query = String(query || '');
  state.currentIndex = -1;
  return syncEditorSearchState(session, {
    reveal,
    preserveIndex: false,
  });
}

function navigateEditorSearch(session = getActiveSession(), direction = 1) {
  const state = syncEditorSearchState(session, { reveal: false, preserveIndex: true });
  if (!state || !Array.isArray(state.matches) || state.matches.length === 0) return;
  const total = state.matches.length;
  const currentIndex = Number.isFinite(state.currentIndex) ? state.currentIndex : -1;
  state.currentIndex = currentIndex < 0
    ? 0
    : (currentIndex + direction + total) % total;
  applyEditorSearchDecorations(getActiveMonacoEditor(), state);
  revealEditorSearchMatch(getActiveMonacoEditor(), state.matches[state.currentIndex]);
  updateEditorSearchControls(session);
}

function renderEditorSearchToolbar(session) {
  const state = getEditorSearchState(session, { create: false });
  const activeFilePath = getActiveTab(session)?.filePath || session?.selectedFilePath || '';
  const query = state?.query || '';
  const matches = state?.filePath === activeFilePath && Array.isArray(state?.matches) ? state.matches : [];
  const currentIndex = matches.length > 0 && Number.isFinite(state?.currentIndex) ? state.currentIndex + 1 : 0;
  return `
    <div class="code-editor__toolbar-search" role="search" aria-label="Search in current file">
      <input
        class="code-editor__search-input"
        type="text"
        value="${escAttr(query)}"
        placeholder="Search in file"
        data-code-editor-search-input
      >
      <span class="code-editor__search-status" data-code-editor-search-status>${query ? `${currentIndex}/${matches.length}` : 'Find in file'}</span>
      <button class="btn btn-secondary btn-sm" type="button" data-code-editor-search-prev title="Previous match"${matches.length === 0 ? ' disabled' : ''}>Prev</button>
      <button class="btn btn-secondary btn-sm" type="button" data-code-editor-search-next title="Next match"${matches.length === 0 ? ' disabled' : ''}>Next</button>
      <button class="btn btn-secondary btn-sm" type="button" data-code-editor-search-clear title="Clear search"${query ? '' : ' hidden'}>Clear</button>
    </div>
  `;
}

function findStructureSymbolByLine(structureView, lineNumber) {
  if (!structureView || !Array.isArray(structureView.symbols) || !Number.isFinite(lineNumber)) return null;
  const matches = structureView.symbols.filter((symbol) => (
    symbol.range.startLine <= lineNumber && symbol.range.endLine >= lineNumber
  ));
  if (matches.length === 0) return null;
  matches.sort((left, right) => (
    (left.range.endLine - left.range.startLine) - (right.range.endLine - right.range.startLine)
    || left.range.startLine - right.range.startLine
  ));
  return matches[0];
}

function reconcileStructureSelection(previousView, nextView, preferredLineNumber = 0) {
  if (!nextView || !Array.isArray(nextView.symbols) || nextView.symbols.length === 0) {
    return nextView;
  }
  const previousSelected = previousView?.path === nextView.path
    ? (previousView?.symbols?.find((symbol) => symbol.id === previousView.selectedSymbolId) || null)
    : null;
  let selectedSymbol = null;
  if (previousSelected) {
    selectedSymbol = nextView.symbols.find((symbol) => (
      symbol.qualifiedName === previousSelected.qualifiedName
      && symbol.kind === previousSelected.kind
    )) || null;
  }
  if (!selectedSymbol && Number.isFinite(preferredLineNumber) && preferredLineNumber > 0) {
    selectedSymbol = findStructureSymbolByLine(nextView, preferredLineNumber);
  }
  if (!selectedSymbol) {
    selectedSymbol = nextView.symbols[0] || null;
  }
  nextView.selectedSymbolId = selectedSymbol?.id || null;
  nextView.revealSymbolId = null;
  return nextView;
}

function triggerMonacoStructureRefresh() {
  monacoStructureRefreshEmitter?.fire();
}

function isInspectorOpen(session) {
  return !!session?.inspectorOpen;
}

function openInspector(session, tab = 'investigate') {
  if (!session) return;
  session.inspectorOpen = true;
  session.inspectorTab = normalizeInspectorTabValue(tab);
  saveState(codeState);
}

function closeDetachedInspectorWindow() {
  const popupSession = inspectorPopupSessionId ? getSessionById(inspectorPopupSessionId) : null;
  if (popupSession) {
    popupSession.inspectorDetached = false;
  }
  if (inspectorPopupWindow && !inspectorPopupWindow.closed) {
    inspectorPopupWindow.__guardianClosing = true;
    inspectorPopupWindow.close();
  }
  inspectorPopupWindow = null;
  inspectorPopupSessionId = null;
}

function closeInspector(session) {
  if (!session) return;
  session.inspectorOpen = false;
  session.inspectorDetached = false;
  closeDetachedInspectorWindow();
  saveState(codeState);
}

function focusCurrentEditorSymbol(session, tab = 'investigate') {
  if (!session) return false;
  openInspector(session, tab);
  const structureView = isStructureViewCurrentFile(session) ? session.structureView : null;
  const anchorLineNumber = getCurrentViewportAnchorLineNumber();
  const symbol = findStructureSymbolByLine(structureView, anchorLineNumber)
    || getSelectedStructureSymbol(session)
    || structureView?.symbols?.[0]
    || null;
  if (!symbol) {
    return false;
  }
  focusStructureSymbol(session, symbol.id, { reveal: false, switchTab: false });
  return true;
}

function focusStructureSymbol(sessionOrId, symbolId, { reveal = true, switchTab = true } = {}) {
  const session = typeof sessionOrId === 'string' ? getSessionById(sessionOrId) : sessionOrId;
  if (!session?.structureView || !isStructureViewCurrentFile(session)) return;
  const symbol = session.structureView.symbols.find((entry) => entry.id === symbolId);
  if (!symbol) return;
  session.structureView.selectedSymbolId = symbol.id;
  session.structureView.revealSymbolId = reveal ? symbol.id : null;
  if (switchTab) {
    openInspector(session, 'investigate');
  }
  saveState(codeState);
  queueSessionPersist(session);
  rerenderFromState();
}

function ensureMonacoStructureSupport() {
  const monaco = window.monaco;
  if (!monaco) return;

  if (!monacoStructureRefreshEmitter) {
    monacoStructureRefreshEmitter = new monaco.Emitter();
  }

  if (!monacoStructureCommandRegistered) {
    monaco.editor.registerCommand(MONACO_STRUCTURE_INSPECT_COMMAND, (_accessor, sessionId, symbolId) => {
      if (!sessionId || !symbolId) return;
      focusStructureSymbol(String(sessionId), String(symbolId), { reveal: false, switchTab: true });
    });
    monacoStructureCommandRegistered = true;
  }

  if (!monacoStructureProvidersRegistered) {
    ['typescript', 'javascript'].forEach((languageId) => {
      monaco.languages.registerCodeLensProvider(languageId, {
        onDidChange: monacoStructureRefreshEmitter.event,
        provideCodeLenses(model) {
          const session = getActiveSession();
          const structureView = session?.structureView;
          if (!session || !structureView?.supported || !Array.isArray(structureView.symbols)) {
            return { lenses: [], dispose() {} };
          }
          if (!session.selectedFilePath || model.uri.scheme !== 'file' || model.uri.fsPath !== session.selectedFilePath) {
            return { lenses: [], dispose() {} };
          }

          const lenses = structureView.symbols.map((symbol) => {
            const concerns = symbol.securityNotes.length + symbol.qualityNotes.length;
            const relationCount = symbol.callers.length + symbol.callees.length;
            const items = [{
              range: new monaco.Range(symbol.range.startLine, 1, symbol.range.startLine, 1),
              id: `${symbol.id}:inspect`,
              command: {
                id: MONACO_STRUCTURE_INSPECT_COMMAND,
                title: 'Inspect',
                arguments: [session.id, symbol.id],
              },
            }];
            if (concerns > 0) {
              items.push({
                range: new monaco.Range(symbol.range.startLine, 1, symbol.range.startLine, 1),
                id: `${symbol.id}:concerns`,
                command: {
                  id: MONACO_STRUCTURE_INSPECT_COMMAND,
                  title: `${concerns} ${concerns === 1 ? 'concern' : 'concerns'}`,
                  arguments: [session.id, symbol.id],
                },
              });
            }
            if (relationCount > 0) {
              items.push({
                range: new monaco.Range(symbol.range.startLine, 1, symbol.range.startLine, 1),
                id: `${symbol.id}:relations`,
                command: {
                  id: MONACO_STRUCTURE_INSPECT_COMMAND,
                  title: `${relationCount} ${relationCount === 1 ? 'relation' : 'relations'}`,
                  arguments: [session.id, symbol.id],
                },
              });
            }
            return items;
          }).flat();

          return { lenses, dispose() {} };
        },
      });
    });
    monacoStructureProvidersRegistered = true;
  }
}

function applyMonacoStructureSelection(session = getActiveSession()) {
  const monaco = window.monaco;
  const activeEditor = getActiveMonacoEditor();
  if (!monaco || !activeEditor) return;
  const selectedSymbol = getSelectedStructureSymbol(session);
  if (!selectedSymbol || !session?.selectedFilePath || activeEditor.getModel()?.uri?.fsPath !== session.selectedFilePath) {
    monacoStructureSelectionDecorations?.clear();
    return;
  }

  if (!monacoStructureSelectionDecorations || monacoStructureSelectionEditor !== activeEditor) {
    monacoStructureSelectionDecorations?.clear();
    monacoStructureSelectionDecorations = activeEditor.createDecorationsCollection();
    monacoStructureSelectionEditor = activeEditor;
  }

  const range = new monaco.Range(
    selectedSymbol.range.startLine,
    selectedSymbol.range.startColumn,
    selectedSymbol.range.endLine,
    selectedSymbol.range.endColumn,
  );
  monacoStructureSelectionDecorations.set([{
    range,
    options: {
      inlineClassName: 'code-structure-symbol-highlight',
      isWholeLine: false,
      overviewRuler: {
        color: 'rgba(210, 153, 34, 0.65)',
        position: monaco.editor.OverviewRulerLane.Center,
      },
      minimap: {
        color: 'rgba(210, 153, 34, 0.65)',
        position: monaco.editor.MinimapPosition.Inline,
      },
    },
  }]);

  if (session.structureView?.revealSymbolId === selectedSymbol.id) {
    if (typeof activeEditor.setSelection === 'function') {
      activeEditor.setSelection(range);
    } else {
      activeEditor.setPosition({
        lineNumber: selectedSymbol.range.startLine,
        column: selectedSymbol.range.startColumn,
      });
    }
    if (typeof activeEditor.revealRangeNearTop === 'function') {
      activeEditor.revealRangeNearTop(range);
    } else {
      activeEditor.revealRangeInCenter(range);
    }
    activeEditor.focus();
    session.structureView.revealSymbolId = null;
  }
}

/**
 * Save current editor view state (cursor, scroll, selection) for the active tab.
 */
function saveMonacoViewState(filePath) {
  if (!filePath || !monacoEditorInstance) return;
  const entry = monacoModels.get(filePath);
  if (entry) {
    entry.viewState = monacoEditorInstance.saveViewState();
  }
}

/**
 * Mount or update the Monaco editor in the given container for the active tab.
 */
function mountMonacoEditor(container, filePath, content, isDiff, diffContent) {
  const monaco = window.monaco;
  if (!monaco || !container) return;
  ensureMonacoStructureSupport();

  if (isDiff) {
    // Diff editor mode
    if (monacoEditorInstance) {
      monacoEditorInstance.dispose();
      monacoEditorInstance = null;
    }
    if (!monacoDiffInstance) {
      monacoDiffInstance = monaco.editor.createDiffEditor(container, {
        originalEditable: false,
        renderSideBySide: true,
        enableSplitViewResizing: true,
        automaticLayout: true,
        readOnly: false,
        theme: currentMonacoTheme,
        fontSize: 13,
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
      });
    }
    const lang = mapMonacoLanguageId(filePath);
    // Dispose previous original model to prevent leak on repeated diff toggles
    const prevDiffModel = monacoDiffInstance.getModel();
    if (prevDiffModel?.original && !prevDiffModel.original.isDisposed()) {
      prevDiffModel.original.dispose();
    }
    const originalModel = monaco.editor.createModel(diffContent || '', lang);
    const modifiedModel = getOrCreateModel(filePath, content);
    if (modifiedModel) {
      modifiedModel.setValue(content || '');
    }
    monacoDiffInstance.setModel({ original: originalModel, modified: modifiedModel });
    return;
  }

  // Regular editor mode
  if (monacoDiffInstance) {
    monacoDiffInstance.dispose();
    monacoDiffInstance = null;
  }

  const model = getOrCreateModel(filePath, content);
  if (!model) return;

  // Update model content if it doesn't match (e.g. file reloaded from disk)
  const session = getActiveSession();
  const tab = getActiveTab(session);
  const isTabDirty = tab?.dirty;
  if (!isTabDirty && model.getValue() !== (content || '')) {
    model.setValue(content || '');
  }

  if (!monacoEditorInstance) {
    monacoEditorInstance = monaco.editor.create(container, {
      model,
      theme: currentMonacoTheme,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
      minimap: { enabled: true },
      lineNumbers: 'on',
      folding: true,
      wordWrap: 'off',
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true },
      readOnly: false,
      tabSize: 2,
      insertSpaces: true,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      padding: { top: 8 },
    });

    // Ctrl+S / Cmd+S to save
    monacoEditorInstance.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => saveEditorFile()
    );

    monacoEditorInstance.addAction({
      id: 'guardian.inspect-current-symbol',
      label: 'Inspect Current Symbol',
      contextMenuGroupId: 'navigation',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyI],
      run: () => {
        const session = getActiveSession();
        const structureView = session?.structureView;
        if (!session || !structureView?.supported) return null;
        const position = monacoEditorInstance.getPosition();
        const symbol = findStructureSymbolByLine(structureView, position?.lineNumber || 0);
        if (!symbol) return null;
        focusStructureSymbol(session, symbol.id, { reveal: false, switchTab: true });
        return null;
      },
    });

    // Track dirty state
    monacoEditorInstance.onDidChangeModelContent(() => {
      const session = getActiveSession();
      if (!session) return;
      const tab = getActiveTab(session);
      if (!tab) return;
      tab.content = monacoEditorInstance.getValue();
      tab.dirty = true;
      scheduleStructurePreviewRefresh(session, tab.content);
      // Update dirty indicator in header without full rerender
      const dirtyDot = currentContainer?.querySelector('.code-editor__dirty');
      if (!dirtyDot) {
        const h3 = currentContainer?.querySelector('.code-editor .panel__header h3');
        if (h3 && !h3.querySelector('.code-editor__dirty')) {
          const span = document.createElement('span');
          span.className = 'code-editor__dirty';
          span.title = 'Unsaved changes';
          span.innerHTML = '&bull;';
          h3.appendChild(span);
        }
      }
      // Show save button if not visible
      const actions = currentContainer?.querySelector('.code-editor .panel__actions');
      if (actions && !actions.querySelector('[data-code-save-file]')) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary btn-sm';
        btn.type = 'button';
        btn.dataset.codeSaveFile = '';
        btn.title = 'Save changes (Ctrl+S)';
        btn.textContent = 'Save';
        btn.addEventListener('click', () => saveEditorFile());
        actions.prepend(btn);
      }
    });
  } else {
    monacoEditorInstance.setModel(model);
  }

  // Restore view state if available
  const entry = monacoModels.get(filePath);
  if (entry?.viewState) {
    monacoEditorInstance.restoreViewState(entry.viewState);
  }
  triggerMonacoStructureRefresh();
  applyMonacoStructureSelection(session);
  monacoEditorInstance.focus();
}

function isActiveCodeView(container, lifecycleId) {
  return currentContainer === container && lifecycleId === codeViewLifecycleId;
}

// ─── Platform-aware shell options ──────────────────────────

function getShellOptions() {
  if (Array.isArray(shellOptionsCache) && shellOptionsCache.length > 0) {
    return shellOptionsCache;
  }
  switch (detectedPlatform) {
    case 'win32':
      return [
        { id: 'powershell', label: 'PowerShell (Windows)', detail: 'powershell.exe' },
        { id: 'cmd', label: 'Command Prompt (cmd.exe)', detail: 'cmd.exe' },
        { id: 'git-bash', label: 'Git Bash', detail: 'C:\\Program Files\\Git\\bin\\bash.exe' },
        { id: 'wsl-login', label: 'WSL Ubuntu', detail: 'wsl.exe (default shell/profile)' },
        { id: 'wsl', label: 'WSL Bash (Clean)', detail: 'wsl -- bash --noprofile --norc' },
      ];
    case 'darwin':
      return [
        { id: 'zsh', label: 'Zsh', detail: 'zsh' },
        { id: 'bash', label: 'Bash', detail: 'bash' },
        { id: 'sh', label: 'POSIX sh', detail: 'sh' },
      ];
    default:
      return [
        { id: 'bash', label: 'Bash', detail: 'bash' },
        { id: 'zsh', label: 'Zsh', detail: 'zsh' },
        { id: 'sh', label: 'POSIX sh', detail: 'sh' },
      ];
  }
}

function getDefaultShell() {
  return getShellOptions()[0]?.id || 'bash';
}

function getShellOption(shellId) {
  return getShellOptions().find((option) => option.id === shellId) || null;
}

function normalizeTerminalShell(shellId) {
  const requested = typeof shellId === 'string' && shellId.trim() ? shellId.trim() : getDefaultShell();
  const normalized = detectedPlatform === 'win32' && requested === 'bash' ? 'git-bash' : requested;
  return getShellOption(normalized)?.id || getDefaultShell();
}

function ensureTerminalCss() {
  if (terminalCssLoaded) return;
  terminalCssLoaded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/vendor/xterm/xterm.css';
  document.head.appendChild(link);
}

async function loadTerminalLib() {
  if (!terminalLibPromise) {
    ensureTerminalCss();
    terminalLibPromise = Promise.all([
      import('/vendor/xterm/xterm.mjs'),
      import('/vendor/xterm/addon-fit.mjs'),
    ]).then(([xterm, addonFit]) => ({
      Terminal: xterm.Terminal,
      FitAddon: addonFit.FitAddon,
    }));
  }
  return terminalLibPromise;
}

async function copyTextToClipboard(text) {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function bindTerminalListeners() {
  if (terminalListenersBound) return;
  terminalListenersBound = true;
  if (!terminalUnloadBound) {
    terminalUnloadBound = true;
    window.addEventListener('beforeunload', (event) => {
      const activeSession = getActiveSession();
      if (activeSession) {
        syncActiveEditorStateFromMonaco(activeSession);
      }
      if (getDirtyCodeTabs().length > 0) {
        event.preventDefault();
        event.returnValue = '';
      }
      for (const session of codeState.sessions || []) {
        for (const tab of session.terminalTabs || []) {
          if (tab.runtimeTerminalId) {
            fetch(`/api/code/terminals/${encodeURIComponent(tab.runtimeTerminalId)}`, {
              method: 'DELETE',
              credentials: 'same-origin',
              keepalive: true,
            }).catch(() => {});
          }
        }
      }
    });
  }

  onSSE('terminal.output', (payload) => {
    const tab = findTerminalTabByRuntimeId(payload?.terminalId);
    if (!tab || typeof payload?.data !== 'string') return;
    tab.output = trimTerminalOutput((tab.output || '') + payload.data);
    tab.connected = true;
    saveState(codeState);
    const instance = terminalInstances.get(tab.id);
    if (instance) instance.term.write(payload.data);
  });

  onSSE('terminal.exit', (payload) => {
    const tab = findTerminalTabByRuntimeId(payload?.terminalId);
    if (!tab) return;
    tab.connected = false;
    tab.runtimeTerminalId = null;
    const exitCode = Number.isInteger(payload?.exitCode) ? payload.exitCode : 'unknown';
    tab.output = trimTerminalOutput(`${tab.output || ''}\n[process exited ${exitCode}]\n`);
    saveState(codeState);
    const instance = terminalInstances.get(tab.id);
    if (instance) {
      instance.term.write(`\r\n[process exited ${exitCode}]\r\n`);
    }
    scheduleTerminalRender();
  });
}

function bindRunTimelineListeners() {
  if (runTimelineListenersBound) return;
  runTimelineListenersBound = true;

  onSSE('run.timeline', (payload) => {
    const run = normalizeTimelineRun(payload);
    const codeSessionId = run?.summary?.codeSessionId;
    if (!run || !codeSessionId) return;
    const session = getSessionById(codeSessionId);
    if (!session) return;
    session.timelineRuns = mergeTimelineRuns(session.timelineRuns, run);
    saveState(codeState);
    const activeSession = getActiveSession();
    if (
      window.location.hash.startsWith('#/code')
      && activeSession?.id === codeSessionId
      && (
        normalizeAssistantTabValue(activeSession.activeAssistantTab) === 'activity'
        || (
          normalizeAssistantTabValue(activeSession.activeAssistantTab) === 'chat'
          && activeSession.pendingResponse
        )
      )
    ) {
      rerenderFromState();
    }
  });
}

function mergeTimelineRuns(existingRuns, nextRun) {
  const normalizedExisting = normalizeTimelineRuns(existingRuns);
  const byRunId = new Map(normalizedExisting.map((run) => [run.summary.runId, run]));
  byRunId.set(nextRun.summary.runId, nextRun);
  return [...byRunId.values()]
    .sort((left, right) => (right.summary.lastUpdatedAt || 0) - (left.summary.lastUpdatedAt || 0))
    .slice(0, MAX_TIMELINE_RUNS);
}

function findTerminalTabByRuntimeId(runtimeTerminalId) {
  if (!runtimeTerminalId) return null;
  for (const session of codeState.sessions) {
    const tab = (session.terminalTabs || []).find((candidate) => candidate.runtimeTerminalId === runtimeTerminalId);
    if (tab) return tab;
  }
  return null;
}

function scheduleTerminalRender() {
  if (terminalRenderTimer) return;
  terminalRenderTimer = setTimeout(() => {
    terminalRenderTimer = null;
    rerenderFromState();
  }, 40);
}

function trimTerminalOutput(text) {
  const MAX_CHARS = 120000;
  return text.length > MAX_CHARS ? text.slice(text.length - MAX_CHARS) : text;
}

async function readClipboardTextFromEvent(event) {
  const directText = event?.clipboardData?.getData?.('text/plain');
  if (typeof directText === 'string' && directText.length > 0) {
    return directText;
  }
  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '';
    }
  }
  return '';
}

async function forwardTerminalPaste(event, tab) {
  if (!tab?.runtimeTerminalId) return;
  const text = await readClipboardTextFromEvent(event);
  if (!text) return;
  api.codeTerminalInput(tab.runtimeTerminalId, { input: text }).catch(() => {});
}

function forwardTerminalText(tab, text) {
  if (!tab?.runtimeTerminalId || !text) return;
  api.codeTerminalInput(tab.runtimeTerminalId, { input: text }).catch(() => {});
}

function isClipboardPasteSentinel(text) {
  return text === '^V' || text === '\u0016';
}

function shouldBridgeTerminalTextInput(event, text = '') {
  const inputType = String(event?.inputType || '');
  if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop' || inputType === 'insertReplacementText') {
    return true;
  }
  const candidate = typeof text === 'string' && text
    ? text
    : (typeof event?.data === 'string' ? event.data : '');
  if (!candidate) return false;
  if (isClipboardPasteSentinel(candidate)) return true;
  if (/[\r\n\t]/.test(candidate)) return true;
  return candidate.length >= 4;
}

async function forwardTerminalInsertedText(event, tab, text = '') {
  if (isClipboardPasteSentinel(text) || !text) {
    await forwardTerminalPaste(event, tab);
    return;
  }
  forwardTerminalText(tab, text);
}

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function humanizeToolName(toolName) {
  return String(toolName || '')
    .replace(/^code_/, '')
    .replace(/^fs_/, 'file ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatRelativeTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortTreeEntries(entries) {
  return [...entries].sort((a, b) => {
    const typeA = a.type === 'dir' ? 'dir' : 'file';
    const typeB = b.type === 'dir' ? 'dir' : 'file';
    if (typeA !== typeB) return typeA === 'dir' ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function normalizeTreeEntries(entries) {
  return Array.isArray(entries)
    ? sortTreeEntries(entries
      .filter((entry) => entry && typeof entry.name === 'string')
      .map((entry) => ({
        name: String(entry.name),
        type: entry.type === 'dir' ? 'dir' : 'file',
      })))
    : [];
}

function normalizeSessionUiStateRecord(record, existing = {}) {
  const uiState = record?.uiState || {};
  return {
    currentDirectory: uiState.currentDirectory || record?.resolvedRoot || record?.workspaceRoot || '.',
    selectedFilePath: uiState.selectedFilePath || null,
    showDiff: !!uiState.showDiff,
    terminalTabs: normalizeTerminalTabs(uiState.terminalTabs, existing.terminalTabs),
    terminalCollapsed: !!uiState.terminalCollapsed,
    expandedDirs: Array.isArray(uiState.expandedDirs) ? uiState.expandedDirs : [],
    activeAssistantTab: normalizeAssistantTabValue(uiState.activeAssistantTab || existing.activeAssistantTab),
  };
}

function getSessionUiStateSignature(uiState) {
  return JSON.stringify({
    currentDirectory: uiState?.currentDirectory || '.',
    selectedFilePath: uiState?.selectedFilePath || null,
    showDiff: !!uiState?.showDiff,
    terminalTabs: normalizeTerminalTabs(uiState?.terminalTabs, []),
    terminalCollapsed: !!uiState?.terminalCollapsed,
    expandedDirs: Array.isArray(uiState?.expandedDirs) ? uiState.expandedDirs : [],
    activeAssistantTab: normalizeAssistantTabValue(uiState?.activeAssistantTab),
  });
}

function getEffectiveSessionUiState(record, existing = {}) {
  const serverUiState = normalizeSessionUiStateRecord(record, existing);
  const pendingUiState = pendingSessionUiStateById.get(record?.id);
  if (!pendingUiState) return serverUiState;
  if (getSessionUiStateSignature(pendingUiState) === getSessionUiStateSignature(serverUiState)) {
    pendingSessionUiStateById.delete(record.id);
    return serverUiState;
  }
  return {
    ...serverUiState,
    ...pendingUiState,
    terminalTabs: normalizeTerminalTabs(pendingUiState.terminalTabs, serverUiState.terminalTabs),
    expandedDirs: Array.isArray(pendingUiState.expandedDirs) ? pendingUiState.expandedDirs : serverUiState.expandedDirs,
    activeAssistantTab: normalizeAssistantTabValue(pendingUiState.activeAssistantTab || serverUiState.activeAssistantTab),
  };
}

function getTreeCacheSignature(value) {
  return JSON.stringify({
    error: String(value?.error || ''),
    resolvedPath: String(value?.resolvedPath || ''),
    entries: normalizeTreeEntries(value?.entries),
  });
}

function getVisibleTreePaths(session) {
  if (!session) return [];
  const rootPath = session.resolvedRoot || session.workspaceRoot || '.';
  return Array.from(new Set([
    rootPath,
    ...(Array.isArray(session.expandedDirs) ? session.expandedDirs : []),
  ]));
}

function getVisibleTreeSignature(session) {
  return JSON.stringify(getVisibleTreePaths(session).map((dirPath) => ({
    path: dirPath,
    signature: getTreeCacheSignature(treeCache.get(dirPath)),
  })));
}

function isApprovalNotFoundMessage(value) {
  return /approval\s+'[^']+'\s+not\s+found/i.test(String(value || ''));
}

function isCodeSessionUnavailableError(value) {
  return value?.code === 'CODE_SESSION_UNAVAILABLE'
    || /code session\b.*\bunavailable\b/i.test(String(value?.message || value || ''));
}

function getApprovalBacklogState(session) {
  const count = Array.isArray(session?.pendingApprovals) ? session.pendingApprovals.length : 0;
  return {
    count,
    blocked: count >= APPROVAL_BACKLOG_SOFT_CAP,
  };
}

function isSessionJob(job, session) {
  return !!job
    && (
      (job.codeSessionId && job.codeSessionId === session.id)
      || (
        job.userId === session.conversationUserId
        && job.channel === (session.conversationChannel || 'code-session')
      )
    );
}

function isCodeAssistantJob(job) {
  const toolName = String(job?.toolName || '').trim();
  return toolName.startsWith('code_')
    || toolName === 'find_tools'
    || toolName.startsWith('fs_')
    || toolName === 'shell_safe';
}

function isVerificationJob(job) {
  const toolName = String(job?.toolName || '').trim();
  return toolName === 'code_test'
    || toolName === 'code_lint'
    || toolName === 'code_build'
    || !!job?.verificationStatus
    || job?.status === 'failed';
}

function mapTaskStatus(job) {
  if (!job) return 'info';
  if (job.status === 'pending_approval') return 'waiting';
  if (job.status === 'failed' || job.status === 'denied') return 'blocked';
  if (job.status === 'running') return 'active';
  if (job.status === 'succeeded') return 'completed';
  return 'info';
}

function mapCheckStatus(job) {
  if (!job) return 'info';
  if (job.status === 'failed' || job.status === 'denied') return 'fail';
  if (job.verificationStatus === 'verified') return 'pass';
  if (job.status === 'pending_approval') return 'warn';
  if (job.verificationStatus === 'unverified') return 'warn';
  if (job.status === 'succeeded') return 'warn';
  return 'info';
}

function summarizeJobDetail(job) {
  if (!job) return '';
  if (job.status === 'pending_approval') return 'Waiting for your approval before execution can continue.';
  if (job.status === 'failed' || job.status === 'denied') return job.error || 'This step did not complete successfully.';
  if (job.verificationEvidence) return job.verificationEvidence;
  if (job.resultPreview) return job.resultPreview;
  if (job.argsPreview) return job.argsPreview;
  return `${humanizeToolName(job.toolName)} ${job.status || 'updated'}.`;
}

function summarizeTaskTitle(job) {
  if (!job) return 'Recent activity';
  if (job.status === 'pending_approval') return `${humanizeToolName(job.toolName)} is waiting for approval`;
  if (job.status === 'failed') return `${humanizeToolName(job.toolName)} failed`;
  if (job.status === 'denied') return `${humanizeToolName(job.toolName)} was denied`;
  if (job.status === 'succeeded') return `${humanizeToolName(job.toolName)} completed`;
  return `${humanizeToolName(job.toolName)} is in progress`;
}

function humanizeWorkspaceTrustFindingKind(kind) {
  return String(kind || '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeWorkspaceTrustPath(path) {
  return String(path || '').replace(/\\/g, '/');
}

function isWorkspaceTrustDocPath(path) {
  const normalized = normalizeWorkspaceTrustPath(path).toLowerCase();
  return normalized.startsWith('docs/')
    || normalized.includes('/docs/')
    || normalized.endsWith('.md')
    || normalized.endsWith('.txt');
}

function isWorkspaceTrustLoopbackValue(value) {
  return /(?:^|[^\w])(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|::1)(?::\d+)?(?:[\/\s]|$)/i.test(String(value || ''));
}

function buildWorkspaceTrustFindingGuidance(finding) {
  const kindKey = String(finding?.kind || '');
  const path = normalizeWorkspaceTrustPath(finding?.path || '');
  const evidence = String(finding?.evidence || '');
  const isDocPath = isWorkspaceTrustDocPath(path);
  const hasLoopbackContext = isWorkspaceTrustLoopbackValue(path) || isWorkspaceTrustLoopbackValue(evidence);
  const isNodeInlineExec = /\bnode\b[^\n]{0,160}\s-[ce]\b/i.test(evidence);
  const observedContext = [];

  if (path) observedContext.push(`Path: ${path}`);
  if (evidence) observedContext.push(`Evidence: ${evidence}`);
  if (isDocPath && kindKey === 'prompt_injection') {
    observedContext.push('This hit is in documentation or test-like content, not an executable repo hook.');
  }
  if (hasLoopbackContext && kindKey === 'network_fetch') {
    observedContext.push('The observed endpoint is loopback/local-host, which usually indicates a local health check or metadata query.');
  }

  const defaultGuidance = {
    why: 'Guardian found a repo-owned pattern that changes how much autonomy it should allow before a human reviews the workspace.',
    investigateNext: [
      'Open the referenced file and inspect the surrounding lines, not just the excerpt shown here.',
      'Decide whether the pattern is executable repo behavior, local tooling glue, or documentation/test content.',
      'Keep the repo blocked only if the behavior executes remote, encoded, or otherwise opaque content.',
    ],
    benignContext: '',
  };

  switch (kindKey) {
    case 'prompt_injection':
      return {
        why: 'Prompt-like instructions in repo content can steer a model if raw snippets are passed through without sanitization.',
        investigateNext: isDocPath
          ? [
            'Confirm the file is documentation, a runbook, or a test fixture rather than an executable prompt template.',
            'Check that untrusted repo summaries and raw working-set snippets stay suppressed until the workspace is trusted.',
            'If the content is intentional adversarial test data, keep it isolated to docs/tests and treat this as a review signal rather than a malware signal.',
          ]
          : [
            'Inspect how this file is consumed and whether its contents are ever inserted into model prompts.',
            'Check whether the file is operator documentation, prompt content, or untrusted sample data.',
            'Escalate only if this content can reach the model as instructions without the untrusted-content guardrails.',
          ],
        benignContext: isDocPath
          ? 'Security docs, runbooks, and prompt-testing fixtures commonly trigger this warning intentionally.'
          : '',
      };
    case 'lifecycle_script':
      return {
        why: 'Package lifecycle hooks can run automatically during install, pack, or publish flows.',
        investigateNext: [
          'Inspect the named lifecycle entries in `package.json` and read the exact commands they invoke.',
          'Confirm the hook only performs expected local build, vendoring, or packaging work.',
          'If a lifecycle hook downloads, decodes, or executes remote content, keep the repo blocked.',
        ],
        benignContext: 'Many repos use lifecycle hooks for vendoring assets or validating release output, but they still deserve review because they run implicitly.',
      };
    case 'fetch_pipe_exec':
      return {
        why: 'This pattern downloads content and executes it immediately, which is one of the strongest repo-trust blocking signals.',
        investigateNext: [
          'Review the full command, destination host, and the interpreter or shell it feeds.',
          'Assume the repo should stay blocked until you verify the fetched content and publisher.',
          'If this is only a convenience bootstrap script, move it behind explicit operator review instead of letting it blend into normal repo tooling.',
        ],
        benignContext: '',
      };
    case 'encoded_exec':
      return {
        why: 'Encoded execution obscures what will actually run, which makes quick manual review unreliable.',
        investigateNext: [
          'Decode or expand the payload outside the workflow before trusting the repo.',
          'Check whether the encoded command came from a bootstrap helper, installer, or copied third-party snippet.',
          'Keep the repo blocked until the decoded behavior is fully understood.',
        ],
        benignContext: '',
      };
    case 'inline_exec':
      return {
        why: isNodeInlineExec
          ? 'Inline Node.js one-liners are common in dev tooling, but they hide logic behind a compact command that still needs human review.'
          : 'Inline interpreter execution hides behavior behind a one-liner and deserves direct inspection.',
        investigateNext: isNodeInlineExec
          ? [
            'Read the full one-liner and confirm it only parses local data, prints metadata, or performs simple file work.',
            'Check whether it consumes loopback or local input rather than downloaded third-party content.',
            'Escalate only if it evaluates untrusted input, decodes payloads, or launches follow-on execution.',
          ]
          : [
            'Read the full inline command rather than relying on the excerpt.',
            'Check whether it evaluates untrusted input, decodes payloads, or launches follow-on processes.',
            'If it sits inside an install hook or a remote fetch chain, keep the repo blocked.',
          ],
        benignContext: isNodeInlineExec
          ? 'Short `node -e` helpers are often used for JSON parsing, file-copy glue, or quick environment checks in bootstrap scripts.'
          : '',
      };
    case 'network_fetch':
      return {
        why: hasLoopbackContext
          ? 'Repo-owned scripts contact a network endpoint. Loopback traffic is usually a local service probe, but it still helps to confirm what is being queried.'
          : 'Repo-owned scripts contact a network endpoint, which can introduce remote content or leak local data.',
        investigateNext: hasLoopbackContext
          ? [
            'Verify the endpoint is loopback-only and belongs to an expected local service such as Ollama.',
            'Confirm the response is only inspected or parsed locally and is not executed.',
            'Downgrade concern if the call is just a health check or model-discovery query.',
          ]
          : [
            'Identify the remote host and what data is being fetched.',
            'Check whether the response is saved, executed, or only inspected.',
            'Keep the repo blocked if the fetch feeds directly into execution or runs during install.',
          ],
        benignContext: hasLoopbackContext
          ? 'Loopback requests usually indicate local health checks, not third-party downloads.'
          : '',
      };
    case 'shell_launcher':
      return {
        why: 'Launching a shell with inline commands increases the chance that hidden or concatenated behavior is missed during quick review.',
        investigateNext: [
          'Expand the launched command and inspect the exact shell payload.',
          'Check whether the shell invocation only wraps expected local commands or adds downloads and evaluation.',
          'Keep the repo blocked if the shell command materially obscures the real behavior.',
        ],
        benignContext: '',
      };
    case 'native_av_detection':
      return {
        why: 'A native host malware scanner already reported a workspace detection, which is stronger evidence than static pattern matching.',
        investigateNext: [
          'Review the provider details and affected file path from the AV evidence.',
          'Rescan or quarantine the detected file outside Guardian before trusting the repo.',
          'Do not rely on manual trust override until the host scanner reports a clean result.',
        ],
        benignContext: '',
      };
    default:
      return defaultGuidance;
  }
}

function hasWorkspaceTrustNativeDetection(workspaceTrust) {
  if (!workspaceTrust) return false;
  if (workspaceTrust.nativeProtection?.status === 'detected') return true;
  return Array.isArray(workspaceTrust.findings)
    && workspaceTrust.findings.some((finding) => finding.kind === 'native_av_detection');
}

function isWorkspaceTrustReviewActive(session) {
  const workspaceTrust = session?.workspaceTrust || null;
  const workspaceTrustReview = session?.workspaceTrustReview || null;
  if (!workspaceTrust || !workspaceTrustReview) return false;
  if (workspaceTrust.state === 'trusted') return false;
  if (workspaceTrustReview.decision !== 'accepted') return false;
  return !hasWorkspaceTrustNativeDetection(workspaceTrust);
}

function getEffectiveWorkspaceTrustState(session) {
  const workspaceTrust = session?.workspaceTrust || null;
  if (!workspaceTrust) return null;
  if (workspaceTrust.state === 'trusted') return 'trusted';
  return isWorkspaceTrustReviewActive(session) ? 'trusted' : workspaceTrust.state;
}

function isWorkspaceTrustOverrideAvailable(session) {
  const workspaceTrust = session?.workspaceTrust || null;
  if (!workspaceTrust || workspaceTrust.state === 'trusted') return false;
  return !hasWorkspaceTrustNativeDetection(workspaceTrust);
}

function getWorkspaceTrustBadgeClass(state) {
  if (state === 'blocked') return 'badge-trust-blocked';
  if (state === 'caution') return 'badge-trust-caution';
  if (state === 'trusted') return 'badge-trust-trusted';
  return 'badge-trust-neutral';
}

function buildWorkspaceTrustFindingViewModels(workspaceTrust) {
  return Array.isArray(workspaceTrust?.findings)
    ? workspaceTrust.findings.map((finding, index) => ({
      id: `workspace-trust-finding-${index}`,
      severity: String(finding?.severity || 'warn'),
      kindKey: String(finding?.kind || ''),
      kind: humanizeWorkspaceTrustFindingKind(finding?.kind),
      path: normalizeWorkspaceTrustPath(finding?.path || ''),
      summary: String(finding?.summary || ''),
      evidence: String(finding?.evidence || ''),
      ...buildWorkspaceTrustFindingGuidance(finding),
    }))
    : [];
}

function renderWorkspaceTrustFindingsMarkup(workspaceTrust) {
  const findings = buildWorkspaceTrustFindingViewModels(workspaceTrust);
  if (!Array.isArray(findings) || findings.length === 0) return '';
  const highCount = findings.filter((finding) => finding.severity === 'high').length;
  const warnCount = findings.filter((finding) => finding.severity !== 'high').length;
  const meta = [
    highCount > 0 ? `${highCount} blocking` : '',
    warnCount > 0 ? `${warnCount} review` : '',
    workspaceTrust?.truncated ? 'scan truncated' : '',
  ].filter(Boolean).join(' • ');
  const note = workspaceTrust?.truncated
    ? 'Showing the highest-priority findings from a truncated scan. Review the repo directly if you need full coverage before trusting it.'
    : findings.length >= 12
      ? 'Showing the highest-priority findings first. Expand any row for deterministic guidance.'
      : 'Expand a row for deterministic guidance on what to inspect next.';
  return `
    <div class="code-status-card__findings">
      <div class="code-status-card__findings-header">
        <div class="code-status-card__findings-title">Trust findings</div>
        ${meta ? `<div class="code-status-card__findings-meta">${esc(meta)}</div>` : ''}
      </div>
      <div class="code-status-card__findings-note">${esc(note)}</div>
      <div class="code-status-card__findings-scroll">
        ${findings.map((finding) => `
          <details class="code-status-card__finding severity-${escAttr(finding.severity)}"${finding.severity === 'high' || finding.kindKey === 'native_av_detection' ? ' open' : ''}>
            <summary class="code-status-card__finding-summaryline">
              <div class="code-status-card__finding-top">
                <span class="code-status-card__finding-badge severity-${escAttr(finding.severity)}">${esc(finding.severity.toUpperCase())}</span>
                <span class="code-status-card__finding-kind">${esc(finding.kind || 'Indicator')}</span>
              </div>
              ${finding.path ? `<div class="code-status-card__finding-path">${esc(finding.path)}</div>` : ''}
              ${finding.summary ? `<div class="code-status-card__finding-preview">${esc(finding.summary)}</div>` : ''}
              <span class="code-status-card__finding-impact severity-${escAttr(finding.severity)}">${finding.severity === 'high' ? 'Blocking by default' : 'Review before trusting'}</span>
            </summary>
            <div class="code-status-card__finding-body">
              <div class="code-status-card__finding-section">
                <div class="code-status-card__finding-section-title">Why this matters</div>
                <div class="code-status-card__finding-copy">${esc(finding.why || '')}</div>
              </div>
              ${finding.benignContext ? `
                <div class="code-status-card__finding-section">
                  <div class="code-status-card__finding-section-title">Benign context to check first</div>
                  <div class="code-status-card__finding-copy">${esc(finding.benignContext)}</div>
                </div>
              ` : ''}
              ${Array.isArray(finding.investigateNext) && finding.investigateNext.length > 0 ? `
                <div class="code-status-card__finding-section">
                  <div class="code-status-card__finding-section-title">Investigate next</div>
                  <ul class="code-status-card__finding-list">
                    ${finding.investigateNext.map((item) => `<li>${esc(item)}</li>`).join('')}
                  </ul>
                </div>
              ` : ''}
              ${Array.isArray(finding.observedContext) && finding.observedContext.length > 0 ? `
                <div class="code-status-card__finding-section">
                  <div class="code-status-card__finding-section-title">Observed context</div>
                  <ul class="code-status-card__finding-list">
                    ${finding.observedContext.map((item) => `<li>${esc(item)}</li>`).join('')}
                  </ul>
                </div>
              ` : ''}
            </div>
          </details>
        `).join('')}
      </div>
    </div>
  `;
}

function deriveTaskItems(session) {
  const items = [];
  const backlog = getApprovalBacklogState(session);
  const recentJobs = Array.isArray(session?.recentJobs) ? session.recentJobs.filter(isCodeAssistantJob) : [];
  const workspaceProfile = session?.workspaceProfile || null;
  const workspaceTrust = session?.workspaceTrust || null;
  const workspaceMap = session?.workspaceMap || null;
  const workingSet = session?.workingSet || null;

  if (backlog.count > 0) {
    items.push({
      id: 'pending-approvals',
      title: backlog.blocked
        ? `Approval backlog is full (${backlog.count})`
        : `${backlog.count} ${pluralize(backlog.count, 'approval')} waiting`,
      status: backlog.blocked ? 'blocked' : 'waiting',
      detail: backlog.blocked
        ? 'New write actions are paused until you clear some approvals.'
        : 'A mutating step is paused until you approve or deny it.',
    });
  }

  if (workspaceProfile?.summary) {
    items.push({
      id: 'workspace-profile',
      title: workspaceProfile.repoName
        ? `Workspace profile: ${workspaceProfile.repoName}`
        : 'Workspace profile',
      status: 'info',
      detail: workspaceProfile.summary,
      meta: workspaceProfile.stack?.length ? workspaceProfile.stack.join(', ') : (workspaceProfile.repoKind || ''),
    });
  }

  if (workspaceTrust?.summary) {
    const effectiveTrustState = getEffectiveWorkspaceTrustState(session) || workspaceTrust.state;
    const reviewActive = isWorkspaceTrustReviewActive(session);
    const nativeProtectionMeta = workspaceTrust.nativeProtection?.summary
      ? ` • ${workspaceTrust.nativeProtection.summary}`
      : '';
    items.push({
      id: 'workspace-trust',
      title: reviewActive
        ? 'Workspace trust: accepted'
        : `Workspace trust: ${effectiveTrustState}`,
      status: reviewActive
        ? 'completed'
        : effectiveTrustState === 'trusted' ? 'completed' : effectiveTrustState === 'blocked' ? 'blocked' : 'warn',
      detail: reviewActive
        ? `Manual trust acceptance is active for this session. Effective trust is trusted for repo-scoped tools. Raw scanner state remains ${workspaceTrust.state}. ${workspaceTrust.summary}`
        : workspaceTrust.summary,
      meta: `${reviewActive ? `raw ${String(workspaceTrust.state || '').toUpperCase()} • ` : ''}${workspaceTrust.scannedFiles || 0} scanned file${workspaceTrust.scannedFiles === 1 ? '' : 's'}${workspaceTrust.truncated ? ' • truncated' : ''}${nativeProtectionMeta}`,
      workspaceTrust,
    });
  }

  if (workspaceMap?.indexedFileCount) {
    const directoryPreview = Array.isArray(workspaceMap.directories)
      ? workspaceMap.directories.slice(0, 3).map((entry) => `${entry.path} (${entry.fileCount})`).join(', ')
      : '';
    items.push({
      id: 'workspace-map',
      title: 'Indexed repo map',
      status: 'info',
      detail: `${workspaceMap.indexedFileCount} indexed files${workspaceMap.truncated ? ' (truncated)' : ''}${directoryPreview ? `. Directories: ${directoryPreview}.` : '.'}`,
      meta: Array.isArray(workspaceMap.notableFiles) && workspaceMap.notableFiles.length > 0
        ? workspaceMap.notableFiles.slice(0, 4).join(', ')
        : '',
    });
  }

  if (session?.focusSummary) {
    items.push({
      id: 'focus-summary',
      title: 'Current focus',
      status: 'info',
      detail: session.focusSummary,
    });
  }

  if (Array.isArray(workingSet?.files) && workingSet.files.length > 0) {
    items.push({
      id: 'working-set',
      title: 'Current working set',
      status: 'info',
      detail: workingSet.rationale || 'Prepared repo files for the latest coding turn.',
      meta: workingSet.files.slice(0, 4).map((entry) => entry.path).join(', '),
    });
  }

  if (session?.planSummary) {
    items.push({
      id: 'active-plan',
      title: 'Active plan',
      status: 'info',
      detail: session.planSummary,
    });
  }

  recentJobs.slice(0, 4).forEach((job) => {
    items.push({
      id: job.id,
      title: summarizeTaskTitle(job),
      status: mapTaskStatus(job),
      detail: summarizeJobDetail(job),
      meta: formatRelativeTime(job.createdAt),
    });
  });

  return items;
}

function deriveCheckItems(session) {
  const jobs = Array.isArray(session?.recentJobs)
    ? session.recentJobs.filter(isVerificationJob).slice(0, 8)
    : [];
  const verification = Array.isArray(session?.verification)
    ? session.verification.slice(0, 8)
    : [];
  return [
    ...verification.map((entry) => ({
      id: entry.id,
      title: formatVerificationTitle(entry),
      status: entry.status,
      detail: entry.summary,
      meta: formatRelativeTime(entry.timestamp),
      sortAt: entry.timestamp,
    })),
    ...jobs.map((job) => ({
      id: job.id,
      title: humanizeToolName(job.toolName),
      status: mapCheckStatus(job),
      detail: summarizeJobDetail(job),
      meta: formatRelativeTime(job.createdAt),
      sortAt: job.createdAt || 0,
    })),
  ]
    .sort((left, right) => (right.sortAt || 0) - (left.sortAt || 0))
    .slice(0, 8)
    .map(({ sortAt: _sortAt, ...item }) => item);
}

function formatVerificationTitle(entry) {
  if (entry?.id === 'assistant-security') return 'Assistant Security';
  switch (entry?.kind) {
    case 'lint':
      return 'Lint';
    case 'build':
      return 'Build';
    case 'test':
      return 'Tests';
    default:
      return 'Verification';
  }
}

function collectCachedTreeFilePaths(dirPath, results = []) {
  const cached = treeCache.get(dirPath);
  if (!cached || !Array.isArray(cached.entries)) return results;
  for (const entry of cached.entries) {
    const nextPath = joinWorkspacePath(dirPath, entry.name);
    if (entry.type === 'file') {
      results.push(nextPath);
      continue;
    }
    collectCachedTreeFilePaths(nextPath, results);
  }
  return results;
}

function getCodeChatReferenceCatalog(session) {
  const catalog = [];
  const seen = new Set();
  const workspaceRoot = session?.resolvedRoot || session?.workspaceRoot || '';
  const addEntry = (pathValue, category = '', summary = '') => {
    const normalizedPath = String(pathValue || '')
      .trim()
      .replace(/[\\/]+/g, '/')
      .replace(/^\.\/+/, '');
    if (!normalizedPath) return;
    const key = normalizeComparablePath(normalizedPath);
    if (!key || seen.has(key)) return;
    seen.add(key);
    catalog.push({ path: normalizedPath, category, summary });
  };

  if (session?.selectedFilePath && workspaceRoot) {
    addEntry(toRelativePath(session.selectedFilePath, workspaceRoot), 'selected');
  }
  if (Array.isArray(session?.openTabs)) {
    session.openTabs.forEach((tab) => {
      addEntry(workspaceRoot ? toRelativePath(tab.filePath, workspaceRoot) : tab.filePath, 'open');
    });
  }
  if (Array.isArray(session?.workspaceMap?.notableFiles)) {
    session.workspaceMap.notableFiles.forEach((pathValue) => addEntry(pathValue, 'notable'));
  }
  if (Array.isArray(session?.workspaceMap?.files)) {
    session.workspaceMap.files.forEach((entry) => addEntry(entry.path, entry.category, entry.summary));
  }
  if (catalog.length === 0 && workspaceRoot) {
    collectCachedTreeFilePaths(workspaceRoot).forEach((fullPath) => addEntry(toRelativePath(fullPath, workspaceRoot), 'cached'));
  }
  return catalog;
}

function scoreCodeChatReference(entry, normalizedQuery) {
  if (!normalizedQuery) return 1;
  const pathValue = normalizeComparablePath(entry.path);
  const baseValue = basename(entry.path).toLowerCase();
  const queryTokens = normalizedQuery.split(/[./_-]+/).filter(Boolean);
  let score = 0;
  if (pathValue === normalizedQuery) score += 1200;
  else if (baseValue === normalizedQuery) score += 1100;
  if (pathValue.startsWith(normalizedQuery)) score += 950;
  if (baseValue.startsWith(normalizedQuery)) score += 900;
  if (pathValue.includes(`/${normalizedQuery}`)) score += 760;
  if (pathValue.includes(normalizedQuery)) score += 620;
  queryTokens.forEach((token) => {
    if (token.length < 2) return;
    if (baseValue.includes(token)) score += 55;
    if (pathValue.includes(token)) score += 20;
  });
  return score;
}

function getCodeChatReferenceSuggestions(session, query) {
  const catalog = getCodeChatReferenceCatalog(session);
  if (catalog.length === 0) return [];
  const normalizedQuery = normalizeComparablePath(query || '').replace(/^@/, '');
  const scored = catalog
    .map((entry) => ({ ...entry, score: scoreCodeChatReference(entry, normalizedQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || left.path.split('/').length - right.path.split('/').length
      || left.path.localeCompare(right.path)
    ));
  return scored.slice(0, MAX_CHAT_FILE_REFERENCE_SUGGESTIONS);
}

function findCodeChatMentionMatch(text, cursorIndex) {
  if (!Number.isFinite(cursorIndex) || cursorIndex < 0) return null;
  const beforeCursor = String(text || '').slice(0, cursorIndex);
  const afterCursor = String(text || '').slice(cursorIndex);
  if (/^[A-Za-z0-9_./\\-]/.test(afterCursor)) return null;
  const match = beforeCursor.match(/(^|[\s([{])@([A-Za-z0-9_./\\-]*)$/);
  if (!match) return null;
  const query = match[2] || '';
  const start = beforeCursor.length - query.length - 1;
  return { start, end: cursorIndex, query };
}

function extractCodeChatFileReferences(session, text) {
  const catalog = getCodeChatReferenceCatalog(session);
  if (catalog.length === 0) return [];
  const catalogByPath = new Map(catalog.map((entry) => [normalizeComparablePath(entry.path), entry.path]));
  const references = [];
  const seen = new Set();
  const pattern = /(^|[\s([{])@([A-Za-z0-9_./\\-]+)/g;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    const candidate = String(match[2] || '')
      .trim()
      .replace(/[)>}\],;:!?]+$/, '')
      .replace(/[\\/]+/g, '/')
      .replace(/^\.\/+/, '');
    const resolved = catalogByPath.get(normalizeComparablePath(candidate));
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    references.push(resolved);
    if (references.length >= MAX_CHAT_FILE_REFERENCES) break;
  }
  return references;
}

function renderCodeChatDraftReferencesMarkup(references) {
  const normalized = normalizeDraftFileReferences(references);
  if (normalized.length === 0) return '';
  return `
    <div class="code-chat__refs-label">Tagged context</div>
    <div class="code-chat__refs-pills">
      ${normalized.map((pathValue) => `<span class="code-chat__ref-pill" title="${escAttr(pathValue)}">@${esc(pathValue)}</span>`).join('')}
    </div>
  `;
}

function renderCodeChatReferencePickerMarkup(picker) {
  if (!picker || !Array.isArray(picker.suggestions) || picker.suggestions.length === 0) return '';
  return picker.suggestions.map((entry, index) => {
    const isActive = index === picker.selectedIndex;
    const secondary = entry.path === basename(entry.path)
      ? (entry.summary || entry.category || '')
      : entry.path;
    return `
      <button
        class="code-chat__mention-item ${isActive ? 'is-active' : ''}"
        type="button"
        data-code-chat-ref-suggestion="${escAttr(entry.path)}"
      >
        <span class="code-chat__mention-primary">@${esc(basename(entry.path))}</span>
        <span class="code-chat__mention-secondary">${esc(secondary)}</span>
      </button>
    `;
  }).join('');
}

function updateCodeChatReferenceList(form, references) {
  const host = form?.querySelector('[data-code-chat-ref-list]');
  if (!host) return;
  const markup = renderCodeChatDraftReferencesMarkup(references);
  host.innerHTML = markup;
  host.hidden = !markup;
}

function updateCodeChatReferencePicker(form, picker) {
  const host = form?.querySelector('[data-code-chat-mention-menu]');
  if (!host) return;
  const markup = renderCodeChatReferencePickerMarkup(picker);
  host.innerHTML = markup;
  host.hidden = !markup;
}

function syncCodeChatDraftReferences(session, form, textarea) {
  if (!session || !textarea) return;
  session.chatDraft = textarea.value;
  session.draftFileReferences = extractCodeChatFileReferences(session, textarea.value);
  updateCodeChatReferenceList(form, session.draftFileReferences);
}

function refreshCodeChatReferencePicker(session, form, textarea) {
  if (!session || !textarea) return;
  const mention = findCodeChatMentionMatch(textarea.value, textarea.selectionStart);
  if (!mention) {
    activeChatReferencePicker = null;
    updateCodeChatReferencePicker(form, null);
    return;
  }
  const suggestions = getCodeChatReferenceSuggestions(session, mention.query);
  if (suggestions.length === 0) {
    activeChatReferencePicker = null;
    updateCodeChatReferencePicker(form, null);
    return;
  }
  const previousPath = activeChatReferencePicker?.sessionId === session.id
    ? activeChatReferencePicker.suggestions?.[activeChatReferencePicker.selectedIndex]?.path
    : null;
  let selectedIndex = 0;
  if (previousPath) {
    const matchIndex = suggestions.findIndex((entry) => entry.path === previousPath);
    if (matchIndex >= 0) selectedIndex = matchIndex;
  }
  activeChatReferencePicker = {
    sessionId: session.id,
    start: mention.start,
    end: mention.end,
    query: mention.query,
    suggestions,
    selectedIndex,
  };
  updateCodeChatReferencePicker(form, activeChatReferencePicker);
}

function applyCodeChatReferenceSuggestion(session, form, textarea, pathValue) {
  if (!session || !form || !textarea || !pathValue) return;
  const picker = activeChatReferencePicker;
  if (!picker || picker.sessionId !== session.id) return;
  const before = textarea.value.slice(0, picker.start);
  const after = textarea.value.slice(picker.end);
  const insertion = `@${pathValue}`;
  const shouldAppendSpace = !after || !/^[\s)\]}.,;:!?]/.test(after);
  const nextValue = `${before}${insertion}${shouldAppendSpace ? ' ' : ''}${after}`;
  const caretIndex = before.length + insertion.length + (shouldAppendSpace ? 1 : 0);
  textarea.value = nextValue;
  textarea.selectionStart = caretIndex;
  textarea.selectionEnd = caretIndex;
  activeChatReferencePicker = null;
  syncCodeChatDraftReferences(session, form, textarea);
  updateCodeChatReferencePicker(form, null);
  saveState(codeState);
  textarea.focus();
}

function getTaskBadgeCount(session) {
  return deriveTaskItems(session)
    .filter((item) => item.status !== 'completed')
    .filter((item) => item.id !== 'workspace-profile' && item.id !== 'workspace-map' && item.id !== 'working-set' && item.id !== 'focus-summary')
    .length;
}

function getCheckBadgeCount(session) {
  return deriveCheckItems(session).filter((item) => item.status !== 'pass' && item.status !== 'info').length;
}

function normalizePendingApprovals(values, existing = []) {
  const previousById = new Map(
    (Array.isArray(existing) ? existing : [])
      .filter((entry) => entry && typeof entry.id === 'string')
      .map((entry) => [entry.id, entry]),
  );
  return Array.isArray(values)
    ? values
      .filter((entry) => entry && typeof entry.id === 'string')
      .map((entry) => {
        const previous = previousById.get(entry.id) || {};
        return {
          id: entry.id,
          toolName: String(entry.toolName || previous.toolName || 'unknown'),
          argsPreview: String(entry.argsPreview || previous.argsPreview || ''),
          createdAt: Number(entry.createdAt || previous.createdAt) || null,
          risk: String(entry.risk || previous.risk || ''),
          origin: String(entry.origin || previous.origin || ''),
        };
      })
    : [];
}

function disposeTerminalInstance(tabId) {
  const instance = terminalInstances.get(tabId);
  if (!instance) return;
  instance.resizeObserver?.disconnect?.();
  instance.term.dispose();
  terminalInstances.delete(tabId);
}

function disposeInactiveTerminalInstances(activeTabs) {
  const keep = new Set((activeTabs || []).map((tab) => tab.id));
  for (const tabId of Array.from(terminalInstances.keys())) {
    if (!keep.has(tabId)) {
      disposeTerminalInstance(tabId);
    }
  }
}

async function mountActiveTerminals(container, session, { focusTabId = null } = {}) {
  const tabs = session?.terminalTabs || [];
  disposeInactiveTerminalInstances(tabs);
  if (tabs.length === 0) return;
  const { Terminal, FitAddon } = await loadTerminalLib();
  for (const tab of tabs) {
    const host = container.querySelector(`[data-terminal-viewport="${tab.id}"]`);
    if (!host) {
      disposeTerminalInstance(tab.id);
      continue;
    }
    const existing = terminalInstances.get(tab.id);
    if (existing?.host === host) {
      existing.fitAddon.fit();
      if (focusTabId && focusTabId === tab.id) {
        existing.term.focus();
      }
      continue;
    }
    disposeTerminalInstance(tab.id);
    host.innerHTML = '';
    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: '#0b1220',
        foreground: '#e5edf7',
        cursor: '#f8fafc',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    const helperTextarea = host.querySelector('textarea');
    fitAddon.fit();
    if (tab.output) {
      term.write(tab.output);
    }
    term.attachCustomKeyEventHandler((event) => {
      const isCopy = event.type === 'keydown' && event.key.toLowerCase() === 'c' && (event.ctrlKey || event.metaKey);
      if (isCopy && term.hasSelection()) {
        void copyTextToClipboard(term.getSelection());
        term.clearSelection();
        event.preventDefault();
        return false;
      }
      const isPaste = event.type === 'keydown'
        && (
          (event.key.toLowerCase() === 'v' && (event.ctrlKey || event.metaKey))
          || (event.key === 'Insert' && event.shiftKey)
        );
      if (isPaste) {
        event.preventDefault();
        void forwardTerminalPaste(event, tab);
        return false;
      }
      return true;
    });
    term.onData((data) => {
      if (!tab.runtimeTerminalId) return;
      forwardTerminalText(tab, data);
    });
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (tab.runtimeTerminalId) {
        api.codeTerminalResize(tab.runtimeTerminalId, {
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {});
      }
    });
    resizeObserver.observe(host);
    host.addEventListener('click', () => term.focus());
    const handlePaste = (event) => {
      event.preventDefault();
      void forwardTerminalPaste(event, tab);
    };
    const handleBeforeInput = (event) => {
      if (!shouldBridgeTerminalTextInput(event)) return;
      event.preventDefault();
      const text = typeof event.data === 'string' ? event.data : '';
      void forwardTerminalInsertedText(event, tab, text);
    };
    const handleInput = (event) => {
      const text = typeof helperTextarea?.value === 'string' ? helperTextarea.value : '';
      if (!shouldBridgeTerminalTextInput(event, text)) return;
      if (helperTextarea) helperTextarea.value = '';
      event.preventDefault?.();
      void forwardTerminalInsertedText(event, tab, text);
    };
    host.addEventListener('paste', handlePaste, true);
    helperTextarea?.addEventListener('paste', handlePaste, true);
    host.addEventListener('beforeinput', handleBeforeInput, true);
    helperTextarea?.addEventListener('beforeinput', handleBeforeInput, true);
    helperTextarea?.addEventListener('input', handleInput, true);
    if (focusTabId && focusTabId === tab.id) {
      term.focus();
    }
    if (tab.runtimeTerminalId) {
      api.codeTerminalResize(tab.runtimeTerminalId, {
        cols: term.cols,
        rows: term.rows,
      }).catch(() => {});
    }
    terminalInstances.set(tab.id, { term, fitAddon, resizeObserver, host });
  }
}

function mapServerHistory(history) {
  return Array.isArray(history)
    ? history
      .map((entry) => normalizeVisibleHistoryEntry(entry))
      .filter(Boolean)
    : [];
}

function normalizeVisibleHistoryEntry(entry) {
  const role = entry?.role === 'user' ? 'user' : 'agent';
  const content = sanitizeVisibleHistoryContent(role, String(entry?.content || ''));
  if (!content) return null;
  const responseSource = normalizeCodeResponseSource(entry?.responseSource || entry?.metadata?.responseSource);
  return {
    role,
    content,
    timestamp: Number(entry?.timestamp) || Date.now(),
    ...(responseSource ? { responseSource } : {}),
  };
}

function normalizeCodeResponseSource(value) {
  if (!value || typeof value !== 'object') return null;
  const locality = value.locality === 'local' || value.locality === 'external'
    ? value.locality
    : null;
  if (!locality) return null;
  return {
    locality,
    ...(typeof value.providerName === 'string' && value.providerName ? { providerName: value.providerName } : {}),
    ...(value.tier === 'local' || value.tier === 'external' ? { tier: value.tier } : {}),
    ...(value.usedFallback === true ? { usedFallback: true } : {}),
    ...(typeof value.notice === 'string' && value.notice ? { notice: value.notice } : {}),
  };
}

function sanitizeVisibleHistoryContent(role, content) {
  if (!content) return '';
  if (role !== 'user') return content;
  if (content.startsWith('[Code Approval Continuation]')) {
    return '';
  }
  if (!content.startsWith('[Code Workspace Context]')) {
    return content;
  }
  const rulesMarker = '\n\n[Code Workspace Operating Rules]\n';
  const rulesIndex = content.indexOf(rulesMarker);
  if (rulesIndex < 0) return content;
  const afterRules = content.indexOf('\n\n', rulesIndex + rulesMarker.length);
  if (afterRules < 0) return content;
  return content.slice(afterRules + 2).trim();
}

function normalizeWorkspaceProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    repoName: profile.repoName || '',
    repoKind: profile.repoKind || '',
    summary: profile.summary || '',
    stack: Array.isArray(profile.stack) ? profile.stack.map((value) => String(value)) : [],
    manifests: Array.isArray(profile.manifests) ? profile.manifests.map((value) => String(value)) : [],
    inspectedFiles: Array.isArray(profile.inspectedFiles) ? profile.inspectedFiles.map((value) => String(value)) : [],
    topLevelEntries: Array.isArray(profile.topLevelEntries) ? profile.topLevelEntries.map((value) => String(value)) : [],
    entryHints: Array.isArray(profile.entryHints) ? profile.entryHints.map((value) => String(value)) : [],
    lastIndexedAt: Number(profile.lastIndexedAt) || 0,
  };
}

function normalizeWorkspaceTrust(trust) {
  if (!trust || typeof trust !== 'object') return null;
  const nativeProtection = trust.nativeProtection && typeof trust.nativeProtection === 'object'
    ? {
      provider: String(trust.nativeProtection.provider || ''),
      status: String(trust.nativeProtection.status || 'pending'),
      summary: String(trust.nativeProtection.summary || ''),
      observedAt: Number(trust.nativeProtection.observedAt) || 0,
      requestedAt: Number(trust.nativeProtection.requestedAt) || 0,
      details: Array.isArray(trust.nativeProtection.details)
        ? trust.nativeProtection.details.map((value) => String(value))
        : [],
    }
    : null;
  return {
    state: String(trust.state || 'trusted'),
    summary: String(trust.summary || ''),
    assessedAt: Number(trust.assessedAt) || 0,
    scannedFiles: Number(trust.scannedFiles) || 0,
    truncated: !!trust.truncated,
    findings: Array.isArray(trust.findings)
      ? trust.findings.map((finding) => ({
        severity: String(finding?.severity || 'warn'),
        kind: String(finding?.kind || 'unknown'),
        path: String(finding?.path || ''),
        summary: String(finding?.summary || ''),
        evidence: String(finding?.evidence || ''),
      }))
      : [],
    nativeProtection,
  };
}

function normalizeWorkspaceTrustReview(review) {
  if (!review || typeof review !== 'object') return null;
  return {
    decision: String(review.decision || ''),
    reviewedAt: Number(review.reviewedAt) || 0,
    reviewedBy: String(review.reviewedBy || ''),
    assessmentFingerprint: String(review.assessmentFingerprint || ''),
    rawState: String(review.rawState || ''),
    findingCount: Number(review.findingCount) || 0,
  };
}

function normalizeWorkspaceMapFileEntry(entry) {
  if (!entry || typeof entry !== 'object' || !entry.path) return null;
  return {
    path: String(entry.path),
    category: entry.category ? String(entry.category) : '',
    extension: entry.extension ? String(entry.extension) : '',
    size: Number(entry.size) || 0,
    summary: entry.summary ? String(entry.summary) : '',
    symbols: Array.isArray(entry.symbols) ? entry.symbols.map((value) => String(value)) : [],
    imports: Array.isArray(entry.imports) ? entry.imports.map((value) => String(value)) : [],
    keywords: Array.isArray(entry.keywords) ? entry.keywords.map((value) => String(value)) : [],
  };
}

function normalizeWorkspaceMap(map) {
  if (!map || typeof map !== 'object') return null;
  return {
    indexedFileCount: Number(map.indexedFileCount) || 0,
    totalDiscoveredFiles: Number(map.totalDiscoveredFiles) || 0,
    truncated: !!map.truncated,
    notableFiles: Array.isArray(map.notableFiles) ? map.notableFiles.map((value) => String(value)) : [],
    directories: Array.isArray(map.directories)
      ? map.directories.map((entry) => ({
        path: entry?.path ? String(entry.path) : '.',
        fileCount: Number(entry?.fileCount) || 0,
        sampleFiles: Array.isArray(entry?.sampleFiles) ? entry.sampleFiles.map((value) => String(value)) : [],
      }))
      : [],
    files: Array.isArray(map.files)
      ? map.files.map((entry) => normalizeWorkspaceMapFileEntry(entry)).filter((entry) => entry?.path)
      : [],
    lastIndexedAt: Number(map.lastIndexedAt) || 0,
  };
}

function normalizeWorkspaceWorkingSet(workingSet) {
  if (!workingSet || typeof workingSet !== 'object') return null;
  return {
    query: workingSet.query || '',
    rationale: workingSet.rationale || '',
    retrievedAt: Number(workingSet.retrievedAt) || 0,
    files: Array.isArray(workingSet.files)
      ? workingSet.files.map((entry) => ({
        path: entry?.path ? String(entry.path) : '',
        category: entry?.category ? String(entry.category) : '',
        reason: entry?.reason ? String(entry.reason) : '',
        summary: entry?.summary ? String(entry.summary) : '',
      })).filter((entry) => entry.path)
      : [],
  };
}

function normalizeDraftFileReferences(value) {
  if (!Array.isArray(value)) return [];
  const deduped = [];
  const seen = new Set();
  for (const entry of value) {
    const normalized = String(entry || '')
      .trim()
      .replace(/^@/, '')
      .replace(/[\\/]+/g, '/')
      .replace(/^\.\/+/, '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= MAX_CHAT_FILE_REFERENCES) break;
  }
  return deduped;
}

function normalizeServerSession(record, existing = {}) {
  const uiState = getEffectiveSessionUiState(record, existing);
  const workState = record?.workState || {};
  const hasWorkspaceProfile = Object.prototype.hasOwnProperty.call(workState, 'workspaceProfile');
  const hasWorkspaceTrust = Object.prototype.hasOwnProperty.call(workState, 'workspaceTrust');
  const hasWorkspaceTrustReview = Object.prototype.hasOwnProperty.call(workState, 'workspaceTrustReview');
  const hasWorkspaceMap = Object.prototype.hasOwnProperty.call(workState, 'workspaceMap');
  const hasWorkingSet = Object.prototype.hasOwnProperty.call(workState, 'workingSet');
  return {
    ...existing,
    id: record.id,
    title: record.title || 'Coding Session',
    workspaceRoot: record.workspaceRoot || '.',
    resolvedRoot: record.resolvedRoot || record.workspaceRoot || '.',
    currentDirectory: uiState.currentDirectory || record.resolvedRoot || record.workspaceRoot || '.',
    selectedFilePath: uiState.selectedFilePath || null,
    showDiff: !!uiState.showDiff,
    agentId: record.agentId || null,
    status: record.status || 'idle',
    conversationUserId: record.conversationUserId || '',
    conversationChannel: record.conversationChannel || 'code-session',
    terminalTabs: normalizeTerminalTabs(uiState.terminalTabs, existing.terminalTabs),
    terminalCollapsed: !!uiState.terminalCollapsed,
    expandedDirs: Array.isArray(uiState.expandedDirs) ? uiState.expandedDirs : [],
    chat: Array.isArray(existing.chat) ? existing.chat : [],
    chatDraft: existing.chatDraft || '',
    draftFileReferences: normalizeDraftFileReferences(existing.draftFileReferences),
    pendingApprovals: normalizePendingApprovals(workState.pendingApprovals, existing.pendingApprovals),
    activeSkills: Array.isArray(workState.activeSkills) ? workState.activeSkills.map((value) => String(value)) : [],
    recentJobs: Array.isArray(workState.recentJobs) ? workState.recentJobs.slice(0, MAX_SESSION_JOBS) : [],
    verification: normalizeVerificationEntries(workState.verification, existing.verification),
    focusSummary: workState.focusSummary || '',
    planSummary: workState.planSummary || '',
    compactedSummary: workState.compactedSummary || '',
    workspaceProfile: hasWorkspaceProfile ? normalizeWorkspaceProfile(workState.workspaceProfile) : (existing.workspaceProfile || null),
    workspaceTrust: hasWorkspaceTrust ? normalizeWorkspaceTrust(workState.workspaceTrust) : (existing.workspaceTrust || null),
    workspaceTrustReview: hasWorkspaceTrustReview ? normalizeWorkspaceTrustReview(workState.workspaceTrustReview) : (existing.workspaceTrustReview || null),
    workspaceMap: hasWorkspaceMap ? normalizeWorkspaceMap(workState.workspaceMap) : (existing.workspaceMap || null),
    workingSet: hasWorkingSet ? normalizeWorkspaceWorkingSet(workState.workingSet) : (existing.workingSet || null),
    timelineRuns: normalizeTimelineRuns(existing.timelineRuns),
    structureView: normalizeStructureView(existing.structureView, existing.structureView),
    activeAssistantTab: normalizeAssistantTabValue(uiState.activeAssistantTab || existing.activeAssistantTab),
    inspectorOpen: !!existing.inspectorOpen,
    inspectorDetached: !!existing.inspectorDetached,
    inspectorTab: normalizeInspectorTabValue(existing.inspectorTab),
    lastExplorerPath: existing.lastExplorerPath || null,
  };
}

function normalizeVerificationEntries(value, fallback = []) {
  if (!Array.isArray(value)) return Array.isArray(fallback) ? fallback : [];
  return value
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') return null;
      const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `verification-${index}`;
      const kind = typeof entry.kind === 'string' && ['test', 'lint', 'build', 'manual'].includes(entry.kind)
        ? entry.kind
        : 'manual';
      const status = typeof entry.status === 'string' && ['pass', 'warn', 'fail', 'not_run'].includes(entry.status)
        ? entry.status
        : 'not_run';
      const summary = typeof entry.summary === 'string' ? entry.summary : '';
      const timestamp = Number.isFinite(entry.timestamp) ? Number(entry.timestamp) : 0;
      return { id, kind, status, summary, timestamp };
    })
    .filter(Boolean);
}

function normalizeTimelineItem(item) {
  if (!item || typeof item !== 'object') return null;
  const id = typeof item.id === 'string' ? item.id : '';
  const runId = typeof item.runId === 'string' ? item.runId : '';
  const timestamp = Number(item.timestamp) || 0;
  const title = typeof item.title === 'string' ? item.title : '';
  if (!id || !runId || !timestamp || !title) return null;
  return {
    id,
    runId,
    timestamp,
    type: typeof item.type === 'string' ? item.type : 'note',
    status: typeof item.status === 'string' ? item.status : 'info',
    source: typeof item.source === 'string' ? item.source : 'system',
    title,
    detail: typeof item.detail === 'string' ? item.detail : '',
  };
}

function normalizeTimelineSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const runId = typeof summary.runId === 'string' ? summary.runId : '';
  if (!runId) return null;
  return {
    runId,
    kind: typeof summary.kind === 'string' ? summary.kind : 'assistant_dispatch',
    status: typeof summary.status === 'string' ? summary.status : 'queued',
    title: typeof summary.title === 'string' ? summary.title : runId,
    subtitle: typeof summary.subtitle === 'string' ? summary.subtitle : '',
    channel: typeof summary.channel === 'string' ? summary.channel : '',
    agentId: typeof summary.agentId === 'string' ? summary.agentId : '',
    codeSessionId: typeof summary.codeSessionId === 'string' ? summary.codeSessionId : '',
    lastUpdatedAt: Number(summary.lastUpdatedAt) || 0,
    startedAt: Number(summary.startedAt) || 0,
    completedAt: Number(summary.completedAt) || 0,
    durationMs: Number(summary.durationMs) || 0,
    pendingApprovalCount: Number(summary.pendingApprovalCount) || 0,
    verificationPendingCount: Number(summary.verificationPendingCount) || 0,
  };
}

function normalizeTimelineRun(run) {
  if (!run || typeof run !== 'object') return null;
  const summary = normalizeTimelineSummary(run.summary);
  if (!summary) return null;
  const items = Array.isArray(run.items)
    ? run.items.map((item) => normalizeTimelineItem(item)).filter(Boolean)
    : [];
  return { summary, items };
}

function normalizeTimelineRuns(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((run) => normalizeTimelineRun(run))
    .filter(Boolean)
    .sort((left, right) => (right.summary.lastUpdatedAt || 0) - (left.summary.lastUpdatedAt || 0))
    .slice(0, MAX_TIMELINE_RUNS);
}

function mergeCodeSessionRecord(snapshot, existing = {}) {
  if (!snapshot?.session) return null;
  const merged = normalizeServerSession(snapshot.session, existing);
  upsertSession(merged);
  return merged;
}

function upsertSession(session) {
  const index = codeState.sessions.findIndex((entry) => entry.id === session.id);
  if (index >= 0) {
    codeState.sessions.splice(index, 1, session);
  } else {
    codeState.sessions.unshift(session);
  }
  return session;
}

function mergeSessionsFromServer(payload) {
  const previousById = new Map((codeState.sessions || []).map((session) => [session.id, session]));
  const sessions = Array.isArray(payload?.sessions)
    ? payload.sessions.map((record) => normalizeServerSession(record, previousById.get(record.id) || {}))
    : [];
  codeState.sessions = sessions;
  const serverCurrentSessionId = typeof payload?.currentSessionId === 'string' ? payload.currentSessionId : null;
  const preferredActiveId = codeState.activeSessionId && sessions.some((session) => session.id === codeState.activeSessionId)
    ? codeState.activeSessionId
    : (serverCurrentSessionId && sessions.some((session) => session.id === serverCurrentSessionId)
      ? serverCurrentSessionId
      : sessions[0]?.id || null);
  codeState.activeSessionId = preferredActiveId;
}

function applyCodeSessionSnapshot(snapshot) {
  if (!snapshot?.session) return null;
  const existing = codeState.sessions.find((session) => session.id === snapshot.session.id) || {};
  const merged = mergeCodeSessionRecord(snapshot, existing);
  if (!merged) return null;
  merged.chat = mapServerHistory(snapshot.history);
  return merged;
}

async function refreshSessionsIndex() {
  const result = await api.codeSessions({ channel: DEFAULT_USER_CHANNEL });
  mergeSessionsFromServer(result);
  saveState(codeState);
  return codeState.sessions;
}

async function refreshSessionSnapshot(sessionId, { historyLimit = 120 } = {}) {
  const snapshot = await api.codeSessionGet(sessionId, {
    channel: DEFAULT_USER_CHANNEL,
    historyLimit,
  });
  const session = applyCodeSessionSnapshot(snapshot);
  saveState(codeState);
  return session;
}

async function ensureBackendSession(session) {
  if (!session?.id) return null;
  const fresh = await refreshSessionSnapshot(session.id).catch(() => null);
  if (!fresh) return null;
  await api.codeSessionAttach(fresh.id, { channel: DEFAULT_USER_CHANNEL }).catch(() => {});
  return fresh;
}

function buildCodeSessionUiState(session) {
  return {
    currentDirectory: session.currentDirectory || session.resolvedRoot || session.workspaceRoot || '.',
    selectedFilePath: session.selectedFilePath || null,
    showDiff: !!session.showDiff,
    expandedDirs: Array.isArray(session.expandedDirs) ? session.expandedDirs : [],
    activeAssistantTab: normalizeAssistantTabValue(session.activeAssistantTab),
    terminalCollapsed: !!session.terminalCollapsed,
    terminalTabs: Array.isArray(session.terminalTabs)
      ? session.terminalTabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        shell: normalizeTerminalShell(tab.shell),
      }))
      : [],
  };
}

function queueSessionPersist(session) {
  if (!session?.id) return;
  pendingSessionUiStateById.set(session.id, buildCodeSessionUiState(session));
  const existing = sessionPersistTimers.get(session.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    sessionPersistTimers.delete(session.id);
    try {
      const snapshot = await api.codeSessionUpdate(session.id, {
        channel: DEFAULT_USER_CHANNEL,
        uiState: buildCodeSessionUiState(session),
        agentId: session.agentId || null,
      });
      applyCodeSessionSnapshot(snapshot);
      saveState(codeState);
      if (currentContainer) rerenderFromState();
    } catch {
      // Best-effort UI persistence. The next snapshot refresh will reconcile state.
    }
  }, 150);
  sessionPersistTimers.set(session.id, timer);
}

function ensureSessionRefreshLoop() {
  if (sessionRefreshInterval) return;
  sessionRefreshInterval = setInterval(async () => {
    const activeSession = getActiveSession();
    if (!activeSession || !currentContainer) return;
    try {
      const previousSignature = getSessionRenderSignature(activeSession);
      const previousTreeSignature = getVisibleTreeSignature(activeSession);
      const session = await refreshSessionSnapshot(activeSession.id);
      if (!session) return;
      await refreshVisibleTreeDirs(session);
      await refreshAssistantState(session, { rerender: false });
      if (getSessionRenderSignature(session) !== previousSignature || getVisibleTreeSignature(session) !== previousTreeSignature) {
        rerenderFromState();
      }
    } catch {
      // Ignore transient refresh failures; the next tick can recover.
    }
  }, SESSION_REFRESH_INTERVAL_MS);
}

// ─── Render pipeline ──────────────────────────────────────

export async function renderCode(container) {
  const lifecycleId = ++codeViewLifecycleId;
  renderInFlight = true;
  currentContainer = container;
  bindTerminalListeners();
  bindRunTimelineListeners();

  // Start loading Monaco in parallel with data fetches
  loadMonaco().catch(() => {});

  if (!hasRenderedOnce) {
    container.innerHTML = '<div class="loading" style="padding:2rem">Loading coding workspace...</div>';
  }

  try {
    const [agents, statusResult] = await Promise.all([
      api.agents().catch(() => []),
      api.status().catch(() => null),
    ]);
    cachedAgents = agents.filter(isCodeSelectableAgent);
    if (statusResult?.platform) detectedPlatform = statusResult.platform;
    if (Array.isArray(statusResult?.shellOptions)) shellOptionsCache = statusResult.shellOptions;

    codeState = normalizeState(codeState, cachedAgents);
    await refreshSessionsIndex().catch(() => {
      saveState(codeState);
    });
    if (!isActiveCodeView(container, lifecycleId)) return;
    ensureSessionRefreshLoop();

    let activeSession = getActiveSession();
    if (activeSession) {
      activeSession = await refreshSessionSnapshot(activeSession.id).catch(() => activeSession);
      // Re-attach on page load so the backend attachment record stays fresh.
      // After a backend restart the in-memory session map is lost, so the old
      // attachment (keyed by the previous principalId/surfaceId) may be stale.
      if (activeSession?.id) {
        await api.codeSessionAttach(activeSession.id, { channel: DEFAULT_USER_CHANNEL }).catch(() => {});
      }
    }
    if (!isActiveCodeView(container, lifecycleId)) return;
    if (activeSession) {
      // Load root tree dir if not cached
      const rootPath = activeSession.resolvedRoot || activeSession.workspaceRoot || '.';
      if (!treeCache.has(rootPath)) {
        const rootData = await loadTreeDir(activeSession, rootPath);
        treeCache.set(rootPath, rootData);
        if (!activeSession.resolvedRoot && rootData.resolvedPath) {
          activeSession.resolvedRoot = rootData.resolvedPath;
        }
      }
      if (!isActiveCodeView(container, lifecycleId)) return;
      // Load expanded dirs
      await loadExpandedDirs(activeSession);
      const [fileView, structureView] = await Promise.all([
        loadFileView(activeSession),
        loadStructureView(activeSession),
      ]);
      cachedFileView = fileView;
      invalidateStructurePreviewState(activeSession.id, activeSession.selectedFilePath || '');
      activeSession.structureView = structureView;
      await ensureSessionTerminals(activeSession);
      await refreshAssistantState(activeSession, { rerender: false });
      saveState(codeState);
    } else {
      cachedFileView = { source: '', diff: '', error: null };
    }
    if (!isActiveCodeView(container, lifecycleId)) return;

    renderDOM(container);
    hasRenderedOnce = true;
  } catch (err) {
    if (isActiveCodeView(container, lifecycleId)) {
      container.innerHTML = `<div class="loading" style="padding:2rem">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
    }
  } finally {
    if (lifecycleId === codeViewLifecycleId) {
      renderInFlight = false;
    }
  }
}

export function updateCode() {
  if (!currentContainer) return;
  const activeSession = getActiveSession();
  if (activeSession) {
    void refreshSessionData(activeSession);
  } else {
    void refreshSessionsIndex().then(() => rerenderFromState()).catch(() => {});
  }
}

export function teardownCode() {
  codeViewLifecycleId += 1;
  currentContainer = null;
  pendingTerminalFocusTabId = null;
  renderInFlight = false;
  closeDetachedInspectorWindow();
  for (const [, previewState] of structurePreviewStateBySessionId) {
    if (previewState?.timer) {
      clearTimeout(previewState.timer);
    }
  }
  structurePreviewStateBySessionId = new Map();
  pendingSessionUiStateById = new Map();
  editorSearchStateBySessionId = new Map();
  if (deferredSelectionRerenderTimer) {
    clearTimeout(deferredSelectionRerenderTimer);
    deferredSelectionRerenderTimer = null;
  }
  if (sessionRefreshInterval) {
    clearInterval(sessionRefreshInterval);
    sessionRefreshInterval = null;
  }
  disposeInactiveTerminalInstances([]);
  disposeMonacoEditors();
  disposeAllModels();
}

function rerenderFromState() {
  if (!currentContainer) return;
  if (hasActiveChatSelection(currentContainer)) {
    if (deferredSelectionRerenderTimer) return;
    deferredSelectionRerenderTimer = window.setTimeout(() => {
      deferredSelectionRerenderTimer = null;
      if (currentContainer) rerenderFromState();
    }, 250);
    return;
  }
  if (deferredSelectionRerenderTimer) {
    clearTimeout(deferredSelectionRerenderTimer);
    deferredSelectionRerenderTimer = null;
  }
  renderDOM(currentContainer, { focusTerminalTabId: pendingTerminalFocusTabId });
  pendingTerminalFocusTabId = null;
  const activeSession = getActiveSession();
  if (activeSession) {
    void ensureSessionTerminals(activeSession);
  }
  syncDetachedInspectorWindow(activeSession);
}

function saveScrollPositions(container) {
  const positions = {};
  for (const sel of SCROLL_SELECTORS) {
    const el = container.querySelector(sel);
    if (el) positions[sel] = el.scrollTop;
  }
  return positions;
}

function restoreScrollPositions(container, positions) {
  for (const [sel, top] of Object.entries(positions)) {
    const el = container.querySelector(sel);
    if (el) el.scrollTop = top;
  }
}

function captureFocusState(container) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !container.contains(active)) return null;

  const terminalPane = active.closest('.code-terminal-pane[data-pane-id]');
  if (terminalPane instanceof HTMLElement) {
    return {
      type: 'terminal',
      tabId: terminalPane.dataset.paneId || null,
    };
  }

  if (active.matches('[data-code-chat-form] textarea[name="message"]')) {
    return captureSelectionState({ type: 'chat-input' }, active);
  }

  if (active.matches('[data-code-session-form] [name]')) {
    return captureSelectionState({
      type: 'create-session-form',
      name: active.getAttribute('name') || '',
    }, active);
  }

  if (active.matches('[data-code-edit-session-form] [name]')) {
    return captureSelectionState({
      type: 'edit-session-form',
      name: active.getAttribute('name') || '',
    }, active);
  }

  return null;
}

function captureSelectionState(state, element) {
  if (typeof element.selectionStart === 'number') {
    state.selectionStart = element.selectionStart;
    state.selectionEnd = typeof element.selectionEnd === 'number' ? element.selectionEnd : element.selectionStart;
    state.selectionDirection = element.selectionDirection || 'none';
  }
  return state;
}

function restoreFocusState(container, state) {
  if (!state || state.type === 'terminal') return;
  let selector = '';
  if (state.type === 'chat-input') {
    selector = '[data-code-chat-form] textarea[name="message"]';
  } else if (state.type === 'create-session-form' && state.name) {
    selector = `[data-code-session-form] [name="${state.name}"]`;
  } else if (state.type === 'edit-session-form' && state.name) {
    selector = `[data-code-edit-session-form] [name="${state.name}"]`;
  }
  if (!selector) return;
  const element = container.querySelector(selector);
  if (!(element instanceof HTMLElement)) return;
  element.focus({ preventScroll: true });
  if (typeof element.setSelectionRange === 'function' && typeof state.selectionStart === 'number') {
    try {
      element.setSelectionRange(state.selectionStart, state.selectionEnd, state.selectionDirection);
    } catch {
      // Ignore controls that do not support selection restoration.
    }
  }
}

function hasActiveChatSelection(container) {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const chatHistory = container.querySelector('.code-chat__history');
  if (!chatHistory) return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    const common = range.commonAncestorContainer;
    const node = common?.nodeType === Node.TEXT_NODE ? common.parentNode : common;
    if (node instanceof Node && chatHistory.contains(node)) {
      return true;
    }
  }
  return false;
}

function getSessionRenderSignature(session) {
  if (!session) return '';
  return JSON.stringify({
    title: session.title || '',
    workspaceRoot: session.workspaceRoot || '',
    resolvedRoot: session.resolvedRoot || '',
    currentDirectory: session.currentDirectory || '',
    selectedFilePath: session.selectedFilePath || '',
    showDiff: !!session.showDiff,
    status: session.status || '',
    expandedDirs: Array.isArray(session.expandedDirs) ? session.expandedDirs : [],
    chat: Array.isArray(session.chat)
      ? session.chat.map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp || 0,
        responseSource: message.responseSource || null,
      }))
      : [],
    pendingApprovals: Array.isArray(session.pendingApprovals)
      ? session.pendingApprovals.map((approval) => ({
        id: approval.id,
        toolName: approval.toolName,
        argsPreview: approval.argsPreview,
        createdAt: approval.createdAt || null,
        risk: approval.risk || '',
        origin: approval.origin || '',
      }))
      : [],
    activeSkills: Array.isArray(session.activeSkills) ? session.activeSkills : [],
    recentJobs: Array.isArray(session.recentJobs)
      ? session.recentJobs.map((job) => ({
        id: job.id,
        toolName: job.toolName,
        status: job.status,
        resultPreview: job.resultPreview || '',
        error: job.error || '',
        argsPreview: job.argsPreview || '',
        verificationStatus: job.verificationStatus || '',
        verificationEvidence: job.verificationEvidence || '',
        createdAt: job.createdAt || 0,
      }))
      : [],
    focusSummary: session.focusSummary || '',
    planSummary: session.planSummary || '',
    compactedSummary: session.compactedSummary || '',
    workspaceProfile: normalizeWorkspaceProfile(session.workspaceProfile),
    workspaceTrust: normalizeWorkspaceTrust(session.workspaceTrust),
    workspaceMap: normalizeWorkspaceMap(session.workspaceMap),
    workingSet: normalizeWorkspaceWorkingSet(session.workingSet),
    activeAssistantTab: session.activeAssistantTab || 'chat',
    terminalCollapsed: !!session.terminalCollapsed,
    terminalTabs: Array.isArray(session.terminalTabs)
      ? session.terminalTabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        shell: normalizeTerminalShell(tab.shell),
      }))
      : [],
  });
}

function scrollToBottom(container, selector) {
  const el = container.querySelector(selector);
  if (el) el.scrollTop = el.scrollHeight;
}

async function ensureSessionTerminals(session) {
  if (!session?.terminalTabs?.length) return;
  await Promise.all(session.terminalTabs.map((tab) => ensureTerminalConnected(session, tab)));
}

async function ensureTerminalConnected(session, tab) {
  if (!tab || tab.runtimeTerminalId || tab.connecting || tab.openFailed) return;
  tab.connecting = true;
  tab.openError = '';
  if (!tab.output) {
    tab.output = 'Connecting to terminal...\n';
  }
  saveState(codeState);
  try {
    const result = await api.codeTerminalOpen({
      sessionId: session.id,
      cwd: session.currentDirectory || session.resolvedRoot || session.workspaceRoot,
      shell: normalizeTerminalShell(tab.shell),
      cols: 120,
      rows: 30,
    });
    tab.runtimeTerminalId = result?.terminalId || null;
    tab.connected = !!tab.runtimeTerminalId;
    tab.openFailed = false;
    tab.openError = '';
    if (tab.output === 'Connecting to terminal...\n') {
      tab.output = '';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tab.connected = false;
    tab.runtimeTerminalId = null;
    tab.openFailed = true;
    tab.openError = message;
    tab.output = trimTerminalOutput(`${tab.output || ''}\n[terminal error: ${message}]\n`);
  } finally {
    tab.connecting = false;
    saveState(codeState);
  }
}

async function closeTerminal(tab) {
  if (!tab?.runtimeTerminalId) return;
  try {
    await api.codeTerminalClose(tab.runtimeTerminalId);
  } catch {
    // Best effort close.
  }
  tab.runtimeTerminalId = null;
  tab.connected = false;
  tab.openFailed = false;
  tab.openError = '';
}

function renderDOM(container, { focusTerminalTabId = null } = {}) {
  // Save Monaco view state before DOM wipe
  const prevSession = getActiveSession();
  const prevTab = prevSession ? getActiveTab(prevSession) : null;
  if (prevTab) saveMonacoViewState(prevTab.filePath);
  // Dispose Monaco instances (DOM will be destroyed by innerHTML)
  disposeMonacoEditors();

  const saved = saveScrollPositions(container);
  const focusState = captureFocusState(container);
  const activeSession = getActiveSession();
  const fileView = cachedFileView;
  const activePanel = codeState.activePanel !== undefined ? codeState.activePanel : 'sessions'; // 'sessions' | 'explorer' | 'git' | null
  const panelCollapsed = !activePanel;

  const activeTab = activeSession ? getActiveTab(activeSession) : null;
  const editorDirty = activeTab?.dirty || false;
  const openTabs = activeSession?.openTabs || [];
  const editorContent = activeTab
    ? `<div class="code-editor__monaco" data-monaco-editor></div>`
    : '';
  const tabBar = openTabs.length > 0 ? `
    <div class="code-editor__tabs">
      ${openTabs.map((tab, i) => `
        <button class="code-editor__tab ${i === activeSession.activeTabIndex ? 'is-active' : ''}" type="button" data-code-tab-index="${i}" title="${escAttr(tab.filePath)}">
          <span class="code-editor__tab-name">${tab.dirty ? '<span class="code-editor__dirty">&bull;</span> ' : ''}${esc(basename(tab.filePath))}</span>
          <span class="code-editor__tab-close" data-code-tab-close="${i}" title="Close">&times;</span>
        </button>
      `).join('')}
    </div>
  ` : '';

  const isCollapsed = activeSession?.terminalCollapsed;
  const terminalPanes = activeSession ? getVisibleTerminalPanes(activeSession) : [];

  container.innerHTML = `
    <div class="code-page">
      <div class="code-page__shell ${panelCollapsed ? 'panel-collapsed' : ''}">
        <aside class="code-side-panel ${panelCollapsed ? 'is-collapsed' : ''}">
          <nav class="code-side-panel__nav">
            <button class="code-side-panel__nav-btn ${activePanel === 'sessions' ? 'is-active' : ''}" type="button" data-code-panel-switch="sessions" title="Sessions">&#128451;</button>
            <button class="code-side-panel__nav-btn ${activePanel === 'explorer' ? 'is-active' : ''}" type="button" data-code-panel-switch="explorer" title="Explorer">&#128193;</button>
            <button class="code-side-panel__nav-btn ${activePanel === 'git' ? 'is-active' : ''}" type="button" data-code-panel-switch="git" title="Source Control">&#9095;</button>
          </nav>
          ${!panelCollapsed ? `
          ${activePanel === 'sessions' ? `
            <div class="code-side-panel__section">
              <div class="code-rail__header">
                <h3><span class="code-panel-title__icon">&#128451;</span> Sessions</h3>
                <button class="btn btn-primary btn-sm" type="button" data-code-new-session>+</button>
              </div>
              ${renderSessionForm()}
              <div class="code-rail__list">
                ${codeState.sessions.map((session) => renderSessionCard(session)).join('')}
              </div>
            </div>
          ` : ''}
          ${activePanel === 'explorer' ? `
            <div class="code-side-panel__section">
              <div class="panel__header">
                <h3><span class="code-panel-title__icon">&#128193;</span> Explorer</h3>
                ${activeSession ? `
                  <div class="panel__actions">
                    <button class="btn btn-secondary btn-sm" type="button" data-code-refresh-explorer title="Reload directory tree">&#x21BB;</button>
                  </div>
                ` : ''}
              </div>
              ${activeSession ? `
                <div class="code-file-list">
                  ${renderTree(activeSession.resolvedRoot || activeSession.workspaceRoot || '.', activeSession)}
                </div>
              ` : '<div class="empty-state">Create a session to browse.</div>'}
            </div>
          ` : ''}
          ${activePanel === 'git' ? `
            <div class="code-side-panel__section">
              <div class="panel__header">
                <h3><span class="code-panel-title__icon">&#9095;</span> Source Control</h3>
                ${activeSession ? `
                  <div class="panel__actions">
                    <button class="btn btn-secondary btn-sm" type="button" data-code-git-refresh title="Refresh git status">&#x21BB;</button>
                  </div>
                ` : ''}
              </div>
              ${activeSession ? renderGitPanel(activeSession) : '<div class="empty-state">Create a session to view source control.</div>'}
            </div>
          ` : ''}
          ` : ''}
        </aside>
        <section class="code-workspace">
          <div class="code-workspace__main ${isCollapsed ? 'terminals-collapsed' : ''}">
            <section class="code-editor panel">
              ${tabBar}
              <div class="panel__header">
                <h3>${activeTab ? `${esc(basename(activeTab.filePath))}${editorDirty ? ' <span class="code-editor__dirty" title="Unsaved changes">&bull;</span>' : ''}` : 'Editor'} <span class="code-tooltip-icon" title="Edit files directly. Changes are saved with the Save button or Ctrl+S. Use Split Diff to compare source and changes side by side.">&#9432;</span></h3>
                ${activeTab ? `
                  <div class="panel__actions">
                    ${renderEditorSearchToolbar(activeSession)}
                    <button class="btn btn-secondary btn-sm" type="button" data-code-open-structure title="Open guided code investigation">Inspect</button>
                    ${editorDirty ? '<button class="btn btn-primary btn-sm" type="button" data-code-save-file title="Save changes (Ctrl+S)">Save</button>' : ''}
                    <button class="btn btn-secondary btn-sm" type="button" data-code-refresh-file title="Reload file contents">&#x21BB;</button>
                    <button class="btn btn-secondary btn-sm" type="button" data-code-toggle-diff title="Toggle side-by-side source and diff view">${activeSession.showDiff ? 'Source Only' : 'Split Diff'}</button>
                    <select class="code-editor__theme-select" data-code-theme-select title="Editor theme">
                      ${THEME_REGISTRY.map((t) => `<option value="${escAttr(t.id)}" ${t.id === currentMonacoTheme ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
                    </select>
                  </div>
                ` : ''}
              </div>
              ${activeTab ? `
                <div class="code-path">${esc(activeTab.filePath)}</div>
                ${fileView.error ? `<div class="code-error">${esc(fileView.error)}</div>` : ''}
                ${editorContent}
              ` : '<div class="empty-state">Select a file to open.</div>'}
            </section>
            <div data-code-inspector-host>${renderCodeInspector(activeSession)}</div>
            <section class="code-terminals panel ${isCollapsed ? 'is-collapsed' : ''}">
              <div class="panel__header">
                <h3>Terminal <span class="code-tooltip-icon" title="Direct shell access from the selected workspace. This is a command-based terminal surface backed by your chosen shell.">&#9432;</span></h3>
                ${activeSession ? `
                  <div class="panel__actions">
                    <button class="btn btn-secondary btn-sm" type="button" data-code-toggle-terminal-collapse title="${isCollapsed ? 'Expand' : 'Collapse'} terminal panel">${isCollapsed ? '&#x25B2;' : '&#x25BC;'}</button>
                    ${!isCollapsed && terminalPanes.length < MAX_TERMINAL_PANES ? `
                      <button class="btn btn-secondary btn-sm" type="button" data-code-new-terminal title="Add terminal pane (max ${MAX_TERMINAL_PANES})">+ Terminal</button>
                    ` : ''}
                  </div>
                ` : ''}
              </div>
              ${!isCollapsed && activeSession ? `
                <div class="code-terminal-panes" style="grid-template-columns: repeat(${terminalPanes.length}, 1fr)">
                  ${terminalPanes.map((tab) => renderTerminalPane(activeSession, tab)).join('')}
                </div>
              ` : (!activeSession ? '<div class="empty-state">Create a session to open terminals.</div>' : '')}
            </section>
          </div>
          <aside class="code-chat panel">
            <div class="panel__header">
              <h3 class="code-chat__title"><span class="code-chat__title-icon">&#x1F4BB;</span><span>Coding Assistant</span></h3>
              ${activeSession ? `
                <div class="panel__actions">
                  <button class="btn btn-secondary btn-sm" type="button" data-code-reset-chat title="Clear conversation and start fresh">Clear Chat</button>
                </div>
              ` : ''}
            </div>
            ${activeSession ? `
              <div data-code-assistant-tabs-host>${renderAssistantTabs(activeSession)}</div>
              <div class="code-assistant-panel" data-code-assistant-panel-host>${renderAssistantPanel(activeSession)}</div>
            ` : '<div class="empty-state">Create a session to start chatting.</div>'}
          </aside>
        </section>
      </div>
    </div>
  `;

  bindEvents(container);
  restoreScrollPositions(container, saved);
  restoreFocusState(container, focusState);
  if (activeSession) {
    const terminalFocusTabId = focusTerminalTabId || (focusState?.type === 'terminal' ? focusState.tabId : null);
    void mountActiveTerminals(container, activeSession, { focusTabId: terminalFocusTabId });
  } else {
    disposeInactiveTerminalInstances([]);
    disposeMonacoEditors();
    disposeAllModels();
    resetMonacoEditorSearchDecorations();
  }

  // Mount Monaco editor after DOM is ready
  if (activeTab) {
    const monacoContainer = container.querySelector('[data-monaco-editor]');
    if (monacoContainer) {
      loadMonaco().then(() => {
        if (!isActiveCodeView(container, codeViewLifecycleId)) return;
        const src = activeTab.content ?? fileView.source ?? '';
        const isDiff = activeSession.showDiff;
        mountMonacoEditor(monacoContainer, activeTab.filePath, src, isDiff, fileView.source || '');
        syncEditorSearchState(activeSession, { reveal: false, preserveIndex: true });
      }).catch((err) => {
        monacoContainer.innerHTML = `<div class="code-error" style="padding:1rem">Failed to load editor: ${esc(err.message)}</div>`;
      });
    }
  } else {
    updateEditorSearchControls(activeSession);
  }
}

// ─── Tree Explorer ─────────────────────────────────────────

function renderTree(rootPath, session) {
  const cached = treeCache.get(rootPath);
  if (!cached) return '<div class="empty-inline">Loading...</div>';
  if (cached.error) return `<div class="code-error">${esc(cached.error)}</div>`;
  if (!cached.entries || cached.entries.length === 0) return '<div class="empty-inline">Empty directory.</div>';
  return renderTreeEntries(rootPath, cached.entries, 0, session);
}

function renderTreeEntries(basePath, entries, depth, session) {
  const expandedDirs = session.expandedDirs || [];
  // Sort: dirs first, then files, alphabetical
  const sorted = [...entries].sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });

  return sorted.map((entry) => {
    const fullPath = joinWorkspacePath(basePath, entry.name);
    const indent = depth * 16;

    if (entry.type === 'dir') {
      const isExpanded = expandedDirs.includes(fullPath);
      const chevronClass = isExpanded ? 'is-expanded' : '';
      let children = '';
      if (isExpanded) {
        const childCache = treeCache.get(fullPath);
        if (childCache && !childCache.error && childCache.entries) {
          children = renderTreeEntries(fullPath, childCache.entries, depth + 1, session);
        } else if (childCache?.error) {
          children = `<div class="code-tree-row" style="padding-left:${(depth + 1) * 16}px"><span class="code-error" style="font-size:0.7rem">${esc(childCache.error)}</span></div>`;
        } else {
          children = `<div class="code-tree-row" style="padding-left:${(depth + 1) * 16}px"><span class="text-muted" style="font-size:0.7rem">Loading...</span></div>`;
        }
      }
      return `<button class="code-tree-row is-dir" type="button" data-code-tree-toggle="${escAttr(fullPath)}" style="padding-left:${indent}px">
        <span class="code-tree-chevron ${chevronClass}">&#x25B6;</span>
        <span class="code-tree-icon">&#128193;</span>
        <span class="code-tree-name">${esc(entry.name)}</span>
      </button>${children}`;
    }

    return `<button class="code-tree-row" type="button" data-code-tree-file="${escAttr(fullPath)}" style="padding-left:${indent}px">
      <span class="code-tree-icon">&#128196;</span>
      <span class="code-tree-name">${esc(entry.name)}</span>
    </button>`;
  }).join('');
}

async function loadTreeDir(session, dirPath) {
  const result = await api.codeFsList({
    sessionId: session?.id,
    path: dirPath,
  }).catch((err) => ({ success: false, error: err.message }));

  if (!result?.success) {
    return { entries: [], error: result?.message || result?.error || 'Failed to list directory.', resolvedPath: dirPath };
  }

  return {
    entries: Array.isArray(result.entries) ? result.entries : [],
    error: null,
    resolvedPath: result.path || dirPath,
  };
}

async function loadExpandedDirs(session) {
  const expandedDirs = session.expandedDirs || [];
  const missing = expandedDirs.filter((dir) => !treeCache.has(dir));
  if (missing.length === 0) return;
  const results = await Promise.all(missing.map((dir) => loadTreeDir(session, dir)));
  results.forEach((result, i) => treeCache.set(missing[i], result));
}

// ─── Directory Picker ──────────────────────────────────────

function renderDirPicker() {
  if (!codeState.dirPickerOpen) return '';
  const path = codeState.dirPickerPath || '/';
  const entries = codeState.dirPickerEntries || [];
  const error = codeState.dirPickerError || '';
  const loading = codeState.dirPickerLoading;

  return `
    <div class="code-dir-picker">
      <div class="code-dir-picker__path">${esc(path)}</div>
      ${error ? `<div class="code-error">${esc(error)}</div>` : ''}
      <div class="code-dir-picker__list">
        ${path !== '/' ? `<button class="code-dir-picker__entry" type="button" data-code-dirpick-navigate="${escAttr(parentPath(path))}">..</button>` : ''}
        ${loading ? '<div class="empty-inline">Loading...</div>' : entries.filter((e) => e.type === 'dir').map((e) => `
          <button class="code-dir-picker__entry" type="button" data-code-dirpick-navigate="${escAttr(joinWorkspacePath(path, e.name))}">${esc(e.name)}</button>
        `).join('') || '<div class="empty-inline">No subdirectories.</div>'}
      </div>
      <div class="code-dir-picker__actions">
        <button class="btn btn-primary btn-sm" type="button" data-code-dirpick-select>Select</button>
        <button class="btn btn-secondary btn-sm" type="button" data-code-dirpick-cancel>Cancel</button>
      </div>
    </div>
  `;
}

async function openDirPicker(startPath) {
  codeState.dirPickerOpen = true;
  codeState.dirPickerPath = startPath || '/';
  codeState.dirPickerEntries = [];
  codeState.dirPickerError = '';
  codeState.dirPickerLoading = true;
  saveState(codeState);
  rerenderFromState();
  await navigateDirPicker(codeState.dirPickerPath);
}

async function navigateDirPicker(dirPath) {
  codeState.dirPickerPath = dirPath;
  codeState.dirPickerLoading = true;
  codeState.dirPickerError = '';
  saveState(codeState);
  rerenderFromState();

  const result = await api.codeFsList({
    path: dirPath,
  }).catch((err) => ({ success: false, error: err.message }));

  if (!result?.success) {
    codeState.dirPickerError = result?.message || 'Failed to list directory.';
    codeState.dirPickerEntries = [];
  } else {
    codeState.dirPickerPath = result.path || dirPath;
    codeState.dirPickerEntries = Array.isArray(result.entries) ? result.entries : [];
    codeState.dirPickerError = '';
  }
  codeState.dirPickerLoading = false;
  saveState(codeState);
  rerenderFromState();
}

function closeDirPicker() {
  codeState.dirPickerOpen = false;
  codeState.dirPickerPath = '';
  codeState.dirPickerEntries = [];
  codeState.dirPickerError = '';
  codeState.dirPickerLoading = false;
  saveState(codeState);
  rerenderFromState();
}

// ─── Terminal rendering ────────────────────────────────────

function getVisibleTerminalPanes(session) {
  return session.terminalTabs || [];
}

function renderTerminalPane(session, tab) {
  const shellOptions = getShellOptions();
  const currentShell = normalizeTerminalShell(tab.shell);
  const selectedShell = getShellOption(currentShell);
  const cwd = session.resolvedRoot || session.workspaceRoot;
  const terminalError = typeof tab.openError === 'string' ? tab.openError.trim() : '';

  return `
    <div class="code-terminal-pane" data-pane-id="${escAttr(tab.id)}">
      <div class="code-terminal-pane__header">
        <span class="code-terminal-pane__name">${esc(tab.name)}</span>
        <span class="code-terminal-pane__badge">${tab.connected ? 'connected' : tab.connecting ? 'connecting' : tab.openFailed ? 'error' : 'disconnected'}</span>
        <select class="code-terminal-pane__shell" data-code-shell-select="${escAttr(tab.id)}">
          ${shellOptions.map((option) => `<option value="${escAttr(option.id)}"${option.id === currentShell ? ' selected' : ''}>${esc(option.label)}</option>`).join('')}
        </select>
        <button class="code-terminal-pane__close" type="button" data-code-close-terminal="${escAttr(tab.id)}" title="Close pane">&times;</button>
      </div>
      <div class="code-terminal__toolbar">
        <span class="code-terminal__meta">shell: ${esc(selectedShell?.detail || currentShell)}</span>
        <span class="code-terminal__meta">cwd: ${esc(cwd)}</span>
      </div>
      ${tab.openFailed && terminalError ? `<div class="code-terminal-pane__error">${esc(terminalError)}</div>` : ''}
      <div class="code-terminal__viewport" data-terminal-viewport="${escAttr(tab.id)}"></div>
    </div>
  `;
}

function renderAssistantTabs(session) {
  const approvalCount = Array.isArray(session?.pendingApprovals) ? session.pendingApprovals.length : 0;
  const taskCount = getTaskBadgeCount(session);
  const checkCount = getCheckBadgeCount(session);
  const activeTab = normalizeAssistantTabValue(session?.activeAssistantTab);
  const activityTotal = approvalCount + taskCount + checkCount;
  const viewedActivityTotal = (session?.viewedApprovalCount || 0) + (session?.viewedTaskCount || 0) + (session?.viewedCheckCount || 0);
  const unreadCounts = {
    chat: 0,
    activity: activeTab === 'activity' ? 0 : Math.max(0, activityTotal - viewedActivityTotal),
  };
  const providerOptions = getCodeProviderOptions(cachedAgents);

  return `
    <div class="code-assistant-tabs" role="tablist" aria-label="Coding assistant views">
      ${ASSISTANT_TABS.map((tabId) => {
        const label = tabId.charAt(0).toUpperCase() + tabId.slice(1);
        const isActive = activeTab === tabId;
        const count = unreadCounts[tabId] || 0;
        return `
          <button
            class="code-assistant-tab ${isActive ? 'is-active' : ''}"
            type="button"
            role="tab"
            aria-selected="${isActive ? 'true' : 'false'}"
            data-code-assistant-tab="${escAttr(tabId)}"
          >
            <span>${label}</span>
            ${count > 0 ? `<span class="code-assistant-tab__badge">${count}</span>` : ''}
          </button>
        `;
      }).join('')}
      <select class="code-chat__provider-select" data-code-provider-select title="LLM provider for this session">
        ${providerOptions.map((option) => `<option value="${escAttr(option.value)}"${(session?.agentId || '') === option.value ? ' selected' : ''}>${esc(option.label)}</option>`).join('')}
      </select>
    </div>
  `;
}

function renderChatNotice(session) {
  const backlog = getApprovalBacklogState(session);
  if (backlog.count === 0) return '';
  const copy = backlog.blocked
    ? `Too many approvals are waiting. New code changes are paused until you clear some of them.`
    : `${backlog.count} ${pluralize(backlog.count, 'approval')} ${backlog.count === 1 ? 'is' : 'are'} waiting for your decision.`;
  return `
    <div class="code-chat__notice ${backlog.blocked ? 'is-warning' : ''}">
      <span>${esc(copy)}</span>
      <button class="btn btn-secondary btn-sm" type="button" data-code-switch-tab="activity">Review approvals</button>
    </div>
  `;
}

function renderWorkspaceTrustNotice(session) {
  const workspaceTrust = session?.workspaceTrust || null;
  const effectiveTrustState = getEffectiveWorkspaceTrustState(session);
  const reviewActive = isWorkspaceTrustReviewActive(session);
  if (!workspaceTrust || (effectiveTrustState === 'trusted' && !reviewActive)) return '';
  const nativeDetection = hasWorkspaceTrustNativeDetection(workspaceTrust);
  const copy = nativeDetection
    ? 'Native host malware scanning reported a workspace detection. Guardian will require approval before repo execution or persistence actions continue.'
    : reviewActive
      ? `Manual trust acceptance is active for this session. Effective trust is TRUSTED and repo-scoped tools run normally. Raw scanner state remains ${String(workspaceTrust.state || '').toUpperCase()}. If the findings change, the acceptance clears automatically.`
      : workspaceTrust.state === 'blocked'
      ? 'Static repo review found high-risk indicators. Guardian will require approval before repo execution or persistence actions continue.'
      : 'Static repo review found suspicious indicators. Guardian will require approval before repo execution or persistence actions continue.';
  return `
    <div class="code-chat__notice ${reviewActive ? 'is-info' : 'is-warning'}">
      <span>${esc(copy)}</span>
    </div>
  `;
}

function formatCodeMessageRole(role) {
  switch (role) {
    case 'user':
      return 'You';
    case 'error':
      return 'System';
    case 'agent':
    default:
      return 'Coding Assistant';
  }
}

function renderCodeMessage(role, content, extraClass = '', approvals = null, responseSource = null) {
  const className = `code-message ${role === 'user' ? 'is-user' : role === 'error' ? 'is-error' : 'is-agent'}${extraClass ? ` ${extraClass}` : ''}`;
  const sourceBadge = responseSource?.locality
    ? `<span class="code-message__source" title="${escAttr(buildCodeResponseSourceTitle(responseSource))}">${esc(buildCodeResponseSourceLabel(responseSource))}</span>`
    : '';
  const approvalButtons = Array.isArray(approvals) && approvals.length > 0
    ? `<div class="code-message__approvals">
        ${approvals.map((a) => `
          <div class="code-message__approval">
            <span class="code-message__approval-tool">${esc(a.toolName)}</span>
            <span class="code-message__approval-args">${esc(a.argsPreview || '')}</span>
            <span class="code-message__approval-actions">
              <button class="btn btn-primary btn-sm" type="button" data-code-inline-approve="${escAttr(a.id)}">Approve</button>
              <button class="btn btn-secondary btn-sm" type="button" data-code-inline-deny="${escAttr(a.id)}">Deny</button>
            </span>
          </div>
        `).join('')}
      </div>`
    : '';
  return `
    <div class="${className}">
      <div class="code-message__role">${esc(formatCodeMessageRole(role))}${sourceBadge}</div>
      <div class="code-message__body">${esc(content)}</div>
      ${approvalButtons}
    </div>
  `;
}

function buildCodeResponseSourceLabel(responseSource) {
  if (!responseSource?.locality) return '';
  let label = responseSource.locality;
  if (responseSource.providerName) {
    label += ` · ${responseSource.providerName}`;
  }
  if (responseSource.usedFallback) {
    label += ' fallback';
  }
  return label;
}

function buildCodeResponseSourceTitle(responseSource) {
  if (!responseSource) return '';
  const parts = [];
  if (responseSource.notice) parts.push(String(responseSource.notice));
  if (responseSource.tier && responseSource.tier !== responseSource.locality) {
    parts.push(`Requested ${responseSource.tier} route.`);
  }
  return parts.join(' ');
}

function renderCodeThinkingMessage() {
  return `
    <div class="code-message is-agent is-thinking">
      <div class="code-message__role">Coding Assistant</div>
      <div class="code-message__thinking">
        <span class="chat-spinner" aria-hidden="true"></span>
        <span>Thinking through the workspace...</span>
      </div>
    </div>
  `;
}

function renderTaskList(session) {
  const items = deriveTaskItems(session);
  if (items.length === 0) {
    return '<div class="empty-state">No tracked coding work yet. Active plans, paused steps, and recent coding actions will appear here.</div>';
  }
  return `
    <div class="code-status-list">
      ${items.map((item) => `
        <article class="code-status-card status-${escAttr(item.status)}">
          <div class="code-status-card__top">
            <strong>${esc(item.title)}</strong>
            ${item.meta ? `<span class="code-status-card__meta">${esc(item.meta)}</span>` : ''}
          </div>
          <div class="code-status-card__detail">${esc(item.detail || '')}</div>
          ${renderWorkspaceTrustFindingsMarkup(item.workspaceTrust)}
        </article>
      `).join('')}
    </div>
  `;
}

function renderSessionRunTimeline(session) {
  const runs = normalizeTimelineRuns(session?.timelineRuns);
  if (runs.length === 0) {
    return '<div class="empty-state">Live run activity will appear here when this coding session dispatches work.</div>';
  }

  return `
    <div class="code-status-list">
      ${runs.map((run, index) => `
        <details class="code-status-card status-${escAttr(mapTimelineRunTone(run.summary.status))}"${index === 0 ? ' open' : ''}>
          <summary class="code-status-card__top">
            <strong>${esc(run.summary.title)}</strong>
            <span class="code-status-card__meta">${esc(formatTimelineRunMeta(run.summary))}</span>
          </summary>
          ${run.summary.subtitle ? `<div class="code-status-card__detail">${esc(run.summary.subtitle)}</div>` : ''}
          <div class="code-status-list" style="margin-top:0.75rem">
            ${run.items.slice(-6).map((item) => `
              <article class="code-status-card status-${escAttr(mapTimelineItemTone(item.status))}">
                <div class="code-status-card__top">
                  <strong>${esc(item.title)}</strong>
                  <span class="code-status-card__meta">${esc(formatRelativeTime(item.timestamp))}</span>
                </div>
                ${item.detail ? `<div class="code-status-card__detail">${esc(item.detail)}</div>` : ''}
              </article>
            `).join('')}
          </div>
        </details>
      `).join('')}
    </div>
  `;
}

function renderCodeLiveProgress(session) {
  const pendingStartedAt = Number(session?.pendingResponse?.startedAt) || 0;
  if (!pendingStartedAt) return '';

  const run = findPendingTimelineRun(session, pendingStartedAt);
  if (!run) {
    return `
      <div class="code-chat__progress">
        <article class="code-status-card status-active">
          <div class="code-status-card__top">
            <strong>Starting request</strong>
            <span class="code-status-card__meta">just now</span>
          </div>
          <div class="code-status-card__detail">Guardian is preparing this coding turn.</div>
        </article>
      </div>
    `;
  }

  const summary = summarizeCodeLiveRun(run);
  return `
    <div class="code-chat__progress">
      <article class="code-status-card status-${escAttr(mapTimelineRunTone(run.summary.status))}">
        <div class="code-status-card__top">
          <strong>${esc(summary.title)}</strong>
          <span class="code-status-card__meta">${esc(formatTimelineRunMeta(run.summary))}</span>
        </div>
        ${summary.detail ? `<div class="code-status-card__detail">${esc(summary.detail)}</div>` : ''}
        ${summary.items.length > 0
          ? `<div class="code-chat__progress-items">
              ${summary.items.map((item) => `
                <div class="code-chat__progress-item">
                  <div class="code-chat__progress-title">${esc(item.title)}</div>
                  ${item.detail ? `<div class="code-chat__progress-detail">${esc(item.detail)}</div>` : ''}
                </div>
              `).join('')}
            </div>`
          : ''}
      </article>
    </div>
  `;
}

function summarizeCodeLiveRun(run) {
  const items = Array.isArray(run?.items)
    ? run.items
      .filter(isMeaningfulCodeLiveItem)
      .slice(-2)
      .map((item) => ({
        title: String(item?.title || '').trim(),
        detail: String(item?.detail || '').trim(),
      }))
      .filter((item) => item.title)
    : [];
  const latestItem = items[items.length - 1] || null;
  return {
    title: latestItem?.title || humanizeCodeLiveStatus(run?.summary?.status),
    detail: latestItem?.detail || '',
    items,
  };
}

function isMeaningfulCodeLiveItem(item) {
  const type = String(item?.type || '').trim();
  return type !== 'run_queued'
    && type !== 'run_started'
    && type !== 'run_completed';
}

function humanizeCodeLiveStatus(status) {
  switch (String(status || '')) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Working…';
    case 'awaiting_approval':
      return 'Waiting for approval';
    case 'verification_pending':
      return 'Verification pending';
    case 'blocked':
      return 'Blocked';
    case 'failed':
      return 'Failed';
    case 'completed':
      return 'Done';
    default:
      return 'Working…';
  }
}

function findPendingTimelineRun(session, pendingStartedAt) {
  const activeStatuses = new Set(['queued', 'running', 'awaiting_approval', 'verification_pending', 'blocked']);
  const runs = normalizeTimelineRuns(session?.timelineRuns);
  const threshold = Math.max(0, pendingStartedAt - 5_000);
  return runs.find((run) => {
    const startedAt = Number(run?.summary?.startedAt) || Number(run?.summary?.lastUpdatedAt) || 0;
    return activeStatuses.has(run.summary.status) && startedAt >= threshold;
  }) || null;
}

function mapTimelineRunTone(status) {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'blocked';
  if (status === 'blocked' || status === 'awaiting_approval' || status === 'verification_pending') return 'warn';
  if (status === 'running') return 'active';
  return 'active';
}

function mapTimelineItemTone(status) {
  if (status === 'succeeded') return 'completed';
  if (status === 'failed') return 'blocked';
  if (status === 'blocked' || status === 'warning') return 'warn';
  if (status === 'running') return 'active';
  return 'active';
}

function formatTimelineRunMeta(summary) {
  const parts = [];
  if (summary.status) parts.push(summary.status.replace(/_/g, ' '));
  if (summary.kind) parts.push(summary.kind.replace(/_/g, ' '));
  const time = formatRelativeTime(summary.lastUpdatedAt || summary.startedAt);
  if (time) parts.push(time);
  if (summary.pendingApprovalCount > 0) {
    parts.push(`${summary.pendingApprovalCount} approval${summary.pendingApprovalCount === 1 ? '' : 's'}`);
  } else if (summary.durationMs > 0) {
    parts.push(`${summary.durationMs}ms`);
  }
  return parts.join(' • ');
}

function renderApprovalList(session) {
  const approvals = Array.isArray(session?.pendingApprovals) ? session.pendingApprovals : [];
  const backlog = getApprovalBacklogState(session);
  const warning = backlog.blocked
    ? `<div class="code-tab-banner is-warning">New write actions are paused until some approvals are cleared.</div>`
    : '';
  if (approvals.length === 0) {
    return `${warning}<div class="empty-state">No approvals are waiting for this coding session.</div>`;
  }
  return `
    ${warning}
    <div class="code-status-list">
      ${approvals.map((approval) => `
        <article class="approval-card">
          <div class="approval-card__header">
            <div>
              <div class="approval-card__title">${esc(humanizeToolName(approval.toolName))}</div>
              <div class="approval-card__meta">
                ${approval.createdAt ? esc(formatRelativeTime(approval.createdAt)) : ''}
                ${approval.risk ? ` • ${esc(approval.risk)}` : ''}
                ${approval.origin ? ` • ${esc(approval.origin)}` : ''}
              </div>
            </div>
          </div>
          <div class="approval-card__preview">${esc(approval.argsPreview || 'No preview available.')}</div>
          <div class="approval-card__actions">
            <button class="btn btn-secondary btn-sm" type="button" data-code-approval-id="${escAttr(approval.id)}" data-code-approval-decision="approved">Approve</button>
            <button class="btn btn-secondary btn-sm" type="button" data-code-approval-id="${escAttr(approval.id)}" data-code-approval-decision="denied">Deny</button>
          </div>
        </article>
      `).join('')}
    </div>
  `;
}

function renderCheckList(session) {
  const items = deriveCheckItems(session);
  if (items.length === 0) {
    return '<div class="empty-state">Verification results will appear here when coding checks or tool verification runs complete.</div>';
  }
  return `
    <div class="code-status-list">
      ${items.map((item) => `
        <article class="code-status-card status-${escAttr(item.status)}">
          <div class="code-status-card__top">
            <strong>${esc(item.title)}</strong>
            ${item.meta ? `<span class="code-status-card__meta">${esc(item.meta)}</span>` : ''}
          </div>
          <div class="code-status-card__detail">${esc(item.detail || '')}</div>
        </article>
      `).join('')}
    </div>
  `;
}

function summarizeStructureSymbolMeta(symbol) {
  const parts = [symbol.kind];
  if (symbol.exported) parts.push('exported');
  if (symbol.async) parts.push('async');
  parts.push(`lines ${symbol.range.startLine}-${symbol.range.endLine}`);
  return parts.join(' • ');
}

function renderStructureCountPill(label, values) {
  if (!Array.isArray(values) || values.length === 0) return '';
  return `<span class="code-structure-pill">${esc(label)} ${values.length}</span>`;
}

function resolveStructureRelationSymbols(structureView, qualifiedNames, { excludeIds = [] } = {}) {
  const symbols = Array.isArray(structureView?.symbols) ? structureView.symbols : [];
  const byQualifiedName = new Map(symbols.map((symbol) => [symbol.qualifiedName, symbol]));
  const excluded = new Set(Array.isArray(excludeIds) ? excludeIds : []);
  const seen = new Set();
  const matches = [];

  for (const value of Array.isArray(qualifiedNames) ? qualifiedNames : []) {
    const qualifiedName = String(value || '').trim();
    if (!qualifiedName) continue;
    const symbol = byQualifiedName.get(qualifiedName)
      || symbols.find((entry) => entry.name === qualifiedName || entry.qualifiedName.endsWith(`.${qualifiedName}`))
      || null;
    if (!symbol || excluded.has(symbol.id) || seen.has(symbol.id)) continue;
    seen.add(symbol.id);
    matches.push(symbol);
  }

  return matches;
}

function getVisualToneForSymbol(symbol) {
  if (!symbol) return 'neutral';
  if (Array.isArray(symbol.securityNotes) && symbol.securityNotes.length > 0) return 'risk';
  if (
    (Array.isArray(symbol.trustBoundaryTags) && symbol.trustBoundaryTags.length > 0)
    || (Array.isArray(symbol.sideEffects) && symbol.sideEffects.length > 0)
  ) {
    return 'signal';
  }
  if (((symbol.callers?.length || 0) + (symbol.callees?.length || 0)) > 0) return 'linked';
  return 'neutral';
}

function renderVisualMetricPill(label, count, tone = '') {
  if (!Number.isFinite(count) || count <= 0) return '';
  const toneClass = tone ? ` tone-${escAttr(tone)}` : '';
  return `<span class="code-visual-pill${toneClass}">${esc(`${label} ${count}`)}</span>`;
}

function renderVisualSymbolButton(symbol, { selectedId = '', emphasis = 'normal', reveal = false } = {}) {
  if (!symbol) return '';
  const tone = getVisualToneForSymbol(symbol);
  const relationCount = (symbol.callers?.length || 0) + (symbol.callees?.length || 0);
  const concernCount = (symbol.qualityNotes?.length || 0) + (symbol.securityNotes?.length || 0);
  const isSelected = selectedId === symbol.id;
  const classes = [
    'code-visual-node',
    isSelected ? 'is-selected' : '',
    emphasis === 'focus' ? 'is-focus' : '',
    emphasis === 'compact' ? 'is-compact' : '',
    `tone-${tone}`,
  ].filter(Boolean).join(' ');
  const stats = [];
  if (relationCount > 0) stats.push(`${relationCount} ${relationCount === 1 ? 'relation' : 'relations'}`);
  if (concernCount > 0) stats.push(`${concernCount} ${concernCount === 1 ? 'concern' : 'concerns'}`);

  return `
    <button
      class="${classes}"
      type="button"
      data-code-visual-symbol="${escAttr(symbol.id)}"
      data-code-visual-reveal="${reveal ? 'true' : 'false'}"
    >
      <span class="code-visual-node__meta">${esc(symbol.kind)}${symbol.exported ? ' • exported' : ''}${symbol.async ? ' • async' : ''}</span>
      <span class="code-visual-node__name">${esc(symbol.name)}</span>
      <span class="code-visual-node__summary">${esc(symbol.summary || 'No deterministic summary yet.')}</span>
      ${stats.length > 0 ? `<span class="code-visual-node__stats">${esc(stats.join(' • '))}</span>` : ''}
    </button>
  `;
}

function renderVisualSymbolStack(title, symbols, emptyCopy, selectedId) {
  return `
    <div class="code-visual-stack">
      <div class="code-visual-stack__title">${esc(title)}</div>
      ${symbols.length > 0
        ? symbols.map((symbol) => renderVisualSymbolButton(symbol, { selectedId, emphasis: 'compact', reveal: true })).join('')
        : `<div class="code-visual-empty">${esc(emptyCopy)}</div>`}
    </div>
  `;
}

function renderVisualStrip(title, symbols, selectedId, emptyCopy = '') {
  if ((!Array.isArray(symbols) || symbols.length === 0) && !emptyCopy) return '';
  return `
    <section class="code-visual-section">
      <div class="code-visual-section__title">${esc(title)}</div>
      ${Array.isArray(symbols) && symbols.length > 0
        ? `<div class="code-visual-strip">${symbols.map((symbol) => renderVisualSymbolButton(symbol, { selectedId, reveal: true })).join('')}</div>`
        : `<div class="code-visual-empty">${esc(emptyCopy)}</div>`}
    </section>
  `;
}

function renderVisualFocusCard(symbol) {
  if (!symbol) return '';
  const tone = getVisualToneForSymbol(symbol);
  const relationCount = (symbol.callers?.length || 0) + (symbol.callees?.length || 0);
  const concernCount = (symbol.qualityNotes?.length || 0) + (symbol.securityNotes?.length || 0);

  return `
    <article class="code-visual-focus tone-${escAttr(tone)}">
      <div class="code-visual-focus__header">
        <div>
          <div class="code-visual-focus__eyebrow">${esc(summarizeStructureSymbolMeta(symbol))}</div>
          <h4>${esc(symbol.name)}</h4>
        </div>
        <button class="btn btn-secondary btn-sm" type="button" data-code-visual-symbol="${escAttr(symbol.id)}" data-code-visual-reveal="true">Reveal</button>
      </div>
      ${symbol.signature ? `<div class="code-visual-focus__signature">${esc(symbol.signature)}</div>` : ''}
      <div class="code-visual-focus__summary">${esc(symbol.summary || 'No deterministic summary yet.')}</div>
      <div class="code-visual-focus__pills">
        ${renderVisualMetricPill('Relations', relationCount, 'linked')}
        ${renderVisualMetricPill('Side effects', symbol.sideEffects?.length || 0, 'signal')}
        ${renderVisualMetricPill('Boundaries', symbol.trustBoundaryTags?.length || 0, 'signal')}
        ${renderVisualMetricPill('Concerns', concernCount, 'risk')}
      </div>
    </article>
  `;
}

function renderStructureScopeNavigator(session) {
  const structureView = session?.structureView;
  if (!isSectionedStructureView(structureView)) return '';
  const currentSection = getCurrentStructureSection(structureView);
  return `
    <section class="code-investigation-scope">
      <div class="code-investigation-scope__header">
        <div>
          <div class="code-investigation-scope__eyebrow">Sectioned Inspection</div>
          <div class="code-investigation-scope__title">This file is large, so inspection is scoped to one section at a time.</div>
          <div class="code-investigation-scope__copy">
            Current scope: ${esc(currentSection?.title || 'Section')} (${esc(currentSection ? formatStructureLineRange(currentSection.range) : '')})
            • ${esc(`${formatByteSize(structureView.fileBytes)} across ${structureView.totalLines || 0} lines`)}
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" type="button" data-code-structure-sync-cursor>Use Cursor Section</button>
      </div>
      <div class="code-investigation-scope__sections">
        ${structureView.sections.map((section) => `
          <button
            class="code-investigation-section ${section.id === structureView.selectedSectionId ? 'is-selected' : ''}"
            type="button"
            data-code-structure-section="${escAttr(section.id)}"
          >
            <span class="code-investigation-section__title">${esc(section.title)}</span>
            <span class="code-investigation-section__meta">${esc(`${formatStructureLineRange(section.range)} • ${section.lineCount} lines`)}</span>
            <span class="code-investigation-section__summary">${esc(section.summary || '')}</span>
          </button>
        `).join('')}
      </div>
    </section>
  `;
}

function renderInvestigationHotspot(hotspot) {
  if (!hotspot?.symbol) return '';
  return `
    <article class="code-hotspot-card severity-${escAttr(hotspot.severity)}">
      <div class="code-hotspot-card__header">
        <div>
          <div class="code-hotspot-card__eyebrow">${esc(summarizeStructureSymbolMeta(hotspot.symbol))}</div>
          <h4>${esc(hotspot.symbol.name)}</h4>
        </div>
        <span class="code-hotspot-card__badge severity-${escAttr(hotspot.severity)}">${esc(hotspot.severity === 'high' ? 'High' : hotspot.severity === 'warn' ? 'Review' : 'Note')}</span>
      </div>
      <div class="code-hotspot-card__title">${esc(hotspot.title)}</div>
      <div class="code-hotspot-card__copy">${esc(hotspot.narrative)}</div>
      <div class="code-hotspot-card__actions">
        <button class="btn btn-secondary btn-sm" type="button" data-code-structure-symbol="${escAttr(hotspot.symbol.id)}" data-code-structure-reveal="true">Reveal</button>
        <button class="btn btn-secondary btn-sm" type="button" data-code-visual-symbol="${escAttr(hotspot.symbol.id)}" data-code-visual-reveal="false">Show Flow</button>
      </div>
    </article>
  `;
}

function renderInvestigatePanel(session) {
  const structureView = session?.structureView;
  if (!session?.selectedFilePath) {
    return '<div class="empty-state">Open a TypeScript or JavaScript file to investigate what the code does, what it talks to, and which hotspots deserve attention first.</div>';
  }
  if (structureView && !isStructureViewCurrentFile(session)) {
    return '<div class="empty-state">Loading investigation for the active file...</div>';
  }
  if (!structureView) {
    return '<div class="empty-state">Investigation guidance will appear here for the active file.</div>';
  }
  if (structureView.error) {
    return `<div class="empty-state">${esc(structureView.error)}</div>`;
  }
  if (!structureView.supported) {
    return `
      ${renderStructureScopeNavigator(session)}
      <div class="empty-state">${esc(structureView.summary || 'Investigation is not available for this file.')}</div>
    `;
  }

  const focusSymbol = pickInvestigationFocusSymbol(structureView);
  const hotspots = buildInvestigationHotspots(structureView);
  const surfaceSummary = buildInvestigationSurfaceSummary(structureView);
  const currentSection = getCurrentStructureSection(structureView);
  const nextSteps = buildInvestigationNextSteps(structureView, focusSymbol, hotspots);

  return `
    ${renderStructureScopeNavigator(session)}
    <article class="code-investigation-hero">
      <div class="code-investigation-hero__eyebrow">What This Code Does</div>
      <h4>${esc(focusSymbol?.name || (structureView.path || session.selectedFilePath))}</h4>
      <div class="code-investigation-hero__copy">${esc(buildInvestigationBehaviorCopy(structureView, focusSymbol))}</div>
      <div class="code-investigation-hero__pills">
        <span class="code-visual-pill tone-linked">${esc(`${structureView.symbols.length} symbols in scope`)}</span>
        ${currentSection ? `<span class="code-visual-pill tone-signal">${esc(formatStructureLineRange(currentSection.range))}</span>` : ''}
        ${focusSymbol?.exported ? '<span class="code-visual-pill tone-linked">exported focus</span>' : ''}
        ${focusSymbol?.sideEffects?.length ? `<span class="code-visual-pill tone-risk">${esc(`${focusSymbol.sideEffects.length} side effects`)}</span>` : ''}
      </div>
    </article>
    <div class="code-investigation-grid">
      <article class="code-investigation-card tone-linked">
        <div class="code-investigation-card__title">What It Talks To</div>
        <div class="code-investigation-card__copy">${esc(surfaceSummary.headline)}</div>
        ${surfaceSummary.items.length > 0 ? `<ul class="code-investigation-card__list">${surfaceSummary.items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
      </article>
      <article class="code-investigation-card tone-risk">
        <div class="code-investigation-card__title">Potential Risks</div>
        <div class="code-investigation-card__copy">${esc(buildInvestigationRiskSummary(structureView))}</div>
      </article>
      <article class="code-investigation-card tone-signal">
        <div class="code-investigation-card__title">Quality Issues</div>
        <div class="code-investigation-card__copy">${esc(buildInvestigationQualitySummary(structureView))}</div>
      </article>
      <article class="code-investigation-card tone-neutral">
        <div class="code-investigation-card__title">Where To Look Next</div>
        <ul class="code-investigation-card__list">
          ${nextSteps.map((step) => `<li>${esc(step)}</li>`).join('')}
        </ul>
      </article>
    </div>
    <section class="code-investigation-section-block">
      <div class="code-investigation-section-block__title">Hotspots To Investigate First</div>
      <div class="code-hotspot-grid">
        ${hotspots.length > 0
          ? hotspots.map((hotspot) => renderInvestigationHotspot(hotspot)).join('')
          : '<div class="code-visual-empty">No deterministic hotspots were surfaced in this scope.</div>'}
      </div>
    </section>
    ${focusSymbol ? `
      <article class="code-structure-focus">
        <div class="code-structure-focus__header">
          <div>
            <div class="code-structure-focus__eyebrow">Focused symbol</div>
            <h4>${esc(focusSymbol.name)}</h4>
          </div>
          <button class="btn btn-secondary btn-sm" type="button" data-code-structure-symbol="${escAttr(focusSymbol.id)}" data-code-structure-reveal="true">Reveal</button>
        </div>
        ${focusSymbol.signature ? `<div class="code-structure-focus__signature">${esc(focusSymbol.signature)}</div>` : ''}
        <div class="code-structure-focus__summary">${esc(focusSymbol.summary || '')}</div>
        ${focusSymbol.excerpt ? `<pre class="code-structure-focus__excerpt">${esc(focusSymbol.excerpt)}</pre>` : ''}
      </article>
    ` : ''}
  `;
}

function renderVisualPanel(session) {
  const structureView = session?.structureView;
  if (!session?.selectedFilePath) {
    return '<div class="empty-state">Open a TypeScript or JavaScript file, then use Inspect to open the code inspector and switch to Flow.</div>';
  }
  if (structureView && !isStructureViewCurrentFile(session)) {
    return '<div class="empty-state">Loading flow analysis for the active file...</div>';
  }
  if (!structureView) {
    return '<div class="empty-state">Flow diagrams will appear here for the active file.</div>';
  }
  if (structureView.error) {
    return `<div class="empty-state">${esc(structureView.error)}</div>`;
  }
  if (!structureView.supported) {
    return `
      ${renderStructureScopeNavigator(session)}
      <div class="empty-state">${esc(structureView.summary || 'Flow explanations are not available for this file.')}</div>
    `;
  }
  if (!Array.isArray(structureView.symbols) || structureView.symbols.length === 0) {
    return `<div class="empty-state">${esc(structureView.summary || 'No extractable symbols were found in this file yet.')}</div>`;
  }

  const selectedSymbol = getSelectedStructureSymbol(session);
  if (!selectedSymbol) {
    return '<div class="empty-state">Select a symbol to generate a visual explanation.</div>';
  }

  const previewBanner = getStructurePreviewBanner(session);
  const callers = resolveStructureRelationSymbols(structureView, selectedSymbol.callers, { excludeIds: [selectedSymbol.id] })
    .slice(0, MAX_VISUAL_SYMBOLS_PER_SECTION);
  const callees = resolveStructureRelationSymbols(structureView, selectedSymbol.callees, { excludeIds: [selectedSymbol.id] })
    .slice(0, MAX_VISUAL_SYMBOLS_PER_SECTION);
  const childSymbols = structureView.symbols
    .filter((symbol) => symbol.parentId === selectedSymbol.id)
    .slice(0, MAX_VISUAL_SYMBOLS_PER_SECTION);
  const peerSymbols = structureView.symbols
    .filter((symbol) => symbol.id !== selectedSymbol.id && symbol.parentId === selectedSymbol.parentId)
    .slice(0, MAX_VISUAL_SYMBOLS_PER_SECTION);
  const topLevelSymbols = structureView.symbols
    .filter((symbol) => !symbol.parentId)
    .slice(0, MAX_VISUAL_SYMBOLS_PER_SECTION + 1);
  const relatedTopLevelSymbols = peerSymbols.filter((symbol) => !symbol.parentId);
  const flowNextSteps = buildFlowNextSteps(selectedSymbol);

  return `
    ${renderStructureScopeNavigator(session)}
    ${previewBanner}
    <article class="code-investigation-hero">
      <div class="code-investigation-hero__eyebrow">How This Code Flows</div>
      <h4>${esc(selectedSymbol.name)}</h4>
      <div class="code-investigation-hero__copy">${esc(buildFlowNarrative(selectedSymbol))}</div>
      <div class="code-investigation-hero__pills">
        <span class="code-visual-pill tone-linked">${esc(`${callers.length} upstream caller${callers.length === 1 ? '' : 's'}`)}</span>
        <span class="code-visual-pill tone-linked">${esc(`${callees.length} downstream callee${callees.length === 1 ? '' : 's'}`)}</span>
        ${selectedSymbol.sideEffects.length > 0 ? `<span class="code-visual-pill tone-risk">${esc(`${selectedSymbol.sideEffects.length} side effects`)}</span>` : ''}
      </div>
    </article>
    <div class="code-investigation-grid">
      <article class="code-investigation-card tone-linked">
        <div class="code-investigation-card__title">Local Flow Story</div>
        <div class="code-investigation-card__copy">${esc(`${selectedSymbol.name} sits between its local callers and callees inside the current file or section. Use the graph below to trace control in order instead of reading the whole file top to bottom.`)}</div>
      </article>
      <article class="code-investigation-card tone-risk">
        <div class="code-investigation-card__title">Potential Issues</div>
        <div class="code-investigation-card__copy">${esc(buildFlowRiskCopy(selectedSymbol))}</div>
      </article>
      <article class="code-investigation-card tone-neutral">
        <div class="code-investigation-card__title">Trace Next</div>
        <ul class="code-investigation-card__list">
          ${flowNextSteps.map((step) => `<li>${esc(step)}</li>`).join('')}
        </ul>
      </article>
    </div>
    <article class="code-status-card status-info">
      <div class="code-status-card__top">
        <strong>${esc(structureView.path || session.selectedFilePath)}</strong>
        <span class="code-status-card__meta">${esc(`${structureView.language || 'Code'} • symbol flow`)}</span>
      </div>
      <div class="code-status-card__detail">${esc(`${selectedSymbol.name} is the current flow focus. Use this view to trace who reaches it, what it invokes next, and which nearby symbols share the same local scope.`)}</div>
    </article>
    <div class="code-visual-stage">
      ${renderVisualSymbolStack('Upstream Callers', callers, 'No local callers detected for this symbol.', selectedSymbol.id)}
      <div class="code-visual-bridge"><span>${callers.length > 1 ? 'converge on' : 'calls into'}</span></div>
      ${renderVisualFocusCard(selectedSymbol)}
      <div class="code-visual-bridge"><span>${callees.length > 1 ? 'fans out to' : 'invokes'}</span></div>
      ${renderVisualSymbolStack('Downstream Calls', callees, 'No local callees detected for this symbol.', selectedSymbol.id)}
    </div>
    ${renderVisualStrip('Contained symbols', childSymbols, selectedSymbol.id)}
    ${renderVisualStrip(
      selectedSymbol.parentId ? 'Same-scope siblings' : 'Related top-level symbols',
      selectedSymbol.parentId ? peerSymbols : relatedTopLevelSymbols,
      selectedSymbol.id,
      selectedSymbol.parentId ? 'No sibling symbols detected in this scope.' : 'No other top-level symbols detected in this file.'
    )}
    ${renderVisualStrip('Section map', topLevelSymbols, selectedSymbol.id)}
  `;
}

function normalizeRepoRelativePath(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
}

function resolveRepoRelativePath(value) {
  const segments = [];
  for (const segment of normalizeRepoRelativePath(value).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

function dirnameRepoPath(value) {
  const normalized = resolveRepoRelativePath(value);
  if (!normalized || !normalized.includes('/')) return '.';
  return normalized.slice(0, normalized.lastIndexOf('/')) || '.';
}

function resolveRepoImportTarget(fromPath, importSource, byPath) {
  const source = String(importSource || '').trim();
  if (!source.startsWith('.')) return null;
  const fromDir = dirnameRepoPath(fromPath);
  const baseTarget = resolveRepoRelativePath(`${fromDir === '.' ? '' : `${fromDir}/`}${source}`);
  const candidates = [
    baseTarget,
    ...REPO_IMPORT_RESOLVE_EXTENSIONS.map((ext) => `${baseTarget}${ext}`),
    ...REPO_IMPORT_RESOLVE_EXTENSIONS.map((ext) => `${baseTarget}/index${ext}`),
  ];
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeRepoRelativePath(candidate);
    const match = byPath.get(normalizedCandidate);
    if (match) return match;
  }
  return null;
}

function buildWorkspaceMapFileIndex(session) {
  const entries = Array.isArray(session?.workspaceMap?.files)
    ? session.workspaceMap.files
      .map((entry) => {
        const relativePath = normalizeRepoRelativePath(entry?.path);
        if (!relativePath) return null;
        return {
          ...entry,
          path: relativePath,
        };
      })
      .filter(Boolean)
    : [];
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return { entries, byPath };
}

function createRepoFileEntry(pathValue, extra = {}) {
  return {
    path: normalizeRepoRelativePath(pathValue),
    category: '',
    extension: '',
    size: 0,
    summary: '',
    symbols: [],
    imports: [],
    keywords: [],
    ...extra,
  };
}

function hydrateRepoFileEntry(pathValue, byPath, fallback = {}) {
  const normalizedPath = normalizeRepoRelativePath(pathValue);
  if (!normalizedPath) return null;
  return byPath.get(normalizedPath) || createRepoFileEntry(normalizedPath, fallback);
}

function dedupeRepoFiles(entries, { excludePaths = [] } = {}) {
  const excluded = new Set((excludePaths || []).map((value) => normalizeRepoRelativePath(value)).filter(Boolean));
  const seen = new Set();
  const results = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalizedPath = normalizeRepoRelativePath(entry?.path);
    if (!normalizedPath || excluded.has(normalizedPath) || seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    results.push({
      ...entry,
      path: normalizedPath,
    });
  }
  return results;
}

function resolveWorkspaceFilePath(session, relativePath) {
  const rootPath = session?.resolvedRoot || session?.workspaceRoot || '.';
  if (!rootPath || !relativePath) return '';
  const normalizedRelativePath = normalizeRepoRelativePath(relativePath);
  const separator = rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/';
  return `${rootPath.replace(/[\\/]+$/, '')}${separator}${normalizedRelativePath.replace(/\//g, separator)}`;
}

function renderRepoFileButton(entry, { currentPath = '', emphasis = 'normal' } = {}) {
  const relativePath = normalizeRepoRelativePath(entry?.path);
  if (!relativePath) return '';
  const stats = [];
  if (Array.isArray(entry?.imports) && entry.imports.length > 0) {
    stats.push(`${entry.imports.length} ${entry.imports.length === 1 ? 'import' : 'imports'}`);
  }
  if (Array.isArray(entry?.symbols) && entry.symbols.length > 0) {
    stats.push(`${entry.symbols.length} ${entry.symbols.length === 1 ? 'symbol' : 'symbols'}`);
  }
  if (Array.isArray(entry?.keywords) && entry.keywords.length > 0) {
    stats.push(`${entry.keywords.length} keywords`);
  }
  const classes = [
    'code-visual-node',
    'code-repo-node',
    emphasis === 'compact' ? 'is-compact' : '',
    relativePath === currentPath ? 'is-selected' : '',
  ].filter(Boolean).join(' ');
  const metaParts = [entry?.category || 'file'];
  if (entry?.extension) metaParts.push(entry.extension);

  return `
    <button class="${classes}" type="button" data-code-repo-file="${escAttr(relativePath)}">
      <span class="code-visual-node__meta">${esc(metaParts.join(' • '))}</span>
      <span class="code-visual-node__name">${esc(basename(relativePath))}</span>
      <span class="code-repo-node__path">${esc(relativePath)}</span>
      <span class="code-visual-node__summary">${esc(entry?.summary || 'No indexed summary yet for this file.')}</span>
      ${stats.length > 0 ? `<span class="code-visual-node__stats">${esc(stats.join(' • '))}</span>` : ''}
    </button>
  `;
}

function renderRepoFileStack(title, entries, emptyCopy, currentPath) {
  return `
    <div class="code-visual-stack">
      <div class="code-visual-stack__title">${esc(title)}</div>
      ${entries.length > 0
        ? entries.map((entry) => renderRepoFileButton(entry, { currentPath, emphasis: 'compact' })).join('')
        : `<div class="code-visual-empty">${esc(emptyCopy)}</div>`}
    </div>
  `;
}

function renderRepoFileStrip(title, entries, currentPath, emptyCopy = '') {
  if ((!Array.isArray(entries) || entries.length === 0) && !emptyCopy) return '';
  return `
    <section class="code-visual-section">
      <div class="code-visual-section__title">${esc(title)}</div>
      ${Array.isArray(entries) && entries.length > 0
        ? `<div class="code-visual-strip">${entries.map((entry) => renderRepoFileButton(entry, { currentPath })).join('')}</div>`
        : `<div class="code-visual-empty">${esc(emptyCopy)}</div>`}
    </section>
  `;
}

function renderRepoFocusCard(entry, metrics = {}) {
  if (!entry?.path) return '';
  return `
    <article class="code-visual-focus code-repo-focus tone-linked">
      <div class="code-visual-focus__header">
        <div>
          <div class="code-visual-focus__eyebrow">${esc(`${entry.category || 'file'}${entry.extension ? ` • ${entry.extension}` : ''}`)}</div>
          <h4>${esc(basename(entry.path))}</h4>
        </div>
        <button class="btn btn-secondary btn-sm" type="button" data-code-repo-file="${escAttr(entry.path)}">Open</button>
      </div>
      <div class="code-repo-focus__path">${esc(entry.path)}</div>
      <div class="code-visual-focus__summary">${esc(entry.summary || 'No indexed summary yet for this file.')}</div>
      <div class="code-visual-focus__pills">
        ${renderVisualMetricPill('Imported by', metrics.importedByCount || 0, 'linked')}
        ${renderVisualMetricPill('Imports', metrics.importsCount || 0, 'linked')}
        ${renderVisualMetricPill('Peers', metrics.peerCount || 0, 'signal')}
        ${renderVisualMetricPill('Symbols', entry.symbols?.length || 0, 'signal')}
      </div>
    </article>
  `;
}

function renderRepoVisualPanel(session) {
  const { entries, byPath } = buildWorkspaceMapFileIndex(session);
  if (entries.length === 0) {
    return '<div class="empty-state">Repo visuals need the indexed workspace map. Reopen the session or wait for indexing to finish.</div>';
  }

  const workspaceMap = session?.workspaceMap || null;
  const selectedRelativePath = normalizeRepoRelativePath(toRelativePath(session?.selectedFilePath || '', session?.resolvedRoot || session?.workspaceRoot || ''));
  const currentEntry = hydrateRepoFileEntry(selectedRelativePath, byPath);
  const currentPath = currentEntry?.path || '';

  const importedByFiles = currentEntry
    ? dedupeRepoFiles(entries.filter((entry) => (
      entry.path !== currentPath
      && Array.isArray(entry.imports)
      && entry.imports.some((source) => resolveRepoImportTarget(entry.path, source, byPath)?.path === currentPath)
    )))
    : [];
  const importedFiles = currentEntry
    ? dedupeRepoFiles((currentEntry.imports || []).map((source) => resolveRepoImportTarget(currentEntry.path, source, byPath)).filter(Boolean))
    : [];
  const peerFiles = currentEntry
    ? dedupeRepoFiles(entries.filter((entry) => entry.path !== currentPath && dirnameRepoPath(entry.path) === dirnameRepoPath(currentPath)))
    : [];
  const workingSetFiles = dedupeRepoFiles(
    (session?.workingSet?.files || []).map((entry) => hydrateRepoFileEntry(entry?.path, byPath, {
      category: entry?.category ? String(entry.category) : '',
      summary: entry?.reason ? String(entry.reason) : (entry?.summary ? String(entry.summary) : ''),
    })).filter(Boolean),
    { excludePaths: [currentPath] },
  );
  const notableFiles = dedupeRepoFiles(
    (workspaceMap?.notableFiles || []).map((pathValue) => hydrateRepoFileEntry(pathValue, byPath)).filter(Boolean),
    { excludePaths: [currentPath] },
  );
  const indexedSummary = `${workspaceMap?.indexedFileCount || entries.length} indexed files across ${workspaceMap?.directories?.length || 0} directories`;
  const impactNextSteps = buildImpactNextSteps(currentEntry, importedByFiles, importedFiles, workingSetFiles);

  if (!session?.selectedFilePath) {
    return `
      <article class="code-status-card status-info">
        <div class="code-status-card__top">
          <strong>Repo impact graph</strong>
          <span class="code-status-card__meta">${esc(indexedSummary)}</span>
        </div>
        <div class="code-status-card__detail">Impact shows which neighboring files, imports, and entry points are likely to move when the active file changes. Select a file in the editor to anchor the graph.</div>
      </article>
      ${renderRepoFileStrip('Working set', workingSetFiles.slice(0, MAX_REPO_VISUAL_FILES_PER_SECTION), '', 'No working-set files are available yet.')}
      ${renderRepoFileStrip('Notable files', notableFiles.slice(0, MAX_REPO_VISUAL_FILES_PER_SECTION), '', 'No notable files were indexed.')}
    `;
  }

  if (!currentEntry) {
    return `
      <article class="code-status-card status-info">
        <div class="code-status-card__top">
          <strong>${esc(selectedRelativePath || session.selectedFilePath)}</strong>
          <span class="code-status-card__meta">${esc(indexedSummary)}</span>
        </div>
        <div class="code-status-card__detail">The active file is open in the editor, but the workspace map does not have enough indexed repo metadata for impact analysis yet.</div>
      </article>
      ${renderRepoFileStrip('Working set', workingSetFiles.slice(0, MAX_REPO_VISUAL_FILES_PER_SECTION), '', 'No working-set files are available yet.')}
      ${renderRepoFileStrip('Notable files', notableFiles.slice(0, MAX_REPO_VISUAL_FILES_PER_SECTION), '', 'No notable files were indexed.')}
    `;
  }

  return `
    <article class="code-investigation-hero">
      <div class="code-investigation-hero__eyebrow">How Changes Spread</div>
      <h4>${esc(currentEntry.path)}</h4>
      <div class="code-investigation-hero__copy">${esc(buildImpactNarrative(currentEntry, importedByFiles, importedFiles, peerFiles))}</div>
      <div class="code-investigation-hero__pills">
        <span class="code-visual-pill tone-linked">${esc(`${importedByFiles.length} inbound dependent${importedByFiles.length === 1 ? '' : 's'}`)}</span>
        <span class="code-visual-pill tone-linked">${esc(`${importedFiles.length} local dependenc${importedFiles.length === 1 ? 'y' : 'ies'}`)}</span>
        <span class="code-visual-pill tone-signal">${esc(`${peerFiles.length} directory peer${peerFiles.length === 1 ? '' : 's'}`)}</span>
      </div>
    </article>
    <div class="code-investigation-grid">
      <article class="code-investigation-card tone-linked">
        <div class="code-investigation-card__title">Blast Radius</div>
        <div class="code-investigation-card__copy">${esc(`${basename(currentEntry.path)} can affect inbound dependents, downstream imports, and nearby files that share the same folder context.`)}</div>
      </article>
      <article class="code-investigation-card tone-risk">
        <div class="code-investigation-card__title">Potential Issues</div>
        <div class="code-investigation-card__copy">${esc(buildImpactRiskCopy(importedByFiles, importedFiles, workingSetFiles, notableFiles))}</div>
      </article>
      <article class="code-investigation-card tone-neutral">
        <div class="code-investigation-card__title">Check Next</div>
        <ul class="code-investigation-card__list">
          ${impactNextSteps.map((step) => `<li>${esc(step)}</li>`).join('')}
        </ul>
      </article>
    </div>
    <article class="code-status-card status-info">
      <div class="code-status-card__top">
        <strong>${esc(currentEntry.path)}</strong>
        <span class="code-status-card__meta">${esc(indexedSummary)}</span>
      </div>
      <div class="code-status-card__detail">Impact uses the workspace index to show which files feed into this one, which files it depends on, and where nearby repo context could widen the blast radius.</div>
    </article>
    <div class="code-visual-stage code-repo-stage">
      ${renderRepoFileStack('Inbound dependents', importedByFiles.slice(0, MAX_REPO_VISUAL_FILES_PER_SECTION), 'No indexed local importers detected for this file.', currentPath)}
      <div class="code-visual-bridge"><span>${importedByFiles.length > 1 ? 'feeds' : 'feeds into'}</span></div>
      ${renderRepoFocusCard(currentEntry, {
        importedByCount: importedByFiles.length,
        importsCount: importedFiles.length,
        peerCount: peerFiles.length,
      })}
      <div class="code-visual-bridge"><span>${importedFiles.length > 1 ? 'imports' : 'imports from'}</span></div>
      ${renderRepoFileStack('Downstream dependencies', importedFiles.slice(0, MAX_REPO_VISUAL_FILES_PER_SECTION), 'No indexed relative imports detected for this file.', currentPath)}
    </div>
    ${renderRepoFileStrip('Directory peers', peerFiles.slice(0, MAX_REPO_VISUAL_FILES_PER_SECTION), currentPath, 'No sibling files were indexed in this directory.')}
    ${renderRepoFileStrip('Working set', workingSetFiles.slice(0, MAX_REPO_VISUAL_FILES_PER_SECTION), currentPath, 'No working-set files are available yet.')}
    ${renderRepoFileStrip('Notable files', notableFiles.slice(0, MAX_REPO_VISUAL_FILES_PER_SECTION), currentPath, 'No notable files were indexed.')}
  `;
}

function renderStructureList(session) {
  const structureView = session?.structureView;
  if (!session?.selectedFilePath) {
    return '<div class="empty-state">Open a TypeScript or JavaScript file to inspect symbols, side effects, and trust boundaries.</div>';
  }
  if (!structureView) {
    return '<div class="empty-state">Structure insights will appear here for the active file.</div>';
  }
  if (structureView.error) {
    return `<div class="empty-state">${esc(structureView.error)}</div>`;
  }
  if (!structureView.supported) {
    return `<div class="empty-state">${esc(structureView.summary || 'Structure inspection is not available for this file.')}</div>`;
  }
  if (!Array.isArray(structureView.symbols) || structureView.symbols.length === 0) {
    return `<div class="empty-state">${esc(structureView.summary || 'No extractable symbols were found in this file yet.')}</div>`;
  }

  const selectedSymbol = getSelectedStructureSymbol(session);
  const previewBanner = getStructurePreviewBanner(session);
  const selectedMeta = selectedSymbol
    ? `
      <article class="code-structure-focus">
        <div class="code-structure-focus__header">
          <div>
            <div class="code-structure-focus__eyebrow">${esc(summarizeStructureSymbolMeta(selectedSymbol))}</div>
            <h4>${esc(selectedSymbol.name)}</h4>
          </div>
          <button class="btn btn-secondary btn-sm" type="button" data-code-structure-symbol="${escAttr(selectedSymbol.id)}" data-code-structure-reveal="true">Reveal</button>
        </div>
        ${selectedSymbol.signature ? `<div class="code-structure-focus__signature">${esc(selectedSymbol.signature)}</div>` : ''}
        <div class="code-structure-focus__summary">${esc(selectedSymbol.summary || '')}</div>
        <div class="code-structure-focus__pills">
          ${renderStructureCountPill('Side effects', selectedSymbol.sideEffects)}
          ${renderStructureCountPill('Boundaries', selectedSymbol.trustBoundaryTags)}
          ${renderStructureCountPill('Quality notes', selectedSymbol.qualityNotes)}
          ${renderStructureCountPill('Security notes', selectedSymbol.securityNotes)}
          ${renderStructureCountPill('Callers', selectedSymbol.callers)}
          ${renderStructureCountPill('Callees', selectedSymbol.callees)}
        </div>
        ${selectedSymbol.excerpt ? `<pre class="code-structure-focus__excerpt">${esc(selectedSymbol.excerpt)}</pre>` : ''}
        <div class="code-structure-grid">
          <div class="code-structure-grid__section">
            <div class="code-structure-grid__title">Side Effects</div>
            <div class="code-structure-grid__body">${selectedSymbol.sideEffects.length > 0 ? esc(selectedSymbol.sideEffects.join(', ')) : 'No deterministic side effects detected.'}</div>
          </div>
          <div class="code-structure-grid__section">
            <div class="code-structure-grid__title">Trust Boundaries</div>
            <div class="code-structure-grid__body">${selectedSymbol.trustBoundaryTags.length > 0 ? esc(selectedSymbol.trustBoundaryTags.join(', ')) : 'No trust-boundary tags detected.'}</div>
          </div>
          <div class="code-structure-grid__section">
            <div class="code-structure-grid__title">Quality Notes</div>
            <div class="code-structure-grid__body">${selectedSymbol.qualityNotes.length > 0 ? esc(selectedSymbol.qualityNotes.join(' ')) : 'No deterministic quality notes.'}</div>
          </div>
          <div class="code-structure-grid__section">
            <div class="code-structure-grid__title">Security Notes</div>
            <div class="code-structure-grid__body">${selectedSymbol.securityNotes.length > 0 ? esc(selectedSymbol.securityNotes.join(' ')) : 'No deterministic security notes.'}</div>
          </div>
          <div class="code-structure-grid__section">
            <div class="code-structure-grid__title">Callers</div>
            <div class="code-structure-grid__body">${selectedSymbol.callers.length > 0 ? esc(selectedSymbol.callers.join(', ')) : 'No local callers detected.'}</div>
          </div>
          <div class="code-structure-grid__section">
            <div class="code-structure-grid__title">Callees</div>
            <div class="code-structure-grid__body">${selectedSymbol.callees.length > 0 ? esc(selectedSymbol.callees.join(', ')) : 'No local callees detected.'}</div>
          </div>
        </div>
      </article>
    `
    : '';

  return `
    ${previewBanner}
    <article class="code-status-card status-info">
      <div class="code-status-card__top">
        <strong>${esc(structureView.path || session.selectedFilePath)}</strong>
        <span class="code-status-card__meta">${esc(`${structureView.language || 'Code'} • ${structureView.provenance || 'deterministic_ast'}`)}</span>
      </div>
      <div class="code-status-card__detail">${esc(structureView.summary || '')}</div>
      ${(structureView.importSources.length > 0 || structureView.exports.length > 0)
        ? `<div class="code-structure-file-meta">
            ${structureView.importSources.length > 0 ? `<div><strong>Imports</strong> ${esc(structureView.importSources.slice(0, 6).join(', '))}</div>` : ''}
            ${structureView.exports.length > 0 ? `<div><strong>Exports</strong> ${esc(structureView.exports.slice(0, 6).join(', '))}</div>` : ''}
          </div>`
        : ''}
    </article>
    ${selectedMeta}
    <div class="code-structure-list">
      ${structureView.symbols.map((symbol) => {
        const concernCount = symbol.qualityNotes.length + symbol.securityNotes.length;
        const relationCount = symbol.callers.length + symbol.callees.length;
        const isSelected = selectedSymbol?.id === symbol.id;
        return `
          <button
            class="code-structure-item ${isSelected ? 'is-selected' : ''}"
            type="button"
            data-code-structure-symbol="${escAttr(symbol.id)}"
            data-code-structure-reveal="true"
          >
            <span class="code-structure-item__top">
              <span class="code-structure-item__name">${esc(symbol.name)}</span>
              <span class="code-structure-item__kind">${esc(symbol.kind)}</span>
            </span>
            <span class="code-structure-item__meta">${esc(`lines ${symbol.range.startLine}-${symbol.range.endLine}${symbol.exported ? ' • exported' : ''}${symbol.async ? ' • async' : ''}`)}</span>
            <span class="code-structure-item__summary">${esc(symbol.summary || '')}</span>
            ${(concernCount > 0 || relationCount > 0)
              ? `<span class="code-structure-item__stats">
                  ${concernCount > 0 ? `<span>${esc(`${concernCount} ${concernCount === 1 ? 'concern' : 'concerns'}`)}</span>` : ''}
                  ${relationCount > 0 ? `<span>${esc(`${relationCount} ${relationCount === 1 ? 'relation' : 'relations'}`)}</span>` : ''}
                </span>`
              : ''}
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function renderInspectorTabs(session) {
  const activeTab = normalizeInspectorTabValue(session?.inspectorTab);
  const labelMap = {
    investigate: 'Investigate',
    flow: 'Flow',
    impact: 'Impact',
  };
  return `
    <div class="code-inspector__tabs" role="tablist" aria-label="Code inspector views">
      ${INSPECTOR_TABS.map((tabId) => {
        const label = labelMap[tabId] || tabId;
        const isActive = activeTab === tabId;
        return `
          <button
            class="code-inspector__tab ${isActive ? 'is-active' : ''}"
            type="button"
            role="tab"
            aria-selected="${isActive ? 'true' : 'false'}"
            data-code-inspector-tab="${escAttr(tabId)}"
          >
            ${esc(label)}
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function renderInspectorModeHint(session) {
  switch (normalizeInspectorTabValue(session?.inspectorTab)) {
    case 'flow':
      return '<div class="code-inspector__hint">Flow traces symbol-to-symbol behavior inside the current file or selected section.</div>';
    case 'impact':
      return '<div class="code-inspector__hint">Impact traces file-to-file blast radius across the repo using the indexed workspace map.</div>';
    case 'investigate':
    default:
      return '<div class="code-inspector__hint">Investigate explains what the current code does, what it talks to, and which risks or quality issues deserve attention first.</div>';
  }
}

function renderInspectorPanel(session) {
  switch (normalizeInspectorTabValue(session?.inspectorTab)) {
    case 'flow':
      return renderVisualPanel(session);
    case 'impact':
      return renderRepoVisualPanel(session);
    case 'investigate':
    default:
      return renderInvestigatePanel(session);
  }
}

function renderCodeInspectorSurface(session, { detached = false } = {}) {
  const activeFile = session?.selectedFilePath
    ? toRelativePath(session.selectedFilePath, session.resolvedRoot || session.workspaceRoot || '') || session.selectedFilePath
    : '';
  return `
    <section class="code-inspector__window panel ${detached ? 'is-detached' : 'is-modal'}" role="dialog" aria-modal="${detached ? 'false' : 'true'}" aria-label="Code inspector">
      <div class="code-inspector__header">
        <div class="code-inspector__heading">
          <div class="code-inspector__eyebrow">Guided code investigation</div>
          <h3>${esc(activeFile || session?.title || 'Inspector')}</h3>
        </div>
        <div class="panel__actions">
          ${detached
            ? '<button class="btn btn-secondary btn-sm" type="button" data-code-inspector-attach>Dock</button>'
            : '<button class="btn btn-secondary btn-sm" type="button" data-code-inspector-detach>Detach</button>'}
          <button class="btn btn-secondary btn-sm" type="button" data-code-inspector-close>Close</button>
        </div>
      </div>
      <div class="code-inspector__subhead">
        <span>${esc(session?.resolvedRoot || session?.workspaceRoot || '')}</span>
        ${activeFile ? `<span>${esc(activeFile)}</span>` : '<span>Select a file to inspect.</span>'}
      </div>
      ${renderInspectorTabs(session)}
      ${renderInspectorModeHint(session)}
      <div class="code-inspector__body">
        ${renderInspectorPanel(session)}
      </div>
    </section>
  `;
}

function getCurrentUiThemeDefinition() {
  const themeId = document.documentElement?.dataset?.theme || getSavedTheme();
  return themes.find((theme) => theme.id === themeId) || themes[0] || {
    id: 'guardian-angel',
    vars: {},
  };
}

function serializeThemeVars(theme) {
  return Object.entries(theme?.vars || {})
    .map(([prop, value]) => `${prop}: ${String(value)};`)
    .join(' ');
}

function renderCodeInspectorPopupThemeScript(theme) {
  const fallbackThemeId = String(theme?.id || '');
  const themeKeys = Object.keys(theme?.vars || {});
  return `
    <script>
      (() => {
        const fallbackThemeId = ${JSON.stringify(fallbackThemeId)};
        const themeKeys = ${JSON.stringify(themeKeys)};
        const targetRoot = document.documentElement;
        const applyFromRoot = (sourceRoot) => {
          if (!sourceRoot) return false;
          const sourceWindow = sourceRoot.ownerDocument?.defaultView || window;
          const computed = sourceWindow.getComputedStyle(sourceRoot);
          const nextThemeId = sourceRoot.dataset?.theme || fallbackThemeId;
          if (nextThemeId) {
            targetRoot.dataset.theme = nextThemeId;
          }
          for (const key of themeKeys) {
            const value = sourceRoot.style.getPropertyValue(key) || computed.getPropertyValue(key);
            if (value) {
              targetRoot.style.setProperty(key, value.trim());
            }
          }
          return true;
        };

        try {
          const openerRoot = window.opener?.document?.documentElement;
          applyFromRoot(openerRoot);
          if (openerRoot && window.MutationObserver) {
            const observer = new window.MutationObserver(() => {
              applyFromRoot(openerRoot);
            });
            observer.observe(openerRoot, {
              attributes: true,
              attributeFilter: ['data-theme', 'style'],
            });
            window.addEventListener('beforeunload', () => observer.disconnect(), { once: true });
          }
        } catch {
          // Keep the inline fallback theme when opener theme sync is unavailable.
        }
      })();
    </script>
  `;
}

function renderCodeInspectorPopupDocument(session) {
  const theme = getCurrentUiThemeDefinition();
  const themeStyles = serializeThemeVars(theme);
  return `<!doctype html>
<html lang="en" data-theme="${escAttr(theme.id)}" style="${escAttr(themeStyles)}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Guardian Code Inspector</title>
    <link rel="stylesheet" href="/css/style.css">
  </head>
  <body class="code-inspector-popup-body">
    <div class="code-inspector-popup-shell">
      <div class="code-inspector code-inspector--popup">
        ${renderCodeInspectorSurface(session, { detached: true })}
      </div>
    </div>
    ${renderCodeInspectorPopupThemeScript(theme)}
  </body>
</html>`;
}

function renderCodeInspector(session) {
  if (!session || !isInspectorOpen(session) || session.inspectorDetached) return '';
  return `
    <div class="code-inspector-overlay" data-code-inspector-overlay>
      <button class="code-inspector__backdrop" type="button" aria-label="Close code inspector" data-code-inspector-close></button>
      <div class="code-inspector">
        ${renderCodeInspectorSurface(session)}
      </div>
    </div>
  `;
}

function renderAssistantPanel(session) {
  const activeTab = normalizeAssistantTabValue(session?.activeAssistantTab);
  switch (activeTab) {
    case 'activity':
      return `
        <div class="code-assistant-panel__body">
          <div class="code-chat__meta">
            <div class="code-chat__workspace">${esc(session.resolvedRoot || session.workspaceRoot)}</div>
          </div>
          ${renderWorkspaceTrustNotice(session)}
          <div class="code-assistant-panel__scroll">
            ${renderSessionRunTimeline(session)}
            ${renderApprovalList(session)}
            ${renderTaskList(session)}
            ${renderCheckList(session)}
          </div>
        </div>
      `;
    case 'chat':
    default:
      const committedMessages = Array.isArray(session.chat) ? session.chat : [];
      const pendingUserMessage = typeof session.pendingResponse?.message === 'string'
        ? session.pendingResponse.message.trim()
        : '';
      const hasVisibleMessages = committedMessages.length > 0 || !!pendingUserMessage;
      return `
        <div class="code-assistant-panel__body">
          <div class="code-chat__meta">
            <div class="code-chat__workspace">${esc(session.resolvedRoot || session.workspaceRoot)}</div>
          </div>
          ${renderWorkspaceTrustNotice(session)}
          ${renderChatNotice(session)}
          ${renderCodeLiveProgress(session)}
          <div class="code-chat__history">
            ${!hasVisibleMessages
              ? `<div class="code-chat__onboarding">
                  <div class="code-chat__onboarding-title">Getting Started</div>
                  <ul class="code-chat__onboarding-list">
                    <li>Describe a bug, feature, or refactor in plain language</li>
                    <li>The agent reads files, edits code, and runs commands</li>
                    <li>Mutating actions go through Guardian approval automatically</li>
                    <li>Coding tools are built in &mdash; just describe what you need</li>
                  </ul>
                </div>`
              : `${committedMessages.map((message, idx) => {
                  const isLastAgent = message.role === 'agent' && !committedMessages.slice(idx + 1).some((m) => m.role === 'agent');
                  const inlineApprovals = isLastAgent && !pendingUserMessage && Array.isArray(session.pendingApprovals) && session.pendingApprovals.length > 0
                    ? session.pendingApprovals
                    : null;
                  return renderCodeMessage(message.role, message.content, '', inlineApprovals, message.responseSource);
                }).join('')}${pendingUserMessage ? renderCodeMessage('user', pendingUserMessage, 'is-pending') : ''}${pendingUserMessage ? renderCodeThinkingMessage() : ''}`}
          </div>
          <form class="code-chat__form" data-code-chat-form>
            <div class="code-chat__refs" data-code-chat-ref-list${Array.isArray(session.draftFileReferences) && session.draftFileReferences.length > 0 ? '' : ' hidden'}>
              ${renderCodeChatDraftReferencesMarkup(session.draftFileReferences)}
            </div>
            <div class="code-chat__composer">
              <textarea name="message" rows="3" placeholder="Describe the change, bug, or refactor you want. Type @ to tag files or docs." title="Type @ to tag workspace files or docs and inject that context into this turn.">${esc(session.chatDraft || '')}</textarea>
              <div class="code-chat__mention-menu" data-code-chat-mention-menu hidden></div>
            </div>
            <div class="code-chat__hint">Type <code>@</code> to tag files or docs into this turn's model context.</div>
            <button class="btn btn-primary" type="submit">Send</button>
          </form>
        </div>
      `;
  }
}

function renderDetachedInspectorWindow(session) {
  if (!session?.inspectorDetached || !session.inspectorOpen) return false;
  const popup = inspectorPopupWindow && !inspectorPopupWindow.closed
    ? inspectorPopupWindow
    : window.open('', 'guardian-code-inspector', 'popup=yes,width=1180,height=820,resizable=yes,scrollbars=yes');
  if (!popup) return false;
  const savedScroll = saveScrollPositions(popup.document);
  inspectorPopupWindow = popup;
  inspectorPopupSessionId = session.id;
  popup.__guardianClosing = false;
  if (!popup.__guardianInspectorUnloadBound) {
    popup.addEventListener('beforeunload', () => {
      if (popup.__guardianClosing) return;
      const liveSession = inspectorPopupSessionId ? getSessionById(inspectorPopupSessionId) : null;
      if (liveSession) {
        liveSession.inspectorOpen = false;
        liveSession.inspectorDetached = false;
        saveState(codeState);
      }
      inspectorPopupWindow = null;
      inspectorPopupSessionId = null;
      if (currentContainer) {
        rerenderFromState();
      }
    });
    popup.__guardianInspectorUnloadBound = true;
  }
  popup.document.open();
  popup.document.write(renderCodeInspectorPopupDocument(session));
  popup.document.close();
  popup.focus();
  bindInspectorEvents(popup.document);
  restoreScrollPositions(popup.document, savedScroll);
  return true;
}

function syncDetachedInspectorWindow(session = getActiveSession()) {
  if (inspectorPopupWindow?.closed) {
    inspectorPopupWindow = null;
  }

  if (!inspectorPopupWindow && inspectorPopupSessionId && session?.id === inspectorPopupSessionId && session.inspectorDetached) {
    session.inspectorOpen = false;
    session.inspectorDetached = false;
    inspectorPopupSessionId = null;
    saveState(codeState);
    if (currentContainer) {
      const inspectorHost = currentContainer.querySelector('[data-code-inspector-host]');
      if (inspectorHost) inspectorHost.innerHTML = renderCodeInspector(session);
      bindInspectorEvents(currentContainer);
    }
    return;
  }

  if (!session?.inspectorOpen || !session.inspectorDetached) {
    closeDetachedInspectorWindow();
    return;
  }

  if (!renderDetachedInspectorWindow(session)) {
    session.inspectorDetached = false;
    saveState(codeState);
  }
}

function refreshInspectorSurface(session) {
  const savedScroll = currentContainer ? saveScrollPositions(currentContainer) : null;
  if (currentContainer) {
    const inspectorHost = currentContainer.querySelector('[data-code-inspector-host]');
    if (inspectorHost) {
      inspectorHost.innerHTML = renderCodeInspector(session);
    }
    bindInspectorEvents(currentContainer);
    if (savedScroll) {
      restoreScrollPositions(currentContainer, savedScroll);
    }
  }
  syncDetachedInspectorWindow(session);
}

function bindInspectorEvents(root = currentContainer) {
  if (!root) return;
  root.querySelectorAll('[data-code-structure-symbol]').forEach((button) => {
    button.addEventListener('click', () => {
      const session = getActiveSession();
      if (!session) return;
      const symbolId = button.dataset.codeStructureSymbol || '';
      const reveal = button.dataset.codeStructureReveal === 'true';
      if (!symbolId) return;
      focusStructureSymbol(session, symbolId, { reveal, switchTab: true });
    });
  });
  root.querySelectorAll('[data-code-visual-symbol]').forEach((button) => {
    button.addEventListener('click', () => {
      const session = getActiveSession();
      if (!session) return;
      const symbolId = button.dataset.codeVisualSymbol || '';
      const reveal = button.dataset.codeVisualReveal === 'true';
      if (!symbolId) return;
      openInspector(session, 'flow');
      focusStructureSymbol(session, symbolId, { reveal, switchTab: false });
    });
  });
  root.querySelectorAll('[data-code-structure-section]').forEach((button) => {
    button.addEventListener('click', async () => {
      const session = getActiveSession();
      if (!session) return;
      const sectionId = button.dataset.codeStructureSection || '';
      if (!sectionId) return;
      await refreshStructureScope(session, { sectionId });
    });
  });
  root.querySelectorAll('[data-code-structure-sync-cursor]').forEach((button) => {
    button.addEventListener('click', async () => {
      const session = getActiveSession();
      if (!session) return;
      await refreshStructureScope(session, {
        lineNumber: getCurrentCursorLineNumber(),
        sectionId: '',
      });
    });
  });
  root.querySelectorAll('[data-code-repo-file]').forEach((button) => {
    button.addEventListener('click', async () => {
      const session = getActiveSession();
      if (!session) return;
      const relativePath = button.dataset.codeRepoFile || '';
      const filePath = resolveWorkspaceFilePath(session, relativePath);
      if (!filePath) return;
      const currentTab = getActiveTab(session);
      if (currentTab) {
        saveMonacoViewState(currentTab.filePath);
        syncActiveEditorStateFromMonaco(session);
      }
      openFileInTab(session, filePath);
      session.showDiff = false;
      openInspector(session, 'impact');
      saveState(codeState);
      queueSessionPersist(session);
      await refreshFileView(session);
    });
  });
  root.querySelectorAll('[data-code-inspector-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const session = getActiveSession();
      if (!session) return;
      session.inspectorTab = normalizeInspectorTabValue(button.dataset.codeInspectorTab);
      saveState(codeState);
      refreshInspectorSurface(session);
    });
  });
  root.querySelectorAll('[data-code-inspector-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const session = getActiveSession();
      if (!session) return;
      closeInspector(session);
      rerenderFromState();
    });
  });
  root.querySelectorAll('[data-code-inspector-detach]').forEach((button) => {
    button.addEventListener('click', () => {
      const session = getActiveSession();
      if (!session) return;
      session.inspectorOpen = true;
      session.inspectorDetached = true;
      saveState(codeState);
      syncDetachedInspectorWindow(session);
      rerenderFromState();
    });
  });
  root.querySelectorAll('[data-code-inspector-attach]').forEach((button) => {
    button.addEventListener('click', () => {
      const session = getActiveSession();
      if (!session) return;
      session.inspectorDetached = false;
      session.inspectorOpen = true;
      closeDetachedInspectorWindow();
      saveState(codeState);
      rerenderFromState();
    });
  });
}

function applyStructureViewUpdate(session, structureView, { refreshInspector = true } = {}) {
  if (!session) return;
  session.structureView = structureView;
  saveState(codeState);
  triggerMonacoStructureRefresh();
  applyMonacoStructureSelection(session);
  if (refreshInspector && isInspectorOpen(session)) {
    refreshInspectorSurface(session);
  }
}

// ─── Git panel rendering ───────────────────────────────────

function renderGitPanel(session) {
  const git = session.gitState || {};
  const branch = git.branch || '';
  const staged = git.staged || [];
  const unstaged = git.unstaged || [];
  const untracked = git.untracked || [];
  const loading = !!git.loading;
  const commitMsg = session.gitCommitMessage || '';

  if (loading) {
    return '<div class="empty-inline" style="padding:1rem">Loading git status...</div>';
  }
  if (!branch && staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
    const notInitialized = git.notARepo;
    return `
      <div class="empty-state" style="padding:0.75rem">
        ${notInitialized ? `
          <div style="margin-bottom:0.5rem">This workspace is not a git repository.</div>
          <button class="btn btn-primary btn-sm" type="button" data-code-git-init>Initialize Repository</button>
        ` : `
          <div style="margin-bottom:0.5rem">No git status available.</div>
          <button class="btn btn-secondary btn-sm" type="button" data-code-git-refresh>Refresh</button>
        `}
      </div>
    `;
  }

  const renderFileRow = (file, group) => {
    const statusIcon = file.status === 'M' ? 'M' : file.status === 'A' ? 'A' : file.status === 'D' ? 'D' : file.status === 'R' ? 'R' : file.status === '?' ? 'U' : file.status || '?';
    const statusClass = file.status === 'M' ? 'modified' : file.status === 'D' ? 'deleted' : file.status === 'A' ? 'added' : file.status === '?' ? 'untracked' : 'default';
    return `
      <div class="code-git-file">
        <button class="code-git-file__name" type="button" data-code-git-file-diff="${escAttr(file.path)}" title="${escAttr(file.path)}">
          <span class="code-git-status code-git-status--${statusClass}">${esc(statusIcon)}</span>
          <span class="code-git-file__label">${esc(file.path)}</span>
        </button>
        <span class="code-git-file__actions">
          ${group === 'unstaged' || group === 'untracked' ? `<button class="code-git-action-btn" type="button" data-code-git-stage="${escAttr(file.path)}" title="Stage">+</button>` : ''}
          ${group === 'staged' ? `<button class="code-git-action-btn" type="button" data-code-git-unstage="${escAttr(file.path)}" title="Unstage">&minus;</button>` : ''}
          ${group !== 'staged' ? `<button class="code-git-action-btn code-git-action-btn--danger" type="button" data-code-git-discard="${escAttr(file.path)}" title="Discard changes">&#x2715;</button>` : ''}
        </span>
      </div>
    `;
  };

  const sections = [];
  if (branch) {
    sections.push(`<div class="code-git-branch" title="Current branch"><span class="code-git-branch__icon">&#9095;</span> ${esc(branch)}</div>`);
  }

  // Commit input
  sections.push(`
    <div class="code-git-commit">
      <input class="code-git-commit__input" type="text" placeholder="Commit message" value="${escAttr(commitMsg)}" data-code-git-commit-msg>
      <button class="btn btn-primary btn-sm" type="button" data-code-git-commit title="Commit staged changes" ${staged.length === 0 ? 'disabled' : ''}>Commit</button>
    </div>
  `);

  if (staged.length > 0) {
    sections.push(`
      <div class="code-git-group">
        <div class="code-git-group__header">
          <span>Staged Changes</span>
          <span class="code-git-group__count">${staged.length}</span>
        </div>
        ${staged.map((f) => renderFileRow(f, 'staged')).join('')}
      </div>
    `);
  }

  if (unstaged.length > 0) {
    sections.push(`
      <div class="code-git-group">
        <div class="code-git-group__header">
          <span>Changes</span>
          <span class="code-git-group__count">${unstaged.length}</span>
        </div>
        ${unstaged.map((f) => renderFileRow(f, 'unstaged')).join('')}
      </div>
    `);
  }

  if (untracked.length > 0) {
    sections.push(`
      <div class="code-git-group">
        <div class="code-git-group__header">
          <span>Untracked Files</span>
          <span class="code-git-group__count">${untracked.length}</span>
        </div>
        ${untracked.map((f) => renderFileRow(f, 'untracked')).join('')}
      </div>
    `);
  }

  // Action bar
  sections.push(`
    <div class="code-git-actions-bar">
      <button class="btn btn-secondary btn-sm" type="button" data-code-git-pull title="Pull">&#x2193; Pull</button>
      <button class="btn btn-secondary btn-sm" type="button" data-code-git-push title="Push">&#x2191; Push</button>
      <button class="btn btn-secondary btn-sm" type="button" data-code-git-fetch title="Fetch">&#x21BB; Fetch</button>
    </div>
  `);

  // Git graph
  const graphEntries = git.graph || [];
  if (graphEntries.length > 0) {
    sections.push(`
      <div class="code-git-group">
        <div class="code-git-group__header">
          <span>Commit Graph</span>
          <span class="code-git-group__count">${graphEntries.length}</span>
        </div>
        <div class="code-git-graph">
          ${graphEntries.map((entry) => {
            const isHead = entry.refs && entry.refs.includes('HEAD');
            return `<div class="code-git-graph__row ${isHead ? 'is-head' : ''}">
              <span class="code-git-graph__line">${esc(entry.graph || '')}</span>
              <span class="code-git-graph__hash">${esc(entry.hash || '')}</span>
              ${entry.refs ? `<span class="code-git-graph__refs">${esc(entry.refs)}</span>` : ''}
              <span class="code-git-graph__msg">${esc(entry.message || '')}</span>
              <span class="code-git-graph__date">${esc(entry.date || '')}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
    `);
  }

  return `<div class="code-git-panel">${sections.join('')}</div>`;
}

// ─── Session card rendering ────────────────────────────────

function renderSessionForm() {
  const isCreate = codeState.showCreateForm;
  const isEdit = !!codeState.editingSessionId;
  if (!isCreate && !isEdit) return '';

  const draft = isEdit ? codeState.editDraft || {} : codeState.createDraft || {};
  const editSession = isEdit
    ? codeState.sessions.find((session) => session.id === codeState.editingSessionId) || null
    : null;
  const formId = isEdit ? 'data-code-edit-session-form' : 'data-code-session-form';
  const submitLabel = isEdit ? 'Save' : 'Create';
  const cancelAttr = isEdit ? 'data-code-cancel-edit' : 'data-code-cancel-create';
  const workspaceTrust = editSession?.workspaceTrust || null;
  const effectiveTrustState = getEffectiveWorkspaceTrustState(editSession) || workspaceTrust?.state || null;
  const reviewActive = isWorkspaceTrustReviewActive(editSession);
  const overrideAvailable = isWorkspaceTrustOverrideAvailable(editSession);
  const overrideChecked = isEdit
    ? (draft.workspaceTrustOverrideAccepted !== undefined
      ? !!draft.workspaceTrustOverrideAccepted
      : reviewActive)
    : false;
  const effectiveTrustBadgeClass = reviewActive
    ? 'badge-trust-accepted'
    : getWorkspaceTrustBadgeClass(effectiveTrustState);
  const rawTrustBadgeClass = getWorkspaceTrustBadgeClass(workspaceTrust?.state || '');
  const trustReviewSection = isEdit && workspaceTrust && (workspaceTrust.state !== 'trusted' || reviewActive)
    ? `
      <div class="code-session-form__trust-review">
        <div class="code-session-form__trust-title">Repo Trust Review</div>
        <div class="code-session-form__trust-copy">
          ${reviewActive
            ? `This workspace is manually trusted for this session because you accepted the current findings ${editSession?.workspaceTrustReview?.reviewedAt ? esc(formatRelativeTime(editSession.workspaceTrustReview.reviewedAt)) : ''}. If the findings change, the override clears automatically.`
            : overrideAvailable
              ? `The scanner still found indicators in this repo. You can acknowledge them here and treat the workspace as trusted for this session. Raw findings remain visible in activity.`
              : `Manual trust override is unavailable while native AV reports an active workspace detection.`}
        </div>
        <div class="code-session-form__trust-statuses">
          <span class="badge ${escAttr(effectiveTrustBadgeClass)}">
            Effective: ${esc(reviewActive ? 'ACCEPTED' : String(effectiveTrustState || '').toUpperCase())}
          </span>
          <span class="badge ${escAttr(rawTrustBadgeClass)}">
            Raw: ${esc(String(workspaceTrust.state || '').toUpperCase())}
          </span>
        </div>
        <label class="code-session-form__checkbox">
          <input
            name="workspaceTrustOverrideAccepted"
            type="checkbox"
            ${overrideChecked ? 'checked' : ''}
            ${!overrideAvailable ? 'disabled' : ''}
          >
          <span>I reviewed the current findings and want this workspace treated as trusted for this session.</span>
        </label>
        ${renderWorkspaceTrustFindingsMarkup(workspaceTrust)}
      </div>
    `
    : '';

  return `
    <form class="code-session-form is-visible" ${formId}>
      <label>
        Title
        <input name="title" type="text" value="${escAttr(draft.title || '')}" placeholder="Frontend app">
      </label>
      <label>
        Workspace Root
        <div class="code-session-form__field-row">
          <input name="workspaceRoot" type="text" value="${escAttr(draft.workspaceRoot || '.')}" placeholder=". or /path/to/project" style="flex:1">
          <button class="btn btn-secondary btn-sm" type="button" data-code-browse-dir>Browse</button>
        </div>
      </label>
      ${renderDirPicker()}
      ${!isEdit ? `
        <label>
          Agent
          <select name="agentId">
            ${getCodeProviderOptions(cachedAgents).map((option) => (
              `<option value="${escAttr(option.value)}"${draft.agentId === option.value ? ' selected' : ''}>${esc(option.value ? option.label : 'Guardian Auto')}</option>`
            )).join('')}
          </select>
        </label>
      ` : ''}
      <div class="code-session-form__actions">
        <button class="btn btn-primary btn-sm" type="submit">${submitLabel}</button>
        <button class="btn btn-secondary btn-sm" type="button" ${cancelAttr}>Cancel</button>
        ${isEdit ? `<button class="btn btn-danger btn-sm code-session-form__clear" type="button" data-code-clear-history="${escAttr(codeState.editingSessionId)}" title="Permanently clears all chat history for this session. This cannot be undone.">Clear History</button>` : ''}
      </div>
      ${trustReviewSection}
    </form>
  `;
}

function renderSessionCard(session) {
  const isActive = session.id === codeState.activeSessionId;
  const approvalCount = Array.isArray(session.pendingApprovals) ? session.pendingApprovals.length : 0;
  const checkCount = getCheckBadgeCount(session);
  const taskCount = getTaskBadgeCount(session);
  const workspaceTrust = session.workspaceTrust || null;
  const effectiveTrustState = getEffectiveWorkspaceTrustState(session) || workspaceTrust?.state || null;
  const reviewActive = isWorkspaceTrustReviewActive(session);
  const trustBadgeClass = reviewActive
    ? 'badge-trust-accepted'
    : getWorkspaceTrustBadgeClass(effectiveTrustState);
  const rawTrustBadgeClass = getWorkspaceTrustBadgeClass(workspaceTrust?.state || null);
  return `
    <button class="code-session ${isActive ? 'is-active' : ''}" type="button" data-code-session-id="${escAttr(session.id)}">
      <div class="code-session__top">
        <strong>${esc(session.title)}</strong>
        <span style="display:flex;gap:0.4rem;align-items:center">
          <span class="code-session__edit" data-code-edit-session="${escAttr(session.id)}" title="Edit session">&#9998;</span>
          <span class="code-session__delete" data-code-delete-session="${escAttr(session.id)}">&times;</span>
        </span>
      </div>
      <div class="code-session__meta">${esc(session.workspaceRoot)}</div>
      <div class="code-session__badges">
        ${workspaceTrust ? `<span class="badge ${trustBadgeClass}">TRUST: ${esc(reviewActive ? 'ACCEPTED' : String(effectiveTrustState || '').toUpperCase())}</span>` : ''}
        ${reviewActive ? `<span class="badge ${rawTrustBadgeClass}">RAW: ${esc(String(workspaceTrust?.state || '').toUpperCase())}</span>` : ''}
        ${approvalCount > 0 ? `<span class="badge badge-warn">${approvalCount} ${approvalCount === 1 ? 'approval' : 'approvals'}</span>` : ''}
        ${taskCount > 0 ? `<span class="badge badge-idle">${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}</span>` : ''}
        ${checkCount > 0 ? `<span class="badge badge-info">${checkCount} ${checkCount === 1 ? 'check' : 'checks'}</span>` : ''}
      </div>
    </button>
  `;
}

// ─── Tab helpers ───────────────────────────────────────────

function getActiveTab(session) {
  if (!session || !Array.isArray(session.openTabs) || session.openTabs.length === 0) return null;
  const idx = session.activeTabIndex;
  if (idx < 0 || idx >= session.openTabs.length) return null;
  return session.openTabs[idx];
}

function openFileInTab(session, filePath) {
  if (!session) return;
  if (!Array.isArray(session.openTabs)) session.openTabs = [];
  // Check if already open
  const existingIdx = session.openTabs.findIndex((t) => t.filePath === filePath);
  if (existingIdx >= 0) {
    session.activeTabIndex = existingIdx;
  } else {
    session.openTabs.push({ filePath, dirty: false, content: null });
    session.activeTabIndex = session.openTabs.length - 1;
  }
  // Sync legacy field
  session.selectedFilePath = filePath;
}

function closeTab(session, index) {
  if (!session || !Array.isArray(session.openTabs)) return;
  const tab = session.openTabs[index];
  if (!tab) return;
  if (tab.dirty && !confirm(`Discard unsaved changes to ${basename(tab.filePath)}?`)) return;
  session.openTabs.splice(index, 1);
  if (session.openTabs.length === 0) {
    session.activeTabIndex = -1;
    session.selectedFilePath = null;
  } else if (session.activeTabIndex >= session.openTabs.length) {
    session.activeTabIndex = session.openTabs.length - 1;
    session.selectedFilePath = session.openTabs[session.activeTabIndex].filePath;
  } else {
    session.selectedFilePath = session.openTabs[session.activeTabIndex]?.filePath || null;
  }
}

function syncActiveEditorStateFromMonaco(session = getActiveSession()) {
  const currentTab = getActiveTab(session);
  if (!currentTab || !monacoEditorInstance) return;
  const value = monacoEditorInstance.getValue();
  if (value !== (cachedFileView.source || '')) {
    currentTab.content = value;
    currentTab.dirty = true;
  }
}

function getDirtyCodeTabs() {
  const dirtyTabs = [];
  for (const session of codeState.sessions || []) {
    if (!Array.isArray(session?.openTabs)) continue;
    for (const tab of session.openTabs) {
      if (tab?.dirty && tab.filePath) {
        dirtyTabs.push({ session, tab });
      }
    }
  }
  return dirtyTabs;
}

function formatDirtyTabsPrompt(dirtyTabs) {
  if (dirtyTabs.length === 1) {
    return `Save changes to ${basename(dirtyTabs[0].tab.filePath)} before leaving the Code page?\n\nPress OK to save and continue. Press Cancel to stay on this page.`;
  }
  const preview = dirtyTabs
    .slice(0, 3)
    .map(({ tab }) => basename(tab.filePath))
    .join(', ');
  const remainder = dirtyTabs.length > 3 ? `, and ${dirtyTabs.length - 3} more` : '';
  return `Save ${dirtyTabs.length} unsaved files before leaving the Code page?\n\n${preview}${remainder}\n\nPress OK to save and continue. Press Cancel to stay on this page.`;
}

async function saveCodeTab(session, tab) {
  if (!session || !tab?.filePath) return;
  const activeSession = getActiveSession();
  const isActiveSession = !!activeSession && activeSession.id === session.id;
  const isActiveTab = isActiveSession && getActiveTab(session) === tab;
  const content = isActiveTab && monacoEditorInstance ? monacoEditorInstance.getValue() : tab.content;
  if (content == null) {
    throw new Error(`No staged editor content is available for ${basename(tab.filePath)}.`);
  }
  const result = await api.codeFsWrite({
    sessionId: session.id,
    path: tab.filePath,
    content,
  });
  if (!result?.success) {
    throw new Error(result?.error || `Failed to save ${basename(tab.filePath)}.`);
  }
  tab.dirty = false;
  tab.content = null;
  if (isActiveTab) {
    cachedFileView = { ...cachedFileView, source: content };
  }
}

export async function confirmCodeRouteLeave() {
  const activeSession = getActiveSession();
  if (activeSession) {
    syncActiveEditorStateFromMonaco(activeSession);
  }
  const dirtyTabs = getDirtyCodeTabs();
  if (dirtyTabs.length === 0) return true;
  if (!window.confirm(formatDirtyTabsPrompt(dirtyTabs))) {
    return false;
  }
  try {
    for (const { session, tab } of dirtyTabs) {
      await saveCodeTab(session, tab);
    }
    saveState(codeState);
    if (currentContainer) {
      rerenderFromState();
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const session = dirtyTabs[0]?.session || activeSession;
    if (session) {
      appendChatMessage(session, 'error', `Save failed: ${message}`);
    }
    saveState(codeState);
    if (currentContainer) {
      rerenderFromState();
    }
    window.alert(`Couldn't save your changes before leaving the Code page.\n\n${message}`);
    return false;
  }
}

// ─── Editor save ───────────────────────────────────────────

async function saveEditorFile() {
  const session = getActiveSession();
  const tab = getActiveTab(session);
  if (!session || !tab || !tab.dirty) return;
  try {
    await saveCodeTab(session, tab);
    invalidateStructurePreviewState(session.id, session.selectedFilePath || '');
    session.structureView = await loadStructureView(session);
    saveState(codeState);
    rerenderFromState();
  } catch (err) {
    appendChatMessage(session, 'error', `Save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Git helpers ───────────────────────────────────────────

async function refreshGitStatus(session) {
  session.gitState = { ...session.gitState, loading: true };
  saveState(codeState);
  rerenderFromState();
  try {
    const [statusResult, graphResult] = await Promise.all([
      api.codeGitStatus(session.id),
      api.codeGitGraph(session.id).catch(() => ({ success: false, entries: [] })),
    ]);
    if (statusResult?.success) {
      session.gitState = {
        branch: statusResult.branch || '',
        staged: Array.isArray(statusResult.staged) ? statusResult.staged : [],
        unstaged: Array.isArray(statusResult.unstaged) ? statusResult.unstaged : [],
        untracked: Array.isArray(statusResult.untracked) ? statusResult.untracked : [],
        graph: Array.isArray(graphResult?.entries) ? graphResult.entries : [],
        loading: false,
      };
    } else {
      const notARepo = /not a git repository/i.test(statusResult?.error || '');
      session.gitState = { loading: false, notARepo };
    }
  } catch {
    session.gitState = { loading: false };
  }
  saveState(codeState);
  rerenderFromState();
}

async function runGitAction(session, action, args = {}) {
  try {
    await api.codeGitAction(session.id, { action, ...args });
  } catch (err) {
    appendChatMessage(session, 'error', `Git ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  await refreshGitStatus(session);
}

// ─── Async data refresh helpers ────────────────────────────

async function refreshTree(session) {
  const rootPath = session.resolvedRoot || session.workspaceRoot || '.';
  treeCache.clear();
  const rootData = await loadTreeDir(session, rootPath);
  treeCache.set(rootPath, rootData);
  if (!session.resolvedRoot && rootData.resolvedPath) {
    session.resolvedRoot = rootData.resolvedPath;
  }
  await loadExpandedDirs(session);
  saveState(codeState);
  rerenderFromState();
}

async function refreshVisibleTreeDirs(session) {
  const visiblePaths = getVisibleTreePaths(session);
  if (visiblePaths.length === 0) return false;

  const results = await Promise.all(visiblePaths.map((dirPath) => loadTreeDir(session, dirPath)));
  let changed = false;

  results.forEach((result, index) => {
    const dirPath = visiblePaths[index];
    if (getTreeCacheSignature(treeCache.get(dirPath)) !== getTreeCacheSignature(result)) {
      changed = true;
    }
    treeCache.set(dirPath, result);
    if (index === 0 && !session.resolvedRoot && result.resolvedPath) {
      session.resolvedRoot = result.resolvedPath;
    }
  });

  return changed;
}

async function refreshFileView(session) {
  invalidateStructurePreviewState(session.id, session.selectedFilePath || '');
  const [fileView, structureView] = await Promise.all([
    loadFileView(session),
    loadStructureView(session),
  ]);
  cachedFileView = fileView;
  session.structureView = structureView;
  saveState(codeState);
  rerenderFromState();
}

async function refreshSessionData(session) {
  const latestSession = await refreshSessionSnapshot(session.id).catch(() => session);
  const currentSession = latestSession || session;
  invalidateStructurePreviewState(currentSession.id, currentSession.selectedFilePath || '');
  const rootPath = currentSession.resolvedRoot || currentSession.workspaceRoot || '.';
  treeCache.clear();
  const [rootData, fileView] = await Promise.all([
    loadTreeDir(currentSession, rootPath),
    loadFileView(currentSession),
  ]);
  const structureView = await loadStructureView(currentSession);
  treeCache.set(rootPath, rootData);
  if (!currentSession.resolvedRoot && rootData.resolvedPath) {
    currentSession.resolvedRoot = rootData.resolvedPath;
  }
  cachedFileView = fileView;
  currentSession.structureView = structureView;
  await loadExpandedDirs(currentSession);
  await refreshAssistantState(currentSession, { rerender: false });
  saveState(codeState);
  rerenderFromState();
}

// ─── API data loaders ──────────────────────────────────────

async function loadFileView(session) {
  if (!session.selectedFilePath) {
    return { source: '', diff: '', error: null };
  }

  const [sourceResult, diffResult] = await Promise.all([
    api.codeFsRead({
      sessionId: session.id,
      path: session.selectedFilePath,
      maxBytes: 250000,
    }).catch((err) => ({ success: false, error: err.message })),
    api.codeGitDiff({
      sessionId: session.id,
      cwd: session.currentDirectory || session.resolvedRoot || session.workspaceRoot,
      path: session.selectedFilePath,
    }).catch((err) => ({ success: false, error: err.message })),
  ]);

  return {
    source: sourceResult?.content || '',
    diff: diffResult?.stdout || diffResult?.stderr || '',
    error: sourceResult?.success ? null : (sourceResult?.message || sourceResult?.error || 'Failed to read file.'),
  };
}

async function loadStructureView(session) {
  return loadStructureViewWithOptions(session);
}

async function loadStructureViewWithOptions(session, options = {}) {
  const selectedFilePath = session?.selectedFilePath || '';
  const content = typeof options.content === 'string' ? options.content : null;
  const preferredLineNumber = Number(options.lineNumber) || 0;
  const requestedSectionId = resolveStructureRequestSectionId(session, preferredLineNumber, options.sectionId);
  if (!selectedFilePath) {
    return normalizeStructureView(null, session?.structureView);
  }
  try {
    const result = content !== null
      ? await api.codeSessionStructurePreview(session.id, {
        channel: DEFAULT_USER_CHANNEL,
        path: selectedFilePath,
        content,
        ...(preferredLineNumber > 0 ? { line: preferredLineNumber } : {}),
        ...(requestedSectionId ? { sectionId: requestedSectionId } : {}),
      })
      : await api.codeSessionStructure(session.id, {
        channel: DEFAULT_USER_CHANNEL,
        path: selectedFilePath,
        ...(preferredLineNumber > 0 ? { line: preferredLineNumber } : {}),
        ...(requestedSectionId ? { sectionId: requestedSectionId } : {}),
      });
    if (!result?.success) {
      return normalizeStructureView({
        path: toRelativePath(selectedFilePath, session.resolvedRoot || session.workspaceRoot || ''),
        supported: false,
        summary: result?.error || 'Structure inspection failed for this file.',
        error: result?.error || 'Structure inspection failed for this file.',
        symbols: [],
      }, session.structureView);
    }
    return reconcileStructureSelection(
      session.structureView,
      normalizeStructureView(result, session.structureView),
      preferredLineNumber,
    );
  } catch (err) {
    return normalizeStructureView({
      path: toRelativePath(selectedFilePath, session.resolvedRoot || session.workspaceRoot || ''),
      supported: false,
      summary: err instanceof Error ? err.message : 'Structure inspection failed for this file.',
      error: err instanceof Error ? err.message : 'Structure inspection failed for this file.',
      symbols: [],
    }, session.structureView);
  }
}

async function refreshStructureScope(session, options = {}) {
  if (!session?.selectedFilePath) {
    return normalizeStructureView(null, session?.structureView);
  }
  const structureView = await loadStructureViewWithOptions(session, options);
  applyStructureViewUpdate(session, structureView, {
    refreshInspector: options.refreshInspector !== false,
  });
  return structureView;
}

function scheduleStructurePreviewRefresh(session, content) {
  if (!session?.id || typeof content !== 'string' || !session.selectedFilePath || !isStructurePreviewablePath(session.selectedFilePath)) {
    return;
  }
  const liveSession = resolveLiveSession(session.id, session) || session;
  const previewState = getStructurePreviewState(liveSession.id, liveSession.selectedFilePath);
  previewState.editVersion += 1;
  previewState.requestSerial += 1;
  previewState.lastError = '';
  const editVersion = previewState.editVersion;
  const requestSerial = previewState.requestSerial;
  const filePath = liveSession.selectedFilePath;

  if (previewState.timer) {
    clearTimeout(previewState.timer);
  }

  previewState.timer = setTimeout(async () => {
    previewState.timer = null;
    const currentSession = resolveLiveSession(liveSession.id, liveSession) || liveSession;
    if (!currentSession.selectedFilePath || currentSession.selectedFilePath !== filePath) return;
    const lineNumber = getCurrentCursorLineNumber();
    try {
      const structureView = await loadStructureViewWithOptions(currentSession, {
        content,
        lineNumber,
      });
      const latestPreviewState = structurePreviewStateBySessionId.get(currentSession.id);
      if (!latestPreviewState) return;
      if (latestPreviewState.requestSerial !== requestSerial || latestPreviewState.editVersion !== editVersion) return;
      if (currentSession.selectedFilePath !== filePath) return;
      latestPreviewState.appliedEditVersion = editVersion;
      latestPreviewState.mode = 'preview';
      latestPreviewState.lastError = '';
      applyStructureViewUpdate(currentSession, structureView, { refreshInspector: isInspectorOpen(currentSession) });
    } catch (err) {
      const latestPreviewState = structurePreviewStateBySessionId.get(currentSession.id);
      if (!latestPreviewState || latestPreviewState.requestSerial !== requestSerial) return;
      latestPreviewState.mode = 'saved';
      latestPreviewState.lastError = 'Live structure preview failed. Showing the last successful analysis.';
      if (isInspectorOpen(currentSession)) {
        refreshInspectorSurface(currentSession);
      }
    }
  }, STRUCTURE_PREVIEW_DEBOUNCE_MS);
}

async function loadAssistantState(session) {
  if (!session?.id) {
    return {
      pendingApprovals: normalizePendingApprovals(session.pendingApprovals, session.pendingApprovals),
      recentJobs: Array.isArray(session.recentJobs) ? session.recentJobs.slice(0, MAX_SESSION_JOBS) : [],
      verification: normalizeVerificationEntries(session.verification, session.verification),
      timelineRuns: normalizeTimelineRuns(session.timelineRuns),
    };
  }
  const [snapshot, timeline] = await Promise.all([
    api.codeSessionGet(session.id, {
      channel: DEFAULT_USER_CHANNEL,
      historyLimit: 1,
    }),
    api.codeSessionTimeline(session.id, {
      channel: DEFAULT_USER_CHANNEL,
      limit: MAX_TIMELINE_RUNS,
    }).catch(() => ({ runs: [] })),
  ]);
  const refreshedSession = mergeCodeSessionRecord(snapshot, resolveLiveSession(session.id, session) || session) || session;

  return {
    pendingApprovals: normalizePendingApprovals(refreshedSession.pendingApprovals, session.pendingApprovals),
    recentJobs: Array.isArray(refreshedSession.recentJobs) ? refreshedSession.recentJobs.slice(0, MAX_SESSION_JOBS) : [],
    verification: normalizeVerificationEntries(refreshedSession.verification, session.verification),
    timelineRuns: normalizeTimelineRuns(timeline?.runs),
  };
}

async function refreshAssistantState(session, { rerender = true, fallbackPendingApprovals = null } = {}) {
  if (!session) return;
  const nextState = await loadAssistantState(session);
  session.pendingApprovals = Array.isArray(nextState.pendingApprovals) && nextState.pendingApprovals.length > 0
    ? nextState.pendingApprovals
    : normalizePendingApprovals(fallbackPendingApprovals, session.pendingApprovals);
  session.recentJobs = nextState.recentJobs;
  session.verification = nextState.verification;
  session.timelineRuns = nextState.timelineRuns;
  saveState(codeState);
  if (rerender) rerenderFromState();
}

function appendChatMessage(session, role, content, meta = {}) {
  if (!session || !content) return;
  session.chat.push({ role, content, ...meta });
}

async function decideCodeApprovalWithRetry(session, approvalId, decision) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await api.codeSessionDecideApproval(session.id, approvalId, {
        decision,
        channel: DEFAULT_USER_CHANNEL,
      });
      if (result?.success === false && isApprovalNotFoundMessage(result.message) && attempt < 4) {
        lastError = new Error(result.message);
      } else {
        return result;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isApprovalNotFoundMessage(lastError.message) || attempt >= 4) {
        throw lastError;
      }
    }

    await delay(250 * (attempt + 1));
    const refreshed = await loadAssistantState(session).catch(() => null);
    if (refreshed) {
      if (Array.isArray(refreshed.pendingApprovals) && refreshed.pendingApprovals.length > 0) {
        session.pendingApprovals = refreshed.pendingApprovals;
      }
      if (Array.isArray(refreshed.recentJobs)) {
        session.recentJobs = refreshed.recentJobs;
      }
      if (Array.isArray(refreshed.timelineRuns)) {
        session.timelineRuns = refreshed.timelineRuns;
      }
      saveState(codeState);
    }
  }

  if (lastError) throw lastError;
  throw new Error(`Approval '${approvalId}' could not be processed.`);
}

async function handleCodeApprovalDecision(session, approvalIds, decision) {
  if (!session || !Array.isArray(approvalIds) || approvalIds.length === 0) return;
  const sessionId = session.id;
  let refreshSessionId = sessionId;

  const approvalResponses = [];
  let continuationPendingApprovals = null;
  for (const id of approvalIds) {
    const liveSession = resolveLiveSession(sessionId, session);
    try {
      const result = await decideCodeApprovalWithRetry(liveSession, id, decision);
      approvalResponses.push(result);
    } catch (err) {
      approvalResponses.push({
        success: false,
        message: err instanceof Error ? err.message : String(err),
        continueConversation: false,
      });
    }
  }

  const immediateMessages = approvalResponses
    .map((result) => result.displayMessage)
    .filter((value) => typeof value === 'string' && value.trim().length > 0);
  const continuedResponses = approvalResponses
    .map((result) => result.continuedResponse)
    .filter((value) => value && typeof value.content === 'string');

  const currentSession = resolveLiveSession(sessionId, session);
  immediateMessages.forEach((message) => appendChatMessage(currentSession, 'agent', message));
  continuedResponses.forEach((response) => appendChatMessage(currentSession, 'agent', response.content));

  if (decision === 'approved' && continuedResponses.length === 0 && approvalResponses.some((result) => result.continueConversation !== false)) {
    const summary = approvalResponses
      .map((result) => result.success ? (result.message || 'approved') : `Failed: ${result.message || 'unknown error'}`)
      .join('; ');
    const continuationMessage = [
      '[Code Approval Continuation]',
      `[User approved the pending tool action(s). Result: ${summary}]`,
      'Please continue the original coding task and adjust if any approved action failed.',
    ].join('\n');
    try {
      const outboundSession = await ensureBackendSession(currentSession || session);
      if (!outboundSession?.id) {
        throw Object.assign(new Error('This coding session is no longer available. Refresh the session list and reopen the workspace before retrying.'), {
          code: 'CODE_SESSION_UNAVAILABLE',
        });
      }
      const outboundSessionId = outboundSession.id;
      refreshSessionId = outboundSessionId;
      const response = await api.codeSessionSendMessage(outboundSessionId, {
        content: continuationMessage,
        channel: DEFAULT_USER_CHANNEL,
      });
      const liveSession = resolveLiveSession(outboundSessionId, outboundSession || currentSession || session);
      if (Array.isArray(response?.metadata?.activeSkills)) {
        liveSession.activeSkills = response.metadata.activeSkills.map((value) => String(value));
      }
      const responsePendingApprovals = Array.isArray(response?.metadata?.pendingApprovals)
        ? response.metadata.pendingApprovals
        : null;
      if (responsePendingApprovals) {
        continuationPendingApprovals = responsePendingApprovals;
        liveSession.pendingApprovals = normalizePendingApprovals(responsePendingApprovals, liveSession.pendingApprovals);
      }
      appendChatMessage(liveSession, 'agent', response.content || 'Approval processed.');
    } catch (err) {
      appendChatMessage(resolveLiveSession(sessionId, currentSession || session), 'error', err instanceof Error ? err.message : String(err));
    }
  }

  const refreshedSession = await refreshSessionSnapshot(refreshSessionId).catch(() => resolveLiveSession(refreshSessionId, session));
  await refreshAssistantState(refreshedSession || session, {
    rerender: false,
    fallbackPendingApprovals: continuationPendingApprovals,
  });
  saveState(codeState);
  rerenderFromState();
  scrollToBottom(currentContainer, '.code-chat__history');
}

// ─── Event binding ─────────────────────────────────────────

function bindEvents(container) {
  // ── Session rail ──

  // ── Icon rail panel switching ──
  container.querySelectorAll('[data-code-panel-switch]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const panel = btn.dataset.codePanelSwitch;
      if (codeState.activePanel === panel) {
        codeState.activePanel = null; // collapse
      } else {
        codeState.activePanel = panel;
        // Auto-refresh git status when switching to git panel
        if (panel === 'git') {
          const session = getActiveSession();
          if (session) void refreshGitStatus(session);
        }
      }
      saveState(codeState);
      rerenderFromState();
    });
  });

  container.querySelector('[data-code-new-session]')?.addEventListener('click', () => {
    codeState.showCreateForm = true;
    codeState.editingSessionId = null;
    saveState(codeState);
    rerenderFromState();
  });

  container.querySelector('[data-code-cancel-create]')?.addEventListener('click', () => {
    codeState.showCreateForm = false;
    closeDirPicker();
    saveState(codeState);
    rerenderFromState();
  });

  container.querySelector('[data-code-cancel-edit]')?.addEventListener('click', () => {
    codeState.editingSessionId = null;
    codeState.editDraft = null;
    closeDirPicker();
    saveState(codeState);
    rerenderFromState();
  });

  container.querySelector('[data-code-clear-history]')?.addEventListener('click', async () => {
    const sessionId = container.querySelector('[data-code-clear-history]')?.dataset?.codeClearHistory;
    const session = codeState.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    if (!confirm(`Clear all conversation history for "${session.title}"? This cannot be undone.`)) return;
    session.chat = [];
    session.pendingResponse = null;
    saveState(codeState);
    try {
      await api.codeSessionResetConversation(session.id, { channel: DEFAULT_USER_CHANNEL });
    } catch {
      // Keep local clear even if server reset fails.
    }
    const refreshedSession = await refreshSessionSnapshot(session.id).catch(() => session);
    await refreshAssistantState(refreshedSession || session, { rerender: false });
    codeState.editingSessionId = null;
    codeState.editDraft = null;
    saveState(codeState);
    rerenderFromState();
  });

  // ── Git panel ──
  container.querySelector('[data-code-git-refresh]')?.addEventListener('click', async () => {
    const session = getActiveSession();
    if (session) await refreshGitStatus(session);
  });

  container.querySelector('[data-code-git-init]')?.addEventListener('click', async () => {
    const session = getActiveSession();
    if (!session) return;
    await runGitAction(session, 'init');
  });

  container.querySelector('[data-code-git-commit-msg]')?.addEventListener('input', (e) => {
    const session = getActiveSession();
    if (session) session.gitCommitMessage = e.currentTarget.value;
    saveState(codeState);
  });

  container.querySelector('[data-code-git-commit]')?.addEventListener('click', async () => {
    const session = getActiveSession();
    if (!session) return;
    const msg = (session.gitCommitMessage || '').trim();
    if (!msg) return;
    await runGitAction(session, 'commit', { message: msg });
    session.gitCommitMessage = '';
    saveState(codeState);
  });

  container.querySelector('[data-code-git-pull]')?.addEventListener('click', async () => {
    const session = getActiveSession();
    if (session) await runGitAction(session, 'pull');
  });

  container.querySelector('[data-code-git-push]')?.addEventListener('click', async () => {
    const session = getActiveSession();
    if (session) await runGitAction(session, 'push');
  });

  container.querySelector('[data-code-git-fetch]')?.addEventListener('click', async () => {
    const session = getActiveSession();
    if (session) await runGitAction(session, 'fetch');
  });

  container.querySelectorAll('[data-code-git-stage]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const session = getActiveSession();
      if (session) await runGitAction(session, 'stage', { path: btn.dataset.codeGitStage });
    });
  });

  container.querySelectorAll('[data-code-git-unstage]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const session = getActiveSession();
      if (session) await runGitAction(session, 'unstage', { path: btn.dataset.codeGitUnstage });
    });
  });

  container.querySelectorAll('[data-code-git-discard]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const path = btn.dataset.codeGitDiscard;
      if (!confirm(`Discard changes to ${path}? This cannot be undone.`)) return;
      const session = getActiveSession();
      if (session) await runGitAction(session, 'discard', { path });
    });
  });

  container.querySelectorAll('[data-code-git-file-diff]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const session = getActiveSession();
      if (!session) return;
      const filePath = btn.dataset.codeGitFileDiff;
      const fullPath = joinWorkspacePath(session.resolvedRoot || session.workspaceRoot || '.', filePath);
      openFileInTab(session, fullPath);
      session.showDiff = true;
      saveState(codeState);
      await refreshFileView(session);
      rerenderFromState();
    });
  });

  // Create form
  const createForm = container.querySelector('[data-code-session-form]');
  createForm?.addEventListener('input', (event) => {
    const form = event.currentTarget;
    codeState.createDraft = {
      title: form.elements.title.value,
      workspaceRoot: form.elements.workspaceRoot.value,
      agentId: form.elements.agentId?.value || '',
    };
    saveState(codeState);
  });

  createForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const title = form.elements.title.value.trim() || 'Coding Session';
    const workspaceRoot = form.elements.workspaceRoot.value.trim() || '.';
    const agentId = form.elements.agentId?.value || '';
    const snapshot = await api.codeSessionCreate({
      title,
      workspaceRoot,
      agentId: agentId || null,
      channel: DEFAULT_USER_CHANNEL,
      attach: true,
    });
    const session = applyCodeSessionSnapshot(snapshot);
    codeState.activeSessionId = session?.id || null;
    codeState.showCreateForm = false;
    codeState.createDraft = { title: '', workspaceRoot: '.', agentId: '' };
    treeCache.clear();
    cachedFileView = { source: '', diff: '', error: null };
    closeDirPicker();
    saveState(codeState);
    rerenderFromState();
    if (session) void refreshSessionData(session);
  });

  // Edit form
  const editForm = container.querySelector('[data-code-edit-session-form]');
  editForm?.addEventListener('input', (event) => {
    const form = event.currentTarget;
    codeState.editDraft = {
      ...codeState.editDraft,
      title: form.elements.title.value,
      workspaceRoot: form.elements.workspaceRoot.value,
      workspaceTrustOverrideAccepted: !!form.elements.workspaceTrustOverrideAccepted?.checked,
    };
    saveState(codeState);
  });

  editForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = codeState.sessions.find((s) => s.id === codeState.editingSessionId);
    if (!session) return;
    const form = event.currentTarget;
    const nextTitle = form.elements.title.value.trim() || session.title;
    const newRoot = form.elements.workspaceRoot.value.trim() || session.workspaceRoot;
    const workspaceTrustOverrideAccepted = !!form.elements.workspaceTrustOverrideAccepted?.checked;
    if (newRoot !== session.workspaceRoot) {
      await Promise.all((session.terminalTabs || []).map((tab) => closeTerminal(tab)));
      session.terminalTabs = (session.terminalTabs || []).map((tab, index) => ({
        ...tab,
        runtimeTerminalId: null,
        connecting: false,
        connected: false,
        output: index === 0 ? '' : tab.output || '',
      }));
      treeCache.clear();
    }
    const snapshot = await api.codeSessionUpdate(session.id, {
      title: nextTitle,
      workspaceRoot: newRoot,
      channel: DEFAULT_USER_CHANNEL,
      uiState: {
        ...buildCodeSessionUiState(session),
        currentDirectory: newRoot !== session.workspaceRoot
          ? newRoot
          : (session.currentDirectory || session.resolvedRoot || session.workspaceRoot || '.'),
        selectedFilePath: newRoot !== session.workspaceRoot ? null : session.selectedFilePath,
      },
      workState: {
        workspaceTrustReview: workspaceTrustOverrideAccepted ? { decision: 'accepted' } : null,
      },
    });
    applyCodeSessionSnapshot(snapshot);
    codeState.editingSessionId = null;
    codeState.editDraft = null;
    closeDirPicker();
    saveState(codeState);
    rerenderFromState();
    if (session.id === codeState.activeSessionId) {
      void refreshSessionData(session);
    }
  });

  // Edit session button
  container.querySelectorAll('[data-code-edit-session]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const sessionId = button.dataset.codeEditSession;
      const session = codeState.sessions.find((s) => s.id === sessionId);
      if (!session) return;
      codeState.editingSessionId = sessionId;
      codeState.showCreateForm = false;
      codeState.editDraft = {
        title: session.title,
        workspaceRoot: session.workspaceRoot,
        workspaceTrustOverrideAccepted: isWorkspaceTrustReviewActive(session),
      };
      saveState(codeState);
      rerenderFromState();
    });
  });

  // Browse button (dir picker)
  container.querySelector('[data-code-browse-dir]')?.addEventListener('click', () => {
    const currentInput = container.querySelector('[name="workspaceRoot"]');
    const activeSession = getActiveSession();
    const startPath = currentInput?.value?.trim()
      || activeSession?.resolvedRoot
      || activeSession?.workspaceRoot
      || '.';
    void openDirPicker(startPath);
  });

  // Dir picker navigation
  container.querySelectorAll('[data-code-dirpick-navigate]').forEach((button) => {
    button.addEventListener('click', () => {
      void navigateDirPicker(button.dataset.codeDirpickNavigate);
    });
  });

  // Dir picker select
  container.querySelector('[data-code-dirpick-select]')?.addEventListener('click', () => {
    const input = container.querySelector('[name="workspaceRoot"]');
    if (input && codeState.dirPickerPath) {
      input.value = codeState.dirPickerPath;
      // Update the draft
      if (codeState.editingSessionId) {
        codeState.editDraft = { ...codeState.editDraft, workspaceRoot: codeState.dirPickerPath };
      } else {
        codeState.createDraft = { ...codeState.createDraft, workspaceRoot: codeState.dirPickerPath };
      }
    }
    closeDirPicker();
  });

  container.querySelector('[data-code-dirpick-cancel]')?.addEventListener('click', () => {
    closeDirPicker();
  });

  // Switch session
  container.querySelectorAll('[data-code-session-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const prevId = codeState.activeSessionId;
      codeState.activeSessionId = button.dataset.codeSessionId;
      if (prevId === codeState.activeSessionId) return;
      treeCache.clear();
      cachedFileView = { source: '', diff: '', error: null };
      disposeAllModels();
      saveState(codeState);
      rerenderFromState();
      const session = getActiveSession();
      if (session) {
        void api.codeSessionAttach(session.id, { channel: DEFAULT_USER_CHANNEL }).catch(() => {});
        void refreshSessionData(session);
      }
    });
  });

  // Delete session
  container.querySelectorAll('[data-code-delete-session]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const deletedId = button.dataset.codeDeleteSession;
      const deletedSession = codeState.sessions.find((session) => session.id === deletedId);
      if (deletedSession) {
        await Promise.all((deletedSession.terminalTabs || []).map((tab) => closeTerminal(tab)));
      }
      if (deletedId) {
        await api.codeSessionDelete(deletedId, { channel: DEFAULT_USER_CHANNEL }).catch(() => null);
        pendingSessionUiStateById.delete(deletedId);
        editorSearchStateBySessionId.delete(deletedId);
      }
      codeState.sessions = codeState.sessions.filter((session) => session.id !== deletedId);
      const wasActive = codeState.activeSessionId === deletedId;
      codeState.activeSessionId = codeState.sessions[0]?.id || null;
      saveState(codeState);
      if (wasActive) {
        treeCache.clear();
        cachedFileView = { source: '', diff: '', error: null };
        disposeAllModels();
        rerenderFromState();
        const session = getActiveSession();
        if (session) void refreshSessionData(session);
      } else {
        rerenderFromState();
      }
    });
  });

  // ── Explorer (tree) ──

  container.querySelector('[data-code-refresh-explorer]')?.addEventListener('click', () => {
    const session = getActiveSession();
    if (session) void refreshTree(session);
  });

  container.querySelectorAll('[data-code-tree-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const session = getActiveSession();
      if (!session) return;
      const dirPath = button.dataset.codeTreeToggle;
      if (!session.expandedDirs) session.expandedDirs = [];
      const idx = session.expandedDirs.indexOf(dirPath);
      if (idx >= 0) {
        session.expandedDirs.splice(idx, 1);
      } else {
        session.expandedDirs.push(dirPath);
        // Lazy-load if not cached
        if (!treeCache.has(dirPath)) {
          saveState(codeState);
          void (async () => {
            const data = await loadTreeDir(session, dirPath);
            treeCache.set(dirPath, data);
            rerenderFromState();
          })();
          return;
        }
      }
      saveState(codeState);
      queueSessionPersist(session);
      rerenderFromState();
    });
  });

  container.querySelectorAll('[data-code-tree-file]').forEach((button) => {
    button.addEventListener('click', () => {
      const session = getActiveSession();
      if (!session) return;
      const filePath = button.dataset.codeTreeFile || null;
      if (!filePath) return;
      // Save current Monaco view state before switching
      const currentTab = getActiveTab(session);
      if (currentTab) {
        saveMonacoViewState(currentTab.filePath);
        syncActiveEditorStateFromMonaco(session);
      }
      openFileInTab(session, filePath);
      session.showDiff = false;
      saveState(codeState);
      queueSessionPersist(session);
      void refreshFileView(session);
    });
  });

  container.querySelector('[data-code-refresh-file]')?.addEventListener('click', () => {
    const session = getActiveSession();
    if (!session) return;
    const tab = getActiveTab(session);
    if (tab) { tab.dirty = false; tab.content = null; }
    void refreshFileView(session);
  });

  container.querySelector('[data-code-toggle-diff]')?.addEventListener('click', () => {
    const session = getActiveSession();
    if (!session) return;
    session.showDiff = !session.showDiff;
    saveState(codeState);
    queueSessionPersist(session);
    rerenderFromState();
  });

  // ── Editor tabs ──

  container.querySelectorAll('[data-code-tab-index]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      // Ignore if the close button was clicked
      if (e.target.closest('[data-code-tab-close]')) return;
      const session = getActiveSession();
      if (!session) return;
      const idx = parseInt(btn.dataset.codeTabIndex, 10);
      if (idx === session.activeTabIndex) return;
      // Save current Monaco view state before switching
      const currentTab = getActiveTab(session);
      if (currentTab) {
        saveMonacoViewState(currentTab.filePath);
        syncActiveEditorStateFromMonaco(session);
      }
      session.activeTabIndex = idx;
      session.selectedFilePath = session.openTabs[idx]?.filePath || null;
      session.showDiff = false;
      saveState(codeState);
      queueSessionPersist(session);
      void refreshFileView(session);
    });
  });

  container.querySelectorAll('[data-code-tab-close]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const session = getActiveSession();
      if (!session) return;
      const idx = parseInt(btn.dataset.codeTabClose, 10);
      const closingTab = session.openTabs[idx];
      closeTab(session, idx);
      // Dispose the Monaco model for the closed tab
      if (closingTab) disposeModel(closingTab.filePath);
      saveState(codeState);
      queueSessionPersist(session);
      if (session.selectedFilePath) {
        void refreshFileView(session);
      } else {
        cachedFileView = { source: '', diff: '', error: null };
        disposeMonacoEditors();
        rerenderFromState();
      }
    });
  });

  // ── Editor (Monaco handles its own events — Ctrl+S, dirty tracking are in mountMonacoEditor) ──

  // Theme selector
  container.querySelector('[data-code-theme-select]')?.addEventListener('change', (e) => {
    const themeId = e.target.value;
    currentMonacoTheme = themeId;
    localStorage.setItem(MONACO_THEME_STORAGE_KEY, themeId);
    if (window.monaco) {
      window.monaco.editor.setTheme(themeId);
    }
  });

  container.querySelector('[data-code-editor-search-input]')?.addEventListener('input', (event) => {
    const session = getActiveSession();
    if (!session) return;
    setEditorSearchQuery(session, event.target.value, { reveal: true });
  });
  container.querySelector('[data-code-editor-search-input]')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      navigateEditorSearch(getActiveSession(), event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      const session = getActiveSession();
      if (!session) return;
      setEditorSearchQuery(session, '', { reveal: false });
    }
  });
  container.querySelector('[data-code-editor-search-prev]')?.addEventListener('click', () => {
    navigateEditorSearch(getActiveSession(), -1);
  });
  container.querySelector('[data-code-editor-search-next]')?.addEventListener('click', () => {
    navigateEditorSearch(getActiveSession(), 1);
  });
  container.querySelector('[data-code-editor-search-clear]')?.addEventListener('click', () => {
    const session = getActiveSession();
    if (!session) return;
    setEditorSearchQuery(session, '', { reveal: false });
  });

  container.querySelector('[data-code-save-file]')?.addEventListener('click', () => saveEditorFile());
  container.querySelector('[data-code-open-structure]')?.addEventListener('click', async () => {
    const session = getActiveSession();
    if (!session) return;
    const lineNumber = getCurrentViewportAnchorLineNumber();
    if (
      !session.structureView
      || !isStructureViewCurrentFile(session)
      || !session.structureView.supported
      || isSectionedStructureView(session.structureView)
    ) {
      await refreshStructureScope(session, {
        lineNumber,
        sectionId: '',
        refreshInspector: false,
      }).catch(() => {});
    }
    if (focusCurrentEditorSymbol(session, 'investigate')) return;
    openInspector(session, 'investigate');
    rerenderFromState();
  });

  // ── Terminals ──

  container.querySelector('[data-code-toggle-terminal-collapse]')?.addEventListener('click', () => {
    const session = getActiveSession();
    if (!session) return;
    session.terminalCollapsed = !session.terminalCollapsed;
    saveState(codeState);
    queueSessionPersist(session);
    rerenderFromState();
  });

  container.querySelector('[data-code-new-terminal]')?.addEventListener('click', () => {
    const session = getActiveSession();
    if (!session) return;
    if (session.terminalTabs.length >= MAX_TERMINAL_PANES) return;
    const tab = createTerminalTab(`Terminal ${session.terminalTabs.length + 1}`, getDefaultShell());
    session.terminalTabs.push(tab);
    pendingTerminalFocusTabId = tab.id;
    saveState(codeState);
    queueSessionPersist(session);
    rerenderFromState();
    void ensureTerminalConnected(session, tab);
  });

  container.querySelectorAll('[data-code-close-terminal]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const session = getActiveSession();
      if (!session) return;
      if (session.terminalTabs.length <= 1) return;
      const tabId = button.dataset.codeCloseTerminal;
      const tab = session.terminalTabs.find((candidate) => candidate.id === tabId);
      if (tab) {
        await closeTerminal(tab);
      }
      session.terminalTabs = session.terminalTabs.filter((candidate) => candidate.id !== tabId);
      saveState(codeState);
      queueSessionPersist(session);
      rerenderFromState();
    });
  });

  // Shell type selector
  container.querySelectorAll('[data-code-shell-select]').forEach((select) => {
    select.addEventListener('change', async () => {
      const session = getActiveSession();
      if (!session) return;
      const tabId = select.dataset.codeShellSelect;
      const tab = session.terminalTabs.find((t) => t.id === tabId);
      if (tab) {
        await closeTerminal(tab);
        tab.shell = normalizeTerminalShell(select.value);
        tab.output = '';
        tab.openFailed = false;
        tab.openError = '';
        saveState(codeState);
        queueSessionPersist(session);
        rerenderFromState();
        void ensureTerminalConnected(session, tab);
      }
    });
  });

  // ── Assistant tabs ──

  container.querySelectorAll('[data-code-assistant-tab], [data-code-switch-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const session = getActiveSession();
      if (!session) return;
      const nextTab = button.dataset.codeAssistantTab || button.dataset.codeSwitchTab;
      if (!isAssistantTab(nextTab)) return;
      session.activeAssistantTab = nextTab;
      // Clear badge counts when the user opens the activity tab
      if (nextTab === 'activity') {
        session.viewedApprovalCount = (session.pendingApprovals || []).length;
        session.viewedTaskCount = getTaskBadgeCount(session);
        session.viewedCheckCount = getCheckBadgeCount(session);
      }
      saveState(codeState);
      queueSessionPersist(session);
      rerenderFromState();
    });
  });
  bindInspectorEvents(container);

  container.querySelectorAll('[data-code-approval-id][data-code-approval-decision]').forEach((button) => {
    button.addEventListener('click', async () => {
      const session = getActiveSession();
      if (!session) return;
      const approvalId = button.dataset.codeApprovalId;
      const decision = button.dataset.codeApprovalDecision;
      if (!approvalId || (decision !== 'approved' && decision !== 'denied')) return;
      button.setAttribute('disabled', 'true');
      try {
        await handleCodeApprovalDecision(session, [approvalId], decision);
      } finally {
        button.removeAttribute('disabled');
      }
    });
  });

  // ── Inline approvals in chat ──

  container.querySelectorAll('[data-code-inline-approve], [data-code-inline-deny]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const session = getActiveSession();
      if (!session) return;
      const approvalId = btn.dataset.codeInlineApprove || btn.dataset.codeInlineDeny;
      const decision = btn.dataset.codeInlineApprove ? 'approved' : 'denied';
      if (!approvalId) return;
      btn.setAttribute('disabled', 'true');
      // Disable the sibling button too
      const parent = btn.closest('.code-message__approval-actions');
      if (parent) parent.querySelectorAll('button').forEach((b) => b.setAttribute('disabled', 'true'));
      try {
        await handleCodeApprovalDecision(session, [approvalId], decision);
      } finally {
        btn.removeAttribute('disabled');
      }
    });
  });

  // ── Chat ──

  container.querySelector('[data-code-chat-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = getActiveSession();
    if (!session) return;
    const sessionId = session.id;
    const form = event.currentTarget;
    const textarea = form.elements.message;
    const message = textarea.value.trim();
    if (!message) return;
    session.chatDraft = '';
    session.draftFileReferences = extractCodeChatFileReferences(session, textarea.value);
    session.pendingResponse = { message, startedAt: Date.now() };
    activeChatReferencePicker = null;
    saveState(codeState);
    rerenderFromState();
    scrollToBottom(currentContainer, '.code-chat__history');

    try {
      const outboundSession = await ensureBackendSession(session);
      if (!outboundSession?.id) {
        throw Object.assign(new Error('This coding session is no longer available. Refresh the session list and reopen the workspace before sending another message.'), {
          code: 'CODE_SESSION_UNAVAILABLE',
        });
      }
      const outboundSessionId = outboundSession.id;
      const fileReferences = normalizeDraftFileReferences(session.draftFileReferences);
      const response = await api.codeSessionSendMessage(outboundSessionId, {
        content: message,
        channel: DEFAULT_USER_CHANNEL,
        ...(fileReferences.length > 0
          ? {
            metadata: {
              codeContext: {
                fileReferences: fileReferences.map((pathValue) => ({ path: pathValue })),
              },
            },
          }
          : {}),
      });
      const liveSession = resolveLiveSession(outboundSessionId, outboundSession || session);
      liveSession.chatDraft = '';
      liveSession.draftFileReferences = [];
      liveSession.activeSkills = Array.isArray(response?.metadata?.activeSkills)
        ? response.metadata.activeSkills.map((value) => String(value))
        : [];
      const responsePendingApprovals = Array.isArray(response?.metadata?.pendingApprovals)
        ? response.metadata.pendingApprovals
        : null;
      if (responsePendingApprovals) {
        liveSession.pendingApprovals = normalizePendingApprovals(responsePendingApprovals, liveSession.pendingApprovals);
      }
      appendChatMessage(liveSession, 'user', message);
      liveSession.pendingResponse = null;
      const responseSource = response?.metadata?.responseSource || null;
      appendChatMessage(liveSession, 'agent', response.content || 'No response content.', { responseSource });
      // Refresh file view after assistant response — the assistant may have edited the open file.
      const activeEditorTab = getActiveTab(liveSession);
      if (activeEditorTab) { activeEditorTab.dirty = false; activeEditorTab.content = null; }
      const refreshedSession = await refreshSessionSnapshot(outboundSessionId).catch(() => resolveLiveSession(outboundSessionId, liveSession));
      await refreshAssistantState(refreshedSession || liveSession, {
        rerender: false,
        fallbackPendingApprovals: responsePendingApprovals,
      });
      if (liveSession.selectedFilePath) {
        invalidateStructurePreviewState(liveSession.id, liveSession.selectedFilePath || '');
        const [fileView, structureView] = await Promise.all([
          loadFileView(liveSession),
          loadStructureView(liveSession),
        ]);
        cachedFileView = fileView;
        liveSession.structureView = structureView;
      }
    } catch (err) {
      const liveSession = resolveLiveSession(sessionId, session);
      liveSession.pendingResponse = null;
      if (isCodeSessionUnavailableError(err)) {
        liveSession.chatDraft = message;
        liveSession.draftFileReferences = extractCodeChatFileReferences(liveSession, textarea.value);
        textarea.value = message;
        appendChatMessage(liveSession, 'error', err instanceof Error ? err.message : String(err));
      } else {
        appendChatMessage(liveSession, 'user', message);
        appendChatMessage(liveSession, 'error', err instanceof Error ? err.message : String(err));
      }
    }
    saveState(codeState);
    rerenderFromState();
    scrollToBottom(currentContainer, '.code-chat__history');
  });

  container.querySelector('[data-code-provider-select]')?.addEventListener('change', async (e) => {
    const session = getActiveSession();
    if (!session) return;
    const nextAgentId = e.currentTarget.value || null;
    session.agentId = nextAgentId;
    saveState(codeState);
    try {
      await api.codeSessionUpdate(session.id, {
        agentId: nextAgentId,
        channel: DEFAULT_USER_CHANNEL,
      });
    } catch {
      // Best-effort persist — local state already updated.
    }
  });

  container.querySelector('[data-code-reset-chat]')?.addEventListener('click', async () => {
    const session = getActiveSession();
    if (!session) return;
    session.chat = [];
    session.pendingResponse = null;
    saveState(codeState);
    try {
      await api.codeSessionResetConversation(session.id, { channel: DEFAULT_USER_CHANNEL });
    } catch {
      // Keep local reset even if server reset fails.
    }
    const refreshedSession = await refreshSessionSnapshot(session.id).catch(() => session);
    await refreshAssistantState(refreshedSession || session, { rerender: false });
    rerenderFromState();
  });

  const codeChatInput = container.querySelector('[data-code-chat-form] textarea[name="message"]');
  const codeChatForm = codeChatInput?.form || container.querySelector('[data-code-chat-form]');
  if (codeChatForm && codeChatInput) {
    updateCodeChatReferenceList(codeChatForm, getActiveSession()?.draftFileReferences || []);
    updateCodeChatReferencePicker(codeChatForm, null);
  }
  codeChatInput?.addEventListener('keydown', (event) => {
    const input = event.currentTarget;
    const form = input instanceof HTMLTextAreaElement ? input.form : null;
    const session = getActiveSession();
    if (!form || !session) return;
    if (activeChatReferencePicker?.sessionId === session.id) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const maxIndex = activeChatReferencePicker.suggestions.length - 1;
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        activeChatReferencePicker.selectedIndex = Math.max(0, Math.min(maxIndex, activeChatReferencePicker.selectedIndex + delta));
        updateCodeChatReferencePicker(form, activeChatReferencePicker);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
        event.preventDefault();
        const selected = activeChatReferencePicker.suggestions[activeChatReferencePicker.selectedIndex];
        if (selected) {
          applyCodeChatReferenceSuggestion(session, form, input, selected.path);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        activeChatReferencePicker = null;
        updateCodeChatReferencePicker(form, null);
        return;
      }
    }
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    event.preventDefault();
    if (event.repeat) return;
    if (!form) return;
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return;
    }
    form.querySelector('button[type="submit"]')?.click();
  });

  codeChatInput?.addEventListener('input', (event) => {
    const session = getActiveSession();
    if (!session) return;
    const input = event.currentTarget;
    const form = input instanceof HTMLTextAreaElement ? input.form : null;
    if (!form || !(input instanceof HTMLTextAreaElement)) return;
    syncCodeChatDraftReferences(session, form, input);
    refreshCodeChatReferencePicker(session, form, input);
    saveState(codeState);
  });

  codeChatInput?.addEventListener('click', (event) => {
    const session = getActiveSession();
    const input = event.currentTarget;
    const form = input instanceof HTMLTextAreaElement ? input.form : null;
    if (!session || !form || !(input instanceof HTMLTextAreaElement)) return;
    refreshCodeChatReferencePicker(session, form, input);
  });

  codeChatInput?.addEventListener('keyup', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === 'Tab') return;
    const session = getActiveSession();
    const input = event.currentTarget;
    const form = input instanceof HTMLTextAreaElement ? input.form : null;
    if (!session || !form || !(input instanceof HTMLTextAreaElement)) return;
    refreshCodeChatReferencePicker(session, form, input);
  });

  codeChatInput?.addEventListener('blur', (event) => {
    const input = event.currentTarget;
    const form = input instanceof HTMLTextAreaElement ? input.form : null;
    if (!form) return;
    setTimeout(() => {
      if (document.activeElement && form.contains(document.activeElement)) return;
      activeChatReferencePicker = null;
      updateCodeChatReferencePicker(form, null);
    }, 0);
  });

  codeChatForm?.addEventListener('mousedown', (event) => {
    const button = event.target.closest('[data-code-chat-ref-suggestion]');
    const session = getActiveSession();
    if (!button || !session || !(codeChatInput instanceof HTMLTextAreaElement)) return;
    event.preventDefault();
    applyCodeChatReferenceSuggestion(session, codeChatForm, codeChatInput, button.dataset.codeChatRefSuggestion);
  });
}

// ─── State management ──────────────────────────────────────

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {
      sessions: [],
      activeSessionId: null,
      showCreateForm: false,
      activePanel: 'sessions',
      createDraft: { title: '', workspaceRoot: '.', agentId: '' },
    };
  } catch {
    return {
      sessions: [],
      activeSessionId: null,
      showCreateForm: false,
      activePanel: 'sessions',
      createDraft: { title: '', workspaceRoot: '.', agentId: '' },
    };
  }
}

function normalizeState(raw, agents) {
  const next = {
    sessions: Array.isArray(raw?.sessions) ? raw.sessions.map((session) => {
      const terminalTabs = normalizeTerminalTabs(session.terminalTabs);
      return {
        id: session.id || crypto.randomUUID(),
        title: session.title || 'Coding Session',
        workspaceRoot: session.workspaceRoot || '.',
        resolvedRoot: session.resolvedRoot || null,
        currentDirectory: session.currentDirectory || null,
        selectedFilePath: session.selectedFilePath || null,
        showDiff: !!session.showDiff,
        openTabs: Array.isArray(session.openTabs) ? session.openTabs.map((t) => ({
          filePath: t.filePath || '',
          dirty: false,
          content: null,
        })).filter((t) => t.filePath) : [],
        activeTabIndex: typeof session.activeTabIndex === 'number' ? session.activeTabIndex : -1,
        agentId: resolveAgentId(session.agentId, agents),
        status: session.status || 'idle',
        conversationUserId: session.conversationUserId || '',
        conversationChannel: session.conversationChannel || 'code-session',
        terminalTabs,
        terminalCollapsed: !!session.terminalCollapsed,
        expandedDirs: Array.isArray(session.expandedDirs) ? session.expandedDirs : [],
        chat: Array.isArray(session.chat) ? session.chat.slice(-30) : [],
        chatDraft: session.chatDraft || '',
        draftFileReferences: normalizeDraftFileReferences(session.draftFileReferences),
        pendingApprovals: Array.isArray(session.pendingApprovals) ? session.pendingApprovals : [],
        activeSkills: Array.isArray(session.activeSkills) ? session.activeSkills : [],
        recentJobs: Array.isArray(session.recentJobs) ? session.recentJobs.slice(0, MAX_SESSION_JOBS) : [],
        verification: normalizeVerificationEntries(session.verification),
        lastExplorerPath: session.lastExplorerPath || null,
        focusSummary: session.focusSummary || '',
        planSummary: session.planSummary || '',
        compactedSummary: session.compactedSummary || '',
        workspaceProfile: normalizeWorkspaceProfile(session.workspaceProfile),
        workspaceTrust: normalizeWorkspaceTrust(session.workspaceTrust),
        workspaceTrustReview: normalizeWorkspaceTrustReview(session.workspaceTrustReview),
        workspaceMap: normalizeWorkspaceMap(session.workspaceMap),
        workingSet: normalizeWorkspaceWorkingSet(session.workingSet),
        structureView: normalizeStructureView(session.structureView, session.structureView),
        activeAssistantTab: normalizeAssistantTabValue(session.activeAssistantTab),
        inspectorOpen: false,
        inspectorDetached: false,
        inspectorTab: normalizeInspectorTabValue(session.inspectorTab),
        gitState: session.gitState || null,
        gitCommitMessage: session.gitCommitMessage || '',
        editorDirty: false,
        editorContent: null,
      };
    }) : [],
    activeSessionId: raw?.activeSessionId || null,
    showCreateForm: !!raw?.showCreateForm,
    activePanel: raw?.activePanel || (raw?.railCollapsed ? null : 'sessions'),
    editingSessionId: raw?.editingSessionId || null,
    editDraft: raw?.editDraft || null,
    createDraft: {
      title: raw?.createDraft?.title || '',
      workspaceRoot: raw?.createDraft?.workspaceRoot || '.',
      agentId: raw?.createDraft?.agentId || '',
    },
  };

  if (!next.sessions.some((session) => session.id === next.activeSessionId)) {
    next.activeSessionId = next.sessions[0]?.id || null;
  }

  return next;
}

function normalizeTerminalTabs(value, existing = []) {
  const previousById = new Map(
    (Array.isArray(existing) ? existing : [])
      .filter((tab) => tab && typeof tab.id === 'string')
      .map((tab) => [tab.id, tab]),
  );
  const userTabs = Array.isArray(value) && value.length > 0
    ? value
      .map((tab) => ({
        ...(previousById.get(tab.id) || {}),
        id: tab.id && tab.id !== 'agent' ? tab.id : crypto.randomUUID(),
        name: tab.name && tab.name !== 'Agent' ? tab.name : 'Terminal 1',
        shell: normalizeTerminalShell(tab.shell || previousById.get(tab.id)?.shell || getDefaultShell()),
        output: typeof previousById.get(tab.id)?.output === 'string'
          ? trimTerminalOutput(previousById.get(tab.id).output)
          : trimTerminalOutput(typeof tab.output === 'string'
            ? tab.output
            : Array.isArray(tab.history) ? tab.history.join('\n\n') : ''),
        runtimeTerminalId: typeof previousById.get(tab.id)?.runtimeTerminalId === 'string' && previousById.get(tab.id).runtimeTerminalId
          ? previousById.get(tab.id).runtimeTerminalId
          : null,
        connecting: !!previousById.get(tab.id)?.connecting,
        connected: !!previousById.get(tab.id)?.connected,
        openFailed: !!previousById.get(tab.id)?.openFailed,
        openError: typeof previousById.get(tab.id)?.openError === 'string' ? previousById.get(tab.id).openError : '',
      }))
    : [];
  return userTabs.length > 0 ? userTabs : [createTerminalTab('Terminal 1', getDefaultShell())];
}

function saveState(state) {
  const persistable = {
    ...state,
    sessions: Array.isArray(state.sessions)
      ? state.sessions.map((session) => {
        const { pendingResponse: _pendingResponse, ...persistedSession } = session;
        return {
          ...persistedSession,
          terminalTabs: Array.isArray(session.terminalTabs)
            ? session.terminalTabs.map((tab) => ({
              id: tab.id,
              name: tab.name,
              shell: normalizeTerminalShell(tab.shell),
              output: typeof tab.output === 'string' ? trimTerminalOutput(tab.output) : '',
              openError: typeof tab.openError === 'string' ? tab.openError : '',
            }))
            : [],
          recentJobs: Array.isArray(session.recentJobs) ? session.recentJobs.slice(0, MAX_SESSION_JOBS) : [],
          verification: normalizeVerificationEntries(session.verification),
          timelineRuns: [],
          workspaceProfile: normalizeWorkspaceProfile(session.workspaceProfile),
          workspaceTrust: normalizeWorkspaceTrust(session.workspaceTrust),
          workspaceTrustReview: normalizeWorkspaceTrustReview(session.workspaceTrustReview),
          workspaceMap: normalizeWorkspaceMap(session.workspaceMap),
          workingSet: normalizeWorkspaceWorkingSet(session.workingSet),
          structureView: normalizeStructureView(session.structureView, session.structureView),
          activeAssistantTab: normalizeAssistantTabValue(session.activeAssistantTab),
          inspectorOpen: false,
          inspectorDetached: false,
          inspectorTab: normalizeInspectorTabValue(session.inspectorTab),
          draftFileReferences: normalizeDraftFileReferences(session.draftFileReferences),
        };
      })
      : [],
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
}

function getActiveSession() {
  return codeState.sessions.find((session) => session.id === codeState.activeSessionId) || null;
}

function getSessionById(sessionId) {
  if (!sessionId) return null;
  return codeState.sessions.find((session) => session.id === sessionId) || null;
}

function resolveLiveSession(sessionOrId, fallback = null) {
  if (!sessionOrId) return fallback;
  const sessionId = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id;
  return getSessionById(sessionId) || fallback || (typeof sessionOrId === 'string' ? null : sessionOrId);
}

function createTerminalTab(name, shell) {
  return {
    id: crypto.randomUUID(),
    name,
    shell: normalizeTerminalShell(shell),
    output: '',
    runtimeTerminalId: null,
    connecting: false,
    connected: false,
    openFailed: false,
    openError: '',
  };
}

// ─── Path and string utilities ─────────────────────────────

function resolveAgentId(agentId, agents) {
  if (!agentId) return null;
  return agents.some((agent) => agent.id === agentId) ? agentId : null;
}

function isCodeSelectableAgent(agent) {
  if (!agent || agent.canChat === false) return false;
  if (agent.internal !== true) return true;
  return agent.routingRole === 'local' || agent.routingRole === 'external';
}

function getCodeProviderOptions(agents) {
  const selectableAgents = Array.isArray(agents) ? agents.filter(isCodeSelectableAgent) : [];
  const localAgent = selectableAgents.find((agent) => agent.routingRole === 'local');
  const externalAgent = selectableAgents.find((agent) => agent.routingRole === 'external');

  if (localAgent || externalAgent) {
    return [
      { value: '', label: 'Auto' },
      ...(localAgent ? [{ value: localAgent.id, label: 'Local' }] : []),
      ...(externalAgent ? [{ value: externalAgent.id, label: 'External' }] : []),
    ];
  }

  return [
    { value: '', label: 'Auto' },
    ...selectableAgents
      .filter((agent) => agent.internal !== true)
      .map((agent) => ({ value: agent.id, label: agent.name || agent.id })),
  ];
}

function joinWorkspacePath(base, child) {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  if (base.endsWith(separator)) return `${base}${child}`;
  return `${base}${separator}${child}`;
}

function parentPath(value) {
  if (!value) return '.';
  const normalized = value.replace(/[\\/]+$/, '') || value;
  if (/^[a-zA-Z]:$/.test(normalized) || normalized === '/' || normalized === '\\\\') {
    return normalized;
  }
  const separator = normalized.includes('\\') && !normalized.includes('/') ? '\\' : '/';
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (index < 0) return normalized;
  if (index === 0) return separator;
  if (index === 2 && /^[a-zA-Z]:/.test(normalized)) return normalized.slice(0, 2);
  return normalized.slice(0, index) || normalized;
}

function basename(value) {
  if (!value) return '';
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
}

function toRelativePath(target, root) {
  if (!target || !root) return '';
  const normalizedTarget = target.replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return normalizedTarget.slice(normalizedRoot.length + 1);
  }
  return basename(target);
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(value) {
  return esc(value).replace(/`/g, '&#96;');
}

function normalizeComparablePath(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}
