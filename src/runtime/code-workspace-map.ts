import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CodeWorkspaceProfile } from './code-workspace-profile.js';

const MAX_INDEXED_FILES = 220;
const MAX_DIRECTORY_SUMMARIES = 24;
const MAX_DIRECTORY_SAMPLES = 4;
const MAX_FILE_BYTES = 12_000;
const MAX_SUMMARY_CHARS = 260;
const MAX_SNIPPET_CHARS = 900;
const MAX_WORKING_SET_FILES = 6;
const MAX_WORKING_SET_SNIPPETS = 4;
const MAX_SYMBOLS_PER_FILE = 10;
const MAX_IMPORTS_PER_FILE = 8;
const MAX_KEYWORDS_PER_FILE = 16;
const MAX_WALK_DEPTH = 6;

const IGNORED_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'vendor',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'out',
  'tmp',
  'temp',
]);

const TEXT_EXTENSIONS = new Set([
  '',
  '.md',
  '.txt',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.html',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.vue',
  '.svelte',
  '.sh',
  '.ps1',
  '.sql',
  '.graphql',
  '.proto',
]);

const DOC_BASENAMES = new Set([
  'readme.md',
  'readme',
  'overview.md',
  'architecture.md',
  'contributing.md',
  'docs.md',
  'guide.md',
]);

const MANIFEST_BASENAMES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'turbo.json',
  'nx.json',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'tsconfig.json',
  'jsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'cargo.toml',
  'go.mod',
  'composer.json',
  'gemfile',
  'mix.exs',
  'pom.xml',
  'dockerfile',
  '.env',
  '.env.example',
]);

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.vue',
  '.svelte',
]);

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'be',
  'brief',
  'but',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'give',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'look',
  'me',
  'of',
  'on',
  'or',
  'our',
  'overview',
  'please',
  'repo',
  'repository',
  'see',
  'sort',
  'tell',
  'that',
  'the',
  'their',
  'them',
  'there',
  'this',
  'to',
  'type',
  'up',
  'we',
  'what',
  'where',
  'which',
  'with',
  'workspace',
  'yeah',
  'you',
  'your',
]);

export type CodeWorkspaceFileCategory =
  | 'doc'
  | 'manifest'
  | 'source'
  | 'test'
  | 'config'
  | 'asset';

export interface CodeWorkspaceMapFile {
  path: string;
  category: CodeWorkspaceFileCategory;
  extension: string;
  size: number;
  summary: string;
  symbols: string[];
  imports: string[];
  keywords: string[];
}

export interface CodeWorkspaceDirectorySummary {
  path: string;
  fileCount: number;
  sampleFiles: string[];
}

export interface CodeWorkspaceMap {
  workspaceRoot: string;
  indexedFileCount: number;
  totalDiscoveredFiles: number;
  truncated: boolean;
  notableFiles: string[];
  directories: CodeWorkspaceDirectorySummary[];
  files: CodeWorkspaceMapFile[];
  lastIndexedAt: number;
}

export interface CodeWorkspaceWorkingSetFile {
  path: string;
  category: CodeWorkspaceFileCategory;
  score: number;
  reason: string;
  summary: string;
  symbols: string[];
}

export interface CodeWorkspaceWorkingSetSnippet {
  path: string;
  excerpt: string;
}

export interface CodeWorkspaceWorkingSet {
  query: string;
  retrievedAt: number;
  rationale: string;
  files: CodeWorkspaceWorkingSetFile[];
  snippets: CodeWorkspaceWorkingSetSnippet[];
}

function limitText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function readTextIfExists(path: string, maxBytes = MAX_FILE_BYTES): string {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8').slice(0, maxBytes);
  } catch {
    return '';
  }
}

function tokenize(value: string): string[] {
  const matches = value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  return Array.from(new Set(matches.filter((token) => !STOPWORDS.has(token))));
}

function firstMeaningfulLines(text: string, limit = 4): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => (
      line
      && !line.startsWith('//')
      && !line.startsWith('#!')
      && !line.startsWith('/*')
      && !line.startsWith('*')
      && !line.startsWith('import ')
      && !line.startsWith('export {')
    ))
    .slice(0, limit);
}

function extractMarkdownSummary(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !/^[-*`]/.test(line));
  return limitText(lines.slice(0, 3).join(' '), MAX_SUMMARY_CHARS);
}

function extractJsonSummary(fileName: string, text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (fileName === 'package.json' && parsed && typeof parsed === 'object') {
      const packageJson = parsed as Record<string, unknown>;
      const scripts = packageJson.scripts && typeof packageJson.scripts === 'object'
        ? Object.keys(packageJson.scripts as Record<string, unknown>).slice(0, 6)
        : [];
      const deps = [
        ...(packageJson.dependencies && typeof packageJson.dependencies === 'object'
          ? Object.keys(packageJson.dependencies as Record<string, unknown>)
          : []),
        ...(packageJson.devDependencies && typeof packageJson.devDependencies === 'object'
          ? Object.keys(packageJson.devDependencies as Record<string, unknown>)
          : []),
      ].slice(0, 8);
      return limitText(
        [
          typeof packageJson.name === 'string' ? packageJson.name : '',
          typeof packageJson.description === 'string' ? packageJson.description : '',
          scripts.length > 0 ? `scripts: ${scripts.join(', ')}` : '',
          deps.length > 0 ? `deps: ${deps.join(', ')}` : '',
        ].filter(Boolean).join(' — '),
        MAX_SUMMARY_CHARS,
      );
    }
    if (parsed && typeof parsed === 'object') {
      return limitText(`JSON keys: ${Object.keys(parsed as Record<string, unknown>).slice(0, 10).join(', ')}`, MAX_SUMMARY_CHARS);
    }
  } catch {
    // Ignore parse failures.
  }
  return limitText(firstMeaningfulLines(text, 3).join(' '), MAX_SUMMARY_CHARS);
}

function extractTomlSummary(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .slice(0, 6);
  return limitText(lines.join(' '), MAX_SUMMARY_CHARS);
}

function extractSymbols(text: string): string[] {
  const matches = [
    ...text.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g),
    ...text.matchAll(/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?(?:\(|<)/g),
    ...text.matchAll(/\b(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/g),
    ...text.matchAll(/\binterface\s+([A-Za-z_][A-Za-z0-9_]*)/g),
    ...text.matchAll(/\btype\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g),
    ...text.matchAll(/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g),
  ]
    .map((match) => match[1])
    .filter(Boolean);
  return Array.from(new Set(matches)).slice(0, MAX_SYMBOLS_PER_FILE);
}

function extractImports(text: string): string[] {
  const matches = [
    ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...text.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
  ]
    .map((match) => match[1])
    .filter(Boolean);
  return Array.from(new Set(matches)).slice(0, MAX_IMPORTS_PER_FILE);
}

function categorizeFile(relativePath: string): CodeWorkspaceFileCategory {
  const baseName = basename(relativePath).toLowerCase();
  const ext = extname(relativePath).toLowerCase();
  const lowerPath = relativePath.toLowerCase();
  if (DOC_BASENAMES.has(baseName) || ext === '.md' || lowerPath.startsWith('docs/')) return 'doc';
  if (MANIFEST_BASENAMES.has(baseName)) return 'manifest';
  if (/(\.|\/)(test|spec)\.[^/]+$/i.test(lowerPath) || lowerPath.includes('/tests/') || lowerPath.includes('/__tests__/')) return 'test';
  if (lowerPath.startsWith('config/') || lowerPath.includes('.config.') || ['.json', '.yaml', '.yml', '.toml', '.ini'].includes(ext)) return 'config';
  if (SOURCE_EXTENSIONS.has(ext)) return 'source';
  return 'asset';
}

function summarizeFile(relativePath: string, text: string): string {
  const baseName = basename(relativePath).toLowerCase();
  const ext = extname(relativePath).toLowerCase();
  if (baseName === 'package.json' || ext === '.json') return extractJsonSummary(baseName, text);
  if (ext === '.md' || DOC_BASENAMES.has(baseName)) return extractMarkdownSummary(text);
  if (ext === '.toml') return extractTomlSummary(text);
  return limitText(firstMeaningfulLines(text).join(' '), MAX_SUMMARY_CHARS);
}

function deriveKeywords(relativePath: string, summary: string, symbols: string[], imports: string[]): string[] {
  return Array.from(new Set([
    ...tokenize(relativePath.replace(/[/.]/g, ' ')),
    ...tokenize(summary),
    ...symbols.flatMap((value) => tokenize(value)),
    ...imports.flatMap((value) => tokenize(value.replace(/[/.]/g, ' '))),
  ])).slice(0, MAX_KEYWORDS_PER_FILE);
}

function isTextFile(relativePath: string): boolean {
  const ext = extname(relativePath).toLowerCase();
  const baseName = basename(relativePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  return MANIFEST_BASENAMES.has(baseName) || DOC_BASENAMES.has(baseName);
}

function shouldIgnoreDir(name: string): boolean {
  return IGNORED_DIRS.has(name.toLowerCase());
}

function toWorkspaceRelativePath(workspaceRoot: string, value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = sep === '/' ? value.replace(/\\/g, '/') : value.replace(/\//g, '\\');
  const resolvedValue = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(workspaceRoot, normalized);
  const relativePath = relative(workspaceRoot, resolvedValue);
  if (!relativePath || relativePath === '') return '.';
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
  return relativePath.split(sep).join('/');
}

function readSnippet(workspaceRoot: string, relativePath: string): string {
  const absolutePath = join(workspaceRoot, relativePath);
  const text = readTextIfExists(absolutePath, MAX_FILE_BYTES);
  if (!text) return '';
  const ext = extname(relativePath).toLowerCase();
  if (ext === '.md') {
    return limitText(
      text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 10).join('\n'),
      MAX_SNIPPET_CHARS,
    );
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, '  '))
    .filter((line) => line.trim())
    .slice(0, 18)
    .join('\n');
  return limitText(lines, MAX_SNIPPET_CHARS);
}

export function cloneWorkspaceMap(map: CodeWorkspaceMap | null | undefined): CodeWorkspaceMap | null {
  if (!map) return null;
  return {
    ...map,
    notableFiles: Array.isArray(map.notableFiles) ? [...map.notableFiles] : [],
    directories: Array.isArray(map.directories)
      ? map.directories.map((entry) => ({
          path: entry.path,
          fileCount: entry.fileCount,
          sampleFiles: Array.isArray(entry.sampleFiles) ? [...entry.sampleFiles] : [],
        }))
      : [],
    files: Array.isArray(map.files)
      ? map.files.map((entry) => ({
          ...entry,
          symbols: Array.isArray(entry.symbols) ? [...entry.symbols] : [],
          imports: Array.isArray(entry.imports) ? [...entry.imports] : [],
          keywords: Array.isArray(entry.keywords) ? [...entry.keywords] : [],
        }))
      : [],
  };
}

export function cloneWorkspaceWorkingSet(workingSet: CodeWorkspaceWorkingSet | null | undefined): CodeWorkspaceWorkingSet | null {
  if (!workingSet) return null;
  return {
    ...workingSet,
    files: Array.isArray(workingSet.files)
      ? workingSet.files.map((entry) => ({
          ...entry,
          symbols: Array.isArray(entry.symbols) ? [...entry.symbols] : [],
        }))
      : [],
    snippets: Array.isArray(workingSet.snippets)
      ? workingSet.snippets.map((entry) => ({ ...entry }))
      : [],
  };
}

export function buildCodeWorkspaceMapSync(workspaceRoot: string, now = Date.now()): CodeWorkspaceMap {
  const files: CodeWorkspaceMapFile[] = [];
  const directories = new Map<string, { fileCount: number; sampleFiles: string[] }>();
  const notableFiles = new Set<string>();
  let totalDiscoveredFiles = 0;
  let truncated = false;

  const visitDirectory = (absoluteDir: string, relativeDir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || truncated) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) break;
      const absolutePath = join(absoluteDir, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!shouldIgnoreDir(entry.name)) {
          visitDirectory(absolutePath, relativePath, depth + 1);
        }
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      totalDiscoveredFiles += 1;
      if (!isTextFile(relativePath)) continue;
      let size = 0;
      try {
        size = statSync(absolutePath).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES * 6) continue;
      const text = readTextIfExists(absolutePath, MAX_FILE_BYTES);
      if (!text.trim()) continue;
      const category = categorizeFile(relativePath);
      const summary = summarizeFile(relativePath, text);
      const symbols = extractSymbols(text);
      const imports = extractImports(text);
      const keywords = deriveKeywords(relativePath, summary, symbols, imports);
      files.push({
        path: relativePath,
        category,
        extension: extname(relativePath).toLowerCase(),
        size,
        summary,
        symbols,
        imports,
        keywords,
      });

      const directoryPath = dirname(relativePath).replace(/\\/g, '/');
      const normalizedDirectoryPath = directoryPath === '.' ? '.' : directoryPath;
      const directorySummary = directories.get(normalizedDirectoryPath) ?? { fileCount: 0, sampleFiles: [] };
      directorySummary.fileCount += 1;
      if (directorySummary.sampleFiles.length < MAX_DIRECTORY_SAMPLES) {
        directorySummary.sampleFiles.push(relativePath);
      }
      directories.set(normalizedDirectoryPath, directorySummary);

      const baseName = basename(relativePath).toLowerCase();
      if (
        category === 'manifest'
        || DOC_BASENAMES.has(baseName)
        || /(^|\/)(app|main|index|routes?|layout|server|client)\.(t|j)sx?$/i.test(relativePath)
      ) {
        notableFiles.add(relativePath);
      }

      if (files.length >= MAX_INDEXED_FILES) {
        truncated = true;
      }
    }
  };

  visitDirectory(workspaceRoot, '', 0);

  const directorySummaries = [...directories.entries()]
    .map(([pathValue, value]) => ({
      path: pathValue,
      fileCount: value.fileCount,
      sampleFiles: value.sampleFiles.slice(0, MAX_DIRECTORY_SAMPLES),
    }))
    .sort((left, right) => {
      if (left.path === '.') return -1;
      if (right.path === '.') return 1;
      return right.fileCount - left.fileCount || left.path.localeCompare(right.path);
    })
    .slice(0, MAX_DIRECTORY_SUMMARIES);

  return {
    workspaceRoot,
    indexedFileCount: files.length,
    totalDiscoveredFiles,
    truncated,
    notableFiles: [...notableFiles].sort((left, right) => left.localeCompare(right)).slice(0, 20),
    directories: directorySummaries,
    files,
    lastIndexedAt: now,
  };
}

function pickBootstrapPaths(
  workspaceMap: CodeWorkspaceMap,
  workspaceProfile: CodeWorkspaceProfile | null | undefined,
  selectedFileRelativePath: string | null,
): string[] {
  const seeds: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    seeds.push(trimmed);
  };

  push(selectedFileRelativePath);
  for (const notable of workspaceMap.notableFiles) push(notable);
  for (const inspected of workspaceProfile?.inspectedFiles ?? []) push(inspected);
  for (const hint of workspaceProfile?.entryHints ?? []) {
    const matchedFile = workspaceMap.files.find((entry) => entry.path === hint || basename(entry.path) === hint);
    if (matchedFile) push(matchedFile.path);
  }

  if (seeds.length === 0 && workspaceMap.files.length > 0) {
    workspaceMap.files
      .filter((entry) => entry.category === 'doc' || entry.category === 'manifest' || entry.category === 'source')
      .slice(0, 6)
      .forEach((entry) => push(entry.path));
  }

  return seeds.slice(0, MAX_WORKING_SET_FILES);
}

function describeReason(reasons: string[]): string {
  const unique = Array.from(new Set(reasons.filter(Boolean)));
  if (unique.length === 0) return 'repo bootstrap context';
  return unique.slice(0, 3).join(', ');
}

export function buildCodeWorkspaceWorkingSetSync(args: {
  workspaceRoot: string;
  workspaceMap: CodeWorkspaceMap;
  workspaceProfile?: CodeWorkspaceProfile | null;
  query: string;
  selectedFilePath?: string | null;
  currentDirectory?: string | null;
  previousWorkingSet?: CodeWorkspaceWorkingSet | null;
  now?: number;
}): CodeWorkspaceWorkingSet {
  const now = args.now ?? Date.now();
  const query = args.query.trim();
  const tokens = tokenize(query);
  const selectedFileRelativePath = toWorkspaceRelativePath(args.workspaceRoot, args.selectedFilePath);
  const currentDirectoryRelativePath = toWorkspaceRelativePath(args.workspaceRoot, args.currentDirectory);
  const bootstrapPaths = pickBootstrapPaths(args.workspaceMap, args.workspaceProfile, selectedFileRelativePath);
  const bootstrapSet = new Set(bootstrapPaths);
  const previousPathSet = new Set((args.previousWorkingSet?.files ?? []).map((entry) => entry.path));

  const scored = args.workspaceMap.files.map((entry) => {
    let score = 0;
    const reasons: string[] = [];
    if (bootstrapSet.has(entry.path)) {
      score += entry.category === 'source' ? 8 : 10;
      reasons.push('repo bootstrap');
    }
    if (selectedFileRelativePath && entry.path === selectedFileRelativePath) {
      score += 30;
      reasons.push('selected file');
    }
    if (currentDirectoryRelativePath && currentDirectoryRelativePath !== '.' && entry.path.startsWith(`${currentDirectoryRelativePath}/`)) {
      score += 5;
      reasons.push('current directory');
    }
    if (previousPathSet.has(entry.path)) {
      score += 8;
      reasons.push('recent working set');
    }

    const pathLower = entry.path.toLowerCase();
    const summaryLower = entry.summary.toLowerCase();
    for (const token of tokens) {
      if (pathLower.includes(token)) {
        score += 12;
        reasons.push(`path matches "${token}"`);
      }
      if (summaryLower.includes(token)) {
        score += 7;
        reasons.push(`summary matches "${token}"`);
      }
      if (entry.symbols.some((symbol) => symbol.toLowerCase().includes(token))) {
        score += 9;
        reasons.push(`symbol matches "${token}"`);
      }
      if (entry.imports.some((importPath) => importPath.toLowerCase().includes(token))) {
        score += 4;
        reasons.push(`import matches "${token}"`);
      }
      if (entry.keywords.some((keyword) => keyword.includes(token))) {
        score += 5;
        reasons.push(`keyword matches "${token}"`);
      }
    }

    if (tokens.length === 0) {
      if (entry.category === 'doc' || entry.category === 'manifest') score += 5;
      if (entry.category === 'source' && bootstrapSet.has(entry.path)) score += 4;
    }

    return { entry, score, reason: describeReason(reasons) };
  });

  const selected = scored
    .filter((entry) => entry.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || left.entry.path.localeCompare(right.entry.path)
    ))
    .slice(0, MAX_WORKING_SET_FILES)
    .map((entry) => ({
      path: entry.entry.path,
      category: entry.entry.category,
      score: entry.score,
      reason: entry.reason,
      summary: entry.entry.summary,
      symbols: entry.entry.symbols.slice(0, 6),
    }));

  const fallbackSelection = selected.length > 0
    ? selected
    : bootstrapPaths
      .map((pathValue) => args.workspaceMap.files.find((entry) => entry.path === pathValue))
      .filter((entry): entry is CodeWorkspaceMapFile => !!entry)
      .slice(0, MAX_WORKING_SET_FILES)
      .map((entry) => ({
        path: entry.path,
        category: entry.category,
        score: 1,
        reason: 'repo bootstrap',
        summary: entry.summary,
        symbols: entry.symbols.slice(0, 6),
      }));

  const snippets = fallbackSelection
    .slice(0, MAX_WORKING_SET_SNIPPETS)
    .map((entry) => ({
      path: entry.path,
      excerpt: readSnippet(args.workspaceRoot, entry.path),
    }))
    .filter((entry) => entry.excerpt.trim().length > 0);

  const rationale = fallbackSelection.length > 0
    ? `Prepared ${fallbackSelection.length} repo files from the indexed workspace for this turn.`
    : 'No indexed workspace files were selected for this turn.';

  return {
    query,
    retrievedAt: now,
    rationale,
    files: fallbackSelection,
    snippets,
  };
}

export function shouldRefreshCodeWorkspaceMap(
  workspaceMap: CodeWorkspaceMap | null | undefined,
  workspaceRoot: string,
  now = Date.now(),
): boolean {
  if (!workspaceMap) return true;
  if (workspaceMap.workspaceRoot !== workspaceRoot) return true;
  return (now - (workspaceMap.lastIndexedAt || 0)) > 120_000;
}

export function formatCodeWorkspaceMapSummaryForPrompt(workspaceMap: CodeWorkspaceMap | null | undefined): string {
  if (!workspaceMap) return 'workspaceMap: (not indexed yet)';
  const directorySummary = workspaceMap.directories
    .slice(0, 6)
    .map((entry) => `${entry.path} (${entry.fileCount})`)
    .join(', ');
  return [
    `workspaceMap.indexedFileCount: ${workspaceMap.indexedFileCount}`,
    `workspaceMap.totalDiscoveredFiles: ${workspaceMap.totalDiscoveredFiles}`,
    `workspaceMap.truncated: ${workspaceMap.truncated ? 'yes' : 'no'}`,
    `workspaceMap.notableFiles: ${workspaceMap.notableFiles.length > 0 ? workspaceMap.notableFiles.join(', ') : '(none)'}`,
    `workspaceMap.directories: ${directorySummary || '(none)'}`,
  ].join('\n');
}

export function formatCodeWorkspaceWorkingSetForPrompt(workingSet: CodeWorkspaceWorkingSet | null | undefined): string {
  if (!workingSet) return 'workingSet: (not prepared yet)';
  const fileLines = workingSet.files.length > 0
    ? workingSet.files.map((entry) => `- ${entry.path} [${entry.category}] (${entry.reason})${entry.summary ? `: ${entry.summary}` : ''}`).join('\n')
    : '- (none)';
  const snippetLines = workingSet.snippets.length > 0
    ? workingSet.snippets.map((entry) => `FILE ${entry.path}\n${entry.excerpt}`).join('\n\n')
    : '(none)';
  return [
    `workingSet.query: ${workingSet.query || '(empty)'}`,
    `workingSet.rationale: ${workingSet.rationale}`,
    'workingSet.files:',
    fileLines,
    'workingSet.snippets:',
    snippetLines,
  ].join('\n');
}
