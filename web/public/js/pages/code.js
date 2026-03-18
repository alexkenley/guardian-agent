import { api } from '../api.js';
import { onSSE } from '../app.js';

const STORAGE_KEY = 'guardianagent_code_sessions_v2';
const DEFAULT_USER_CHANNEL = 'web';
const MAX_TERMINAL_PANES = 3;
const APPROVAL_BACKLOG_SOFT_CAP = 3;
const MAX_SESSION_JOBS = 20;
const ASSISTANT_TABS = ['chat', 'activity'];
const SESSION_REFRESH_INTERVAL_MS = 5000;
const JS_TS_KEYWORDS = [
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements',
  'import', 'in', 'instanceof', 'interface', 'let', 'new', 'of', 'private', 'protected', 'public', 'readonly',
  'return', 'set', 'static', 'super', 'switch', 'throw', 'try', 'type', 'typeof', 'var', 'void', 'while', 'yield',
];
const JS_TS_TYPES = [
  'Array', 'Map', 'Promise', 'ReadonlyArray', 'Record', 'Set', 'any', 'boolean', 'never', 'null', 'number', 'object',
  'string', 'true', 'false', 'undefined', 'unknown', 'void',
];
const PYTHON_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'False', 'finally', 'for', 'from', 'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass',
  'raise', 'return', 'True', 'try', 'while', 'with', 'yield',
];
const SHELL_KEYWORDS = [
  'case', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function', 'if', 'in', 'local', 'readonly',
  'return', 'select', 'then', 'until', 'while',
];
const MARKDOWN_INLINE_RULES = [
  { type: 'string', pattern: /`[^`\n]+`/g },
  { type: 'function', pattern: /\[[^\]]+\]\([^)]+\)/g },
  { type: 'keyword', pattern: /\*\*[^*\n]+\*\*|__[^_\n]+__/g },
  { type: 'type', pattern: /\*[^*\n]+\*|_[^_\n]+_/g },
];

const SCROLL_SELECTORS = ['.code-file-list', '.code-editor__content', '.code-chat__history', '.code-rail__list'];

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
let terminalRenderTimer = null;
let terminalUnloadBound = false;
let terminalLibPromise = null;
let terminalCssLoaded = false;
let terminalInstances = new Map();
let sessionRefreshInterval = null;
let sessionPersistTimers = new Map();
let pendingTerminalFocusTabId = null;
let deferredSelectionRerenderTimer = null;

function isAssistantTab(value) {
  return ASSISTANT_TABS.includes(value);
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

function renderCodeBlock(content, { filePath = '', kind = 'source' } = {}) {
  const text = String(content ?? '');
  const language = kind === 'diff' ? 'diff' : detectCodeLanguage(filePath);
  const highlighted = kind === 'diff'
    ? highlightDiff(text)
    : highlightCode(text, language);
  const highlightedClass = highlighted !== esc(text) ? ' is-highlighted' : '';
  return `<pre class="code-editor__content code-editor__content--${escAttr(kind)}${highlightedClass}" data-code-language="${escAttr(language)}">${highlighted}</pre>`;
}

function detectCodeLanguage(filePath) {
  const name = basename(filePath || '').toLowerCase();
  if (!name) return 'plaintext';
  if (name === 'dockerfile' || name === 'makefile' || name === '.gitignore' || name.endsWith('.env')) {
    return 'shell';
  }
  const ext = name.includes('.') ? name.split('.').pop() : '';
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'css':
    case 'scss':
    case 'less':
      return 'css';
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
      return 'markup';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'py':
      return 'python';
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'ps1':
    case 'psm1':
    case 'bat':
    case 'cmd':
      return 'shell';
    default:
      return 'plaintext';
  }
}

function highlightCode(text, language) {
  switch (language) {
    case 'javascript':
      return highlightByRules(text, [
        { type: 'comment', pattern: /\/\*[\s\S]*?\*\//g },
        { type: 'comment', pattern: /\/\/.*$/gm },
        { type: 'keyword', pattern: /@[A-Za-z_$][\w$]*/g },
        { type: 'string', pattern: /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g },
        { type: 'keyword', pattern: makeWordPattern(JS_TS_KEYWORDS) },
        { type: 'type', pattern: makeWordPattern(JS_TS_TYPES) },
        { type: 'number', pattern: /\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/g },
        { type: 'function', pattern: /\b[A-Za-z_$][\w$]*(?=\s*\()/g },
      ]);
    case 'json':
      return highlightByRules(text, [
        { type: 'property', pattern: /"(?:\\.|[^"\\])*"(?=\s*:)/g },
        { type: 'string', pattern: /"(?:\\.|[^"\\])*"/g },
        { type: 'number', pattern: /\b-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi },
        { type: 'keyword', pattern: /\b(?:true|false|null)\b/g },
      ]);
    case 'css':
      return highlightByRules(text, [
        { type: 'comment', pattern: /\/\*[\s\S]*?\*\//g },
        { type: 'keyword', pattern: /@[\w-]+/g },
        { type: 'property', pattern: /--[\w-]+(?=\s*:)|\b[A-Za-z-]+(?=\s*:)/g },
        { type: 'function', pattern: /\b[A-Za-z-]+(?=\()/g },
        { type: 'string', pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g },
        { type: 'number', pattern: /#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|ms|s|deg)?\b/g },
      ]);
    case 'markup':
      return highlightByRules(text, [
        { type: 'comment', pattern: /<!--[\s\S]*?-->/g },
        { type: 'keyword', pattern: /<\/?[A-Za-z][A-Za-z0-9:-]*/g },
        { type: 'property', pattern: /\b[A-Za-z_:][-A-Za-z0-9_:.]*(?=\=)/g },
        { type: 'string', pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g },
      ]);
    case 'yaml':
      return highlightByRules(text, [
        { type: 'comment', pattern: /#.*$/gm },
        { type: 'property', pattern: /^[ \t-]*[A-Za-z0-9_"'.-]+(?=\s*:)/gm },
        { type: 'string', pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g },
        { type: 'keyword', pattern: /\b(?:true|false|null|yes|no|on|off)\b/gi },
        { type: 'number', pattern: /\b-?\d+(?:\.\d+)?\b/g },
      ]);
    case 'python':
      return highlightByRules(text, [
        { type: 'comment', pattern: /#.*$/gm },
        { type: 'string', pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g },
        { type: 'keyword', pattern: makeWordPattern(PYTHON_KEYWORDS) },
        { type: 'number', pattern: /\b\d+(?:\.\d+)?\b/g },
        { type: 'function', pattern: /\b[A-Za-z_][\w]*(?=\s*\()/g },
      ]);
    case 'shell':
      return highlightByRules(text, [
        { type: 'comment', pattern: /#.*$/gm },
        { type: 'string', pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g },
        { type: 'variable', pattern: /\$\{[^}]+\}|\$[A-Za-z_][\w]*|%[A-Za-z_][\w]*%/g },
        { type: 'keyword', pattern: makeWordPattern(SHELL_KEYWORDS) },
        { type: 'number', pattern: /\b\d+(?:\.\d+)?\b/g },
        { type: 'function', pattern: /\b[A-Za-z_][\w-]*(?=\s*\()/g },
      ]);
    case 'markdown':
      return highlightMarkdown(text);
    default:
      return esc(text);
  }
}

function highlightMarkdown(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        return `<span class="code-line code-line--meta">${renderToken('keyword', line)}</span>`;
      }
      if (/^\s{0,3}#{1,6}\s/.test(line)) {
        return `<span class="code-line code-line--meta">${highlightByRules(line, MARKDOWN_INLINE_RULES)}</span>`;
      }
      if (/^\s*>\s/.test(line)) {
        return `<span class="code-line code-line--context">${renderToken('comment', line)}</span>`;
      }
      if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) {
        return `<span class="code-line code-line--context">${highlightByRules(line, MARKDOWN_INLINE_RULES)}</span>`;
      }
      const inline = highlightByRules(line, MARKDOWN_INLINE_RULES);
      return `<span class="code-line code-line--context">${inline || '&#8203;'}</span>`;
    })
    .join('');
}

function highlightDiff(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      let lineClass = 'context';
      if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
        lineClass = 'meta';
      } else if (line.startsWith('@@')) {
        lineClass = 'hunk';
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        lineClass = 'add';
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        lineClass = 'remove';
      }
      const body = line.length > 0 ? esc(line) : '&#8203;';
      return `<span class="code-line code-line--${lineClass}">${body}</span>`;
    })
    .join('');
}

function highlightByRules(text, rules) {
  const input = String(text ?? '');
  let cursor = 0;
  let output = '';

  while (cursor < input.length) {
    const next = findNextHighlightMatch(input, cursor, rules);
    if (!next) {
      output += esc(input.slice(cursor));
      break;
    }
    if (next.index > cursor) {
      output += esc(input.slice(cursor, next.index));
    }
    output += renderToken(next.type, next.value);
    cursor = next.index + next.value.length;
  }

  return output;
}

function findNextHighlightMatch(text, cursor, rules) {
  let best = null;
  for (const rule of rules) {
    rule.pattern.lastIndex = cursor;
    const match = rule.pattern.exec(text);
    if (!match || typeof match.index !== 'number' || match[0].length === 0) continue;
    if (!best || match.index < best.index || (match.index === best.index && match[0].length > best.value.length)) {
      best = {
        index: match.index,
        value: match[0],
        type: typeof rule.type === 'function' ? rule.type(match[0], match) : rule.type,
      };
    }
  }
  return best;
}

function makeWordPattern(words) {
  return new RegExp(`\\b(?:${words.join('|')})\\b`, 'g');
}

function renderToken(type, value) {
  return `<span class="code-token code-token--${type}">${esc(value)}</span>`;
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
  if (/[\r\n\t ]/.test(candidate)) return true;
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

function deriveTaskItems(session) {
  const items = [];
  const backlog = getApprovalBacklogState(session);
  const recentJobs = Array.isArray(session?.recentJobs) ? session.recentJobs.filter(isCodeAssistantJob) : [];
  const workspaceProfile = session?.workspaceProfile || null;
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
  return jobs.map((job) => ({
    id: job.id,
    title: humanizeToolName(job.toolName),
    status: mapCheckStatus(job),
    detail: summarizeJobDetail(job),
    meta: formatRelativeTime(job.createdAt),
  }));
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
  return {
    role,
    content,
    timestamp: Number(entry?.timestamp) || Date.now(),
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

function normalizeServerSession(record, existing = {}) {
  const uiState = record?.uiState || {};
  const workState = record?.workState || {};
  const hasWorkspaceProfile = Object.prototype.hasOwnProperty.call(workState, 'workspaceProfile');
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
    pendingApprovals: normalizePendingApprovals(workState.pendingApprovals, existing.pendingApprovals),
    activeSkills: Array.isArray(workState.activeSkills) ? workState.activeSkills.map((value) => String(value)) : [],
    recentJobs: Array.isArray(workState.recentJobs) ? workState.recentJobs.slice(0, MAX_SESSION_JOBS) : [],
    focusSummary: workState.focusSummary || '',
    planSummary: workState.planSummary || '',
    compactedSummary: workState.compactedSummary || '',
    workspaceProfile: hasWorkspaceProfile ? normalizeWorkspaceProfile(workState.workspaceProfile) : (existing.workspaceProfile || null),
    workspaceMap: hasWorkspaceMap ? normalizeWorkspaceMap(workState.workspaceMap) : (existing.workspaceMap || null),
    workingSet: hasWorkingSet ? normalizeWorkspaceWorkingSet(workState.workingSet) : (existing.workingSet || null),
    activeAssistantTab: isAssistantTab(uiState.activeAssistantTab) ? uiState.activeAssistantTab : (existing.activeAssistantTab || 'chat'),
    lastExplorerPath: existing.lastExplorerPath || null,
  };
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
    activeAssistantTab: isAssistantTab(session.activeAssistantTab) ? session.activeAssistantTab : 'chat',
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
      cachedFileView = await loadFileView(activeSession);
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
  if (deferredSelectionRerenderTimer) {
    clearTimeout(deferredSelectionRerenderTimer);
    deferredSelectionRerenderTimer = null;
  }
  if (sessionRefreshInterval) {
    clearInterval(sessionRefreshInterval);
    sessionRefreshInterval = null;
  }
  disposeInactiveTerminalInstances([]);
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

function renderDOM(container, { focusTerminalTabId = null } = {}) {
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
    ? (activeSession.showDiff
      ? `<div class="code-editor__split">
          <div class="code-editor__pane">
            <div class="code-editor__pane-label">Source</div>
            ${renderCodeBlock(fileView.source || 'Empty file.', {
              filePath: activeTab.filePath,
              kind: 'source',
            })}
          </div>
          <div class="code-editor__pane">
            <div class="code-editor__pane-label">Diff</div>
            ${renderCodeBlock(fileView.diff || 'No diff output for this file.', { kind: 'diff' })}
          </div>
        </div>`
      : `<textarea class="code-editor__textarea" data-code-editor-textarea spellcheck="false">${esc(activeTab.content ?? fileView.source ?? '')}</textarea>`)
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
                    ${editorDirty ? '<button class="btn btn-primary btn-sm" type="button" data-code-save-file title="Save changes (Ctrl+S)">Save</button>' : ''}
                    <button class="btn btn-secondary btn-sm" type="button" data-code-refresh-file title="Reload file contents">&#x21BB;</button>
                    <button class="btn btn-secondary btn-sm" type="button" data-code-toggle-diff title="Toggle side-by-side source and diff view">${activeSession.showDiff ? 'Source Only' : 'Split Diff'}</button>
                  </div>
                ` : ''}
              </div>
              ${activeTab ? `
                <div class="code-path">${esc(activeTab.filePath)}</div>
                ${fileView.error ? `<div class="code-error">${esc(fileView.error)}</div>` : ''}
                ${editorContent}
              ` : '<div class="empty-state">Select a file to open.</div>'}
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
              <h3 class="code-chat__title"><span class="code-chat__title-icon">&#x1F4BB;</span><span>Coding Assistant</span></h3>
              ${activeSession ? `
                <div class="panel__actions">
                  <button class="btn btn-secondary btn-sm" type="button" data-code-reset-chat title="Clear conversation and start fresh">Clear Chat</button>
                </div>
              ` : ''}
            </div>
            ${activeSession ? `
              ${renderAssistantTabs(activeSession)}
              ${renderAssistantPanel(activeSession)}
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

function renderAssistantTabs(session) {
  const approvalCount = Array.isArray(session?.pendingApprovals) ? session.pendingApprovals.length : 0;
  const taskCount = getTaskBadgeCount(session);
  const checkCount = getCheckBadgeCount(session);
  const activeTab = session?.activeAssistantTab || 'chat';
  const activityTotal = approvalCount + taskCount + checkCount;
  const viewedActivityTotal = (session?.viewedApprovalCount || 0) + (session?.viewedTaskCount || 0) + (session?.viewedCheckCount || 0);
  const unreadCounts = {
    chat: 0,
    activity: activeTab === 'activity' ? 0 : Math.max(0, activityTotal - viewedActivityTotal),
  };

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
      <button class="btn btn-secondary btn-sm" type="button" data-code-switch-tab="approvals">Review approvals</button>
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

function renderCodeMessage(role, content, extraClass = '', approvals = null) {
  const className = `code-message ${role === 'user' ? 'is-user' : role === 'error' ? 'is-error' : 'is-agent'}${extraClass ? ` ${extraClass}` : ''}`;
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
      <div class="code-message__role">${esc(formatCodeMessageRole(role))}</div>
      <div class="code-message__body">${esc(content)}</div>
      ${approvalButtons}
    </div>
  `;
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
        </article>
      `).join('')}
    </div>
  `;
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

function renderAssistantPanel(session) {
  const activeTab = session?.activeAssistantTab || 'chat';
  switch (activeTab) {
    case 'activity':
      return `
        <div class="code-assistant-panel__body">
          <div class="code-chat__meta">
            <div class="code-chat__workspace">${esc(session.resolvedRoot || session.workspaceRoot)}</div>
          </div>
          <div class="code-assistant-panel__scroll">
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
        <div class="code-chat__meta">
          <div class="code-chat__workspace">${esc(session.resolvedRoot || session.workspaceRoot)}</div>
        </div>
        ${renderChatNotice(session)}
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
                // Attach inline approval buttons to the last agent message if there are pending approvals
                const isLastAgent = message.role === 'agent' && !committedMessages.slice(idx + 1).some((m) => m.role === 'agent');
                const inlineApprovals = isLastAgent && !pendingUserMessage && Array.isArray(session.pendingApprovals) && session.pendingApprovals.length > 0
                  ? session.pendingApprovals
                  : null;
                return renderCodeMessage(message.role, message.content, '', inlineApprovals);
              }).join('')}${pendingUserMessage ? renderCodeMessage('user', pendingUserMessage, 'is-pending') : ''}${pendingUserMessage ? renderCodeThinkingMessage() : ''}`}
        </div>
        <form class="code-chat__form" data-code-chat-form>
          <textarea name="message" rows="3" placeholder="Describe the change, bug, or refactor you want.">${esc(session.chatDraft || '')}</textarea>
          <button class="btn btn-primary" type="submit">Send</button>
        </form>
      `;
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
        ${isEdit ? `<button class="btn btn-danger btn-sm" type="button" data-code-clear-history="${escAttr(codeState.editingSessionId)}" style="margin-left:auto" title="Permanently clears all chat history for this session. This cannot be undone.">Clear History</button>` : ''}
      </div>
    </form>
  `;
}

function renderSessionCard(session) {
  const isActive = session.id === codeState.activeSessionId;
  const approvalCount = Array.isArray(session.pendingApprovals) ? session.pendingApprovals.length : 0;
  const checkCount = getCheckBadgeCount(session);
  const taskCount = getTaskBadgeCount(session);
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

// ─── Editor save ───────────────────────────────────────────

async function saveEditorFile() {
  const session = getActiveSession();
  const tab = getActiveTab(session);
  if (!session || !tab || !tab.dirty) return;
  const content = tab.content;
  if (content == null) return;
  try {
    const result = await api.codeFsWrite({
      sessionId: session.id,
      path: tab.filePath,
      content,
    });
    if (result?.success) {
      tab.dirty = false;
      tab.content = null;
      cachedFileView = { ...cachedFileView, source: content };
      saveState(codeState);
      rerenderFromState();
    } else {
      appendChatMessage(session, 'error', `Save failed: ${result?.error || 'Unknown error'}`);
    }
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
  cachedFileView = await loadFileView(session);
  rerenderFromState();
}

async function refreshSessionData(session) {
  const latestSession = await refreshSessionSnapshot(session.id).catch(() => session);
  const currentSession = latestSession || session;
  const rootPath = currentSession.resolvedRoot || currentSession.workspaceRoot || '.';
  treeCache.clear();
  const [rootData, fileView] = await Promise.all([
    loadTreeDir(currentSession, rootPath),
    loadFileView(currentSession),
  ]);
  treeCache.set(rootPath, rootData);
  if (!currentSession.resolvedRoot && rootData.resolvedPath) {
    currentSession.resolvedRoot = rootData.resolvedPath;
  }
  cachedFileView = fileView;
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

async function loadAssistantState(session) {
  if (!session?.id) {
    return {
      pendingApprovals: normalizePendingApprovals(session.pendingApprovals, session.pendingApprovals),
      recentJobs: Array.isArray(session.recentJobs) ? session.recentJobs.slice(0, MAX_SESSION_JOBS) : [],
    };
  }
  const snapshot = await api.codeSessionGet(session.id, {
    channel: DEFAULT_USER_CHANNEL,
    historyLimit: 1,
  });
  const refreshedSession = mergeCodeSessionRecord(snapshot, resolveLiveSession(session.id, session) || session) || session;

  return {
    pendingApprovals: normalizePendingApprovals(refreshedSession.pendingApprovals, session.pendingApprovals),
    recentJobs: Array.isArray(refreshedSession.recentJobs) ? refreshedSession.recentJobs.slice(0, MAX_SESSION_JOBS) : [],
  };
}

async function refreshAssistantState(session, { rerender = true, fallbackPendingApprovals = null } = {}) {
  if (!session) return;
  const nextState = await loadAssistantState(session);
  session.pendingApprovals = Array.isArray(nextState.pendingApprovals) && nextState.pendingApprovals.length > 0
    ? nextState.pendingApprovals
    : normalizePendingApprovals(fallbackPendingApprovals, session.pendingApprovals);
  session.recentJobs = nextState.recentJobs;
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
      // Save current tab's textarea content before switching
      const currentTab = getActiveTab(session);
      if (currentTab) {
        const ta = document.querySelector('[data-code-editor-textarea]');
        if (ta && ta.value !== (cachedFileView.source || '')) {
          currentTab.content = ta.value;
          currentTab.dirty = true;
        }
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
      // Save current tab's content before switching
      const currentTab = getActiveTab(session);
      if (currentTab) {
        const ta = container.querySelector('[data-code-editor-textarea]');
        if (ta && ta.value !== (cachedFileView.source || '')) {
          currentTab.content = ta.value;
          currentTab.dirty = true;
        }
      }
      session.activeTabIndex = idx;
      session.selectedFilePath = session.openTabs[idx]?.filePath || null;
      session.showDiff = false;
      saveState(codeState);
      void refreshFileView(session);
    });
  });

  container.querySelectorAll('[data-code-tab-close]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const session = getActiveSession();
      if (!session) return;
      const idx = parseInt(btn.dataset.codeTabClose, 10);
      closeTab(session, idx);
      saveState(codeState);
      if (session.selectedFilePath) {
        void refreshFileView(session);
      } else {
        cachedFileView = { source: '', diff: '', error: null };
        rerenderFromState();
      }
    });
  });

  // ── Editor (editable textarea) ──

  const editorTextarea = container.querySelector('[data-code-editor-textarea]');
  if (editorTextarea) {
    editorTextarea.addEventListener('input', () => {
      const session = getActiveSession();
      if (!session) return;
      const tab = getActiveTab(session);
      if (tab) {
        tab.content = editorTextarea.value;
        tab.dirty = true;
      }
      // Update the dirty indicator without a full rerender (avoids losing cursor/scroll)
      const dirtyDot = container.querySelector('.code-editor__dirty');
      if (!dirtyDot) {
        const h3 = container.querySelector('.code-editor .panel__header h3');
        if (h3 && !h3.querySelector('.code-editor__dirty')) {
          const span = document.createElement('span');
          span.className = 'code-editor__dirty';
          span.title = 'Unsaved changes';
          span.innerHTML = '&bull;';
          h3.appendChild(span);
        }
      }
      // Show save button if not already visible
      const actions = container.querySelector('.code-editor .panel__actions');
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

    editorTextarea.addEventListener('keydown', (e) => {
      // Ctrl+S / Cmd+S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveEditorFile();
      }
      // Tab inserts 2 spaces instead of moving focus
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = editorTextarea.selectionStart;
        const end = editorTextarea.selectionEnd;
        editorTextarea.value = editorTextarea.value.substring(0, start) + '  ' + editorTextarea.value.substring(end);
        editorTextarea.selectionStart = editorTextarea.selectionEnd = start + 2;
        editorTextarea.dispatchEvent(new Event('input'));
      }
    });
  }

  container.querySelector('[data-code-save-file]')?.addEventListener('click', () => saveEditorFile());

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
    const message = form.elements.message.value.trim();
    if (!message) return;
    session.chatDraft = '';
    session.pendingResponse = { message, startedAt: Date.now() };
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
      const response = await api.codeSessionSendMessage(outboundSessionId, {
        content: message,
        channel: DEFAULT_USER_CHANNEL,
      });
      const liveSession = resolveLiveSession(outboundSessionId, outboundSession || session);
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
      appendChatMessage(liveSession, 'agent', response.content || 'No response content.');
      // Refresh file view after assistant response — the assistant may have edited the open file.
      const activeEditorTab = getActiveTab(liveSession);
      if (activeEditorTab) { activeEditorTab.dirty = false; activeEditorTab.content = null; }
      const refreshedSession = await refreshSessionSnapshot(outboundSessionId).catch(() => resolveLiveSession(outboundSessionId, liveSession));
      await refreshAssistantState(refreshedSession || liveSession, {
        rerender: false,
        fallbackPendingApprovals: responsePendingApprovals,
      });
      if (liveSession.selectedFilePath) {
        cachedFileView = await loadFileView(liveSession);
      }
    } catch (err) {
      const liveSession = resolveLiveSession(sessionId, session);
      liveSession.pendingResponse = null;
      if (isCodeSessionUnavailableError(err)) {
        liveSession.chatDraft = message;
        form.elements.message.value = message;
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
        pendingApprovals: Array.isArray(session.pendingApprovals) ? session.pendingApprovals : [],
        activeSkills: Array.isArray(session.activeSkills) ? session.activeSkills : [],
        recentJobs: Array.isArray(session.recentJobs) ? session.recentJobs.slice(0, MAX_SESSION_JOBS) : [],
        lastExplorerPath: session.lastExplorerPath || null,
        focusSummary: session.focusSummary || '',
        planSummary: session.planSummary || '',
        compactedSummary: session.compactedSummary || '',
        workspaceProfile: normalizeWorkspaceProfile(session.workspaceProfile),
        activeAssistantTab: isAssistantTab(session.activeAssistantTab) ? session.activeAssistantTab
          : (session.activeAssistantTab === 'tasks' || session.activeAssistantTab === 'approvals' || session.activeAssistantTab === 'checks') ? 'activity'
          : 'chat',
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
          }))
          : [],
        recentJobs: Array.isArray(session.recentJobs) ? session.recentJobs.slice(0, MAX_SESSION_JOBS) : [],
        workspaceProfile: normalizeWorkspaceProfile(session.workspaceProfile),
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
  };
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

function normalizeComparablePath(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}
