import { api } from '../api.js';
import { onSSE } from '../app.js';

const STORAGE_KEY = 'guardianagent_code_sessions_v1';
const DEFAULT_USER_CHANNEL = 'web';
const MAX_TERMINAL_PANES = 3;

const SCROLL_SELECTORS = ['.code-file-list', '.code-editor__content', '.code-chat__history', '.code-rail__list'];

let currentContainer = null;
let codeState = loadState();
let cachedAgents = [];
let cachedFileView = { source: '', diff: '', error: null };
let treeCache = new Map(); // keyed by absolute path → { entries, error }
let renderInFlight = false;
let hasRenderedOnce = false;
let detectedPlatform = 'linux'; // populated on first render from server
let shellOptionsCache = [];
let terminalListenersBound = false;
let terminalRenderTimer = null;
let terminalUnloadBound = false;
let terminalLibPromise = null;
let terminalCssLoaded = false;
let terminalInstances = new Map();

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
        { id: 'wsl', label: 'WSL Bash', detail: 'wsl -- bash' },
        { id: 'bash', label: 'Bash', detail: 'bash' },
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
    window.addEventListener('beforeunload', () => {
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

async function mountActiveTerminals(container, session) {
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
      return true;
    });
    term.onData((data) => {
      if (!tab.runtimeTerminalId) return;
      api.codeTerminalInput(tab.runtimeTerminalId, { input: data }).catch(() => {});
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
    term.focus();
    if (tab.runtimeTerminalId) {
      api.codeTerminalResize(tab.runtimeTerminalId, {
        cols: term.cols,
        rows: term.rows,
      }).catch(() => {});
    }
    terminalInstances.set(tab.id, { term, fitAddon, resizeObserver, host });
  }
}

// ─── Render pipeline ──────────────────────────────────────

export async function renderCode(container) {
  if (renderInFlight) return;
  renderInFlight = true;
  currentContainer = container;
  bindTerminalListeners();

  if (!hasRenderedOnce) {
    container.innerHTML = '<div class="loading" style="padding:2rem">Loading coding workspace...</div>';
  }

  try {
    const [agents, statusResult] = await Promise.all([
      api.agents().catch(() => []),
      api.status().catch(() => null),
    ]);
    cachedAgents = agents.filter((agent) => agent.canChat !== false);
    if (statusResult?.platform) detectedPlatform = statusResult.platform;
    if (Array.isArray(statusResult?.shellOptions)) shellOptionsCache = statusResult.shellOptions;

    codeState = normalizeState(codeState, cachedAgents);
    saveState(codeState);

    const activeSession = getActiveSession();
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
      // Load expanded dirs
      await loadExpandedDirs(activeSession);
      cachedFileView = await loadFileView(activeSession);
      await ensureSessionTerminals(activeSession);
      saveState(codeState);
    } else {
      cachedFileView = { source: '', diff: '', error: null };
    }

    renderDOM(container);
    hasRenderedOnce = true;
  } catch (err) {
    container.innerHTML = `<div class="loading" style="padding:2rem">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  } finally {
    renderInFlight = false;
  }
}

export function updateCode() {
  // No-op: Code page manages its own state; SSE invalidation is disabled for this route.
}

function rerenderFromState() {
  if (!currentContainer) return;
  renderDOM(currentContainer);
  const activeSession = getActiveSession();
  if (activeSession) {
    void ensureSessionTerminals(activeSession);
  }
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
  if (!tab.output) {
    tab.output = 'Connecting to terminal...\n';
  }
  saveState(codeState);
  try {
    const result = await api.codeTerminalOpen({
      cwd: session.resolvedRoot || session.workspaceRoot,
      shell: tab.shell || getDefaultShell(),
      cols: 120,
      rows: 30,
    });
    tab.runtimeTerminalId = result?.terminalId || null;
    tab.connected = !!tab.runtimeTerminalId;
    tab.openFailed = false;
    if (tab.output === 'Connecting to terminal...\n') {
      tab.output = '';
    }
  } catch (err) {
    tab.connected = false;
    tab.runtimeTerminalId = null;
    tab.openFailed = true;
    tab.output = trimTerminalOutput(`${tab.output || ''}\n[terminal error: ${err instanceof Error ? err.message : String(err)}]\n`);
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
}

function renderDOM(container) {
  const saved = saveScrollPositions(container);
  const activeSession = getActiveSession();
  const fileView = cachedFileView;

  const editorContent = activeSession?.selectedFilePath
    ? (activeSession.showDiff
      ? `<div class="code-editor__split">
          <div class="code-editor__pane">
            <div class="code-editor__pane-label">Source</div>
            <pre class="code-editor__content">${esc(fileView.source || 'Empty file.')}</pre>
          </div>
          <div class="code-editor__pane">
            <div class="code-editor__pane-label">Diff</div>
            <pre class="code-editor__content">${esc(fileView.diff || 'No diff output for this file.')}</pre>
          </div>
        </div>`
      : `<pre class="code-editor__content">${esc(fileView.source || 'Empty file.')}</pre>`)
    : '';

  const isCollapsed = activeSession?.terminalCollapsed;
  const terminalPanes = activeSession ? getVisibleTerminalPanes(activeSession) : [];

  container.innerHTML = `
    <div class="code-page">
      <div class="code-page__shell">
        <aside class="code-rail">
          <div class="code-rail__header">
            <h3>Sessions</h3>
            <button class="btn btn-primary btn-sm" type="button" data-code-new-session>+</button>
          </div>
          ${renderSessionForm()}
          <div class="code-rail__list">
            ${codeState.sessions.map((session) => renderSessionCard(session)).join('')}
          </div>
        </aside>
        <section class="code-workspace">
          <div class="code-workspace__main ${isCollapsed ? 'terminals-collapsed' : ''}">
            <section class="code-explorer panel">
              <div class="panel__header">
                <h3>Explorer <span class="code-tooltip-icon" title="Browse workspace files. Expand folders in the tree, click files to view source.">&#9432;</span></h3>
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
            </section>
            <section class="code-editor panel">
              <div class="panel__header">
                <h3>${activeSession?.selectedFilePath ? esc(basename(activeSession.selectedFilePath)) : 'Editor'} <span class="code-tooltip-icon" title="View file source and git diffs. Click a file in the Explorer to open it. Use Split Diff to compare source and changes side by side.">&#9432;</span></h3>
                ${activeSession?.selectedFilePath ? `
                  <div class="panel__actions">
                    <button class="btn btn-secondary btn-sm" type="button" data-code-refresh-file title="Reload file contents">&#x21BB;</button>
                    <button class="btn btn-secondary btn-sm" type="button" data-code-toggle-diff title="Toggle side-by-side source and diff view">${activeSession.showDiff ? 'Source Only' : 'Split Diff'}</button>
                  </div>
                ` : ''}
              </div>
              ${activeSession?.selectedFilePath ? `
                <div class="code-path">${esc(activeSession.selectedFilePath)}</div>
                ${fileView.error ? `<div class="code-error">${esc(fileView.error)}</div>` : ''}
                ${editorContent}
              ` : '<div class="empty-state">Select a file to inspect.</div>'}
            </section>
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
              <h3>Assistant</h3>
              ${activeSession ? `
                <div class="panel__actions">
                  <button class="btn btn-secondary btn-sm" type="button" data-code-reset-chat title="Clear conversation and start fresh">Reset</button>
                </div>
              ` : ''}
            </div>
            ${activeSession ? `
              <div class="code-chat__meta">
                <div class="code-chat__workspace">${esc(activeSession.resolvedRoot || activeSession.workspaceRoot)}</div>
              </div>
              <div class="code-chat__history">
                ${activeSession.chat.length === 0
                  ? `<div class="code-chat__onboarding">
                      <div class="code-chat__onboarding-title">Getting Started</div>
                      <ul class="code-chat__onboarding-list">
                        <li>Describe a bug, feature, or refactor in plain language</li>
                        <li>The agent reads files, edits code, and runs commands</li>
                        <li>Mutating actions go through Guardian approval automatically</li>
                        <li>Coding tools are built in &mdash; just describe what you need</li>
                      </ul>
                    </div>`
                  : activeSession.chat.map((message) => `
                    <div class="code-message ${message.role === 'user' ? 'is-user' : message.role === 'error' ? 'is-error' : 'is-agent'}">
                      <div class="code-message__role">${esc(message.role)}</div>
                      <div class="code-message__body">${esc(message.content)}</div>
                    </div>
                  `).join('')}
              </div>
              <form class="code-chat__form" data-code-chat-form>
                <textarea name="message" rows="3" placeholder="Describe the change, bug, or refactor you want.">${esc(activeSession.chatDraft || '')}</textarea>
                <button class="btn btn-primary" type="submit">Send</button>
              </form>
            ` : '<div class="empty-state">Create a session to start chatting.</div>'}
          </aside>
        </section>
      </div>
    </div>
  `;

  bindEvents(container);
  restoreScrollPositions(container, saved);
  if (activeSession) {
    void mountActiveTerminals(container, activeSession);
  } else {
    disposeInactiveTerminalInstances([]);
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
  const currentShell = tab.shell || getDefaultShell();
  const selectedShell = getShellOption(currentShell);
  const cwd = session.resolvedRoot || session.workspaceRoot;

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
      <div class="code-terminal__viewport" data-terminal-viewport="${escAttr(tab.id)}"></div>
    </div>
  `;
}

// ─── Session card rendering ────────────────────────────────

function renderSessionForm() {
  const isCreate = codeState.showCreateForm;
  const isEdit = !!codeState.editingSessionId;
  if (!isCreate && !isEdit) return '';

  const draft = isEdit ? codeState.editDraft || {} : codeState.createDraft || {};
  const formId = isEdit ? 'data-code-edit-session-form' : 'data-code-session-form';
  const submitLabel = isEdit ? 'Save' : 'Create';
  const cancelAttr = isEdit ? 'data-code-cancel-edit' : 'data-code-cancel-create';

  return `
    <form class="code-session-form is-visible" ${formId}>
      <label>
        Title
        <input name="title" type="text" value="${escAttr(draft.title || '')}" placeholder="Frontend app">
      </label>
      <label>
        Workspace Root
        <div style="display:flex;gap:0.5rem;align-items:center">
          <input name="workspaceRoot" type="text" value="${escAttr(draft.workspaceRoot || '.')}" placeholder=". or /path/to/project" style="flex:1">
          <button class="btn btn-secondary btn-sm" type="button" data-code-browse-dir>Browse</button>
        </div>
      </label>
      ${renderDirPicker()}
      ${!isEdit ? `
        <label>
          Agent
          <select name="agentId">
            <option value="">Guardian Auto</option>
            ${cachedAgents.map((agent) => `<option value="${escAttr(agent.id)}"${draft.agentId === agent.id ? ' selected' : ''}>${esc(agent.name)} (${esc(agent.id)})</option>`).join('')}
          </select>
        </label>
      ` : ''}
      <div class="code-session-form__actions">
        <button class="btn btn-primary btn-sm" type="submit">${submitLabel}</button>
        <button class="btn btn-secondary btn-sm" type="button" ${cancelAttr}>Cancel</button>
      </div>
    </form>
  `;
}

function renderSessionCard(session) {
  const isActive = session.id === codeState.activeSessionId;
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
    </button>
  `;
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

async function refreshFileView(session) {
  cachedFileView = await loadFileView(session);
  rerenderFromState();
}

async function refreshSessionData(session) {
  const rootPath = session.resolvedRoot || session.workspaceRoot || '.';
  treeCache.clear();
  const [rootData, fileView] = await Promise.all([
    loadTreeDir(session, rootPath),
    loadFileView(session),
  ]);
  treeCache.set(rootPath, rootData);
  if (!session.resolvedRoot && rootData.resolvedPath) {
    session.resolvedRoot = rootData.resolvedPath;
  }
  cachedFileView = fileView;
  await loadExpandedDirs(session);
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
      path: session.selectedFilePath,
      maxBytes: 250000,
    }).catch((err) => ({ success: false, error: err.message })),
    api.codeGitDiff({
      cwd: session.resolvedRoot || session.workspaceRoot,
      path: toRelativePath(session.selectedFilePath, session.resolvedRoot || session.workspaceRoot),
    }).catch((err) => ({ success: false, error: err.message })),
  ]);

  return {
    source: sourceResult?.content || '',
    diff: diffResult?.stdout || diffResult?.stderr || '',
    error: sourceResult?.success ? null : (sourceResult?.message || sourceResult?.error || 'Failed to read file.'),
  };
}

// ─── Event binding ─────────────────────────────────────────

function bindEvents(container) {
  // ── Session rail ──

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

  createForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const title = form.elements.title.value.trim() || 'Coding Session';
    const workspaceRoot = form.elements.workspaceRoot.value.trim() || '.';
    const agentId = form.elements.agentId?.value || '';
    const session = createSession(title, workspaceRoot, agentId || null);
    codeState.sessions.unshift(session);
    codeState.activeSessionId = session.id;
    codeState.showCreateForm = false;
    codeState.createDraft = { title: '', workspaceRoot: '.', agentId: '' };
    treeCache.clear();
    cachedFileView = { source: '', diff: '', error: null };
    closeDirPicker();
    saveState(codeState);
    rerenderFromState();
    void refreshSessionData(session);
  });

  // Edit form
  const editForm = container.querySelector('[data-code-edit-session-form]');
  editForm?.addEventListener('input', (event) => {
    const form = event.currentTarget;
    codeState.editDraft = {
      ...codeState.editDraft,
      title: form.elements.title.value,
      workspaceRoot: form.elements.workspaceRoot.value,
    };
    saveState(codeState);
  });

  editForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = codeState.sessions.find((s) => s.id === codeState.editingSessionId);
    if (!session) return;
    const form = event.currentTarget;
    session.title = form.elements.title.value.trim() || session.title;
    const newRoot = form.elements.workspaceRoot.value.trim() || session.workspaceRoot;
    if (newRoot !== session.workspaceRoot) {
      await Promise.all((session.terminalTabs || []).map((tab) => closeTerminal(tab)));
      session.workspaceRoot = newRoot;
      session.resolvedRoot = null;
      session.terminalTabs = (session.terminalTabs || []).map((tab, index) => ({
        ...tab,
        runtimeTerminalId: null,
        connecting: false,
        connected: false,
        output: index === 0 ? '' : tab.output || '',
      }));
      treeCache.clear();
    }
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
      saveState(codeState);
      rerenderFromState();
      const session = getActiveSession();
      if (session) void refreshSessionData(session);
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
      codeState.sessions = codeState.sessions.filter((session) => session.id !== deletedId);
      const wasActive = codeState.activeSessionId === deletedId;
      codeState.activeSessionId = codeState.sessions[0]?.id || null;
      saveState(codeState);
      if (wasActive) {
        treeCache.clear();
        cachedFileView = { source: '', diff: '', error: null };
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
      rerenderFromState();
    });
  });

  container.querySelectorAll('[data-code-tree-file]').forEach((button) => {
    button.addEventListener('click', () => {
      const session = getActiveSession();
      if (!session) return;
      session.selectedFilePath = button.dataset.codeTreeFile || null;
      session.showDiff = false;
      saveState(codeState);
      void refreshFileView(session);
    });
  });

  container.querySelector('[data-code-refresh-file]')?.addEventListener('click', () => {
    const session = getActiveSession();
    if (session) void refreshFileView(session);
  });

  container.querySelector('[data-code-toggle-diff]')?.addEventListener('click', () => {
    const session = getActiveSession();
    if (!session) return;
    session.showDiff = !session.showDiff;
    saveState(codeState);
    rerenderFromState();
  });

  // ── Terminals ──

  container.querySelector('[data-code-toggle-terminal-collapse]')?.addEventListener('click', () => {
    const session = getActiveSession();
    if (!session) return;
    session.terminalCollapsed = !session.terminalCollapsed;
    saveState(codeState);
    rerenderFromState();
  });

  container.querySelector('[data-code-new-terminal]')?.addEventListener('click', () => {
    const session = getActiveSession();
    if (!session) return;
    if (session.terminalTabs.length >= MAX_TERMINAL_PANES) return;
    const tab = createTerminalTab(`Terminal ${session.terminalTabs.length + 1}`, getDefaultShell());
    session.terminalTabs.push(tab);
    saveState(codeState);
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
        tab.shell = select.value;
        tab.output = '';
        tab.openFailed = false;
        saveState(codeState);
        rerenderFromState();
        void ensureTerminalConnected(session, tab);
      }
    });
  });

  // ── Chat ──

  container.querySelector('[data-code-chat-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = getActiveSession();
    if (!session) return;
    const form = event.currentTarget;
    const message = form.elements.message.value.trim();
    if (!message) return;
    session.chatDraft = '';
    session.chat.push({ role: 'user', content: message });
    saveState(codeState);
    rerenderFromState();
    scrollToBottom(currentContainer, '.code-chat__history');

    try {
      const response = await api.sendMessage(
        buildCodePrompt(session, message),
        session.agentId || undefined,
        buildUserId(session),
        DEFAULT_USER_CHANNEL,
      );
      session.activeSkills = Array.isArray(response?.metadata?.activeSkills)
        ? response.metadata.activeSkills.map((value) => String(value))
        : [];
      session.chat.push({ role: 'agent', content: response.content || 'No response content.' });
    } catch (err) {
      session.chat.push({ role: 'error', content: err instanceof Error ? err.message : String(err) });
    }
    saveState(codeState);
    rerenderFromState();
    scrollToBottom(currentContainer, '.code-chat__history');
  });

  container.querySelector('[data-code-reset-chat]')?.addEventListener('click', async () => {
    const session = getActiveSession();
    if (!session) return;
    session.chat = [];
    saveState(codeState);
    try {
      await api.resetConversation(session.agentId || cachedAgents[0]?.id || 'default', buildUserId(session), DEFAULT_USER_CHANNEL);
    } catch {
      // Keep local reset even if server reset fails.
    }
    rerenderFromState();
  });

  container.querySelector('[data-code-chat-form] textarea[name="message"]')?.addEventListener('input', (event) => {
    const session = getActiveSession();
    if (!session) return;
    session.chatDraft = event.currentTarget.value;
    saveState(codeState);
  });
}

// ─── State management ──────────────────────────────────────

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { sessions: [], activeSessionId: null, showCreateForm: false, createDraft: { title: '', workspaceRoot: '.', agentId: '' } };
  } catch {
    return { sessions: [], activeSessionId: null, showCreateForm: false, createDraft: { title: '', workspaceRoot: '.', agentId: '' } };
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
        agentId: resolveAgentId(session.agentId, agents),
        terminalTabs,
        terminalCollapsed: !!session.terminalCollapsed,
        expandedDirs: Array.isArray(session.expandedDirs) ? session.expandedDirs : [],
        chat: Array.isArray(session.chat) ? session.chat.slice(-30) : [],
        chatDraft: session.chatDraft || '',
        pendingApprovals: Array.isArray(session.pendingApprovals) ? session.pendingApprovals : [],
        activeSkills: Array.isArray(session.activeSkills) ? session.activeSkills : [],
        lastExplorerPath: session.lastExplorerPath || null,
        planSummary: session.planSummary || '',
        compactedSummary: session.compactedSummary || '',
      };
    }) : [],
    activeSessionId: raw?.activeSessionId || null,
    showCreateForm: !!raw?.showCreateForm,
    editingSessionId: raw?.editingSessionId || null,
    editDraft: raw?.editDraft || null,
    createDraft: {
      title: raw?.createDraft?.title || '',
      workspaceRoot: raw?.createDraft?.workspaceRoot || '.',
      agentId: raw?.createDraft?.agentId || '',
    },
  };

  if (next.sessions.length === 0) {
    const session = createSession('GuardianAgent', '.', resolveAgentId(null, agents));
    next.sessions = [session];
    next.activeSessionId = session.id;
  }

  if (!next.sessions.some((session) => session.id === next.activeSessionId)) {
    next.activeSessionId = next.sessions[0]?.id || null;
  }

  return next;
}

function normalizeTerminalTabs(value) {
  const userTabs = Array.isArray(value) && value.length > 0
    ? value
      .map((tab) => ({
        id: tab.id && tab.id !== 'agent' ? tab.id : crypto.randomUUID(),
        name: tab.name && tab.name !== 'Agent' ? tab.name : 'Terminal 1',
        shell: tab.shell || getDefaultShell(),
        output: typeof tab.output === 'string'
          ? trimTerminalOutput(tab.output)
          : trimTerminalOutput(Array.isArray(tab.history) ? tab.history.join('\n\n') : ''),
        runtimeTerminalId: typeof tab.runtimeTerminalId === 'string' && tab.runtimeTerminalId ? tab.runtimeTerminalId : null,
        connecting: !!tab.connecting,
        connected: !!tab.connected,
        openFailed: !!tab.openFailed,
      }))
    : [];
  return userTabs.length > 0 ? userTabs : [createTerminalTab('Terminal 1', getDefaultShell())];
}

function saveState(state) {
  const persistable = {
    ...state,
    sessions: Array.isArray(state.sessions)
      ? state.sessions.map((session) => ({
        ...session,
        terminalTabs: Array.isArray(session.terminalTabs)
          ? session.terminalTabs.map((tab) => ({
            id: tab.id,
            name: tab.name,
            shell: tab.shell,
            output: typeof tab.output === 'string' ? trimTerminalOutput(tab.output) : '',
          }))
          : [],
      }))
      : [],
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
}

function getActiveSession() {
  return codeState.sessions.find((session) => session.id === codeState.activeSessionId) || null;
}

function createSession(title, workspaceRoot, agentId) {
  return {
    id: crypto.randomUUID(),
    title,
    workspaceRoot,
    resolvedRoot: null,
    currentDirectory: null,
    selectedFilePath: null,
    showDiff: false,
    agentId,
    terminalTabs: [createTerminalTab('Terminal 1', getDefaultShell())],
    terminalCollapsed: false,
    expandedDirs: [],
    chat: [],
    chatDraft: '',
    pendingApprovals: [],
    activeSkills: [],
    lastExplorerPath: null,
    planSummary: '',
    compactedSummary: '',
  };
}

function createTerminalTab(name, shell) {
  return {
    id: crypto.randomUUID(),
    name,
    shell: shell || getDefaultShell(),
    output: '',
    runtimeTerminalId: null,
    connecting: false,
    connected: false,
    openFailed: false,
  };
}

// ─── Prompt and output helpers ─────────────────────────────

function buildUserId(session) {
  return `web-code-${session.id}`;
}

function buildCodePrompt(session, message) {
  const workspaceRoot = session.resolvedRoot || session.workspaceRoot;
  const selectedFile = session.selectedFilePath || '(none)';
  const currentDirectory = session.currentDirectory || workspaceRoot;
  return [
    '[Code Workspace Context]',
    `workspaceRoot: ${workspaceRoot}`,
    `currentDirectory: ${currentDirectory}`,
    `selectedFile: ${selectedFile}`,
    Array.isArray(session.activeSkills) && session.activeSkills.length > 0
      ? `activeSkills: ${session.activeSkills.join(', ')}`
      : 'activeSkills: (none)',
    session.planSummary ? `activePlan:\n${session.planSummary}` : 'activePlan: (none)',
    session.compactedSummary ? `compactedSummary:\n${session.compactedSummary}` : 'compactedSummary: (none)',
    '',
    '[Code Workspace Operating Rules]',
    'Follow this loop: understand first, act second, verify third.',
    'Read files before editing them. Prefer code-aware tools when available.',
    'Use code_symbol_search before broad changes and use git diff to verify what changed.',
    'For complex or multi-file work, create or update a concise plan before making large edits.',
    'After material changes, run targeted verification such as tests, lint, or build when available.',
    'If you start repeating the same failed action, stop and change approach.',
    'If the current thread feels stale or bloated, summarize progress clearly so the session can be compacted.',
    '',
    'Use coding tools when appropriate. If coding tools are not visible, call find_tools with query "coding code edit patch create plan git diff commit test build lint symbol".',
    `When running shell commands, use cwd="${workspaceRoot}".`,
    '',
    message,
  ].join('\n');
}

// ─── Path and string utilities ─────────────────────────────

function resolveAgentId(agentId, agents) {
  if (!agentId) return null;
  return agents.some((agent) => agent.id === agentId) ? agentId : null;
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
